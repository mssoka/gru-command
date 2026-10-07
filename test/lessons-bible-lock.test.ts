import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { BibleLockReleaseError, BibleStore, RepairWriteError } from '../src/lessons/bible.js';
import { DREAM_STATE_FILE, DreamEngine, LessonProposals, loadDreamState, PROPOSAL_FILE, type ProposalNotifier } from '../src/lessons/dream.js';
import { JournalStore } from '../src/lessons/journal.js';
import { DreamError, type ProposedChapter } from '../src/lessons/types.js';

/**
 * The Book of Lessons write lock under injected faults (owner decision
 * 2026-10-07: an exclusive SQLite transaction the OS releases when its
 * process ends). Work that fails inside the lock releases it; a completed
 * write whose release reports a failure is reported as COMPLETED — so the
 * dream never replays an applied batch and an Accept is never lost.
 */

const faults = vi.hoisted(() => ({ failClose: 0 }));

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>();
  class DatabaseSync extends actual.DatabaseSync {
    override close(): void {
      super.close(); // the lock IS released; only the report fails
      if (faults.failClose > 0) {
        faults.failClose -= 1;
        throw new Error('disk I/O error');
      }
    }
  }
  return { ...actual, DatabaseSync };
});

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  faults.failClose = 0;
});

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

describe('Book of Lessons write lock under faults', () => {
  it('work that fails inside the lock releases it — the next write proceeds', () => {
    const bible = store();
    expect(() => bible.applyUpdates([{ ...UPDATE, slug: 'Not A Slug' }], PROVENANCE)).toThrowError(/kebab-case/);
    expect(bible.applyUpdates([UPDATE], PROVENANCE).chaptersWritten).toBe(1);
  });

  it('a completed write whose lock release fails is reported as completed, with its result', () => {
    const bible = store();
    faults.failClose = 1;
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

  it('a repair whose lock release fails after every chapter was written reports the backup — never "nothing was written"', () => {
    const bible = store();
    writeFileSync(join(bible.chaptersDir, 'a.md'), '# A\n\n## a\n\nrecurred: 1\nprovenance: j-2; earlier: j-1\n\nBody.\n');
    faults.failClose = 1;
    let caught: unknown;
    try {
      bible.repairProvenance(new Map([['j-1', '2026-10-01T00:01:00.000Z'], ['j-2', '2026-10-01T00:02:00.000Z']]), { write: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RepairWriteError);
    expect((caught as RepairWriteError).message).toContain('repair replaced all 1 chapter(s) (a), then failed: ');
    expect((caught as RepairWriteError).message).toContain('disk I/O error');
    expect(existsSync((caught as RepairWriteError).backupDir)).toBe(true);
  });

  it('the dream advances its cursor when only the lock release failed, so the batch is never replayed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-dream-lock-'));
    cleanupDirs.push(dir);
    const journal = new JournalStore(join(dir, 'journal'));
    const bible = new BibleStore(join(dir, 'bible'));
    const entry = journal.append({ kind: 'finding', source: 'gru', body: 'shell hang' });
    const distill = vi.fn(async () => ({ chapters: [{ ...UPDATE, lessons: [{ ...UPDATE.lessons[0]!, journalIds: [entry.id] }] }] }));
    const engine = new DreamEngine({ journal, bible, distiller: { distill }, autoApply: true });
    faults.failClose = 1;
    await expect(engine.run()).rejects.toThrowError(DreamError);
    await expect(engine.run()).resolves.toMatchObject({ status: 'noop' });
    expect(loadDreamState(join(bible.dir, DREAM_STATE_FILE)).coveredThroughSeq).toBe(entry.seq);
    expect(bible.readChapter('ops')?.lessons[0]?.recurred).toBe(1);
    expect(distill).toHaveBeenCalledTimes(1);
  });

  it('an Accept that was written but whose lock release failed is a finished Accept — cursor advanced, notice resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-accept-lock-'));
    cleanupDirs.push(dir);
    const journal = new JournalStore(join(dir, 'journal'));
    const bible = new BibleStore(join(dir, 'bible'));
    const resolved: string[] = [];
    const notifier: ProposalNotifier = {
      ensure: () => {},
      resolve: (id) => {
        resolved.push(id);
      },
      inform: () => {},
      conflict: () => {},
    };
    const proposals = new LessonProposals({ bible, notifier });
    const entry = journal.append({ kind: 'finding', source: 'gru', body: 'shell hang' });
    const distill = async () => ({ chapters: [{ ...UPDATE, lessons: [{ ...UPDATE.lessons[0]!, journalIds: [entry.id] }] }] });
    await new DreamEngine({ journal, bible, distiller: { distill }, proposals }).run();
    const { id, notificationId } = proposals.review()!;
    faults.failClose = 1;
    expect(proposals.accept(id)).toMatchObject({ decision: 'accepted', report: { chaptersWritten: 1 } });
    expect(loadDreamState(join(bible.dir, DREAM_STATE_FILE)).coveredThroughSeq).toBe(entry.seq);
    expect(resolved).toEqual([notificationId]);
    expect(existsSync(join(bible.dir, PROPOSAL_FILE))).toBe(false);
    expect(bible.applyUpdates([UPDATE], PROVENANCE).chaptersWritten).toBe(1); // nothing left holding the book
  });
});
