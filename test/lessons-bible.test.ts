import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BibleStore,
  enforceChapterCap,
  parseChapter,
  BIBLE_WRITE_LOCK,
  compareProvenance,
  PROVENANCE_FLOOR,
  RepairWriteError,
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
    // Old references go before lesson text (owner decision 2026-10-07): the
    // archive keeps the NEWEST dropped handle and never invents one.
    const archived = reparsed.lessons.find((lesson) => lesson.slug === 'archived-provenance')!;
    const droppedIds = new Set(result.droppedProvenance.map((ref) => ref.id));
    expect(archived.provenance.length).toBeGreaterThan(0);
    for (const ref of archived.provenance) expect(droppedIds.has(ref.id)).toBe(true);
    const newestDropped = [...result.droppedProvenance].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)!;
    expect(archived.provenance.map((ref) => ref.id)).toContain(newestDropped.id);
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
      expect.objectContaining({
        slug: 'completion-contract',
        changed: true,
        linesRewritten: 3,
        lessonsBefore: 3,
        lessonsAfter: 3,
        formatting: 'preserved',
      }),
    ]);
    expect(readFileSync(file, 'utf-8')).toBe(HAND_EDITED);

    const applied = bible.repairProvenance(JOURNAL, { write: true, now });
    expect(applied.backupDir).toMatch(/[/\\]\.repair-backup-2026-10-07T12-00-00-000Z-[0-9a-f]{8}$/u);
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

describe('repair and cap review fixes (bmad-code-review of #253, 2026-10-07)', () => {
  const ARCHIVE_BODY = 'Lessons trimmed at the chapter cap; provenance retained so the journal remains the ground truth.';
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  const ref = (seq: number, minute = seq): ProvenanceRef => ({ id: `j-${seq}`, ts: at(minute) });
  const lesson = (slug: string, provenance: ProvenanceRef[], recurred = 1, body = `${slug} ${'x'.repeat(154)}`) => ({
    slug,
    body: body.slice(0, Math.max(body.length, 1)),
    recurred,
    provenance,
    tags: [] as string[],
  });
  const archive = (provenance: ProvenanceRef[]) => ({
    slug: 'archived-provenance',
    body: ARCHIVE_BODY,
    recurred: 1,
    provenance,
    tags: ['archived'],
  });
  const chapterOf = (lessons: BibleChapter['lessons']): BibleChapter => ({ slug: 'fix', title: 'Fix', summary: '', tags: [], lessons });
  const bytes = (chapter: BibleChapter): number => Buffer.byteLength(serializeChapter(chapter), 'utf8');
  const JOURNAL = new Map(Array.from({ length: 30 }, (_, index) => [`j-${index + 1}`, at(index + 1)] as const));

  it('a dropped lesson joins the archive at once, so one lesson plus a one-handle archive survives the cap', () => {
    // The dropped lesson brings three handles; only once they shrink to one
    // does the archive fit beside the surviving lesson — which must stay.
    const a = lesson('a', [ref(1), ref(2), ref(3)], 1);
    const b = lesson('b', [ref(4)], 2);
    const cap = bytes(chapterOf([b, archive([ref(3)])]));
    const result = enforceChapterCap(chapterOf([a, b]), cap);
    expect(result.chapter.lessons.map((entry) => entry.slug)).toEqual(['b', 'archived-provenance']);
    expect(result.chapter.lessons[1]!.provenance).toEqual([ref(3)]);
    expect(result.droppedLessons).toBe(1);
  });

  it('an existing archive is sized once, as the union of old and newly dropped handles', () => {
    const a = lesson('a', [ref(1)], 1);
    const b = lesson('b', [ref(2)], 2);
    const cap = bytes(chapterOf([b, archive([ref(6)])]));
    const result = enforceChapterCap(chapterOf([a, b, archive([ref(5), ref(6)])]), cap);
    expect(result.chapter.lessons.map((entry) => entry.slug)).toEqual(['b', 'archived-provenance']);
    expect(result.chapter.lessons[1]!.provenance).toEqual([ref(6)]);
  });

  it('releases the chronologically oldest handle whatever the stored order, ties broken by journal sequence', () => {
    const fitsWithOne = bytes(chapterOf([lesson('a', [ref(1)]), archive([ref(20)])]));
    const squeezed = enforceChapterCap(chapterOf([lesson('a', [ref(1)]), archive([ref(20), ref(10)])]), fitsWithOne);
    expect(squeezed.chapter.lessons[1]!.provenance).toEqual([ref(20)]);

    const tied = [8, 9, 10, 11, 12].map((seq) => ref(seq, 5)); // equal timestamps
    const floor = bytes(chapterOf([lesson('t', tied.slice(-PROVENANCE_FLOOR))]));
    const result = enforceChapterCap(chapterOf([lesson('t', [tied[4]!, tied[0]!, tied[3]!, tied[1]!, tied[2]!])]), floor);
    expect(result.chapter.lessons[0]!.provenance.map((entry) => entry.id)).toEqual(['j-10', 'j-11', 'j-12']);
  });

  it('runs until the chapter fits — 10,004 handles or 300 archived ones — and counts every release', () => {
    const many = Array.from({ length: 10_004 }, (_, index) => ({ id: `j-${index + 1}`, ts: at(index + 1) }));
    const cap = bytes(chapterOf([lesson('busy', many.slice(-PROVENANCE_FLOOR))]));
    const result = enforceChapterCap(chapterOf([lesson('busy', many)]), cap);
    expect(result.chapter.lessons[0]!.provenance).toEqual(many.slice(-PROVENANCE_FLOOR));
    expect(result.provenanceTrimmed).toBe(10_001);
    expect(result.trimmed).toBe(0);

    const archived = Array.from({ length: 300 }, (_, index) => ({ id: `j-${index + 1}`, ts: at(index + 1) }));
    const squeezedCap = bytes(chapterOf([archive(archived.slice(-1))]));
    const squeezed = enforceChapterCap(chapterOf([archive(archived)]), squeezedCap);
    expect(squeezed.chapter.lessons[0]!.provenance).toEqual(archived.slice(-1));
    expect(squeezed.provenanceTrimmed).toBe(299);
  });

  it('refuses unrecognized fragments and contradicted timestamps instead of erasing them', () => {
    const chapter = (provenance: string) => `# Fix\n\n## a\n\nrecurred: 1\nprovenance: ${provenance}\n\nBody.\n`;
    expect(() => repairChapterProvenance(chapter('j-999x'), 'fix', JOURNAL)).toThrowError(/unrecognized provenance fragment "j-999x"/);
    expect(() => repairChapterProvenance(chapter('j-1, see j-2 later'), 'fix', JOURNAL)).toThrowError(/unrecognized provenance fragment "see j-2 later"/);
    expect(() => repairChapterProvenance(chapter(`j-1@${at(9)}`), 'fix', JOURNAL)).toThrowError(/journal records j-1 at/);
  });

  it('collects every provenance line of a lesson into one canonical line, idempotently', () => {
    const text = `# Fix\n\n## a\n\nrecurred: 2\nprovenance: j-2\nprovenance: j-1, j-2\ntags: x\n\nBody.\n`;
    const once = repairChapterProvenance(text, 'fix', JOURNAL);
    expect(once.text).toBe(`# Fix\n\n## a\n\nrecurred: 2\nprovenance: j-1@${at(1)}, j-2@${at(2)}\ntags: x\n\nBody.\n`);
    expect(once.linesRewritten).toBe(2);
    const twice = repairChapterProvenance(once.text, 'fix', JOURNAL);
    expect(twice.text).toBe(once.text);
    expect(twice.linesRewritten).toBe(0);
  });

  function bibleWith(files: Record<string, string>): BibleStore {
    const bible = tmpBible();
    bible.ensureSeeded();
    for (const [name, text] of Object.entries(files)) writeFileSync(join(bible.chaptersDir, name), text, 'utf-8');
    return bible;
  }

  const brokenA = `# A\n\n## a\n\nrecurred: 1\nprovenance: j-2; earlier: j-1\n\n    indented();\n      deeper();\n\nTrailing prose.\n`;

  it('keeps body bytes exactly below the cap — only the provenance line changes', () => {
    const bible = bibleWith({ 'a.md': brokenA });
    const report = bible.repairProvenance(JOURNAL, { write: true });
    expect(report.chapters).toEqual([expect.objectContaining({ slug: 'a', changed: true, bodiesTrimmed: 0, formatting: 'preserved' })]);
    expect(readFileSync(join(bible.chaptersDir, 'a.md'), 'utf-8')).toBe(
      brokenA.replace('provenance: j-2; earlier: j-1', `provenance: j-1@${at(1)}, j-2@${at(2)}`),
    );
  });

  it('every chapter is checked before any write: one bad chapter leaves the whole book and backups untouched', () => {
    const bad = `# Z\n\n## z\n\nrecurred: 1\nprovenance: j-404\n\nBody.\n`;
    const bible = bibleWith({ 'a.md': brokenA, 'z.md': bad });
    expect(() => bible.repairProvenance(JOURNAL, { write: true })).toThrowError(/cites journal id j-404/);
    expect(readFileSync(join(bible.chaptersDir, 'a.md'), 'utf-8')).toBe(brokenA);
    expect(readFileSync(join(bible.chaptersDir, 'z.md'), 'utf-8')).toBe(bad);
    expect(readdirSync(bible.dir).filter((name) => name.startsWith('.repair-backup-'))).toEqual([]);
  });

  it('never reuses a backup directory, even for two repairs stamped the same instant', () => {
    const now = new Date('2026-10-07T12:00:00.000Z');
    const bible = bibleWith({ 'a.md': brokenA });
    const first = bible.repairProvenance(JOURNAL, { write: true, now });
    const brokenB = brokenA.replace('# A', '# A again');
    writeFileSync(join(bible.chaptersDir, 'a.md'), brokenB, 'utf-8');
    const second = bible.repairProvenance(JOURNAL, { write: true, now });
    expect(first.backupDir).not.toBe(second.backupDir);
    expect(readFileSync(join(first.backupDir!, 'chapters', 'a.md'), 'utf-8')).toBe(brokenA);
    expect(readFileSync(join(second.backupDir!, 'chapters', 'a.md'), 'utf-8')).toBe(brokenB);
  });

  it('a failed write names what was replaced and where every original is', () => {
    const bible = bibleWith({ 'a.md': brokenA, 'b.md': brokenA.replace('# A', '# B') });
    const store = bible as unknown as { writeAtomic(file: string, text: string): void };
    const real = store.writeAtomic.bind(bible);
    let chapterWrites = 0;
    store.writeAtomic = (file: string, text: string) => {
      if (file.startsWith(bible.chaptersDir) && ++chapterWrites === 2) throw new Error('disk full');
      real(file, text);
    };
    let caught: unknown;
    try {
      bible.repairProvenance(JOURNAL, { write: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RepairWriteError);
    const failure = caught as RepairWriteError;
    expect(failure.written).toEqual(['a']);
    expect(failure.message).toContain('repair stopped after replacing 1 of 2 chapter(s) (a) — disk full');
    expect(failure.message).toContain('may be partially repaired');
    expect(readFileSync(join(failure.backupDir, 'chapters', 'b.md'), 'utf-8')).toBe(brokenA.replace('# A', '# B'));
  });

  it('repair and the dream share the write lock: contention fails loud; a dead holder is taken over', () => {
    const bible = bibleWith({ 'a.md': brokenA });
    const lock = join(bible.dir, BIBLE_WRITE_LOCK);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, action: 'dream apply', at: 'now' }));
    expect(() => bible.repairProvenance(JOURNAL, { write: true })).toThrowError(/being written by pid \d+ \(dream apply/);
    expect(() => bible.applyUpdates([proposal()], PROVENANCE)).toThrowError(/being written by pid/);
    expect(readFileSync(join(bible.chaptersDir, 'a.md'), 'utf-8')).toBe(brokenA);
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    writeFileSync(lock, JSON.stringify({ pid: dead, action: 'provenance repair', at: 'then' }));
    expect(bible.repairProvenance(JOURNAL, { write: true }).backupDir).not.toBeNull();
    expect(existsSync(lock)).toBe(false);
  });

  it('the tool refuses another instance’s data dir and uses the selected instance’s cap', () => {
    const instance = (cap: number) => {
      const home = mkdtempSync(join(tmpdir(), 'gru-command-repair-instance-'));
      cleanupDirs.push(home);
      writeFileSync(join(home, 'config.toml'), `[lessons]\nchapter_cap_bytes = ${cap}\n`, 'utf-8');
      mkdirSync(join(home, 'bible', 'chapters'), { recursive: true });
      return home;
    };
    const a = instance(4_096);
    const b = instance(8_192);
    const tool = resolve(import.meta.dirname, '..', 'tools', 'repair-bible-provenance.mjs');
    const run = (home: string, ...args: string[]) =>
      spawnSync(process.execPath, [tool, ...args], { encoding: 'utf-8', env: { ...process.env, GRU_COMMAND_HOME: home } });
    const crossed = run(a, b);
    expect(crossed.status).toBe(1);
    expect(crossed.stderr).toContain('is not this instance\'s data dir');
    expect(crossed.stderr).toContain('nothing was written');
    const own = run(b, b);
    expect(own.status, own.stderr).toBe(0);
    expect(own.stdout).toContain('cap 8192 B');
  });
});

describe('second review round of #253 (bmad-code-review, 2026-10-07)', () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  const JOURNAL = new Map(Array.from({ length: 30 }, (_, index) => [`j-${index + 1}`, at(index + 1)] as const));
  const handlesLine = (ids: number[]) => `provenance: ${ids.map((id) => `j-${id}@${at(id)}`).join(', ')}`;
  function bibleWith(files: Record<string, string>, cap = 4_096): BibleStore {
    const bible = tmpBible(cap);
    bible.ensureSeeded();
    for (const [name, text] of Object.entries(files)) writeFileSync(join(bible.chaptersDir, name), text, 'utf-8');
    return bible;
  }
  const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

  it('a dead holder is reclaimed only through the gate, and a release never removes a lock it does not own', () => {
    const chapter = `# A\n\n## a\n\nrecurred: 1\nprovenance: j-2; earlier: j-1\n\nBody.\n`;
    const bible = bibleWith({ 'a.md': chapter });
    const lock = join(bible.dir, BIBLE_WRITE_LOCK);
    writeFileSync(lock, JSON.stringify({ pid: deadPid(), token: 'old', action: 'dream apply', at: 'then' }));
    mkdirSync(`${lock}.reclaim`); // another process is mid-reclaim
    expect(() => bible.repairProvenance(JOURNAL, { write: true })).toThrowError(/another process is reclaiming/);
    expect(JSON.parse(readFileSync(lock, 'utf-8')).token).toBe('old');
    rmSync(`${lock}.reclaim`, { recursive: true });
    expect(bible.repairProvenance(JOURNAL, { write: true }).backupDir).not.toBeNull();
    expect(existsSync(lock)).toBe(false);

    const store = bible as unknown as { withWriteLock<T>(action: string, fn: () => T): T };
    store.withWriteLock('test', () => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'someone-else', action: 'x', at: 'now' }));
    });
    expect(JSON.parse(readFileSync(lock, 'utf-8')).token).toBe('someone-else');
  });

  it('a lock that cannot be taken leaves no lock or staging file behind', () => {
    const bible = bibleWith({ 'a.md': `# A\n\n## a\n\nrecurred: 1\nprovenance: j-1\n\nBody.\n` });
    chmodSync(bible.dir, 0o500);
    try {
      expect(() => bible.repairProvenance(JOURNAL, { write: true })).toThrowError();
    } finally {
      chmodSync(bible.dir, 0o700);
    }
    expect(readdirSync(bible.dir).filter((name) => name.startsWith(BIBLE_WRITE_LOCK))).toEqual([]);
  });

  it('a cleanup failure after every chapter was written is reported with the backup — never "nothing was written"', () => {
    const bible = bibleWith({ 'a.md': `# A\n\n## a\n\nrecurred: 1\nprovenance: j-2; earlier: j-1\n\nBody.\n` });
    const store = bible as unknown as { releaseLock(lock: string, token: string): void };
    store.releaseLock = () => {
      throw new Error('unlink failed');
    };
    let caught: unknown;
    try {
      bible.repairProvenance(JOURNAL, { write: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RepairWriteError);
    expect((caught as RepairWriteError).message).toContain('repair replaced all 1 chapter(s) (a), then failed: unlink failed');
    expect(existsSync((caught as RepairWriteError).backupDir)).toBe(true);
  });

  it('a chapter that already fits as repaired keeps every byte — even at exactly the cap', () => {
    // Compact (no blank lines): the canonical form is LARGER than this file,
    // so measuring canonical text would wrongly see it over the cap.
    const text = `# A\n## only\nrecurred: 1\nprovenance: j-2; earlier: j-1\nShort body.\n`;
    const repaired = repairChapterProvenance(text, 'a', JOURNAL).text;
    const bible = bibleWith({ 'a.md': text }, Buffer.byteLength(repaired, 'utf8'));
    const report = bible.repairProvenance(JOURNAL, { write: true });
    expect(report.chapters[0]).toMatchObject({ lessonsAfter: 1, lessonsDropped: 0, bodiesTrimmed: 0, formatting: 'preserved' });
    expect(readFileSync(join(bible.chaptersDir, 'a.md'), 'utf-8')).toBe(repaired);
  });

  it('over the cap, references are released on the real file and the body bytes stay untouched', () => {
    // Deep indentation: the canonical form drops it and would "fit", while
    // the real file is over — measuring canonical text kept all five handles
    // and threw the indentation away.
    const text = `# A\n\n## busy\n\nrecurred: 5\n${handlesLine([1, 2, 3, 4, 5])}\n\n${' '.repeat(40)}keep();\n      this();\n`;
    const bible = bibleWith({ 'a.md': text }, Buffer.byteLength(text, 'utf8') - 20);
    const report = bible.repairProvenance(JOURNAL, { write: true });
    expect(report.chapters[0]).toMatchObject({ provenanceTrimmed: 1, bodiesTrimmed: 0, lessonsDropped: 0, formatting: 'preserved' });
    const written = readFileSync(join(bible.chaptersDir, 'a.md'), 'utf-8');
    expect(written).toBe(text.replace(handlesLine([1, 2, 3, 4, 5]), handlesLine([2, 3, 4, 5])));
    expect(Buffer.byteLength(written, 'utf8')).toBeLessThanOrEqual(bible.chapterCapBytes);
    expect(readFileSync(join(report.backupDir!, 'chapters', 'a.md'), 'utf-8')).toBe(text);
  });

  it('keeps CRLF and mixed line endings byte for byte', () => {
    const crlf = '# A\r\n\r\n## a\r\n\r\nrecurred: 1\r\nprovenance: j-2; earlier: j-1\r\n\r\nLine one.\r\nLine two.\r\n';
    const mixed = '# B\n\r\n## b\r\n\nrecurred: 1\nprovenance: j-1\r\n\nMixed.\r\nEndings.\n';
    const canonical = `provenance: j-1@${at(1)}, j-2@${at(2)}`;
    expect(repairChapterProvenance(crlf, 'a', JOURNAL).text).toBe(crlf.replace('provenance: j-2; earlier: j-1', canonical));
    expect(repairChapterProvenance(mixed, 'b', JOURNAL).text).toBe(mixed.replace('provenance: j-1', `provenance: j-1@${at(1)}`));
  });

  it('a lesson without journal handles is evicted before a journal-backed one, in either order', () => {
    const backed = { slug: 'backed', body: `backed ${'x'.repeat(153)}`, recurred: 1, provenance: [{ id: 'j-1', ts: at(1) }], tags: [] };
    const bare = { slug: 'bare', body: `bare ${'y'.repeat(155)}`, recurred: 1, provenance: [] as ProvenanceRef[], tags: [] };
    for (const lessons of [[backed, bare], [bare, backed]]) {
      const chapter: BibleChapter = { slug: 'fix', title: 'Fix', summary: '', tags: [], lessons };
      const smaller = enforceChapterCap(chapter, Buffer.byteLength(serializeChapter(chapter), 'utf8') - 1);
      expect(smaller.chapter.lessons.map((lesson) => lesson.slug)).toContain('backed');
      expect(smaller.chapter.lessons.map((lesson) => lesson.slug)).not.toContain('bare');
    }
  });

  it('equal recurrence evicts the chronologically older lesson, ties broken by journal sequence', () => {
    const newer = { slug: 'newer', body: `newer ${'n'.repeat(154)}`, recurred: 2, provenance: [{ id: 'j-10', ts: at(5) }], tags: [] };
    const older = { slug: 'older', body: `older ${'o'.repeat(154)}`, recurred: 2, provenance: [{ id: 'j-9', ts: at(5) }], tags: [] };
    const chapter: BibleChapter = { slug: 'fix', title: 'Fix', summary: '', tags: [], lessons: [newer, older] };
    const cap = Buffer.byteLength(serializeChapter(chapter), 'utf8') - 1;
    const result = enforceChapterCap(chapter, cap);
    expect(result.chapter.lessons.map((lesson) => lesson.slug)).toEqual(['newer', 'archived-provenance']);
  });

  it('orders handles by instant, not spelling', () => {
    const offset = { id: 'j-2', ts: '2026-10-01T01:00:00+02:00' }; // 2026-09-30T23:00Z
    const zulu = { id: 'j-1', ts: '2026-10-01T00:00:00Z' };
    expect(compareProvenance(offset, zulu)).toBeLessThan(0);
    expect(compareProvenance({ id: 'j-3', ts: '2026-10-01T00:00:00.5Z' }, { id: 'j-4', ts: '2026-10-01T00:00:00.500Z' })).toBeLessThan(0);
    expect(compareProvenance({ id: 'j-4', ts: '2026-10-01T00:00:00.5Z' }, { id: 'j-3', ts: '2026-10-01T00:00:00.500Z' })).toBeGreaterThan(0);
  });

  it('the tool refuses an inconsistent journal before any write', () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-repair-journal-'));
    cleanupDirs.push(home);
    const journal = new JournalStore(join(home, 'journal'));
    const first = journal.append({ kind: 'finding', source: 'gru', body: 'first' });
    mkdirSync(join(home, 'bible', 'chapters'), { recursive: true });
    const chapter = `# Ops\n\n## a\n\nrecurred: 1\nprovenance: ${first.id}\n\nBody.\n`;
    writeFileSync(join(home, 'bible', 'chapters', 'ops.md'), chapter);
    const file = join(home, 'journal', readdirSync(join(home, 'journal')).find((name) => name.endsWith('.jsonl'))!);
    const duplicate = { ...JSON.parse(readFileSync(file, 'utf-8').trim().split('\n')[0]!), seq: 2, ts: '2026-01-01T00:00:00.000Z' };
    appendFileSync(file, `${JSON.stringify(duplicate)}\n`);
    const tool = resolve(import.meta.dirname, '..', 'tools', 'repair-bible-provenance.mjs');
    const ran = spawnSync(process.execPath, [tool, '--write'], { encoding: 'utf-8', env: { ...process.env, GRU_COMMAND_HOME: home } });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(/journal entry seq 2 is recorded as j-1|journal id j-1 appears twice/);
    expect(readFileSync(join(home, 'bible', 'chapters', 'ops.md'), 'utf-8')).toBe(chapter);
  });
});

describe('plan, then apply only onto the planned book (owner decision 2026-10-07)', () => {
  it('planUpdates writes nothing and describes exactly what Accept would change', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    bible.applyUpdates([proposal()], PROVENANCE);
    const index = bible.readIndexText();
    const chapter = readFileSync(join(bible.dir, 'chapters', 'ops-restarts.md'), 'utf-8');
    const plan = bible.planUpdates(
      [
        proposal({
          lessons: [
            { slug: 'shell-hang', body: 'A live shell holds the session open; close it first.', journalIds: ['j-2'] },
            { slug: 'new-lesson', body: 'Something new to keep.', journalIds: ['j-3'] },
          ],
        }),
      ],
      PROVENANCE,
    );
    expect(bible.readIndexText()).toBe(index);
    expect(readFileSync(join(bible.dir, 'chapters', 'ops-restarts.md'), 'utf-8')).toBe(chapter);
    expect(plan.base).not.toBe(plan.after);
    expect(plan.changes).toEqual([
      expect.objectContaining({
        slug: 'ops-restarts',
        added: [{ slug: 'new-lesson', body: 'Something new to keep.', recurred: 1, previousBody: null }],
        changed: [
          expect.objectContaining({ slug: 'shell-hang', recurred: 2, body: 'A live shell holds the session open; close it first.' }),
        ],
      }),
    ]);
    expect(plan.report).toMatchObject({ chaptersWritten: 1, lessonsAdded: 1, lessonsMerged: 1 });
  });

  it('applyPlan refuses a book that moved since planning, and is a no-op once applied', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const plan = bible.planUpdates([proposal()], PROVENANCE);
    writeFileSync(join(bible.dir, 'INDEX.md'), `${bible.readIndexText() ?? ''}\n`);
    expect(() => bible.applyPlan(plan)).toThrowError(expect.objectContaining({ name: 'ProposalError', code: 'stale' }));
    expect(bible.readChapter('ops-restarts')).toBeNull();

    const fresh = bible.planUpdates([proposal()], PROVENANCE);
    bible.applyPlan(fresh);
    const written = readFileSync(join(bible.dir, 'chapters', 'ops-restarts.md'), 'utf-8');
    expect(bible.applyPlan(fresh)).toEqual(fresh.report);
    expect(readFileSync(join(bible.dir, 'chapters', 'ops-restarts.md'), 'utf-8')).toBe(written);
  });
});
