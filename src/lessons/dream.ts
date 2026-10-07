import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { BibleStore } from './bible.js';
import { DreamError, type JournalEntry, type ProposedChapter } from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The dream pass: journal → bible. Mechanics only — the judgment (what is
 * one lesson, what merges, how to word it) belongs to the distiller (Bob).
 *
 * Invariants this layer guarantees regardless of distiller behavior:
 *   - the cursor advances ONLY after a successful apply (a failed dream
 *     retries the same entries next cycle — never a silent skip);
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
  readonly status: 'noop' | 'dreamed';
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
  private readonly stateFile: string;
  private readonly maxEntriesPerDream: number;
  private readonly log: Log;
  private readonly now: () => Date;

  constructor(opts: DreamEngineOptions) {
    this.journal = opts.journal;
    this.bible = opts.bible;
    this.distiller = opts.distiller;
    this.stateFile = opts.stateFile ?? join(opts.bible.dir, DREAM_STATE_FILE);
    this.maxEntriesPerDream = opts.maxEntriesPerDream ?? DEFAULT_MAX_ENTRIES_PER_DREAM;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  /** One dream pass. No new entries = no distiller call = no model cost. */
  async run(): Promise<DreamOutcome> {
    this.bible.ensureSeeded();
    const state = loadDreamState(this.stateFile);
    const pending = this.journal.list({ after: state.coveredThroughSeq, limit: this.maxEntriesPerDream });
    if (pending.length === 0) {
      return {
        status: 'noop',
        entries: 0,
        coveredThroughSeq: state.coveredThroughSeq,
        chaptersTouched: 0,
        lessonsAdded: 0,
        lessonsMerged: 0,
        lessonsTrimmed: 0,
        lessonsDropped: 0,
      };
    }
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

    const report = this.bible.applyUpdates(result.chapters, tsById);
    const last = pending[pending.length - 1]!;
    saveDreamState(this.stateFile, {
      version: 1,
      coveredThroughSeq: last.seq,
      lastDreamAt: this.now().toISOString(),
      cycles: state.cycles + 1,
    });
    this.log('info', 'dream pass completed', {
      entries: pending.length,
      covered_through_seq: last.seq,
      chapters_touched: report.chaptersWritten,
      lessons_added: report.lessonsAdded,
      lessons_merged: report.lessonsMerged,
      lessons_trimmed: report.lessonsTrimmed,
      lessons_dropped: report.lessonsDropped,
    });
    return {
      status: 'dreamed',
      entries: pending.length,
      coveredThroughSeq: last.seq,
      chaptersTouched: report.chaptersWritten,
      lessonsAdded: report.lessonsAdded,
      lessonsMerged: report.lessonsMerged,
      lessonsTrimmed: report.lessonsTrimmed,
      lessonsDropped: report.lessonsDropped,
    };
  }
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
