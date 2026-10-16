import { randomUUID } from 'node:crypto';
import type { VectorConfig } from '../config.js';
import type { EventBus } from '../events/bus.js';
import type { LedgerApi } from '../ledger/api.js';
import { parseNotificationDecision, type NotificationDecision } from '../ledger/notification-decision.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { PackageResolution } from '../property/types.js';
import { buildRaidCandidates, type RaidCandidate, type RaidCandidateList } from './candidates.js';
import { breakInContract, fixHeistJobId, fixHeistTitle, renderFixBriefing } from './fix.js';
import { repositoryRollups, signalsPayload, VECTOR_EVENTS, VectorLedger, type BreakInRecord, type RaidRecord, type RaidRequester, type RaidTarget, type RepositoryRollup } from './ledger.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Vector's raids, planning half (#351 §1–2): code builds the candidate list,
 * Gru picks from it, and a pick either waits for the owner in FOR YOU
 * (`raid_mode = "proposed"`) or launches (`"autonomous"`, or a chat request,
 * which counts as the owner's Accept). A launched raid waits in Silas's raid
 * queue. Raids gate nothing: no heist path reads any of this.
 */

/** Gru's turn: an action-required row carrying the changed candidate list. */
export const RAID_CANDIDATES_KIND = 'vector.raid-candidates';
/** The owner's Accept/Decline on one raid Gru picked. */
export const RAID_PROPOSAL_KIND = 'vector.raid-proposal';
/** Board activity: a raid launched (autonomous or accepted). */
export const RAID_LAUNCHED_KIND = 'vector.raid-launched';
/** Board activity: a proposal withdrawn because its target changed. */
export const RAID_WITHDRAWN_KIND = 'vector.raid-proposal-withdrawn';
/** The owner's Accept/Decline on turning one break-in into a fix heist. */
export const FIX_PROPOSAL_KIND = 'vector.fix-proposal';
/** Board activity: a fix heist was dispatched for a break-in. */
export const FIX_DISPATCHED_KIND = 'vector.fix-dispatched';
/** Gru's attention: a fix heist could not be dispatched (retried at the next reconcile). */
export const FIX_DISPATCH_FAILED_KIND = 'vector.fix-dispatch-failed';

export const RAID_REASON_MAX_CHARS = 200;

/** How often undone follow-through (decisions, fix dispatches) is retried. */
export const RECONCILE_INTERVAL_MS = 300_000;

/** A refusal Gru (or the owner, through chat) can act on, by name. */
export class VectorRefusal extends Error {
  constructor(readonly code: 'vector_disabled' | 'invalid_pick' | 'not_a_candidate', message: string) {
    super(message);
    this.name = 'VectorRefusal';
  }
}

export interface RaidPickInput {
  readonly repo: string;
  readonly packageDir: string;
  readonly reason: string;
}

export interface PickRequest {
  readonly picks: readonly RaidPickInput[];
  /** The offered candidate list this answers, when it answers one. */
  readonly digest: string | null;
  readonly requestedBy: RaidRequester;
}

export interface PickResult {
  readonly raids: readonly RaidRecord[];
}

export interface VectorServiceOptions {
  readonly vector: VectorConfig;
  readonly workspaceRoot: string;
  readonly managedRepos: readonly string[];
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  readonly log?: Log;
  readonly now?: () => Date;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly setTimeout?: typeof setTimeout;
  /** Seam A capability resolution (default: the real resolver). */
  readonly resolvePackages?: (repoPath: string) => readonly PackageResolution[];
  /** The normal dispatch path a fix heist goes through (POST /api/dispatch's service). */
  readonly dispatchFix?: (input: { readonly jobId: string; readonly repoPath: string; readonly title: string; readonly briefing: string }) => Promise<unknown>;
}

const OWNER_PROVENANCE = { credential: 'internal', declaredActor: null } as const;

/** Control, format, separator, private-use, unassigned and lone-surrogate
 * code points: anything that can break, reorder or hide a rendered line
 * (the classes src/dispatch/line-safe.ts escapes). */
const LINE_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;

const targetName = (target: RaidTarget): string => {
  const name = target.packageDir === '.' ? target.repo : `${target.repo}/${target.packageDir}`;
  return name.length <= 160 ? name : `${name.slice(0, 159)}…`;
};

function oneLine(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new VectorRefusal('invalid_pick', `${what} must be a string`);
  const trimmed = value.trim();
  // Control, format, separator, private-use and unassigned characters are
  // refused: the value is shown on owner-facing cards.
  if (trimmed === '' || LINE_UNSAFE.test(trimmed)) throw new VectorRefusal('invalid_pick', `${what} must be one non-blank line of visible text`);
  if (trimmed.length > max) throw new VectorRefusal('invalid_pick', `${what} must be at most ${String(max)} characters`);
  return trimmed;
}

export class VectorService {
  private readonly store: VectorLedger;
  private readonly log: Log;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTick: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: VectorServiceOptions) {
    this.store = new VectorLedger(opts.ledger);
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.opts.vector.enabled;
  }

  /** Boot: reconcile proposals, follow owner decisions, start the plan cadence. */
  start(): void {
    if (!this.enabled) {
      this.log('info', 'vector raids disabled ([vector] enabled = false): no candidate list, no Gru turn, no Vector session', {});
      return;
    }
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.opts.bus.subscribe((event) => {
      if (event.kind !== 'notification.decision') return;
      const id = (event.payload as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') return;
      try { this.followDecision(id); } catch (error) {
        this.log('error', 'vector raid decision follow-through failed; the next reconcile retries it', { notification: id, error: String(error) });
      }
    });
    this.reconcile();
    // Decisions and fix dispatches a failure left undone are retried even
    // when planning is off (plan_interval_ms = 0).
    this.reconcileTimer = (this.opts.setInterval ?? setInterval)(() => {
      try { this.reconcile(); } catch (error) { this.log('error', 'vector reconcile failed; the next interval retries it', { error: String(error) }); }
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
    if (this.opts.vector.planIntervalMs > 0) {
      const tick = (): void => {
        try { this.planTick(); } catch (error) { this.log('error', 'vector raid planning failed; the next interval retries it', { error: String(error) }); }
      };
      // The first list is built off the boot path: it reads every managed repository.
      this.firstTick = (this.opts.setTimeout ?? setTimeout)(() => { this.firstTick = null; tick(); }, 0);
      this.firstTick.unref?.();
      this.timer = (this.opts.setInterval ?? setInterval)(tick, this.opts.vector.planIntervalMs);
      this.timer.unref?.();
    } else {
      this.log('info', 'vector raid planning interval is 0: raids only on request', {});
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.firstTick !== null) {
      clearTimeout(this.firstTick);
      this.firstTick = null;
    }
    for (const timer of [this.timer, this.reconcileTimer]) if (timer !== null) (this.opts.clearInterval ?? clearInterval)(timer);
    this.timer = null;
    this.reconcileTimer = null;
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new VectorRefusal('vector_disabled', 'Vector raids are disabled: set [vector] enabled = true in config.toml to let Gru plan raids');
    }
  }

  /** The code-built, ranked candidate list (fresh on every call). */
  candidates(): RaidCandidateList {
    this.requireEnabled();
    const raids = this.store.raids();
    return buildRaidCandidates({
      workspaceRoot: this.opts.workspaceRoot,
      managedRepos: this.opts.managedRepos,
      maxRaidsPerDay: this.opts.vector.maxRaidsPerDay,
      raids,
      perkinsFindings: (repo, since) => this.perkinsFindings(repo, since),
      escapedRegressions: (target) => this.store.breakIns().filter((entry) => entry.target.repo === target.repo && entry.target.packageDir === target.packageDir).length,
      ...(this.opts.resolvePackages === undefined ? {} : { resolvePackages: this.opts.resolvePackages }),
      now: this.now(),
    });
  }

  raids(): readonly RaidRecord[] {
    return this.store.raids();
  }

  /**
   * One planning tick: no eligible candidate means no Gru turn; a list Gru
   * already answered (or is still answering) is never offered again.
   */
  planTick(): { readonly offered: boolean; readonly digest: string | null } {
    this.requireEnabled();
    this.reconcile();
    const list = this.candidates();
    if (list.candidates.length === 0) return { offered: false, digest: null };
    if (this.store.plan(list.digest) !== null) return { offered: false, digest: list.digest };
    // A newer list supersedes any offer Gru has not answered yet.
    for (const open of this.store.openPlans()) {
      this.opts.ledger.resolveNotificationById(open.notificationId, 'vector-plan-superseded');
      this.store.record(VECTOR_EVENTS.planDecided, { digest: open.digest, picks: 0, superseded_by: list.digest });
    }
    const notificationId = `vector-plan:${list.digest.slice(0, 24)}`;
    this.opts.notifications.post({
      id: notificationId,
      kind: RAID_CANDIDATES_KIND,
      routing: 'action-required',
      severity: 'info',
      title: `Vector raid candidates changed (${String(list.candidates.length)})`,
      detail: this.planDetail(list),
    });
    this.store.record(VECTOR_EVENTS.planOffered, { digest: list.digest, notification_id: notificationId, candidates: list.candidates.length });
    return { offered: true, digest: list.digest };
  }

  private planDetail(list: RaidCandidateList): string {
    const rows = list.candidates.slice(0, 20).map((candidate, index) => {
      const s = candidate.signals;
      return `${String(index + 1)}. ${targetName(candidate.target)} @ ${candidate.headSha.slice(0, 12)} — commits since last raid ${String(s.commitsSinceLastRaid)}, ` +
        `Perkins findings ${String(s.perkinsFindings)}, earlier break-ins ${String(s.escapedRegressions)}, ` +
        `last raid ${s.daysSinceLastRaid === null ? 'never' : `${String(s.daysSinceLastRaid)} days ago`}`;
    });
    return [
      'Pick zero or more targets to raid, each with a one-line reason: POST /api/vector/raids',
      `{ "digest": "${list.digest}", "picks": [{ "repo": …, "package_dir": …, "reason": … }] } (GET /api/vector/candidates for the full list).`,
      'An empty "picks" answers this list. Raids run off the heist path and gate nothing.',
      ...rows,
      ...(list.candidates.length > 20 ? [`… and ${String(list.candidates.length - 20)} more`] : []),
    ].join('\n');
  }

  /** Validate and record Gru's picks (or the owner's chat request). Atomic: one invalid pick refuses them all. */
  pick(request: PickRequest): PickResult {
    this.requireEnabled();
    // Withdraw stale proposals first: a pending proposal that survives is
    // current, and a retried pick of its target reuses it.
    this.reconcile();
    const list = this.candidates();
    const pending = this.store.raids().filter((raid) => raid.state === 'proposed');
    const chosen: { readonly candidate: RaidCandidate | null; readonly reuse: RaidRecord | null; readonly reason: string }[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of request.picks.entries()) {
      const repo = oneLine(raw.repo, `picks[${String(index)}].repo`, 200);
      const packageDir = oneLine(raw.packageDir, `picks[${String(index)}].package_dir`, 500);
      const reason = oneLine(raw.reason, `picks[${String(index)}].reason`, RAID_REASON_MAX_CHARS);
      const key = `${repo}\u0000${packageDir}`;
      if (seen.has(key)) throw new VectorRefusal('invalid_pick', `picks[${String(index)}] repeats ${repo}/${packageDir}`);
      seen.add(key);
      const reuse = pending.find((raid) => raid.target.repo === repo && raid.target.packageDir === packageDir);
      if (reuse !== undefined) { chosen.push({ candidate: null, reuse, reason }); continue; }
      const candidate = list.candidates.find((entry) => entry.target.repo === repo && entry.target.packageDir === packageDir);
      if (candidate === undefined) {
        const excluded = list.exclusions.find((entry) => entry.repo === repo && (entry.packageDir === null || entry.packageDir === packageDir));
        throw new VectorRefusal('not_a_candidate', `${repo}/${packageDir} is not a raid candidate: ${excluded?.reason ?? 'code found no runnable package there'}`);
      }
      chosen.push({ candidate, reuse: null, reason });
    }
    const raids: RaidRecord[] = [];
    for (const { candidate, reuse, reason } of chosen) {
      if (reuse !== null) {
        // The owner asking in chat is the owner's Accept of the pending card.
        if (request.requestedBy === 'owner-chat' && reuse.notificationId !== null) {
          this.opts.ledger.recordNotificationDecision(reuse.notificationId, 'accept', 'owner-chat');
          this.followDecision(reuse.notificationId);
        }
        raids.push(this.store.raid(reuse.id)!);
        continue;
      }
      if (candidate === null) continue;
      const raidId = `raid-${randomUUID()}`;
      this.store.record(VECTOR_EVENTS.picked, {
        raid_id: raidId,
        repo: candidate.target.repo,
        package_dir: candidate.target.packageDir,
        source_identity: candidate.sourceIdentity,
        head_sha: candidate.headSha,
        reason,
        requested_by: request.requestedBy,
        signals: signalsPayload(candidate.signals),
      });
      if (request.requestedBy === 'owner-chat') this.launch(raidId, 'owner-chat');
      else if (this.opts.vector.raidMode === 'autonomous') this.launch(raidId, 'autonomous');
      else this.propose(raidId);
      raids.push(this.store.raid(raidId)!);
    }
    if (request.digest !== null) {
      const plan = this.store.plan(request.digest);
      if (plan !== null && plan.decidedAt === null) {
        this.store.record(VECTOR_EVENTS.planDecided, { digest: plan.digest, picks: chosen.length });
        this.opts.ledger.resolveNotificationById(plan.notificationId, 'gru');
      }
    }
    return { raids };
  }

  private decision(raid: RaidRecord): NotificationDecision {
    const v = this.opts.vector;
    const s = raid.signals;
    return parseNotificationDecision({
      question: `Launch Vector's raid on ${targetName(raid.target)}?`,
      context: [
        `Gru picked it at ${raid.headSha.slice(0, 12)}: ${raid.reason}`,
        `Budget: up to ${String(v.maxRounds)} attacks, ${String(v.maxRuns)} sandboxed runs, ${String(Math.round(v.maxRaidMs / 60_000))} minutes.`,
        `Signals: ${String(s.commitsSinceLastRaid)} commits since the last raid, ${String(s.perkinsFindings)} Perkins findings, ${String(s.escapedRegressions)} earlier break-ins.`,
        'A raid gates nothing, and finding nothing never means the code is safe.',
      ].join('\n'),
      recommendation: 'Gru recommends this raid.',
      reservedClass: 'authority-cost',
      whyNotDelegable: 'raid_mode = "proposed": a raid spends quota only with your Accept.',
      options: [
        { id: 'accept', label: 'Accept: launch the raid', consequence: 'Silas queues it; it starts when no heist work is waiting.' },
        { id: 'decline', label: 'Decline', consequence: 'Recorded. This package is not proposed again until its code changes.' },
      ],
      discussion: false,
    });
  }

  private propose(raidId: string): void {
    const raid = this.store.raid(raidId)!;
    const notificationId = `vector-raid:${raidId}`;
    this.opts.notifications.post({
      id: notificationId,
      kind: RAID_PROPOSAL_KIND,
      routing: 'needs-owner',
      severity: 'info',
      title: `Vector raid proposed: ${targetName(raid.target)}`,
      detail: `Gru's reason: ${raid.reason}`,
      decision: this.decision(raid),
    });
    this.store.record(VECTOR_EVENTS.proposed, { raid_id: raidId, notification_id: notificationId });
  }

  private launch(raidId: string, launchedBy: 'owner-accept' | 'autonomous' | 'owner-chat'): void {
    const raid = this.store.raid(raidId)!;
    this.store.record(VECTOR_EVENTS.queued, { raid_id: raidId, launched_by: launchedBy });
    this.opts.notifications.post({
      id: `vector-launched:${raidId}`,
      kind: RAID_LAUNCHED_KIND,
      routing: 'fyi',
      severity: 'info',
      title: `Vector raid launched: ${targetName(raid.target)}`,
      detail: `${launchedBy === 'autonomous' ? 'Launched by Gru (raid_mode = "autonomous")' : launchedBy === 'owner-chat' ? 'Requested by the owner in chat' : 'Accepted by the owner'}; queued for Silas. Reason: ${raid.reason}`,
    });
  }

  breakIns(): readonly BreakInRecord[] {
    return this.store.breakIns();
  }

  /** Spend and yield per repository across every finished raid (#351 §5). */
  rollup(): readonly RepositoryRollup[] {
    return repositoryRollups(this.store.raids());
  }

  /**
   * A confirmed break-in (#351 §4): one FOR YOU fix proposal (fix_mode
   * "proposed"), or the fix heist itself ("autonomous"). Idempotent, and a
   * contract the owner declined at this source identity is not proposed again.
   */
  async onBreakIn(breakInId: string): Promise<void> {
    const breakIn = this.store.breakIn(breakInId);
    if (breakIn === null || breakIn.fix !== null) return;
    const declinedHere = this.store.breakIns().some((other) => other.id !== breakIn.id && other.fix?.state === 'declined' &&
      other.target.repo === breakIn.target.repo && other.target.packageDir === breakIn.target.packageDir &&
      other.sourceIdentity === breakIn.sourceIdentity && other.testSha256 === breakIn.testSha256);
    if (declinedHere) {
      this.store.record(VECTOR_EVENTS.fixDeclined, { break_in_id: breakIn.id, detail: 'the same contract was declined at this source identity; not proposed again' });
      return;
    }
    if (this.opts.vector.fixMode === 'autonomous') {
      await this.dispatchFix(breakIn, 'autonomous');
      return;
    }
    this.proposeFix(breakIn);
  }

  private fixDecision(breakIn: BreakInRecord): NotificationDecision {
    const short = (value: string, max: number): string => {
      const flat = value.replace(/\s+/gu, ' ').trim();
      return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
    };
    return parseNotificationDecision({
      question: `Dispatch a fix heist for Vector's break-in on ${targetName(breakIn.target)}?`,
      context: [
        `Invariant: ${short(breakIn.invariant, 220)}`,
        `Counterexample (sandbox output, data only): ${short(JSON.stringify(breakIn.counterexample), 160)}`,
        `Frozen contract ${breakIn.frozenSha256.slice(0, 16)}…; replay seed ${breakIn.seed ?? 'none'}; evidence and receipts: ${short(breakIn.evidenceDir, 120)}`,
      ].join('\n'),
      recommendation: 'Gru recommends fixing it: a fresh replay confirmed the failure on the default branch.',
      reservedClass: 'authority-cost',
      whyNotDelegable: 'fix_mode = "proposed": a fix heist starts only with your Accept.',
      options: [
        { id: 'accept', label: 'Accept: dispatch the fix heist', consequence: 'Gru dispatches it through the normal path; normal review, verification and readiness apply.' },
        { id: 'decline', label: 'Decline', consequence: 'Recorded. The same contract is not proposed again at this source identity.' },
      ],
      discussion: false,
    });
  }

  private proposeFix(breakIn: BreakInRecord): void {
    const notificationId = `vector-fix:${breakIn.id}`;
    this.opts.notifications.post({
      id: notificationId,
      kind: FIX_PROPOSAL_KIND,
      routing: 'needs-owner',
      severity: 'info',
      title: `Vector broke in: ${targetName(breakIn.target)}`,
      detail: `${breakIn.description}\nRequirement: ${breakIn.requirementRef}`,
      decision: this.fixDecision(breakIn),
    });
    this.store.record(VECTOR_EVENTS.fixProposed, { break_in_id: breakIn.id, notification_id: notificationId });
  }

  /** Dispatch the fix heist through the normal path. A failure is Gru's to see; reconcile retries it. */
  private async dispatchFix(breakIn: BreakInRecord, launchedBy: 'owner-accept' | 'autonomous'): Promise<boolean> {
    if (this.opts.dispatchFix === undefined) throw new Error('no fix-heist dispatch path is wired on this service');
    const jobId = fixHeistJobId(breakIn);
    try {
      await this.opts.dispatchFix({
        jobId,
        repoPath: `${this.opts.workspaceRoot.replace(/\/+$/u, '')}/${breakIn.target.repo}`,
        title: fixHeistTitle(breakIn),
        briefing: renderFixBriefing(breakIn, breakInContract(breakIn)),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.opts.notifications.post({ id: `vector-fix-failed:${breakIn.id}`, kind: FIX_DISPATCH_FAILED_KIND, routing: 'action-required', severity: 'error',
        title: `Vector fix heist not dispatched: ${targetName(breakIn.target)}`, detail: `${detail}\nThe next reconcile retries it.` });
      this.log('error', 'vector fix heist dispatch failed; the next reconcile retries it', { breakIn: breakIn.id, error: detail });
      return false;
    }
    this.store.record(VECTOR_EVENTS.fixDispatched, { break_in_id: breakIn.id, job_id: jobId, launched_by: launchedBy });
    const failed = this.opts.ledger.getNotification(`vector-fix-failed:${breakIn.id}`);
    if (failed !== null && failed.resolvedAt === null) this.opts.ledger.resolveNotificationById(failed.id, 'vector-fix-dispatched');
    this.opts.notifications.post({ id: `vector-fix-dispatched:${breakIn.id}`, kind: FIX_DISPATCHED_KIND, routing: 'fyi', severity: 'info',
      title: `Vector fix heist dispatched: ${jobId}`, detail: `${launchedBy === 'autonomous' ? 'fix_mode = "autonomous"' : 'Accepted by the owner'}; the frozen contract travels with it.` });
    return true;
  }

  /** Carry out the owner's recorded choice on a fix proposal. Idempotent. */
  async followFixDecision(notificationId: string): Promise<void> {
    const row = this.opts.ledger.getNotification(notificationId);
    if (row === null || row.kind !== FIX_PROPOSAL_KIND || row.decidedOption === null) return;
    const breakIn = this.store.breakIns().find((entry) => entry.fix?.notificationId === notificationId);
    if (breakIn === undefined) return;
    if (breakIn.fix?.state === 'proposed') {
      if (row.decidedOption === 'accept') {
        if (!(await this.dispatchFix(breakIn, 'owner-accept'))) return;
      } else {
        this.store.record(VECTOR_EVENTS.fixDeclined, { break_in_id: breakIn.id, detail: `declined by ${row.decidedBy ?? 'the owner'}` });
      }
    }
    const done = this.store.breakIn(breakIn.id)!;
    if (row.resolvedAt === null && done.fix?.state !== 'proposed') {
      this.opts.ledger.resolveOwnerDecision(notificationId, done.fix?.state === 'dispatched' ? `fix heist ${done.fix.jobId ?? ''} dispatched` : 'decline recorded', OWNER_PROVENANCE);
    }
  }

  /** Carry out the owner's recorded choice on a raid proposal. Idempotent. */
  followDecision(notificationId: string): void {
    const row = this.opts.ledger.getNotification(notificationId);
    if (row?.kind === FIX_PROPOSAL_KIND) {
      void this.followFixDecision(notificationId).catch((error: unknown) => {
        this.log('error', 'vector fix decision follow-through failed; the next reconcile retries it', { notification: notificationId, error: String(error) });
      });
      return;
    }
    if (row === null || row.kind !== RAID_PROPOSAL_KIND || row.decidedOption === null) return;
    const raid = this.store.raids().find((entry) => entry.notificationId === notificationId);
    if (raid === undefined) return;
    if (raid.state === 'proposed') {
      if (row.decidedOption === 'accept') this.launch(raid.id, 'owner-accept');
      else this.store.record(VECTOR_EVENTS.declined, { raid_id: raid.id, detail: `declined by ${row.decidedBy ?? 'the owner'}` });
    }
    if (row.resolvedAt === null) {
      const done = this.store.raid(raid.id)!;
      this.opts.ledger.resolveOwnerDecision(notificationId, done.state === 'queued' ? 'raid queued for Silas' : 'decline recorded', OWNER_PROVENANCE);
    }
  }

  /**
   * Boot and every tick: carry out decisions recorded while the service was
   * down, withdraw proposals whose target changed, and re-ensure every
   * pending proposal's FOR YOU row.
   */
  reconcile(): void {
    if (!this.enabled) return;
    for (const breakIn of this.store.breakIns()) {
      if (breakIn.fix === null) {
        // Found while the follow-through was down (or it failed): carry it out now.
        void this.onBreakIn(breakIn.id).catch((error: unknown) => this.log('error', 'vector break-in follow-through failed', { breakIn: breakIn.id, error: String(error) }));
      } else if (breakIn.fix.state === 'proposed' && breakIn.fix.notificationId !== null) {
        const row = this.opts.ledger.getNotification(breakIn.fix.notificationId);
        if (row === null) this.proposeFix(breakIn);
        else if (row.decidedOption !== null) this.followDecision(row.id);
      }
    }
    const pending = this.store.raids().filter((raid) => raid.state === 'proposed' && raid.notificationId !== null);
    if (pending.length === 0) return;
    let list: RaidCandidateList | null = null;
    for (const raid of pending) {
      const row = this.opts.ledger.getNotification(raid.notificationId!);
      if (row !== null && row.decidedOption !== null) { this.followDecision(raid.notificationId!); continue; }
      // Proposals exclude their own target, so compare against the code
      // directly: the package's tree at the current default-branch head.
      list ??= this.candidatesIgnoringPending();
      const current = list.candidates.find((entry) => entry.target.repo === raid.target.repo && entry.target.packageDir === raid.target.packageDir);
      if (current === undefined || current.sourceIdentity !== raid.sourceIdentity) {
        const detail = current === undefined
          ? `withdrawn: ${targetName(raid.target)} is no longer a raid candidate`
          : `withdrawn: ${targetName(raid.target)} changed (${raid.sourceIdentity.slice(0, 12)} → ${current.sourceIdentity.slice(0, 12)}) before a decision`;
        if (row !== null) this.opts.ledger.withdrawOwnerProposal(row.id, detail);
        this.store.record(VECTOR_EVENTS.withdrawn, { raid_id: raid.id, detail });
        this.opts.notifications.post({ id: `vector-withdrawn:${raid.id}`, kind: RAID_WITHDRAWN_KIND, routing: 'fyi', severity: 'info', title: `Vector raid proposal withdrawn: ${targetName(raid.target)}`, detail });
        continue;
      }
      if (row === null) this.propose(raid.id);
    }
  }

  /** The candidate list as if no proposal were pending (the withdrawal check). */
  private candidatesIgnoringPending(): RaidCandidateList {
    const raids = this.store.raids().filter((raid) => raid.state !== 'proposed');
    return buildRaidCandidates({
      workspaceRoot: this.opts.workspaceRoot,
      managedRepos: this.opts.managedRepos,
      // The daily cap does not decide whether a pending proposal is stale.
      maxRaidsPerDay: Number.MAX_SAFE_INTEGER,
      raids,
      perkinsFindings: () => 0,
      escapedRegressions: () => 0,
      ...(this.opts.resolvePackages === undefined ? {} : { resolvePackages: this.opts.resolvePackages }),
      now: this.now(),
    });
  }

  /** Changes-requested Perkins verdicts on the repository's jobs since an instant. */
  private perkinsFindings(repo: string, since: string | null): number {
    const sinceMs = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);
    let count = 0;
    for (const job of this.opts.ledger.listJobs(repo)) {
      for (const round of this.opts.ledger.listRounds(job.id)) {
        if (round.verdict === 'changes-requested' && Date.parse(round.updatedAt) > sinceMs) count += 1;
      }
    }
    return count;
  }
}
