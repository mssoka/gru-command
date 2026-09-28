import { existsSync } from 'node:fs';
import type {
  LedgerApi,
  ProviderWaitRecord,
} from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import { rebriefFreshMinion } from '../dispatch/fix-directive.js';
import type { DirectiveRegistry } from '../dispatch/fix-directive.js';
import type { WorktreePort } from '../dispatch/worktree-port.js';
import type { SlotReArmPort } from './sensor.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The GUARDED eligible-state transition (briefing acceptance 7): how a
 * recovered wait becomes one actual continuation. This is deliberately NOT
 * notification-ACK automation and NOT a bare respawn — every claim
 * rechecks approval, the current incident, step scope, other blockers,
 * existing actor/tool cessation, and routes the continuation through the
 * normal dispatch surface (resume + re-deliver on the same lane).
 *
 * Silas invokes this through the ops surface (`POST
 * /api/silas/provider-recovery/claim`); boot reconciliation and the digest
 * keep the lane visible until it is claimed. One wait claims ONE
 * continuation; fan-out happens only after actual model progress, through
 * the same normal dispatch surfaces (the resident budget stays owned by
 * the cap lane — no second capacity counter here).
 */

export interface RecoveryClaimDeps {
  readonly registry: DirectiveRegistry;
  readonly ledger: LedgerApi;
  readonly worktrees: WorktreePort;
  readonly slotReArm?: SlotReArmPort;
  readonly log?: Log;
}

export type RecoveryClaimResult =
  | { readonly outcome: 'continued'; readonly waitId: string; readonly minionId: string; readonly path: 'resumed' | 'redispatched' }
  | { readonly outcome: 'rearmed'; readonly waitId: string; readonly agentId: string }
  | { readonly outcome: 'skipped'; readonly waitId: string; readonly why: string }
  | { readonly outcome: 'not-found'; readonly waitId: string }
  | { readonly outcome: 'not-recovered'; readonly waitId: string; readonly status: string };

/**
 * Claim one recovered wait and start its continuation. Every guard throws
 * nothing — a skipped claim is a recorded, visible outcome.
 */
export async function claimProviderRecoveryContinuation(
  deps: RecoveryClaimDeps,
  waitId: string,
  by: string,
): Promise<RecoveryClaimResult> {
  const wait = deps.ledger.getProviderWait(waitId);
  if (wait === null) return { outcome: 'not-found', waitId };
  if (wait.status !== 'recovered-pending') {
    return { outcome: 'not-recovered', waitId, status: wait.status };
  }
  if (wait.waiterKind === 'silas-slot') {
    return claimSilasSlot(deps, wait, by);
  }
  return claimJobMinion(deps, wait, by);
}

/** The Silas logical slot: guarded owned re-arm of the SAME slot only. */
function claimSilasSlot(
  deps: RecoveryClaimDeps,
  wait: ProviderWaitRecord,
  by: string,
): RecoveryClaimResult {
  if (deps.slotReArm === null || deps.slotReArm === undefined) {
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', {
      why: 'silas slot not hosted',
      by,
    });
    return { outcome: 'skipped', waitId: wait.id, why: 'silas slot not hosted' };
  }
  if (wait.agentId === null) {
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: 'no agent bound to the slot wait', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'no agent bound to the slot wait' };
  }
  const rearmed = deps.slotReArm.ownedProviderReArm(wait.agentId, wait.id);
  if (!rearmed) {
    // The slot is no longer in the recorded provider-stop state (owner
    // re-armed it, or it was replaced): retain nothing — the live slot
    // owns the lane now.
    deps.ledger.setProviderWaitStatus(wait.id, 'superseded', { why: 'slot no longer provider-stopped', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'slot no longer provider-stopped' };
  }
  deps.ledger.appendCustomEvent({
    kind: 'provider.recovery-claimed',
    agentId: wait.agentId,
    payload: { wait_id: wait.id, waiter: 'silas-slot', by, admission: 'rearmed' },
  });
  deps.ledger.setProviderWaitStatus(wait.id, 'claimed', { why: 'slot re-armed', by });
  return { outcome: 'rearmed', waitId: wait.id, agentId: wait.agentId };
}

/** A job-minion wait: resume the interrupted session on the same lane,
 * re-delivering the saved continuation reference (or a recovery directive
 * when the interrupted prompt could not be captured). */
async function claimJobMinion(
  deps: RecoveryClaimDeps,
  wait: ProviderWaitRecord,
  by: string,
): Promise<RecoveryClaimResult> {
  // Guard 1 — the job is still approved, unfinished, and un-blocked.
  const job = wait.jobId !== null ? deps.ledger.getJob(wait.jobId) : null;
  if (job === null || job.status === 'merged' || job.status === 'done') {
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: 'job completed or missing', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'job completed or missing' };
  }
  if (job.status === 'blocked' || job.status === 'parked') {
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: `job ${job.status} (owner/ops hold)`, by });
    return { outcome: 'skipped', waitId: wait.id, why: `job ${job.status} (owner/ops hold)` };
  }
  // Guard 2 — the incident is still current for this waiter.
  const pending = deps.ledger.getPendingProviderRecovery(wait.routeKey, wait.incidentGeneration);
  if (pending === null) {
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: 'recovery evidence no longer current', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'recovery evidence no longer current' };
  }
  // Guard 3 — the stopped actor ceased; no live replacement owns the lane.
  if (wait.agentId !== null && deps.registry.getHandle(wait.agentId) !== null) {
    deps.ledger.setProviderWaitStatus(wait.id, 'superseded', { why: 'original actor is live again', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'original actor is live again' };
  }
  const replacement = deps.ledger
    .listAgents()
    .find(
      (agent) =>
        agent.jobId === wait.jobId &&
        agent.role === 'minion' &&
        agent.id !== wait.agentId &&
        agent.createdAt >= wait.createdAt &&
        deps.registry.getHandle(agent.id) !== null,
    );
  if (replacement !== undefined) {
    deps.ledger.setProviderWaitStatus(wait.id, 'superseded', { why: 'a live replacement minion owns the lane', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'a live replacement minion owns the lane' };
  }
  // Guard 4 — the lane still exists (its worktree was not swept).
  const lane = deps.worktrees
    .listWorktrees({ jobId: wait.jobId ?? undefined })
    .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
  if (lane === undefined) {
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: 'job lane swept — nothing to resume into', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'job lane swept — nothing to resume into' };
  }

  // One continuation: resume the interrupted session when it still exists,
  // otherwise a fresh worker on the same lane (rebrief machinery).
  const resumeFile =
    wait.sessionFile !== null && wait.sessionFile !== '' && existsSync(wait.sessionFile)
      ? wait.sessionFile
      : null;
  const continuationPrompt = wait.continuation?.promptText ?? null;
  const note =
    continuationPrompt !== null && continuationPrompt.trim() !== ''
      ? `Provider ${wait.provider} recovered. The interrupted turn's prompt is re-delivered below.`
      : `Provider ${wait.provider} recovered. The interrupted turn's prompt could not be recovered — continue the briefing.`;
  deps.ledger.appendCustomEvent({
    kind: 'provider.recovery-claimed',
    jobId: wait.jobId,
    agentId: wait.agentId,
    payload: { wait_id: wait.id, waiter: 'job-minion', by, path: resumeFile !== null ? 'resumed' : 'redispatched' },
  });
  const admitted = { recorded: false };
  const result = await rebriefFreshMinion({
    registry: deps.registry,
    ledger: deps.ledger,
    worktrees: deps.worktrees,
    jobId: wait.jobId as string,
    note,
    briefing: continuationPrompt ?? job.briefing,
    ...(resumeFile !== null ? { resumeFile } : {}),
    onSpawned: (worker) => {
      // Record ACTUAL admission (the turn really starting) separately from
      // this claim/delivery — a delivered event alone is not proof.
      const handle = deps.registry.getHandle(worker.id);
      if (handle === null) return;
      handle.subscribe((event) => {
        if (event.type === 'turn_start' && !admitted.recorded) {
          admitted.recorded = true;
          deps.ledger.appendCustomEvent({
            kind: 'provider.continuation-admitted',
            jobId: wait.jobId,
            agentId: worker.id,
            payload: { wait_id: wait.id, by },
          });
        }
      });
    },
  });
  deps.ledger.setProviderWaitStatus(wait.id, 'claimed', {
    why: 'continuation started',
    by,
    minion: result.minionId,
  });
  deps.log?.('info', 'provider recovery continuation started', {
    wait_id: wait.id,
    job: wait.jobId,
    minion: result.minionId,
    path: resumeFile !== null ? 'resumed' : 'redispatched',
  });
  return {
    outcome: 'continued',
    waitId: wait.id,
    minionId: result.minionId,
    path: resumeFile !== null ? 'resumed' : 'redispatched',
  };
}
