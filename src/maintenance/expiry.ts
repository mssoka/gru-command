import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { EventBus } from '../events/bus.js';
import { repositoryGitEnv } from '../git-env.js';
import { NotificationDecisionRefusal, type EventRecord, type LedgerApi, type NotificationRecord, type WorktreeRecord } from '../ledger/api.js';
import { parseNotificationDecision, type NotificationDecision } from '../ledger/notification-decision.js';
import { isJobTerminal } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { PRESERVED_REF_PREFIX, preservedRefComponent } from '../worktrees/manager.js';
import { removeTree, treeBytes } from '../worktrees/reclaim.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Expiry (#427 PR 2b): what GC keeps after a job ends is removed when it
 * loses nothing, and proposed to the owner when it would.
 *
 * - **Review artifacts.** Once a job has been terminal (merged, done or
 *   binned) for {@link REVIEW_EXPIRY_MS}, its `reviews/<round>` folders are
 *   emptied except {@link REVIEW_KEPT_FILES} and its
 *   `reviews/fallback-gate/<job>-*` folders are deleted, automatically: the
 *   ledger keeps the verdicts and findings, the PR keeps the published
 *   review, and nothing reviews a terminal job again. Each round's
 *   `consolidated.json` stays because readers outlive the job: the decision
 *   backtest's same-blocker corpus (`gru-decisions extract-cases --surface
 *   same_blocker`, src/decisions/cases/same-blocker-extract.ts) and the
 *   digest's blocker reader (src/dispatch/silas-driver.ts) read it. Each
 *   pass records `reviews.expired { job_id, rounds, fallback_gates, bytes }`
 *   for each job it deleted something of. A file whose delete fails stays,
 *   and the next reconcile tries it again.
 * - **Saved work.** Preserve copies (`<preserve_root>/<lane>/<stamp>`) and
 *   snapshot refs (`refs/gru/preserved/<lane>/<stamp>`) hold minion work, so
 *   they are never deleted automatically (owner ruling 2026-10-16). Once a
 *   swept lane's job has been terminal for {@link PRESERVE_EXPIRY_MS}, GC
 *   posts one FOR YOU card per repository (kind {@link PRESERVE_EXPIRY_KIND})
 *   listing them, their sizes and how to restore each. The list is recorded
 *   first (`preserves.proposed`). Accept deletes exactly what it lists
 *   (`preserves.deleted`): a copy by its path, a ref only while it still
 *   names the listed commit. Accept follows the list recorded before the
 *   card, re-checked: a copy only while it is still that lane's folder under
 *   the preserve root with its listed size, a ref only while it is that
 *   lane's snapshot ref of this repository naming the listed commit;
 *   anything else is kept and proposed again. A pass that cannot delete all
 *   of it records what it did (`preserves.delete-incomplete`) and keeps the
 *   card open; the pass that finishes records the sum. Decline keeps them
 *   (`preserves.declined`), and GC proposes again
 *   {@link PRESERVE_REPROPOSE_MS} later.
 *
 * Both run at start and every hour ({@link EXPIRY_RECONCILE_INTERVAL_MS}),
 * one pass at a time, with no migration: ledger events and notification
 * rows only. The periods are constants; a later change may move them to
 * config.
 */

const DAY_MS = 24 * 60 * 60_000;

/** How long a job is terminal before its review folders are deleted. */
export const REVIEW_EXPIRY_MS = 14 * DAY_MS;
/** How long a swept lane's job is terminal before its saved work is proposed for deletion. */
export const PRESERVE_EXPIRY_MS = 30 * DAY_MS;
/** How long after a Decline the same repository is proposed again. */
export const PRESERVE_REPROPOSE_MS = 30 * DAY_MS;
/** Expiry runs at start and then every hour. */
export const EXPIRY_RECONCILE_INTERVAL_MS = 60 * 60_000;

/** The owner's Accept/Decline on deleting a repository's expired saved work. */
export const PRESERVE_EXPIRY_KIND = 'worktree.preserve-expiry';

/** Expiry's ledger events. */
export const EXPIRY_EVENTS = {
  reviewsExpired: 'reviews.expired',
  preservesProposed: 'preserves.proposed',
  preservesDeclined: 'preserves.declined',
  preservesDeleted: 'preserves.deleted',
  preservesDeleteIncomplete: 'preserves.delete-incomplete',
} as const;

/** The files of an expired round folder that are kept: long-lived readers
 * read them after the job ends (the decision backtest's same-blocker
 * corpus, the digest's blocker reader). Kept only as regular files. */
export const REVIEW_KEPT_FILES: readonly string[] = ['consolidated.json'];

/** A review round id as `reviewArtifactDirectory` accepts it for a folder name. */
const ROUND_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u;
/** A fallback gate's folder: `<job>-<epoch ms>-<random base36>`. */
const FALLBACK_GATE_FOLDER = /^(.+)-\d+-[a-z0-9]+$/u;

const OWNER_PROVENANCE = { credential: 'internal', declaredActor: null } as const;

/** One preserve copy a card lists. */
export interface ExpiredCopy {
  readonly lane: string;
  readonly path: string;
  readonly bytes: number;
}

/** One snapshot ref a card lists; `bytes`: what only it keeps in the
 * repository (null when git could not say). */
export interface ExpiredRef {
  readonly lane: string;
  readonly ref: string;
  readonly sha: string;
  readonly bytes: number | null;
}

/** A repository's expired saved work. */
export interface ExpiredWork {
  readonly repoPath: string;
  readonly repoName: string;
  readonly copies: readonly ExpiredCopy[];
  readonly refs: readonly ExpiredRef[];
}

/** A finished job's review folders ({@link ExpiryService.expirableReviews}). */
export interface ExpirableReviews {
  readonly jobId: string;
  readonly rounds: readonly string[];
  readonly fallbackGates: readonly string[];
  /** What expiry deletes, rounds first: each folder, or for a round folder
   * holding a kept file ({@link REVIEW_KEPT_FILES}) its other entries. */
  readonly paths: readonly string[];
}

/** What one `reviews.expired` recorded. */
export interface ReviewsExpired {
  readonly jobId: string;
  readonly rounds: readonly string[];
  readonly fallbackGates: readonly string[];
  readonly bytes: number;
}

/** A recorded proposal (`preserves.proposed`), as its card's Accept reads it. */
interface Proposal extends ExpiredWork {
  readonly notificationId: string;
  readonly proposal: number;
}

export interface ExpiryServiceOptions {
  readonly ledger: Pick<LedgerApi,
    'getJob' | 'getRound' | 'listJobEventsByKinds' | 'listWorktrees' | 'getWorktree' | 'appendCustomEvent' | 'listOpenNotificationsByKinds' |
    'resolveOwnerDecision' | 'listEventsAfter'>;
  readonly bus: EventBus;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  /** `<data_dir>/reviews`: round folders and `fallback-gate/`. */
  readonly reviewsRoot: string;
  /** `[worktrees] preserve_root`. */
  readonly preserveRoot: string;
  /** Run at the start of every pass (main.ts: the moved-repository check). A
   * failure is logged. */
  readonly onReconcile?: () => Promise<void> | void;
  /** Clock seam (default Date.now). */
  readonly now?: () => number;
  readonly log?: Log;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

export class ExpiryService {
  private readonly log: Log;
  private readonly now: () => number;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  /** Jobs whose terminal time could not be read, warned about once. */
  private readonly unreadable = new Set<string>();

  constructor(private readonly opts: ExpiryServiceOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** Follow the owner's answers, run a pass now, and one every hour. */
  start(): void {
    if (this.unsubscribe !== null || this.stopped) return;
    this.unsubscribe = this.opts.bus.subscribe((event) => {
      if (event.kind !== 'notification.decision') return;
      const id = (event.payload as { readonly id?: unknown } | null)?.id;
      if (typeof id === 'string' && id.startsWith('worktree-preserve-expiry:')) void this.reconcile();
    });
    this.timer = (this.opts.setInterval ?? setInterval)(() => { void this.reconcile(); }, EXPIRY_RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
    void this.reconcile();
  }

  /** Stop following and reconciling; a pass that is running stops at its
   * next step. */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) (this.opts.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }

  /** One pass (a pass already running takes this request after it). Never rejects. */
  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.stopped);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private async pass(): Promise<void> {
    const steps: readonly [string, () => Promise<void> | void][] = [
      ['the moved-repository check', () => this.opts.onReconcile?.()],
      ['review expiry', async () => { await this.expireReviews(); }],
      ['saved-work decisions', () => this.followCards()],
      ['saved-work proposals', () => this.proposeExpiredWork()],
    ];
    for (const [what, step] of steps) {
      if (this.stopped) return;
      try {
        await step();
      } catch (error) {
        this.log('error', `${what} failed; the next reconcile retries it`, { error: String(error) });
      }
    }
  }

  // ------------------------------------------------------------------
  // Review artifacts
  // ------------------------------------------------------------------

  /** The review folders of every job terminal for at least `olderThanMs`
   * (default {@link REVIEW_EXPIRY_MS}), by job: what {@link expireReviews}
   * deletes. An open job's folders, a job whose end cannot be read, the
   * folders of a round or job the ledger does not know, and a round folder
   * holding nothing but its kept files (expired before) are never listed.
   * The disk budget (#427 PR 3) lists them with no wait (`olderThanMs: 0`). */
  expirableReviews(opts: { readonly olderThanMs?: number } = {}): readonly ExpirableReviews[] {
    const olderThan = opts.olderThanMs ?? REVIEW_EXPIRY_MS;
    const byJob = new Map<string, { rounds: string[]; gates: string[] }>();
    const of = (jobId: string): { rounds: string[]; gates: string[] } => {
      const entry = byJob.get(jobId) ?? { rounds: [], gates: [] };
      byJob.set(jobId, entry);
      return entry;
    };
    for (const name of folders(this.opts.reviewsRoot)) {
      if (name === 'fallback-gate' || !ROUND_FOLDER.test(name)) continue;
      const round = this.opts.ledger.getRound(name);
      if (round !== null) of(round.jobId).rounds.push(name);
    }
    for (const name of folders(join(this.opts.reviewsRoot, 'fallback-gate'))) {
      const jobId = FALLBACK_GATE_FOLDER.exec(name)?.[1];
      if (jobId !== undefined) of(jobId).gates.push(name);
    }
    const expirable: ExpirableReviews[] = [];
    for (const [jobId, found] of byJob) {
      const since = this.terminalSince(jobId);
      if (since === null || this.now() - since < olderThan) continue;
      const rounds: string[] = [];
      const roundPaths: string[] = [];
      for (const name of found.rounds) {
        const folder = join(this.opts.reviewsRoot, name);
        const entries = expiredEntries(folder, REVIEW_KEPT_FILES);
        if (entries.length === 0) continue;
        rounds.push(name);
        roundPaths.push(...(entries.length === readdirOrEmpty(folder).length ? [folder] : entries.map((entry) => join(folder, entry))));
      }
      if (rounds.length + found.gates.length === 0) continue;
      expirable.push({
        jobId,
        rounds,
        fallbackGates: found.gates,
        paths: [...roundPaths, ...found.gates.map((name) => join(this.opts.reviewsRoot, 'fallback-gate', name))],
      });
    }
    return expirable;
  }

  /** Delete the review folders of every job terminal for at least
   * `olderThanMs` (default {@link REVIEW_EXPIRY_MS}; `jobs`: only those
   * jobs'); record one `reviews.expired` per job, and return what each
   * record says. */
  async expireReviews(opts: { readonly olderThanMs?: number; readonly jobs?: readonly string[] } = {}): Promise<readonly ReviewsExpired[]> {
    const olderThanMs = opts.olderThanMs ?? REVIEW_EXPIRY_MS;
    const expired: ReviewsExpired[] = [];
    for (const found of this.expirableReviews({ olderThanMs })) {
      if (this.stopped) break;
      if (opts.jobs !== undefined && !opts.jobs.includes(found.jobId)) continue;
      const done = await this.expireJobReviews(found, { olderThanMs });
      if (done !== null) expired.push(done);
    }
    return expired;
  }

  /** Delete exactly the listed review folders of one job (#427 PR 3: what
   * the disk budget's step, or the card the owner accepted, listed), each
   * checked again first, without listing every review: the job is still
   * terminal for at least `olderThanMs` (default {@link REVIEW_EXPIRY_MS}),
   * and each folder is still there and still that job's. One
   * `reviews.expired` records what was deleted; null when nothing was. */
  async expireJobReviews(listed: Pick<ExpirableReviews, 'jobId' | 'rounds' | 'fallbackGates'>, opts: { readonly olderThanMs?: number } = {}): Promise<ReviewsExpired | null> {
    const { jobId } = listed;
    const since = this.terminalSince(jobId);
    if (since === null || this.now() - since < (opts.olderThanMs ?? REVIEW_EXPIRY_MS)) return null;
    const rounds: string[] = [];
    const gates: string[] = [];
    const failed: { readonly folder: string; readonly error: string }[] = [];
    let bytes = 0;
    /** Delete a folder (a fallback gate's), or a round folder's entries
     * but its kept files; `done` names it once nothing else is left. */
    const remove = async (folder: string, done: string[], name: string, keepFiles: readonly string[]): Promise<void> => {
      if (!existsSync(folder)) return;
      const entries = keepFiles.length === 0 ? null : expiredEntries(folder, keepFiles);
      if (entries !== null && entries.length === 0) return; // expired before
      const targets = entries === null || entries.length === readdirOrEmpty(folder).length ? [folder] : entries.map((entry) => join(folder, entry));
      let complete = true;
      for (const target of targets) {
        const size = await treeBytes(target);
        try {
          await removeTree(target);
          bytes += size;
        } catch (error) {
          complete = false;
          failed.push({ folder: target, error: String(error) });
        }
      }
      if (complete) done.push(name);
    };
    for (const name of listed.rounds) {
      if (this.stopped) break;
      if (name === 'fallback-gate' || !ROUND_FOLDER.test(name) || this.opts.ledger.getRound(name)?.jobId !== jobId) continue;
      await remove(join(this.opts.reviewsRoot, name), rounds, name, REVIEW_KEPT_FILES);
    }
    for (const name of listed.fallbackGates) {
      if (this.stopped) break;
      if (FALLBACK_GATE_FOLDER.exec(name)?.[1] !== jobId) continue;
      await remove(join(this.opts.reviewsRoot, 'fallback-gate', name), gates, name, []);
    }
    if (failed.length > 0) this.log('warn', 'review folders of a finished job could not be deleted; the next reconcile tries again', { job: jobId, failed });
    if (rounds.length + gates.length === 0) return null;
    this.opts.ledger.appendCustomEvent({ kind: EXPIRY_EVENTS.reviewsExpired, jobId, payload: { job_id: jobId, rounds, fallback_gates: gates, bytes } });
    this.log('info', 'review folders of a finished job expired', { job: jobId, rounds: rounds.length, fallback_gates: gates.length, bytes });
    return { jobId, rounds, fallbackGates: gates, bytes };
  }

  /** When the job became terminal (its newest `job.status` to that status),
   * or null while it is open or the time cannot be read (with one warn: an
   * unreadable time is never old). */
  private terminalSince(jobId: string): number | null {
    const job = this.opts.ledger.getJob(jobId);
    if (job === null || !isJobTerminal(job.status)) return null;
    const event = this.opts.ledger.listJobEventsByKinds(jobId, ['job.status'], { limit: 1 })[0];
    const at = event !== undefined && (event.payload as { readonly to?: unknown } | null)?.to === job.status ? Date.parse(event.ts) : Number.NaN;
    if (!Number.isNaN(at)) return at;
    if (!this.unreadable.has(jobId)) {
      this.unreadable.add(jobId);
      this.log('warn', 'when a finished job ended cannot be read; nothing of it expires', { job: jobId, status: job.status, event: event?.seq ?? null });
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Saved work: preserve copies and snapshot refs
  // ------------------------------------------------------------------

  /** Each repository's saved work from swept lanes whose job has been
   * terminal for at least {@link PRESERVE_EXPIRY_MS}. */
  async expiredWork(): Promise<readonly ExpiredWork[]> {
    const lanesByRepo = new Map<string, WorktreeRecord[]>();
    for (const lane of this.opts.ledger.listWorktrees({ status: 'swept' })) {
      const jobId = lane.jobId ?? (lane.roundId === null ? null : this.opts.ledger.getRound(lane.roundId)?.jobId ?? null);
      if (jobId === null) continue;
      const since = this.terminalSince(jobId);
      if (since === null || this.now() - since < PRESERVE_EXPIRY_MS) continue;
      lanesByRepo.set(lane.repoPath, [...(lanesByRepo.get(lane.repoPath) ?? []), lane]);
    }
    const expired: ExpiredWork[] = [];
    for (const [repoPath, lanes] of lanesByRepo) {
      const copies: ExpiredCopy[] = [];
      for (const lane of lanes) {
        const folder = join(this.opts.preserveRoot, lane.id);
        if (!inside(this.opts.preserveRoot, folder)) continue;
        for (const name of folders(folder)) {
          const path = join(folder, name);
          copies.push({ lane: lane.id, path, bytes: await treeBytes(path) });
        }
      }
      const refs = this.expiredRefs(repoPath, new Map(lanes.map((lane) => [preservedRefComponent(lane.id), lane.id])));
      if (copies.length + refs.length > 0) expired.push({ repoPath, repoName: lanes[0]!.repoName, copies, refs });
    }
    return expired;
  }

  /** The snapshot refs of the given lanes (by their ref component) in one
   * repository. A repository that is gone, or git failing, lists none. */
  private expiredRefs(repoPath: string, lanes: ReadonlyMap<string, string>): ExpiredRef[] {
    if (!existsSync(repoPath)) return [];
    const listing = git(repoPath, ['for-each-ref', '--format=%(objectname) %(refname)', `${PRESERVED_REF_PREFIX}/`]);
    if (listing.status !== 0) {
      this.log('warn', 'the snapshot refs of a repository could not be listed; none of them is proposed now', { repo_path: repoPath, error: listing.stderr.trim() });
      return [];
    }
    const refs: ExpiredRef[] = [];
    for (const line of listing.stdout.split('\n')) {
      const space = line.indexOf(' ');
      if (space < 0) continue;
      const sha = line.slice(0, space);
      const ref = line.slice(space + 1);
      const parts = ref.slice(PRESERVED_REF_PREFIX.length + 1).split('/');
      const lane = parts.length === 2 ? lanes.get(parts[0]!) : undefined;
      if (lane === undefined) continue;
      // What only this ref keeps: its objects no other ref reaches.
      const usage = git(repoPath, ['rev-list', '--objects', '--disk-usage', sha, '--not', `--exclude=${ref}`, '--all']);
      const bytes = usage.status === 0 ? Number(usage.stdout.trim()) : Number.NaN;
      refs.push({ lane, ref, sha, bytes: Number.isSafeInteger(bytes) ? bytes : null });
    }
    return refs;
  }

  /** One card per repository with expired saved work, unless a card of it is
   * open, or the owner declined one less than {@link PRESERVE_REPROPOSE_MS}
   * ago. The list is recorded before the card is posted, so an Accept always
   * has it. */
  async proposeExpiredWork(): Promise<void> {
    const open = this.opts.ledger.listOpenNotificationsByKinds([PRESERVE_EXPIRY_KIND]);
    for (const work of await this.expiredWork()) {
      if (this.stopped) return;
      if (open.some((card) => this.proposal(card.id)?.repoPath === work.repoPath)) continue;
      const declined = this.latest(EXPIRY_EVENTS.preservesDeclined, work.repoPath);
      const declinedAt = Date.parse(String((declined?.payload as { readonly decided_at?: unknown } | undefined)?.decided_at ?? declined?.ts ?? ''));
      if (declined !== null && (Number.isNaN(declinedAt) || this.now() - declinedAt < PRESERVE_REPROPOSE_MS)) continue;
      const last = this.latest(EXPIRY_EVENTS.preservesProposed, work.repoPath);
      const proposal = Number((last?.payload as { readonly proposal?: unknown } | undefined)?.proposal ?? 0) + 1;
      const id = preserveExpiryCardId(work.repoPath, work.repoName, proposal);
      this.opts.ledger.appendCustomEvent({
        kind: EXPIRY_EVENTS.preservesProposed,
        payload: { repo_path: work.repoPath, repo: work.repoName, notification_id: id, proposal, copies: work.copies, refs: work.refs },
      });
      this.opts.notifications.post(preserveExpiryCard(id, work));
    }
  }

  /** Carry out the answered cards. Accept deletes exactly what the card
   * listed; a delete that fails keeps the card open, and the next pass
   * deletes what is left. */
  async followCards(): Promise<void> {
    for (const card of this.opts.ledger.listOpenNotificationsByKinds([PRESERVE_EXPIRY_KIND])) {
      if (this.stopped) return;
      if (card.decidedOption === null) continue;
      const proposal = this.proposal(card.id);
      if (proposal === null) {
        this.close(card, 'nothing deleted: GC has no record of what this card listed');
        continue;
      }
      if (card.decidedOption !== 'accept') {
        this.opts.ledger.appendCustomEvent({
          kind: EXPIRY_EVENTS.preservesDeclined,
          payload: { repo_path: proposal.repoPath, notification_id: card.id, by: card.decidedBy ?? 'the owner', decided_at: card.decidedAt },
        });
        this.close(card, `kept; GC proposes again in ${String(PRESERVE_REPROPOSE_MS / DAY_MS)} days`);
        continue;
      }
      await this.deleteListed(card, proposal);
    }
  }

  private async deleteListed(card: NotificationRecord, proposal: Proposal): Promise<void> {
    const earlier = this.earlierPasses(card.id);
    const failed: { readonly item: string; readonly error: string }[] = [];
    const kept: { readonly item: string; readonly reason: string }[] = [];
    const copies: string[] = [];
    const refs: string[] = [];
    let bytes = 0;
    /** A lane the card lists: released, of this repository when `repoPath` is given. */
    const releasedLane = (id: string, repoPath: string | null): boolean => {
      const lane = this.opts.ledger.getWorktree(id);
      return lane !== null && lane.status === 'swept' && (repoPath === null || lane.repoPath === repoPath);
    };
    for (const copy of proposal.copies) {
      if (earlier.copies.has(copy.path)) continue;
      const parts = relative(this.opts.preserveRoot, copy.path).split(sep);
      if (!releasedLane(copy.lane, null) || parts.length !== 2 || parts[0] !== copy.lane || !inside(this.opts.preserveRoot, copy.path)) {
        kept.push({ item: copy.path, reason: 'it is not a preserve copy of a released lane this card lists' });
        continue;
      }
      if (!existsSync(copy.path)) continue;
      if (!insideReally(this.opts.preserveRoot, copy.path)) {
        kept.push({ item: copy.path, reason: 'it is not a folder under the preserve root (a link, or reached through one)' });
        continue;
      }
      // A copy a failed pass began deleting is finished, whatever is left.
      if (!earlier.attempted.has(copy.path) && await treeBytes(copy.path) !== copy.bytes) {
        kept.push({ item: copy.path, reason: 'it changed since the card listed it' });
        continue;
      }
      try {
        await removeTree(copy.path);
        bytes += copy.bytes;
        copies.push(copy.path);
      } catch (error) {
        failed.push({ item: copy.path, error: String(error) });
      }
    }
    for (const ref of proposal.refs) {
      if (earlier.refs.has(ref.ref)) continue;
      const parts = ref.ref.startsWith(`${PRESERVED_REF_PREFIX}/`) ? ref.ref.slice(PRESERVED_REF_PREFIX.length + 1).split('/') : [];
      if (!existsSync(proposal.repoPath)) {
        kept.push({ item: ref.ref, reason: `the repository is no longer at ${proposal.repoPath}` });
        continue;
      }
      if (!releasedLane(ref.lane, proposal.repoPath) || parts.length !== 2 || parts[0] !== preservedRefComponent(ref.lane) || parts[1] === '') {
        kept.push({ item: ref.ref, reason: 'it is not a snapshot ref of a released lane of this repository' });
        continue;
      }
      const now = git(proposal.repoPath, ['rev-parse', '--verify', '--quiet', ref.ref]);
      if (now.status === 1) continue;
      if (now.status !== 0) {
        failed.push({ item: ref.ref, error: now.stderr.trim() || `git rev-parse exited ${String(now.status)}` });
        continue;
      }
      if (now.stdout.trim() !== ref.sha) {
        kept.push({ item: ref.ref, reason: `it names ${now.stdout.trim()} now, not the listed ${ref.sha}` });
        continue;
      }
      const deleted = git(proposal.repoPath, ['update-ref', '-d', ref.ref, ref.sha]);
      if (deleted.status === 0) {
        bytes += ref.bytes ?? 0;
        refs.push(ref.ref);
      } else {
        failed.push({ item: ref.ref, error: deleted.stderr.trim() || `git update-ref exited ${String(deleted.status)}` });
      }
    }
    if (failed.length > 0) {
      // Recorded when it changed something or failed something new, so a
      // card that keeps failing adds no record per pass.
      if (copies.length + refs.length > 0 || failed.some((entry) => !earlier.attempted.has(entry.item))) {
        this.opts.ledger.appendCustomEvent({
          kind: EXPIRY_EVENTS.preservesDeleteIncomplete,
          payload: { repo_path: proposal.repoPath, notification_id: card.id, copies, refs, bytes, failed: failed.map((entry) => entry.item) },
        });
      }
      this.log('warn', 'saved work the owner accepted to delete could not all be deleted; the card stays open and the next reconcile deletes what is left', { notification: card.id, failed });
      return;
    }
    this.opts.ledger.appendCustomEvent({
      kind: EXPIRY_EVENTS.preservesDeleted,
      payload: {
        repo_path: proposal.repoPath,
        notification_id: card.id,
        copies: [...earlier.copies, ...copies],
        refs: [...earlier.refs, ...refs],
        kept,
        bytes: earlier.bytes + bytes,
      },
    });
    this.close(card, kept.length === 0 ? 'deleted everything the card listed' : `deleted what the card listed, except ${kept.map((entry) => `${entry.item} (${entry.reason})`).join('; ')}`);
  }

  /** What earlier passes of an accepted card deleted, and began deleting,
   * before one of them failed (`preserves.delete-incomplete`). */
  private earlierPasses(notificationId: string): { readonly copies: ReadonlySet<string>; readonly refs: ReadonlySet<string>; readonly attempted: ReadonlySet<string>; readonly bytes: number } {
    const copies = new Set<string>();
    const refs = new Set<string>();
    const attempted = new Set<string>();
    let bytes = 0;
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    for (let cursor = 0; ;) {
      const page = this.opts.ledger.listEventsAfter(cursor, { kinds: [EXPIRY_EVENTS.preservesDeleteIncomplete], payload: { key: 'notification_id', equals: notificationId }, limit: 500 });
      if (page.length === 0) return { copies, refs, attempted, bytes };
      for (const event of page) {
        cursor = event.seq;
        const payload = (event.payload ?? {}) as { readonly copies?: unknown; readonly refs?: unknown; readonly failed?: unknown; readonly bytes?: unknown };
        for (const path of strings(payload.copies)) copies.add(path);
        for (const ref of strings(payload.refs)) refs.add(ref);
        for (const item of strings(payload.failed)) attempted.add(item);
        if (typeof payload.bytes === 'number' && Number.isFinite(payload.bytes)) bytes += payload.bytes;
      }
    }
  }

  /** The list recorded before the card was posted: the first
   * `preserves.proposed` naming it (a later one is never what the owner saw). */
  private proposal(notificationId: string): Proposal | null {
    const event = this.opts.ledger.listEventsAfter(0, { kinds: [EXPIRY_EVENTS.preservesProposed], payload: { key: 'notification_id', equals: notificationId }, order: 'asc', limit: 1 })[0] ?? null;
    const payload = (event?.payload ?? null) as Record<string, unknown> | null;
    if (payload === null || typeof payload['repo_path'] !== 'string' || !Array.isArray(payload['copies']) || !Array.isArray(payload['refs'])) return null;
    return {
      notificationId,
      proposal: Number(payload['proposal'] ?? 0),
      repoPath: payload['repo_path'],
      repoName: String(payload['repo'] ?? ''),
      copies: payload['copies'] as ExpiredCopy[],
      refs: payload['refs'] as ExpiredRef[],
    };
  }

  /** The newest event of a kind for one repository. */
  private latest(kind: string, repoPath: string): EventRecord | null {
    return this.opts.ledger.listEventsAfter(0, { kinds: [kind], payload: { key: 'repo_path', equals: repoPath }, order: 'desc', limit: 1 })[0] ?? null;
  }

  private close(card: NotificationRecord, detail: string): void {
    try {
      this.opts.ledger.resolveOwnerDecision(card.id, detail, OWNER_PROVENANCE);
    } catch (error) {
      if (!(error instanceof NotificationDecisionRefusal)) throw error;
      this.log('warn', 'a saved-work card could not be closed', { notification: card.id, error: error.message });
    }
  }
}

/** A repository's card for one proposal: one per repository and proposal. */
export function preserveExpiryCardId(repoPath: string, repoName: string, proposal: number): string {
  return `worktree-preserve-expiry:${repoName}:${createHash('sha256').update(repoPath).digest('hex').slice(0, 8)}:${String(proposal)}`;
}

/** The FOR YOU card listing a repository's expired saved work. */
export function preserveExpiryCard(id: string, work: ExpiredWork): {
  readonly id: string;
  readonly kind: typeof PRESERVE_EXPIRY_KIND;
  readonly routing: 'needs-owner';
  readonly severity: 'info';
  readonly title: string;
  readonly detail: string;
  readonly decision: NotificationDecision;
} {
  const total = work.copies.reduce((sum, copy) => sum + copy.bytes, 0) + work.refs.reduce((sum, ref) => sum + (ref.bytes ?? 0), 0);
  const counted = `${String(work.copies.length)} preserve cop${work.copies.length === 1 ? 'y' : 'ies'} and ${String(work.refs.length)} snapshot ref${work.refs.length === 1 ? '' : 's'}`;
  const lines = [
    `Saved work in ${work.repoName} (${work.repoPath}) from lanes whose jobs ended at least ${String(PRESERVE_EXPIRY_MS / DAY_MS)} days ago: ${counted}, about ${size(total)}.`,
  ];
  if (work.copies.length > 0) {
    lines.push('', 'Preserve copies (untracked files a release copied out of a lane):');
    for (const copy of work.copies) {
      lines.push(`- ${copy.path} (lane ${copy.lane}, ${size(copy.bytes)}). To copy it back into a checkout: cp -R ${shellWord(`${copy.path}/.`)} ${shellWord(work.repoPath)}`);
    }
  }
  if (work.refs.length > 0) {
    lines.push('', 'Snapshot refs (tracked edits a release saved before it removed a lane):');
    for (const ref of work.refs) {
      lines.push(`- ${ref.ref} at ${ref.sha.slice(0, 12)} (lane ${ref.lane}, ${ref.bytes === null ? 'size unknown' : size(ref.bytes)}). To apply it: git -C ${shellWord(work.repoPath)} cherry-pick --no-commit ${shellWord(ref.ref)}`);
    }
  }
  lines.push('', `Accept deletes exactly these and nothing else (a ref only while it still names the listed commit; git frees its objects at its next gc). Decline keeps them, and GC asks again in ${String(PRESERVE_REPROPOSE_MS / DAY_MS)} days.`);
  return {
    id,
    kind: PRESERVE_EXPIRY_KIND,
    routing: 'needs-owner',
    severity: 'info',
    title: `Delete saved work of finished jobs in ${work.repoName}`,
    detail: lines.join('\n'),
    decision: parseNotificationDecision({
      question: `Delete the ${counted} GC kept from finished jobs in ${work.repoName}?`,
      context: `They hold minion work saved when lanes were released, from jobs that ended at least ${String(PRESERVE_EXPIRY_MS / DAY_MS)} days ago (about ${size(total)}). The details list each one and how to restore it.`,
      recommendation: null,
      reservedClass: 'destructive',
      whyNotDelegable: 'Deleting saved work loses it for good, and anything that loses data stays the owner\'s call (owner ruling 2026-10-16).',
      options: [
        { id: 'accept', label: 'Accept: delete them', consequence: 'GC deletes exactly what this card lists and nothing else.' },
        { id: 'decline', label: 'Decline: keep them', consequence: `Nothing is deleted. GC asks again in ${String(PRESERVE_REPROPOSE_MS / DAY_MS)} days.` },
      ],
      discussion: false,
    }),
  };
}

/** The real folders in a real directory (never a link, nor one reached
 * through a link), sorted; none when it is not one or cannot be read. */
function folders(dir: string): string[] {
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.filter((name) => {
    try {
      return lstatSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Whether `path` lies strictly inside `root`, by its spelling and path
 * segment (`<root>/..x` lies inside, `<root>-2` does not). */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** A folder's names, sorted; none when it cannot be read. */
function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The entries of an expired round folder to delete: all but the kept
 * files, each kept only as a regular file (a link or folder of that name
 * goes). */
function expiredEntries(folder: string, keepFiles: readonly string[]): string[] {
  return readdirOrEmpty(folder).filter((name) => {
    if (!keepFiles.includes(name)) return true;
    try {
      return !lstatSync(join(folder, name)).isFile();
    } catch {
      return false;
    }
  });
}

/** Whether `path` is a real folder (not a link) lying inside `root` as the
 * filesystem resolves both, so a delete never follows a link out of it. */
function insideReally(root: string, path: string): boolean {
  try {
    return inside(root, path) && lstatSync(path).isDirectory() && inside(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
}

function git(repoPath: string, args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const run = spawnSync('git', [...args], { cwd: repoPath, encoding: 'utf-8', env: { ...repositoryGitEnv(false), GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024 });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? (run.error === undefined ? '' : String(run.error)) };
}

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]!}`;
}

/** A word a POSIX shell reads back as itself. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`;
}

/** Start the moved-repository follow-through and expiry after the service
 * listens: off the heist path, so a failure to start is loud, never fatal. */
export function startExpiry(parts: { readonly expiry: Pick<ExpiryService, 'start'>; readonly repoMoves: { start(): void } }, log: Log): void {
  try {
    parts.repoMoves.start();
    parts.expiry.start();
  } catch (error) {
    log('error', 'expiry failed to start', { error: String(error) });
  }
}
