import * as fs from 'node:fs';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { BibleLockReleaseError, BibleStore, BIBLE_WRITE_LOCK } from '../src/lessons/bible.js';
import { DREAM_STATE_FILE, DreamEngine, loadDreamState } from '../src/lessons/dream.js';
import { JournalStore } from '../src/lessons/journal.js';
import { DreamError, type ProposedChapter } from '../src/lessons/types.js';

/**
 * The Book of Lessons write lock under injected filesystem faults (third
 * bmad-code-review round of #253): nothing of a failed acquisition may
 * outlive it, and a completed write whose lock release fails is reported
 * as completed — so the dream never replays an applied batch.
 */

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    rmSync: vi.fn(actual.rmSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

const real = await vi.importActual<typeof import('node:fs')>('node:fs');

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.mocked(fs.writeFileSync).mockReset();
  vi.mocked(fs.rmSync).mockReset();
  vi.mocked(fs.unlinkSync).mockReset();
});

const isStaging = (path: unknown): boolean => /\.write\.lock\.[0-9a-f-]{36}$/u.test(String(path));
const isLock = (path: unknown): boolean => String(path).endsWith(BIBLE_WRITE_LOCK);

function store(): BibleStore {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-bible-lock-'));
  cleanupDirs.push(dir);
  const bible = new BibleStore(join(dir, 'bible'));
  bible.ensureSeeded();
  return bible;
}

const UPDATE: ProposedChapter = {
  slug: 'ops',
  title: 'Ops',
  summary: 'Restart discipline.',
  tags: ['ops'],
  lessons: [{ slug: 'shell', body: 'Close the shell first.', journalIds: ['j-1'] }],
};
const PROVENANCE = new Map([['j-1', '2026-10-07T00:00:00.000Z']]);

describe('Book of Lessons write lock under filesystem faults', () => {
  it('a staging write that fails after creating its file leaves nothing behind', () => {
    const bible = store();
    vi.mocked(fs.writeFileSync).mockImplementation((path, data, options) => {
      if (isStaging(path)) {
        real.writeFileSync(path, '{"pid":', options); // partially written, then the disk fills
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return real.writeFileSync(path, data, options);
    });
    expect(() => bible.applyUpdates([UPDATE], PROVENANCE)).toThrowError(/ENOSPC/);
    expect(readdirSync(bible.dir).filter((name) => name.startsWith(BIBLE_WRITE_LOCK))).toEqual([]);
    expect(bible.readChapter('ops')).toBeNull();
  });

  it('a lock published but whose staging cleanup fails is released: the write never runs, the next one does', () => {
    const bible = store();
    let failures = 0;
    vi.mocked(fs.rmSync).mockImplementation((path, options) => {
      if (isStaging(path) && failures === 0) {
        failures += 1;
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      }
      return real.rmSync(path, options);
    });
    expect(() => bible.applyUpdates([UPDATE], PROVENANCE)).toThrowError(/EBUSY/);
    expect(bible.readChapter('ops')).toBeNull(); // the locked work never ran
    expect(readdirSync(bible.dir).filter((name) => name.startsWith(BIBLE_WRITE_LOCK))).toEqual([]);
    expect(bible.applyUpdates([UPDATE], PROVENANCE).chaptersWritten).toBe(1); // not blocked by a leaked lock
  });

  it('a completed write whose lock release fails is reported as completed, with its result', () => {
    const bible = store();
    vi.mocked(fs.unlinkSync).mockImplementation((path) => {
      if (isLock(path)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return real.unlinkSync(path);
    });
    let caught: unknown;
    try {
      bible.applyUpdates([UPDATE], PROVENANCE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BibleLockReleaseError);
    expect((caught as Error).message).toContain('dream apply completed, but releasing the book write lock');
    expect((caught as BibleLockReleaseError).result).toMatchObject({ chaptersWritten: 1, lessonsAdded: 1 });
    expect(bible.readChapter('ops')?.lessons[0]?.recurred).toBe(1);
  });

  it('the dream advances its cursor when only the lock release failed, so the batch is never replayed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-dream-lock-'));
    cleanupDirs.push(dir);
    const journal = new JournalStore(join(dir, 'journal'));
    const bible = new BibleStore(join(dir, 'bible'));
    const entry = journal.append({ kind: 'finding', source: 'gru', body: 'shell hang' });
    const distill = vi.fn(async () => ({ chapters: [{ ...UPDATE, lessons: [{ ...UPDATE.lessons[0]!, journalIds: [entry.id] }] }] }));
    const engine = new DreamEngine({ journal, bible, distiller: { distill } });
    let failures = 0;
    vi.mocked(fs.unlinkSync).mockImplementation((path) => {
      if (isLock(path) && failures === 0) {
        failures += 1;
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return real.unlinkSync(path);
    });
    await expect(engine.run()).rejects.toThrowError(DreamError);
    await expect(engine.run()).resolves.toMatchObject({ status: 'noop' });
    expect(loadDreamState(join(bible.dir, DREAM_STATE_FILE)).coveredThroughSeq).toBe(entry.seq);
    expect(bible.readChapter('ops')?.lessons[0]?.recurred).toBe(1);
    expect(distill).toHaveBeenCalledTimes(1);
  });
});
