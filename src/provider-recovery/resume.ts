import { existsSync } from 'node:fs';
import type {
  LedgerApi,
  ProviderWaitRecord,
} from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import { rebriefFreshMinion } from '../dispatch/fix-directive.js';
import type { DirectiveRegistry } from '../dispatch/fix-directive.js';
import type { WorktreePort } from '../dispatch/worktree-port.js';
import { blockedByOwnWallSettle } from './settle-attribution.js';
import { isJobTerminal } from '../ledger/states.js';
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

/** A continuation failure leaves the lane honestly non-working: when this
 * claim re-opened (or kept) the lane `working`, block it with a note so the
 * board and the digest never show an active lane nobody is driving (#160).
 * Owner holds, review windows, and terminal states stay exactly as they
 * are — the error events already carry the failure either way. */
function blockReopenedLane(
  ledger: Pick<LedgerApi, 'getJob' | 'setJobStatus' | 'noteJob'>,
  jobId: string | null,
  note: string,
): void {
  if (jobId === null) return;
  const job = ledger.getJob(jobId);
  if (job === null || job.status !== 'working') return;
  ledger.setJobStatus(jobId, 'blocked');
  ledger.noteJob(jobId, note.slice(0, 300));
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
    // re-armed it, or another claimant already settled this wait): settle
    // only when this wait is not ALREADY terminal — otherwise the loser of
    // a concurrent claim must not throw, it just reports the settled state.
    const current = deps.ledger.getProviderWait(wait.id);
    if (current !== null && (current.status === 'claimed' || current.status === 'superseded' || current.status === 'cancelled')) {
      return { outcome: 'skipped', waitId: wait.id, why: 'slot no longer provider-stopped (wait already settled)' };
    }
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
  // `parked` is always an explicit owner hold. A `blocked` status cancels
  // UNLESS the ledger attributes the block to this wait's own failing turn
  // (the dispatch settle raced the wait — r4 directive): that block IS this
  // provider blocker's settlement and must not strand the recovery.
  const job = wait.jobId !== null ? deps.ledger.getJob(wait.jobId) : null;
  if (job === null || isJobTerminal(job.status)) {
    // Truthful reason per terminal state: a discarded (`binned`) lane is
    // cancelled, never reported as completed.
    const why = job === null ? 'job missing' : `job is ${job.status} — no continuation`;
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why, by });
    return { outcome: 'skipped', waitId: wait.id, why };
  }
  if (job.status === 'parked') {
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: 'job parked (owner/ops hold)', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'job parked (owner/ops hold)' };
  }
  if (
    job.status === 'blocked' &&
    !blockedByOwnWallSettle(deps.ledger, { jobId: wait.jobId, agentId: wait.agentId })
  ) {
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: 'job blocked (owner/ops hold)', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'job blocked (owner/ops hold)' };
  }
  // Guard 2 — this waiter is a member of a still-open recovery BATCH
  // (r1 #7: shared recoveries bind every matching waiter; membership is by
  // the batch id stamped on the wait, not per-generation marker equality).
  const pending =
    wait.recoveryBatchId !== null
      ? deps.ledger.getPendingProviderRecoveryById(wait.recoveryBatchId)
      : deps.ledger.getPendingProviderRecovery(wait.routeKey, wait.incidentGeneration);
  if (pending === null) {
    deps.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: 'recovery evidence no longer current', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'recovery evidence no longer current' };
  }
  // Guard 3 — the stopped actor ceased; no live replacement owns the lane.
  if (wait.agentId !== null && deps.registry.getHandle(wait.agentId) !== null) {
    deps.ledger.setProviderWaitStatus(wait.id, 'superseded', { why: 'original actor is live again', by });
    return { outcome: 'skipped', waitId: wait.id, why: 'original actor is live again' };
  }
  // A replacement must be a live IMPLEMENTER (Gru ruling 2026-09-29 +
  // #161 union): a newer review-only session or tracked child is not the
  // lane's writer — listImplementerMinions applies the exclusions. A
  // waiter without a job id has no replacement semantics at all.
  const replacement = wait.jobId !== null
    ? deps.ledger
        .listImplementerMinions(wait.jobId)
        .find(
          (agent) =>
            agent.id !== wait.agentId &&
            agent.createdAt >= wait.createdAt &&
            deps.registry.getHandle(agent.id) !== null,
        )
    : undefined;
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
  // r1 #10 (phase3 item 5): ATOMIC claim-BEFORE-spawn. Compare-and-set
  // recovered-pending → claimed; concurrent claimants and replays lose
  // here, before any prompt or spawn side effect can duplicate.
  const claimed = deps.ledger.claimProviderWaitAtomic(wait.id, {
    by,
    path: resumeFile !== null ? 'resumed' : 'redispatched',
  });
  if (!claimed) {
    return { outcome: 'skipped', waitId: wait.id, why: 'recovery already claimed (concurrent claimant or replay)' };
  }
  deps.ledger.appendCustomEvent({
    kind: 'provider.recovery-claimed',
    jobId: wait.jobId,
    agentId: wait.agentId,
    payload: { wait_id: wait.id, waiter: 'job-minion', by, path: resumeFile !== null ? 'resumed' : 'redispatched' },
  });
  if (job.status === 'blocked') {
    // Wall-attributed block (Guard 1): the continuation re-opens the lane,
    // mirroring the Silas follow-through re-open for delivered/in-review
    // lanes. Without it the resumed lane would stay blocked and could
    // never settle a later delivery.
    deps.ledger.setJobStatus(job.id, 'working');
    deps.ledger.noteJob(job.id, 'provider recovery: lane re-opened after a wall-settled block');
  }
  // This reservation fences binning during asynchronous spawn/turn work;
  // the durable claimed wait itself remains historical after settlement.
  const releaseContinuation = deps.ledger.beginProviderContinuation(wait.id, job.id);
  const admitted = { recorded: false };
  let result: Awaited<ReturnType<typeof rebriefFreshMinion>>;
  try {
    result = await rebriefFreshMinion({
      registry: deps.registry,
      ledger: deps.ledger,
      worktrees: deps.worktrees,
      jobId: wait.jobId as string,
      note,
      briefing: continuationPrompt ?? job.briefing,
      ...(resumeFile !== null ? { resumeFile } : {}),
      beforeTurnSideEffect: () => {
        // A hold or terminal disposition may land during the awaited
        // worker gate/spawn. Never prompt the replacement against it;
        // rebriefFreshMinion disposes a spawned handle on refusal.
        const current = deps.ledger.getJob(job.id);
        if (current === null || isJobTerminal(current.status) || current.status === 'parked' || current.status === 'blocked') {
          throw new Error(`provider continuation refused — job "${job.id}" is ${current?.status ?? 'missing'}`);
        }
      },
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
  } catch (error) {
    // The claim won but the spawn/continuation failed DETERMINISTICALLY.
    // Never blind-retry (crash/ambiguous delivery must be reconciled, not
    // replayed): keep the claim as the durable record and surface it.
    const detail = String(error).slice(0, 300);
    deps.ledger.appendCustomEvent({
      kind: 'provider.continuation-failed',
      jobId: wait.jobId,
      agentId: wait.agentId,
      payload: { wait_id: wait.id, by, stage: 'spawn', error: detail },
    });
    // The same durable non-success visibility as every other failed minion
    // turn (#160): a lane whose continuation failed is not working — it
    // blocks with the error on the record for Silas follow-through.
    deps.ledger.appendCustomEvent({
      kind: 'job.minion-error',
      jobId: wait.jobId,
      payload: { agentId: wait.agentId, error: detail },
    });
    blockReopenedLane(deps.ledger, wait.jobId, `provider recovery continuation failed: ${detail}`);
    deps.log?.('error', 'provider recovery continuation failed after atomic claim — stranded claim recorded, no replay', {
      wait_id: wait.id,
      job: wait.jobId,
      error: String(error),
    });
    return { outcome: 'skipped', waitId: wait.id, why: 'continuation spawn failed after atomic claim (recorded; no automatic replay)' };
  } finally {
    releaseContinuation();
  }
  // Guarded continuation turn truth (#160): a prompt that settles with an
  // in-band runtime error was admitted but is NOT a continuation. The atomic
  // claim stays the durable record (never replayed automatically); the
  // failure is surfaced where the digest and settle attribution see it.
  // A delivery must never be minted from a settled-but-failed turn.
  if (result.outcome === 'error') {
    const detail = result.error ?? 'runtime settled the continuation turn with an in-band error';
    deps.ledger.appendCustomEvent({
      kind: 'provider.continuation-failed',
      jobId: wait.jobId,
      agentId: result.minionId,
      payload: { wait_id: wait.id, by, stage: 'turn', error: detail.slice(0, 300) },
    });
    deps.ledger.appendCustomEvent({
      kind: 'job.minion-error',
      jobId: wait.jobId,
      payload: { agentId: result.minionId, error: detail },
    });
    blockReopenedLane(deps.ledger, wait.jobId, `provider recovery continuation failed in-band: ${detail.slice(0, 200)}`);
    deps.log?.('error', 'provider recovery continuation settled with an in-band error — claim kept, no delivery', {
      wait_id: wait.id,
      job: wait.jobId,
      minion: result.minionId,
      error: detail,
    });
    return {
      outcome: 'skipped',
      waitId: wait.id,
      why: 'continuation turn settled with an in-band error (recorded; no automatic replay)',
    };
  }
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
