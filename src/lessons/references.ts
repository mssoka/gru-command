import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { BibleStore } from './bible.js';
import { parseIndex } from './bible.js';
import type {
  BibleChapter,
  LessonIndexEntry,
  LessonPointer,
  LessonsReferencePort,
} from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Progressive-disclosure references: match task keywords against the
 * bible INDEX (plus chapter/lesson tags and anchors) and emit POINTER
 * lines — location + reason. Chapter bodies are never inlined; the
 * pointed-to file stays where it is and the minion reads it on demand.
 *
 * v1 is grep-level matching by design: deterministic, explainable, no
 * embeddings. The index stays the primary surface — pointers derived from
 * chapter metadata are a refinement, not a replacement.
 */

export const DEFAULT_MAX_REFERENCES = 3;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when',
  'task', 'briefing', 'please', 'make', 'sure', 'job', 'repo', 'project',
  'code', 'worktree', 'branch', 'pull', 'request', 'review', 'about',
  'after', 'before', 'should', 'must', 'will', 'then', 'than', 'them',
  'they', 'have', 'has', 'not', 'but', 'all', 'any', 'our', 'your',
]);

/** Lowercased stemmed keywords from free text (plurals and common verb
 * endings fold together so "restarting" matches a "restarts" tag). */
export function taskTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  const terms: string[] = [];
  for (const word of words) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    const stem = stemWord(word);
    if (!terms.includes(stem)) terms.push(stem);
  }
  return terms;
}

function stemWord(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokensOf(text: string): Set<string> {
  return new Set(taskTerms(text));
}

interface ScoredChapter {
  readonly entry: LessonIndexEntry;
  readonly chapter: BibleChapter | null;
  readonly score: number;
  readonly matched: string[];
  readonly lessons: ScoredLesson[];
}

interface ScoredLesson {
  readonly slug: string;
  readonly score: number;
  readonly matched: string[];
}

/**
 * Score index entries + (when chapters are available) lessons against the
 * task terms. Tags weigh most (curated keywords), then slugs/anchors,
 * then summaries.
 */
export function matchReferences(input: {
  readonly index: readonly LessonIndexEntry[];
  readonly chapters?: readonly BibleChapter[];
  readonly taskText: string;
  readonly max?: number;
  /** Absolute bible dir; chapter pointer paths are built under it. */
  readonly bibleDir: string;
}): LessonPointer[] {
  const max = Math.max(0, input.max ?? DEFAULT_MAX_REFERENCES);
  if (max === 0) return [];
  const terms = taskTerms(input.taskText);
  if (terms.length === 0) return [];
  const chapterBySlug = new Map((input.chapters ?? []).map((chapter) => [chapter.slug, chapter]));

  const scored: ScoredChapter[] = [];
  for (const entry of input.index) {
    const chapter = chapterBySlug.get(entry.slug) ?? null;
    const matched = new Set<string>();
    let score = 0;
    for (const term of terms) {
      if (entry.tags.some((tag) => tokensOf(tag).has(term))) {
        score += 3;
        matched.add(term);
      }
      if (tokensOf(entry.slug).has(term)) {
        score += 2;
        matched.add(term);
      }
      if (tokensOf(entry.summary).has(term)) {
        score += 1;
        matched.add(term);
      }
    }
    const lessons: ScoredLesson[] = [];
    if (chapter !== null) {
      for (const lesson of chapter.lessons) {
        const lessonMatched = new Set<string>();
        let lessonScore = 0;
        for (const term of terms) {
          if (lesson.tags.some((tag) => tokensOf(tag).has(term))) {
            lessonScore += 4;
            lessonMatched.add(term);
          }
          if (tokensOf(lesson.slug).has(term)) {
            lessonScore += 3;
            lessonMatched.add(term);
          }
        }
        if (lessonScore > 0) {
          lessons.push({ slug: lesson.slug, score: lessonScore, matched: [...lessonMatched] });
          for (const term of lessonMatched) matched.add(term);
        }
      }
      lessons.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
    }
    if (score > 0 || lessons.length > 0) {
      scored.push({ entry, chapter, score, matched: [...matched], lessons });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.entry.slug.localeCompare(b.entry.slug));

  const pointers: LessonPointer[] = [];
  const usedChapters = new Set<string>();
  // Lesson pointers first (more specific), then chapter pointers for
  // chapters that contributed no lesson hit.
  for (const item of scored) {
    for (const lesson of item.lessons) {
      if (pointers.length >= max) break;
      pointers.push({
        chapter: item.entry.slug,
        lesson: lesson.slug,
        path: join(input.bibleDir, 'chapters', `${item.entry.slug}.md`),
        why: whyFor(lesson.matched),
      });
      usedChapters.add(item.entry.slug);
    }
    if (pointers.length >= max) break;
  }
  for (const item of scored) {
    if (pointers.length >= max) break;
    if (usedChapters.has(item.entry.slug) && item.lessons.length > 0) continue;
    if (item.score <= 0) continue;
    pointers.push({
      chapter: item.entry.slug,
      lesson: null,
      path: join(input.bibleDir, 'chapters', `${item.entry.slug}.md`),
      why: whyFor(item.matched),
    });
  }
  return pointers;
}

function whyFor(terms: readonly string[]): string {
  const unique = [...new Set(terms)].slice(0, 4);
  return `task mentions ${unique.join(', ')}`;
}

/** One pointer line: location + reason, never content. */
export function renderPointerLine(pointer: LessonPointer): string {
  const anchor = pointer.lesson !== null ? `#${pointer.lesson}` : '';
  return `- read ${pointer.path}${anchor} (why: ${pointer.why})`;
}

export const LESSONS_SECTION_HEADING =
  'RELEVANT LESSONS (pointers only — read the section at its path on demand; nothing is inlined):';

/** The optional "Relevant lessons" block; empty string when no pointers
 * (templates then omit the section entirely). */
export function renderLessonsSection(pointers: readonly LessonPointer[]): string {
  if (pointers.length === 0) return '';
  return [LESSONS_SECTION_HEADING, ...pointers.map(renderPointerLine)].join('\n');
}

/** Append pointer lines to an existing prompt/directive (no-op when none). */
export function appendLessonPointers(text: string, pointers: readonly LessonPointer[]): string {
  const section = renderLessonsSection(pointers);
  return section === '' ? text : `${text}\n\n${section}`;
}

/** The production reference port: reads the index + chapters on demand.
 * Matching failures are LOGGED and degrade to no pointers — memory is
 * advisory and must never block a dispatch (the log is the loud part). */
export function createBibleReferences(opts: {
  readonly bible: BibleStore;
  readonly maxReferences?: number;
  readonly log?: Log;
}): LessonsReferencePort {
  const max = opts.maxReferences ?? DEFAULT_MAX_REFERENCES;
  const log = opts.log ?? (() => {});
  return {
    referencesFor(taskText: string): readonly LessonPointer[] {
      try {
        const indexText = opts.bible.readIndexText();
        if (indexText === null) return [];
        const entries = parseIndex(indexText);
        if (entries.length === 0) return [];
        let chapters: BibleChapter[] = [];
        try {
          chapters = opts.bible.readChapters();
        } catch (error) {
          log('warn', 'bible chapters unreadable during reference matching — index-level pointers only', {
            error: String(error),
          });
        }
        return matchReferences({ index: entries, chapters, taskText, max, bibleDir: opts.bible.dir });
      } catch (error) {
        log('error', 'lesson reference matching failed — briefing continues without pointers', {
          error: String(error),
        });
        return [];
      }
    },
  };
}
