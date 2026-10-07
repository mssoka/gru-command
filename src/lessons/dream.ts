import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { BiblePlan, BibleStore } from './bible.js';
import { DreamError, ProposalError, type JournalEntry, type ProposedChapter } from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The dream pass: journal → bible. Mechanics only — the judgment (what is
 * one lesson, what merges, how to word it) belongs to the distiller (Bob).
 *
 * Invariants this layer guarantees regardless of distiller behavior:
 *   - the owner approves every book update: a pass PROPOSES (For You) and
 *     nothing is written until Accept; Reject consumes the batch without
 *     writing (owner decision 2026-10-07);
 *   - the cursor advances ONLY on an owner decision (or, in tests, a
 *     successful apply) — a failed dream retries the same entries next
 *     cycle, never a silent skip;
 *   - a bounded batch per pass (entries beyond the bound wait for the
 *     next pass rather than bloating the prompt);
 *   - invented provenance is a hard error (the distiller may only cite
 *     journal ids it was given);
 *   - one pass in flight at a time (the scheduler skips overlapping beats).
 */

export const DREAM_STATE_FILE = '.dream-state.json';
/** Incident kind raised while dream passes keep failing. */
export const DREAM_FAILED_KIND = 'lessons.dream-failed';
export const DEFAULT_MAX_ENTRIES_PER_DREAM = 100;

export interface DreamState {
  readonly version: 1;
  /** Journal high-water mark through which the last dream consumed. */
  readonly coveredThroughSeq: number;
  readonly lastDreamAt: string | null;
  readonly cycles: number;
}

/** POSIX single-quoted shell word. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/gu, `'\\''`)}'`;
}

/** The exact command that rebuilds a damaged book's provenance for THIS
 * instance — its GRU_COMMAND_HOME, Node and data dir — pasteable from any
 * shell, including a launchd service's non-default instance. */
export function repairCommand(input: {
  readonly nodePath: string;
  readonly toolPath: string;
  readonly instanceDir: string;
  readonly dataDir: string;
}): string {
  return `GRU_COMMAND_HOME=${shellQuote(input.instanceDir)} ${shellQuote(input.nodePath)} ` +
    `${shellQuote(input.toolPath)} ${shellQuote(input.dataDir)}`;
}

/** The notification surface a failing dream reports through
 * (NotificationCenter in production). */
export interface DreamIncidentPort {
  postIncident(input: {
    kind: string;
    routing: 'action-required';
    severity: 'error';
    title: string;
    detail: string;
    dedupe: 'active';
  }): { readonly id: string; readonly detail: string | null };
  updateDetail(id: string, detail: string): unknown;
  resolveIncidents(kindPrefix: string, by: string): unknown;
}

const FIRST_FAILURE = /^First failure \(([^)]*)\): (.*)$/mu;
const LATEST_FAILURE = /^Latest failure \([^)]*, failed pass (\d+)\): /mu;

/** Production wiring for DreamScheduler's hooks: a failing dream is ONE
 * open action-required incident per failure streak (it failed every pass
 * for days unnoticed — owner incident 2026-10-07). Its detail keeps the
 * FIRST failure (when the streak began) and refreshes the LATEST one on
 * every failed pass (owner decision 2026-10-07), with the repair command;
 * the next completed pass resolves it. */
export function dreamFailureIncidents(
  port: DreamIncidentPort,
  command: string,
  now: () => Date = () => new Date(),
): { onFailure(error: unknown): void; onSuccess(): void } {
  const oneLine = (error: unknown) => String(error).replace(/\s*\n\s*/gu, ' ');
  const render = (first: { at: string; error: string }, latest: { at: string; error: string }, pass: number) =>
    `First failure (${first.at}): ${first.error}\n` +
    `Latest failure (${latest.at}, failed pass ${pass}): ${latest.error}\n\n` +
    "The journal cursor is unchanged; the next beat retries. If a chapter's provenance is malformed, rebuild it " +
    `from the journal (dry run first, then add --write):\n${command}`;
  return {
    onFailure: (error) => {
      const latest = { at: now().toISOString(), error: oneLine(error) };
      const fresh = render(latest, latest, 1);
      const row = port.postIncident({
        kind: DREAM_FAILED_KIND,
        routing: 'action-required',
        severity: 'error',
        title: 'Lesson dream is failing — the Book of Lessons is not being updated',
        detail: fresh,
        dedupe: 'active',
      });
      if (row.detail === fresh) return; // a new streak
      const first = FIRST_FAILURE.exec(row.detail ?? '');
      const pass = Number(LATEST_FAILURE.exec(row.detail ?? '')?.[1] ?? '1') + 1;
      port.updateDetail(
        row.id,
        render(first === null ? latest : { at: first[1]!, error: first[2]! }, latest, pass),
      );
    },
    onSuccess: () => {
      port.resolveIncidents(DREAM_FAILED_KIND, 'dream');
    },
  };
}

export interface DistillInput {
  readonly entries: readonly JournalEntry[];
  /** Current INDEX.md text (null before the first seed). */
  readonly index: string | null;
  readonly bibleDir: string;
  readonly chapterCapBytes: number;
  readonly indexCapBytes: number;
}

export interface DistillResult {
  readonly chapters: readonly ProposedChapter[];
}

/** The judgment port: production = Bob via the supervised slot; tests use
 * deterministic fakes. */
export interface DreamDistiller {
  distill(input: DistillInput): Promise<DistillResult>;
}

export interface DreamOutcome {
  /** `proposed`: a book update now waits for the owner in For You;
   * `awaiting-owner`: an earlier proposal is still undecided, so this pass
   * did nothing (no distiller call, no model cost). */
  readonly status: 'noop' | 'dreamed' | 'proposed' | 'awaiting-owner';
  readonly entries: number;
  readonly coveredThroughSeq: number;
  readonly chaptersTouched: number;
  readonly lessonsAdded: number;
  readonly lessonsMerged: number;
  readonly lessonsTrimmed: number;
  readonly lessonsDropped: number;
}

export interface DreamEngineOptions {
  readonly journal: {
    list(options?: { after?: number; limit?: number }): readonly JournalEntry[];
  };
  readonly bible: BibleStore;
  readonly distiller: DreamDistiller;
  /** Owner approval (the service's path): every pass proposes, nothing is
   * written until the owner accepts in For You (owner decision 2026-10-07). */
  readonly proposals?: LessonProposals;
  /** Write each pass directly — tests of the dream mechanics only. Exactly
   * one of `proposals` / `autoApply` must be chosen; there is no default. */
  readonly autoApply?: boolean;
  /** Defaults to <bible-dir>/.dream-state.json. */
  readonly stateFile?: string;
  readonly maxEntriesPerDream?: number;
  readonly log?: Log;
  readonly now?: () => Date;
}

export class DreamEngine {
  private readonly journal: DreamEngineOptions['journal'];
  private readonly bible: BibleStore;
  private readonly distiller: DreamDistiller;
  private readonly proposals: LessonProposals | null;
  private readonly stateFile: string;
  private readonly maxEntriesPerDream: number;
  private readonly log: Log;
  private readonly now: () => Date;

  constructor(opts: DreamEngineOptions) {
    if ((opts.proposals === undefined) === (opts.autoApply !== true)) {
      throw new DreamError(
        'dream engine needs exactly one write path: proposals (owner approval) or autoApply: true (tests)',
      );
    }
    this.journal = opts.journal;
    this.bible = opts.bible;
    this.distiller = opts.distiller;
    this.proposals = opts.proposals ?? null;
    this.stateFile = opts.stateFile ?? join(opts.bible.dir, DREAM_STATE_FILE);
    this.maxEntriesPerDream = opts.maxEntriesPerDream ?? DEFAULT_MAX_ENTRIES_PER_DREAM;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  /** One dream pass. No new entries = no distiller call = no model cost. */
  async run(): Promise<DreamOutcome> {
    this.bible.ensureSeeded();
    const state = loadDreamState(this.stateFile);
    const idle = (status: 'noop' | 'awaiting-owner'): DreamOutcome => ({
      status,
      entries: 0,
      coveredThroughSeq: state.coveredThroughSeq,
      chaptersTouched: 0,
      lessonsAdded: 0,
      lessonsMerged: 0,
      lessonsTrimmed: 0,
      lessonsDropped: 0,
    });
    if (this.proposals !== null) {
      const waiting = this.proposals.pending();
      if (waiting !== null) {
        // Re-announce a proposal whose notification never landed (a crash
        // between writing it and posting) — never a second proposal.
        this.proposals.ensureAnnounced(waiting);
        this.log('info', 'dream beat skipped — a lesson proposal awaits the owner', { proposal_id: waiting.id });
        return idle('awaiting-owner');
      }
    }
    const pending = this.journal.list({ after: state.coveredThroughSeq, limit: this.maxEntriesPerDream });
    if (pending.length === 0) return idle('noop');
    const index = this.bible.readIndexText();
    const result = await this.distiller.distill({
      entries: pending,
      index,
      bibleDir: this.bible.dir,
      chapterCapBytes: this.bible.chapterCapBytes,
      indexCapBytes: this.bible.indexCapBytes,
    });

    // Provenance guard: only ids from THIS batch may be cited. The
    // distiller reads entries; anything else is invention.
    const tsById = new Map(pending.map((entry) => [entry.id, entry.ts]));
    for (const chapter of result.chapters) {
      for (const lesson of chapter.lessons) {
        for (const id of lesson.journalIds) {
          if (!tsById.has(id)) {
            throw new DreamError(
              `distiller cited journal id ${id} (chapter ${chapter.slug}, lesson ${lesson.slug}) but it is not part of this dream batch`,
            );
          }
        }
      }
    }

    const plan = this.bible.planUpdates(result.chapters, tsById);
    const last = pending[pending.length - 1]!;
    const nextState: DreamState = {
      version: 1,
      coveredThroughSeq: last.seq,
      lastDreamAt: this.now().toISOString(),
      cycles: state.cycles + 1,
    };
    const outcome = (status: 'dreamed' | 'proposed'): DreamOutcome => ({
      status,
      entries: pending.length,
      coveredThroughSeq: status === 'dreamed' ? last.seq : state.coveredThroughSeq,
      chaptersTouched: plan.report.chaptersWritten,
      lessonsAdded: plan.report.lessonsAdded,
      lessonsMerged: plan.report.lessonsMerged,
      lessonsTrimmed: plan.report.lessonsTrimmed,
      lessonsDropped: plan.report.lessonsDropped,
    });
    if (this.proposals !== null) {
      const proposal = this.proposals.create({
        plan,
        entries: pending.length,
        fromCursor: state.coveredThroughSeq,
        nextState,
      });
      this.log('info', 'dream pass proposed — awaiting the owner in For You', {
        proposal_id: proposal.id,
        entries: pending.length,
        through_seq: last.seq,
        chapters_touched: plan.report.chaptersWritten,
        lessons_added: plan.report.lessonsAdded,
        lessons_merged: plan.report.lessonsMerged,
      });
      return outcome('proposed');
    }

    const report = this.bible.applyPlan(plan);
    saveDreamState(this.stateFile, nextState);
    this.log('info', 'dream pass completed', {
      entries: pending.length,
      covered_through_seq: last.seq,
      chapters_touched: report.chaptersWritten,
      lessons_added: report.lessonsAdded,
      lessons_merged: report.lessonsMerged,
      lessons_trimmed: report.lessonsTrimmed,
      lessons_dropped: report.lessonsDropped,
    });
    return outcome('dreamed');
  }
}

// ------------------------------------------------------------------
// Owner-approved lesson proposals (owner decision 2026-10-07)
// ------------------------------------------------------------------

export const PROPOSAL_FILE = '.proposal.json';
/** The For You notification kind that carries a lesson proposal. */
export const LESSONS_PROPOSAL_KIND = 'lessons.proposal';

/** A planned book update waiting for the owner. At most one exists; while
 * it waits, the dream does not distill (and spends nothing). */
export interface LessonProposal {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly notificationId: string | null;
  /** Journal entries the proposal was distilled from. */
  readonly entries: number;
  /** The dream cursor the proposal was computed from. */
  readonly fromCursor: number;
  /** The dream state after a decision (Accept or Reject both consume the
   * entries — a rejected batch is never proposed again). */
  readonly nextState: DreamState;
  readonly plan: BiblePlan;
}

/** The owner-facing review of a pending proposal. */
export interface LessonProposalReview {
  readonly id: string;
  readonly createdAt: string;
  readonly notificationId: string | null;
  readonly entries: number;
  readonly throughSeq: number;
  readonly report: BiblePlan['report'];
  readonly chapters: BiblePlan['changes'];
}

export interface LessonProposalDecision {
  readonly id: string;
  readonly decision: 'accepted' | 'rejected';
  readonly coveredThroughSeq: number;
  readonly report: BiblePlan['report'] | null;
}

/** How proposals reach the owner. Production: a needs-owner (For You)
 * notification; resolve closes it; stale posts an FYI. */
export interface ProposalNotifier {
  proposed(input: { readonly title: string; readonly detail: string }): string;
  resolve(notificationId: string, by: string): void;
  stale(input: { readonly title: string; readonly detail: string }): void;
}

export interface LessonProposalsOptions {
  readonly bible: BibleStore;
  readonly notifier: ProposalNotifier;
  /** Defaults to <bible-dir>/.dream-state.json. */
  readonly stateFile?: string;
  readonly log?: Log;
  readonly now?: () => Date;
}

export class LessonProposals {
  private readonly bible: BibleStore;
  private readonly notifier: ProposalNotifier;
  private readonly stateFile: string;
  private readonly file: string;
  private readonly log: Log;
  private readonly now: () => Date;

  constructor(opts: LessonProposalsOptions) {
    this.bible = opts.bible;
    this.notifier = opts.notifier;
    this.stateFile = opts.stateFile ?? join(opts.bible.dir, DREAM_STATE_FILE);
    this.file = join(opts.bible.dir, PROPOSAL_FILE);
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  /** The pending proposal, or null. A corrupt file fails loud. */
  pending(): LessonProposal | null {
    if (!existsSync(this.file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch (error) {
      throw new DreamError(`lesson proposal ${this.file} is unreadable (${String(error)}) — inspect or remove it`);
    }
    if (!isLessonProposal(parsed)) {
      throw new DreamError(`lesson proposal ${this.file} is malformed — inspect or remove it`);
    }
    return parsed;
  }

  review(): LessonProposalReview | null {
    const proposal = this.pending();
    if (proposal === null) return null;
    return {
      id: proposal.id,
      createdAt: proposal.createdAt,
      notificationId: proposal.notificationId,
      entries: proposal.entries,
      throughSeq: proposal.nextState.coveredThroughSeq,
      report: proposal.plan.report,
      chapters: proposal.plan.changes,
    };
  }

  /** Persist a new proposal, then put it in front of the owner. */
  create(input: {
    readonly plan: BiblePlan;
    readonly entries: number;
    readonly fromCursor: number;
    readonly nextState: DreamState;
  }): LessonProposal {
    if (this.pending() !== null) throw new DreamError('a lesson proposal is already pending');
    const proposal: LessonProposal = {
      version: 1,
      id: randomUUID(),
      createdAt: this.now().toISOString(),
      notificationId: null,
      entries: input.entries,
      fromCursor: input.fromCursor,
      nextState: input.nextState,
      plan: input.plan,
    };
    // Durable first: a crash before the post leaves a proposal the next
    // beat re-announces, never an announced proposal with no file.
    this.write(proposal);
    return this.ensureAnnounced(proposal);
  }

  /** Post the For You notification if this proposal has none yet. */
  ensureAnnounced(proposal: LessonProposal): LessonProposal {
    if (proposal.notificationId !== null) return proposal;
    const notificationId = this.notifier.proposed(proposalNotice(proposal));
    const announced = { ...proposal, notificationId };
    this.write(announced);
    return announced;
  }

  /** Owner Accept: write the planned update, then advance the cursor. */
  accept(id: string): LessonProposalDecision {
    const proposal = this.require(id);
    let report: BiblePlan['report'];
    try {
      report = this.bible.applyPlan(proposal.plan);
    } catch (error) {
      if (error instanceof ProposalError && error.code === 'stale') this.discardStale(proposal, error.message);
      throw error;
    }
    return this.close(proposal, 'accepted', report);
  }

  /** Owner Reject: the book is untouched; the batch is consumed anyway. */
  reject(id: string): LessonProposalDecision {
    return this.close(this.require(id), 'rejected', null);
  }

  private require(id: string): LessonProposal {
    const proposal = this.pending();
    if (proposal === null) throw new ProposalError('none', 'no lesson proposal is pending');
    if (proposal.id !== id) {
      throw new ProposalError('mismatch', `lesson proposal ${id} is not the pending one (${proposal.id})`);
    }
    // The cursor must still be where the proposal started — or already be
    // its result (a decision retried after a crash mid-bookkeeping).
    const cursor = loadDreamState(this.stateFile).coveredThroughSeq;
    if (cursor !== proposal.fromCursor && cursor !== proposal.nextState.coveredThroughSeq) {
      const detail = `the dream cursor moved to ${cursor} since this proposal was made from ${proposal.fromCursor}`;
      this.discardStale(proposal, detail);
      throw new ProposalError('stale', detail);
    }
    return proposal;
  }

  private close(
    proposal: LessonProposal,
    decision: 'accepted' | 'rejected',
    report: BiblePlan['report'] | null,
  ): LessonProposalDecision {
    saveDreamState(this.stateFile, proposal.nextState);
    rmSync(this.file, { force: true });
    if (proposal.notificationId !== null) this.notifier.resolve(proposal.notificationId, `owner:${decision}`);
    this.log('info', `lesson proposal ${decision}`, {
      proposal_id: proposal.id,
      covered_through_seq: proposal.nextState.coveredThroughSeq,
      chapters_written: report?.chaptersWritten ?? 0,
    });
    return { id: proposal.id, decision, coveredThroughSeq: proposal.nextState.coveredThroughSeq, report };
  }

  /** A stale proposal is discarded with the cursor left put, so the next
   * dream re-proposes the same entries against the current book. */
  private discardStale(proposal: LessonProposal, detail: string): void {
    rmSync(this.file, { force: true });
    if (proposal.notificationId !== null) this.notifier.resolve(proposal.notificationId, 'stale');
    this.notifier.stale({
      title: 'Lesson proposal withdrawn — the Book of Lessons changed',
      detail: `${detail}. Nothing was written; the next dream re-proposes these journal entries.`,
    });
    this.log('warn', 'lesson proposal discarded as stale', { proposal_id: proposal.id, detail });
  }

  private write(proposal: LessonProposal): void {
    const staging = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(staging, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
      renameSync(staging, this.file);
    } catch (error) {
      rmSync(staging, { force: true });
      throw new DreamError(`could not write lesson proposal ${this.file}: ${String(error)}`);
    }
  }
}

function proposalNotice(proposal: LessonProposal): { title: string; detail: string } {
  const report = proposal.plan.report;
  const changes = report.lessonsAdded + report.lessonsMerged;
  const chapters = proposal.plan.changes.map((change) => change.slug);
  const parts = [
    `${report.lessonsAdded} new`,
    `${report.lessonsMerged} updated`,
    ...(report.chaptersRetired > 0 ? [`${report.chaptersRetired} chapter(s) retired`] : []),
  ];
  return {
    title: `Book of Lessons: ${changes} lesson change${changes === 1 ? '' : 's'} proposed`,
    detail:
      `From ${proposal.entries} journal entr${proposal.entries === 1 ? 'y' : 'ies'}: ${parts.join(', ')} ` +
      `across ${chapters.length} chapter(s) (${chapters.join(', ')}). Review the changes, then Accept or Reject.`,
  };
}

function isLessonProposal(value: unknown): value is LessonProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const plan = row['plan'] as Record<string, unknown> | null | undefined;
  const next = row['nextState'] as Record<string, unknown> | null | undefined;
  const count = (field: unknown): boolean => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
  return (
    row['version'] === 1 &&
    typeof row['id'] === 'string' &&
    typeof row['createdAt'] === 'string' &&
    (row['notificationId'] === null || typeof row['notificationId'] === 'string') &&
    count(row['entries']) &&
    count(row['fromCursor']) &&
    typeof next === 'object' && next !== null &&
    next['version'] === 1 && count(next['coveredThroughSeq']) && count(next['cycles']) &&
    (next['lastDreamAt'] === null || typeof next['lastDreamAt'] === 'string') &&
    typeof plan === 'object' && plan !== null &&
    typeof plan['base'] === 'string' && typeof plan['after'] === 'string' &&
    typeof plan['indexText'] === 'string' &&
    Array.isArray(plan['writes']) && Array.isArray(plan['retired']) && Array.isArray(plan['changes']) &&
    typeof plan['report'] === 'object' && plan['report'] !== null
  );
}

/**
 * Cadence trigger for the dream (default: on boot + every 12h), due-based
 * (issue #221): the next pass is due `lastDreamAt + intervalMs`, read from
 * the persisted dream state at start, so a service restart inherits the
 * running cadence instead of resetting it. The on-boot pass fires only
 * when the dream is already due; a restart before the due time waits out
 * the remainder as the first periodic beat. Never overlaps; a failed pass
 * is logged loud and retried at the next beat.
 */
export interface DreamSchedulerOptions {
  /** Interval in ms; 0 disables the periodic trigger (a due on-boot pass still fires). */
  readonly intervalMs: number;
  readonly dreamOnBoot: boolean;
  /** Persisted last-dream timestamp (ISO string) or null (never dreamed),
   * read fresh at start. Omitting it keeps the pre-due semantics: the dream
   * counts as due immediately. */
  readonly lastDreamAt?: () => string | null;
  readonly run: () => Promise<DreamOutcome>;
  /** A failed pass, beyond the log line — production raises an incident so
   * a broken dream cannot stay silent for days (owner incident 2026-10-07). */
  readonly onFailure?: (error: unknown) => void;
  /** A pass that completed (including noop) — production resolves that incident. */
  readonly onSuccess?: (outcome: DreamOutcome) => void;
  readonly log?: Log;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly now?: () => Date;
}

export class DreamScheduler {
  private readonly opts: DreamSchedulerOptions;
  private readonly log: Log;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(opts: DreamSchedulerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  get running(): boolean {
    return this.timer !== null || this.bootTimer !== null || this.firstBeatTimer !== null;
  }

  /** Milliseconds until the next dream is due, from the persisted schedule:
   * `max(0, lastDreamAt + intervalMs − now)`; null (never dreamed) is due
   * now. An unparsable timestamp is a corrupt state file — refuse to guess. */
  private dueInMs(): number {
    const lastDreamAt = this.opts.lastDreamAt?.() ?? null;
    if (lastDreamAt === null) return 0;
    const last = Date.parse(lastDreamAt);
    if (Number.isNaN(last)) {
      throw new DreamError(
        `persisted dream state has an unparsable lastDreamAt ${JSON.stringify(lastDreamAt)} — inspect or remove the dream state file`,
      );
    }
    return Math.max(0, last + this.opts.intervalMs - this.now().getTime());
  }

  start(): void {
    if (this.timer !== null || this.bootTimer !== null || this.firstBeatTimer !== null) return;
    const dueInMs = this.dueInMs();
    if (this.opts.dreamOnBoot && dueInMs === 0) {
      const setTimeoutImpl = this.opts.setTimeout ?? setTimeout;
      this.bootTimer = setTimeoutImpl(() => {
        this.bootTimer = null;
        void this.tick();
      }, 0);
      this.bootTimer.unref?.();
    }
    if (this.opts.intervalMs > 0) {
      // Cadence continuity: a restart mid-interval waits out the remainder
      // (dueInMs) instead of resetting the clock; due-now falls back to a
      // full interval. The recurring interval arms after the first beat.
      const firstBeatInMs = dueInMs > 0 ? dueInMs : this.opts.intervalMs;
      const setTimeoutImpl = this.opts.setTimeout ?? setTimeout;
      this.firstBeatTimer = setTimeoutImpl(() => {
        this.firstBeatTimer = null;
        void this.tick();
        const setIntervalImpl = this.opts.setInterval ?? setInterval;
        this.timer = setIntervalImpl(() => {
          void this.tick();
        }, this.opts.intervalMs);
        this.timer.unref?.();
      }, firstBeatInMs);
      this.firstBeatTimer.unref?.();
    }
    this.log('info', 'lesson dream trigger started', {
      interval_ms: this.opts.intervalMs,
      on_boot: this.opts.dreamOnBoot,
      boot_pass_due: this.opts.dreamOnBoot && dueInMs === 0,
      due_in_ms: dueInMs,
      first_beat_in_ms: this.opts.intervalMs > 0 ? (dueInMs > 0 ? dueInMs : this.opts.intervalMs) : null,
    });
  }

  stop(): void {
    if (this.bootTimer !== null) {
      (this.opts.clearTimeout ?? clearTimeout)(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.firstBeatTimer !== null) {
      (this.opts.clearTimeout ?? clearTimeout)(this.firstBeatTimer);
      this.firstBeatTimer = null;
    }
    if (this.timer !== null) {
      (this.opts.clearInterval ?? clearInterval)(this.timer);
      this.timer = null;
    }
  }

  /** A throwing hook is logged, never allowed to break the beat. */
  private notify(hook: 'onFailure' | 'onSuccess', call: () => void): void {
    try {
      call();
    } catch (error) {
      this.log('warn', `dream ${hook} hook threw`, { error: String(error) });
    }
  }

  /** One dream beat. A busy engine skips the beat (returns null). */
  async tick(): Promise<DreamOutcome | null> {
    if (this.busy) {
      this.log('info', 'dream beat skipped — previous pass still running', {});
      return null;
    }
    this.busy = true;
    try {
      const outcome = await this.opts.run();
      if (outcome.status === 'noop') {
        this.log('debug', 'dream beat: no new journal entries', {});
      }
      this.notify('onSuccess', () => this.opts.onSuccess?.(outcome));
      return outcome;
    } catch (error) {
      this.log('error', 'dream pass failed — journal cursor unchanged, next beat retries', {
        error: String(error),
      });
      this.notify('onFailure', () => this.opts.onFailure?.(error));
      return null;
    } finally {
      this.busy = false;
    }
  }
}

export function loadDreamState(file: string): DreamState {
  if (!existsSync(file)) {
    return { version: 1, coveredThroughSeq: 0, lastDreamAt: null, cycles: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new DreamError(
      `dream state ${file} is unreadable (${String(error)}); refusing to guess — inspect or remove the file`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DreamError(`dream state ${file} is not an object — inspect or remove the file`);
  }
  const row = parsed as Record<string, unknown>;
  const covered = row['coveredThroughSeq'];
  const lastDreamAt = row['lastDreamAt'];
  const cycles = row['cycles'];
  if (typeof covered !== 'number' || !Number.isSafeInteger(covered) || covered < 0) {
    throw new DreamError(`dream state ${file} has an invalid coveredThroughSeq — inspect or remove the file`);
  }
  if (lastDreamAt !== null && typeof lastDreamAt !== 'string') {
    throw new DreamError(`dream state ${file} has an invalid lastDreamAt — inspect or remove the file`);
  }
  if (typeof cycles !== 'number' || !Number.isSafeInteger(cycles) || cycles < 0) {
    throw new DreamError(`dream state ${file} has an invalid cycles counter — inspect or remove the file`);
  }
  return { version: 1, coveredThroughSeq: covered, lastDreamAt, cycles };
}

export function saveDreamState(file: string, state: DreamState): void {
  const staging = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    renameSync(staging, file);
  } catch (error) {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* best effort — the active state was never replaced */
    }
    throw new DreamError(`could not write dream state ${file}: ${String(error)}`);
  }
}
