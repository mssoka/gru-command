import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { JobExecutionStop, type JobStopDeps } from '../src/dispatch/job-stop.js';
import { DispatchService } from '../src/dispatch/service.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

const JOB = 'job-stop';

interface Fixture {
  readonly ledger: LedgerApi;
  readonly db: LedgerDb;
  readonly stop: JobExecutionStop;
  readonly handles: Map<string, AgentHandle>;
  readonly close: () => void;
}

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeHandle(id: string, evidence: 'ceased' | 'unknown', reject = false): AgentHandle {
  return {
    id,
    role: 'minion',
    sessionFile: null,
    capabilities: {},
    health: () => ({ state: 'streaming', lastActivity: null, sessionFile: null }),
    dispose: async () => {
      if (reject) throw new Error('dispose rejected');
    },
    cessationEvidence: () => evidence,
  } as unknown as AgentHandle;
}

function fixture(opts: {
  readonly agents?: readonly { readonly id: string; readonly state: 'spawning' | 'streaming' }[];
  readonly handles?: ReadonlyMap<string, AgentHandle>;
  readonly reviews?: JobStopDeps['reviews'];
} = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'gru-job-stop-'));
  dirs.push(dir);
  const db = new LedgerDb(dir);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  ledger.addJob({ id: JOB, repo: 'gru-command', title: 'stop the producers', briefing: 'b' });
  ledger.setJobStatus(JOB, 'working');
  for (const agent of opts.agents ?? []) {
    ledger.registerAgent({ id: agent.id, role: 'minion', jobId: JOB, parentage: 'top-level' });
    ledger.setAgentState(agent.id, agent.state);
  }
  const handles = new Map(opts.handles ?? []);
  const stop = new JobExecutionStop({
    ledger,
    handles: { get: (agentId) => handles.get(agentId) ?? null },
    children: null,
    reviews: opts.reviews === undefined ? null : opts.reviews,
    log: () => {},
  });
  return { ledger, db, stop, handles, close: () => db.close() };
}

describe('job execution stop (issue #455)', () => {
  it('records stopped only on positive adapter cessation evidence', async () => {
    const f = fixture({
      agents: [{ id: 'minion-1', state: 'streaming' }],
      handles: new Map([['minion-1', fakeHandle('minion-1', 'ceased')]]),
      reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('stopped');
      expect(outcome.agents).toEqual([{ agentId: 'minion-1', role: 'minion', state: 'stopped', detail: null }]);
      expect(outcome.reviews.state).toBe('stopped');
      const events = f.ledger.listJobEventsByKinds(JOB, ['job.execution-stop']);
      expect(events.map((event) => (event.payload as { state: string }).state).reverse()).toEqual(['requested', 'stopped']);
    } finally {
      f.close();
    }
  });

  it('preserves unproven when disposal returns without cessation evidence', async () => {
    const f = fixture({
      agents: [{ id: 'minion-2', state: 'streaming' }],
      handles: new Map([['minion-2', fakeHandle('minion-2', 'unknown')]]),
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.agents[0]?.state).toBe('unproven');
      expect(outcome.agents[0]?.detail).toMatch(/without the adapter observing cessation/);
      const events = f.ledger.listJobEventsByKinds(JOB, ['job.execution-stop']);
      expect((events[0]?.payload as { state: string }).state).toBe('unproven');
    } finally {
      f.close();
    }
  });

  it('treats a ledger open turn with no runtime handle as unproven, never stopped', async () => {
    const f = fixture({ agents: [{ id: 'minion-3', state: 'streaming' }] });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.agents[0]?.detail).toMatch(/runtime holds no handle/);
    } finally {
      f.close();
    }
  });

  it('names a failed dispose instead of claiming the producer stopped', async () => {
    const f = fixture({
      agents: [{ id: 'minion-4', state: 'streaming' }],
      handles: new Map([['minion-4', fakeHandle('minion-4', 'ceased', true)]]),
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.agents[0]?.detail).toMatch(/dispose failed/);
    } finally {
      f.close();
    }
  });

  it('does not hide an unsettled verification behind a stopped verdict', async () => {
    const f = fixture({ agents: [{ id: 'minion-5', state: 'streaming' }], handles: new Map([['minion-5', fakeHandle('minion-5', 'ceased')]]) });
    try {
      f.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: JOB, payload: { run_id: 'run-open' } });
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.outstanding.join(' ')).toMatch(/unsettled verification run/);
    } finally {
      f.close();
    }
  });

  it('records an unconfirmed review stop as unproven', async () => {
    const f = fixture({
      reviews: {
        supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 1, confirmed: false, detail: 'session still live' }),
      },
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.reviews).toEqual({ state: 'unproven', roundIds: [], detail: 'session still live' });
    } finally {
      f.close();
    }
  });

  // A disposal makes the producer's briefing turn reject. That rejection is
  // the CONSEQUENCE of the hold and must not rewrite the explicit owner
  // hold into a fresh `blocked` blocker.
  it('keeps the lane parked when a disposed producer settles with an error', async () => {
    const repo = makeFixtureRepo('job-stop-settle');
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'gru-job-stop-lanes-'));
    dirs.push(laneRoot);
    const dir = mkdtempSync(join(tmpdir(), 'gru-job-stop-ledger-'));
    dirs.push(dir);
    const db = new LedgerDb(dir);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
    try {
      const worktrees = new InMemoryWorktreePort(laneRoot, ledger);
      let failTurn!: (error: unknown) => void;
      const turn = new Promise<void>((_, reject) => {
        failTurn = reject;
      });
      const handle = {
        id: 'minion-parked',
        role: 'minion',
        sessionFile: null,
        capabilities: {},
        prompt: () => turn,
        health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }),
        dispose: async () => {},
      } as unknown as AgentHandle;
      const service = new DispatchService({ ledger, worktrees, spawner: async () => handle });
      const run = await service.dispatch({
        jobId: 'job-parked-settle',
        repoPath: repo.path,
        title: 'parked settle',
        briefing: 'work',
      });
      expect(ledger.getJob('job-parked-settle')?.status).toBe('working');
      ledger.setJobStatus('job-parked-settle', 'parked');
      failTurn(new Error('turn aborted by the explicit owner hold'));
      await run.settled;
      expect(ledger.getJob('job-parked-settle')?.status).toBe('parked');
      expect(ledger.latestJobEvent('job-parked-settle', 'job.minion-error')).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
