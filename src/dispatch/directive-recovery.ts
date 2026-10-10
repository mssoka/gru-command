/**
 * Guarded interrupted-directive recovery — route orchestration.
 *
 * The retirement decision itself is a ledger transaction (see
 * `LedgerApi.retireInterruptedDirective`). This module supplies ONLY the
 * evidence the ledger cannot read: the job's live lane (registry) and its
 * freshly resolved head, plus the in-process pace-queue check that is not
 * durable ledger state.
 *
 * The caller's expectations are binding inputs, never evidence: a wrong
 * job/state/payload hash is refused by the ledger, and a head that does not
 * match the fresh `git rev-parse` is refused as stale before any write.
 * Every failure is a typed `DirectiveRetirementError` (or `RecordNotFound`)
 * and leaves the row, events and holds untouched. The whole path from
 * evidence read to transaction commit is synchronous, so no producer can
 * interleave between the check and the state flip in this single-process
 * service.
 */

import { RecordNotFound, type LedgerApi } from '../ledger/api.js';
import {
  DirectiveRetirementError,
  type DirectiveRequestRecord,
  type LiveDirectiveState,
} from '../ledger/directives.js';
import type { PacingGate } from '../runtime/pacing.js';
import { resolveGitCommit } from './perkins-review/artifacts.js';
import type { WorktreeLane, WorktreePort } from './worktree-port.js';

export interface DirectiveRetirementRequest {
  readonly ledger: Pick<LedgerApi, 'getDirective' | 'retireInterruptedDirective' | 'listAgents'>;
  readonly worktrees: Pick<WorktreePort, 'listWorktrees'>;
  /** Pace-gate view (when hosted): a worker turn already queued for this
   * job is live producer evidence. */
  readonly workerGate?: Pick<PacingGate, 'view'>;
  /** Fresh supervisor ownership, including scheduled backoff/retry turns. */
  readonly pendingProducerBlockers: (jobId: string) => readonly string[];
  readonly requestId: string;
  readonly expected: {
    readonly jobId: string;
    readonly state: LiveDirectiveState;
    readonly payloadHash: string;
    readonly head: string;
  };
  readonly reason: string;
  readonly by: string;
}

export interface DirectiveRetirementOutcome {
  readonly record: DirectiveRequestRecord;
  readonly idempotent: boolean;
  readonly phaseClosed: string | null;
}

const RETIRABLE_STATES: readonly LiveDirectiveState[] = ['dispatching', 'admitted'];

/** Resolve the single non-swept job lane, or refuse with the exact reason.
 * Zero lanes (never created / swept) and ambiguous multi-lane registry
 * states both fail closed: without a lane there is no head to bind, and a
 * retirement must never be executed against a guessed checkout. */
export function resolveRetirementLane(
  worktrees: Pick<WorktreePort, 'listWorktrees'>,
  jobId: string,
): WorktreeLane {
  let jobLanes: readonly WorktreeLane[];
  try {
    jobLanes = worktrees.listWorktrees({ jobId }).filter((lane) => lane.kind === 'job');
  } catch (error) {
    throw new DirectiveRetirementError('lane_unavailable',
      `job "${jobId}" lane registry is unreadable (${String(error).slice(0, 200)}) — cannot bind cessation evidence`);
  }
  const candidates = jobLanes.filter((lane) => lane.status !== 'swept');
  if (candidates.length !== 1) {
    throw new DirectiveRetirementError(
      'lane_unavailable',
      candidates.length === 0
        ? `job "${jobId}" has no live lane worktree — a retirement must bind the current lane head`
        : `job "${jobId}" has ${candidates.length} live lane worktrees (${candidates.map((lane) => lane.id).join(', ')}) — refusing an ambiguous bind`,
    );
  }
  return candidates[0] as WorktreeLane;
}

/** The one public entry point used by the retirement route. */
export function retireInterruptedDirectiveFromRoute(input: DirectiveRetirementRequest): DirectiveRetirementOutcome {
  const row = input.ledger.getDirective(input.requestId);
  if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);

  const callLedger = (lane?: { readonly id: string; readonly resolvedHead: string }): DirectiveRetirementOutcome =>
    input.ledger.retireInterruptedDirective({
      requestId: input.requestId,
      expectedJobId: input.expected.jobId,
      expectedState: input.expected.state,
      expectedPayloadHash: input.expected.payloadHash,
      expectedHead: input.expected.head,
      ...(lane !== undefined ? { lane } : {}),
      reason: input.reason,
      by: input.by,
    });

  // Consumed (retired) and terminal rows are decided entirely by durable
  // state: a replay compares the canonical intent fingerprint, a
  // settled/failed row refuses. No fresh lane evidence exists to require.
  if (!RETIRABLE_STATES.includes(row.state as LiveDirectiveState)) return callLedger();

  const lane = resolveRetirementLane(input.worktrees, row.jobId);
  let producerBlockers: readonly string[];
  try {
    producerBlockers = input.pendingProducerBlockers(row.jobId);
  } catch (error) {
    throw new DirectiveRetirementError('live_work',
      `job "${row.jobId}" supervisor ownership is unreadable (${String(error).slice(0, 200)}) — cannot prove cessation`,
      ['supervisor ownership unavailable']);
  }
  if (producerBlockers.length > 0) {
    throw new DirectiveRetirementError('live_work', `job "${row.jobId}" has pending supervised producer ownership`, producerBlockers);
  }
  if (input.workerGate !== undefined) {
    const agentIds = new Set(input.ledger.listAgents().filter((agent) => agent.jobId === row.jobId).map((agent) => agent.id));
    const queued = input.workerGate.view().worker.queued.find((entry) => entry.id === row.jobId || agentIds.has(entry.id));
    if (queued !== undefined) {
      throw new DirectiveRetirementError(
        'live_work',
        `job "${row.jobId}" has a queued worker turn waiting for a pace slot — retirement would race it`,
        [`queued worker turn: ${queued.label}`],
      );
    }
  }
  let resolvedHead: string;
  try {
    // Bind the checkout that actually holds the work. A detached or
    // switched lane can leave its registered branch tip unchanged.
    resolvedHead = resolveGitCommit(lane.path, 'HEAD');
  } catch (error) {
    throw new DirectiveRetirementError(
      'lane_unavailable',
      `job "${row.jobId}" lane head is unresolvable (${String(error).slice(0, 200)}) — cannot bind the cessation evidence`,
    );
  }
  return callLedger({ id: lane.id, resolvedHead });
}

/** Concrete Gru judgment. The same cessation predicates as retirement
 * precede its atomic transaction; caller expectations never become proof. */
export function recoverInterruptedDirectiveFromRoute(input: {
  readonly ledger: LedgerApi;
  readonly worktrees: Pick<WorktreePort, 'listWorktrees'>;
  readonly pendingProducerBlockers: (jobId: string) => readonly string[];
  readonly workerGate?: Pick<PacingGate, 'view'>;
  readonly requestId: string;
  readonly generation: number;
  readonly expectedPayloadHash: string;
  readonly expectedHead: string;
  readonly expectedEpoch: number;
  readonly expectedWorkRevision?: number;
  readonly expectedContractSha256?: string;
  readonly reason: string;
  readonly decision: { readonly kind: 'successor'; readonly requestId: string; readonly directive: string } |
    { readonly kind: 'owner-decision'; readonly obligationId: string };
}): ReturnType<LedgerApi['consumeDirectiveRecoveryDecision']> {
  const row = input.ledger.getDirective(input.requestId);
  if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
  // A consumed replay is ledger-only: history stands even if HEAD moved.
  if (input.ledger.recoveryDecisionHistory('directive', row.requestId).some((decision) => decision.generation === input.generation)) return input.ledger.consumeDirectiveRecoveryDecision({ ...input,
    lane: { id: '', resolvedHead: input.expectedHead } });
  const lane = resolveRetirementLane(input.worktrees, row.jobId);
  if (input.decision.kind === 'successor') {
    const supervised = input.pendingProducerBlockers(row.jobId);
    const durable = input.ledger.directiveProgressBlockers(row.requestId, lane.id);
    const ids = new Set(input.ledger.listAgents().filter((agent) => agent.jobId === row.jobId).map((agent) => agent.id));
    const queued = input.workerGate?.view().worker.queued.filter((entry) => entry.id === row.jobId || ids.has(entry.id)) ?? [];
    if (supervised.length + durable.length + queued.length > 0) throw new DirectiveRetirementError('live_work',
      'recovery successor refused: actual producer cessation is not proven', [...supervised, ...durable, ...queued.map((entry) => entry.label)]);
  }
  return input.ledger.consumeDirectiveRecoveryDecision({ requestId: input.requestId, generation: input.generation,
    expectedPayloadHash: input.expectedPayloadHash, expectedHead: input.expectedHead, expectedEpoch: input.expectedEpoch,
    reason: input.reason, decision: input.decision, expectedWorkRevision: input.expectedWorkRevision, expectedContractSha256: input.expectedContractSha256, lane: { id: lane.id, resolvedHead: resolveGitCommit(lane.path, 'HEAD') } });
}


export function recoverInterruptedRebriefFromRoute(input: Omit<Parameters<typeof recoverInterruptedDirectiveFromRoute>[0], 'requestId' | 'decision'> & {
  readonly markerId: string; readonly expectedReceiptEvidenceSha256: string;
  readonly decision: Parameters<LedgerApi['consumeRebriefRecoveryDecision']>[0]['decision'];
}): ReturnType<LedgerApi['consumeRebriefRecoveryDecision']> {
  const call = (lane: { readonly id: string; readonly resolvedHead: string }) => input.ledger.consumeRebriefRecoveryDecision({
    markerId: input.markerId, generation: input.generation, expectedPayloadHash: input.expectedPayloadHash,
    expectedHead: input.expectedHead, expectedEpoch: input.expectedEpoch, expectedWorkRevision: input.expectedWorkRevision, expectedContractSha256: input.expectedContractSha256,
    expectedReceiptEvidenceSha256: input.expectedReceiptEvidenceSha256, reason: input.reason, decision: input.decision, lane });
  if (input.ledger.getRebriefRecoveryDecision(input.markerId, input.generation) !== null) return call({ id: '', resolvedHead: input.expectedHead });
  const marker = input.ledger.listPendingRebriefs().find((row) => row.id === input.markerId);
  if (marker === undefined) throw new RecordNotFound(`rebrief marker "${input.markerId}" not found`);
  const lane = resolveRetirementLane(input.worktrees, marker.jobId);
  if (input.decision.kind === 'successor') {
    const supervised = input.pendingProducerBlockers(marker.jobId);
    const ids = new Set(input.ledger.listAgents().filter((agent) => agent.jobId === marker.jobId).map((agent) => agent.id));
    const queued = input.workerGate?.view().worker.queued.filter((entry) => entry.id === marker.jobId || ids.has(entry.id)) ?? [];
    if (supervised.length + queued.length > 0) throw new DirectiveRetirementError('live_work', 'legacy rebrief successor requires proven producer cessation', [...supervised, ...queued.map((entry) => entry.label)]);
  }
  return call({ id: lane.id, resolvedHead: resolveGitCommit(lane.path, 'HEAD') });
}
