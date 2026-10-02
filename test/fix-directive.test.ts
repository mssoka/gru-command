import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebriefFreshMinion, recordFollowUpDelivery, renderRebriefPrompt, routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { PR_CREATION_RULE } from '../src/dispatch/pr-creation.js';
import type { WorktreeLane } from '../src/dispatch/worktree-port.js';
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
    expect(prompted[0]).toBe(`fix the blocker\n\n${PR_CREATION_RULE}`); // resumed session gets the directive (never the re-brief wrapper), now carrying the current non-draft PR rule
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
        listAgents: () => [{ id: 'minion-live', role: 'minion', jobId: 'job-live', sessionFile: null }],
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
        listAgents: () => [minionRecord('minion-live', 'job-cancel', '/sessions/live.jsonl')],
        registerAgent: (input) => minionRecord(input.id, input.jobId ?? null, input.sessionFile ?? null),
        getJob: () => null,
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
    await expect(routing).resolves.toEqual({ delivered: false, note: 'review operation aborted' });
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
        listAgents: () => [],
        registerAgent: (input) => minionRecord(input.id, input.jobId ?? null, input.sessionFile ?? null),
        getJob: () => null,
      },
      worktrees: { listWorktrees: () => [lane] } as never,
      jobId: 'job-cancel',
      directive: 'fix the blocker',
      signal: controller.signal,
      retrySettlement: () => new Promise<'recovered'>(() => {}),
    });
    await vi.waitFor(() => expect(prompted).toHaveLength(1));
    controller.abort();
    await expect(routing).resolves.toEqual({ delivered: false, note: 'review operation aborted' });
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
        listAgents: () => [],
        registerAgent: (input) => minionRecord(input.id, input.jobId ?? null, input.sessionFile ?? null),
        getJob: () => null,
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
        listAgents: () => [],
        registerAgent: (input) => minionRecord(input.id, input.jobId ?? null, input.sessionFile ?? null),
        getJob: () => null,
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
