import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Role, type RuntimeId } from '../src/config.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import type { AgentHandle, AgentRuntime, AgentState, RuntimeEvent, RuntimeEventListener, SpawnOptions } from '../src/runtime/types.js';
import type { SessionStore } from '../src/sessions/store.js';
import { BACKGROUND_PROCESS_RULE, WORKER_RULE_BLOCKS, appendWorkerRules } from '../src/dispatch/worker-rules.js';
import {
  LANE_JOB_ENV, LANE_TOKEN_ENV, elapsedSeconds, isLaneToken, laneProvenanceEnv, newLaneToken, readLaneTokens, readProcessFacts,
} from '../src/worktrees/lane-provenance.js';
import type { PausedProcess, SweepRequest, SweepResult } from '../src/worktrees/manager.js';
import { STOP_AND_SWEEP_OPTION, sweepPausedCard, sweepPausedCardOf, sweepPausedKind, sweepPausedSummary } from '../src/worktrees/sweep-card.js';
import { postSweepPausedCard, SweepDecisionFollower, withdrawSweptLaneCards } from '../src/worktrees/sweep-decisions.js';

/**
 * Lane provenance (#486): the token every lane session passes to what it
 * starts, how GC reads it back, the registry's "lane quiet" signal, and the
 * owner's card for what is left.
 */

const cleanupDirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
});
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** A long-lived node process (its environment is readable on Linux and on
 * macOS, where node is not a system binary). */
function sleeper(env: NodeJS.ProcessEnv): ChildProcess & { pid: number } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env, stdio: 'ignore' });
  children.push(child);
  return child as ChildProcess & { pid: number };
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[LANE_TOKEN_ENV];
  delete env[LANE_JOB_ENV];
  return env;
}

describe('the lane token and its variables', () => {
  it('is 128 random bits in hex, and the variables name the token and, when there is one, the job', () => {
    const token = newLaneToken();
    expect(isLaneToken(token)).toBe(true);
    expect(newLaneToken()).not.toBe(token);
    expect(laneProvenanceEnv({ laneId: 'job-a', jobId: 'job-a', token })).toEqual({ GRU_LANE_TOKEN: token, GRU_LANE_JOB: 'job-a' });
    expect(laneProvenanceEnv({ laneId: 'round-1', jobId: null, token })).toEqual({ GRU_LANE_TOKEN: token });
    expect(() => laneProvenanceEnv({ laneId: 'job-a', jobId: 'job-a', token: 'not-a-token' })).toThrow(/no valid lane token/u);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('reads back the token a live process carries, and none from one that carries none', async () => {
    const token = newLaneToken();
    const carrying = sleeper({ ...cleanEnv(), [LANE_TOKEN_ENV]: token });
    const plain = sleeper(cleanEnv());
    const command = `${process.execPath} -e setTimeout(() => {}, 60000)`;
    await vi.waitFor(async () => {
      const reads = await readLaneTokens([{ pid: carrying.pid, command }, { pid: plain.pid, command }]);
      expect(reads.get(carrying.pid)).toEqual({ readable: true, token });
      expect(reads.get(plain.pid)).toEqual({ readable: true, token: null });
    }, { timeout: 5_000 });
  });

  it.runIf(process.platform === 'darwin')('on macOS, a pid whose command line is no longer the listed one reads as unreadable (a recycled pid never matches)', async () => {
    const token = newLaneToken();
    const carrying = sleeper({ ...cleanEnv(), [LANE_TOKEN_ENV]: token });
    await vi.waitFor(async () => {
      const reads = await readLaneTokens([{ pid: carrying.pid, command: 'some other program --flag' }]);
      expect(reads.get(carrying.pid)).toEqual({ readable: false });
    }, { timeout: 5_000 });
  });

  it('names a process by its executable and dates its start from its elapsed time', async () => {
    expect(elapsedSeconds('05')).toBeNull();
    expect(elapsedSeconds('01:05')).toBe(65);
    expect(elapsedSeconds('02:01:05')).toBe(7_265);
    expect(elapsedSeconds('3-02:01:05')).toBe(266_465);
    const child = sleeper(cleanEnv());
    const now = Date.now();
    await vi.waitFor(async () => {
      const fact = (await readProcessFacts([child.pid], now)).get(child.pid);
      expect(fact?.name).toMatch(/node/u);
      expect(Math.abs(Date.parse(fact?.startedAt ?? '') - now)).toBeLessThan(120_000);
    }, { timeout: 5_000 });
  });
});

describe('the worker rule blocks', () => {
  it('tell every minion to stop what it starts before its turn ends', () => {
    expect(WORKER_RULE_BLOCKS).toContain(BACKGROUND_PROCESS_RULE);
    expect(appendWorkerRules('brief')).toContain('`agent-browser close`');
  });
});

// ------------------------------------------------------------------
// The registry: lane provenance at spawn, and the lane-quiet signal.
// ------------------------------------------------------------------

const caps = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

interface FakeSession {
  state: AgentState;
  release: () => void;
  emit: (event: RuntimeEvent) => void;
}

function registryHarness() {
  const dir = tmp('gru-486-registry-');
  const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 8 } };
  const spawned: SpawnOptions[] = [];
  const sessions = new Map<string, FakeSession>();
  const quiet: string[] = [];
  let next = 0;
  const adapter = (id: RuntimeId): AgentRuntime => ({
    id, capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
    spawn: async (role: Role, opts: SpawnOptions = {}): Promise<AgentHandle> => {
      spawned.push(opts);
      const agentId = `worker-${String(++next)}`;
      const listeners = new Set<RuntimeEventListener>();
      const session: FakeSession = {
        state: 'idle',
        release: () => {},
        emit: (event) => { for (const listener of listeners) listener(event); },
      };
      sessions.set(agentId, session);
      return {
        id: agentId, role, sessionFile: `${dir}/${agentId}.jsonl`, capabilities: caps,
        health: () => ({ state: session.state, lastActivity: null, sessionFile: `${dir}/${agentId}.jsonl` }),
        cessationEvidence: () => (session.state === 'disposed' ? 'ceased' : 'unknown'),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        // A turn streams until the test releases it.
        prompt: () => new Promise<void>((resolve) => {
          session.state = 'streaming';
          session.release = () => { session.state = 'idle'; resolve(); };
        }),
        steer: async () => {}, followUp: async () => {},
        hasLiveProcess: () => false, isCompacting: () => false,
        dispose: async () => {
          session.state = 'disposed';
          session.emit({ type: 'state', state: 'disposed' });
          session.emit({ type: 'cessation_evidence', evidence: 'ceased' });
        },
      };
    },
  });
  const pi = adapter('pi');
  class TestRegistry extends RuntimeRegistry {
    override runtimeIdFor(): RuntimeId { return 'pi'; }
    override runtimeFor(): AgentRuntime { return pi; }
  }
  const lanes = new Map([[join(dir, 'lane-a'), { laneId: 'job-a', jobId: 'job-a', token: 'a'.repeat(32) }]]);
  const registry = new TestRegistry({
    config, store: {} as SessionStore,
    laneProvenanceFor: (cwd) => lanes.get(cwd) ?? null,
    onLaneQuiet: (laneId) => quiet.push(laneId),
  });
  return { registry, spawned, sessions, quiet, laneA: join(dir, 'lane-a'), other: join(dir, 'elsewhere') };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('the registry and the lane a session runs in', () => {
  it('hands a session spawned in a registered lane that lane\'s provenance, and none to a session elsewhere', async () => {
    const h = registryHarness();
    const inLane = await h.registry.spawn('minion', { cwd: h.laneA });
    const elsewhere = await h.registry.spawn('minion', { cwd: h.other });
    expect(h.spawned.map((opts) => opts.laneProvenance ?? null)).toEqual([{ laneId: 'job-a', jobId: 'job-a', token: 'a'.repeat(32) }, null]);
    await inLane.dispose();
    await elsewhere.dispose();
  });

  it('says a lane is quiet only once every session on it has settled its turn, and again when one is disposed', async () => {
    const h = registryHarness();
    const first = await h.registry.spawn('minion', { cwd: h.laneA });
    const second = await h.registry.spawn('minion', { cwd: h.laneA });
    const elsewhere = await h.registry.spawn('minion', { cwd: h.other });
    const firstTurn = first.prompt('work');
    const secondTurn = second.prompt('work');
    const elsewhereTurn = elsewhere.prompt('work');
    expect(h.registry.laneQuiet('job-a')).toBe(false);
    h.sessions.get(first.id)!.release();
    await firstTurn;
    await settle();
    // The second session's turn still streams in the lane: its processes may
    // carry the token, so nothing is reaped yet.
    expect(h.quiet).toEqual([]);
    expect(h.registry.laneQuiet('job-a')).toBe(false);
    h.sessions.get(elsewhere.id)!.release();
    await elsewhereTurn;
    await settle();
    expect(h.quiet).toEqual([]);
    h.sessions.get(second.id)!.release();
    await secondTurn;
    await settle();
    expect(h.quiet).toEqual(['job-a']);
    expect(h.registry.laneQuiet('job-a')).toBe(true);
    await first.dispose();
    expect(h.quiet).toEqual(['job-a', 'job-a']);
    await second.dispose();
    await elsewhere.dispose();
  });
});

// ------------------------------------------------------------------
// The owner's card and the follow-through of its answer.
// ------------------------------------------------------------------

function ledgerHarness() {
  const db = new LedgerDb(tmp('gru-486-ledger-'));
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  ledger.addJob({ id: 'job-b', repo: 'repo', title: 'browser checks' });
  const lane = ledger.registerWorktree({ id: 'job-b', kind: 'job', repoPath: '/repos/repo', repoName: 'repo', path: '/lanes/repo/job-b', branch: 'gru/job-b', sha: 'a'.repeat(40), jobId: 'job-b' });
  return { db, bus, ledger, notifications, lane };
}

function paused(pid: number, name: string, provenance: PausedProcess['provenance'], startedAt: string, otherLane: string | null = null): PausedProcess {
  return { pid, command: `${name} --flag`, name, startedAt, cwd: '/lanes/repo/job-b', provenance, otherLane };
}

describe('the owner\'s card for a paused sweep', () => {
  const details: PausedProcess[] = [
    paused(65215, 'agent-browser', 'no-token', '2026-10-23T03:10:12Z'),
    ...[79503, 79510, 79511].map((pid, index) => paused(pid, 'Google Chrome Helper', 'unreadable', `2026-10-23T03:1${String(index)}:00Z`)),
    paused(81000, 'vite', 'other-lane', '2026-10-23T03:13:00Z', 'job-c'),
  ];

  it('names each kind of process, its pids, start times and working directory, and why GC did not stop it', () => {
    const h = ledgerHarness();
    try {
      const card = sweepPausedCard(h.lane, details);
      expect(sweepPausedSummary(details)).toBe('Google Chrome Helper ×3 + agent-browser + vite');
      expect(card.title).toBe('Worktree sweep paused: 5 processes still running in repo');
      expect(card.detail).toContain('- agent-browser ×1 (pid 65215; started 2026-10-23T03:10:12Z; working directory /lanes/repo/job-b): carries no lane token');
      expect(card.detail).toContain('- Google Chrome Helper ×3 (pids 79503, 79510, 79511; started 2026-10-23T03:10:00Z to 2026-10-23T03:12:00Z;');
      expect(card.detail).toContain('GC cannot read its environment');
      expect(card.detail).toContain('carries the token of lane job-c');
      expect(card.decision.options).toEqual([expect.objectContaining({ id: STOP_AND_SWEEP_OPTION, label: 'Stop these 5 processes and finish the sweep' })]);
      expect(card.decision.reservedClass).toBe('destructive');
    } finally { h.db.close(); }
  });

  it('is named by its lane and pause, and a newer pause or the sweep withdraws an unanswered one', () => {
    const h = ledgerHarness();
    try {
      expect(sweepPausedCardOf(sweepPausedKind('job-b', 'p1'))).toEqual({ laneId: 'job-b', pauseId: 'p1' });
      expect(sweepPausedCardOf('worktree-sweep-paused')).toBeNull();
      const first = postSweepPausedCard(h, { worktree: h.lane, pauseId: 'p1', details });
      expect(first.routing).toBe('needs-owner');
      expect(first.id).toBe('worktree-sweep-paused:job-b:p1');
      const second = postSweepPausedCard(h, { worktree: h.lane, pauseId: 'p2', details });
      expect(h.ledger.getNotification(first.id)?.resolvedBy).toBe('producer-withdrawn');
      expect(h.ledger.getNotification(second.id)?.resolvedAt).toBeNull();
      withdrawSweptLaneCards(h, 'job-b');
      expect(h.ledger.getNotification(second.id)?.resolvedBy).toBe('producer-withdrawn');
    } finally { h.db.close(); }
  });

  it('carries out "stop these processes" as a confirmed kill of exactly the pids that card named, then closes the card', async () => {
    const h = ledgerHarness();
    const releases: SweepRequest[] = [];
    const follower = new SweepDecisionFollower({
      ledger: h.ledger,
      bus: h.bus,
      release: async (input): Promise<SweepResult> => {
        releases.push(input);
        return { status: 'swept', preserved: null, branch: 'deleted', freshHead: 'b'.repeat(40) };
      },
    });
    try {
      h.ledger.setWorktreeStatus('job-b', 'paused', 'sweep paused');
      h.ledger.appendCustomEvent({ kind: 'worktree.paused', jobId: 'job-b', payload: { id: 'job-b', path: h.lane.path, pause_id: 'p1', processes: [{ pid: 65215 }, { pid: 79503 }] } });
      const card = postSweepPausedCard(h, { worktree: h.lane, pauseId: 'p1', details });
      follower.start();
      h.notifications.decide(card.id, STOP_AND_SWEEP_OPTION, 'owner');
      await vi.waitFor(() => expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull());
      expect(releases).toEqual([{ worktreeId: 'job-b', confirmKill: true, confirmKillPids: [65215, 79503] }]);
      const resolved = h.ledger.listEvents({ limit: 50 }).find((event) => event.kind === 'notification.resolved' && (event.payload as { id?: string }).id === card.id);
      expect(resolved?.payload).toMatchObject({ detail: 'stopped the processes and swept lane job-b', owner_decision: STOP_AND_SWEEP_OPTION });
    } finally { follower.stop(); h.db.close(); }
  });

  it('stops nothing for a lane that is no longer paused, and closes the card saying so', async () => {
    const h = ledgerHarness();
    const release = vi.fn<(input: SweepRequest) => Promise<SweepResult>>();
    const follower = new SweepDecisionFollower({ ledger: h.ledger, bus: h.bus, release });
    try {
      h.ledger.appendCustomEvent({ kind: 'worktree.paused', jobId: 'job-b', payload: { id: 'job-b', path: h.lane.path, pause_id: 'p1', processes: [{ pid: 65215 }] } });
      const card = postSweepPausedCard(h, { worktree: h.lane, pauseId: 'p1', details });
      h.notifications.decide(card.id, STOP_AND_SWEEP_OPTION, 'owner');
      // An answer recorded before the follower started (a restart) is carried out at start.
      follower.start();
      await vi.waitFor(() => expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull());
      expect(release).not.toHaveBeenCalled();
    } finally { follower.stop(); h.db.close(); }
  });
});
