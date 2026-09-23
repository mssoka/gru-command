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
export const DEFAULT_MAX_ENTRIES_PER_DREAM = 100;

export interface DreamState {
  readonly version: 1;
  /** Journal high-water mark through which the last dream consumed. */
  readonly coveredThroughSeq: number;
  readonly lastDreamAt: string | null;
  readonly cycles: number;
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
 * Cadence trigger for the dream (default: on boot + every 12h). Never
 * overlaps; a failed pass is logged loud and retried at the next beat.
 */
export interface DreamSchedulerOptions {
  /** Interval in ms; 0 disables the periodic trigger (on-boot still fires). */
  readonly intervalMs: number;
  readonly dreamOnBoot: boolean;
  readonly run: () => Promise<DreamOutcome>;
  readonly log?: Log;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

export class DreamScheduler {
  private readonly opts: DreamSchedulerOptions;
  private readonly log: Log;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(opts: DreamSchedulerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  get running(): boolean {
    return this.timer !== null || this.bootTimer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    if (this.opts.dreamOnBoot) {
      const setTimeoutImpl = this.opts.setTimeout ?? setTimeout;
      this.bootTimer = setTimeoutImpl(() => {
        this.bootTimer = null;
        void this.tick();
      }, 0);
      this.bootTimer.unref?.();
    }
    if (this.opts.intervalMs > 0) {
      const setIntervalImpl = this.opts.setInterval ?? setInterval;
      this.timer = setIntervalImpl(() => {
        void this.tick();
      }, this.opts.intervalMs);
      this.timer.unref?.();
    }
    this.log('info', 'lesson dream trigger started', {
      interval_ms: this.opts.intervalMs,
      on_boot: this.opts.dreamOnBoot,
    });
  }

  stop(): void {
    if (this.bootTimer !== null) {
      (this.opts.clearTimeout ?? clearTimeout)(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.timer !== null) {
      (this.opts.clearInterval ?? clearInterval)(this.timer);
      this.timer = null;
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
      return outcome;
    } catch (error) {
      this.log('error', 'dream pass failed — journal cursor unchanged, next beat retries', {
        error: String(error),
      });
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
