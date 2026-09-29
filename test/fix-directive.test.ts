import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFollowUpDelivery, renderRebriefPrompt, routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import type { AgentHandle } from '../src/runtime/types.js';
import type { WorktreeLane, WorktreePort } from '../src/dispatch/worktree-port.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * The follow-up delivery signal (R2 review B3): a settled directive or
 * re-brief turn must land as a delivery on the record, carrying the lane
 * head the turn produced — that is what the digest's freshness predicate
 * reads to decide whether a re-review round is warranted.
 */

const cleanupRepos: FixtureRepo[] = [];
const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

interface RecordedEvent {
  readonly kind: string;
  readonly jobId?: string | null;
  readonly payload?: unknown;
}

function fakeLedger() {
  const events: RecordedEvent[] = [];
  return {
    events,
    appendCustomEvent(fields: { kind: string; jobId?: string | null; payload?: unknown }) {
      events.push(fields);
      return {
        seq: events.length,
        ts: '2026-09-21T00:00:00.000Z',
        kind: fields.kind,
        agentId: null,
        jobId: fields.jobId ?? null,
        roundId: null,
        lens: null,
        payload: fields.payload ?? {},
      };
    },
  };
}

function laneAt(path: string, status: WorktreeLane['status'] = 'active'): WorktreeLane {
  return {
    id: 'job-1',
    kind: 'job',
    repoPath: path,
    repoName: 'fixture',
    path,
    branch: 'gru/job-1',
    sha: 'sha-created',
    jobId: 'job-1',
    roundId: null,
    status,
  };
}

describe('fresh fix worker association', () => {
  it('binds the owning job before a failed prompt and keeps it after disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-fix-binding-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: 'owner-lane', repo: 'fixture', title: 'Full owner title' });
      let disposed = false;
      const handle = {
        id: 'worker-uuid-0001', role: 'minion', sessionFile: '/fixture/session',
        async prompt() {
          expect(ledger.getAgent('worker-uuid-0001')?.jobId).toBe('owner-lane');
          throw new Error('prompt failed');
        },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile: '/fixture/session' }; },
        async dispose() { disposed = true; },
      } satisfies AgentHandle;
      await expect(routeFixDirectiveToMinion({
        jobId: 'owner-lane', directive: 'repair', signal: new AbortController().signal,
        ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => null, spawn: async () => handle, disposeHandle: async () => {} },
      })).rejects.toThrow('prompt failed');
      expect(disposed).toBe(true);
      expect(ledger.getAgent(handle.id)).toMatchObject({ role: 'minion', jobId: 'owner-lane', sessionFile: '/fixture/session' });
    } finally {
      db.close();
    }
  });

  it('never routes a directive into a review-only session, however new (Gru ruling 2026-09-29)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-fix-reviewer-safe-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: 'reviewer-safe', repo: 'fixture', title: 't', briefing: 'b' });
      // An implementer with NO live handle, and a NEWEST review-only row
      // (round-bound minion) whose handle IS live — the old newest-first
      // live-handle loop prompted the reviewer; routing must spawn fresh
      // instead.
      ledger.registerAgent({ id: 'impl-minion', role: 'minion', jobId: 'reviewer-safe', sessionFile: '/fixture/impl.jsonl' });
      const round = ledger.addRound({ jobId: 'reviewer-safe', lenses: ['blind'] });
      ledger.registerAgent({ id: 'rev-reviewer', role: 'minion', roundId: round.id, jobId: 'reviewer-safe', sessionFile: '/fixture/rev.jsonl' });
      const bump = db.handle.prepare('UPDATE agents SET updated_at = ? WHERE id = ?');
      bump.run('2026-09-29T12:00:01.000Z', 'impl-minion');
      bump.run('2026-09-29T12:00:02.000Z', 'rev-reviewer');
      const prompted: string[] = [];
      let spawned = 0;
      const reviewerHandle = {
        id: 'rev-reviewer', role: 'minion', sessionFile: '/fixture/rev.jsonl',
        async prompt() { prompted.push('rev-reviewer'); },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile: '/fixture/rev.jsonl' }; },
        async dispose() {},
      } satisfies AgentHandle;
      const freshHandle = {
        id: 'fresh-worker', role: 'minion', sessionFile: '/fixture/fresh.jsonl',
        async prompt() { prompted.push('fresh-worker'); },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile: '/fixture/fresh.jsonl' }; },
        async dispose() {},
      } satisfies AgentHandle;
      const outcome = await routeFixDirectiveToMinion({
        jobId: 'reviewer-safe', directive: 'repair the flake', signal: new AbortController().signal,
        ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: {
          getHandle: (id: string) => (id === 'rev-reviewer' ? reviewerHandle : null),
          spawn: async () => { spawned += 1; return freshHandle; },
          disposeHandle: async () => {},
        },
      });
      expect(prompted).toEqual(['fresh-worker']);
      expect(spawned).toBe(1);
      expect(outcome.delivered).toBe(true);
      expect(outcome.minionId).toBe('fresh-worker');
    } finally {
      db.close();
    }
  });
});

describe('recordFollowUpDelivery (the loop-closing signal)', () => {
  it('records job.delivered with the lane head the settled turn produced', async () => {
    const repo = makeFixtureRepo('fixture-followup-delivery');
    cleanupRepos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'gru-command-followup-lanes-'));
    cleanupDirs.push(root);
    const worktrees = new InMemoryWorktreePort(root);
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'job-1' });
    writeFileSync(join(lane.path, 'fix.txt'), 'fixed\n');
    execFileSync('git', ['-C', lane.path, 'add', 'fix.txt']);
    execFileSync(
      'git',
      ['-C', lane.path, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'fix'],
      { stdio: 'ignore' },
    );
    const head = execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const ledger = fakeLedger();
    const result = recordFollowUpDelivery({
      ledger,
      worktrees,
      jobId: 'job-1',
      agentId: 'minion-1',
      source: 'silas-directive',
    });
    expect(result.sha).toBe(head);
    expect(result.lanePath).toBe(lane.path);
    expect(result.note).toBeNull();
    expect(ledger.events).toEqual([
      { kind: 'job.delivered', jobId: 'job-1', payload: { agentId: 'minion-1', source: 'silas-directive', sha: head } },
    ]);
  });

  it('still records the delivery when no head can be resolved — loud note, no fabricated sha', () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-command-followup-nogit-'));
    cleanupDirs.push(root);
    const path = join(root, 'not-a-repo');
    mkdirSync(path);
    const ledger = fakeLedger();
    const result = recordFollowUpDelivery({
      ledger,
      worktrees: { listWorktrees: () => [laneAt(path)] },
      jobId: 'job-1',
      agentId: null,
      source: 'silas-rebrief',
    });
    expect(result.sha).toBeNull();
    expect(result.note).toContain('lane head unresolved');
    expect(ledger.events).toEqual([
      { kind: 'job.delivered', jobId: 'job-1', payload: { agentId: null, source: 'silas-rebrief', sha: null } },
    ]);
  });

  it('resolves the head from the ACTIVE job lane, never a swept one', async () => {
    const repo = makeFixtureRepo('fixture-followup-active-lane');
    cleanupRepos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'gru-command-followup-active-'));
    cleanupDirs.push(root);
    const worktrees = new InMemoryWorktreePort(root);
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'job-1' });
    const head = execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const ledger = fakeLedger();
    const result = recordFollowUpDelivery({
      ledger,
      // A swept lane (its path may be gone) precedes the live one in list order.
      worktrees: { listWorktrees: () => [laneAt(join(root, 'swept-away'), 'swept'), lane] },
      jobId: 'job-1',
      agentId: 'minion-2',
      source: 'silas-directive',
    });
    expect(result.sha).toBe(head);
    expect(result.note).toBeNull();
    expect(result.lanePath).toBe(lane.path);
  });

  it('records the delivery (sha null) when the registry has no job lane at all', () => {
    const ledger = fakeLedger();
    const result = recordFollowUpDelivery({
      ledger,
      worktrees: { listWorktrees: () => [{ ...laneAt('/nowhere'), kind: 'review', roundId: 'r1', jobId: null }] },
      jobId: 'job-1',
      agentId: 'minion-3',
      source: 'silas-rebrief',
    });
    expect(result.sha).toBeNull();
    expect(result.lanePath).toBeNull();
    expect(result.note).toContain('no job lane');
    expect(ledger.events[0]?.payload).toEqual({ agentId: 'minion-3', source: 'silas-rebrief', sha: null });
  });
});

describe('renderRebriefPrompt (the fresh worker contract)', () => {
  it('carries the re-brief note AND the original briefing; a missing briefing is loud, never silent', () => {
    const prompt = renderRebriefPrompt({
      jobId: 'job-1',
      briefing: 'THE ORIGINAL CONTRACT',
      note: 'same blocker three rounds; try a different approach',
    });
    expect(prompt).toContain('Re-brief — job job-1');
    expect(prompt).toContain('same blocker three rounds; try a different approach');
    expect(prompt).toContain('THE ORIGINAL CONTRACT');
    expect(prompt).toContain('never merge your own pull request');
    // A job row with no stored briefing says so — the fresh worker must not
    // silently receive an empty contract.
    const bare = renderRebriefPrompt({ jobId: 'job-2', briefing: null, note: 'n' });
    expect(bare).toContain('the job row carries no stored briefing');
  });
});
describe('eviction-safe fix directives (phase 3)', () => {
  const CAPS = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

  function stubRegistry(liveRejectsWith: Error | null) {
    const failing = {
      id: 'minion-live', role: 'minion' as const, sessionFile: '/sessions/failing.jsonl', capabilities: CAPS,
      health: () => ({ state: 'idle', lastActivity: null, sessionFile: '/sessions/failing.jsonl' }),
      prompt: async () => { if (liveRejectsWith !== null) throw liveRejectsWith; },
      steer: async () => {}, followUp: async () => {}, subscribe: () => () => {}, dispose: async () => {},
    };
    const controller = new AbortController();
    const calls: Array<{ role: string; options: { resumeFile?: string | null } }> = [];
    const prompted: string[] = [];
    const registry = {
      getHandle: () => failing,
      spawn: async (_role: string, options: { resumeFile?: string | null } = {}) => {
        calls.push({ role: _role, options });
        return {
          ...failing, id: `minion-resumed-${calls.length}`,
          sessionFile: options.resumeFile ?? `/sessions/fresh-${calls.length}.jsonl`,
          prompt: async (text: string) => { prompted.push(text); },
        };
      },
    };
    return { registry, failing, controller, calls, prompted };
  }

  it('falls through a typed eviction rejection and resumes the FAILING logical session', async () => {
    const { WorkerDisposalInProgressError } = await import('../src/runtime/registry.js');
    const { registry, controller, calls } = stubRegistry(new WorkerDisposalInProgressError());
    const root = mkdtempSync(join(tmpdir(), 'fix-directive-evict-'));
    const worktrees = new InMemoryWorktreePort(root);
    const repo = makeFixtureRepo('fixture-fix-evict');
    cleanupRepos.push(repo);
    await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'job-evict' });
    const ledgerEvents: Array<{ kind: string; payload: unknown }> = [];
    const ledger = {
      listAgents: () => [{ id: 'minion-live', role: 'minion', jobId: 'job-evict', sessionFile: '/sessions/failing.jsonl' }],
      registerAgent: (fields: { id: string }) => { ledgerEvents.push({ kind: 'agent', payload: fields }); },
      getJob: () => ({ briefing: 'original contract' }),
    };
    const outcome = await routeFixDirectiveToMinion({
      registry: registry as never, ledger: ledger as never, worktrees,
      jobId: 'job-evict', directive: 'fix the blocker', signal: controller.signal,
    });
    expect(outcome.delivered).toBe(true);
    expect(calls[0]?.options.resumeFile).toBe('/sessions/failing.jsonl'); // the failing session, not an arbitrary record
    rmSync(root, { recursive: true, force: true });
  });

  it('a successful resume prompts the directive itself; only a failed resume re-briefs from the original contract', async () => {
    const { WorkerDisposalInProgressError } = await import('../src/runtime/registry.js');
    const { registry, controller, prompted } = stubRegistry(new WorkerDisposalInProgressError());
    const root = mkdtempSync(join(tmpdir(), 'fix-directive-resume-'));
    const worktrees = new InMemoryWorktreePort(root);
    const repo = makeFixtureRepo('fixture-fix-resume');
    cleanupRepos.push(repo);
    await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'job-resume' });
    const ledger = {
      listAgents: () => [{ id: 'minion-live', role: 'minion', jobId: 'job-resume', sessionFile: '/sessions/failing.jsonl' }],
      registerAgent: () => {},
      getJob: () => ({ briefing: 'original contract' }),
    };
    await routeFixDirectiveToMinion({
      registry: registry as never, ledger: ledger as never, worktrees,
      jobId: 'job-resume', directive: 'fix the blocker', signal: controller.signal,
    });
    expect(prompted[0]).toBe('fix the blocker'); // resumed session gets the directive, not a re-brief
    rmSync(root, { recursive: true, force: true });
  });
});
