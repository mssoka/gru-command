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
  loadDreamState,
  PROPOSAL_FILE,
  repairCommand,
  saveDreamState,
  type DreamDistiller,
  type DistillInput,
  type DistillResult,
  type DreamOutcome,
  type ProposalNotifier,
} from '../src/lessons/dream.js';
import { DREAM_PROMPT_BODY_CLAMP, parseDreamOutput, renderDreamPrompt } from '../src/lessons/distiller.js';
import { JournalStore } from '../src/lessons/journal.js';
import { DreamError, ProposalError, type JournalEntry, type ProposedChapter } from '../src/lessons/types.js';

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
  class FakeNotifier implements ProposalNotifier {
    readonly posted: { title: string; detail: string }[] = [];
    readonly resolved: { id: string; by: string }[] = [];
    readonly staleNotices: { title: string; detail: string }[] = [];
    proposed(input: { title: string; detail: string }): string {
      this.posted.push(input);
      return `notice-${this.posted.length}`;
    }
    resolve(id: string, by: string): void {
      this.resolved.push({ id, by });
    }
    stale(input: { title: string; detail: string }): void {
      this.staleNotices.push(input);
    }
  }

  function proposalHarness() {
    const root = tmpDir('gru-command-proposals-');
    const journal = new JournalStore(join(root, 'journal'));
    const bible = new BibleStore(join(root, 'bible'));
    const distiller = new FakeDistiller();
    const notifier = new FakeNotifier();
    const proposals = new LessonProposals({ bible, notifier });
    const engine = new DreamEngine({ journal, bible, distiller, proposals });
    return { journal, bible, distiller, notifier, proposals, engine };
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

  it('needs exactly one write path: owner proposals or explicit autoApply', () => {
    const h = proposalHarness();
    expect(() => new DreamEngine({ journal: h.journal, bible: h.bible, distiller: h.distiller })).toThrowError(
      /exactly one write path/,
    );
    expect(
      () => new DreamEngine({ journal: h.journal, bible: h.bible, distiller: h.distiller, proposals: h.proposals, autoApply: true }),
    ).toThrowError(/exactly one write path/);
  });

  it('a pass proposes: the book and the cursor are untouched and the owner is asked once', async () => {
    const h = proposalHarness();
    h.bible.ensureSeeded();
    const before = book(h.bible);
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    const outcome = await h.engine.run();
    expect(outcome).toMatchObject({ status: 'proposed', entries: 1, coveredThroughSeq: 0, lessonsAdded: 1 });
    expect(book(h.bible)).toEqual(before);
    expect(cursor(h.bible)).toBe(0);
    expect(h.notifier.posted).toEqual([
      {
        title: 'Book of Lessons: 1 lesson change proposed',
        detail: 'From 1 journal entry: 1 new, 0 updated across 1 chapter(s) (ops-restarts). Review the changes, then Accept or Reject.',
      },
    ]);
    const review = h.proposals.review()!;
    expect(review).toMatchObject({ notificationId: 'notice-1', entries: 1, throughSeq: 1 });
    expect(review.chapters).toEqual([
      expect.objectContaining({
        slug: 'ops-restarts',
        retired: false,
        added: [{ slug: 'shell-hang', body: 'the one durable lesson', recurred: 1, previousBody: null }],
        changed: [],
      }),
    ]);
  });

  it('while a proposal waits, a beat neither distills nor proposes again — and re-posts a lost notice', async () => {
    const h = proposalHarness();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'first' });
    await h.engine.run();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'second' });
    const waiting = await h.engine.run();
    expect(waiting.status).toBe('awaiting-owner');
    expect(h.distiller.calls).toHaveLength(1);
    expect(h.notifier.posted).toHaveLength(1);

    // A crash between persisting and posting leaves notificationId null.
    const file = join(h.bible.dir, PROPOSAL_FILE);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), notificationId: null }));
    await h.engine.run();
    expect(h.notifier.posted).toHaveLength(2);
    expect(h.proposals.review()!.notificationId).toBe('notice-2');
    expect(h.distiller.calls).toHaveLength(1);
  });

  it('Accept writes the planned update, advances the cursor and resolves the notice', async () => {
    const h = proposalHarness();
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const id = h.proposals.review()!.id;
    const decision = h.proposals.accept(id);
    expect(decision).toMatchObject({ id, decision: 'accepted', coveredThroughSeq: entry.seq });
    expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.provenance).toEqual([{ id: entry.id, ts: entry.ts }]);
    expect(cursor(h.bible)).toBe(entry.seq);
    expect(h.notifier.resolved).toEqual([{ id: 'notice-1', by: 'owner:accepted' }]);
    expect(h.proposals.pending()).toBeNull();
    expect((await h.engine.run()).status).toBe('noop');
  });

  it('Reject leaves the book untouched and consumes the batch: it is never proposed again', async () => {
    const h = proposalHarness();
    h.bible.ensureSeeded();
    const before = book(h.bible);
    const entry = h.journal.append({ kind: 'finding', source: 'gru', body: 'not worth keeping' });
    await h.engine.run();
    const decision = h.proposals.reject(h.proposals.review()!.id);
    expect(decision).toMatchObject({ decision: 'rejected', coveredThroughSeq: entry.seq, report: null });
    expect(book(h.bible)).toEqual(before);
    expect(cursor(h.bible)).toBe(entry.seq);
    expect(h.notifier.resolved).toEqual([{ id: 'notice-1', by: 'owner:rejected' }]);
    expect((await h.engine.run()).status).toBe('noop');
    expect(h.distiller.calls).toHaveLength(1);
  });

  it('a book that moved makes Accept stale: nothing written, cursor kept, owner told, next pass re-proposes', async () => {
    const h = proposalHarness();
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    const id = h.proposals.review()!.id;
    // Someone changed the book after the proposal was planned.
    writeFileSync(join(h.bible.dir, 'INDEX.md'), `${h.bible.readIndexText() ?? ''}\n`);
    const moved = book(h.bible);
    expect(() => h.proposals.accept(id)).toThrowError(ProposalError);
    expect(book(h.bible)).toEqual(moved);
    expect(cursor(h.bible)).toBe(0);
    expect(h.proposals.pending()).toBeNull();
    expect(h.notifier.resolved).toEqual([{ id: 'notice-1', by: 'stale' }]);
    expect(h.notifier.staleNotices).toHaveLength(1);
    expect((await h.engine.run()).status).toBe('proposed');
    expect(h.distiller.calls).toHaveLength(2);
  });

  it('a decision for no proposal, or for a different one, fails loud and changes nothing', async () => {
    const h = proposalHarness();
    expect(() => h.proposals.accept('nope')).toThrowError(expect.objectContaining({ code: 'none' }));
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    await h.engine.run();
    expect(() => h.proposals.reject('another-proposal')).toThrowError(expect.objectContaining({ code: 'mismatch' }));
    expect(h.proposals.pending()).not.toBeNull();
    expect(h.notifier.resolved).toEqual([]);
  });
});
