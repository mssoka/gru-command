import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BibleStore,
  enforceChapterCap,
  parseChapter,
  PROVENANCE_FLOOR,
  repairChapterProvenance,
  parseIndex,
  renderIndex,
  serializeChapter,
} from '../src/lessons/bible.js';
import { JournalStore } from '../src/lessons/journal.js';
import { BibleError, type BibleChapter, type ProposedChapter, type ProvenanceRef } from '../src/lessons/types.js';

/**
 * Bible (Book of Lessons memory): stable anchors, semantic-dedupe merge
 * semantics (recurred counter + provenance), the chapter cap, and the
 * index cap. The dream supplies judgment; the store enforces these.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpBible(capBytes = 4_096, indexCapBytes = 1_024): BibleStore {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-bible-'));
  cleanupDirs.push(dir);
  return new BibleStore(join(dir, 'bible'), { chapterCapBytes: capBytes, indexCapBytes });
}

const PROVENANCE = new Map([
  ['j-1', '2026-09-23T00:00:00.000Z'],
  ['j-2', '2026-09-24T00:00:00.000Z'],
  ['j-3', '2026-09-25T00:00:00.000Z'],
]);

function proposal(overrides: Partial<ProposedChapter> = {}): ProposedChapter {
  return {
    slug: 'ops-restarts',
    title: 'Ops restarts',
    summary: 'Restart discipline for the hosted service.',
    tags: ['ops', 'restarts'],
    lessons: [
      {
        slug: 'shell-hang',
        body: 'A live tool process holds the session open; kill the shell before restarting.',
        tags: ['shell', 'hang'],
        journalIds: ['j-1'],
      },
    ],
    ...overrides,
  };
}

describe('bible store', () => {
  it('seeds README + empty INDEX and never overwrites existing content', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const readme = join(bible.dir, 'README.md');
    const index = join(bible.dir, 'INDEX.md');
    expect(readFileSync(readme, 'utf-8')).toContain('Book of Lessons');
    expect(readFileSync(readme, 'utf-8')).toContain('progressive');
    expect(parseIndex(readFileSync(index, 'utf-8'))).toEqual([]);

    // Hand edits (or a later seed revision) must not clobber user content.
    const custom = 'my own notes\n';
    writeFileSync(readme, custom, 'utf-8');
    bible.ensureSeeded();
    expect(readFileSync(readme, 'utf-8')).toBe(custom);
  });

  it('round-trips a chapter through the canonical markdown format', () => {
    const chapter: BibleChapter = {
      slug: 'ops-restarts',
      title: 'Ops restarts',
      summary: 'Restart discipline for the hosted service.',
      tags: ['ops', 'restarts'],
      lessons: [
        {
          slug: 'shell-hang',
          body: 'Kill the shell first.\n- one\n- two',
          recurred: 3,
          provenance: [
            { id: 'j-1', ts: '2026-09-23T00:00:00.000Z' },
            { id: 'j-2', ts: '2026-09-24T00:00:00.000Z' },
          ],
          tags: ['shell', 'hang'],
        },
      ],
    };
    const text = serializeChapter(chapter);
    expect(text).toContain('## shell-hang');
    expect(parseChapter(text, 'ops-restarts')).toEqual(chapter);
  });

  it('applies updates: new lesson, index line with tags, provenance refs', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const report = bible.applyUpdates([proposal()], PROVENANCE);
    expect(report).toEqual({
      chaptersWritten: 1,
      chaptersRetired: 0,
      lessonsAdded: 1,
      lessonsMerged: 0,
      lessonsTrimmed: 0,
      lessonsDropped: 0,
    });
    const chapter = bible.readChapter('ops-restarts');
    expect(chapter?.lessons[0]).toMatchObject({
      slug: 'shell-hang',
      recurred: 1,
      tags: ['shell', 'hang'],
      provenance: [{ id: 'j-1', ts: '2026-09-23T00:00:00.000Z' }],
    });
    const index = parseIndex(bible.readIndexText()!);
    expect(index).toEqual([
      { slug: 'ops-restarts', summary: 'Restart discipline for the hosted service.', tags: ['ops', 'restarts'] },
    ]);
  });

  it('dedupes the same finding twice into one lesson with recurred: 2 and both provenances', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const twice: ProposedChapter = proposal({
      lessons: [
        {
          slug: 'shell-hang',
          body: 'A live tool process holds the session open; kill the shell before restarting.',
          journalIds: ['j-1'],
        },
        {
          slug: 'shell-hang',
          body: 'A live tool process holds the session open; kill the shell before restarting.',
          journalIds: ['j-2'],
        },
      ],
    });
    const report = bible.applyUpdates([twice], PROVENANCE);
    expect(report.lessonsAdded).toBe(1);
    expect(report.lessonsMerged).toBe(1);
    const lessons = bible.readChapter('ops-restarts')!.lessons;
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.recurred).toBe(2);
    expect(lessons[0]!.provenance.map((ref) => ref.id)).toEqual(['j-1', 'j-2']);
  });

  it('fuzzy-merges a reworded repeat under a different slug (same body)', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    bible.applyUpdates([proposal()], PROVENANCE);
    const later = proposal({
      lessons: [
        {
          slug: 'session-held-by-tool',
          body: 'A live tool process holds the session open; kill the shell before restarting.',
          journalIds: ['j-2'],
        },
      ],
    });
    const report = bible.applyUpdates([later], PROVENANCE);
    expect(report.lessonsMerged).toBe(1);
    expect(report.lessonsAdded).toBe(0);
    const lessons = bible.readChapter('ops-restarts')!.lessons;
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.slug).toBe('shell-hang'); // the anchor stays stable
    expect(lessons[0]!.recurred).toBe(2);
  });

  it('honors an explicit mergeInto target (the distiller’s semantic call)', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    bible.applyUpdates([proposal()], PROVENANCE);
    const report = bible.applyUpdates(
      [
        proposal({
          lessons: [
            {
              slug: 'restart-shell-first',
              mergeInto: 'shell-hang',
              body: 'Kill the shell before restarting: the live tool process holds the session open.',
              journalIds: ['j-2'],
            },
          ],
        }),
      ],
      PROVENANCE,
    );
    expect(report.lessonsMerged).toBe(1);
    const lessons = bible.readChapter('ops-restarts')!.lessons;
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.slug).toBe('shell-hang');
    expect(lessons[0]!.recurred).toBe(2);
    expect(lessons[0]!.body).toContain('Kill the shell before restarting:');
  });

  it('rewrites only the touched chapters and regenerates the index', async () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    bible.applyUpdates(
      [
        proposal(),
        proposal({
          slug: 'worktrees',
          title: 'Worktrees',
          summary: 'Lane hygiene.',
          tags: ['worktrees'],
          lessons: [{ slug: 'sweep-first', body: 'Preserve before sweeping.', journalIds: ['j-2'] }],
        }),
      ],
      PROVENANCE,
    );
    const untouchedFile = join(bible.dir, 'chapters', 'worktrees.md');
    const before = statSync(untouchedFile).mtimeMs;
    const beforeContent = readFileSync(untouchedFile, 'utf-8');
    await delay(20);
    bible.applyUpdates(
      [
        proposal({
          lessons: [
            {
              slug: 'shell-hang',
              body: 'A live tool process holds the session open; kill the shell before restarting.',
              journalIds: ['j-3'],
            },
          ],
        }),
      ],
      PROVENANCE,
    );
    expect(statSync(untouchedFile).mtimeMs).toBe(before);
    expect(readFileSync(untouchedFile, 'utf-8')).toBe(beforeContent);
    const index = parseIndex(bible.readIndexText()!);
    expect(index.map((entry) => entry.slug).sort()).toEqual(['ops-restarts', 'worktrees']);
  });

  it('enforces the chapter cap by trimming, then archiving dropped provenance', () => {
    const cap = 900;
    const lessons = Array.from({ length: 6 }, (_, index) => ({
      slug: `lesson-${index}`,
      body: `Lesson ${index}: ${'detail '.repeat(40)}end.`,
      recurred: index + 1,
      provenance: [{ id: `j-${index + 1}`, ts: `2026-09-2${index}T00:00:00.000Z` }],
      tags: [],
    }));
    const chapter: BibleChapter = {
      slug: 'capped',
      title: 'Capped',
      summary: 'A chapter that must fit.',
      tags: ['cap'],
      lessons,
    };
    const result = enforceChapterCap(chapter, cap);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(cap);
    expect(result.trimmed).toBeGreaterThan(0);
    const reparsed = parseChapter(result.text, 'capped');
    expect(reparsed.lessons.some((lesson) => lesson.slug === 'archived-provenance')).toBe(true);
    // Every dropped lesson's provenance survives in the archive lesson.
    const archived = reparsed.lessons.find((lesson) => lesson.slug === 'archived-provenance')!;
    const archivedIds = new Set(archived.provenance.map((ref) => ref.id));
    const keptIds = new Set(
      reparsed.lessons
        .filter((lesson) => lesson.slug !== 'archived-provenance')
        .flatMap((lesson) => lesson.provenance.map((ref) => ref.id)),
    );
    for (const ref of result.droppedProvenance) {
      expect(keptIds.has(ref.id) || archivedIds.has(ref.id)).toBe(true);
    }
  });

  it('a chapter cap too small to hold even one lesson fails loud', () => {
    const chapter: BibleChapter = {
      slug: 'tiny',
      title: 'Tiny',
      summary: '',
      tags: [],
      lessons: [
        { slug: 'one', body: 'x'.repeat(500), recurred: 1, provenance: [{ id: 'j-1', ts: '2026-09-23T00:00:00.000Z' }], tags: [] },
      ],
    };
    expect(() => enforceChapterCap(chapter, 120)).toThrowError(BibleError);
  });

  it('caps INDEX.md by compacting summaries, then dropping tags; impossible lists fail loud', () => {
    const chapters: BibleChapter[] = Array.from({ length: 4 }, (_, index) => ({
      slug: `chapter-${index}`,
      title: `Chapter ${index}`,
      summary: `A long summary for chapter ${index} that alone would not fit a very small cap.`,
      tags: ['one', 'two'],
      lessons: [],
    }));
    const capped = renderIndex(chapters, 420);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(420);
    expect(parseIndex(capped)).toHaveLength(4);
    expect(() => renderIndex(chapters, 120)).toThrowError(/cannot hold 4 chapter/);
  });

  it('requires provenance: no journal ids, or an id outside the batch, is a hard error', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    expect(() =>
      bible.applyUpdates(
        [proposal({ lessons: [{ slug: 'x', body: 'no provenance', journalIds: [] }] })],
        PROVENANCE,
      ),
    ).toThrowError(/cites no journal id/);
    expect(() =>
      bible.applyUpdates(
        [proposal({ lessons: [{ slug: 'x', body: 'invented provenance', journalIds: ['j-99'] }] })],
        PROVENANCE,
      ),
    ).toThrowError(/cites journal id j-99 which is not part of this dream batch/);
  });

  it('retires a chapter on request and removes it from the index', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    bible.applyUpdates([proposal()], PROVENANCE);
    expect(bible.readChapter('ops-restarts')).not.toBeNull();
    const report = bible.applyUpdates(
      [{ slug: 'ops-restarts', title: 'Ops restarts', summary: 'retired', lessons: [], retire: true }],
      PROVENANCE,
    );
    expect(report.chaptersRetired).toBe(1);
    expect(bible.readChapter('ops-restarts')).toBeNull();
    expect(parseIndex(bible.readIndexText()!)).toEqual([]);
  });

  it('reproduces provenance dates in the serialized chapter (ids/dates on every lesson)', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    bible.applyUpdates([proposal()], PROVENANCE);
    const text = readFileSync(join(bible.dir, 'chapters', 'ops-restarts.md'), 'utf-8');
    expect(text).toContain('provenance: j-1@2026-09-23T00:00:00.000Z');
  });
});

describe('provenance repair and the elastic cap (owner incident 2026-10-07)', () => {
  /** Ascending journal handles j-1..j-n, one minute apart. */
  function handles(count: number, from = 1): ProvenanceRef[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `j-${from + index}`,
      ts: new Date(Date.UTC(2026, 9, 1, 0, from + index)).toISOString(),
    }));
  }

  function chapterOf(lessons: BibleChapter['lessons']): BibleChapter {
    return { slug: 'elastic', title: 'Elastic', summary: 'Cap behavior.', tags: [], lessons };
  }

  it('releases the oldest provenance handles before touching any lesson text', () => {
    const cited = handles(40);
    const quiet = handles(2, 100);
    const lessons = [
      { slug: 'cited-often', body: `Cited often. ${'detail '.repeat(30)}end.`, recurred: 40, provenance: cited, tags: [] },
      { slug: 'cited-twice', body: `Cited twice. ${'detail '.repeat(30)}end.`, recurred: 2, provenance: quiet, tags: [] },
    ];
    // A cap that fits only once the busy lesson keeps its newest 10 handles.
    const cap = Buffer.byteLength(
      serializeChapter(chapterOf([{ ...lessons[0]!, provenance: cited.slice(-10) }, lessons[1]!])),
      'utf8',
    );
    const result = enforceChapterCap(chapterOf(lessons), cap);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(cap);
    expect(result.trimmed).toBe(0);
    expect(result.droppedLessons).toBe(0);
    const [often, twice] = result.chapter.lessons;
    expect(often!.body).toBe(lessons[0]!.body);
    expect(often!.recurred).toBe(40);
    expect(often!.provenance).toEqual(cited.slice(-10));
    expect(twice!.provenance).toEqual(quiet);
    expect(result.provenanceTrimmed).toBe(30);
  });

  it('releases the archive record’s oldest handles before any lesson text', () => {
    const lesson = { slug: 'kept', body: `Kept lesson. ${'detail '.repeat(40)}end.`, recurred: 2, provenance: handles(2), tags: [] };
    const archive = {
      slug: 'archived-provenance',
      body: 'Lessons trimmed at the chapter cap; provenance retained so the journal remains the ground truth.',
      recurred: 1,
      provenance: handles(60, 200),
      tags: ['archived'],
    };
    const cap = Buffer.byteLength(
      serializeChapter(chapterOf([lesson, { ...archive, provenance: archive.provenance.slice(-5) }])),
      'utf8',
    );
    const result = enforceChapterCap(chapterOf([lesson, archive]), cap);
    expect(result.trimmed).toBe(0);
    expect(result.chapter.lessons[0]!.body).toBe(lesson.body);
    expect(result.chapter.lessons[1]!.provenance).toEqual(archive.provenance.slice(-5));
  });

  it('stops at the newest PROVENANCE_FLOOR handles and only then trims lesson text', () => {
    const cited = handles(8);
    const lesson = { slug: 'long', body: `Long lesson. ${'detail '.repeat(120)}end.`, recurred: 8, provenance: cited, tags: [] };
    const result = enforceChapterCap(chapterOf([lesson]), 700);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(700);
    expect(result.chapter.lessons[0]!.provenance).toEqual(cited.slice(-PROVENANCE_FLOOR));
    expect(result.provenanceTrimmed).toBe(8 - PROVENANCE_FLOOR);
    expect(result.trimmed).toBeGreaterThan(0);
    expect(result.droppedLessons).toBe(0);
  });

  const JOURNAL = new Map([
    ['j-869', '2026-10-02T20:01:00.000Z'],
    ['j-870', '2026-10-02T20:02:00.000Z'],
    ['j-878', '2026-10-02T20:10:00.000Z'],
    ['j-879', '2026-10-02T20:30:37.346Z'],
    ['j-880', '2026-10-02T20:46:43.208Z'],
    ['j-884', '2026-10-02T20:59:25.619Z'],
    ['j-900', '2026-10-02T22:00:00.000Z'],
    ['j-907', '2026-10-02T22:53:41.547Z'],
    ['j-914', '2026-10-02T23:10:00.000Z'],
    ['j-922', '2026-10-03T00:33:26.465Z'],
    ['j-1068', '2026-10-03T19:13:43.445Z'],
  ]);

  /** The exact hand-edited shapes found in the live book on 2026-10-07. */
  const HAND_EDITED = [
    '# Completion contract',
    '',
    'summary: Continuous completion.',
    '',
    '## every-heist-advances',
    '',
    'recurred: 2',
    'provenance: j-879@2026-10-02T20:30:37.346Z, j-884@2026-10-02T20:59:25.619Z; earlier: j-869, j-878',
    'tags: completion',
    '',
    'Every approved heist resolves to owned work.',
    'provenance: j-999 is quoted in this body and must never be touched',
    '',
    '## delivery-truth',
    '',
    'recurred: 4',
    'provenance: j-1068@2026-10-03T19:13:43.445Z; earlier: j-907,2026-10-02T22:53:41.547Z, j-880@2026-10-02T20:46:43.208Z; earlier: j-870, j-878',
    '',
    'Failed jobs are never marked delivered.',
    '',
    '## review-rounds',
    '',
    'recurred: 3',
    'provenance: j-922@2026-10-03T00:33:26.465Z, j-914; earlier: j-900',
    '',
    'A round binds one head.',
    '',
  ].join('\n');

  it('repairChapterProvenance rebuilds the live hand-edited shapes from the journal, oldest first', () => {
    expect(() => parseChapter(HAND_EDITED, 'completion-contract')).toThrowError(/must be "<journal-id>@<iso-date>"/);
    const { chapter, linesRewritten } = repairChapterProvenance(HAND_EDITED, 'completion-contract', JOURNAL);
    expect(linesRewritten).toBe(3);
    const ids = (slug: string) => chapter.lessons.find((lesson) => lesson.slug === slug)!.provenance;
    const ref = (id: string) => ({ id, ts: JOURNAL.get(id)! });
    expect(ids('every-heist-advances')).toEqual(['j-869', 'j-878', 'j-879', 'j-884'].map(ref));
    expect(ids('delivery-truth')).toEqual(['j-870', 'j-878', 'j-880', 'j-907', 'j-1068'].map(ref));
    expect(ids('review-rounds')).toEqual(['j-900', 'j-914', 'j-922'].map(ref));
    // Body text is never rewritten, even a line that looks like metadata.
    expect(chapter.lessons[0]!.body).toContain('provenance: j-999 is quoted in this body');
    expect(parseChapter(serializeChapter(chapter), 'completion-contract')).toEqual(chapter);
  });

  it('refuses to invent provenance: an id missing from the journal aborts with its name', () => {
    const missing = new Map(JOURNAL);
    missing.delete('j-878');
    expect(() => repairChapterProvenance(HAND_EDITED, 'completion-contract', missing)).toThrowError(
      /cites journal id j-878, which is not in the journal/,
    );
  });

  it('repairProvenance: a dry run writes nothing, --write backs up first, and a second run is a no-op', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const file = join(bible.chaptersDir, 'completion-contract.md');
    writeFileSync(file, HAND_EDITED, 'utf-8');
    const now = new Date('2026-10-07T12:00:00.000Z');

    const dry = bible.repairProvenance(JOURNAL, { write: false, now });
    expect(dry.backupDir).toBeNull();
    expect(dry.chapters).toEqual([
      expect.objectContaining({ slug: 'completion-contract', changed: true, linesRewritten: 3, lessonsBefore: 3, lessonsAfter: 3 }),
    ]);
    expect(readFileSync(file, 'utf-8')).toBe(HAND_EDITED);

    const applied = bible.repairProvenance(JOURNAL, { write: true, now });
    expect(applied.backupDir).toBe(join(bible.dir, '.repair-backup-2026-10-07T12-00-00-000Z'));
    expect(readFileSync(join(applied.backupDir!, 'chapters', 'completion-contract.md'), 'utf-8')).toBe(HAND_EDITED);
    expect(bible.readChapters().map((chapter) => chapter.slug)).toEqual(['completion-contract']);

    const again = bible.repairProvenance(JOURNAL, { write: true, now });
    expect(again.backupDir).toBeNull();
    expect(again.chapters.every((chapter) => !chapter.changed)).toBe(true);
  });

  it('the owner tool: a dry run reports, --write repairs and proves the book with the strict reader', () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-repair-tool-'));
    cleanupDirs.push(home);
    const journal = new JournalStore(join(home, 'journal'));
    const first = journal.append({ kind: 'finding', source: 'gru', body: 'first sighting' });
    const second = journal.append({ kind: 'finding', source: 'silas', body: 'second sighting' });
    const chapters = join(home, 'bible', 'chapters');
    mkdirSync(chapters, { recursive: true });
    const file = join(chapters, 'ops.md');
    const broken = `# Ops\n\n## restarts\n\nrecurred: 2\nprovenance: ${second.id}@${second.ts}; earlier: ${first.id}\n\nRestart with care.\n`;
    writeFileSync(file, broken, 'utf-8');
    const tool = resolve(import.meta.dirname, '..', 'tools', 'repair-bible-provenance.mjs');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], { encoding: 'utf-8', env: { ...process.env, GRU_COMMAND_HOME: home } });

    const dry = run();
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('CHANGE ops: lessons 1→1');
    expect(dry.stdout).toContain('1 chapter(s) would change — re-run with --write to apply');
    expect(readFileSync(file, 'utf-8')).toBe(broken);

    const applied = run('--write');
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain('repaired 1 chapter(s); every chapter parses and fits the cap');
    expect(readFileSync(file, 'utf-8')).toContain(`provenance: ${first.id}@${first.ts}, ${second.id}@${second.ts}`);
    expect(existsSync(join(home, 'bible'))).toBe(true);
  });
});
