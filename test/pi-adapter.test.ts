import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { PiRuntime, normalizeSessionPath, type PiRuntimeOptions } from '../src/runtime/pi-adapter.js';
import { RuntimeRegistry, applyThinkingFallback, serviceRegistryOptions } from '../src/runtime/registry.js';
import { makeWorkflowLane } from './helpers/workflow-lane.js';
import { makeFallbackRuntimeHarness } from './helpers/fallback-runtime.js';
import { LockBusyError, SessionStore } from '../src/sessions/store.js';
import { capabilitiesForModelInput, type AgentHandle, type RuntimeEvent } from '../src/runtime/types.js';
import { makeIsolatedModelRuntime, makeStubModelRuntime, StubScript, type StubResponder, type StubTurn } from './helpers/stub-model.js';
import { PerkinsWholeReview } from '../src/dispatch/perkins-review/whole.js';
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
    if (prompt.startsWith('<conversation>')) {
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
      call.prompt.startsWith('<conversation>'),
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
        call.prompt.startsWith('<conversation>'),
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
    if (prompt.startsWith('<conversation>')) {
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
        (call) => call.prompt.startsWith('<conversation>') && call.aborted,
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
    const registry = new RuntimeRegistry({ ...serviceRegistryOptions({ config: { ...fx.config, dataDir }, store: fx.store,
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
    const registry = new RuntimeRegistry({ ...serviceRegistryOptions({ config: { ...fx.config, dataDir: f.dataDir },
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

  it('enforces isolated-review tools and strips ambient Pi resources', async () => {
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

  it('injects exactly the declared native tools into an isolated lens session, in-process', async () => {
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

  it('rejects resume for isolated reviews so ambient history cannot cross the boundary', async () => {
    const fx = await fixture();
    const ordinary = await fx.runtime.spawn('perkins');
    const file = ordinary.sessionFile!;
    await ordinary.dispose();
    await expect(fx.runtime.spawn('perkins', {
      resumeFile: file,
      isolatedReview: { systemPrompt: 'isolated', tools: [] },
    })).rejects.toThrow(/must be fresh/);
  });

  it('round-trips a prompt with ordered deltas, turn lifecycle, and a durable session file', async () => {
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

  it('exposes native context usage and a failed native compact keeps the same session usable', async () => {
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

  it('successfully compacts through the installed Pi SDK without changing session identity', async () => {
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
        session: { isCompacting: boolean };
        onPiEvent(event: unknown): void;
      };
      const nativeSession = internal.session;
      try {
        await handle.prompt('prime');
        // Pi dispatches compaction_end before the session clears isCompacting;
        // hold that gate closed to pin the adapter's bounded reconciliation.
        internal.session = new Proxy(nativeSession, {
          get(target, key) {
            if (key === 'isCompacting') return true;
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
          // Drain any disposal timers while the fake clock is still installed.
          await vi.advanceTimersByTimeAsync(60_000);
        } finally {
          vi.useRealTimers();
        }
        // The reconcile path disposes instead of wedging on the stuck gate.
        await waitFor(() => handle.health().state === 'disposed', 'reconciled disposal');
        expect(handle.sessionFile).not.toBeNull();
        expect(existsSync(`${handle.sessionFile!}.lock`)).toBe(false);
      } finally {
        internal.session = nativeSession;
        await handle.dispose();
      }
    });

    it('a signal-ignoring summary keeps compaction open until disposal: one failed terminal, no duplicates', async () => {
      let releaseSummary: () => void = () => {};
      const summaryHold = new Promise<void>((resolve) => {
        releaseSummary = resolve;
      });
      const fx = await fixture((prompt, index) => {
        if (prompt.startsWith('<conversation>')) return { deltas: [], hold: summaryHold };
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

    it('native SDK follow-up: admitted before compaction, pending through the stall, delivered once (signal settles)', async () => {
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

  it('emits thinking deltas before text when the model reasons', async () => {
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

  it('resumes a previous session file with history intact (process restart)', async () => {
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

  it('fails loud on an unknown model reference', async () => {
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
    for (const change of [
      { provider: 'credential-looking-provider' },
      { id: 'credential-looking-model' },
      { api: 'credential-looking-api' },
      { thinkingLevelMap: { high: 'credential-looking-thinking' } },
      { thinkingLevelMap: { 'credential-looking-key': 'high' } },
      { compat: { allowedFallbackModels: [{ provider: 'anthropic', model: 'claude-credential-looking-token',
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
    const runtime = new PiRuntime({
      config,
      store,
      agentDir,
      modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['settings default'] }]), {
        refreshAuthCache: false,
      }),
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
    });
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

  it('dispose releases the session lock', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('gru');
    const file = handle.sessionFile!;
    await handle.dispose();
    const fresh = new SessionStore(fx.store.dataDir);
    expect(() => fresh.acquireLock(file)).not.toThrow();
    fresh.releaseLock(file);
    expect(handle.health().state).toBe('disposed');
  });

  it('declares pi capabilities honestly in the matrix', async () => {
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
        images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
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
  it('boots with growth detection, resolves roles to the configured runtime, and reports status', async () => {
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
  it('B3: images round-trip in the EXACT SDK shape (data + mimeType)', async () => {
    const fx = await fixture([{ deltas: ['seen'] }], ['text', 'image']);
    const handle = await fx.runtime.spawn('gru');
    try {
      await handle.prompt('look', {
        owner: 'alice',
        images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
      });
      expect(fx.script.calls[0]!.images).toEqual([
        { data: 'aGVsbG8=', mimeType: 'image/png' },
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

  it('W7: error turn — in-band completion: error event + state error, then recovers', async () => {
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

  it('N24: resumeFile outside the session store is refused', async () => {
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
    const warn = logs.find((l) => l.level === 'warn' && l.msg.includes('changed while service was down'));
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
  it('hosts the session rooted at an explicit project cwd, not the workspace root', async () => {
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
    const registry = new RuntimeRegistry({ ...serviceRegistryOptions({ config: { ...fx.config, dataDir }, store: fx.store,
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
    const registry = new RuntimeRegistry({ ...serviceRegistryOptions({ config: { ...fx.config, dataDir }, store: fx.store,
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
  it('sdk errors: numeric status/statusCode is the gate; headers carry Retry-After', async () => {
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
