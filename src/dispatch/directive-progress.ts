import type { LedgerApi } from '../ledger/api.js';
import { LIVE_DIRECTIVE_STATES, isDirectiveTerminal } from '../ledger/directives.js';
import { isJobTerminal } from '../ledger/states.js';
import { DirectiveCheckpointError, inspectDirectiveCheckpoint, readDirectiveBinding, type DirectiveTurnIdentity } from '../runtime/directive-checkpoint.js';
import type { AgentHandle, NativeAgentTool } from '../runtime/types.js';
import type { PacingGate, PacingLease, RetrySettlement } from '../runtime/pacing.js';
import { flipJobToWorking, recordFollowUpDelivery, renderRebriefPrompt, routeFixDirectiveToMinion, type DirectiveRegistry } from './fix-directive.js';
import { observePendingRebriefs, type RecoveryNotifications } from './rebrief-recovery.js';
import type { WorktreePort } from './worktree-port.js';
import type { LessonsReferencePort } from '../lessons/types.js';
import { resolveGitCommit } from './perkins-review/artifacts.js';
import { surfaceRecoveryOwnerTransfer } from './recovery-owner.js';

export interface DirectiveProgressDeps {
  readonly ledger: LedgerApi;
  readonly registry: DirectiveRegistry;
  readonly worktrees: WorktreePort;
  readonly notifications: RecoveryNotifications;
  readonly pendingProducerBlockers: (jobId: string) => readonly string[];
  readonly signal: AbortSignal;
  readonly workerGate?: PacingGate;
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  readonly parentTools?: (agentId: string) => readonly NativeAgentTool[];
  readonly lessons?: LessonsReferencePort;
}
function check(deps: DirectiveProgressDeps, identity: DirectiveTurnIdentity): void {
  if (deps.signal.aborted) throw new DirectiveCheckpointError('service stopping — directive recovery cancelled');
  deps.ledger.assertDirectiveAuthority(identity);
}
const unknownCleanup = new WeakMap<LedgerApi, Map<string, { readonly identity: DirectiveTurnIdentity; readonly handle: AgentHandle }>>();
function recordCleanup(deps: DirectiveProgressDeps, identity: DirectiveTurnIdentity, handle: AgentHandle): void {
  const key = `${identity.requestId}:${handle.id}`;
  let owned = unknownCleanup.get(deps.ledger);
  if (owned === undefined) { owned = new Map(); unknownCleanup.set(deps.ledger, owned); }
  let ceased = false;
  try { ceased = handle.cessationEvidence?.() === 'ceased'; } catch { /* UNKNOWN remains a durable fence. */ }
  if (ceased) {
    if (owned.delete(key)) deps.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: identity.jobId,
      payload: { request_id: identity.requestId, agent_id: handle.id } });
    return;
  }
  if (!owned.has(key)) deps.ledger.appendCustomEvent({ kind: 'silas.directive-producer-unknown', jobId: identity.jobId,
    payload: { request_id: identity.requestId, agent_id: handle.id } });
  owned.set(key, { identity, handle });
}

function checkAdmissionFences(deps: DirectiveProgressDeps, identity: DirectiveTurnIdentity, handle?: AgentHandle): void {
  check(deps, identity);
  const lane = deps.worktrees.listWorktrees({ jobId: identity.jobId }).find((lane) => lane.kind === 'job' && lane.status !== 'swept');
  const target = deps.ledger.getDirective(identity.requestId)?.nativeTarget;
  const ownSpawningAgentId = handle?.health().state === 'idle' && target?.agentId === handle.id && target.sessionFile === handle.sessionFile ? handle.id : undefined;
  const durable = deps.ledger.directiveProgressBlockers(identity.requestId, lane?.id ?? '', ownSpawningAgentId)
    .filter((blocker) => !blocker.startsWith('in-flight admission(s):'));
  const own = new Set([`directive ${identity.requestId}`, `directive recovery ${identity.requestId}`, `rebrief ${identity.requestId}`]);
  const reservations = deps.ledger.listJobAdmissions(identity.jobId).filter((kind) => !own.has(kind));
  const supervised = deps.pendingProducerBlockers(identity.jobId);
  if (durable.length + reservations.length + supervised.length > 0) throw new DirectiveCheckpointError(`directive producer fences: ${[...durable, ...reservations, ...supervised].join('; ')}`);
}

/** Shared HTTP/fresh-successor path. The adapter, not prompt fulfillment,
 * binds actual admission. The same native readback settles boot recovery. */
export async function executeAcceptedDirective(deps: DirectiveProgressDeps, requestId: string): Promise<void> {
  const identity = deps.ledger.directiveTurnIdentity(requestId);
  const row = deps.ledger.getDirective(requestId)!;
  check(deps, identity);
  if (!deps.ledger.claimDirectiveDispatch(requestId)) return;
  const release = deps.ledger.beginJobAdmission(row.jobId, `directive ${requestId}`);
  let preparedHandle: AgentHandle | undefined;
  try {
    const payload = JSON.parse(row.payload) as { directive: string };
    const directive = row.requestKind === 'rebrief' ? renderRebriefPrompt({ jobId: row.jobId, note: payload.directive, briefing: row.contractSnapshot, workRevision: identity.workRevision }) : payload.directive;
    const result = await routeFixDirectiveToMinion({ ...deps, jobId: row.jobId, directive, freshSession: row.requestKind === 'rebrief',
      contract: row.contractSnapshot, owner: `silas-directive:${requestId}`,
      ...(row.contractSnapshot === null || row.requestKind === 'rebrief' ? {} : { continuation: {
        block: `Approved contract revision ${identity.workRevision} at request acceptance:\n${row.contractSnapshot}`,
        freshNote: `Service-bound contract revision ${identity.workRevision}.`,
      } }),
      beforeTurnSideEffect: () => check(deps, identity),
      onCleanup: (handle) => recordCleanup(deps, identity, handle),
      onPrepared: (handle) => {
        preparedHandle = handle;
        check(deps, identity);
        if (handle.sessionFile === null || handle.inspectDirective === undefined) throw new DirectiveCheckpointError('runtime cannot durably attest directive admission');
        deps.ledger.prepareDirectiveTarget(requestId, { agentId: handle.id, sessionFile: handle.sessionFile });
      },
      directiveTurn: { identity, beforeAdmission: () => checkAdmissionFences(deps, identity, preparedHandle),
        onAdmitted: (binding) => { deps.ledger.bindDirectiveNativeAdmission(binding); } },
    });
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
    if (!deps.signal.aborted) {
      deps.ledger.recordDirectiveReconcile({ requestId, note: String(error) });
      surfaceDirectiveRecovery(deps, requestId, String(error));
    }
  } finally { release(); }
}

/** Completion first, correlated and idempotent: no worker execution. */
export function settleNativeDirective(deps: DirectiveProgressDeps, identity: DirectiveTurnIdentity): boolean {
  const row = deps.ledger.getDirective(identity.requestId);
  if (row === null || isDirectiveTerminal(row.state)) return row?.state === 'settled';
  const landed = deps.ledger.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId);
  if (landed !== null && row.state === 'admitted') {
    deps.ledger.recordDirectiveDelivery({ requestId: row.requestId, eventSeq: landed.seq });
    return true;
  }
  if (row.nativeTarget === null) return false;
  const proof = inspectDirectiveCheckpoint(row.nativeTarget.sessionFile, identity);
  const binding = readDirectiveBinding(row.nativeTarget.sessionFile, identity.requestId);
  if (binding?.userEntryId != null) deps.ledger.bindDirectiveNativeAdmission(binding);
  if (proof.state !== 'terminal' || !proof.ok) return false;
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
    } }, identity);
  }
  const delivery = recordFollowUpDelivery({ ledger: {
    appendCustomEvent: (fields) => deps.ledger.appendCustomEventIfCurrentDirective({ kind: fields.kind, jobId: identity.jobId, payload: fields.payload }, identity),
    getJob: (id) => deps.ledger.getJob(id), openReportObligation: (fields) => deps.ledger.openReportObligation(fields),
  }, worktrees: deps.worktrees, jobId: row.jobId,
    agentId: proof.binding.agentId, source: row.requestKind === 'rebrief' ? 'silas-rebrief' : 'silas-directive', requestId: row.requestId,
    ...(phase === null ? {} : { phaseId: phase.phaseId }), workRevision: identity.workRevision });
  deps.ledger.recordDirectiveDelivery({ requestId: row.requestId, eventSeq: delivery.eventSeq });
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
    for (const { identity, handle } of unknownCleanup.get(this.deps.ledger)?.values() ?? []) recordCleanup(this.deps, identity, handle);
    const scope = 'directive-native-progress';
    let cursor = this.deps.ledger.readReconcileCursor(scope) ?? 0;
    const rows = this.deps.ledger.listPendingDirectives({ states: LIVE_DIRECTIVE_STATES, rowidCursor: cursor, limit });
    for (const row of rows) {
      cursor = this.deps.ledger.directiveRowid(row.requestId) ?? cursor;
      if (this.active.has(row.requestId) || this.deps.ledger.listJobAdmissions(row.jobId).length > 0) continue;
      // New acceptance publishes before its HTTP owner can reserve. It is
      // not a restart gap; a truthful failure or the next boot exposes one.
      if (row.baselineSeq >= this.bootWatermark && row.dispatchStartedAt === null && row.failReason === null && !this.deps.ledger.isRecoverySuccessor(row.requestId)) continue;
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
      if (row.dispatchStartedAt === null && deps.ledger.isRecoverySuccessor(row.requestId)) {
        await executeAcceptedDirective(deps, requestId);
        return;
      }
      throw new DirectiveCheckpointError('accepted request has no exact native association; inspect before choosing fresh authority');
    }
    if (settleNativeDirective(deps, identity)) return;
    check(deps, identity);
    row = deps.ledger.getDirective(requestId)!;
    const proof = inspectDirectiveCheckpoint(row.nativeTarget!.sessionFile, identity);
    if (proof.state !== 'resumable') throw new DirectiveCheckpointError(proof.state === 'unknown' ? proof.reason : proof.error ?? 'native error/abort is incomplete');
    const lanes = deps.worktrees.listWorktrees({ jobId: row.jobId }).filter((lane) => lane.kind === 'job' && lane.status !== 'swept');
    if (lanes.length !== 1) throw new DirectiveCheckpointError('recovery requires the original single live job lane');
    const lane = lanes[0]!;
    const assertProducerFences = (): void => {
      check(deps, identity);
      const durable = deps.ledger.directiveProgressBlockers(requestId, lane.id)
        .filter((blocker) => !blocker.startsWith('in-flight admission(s):'));
      const own = `directive recovery ${requestId}`;
      const admissions = deps.ledger.listJobAdmissions(row.jobId).filter((kind) => kind !== own);
      const supervised = deps.pendingProducerBlockers(row.jobId);
      if (durable.length > 0 || admissions.length > 0 || supervised.length > 0) throw new DirectiveCheckpointError(`producer ownership remains: ${[...durable, ...admissions, ...supervised].join('; ')}`);
    };
    assertProducerFences();
    let lease: PacingLease | null = null;
    let handle: AgentHandle | null = null;
    let cleanup: Promise<void> | null = null;
    const failures: unknown[] = [];
    const disposeOwned = (): Promise<void> => {
      if (handle === null) return Promise.resolve();
      const target = handle;
      cleanup ??= Promise.resolve().then(async () => {
        try { await deps.registry.disposeHandle(target); } catch (error) { failures.push(error); }
        // Record ownership even when disposal fails; neither Promise
        // fulfillment nor a cleanup error establishes actual cessation.
        try { recordCleanup(deps, identity, target); } catch (error) { failures.push(error); }
      });
      return cleanup;
    };
    const abort = (): void => { void disposeOwned(); };
    let completed = false;
    try {
      if (deps.workerGate !== undefined) lease = await deps.workerGate.acquireWorkerTurn({ id: row.jobId, jobId: row.jobId, label: `checkpoint recovery → ${requestId}`, signal: deps.signal });
      assertProducerFences();
      deps.ledger.claimDirectiveCheckpoint(identity, proof.checkpointId);
      const head = resolveGitCommit(lane.path, 'HEAD');
      const tools = deps.parentTools?.(proof.binding.agentId) ?? [];
      handle = await deps.registry.spawn('minion', { resumeFile: proof.binding.sessionFile, agentId: proof.binding.agentId,
        cwd: lane.path, signal: deps.signal, ...(tools.length === 0 ? {} : { nativeTools: tools }) });
      deps.signal.addEventListener('abort', abort, { once: true });
      assertProducerFences();
      if (handle.id !== proof.binding.agentId || handle.sessionFile !== proof.binding.sessionFile || handle.resumeDirective === undefined) throw new DirectiveCheckpointError('runtime did not preserve exact native/logical session continuation capability');
      if (resolveGitCommit(lane.path, 'HEAD') !== head) throw new DirectiveCheckpointError('lane changed during checkpoint spawn');
      const verdict = await handle.resumeDirective(identity, proof.checkpointId, assertProducerFences);
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

  async settled(): Promise<void> { await Promise.all(this.active.values()); }
  async dispose(): Promise<void> { this.disposed = true; this.stop.abort(); await this.settled(); }
}
