import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BibleStore,
  enforceChapterCap,
  parseChapter,
  parseIndex,
  renderIndex,
  serializeChapter,
} from '../src/lessons/bible.js';
import { BibleError, type BibleChapter, type ProposedChapter } from '../src/lessons/types.js';

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
