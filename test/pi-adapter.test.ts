import { BUILD_INCIDENT, FULL_INCIDENT, WEB_INCIDENT, authenticatedCaptureStatus, verificationLane } from './helpers/worker-verification.js';
import { ModelRuntime, createBashToolDefinition, defineTool, type AgentSession, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { toToolDeclaration } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { COMPACTION_END_RECONCILE_MS, PiRuntime, laneBashTool, normalizeSessionPath, rendersAs, type PiRuntimeOptions } from '../src/runtime/pi-adapter.js';
import type { WorkerVerificationPolicy } from '../src/runtime/worker-verification-policy.js';
import type { DirectiveProducer } from '../src/runtime/directive-checkpoint.js';
import { RuntimeRegistry, applyThinkingFallback, ledgerReviewOwnerCessation, serviceRegistryOptions } from '../src/runtime/registry.js';
import { makeWorkflowLane } from './helpers/workflow-lane.js';
import { NO_REVIEW_OWNER_LEDGER } from './helpers/no-review-owner-ledger.js';
import { makeFallbackRuntimeHarness } from './helpers/fallback-runtime.js';
import { LockBusyError, SessionStore } from '../src/sessions/store.js';
import { capabilitiesForModelInput, type AgentHandle, type PromptOptions, type RuntimeEvent } from '../src/runtime/types.js';
import { makeIsolatedModelRuntime, makeStubModelRuntime, STUB_MODEL_ID, STUB_PROVIDER_ID, StubScript, type StubResponder, type StubTurn } from './helpers/stub-model.js';
import { PerkinsWholeReview } from '../src/dispatch/perkins-review/whole.js';
import { Supervisor } from '../src/supervision/supervisor.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { freezeReviewInputs } from '../src/dispatch/perkins-review/artifacts.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';

/**
 * Perkins r3 B1: a gated-twin mock for createAgentSession. Disarmed, it is
 * a transparent pass-through; armed, twin 0 stalls then FAILS while twin 1
 * stalls then proceeds — the one interleaving where the winner-ensures-
 * lock re-acquire leg must fire (the pre-acquiring twin releases in its
 * catch while the survivor is still in flight).
 */
const twinGate = vi.hoisted(() => ({
  armed: false,
  fail0: null as null | (() => void),
  release1: null as null | (() => void),
  lastOptions: null as unknown,
  /** The created session's agent state loses its assignable tools accessor. */
  breakToolsAccessor: false,
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@earendil-works/pi-coding-agent')
  >();
  let call = 0;
  return {
    ...actual,
    createAgentSession: async (opts: unknown) => {
      twinGate.lastOptions = opts;
      if (twinGate.breakToolsAccessor) {
        const created = await actual.createAgentSession(opts as never);
        Object.defineProperty(created.session.agent.state, 'tools', { value: [], writable: true, configurable: true, enumerable: true });
        return created;
      }
      if (!twinGate.armed) {
        return actual.createAgentSession(opts as never);
      }
      const n = call++;
      if (n === 0) {
        await new Promise<never>((_, reject) => {
          twinGate.fail0 = () => reject(new Error('twin-0 infrastructure failure'));
        });
      }
      await new Promise<void>((resolveGate) => {
        twinGate.release1 = resolveGate;
      });
      return actual.createAgentSession(opts as never);
    },
  };
});

/** A real 1x1 PNG. Pi 1.x decodes prompt images and drops (with a hint in the
 * prompt text) bytes that are not an image, so transport tests need a real one. */
const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** A session written by the real pi 0.85.1 SessionManager (recorded cwd /fixture/project). */
const PI_085_SESSION = join(import.meta.dirname, 'fixtures', 'pi-0.85-session.jsonl');

/** A compaction summary request. Pi 1.x summarizes the history before the cut
 * with a `<conversation>` prompt and a split turn's prefix with a
 * `# Conversation` one; the scripted provider holds or answers either. */
function isSummaryRequest(prompt: string): boolean {
  return prompt.startsWith('<conversation>') || prompt.startsWith('# Conversation');
}

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  home: string;
  workspace: string;
  agentDir: string;
  store: SessionStore;
  script: StubScript;
  config: ReturnType<typeof loadConfig>;
  modelRuntime: Awaited<ReturnType<typeof makeStubModelRuntime>>;
}

interface FixtureOptions {
  readonly modelCatalogRefresh?: PiRuntimeOptions['modelCatalogRefresh'];
  readonly configExtra?: string;
  readonly log?: PiRuntimeOptions['log'];
}

async function fixture(
  turns: readonly StubTurn[] | StubResponder = [],
  modelInput: readonly ('text' | 'image')[] = ['text'],
  options: FixtureOptions = {},
): Promise<Fixture & { runtime: PiRuntime }> {
  const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
  const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
  cleanupDirs.push(home, workspace, agentDir);
  writeFileSync(
    configPathFor(home),
    `workspace_root = "${workspace}"\n[models]\ndefault = "gru-stub/stub-model"\n${options.configExtra ?? ''}`,
    'utf-8',
  );
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const store = new SessionStore(config.dataDir);
  const script = new StubScript(turns);
  const modelRuntime = await makeStubModelRuntime(script, { input: modelInput });
  const runtime = new PiRuntime({
    config,
    store,
    agentDir,
    modelRuntime,
    ...(options.modelCatalogRefresh !== undefined
      ? { modelCatalogRefresh: options.modelCatalogRefresh }
      : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  return { home, workspace, agentDir, store, script, config, modelRuntime, runtime };
}

function collect(handle: { subscribe(listener: (event: RuntimeEvent) => void): () => void }): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  handle.subscribe((event) => events.push(event));
  return events;
}

/** Await a spawn that MUST fail and return its message for content pins. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected the promise to reject');
}

/** Poll a condition until it holds; throws with the label on timeout. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface CancellationObservation {
  readonly variant: 'broad' | 'narrow';
  readonly summaryMode: 'abort-settles' | 'late-terminal';
  readonly cancellations: number;
  readonly abortOutcome: string | null;
  readonly turn: string;
  readonly queued: string;
  readonly errorEvents: number;
  readonly errorMessages: readonly string[];
  readonly stateErrors: number;
  readonly assistantErrors: number;
  readonly abortedEnds: number;
  readonly successEnds: number;
  readonly terminalEnds: readonly { readonly success: boolean; readonly error: string | null }[];
  readonly rawSdkCompactionEnds: number;
  readonly summarySettledByAbort: boolean;
  readonly stalledSummaryCalls: number;
  readonly continuationReachedModel: boolean;
  readonly recoveredReplyDelta: boolean;
  readonly recoveredReplyState: boolean;
  readonly recoveredReplyDurable: boolean;
  readonly queuedPendingDuringStall: boolean;
  readonly queuedModelCallsDuringStall: number;
  readonly queuedSettledAfterCancel: boolean | null;
  readonly queuedModelCallsAfterCancel: number | null;
  readonly continuationCallsAfterCancel: number | null;
  readonly postCancelGuardMessages: readonly string[] | null;
  readonly postCancelGuardModelCalls: number | null;
  readonly guardMessages: readonly string[];
  readonly guardModelCallsDuringStall: number;
  readonly guardModelCalls: number;
  readonly queuedDelivered: number;
  readonly afterSettle: string;
  readonly afterSettleDelivered: number;
  readonly disposed: boolean;
  readonly idle: boolean;
}

/**
 * Drive one real mid-run threshold compaction into a stall, then apply the
 * cancellation a bound would apply — broad `session.abort()` or summary-only
 * `session.abortCompaction()` — through the public SDK session and measure the
 * outcome. No product code is modified and no adapter deadline is armed: the
 * cancellation is invoked through the public SDK session, so this contract
 * holds for any future (or owner-controlled) bound that needs it. The
 * adapter's former #137 deadline is gone (rollback of PR #137), which is
 * exactly why the boundary is pinned here instead of at the deleted call site.
 *
 * The first cycle is measured alone before any follow-up starts: the adapter
 * keeps one pending terminal slot, and a second adjacent cycle would race the
 * publication poll. Other-owner work is admitted while the measured turn is
 * live and BEFORE native compaction opens, so its pending-to-delivered
 * transition is proven through the stall and the cancellation instead of
 * being submitted after settlement; one post-settlement request is kept as a
 * separate usability check. While the summary is held, fresh prompt/steer/
 * followUp requests must be refused by the compacting admission guard. Only
 * the FIRST summary stalls; later cycles summarize normally so exactly-once
 * delivery is not conflated with an open-ended provider stall.
 *
 * `abort-settles`: a faithful transport — the held summary stream ends when
 * its request signal aborts. `late-terminal`: the signal is ignored and the
 * transport settles only when the test releases it (after the cancellation).
 */
async function observeCompactionCancellation(
  variant: 'broad' | 'narrow',
  summaryMode: 'abort-settles' | 'late-terminal',
): Promise<CancellationObservation> {
  const history = 'history '.repeat(12_000); // ~24k estimated tokens: forces a discarding cut point
  let releaseSummary: () => void = () => {};
  const summaryHold = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  let summaryCalls = 0;
  const fx = await fixture((prompt, index) => {
    if (isSummaryRequest(prompt)) {
      summaryCalls += 1;
      return summaryCalls === 1
        ? { deltas: [], hold: summaryHold, honorAbort: summaryMode === 'abort-settles' }
        : { deltas: ['summary'] };
    }
    if (index === 0) return { deltas: [history] };
    if (index === 1) {
      // The tool call keeps the run live through prepareNextTurnWithContext,
      // where pi runs native threshold compaction mid-run.
      return {
        deltas: [],
        toolCall: { id: 'call-1', name: 'read', args: { path: 'missing.txt' } },
        usageTokens: 90_000,
      };
    }
    // Distinctive continuation reply: the recovered answer must be observable
    // as a delta and as a successful persisted assistant message, not only as
    // model admission (the broad aborted turn also fulfills admission).
    if (prompt.includes('[TOOL_RESULT')) return { deltas: ['continuation-recovered'] };
    return { deltas: [`answer-${index}`] };
  });
  const handle = await fx.runtime.spawn('gru');
  const events = collect(handle);
  const rawSdkEvents: string[] = [];
  const sdkSession = (handle as unknown as {
    session: { subscribe?: (listener: (event: unknown) => void) => () => void };
  }).session;
  if (sdkSession.subscribe === undefined) throw new Error('SDK session is missing subscribe()');
  sdkSession.subscribe((event) => rawSdkEvents.push(String((event as { type?: unknown }).type)));
  const internal = handle as unknown as {
    session: {
      abort?: () => Promise<void>;
      abortCompaction?: () => void;
      isIdle: boolean;
      agent: { state: { messages: Array<{ role: string; stopReason?: string; content?: unknown }> } };
    };
  };
  try {
    await handle.prompt('start');
    const turn = handle.prompt('do the work').then(
      () => 'resolved',
      (error: Error) => `rejected:${error.message}`,
    );
    // Admit other-owner work while the turn is live and before native
    // compaction opens: single-writer must hold it pending, and it must
    // deliver exactly once after genuine settlement.
    const queued = handle.prompt('queued work', { owner: 'other' }).then(
      () => 'resolved',
      (error: Error) => `rejected:${error.message}`,
    );
    let queuedSettled = false;
    void queued.then(() => {
      queuedSettled = true;
    });
    await waitFor(
      () => events.some((event) => event.type === 'compaction_start'),
      'compaction_start',
    );
    // Pending through the held summary: the queued item must not reach the
    // model while compaction is in progress, and fresh execution requests
    // against the compacting session must be refused by the admission guard.
    const queuedPendingDuringStall = !queuedSettled;
    const queuedModelCallsDuringStall = fx.script.calls.filter(
      (call) => call.prompt === 'queued work',
    ).length;
    const guardOutcomes = await Promise.all([
      handle.prompt('during compaction', { owner: 'other' }).then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
      handle.steer('during compaction', { owner: 'other' }).then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
      handle.followUp('during compaction', { owner: 'other' }).then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
    ]);
    // Pin each guard's rejection text and prove none of them reached the
    // model: a single regex count would let any wording containing
    // "compacting" pass, and a guard that rejects after enqueueing would be
    // invisible without the model-call check. The stall-time count is kept
    // AND the final count is re-taken after all work settles (a rejected but
    // enqueued request could deliver later without changing a cached zero).
    const guardMessages = guardOutcomes;
    const guardModelCallsDuringStall = fx.script.calls.filter((call) =>
      call.prompt.includes('during compaction'),
    ).length;
    // The cancellation seam under test: exactly one call, summary-only or broad.
    let cancellations = 0;
    let abortSettled: Promise<string> | null = null;
    if (variant === 'broad') {
      const abort = internal.session.abort;
      if (abort === undefined) throw new Error('SDK session is missing abort()');
      cancellations += 1;
      // Capture the SDK abort promise instead of discarding it: a rejection
      // must fail at this seam, not surface as an unhandled rejection.
      abortSettled = abort.call(internal.session).then(
        () => 'resolved',
        (error: Error) => `rejected:${error.message}`,
      );
    } else {
      const abortCompaction = internal.session.abortCompaction;
      if (abortCompaction === undefined) throw new Error('SDK session is missing abortCompaction()');
      cancellations += 1;
      abortCompaction.call(internal.session);
    }
    let queuedSettledAfterCancel: boolean | null = null;
    let queuedModelCallsAfterCancel: number | null = null;
    let continuationCallsAfterCancel: number | null = null;
    let postCancelGuardMessages: readonly string[] | null = null;
    if (summaryMode === 'late-terminal') {
      // The transport ignores the request signal: give the SDK abort path a
      // bounded probe window for its own terminal, then settle the transport
      // late. The probe never gates a pin — it only orders the release after
      // the cancellation to define this mode.
      const until = Date.now() + 2_000;
      while (Date.now() < until && !rawSdkEvents.includes('compaction_end')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Post-cancellation held-transport checkpoint: while the cancelled
      // transport is STILL held (the release is below), the pending work must
      // remain owed, nothing may reach the model, and the admission guard
      // must still refuse fresh execution — the zero-premature-delivery
      // interval is measured on the actual surface, not only before cancel.
      queuedSettledAfterCancel = queuedSettled;
      queuedModelCallsAfterCancel = fx.script.calls.filter(
        (call) => call.prompt === 'queued work',
      ).length;
      continuationCallsAfterCancel = fx.script.calls.filter(
        (call) => call.prompt.startsWith('do the work') && call.prompt.includes('[TOOL_RESULT'),
      ).length;
      postCancelGuardMessages = await Promise.all([
        handle.prompt('during held cancel', { owner: 'other' }).then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
        handle.steer('during held cancel', { owner: 'other' }).then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
        handle.followUp('during held cancel', { owner: 'other' }).then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
      ]);
    }
    releaseSummary(); // no-op for an already-aborted stream; settles a late one
    await waitFor(
      () => events.some((event) => event.type === 'compaction_end'),
      'compaction_end',
      8_000,
    );
    const turnOutcome = await turn;
    const queuedOutcome = await queued;
    await waitFor(
      () => fx.script.calls.some((call) => call.prompt === 'queued work'),
      'queued delivery',
      8_000,
    );
    // Separate post-settlement usability check: fresh work on the settled
    // session delivers exactly once, on its own.
    const afterSettle = handle.prompt('after settle', { owner: 'other' }).then(
      () => 'resolved',
      (error: Error) => `rejected:${error.message}`,
    );
    const afterSettleOutcome = await afterSettle;
    await waitFor(
      () => fx.script.calls.some((call) => call.prompt === 'after settle'),
      'post-settlement delivery',
      8_000,
    );
    await waitFor(() => internal.session.isIdle || handle.health().state === 'disposed', 'session settle');
    // The broad abort promise must resolve (session reached idle), never
    // reject; the summary-only path has no broad abort at all.
    const abortOutcome = abortSettled === null ? null : await abortSettled;
    // Final guarded-prompt count AFTER the measured turn, queued work, and
    // post-settlement request have all settled.
    const guardModelCalls = fx.script.calls.filter((call) =>
      call.prompt.includes('during compaction'),
    ).length;
    // r8: a guard that rejects but also enqueues would deliver the rejected
    // request after the transport settles. Re-count the held-cancel prompts
    // after settlement so the rejection text cannot mask that delivery.
    const postCancelGuardModelCalls = fx.script.calls.filter((call) =>
      call.prompt.includes('during held cancel'),
    ).length;
    // Anchor the abort-settlement marker to the FIRST summary call (the
    // stalled one), not any later summary that the same signal could abort.
    const firstSummary = fx.script.calls.find((call) =>
      isSummaryRequest(call.prompt),
    );
    // The recovered reply must be observable as a delta AND as a successful
    // assistant message, not only as model admission. The durable check reads
    // the session JSONL (the SDK persists asynchronously, so a narrow
    // variant waits for it); the live SDK state check is kept separately.
    const recoveredReplyDelta = events.some(
      (event) => event.type === 'text_delta' && event.delta === 'continuation-recovered',
    );
    const recoveredReplyState = internal.session.agent.state.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.stopReason === 'stop' &&
        JSON.stringify(message.content ?? '').includes('continuation-recovered'),
    );
    const readDurableReply = (): boolean => {
      const file = handle.sessionFile;
      if (file === null) throw new Error('session file missing for the durable reply check');
      let text: string;
      try {
        text = readFileSync(file, 'utf-8');
      } catch {
        return false;
      }
      return text.split('\n').some((line) => {
        if (line.trim() === '') return false;
        let entry: {
          type?: unknown;
          message?: { role?: unknown; stopReason?: unknown; content?: unknown };
        };
        try {
          entry = JSON.parse(line) as typeof entry;
        } catch {
          // The SDK persists asynchronously: a partially flushed tail line is
          // not a durable reply yet, so the poll simply retries (never throws
          // out of the predicate).
          return false;
        }
        return (
          entry.type === 'message' &&
          entry.message?.role === 'assistant' &&
          entry.message?.stopReason === 'stop' &&
          JSON.stringify(entry.message?.content ?? '').includes('continuation-recovered')
        );
      });
    };
    let recoveredReplyDurable = readDurableReply();
    if (variant === 'narrow') {
      await waitFor(() => {
        recoveredReplyDurable = readDurableReply();
        return recoveredReplyDurable;
      }, 'durable recovered reply');
    }
    const compactionEnds = events.filter(
      (event): event is Extract<RuntimeEvent, { type: 'compaction_end' }> =>
        event.type === 'compaction_end',
    );
    return {
      variant,
      summaryMode,
      cancellations,
      abortOutcome,
      turn: turnOutcome,
      queued: queuedOutcome,
      errorEvents: events.filter((event) => event.type === 'error').length,
      errorMessages: events
        .filter((event): event is Extract<RuntimeEvent, { type: 'error' }> => event.type === 'error')
        .map((event) => event.error),
      stateErrors: events.filter((event) => event.type === 'state' && event.state === 'error').length,
      assistantErrors: internal.session.agent.state.messages.filter(
        (message) => message.role === 'assistant' && message.stopReason === 'error',
      ).length,
      abortedEnds: compactionEnds.filter(
        (event) => !event.success && event.error === 'compaction aborted',
      ).length,
      successEnds: compactionEnds.filter((event) => event.success).length,
      terminalEnds: compactionEnds.map((event) => ({
        success: event.success,
        error: event.error ?? null,
      })),
      rawSdkCompactionEnds: rawSdkEvents.filter((type) => type === 'compaction_end').length,
      summarySettledByAbort: firstSummary?.aborted === true,
      stalledSummaryCalls: fx.script.calls.filter((call) =>
        isSummaryRequest(call.prompt),
      ).length,
      continuationReachedModel: fx.script.calls.some(
        (call) => call.prompt.startsWith('do the work') && call.prompt.includes('[TOOL_RESULT'),
      ),
      recoveredReplyDelta,
      recoveredReplyState,
      recoveredReplyDurable,
      queuedPendingDuringStall,
      queuedModelCallsDuringStall,
      queuedSettledAfterCancel,
      queuedModelCallsAfterCancel,
      continuationCallsAfterCancel,
      postCancelGuardMessages,
      postCancelGuardModelCalls,
      guardMessages,
      guardModelCallsDuringStall,
      guardModelCalls,
      queuedDelivered: fx.script.calls.filter((call) => call.prompt === 'queued work').length,
      afterSettle: afterSettleOutcome,
      afterSettleDelivered: fx.script.calls.filter((call) => call.prompt === 'after settle').length,
      disposed: handle.health().state === 'disposed',
      idle: internal.session.isIdle,
    };
  } finally {
    releaseSummary();
    await handle.dispose();
  }
}

interface NativeQueueObservation {
  readonly summaryMode: 'abort-settles' | 'late-terminal';
  readonly pendingAfterAdmission: number;
  readonly pendingDuringStall: number;
  readonly modelCallsDuringStall: number;
  readonly pendingAfterCancel: number | null;
  readonly modelCallsAfterCancel: number | null;
  readonly postCancelGuardMessages: readonly string[] | null;
  readonly postCancelGuardModelCalls: number | null;
  readonly turn: string;
  readonly errorEvents: number;
  readonly continuationReachedModel: boolean;
  readonly followUpReplyDelta: boolean;
  readonly followUpReplyState: boolean;
  readonly delivered: number;
  readonly pendingAfterSettlement: number;
  readonly abortedEnds: number;
  readonly successEnds: number;
  readonly terminalEnds: readonly { readonly success: boolean; readonly error: string | null }[];
  readonly summarySettledByAbort: boolean;
  readonly idle: boolean;
  readonly disposed: boolean;
}

/**
 * Acceptance C for the NATIVE channel (the adapter-queue path is covered
 * separately by observeCompactionCancellation): a same-owner SDK followUp is
 * admitted while the measured run is live and BEFORE native threshold
 * compaction opens (a tool-call stream gate), stays pending through the held
 * summary, survives summary-only cancellation, and delivers exactly once
 * after genuine settlement. The native surface itself proves admission:
 * `pendingMessageCount` moves 0 -> 1 -> 0 and the followUp call is counted
 * through the public SDK session, never the adapter queue.
 */
async function observeNativeFollowUpCancellation(
  summaryMode: 'abort-settles' | 'late-terminal',
): Promise<NativeQueueObservation> {
  const history = 'history '.repeat(12_000); // ~24k estimated tokens: forces a discarding cut point
  let releaseSummary: () => void = () => {};
  const summaryHold = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  let releaseToolCall: () => void = () => {};
  const toolGate = new Promise<void>((resolve) => {
    releaseToolCall = resolve;
  });
  let summaryCalls = 0;
  const fx = await fixture((prompt, index) => {
    if (isSummaryRequest(prompt)) {
      summaryCalls += 1;
      return summaryCalls === 1
        ? { deltas: [], hold: summaryHold, honorAbort: summaryMode === 'abort-settles' }
        : { deltas: ['summary'] };
    }
    if (index === 0) return { deltas: [history] };
    if (index === 1) {
      // Gate the tool-call stream: the test admits the native follow-up while
      // the run is live and before prepareNextTurnWithContext can compact.
      return {
        deltas: [],
        toolCall: { id: 'call-1', name: 'read', args: { path: 'missing.txt' } },
        usageTokens: 90_000,
        hold: toolGate,
      };
    }
    // A distinctive reply for the queued follow-up: model admission alone
    // cannot prove the delivered message produced a successful answer.
    if (prompt === 'native follow-up') return { deltas: ['native-follow-up-answered'] };
    return { deltas: [`answer-${index}`] };
  });
  const handle = await fx.runtime.spawn('gru');
  const events = collect(handle);
  const rawSdkEvents: string[] = [];
  const sdkSession = (handle as unknown as {
    session: {
      subscribe?: (listener: (event: unknown) => void) => () => void;
      followUp?: (text: string, images?: unknown) => Promise<void>;
      pendingMessageCount?: number;
      abortCompaction?: () => void;
      isIdle: boolean;
    };
  }).session;
  if (
    sdkSession.subscribe === undefined ||
    sdkSession.followUp === undefined ||
    sdkSession.pendingMessageCount === undefined ||
    sdkSession.abortCompaction === undefined
  ) {
    throw new Error('SDK session is missing a required native surface');
  }
  sdkSession.subscribe((event) => rawSdkEvents.push(String((event as { type?: unknown }).type)));
  const pendingCount = (): number => {
    const count = sdkSession.pendingMessageCount;
    if (count === undefined) throw new Error('SDK session lost pendingMessageCount');
    return count;
  };
  try {
    await handle.prompt('start');
    const turn = handle.prompt('do the work').then(
      () => 'resolved',
      (error: Error) => `rejected:${error.message}`,
    );
    await waitFor(
      () => fx.script.calls.some((call) => call.prompt === 'do the work'),
      'tool-call turn started',
    );
    // Same-owner native admission while the run is live: the adapter routes
    // this to the SDK queue (counted by the proxy), never to its own queue.
    await handle.followUp('native follow-up');
    const pendingAfterAdmission = pendingCount();
    releaseToolCall();
    await waitFor(
      () => events.some((event) => event.type === 'compaction_start'),
      'compaction_start',
    );
    // Pending through the stall: nothing reaches the model while compaction is
    // open, and the SDK still holds the message.
    const pendingDuringStall = pendingCount();
    const modelCallsDuringStall = fx.script.calls.filter(
      (call) => call.prompt === 'native follow-up',
    ).length;
    // The cancellation seam under test: summary-only.
    sdkSession.abortCompaction!();
    let pendingAfterCancel: number | null = null;
    let modelCallsAfterCancel: number | null = null;
    let postCancelGuardMessages: readonly string[] | null = null;
    if (summaryMode === 'late-terminal') {
      // The transport ignores the request signal: give the SDK abort path a
      // bounded probe window for its own terminal, then settle the transport
      // late — the definition of this mode.
      const until = Date.now() + 2_000;
      while (Date.now() < until && !rawSdkEvents.includes('compaction_end')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // r7: post-cancellation held-transport checkpoint — the native queue's
      // pending work must remain owed, nothing may reach the model, and the
      // admission guard must still refuse fresh execution while the cancelled
      // transport is still held (the release is below).
      pendingAfterCancel = pendingCount();
      modelCallsAfterCancel = fx.script.calls.filter(
        (call) => call.prompt === 'native follow-up',
      ).length;
      postCancelGuardMessages = await Promise.all([
        handle.prompt('during held cancel', { owner: 'other' }).then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
        handle.steer('during held cancel', { owner: 'other' }).then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
        handle.followUp('during held cancel', { owner: 'other' }).then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
      ]);
    }
    releaseSummary();
    await waitFor(
      () => events.some((event) => event.type === 'compaction_end'),
      'compaction_end',
      8_000,
    );
    const turnOutcome = await turn;
    await waitFor(
      () => fx.script.calls.some((call) => call.prompt === 'native follow-up'),
      'native follow-up delivery',
      8_000,
    );
    await waitFor(() => pendingCount() === 0, 'native queue drained');
    const internal = handle as unknown as {
      session: {
        isIdle: boolean;
        agent: { state: { messages: Array<{ role: string; stopReason?: string; content?: unknown }> } };
      };
    };
    await waitFor(() => internal.session.isIdle || handle.health().state === 'disposed', 'session settle');
    // The delivered follow-up must produce a successful answer on the event
    // surface, not only a model admission count.
    await waitFor(
      () =>
        events.some(
          (event) => event.type === 'text_delta' && event.delta === 'native-follow-up-answered',
        ),
      'native follow-up reply',
      8_000,
    );
    const compactionEnds = events.filter(
      (event): event is Extract<RuntimeEvent, { type: 'compaction_end' }> =>
        event.type === 'compaction_end',
    );
    const postCancelGuardModelCalls = fx.script.calls.filter((call) =>
      call.prompt.includes('during held cancel'),
    ).length;
    return {
      summaryMode,
      pendingAfterAdmission,
      pendingDuringStall,
      modelCallsDuringStall,
      pendingAfterCancel,
      modelCallsAfterCancel,
      postCancelGuardMessages,
      postCancelGuardModelCalls,
      followUpReplyDelta: events.some(
        (event) => event.type === 'text_delta' && event.delta === 'native-follow-up-answered',
      ),
      followUpReplyState: internal.session.agent.state.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.stopReason === 'stop' &&
          JSON.stringify(message.content ?? '').includes('native-follow-up-answered'),
      ),
      turn: turnOutcome,
      errorEvents: events.filter((event) => event.type === 'error').length,
      continuationReachedModel: fx.script.calls.some(
        (call) => call.prompt.startsWith('do the work') && call.prompt.includes('[TOOL_RESULT'),
      ),
      delivered: fx.script.calls.filter((call) => call.prompt === 'native follow-up').length,
      pendingAfterSettlement: pendingCount(),
      abortedEnds: compactionEnds.filter(
        (event) => !event.success && event.error === 'compaction aborted',
      ).length,
      successEnds: compactionEnds.filter((event) => event.success).length,
      terminalEnds: compactionEnds.map((event) => ({
        success: event.success,
        error: event.error ?? null,
      })),
      summarySettledByAbort: fx.script.calls.some(
        (call) => isSummaryRequest(call.prompt) && call.aborted,
      ),
      idle: internal.session.isIdle,
      disposed: handle.health().state === 'disposed',
    };
  } finally {
    releaseSummary();
    releaseToolCall();
    await handle.dispose();
  }
}

describe('PiRuntime over the stub model (offline SDK round-trip)', () => {
  it('spawns a session persisted under the instance sessions dir', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      expect(handle.role).toBe('gru');
      const expectedDir = fx.store.sessionDirFor('gru', fx.workspace);
      expect(handle.sessionFile).toContain(expectedDir);
      expect(handle.sessionFile).toMatch(/\.jsonl$/);
      // pi-standard file naming: <timestamp>_<uuid>.jsonl
      const sessionFile = handle.sessionFile!;
      const name = sessionFile.split('/').pop()!;
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T[\dT:.Z-]+_[0-9a-f-]{36}\.jsonl$/);
      // The session file is locked for the handle's lifetime.
      expect(existsSync(`${sessionFile}.lock`)).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it('a listener that throws a value that cannot be printed is isolated: emit never throws, and later listeners still run (#485)', async () => {
    const logs: { readonly level: string; readonly msg: string; readonly fields?: Record<string, unknown> }[] = [];
    const fx = await fixture([{ deltas: ['answered'] }], ['text'], { log: (level, msg, fields) => logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }) });
    const handle = await fx.runtime.spawn('gru');
    handle.subscribe(() => { const thrown: unknown = Object.create(null); throw thrown; });
    const events = collect(handle);
    try {
      await handle.prompt('answer plainly');
      expect(events.some((event) => event.type === 'turn_end')).toBe(true);
      expect(logs).toContainEqual({ level: 'warn', msg: 'runtime event listener threw', fields: { error: 'a non-error value was thrown: an unprintable value' } });
    } finally {
      await handle.dispose();
    }
  });

  it('an ordinary task spawn asks the SDK for no step, turn, or tool-call cap (issue #158)', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
    try {
      const options = twinGate.lastOptions as Record<string, unknown> | null;
      expect(options).not.toBeNull();
      // Capture sanity: the adapter really passed its session setup through.
      expect(Array.isArray(options?.tools)).toBe(true);
      // Pin that a provider/SDK step, turn, iteration, or tool-call ceiling is
      // never invented for a task turn: a cap-only stop was the #158 incident.
      for (const key of Object.keys(options ?? {})) {
        expect(key).not.toMatch(/(?:max|limit|budget).*(?:step|turn|tool|call|iteration)/iu);
        expect(key).not.toMatch(/(?:step|turn|tool|call|iteration).*(?:max|limit|budget)/iu);
      }
      for (const banned of ['maxSteps', 'maxTurns', 'maxToolCalls', 'maxIterations', 'stepLimit', 'turnLimit', 'toolCallLimit', 'maxBudgetUsd']) {
        expect(options).not.toHaveProperty(banned);
      }
    } finally {
      await handle.dispose();
    }
  });

  it('a lane-bound managed BMAD runtime loads ahead of a same-named skill and is named in the prompt; reviews never get it', async () => {
    const fx = await fixture();
    // A global (user) bmad-build would win pi's first-loaded-wins rule.
    mkdirSync(join(fx.agentDir, 'skills', 'bmad-build'), { recursive: true });
    writeFileSync(join(fx.agentDir, 'skills', 'bmad-build', 'SKILL.md'), '---\nname: bmad-build\ndescription: stale global copy\n---\nSTALE', 'utf8');
    mkdirSync(join(fx.agentDir, 'skills', 'unrelated'), { recursive: true });
    writeFileSync(join(fx.agentDir, 'skills', 'unrelated', 'SKILL.md'), '---\nname: unrelated\ndescription: kept\n---\nKEPT', 'utf8');
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'gru-command-managed-'));
    cleanupDirs.push(runtimeRoot);
    mkdirSync(join(runtimeRoot, 'skills', 'bmad-build'), { recursive: true });
    writeFileSync(join(runtimeRoot, 'skills', 'bmad-build', 'SKILL.md'), '---\nname: bmad-build\ndescription: bound runtime copy\n---\nBOUND', 'utf8');
    const managedSkills = {
      source: 'gru-command-bmad',
      runtimeId: 'bmad-method@6.12.0+gru-command-bmad.1',
      contentSha256: 'a'.repeat(64),
      root: runtimeRoot,
      skillsDir: join(runtimeRoot, 'skills'),
      skills: ['bmad-build'],
      laneBound: true,
    };
    type Loader = { getSkills(): { skills: Array<{ name: string; filePath: string }> }; getSystemPrompt(): string | undefined };
    const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace, managedSkills });
    try {
      const loader = (twinGate.lastOptions as { resourceLoader: Loader }).resourceLoader;
      const skills = loader.getSkills().skills;
      expect(skills.filter((skill) => skill.name === 'bmad-build').map((skill) => skill.filePath))
        .toEqual([join(runtimeRoot, 'skills', 'bmad-build', 'SKILL.md')]);
      expect(skills.map((skill) => skill.name)).toContain('unrelated');
      const prompt = loader.getSystemPrompt() ?? '';
      expect(prompt).toContain('## Gru Command BMAD runtime');
      expect(prompt).toContain('`bmad-method@6.12.0+gru-command-bmad.1`');
      expect(prompt).toContain(runtimeRoot);
      expect(prompt).toContain('does not change when Gru Command is updated');
    } finally {
      await handle.dispose();
    }
    const review = await fx.runtime.spawn('perkins', {
      cwd: fx.workspace,
      managedSkills,
      isolatedReview: { systemPrompt: 'isolated policy', tools: [] },
    });
    try {
      const loader = (twinGate.lastOptions as { resourceLoader: Loader }).resourceLoader;
      expect(loader.getSkills().skills).toEqual([]);
      expect(loader.getSystemPrompt()).toBe('isolated policy');
    } finally {
      await review.dispose();
    }
  });

  it('production file-only supervised-shaped resumes keep the logical minion through two real SDK restarts', async () => {
    const { LedgerApi } = await import('../src/ledger/api.js');
    const { LedgerDb } = await import('../src/ledger/db.js');
    const { serviceWorkflowAuthority } = await import('../src/workflows/session.js');
    const fx = await fixture([{ deltas: ['offline resume canary'] }]);
    const f = makeWorkflowLane(); cleanupDirs.push(f.root);
    const dataDir = realpathSync(fx.home); const db = new LedgerDb(dataDir); const ledger = new LedgerApi(db.handle);
    ledger.addJob({ id: f.lane.id, repo: f.lane.repoName, title: 'original job', briefing: 'original contract' });
    ledger.registerWorktree(f.lane);
    const authority = serviceWorkflowAuthority(dataDir, () => ledger);
    const registry = new RuntimeRegistry({ ...serviceRegistryOptions({ reviewOwnerCessation: NO_REVIEW_OWNER_LEDGER, config: { ...fx.config, dataDir }, store: fx.store,
      workflowLaneFor: authority.workflowLaneFor, workflowBuildFor: authority.workflowBuildFor, workflowAgentFor: authority.workflowAgentFor }),
      pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
    });
    try {
      const first = await registry.spawn('minion', { cwd: f.lane.path, agentId: 'original-logical-minion' });
      await first.prompt('offline canary');
      const file = first.sessionFile!;
      ledger.registerAgent({ id: first.id, role: 'minion', jobId: f.lane.id, sessionFile: file, parentage: 'top-level' });
      await first.dispose();
      for (let restart = 0; restart < 2; restart++) {
        const resumed = await registry.spawn('minion', { resumeFile: file }); // exactly the supervisor input, no id/cwd
        expect(resumed.id).toBe('original-logical-minion');
        expect(resumed.sessionFile).toBe(file);
        ledger.registerAgent({ id: resumed.id, role: 'minion', jobId: f.lane.id, sessionFile: resumed.sessionFile });
        await resumed.dispose();
      }
      expect(ledger.listAgents().filter((agent) => agent.sessionFile === file).map((agent) => agent.id)).toEqual(['original-logical-minion']);
    } finally { await registry.dispose(); await fx.runtime.dispose(); db.close(); }
  });

  it('production owned workflow reaches the Pi loader ahead of hostile project/global copies and survives resume', async () => {
    const fx = await fixture([{ deltas: ['built'] }, { deltas: ['resumed'] }]);
    const f = makeWorkflowLane(); cleanupDirs.push(f.root);
    for (const base of [join(f.lane.path, '.agents'), fx.agentDir]) {
      mkdirSync(join(base, 'skills/gc-build'), { recursive: true });
      writeFileSync(join(base, 'skills/gc-build/SKILL.md'), '---\nname: gc-build\ndescription: incompatible ambient copy\n---\nWRONG-WORKFLOW');
    }
    mkdirSync(join(f.lane.path, '_bmad/custom'), { recursive: true });
    writeFileSync(join(f.lane.path, '_bmad/custom/config.toml'), 'NOT TOML');
    const registry = new RuntimeRegistry({ ...serviceRegistryOptions({ reviewOwnerCessation: NO_REVIEW_OWNER_LEDGER, config: { ...fx.config, dataDir: f.dataDir },
      store: new SessionStore(f.dataDir), workflowLaneFor: () => f.lane }),
      pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
    });
    const first = await registry.spawn('minion', { cwd: f.lane.path, agentId: 'same-worker' });
    const assertBoundary = () => {
      const options = twinGate.lastOptions as { cwd: string; resourceLoader: { getSkills(): { skills: Array<{ name: string; filePath: string }> }; getSystemPrompt(): string } };
      expect(options.cwd).toBe(f.lane.path);
      const selected = options.resourceLoader.getSkills().skills.filter((skill) => skill.name === 'gc-build');
      expect(selected).toHaveLength(1);
      expect(selected[0]!.filePath).toContain(join(f.dataDir, 'bmad-runtime/gru-command-workflows-'));
      const note = options.resourceLoader.getSystemPrompt();
      expect(note).toContain('## Gru Command owned delivery workflow');
      expect(note).toContain(join(f.dataDir, 'projects'));
      expect(note).toContain(join(f.lane.path, 'gru-output'));
      expect(note).toContain('workflow-context.json');
      // Bound-workflow boundary (native r2 blocker): the note composes after
      // the corrected role, qualifies owner-held merges to final PR merges
      // only, and keeps ordinary same-branch integration intact.
      expect(note).toContain('worker agent');
      expect(note).toContain('merge main into your task branch');
      expect(note).toContain('final PR merges remain owner-held');
      expect(note).not.toContain('READY; merges remain owner-held');
      return selected[0]!.filePath;
    };
    try {
      const selected = assertBoundary();
      await first.prompt('build');
      await first.dispose();
      const resumed = await registry.spawn('minion', { agentId: 'same-worker', resumeFile: first.sessionFile! });
      try {
        expect(resumed.id).toBe('same-worker');
        expect(assertBoundary()).toBe(selected);
        await resumed.prompt('continue');
      } finally { await resumed.dispose(); }
      expect(readFileSync(join(f.lane.path, '_bmad/custom/config.toml'), 'utf8')).toBe('NOT TOML');
      expect(existsSync(join(f.lane.path, '_bmad/render'))).toBe(false);
    } finally { await first.dispose(); await registry.dispose(); }
  });

  it('enforces isolated-review tools and strips ambient Pi resources #contract:isolated-review-tools:pi', async () => {
    const fx = await fixture();
    writeFileSync(join(fx.workspace, 'AGENTS.md'), 'PROJECT-CONTEXT-CANARY', 'utf8');
    mkdirSync(join(fx.agentDir, 'skills', 'canary'), { recursive: true });
    writeFileSync(join(fx.agentDir, 'skills', 'canary', 'SKILL.md'), '---\nname: canary\ndescription: secret canary\n---\nCANARY', 'utf8');
    const handle = await fx.runtime.spawn('perkins', {
      isolatedReview: { systemPrompt: 'isolated policy', tools: [] },
    });
    try {
      const options = twinGate.lastOptions as {
        noTools?: string;
        tools?: string[];
        resourceLoader: {
          getSkills(): { skills: unknown[] };
          getPrompts(): { prompts: unknown[] };
          getAgentsFiles(): { agentsFiles: unknown[] };
          getExtensions(): { extensions: unknown[] };
          getSystemPrompt(): string | undefined;
          getAppendSystemPrompt(): string[];
        };
      };
      expect(options.noTools).toBe('all');
      expect(options.tools).toEqual([]);
      expect(options.resourceLoader.getSkills().skills).toEqual([]);
      expect(options.resourceLoader.getPrompts().prompts).toEqual([]);
      expect(options.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(options.resourceLoader.getExtensions().extensions).toEqual([]);
      expect(options.resourceLoader.getAppendSystemPrompt()).toEqual([]);
      expect(options.resourceLoader.getSystemPrompt()).toBe('isolated policy');
      expect(handle.reviewIsolation).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it('wires requested isolated-review native tools and declares them on the handle', async () => {
    const fx = await fixture();
    const tool = {
      name: 'perkins_submit_findings',
      description: 'structured findings child tool',
      inputSchema: { type: 'object', additionalProperties: false },
      execute: async () => ({ text: JSON.stringify({ accepted: true }) }),
    };
    const handle = await fx.runtime.spawn('perkins', {
      isolatedReview: { systemPrompt: 'isolated policy', tools: [], nativeTools: [tool] },
    });
    try {
      const options = twinGate.lastOptions as {
        tools?: string[];
        customTools?: Array<{ name: string; execute(...args: unknown[]): Promise<unknown> }>;
      };
      expect(options.tools).toEqual(['perkins_submit_findings']);
      expect(options.customTools?.map((entry) => entry.name)).toEqual(['perkins_submit_findings']);
      expect(handle.reviewTools).toEqual(['perkins_submit_findings']);
      await expect(options.customTools![0]!.execute('call', {}, undefined, undefined))
        .resolves.toSatisfy((result: unknown) => JSON.stringify(result).includes('accepted'));
    } finally {
      await handle.dispose();
    }
    const textOnly = await fx.runtime.spawn('perkins', {
      isolatedReview: { systemPrompt: 'isolated policy', tools: [] },
    });
    try {
      expect(textOnly.reviewTools).toBeUndefined();
    } finally {
      await textOnly.dispose();
    }
  });

  it('runs a whole-PR Perkins lead through the production registry and real Pi adapter', async () => {
    let leadTurns = 0;
    const harvested: Array<{
      severity: string; category: string; title: string; location: string;
      evidence: string; detail: string; recommended_fix: string; source: string;
    }> = [];
    const harvest = (prompt: string): void => {
      // A resumed prompt replays earlier tool results; only NEW blocks count.
      for (const markerText of prompt.split('[TOOL_RESULT perkins_run_specialists]').slice(1)) {
        const payload = markerText.split(/\n\[TOOL_RESULT /)[0]!.trim();
        try {
          const parsed = JSON.parse(payload) as { results: Array<{ findings: Array<Record<string, unknown>> }> };
          for (const result of parsed.results) {
            for (const finding of result.findings) {
              const key = `${finding['title']}\0${finding['location']}`;
              if (harvestedIds.has(key)) continue;
              harvestedIds.add(key);
              harvested.push(finding as never);
            }
          }
        } catch { /* non-JSON tool text */ }
      }
    };
    const harvestedIds = new Set<string>();
    const fx = await fixture((prompt) => {
      if (prompt.includes('COMPLETE FROZEN DIFF (the whole change under review)')) {
        leadTurns += 1;
        harvest(prompt);
        if (leadTurns === 1) {
          return {
            deltas: [],
            toolCall: {
              id: 'lead-run-1', name: 'perkins_run_specialists',
              args: { runs: ['blind', 'edge', 'acceptance', 'security'].map((lens) => ({ lens })) },
            },
          };
        }
        if (leadTurns === 2) {
          return {
            deltas: [],
            toolCall: {
              id: 'lead-run-2', name: 'perkins_run_specialists',
              args: { runs: ['architecture', 'codebase', 'tests', 'performance'].map((lens) => ({ lens })) },
            },
          };
        }
        if (leadTurns === 3) {
          return {
            deltas: [],
            toolCall: {
              id: 'lead-run-3', name: 'perkins_run_specialists',
              args: { runs: ['operations'].map((lens) => ({ lens })) },
            },
          };
        }
        if (leadTurns >= 5) return { deltas: ['whole-PR lead complete'] };
        const targetSha = /^Frozen target SHA: (.+)$/m.exec(prompt)?.[1] ?? '';
        const baseSha = /^Frozen diff base SHA: (.+)$/m.exec(prompt)?.[1] ?? '';
        return {
          deltas: [],
          toolCall: {
            id: 'lead-submit', name: 'perkins_submit_review',
            args: {
              verdict: 'READY TO MERGE',
              findings: harvested,
              prior_dispositions: [],
              report_markdown: [
                '# Perkins Code Review',
                '',
                '**Verdict: READY TO MERGE**',
                `Target: ${targetSha}`,
                `Base: ${baseSha}`,
                'Specialists: blind edge acceptance security architecture codebase tests performance operations',
                'warning Verified adapter finding src/main.ts:2',
                'warning Changed behavior lacks test tracing src/main.ts:2 — add an assertion for the changed return value.',
                'Retain verification coverage for this path.',
              ].join('\n'),
            },
          },
        };
      }
      const lens = /Your lens id is "(blind|edge|acceptance|security|architecture|codebase|tests|performance|operations)"/u.exec(prompt)?.[1];
      // Native-tool children submit structured findings through the product
      // tool; assistant text is never the findings channel on pi.
      const childFindings = lens === 'security'
        ? [{
            severity: 'warning', category: 'coverage', title: 'Verified adapter finding',
            location: 'src/main.ts:2', evidence: '  return 43;',
            detail: 'The changed line is independently reviewable.',
            recommended_fix: 'Retain verification coverage for this path.',
          }]
        : lens === 'tests'
          ? [{
              severity: 'warning', category: 'coverage', title: 'Changed behavior lacks test tracing',
              location: 'src/main.ts:2', evidence: '  return 43;',
              detail: 'The changed return value has no direct assertion.',
              recommended_fix: 'Add an assertion for the changed return value.',
            }]
          : [];
      return {
        deltas: [],
        toolCall: {
          id: `child-submit-${lens ?? 'unknown'}`,
          name: 'perkins_submit_findings',
          args: { findings: childFindings },
        },
      };
    });
    const repo = makeFixtureRepo('pi-perkins-hybrid');
    let registry: RuntimeRegistry | null = null;
    const owned: AgentHandle[] = [];
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    try {
      const frozen = freezeReviewInputs({
        roundId: 'pi-hybrid-round', repoPath: repo.path, artifactRoot: join(fx.home, 'review-artifacts'),
        baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'Acceptance: answer returns 43.',
      });
      registry = new RuntimeRegistry({
        config: fx.config,
        store: fx.store,
        pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
      });
      const engine = new PerkinsWholeReview({
        spawner: async (role, options) => {
          const handle = await registry!.spawn(role, options);
          owned.push(handle);
          return handle;
        },
        policy: loadPerkinsPolicy(),
      });
      const result = await engine.run({
        roundId: 'pi-hybrid-round', roundNumber: 1, frozenReview: frozen,
        movementRef: 'feature/review', noSpec: false,
      });
      expect(result.canonicalVerdict).toBe('READY TO MERGE');
      expect(result.specialistRuns.filter((run) => run.status === 'valid')).toHaveLength(9);
      expect(leadTurns).toBe(4);
      expect(fx.script.calls.filter((call) => !call.prompt.includes('COMPLETE FROZEN DIFF (the whole change under review)'))).toHaveLength(9);
      expect(result.findings).toHaveLength(2);
      expect(owned).toHaveLength(10);
      expect(new Set(owned.map((handle) => handle.id)).size).toBe(10);
      expect(new Set(owned.map((handle) => handle.sessionFile)).size).toBe(10);
      expect(owned.every((handle) => handle.reviewIsolation === true)).toBe(true);
      expect(registry.status().activeSessions).toBe(0);
    } finally {
      await registry?.dispose();
      await fx.runtime.dispose();
      repo.cleanup();
    }
  });

  it('confines isolated-review read tools to the review working directory', async () => {
    const fx = await fixture();
    const outsideDir = mkdtempSync(join(tmpdir(), 'pi-review-outside-'));
    cleanupDirs.push(outsideDir);
    const outside = join(outsideDir, 'secret.txt');
    writeFileSync(outside, 'must not be readable', 'utf8');
    const linkedOutside = join(fx.workspace, 'linked-secret.txt');
    symlinkSync(outside, linkedOutside);
    const handle = await fx.runtime.spawn('perkins', {
      cwd: fx.workspace,
      isolatedReview: { systemPrompt: 'isolated policy', tools: ['read'] },
    });
    try {
      const options = twinGate.lastOptions as {
        tools?: string[];
        customTools?: Array<{ execute(...args: unknown[]): Promise<unknown> }>;
      };
      expect(options.tools).toEqual(['review_read']);
      expect(options.customTools).toHaveLength(1);
      const inside = join(fx.workspace, 'inside-review.txt');
      writeFileSync(inside, 'inside review canary', 'utf8');
      await expect(options.customTools![0]!.execute('call', { path: inside }, undefined, undefined, { cwd: fx.workspace }))
        .resolves.toSatisfy((result: unknown) => JSON.stringify(result).includes('inside review canary'));
      await expect(options.customTools![0]!.execute('call', { path: outside }, undefined, undefined, { cwd: fx.workspace }))
        .rejects.toThrow(/escapes the review working directory/);
      await expect(options.customTools![0]!.execute('call', { path: linkedOutside }, undefined, undefined, { cwd: fx.workspace }))
        .rejects.toThrow(/escapes the review working directory/);
    } finally {
      await handle.dispose();
    }
  });

  it('injects exactly the declared native tools into an isolated lens session, in-process #contract:review-native-tools:pi', async () => {
    const fx = await fixture([
      {
        deltas: [],
        toolCall: { id: 'submit-1', name: 'perkins_submit_findings', args: { findings: [{ title: 'candidate' }] } },
      },
      { deltas: ['lens done'] },
    ]);
    const executions: unknown[] = [];
    const submitFindings = {
      name: 'perkins_submit_findings',
      description: 'submit structured lens findings',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['findings'],
        properties: { findings: { type: 'array', items: { type: 'object' } } },
      },
      execute: async (input: unknown) => {
        executions.push(input);
        return { text: JSON.stringify({ accepted: true }), details: { accepted: true } };
      },
    };
    const handle = await fx.runtime.spawn('perkins', {
      cwd: fx.workspace,
      isolatedReview: {
        systemPrompt: 'isolated lens policy',
        tools: ['read', 'grep', 'find', 'ls'],
        nativeTools: [submitFindings],
      },
    });
    try {
      const options = twinGate.lastOptions as {
        tools?: string[];
        customTools?: Array<{ name: string }>;
      };
      // The declared set is exposed EXACTLY: confined read tools plus the one
      // declared native tool — never the lead's orchestration tools.
      expect(options.tools).toEqual([
        'review_read',
        'review_grep',
        'review_find',
        'review_ls',
        'perkins_submit_findings',
      ]);
      expect(options.customTools!.map((tool) => tool.name)).toEqual([
        'review_read',
        'review_grep',
        'review_find',
        'review_ls',
        'perkins_submit_findings',
      ]);
      expect(options.customTools!.some((tool) => tool.name === 'perkins_run_lenses')).toBe(false);
      // The session really calls the injected callback: the stub model emits
      // the tool call, the SDK executes it, and the next turn sees the result.
      await handle.prompt('submit the lens findings');
      expect(executions).toEqual([{ findings: [{ title: 'candidate' }] }]);
      expect(fx.script.calls).toHaveLength(2);
      expect(fx.script.calls[1]!.prompt).toContain('[TOOL_RESULT perkins_submit_findings]');
      expect(fx.script.calls[1]!.prompt).toContain('{"accepted":true}');
    } finally {
      await handle.dispose();
    }
  });

  it('rejects resume for isolated reviews so ambient history cannot cross the boundary #contract:isolated-review-no-resume:pi', async () => {
    const fx = await fixture();
    const ordinary = await fx.runtime.spawn('perkins');
    const file = ordinary.sessionFile!;
    await ordinary.dispose();
    await expect(fx.runtime.spawn('perkins', {
      resumeFile: file,
      isolatedReview: { systemPrompt: 'isolated', tools: [] },
    })).rejects.toThrow(/must be fresh/);
  });

  it('round-trips a prompt with ordered deltas, turn lifecycle, and a durable session file #contract:session-roundtrip:pi', async () => {
    const fx = await fixture([{ deltas: ['Hello', ' ', 'world'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('say hi', { owner: 'alice' });
      const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
      expect(deltas).toEqual(['Hello', ' ', 'world']);
      expect(events.filter((e) => e.type === 'turn_start').length).toBe(1);
      expect(events.filter((e) => e.type === 'turn_end').length).toBe(1);
      const states = events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
      expect(states).toContain('streaming');
      expect(states[states.length - 1]).toBe('idle');
      expect(handle.health().lastActivity).not.toBeNull();
      // Durable jsonl: header + user message + assistant message, at least.
      const lines = readFileSync(handle.sessionFile!, 'utf-8').trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      const header = JSON.parse(lines[0]!) as { type: string; cwd: string };
      expect(header.type).toBe('session');
      expect(header.cwd).toBe(fx.workspace);
    } finally {
      await handle.dispose();
    }
  });

  it('exposes native context usage and a failed native compact keeps the same session usable #contract:context-usage:pi', async () => {
    const fx = await fixture([{ deltas: ['one'] }, { deltas: ['two'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('first turn');
      const usage = handle.getContextUsage?.();
      const nativeUsage = (
        handle as unknown as {
          session: {
            getContextUsage(): {
              tokens: number | null;
              contextWindow: number;
              percent: number | null;
            } | undefined;
          };
        }
      ).session.getContextUsage();
      expect(usage).not.toBeNull();
      expect(nativeUsage?.tokens).not.toBeNull();
      expect(nativeUsage?.percent).not.toBeNull();
      expect(usage).toEqual({
        tokens: nativeUsage?.tokens,
        contextWindow: nativeUsage?.contextWindow,
        percent: Math.max(0, Math.min(100, nativeUsage!.percent!)),
      });
      expect(handle.canCompact?.()).toBe(true);
      const id = handle.id;
      const file = handle.sessionFile;
      await expect(handle.compact?.()).rejects.toThrow(/Nothing to compact|Already compacted/);
      expect(handle.id).toBe(id);
      expect(handle.sessionFile).toBe(file);
      expect(events.some((event) => event.type === 'compaction_start')).toBe(true);
      expect(
        events.some((event) => event.type === 'compaction_end' && !event.success),
      ).toBe(true);
      await handle.prompt('still usable');
      expect(fx.script.calls.map((call) => call.prompt)).toContain('still usable');
    } finally {
      await handle.dispose();
    }
  });

  it('successfully compacts through the installed Pi SDK without changing session identity #contract:compaction:pi', async () => {
    const fx = await fixture([
      { deltas: ['first answer'] },
      { deltas: ['second answer'] },
      { deltas: ['## Goal\nKeep the tested conversation usable.'] },
      { deltas: ['after compact'] },
    ]);
    writeFileSync(
      join(fx.agentDir, 'settings.json'),
      `${JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 100 } })}\n`,
      'utf-8',
    );
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('first turn');
      await handle.prompt('second turn');
      const id = handle.id;
      const file = handle.sessionFile;
      await handle.compact?.();
      expect(handle.id).toBe(id);
      expect(handle.sessionFile).toBe(file);
      expect(events.some((event) => event.type === 'compaction_end' && event.success)).toBe(true);
      expect(
        readFileSync(file!, 'utf-8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { type?: string })
          .some((entry) => entry.type === 'compaction'),
      ).toBe(true);
      // Pi deliberately withholds post-compaction usage until another model response.
      expect(handle.getContextUsage?.()).toBeNull();
      await handle.prompt('continue after compact');
      expect(handle.getContextUsage?.()).not.toBeNull();

      type InternalSession = {
        compact(): Promise<unknown>;
        readonly sessionId: string;
        readonly sessionFile: string | undefined;
        readonly isIdle: boolean;
        readonly isCompacting: boolean;
      };
      const internal = handle as unknown as { session: InternalSession };
      const nativeSession = internal.session;
      let release!: () => void;
      const heldSession = new Proxy(nativeSession, {
        get(target, key) {
          if (key === 'compact') {
            return () => new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return Reflect.get(target, key, target);
        },
      });
      internal.session = heldSession;
      const compacting = handle.compact!();
      expect(handle.isCompacting?.()).toBe(true);
      await expect(handle.compact?.()).rejects.toThrow(/busy/);
      await expect(handle.prompt('must not overlap')).rejects.toThrow(/compacting/);
      release();
      await expect(compacting).rejects.toThrow(/without a terminal event/);

      internal.session = new Proxy(nativeSession, {
        get(target, key) {
          if (key === 'compact') return async () => {};
          if (key === 'sessionId') return 'foreign-session-id';
          return Reflect.get(target, key, target);
        },
      });
      await expect(handle.compact?.()).rejects.toThrow(/changed session identity/);
      expect(handle.health().state).toBe('disposed');
      internal.session = nativeSession;
    } finally {
      await handle.dispose();
    }

    // Issue #161: a product-owned child id is NOT session-identity drift.
    // The native session id is compared, so an unchanged compaction on a
    // child handle settles instead of disposing the session.
    const childFx = await fixture([{ deltas: ['child answer'] }, { deltas: ['## Goal\nchild summary'] }]);
    writeFileSync(
      join(childFx.agentDir, 'settings.json'),
      `${JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 100 } })}\n`,
      'utf-8',
    );
    const child = await childFx.runtime.spawn('minion', { agentId: 'child-compact-id' });
    try {
      expect(child.id).toBe('child-compact-id');
      await child.prompt('child turn');
      const childFile = child.sessionFile;
      await child.compact?.();
      expect(child.id).toBe('child-compact-id');
      expect(child.sessionFile).toBe(childFile);
      expect(child.health().state).not.toBe('disposed');
    } finally {
      await child.dispose();
    }
  });

  it('resolves native compaction terminal failure when dispose races compact', async () => {
    const fx = await fixture([{ deltas: ['first answer'] }]);
    const handle = await fx.runtime.spawn('gru');
    const events = collect(handle);
    type InternalSession = {
      compact(): Promise<unknown>;
      dispose(): void;
      readonly sessionId: string;
      readonly sessionFile: string | undefined;
      readonly isIdle: boolean;
      readonly isCompacting: boolean;
    };
    const internal = handle as unknown as { session: InternalSession };
    const nativeSession = internal.session;
    let release!: () => void;
    internal.session = new Proxy(nativeSession, {
      get(target, key) {
        if (key === 'compact') {
          return () => new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Reflect.get(target, key, target);
      },
    });
    const compacting = handle.compact!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const disposing = handle.dispose();
    release();
    await expect(compacting).rejects.toThrow(/disposed during native compaction/);
    await disposing;
    expect(
      events.filter((event) => event.type === 'compaction_end' && !event.success),
    ).toHaveLength(1);
  });

  it('an explicit compaction Pi cancelled keeps Pi\'s own cancel terminal when its call then throws', async () => {
    const fx = await fixture([{ deltas: ['first answer'] }]);
    const handle = await fx.runtime.spawn('gru');
    const events = collect(handle);
    const internal = handle as unknown as { session: { compact(): Promise<unknown> }; onPiEvent(event: unknown): void };
    const nativeSession = internal.session;
    // As Pi's compact() does when cancelled: it emits its own aborted terminal, then rethrows.
    internal.session = new Proxy(nativeSession, {
      get(target, key) {
        if (key === 'compact') {
          return async () => {
            internal.onPiEvent({ type: 'compaction_start' });
            internal.onPiEvent({ type: 'compaction_end', aborted: true, willRetry: false });
            throw new Error('Compaction cancelled');
          };
        }
        return Reflect.get(target, key, target);
      },
    });
    try {
      await handle.prompt('prime');
      await expect(handle.compact!()).rejects.toThrow(/^compaction aborted$/u);
      expect(events.filter((event) => event.type === 'compaction_end')).toEqual([{ type: 'compaction_end', success: false, error: 'compaction aborted' }]);
    } finally {
      internal.session = nativeSession;
      await handle.dispose();
    }
  });

  it('a failed explicit compaction whose handlers outlast the reconcile bound with Pi\'s flag clear keeps the handle and publishes once', async () => {
    const fx = await fixture([{ deltas: ['first answer'] }, { deltas: ['still usable'] }]);
    const handle = await fx.runtime.spawn('gru');
    const events = collect(handle);
    const internal = handle as unknown as { session: { compact(): Promise<unknown> }; onPiEvent(event: unknown): void; flushCompactionEndWhenSettled(): void };
    const nativeSession = internal.session;
    let release!: () => void;
    let reachedHandlers = false;
    // As Pi's compact() fails: its flag clears, its terminal is emitted, then it
    // awaits slow session_compact_failed handlers before it rethrows.
    internal.session = new Proxy(nativeSession, {
      get(target, key) {
        if (key === 'compact') {
          return async () => {
            internal.onPiEvent({ type: 'compaction_start' });
            internal.onPiEvent({ type: 'compaction_end', aborted: false, willRetry: false, errorMessage: 'Compaction failed: summary provider failed' });
            reachedHandlers = true;
            await new Promise<void>((resolveHandlers) => { release = resolveHandlers; });
            throw new Error('summary provider failed');
          };
        }
        return Reflect.get(target, key, target);
      },
    });
    let clock: { mockRestore(): void } | null = null;
    try {
      await handle.prompt('prime');
      const compacting = handle.compact!().then(() => null, (error: Error) => error);
      await waitFor(() => reachedHandlers, 'Pi awaiting its failure handlers');
      const polls = vi.spyOn(internal, 'flushCompactionEndWhenSettled');
      const now = Date.now.bind(Date);
      clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + COMPACTION_END_RECONCILE_MS);
      await waitFor(() => polls.mock.calls.length >= 2, 'withheld-terminal polls past the reconcile bound');
      // Only the adapter's own flag holds: no failed terminal, no disposal.
      expect(events.filter((event) => event.type === 'compaction_end')).toEqual([]);
      expect(handle.health().state).not.toBe('disposed');
      clock.mockRestore(); clock = null; polls.mockRestore();
      release();
      expect(String(await compacting)).toContain('Compaction failed: summary provider failed');
      expect(events.filter((event) => event.type === 'compaction_end')).toEqual([{ type: 'compaction_end', success: false, error: 'Compaction failed: summary provider failed' }]);
      internal.session = nativeSession;
      await handle.prompt('still usable');
      expect(fx.script.calls.map((call) => call.prompt)).toContain('still usable');
    } finally {
      clock?.mockRestore();
      release?.();
      internal.session = nativeSession;
      await handle.dispose();
    }
  });

  it('never aborts a pending explicit compaction when time crosses the former #137 deadline', async () => {
    const fx = await fixture([{ deltas: ['first answer'] }]);
    const handle = await fx.runtime.spawn('gru');
    const events = collect(handle);
    type InternalSession = {
      compact(): Promise<unknown>;
      readonly sessionId: string;
      readonly sessionFile: string | undefined;
      readonly isIdle: boolean;
      readonly isCompacting: boolean;
    };
    const internal = handle as unknown as {
      session: InternalSession;
      onPiEvent(event: unknown): void;
    };
    const nativeSession = internal.session;
    let abortCalls = 0;
    let release!: () => void;
    internal.session = new Proxy(nativeSession, {
      get(target, key) {
        if (key === 'compact') {
          return () => new Promise<void>((resolve) => {
            release = () => {
              // The native terminal arrives with the SDK call, as in the real
              // adapter round-trip; then the summary call settles.
              internal.onPiEvent({ type: 'compaction_end' });
              resolve();
            };
          });
        }
        if (key === 'abort') {
          return async () => {
            abortCalls += 1;
          };
        }
        return Reflect.get(target, key, target);
      },
    });
    try {
      await handle.prompt('prime');
      vi.useFakeTimers();
      const settled = handle.compact!().then(
        () => null,
        (error: Error) => error,
      );
      // Cross the former five-minute wrapper deadline: nothing may abort the
      // compaction or settle the pending reply on this timer (rollback of
      // PR #137's deadline).
      await vi.advanceTimersByTimeAsync(300_001);
      expect(abortCalls).toBe(0);
      expect(events.some((event) => event.type === 'compaction_end')).toBe(false);
      release();
      await expect(settled).resolves.toBeNull();
      const ends = events.filter((event) => event.type === 'compaction_end');
      expect(ends).toHaveLength(1);
      expect((ends[0] as { success: boolean }).success).toBe(true);
    } finally {
      vi.useRealTimers();
      internal.session = nativeSession;
      await handle.dispose();
    }
  });

  it('never aborts a silent native compaction at the former #137 deadline and publishes its completion', async () => {
    const fx = await fixture([{ deltas: ['first answer'] }]);
    const handle = await fx.runtime.spawn('gru');
    const events = collect(handle);
    const internal = handle as unknown as {
      session: { abort?(): Promise<void> };
      onPiEvent(event: unknown): void;
    };
    const nativeSession = internal.session;
    let abortCalls = 0;
    internal.session = new Proxy(nativeSession, {
      get(target, key) {
        if (key === 'abort') {
          return async () => {
            abortCalls += 1;
          };
        }
        return Reflect.get(target, key, target);
      },
    });
    try {
      await handle.prompt('prime');
      vi.useFakeTimers();
      internal.onPiEvent({ type: 'compaction_start', reason: 'threshold' });
      await vi.advanceTimersByTimeAsync(300_001);
      expect(abortCalls).toBe(0);
      expect(events.some((event) => event.type === 'compaction_end')).toBe(false);
      // Native completion proceeds promptly — no timer must be awaited.
      internal.onPiEvent({ type: 'compaction_end' });
      const ends = events.filter((event) => event.type === 'compaction_end');
      expect(ends).toHaveLength(1);
      expect((ends[0] as { success: boolean }).success).toBe(true);
    } finally {
      vi.useRealTimers();
      internal.session = nativeSession;
      await handle.dispose();
    }
  });

  describe('compaction cancellation boundary: summary-only vs broad (test-only seam, no product change)', () => {
    it('broad cancellation: the live pending turn is cancelled and surfaces the SDK abort error', async () => {
      const observation = await observeCompactionCancellation('broad', 'abort-settles');
      expect(observation.cancellations).toBe(1);
      expect(observation.abortOutcome).toBe('resolved');
      expect(observation.turn).toBe('resolved');
      expect(observation.errorEvents).toBe(1);
      // The surfaced error is the SDK abort message, not an anonymous failure:
      // the test title's claim is pinned to the actual text.
      expect(observation.errorMessages).toHaveLength(1);
      expect(observation.errorMessages[0]).toContain('aborted');
      expect(observation.stateErrors).toBe(1);
      expect(observation.assistantErrors).toBe(1);
      expect(observation.continuationReachedModel).toBe(false);
      expect(observation.recoveredReplyDelta).toBe(false);
      expect(observation.recoveredReplyState).toBe(false);
      expect(observation.recoveredReplyDurable).toBe(false);
      expect(observation.summarySettledByAbort).toBe(true);
      // The aborted first cycle is superseded by the SDK's immediate
      // prepareNextTurn retry, which completes before the adapter's single
      // pending-terminal slot has an idle gate to publish: consumers see the
      // eventual success exactly once, never a duplicate or a wedged slot.
      expect(observation.abortedEnds).toBe(0);
      expect(observation.successEnds).toBe(1);
      // Acceptance D: the COMPLETE external terminal list, not just success
      // and the one exact failure text — a differently-worded extra terminal
      // can no longer escape this oracle.
      expect(observation.terminalEnds).toEqual([{ success: true, error: null }]);
      expect(observation.rawSdkCompactionEnds).toBeGreaterThanOrEqual(1);
      expect(observation.queuedDelivered).toBe(1);
      expect(observation.queued).toBe('resolved');
      expect(observation.queuedPendingDuringStall).toBe(true);
      expect(observation.queuedModelCallsDuringStall).toBe(0);
      expect(observation.guardMessages).toEqual([
        'agent session is compacting; prompt requires an idle session',
        'agent session is compacting; steer requires an idle session',
        'agent session is compacting; follow-up requires an idle session',
      ]);
      expect(observation.guardModelCallsDuringStall).toBe(0);
      expect(observation.guardModelCalls).toBe(0);
      expect(observation.stalledSummaryCalls).toBeGreaterThanOrEqual(1);
      expect(observation.afterSettle).toBe('resolved');
      expect(observation.afterSettleDelivered).toBe(1);
      expect(observation.idle).toBe(true);
      expect(observation.disposed).toBe(false);
    });

    it('narrow cancellation: the pending turn answers, no error events, follow-up work exactly once', async () => {
      const observation = await observeCompactionCancellation('narrow', 'abort-settles');
      expect(observation.cancellations).toBe(1);
      expect(observation.abortOutcome).toBeNull();
      expect(observation.turn).toBe('resolved');
      expect(observation.errorEvents).toBe(0);
      expect(observation.stateErrors).toBe(0);
      expect(observation.assistantErrors).toBe(0);
      expect(observation.continuationReachedModel).toBe(true);
      expect(observation.recoveredReplyDelta).toBe(true);
      expect(observation.recoveredReplyState).toBe(true);
      expect(observation.recoveredReplyDurable).toBe(true);
      expect(observation.summarySettledByAbort).toBe(true);
      // The SDK reports the summary-only cancellation as an aborted
      // compaction; the adapter publishes that failure terminal exactly once.
      expect(observation.abortedEnds).toBe(1);
      expect(observation.successEnds).toBe(0);
      expect(observation.terminalEnds).toEqual([{ success: false, error: 'compaction aborted' }]);
      expect(observation.rawSdkCompactionEnds).toBeGreaterThanOrEqual(1);
      expect(observation.queuedDelivered).toBe(1);
      expect(observation.queued).toBe('resolved');
      expect(observation.queuedPendingDuringStall).toBe(true);
      expect(observation.queuedModelCallsDuringStall).toBe(0);
      expect(observation.guardMessages).toEqual([
        'agent session is compacting; prompt requires an idle session',
        'agent session is compacting; steer requires an idle session',
        'agent session is compacting; follow-up requires an idle session',
      ]);
      expect(observation.guardModelCallsDuringStall).toBe(0);
      expect(observation.guardModelCalls).toBe(0);
      expect(observation.stalledSummaryCalls).toBeGreaterThanOrEqual(1);
      expect(observation.afterSettle).toBe('resolved');
      expect(observation.afterSettleDelivered).toBe(1);
      expect(observation.idle).toBe(true);
      expect(observation.disposed).toBe(false);
    });

    it('late terminal under broad cancellation: the cancelled run stays cancelled; one terminal publishes', async () => {
      const observation = await observeCompactionCancellation('broad', 'late-terminal');
      expect(observation.cancellations).toBe(1);
      expect(observation.abortOutcome).toBe('resolved');
      expect(observation.turn).toBe('resolved');
      expect(observation.errorEvents).toBe(1);
      expect(observation.errorMessages).toHaveLength(1);
      expect(observation.errorMessages[0]).toContain('aborted');
      expect(observation.assistantErrors).toBe(1);
      expect(observation.continuationReachedModel).toBe(false);
      expect(observation.recoveredReplyDelta).toBe(false);
      expect(observation.recoveredReplyState).toBe(false);
      expect(observation.recoveredReplyDurable).toBe(false);
      expect(observation.summarySettledByAbort).toBe(false);
      expect(observation.abortedEnds).toBe(0);
      expect(observation.successEnds).toBe(1);
      expect(observation.terminalEnds).toEqual([{ success: true, error: null }]);
      expect(observation.rawSdkCompactionEnds).toBeGreaterThanOrEqual(1);
      expect(observation.queuedDelivered).toBe(1);
      expect(observation.queued).toBe('resolved');
      expect(observation.queuedPendingDuringStall).toBe(true);
      expect(observation.queuedModelCallsDuringStall).toBe(0);
      expect(observation.guardMessages).toEqual([
        'agent session is compacting; prompt requires an idle session',
        'agent session is compacting; steer requires an idle session',
        'agent session is compacting; follow-up requires an idle session',
      ]);
      expect(observation.guardModelCallsDuringStall).toBe(0);
      expect(observation.guardModelCalls).toBe(0);
      expect(observation.stalledSummaryCalls).toBeGreaterThanOrEqual(1);
      expect(observation.afterSettle).toBe('resolved');
      expect(observation.afterSettleDelivered).toBe(1);
      expect(observation.idle).toBe(true);
      expect(observation.disposed).toBe(false);
      // r7: the zero-premature-delivery interval is pinned AFTER cancellation
      // while the transport is still held: work stays owed on the actual
      // surface, nothing reached the model, and fresh execution is refused.
      expect(observation.queuedSettledAfterCancel).toBe(false);
      expect(observation.queuedModelCallsAfterCancel).toBe(0);
      expect(observation.continuationCallsAfterCancel).toBe(0);
      expect(observation.postCancelGuardMessages).toEqual([
        'agent session is compacting; prompt requires an idle session',
        'agent session is compacting; steer requires an idle session',
        'agent session is compacting; follow-up requires an idle session',
      ]);
      expect(observation.postCancelGuardModelCalls).toBe(0);
    });

    it('late terminal under narrow cancellation: the run recovers and no terminal duplicates publish', async () => {
      const observation = await observeCompactionCancellation('narrow', 'late-terminal');
      expect(observation.cancellations).toBe(1);
      expect(observation.abortOutcome).toBeNull();
      expect(observation.turn).toBe('resolved');
      expect(observation.errorEvents).toBe(0);
      expect(observation.assistantErrors).toBe(0);
      expect(observation.continuationReachedModel).toBe(true);
      expect(observation.recoveredReplyDelta).toBe(true);
      expect(observation.recoveredReplyState).toBe(true);
      expect(observation.recoveredReplyDurable).toBe(true);
      expect(observation.summarySettledByAbort).toBe(false);
      expect(observation.abortedEnds).toBe(1);
      expect(observation.successEnds).toBe(0);
      expect(observation.terminalEnds).toEqual([{ success: false, error: 'compaction aborted' }]);
      expect(observation.rawSdkCompactionEnds).toBeGreaterThanOrEqual(1);
      expect(observation.queuedDelivered).toBe(1);
      expect(observation.queued).toBe('resolved');
      expect(observation.queuedPendingDuringStall).toBe(true);
      expect(observation.queuedModelCallsDuringStall).toBe(0);
      expect(observation.guardMessages).toEqual([
        'agent session is compacting; prompt requires an idle session',
        'agent session is compacting; steer requires an idle session',
        'agent session is compacting; follow-up requires an idle session',
      ]);
      expect(observation.guardModelCallsDuringStall).toBe(0);
      expect(observation.guardModelCalls).toBe(0);
      expect(observation.stalledSummaryCalls).toBeGreaterThanOrEqual(1);
      expect(observation.afterSettle).toBe('resolved');
      expect(observation.afterSettleDelivered).toBe(1);
      expect(observation.idle).toBe(true);
      expect(observation.disposed).toBe(false);
      // r7: the zero-premature-delivery interval is pinned AFTER cancellation
      // while the transport is still held: work stays owed on the actual
      // surface, nothing reached the model, and fresh execution is refused.
      expect(observation.queuedSettledAfterCancel).toBe(false);
      expect(observation.queuedModelCallsAfterCancel).toBe(0);
      expect(observation.continuationCallsAfterCancel).toBe(0);
      expect(observation.postCancelGuardMessages).toEqual([
        'agent session is compacting; prompt requires an idle session',
        'agent session is compacting; steer requires an idle session',
        'agent session is compacting; follow-up requires an idle session',
      ]);
      expect(observation.postCancelGuardModelCalls).toBe(0);
    });

    it('explicit stop context: dispose aborts the live stream, rejects queued work, and releases the session', async () => {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The live stream honors the request signal: disposal must settle it by
      // abort instead of waiting on a hold only the test can release.
      const fx = await fixture([
        { deltas: ['live'], hold, honorAbort: true },
        { deltas: ['never'] },
      ]);
      const handle = await fx.runtime.spawn('gru');
      expect(handle.sessionFile).not.toBeNull();
      const sessionFile = handle.sessionFile!;
      const live = handle.prompt('live turn').then(
        () => 'resolved',
        (error: Error) => `rejected:${error.message}`,
      );
      const queued = handle.prompt('queued behind live', { owner: 'other' }).then(
        () => 'resolved',
        (error: Error) => `rejected:${error.message}`,
      );
      try {
        await waitFor(
          () => fx.script.calls.some((call) => call.prompt === 'live turn'),
          'live turn admitted',
        );
        await handle.dispose();
        // Disposal settled the live stream by abort — never left it held.
        await waitFor(
          () => fx.script.calls[0]?.aborted === true,
          'live stream abort settlement',
        );
        expect(fx.script.calls[0]?.aborted).toBe(true);
        expect(await queued).toMatch(
          /rejected:agent session disposed before queued message was delivered/,
        );
        expect(handle.health().state).toBe('disposed');
        expect(existsSync(`${sessionFile}.lock`)).toBe(false);
        // The queued request never reached the model; only the live one did.
        const prompts = fx.script.calls.map((call) => call.prompt);
        expect(prompts).not.toContain('queued behind live');
        expect(prompts).toEqual(['live turn']);
        // The aborted live turn settles (no wedged run); its stream-abort
        // settlement is pinned above, and disposal owns the terminal state.
        // Pin the outcome too: an unexpected provider failure must not pass
        // behind the successful stream-abort check.
        expect(await live).toBe('resolved');
      } finally {
        release();
        await live.catch(() => {});
        await handle.dispose();
      }
    });

    it('a stuck native gate after its terminal reconciles at the 5s bound: one failed terminal, then disposal', async () => {
      const fx = await fixture([{ deltas: ['prime'] }]);
      const handle = await fx.runtime.spawn('gru');
      const events = collect(handle);
      const internal = handle as unknown as {
        session: import('@earendil-works/pi-coding-agent').AgentSession;
        readonly liveTurn: Promise<void> | null;
        readonly compactionWork: Promise<void> | null;
        readonly compacting: boolean;
        readonly nativeCompactionOpen: boolean;
        readonly pendingCompactionEnd: unknown | null;
        readonly explicitCompactionTerminal: { readonly settled: boolean } | null;
        readonly queue: readonly unknown[];
        onPiEvent(event: unknown): void;
      };
      const nativeSession = await actualDirectiveSdkSession(handle);
      const nativeDisposal = vi.spyOn(nativeSession, 'dispose'); // actual pinned SDK call-through
      let injectedGate = true;
      let releaseCleanup!: () => void;
      const cleanupAllowed = new Promise<void>((resolveGate) => { releaseCleanup = resolveGate; });
      let cleanupStarted!: () => void;
      const cleanupInvoked = new Promise<void>((resolveGate) => { cleanupStarted = resolveGate; });
      const disposeNative = async (): Promise<void> => {
        cleanupStarted();
        await cleanupAllowed;
        await nativeSession.dispose();
        await nativeSession.agent.waitForIdle();
        await nativeSession.waitForIdle();
        if (!nativeSession.isIdle || nativeSession.isStreaming || nativeSession.isCompacting ||
            nativeSession.isBashRunning || nativeSession.hasPendingBashMessages || nativeSession.pendingMessageCount !== 0 ||
            nativeSession.agent.hasQueuedMessages() || internal.liveTurn !== null || internal.compactionWork !== null ||
            internal.compacting || internal.nativeCompactionOpen || internal.pendingCompactionEnd !== null ||
            internal.explicitCompactionTerminal?.settled === false || internal.queue.length !== 0) {
          throw new Error('fixture cannot end its injected gate without actual SDK/adapter/controller quiescence');
        }
        // End ONLY the artificial post-terminal probe, after successful real
        // required SDK cleanup AND observed native/adapter quiescence.
        injectedGate = false;
      };
      try {
        await handle.prompt('prime');
        // Pi dispatches compaction_end before the session clears isCompacting;
        // hold that gate closed to pin the adapter's bounded reconciliation.
        internal.session = new Proxy(nativeSession, {
          get(target, key) {
            if (key === 'isCompacting' && injectedGate) return true;
            if (key === 'dispose') return disposeNative;
            return Reflect.get(target, key, target);
          },
        });
        // Fake timers AFTER the real session is primed: the reconcile bound is
        // then pinned deterministically instead of measuring host scheduling
        // (a delayed worker could otherwise resume the negative check after
        // the bound, or the positive check after a wall-clock ceiling, despite
        // correct behavior).
        vi.useFakeTimers();
        try {
          internal.onPiEvent({ type: 'compaction_start' });
          internal.onPiEvent({ type: 'compaction_end', aborted: true });
          // Nothing publishes before the bound.
          await vi.advanceTimersByTimeAsync(4_999);
          expect(events.some((event) => event.type === 'compaction_end')).toBe(false);
          // Crossing the 5,000ms bound (with one second of fake-clock slack so
          // a widened constant still fails while a poll-cadence change does
          // not) publishes exactly one failed terminal.
          await vi.advanceTimersByTimeAsync(1_000);
          const ends = events.filter(
            (event): event is Extract<RuntimeEvent, { type: 'compaction_end' }> =>
              event.type === 'compaction_end',
          );
          expect(ends).toHaveLength(1);
          expect(ends[0]!.success).toBe(false);
          expect(ends[0]!.error).toBe('native compaction state did not settle after its terminal event');
          await cleanupInvoked;
          expect(injectedGate).toBe(true);
          expect(nativeDisposal).not.toHaveBeenCalled();
          expect(handle.cessationEvidence!()).toBe('unknown');
          expect(handle.health().state).not.toBe('disposed');
          expect(fx.store.isHeld(handle.sessionFile!)).toBe(true);
          expect(existsSync(`${handle.sessionFile!}.lock`)).toBe(true);
          expect(events.filter((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased')).toEqual([]);
          releaseCleanup();
          // Drain any disposal timers while the fake clock is still installed.
          await vi.advanceTimersByTimeAsync(60_000);
        } finally {
          vi.useRealTimers();
        }
        // The reconcile path disposes instead of wedging on the stuck gate.
        await waitFor(() => handle.health().state === 'disposed', 'reconciled disposal');
        expect(handle.sessionFile).not.toBeNull();
        expect(existsSync(`${handle.sessionFile!}.lock`)).toBe(false);
        expect(nativeDisposal).toHaveBeenCalledTimes(1);
        expect(injectedGate).toBe(false);
        expect(nativeSession.isIdle).toBe(true);
        expect(nativeSession.isStreaming).toBe(false);
        expect(nativeSession.isCompacting).toBe(false);
        expect(nativeSession.isBashRunning).toBe(false);
        expect(nativeSession.hasPendingBashMessages).toBe(false);
        expect(events.filter((event) => event.type === 'compaction_end')).toHaveLength(1);
        await handle.dispose();
        expect(nativeDisposal).toHaveBeenCalledTimes(1);
      } finally {
        releaseCleanup();
        try { await handle.dispose(); }
        finally {
          if (!injectedGate) internal.session = nativeSession;
          nativeDisposal.mockRestore();
        }
      }
    });

    it('a signal-ignoring summary keeps compaction open until disposal: one failed terminal, no duplicates', async () => {
      let releaseSummary: () => void = () => {};
      const summaryHold = new Promise<void>((resolve) => {
        releaseSummary = resolve;
      });
      const fx = await fixture((prompt, index) => {
        if (isSummaryRequest(prompt)) return { deltas: [], hold: summaryHold };
        if (index === 0) return { deltas: ['history '.repeat(12_000)] };
        if (index === 1) {
          return {
            deltas: [],
            toolCall: { id: 'call-1', name: 'read', args: { path: 'missing.txt' } },
            usageTokens: 90_000,
          };
        }
        return { deltas: [`answer-${index}`] };
      });
      const handle = await fx.runtime.spawn('gru');
      const events = collect(handle);
      const internal = handle as unknown as {
        session: { abortCompaction?: () => void };
      };
      let disposal: Promise<void> | null = null;
      try {
        await handle.prompt('start');
        const turn = handle.prompt('do the work').then(
          () => 'resolved',
          (error: Error) => `rejected:${error.message}`,
        );
        await waitFor(
          () => events.some((event) => event.type === 'compaction_start'),
          'compaction_start',
        );
        if (internal.session.abortCompaction === undefined) {
          throw new Error('SDK session is missing abortCompaction()');
        }
        internal.session.abortCompaction();
        // The transport ignores the cancellation: no terminal is fabricated
        // while the summary stays open.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(events.some((event) => event.type === 'compaction_end')).toBe(false);
        // Disposal is the way out of a truly stuck provider summary. Its
        // failed terminal is published synchronously, before disposal awaits
        // SDK session-level idle (which can wait on the held summary), so
        // start disposal without awaiting it, inspect that terminal while the
        // stream is still held, then release the stream and await the ORIGINAL
        // disposal promise. A second dispose() call returns early and does not
        // join the first, so cleanup keeps this promise.
        disposal = handle.dispose();
        const endsWhileHeld = events.filter(
          (event): event is Extract<RuntimeEvent, { type: 'compaction_end' }> =>
            event.type === 'compaction_end',
        );
        expect(endsWhileHeld).toHaveLength(1);
        expect(endsWhileHeld[0]!.success).toBe(false);
        expect(endsWhileHeld[0]!.error).toBe('agent session disposed during native compaction');
        // No second terminal while the summary remains open.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(
          events.filter((event) => event.type === 'compaction_end'),
        ).toHaveLength(1);
        releaseSummary();
        await disposal;
        await turn.catch(() => {});
        expect(handle.health().state).toBe('disposed');
        expect(handle.sessionFile).not.toBeNull();
        expect(existsSync(`${handle.sessionFile!}.lock`)).toBe(false);
        // A late transport settlement adds no second terminal.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(
          events.filter((event) => event.type === 'compaction_end'),
        ).toHaveLength(1);
      } finally {
        releaseSummary();
        if (disposal !== null) await disposal.catch(() => {});
        else await handle.dispose().catch(() => {});
      }
    });

    it('native SDK follow-up: admitted before compaction, pending through the stall, delivered once (signal settles) #contract:steering:pi', async () => {
      const observation = await observeNativeFollowUpCancellation('abort-settles');
      expect(observation.pendingAfterAdmission).toBe(1);
      expect(observation.pendingDuringStall).toBe(1);
      expect(observation.modelCallsDuringStall).toBe(0);
      expect(observation.turn).toBe('resolved');
      expect(observation.errorEvents).toBe(0);
      expect(observation.continuationReachedModel).toBe(true);
      expect(observation.delivered).toBe(1);
      expect(observation.pendingAfterSettlement).toBe(0);
      expect(observation.abortedEnds).toBe(1);
      expect(observation.successEnds).toBe(0);
      expect(observation.terminalEnds).toEqual([{ success: false, error: 'compaction aborted' }]);
      expect(observation.summarySettledByAbort).toBe(true);
      expect(observation.idle).toBe(true);
      expect(observation.disposed).toBe(false);
      expect(observation.followUpReplyDelta).toBe(true);
      expect(observation.followUpReplyState).toBe(true);
    });

    it('native SDK follow-up: late transport settlement still delivers the pending message exactly once', async () => {
      const observation = await observeNativeFollowUpCancellation('late-terminal');
      expect(observation.pendingAfterAdmission).toBe(1);
      expect(observation.pendingDuringStall).toBe(1);
      expect(observation.modelCallsDuringStall).toBe(0);
      expect(observation.turn).toBe('resolved');
      expect(observation.errorEvents).toBe(0);
      expect(observation.continuationReachedModel).toBe(true);
      expect(observation.delivered).toBe(1);
      expect(observation.pendingAfterSettlement).toBe(0);
      expect(observation.abortedEnds).toBe(1);
      expect(observation.successEnds).toBe(0);
      expect(observation.terminalEnds).toEqual([{ success: false, error: 'compaction aborted' }]);
      expect(observation.summarySettledByAbort).toBe(false);
      expect(observation.idle).toBe(true);
      expect(observation.disposed).toBe(false);
      // r7: the held-transport interval is pinned AFTER cancellation too: the
      // native queue still owes the message on its real surface, nothing
      // reached the model, and fresh execution is refused.
      expect(observation.pendingAfterCancel).toBe(1);
      expect(observation.modelCallsAfterCancel).toBe(0);
      expect(observation.postCancelGuardMessages).toEqual([
        'agent session is compacting; prompt requires an idle session',
        'agent session is compacting; steer requires an idle session',
        'agent session is compacting; follow-up requires an idle session',
      ]);
      expect(observation.postCancelGuardModelCalls).toBe(0);
      expect(observation.followUpReplyDelta).toBe(true);
      expect(observation.followUpReplyState).toBe(true);
    });
  });

  it('emits thinking deltas before text when the model reasons #contract:thinking-deltas:pi', async () => {
    const fx = await fixture([{ thinking: ['pondering'], deltas: ['answer'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('think hard');
      const kinds = events
        .filter((e) => e.type === 'thinking_delta' || e.type === 'text_delta')
        .map((e) => e.type);
      expect(kinds).toEqual(['thinking_delta', 'text_delta']);
    } finally {
      await handle.dispose();
    }
  });

  it('single-writer: a second owner while a turn is live queues, then delivers in order', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([
      { deltas: ['first-turn'], hold },
      { deltas: ['second-turn'] },
    ]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      const alice = handle.prompt('q1', { owner: 'alice' });
      const bob = handle.prompt('q2', { owner: 'bob' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['q1']);
      expect(events.some((e) => e.type === 'queued' && e.owner === 'bob')).toBe(true);
      release();
      await Promise.all([alice, bob]);
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['q1', 'q2']);
      // Turns never interleave: bob's turn starts strictly after alice's ends.
      const turnEnds = events.filter((e) => e.type === 'turn_end').length;
      const stateIdleAfterFirst = events.some((e) => e.type === 'state' && (e as { state: string }).state === 'idle');
      expect(turnEnds).toBe(2);
      expect(stateIdleAfterFirst).toBe(true);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('pi queue honors opt-in timeoutMs: the caller rejects, the queue survives', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([
      { deltas: ['first'], hold },
      { deltas: ['later'] },
    ]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const alice = handle.prompt('q1', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const impatient = handle.prompt('q-impatient', { owner: 'bob', timeoutMs: 20 });
      const patient = handle.prompt('q-patient', { owner: 'carol' });
      await expect(impatient).rejects.toThrow(/queued wait timed out after 20ms/);
      release();
      await Promise.all([alice, patient]);
      // The timed-out caller never reached the model; the patient one did.
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['q1', 'q-patient']);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it("owner steer and followUp during the owner's live turn pass through natively", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['base'], hold }, { deltas: ['steer'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      const alice = handle.prompt('go', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Owner channels: no queueing, no throw.
      await handle.steer('adjust course', { owner: 'alice' });
      await handle.followUp('then summarize', { owner: 'alice' });
      release();
      await alice;
      // No single-writer queue events: owner channels are native.
      expect(events.some((e) => e.type === 'queued')).toBe(false);
      // The steering/followUp texts reach the model as delivered user turns
      // (pi delivers them after the in-flight tool call window).
      const delivered = fx.script.calls.map((c) => c.prompt);
      expect(delivered[0]).toBe('go');
      expect(delivered).toContain('adjust course');
      expect(delivered).toContain('then summarize');
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('non-owner steer while live queues instead of interleaving', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['a'], hold }, { deltas: ['b'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const alice = handle.prompt('mine', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const bobSteer = handle.steer('bob tries', { owner: 'bob' });
      release();
      await Promise.all([alice, bobSteer]);
      // bob's steer became a queued follow-on prompt, delivered after idle.
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['mine', 'bob tries']);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('resumes a previous session file with history intact (process restart) #contract:session-resume:pi', async () => {
    const fx = await fixture([{ deltas: ['first'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('remember this', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    const entriesBefore = readFileSync(file, 'utf-8').trim().split('\n').length;

    // "New process": same instance data dir, fresh store + adapter.
    const config = loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester');
    const secondStore = new SessionStore(config.dataDir);
    const second = new PiRuntime({
      config,
      store: secondStore,
      agentDir: fx.agentDir,
      modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['second'] }])),
    });
    const resumed = await second.spawn('gru', { resumeFile: file });
    try {
      expect(resumed.sessionFile).toBe(file); // same file, no duplicate session
      await resumed.prompt('continue', { owner: 'alice' });
      const entriesAfter = readFileSync(file, 'utf-8').trim().split('\n').length;
      expect(entriesAfter).toBeGreaterThan(entriesBefore);
    } finally {
      await resumed.dispose();
    }
  });

  it('opens and resumes a session file written by pi 0.85.1 (#521)', async () => {
    const fx = await fixture([{ deltas: ['after the upgrade'] }]);
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const sessionDir = join(fx.store.sessionsDir, 'gru', 'pi-0-85-fixture');
    mkdirSync(sessionDir, { recursive: true });
    const copyOf = (name: string): string => {
      const copy = join(sessionDir, name);
      copyFileSync(PI_085_SESSION, copy);
      return copy;
    };
    // The adapter opens a resumed file with SessionManager.open(file, dir, cwd);
    // the fixture's own neutral cwd opens cleanly with its four messages.
    const sdkCopy = copyOf('sdk-open.jsonl');
    const opened = SessionManager.open(sdkCopy, sessionDir, '/fixture/project');
    expect(opened.getCwd()).toBe('/fixture/project');
    expect(opened.buildSessionContext().messages).toHaveLength(4);

    // The adapter's own resume path (a spawn cwd must exist, so the session
    // runs in the fixture workspace while its recorded cwd stays old).
    const adapterCopy = copyOf('adapter-resume.jsonl');
    const resumed = await fx.runtime.spawn('gru', { resumeFile: adapterCopy, model: `${STUB_PROVIDER_ID}/${STUB_MODEL_ID}` });
    try {
      expect(resumed.sessionFile).toBe(adapterCopy);
      // The resumed session holds the old transcript's four messages (whether
      // resume rewrites the copy is recorded in the PR, not asserted here).
      const resumedSession = await actualDirectiveSdkSession(resumed);
      expect(resumedSession.agent.state.messages.map((entry) => entry.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
      await resumed.prompt('continue', { owner: 'alice' });
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['continue']);
    } finally {
      await resumed.dispose();
    }
  });

  it('the executor fence survives the SDK re-applying the tool loadout, and a session registers no MCP, codemode or tool-search tool (#521)', async () => {
    const fx = await fixture([{ deltas: ['one'] }, { deltas: ['two'] }]);
    const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
    const session = await actualDirectiveSdkSession(handle);
    // The SDK's own tool registry: what it hands the agent before the adapter's guard.
    const registry = (session as unknown as { readonly _toolRegistry: ReadonlyMap<string, { readonly execute: unknown }> })._toolRegistry;
    const guarded = () => session.agent.state.tools.every((tool) => tool.execute !== registry.get(tool.name)!.execute);
    try {
      const executors = session.agent.state.tools.map((tool) => tool.execute);
      expect(guarded()).toBe(true);
      await handle.prompt('first', { owner: 'alice' });
      await handle.prompt('second', { owner: 'alice' });
      // Pi 1.x re-applies the loadout before every prompt: the same guarded executors must still stand.
      expect(guarded()).toBe(true);
      expect(session.agent.state.tools.map((tool) => tool.execute)).toEqual(executors);
      expect(session.getAllTools().map((tool) => tool.name).sort()).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
    } finally {
      await handle.dispose();
      await fx.runtime.dispose();
      fx.store.dispose();
    }
  });

  it('a session whose agent state no longer exposes an assignable tools accessor is refused by name before anything is registered (#521)', async () => {
    const fx = await fixture([]);
    twinGate.breakToolsAccessor = true;
    try {
      await expect(fx.runtime.spawn('minion', { cwd: fx.workspace })).rejects.toThrow(
        'the pi SDK agent state no longer exposes an assignable tools accessor; refusing to run without the directive executor fence',
      );
    } finally { twinGate.breakToolsAccessor = false; }
    // No lock was taken and no session file is held by the refused spawn.
    expect((readdirSync(fx.store.sessionsDir, { recursive: true }) as string[]).filter((name) => name.endsWith('.lock'))).toEqual([]);
    await fx.runtime.dispose();
    fx.store.dispose();
  });

  it('a session the installed SDK wrote reads back through the transcript service without its scaffolding entries (#521)', async () => {
    const { TranscriptService } = await import('../src/transcripts/service.js');
    const fx = await fixture([{ deltas: [], toolCall: { id: 'call-1', name: 'ls', args: {} } }, { deltas: ['listed'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      await handle.prompt('list my files', { owner: 'alice' });
      expect(readFileSync(handle.sessionFile!, 'utf-8')).toContain('"role":"system"');
      const result = new TranscriptService(fx.store.sessionsDir).read(relative(fx.store.sessionsDir, handle.sessionFile!));
      expect(result.tornLines).toBe(0);
      expect(result.entries.map((entry) => [entry.kind, entry.toolName])).toEqual([['user', null], ['assistant', null], ['tool_result', 'ls'], ['assistant', null]]);
    } finally {
      await handle.dispose();
    }
  });

  it('a directive on a resumed session whose prompt inputs changed runs its tool: the manifest binds the prompt the run carries (#521)', async () => {
    const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
    const fx = await fixture([
      { deltas: ['ordinary reply'] },
      { deltas: [], toolCall: { id: 'changed-prompt-call', name: 'bash', args: { command: "printf 'ran\\n' > changed-prompt.txt" } } },
      { deltas: ['done'] },
    ]);
    const identity = { requestId: 'changed-prompt', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'changed-prompt-job', workRevision: 0, authorityEpoch: 0 };
    const first = await fx.runtime.spawn('minion', { cwd: fx.workspace, agentId: 'changed-prompt-minion' });
    await first.prompt('ordinary work', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    // A project rule file changes between the two runs, so the resumed run's
    // prompt differs from the persisted one and Pi persists a system patch
    // ahead of the directive's receipt.
    writeFileSync(join(fx.workspace, 'AGENTS.md'), 'Project rule: changed after the first run.\n');
    const resumed = await fx.runtime.spawn('minion', { cwd: fx.workspace, agentId: 'changed-prompt-minion', resumeFile: file });
    try {
      const verdict = await resumed.promptWithVerdict!('approved directive', { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } });
      expect(verdict).toMatchObject({ ok: true });
      expect(readFileSync(join(fx.workspace, 'changed-prompt.txt'), 'utf-8')).toBe('ran\n');
      const rows = readFileSync(file, 'utf-8').trimEnd().split('\n').map((line) => JSON.parse(line) as { readonly message?: { readonly role: string } });
      expect(rows.filter((row) => row.message?.role === 'system')).toHaveLength(2);
      expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true });
    } finally {
      await resumed.dispose();
      await fx.runtime.dispose();
      fx.store.dispose();
    }
  });

  it('a directive on a resumed session whose persisted prompt carries text the effective prompt does not is refused before its receipt and its first request (#521)', async () => {
    const fx = await fixture([
      { deltas: ['ordinary reply'] },
      { deltas: [], toolCall: { id: 'unbound-prompt-call', name: 'bash', args: { command: "printf 'ran\\n' > unbound-prompt.txt" } } },
      { deltas: ['unreachable'] },
    ]);
    const identity = { requestId: 'unbound-prompt', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'unbound-prompt-job', workRevision: 0, authorityEpoch: 0 };
    const first = await fx.runtime.spawn('minion', { cwd: fx.workspace, agentId: 'unbound-prompt-minion' });
    await first.prompt('ordinary work', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    // The persisted system message gains text no approved prompt carries. The
    // SDK diffs prompt sections only, so it would replay that text unchanged.
    type Row = { message?: { role: string; content?: unknown } };
    const rows = readFileSync(file, 'utf-8').trimEnd().split('\n').map((line) => JSON.parse(line) as Row);
    const system = rows.find((row) => row.message?.role === 'system');
    expect(system).toBeDefined();
    system!.message!.content = 'unapproved persisted role authority';
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const resumed = await fx.runtime.spawn('minion', { cwd: fx.workspace, agentId: 'unbound-prompt-minion', resumeFile: file });
    try {
      await expect(resumed.promptWithVerdict!('approved directive', { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } }))
        .rejects.toThrow('native directive transcript prompt differs from the prompt its authority manifest bound');
      // Refused ahead of the receipt: the unapproved text never reaches the model.
      expect(fx.script.calls.map((call) => call.prompt)).toEqual(['ordinary work']);
      expect(existsSync(join(fx.workspace, 'unbound-prompt.txt'))).toBe(false);
      expect(readFileSync(file, 'utf-8')).not.toContain('approved directive');
    } finally {
      await resumed.dispose();
      await fx.runtime.dispose();
      fx.store.dispose();
    }
  });

  it('the effective prompt is the replay\'s parts in any order, and a mismatch costs no search however many parts repeat (#521)', () => {
    expect(rendersAs('', [])).toBe(true);
    expect(rendersAs('one\n\ntwo\n\nthree', ['three', 'one', 'two'])).toBe(true);
    expect(rendersAs('one\n\ntwo', ['one', 'two', 'two'])).toBe(false);
    expect(rendersAs('one\n\ntwo', ['one', 'three'])).toBe(false);
    expect(rendersAs('one two', ['one', 'two'])).toBe(false);
    expect(rendersAs('one\n\ntwo\n\nextra', ['one', 'two'])).toBe(false);
    // 60 equal sections that are not the text: every order was once tried.
    const repeated = Array.from({ length: 60 }, () => 'section');
    const started = Date.now();
    expect(rendersAs([...repeated.slice(1), 'other'].join('\n\n'), repeated)).toBe(false);
    expect(rendersAs(repeated.join('\n\n'), repeated)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a session keeps the pre-1.x request pattern: prompt-cache warming is off unless the user\'s own Pi settings name a mode (#521)', async () => {
    const fx = await fixture([{ deltas: ['one'] }, { deltas: ['two'] }]);
    const mode = async (spawn: () => Promise<AgentHandle>) => {
      const handle = await spawn();
      try { return (await actualDirectiveSdkSession(handle)).settingsManager.getCacheWarmingMode(); } finally { await handle.dispose(); }
    };
    expect(await mode(() => fx.runtime.spawn('minion', { cwd: fx.workspace }))).toBe('off');
    const review = await fx.runtime.spawn('perkins', { isolatedReview: { systemPrompt: 'isolated policy', tools: [] } });
    try {
      expect((twinGate.lastOptions as { settingsManager: { getCacheWarmingMode(): string } }).settingsManager.getCacheWarmingMode()).toBe('off');
    } finally { await review.dispose(); }
    const settings = join(fx.agentDir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf-8')) as object : {}), cacheWarming: 'streaming' }));
    expect(await mode(() => fx.runtime.spawn('minion', { cwd: fx.workspace }))).toBe('streaming');
    expect(JSON.parse(readFileSync(settings, 'utf-8'))).toMatchObject({ cacheWarming: 'streaming' });
  });

  it('a system patch the SDK adds while preparing a directive\'s next turn is refused before that model request (#521)', async () => {
    const fx = await fixture([
      { deltas: [], toolCall: { id: 'patched-call', name: 'bash', args: { command: "printf 'ran\\n' > patched-first.txt" } } },
      { deltas: ['unreachable'] },
    ]);
    const identity = { requestId: 'next-turn-patch', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'next-turn-patch-job', workRevision: 0, authorityEpoch: 0 };
    const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace, agentId: 'next-turn-patch-minion' });
    const session = await actualDirectiveSdkSession(handle);
    // The SDK computes a prompt patch from the session's options before every
    // turn; once the first tool result is in, it owes one the approved prompt
    // never carried.
    const sdk = session as unknown as { _preparePromptAndToolLoadout: (...args: unknown[]) => unknown };
    const prepare = sdk._preparePromptAndToolLoadout.bind(session);
    let patching = false;
    sdk._preparePromptAndToolLoadout = (...args) => patching
      ? { role: 'system', content: '', sections: { rules: 'unapproved next-turn section' }, timestamp: Date.now() }
      : prepare(...args);
    session.subscribe((event) => { if (event.type === 'message_end' && event.message.role === 'toolResult') patching = true; });
    try {
      const verdict = await handle.promptWithVerdict!('approved directive', { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } });
      expect(verdict).toMatchObject({ ok: false, error: expect.stringContaining('effective native model/role/tools authority changed during next-turn preparation') });
      expect(readFileSync(join(fx.workspace, 'patched-first.txt'), 'utf-8')).toBe('ran\n');
      expect(fx.script.calls).toHaveLength(1);
    } finally {
      await handle.dispose();
      await fx.runtime.dispose();
      fx.store.dispose();
    }
  });

  it('a pi directive refuses prompt images by name: pi 1.x re-encodes them, so the receipt could not match (#521)', async () => {
    const { readDirectiveBinding } = await import('../src/runtime/directive-checkpoint.js');
    const fx = await fixture([{ deltas: ['unused'] }], ['text', 'image']);
    const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
    const identity = { requestId: 'directive-image', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'directive-image-job', workRevision: 0, authorityEpoch: 0 };
    try {
      await expect(handle.prompt('with an image', {
        directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} },
        images: [{ mediaType: 'image/png', data: PNG_1X1_BASE64 }],
      })).rejects.toThrow('a pi directive carries text only');
      expect(fx.script.calls).toHaveLength(0);
      expect(readDirectiveBinding(handle.sessionFile!, identity.requestId)).toBeNull();
    } finally {
      await handle.dispose();
      await fx.runtime.dispose();
      fx.store.dispose();
    }
  });

  it('a steer an extension input handler consumed is logged, not silently accepted (#521)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    const logs: string[] = [];
    const fx = await fixture([{ deltas: ['a'], hold }], ['text'], { log: (level, msg) => { logs.push(`${level}:${msg}`); } });
    const handle = await fx.runtime.spawn('gru');
    const session = await actualDirectiveSdkSession(handle);
    vi.spyOn(session, 'steer').mockResolvedValue('handled');
    try {
      const turn = handle.prompt('mine', { owner: 'alice' });
      await waitFor(() => fx.script.calls.length === 1, 'the live turn');
      await handle.steer('adjust', { owner: 'alice' });
      expect(logs).toContain('warn:a pi extension input handler consumed the steer; nothing was queued');
      release();
      await turn;
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('a follow-up an extension input handler consumed is logged, not silently accepted (#521)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    const logs: string[] = [];
    const fx = await fixture([{ deltas: ['a'], hold }], ['text'], { log: (level, msg) => { logs.push(`${level}:${msg}`); } });
    const handle = await fx.runtime.spawn('gru');
    const session = await actualDirectiveSdkSession(handle);
    vi.spyOn(session, 'followUp').mockResolvedValue('handled');
    try {
      const turn = handle.prompt('mine', { owner: 'alice' });
      await waitFor(() => fx.script.calls.length === 1, 'the live turn');
      await handle.followUp('and then', { owner: 'alice' });
      expect(logs).toContain('warn:a pi extension input handler consumed the follow-up; nothing was queued');
      release();
      await turn;
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('fails loud on an unknown model reference #contract:model-resolution:pi', async () => {
    const fx = await fixture([], ['text'], {
      configExtra: '[runtimes.pi]\nmodel_refresh = false\n',
    });
    await expect(fx.runtime.spawn('gru', { model: 'nope/no-such-model' })).rejects.toThrow(
      /unknown model "nope\/no-such-model"/,
    );
  });

  it('preflight and spawn share a single bounded live-catalog refresh for concurrent misses', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let calls = 0;
    let visible = false;
    const fx = await fixture([], ['text'], {
      modelCatalogRefresh: async (_runtime, request) => {
        calls += 1;
        expect(request).toEqual({ provider: 'gru-stub', timeoutMs: 10_000 });
        await gate;
        visible = true;
        return { attempted: true, detail: 'completed' };
      },
    });
    const original = fx.modelRuntime.getModel.bind(fx.modelRuntime);
    let misses = 0;
    let allMissed!: () => void;
    const missGate = new Promise<void>((resolveGate) => { allMissed = resolveGate; });
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
      if (visible) return original(provider, id);
      misses += 1;
      if (misses === 3) allMissed();
      return undefined;
    });
    const a = fx.runtime.checkReviewModel('perkins');
    const b = fx.runtime.checkReviewModel('perkins');
    const spawned = fx.runtime.spawn('perkins');
    await missGate;
    await vi.waitFor(() => expect(calls).toBe(1));
    release();
    const handle = await spawned;
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
    expect(calls).toBe(1);
    await handle.dispose();
  });

  it('shares cold catalog initialization across probes and retries a rejected initialization', async () => {
    const fx = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const create = vi.spyOn(ModelRuntime, 'create');
    let attempts = 0;
    create.mockImplementation(async () => {
      attempts += 1;
      await gate;
      if (attempts === 1) throw new Error('cold catalog unavailable');
      return fx.modelRuntime;
    });
    const runtime = new PiRuntime({ config: fx.config, store: fx.store, agentDir: fx.agentDir });
    try {
      const a = runtime.checkReviewModel('perkins');
      const b = runtime.checkReviewModel('perkins');
      const spawn = runtime.spawn('perkins');
      await vi.waitFor(() => expect(attempts).toBe(1));
      release();
      await expect(Promise.allSettled([a, b, spawn])).resolves.toEqual([
        expect.objectContaining({ status: 'rejected' }),
        expect.objectContaining({ status: 'rejected' }),
        expect.objectContaining({ status: 'rejected' }),
      ]);
      await expect(runtime.checkReviewModel('perkins')).resolves.toBeUndefined();
      const handle = await runtime.spawn('perkins');
      await handle.dispose();
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      create.mockRestore();
      await runtime.dispose();
    }
  });

  it('does not share a provider-scoped refresh with another provider while preflight and spawn overlap', async () => {
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolveGate) => { releaseA = resolveGate; });
    const refreshed = new Set<string>();
    const calls: string[] = [];
    const fx = await fixture([], ['text'], {
      configExtra: '[models.roles]\nperkins = "gru-stub/live-A"\ngru = "other/live-B"\n',
      modelCatalogRefresh: async (_runtime, request) => {
        calls.push(request.provider);
        if (request.provider === 'gru-stub') await aGate;
        refreshed.add(request.provider);
        return { attempted: true, detail: 'completed' };
      },
    });
    const originalProvider = fx.modelRuntime.getProvider('gru-stub')!;
    const originalModel = fx.modelRuntime.getModel('gru-stub', 'stub-model')!;
    fx.modelRuntime.registerNativeProvider({
      ...originalProvider, id: 'other',
      getModels: () => [{ ...originalModel, provider: 'other', id: 'live-B' }],
    });
    await fx.modelRuntime.refresh({ allowNetwork: false, providers: ['other'] });
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) =>
      refreshed.has(provider) ? { ...originalModel, provider, id } : undefined);
    const a = fx.runtime.checkReviewModel('perkins');
    await vi.waitFor(() => expect(calls).toEqual(['gru-stub']));
    const b = fx.runtime.checkReviewModel('gru');
    const anotherB = fx.runtime.spawn('gru');
    await new Promise<void>((resolveGate) => setImmediate(resolveGate));
    expect(calls).toEqual(['gru-stub']);
    releaseA();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    const handle = await anotherB;
    await handle.dispose();
    expect(calls).toEqual(['gru-stub', 'other']);
  });

  it('preflight fails on real miss, offline mode and refresh failure, never substitutes a model', async () => {
    for (const [policy, detail] of [
      ['', 'failed (network unavailable)'],
      ['[runtimes.pi]\nmodel_refresh = false\n', 'skipped ([runtimes.pi] model_refresh = false)'],
    ]) {
      const fx = await fixture([], ['text'], {
        configExtra: `${policy}\n[models.roles]\nperkins = "gru-stub/no-such-id"\n`,
        modelCatalogRefresh: async () => ({ attempted: true, detail: 'failed (network unavailable)' }),
      });
      await expect(fx.runtime.checkReviewModel('perkins')).rejects.toThrow(detail);
      await expect(fx.runtime.spawn('perkins')).rejects.toThrow(detail);
    }
  });

  it('pins the Pi preflight provider/model on isolated lead and child spawns and refuses a changed settings default', async () => {
    const fx = await fixture([], ['text'], { configExtra: '[models.roles]\nperkins = "default"\n[runtimes.pi.roles.perkins]\nthinking_level = "high"\n' });
    const settings = join(fx.agentDir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' }));
    const registry = new RuntimeRegistry({ config: fx.config, store: fx.store,
      pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime } });
    const proof = await registry.prepareReviewModel('perkins');
    expect(registry.reviewThinkingLevel('perkins')).toBe('high');
    expect(proof).toMatchObject({ role: 'perkins', modelRef: 'gru-stub/stub-model', settings: {}, authEnv: {} });
    expect(proof?.routingSha256).toMatch(/^[a-f0-9]{64}$/u);
    const generation = randomUUID();
    const lead = await registry.spawn('perkins', {
      reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] }, reviewModel: proof,
      reviewOwnerGeneration: generation,
    });
    const owner = { roundId: 'test-round', runtimeId: 'pi', pid: process.pid, generation };
    expect(registry.reviewOwnerCeased(lead.id, owner)).toBe(false);
    expect((twinGate.lastOptions as { model?: { provider: string; id: string } }).model)
      .toMatchObject({ provider: 'gru-stub', id: 'stub-model' });
    expect((twinGate.lastOptions as { thinkingLevel?: string }).thinkingLevel).toBe('high');
    await lead.dispose();
    expect(registry.reviewOwnerCeased(lead.id, owner)).toBe(true);
    expect(registry.reviewOwnerCeased(lead.id, { ...owner, generation: randomUUID() })).toBe(false);
    const child = await registry.spawn('perkins', {
      isolatedReview: { systemPrompt: 'lens', tools: [] }, reviewModel: proof,
    });
    expect((twinGate.lastOptions as { model?: { provider: string; id: string } }).model)
      .toMatchObject({ provider: 'gru-stub', id: 'stub-model' });
    expect((twinGate.lastOptions as { thinkingLevel?: string }).thinkingLevel).toBe('high');
    await child.dispose();
    const getModel = fx.modelRuntime.getModel.bind(fx.modelRuntime);
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) =>
      id === 'alternate-model' ? { ...getModel(provider, 'stub-model')!, id } : getModel(provider, id));
    writeFileSync(settings, JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'alternate-model' }));
    for (const reviewMode of [
      { reviewLead: { systemPrompt: 'lead', tools: [] as const, nativeTools: [] } },
      { isolatedReview: { systemPrompt: 'lens', tools: [] as const } },
    ]) {
      await expect(registry.spawn('perkins', { ...reviewMode, reviewModel: proof }))
        .rejects.toThrow('Pi review model changed since preflight');
    }
    writeFileSync(settings, JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' }));
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
      const selected = getModel(provider, id);
      return selected === undefined ? undefined : { ...selected, baseUrl: 'https://alternate.example.invalid/v2' };
    });
    await expect(registry.spawn('perkins', {
      reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] }, reviewModel: proof,
    })).rejects.toThrow('Pi review model changed since preflight');
    const changedRoute = await registry.prepareReviewModel('perkins');
    expect(changedRoute?.modelRef).toBe(proof?.modelRef);
    expect(changedRoute?.routingSha256).toBeUndefined();
    for (const changes of [
      { maxTokens: 2_048 }, { contextWindow: 50_000 }, { input: ['text', 'image'] as ('text' | 'image')[] },
    ]) {
      vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
        const selected = getModel(provider, id);
        return selected === undefined ? undefined : { ...selected, ...changes };
      });
      const changedModel = await registry.prepareReviewModel('perkins');
      expect(changedModel?.modelRef).toBe(proof?.modelRef);
      expect(changedModel?.routingSha256).not.toBe(proof?.routingSha256);
      await expect(registry.spawn('perkins', {
        reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] }, reviewModel: proof,
      })).rejects.toThrow('Pi review model changed since preflight');
    }
    for (const baseUrl of ['https://user:secret@example.invalid/v2',
      'https://api.openai.com/v1/secret-in-path', 'https://secret-in-host.example.invalid/v1']) {
      vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
        const selected = getModel(provider, id);
        return selected === undefined ? undefined : { ...selected, baseUrl };
      });
      const unknownRoute = await registry.prepareReviewModel('perkins');
      expect(unknownRoute?.routingSha256).toBeUndefined();
      vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
        const selected = getModel(provider, id);
        return selected === undefined ? undefined : { ...selected, baseUrl: `${baseUrl}/changed` };
      });
      await expect(registry.spawn('perkins', {
        reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] }, reviewModel: unknownRoute,
      })).rejects.toThrow('Pi review model changed since preflight');
    }
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
      const selected = getModel(provider, id);
      return selected === undefined ? undefined : { ...selected, api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com', compat: { supportsStrictTools: true,
          allowedFallbackModels: [{ provider: 'anthropic', model: 'claude-opus-5',
            cost: { input: 5, output: 25, cacheRead: 1, cacheWrite: 2 } }] } };
    });
    const compatible = await registry.prepareReviewModel('perkins');
    expect(compatible?.routingSha256).toMatch(/^[a-f0-9]{64}$/u);
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
      const selected = getModel(provider, id);
      return selected === undefined ? undefined : { ...selected, api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com', name: 'credential-looking-display-name',
        compat: { supportsStrictTools: true, allowedFallbackModels: [{ provider: 'anthropic', model: 'claude-opus-5',
          cost: { input: 5, output: 25, cacheRead: 1, cacheWrite: 2 } }] } };
    });
    expect((await registry.prepareReviewModel('perkins'))?.routingSha256).toBe(compatible?.routingSha256);
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
      const selected = getModel(provider, id);
      return selected === undefined ? undefined : { ...selected, api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com', compat: { supportsStrictTools: false,
          allowedFallbackModels: [{ provider: 'anthropic', model: 'claude-opus-5',
            cost: { input: 5, output: 25, cacheRead: 1, cacheWrite: 2 } }] } };
    });
    expect((await registry.prepareReviewModel('perkins'))?.routingSha256).not.toBe(compatible?.routingSha256);
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
      const selected = getModel(provider, id);
      return selected === undefined ? undefined : { ...selected, api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        compat: { secretOverride: 'sensitive' } as unknown as NonNullable<typeof selected>['compat'] };
    });
    expect((await registry.prepareReviewModel('perkins'))?.routingSha256).toBeUndefined();
    // Fallback model ids are judged by SHAPE, never a published-name list
    // (owner ruling 2026-10-15): a current model the old list lacked is reusable...
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
      const selected = getModel(provider, id);
      return selected === undefined ? undefined : { ...selected, api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com', compat: { supportsStrictTools: true,
          allowedFallbackModels: [{ provider: 'anthropic', model: 'claude-opus-5-5',
            cost: { input: 5, output: 25, cacheRead: 1, cacheWrite: 2 } }] } };
    });
    expect((await registry.prepareReviewModel('perkins'))?.routingSha256).toMatch(/^[a-f0-9]{64}$/u);
    // ...while credential-shaped (mixed-case key) material never is.
    for (const change of [
      { provider: 'credential-looking-provider' },
      { id: 'credential-looking-model' },
      { api: 'credential-looking-api' },
      { thinkingLevelMap: { high: 'credential-looking-thinking' } },
      { thinkingLevelMap: { 'credential-looking-key': 'high' } },
      { compat: { allowedFallbackModels: [{ provider: 'anthropic', model: 'sk-ant-api03-Xy7Qk9LmN2pR4tVb8wZ1',
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }] } },
    ]) {
      vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
        const selected = getModel(provider, id);
        return selected === undefined ? undefined : { ...selected, api: 'anthropic-messages',
          baseUrl: 'https://api.anthropic.com', ...change };
      });
      if ('provider' in change) {
        await expect(registry.prepareReviewModel('perkins')).rejects.toThrow('not authenticated');
      } else {
        expect((await registry.prepareReviewModel('perkins'))?.routingSha256).toBeUndefined();
      }
    }
  });

  it('a restarted registry accepts a pi review owner its host saw cease, even while that host pid still looks alive #contract:review-owner-durable-cessation:pi', async () => {
    const fx = await fixture([], ['text'], { configExtra: '[models.roles]\nperkins = "default"\n' });
    writeFileSync(join(fx.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' }));
    const { LedgerApi } = await import('../src/ledger/api.js');
    const { LedgerDb } = await import('../src/ledger/db.js');
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'gru-pi-owner-cessation-db-')));
    try {
      const ledger = new LedgerApi(db.handle);
      ledger.addJob({ id: 'job-pi-owner', repo: 'fixture', title: 'pi owner', baseBranch: 'main', briefing: 'review' });
      const round = ledger.addRound({ jobId: 'job-pi-owner', targetRef: 'a'.repeat(40), lenses: ['blind'] });
      // The owner marker names another host pid, as a restart finds it.
      const marker = { roundId: round.id, runtimeId: 'pi', pid: process.ppid, generation: randomUUID() };
      ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: 'job-pi-owner', roundId: round.id,
        payload: { ...marker, targetSha: 'a'.repeat(40) } });
      const cessation = ledgerReviewOwnerCessation(() => ledger);
      const owner = new RuntimeRegistry({ config: fx.config, store: fx.store,
        pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime }, reviewOwnerCessation: cessation });
      const lead = await owner.spawn('perkins', {
        reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] },
        reviewModel: await owner.prepareReviewModel('perkins'), reviewOwnerGeneration: marker.generation,
      });
      await lead.dispose();
      expect(ledger.latestRoundEvent(round.id, 'round.review-owner-ceased')?.payload)
        .toMatchObject({ source: 'adapter', agentId: lead.id, generation: marker.generation });
      // A live (or reused) host pid cannot answer; only the durable record can.
      const restarted = new RuntimeRegistry({ config: fx.config, store: fx.store, reviewOwnerCessation: cessation,
        ownerProcessProbe: () => 'alive' });
      expect(restarted.reviewOwnerCeased(lead.id, marker)).toBe(true);
      expect(restarted.reviewOwnerCeased(lead.id, { ...marker, generation: randomUUID() })).toBe(false);
      expect(new RuntimeRegistry({ config: fx.config, store: fx.store, ownerProcessProbe: () => 'alive' })
        .reviewOwnerCeased(lead.id, marker)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('registry preflight selects the perkins role model and the same cached adapter used by spawn', async () => {
    const fx = await fixture([], ['text'], { configExtra: '[models.roles]\nperkins = "gru-stub/custom/group-model"\n' });
    const original = fx.modelRuntime.getModel.bind(fx.modelRuntime);
    vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation((provider, id) => {
      if (provider === 'gru-stub' && id === 'custom/group-model') {
        return { ...original('gru-stub', 'stub-model')!, id };
      }
      return original(provider, id);
    });
    const registry = new RuntimeRegistry({
      config: fx.config, store: fx.store,
      pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
    });
    await expect(registry.checkReviewModel('perkins')).resolves.toBeUndefined();
    const handle = await registry.spawn('perkins');
    await handle.dispose();
    expect(registry.runtimeIdFor('perkins')).toBe('pi');
    await expect(registry.checkReviewModel('gru')).resolves.toBeUndefined();
  });

  it('preflight checks the resolved model provider auth, including settings defaults', async () => {
    const fx = await fixture([], ['text'], { configExtra: '[models.roles]\nperkins = "default"\n' });
    writeFileSync(join(fx.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' }));
    await expect(fx.runtime.checkReviewModel('perkins')).resolves.toBeUndefined();
    const auth = vi.spyOn(fx.modelRuntime, 'checkAuth').mockResolvedValue(undefined);
    await expect(fx.runtime.checkReviewModel('perkins')).rejects.toThrow('not authenticated: gru-stub');
    expect(auth).toHaveBeenCalledWith('gru-stub');
    auth.mockRestore();
    await expect(fx.runtime.spawn('perkins', { model: 'default' }).then(async (handle) => handle.dispose())).resolves.toBeUndefined();
  });

  it('an anthropic review model on api.anthropic.com is reusable by id SHAPE — never credential-shaped ids', async () => {
    const fx = await fixture([], ['text'], { configExtra: '[models.roles]\nperkins = "default"\n' });
    writeFileSync(join(fx.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' }));
    const getModel = fx.modelRuntime.getModel.bind(fx.modelRuntime);
    const checkAuth = fx.modelRuntime.checkAuth.bind(fx.modelRuntime);
    vi.spyOn(fx.modelRuntime, 'checkAuth').mockImplementation(() => checkAuth('gru-stub'));
    const routingFor = async (id: string) => {
      vi.spyOn(fx.modelRuntime, 'getModel').mockImplementation(() => ({ ...getModel('gru-stub', 'stub-model')!,
        provider: 'anthropic', id, api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }));
      const snapshot = await fx.runtime.prepareReviewModel('perkins');
      expect(snapshot.modelRef).toBe(`anthropic/${id}`);
      return snapshot.routingSha256;
    };
    // A current model no published-name list carried is reusable...
    expect(await routingFor('claude-opus-5-5')).toMatch(/^[a-f0-9]{64}$/u);
    // ...credential-shaped ids never are (mixed case; a long lowercase run).
    expect(await routingFor('sk-ant-api03-Xy7Qk9LmN2pR4tVb8wZ1')).toBeUndefined();
    expect(await routingFor('claude-9f86d081884c7d659a2feaa0c55ad015')).toBeUndefined();
  });

  it('resolves a live-catalog model through ONE bounded refresh (deepseek-flash shape)', async () => {
    // Reproduces the owner report: the offline catalog misses the model
    // (`getModel` returns undefined) while the live catalog has it. The
    // adapter must refresh once, re-resolve, and spawn — without ever
    // putting the network on the healthy-spawn path.
    const refresher = vi.fn(async () => ({
      attempted: true,
      detail: 'completed within the 10000 ms budget',
    }));
    const fx = await fixture([{ deltas: ['live catalog model'] }], ['text'], {
      modelCatalogRefresh: refresher,
    });
    const original = fx.modelRuntime.getModel.bind(fx.modelRuntime);
    const getModel = vi
      .spyOn(fx.modelRuntime, 'getModel')
      .mockImplementationOnce(() => undefined)
      .mockImplementation((provider, modelId) => original(provider, modelId));
    try {
      const handle = await fx.runtime.spawn('gru', { model: 'gru-stub/stub-model' });
      try {
        const events = collect(handle);
        await handle.prompt('live check', { owner: 'alice' });
        expect(
          events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta),
        ).toEqual(['live catalog model']);
      } finally {
        await handle.dispose();
      }
      expect(refresher).toHaveBeenCalledTimes(1);
      expect(refresher).toHaveBeenCalledWith(fx.modelRuntime, {
        provider: 'gru-stub',
        timeoutMs: 10_000,
      });
    } finally {
      getModel.mockRestore();
    }
  });

  it('healthy resolutions never touch the catalog refresh path (no added latency)', async () => {
    const refresher = vi.fn(async () => ({ attempted: true, detail: 'must not run' }));
    const fx = await fixture([{ deltas: ['ok'] }], ['text'], { modelCatalogRefresh: refresher });
    const handle = await fx.runtime.spawn('gru');
    await handle.dispose();
    expect(refresher).not.toHaveBeenCalled();
  });

  it('unknown-model errors name the model, the refresh outcome, and the near matches', async () => {
    const refresher = vi.fn(async () => ({
      attempted: true,
      detail: 'completed within the 10000 ms budget',
    }));
    const fx = await fixture([], ['text'], { modelCatalogRefresh: refresher });
    const error = await rejection(
      fx.runtime.spawn('gru', { model: 'gru-stub/no-such-model' }),
    );
    expect(error.message).toContain('unknown model "gru-stub/no-such-model"');
    expect(error.message).toContain(
      'catalog refresh attempted — completed within the 10000 ms budget',
    );
    expect(error.message).toContain('nearest registered models for "gru-stub": stub-model');
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it('reports a skipped refresh when [runtimes.pi] model_refresh = false', async () => {
    const refresher = vi.fn(async () => {
      throw new Error('must not run');
    });
    const fx = await fixture([], ['text'], {
      modelCatalogRefresh: refresher,
      configExtra: '[runtimes.pi]\nmodel_refresh = false\n',
    });
    const error = await rejection(fx.runtime.spawn('gru', { model: 'nope/whatever' }));
    expect(error.message).toContain('unknown model "nope/whatever"');
    expect(error.message).toContain('catalog refresh skipped ([runtimes.pi] model_refresh = false)');
    expect(error.message).toContain('provider "nope" is not registered');
    expect(refresher).not.toHaveBeenCalled();
  });

  it('bounds the network refresh with model_refresh_timeout_ms', async () => {
    const fx = await fixture([], ['text'], {
      configExtra: '[runtimes.pi]\nmodel_refresh_timeout_ms = 25\n',
    });
    const refresh = vi.spyOn(fx.modelRuntime, 'refresh').mockImplementation(
      (options) =>
        new Promise((resolve) => {
          const signal = options?.signal;
          const settle = (): void => resolve({ aborted: true, errors: new Map<string, Error>() });
          if (signal?.aborted === true) settle();
          else signal?.addEventListener('abort', settle);
        }),
    );
    try {
      const startedAt = Date.now();
      const error = await rejection(fx.runtime.spawn('gru', { model: 'gru-stub/live-only' }));
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(error.message).toContain('timed out after 25 ms');
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith(
        expect.objectContaining({ allowNetwork: true, providers: ['gru-stub'] }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('accepts an explicit thinking level and fails loud on an invalid one (ruling 16)', async () => {
    const fx = await fixture([{ deltas: ['ok'] }]);
    const handle = await fx.runtime.spawn('gru', { thinkingLevel: 'high' });
    await handle.dispose();
    await expect(fx.runtime.spawn('gru', { thinkingLevel: 'banana' })).rejects.toThrow(
      /unknown thinking level "banana" for pi/,
    );
  });

  it('the "default" model sentinel passes through to the runtime harness', async () => {
    // No [models] default configured: policy resolves to "default", which
    // means "whatever pi itself would pick". pi's own resolution reads the
    // settings default — so we point the harness default at the stub
    // provider and prove the full passthrough path end-to-end.
    const fx = await fixture([{ deltas: ['passthrough'] }]);
    writeFileSync(
      join(fx.agentDir, 'settings.json'),
      `${JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' })}\n`,
      'utf-8',
    );
    const handle = await fx.runtime.spawn('gru', { model: 'default' });
    try {
      const events = collect(handle);
      await handle.prompt('sentinel check', { owner: 'alice' });
      expect(
        events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta),
      ).toEqual(['passthrough']);
    } finally {
      await handle.dispose();
    }
  });

  it('preflight rejects the pi default when neither config nor settings select a model', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
    cleanupDirs.push(home, workspace, agentDir);
    writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const runtime = new PiRuntime({
      config,
      store: new SessionStore(config.dataDir),
      agentDir,
      modelRuntime: await makeIsolatedModelRuntime(),
    });
    await expect(runtime.checkReviewModel('perkins')).rejects.toThrow(
      /no selected pi default model; configure a settings default or \[models\] default for review/,
    );
  });

  it('the sentinel path fails LOUD when nothing is configured (no silent fallback)', async () => {
    // Stub-FREE isolated runtime: no provider is configured at all, so the
    // "default" sentinel resolves to nothing and prompt fails loudly
    // instead of silently rerouting to some other model.
    const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
    cleanupDirs.push(home, workspace, agentDir);
    writeFileSync(
      configPathFor(home),
      `workspace_root = "${workspace}"\n`,
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const runtime = new PiRuntime({
      config,
      store,
      agentDir,
      modelRuntime: await makeIsolatedModelRuntime(),
    });
    const handle = await runtime.spawn('gru', { model: 'default' });
    await expect(handle.prompt('anyone there?', { owner: 'alice' })).rejects.toThrow(
      /No API key found for the selected model|no models available/i,
    );
    await handle.dispose();
  });

  it('resolves the settings default eagerly when the auth snapshot is stale (2026-09-20 probe shape)', async () => {
    // User report: chat + Bob consolidation died with "No API key found for
    // the selected model" although the user's settings and auth were valid.
    // The shared offline ModelRuntime (refreshOnCreate: false) never builds
    // its auth snapshot, so pi's own settings-default path — gated on
    // hasConfiguredAuth() — rejected the user's configured default and fell
    // through to "first available"/nothing. The adapter must resolve the
    // settings default ITSELF and pass the explicit model. Hermetic repro:
    // stub runtime with a COLD auth cache — hasConfiguredAuth() is false
    // for every provider, exactly like the user's runtime; prompting an
    // explicitly-passed model still works (probe P2).
    const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
    cleanupDirs.push(home, workspace, agentDir);
    // No [models] section: the product path resolves the "default" sentinel.
    writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
    writeFileSync(
      join(agentDir, 'settings.json'),
      `${JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' })}\n`,
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const staleModelRuntime = await makeStubModelRuntime(new StubScript([{ deltas: ['settings default'] }]), {
      refreshAuthCache: false,
    });
    const runtime = new PiRuntime({
      config,
      store,
      agentDir,
      modelRuntime: staleModelRuntime,
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
    });
    // Cold-cache PRECONDITION (Perkins r1 W6): the regression guard is only
    // meaningful while pi's own auth-gated path would reject this default.
    // If an SDK timing change ever warms the cache, fail here, loudly,
    // instead of silently defanging the test.
    expect(staleModelRuntime.hasConfiguredAuth('gru-stub')).toBe(false);
    const handle = await runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('sentinel check', { owner: 'alice' });
      expect(
        events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta),
      ).toEqual(['settings default']);
      // Spawn logs the RESOLVED model so future complaints name the model.
      const spawnLog = logs.find((l) => l.msg.includes('model resolved'));
      expect(spawnLog).toBeDefined();
      expect(spawnLog?.level).toBe('info');
      expect(spawnLog?.fields?.['model']).toBe('gru-stub/stub-model');
    } finally {
      await handle.dispose();
    }
  });

  it('fails loud when the settings default names an unregistered model', async () => {
    // A settings default that misses the catalog must never silently
    // reroute to "first available" (the 2026-09-20 bug shape); it names
    // the stale reference like the explicit path does — plus the refresh
    // outcome and the nearest registered alternatives.
    const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
    cleanupDirs.push(home, workspace, agentDir);
    writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
    writeFileSync(
      join(agentDir, 'settings.json'),
      `${JSON.stringify({ defaultProvider: 'nope', defaultModel: 'no-such-model' })}\n`,
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const runtime = new PiRuntime({
      config,
      store,
      agentDir,
      modelRuntime: await makeStubModelRuntime(new StubScript([]), { refreshAuthCache: false }),
      modelCatalogRefresh: async () => ({
        attempted: true,
        detail: 'failed (no network in tests)',
      }),
    });
    const error = await rejection(runtime.spawn('gru'));
    expect(error.message).toContain('settings default "nope/no-such-model" is not a registered model');
    expect(error.message).toContain('catalog refresh attempted — failed (no network in tests)');
    expect(error.message).toContain('provider "nope" is not registered');
    expect(error.message).toContain(join(agentDir, 'settings.json'));
  });

  describe('settings default sentinel resolution (Perkins r1 follow-ups, issue #24)', () => {
    interface SentinelFx {
      readonly runtime: PiRuntime;
      readonly home: string;
      readonly workspace: string;
      readonly agentDir: string;
      readonly logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
    }

    async function sentinelFx(
      globalSettings: string | Buffer | undefined,
      projectSettings?: string,
    ): Promise<SentinelFx> {
      const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
      const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
      cleanupDirs.push(home, workspace, agentDir);
      writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
      if (globalSettings !== undefined) writeFileSync(join(agentDir, 'settings.json'), globalSettings);
      if (projectSettings !== undefined) {
        mkdirSync(join(workspace, '.pi'), { recursive: true });
        writeFileSync(join(workspace, '.pi', 'settings.json'), projectSettings, 'utf-8');
      }
      const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
      const logs: SentinelFx['logs'] = [];
      const runtime = new PiRuntime({
        config,
        store: new SessionStore(config.dataDir),
        agentDir,
        modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['ok'] }]), {
          refreshAuthCache: false,
        }),
        log: (level, msg, fields) => logs.push({ level, msg, fields }),
      });
      return { runtime, home, workspace, agentDir, logs };
    }

    const stubDefault = JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' });
    const resolvedModel = (fx: SentinelFx): unknown =>
      fx.logs.find((l) => l.msg === 'spawn: model resolved')?.fields?.['model'];

    it('throws naming the file when settings.json is corrupt (W2), not the cryptic No API key', async () => {
      const fx = await sentinelFx('{ "defaultProvider": "gru-stub", oops');
      const error = await rejection(fx.runtime.spawn('gru'));
      expect(error.message).toContain(join(fx.agentDir, 'settings.json'));
      expect(error.message).toMatch(/unreadable or corrupt/);
      expect(error.message).not.toMatch(/No API key/);
    });

    it('treats an ABSENT settings.json as naming nothing and logs the undefined-model branch honestly (W2/N3/N4)', async () => {
      const fx = await sentinelFx(undefined);
      const handle = await fx.runtime.spawn('gru');
      await handle.dispose();
      expect(resolvedModel(fx)).toBe('pi default resolution (no settings default named)');
    });

    it('tolerates a UTF-8 BOM (N2)', async () => {
      const fx = await sentinelFx(`\uFEFF${stubDefault}`);
      const handle = await fx.runtime.spawn('gru');
      await handle.dispose();
      expect(resolvedModel(fx)).toBe('gru-stub/stub-model');
    });

    it('a partial default (provider only, or model only) names nothing (W5)', async () => {
      for (const partial of [
        JSON.stringify({ defaultProvider: 'gru-stub' }),
        JSON.stringify({ defaultModel: 'stub-model' }),
      ]) {
        const fx = await sentinelFx(partial);
        const handle = await fx.runtime.spawn('gru');
        await handle.dispose();
        expect(resolvedModel(fx)).toBe('pi default resolution (no settings default named)');
      }
    });

    it('empty or whitespace defaults name nothing instead of a confusing "/x" error (N1)', async () => {
      for (const body of [
        { defaultProvider: '', defaultModel: 'stub-model' },
        { defaultProvider: 'gru-stub', defaultModel: '   ' },
        { defaultProvider: null, defaultModel: null },
      ]) {
        const fx = await sentinelFx(JSON.stringify(body));
        const handle = await fx.runtime.spawn('gru');
        await handle.dispose();
        expect(resolvedModel(fx)).toBe('pi default resolution (no settings default named)');
      }
    });

    it('a non-string default throws naming the key (N2)', async () => {
      const fx = await sentinelFx(JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 42 }));
      const error = await rejection(fx.runtime.spawn('gru'));
      expect(error.message).toContain('defaultModel must be a string, got number');
      expect(error.message).toContain(join(fx.agentDir, 'settings.json'));
    });

    it('honours a project-scope .pi/settings.json default, which wins over global (W4)', async () => {
      const onlyProject = await sentinelFx(undefined, stubDefault);
      const a = await onlyProject.runtime.spawn('gru');
      await a.dispose();
      expect(resolvedModel(onlyProject)).toBe('gru-stub/stub-model');

      const both = await sentinelFx(
        JSON.stringify({ defaultProvider: 'nope', defaultModel: 'no-such-model' }),
        stubDefault,
      );
      const b = await both.runtime.spawn('gru');
      await b.dispose();
      expect(resolvedModel(both)).toBe('gru-stub/stub-model');
    });

    it('a resumed session keeps its persisted model over the settings default (W1)', async () => {
      // Settings name an UNREGISTERED model: if the settings default were
      // eagerly resolved on resume the spawn would throw. Session restore
      // must outrank settings (pi's documented order).
      const fx = await fixture([{ deltas: ['first'] }, { deltas: ['second'] }]);
      const first = await fx.runtime.spawn('gru');
      await first.prompt('remember', { owner: 'alice' });
      const file = first.sessionFile!;
      await first.dispose();
      writeFileSync(
        join(fx.agentDir, 'settings.json'),
        JSON.stringify({ defaultProvider: 'nope', defaultModel: 'no-such-model' }),
        'utf-8',
      );
      const config = loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester');
      const logs: SentinelFx['logs'] = [];
      const second = new PiRuntime({
        config,
        store: new SessionStore(config.dataDir),
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['again'] }]), {
          refreshAuthCache: false,
        }),
        log: (level, msg, fields) => logs.push({ level, msg, fields }),
      });
      const resumed = await second.spawn('gru', { resumeFile: file, model: 'default' });
      try {
        expect(logs.find((l) => l.msg === 'spawn: model resolved')?.fields?.['model']).toBe(
          'gru-stub/stub-model',
        );
      } finally {
        await resumed.dispose();
      }
    });

    it('a resume with an unresolvable settings default and no persisted model still fails loud and is not marked down (W1)', async () => {
      const fx = await sentinelFx(JSON.stringify({ defaultProvider: 'nope', defaultModel: 'x' }));
      const store = new SessionStore(loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester').dataDir);
      const empty = join(store.sessionsDir, 'empty-resume.jsonl');
      mkdirSync(store.sessionsDir, { recursive: true });
      writeFileSync(empty, '', 'utf-8');
      const error = await rejection(fx.runtime.spawn('gru', { resumeFile: empty }));
      expect(error.message).toContain('settings default "nope/x" is not a registered model');
      expect(fx.runtime.health().state).toBe('ok');
    });
  });

  it('dispose releases the session lock #contract:dispose-releases-lock:pi', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('gru');
    const file = handle.sessionFile!;
    await handle.dispose();
    const fresh = new SessionStore(fx.store.dataDir);
    expect(() => fresh.acquireLock(file)).not.toThrow();
    fresh.releaseLock(file);
    expect(handle.health().state).toBe('disposed');
  });

  it('declares pi capabilities honestly in the matrix #contract:capabilities:pi', async () => {
    const fx = await fixture();
    expect(fx.runtime.capabilities).toEqual({
      streaming: true,
      steer: 'native',
      resume: 'file',
      images: true,
      thinking: true,
      thinkingLevelControl: true,
      followUp: true,
    });
    expect(fx.runtime.health()).toEqual({ state: 'ok' });
    // Model metadata cannot grant a modality the adapter transport lacks.
    expect(
      capabilitiesForModelInput({ ...fx.runtime.capabilities, images: false }, ['text', 'image']).images,
    ).toBe(false);
  });

  it('B1 fails-pre-fix discriminator: a text-only resolved model makes the spawned handle vision-incapable', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      expect(handle.capabilities.images).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it('B1 positive discriminator: an image-capable resolved model keeps vision enabled and transports images', async () => {
    const fx = await fixture([{ deltas: ['seen'] }], ['text', 'image']);
    const handle = await fx.runtime.spawn('gru');
    try {
      expect(handle.capabilities.images).toBe(true);
      await handle.prompt('look at this', {
        owner: 'alice',
        images: [{ mediaType: 'image/png', data: PNG_1X1_BASE64 }],
      });
      expect(fx.script.calls.length).toBe(1);
      expect(fx.script.calls[0]!.imageCount).toBe(1);
    } finally {
      await handle.dispose();
    }
  });

  it('unnamed steer queues behind a NAMED owner (handle principal is not an alias)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['a'], hold }, { deltas: ['b'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const alice = handle.prompt('mine', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // An UNNAMED steer while alice's turn is live: not alice's channel.
      const anon = handle.steer('anonymous nudge');
      release();
      await Promise.all([alice, anon]);
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['mine', 'anonymous nudge']);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('unnamed steer during the handle OWN turn passes natively (one brain per session)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['a'], hold }, { deltas: ['steered'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const first = handle.prompt('mine');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await handle.steer('course correct');
      release();
      await first;
      // steered natively — the follow-up arrives as its own model turn
      expect(fx.script.calls.map((c) => c.prompt)).toContain('course correct');
    } finally {
      release();
      await handle.dispose();
    }
  });
});

describe('RuntimeRegistry', () => {
  it('boots with growth detection, resolves roles to the configured runtime, and reports status #contract:registry-policy:pi', async () => {
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      pi: {
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['ok'] }])),
      },
    });
    const growth = registry.boot();
    expect(growth.findings).toEqual([]);
    expect(growth.snapshotState).toBe('missing'); // first boot ever
    expect(registry.runtimeIdFor('gru')).toBe('pi');
    expect(registry.runtimeIdFor('minion')).toBe('pi');

    const before = registry.status();
    expect(before.agentSession.state).toBe('no-session');
    expect(before.activeSessions).toBe(0);
    expect(before.adapters).toEqual([]); // adapters are created lazily

    const handle = await registry.spawn('gru');
    try {
      await handle.prompt('status check', { owner: 'alice' });
      const after = registry.status();
      expect(after.agentSession.state).toBe('idle');
      expect(after.agentSession.lastActivity).not.toBeNull();
      expect(after.activeSessions).toBe(1);
      expect(after.adapters).toEqual([{ id: 'pi', state: 'ok' }]);
    } finally {
      await registry.disposeHandle(handle);
    }
    expect(registry.status().activeSessions).toBe(0);
    await registry.dispose();
  });

  it('forwards isolatedReview through the production registry to the adapter', async () => {
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: fx.config,
      store: fx.store,
      pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
    });
    registry.boot();
    const handle = await registry.spawn('perkins', {
      isolatedReview: { systemPrompt: 'registry-isolated-policy', tools: [] },
    });
    try {
      const options = twinGate.lastOptions as {
        noTools?: string;
        resourceLoader: { getSystemPrompt(): string | undefined; getSkills(): { skills: unknown[] } };
      };
      expect(options.noTools).toBe('all');
      expect(options.resourceLoader.getSystemPrompt()).toBe('registry-isolated-policy');
      expect(options.resourceLoader.getSkills().skills).toEqual([]);
    } finally {
      await registry.disposeHandle(handle);
      await registry.dispose();
    }
  });

  it('resolves claude-code to a fallback-wrapped adapter and still rejects unknown ids', () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), 'gru-command-reg-')));
    cleanupDirs.push(store.dataDir);
    // Minimal config stand-in: the registry reads runtimes and the resident
    // concurrency limit for this path; constructing the claude-code adapter
    // must not touch disk or probe the binary (that happens lazily at spawn).
    const registry = new RuntimeRegistry({
      config: { runtimes: { default: 'pi', roles: {} }, concurrency: { maxWorkers: 4 } } as never,
      store,
    });
    // Pre-E3 this threw "no adapter implementation yet" (red → green flip):
    const adapter = registry.runtimeFor('claude-code');
    expect(adapter.id).toBe('claude-code');
    expect(adapter.capabilities.steer).toBe('queued'); // fallback-wrapped
    expect(() => registry.runtimeFor('bogus' as never)).toThrow(/unknown runtime/);
  });

  it('self-heals: a handle disposed directly leaves the registry set', async () => {
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      pi: {
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['ok'] }])),
      },
    });
    registry.boot();
    const handle = await registry.spawn('gru');
    expect(registry.status().activeSessions).toBe(1);
    await handle.dispose(); // direct dispose, NOT registry.disposeHandle
    expect(registry.status().activeSessions).toBe(0);
    expect(registry.status().agentSession.state).toBe('no-session');
    await registry.dispose();
  });

  it('thinking fallback: a control-less adapter gets warn + default (ruling 16)', () => {
    const warns: string[] = [];
    const fakeAdapter = {
      id: 'fake',
      capabilities: {
        streaming: true,
        steer: 'queued' as const,
        resume: 'none' as const,
        images: false,
        thinking: false,
        thinkingLevelControl: false,
        followUp: false,
      },
    };
    const log = (level: string, msg: string) => {
      if (level === 'warn') warns.push(msg);
    };
    expect(applyThinkingFallback(fakeAdapter as never, 'high', log)).toBe('default');
    expect(warns.length).toBe(1);
    expect(warns[0]!).toContain('cannot set thinking level');
    // The sentinel and capable adapters pass through untouched:
    expect(applyThinkingFallback(fakeAdapter as never, 'default', log)).toBe('default');
    const capable = {
      id: 'capable',
      capabilities: { ...fakeAdapter.capabilities, thinkingLevelControl: true },
    };
    expect(applyThinkingFallback(capable as never, 'max', log)).toBe('max');
  });
});

describe('Perkins r1 regressions', () => {
  it('B3: images round-trip in the EXACT SDK shape (data + mimeType) #contract:images:pi', async () => {
    const fx = await fixture([{ deltas: ['seen'] }], ['text', 'image']);
    const handle = await fx.runtime.spawn('gru');
    try {
      await handle.prompt('look', {
        owner: 'alice',
        images: [{ mediaType: 'image/png', data: PNG_1X1_BASE64 }],
      });
      expect(fx.script.calls[0]!.images).toEqual([
        { data: PNG_1X1_BASE64, mimeType: 'image/png' },
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it('W6: tool lifecycle events map through (tool_start/tool_end with callId)', async () => {
    const fx = await fixture([
      { deltas: [], toolCall: { id: 'call-1', name: 'ls', args: {} } },
      { deltas: ['listed'] },
    ]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('list my files', { owner: 'alice' });
      const starts = events.filter((e) => e.type === 'tool_start') as {
        callId: string;
        tool: string;
      }[];
      expect(starts).toEqual([{ type: 'tool_start', callId: 'call-1', tool: 'ls' }] as never);
      const ends = events.filter((e) => e.type === 'tool_end') as {
        callId: string;
        isError: boolean;
      }[];
      expect(ends.length).toBe(1);
      expect(ends[0]!.callId).toBe('call-1');
      expect(typeof ends[0]!.isError).toBe('boolean');
      // The second model call (post-tool) delivered the text:
      expect(fx.script.calls.length).toBe(2);
    } finally {
      await handle.dispose();
    }
  });

  it('E7 follow-up: a long quiet bash run heartbeats and reports a live process', async () => {
    const fx = await fixture([
      { deltas: [], toolCall: { id: 'call-quiet', name: 'bash', args: { command: 'sleep 0.3' } } },
      { deltas: ['quiet tool done'] },
    ]);
    // Short heartbeat cadence: the production derivation is exercised by
    // tool-heartbeat.test.ts; this proves the pi wiring end to end.
    const runtime = new PiRuntime({
      config: fx.config,
      store: fx.store,
      agentDir: fx.agentDir,
      modelRuntime: fx.modelRuntime,
      toolHeartbeatMs: 40,
    });
    const handle = await runtime.spawn('gru');
    try {
      const events = collect(handle);
      const turn = handle.prompt('run the quiet tool', { owner: 'alice' });
      // The quiet bash child is the live-process probe's evidence.
      await vi.waitFor(() => expect(handle.hasLiveProcess?.()).toBe(true));
      await turn;
      expect(handle.hasLiveProcess?.()).toBe(false);
      const heartbeats = events.filter(
        (event) => event.type === 'tool_update' && event.callId === 'call-quiet',
      );
      // The bash tool itself emits only its empty start update; the
      // periodic still-running updates prove the heartbeat fired.
      expect(heartbeats.length).toBeGreaterThanOrEqual(3);
    } finally {
      await handle.dispose();
      await runtime.dispose();
    }
  });

  it('issue #315: a declared-scope lane blocks the producer bash call before it starts', async () => {
    const laneDir = mkdtempSync(join(tmpdir(), 'gru-command-315-'));
    cleanupDirs.push(laneDir);
    // If the guard ever failed, the shell redirect would still create the
    // sentinel before npm runs — so its absence proves zero producer starts.
    writeFileSync(join(laneDir, 'package.json'), JSON.stringify({
      name: 'lane-fixture',
      scripts: { test: 'node -e "require(\'node:fs\').writeFileSync(\'started.txt\',\'x\')"' },
    }));
    const sentinel = join(laneDir, 'started.txt');
    const policy: WorkerVerificationPolicy = {
      jobId: 'job-915', laneId: 'job-915', cwd: laneDir, scopes: ['full'],
      producerPrefixes: [['npm', 'test']], helper: '/pkg/dist/verify/capture-cli.js', configFile: '/instance/config.toml',
    };
    const fx = await fixture([
      { deltas: [], toolCall: { id: 'call-producer', name: 'bash', args: { command: 'npm test > started.txt' } } },
      { deltas: ['refused'] },
    ]);
    const handle = await fx.runtime.spawn('gru', { cwd: laneDir, workerVerification: policy });
    try {
      await handle.prompt('run the declared verification', { owner: 'alice' });
      expect(existsSync(sentinel)).toBe(false);
      expect(readFileSync(handle.sessionFile!, 'utf8')).toContain('Minion verification refused before execution');
    } finally {
      await handle.dispose();
      await fx.runtime.dispose();
    }
  });

  it('#486: a lane session\'s bash commands carry its lane\'s variables, never ones the service inherited, with the session\'s shell prefix kept; a session outside a lane carries none #contract:lane-provenance:pi', async () => {
    // The service itself was started inside another lane.
    const inherited = { token: process.env['GRU_LANE_TOKEN'], job: process.env['GRU_LANE_JOB'] };
    process.env['GRU_LANE_TOKEN'] = 'f0'.repeat(16);
    process.env['GRU_LANE_JOB'] = 'outer-job';
    onTestFinished(() => {
      if (inherited.token === undefined) delete process.env['GRU_LANE_TOKEN']; else process.env['GRU_LANE_TOKEN'] = inherited.token;
      if (inherited.job === undefined) delete process.env['GRU_LANE_JOB']; else process.env['GRU_LANE_JOB'] = inherited.job;
    });
    const laneDir = mkdtempSync(join(tmpdir(), 'gru-command-486-'));
    cleanupDirs.push(laneDir);
    const record = (file: string) => ({ deltas: [], toolCall: { id: `call-${file}`, name: 'bash', args: { command: `printf '%s|%s|%s' "$GRU_LANE_TOKEN" "$GRU_LANE_JOB" "$GC_PREFIX_SEEN" > ${file}` } } });
    const fx = await fixture([
      record('in-lane.txt'), { deltas: ['recorded'] },
      record('no-job.txt'), { deltas: ['recorded'] },
      record('outside.txt'), { deltas: ['recorded'] },
    ]);
    // The session's own shell setting, which Pi's built-in bash honours.
    writeFileSync(join(fx.agentDir, 'settings.json'), JSON.stringify({ shellCommandPrefix: 'export GC_PREFIX_SEEN=1' }));
    const token = 'c3'.repeat(16);
    const inLane = await fx.runtime.spawn('gru', { cwd: laneDir, laneProvenance: { laneId: 'job-486', jobId: 'job-486', token } });
    const noJob = await fx.runtime.spawn('gru', { cwd: laneDir, laneProvenance: { laneId: 'round-1', jobId: null, token: 'b2'.repeat(16) } });
    const outside = await fx.runtime.spawn('gru', { cwd: laneDir });
    try {
      await inLane.prompt('record the lane', { owner: 'alice' });
      await noJob.prompt('record the lane', { owner: 'alice' });
      await outside.prompt('record the lane', { owner: 'alice' });
      expect(readFileSync(join(laneDir, 'in-lane.txt'), 'utf8')).toBe(`${token}|job-486|1`);
      expect(readFileSync(join(laneDir, 'no-job.txt'), 'utf8')).toBe(`${'b2'.repeat(16)}||1`);
      expect(readFileSync(join(laneDir, 'outside.txt'), 'utf8')).toBe('||1');
    } finally {
      await inLane.dispose();
      await noJob.dispose();
      await outside.dispose();
      await fx.runtime.dispose();
    }
  });

  it('#486: the lane bash tool is Pi\'s own bash tool, as the model sees it', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gru-command-486-def-'));
    cleanupDirs.push(cwd);
    const shape = (tool: ToolDefinition) => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines });
    expect(shape(laneBashTool(cwd, cwd, { GRU_LANE_TOKEN: 'c3'.repeat(16) }))).toEqual(shape(defineTool(createBashToolDefinition(cwd))));
  });

  it('W7: error turn — in-band completion: error event + state error, then recovers #contract:in-band-error:pi', async () => {
    const fx = await fixture([{ deltas: [], error: 'model exploded' }, { deltas: ['recovered'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      // The SDK contract: failures AFTER acceptance surface through the
      // event/message stream, not a rejection — prompt() resolves, the
      // error is in-band, and the session stays usable (robustness, R3).
      await handle.prompt('boom', { owner: 'alice' });
      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect((errorEvents[0] as { error: string }).error).toContain('model exploded');
      expect(handle.health().state).toBe('error');
      expect(handle.health().error).toBeTruthy();
      // The handle recovers: next prompt works and ends idle.
      await handle.prompt('again', { owner: 'alice' });
      expect(handle.health().state).toBe('idle');
      const states = events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
      expect(states).toContain('error');
      expect(states[states.length - 1]).toBe('idle');
    } finally {
      await handle.dispose();
    }
  });

  it('W7b: promptWithVerdict preserves an errored turn when a queued successor clears the state (r5 blocker 1)', async () => {
    let release!: () => void;
    const fx = await fixture([
      { deltas: [], error: 'queued-race exploded', hold: new Promise<void>((resolve) => (release = resolve)) },
      { deltas: ['successor'] },
    ]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const first = handle.promptWithVerdict!('first', { owner: 'alice' });
      await vi.waitFor(() => expect(fx.script.calls).toHaveLength(1));
      // A successor is queued while the errored turn is still live.
      const successor = handle.prompt('successor', { owner: 'alice' });
      release();
      const verdict = await first;
      // The successor runs to completion and owns the live session state...
      await successor;
      expect(handle.health().state).toBe('idle');
      // ...but the errored turn's own captured verdict is preserved.
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toContain('queued-race exploded');
    } finally {
      await handle.dispose();
      await fx.runtime.dispose();
    }
  });

  it('W7c: a turn aborted mid-flight by disposal never attests success (#160)', async () => {
    const fx = await fixture([{ deltas: [], hold: new Promise<void>(() => {}), honorAbort: true }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const pending = handle.promptWithVerdict!('aborted mid-flight', { owner: 'alice' });
      await vi.waitFor(() => expect(fx.script.calls).toHaveLength(1));
      // Disposal aborts the live transport turn; the prompt resolves with
      // the transport's aborted terminal message.
      await handle.dispose();
      const verdict = await pending;
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toBeTruthy();
      expect(fx.script.calls[0]?.aborted).toBe(true);
    } finally {
      await fx.runtime.dispose();
    }
  });

  it('W7d: a length-truncated completion is not positive completion evidence (#160)', async () => {
    const fx = await fixture([{ deltas: ['partial answer'], stopReason: 'length' }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const verdict = await handle.promptWithVerdict!('truncate me', { owner: 'alice' });
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toContain('length');
    } finally {
      await handle.dispose();
      await fx.runtime.dispose();
    }
  });

  it('W10: registry status aggregates streaming while a turn is live', async () => {
    let release!: () => void;
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      pi: {
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(
          new StubScript([{ deltas: ['held'], hold: new Promise<void>((r) => (release = r)) }]),
        ),
      },
    });
    registry.boot();
    const handle = await registry.spawn('gru');
    const p = handle.prompt('hold it', { owner: 'alice' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(registry.status().agentSession.state).toBe('streaming');
    expect(registry.status().agentSession.lastActivity).not.toBeNull();
    release();
    await p;
    expect(registry.status().agentSession.state).toBe('idle');
    await registry.dispose();
  });

  it('B4: double-resume of one session file in one process is rejected loudly', async () => {
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write something', { owner: 'alice' });
    const file = first.sessionFile!;
    await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(
      /already hosted by this process/,
    );
    // After the first handle disposes, the file can be re-hosted.
    await first.dispose();
    const resumed = await fx.runtime.spawn('gru', { resumeFile: file });
    await resumed.dispose();
  });

  it('N16: resume of a file locked by another process rejects without touching the file', async () => {
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    // Another "process" (fresh store instance, own bootId) holds the lock:
    const other = new SessionStore(fx.store.dataDir);
    other.acquireLock(file);
    const linesBefore = readFileSync(file, 'utf-8').split('\n').length;
    try {
      await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(/locked by pid/);
      expect(readFileSync(file, 'utf-8').split('\n').length).toBe(linesBefore);
      expect(existsSync(`${file}.lock`)).toBe(true); // theirs, intact
    } finally {
      other.releaseLock(file);
      other.dispose();
    }
  });

  it('refuses to resume a transcript another runtime wrote (a Claude Code session) by name, releasing its lock #contract:foreign-transcript-refused:pi', async () => {
    const fx = await fixture([{ deltas: ['x'] }]);
    const dir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '2026-09-17T00-00-00-000Z_11111111-1111-1111-1111-111111111111.jsonl');
    // Claude Code's own first records (an init frame, then a user turn).
    writeFileSync(file, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: '11111111-1111-1111-1111-111111111111' })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`, 'utf-8');
    const before = readFileSync(file, 'utf-8');
    await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(/is not a valid pi session/);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('a stub turn supplying both toolCall and toolCalls is refused where it is written, never inside a detached stream (#363)', () => {
    const call = { id: 'c1', name: 'bash', args: { command: 'ls' } };
    expect(() => new StubScript([{ deltas: [], toolCall: call, toolCalls: [call] }])).toThrow(/must not supply both toolCall and toolCalls/);
    const responder = new StubScript(() => ({ deltas: [], toolCall: call, toolCalls: [call] }));
    expect(() => responder.next('prompt')).toThrow(/must not supply both toolCall and toolCalls/);
  });

  it('N24: resumeFile outside the session store is refused #contract:resume-outside-store-refused:pi', async () => {
    const fx = await fixture([]);
    await expect(
      fx.runtime.spawn('gru', { resumeFile: join(fx.home, 'elsewhere.jsonl') }),
    ).rejects.toThrow(/must live under the session store/);
  });

  it('N17: adapter health goes down on infrastructure failure and recovers', async () => {
    const fx = await fixture([{ deltas: ['ok'] }], ['text'], {
      configExtra: '[runtimes.pi]\nmodel_refresh = false\n',
    });
    // Poison the sessions dir for the gru role: a FILE where the dir must be.
    const roleDir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(join(roleDir, '..'), { recursive: true });
    writeFileSync(roleDir, 'not a dir', 'utf-8');
    await expect(fx.runtime.spawn('gru')).rejects.toThrow();
    expect(fx.runtime.health().state).toBe('down');
    // Next attempt clears it:
    rmSync(roleDir);
    const handle = await fx.runtime.spawn('gru');
    expect(fx.runtime.health().state).toBe('ok');
    await handle.dispose();
    // And validation errors (bad model refs) never latch 'down':
    await expect(fx.runtime.spawn('gru', { model: 'nope/nope' })).rejects.toThrow(/unknown model/);
    expect(fx.runtime.health().state).toBe('ok');
  });
});

describe('Perkins r1 boot-surface pins', () => {
  it('N12/N13: boot backs up tracked sessions and logs grown files with kind + byte delta', async () => {
    const fx = await fixture();
    // Seed a session file, snapshot it, then grow it "while down":
    const dir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '2026-09-15T00-00-00-000Z_11111111-1111-1111-1111-111111111111.jsonl');
    writeFileSync(file, '{"type":"session","version":3}\n', 'utf-8');
    fx.store.persistSnapshot();
    writeFileSync(file, '{"type":"session","version":3}\n{"type":"message"}\n', 'utf-8');

    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
      pi: { agentDir: fx.agentDir, modelRuntime: await makeStubModelRuntime(new StubScript([])) },
    });
    const growth = registry.boot();
    expect(growth.findings.length).toBe(1);
    expect(growth.findings[0]!.kind).toBe('grew');
    // N13: the warn log names file + kind + byte delta:
    const warn = logs.find((l) => l.level === 'warn' && l.msg.includes('changed since the last snapshot'));
    expect(warn).toBeDefined();
    expect(warn!.fields).toMatchObject({ file, kind: 'grew', byte_delta: 19 });
    // N12: the boot backup pass left a copy in the backups dir:
    const backupsDir = join(fx.store.sessionsDir, 'backups');
    const backups = readdirSync(backupsDir).filter((n) => n.endsWith('.bak'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(backupsDir, backups[0]!), 'utf-8')).toContain('"type":"message"');
    // And the snapshot now covers the grown file (clean next boot):
    expect(new SessionStore(fx.store.dataDir).detectGrowth().findings).toEqual([]);
    registry.dispose();
  });
});

describe('path normalization', () => {
  it('W3: resume paths normalize like the SDK (tilde, file://, resolve)', () => {
    const home = process.env['HOME'] ?? '';
    expect(normalizeSessionPath('~/x/s.jsonl')).toBe(join(home, 'x', 's.jsonl'));
    expect(normalizeSessionPath('file:///tmp/a%20b/s.jsonl')).toBe(resolve('/tmp/a b/s.jsonl'));
    expect(normalizeSessionPath('./rel/s.jsonl')).toBe(resolve('./rel/s.jsonl'));
  });
});

describe('Perkins r2: concurrent double-resume race (B4-race)', () => {
  it('the loser never deletes the winner\'s lock; a foreign writer stays locked out; health stays ok', async () => {
    // Seed one durable session file in the store.
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write something', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    expect(existsSync(`${file}.lock`)).toBe(false);

    // TWO concurrent resume spawns: both pass the pre-check before either
    // registers (the r2 race window). Exactly one may win.
    const results = await Promise.allSettled([
      fx.runtime.spawn('gru', { resumeFile: file }),
      fx.runtime.spawn('gru', { resumeFile: file }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /already hosted by this process/,
    );

    // THE R2 BLOCKER: the winner's lock file must SURVIVE the loser's
    // rejection cleanup.
    expect(existsSync(`${file}.lock`)).toBe(true);
    // A foreign store (other bootId) is still locked out:
    const foreign = new SessionStore(fx.store.dataDir);
    expect(() => foreign.acquireLock(file)).toThrow(LockBusyError);
    foreign.dispose();
    // W1-latch pin: losing a race is a state conflict, not adapter health:
    expect(fx.runtime.health().state).toBe('ok');

    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof fx.runtime.spawn>>>).value;
    await winner.dispose();
    expect(existsSync(`${file}.lock`)).toBe(false); // released by the winner
  });
});

describe('Perkins r3: gated-twin scenario (winner-ensures-lock leg)', () => {
  it('the surviving twin re-acquires the released lock before hosting', async () => {
    // Seed a durable session file.
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('seed', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    expect(existsSync(`${file}.lock`)).toBe(false);

    twinGate.armed = true;
    try {
      // Twin 0 (pre-acquirer) stalls inside createAgentSession; twin 1
      // (skipped the pre-lock — same store already held it) stalls too.
      const twin0 = fx.runtime.spawn('gru', { resumeFile: file });
      const twin1 = fx.runtime.spawn('gru', { resumeFile: file });
      await vi.waitFor(() => expect(twinGate.fail0).not.toBeNull());
      await vi.waitFor(() => expect(twinGate.release1).not.toBeNull());

      // Twin 0 fails: its catch releases the pre-lock (nobody hosts yet).
      twinGate.fail0!();
      await expect(twin0).rejects.toThrow(/twin-0 infrastructure failure/);
      // THE PRE-LOCK IS GONE — the survivor must re-acquire at registration:
      expect(existsSync(`${file}.lock`)).toBe(false);

      // Twin 1 proceeds and hosts — the winner-ensures-lock leg fires here.
      twinGate.release1!();
      const survivor = await twin1;
      expect(survivor.sessionFile).toBe(file);
      expect(existsSync(`${file}.lock`)).toBe(true); // re-acquired
      // Cross-process single-writer still enforced after the re-acquire:
      const foreign = new SessionStore(fx.store.dataDir);
      expect(() => foreign.acquireLock(file)).toThrow(LockBusyError);
      foreign.dispose();
      await survivor.dispose();
      expect(existsSync(`${file}.lock`)).toBe(false);
    } finally {
      twinGate.armed = false;
      twinGate.fail0 = null;
      twinGate.release1 = null;
    }
  });
});

describe('spawn cwd (SPEC ruling 17 — dispatch roots in the project)', () => {
  it('hosts the session rooted at an explicit project cwd, not the workspace root #contract:spawn-cwd:pi', async () => {
    const fx = await fixture();
    const project = join(fx.workspace, 'fixture-project');
    mkdirSync(project, { recursive: true });
    const handle = await fx.runtime.spawn('minion', { cwd: project });
    try {
      const expectedDir = fx.store.sessionDirFor('minion', project);
      expect(handle.sessionFile).toContain(expectedDir);
      expect(handle.sessionFile).not.toContain(fx.store.sessionDirFor('minion', fx.workspace));
    } finally {
      await handle.dispose();
    }
    // Issue #161: a child worker's bounded authority is enforced by the
    // ADAPTER's own tool allowlist, and its product-owned identity is
    // honored (the ledger identity exists before the session).
    const child = await fx.runtime.spawn('minion', {
      cwd: project,
      agentId: 'child-owned-id',
      roleTools: ['read', 'grep', 'find', 'ls'],
    });
    try {
      const options = twinGate.lastOptions as { tools?: string[] };
      expect(options.tools).toEqual(['read', 'grep', 'find', 'ls']);
      expect(child.id).toBe('child-owned-id');
    } finally {
      await child.dispose();
    }
    // An override can only NARROW: an undeclared tool refuses loud.
    await expect(
      fx.runtime.spawn('minion', { cwd: project, roleTools: ['read', 'undeclared-tool'] }),
    ).rejects.toThrowError(/role tool override names "undeclared-tool"/);
  });

  it('default fallback reaches the real Pi SDK with read-only tools and host-captured findings', async () => {
    const fx = await fixture([
      { deltas: [], toolCall: { id: 'fallback-submit', name: 'gc_submit_fallback_findings', args: { findings: [] } } },
      { deltas: ['DONE'] },
    ]);
    const dataDir = realpathSync(fx.home);
    const h = makeFallbackRuntimeHarness((role, opts) => registry.spawn(role, opts), dataDir);
    const registry = new RuntimeRegistry({ ...serviceRegistryOptions({ reviewOwnerCessation: NO_REVIEW_OWNER_LEDGER, config: { ...fx.config, dataDir }, store: fx.store,
      workflowLaneFor: h.authority.workflowLaneFor, workflowBuildFor: h.authority.workflowBuildFor }),
      pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
    });
    try {
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback');
      expect(outcome.clearToMerge).toBe(true);
      const options = twinGate.lastOptions as { tools: string[]; customTools: { name: string }[]; noTools: string };
      expect(options.noTools).toBe('all');
      expect(options.tools).toEqual(['review_read', 'review_grep', 'review_find', 'review_ls', 'gc_submit_fallback_findings']);
      expect(options.customTools.map((tool) => tool.name)).toEqual(options.tools);
      expect(readFileSync(outcome.reportFiles[0]!, 'utf8').trim()).toBe('[]');
      expect(outcome.reportFiles[0]).toContain(join(dataDir, 'projects'));
      expect(readFileSync(join(h.lane.path, 'candidate.ts'), 'utf8')).toBe('export const candidate = 1;\n');
      expect(h.ledger.listRounds(h.job.id)).toEqual([]);
    } finally { await h.wave.shutdown(); await registry.dispose(); await fx.runtime.dispose(); h.close(); }
  });

  it('real Pi in-band error after host submission cannot turn the empty fallback report into PASS', async () => {
    const fx = await fixture([
      { deltas: [], toolCall: { id: 'fallback-submit-before-error', name: 'gc_submit_fallback_findings', args: { findings: [] } } },
      { deltas: [], error: 'review failed in-band', stopReason: 'error' },
    ]);
    const dataDir = realpathSync(fx.home);
    const h = makeFallbackRuntimeHarness((role, opts) => registry.spawn(role, opts), dataDir);
    const registry = new RuntimeRegistry({ ...serviceRegistryOptions({ reviewOwnerCessation: NO_REVIEW_OWNER_LEDGER, config: { ...fx.config, dataDir }, store: fx.store,
      workflowLaneFor: h.authority.workflowLaneFor, workflowBuildFor: h.authority.workflowBuildFor }),
      pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
    });
    try {
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback');
      expect(outcome.clearToMerge).toBe(false);
      expect(outcome.note).toContain('fallback reviewer turn did not successfully complete');
      expect(readFileSync(outcome.reportFiles[0]!, 'utf8').trim()).toBe('[]');
      expect(h.ledger.listEvents().some((event) => event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
    } finally { await h.wave.shutdown(); await registry.dispose(); await fx.runtime.dispose(); h.close(); }
  });

  it('fails loud on a relative or nonexistent cwd (never a silent fallback)', async () => {
    const fx = await fixture();
    await expect(fx.runtime.spawn('minion', { cwd: 'relative/path' })).rejects.toThrowError(
      /absolute path/,
    );
    await expect(fx.runtime.spawn('minion', { cwd: join(fx.workspace, 'missing') })).rejects.toThrowError(
      /does not exist/,
    );
    // Neither failure dents adapter health (caller-facing, not infra).
    expect(fx.runtime.health().state).toBe('ok');
  });
});

describe('typed provider-response provenance (r1 #13) — pure parsers', () => {
  // The adapter is the ONLY place typed provenance is minted: an SDK error
  // object with a numeric status, or a provider terminal message whose
  // machine-composed line parses strictly. Arbitrary exceptions stay
  // anonymous, so the recovery sensor can never misread them.
  it('sdk errors: numeric status/statusCode is the gate; headers carry Retry-After #contract:provider-failure-typed:pi', async () => {
    const { typedFromSdkError } = await import('../src/runtime/pi-adapter.js');
    expect(typedFromSdkError(new Error('arbitrary exception'))).toBeNull();
    expect(typedFromSdkError({ message: 'no numeric status' })).toBeNull();
    expect(typedFromSdkError({ status: 429 })).toEqual({ origin: 'sdk-error', status: 429 });
    expect(typedFromSdkError({ statusCode: 503 })).toEqual({ origin: 'sdk-error', status: 503 });
    const withHeaders = {
      status: 429,
      error: { error: { code: '1302' } },
      headers: { get: (name: string) => (name === 'retry-after-ms' ? '2500' : null) },
    };
    expect(typedFromSdkError(withHeaders)).toEqual({ origin: 'sdk-error', status: 429, bodyCode: '1302', retryAfterMs: 2500 });
    const seconds = { status: 429, headers: { get: (name: string) => (name === 'retry-after' ? '7' : null) } };
    expect(typedFromSdkError(seconds)).toEqual({ origin: 'sdk-error', status: 429, retryAfterMs: 7000 });
    expect(typedFromSdkError({ status: 429, error: { code: 1308 } })).toEqual({
      origin: 'sdk-error',
      status: 429,
      bodyCode: '1308',
    });
  });

  it('provider messages: only the strict machine-composed line yields typed provenance', async () => {
    const { typedFromProviderMessageLine } = await import('../src/runtime/pi-adapter.js');
    expect(typedFromProviderMessageLine('something exploded', 'zai-coding-cn', 'glm-5.3')).toBeNull();
    expect(typedFromProviderMessageLine('quota issues mentioned in prose', 'zai-coding-cn', 'glm-5.3')).toBeNull();
    expect(
      typedFromProviderMessageLine('429: {"error":{"code":"1302","message":"usage window limit"}}', 'zai-coding-cn', 'glm-5.3'),
    ).toEqual({ origin: 'provider-message', status: 429, bodyCode: '1302' });
    expect(typedFromProviderMessageLine('401: {"error":{"code":"1002"}}', 'zai-coding-cn', 'glm-5.3')).toEqual({
      origin: 'provider-message',
      status: 401,
      bodyCode: '1002',
    });
    // A bare status without a body still parses; malformed JSON never invents one.
    expect(typedFromProviderMessageLine('429: not-json', 'zai-coding-cn', 'glm-5.3')).toEqual({
      origin: 'provider-message',
      status: 429,
    });
  });
});

it('a directive-bearing steer or follow-up from the live turn\'s own owner waits as its own queued turn with its own admission, never native steering (#363 S05-2-02)', async () => {
  for (const channel of ['steer', 'followUp'] as const) {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture([{ deltas: ['base'], hold }, { deltas: ['directive turn done'] }]);
    const handle = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: `directive-${channel}-minion` });
    const identity = { requestId: `directive-${channel}`, payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: `directive-${channel}-job`, workRevision: 0, authorityEpoch: 0 };
    const events = collect(handle);
    let admissions = 0;
    try {
      const live = handle.prompt('go', { owner: 'alice' });
      await vi.waitFor(() => expect(f.script.calls.map((call) => call.prompt)).toEqual(['go']));
      const directed = handle[channel]('exact accepted directive', { owner: 'alice', directive: { identity, beforeAdmission: () => { admissions += 1; }, onAdmitted: () => {} } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'queued')).toBe(true));
      // Not delivered into the live turn: it waits in the single-writer queue, unadmitted.
      expect(events.some((event) => event.type === 'queued'), channel).toBe(true);
      expect(admissions, channel).toBe(0);
      expect(f.script.calls.map((call) => call.prompt), channel).toEqual(['go']);
      release();
      await live; await directed;
      // Then its own turn: admitted for itself, delivered after the live one, checkpointed exactly.
      expect(admissions, channel).toBeGreaterThan(0);
      expect(f.script.calls.map((call) => call.prompt), channel).toEqual(['go', 'exact accepted directive']);
      const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
      expect(inspectDirectiveCheckpoint(handle.sessionFile!, identity), channel).toMatchObject({ state: 'terminal', ok: true });
    } finally { release(); await handle.dispose(); await f.runtime.dispose(); f.store.dispose(); }
  }
});

it('directive native multi-tool invocation persists each sequential result and rejects unpersisted, foreign or completed calls', async () => {
  const f = await fixture([
    { deltas: [], toolCalls: [
      { id: 'native-batch-first', name: 'bash', args: { command: "printf 'first\\n' > native-batch.txt" } },
      { id: 'native-batch-second', name: 'bash', args: { command: "printf 'second\\n' >> native-batch.txt" } },
    ] },
    { deltas: ['genuine multi-tool completion'] },
  ]);
  const handle = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: 'native-batch-minion' });
  const session = await actualDirectiveSdkSession(handle);
  session.agent.toolExecution = 'sequential';
  const before = session.agent.beforeToolCall!;
  const { flushDirectiveToolIntent, inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  let checkedSecond = false;
  session.agent.beforeToolCall = async (input, signal) => {
    if (input.toolCall.id === 'native-batch-second') {
      const bytes = readFileSync(handle.sessionFile!, 'utf8');
      const tail = JSON.parse(bytes.trimEnd().split('\n').at(-1)!) as { message: { role: string; toolCallId: string } };
      expect(tail.message).toMatchObject({ role: 'toolResult', toolCallId: 'native-batch-first' });
      expect(() => flushDirectiveToolIntent(handle.sessionFile!, { ...input.assistantMessage, timestamp: input.assistantMessage.timestamp + 1 }, input.toolCall, identity)).toThrow(/invocation/);
      expect(() => flushDirectiveToolIntent(handle.sessionFile!, input.assistantMessage, { ...input.toolCall, arguments: { command: 'unpersisted effect' } }, identity)).toThrow(/invocation/);
      expect(() => flushDirectiveToolIntent(handle.sessionFile!, input.assistantMessage, { ...input.toolCall, id: 'foreign-call' }, identity)).toThrow(/invocation/);
      const completed = input.assistantMessage.content.find((block) => block.type === 'toolCall' && block.id === 'native-batch-first');
      if (completed?.type !== 'toolCall') throw new Error('native first batch call missing');
      expect(() => flushDirectiveToolIntent(handle.sessionFile!, input.assistantMessage, completed, identity)).toThrow(/invocation/);
      expect(readFileSync(handle.sessionFile!, 'utf8')).toBe(bytes);
      checkedSecond = true;
    }
    return before(input, signal);
  };
  const identity = { requestId: 'native-batch-request', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64),
    jobId: 'native-batch-job', workRevision: 0, authorityEpoch: 0 };
  try {
    const verdict = await handle.promptWithVerdict!('approved sequential native tool batch', {
      directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} },
    });
    expect(verdict).toMatchObject({ ok: true }); expect(checkedSecond).toBe(true);
    expect(readFileSync(join(f.workspace, 'native-batch.txt'), 'utf8')).toBe('first\nsecond\n');
    expect(f.script.calls).toHaveLength(2);
    expect(inspectDirectiveCheckpoint(handle.sessionFile!, identity)).toMatchObject({ state: 'terminal', ok: true });
    const messages = readFileSync(handle.sessionFile!, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { message?: { role: string; isError?: boolean } });
    expect(messages.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message?.isError)).toEqual([false, false]);
  } finally { await handle.dispose(); await f.runtime.dispose(); f.store.dispose(); }
});

async function assertAdmissionFailureFencesTools(mode: 'sequential' | 'parallel') {
  const f = await fixture([{ deltas: [], toolCalls: [
    { id: 'unpublished-first', name: 'bash', args: { command: 'echo forbidden > unpublished-admission.txt' } },
    { id: 'unpublished-second', name: 'bash', args: { command: 'echo forbidden >> unpublished-admission.txt' } },
  ] }, { deltas: ['native terminal after offered tools'] }]);
  const scene = await directiveRecoveryLedgerFixture(`admission-failure-${mode}`);
  const handle = await f.runtime.spawn('minion', { cwd: scene.lane.path, agentId: 'admission-failure-minion' });
  const session = await actualDirectiveSdkSession(handle); session.agent.toolExecution = mode;
  scene.ledger.registerAgent({ id: handle.id, role: 'minion', jobId: scene.request.jobId, sessionFile: handle.sessionFile });
  scene.ledger.setAgentState(handle.id, 'idle');
  scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
  const fault = new Error('original exact admission publication failed');
  const publish = vi.spyOn(scene.ledger, 'bindDirectiveNativeAdmission').mockImplementationOnce(() => { throw fault; });
  try {
    const verdict = await handle.promptWithVerdict!('original approved native tools', { directive: { identity: scene.identity,
      beforeAdmission: () => scene.ledger.assertDirectiveAuthority(scene.identity),
      onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } } });
    expect(existsSync(join(scene.lane.path, 'unpublished-admission.txt'))).toBe(false);
    expect(verdict).toMatchObject({ ok: false }); expect(verdict.error).toContain(fault.message);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(scene.ledger.getDirective(scene.request.requestId)).toMatchObject({ state: 'dispatching', nativeBinding: null });
    const { inspectDirectiveAdmission } = await import('../src/runtime/directive-checkpoint.js');
    expect(inspectDirectiveAdmission(handle.sessionFile!, scene.identity)).toMatchObject({ identity: scene.identity, agentId: handle.id });
    const rows = readFileSync(handle.sessionFile!, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { message?: { role: string; isError?: boolean } });
    expect(rows.filter((row) => row.message?.role === 'user')).toHaveLength(1);
    const results = rows.filter((row) => row.message?.role === 'toolResult');
    expect(results).toHaveLength(2); expect(results.every((row) => row.message?.isError === true)).toBe(true);
    expect(scene.ledger.latestJobEvent(scene.request.jobId, 'job.delivered')).toBeNull();
    expect(handle.cessationEvidence!()).toBe('unknown'); expect(f.store.isHeld(handle.sessionFile!)).toBe(true);
  } finally { publish.mockRestore(); await handle.dispose(); await f.runtime.dispose(); f.store.dispose(); scene.db.close(); scene.repo.cleanup(); }
}
it('R12 failed exact admission publication fences real sequential SDK tool effects', () => assertAdmissionFailureFencesTools('sequential'));
it('R12 failed exact admission publication fences real parallel SDK tool effects', () => assertAdmissionFailureFencesTools('parallel'));

async function assertSdkToolAuthority(boundary: 'model-await' | 'prior-hook-await') {
  let release!: () => void; const hold = new Promise<void>((resolveGate) => { release = resolveGate; });
  const f = await fixture([{ deltas: [], ...(boundary === 'model-await' ? { hold } : {}), toolCalls: [
    { id: 'allowed-first', name: 'bash', args: { command: 'echo allowed > authority-effects.txt' } },
    { id: 'revoked-second', name: 'bash', args: { command: 'echo forbidden >> authority-effects.txt' } },
  ] }, { deltas: ['done'] }]);
  const original = await f.runtime.spawn('minion', { cwd: f.workspace });
  const session = await actualDirectiveSdkSession(original); session.agent.toolExecution = 'sequential';
  let allowed = true; let checks = 0;
  const previous = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (input, signal) => {
    if (input.toolCall.id === 'revoked-second') {
      if (boundary === 'prior-hook-await') await Promise.resolve();
      allowed = false;
    }
    return previous?.(input, signal);
  };
  const { PiAgentHandle, PI_CAPABILITIES } = await import('../src/runtime/pi-adapter.js');
  const handle = new PiAgentHandle('minion', session, original.sessionFile!, PI_CAPABILITIES, false, [], f.store, () => {}, () => {}, 60000, original.id, () => 'exact test authority');
  const identity = { requestId: 'tool-revocation', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'tool-job', workRevision: 0, authorityEpoch: 0 };
  try {
    const turn = handle.promptWithVerdict!('approved tools', { directive: { identity, beforeAdmission: () => { checks += 1; if (!allowed) throw new Error('exact authority revoked'); }, onAdmitted: () => {} } });
    if (boundary === 'model-await') { await waitFor(() => f.script.calls.length === 1, 'awaited native model'); allowed = false; release(); }
    await turn;
    if (boundary === 'model-await') expect(existsSync(join(f.workspace, 'authority-effects.txt'))).toBe(false);
    else expect(readFileSync(join(f.workspace, 'authority-effects.txt'), 'utf8')).toBe('allowed\n');
    expect(checks).toBeGreaterThan(2);
    const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
    expect(inspectDirectiveCheckpoint(handle.sessionFile!, identity).state).toBe('unknown');
  } finally { release(); await handle.dispose(); await original.dispose(); await f.runtime.dispose(); f.store.dispose(); }
}
it('real sequential SDK tools recheck revoked directive authority after model-await', () => assertSdkToolAuthority('model-await'));
it('real sequential SDK tools recheck revoked directive authority after prior-hook-await', () => assertSdkToolAuthority('prior-hook-await'));

/** A supervised real-SDK directive scene for native directive refusals (#485). */
async function nativeRefusalFixture(turns: readonly StubTurn[] | StubResponder, configureSession?: Parameters<typeof sdkDirectiveExecutionFixture>[1]) {
  const f = await sdkDirectiveExecutionFixture(turns, configureSession);
  // The supervisor's own log lines, kept for assertions.
  const supervisorLogs: { readonly level: string; readonly msg: string; readonly fields?: Record<string, unknown> }[] = [];
  const supervisor = new Supervisor({ config: { enabled: true, turnSilenceMs: 60_000,
    restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1 },
    registry: f.registry, ledger: f.scene.ledger, notifications: f.scene.notifications, tickMs: 60_000,
    log: (level, msg, fields) => { supervisorLogs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); } });
  const handle = await f.registry.spawn('minion', { cwd: f.scene.lane.path, agentId: 'logical-minion' });
  if (handle.prepareDirectiveProducer === undefined || handle.promptWithVerdict === undefined) throw new Error('real Pi directive producer surfaces are required');
  const events = collect(handle);
  const errors = () => events.filter((event): event is Extract<RuntimeEvent, { type: 'error' }> => event.type === 'error');
  const retained = () => f.scene.ledger.listEvents({ limit: 100 })
    .filter((event) => event.kind === 'supervision.native-refusal-retained' && event.agentId === handle.id).map((event) => event.payload);
  /** Tagged with no provider identity, retained for directive recovery: no wall, no stop, one durable trace. */
  const expectRetained = (event: RuntimeEvent | undefined, error: string) => {
    expect(event).toEqual({ type: 'error', error, fatal: false, nativeControl: 'directive-refusal' });
    expect(supervisor.viewFor(handle.id)).toMatchObject({ state: 'watching', breakerOpen: false, restarts: 0 });
    expect(f.scene.ledger.listNotifications({ limit: 100 }).some((notice) => notice.kind.includes('provider-wall'))).toBe(false);
    expect(retained()).toContainEqual({ error });
    expect(handle.health().state).not.toBe('disposed');
  };
  const cleanup = async () => { supervisor.dispose(); await f.cleanup(); };
  return { ...f, supervisor, supervisorLogs, handle, events, errors, retained, expectRetained, cleanup };
}

/** Starts the scene's one ledger directive on its minion. */
function startLedgerDirective(f: Awaited<ReturnType<typeof nativeRefusalFixture>>) {
  const { scene, handle } = f;
  expect(scene.ledger.claimDirectiveDispatch(scene.request.requestId)).toBe(true);
  scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
  const producer = handle.prepareDirectiveProducer!(scene.identity);
  expect(scene.ledger.startDirectiveProducer(scene.identity, producer)).toBeGreaterThan(0);
  const directive: NonNullable<PromptOptions['directive']> = { identity: scene.identity,
    beforeAdmission: () => scene.ledger.assertDirectiveAuthority(scene.identity),
    onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } };
  return { producer, options: { owner: `silas-directive:${scene.request.requestId}`, directive } };
}

const HELD_REFUSAL = 'directive authority is terminal, held or superseded — no work may proceed';

it('a real tool-fence refusal surfaces as GC\'s wrapper around it, tagged, and the supervisor keeps watching with a durable trace (#485)', async () => {
  let applyAcceptedClarification: (() => void) | null = null;
  const f = await nativeRefusalFixture((_prompt, index) => {
    if (index === 0) applyAcceptedClarification?.();
    return index === 0
      ? { deltas: [], toolCall: { id: 'refused-local-effect', name: 'bash', args: { command: 'printf forbidden > local-authority-effect.txt' } } }
      : { deltas: ['native refusal remains final'] };
  });
  const { scene, handle } = f;
  try {
    const { producer, options } = startLedgerDirective(f);
    applyAcceptedClarification = () => {
      expect(scene.ledger.addJobAmendment({ jobId: scene.request.jobId, body: 'Synthetic accepted administrative contract clarification.',
        supersedes: [], approval: { by: 'owner', reference: 'synthetic accepted clarification' }, effect: 'material',
        expectedContractSha256: scene.identity.contractSha256 }).status).toBe('accepted');
      scene.ledger.failDirective({ requestId: scene.request.requestId, reason: 'accepted contract clarification superseded the original continuation' });
    };
    const verdict = await handle.promptWithVerdict!('original accepted synthetic directive', options);
    expect(verdict.ok).toBe(false);
    await waitFor(() => f.errors().length > 0, 'real native refusal error event');
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    // The tool fence refused the bare refusal; the next turn's fence refused with GC's wrapper around it.
    expect(f.errors()).toHaveLength(1);
    f.expectRetained(f.errors()[0], `native directive admission/guard failed; further tool effects refused: DirectiveCheckpointError: ${HELD_REFUSAL}`);
    expect(readFileSync(handle.sessionFile!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { message?: { role?: string; content?: readonly { text?: string }[] } })
      .filter((row) => row.message?.role === 'user' && row.message.content?.some((part) => part.text === 'original accepted synthetic directive'))).toHaveLength(1);
    expect(existsSync(join(scene.lane.path, 'local-authority-effect.txt'))).toBe(false);
    expect(scene.ledger.getDirective(scene.request.requestId)).toMatchObject({ state: 'failed', nativeBinding: { identity: scene.identity } });
    expect(scene.ledger.directiveCurrentAuthority(scene.request.jobId).contractSha256).not.toBe(scene.identity.contractSha256);
    const receipts = readFileSync(`${handle.sessionFile!}.producers.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { state: string; toolCallId?: string });
    expect(receipts).toContainEqual(expect.objectContaining({ state: 'guard-refused', toolCallId: 'refused-local-effect' }));
    expect(receipts.some((receipt) => receipt.state === 'ceased')).toBe(false);
    const { inspectDirectiveCheckpoint, inspectDirectiveProducers } = await import('../src/runtime/directive-checkpoint.js');
    expect(inspectDirectiveCheckpoint(handle.sessionFile!, scene.identity).state).toBe('unknown');
    expect(inspectDirectiveProducers(handle.sessionFile!, scene.identity)).toEqual([{ producer, evidence: 'unknown' }]);
  } finally { await f.cleanup(); }
});

it('a refusal at Pi\'s prompt preflight rejects the prompt as itself, tagged, with no admission and no wall (#485)', async () => {
  let revoke: (() => void) | null = null;
  const f = await nativeRefusalFixture([{ deltas: ['directive reply that must never be requested'] }], (session) => {
    // After runTurn's own authority check, before Pi's preflight re-check.
    const nativePrompt = session.prompt.bind(session);
    session.prompt = async (text, options) => { revoke?.(); return nativePrompt(text, options); };
  });
  const { scene, handle } = f;
  try {
    const { options } = startLedgerDirective(f);
    revoke = () => { revoke = null; scene.ledger.failDirective({ requestId: scene.request.requestId, reason: 'owner held the job before admission' }); };
    await expect(handle.promptWithVerdict!('original accepted synthetic directive', options)).rejects.toThrow(HELD_REFUSAL);
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    expect(f.errors()).toHaveLength(1);
    f.expectRetained(f.errors()[0], `DirectiveCheckpointError: ${HELD_REFUSAL}`);
    expect(f.fx.script.calls).toHaveLength(0);
    expect(scene.ledger.getDirective(scene.request.requestId)).toMatchObject({ state: 'failed', nativeBinding: null });
  } finally { await f.cleanup(); }
});

async function assertRefusalBetweenTurns(journal: 'recorded' | 'unrecorded') {
  const checkpoint = await import('../src/runtime/directive-checkpoint.js');
  let revoke: (() => void) | null = null;
  const f = await nativeRefusalFixture([
    { deltas: [], toolCall: { id: 'permitted-effect', name: 'bash', args: { command: 'printf ran > between-turns.txt' } } },
    { deltas: ['directive reply that must never be requested'] },
  ], (session) => {
    // The tool ran; authority is revoked before the next model request.
    const after = session.agent.afterToolCall;
    session.agent.afterToolCall = async (input, signal) => { const result = await after?.(input, signal); revoke?.(); return result; };
  });
  const { scene, handle } = f;
  const receipt = vi.spyOn(checkpoint, 'recordDirectiveAuthorityRefusal');
  if (journal === 'unrecorded') receipt.mockImplementation(() => { throw new Error('authority refusal journal unavailable'); });
  try {
    const { options } = startLedgerDirective(f);
    revoke = () => { revoke = null; scene.ledger.failDirective({ requestId: scene.request.requestId, reason: 'owner held the job between turns' }); };
    const verdict = await handle.promptWithVerdict!('original accepted synthetic directive', options);
    expect(verdict.ok).toBe(false);
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    expect(readFileSync(join(scene.lane.path, 'between-turns.txt'), 'utf8')).toBe('ran');
    expect(f.fx.script.calls).toHaveLength(1);
    expect(receipt).toHaveBeenCalledTimes(1);
    expect(f.errors()).toHaveLength(1);
    // Pi's SDK reduced the thrown refusal to its message: the bare refusal, or the
    // AggregateError that replaced it when its receipt could not be journaled.
    f.expectRetained(f.errors()[0], journal === 'recorded' ? HELD_REFUSAL : 'native guard refusal could not be durably recorded; physical ownership retained');
  } finally { receipt.mockRestore(); await f.cleanup(); }
}
it('authority revoked between turns: the next-turn fence\'s bare refusal is tagged and the minion keeps watching (#485)', () => assertRefusalBetweenTurns('recorded'));
it('a between-turn refusal whose receipt cannot be journaled is still tagged as the AggregateError that replaced it (#485)', () => assertRefusalBetweenTurns('unrecorded'));

it('each refused directive turn on one handle is tagged for itself; a look-alike text with no refusal in its turn stays a provider error (#485)', async () => {
  const { DirectiveCheckpointError } = await import('../src/runtime/directive-checkpoint.js');
  const preflightRefusal = 'synthetic native refusal at admission: the directive is held';
  const nextTurnRefusal = 'synthetic native refusal before the next model request: the directive is superseded';
  let toolsRun = 0;
  const f = await nativeRefusalFixture((_prompt, index) => [
    { deltas: [], error: HELD_REFUSAL },
    { deltas: [], toolCall: { id: 'permitted-effect', name: 'bash', args: { command: 'printf ran > refused-turns.txt' } } },
    { deltas: [], error: nextTurnRefusal },
    { deltas: [], toolCall: { id: 'second-permitted-effect', name: 'bash', args: { command: 'printf again >> refused-turns.txt' } } },
  ][index] ?? { deltas: ['unexpected model request'] }, (session) => {
    const after = session.agent.afterToolCall;
    session.agent.afterToolCall = async (input, signal) => { const result = await after?.(input, signal); toolsRun += 1; return result; };
  });
  const { handle } = f;
  const directive = (requestId: string, beforeAdmission: () => void) => ({ identity: { requestId, payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64),
    jobId: 'refused-turns-job', workRevision: 0, authorityEpoch: 0 }, beforeAdmission, onAdmitted: () => {} });
  try {
    // 1. Nothing refused: the provider's in-band error is the provider's, even in GC's exact words.
    expect(await handle.promptWithVerdict!('look-alike directive', { directive: directive('look-alike', () => {}) })).toMatchObject({ ok: false });
    // 2. Refused at Pi's preflight (the second check), as itself.
    let checks = 0;
    await expect(handle.promptWithVerdict!('preflight-refused directive', { directive: directive('preflight-refused', () => {
      if (++checks === 2) throw new DirectiveCheckpointError(preflightRefusal);
    }) })).rejects.toThrow(preflightRefusal);
    // 3. Refused at the next-turn fence after a tool ran, reduced to text by the SDK.
    expect(await handle.promptWithVerdict!('next-turn-refused directive', { directive: directive('next-turn-refused', () => {
      if (toolsRun === 1) throw new DirectiveCheckpointError(nextTurnRefusal);
    }) })).toMatchObject({ ok: false });
    // 4. Turn 3's exact words from the provider in a turn that refused nothing.
    expect(await handle.promptWithVerdict!('second look-alike directive', { directive: directive('second-look-alike', () => {}) })).toMatchObject({ ok: false });
    // 5. GC never raises a blank refusal: one given no reason still names itself, and is tagged.
    expect(await handle.promptWithVerdict!('blank refusal directive', { directive: directive('blank-refusal', () => {
      if (toolsRun === 2) throw new DirectiveCheckpointError(' ');
    }) })).toMatchObject({ ok: false });
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    const [lookAlike, atPreflight, atNextTurn, secondLookAlike, blank] = f.errors();
    expect(f.errors()).toHaveLength(5);
    expect(lookAlike).toEqual({ type: 'error', error: HELD_REFUSAL, fatal: false, provider: STUB_PROVIDER_ID, model: STUB_MODEL_ID });
    expect(secondLookAlike).toEqual({ type: 'error', error: nextTurnRefusal, fatal: false, provider: STUB_PROVIDER_ID, model: STUB_MODEL_ID });
    f.expectRetained(atPreflight, `DirectiveCheckpointError: ${preflightRefusal}`);
    f.expectRetained(atNextTurn, nextTurnRefusal);
    f.expectRetained(blank, 'directive refused without a stated reason');
    expect(f.retained()).toEqual([{ error: 'directive refused without a stated reason' }, { error: nextTurnRefusal }, { error: `DirectiveCheckpointError: ${preflightRefusal}` }]);
    expect(readFileSync(join(f.scene.lane.path, 'refused-turns.txt'), 'utf8')).toBe('ranagain');
  } finally { await f.cleanup(); }
});

it('an in-band error that only quotes a refusal recorded in its turn is not that refusal (#485)', async () => {
  const { DirectiveCheckpointError } = await import('../src/runtime/directive-checkpoint.js');
  const refusal = 'synthetic native refusal at admission: the directive is held';
  const quoted = `upstream rejected the request: ${refusal}`;
  const f = await nativeRefusalFixture([{ deltas: ['directive reply that must never be requested'] }], (session, handle) => {
    // A provider-shaped failure lands in the turn after its refusal was recorded, before the turn settles.
    const nativePrompt = session.prompt.bind(session);
    session.prompt = async (text, options) => {
      try { return await nativePrompt(text, options); } catch (error) {
        (handle as unknown as { onPiEvent(event: unknown): void }).onPiEvent({ type: 'message_end',
          message: { role: 'assistant', stopReason: 'error', errorMessage: quoted, provider: STUB_PROVIDER_ID, model: STUB_MODEL_ID } });
        throw error;
      }
    };
  });
  const { handle } = f;
  let checks = 0;
  try {
    await expect(handle.promptWithVerdict!('preflight-refused directive', { directive: { identity: { requestId: 'quoted-refusal', payloadHash: 'a'.repeat(64),
      contractSha256: 'c'.repeat(64), jobId: 'quoted-refusal-job', workRevision: 0, authorityEpoch: 0 },
      beforeAdmission: () => { if (++checks === 2) throw new DirectiveCheckpointError(refusal); }, onAdmitted: () => {} } })).rejects.toThrow(refusal);
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    expect(f.errors()).toHaveLength(2);
    expect(f.errors()[0]).toEqual({ type: 'error', error: quoted, fatal: false, provider: STUB_PROVIDER_ID, model: STUB_MODEL_ID });
    f.expectRetained(f.errors()[1], `DirectiveCheckpointError: ${refusal}`);
    expect(f.retained()).toEqual([{ error: `DirectiveCheckpointError: ${refusal}` }]);
  } finally { await f.cleanup(); }
});

const EXTENSION_AUTH = '401 Unauthorized: invalid x-api-key';

/** An error from code GC does not own (an extension hook, the SDK) in a directive
 * turn, and GC's wrapper around one, are routed as the failures they are (#485). */
async function assertForeignErrorRouted(where: 'sdk-next-turn' | 'extension-unjournaled' | 'extension-unjournaled-persistent' | 'extension-tool-fence') {
  const checkpoint = await import('../src/runtime/directive-checkpoint.js');
  const f = await nativeRefusalFixture([
    { deltas: [], toolCall: { id: 'permitted-effect', name: 'bash', args: { command: 'printf ran > foreign-error.txt' } } },
    { deltas: ['directive reply that must never be requested'] },
  ], (session) => {
    if (where === 'sdk-next-turn') {
      // The SDK's own next-turn preparation fails after the tool ran.
      vi.spyOn(session as unknown as { _compactBeforeNextAssistantResponse(context: unknown): Promise<unknown> }, '_compactBeforeNextAssistantResponse')
        .mockRejectedValueOnce(new Error('SDK next-turn preparation failed'));
      return;
    }
    // A third-party Pi extension's tool_call handler throws inside the native fence.
    const runner = (session as unknown as { readonly _extensionRunner: { hasHandlers(type: string): boolean; emitToolCall(event: unknown): Promise<unknown> } })._extensionRunner;
    const handles = runner.hasHandlers.bind(runner);
    vi.spyOn(runner, 'hasHandlers').mockImplementation((type) => type === 'tool_call' || handles(type));
    vi.spyOn(runner, 'emitToolCall').mockRejectedValue(new Error(EXTENSION_AUTH));
  });
  const { handle } = f;
  const unjournaled = where === 'extension-unjournaled' || where === 'extension-unjournaled-persistent';
  const journals = unjournaled
    ? [vi.spyOn(checkpoint, 'recordDirectiveToolRefusal'), vi.spyOn(checkpoint, 'recordDirectiveAuthorityRefusal')]
      // Each fails once in the turn, and the wall stop's disposal retries them and succeeds;
      // or the journal stays down through that disposal too.
      .map((journal) => where === 'extension-unjournaled-persistent'
        ? journal.mockImplementation(() => { throw new Error('refusal journal unavailable'); })
        : journal.mockImplementationOnce(() => { throw new Error('refusal journal unavailable'); }))
    : [];
  try {
    const { options } = startLedgerDirective(f);
    expect(await handle.promptWithVerdict!('original accepted synthetic directive', options)).toMatchObject({ ok: false });
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    expect(f.errors()).toEqual([{ type: 'error', fatal: false, provider: STUB_PROVIDER_ID, model: STUB_MODEL_ID, error: {
      'sdk-next-turn': 'SDK next-turn preparation failed',
      // Its receipt journal failed too: the AggregateError replacing a foreign error is no refusal
      // either, and keeps the foreign error's own words.
      'extension-unjournaled': 'native guard refusal could not be durably recorded; physical ownership retained: DirectiveCheckpointError: '
        + `native directive admission/guard failed; further tool effects refused: Error: ${EXTENSION_AUTH}`,
      'extension-unjournaled-persistent': 'native guard refusal could not be durably recorded; physical ownership retained: DirectiveCheckpointError: '
        + `native directive admission/guard failed; further tool effects refused: Error: ${EXTENSION_AUTH}`,
      // GC's wrapper names its foreign cause: still the extension's failure, never a refusal.
      'extension-tool-fence': `native directive admission/guard failed; further tool effects refused: Error: ${EXTENSION_AUTH}`,
    }[where] }]);
    expect(f.retained()).toEqual([]);
    expect(existsSync(join(f.scene.lane.path, 'foreign-error.txt'))).toBe(where === 'sdk-next-turn');
    if (where !== 'sdk-next-turn') {
      // The extension's 401 is classified by its own words: an authentication wall.
      await waitFor(() => f.supervisor.viewFor(handle.id)?.state === 'stopped', 'the authentication-wall stop');
      expect(f.supervisor.viewFor(handle.id)).toMatchObject({ state: 'stopped', breakerOpen: true, stopReason: 'authentication_wall' });
      expect(f.scene.ledger.listNotifications({ limit: 100 }).filter((notice) => notice.kind === `supervision.provider-wall.${handle.id}.authentication_wall`)).toHaveLength(1);
      if (where === 'extension-unjournaled-persistent') {
        // The stop's disposal cannot settle the owed receipts. Its rejection is the journal's raw
        // fault; the supervisor's warn line is the named boundary that reports it. The handle keeps
        // its physical ownership (registered, cessation unknown), never ceased silently.
        await waitFor(() => f.supervisorLogs.some((line) => line.msg === 'dispose after provider-wall escalation failed'), 'the failed disposal');
        expect(f.supervisorLogs).toContainEqual({ level: 'warn', msg: 'dispose after provider-wall escalation failed',
          fields: { agent_id: handle.id, error: 'Error: refusal journal unavailable' } });
        // By identity: a failing toBe would print the handle, whose SDK theme getter throws.
        expect(f.registry.getHandle(handle.id) === handle).toBe(true);
        expect(handle.cessationEvidence!()).toBe('unknown');
        // Once the journal is back, the next disposal settles the receipts and the handle ceases.
        for (const journal of journals) journal.mockRestore();
        await f.registry.disposeHandle(handle);
        expect(handle.cessationEvidence!()).toBe('ceased');
      } else {
        await waitFor(() => handle.health().state === 'disposed', 'the stop\'s disposal');
        expect(handle.cessationEvidence!()).toBe('ceased');
      }
    } else {
      // Routed, and classified by words that name no wall.
      expect(f.supervisor.viewFor(handle.id)).toMatchObject({ state: 'watching', breakerOpen: false });
    }
  } finally { for (const journal of journals) journal.mockRestore(); await f.cleanup(); }
}
it('the SDK\'s own next-turn failure in a directive turn stays untagged with its provider identity (#485)', () => assertForeignErrorRouted('sdk-next-turn'));
it('a Pi extension\'s 401 whose refusal receipts cannot be journaled stays untagged in its AggregateError, and still walls (#485)', () => assertForeignErrorRouted('extension-unjournaled'));
it('a refusal journal that stays down through the wall stop leaves the disposal failed loud and the handle owned, until a retry settles it (#485)', () => assertForeignErrorRouted('extension-unjournaled-persistent'));
it('a Pi extension\'s 401 at a tool fence, wrapped by GC at the next fence, stays untagged and stops as authentication_wall (#485)', () => assertForeignErrorRouted('extension-tool-fence'));

/** GC code outside its bookkeeping calls (the authority manifest) failing at Pi's
 * preflight rejects the prompt untagged, routed; a non-error throw is named (#485). */
async function assertPreflightManifestFailure(thrown: 'error' | 'null') {
  const f = await nativeRefusalFixture([{ deltas: ['directive reply that must never be requested'] }]);
  const { handle } = f;
  // Read 1 prepares the turn's binding; read 2 is Pi's preflight.
  const manifest = (handle as unknown as { directiveAuthorityManifest?: () => string }).directiveAuthorityManifest;
  let reads = 0;
  (handle as unknown as { directiveAuthorityManifest: () => string | undefined }).directiveAuthorityManifest = () => {
    if (++reads !== 2) return manifest?.();
    const value: unknown = thrown === 'error' ? new TypeError('authority manifest computation failed') : null;
    throw value;
  };
  try {
    const { options } = startLedgerDirective(f);
    const turn = handle.promptWithVerdict!('original accepted synthetic directive', options);
    if (thrown === 'error') await expect(turn).rejects.toThrow(new TypeError('authority manifest computation failed'));
    else await expect(turn).rejects.toBeNull();
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    const error = thrown === 'error' ? 'TypeError: authority manifest computation failed' : 'a non-error value was thrown: null';
    expect(f.errors()).toEqual([{ type: 'error', error, fatal: false }]);
    expect(handle.health().error).toBe(error);
    expect(f.retained()).toEqual([]);
    expect(f.supervisor.viewFor(handle.id)).toMatchObject({ state: 'watching', breakerOpen: false });
    expect(f.fx.script.calls).toHaveLength(0);
  } finally { await f.cleanup(); }
}
it('a GC failure outside its bookkeeping at Pi\'s preflight rejects the prompt untagged (#485)', () => assertPreflightManifestFailure('error'));
it('a null thrown outside GC\'s bookkeeping at Pi\'s preflight is routed untagged and named (#485)', () => assertPreflightManifestFailure('null'));

it('a value the turn\'s own proof read throws that cannot be printed still settles a named verdict, and frees the turn (#485)', async () => {
  const checkpoint = await import('../src/runtime/directive-checkpoint.js');
  const f = await nativeRefusalFixture([{ deltas: ['done'] }]);
  const { handle } = f;
  // Read 1 is the completion's checkpoint read; read 2 the verdict's own proof read.
  const inspect = checkpoint.inspectDirectiveCheckpoint;
  let reads = 0;
  const proof = vi.spyOn(checkpoint, 'inspectDirectiveCheckpoint').mockImplementation((...args) => {
    if (++reads !== 2) return inspect(...args);
    const value: unknown = Object.create(null);
    throw value;
  });
  try {
    const verdict = await handle.promptWithVerdict!('proof directive', { directive: { identity: { requestId: 'unprintable-proof', payloadHash: 'a'.repeat(64),
      contractSha256: 'c'.repeat(64), jobId: 'unprintable-job', workRevision: 0, authorityEpoch: 0 }, beforeAdmission: () => {}, onAdmitted: () => {} } });
    expect(reads).toBe(2);
    expect(verdict).toEqual({ ok: false, error: 'native correlated terminal proof unavailable: a non-error value was thrown: an unprintable value' });
    // The settle path ran to its end: no live turn is left behind.
    expect(handle.pendingTurn?.()).toBeNull();
    expect(handle.health().state).toBe('idle');
  } finally { proof.mockRestore(); await f.cleanup(); }
});

type PiBookkeepingCall = 'authority check at preflight' | 'binding read at preflight' | 'authority check' | 'tool intent journal' | 'binding read'
  | 'admission receipt' | 'admission publication' | 'checkpoint read' | 'completion receipt';

/** An EDQUOT inside one GC bookkeeping call is one tagged refusal and no quota-wall stop (#485). */
async function assertPiBookkeepingFault(site: PiBookkeepingCall) {
  const checkpoint = await import('../src/runtime/directive-checkpoint.js');
  const { deterministicFailureClass } = await import('../src/decisions/questions.js');
  const completion = site === 'checkpoint read' || site === 'completion receipt';
  const f = await nativeRefusalFixture(completion ? [{ deltas: ['done'] }] : [
    { deltas: [], toolCall: { id: 'refused-effect', name: 'bash', args: { command: 'printf forbidden > bookkeeping-fault.txt' } } },
    { deltas: ['directive reply that must never be requested'] },
  ]);
  const { handle } = f;
  const quota = Object.assign(new Error('EDQUOT: disk quota exceeded, write'), { code: 'EDQUOT' });
  const raise = (): never => { throw quota; };
  const call = site.replace(/ at preflight$/u, '');
  // The preflight reads the binding first; the tool fence reads it next.
  const readBinding = checkpoint.readDirectiveBinding;
  let reads = 0;
  const fault = site === 'binding read at preflight' || site === 'binding read'
    ? vi.spyOn(checkpoint, 'readDirectiveBinding').mockImplementation((...args) => (++reads === (site === 'binding read' ? 2 : 1) ? raise() : readBinding(...args)))
    : site === 'tool intent journal' ? vi.spyOn(checkpoint, 'flushDirectiveToolIntent').mockImplementationOnce(raise)
      : site === 'admission receipt' ? vi.spyOn(checkpoint, 'inspectDirectiveAdmission').mockImplementationOnce(raise)
        : site === 'checkpoint read' ? vi.spyOn(checkpoint, 'inspectDirectiveCheckpoint').mockImplementationOnce(raise)
          : site === 'completion receipt' ? vi.spyOn(checkpoint, 'recordDirectiveCompletion').mockImplementationOnce(raise) : null;
  let checks = 0;
  try {
    const { options } = startLedgerDirective(f);
    const directive: NonNullable<PromptOptions['directive']> = { ...options.directive,
      // Check 1 is the turn's own, 2 Pi's preflight, 3 the tool fence.
      beforeAdmission: () => { checks += 1; if ((site === 'authority check at preflight' && checks === 2) || (site === 'authority check' && checks === 3)) raise(); options.directive.beforeAdmission(); },
      onAdmitted: (binding) => { if (site === 'admission publication') raise(); options.directive.onAdmitted(binding); } };
    const refusal = `DirectiveCheckpointError: directive bookkeeping failed: ${call}: EDQUOT: disk quota exceeded, write`;
    const turn = handle.promptWithVerdict!('original accepted synthetic directive', { ...options, directive });
    if (site.endsWith('at preflight')) {
      await expect(turn, site).rejects.toThrow(refusal.replace('DirectiveCheckpointError: ', ''));
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
      expect(f.errors(), site).toHaveLength(1);
      f.expectRetained(f.errors()[0], refusal);
    } else if (completion) {
      // The reply settled the turn: no fence follows, and the verdict carries the refusal.
      expect(await turn, site).toEqual({ ok: false, error: refusal });
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
      expect(f.errors(), site).toEqual([]);
      expect(f.supervisor.viewFor(handle.id), site).toMatchObject({ state: 'watching', breakerOpen: false });
    } else {
      expect(await turn, site).toMatchObject({ ok: false });
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
      expect(existsSync(join(f.scene.lane.path, 'bookkeeping-fault.txt')), site).toBe(false);
      const error = `native directive admission/guard failed; further tool effects refused: ${refusal}`;
      expect(f.errors(), site).toHaveLength(1);
      f.expectRetained(f.errors()[0], error);
      // Its words alone would wall: the tag is what keeps it with directive recovery.
      expect(deterministicFailureClass(error), site).toBe('quota_wall');
    }
    if (fault !== null) expect(fault, site).toHaveBeenCalled();
    // Every bookkeeping fault reaches the runtime log once, with the fault it replaced, stack included.
    expect(f.logs.filter((line) => line.msg === 'native directive bookkeeping failed; the directive is refused'), site)
      .toEqual([expect.objectContaining({ level: 'error', fields: expect.objectContaining({ fault: expect.stringMatching(/^Error: EDQUOT: disk quota exceeded, write\n\s+at /u) }) })]);
  } finally { fault?.mockRestore(); await f.cleanup(); }
}
it('an EDQUOT in the ledger\'s authority check at Pi\'s preflight is one tagged refusal (#485)', () => assertPiBookkeepingFault('authority check at preflight'));
it('an EDQUOT in the binding read at Pi\'s preflight is one tagged refusal (#485)', () => assertPiBookkeepingFault('binding read at preflight'));
it('an EDQUOT in the ledger\'s authority check at the tool fence is a tagged refusal at the next fence, never a quota wall (#485)', () => assertPiBookkeepingFault('authority check'));
it('an EDQUOT in the tool intent journal is a tagged refusal at the next fence, never a quota wall (#485)', () => assertPiBookkeepingFault('tool intent journal'));
it('an EDQUOT in the tool fence\'s binding read is a tagged refusal at the next fence, never a quota wall (#485)', () => assertPiBookkeepingFault('binding read'));
it('an EDQUOT in the admission readback is a tagged refusal at the next fence, never a quota wall (#485)', () => assertPiBookkeepingFault('admission receipt'));
it('an EDQUOT in the ledger\'s admission publication is a tagged refusal at the next fence, never a quota wall (#485)', () => assertPiBookkeepingFault('admission publication'));
it('an EDQUOT in the completion\'s checkpoint read refuses the verdict and routes nothing (#485)', () => assertPiBookkeepingFault('checkpoint read'));
it('an EDQUOT in the completion receipt refuses the verdict and routes nothing (#485)', () => assertPiBookkeepingFault('completion receipt'));

/** A bare null or undefined thrown in a directive turn still fails it closed (#485, on
 * main too). Thrown outside GC's bookkeeping calls (the tool fence's authority
 * manifest) it is no refusal; thrown by GC's own ledger publication it is converted
 * where it happens, and is one. */
async function assertNullishFailure(site: 'fence' | 'admission publication', thrown: null | undefined) {
  const f = await nativeRefusalFixture([
    { deltas: [], toolCalls: [
      { id: 'refused-first', name: 'bash', args: { command: 'printf first > nullish-fence.txt' } },
      { id: 'refused-second', name: 'bash', args: { command: 'printf second >> nullish-fence.txt' } },
    ] },
    { deltas: ['directive reply that must never be requested'] },
  ]);
  const { handle } = f;
  const nothing = (): never => { const value: unknown = thrown; throw value; };
  if (site === 'fence') {
    // Reads 1 and 2 admit the turn (its own binding, Pi's preflight); 3 is the first tool's fence.
    const manifest = (handle as unknown as { directiveAuthorityManifest?: () => string }).directiveAuthorityManifest;
    let reads = 0;
    (handle as unknown as { directiveAuthorityManifest: () => string | undefined }).directiveAuthorityManifest = () => (++reads === 3 ? nothing() : manifest?.());
  }
  try {
    const verdict = await handle.promptWithVerdict!('nullish directive', { directive: { identity: { requestId: `nullish-${site.replace(/\W+/gu, '-')}-${String(thrown)}`, payloadHash: 'a'.repeat(64),
      contractSha256: 'c'.repeat(64), jobId: 'nullish-job', workRevision: 0, authorityEpoch: 0 }, beforeAdmission: () => {},
      onAdmitted: () => { if (site === 'admission publication') nothing(); } } });
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    // Neither tool ran: the failure refuses every later effect.
    expect(existsSync(join(f.scene.lane.path, 'nullish-fence.txt'))).toBe(false);
    expect(f.fx.script.calls).toHaveLength(1);
    const named = `a non-error value was thrown: ${String(thrown)}`;
    // The turn's durable texts name the bare value: its verdict, and the first tool's refusal receipt.
    const failure = site === 'fence' ? named : `DirectiveCheckpointError: directive bookkeeping failed: admission publication: ${named}`;
    expect(verdict).toEqual({ ok: false, error: failure });
    const receipts = readFileSync(`${handle.sessionFile!}.producers.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { state: string; toolCallId?: string; reason?: string });
    expect(receipts).toContainEqual(expect.objectContaining({ state: 'guard-refused', toolCallId: 'refused-first',
      reason: site === 'fence' ? named : `DirectiveCheckpointError: native directive admission/guard failed; further tool effects refused: ${failure}` }));
    if (site === 'fence') {
      // GC's wrapper names a cause that is no refusal: untagged, with its provider identity.
      expect(f.errors()).toEqual([{ type: 'error', error: `native directive admission/guard failed; further tool effects refused: ${named}`,
        fatal: false, provider: STUB_PROVIDER_ID, model: STUB_MODEL_ID }]);
      expect(f.retained()).toEqual([]);
    } else {
      expect(f.errors()).toHaveLength(1);
      f.expectRetained(f.errors()[0], `native directive admission/guard failed; further tool effects refused: DirectiveCheckpointError: directive bookkeeping failed: admission publication: ${named}`);
    }
  } finally { await f.cleanup(); }
}
it('a null thrown at a tool fence outside GC\'s bookkeeping refuses every later effect, and its wrapper is untagged (#485)', () => assertNullishFailure('fence', null));
it('an undefined thrown at a tool fence outside GC\'s bookkeeping refuses every later effect, and its wrapper is untagged (#485)', () => assertNullishFailure('fence', undefined));
it('a null thrown by the ledger\'s admission publication is a tagged refusal that refuses every later effect (#485)', () => assertNullishFailure('admission publication', null));
it('an undefined thrown by the ledger\'s admission publication is a tagged refusal that refuses every later effect (#485)', () => assertNullishFailure('admission publication', undefined));

it('a provider authentication rejection in a directive turn is never tagged and still stops as authentication_wall (#485)', async () => {
  const f = await nativeRefusalFixture([{ deltas: ['directive reply that must never be requested'] }], (session) => {
    // Pi's own untyped rejection for an expired OAuth login.
    const models = (session as unknown as { readonly _modelRuntime: ModelRuntime })._modelRuntime;
    vi.spyOn(models, 'hasConfiguredAuth').mockReturnValue(false);
    vi.spyOn(models, 'checkAuth').mockResolvedValue(undefined);
    vi.spyOn(models, 'isUsingOAuth').mockReturnValue(true);
  });
  const { handle } = f;
  try {
    const { options } = startLedgerDirective(f);
    await expect(handle.promptWithVerdict!('original accepted synthetic directive', options)).rejects.toThrow(`Authentication failed for "${STUB_PROVIDER_ID}"`);
    await waitFor(() => handle.health().state === 'disposed', 'the authentication-wall stop');
    expect(f.errors()).toHaveLength(1);
    expect(f.errors()[0]).not.toHaveProperty('nativeControl');
    expect(f.errors()[0]!.error).toContain(`Error: Authentication failed for "${STUB_PROVIDER_ID}"`);
    expect(f.supervisor.viewFor(handle.id)).toMatchObject({ state: 'stopped', breakerOpen: true, stopReason: 'authentication_wall' });
    expect(f.scene.ledger.listNotifications({ limit: 100 }).filter((notice) => notice.kind === `supervision.provider-wall.${handle.id}.authentication_wall`)).toHaveLength(1);
    expect(f.retained()).toEqual([]);
    expect(f.fx.script.calls).toHaveLength(0);
  } finally { await f.cleanup(); }
});

it('routes a synthesized next-turn native guard refusal locally and consumes its event provenance', async () => {
  let applyAcceptedClarification: (() => void) | null = null;
  let preparations = 0;
  let clarificationApplied = false;
  let injectedProviderError = false;
  const localRefusalBeforeProvider: RuntimeEvent[] = [];
  let supervisorViewBeforeProvider: ReturnType<Supervisor['viewFor']> | null = null;
  let providerWallBeforeProvider = false;
  let guardRefusalReceiptBeforeProvider = false;
  let cessationReceiptBeforeProvider = false;
  const events: RuntimeEvent[] = [];
  const supervisorHolder: { current: Supervisor | null } = { current: null };
  const f = await sdkDirectiveExecutionFixture([
    { deltas: [], toolCall: { id: 'authorized-before-next-turn-refusal', name: 'bash', args: { command: 'printf authorized-before-refusal' } } },
    { deltas: ['must not resume after the local refusal'] },
  ], (session, handle) => {
    const prepare = session.agent.prepareNextTurnWithContext!.bind(session.agent);
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      preparations += 1;
      if (!clarificationApplied && f.fx.script.calls.length === 1) {
        clarificationApplied = true;
        applyAcceptedClarification?.();
      }
      return prepare(turn, signal);
    };
    const runtimeBoundary = handle as unknown as { onPiEvent: (event: unknown) => void };
    session.subscribe((event) => {
      if (injectedProviderError || event.type !== 'message_end' || event.message.role !== 'assistant' || event.message.stopReason !== 'error') return;
      injectedProviderError = true;
      const localRefusal = [...events].reverse().find((candidate) => candidate.type === 'error' && candidate.nativeControl === 'directive-refusal');
      if (localRefusal !== undefined) localRefusalBeforeProvider.push(localRefusal);
      const liveSupervisor = supervisorHolder.current;
      if (liveSupervisor === null) throw new Error('supervisor must be constructed before the synthetic Pi session is spawned');
      supervisorViewBeforeProvider = liveSupervisor.viewFor(handle.id);
      providerWallBeforeProvider = f.scene.ledger.listNotifications({ limit: 100 }).some((notice) => notice.kind.includes('provider-wall') && notice.agentId === handle.id);
      const receipts = readFileSync(`${handle.sessionFile!}.producers.jsonl`, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as { state: string; boundary?: string });
      guardRefusalReceiptBeforeProvider = receipts.some((receipt) => receipt.state === 'guard-refused' && receipt.boundary === 'authority');
      cessationReceiptBeforeProvider = receipts.some((receipt) => receipt.state === 'ceased');
      runtimeBoundary.onPiEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error',
        errorMessage: 'HTTP 401 Unauthorized', provider: 'synthetic-provider', model: 'synthetic-model' } });
    });
  });
  const { scene, registry, fx } = f;
  const supervisor = new Supervisor({ config: { enabled: true, turnSilenceMs: 60_000,
    restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1 },
    registry, ledger: scene.ledger, notifications: scene.notifications, tickMs: 5 });
  supervisorHolder.current = supervisor;
  supervisor.start();
  const spawn = vi.spyOn(registry, 'spawn');
  try {
    expect(scene.ledger.claimDirectiveDispatch(scene.request.requestId)).toBe(true);
    const handle = await registry.spawn('minion', { cwd: scene.lane.path, agentId: 'synthesized-next-turn-local-refusal' });
    scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
    if (handle.prepareDirectiveProducer === undefined || handle.promptWithVerdict === undefined) throw new Error('real Pi directive producer surfaces are required');
    const producer = handle.prepareDirectiveProducer(scene.identity);
    expect(scene.ledger.startDirectiveProducer(scene.identity, producer)).toBeGreaterThan(0);
    applyAcceptedClarification = () => {
      expect(scene.ledger.addJobAmendment({ jobId: scene.request.jobId, body: 'Synthetic accepted administrative contract clarification.',
        supersedes: [], approval: { by: 'owner', reference: 'synthetic accepted clarification' }, effect: 'administrative',
        expectedContractSha256: scene.identity.contractSha256 }).status).toBe('accepted');
      scene.ledger.failDirective({ requestId: scene.request.requestId, reason: 'accepted contract clarification superseded the original continuation' });
    };
    handle.subscribe((event) => events.push(event));
    const verdict = await handle.promptWithVerdict('original accepted synthetic directive', { owner: `silas-directive:${scene.request.requestId}`,
      directive: { identity: scene.identity, beforeAdmission: () => scene.ledger.assertDirectiveAuthority(scene.identity),
        onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } } });
    expect(verdict.ok).toBe(false);
    await waitFor(() => events.some((event) => event.type === 'error' && event.error === 'HTTP 401 Unauthorized'), 'separate subsequent provider error event');
    await vi.waitFor(() => expect(supervisor.viewFor(handle.id)).toMatchObject({ state: 'stopped', breakerOpen: true, stopReason: 'authentication_wall', restarts: 0 }));

    expect(preparations).toBeGreaterThan(0);
    expect(clarificationApplied).toBe(true);
    expect(injectedProviderError).toBe(true);
    const localRefusal = localRefusalBeforeProvider[0];
    expect(localRefusal?.type).toBe('error');
    expect(localRefusal?.type === 'error' ? localRefusal.error : '').toContain('directive authority is terminal, held or superseded — no work may proceed');
    expect(localRefusal).toMatchObject({ nativeControl: 'directive-refusal', fatal: false });
    expect(localRefusal?.type === 'error' ? localRefusal.typed : undefined).toBeUndefined();
    expect(supervisorViewBeforeProvider).toMatchObject({ state: 'watching', breakerOpen: false, restarts: 0 });
    expect(providerWallBeforeProvider).toBe(false);
    const providerFailure = events.find((event) => event.type === 'error' && event.error === 'HTTP 401 Unauthorized');
    expect(providerFailure?.type).toBe('error');
    if (providerFailure?.type !== 'error') throw new Error(`synthetic Pi provider error event missing: ${JSON.stringify(events)}`);
    expect(providerFailure.nativeControl).toBeUndefined();
    expect(providerFailure.typed).toBeUndefined();
    expect(providerFailure).toMatchObject({ provider: 'synthetic-provider', model: 'synthetic-model' });
    expect(scene.ledger.listNotifications({ limit: 100 }).some((notice) => notice.kind.includes('provider-wall') && notice.agentId === handle.id)).toBe(true);
    expect(scene.ledger.listProviderWaits()).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fx.script.calls).toHaveLength(1);
    expect(readFileSync(handle.sessionFile!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { message?: { role?: string; content?: readonly { text?: string }[] } })
      .filter((row) => row.message?.role === 'user' && row.message.content?.some((part) => part.text === 'original accepted synthetic directive'))).toHaveLength(1);
    expect(existsSync(join(scene.lane.path, 'local-authority-effect.txt'))).toBe(false);
    expect(guardRefusalReceiptBeforeProvider).toBe(true);
    expect(cessationReceiptBeforeProvider).toBe(false);
    const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
    expect(inspectDirectiveCheckpoint(handle.sessionFile!, scene.identity).state).toBe('unknown');
    expect(scene.ledger.getDirective(scene.request.requestId)).toMatchObject({ state: 'failed', nativeBinding: { identity: scene.identity } });
  } finally {
    supervisor.dispose();
    await f.cleanup();
  }
});

it('typed provider terminal errors with local-authority words retain auth and quota routing', async () => {
  for (const { status, bodyCode, stopReason } of [
    { status: 401, bodyCode: '1002', stopReason: 'authentication_wall' as const },
    { status: 429, bodyCode: '1302', stopReason: 'quota_wall' as const },
  ]) {
    const f = await sdkDirectiveExecutionFixture([{ deltas: ['no provider call is required for an injected terminal'] }]);
    const { scene, registry } = f;
    const supervisor = new Supervisor({ config: { enabled: true, turnSilenceMs: 60_000,
      restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1 },
      registry, ledger: scene.ledger, notifications: scene.notifications, tickMs: 5 });
    supervisor.start();
    const spawn = vi.spyOn(registry, 'spawn');
    try {
      const handle = await registry.spawn('minion', { cwd: scene.lane.path, agentId: `typed-provider-local-words-${status}` });
      const events: RuntimeEvent[] = [];
      handle.subscribe((event) => events.push(event));
      const runtimeBoundary = handle as unknown as { onPiEvent: (event: unknown) => void };
      const localControlWords = 'DirectiveCheckpointError: directive authority is terminal, held or superseded — no work is authorized';
      const errorMessage = `${status}: ${JSON.stringify({ error: { code: bodyCode, message: localControlWords } })}`;
      runtimeBoundary.onPiEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error',
        errorMessage, provider: 'zai-coding-cn', model: 'glm-5.3' } });
      await vi.waitFor(() => expect(supervisor.viewFor(handle.id)).toMatchObject({ state: 'stopped', breakerOpen: true, stopReason, restarts: 0 }));
      const providerFailure = events.find((event) => event.type === 'error');
      expect(providerFailure?.type).toBe('error');
      if (providerFailure?.type !== 'error') throw new Error(`typed Pi provider error event missing: ${JSON.stringify(events)}`);
      expect(providerFailure).toMatchObject({ provider: 'zai-coding-cn', model: 'glm-5.3', fatal: false,
        typed: { origin: 'provider-message', status, bodyCode } });
      expect(providerFailure).not.toHaveProperty('nativeControl');
      expect(scene.ledger.listNotifications({ limit: 100 }).some((notice) => notice.kind.includes('provider-wall') && notice.agentId === handle.id)).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(scene.ledger.listProviderWaits()).toEqual([]);
    } finally {
      supervisor.dispose();
      await f.cleanup();
    }
  }
});

it('does not carry a captured native refusal onto a later provider error in the same Pi turn', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
  const f = await sdkDirectiveExecutionFixture([{ deltas: [], hold, honorAbort: true }]);
  const { scene, registry, fx } = f;
  const supervisor = new Supervisor({ config: { enabled: true, turnSilenceMs: 60_000,
    restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1 },
    registry, ledger: scene.ledger, notifications: scene.notifications, tickMs: 5 });
  let running: Promise<unknown> | null = null;
  try {
    expect(scene.ledger.claimDirectiveDispatch(scene.request.requestId)).toBe(true);
    const handle = await registry.spawn('minion', { cwd: scene.lane.path, agentId: 'same-turn-local-refusal-provider-error' });
    scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
    if (handle.prepareDirectiveProducer === undefined || handle.promptWithVerdict === undefined) throw new Error('real Pi directive producer surfaces are required');
    const producer = handle.prepareDirectiveProducer(scene.identity);
    scene.ledger.startDirectiveProducer(scene.identity, producer);
    const directive: NonNullable<PromptOptions['directive']> = { identity: scene.identity,
      beforeAdmission: () => scene.ledger.assertDirectiveAuthority(scene.identity),
      onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } };
    const events: RuntimeEvent[] = [];
    handle.subscribe((event) => events.push(event));
    running = handle.promptWithVerdict('synthetic accepted native directive', { owner: `silas-directive:${scene.request.requestId}`, directive })
      .then((value) => value, (error: unknown) => ({ error: String(error) }));
    await waitFor(() => fx.script.calls.length === 1, 'live synthetic Pi model turn');
    const checkpoint = await import('../src/runtime/directive-checkpoint.js');
    const guardError = new checkpoint.DirectiveCheckpointError('synthetic directive guard refusal');
    const runtimeBoundary = handle as unknown as {
      refuseDirectiveGuard: (active: NonNullable<PromptOptions['directive']>, toolCallId: string | undefined, error: unknown) => never;
      onPiEvent: (event: unknown) => void;
    };
    try { runtimeBoundary.refuseDirectiveGuard(directive, undefined, guardError); }
    catch (error) { expect(error).toBe(guardError); }
    runtimeBoundary.onPiEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error',
      errorMessage: 'HTTP 401 Unauthorized', provider: 'synthetic-provider', model: 'synthetic-model' } });
    const providerFailure = [...events].reverse().find((event) => event.type === 'error' && event.error === 'HTTP 401 Unauthorized');
    expect(providerFailure?.type).toBe('error');
    if (providerFailure?.type !== 'error') throw new Error(`synthetic Pi provider error event missing: ${JSON.stringify(events)}`);
    expect(providerFailure.nativeControl).toBeUndefined();
    expect(providerFailure.typed).toBeUndefined();
    expect(providerFailure).toMatchObject({ provider: 'synthetic-provider', model: 'synthetic-model' });
    await vi.waitFor(() => expect(supervisor.viewFor(handle.id)).toMatchObject({ state: 'stopped', breakerOpen: true, stopReason: 'authentication_wall' }));
    expect(scene.ledger.listNotifications({ limit: 100 }).some((notice) => notice.kind.includes('provider-wall') && notice.agentId === handle.id)).toBe(true);
    expect(scene.ledger.listProviderWaits()).toEqual([]);
    expect(fx.script.calls).toHaveLength(1);
  } finally {
    release();
    if (running !== null) await running;
    supervisor.dispose();
    await f.cleanup();
  }
});

it('routes a late Pi preflight authority refusal through native recovery without accepting or replaying the prompt', async () => {
  let checks = 0;
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['provider must not be called'] }]);
  const { scene, registry, fx } = f;
  const supervisor = new Supervisor({ config: { enabled: true, turnSilenceMs: 60_000,
    restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1 },
    registry, ledger: scene.ledger, notifications: scene.notifications, tickMs: 5 });
  const spawn = vi.spyOn(registry, 'spawn');
  try {
    expect(scene.ledger.claimDirectiveDispatch(scene.request.requestId)).toBe(true);
    const handle = await registry.spawn('minion', { cwd: scene.lane.path, agentId: 'late-preflight-minion' });
    scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
    if (handle.prepareDirectiveProducer === undefined || handle.promptWithVerdict === undefined) throw new Error('real Pi directive producer surfaces are required');
    const producer = handle.prepareDirectiveProducer(scene.identity);
    scene.ledger.startDirectiveProducer(scene.identity, producer);
    const events: RuntimeEvent[] = [];
    handle.subscribe((event) => events.push(event));
    await expect(handle.promptWithVerdict('synthetic original accepted directive', { owner: `silas-directive:${scene.request.requestId}`,
      directive: { identity: scene.identity, beforeAdmission: () => {
        checks += 1;
        if (checks === 2) {
          expect(scene.ledger.addJobAmendment({ jobId: scene.request.jobId, body: 'Synthetic accepted administrative contract clarification.',
            supersedes: [], approval: { by: 'owner', reference: 'synthetic accepted clarification' }, effect: 'material',
            expectedContractSha256: scene.identity.contractSha256 }).status).toBe('accepted');
          scene.ledger.failDirective({ requestId: scene.request.requestId, reason: 'accepted contract clarification superseded the original continuation' });
        }
        scene.ledger.assertDirectiveAuthority(scene.identity);
      }, onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } } }))
      .rejects.toThrow('directive authority is terminal, held or superseded — no work may proceed');
    expect(checks).toBe(2);
    await waitFor(() => events.some((event) => event.type === 'error'), 'late preflight refusal error event');
    const refusal = events.find((event) => event.type === 'error');
    expect(refusal?.type).toBe('error');
    expect(refusal?.type === 'error' ? refusal.error : '').toContain('directive authority is terminal, held or superseded — no work may proceed');
    expect(refusal).toMatchObject({ nativeControl: 'directive-refusal', fatal: false });
    expect(fx.script.calls).toHaveLength(0);
    expect(supervisor.viewFor(handle.id)).toMatchObject({ state: 'watching', breakerOpen: false, restarts: 0 });
    expect(scene.ledger.listNotifications({ limit: 100 }).some((notice) => notice.kind.includes('provider-wall'))).toBe(false);
    expect(scene.ledger.listProviderWaits()).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    const rows = readFileSync(handle.sessionFile!, 'utf8').trimEnd().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { message?: { role?: string; content?: readonly { text?: string }[] } });
    expect(rows.filter((row) => row.message?.role === 'user' && row.message.content?.some((part) => part.text === 'synthetic original accepted directive'))).toHaveLength(0);
    expect(existsSync(join(scene.lane.path, 'local-authority-effect.txt'))).toBe(false);
    expect(scene.ledger.getDirective(scene.request.requestId)?.state).toBe('failed');
    expect(scene.ledger.directiveCurrentAuthority(scene.request.jobId).contractSha256).not.toBe(scene.identity.contractSha256);
    const receipts = readFileSync(`${handle.sessionFile!}.producers.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { state: string; boundary?: string });
    expect(receipts).toContainEqual(expect.objectContaining({ state: 'guard-refused', boundary: 'authority' }));
    expect(receipts.some((receipt) => receipt.state === 'ceased')).toBe(false);
    const { inspectDirectiveCheckpoint, inspectDirectiveProducers } = await import('../src/runtime/directive-checkpoint.js');
    expect(inspectDirectiveCheckpoint(handle.sessionFile!, scene.identity).state).toBe('unknown');
    expect(inspectDirectiveProducers(handle.sessionFile!, scene.identity)).toEqual([{ producer, evidence: 'unknown' }]);
    expect(handle.cessationEvidence!()).toBe('unknown');
    expect(fx.store.isHeld(handle.sessionFile!)).toBe(true);
  } finally {
    supervisor.dispose();
    await f.cleanup();
  }
});

it('retains native provenance when refusal-journal failure wraps the captured preflight refusal in AggregateError', async () => {
  let checks = 0;
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['provider must not be called'] }]);
  const { scene, registry, fx } = f;
  const supervisor = new Supervisor({ config: { enabled: true, turnSilenceMs: 60_000,
    restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1 },
    registry, ledger: scene.ledger, notifications: scene.notifications, tickMs: 5 });
  const spawn = vi.spyOn(registry, 'spawn');
  const checkpoint = await import('../src/runtime/directive-checkpoint.js');
  const recordRefusal = checkpoint.recordDirectiveAuthorityRefusal;
  let failJournal = true;
  const journal = vi.spyOn(checkpoint, 'recordDirectiveAuthorityRefusal').mockImplementation((...args) => {
    if (failJournal) throw new Error('synthetic authority-refusal journal failure');
    recordRefusal(...args);
  });
  try {
    expect(scene.ledger.claimDirectiveDispatch(scene.request.requestId)).toBe(true);
    const handle = await registry.spawn('minion', { cwd: scene.lane.path, agentId: 'aggregate-preflight-minion' });
    scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
    if (handle.prepareDirectiveProducer === undefined || handle.promptWithVerdict === undefined) throw new Error('real Pi directive producer surfaces are required');
    const producer = handle.prepareDirectiveProducer(scene.identity);
    scene.ledger.startDirectiveProducer(scene.identity, producer);
    const events: RuntimeEvent[] = [];
    handle.subscribe((event) => events.push(event));
    await expect(handle.promptWithVerdict('synthetic original accepted directive', { owner: `silas-directive:${scene.request.requestId}`,
      directive: { identity: scene.identity, beforeAdmission: () => {
        checks += 1;
        if (checks === 2) {
          expect(scene.ledger.addJobAmendment({ jobId: scene.request.jobId, body: 'Synthetic accepted administrative contract clarification.',
            supersedes: [], approval: { by: 'owner', reference: 'synthetic accepted clarification' }, effect: 'material',
            expectedContractSha256: scene.identity.contractSha256 }).status).toBe('accepted');
          scene.ledger.failDirective({ requestId: scene.request.requestId, reason: 'accepted contract clarification superseded the original continuation' });
        }
        scene.ledger.assertDirectiveAuthority(scene.identity);
      }, onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } } }))
      .rejects.toThrow('native guard refusal could not be durably recorded; physical ownership retained');
    expect(checks).toBe(2);
    expect(journal).toHaveBeenCalledTimes(1);
    await waitFor(() => events.some((event) => event.type === 'error'), 'aggregate preflight refusal error event');
    const refusal = events.find((event) => event.type === 'error');
    expect(refusal?.type).toBe('error');
    expect(refusal?.type === 'error' ? refusal.error : '').toContain('native guard refusal could not be durably recorded');
    expect(refusal?.type === 'error' ? refusal.error : '').not.toContain('directive authority is terminal, held or superseded');
    expect(refusal).toMatchObject({ nativeControl: 'directive-refusal', fatal: false });
    expect(fx.script.calls).toHaveLength(0);
    expect(supervisor.viewFor(handle.id)).toMatchObject({ state: 'watching', breakerOpen: false, restarts: 0 });
    expect(scene.ledger.listNotifications({ limit: 100 }).some((notice) => notice.kind.includes('provider-wall'))).toBe(false);
    expect(scene.ledger.listProviderWaits()).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(scene.lane.path, 'aggregate-authority-effect.txt'))).toBe(false);
    expect(scene.ledger.getDirective(scene.request.requestId)?.state).toBe('failed');
    const rows = readFileSync(handle.sessionFile!, 'utf8').trimEnd().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { message?: { role?: string } });
    expect(rows.some((row) => row.message?.role === 'user')).toBe(false);
    const { inspectDirectiveCheckpoint, inspectDirectiveProducers } = await import('../src/runtime/directive-checkpoint.js');
    expect(inspectDirectiveCheckpoint(handle.sessionFile!, scene.identity).state).toBe('unknown');
    expect(inspectDirectiveProducers(handle.sessionFile!, scene.identity)).toEqual([{ producer, evidence: 'unknown' }]);
    expect(handle.cessationEvidence!()).toBe('unknown');
    expect(fx.store.isHeld(handle.sessionFile!)).toBe(true);
  } finally {
    failJournal = false;
    journal.mockRestore();
    supervisor.dispose();
    await f.cleanup();
  }
});

it('cessation journal failure retains native lock and physical owner until an exact receipt retry succeeds', async () => {
  const f = await fixture([{ deltas: ['done'] }]);
  const handle = await f.runtime.spawn('minion', { cwd: f.workspace });
  const identity = { requestId: 'ceased-journal', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'ceased-job', workRevision: 0, authorityEpoch: 0 };
  handle.prepareDirectiveProducer!(identity);
  const path = `${handle.sessionFile!}.producers.jsonl`; const bytes = readFileSync(path, 'utf8');
  writeFileSync(path, `${bytes}{partial`);
  try {
    await expect(handle.dispose()).rejects.toThrow(/partial/);
    expect(f.store.isHeld(handle.sessionFile!)).toBe(true);
    expect(existsSync(`${handle.sessionFile!}.lock`)).toBe(true);
    expect(handle.health().state).not.toBe('disposed');
    await expect(f.runtime.spawn('minion', { resumeFile: handle.sessionFile! })).rejects.toThrow(/already hosted/);
    writeFileSync(path, bytes);
    await handle.dispose(); await handle.dispose();
    expect(handle.cessationEvidence!()).toBe('ceased'); expect(f.store.isHeld(handle.sessionFile!)).toBe(false);
    const rows = readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { state: string });
    expect(rows.filter((row) => row.state === 'ceased')).toHaveLength(1);
  } finally { writeFileSync(path, readFileSync(path, 'utf8').replace('{partial', '')); await handle.dispose(); await f.runtime.dispose(); f.store.dispose(); }
});

it('restart recovery records actual admission while the native prompt remains pending', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolveGate) => { release = resolveGate; });
  const f = await fixture([{ deltas: ['pending'], hold }]);
  const handle = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: 'approved-minion' });
  const admissions: { readonly userEntryId: string | null; readonly sessionFile: string }[] = [];
  const options = {
    owner: 'silas-directive:pending-admission',
    directive: {
      identity: { requestId: 'pending-admission', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'approved-job', workRevision: 1, authorityEpoch: 0 },
      beforeAdmission: () => {},
      onAdmitted: (binding: { readonly userEntryId: string | null; readonly sessionFile: string }) => admissions.push(binding),
    },
  };
  let settled = false;
  const turn = handle.prompt('approved pending native request', options).then(() => { settled = true; });
  try {
    await waitFor(() => f.script.calls.length === 1, 'native provider call');
    expect(settled).toBe(false);
    // Baseline 32fc2f6 has no actual-admission observer:
    // this ASSERTION reds there, with no new-module import/setup failure.
    expect(admissions).toHaveLength(1);
    expect(admissions[0]?.userEntryId).toBeTruthy();
    const entries = readFileSync(handle.sessionFile!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { id?: string; message?: { role?: string } });
    expect(entries.find((entry) => entry.id === admissions[0]?.userEntryId)?.message?.role).toBe('user');
  } finally {
    release();
    await turn;
    await f.runtime.dispose();
    f.store.dispose();
  }
});

it('restart recovery continues a durable SDK user checkpoint without replaying its prompt', async () => {
  const f = await fixture([{ deltas: ['completed from original checkpoint'] }]);
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const identity = { requestId: 'sdk-checkpoint', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'sdk-job', workRevision: 0, authorityEpoch: 0 };
  const original = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: 'sdk-logical-minion' });
  const file = original.sessionFile!;
  let preflights = 0;
  try {
    // Prepare the adapter-owned exact association, then stop BEFORE the
    // native user entry/provider command. The fixture subsequently writes
    // that actual SDK entry, modeling the admission/product-callback crash
    // window without erasing any native abort or completion evidence.
    await expect(original.prompt('already accepted SDK request', { directive: { identity,
      beforeAdmission: () => { if (++preflights > 1) throw new Error('fixture stops before native acceptance'); },
      onAdmitted: () => { throw new Error('unexpected admission before the fixture checkpoint'); },
    } })).rejects.toThrow('fixture stops before native acceptance');
    expect(f.script.calls).toHaveLength(0);
    // Pi 1.x persists the prompt and tool declarations directly ahead of the first prompt.
    const system = persistedSystemMessage(await actualDirectiveSdkSession(original));
    await original.dispose();
    const manager = SessionManager.open(file);
    manager.appendMessage(system);
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'already accepted SDK request' }], timestamp: Date.now() });
    const proof = inspectDirectiveCheckpoint(file, identity);
    expect(proof.state).toBe('resumable');
    if (proof.state !== 'resumable') throw new Error('SDK checkpoint fixture is not resumable');
    const resumed = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: original.id, resumeFile: file });
    expect(resumed.id).toBe(original.id); expect(resumed.sessionFile).toBe(file);
    const prompt = vi.spyOn(resumed, 'prompt');
    expect(await resumed.resumeDirective!(identity, proof.checkpointId, () => {})).toMatchObject({ ok: true });
    expect(prompt).not.toHaveBeenCalled(); expect(f.script.calls).toHaveLength(1);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true });
  } finally { await f.runtime.dispose(); f.store.dispose(); }
});

it('restart recovery refuses to continue a checkpoint whose transcript predates pi 1.x: no system prompt would reach the model (#521)', async () => {
  const f = await fixture([{ deltas: ['must not run'] }]);
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const identity = { requestId: 'pre-1x-checkpoint', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'pre-1x-job', workRevision: 0, authorityEpoch: 0 };
  const original = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: 'pre-1x-minion' });
  const file = original.sessionFile!;
  let preflights = 0;
  try {
    await expect(original.prompt('already accepted request', { directive: { identity,
      beforeAdmission: () => { if (++preflights > 1) throw new Error('fixture stops before native acceptance'); },
      onAdmitted: () => { throw new Error('unexpected admission before the fixture checkpoint'); },
    } })).rejects.toThrow('fixture stops before native acceptance');
    await original.dispose();
    // What a 0.85.1 host persisted: the user receipt with no system message before it.
    SessionManager.open(file).appendMessage({ role: 'user', content: [{ type: 'text', text: 'already accepted request' }], timestamp: Date.now() });
    const proof = inspectDirectiveCheckpoint(file, identity);
    if (proof.state !== 'resumable') throw new Error('pre-1.x checkpoint fixture is not resumable');
    const resumed = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: original.id, resumeFile: file });
    await expect(resumed.resumeDirective!(identity, proof.checkpointId, () => {})).rejects.toThrow('this one predates pi 1.x and is not safely resumable');
    expect(f.script.calls).toHaveLength(0);
  } finally { await f.runtime.dispose(); f.store.dispose(); }
});

it('restart recovery refuses to continue a checkpoint whose persisted prompt carries text the effective prompt does not: nothing reaches the model (#521)', async () => {
  const f = await fixture([{ deltas: ['must not run'] }]);
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const identity = { requestId: 'unbound-checkpoint', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'unbound-checkpoint-job', workRevision: 0, authorityEpoch: 0 };
  const original = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: 'unbound-checkpoint-minion' });
  const file = original.sessionFile!;
  let preflights = 0;
  try {
    // What a 1.x host persists ahead of the receipt, with text its prompt never carried.
    const system = { ...persistedSystemMessage(await actualDirectiveSdkSession(original)), content: 'unapproved persisted role authority' };
    await expect(original.prompt('already accepted request', { directive: { identity,
      beforeAdmission: () => { if (++preflights > 1) throw new Error('fixture stops before native acceptance'); },
      onAdmitted: () => { throw new Error('unexpected admission before the fixture checkpoint'); },
    } })).rejects.toThrow('fixture stops before native acceptance');
    await original.dispose();
    const manager = SessionManager.open(file);
    manager.appendMessage(system);
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'already accepted request' }], timestamp: Date.now() });
    const proof = inspectDirectiveCheckpoint(file, identity);
    if (proof.state !== 'resumable') throw new Error('checkpoint fixture is not resumable');
    const resumed = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: original.id, resumeFile: file });
    let claims = 0;
    await expect(resumed.resumeDirective!(identity, proof.checkpointId, () => { claims += 1; })).rejects.toThrow('native directive transcript prompt differs from the prompt its authority manifest bound');
    // Refused before the continuation is claimed, so the checkpoint stays resumable.
    expect(claims).toBe(0);
    expect(f.script.calls).toHaveLength(0);
  } finally { await f.runtime.dispose(); f.store.dispose(); }
});

it('restart recovery retains UNKNOWN and its writer lock through pending or failed actual SDK disposal', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolveGate) => { release = resolveGate; });
  // A real SDK-owned provider run remains pending even after abort. Neither
  // independent bash flag is mocked: this exercises native ownership alone.
  const f = await fixture([{ deltas: ['still owned native run'], hold, honorAbort: false }]);
  const handle = await f.runtime.spawn('minion', { cwd: f.workspace, agentId: 'sdk-disposal-minion' });
  const events = collect(handle);
  const identity = { requestId: 'sdk-disposal-request', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64),
    jobId: 'sdk-disposal-job', workRevision: 1, authorityEpoch: 0 };
  const admissions: unknown[] = [];
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const session = (handle as unknown as { readonly session: {
    readonly isIdle: boolean;
    readonly isBashRunning: boolean;
    readonly hasPendingBashMessages: boolean;
    readonly _extensionRunner: { invalidate(message?: string): void };
    dispose(): void | Promise<void>;
    waitForIdle(): Promise<void>;
  } }).session;
  const file = handle.sessionFile!;
  let turnSettled = false;
  const turn = handle.prompt('approved held native work', { directive: { identity, beforeAdmission: () => {},
    onAdmitted: (binding) => { admissions.push(binding); } } }).finally(() => { turnSettled = true; });
  const disposal = vi.spyOn(session, 'dispose'); // call through the ACTUAL SDK method
  const failure = new Error('actual SDK invalidation failed before native idle');
  // Pinned SDK dispose invokes this real dependency after abort hooks, before
  // disconnect/cleanup; it does not await session-level waitForIdle at all.
  const invalidation = vi.spyOn(session._extensionRunner, 'invalidate').mockImplementation(() => { throw failure; });
  try {
    await waitFor(() => f.script.calls.length === 1, 'held native SDK run');
    expect(admissions).toHaveLength(1);
    expect(session.isIdle).toBe(false); expect(turnSettled).toBe(false);
    expect(session.isBashRunning).toBe(false); expect(session.hasPendingBashMessages).toBe(false);
    expect(inspectDirectiveCheckpoint(file, identity).state).toBe('resumable');
    const nativeBytes = readFileSync(file, 'utf8');
    // Idle-first cleanup may still be pending here; do not demand unsafe
    // SDK-before-idle ordering just to observe the injected rejection.
    const disposing = handle.dispose().then(() => null, (error: unknown) => error);
    await new Promise<void>((resolveGate) => setImmediate(resolveGate));
    expect(session.isIdle).toBe(false); expect(turnSettled).toBe(false);
    expect(session.isBashRunning).toBe(false); expect(session.hasPendingBashMessages).toBe(false);
    expect(handle.cessationEvidence!(), 'pending or rejected native disposal without full cleanup cannot attest cessation').toBe('unknown');
    expect(events.filter((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased')).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(nativeBytes);
    expect(inspectDirectiveCheckpoint(file, identity).state).toBe('resumable');
    expect(f.store.isHeld(file)).toBe(true); expect(existsSync(`${file}.lock`)).toBe(true);
    const foreign = new SessionStore(f.store.dataDir);
    try { expect(() => foreign.acquireLock(file)).toThrow(LockBusyError); } finally { foreign.dispose(); }
    await expect(f.runtime.spawn('minion', { resumeFile: file })).rejects.toThrow(/already hosted by this process/);
    expect(f.script.calls).toHaveLength(1); expect(admissions).toHaveLength(1);
    release(); await turn; await session.waitForIdle();
    expect(await disposing).toBe(failure);
    expect(disposal).toHaveBeenCalledTimes(1); expect(invalidation).toHaveBeenCalledTimes(1);
    expect(session.isIdle).toBe(true); expect(turnSettled).toBe(true);
    expect(handle.cessationEvidence!(), 'native idle does not excuse failed required SDK cleanup').toBe('unknown');
    expect(events.filter((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased')).toEqual([]);
    expect(f.store.isHeld(file)).toBe(true); expect(existsSync(`${file}.lock`)).toBe(true);
    // Only a later successful full disposal may release this original owner.
    invalidation.mockRestore();
    await handle.dispose();
    expect(disposal).toHaveBeenCalledTimes(2);
    expect(handle.cessationEvidence!()).toBe('ceased'); expect(handle.cessationEvidence!()).toBe('ceased');
    await handle.dispose();
    expect(events.filter((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased')).toHaveLength(1);
    expect(f.store.isHeld(file)).toBe(false); expect(existsSync(`${file}.lock`)).toBe(false);
    expect(admissions).toHaveLength(1); expect(f.script.calls).toHaveLength(1);
  } finally {
    invalidation.mockRestore(); release();
    await turn.catch(() => {});
    // Even an assertion-RED must release the REAL SDK resource; the old
    // adapter's disposed flag would otherwise short-circuit that teardown.
    await session.waitForIdle(); await session.dispose();
    disposal.mockRestore(); await f.runtime.dispose(); f.store.dispose();
  }
});

it('restart recovery rejects synchronous SDK disposal success as proof while the native run still owns work', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolveGate) => { release = resolveGate; });
  const f = await fixture([{ deltas: ['held actual native stream'], hold, honorAbort: false }]);
  const handle = await f.runtime.spawn('minion', { cwd: f.workspace });
  const events = collect(handle);
  const session = (handle as unknown as { readonly session: {
    readonly isIdle: boolean;
    readonly isBashRunning: boolean;
    readonly hasPendingBashMessages: boolean;
    dispose(): void;
    waitForIdle(): Promise<void>;
  } }).session;
  const file = handle.sessionFile!;
  const turn = handle.prompt('actual synchronous disposal proof boundary');
  try {
    await waitFor(() => f.script.calls.length === 1, 'real native held provider');
    // Actual pinned SDK succeeds synchronously BEFORE the held native run
    // ends. No replacement session/dispose implementation or bash flag.
    expect(session.dispose()).toBeUndefined();
    expect(session.isIdle).toBe(false);
    expect(session.isBashRunning).toBe(false); expect(session.hasPendingBashMessages).toBe(false);
    let settled = false;
    const disposing = handle.dispose().then(() => { settled = true; });
    const concurrent = handle.dispose();
    await new Promise<void>((resolveGate) => setImmediate(resolveGate));
    expect(settled).toBe(false);
    expect(handle.cessationEvidence!()).toBe('unknown');
    expect(events.filter((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased')).toEqual([]);
    expect(existsSync(`${file}.lock`)).toBe(true); expect(f.store.isHeld(file)).toBe(true);
    await expect(handle.prompt('forbidden work during disposal')).rejects.toThrow(/disposed/);
    await expect(f.runtime.spawn('minion', { resumeFile: file })).rejects.toThrow(/already hosted by this process/);
    expect(f.script.calls).toHaveLength(1);
    release(); await turn; await session.waitForIdle();
    await Promise.all([disposing, concurrent]);
    expect(session.isIdle).toBe(true); expect(handle.cessationEvidence!()).toBe('ceased');
    await handle.dispose();
    expect(events.filter((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased')).toHaveLength(1);
    expect(existsSync(`${file}.lock`)).toBe(false); expect(f.script.calls).toHaveLength(1);
  } finally {
    release(); await turn.catch(() => {}); await session.waitForIdle(); await session.dispose();
    await f.runtime.dispose(); f.store.dispose();
  }
});

/** A real persisted ledger/lane for SDK ownership regressions, not a native
 * handoff fixture. It supplies no positive original-producer proof. */
async function directiveRecoveryLedgerFixture(label: string, materialRevision = false, rebrief = false) {
  const { LedgerDb } = await import('../src/ledger/db.js');
  const { LedgerApi } = await import('../src/ledger/api.js');
  const { EventBus } = await import('../src/events/bus.js');
  const { NotificationCenter } = await import('../src/notifications/center.js');
  const { InMemoryWorktreePort } = await import('./helpers/in-memory-worktrees.js');
  const dir = mkdtempSync(join(tmpdir(), 'gru-sdk-recovery-ledger-')); cleanupDirs.push(dir);
  const repo = makeFixtureRepo(label);
  const db = new LedgerDb(dir); const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'lanes'), ledger);
  ledger.addJob({ id: 'sdk-original-job', repo: 'fixture', title: label, briefing: 'immutable original approved contract' });
  ledger.setJobStatus('sdk-original-job', 'working');
  const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'sdk-original-job' });
  if (ledger.getWorktree(lane.id) === null) ledger.registerWorktree(lane); // durable lane facts at original creation, never during recovery
  if (materialRevision) expect(ledger.addJobAmendment({ jobId: 'sdk-original-job', body: 'Approved original material scope.', supersedes: [], approval: { by: 'owner', reference: 'GH-286 completion fixture' }, effect: 'material', expectedContractSha256: ledger.directiveCurrentAuthority('sdk-original-job').contractSha256 }).status).toBe('accepted');
  let sourceRoundId: string | undefined;
  if (rebrief) { const source = ledger.addRound({ jobId: 'sdk-original-job', lenses: [] }); ledger.setRoundStatus(source.id, 'aborted'); sourceRoundId = source.id; }
  const request = rebrief ? ledger.beginRebriefIntent({ jobId: 'sdk-original-job', requestId: 'sdk-original-request',
    note: 'perform original approved work only once', holder: 'gru', sourceContext: { ruleId: 'accepted-original-rule', sourceRoundId },
    handoff: { kind: 'gru-decision', decision: 'retain exact original phase completion context' } }).record :
    ledger.beginDirectiveIntent({ jobId: 'sdk-original-job', requestId: 'sdk-original-request', directive: 'perform original approved work only once', holder: 'gru' }).record;
  return { dir, repo, db, bus, ledger, notifications, worktrees, lane, request,
    identity: ledger.directiveTurnIdentity(request.requestId) };
}

async function sdkDirectiveExecutionFixture(turns: readonly StubTurn[] | StubResponder, configureSession?: (session: Awaited<ReturnType<typeof actualDirectiveSdkSession>>, handle: AgentHandle) => void, materialRevision = false, useDefaultToolExecution = false, rebrief = false) {
  const fx = await fixture(turns);
  const scene = await directiveRecoveryLedgerFixture('guarded-sdk-tools', materialRevision, rebrief);
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  // Every runtime log line, kept for assertions.
  const logs: { readonly level: string; readonly msg: string; readonly fields?: Record<string, unknown> }[] = [];
  const registry = new RuntimeRegistry({ config: fx.config, store: fx.store,
    pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
    log: (level, msg, fields) => { logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); } });
  const states: string[] = []; const toolStates: string[] = [];
  const sessions: InstanceType<typeof AgentSession>[] = [];
  registry.onAgentEvent((envelope) => {
    if (envelope.phase === 'spawned') {
      const handle = registry.getHandle(envelope.agentId)!;
      scene.ledger.registerAgent({ id: handle.id, role: handle.role, jobId: scene.request.jobId, sessionFile: handle.sessionFile, parentage: 'top-level' });
      // Record genuine initial adapter state, then relay every native state
      // through the real registry tap. Never replace streaming with idle.
      scene.ledger.setAgentState(handle.id, handle.health().state);
      const session = (handle as unknown as { readonly session: unknown }).session;
      if (!(session instanceof AgentSession)) throw new Error('guard regression requires the actual pinned SDK');
      sessions.push(session); if (!useDefaultToolExecution) session.agent.toolExecution = 'sequential';
      vi.spyOn(session, 'prompt'); vi.spyOn(session.agent, 'continue');
      const before = session.agent.beforeToolCall!;
      session.agent.beforeToolCall = async (input, signal) => {
        toolStates.push(scene.ledger.getAgent(handle.id)!.state);
        expect(handle.health().state).toBe('streaming');
        expect(scene.ledger.getAgent(handle.id)!.state).toBe('streaming');
        return before(input, signal);
      };
      configureSession?.(session, handle);
    }
    if (envelope.phase === 'event' && envelope.event?.type === 'state') {
      states.push(envelope.event.state);
      scene.ledger.setAgentState(envelope.agentId, envelope.event.state);
    }
  });
  const deps = { ledger: scene.ledger, registry, worktrees: scene.worktrees, notifications: scene.notifications,
    signal: new AbortController().signal, pendingProducerBlockers: () => [] };
  const cleanup = async () => { await registry.dispose(); await fx.runtime.dispose(); fx.store.dispose(); scene.db.close(); scene.repo.cleanup(); };
  return { fx, scene, registry, sessions, states, toolStates, deps, logs, cleanup };
}

async function assertSdkOriginalCompletionHead(mode: 'known' | 'missing' | 'null' | 'conflicting' | 'malformed') {
  const { execFileSync } = await import('node:child_process');
  const { executeAcceptedDirective, DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  const { LedgerDb } = await import('../src/ledger/db.js'); const { LedgerApi } = await import('../src/ledger/api.js');
  const { EventBus } = await import('../src/events/bus.js'); const { NotificationCenter } = await import('../src/notifications/center.js');
  const { laneIsBusy } = await import('../src/dispatch/branch-idle.js');
  let release!: () => void; const hold = new Promise<void>((done) => { release = done; });
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['Original accepted material scope genuinely finished.'], hold }], undefined, true);
  const { lane, request } = f.scene;
  const originalHead = execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const publish = f.scene.ledger.appendCustomEventIfCurrentDirective.bind(f.scene.ledger);
  const loss = vi.spyOn(f.scene.ledger, 'appendCustomEventIfCurrentDirective').mockImplementation((fields, identity) => {
    if (fields.kind === 'job.delivered') throw new Error('lost original completion publication before commit');
    return publish(fields, identity);
  });
  let moved = false;
  try {
    const running = executeAcceptedDirective(f.deps, request.requestId);
    await waitFor(() => f.fx.script.calls.length === 1, 'actual SDK original model turn');
    if (mode === 'null') { renameSync(lane.path, `${lane.path}.temporarily-absent`); moved = true; }
    release(); await running; loss.mockRestore();
    if (moved) { renameSync(`${lane.path}.temporarily-absent`, lane.path); moved = false; }
    const row = f.scene.ledger.getDirective(request.requestId)!;
    expect(row.state).toBe('admitted'); expect(row.workRevision).toBe(1);
    expect(f.scene.ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId)).toBeNull();
    const path = `${row.nativeTarget!.sessionFile}.producers.jsonl`;
    const receipts = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { state: string; producer: unknown; checkpointId?: string; head?: string | null });
    const completed = receipts.filter((receipt) => receipt.state === 'completed');
    expect(completed).toHaveLength(1); expect(completed[0]!.head).toBe(mode === 'null' ? null : originalHead);
    expect(completed[0]!.producer).toEqual((f.scene.ledger.latestJobEventByRequestId(row.jobId, 'silas.directive-producer-started', row.requestId)!.payload as { native_producer: unknown }).native_producer);
    if (mode === 'missing') writeFileSync(path, receipts.filter((receipt) => receipt.state !== 'completed').map((receipt) => JSON.stringify(receipt)).join('\n') + '\n');
    if (mode === 'conflicting') writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ ...completed[0], head: 'd'.repeat(40) }) + '\n');
    if (mode === 'malformed') writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ ...completed[0], checkpointId: 9 }) + '\n');
    writeFileSync(join(lane.path, 'later-owner-artifact.txt'), 'Later current branch evidence must not relabel original completion.\n');
    execFileSync('git', ['-C', lane.path, 'add', 'later-owner-artifact.txt']);
    execFileSync('git', ['-C', lane.path, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'later independent fixture head']);
    expect(execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).not.toBe(originalHead);
    const bytes = readFileSync(row.nativeTarget!.sessionFile, 'utf8'); const journal = readFileSync(path, 'utf8');
    const accepted = f.scene.ledger.getDirective(row.requestId)!; const job = f.scene.ledger.getJob(row.jobId)!;
    await f.registry.dispose(); f.scene.db.close();
    for (let restart = 0; restart < 2; restart += 1) {
      const db = new LedgerDb(f.scene.dir); const bus = new EventBus({}); const ledger = new LedgerApi(db.handle, { bus });
      try {
        const spawn = vi.fn(async () => { throw new Error('completed original work must never execute or allocate again'); });
        const service = new DirectiveProgressService({ ...f.deps, ledger, notifications: new NotificationCenter({ ledger, bus }), registry: { getHandle: () => null, spawn, disposeHandle: async () => {} } });
        service.reconsider(); await service.settled(); service.reconsider(); await service.settled(); await service.dispose();
        const refused = mode === 'conflicting' || mode === 'malformed';
        expect(ledger.getDirective(row.requestId)?.state).toBe(refused ? 'admitted' : 'settled');
        const delivery = ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId);
        if (refused) expect(delivery).toBeNull();
        else {
          const known = mode === 'known';
          expect(delivery?.payload).toMatchObject({ request_id: row.requestId, work_revision: 1, sha: known ? originalHead : null, candidate_delivery_proven: false, native_completion: { identity: { requestId: row.requestId, workRevision: 1 }, checkpoint_id: completed[0]!.checkpointId, binding: row.nativeBinding } });
          expect(ledger.workRevisionState(row.jobId)).toEqual({ required: 1, delivered: 0 });
          expect(ledger.correctiveVerificationDebt(row.jobId)).toEqual({ revision: 1, head: null });
          expect(laneIsBusy(ledger, ledger.getJob(row.jobId)!)).toBe(true);
          expect(ledger.listEvents().filter((event) => event.jobId === row.jobId && event.kind === 'job.delivered')).toHaveLength(1);
          if (!known) expect(ledger.listObligations({ jobId: row.jobId }).some((obligation) => obligation.nextAction.kind === 'gru-decision' && obligation.nextAction.decision.includes('completion HEAD is unproven'))).toBe(true);
        }
        expect(ledger.getDirective(row.requestId)).toMatchObject({ payloadHash: accepted.payloadHash, payload: accepted.payload, workRevision: 1, authorityEpoch: accepted.authorityEpoch, nativeTarget: accepted.nativeTarget, nativeBinding: accepted.nativeBinding });
        expect(ledger.getJob(row.jobId)).toEqual(job); expect(f.scene.worktrees.listWorktrees({ jobId: row.jobId })).toEqual([lane]); expect(spawn).not.toHaveBeenCalled();
      } finally { db.close(); }
    }
    expect(readFileSync(row.nativeTarget!.sessionFile, 'utf8')).toBe(bytes); expect(readFileSync(path, 'utf8')).toBe(journal);
    expect(f.fx.script.calls).toHaveLength(1); expect(f.sessions).toHaveLength(1);
  } finally { release(); loss.mockRestore(); if (moved) renameSync(`${lane.path}.temporarily-absent`, lane.path); await f.cleanup(); }
}
it('actual SDK original HEAD receipt survives later branch movement and two ledger/service restarts at accepted revision one', () => assertSdkOriginalCompletionHead('known'));
it('absent historical completion HEAD never samples later branch HEAD or advances accepted candidate revision', () => assertSdkOriginalCompletionHead('missing'));
it('actual SDK unavailable contemporaneous completion HEAD settles truthful original progress without candidate READY', () => assertSdkOriginalCompletionHead('null'));
it('conflicting original SDK completion HEAD receipts remain UNKNOWN and unconsumed across two restarts', () => assertSdkOriginalCompletionHead('conflicting'));
it('malformed original SDK completion receipt remains UNKNOWN and unconsumed across two restarts', () => assertSdkOriginalCompletionHead('malformed'));

const guardedSdkTools: readonly StubTurn[] = [
  { deltas: [], toolCalls: [
    { id: 'guarded-first', name: 'bash', args: { command: "printf 'first\\n' > guarded-effects.txt" } },
    { id: 'guarded-second', name: 'bash', args: { command: "printf 'second\\n' >> guarded-effects.txt" } },
  ] },
  { deltas: ['genuine guarded correlated delivery'] },
];

it('PR334 runtime causal parallel preparation revocation prevents the previously prepared first effect', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const f = await sdkDirectiveExecutionFixture(guardedSdkTools, (session) => {
    session.agent.toolExecution = 'parallel';
    const runner = (session as unknown as { _extensionRunner: { hasHandlers(type: string): boolean; emitToolCall(event: { toolCallId: string }): Promise<undefined> } })._extensionRunner;
    const has = runner.hasHandlers.bind(runner);
    vi.spyOn(runner, 'hasHandlers').mockImplementation((type) => type === 'tool_call' || has(type));
    vi.spyOn(runner, 'emitToolCall').mockImplementation(async (event) => {
      if (event.toolCallId === 'guarded-second') f.scene.ledger.setJobStatus(f.scene.request.jobId, 'parked');
      return undefined;
    });
  });
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    expect(existsSync(join(f.scene.lane.path, 'guarded-effects.txt'))).toBe(false);
    expect(f.scene.ledger.getDirective(f.scene.request.requestId)?.state).toBe('admitted');
  } finally { await f.cleanup(); }
});

it('PR334 runtime causal effective arguments cannot change behind the persisted native tool intent', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const turns: readonly StubTurn[] = [
    { deltas: [], toolCall: { id: 'effective-arguments', name: 'bash', args: { command: 'printf approved > approved-effect.txt' } } },
    { deltas: ['original final response'] },
  ];
  const f = await sdkDirectiveExecutionFixture(turns, (session) => {
    const runner = (session as unknown as { _extensionRunner: { hasHandlers(type: string): boolean; emitToolCall(event: { toolCallId: string; input: Record<string, unknown> }): Promise<undefined> } })._extensionRunner;
    const has = runner.hasHandlers.bind(runner);
    vi.spyOn(runner, 'hasHandlers').mockImplementation((type) => type === 'tool_call' || has(type));
    vi.spyOn(runner, 'emitToolCall').mockImplementation(async (event) => {
      if (event.toolCallId === 'effective-arguments') event.input.command = 'printf unapproved > unapproved-effect.txt';
      return undefined;
    });
  });
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    expect(existsSync(join(f.scene.lane.path, 'unapproved-effect.txt'))).toBe(false);
    expect(f.scene.ledger.getDirective(f.scene.request.requestId)?.state).toBe('admitted');
  } finally { await f.cleanup(); }
});

it('PR334 runtime causal changed next-turn model authority cannot publish tool-free completion', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  let preparations = 0;
  let authorityChanged = false;
  const f = await sdkDirectiveExecutionFixture([
    { deltas: [], toolCall: { id: 'model-authority-preface', name: 'bash', args: { command: 'printf model-authority-preface' } } },
    { deltas: ['tool-free response under changed model authority'] },
  ], (session) => {
    const prepare = session.agent.prepareNextTurnWithContext!.bind(session.agent);
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      preparations += 1;
      await Promise.resolve();
      const previous = session.model!.maxTokens;
      session.agent.state.model = { ...session.model!, maxTokens: previous - 1 };
      authorityChanged = session.model!.maxTokens === previous - 1;
      return prepare(turn, signal);
    };
  });
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    expect(preparations).toBe(1);
    expect(authorityChanged).toBe(true);
    expect(f.scene.ledger.getDirective(f.scene.request.requestId)?.state).toBe('admitted');
    expect(f.scene.ledger.latestJobEventByRequestId(f.scene.request.jobId, 'job.delivered', f.scene.request.requestId)).toBeNull();
    const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    expect(inspectDirectiveCheckpoint(row.nativeTarget!.sessionFile, f.scene.ledger.directiveTurnIdentity(row.requestId)).state).toBe('unknown');
    await f.registry.dispose(); f.scene.db.close();
    const native = readFileSync(row.nativeTarget!.sessionFile, 'utf8');
    const journal = readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8');
    expect(journal.split('\n').filter(Boolean).map((line) => JSON.parse(line)).some((receipt) => receipt.state === 'guard-refused' && receipt.boundary === 'authority' && receipt.toolCallId === undefined)).toBe(true);
    const { DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
    const { LedgerDb } = await import('../src/ledger/db.js'); const { LedgerApi } = await import('../src/ledger/api.js');
    const { EventBus } = await import('../src/events/bus.js'); const { NotificationCenter } = await import('../src/notifications/center.js');
    for (let restart = 0; restart < 2; restart += 1) {
      const db = new LedgerDb(f.scene.dir); const bus = new EventBus({}); const ledger = new LedgerApi(db.handle, { bus });
      const spawn = vi.fn(async () => { throw new Error('refused model authority must never replay'); });
      const service = new DirectiveProgressService({ ...f.deps, ledger, notifications: new NotificationCenter({ ledger, bus }), registry: { getHandle: () => null, spawn, disposeHandle: async () => {} } });
      try {
        service.reconsider(); await service.settled();
        expect(ledger.getDirective(row.requestId)?.state).toBe('admitted');
        expect(ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId)).toBeNull();
        expect(spawn).not.toHaveBeenCalled();
      } finally { await service.dispose(); db.close(); }
    }
    expect(readFileSync(row.nativeTarget!.sessionFile, 'utf8')).toBe(native);
    expect(readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8')).toBe(journal);
    expect(f.fx.script.calls).toHaveLength(1);
  } finally { await f.cleanup(); }
});

it('PR334 runtime causal real supervisor permits its exact current native tool owner', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const { Supervisor } = await import('../src/supervision/supervisor.js');
  const f = await sdkDirectiveExecutionFixture(guardedSdkTools);
  const supervisor = new Supervisor({ config: { enabled: true, turnSilenceMs: 600000, restartWindowMs: 600000, maxRestarts: 3, restartBackoffMs: 10 }, registry: f.registry, ledger: f.scene.ledger, notifications: f.scene.notifications, tickMs: 60000 });
  supervisor.start();
  let exactOwnerChecks = 0;
  const pending = supervisor.pendingProducerBlockers.bind(supervisor);
  vi.spyOn(supervisor, 'pendingProducerBlockers').mockImplementation((jobId, currentNative) => {
    const blockers = pending(jobId, currentNative);
    if (currentNative !== undefined && pending(jobId).length > 0 && blockers.length === 0) {
      exactOwnerChecks += 1;
      expect(pending(jobId, { ...currentNative, producer: { ...currentNative.producer, incarnation: `${currentNative.producer.incarnation}-foreign` } }).length).toBeGreaterThan(0);
      expect(pending(jobId, { ...currentNative, producer: { ...currentNative.producer, agentId: `${currentNative.producer.agentId}-foreign` } }).length).toBeGreaterThan(0);
    }
    return blockers;
  });
  try {
    await executeAcceptedDirective({ ...f.deps, pendingProducerBlockers: supervisor.pendingProducerBlockers.bind(supervisor) }, f.scene.request.requestId);
    expect(exactOwnerChecks).toBeGreaterThan(0);
    expect(f.scene.ledger.getDirective(f.scene.request.requestId)?.state).toBe('settled');
    expect(readFileSync(join(f.scene.lane.path, 'guarded-effects.txt'), 'utf8')).toBe('first\nsecond\n');
  } finally { supervisor.dispose(); await f.cleanup(); }
});

it('automatic SDK compaction completes before the same admitted native authority check resumes, and later native tools run once', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const { inspectDirectiveAdmission, inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const { Supervisor } = await import('../src/supervision/supervisor.js');
  const history = 'history '.repeat(100);
  let releaseSummary!: () => void;
  const summaryHold = new Promise<void>((resolveSummary) => { releaseSummary = resolveSummary; });
  let handle: AgentHandle | null = null;
  let supervisor: InstanceType<typeof Supervisor> | null = null;
  type CompactionObservation = {
    readonly view: ReturnType<InstanceType<typeof Supervisor>['viewFor']>;
    readonly adapterCompacting: boolean;
    readonly openControl: boolean | undefined;
    readonly openTurn: boolean;
    readonly openToolCalls: number;
    readonly ownNative: boolean;
    readonly identityMatches: Readonly<Record<string, boolean>>;
    readonly exactBlockers: readonly string[];
    readonly unownedBlockers: readonly string[];
    readonly mismatchedBlockers: Readonly<Record<string, readonly string[]>>;
  };
  let sample: (() => CompactionObservation | null) | null = null;
  const rawCompaction: string[] = [];
  /** What the adapter published, in order: compaction episodes and turn starts. */
  const published: string[] = [];
  const preparations: { readonly before: CompactionObservation; readonly after: CompactionObservation }[] = [];
  const afterCompactionTurnStarts: CompactionObservation[] = [];
  let rawTerminalObserved = false;
  const f = await sdkDirectiveExecutionFixture([
    { deltas: [history], toolCall: { id: 'compact-once', name: 'bash', args: { command: "printf 'once\\n' >> compacted-native-effect.txt" } }, usageTokens: 90_000 },
    { deltas: ['automatic compaction summary'], hold: summaryHold },
    // A native tool call after the compaction: the fence walks past it (#481).
    { deltas: [], toolCall: { id: 'after-compaction', name: 'bash', args: { command: "printf 'after\\n' >> compacted-native-effect.txt" } } },
    { deltas: ['completed after automatic compaction'] },
  ], (session, spawned) => {
    handle = spawned;
    const sdk = session as unknown as { subscribe(listener: (event: unknown) => void): () => void };
    sdk.subscribe((event) => {
      const type = (event as { readonly type?: unknown }).type;
      if (type === 'compaction_start' || type === 'compaction_end') {
        rawCompaction.push(type);
        if (type === 'compaction_end') rawTerminalObserved = true;
      }
    });
    const prepare = session.agent.prepareNextTurnWithContext!.bind(session.agent);
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const before = sample?.() ?? null;
      try { return await prepare(turn, signal); }
      finally {
        const after = sample?.() ?? null;
        if (before !== null && after !== null) preparations.push({ before, after });
      }
    };
    spawned.subscribe((event) => {
      if (event.type === 'compaction_start' || event.type === 'turn_start') published.push(event.type);
      if (event.type === 'compaction_end') published.push(`compaction_end:${event.success ? 'success' : event.error ?? 'failed'}`);
      if (event.type === 'turn_start' && rawTerminalObserved) {
        const observation = sample?.();
        if (observation !== null && observation !== undefined) afterCompactionTurnStarts.push(observation);
      }
    });
  });
  writeFileSync(join(f.fx.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 64 } }));
  supervisor = new Supervisor({ config: { enabled: true, turnSilenceMs: 600000, restartWindowMs: 600000, maxRestarts: 3, restartBackoffMs: 10 }, registry: f.registry, ledger: f.scene.ledger, notifications: f.scene.notifications, tickMs: 60000 });
  supervisor.start();
  const currentOwner = () => {
    if (handle === null) return null;
    const started = f.scene.ledger.latestJobEventByRequestId(f.scene.request.jobId, 'silas.directive-producer-started', f.scene.request.requestId);
    if (started === null) return null;
    const producer = (started.payload as { readonly native_producer?: DirectiveProducer } | undefined)?.native_producer;
    return producer === undefined ? null : { handle, producer, started };
  };
  sample = () => {
    if (handle === null || supervisor === null) return null;
    const view = supervisor.viewFor(handle.id);
    const owner = currentOwner();
    const row = f.scene.ledger.getDirective(f.scene.request.requestId);
    const pendingIdentity = handle.pendingTurn?.()?.directive?.identity;
    const nativeBinding = row?.nativeBinding;
    const nativeTarget = row?.nativeTarget;
    const startedProducer = (owner?.started.payload as { readonly native_producer?: unknown } | undefined)?.native_producer;
    const identityMatches = {
      sameRegisteredHandle: f.registry.getHandle(handle.id) === handle,
      producerAgent: owner !== null && owner.producer.agentId === handle.id,
      producerJob: owner !== null && owner.producer.identity.jobId === f.scene.request.jobId,
      acceptedIdentity: owner !== null && isDeepStrictEqual(owner.producer.identity, f.scene.identity),
      nativeTarget: nativeTarget?.agentId === handle.id && nativeTarget.sessionFile === handle.sessionFile,
      producerSessionFile: owner !== null && owner.producer.sessionFile === handle.sessionFile,
      bindingSession: owner !== null && nativeBinding?.sessionId === owner.producer.sessionId,
      pendingTurnIdentity: owner !== null && isDeepStrictEqual(pendingIdentity, owner.producer.identity),
      startedProducerReceipt: owner !== null && isDeepStrictEqual(startedProducer, owner.producer),
    };
    const ownNative = Object.values(identityMatches).every(Boolean);
    const exactBlockers = owner === null ? [] : supervisor.pendingProducerBlockers(f.scene.request.jobId, owner);
    const mismatchedBlockers: Readonly<Record<string, readonly string[]>> = owner === null ? {} : {
      incarnation: supervisor.pendingProducerBlockers(f.scene.request.jobId, { handle, producer: { ...owner.producer, incarnation: `${owner.producer.incarnation}-foreign` } }),
      session: supervisor.pendingProducerBlockers(f.scene.request.jobId, { handle, producer: { ...owner.producer, sessionId: `${owner.producer.sessionId}-foreign` } }),
      identity: supervisor.pendingProducerBlockers(f.scene.request.jobId, { handle, producer: { ...owner.producer, identity: { ...owner.producer.identity, requestId: `${owner.producer.identity.requestId}-foreign` } } }),
    };
    return {
      view,
      adapterCompacting: handle.isCompacting?.() === true,
      openControl: view?.openControl,
      openTurn: view?.openTurn ?? false,
      openToolCalls: view?.openToolCalls ?? -1,
      ownNative,
      identityMatches,
      exactBlockers,
      unownedBlockers: supervisor.pendingProducerBlockers(f.scene.request.jobId),
      mismatchedBlockers,
    };
  };
  let runError: unknown = null;
  try {
    const running = executeAcceptedDirective({ ...f.deps, pendingProducerBlockers: supervisor.pendingProducerBlockers.bind(supervisor) }, f.scene.request.requestId);
    await waitFor(() => rawCompaction.includes('compaction_start') && f.fx.script.calls.some((call) => isSummaryRequest(call.prompt)), 'held automatic compaction summary');
    const active = sample();
    expect(active).not.toBeNull();
    expect(active).toMatchObject({ openControl: true, openTurn: false, openToolCalls: 0, adapterCompacting: true, ownNative: true });
    expect(active?.exactBlockers.some((blocker) => blocker.includes('open turn/control/tool'))).toBe(true);
    expect(f.fx.script.calls.filter((call) => !isSummaryRequest(call.prompt))).toHaveLength(1);
    releaseSummary();
    try { await running; } catch (error) { runError = error; }

    // One preparation compacted; the second follows the post-compaction tool call.
    expect(preparations).toHaveLength(2);
    const afterPreparation = preparations[0]?.after;
    expect(afterPreparation, JSON.stringify({ rawCompaction, preparations, runError: String(runError) })).toMatchObject({
      openControl: false,
      openTurn: false,
      openToolCalls: 0,
      adapterCompacting: false,
      ownNative: true,
      exactBlockers: [],
      identityMatches: {
        sameRegisteredHandle: true,
        producerAgent: true,
        producerJob: true,
        acceptedIdentity: true,
        nativeTarget: true,
        producerSessionFile: true,
        bindingSession: true,
        pendingTurnIdentity: true,
        startedProducerReceipt: true,
      },
    });
    expect(rawCompaction).toEqual(['compaction_start', 'compaction_end']);
    // The adapter publishes the episode's successful terminal before the next model turn starts.
    expect(published.slice(published.indexOf('compaction_start'))).toEqual(['compaction_start', 'compaction_end:success', 'turn_start', 'turn_start']);
    expect(runError).toBeNull();

    expect(afterCompactionTurnStarts).toHaveLength(2);
    const continued = afterCompactionTurnStarts[0]!;
    expect(continued).toMatchObject({ openControl: false, openTurn: true, openToolCalls: 0, ownNative: true, exactBlockers: [] });
    expect(continued.unownedBlockers.some((blocker) => blocker.includes('open turn/control/tool'))).toBe(true);
    expect(Object.values(continued.mismatchedBlockers).every((blockers) => blockers.some((blocker) => blocker.includes('open turn/control/tool')))).toBe(true);

    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    expect(row).toMatchObject({ state: 'settled', payloadHash: f.scene.identity.payloadHash, workRevision: f.scene.identity.workRevision,
      contractSha256: f.scene.identity.contractSha256, authorityEpoch: f.scene.identity.authorityEpoch });
    expect(row.nativeBinding?.sessionId).toBe(currentOwner()?.producer.sessionId);
    const nativeSession = f.sessions[0]!;
    const admission = inspectDirectiveAdmission(row.nativeTarget!.sessionFile, f.scene.identity);
    expect(admission).toMatchObject({ identity: f.scene.identity, agentId: row.nativeTarget!.agentId, sessionId: nativeSession.sessionId });
    const checkpoint = inspectDirectiveCheckpoint(row.nativeTarget!.sessionFile, f.scene.identity);
    expect(checkpoint).toMatchObject({ state: 'terminal', ok: true, binding: row.nativeBinding });
    if (checkpoint.state !== 'terminal') throw new Error('original native completion must have a successful terminal checkpoint');
    const events = f.scene.ledger.listJobEvents(row.jobId, { limit: 100 });
    const producerStarts = events.filter((event) => event.kind === 'silas.directive-producer-started' &&
      (event.payload as { readonly request_id?: unknown } | undefined)?.request_id === row.requestId);
    expect(producerStarts).toHaveLength(1);
    const deliveries = f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])
      .filter((event) => (event.payload as { readonly request_id?: unknown } | undefined)?.request_id === row.requestId);
    expect(deliveries).toHaveLength(1);
    const producerRecords = readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line) as { readonly state: string; readonly producer?: DirectiveProducer; readonly checkpointId?: string; readonly head?: string | null });
    const originalProducer = currentOwner()?.producer;
    expect(originalProducer).toBeDefined();
    const starts = producerRecords.filter((record) => record.state === 'started' && isDeepStrictEqual(record.producer?.identity, f.scene.identity));
    expect(starts).toHaveLength(1);
    const completions = producerRecords.filter((record) => record.state === 'completed' && isDeepStrictEqual(record.producer?.identity, f.scene.identity));
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ producer: originalProducer, checkpointId: checkpoint.checkpointId,
      head: execFileSync('git', ['-C', f.scene.lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
    // Both native effects ran exactly once: before the compaction and after it.
    expect(readFileSync(join(f.scene.lane.path, 'compacted-native-effect.txt'), 'utf8')).toBe('once\nafter\n');
    const nativeRows = readFileSync(row.nativeTarget!.sessionFile, 'utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line) as { readonly type: string; readonly message?: { readonly role: string; readonly toolCallId?: string; readonly isError?: boolean } });
    expect(nativeRows.filter((entry) => entry.type === 'compaction')).toHaveLength(1);
    expect(nativeRows.filter((entry) => entry.message?.role === 'toolResult').map((entry) => [entry.message!.toolCallId, entry.message!.isError]))
      .toEqual([['compact-once', false], ['after-compaction', false]]);
    expect(producerRecords.filter((record) => record.state === 'guard-refused')).toEqual([]);
    expect(nativeSession.prompt).toHaveBeenCalledTimes(1);
    expect(f.fx.script.calls).toHaveLength(4);
    expect(f.sessions).toHaveLength(1);
  } finally {
    releaseSummary();
    supervisor.dispose();
    await f.cleanup();
  }
});

it('Pi post-run compaction after the directive terminal settles the original completion once', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  // The final reply's usage crosses the compaction threshold: Pi compacts after the run, before it settles.
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['history '.repeat(100)], usageTokens: 90_000 }, { deltas: ['post-run summary'] }]);
  writeFileSync(join(f.fx.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 64 } }));
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const rows = readFileSync(row.nativeTarget!.sessionFile, 'utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line) as { readonly type: string; readonly id: string; readonly parentId?: string | null; readonly message?: { readonly role: string; readonly stopReason?: string } });
    const [final, compaction] = rows.slice(-2);
    expect(final).toMatchObject({ type: 'message', message: { role: 'assistant', stopReason: 'stop' } });
    expect(compaction).toMatchObject({ type: 'compaction', parentId: final!.id });
    expect(f.fx.script.calls.map((call) => isSummaryRequest(call.prompt))).toEqual([false, true]);
    expect(inspectDirectiveCheckpoint(row.nativeTarget!.sessionFile, f.scene.identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: final!.id, binding: row.nativeBinding });
    expect(row.state).toBe('settled');
    const deliveries = f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])
      .filter((event) => (event.payload as { readonly request_id?: unknown } | undefined)?.request_id === row.requestId);
    expect(deliveries).toHaveLength(1);
    const completions = readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line) as { readonly state: string; readonly checkpointId?: string }).filter((record) => record.state === 'completed');
    expect(completions.map((record) => record.checkpointId)).toEqual([final!.id]);
    expect(f.sessions[0]!.prompt).toHaveBeenCalledTimes(1);
  } finally { await f.cleanup(); }
});

/** A real Supervisor over the fixture's registry: directive admission fences
 * consult its producer blockers, which an unpublished compaction keeps open. */
async function superviseDirectiveFixture(f: Awaited<ReturnType<typeof sdkDirectiveExecutionFixture>>) {
  const { Supervisor } = await import('../src/supervision/supervisor.js');
  const supervisor = new Supervisor({ config: { enabled: true, turnSilenceMs: 600000, restartWindowMs: 600000, maxRestarts: 3, restartBackoffMs: 10 },
    registry: f.registry, ledger: f.scene.ledger, notifications: f.scene.notifications, tickMs: 60000 });
  supervisor.start();
  return { supervisor, deps: { ...f.deps, pendingProducerBlockers: supervisor.pendingProducerBlockers.bind(supervisor) } };
}
/** The native transcript's entries, in file order. */
function nativeEntries(file: string) {
  return readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { readonly type: string; readonly id: string; readonly parentId?: string | null;
    readonly targetId?: string; readonly replacement?: unknown;
    readonly message?: { readonly role: string; readonly stopReason?: string; readonly toolCallId?: string; readonly isError?: boolean } });
}

it('Pi context-overflow compact-and-retry keeps the directive: the failed reply is history, a tool after the retry runs once, and it settles once', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const effect = (line: string) => `printf '${line}\\n' >> overflow-effect.txt`;
  const published: string[] = [];
  const f = await sdkDirectiveExecutionFixture([
    { deltas: ['history '.repeat(100)], toolCall: { id: 'before-overflow', name: 'bash', args: { command: effect('before') } } },
    // The provider rejects the next request as too long; the tool call in that failed reply never runs.
    { deltas: [], toolCall: { id: 'never-run', name: 'bash', args: { command: effect('never') } }, error: 'prompt is too long: 150000 tokens > 100000 maximum' },
    { deltas: ['overflow recovery summary'] },
    { deltas: [], toolCall: { id: 'after-retry', name: 'bash', args: { command: effect('after') } } },
    { deltas: ['completed after overflow recovery'] },
  ], (_session, spawned) => {
    spawned.subscribe((event) => {
      if (event.type === 'compaction_start') published.push(event.type);
      if (event.type === 'compaction_end') published.push(`compaction_end:${event.success ? 'success' : event.error ?? 'failed'}`);
      if (event.type === 'tool_start') published.push(`tool_start:${event.callId}`);
    });
  });
  writeFileSync(join(f.fx.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 64 } }));
  const { supervisor, deps } = await superviseDirectiveFixture(f);
  try {
    await executeAcceptedDirective(deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const rows = nativeEntries(row.nativeTarget!.sessionFile);
    const failed = rows.findIndex((entry) => entry.message?.stopReason === 'error');
    // Pi 1.x omits the failed reply from context with an edit, then compacts on it.
    expect(rows[failed + 1]).toMatchObject({ type: 'context_edit', parentId: rows[failed]!.id, targetId: rows[failed]!.id, replacement: null });
    expect(rows[failed + 2]).toMatchObject({ type: 'compaction', parentId: rows[failed + 1]!.id });
    expect(rows[failed + 3]).toMatchObject({ type: 'message', parentId: rows[failed + 2]!.id, message: { role: 'assistant', stopReason: 'toolUse' } });
    expect(readFileSync(join(f.scene.lane.path, 'overflow-effect.txt'), 'utf8')).toBe('before\nafter\n');
    // The compaction's terminal is published before the continued reply's tool
    // starts. No next-turn preparation precedes a continued reply's first call:
    // the microtask re-check at Pi's settle point gives this order.
    expect(published).toEqual(['tool_start:before-overflow', 'compaction_start', 'compaction_end:success', 'tool_start:after-retry']);
    expect(rows.filter((entry) => entry.message?.role === 'toolResult').map((entry) => [entry.message!.toolCallId, entry.message!.isError]))
      .toEqual([['before-overflow', false], ['after-retry', false]]);
    const final = rows.at(-1)!;
    expect(final).toMatchObject({ type: 'message', message: { role: 'assistant', stopReason: 'stop' } });
    expect(inspectDirectiveCheckpoint(row.nativeTarget!.sessionFile, f.scene.identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: final.id });
    expect(row.state).toBe('settled');
    expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])
      .filter((event) => (event.payload as { readonly request_id?: unknown } | undefined)?.request_id === row.requestId)).toHaveLength(1);
    expect(readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8')).not.toContain('guard-refused');
    expect(f.fx.script.calls.map((call) => isSummaryRequest(call.prompt))).toEqual([false, false, true, false, false]);
    expect(f.sessions[0]!.prompt).toHaveBeenCalledTimes(1);
  } finally { supervisor.dispose(); await f.cleanup(); }
});

it('Pi pre-prompt compaction publishes its terminal before the supervised directive\'s admission fences run', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  // The earlier reply crosses the threshold but its post-run summary fails, so
  // Pi compacts again inside the directive's prompt, before its first model call.
  const f = await sdkDirectiveExecutionFixture([
    { deltas: ['history '.repeat(100)], usageTokens: 90_000 },
    { deltas: [], error: 'summary provider failed' },
    { deltas: ['pre-prompt summary'] },
    { deltas: [], toolCall: { id: 'after-pre-prompt', name: 'bash', args: { command: "printf 'once\\n' >> pre-prompt-effect.txt" } } },
    { deltas: ['completed after pre-prompt compaction'] },
  ]);
  writeFileSync(join(f.fx.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 64 } }));
  const { supervisor, deps } = await superviseDirectiveFixture(f);
  const published: string[] = [];
  try {
    const minion = await f.registry.spawn('minion', { cwd: f.scene.lane.path, agentId: 'pre-prompt-supervised-minion' });
    minion.subscribe((event) => {
      if (event.type === 'compaction_start' || event.type === 'tool_start') published.push(event.type);
      if (event.type === 'compaction_end') published.push(`compaction_end:${event.success ? 'success' : event.error ?? 'failed'}`);
    });
    await minion.prompt('earlier ordinary work');
    await waitFor(() => minion.isCompacting?.() === false, 'failed post-run compaction terminal');
    published.length = 0; // only the directive's own episode
    await executeAcceptedDirective(deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    expect(row.nativeTarget?.agentId).toBe(minion.id);
    const rows = nativeEntries(minion.sessionFile!);
    const user = rows.findIndex((entry) => entry.id === row.nativeBinding?.userEntryId);
    expect(rows[user - 1]).toMatchObject({ type: 'compaction', parentId: row.nativeBinding!.baseline });
    expect(published).toEqual(['compaction_start', 'compaction_end:success', 'tool_start']);
    expect(readFileSync(join(f.scene.lane.path, 'pre-prompt-effect.txt'), 'utf8')).toBe('once\n');
    expect(inspectDirectiveCheckpoint(minion.sessionFile!, f.scene.identity)).toMatchObject({ state: 'terminal', ok: true });
    expect(row.state).toBe('settled');
    expect(readFileSync(`${minion.sessionFile!}.producers.jsonl`, 'utf8')).not.toContain('guard-refused');
  } finally { supervisor.dispose(); await f.cleanup(); }
});

it('a failed Pi pre-prompt compaction publishes its terminal before the supervised directive\'s admission fences run', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  // Both summaries fail: after the earlier reply, and again before the
  // directive's prompt. Pi awaits its failure hook before its gate clears.
  const f = await sdkDirectiveExecutionFixture([
    { deltas: ['history '.repeat(100)], usageTokens: 90_000 },
    { deltas: [], error: 'summary provider failed' },
    { deltas: [], error: 'pre-prompt summary provider failed' },
    { deltas: [], toolCall: { id: 'after-failed-compaction', name: 'bash', args: { command: "printf 'once\\n' >> failed-compaction-effect.txt" } } },
    { deltas: ['completed after a failed pre-prompt compaction'] },
  ]);
  writeFileSync(join(f.fx.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 64 } }));
  const { supervisor, deps } = await superviseDirectiveFixture(f);
  const published: string[] = [];
  try {
    const minion = await f.registry.spawn('minion', { cwd: f.scene.lane.path, agentId: 'failed-pre-prompt-minion' });
    minion.subscribe((event) => {
      if (event.type === 'compaction_start' || event.type === 'tool_start') published.push(event.type);
      if (event.type === 'compaction_end') published.push(`compaction_end:${event.success ? 'success' : event.error ?? 'failed'}`);
    });
    await minion.prompt('earlier ordinary work');
    await waitFor(() => minion.isCompacting?.() === false, 'failed post-run compaction terminal');
    published.length = 0; // only the directive's own episode
    await executeAcceptedDirective(deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    expect(published).toEqual(['compaction_start', expect.stringMatching(/^compaction_end:.*pre-prompt summary provider failed/u), 'tool_start']);
    expect(row.nativeTarget?.agentId).toBe(minion.id);
    // The failed compaction wrote no entry: the receipt follows the baseline.
    const rows = nativeEntries(minion.sessionFile!);
    expect(rows.find((entry) => entry.id === row.nativeBinding?.userEntryId)).toMatchObject({ parentId: row.nativeBinding!.baseline });
    expect(readFileSync(join(f.scene.lane.path, 'failed-compaction-effect.txt'), 'utf8')).toBe('once\n');
    expect(inspectDirectiveCheckpoint(minion.sessionFile!, f.scene.identity)).toMatchObject({ state: 'terminal', ok: true });
    expect(row.state).toBe('settled');
    expect(readFileSync(`${minion.sessionFile!}.producers.jsonl`, 'utf8')).not.toContain('guard-refused');
  } finally { supervisor.dispose(); await f.cleanup(); }
});

it('Pi pre-prompt compaction before a directive receipt is admitted and the directive completes', async () => {
  const { inspectDirectiveAdmission, inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  let summaries = 0;
  // The earlier reply crosses the threshold but its post-run summary fails, so
  // Pi compacts again before the next prompt: after the directive's baseline.
  const f = await fixture((prompt, index) => {
    if (isSummaryRequest(prompt)) return summaries++ === 0 ? { deltas: [], error: 'summary provider failed' } : { deltas: ['pre-prompt summary'] };
    return index === 0 ? { deltas: ['history '.repeat(100)], usageTokens: 90_000 } : { deltas: ['directive done'] };
  });
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 64 } }));
  const scene = await directiveRecoveryLedgerFixture('pre-prompt-compaction');
  const handle = await f.runtime.spawn('minion', { cwd: scene.lane.path, agentId: 'pre-prompt-compaction-minion' });
  scene.ledger.registerAgent({ id: handle.id, role: 'minion', jobId: scene.request.jobId, sessionFile: handle.sessionFile });
  scene.ledger.setAgentState(handle.id, 'idle');
  try {
    await handle.prompt('earlier ordinary work');
    await waitFor(() => handle.isCompacting?.() === false, 'failed post-run compaction terminal');
    const baseline = (JSON.parse(readFileSync(handle.sessionFile!, 'utf8').trimEnd().split('\n').at(-1)!) as { readonly id: string }).id;
    scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
    const verdict = await handle.promptWithVerdict!('approved directive', { directive: { identity: scene.identity,
      beforeAdmission: () => scene.ledger.assertDirectiveAuthority(scene.identity),
      onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } } });
    expect(verdict).toEqual({ ok: true, error: null });
    const rows = readFileSync(handle.sessionFile!, 'utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line) as { readonly type: string; readonly id: string; readonly parentId?: string | null; readonly message?: { readonly role: string } });
    const at = rows.findIndex((entry) => entry.id === baseline);
    const [compaction, user, final] = rows.slice(at + 1);
    expect(compaction).toMatchObject({ type: 'compaction', parentId: baseline });
    expect(user).toMatchObject({ type: 'message', parentId: compaction!.id, message: { role: 'user' } });
    expect(rows.slice(at + 4)).toEqual([]);
    const admission = inspectDirectiveAdmission(handle.sessionFile!, scene.identity);
    expect(admission).toMatchObject({ baseline, userEntryId: user!.id });
    expect(scene.ledger.getDirective(scene.request.requestId)).toMatchObject({ state: 'admitted', nativeBinding: admission });
    expect(inspectDirectiveCheckpoint(handle.sessionFile!, scene.identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: final!.id });
    expect(f.script.calls.map((call) => isSummaryRequest(call.prompt) ? 'summary' : call.prompt)).toEqual(['earlier ordinary work', 'summary', 'summary', 'approved directive']);
  } finally { await handle.dispose(); await f.runtime.dispose(); f.store.dispose(); scene.db.close(); scene.repo.cleanup(); }
});

/** Preparation waits for a compaction terminal the adapter withholds while
 * Pi's compaction state does not settle; the run's abort, disposal, or the
 * reconcile deadline (which disposes) ends that wait with its own refusal
 * and no further model request. */
async function assertCompactionWaitCancelled(by: 'abort' | 'dispose' | 'deadline') {
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  const f = await fixture([
    { deltas: ['history '.repeat(100)], toolCall: { id: 'before-wait', name: 'bash', args: { command: "printf 'once\\n' >> wait-effect.txt" } }, usageTokens: 90_000 },
    { deltas: ['automatic compaction summary'] },
    { deltas: ['never requested'] },
  ]);
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 64 } }));
  const scene = await directiveRecoveryLedgerFixture(`compaction-wait-${by}`);
  const handle = await f.runtime.spawn('minion', { cwd: scene.lane.path, agentId: `compaction-wait-${by}-minion` });
  const session = await actualDirectiveSdkSession(handle); session.agent.toolExecution = 'sequential';
  scene.ledger.registerAgent({ id: handle.id, role: 'minion', jobId: scene.request.jobId, sessionFile: handle.sessionFile });
  scene.ledger.setAgentState(handle.id, 'idle');
  scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
  // After its terminal event, Pi's compaction state stays set: a native gate that does not settle.
  const nativeCompacting = Object.getOwnPropertyDescriptor(AgentSession.prototype, 'isCompacting')!.get!;
  let held = false;
  Object.defineProperty(session, 'isCompacting', { configurable: true, get: () => held || nativeCompacting.call(session) });
  session.subscribe((event) => { if (event.type === 'compaction_end') held = true; });
  const events = collect(handle);
  // The deadline published its failed terminal; the gate then opens so disposal can prove native quiescence.
  if (by === 'deadline') handle.subscribe((event) => { if (event.type === 'compaction_end') held = false; });
  // Synchronization only: preparation has registered its wait for the withheld terminal.
  const waiters = (handle as unknown as { readonly compactionTerminalWaiters: ReadonlySet<unknown> }).compactionTerminalWaiters;
  let clock: { mockRestore(): void } | null = null;
  try {
    const turn = handle.promptWithVerdict!('approved directive', { directive: { identity: scene.identity,
      beforeAdmission: () => scene.ledger.assertDirectiveAuthority(scene.identity),
      onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } } });
    await waitFor(() => waiters.size === 1, 'next-turn preparation waiting for the withheld compaction terminal');
    let disposing: Promise<void> | null = null;
    if (by === 'abort') session.agent.abort();
    else if (by === 'dispose') { disposing = handle.dispose(); held = false; }
    else {
      // The gate stays closed past the reconcile bound: the next poll publishes a failed terminal and disposes.
      const now = Date.now.bind(Date);
      clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + COMPACTION_END_RECONCILE_MS);
    }
    const verdict = await turn;
    clock?.mockRestore(); clock = null;
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('native directive ownership cancelled while its compaction terminal was pending');
    expect(waiters.size).toBe(0);
    // Abort: the turn settled while the terminal was still withheld. Dispose and the deadline publish it as failed.
    expect(events.filter((event) => event.type === 'compaction_end')).toEqual(by === 'abort' ? [] :
      [{ type: 'compaction_end', success: false, error: by === 'dispose' ? 'agent session disposed during native compaction' : 'native compaction state did not settle after its terminal event' }]);
    expect(f.script.calls.map((call) => isSummaryRequest(call.prompt))).toEqual([false, true]);
    expect(readFileSync(join(scene.lane.path, 'wait-effect.txt'), 'utf8')).toBe('once\n');
    const refusals = readFileSync(`${handle.sessionFile!}.producers.jsonl`, 'utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line) as { readonly state: string; readonly boundary?: string; readonly reason?: string }).filter((record) => record.state === 'guard-refused');
    expect(refusals).toEqual([expect.objectContaining({ boundary: 'authority', reason: expect.stringContaining('cancelled while its compaction terminal was pending') })]);
    expect(inspectDirectiveCheckpoint(handle.sessionFile!, scene.identity)).toEqual({ state: 'unknown', reason: 'native directive execution/authority boundary refused; exact turn remains incomplete' });
    held = false;
    if (by === 'abort') {
      await waitFor(() => events.some((event) => event.type === 'compaction_end'), 'compaction terminal once the native gate settles');
      expect(events.filter((event) => event.type === 'compaction_end')).toEqual([{ type: 'compaction_end', success: true }]);
    }
    await (disposing ?? handle.dispose());
    expect(handle.cessationEvidence!()).toBe('ceased');
    expect(f.store.isHeld(handle.sessionFile!)).toBe(false);
  } finally { clock?.mockRestore(); held = false; await handle.dispose(); await f.runtime.dispose(); f.store.dispose(); scene.db.close(); scene.repo.cleanup(); }
}
/** At the directive's admission (preflight), before Pi writes a receipt, the
 * directive is refused when the pre-prompt compaction terminal is still
 * withheld by Pi's gate, when the reconcile bound disposed the handle (before
 * preflight, or in admission's own flush), or when a compaction is still
 * running with no terminal yet. */
async function assertPreflightRefused(by: 'withheld' | 'disposed' | 'disposed-at-admission' | 'running') {
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  const { DirectiveCheckpointError, readDirectiveBinding } = await import('../src/runtime/directive-checkpoint.js');
  let summaries = 0; let replies = 0;
  const f = await fixture((prompt) => {
    if (isSummaryRequest(prompt)) return summaries++ === 0 ? { deltas: [], error: 'summary provider failed' } : { deltas: ['pre-prompt summary'] };
    return [{ deltas: ['history '.repeat(100)], usageTokens: 90_000 }][replies++] ?? { deltas: ['directive reply that must never be requested'] };
  });
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 64 } }));
  const scene = await directiveRecoveryLedgerFixture(`preflight-${by}`);
  const handle = await f.runtime.spawn('minion', { cwd: scene.lane.path, agentId: `preflight-${by}-minion` });
  const session = await actualDirectiveSdkSession(handle);
  const internal = handle as unknown as { onPiEvent(event: unknown): void };
  scene.ledger.registerAgent({ id: handle.id, role: 'minion', jobId: scene.request.jobId, sessionFile: handle.sessionFile });
  scene.ledger.setAgentState(handle.id, 'idle');
  scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
  // After the directive's pre-prompt terminal, Pi's compaction gate stays set.
  const nativeCompacting = Object.getOwnPropertyDescriptor(AgentSession.prototype, 'isCompacting')!.get!;
  let armed = false; let held = false;
  let clock: { mockRestore(): void } | null = null;
  Object.defineProperty(session, 'isCompacting', { configurable: true, get: () => held || nativeCompacting.call(session) });
  session.subscribe((event) => {
    if (!armed || event.type !== 'compaction_end' || by === 'running') return;
    held = true;
    if (by === 'disposed') {
      // Past the reconcile bound by the next re-check: it publishes a failed terminal and disposes.
      const now = Date.now.bind(Date);
      clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + COMPACTION_END_RECONCILE_MS);
    }
  });
  if (by === 'disposed-at-admission' || by === 'running') {
    // Act as Pi hands over to the run (agent.prompt, after its preparation and
    // compaction): the bound is crossed there, so admission's own flush is the
    // first re-check past it; or a compaction starts there.
    const nativePrompt = session.agent.prompt.bind(session.agent);
    session.agent.prompt = (async (...args: Parameters<typeof nativePrompt>) => {
      if (armed && by === 'running') internal.onPiEvent({ type: 'compaction_start' });
      if (armed && by === 'disposed-at-admission') {
        const now = Date.now.bind(Date);
        clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + COMPACTION_END_RECONCILE_MS);
      }
      return nativePrompt(...args);
    }) as typeof nativePrompt;
  }
  const events = collect(handle);
  // Once the bound published its failed terminal the gate opens, so disposal can prove quiescence.
  if (by === 'disposed' || by === 'disposed-at-admission') handle.subscribe((event) => { if (event.type === 'compaction_end') held = false; });
  try {
    await handle.prompt('earlier ordinary work');
    await waitFor(() => handle.isCompacting?.() === false, 'failed post-run compaction terminal');
    events.length = 0;
    armed = true;
    const turn = handle.promptWithVerdict!('approved directive', { directive: { identity: scene.identity,
      beforeAdmission: () => scene.ledger.assertDirectiveAuthority(scene.identity),
      onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } } });
    const refusal = new DirectiveCheckpointError(by === 'withheld' ? 'native compaction terminal still withheld at directive admission'
      : by === 'running' ? 'native compaction still running at directive admission' : 'native directive owner disposed during prompt preparation');
    await expect(turn).rejects.toThrow(refusal);
    (clock as { mockRestore(): void } | null)?.mockRestore(); clock = null;
    // GC's own refusal, never a provider's (#485); a disposed owner reports nothing.
    expect(events.filter((event) => event.type === 'error')).toEqual(by === 'withheld' || by === 'running'
      ? [{ type: 'error', error: String(refusal), fatal: false, nativeControl: 'directive-refusal' }] : []);
    // Not admitted: no receipt, no directive model request.
    const rows = readFileSync(handle.sessionFile!, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { readonly message?: { readonly role: string } });
    expect(rows.filter((entry) => entry.message?.role === 'user')).toHaveLength(1);
    expect(readDirectiveBinding(handle.sessionFile!, scene.identity.requestId)?.userEntryId).toBeNull();
    expect(scene.ledger.getDirective(scene.request.requestId)?.nativeBinding).toBeNull();
    expect(replies).toBe(1);
    if (by === 'withheld') {
      held = false;
      await waitFor(() => events.some((event) => event.type === 'compaction_end'), 'the withheld terminal once Pi\'s gate clears');
      expect(events.filter((event) => event.type === 'compaction_end')).toEqual([{ type: 'compaction_end', success: true }]);
      expect(handle.health().state).not.toBe('disposed');
    } else if (by === 'running') {
      // The pre-prompt terminal published; the running one ends later and publishes too.
      internal.onPiEvent({ type: 'compaction_end' });
      await waitFor(() => events.filter((event) => event.type === 'compaction_end').length === 2, 'the running compaction\'s terminal');
      expect(events.filter((event) => event.type === 'compaction_end')).toEqual([{ type: 'compaction_end', success: true }, { type: 'compaction_end', success: true }]);
      expect(handle.health().state).not.toBe('disposed');
    } else {
      expect(events.filter((event) => event.type === 'compaction_end')).toEqual([{ type: 'compaction_end', success: false, error: 'native compaction state did not settle after its terminal event' }]);
      await handle.dispose();
      expect(handle.cessationEvidence!()).toBe('ceased');
    }
  } finally { (clock as { mockRestore(): void } | null)?.mockRestore(); held = false; await handle.dispose(); await f.runtime.dispose(); f.store.dispose(); scene.db.close(); scene.repo.cleanup(); }
}
it('a directive is refused at admission while Pi\'s gate still withholds its pre-prompt compaction terminal, before any receipt', () => assertPreflightRefused('withheld'));
it('a directive is refused at admission when the reconcile bound disposed its owner during prompt preparation, before any receipt', () => assertPreflightRefused('disposed'));
it('a directive is refused when admission\'s own flush crosses the reconcile bound and disposes its owner, before any receipt', () => assertPreflightRefused('disposed-at-admission'));
it('a directive is refused at admission while a compaction is still running with no terminal, before any receipt', () => assertPreflightRefused('running'));
it('a directive abort during the compaction terminal wait refuses at once, without another model request', () => assertCompactionWaitCancelled('abort'));
it('disposal during the compaction terminal wait refuses at once and releases native ownership', () => assertCompactionWaitCancelled('dispose'));
it('a compaction terminal that never settles ends the waiting preparation at the reconcile deadline with a refusal', () => assertCompactionWaitCancelled('deadline'));

/** A directive whose compact-and-retry compaction terminal is still withheld
 * (Pi's gate held) when Pi starts its next mid-run compaction: the adapter
 * folds that start into the open episode and publishes one terminal. */
async function assertJoinedCompaction(scenario: 'held-preparation' | 'past-deadline') {
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  let releaseJoinedSummary!: () => void;
  const joinedSummaryHold = new Promise<void>((resolveHold) => { releaseJoinedSummary = resolveHold; });
  let summaries = 0; let replies = 0; let joinedSummaryStarted = false;
  const f = await fixture((prompt) => {
    if (isSummaryRequest(prompt)) {
      if (summaries++ === 1 && scenario === 'past-deadline') { joinedSummaryStarted = true; return { deltas: ['automatic summary'], hold: joinedSummaryHold }; }
      return { deltas: ['automatic summary'] };
    }
    return [
      { deltas: ['history '.repeat(100)], toolCall: { id: 'before-overflow', name: 'bash', args: { command: "printf 'before\\n' >> held-effect.txt" } } },
      // The provider rejects the next request as too long: Pi compacts and continues.
      { deltas: [], error: 'prompt is too long: 150000 tokens > 100000 maximum' },
      { deltas: ['history '.repeat(100)], toolCall: { id: 'during-hold', name: 'bash', args: { command: "printf 'once\\n' >> held-effect.txt" } }, usageTokens: 90_000 },
      { deltas: ['completed after both compactions'] },
    ][replies++] ?? { deltas: ['unexpected extra reply'] };
  });
  writeFileSync(join(f.agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 64 } }));
  const scene = await directiveRecoveryLedgerFixture(`joined-compaction-${scenario}`);
  const handle = await f.runtime.spawn('minion', { cwd: scene.lane.path, agentId: `joined-compaction-${scenario}-minion` });
  const session = await actualDirectiveSdkSession(handle); session.agent.toolExecution = 'sequential';
  scene.ledger.registerAgent({ id: handle.id, role: 'minion', jobId: scene.request.jobId, sessionFile: handle.sessionFile });
  scene.ledger.setAgentState(handle.id, 'idle');
  scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: handle.id, sessionFile: handle.sessionFile! });
  // Pi's compaction gate stays set after the compact-and-retry terminal, so
  // the adapter still withholds it when Pi starts the mid-run compaction.
  const nativeCompacting = Object.getOwnPropertyDescriptor(AgentSession.prototype, 'isCompacting')!.get!;
  let held = false; let nativeEnds = 0;
  Object.defineProperty(session, 'isCompacting', { configurable: true, get: () => held || nativeCompacting.call(session) });
  session.subscribe((event) => { if (event.type === 'compaction_end') { held = true; nativeEnds += 1; } });
  // Outside the adapter's wrapper: whether the adapter still reported compaction when the compacting preparation returned.
  let compactingAfterPreparation: boolean | null = null;
  const prepare = session.agent.prepareNextTurnWithContext!.bind(session.agent);
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const update = await prepare(turn, signal);
    if (nativeEnds === 2) compactingAfterPreparation ??= handle.isCompacting!();
    return update;
  };
  const events = collect(handle);
  // Synchronization only: preparation has registered its wait for the withheld terminal.
  const waiters = (handle as unknown as { readonly compactionTerminalWaiters: ReadonlySet<unknown> }).compactionTerminalWaiters;
  let clock: { mockRestore(): void } | null = null;
  try {
    const turn = handle.promptWithVerdict!('approved directive', { directive: { identity: scene.identity,
      beforeAdmission: () => scene.ledger.assertDirectiveAuthority(scene.identity),
      onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); } } });
    if (scenario === 'past-deadline') {
      // The joined summary outlasts the first terminal's reconcile bound: the
      // joined start disarmed it, so the polls publish nothing and keep the session.
      await waitFor(() => joinedSummaryStarted, 'the joined compaction summary in flight');
      const polls = vi.spyOn(handle as unknown as { flushCompactionEndWhenSettled(): void }, 'flushCompactionEndWhenSettled');
      const now = Date.now.bind(Date);
      clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + COMPACTION_END_RECONCILE_MS);
      await waitFor(() => polls.mock.calls.length >= 2, 'withheld-terminal polls past the first episode\'s reconcile bound');
      expect(events.filter((event) => event.type === 'compaction_end')).toEqual([]);
      clock.mockRestore(); clock = null; polls.mockRestore();
      releaseJoinedSummary();
    }
    await waitFor(() => nativeEnds === 2 && waiters.size === 1, 'next-turn preparation waiting after both native compactions');
    expect(compactingAfterPreparation).toBeNull();
    // The second native start joined the open episode: one start, nothing published yet.
    expect(events.filter((event) => event.type === 'compaction_start' || event.type === 'compaction_end').map((event) => event.type)).toEqual(['compaction_start']);
    held = false;
    expect(await turn).toEqual({ ok: true, error: null });
    expect(compactingAfterPreparation).toBe(false);
    expect(events.filter((event) => event.type === 'compaction_end')).toEqual([{ type: 'compaction_end', success: true }]);
    expect(handle.health().state).not.toBe('disposed');
    expect(readFileSync(join(scene.lane.path, 'held-effect.txt'), 'utf8')).toBe('before\nonce\n');
    expect(replies).toBe(4);
  } finally { clock?.mockRestore(); releaseJoinedSummary(); held = false; await handle.dispose(); await f.runtime.dispose(); f.store.dispose(); scene.db.close(); scene.repo.cleanup(); }
}
it('a compaction Pi starts while an earlier terminal is still withheld holds next-turn preparation until it publishes', () => assertJoinedCompaction('held-preparation'));
it('a joined compaction running past the first terminal\'s reconcile bound publishes its real terminal and the session lives', () => assertJoinedCompaction('past-deadline'));

/** Pi's own compaction events into one open episode, its terminal held back
 * by Pi's gate: the joined episode publishes one terminal once the gate opens. */
async function assertJoinedTerminal(outcomes: readonly ('success' | 'failure' | 'aborted')[], expected: Extract<RuntimeEvent, { type: 'compaction_end' }>,
  droppedFailures: readonly string[] = []) {
  const dropped: unknown[] = [];
  const f = await fixture([{ deltas: ['primed'] }], ['text'], { log: (level, msg, fields) => {
    if (level === 'warn' && msg === 'joined native compaction failure not published') dropped.push(fields?.['error']);
  } });
  const handle = await f.runtime.spawn('gru');
  const session = await actualDirectiveSdkSession(handle);
  const internal = handle as unknown as { onPiEvent(event: unknown): void };
  const events = collect(handle);
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  const nativeCompacting = Object.getOwnPropertyDescriptor(AgentSession.prototype, 'isCompacting')!.get!;
  let held = true;
  try {
    await handle.prompt('prime');
    Object.defineProperty(session, 'isCompacting', { configurable: true, get: () => held || nativeCompacting.call(session) });
    for (const [index, outcome] of outcomes.entries()) {
      internal.onPiEvent({ type: 'compaction_start' });
      internal.onPiEvent({ type: 'compaction_end', aborted: outcome === 'aborted',
        ...(outcome === 'failure' ? { errorMessage: `Auto-compaction failed: summary ${index} failed` } : {}) });
    }
    expect(events.filter((event) => event.type === 'compaction_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'compaction_end')).toEqual([]);
    held = false;
    await waitFor(() => events.some((event) => event.type === 'compaction_end'), 'the joined terminal once Pi\'s gate opens');
    expect(events.filter((event) => event.type === 'compaction_end')).toEqual([expected]);
    // A failure the join did not publish is still logged.
    expect(dropped).toEqual(droppedFailures);
  } finally { held = false; await handle.dispose(); await f.runtime.dispose(); f.store.dispose(); }
}
it('a joined compaction episode publishes one terminal: a later written summary wins over an earlier failure', () =>
  assertJoinedTerminal(['failure', 'success'], { type: 'compaction_end', success: true }, ['Auto-compaction failed: summary 0 failed']));
it('a joined compaction episode publishes one terminal: an earlier written summary wins over a later failure', () =>
  assertJoinedTerminal(['success', 'failure'], { type: 'compaction_end', success: true }, ['Auto-compaction failed: summary 1 failed']));
it('a joined compaction episode with no summary publishes a failure\'s own error, never a later cancel\'s', () =>
  assertJoinedTerminal(['failure', 'aborted'], { type: 'compaction_end', success: false, error: 'Auto-compaction failed: summary 0 failed' }));
it('a joined compaction episode with no summary publishes the first failure, the root cause, and logs the later one', () =>
  assertJoinedTerminal(['failure', 'failure'], { type: 'compaction_end', success: false, error: 'Auto-compaction failed: summary 0 failed' }, ['Auto-compaction failed: summary 1 failed']));
it('a joined compaction episode keeps a written summary over a later cancel', () =>
  assertJoinedTerminal(['success', 'aborted'], { type: 'compaction_end', success: true }));
it('a compaction cancelled with no later attempt publishes compaction aborted', () =>
  assertJoinedTerminal(['aborted'], { type: 'compaction_end', success: false, error: 'compaction aborted' }));
it('a joined compaction episode publishes a later failure over an earlier cancel', () =>
  assertJoinedTerminal(['aborted', 'failure'], { type: 'compaction_end', success: false, error: 'Auto-compaction failed: summary 1 failed' }));

it('restart recovery continues a directive the host lost right after Pi\'s mid-run compaction: one model call, the earlier effect never re-run', async () => {
  const { DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['completed after the compacted checkpoint'] }]);
  let service: InstanceType<typeof DirectiveProgressService> | null = null;
  let compaction = '';
  try {
    // The ceased host's persisted round: its bash effect ran once, then Pi
    // compacted, and the host died before the next model call.
    const seeded = await seedSdkUserCheckpoint(f, (session, receipt) => {
      const call = { type: 'toolCall', id: 'before-crash', name: 'bash', arguments: { command: "printf 'once\\n' >> resumed-effect.txt" } };
      session.sessionManager.appendMessage({ role: 'assistant', content: [call], api: 'gru-stub', provider: 'gru-stub', model: 'stub-model', stopReason: 'toolUse', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
      session.sessionManager.appendMessage({ role: 'toolResult', toolCallId: 'before-crash', toolName: 'bash', content: [{ type: 'text', text: '' }], isError: false, timestamp: Date.now() } as never);
      writeFileSync(join(f.scene.lane.path, 'resumed-effect.txt'), 'once\n');
      compaction = session.sessionManager.appendCompaction('summary of the interrupted turn', receipt, 90_000, undefined, false);
    });
    expect(seeded.proof).toMatchObject({ state: 'resumable', checkpointId: compaction });
    service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    expect(row.state).toBe('settled');
    expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])
      .filter((event) => (event.payload as { readonly request_id?: unknown } | undefined)?.request_id === row.requestId)).toHaveLength(1);
    expect(f.fx.script.calls).toHaveLength(1);
    expect(readFileSync(join(f.scene.lane.path, 'resumed-effect.txt'), 'utf8')).toBe('once\n');
    const resumed = f.sessions.at(-1)!;
    expect(resumed.prompt).not.toHaveBeenCalled();
    expect(resumed.agent.continue).toHaveBeenCalledTimes(1);
    const final = nativeEntries(row.nativeTarget!.sessionFile).at(-1)!;
    expect(final).toMatchObject({ type: 'message', parentId: compaction, message: { role: 'assistant', stopReason: 'stop' } });
    expect(inspectDirectiveCheckpoint(row.nativeTarget!.sessionFile, f.scene.identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: final.id });
  } finally { await service?.dispose(); await f.cleanup(); }
});

/** `afterReceipt` writes, through the same SDK primitives, what the original
 * host persisted after the receipt before it ceased. */
async function seedSdkUserCheckpoint(f: Awaited<ReturnType<typeof sdkDirectiveExecutionFixture>>,
  afterReceipt?: (session: Awaited<ReturnType<typeof actualDirectiveSdkSession>>, receipt: string) => void) {
  const { prepareDirectiveBinding, inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const original = await f.registry.spawn('minion', { cwd: f.scene.lane.path, agentId: 'guarded-original-minion' });
  const session = await actualDirectiveSdkSession(original);
  const lockOwner = JSON.parse(readFileSync(`${original.sessionFile!}.lock`, 'utf8')) as { host?: string; pid: number; bootId: string };
  expect(f.fx.store.isHeld(original.sessionFile!)).toBe(true);
  const identity = f.scene.identity;
  f.scene.ledger.claimDirectiveDispatch(identity.requestId);
  f.scene.ledger.prepareDirectiveTarget(identity.requestId, { agentId: original.id, sessionFile: original.sessionFile! });
  const producer = original.prepareDirectiveProducer!(identity);
  const start = f.scene.ledger.startDirectiveProducer(identity, producer);
  const authority = (original as unknown as { directiveAuthorityManifest(): string }).directiveAuthorityManifest();
  const text = 'original approved native user checkpoint';
  prepareDirectiveBinding({ identity, runtime: 'pi', agentId: original.id, sessionId: session.sessionId,
    sessionFile: original.sessionFile!, text, authorityManifest: authority });
  // Accountable checkpoint fixture: the SDK's public persistence primitive
  // writes the original user receipt. No model, effects or terminal is forged.
  // Pi 1.x persists the session's prompt and tool declarations as a system
  // message directly ahead of the first prompt, so a real host that ceased
  // after its receipt left that entry before it.
  session.sessionManager.appendMessage(persistedSystemMessage(session));
  const receipt = session.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
  afterReceipt?.(session, receipt);
  const proof = inspectDirectiveCheckpoint(original.sessionFile!, identity);
  if (proof.state !== 'resumable') throw new Error('SDK user fixture did not produce a resumable checkpoint');
  f.scene.ledger.bindDirectiveNativeAdmission(proof.binding);
  await f.registry.disposeHandle(original); // genuine original native cessation
  f.scene.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: identity.jobId, payload: {
    request_id: identity.requestId, producer_start_seq: start, producer_identity: identity, native_producer: producer,
    agent_id: original.id, session_file: original.sessionFile,
  } });
  return { original, proof, lockOwner, prefix: readFileSync(original.sessionFile!, 'utf8') };
}

async function assertGuardedSdkDelivery(resume: boolean) {
  const { executeAcceptedDirective, DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  const f = await sdkDirectiveExecutionFixture(guardedSdkTools);
  let service: InstanceType<typeof DirectiveProgressService> | null = null;
  try {
    const seeded = resume ? await seedSdkUserCheckpoint(f) : null;
    const spawn = vi.spyOn(f.registry, 'spawn');
    if (resume) { service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); }
    else await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const entries = readFileSync(row.nativeTarget!.sessionFile, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { message?: { role: string; toolCallId?: string; isError?: boolean } });
    const results = entries.filter((entry) => entry.message?.role === 'toolResult');
    expect(row.state, `Native SDK tool evidence: ${JSON.stringify(results)}`).toBe('settled');
    expect(readFileSync(join(f.scene.lane.path, 'guarded-effects.txt'), 'utf8')).toBe('first\nsecond\n');
    expect(f.toolStates).toEqual(['streaming', 'streaming']); expect(f.states).toContain('streaming');
    expect(f.scene.ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId)?.payload).toMatchObject({ request_id: row.requestId, agentId: row.nativeTarget!.agentId });
    expect(f.fx.script.calls).toHaveLength(2); expect(spawn).toHaveBeenCalledTimes(1);
    expect(f.sessions.at(-1)!.prompt).toHaveBeenCalledTimes(resume ? 0 : 1);
    expect(f.sessions.at(-1)!.agent.continue).toHaveBeenCalledTimes(resume ? 1 : 0);
    expect(results.map((entry) => [entry.message!.toolCallId, entry.message!.isError])).toEqual([['guarded-first', false], ['guarded-second', false]]);
    if (seeded !== null) {
      expect(spawn.mock.calls[0]![1]).toMatchObject({ resumeFile: seeded.original.sessionFile, agentId: seeded.original.id, cwd: f.scene.lane.path });
      expect(row.nativeBinding).toEqual(seeded.proof.binding);
      expect(readFileSync(row.nativeTarget!.sessionFile, 'utf8').startsWith(seeded.prefix)).toBe(true);
      expect(entries.filter((entry) => entry.message?.role === 'user')).toHaveLength(1);
      service!.reconsider(); await service!.settled(); expect(spawn).toHaveBeenCalledTimes(1);
    }
    expect(f.scene.worktrees.listWorktrees({ jobId: row.jobId })).toEqual([f.scene.lane]);
  } finally { await service?.dispose(); await f.cleanup(); }
}
it('production shared executor permits only its exact streaming SDK producer to run two native tools and deliver #contract:native-directive-admission:pi', () => assertGuardedSdkDelivery(false));
it('production checkpoint callback permits its exact streaming SDK producer to run two native tools without prompt replay', () => assertGuardedSdkDelivery(true));

async function assertProductionSdkFence(resume: boolean, fault: 'model-await' | 'prior-hook-await' | 'branch-model-await' | 'branch-hook' | 'foreign-streaming' | 'manifest-model' | 'manifest-role' | 'manifest-hook' | 'manifest-tools' | 'manifest-role-hook' | 'manifest-model-hook' | 'manifest-execution-mode') {
  const hook = fault === 'prior-hook-await' || fault.endsWith('-hook');
  const manifest = fault.startsWith('manifest-');
  const { executeAcceptedDirective, DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  let release!: () => void; const hold = new Promise<void>((resolveGate) => { release = resolveGate; });
  let reached!: () => void; const boundary = new Promise<void>((resolveGate) => { reached = resolveGate; });
  const first = guardedSdkTools[0]!;
  const f = await sdkDirectiveExecutionFixture([
    { ...first, ...(!hook ? { hold, honorAbort: true } : {}) }, guardedSdkTools[1]!,
  ], (session) => {
    if (!hook) return;
    // Actual awaited SDK extension hook: the adapter must recheck AFTER it.
    const runner = (session as unknown as { readonly _extensionRunner: {
      hasHandlers(type: string): boolean; emitToolCall(input: { toolCallId: string }): Promise<undefined>;
    } })._extensionRunner;
    const has = runner.hasHandlers.bind(runner);
    vi.spyOn(runner, 'hasHandlers').mockImplementation((type) => type === 'tool_call' || has(type));
    vi.spyOn(runner, 'emitToolCall').mockImplementation(async (input) => {
      if (input.toolCallId === 'guarded-second') { reached(); await hold; }
      return undefined;
    });
  });
  let service: InstanceType<typeof DirectiveProgressService> | null = null;
  let run: Promise<void> | null = null;
  let foreignRegistry: RuntimeRegistry | null = null;
  let foreignTurn: Promise<void> | null = null;
  let foreignRelease = () => {};
  try {
    if (resume) await seedSdkUserCheckpoint(f);
    if (resume) { service = new DirectiveProgressService(f.deps); service.reconsider(); run = service.settled(); }
    else run = executeAcceptedDirective(f.deps, f.scene.request.requestId);
    if (hook) await Promise.race([boundary, run.then(() => { throw new Error('SDK settled before genuine prior-hook await'); })]);
    else await waitFor(() => f.fx.script.calls.length === 1, 'genuine guarded model await');
    const active = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    expect(f.scene.ledger.getAgent(active.nativeTarget!.agentId)?.state).toBe('streaming');
    if (fault === 'foreign-streaming') {
      const foreignHold = new Promise<void>((resolveGate) => { foreignRelease = resolveGate; });
      const script = new StubScript([{ deltas: [], hold: foreignHold, honorAbort: true }]);
      const registry = new RuntimeRegistry({ config: f.fx.config, store: f.fx.store,
        pi: { agentDir: f.fx.agentDir, modelRuntime: await makeStubModelRuntime(script) } });
      foreignRegistry = registry;
      registry.onAgentEvent((envelope) => {
        if (envelope.phase === 'spawned') {
          const handle = registry.getHandle(envelope.agentId)!;
          f.scene.ledger.registerAgent({ id: handle.id, role: handle.role, jobId: active.jobId, sessionFile: handle.sessionFile, parentage: 'top-level' });
          f.scene.ledger.setAgentState(handle.id, handle.health().state);
        }
        if (envelope.phase === 'event' && envelope.event?.type === 'state') f.scene.ledger.setAgentState(envelope.agentId, envelope.event.state);
      });
      const foreign = await registry.spawn('minion', { cwd: f.scene.lane.path, agentId: 'foreign-streaming-producer' });
      foreignTurn = foreign.prompt('independent foreign native turn held open');
      await waitFor(() => script.calls.length === 1 && f.scene.ledger.getAgent(foreign.id)?.state === 'streaming', 'truthful foreign SDK streaming producer');
      expect(foreign.health().state).toBe('streaming');
    } else if (manifest) {
      const session = f.sessions.at(-1)!;
      if (fault.startsWith('manifest-role')) rewriteSystemPrompt(session, 'unapproved live system authority');
      else if (fault.startsWith('manifest-model')) session.agent.state.model = { ...session.model!, maxTokens: session.model!.maxTokens - 1 };
      else if (fault === 'manifest-execution-mode') session.agent.toolExecution = 'parallel';
      else session.agent.state.tools = session.agent.state.tools.filter((tool) => tool.name !== 'read');
      expect(f.scene.ledger.directiveTurnIdentity(active.requestId)).toEqual(f.scene.identity);
    } else if (fault.startsWith('branch-')) {
      const head = execFileSync('git', ['-C', f.scene.lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['-C', f.scene.lane.path, 'checkout', '-b', 'unapproved-native-branch'], { stdio: 'pipe' });
      expect(execFileSync('git', ['-C', f.scene.lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(head);
    } else f.scene.ledger.setJobStatus(active.jobId, 'parked');
    release(); await run;
    const path = join(f.scene.lane.path, 'guarded-effects.txt');
    if (hook) expect(readFileSync(path, 'utf8')).toBe('first\n');
    else expect(existsSync(path)).toBe(false);
    expect(f.scene.ledger.getDirective(active.requestId)?.state).toBe('admitted');
    expect(f.scene.ledger.latestJobEventByRequestId(active.jobId, 'job.delivered', active.requestId)).toBeNull();
    if (manifest) {
      expect(f.fx.script.calls).toHaveLength(1); // last-effect refusal also fences the next model request
      expect(readFileSync(`${active.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8')).toContain('guard-refused');
      const { LedgerDb } = await import('../src/ledger/db.js'); const { LedgerApi } = await import('../src/ledger/api.js');
      const { EventBus } = await import('../src/events/bus.js'); const { NotificationCenter } = await import('../src/notifications/center.js');
      await service?.dispose(); service = null; f.scene.db.close();
      f.scene.db = new LedgerDb(f.scene.dir); f.scene.ledger = new LedgerApi(f.scene.db.handle, { bus: new EventBus({}) });
      f.scene.notifications = new NotificationCenter({ ledger: f.scene.ledger, bus: new EventBus({}) });
      const spawn = vi.spyOn(f.registry, 'spawn');
      service = new DirectiveProgressService({ ...f.deps, ledger: f.scene.ledger, notifications: f.scene.notifications });
      service.reconsider(); await service.settled();
      expect(spawn).not.toHaveBeenCalled(); expect(f.scene.ledger.getDirective(active.requestId)?.state).toBe('admitted');
      expect(f.scene.ledger.latestJobEventByRequestId(active.jobId, 'job.delivered', active.requestId)).toBeNull();
      expect(f.scene.ledger.workRevisionState(active.jobId).delivered).toBe(0);
    }
    if (fault === 'foreign-streaming') {
      expect(readFileSync(active.nativeTarget!.sessionFile, 'utf8')).toContain('foreign-streaming-producer (streaming)');
      expect(f.scene.ledger.getAgent('foreign-streaming-producer')?.state).toBe('streaming');
    }
  } finally {
    release(); foreignRelease(); await run?.catch(() => {}); await service?.dispose();
    await foreignRegistry?.dispose(); await foreignTurn?.catch(() => {}); await f.cleanup();
  }
}
it('production shared SDK tool guard refuses authority revoked during its model await', () => assertProductionSdkFence(false, 'model-await'));
it('production checkpoint SDK tool guard refuses authority revoked during its model await', () => assertProductionSdkFence(true, 'model-await'));
it('production shared SDK tool guard rechecks authority after its awaited native prior hook', () => assertProductionSdkFence(false, 'prior-hook-await'));
it('production checkpoint SDK tool guard rechecks authority after its awaited native prior hook', () => assertProductionSdkFence(true, 'prior-hook-await'));
it('R13 real resumed SDK refuses tool effects after a same-HEAD branch change during model await', () => assertProductionSdkFence(true, 'branch-model-await'));
it('R13 real resumed SDK rechecks the original branch after its awaited prior tool hook', () => assertProductionSdkFence(true, 'branch-hook'));
it('R14 real fresh SDK refuses tool effects after a same-HEAD branch change during model await', () => assertProductionSdkFence(false, 'branch-model-await'));
it('R14 real fresh SDK rechecks the original branch after its awaited prior tool hook', () => assertProductionSdkFence(false, 'branch-hook'));
it('production shared SDK tool guard never exempts a foreign streaming producer', () => assertProductionSdkFence(false, 'foreign-streaming'));
it('production checkpoint SDK tool guard never exempts a foreign streaming producer', () => assertProductionSdkFence(true, 'foreign-streaming'));
it('real SDK model authority mutation refuses effects and further model requests across persistent restart', () => assertProductionSdkFence(false, 'manifest-model'));
it('real resumed SDK system authority mutation refuses effects and further model requests across persistent restart', () => assertProductionSdkFence(true, 'manifest-role'));
it('real SDK tool authority mutation after awaited prior hook retains only its permitted first effect across restart', () => assertProductionSdkFence(false, 'manifest-hook'));
it('real resumed SDK tool authority mutation after awaited prior hook never gains further model requests or delivery on restart', () => assertProductionSdkFence(true, 'manifest-hook'));
it('real SDK execution-mode mutation refuses native effects and further model requests across persistent restart', () => assertProductionSdkFence(false, 'manifest-execution-mode'));

it('restart authority manifest binds closure context for native tools with identical function source', async () => {
  const f = await fixture([]);
  const nativeTool = (scope: string, authorityManifest: string) => ({ name: 'scoped_native_tool', description: 'Scoped native tool',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }, authorityManifest,
    async execute() { return { text: scope }; } });
  const first = await f.runtime.spawn('minion', { cwd: f.workspace, nativeTools: [nativeTool('scope-one', 'parent-capability:one')] });
  const firstManifest = (first as unknown as { directiveAuthorityManifest(): string }).directiveAuthorityManifest();
  await first.dispose();
  const second = await f.runtime.spawn('minion', { cwd: f.workspace, nativeTools: [nativeTool('scope-two', 'parent-capability:two')] });
  const secondManifest = (second as unknown as { directiveAuthorityManifest(): string }).directiveAuthorityManifest();
  expect(secondManifest).not.toBe(firstManifest);
  await second.dispose();
});

it('refuses directive admission when a custom native tool has no explicit closure-authority manifest', async () => {
  const f = await fixture([]);
  const handle = await f.runtime.spawn('minion', { cwd: f.workspace, nativeTools: [{ name: 'unbound_native_tool', description: 'Unbound native tool',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }, async execute() { return { text: 'must not run' }; } }] });
  const identity = { requestId: 'unbound-native-authority', payloadHash: 'a'.repeat(64), contractSha256: 'b'.repeat(64), jobId: 'native-authority-job', workRevision: 0, authorityEpoch: 0 };
  if (handle.promptWithVerdict === undefined) throw new Error('Pi runtime must support directive terminal verdicts');
  await expect(handle.promptWithVerdict('approved task', { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } }))
    .rejects.toThrow(/lack stable authority manifests/u);
  expect(f.script.calls).toHaveLength(0);
  await handle.dispose();
});

/** SDK 1.x derives `agent.state.systemPrompt` from the transcript's system
 * messages (it is read-only): rewrite the leading one, as a live role change. */
function rewriteSystemPrompt(session: AgentSession, text: string): void {
  const [leading, ...rest] = session.agent.state.messages;
  if (leading?.role !== 'system') throw new Error('expected the session transcript to lead with its system message');
  session.agent.state.messages = [{ ...leading, content: text }, ...rest];
}

/** What a real pi 1.x host persists directly ahead of a session's first
 * prompt: the SDK's prompt-sections patch carrying the tool declarations. */
function persistedSystemMessage(session: AgentSession) {
  const sdk = session as unknown as {
    readonly _baseSystemPromptOptions: object;
    _preparePromptAndToolLoadout(options: object): { readonly role: 'system'; readonly content: string; readonly sections: Record<string, string | null>; readonly timestamp: number } | undefined;
  };
  const patch = sdk._preparePromptAndToolLoadout(structuredClone(sdk._baseSystemPromptOptions));
  if (patch === undefined) throw new Error('a session that has not prompted must owe its prompt sections');
  return { ...patch, toolsAdded: session.agent.state.tools.map(toToolDeclaration) };
}

async function actualDirectiveSdkSession(handle: AgentHandle) {
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  const exposed = (handle as unknown as { readonly session: unknown }).session;
  if (!(exposed instanceof AgentSession)) throw new Error('ownership regression requires the actual pinned SDK AgentSession');
  return exposed;
}

async function assertPreFenceSdkOwnerSurvivesRestart(terminal: boolean): Promise<void> {
  const { LedgerDb } = await import('../src/ledger/db.js');
  const { LedgerApi } = await import('../src/ledger/api.js');
  const { EventBus } = await import('../src/events/bus.js');
  const { NotificationCenter } = await import('../src/notifications/center.js');
  const { DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  const { inspectDirectiveCheckpoint, readDirectiveBinding } = await import('../src/runtime/directive-checkpoint.js');
  let release!: () => void; const hold = new Promise<void>((resolveGate) => { release = resolveGate; });
  let reached!: () => void; const boundary = new Promise<void>((resolveGate) => { reached = resolveGate; });
  const f = await fixture((_prompt, index) => {
    if (index === 0) return { deltas: [], toolCall: { id: 'original-effect-call', name: 'bash',
      args: { command: "printf 'original-effect\\n' >> legacy-effect.txt" } } };
    if (!terminal) { reached(); return { deltas: [], hold, honorAbort: false }; }
    return { deltas: ['genuine original terminal response'] };
  });
  const scene = await directiveRecoveryLedgerFixture(terminal ? 'legacy-terminal-owner' : 'legacy-resumable-owner');
  const owner = await f.runtime.spawn('minion', { cwd: scene.lane.path, agentId: 'sdk-original-minion' });
  const session = await actualDirectiveSdkSession(owner);
  const file = owner.sessionFile!;
  // This public awaited observer really holds the terminal SDK run. It is
  // NOT a stop hook, idle stub, transcript rewrite or graceful handoff.
  const unsubscribe = terminal ? session.agent.subscribe(async (event) => {
    if (event.type === 'agent_end') { reached(); await hold; }
  }) : () => {};
  let reopened: InstanceType<typeof LedgerDb> | null = null;
  let service: InstanceType<typeof DirectiveProgressService> | null = null;
  let settled = false;
  scene.ledger.registerAgent({ id: owner.id, role: 'minion', jobId: scene.request.jobId, sessionFile: file, parentage: 'top-level' });
  // Last persisted pre-turn observer state. No live state is rewritten to
  // idle; this old snapshot is deliberately not a cessation attestation.
  scene.ledger.setAgentState(owner.id, 'idle');
  scene.ledger.prepareDirectiveTarget(scene.request.requestId, { agentId: owner.id, sessionFile: file });
  // Explicit preceding-version fixture: its dispatch claim stored these
  // facts before native admission, before the producer-reservation event
  // existed. Do not call/delete a genuine current claim or backfill proof.
  scene.db.handle.prepare('UPDATE pending_directives SET dispatch_started_at = ? WHERE request_id = ?')
    .run(new Date().toISOString(), scene.request.requestId);
  scene.ledger.appendCustomEvent({ kind: 'silas.directive-dispatch-started', jobId: scene.request.jobId,
    payload: { request_id: scene.request.requestId } });
  const turn = owner.prompt('perform original approved work only once', { directive: { identity: scene.identity,
    beforeAdmission: () => { scene.ledger.assertDirectiveAuthority(scene.identity); },
    onAdmitted: (binding) => { scene.ledger.bindDirectiveNativeAdmission(binding); },
  } }).finally(() => { settled = true; });
  // Observe an early genuine failure instead of hanging in setup if the
  // actual SDK never reaches the requested owned boundary.
  const premature = turn.then(() => { throw new Error('original SDK settled before its held boundary'); });
  try {
    await Promise.race([boundary, premature]);
    expect(settled).toBe(false); expect(session.isIdle).toBe(false);
    expect(session.agent.state.isStreaming).toBe(true);
    expect(session.isBashRunning).toBe(false); expect(session.hasPendingBashMessages).toBe(false);
    expect(owner.cessationEvidence!()).toBe('unknown');
    expect(f.store.isHeld(file)).toBe(true);
    expect(readFileSync(join(scene.lane.path, 'legacy-effect.txt'), 'utf8')).toBe('original-effect\n');
    const proof = inspectDirectiveCheckpoint(file, scene.identity);
    if (terminal) expect(proof).toMatchObject({ state: 'terminal', ok: true });
    else expect(proof.state).toBe('resumable');
    const request = scene.ledger.getDirective(scene.request.requestId)!;
    expect(request).toMatchObject({ state: 'admitted', recoveryCheckpoint: null });
    expect(request.dispatchStartedAt).not.toBeNull();
    const admission = scene.ledger.getEvent(request.admissionSeq!);
    expect(admission?.kind).toBe('silas.directive-sent');
    expect(scene.ledger.latestJobEvent(request.jobId, 'silas.directive-producer-started')).toBeNull();
    expect(scene.ledger.latestJobEvent(request.jobId, 'silas.directive-producer-ceased')).toBeNull();
    const prefix = readFileSync(file, 'utf8');
    const binding = readDirectiveBinding(file, request.requestId);
    scene.db.close();
    reopened = new LedgerDb(scene.dir); expect(reopened.dbPath).toBe(scene.db.dbPath);
    const bus = new EventBus({}); const ledger = new LedgerApi(reopened.handle, { bus });
    const registry: import('../src/dispatch/fix-directive.js').DirectiveRegistry = { getHandle: () => null,
      spawn: vi.fn(async () => { throw new Error('fresh empty registry cannot replace an unproven original SDK owner'); }),
      disposeHandle: vi.fn(async () => { throw new Error('fresh empty registry does not own the original handle'); }) };
    service = new DirectiveProgressService({ ledger, registry, worktrees: scene.worktrees,
      notifications: new NotificationCenter({ ledger, bus }), signal: new AbortController().signal,
      pendingProducerBlockers: () => [] });
    service.reconsider(); await service.settled();
    expect(settled).toBe(false); expect(session.isIdle).toBe(false);
    expect(owner.cessationEvidence!()).toBe('unknown'); expect(f.store.isHeld(file)).toBe(true);
    expect(f.script.calls).toHaveLength(2);
    expect(readFileSync(join(scene.lane.path, 'legacy-effect.txt'), 'utf8')).toBe('original-effect\n');
    expect(readFileSync(file, 'utf8')).toBe(prefix);
    expect(readDirectiveBinding(file, request.requestId)).toEqual(binding);
    expect(ledger.getEvent(request.admissionSeq!)).toEqual(admission);
    expect(ledger.latestJobEvent(request.jobId, 'job.delivered'),
      'pre-fence native terminal completeness cannot prove the still-held original SDK producer ceased').toBeNull();
    expect(registry.spawn, 'pre-fence user/tool results and missing reservation cannot authorize a new producer').not.toHaveBeenCalled();
    expect(registry.disposeHandle).not.toHaveBeenCalled();
    expect(ledger.getDirective(request.requestId)).toMatchObject({ state: 'admitted', recoveryCheckpoint: null,
      payloadHash: request.payloadHash, workRevision: request.workRevision, contractSha256: request.contractSha256,
      authorityEpoch: request.authorityEpoch, nativeTarget: request.nativeTarget, nativeBinding: request.nativeBinding });
    const debt = ledger.listObligations({ jobId: request.jobId }).find((row) => row.incidentKey === `directive-recovery:${request.requestId}`);
    expect(debt).toMatchObject({ state: 'open', nextAction: { kind: 'gru-decision' } });
  } finally {
    // Preserve every inspected byte until assertions finish; then genuinely
    // release the original provider/listener and dispose its actual owner.
    release(); unsubscribe(); await turn.catch(() => {}); await premature.catch(() => {});
    await service?.dispose(); await session.waitForIdle(); await owner.dispose();
    await f.runtime.dispose(); f.store.dispose(); reopened?.close(); scene.db.close(); scene.repo.cleanup();
  }
}

it('pre-fence persisted admitted tool results stay UNKNOWN with a genuinely held original SDK after ledger restart', async () => {
  await assertPreFenceSdkOwnerSurvivesRestart(false);
});

it('pre-fence persisted admitted terminal stays UNKNOWN with a genuinely held original SDK listener after ledger restart', async () => {
  await assertPreFenceSdkOwnerSurvivesRestart(true);
});

it('resident actual SDK disposal and pre-durability UNKNOWN journal failures retain both original failures', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const f = await fixture([{ deltas: ['genuine original terminal'] }]);
  const scene = await directiveRecoveryLedgerFixture('resident-sdk-journal-failures');
  const owner = await f.runtime.spawn('minion', { cwd: scene.lane.path, agentId: 'resident-sdk-minion' });
  const session = await actualDirectiveSdkSession(owner);
  const dependency = session as unknown as { readonly _extensionRunner: { invalidate(message?: string): void } };
  const original = new Error('original actual resident SDK invalidation failure');
  const disposal = vi.spyOn(session, 'dispose'); // actual pinned dispose call-through
  const invalidation = vi.spyOn(dependency._extensionRunner, 'invalidate').mockImplementation(() => { throw original; });
  scene.ledger.registerAgent({ id: owner.id, role: 'minion', jobId: scene.request.jobId, sessionFile: owner.sessionFile, parentage: 'top-level' });
  scene.ledger.setAgentState(owner.id, 'idle');
  const registry: import('../src/dispatch/fix-directive.js').DirectiveRegistry = {
    getHandle: (id) => id === owner.id ? owner : null,
    spawn: vi.fn(async () => { throw new Error('resident must not acquire another native owner'); }),
    disposeHandle: async (handle) => { await handle.dispose(); },
  };
  try {
    scene.db.handle.exec(`CREATE TRIGGER reject_resident_unknown BEFORE INSERT ON events
      WHEN NEW.kind = 'silas.directive-producer-unknown'
      BEGIN SELECT RAISE(FAIL, 'original resident UNKNOWN journal storage failure'); END`);
    await executeAcceptedDirective({ ledger: scene.ledger, registry, worktrees: scene.worktrees,
      notifications: scene.notifications, signal: new AbortController().signal, pendingProducerBlockers: () => [] }, scene.request.requestId);
    expect(disposal).toHaveBeenCalledTimes(1); expect(invalidation).toHaveBeenCalledTimes(1);
    expect(session.isIdle).toBe(true); expect(owner.cessationEvidence!()).toBe('unknown');
    expect(f.store.isHeld(owner.sessionFile!)).toBe(true); expect(registry.spawn).not.toHaveBeenCalled();
    expect(f.script.calls).toHaveLength(1);
    expect(scene.ledger.getDirective(scene.request.requestId)?.state).toBe('admitted');
    expect(scene.ledger.latestJobEvent(scene.request.jobId, 'job.delivered')).toBeNull();
    expect(scene.ledger.latestJobEvent(scene.request.jobId, 'silas.directive-producer-unknown')).toBeNull();
    expect(scene.ledger.latestJobEvent(scene.request.jobId, 'silas.directive-producer-ceased')).toBeNull();
    const card = scene.ledger.findNotificationByKind(`silas.directive-unreconciled.${scene.request.requestId}`, 'active');
    expect(card?.detail, 'UNKNOWN journaling must not mask the real pinned SDK disposal failure').toContain(original.message);
    expect(card?.detail).toContain('original resident UNKNOWN journal storage failure');
  } finally {
    scene.db.handle.exec('DROP TRIGGER IF EXISTS reject_resident_unknown');
    invalidation.mockRestore(); await owner.dispose(); disposal.mockRestore();
    await f.runtime.dispose(); f.store.dispose(); scene.db.close(); scene.repo.cleanup();
  }
});

async function assertStrictOriginalSdkLock(mode: 'foreign' | 'legacy' | 'reused' | 'live' | 'eperm') {
  const { hostname } = await import('node:os');
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['must never execute'] }]);
  const seeded = await seedSdkUserCheckpoint(f); const file = seeded.original.sessionFile!;
  const native = JSON.parse(readFileSync(`${file}.producers.jsonl`, 'utf8').trim().split('\n')[0]!) as { producer: import('../src/runtime/directive-checkpoint.js').DirectiveProducer };
  // Bind the actual SDK-owned lock observed before real disposal. This
  // independent fixture observation also works against received production
  // whose missing producer binding is precisely the regression under test.
  const owner = { ...seeded.lockOwner, host: seeded.lockOwner.host ?? native.producer.host };
  const lock = { host: mode === 'foreign' ? 'foreign-host' : hostname(), pid: process.pid,
    bootId: mode === 'reused' ? 'different-current-native-boot' : owner.bootId, acquiredAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z' };
  const body = mode === 'legacy' ? { pid: lock.pid, bootId: lock.bootId, acquiredAt: lock.acquiredAt, heartbeatAt: lock.heartbeatAt } : lock;
  writeFileSync(`${file}.lock`, JSON.stringify(body));
  const bytes = readFileSync(file, 'utf8'); const journal = readFileSync(`${file}.producers.jsonl`, 'utf8'); const agent = f.scene.ledger.getAgent(seeded.original.id);
  const kill = mode === 'eperm' ? vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('original PID probe denied'), { code: 'EPERM' }); }) : null;
  try {
    const outcome = await f.registry.spawn('minion', { cwd: f.scene.lane.path, agentId: seeded.original.id, resumeFile: file,
      directiveRecoveryProducer: { ...native.producer, lockOwner: owner } }).then(() => ({ accepted: true, message: '' }), (error: unknown) => ({ accepted: false, message: String(error) }));
    expect(outcome.accepted).toBe(false); expect(outcome.message).toMatch(/lock|locked|owner|PID/);
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe(JSON.stringify(body)); expect(f.fx.store.isHeld(file)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(bytes); expect(readFileSync(`${file}.producers.jsonl`, 'utf8')).toBe(journal);
    expect(f.scene.ledger.getAgent(seeded.original.id)).toEqual(agent); expect(f.fx.script.calls).toHaveLength(0); expect(f.sessions).toHaveLength(1);
  } finally { kill?.mockRestore(); rmSync(`${file}.lock`, { force: true }); await f.cleanup(); }
}
it('actual Pi native resume refuses a stale foreign-host lock without stealing original bytes', () => assertStrictOriginalSdkLock('foreign'));
it('actual Pi native resume refuses a stale legacy unbound lock without native admission', () => assertStrictOriginalSdkLock('legacy'));
it('actual Pi native resume refuses a reused native boot incarnation without replacing the original lock', () => assertStrictOriginalSdkLock('reused'));
it('actual Pi native resume refuses even a stale live original PID lock', () => assertStrictOriginalSdkLock('live'));
it('actual Pi native resume refuses EPERM original PID evidence and preserves every ownership row', () => assertStrictOriginalSdkLock('eperm'));

it('actual Pi native resume through the production registry reclaims the exact host-absent predecessor\'s surviving lock, without replaying anything (#363 S05-0-05, S05-2-01, S10-2-01)', async () => {
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['must never execute'] }]);
  const seeded = await seedSdkUserCheckpoint(f); const file = seeded.original.sessionFile!;
  const native = JSON.parse(readFileSync(`${file}.producers.jsonl`, 'utf8').trim().split('\n')[0]!) as { producer: import('../src/runtime/directive-checkpoint.js').DirectiveProducer };
  const owner = { ...seeded.lockOwner, host: seeded.lockOwner.host ?? native.producer.host };
  // A host that died wrote no cessation receipt: only its start remains in the journal.
  const rows = readFileSync(`${file}.producers.jsonl`, 'utf8').trimEnd().split('\n');
  writeFileSync(`${file}.producers.jsonl`, `${rows.filter((line) => (JSON.parse(line) as { state: string }).state !== 'ceased').join('\n')}\n`);
  // The exact original owner's lock survives its host's exit.
  const lock = { host: owner.host, pid: owner.pid, bootId: owner.bootId, acquiredAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z' };
  writeFileSync(`${file}.lock`, JSON.stringify(lock));
  const bytes = readFileSync(file, 'utf8'); const journal = readFileSync(`${file}.producers.jsonl`, 'utf8');
  const realKill = process.kill.bind(process);
  // The original producer's PID is probed as gone (ESRCH): host-absent, not merely ceased.
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === 0 && (pid === native.producer.pid || pid === owner.pid)) throw Object.assign(new Error('original host exited'), { code: 'ESRCH' });
    return realKill(pid, signal);
  });
  try {
    const { inspectDirectiveProducers } = await import('../src/runtime/directive-checkpoint.js');
    expect(inspectDirectiveProducers(file, native.producer.identity).at(-1)).toMatchObject({ evidence: 'host-absent' });
    // The exact journaled predecessor, its recorded lock owner included.
    const handle = await f.registry.spawn('minion', { cwd: f.scene.lane.path, agentId: seeded.original.id, resumeFile: file,
      directiveRecoveryProducer: native.producer });
    try {
      // Reclaimed: the store now holds the original session, and nothing was replayed.
      expect(handle.sessionFile).toBe(file);
      expect(f.fx.store.isHeld(file)).toBe(true);
      expect(readFileSync(`${file}.lock`, 'utf8')).not.toBe(JSON.stringify(lock));
      expect(readFileSync(file, 'utf8')).toBe(bytes); expect(readFileSync(`${file}.producers.jsonl`, 'utf8')).toBe(journal);
      expect(f.fx.script.calls).toHaveLength(0);
    } finally { await f.registry.disposeHandle(handle).catch(() => {}); }
  } finally { kill.mockRestore(); rmSync(`${file}.lock`, { force: true }); await f.cleanup(); }
});

async function assertSdkRefusalJournalRetry(postCommit: boolean) {
  const checkpoint = await import('../src/runtime/directive-checkpoint.js');
  const { executeAcceptedDirective, DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  let release!: () => void; const hold = new Promise<void>((done) => { release = done; });
  const f = await sdkDirectiveExecutionFixture([{ ...guardedSdkTools[0]!, hold }, guardedSdkTools[1]!]);
  const original = checkpoint.recordDirectiveToolRefusal;
  let failing = true;
  const journal = vi.spyOn(checkpoint, 'recordDirectiveToolRefusal').mockImplementation((...args) => {
    if (postCommit || !failing) original(...args);
    if (failing) throw new Error(`refusal journal ${postCommit ? 'post' : 'pre'}-commit publication failure`);
  });
  try {
    const run = executeAcceptedDirective(f.deps, f.scene.request.requestId);
    await waitFor(() => f.fx.script.calls.length === 1, 'actual guarded SDK model await');
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!; const file = row.nativeTarget!.sessionFile;
    const handle = f.registry.getHandle(row.nativeTarget!.agentId)!;
    rewriteSystemPrompt(f.sessions[0]!, 'unapproved current role authority'); release(); await run;
    expect(existsSync(join(f.scene.lane.path, 'guarded-effects.txt'))).toBe(false); expect(f.fx.script.calls).toHaveLength(1);
    // While its tool refusals' receipts are owed, the refusal at the next model request is durable: never ordinary work.
    expect(checkpoint.inspectDirectiveCheckpoint(file, f.scene.identity)).toEqual({ state: 'unknown', reason: 'native directive execution/authority boundary refused; exact turn remains incomplete' });
    expect(handle.cessationEvidence!()).toBe('unknown'); expect(f.fx.store.isHeld(file)).toBe(true); expect(existsSync(`${file}.lock`)).toBe(true);
    expect(f.scene.ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId)).toBeNull();
    failing = false; await f.registry.disposeHandle(handle);
    expect(handle.cessationEvidence!()).toBe('ceased'); expect(existsSync(`${file}.lock`)).toBe(false);
    const receipts = readFileSync(`${file}.producers.jsonl`, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { state: string; toolCallId?: string; boundary?: string });
    expect(receipts.filter((receipt) => receipt.state === 'guard-refused')).toHaveLength(3);
    expect(receipts.filter((receipt) => receipt.state === 'guard-refused' && receipt.toolCallId !== undefined).map((receipt) => receipt.toolCallId).sort()).toEqual(['guarded-first', 'guarded-second']);
    expect(receipts.filter((receipt) => receipt.state === 'guard-refused' && receipt.boundary === 'authority' && receipt.toolCallId === undefined)).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.state === 'completed')).toHaveLength(0);
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); await service.dispose();
    f.scene.db.close(); const { LedgerDb } = await import('../src/ledger/db.js'); const { LedgerApi } = await import('../src/ledger/api.js');
    const { EventBus } = await import('../src/events/bus.js'); const { NotificationCenter } = await import('../src/notifications/center.js');
    f.scene.db = new LedgerDb(f.scene.dir); const bus = new EventBus({}); f.scene.ledger = new LedgerApi(f.scene.db.handle, { bus });
    const spawn = vi.spyOn(f.registry, 'spawn');
    const restart = new DirectiveProgressService({ ...f.deps, ledger: f.scene.ledger, notifications: new NotificationCenter({ ledger: f.scene.ledger, bus }) });
    restart.reconsider(); await restart.settled(); await restart.dispose();
    expect(spawn).not.toHaveBeenCalled(); expect(f.scene.ledger.getDirective(row.requestId)?.state).toBe('admitted');
    expect(f.scene.ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId)).toBeNull();
    expect(f.scene.ledger.workRevisionState(row.jobId).delivered).toBe(0);
  } finally { release(); failing = false; journal.mockRestore(); await f.cleanup(); }
}
it('actual SDK pre-commit refusal journal failure retains lock and retries refusal before cessation or restart settlement #contract:directive-tool-error:pi', () => assertSdkRefusalJournalRetry(false));
it('actual SDK post-commit refusal journal failure fsync-retries exact receipts without duplicate refusals or delivery', () => assertSdkRefusalJournalRetry(true));

it('real SDK system mutation before native effects remains refused before the next model request and across restart', () => assertProductionSdkFence(false, 'manifest-role'));
it('real SDK tools mutation before native effects remains refused before the next model request and across restart', () => assertProductionSdkFence(false, 'manifest-tools'));
it('real SDK system mutation after awaited prior hook preserves only its first permitted effect', () => assertProductionSdkFence(false, 'manifest-role-hook'));
it('real SDK model mutation after awaited prior hook preserves only its first permitted effect', () => assertProductionSdkFence(false, 'manifest-model-hook'));

async function assertSdkBoundToolAncestry(fault: 'foreign-user' | 'branch' | 'missing-result', resume: boolean) {
  const { executeAcceptedDirective, DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  let mutation = false;
  const f = await sdkDirectiveExecutionFixture(guardedSdkTools, (session) => {
    session.agent.toolExecution = 'sequential';
    const runner = (session as unknown as { _extensionRunner: { hasHandlers(type: string): boolean; emitToolCall(input: { toolCallId: string }): Promise<undefined> } })._extensionRunner;
    const prior = runner.hasHandlers.bind(runner); vi.spyOn(runner, 'hasHandlers').mockImplementation((type) => type === 'tool_call' || prior(type));
    vi.spyOn(runner, 'emitToolCall').mockImplementation(async ({ toolCallId }) => {
      if (mutation || toolCallId !== (fault === 'missing-result' ? 'guarded-second' : 'guarded-first')) return undefined;
      await Promise.resolve(); mutation = true;
      const file = session.sessionFile!; const entries = readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { id: string; type: string; parentId?: string; message?: { role: string } });
      if (fault === 'missing-result') entries.splice(entries.findIndex((entry) => entry.message?.role === 'toolResult'), 1);
      else {
        const index = entries.map((entry) => entry.message?.role).lastIndexOf('assistant'); const invocation = entries[index]!;
        if (fault === 'branch') invocation.parentId = entries[0]!.id;
        else {
          const foreign = { type: 'message', id: 'foreign-native-user', parentId: invocation.parentId, message: { role: 'user', content: [{ type: 'text', text: 'unaccepted native steer' }] } };
          entries.splice(index, 0, foreign); invocation.parentId = foreign.id;
        }
      }
      writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'); return undefined;
    });
  });
  let service: InstanceType<typeof DirectiveProgressService> | null = null;
  try {
    if (resume) { await seedSdkUserCheckpoint(f); service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); }
    else await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    expect(mutation).toBe(true); const effect = join(f.scene.lane.path, 'guarded-effects.txt');
    expect(existsSync(effect) ? readFileSync(effect, 'utf8') : '').toBe(fault === 'missing-result' ? 'first\n' : '');
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    expect(row.state).toBe('admitted'); expect(f.scene.ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId)).toBeNull();
    expect(readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8')).toContain('guard-refused');
    service ??= new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); expect(f.scene.ledger.getDirective(row.requestId)?.state).toBe('admitted');
  } finally { await service?.dispose(); await f.cleanup(); }
}
it('P30 shared real SDK foreign native user after awaited prior hook cannot own directive effects', () => assertSdkBoundToolAncestry('foreign-user', false));
it('P30 resumed original SDK foreign native user cannot steal the accepted effect ancestry', () => assertSdkBoundToolAncestry('foreign-user', true));
it('P30 shared real SDK branched invocation with identical tool arguments is refused before effects', () => assertSdkBoundToolAncestry('branch', false));
it('P30 resumed real SDK missing earlier sequential native result preserves first effect and refuses second', () => assertSdkBoundToolAncestry('missing-result', true));

it('P30 default pinned SDK parallel-safe read batch preserves exact accepted ancestry and completes both real tools', async () => {
  const { executeAcceptedDirective, DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  const entered: string[] = []; let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  const f = await sdkDirectiveExecutionFixture([
    { deltas: [], toolCalls: [
      { id: 'parallel-first', name: 'read', args: { path: 'parallel-first.txt' } },
      { id: 'parallel-second', name: 'read', args: { path: 'parallel-second.txt' } },
    ] },
    { deltas: ['both independently allowed original reads completed'] },
  ], (session) => {
    expect(session.agent.toolExecution).toBe('parallel'); // actual SDK default, never configured
    const read = session.agent.state.tools.find((tool) => tool.name === 'read')!;
    expect(read.executionMode).not.toBe('sequential');
    const execute = read.execute.bind(read);
    vi.spyOn(read, 'execute').mockImplementation(async (...args) => {
      entered.push(args[0]); if (entered.length === 2) release();
      await both; return execute(...args);
    });
    // Let the failing received guard finish cleanly rather than time out:
    // it emits the denied second preparation before either read executes.
    session.subscribe((event) => { if (event.type === 'tool_execution_end' && event.toolCallId === 'parallel-second' && event.isError) release(); });
  }, false, true);
  try {
    writeFileSync(join(f.scene.lane.path, 'parallel-first.txt'), 'first independent input');
    writeFileSync(join(f.scene.lane.path, 'parallel-second.txt'), 'second independent input');
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    expect(entered).toEqual(['parallel-first', 'parallel-second']);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    expect(row.state).toBe('settled'); expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])).toHaveLength(1);
    const native = readFileSync(row.nativeTarget!.sessionFile, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { message?: { role?: string; toolCallId?: string; isError?: boolean } });
    expect(native.filter((entry) => entry.message?.role === 'toolResult').map((entry) => [entry.message?.toolCallId, entry.message?.isError])).toEqual([
      ['parallel-first', false], ['parallel-second', false],
    ]);
    expect(readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8')).not.toContain('guard-refused');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); await service.dispose();
    expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])).toHaveLength(1);
  } finally { release(); await f.cleanup(); }
});

/** A real SDK directive whose bash command fails (`exit 3`) settles like any
 * other: the failure is ordinary work, whatever the minion does next. */
async function assertSdkFailedCommandIsOrdinary(turns: readonly StubTurn[], results: readonly (readonly [string, boolean])[]) {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const f = await sdkDirectiveExecutionFixture(turns);
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const native = readFileSync(row.nativeTarget!.sessionFile, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as { message?: { role?: string; toolCallId?: string; isError?: boolean } });
    expect(native.filter((entry) => entry.message?.role === 'toolResult').map((entry) => [entry.message?.toolCallId, entry.message?.isError])).toEqual(results);
    expect(readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8')).not.toContain('guard-refused');
    expect(row.state).toBe('settled'); expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])).toHaveLength(1);
  } finally { await f.cleanup(); }
}
const failingCommand = { id: 'failing-command', name: 'bash', args: { command: 'exit 3' } };
const followingCommand = { id: 'following-command', name: 'bash', args: { command: 'true' } };
it('a real SDK bash command that fails is ordinary work once the model answers it: the directive settles', () => assertSdkFailedCommandIsOrdinary([
  { deltas: [], toolCalls: [failingCommand] }, { deltas: ['the command failed, so the minion reported it'] },
], [['failing-command', true]]));
it('a real SDK minion may go on calling tools after a failed command, and the directive settles #contract:directive-tool-error:pi', () => assertSdkFailedCommandIsOrdinary([
  { deltas: [], toolCalls: [failingCommand] }, { deltas: [], toolCalls: [followingCommand] }, { deltas: ['fixed it after the failure'] },
], [['failing-command', true], ['following-command', false]]));
it('a later call in the same sequential batch still runs after a failed one, and the directive settles', () => assertSdkFailedCommandIsOrdinary([
  { deltas: [], toolCalls: [failingCommand, followingCommand] }, { deltas: ['both calls settled'] },
], [['failing-command', true], ['following-command', false]]));

/*
 * Pi retry history (#483). A retryable provider error (a truncated OpenAI
 * Responses stream, read by the real pi-ai parser over a synthetic fetch)
 * leaves its error row in the transcript, and the SDK retries from it. The
 * live auto_retry_start is durably receipted, so the tool guard, the turn's
 * checkpoint and settlement all walk past that row; nothing else does.
 */
type ResponsesEvent = Readonly<Record<string, unknown>>;
const responsesUsage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
  output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
function responsesFunctionCall(ordinal: number, name: string, callId: string, args: Record<string, unknown>): readonly ResponsesEvent[] {
  const json = JSON.stringify(args);
  const item = { id: `item-${ordinal}`, type: 'function_call', call_id: callId, name, arguments: json, status: 'completed' };
  return [
    { type: 'response.created', response: { id: `response-${ordinal}`, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: json },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: json },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `response-${ordinal}`, object: 'response', status: 'completed', output: [item], usage: responsesUsage } },
  ];
}
function responsesAnswer(text: string): readonly ResponsesEvent[] {
  const item = { id: 'answer-item', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text }] };
  return [
    { type: 'response.created', response: { id: 'response-answer', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'response-answer', object: 'response', status: 'completed', output: [item], usage: responsesUsage } },
  ];
}
/** A stream that ends before any terminal response event, having output nothing. */
const responsesTruncated: readonly ResponsesEvent[] = [{ type: 'response.created', response: { id: 'truncated-response', status: 'in_progress' } }];
/** The same end after a completed commentary message, which the parser signs. */
function responsesTruncatedAfterCommentary(text: string): readonly ResponsesEvent[] {
  const item = { id: 'commentary-item', type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text }] };
  return [...responsesTruncated,
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item }];
}
/** The same end while a function call is still streaming its arguments. */
function responsesTruncatedToolCall(name: string): readonly ResponsesEvent[] {
  return [...responsesTruncated,
    { type: 'response.output_item.added', output_index: 0, item: { id: 'partial-item', type: 'function_call', call_id: 'partial-call', name, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"partial":' }];
}
/** Serves `providerId/modelId` through the real Responses parser: request n
 * reads `bodies[n]`. Returns the count of requests made. */
async function registerSyntheticResponses(modelRuntime: ModelRuntime, providerId: string, modelId: string, bodies: readonly (readonly ResponsesEvent[])[]): Promise<() => number> {
  const { stream: streamOpenAIResponses } = await import('@earendil-works/pi-ai/api/openai-responses');
  const model = { id: modelId, name: 'Synthetic Responses Model', api: 'openai-responses' as const, provider: providerId,
    baseUrl: 'http://synthetic.invalid/v1', reasoning: false, input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_024 };
  let requests = 0;
  const fakeFetch: typeof fetch = async () => {
    const events = bodies[requests];
    requests += 1;
    if (events === undefined) throw new Error(`synthetic Responses provider has no body for request ${String(requests)}`);
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  modelRuntime.registerNativeProvider({
    id: providerId, name: 'Synthetic offline Responses',
    auth: { apiKey: { name: 'synthetic key', resolve: async () => ({ auth: { apiKey: 'offline-only' }, source: 'test' }) } },
    getModels: () => [model],
    stream: (selectedModel, context, options) => streamOpenAIResponses(selectedModel as Parameters<typeof streamOpenAIResponses>[0], context,
      { ...options, apiKey: 'offline-only', fetch: fakeFetch } as Parameters<typeof streamOpenAIResponses>[2]),
    streamSimple: (selectedModel, context, options) => streamOpenAIResponses(selectedModel as Parameters<typeof streamOpenAIResponses>[0], context,
      { ...options, apiKey: 'offline-only', fetch: fakeFetch } as Parameters<typeof streamOpenAIResponses>[2]),
  });
  await modelRuntime.refresh({ allowNetwork: false, providers: [providerId] });
  return () => requests;
}
interface NativeRow {
  readonly type?: string; readonly targetId?: string; readonly replacement?: unknown;
  readonly id: string; readonly parentId: string | null;
  readonly message?: { readonly role?: string; readonly stopReason?: string; readonly errorMessage?: string; readonly toolCallId?: string; readonly isError?: boolean; readonly content?: readonly unknown[] };
}
function nativeRows(file: string): readonly NativeRow[] {
  return readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as NativeRow);
}
function producerJournal(file: string): readonly Readonly<Record<string, unknown>>[] {
  return readFileSync(`${file}.producers.jsonl`, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}
const toolResultsOf = (rows: readonly NativeRow[]) => rows.filter((row) => row.message?.role === 'toolResult').map((row) => [row.message?.toolCallId, row.message?.isError]);
/** Pi 1.x omits a failed reply from context with an edit linked on it; the
 * SDK's retried replies hang off that edit, read here by stop reason. */
function retriedReplies(rows: readonly NativeRow[], error: NativeRow) {
  const edits = rows.filter((entry) => entry.parentId === error.id);
  expect(edits).toEqual([expect.objectContaining({ type: 'context_edit', targetId: error.id, replacement: null })]);
  return rows.filter((entry) => entry.parentId === edits[0]!.id).map((entry) => entry.message?.stopReason);
}

it('a real SDK retry after a truncated Responses stream settles the directive once, and its checkpoint outlives the turn and the minion (#483)', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  let minion: AgentHandle | undefined;
  const f = await sdkDirectiveExecutionFixture([], (_session, handle) => { minion = handle; });
  // The fixture's default model, now read by the real Responses parser.
  const requests = await registerSyntheticResponses(f.fx.modelRuntime, 'gru-stub', 'stub-model', [
    responsesFunctionCall(1, 'bash', 'failing-call', { command: 'exit 3' }), responsesTruncated,
    responsesFunctionCall(3, 'bash', 'following-call', { command: 'true' }), responsesAnswer('retried past the truncated stream'),
  ]);
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const file = row.nativeTarget!.sessionFile;
    const rows = nativeRows(file);
    const error = rows.find((entry) => entry.message?.stopReason === 'error')!;
    const answer = rows.filter((entry) => entry.message?.role === 'assistant' && entry.message.stopReason === 'stop').at(-1)!;
    expect(error.message?.errorMessage).toContain('stream ended before a terminal response event');
    expect(retriedReplies(rows, error)).toEqual(['toolUse']);
    expect(toolResultsOf(rows)).toEqual([['failing-call|item-1', true], ['following-call|item-3', false]]);
    expect(requests()).toBe(4);
    expect(row.state).toBe('settled'); expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])).toHaveLength(1);
    const journal = producerJournal(file);
    expect(journal.filter((receipt) => receipt['state'] === 'retry-start')).toEqual([
      expect.objectContaining({ entryId: error.id, errorMessage: error.message?.errorMessage })]);
    expect(journal.map((receipt) => receipt['state'])).not.toContain('guard-refused');
    const identity = f.scene.ledger.directiveTurnIdentity(row.requestId);
    const terminal = { state: 'terminal', ok: true, error: null, checkpointId: answer.id };
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject(terminal);
    expect(minion?.id).toBe(row.nativeTarget!.agentId);
    await minion!.dispose();
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject(terminal);
  } finally { await f.cleanup(); }
});

it('a real SDK retry of the directive\'s first request, after a short backoff, lets its next tool call run once and the directive settles (#483)', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const retryStarts: unknown[] = [];
  const f = await sdkDirectiveExecutionFixture([], (session) => {
    session.subscribe((event) => { if (event.type === 'auto_retry_start') retryStarts.push(event); });
  });
  // SDK delayMs is baseDelayMs·2^(attempt-1). Pi 1.x treats a non-integer as
  // unsafe and sleeps its 60 s cap instead, so a fractional delay can no longer
  // reach the adapter from the SDK; the validator's acceptance of one stays
  // pinned in directive-retry-history.test.ts.
  writeFileSync(join(f.fx.agentDir, 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 1 } }));
  const effects = mkdtempSync(join(tmpdir(), 'gru-retry-effect-')); cleanupDirs.push(effects);
  const effect = join(effects, 'ran.log');
  const requests = await registerSyntheticResponses(f.fx.modelRuntime, 'gru-stub', 'stub-model', [
    responsesTruncated, responsesFunctionCall(2, 'bash', 'once-call', { command: `printf ran >> ${JSON.stringify(effect)}` }),
    responsesAnswer('ran once after the retried first request'),
  ]);
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const file = row.nativeTarget!.sessionFile;
    const rows = nativeRows(file);
    const user = rows.find((entry) => entry.message?.role === 'user')!;
    const error = rows.find((entry) => entry.message?.stopReason === 'error')!;
    expect(error.parentId).toBe(user.id);
    expect(retryStarts).toEqual([expect.objectContaining({ attempt: 1, delayMs: 1, errorMessage: error.message?.errorMessage })]);
    expect(retriedReplies(rows, error)).toEqual(['toolUse']);
    expect(toolResultsOf(rows)).toEqual([['once-call|item-2', false]]);
    expect(readFileSync(effect, 'utf8')).toBe('ran');
    expect(requests()).toBe(3);
    const journal = producerJournal(file);
    expect(journal.filter((receipt) => receipt['state'] === 'retry-start')).toEqual([
      expect.objectContaining({ entryId: error.id, errorMessage: error.message?.errorMessage })]);
    expect(journal.map((receipt) => receipt['state'])).not.toContain('guard-refused');
    expect(row.state).toBe('settled'); expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])).toHaveLength(1);
  } finally { await f.cleanup(); }
});

it('a real SDK retry after a stream that broke past signed commentary text lets the next tool call run and settles (#483)', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const retryStarts: unknown[] = [];
  const f = await sdkDirectiveExecutionFixture([], (session) => { session.subscribe((event) => { if (event.type === 'auto_retry_start') retryStarts.push(event); }); });
  writeFileSync(join(f.fx.agentDir, 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 1 } }));
  const requests = await registerSyntheticResponses(f.fx.modelRuntime, 'gru-stub', 'stub-model', [
    responsesTruncatedAfterCommentary('Checking the failing test first.'), responsesFunctionCall(2, 'bash', 'after-commentary', { command: 'true' }),
    responsesAnswer('settled after the signed commentary'),
  ]);
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const rows = nativeRows(row.nativeTarget!.sessionFile);
    const error = rows.find((entry) => entry.message?.stopReason === 'error')!;
    expect(retryStarts).toEqual([expect.objectContaining({ attempt: 1, delayMs: 1 })]);
    expect(error.message?.content).toEqual([{ type: 'text', text: 'Checking the failing test first.', textSignature: expect.stringContaining('commentary-item') }]);
    expect(toolResultsOf(rows)).toEqual([['after-commentary|item-2', false]]);
    expect(requests()).toBe(3);
    expect(row.state).toBe('settled'); expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])).toHaveLength(1);
  } finally { await f.cleanup(); }
});

it('a real SDK retry of a truncated stream holding a partial tool call continues: the half-written call never runs, the retried one runs once, and the directive settles (#483)', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const retryStarts: unknown[] = [];
  const f = await sdkDirectiveExecutionFixture([], (session) => { session.subscribe((event) => { if (event.type === 'auto_retry_start') retryStarts.push(event); }); });
  writeFileSync(join(f.fx.agentDir, 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 1 } }));
  const effects = mkdtempSync(join(tmpdir(), 'gru-retry-effect-')); cleanupDirs.push(effects);
  const effect = join(effects, 'ran.log');
  const requests = await registerSyntheticResponses(f.fx.modelRuntime, 'gru-stub', 'stub-model', [
    responsesTruncatedToolCall('bash'), responsesFunctionCall(2, 'bash', 'retried-call', { command: `printf ran >> ${JSON.stringify(effect)}` }),
    responsesAnswer('the retried call ran once'),
  ]);
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const file = row.nativeTarget!.sessionFile;
    const rows = nativeRows(file);
    const error = rows.find((entry) => entry.message?.stopReason === 'error')!;
    // The real parser keeps the half-written call inside the persisted error row.
    expect(error.message?.errorMessage).toContain('stream ended before a terminal response event');
    expect(error.message?.content).toContainEqual(expect.objectContaining({ type: 'toolCall', name: 'bash' }));
    expect(retryStarts).toEqual([expect.objectContaining({ attempt: 1, delayMs: 1, errorMessage: error.message?.errorMessage })]);
    expect(retriedReplies(rows, error)).toEqual(['toolUse']);
    expect(toolResultsOf(rows)).toEqual([['retried-call|item-2', false]]);
    expect(readFileSync(effect, 'utf8')).toBe('ran');
    expect(requests()).toBe(3);
    expect(row.state).toBe('settled'); expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])).toHaveLength(1);
    const journal = producerJournal(file);
    expect(journal.filter((receipt) => receipt['state'] === 'retry-start')).toEqual([
      expect.objectContaining({ entryId: error.id, errorMessage: error.message?.errorMessage })]);
    expect(journal.map((receipt) => receipt['state'])).not.toContain('guard-refused');
  } finally { await f.cleanup(); }
});

it('a real SDK tool call cut off by the output token limit is answered by the SDK, and the next tool call runs once and the directive settles (#483)', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const effects = mkdtempSync(join(tmpdir(), 'gru-length-effect-')); cleanupDirs.push(effects);
  const effect = join(effects, 'ran.log');
  const f = await sdkDirectiveExecutionFixture([
    { deltas: [], toolCall: { id: 'cut-off', name: 'bash', args: { command: `printf cut >> ${JSON.stringify(effect)}` } }, stopReason: 'length' },
    { deltas: [], toolCall: { id: 'after-cut-off', name: 'bash', args: { command: `printf ran >> ${JSON.stringify(effect)}` } } },
    { deltas: ['answered after the output token limit'] },
  ]);
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const file = row.nativeTarget!.sessionFile;
    const rows = nativeRows(file);
    expect(rows.find((entry) => entry.message?.stopReason === 'length')?.message?.content).toContainEqual(expect.objectContaining({ type: 'toolCall', id: 'cut-off' }));
    // The SDK's own "not executed" result answers the cut-off call; only the next one ran.
    expect(toolResultsOf(rows)).toEqual([['cut-off', true], ['after-cut-off', false]]);
    expect(readFileSync(effect, 'utf8')).toBe('ran');
    expect(producerJournal(file).map((receipt) => receipt['state'])).not.toContain('guard-refused');
    expect(row.state).toBe('settled'); expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])).toHaveLength(1);
  } finally { await f.cleanup(); }
});

// Providers that report `stop` with tool calls (e.g. OpenAI-compatible chat
// completions): the stub drives the same SDK agent loop, not a real transport.
it('a real SDK stop row holding a tool call (providers that report stop with tool calls) runs it once, and the directive settles (#483)', async () => {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const effects = mkdtempSync(join(tmpdir(), 'gru-stop-call-effect-')); cleanupDirs.push(effects);
  const effect = join(effects, 'ran.log');
  const f = await sdkDirectiveExecutionFixture([
    { deltas: [], toolCall: { id: 'stop-call', name: 'bash', args: { command: `printf ran >> ${JSON.stringify(effect)}` } }, stopReason: 'stop' },
    { deltas: ['answered after the stop row\'s call'] },
  ]);
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const file = row.nativeTarget!.sessionFile;
    const rows = nativeRows(file);
    expect(rows.find((entry) => entry.message?.role === 'assistant')?.message).toMatchObject({ stopReason: 'stop', content: [expect.objectContaining({ type: 'toolCall', id: 'stop-call' })] });
    expect(toolResultsOf(rows)).toEqual([['stop-call', false]]);
    expect(readFileSync(effect, 'utf8')).toBe('ran');
    expect(producerJournal(file).map((receipt) => receipt['state'])).not.toContain('guard-refused');
    expect(row.state).toBe('settled'); expect(f.scene.ledger.listJobEventsByKinds(row.jobId, ['job.delivered'])).toHaveLength(1);
  } finally { await f.cleanup(); }
});

it('an ordinary turn whose last row is a stop row holding a tool call is no successful completion, like a toolUse row (#483)', async () => {
  for (const stopReason of ['stop', 'toolUse'] as const) {
    let finished = 0;
    const fx = await fixture([{ deltas: [], toolCall: { id: 'finish-call', name: 'finish_now', args: {} }, stopReason }]);
    // Every call in the batch terminates, so the SDK ends the run on that row.
    const nativeTools = [{ name: 'finish_now', description: 'End the run now.', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { finished += 1; return { text: 'finished', terminate: true }; } }];
    const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace, nativeTools });
    try {
      const verdict = await handle.promptWithVerdict!('finish through the tool');
      expect(finished, stopReason).toBe(1);
      expect(verdict, stopReason).toEqual({ ok: false,
        error: `turn settled without a successful completion (stopReason: ${stopReason === 'stop' ? 'stop holding tool calls' : 'toolUse'})` });
    } finally { await handle.dispose(); await fx.runtime.dispose(); fx.store.dispose(); }
  }
});

it('a real SDK row aborted while holding a tool call never runs it: the directive is a failed terminal (#483)', async () => {
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const effects = mkdtempSync(join(tmpdir(), 'gru-aborted-call-effect-')); cleanupDirs.push(effects);
  const effect = join(effects, 'ran.log');
  const fx = await fixture([{ deltas: [], toolCall: { id: 'aborted-call', name: 'bash', args: { command: `printf ran >> ${JSON.stringify(effect)}` } },
    hold: new Promise<void>(() => {}), honorAbort: true }]);
  const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
  const session = await actualDirectiveSdkSession(handle);
  const identity = { requestId: 'aborted-call-directive', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'aborted-call-job', workRevision: 0, authorityEpoch: 0 };
  try {
    const turn = handle.promptWithVerdict!('call a tool, then be aborted', { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } });
    await waitFor(() => fx.script.calls.length === 1, 'held native call');
    await session.abort();
    expect((await turn).ok).toBe(false);
    const rows = nativeRows(handle.sessionFile!);
    const aborted = rows.find((entry) => entry.message?.stopReason === 'aborted')!;
    expect(aborted.message?.content).toContainEqual(expect.objectContaining({ type: 'toolCall', id: 'aborted-call' }));
    expect(toolResultsOf(rows)).toEqual([]);
    expect(existsSync(effect)).toBe(false);
    expect(inspectDirectiveCheckpoint(handle.sessionFile!, identity)).toMatchObject({ state: 'terminal', ok: false, checkpointId: aborted.id });
  } finally { await handle.dispose(); await fx.runtime.dispose(); fx.store.dispose(); }
});

const UNRECORDED_RETRY = 'native SDK retry evidence not recorded; retry-history tool effects remain refused';
/** A directive minion on its own synthetic Responses model outside dispatch,
 * with a 1 ms retry base, its adapter log and its SDK retry starts captured. */
async function retryMinion(bodies: readonly (readonly ResponsesEvent[])[]) {
  const logs: { readonly level: string; readonly msg: string; readonly fields?: Record<string, unknown> }[] = [];
  const fx = await fixture([], ['text'], { log: (level, msg, fields) => logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }) });
  writeFileSync(join(fx.agentDir, 'settings.json'), JSON.stringify({ retry: { baseDelayMs: 1 } }));
  const requests = await registerSyntheticResponses(fx.modelRuntime, 'gru-synthetic-responses', 'synthetic-model', bodies);
  const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace, model: 'gru-synthetic-responses/synthetic-model' });
  const session = await actualDirectiveSdkSession(handle);
  const retryStarts: unknown[] = [];
  session.subscribe((event) => { if (event.type === 'auto_retry_start') retryStarts.push(event); });
  const directive = (requestId: string) => ({ identity: { requestId, payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64),
    jobId: `${requestId}-job`, workRevision: 0, authorityEpoch: 0 }, beforeAdmission: () => {}, onAdmitted: () => {} });
  const dispose = async () => { await handle.dispose(); await fx.runtime.dispose(); fx.store.dispose(); };
  return { logs, requests, handle, session, retryStarts, directive, dispose };
}

it('a real SDK retry whose failed reply the cache warmer followed still records its retry-start receipt, and the retried tool runs (#521)', async () => {
  const effects = mkdtempSync(join(tmpdir(), 'gru-retry-effect-')); cleanupDirs.push(effects);
  const effect = join(effects, 'ran.log');
  const m = await retryMinion([responsesTruncated, responsesFunctionCall(2, 'bash', 'after-warm-leaf', { command: `printf ran >> ${JSON.stringify(effect)}` }), responsesAnswer('done after the warm entry')]);
  const request = m.directive('warm-leaf-retry');
  // Pi's cache warmer appends a usage entry on a timer: here it becomes the
  // branch's leaf between the failed reply and the retry's start.
  let warmed = false;
  m.session.subscribe((event) => {
    if (event.type === 'agent_end' && !warmed) {
      warmed = true;
      m.session.sessionManager.appendUsage('cache_warm', 'gru-synthetic-responses', 'synthetic-model',
        { input: 1, output: 1, cacheRead: 9, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
    }
  });
  try {
    const verdict = await m.handle.promptWithVerdict!('synthetic native retry investigation', { directive: request });
    const file = m.handle.sessionFile!;
    expect(warmed).toBe(true);
    expect(nativeRows(file).some((row) => row.type === 'usage')).toBe(true);
    const error = nativeRows(file).find((entry) => entry.message?.stopReason === 'error')!;
    expect(producerJournal(file).filter((receipt) => receipt['state'] === 'retry-start')).toEqual([expect.objectContaining({ entryId: error.id })]);
    expect(m.logs.filter((entry) => entry.msg === UNRECORDED_RETRY)).toEqual([]);
    expect(readFileSync(effect, 'utf-8')).toBe('ran');
    expect(verdict).toMatchObject({ ok: true });
  } finally {
    await m.dispose();
  }
});

it('a real SDK retry of an error row holding an unknown block records no evidence, says why, and refuses the next tool by the error row\'s own reason (#483)', async () => {
  const effects = mkdtempSync(join(tmpdir(), 'gru-retry-effect-')); cleanupDirs.push(effects);
  const effect = join(effects, 'ran.log');
  const m = await retryMinion([responsesTruncated, responsesFunctionCall(2, 'bash', 'refused-call', { command: `printf ran >> ${JSON.stringify(effect)}` })]);
  // Before pi persists the error row, give it a block that is not retry history.
  m.session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') {
      (event.message.content as unknown[]).push({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    }
  });
  const { directive } = m;
  const request = directive('unknown-block-retry');
  try {
    const verdict = await m.handle.promptWithVerdict!('synthetic native retry investigation', { directive: request });
    const file = m.handle.sessionFile!;
    const rows = nativeRows(file);
    expect(rows.find((entry) => entry.message?.stopReason === 'error')?.message?.content).toContainEqual(expect.objectContaining({ type: 'image' }));
    expect(m.retryStarts).toEqual([expect.objectContaining({ attempt: 1, delayMs: 1 })]);
    expect(m.logs).toContainEqual({ level: 'warn', msg: UNRECORDED_RETRY,
      fields: { requestId: request.identity.requestId, reason: 'native branch tail is not an error row of retry-history content carrying this retry\'s error' } });
    expect(toolResultsOf(rows)).toEqual([['refused-call|item-2', true]]);
    expect(existsSync(effect)).toBe(false);
    expect(verdict.ok).toBe(false);
    expect(m.requests()).toBe(2);
    const journal = producerJournal(file);
    expect(journal.map((receipt) => receipt['state'])).not.toContain('retry-start');
    expect(journal).toContainEqual(expect.objectContaining({ state: 'guard-refused', reason: expect.stringContaining('native error row has no matching live SDK retry-start receipt') }));
  } finally { await m.dispose(); }
});

/** Tears `m`'s producer journal from the provider error row's end through
 * the SDK's auto_retry_start, which the adapter sees first, and heals it
 * before the retried request. `heal` removes only the torn fragment, never a
 * line appended after it. */
function tearJournalThroughRetryStart(m: Awaited<ReturnType<typeof retryMinion>>): () => void {
  const journalPath = () => `${m.handle.sessionFile!}.producers.jsonl`;
  const torn = '{"state":"torn-by-this-test"';
  const heal = () => { if (existsSync(journalPath())) writeFileSync(journalPath(), readFileSync(journalPath(), 'utf8').replace(torn, '')); };
  let tore = false;
  m.session.subscribe((event) => {
    if (!tore && event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') {
      tore = true;
      appendFileSync(journalPath(), torn);
    }
    if (event.type === 'auto_retry_start') heal();
  });
  return heal;
}
const expectUnreadableJournalWarn = (m: Awaited<ReturnType<typeof retryMinion>>, requestId: string) =>
  expect(m.logs).toContainEqual({ level: 'warn', msg: UNRECORDED_RETRY, fields: { requestId, error: expect.stringContaining('native producer journal has a partial write') } });

it('a real SDK retry whose producer journal cannot be read logs the error, and the directive stays fail-closed at its next tool (#483)', async () => {
  const effects = mkdtempSync(join(tmpdir(), 'gru-retry-effect-')); cleanupDirs.push(effects);
  const effect = join(effects, 'ran.log');
  const m = await retryMinion([responsesTruncated, responsesFunctionCall(2, 'bash', 'after-torn-journal', { command: `printf ran >> ${JSON.stringify(effect)}` })]);
  const request = m.directive('unreadable-journal-retry');
  const heal = tearJournalThroughRetryStart(m);
  const events = collect(m.handle);
  try {
    const verdict = await m.handle.promptWithVerdict!('synthetic native retry investigation', { directive: request });
    // The failed receipt routes nothing of its own: the errors and error states are the
    // provider's retried truncation, then the guard's tagged refusal.
    const truncated = 'OpenAI Responses stream ended before a terminal response event';
    const refused = 'native directive admission/guard failed; further tool effects refused: DirectiveCheckpointError: native error row has no matching live SDK retry-start receipt';
    expect(events.filter((event) => event.type === 'error' || (event.type === 'state' && event.state === 'error'))).toEqual([
      { type: 'error', error: truncated, fatal: false, provider: 'gru-synthetic-responses', model: 'synthetic-model' },
      { type: 'state', state: 'error', error: truncated },
      { type: 'error', error: refused, fatal: false, nativeControl: 'directive-refusal' },
      { type: 'state', state: 'error', error: refused },
    ]);
    expect(m.retryStarts).toEqual([expect.objectContaining({ attempt: 1, delayMs: 1 })]);
    expectUnreadableJournalWarn(m, request.identity.requestId);
    // Fail-closed: no receipt, so the guard refused the retried call, by name.
    expect(verdict).toMatchObject({ ok: false, error: expect.stringContaining('native error row has no matching live SDK retry-start receipt') });
    expect(existsSync(effect)).toBe(false);
    const journal = producerJournal(m.handle.sessionFile!);
    expect(journal.map((receipt) => receipt['state'])).not.toContain('retry-start');
    expect(journal).toContainEqual(expect.objectContaining({ state: 'guard-refused', reason: expect.stringContaining('native error row has no matching live SDK retry-start receipt') }));
    expect(m.requests()).toBe(2);
  } finally {
    heal(); // disposal records cessation in a readable journal
    await m.dispose();
  }
});

it('a real SDK retry whose producer journal cannot be read logs the error, and a plain retried answer still leaves the directive not ok (#483)', async () => {
  const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const m = await retryMinion([responsesTruncated, responsesAnswer('answered after the retry')]);
  const request = m.directive('unreadable-journal-plain-retry');
  const heal = tearJournalThroughRetryStart(m);
  try {
    const verdict = await m.handle.promptWithVerdict!('synthetic native retry investigation', { directive: request });
    expect(m.retryStarts).toEqual([expect.objectContaining({ attempt: 1, delayMs: 1 })]);
    expectUnreadableJournalWarn(m, request.identity.requestId);
    // The answer's completion receipt found no terminal proof, and that error is the verdict's.
    expect(verdict).toEqual({ ok: false, error: 'DirectiveCheckpointError: native completion checkpoint/producer unavailable' });
    // The journal reads again; without a receipt the answer follows the error row's terminal.
    expect(inspectDirectiveCheckpoint(m.handle.sessionFile!, request.identity)).toEqual({ state: 'unknown',
      reason: 'native entries follow the correlated terminal checkpoint without a distinct bound request' });
    expect(producerJournal(m.handle.sessionFile!).map((receipt) => receipt['state'])).not.toContain('retry-start');
    expect(m.requests()).toBe(2);
  } finally {
    heal(); // disposal records cessation in a readable journal
    await m.dispose();
  }
});

it('a real SDK retry whose receipt write throws a value that cannot be printed logs it by name, and the directive stays fail-closed (#485)', async () => {
  const checkpoint = await import('../src/runtime/directive-checkpoint.js');
  const effects = mkdtempSync(join(tmpdir(), 'gru-retry-effect-')); cleanupDirs.push(effects);
  const effect = join(effects, 'ran.log');
  const m = await retryMinion([responsesTruncated, responsesFunctionCall(2, 'bash', 'after-unprintable-receipt', { command: `printf ran >> ${JSON.stringify(effect)}` })]);
  const request = m.directive('unprintable-retry-receipt');
  const receipt = vi.spyOn(checkpoint, 'recordDirectiveRetryStart').mockImplementation(() => { const thrown: unknown = Object.create(null); throw thrown; });
  try {
    const verdict = await m.handle.promptWithVerdict!('synthetic native retry investigation', { directive: request });
    expect(m.retryStarts).toEqual([expect.objectContaining({ attempt: 1, delayMs: 1 })]);
    expect(m.logs).toContainEqual({ level: 'warn', msg: UNRECORDED_RETRY,
      fields: { requestId: request.identity.requestId, error: 'a non-error value was thrown: an unprintable value' } });
    expect(verdict).toMatchObject({ ok: false, error: expect.stringContaining('native error row has no matching live SDK retry-start receipt') });
    expect(existsSync(effect)).toBe(false);
  } finally { receipt.mockRestore(); await m.dispose(); }
});

it('a real SDK retry with no live directive writes no retry evidence (#483)', async () => {
  const m = await retryMinion([responsesAnswer('the directive finished'), responsesTruncated, responsesAnswer('the plain turn finished')]);
  try {
    expect(await m.handle.promptWithVerdict!('a directive first', { directive: m.directive('before-plain-retry') })).toMatchObject({ ok: true });
    expect(await m.handle.promptWithVerdict!('then an ordinary turn')).toMatchObject({ ok: true });
    expect(m.retryStarts).toEqual([expect.objectContaining({ attempt: 1, delayMs: 1 })]);
    expect(m.requests()).toBe(3);
    const states = producerJournal(m.handle.sessionFile!).map((receipt) => receipt['state']);
    expect(states).toContain('started');
    expect(states).not.toContain('retry-start');
    expect(m.logs.filter((log) => log.msg === UNRECORDED_RETRY)).toEqual([]);
  } finally { await m.dispose(); }
});

async function assertHistoricalSdkBoundary(mode: 'parked' | 'null' | 'held' | 'owner-stop' | 'foreign' | 'older-unknown' | 'current-lock' | 'live-producer' | 'reservation' | 'multiple' | 'rebrief' | 'rebrief-missing' | 'missing-head' | 'parked-missing-head') {
  const { executeAcceptedDirective, DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['genuine past original completion'], hold }], undefined, false, false, mode === 'rebrief' || mode === 'rebrief-missing'); const stop = new AbortController();
  const actual = f.scene.ledger.appendCustomEventIfCurrentDirective.bind(f.scene.ledger);
  const loss = vi.spyOn(f.scene.ledger, 'appendCustomEventIfCurrentDirective').mockImplementation((fields, identity) => { if (fields.kind === 'job.delivered' || mode === 'rebrief-missing' && fields.kind === 'silas.rebrief') { stop.abort(); throw new Error('original delivery callback lost during shutdown'); } return actual(fields, identity); });
  let moved = false; let service: InstanceType<typeof DirectiveProgressService> | undefined; let reservation: (() => void) | undefined;
  try {
    const running = executeAcceptedDirective({ ...f.deps, signal: stop.signal }, f.scene.request.requestId);
    await waitFor(() => f.fx.script.calls.length === 1, 'P39 original actual SDK acceptance');
    if (mode === 'null') { renameSync(f.scene.lane.path, `${f.scene.lane.path}.missing`); moved = true; }
    release(); await running; loss.mockRestore();
    if (moved) { renameSync(`${f.scene.lane.path}.missing`, f.scene.lane.path); moved = false; }
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!; const originalIdentity = f.scene.ledger.directiveTurnIdentity(row.requestId);
    expect(row.state).toBe('admitted');
    if (mode === 'multiple') {
      const owner = await f.registry.spawn('minion', { cwd: f.scene.lane.path, agentId: row.nativeTarget!.agentId, resumeFile: row.nativeTarget!.sessionFile });
      expect(owner.prepareDirectiveProducer).toBeTypeOf('function'); owner.prepareDirectiveProducer!(originalIdentity);
      await f.registry.disposeHandle(owner);
      const { inspectDirectiveProducers } = await import('../src/runtime/directive-checkpoint.js');
      expect(inspectDirectiveProducers(row.nativeTarget!.sessionFile, originalIdentity)).toHaveLength(2);
    }
    const originalRebrief = f.scene.ledger.latestJobEventByRequestId(row.jobId, 'silas.rebrief', row.requestId);
    if (mode === 'rebrief') expect(originalRebrief?.payload).toMatchObject({ rule_id: row.sourceContext!.ruleId, source_round_id: row.sourceContext!.sourceRoundId });
    if (mode === 'rebrief-missing') expect(originalRebrief).toBeNull();
    const originalPhase = f.scene.ledger.findPhaseHandoffByRequest({ jobId: row.jobId, requestId: row.requestId });
    if (mode === 'missing-head' || mode === 'parked-missing-head') {
      // Fault-inject loss of the original HEAD receipt only. Keep every
      // original start/cessation byte; recovery never recreates completion.
      const journal = `${row.nativeTarget!.sessionFile}.producers.jsonl`;
      const rows = readFileSync(journal, 'utf8').trimEnd().split('\n');
      expect(rows.some((line) => (JSON.parse(line) as { state: string }).state === 'completed')).toBe(true);
      writeFileSync(journal, rows.filter((line) => (JSON.parse(line) as { state: string }).state !== 'completed').join('\n') + '\n');
    }
    if (mode === 'parked' || mode === 'parked-missing-head') f.scene.ledger.setJobStatus(row.jobId, 'parked');
    else f.scene.ledger.addJobAmendment({ jobId: row.jobId, body: 'changed approved current input', effect: 'administrative', supersedes: [], approval: { by: 'owner', reference: 'P39-boundaries' }, expectedContractSha256: originalIdentity.contractSha256 });
    if (mode === 'held' || mode === 'owner-stop') { const debt = f.scene.ledger.recordBlockedObservation(row.jobId, { logicalStep: 'operation', incidentKey: mode === 'held' ? `directive-recovery:${row.requestId}` : 'P39-owner-stop', observedAtSeq: f.scene.ledger.latestEventSeq(), category: { kind: 'known', category: 'restart-recovery' }, nextAction: mode === 'held' ? { kind: 'gru-decision', decision: 'retain suspended original context' } : { kind: 'owner-decision', decision: 'real original owner stop stays held' } }); if (mode === 'held') f.scene.ledger.suspendObligation(debt.id, 'explicit original hold'); }
    if (mode === 'current-lock') writeFileSync(`${row.nativeTarget!.sessionFile}.lock`, JSON.stringify({ host: 'foreign', pid: process.pid, bootId: 'foreign' }));
    if (mode === 'foreign' || mode === 'older-unknown') { const path = `${row.nativeTarget!.sessionFile}.producers.jsonl`; const records = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { state: string; producer: Record<string, unknown> }); const start = records.find((record) => record.state === 'started')!; writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ ...start, producer: { ...start.producer, incarnation: 'P39-unproven-incarnation', ...(mode === 'foreign' ? { agentId: 'foreign-minion' } : { host: 'unproven-host' }) } }) + '\n'); }
    if (mode === 'live-producer') { f.scene.ledger.registerAgent({ id: 'P39-other-live', role: 'minion', jobId: row.jobId, sessionFile: null }); f.scene.ledger.setAgentState('P39-other-live', 'streaming'); }
    if (mode === 'reservation') reservation = f.scene.ledger.beginJobAdmission(row.jobId, 'independent reserved producer');
    const job = f.scene.ledger.getJob(row.jobId)!; const bytes = readFileSync(row.nativeTarget!.sessionFile, 'utf8');
    const physicalBytes = readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8');
    const spawn = vi.spyOn(f.registry, 'spawn'); spawn.mockClear();
    service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); service.reconsider(); await service.settled();
    const positive = mode === 'parked' || mode === 'null' || mode === 'multiple' || mode === 'rebrief' || mode === 'rebrief-missing' || mode === 'missing-head' || mode === 'parked-missing-head';
    expect(f.scene.ledger.getDirective(row.requestId)?.state).toBe(positive ? 'settled' : 'admitted'); expect(spawn).not.toHaveBeenCalled(); expect(f.scene.ledger.getJob(row.jobId)).toEqual(job); expect(readFileSync(row.nativeTarget!.sessionFile, 'utf8')).toBe(bytes);
    const delivery = f.scene.ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId);
    if (mode === 'missing-head' || mode === 'parked-missing-head') {
      expect(readFileSync(`${row.nativeTarget!.sessionFile}.producers.jsonl`, 'utf8')).toBe(physicalBytes);
      expect((delivery!.payload as { native_completion: { receipt: unknown } }).native_completion.receipt).toBeNull();
      expect(f.scene.ledger.latestCandidateDelivery(row.jobId)).toBeNull();
    }
    if (positive) { expect(delivery?.payload).toMatchObject({ historical_bookkeeping_only: true, candidate_delivery_proven: false, native_completion: { identity: originalIdentity } }); if (mode === 'null' || mode === 'missing-head' || mode === 'parked-missing-head') expect((delivery!.payload as { sha: unknown }).sha).toBeNull(); expect(f.scene.ledger.workRevisionState(row.jobId).delivered).toBe(0); expect(f.scene.ledger.latestJobEvent(row.jobId, 'silas.directive-current-gates-owed')).not.toBeNull(); }
    else expect(delivery).toBeNull();
    if (mode === 'rebrief' || mode === 'rebrief-missing') {
      const receipt = f.scene.ledger.latestJobEventByRequestId(row.jobId, 'silas.rebrief', row.requestId)!;
      expect(receipt.payload).toMatchObject({ request_id: row.requestId, minion_id: row.nativeTarget!.agentId, phase_id: originalPhase!.phaseId, rule_id: row.sourceContext!.ruleId, source_round_id: row.sourceContext!.sourceRoundId });
      if (mode === 'rebrief') expect(receipt).toEqual(originalRebrief);
      expect(f.scene.ledger.getDirective(row.requestId)?.sourceContext).toEqual(row.sourceContext); expect(f.scene.ledger.listPendingRebriefs({ jobId: row.jobId })).toEqual([]);
      expect((delivery!.payload as { phase_id: string }).phase_id).toBe(originalPhase!.phaseId);
      expect(f.scene.ledger.findPhaseHandoffByRequest({ jobId: row.jobId, requestId: row.requestId })).toEqual(originalPhase);
    }
    const { LedgerDb } = await import('../src/ledger/db.js'); const { LedgerApi } = await import('../src/ledger/api.js'); const db = new LedgerDb(f.scene.dir); try { const ledger = new LedgerApi(db.handle); expect(ledger.getDirective(row.requestId)?.state).toBe(positive ? 'settled' : 'admitted'); expect(ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId)).toEqual(delivery); } finally { db.close(); }
  } finally { release(); loss.mockRestore(); reservation?.(); if (moved) renameSync(`${f.scene.lane.path}.missing`, f.scene.lane.path); await service?.dispose(); await f.cleanup(); }
}

it('P39 actual original SDK historical completion preserves parked boundary through restart without native replay', () => assertHistoricalSdkBoundary('parked'));
it('P39 actual original SDK historical completion preserves null boundary through restart without native replay', () => assertHistoricalSdkBoundary('null'));
it('P55 actual SDK historical completion retains truthful null HEAD after original receipt loss and restart', () => assertHistoricalSdkBoundary('missing-head'));
it('P55 actual SDK parked historical completion retains truthful null HEAD without replay or sidecar backfill', () => assertHistoricalSdkBoundary('parked-missing-head'));
it('P39 actual original SDK historical completion preserves held boundary through restart without native replay', () => assertHistoricalSdkBoundary('held'));
it('P39 actual original SDK historical completion preserves owner-stop boundary through restart without native replay', () => assertHistoricalSdkBoundary('owner-stop'));
it('P39 actual original SDK historical completion preserves foreign boundary through restart without native replay', () => assertHistoricalSdkBoundary('foreign'));
it('P39 actual original SDK historical completion preserves older-unknown boundary through restart without native replay', () => assertHistoricalSdkBoundary('older-unknown'));
it('P39 actual original SDK historical completion preserves current-lock boundary through restart without native replay', () => assertHistoricalSdkBoundary('current-lock'));
it('P39 actual original SDK historical completion preserves live-producer boundary through restart without native replay', () => assertHistoricalSdkBoundary('live-producer'));
it('P39 actual original SDK historical completion preserves reservation boundary through restart without native replay', () => assertHistoricalSdkBoundary('reservation'));
it('P39 genuinely resumed and disposed second SDK incarnation preserves original completion without replay', () => assertHistoricalSdkBoundary('multiple'));
it('P39 actual accepted SDK rebrief retains real original receipt and source-context pointers through historical bookkeeping', () => assertHistoricalSdkBoundary('rebrief'));
it('P39 missing original SDK rebrief receipt is restored with exact accepted source-context and phase pointers without release', () => assertHistoricalSdkBoundary('rebrief-missing'));

it('P39 guarded single-flight then genuinely newer SDK candidate preserves historical replay and ordinary unknown-HEAD fence', async () => {
  const { executeAcceptedDirective, DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['original native completed before shutdown'] }, { deltas: ['genuine later current native completion'] }]);
  const stop = new AbortController(); const originalAppend = f.scene.ledger.appendCustomEventIfCurrentDirective.bind(f.scene.ledger);
  const loss = vi.spyOn(f.scene.ledger, 'appendCustomEventIfCurrentDirective').mockImplementation((fields, identity) => { if (fields.kind === 'job.delivered') { stop.abort(); throw new Error('old ledger delivery lost after native completion'); } return originalAppend(fields, identity); });
  let service: InstanceType<typeof DirectiveProgressService> | undefined;
  try {
    await executeAcceptedDirective({ ...f.deps, signal: stop.signal }, f.scene.request.requestId); loss.mockRestore();
    const original = f.scene.ledger.getDirective(f.scene.request.requestId)!; const before = readFileSync(original.nativeTarget!.sessionFile, 'utf8');
    expect(() => f.scene.ledger.beginDirectiveIntent({ jobId: original.jobId, requestId: 'cannot-bypass-live-original', directive: 'new current work', holder: 'gru' })).toThrow(/already live/);
    expect(f.fx.script.calls).toHaveLength(1); expect(readFileSync(original.nativeTarget!.sessionFile, 'utf8')).toBe(before);
    f.scene.ledger.addJobAmendment({ jobId: original.jobId, body: 'new material accepted current scope', effect: 'material', supersedes: [], approval: { by: 'owner', reference: 'P39-current' }, expectedContractSha256: original.contractSha256! });
    service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    const historic = f.scene.ledger.getDirective(original.requestId)!; expect(historic.state).toBe('settled');
    const root = f.scene.ledger.latestJobEvent(original.jobId, 'silas.directive-current-gates-owed')!;
    const current = f.scene.ledger.beginRebriefIntent({ jobId: original.jobId, requestId: 'genuine-current-native', note: 'perform newly accepted current material scope', holder: 'gru' }).record;
    await executeAcceptedDirective(f.deps, current.requestId);
    const accepted = f.scene.ledger.getDirective(current.requestId)!; expect(accepted.state).toBe('settled'); expect(accepted.admissionSeq!).toBeGreaterThan(root.seq);
    const candidate = f.scene.ledger.latestCandidateDelivery(original.jobId)!; expect(candidate.seq).toBe(accepted.deliverySeq); expect(candidate.payload).toMatchObject({ work_revision: 1, candidate_delivery_proven: true, native_completion: { identity: f.scene.ledger.directiveTurnIdentity(current.requestId) } });
    for (let replay = 0; replay < 2; replay += 1) { f.scene.ledger.recordDirectiveDelivery({ requestId: original.requestId, eventSeq: historic.deliverySeq! }); service.reconsider(); await service.settled(); expect(f.scene.ledger.latestCandidateDelivery(original.jobId)).toEqual(candidate); expect(f.scene.ledger.workRevisionState(original.jobId)).toEqual({ required: 1, delivered: 1 }); expect(f.scene.ledger.getEvent(root.seq)).toEqual(root); }
    expect(f.fx.script.calls).toHaveLength(2); expect(readFileSync(original.nativeTarget!.sessionFile, 'utf8')).toBe(before);
    const unknown = f.scene.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: original.jobId, payload: { work_revision: 1, sha: null, candidate_delivery_proven: false } });
    expect(f.scene.ledger.latestCandidateDelivery(original.jobId)).toEqual(candidate); expect(f.scene.ledger.workRevisionState(original.jobId).delivered).toBe(1);
    expect(f.scene.ledger.latestJobEvent(original.jobId, 'job.delivered')?.seq).toBe(unknown.seq);
    expect(f.scene.ledger.correctiveVerificationDebt(original.jobId)).toEqual({ revision: 1, head: null });
    const callerFlag = f.scene.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: original.jobId, payload: { request_id: original.requestId, work_revision: 1, sha: null, candidate_delivery_proven: false, historical_bookkeeping_only: true } });
    expect(f.scene.ledger.latestCandidateDelivery(original.jobId)).toEqual(candidate);
    expect(f.scene.ledger.latestJobEvent(original.jobId, 'job.delivered')?.seq).toBe(callerFlag.seq);
    expect(f.scene.ledger.correctiveVerificationDebt(original.jobId)).toEqual({ revision: 1, head: null });
  } finally { loss.mockRestore(); await service?.dispose(); await f.cleanup(); }
});

it('P39 genuine original SDK completion after amendment records historical-only progress without replacing a newer candidate', async () => {
  const { executeAcceptedDirective, DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['genuine original native completion before amendment'] }]);
  const actual = f.scene.ledger.appendCustomEventIfCurrentDirective.bind(f.scene.ledger);
  const loss = vi.spyOn(f.scene.ledger, 'appendCustomEventIfCurrentDirective').mockImplementation((fields, identity) => {
    if (fields.kind === 'job.delivered') throw new Error('P39 original delivery callback lost before ledger commit'); return actual(fields, identity);
  });
  let service: InstanceType<typeof DirectiveProgressService> | undefined;
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId); loss.mockRestore();
    const identity = f.scene.identity; const original = f.scene.ledger.getDirective(identity.requestId)!;
    expect(original.state).toBe('admitted');
    f.scene.ledger.addJobAmendment({ jobId: identity.jobId, body: 'genuinely changed owner accepted scope', supersedes: [], approval: { by: 'owner', reference: 'P39' }, effect: 'material', expectedContractSha256: identity.contractSha256 });
    const newer = f.scene.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: identity.jobId, payload: { agentId: 'different-current-minion', sha: 'd'.repeat(40), work_revision: 1 } });
    const job = f.scene.ledger.getJob(identity.jobId)!; const spawn = vi.spyOn(f.registry, 'spawn'); spawn.mockClear();
    service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.scene.ledger.getDirective(identity.requestId)?.state).toBe('settled'); expect(spawn).not.toHaveBeenCalled();
    expect(f.scene.ledger.getJob(identity.jobId)).toEqual(job); expect(f.scene.ledger.latestCandidateDelivery(identity.jobId)?.seq).toBe(newer.seq);
    expect(f.scene.ledger.workRevisionState(identity.jobId)).toEqual({ required: 1, delivered: 1 });
    const delivery = f.scene.ledger.latestJobEventByRequestId(identity.jobId, 'job.delivered', identity.requestId)!;
    expect(delivery.payload).toMatchObject({ historical_bookkeeping_only: true, candidate_delivery_proven: false, work_revision: 0, native_completion: { identity } });
    const root = f.scene.ledger.latestJobEvent(identity.jobId, 'silas.directive-current-gates-owed')!;
    const duty = f.scene.ledger.getObligation((root.payload as { obligation_id: string }).obligation_id)!;
    expect(duty.state).toBe('open'); expect(root.payload).toMatchObject({ root_kind: 'original-native-completion', request_id: identity.requestId, delivery_seq: delivery.seq, identity });
    expect(() => f.scene.ledger.settleObligation({ obligationId: duty.id, settlement: { kind: 'executed-action', action: 'old completion is not current gates', evidenceEventSeq: delivery.seq, evidenceEventKind: delivery.kind } })).toThrow(/current gate duty/);
    service.reconsider(); await service.settled(); expect(f.scene.ledger.listJobEventsByKinds(identity.jobId, ['silas.directive-current-gates-owed'])).toHaveLength(1);
    const unknown = f.scene.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: identity.jobId, payload: { sha: null, work_revision: 1, candidate_delivery_proven: false } });
    expect(f.scene.ledger.latestCandidateDelivery(identity.jobId)?.seq).toBe(newer.seq); expect(f.scene.ledger.workRevisionState(identity.jobId).delivered).toBe(1);
    expect(f.scene.ledger.latestJobEvent(identity.jobId, 'job.delivered')?.seq).toBe(unknown.seq);
    expect(f.scene.ledger.correctiveVerificationDebt(identity.jobId)).toEqual({ revision: 1, head: null });
  } finally { loss.mockRestore(); await service?.dispose(); await f.cleanup(); }
});

it('P36 actual production fallback wrapper forwards native claim refusal and then claims the same SDK continuation exactly once', async () => {
  const { withFallbacks } = await import('../src/runtime/fallbacks.js');
  const { DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['original checkpoint genuinely finished through wrapper'] }]);
  let service: InstanceType<typeof DirectiveProgressService> | undefined;
  try {
    await seedSdkUserCheckpoint(f);
    const spawn = f.registry.spawn.bind(f.registry);
    vi.spyOn(f.registry, 'spawn').mockImplementation(async (role, options) => {
      const handle = await spawn(role, options);
      const fallback = withFallbacks({ id: 'pi', capabilities: { ...handle.capabilities, steer: 'queued' },
        spawn: async () => handle, health: () => f.fx.runtime.health(), dispose: async () => {} });
      return fallback.spawn(role, options);
    });
    const claim = vi.spyOn(f.scene.ledger, 'claimDirectiveCheckpoint').mockImplementation(() => { throw new Error('P36 durable native claim refused'); });
    service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(claim).toHaveBeenCalledTimes(1); expect(f.sessions.at(-1)!.agent.continue).not.toHaveBeenCalled();
    expect(f.scene.ledger.getDirective(f.scene.request.requestId)?.recoveryCheckpoint).toBeNull();
    claim.mockRestore(); const actualClaim = vi.spyOn(f.scene.ledger, 'claimDirectiveCheckpoint');
    service.reconsider(); await service.settled();
    expect(actualClaim).toHaveBeenCalledTimes(1); expect(f.sessions.at(-1)!.agent.continue).toHaveBeenCalledTimes(1);
    expect(f.sessions.every((session) => vi.mocked(session.prompt).mock.calls.length === 0)).toBe(true);
    expect(f.scene.ledger.getDirective(f.scene.request.requestId)?.state).toBe('settled');
    service.reconsider(); await service.settled(); expect(actualClaim).toHaveBeenCalledTimes(1);
  } finally { await service?.dispose(); await f.cleanup(); }
});

async function assertNativeCompletionHeadLengths(boundary: 'writer' | 'reader'): Promise<void> {
  const { executeAcceptedDirective } = await import('../src/dispatch/directive-progress.js');
  const { readDirectiveCompletion, recordDirectiveCompletion, inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
  const f = await sdkDirectiveExecutionFixture([{ deltas: ['real original native completion'] }]);
  try {
    await executeAcceptedDirective(f.deps, f.scene.request.requestId);
    const row = f.scene.ledger.getDirective(f.scene.request.requestId)!;
    const proof = inspectDirectiveCheckpoint(row.nativeTarget!.sessionFile, f.scene.identity);
    if (proof.state !== 'terminal') throw new Error('P40 requires real SDK terminal completion');
    const receipt = readDirectiveCompletion(row.nativeTarget!.sessionFile, f.scene.identity, proof.checkpointId)!;
    const journal = `${row.nativeTarget!.sessionFile}.producers.jsonl`; const original = readFileSync(journal, 'utf8');
    for (const length of [41, 48, 63]) {
      const entries = original.trimEnd().split('\n').map((line) => JSON.parse(line) as { state: string; head?: string | null });
      if (boundary === 'writer') {
        const before = entries.filter((entry) => entry.state !== 'completed').map((entry) => JSON.stringify(entry)).join('\n') + '\n';
        writeFileSync(journal, before);
        expect(() => recordDirectiveCompletion(receipt.producer, proof.checkpointId, 'a'.repeat(length))).toThrow(/HEAD malformed/);
        expect(readFileSync(journal, 'utf8')).toBe(before);
      } else {
        for (const entry of entries) if (entry.state === 'completed') entry.head = 'a'.repeat(length);
        writeFileSync(journal, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        expect(() => readDirectiveCompletion(row.nativeTarget!.sessionFile, f.scene.identity, proof.checkpointId)).toThrow(/malformed native completion HEAD/);
      }
      writeFileSync(journal, original);
    }
    for (const head of ['a'.repeat(40), 'b'.repeat(64), null]) {
      const entries = original.trimEnd().split('\n').map((line) => JSON.parse(line) as { state: string; head?: string | null });
      for (const entry of entries) if (entry.state === 'completed') entry.head = head;
      writeFileSync(journal, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      expect(readDirectiveCompletion(row.nativeTarget!.sessionFile, f.scene.identity, proof.checkpointId)?.head).toBe(head);
      expect(() => recordDirectiveCompletion(receipt.producer, proof.checkpointId, head)).not.toThrow();
      writeFileSync(journal, original);
    }
  } finally { await f.cleanup(); }
}
it('P40 original native completion writer rejects intermediate Git ID lengths and preserves exact SHA1 SHA256 null', () => assertNativeCompletionHeadLengths('writer'));
it('P40 durable native completion reader rejects intermediate Git ID lengths and preserves exact SHA1 SHA256 null', () => assertNativeCompletionHeadLengths('reader'));

describe('scheduled verification ordinary Pi Bash', () => {
  interface RefusalCaseFixtureIdentity {
    readonly laneRoot: string;
    readonly lanePath: string;
    readonly laneId: string;
    readonly branch: string | null;
    readonly producerStarts: string;
    readonly laneFixtureSetupMs: number;
    readonly home: string;
    readonly dataDir: string;
    readonly transcript: string;
    readonly modelScript: StubScript;
    readonly workerSession: ReturnType<typeof verificationLane>['session'];
  }

  async function refuses(
    input: string | ((cwd: string) => string),
    quality = false,
    template?: Parameters<typeof verificationLane>[1],
  ): Promise<RefusalCaseFixtureIdentity> {
    const laneSetupStarted = performance.now();
    const lane = verificationLane(quality, template);
    const laneFixtureSetupMs = performance.now() - laneSetupStarted;
    cleanupDirs.push(lane.root);
    const command = typeof input === 'string' ? input : input(lane.lane.path);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const f = await fixture([
      { deltas: [], toolCall: { id: 'verification-call', name: 'bash', args: { command } } },
      { deltas: ['settled'] },
    ]);
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      await handle.prompt('attempt ordinary Bash');
      expect(existsSync(lane.starts)).toBe(false);
      const transcriptPath = handle.sessionFile;
      if (transcriptPath === null) throw new Error('refusal case did not create an ordinary Pi transcript');
      const transcript = readFileSync(transcriptPath, 'utf8');
      expect(transcript).toContain('capture-cli.js');
      expect(transcript).toContain('focused, full');
      expect(transcript).toContain('no receipt was created');
      await handle.dispose();
      return {
        laneRoot: lane.root, lanePath: lane.lane.path, laneId: lane.lane.id, branch: lane.lane.branch,
        producerStarts: lane.starts, laneFixtureSetupMs, home: f.home, dataDir: f.config.dataDir, transcript: transcriptPath,
        modelScript: f.script, workerSession: lane.session,
      };
    } finally { process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  }
  it('scheduled verification guard refuses the exact web incident before any producer', async () => refuses(WEB_INCIDENT));
  it('scheduled verification guard refuses the exact npm test incident before any producer', async () => refuses(FULL_INCIDENT));
  it('scheduled verification guard refuses the entire exact build compound before its first producer', async () => refuses(BUILD_INCIDENT));
  it('a directive whose minion is refused a test command is ordinary work: the minion goes on and the directive completes #contract:directive-tool-error:pi', async () => {
    const { inspectDirectiveCheckpoint } = await import('../src/runtime/directive-checkpoint.js');
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const f = await fixture([
      { deltas: [], toolCall: { id: 'verification-call', name: 'bash', args: { command: FULL_INCIDENT } } },
      { deltas: [], toolCall: { id: 'after-refusal', name: 'bash', args: { command: 'true' } } },
      { deltas: ['scheduled the scope instead'] },
    ]);
    const identity = { requestId: 'verification-refused-directive', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64),
      jobId: 'verification-refused-job', workRevision: 0, authorityEpoch: 0 };
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      const verdict = await handle.promptWithVerdict!('a directive in a verification lane', { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } });
      expect(existsSync(lane.starts)).toBe(false);
      const transcript = readFileSync(handle.sessionFile!, 'utf8');
      expect(transcript).toContain('no receipt was created');
      const results = transcript.trimEnd().split('\n').map((line) => JSON.parse(line) as { message?: { role?: string; toolCallId?: string; isError?: boolean } })
        .filter((entry) => entry.message?.role === 'toolResult').map((entry) => [entry.message?.toolCallId, entry.message?.isError]);
      expect(results).toEqual([['verification-call', true], ['after-refusal', false]]);
      expect(verdict).toMatchObject({ ok: true });
      expect(inspectDirectiveCheckpoint(handle.sessionFile!, identity)).toMatchObject({ state: 'terminal', ok: true });
      await handle.dispose();
    } finally { process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });


  it('review-1 standalone lint refuses before any producer #contract:scheduled-verification:pi', async () => refuses('npm run lint'));
  it('review-1 standalone typecheck refuses before any producer', async () => refuses('npm run typecheck'));
  it('review-1 standalone build refuses before any producer', async () => refuses('npm run build'));
  it('review-1 standalone build:web refuses before any producer', async () => refuses('npm run build:web'));
  it('review-1 backend script refuses before any producer', async () => refuses('npm run test:backend'));
  it('review-1 heavy backend script refuses before any producer', async () => refuses('npm run test:backend:heavy'));
  it('review-1 web script refuses in a minimal lane', async () => refuses('npm run test:web'));
  it('review-1 npm prefix normalization refuses before any producer', async () => refuses('npm --prefix web test'));
  it('review-1 npx option normalization refuses before any producer', async () => refuses('npx --no-install vitest run'));
  it('review-1 assignment-prefixed declared custom script refuses', async () => refuses('CI=1 npm run quality', true));
  it('review-1 wrapper nesting and options refuse before any producer', async () => {
    for (const command of ['env -i PATH="$PATH" npm test', 'env -u UNUSED command -p env --ignore-environment PATH="$PATH" npm test', 'command -- env --unset=UNUSED npm test']) await refuses(command);
  });
  it('review-1 adjacent redirects refuse before any producer', async () => {
    for (const command of ['npm test>test.log', 'npm test 2>test.log', 'npm test>>test.log']) await refuses(command);
  });
  it('review-1 known direct local-bin paths refuse before any producer', async () => {
    for (const command of ['./node_modules/.bin/vitest run', 'cd web && ../node_modules/.bin/vitest run']) await refuses(command);
    await refuses((cwd) => `${join(cwd, 'node_modules/.bin/vitest')} run`);
    await refuses((cwd) => `${join(cwd, 'web/node_modules/.bin/vitest')} run`);
  });
  it('review-1 executable producers outside literal heredocs refuse whole calls', async () => {
    await refuses("cat <<'EOF'\nnpm test\nEOF\nnpm run build:web");
    await refuses("npm test; cat <<'EOF'\nnpx vitest run\nEOF");
  });
  it('review-1 each conventional direct tool independently refuses', async () => {
    for (const producer of ['vitest run', 'jest', 'tsc --noEmit', 'eslint .', 'vite build', 'playwright test']) {
      await refuses(producer); await refuses(`npx ${producer}`);
    }
  });
  it('scheduled verification preserves normal SDK source/Git/quoted-text and helper execution', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const capture = await authenticatedCaptureStatus(lane);
    const command = `git status --short; printf '%s' 'npm test && npx vitest run'; ${capture.command}`;
    const f = await fixture([{ deltas: [], toolCall: { id: 'source-call', name: 'bash', args: { command } } }, { deltas: ['done'] }]);
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      await handle.prompt('source inspection');
      expect(capture.requests).toEqual(['GET /api/verify/status?request_id=existing']);
      expect(readFileSync(handle.sessionFile!, 'utf8')).toContain('existing');
      expect(readFileSync(handle.sessionFile!, 'utf8')).not.toContain('Minion verification refused');
      await handle.dispose();
    } finally { await f.runtime.dispose(); await capture.close(); }
  });
  it('review-1 literal source heredocs and development/setup actions remain normal Bash', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const command = "cat > source.txt <<'EOF'\nnpm test && npx vitest run\nEOF\ncat source.txt; vite; vite dev; npx vite preview; playwright install; npx playwright install-deps";
    const f = await fixture([{ deltas: [], toolCall: { id: 'source-call', name: 'bash', args: { command } } }, { deltas: ['done'] }]);
    try {
      const handle = await f.runtime.spawn('minion', lane.session); await handle.prompt('source work');
      expect(existsSync(join(lane.lane.path, 'source.txt'))).toBe(true);
      expect(readFileSync(join(lane.lane.path, 'source.txt'), 'utf8')).toBe('npm test && npx vitest run\n');
      expect(readFileSync(lane.starts, 'utf8').trim().split('\n')).toHaveLength(5);
      expect(readFileSync(handle.sessionFile!, 'utf8')).not.toContain('Minion verification refused');
      await handle.dispose();
    } finally { process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });

  it('review-2 npm aliases refuse independently before producer start', async () => {
    for (const command of ['npm tst', 'npm run-script lint', 'npm exec -- vitest run', 'npm x -- vitest run', 'npm rum lint', 'npm urn lint']) await refuses(command);
  });
  it('review-2 conventional option positions refuse independently', async () => {
    for (const command of ['npm --loglevel error test', 'npm run --if-present lint', 'npm --loglevel error run --if-present lint']) await refuses(command);
  });
  it('review-2 exact declared script words refuse independently', async () => {
    for (const command of ['npm run test.unit', 'npm run-script check/unit']) await refuses(command, true);
  });
  it('review-2 root-relative web bin paths refuse independently', async () => {
    for (const command of ['web/node_modules/.bin/vitest run', './web/node_modules/.bin/vitest run']) await refuses(command);
  });
  it('review-2 bounded control prefixes refuse entire calls', async () => {
    for (const command of ['! npm test', '! printf ok | npm test', 'if npm test; then printf ok; fi', '( npm test )', '{ npm test; }']) await refuses(command);
  });

  it('review-2 plain unquoted source heredocs and diagnostic reads execute normally', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const command = "cat > source.txt <<EOF\nnpm test && npx vitest run\nEOF\ncat source.txt; tsc --version; tsc --showConfig; eslint --help; npx --no-install tsc --version; npm exec -- tsc --showConfig";
    const f = await fixture([{ deltas: [], toolCall: { id: 'source-call', name: 'bash', args: { command } } }, { deltas: ['done'] }]);
    try {
      const handle = await f.runtime.spawn('minion', lane.session); await handle.prompt('source reads');
      expect(existsSync(join(lane.lane.path, 'source.txt'))).toBe(true);
      expect(readFileSync(join(lane.lane.path, 'source.txt'), 'utf8')).toBe('npm test && npx vitest run\n');
      expect(readFileSync(lane.starts, 'utf8').trim().split('\n')).toEqual(['tsc', 'tsc', 'eslint', 'npx', 'npm']);
      expect(readFileSync(handle.sessionFile!, 'utf8')).not.toContain('Minion verification refused');
      await handle.dispose();
    } finally { process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });

  it('review-8 Pi SDK refuses option-terminator and heredoc-FD producers before any executable starts', async () => {
    for (const command of ['npx vitest run -- --help', 'npm 0<<EOF test\nEOF\n']) await refuses(command);
  });
  it('strict repair every retained producing raw case refuses through ordinary Pi with zero starts', async () => {
    const { nativeCorpus } = await import('./helpers/verification-native-corpus.mjs');
    const refusedRows = nativeCorpus.filter((row) => row.refused);
    expect(refusedRows).toHaveLength(54);
    const seedSetupStarted = performance.now();
    const template = makeWorkflowLane();
    const seedFixtureSetupMs = performance.now() - seedSetupStarted;
    cleanupDirs.push(template.root);
    const identities: RefusalCaseFixtureIdentity[] = [];
    for (const row of refusedRows) identities.push(await refuses(row.raw, true, template.lane));
    const expectIndependent = <T>(select: (identity: RefusalCaseFixtureIdentity) => T) => {
      expect(new Set(identities.map(select)).size).toBe(54);
    };
    expect(identities).toHaveLength(54);
    expectIndependent((identity) => identity.laneRoot);
    expectIndependent((identity) => identity.lanePath);
    expectIndependent((identity) => identity.laneId);
    expectIndependent((identity) => identity.branch);
    expectIndependent((identity) => identity.producerStarts);
    expectIndependent((identity) => identity.home);
    expectIndependent((identity) => identity.dataDir);
    expectIndependent((identity) => identity.transcript);
    expectIndependent((identity) => identity.modelScript);
    expectIndependent((identity) => identity.workerSession);
    const caseLaneFixtureSetupMs = identities.reduce((total, identity) => total + identity.laneFixtureSetupMs, 0);
    console.info(`[raw-refusal-fixture] cases=${identities.length} seed-setup-ms=${seedFixtureSetupMs.toFixed(1)} independent-lane-setup-ms=${caseLaneFixtureSetupMs.toFixed(1)}`);
  });
  it('strict repair reopened real-SDK Pi preserves identity cwd workflow and refuses all incidents', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const f = await fixture([ { deltas: ['established'] },
      ...[WEB_INCIDENT, FULL_INCIDENT, BUILD_INCIDENT].flatMap((command, index) => [
        { deltas: [], toolCall: { id: `reopened-${index}`, name: 'bash', args: { command } } }, { deltas: ['settled'] },
      ]),
    ]);
    try {
      const first = await f.runtime.spawn('minion', lane.session); await first.prompt('establish');
      const id = first.id; const file = first.sessionFile!; await first.dispose();
      const retained = JSON.stringify(lane.session.managedSkills);
      const reopened = await f.runtime.spawn('minion', { ...lane.session, resumeFile: file });
      expect(reopened.id).toBe(id); expect(reopened.sessionFile).toBe(file);
      for (const incident of [WEB_INCIDENT, FULL_INCIDENT, BUILD_INCIDENT]) await reopened.prompt(incident);
      expect(existsSync(lane.starts)).toBe(false);
      expect(readFileSync(file, 'utf8')).toContain('focused, full');
      expect(JSON.stringify(lane.session.managedSkills)).toBe(retained);
      expect(readFileSync(file, 'utf8')).toContain(lane.lane.path);
      await reopened.dispose();
    } finally { process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });

  it('strict repair expanding escaped source plaintext and help diagnostics execute ordinary Pi', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const command = "cat > escaped.txt <<EOF\n\\$(npm test)\n\\`npm test\\`\nEOF\ncat > empty.txt <<''\nnpm test\n\ncat escaped.txt empty.txt; tsc --pretty false --showConfig; npx vitest run --help";
    const f = await fixture([{ deltas: [], toolCall: { id: 'escaped-source', name: 'bash', args: { command } } }, { deltas: ['done'] }]);
    try {
      const handle = await f.runtime.spawn('minion', lane.session); await handle.prompt('source');
      expect(readFileSync(join(lane.lane.path, 'escaped.txt'), 'utf8')).toBe('$(npm test)\n`npm test`\n');
      expect(readFileSync(join(lane.lane.path, 'empty.txt'), 'utf8')).toBe('npm test\n');
      expect(readFileSync(lane.starts, 'utf8').trim().split('\n')).toEqual(['tsc', 'npx']);
      expect(readFileSync(handle.sessionFile!, 'utf8')).not.toContain('Minion verification refused'); await handle.dispose();
    } finally { process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });

});
