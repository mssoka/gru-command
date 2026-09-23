import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BibleStore } from '../src/lessons/bible.js';
import { DreamEngine, DreamScheduler, loadDreamState, type DreamDistiller, type DistillInput, type DistillResult, type DreamOutcome } from '../src/lessons/dream.js';
import { JournalStore } from '../src/lessons/journal.js';
import { DreamError, type JournalEntry, type ProposedChapter } from '../src/lessons/types.js';

/**
 * Dream pass (Book of Lessons distillation): cursor semantics, dedupe
 * across passes (recurred), provenance guard, bounded batches, and the
 * cadence scheduler (on boot + interval, never overlapping).
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function updateFrom(entries: readonly JournalEntry[], body = 'the one durable lesson'): ProposedChapter {
  return {
    slug: 'ops-restarts',
    title: 'Ops restarts',
    summary: 'Restart discipline.',
    tags: ['ops'],
    lessons: [
      {
        slug: 'shell-hang',
        body,
        journalIds: entries.map((entry) => entry.id),
      },
    ],
  };
}

class FakeDistiller implements DreamDistiller {
  readonly calls: DistillInput[] = [];
  private readonly responder: (input: DistillInput) => DistillResult;

  constructor(responder?: (input: DistillInput) => DistillResult) {
    this.responder = responder ?? ((input) => ({ chapters: [updateFrom(input.entries)] }));
  }

  async distill(input: DistillInput): Promise<DistillResult> {
    this.calls.push(input);
    return this.responder(input);
  }
}

function engineHarness(opts: { maxEntriesPerDream?: number } = {}) {
  const root = tmpDir('gru-command-dream-');
  const journal = new JournalStore(join(root, 'journal'));
  const bible = new BibleStore(join(root, 'bible'));
  const distiller = new FakeDistiller();
  const engine = new DreamEngine({
    journal,
    bible,
    distiller,
    ...(opts.maxEntriesPerDream !== undefined ? { maxEntriesPerDream: opts.maxEntriesPerDream } : {}),
  });
  return { root, journal, bible, distiller, engine };
}

describe('dream engine', () => {
  it('no new entries = no distiller call, no state churn, no model cost', async () => {
    const h = engineHarness();
    const outcome = await h.engine.run();
    expect(outcome.status).toBe('noop');
    expect(outcome.entries).toBe(0);
    expect(h.distiller.calls).toHaveLength(0);
  });

  it('dreams a journal entry into a chapter and advances the cursor exactly once', async () => {
    const h = engineHarness();
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    const first = await h.engine.run();
    expect(first).toMatchObject({ status: 'dreamed', entries: 1, coveredThroughSeq: entry.seq, lessonsAdded: 1 });
    expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.provenance).toEqual([
      { id: entry.id, ts: entry.ts },
    ]);
    const state = loadDreamState(join(h.bible.dir, '.dream-state.json'));
    expect(state.coveredThroughSeq).toBe(entry.seq);
    expect(state.cycles).toBe(1);

    // The same entry is never re-dreamed.
    const second = await h.engine.run();
    expect(second.status).toBe('noop');
    expect(h.distiller.calls).toHaveLength(1);
  });

  it('a repeat finding across dreams merges into the lesson: recurred 2, both provenances', async () => {
    const h = engineHarness();
    const firstEntry = h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const secondEntry = h.journal.append({
      kind: 'finding',
      source: 'silas',
      body: 'shell hang finding again (same root cause)',
    });
    const second = await h.engine.run();
    expect(second.lessonsMerged).toBe(1);
    const lessons = h.bible.readChapter('ops-restarts')!.lessons;
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.recurred).toBe(2);
    expect(lessons[0]!.provenance.map((ref) => ref.id)).toEqual([firstEntry.id, secondEntry.id]);
  });

  it('a failed dream leaves the cursor put so the same entries retry next beat', async () => {
    const h = engineHarness();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'retry me' });
    const failing = new DreamEngine({
      journal: h.journal,
      bible: h.bible,
      distiller: {
        async distill(): Promise<DistillResult> {
          throw new Error('model outage');
        },
      },
    });
    await expect(failing.run()).rejects.toThrowError(/model outage/);
    expect(loadDreamState(join(h.bible.dir, '.dream-state.json')).coveredThroughSeq).toBe(0);

    const recovered = await h.engine.run();
    expect(recovered.status).toBe('dreamed');
    expect(recovered.entries).toBe(1);
  });

  it('refuses invented provenance: ids outside the batch fail the pass with the cursor unchanged', async () => {
    const h = engineHarness();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'real entry' });
    const rogue = new DreamEngine({
      journal: h.journal,
      bible: h.bible,
      distiller: new FakeDistiller(() => ({
        chapters: [
          {
            slug: 'ops-restarts',
            title: 'Ops restarts',
            summary: 'Restart discipline.',
            lessons: [{ slug: 'invented', body: 'made up', journalIds: ['j-99'] }],
          },
        ],
      })),
    });
    await expect(rogue.run()).rejects.toThrowError(DreamError);
    expect(loadDreamState(join(h.bible.dir, '.dream-state.json')).coveredThroughSeq).toBe(0);
    expect(h.bible.readChapter('ops-restarts')).toBeNull();
  });

  it('bounds one pass: entries beyond maxEntriesPerDream wait for the next pass', async () => {
    const h = engineHarness({ maxEntriesPerDream: 1 });
    h.journal.append({ kind: 'finding', source: 'gru', body: 'first' });
    h.journal.append({ kind: 'finding', source: 'gru', body: 'second' });
    const first = await h.engine.run();
    expect(first.entries).toBe(1);
    expect(first.coveredThroughSeq).toBe(1);
    const second = await h.engine.run();
    expect(second.entries).toBe(1);
    expect(second.coveredThroughSeq).toBe(2);
  });
});

describe('dream scheduler', () => {
  it('fires on boot and on the interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const runs: DreamOutcome[] = [];
      const scheduler = new DreamScheduler({
        intervalMs: 100,
        dreamOnBoot: true,
        run: async () => {
          const outcome: DreamOutcome = {
            status: 'noop',
            entries: 0,
            coveredThroughSeq: runs.length,
            chaptersTouched: 0,
            lessonsAdded: 0,
            lessonsMerged: 0,
            lessonsTrimmed: 0,
            lessonsDropped: 0,
          };
          runs.push(outcome);
          return outcome;
        },
      });
      scheduler.start();
      expect(scheduler.running).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toHaveLength(1); // on boot
      await vi.advanceTimersByTimeAsync(350);
      expect(runs.length).toBeGreaterThanOrEqual(4); // boot + ~3 intervals
      scheduler.stop();
      expect(scheduler.running).toBe(false);
      const fired = runs.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(runs).toHaveLength(fired);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overlaps: a busy pass skips the beat', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const scheduler = new DreamScheduler({
      intervalMs: 10,
      dreamOnBoot: false,
      run: async () => {
        started += 1;
        await gate;
        return {
          status: 'noop',
          entries: 0,
          coveredThroughSeq: 0,
          chaptersTouched: 0,
          lessonsAdded: 0,
          lessonsMerged: 0,
          lessonsTrimmed: 0,
          lessonsDropped: 0,
        } satisfies DreamOutcome;
      },
    });
    const first = scheduler.tick();
    const skipped = await scheduler.tick();
    expect(skipped).toBeNull();
    expect(started).toBe(1);
    release();
    expect((await first)?.status).toBe('noop');
  });

  it('interval 0 + dreamOnBoot false = the trigger never fires', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const scheduler = new DreamScheduler({
        intervalMs: 0,
        dreamOnBoot: false,
        run: async () => {
          calls += 1;
          throw new Error('should never run');
        },
      });
      scheduler.start();
      expect(scheduler.running).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
