import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SilasConfig } from '../config.js';
import type { EventBus } from '../events/bus.js';
import type { AgentRecord, EventRecord, JobRecord, LedgerApi, RoundRecord } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { AgentHandle, SpawnOptions } from '../runtime/types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Silas ops driver (EPICS E8 follow-through; owner ruling 2026-09-21).
 *
 * Silas is the hosted ops session (supervised slot `silas-ops`, the
 * gru-main / bob-consolidator pattern). This module is his watchtower and
 * alarm clock — never his hand:
 *
 * - It watches the ledger event bus (job delivered, minion error, round
 *   verdict) and wakes the silas slot on the events that matter.
 * - A config-driven periodic sweep computes a compact digest of actionable
 *   states (delivered without PR; PR awaiting an up-to-date review round;
 *   a NEEDS CHANGES verdict awaiting follow-through, with same-blocker
 *   recurrence analysis; working lanes whose minion has gone idle) and
 *   wakes Silas only when the digest is non-empty.
 * - Concurrency follows the decisions runtime's one-slot replay: a trigger
 *   arriving mid-turn is never dropped and never stacks — only the LATEST
 *   queued trigger runs after the open turn settles.
 * - Silas acts through the service's own authenticated ops surface
 *   (`/api/silas/*` plus the dispatch pr/review endpoints); this driver
 *   performs no actions itself. The wake prompt carries the operating
 *   skills (`resources/silas-skills/`) — the files are the in-repo source,
 *   injection is the delivery mechanism, so a clean install needs nothing
 *   else on disk.
 *
 * There is NO hard round cap: while blockers evolve, the loop continues.
 * Only the recurrence ladder below intervenes, and escalation — never an
 * endless loop — is the terminal rung.
 */

// ------------------------------------------------------------------
// Recurrence policy (pure, pinned by tests)
// ------------------------------------------------------------------

/** One review finding as the digest consumes it (the blocker subset of a
 * consolidated Perkins report; the fallback gate's findings share shape). */
export interface RoundBlocker {
  readonly category: string;
  readonly title: string;
  readonly location: string;
}

export type RecurrenceAdvice = 'monitor' | 'directive' | 'rebrief' | 'escalate';

/**
 * Canonical blocker identity: the same defect resurfaces across review
 * rounds with reworded prose, so the fingerprint normalizes the finding's
 * category, location, and title (case and whitespace collapsed). Evidence
 * is deliberately excluded — it changes every round.
 */
export function blockerFingerprint(blocker: RoundBlocker): string {
  const norm = (value: string): string => value.toLowerCase().replace(/\s+/gu, ' ').trim();
  return [norm(blocker.category), norm(blocker.location), norm(blocker.title)].join('::');
}

/**
 * How many CONSECUTIVE verdict rounds (newest first) contain this exact
 * blocker fingerprint. A blocker absent from any round breaks the streak —
 * which is the ruling's "evolving blockers keep looping": a new or changed
 * blocker counts from one again and the loop continues unbounded.
 */
export function consecutiveRecurrence(fingerprint: string, roundsNewestFirst: readonly (readonly RoundBlocker[])[]): number {
  let count = 0;
  for (const round of roundsNewestFirst) {
    if (round.some((blocker) => blockerFingerprint(blocker) === fingerprint)) count += 1;
    else break;
  }
  return count;
}

/**
 * One rung of the recurrence ladder (owner ruling, defaults 2/3/4):
 * same canonical blocker twice → fix directive; third → re-brief a fresh
 * minion; fourth → escalation. Advisory-deterministic: the digest names
 * the rung, Silas executes it through the ops surface.
 */
export function adviseRecurrence(
  consecutiveRounds: number,
  thresholds: Pick<SilasConfig, 'directiveAt' | 'rebriefAt' | 'escalateAt'>,
): RecurrenceAdvice {
  if (consecutiveRounds >= thresholds.escalateAt) return 'escalate';
  if (consecutiveRounds >= thresholds.rebriefAt) return 'rebrief';
  if (consecutiveRounds >= thresholds.directiveAt) return 'directive';
  return 'monitor';
}

// ------------------------------------------------------------------
// Digest (the four actionable states)
// ------------------------------------------------------------------

/** Ledger surface the digest reads (the real LedgerApi satisfies it). */
export interface DigestLedger {
  listJobs(): readonly JobRecord[];
  getJob(id: string): JobRecord | null;
  listRounds(jobId: string): readonly RoundRecord[];
  listJobEvents(jobId: string, opts?: { limit?: number }): readonly EventRecord[];
  latestJobEvent(jobId: string, kind: string): EventRecord | null;
  latestRoundEvent(roundId: string, kind: string): EventRecord | null;
  listAgents(): readonly AgentRecord[];
}

/** Blockers of one round, with an explicit loud note instead of a silent
 * empty when the consolidated report cannot be read. */
export interface RoundBlockersResult {
  readonly blockers: readonly RoundBlocker[];
  readonly note: string | null;
}

export type BlockersForRound = (roundId: string) => Promise<RoundBlockersResult>;

/**
 * Default blockers port: read the round's consolidated Perkins report via
 * the artifact directory its `round.perkins-review` event recorded. A
 * missing/unreadable report is loud IN the digest, never a throw — one
 * damaged artifact must not blind the whole sweep.
 */
export function consolidatedBlockersFor(ledger: DigestLedger): BlockersForRound {
  return (roundId: string): Promise<RoundBlockersResult> => {
    try {
      const event = ledger.latestRoundEvent(roundId, 'round.perkins-review');
      const directory =
        typeof event?.payload === 'object' && event.payload !== null
          ? (event.payload as { artifactDirectory?: unknown }).artifactDirectory
          : undefined;
      if (typeof directory !== 'string' || directory === '') {
        return Promise.resolve({ blockers: [], note: 'no consolidated report recorded for this round' });
      }
      const file = join(directory, 'consolidated.json');
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { findings?: unknown };
      if (!Array.isArray(parsed.findings)) {
        return Promise.resolve({ blockers: [], note: `consolidated report ${file} has no findings array` });
      }
      const blockers = (parsed.findings as unknown[])
        .map((finding) => finding as Partial<RoundBlocker> & { severity?: unknown })
        .filter((finding) => finding.severity === 'blocker')
        .map((finding) => ({
          category: String(finding.category ?? ''),
          title: String(finding.title ?? ''),
          location: String(finding.location ?? ''),
        }));
      return Promise.resolve({ blockers, note: null });
    } catch (error) {
      return Promise.resolve({ blockers: [], note: `blockers unavailable: ${String(error).slice(0, 200)}` });
    }
  };
}

export interface DigestRecurringBlocker extends RoundBlocker {
  readonly fingerprint: string;
  readonly consecutiveRounds: number;
  readonly advice: RecurrenceAdvice;
}

export interface DeliveredWithoutPrRow {
  readonly jobId: string;
  readonly repo: string;
  readonly branch: string | null;
  readonly lanePath: string | null;
  readonly minionSessionFile: string | null;
  readonly deliveredAt: string | null;
}

export interface PrWithoutReviewRow {
  readonly jobId: string;
  readonly repo: string;
  readonly prUrl: string;
  readonly priorRounds: number;
}

export interface VerdictAwaitingDirectiveRow {
  readonly jobId: string;
  readonly repo: string;
  readonly roundId: string;
  readonly roundSeq: number;
  readonly verdict: string;
  readonly blockerCount: number;
  readonly blockersNote: string | null;
  readonly recurringBlockers: readonly DigestRecurringBlocker[];
}

export interface StalledWorkingRow {
  readonly jobId: string;
  readonly repo: string;
  readonly minionId: string | null;
  readonly minionState: string | null;
  readonly lastActivity: string | null;
  readonly idleMs: number;
}

export interface MinionErrorRow {
  readonly jobId: string;
  readonly repo: string;
  readonly error: string;
  readonly at: string | null;
}

export interface SilasOpsDigest {
  readonly computedAt: string;
  readonly trigger: string;
  readonly deliveredWithoutPr: readonly DeliveredWithoutPrRow[];
  readonly prWithoutReview: readonly PrWithoutReviewRow[];
  readonly verdictsAwaitingDirective: readonly VerdictAwaitingDirectiveRow[];
  readonly stalledWorking: readonly StalledWorkingRow[];
  readonly minionErrors: readonly MinionErrorRow[];
}

/** Count of actionable rows (event triggers wake even at zero; sweeps do not). */
export function digestActionCount(digest: SilasOpsDigest): number {
  return (
    digest.deliveredWithoutPr.length +
    digest.prWithoutReview.length +
    digest.verdictsAwaitingDirective.length +
    digest.stalledWorking.length +
    digest.minionErrors.length
  );
}

/** Job lane record as the digest needs it (registry worktree shape). */
interface DigestLane {
  readonly kind: 'job' | 'review';
  readonly status: 'active' | 'paused' | 'swept';
  readonly path: string;
  readonly branch: string | null;
}

export interface WorktreeListPort {
  listWorktrees(scope?: { jobId?: string }): readonly DigestLane[];
}

export interface ComputeDigestInput {
  readonly ledger: DigestLedger;
  readonly worktrees?: WorktreeListPort;
  readonly blockersForRound: BlockersForRound;
  readonly config: Pick<SilasConfig, 'stallThresholdMs' | 'directiveAt' | 'rebriefAt' | 'escalateAt'>;
  readonly trigger: string;
  readonly now?: () => number;
}

/**
 * The compact digest of actionable ops states, computed from the ledger
 * alone (the ledger is the record; no runtime or filesystem probing beyond
 * the consolidated-report port):
 *
 * 1. deliveredWithoutPr — job delivered (completion turn settled) but no
 *    PR registered and no review round yet: find and register the PR.
 * 2. prWithoutReview — PR registered and the newest delivery is newer than
 *    the newest review round (or no round at all): request the wave. This
 *    is both the first review and the re-review after a fix round.
 * 3. verdictsAwaitingDirective — the newest round recorded NEEDS CHANGES
 *    and no silas follow-through has landed since that verdict: deliver the
 *    ladder's rung (directive → re-brief → escalate) for recurring blockers.
 * 4. stalledWorking — job working with no delivery while its minion has
 *    shown no activity past the stall threshold: assess the lane.
 *
 * plus minionErrors — a minion turn that failed more recently than any
 * delivery — so an error wake always carries its context.
 */
export async function computeSilasDigest(input: ComputeDigestInput): Promise<SilasOpsDigest> {
  const now = input.now ?? Date.now;
  const digest: {
    computedAt: string;
    trigger: string;
    deliveredWithoutPr: DeliveredWithoutPrRow[];
    prWithoutReview: PrWithoutReviewRow[];
    verdictsAwaitingDirective: VerdictAwaitingDirectiveRow[];
    stalledWorking: StalledWorkingRow[];
    minionErrors: MinionErrorRow[];
  } = {
    computedAt: new Date(now()).toISOString(),
    trigger: input.trigger,
    deliveredWithoutPr: [],
    prWithoutReview: [],
    verdictsAwaitingDirective: [],
    stalledWorking: [],
    minionErrors: [],
  };
  for (const job of input.ledger.listJobs()) {
    if (job.status === 'merged' || job.status === 'done') continue;
    const rounds = [...input.ledger.listRounds(job.id)].sort((a, b) => b.seq - a.seq);
    const newestRound = rounds[0] ?? null;
    const delivered = input.ledger.latestJobEvent(job.id, 'job.delivered');
    const minionError = input.ledger.latestJobEvent(job.id, 'job.minion-error');

    // (1) Delivered, no PR yet.
    if (delivered !== null && job.prUrl === null && rounds.length === 0) {
      const lane = (input.worktrees?.listWorktrees({ jobId: job.id }) ?? []).find((candidate) => candidate.kind === 'job');
      const minion = input.ledger
        .listAgents()
        .filter((agent) => agent.jobId === job.id && agent.role === 'minion')
        .sort((a, b) => (b.lastActivity ?? b.createdAt).localeCompare(a.lastActivity ?? a.createdAt))[0];
      digest.deliveredWithoutPr.push({
        jobId: job.id,
        repo: job.repo,
        branch: lane?.branch ?? null,
        lanePath: lane?.path ?? null,
        minionSessionFile: minion?.sessionFile ?? null,
        deliveredAt: delivered.ts,
      });
    }

    // (2) PR registered, review overdue (first or re-review).
    if (job.prUrl !== null && job.status === 'working' && newestRound === null) {
      digest.prWithoutReview.push({ jobId: job.id, repo: job.repo, prUrl: job.prUrl, priorRounds: 0 });
    } else if (
      job.prUrl !== null &&
      job.status === 'working' &&
      newestRound !== null &&
      delivered !== null &&
      delivered.seq > newestRound.seq
    ) {
      digest.prWithoutReview.push({
        jobId: job.id,
        repo: job.repo,
        prUrl: job.prUrl,
        priorRounds: rounds.length,
      });
    }

    // (3) NEEDS CHANGES verdict awaiting follow-through.
    if (
      newestRound !== null &&
      newestRound.verdict === 'changes-requested' &&
      newestRound.status === 'verdict-posted' &&
      job.status === 'in-review'
    ) {
      const verdictEvent = input.ledger.latestJobEvent(job.id, 'round.verdict');
      const handled = input.ledger
        .listJobEvents(job.id, { limit: 50 })
        .filter((event) => event.kind === 'silas.directive-sent' || event.kind === 'silas.rebrief' || event.kind === 'silas.escalated');
      // Only hand the verdict over when no silas rung has landed after it —
      // a directive whose turn is still running must not re-fire per sweep.
      const alreadyHandled = handled.some((event) => verdictEvent === null || event.seq > verdictEvent.seq);
      if (!alreadyHandled) {
        const verdictRounds = rounds.filter((round) => round.verdict === 'changes-requested');
        const blockerHistory: (readonly RoundBlocker[])[] = [];
        let blockersNote: string | null = null;
        for (const round of verdictRounds) {
          const result = await input.blockersForRound(round.id);
          blockerHistory.push(result.blockers);
          if (result.note !== null && round.id === newestRound.id) blockersNote = result.note;
        }
        // verdictRounds preserves the newest-first order of `rounds`, so the
        // first history entry IS the verdict awaiting follow-through.
        const latest = blockerHistory[0] ?? [];
        const seen = new Map<string, DigestRecurringBlocker>();
        for (const blocker of latest) {
          const fingerprint = blockerFingerprint(blocker);
          if (seen.has(fingerprint)) continue;
          const consecutiveRounds = consecutiveRecurrence(fingerprint, blockerHistory);
          seen.set(fingerprint, {
            ...blocker,
            fingerprint,
            consecutiveRounds,
            advice: adviseRecurrence(consecutiveRounds, input.config),
          });
        }
        digest.verdictsAwaitingDirective.push({
          jobId: job.id,
          repo: job.repo,
          roundId: newestRound.id,
          roundSeq: newestRound.seq,
          verdict: newestRound.verdict,
          blockerCount: latest.length,
          blockersNote,
          recurringBlockers: [...seen.values()],
        });
      }
    }

    // (4) Stalled lane: working with no delivery, minion gone quiet.
    if (job.status === 'working' && delivered === null) {
      const minion = input.ledger
        .listAgents()
        .filter((agent) => agent.jobId === job.id && agent.role === 'minion')
        .sort((a, b) => (b.lastActivity ?? b.createdAt).localeCompare(a.lastActivity ?? a.createdAt))[0];
      if (minion !== undefined) {
        const lastMs = Date.parse(minion.lastActivity ?? minion.createdAt);
        if (Number.isFinite(lastMs) && now() - lastMs >= input.config.stallThresholdMs) {
          digest.stalledWorking.push({
            jobId: job.id,
            repo: job.repo,
            minionId: minion.id,
            minionState: minion.state,
            lastActivity: minion.lastActivity,
            idleMs: now() - lastMs,
          });
        }
      }
    }

    // Context: a minion error more recent than any delivery.
    if (minionError !== null && (delivered === null || minionError.seq > delivered.seq)) {
      digest.minionErrors.push({
        jobId: job.id,
        repo: job.repo,
        error: String((minionError.payload as { error?: unknown })?.error ?? 'unknown error').slice(0, 300),
        at: minionError.ts,
      });
    }
  }
  return digest;
}

// ------------------------------------------------------------------
// Skills (in-repo source, driver-injected delivery)
// ------------------------------------------------------------------

export interface SkillModule {
  readonly name: string;
  readonly body: string;
}

/** `<package>/resources/silas-skills/` — src/ and dist/ both sit two levels
 * below the package root, so one relative path serves dev and built layouts. */
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'silas-skills');

export const SILAS_SKILL_NAMES = ['ops-dispatch', 'ledger-closeout'] as const;

/**
 * Load the silas operating skills from the shipped resources. Fail loud:
 * the wake prompt is the delivery mechanism, so a missing skill is a
 * broken install, not a silently smaller prompt.
 */
export function loadSilasSkills(
  names: readonly string[] = SILAS_SKILL_NAMES,
  skillsDir: string = SKILLS_DIR,
): readonly SkillModule[] {
  return names.map((name) => {
    const file = join(skillsDir, name, 'SKILL.md');
    let body: string;
    try {
      body = readFileSync(file, 'utf-8');
    } catch (error) {
      throw new Error(
        `silas skill "${name}" is unreadable at ${file} (${String(error)}); ` +
          'the product ships its ops skills under resources/silas-skills — restore them before hosting silas',
      );
    }
    const trimmed = body.trim();
    if (trimmed === '') {
      throw new Error(`silas skill "${name}" at ${file} is empty — the skill needs its instructions`);
    }
    return { name, body: trimmed };
  });
}

// ------------------------------------------------------------------
// The driver
// ------------------------------------------------------------------

/** The supervised-slot surface the driver needs (as bob-scheduler). */
export interface SilasSlot {
  ensure(options?: SpawnOptions): Promise<AgentHandle>;
}

export type SilasTriggerKind = 'job.delivered' | 'job.minion-error' | 'round.verdict' | 'sweep';

export interface SilasTrigger {
  readonly kind: SilasTriggerKind;
  readonly jobId?: string;
}

export interface SilasDriverOptions {
  readonly slot: SilasSlot;
  readonly ledger: DigestLedger & Pick<LedgerApi, 'appendCustomEvent'>;
  readonly worktrees?: WorktreeListPort;
  readonly config: SilasConfig;
  /** The ops surface Silas acts through: base URL + where the pairing token lives. */
  readonly ops: { readonly baseUrl: string; readonly configPath: string };
  readonly bus?: EventBus;
  /** Operating skills injected into every wake prompt (default: shipped resources). */
  readonly skills?: readonly SkillModule[];
  readonly blockersForRound?: BlockersForRound;
  readonly log?: Log;
  /** Clock + timer seams for tests. */
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly now?: () => number;
}

const SILAS_WAKE_EVENTS: readonly string[] = ['job.delivered', 'job.minion-error', 'round.verdict'];

export class SilasDriver {
  private readonly opts: SilasDriverOptions;
  private readonly log: Log;
  private readonly skills: readonly SkillModule[];
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeInFlight: Promise<void> | null = null;
  private queuedTrigger: SilasTrigger | null = null;
  private disposed = false;

  constructor(opts: SilasDriverOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.skills = opts.skills ?? loadSilasSkills();
    this.now = opts.now ?? Date.now;
    this.setIntervalImpl = opts.setInterval ?? setInterval;
    this.clearIntervalImpl = opts.clearInterval ?? clearInterval;
    if (opts.bus !== undefined) {
      this.unsubscribe = opts.bus.subscribe((event) => {
        if (!SILAS_WAKE_EVENTS.includes(event.kind)) return;
        void this.trigger({ kind: event.kind as SilasTriggerKind, jobId: event.jobId ?? undefined });
      });
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Start the periodic sweep (event wakes are live from construction). */
  start(): void {
    if (!this.opts.config.enabled) {
      this.log('info', 'silas ops driver disabled by config — no slot wakes', {});
      return;
    }
    if (this.timer !== null) return;
    if (this.opts.config.sweepIntervalMs <= 0) {
      this.log('info', 'silas sweep disabled (interval 0); event wakes stay live', {});
      return;
    }
    this.timer = this.setIntervalImpl(() => {
      void this.trigger({ kind: 'sweep' });
    }, this.opts.config.sweepIntervalMs);
    this.timer.unref?.();
    this.log('info', 'silas ops driver started', { sweepIntervalMs: this.opts.config.sweepIntervalMs });
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.disposed = true;
  }

  /**
   * One wake attempt. Never overlapping: a trigger arriving while a turn
   * is open queues ONE slot (latest wins — the next digest supersedes the
   * stale one) and runs after the open turn settles. A failed wake is
   * logged loud; the next sweep or event retries it.
   */
  async trigger(trigger: SilasTrigger): Promise<void> {
    if (this.disposed) return;
    if (!this.opts.config.enabled) return;
    if (this.wakeInFlight !== null) {
      this.queuedTrigger = trigger;
      return;
    }
    const run = this.runWake(trigger);
    this.wakeInFlight = run;
    try {
      await run;
    } finally {
      this.wakeInFlight = null;
      const queued = this.queuedTrigger;
      this.queuedTrigger = null;
      if (queued !== null && !this.disposed) {
        void this.trigger(queued).catch(() => {});
      }
    }
  }

  /** Compute the digest; wake the slot only when there is something to do
   * (sweeps skip empty digests; event wakes always deliver — the event
   * itself is context Silas should see). */
  private async runWake(trigger: SilasTrigger): Promise<void> {
    let digest: SilasOpsDigest;
    try {
      digest = await computeSilasDigest({
        ledger: this.opts.ledger,
        ...(this.opts.worktrees !== undefined ? { worktrees: this.opts.worktrees } : {}),
        blockersForRound: this.opts.blockersForRound ?? consolidatedBlockersFor(this.opts.ledger),
        config: this.opts.config,
        trigger: trigger.kind,
        now: this.now,
      });
    } catch (error) {
      this.log('error', 'silas digest computation failed', { trigger: trigger.kind, error: String(error) });
      return;
    }
    const actionable = digestActionCount(digest);
    if (trigger.kind === 'sweep' && actionable === 0) {
      this.log('info', 'silas sweep found nothing actionable', {});
      return;
    }
    try {
      this.opts.ledger.appendCustomEvent({
        kind: 'silas.wake',
        ...(trigger.jobId !== undefined ? { jobId: trigger.jobId } : {}),
        payload: { trigger: trigger.kind, actionable },
      });
    } catch (error) {
      this.log('error', 'silas wake event could not be persisted', { error: String(error) });
    }
    const prompt = buildWakePrompt({
      digest,
      trigger,
      skills: this.skills,
      ops: this.opts.ops,
    });
    try {
      const handle = await this.opts.slot.ensure();
      await handle.prompt(prompt, { owner: 'silas-driver' });
      this.log('info', 'silas wake delivered', { trigger: trigger.kind, actionable });
    } catch (error) {
      // A failed wake must never take the service down (unhandled
      // rejections are fatal in main): log loud; the next sweep or event
      // retries, and the digest recomputes from the ledger anyway.
      this.log('error', 'silas wake failed', { trigger: trigger.kind, error: String(error) });
    }
  }
}

// ------------------------------------------------------------------
// Wake prompt (the skills' delivery vehicle)
// ------------------------------------------------------------------

export function buildWakePrompt(input: {
  digest: SilasOpsDigest;
  trigger: SilasTrigger;
  skills: readonly SkillModule[];
  ops: { readonly baseUrl: string; readonly configPath: string };
}): string {
  const digestJson = JSON.stringify(input.digest, null, 2);
  return [
    `Silas ops wake — trigger: ${input.trigger.kind}${input.trigger.jobId !== undefined ? ` (job ${input.trigger.jobId})` : ''}`,
    '',
    'You are the operations layer. The digest below lists every lane awaiting',
    'ops follow-through, computed from the ledger moments ago. Work inside',
    'your authority: dispatch, track, close. Never write product code; never',
    'merge (Perkins owns verdict authority; the human holds the merge);',
    'preserve before remove; escalate to the chief with pointers, not prose.',
    'Never act on the Gru chat session itself.',
    '',
    '## Ops surface',
    '',
    `The service API is at ${input.ops.baseUrl}. Authenticate EVERY call with`,
    `the pairing token stored in ${input.ops.configPath} (the [auth] token).`,
    'Read it WITHOUT echoing it, for example:',
    '',
    '  TOKEN=$(sed -n \'s/^token = "\\(.*\\)"/\\1/p\' ' + input.ops.configPath + ')',
    '  curl -sf -X POST ' + input.ops.baseUrl + '/api/dispatch/pr \\',
    '    -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\',
    '    -d \'{"job_id":"...","url":"...","by":"silas"}\'',
    '',
    'A 401 means re-read the token. A 4xx carries a detail message — fix the',
    'request, never retry blind. Pass "by":"silas" so the ledger records the',
    'action as yours.',
    '',
    '## Operating skills',
    '',
    ...input.skills.flatMap((skill) => [`### skill: ${skill.name}`, '', skill.body, '']),
    '## Digest (actionable states, JSON)',
    '',
    '```json',
    digestJson,
    '```',
    '',
    '## Recurrence policy (the ladder — no hard round cap)',
    '',
    'While blockers evolve, the loop continues: fix rounds re-enter review',
    'without limit. When the SAME canonical blocker (same fingerprint) recurs',
    'across consecutive verdict rounds, follow the advice named per blocker:',
    'directive → re-brief a fresh minion → escalate. Escalation always beats',
    'an endless loop.',
    '',
    'Reply with a short completion note: what you did per lane, or why you',
    'left it untouched.',
  ].join('\n');
}
