/**
 * Book of Lessons (owner design 2026-09-23): the judgment trail is captured
 * as deliberate journal entries, distilled by the dream pass (Bob) into a
 * concise, deduplicated bible of chapters, and referenced from
 * briefings/directives as POINTERS only — never inlined bodies.
 *
 *   journal/   append-only JSONL, one file per source-day
 *   bible/     INDEX.md (hard cap) + chapters/*.md (stable anchors)
 *   dream      journal entries → chapter updates: semantic dedupe, chapter
 *              caps, provenance; only affected chapters are rewritten
 *   pointers   keyword matches against the index/chapters, rendered as
 *              "read <path>#<anchor> (why: …)" lines
 *
 * Minions read the pointed section on demand with their file tools; the
 * chapter body never travels inside a briefing.
 */

export const JOURNAL_KINDS = ['finding', 'ruling', 'observation'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export function isJournalKind(value: unknown): value is JournalKind {
  return typeof value === 'string' && (JOURNAL_KINDS as readonly string[]).includes(value);
}

/** Stable anchor slugs: kebab-case, bounded. `## <slug>` in a chapter file. */
export const LESSONS_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isLessonsSlug(value: string): boolean {
  return value.length > 0 && value.length <= 64 && LESSONS_SLUG_PATTERN.test(value);
}

/** Applier-managed lesson slug carrying provenance of cap-dropped lessons.
 * Proposal slugs may never use it. */
export const ARCHIVED_LESSON_SLUG = 'archived-provenance';

/** Named failures at the lessons boundary (never silent fallbacks). */
export class LessonsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LessonsError';
  }
}

export class JournalError extends LessonsError {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

export class BibleError extends LessonsError {
  constructor(message: string) {
    super(message);
    this.name = 'BibleError';
  }
}

export class DreamError extends LessonsError {
  constructor(message: string) {
    super(message);
    this.name = 'DreamError';
  }
}

export class LessonCaptureError extends LessonsError {
  constructor(message: string) {
    super(message);
    this.name = 'LessonCaptureError';
  }
}

/** One deliberate journal entry (append-only; the judgment trail). */
export interface JournalEntry {
  /** Global monotonic sequence — the dream cursor walks this. */
  readonly seq: number;
  /** Stable id (`j-<seq>`) used as the bible's provenance handle. */
  readonly id: string;
  /** ISO timestamp of capture. */
  readonly ts: string;
  readonly kind: JournalKind;
  /** 'gru' | 'silas' | 'owner' | 'minion:<job>' | … — who judged it. */
  readonly source: string;
  readonly tags: readonly string[];
  readonly body: string;
}

/** One provenance handle inside a lesson: journal id + its capture date. */
export interface ProvenanceRef {
  readonly id: string;
  readonly ts: string;
}

export interface BibleLesson {
  /** Stable section anchor: the `## <slug>` heading. */
  readonly slug: string;
  readonly body: string;
  /** How many times this lesson has been re-proven (1 = first capture). */
  readonly recurred: number;
  readonly provenance: readonly ProvenanceRef[];
  readonly tags: readonly string[];
}

export interface BibleChapter {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly lessons: readonly BibleLesson[];
}

/** One proposed lesson from a distiller (Bob's dream output). */
export interface ProposedLesson {
  readonly slug: string;
  readonly body: string;
  readonly tags?: readonly string[];
  /** Journal ids this proposal distills — every lesson cites provenance. */
  readonly journalIds: readonly string[];
  /** Explicit semantic-dedupe target (existing lesson slug in the chapter). */
  readonly mergeInto?: string;
}

/** One proposed chapter update from a distiller. */
export interface ProposedChapter {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly tags?: readonly string[];
  readonly lessons: readonly ProposedLesson[];
  /** Retire (delete) the chapter after carrying its lessons elsewhere. */
  readonly retire?: boolean;
}

export interface LessonIndexEntry {
  readonly slug: string;
  readonly summary: string;
  readonly tags: readonly string[];
}

/** A progressive-disclosure reference: location + reason, never a body. */
export interface LessonPointer {
  readonly chapter: string;
  /** Section anchor (lesson slug); null points at the whole chapter. */
  readonly lesson: string | null;
  /** Absolute path of the chapter file at its bible location. */
  readonly path: string;
  /** Why this section is relevant to the task at hand. */
  readonly why: string;
}

/** The injection port dispatch/ops surfaces use to populate pointer lines. */
export interface LessonsReferencePort {
  referencesFor(taskText: string): readonly LessonPointer[];
}

/** One deliberate lesson drafted by a minion in its delivery report. */
export interface LessonDraft {
  readonly kind: JournalKind;
  readonly tags: readonly string[];
  readonly body: string;
}
