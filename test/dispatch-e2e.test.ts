import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import type { FallbackGateOutcome, WaveOutcome } from '../src/dispatch/perkins.js';

function asWave(outcome: WaveOutcome | FallbackGateOutcome): WaveOutcome {
  if (!('route' in outcome)) return outcome;
  throw new Error(`expected a Perkins wave outcome, got ${outcome.route}`);
}
import { BoardEngine } from '../src/board/engine.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { fakeHybridSpawner } from './helpers/perkins-hybrid-double.js';
import type { AgentCapabilities, AgentHandle, AgentState, PromptOptions, RuntimeEvent, SpawnOptions } from '../src/runtime/types.js';

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};
import type { Role } from '../src/config.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * End-to-end dispatch on a fixture repo (EPICS E8 story 4): briefing →
 * job + worktree + minion rooted in the project (ruling 17) → board arc →
 * PR link → review wave → verdict → release sweep. Generic fixture only.
 */

const PR_URL = 'https://git.example.invalid/fixture-owner/fixture-app/pull/3';

interface FakeHandle extends AgentHandle {
  readonly prompts: { text: string; owner?: string }[];
}

interface DispatchHarness {
  ledger: LedgerApi;
  repo: FixtureRepo;
  worktrees: InMemoryWorktreePort;
  dispatch: DispatchService;
  wave: WaveRunner;
  engine: BoardEngine;
  spawns: { role: Role; options: SpawnOptions }[];
  handles: FakeHandle[];
  poster: { post: ReturnType<typeof vi.fn> };
  cleanup(): void;
}

/** The default minion craft: a stub change COMMITTED inside its assigned
 * worktree — exercising the real git path a dispatched agent uses. */
async function defaultMinionSettle(_text: string, cwd: string): Promise<void> {
  writeFileSync(join(cwd, 'minion-deliverable.txt'), 'stub change delivered\n');
  execFileSync('git', ['-C', cwd, 'add', 'minion-deliverable.txt']);
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'test: deliver minion change'], { stdio: 'ignore' });
}

function makeHandle(id: string, role: Role, settle: (text: string) => Promise<void>): FakeHandle {
  const prompts: { text: string; owner?: string }[] = [];
  const listeners = new Set<(event: RuntimeEvent) => void>();
  return {
    role,
    id,
    sessionFile: null,
    capabilities: FAKE_CAPABILITIES,
    prompts,
    prompt(text: string, options?: PromptOptions) {
      prompts.push({ text, owner: options?.owner });
      return settle(text);
    },
    async steer() {},
    async followUp() {},
    subscribe(listener: (event: RuntimeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    health() {
      return { state: 'idle' as AgentState, lastActivity: new Date().toISOString(), sessionFile: null };
    },
    async dispose() {},
  };
}

function makeDispatchHarness(opts: {
  minionSettle?: (text: string, cwd: string) => Promise<void>;
} = {}): DispatchHarness {
  const repo = makeFixtureRepo('fixture-app');
  const dataDir = mkdtempSync(join(tmpdir(), 'gru-command-e2edata-'));
  const ledgerDb = new LedgerDb(dataDir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(ledgerDb.handle, { bus });
  const engine = new BoardEngine({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(mkdtempSync(join(tmpdir(), 'gru-command-e2ewt-')));
  const spawns: { role: Role; options: SpawnOptions }[] = [];
  const handles: FakeHandle[] = [];
  const reviewSessions = join(dataDir, 'review-sessions');
  mkdirSync(reviewSessions, { recursive: true });
  const hybrid = fakeHybridSpawner(reviewSessions, { childAnswer: () => '[]' });
  let n = 0;
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: options ?? {} });
    if (role === 'perkins') {
      const handle = await hybrid.spawner(role, options);
      engine.onRuntimeEvent({ agentId: handle.id, role, sessionFile: handle.sessionFile, phase: 'spawned' });
      return handle;
    }
    const id = `agent-${++n}`;
    const cwd = options?.cwd ?? '';
    const handle = makeHandle(
      id,
      role,
      role === 'minion'
        ? (text: string) => (opts.minionSettle ?? defaultMinionSettle)(text, cwd)
        : async () => {},
    );
    handles.push(handle);
    engine.onRuntimeEvent({ agentId: handle.id, role, sessionFile: null, phase: 'spawned' });
    return handle;
  };
  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const poster = { post: vi.fn(async () => {}) };
  const wave = new WaveRunner({
    ledger,
    worktrees,
    spawner,
    poster,
    reviewArtifactRoot: join(dataDir, 'reviews'),
  });
  return {
    ledger,
    repo,
    worktrees,
    dispatch,
    wave,
    engine,
    spawns,
    handles,
    poster,
    cleanup(): void {
      ledgerDb.close();
      repo.cleanup();
    },
  };
}

const cleanups: DispatchHarness[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!.cleanup();
});

function harness(opts: Parameters<typeof makeDispatchHarness>[0] = {}): DispatchHarness {
  const h = makeDispatchHarness(opts);
  cleanups.push(h);
  return h;
}

describe('end-to-end dispatch (E8 story 4)', () => {
  it('runs the full heist arc on a fixture repo: briefing → minion on a worktree → board → PR → wave → release', async () => {
    const h = harness();

    // --- Gru authors a briefing; ops hands it off; the minion runs. ---
    const outcome = await h.dispatch.dispatch({
      jobId: 'widget-polish',
      repoPath: h.repo.path,
      title: 'polish the widget',
      briefing: 'Make the widget polish generic and verify it. Acceptance: tests pass.',
    });
    expect(outcome.job.status).toBe('working');
    expect(await outcome.settled).toEqual({ ok: true });

    // Ruling 17: the minion session is ROOTED IN THE PROJECT WORKTREE.
    const minionSpawn = h.spawns.find((spawn) => spawn.role === 'minion');
    expect(minionSpawn?.options.cwd).toBe(outcome.worktree.path);
    // The briefing contract was delivered, shaped for the lane.
    const minion = h.handles.find((handle) => handle.role === 'minion');
    expect(minion?.prompts[0]?.text).toContain('Dispatch briefing — job widget-polish');
    expect(minion?.prompts[0]?.text).toContain('Acceptance: tests pass.');
    expect(minion?.prompts[0]?.text).toContain(outcome.worktree.branch!);

    // The lane: branch-for-jobs, registered through the port.
    expect(outcome.worktree.branch).toBe('gru/widget-polish');
    expect(existsSync(outcome.worktree.path)).toBe(true);

    // The minion's stub change landed in ITS lane checkout.
    expect(existsSync(join(outcome.worktree.path, 'minion-deliverable.txt'))).toBe(true);
    expect(readFileSync(join(outcome.worktree.path, 'minion-deliverable.txt'), 'utf-8')).toBe(
      'stub change delivered\n',
    );

    // --- The board shows the arc (repo-grouped, agent attached). ---
    let snapshot = h.engine.snapshot();
    const group = snapshot.repos.find((r) => r.name === 'fixture-app');
    expect(group?.jobs).toHaveLength(1);
    expect(group?.jobs[0]?.status).toBe('working');
    expect(group?.jobs[0]?.id).toBe('widget-polish');
    const events = h.ledger.listEvents({ limit: 100 });
    expect(events.some((e) => e.kind === 'job.handoff')).toBe(true);
    expect(events.some((e) => e.kind === 'job.minion-spawned')).toBe(true);
    expect(events.some((e) => e.kind === 'job.delivered')).toBe(true);
    const agentRow = h.ledger.getAgent(outcome.agentId);
    expect(agentRow?.jobId).toBe('widget-polish');
    expect(agentRow?.role).toBe('minion');

    // --- The PR link lands; review wave runs; verdict consolidates. ---
    h.dispatch.recordPr('widget-polish', PR_URL);
    expect(h.ledger.getJob('widget-polish')?.prUrl).toBe(PR_URL);
    const waveOutcome = asWave(await h.wave.runRound({ jobId: 'widget-polish' }));
    expect(waveOutcome.verdict).toBe('approved');
    expect(waveOutcome.posted).toBe(true);
    expect(h.poster.post).toHaveBeenCalledWith(expect.objectContaining({ prUrl: PR_URL }));

    snapshot = h.engine.snapshot();
    const jobView = snapshot.repos.find((r) => r.name === 'fixture-app')?.jobs[0];
    expect(jobView?.status).toBe('in-review');
    expect(jobView?.rounds[0]?.verdict).toBe('approved');
    expect(jobView?.rounds[0]?.lenses.every((chip) => chip.state === 'done')).toBe(true);
    // The review ran DETACHED (no branch debris in the repo).
    expect(h.repo.git(['branch', '--list'])).not.toContain('r1');

    // --- Release: preserve-first sweep closes the lane. ---
    const release = await h.dispatch.release('widget-polish');
    expect(release?.status).toBe('swept');
    expect(h.dispatch.worktreesFor('widget-polish').every((lane) => lane.status === 'swept')).toBe(true);
  });

  it('blocks the job loudly when the minion cannot be spawned (no half lanes)', async () => {
    const h = harness();
    // Build a dispatch whose spawner always fails.
    const dataDir = mkdtempSync(join(tmpdir(), 'gru-command-e2efail-'));
    const ledgerDb = new LedgerDb(dataDir);
    const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
    const worktrees = new InMemoryWorktreePort(mkdtempSync(join(tmpdir(), 'gru-command-e2efailwt-')));
    const dispatch = new DispatchService({
      ledger,
      worktrees,
      spawner: async () => {
        throw new Error('runtime down');
      },
    });
    try {
      await expect(
        dispatch.dispatch({
          jobId: 'job-doomed',
          repoPath: h.repo.path,
          title: 'doomed',
          briefing: 'will not start',
        }),
      ).rejects.toThrowError(/runtime down/);
      expect(ledger.getJob('job-doomed')?.status).toBe('blocked');
      // The half-created lane was swept back out through the port.
      expect(worktrees.getWorktree('job-doomed')?.status).toBe('swept');
    } finally {
      ledgerDb.close();
    }
  });

  it('honors the minion\u2019s briefing completion and failure transitions on the record', async () => {
    const failed = harness({
      minionSettle: async () => {
        throw new Error('turn exploded');
      },
    });
    const outcome = await failed.dispatch.dispatch({
      jobId: 'job-fail',
      repoPath: failed.repo.path,
      title: 'will fail',
      briefing: 'attempt the thing',
    });
    const settled = await outcome.settled;
    expect(settled.ok).toBe(false);
    expect(settled.error).toMatch(/turn exploded/);
    const kinds = failed.ledger.listEvents({ limit: 100 }).map((e) => e.kind);
    expect(kinds).toContain('job.minion-error');
  });
});
