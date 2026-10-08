import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  BibleStore,
  enforceChapterCap,
  parseChapter,
  BIBLE_WRITE_LOCK,
  BIBLE_WRITE_LOCK_HOLDER,
  bookFingerprint,
  checkPlan,
  compareIsoInstants,
  compareProvenance,
  describePlan,
  parseIsoInstant,
  PROVENANCE_FLOOR,
  RepairWriteError,
  repairChapterProvenance,
  parseIndex,
  renderIndex,
  serializeChapter,
} from '../src/lessons/bible.js';
import { JournalStore } from '../src/lessons/journal.js';
import { createBibleReferences } from '../src/lessons/references.js';
import { ARCHIVED_LESSON_SLUG as WEB_ARCHIVED_LESSON_SLUG } from '../web/src/lib/board-protocol.js';
import { ARCHIVED_LESSON_SLUG, BibleError, type BibleChapter, type ProposedChapter, type ProvenanceRef } from '../src/lessons/types.js';
import type { BiblePlan } from '../src/lessons/bible.js';

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

/** A separate process that takes the book's write lock and holds it until
 * killed — it never releases it itself. */
const HOLD_LOCK = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN EXCLUSIVE');
require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, action: 'dream apply', at: new Date().toISOString() }));
process.stdout.write('held\\n');
setInterval(() => {}, 60000);
`;
async function holdBookLock(bible: BibleStore): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--no-warnings', '-e', HOLD_LOCK, join(bible.dir, BIBLE_WRITE_LOCK), join(bible.dir, BIBLE_WRITE_LOCK_HOLDER)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolveHeld, rejectHeld) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('held')) resolveHeld();
    });
    child.once('exit', () => rejectHeld(new Error('the lock holder exited before taking the lock')));
  });
  return child;
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
    expect(report.chapters).toEqual([expect.objectContaining({ slug: 'a', changed: true, bodiesTrimmed: 0 })]);
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

  it('repair and the dream share the write lock: contention fails loud; a holder that dies releases it', async () => {
    const bible = bibleWith({ 'a.md': brokenA });
    const holder = await holdBookLock(bible);
    try {
      expect(() => bible.repairProvenance(JOURNAL, { write: true })).toThrowError(/being written by pid \d+ \(dream apply/);
      expect(() => bible.applyUpdates([proposal()], PROVENANCE)).toThrowError(/being written by pid/);
      expect(readFileSync(join(bible.chaptersDir, 'a.md'), 'utf-8')).toBe(brokenA);
    } finally {
      holder.kill('SIGKILL');
      await once(holder, 'exit');
    }
    // Killed without any cleanup of its own: the OS released its lock.
    expect(bible.repairProvenance(JOURNAL, { write: true }).backupDir).not.toBeNull();
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

  it('leftover files of the old lock design — and a stale holder note — block nothing', () => {
    const chapter = `# A\n\n## a\n\nrecurred: 1\nprovenance: j-2; earlier: j-1\n\nBody.\n`;
    const bible = bibleWith({ 'a.md': chapter });
    writeFileSync(join(bible.dir, '.write.lock'), JSON.stringify({ pid: process.ppid, token: 'old', action: 'dream apply', at: 'then' }));
    mkdirSync(join(bible.dir, '.write.lock.reclaim'));
    writeFileSync(join(bible.dir, BIBLE_WRITE_LOCK_HOLDER), JSON.stringify({ pid: process.ppid, action: 'dream apply', at: 'then' }));
    expect(bible.repairProvenance(JOURNAL, { write: true }).backupDir).not.toBeNull();
    expect(bible.applyUpdates([proposal()], PROVENANCE).chaptersWritten).toBe(1);
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

  it('a chapter that already fits as repaired keeps every byte — even at exactly the cap', () => {
    // Compact (no blank lines): the canonical form is LARGER than this file,
    // so measuring canonical text would wrongly see it over the cap.
    const text = `# A\n## only\nrecurred: 1\nprovenance: j-2; earlier: j-1\nShort body.\n`;
    const repaired = repairChapterProvenance(text, 'a', JOURNAL).text;
    const bible = bibleWith({ 'a.md': text }, Buffer.byteLength(repaired, 'utf8'));
    const report = bible.repairProvenance(JOURNAL, { write: true });
    expect(report.chapters[0]).toMatchObject({ lessonsAfter: 1, lessonsDropped: 0, bodiesTrimmed: 0 });
    expect(readFileSync(join(bible.chaptersDir, 'a.md'), 'utf-8')).toBe(repaired);
  });

  it('over the cap, references are released on the real file and the body bytes stay untouched', () => {
    // Deep indentation: the canonical form drops it and would "fit", while
    // the real file is over — measuring canonical text kept all five handles
    // and threw the indentation away.
    const text = `# A\n\n## busy\n\nrecurred: 5\n${handlesLine([1, 2, 3, 4, 5])}\n\n${' '.repeat(40)}keep();\n      this();\n`;
    const bible = bibleWith({ 'a.md': text }, Buffer.byteLength(text, 'utf8') - 20);
    const report = bible.repairProvenance(JOURNAL, { write: true });
    expect(report.chapters[0]).toMatchObject({ provenanceTrimmed: 1, bodiesTrimmed: 0, lessonsDropped: 0 });
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

describe('third review round of #253 (bmad-code-review, 2026-10-07)', () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  const JOURNAL = new Map(Array.from({ length: 30 }, (_, index) => [`j-${index + 1}`, at(index + 1)] as const));
  const TOOL = resolve(import.meta.dirname, '..', 'tools', 'repair-bible-provenance.mjs');
  const backups = (bibleDir: string): string[] => readdirSync(bibleDir).filter((name) => name.startsWith('.repair-backup-'));
  const lessonOf = (slug: string, provenance: ProvenanceRef[], body: string) => ({ slug, body, recurred: 1, provenance, tags: [] as string[] });
  const chapterOf = (lessons: BibleChapter['lessons']): BibleChapter => ({ slug: 'fix', title: 'Fix', summary: '', tags: [], lessons });

  /** An instance whose chapter cites j-1, with raw journal lines appended. */
  function toolHome(extraLines: (template: Record<string, unknown>) => readonly Record<string, unknown>[]) {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-repair-r3-'));
    cleanupDirs.push(home);
    const journal = new JournalStore(join(home, 'journal'));
    const first = journal.append({ kind: 'finding', source: 'gru', body: 'first' });
    const file = join(home, 'journal', readdirSync(join(home, 'journal')).find((name) => name.endsWith('.jsonl'))!);
    const template = JSON.parse(readFileSync(file, 'utf-8').trim().split('\n')[0]!) as Record<string, unknown>;
    appendFileSync(file, extraLines(template).map((line) => `${JSON.stringify(line)}\n`).join(''));
    mkdirSync(join(home, 'bible', 'chapters'), { recursive: true });
    const chapter = `# Ops\n\n## a\n\nrecurred: 1\nprovenance: ${first.id}\n\nBody.\n`;
    writeFileSync(join(home, 'bible', 'chapters', 'ops.md'), chapter);
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf-8', env: { ...process.env, GRU_COMMAND_HOME: home } });
    return { home, chapter, run };
  }

  it('the tool checks every journal record from one read — a conflict past a page boundary still refuses', () => {
    const { home, chapter, run } = toolHome((template) => [
      ...Array.from({ length: 9_999 }, (_, index) => ({ ...template, seq: index + 2, id: `j-${index + 2}` })),
      { ...template, seq: 10_000, id: 'j-10000', ts: '2026-01-01T00:00:00.000Z' }, // the same id, a second time
    ]);
    const ran = run('--write');
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('journal id j-10000 appears twice with different timestamps');
    expect(readFileSync(join(home, 'bible', 'chapters', 'ops.md'), 'utf-8')).toBe(chapter);
    expect(backups(join(home, 'bible'))).toEqual([]);
  });

  it('the tool refuses an invalid timestamp on any journal record, cited or not, in a dry run and with --write', () => {
    const { home, chapter, run } = toolHome((template) => [{ ...template, seq: 2, id: 'j-2', ts: 'not-a-timestamp' }]);
    for (const args of [[], ['--write']]) {
      const ran = run(...args);
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain('journal entry j-2 has an invalid timestamp "not-a-timestamp"');
    }
    expect(readFileSync(join(home, 'bible', 'chapters', 'ops.md'), 'utf-8')).toBe(chapter);
    expect(backups(join(home, 'bible'))).toEqual([]);
  });

  it('refuses a chapter with two lessons on the same anchor — nothing is guessed or rewritten', () => {
    const bible = tmpBible(4_096);
    bible.ensureSeeded();
    const file = join(bible.chaptersDir, 'dup.md');
    const text = `# Dup\n\n## a\n\nrecurred: 1\nprovenance: j-1\n\n    First body.\n\n## a\n\nrecurred: 1\nprovenance: j-2\n\nSecond body.\n`;
    writeFileSync(file, text);
    expect(() => bible.repairProvenance(JOURNAL, { write: true })).toThrowError(/more than one lesson anchored "## a"/);
    expect(readFileSync(file, 'utf-8')).toBe(text);
    expect(backups(bible.dir)).toEqual([]);
  });

  it('trimming an indented body line that reads like metadata keeps it body text, in place', () => {
    const body = `    tags: not metadata — an indented body line\n${'Restart with care. '.repeat(30).trim()}`;
    const text = `# Ops\n\n## a\n\nrecurred: 1\nprovenance: j-1@${at(1)}\n\n${body}\n`;
    const bible = tmpBible(Buffer.byteLength(text, 'utf8') - 60);
    bible.ensureSeeded();
    const file = join(bible.chaptersDir, 'ops.md');
    writeFileSync(file, text);
    const report = bible.repairProvenance(JOURNAL, { write: true });
    expect(report.chapters[0]).toMatchObject({ lessonsDropped: 0 });
    expect(report.chapters[0]!.bodiesTrimmed).toBeGreaterThan(0);
    const written = readFileSync(file, 'utf-8');
    expect(written).toContain('\n\n    tags: not metadata — an indented body line\n');
    const lesson = bible.readChapter('ops')!.lessons[0]!;
    expect(lesson.tags).toEqual([]);
    expect(lesson.body.startsWith('tags: not metadata')).toBe(true);
    expect(lesson.body.endsWith('[trimmed to fit the chapter cap]')).toBe(true);
  });

  it('dropping a lesson without journal handles creates no archive, so the lessons that fit stay', () => {
    const backed = lessonOf('backed', [{ id: 'j-1', ts: at(1) }], 'A journal-backed lesson worth keeping.');
    const uncited = lessonOf('uncited', [], 'A lesson nobody cited.');
    const result = enforceChapterCap(chapterOf([uncited, backed]), Buffer.byteLength(serializeChapter(chapterOf([backed])), 'utf8'));
    expect(result.chapter.lessons.map((lesson) => lesson.slug)).toEqual(['backed']);
    expect(result.droppedLessons).toBe(1);
    // An uncited-only chapter fits its cap once one lesson goes — no empty archive pushes it over.
    const other = lessonOf('other', [], 'Another uncited lesson.');
    const onlyUncited = enforceChapterCap(chapterOf([uncited, other]), Buffer.byteLength(serializeChapter(chapterOf([other])), 'utf8'));
    expect(onlyUncited.chapter.lessons.map((lesson) => lesson.slug)).toEqual(['other']);
  });

  it('body trimming never splits a surrogate pair', () => {
    const body = '😀'.repeat(200);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const full = Buffer.byteLength(serializeChapter(chapterOf([lessonOf('emoji', [{ id: 'j-1', ts: at(1) }], body)])), 'utf8');
    for (let over = 100; over < 108; over += 1) {
      const result = enforceChapterCap(chapterOf([lessonOf('emoji', [{ id: 'j-1', ts: at(1) }], body)]), full - over);
      const trimmed = result.chapter.lessons[0]!.body;
      expect(result.trimmed).toBeGreaterThan(0);
      expect(loneSurrogate.test(trimmed), `cap overshoot ${over}`).toBe(false);
      expect(Buffer.from(trimmed, 'utf8').toString('utf8')).toBe(trimmed);
    }
  });

  it('refuses a chapter that is not valid UTF-8 before any backup or write', () => {
    const bible = tmpBible(4_096);
    bible.ensureSeeded();
    const file = join(bible.chaptersDir, 'bad.md');
    const bytes = Buffer.concat([Buffer.from('# Bad\n\n## a\n\nrecurred: 1\nprovenance: j-1\n\nBody '), Buffer.from([0xff, 0xfe]), Buffer.from('.\n')]);
    writeFileSync(file, bytes);
    expect(() => bible.repairProvenance(JOURNAL, { write: true })).toThrowError(/is not valid UTF-8/);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(backups(bible.dir)).toEqual([]);
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
    expect(describePlan(plan).chapters).toEqual([
      expect.objectContaining({
        slug: 'ops-restarts',
        added: [
          {
            slug: 'new-lesson',
            body: 'Something new to keep.',
            recurred: 1,
            tags: [],
            previousBody: null,
            previousRecurred: null,
            previousTags: null,
          },
        ],
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

describe('the review shows every change, and text can never become metadata (review of #254)', () => {
  it('reports summary and tag changes and every removed lesson with its text', () => {
    const bible = tmpBible(4_096);
    bible.ensureSeeded();
    bible.applyUpdates(
      [
        proposal({
          lessons: [
            { slug: 'shell-hang', body: 'A live shell holds the session open.', tags: ['shell'], journalIds: ['j-1'] },
            { slug: 'old-habit', body: 'An old habit worth dropping.', journalIds: ['j-2'] },
          ],
        }),
        { slug: 'model-policy', title: 'Model policy', summary: 'Which model does what.', tags: ['models'], lessons: [{ slug: 'sol-for-silas', body: 'Silas runs on Sol.', journalIds: ['j-3'] }] },
      ],
      PROVENANCE,
    );
    const plan = bible.planUpdates(
      [
        proposal({
          summary: 'Restart and roll discipline.',
          tags: ['ops', 'roll'],
          lessons: [{ slug: 'shell-hang', body: 'A live shell holds the session open.', tags: ['shell', 'roll'], journalIds: ['j-3'] }],
        }),
        { slug: 'model-policy', title: 'Model policy', summary: 'retired', lessons: [], retire: true },
      ],
      PROVENANCE,
    );
    const ops = describePlan(plan).chapters.find((change) => change.slug === 'ops-restarts')!;
    expect(ops.summary).toEqual({ before: 'Restart discipline for the hosted service.', after: 'Restart and roll discipline.' });
    expect(ops.tags).toEqual({ before: ['ops', 'restarts'], after: ['ops', 'restarts', 'roll'] });
    expect(ops.changed).toEqual([
      expect.objectContaining({ slug: 'shell-hang', recurred: 2, tags: ['shell', 'roll'], previousTags: ['shell'], previousRecurred: 1 }),
    ]);
    const retired = describePlan(plan).chapters.find((change) => change.slug === 'model-policy')!;
    expect(retired).toMatchObject({
      retired: true,
      removed: [{ slug: 'sol-for-silas', body: 'Silas runs on Sol.', recurred: 1, reason: 'retired' }],
    });

    // The cap removing a lesson names it, with the text that disappears.
    const tight = tmpBible(4_096);
    tight.ensureSeeded();
    tight.applyUpdates([proposal({ lessons: [
      { slug: 'keep-me', body: `Keep me. ${'k'.repeat(150)}`, journalIds: ['j-1'] },
      { slug: 'drop-me', body: `Drop me. ${'d'.repeat(150)}`, journalIds: ['j-2'] },
    ] })], PROVENANCE);
    const squeezed = new BibleStore(tight.dir, { chapterCapBytes: 560 });
    const capped = squeezed.planUpdates(
      [proposal({ lessons: [{ slug: 'keep-me', body: `Keep me. ${'k'.repeat(150)}`, journalIds: ['j-3'] }] })],
      PROVENANCE,
    );
    const removed = describePlan(capped).chapters[0]!.removed;
    expect(removed.map((lesson) => [lesson.slug, lesson.reason])).toEqual([['drop-me', 'cap']]);
    expect(removed[0]!.body).toBe(`Drop me. ${'d'.repeat(150)}`);
  });

  it('refuses a lesson body that the chapter format would read back as metadata', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    expect(() =>
      bible.planUpdates(
        [proposal({ lessons: [{ slug: 'sneaky', body: 'recurred: 99\nprovenance: j-999@2026-01-01T00:00:00.000Z\nreal text', journalIds: ['j-1'] }] })],
        PROVENANCE,
      ),
    ).toThrowError(/body starts with a metadata line/);
    expect(bible.readChapter('ops-restarts')).toBeNull();
  });
});

describe('second review round of #254 — plans and their review (bmad-code-review, 2026-10-07)', () => {
  it('the review shows a rename and the INDEX lines a change rewrites, untouched chapters included', () => {
    const bible = new BibleStore(join(mkdtempSync(join(tmpdir(), 'gru-command-bible-index-')), 'bible'), { indexCapBytes: 4_096 });
    cleanupDirs.push(dirname(bible.dir));
    bible.ensureSeeded();
    bible.applyUpdates([proposal(), { slug: 'model-policy', title: 'Model policy', summary: 'Which model does what.', tags: ['models', 'routing'], lessons: [{ slug: 'sol', body: 'Silas runs on Sol.', journalIds: ['j-2'] }] }], PROVENANCE);
    // The index cap forces compaction: adding a chapter strips tags from an
    // UNTOUCHED chapter's index line.
    const tight = new BibleStore(bible.dir, { indexCapBytes: Buffer.byteLength(bible.readIndexText() ?? '', 'utf8') + 40 });
    const plan = tight.planUpdates(
      [
        proposal({ title: 'Ops restarts and rolls', lessons: [] }),
        { slug: 'zz-new', title: 'New', summary: 'A brand new chapter of lessons.', tags: ['new'], lessons: [{ slug: 'n', body: 'New lesson.', journalIds: ['j-3'] }] },
      ],
      PROVENANCE,
    );
    const review = describePlan(plan);
    expect(review.chapters.find((change) => change.slug === 'ops-restarts')!.title).toEqual({ before: 'Ops restarts', after: 'Ops restarts and rolls' });
    const untouched = review.index.find((entry) => entry.slug === 'model-policy');
    expect(untouched).toBeDefined();
    expect(untouched!.before).not.toEqual(untouched!.after);
  });

  it('creating and retiring the same chapter in one batch is simply absence', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const plan = bible.planUpdates(
      [
        { slug: 'fleeting', title: 'Fleeting', summary: 'Here and gone.', lessons: [{ slug: 'x', body: 'Gone.', journalIds: ['j-1'] }] },
        { slug: 'fleeting', title: 'Fleeting', summary: 'retired', lessons: [], retire: true },
      ],
      PROVENANCE,
    );
    expect(plan.writes.map((write) => write.slug)).toEqual([]);
    expect(plan.retired).toEqual([]);
    expect(describePlan(plan).chapters).toEqual([]);
  });

  it('refuses chapter metadata the format cannot hold — no forged summary through a tag', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    expect(() => bible.planUpdates([proposal({ tags: ['ops\nsummary: Forged summary.'] })], PROVENANCE)).toThrowError(/line break or a comma/);
    expect(() => bible.planUpdates([proposal({ tags: ['a, b'] })], PROVENANCE)).toThrowError(/line break or a comma/);
    expect(() => bible.planUpdates([proposal({ title: 'Ops\n## injected' })], PROVENANCE)).toThrowError(/single lines/);
    expect(bible.readChapter('ops-restarts')).toBeNull();
  });
});

describe('third review round of #254 — plan integrity, cap effects, canonical input, lock recovery (2026-10-07)', () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  const journal = (count: number, from = 1) => new Map(Array.from({ length: count }, (_, index) => [`j-${from + index}`, at(from + index)] as const));
  const ARCHIVE_BODY = 'Lessons trimmed at the chapter cap; provenance retained so the journal remains the ground truth.';
  const model = { slug: 'model-policy', title: 'Model policy', summary: 'Which model does what.', tags: ['models'], lessons: [{ slug: 'sol', body: 'Silas runs on Sol.', tags: ['silas'], journalIds: ['j-2'] }] };

  it('a plan with a forged fingerprint — to skip its writes or to redirect them — is refused before anything acts', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const plan = bible.planUpdates([proposal()], PROVENANCE);
    expect(() => checkPlan({ ...plan, after: plan.base })).toThrowError(/writes do not produce its planned book/);
    expect(() => bible.applyPlan({ ...plan, after: plan.base })).toThrowError(/writes do not produce its planned book/);
    expect(bible.readChapter('ops-restarts')).toBeNull();
    expect(() => checkPlan({ ...plan, base: 'f'.repeat(64) })).toThrowError(/does not fingerprint to its base/);
    expect(() => checkPlan({ ...plan, before: plan.before.filter((entry) => entry.path !== 'INDEX.md') })).toThrowError(/inconsistent/);
  });

  it('applying onto a changed book names every unexpected path — changed, added, deleted — and writes nothing', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    bible.applyUpdates([model, { ...model, slug: 'gone-soon', title: 'Gone soon' }], PROVENANCE);
    const plan = bible.planUpdates([proposal()], PROVENANCE);
    writeFileSync(join(bible.chaptersDir, 'model-policy.md'), `${readFileSync(join(bible.chaptersDir, 'model-policy.md'), 'utf-8')}\nEdited.\n`);
    writeFileSync(join(bible.chaptersDir, 'stray.md'), '# Stray\n');
    rmSync(join(bible.chaptersDir, 'gone-soon.md'));
    expect(() => bible.applyPlan(plan)).toThrowError(
      /chapters\/gone-soon\.md deleted, chapters\/model-policy\.md changed, chapters\/stray\.md added/,
    );
    expect(bible.readChapter('ops-restarts')).toBeNull();
  });

  it('the review counts every handle the cap released — an incoming lesson’s too — and names incoming lessons it left out', () => {
    const many = journal(40);
    const bible = tmpBible(1_200);
    bible.ensureSeeded();
    const plan = bible.planUpdates([{ slug: 'ops', title: 'Ops', summary: 'Ops.', tags: ['ops'], lessons: [{ slug: 'many', body: 'A lesson cited forty times.', journalIds: [...many.keys()] }] }], many);
    const written = parseChapter(plan.writes[0]!.text, 'ops').lessons[0]!;
    expect(written.provenance.length).toBeLessThan(40);
    expect(describePlan(plan).chapters[0]!.provenanceTrimmed).toBe(40 - written.provenance.length);

    // Two incoming lessons, room for one plus the archive of the other.
    const keep = { slug: 'keep', body: 'K'.repeat(150), recurred: 1, provenance: [{ id: 'j-2', ts: at(2) }], tags: [] as string[] };
    const archived = { slug: ARCHIVED_LESSON_SLUG, body: ARCHIVE_BODY, recurred: 1, provenance: [{ id: 'j-1', ts: at(1) }], tags: ['archived'] };
    const cap = Buffer.byteLength(serializeChapter({ slug: 'two', title: 'Two', summary: 'Two.', tags: [], lessons: [keep, archived] }), 'utf8');
    const tight = tmpBible(cap);
    tight.ensureSeeded();
    const dropped = tight.planUpdates([{
      slug: 'two',
      title: 'Two',
      summary: 'Two.',
      lessons: [
        { slug: 'left-out', body: 'L'.repeat(150), journalIds: ['j-1'] },
        { slug: 'keep', body: 'K'.repeat(150), journalIds: ['j-2'] },
      ],
    }], journal(2));
    const change = describePlan(dropped).chapters[0]!;
    // The archive record the drop creates is reviewed too (#253 round 5, C5).
    expect(change.added.map((lesson) => lesson.slug)).toEqual(['keep', ARCHIVED_LESSON_SLUG]);
    expect(change.removed).toEqual([{ slug: 'left-out', body: 'L'.repeat(150), recurred: 1, tags: [], reason: 'discarded' }]);
  });

  it('the review counts handles the cap released from the archive record', () => {
    const archive = { slug: ARCHIVED_LESSON_SLUG, body: ARCHIVE_BODY, recurred: 1, provenance: [...journal(60).entries()].map(([id, ts]) => ({ id, ts })), tags: ['archived'] };
    const existing = { slug: 'keep', body: 'Keep this lesson.', recurred: 1, provenance: [{ id: 'j-61', ts: at(61) }], tags: [] as string[] };
    const text = serializeChapter({ slug: 'ops', title: 'Ops', summary: 'Ops.', tags: ['ops'], lessons: [existing, archive] });
    const bible = tmpBible(Buffer.byteLength(text, 'utf8') + 40);
    bible.ensureSeeded();
    writeFileSync(join(bible.chaptersDir, 'ops.md'), text);
    const plan = bible.planUpdates([{ slug: 'ops', title: 'Ops', summary: 'Ops.', tags: ['ops'], lessons: [{ slug: 'fresh', body: 'A new lesson that needs room.', journalIds: ['j-62'] }] }], journal(1, 62));
    const after = parseChapter(plan.writes[0]!.text, 'ops').lessons.find((lesson) => lesson.slug === ARCHIVED_LESSON_SLUG)!;
    expect(after.provenance.length).toBeLessThan(60);
    expect(describePlan(plan).chapters[0]!.provenanceTrimmed).toBe(60 - after.provenance.length);
  });

  it('removals carry their tags — a retired chapter’s lessons, summary and tags alike', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    bible.applyUpdates([model], PROVENANCE);
    const plan = bible.planUpdates([{ ...model, lessons: [], retire: true }], PROVENANCE);
    const change = describePlan(plan).chapters[0]!;
    expect(change).toMatchObject({ retired: true, summary: { before: 'Which model does what.', after: '' }, tags: { before: ['models'], after: [] } });
    expect(change.removed).toEqual([{ slug: 'sol', body: 'Silas runs on Sol.', recurred: 1, tags: ['silas'], reason: 'retired' }]);
    expect(describePlan(plan).index).toEqual([{ slug: 'model-policy', before: { summary: 'Which model does what.', tags: ['models'] }, after: null }]);
  });

  it('plans what the format reads back: padded title and tags, duplicate tags and CRLF bodies are canonicalized', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const plan = bible.planUpdates([{
      slug: 'ops',
      title: ' Ops ',
      summary: 'Ops.',
      tags: [' ops ', 'ops'],
      lessons: [{ slug: 'crlf', body: 'Line one.\r\nLine two.', tags: [' shell ', 'shell'], journalIds: ['j-1'] }],
    }], PROVENANCE);
    bible.applyPlan(plan);
    const chapter = bible.readChapter('ops')!;
    expect([chapter.title, chapter.tags]).toEqual(['Ops', ['ops']]);
    expect([chapter.lessons[0]!.body, chapter.lessons[0]!.tags]).toEqual(['Line one.\nLine two.', ['shell']]);
  });
});

describe('fourth review round of #253 — the whole lessons change (bmad-code-review, 2026-10-07)', () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  const JOURNAL = new Map(Array.from({ length: 30 }, (_, index) => [`j-${index + 1}`, at(index + 1)] as const));
  const TOOL = resolve(import.meta.dirname, '..', 'tools', 'repair-bible-provenance.mjs');
  const backups = (bibleDir: string): string[] => readdirSync(bibleDir).filter((name) => name.startsWith('.repair-backup-'));
  const lessonOf = (slug: string, provenance: ProvenanceRef[], body: string) => ({ slug, body, recurred: 1, provenance, tags: [] as string[] });
  const chapterOf = (lessons: BibleChapter['lessons']): BibleChapter => ({ slug: 'fix', title: 'Fix', summary: '', tags: [], lessons });
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

  it('an uncited archive record that receives handles gains a provenance line, in place', () => {
    const text = [
      '# Ops', '', '## keep', '', 'recurred: 1', `provenance: j-2@${at(2)}`, '', 'Keep this lesson.', '',
      '## cited', '', 'recurred: 1', `provenance: j-1@${at(1)}`, '', 'An older cited lesson.', '',
      `## ${ARCHIVED_LESSON_SLUG}`, '', 'recurred: 1', 'tags: archived', '', 'Archived lessons.', '',
    ].join('\n');
    const bible = tmpBible(Buffer.byteLength(text, 'utf8') - 30);
    bible.ensureSeeded();
    writeFileSync(join(bible.chaptersDir, 'ops.md'), text);
    const report = bible.repairProvenance(JOURNAL, { write: true });
    expect(report.chapters[0]).toMatchObject({ lessonsDropped: 1 });
    const archive = bible.readChapter('ops')!.lessons.find((lesson) => lesson.slug === ARCHIVED_LESSON_SLUG)!;
    expect(archive.provenance).toEqual([{ id: 'j-1', ts: at(1) }]);
    expect(readFileSync(join(bible.chaptersDir, 'ops.md'), 'utf-8')).toContain('recurred: 1\ntags: archived\nprovenance: j-1@');
  });

  it('trimming keeps the longest prefix that fits in BYTES — multibyte text is not over-trimmed', () => {
    const body = `${'a'.repeat(170)}${'😀'.repeat(100)}`;
    const ref = [{ id: 'j-1', ts: at(1) }];
    const full = Buffer.byteLength(serializeChapter(chapterOf([lessonOf('emoji', ref, body)])), 'utf8');
    const cap = full - 150;
    const result = enforceChapterCap(chapterOf([lessonOf('emoji', ref, body)]), cap);
    const trimmed = result.chapter.lessons[0]!.body;
    expect(Buffer.byteLength(serializeChapter(result.chapter), 'utf8')).toBeLessThanOrEqual(cap);
    const marker = ' … [trimmed to fit the chapter cap]';
    const prefix = trimmed.slice(0, -marker.length);
    const next = Array.from(body.slice(prefix.length))[0]!;
    const oneMore = chapterOf([lessonOf('emoji', ref, `${prefix}${next}${marker}`)]);
    expect(Buffer.byteLength(serializeChapter(oneMore), 'utf8')).toBeGreaterThan(cap); // nothing more would have fit
    expect(loneSurrogate.test(trimmed)).toBe(false);
  });

  it('a trim keeps every retained line byte for byte, CRLF included', () => {
    const body = ['First retained line.', 'Second retained line.', 'Restart with care. '.repeat(40).trim()].join('\r\n');
    const text = ['# Ops', '', '## a', '', 'recurred: 1', `provenance: j-1@${at(1)}`, '', body, ''].join('\r\n');
    const bible = tmpBible(Buffer.byteLength(text, 'utf8') - 200);
    bible.ensureSeeded();
    writeFileSync(join(bible.chaptersDir, 'ops.md'), text);
    expect(bible.repairProvenance(JOURNAL, { write: true }).chapters[0]!.bodiesTrimmed).toBeGreaterThan(0);
    const written = readFileSync(join(bible.chaptersDir, 'ops.md'), 'utf-8');
    expect(written.startsWith(['# Ops', '', '## a', '', 'recurred: 1', `provenance: j-1@${at(1)}`, '', 'First retained line.', 'Second retained line.', ''].join('\r\n'))).toBe(true);
    expect(written.split('\n').slice(0, -1).every((line) => line.endsWith('\r'))).toBe(true);
  });

  it('instants keep their full precision and real calendar: sub-millisecond order, equal spellings, impossible dates', () => {
    const refs = [
      { id: 'j-1', ts: '2026-10-01T00:00:00.0004Z' },
      { id: 'j-2', ts: '2026-10-01T00:00:00.0003Z' },
      { id: 'j-3', ts: '2026-10-01T00:00:00.0002Z' },
      { id: 'j-4', ts: '2026-10-01T00:00:00.0001Z' },
    ];
    expect([...refs].sort(compareProvenance).map((ref) => ref.id)).toEqual(['j-4', 'j-3', 'j-2', 'j-1']);
    expect(compareProvenance({ id: 'j-1', ts: '2026-10-01T02:00:00.5+02:00' }, { id: 'j-2', ts: '2026-10-01T00:00:00.500Z' })).toBeLessThan(0); // same instant → sequence
    expect(parseIsoInstant('2026-02-30T00:00:00.000Z')).toBeNull();
    expect(parseIsoInstant('2024-02-29T23:59:59.999999Z')).not.toBeNull();
    const journal = new Map([['j-1', '2026-10-01T00:00:00.0002Z']]);
    expect(() => repairChapterProvenance('# A\n\n## a\n\nrecurred: 1\nprovenance: j-1@2026-10-01T00:00:00.0001Z\n\nBody.\n', 'a', journal)).toThrowError(
      /but the journal records j-1/,
    );
  });

  it('the strict reader refuses two lessons on one anchor — no review shows the wrong "before" text', () => {
    expect(() => parseChapter('# A\n\n## a\n\nrecurred: 1\n\nFirst.\n\n## a\n\nrecurred: 1\n\nSecond.\n', 'a')).toThrowError(/more than one lesson anchored "## a"/);
    const bible = tmpBible();
    bible.ensureSeeded();
    writeFileSync(join(bible.chaptersDir, 'ops-restarts.md'), '# Ops\n\n## shell-hang\n\nrecurred: 1\n\nFirst.\n\n## shell-hang\n\nrecurred: 1\n\nSecond.\n');
    expect(() => bible.planUpdates([proposal()], PROVENANCE)).toThrowError(/more than one lesson anchored/);
  });

  it('truncation never leaves half a character — summaries and INDEX lines survive UTF-8 unchanged', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const plan = bible.planUpdates([proposal({ summary: `${'x'.repeat(159)}😀 and more` })], PROVENANCE);
    bible.applyPlan(plan);
    const summary = bible.readChapter('ops-restarts')!.summary;
    expect(loneSurrogate.test(summary)).toBe(false);
    expect(summary.startsWith('x'.repeat(159))).toBe(true);
    const chapters = Array.from({ length: 4 }, (_, index) => ({ slug: `c-${index}`, title: 'C', summary: '😀'.repeat(60), tags: [], lessons: [] }));
    for (let cap = 400; cap < 520; cap += 7) {
      let rendered: string;
      try {
        rendered = renderIndex(chapters, cap);
      } catch {
        continue; // too small for any index: refused, not corrupted
      }
      expect(loneSurrogate.test(rendered), `index cap ${cap}`).toBe(false);
    }
  });

  it('bare CR line endings are canonicalized before validation — a CR-hidden heading is still refused', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    bible.applyPlan(bible.planUpdates([proposal({ lessons: [{ slug: 'cr', body: 'First.\rSecond.', journalIds: ['j-1'] }] })], PROVENANCE));
    expect(bible.readChapter('ops-restarts')!.lessons[0]!.body).toBe('First.\nSecond.');
    expect(() => bible.planUpdates([proposal({ lessons: [{ slug: 'hidden', body: 'Text.\r## Smuggled heading', journalIds: ['j-1'] }] })], PROVENANCE)).toThrowError(
      /heading/,
    );
  });

  it('only a pristine book is seeded — a book with chapters or state but no INDEX.md fails loud and gains nothing', () => {
    const bible = tmpBible();
    mkdirSync(bible.chaptersDir, { recursive: true });
    writeFileSync(join(bible.chaptersDir, 'ops.md'), '# Ops\n\n## a\n\nrecurred: 1\n\nBody.\n');
    expect(() => bible.ensureSeeded()).toThrowError(/has chapters but no INDEX\.md/);
    expect(existsSync(join(bible.dir, 'INDEX.md'))).toBe(false);
    const stateOnly = tmpBible();
    mkdirSync(stateOnly.dir, { recursive: true });
    writeFileSync(join(stateOnly.dir, '.dream-state.json'), '{}');
    expect(() => stateOnly.ensureSeeded()).toThrowError(/\.dream-state\.json but no INDEX\.md/);
    const fresh = tmpBible();
    fresh.ensureSeeded();
    expect(existsSync(join(fresh.dir, 'INDEX.md'))).toBe(true);
  });

  it('a plan whose INDEX.md carries anything beyond the index of its result is refused, hashes notwithstanding', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const plan = bible.planUpdates([proposal()], PROVENANCE);
    const indexText = `${plan.indexText}Smuggled text the review never shows.\n`;
    const result = new Map(plan.before.filter((entry) => entry.text !== null).map((entry) => [entry.path, entry.text as string]));
    for (const write of plan.writes) result.set(`chapters/${write.slug}.md`, write.text);
    result.set('INDEX.md', indexText);
    const hash = createHash('sha256').update(indexText, 'utf8').digest('hex');
    const forged = {
      ...plan,
      indexText,
      after: bookFingerprint(result),
      files: plan.files.map((file) => (file.path === 'INDEX.md' ? { ...file, after: hash } : file)),
    };
    expect(() => checkPlan(forged)).toThrowError(/is not the index of the book it produces/);
  });

  it('the tool refuses an impossible calendar date on any journal record — dry run and --write alike', () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-repair-r4-'));
    cleanupDirs.push(home);
    const journal = new JournalStore(join(home, 'journal'));
    const first = journal.append({ kind: 'finding', source: 'gru', body: 'first' });
    const file = join(home, 'journal', readdirSync(join(home, 'journal')).find((name) => name.endsWith('.jsonl'))!);
    const template = JSON.parse(readFileSync(file, 'utf-8').trim().split('\n')[0]!) as Record<string, unknown>;
    appendFileSync(file, `${JSON.stringify({ ...template, seq: 2, id: 'j-2', ts: '2026-02-30T00:00:00.000Z' })}\n`);
    mkdirSync(join(home, 'bible', 'chapters'), { recursive: true });
    const chapter = `# Ops\n\n## a\n\nrecurred: 1\nprovenance: ${first.id}\n\nBody.\n`;
    writeFileSync(join(home, 'bible', 'chapters', 'ops.md'), chapter);
    for (const args of [[], ['--write']]) {
      const ran = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf-8', env: { ...process.env, GRU_COMMAND_HOME: home } });
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain('journal entry j-2 has an invalid timestamp "2026-02-30T00:00:00.000Z"');
    }
    expect(readFileSync(join(home, 'bible', 'chapters', 'ops.md'), 'utf-8')).toBe(chapter);
    expect(backups(join(home, 'bible'))).toEqual([]);
  });

  it('the tool refuses an instance without a book instead of "repairing" a new empty one', () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-repair-typo-'));
    cleanupDirs.push(home);
    const ran = spawnSync(process.execPath, [TOOL, '--write'], { encoding: 'utf-8', env: { ...process.env, GRU_COMMAND_HOME: home } });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('does not exist');
    expect(existsSync(join(home, 'bible'))).toBe(false);
  });
});

describe('fifth review round of #253 — follow-up (bmad-code-review, 2026-10-08)', () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  const lessonOf = (slug: string, provenance: ProvenanceRef[], body: string) => ({ slug, body, recurred: 1, provenance, tags: [] as string[] });
  const chapterOf = (lessons: BibleChapter['lessons']): BibleChapter => ({ slug: 'fix', title: 'Fix', summary: '', tags: [], lessons });
  const JOURNAL_R5 = new Map(Array.from({ length: 30 }, (_, index) => [`j-${index + 1}`, at(index + 1)] as const));
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

  it('years 0000–0099 are themselves — never 1900–1999 — and year 0 has its leap day (R5-A2)', () => {
    expect(compareIsoInstants('0026-10-01T00:00:00Z', '1926-10-01T00:00:00Z')).toBeLessThan(0);
    expect(compareIsoInstants('0099-12-31T23:59:59Z', '0100-01-01T00:00:00Z')).toBeLessThan(0);
    expect(compareIsoInstants('0026-10-01T01:00:00+01:00', '0026-10-01T00:00:00Z')).toBe(0);
    expect(parseIsoInstant('0000-02-29T00:00:00Z')).not.toBeNull();
    expect(parseIsoInstant('0400-02-29T00:00:00Z')).not.toBeNull();
    expect(parseIsoInstant('0100-02-29T00:00:00Z')).toBeNull();
    expect(parseIsoInstant('1900-02-29T00:00:00Z')).toBeNull();
    const journal = new Map([['j-1', '1926-10-01T00:00:00.000Z']]);
    expect(() => repairChapterProvenance('# A\n\n## a\n\nrecurred: 1\nprovenance: j-1@0026-10-01T00:00:00.000Z\n\nBody.\n', 'a', journal))
      .toThrowError(/cites j-1@0026-10-01T00:00:00.000Z, but the journal records j-1 at 1926-10-01T00:00:00.000Z/);
  });

  it('a timestamp split off by a comma may carry an offset: an equal instant repairs, a different one refuses (R5-A3)', () => {
    const journal = new Map([['j-1', '2026-10-01T00:00:00.000Z']]);
    const repaired = repairChapterProvenance('# A\n\n## a\n\nrecurred: 1\nprovenance: j-1,2026-10-01T02:00:00+02:00\n\nBody.\n', 'a', journal).text;
    expect(repaired).toContain('provenance: j-1@2026-10-01T00:00:00.000Z\n');
    expect(() => repairChapterProvenance('# A\n\n## a\n\nrecurred: 1\nprovenance: j-1,2026-10-01T02:00:00+01:00\n\nBody.\n', 'a', journal))
      .toThrowError(/cites j-1,2026-10-01T02:00:00\+01:00, but the journal records j-1 at 2026-10-01T00:00:00.000Z/);
  });

  it('an impossible instant is refused by the reader, the planner and the cap — never ordered by spelling (R5-A12)', () => {
    expect(() => parseChapter('# A\n\n## a\n\nrecurred: 1\nprovenance: j-1@2026-02-30T00:00:00.000Z\n\nBody.\n', 'a'))
      .toThrowError(/provenance "j-1@2026-02-30T00:00:00.000Z" carries an impossible or malformed instant/);
    const bible = tmpBible();
    bible.ensureSeeded();
    const impossible = new Map([...PROVENANCE, ['j-1', '2026-02-30T00:00:00.000Z']]);
    expect(() => bible.planUpdates([proposal()], impossible)).toThrowError(/records j-1 at an impossible or malformed instant "2026-02-30T00:00:00.000Z"/);
    expect(() => compareProvenance({ id: 'j-1', ts: '2026-02-30T00:00:00.000Z' }, { id: 'j-2', ts: at(2) }))
      .toThrowError(/provenance j-1@2026-02-30T00:00:00.000Z is not a valid ISO instant/);
    const chapter = chapterOf([
      lessonOf('a', [{ id: 'j-1', ts: '2026-02-30T00:00:00.000Z' }], 'a'.repeat(300)),
      lessonOf('b', [{ id: 'j-2', ts: at(2) }], 'b'.repeat(300)),
    ]);
    expect(() => enforceChapterCap(chapter, 400)).toThrowError(/is not a valid ISO instant/);
  });

  it('a chapter with bare CR line endings is read line by line: repaired in place, and an unknown id refuses before any write (R5-A13)', () => {
    const journal = new Map([['j-1', at(1)], ['j-2', at(2)]]);
    const damaged = ['# Ops', '', '## a', '', 'recurred: 1', 'provenance: j-2; earlier: j-1', '', 'Body.', ''].join('\r');
    const repaired = repairChapterProvenance(damaged, 'ops', journal).text;
    expect(repaired).toBe(['# Ops', '', '## a', '', 'recurred: 1', `provenance: j-1@${at(1)}, j-2@${at(2)}`, '', 'Body.', ''].join('\r'));
    expect(parseChapter(repaired, 'ops').lessons.map((lesson) => lesson.slug)).toEqual(['a']);
    const bible = tmpBible();
    bible.ensureSeeded();
    const unknown = ['# Ops', '', '## a', '', 'recurred: 1', 'provenance: j-999', '', 'Body.', ''].join('\r');
    writeFileSync(join(bible.chaptersDir, 'ops.md'), unknown);
    for (const write of [false, true]) {
      expect(() => bible.repairProvenance(journal, { write })).toThrowError(/cites journal id j-999, which is not in the journal/);
    }
    expect(readFileSync(join(bible.chaptersDir, 'ops.md'), 'utf-8')).toBe(unknown);
    expect(readdirSync(bible.dir).filter((name) => name.startsWith('.repair-backup-'))).toEqual([]);
  });

  it('a CRLF chapter keeps the longest prefix that fits as WRITTEN — not a CR byte per line less (R5-A1)', () => {
    const body = Array.from({ length: 24 }, (_, line) => `line ${String(line).padStart(2, '0')} keeps its words`).join('\r\n');
    const text = ['# Ops', '', '## a', '', 'recurred: 1', `provenance: j-1@${at(1)}`, '', body, ''].join('\r\n');
    const cap = 512;
    const bible = tmpBible(cap);
    bible.ensureSeeded();
    writeFileSync(join(bible.chaptersDir, 'ops.md'), text);
    expect(bible.repairProvenance(JOURNAL_R5, { write: true }).chapters[0]!.bodiesTrimmed).toBe(1);
    const written = readFileSync(join(bible.chaptersDir, 'ops.md'), 'utf-8');
    expect(Buffer.byteLength(written, 'utf8')).toBeLessThanOrEqual(cap);
    // Maximal: one more character (or its CRLF) would not have fit.
    expect(Buffer.byteLength(written, 'utf8')).toBeGreaterThan(cap - 3);
    expect(written.split('\n').slice(0, -1).every((line) => line.endsWith('\r'))).toBe(true);
  });

  it('a body indented with Unicode spaces trims in place, its indentation byte for byte (R5-A4)', () => {
    const indent = '\u00a0\u00a0';
    const body = `${indent}${'Restart with care and close the shell first. '.repeat(12).trim()}`;
    const text = ['# Ops', '', '## a', '', 'recurred: 1', `provenance: j-1@${at(1)}`, '', body, ''].join('\n');
    expect(parseChapter(text, 'ops').lessons[0]!.body.startsWith('Restart')).toBe(true);
    const cap = 512;
    const bible = tmpBible(cap);
    bible.ensureSeeded();
    writeFileSync(join(bible.chaptersDir, 'ops.md'), text);
    expect(bible.repairProvenance(JOURNAL_R5, { write: true }).chapters[0]!.bodiesTrimmed).toBe(1);
    const written = readFileSync(join(bible.chaptersDir, 'ops.md'), 'utf-8');
    expect(Buffer.byteLength(written, 'utf8')).toBeLessThanOrEqual(cap);
    expect(written).toContain(`\n\n${indent}Restart with care`);
    expect(written).toContain(' … [trimmed to fit the chapter cap]\n');
  });

  const TOOL_R5 = resolve(import.meta.dirname, '..', 'tools', 'repair-bible-provenance.mjs');
  const backupsOf = (bibleDir: string): string[] => readdirSync(bibleDir).filter((name) => name.startsWith('.repair-backup-'));
  /** An instance whose journal holds `first` plus raw `extra` records, and
   * whose book holds one chapter citing `first`. */
  function toolInstance(extra: (template: Record<string, unknown>) => Record<string, unknown>[]) {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-repair-r5-'));
    cleanupDirs.push(home);
    const journal = new JournalStore(join(home, 'journal'));
    const first = journal.append({ kind: 'finding', source: 'gru', body: 'first' });
    const file = join(home, 'journal', readdirSync(join(home, 'journal')).find((name) => name.endsWith('.jsonl'))!);
    const template = JSON.parse(readFileSync(file, 'utf-8').trim().split('\n')[0]!) as Record<string, unknown>;
    for (const record of extra(template)) appendFileSync(file, `${JSON.stringify(record)}\n`);
    mkdirSync(join(home, 'bible', 'chapters'), { recursive: true });
    const chapter = `# Ops\n\n## a\n\nrecurred: 1\nprovenance: ${first.id}\n\nBody.\n`;
    writeFileSync(join(home, 'bible', 'chapters', 'ops.md'), chapter);
    const run = (...args: string[]) => spawnSync(process.execPath, [TOOL_R5, ...args], { encoding: 'utf-8', env: { ...process.env, GRU_COMMAND_HOME: home } });
    return { home, chapter, run };
  }

  it('the tool tolerates only identical duplicate journal records — conflicting contents refuse before any write (R5-A6)', () => {
    const conflicting = toolInstance((template) => [{ ...template, body: 'a different body', source: 'minion' }]);
    for (const args of [[], ['--write']]) {
      const ran = conflicting.run(...args);
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain('journal id j-1 appears twice with different contents');
    }
    expect(readFileSync(join(conflicting.home, 'bible', 'chapters', 'ops.md'), 'utf-8')).toBe(conflicting.chapter);
    expect(backupsOf(join(conflicting.home, 'bible'))).toEqual([]);
    // The same record twice, keys in another order, says the same thing.
    const identical = toolInstance((template) => [Object.fromEntries(Object.entries(template).reverse())]);
    const ran = identical.run('--write');
    expect(ran.stderr).not.toContain('repair-bible-provenance:');
    expect(ran.status).toBe(0);
  });

  it('the tool reports an unreadable or non-directory book as itself — never as a missing instance (R5-A8)', () => {
    const notDir = toolInstance(() => []);
    rmSync(join(notDir.home, 'bible', 'chapters'), { recursive: true });
    writeFileSync(join(notDir.home, 'bible', 'chapters'), 'not a directory');
    const ran = notDir.run();
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('exists but is not a directory');
    expect(ran.stderr).not.toContain('right instance');
    if (process.getuid?.() === 0) return; // root reads through any mode
    const locked = toolInstance(() => []);
    chmodSync(join(locked.home, 'bible'), 0o000);
    try {
      const refused = locked.run();
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('cannot be read (EACCES');
      expect(refused.stderr).not.toContain('right instance');
    } finally {
      chmodSync(join(locked.home, 'bible'), 0o755);
    }
  });

  it('a written result that does not verify is reported, still under the lock, with what was replaced and the backup (R5-A7)', () => {
    const bible = tmpBible(512);
    bible.ensureSeeded();
    const damaged = `# Ops\n\n## a\n\nrecurred: 1\nprovenance: j-1\n\nBody.\n`;
    writeFileSync(join(bible.chaptersDir, 'ops.md'), damaged);
    const store = bible as unknown as { writeAtomic(file: string, data: string | Buffer): void };
    const real = store.writeAtomic.bind(bible);
    // The bytes that land are not the bytes planned (a faulty disk, say).
    store.writeAtomic = (file, data) => real(file, file === join(bible.chaptersDir, 'ops.md') ? `${String(data)}${'x'.repeat(600)}` : data);
    let caught: unknown;
    try {
      bible.repairProvenance(JOURNAL_R5, { write: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RepairWriteError);
    expect((caught as Error).message).toMatch(/repair replaced 1 chapter\(s\) \(ops\), but the result does not verify: chapter ops\.md does not hold the planned bytes/);
    expect(readFileSync(join((caught as RepairWriteError).backupDir, 'chapters', 'ops.md'), 'utf-8')).toBe(damaged);
  });

  it('a failed backup aborts before any chapter is replaced, and releases the lock (R5-A10)', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const chapters = ['a', 'b'].map((slug) => [slug, `# ${slug.toUpperCase()}\n\n## ${slug}\n\nrecurred: 1\nprovenance: j-1\n\nBody.\n`] as const);
    for (const [slug, text] of chapters) writeFileSync(join(bible.chaptersDir, `${slug}.md`), text);
    const store = bible as unknown as { writeAtomic(file: string, data: string | Buffer): void };
    const real = store.writeAtomic.bind(bible);
    let backups = 0;
    store.writeAtomic = (file, data) => {
      if (file.includes('.repair-backup-') && ++backups === 2) throw new Error('ENOSPC: no space left on device');
      real(file, data);
    };
    expect(() => bible.repairProvenance(JOURNAL_R5, { write: true })).toThrowError(/could not back up the chapters to .*ENOSPC.*the book was not changed/);
    for (const [slug, text] of chapters) expect(readFileSync(join(bible.chaptersDir, `${slug}.md`), 'utf-8')).toBe(text);
    store.writeAtomic = real;
    expect(bible.repairProvenance(JOURNAL_R5, { write: true }).chapters.every((chapter) => chapter.changed)).toBe(true);
  });

  it('managed reads are strict UTF-8: an invalid baseline refuses, and valid-to-invalid bytes after planning never pass as unchanged (C2)', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const file = join(bible.chaptersDir, 'ops-restarts.md');
    const text = `# Ops restarts\n\n## old\n\nrecurred: 1\nprovenance: j-2@${PROVENANCE.get('j-2')}\n\nA replacement character \uFFFD stays as written.\n`;
    writeFileSync(file, text);
    const plan = bible.planUpdates([proposal()], PROVENANCE);
    const corrupted = Buffer.from(readFileSync(file).toString('latin1').replace('\u00ef\u00bf\u00bd', '\u00ff'), 'latin1');
    expect(corrupted.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    writeFileSync(file, corrupted);
    expect(() => bible.applyPlan(plan)).toThrowError(/ops-restarts\.md is not valid UTF-8/);
    expect(readFileSync(file).equals(corrupted)).toBe(true);
    expect(() => bible.planUpdates([proposal()], PROVENANCE)).toThrowError(/ops-restarts\.md is not valid UTF-8/);
    expect(() => bible.readChapter('ops-restarts')).toThrowError(/is not valid UTF-8/);
  });

  it('a plan whose report claims trims or drops the cap did not make is refused before anything is written (C6)', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const plan = bible.planUpdates([proposal()], PROVENANCE);
    expect(plan.report).toMatchObject({ lessonsTrimmed: 0, lessonsDropped: 0 });
    for (const forged of [{ lessonsTrimmed: 99 }, { lessonsDropped: 88 }]) {
      const tampered = { ...plan, report: { ...plan.report, ...forged } };
      expect(() => checkPlan(tampered)).toThrowError(/its report claims .* the cap trims 0 and drops 0/);
      expect(() => bible.applyPlan(tampered)).toThrowError(/its report claims/);
    }
    expect(bible.readChapter('ops-restarts')).toBeNull();
  });

  it('the archive record is reviewed like any record — its arrival, a change to its text, and its removal (C5)', () => {
    expect(WEB_ARCHIVED_LESSON_SLUG).toBe(ARCHIVED_LESSON_SLUG);
    const archiveBody = 'Lessons trimmed at the chapter cap; provenance retained so the journal remains the ground truth.';
    // The cap drops a lesson: the archive record it creates is listed.
    const keep = lessonOf('keep', [{ id: 'j-2', ts: at(2) }], 'K'.repeat(150));
    const archived = { slug: ARCHIVED_LESSON_SLUG, body: archiveBody, recurred: 1, provenance: [{ id: 'j-1', ts: at(1) }], tags: ['archived'] };
    const cap = Buffer.byteLength(serializeChapter({ slug: 'two', title: 'Two', summary: 'Two.', tags: [], lessons: [keep, archived] }), 'utf8');
    const tight = tmpBible(cap);
    tight.ensureSeeded();
    const plan = tight.planUpdates([{
      slug: 'two', title: 'Two', summary: 'Two.',
      lessons: [{ slug: 'left-out', body: 'L'.repeat(150), journalIds: ['j-1'] }, { slug: 'keep', body: 'K'.repeat(150), journalIds: ['j-2'] }],
    }], JOURNAL_R5);
    const change = describePlan(plan).chapters[0]!;
    expect(change.added.map((lesson) => lesson.slug)).toEqual(['keep', ARCHIVED_LESSON_SLUG]);
    expect(change.added[1]).toMatchObject({ body: archiveBody, tags: ['archived'], previousBody: null });
    // A plan whose archive text differs from the book's shows the change.
    tight.applyPlan(plan);
    const next = tight.planUpdates([{ slug: 'two', title: 'Two', summary: 'Two.', lessons: [{ slug: 'keep', body: 'K'.repeat(150), journalIds: ['j-2'] }] }], JOURNAL_R5);
    const write = next.writes[0]!;
    const uncapped = { ...write.uncapped, lessons: write.uncapped.lessons.map((lesson) =>
      lesson.slug === ARCHIVED_LESSON_SLUG ? { ...lesson, body: 'Rewritten archive text.' } : lesson) };
    const forged = { ...next, writes: [{ ...write, uncapped, text: enforceChapterCap(uncapped, next.chapterCapBytes).text }] };
    expect(describePlan(forged).chapters[0]!.changed).toContainEqual(expect.objectContaining({
      slug: ARCHIVED_LESSON_SLUG, body: 'Rewritten archive text.', previousBody: archiveBody,
    }));
    // Retiring the chapter removes the archive record with its text and tags.
    const retire = tight.planUpdates([{ slug: 'two', title: 'Two', summary: 'Two.', retire: true, lessons: [] }], JOURNAL_R5);
    expect(describePlan(retire).chapters[0]!.removed).toContainEqual({
      slug: ARCHIVED_LESSON_SLUG, body: archiveBody, recurred: 1, tags: ['archived'], reason: 'retired',
    });
  });

  it('a summary that ends like a tag list never becomes INDEX tags — refused with what to do (C7)', () => {
    const chapter = (summary: string, tags: string[]): BibleChapter => ({ slug: 'ops', title: 'Ops', summary, tags, lessons: [] });
    expect(() => renderIndex([chapter('Restart discipline (tags: emergency)', [])]))
      .toThrowError(/chapter ops's INDEX line would read back as different metadata — a summary must not end like a tag list/);
    // With real tags the line still reads back exactly — until the cap drops them.
    const tagged = [chapter('Restart discipline (tags: emergency)', ['ops'])];
    expect(parseIndex(renderIndex(tagged))).toEqual([{ slug: 'ops', summary: 'Restart discipline (tags: emergency)', tags: ['ops'] }]);
    const full = Buffer.byteLength(renderIndex(tagged), 'utf8');
    expect(() => renderIndex(tagged, full - 1)).toThrowError(/would read back as different metadata/);
    const bible = tmpBible();
    bible.ensureSeeded();
    expect(() => bible.planUpdates([proposal({ summary: 'Restart discipline (tags: emergency)', tags: [] })], PROVENANCE))
      .toThrowError(/a summary must not end like a tag list/);
  });

  it('INDEX compaction budgets real UTF-8 bytes: feasible emoji and CJK caps succeed, impossible ones refuse (C12)', () => {
    for (const glyph of ['😀', '漢']) {
      const chapters = Array.from({ length: 4 }, (_, index) => ({ slug: `c-${index}`, title: 'C', summary: glyph.repeat(60), tags: [], lessons: [] }));
      const skeleton = Buffer.byteLength(renderIndex(chapters.map((chapter) => ({ ...chapter, summary: 'x'.repeat(24) })), 100_000), 'utf8') - 4 * 24;
      for (let cap = skeleton + 4 * 24; cap < 1_200; cap += 7) {
        const rendered = renderIndex(chapters, cap);
        expect(Buffer.byteLength(rendered, 'utf8'), `${glyph} cap ${cap}`).toBeLessThanOrEqual(cap);
        expect(loneSurrogate.test(rendered), `${glyph} cap ${cap}`).toBe(false);
        expect(parseIndex(rendered).map((entry) => entry.slug)).toEqual(['c-0', 'c-1', 'c-2', 'c-3']);
      }
      expect(() => renderIndex(chapters, skeleton + 4 * 24 - 4)).toThrowError(/cannot hold 4 chapter\(s\)/);
    }
    // The case the review measured: four long emoji summaries under 500 bytes.
    const emoji = Array.from({ length: 4 }, (_, index) => ({ slug: `c-${index}`, title: 'C', summary: '😀'.repeat(60), tags: [], lessons: [] }));
    expect(Buffer.byteLength(renderIndex(emoji, 500), 'utf8')).toBeLessThanOrEqual(500);
  });

  it('a plan approved under the first release verifies and applies byte for byte after the upgrade (R6-01)', () => {
    // Made by the merged first release (4cc8a83): its trimming and INDEX
    // compaction differ from today's, and the owner approved THESE bytes.
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'lessons-plan-contract-1.json'), 'utf8')) as {
      chapterCapBytes: number; indexCapBytes: number; plan: BiblePlan;
    };
    expect(fixture.plan.contract).toBeUndefined();
    const bible = tmpBible(fixture.chapterCapBytes, fixture.indexCapBytes);
    mkdirSync(bible.chaptersDir, { recursive: true });
    for (const entry of fixture.plan.before) if (entry.text !== null) writeFileSync(join(bible.dir, entry.path), entry.text);
    expect(() => checkPlan(fixture.plan)).not.toThrow();
    expect(describePlan(fixture.plan).chapters.map((chapter) => chapter.slug)).toEqual(['alpha']);
    // Under today's contract the same bytes would not verify...
    expect(() => checkPlan({ ...fixture.plan, contract: 2 })).toThrowError(/is not what the cap makes|is not the index of the book it produces/);
    expect(() => checkPlan({ ...fixture.plan, contract: 7 as never })).toThrowError(/planning contract 7 is unknown/);
    // ...yet the approved plan applies exactly as approved.
    bible.applyPlan(fixture.plan);
    for (const write of fixture.plan.writes) expect(readFileSync(join(bible.chaptersDir, `${write.slug}.md`), 'utf8')).toBe(write.text);
    expect(readFileSync(join(bible.dir, 'INDEX.md'), 'utf8')).toBe(fixture.plan.indexText);
    // Plans made today carry their contract.
    expect(bible.planUpdates([proposal({ slug: 'ops-new' })], PROVENANCE).contract).toBe(2);
  });

  /** A first-release fixture, its reviewed book laid down in a fresh store. */
  function firstReleasePlan(name: string): { plan: BiblePlan; bible: BibleStore } {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as {
      chapterCapBytes: number; indexCapBytes: number; plan: BiblePlan;
    };
    expect(fixture.plan.contract).toBeUndefined();
    const bible = tmpBible(fixture.chapterCapBytes, fixture.indexCapBytes);
    mkdirSync(bible.chaptersDir, { recursive: true });
    for (const entry of fixture.plan.before) if (entry.text !== null) writeFileSync(join(bible.dir, entry.path), entry.text);
    return { plan: fixture.plan, bible };
  }

  it('a first-release plan that repeats a handle — in its reviewed book and in its writes — verifies, reviews and applies byte for byte; today\'s reader still refuses repeats (R7-01)', () => {
    // Made by the first release (4cc8a83): a lesson citing one journal id
    // twice was written as two copies, and the owner approved those bytes.
    const { plan, bible } = firstReleasePlan('lessons-plan-contract-1-duplicates.json');
    expect(plan.before.find((entry) => entry.path === 'chapters/ops.md')?.text).toContain('j-1@2026-10-01T00:01:00.000Z, j-1@');
    expect(plan.writes[0]!.text).toContain('j-3@2026-10-01T00:03:00.000Z, j-3@');
    expect(() => checkPlan(plan)).not.toThrow();
    const review = describePlan(plan);
    expect(review.chapters.map((chapter) => [chapter.slug, chapter.added.map((lesson) => lesson.slug)])).toEqual([['ops', ['shell']]]);
    expect(() => checkPlan({ ...plan, contract: 2 })).toThrowError(/provenance repeats j-1/);
    bible.applyPlan(plan);
    for (const write of plan.writes) expect(readFileSync(join(bible.chaptersDir, `${write.slug}.md`), 'utf8')).toBe(write.text);
    expect(readFileSync(join(bible.dir, 'INDEX.md'), 'utf8')).toBe(plan.indexText);
    // The book now holds the approved bytes; reading it is still today's
    // contract, which names the repair tool.
    expect(() => bible.readChapter('ops')).toThrowError(/provenance cites j-1 more than once — rebuild it from the journal with the repair tool/);
    expect(() => parseChapter(plan.writes[0]!.text, 'ops')).toThrowError(/more than once/);
    expect(parseChapter(plan.writes[0]!.text, 'ops', 1).lessons.map((lesson) => lesson.provenance.map((ref) => ref.id)))
      .toEqual([['j-1', 'j-1', 'j-2'], ['j-3', 'j-3']]);
  });

  it('a first-release plan over handles dated before year 100 replays that release\'s chronology — handle release, drop choice and archive merge (R7-02)', () => {
    // The first release ordered instants with Date.UTC, which reads years
    // 0–99 as 1900–1999: "0026-12" sorted after "1926-07". The owner
    // approved what THAT order kept.
    for (const [name, kept] of [
      ['lessons-plan-contract-1-early-year.json', [['restart', ['j-2', 'j-7', 'j-4', 'j-6']]]],
      ['lessons-plan-contract-1-early-drops.json', [['alpha', ['j-1', 'j-2']], ['archived-provenance', ['j-6']]]],
      ['lessons-plan-contract-1-early-archive.json', [['bravo', ['j-3', 'j-4']], ['archived-provenance', ['j-2']]]],
    ] as const) {
      const { plan, bible } = firstReleasePlan(name);
      expect(parseChapter(plan.writes[0]!.text, 'ops', 1).lessons.map((lesson) => [lesson.slug, lesson.provenance.map((ref) => ref.id)]), name)
        .toEqual(kept);
      expect(() => checkPlan(plan), name).not.toThrow();
      expect(describePlan(plan).chapters.map((chapter) => chapter.slug), name).toEqual(['ops']);
      // Today's chronology keeps other handles and lessons from the same merge.
      expect(() => checkPlan({ ...plan, contract: 2 }), name).toThrowError(/is not what the cap makes of its merged chapter/);
      bible.applyPlan(plan);
      expect(readFileSync(join(bible.chaptersDir, 'ops.md'), 'utf8'), name).toBe(plan.writes[0]!.text);
      expect(readFileSync(join(bible.dir, 'INDEX.md'), 'utf8'), name).toBe(plan.indexText);
    }
  });

  it('every provenance line of a lesson counts — a handle repeated across lines is refused (R6-02)', () => {
    expect(() => parseChapter(`# A\n\n## a\n\nrecurred: 1\nprovenance: j-3@${at(3)}\nprovenance: j-3@${at(3)}\nprovenance: j-3@${at(3)}\n\nBody.\n`, 'a'))
      .toThrowError(/provenance cites j-3 more than once/);
    // The repair still folds such lines into one, deliberately.
    const repaired = repairChapterProvenance(`# A\n\n## a\n\nrecurred: 1\nprovenance: j-3\nprovenance: j-3\n\nBody.\n`, 'a', JOURNAL_R5).text;
    expect(parseChapter(repaired, 'a').lessons[0]!.provenance.map((ref) => ref.id)).toEqual(['j-3']);
  });

  it('an impossible instant is refused before the cap measures anything — fitting, trimming, or stored pre-cap (R6-03)', () => {
    const bad = { id: 'j-1', ts: '2026-02-30T00:00:00.000Z' };
    expect(() => enforceChapterCap(chapterOf([lessonOf('fits', [bad], 'Short body.')]), 4_096)).toThrowError(/j-1@2026-02-30T00:00:00.000Z is not a valid ISO instant/);
    expect(() => enforceChapterCap(chapterOf([lessonOf('long', [bad], 'x'.repeat(600))]), 300)).toThrowError(/is not a valid ISO instant/);
    const bible = tmpBible();
    bible.ensureSeeded();
    const plan = bible.planUpdates([proposal()], PROVENANCE);
    const write = plan.writes[0]!;
    const stored = { id: 'j-99', ts: '2026-02-30T00:00:00.000Z' };
    const forged = { ...plan, writes: [{ ...write, uncapped: { ...write.uncapped, lessons: write.uncapped.lessons.map((lesson) => ({ ...lesson, provenance: [...lesson.provenance, stored] })) } }] };
    expect(() => checkPlan(forged)).toThrowError(/pre-cap provenance j-99 carries an invalid instant/);
  });

  it('a repaired chapter must hold the planned bytes — a valid-looking substitution is still caught (R6-05)', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    writeFileSync(join(bible.chaptersDir, 'ops.md'), `# Ops\n\n## a\n\nrecurred: 1\nprovenance: j-1\n\nBody.\n`);
    const store = bible as unknown as { writeAtomic(file: string, data: string | Buffer): void };
    const real = store.writeAtomic.bind(bible);
    // A parseable, fitting, WRONG instant lands instead of the journal's.
    store.writeAtomic = (file, data) => real(file, file === join(bible.chaptersDir, 'ops.md') ? String(data).replace(at(1), at(2)) : data);
    expect(() => bible.repairProvenance(JOURNAL_R5, { write: true })).toThrowError(/chapter ops\.md does not hold the planned bytes/);
  });

  it('a planned chapter that vanishes before verification fails the repair — never a success report without it (R7-06)', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    const original = `# Ops\n\n## a\n\nrecurred: 1\nprovenance: j-1\n\nBody.\n`;
    writeFileSync(join(bible.chaptersDir, 'ops.md'), original);
    const store = bible as unknown as { writeAtomic(file: string, data: string | Buffer): void };
    const real = store.writeAtomic.bind(bible);
    // The replacement lands, then is deleted before the read-back.
    store.writeAtomic = (file, data) => {
      real(file, data);
      if (file === join(bible.chaptersDir, 'ops.md')) rmSync(file);
    };
    let caught: unknown;
    try {
      bible.repairProvenance(JOURNAL_R5, { write: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RepairWriteError);
    const failure = caught as RepairWriteError;
    expect(failure.message).toMatch(/chapter ops\.md cannot be read back \(ENOENT\)/);
    expect(failure.written).toEqual(['ops']);
    expect(readFileSync(join(failure.backupDir, 'chapters', 'ops.md'), 'utf8')).toBe(original);
  });

  it('the body floor is 160 code units even when an emoji straddles it — never 159 plus the marker (R7-09)', () => {
    const marker = ' … [trimmed to fit the chapter cap]';
    const body = `${'a'.repeat(159)}😀${'b'.repeat(300)}`;
    const chapter = chapterOf([lessonOf('emoji', [{ id: 'j-1', ts: at(1) }], body)]);
    const sized = (kept: string) => Buffer.byteLength(serializeChapter(chapterOf([lessonOf('emoji', [{ id: 'j-1', ts: at(1) }], `${kept}${marker}`)])), 'utf8');
    // Room for 159 units and the marker, not 161: the lesson cannot stay.
    const tight = enforceChapterCap(chapter, sized('a'.repeat(159)));
    for (const lesson of tight.chapter.lessons.filter((candidate) => candidate.slug !== ARCHIVED_LESSON_SLUG)) {
      expect(lesson.body.endsWith(marker) ? lesson.body.length - marker.length : lesson.body.length).toBeGreaterThanOrEqual(160);
    }
    expect(tight.chapter.lessons.some((lesson) => lesson.slug === 'emoji')).toBe(false);
    // Room for the whole emoji: kept at the first boundary past the floor.
    const roomy = enforceChapterCap(chapter, sized(`${'a'.repeat(159)}😀`));
    expect(roomy.chapter.lessons.find((lesson) => lesson.slug === 'emoji')?.body).toBe(`${'a'.repeat(159)}😀${marker}`);
  });

  it('whitespace a trim drops never counts toward the body floor (R6-06)', () => {
    const body = `First.${' '.repeat(200)}${'Retained words after the gap. '.repeat(3).trim()}`;
    const chapter = chapterOf([lessonOf('gap', [{ id: 'j-1', ts: at(1) }], body)]);
    const full = Buffer.byteLength(serializeChapter(chapter), 'utf8');
    const result = enforceChapterCap(chapter, full - 20);
    const kept = result.chapter.lessons.find((lesson) => lesson.slug === 'gap')!;
    expect(result.trimmed).toBe(1);
    expect(kept.body).toMatch(/^First\. +Retained words/u); // never just "First." plus the marker
    expect(kept.body.endsWith(' … [trimmed to fit the chapter cap]')).toBe(true);
    // Room only for a cut INSIDE the gap: that would keep six units — the
    // lesson goes to the archive instead.
    const archive = {
      slug: ARCHIVED_LESSON_SLUG, recurred: 1, provenance: [{ id: 'j-1', ts: at(1) }], tags: ['archived'],
      body: 'Lessons trimmed at the chapter cap; provenance retained so the journal remains the ground truth.',
    };
    const tight = Buffer.byteLength(serializeChapter(chapterOf([archive])), 'utf8');
    const squeezed = enforceChapterCap(chapter, tight);
    expect(squeezed.chapter.lessons.some((lesson) => lesson.body.startsWith('First. …'))).toBe(false);
    expect(squeezed.droppedLessons).toBe(1);
  });

  it('INDEX.md and chapters alike: invalid bytes refuse reading, planning and applying, and stay as they are (R6-10)', () => {
    for (const target of ['INDEX.md', 'chapters/ops-restarts.md'] as const) {
      const bible = tmpBible();
      bible.ensureSeeded();
      // A replacement character the book really holds — in a summary, so in INDEX.md too.
      bible.applyPlan(bible.planUpdates([proposal({ summary: 'Restart discipline \uFFFD kept.' })], PROVENANCE));
      const file = join(bible.dir, target);
      expect(readFileSync(file).includes(Buffer.from([0xef, 0xbf, 0xbd])), target).toBe(true);
      const plan = bible.planUpdates([proposal({ slug: 'ops-other' })], PROVENANCE);
      const corrupted = Buffer.from(readFileSync(file).toString('latin1').replace('\u00ef\u00bf\u00bd', '\u00ff'), 'latin1');
      writeFileSync(file, corrupted);
      expect(() => bible.applyPlan(plan), target).toThrowError(new RegExp(`${target.replace('.', '\\.')} is not valid UTF-8`));
      expect(() => bible.planUpdates([proposal({ slug: 'ops-other' })], PROVENANCE), target).toThrowError(/is not valid UTF-8/);
      expect(() => (target === 'INDEX.md' ? bible.readIndexText() : bible.readChapter('ops-restarts')), target).toThrowError(/is not valid UTF-8/);
      expect(readFileSync(file).equals(corrupted), target).toBe(true);
      expect(existsSync(join(bible.chaptersDir, 'ops-other.md')), target).toBe(false);
    }
  });

  it('a bare-CR or CRLF INDEX.md points briefings at exactly the lessons an LF one does (R6-11)', () => {
    const pointersWith = (eol: string) => {
      const bible = tmpBible();
      bible.ensureSeeded();
      bible.applyPlan(bible.planUpdates([proposal()], PROVENANCE));
      const index = join(bible.dir, 'INDEX.md');
      writeFileSync(index, readFileSync(index, 'utf8').replace(/\n/gu, eol));
      return createBibleReferences({ bible }).referencesFor('restart the shell').map((pointer) => ({ ...pointer, path: basename(pointer.path) }));
    };
    const lf = pointersWith('\n');
    expect(lf.length).toBeGreaterThan(0);
    expect(pointersWith('\r\n')).toEqual(lf);
    expect(pointersWith('\r')).toEqual(lf);
  });

  it('a chapter with invalid bytes is refused by the bulk read, by name, and briefings fall back to index-level pointers (R7-07)', () => {
    const bible = tmpBible();
    bible.ensureSeeded();
    // A replacement character the chapter really holds, then corrupted on disk.
    bible.applyPlan(bible.planUpdates([proposal({ summary: 'Restart discipline \uFFFD kept.' })], PROVENANCE));
    const healthy = createBibleReferences({ bible }).referencesFor('restart the shell');
    expect(healthy.some((pointer) => pointer.lesson !== null)).toBe(true);
    const file = join(bible.chaptersDir, 'ops-restarts.md');
    writeFileSync(file, Buffer.from(readFileSync(file).toString('latin1').replace('ï¿½', 'ÿ'), 'latin1'));
    expect(() => bible.readChapters()).toThrowError(/chapters\/ops-restarts\.md is not valid UTF-8/);
    const logged: { level: string; message: string; fields: Record<string, unknown> | undefined }[] = [];
    const pointers = createBibleReferences({
      bible,
      log: (level, message, fields) => logged.push({ level, message, fields }),
    }).referencesFor('restart the shell');
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.every((pointer) => pointer.lesson === null)).toBe(true);
    expect(pointers.map((pointer) => pointer.chapter)).toContain('ops-restarts');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe('warn');
    expect(String(logged[0]!.fields?.['error'])).toMatch(/ops-restarts\.md is not valid UTF-8/);
  });

  it('repeated journal ids never fill the provenance floor with copies — the newest three distinct handles stay (R5-A5, C4)', () => {
    const refs = new Map(Array.from({ length: 5 }, (_, index) => [`j-${index + 1}`, at(index + 1)] as const));
    const body = 'A lesson whose evidence repeats.';
    const handles = (...seqs: number[]) => seqs.map((seq) => ({ id: `j-${seq}`, ts: at(seq) }));
    // A cap that holds the lesson with exactly three handles.
    const three = serializeChapter({ slug: 'ops', title: 'Ops', summary: 'Ops.', tags: ['ops'], lessons: [lessonOf('dup', handles(3, 4, 5), body)] });
    const bible = tmpBible(Buffer.byteLength(three, 'utf8'));
    bible.ensureSeeded();
    const plan = bible.planUpdates([{
      slug: 'ops', title: 'Ops', summary: 'Ops.', tags: ['ops'],
      lessons: [{ slug: 'dup', body, journalIds: ['j-1', 'j-2', 'j-3', 'j-4', 'j-5', 'j-5', 'j-5'] }],
    }], refs);
    expect(plan.writes[0]!.text).toBe(three);
    expect(plan.writes[0]!.uncapped.lessons[0]!.provenance.map((ref) => ref.id)).toEqual(['j-1', 'j-2', 'j-3', 'j-4', 'j-5']);
    expect(describePlan(plan).chapters[0]!.provenanceTrimmed).toBe(2);
    // A stored lesson cites each handle once; a plan that repeats one is refused.
    expect(() => parseChapter(`# Ops\n\n## dup\n\nrecurred: 1\nprovenance: j-5@${at(5)}, j-5@${at(5)}\n\n${body}\n`, 'ops'))
      .toThrowError(/provenance cites j-5 more than once/);
    const write = plan.writes[0]!;
    const lesson = write.uncapped.lessons[0]!;
    const forged = { ...plan, writes: [{ ...write, uncapped: { ...write.uncapped, lessons: [{ ...lesson, provenance: [...lesson.provenance, lesson.provenance.at(-1)!] }] } }] };
    expect(() => checkPlan(forged)).toThrowError(/pre-cap provenance repeats j-5/);
  });
});
