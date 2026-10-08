import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import {
  ARCHIVED_LESSON_SLUG,
  BibleError,
  isLessonsSlug,
  ProposalError,
  type BibleChapter,
  type BibleLesson,
  type LessonIndexEntry,
  type ProposedChapter,
  type ProposedLesson,
  type ProvenanceRef,
} from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The bible: the collated, deduplicated, concise distillation of the
 * journal. Two surfaces:
 *
 *   INDEX.md          the ONLY part ever embedded in briefings — one line
 *                     per chapter (summary + keyword tags), hard capped
 *   chapters/*.md     the chapters themselves; read ON DEMAND by agents,
 *                     never inlined. Each lesson is a `## <slug>` section
 *                     with `recurred`/`provenance`/`tags` metadata.
 *
 * The store enforces the mechanical invariants the dream must not be able
 * to violate: slug stability, recurrence counting, provenance, chapter
 * caps, and the index cap. Distillers (Bob) supply judgment; this file
 * supplies the guarantees.
 */

export const BIBLE_INDEX_FILE = 'INDEX.md';
export const BIBLE_README_FILE = 'README.md';
export const BIBLE_CHAPTERS_DIR = 'chapters';
export const DEFAULT_CHAPTER_CAP_BYTES = 4_096;
export const DEFAULT_INDEX_CAP_BYTES = 1_024;
/** Cross-process write lock shared by the dream's apply and the repair: an
 * exclusive SQLite transaction on this file (owner decision 2026-10-07). */
export const BIBLE_WRITE_LOCK = '.write.lock.sqlite';
/** Who holds the lock, for the contention message (best effort). */
export const BIBLE_WRITE_LOCK_HOLDER = '.write.lock.holder';
/** Files only a book in use has (the dream cursor, a pending proposal). */
const BOOK_STATE_FILES = ['.dream-state.json', '.proposal.json'] as const;

/** Who holds the write lock (informational — for the contention message
 * only; the lock itself is the SQLite transaction). */
interface LockHolder {
  readonly pid: number;
  readonly action: string;
  readonly at: string;
}

function readLockHolder(file: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    return typeof parsed['pid'] === 'number'
      ? { pid: parsed['pid'], action: String(parsed['action'] ?? 'unknown'), at: String(parsed['at'] ?? 'unknown') }
      : null;
  } catch {
    return null;
  }
}

/** SQLITE_BUSY: another connection holds the lock. */
function sqliteBusy(error: unknown): boolean {
  const failed = error as { errcode?: unknown; message?: unknown } | null;
  return failed?.errcode === 5 || (typeof failed?.message === 'string' && /database is locked/u.test(failed.message));
}

/** Below this a lesson body is "trimmed to the bone" — cap enforcement
 * shortens bodies down to it, then starts dropping least-valuable lessons. */
const MIN_LESSON_BODY_CHARS = 160;

/** Cap enforcement keeps at least this many of a lesson's NEWEST journal
 * handles. Older handles go first, before any lesson text is touched:
 * `recurred` keeps the true count and the journal remains the ground truth
 * (owner decision 2026-10-07 — full provenance had outgrown the 4 KB cap). */
export const PROVENANCE_FLOOR = 3;

export const BIBLE_README = `# Book of Lessons — how this directory works

The book is the operation's long-term memory: a concise, deduplicated
record of lessons worth keeping. It is NOT a log — the journal
(../journal/) is the append-only capture; this is the distillation.

## Who writes what

- The **journal** captures deliberate entries (findings, rulings,
  observations) with provenance. Gru and Silas append through the
  service's authenticated API; a minion's delivery report may end with an
  optional \`lessons\` block the host extracts.
- The **dream** (on a cadence) has Bob distill journal entries newer than
  the last dream into an output file; the service validates it, merges
  repeats into existing lessons (bumping \`recurred\`), and PROPOSES the
  result to the owner (FOR YOU). Only the owner's Accept rewrites the
  affected chapters; Reject leaves the book untouched. It never pastes
  journal text verbatim and never invents events.
- This directory is machine-managed: **nobody hand-edits chapters,
  INDEX.md or .dream-state.json** — Bob included. A hand edit breaks every
  later dream. Corrections go through the journal and the next dream;
  malformed provenance is rebuilt from the journal by
  \`tools/repair-bible-provenance.mjs\`.

## Format

\`INDEX.md\` — one line per chapter, the only thing ever embedded in a
briefing:

    - [<chapter-slug>](chapters/<chapter-slug>.md) — one-line summary (tags: a, b)

\`chapters/<chapter-slug>.md\` — a chapter file with stable anchors; each
lesson is an H2 whose slug is the anchor:

    # <chapter title>

    summary: <one line>
    tags: a, b

    ## <lesson-slug>

    recurred: 2
    provenance: j-12@2026-09-23T18:22:31.000Z, j-27@2026-09-24T09:00:00.000Z
    tags: a, b

    <the lesson: the fewest words a future worker needs>

## Reading and referencing

- Gru and Silas match task keywords against \`INDEX.md\` and put POINTER
  lines into briefings/directives (progressive disclosure):
  \`read <bible>/chapters/<slug>.md#<lesson-slug> (why: …)\`.
- A minion reads the pointed section with its own file tools when the
  task needs it. Chapter bodies are never inlined into briefings —
  pointers keep context small.
- The journal id in \`provenance\` resolves to the exact entry under
  \`../journal/\`; the full story always remains there.
`;

export interface BibleStoreOptions {
  readonly chapterCapBytes?: number;
  readonly indexCapBytes?: number;
  readonly log?: Log;
}

export interface ApplyReport {
  readonly chaptersWritten: number;
  readonly chaptersRetired: number;
  readonly lessonsAdded: number;
  readonly lessonsMerged: number;
  readonly lessonsTrimmed: number;
  readonly lessonsDropped: number;
}

export interface ChapterCapResult {
  readonly chapter: BibleChapter;
  readonly text: string;
  /** Oldest provenance handles released from surviving lessons. */
  readonly provenanceTrimmed: number;
  readonly trimmed: number;
  readonly droppedLessons: number;
  readonly droppedProvenance: readonly ProvenanceRef[];
}

/** One lesson as the owner reviews it: what it will read after the update
 * and what it read before (previous* null for a new lesson). */
export interface LessonChangeView {
  readonly slug: string;
  readonly body: string;
  readonly recurred: number;
  readonly tags: readonly string[];
  readonly previousBody: string | null;
  readonly previousRecurred: number | null;
  readonly previousTags: readonly string[] | null;
}

/** A lesson the update removes, with the text and tags that disappear:
 * `cap` — an existing lesson dropped to fit; `retired` — its chapter is
 * retired; `discarded` — an incoming lesson the cap left out. */
export interface RemovedLessonView {
  readonly slug: string;
  readonly body: string;
  readonly recurred: number;
  readonly tags: readonly string[];
  readonly reason: 'cap' | 'retired' | 'discarded';
}

/** What an update does to one chapter, for the owner's review (owner
 * decision 2026-10-07: every visible change is shown, metadata and
 * removals included). Derived from the plan's baseline and writes, so it
 * can never disagree with what Accept writes. */
export interface ChapterChange {
  readonly slug: string;
  /** Title before (null for a new chapter) and after. */
  readonly title: { readonly before: string | null; readonly after: string };
  readonly retired: boolean;
  /** Chapter summary before (null for a new chapter) and after. */
  readonly summary: { readonly before: string | null; readonly after: string };
  readonly tags: { readonly before: readonly string[]; readonly after: readonly string[] };
  readonly added: readonly LessonChangeView[];
  /** Lessons whose text, recurrence or tags change (handle-only changes
   * are summarized in provenanceTrimmed, not listed). */
  readonly changed: readonly LessonChangeView[];
  readonly removed: readonly RemovedLessonView[];
  readonly provenanceTrimmed: number;
  readonly bodiesTrimmed: number;
}

/** One INDEX.md entry as briefings see it. */
export interface IndexEntryView {
  readonly summary: string;
  readonly tags: readonly string[];
}

/** An INDEX.md line the update changes — including entries of chapters the
 * update does not otherwise touch (index-cap compaction). */
export interface IndexEntryChange {
  readonly slug: string;
  readonly before: IndexEntryView | null;
  readonly after: IndexEntryView | null;
}

/** Everything the owner reviews before Accept. */
export interface PlanReview {
  readonly chapters: readonly ChapterChange[];
  readonly index: readonly IndexEntryChange[];
}

/** One managed file a plan touches: its content hash before and after
 * (null = absent). A plan applies — or resumes after a crash — only while
 * every listed file is in one of those two states. */
export interface PlannedFile {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** A fully computed, not-yet-written book update. */
export interface BiblePlan {
  /** Fingerprint of the book the plan was computed against. */
  readonly base: string;
  /** Fingerprint of the book the plan produces. */
  readonly after: string;
  readonly files: readonly PlannedFile[];
  /** The COMPLETE managed book the plan was computed against — every file
   * by path, plus each touched path that was absent (text null). Both
   * fingerprints are recomputed from it, the review is derived from it,
   * and an unexpected change is named against it. */
  readonly before: readonly { readonly path: string; readonly text: string | null }[];
  /** Each written chapter: its text, and the chapter as merged BEFORE the
   * cap — the cap is re-run on it to prove the text and to report exactly
   * what the cap released, trimmed or left out. */
  readonly writes: readonly { readonly slug: string; readonly text: string; readonly uncapped: BibleChapter }[];
  readonly retired: readonly string[];
  readonly indexText: string;
  /** The chapter and INDEX caps the plan was computed with. */
  readonly chapterCapBytes: number;
  readonly indexCapBytes: number;
  readonly report: ApplyReport;
  /** The planning contract (cap trimming and INDEX rendering) the plan was
   * made under (R6-01): absent = 1, the first release's. A stored plan is
   * verified under ITS contract, so an approved plan survives an upgrade
   * with its exact bytes. */
  readonly contract?: PlanContract;
}

/** 1: the first release (overshoot trimming, character-budget INDEX
 * compaction). 2: retained-text bisection trimming, UTF-8 byte budgets and
 * INDEX read-back. */
export type PlanContract = 1 | 2;
export const PLAN_CONTRACT: PlanContract = 2;

export interface ChapterRepairReport {
  readonly slug: string;
  readonly changed: boolean;
  readonly linesRewritten: number;
  readonly lessonsBefore: number;
  readonly lessonsAfter: number;
  readonly provenanceTrimmed: number;
  readonly bodiesTrimmed: number;
  readonly lessonsDropped: number;
  readonly bytes: number;
}

export interface ProvenanceRepairReport {
  readonly chapters: readonly ChapterRepairReport[];
  /** Where the replaced originals were saved; null when nothing was written. */
  readonly backupDir: string | null;
}

export class BibleStore {
  readonly dir: string;
  readonly chaptersDir: string;
  readonly chapterCapBytes: number;
  readonly indexCapBytes: number;
  private readonly log: Log;

  constructor(dir: string, opts: BibleStoreOptions = {}) {
    this.dir = dir;
    this.chaptersDir = join(dir, BIBLE_CHAPTERS_DIR);
    this.chapterCapBytes = opts.chapterCapBytes ?? DEFAULT_CHAPTER_CAP_BYTES;
    this.indexCapBytes = opts.indexCapBytes ?? DEFAULT_INDEX_CAP_BYTES;
    this.log = opts.log ?? (() => {});
  }

  /** Create the bible tree and seed README + empty index. Existing files
   * are never overwritten — user content is theirs. */
  ensureSeeded(): void {
    const index = join(this.dir, BIBLE_INDEX_FILE);
    if (!existsSync(index)) {
      // Only a pristine book is seeded. A book that already has chapters, a
      // dream cursor or a proposal but lost INDEX.md is damaged: recreating
      // an empty index would change it without the owner's approval and
      // hide the loss — fail loud instead.
      const chapters = existsSync(this.chaptersDir) && readdirSync(this.chaptersDir).some((name) => name.endsWith('.md'));
      const state = BOOK_STATE_FILES.filter((name) => existsSync(join(this.dir, name)));
      if (chapters || state.length > 0) {
        throw new BibleError(
          `the Book of Lessons at ${this.dir} has ${chapters ? 'chapters' : state.join(', ')} but no ${BIBLE_INDEX_FILE} — ` +
            'restore it from a backup (or move the book aside to start fresh); nothing was created',
        );
      }
    }
    mkdirSync(this.chaptersDir, { recursive: true, mode: 0o700 });
    const readme = join(this.dir, BIBLE_README_FILE);
    if (!existsSync(readme)) this.writeAtomic(readme, BIBLE_README);
    if (!existsSync(index)) this.writeAtomic(index, renderIndex([], this.indexCapBytes));
  }

  readIndexText(): string | null {
    const file = join(this.dir, BIBLE_INDEX_FILE);
    let raw: Buffer;
    try {
      raw = readFileSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw new BibleError(`bible index ${file} is unreadable: ${String(error)}`);
    }
    return strictText(raw, file);
  }

  /** All chapters, slug order. A malformed chapter file fails loud. */
  readChapters(): BibleChapter[] {
    let names: string[];
    try {
      names = readdirSync(this.chaptersDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw new BibleError(`bible chapters dir ${this.chaptersDir} is unreadable: ${String(error)}`);
    }
    const chapters: BibleChapter[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.md')).sort()) {
      const slug = name.slice(0, -'.md'.length);
      if (!isLessonsSlug(slug)) {
        throw new BibleError(`bible chapter file ${join(this.chaptersDir, name)} has an invalid slug filename`);
      }
      const file = join(this.chaptersDir, name);
      chapters.push(parseChapter(strictText(readFileSync(file), file), slug));
    }
    return chapters;
  }

  readChapter(slug: string): BibleChapter | null {
    if (!isLessonsSlug(slug)) throw new BibleError(`invalid chapter slug: ${JSON.stringify(slug)}`);
    const file = join(this.chaptersDir, `${slug}.md`);
    let raw: Buffer;
    try {
      raw = readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return parseChapter(strictText(raw, file), slug);
  }

  /**
   * Owner-run provenance repair (owner incident 2026-10-07): rebuild every
   * chapter's provenance from the journal, re-apply the chapter cap, and —
   * only with `write` — back the originals up under a fresh
   * `.repair-backup-<stamp>-<nonce>/chapters/` before replacing them
   * atomically. Every chapter is repaired and checked BEFORE any write, so
   * one bad chapter aborts with the book untouched. A write holds the
   * book's write lock (the dream takes it too), so a dream can never land
   * between this repair's read and its write. Chapters below the cap keep
   * their exact bytes apart from the provenance lines. Idempotent.
   */
  repairProvenance(
    journalTs: ReadonlyMap<string, string>,
    opts: { readonly write: boolean; readonly now?: Date },
  ): ProvenanceRepairReport {
    let completed: { readonly backupDir: string; readonly written: readonly string[] } | null = null;
    const run = (): ProvenanceRepairReport => {
      let names: string[];
      try {
        names = readdirSync(this.chaptersDir).filter((name) => name.endsWith('.md')).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { chapters: [], backupDir: null };
        throw new BibleError(`bible chapters dir ${this.chaptersDir} is unreadable: ${String(error)}`);
      }
      const planned: { readonly slug: string; readonly original: Buffer; readonly text: string }[] = [];
      const chapters: ChapterRepairReport[] = [];
      for (const name of names) {
        const slug = name.slice(0, -'.md'.length);
        const file = join(this.chaptersDir, name);
        if (!isLessonsSlug(slug)) {
          throw new BibleError(`bible chapter file ${file} has an invalid slug filename`);
        }
        // The original bytes are what the backup keeps — exactly; text that
        // is not valid UTF-8 cannot be repaired without guessing.
        const raw = readFileSync(file);
        let original: string;
        try {
          original = STRICT_UTF8.decode(raw);
        } catch {
          throw new BibleError(`bible chapter ${file} is not valid UTF-8 — fix it by hand`);
        }
        const repaired = repairChapterProvenance(original, slug, journalTs);
        // Already fits as repaired: the bytes stay exactly as they are.
        // Otherwise every cap decision is measured — and written — on the
        // in-place file: references go before any text, nothing is ever
        // re-serialized, and a cap that cannot be met faithfully aborts.
        let text = repaired.text;
        let capped: ChapterCapResult = {
          chapter: repaired.chapter, text, provenanceTrimmed: 0, trimmed: 0, droppedLessons: 0, droppedProvenance: [],
        };
        if (Buffer.byteLength(text, 'utf8') > this.chapterCapBytes) {
          capped = enforceChapterCap(repaired.chapter, this.chapterCapBytes, (candidate) =>
            Buffer.byteLength(renderFaithfully(repaired.text, candidate), 'utf8'));
          text = renderFaithfully(repaired.text, capped.chapter);
        }
        const count = (chapter: BibleChapter): number =>
          chapter.lessons.filter((lesson) => lesson.slug !== ARCHIVED_LESSON_SLUG).length;
        chapters.push({
          slug,
          changed: text !== original,
          linesRewritten: repaired.linesRewritten,
          lessonsBefore: count(repaired.chapter),
          lessonsAfter: count(capped.chapter),
          provenanceTrimmed: capped.provenanceTrimmed,
          bodiesTrimmed: capped.trimmed,
          lessonsDropped: capped.droppedLessons,
          bytes: Buffer.byteLength(text, 'utf8'),
        });
        if (text !== original) planned.push({ slug, original: raw, text });
      }
      if (!opts.write || planned.length === 0) return { chapters, backupDir: null };

      const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/gu, '-');
      const backupDir = join(this.dir, `.repair-backup-${stamp}-${randomUUID().slice(0, 8)}`);
      try {
        mkdirSync(backupDir, { mode: 0o700 }); // exclusive: never reuses a snapshot
        mkdirSync(join(backupDir, BIBLE_CHAPTERS_DIR), { mode: 0o700 });
        for (const write of planned) {
          this.writeAtomic(join(backupDir, BIBLE_CHAPTERS_DIR, `${write.slug}.md`), write.original);
        }
      } catch (error) {
        throw new BibleError(
          `could not back up the chapters to ${backupDir} (${String(error)}); the book was not changed`,
        );
      }
      const written: string[] = [];
      for (const write of planned) {
        try {
          this.writeAtomic(join(this.chaptersDir, `${write.slug}.md`), write.text);
        } catch (error) {
          throw new RepairWriteError(
            `repair stopped after replacing ${written.length} of ${planned.length} chapter(s)` +
              `${written.length > 0 ? ` (${written.join(', ')})` : ''} — ${error instanceof Error ? error.message : String(error)}. ` +
              `The book may be partially repaired; every original is saved in ${backupDir}.`,
            backupDir,
            written,
          );
        }
        written.push(write.slug);
      }
      // Proven while the lock is still held (R5-A7): every chapter, as
      // stored, is strict UTF-8, parses with the dream's reader and fits —
      // and every replaced one holds exactly the planned bytes (R6-05).
      const plannedBytes = new Map(planned.map((write) => [`${write.slug}.md`, Buffer.from(write.text, 'utf8')]));
      try {
        // Every planned replacement explicitly — one that vanished is a failure (R7-06).
        for (const [name, expected] of plannedBytes) {
          let raw: Buffer;
          try {
            raw = readFileSync(join(this.chaptersDir, name));
          } catch (error) {
            throw new BibleError(`chapter ${name} cannot be read back (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
          }
          if (!raw.equals(expected)) throw new BibleError(`chapter ${name} does not hold the planned bytes`);
        }
        for (const name of readdirSync(this.chaptersDir).filter((entry) => entry.endsWith('.md')).sort()) {
          const raw = readFileSync(join(this.chaptersDir, name));
          const expected = plannedBytes.get(name);
          if (expected !== undefined && !raw.equals(expected)) {
            throw new BibleError(`chapter ${name} does not hold the planned bytes`);
          }
          if (raw.length > this.chapterCapBytes) {
            throw new BibleError(`chapter ${name} is ${raw.length} B, over the ${this.chapterCapBytes} B cap`);
          }
          parseChapter(STRICT_UTF8.decode(raw), name.slice(0, -'.md'.length));
        }
      } catch (error) {
        throw new RepairWriteError(
          `repair replaced ${written.length} chapter(s) (${written.join(', ')}), but the result does not verify: ` +
            `${error instanceof Error ? error.message : String(error)}. Every original is saved in ${backupDir}.`,
          backupDir,
          written,
        );
      }
      completed = { backupDir, written };
      this.log('info', 'bible provenance repaired', { chapters_written: written.length, backup_dir: backupDir });
      return { chapters, backupDir };
    };
    if (!opts.write) return run();
    try {
      return this.withWriteLock('provenance repair', run);
    } catch (error) {
      const done = completed as { readonly backupDir: string; readonly written: readonly string[] } | null;
      if (done === null || error instanceof RepairWriteError) throw error;
      // Every chapter was replaced; only the cleanup after it failed.
      throw new RepairWriteError(
        `repair replaced all ${done.written.length} chapter(s) (${done.written.join(', ')}), then failed: ` +
          `${error instanceof Error ? error.message : String(error)}. The originals are saved in ${done.backupDir}.`,
        done.backupDir,
        done.written,
      );
    }
  }

  /**
   * The book's cross-process write lock (owner decision 2026-10-07): an
   * EXCLUSIVE transaction on a small SQLite file. The dream's apply and the
   * owner's repair both hold it across their reads and writes, so neither
   * can overwrite the other's result. The OS releases it when its process
   * ends, however it ends — a stale lock cannot exist, so there is nothing
   * to reclaim and no PID to trust. Contention fails loud at once.
   */
  private withWriteLock<T>(action: string, fn: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = join(this.dir, BIBLE_WRITE_LOCK);
    const holderFile = join(this.dir, BIBLE_WRITE_LOCK_HOLDER);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(lock);
    } catch (error) {
      throw new BibleError(`cannot open the book write lock ${lock}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      db.exec('PRAGMA busy_timeout = 0');
      db.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      db.close();
      if (!sqliteBusy(error)) {
        throw new BibleError(`cannot take the book write lock ${lock}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const holder = readLockHolder(holderFile);
      throw new BibleError(
        holder === null
          ? 'the Book of Lessons is being written by another process; retry when it finishes'
          : `the Book of Lessons is being written by pid ${holder.pid} (${holder.action}, since ${holder.at}); retry when it finishes`,
      );
    }
    const release = (): void => {
      try {
        db.exec('ROLLBACK');
      } finally {
        db.close(); // closing the connection releases the lock, even if the rollback failed
      }
    };
    let result: T;
    try {
      try {
        writeFileSync(holderFile, JSON.stringify({ pid: process.pid, action, at: new Date().toISOString() }), { mode: 0o600 });
      } catch {
        /* informational only */
      }
      result = fn();
    } catch (error) {
      try {
        release();
      } catch (failure) {
        this.log('warn', 'bible write lock release failed after an error', { lock, error: String(failure) });
      }
      throw error;
    }
    // After a successful write a release failure is reported, never hidden
    // — and it carries the completed result, so a caller can tell "written,
    // cleanup failed" from "not written".
    try {
      release();
    } catch (error) {
      throw new BibleLockReleaseError(
        `${action} completed, but releasing the book write lock ${lock} failed: ${error instanceof Error ? error.message : String(error)} ` +
          '(the lock is released when this process ends)',
        result,
      );
    }
    return result;
  }

  /**
   * Plan distiller updates WITHOUT writing: dedupe (explicit merge target,
   * stable slug, or near-identical body), bump `recurred`, union
   * provenance, enforce the chapter cap, render the index. The plan names
   * the exact book it was computed against (`base`) and the one it
   * produces (`after`), each touched file's before/after hash, and a
   * per-chapter review of everything that changes — the owner decides on
   * that review before anything is written (owner decision 2026-10-07).
   * Every planned chapter is re-parsed and must read back exactly as
   * planned, so lesson text can never turn into metadata on Accept.
   */
  planUpdates(
    updates: readonly ProposedChapter[],
    provenance: ReadonlyMap<string, string>,
  ): BiblePlan {
    const files = this.snapshotFiles();
    const original = new Map(this.readChapters().map((chapter) => [chapter.slug, chapter]));
    const chapters = new Map(original);
    const touched = new Set<string>();
    const retired = new Set<string>();
    let lessonsAdded = 0;
    let lessonsMerged = 0;
    let lessonsTrimmed = 0;
    let lessonsDropped = 0;

    for (const proposed of updates) {
      // Canonical first — what the chapter format will read back — then
      // validated, so nothing (a CR-hidden heading) slips past as text.
      const update = normalizeProposedChapter(proposed);
      validateProposedChapter(update);
      if (update.retire === true) {
        // Retiring a chapter created earlier in this same batch is net
        // absence: nothing to retire from the book.
        if (chapters.delete(update.slug) && original.has(update.slug)) retired.add(update.slug);
        else touched.delete(update.slug);
        continue;
      }
      retired.delete(update.slug);
      const existing = chapters.get(update.slug);
      const chapter: BibleChapter =
        existing ?? { slug: update.slug, title: update.title, summary: update.summary, tags: [], lessons: [] };
      const merged = applyLessonUpdates(chapter, update, provenance);
      lessonsAdded += merged.added;
      lessonsMerged += merged.merged;
      chapters.set(update.slug, merged.chapter);
      touched.add(update.slug);
    }

    const finalChapters: BibleChapter[] = [];
    const writes: { slug: string; text: string; uncapped: BibleChapter }[] = [];
    for (const chapter of chapters.values()) {
      if (!touched.has(chapter.slug)) {
        finalChapters.push(chapter);
        continue;
      }
      if (retired.has(chapter.slug)) continue;
      const capped = enforceChapterCap(chapter, this.chapterCapBytes);
      assertReadsBack(capped.text, capped.chapter);
      lessonsTrimmed += capped.trimmed;
      lessonsDropped += capped.droppedLessons;
      finalChapters.push(capped.chapter);
      writes.push({ slug: chapter.slug, text: capped.text, uncapped: chapter });
    }
    // Render the index BEFORE any write: a cap failure must leave the whole
    // bible untouched (otherwise a retried dream could double-count
    // recurrences over half-applied state).
    const indexText = renderIndex(finalChapters, this.indexCapBytes);

    const after = new Map(files);
    for (const write of writes) after.set(`${BIBLE_CHAPTERS_DIR}/${write.slug}.md`, write.text);
    for (const slug of retired) after.delete(`${BIBLE_CHAPTERS_DIR}/${slug}.md`);
    after.set(BIBLE_INDEX_FILE, indexText);
    const touchedPaths = [
      ...writes.map((write) => `${BIBLE_CHAPTERS_DIR}/${write.slug}.md`),
      ...[...retired].map((slug) => `${BIBLE_CHAPTERS_DIR}/${slug}.md`),
      BIBLE_INDEX_FILE,
    ];

    const baselinePaths = [...new Set([...files.keys(), ...touchedPaths])].sort();
    return {
      base: bookFingerprint(files),
      after: bookFingerprint(after),
      files: touchedPaths.map((path) => ({
        path,
        before: contentHash(files.get(path)),
        after: contentHash(after.get(path)),
      })),
      before: baselinePaths.map((path) => ({ path, text: files.get(path) ?? null })),
      writes,
      retired: [...retired],
      indexText,
      chapterCapBytes: this.chapterCapBytes,
      indexCapBytes: this.indexCapBytes,
      contract: PLAN_CONTRACT,
      report: {
        chaptersWritten: writes.length,
        chaptersRetired: retired.size,
        lessonsAdded,
        lessonsMerged,
        lessonsTrimmed,
        lessonsDropped,
      },
    };
  }

  /**
   * Write a plan onto the book it was planned against — and only that book.
   * Under the book's write lock: every file the plan touches must be at its
   * planned before OR after state (a crash mid-apply leaves a mixture this
   * resumes), and the whole book the plan would leave must fingerprint to
   * `plan.after` (any unrelated change, or a corrupt plan, is refused before
   * the first write). A moved book is ProposalError('stale') with nothing
   * written; a book already equal to the result is a no-op.
   */
  applyPlan(plan: BiblePlan): ApplyReport {
    const verified = verifyPlan(plan);
    return this.withWriteLock('lesson proposal accept', () => this.applyPlanLocked(plan, verified));
  }

  private applyPlanLocked(plan: BiblePlan, verified: VerifiedPlan): ApplyReport {
    const current = this.snapshotFiles();
    if (bookFingerprint(current) === plan.after) return plan.report;
    // Every managed file must be exactly as planned before or after (a
    // crash mid-apply leaves a mixture this resumes); anything else is a
    // foreign change, named file by file — nothing is written.
    const unexpected = unexpectedPaths(current, verified.baseline, verified.result);
    if (unexpected.length > 0) {
      throw new ProposalError(
        'stale',
        `the Book of Lessons changed since this update was planned (${unexpected.join(', ')}); nothing was written`,
      );
    }
    for (const write of plan.writes) {
      const path = `${BIBLE_CHAPTERS_DIR}/${write.slug}.md`;
      if (current.get(path) !== write.text) this.writeAtomic(join(this.chaptersDir, `${write.slug}.md`), write.text);
    }
    for (const slug of plan.retired) rmSync(join(this.chaptersDir, `${slug}.md`), { force: true });
    if (current.get(BIBLE_INDEX_FILE) !== plan.indexText) this.writeAtomic(join(this.dir, BIBLE_INDEX_FILE), plan.indexText);
    if (bookFingerprint(this.snapshotFiles()) !== plan.after) {
      throw new BibleError('the Book of Lessons does not match the applied plan; inspect it before retrying');
    }
    this.log('info', 'bible updated', {
      chapters_written: plan.report.chaptersWritten,
      chapters_retired: plan.report.chaptersRetired,
      lessons_added: plan.report.lessonsAdded,
      lessons_merged: plan.report.lessonsMerged,
      lessons_trimmed: plan.report.lessonsTrimmed,
      lessons_dropped: plan.report.lessonsDropped,
      index_bytes: Buffer.byteLength(plan.indexText, 'utf8'),
    });
    return plan.report;
  }

  /** The current book's fingerprint (what a plan's `base` is compared to). */
  fingerprint(): string {
    return bookFingerprint(this.snapshotFiles());
  }

  /** Every managed path that differs from the plan's reviewed baseline
   * (`baselineOnly`) — or from both its baseline and its result — named as
   * changed, added or deleted. */
  driftFrom(plan: BiblePlan, baselineOnly: boolean): string[] {
    const verified = verifyPlan(plan);
    return unexpectedPaths(this.snapshotFiles(), verified.baseline, baselineOnly ? verified.baseline : verified.result);
  }

  /** Plan and write in one step — tests and owner-run tooling only; the
   * service's dream proposes and waits for the owner. */
  applyUpdates(
    updates: readonly ProposedChapter[],
    provenance: ReadonlyMap<string, string>,
  ): ApplyReport {
    // The lock covers the reads and planning too, so nothing can land
    // between this plan's read and its write.
    return this.withWriteLock('dream apply', () => {
      const plan = this.planUpdates(updates, provenance);
      return this.applyPlanLocked(plan, verifyPlan(plan));
    });
  }

  /** The book's managed files (INDEX.md + chapters/*.md) by relative path. */
  private snapshotFiles(): Map<string, string> {
    const files = new Map<string, string>();
    const index = this.readIndexText();
    if (index !== null) files.set(BIBLE_INDEX_FILE, index);
    let names: string[] = [];
    try {
      names = readdirSync(this.chaptersDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new BibleError(`bible chapters dir ${this.chaptersDir} is unreadable: ${String(error)}`);
      }
    }
    for (const name of names.filter((candidate) => candidate.endsWith('.md')).sort()) {
      const file = join(this.chaptersDir, name);
      files.set(`${BIBLE_CHAPTERS_DIR}/${name}`, strictText(readFileSync(file), file));
    }
    return files;
  }

  private writeAtomic(file: string, data: string | Buffer): void {
    const staging = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(staging, data);
      renameSync(staging, file);
    } catch (error) {
      try {
        rmSync(staging, { force: true });
      } catch {
        /* best effort — the active file was never replaced */
      }
      throw new BibleError(`could not write ${file}: ${String(error)}`);
    }
  }
}

/** sha256 over the book's managed files, path-ordered and length-framed
 * so no file content can impersonate another path. */
export function bookFingerprint(files: ReadonlyMap<string, string>): string {
  const digest = createHash('sha256');
  digest.update('gru-book-of-lessons-v1\0');
  for (const path of [...files.keys()].sort()) {
    const text = files.get(path)!;
    digest.update(`${path}\0${Buffer.byteLength(text, 'utf8')}\0`).update(text, 'utf8');
  }
  return digest.digest('hex');
}

/** A plan proven consistent: its intended content per touched path (null =
 * removed), the complete baseline book, and the book it produces. */
interface VerifiedPlan {
  readonly content: ReadonlyMap<string, string | null>;
  readonly baseline: ReadonlyMap<string, string>;
  readonly result: ReadonlyMap<string, string>;
}

/** Prove a plan consistent before anything acts on it — a corrupt or
 * forged plan is refused before the lock is even taken, let alone a write:
 * its writes match its file list and hashes; its complete baseline
 * fingerprints to `base` and, with the writes applied, to `after` (so
 * neither can be forged to skip or redirect a write); every written
 * chapter is exactly what the cap makes of its pre-cap chapter, and reads
 * back as planned. */
function verifyPlan(plan: BiblePlan): VerifiedPlan {
  const fail = (what: string): never => {
    throw new BibleError(`the update plan is inconsistent: ${what}; nothing was written`);
  };
  if (plan.contract !== undefined && plan.contract !== 1 && plan.contract !== 2) fail(`its planning contract ${String(plan.contract)} is unknown`);
  const contract = planContract(plan);
  const content = new Map<string, string | null>();
  for (const write of plan.writes) content.set(`${BIBLE_CHAPTERS_DIR}/${write.slug}.md`, write.text);
  for (const slug of plan.retired) content.set(`${BIBLE_CHAPTERS_DIR}/${slug}.md`, null);
  content.set(BIBLE_INDEX_FILE, plan.indexText);
  const listed = new Set(plan.files.map((file) => file.path));
  if (plan.files.length !== content.size || [...content.keys()].some((path) => !listed.has(path))) {
    fail('its file list does not match its writes');
  }
  for (const file of plan.files) {
    if (contentHash(content.get(file.path)) !== file.after) fail(`${file.path} does not match its planned result`);
  }
  const slugs = plan.writes.map((write) => write.slug);
  if (new Set(slugs).size !== slugs.length || plan.retired.some((slug) => slugs.includes(slug)) || new Set(plan.retired).size !== plan.retired.length) {
    fail('a chapter is written twice or both written and retired');
  }
  const before = new Map(plan.before.map((entry) => [entry.path, entry.text]));
  if (before.size !== plan.before.length) fail('its baseline lists a path twice');
  for (const file of plan.files) {
    if (!before.has(file.path) || contentHash(before.get(file.path)) !== file.before) {
      fail(`${file.path} baseline does not match its recorded hash`);
    }
  }
  for (const [path, text] of before) if (text === null && !listed.has(path)) fail(`its baseline marks untouched ${path} absent`);
  const baseline = new Map([...before].filter((entry): entry is [string, string] => entry[1] !== null));
  if (bookFingerprint(baseline) !== plan.base) fail('its baseline does not fingerprint to its base');
  const result = new Map(baseline);
  for (const [path, text] of content) {
    if (text === null) result.delete(path);
    else result.set(path, text);
  }
  if (bookFingerprint(result) !== plan.after) fail('its writes do not produce its planned book');
  if (plan.report.chaptersWritten !== plan.writes.length || plan.report.chaptersRetired !== plan.retired.length) {
    fail('its report does not match its writes');
  }
  if (!Number.isSafeInteger(plan.chapterCapBytes) || plan.chapterCapBytes <= 0) fail('its chapter cap');
  if (!Number.isSafeInteger(plan.indexCapBytes) || plan.indexCapBytes <= 0) fail('its index cap');
  let trimmed = 0;
  let dropped = 0;
  for (const write of plan.writes) {
    assertChapterModel(write.uncapped, write.slug, contract);
    const capped = enforceChapterCap(write.uncapped, plan.chapterCapBytes, undefined, contract);
    if (capped.text !== write.text) fail(`chapter ${write.slug} is not what the cap makes of its merged chapter`);
    if (!utf8Exact(write.text)) fail(`chapter ${write.slug} would not survive UTF-8 unchanged`);
    assertReadsBack(write.text, capped.chapter, contract);
    trimmed += capped.trimmed;
    dropped += capped.droppedLessons;
  }
  // The counts Accept reports and logs are the cap's own (C6).
  if (plan.report.lessonsTrimmed !== trimmed || plan.report.lessonsDropped !== dropped) {
    fail(`its report claims ${plan.report.lessonsTrimmed} trimmed and ${plan.report.lessonsDropped} dropped lesson(s); the cap trims ${trimmed} and drops ${dropped}`);
  }
  // INDEX.md is exactly the index of the book the plan produces — so it can
  // carry nothing the review does not show.
  const resultChapters = [...result.entries()]
    .filter(([path]) => path.startsWith(`${BIBLE_CHAPTERS_DIR}/`) && path.endsWith('.md'))
    .map(([path, text]) => parseChapter(text, path.slice(BIBLE_CHAPTERS_DIR.length + 1, -'.md'.length), contract));
  const index = contract === 1 ? renderIndexV1(resultChapters, plan.indexCapBytes) : renderIndex(resultChapters, plan.indexCapBytes);
  if (!utf8Exact(plan.indexText) || index !== plan.indexText) {
    fail('its INDEX.md is not the index of the book it produces');
  }
  return { content, baseline, result };
}

/** Every managed path whose current content is neither the planned
 * baseline nor the planned result — described as changed, added or deleted. */
function unexpectedPaths(
  current: ReadonlyMap<string, string>,
  baseline: ReadonlyMap<string, string>,
  result: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const path of [...new Set([...current.keys(), ...baseline.keys(), ...result.keys()])].sort()) {
    const now = current.get(path);
    if (now === baseline.get(path) || now === result.get(path)) continue;
    out.push(`${path} ${now === undefined ? 'deleted' : baseline.has(path) || result.has(path) ? 'changed' : 'added'}`);
  }
  return out;
}

/** A stored pre-cap chapter must be a well-formed chapter model. */
function assertChapterModel(value: unknown, slug: string, contract: PlanContract = PLAN_CONTRACT): void {
  const bad = (what: string): never => {
    throw new BibleError(`the update plan is inconsistent: chapter ${slug} pre-cap ${what}; nothing was written`);
  };
  const isStrings = (input: unknown): boolean => Array.isArray(input) && input.every((item) => typeof item === 'string');
  if (typeof value !== 'object' || value === null) bad('is not a chapter');
  const chapter = value as Record<string, unknown>;
  if (chapter['slug'] !== slug) bad('slug');
  if (typeof chapter['title'] !== 'string' || typeof chapter['summary'] !== 'string' || !isStrings(chapter['tags'])) bad('metadata');
  if (!Array.isArray(chapter['lessons'])) bad('lessons');
  for (const item of chapter['lessons'] as unknown[]) {
    const lesson = (typeof item === 'object' && item !== null ? item : bad('lesson')) as Record<string, unknown>;
    if (typeof lesson['slug'] !== 'string' || !isLessonsSlug(lesson['slug'])) bad('lesson slug');
    if (typeof lesson['body'] !== 'string' || !isStrings(lesson['tags'])) bad('lesson text');
    if (typeof lesson['recurred'] !== 'number' || !Number.isSafeInteger(lesson['recurred']) || lesson['recurred'] < 1) bad('lesson recurrence');
    if (!Array.isArray(lesson['provenance'])) bad('lesson provenance');
    const ids = new Set<string>();
    for (const ref of lesson['provenance'] as unknown[]) {
      const handle = (typeof ref === 'object' && ref !== null ? ref : bad('handle')) as Record<string, unknown>;
      if (typeof handle['id'] !== 'string' || typeof handle['ts'] !== 'string') bad('handle');
      // Contract 1 planned repeated journal ids as copies; it is checked as it was.
      if (contract !== 1 && ids.has(handle['id'] as string)) bad(`provenance repeats ${String(handle['id'])}`);
      if (contract !== 1 && parseIsoInstant(handle['ts'] as string) === null) bad(`provenance ${String(handle['id'])} carries an invalid instant`);
      ids.add(handle['id'] as string);
    }
  }
}

/** Check a plan's internal consistency without writing anything — run
 * before a stored proposal is shown or decided. */
export function checkPlan(plan: BiblePlan): void {
  verifyPlan(plan);
}

/** The owner's review of a plan, derived from its baseline and its writes
 * — never stored separately, so it cannot disagree with what Accept writes.
 * Cap effects come from re-running the cap on each pre-cap chapter. */
export function describePlan(plan: BiblePlan): PlanReview {
  const baseline = new Map(plan.before.map((entry) => [entry.path, entry.text]));
  const chapters: ChapterChange[] = [];
  for (const write of plan.writes) {
    const prior = baseline.get(`${BIBLE_CHAPTERS_DIR}/${write.slug}.md`) ?? null;
    chapters.push(
      describeChapterChange(
        prior === null ? null : parseChapter(prior, write.slug, planContract(plan)),
        write.uncapped,
        enforceChapterCap(write.uncapped, plan.chapterCapBytes, undefined, planContract(plan)),
      ),
    );
  }
  for (const slug of plan.retired) {
    const prior = baseline.get(`${BIBLE_CHAPTERS_DIR}/${slug}.md`) ?? null;
    if (prior === null) continue;
    const before = parseChapter(prior, slug, planContract(plan));
    chapters.push({
      slug,
      title: { before: before.title, after: before.title },
      retired: true,
      summary: { before: before.summary, after: '' },
      tags: { before: before.tags, after: [] },
      added: [],
      changed: [],
      // The archive record goes too — shown like every other record (C5).
      removed: before.lessons
        .map((lesson) => ({ slug: lesson.slug, body: lesson.body, recurred: lesson.recurred, tags: lesson.tags, reason: 'retired' as const })),
      provenanceTrimmed: 0,
      bodiesTrimmed: 0,
    });
  }
  const entries = (text: string | null) =>
    new Map(parseIndex(text ?? '', planContract(plan)).map((entry) => [entry.slug, { summary: entry.summary, tags: entry.tags }]));
  const beforeIndex = entries(baseline.get(BIBLE_INDEX_FILE) ?? null);
  const afterIndex = entries(plan.indexText);
  const index: IndexEntryChange[] = [];
  for (const slug of [...new Set([...beforeIndex.keys(), ...afterIndex.keys()])].sort()) {
    const before = beforeIndex.get(slug) ?? null;
    const after = afterIndex.get(slug) ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) index.push({ slug, before, after });
  }
  return { chapters, index };
}

/** sha256 of one file's content; null when the file is absent. */
function contentHash(text: string | undefined | null): string | null {
  return text === undefined || text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A planned chapter must read back exactly as planned — otherwise a
 * body line would be re-read as metadata (or anchors) after Accept. */
function assertReadsBack(text: string, planned: BibleChapter, contract: PlanContract = PLAN_CONTRACT): void {
  const reread = parseChapter(text, planned.slug, contract);
  const shape = (chapter: BibleChapter) =>
    JSON.stringify([
      chapter.title,
      chapter.summary,
      chapter.tags,
      chapter.lessons.map((lesson) => [lesson.slug, lesson.body, lesson.recurred, lesson.provenance, lesson.tags]),
    ]);
  if (shape(reread) !== shape(planned)) {
    throw new BibleError(
      `chapter ${planned.slug} would not read back as planned — its title, summary, tags or a lesson body would be parsed as other structure; reword it`,
    );
  }
}

function describeChapterChange(before: BibleChapter | null, uncapped: BibleChapter, cap: ChapterCapResult): ChapterChange {
  const after = cap.chapter;
  // The archive record (slug ARCHIVED_LESSON_SLUG) is listed like any
  // lesson (C5): its arrival, any change to its text or tags, and its
  // removal are all visible — only handle-only changes stay summarized.
  const previous = new Map((before?.lessons ?? []).map((lesson) => [lesson.slug, lesson]));
  const added: LessonChangeView[] = [];
  const changed: LessonChangeView[] = [];
  const kept = new Set<string>();
  for (const lesson of after.lessons) {
    kept.add(lesson.slug);
    const prior = previous.get(lesson.slug);
    const view = {
      slug: lesson.slug,
      body: lesson.body,
      recurred: lesson.recurred,
      tags: lesson.tags,
      previousBody: prior?.body ?? null,
      previousRecurred: prior?.recurred ?? null,
      previousTags: prior?.tags ?? null,
    };
    if (prior === undefined) added.push(view);
    else if (prior.body !== lesson.body || prior.recurred !== lesson.recurred || prior.tags.join('\u0000') !== lesson.tags.join('\u0000')) {
      changed.push(view);
    }
  }
  const removedView = (lesson: BibleLesson, reason: RemovedLessonView['reason']): RemovedLessonView => ({
    slug: lesson.slug,
    body: lesson.body,
    recurred: lesson.recurred,
    tags: lesson.tags,
    reason,
  });
  const removed: RemovedLessonView[] = [
    ...[...previous.values()].filter((lesson) => !kept.has(lesson.slug)).map((lesson) => removedView(lesson, 'cap')),
    // Incoming lessons the cap left out never reach the book: say so.
    ...uncapped.lessons
      .filter((lesson) => !previous.has(lesson.slug) && !kept.has(lesson.slug))
      .map((lesson) => removedView(lesson, 'discarded')),
  ];
  return {
    slug: after.slug,
    title: { before: before?.title ?? null, after: after.title },
    retired: false,
    summary: { before: before?.summary ?? null, after: after.summary },
    tags: { before: before?.tags ?? [], after: after.tags },
    added,
    changed,
    removed,
    // Every handle the cap released — existing, incoming and archived alike.
    provenanceTrimmed: cap.provenanceTrimmed,
    bodiesTrimmed: cap.trimmed,
  };
}

/** A proposed chapter in the form the chapter format reads back: trimmed
 * title, trimmed and de-duplicated tags, LF line endings in bodies (CRLF
 * and bare CR alike). Validation runs on the result, so the injection
 * guards see exactly what will be written. */
function normalizeProposedChapter(update: ProposedChapter): ProposedChapter {
  const tags = (list: readonly string[]) => [...new Set(list.map((tag) => tag.trim()))];
  return {
    ...update,
    title: update.title.trim(),
    ...(update.tags !== undefined ? { tags: tags(update.tags) } : {}),
    lessons: update.lessons.map((lesson) => ({
      ...lesson,
      body: lesson.body.replace(/\r\n?/gu, '\n').trim(),
      ...(lesson.tags !== undefined ? { tags: tags(lesson.tags) } : {}),
    })),
  };
}

// ------------------------------------------------------------------
// Chapter serialization / parsing (the pinned format)
// ------------------------------------------------------------------

/** At most `length` UTF-16 units of `text`, never ending inside a
 * surrogate pair. */
function safeSlice(text: string, length: number): string {
  if (length >= text.length) return text;
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

/** Text that survives a UTF-8 round trip unchanged (no lone surrogates). */
function utf8Exact(text: string): boolean {
  return Buffer.from(text, 'utf8').toString('utf8') === text;
}

function collapseLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Serialize one chapter in the canonical format (stable anchors, bounded
 * metadata). Bodies never contain heading lines — validated at the door. */
export function serializeChapter(chapter: BibleChapter): string {
  const lines: string[] = [`# ${chapter.title}`, ''];
  if (chapter.summary !== '') lines.push(`summary: ${collapseLine(chapter.summary)}`);
  if (chapter.tags.length > 0) lines.push(`tags: ${chapter.tags.join(', ')}`);
  for (const lesson of chapter.lessons) {
    lines.push(
      '',
      `## ${lesson.slug}`,
      '',
      `recurred: ${lesson.recurred}`,
      `provenance: ${lesson.provenance.map((ref) => `${ref.id}@${ref.ts}`).join(', ')}`,
    );
    if (lesson.tags.length > 0) lines.push(`tags: ${lesson.tags.join(', ')}`);
    lines.push('', lesson.body.trim());
  }
  return `${lines.join('\n')}\n`;
}

const CHAPTER_META_LINE = /^(summary|tags):\s*(.*)$/;
const LESSON_META_LINE = /^(recurred|provenance|tags):\s*(.*)$/;
const HEADING_LINE = /^#{1,6}\s/;
/** Marker appended to a body shortened by cap enforcement. */
const TRIM_MARKER = ' … [trimmed to fit the chapter cap]';

export function parseChapter(text: string, slug: string, contract: PlanContract = PLAN_CONTRACT): BibleChapter {
  if (!isLessonsSlug(slug)) throw new BibleError(`invalid chapter slug: ${JSON.stringify(slug)}`);
  // CRLF, LF and a bare CR each end a line (R5-A13): a CR-only chapter is
  // read as its lines, never as one line with nothing in it. Contract 1
  // read a bare CR as part of its line, and is replayed that way (R8-01).
  const lines = text.split(lineBreaks(contract));
  let title: string | null = null;
  let summary = '';
  const chapterTags: string[] = [];
  interface Section {
    slug: string;
    lines: string[];
  }
  const sections: Section[] = [];
  let current: Section | null = null;
  let inChapterMeta = true;

  for (const raw of lines) {
    const line = raw ?? '';
    if (title === null) {
      if (line.trim() === '') continue;
      if (!line.startsWith('# ')) {
        throw new BibleError(`chapter ${slug}.md must start with "# <title>", found ${JSON.stringify(line)}`);
      }
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith('## ')) {
      inChapterMeta = false;
      const sectionSlug = line.slice(3).trim();
      if (!isLessonsSlug(sectionSlug)) {
        throw new BibleError(`chapter ${slug}.md has an invalid lesson anchor: ${JSON.stringify(sectionSlug)}`);
      }
      if (sections.some((section) => section.slug === sectionSlug)) {
        // Two lessons on one anchor cannot be told apart — every merge,
        // review and repair would pick one arbitrarily.
        throw new BibleError(`chapter ${slug}.md has more than one lesson anchored "## ${sectionSlug}" — fix it by hand`);
      }
      current = { slug: sectionSlug, lines: [] };
      sections.push(current);
      continue;
    }
    if (inChapterMeta && current === null) {
      const meta = CHAPTER_META_LINE.exec(line);
      if (meta !== null) {
        if (meta[1] === 'summary') summary = meta[2] ?? '';
        else if (meta[1] === 'tags') chapterTags.push(...splitTags(meta[2] ?? ''));
        continue;
      }
      if (line.trim() === '') continue;
      // Unknown chapter-level line: keep it as summary context rather than
      // silently dropping it (a hand edit stays visible in the index).
      summary = summary === '' ? collapseLine(line) : `${summary} ${collapseLine(line)}`;
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  if (title === null) throw new BibleError(`chapter ${slug}.md is empty`);

  const lessons: BibleLesson[] = [];
  for (const section of sections) {
    lessons.push(parseLesson(contract, slug, section.slug, section.lines));
  }
  return { slug, title, summary, tags: chapterTags, lessons };
}

function parseLesson(contract: PlanContract, chapterSlug: string, slug: string, lines: readonly string[]): BibleLesson {
  let recurred = 1;
  let sawRecurred = false;
  const provenance: ProvenanceRef[] = [];
  const tags: string[] = [];
  const bodyLines: string[] = [];
  let inMeta = true;
  for (const line of lines) {
    if (inMeta) {
      const meta = LESSON_META_LINE.exec(line);
      if (meta !== null) {
        if (meta[1] === 'recurred') {
          const value = Number.parseInt(meta[2] ?? '', 10);
          if (!Number.isSafeInteger(value) || value < 1) {
            throw new BibleError(`chapter ${chapterSlug}.md lesson ${slug}: recurred must be a positive integer`);
          }
          recurred = value;
          sawRecurred = true;
        } else if (meta[1] === 'provenance') {
          // One handle once per LESSON, across every provenance line (R6-02)
          // — contract 1 read repeats and impossible instants as written.
          for (const ref of splitProvenance(meta[2] ?? '', chapterSlug, slug, contract)) {
            if (contract !== 1 && provenance.some((seen) => seen.id === ref.id)) {
              throw new BibleError(
                `chapter ${chapterSlug}.md lesson ${slug}: provenance cites ${ref.id} more than once — rebuild it from the journal with the repair tool`,
              );
            }
            provenance.push(ref);
          }
        } else if (meta[1] === 'tags') {
          tags.push(...splitTags(meta[2] ?? ''));
        }
        continue;
      }
      if (line.trim() === '') continue;
      inMeta = false;
    }
    bodyLines.push(line);
  }
  const body = bodyLines.join('\n').trim();
  if (body === '') {
    throw new BibleError(`chapter ${chapterSlug}.md lesson ${slug} has no body`);
  }
  if (tags.length === 0 && provenance.length === 0 && !sawRecurred) {
    throw new BibleError(
      `chapter ${chapterSlug}.md lesson ${slug} carries no metadata — lessons need recurred/provenance/tags`,
    );
  }
  return { slug, body, recurred, provenance, tags };
}

function splitTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

function splitProvenance(value: string, chapterSlug: string, lessonSlug: string, contract: PlanContract = PLAN_CONTRACT): ProvenanceRef[] {
  const refs: ProvenanceRef[] = [];
  for (const item of value.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
    const at = item.lastIndexOf('@');
    const id = at === -1 ? item : item.slice(0, at);
    const ts = at === -1 ? '' : item.slice(at + 1);
    if (id === '' || ts === '') {
      throw new BibleError(
        `chapter ${chapterSlug}.md lesson ${lessonSlug}: provenance ${JSON.stringify(item)} must be "<journal-id>@<iso-date>"`,
      );
    }
    if (contract !== 1 && parseIsoInstant(ts) === null) {
      throw new BibleError(
        `chapter ${chapterSlug}.md lesson ${lessonSlug}: provenance ${JSON.stringify(item)} carries an impossible or malformed instant — ` +
          'it must be "<journal-id>@<iso-date>"',
      );
    }
    if (contract !== 1 && refs.some((ref) => ref.id === id)) {
      throw new BibleError(
        `chapter ${chapterSlug}.md lesson ${lessonSlug}: provenance cites ${id} more than once — rebuild it from the journal with the repair tool`,
      );
    }
    refs.push({ id, ts });
  }
  return refs;
}

/** One raw line and the terminator that followed it ("\r\n", "\n", "\r",
 * or "" for an unterminated last line) — kept so edits never change line
 * endings. */
interface RawLine {
  readonly text: string;
  readonly eol: string;
}

interface RawSection {
  readonly heading: RawLine;
  readonly slug: string;
  readonly meta: RawLine[];
  readonly body: RawLine[];
}

function splitRawLines(text: string): RawLine[] {
  const parts = text.split(/(\r\n|\r|\n)/u);
  const lines: RawLine[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    lines.push({ text: parts[index] ?? '', eol: parts[index + 1] ?? '' });
  }
  return lines;
}

/** Split a chapter's raw lines exactly as parseChapter/parseLesson read
 * them: everything before the first `## ` anchor is the header; in each
 * lesson, leading blank/metadata lines are its metadata block and the rest
 * is its body. Joining the parts reproduces the text byte for byte. */
function splitSections(text: string): { header: RawLine[]; sections: RawSection[]; eol: string } {
  const header: RawLine[] = [];
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inMeta = false;
  const lines = splitRawLines(text);
  for (const line of lines) {
    if (line.text.startsWith('## ')) {
      current = { heading: line, slug: line.text.slice(3).trim(), meta: [], body: [] };
      sections.push(current);
      inMeta = true;
      continue;
    }
    if (current === null) {
      header.push(line);
      continue;
    }
    if (inMeta && (line.text.trim() === '' || LESSON_META_LINE.test(line.text))) {
      current.meta.push(line);
      continue;
    }
    inMeta = false;
    current.body.push(line);
  }
  return { header, sections, eol: lines.find((line) => line.eol !== '')?.eol ?? '\n' };
}

function joinSections(header: readonly RawLine[], sections: readonly RawSection[]): string {
  const join = (lines: readonly RawLine[]) => lines.map((line) => `${line.text}${line.eol}`).join('');
  return join(header) + sections.map((section) => join([section.heading, ...section.meta, ...section.body])).join('');
}

function provenanceLine(refs: readonly ProvenanceRef[]): string {
  return `provenance: ${refs.map((ref) => `${ref.id}@${ref.ts}`).join(', ')}`;
}

const PROVENANCE_FRAGMENT = /^(j-\d+)(?:@(\S+))?$/u;

/** Resolve one damaged provenance value against the journal. Only the
 * shapes found in the hand-edited book are understood — `<id>`,
 * `<id>@<iso>`, an `earlier:` list label, and `<id>,<iso>` (a timestamp
 * split off by a comma). Any other fragment, any id the journal lacks, and
 * any cited timestamp the journal contradicts abort: nothing is erased or
 * invented silently. */
function resolveDamagedProvenance(
  value: string,
  where: string,
  journalTs: ReadonlyMap<string, string>,
): ProvenanceRef[] {
  const refs: ProvenanceRef[] = [];
  let bareId: string | null = null;
  for (const raw of value.split(/[,;]/u)) {
    const fragment = raw.trim().replace(/^earlier:\s*/u, '').trim();
    if (fragment === '') continue;
    const match = PROVENANCE_FRAGMENT.exec(fragment);
    if (match !== null) {
      const id = match[1]!;
      const ts = journalTs.get(id);
      if (ts === undefined) {
        throw new BibleError(`${where} cites journal id ${id}, which is not in the journal — refusing to invent provenance`);
      }
      if (parseIsoInstant(ts) === null) {
        throw new BibleError(`the journal records ${id} at an invalid timestamp ${JSON.stringify(ts)} — fix the journal first`);
      }
      if (match[2] !== undefined && compareIsoInstants(match[2], ts) !== 0) {
        throw new BibleError(`${where} cites ${id}@${match[2]}, but the journal records ${id} at ${ts}`);
      }
      refs.push({ id, ts });
      bareId = match[2] === undefined ? id : null;
      continue;
    }
    if (bareId !== null && parseIsoInstant(fragment) !== null) {
      if (compareIsoInstants(fragment, journalTs.get(bareId) ?? '') !== 0) {
        throw new BibleError(`${where} cites ${bareId},${fragment}, but the journal records ${bareId} at ${journalTs.get(bareId)}`);
      }
      bareId = null;
      continue;
    }
    throw new BibleError(
      `${where} has an unrecognized provenance fragment ${JSON.stringify(fragment)} — the repair understands ` +
        '<id>, <id>@<iso>, "earlier:" lists and <id>,<iso>; fix it by hand from the journal',
    );
  }
  return refs;
}

/**
 * Rebuild every lesson's provenance as ONE canonical `<id>@<journal ts>`
 * line from the journal, the ground truth, editing the chapter in place:
 * every handle across the lesson's metadata block is collected, deduped
 * and ordered oldest → newest (compareProvenance), the first provenance
 * line is replaced and any others removed. Body text and every other byte
 * are untouched. Recovers the hand-edited shapes the strict parser rejects
 * (owner incident 2026-10-07) without guessing.
 */
export function repairChapterProvenance(
  text: string,
  slug: string,
  journalTs: ReadonlyMap<string, string>,
): { readonly chapter: BibleChapter; readonly text: string; readonly linesRewritten: number } {
  const { header, sections } = splitSections(text);
  const anchors = new Set<string>();
  for (const section of sections) {
    if (anchors.has(section.slug)) {
      throw new BibleError(
        `chapter ${slug}.md has more than one lesson anchored "## ${section.slug}" — the repair cannot tell them apart; fix it by hand`,
      );
    }
    anchors.add(section.slug);
  }
  let linesRewritten = 0;
  const repaired = sections.map((section) => {
    const where = `chapter ${slug}.md lesson ${section.slug}`;
    const refs: ProvenanceRef[] = [];
    for (const line of section.meta) {
      const meta = LESSON_META_LINE.exec(line.text);
      if (meta?.[1] !== 'provenance') continue;
      mergeProvenance(refs, resolveDamagedProvenance(meta[2] ?? '', where, journalTs));
    }
    refs.sort(compareProvenance);
    const meta: RawLine[] = [];
    let placed = false;
    for (const line of section.meta) {
      if (LESSON_META_LINE.exec(line.text)?.[1] !== 'provenance') {
        meta.push(line);
        continue;
      }
      if (placed || refs.length === 0) {
        linesRewritten += 1; // a duplicate (or empty) provenance line folds away
        continue;
      }
      const canonical = provenanceLine(refs);
      if (canonical !== line.text) linesRewritten += 1;
      meta.push({ text: canonical, eol: line.eol });
      placed = true;
    }
    return { ...section, meta };
  });
  const repairedText = joinSections(header, repaired);
  return { chapter: parseChapter(repairedText, slug), text: repairedText, linesRewritten };
}

/** Lessons, compared on everything the book stores. */
function sameLessons(left: readonly BibleLesson[], right: readonly BibleLesson[]): boolean {
  return JSON.stringify(left.map((lesson) => [lesson.slug, lesson.body, lesson.recurred, lesson.provenance, lesson.tags])) ===
    JSON.stringify(right.map((lesson) => [lesson.slug, lesson.body, lesson.recurred, lesson.provenance, lesson.tags]));
}

/** Apply a capped chapter to the repaired text IN PLACE: surviving lessons
 * keep their exact bytes except a released provenance handle or an
 * explicitly trimmed body; dropped lessons' sections go; a new archive
 * record is appended canonically. Null when the in-place result does not
 * re-parse to exactly the capped chapter. */
function renderCappedInPlace(text: string, capped: BibleChapter): string | null {
  const { header, sections, eol } = splitSections(text);
  const bySlug = new Map(sections.map((section) => [section.slug, section]));
  const out: RawSection[] = [];
  const lines = (body: string): RawLine[] => body.split('\n').map((line) => ({ text: line, eol }));
  for (const lesson of capped.lessons) {
    const section = bySlug.get(lesson.slug);
    if (section === undefined) {
      const last = out.at(-1);
      if (last !== undefined) {
        const tail = last.body.at(-1);
        if (tail !== undefined && tail.eol === '') last.body[last.body.length - 1] = { text: tail.text, eol };
        if ((last.body.at(-1)?.text ?? '') !== '') last.body.push({ text: '', eol });
      }
      out.push({
        heading: { text: `## ${lesson.slug}`, eol },
        slug: lesson.slug,
        meta: [
          { text: '', eol },
          { text: `recurred: ${lesson.recurred}`, eol },
          { text: provenanceLine(lesson.provenance), eol },
          ...(lesson.tags.length > 0 ? [{ text: `tags: ${lesson.tags.join(', ')}`, eol }] : []),
          { text: '', eol },
        ],
        body: lines(lesson.body.trim()),
      });
      continue;
    }
    const meta = section.meta.map((line) =>
      LESSON_META_LINE.exec(line.text)?.[1] === 'provenance' ? { text: provenanceLine(lesson.provenance), eol: line.eol } : line,
    );
    if (lesson.provenance.length > 0 && !section.meta.some((line) => LESSON_META_LINE.exec(line.text)?.[1] === 'provenance')) {
      // A section without a provenance line (an uncited archive record) that
      // now receives handles gets one, right after its last metadata line.
      let last = -1;
      meta.forEach((line, index) => {
        if (LESSON_META_LINE.test(line.text)) last = index;
      });
      meta.splice(last + 1, 0, { text: provenanceLine(lesson.provenance), eol: meta[last]?.eol || eol });
    }
    const originalBody = section.body.map((line) => line.text).join('\n').trim();
    let body = section.body;
    if (originalBody !== lesson.body) {
      const edited = trimmedBodyLines(section.body, lesson.body);
      if (edited === null) return null; // not a suffix trim — never rewrite text
      body = edited;
    }
    out.push({ ...section, meta, body });
  }
  const rendered = joinSections(header, out);
  try {
    const reparsed = parseChapter(rendered, capped.slug);
    const same = reparsed.title === capped.title && reparsed.summary === capped.summary &&
      reparsed.tags.join('\u0000') === capped.tags.join('\u0000') && sameLessons(reparsed.lessons, capped.lessons);
    return same ? rendered : null;
  } catch {
    return null;
  }
}

/** A body trimmed by the cap, edited in place: every retained line keeps
 * its exact bytes and line ending; only the cut line changes (its prefix
 * plus the trim marker) and the lines after it go. The first line keeps
 * its indentation, so an indented line that reads like metadata stays body
 * text. Null when `trimmed` is not a suffix trim of the file's body. */
function trimmedBodyLines(raw: readonly RawLine[], trimmed: string): RawLine[] | null {
  if (!trimmed.endsWith(TRIM_MARKER)) return null;
  let trailing = 0;
  while (trailing < raw.length && raw[raw.length - 1 - trailing]!.text.trim() === '') trailing += 1;
  const content = raw.slice(0, raw.length - trailing);
  // Exactly what the reader's trimStart() removed — NBSP and every other
  // Unicode space included (R5-A4) — is kept, byte for byte.
  const first = content[0]?.text ?? '';
  const indent = first.slice(0, first.length - first.trimStart().length);
  const textOf = (index: number): string => (index === 0 ? content[0]!.text.slice(indent.length) : content[index]!.text);
  const kept = trimmed.slice(0, -TRIM_MARKER.length).split('\n');
  const cut = kept.length - 1;
  if (cut >= content.length) return null;
  for (let index = 0; index < cut; index += 1) if (textOf(index) !== kept[index]) return null;
  if (!textOf(cut).startsWith(kept[cut]!)) return null;
  return [
    ...content.slice(0, cut),
    { text: `${cut === 0 ? indent : ''}${kept[cut]}${TRIM_MARKER}`, eol: content[cut]!.eol },
    ...raw.slice(raw.length - trailing),
  ];
}

/** The capped chapter written into the file in place — or a refusal: the
 * repair never falls back to re-serializing (that loses formatting and can
 * turn body text into metadata). */
function renderFaithfully(text: string, capped: BibleChapter): string {
  const rendered = renderCappedInPlace(text, capped);
  if (rendered === null) {
    throw new BibleError(
      `chapter ${capped.slug}.md cannot be fitted to the cap in place without changing what it says — fix it by hand`,
    );
  }
  return rendered;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A managed book file's text, decoded strictly (C2): a lossy decode would
 * turn different invalid bytes into the same U+FFFD, so a fingerprint could
 * not see the change. Invalid UTF-8 fails loud, naming the file. */
function strictText(raw: Buffer, file: string): string {
  try {
    return STRICT_UTF8.decode(raw);
  } catch {
    throw new BibleError(`bible file ${file} is not valid UTF-8 — fix it by hand`);
  }
}

/** One write that failed mid-repair: names what was replaced and where the
 * originals are, because the book may now be partially repaired. */
export class RepairWriteError extends BibleError {
  readonly backupDir: string;
  readonly written: readonly string[];

  constructor(message: string, backupDir: string, written: readonly string[]) {
    super(message);
    this.name = 'RepairWriteError';
    this.backupDir = backupDir;
    this.written = written;
  }
}

/** The locked work COMPLETED, but releasing the write lock afterwards
 * failed. Carries the completed result, so no caller can mistake it for
 * "nothing was written" (and, say, replay a dream batch). */
export class BibleLockReleaseError extends BibleError {
  readonly result: unknown;

  constructor(message: string, result: unknown) {
    super(message);
    this.name = 'BibleLockReleaseError';
    this.result = result;
  }
}

// ------------------------------------------------------------------
// Index rendering / parsing
// ------------------------------------------------------------------

const INDEX_HEADER = [
  '# Book of Lessons — index',
  '<!-- generated by the dreamer; do not edit by hand -->',
  '',
];

const INDEX_LINE = /^- \[([^\]]+)\]\(chapters\/([^)]+)\.md\) — (.*)$/;
/** Each compacted INDEX summary keeps at least this many bytes. */
const MIN_INDEX_SUMMARY_BYTES = 24;
const INDEX_TAGS_SUFFIX = /(.*) \(tags: (.*)\)$/;

/** Render INDEX.md under a hard byte cap. Summaries compact first, then
 * tags drop; if the chapter list still cannot fit, the dream fails loud
 * (consolidating chapters is the dreamer's job — the cap is the pressure). */
export function renderIndex(
  chapters: readonly BibleChapter[],
  capBytes: number = DEFAULT_INDEX_CAP_BYTES,
): string {
  const sorted = [...chapters].sort((a, b) => a.slug.localeCompare(b.slug));
  const build = (includeTags: boolean, summaryOf: (summary: string) => string) => {
    const lines = [...INDEX_HEADER];
    const intended = new Map<string, IndexEntryView>();
    for (const chapter of sorted) {
      const summary = summaryOf(collapseLine(chapter.summary));
      const tags = includeTags ? chapter.tags : [];
      lines.push(`- [${chapter.slug}](chapters/${chapter.slug}.md) — ${summary}${tags.length > 0 ? ` (tags: ${tags.join(', ')})` : ''}`);
      intended.set(chapter.slug, { summary, tags });
    }
    return { text: `${lines.join('\n')}\n`, intended };
  };
  const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') <= capBytes;
  // C7: briefings read exactly the metadata meant — a summary that ends
  // like a tag list would otherwise become fabricated INDEX tags.
  const readsBack = (candidate: ReturnType<typeof build>): string => {
    const parsed = new Map(parseIndex(candidate.text).map((entry) => [entry.slug, entry]));
    for (const [slug, meant] of candidate.intended) {
      const got = parsed.get(slug);
      if (got === undefined || got.summary !== meant.summary || got.tags.join('\u0000') !== meant.tags.join('\u0000')) {
        throw new BibleError(
          `chapter ${slug}'s INDEX line would read back as different metadata — a summary must not end like ` +
            'a tag list " (tags: …)"; reword the summary',
        );
      }
    }
    return candidate.text;
  };

  const full = build(true, (summary) => summary);
  if (fits(full.text)) return readsBack(full);
  const withoutTags = build(false, (summary) => summary);
  if (fits(withoutTags.text)) return readsBack(withoutTags);

  // Even without tags it does not fit: share the remaining BYTES equally
  // across summaries (C12) — each cut at a code-point boundary, its
  // ellipsis included; the metadata skeleton is fixed.
  const skeletonBytes = Buffer.byteLength(build(false, () => '').text, 'utf8');
  const perSummary = sorted.length === 0 ? 0 : Math.floor((capBytes - skeletonBytes) / sorted.length);
  if (sorted.length === 0 || perSummary < MIN_INDEX_SUMMARY_BYTES) {
    throw new BibleError(
      `bible index cap ${capBytes} bytes cannot hold ${sorted.length} chapter(s) — ` +
        'consolidate chapters (or raise lessons.index_cap_bytes)',
    );
  }
  const ellipsis = '…';
  const compacted = build(false, (summary) =>
    Buffer.byteLength(summary, 'utf8') <= perSummary
      ? summary
      : `${summary.slice(0, prefixWithinBytes(summary, perSummary - Buffer.byteLength(ellipsis, 'utf8')))}${ellipsis}`);
  if (!fits(compacted.text)) {
    throw new BibleError(`bible index compaction could not fit ${sorted.length} chapter(s) under ${capBytes} bytes`);
  }
  return readsBack(compacted);
}

/** UTF-16 length of the longest code-point prefix of `text` that fits in
 * `maxBytes` of UTF-8. */
function prefixWithinBytes(text: string, maxBytes: number): number {
  let bytes = 0;
  let length = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    length += char.length;
  }
  return length;
}

/** INDEX.md as planning contract 1 rendered it (R6-01) — kept verbatim so
 * a plan approved under it verifies after an upgrade. */
function renderIndexV1(chapters: readonly BibleChapter[], capBytes: number): string {
  const sorted = [...chapters].sort((a, b) => a.slug.localeCompare(b.slug));
  const build = (includeTags: boolean, summaryBudget: number | null): string => {
    const lines = [...INDEX_HEADER];
    for (const chapter of sorted) {
      let summary = collapseLine(chapter.summary);
      if (summaryBudget !== null && summary.length > summaryBudget) {
        summary = `${safeSlice(summary, Math.max(1, summaryBudget - 1))}…`;
      }
      const tags = includeTags && chapter.tags.length > 0 ? ` (tags: ${chapter.tags.join(', ')})` : '';
      lines.push(`- [${chapter.slug}](chapters/${chapter.slug}.md) — ${summary}${tags}`);
    }
    return `${lines.join('\n')}\n`;
  };
  const full = build(true, null);
  if (Buffer.byteLength(full, 'utf8') <= capBytes) return full;
  const withoutTags = build(false, null);
  if (Buffer.byteLength(withoutTags, 'utf8') <= capBytes) return withoutTags;
  const skeletonBytes = Buffer.byteLength(build(false, 0), 'utf8');
  const budget = sorted.length === 0 ? 0 : Math.floor((capBytes - skeletonBytes) / sorted.length) - 1;
  if (sorted.length === 0 || budget < 24) {
    throw new BibleError(`bible index cap ${capBytes} bytes cannot hold ${sorted.length} chapter(s) — consolidate chapters (or raise lessons.index_cap_bytes)`);
  }
  const compacted = build(false, budget);
  if (Buffer.byteLength(compacted, 'utf8') > capBytes) {
    throw new BibleError(`bible index compaction could not fit ${sorted.length} chapter(s) under ${capBytes} bytes`);
  }
  return compacted;
}

/** The contract a stored plan was made under (absent: the first). */
function planContract(plan: BiblePlan): PlanContract {
  return plan.contract ?? 1;
}

/** The line terminators of a planning contract: the first release split
 * on CRLF and LF only; today a bare CR ends a line too (R5-A13, R8-01). */
function lineBreaks(contract: PlanContract): RegExp {
  return contract === 1 ? /\r?\n/u : /\r\n|\r|\n/u;
}

export function parseIndex(text: string, contract: PlanContract = PLAN_CONTRACT): LessonIndexEntry[] {
  const entries: LessonIndexEntry[] = [];
  for (const line of text.split(lineBreaks(contract))) {
    const match = INDEX_LINE.exec(line);
    if (match === null) continue;
    const slug = match[1] ?? '';
    const fileSlug = match[2] ?? '';
    if (slug !== fileSlug || !isLessonsSlug(slug)) continue;
    let summary = match[3] ?? '';
    let tags: string[] = [];
    const suffix = INDEX_TAGS_SUFFIX.exec(summary);
    if (suffix !== null) {
      summary = suffix[1] ?? '';
      tags = splitTags(suffix[2] ?? '');
    }
    entries.push({ slug, summary, tags });
  }
  return entries;
}

// ------------------------------------------------------------------
// Merge + cap mechanics
// ------------------------------------------------------------------

/** Token-set similarity for near-duplicate bodies (no embeddings in v1 —
 * deterministic bag-of-words keeps the mechanic testable; the distiller's
 * explicit merge target remains the primary semantic signal). */
export const FUZZY_MERGE_THRESHOLD = 0.8;

export function bodyTokens(body: string): Set<string> {
  const tokens = body.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  return new Set(tokens.filter((token) => token.length >= 3));
}

export function bodySimilarity(a: string, b: string): number {
  const left = bodyTokens(a);
  const right = bodyTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function unionTags(existing: readonly string[], incoming: readonly string[] | undefined): string[] {
  const out = [...existing];
  for (const tag of incoming ?? []) {
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function unionProvenance(existing: readonly ProvenanceRef[], incoming: readonly ProvenanceRef[]): ProvenanceRef[] {
  const out = [...existing];
  for (const ref of incoming) {
    if (!out.some((candidate) => candidate.id === ref.id)) out.push(ref);
  }
  return out;
}

function applyLessonUpdates(
  chapter: BibleChapter,
  update: ProposedChapter,
  provenance: ReadonlyMap<string, string>,
): { chapter: BibleChapter; added: number; merged: number } {
  const lessons = [...chapter.lessons];
  let added = 0;
  let merged = 0;
  for (const proposed of update.lessons) {
    // Each journal handle once: a repeated id would fill the newest-three
    // provenance floor with copies and release distinct handles instead.
    const refs = [...new Set(proposed.journalIds)].map((id) => {
      const ts = provenance.get(id);
      if (ts === undefined) {
        throw new BibleError(
          `chapter ${update.slug} lesson ${proposed.slug} cites journal id ${id} which is not part of this dream batch`,
        );
      }
      if (parseIsoInstant(ts) === null) {
        throw new BibleError(`the journal records ${id} at an impossible or malformed instant ${JSON.stringify(ts)} — fix the journal first`);
      }
      return { id, ts };
    });
    const targetSlug = proposed.mergeInto ?? proposed.slug;
    let index = lessons.findIndex((lesson) => lesson.slug === targetSlug);
    if (proposed.mergeInto !== undefined && index === -1) {
      throw new BibleError(
        `chapter ${update.slug} lesson ${proposed.slug} says mergeInto ${proposed.mergeInto}, but no such lesson exists`,
      );
    }
    if (index === -1) {
      const fuzzy = lessons.findIndex(
        (lesson) =>
          lesson.slug !== ARCHIVED_LESSON_SLUG &&
          bodySimilarity(lesson.body, proposed.body) >= FUZZY_MERGE_THRESHOLD,
      );
      if (fuzzy !== -1) index = fuzzy;
    }
    if (index !== -1) {
      const target = lessons[index]!;
      lessons[index] = {
        ...target,
        body: proposed.body.trim(),
        recurred: target.recurred + 1,
        provenance: unionProvenance(target.provenance, refs),
        tags: unionTags(target.tags, proposed.tags),
      };
      merged += 1;
      continue;
    }
    lessons.push({
      slug: proposed.slug,
      body: proposed.body.trim(),
      recurred: 1,
      provenance: refs,
      tags: [...(proposed.tags ?? [])],
    });
    added += 1;
  }
  return {
    chapter: {
      slug: chapter.slug,
      title: update.title,
      summary: safeSlice(collapseLine(update.summary), 160),
      tags: unionTags(chapter.tags, update.tags),
      lessons,
    },
    added,
    merged,
  };
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

/** An ISO-8601 instant with a real calendar date and time — any offset,
 * any fractional precision — as whole UTC seconds plus its fraction digits
 * (trailing zeros dropped). Null for anything else, including dates
 * Date.parse would silently normalize (2026-02-30). */
/** Days in a proleptic-Gregorian month (year 0 is a leap year). */
function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** Epoch seconds of a UTC civil time, for EVERY four-digit year — never
 * Date.UTC's 0–99 → 1900–1999 mapping. */
function utcEpochSeconds(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime() / 1000;
}

export function parseIsoInstant(ts: string): { readonly seconds: number; readonly fraction: string } | null {
  const match = ISO_INSTANT.exec(ts);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  const zone = match[8]!;
  if (zone !== 'Z') {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    offset = (zone[0] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60;
  }
  return { seconds: utcEpochSeconds(year, month, day, hour, minute, second) - offset, fraction: (match[7] ?? '').replace(/0+$/u, '') };
}

/** Order two ISO instants without losing precision (no millisecond
 * truncation): negative, zero or positive; null when either is invalid. */
export function compareIsoInstants(left: string, right: string): number | null {
  const a = parseIsoInstant(left);
  const b = parseIsoInstant(right);
  if (a === null || b === null) return null;
  if (a.seconds !== b.seconds) return a.seconds - b.seconds;
  const width = Math.max(a.fraction.length, b.fraction.length);
  return a.fraction.padEnd(width, '0').localeCompare(b.fraction.padEnd(width, '0'));
}

/** The shared chronological order for journal handles: timestamp, then
 * the numeric journal sequence (`j-<seq>`), so equal timestamps never fall
 * back to insertion order. Oldest first. */
export function compareProvenance(left: ProvenanceRef, right: ProvenanceRef): number {
  // Instants, not spellings and not milliseconds: "01:00+02:00" precedes
  // "00:00Z", .0001Z precedes .0002Z, and equal instants written
  // differently tie, falling to the journal sequence.
  const byInstant = compareIsoInstants(left.ts, right.ts);
  if (byInstant === null) {
    const bad = parseIsoInstant(left.ts) === null ? left : right;
    throw new BibleError(`provenance ${bad.id}@${bad.ts} is not a valid ISO instant`);
  }
  return byInstant || journalSeq(left.id) - journalSeq(right.id) || left.id.localeCompare(right.id);
}

type ProvenanceOrder = (left: ProvenanceRef, right: ProvenanceRef) => number;

/** Contract 1's handle order, verbatim (R7-02): Date.UTC's calendar — years
 * 0–99 read as 1900–1999 — and a lexical fallback for an impossible
 * instant. Only replaying a first-release plan uses it. */
function compareProvenanceV1(left: ProvenanceRef, right: ProvenanceRef): number {
  const parse = (ts: string): { seconds: number; fraction: string } | null => {
    const match = ISO_INSTANT.exec(ts);
    if (match === null) return null;
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return null;
    let offset = 0;
    const zone = match[8]!;
    if (zone !== 'Z') {
      const hours = Number(zone.slice(1, 3));
      const minutes = Number(zone.slice(4, 6));
      if (hours > 23 || minutes > 59) return null;
      offset = (zone[0] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60;
    }
    return { seconds: Date.UTC(year, month - 1, day, hour, minute, second) / 1000 - offset, fraction: (match[7] ?? '').replace(/0+$/u, '') };
  };
  const a = parse(left.ts);
  const b = parse(right.ts);
  let byInstant: number;
  if (a === null || b === null) byInstant = left.ts.localeCompare(right.ts);
  else if (a.seconds !== b.seconds) byInstant = a.seconds - b.seconds;
  else {
    const width = Math.max(a.fraction.length, b.fraction.length);
    byInstant = a.fraction.padEnd(width, '0').localeCompare(b.fraction.padEnd(width, '0'));
  }
  return byInstant || journalSeq(left.id) - journalSeq(right.id) || left.id.localeCompare(right.id);
}

function journalSeq(id: string): number {
  const match = /^j-(\d+)$/u.exec(id);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

/** Serialized bytes one handle costs inside a provenance line that keeps
 * at least one other handle (`<id>@<ts>` plus its ", " separator). */
function handleBytes(ref: ProvenanceRef): number {
  return Buffer.byteLength(`${ref.id}@${ref.ts}`, 'utf8') + 2;
}

/**
 * Enforce the chapter byte cap. Journal handles are elastic first (owner
 * decision 2026-10-07 — old references go before any lesson text): the
 * archive record's oldest handles go first (down to one), then the oldest
 * handle of the most-cited lesson (never below the newest
 * PROVENANCE_FLOOR). Only then are lesson bodies trimmed toward the bone,
 * and finally the least-valuable lessons (lowest `recurred`, oldest
 * provenance) dropped — each dropped lesson's handles joining the ONE
 * archive record at once, so nothing vanishes without a journal handle and
 * the archive is never counted twice. Every step strictly shrinks something
 * finite, so the loop runs until the chapter fits or no step applies.
 * Deterministic and total: the returned text is <= cap or this throws.
 */
export function enforceChapterCap(
  chapter: BibleChapter,
  capBytes: number,
  /** Bytes the chapter will occupy as written (default: canonical form).
   * The repair passes its in-place renderer, so every decision is driven
   * by the real file size. */
  measure: (candidate: BibleChapter) => number = (candidate) => Buffer.byteLength(serializeChapter(candidate), 'utf8'),
  /** The planning contract whose trimming applies (R6-01). */
  contract: PlanContract = PLAN_CONTRACT,
): ChapterCapResult {
  // R6-03: an impossible instant is refused before anything is measured —
  // a chapter that already fits included. Contract 1 never checked (R7-02).
  const order = contract === 1 ? compareProvenanceV1 : compareProvenance;
  for (const lesson of contract === 1 ? [] : chapter.lessons) {
    for (const ref of lesson.provenance) {
      if (parseIsoInstant(ref.ts) === null) {
        throw new BibleError(`chapter ${chapter.slug} lesson ${lesson.slug}: provenance ${ref.id}@${ref.ts} is not a valid ISO instant`);
      }
    }
  }
  let lessons: BibleLesson[] = chapter.lessons.map((lesson) => ({ ...lesson }));
  let provenanceTrimmed = 0;
  let trimmed = 0;
  let droppedLessons = 0;
  const droppedProvenance: ProvenanceRef[] = [];
  const serialized = (): number => measure({ ...chapter, lessons });
  let size = serialized();
  if (size <= capBytes) {
    return { chapter: { ...chapter, lessons }, text: serializeChapter({ ...chapter, lessons }), provenanceTrimmed, trimmed, droppedLessons, droppedProvenance };
  }
  // Handles are released from the oldest end of each (sorted) list; the
  // offsets keep thousands of releases linear instead of re-serializing the
  // chapter on every one.
  lessons = lessons.map((lesson) => ({ ...lesson, provenance: [...lesson.provenance].sort(order) }));
  let released = lessons.map(() => 0);
  const materialize = (): void => {
    lessons = lessons.map((lesson, index) => ({ ...lesson, provenance: lesson.provenance.slice(released[index]) }));
    released = lessons.map(() => 0);
  };
  const live = (index: number): number => lessons[index]!.provenance.length - released[index]!;
  const releaseOldest = (index: number): void => {
    size -= handleBytes(lessons[index]!.provenance[released[index]!]!);
    released[index] = released[index]! + 1;
    provenanceTrimmed += 1;
  };

  const step = (): boolean => {
    const archive = lessons.findIndex((lesson) => lesson.slug === ARCHIVED_LESSON_SLUG);
    if (archive !== -1 && live(archive) > 1) {
      releaseOldest(archive);
      return true;
    }
    let widest = -1;
    for (let index = 0; index < lessons.length; index += 1) {
      if (lessons[index]!.slug === ARCHIVED_LESSON_SLUG || live(index) <= PROVENANCE_FLOOR) continue;
      if (widest === -1 || live(index) > live(widest)) widest = index;
    }
    if (widest !== -1) {
      releaseOldest(widest);
      return true;
    }
    materialize();
    if (contract === 1) {
      // Contract 1, exactly as first released: the longest body above the
      // floor, cut by the overshoot (canonical bytes).
      let longest = -1;
      for (let index = 0; index < lessons.length; index += 1) {
        const lesson = lessons[index]!;
        if (lesson.slug === ARCHIVED_LESSON_SLUG) continue;
        if (untrimmed(lesson.body).length <= MIN_LESSON_BODY_CHARS) continue;
        if (longest === -1 || untrimmed(lesson.body).length > untrimmed(lessons[longest]!.body).length) longest = index;
      }
      if (longest !== -1) {
        const lesson = lessons[longest]!;
        const body = untrimmed(lesson.body);
        const allowed = Buffer.byteLength(lesson.body, 'utf8') - (size - capBytes) - Buffer.byteLength(TRIM_MARKER, 'utf8');
        const cut = Math.max(prefixWithinBytes(body, allowed), safeSlice(body, MIN_LESSON_BODY_CHARS).length);
        lessons[longest] = { ...lesson, body: `${body.slice(0, cut).trimEnd()}${TRIM_MARKER}` };
        trimmed += 1;
        size = serialized();
        return true;
      }
    }
    // (1) shorten the longest body that can still give something up: its
    // RETAINED text — after the trailing-whitespace trim — never below the
    // floor (R6-06).
    let longest = -1;
    let cuts: number[] = [];
    for (let index = 0; index < lessons.length; index += 1) {
      const lesson = lessons[index]!;
      if (lesson.slug === ARCHIVED_LESSON_SLUG) continue;
      const body = untrimmed(lesson.body);
      if (body.length <= MIN_LESSON_BODY_CHARS) continue;
      if (longest !== -1 && body.length <= untrimmed(lessons[longest]!.body).length) continue;
      const candidate = retainedCuts(body);
      if (candidate.length === 0) continue;
      longest = index;
      cuts = candidate;
    }
    if (contract !== 1 && longest !== -1) {
      const lesson = lessons[longest]!;
      const body = untrimmed(lesson.body);
      const withCut = (cut: number): BibleLesson[] => lessons.map((other, index) =>
        index === longest ? { ...lesson, body: `${body.slice(0, cut).trimEnd()}${TRIM_MARKER}` } : other);
      // Bytes as WRITTEN (the supplied measure: CRLF and in-place
      // formatting included, R5-A1): the longest code-point prefix that
      // fits with its marker. Longer prefixes never measure smaller, so the
      // search is a bisection.
      let best = 0;
      for (let low = 1, high = cuts.length - 1; low <= high;) {
        const mid = (low + high) >> 1;
        if (measure({ ...chapter, lessons: withCut(cuts[mid]!) }) <= capBytes) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      lessons = withCut(cuts[best]!);
      trimmed += 1;
      size = serialized();
      return true;
    }
    // (2) drop the least-valuable lesson; its handles join the archive now.
    const candidate = pickDropCandidate(lessons, order);
    if (candidate === -1) return false;
    const [dropped] = lessons.splice(candidate, 1);
    released.splice(candidate, 1);
    droppedLessons += 1;
    mergeProvenance(droppedProvenance, dropped!.provenance);
    const archiveIndex = lessons.findIndex((lesson) => lesson.slug === ARCHIVED_LESSON_SLUG);
    if (dropped!.provenance.length === 0) {
      // Nothing to keep: an archive record would only cost bytes.
    } else if (archiveIndex === -1) {
      lessons.push(buildArchivedLesson([...dropped!.provenance].sort(order)));
      released.push(0);
    } else {
      const merged = [...lessons[archiveIndex]!.provenance];
      mergeProvenance(merged, dropped!.provenance);
      lessons[archiveIndex] = { ...lessons[archiveIndex]!, provenance: merged.sort(order) };
    }
    size = serialized();
    return true;
  };

  while (size > capBytes) {
    if (!step()) break;
    if (size <= capBytes) {
      materialize();
      size = serialized(); // the incremental count is re-proven exactly
    }
  }
  materialize();
  const text = serializeChapter({ ...chapter, lessons });
  if (measure({ ...chapter, lessons }) > capBytes) {
    throw new BibleError(
      `chapter ${chapter.slug} cannot fit ${capBytes} bytes even after releasing provenance, trimming and dropping — raise lessons.chapter_cap_bytes`,
    );
  }
  return { chapter: { ...chapter, lessons }, text, provenanceTrimmed, trimmed, droppedLessons, droppedProvenance };
}

/** The code-point boundaries a body may be cut at — each a strictly
 * shorter prefix whose text, once its trailing whitespace is trimmed,
 * still keeps at least the floor (R6-06). Ascending. */
function retainedCuts(body: string): number[] {
  // At least the floor itself is kept — a surrogate pair at the boundary
  // means one more unit, never one less (R7-09).
  const floor = MIN_LESSON_BODY_CHARS;
  const cuts: number[] = [];
  let kept = 0; // the trimmed length of body[0, offset)
  for (let offset = 0; offset < body.length;) {
    const width = body.codePointAt(offset)! > 0xffff ? 2 : 1;
    if (offset > 0 && kept >= floor) cuts.push(offset);
    if (!/^\s$/u.test(body.slice(offset, offset + width))) kept = offset + width;
    offset += width;
  }
  return cuts;
}

/** A body without the cap's trim marker, so a re-trim never stacks markers. */
function untrimmed(body: string): string {
  return body.endsWith(TRIM_MARKER) ? body.slice(0, -TRIM_MARKER.length) : body;
}

function mergeProvenance(target: ProvenanceRef[], incoming: readonly ProvenanceRef[]): void {
  for (const ref of incoming) {
    if (!target.some((candidate) => candidate.id === ref.id)) target.push(ref);
  }
}

function newestRef(refs: readonly ProvenanceRef[], order: ProvenanceOrder): ProvenanceRef | null {
  let newest: ProvenanceRef | null = null;
  for (const ref of refs) if (newest === null || order(ref, newest) > 0) newest = ref;
  return newest;
}

/** Lowest recurred first, then oldest newest-provenance — the lesson whose
 * loss costs the operation least. -1 when nothing is droppable. */
function pickDropCandidate(lessons: readonly BibleLesson[], order: ProvenanceOrder): number {
  let candidate = -1;
  for (let index = 0; index < lessons.length; index += 1) {
    const lesson = lessons[index]!;
    if (lesson.slug === ARCHIVED_LESSON_SLUG) continue;
    if (candidate === -1) {
      candidate = index;
      continue;
    }
    const best = lessons[candidate]!;
    const bestNewest = newestRef(best.provenance, order);
    const otherNewest = newestRef(lesson.provenance, order);
    // A lesson without any journal handle counts as the oldest: it goes
    // before every journal-backed lesson of the same recurrence.
    const olderNewest = otherNewest === null
      ? bestNewest !== null
      : bestNewest !== null && order(otherNewest, bestNewest) < 0;
    if (lesson.recurred < best.recurred || (lesson.recurred === best.recurred && olderNewest)) {
      candidate = index;
    }
  }
  return candidate;
}

function buildArchivedLesson(provenance: readonly ProvenanceRef[]): BibleLesson {
  return {
    slug: ARCHIVED_LESSON_SLUG,
    body: 'Lessons trimmed at the chapter cap; provenance retained so the journal remains the ground truth.',
    recurred: 1,
    provenance: [...provenance],
    tags: ['archived'],
  };
}

// ------------------------------------------------------------------
// Proposal validation
// ------------------------------------------------------------------

function validateProposedChapter(update: ProposedChapter): void {
  if (!isLessonsSlug(update.slug) || update.slug === ARCHIVED_LESSON_SLUG) {
    throw new BibleError(`proposed chapter slug ${JSON.stringify(update.slug)} is not a valid kebab-case slug`);
  }
  if (update.retire === true) {
    if (update.title.trim() === '') {
      throw new BibleError(`proposed chapter ${update.slug} must carry a title even when retiring`);
    }
    return;
  }
  if (update.title.trim() === '') throw new BibleError(`proposed chapter ${update.slug} has an empty title`);
  if (update.summary.trim() === '') throw new BibleError(`proposed chapter ${update.slug} has an empty summary`);
  if (/[\r\n]/u.test(update.title) || /[\r\n]/u.test(update.summary)) {
    throw new BibleError(`proposed chapter ${update.slug}: the title and summary must be single lines`);
  }
  validateProposedTags(update.slug, update.tags);
  for (const lesson of update.lessons) validateProposedLesson(update.slug, lesson);
}

function validateProposedLesson(chapterSlug: string, lesson: ProposedLesson): void {
  if (!isLessonsSlug(lesson.slug) || lesson.slug === ARCHIVED_LESSON_SLUG) {
    throw new BibleError(
      `chapter ${chapterSlug}: lesson slug ${JSON.stringify(lesson.slug)} is not a valid kebab-case slug`,
    );
  }
  if (lesson.mergeInto !== undefined && (!isLessonsSlug(lesson.mergeInto) || lesson.mergeInto === ARCHIVED_LESSON_SLUG)) {
    throw new BibleError(
      `chapter ${chapterSlug} lesson ${lesson.slug}: mergeInto ${JSON.stringify(lesson.mergeInto)} is not a valid slug`,
    );
  }
  const body = lesson.body.trim();
  if (body === '') throw new BibleError(`chapter ${chapterSlug} lesson ${lesson.slug} has an empty body`);
  if (body.length > 4_000) {
    throw new BibleError(`chapter ${chapterSlug} lesson ${lesson.slug} body exceeds 4000 characters — trim it`);
  }
  if (LESSON_META_LINE.test(body.split('\n')[0] ?? '')) {
    throw new BibleError(
      `chapter ${chapterSlug} lesson ${lesson.slug} body starts with a metadata line ` +
        `(${JSON.stringify((body.split('\n')[0] ?? '').slice(0, 40))}) — the chapter format would read it as ` +
        'recurred/provenance/tags; reword the first line',
    );
  }
  for (const line of body.split('\n')) {
    if (HEADING_LINE.test(line)) {
      throw new BibleError(
        `chapter ${chapterSlug} lesson ${lesson.slug} body contains a markdown heading line — ` +
          'bodies are prose/bullets; headings would corrupt the anchor structure',
      );
    }
  }
  if (!Array.isArray(lesson.journalIds) || lesson.journalIds.length === 0) {
    throw new BibleError(`chapter ${chapterSlug} lesson ${lesson.slug} cites no journal id — provenance is mandatory`);
  }
  validateProposedTags(lesson.slug, lesson.tags);
}

function validateProposedTags(where: string, tags: readonly string[] | undefined): void {
  if (tags === undefined) return;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
    throw new BibleError(`${where}: tags must be an array of non-empty strings`);
  }
  if (tags.some((tag) => /[\r\n,]/u.test(tag))) {
    throw new BibleError(`${where}: a tag may not contain a line break or a comma — the chapter format could not store it`);
  }
  if (tags.length > 12) throw new BibleError(`${where}: at most 12 tags`);
}
