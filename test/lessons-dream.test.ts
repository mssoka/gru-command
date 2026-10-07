import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BibleStore } from '../src/lessons/bible.js';
import {
  dreamFailureIncidents,
  DREAM_FAILED_KIND,
  DreamEngine,
  DreamScheduler,
  DREAM_STATE_FILE,
  LessonProposals,
  lessonProposalNotifier,
  loadDreamState,
  PROPOSAL_FILE,
  repairCommand,
  coalesceReplay,
  saveDreamState,
  type DreamDistiller,
  type DistillInput,
  type DistillResult,
  type DreamOutcome,
  type ProposalNotifier,
} from '../src/lessons/dream.js';
import { DREAM_PROMPT_BODY_CLAMP, parseDreamOutput, renderDreamPrompt } from '../src/lessons/distiller.js';
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
    autoApply: true,
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
      autoApply: true,
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
      autoApply: true,
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

describe('dream distiller protocol (one Bob pass)', () => {
  function entry(id: string, body: string): JournalEntry {
    return { seq: 1, id, ts: '2026-09-23T00:00:00.000Z', kind: 'finding', source: 'gru', tags: [], body };
  }

  it('renders the entries, the bible location, the caps, and the exact output file', () => {
    const long = 'x'.repeat(DREAM_PROMPT_BODY_CLAMP + 500);
    const prompt = renderDreamPrompt({
      entries: [entry('j-1', 'short finding'), entry('j-2', long)],
      index: '# Book of Lessons — index',
      bibleDir: '/tmp/bible',
      chapterCapBytes: 4096,
      indexCapBytes: 1024,
      outputFile: '/tmp/bible/.dream-output-abc.json',
    });
    expect(prompt).toContain('"id":"j-1"');
    expect(prompt).toContain('entry truncated for the dream prompt');
    expect(prompt).toContain('/tmp/bible/.dream-output-abc.json');
    expect(prompt).toContain('Chapters are capped at 4096 bytes');
    expect(prompt).toContain('1024 bytes');
    expect(prompt).toContain('mergeInto');
  });

  it('parses a valid update and rejects invented provenance / malformed shapes', () => {
    const entries = [entry('j-1', 'finding')];
    const valid = parseDreamOutput(
      JSON.stringify({
        chapters: [
          {
            slug: 'ops-restarts',
            title: 'Ops restarts',
            summary: 'One line.',
            tags: ['ops'],
            lessons: [{ slug: 'shell-hang', body: 'Kill the shell.', tags: ['shell'], journalIds: ['j-1'] }],
          },
        ],
      }),
      entries,
    );
    expect(valid.chapters).toHaveLength(1);
    expect(valid.chapters[0]!.lessons[0]).toMatchObject({ slug: 'shell-hang', journalIds: ['j-1'] });

    expect(() => parseDreamOutput('not json', entries)).toThrowError(/not valid JSON/);
    expect(() =>
      parseDreamOutput(
        JSON.stringify({ chapters: [{ slug: 'x', title: 'x', summary: 'x', lessons: [{ slug: 'y', body: 'b', journalIds: ['j-9'] }] }] }),
        entries,
      ),
    ).toThrowError(/provenance may not be invented/);
    expect(() =>
      parseDreamOutput(
        JSON.stringify({ chapters: [{ slug: 'x', title: 'x', summary: 'x', lessons: [{ slug: 'y', body: 'b', journalIds: [] }] }] }),
        entries,
      ),
    ).toThrowError(/cites no journal id/);
    expect(() =>
      parseDreamOutput(
        JSON.stringify({ chapters: [{ slug: 'Not A Slug', title: 'x', summary: 'x', lessons: [] }] }),
        entries,
      ),
    ).toThrowError(/kebab-case slug/);
  });

  it('accepts a retire update without a lessons array', () => {
    const result = parseDreamOutput(
      JSON.stringify({ chapters: [{ slug: 'old-chapter', title: 'Old', summary: 'retired', retire: true }] }),
      [],
    );
    expect(result.chapters[0]).toMatchObject({ slug: 'old-chapter', retire: true, lessons: [] });
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

  it('a failed pass is raised through onFailure (owner incident 2026-10-07), and a throwing hook never breaks the beat', async () => {
    const failure = new DreamError('chapter completion-contract.md lesson x: provenance "j-878" must be "<journal-id>@<iso-date>"');
    const seen: unknown[] = [];
    const logged: string[] = [];
    let successCalls = 0;
    const scheduler = new DreamScheduler({
      intervalMs: 0,
      dreamOnBoot: false,
      run: async () => {
        throw failure;
      },
      onFailure: (error) => {
        seen.push(error);
        throw new Error('incident store down');
      },
      onSuccess: () => {
        successCalls += 1;
      },
      log: (_level, msg) => logged.push(msg),
    });
    await expect(scheduler.tick()).resolves.toBeNull();
    expect(seen).toEqual([failure]);
    expect(successCalls).toBe(0);
    expect(logged).toContain('dream pass failed — journal cursor unchanged, next beat retries');
    expect(logged).toContain('dream onFailure hook threw');
  });

  it('a completed pass (noop included) resolves through onSuccess with its outcome', async () => {
    const outcomes: DreamOutcome[] = [];
    let failureCalls = 0;
    const noop: DreamOutcome = {
      status: 'noop',
      entries: 0,
      coveredThroughSeq: 7,
      chaptersTouched: 0,
      lessonsAdded: 0,
      lessonsMerged: 0,
      lessonsTrimmed: 0,
      lessonsDropped: 0,
    };
    const scheduler = new DreamScheduler({
      intervalMs: 0,
      dreamOnBoot: false,
      run: async () => noop,
      onFailure: () => {
        failureCalls += 1;
      },
      onSuccess: (outcome) => outcomes.push(outcome),
    });
    await expect(scheduler.tick()).resolves.toEqual(noop);
    expect(outcomes).toEqual([noop]);
    expect(failureCalls).toBe(0);
  });
});

describe('due-based dream cadence (issue #221)', () => {
  const HOUR = 3_600_000;
  const BOOT_AT = Date.parse('2026-10-05T12:00:00.000Z');

  /**
   * A persisted schedule (lastDreamAt), one already-covered journal entry,
   * `newEntries` fresh entries, and a scheduler on fake timers whose clock
   * advances in lockstep with the injected `now`.
   */
  function cadenceHarness(opts: {
    intervalMs: number;
    lastDreamAt: string | null;
    newEntries: number;
    dreamOnBoot?: boolean;
  }) {
    const root = tmpDir('gru-command-dream-cadence-');
    const journal = new JournalStore(join(root, 'journal'));
    const bible = new BibleStore(join(root, 'bible'));
    const stateFile = join(bible.dir, DREAM_STATE_FILE);
    const distiller = new FakeDistiller();
    bible.ensureSeeded();
    journal.append({ kind: 'finding', source: 'gru', body: 'covered entry' });
    saveDreamState(stateFile, {
      version: 1,
      coveredThroughSeq: 1,
      lastDreamAt: opts.lastDreamAt,
      cycles: opts.lastDreamAt === null ? 0 : 1,
    });
    for (let index = 0; index < opts.newEntries; index += 1) {
      journal.append({ kind: 'finding', source: 'gru', body: `new entry ${index}` });
    }
    let nowMs = BOOT_AT;
    const engine = new DreamEngine({ journal, bible, distiller, autoApply: true });
    const scheduler = new DreamScheduler({
      intervalMs: opts.intervalMs,
      dreamOnBoot: opts.dreamOnBoot ?? true,
      lastDreamAt: () => loadDreamState(stateFile).lastDreamAt,
      now: () => new Date(nowMs),
      run: () => engine.run(),
    });
    return {
      distiller,
      stateFile,
      scheduler,
      advance: async (ms: number) => {
        nowMs += ms;
        await vi.advanceTimersByTimeAsync(ms);
      },
    };
  }

  it('a restart before the due time does not dream; the beat due after the interval does', async () => {
    vi.useFakeTimers();
    try {
      const lastDreamAt = new Date(BOOT_AT - 5 * HOUR).toISOString();
      const h = cadenceHarness({ intervalMs: 12 * HOUR, lastDreamAt, newEntries: 1 });
      h.scheduler.start();
      await h.advance(0);
      expect(h.distiller.calls).toHaveLength(0); // restart ≠ reset: not due yet
      await h.advance(6 * HOUR);
      expect(h.distiller.calls).toHaveLength(0); // 6h < the 7h still owed
      await h.advance(1 * HOUR); // 12h after the last dream
      expect(h.distiller.calls).toHaveLength(1);
      expect(loadDreamState(h.stateFile).coveredThroughSeq).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a restart after the due time dreams on boot when new entries exist', async () => {
    vi.useFakeTimers();
    try {
      const lastDreamAt = new Date(BOOT_AT - 13 * HOUR).toISOString();
      const h = cadenceHarness({ intervalMs: 12 * HOUR, lastDreamAt, newEntries: 1 });
      h.scheduler.start();
      await h.advance(0);
      expect(h.distiller.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('due on boot with no new journal entries runs the beat but never calls the distiller', async () => {
    vi.useFakeTimers();
    try {
      const lastDreamAt = new Date(BOOT_AT - 13 * HOUR).toISOString();
      const h = cadenceHarness({ intervalMs: 12 * HOUR, lastDreamAt, newEntries: 0 });
      h.scheduler.start();
      await h.advance(0);
      expect(h.distiller.calls).toHaveLength(0);
      expect(loadDreamState(h.stateFile).coveredThroughSeq).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the first periodic beat waits out the remainder since the last dream', async () => {
    vi.useFakeTimers();
    try {
      const lastDreamAt = new Date(BOOT_AT - 5 * HOUR).toISOString();
      const h = cadenceHarness({ intervalMs: 12 * HOUR, lastDreamAt, newEntries: 1, dreamOnBoot: false });
      h.scheduler.start();
      await h.advance(0);
      expect(h.distiller.calls).toHaveLength(0);
      await h.advance(7 * HOUR - 60_000);
      expect(h.distiller.calls).toHaveLength(0);
      await h.advance(60_000);
      expect(h.distiller.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unparsable lastDreamAt fails loud at start instead of guessing', () => {
    const scheduler = new DreamScheduler({
      intervalMs: HOUR,
      dreamOnBoot: true,
      lastDreamAt: () => 'not-a-timestamp',
      run: async () => {
        throw new Error('should never run');
      },
    });
    expect(() => scheduler.start()).toThrowError(DreamError);
    expect(() => scheduler.start()).toThrowError(/lastDreamAt/);
  });

  it('stop() cancels a still-pending due beat', async () => {
    vi.useFakeTimers();
    try {
      const lastDreamAt = new Date(BOOT_AT - 5 * HOUR).toISOString();
      const h = cadenceHarness({ intervalMs: 12 * HOUR, lastDreamAt, newEntries: 1, dreamOnBoot: false });
      h.scheduler.start();
      expect(h.scheduler.running).toBe(true);
      h.scheduler.stop();
      expect(h.scheduler.running).toBe(false);
      await h.advance(24 * HOUR);
      expect(h.distiller.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('interval 0 keeps the on-boot-only semantics: one boot pass, no periodic beat', async () => {
    vi.useFakeTimers();
    try {
      const h = cadenceHarness({ intervalMs: 0, lastDreamAt: null, newEntries: 1 });
      h.scheduler.start();
      await h.advance(0);
      expect(h.distiller.calls).toHaveLength(1);
      await h.advance(48 * HOUR);
      expect(h.distiller.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('failing-dream incident, production wiring (owner incident 2026-10-07)', () => {
  it('one open incident per failure streak, resolved by the next completed pass, re-raised by a new failure', () => {
    const dir = tmpDir('gru-command-dream-incident-');
    const db = new LedgerDb(dir);
    try {
      const bus = new EventBus();
      const ledger = new LedgerApi(db.handle, { bus });
      const notifications = new NotificationCenter({ ledger, bus });
      const hooks = dreamFailureIncidents(notifications, 'REPAIR-COMMAND');
      const open = () =>
        ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === DREAM_FAILED_KIND && row.resolvedAt === null);
      hooks.onFailure(new DreamError('provenance "j-878" must be "<journal-id>@<iso-date>"'));
      hooks.onFailure(new DreamError('provenance "j-878" must be "<journal-id>@<iso-date>"'));
      expect(open()).toHaveLength(1);
      const first = open()[0]!;
      expect(first).toMatchObject({ routing: 'action-required', severity: 'error' });
      expect(first.detail).toContain('REPAIR-COMMAND');
      hooks.onSuccess();
      expect(open()).toHaveLength(0);
      hooks.onFailure(new DreamError('model outage'));
      expect(open()).toHaveLength(1);
      expect(open()[0]!.id).not.toBe(first.id);
    } finally {
      db.close();
    }
  });

  it('keeps the first failure and refreshes the latest on the same open incident (owner decision 2026-10-07)', () => {
    const dir = tmpDir('gru-command-dream-incident-latest-');
    const db = new LedgerDb(dir);
    try {
      const bus = new EventBus();
      const ledger = new LedgerApi(db.handle, { bus });
      const notifications = new NotificationCenter({ ledger, bus });
      const times = ['2026-10-07T09:44:26.000Z', '2026-10-07T21:44:26.000Z', '2026-10-08T09:44:26.000Z'];
      let tick = 0;
      const hooks = dreamFailureIncidents(notifications, 'REPAIR', () => new Date(times[tick++]!));
      const open = () => ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === DREAM_FAILED_KIND && row.resolvedAt === null);
      hooks.onFailure(new DreamError('provenance "j-878" must be "<journal-id>@<iso-date>"'));
      const id = open()[0]!.id;
      hooks.onFailure(new Error('provider outage'));
      hooks.onFailure(new Error('provider still out'));
      expect(open()).toHaveLength(1);
      expect(open()[0]!.id).toBe(id);
      const detail = open()[0]!.detail ?? '';
      expect(detail).toContain(`First failure (${times[0]}): DreamError: provenance "j-878" must be "<journal-id>@<iso-date>"`);
      expect(detail).toContain(`Latest failure (${times[2]}, failed pass 3): Error: provider still out`);
      expect(detail).toContain('REPAIR');
    } finally {
      db.close();
    }
  });

  it('counts every failed pass on the same incident — even identical failures under a fixed clock', () => {
    const dir = tmpDir('gru-command-dream-incident-fixed-');
    const db = new LedgerDb(dir);
    try {
      const bus = new EventBus();
      const ledger = new LedgerApi(db.handle, { bus });
      const notifications = new NotificationCenter({ ledger, bus });
      const hooks = dreamFailureIncidents(notifications, 'REPAIR', () => new Date('2026-10-07T09:44:26.000Z'));
      const open = () => ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === DREAM_FAILED_KIND && row.resolvedAt === null);
      hooks.onFailure(new Error('same failure'));
      const id = open()[0]!.id;
      hooks.onFailure(new Error('same failure'));
      expect(open().map((row) => row.id)).toEqual([id]);
      expect(open()[0]!.detail).toContain('Latest failure (2026-10-07T09:44:26.000Z, failed pass 2): Error: same failure');
    } finally {
      db.close();
    }
  });

  it('a failure spanning lines of any kind stays whole in the first and latest failure', () => {
    const dir = tmpDir('gru-command-dream-incident-eol-');
    const db = new LedgerDb(dir);
    try {
      const bus = new EventBus();
      const ledger = new LedgerApi(db.handle, { bus });
      const notifications = new NotificationCenter({ ledger, bus });
      const hooks = dreamFailureIncidents(notifications, 'REPAIR');
      hooks.onFailure(new Error('part1\rpart2\u2028part3\u2029part4\r\npart5'));
      hooks.onFailure(new Error('later\rstill whole'));
      const detail = ledger.listNotifications({ limit: 50 }).find((row) => row.kind === DREAM_FAILED_KIND)!.detail ?? '';
      expect(detail).toMatch(/^First failure \([^)]*\): Error: part1 part2 part3 part4 part5$/mu);
      expect(detail).toMatch(/^Latest failure \([^)]*, failed pass 2\): Error: later still whole$/mu);
    } finally {
      db.close();
    }
  });

  it('the repair command selects this instance and survives spaces and quotes in every path', () => {
    const root = tmpDir("gru-command-repair cmd 'q' ");
    const instanceDir = join(root, "instance dir's");
    const dataDir = join(root, 'data dir');
    mkdirSync(instanceDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const probe = join(root, 'probe tool.mjs');
    writeFileSync(probe, 'process.stdout.write(JSON.stringify([process.env.GRU_COMMAND_HOME, process.argv[2]]));\n');
    const command = repairCommand({ nodePath: process.execPath, toolPath: probe, instanceDir, dataDir });
    const ran = spawnSync('sh', ['-c', command], { encoding: 'utf-8', env: { PATH: process.env.PATH ?? '' } });
    expect(ran.status, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual([instanceDir, dataDir]);
  });
});

describe('owner-approved lesson proposals (owner decision 2026-10-07)', () => {
  /** Idempotent by id, like the production notifier; can fail on demand. */
  class FakeNotifier implements ProposalNotifier {
    readonly notices = new Map<string, { title: string; detail: string }>();
    readonly ensured: string[] = [];
    readonly resolved: { id: string; by: string }[] = [];
    readonly informed = new Map<string, { title: string; detail: string }>();
    failEnsure = 0;
    failResolve = 0;
    ensure(input: { id: string; title: string; detail: string }): void {
      this.ensured.push(input.id);
      if (!this.notices.has(input.id)) this.notices.set(input.id, { title: input.title, detail: input.detail });
      if (this.failEnsure > 0) {
        this.failEnsure -= 1;
        throw new Error('crash after the notice landed');
      }
    }
    resolve(id: string, by: string): void {
      if (this.failResolve > 0) {
        this.failResolve -= 1;
        throw new Error('notification store down');
      }
      this.resolved.push({ id, by });
    }
    inform(input: { id: string; title: string; detail: string }): void {
      if (!this.informed.has(input.id)) this.informed.set(input.id, { title: input.title, detail: input.detail });
    }
    readonly conflicts = new Map<string, { title: string; detail: string }>();
    conflict(input: { id: string; title: string; detail: string }): void {
      if (!this.conflicts.has(input.id)) this.conflicts.set(input.id, { title: input.title, detail: input.detail });
    }
  }

  function twoChapters(input: DistillInput): DistillResult {
    const ids = input.entries.map((entry) => entry.id);
    return {
      chapters: [
        updateFrom(input.entries),
        {
          slug: 'review-rounds',
          title: 'Review rounds',
          summary: 'One head per round.',
          tags: ['review'],
          lessons: [{ slug: 'one-head', body: 'A round binds one head.', journalIds: ids }],
        },
      ],
    };
  }

  function proposalHarness(responder?: (input: DistillInput) => DistillResult) {
    const root = tmpDir('gru-command-proposals-');
    const journal = new JournalStore(join(root, 'journal'));
    const bible = new BibleStore(join(root, 'bible'));
    const distiller = new FakeDistiller(responder);
    const notifier = new FakeNotifier();
    const proposals = new LessonProposals({ bible, notifier });
    const engine = new DreamEngine({ journal, bible, distiller, proposals });
    const file = join(bible.dir, PROPOSAL_FILE);
    const stored = () => JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const store = (record: Record<string, unknown>) => writeFileSync(file, JSON.stringify(record));
    return { journal, bible, distiller, notifier, proposals, engine, file, stored, store };
  }

  /** Every managed book file, so "untouched" is byte-exact. */
  function book(bible: BibleStore): Record<string, string> {
    const files: Record<string, string> = {};
    const index = bible.readIndexText();
    if (index !== null) files['INDEX.md'] = index;
    for (const name of existsSync(bible.chaptersDir) ? readdirSync(bible.chaptersDir).sort() : []) {
      files[`chapters/${name}`] = readFileSync(join(bible.chaptersDir, name), 'utf-8');
    }
    return files;
  }

  const cursor = (bible: BibleStore): number => loadDreamState(join(bible.dir, DREAM_STATE_FILE)).coveredThroughSeq;

  it('needs exactly one write path, and one cursor shared with the proposals', () => {
    const h = proposalHarness();
    expect(() => new DreamEngine({ journal: h.journal, bible: h.bible, distiller: h.distiller })).toThrowError(
      /exactly one write path/,
    );
    expect(
      () => new DreamEngine({ journal: h.journal, bible: h.bible, distiller: h.distiller, proposals: h.proposals, autoApply: true }),
    ).toThrowError(/exactly one write path/);
    expect(
      () => new DreamEngine({
        journal: h.journal,
        bible: h.bible,
        distiller: h.distiller,
        proposals: h.proposals,
        stateFile: join(h.bible.dir, 'other-state.json'),
      }),
    ).toThrowError(/one cursor must govern both/);
  });

  it('a pass proposes: the book and the cursor are untouched and the owner is asked once, under a fixed notice id', async () => {
    const h = proposalHarness();
    h.bible.ensureSeeded();
    const before = book(h.bible);
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    const outcome = await h.engine.run();
    expect(outcome).toMatchObject({ status: 'proposed', entries: 1, coveredThroughSeq: 0, lessonsAdded: 1 });
    expect(book(h.bible)).toEqual(before);
    expect(cursor(h.bible)).toBe(0);
    const review = h.proposals.review()!;
    expect(review.notificationId).toBe(`lessons-proposal:${review.id}`);
    expect([...h.notifier.notices.entries()]).toEqual([
      [
        review.notificationId,
        {
          title: 'Book of Lessons: 1 lesson change proposed',
          detail: 'From 1 journal entry: 1 new, 0 updated across 1 chapter(s) (ops-restarts). Review the changes, then Accept or Reject.',
        },
      ],
    ]);
    expect(review.chapters).toEqual([
      expect.objectContaining({
        slug: 'ops-restarts',
        retired: false,
        summary: { before: null, after: 'Restart discipline.' },
        tags: { before: [], after: ['ops'] },
        added: [
          {
            slug: 'shell-hang',
            body: 'the one durable lesson',
            recurred: 1,
            tags: [],
            previousBody: null,
            previousRecurred: null,
            previousTags: null,
          },
        ],
        changed: [],
        removed: [],
      }),
    ]);
  });

  it('while a proposal waits, a beat neither distills nor proposes again and re-ensures the SAME notice', async () => {
    const h = proposalHarness();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'first' });
    await h.engine.run();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'second' });
    expect((await h.engine.run()).status).toBe('awaiting-owner');
    expect((await h.engine.run()).status).toBe('awaiting-owner');
    expect(h.distiller.calls).toHaveLength(1);
    expect(h.notifier.notices.size).toBe(1);
    expect(new Set(h.notifier.ensured).size).toBe(1);
  });

  it('a crash right after the notice landed leaves no orphan: the next beat re-ensures the same id', async () => {
    const h = proposalHarness();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    h.notifier.failEnsure = 1;
    await expect(h.engine.run()).rejects.toThrowError(/crash after the notice landed/);
    expect(existsSync(h.file)).toBe(true);
    expect((await h.engine.run()).status).toBe('awaiting-owner');
    expect(h.notifier.notices.size).toBe(1);
    expect([...h.notifier.notices.keys()]).toEqual([h.proposals.review()!.notificationId]);
  });

  it('Accept writes the planned update, advances the cursor and resolves the notice', async () => {
    const h = proposalHarness();
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const { id, notificationId } = h.proposals.review()!;
    const decision = h.proposals.accept(id);
    expect(decision).toMatchObject({ id, decision: 'accepted', coveredThroughSeq: entry.seq });
    expect(h.bible.readChapter('ops-restarts')?.lessons[0]).toMatchObject({
      body: 'the one durable lesson',
      provenance: [{ id: entry.id, ts: entry.ts }],
    });
    expect(cursor(h.bible)).toBe(entry.seq);
    expect(h.notifier.resolved).toEqual([{ id: notificationId, by: 'owner:accepted' }]);
    expect(existsSync(h.file)).toBe(false);
    expect((await h.engine.run()).status).toBe('noop');
  });

  it('Reject leaves the book untouched and consumes the batch: it is never proposed again', async () => {
    const h = proposalHarness();
    h.bible.ensureSeeded();
    const before = book(h.bible);
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'not worth keeping' });
    await h.engine.run();
    const { id, notificationId } = h.proposals.review()!;
    expect(h.proposals.reject(id)).toMatchObject({ decision: 'rejected', coveredThroughSeq: entry.seq, report: null });
    expect(book(h.bible)).toEqual(before);
    expect(cursor(h.bible)).toBe(entry.seq);
    expect(h.notifier.resolved).toEqual([{ id: notificationId, by: 'owner:rejected' }]);
    expect((await h.engine.run()).status).toBe('noop');
    expect(h.distiller.calls).toHaveLength(1);
  });

  it('a moved book makes Accept AND Reject refuse: nothing written, cursor kept, owner told, next pass re-proposes', async () => {
    for (const decide of ['accept', 'reject'] as const) {
      const h = proposalHarness();
      h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
      await h.engine.run();
      const { id, notificationId } = h.proposals.review()!;
      writeFileSync(join(h.bible.dir, 'INDEX.md'), `${h.bible.readIndexText() ?? ''}\n`); // someone edits the book
      const moved = book(h.bible);
      expect(() => h.proposals[decide](id)).toThrowError(expect.objectContaining({ code: 'stale' }));
      expect(book(h.bible)).toEqual(moved);
      expect(cursor(h.bible)).toBe(0);
      expect(existsSync(h.file)).toBe(false);
      expect(h.notifier.resolved).toEqual([{ id: notificationId, by: 'stale' }]);
      expect([...h.notifier.informed.keys()]).toEqual([`lessons-proposal-withdrawn:${id}`]);
      expect((await h.engine.run()).status).toBe('proposed');
      expect(h.distiller.calls).toHaveLength(2);
    }
  });

  it('a beat withdraws a stale pending proposal instead of waiting on it forever', async () => {
    const h = proposalHarness();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    writeFileSync(join(h.bible.dir, 'INDEX.md'), `${h.bible.readIndexText() ?? ''}\n`);
    expect((await h.engine.run()).status).toBe('proposed');
    expect(h.notifier.resolved.map((entry) => entry.by)).toEqual(['stale']);
    expect(h.distiller.calls).toHaveLength(2);
  });

  it('a recorded decision never flips: a crashed Reject cannot become an Accept, and its retry resumes it', async () => {
    const h = proposalHarness();
    h.bible.ensureSeeded();
    const before = book(h.bible);
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const { id } = h.proposals.review()!;
    // Crash after the Reject was recorded, before the cursor moved.
    h.store({ ...h.stored(), decision: { kind: 'rejected', at: '2026-10-07T12:00:00.000Z', detail: null } });
    expect(() => h.proposals.accept(id)).toThrowError(expect.objectContaining({ code: 'decided' }));
    expect(book(h.bible)).toEqual(before);
    // Still reviewable, carrying the recorded decision, so any page can finish it.
    expect(h.proposals.review()).toMatchObject({ id, decision: { kind: 'rejected', at: '2026-10-07T12:00:00.000Z' }, recovery: null });
    expect(h.proposals.reject(id)).toMatchObject({ decision: 'rejected', coveredThroughSeq: entry.seq });
    expect(book(h.bible)).toEqual(before);
    expect(existsSync(h.file)).toBe(false);
  });

  it('a crashed Accept cannot be reversed by Reject; the next reconcile finishes it exactly once', async () => {
    const h = proposalHarness(twoChapters);
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const { id } = h.proposals.review()!;
    const record = h.stored();
    const plan = record['plan'] as { writes: { slug: string; text: string }[] };
    // Crash mid-Accept: decision recorded, first chapter written, the rest not.
    h.store({ ...record, decision: { kind: 'accepted', at: '2026-10-07T12:00:00.000Z', detail: null } });
    writeFileSync(join(h.bible.chaptersDir, `${plan.writes[0]!.slug}.md`), plan.writes[0]!.text);
    expect(() => h.proposals.reject(id)).toThrowError(expect.objectContaining({ code: 'decided' }));
    expect(h.proposals.reconcile()).toBeNull();
    expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.recurred).toBe(1);
    expect(h.bible.readChapter('review-rounds')?.lessons[0]?.recurred).toBe(1);
    expect(cursor(h.bible)).toBe(entry.seq);
    expect(existsSync(h.file)).toBe(false);
    expect((await h.engine.run()).status).toBe('noop');
  });

  it('closing keeps the record until the notice is resolved: a failed resolve is finished later, not lost', async () => {
    const h = proposalHarness();
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const { id, notificationId } = h.proposals.review()!;
    h.notifier.failResolve = 1;
    expect(() => h.proposals.accept(id)).toThrowError(/notification store down/);
    expect(cursor(h.bible)).toBe(entry.seq);
    expect(existsSync(h.file)).toBe(true);
    expect(h.proposals.review()).toMatchObject({ id, decision: { kind: 'accepted' } });
    expect(h.proposals.reconcile()).toBeNull();
    expect(h.notifier.resolved).toEqual([{ id: notificationId, by: 'owner:accepted' }]);
    expect(existsSync(h.file)).toBe(false);
  });

  it('a withdrawal after the cursor moved replays the batch: it is still proposed, and the cursor never rewinds', async () => {
    const h = proposalHarness();
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const state = loadDreamState(join(h.bible.dir, DREAM_STATE_FILE));
    saveDreamState(join(h.bible.dir, DREAM_STATE_FILE), { ...state, coveredThroughSeq: 50 }); // moved elsewhere
    expect((await h.engine.run()).status).toBe('proposed');
    expect(h.distiller.calls).toHaveLength(2);
    expect(h.distiller.calls[1]!.entries.map((replayed) => replayed.id)).toEqual([entry.id]);
    h.proposals.accept(h.proposals.review()!.id);
    const after = loadDreamState(join(h.bible.dir, DREAM_STATE_FILE));
    expect(after.coveredThroughSeq).toBe(50);
    expect(after.replay).toBeUndefined();
    expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.provenance.map((ref) => ref.id)).toEqual([entry.id]);
  });

  it('a corrupt or tampered stored plan is refused before a single write', async () => {
    const h = proposalHarness(twoChapters);
    h.bible.ensureSeeded();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const before = book(h.bible);
    const { id } = h.proposals.review()!;
    const record = h.stored();
    const plan = record['plan'] as { writes: unknown[] };
    h.store({ ...record, plan: { ...plan, writes: [plan.writes[0], null] } });
    expect(() => h.proposals.accept(id)).toThrowError(/malformed \(plan\.writes\[1\]\)/);
    expect(book(h.bible)).toEqual(before);
    const tampered = plan.writes.map((write, index) =>
      index === 1 ? { ...(write as object), text: '# Review rounds\n\n## one-head\n\nrecurred: 9\n\nInjected.\n' } : write,
    );
    h.store({ ...record, plan: { ...plan, writes: tampered } });
    expect(() => h.proposals.accept(id)).toThrowError(/plan is inconsistent/);
    expect(book(h.bible)).toEqual(before);
  });

  it('a decision for no proposal, or for a different one, fails loud and changes nothing', async () => {
    const h = proposalHarness();
    expect(() => h.proposals.accept('nope')).toThrowError(expect.objectContaining({ code: 'none' }));
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    expect(() => h.proposals.reject('another-proposal')).toThrowError(expect.objectContaining({ code: 'mismatch' }));
    expect(h.proposals.review()).not.toBeNull();
    expect(h.notifier.resolved).toEqual([]);
  });

  it('a recorded Accept blocked by a foreign edit keeps the owner’s intent: no withdrawal, no re-proposal, a conflict notice, and the same decision finishes once restored', async () => {
    const h = proposalHarness(twoChapters);
    h.bible.ensureSeeded();
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const { id, notificationId } = h.proposals.review()!;
    const record = h.stored();
    const plan = record['plan'] as { writes: { slug: string; text: string }[]; before: { path: string; text: string | null }[] };
    // Crash mid-Accept, then someone edits INDEX.md before recovery.
    h.store({ ...record, decision: { kind: 'accepted', at: '2026-10-07T12:00:00.000Z', detail: null } });
    writeFileSync(join(h.bible.chaptersDir, `${plan.writes[0]!.slug}.md`), plan.writes[0]!.text);
    const indexBefore = h.bible.readIndexText() ?? '';
    writeFileSync(join(h.bible.dir, 'INDEX.md'), `${indexBefore}\n`);
    expect(h.proposals.reconcile()?.id).toBe(id);
    expect((h.stored()['decision'] as { kind: string }).kind).toBe('accepted');
    expect(h.stored()['recovery']).toMatchObject({ conflict: expect.stringContaining('INDEX.md changed') });
    expect([...h.notifier.conflicts.keys()]).toEqual([`lessons-proposal-conflict:${id}`]);
    expect((await h.engine.run()).status).toBe('awaiting-owner');
    expect(h.distiller.calls).toHaveLength(1);
    expect(cursor(h.bible)).toBe(0);
    // Restore the edited file; the same decision now finishes exactly once.
    writeFileSync(join(h.bible.dir, 'INDEX.md'), indexBefore);
    expect(h.proposals.accept(id)).toMatchObject({ decision: 'accepted', coveredThroughSeq: entry.seq });
    expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.recurred).toBe(1);
    expect(h.notifier.resolved).toEqual([
      { id: notificationId, by: 'owner:accepted' },
      { id: `lessons-proposal-conflict:${id}`, by: 'recovered' },
    ]);
  });

  it('recovery never rewinds the cursor or erases a replay range — once committed, only cleanup remains', async () => {
    const h = proposalHarness();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const { id, notificationId } = h.proposals.review()!;
    h.notifier.failResolve = 1;
    expect(() => h.proposals.accept(id)).toThrowError(expect.objectContaining({ code: 'incomplete' }));
    expect(h.stored()['committed']).toMatchObject({ at: expect.any(String) });
    const file = join(h.bible.dir, DREAM_STATE_FILE);
    const moved = { ...loadDreamState(file), coveredThroughSeq: 50, replay: [{ afterSeq: 40, throughSeq: 45 }] };
    saveDreamState(file, moved);
    expect(h.proposals.reconcile()).toBeNull();
    expect(loadDreamState(file)).toEqual(moved);
    expect(existsSync(h.file)).toBe(false);
    expect(h.notifier.resolved).toEqual([{ id: notificationId, by: 'owner:accepted' }]);
  });

  it('integrity is checked before a record is shown or decided: duplicate writes or a forged cursor refuse with nothing recorded', async () => {
    const h = proposalHarness(twoChapters);
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const record = h.stored();
    const { id } = h.proposals.review()!;
    const plan = record['plan'] as { writes: unknown[] };
    h.store({ ...record, plan: { ...plan, writes: [plan.writes[0], plan.writes[0]] } });
    expect(() => h.proposals.review()).toThrowError(/malformed/);
    expect(() => h.proposals.accept(id)).toThrowError(/malformed/);
    expect(h.stored()['decision']).toBeNull();
    h.store({ ...record, nextState: { ...(record['nextState'] as object), coveredThroughSeq: 1000 } });
    expect(() => h.proposals.reject(id)).toThrowError(/malformed \(nextState cursor\)/);
    expect(cursor(h.bible)).toBe(0);
    expect(h.stored()['decision']).toBeNull();
  });

  it('the review is derived from what Accept writes — exactly the planned text, nothing stored beside it', async () => {
    const h = proposalHarness();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const record = h.stored();
    expect(record['plan']).not.toHaveProperty('changes');
    const write = (record['plan'] as { writes: { text: string }[] }).writes[0]!;
    const review = h.proposals.review()!;
    expect(write.text).toContain(review.chapters[0]!.added[0]!.body);
  });

  it('a bounded replay keeps its tail: two replayed entries, one per pass, Accept then Reject, cursor never rewinds', async () => {
    const h = proposalHarness();
    const e1 = h.journal.append({ kind: 'finding', source: 'gru', body: 'first' });
    const e2 = h.journal.append({ kind: 'finding', source: 'gru', body: 'second' });
    await h.engine.run(); // one proposal for both entries
    const file = join(h.bible.dir, DREAM_STATE_FILE);
    saveDreamState(file, { ...loadDreamState(file), coveredThroughSeq: 50 }); // the cursor moved elsewhere
    const oneAtATime = new DreamEngine({ journal: h.journal, bible: h.bible, distiller: h.distiller, proposals: h.proposals, maxEntriesPerDream: 1 });
    expect((await oneAtATime.run()).status).toBe('proposed'); // the stale one is withdrawn, e1 replayed
    expect(h.distiller.calls.at(-1)!.entries.map((entry) => entry.id)).toEqual([e1.id]);
    h.proposals.accept(h.proposals.review()!.id);
    expect(loadDreamState(file)).toMatchObject({ coveredThroughSeq: 50, replay: [{ afterSeq: e1.seq, throughSeq: e2.seq }] });
    const before = h.bible.readChapter('ops-restarts');
    expect((await oneAtATime.run()).status).toBe('proposed');
    expect(h.distiller.calls.at(-1)!.entries.map((entry) => entry.id)).toEqual([e2.id]);
    h.proposals.reject(h.proposals.review()!.id);
    expect(h.bible.readChapter('ops-restarts')).toEqual(before);
    expect(loadDreamState(file).coveredThroughSeq).toBe(50);
    expect(loadDreamState(file).replay).toBeUndefined();
    expect((await oneAtATime.run()).status).toBe('noop');
  });

  it('production notifier: the proposal is one owner-held For You row; deciding resolves it; withdrawal posts an FYI', async () => {
    const root = tmpDir('gru-command-proposal-ledger-');
    const db = new LedgerDb(root);
    try {
      const bus = new EventBus();
      const ledger = new LedgerApi(db.handle, { bus });
      const notifications = new NotificationCenter({ ledger, bus });
      const journal = new JournalStore(join(root, 'journal'));
      const bible = new BibleStore(join(root, 'bible'));
      const proposals = new LessonProposals({ bible, notifier: lessonProposalNotifier({ notifications, ledger }) });
      const engine = new DreamEngine({ journal, bible, distiller: new FakeDistiller(), proposals });
      journal.append({ kind: 'finding', source: 'gru', body: 'first' });
      await engine.run();
      await engine.run(); // re-ensures; never a second row
      const { id, notificationId } = proposals.review()!;
      const rows = () => ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === 'lessons.proposal');
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ id: notificationId, routing: 'needs-owner', resolvedAt: null });
      proposals.accept(id);
      expect(ledger.getNotification(notificationId)?.resolvedBy).toBe('owner:accepted');

      journal.append({ kind: 'finding', source: 'gru', body: 'second' });
      await engine.run();
      const second = proposals.review()!;
      writeFileSync(join(bible.dir, 'INDEX.md'), `${bible.readIndexText() ?? ''}\n`);
      expect(() => proposals.reject(second.id)).toThrowError(expect.objectContaining({ code: 'stale' }));
      expect(ledger.getNotification(second.notificationId)?.resolvedBy).toBe('stale');
      expect(ledger.getNotification(`lessons-proposal-withdrawn:${second.id}`)).toMatchObject({ routing: 'fyi' });
    } finally {
      db.close();
    }
  });
  describe('third review round of #254 (bmad-code-review, 2026-10-07)', () => {
    const stateFile = (bible: BibleStore) => join(bible.dir, DREAM_STATE_FILE);
    const at = '2026-10-07T12:00:00.000Z';

    it('replay ranges stay disjoint: rejecting the first never re-proposes entries consumed between them', async () => {
      const h = proposalHarness();
      h.bible.ensureSeeded();
      for (let seq = 1; seq <= 45; seq += 1) h.journal.append({ kind: 'finding', source: 'gru', body: `finding ${seq}` });
      saveDreamState(stateFile(h.bible), { version: 1, coveredThroughSeq: 45, lastDreamAt: null, cycles: 3, replay: [{ afterSeq: 0, throughSeq: 1 }, { afterSeq: 40, throughSeq: 45 }] });
      expect((await h.engine.run()).status).toBe('proposed');
      expect(h.distiller.calls.at(-1)!.entries.map((entry) => entry.seq)).toEqual([1]);
      h.proposals.reject(h.proposals.review()!.id);
      expect(loadDreamState(stateFile(h.bible)).replay).toEqual([{ afterSeq: 40, throughSeq: 45 }]);
      expect((await h.engine.run()).status).toBe('proposed');
      expect(h.distiller.calls.at(-1)!.entries.map((entry) => entry.seq)).toEqual([41, 42, 43, 44, 45]);
      // Only ranges that overlap or touch are joined; the single-range format still reads.
      expect(coalesceReplay([{ afterSeq: 40, throughSeq: 45 }, { afterSeq: 0, throughSeq: 1 }])).toEqual([{ afterSeq: 0, throughSeq: 1 }, { afterSeq: 40, throughSeq: 45 }]);
      expect(coalesceReplay([{ afterSeq: 0, throughSeq: 1 }, { afterSeq: 1, throughSeq: 3 }])).toEqual([{ afterSeq: 0, throughSeq: 3 }]);
      writeFileSync(stateFile(h.bible), JSON.stringify({ version: 1, coveredThroughSeq: 9, lastDreamAt: null, cycles: 1, replay: { afterSeq: 2, throughSeq: 4 } }));
      expect(loadDreamState(stateFile(h.bible)).replay).toEqual([{ afterSeq: 2, throughSeq: 4 }]);
    });

    it('an exhausted replay range is dropped and new entries are proposed in the same pass', async () => {
      const h = proposalHarness();
      h.bible.ensureSeeded();
      for (let seq = 1; seq <= 3; seq += 1) h.journal.append({ kind: 'finding', source: 'gru', body: `finding ${seq}` });
      saveDreamState(stateFile(h.bible), { version: 1, coveredThroughSeq: 3, lastDreamAt: null, cycles: 1, replay: [{ afterSeq: 10, throughSeq: 12 }] });
      const fresh = h.journal.append({ kind: 'finding', source: 'gru', body: 'new work' });
      expect((await h.engine.run()).status).toBe('proposed');
      expect(h.distiller.calls.at(-1)!.entries.map((entry) => entry.id)).toEqual([fresh.id]);
      expect(loadDreamState(stateFile(h.bible)).replay).toBeUndefined();
    });

    it('once the decision is committed, recovery is cleanup only — a later legitimate book edit is no conflict', async () => {
      const h = proposalHarness();
      h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
      await h.engine.run();
      const { id, notificationId } = h.proposals.review()!;
      h.notifier.failResolve = 1; // the crash lands right after the book and cursor are durable
      expect(() => h.proposals.accept(id)).toThrowError(expect.objectContaining({ code: 'incomplete' }));
      const edited = `${readFileSync(join(h.bible.chaptersDir, 'ops-restarts.md'), 'utf-8')}\nA later, legitimate edit.\n`;
      writeFileSync(join(h.bible.chaptersDir, 'ops-restarts.md'), edited);
      expect(h.proposals.reconcile()).toBeNull();
      expect(h.notifier.conflicts.size).toBe(0);
      expect(readFileSync(join(h.bible.chaptersDir, 'ops-restarts.md'), 'utf-8')).toBe(edited);
      expect(h.notifier.resolved).toEqual([{ id: notificationId, by: 'owner:accepted' }]);
      expect(existsSync(h.file)).toBe(false);
    });

    it('a malformed timestamp in a stored proposal is refused before review or decision — nothing changes', async () => {
      const h = proposalHarness();
      h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
      await h.engine.run();
      const record = h.stored();
      const { id } = h.proposals.review()!;
      const before = book(h.bible);
      h.store({ ...record, nextState: { ...(record['nextState'] as object), lastDreamAt: 'invalid' } });
      expect(() => h.proposals.review()).toThrowError(/malformed/);
      expect(() => h.proposals.accept(id)).toThrowError(/malformed/);
      expect(h.stored()['decision']).toBeNull();
      expect(book(h.bible)).toEqual(before);
      expect(cursor(h.bible)).toBe(0);
      writeFileSync(stateFile(h.bible), JSON.stringify({ version: 1, coveredThroughSeq: 0, lastDreamAt: 'invalid', cycles: 0 }));
      expect(() => loadDreamState(stateFile(h.bible))).toThrowError(/invalid lastDreamAt/);
    });

    it('a dream state that changed only its schedule timestamp is a changed state — before and after a decision', async () => {
      const h = proposalHarness();
      h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
      await h.engine.run();
      const pending = h.proposals.review()!;
      saveDreamState(stateFile(h.bible), { ...loadDreamState(stateFile(h.bible)), lastDreamAt: at });
      expect(() => h.proposals.accept(pending.id)).toThrowError(expect.objectContaining({ code: 'stale' }));

      h.journal.append({ kind: 'finding', source: 'gru', body: 'second finding' });
      await h.engine.run();
      const second = h.stored();
      h.store({ ...second, decision: { kind: 'rejected', at, detail: null } });
      saveDreamState(stateFile(h.bible), { ...loadDreamState(stateFile(h.bible)), lastDreamAt: '2026-10-08T00:00:00.000Z' });
      expect(h.proposals.reconcile()?.id).toBe(second['id']);
      expect(h.stored()['recovery']).toMatchObject({ conflict: expect.stringContaining('dream cursor state changed') });
    });

    it('a recorded Reject meets a changed book with a conflict, and finishes once the book is restored', async () => {
      const h = proposalHarness();
      h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
      await h.engine.run();
      h.store({ ...h.stored(), decision: { kind: 'rejected', at, detail: null } });
      const index = h.bible.readIndexText()!;
      writeFileSync(join(h.bible.dir, 'INDEX.md'), `${index}\n`);
      expect(h.proposals.reconcile()).not.toBeNull();
      expect(cursor(h.bible)).toBe(0);
      expect(h.stored()).toMatchObject({ decision: { kind: 'rejected' }, recovery: { conflict: expect.stringContaining('changed since this proposal was rejected') } });
      writeFileSync(join(h.bible.dir, 'INDEX.md'), index);
      expect(h.proposals.reconcile()).toBeNull();
      expect(cursor(h.bible)).toBe(1);
    });

    it('a cursor conflict names the state file and both expected states; the label follows the recorded decision', async () => {
      for (const kind of ['accepted', 'rejected'] as const) {
        const h = proposalHarness();
        h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
        await h.engine.run();
        const record = h.stored();
        h.store({ ...record, decision: { kind, at, detail: null } });
        saveDreamState(stateFile(h.bible), { ...loadDreamState(stateFile(h.bible)), coveredThroughSeq: 99 });
        expect(h.proposals.reconcile()).not.toBeNull();
        const notice = h.notifier.conflicts.get(`lessons-proposal-conflict:${String(record['id'])}`)!;
        const label = kind === 'accepted' ? 'Accept' : 'Reject';
        expect(notice.title).toContain(`Your ${label} of the lesson proposal could not finish`);
        expect(notice.detail).toContain(stateFile(h.bible));
        expect(notice.detail).toContain(JSON.stringify(record['fromState']));
        expect(notice.detail).toContain(JSON.stringify(record['nextState']));
        expect(notice.detail).toContain(`press ${label} again`);
        expect(notice.detail).not.toContain('plan.writes');
      }
    });

    it('the conflict notice always says what blocks NOW — refreshed in place through the real notifier and ledger', async () => {
      const root = tmpDir('gru-command-conflict-refresh-');
      const db = new LedgerDb(root);
      try {
        const bus = new EventBus();
        const ledger = new LedgerApi(db.handle, { bus });
        const notifications = new NotificationCenter({ ledger, bus });
        const journal = new JournalStore(join(root, 'journal'));
        const bible = new BibleStore(join(root, 'bible'));
        const proposals = new LessonProposals({ bible, notifier: lessonProposalNotifier({ notifications, ledger }) });
        const engine = new DreamEngine({ journal, bible, distiller: new FakeDistiller(), proposals });
        journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
        await engine.run();
        const file = join(bible.dir, PROPOSAL_FILE);
        const record = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
        writeFileSync(file, JSON.stringify({ ...record, decision: { kind: 'accepted', at, detail: null } }));
        const index = bible.readIndexText()!;
        writeFileSync(join(bible.dir, 'INDEX.md'), `${index}\n`);
        expect(proposals.reconcile()).not.toBeNull();
        const id = `lessons-proposal-conflict:${String(record['id'])}`;
        expect(ledger.getNotification(id)?.detail).toContain('INDEX.md changed');
        // INDEX restored, a chapter edited instead: the same notice, the new cause.
        writeFileSync(join(bible.dir, 'INDEX.md'), index);
        writeFileSync(join(bible.chaptersDir, 'ops-restarts.md'), '# Foreign\n');
        expect(proposals.reconcile()).not.toBeNull();
        const refreshed = ledger.getNotification(id)!;
        expect(refreshed.detail).toContain('chapters/ops-restarts.md');
        expect(refreshed.detail).not.toContain('INDEX.md changed');
        expect(refreshed).toMatchObject({ routing: 'needs-owner', resolvedAt: null });
        expect(ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === 'lessons.proposal-conflict')).toHaveLength(1);
      } finally {
        db.close();
      }
    });

    it('a partial Accept blocked by an edit to an UNTOUCHED chapter names it, changes nothing, and finishes once restored', async () => {
      const h = proposalHarness(twoChapters);
      h.bible.ensureSeeded();
      h.bible.applyUpdates(
        [{ slug: 'model-policy', title: 'Model policy', summary: 'Which model does what.', tags: ['models'], lessons: [{ slug: 'sol', body: 'Silas runs on Sol.', journalIds: ['j-0'] }] }],
        new Map([['j-0', at]]),
      );
      h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
      await h.engine.run();
      const record = h.stored();
      const plan = record['plan'] as { writes: { slug: string; text: string }[] };
      // Crash mid-Accept: the decision is recorded and the first chapter written.
      h.store({ ...record, decision: { kind: 'accepted', at, detail: null } });
      writeFileSync(join(h.bible.chaptersDir, `${plan.writes[0]!.slug}.md`), plan.writes[0]!.text);
      const untouched = join(h.bible.chaptersDir, 'model-policy.md');
      const original = readFileSync(untouched, 'utf-8');
      writeFileSync(untouched, `${original}\nAn unrelated edit.\n`);
      const partial = book(h.bible);
      expect(h.proposals.reconcile()).not.toBeNull();
      expect(h.stored()['recovery']).toMatchObject({ conflict: expect.stringContaining('chapters/model-policy.md changed') });
      expect(book(h.bible)).toEqual(partial);
      expect(cursor(h.bible)).toBe(0);
      expect(h.stored()['decision']).toMatchObject({ kind: 'accepted' });
      writeFileSync(untouched, original);
      expect(h.proposals.reconcile()).toBeNull();
      expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.recurred).toBe(1);
      expect(h.bible.readChapter('review-rounds')?.lessons[0]?.recurred).toBe(1);
      expect(cursor(h.bible)).toBe(1);
    });
  });
});
