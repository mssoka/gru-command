import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import {
  ARCHIVED_LESSON_SLUG,
  BibleError,
  isLessonsSlug,
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

/** Below this a lesson body is "trimmed to the bone" — cap enforcement
 * shortens bodies down to it, then starts dropping least-valuable lessons. */
const MIN_LESSON_BODY_CHARS = 160;

export const BIBLE_README = `# Book of Lessons — how this directory works

The book is the operation's long-term memory: a concise, deduplicated
record of lessons worth keeping. It is NOT a log — the journal
(../journal/) is the append-only capture; this is the distillation.

## Who writes what

- The **journal** captures deliberate entries (findings, rulings,
  observations) with provenance. Gru and Silas append through the
  service's authenticated API; a minion's delivery report may end with an
  optional \`lessons\` block the host extracts.
- The **dream** (Bob, on a cadence) reads journal entries newer than the
  last dream, merges repeats into existing lessons (bumping
  \`recurred\`), and rewrites only the affected chapters. It never pastes
  journal text verbatim and never invents events.
- This directory is machine-managed: **do not hand-edit chapters or
  INDEX.md**. Corrections go through the journal and the next dream.

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
  readonly trimmed: number;
  readonly droppedLessons: number;
  readonly droppedProvenance: readonly ProvenanceRef[];
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
   * Apply distiller updates: dedupe (explicit merge target, stable slug,
   * or near-identical body), bump `recurred`, union provenance, enforce
   * the chapter cap, rewrite ONLY touched chapters, regenerate the index.
   * Any validation failure aborts before a single file is written.
   */
  applyUpdates(
    updates: readonly ProposedChapter[],
    provenance: ReadonlyMap<string, string>,
  ): ApplyReport {
    const chapters = new Map(this.readChapters().map((chapter) => [chapter.slug, chapter]));
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

    let chaptersWritten = 0;
    const finalChapters: BibleChapter[] = [];
    const plannedWrites: { slug: string; text: string }[] = [];
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
      plannedWrites.push({ slug: chapter.slug, text: capped.text });
    }

    // Render the index BEFORE any write: a cap failure must leave the whole
    // bible untouched (otherwise a retried dream could double-count
    // recurrences over half-applied state).
    const indexText = renderIndex(finalChapters, this.indexCapBytes);

    for (const write of plannedWrites) {
      this.writeAtomic(join(this.chaptersDir, `${write.slug}.md`), write.text);
      chaptersWritten += 1;
    }
    for (const slug of retired) {
      rmSync(join(this.chaptersDir, `${slug}.md`), { force: true });
    }
    this.writeAtomic(join(this.dir, BIBLE_INDEX_FILE), indexText);

    this.log('info', 'bible updated', {
      chapters_written: chaptersWritten,
      chapters_retired: retired.size,
      lessons_added: lessonsAdded,
      lessons_merged: lessonsMerged,
      lessons_trimmed: lessonsTrimmed,
      lessons_dropped: lessonsDropped,
      index_bytes: Buffer.byteLength(indexText, 'utf8'),
    });
    return {
      chaptersWritten,
      chaptersRetired: retired.size,
      lessonsAdded,
      lessonsMerged,
      lessonsTrimmed,
      lessonsDropped,
    };
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

/**
 * Enforce the chapter byte cap: trim lesson bodies toward the bone, then
 * drop the least-valuable lessons (lowest `recurred`, oldest provenance)
 * into an `archived-provenance` record so nothing vanishes without a
 * journal handle. Deterministic and total: the returned text is <= cap or
 * the function throws.
 */
export function enforceChapterCap(chapter: BibleChapter, capBytes: number): ChapterCapResult {
  const lessons = chapter.lessons.map((lesson) => ({ ...lesson }));
  let trimmed = 0;
  let droppedLessons = 0;
  const droppedProvenance: ProvenanceRef[] = [];
  const size = (candidate: BibleChapter): number =>
    Buffer.byteLength(serializeChapter(candidate), 'utf8');
  let current: BibleChapter = { ...chapter, lessons };

  const rebuild = (): void => {
    current = { ...chapter, lessons };
  };
  rebuild();

  for (let guard = 0; guard < 1_000; guard += 1) {
    if (size(current) <= capBytes) break;
    // (1) shorten the longest trimmable body by the overshoot.
    let longest = -1;
    for (let index = 0; index < lessons.length; index += 1) {
      const lesson = lessons[index]!;
      if (lesson.slug === ARCHIVED_LESSON_SLUG) continue;
      if (lesson.body.length <= MIN_LESSON_BODY_CHARS + TRIM_MARKER.length) continue;
      if (longest === -1 || lesson.body.length > lessons[longest]!.body.length) longest = index;
    }
    if (longest !== -1) {
      const overshoot = size(current) - capBytes;
      const lesson = lessons[longest]!;
      const nextLength = Math.max(
        MIN_LESSON_BODY_CHARS,
        lesson.body.length - overshoot - TRIM_MARKER.length,
      );
      lessons[longest] = {
        ...lesson,
        body: `${lesson.body.slice(0, nextLength).trimEnd()}${TRIM_MARKER}`,
      };
      trimmed += 1;
      rebuild();
      continue;
    }
    // (2) drop the least-valuable lesson, keeping its provenance handle.
    const candidate = pickDropCandidate(lessons);
    if (candidate === -1) break;
    const [dropped] = lessons.splice(candidate, 1);
    if (dropped !== undefined) {
      droppedLessons += 1;
      mergeProvenance(droppedProvenance, dropped.provenance);
    }
    rebuild();
  }

  if (droppedProvenance.length > 0) {
    // The archive must fit WITH the surviving lessons: make room by
    // dropping further low-value lessons before shrinking provenance.
    let archived = buildArchivedLesson(droppedProvenance);
    while (
      size(withArchive(chapter, lessons, archived)) > capBytes &&
      pickDropCandidate(lessons) !== -1
    ) {
      const candidate = pickDropCandidate(lessons);
      const [dropped] = lessons.splice(candidate, 1);
      if (dropped === undefined) break;
      droppedLessons += 1;
      mergeProvenance(droppedProvenance, dropped.provenance);
      archived = buildArchivedLesson(droppedProvenance);
    }
    const existing = lessons.findIndex((lesson) => lesson.slug === ARCHIVED_LESSON_SLUG);
    if (existing !== -1) {
      const merged = [...lessons[existing]!.provenance];
      mergeProvenance(merged, droppedProvenance);
      lessons[existing] = { ...archived, provenance: merged };
    } else {
      lessons.push(archived);
    }
    rebuild();
  }

  // Final squeeze: the archived provenance list is the only elastic part.
  for (let guard = 0; size(current) > capBytes && guard < 100; guard += 1) {
    const archivedIndex = lessons.findIndex((lesson) => lesson.slug === ARCHIVED_LESSON_SLUG);
    if (archivedIndex === -1) break;
    const archived = lessons[archivedIndex]!;
    if (archived.provenance.length <= 1) break;
    lessons[archivedIndex] = { ...archived, provenance: archived.provenance.slice(1) };
    rebuild();
  }
  if (size(current) > capBytes) {
    throw new BibleError(
      `chapter ${chapter.slug} cannot fit ${capBytes} bytes even after trimming and dropping — raise lessons.chapter_cap_bytes`,
    );
  }
  return { chapter: current, text: serializeChapter(current), trimmed, droppedLessons, droppedProvenance };
}

function withArchive(
  chapter: BibleChapter,
  lessons: readonly BibleLesson[],
  archived: BibleLesson,
): BibleChapter {
  return { ...chapter, lessons: [...lessons, archived] };
}

function mergeProvenance(target: ProvenanceRef[], incoming: readonly ProvenanceRef[]): void {
  for (const ref of incoming) {
    if (!target.some((candidate) => candidate.id === ref.id)) target.push(ref);
  }
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
    const bestNewest = best.provenance.at(-1)?.ts ?? '';
    const otherNewest = lesson.provenance.at(-1)?.ts ?? '';
    if (
      lesson.recurred < best.recurred ||
      (lesson.recurred === best.recurred && otherNewest < bestNewest)
    ) {
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
