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
  LANE_JOB_ENV, LANE_TOKEN_ENV, carriesLaneEnv, elapsedSeconds, isLaneToken, laneProvenanceEnv, laneProvenanceFromLedger, newLaneToken, processName,
  readLaneTokens, readProcessFacts, withoutLaneEnv,
} from '../src/worktrees/lane-provenance.js';
import type { NotificationRecord } from '../src/ledger/api.js';
import type { PausedProcess, SweepRequest, SweepResult } from '../src/worktrees/manager.js';
import { STOP_AND_SWEEP_OPTION, sweepPausedCard, sweepPausedCardOf, sweepPausedKind, sweepPausedSummary } from '../src/worktrees/sweep-card.js';
import { postSweepPausedCard, settleSweptLaneCards, SweepDecisionFollower } from '../src/worktrees/sweep-decisions.js';

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

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('reads back the token a live process carries, and none from one that carries none', async () => {
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

  it.skipIf(process.platform !== 'darwin')('on macOS, a pid whose command line is no longer the listed one reads as unreadable (a recycled pid never matches)', async () => {
    const token = newLaneToken();
    const carrying = sleeper({ ...cleanEnv(), [LANE_TOKEN_ENV]: token });
    await vi.waitFor(async () => {
      const reads = await readLaneTokens([{ pid: carrying.pid, command: 'some other program --flag' }]);
      expect(reads.get(carrying.pid)).toEqual({ readable: false });
    }, { timeout: 5_000 });
  });

  it('drops lane variables a service inherited, and finds a session\'s lane by its exact registered path', () => {
    expect(carriesLaneEnv({ PATH: '/bin' })).toBe(false);
    expect(carriesLaneEnv({ GRU_LANE_JOB: 'outer' })).toBe(true);
    expect(withoutLaneEnv({ PATH: '/bin', GRU_LANE_TOKEN: 'f'.repeat(32), GRU_LANE_JOB: 'outer' })).toEqual({ PATH: '/bin' });
    const h = ledgerHarness();
    const warnings: string[] = [];
    try {
      const find = laneProvenanceFromLedger(h.ledger, (_level, msg) => warnings.push(msg));
      expect(find('/lanes/repo/job-b')).toEqual({ laneId: 'job-b', jobId: 'job-b', token: h.lane.laneToken });
      expect(isLaneToken(h.lane.laneToken)).toBe(true);
      expect(find('/lanes/repo/job-b/src')).toBeNull();
      h.db.handle.prepare("UPDATE worktrees SET lane_token = NULL WHERE id = 'job-b'").run();
      expect(find('/lanes/repo/job-b')).toBeNull();
      expect(warnings).toEqual(['lane has no token: its session carries none, and what it leaves running is asked about at its sweep']);
    } finally { h.db.close(); }
  });

  it('a process row keeps the evidence it was first found by while live; a reap records lane-token, and a pid recorded live again after leaving takes what it is seen by now', () => {
    const h = ledgerHarness();
    try {
      const record = (evidence: string, state: 'live' | 'killed') => h.ledger.recordWorktreeProcesses({ worktreeId: 'job-b', processes: [{ pid: 4242, command: 'node x', evidence }], state });
      const evidence = () => h.ledger.listWorktreeProcesses('job-b').find((proc) => proc.pid === 4242)?.evidence;
      record('registry', 'live');
      record('cwd', 'live');
      expect(evidence()).toBe('registry'); // a live verification run stays GC's own
      record('registry', 'killed');
      record('cwd', 'live'); // the pid is another process now: no stale registry proof
      expect(evidence()).toBe('cwd');
      record('lane-token', 'killed');
      expect(evidence()).toBe('lane-token');
      record('argv', 'live');
      expect(evidence()).toBe('argv');
    } finally { h.db.close(); }
  });

  it('groups a macOS app\'s helpers under its outermost bundle, and names any other process by its executable', () => {
    const app = '/opt/browsers/chrome/Google Chrome for Testing.app';
    expect(processName(`${app}/Contents/MacOS/Google Chrome for Testing`)).toBe('Google Chrome for Testing');
    expect(processName(`${app}/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/1/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer)`)).toBe('Google Chrome for Testing');
    expect(processName(`${app}/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/1/Helpers/chrome_crashpad_handler`)).toBe('Google Chrome for Testing');
    expect(processName('/usr/local/bin/agent-browser')).toBe('agent-browser');
    // A folder merely named like a bundle is no bundle.
    expect(processName('/repos/site.app/target/debug/server')).toBe('server');
    expect(processName('node')).toBe('node');
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
  /** The next disposal fails, leaving the session in place. */
  failDispose: boolean;
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
        failDispose: false,
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
          if (session.failDispose) { session.failDispose = false; throw new Error('dispose failed'); }
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

  it('a disposal that fails leaves its session in the lane, and says the lane is quiet again once the disposal is over', async () => {
    const h = registryHarness();
    const session = await h.registry.spawn('minion', { cwd: h.laneA });
    h.sessions.get(session.id)!.failDispose = true;
    await expect(session.dispose()).rejects.toThrow(/dispose failed/u);
    expect(h.registry.laneQuiet('job-a')).toBe(true);
    expect(h.quiet).toEqual(['job-a']);
    // The session is still there: a turn makes the lane busy again.
    const turn = session.prompt('work');
    expect(h.registry.laneQuiet('job-a')).toBe(false);
    h.sessions.get(session.id)!.release();
    await turn;
    await session.dispose();
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
      expect(card.detail).toContain('GC could not read its environment');
      expect(card.decision.context).toContain('started 2026-10-23T03:10:00Z to 2026-10-23T03:13:00Z');
      expect(card.detail).toContain('carries the token of lane job-c');
      expect(card.decision.options).toEqual([expect.objectContaining({ id: STOP_AND_SWEEP_OPTION, label: 'Stop these 5 processes and finish the sweep' })]);
      expect(card.decision.reservedClass).toBe('destructive');
    } finally { h.db.close(); }
  });

  it('gives each pid its own reason, and says why a token-carrying process was left', () => {
    const h = ledgerHarness();
    try {
      const card = sweepPausedCard(h.lane, [paused(1, 'node', 'no-token', '2026-10-23T03:10:00Z'), paused(2, 'node', 'this-lane', '2026-10-23T03:11:00Z')]);
      expect(card.detail).toContain('- node ×1 (pid 1; started 2026-10-23T03:10:00Z; working directory /lanes/repo/job-b): carries no lane token');
      expect(card.detail).toContain('- node ×1 (pid 2; started 2026-10-23T03:11:00Z; working directory /lanes/repo/job-b): carries this lane\'s token, but a session GC runs in the lane was still busy');
      expect(card.decision.whyNotDelegable).toContain('in use by a busy session');
    } finally { h.db.close(); }
  });

  it('is named by its lane and pause, and a newer pause or the sweep withdraws an unanswered one, a pre-#486 notice included', () => {
    const h = ledgerHarness();
    try {
      expect(sweepPausedCardOf(sweepPausedKind('job-b', 'p1'))).toEqual({ laneId: 'job-b', pauseId: 'p1' });
      expect(sweepPausedCardOf('worktree-sweep-paused')).toBeNull();
      const legacy = h.notifications.post({ kind: 'worktree-sweep-paused:job-b:3f1c', routing: 'needs-owner', severity: 'info', title: 'Worktree sweep paused: live processes in repo' });
      const first = postSweepPausedCard(h, { worktree: h.lane, pauseId: 'p1', details });
      expect(first.routing).toBe('needs-owner');
      expect(first.id).toBe('worktree-sweep-paused:job-b:p1');
      expect(h.ledger.getNotification(legacy.id)?.resolvedBy).toBe('producer-withdrawn');
      const second = postSweepPausedCard(h, { worktree: h.lane, pauseId: 'p2', details });
      expect(h.ledger.getNotification(first.id)?.resolvedBy).toBe('producer-withdrawn');
      expect(h.ledger.getNotification(second.id)?.resolvedAt).toBeNull();
      settleSweptLaneCards(h, 'job-b');
      expect(h.ledger.getNotification(second.id)?.resolvedBy).toBe('producer-withdrawn');
    } finally { h.db.close(); }
  });

  it('touches only its own lane\'s cards, never one whose lane id differs only in case', () => {
    const h = ledgerHarness();
    try {
      const lane = (id: string) => {
        h.ledger.addJob({ id, repo: 'repo', title: id });
        return h.ledger.registerWorktree({ id, kind: 'job', repoPath: '/repos/repo', repoName: 'repo', path: `/lanes/repo/${id}`, branch: `gru/${id}`, sha: 'a'.repeat(40), jobId: id });
      };
      const upper = postSweepPausedCard(h, { worktree: lane('Job-B'), pauseId: 'p1', details });
      const answered = postSweepPausedCard(h, { worktree: lane('JOB-B'), pauseId: 'p1', details });
      h.notifications.decide(answered.id, STOP_AND_SWEEP_OPTION, 'owner');
      postSweepPausedCard(h, { worktree: h.lane, pauseId: 'p1', details });
      // A notice from before #486 that the owner-attention rules handed to Gru.
      const legacy = h.notifications.post({ kind: 'worktree-sweep-paused:job-b:3f1c', routing: 'needs-owner', severity: 'info', title: 'Worktree sweep paused: live processes in repo' });
      h.ledger.updateNotificationTriage(legacy.id, 'action-required', 'routed to Gru');
      settleSweptLaneCards(h, 'job-b');
      expect(h.ledger.getNotification(upper.id)?.resolvedAt).toBeNull();
      expect(h.ledger.getNotification(answered.id)?.resolvedAt).toBeNull();
      expect(h.ledger.getNotification(legacy.id)?.resolvedBy).toBe('sweep-completed');
    } finally { h.db.close(); }
  });

  function resolution(h: ReturnType<typeof ledgerHarness>, id: string): unknown {
    return h.ledger.listEvents({ limit: 100 }).find((event) => event.kind === 'notification.resolved' && (event.payload as { id?: string }).id === id)?.payload;
  }

  function pausedLane(h: ReturnType<typeof ledgerHarness>, pids: readonly number[], extra: Record<string, unknown> = {}): NotificationRecord {
    h.ledger.setWorktreeStatus('job-b', 'paused', 'sweep paused');
    h.ledger.appendCustomEvent({ kind: 'worktree.paused', jobId: 'job-b', payload: { id: 'job-b', path: h.lane.path, pause_id: 'p1', processes: pids.map((pid) => ({ pid })), ...extra } });
    return postSweepPausedCard(h, { worktree: h.lane, pauseId: 'p1', details });
  }

  it('carries out an answer recorded while GC runs as a confirmed kill of exactly the pids that card named, with its pause\'s base branch', async () => {
    const h = ledgerHarness();
    const releases: SweepRequest[] = [];
    const follower = new SweepDecisionFollower({
      ledger: h.ledger,
      bus: h.bus,
      notifications: h.notifications,
      release: async (input): Promise<SweepResult> => {
        releases.push(input);
        return { status: 'paused', processes: [], preserved: null, note: 'sweep paused: pids 79503 survived the acknowledged kill (SIGTERM + SIGKILL)' };
      },
    });
    try {
      const card = pausedLane(h, [65215, 79503], { base_branch: 'develop' });
      follower.start();
      await follower.follow(); // the start pass is over: only the subscription can carry the answer out
      h.notifications.decide(card.id, STOP_AND_SWEEP_OPTION, 'owner');
      await vi.waitFor(() => expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull());
      expect(releases).toEqual([{ worktreeId: 'job-b', confirmKill: true, confirmKillPids: [65215, 79503], baseBranch: 'develop' }]);
      expect(resolution(h, card.id)).toMatchObject({ detail: 'the sweep paused again: sweep paused: pids 79503 survived the acknowledged kill (SIGTERM + SIGKILL)', owner_decision: STOP_AND_SWEEP_OPTION });
    } finally { follower.stop(); h.db.close(); }
  });

  it('an answered card whose release sweeps the lane closes saying so, through the sweep\'s own settlement', async () => {
    const h = ledgerHarness();
    const follower = new SweepDecisionFollower({
      ledger: h.ledger,
      bus: h.bus,
      notifications: h.notifications,
      // As the real release does: the sweep settles the lane's cards (main's onSwept) before it returns.
      release: async (): Promise<SweepResult> => {
        h.ledger.setWorktreeStatus('job-b', 'swept');
        settleSweptLaneCards(h, 'job-b');
        h.notifications.resolveIncidents('worktree-sweep-paused:job-b:', 'sweep-completed');
        return { status: 'swept', preserved: null, branch: 'deleted', freshHead: 'b'.repeat(40) };
      },
    });
    try {
      const card = pausedLane(h, [65215]);
      h.notifications.decide(card.id, STOP_AND_SWEEP_OPTION, 'owner');
      follower.start();
      await vi.waitFor(() => expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull());
      expect(resolution(h, card.id)).toMatchObject({ detail: 'lane job-b was swept after the answer "Stop these 5 processes and finish the sweep"', owner_decision: STOP_AND_SWEEP_OPTION });
    } finally { follower.stop(); h.db.close(); }
  });

  it('an answer that has to wait keeps its card open and answered, tells Gru once, and is tried again at the next pass', async () => {
    const h = ledgerHarness();
    const release = vi.fn<(input: SweepRequest) => Promise<SweepResult>>(async () => { throw new Error('sweep refused: a merge is in progress'); });
    const follower = new SweepDecisionFollower({ ledger: h.ledger, bus: h.bus, notifications: h.notifications, release });
    const waiting = (id: string) => h.ledger.getNotification(`worktree-sweep-answer-waiting:${id}`);
    try {
      const card = pausedLane(h, [65215]);
      h.notifications.decide(card.id, STOP_AND_SWEEP_OPTION, 'owner');
      follower.start();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      await follower.follow(); // the next pass (an answer, a restart, the hourly reconcile) retries it
      expect(release).toHaveBeenCalledTimes(2);
      expect(h.ledger.getNotification(card.id)).toMatchObject({ resolvedAt: null, decidedOption: STOP_AND_SWEEP_OPTION });
      expect(waiting(card.id)).toMatchObject({ routing: 'action-required', kind: 'worktree.sweep-answer-waiting', resolvedAt: null });
      expect(waiting(card.id)?.detail).toContain('its release was refused: sweep refused: a merge is in progress');
      expect(h.ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === 'worktree.sweep-answer-waiting')).toHaveLength(1);
      // Like an operator's release, it never abandons a child worker that has
      // not finished: nothing is released, and the card still waits.
      h.ledger.registerAgent({ id: 'parent-b', role: 'minion', jobId: 'job-b' });
      h.ledger.admitChildWorker({ id: 'child_b', parentAgentId: 'parent-b', jobId: 'job-b', purpose: 'check', authority: 'read-only', task: 't', idempotencyKey: 'k' });
      await follower.follow();
      expect(release).toHaveBeenCalledTimes(2);
      expect(h.ledger.getNotification(card.id)?.resolvedAt).toBeNull();
      // Once the lane is swept, the card and Gru's row settle.
      h.ledger.setWorktreeStatus('job-b', 'swept');
      settleSweptLaneCards(h, 'job-b');
      expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
      expect(waiting(card.id)?.resolvedAt).not.toBeNull();
    } finally { follower.stop(); h.db.close(); }
  });

  it('Gru\'s row about a waiting answer resolves however its card closes; a card closed meanwhile waits for nothing', async () => {
    const h = ledgerHarness();
    const release = vi.fn<(input: SweepRequest) => Promise<SweepResult>>();
    const follower = new SweepDecisionFollower({ ledger: h.ledger, bus: h.bus, notifications: h.notifications, release });
    try {
      h.ledger.registerAgent({ id: 'parent-b', role: 'minion', jobId: 'job-b' });
      h.ledger.admitChildWorker({ id: 'child_b', parentAgentId: 'parent-b', jobId: 'job-b', purpose: 'check', authority: 'read-only', task: 't', idempotencyKey: 'k' });
      const card = pausedLane(h, [65215]);
      h.notifications.decide(card.id, STOP_AND_SWEEP_OPTION, 'owner');
      follower.start();
      await follower.follow();
      const waiting = `worktree-sweep-answer-waiting:${card.id}`;
      expect(h.ledger.getNotification(waiting)?.detail).toContain('answered "Stop these 5 processes and finish the sweep"');
      // The lane was swept, and its sweep's settlement of the cards was lost
      // (a crash between the two): the next pass closes the card, and the row.
      h.ledger.setWorktreeStatus('job-b', 'swept');
      await follower.follow();
      expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
      expect(h.ledger.getNotification(waiting)?.resolvedBy).toBe('card-closed');
      expect(release).not.toHaveBeenCalled();
    } finally { follower.stop(); h.db.close(); }
  });

  it('a child worker that has not finished holds the answer, and its card says which and how to cancel it', async () => {
    const h = ledgerHarness();
    const release = vi.fn<(input: SweepRequest) => Promise<SweepResult>>();
    const follower = new SweepDecisionFollower({ ledger: h.ledger, bus: h.bus, notifications: h.notifications, release });
    try {
      h.ledger.registerAgent({ id: 'parent-b', role: 'minion', jobId: 'job-b' });
      h.ledger.admitChildWorker({ id: 'child_b', parentAgentId: 'parent-b', jobId: 'job-b', purpose: 'check', authority: 'read-only', task: 't', idempotencyKey: 'k' });
      const card = pausedLane(h, [65215]);
      h.notifications.decide(card.id, STOP_AND_SWEEP_OPTION, 'owner');
      follower.start();
      await follower.follow();
      expect(release).not.toHaveBeenCalled();
      expect(h.ledger.getNotification(`worktree-sweep-answer-waiting:${card.id}`)?.detail)
        .toContain('child worker child_b of lane job-b has not finished, and a release never abandons one: cancel it (POST /api/dispatch/children/child_b/cancel)');
    } finally { follower.stop(); h.db.close(); }
  });

  it('carries out nothing once the service is stopping', async () => {
    const h = ledgerHarness();
    const release = vi.fn<(input: SweepRequest) => Promise<SweepResult>>();
    const stop = new AbortController();
    stop.abort();
    const follower = new SweepDecisionFollower({ ledger: h.ledger, bus: h.bus, notifications: h.notifications, release, stopSignal: stop.signal });
    try {
      const card = pausedLane(h, [65215]);
      h.notifications.decide(card.id, STOP_AND_SWEEP_OPTION, 'owner');
      follower.start();
      await follower.follow();
      expect(release).not.toHaveBeenCalled();
      expect(h.ledger.getNotification(card.id)?.resolvedAt).toBeNull();
    } finally { follower.stop(); h.db.close(); }
  });

  it('stops nothing for a lane that is no longer paused, and closes the card saying so', async () => {
    const h = ledgerHarness();
    const release = vi.fn<(input: SweepRequest) => Promise<SweepResult>>();
    const follower = new SweepDecisionFollower({ ledger: h.ledger, bus: h.bus, notifications: h.notifications, release });
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
