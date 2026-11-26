/**
 * DOM builders for the Book of Lessons review (owner redesign 2026-11-26):
 * the counts and "Things to check" on the FOR YOU card, and the full list
 * of changes in the review sheet. Every change the proposal carries stays
 * visible — lesson text, labels, chapter descriptions, removals and every
 * table-of-contents line (owner decision 2026-10-07) — only the words are
 * plainer and each reworded lesson shows what changed (owner pick "D ·
 * Mix": changes marked in place for an edit, before | after for a rewrite).
 */
import type {
  LessonChangeView,
  LessonChapterChangeView,
  LessonIndexChangeView,
  LessonProposalView,
  RemovedLessonView,
} from '../lib/board-protocol.js';
import {
  CHANGE_SIZE_LABEL,
  REMOVED_REASON,
  REWRITE_RATIO,
  changeSize,
  isCutOnly,
  labelChanges,
  lessonDiff,
  lessonName,
  plural,
  splitCut,
  thingsToCheck,
  times,
  tocCutShort,
  wordDiff,
  type DiffSegment,
  type ProposalAnalysis,
} from '../lib/lesson-review.js';
import { el } from './dom.js';

export type LessonFilter = 'all' | 'new' | 'updated' | 'removed' | 'cut';

export const LESSON_FILTERS: readonly { readonly id: LessonFilter; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'updated', label: 'Updated' },
  { id: 'removed', label: 'Removed' },
  { id: 'cut', label: '✂ Cut short' },
];

/** What briefings do with the book, in one plain sentence. */
export function lessonStoryText(review: LessonProposalView): string {
  return (
    `Gru read ${plural(review.entries, 'journal note')} from recent jobs and suggests these changes. ` +
    'Job briefings point minions to the lessons that match their job, so the changes reach minions from their next job.'
  );
}

/** Gru's one-sentence summary as Gru talking (the brain coin and butter
 * bubble of the FOR YOU look), or null when the update carries none. */
export function lessonOverview(review: LessonProposalView): HTMLElement | null {
  const overview = review.overview ?? null;
  if (overview === null || overview.trim() === '') return null;
  const row = el('div', 'board-lessons__overview');
  const bubble = el('div', 'board-notification__gru-bubble board-lessons__overview-text');
  bubble.append(el('span', 'board-notification__gru-label', 'Gru: '), overview);
  row.append(el('span', 'board-notification__gru-coin', '🧠'), bubble);
  return row;
}

/** The coloured counts: new, updated, removed, cut short, new chapters. */
export function lessonTally(analysis: ProposalAnalysis): HTMLElement {
  const tally = el('div', 'board-lessons__tally');
  const chip = (tone: string, text: string, count: number): void => {
    tally.append(el('span', `board-lessons__count board-lessons__count--${count === 0 ? 'zero' : tone}`, text));
  };
  chip('new', `+ ${analysis.added} new`, analysis.added);
  chip('updated', `✎ ${analysis.updated} updated`, analysis.updated);
  chip('removed', `− ${analysis.removed} removed`, analysis.removed);
  if (analysis.cut.length > 0) chip('cut', `✂ ${analysis.cut.length} cut short`, analysis.cut.length);
  if (analysis.newChapters > 0) chip('chapter', `📗 ${plural(analysis.newChapters, 'new chapter')}`, analysis.newChapters);
  return tally;
}

/** "Things to check": the parts that deserve a careful look, or one calm
 * line when every change is a new lesson or a rewording. */
export function lessonChecks(analysis: ProposalAnalysis): HTMLElement {
  const items = thingsToCheck(analysis);
  if (items.length === 0) {
    return el('div', 'board-lessons__check board-lessons__check--calm', 'Nothing unusual: every change is a new lesson or an update.');
  }
  const box = el('div', 'board-lessons__check');
  box.append(el('div', 'board-lessons__check-title', '👀 Things to check'));
  const list = el('ul', 'board-lessons__check-list');
  for (const item of items) list.append(el('li', '', item));
  box.append(list);
  return box;
}

/** How many lessons each filter shows. */
export function filterCounts(review: LessonProposalView): Readonly<Record<LessonFilter, number>> {
  let added = 0;
  let updated = 0;
  let removed = 0;
  let cut = 0;
  for (const chapter of review.chapters) {
    added += chapter.added.length;
    removed += chapter.removed.length;
    for (const lesson of chapter.changed) if (!isCutOnly(lesson)) updated += 1;
    for (const lesson of [...chapter.added, ...chapter.changed]) if (splitCut(lesson.body).cut) cut += 1;
  }
  const all = review.chapters.reduce((sum, chapter) => sum + chapter.added.length + chapter.changed.length + chapter.removed.length, 0);
  return { all, new: added, updated, removed, cut };
}

function cutMark(): HTMLElement {
  return el('span', 'board-lessons__cutmark', '✂ cut here to fit');
}

/** One paragraph with the changes marked in place. */
function markedText(segments: readonly DiffSegment[], cut: boolean): HTMLElement {
  const text = el('p', 'board-lessons__text');
  for (const segment of segments) {
    if (segment.kind === 'same') {
      text.append(segment.text);
      continue;
    }
    if (segment.removed !== '') text.append(el('del', 'board-lessons__del', segment.removed));
    if (segment.added !== '') text.append(el('ins', 'board-lessons__ins', segment.added));
  }
  if (cut) text.append(cutMark());
  return text;
}

/** Before and after side by side, the changed words marked on each side. */
function beforeAfter(segments: readonly DiffSegment[], cut: boolean): HTMLElement {
  const pair = el('div', 'board-lessons__pair');
  const before = el('div', 'board-lessons__side');
  const after = el('div', 'board-lessons__side');
  const beforeText = el('p', 'board-lessons__text');
  const afterText = el('p', 'board-lessons__text');
  for (const segment of segments) {
    if (segment.kind === 'same') {
      beforeText.append(segment.text);
      afterText.append(segment.text);
      continue;
    }
    if (segment.removed !== '') beforeText.append(el('del', 'board-lessons__del', segment.removed));
    if (segment.added !== '') afterText.append(el('ins', 'board-lessons__ins', segment.added));
  }
  if (cut) afterText.append(cutMark());
  before.append(el('div', 'board-lessons__side-label', 'Before'), beforeText);
  after.append(el('div', 'board-lessons__side-label', 'After'), afterText);
  pair.append(before, after);
  return pair;
}

/** Label changes as chips: added ones marked new, dropped ones struck. */
function labelsLine(before: readonly string[], after: readonly string[], prefix = 'Labels'): HTMLElement | null {
  const { added, removed } = labelChanges(before, after);
  if (added.length === 0 && removed.length === 0) return null;
  const line = el('div', 'board-lessons__labels');
  line.append(el('span', 'board-lessons__labels-name', `${prefix}:`));
  for (const tag of added) line.append(el('ins', 'board-lessons__label board-lessons__ins', `+ ${tag}`));
  for (const tag of removed) line.append(el('del', 'board-lessons__label board-lessons__del', tag));
  return line;
}

function plainLabels(tags: readonly string[], gone = false): HTMLElement | null {
  if (tags.length === 0) return null;
  const line = el('div', 'board-lessons__labels');
  line.append(el('span', 'board-lessons__labels-name', 'Labels:'));
  for (const tag of tags) line.append(el(gone ? 'del' : 'span', `board-lessons__label${gone ? ' board-lessons__del' : ''}`, tag));
  return line;
}

function lessonHead(badges: readonly [string, string][], name: string): HTMLElement {
  const head = el('div', 'board-lessons__lesson-head');
  for (const [tone, text] of badges) head.append(el('span', `board-lessons__badge board-lessons__badge--${tone}`, text));
  head.append(el('h4', 'board-lessons__lesson-name', name));
  return head;
}

function newLesson(lesson: LessonChangeView): HTMLElement {
  const { text, cut } = splitCut(lesson.body);
  const node = el('article', `board-lessons__lesson board-lessons__lesson--new${cut ? ' board-lessons__lesson--cut' : ''}`);
  node.dataset.lessonKind = 'new';
  node.dataset.cut = String(cut);
  node.append(
    lessonHead([['new', 'New'], ...(cut ? [['cut', '✂ Cut short'] as [string, string]] : [])], lessonName(lesson.slug)),
    el('div', 'board-lessons__why', `New · seen ${times(lesson.recurred)}.`),
  );
  const body = el('p', 'board-lessons__text', text);
  if (cut) body.append(cutMark());
  node.append(body);
  const labels = plainLabels(lesson.tags);
  if (labels !== null) node.append(labels);
  return node;
}

function changedLesson(lesson: LessonChangeView): HTMLElement {
  const diff = lessonDiff(lesson);
  const reworded = diff.segments.some((segment) => segment.kind === 'change');
  const previous = lesson.previousRecurred;
  const node = el(
    'article',
    `board-lessons__lesson board-lessons__lesson--${diff.cutOnly ? 'cut-only' : 'updated'}${diff.cut ? ' board-lessons__lesson--cut' : ''}`,
  );
  node.dataset.lessonKind = diff.cutOnly ? 'cut' : 'updated';
  node.dataset.cut = String(diff.cut);
  const badges: [string, string][] = [];
  if (!diff.cutOnly) {
    badges.push(['updated', reworded ? 'Reworded' : previous !== null && previous !== lesson.recurred ? 'Seen again' : 'Labels changed']);
  }
  if (diff.cut) badges.push(['cut', '✂ Cut short']);
  node.append(lessonHead(badges, lessonName(lesson.slug)));
  const why = el('div', 'board-lessons__why');
  if (diff.cutOnly) {
    why.append(el('b', '', 'Not reworded: the end is cut because the chapter is full.'));
  } else {
    if (!reworded) why.append('Same wording · ');
    if (previous !== null && lesson.recurred > previous) {
      why.append(el('b', '', 'Seen again'), `, now ${times(lesson.recurred)}. `);
    } else if (previous !== null && lesson.recurred < previous) {
      why.append(`Seen ${times(lesson.recurred)} (was ${times(previous)}). `);
    } else {
      why.append(`Seen ${times(lesson.recurred)}. `);
    }
    if (reworded) {
      const size = changeSize(diff.ratio);
      why.append(el('span', `board-lessons__size board-lessons__size--${size}`, CHANGE_SIZE_LABEL[size]));
    }
  }
  node.append(why);
  node.append(!diff.cutOnly && diff.ratio >= REWRITE_RATIO ? beforeAfter(diff.segments, diff.cut) : markedText(diff.segments, diff.cut));
  if (lesson.previousTags !== null) {
    const labels = labelsLine(lesson.previousTags, lesson.tags);
    if (labels !== null) node.append(labels);
  }
  return node;
}

function removedLesson(lesson: RemovedLessonView): HTMLElement {
  const node = el('article', `board-lessons__lesson board-lessons__lesson--removed`);
  node.dataset.lessonKind = 'removed';
  node.dataset.cut = 'false';
  node.append(
    lessonHead([['removed', lesson.reason === 'discarded' ? 'Left out' : 'Removed']], lessonName(lesson.slug)),
    el('div', 'board-lessons__why', `${REMOVED_REASON[lesson.reason]} ${lesson.reason === 'discarded' ? `Seen ${times(lesson.recurred)}.` : `Seen ${times(lesson.recurred)} before.`}`),
    el('p', 'board-lessons__text board-lessons__text--gone', lesson.body),
  );
  const labels = plainLabels(lesson.tags, true);
  if (labels !== null) node.append(labels);
  return node;
}

/** A one-line text change (a description, a table-of-contents line). */
function lineChange(label: string, before: string | null, after: string | null): HTMLElement {
  const line = el('div', 'board-lessons__line');
  line.append(el('span', 'board-lessons__line-name', label));
  const text = el('span', 'board-lessons__line-text');
  if (before === null && after !== null) text.append(el('ins', 'board-lessons__ins', after));
  else if (after === null && before !== null) text.append(el('del', 'board-lessons__del', before));
  else if (before !== null && after !== null) {
    for (const segment of wordDiff(before, after).segments) {
      if (segment.kind === 'same') text.append(segment.text);
      else {
        if (segment.removed !== '') text.append(el('del', 'board-lessons__del', segment.removed));
        if (segment.added !== '') text.append(el('ins', 'board-lessons__ins', segment.added));
      }
    }
  }
  line.append(text);
  return line;
}

const TOC_LABEL = 'Table of contents (used to match lessons to jobs):';

/** A chapter's table-of-contents line and labels, skipping what the
 * chapter's own description and labels already show (the INDEX usually
 * repeats the description; it differs when its cap cuts it short). */
function tocLines(entry: LessonIndexChangeView, chapter?: LessonChapterChangeView): HTMLElement[] {
  const lines: HTMLElement[] = [];
  const summaryBefore = entry.before?.summary ?? null;
  const summaryAfter = entry.after?.summary ?? null;
  const tagsBefore = entry.before?.tags ?? [];
  const tagsAfter = entry.after?.tags ?? [];
  const sameTags = (left: readonly string[], right: readonly string[]): boolean => left.join('\u0000') === right.join('\u0000');
  const chapterSummaryBefore = chapter === undefined || chapter.title.before === null ? null : (chapter.summary.before ?? '');
  const chapterSummaryAfter = chapter === undefined || chapter.retired ? null : chapter.summary.after;
  const summaryShown = chapter !== undefined && summaryBefore === chapterSummaryBefore && summaryAfter === chapterSummaryAfter;
  const tagsShown = chapter !== undefined && sameTags(tagsBefore, chapter.title.before === null ? [] : chapter.tags.before) &&
    sameTags(tagsAfter, chapter.retired ? [] : chapter.tags.after);
  if (summaryBefore !== summaryAfter && !summaryShown) {
    const line = lineChange(TOC_LABEL, summaryBefore, summaryAfter);
    if (tocCutShort(entry)) line.append(el('span', 'board-lessons__cutmark', '✂ cut short to fit'));
    lines.push(line);
  }
  if (!tagsShown) {
    const labels = labelsLine(tagsBefore, tagsAfter, 'Table-of-contents labels');
    if (labels !== null) lines.push(labels);
  }
  // A table-of-contents-only entry always says what it is, even when only
  // its position or an unchanged line is listed.
  if (chapter === undefined && lines.length === 0) lines.push(lineChange(TOC_LABEL, summaryBefore, summaryAfter));
  return lines;
}

function chapterHead(chapter: LessonChapterChangeView, toc: LessonIndexChangeView | undefined): HTMLElement {
  const head = el('div', 'board-lessons__chapter-head');
  const title = el('div', 'board-lessons__chapter-title');
  title.append(el('h3', 'board-lessons__chapter-name', chapter.title.after));
  if (chapter.retired) title.append(el('span', 'board-lessons__badge board-lessons__badge--removed', 'Chapter removed'));
  else if (chapter.title.before === null) title.append(el('span', 'board-lessons__badge board-lessons__badge--new', 'New chapter'));
  else if (chapter.title.before !== chapter.title.after) title.append(el('span', 'board-lessons__badge board-lessons__badge--chapter', 'Renamed'));
  head.append(title);
  if (!chapter.retired && chapter.title.before !== null && chapter.title.before !== chapter.title.after) {
    head.append(lineChange('Was called:', chapter.title.before, null));
  }
  if (chapter.retired) {
    if (chapter.summary.before !== null && chapter.summary.before !== '') head.append(lineChange('Description removed:', chapter.summary.before, null));
    const tags = plainLabels(chapter.tags.before, true);
    if (tags !== null) head.append(tags);
  } else {
    if (chapter.summary.before !== chapter.summary.after) {
      head.append(lineChange('Description:', chapter.summary.before, chapter.summary.after));
    }
    const tags = labelsLine(chapter.tags.before, chapter.tags.after, 'Chapter labels');
    if (tags !== null) head.append(tags);
  }
  if (toc !== undefined) head.append(...tocLines(toc, chapter));
  return head;
}

function visible(node: HTMLElement, filter: LessonFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'cut') return node.dataset.cut === 'true';
  return node.dataset.lessonKind === filter;
}

/** Every change the proposal would write, chapter by chapter, then the
 * table-of-contents lines of chapters with no lesson change, then the
 * housekeeping footnote. A filter narrows the lessons shown; the chapter
 * and table-of-contents changes show under "All". */
export function lessonChanges(review: LessonProposalView, filter: LessonFilter): HTMLElement {
  const root = el('div', 'board-lessons__changes');
  const toc = new Map(review.index.map((entry) => [entry.slug, entry]));
  let shownLessons = 0;
  let sourcesDropped = 0;
  for (const chapter of review.chapters) {
    sourcesDropped += chapter.provenanceTrimmed;
    const lessons = [
      ...chapter.added.map(newLesson),
      ...chapter.changed.map(changedLesson),
      ...chapter.removed.map(removedLesson),
    ].filter((node) => visible(node, filter));
    const entry = toc.get(chapter.slug);
    toc.delete(chapter.slug);
    if (filter !== 'all' && lessons.length === 0) continue;
    const section = el('section', 'board-lessons__chapter');
    section.dataset.chapter = chapter.slug;
    section.append(chapterHead(chapter, entry), ...lessons);
    if (filter === 'all' && lessons.length === 0) section.append(el('div', 'board-lessons__quiet', 'No lesson in this chapter changes.'));
    shownLessons += lessons.length;
    root.append(section);
  }
  if (filter === 'all' && toc.size > 0) {
    const section = el('section', 'board-lessons__chapter board-lessons__chapter--toc');
    const head = el('div', 'board-lessons__chapter-head');
    const title = el('div', 'board-lessons__chapter-title');
    title.append(el('h3', 'board-lessons__chapter-name', 'Table of contents only'));
    head.append(title, el('div', 'board-lessons__quiet', 'These chapters keep their lessons; only their line in the table of contents changes.'));
    section.append(head);
    for (const entry of toc.values()) {
      const item = el('div', 'board-lessons__toc-entry');
      item.append(el('div', 'board-lessons__toc-name', lessonName(entry.slug)), ...tocLines(entry));
      section.append(item);
    }
    root.append(section);
  }
  if (review.chapters.length === 0 && review.index.length === 0) root.append(el('div', 'board-lessons__quiet', 'No changes to the book.'));
  else if (filter !== 'all' && shownLessons === 0) root.append(el('div', 'board-lessons__quiet', 'Nothing of this kind in this update.'));
  if (filter === 'all' && sourcesDropped > 0) {
    root.append(
      el(
        'p',
        'board-lessons__housekeeping',
        `Housekeeping: ${plural(sourcesDropped, 'old source note')} (which journal note a lesson came from) ` +
          `${sourcesDropped === 1 ? 'is' : 'are'} dropped to save space. No lesson text changes because of this.`,
      ),
    );
  }
  return root;
}
