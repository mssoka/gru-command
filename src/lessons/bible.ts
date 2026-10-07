import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
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
/** Cross-process write lock shared by the dream's apply and the repair. */
export const BIBLE_WRITE_LOCK = '.write.lock';

interface LockHolder {
  readonly pid: number;
  readonly token: string;
  readonly action: string;
  readonly at: string;
}

function readLockHolder(lock: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(lock, 'utf-8')) as Record<string, unknown>;
    return typeof parsed['pid'] === 'number' && Number.isSafeInteger(parsed['pid']) && parsed['pid'] > 0
      ? {
        pid: parsed['pid'],
        token: String(parsed['token'] ?? ''),
        action: String(parsed['action'] ?? 'unknown'),
        at: String(parsed['at'] ?? 'unknown'),
      }
      : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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

/** One lesson as the owner reviews it: the text it will read after the
 * update, and what it read before (null for a new lesson). */
export interface LessonChangeView {
  readonly slug: string;
  readonly body: string;
  readonly recurred: number;
  readonly previousBody: string | null;
}

/** What an update does to one chapter, for the owner's review. */
export interface ChapterChange {
  readonly slug: string;
  readonly title: string;
  readonly retired: boolean;
  readonly added: readonly LessonChangeView[];
  /** Lessons whose text or recurrence changes (handle-only changes are
   * summarized in provenanceTrimmed, not listed). */
  readonly changed: readonly LessonChangeView[];
  readonly provenanceTrimmed: number;
  readonly bodiesTrimmed: number;
  readonly lessonsDropped: number;
}

/** A fully computed, not-yet-written book update. */
export interface BiblePlan {
  /** Fingerprint of the book the plan was computed against. */
  readonly base: string;
  /** Fingerprint of the book the plan produces. */
  readonly after: string;
  readonly writes: readonly { readonly slug: string; readonly text: string }[];
  readonly retired: readonly string[];
  readonly indexText: string;
  readonly changes: readonly ChapterChange[];
  readonly report: ApplyReport;
}

export interface ChapterRepairReport {
  readonly slug: string;
  readonly changed: boolean;
  readonly linesRewritten: number;
  readonly lessonsBefore: number;
  readonly lessonsAfter: number;
  readonly provenanceTrimmed: number;
  readonly bodiesTrimmed: number;
  readonly lessonsDropped: number;
  /** `preserved`: original bytes kept apart from provenance and explicit cap
   * edits; `canonical`: re-serialized (only when in place would not fit). */
  readonly formatting: 'preserved' | 'canonical';
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
    mkdirSync(this.chaptersDir, { recursive: true, mode: 0o700 });
    const readme = join(this.dir, BIBLE_README_FILE);
    if (!existsSync(readme)) this.writeAtomic(readme, BIBLE_README);
    const index = join(this.dir, BIBLE_INDEX_FILE);
    if (!existsSync(index)) this.writeAtomic(index, renderIndex([], this.indexCapBytes));
  }

  readIndexText(): string | null {
    const file = join(this.dir, BIBLE_INDEX_FILE);
    try {
      return readFileSync(file, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw new BibleError(`bible index ${file} is unreadable: ${String(error)}`);
    }
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
      chapters.push(parseChapter(readFileSync(join(this.chaptersDir, name), 'utf-8'), slug));
    }
    return chapters;
  }

  readChapter(slug: string): BibleChapter | null {
    if (!isLessonsSlug(slug)) throw new BibleError(`invalid chapter slug: ${JSON.stringify(slug)}`);
    const file = join(this.chaptersDir, `${slug}.md`);
    try {
      return parseChapter(readFileSync(file, 'utf-8'), slug);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
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
      const planned: { readonly slug: string; readonly original: string; readonly text: string }[] = [];
      const chapters: ChapterRepairReport[] = [];
      for (const name of names) {
        const slug = name.slice(0, -'.md'.length);
        if (!isLessonsSlug(slug)) {
          throw new BibleError(`bible chapter file ${join(this.chaptersDir, name)} has an invalid slug filename`);
        }
        const original = readFileSync(join(this.chaptersDir, name), 'utf-8');
        const repaired = repairChapterProvenance(original, slug, journalTs);
        // Already fits as repaired: the bytes stay exactly as they are.
        // Otherwise every cap decision is measured on the in-place file, so
        // references still go before any text and nothing is re-serialized.
        const capped = Buffer.byteLength(repaired.text, 'utf8') <= this.chapterCapBytes
          ? { chapter: repaired.chapter, text: repaired.text, provenanceTrimmed: 0, trimmed: 0, droppedLessons: 0, droppedProvenance: [] }
          : enforceChapterCap(repaired.chapter, this.chapterCapBytes, (candidate) =>
            Buffer.byteLength(renderCappedInPlace(repaired.text, candidate) ?? serializeChapter(candidate), 'utf8'));
        const capActed = capped.provenanceTrimmed + capped.trimmed + capped.droppedLessons > 0;
        const inPlace = capActed ? renderCappedInPlace(repaired.text, capped.chapter) : repaired.text;
        const fits = inPlace !== null && Buffer.byteLength(inPlace, 'utf8') <= this.chapterCapBytes;
        const text = fits ? inPlace : capped.text;
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
          formatting: fits ? 'preserved' : 'canonical',
          bytes: Buffer.byteLength(text, 'utf8'),
        });
        if (text !== original) planned.push({ slug, original, text });
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
   * The book's cross-process write lock (`.write.lock`): the dream's apply
   * and the owner's repair both hold it across their reads and writes, so
   * neither can overwrite the other's result. Contention fails loud; a lock
   * left by a dead process is taken over with a warning.
   */
  private withWriteLock<T>(action: string, fn: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = join(this.dir, BIBLE_WRITE_LOCK);
    const token = randomUUID();
    this.acquireLock(lock, token, action);
    let result: T;
    try {
      result = fn();
    } catch (error) {
      try {
        this.releaseLock(lock, token);
      } catch (release) {
        this.log('warn', 'bible write lock release failed after an error', { lock, error: String(release) });
      }
      throw error;
    }
    // After a successful write a release failure is reported, never hidden.
    this.releaseLock(lock, token);
    return result;
  }

  /** Create the lock COMPLETE in one atomic step (a hard link of a fully
   * written temp file), so no reader ever sees a half-written lock and no
   * descriptor can leak. A dead holder's lock is replaced only under an
   * exclusive reclaim gate, after re-reading it there — two processes can
   * never both reclaim and both write. */
  private acquireLock(lock: string, token: string, action: string): void {
    const staging = `${lock}.${token}`;
    writeFileSync(staging, JSON.stringify({ pid: process.pid, token, action, at: new Date().toISOString() }), { mode: 0o600 });
    try {
      try {
        linkSync(staging, lock);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new BibleError(`cannot take the book write lock ${lock}: ${String(error)}`);
        }
      }
      const contention = (holder: LockHolder | null): BibleError =>
        new BibleError(
          holder === null
            ? `the Book of Lessons write lock ${lock} is unreadable; if no dream or repair is running, remove it and retry`
            : `the Book of Lessons is being written by pid ${holder.pid} (${holder.action}, since ${holder.at}); retry when it finishes`,
        );
      const seen = readLockHolder(lock);
      if (seen === null || processAlive(seen.pid)) throw contention(seen);
      const gate = `${lock}.reclaim`;
      try {
        mkdirSync(gate);
      } catch {
        throw new BibleError(`another process is reclaiming the Book of Lessons write lock ${lock}; retry`);
      }
      try {
        const holder = readLockHolder(lock);
        if (holder === null || holder.token !== seen.token || processAlive(holder.pid)) throw contention(holder);
        this.log('warn', 'bible write lock left by a dead process — taking it over', {
          lock,
          holder_pid: holder.pid,
          holder_action: holder.action,
        });
        renameSync(staging, lock); // atomic replace, under the gate
      } finally {
        rmSync(gate, { recursive: true, force: true });
      }
    } finally {
      rmSync(staging, { force: true });
    }
  }

  /** Release only THIS acquisition's lock — never one another process now holds. */
  private releaseLock(lock: string, token: string): void {
    const holder = readLockHolder(lock);
    if (holder?.token === token) unlinkSync(lock);
  }

  /**
   * Plan distiller updates WITHOUT writing: dedupe (explicit merge target,
   * stable slug, or near-identical body), bump `recurred`, union
   * provenance, enforce the chapter cap, render the index. The plan names
   * the exact book it was computed against (`base`) and the book it
   * produces (`after`), plus a per-chapter review of what changes — the
   * owner decides on that review before anything is written (owner
   * decision 2026-10-07). Any validation failure throws before planning
   * completes.
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

    for (const update of updates) {
      validateProposedChapter(update);
      if (update.retire === true) {
        if (chapters.delete(update.slug)) retired.add(update.slug);
        touched.add(update.slug);
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
    const writes: { slug: string; text: string }[] = [];
    const changes: ChapterChange[] = [];
    for (const chapter of chapters.values()) {
      if (!touched.has(chapter.slug)) {
        finalChapters.push(chapter);
        continue;
      }
      if (retired.has(chapter.slug)) continue;
      const capped = enforceChapterCap(chapter, this.chapterCapBytes);
      lessonsTrimmed += capped.trimmed;
      lessonsDropped += capped.droppedLessons;
      finalChapters.push(capped.chapter);
      writes.push({ slug: chapter.slug, text: capped.text });
      changes.push(describeChapterChange(original.get(chapter.slug) ?? null, capped));
    }
    for (const slug of retired) {
      const before = original.get(slug);
      changes.push({
        slug,
        title: before?.title ?? slug,
        retired: true,
        added: [],
        changed: [],
        provenanceTrimmed: 0,
        bodiesTrimmed: 0,
        lessonsDropped: before?.lessons.filter((lesson) => lesson.slug !== ARCHIVED_LESSON_SLUG).length ?? 0,
      });
    }

    // Render the index BEFORE any write: a cap failure must leave the whole
    // bible untouched (otherwise a retried dream could double-count
    // recurrences over half-applied state).
    const indexText = renderIndex(finalChapters, this.indexCapBytes);

    const after = new Map(files);
    for (const write of writes) after.set(`${BIBLE_CHAPTERS_DIR}/${write.slug}.md`, write.text);
    for (const slug of retired) after.delete(`${BIBLE_CHAPTERS_DIR}/${slug}.md`);
    after.set(BIBLE_INDEX_FILE, indexText);

    return {
      base: bookFingerprint(files),
      after: bookFingerprint(after),
      writes,
      retired: [...retired],
      indexText,
      changes,
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
   * Write a plan, but only onto the exact book it was computed against: a
   * moved book is a ProposalError('stale') with nothing written. A book
   * that already equals the plan's result is a no-op (an accept retried
   * after a crash between writing and bookkeeping).
   */
  applyPlan(plan: BiblePlan): ApplyReport {
    const current = bookFingerprint(this.snapshotFiles());
    if (current === plan.after) return plan.report;
    if (current !== plan.base) {
      throw new ProposalError(
        'stale',
        'the Book of Lessons changed since this update was planned; nothing was written',
      );
    }
    for (const write of plan.writes) {
      this.writeAtomic(join(this.chaptersDir, `${write.slug}.md`), write.text);
    }
    for (const slug of plan.retired) {
      rmSync(join(this.chaptersDir, `${slug}.md`), { force: true });
    }
    this.writeAtomic(join(this.dir, BIBLE_INDEX_FILE), plan.indexText);

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

  /** Plan and write in one step — tests and owner-run tooling only; the
   * service's dream proposes and waits for the owner. */
  applyUpdates(
    updates: readonly ProposedChapter[],
    provenance: ReadonlyMap<string, string>,
  ): ApplyReport {
    return this.applyPlan(this.planUpdates(updates, provenance));
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
      files.set(`${BIBLE_CHAPTERS_DIR}/${name}`, readFileSync(join(this.chaptersDir, name), 'utf-8'));
    }
    return files;
  }

  private writeAtomic(file: string, text: string): void {
    const staging = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(staging, text, 'utf-8');
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

function describeChapterChange(before: BibleChapter | null, capped: ChapterCapResult): ChapterChange {
  const previous = new Map(
    (before?.lessons ?? [])
      .filter((lesson) => lesson.slug !== ARCHIVED_LESSON_SLUG)
      .map((lesson) => [lesson.slug, lesson]),
  );
  const added: LessonChangeView[] = [];
  const changed: LessonChangeView[] = [];
  for (const lesson of capped.chapter.lessons) {
    if (lesson.slug === ARCHIVED_LESSON_SLUG) continue;
    const prior = previous.get(lesson.slug);
    if (prior === undefined) {
      added.push({ slug: lesson.slug, body: lesson.body, recurred: lesson.recurred, previousBody: null });
    } else if (prior.body !== lesson.body || prior.recurred !== lesson.recurred) {
      changed.push({ slug: lesson.slug, body: lesson.body, recurred: lesson.recurred, previousBody: prior.body });
    }
  }
  return {
    slug: capped.chapter.slug,
    title: capped.chapter.title,
    retired: false,
    added,
    changed,
    provenanceTrimmed: capped.provenanceTrimmed,
    bodiesTrimmed: capped.trimmed,
    lessonsDropped: capped.droppedLessons,
  };
}

// ------------------------------------------------------------------
// Chapter serialization / parsing (the pinned format)
// ------------------------------------------------------------------

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

export function parseChapter(text: string, slug: string): BibleChapter {
  if (!isLessonsSlug(slug)) throw new BibleError(`invalid chapter slug: ${JSON.stringify(slug)}`);
  const lines = text.split(/\r?\n/);
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
    lessons.push(parseLesson(slug, section.slug, section.lines));
  }
  return { slug, title, summary, tags: chapterTags, lessons };
}

function parseLesson(chapterSlug: string, slug: string, lines: readonly string[]): BibleLesson {
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
          provenance.push(...splitProvenance(meta[2] ?? '', chapterSlug, slug));
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

function splitProvenance(value: string, chapterSlug: string, lessonSlug: string): ProvenanceRef[] {
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
    refs.push({ id, ts });
  }
  return refs;
}

/** One raw line and the terminator that followed it ("\r\n", "\n", or ""
 * for an unterminated last line) — kept so edits never change line endings. */
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
  const parts = text.split(/(\r\n|\n)/u);
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
const ISO_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u;

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
      if (Number.isNaN(Date.parse(ts))) {
        throw new BibleError(`the journal records ${id} at an invalid timestamp ${JSON.stringify(ts)} — fix the journal first`);
      }
      if (match[2] !== undefined && Date.parse(match[2]) !== Date.parse(ts)) {
        throw new BibleError(`${where} cites ${id}@${match[2]}, but the journal records ${id} at ${ts}`);
      }
      refs.push({ id, ts });
      bareId = match[2] === undefined ? id : null;
      continue;
    }
    if (bareId !== null && ISO_TIMESTAMP.test(fragment)) {
      if (Date.parse(fragment) !== Date.parse(journalTs.get(bareId) ?? '')) {
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
    const originalBody = section.body.map((line) => line.text).join('\n').trim();
    let body = section.body;
    if (originalBody !== lesson.body) {
      let trailing = 0;
      while (trailing < section.body.length && section.body[section.body.length - 1 - trailing]!.text.trim() === '') trailing += 1;
      body = [...lines(lesson.body.trim()), ...section.body.slice(section.body.length - trailing)];
    }
    out.push({ ...section, meta, body });
  }
  const rendered = joinSections(header, out);
  try {
    const reparsed = parseChapter(rendered, capped.slug);
    return sameLessons(reparsed.lessons, capped.lessons) ? rendered : null;
  } catch {
    return null;
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

// ------------------------------------------------------------------
// Index rendering / parsing
// ------------------------------------------------------------------

const INDEX_HEADER = [
  '# Book of Lessons — index',
  '<!-- generated by the dreamer; do not edit by hand -->',
  '',
];

const INDEX_LINE = /^- \[([^\]]+)\]\(chapters\/([^)]+)\.md\) — (.*)$/;
const INDEX_TAGS_SUFFIX = /(.*) \(tags: (.*)\)$/;

/** Render INDEX.md under a hard byte cap. Summaries compact first, then
 * tags drop; if the chapter list still cannot fit, the dream fails loud
 * (consolidating chapters is the dreamer's job — the cap is the pressure). */
export function renderIndex(
  chapters: readonly BibleChapter[],
  capBytes: number = DEFAULT_INDEX_CAP_BYTES,
): string {
  const sorted = [...chapters].sort((a, b) => a.slug.localeCompare(b.slug));
  const build = (includeTags: boolean, summaryBudget: number | null): string => {
    const lines = [...INDEX_HEADER];
    for (const chapter of sorted) {
      let summary = collapseLine(chapter.summary);
      if (summaryBudget !== null && summary.length > summaryBudget) {
        summary = `${summary.slice(0, Math.max(1, summaryBudget - 1))}…`;
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

  // Even without tags it does not fit: budget the remaining bytes equally
  // across summaries (the metadata skeleton is fixed).
  const skeleton = build(false, 0);
  const skeletonBytes = Buffer.byteLength(skeleton, 'utf8');
  const available = capBytes - skeletonBytes;
  const budget = sorted.length === 0 ? 0 : Math.floor(available / sorted.length) - 1;
  if (sorted.length === 0 || budget < 24) {
    throw new BibleError(
      `bible index cap ${capBytes} bytes cannot hold ${sorted.length} chapter(s) — ` +
        'consolidate chapters (or raise lessons.index_cap_bytes)',
    );
  }
  const compacted = build(false, budget);
  if (Buffer.byteLength(compacted, 'utf8') > capBytes) {
    throw new BibleError(`bible index compaction could not fit ${sorted.length} chapter(s) under ${capBytes} bytes`);
  }
  return compacted;
}

export function parseIndex(text: string): LessonIndexEntry[] {
  const entries: LessonIndexEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
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
    const refs = proposed.journalIds.map((id) => {
      const ts = provenance.get(id);
      if (ts === undefined) {
        throw new BibleError(
          `chapter ${update.slug} lesson ${proposed.slug} cites journal id ${id} which is not part of this dream batch`,
        );
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
      summary: collapseLine(update.summary).slice(0, 160),
      tags: unionTags(chapter.tags, update.tags),
      lessons,
    },
    added,
    merged,
  };
}

/** The shared chronological order for journal handles: timestamp, then
 * the numeric journal sequence (`j-<seq>`), so equal timestamps never fall
 * back to insertion order. Oldest first. */
export function compareProvenance(left: ProvenanceRef, right: ProvenanceRef): number {
  const leftAt = Date.parse(left.ts);
  const rightAt = Date.parse(right.ts);
  // Instants, not spellings: "01:00+02:00" precedes "00:00Z", and equal
  // instants written differently tie, falling to the journal sequence.
  const byInstant = Number.isNaN(leftAt) || Number.isNaN(rightAt) ? left.ts.localeCompare(right.ts) : leftAt - rightAt;
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
): ChapterCapResult {
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
  lessons = lessons.map((lesson) => ({ ...lesson, provenance: [...lesson.provenance].sort(compareProvenance) }));
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
    // (1) shorten the longest trimmable body by the overshoot.
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
      const nextLength = Math.max(MIN_LESSON_BODY_CHARS, body.length - (size - capBytes) - TRIM_MARKER.length);
      lessons[longest] = { ...lesson, body: `${body.slice(0, nextLength).trimEnd()}${TRIM_MARKER}` };
      trimmed += 1;
      size = serialized();
      return true;
    }
    // (2) drop the least-valuable lesson; its handles join the archive now.
    const candidate = pickDropCandidate(lessons);
    if (candidate === -1) return false;
    const [dropped] = lessons.splice(candidate, 1);
    released.splice(candidate, 1);
    droppedLessons += 1;
    mergeProvenance(droppedProvenance, dropped!.provenance);
    const archiveIndex = lessons.findIndex((lesson) => lesson.slug === ARCHIVED_LESSON_SLUG);
    if (archiveIndex === -1) {
      lessons.push(buildArchivedLesson([...dropped!.provenance].sort(compareProvenance)));
      released.push(0);
    } else {
      const merged = [...lessons[archiveIndex]!.provenance];
      mergeProvenance(merged, dropped!.provenance);
      lessons[archiveIndex] = { ...lessons[archiveIndex]!, provenance: merged.sort(compareProvenance) };
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

/** A body without the cap's trim marker, so a re-trim never stacks markers. */
function untrimmed(body: string): string {
  return body.endsWith(TRIM_MARKER) ? body.slice(0, -TRIM_MARKER.length) : body;
}

function mergeProvenance(target: ProvenanceRef[], incoming: readonly ProvenanceRef[]): void {
  for (const ref of incoming) {
    if (!target.some((candidate) => candidate.id === ref.id)) target.push(ref);
  }
}

function newestRef(refs: readonly ProvenanceRef[]): ProvenanceRef | null {
  let newest: ProvenanceRef | null = null;
  for (const ref of refs) if (newest === null || compareProvenance(ref, newest) > 0) newest = ref;
  return newest;
}

/** Lowest recurred first, then oldest newest-provenance — the lesson whose
 * loss costs the operation least. -1 when nothing is droppable. */
function pickDropCandidate(lessons: readonly BibleLesson[]): number {
  let candidate = -1;
  for (let index = 0; index < lessons.length; index += 1) {
    const lesson = lessons[index]!;
    if (lesson.slug === ARCHIVED_LESSON_SLUG) continue;
    if (candidate === -1) {
      candidate = index;
      continue;
    }
    const best = lessons[candidate]!;
    const bestNewest = newestRef(best.provenance);
    const otherNewest = newestRef(lesson.provenance);
    // A lesson without any journal handle counts as the oldest: it goes
    // before every journal-backed lesson of the same recurrence.
    const olderNewest = otherNewest === null
      ? bestNewest !== null
      : bestNewest !== null && compareProvenance(otherNewest, bestNewest) < 0;
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
  if (tags.length > 12) throw new BibleError(`${where}: at most 12 tags`);
}
