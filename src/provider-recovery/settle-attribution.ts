import type { LedgerApi } from '../ledger/api.js';

/**
 * Attribution for a `blocked` job status: is it the settle of THIS
 * provider wait's own failing turn, rather than a pre-existing/generic
 * block (owner/ops hold, another failure class)?
 *
 * The dispatch service settles a failed briefing turn in a fixed order:
 * it appends `job.minion-error` (carrying the failing minion's agent id)
 * and only then writes `job.status {to: 'blocked'}`. So a block that
 * directly follows this wait's own minion error — with no other status
 * transition in between — is the provider wall's own settlement, the
 * "expected interrupted-turn churn" the wait must survive. Any other
 * shape (no minion error, a different agent's error, an older block, or
 * a newer status hop) is NOT attributable and stays owner-controlled.
 *
 * This reads structured event fields ONLY — never job.minion-error prose,
 * backlog membership, or `working` as permission.
 */
export function blockedByOwnWallSettle(
  ledger: Pick<LedgerApi, 'getJob' | 'listJobEvents'>,
  input: { readonly jobId: string | null; readonly agentId: string | null },
): boolean {
  if (input.jobId === null || input.agentId === null) return false;
  const job = ledger.getJob(input.jobId);
  if (job === null || job.status !== 'blocked') return false;
  // Newest first; a bounded window without both events fails closed.
  const events = ledger.listJobEvents(input.jobId);
  const block = events.find(
    (event) => event.kind === 'job.status' && payloadTo(event.payload) === 'blocked',
  );
  const failure = events.find((event) => event.kind === 'job.minion-error');
  if (block === undefined || failure === undefined) return false;
  if (failure.seq >= block.seq) return false;
  if (payloadAgentId(failure.payload) !== input.agentId) return false;
  // The block must directly follow the failing turn: no other status
  // transition between the minion error and the blocked write.
  return !events.some(
    (event) =>
      event.kind === 'job.status' && event.seq > failure.seq && event.seq < block.seq,
  );
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

function payloadTo(payload: unknown): unknown {
  return payloadObject(payload)?.['to'];
}

function payloadAgentId(payload: unknown): unknown {
  return payloadObject(payload)?.['agentId'];
}
