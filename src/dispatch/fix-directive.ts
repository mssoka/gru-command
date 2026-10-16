import { capturePortLaneHandoff } from '../worktrees/handoff.js';
import { randomUUID } from 'node:crypto';
import type { Role } from '../config.js';
import type { LedgerApi } from '../ledger/api.js';
import { isJobTerminal } from '../ledger/states.js';
import type { AgentHandle, NativeAgentTool, SpawnOptions } from '../runtime/types.js';
import { WorkerDisposalInProgressError } from '../runtime/worker-errors.js';
import { requireSpawnCwd } from '../roles.js';
import { appendLessonPointers, renderLessonsSection } from '../lessons/references.js';
import type { LessonPointer, LessonsReferencePort } from '../lessons/types.js';
import { appendWorkerRules, WORKER_RULE_BLOCKS } from './worker-rules.js';
import { withRevisionContinuation } from './work-revision.js';
import { resolveGitCommit } from './perkins-review/artifacts.js';
import { promptVerdictFromHealth, promptWithTerminalVerdict } from '../runtime/prompt-verdict.js';
import type { PromptOptions, PromptTurnVerdict } from '../runtime/types.js';
import type { WorktreePort } from './worktree-port.js';
import { readGitState } from '../verify/scheduler.js';
import { readDirectiveSessionHeader } from '../runtime/directive-checkpoint.js';
import { settleRetries, type PacingGate, type PacingLease, type RetrySettlement } from '../runtime/pacing.js';

/**
 * Fix-directive routing (E8 follow-through; owner ruling 2026-09-21): the
 * mechanics of reaching a job's implementing minion. One implementation,
 * two doors — the bmad-review fallback gate's fixDirectiveSink and the
 * silas ops surface — so "route a directive to the minion" can never drift
 * between them.
 */

/** The product-owned identity + GC-mediated child tools for a
 * (re)dispatched parent session (issue #161). A fresh physical session
 * still belongs to its recorded logical minion; only a job without an
 * implementer record mints an identity. */
function parentIdentitySpawnOptions(
  input: {
    readonly parentTools?: (agentId: string) => readonly NativeAgentTool[];
    readonly ledger: Pick<LedgerApi, 'listImplementerMinions'>;
  },
  jobId: string,
  resumeFile: string | null,
): Pick<SpawnOptions, 'agentId' | 'nativeTools'> {
  const implementers = input.ledger.listImplementerMinions(jobId);
  const original = implementers.find((agent) => resumeFile !== null && agent.sessionFile === resumeFile) ?? implementers[0];
  const agentId = original?.id ?? `minion_${randomUUID()}`;
  const nativeTools = input.parentTools?.(agentId) ?? [];
  return {
    agentId,
    // A runtime that cannot host parent tools returns none: no empty array
    // is forwarded (the adapter would treat a declared-but-empty set the
    // same, but an omission is the honest declaration).
    ...(nativeTools.length > 0 ? { nativeTools } : {}),
  };
}

/** The registry surface directive routing needs (structural — the real
 * RuntimeRegistry satisfies it; tests drive a controllable fake). */
export interface DirectiveRegistry {
  getHandle(agentId: string): AgentHandle | null;
  spawn(role: Role, options?: SpawnOptions): Promise<AgentHandle>;
  disposeHandle(handle: AgentHandle): Promise<void>;
}

export interface DirectiveRoutingDeps {
  readonly registry: DirectiveRegistry;
  readonly ledger: Pick<
    LedgerApi,
    'listImplementerMinions' | 'listAgents' | 'registerAgent' | 'getJob' | 'getAgent'
  >;
  readonly worktrees: WorktreePort;
  /** Book of Lessons injection: pointer lines only, never chapter bodies. */
  readonly lessons?: LessonsReferencePort;
  /** Issue #161: GC-mediated child-worker tools for a (re)dispatched parent
   * session, bound to its product-owned agent id by closure. */
  readonly parentTools?: (agentId: string) => readonly NativeAgentTool[];
  /** Provider pacing: worker (minion turn) admission gate. Absent = off. */
  readonly workerGate?: PacingGate;
  /** Provider pacing: the bounded settlement of an automatic rate-limit
   * retry covering the delivered turn. The directive reports delivered
   * only for 'none'/'recovered'; the worker lease is released before the
   * wait so the retry can reacquire admission. Absent = no interlock. */
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  /** Issue #339: observe a directive-continued blind reviewer session so a
   * prohibited read during the continuation invalidates blind coverage
   * exactly like the dispatch, re-brief and restart-recovery settle seams.
   * Forwarded by the caller (the production observer is read-only and owns its
   * own error boundary); absent = no observation (non-review directives,
   * tests). */
  readonly observeBlindTurn?: (jobId: string, sessionFile: string | null) => void;
}

function verdictFields(verdict: PromptTurnVerdict): { readonly outcome: 'completed' | 'error'; readonly error?: string } {
  return verdict.ok
    ? { outcome: 'completed' }
    : { outcome: 'error', error: verdict.error ?? 'runtime settled the turn with an in-band error' };
}

/** A ledger the directive admission can re-check. `hasUnsettledVerificationRun`
 * is used when the ledger exposes it (the real LedgerApi does); a narrow
 * fake omits it and the check is skipped.
 *
 * Issue #243 F-H3: this is called at EVERY post-wait boundary (after the
 * pacing acquire, around spawn/resume, and immediately before the prompt) —
 * an initial check before the waits cannot see a verification that took
 * ownership of the lane while the producer queued. */
type DirectiveAdmissionLedger = Pick<LedgerApi, 'getJob'> &
  Partial<Pick<LedgerApi, 'hasUnsettledVerificationRun'>>;

function assertDirectiveJobActive(ledger: DirectiveAdmissionLedger, jobId: string): void {
  const job = ledger.getJob(jobId);
  if (job === null || isJobTerminal(job.status)) {
    throw new Error(`directive refused — job "${jobId}" is ${job?.status ?? 'missing'}`);
  }
  if (ledger.hasUnsettledVerificationRun?.(jobId) === true) {
    throw new Error(`directive refused — a verification run owns lane "${jobId}"`);
  }
}

/** Positive routing proof: this invocation stopped at a guard before any
 * native spawn, preparation, prompt or cleanup operation was attempted. */
export class DirectiveDispatchDeferredError extends Error {
  constructor(readonly original: unknown) { super(`pre-native directive deferred: ${String(original)}`); this.name = 'DirectiveDispatchDeferredError'; }
}

/** A caller broke the routing contract (a programming error), refused
 * before any effect. It does not extend DirectiveDispatchDeferredError, so
 * an executor never records it as a deferral; the fix is in the calling
 * code, not a retry. */
export class DirectiveRoutingContractError extends Error {
  constructor(message: string) { super(message); this.name = 'DirectiveRoutingContractError'; }
}

/** Route a directive to the implementing minion: the live job minion
 * first; otherwise a fresh minion on the job lane. Throws
 * DirectiveRoutingContractError when a native directive turn arrives
 * without onPrepared. */
export async function routeFixDirectiveToMinion(
  input: DirectiveRoutingDeps & {
    jobId: string;
    directive: string;
    signal: AbortSignal;
    /** Prompt owner tag (audit); defaults to the shared routing owner. */
    owner?: string;
    readonly directiveTurn?: PromptOptions['directive'];
    readonly beforeTurnSideEffect?: (handle?: AgentHandle) => void;
    readonly onPrepared?: (handle: AgentHandle) => void;
    readonly onCleanup?: (handle: AgentHandle) => void;
    readonly freshSession?: boolean;
    /** The job's effective contract (original briefing plus every accepted
     * amendment): what a FRESH fallback minion is briefed with. Absent =
     * the original briefing (no amendment surface at the caller). */
    contract?: string | null;
    /** Owner rule 4: the pending material amendments travel ONCE. A live or
     * resumed session gets `block` (the canonical bodies); a fresh session
     * already reads them in the effective contract and gets `freshNote`. */
    continuation?: { readonly block: string; readonly freshNote: string };
    /** Issue #243 F-H2: re-prove the family/basis coverage identity at every
     * post-wait admission boundary (after the pacing acquire, around
     * spawn/resume, immediately before the prompt). A hold that arrives while
     * the producer queues must refuse BEFORE any durable/prompt effect. */
    beforeWriterSideEffect?: () => void;
  },
): Promise<{
  delivered: boolean;
  minionId?: string;
  note?: string;
  /** 'error' = the prompt settled with an in-band runtime error: it WAS
   * admitted, but it is not a successful completion and must never
   * complete a marked phase or record a phase-tagged delivery. */
  outcome?: 'completed' | 'error';
  error?: string;
  /** Only on `delivered:false`: `'none'` = positive no-effect proof (the
   * prompt was never handed to a worker or turn); `'unknown'` = the prompt
   * may already have run (cancellation or a spent/superseded retry AFTER
   * the prompt call) — the durable request must stay live for
   * reconciliation and must never be marked failed or release its
   * single-writer guard on this evidence alone. */
  admission?: 'none' | 'unknown';
}> {
  // A native directive turn is admitted only with its target and producer
  // start committed first (#362): without onPrepared nothing would commit
  // them before the prompt, so the route refuses before any effect.
  if (input.directiveTurn !== undefined && input.onPrepared === undefined) {
    throw new DirectiveRoutingContractError(`job "${input.jobId}": a native directive turn needs onPrepared — its target and producer start must commit before the prompt`);
  }
  const disposeAndRecord = async (handle: AgentHandle, viaRegistry = false): Promise<void> => {
    const failures: unknown[] = [];
    try { await (viaRegistry ? input.registry.disposeHandle(handle) : handle.dispose()); } catch (error) { failures.push(error); }
    try { input.onCleanup?.(handle); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `directive cleanup failed: ${failures.map(String).join('; ')}`);
  };
  const owner = input.owner ?? 'fix-directive';
  const assignedLane = input.worktrees.listWorktrees({ jobId: input.jobId }).find((lane) => lane.kind === 'job' && lane.status !== 'swept');
  const assertHandoff = assignedLane === undefined ? () => {} : capturePortLaneHandoff(input.worktrees, assignedLane);
  let nativeAttempted = false;
  let priorCleanupPending = false;
  const guard = (handle?: AgentHandle): void => {
    try { input.beforeTurnSideEffect?.(handle); }
    catch (error) {
      if (input.directiveTurn !== undefined && !nativeAttempted && !priorCleanupPending) throw new DirectiveDispatchDeferredError(error);
      throw error;
    }
  };
  let minions = input.ledger.listImplementerMinions(input.jobId)
    .filter((agent) => agent.parentage !== 'child');
  // Operation-boundary guards below still fence every cleanup, spawn,
  // preparation and prompt. A structural no-route result attempts none:
  // it may settle truthful no-effect history without a branch/effect grant.
  // Follow-up turns carry the CURRENT worker rule blocks too (PR creation
  // and the no-call-budget contract): legacy briefing wording must not
  // outrank them on the live/resumed paths.
  const compose = (revisionText: string): string => appendWorkerRules(
    appendLessonPointers(
      withRevisionContinuation(input.directive, revisionText),
      input.lessons?.referencesFor(input.directive) ?? [],
    ),
  );
  const directive = compose(input.continuation?.block ?? '');
  if (input.freshSession === true) {
    for (const minion of minions) {
      const prior = input.registry.getHandle(minion.id);
      if (prior === null) continue;
      guard();
      priorCleanupPending = true;
      await disposeAndRecord(prior, true);
      if (prior.cessationEvidence?.() !== 'ceased') throw new Error(`prior minion ${prior.id} retains unproven producer ownership — rebrief refused`);
      priorCleanupPending = false; // positive prior cessation is not this request's native attempt
      guard();
    }
    minions = [];
  }
  // Observe the actual physical continuation, never its cancellation race.
  const observe = (sessionFile: string | null): void =>
    input.observeBlindTurn?.(input.jobId, sessionFile);
  let evictedSessionFile: string | null = null;
  // Every post-wait boundary runs the caller's coverage re-proof first, then
  // the ledger's own terminality/verification admission check (F-H2/F-H3).
  const assertAdmissible = (): void => {
    input.beforeWriterSideEffect?.();
    assertDirectiveJobActive(input.ledger, input.jobId);
  };
  for (const minion of minions) {
    const handle = input.registry.getHandle(minion.id);
    if (handle !== null) {
      guard(); // before even the owned prior retry/pacing awaits
      // Active-incident attribution (B1): if an automatic retry is already
      // covering this handle, wait for its settlement BEFORE prompting.
      // Otherwise the new directive and the retry would deliver overlapping
      // prompts on one session, and this turn's failure could be settled by
      // the other turn's outcome. Await before taking the worker slot — the
      // retry re-acquires its own slot and must not be blocked by ours.
      const pending = await settleRetries(input.retrySettlement, handle.id, input.signal);
      guard();
      if (pending === 'cancelled') return { delivered: false, note: 'review operation aborted', admission: 'none' };
      let lease: PacingLease | null = null;
      if (input.workerGate !== undefined) {
        lease = await input.workerGate.acquireWorkerTurn({
          id: input.jobId,
          label: `directive → ${minion.id}`,
          jobId: input.jobId,
          signal: input.signal,
        });
      }
      let promptError: unknown = null;
      let verdict: PromptTurnVerdict | null = null;
      let observation: Promise<void> = Promise.resolve();
      try {
        // A refusal before prompt is positive no-admission proof, not a
        // prompt error eligible for retry recovery. It must still release
        // the pacing lease acquired after the asynchronous wait above.
        assertHandoff();
        assertAdmissible();
        assertHandoff(); // reprove custody before the physical prompt starts
        guard();
        nativeAttempted = true;
        input.onPrepared?.(handle);
        const run = runObservedPrompt(handle, directive, input.signal, owner, () =>
          observe(handle.sessionFile), input.directiveTurn);
        observation = run.observation;
        try {
          verdict = await run.verdict;
        } catch (error) {
          promptError = error;
        }
      } finally {
        // Release before the settlement wait: the retry reacquires the slot.
        lease?.release();
        lease = null;
      }
      // Issue #339 (D1 physical tail): observe the ACTUAL started prompt's
      // session before any disposition branch. Cancellation returns the race
      // first while the physical prompt is still running, and a directive turn
      // has no automatic retry to heal a prohibited read appended afterwards.
      if (!input.signal.aborted) await observation;
      if (promptError instanceof WorkerDisposalInProgressError) {
        // A resident-budget reclaim may be disposing this handle under us
        // (typed handshake): settle any automatic retry covering it BEFORE
        // falling through, so the retry's own delivery and a resumed /
        // session-file fallback can never overlap (two writers on one
        // session) — and a 'recovered' disposition is reported as the
        // delivery it is.
        const disposition = await settleRetries(input.retrySettlement, handle.id, input.signal);
        if (disposition === 'cancelled') return { delivered: false, note: 'review operation aborted', admission: 'unknown' };
        if (disposition === 'recovered') {
          return { delivered: true, minionId: minion.id, ...verdictFields({ ok: true, error: null }) };
        }
        evictedSessionFile = handle.sessionFile;
        continue;
      }
      // A rejected prompt keeps the same bounded settlement interlock as a
      // resolved one: an in-band rate-limit incident may still be carrying
      // the directive, so failure is reported only after the disposition is
      // known (never duplicating a delivery the retry still owns).
      const disposition = await settleRetries(input.retrySettlement, handle.id, input.signal);
      if (disposition === 'cancelled') {
        // The prompt call already ran: admission is UNKNOWN, not a no-effect
        // failure — the request stays live for reconciliation.
        return { delivered: false, note: 'review operation aborted', admission: 'unknown' };
      }
      if (disposition === 'exhausted' || disposition === 'superseded') {
        return {
          delivered: false,
          note: `automatic rate-limit retry ${disposition} before delivery`,
          admission: 'unknown',
        };
      }
      if (promptError !== null && disposition !== 'recovered') throw promptError;
      // Terminal/error correlation (r4/r5 blocker 1): the verdict was
      // captured by the transport when THIS prompt settled — before any
      // queued successor turn could start — and is held across the retry
      // settlement above. A resolved-but-errored turn reports outcome
      // 'error' and must never complete a marked phase or record a
      // phase-tagged delivery. A retry-recovered disposition is the
      // retry's own clean turn (the supervisor supersedes itself on any
      // further in-band error), so it is delivery evidence.
      const evidence =
        disposition === 'recovered'
          ? ({ ok: true, error: null } as const)
          : (verdict ?? promptVerdictFromHealth(handle));
      return { delivered: true, minionId: minion.id, ...verdictFields(evidence) };
    }
  }
  const lane = input.worktrees
    .listWorktrees({ jobId: input.jobId })
    .find((candidate) => candidate.kind === 'job');
  if (lane === undefined) {
    return { delivered: false, note: 'no implementing minion session and no job lane', admission: 'none' };
  }
  guard(); // lane exists: pin original branch before pacing/spawn awaits
  let lease: PacingLease | null = null;
  if (input.workerGate !== undefined) {
    lease = await input.workerGate.acquireWorkerTurn({
      id: input.jobId,
      label: `directive (fresh minion) → ${input.jobId}`,
      jobId: input.jobId,
      signal: input.signal,
    });
  }
  let handle: AgentHandle | null = null;
  let registrationFailed = false;
  const route = async (): Promise<Awaited<ReturnType<typeof routeFixDirectiveToMinion>>> => {
  try {
    // Prefer the CURRENT failing logical session; only when the evicted
    // handle exposed none fall back to the newest session-bearing record —
    // never an arbitrary older disposed minion's session.
    const fallback = evictedSessionFile === null
      ? (minions.find((minion) => minion.sessionFile !== null)?.sessionFile ?? null)
      : null;
    const resumeFile = evictedSessionFile ?? fallback;
    // Issue #161: the (re)dispatched parent keeps one product-owned id
    // (its recorded row's id, even without a transcript) and receives the
    // child tools bound to it — re-briefed parents stay able to commission.
    const identity = parentIdentitySpawnOptions(input, input.jobId, resumeFile);
    // A brand-new session (nothing to resume) has no memory of the contract:
    // brief it with the effective contract like the resume fallback below
    // (owner rule 4) — when the caller supplied one.
    const freshPrompt = (contract: string): string =>
      `Fresh minion re-brief for job ${input.jobId}. Effective contract (original briefing plus accepted amendments):\n${contract}\n\nCurrent fix directive:\n${compose(input.continuation?.freshNote ?? '')}`;
    let prompt = resumeFile === null && input.contract != null && input.freshSession !== true ? freshPrompt(input.contract) : directive;
    try {
      assertHandoff();
      assertAdmissible();
      guard();
      nativeAttempted = true; // a rejected spawn is still uncertain, never a deferral
      handle = await input.registry.spawn('minion', {
        cwd: lane.path, signal: input.signal,
        ...(resumeFile !== null ? { resumeFile } : {}),
        ...identity,
      });
    } catch (error) {
      if (resumeFile === null || input.signal.aborted || input.directiveTurn !== undefined) throw error;
      const job = input.ledger.getJob(input.jobId);
      const contract = input.contract ?? job?.briefing ?? null;
      if (job == null || contract == null) {
        throw new Error(`cannot resume prior minion session for job ${input.jobId} and no original briefing is available to re-brief: ${String(error)}`);
      }
      assertHandoff();
      assertAdmissible();
      guard();
      nativeAttempted = true;
      handle = await input.registry.spawn('minion', { cwd: lane.path, signal: input.signal, ...identity });
      // A fresh session has no memory of accepted amendments: brief it with
      // the EFFECTIVE contract (original + amendments), never the original
      // alone (owner rule 4).
      prompt = freshPrompt(contract);
    }
    assertAdmissible();
    guard();
    let promptError: unknown = null;
    let verdict: PromptTurnVerdict | null = null;
    const spawnedHandle = handle;
    try {
      assertHandoff();
      assertDirectiveJobActive(input.ledger, input.jobId);
      // A fresh fallback minion (the resume attempt failed) is top-level;
      // a resumed row keeps its recorded parentage (never retro-fitted).
      input.ledger.registerAgent({
        id: spawnedHandle.id,
        role: 'minion',
        jobId: input.jobId,
        sessionFile: handle.sessionFile,
        ...(input.ledger.getAgent(spawnedHandle.id) === null ? { parentage: 'top-level' as const } : {}),
      });
      assertHandoff();
      assertDirectiveJobActive(input.ledger, input.jobId);
    } catch (error) {
      registrationFailed = true;
      throw error; // the single cleanup owner below preserves registration AND cleanup failures
    }
    assertAdmissible();
    guard(handle);
    nativeAttempted = true;
    input.onPrepared?.(handle);
    const continuationSessionFile = handle.sessionFile;
    let observation: Promise<void> = Promise.resolve();
    try {
      const run = runObservedPrompt(handle, prompt, input.signal, owner, () =>
        observe(continuationSessionFile), input.directiveTurn);
      observation = run.observation;
      try {
        verdict = await run.verdict;
      } catch (error) {
        promptError = error;
      }
    } finally {
      // Release before the settlement wait: the retry reacquires the slot.
      lease?.release();
      lease = null;
    }
    // Issue #339 (D1 physical tail): observe the ACTUAL started prompt's
    // session before any disposition branch (see the live path above).
    if (!input.signal.aborted) await observation;
    const disposition = await settleRetries(input.retrySettlement, handle.id, input.signal);
    if (disposition === 'cancelled') {
      // The prompt call already ran on the fresh minion: UNKNOWN admission.
      return { delivered: false, note: 'review operation aborted', admission: 'unknown' };
    }
    if (disposition === 'exhausted' || disposition === 'superseded') {
      return {
        delivered: false,
        note: `automatic rate-limit retry ${disposition} before delivery`,
        admission: 'unknown',
      };
    }
    if (promptError !== null && disposition !== 'recovered') throw promptError;
    // Terminal/error correlation (r4/r5 blocker 1): the verdict was captured
    // by the transport when THIS prompt settled (before any queued successor
    // could start) and is held across the retry settlement. A
    // resolved-but-errored turn must never complete a marked phase or record
    // a phase-tagged delivery; a retry-recovered disposition is the retry's
    // own clean turn.
    const evidence =
      disposition === 'recovered'
        ? ({ ok: true, error: null } as const)
        : (verdict ?? promptVerdictFromHealth(handle));
    return { delivered: true, minionId: handle.id, ...verdictFields(evidence) };
  } finally { lease?.release(); }
  };
  const failures: unknown[] = [];
  let result: Awaited<ReturnType<typeof routeFixDirectiveToMinion>> | undefined;
  try { result = await route(); } catch (error) { failures.push(error); }
  const owned = handle as AgentHandle | null;
  if (owned !== null) {
    try { await disposeAndRecord(owned, registrationFailed); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `directive routing/cleanup failed: ${failures.map(String).join('; ')}`);
  if (result === undefined) throw new Error('directive routing settled without result or failure');
  return result;
}

/**
 * Run ONE directive continuation prompt and hand the caller both the raced
 * verdict (cancellation returns promptly) and the OBSERVATION lifetime of the
 * ACTUAL started prompt (issue #339 D1 physical tail).
 *
 * The naive race of the real prompt against cancellation has no
 * physical-completion observer: an abort returns promptly with admission
 * UNKNOWN while the real prompt keeps running, and a directive turn has no
 * automatic retry to heal a prohibited read it appends afterwards. The
 * observation therefore follows the PHYSICAL prompt promise, not the race /
 * logical disposition: it fires whether the prompt resolves, rejects, is
 * superseded, or is still running after an abort.
 *
 * A pre-aborted call starts NO prompt and observes nothing (never a fabricated
 * started-turn observation). The returned `observation` never rejects (the
 * observer port owns its own error boundary), so awaiting it is safe and
 * never introduces an unhandled rejection.
 */
function runObservedPrompt(
  handle: Pick<AgentHandle, 'prompt' | 'health'> & Partial<Pick<AgentHandle, 'promptWithVerdict'>>,
  text: string,
  signal: AbortSignal,
  owner: string,
  observe: () => void,
  directive?: PromptOptions['directive'],
): { readonly verdict: Promise<PromptTurnVerdict>; readonly observation: Promise<void> } {
  if (signal.aborted) {
    return { verdict: Promise.reject(new Error('review operation aborted')), observation: Promise.resolve() };
  }
  const physical = promptWithTerminalVerdict(handle, text, { owner, ...(directive !== undefined ? { directive } : {}) });
  const observation = physical.then(
    () => observe(),
    () => observe(),
  ).then(
    () => undefined,
    () => undefined,
  );
  return {
    verdict: Promise.race([
      physical,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('review operation aborted')), { once: true });
      }),
    ]),
    observation,
  };
}
/**
 * The follow-up delivery signal (the loop's close, not a blind re-fire):
 * a settled directive or re-brief minion turn IS the implementing minion's
 * delivery. Record it as `job.delivered` — the same event the initial
 * briefing turn records — carrying the lane head the turn produced. The
 * digest's freshness predicate reads that sha against the round's reviewed
 * target: a moved head warrants the re-review; the same head does not.
 *
 * Issue #220: on a report-type job this delivery is the HANDBACK — the
 * same transaction opens the one `report:<jobId>` obligation owed by the
 * commissioner (idempotent), so `delivered` never again means "pending
 * forever": it means a disposition is owed and durable.
 */
export function recordFollowUpDelivery(input: {
  readonly ledger: Pick<
    LedgerApi,
    'appendCustomEvent' | 'getJob' | 'openReportObligation'
  >;
  readonly worktrees: Pick<WorktreePort, 'listWorktrees'>;
  readonly jobId: string;
  readonly agentId: string | null;
  readonly source: 'dispatch' | 'silas-directive' | 'silas-rebrief';
  /** Request-scoped correlation: the durable directive request this
   * delivery answers. When present the event can only settle THAT
   * request — a later unrelated delivery cannot clear an older marker. */
  readonly requestId?: string;
  /** Host-owned phase-handoff identity: present when the phase was
   * explicitly marked as owing a completion decision. The completion
   * observer matches on THIS id (never the event sequence). */
  readonly phaseId?: string;
  /** The required work revision the answered request was composed with
   * (owner rule 4): the delivery is the service-bound acknowledgement of
   * that revision. A request that predates revisions passes 0 — it proves
   * no revision. Review admission compares it against the job's required
   * revision (owner rule 2). */
  readonly workRevision: number;
  /** Correlation for a genuinely completed historical request's lost delivery. */
  readonly rebriefMarker?: { readonly id: string; readonly payloadHash: string };
  /** Exact native historical completion: null explicitly means unproven HEAD. */
  readonly nativeCompletion?: { readonly sha: string | null; readonly provenance: unknown };
}): { readonly sha: string | null; readonly lanePath: string | null; readonly note: string | null; readonly eventSeq: number } {
  if (!Number.isSafeInteger(input.workRevision) || input.workRevision < 0) {
    throw new Error(`delivery work revision must be a non-negative integer, got ${String(input.workRevision)}`);
  }
  const jobLanes = input.worktrees.listWorktrees({ jobId: input.jobId }).filter((lane) => lane.kind === 'job');
  const liveJobLanes = jobLanes.filter((candidate) => candidate.status !== 'swept');
  const lane = liveJobLanes[0] ?? jobLanes[0];
  let sha: string | null = null;
  let note: string | null = null;
  let candidateDeliveryProven = false;
  if (input.nativeCompletion !== undefined) {
    if (!(input.nativeCompletion.sha === null || typeof input.nativeCompletion.sha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.nativeCompletion.sha))) throw new Error('original native completion HEAD must be an exact 40/64 hex object ID or null');
    sha = input.nativeCompletion.sha;
    if (sha === null) note = 'original native completion HEAD unproven; current candidate delivery/verification/review remain owed';
    else if (liveJobLanes.length !== 1 || lane === undefined) note = 'original native completion is preserved, but no unique live job lane proves it is the current candidate';
    else {
      const original = typeof input.nativeCompletion.provenance === 'object' && input.nativeCompletion.provenance !== null
        ? input.nativeCompletion.provenance as { readonly binding?: { readonly sessionFile?: unknown; readonly sessionId?: unknown; readonly agentId?: unknown } } : null;
      const binding = original?.binding;
      if (typeof binding?.sessionFile !== 'string' || !binding.sessionFile || typeof binding.sessionId !== 'string' || !binding.sessionId || binding.agentId !== input.agentId) {
        note = 'original native session/cwd/lane identity is unproven; original completion is preserved but current candidate gates remain owed';
      } else {
        try {
          const header = readDirectiveSessionHeader(binding.sessionFile);
          if (header.type !== 'session' || header.id !== binding.sessionId || header.cwd !== lane.path) {
            note = 'original native session cwd does not match the current live job lane; original completion is preserved but current candidate gates remain owed';
          } else {
            const current = readGitState(lane.path, { includeUntracked: true });
            if (current.sha !== sha || current.trackedDirty) note = 'original native completion is preserved, but the live job lane HEAD moved, its tracked tree is dirty, or untracked inputs are present; current candidate delivery/verification/review remain owed';
            else candidateDeliveryProven = true;
          }
        } catch (error) {
          note = `original native session cwd/lane cannot be verified: ${String(error)}; original completion is preserved but current candidate gates remain owed`;
        }
      }
    }
  } else if (lane !== undefined) {
    try {
      sha = resolveGitCommit(lane.path, lane.branch !== null && lane.branch !== '' ? lane.branch : 'HEAD');
    } catch (error) {
      // The turn settled — the delivery stands; a head we cannot resolve only
      // means the digest cannot prove a move, so no phantom re-review fires.
      note = `lane head unresolved: ${String(error).slice(0, 200)}`;
    }
  } else {
    note = 'no job lane in the registry to resolve a head from';
  }
  const event = input.ledger.appendCustomEvent({
    kind: 'job.delivered',
    jobId: input.jobId,
    payload: {
      agentId: input.agentId,
      source: input.source,
      sha,
      ...(input.requestId !== undefined ? { request_id: input.requestId } : {}),
      ...(input.phaseId !== undefined ? { phase_id: input.phaseId } : {}),
      ...(input.rebriefMarker === undefined ? {} : { marker_id: input.rebriefMarker.id, payload_hash: input.rebriefMarker.payloadHash }),
      work_revision: input.workRevision,
      ...(input.nativeCompletion === undefined ? {} : { native_completion: input.nativeCompletion.provenance, candidate_delivery_proven: candidateDeliveryProven }),
    },
  });
  // Native completion is published before modern ledger settlement. Only
  // that exact independently qualified candidate sequence may open report
  // duty, so native handback belongs to recordDirectiveDelivery's transaction.
  // Preserve ordinary nonnative report compatibility and its loud retry note.
  const job = input.ledger.getJob(input.jobId);
  if (input.nativeCompletion === undefined && job !== null && job.deliverable !== null && job.deliverable !== 'pr') {
    try {
      const opened = input.ledger.openReportObligation({ jobId: input.jobId, observedAtSeq: event.seq });
      if (opened.created) {
        input.ledger.appendCustomEvent({
          kind: 'job.report-handback',
          jobId: input.jobId,
          payload: { obligation_id: opened.obligation.id, delivered_seq: event.seq },
        });
      }
    } catch (error) {
      note = note ?? `report obligation open failed: ${String(error).slice(0, 200)}`;
    }
  }
  return { sha, lanePath: lane?.path ?? null, note, eventSeq: event.seq };
}

/** Render the prompt handed to a FRESH minion taking over a stuck lane:
 * the original briefing (still the contract) plus the re-brief note. */
export function renderRebriefPrompt(input: {
  jobId: string;
  /** The effective contract at request time (original briefing plus every
   * accepted amendment); equals the original briefing when none exist. */
  briefing: string | null;
  note: string;
  /** The required work revision the request was composed with (owner rule
   * 4); absent = a request that predates revisions. */
  workRevision?: number | null;
  /** Progressive-disclosure reference lines (no chapter bodies). */
  lessons?: readonly LessonPointer[];
}): string {
  const lessonsSection = renderLessonsSection(input.lessons ?? []);
  return [
    `Re-brief — job ${input.jobId}`,
    '',
    'A fresh worker is taking over this lane. The prior attempts stalled on',
    'the same blocker; the loop is re-opened with a clean session.',
    '',
    'RE-BRIEF NOTE (why you are here, what to do differently):',
    input.note,
    '',
    input.workRevision === undefined || input.workRevision === null
      ? 'CONTRACT (the original briefing plus any accepted amendments):'
      : `CONTRACT — revision ${input.workRevision} (the original briefing plus every accepted amendment; ` +
        `the service records this turn's delivery as contract revision ${input.workRevision} — name it in your completion report):`,
    input.briefing ?? '(the job row carries no stored briefing — read the job note on the board)',
    ...(lessonsSection === '' ? [] : ['', lessonsSection]),
    ...WORKER_RULE_BLOCKS.flatMap((block) => ['', block]),
    '',
    'Execute the briefing inside this worktree. Standing orders: work only',
    'inside this tree; commit your work to the branch; verify it (build,',
    'tests, lint — whatever this project calls green) before finishing;',
    'never merge your own pull request. End with a completion report.',
  ].join('\n');
}

/** Re-open the lane for a Silas follow-through: the follow-up turn is the
 * lane working again. `in-review` is the pre-verdict review window; a
 * `delivered` lane (settled before a PR/review request) re-opens the same
 * way — the fresh directive/re-brief supersedes the prior delivery. */
export function flipJobToWorking(
  ledger: Pick<LedgerApi, 'getJob' | 'setJobStatus' | 'noteJob'>,
  jobId: string,
): void {
  const job = ledger.getJob(jobId);
  if (job === null || (job.status !== 'in-review' && job.status !== 'delivered')) return;
  ledger.setJobStatus(jobId, 'working');
  ledger.noteJob(jobId, 'silas follow-through: fix loop re-opened, lane back to working');
}

/** Re-brief a FRESH minion on the job's lane (the second rung of the
 * recurrence ladder): live minion handles for the job are disposed first
 * (their sessions are preserved on disk — only the live handles go), then
 * a new minion is spawned rooted in the SAME worktree with the re-brief.
 * Restart recovery may pass `resumeFile` to re-enter the interrupted
 * worker's session (the #42 orphan-cure shape: resume, then re-deliver the
 * pending prompt) instead of minting a fresh one. */
export async function rebriefFreshMinion(
  input: DirectiveRoutingDeps & {
    readonly ledger: Pick<LedgerApi, 'setAgentState' | 'getAgent'>;
    jobId: string;
    note: string;
    briefing: string | null;
    /** The required work revision the request was composed with. */
    workRevision?: number | null;
    /** Resume this session file instead of minting fresh (boot recovery). */
    resumeFile?: string | null;
    /** Service-stopping signal: aborts a QUEUED admission wait and lets the
     * settlement race below observe cancellation instead of hanging
     * shutdown. Absent = settlement remains hook-owned. */
    signal?: AbortSignal;
    /** Called after the worker is registered and BEFORE its prompt is
     * delivered — the durable re-brief marker binds the worker here, so a
     * crash mid-turn leaves a resumable pointer behind. */
    onSpawned?: (worker: { readonly id: string; readonly sessionFile: string | null }) => void;
    /** Recheck request ownership and terminality at the last asynchronous
     * admission boundaries; a running prompt is allowed to settle. */
    beforeTurnSideEffect?: () => void;
    /** Issue #339: observe the settled continuation session's tool access so
     * a prohibited read during a resume/re-brief invalidates blind coverage
     * exactly like one at the first briefing. Runs on EVERY post-settlement
     * exit (the in-band-error return, the successful return, AND the
     * cancelled/exhausted/superseded failure exits). The observer owns its
     * own error handling (a bookkeeping failure must not fail a turn); absent
     * = no observation (non-review re-briefs, tests). */
    observeBlindTurn?: (jobId: string, sessionFile: string | null) => void;
  },
): Promise<{
  minionId: string;
  lanePath: string;
  prompt: string;
  sessionFile: string | null;
  /** 'error' = the prompt settled with an in-band runtime error (resolved
   * but failed): the caller must keep the request markers pending and
   * record NO delivery and NO phase completion. */
  outcome: 'completed' | 'error';
  error?: string;
}> {
  const lane = input.worktrees
    .listWorktrees({ jobId: input.jobId })
    .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
  if (lane === undefined) {
    throw new Error(`job "${input.jobId}" has no active job lane — a re-brief needs its worktree`);
  }
  const assertHandoff = capturePortLaneHandoff(input.worktrees, lane);
  const cwd = requireSpawnCwd('minion', lane.path);
  let lease: PacingLease | null = null;
  if (input.workerGate !== undefined) {
    lease = await input.workerGate.acquireWorkerTurn({
      id: input.jobId,
      label: `re-brief → ${input.jobId}`,
      jobId: input.jobId,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }
  try {
    assertHandoff();
    input.beforeTurnSideEffect?.();
    // Retirement/re-brief retires the WRITER sessions only — an active
    // child worker is not the job's minion lane (#161), and review-only
    // sessions (round/lens-bound, Gru ruling 2026-09-29) are never
    // displaced either: the implementer-only pick applies both exclusions.
    const jobMinions = input.ledger.listImplementerMinions(input.jobId);
    for (const minion of jobMinions) {
      const prior = input.registry.getHandle(minion.id);
      if (prior === null) continue;
      await input.registry.disposeHandle(prior).catch((error: unknown) => {
        throw new Error(
          `could not retire the prior minion session ${minion.id} before re-briefing: ${String(error)}`,
        );
      });
      assertHandoff();
      input.beforeTurnSideEffect?.();
    }
    assertHandoff();
    input.beforeTurnSideEffect?.();
    // Issue #161: a fresh/resumed re-brief parent keeps a product-owned id
    // (its recorded row's id, even without a transcript) plus child tools.
    const identity = parentIdentitySpawnOptions(
      input,
      input.jobId,
      input.resumeFile !== undefined && input.resumeFile !== null ? input.resumeFile : null,
    );
    const handle = await input.registry.spawn('minion', {
      cwd,
      ...(input.resumeFile !== undefined && input.resumeFile !== null ? { resumeFile: input.resumeFile } : {}),
      ...identity,
    });
    let prompt: string;
    try {
      assertHandoff();
      input.beforeTurnSideEffect?.();
      // A FRESH re-brief session (no prior row) is explicitly top-level;
      // a resumed row keeps its recorded parentage (never retro-fitted).
      input.ledger.registerAgent({
        id: handle.id,
        role: 'minion',
        sessionFile: handle.sessionFile,
        jobId: input.jobId,
        ...(input.ledger.getAgent(handle.id) === null ? { parentage: 'top-level' as const } : {}),
      });
      input.onSpawned?.({ id: handle.id, sessionFile: handle.sessionFile });
      prompt = renderRebriefPrompt({
        jobId: input.jobId,
        briefing: input.briefing,
        note: input.note,
        ...(input.workRevision !== undefined ? { workRevision: input.workRevision } : {}),
        ...(input.lessons !== undefined
          ? { lessons: input.lessons.referencesFor(`${input.note}\n${input.briefing ?? ''}`) }
          : {}),
      });
      // registerAgent publishes agent.spawned after COMMIT. A subscriber
      // can close the job or replace this request before the prompt; no
      // await may separate this last fence from prompt delivery.
      assertHandoff();
      input.beforeTurnSideEffect?.();
    } catch (error) {
      try {
        await handle.dispose();
        // Registration can commit and then throw from its publication
        // listener. Check the row rather than assuming a returned call.
        if (input.ledger.listAgents().some((agent) => agent.id === handle.id)) {
          input.ledger.setAgentState(handle.id, 'disposed');
        }
      } catch (cleanupError) {
        throw new Error(`could not dispose minion ${handle.id} after failed re-brief setup: ${String(cleanupError)}`, { cause: error });
      }
      throw error;
    }
    let promptError: unknown = null;
    let verdict: PromptTurnVerdict | null = null;
    try {
      verdict = await promptWithTerminalVerdict(handle, prompt, { owner: `silas-rebrief:${input.jobId}` });
    } catch (error) {
      promptError = error;
    } finally {
      // Release before the settlement wait: the retry reacquires the slot.
      lease?.release();
      lease = null;
    }
    // The re-brief delivery reports success only for 'none'/'recovered': a
    // rate-limited turn whose bounded retry is still carrying the prompt
    // must not land the re-brief/delivery markers early, and a rejection
    // whose retry recovers is a delivery, not a failure.
    let disposition: RetrySettlement | 'cancelled' = 'none';
    const abandonedSettlements: Promise<void>[] = [];
    try {
      disposition = await settleRetries(input.retrySettlement, handle.id, input.signal, (abandoned) => {
        abandonedSettlements.push(abandoned);
      });
    } finally {
      // Issue #339: observe the settled continuation turn's own tool results
      // at THIS settle seam on EVERY post-settlement exit — including the
      // failure exits below AND a settlement-hook fault (a named
      // RetrySettlementUnavailableError propagates only after this runs).
      // Running it before the cancelled/exhausted/superseded throws keeps a
      // failed continuation from leaving unscanned prohibited reads behind
      // (only a future successful resume would otherwise heal it).
      // `handle.sessionFile` is the resumed session (the whole file,
      // cumulative), read-only with respect to the review inputs. The
      // observer owns its error handling (a bookkeeping failure must not fail
      // a delivered turn).
      input.observeBlindTurn?.(input.jobId, handle.sessionFile);
      for (const abandoned of abandonedSettlements) {
        // Issue #339: cancellation won the race before the retry turn
        // settled; it can still append prohibited reads AFTER the scan just
        // above, so chain a FINAL observation onto the abandoned settlement.
        void abandoned.then(() => input.observeBlindTurn?.(input.jobId, handle.sessionFile));
      }
    }
    if (disposition === 'cancelled') {
      throw new Error(`re-brief turn on ${handle.id} was cancelled before its automatic retries settled`);
    }
    if (disposition === 'exhausted' || disposition === 'superseded') {
      throw new Error(`re-brief turn failed on ${handle.id}: automatic rate-limit retry ${disposition} before delivery`);
    }
    if (promptError !== null && disposition !== 'recovered') {
      throw new Error(`re-brief turn failed on ${handle.id}: ${String(promptError)}`);
    }
    // Terminal/error correlation (r4/r5 blocker 1): the transport captured
    // the verdict when THIS prompt settled, before any queued successor
    // could start, and it is held across the retry settlement. A
    // resolved-but-errored turn is not a delivery; a retry-recovered
    // disposition is the retry's own clean turn.
    const evidence =
      disposition === 'recovered'
        ? ({ ok: true, error: null } as const)
        : (verdict ?? promptVerdictFromHealth(handle));
    return {
      minionId: handle.id,
      lanePath: lane.path,
      prompt,
      sessionFile: handle.sessionFile,
      ...verdictFields(evidence),
    };
  } finally {
    lease?.release();
  }
}
