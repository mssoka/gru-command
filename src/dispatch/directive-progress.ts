import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import type { LedgerApi } from '../ledger/api.js';
import { LIVE_DIRECTIVE_STATES, isDirectiveTerminal } from '../ledger/directives.js';
import { isJobTerminal } from '../ledger/states.js';
import { DirectiveCheckpointError, directiveProducerLockBlocker, directiveSessionLockBlocker, inspectDirectiveAdmission, inspectDirectiveCheckpoint, inspectDirectiveProducers, readDirectiveBinding, readDirectiveCompletion, readDirectiveSessionHeader, type DirectiveCheckpoint, type DirectiveProducer, type DirectiveTurnIdentity } from '../runtime/directive-checkpoint.js';
import type { AgentHandle, NativeAgentTool } from '../runtime/types.js';
import type { PacingGate, PacingLease, RetrySettlement } from '../runtime/pacing.js';
import { DirectiveDispatchDeferredError, flipJobToWorking, recordFollowUpDelivery, renderRebriefPrompt, routeFixDirectiveToMinion, type DirectiveRegistry } from './fix-directive.js';
import { observePendingRebriefs, type RecoveryNotifications } from './rebrief-recovery.js';
import type { WorktreeLane, WorktreePort } from './worktree-port.js';
import type { LessonsReferencePort } from '../lessons/types.js';
import { resolveGitCommit } from './perkins-review/artifacts.js';
import { surfaceRecoveryOwnerTransfer } from './recovery-owner.js';

export interface DirectiveProgressDeps {
  readonly ledger: LedgerApi;
  readonly registry: DirectiveRegistry;
  readonly worktrees: WorktreePort;
  readonly notifications: RecoveryNotifications;
  readonly pendingProducerBlockers: (jobId: string, currentNative?: { readonly handle: AgentHandle; readonly producer: DirectiveProducer }) => readonly string[];
  readonly signal: AbortSignal;
  readonly workerGate?: PacingGate;
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  readonly parentTools?: (agentId: string) => readonly NativeAgentTool[];
  readonly lessons?: LessonsReferencePort;
  readonly observeBlindTurn?: (jobId: string, sessionFile: string | null) => void;
  /** Job-admission kinds owned by the calling service that legitimately span this directive (e.g. an owner-approved property repair allocation). */
  readonly ownAdmissionKinds?: readonly string[];
  readonly clearLaneForWriter?: (input: { readonly jobId: string; readonly writer: string }) => Promise<unknown>;
  /** Issue #243 F-H2/F-H3: an optional caller re-proof (owner hold, verification
   * ownership) run at every post-wait writer admission boundary inside the
   * route. A throw refuses BEFORE any prompt/durable effect. */
  readonly beforeWriterSideEffect?: () => void;
}
function check(deps: DirectiveProgressDeps, identity: DirectiveTurnIdentity): void {
  if (deps.signal.aborted) throw new DirectiveCheckpointError('service stopping — directive recovery cancelled');
  deps.ledger.assertDirectiveAuthority(identity);
}
/** A caller's admission re-check (`beforeWriterSideEffect`) refused at a
 * post-wait boundary — after pacing, around spawn/resume or immediately
 * before the prompt, each of which precedes that boundary's prompt (#364).
 * It is a positive no-effect only when {@link promptRefusalIsNoEffect}
 * holds; then the request fails by name instead of staying live for
 * reconciliation and fencing the lane. */
export class DirectivePromptRefusedError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'DirectivePromptRefusedError'; }
}

/** #364: an admission refusal fails the request by name only when nothing
 * can have reached the minion — no native admission was bound this turn,
 * the refusal is the ONLY failure (every cleanup settled), and no prepared
 * producer outlives it (none was prepared, or it proved cessation; an
 * unreadable cessation is unproven). Anything else stays live for
 * reconciliation. Returns the reason it is NOT a no-effect, or null. */
export function promptRefusalUnproven(input: {
  readonly error: unknown;
  readonly failures: number;
  readonly admitted: boolean;
  readonly prepared: Pick<AgentHandle, 'id' | 'cessationEvidence'> | undefined;
}): string | null {
  if (!(input.error instanceof DirectivePromptRefusedError)) return 'not an admission refusal';
  if (input.failures !== 1) return 'a cleanup also failed';
  if (input.admitted) return 'a native admission was already bound';
  if (input.prepared === undefined) return null;
  let evidence: string | undefined;
  try { evidence = input.prepared.cessationEvidence?.(); } catch (error) { evidence = `unreadable: ${String(error)}`; }
  return evidence === 'ceased' ? null : `prepared producer ${input.prepared.id} has not proven cessation (${evidence ?? 'no cessation evidence'})`;
}

/** The target minion's runtime cannot host a native directive at all. Raised
 * before any target binding, header read or prompt — positive no-effect. */
class DirectiveRuntimeUnsupportedError extends DirectiveCheckpointError {
  constructor(message: string) { super(message); this.name = 'DirectiveRuntimeUnsupportedError'; }
}
/** A runtime without native admission/producer attestation (claude-code
 * declares this gap) must be refused before the target is bound: a bound
 * target whose producer journal can never exist leaves cessation UNKNOWN
 * forever, turning a declared runtime gap into an owner-only stop. */
function assertNativeDirectiveRuntime(handle: AgentHandle): asserts handle is AgentHandle & {
  readonly sessionFile: string;
  readonly prepareDirectiveProducer: NonNullable<AgentHandle['prepareDirectiveProducer']>;
} {
  if (handle.sessionFile === null || handle.inspectDirective === undefined || handle.prepareDirectiveProducer === undefined) {
    throw new DirectiveRuntimeUnsupportedError(
      `minion ${handle.id} runs on a runtime that cannot attest native directive admission or producer ownership ` +
        '(the claude-code runtime declares this gap); Silas directives and re-briefs need a pi-hosted minion',
    );
  }
}
interface CleanupOwner {
  readonly identity: DirectiveTurnIdentity;
  readonly handle: AgentHandle;
  readonly producerStartSeq?: number;
  readonly unknownRequired: boolean;
  baselineSeq: number | null;
  unknownSeq: number | null;
  retry: Promise<void> | null;
}
const cleanupIncarnations = new WeakMap<AgentHandle, string>();
const unknownCleanup = new WeakMap<LedgerApi, Map<string, CleanupOwner>>();
function cleanupOwnershipBlockers(ledger: LedgerApi, jobId: string): readonly string[] {
  return [...(unknownCleanup.get(ledger)?.values() ?? [])].filter((owner) => owner.identity.jobId === jobId)
    .map(({ identity, handle }) => `retained producer cleanup: minion ${handle.id}, request ${identity.requestId}`);
}
function recordCleanup(deps: DirectiveProgressDeps, identity: DirectiveTurnIdentity, handle: AgentHandle, producerStartSeq?: number): void {
  let incarnation = cleanupIncarnations.get(handle);
  if (incarnation === undefined) { incarnation = randomUUID(); cleanupIncarnations.set(handle, incarnation); }
  const key = `${identity.requestId}:${producerStartSeq ?? incarnation}`;
  let owned = unknownCleanup.get(deps.ledger);
  if (owned === undefined) { owned = new Map(); unknownCleanup.set(deps.ledger, owned); }
  let ceased = false;
  try { ceased = handle.cessationEvidence?.() === 'ceased'; } catch { /* UNKNOWN remains a durable fence. */ }
  let owner = owned.get(key);
  if (owner === undefined) {
    if (ceased && producerStartSeq === undefined) return;
    owner = { identity, handle, producerStartSeq, unknownRequired: !ceased, baselineSeq: null, unknownSeq: null, retry: null };
    // Keep the real retry handle BEFORE storage/publication can fail.
    owned.set(key, owner);
  }
  const receipt = (kind: string, afterSeq: number): number | null => {
    const event = deps.ledger.latestJobEventByRequestId(identity.jobId, kind, identity.requestId);
    const payload = event?.payload as { agent_id?: unknown; producer_start_seq?: unknown } | undefined;
    return event !== null && payload?.agent_id === handle.id &&
      (owner.producerStartSeq === undefined ? event.seq > afterSeq : payload.producer_start_seq === owner.producerStartSeq) ? event.seq : null;
  };
  const publish = (kind: string, afterSeq: number): number => receipt(kind, afterSeq) ??
    deps.ledger.appendCustomEvent({ kind, jobId: identity.jobId,
      payload: { request_id: identity.requestId, agent_id: handle.id,
        ...(owner.unknownSeq === null ? {} : { producer_unknown_seq: owner.unknownSeq }),
        ...(owner.producerStartSeq === undefined ? { session_file: handle.sessionFile } : { producer_start_seq: owner.producerStartSeq, producer_identity: identity, session_file: handle.sessionFile, native_producer: (deps.ledger.getEvent(owner.producerStartSeq)!.payload as { native_producer?: unknown }).native_producer }) } }).seq;
  // An append may commit, then throw in publication. On the next pass,
  // reconcile that exact new receipt rather than append duplicate history.
  owner.baselineSeq ??= deps.ledger.latestEventSeq();
  if (owner.unknownRequired) owner.unknownSeq ??= publish('silas.directive-producer-unknown', owner.baselineSeq);
  if (!ceased) return;
  publish('silas.directive-producer-ceased', owner.unknownSeq ?? owner.baselineSeq);
  owned.delete(key); // only after genuine cessation AND committed publication
}

/** Retry only the retained exact physical handle. Coalesce across services;
 * disposal fulfillment still grants no cessation or work permission. */
function retryCleanup(deps: DirectiveProgressDeps, owner: CleanupOwner): Promise<void> {
  if (owner.retry !== null) return owner.retry;
  owner.retry = Promise.resolve().then(async () => {
    const failures: unknown[] = [];
    try { await deps.registry.disposeHandle(owner.handle); } catch (error) { failures.push(error); }
    try { recordCleanup(deps, owner.identity, owner.handle, owner.producerStartSeq); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `retained native cleanup retry failed: ${failures.map(String).join('; ')}`);
  }).finally(() => { owner.retry = null; });
  return owner.retry;
}

function checkAdmissionFences(deps: DirectiveProgressDeps, identity: DirectiveTurnIdentity, handle?: AgentHandle, producerStartSeq?: number, producer?: DirectiveProducer, historicalReceipt = false): void {
  if (!historicalReceipt) check(deps, identity);
  const lane = deps.worktrees.listWorktrees({ jobId: identity.jobId }).find((lane) => lane.kind === 'job' && lane.status !== 'swept');
  const target = deps.ledger.getDirective(identity.requestId)?.nativeTarget;
  const ownSpawningAgentId = handle?.health().state === 'idle' && (target == null || (target.agentId === handle.id && target.sessionFile === handle.sessionFile)) ? handle.id : undefined;
  const ownNativeProducer = handle?.id === producer?.agentId && handle?.sessionFile === producer?.sessionFile ? producer : undefined;
  const durable = deps.ledger.directiveProgressBlockers(identity.requestId, lane?.id ?? '', ownSpawningAgentId, producerStartSeq, ownNativeProducer)
    .filter((blocker) => !blocker.startsWith('in-flight admission(s):'));
  const own = new Set([`directive ${identity.requestId}`, `directive recovery ${identity.requestId}`, `rebrief ${identity.requestId}`, ...(deps.ownAdmissionKinds ?? [])]);
  const reservations = deps.ledger.listJobAdmissions(identity.jobId).filter((kind) => !own.has(kind));
  const supervised = [...deps.pendingProducerBlockers(identity.jobId, handle !== undefined && ownNativeProducer !== undefined ? { handle, producer: ownNativeProducer } : undefined), ...cleanupOwnershipBlockers(deps.ledger, identity.jobId)];
  if (durable.length + reservations.length + supervised.length > 0) throw new DirectiveCheckpointError(`directive producer fences: ${[...durable, ...reservations, ...supervised].join('; ')}`);
}

/** Shared HTTP/fresh-successor path. The adapter, not prompt fulfillment,
 * binds actual admission. The same native readback settles boot recovery. */
export async function executeAcceptedDirective(deps: DirectiveProgressDeps, requestId: string): Promise<void> {
  const identity = deps.ledger.directiveTurnIdentity(requestId);
  const row = deps.ledger.getDirective(requestId)!;
  check(deps, identity);
  const release = deps.ledger.beginJobAdmission(row.jobId, `directive ${requestId}`);
  let preparedHandle: AgentHandle | undefined;
  let preparedCleanupAttempted = false;
  let admitted = false;
  let producerStartSeq: number | undefined;
  let dispatchStartSeq: number | undefined;
  let preparedProducer: DirectiveProducer | undefined;
  let originalLane: Pick<WorktreeLane, 'id' | 'path' | 'branch'> | undefined;
  const checkFreshAdmission = (handle?: AgentHandle): void => {
    const lanes = deps.worktrees.listWorktrees({ jobId: identity.jobId }).filter((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
    if (originalLane === undefined || originalLane.branch === null || lanes.length !== 1 || lanes[0]?.id !== originalLane.id ||
        lanes[0].path !== originalLane.path || lanes[0].branch !== originalLane.branch) {
      throw new DirectiveCheckpointError('original registered branch/lane is unavailable or changed; fresh native directive effects are forbidden');
    }
    let branch: string;
    try { branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: originalLane.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim(); }
    catch (error) { throw new DirectiveCheckpointError(`original registered branch cannot be proven; fresh native directive effects are forbidden: ${String(error)}`); }
    if (branch !== originalLane.branch) throw new DirectiveCheckpointError('original registered branch differs from the checkout; fresh native directive effects are forbidden');
    const prepared = preparedHandle ?? handle;
    if (prepared !== undefined) assertNativeDirectiveRuntime(prepared);
    if (prepared !== undefined && readDirectiveSessionHeader(prepared.sessionFile).cwd !== originalLane.path) {
      throw new DirectiveCheckpointError('original native cwd differs from its registered lane; fresh directive effects are forbidden');
    }
    checkAdmissionFences(deps, identity, prepared, producerStartSeq, preparedProducer);
  };
  try {
    if (!deps.ledger.claimDirectiveDispatch(requestId)) return;
    const lanes = deps.worktrees.listWorktrees({ jobId: identity.jobId }).filter((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
    if (lanes.length === 1) { const { id, path, branch } = lanes[0]!; originalLane = { id, path, branch }; }
    dispatchStartSeq = deps.ledger.latestJobEventByRequestId(row.jobId, 'silas.directive-dispatch-started', requestId)!.seq;
    if (row.requestKind === 'rebrief' && deps.clearLaneForWriter !== undefined) {
      check(deps, identity);
      try { await deps.clearLaneForWriter({ jobId: row.jobId, writer: `rebrief ${requestId}` }); }
      catch (error) { throw new DirectiveDispatchDeferredError(error); }
      check(deps, identity); // review clearance is not native admission or permission
    }
    const payload = JSON.parse(row.payload) as { directive: string };
    const directive = row.requestKind === 'rebrief' ? renderRebriefPrompt({ jobId: row.jobId, note: payload.directive, briefing: row.contractSnapshot, workRevision: identity.workRevision }) : payload.directive;
    const result = await routeFixDirectiveToMinion({ ...deps, jobId: row.jobId, directive, freshSession: row.requestKind === 'rebrief',
      contract: row.contractSnapshot, owner: `silas-directive:${requestId}`,
      ...(row.contractSnapshot === null || row.requestKind === 'rebrief' ? {} : { continuation: {
        block: `Approved contract revision ${identity.workRevision} at request acceptance:\n${row.contractSnapshot}`,
        freshNote: `Service-bound contract revision ${identity.workRevision}.`,
      } }),
      beforeTurnSideEffect: checkFreshAdmission,
      onCleanup: (handle) => {
        if (handle === preparedHandle) preparedCleanupAttempted = true;
        if (handle === preparedHandle && producerStartSeq === undefined) {
          const committed = deps.ledger.latestJobEventByRequestId(identity.jobId, 'silas.directive-producer-started', identity.requestId);
          const native = (committed?.payload as { native_producer?: { incarnation?: string } } | undefined)?.native_producer;
          if (native?.incarnation !== undefined && native.incarnation === preparedProducer?.incarnation) producerStartSeq = committed!.seq;
        }
        recordCleanup(deps, identity, handle, handle === preparedHandle ? producerStartSeq : undefined);
      },
      onPrepared: (handle) => {
        preparedHandle = handle;
        check(deps, identity);
        assertNativeDirectiveRuntime(handle);
        deps.ledger.prepareDirectiveTarget(requestId, { agentId: handle.id, sessionFile: handle.sessionFile });
        preparedProducer = handle.prepareDirectiveProducer(identity);
        producerStartSeq = deps.ledger.startDirectiveProducer(identity, preparedProducer);
      },
      directiveTurn: { identity, beforeAdmission: () => checkFreshAdmission(),
        onAdmitted: (binding) => { admitted = true; deps.ledger.bindDirectiveNativeAdmission(binding); } },
    });
    // Resident routing does not dispose; the same prepared native owner
    // must prove cleanup too. Fresh routing has already disposed/journaled.
    if (preparedHandle !== undefined) {
      if (!preparedCleanupAttempted) {
        preparedCleanupAttempted = true;
        const failures: unknown[] = [];
        try { await deps.registry.disposeHandle(preparedHandle); } catch (error) { failures.push(error); }
        try { recordCleanup(deps, identity, preparedHandle, producerStartSeq); } catch (error) { failures.push(error); }
        if (failures.length > 0) throw new AggregateError(failures, `directive cleanup failed: ${failures.map(String).join('; ')}`);
      }
      if (preparedHandle.cessationEvidence?.() !== 'ceased') throw new DirectiveCheckpointError(`cleanup retains explicit producer ownership for minion ${preparedHandle.id}`);
    }
    check(deps, identity);
    if (!result.delivered) {
      if (result.admission === 'none') deps.ledger.failDirective({ requestId, reason: result.note ?? 'proven no effect before native admission' });
      else throw new DirectiveCheckpointError(result.note ?? 'directive admission remains unknown');
      return;
    }
    if (result.outcome === 'error') {
      deps.ledger.appendCustomEvent({ kind: 'job.minion-error', jobId: row.jobId, payload: { agentId: result.minionId, error: result.error ?? 'in-band runtime error', request_id: requestId } });
      throw new DirectiveCheckpointError(`in-band runtime error: ${result.error ?? 'directive native turn failed'}`);
    }
    settleNativeDirective(deps, identity);
  } catch (error) {
    const failures: unknown[] = [error];
    if (error instanceof DirectiveDispatchDeferredError && dispatchStartSeq !== undefined) {
      try { deps.ledger.recordDirectiveDispatchDeferral(identity, dispatchStartSeq, String(error)); }
      catch (journalError) { failures.push(journalError); }
    }
    if (preparedHandle !== undefined && !preparedCleanupAttempted) {
      preparedCleanupAttempted = true;
      try { await deps.registry.disposeHandle(preparedHandle); } catch (cleanupError) { failures.push(cleanupError); }
      try { recordCleanup(deps, identity, preparedHandle, producerStartSeq); } catch (journalError) { failures.push(journalError); }
    }
    const failure = failures.length === 1 ? error : new AggregateError(failures, `directive execution/cleanup failed: ${failures.map(String).join('; ')}`);
    const unproven = promptRefusalUnproven({ error, failures: failures.length, admitted, prepared: preparedHandle });
    const promptRefused = error instanceof DirectivePromptRefusedError && unproven === null;
    if ((error instanceof DirectiveRuntimeUnsupportedError || promptRefused) && failures.length === 1 && !deps.signal.aborted) {
      // Refused before any prompt, every cleanup settled and no prepared
      // producer outlives it: a positive no-effect. A runtime refusal cannot
      // change on retry; an admission refusal is the caller's fresh decision.
      deps.ledger.failDirective({ requestId, reason: promptRefused ? `refused before any prompt: ${error.message}` : error.message });
    } else if (!deps.signal.aborted) {
      // An admission refusal that cannot be proven a no-effect says why.
      const note = error instanceof DirectivePromptRefusedError ? `${String(failure)} — kept for reconciliation: ${unproven ?? 'unknown'}` : String(failure);
      deps.ledger.recordDirectiveReconcile({ requestId, note });
      surfaceDirectiveRecovery(deps, requestId, note);
    }
  } finally { release(); }
}

/** Account only for exact physical ownership. A safe transcript never alone
 * proves producer cessation, and original host death never proves tool death. */
function reconcileNativeProducer(deps: DirectiveProgressDeps, identity: DirectiveTurnIdentity): void {
  const row = deps.ledger.getDirective(identity.requestId)!;
  if (row.nativeTarget === null) return;
  const proof = inspectDirectiveCheckpoint(row.nativeTarget.sessionFile, identity);
  const owners = inspectDirectiveProducers(row.nativeTarget.sessionFile, identity);
  const sessionOwners = inspectDirectiveProducers(row.nativeTarget.sessionFile);
  if (owners.length === 0 || sessionOwners.some(({ evidence }) => evidence === 'unknown')) throw new DirectiveCheckpointError(`exact original physical native producer cessation unproven; start ${deps.ledger.latestJobEventByRequestId(identity.jobId, 'silas.directive-producer-started', identity.requestId)?.seq ?? 'unbound'}`);
  if (owners.some(({ evidence }) => evidence === 'host-absent') && (proof.state === 'unknown' || (proof.state === 'terminal' && !proof.ok))) {
    throw new DirectiveCheckpointError('original host absent but native effects/checkpoint remain incomplete');
  }
  const start = deps.ledger.latestJobEventByRequestId(identity.jobId, 'silas.directive-producer-started', identity.requestId);
  const producer = (start?.payload as { native_producer?: unknown } | undefined)?.native_producer;
  const owner = start === null ? owners.at(-1) : owners.find(({ producer: native }) => JSON.stringify(native) === JSON.stringify(producer));
  if (owner === undefined) throw new DirectiveCheckpointError('legacy/unbound physical producer start remains UNKNOWN');
  const agent = deps.ledger.getAgent(owner.producer.agentId);
  const lockBlocker = directiveProducerLockBlocker(sessionOwners.at(-1)!.producer);
  if (lockBlocker !== null) throw new DirectiveCheckpointError(lockBlocker);
  if (JSON.stringify(sessionOwners.at(-1)?.producer) === JSON.stringify(owner.producer) && agent?.jobId === identity.jobId &&
      agent.sessionFile === owner.producer.sessionFile && deps.registry.getHandle(agent.id) === null && agent.state !== 'disposed') {
    deps.ledger.setAgentState(agent.id, 'disposed'); // exact physical cessation, never permission; repair receipt replay too
  }
  if (start === null) return;
  const ceased = deps.ledger.latestJobEventByRequestId(identity.jobId, 'silas.directive-producer-ceased', identity.requestId);
  if ((ceased?.payload as { producer_start_seq?: unknown } | undefined)?.producer_start_seq === start.seq) return;
  // Record this positively proven physical cessation before admission checks:
  // its own durable UNKNOWN cleanup is precisely the debt being reconciled.
  // This is no work permission; callers retain all independent fences before
  // publishing delivery, consuming a checkpoint or starting another producer.
  deps.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: identity.jobId, payload: {
    request_id: identity.requestId, agent_id: owner.producer.agentId, session_file: owner.producer.sessionFile,
    producer_start_seq: start.seq, producer_identity: identity, native_producer: owner.producer, evidence: owner.evidence,
  } });
}

/** Host absence is usable only with the exact successful accountable
 * checkpoint. Both first publication and receipt replay still run the
 * complete independent admission/producer fences after this inspection. */
function assertCompletedNativeOwnership(file: string, identity: DirectiveTurnIdentity, proof: Extract<DirectiveCheckpoint, { state: 'terminal' }>): void {
  const owners = inspectDirectiveProducers(file, identity);
  const sessionOwners = inspectDirectiveProducers(file);
  if (!proof.ok || owners.length === 0 || owners.some(({ producer }) => producer.agentId !== proof.binding.agentId || producer.sessionId !== proof.binding.sessionId) ||
      sessionOwners.length === 0 || sessionOwners.some(({ evidence }) => evidence === 'unknown') || directiveSessionLockBlocker(file) !== null) {
    throw new DirectiveCheckpointError('correlated delivery retains UNKNOWN native physical ownership');
  }
}

/** Completion first, correlated and idempotent: no worker execution. */
export function settleNativeDirective(deps: DirectiveProgressDeps, identity: DirectiveTurnIdentity): boolean {
  let row = deps.ledger.getDirective(identity.requestId);
  if (row === null || isDirectiveTerminal(row.state)) return row?.state === 'settled';
  // Historical admission is an exact prefix fact, not work permission.
  // Restore it even when later bytes/effects or physical ownership are UNKNOWN.
  if (row.nativeTarget !== null) row = deps.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(row.nativeTarget.sessionFile, identity));
  const landed = deps.ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId);
  if (landed !== null && row.state === 'admitted') {
    if (deps.ledger.recoveryOwnerBasis('directive', row.requestId).owned) throw new DirectiveCheckpointError('original receipt remains owned by its explicitly transferred owner reservation');
    if (row.nativeTarget === null) throw new DirectiveCheckpointError('correlated delivery lacks its persisted native target');
    reconcileNativeProducer(deps, identity);
    const proof = inspectDirectiveCheckpoint(row.nativeTarget.sessionFile, identity);
    if (proof.state !== 'terminal' || !proof.ok) throw new DirectiveCheckpointError('correlated delivery lacks an exact successful native terminal checkpoint');
    const completion = readDirectiveCompletion(row.nativeTarget.sessionFile, identity, proof.checkpointId);
    assertCompletedNativeOwnership(row.nativeTarget.sessionFile, identity, proof);
    const payload = landed.payload as { request_id?: unknown; agentId?: unknown; sha?: unknown; work_revision?: unknown; candidate_delivery_proven?: unknown; native_completion?: unknown };
    const job = deps.ledger.getJob(identity.jobId);
    const currentAuthority = deps.ledger.directiveCurrentAuthority(identity.jobId);
    const historical = job?.status === 'parked' || currentAuthority.workRevision !== identity.workRevision ||
      currentAuthority.contractSha256 !== identity.contractSha256 || currentAuthority.authorityEpoch !== identity.authorityEpoch;
    if (historical && payload.request_id === identity.requestId && payload.agentId === proof.binding.agentId && payload.work_revision === 0 &&
        payload.candidate_delivery_proven !== true && payload.native_completion == null) {
      checkAdmissionFences(deps, identity, undefined, undefined, undefined, true);
      deps.ledger.recordDirectiveDelivery({ requestId: row.requestId, eventSeq: landed.seq });
      return true;
    }
    const native = typeof payload.native_completion === 'object' && payload.native_completion !== null
      ? payload.native_completion as { identity?: unknown; checkpoint_id?: unknown; binding?: unknown; receipt?: unknown }
      : null;
    if (payload.request_id !== identity.requestId || payload.agentId !== proof.binding.agentId || payload.work_revision !== identity.workRevision ||
        payload.sha !== (completion?.head ?? null) || typeof payload.candidate_delivery_proven !== 'boolean' ||
        payload.candidate_delivery_proven && (completion === null || completion.head === null) ||
        native === null || !isDeepStrictEqual(native.identity, identity) || native.checkpoint_id !== proof.checkpointId ||
        !isDeepStrictEqual(native.binding, proof.binding) || !isDeepStrictEqual(native.receipt, completion)) {
      throw new DirectiveCheckpointError('correlated delivery does not bind the exact native completion receipt and checkpoint');
    }
    checkAdmissionFences(deps, identity, undefined, undefined, undefined, true);
    deps.ledger.recordDirectiveDelivery({ requestId: row.requestId, eventSeq: landed.seq });
    return true;
  }
  if (row.nativeTarget === null) return false;
  reconcileNativeProducer(deps, identity);
  const proof = inspectDirectiveCheckpoint(row.nativeTarget.sessionFile, identity);
  const binding = readDirectiveBinding(row.nativeTarget.sessionFile, identity.requestId);
  if (binding?.userEntryId != null) deps.ledger.bindDirectiveNativeAdmission(binding);
  if (proof.state !== 'terminal' || !proof.ok) return false;
  assertCompletedNativeOwnership(row.nativeTarget.sessionFile, identity, proof);
  const completion = readDirectiveCompletion(row.nativeTarget.sessionFile, identity, proof.checkpointId);
  const current = deps.ledger.directiveCurrentAuthority(identity.jobId);
  if (deps.ledger.getJob(identity.jobId)?.status === 'parked' || current.workRevision !== identity.workRevision || current.contractSha256 !== identity.contractSha256 || current.authorityEpoch !== identity.authorityEpoch) {
    if (deps.signal.aborted) throw new DirectiveCheckpointError('service stopping — historical bookkeeping cancelled');
    checkAdmissionFences(deps, identity, undefined, undefined, undefined, true);
    const lane = deps.worktrees.listWorktrees({ jobId: identity.jobId }).find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
    deps.ledger.recordHistoricalNativeDirectiveCompletion(identity, lane?.id ?? '');
    return true;
  }
  check(deps, identity);
  checkAdmissionFences(deps, identity);
  // Preserve the exact accepted revision; completion proves no newer input.
  flipJobToWorking(deps.ledger, identity.jobId);
  check(deps, identity);
  const phase = deps.ledger.findPhaseHandoffByRequest({ jobId: row.jobId, requestId: row.requestId });
  if (row.requestKind === 'rebrief' && deps.ledger.latestJobEventByRequestId(row.jobId, 'silas.rebrief', row.requestId) === null) {
    deps.ledger.appendCustomEventIfCurrentDirective({ kind: 'silas.rebrief', jobId: row.jobId, payload: {
      request_id: row.requestId, minion_id: proof.binding.agentId, note: (JSON.parse(row.payload) as { directive: string }).directive,
      ...(phase === null ? {} : { phase_id: phase.phaseId }),
      ...(row.sourceContext?.ruleId === undefined ? {} : { rule_id: row.sourceContext.ruleId }),
      ...(row.sourceContext?.sourceRoundId === undefined ? {} : { source_round_id: row.sourceContext.sourceRoundId }),
      ...(row.sourceContext?.source === undefined ? {} : { source: row.sourceContext.source }),
    } }, identity);
  }
  const delivery = recordFollowUpDelivery({ ledger: {
    appendCustomEvent: (fields) => deps.ledger.appendCustomEventIfCurrentDirective({ kind: fields.kind, jobId: identity.jobId, payload: fields.payload }, identity),
    getJob: (id) => deps.ledger.getJob(id), openReportObligation: (fields) => deps.ledger.openReportObligation(fields),
  }, worktrees: deps.worktrees, jobId: row.jobId,
    agentId: proof.binding.agentId, source: row.requestKind === 'rebrief' ? 'silas-rebrief' : 'silas-directive', requestId: row.requestId,
    ...(phase === null ? {} : { phaseId: phase.phaseId }), workRevision: identity.workRevision,
    nativeCompletion: { sha: completion?.head ?? null, provenance: { identity, checkpoint_id: proof.checkpointId, binding: proof.binding,
      receipt: completion, physical_cessation: inspectDirectiveProducers(row.nativeTarget.sessionFile, identity) } } });
  deps.ledger.recordDirectiveDelivery({ requestId: row.requestId, eventSeq: delivery.eventSeq });
  if (delivery.sha === null) deps.ledger.recordBlockedObservation(row.jobId, { logicalStep: 'operation',
    incidentKey: `directive-completion-head:${row.requestId}`, category: { kind: 'known', category: 'restart-recovery' }, observedAtSeq: delivery.eventSeq,
    nextAction: { kind: 'gru-decision', decision: `Original request ${row.requestId} genuinely completed accepted revision ${identity.workRevision}, but its completion HEAD is unproven. Preserve that progress; inspect current original-lane artifacts and use separately accepted current authority/current-head verification and review. Never invent the old HEAD or replay the request.` } });
  return true;
}

export function surfaceDirectiveRecovery(deps: Pick<DirectiveProgressDeps, 'ledger' | 'notifications'>, requestId: string, reason: string): void {
  const row = deps.ledger.getDirective(requestId);
  const job = row === null ? null : deps.ledger.getJob(row.jobId);
  if (row === null || isDirectiveTerminal(row.state) || job === null || isJobTerminal(job.status)) return;
  if (deps.ledger.recoveryOwnerBasis('directive', requestId).owned) {
    surfaceRecoveryOwnerTransfer(deps, 'directive', requestId);
    return;
  }
  const debt = deps.ledger.openDirectiveRecoveryDebt(requestId, reason);
  const current = deps.ledger.directiveCurrentAuthority(row.jobId);
  deps.notifications.postIncident({ kind: `silas.directive-unreconciled.${requestId}`, routing: 'action-required', severity: 'error',
    title: `Directive ${requestId}: concrete Gru recovery decision owed (job ${row.jobId})`,
    detail: `Request ${requestId}; payload_hash ${row.payloadHash}; generation ${debt.generation}; authority_epoch ${deps.ledger.directiveRecoveryEpoch(row.jobId)}; ` +
      `current approved work_revision ${current.workRevision}, contract_sha256 ${current.contractSha256}; native target ${JSON.stringify(row.nativeTarget)}; blocker/evidence: ${reason}. Inspect GET /api/silas/directives/${requestId}, ` +
      `then POST /api/silas/directives/${requestId}/recover with a fresh named successor or a real reserved owner obligation. ` +
      'No prompt replay. Retirement alone, generic Ops holds and prose disposition do not settle this debt.',
    ...(row.admissionMinion === null ? {} : { agentId: row.admissionMinion }), dedupe: 'active' });
}

/** One service owns all background continuations. Bounded round-robin
 * reconsideration never abandons other lanes behind an ambiguous prefix. */
export class DirectiveProgressService {
  private readonly active = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly stop = new AbortController();
  private readonly deps: DirectiveProgressDeps;
  private readonly bootWatermark: number;
  constructor(deps: DirectiveProgressDeps) {
    this.deps = { ...deps, signal: AbortSignal.any([deps.signal, this.stop.signal]) };
    this.bootWatermark = deps.ledger.latestEventSeq();
  }

  reconsider(limit = 100): void {
    if (this.disposed || this.deps.signal.aborted) return;
    const retained = unknownCleanup.get(this.deps.ledger);
    for (const [key, owner] of retained ?? []) {
      recordCleanup(this.deps, owner.identity, owner.handle, owner.producerStartSeq);
      if (retained?.get(key) !== owner || this.active.has(owner.identity.requestId)) continue;
      const { identity } = owner;
      const release = this.deps.ledger.beginJobAdmission(identity.jobId, `directive cleanup ${identity.requestId}`);
      const run = retryCleanup(this.deps, owner).catch((error: unknown) => {
        if (!this.deps.signal.aborted) surfaceDirectiveRecovery(this.deps, identity.requestId, String(error));
      }).finally(() => { release(); this.active.delete(identity.requestId); });
      this.active.set(identity.requestId, run);
    }
    const scope = 'directive-native-progress';
    let cursor = this.deps.ledger.readReconcileCursor(scope) ?? 0;
    const rows = this.deps.ledger.listPendingDirectives({ states: LIVE_DIRECTIVE_STATES, rowidCursor: cursor, limit });
    for (const row of rows) {
      cursor = this.deps.ledger.directiveRowid(row.requestId) ?? cursor;
      if (this.active.has(row.requestId) || this.deps.ledger.listJobAdmissions(row.jobId).length > 0) continue;
      // Publication may run inside synchronous intake before its HTTP owner
      // reserves. Observe only after that turn, rechecking ownership; this
      // never provides no-effect proof or permission to dispatch a null target.
      if (row.baselineSeq >= this.bootWatermark && row.dispatchStartedAt === null && row.failReason === null && !this.deps.ledger.isRecoverySuccessor(row.requestId)) {
        queueMicrotask(() => {
          const current = this.deps.ledger.getDirective(row.requestId);
          if (!this.disposed && !this.deps.signal.aborted && !this.active.has(row.requestId) && current?.state === 'dispatching' &&
              current.dispatchStartedAt === null && this.deps.ledger.listJobAdmissions(row.jobId).length === 0) this.start(row.requestId);
        });
        continue;
      }
      const job = this.deps.ledger.getJob(row.jobId);
      if (job === null || isJobTerminal(job.status)) continue;
      if (this.deps.ledger.recoveryOwnerBasis('directive', row.requestId).owned) {
        surfaceRecoveryOwnerTransfer(this.deps, 'directive', row.requestId);
        continue;
      }
      this.start(row.requestId);
    }
    this.deps.ledger.writeReconcileCursor({ scope, cursor: rows.length < limit ? 0 : cursor });
    // Historical ambiguity must not monopolize native dispatch. Observe its
    // independent bounded page after scheduling unrelated authorized work;
    // storage/publication failures still fail the deterministic pass loudly.
    observePendingRebriefs({ ...this.deps, stopSignal: this.deps.signal }, { limit });
  }

  private start(requestId: string): void {
    const row = this.deps.ledger.getDirective(requestId)!;
    // Reservation precedes the first await, including pace admission/spawn.
    const release = this.deps.ledger.beginJobAdmission(row.jobId, `directive recovery ${requestId}`);
    const run = this.recover(requestId).catch((error: unknown) => {
      if (!this.deps.signal.aborted) surfaceDirectiveRecovery(this.deps, requestId, String(error));
    }).finally(() => { release(); this.active.delete(requestId); });
    this.active.set(requestId, run);
  }

  private async recover(requestId: string): Promise<void> {
    const deps = this.deps;
    const identity = deps.ledger.directiveTurnIdentity(requestId);
    let row = deps.ledger.getDirective(requestId)!;
    // A successor accepted atomically by Gru is fresh authority. A consumed
    // predecessor's uncertain original work is never replayed.
    if (row.nativeTarget === null) {
      if (deps.ledger.hasDirectiveDispatchDeferral(row.requestId) || row.dispatchStartedAt === null && deps.ledger.isRecoverySuccessor(row.requestId)) {
        await executeAcceptedDirective(deps, requestId);
        return;
      }
      throw new DirectiveCheckpointError('accepted request has no exact native association; inspect before choosing fresh authority');
    }
    if (settleNativeDirective(deps, identity)) return;
    check(deps, identity);
    row = deps.ledger.getDirective(requestId)!;
    if (row.recoveryCheckpoint !== null) throw new DirectiveCheckpointError('original checkpoint claim was already consumed; never prepare or replay it');
    const proof = inspectDirectiveCheckpoint(row.nativeTarget!.sessionFile, identity);
    if (proof.state !== 'resumable') throw new DirectiveCheckpointError(proof.state === 'unknown' ? proof.reason : proof.error ?? 'native error/abort is incomplete');
    const lanes = deps.worktrees.listWorktrees({ jobId: row.jobId }).filter((lane) => lane.kind === 'job' && lane.status !== 'swept');
    if (lanes.length !== 1) throw new DirectiveCheckpointError('recovery requires the original single live job lane');
    const lane = lanes[0]!;
    let producerStartSeq: number | undefined;
    let producer: DirectiveProducer | undefined;
    let handle: AgentHandle | null = null;
    const assertOriginalBranch = (): void => {
      const current = deps.worktrees.listWorktrees({ jobId: row.jobId }).filter((item) => item.kind === 'job' && item.status !== 'swept');
      const header = readDirectiveSessionHeader(proof.binding.sessionFile);
      if (current.length !== 1 || current[0]!.id !== lane.id || current[0]!.path !== lane.path ||
          current[0]!.branch !== lane.branch || header.cwd !== lane.path || lane.branch === null) {
        throw new DirectiveCheckpointError('original registered branch/lane/cwd is unavailable or changed; native continuation is forbidden');
      }
      let branch: string;
      try { branch = execFileSync('git', ['-C', lane.path, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim(); }
      catch (error) { throw new DirectiveCheckpointError(`original registered branch cannot be proven; native continuation is forbidden: ${String(error)}`); }
      if (branch !== lane.branch) throw new DirectiveCheckpointError('original registered branch differs from the checkout; native continuation is forbidden');
    };
    const assertProducerFences = (): void => {
      check(deps, identity);
      assertOriginalBranch(); // before/after awaits, checkpoint claim, and every actual SDK tool boundary
      const ownNativeProducer = handle?.id === producer?.agentId && handle?.sessionFile === producer?.sessionFile ? producer : undefined;
      const durable = deps.ledger.directiveProgressBlockers(requestId, lane.id, handle?.health().state === 'idle' ? handle.id : undefined, producerStartSeq, ownNativeProducer)
        .filter((blocker) => !blocker.startsWith('in-flight admission(s):'));
      const own = `directive recovery ${requestId}`;
      const admissions = deps.ledger.listJobAdmissions(row.jobId).filter((kind) => kind !== own);
      const supervised = [...deps.pendingProducerBlockers(row.jobId, handle !== null && ownNativeProducer !== undefined ? { handle, producer: ownNativeProducer } : undefined), ...cleanupOwnershipBlockers(deps.ledger, row.jobId)];
      if (durable.length > 0 || admissions.length > 0 || supervised.length > 0) throw new DirectiveCheckpointError(`producer ownership remains: ${[...durable, ...admissions, ...supervised].join('; ')}`);
    };
    assertProducerFences();
    let lease: PacingLease | null = null;
    let cleanup: Promise<void> | null = null;
    const failures: unknown[] = [];
    const disposeOwned = (): Promise<void> => {
      if (handle === null) return Promise.resolve();
      const target = handle;
      cleanup ??= Promise.resolve().then(async () => {
        try { await deps.registry.disposeHandle(target); } catch (error) { failures.push(error); }
        // Record ownership even when disposal fails; neither Promise
        // fulfillment nor a cleanup error establishes actual cessation.
        try { recordCleanup(deps, identity, target, producerStartSeq); } catch (error) { failures.push(error); }
      });
      return cleanup;
    };
    const abort = (): void => { void disposeOwned(); };
    let completed = false;
    try {
      if (deps.workerGate !== undefined) lease = await deps.workerGate.acquireWorkerTurn({ id: row.jobId, jobId: row.jobId, label: `checkpoint recovery → ${requestId}`, signal: deps.signal });
      assertProducerFences();
      const head = resolveGitCommit(lane.path, 'HEAD');
      const tools = deps.parentTools?.(proof.binding.agentId) ?? [];
      const predecessor = inspectDirectiveProducers(proof.binding.sessionFile, identity).at(-1);
      handle = await deps.registry.spawn('minion', { resumeFile: proof.binding.sessionFile, agentId: proof.binding.agentId,
        ...(predecessor === undefined ? {} : { directiveRecoveryProducer: predecessor.producer }),
        cwd: lane.path, signal: deps.signal, ...(tools.length === 0 ? {} : { nativeTools: tools }) });
      deps.signal.addEventListener('abort', abort, { once: true });
      check(deps, identity);
      assertOriginalBranch(); // refuse before preparing or claiming a new continuation producer
      if (handle.id !== proof.binding.agentId || handle.sessionFile !== proof.binding.sessionFile) throw new DirectiveCheckpointError('runtime changed the original native/logical session');
      if (handle.prepareDirectiveProducer === undefined) throw new DirectiveCheckpointError('runtime cannot attest physical checkpoint ownership');
      producer = handle.prepareDirectiveProducer(identity);
      producerStartSeq = deps.ledger.startDirectiveProducer(identity, producer);
      if (handle.id !== proof.binding.agentId || handle.sessionFile !== proof.binding.sessionFile || handle.resumeDirective === undefined) throw new DirectiveCheckpointError('runtime did not preserve exact native/logical session continuation capability');
      if (resolveGitCommit(lane.path, 'HEAD') !== head) throw new DirectiveCheckpointError('lane changed during checkpoint spawn');
      const continuedSession = handle.sessionFile;
      const continuation = handle.resumeDirective(identity, proof.checkpointId, assertProducerFences, () => {
        assertProducerFences();
        deps.ledger.claimDirectiveCheckpoint(identity, proof.checkpointId);
      });
      // Observe the actual native continuation on success OR refusal, never
      // create a second prompt or infer delivery from the observation.
      const observation = continuation.then(
        () => deps.observeBlindTurn?.(row.jobId, continuedSession),
        () => deps.observeBlindTurn?.(row.jobId, continuedSession),
      ).then(() => undefined, () => undefined);
      const verdict = await continuation;
      await observation;
      assertProducerFences();
      if (!verdict.ok) throw new DirectiveCheckpointError(verdict.error ?? 'native continuation failed');
      completed = true;
    } catch (error) { failures.push(error); } finally {
      try { deps.signal.removeEventListener('abort', abort); } catch (error) { failures.push(error); }
      try { lease?.release(); } catch (error) { failures.push(error); }
      try { await disposeOwned(); } catch (error) { failures.push(error); }
    }
    if (handle !== null) {
      try {
        if (handle.cessationEvidence?.() !== 'ceased') throw new DirectiveCheckpointError(`cleanup retains explicit producer ownership for minion ${handle.id}`);
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `checkpoint continuation/cleanup failed: ${failures.map(String).join('; ')}`);
    if (completed && !settleNativeDirective(deps, identity)) throw new DirectiveCheckpointError('native continuation lacks correlated completion');
  }

  async settled(): Promise<void> { await Promise.resolve(); await Promise.all(this.active.values()); }
  async dispose(): Promise<void> { this.disposed = true; this.stop.abort(); await this.settled(); }
}

/** Progress owns asynchronous cleanup against the shared registry/storage.
 * Join it first; a failed stage must not skip the other teardown. */
export async function disposeDirectiveResources(progress: Pick<DirectiveProgressService, 'dispose'> | undefined, registry: { dispose(): Promise<void> } | undefined): Promise<void> {
  const failures: unknown[] = [];
  try { await progress?.dispose(); } catch (error) { failures.push(error); }
  try { await registry?.dispose(); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, `directive progress/registry shutdown failed: ${failures.map(String).join('; ')}`);
}
