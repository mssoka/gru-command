import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebriefFreshMinion, recordFollowUpDelivery, renderRebriefPrompt, routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi, type ObligationRecord } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { withFallbacks } from '../src/runtime/fallbacks.js';
import type { AgentHandle, AgentRuntime } from '../src/runtime/types.js';
import { appendWorkerRules } from '../src/dispatch/worker-rules.js';
import type { WorktreeLane, WorktreePort } from '../src/dispatch/worktree-port.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { PacingGate } from '../src/runtime/pacing.js';
import type { AgentRecord } from '../src/ledger/api.js';

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

function fakeLedger(job: { deliverable?: 'review' | 'artifact' | 'investigation' | null } = {}) {
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
    // Issue #220: the delivery path reads the job to decide whether this
    // is a report handback. The fixture's jobs are PR-owing (deliverable
    // null), so the obligation path stays untouched unless a test opts in.
    getJob(id: string) {
      return id === 'job-1'
        ? {
            id,
            repo: 'fixture',
            title: id,
            displayName: null,
            deliverable: job.deliverable ?? null,
            commissioner: null,
            targetRef: null,
            targetSha: null,
            status: 'delivered' as const,
            baseBranch: null,
            prUrl: null,
            note: null,
            briefing: null,
            createdAt: '2026-09-21T00:00:00.000Z',
            updatedAt: '2026-09-21T00:00:00.000Z',
          }
        : null;
    },
    openReportObligation(args: { jobId: string; observedAtSeq: number }) {
      events.push({ kind: 'job.report-obligation-opened', jobId: args.jobId, payload: args });
      return { obligation: { id: `obl-${args.jobId}` } as ObligationRecord, created: true };
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
/** A complete AgentRecord row for ledger-port doubles (the port returns full
 * rows, never partial fixtures). */
function minionRecord(id: string, jobId: string | null, sessionFile: string | null): AgentRecord {
  return {
    id,
    role: 'minion',
    label: null,
    jobId,
    roundId: null,
    state: 'idle',
    lastActivity: null,
    sessionFile,
    parentAgentId: null,
    parentage: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  };
}

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

  it('uses newest spawn order for both live picks and session fallback after integration', async () => {
    for (const live of [true, false]) {
      const root = mkdtempSync(join(tmpdir(), 'fix-directive-order-'));
      cleanupDirs.push(root);
      const db = new LedgerDb(root);
      try {
        const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
        ledger.addJob({ id: 'ordered-heist', repo: 'fixture', title: 'T', briefing: 'original contract' });
        for (const id of ['old', 'new']) {
          ledger.registerAgent({ id, role: 'minion', jobId: 'ordered-heist', sessionFile: `/sessions/${id}.jsonl` });
        }
        const stamp = db.handle.prepare('UPDATE agents SET created_at = ?, updated_at = ? WHERE id = ?');
        stamp.run('2026-09-29T12:00:01Z', '2026-09-29T12:00:03Z', 'old');
        stamp.run('2026-09-29T12:00:02Z', '2026-09-29T12:00:02Z', 'new');
        const { registry, controller, calls, failing } = stubRegistry(null);
        const prompted: string[] = [];
        await routeFixDirectiveToMinion({
          registry: {
            ...registry,
            getHandle: (id: string) => live ? { ...failing, id, prompt: async () => { prompted.push(id); } } : null,
          } as never,
          ledger, worktrees: { listWorktrees: () => [laneAt(root)] } as unknown as WorktreePort,
          jobId: 'ordered-heist', directive: 'repair', signal: controller.signal,
        });
        if (live) {
          expect(prompted).toEqual(['new']);
          expect(calls).toEqual([]);
        } else {
          expect(calls[0]?.options.resumeFile).toBe('/sessions/new.jsonl');
        }
      } finally {
        db.close();
      }
    }
  });

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
      getAgent: () => null,
      listAgents: () => [],
      listImplementerMinions: () => [{ id: 'minion-live', role: 'minion', jobId: 'job-evict', sessionFile: '/sessions/failing.jsonl' }],
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
      getAgent: () => null,
      listAgents: () => [{ id: 'minion-live', role: 'minion', jobId: 'job-resume', sessionFile: '/sessions/failing.jsonl' }],
      listImplementerMinions: () => [{ id: 'minion-live', role: 'minion', jobId: 'job-resume', sessionFile: '/sessions/failing.jsonl' }],
      registerAgent: () => {},
      getJob: () => ({ briefing: 'original contract' }),
    };
    await routeFixDirectiveToMinion({
      registry: registry as never, ledger: ledger as never, worktrees,
      jobId: 'job-resume', directive: 'fix the blocker', signal: controller.signal,
    });
    expect(prompted[0]).toBe(appendWorkerRules('fix the blocker')); // resumed session gets the directive (never the re-brief wrapper), now carrying the current non-draft PR and no-call-budget rules
    // Literal clause pin (not helper-derived): a routed directive must itself
    // carry the no-call-budget rule, whatever the helper composes.
    expect(prompted[0]).toContain('no total or per-phase tool-call budget binds');
    expect(prompted[0]).toContain('it does not bind');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('the non-draft PR rule on follow-up directives', () => {
  const CAPS = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

  it('a directive to the live minion carries the current non-draft PR creation rule', async () => {
    const prompted: string[] = [];
    const handle = {
      id: 'minion-live', role: 'minion' as const, sessionFile: null, capabilities: CAPS,
      health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }),
      prompt: async (text: string) => { prompted.push(text); },
      steer: async () => {}, followUp: async () => {}, subscribe: () => () => {}, dispose: async () => {},
    };
    const outcome = await routeFixDirectiveToMinion({
      registry: {
        getHandle: () => handle as never,
        spawn: async () => { throw new Error('a live minion must be used, not a spawn'); },
        disposeHandle: async () => {},
      },
      ledger: {
        getAgent: () => null,
        listAgents: () => [{ id: 'minion-live', role: 'minion', jobId: 'job-live', sessionFile: null }],
      listImplementerMinions: () => [{ id: 'minion-live', role: 'minion', jobId: 'job-live', sessionFile: null }],
        registerAgent: () => {},
        getJob: () => ({ briefing: 'original contract' }),
      } as never,
      worktrees: {} as never,
      jobId: 'job-live',
      directive: 'open the PR for the finished fix',
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ delivered: true, minionId: 'minion-live', outcome: 'completed' });
    expect(prompted).toHaveLength(1);
    expect(prompted[0]).toContain('open the PR for the finished fix');
    expect(prompted[0]).toContain('ordinary, non-draft PR');
    expect(prompted[0]).toContain('gh pr create without --draft/-d');
  });
});

describe('cancelled retry settlement on directive consumers (r4 verification#3)', () => {
  const CAPS = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };
  const lane = {
    id: 'job-cancel', kind: 'job' as const, repoPath: '/tmp/lane', repoName: 'fixture', path: '/tmp/lane',
    branch: 'gru/job-cancel', sha: 'sha', jobId: 'job-cancel', roundId: null, status: 'active' as const,
  };

  it('a mid-wait abort on the live path reports undelivered and never lands a delivery', async () => {
    const controller = new AbortController();
    const prompted: string[] = [];
    const handle = {
      id: 'minion-live', role: 'minion' as const, sessionFile: '/sessions/live.jsonl', capabilities: CAPS,
      prompt: async (text: string) => { prompted.push(text); },
      subscribe: () => () => {}, dispose: async () => {},
    };
    let settleCalls = 0;
    const routing = routeFixDirectiveToMinion({
      registry: { getHandle: () => handle as never, spawn: async () => handle as never, disposeHandle: async () => {} },
      ledger: {
        listImplementerMinions: () => [minionRecord('minion-live', 'job-cancel', '/sessions/live.jsonl')],
        listAgents: () => [],
        registerAgent: (input) => minionRecord(input.id, input.jobId ?? null, input.sessionFile ?? null),
        getJob: () => null,
        getAgent: () => null,
      },
      worktrees: { listWorktrees: () => [lane] } as never,
      jobId: 'job-cancel',
      directive: 'fix the blocker',
      signal: controller.signal,
      retrySettlement: () => {
        settleCalls += 1;
        // Pre-prompt interlock resolves immediately; the POST-prompt
        // settlement waits — that pending wait is what cancellation must
        // observe instead of reporting a delivery.
        return settleCalls === 1 ? Promise.resolve('none' as const) : new Promise<'recovered'>(() => {});
      },
    });
    await vi.waitFor(() => expect(prompted).toHaveLength(1));
    controller.abort();
    await expect(routing).resolves.toEqual({ delivered: false, note: 'review operation aborted', admission: 'unknown' });
    expect(settleCalls).toBe(2);
  });

  it('a mid-wait abort on the fresh-minion path reports undelivered too', async () => {
    const controller = new AbortController();
    const prompted: string[] = [];
    const handle = {
      id: 'minion-fresh', sessionFile: '/sessions/fresh.jsonl',
      prompt: async (text: string) => { prompted.push(text); },
      dispose: async () => {},
    };
    const routing = routeFixDirectiveToMinion({
      registry: {
        getHandle: () => null,
        spawn: async () => handle as never,
        disposeHandle: async () => {},
      },
      ledger: {
        listImplementerMinions: () => [],
        listAgents: () => [],
        registerAgent: (input) => minionRecord(input.id, input.jobId ?? null, input.sessionFile ?? null),
        getJob: () => null,
        getAgent: () => null,
      },
      worktrees: { listWorktrees: () => [lane] } as never,
      jobId: 'job-cancel',
      directive: 'fix the blocker',
      signal: controller.signal,
      retrySettlement: () => new Promise<'recovered'>(() => {}),
    });
    await vi.waitFor(() => expect(prompted).toHaveLength(1));
    controller.abort();
    await expect(routing).resolves.toEqual({ delivered: false, note: 'review operation aborted', admission: 'unknown' });
  });

  it('a failed registration disposes the spawned directive worker and rethrows the registration error (2026-10-05 review)', async () => {
    const disposed: string[] = [];
    const registrationError = new Error('ledger registration rejected the row');
    const handle = {
      id: 'minion-unregistered', sessionFile: '/sessions/unregistered.jsonl',
      prompt: async () => { throw new Error('the prompt must never run when registration failed'); },
      dispose: async () => {},
    };
    await expect(
      routeFixDirectiveToMinion({
        registry: {
          getHandle: () => null,
          spawn: async () => handle as never,
          disposeHandle: async (disposedHandle: { id: string }) => { disposed.push(disposedHandle.id); },
        },
        ledger: {
          listImplementerMinions: () => [],
          listAgents: () => [],
          registerAgent: () => { throw registrationError; },
          getJob: () => null,
          getAgent: () => null,
        },
        worktrees: { listWorktrees: () => [lane] } as never,
        jobId: 'job-regfail',
        directive: 'fix the blocker',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('ledger registration rejected the row');
    // The spawned handle never survives a failed registration: an
    // unbound live worker is disposed exactly once, loudly.
    expect(disposed).toEqual(['minion-unregistered']);
  });

  it('a queued re-brief admission aborts on the service-stopping signal (r4 adversarial#5)', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'holder' });
    const controller = new AbortController();
    const routing = rebriefFreshMinion({
      registry: {
        getHandle: () => null,
        spawn: async () => { throw new Error('a queued re-brief must not spawn before admission'); },
        disposeHandle: async () => {},
      },
      ledger: {
        listImplementerMinions: () => [],
        listAgents: () => [],
        registerAgent: (input) => minionRecord(input.id, input.jobId ?? null, input.sessionFile ?? null),
        getJob: () => null,
        getAgent: () => null,
        setAgentState: (id) => minionRecord(id, 'job-cancel', null),
      },
      worktrees: { listWorktrees: () => [lane] } as never,
      jobId: 'job-cancel',
      note: 'resume',
      briefing: 'original contract',
      signal: controller.signal,
      workerGate: gate,
    });
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
    controller.abort();
    await expect(routing).rejects.toThrow(/aborted/);
    holder.release();
    expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
  });

  async function assertUnpromptedWorkerDisposed(failure: 'registration' | 'registration-publication' | 'binding' | 'rendering' | 'ownership'): Promise<void> {
    const disposed: string[] = [];
    const states: string[] = [];
    const prompted: string[] = [];
    let registered = false;
    const original = new Error(`${failure} failed`);
    const handle = {
      id: 'setup-worker', sessionFile: null,
      prompt: async (text: string) => { prompted.push(text); },
      dispose: async () => { disposed.push('setup-worker'); },
    };
    await expect(rebriefFreshMinion({
      registry: { getHandle: () => null, spawn: async () => handle as never, disposeHandle: async () => {} },
      ledger: {
        listImplementerMinions: () => [],
        listAgents: () => registered ? [minionRecord('setup-worker', 'job-cancel', null)] : [],
        registerAgent: (input) => {
          if (failure === 'registration') throw original;
          registered = true;
          if (failure === 'registration-publication') throw original;
          return minionRecord(input.id, input.jobId ?? null, input.sessionFile ?? null);
        },
        getJob: () => null,
        getAgent: () => null,
        setAgentState: (id, state) => { states.push(`${id}:${state}`); return minionRecord(id, 'job-cancel', null); },
      },
      worktrees: { listWorktrees: () => [lane] } as never,
      jobId: 'job-cancel', note: 'resume', briefing: 'contract',
      ...(failure === 'binding' ? { onSpawned: () => { throw original; } } : {}),
      ...(failure === 'rendering' ? { lessons: { referencesFor: () => { throw original; } } as never } : {}),
      ...(failure === 'ownership' ? { beforeTurnSideEffect: (() => {
        let checks = 0;
        return () => { if (++checks === 3) throw original; };
      })() } : {}),
    })).rejects.toBe(original);
    expect(disposed).toEqual(['setup-worker']);
    expect(states).toEqual(registered ? ['setup-worker:disposed'] : []);
    expect(prompted).toEqual([]);
  }

  it('disposes an unprompted worker when registration fails', async () => {
    await assertUnpromptedWorkerDisposed('registration');
  });
  it('marks a committed row disposed when registration publication fails', async () => {
    await assertUnpromptedWorkerDisposed('registration-publication');
  });
  it('disposes an unprompted worker when marker binding fails', async () => {
    await assertUnpromptedWorkerDisposed('binding');
  });
  it('disposes an unprompted worker when prompt rendering fails', async () => {
    await assertUnpromptedWorkerDisposed('rendering');
  });
  it('disposes an unprompted worker when final ownership fails', async () => {
    await assertUnpromptedWorkerDisposed('ownership');
  });

  it('a post-prompt abort on the re-brief path rejects before any delivery is recorded', async () => {
    const controller = new AbortController();
    const prompted: string[] = [];
    const handle = {
      id: 'minion-rebrief-cancel', sessionFile: '/sessions/rebrief-cancel.jsonl',
      prompt: async (text: string) => { prompted.push(text); },
      dispose: async () => {},
    };
    const routing = rebriefFreshMinion({
      registry: { getHandle: () => null, spawn: async () => handle as never, disposeHandle: async () => {} },
      ledger: {
        listImplementerMinions: () => [],
        listAgents: () => [],
        registerAgent: (input) => minionRecord(input.id, input.jobId ?? null, input.sessionFile ?? null),
        getJob: () => null,
        getAgent: () => null,
        setAgentState: (id) => minionRecord(id, 'job-cancel', null),
      },
      worktrees: { listWorktrees: () => [lane] } as never,
      jobId: 'job-cancel',
      note: 'resume',
      briefing: 'original contract',
      signal: controller.signal,
      retrySettlement: () => new Promise<'recovered'>(() => {}),
    });
    await vi.waitFor(() => expect(prompted).toHaveLength(1));
    controller.abort();
    await expect(routing).rejects.toThrow(/cancelled before its automatic retries settled/);
  });
});

describe('per-prompt terminal verdict capture (r5 blocker 1)', () => {
  const QUEUED_CAPS = {
    streaming: true,
    steer: 'queued' as const,
    resume: 'file' as const,
    images: false,
    thinking: false,
    thinkingLevelControl: false,
    followUp: false,
  };

  it('a resolved-but-errored directive turn with a queued successor still reports outcome error', async () => {
    // The REAL fallback wrapper (steer:'queued') pumps its queue in the
    // settle path, before its caller resumes; the successor therefore owns
    // the live session health by the time the router would read it. The
    // verdict must have been captured before that pump.
    let healthState: 'idle' | 'error' = 'idle';
    let healthError: string | null = null;
    const resolvers: Array<() => void> = [];
    const inner = {
      role: 'minion' as const,
      id: 'inner-queued',
      sessionFile: null,
      capabilities: QUEUED_CAPS,
      prompt: () => new Promise<void>((resolve) => resolvers.push(resolve)),
      async steer() {},
      async followUp() {},
      subscribe() {
        return () => {};
      },
      health() {
        return {
          state: healthState,
          lastActivity: null,
          sessionFile: null,
          ...(healthError === null ? {} : { error: healthError }),
        };
      },
      async dispose() {},
    };
    const runtime = withFallbacks({
      id: 'queued-fake',
      capabilities: QUEUED_CAPS,
      spawn: async () => inner,
      health: () => ({ state: 'ok' as const }),
      dispose: async () => {},
    } as unknown as AgentRuntime);
    const handle = await runtime.spawn('minion');
    try {
      const routing = routeFixDirectiveToMinion({
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
        ledger: {
          getAgent: () => null,
          listAgents: () => [{ id: 'inner-queued', jobId: 'job-queued', role: 'minion', sessionFile: null }],
          listImplementerMinions: () => [{ id: 'inner-queued', jobId: 'job-queued', role: 'minion', sessionFile: null }],
          registerAgent: () => {},
          getJob: () => null,
        } as never,
        worktrees: {} as never,
        jobId: 'job-queued',
        directive: 'fix the race',
        signal: new AbortController().signal,
      });
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      // A successor is queued while the directive turn is live.
      const successor = handle.prompt('queued successor', { owner: 'other' });
      // The directive turn ends in an in-band error; the successor starts
      // inside the settle path and clears the session health.
      healthState = 'error';
      healthError = 'assistant stopReason error';
      resolvers[0]!();
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));
      healthState = 'idle';
      healthError = null;
      resolvers[1]!();
      await successor;
      await expect(routing).resolves.toEqual({
        delivered: true,
        minionId: 'inner-queued',
        outcome: 'error',
        error: 'assistant stopReason error',
      });
    } finally {
      await handle.dispose();
    }
  });
});
