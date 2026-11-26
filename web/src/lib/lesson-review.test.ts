import { describe, expect, it } from 'vitest';
import { LESSON_TRIM_MARKER, type LessonChangeView, type LessonProposalView } from './board-protocol.js';
import {
  REWRITE_RATIO,
  analyseProposal,
  droppableKeys,
  isDroppable,
  changeSize,
  isCutOnly,
  lessonDiff,
  lessonName,
  proposalHeadline,
  thingsToCheck,
  wordDiff,
  type DiffSegment,
} from './lesson-review.js';

const sides = (segments: readonly DiffSegment[]): { before: string; after: string } => ({
  before: segments.map((segment) => (segment.kind === 'same' ? segment.text : segment.removed)).join(''),
  after: segments.map((segment) => (segment.kind === 'same' ? segment.text : segment.added)).join(''),
});

const changed = (slug: string, previousBody: string, body: string, extra: Partial<LessonChangeView> = {}): LessonChangeView => ({
  slug,
  body,
  recurred: 2,
  tags: [],
  previousBody,
  previousRecurred: 1,
  previousTags: [],
  ...extra,
});

describe('wordDiff', () => {
  it('rebuilds both texts exactly from its segments, for edits, rewrites, additions and deletions', () => {
    const pairs: [string, string][] = [
      ['Drain before a roll.', 'Drain the queue before a roll, then confirm.'],
      ['Close the shell first.\nThen restart.', 'Restart only after the shell is closed.'],
      ['', 'A brand new lesson.'],
      ['A lesson that goes.', ''],
      ['Same text.', 'Same text.'],
      ['Ünïcode wörds — and dashes…', 'Ünïcode words — and dashes!'],
    ];
    for (const [before, after] of pairs) {
      const diff = wordDiff(before, after);
      expect(sides(diff.segments), JSON.stringify([before, after])).toEqual({ before, after });
    }
  });

  it('marks only what changed, and folds a short unchanged bit between two changes into one change', () => {
    expect(wordDiff('Check the gate on the page.', 'Check the gate on the rendered page.').segments).toEqual([
      { kind: 'same', text: 'Check the gate on the ' },
      { kind: 'change', removed: '', added: 'rendered ' },
      { kind: 'same', text: 'page.' },
    ]);
    // "a" between two changed words is folded: one change, not confetti.
    const folded = wordDiff('Use a hammer here.', 'Use the wrench there.').segments;
    expect(folded.filter((segment) => segment.kind === 'change')).toHaveLength(1);
    expect(sides(folded)).toEqual({ before: 'Use a hammer here.', after: 'Use the wrench there.' });
  });

  it('measures how much changed: nothing for identical text, everything for a full replacement', () => {
    expect(wordDiff('Same.', 'Same.').ratio).toBe(0);
    expect(wordDiff('alpha beta', 'gamma delta').ratio).toBe(1);
    const small = wordDiff('Drain the queue before every roll of the service.', 'Drain the queue before each roll of the service.');
    expect(changeSize(small.ratio)).toBe('small');
    expect(changeSize(REWRITE_RATIO)).toBe('rewritten');
    expect(changeSize(REWRITE_RATIO - 0.01)).toBe('some');
  });

  it('replaces a pathologically long body wholesale instead of aligning every word', () => {
    const before = 'word '.repeat(3000);
    const after = 'other '.repeat(3000);
    const diff = wordDiff(before, after);
    expect(sides(diff.segments)).toEqual({ before, after });
    // One change covering everything between the shared edges (here the trailing space).
    expect(diff.segments.filter((segment) => segment.kind === 'change')).toHaveLength(1);
  });
});

describe('cut lessons', () => {
  const old = 'Check each gate against the rendered page. Serve unknown routes from the catch-all. Locate a quote in its section.';
  const cut = `Check each gate against the rendered page. Serve unknown ro${LESSON_TRIM_MARKER}`;

  it('a lesson only the cap shortened shows its old text with the tail struck — never a mid-word rewrite', () => {
    const lesson = changed('release-gate', old, cut, { recurred: 1, previousRecurred: 1 });
    expect(isCutOnly(lesson)).toBe(true);
    const diff = lessonDiff(lesson);
    expect(diff).toMatchObject({ cut: true, cutOnly: true });
    expect(diff.segments).toEqual([
      { kind: 'same', text: 'Check each gate against the rendered page. Serve unknown ro' },
      { kind: 'change', removed: 'utes from the catch-all. Locate a quote in its section.', added: '' },
    ]);
  });

  it('a lesson that was seen again or reworded and then cut is an update that is also cut', () => {
    expect(isCutOnly(changed('release-gate', old, cut, { recurred: 2, previousRecurred: 1 }))).toBe(false);
    const reworded = changed('release-gate', old, `Check every gate on the rendered page first.${LESSON_TRIM_MARKER}`, { recurred: 1, previousRecurred: 1 });
    expect(isCutOnly(reworded)).toBe(false);
    expect(lessonDiff(reworded)).toMatchObject({ cut: true, cutOnly: false });
    // The marker itself is never shown as inserted text.
    expect(sides(lessonDiff(reworded).segments).after).toBe('Check every gate on the rendered page first.');
  });
});

function review(overrides: Partial<LessonProposalView> = {}): LessonProposalView {
  return {
    id: 'p',
    createdAt: '2026-11-26T00:00:00.000Z',
    notificationId: 'n',
    entries: 100,
    throughSeq: 311,
    chapters: [
      {
        slug: 'gates',
        title: { before: 'Gates', after: 'Release gates' },
        retired: false,
        summary: { before: 'Gates.', after: 'Gates.' },
        tags: { before: [], after: [] },
        added: [{ slug: 'new-one', body: 'New.', recurred: 1, tags: [], previousBody: null, previousRecurred: null, previousTags: null }],
        changed: [
          changed('reworded', 'Old words.', 'New words.'),
          changed('cut-only', 'Long text that the cap shortens.', `Long text${LESSON_TRIM_MARKER}`, { recurred: 1, previousRecurred: 1 }),
        ],
        removed: [
          { slug: 'dropped', body: 'Gone.', recurred: 1, tags: [], reason: 'cap' },
          { slug: 'left-out', body: 'Never added.', recurred: 1, tags: [], reason: 'discarded' },
        ],
        provenanceTrimmed: 3,
        bodiesTrimmed: 1,
      },
      {
        slug: 'fresh',
        title: { before: null, after: 'Fresh' },
        retired: false,
        summary: { before: null, after: 'Fresh.' },
        tags: { before: [], after: [] },
        added: [{ slug: 'first', body: 'First.', recurred: 1, tags: [], previousBody: null, previousRecurred: null, previousTags: null }],
        changed: [],
        removed: [],
        provenanceTrimmed: 0,
        bodiesTrimmed: 0,
      },
    ],
    index: [
      { slug: 'gates', before: { summary: 'Gates.', tags: [] }, after: { summary: 'Gat…', tags: [] } },
      { slug: 'fresh', before: null, after: { summary: 'Fresh.', tags: [] } },
    ],
    decision: null,
    recovery: null,
    ...overrides,
  };
}

describe('analyseProposal', () => {
  it('counts each kind of change the way the owner reads them', () => {
    const analysis = analyseProposal(review());
    expect(analysis).toMatchObject({ added: 2, updated: 1, removed: 1, leftOut: 1, newChapters: 1, sourcesDropped: 3, changes: 5 });
    expect(analysis.cut).toEqual([{ chapter: 'Release gates', lesson: 'Cut only' }]);
    expect(analysis.renamed.map((chapter) => chapter.slug)).toEqual(['gates']);
    expect(analysis.tocCut.map((entry) => entry.slug)).toEqual(['gates']);
  });

  it('writes a plain headline from the counts', () => {
    expect(proposalHeadline(analyseProposal(review()))).toBe('Gru wants to add 2 lessons, update 1 and remove 1');
    const onlyNew = review({ chapters: [review().chapters[1]!], index: [] });
    expect(proposalHeadline(analyseProposal(onlyNew))).toBe('Gru wants to add 1 lesson');
    expect(proposalHeadline(analyseProposal(review({ chapters: [], index: [] })))).toBe('Gru wants to tidy the Book of Lessons');
  });

  it('lists only what deserves a careful look, and nothing for plain additions and updates', () => {
    expect(thingsToCheck(analyseProposal(review()))).toEqual([
      '1 lesson would lose its ending to fit: “Cut only”.',
      '1 lesson would be removed.',
      '1 new lesson is left out because the chapter is full.',
      'Renamed: “Gates” → “Release gates”.',
      '1 table-of-contents line minions read would be cut short (for example “Gat…”).',
    ]);
    const calm = review({ chapters: [review().chapters[1]!], index: [] });
    expect(thingsToCheck(analyseProposal(calm))).toEqual([]);
  });
});

describe('lessonName', () => {
  it('turns a slug into a sentence and says what the archive record is', () => {
    expect(lessonName('wall-means-wait-not-restart')).toBe('Wall means wait not restart');
    expect(lessonName('archived-provenance')).toBe('Archive record (where dropped lessons came from)');
  });
});

describe('which changes the owner may drop', () => {
  it('follows the server: the writer’s additions and updates and a retired chapter — never a cut or the cap’s archive record', () => {
    const base = review();
    const withFlags = review({
      chapters: [
        {
          ...base.chapters[0]!,
          added: [{ ...base.chapters[0]!.added[0]!, byWriter: true }, { slug: 'archived-provenance', body: 'Archive.', recurred: 1, tags: [], previousBody: null, previousRecurred: null, previousTags: null, byWriter: false }],
          changed: [{ ...base.chapters[0]!.changed[0]!, byWriter: true }, { ...base.chapters[0]!.changed[1]!, byWriter: false }],
        },
        { ...base.chapters[1]!, slug: 'gone', retired: true, added: [], removed: [{ slug: 'x', body: 'X.', recurred: 1, tags: [], reason: 'retired' }] },
      ],
    });
    expect(droppableKeys(withFlags)).toEqual(['gates/new-one', 'gates/reworded', 'gone']);
    // Without the server's flag (an older server) the text test stands in.
    expect(droppableKeys(review())).toEqual(['gates/new-one', 'gates/reworded', 'fresh/first']);
    expect(isDroppable({ slug: 'archived-provenance', body: 'A.', recurred: 1, tags: [], previousBody: null, previousRecurred: null, previousTags: null })).toBe(false);
    // The flag wins over the text test: a tags-only update that is also cut is still a choice.
    expect(isCutOnly({ ...changed('t', 'Long text here.', `Long text${LESSON_TRIM_MARKER}`, { recurred: 1, previousRecurred: 1 }), byWriter: true })).toBe(false);
  });
});
