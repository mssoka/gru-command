/**
 * The owner's reading of a Book of Lessons proposal (owner redesign
 * 2026-11-26): plain counts, the things that deserve a careful look, and a
 * word-level diff of every reworded lesson. Pure functions over the review
 * payload the server already sends — no model call, nothing the owner did
 * not see becomes hidden: every change the review carries stays visible.
 */
import {
  ARCHIVED_LESSON_SLUG,
  LESSON_TRIM_MARKER,
  type LessonChangeView,
  type LessonChapterChangeView,
  type LessonIndexChangeView,
  type LessonProposalView,
  type RemovedLessonView,
} from './board-protocol.js';

/** One run of a diff: unchanged text, or a change (what goes, what comes). */
export type DiffSegment =
  | { readonly kind: 'same'; readonly text: string }
  | { readonly kind: 'change'; readonly removed: string; readonly added: string };

export interface WordDiff {
  readonly segments: readonly DiffSegment[];
  /** Changed characters over both texts' length: 0 = identical, 1 = nothing kept. */
  readonly ratio: number;
}

/** At or above this share of changed text a lesson is shown before and
 * after side by side; below it, as one paragraph with the changes marked
 * (owner pick "D · Mix", 2026-11-26). */
export const REWRITE_RATIO = 0.45;

/** Above this many token pairs the diff gives up on word alignment and
 * reports the whole text as replaced (a lesson is ~150 words; the guard
 * only bounds memory on a pathological body). */
const MAX_DIFF_CELLS = 4_000_000;

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** A short unchanged bit (a space, or one or two short words) between two
 * changes is folded into them, so a rewritten clause reads as one change
 * instead of a confetti of single words. */
function foldable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  return trimmed.split(/\s+/u).length <= 2 && trimmed.length <= 14;
}

/** Word-level diff (longest common subsequence over words, spaces and
 * punctuation). Deterministic; the concatenated `same`+`removed` text is
 * exactly `before`, and `same`+`added` is exactly `after`. */
export function wordDiff(before: string, after: string): WordDiff {
  if (before === after) return { segments: before === '' ? [] : [{ kind: 'same', text: before }], ratio: 0 };
  const a = tokens(before);
  const b = tokens(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const raw: { kind: 'same' | 'change'; text: string; removed: string; added: string }[] = [];
  const same = (text: string): void => {
    const last = raw[raw.length - 1];
    if (last?.kind === 'same') last.text += text;
    else raw.push({ kind: 'same', text, removed: '', added: '' });
  };
  const change = (side: 'removed' | 'added', text: string): void => {
    let last = raw[raw.length - 1];
    if (last?.kind !== 'change') {
      last = { kind: 'change', text: '', removed: '', added: '' };
      raw.push(last);
    }
    last[side] += text;
  };
  if (prefix > 0) same(a.slice(0, prefix).join(''));
  const n = midA.length;
  const m = midB.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    change('removed', midA.join(''));
    change('added', midB.join(''));
  } else {
    // lcs[i][j]: common tokens of midA[i..] and midB[j..].
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        same(midA[i]!);
        i += 1;
        j += 1;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        change('removed', midA[i]!);
        i += 1;
      } else {
        change('added', midB[j]!);
        j += 1;
      }
    }
    while (i < n) change('removed', midA[i++]!);
    while (j < m) change('added', midB[j++]!);
  }
  if (suffix > 0) same(a.slice(a.length - suffix).join(''));
  for (let index = 1; index < raw.length - 1; index += 1) {
    const middle = raw[index]!;
    const left = raw[index - 1]!;
    const right = raw[index + 1]!;
    if (middle.kind === 'same' && left.kind === 'change' && right.kind === 'change' && foldable(middle.text)) {
      raw.splice(index - 1, 3, {
        kind: 'change',
        text: '',
        removed: left.removed + middle.text + right.removed,
        added: left.added + middle.text + right.added,
      });
      index = Math.max(0, index - 2);
    }
  }
  let changed = 0;
  const segments: DiffSegment[] = raw.map((segment) => {
    if (segment.kind === 'same') return { kind: 'same', text: segment.text };
    changed += segment.removed.length + segment.added.length;
    return { kind: 'change', removed: segment.removed, added: segment.added };
  });
  return { segments, ratio: changed / Math.max(1, before.length + after.length) };
}

/** A body the chapter cap shortened ends with the cap's marker. */
export function splitCut(body: string): { readonly text: string; readonly cut: boolean } {
  return body.endsWith(LESSON_TRIM_MARKER)
    ? { text: body.slice(0, -LESSON_TRIM_MARKER.length), cut: true }
    : { text: body, cut: false };
}

/** A lesson the cap cut and the lesson writer did not otherwise touch: its
 * new text is the start of its old text, and it was not seen again. */
export function isCutOnly(lesson: LessonChangeView): boolean {
  if (lesson.previousBody === null) return false;
  const { text, cut } = splitCut(lesson.body);
  if (!cut) return false;
  if (lesson.previousRecurred !== lesson.recurred) return false;
  return splitCut(lesson.previousBody).text.trimEnd().startsWith(text.trimEnd());
}

/** The diff the owner reads for one changed lesson. A pure cut is shown as
 * exactly that — the old text with its tail struck — never as a mid-word
 * rewrite. */
export function lessonDiff(lesson: LessonChangeView): WordDiff & { readonly cut: boolean; readonly cutOnly: boolean } {
  const after = splitCut(lesson.body);
  const before = splitCut(lesson.previousBody ?? '').text;
  if (isCutOnly(lesson)) {
    const kept = after.text.trimEnd();
    const lost = before.slice(kept.length);
    return {
      segments: [{ kind: 'same', text: kept }, ...(lost === '' ? [] : [{ kind: 'change' as const, removed: lost, added: '' }])],
      ratio: lost.length / Math.max(1, before.length + kept.length),
      cut: true,
      cutOnly: true,
    };
  }
  return { ...wordDiff(before, after.text), cut: after.cut, cutOnly: false };
}

export type ChangeSize = 'small' | 'some' | 'rewritten';

export function changeSize(ratio: number): ChangeSize {
  return ratio < 0.18 ? 'small' : ratio < REWRITE_RATIO ? 'some' : 'rewritten';
}

export const CHANGE_SIZE_LABEL: Readonly<Record<ChangeSize, string>> = {
  small: 'Small edit',
  some: 'Some changes',
  rewritten: 'Mostly rewritten',
};

/** A lesson's slug as a sentence ("wall-means-wait" → "Wall means wait");
 * the archive record says what it is. */
export function lessonName(slug: string): string {
  if (slug === ARCHIVED_LESSON_SLUG) return 'Archive record (where dropped lessons came from)';
  const words = slug.replace(/-+/gu, ' ').trim();
  return words === '' ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

export function times(count: number): string {
  return count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Why a lesson leaves the book, in plain words. */
export const REMOVED_REASON: Readonly<Record<RemovedLessonView['reason'], string>> = {
  cap: 'Removed to make room: the chapter is full.',
  retired: 'Removed with its chapter.',
  discarded: 'New, but left out: the chapter is full.',
};

export interface CutLesson {
  readonly chapter: string;
  readonly lesson: string;
}

export interface ProposalAnalysis {
  readonly added: number;
  /** Existing lessons the lesson writer updated — reworded, seen again or
   * relabelled (a cut alone is not an update). */
  readonly updated: number;
  /** Lessons that leave the book (dropped to fit, or with their chapter). */
  readonly removed: number;
  /** New lessons the cap left out (the book does not change for them). */
  readonly leftOut: number;
  /** Lessons whose ending the cap cuts (reworded ones included). */
  readonly cut: readonly CutLesson[];
  readonly newChapters: number;
  readonly renamed: readonly LessonChapterChangeView[];
  readonly retired: readonly LessonChapterChangeView[];
  /** Old journal handles released to fit (housekeeping, no text change). */
  readonly sourcesDropped: number;
  /** Table-of-contents lines the INDEX cap cuts short. */
  readonly tocCut: readonly LessonIndexChangeView[];
  /** Every change the Accept would write, as the owner counts them. */
  readonly changes: number;
}

export const tocCutShort = (entry: LessonIndexChangeView): boolean =>
  entry.after !== null && entry.after.summary.endsWith('…') && !(entry.before?.summary.endsWith('…') ?? false);

export function analyseProposal(review: LessonProposalView): ProposalAnalysis {
  let added = 0;
  let updated = 0;
  let removed = 0;
  let leftOut = 0;
  let newChapters = 0;
  let sourcesDropped = 0;
  const cut: CutLesson[] = [];
  const renamed: LessonChapterChangeView[] = [];
  const retired: LessonChapterChangeView[] = [];
  for (const chapter of review.chapters) {
    added += chapter.added.length;
    for (const lesson of chapter.removed) {
      if (lesson.reason === 'discarded') leftOut += 1;
      else removed += 1;
    }
    sourcesDropped += chapter.provenanceTrimmed;
    if (chapter.retired) retired.push(chapter);
    else if (chapter.title.before === null) newChapters += 1;
    else if (chapter.title.before !== chapter.title.after) renamed.push(chapter);
    for (const lesson of chapter.changed) if (!isCutOnly(lesson)) updated += 1;
    for (const lesson of [...chapter.added, ...chapter.changed]) {
      if (splitCut(lesson.body).cut) cut.push({ chapter: chapter.title.after, lesson: lessonName(lesson.slug) });
    }
  }
  const tocCut = review.index.filter(tocCutShort);
  const changes = review.chapters.reduce((sum, chapter) => sum + chapter.added.length + chapter.changed.length, 0) + removed;
  return { added, updated, removed, leftOut, cut, newChapters, renamed, retired, sourcesDropped, tocCut, changes };
}

/** "Gru wants to add 4 lessons and update 13". */
export function proposalHeadline(analysis: ProposalAnalysis): string {
  const parts: [string, number][] = [];
  if (analysis.added > 0) parts.push(['add', analysis.added]);
  if (analysis.updated > 0) parts.push(['update', analysis.updated]);
  if (analysis.removed > 0) parts.push(['remove', analysis.removed]);
  if (parts.length === 0) {
    return analysis.cut.length > 0
      ? `Gru wants to shorten ${plural(analysis.cut.length, 'lesson')} to fit`
      : 'Gru wants to tidy the Book of Lessons';
  }
  const words = parts.map(([verb, count], index) => `${verb} ${index === 0 ? plural(count, 'lesson') : count}`);
  const last = words.pop()!;
  return `Gru wants to ${words.length > 0 ? `${words.join(', ')} and ${last}` : last}`;
}

const quoteList = (names: readonly string[]): string => names.map((name) => `“${name}”`).join(', ');

/** The parts of a proposal that deserve a careful look, in plain words —
 * empty when every change is a new lesson or an update. */
export function thingsToCheck(analysis: ProposalAnalysis): string[] {
  const items: string[] = [];
  if (analysis.cut.length > 0) {
    items.push(
      `${plural(analysis.cut.length, 'lesson')} would lose ${analysis.cut.length === 1 ? 'its' : 'their'} ending to fit: ` +
        `${quoteList(analysis.cut.map((cut) => cut.lesson))}.`,
    );
  }
  if (analysis.removed > 0) items.push(`${plural(analysis.removed, 'lesson')} would be removed.`);
  if (analysis.leftOut > 0) {
    items.push(`${plural(analysis.leftOut, 'new lesson')} ${analysis.leftOut === 1 ? 'is' : 'are'} left out because the chapter is full.`);
  }
  if (analysis.retired.length > 0) {
    items.push(`${analysis.retired.length === 1 ? 'A whole chapter' : `${analysis.retired.length} whole chapters`} would go: ${quoteList(analysis.retired.map((chapter) => chapter.title.after))}.`);
  }
  if (analysis.renamed.length > 0) {
    items.push(`Renamed: ${analysis.renamed.map((chapter) => `“${chapter.title.before}” → “${chapter.title.after}”`).join(', ')}.`);
  }
  if (analysis.tocCut.length > 0) {
    items.push(
      `${plural(analysis.tocCut.length, 'table-of-contents line')} minions read would be cut short ` +
        `(for example “${analysis.tocCut[0]!.after!.summary}”).`,
    );
  }
  return items;
}

/** Label (tag) changes: what is added and what goes. */
export function labelChanges(before: readonly string[], after: readonly string[]): { readonly added: string[]; readonly removed: string[] } {
  return { added: after.filter((tag) => !before.includes(tag)), removed: before.filter((tag) => !after.includes(tag)) };
}


