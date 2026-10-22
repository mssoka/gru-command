import { standaloneFixtureLedger } from './helpers/fixture-handoff.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectiveDispatchDeferredError, DirectiveRoutingContractError, rebriefFreshMinion, recordFollowUpDelivery, renderRebriefPrompt, routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi, type ObligationRecord } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { withFallbacks } from '../src/runtime/fallbacks.js';
import type { AgentHandle, AgentRuntime } from '../src/runtime/types.js';
import { appendWorkerRules } from '../src/dispatch/worker-rules.js';
import type { WorktreeLane, WorktreePort } from '../src/dispatch/worktree-port.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { PacingGate, RetrySettlementUnavailableError, type RetrySettlement } from '../src/runtime/pacing.js';
import { admitBlindReview, blindCoverageOf, observeBlindSessionAccess, recordBlindAdmission, BLIND_ACCESS_EVENT } from '../src/dispatch/blind-review.js';
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
            parentJobId: null,
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
  it('releases a paced existing-handle directive when job is binned while queued', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-fix-pacing-bin-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    let holder: Awaited<ReturnType<typeof gate.acquireWorkerTurn>> | null = null;
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: 'job-1', repo: 'fixture', title: 'Paced lane' });
      ledger.setJobStatus('job-1', 'working');
      ledger.registerAgent({ id: 'idle-implementer', role: 'minion', jobId: 'job-1' });
      ledger.setAgentState('idle-implementer', 'idle');
      let prompted = false;
      const handle = {
        id: 'idle-implementer', role: 'minion', sessionFile: null,
        async prompt() { prompted = true; },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile: null }; },
        async dispose() {},
      } satisfies AgentHandle;
      holder = await gate.acquireWorkerTurn({ id: 'another-job', label: 'holder' });
      const routing = routeFixDirectiveToMinion({
        jobId: 'job-1', directive: 'now obsolete', signal: new AbortController().signal,
        ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
        workerGate: gate,
      });
      await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
      ledger.setJobStatus('job-1', 'binned');
      holder.release();
      holder = null;
      await expect(routing).rejects.toThrow(/directive refused.*binned/u);
      expect(prompted).toBe(false);
      expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
      const next = await gate.acquireWorkerTurn({ id: 'next-job', label: 'not stranded' });
      next.release();
      expect(gate.view().worker.running).toBe(0);
    } finally {
      holder?.release();
      db.close();
    }
  });

  it('a resident minion that has replied and only waits on background work ends that wait before the message takes a worker slot (#471 follow-up)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-fix-background-wait-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    // The replied turn still holds the only worker slot until its CLI is gone.
    let waitingTurn: Awaited<ReturnType<typeof gate.acquireWorkerTurn>> | null = await gate.acquireWorkerTurn({ id: 'job-1', label: 'replied, waiting on npm run dev' });
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: 'job-1', repo: 'fixture', title: 'Waiting lane' });
      ledger.setJobStatus('job-1', 'working');
      ledger.registerAgent({ id: 'waiting-implementer', role: 'minion', jobId: 'job-1' });
      const order: string[] = [];
      let waiting = true;
      const handle = {
        id: 'waiting-implementer', role: 'minion', sessionFile: null,
        async prompt() { order.push('prompt'); },
        turnAnswered: () => waiting,
        endBackgroundWait: async () => {
          order.push('end wait');
          waiting = false;
          waitingTurn?.release();
          waitingTurn = null;
        },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile: null }; },
        async dispose() {},
      } satisfies AgentHandle;
      const route = (refuse: boolean) => {
        return routeFixDirectiveToMinion({
          jobId: 'job-1', directive: 'rebase on main', signal: new AbortController().signal,
          ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
          registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
          workerGate: gate,
          // The producer fences refuse a session whose turn is still open.
          beforeTurnSideEffect: () => { if (waiting) throw new Error('directive producer fences: open turn'); },
          beforeWriterSideEffect: () => { if (refuse) throw new Error('coverage identity changed'); },
        });
      };
      // A message refused anyway never costs the minion its background work,
      // and its refusal is still the fences' own.
      await expect(route(true)).rejects.toThrow(/directive producer fences: open turn/u);
      expect(order).toEqual([]);
      const routed = await route(false);
      expect(routed.delivered).toBe(true);
      expect(order).toEqual(['end wait', 'prompt']);
    } finally {
      waitingTurn?.release();
      db.close();
    }
  });

  it('a message for a minion still working tells its turn to skip the wait at its reply (#471 follow-up)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-fix-background-working-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: 'job-1', repo: 'fixture', title: 'Working lane' });
      ledger.setJobStatus('job-1', 'working');
      ledger.registerAgent({ id: 'working-implementer', role: 'minion', jobId: 'job-1' });
      const order: string[] = [];
      const handle = {
        id: 'working-implementer', role: 'minion', sessionFile: null,
        async prompt() { order.push('prompt'); },
        // Still working: nothing is answered yet, so nothing is stopped now.
        turnAnswered: () => false,
        endBackgroundWait: async () => { order.push('skip the wait'); },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile: null }; },
        async dispose() {},
      } satisfies AgentHandle;
      const routed = await routeFixDirectiveToMinion({
        jobId: 'job-1', directive: 'also update the docs', signal: new AbortController().signal,
        ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
      });
      expect(routed.delivered).toBe(true);
      expect(order).toEqual(['skip the wait', 'prompt']);
    } finally {
      db.close();
    }
  });

  it('a re-brief ends the prior minion\'s answered wait before its fences and its cleanup (#471 follow-up)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-fix-background-rebrief-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: 'job-1', repo: 'fixture', title: 'Re-briefed lane' });
      ledger.setJobStatus('job-1', 'working');
      ledger.registerAgent({ id: 'waiting-prior', role: 'minion', jobId: 'job-1' });
      const order: string[] = [];
      let waiting = true;
      const base = {
        role: 'minion', sessionFile: null,
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile: null }; },
        async dispose() {},
      } as const;
      const prior = {
        ...base, id: 'waiting-prior',
        async prompt() { order.push('prior prompt'); },
        turnAnswered: () => waiting,
        endBackgroundWait: async () => { order.push('end wait'); waiting = false; },
        cessationEvidence: () => 'ceased' as const,
      } satisfies AgentHandle;
      const fresh = { ...base, id: 'fresh-minion', async prompt() { order.push('fresh prompt'); } } satisfies AgentHandle;
      const routed = await routeFixDirectiveToMinion({
        jobId: 'job-1', directive: 'start over from the contract', signal: new AbortController().signal, freshSession: true,
        ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: {
          getHandle: (id: string) => (id === 'waiting-prior' ? prior : null),
          spawn: async () => fresh,
          disposeHandle: async (handle: AgentHandle) => { order.push(`dispose ${handle.id}`); },
        },
        // The producer fences refuse a session whose turn is still open.
        beforeTurnSideEffect: () => { if (waiting) throw new Error('directive producer fences: open turn'); },
      });
      expect(routed.delivered).toBe(true);
      expect(order).toEqual(['end wait', 'dispose waiting-prior', 'fresh prompt']);
    } finally {
      db.close();
    }
  });

  it('refuses a freshly binned lane after asynchronous spawn, disposing before prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-fix-bin-race-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: 'job-1', repo: 'fixture', title: 'Lane to discard' });
      ledger.setJobStatus('job-1', 'working');
      let prompted = false;
      let disposed = false;
      const handle = {
        id: 'late-directive-worker', role: 'minion', sessionFile: null,
        async prompt() { prompted = true; },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile: null }; },
        async dispose() { disposed = true; },
      } satisfies AgentHandle;
      await expect(routeFixDirectiveToMinion({
        jobId: 'job-1', directive: 'obsolete directive', signal: new AbortController().signal,
        ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: {
          getHandle: () => null,
          spawn: async () => {
            ledger.setJobStatus('job-1', 'binned');
            return handle;
          },
          disposeHandle: async () => {},
        },
      })).rejects.toThrow(/directive refused.*binned/u);
      expect(prompted).toBe(false);
      expect(disposed).toBe(true);
      expect(ledger.getJob('job-1')?.status).toBe('binned');
      expect(ledger.getAgent(handle.id)).toBeNull();
    } finally {
      db.close();
    }
  });

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

it('P40 preserves historical native HEADs without labeling them current candidates when no live lane matches', () => {
  const appendCustomEvent = vi.fn<LedgerApi['appendCustomEvent']>().mockReturnValue({ seq: 1 } as ReturnType<LedgerApi['appendCustomEvent']>);
  const getJob = vi.fn(() => null); const openReportObligation = vi.fn();
  const ledger = { appendCustomEvent, getJob, openReportObligation };
  const worktrees = new InMemoryWorktreePort(join(tmpdir(), 'P40-no-lane-sampling'));
  const deliver = (sha: string | null) => recordFollowUpDelivery({ ledger, worktrees, jobId: 'P40-original', agentId: 'original-minion', source: 'silas-directive', workRevision: 1,
    nativeCompletion: { sha, provenance: { original: 'immutable original receipt' } } });
  for (const sha of ['a'.repeat(41), 'b'.repeat(48), 'c'.repeat(63), { toString: () => 'a'.repeat(40) } as unknown as string]) {
    expect(() => deliver(sha)).toThrow(/exact 40\/64/);
    expect(appendCustomEvent).not.toHaveBeenCalled(); expect(getJob).not.toHaveBeenCalled(); expect(openReportObligation).not.toHaveBeenCalled();
  }
  for (const sha of ['a'.repeat(40), 'b'.repeat(64), null]) {
    const result = deliver(sha);
    expect(result.sha).toBe(sha);
    expect(appendCustomEvent).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sha, candidate_delivery_proven: false }) }));
    if (sha !== null) expect(result.note).toMatch(/no unique live job lane/u);
  }
});

it('P40 marks original native HEAD as a candidate only on one matching clean unswept job lane', async () => {
  const repo = makeFixtureRepo('P40-native-current-candidate'); cleanupRepos.push(repo);
  const root = mkdtempSync(join(tmpdir(), 'gru-command-native-current-candidate-')); cleanupDirs.push(root);
  const backing = new InMemoryWorktreePort(root, standaloneFixtureLedger('P40-current'));
  const lane = await backing.createJobWorktree({ repoPath: repo.path, jobId: 'P40-current' });
  const head = execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let lanes: readonly WorktreeLane[] = [lane];
  const worktrees = { listWorktrees: () => lanes };
  const appendCustomEvent = vi.fn<LedgerApi['appendCustomEvent']>().mockReturnValue({ seq: 1 } as ReturnType<LedgerApi['appendCustomEvent']>);
  const ledger = { appendCustomEvent, getJob: () => null, openReportObligation: vi.fn() };
  // Unit-level original cwd evidence is recorded before any delivery. The
  // ledger/native integration suites own terminal and physical proof.
  const sessionFile = join(root, 'original-native.jsonl'); const sessionId = 'original-native-session';
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId, cwd: lane.path })}\n`);
  const deliver = () => recordFollowUpDelivery({ ledger, worktrees, jobId: 'P40-current', agentId: 'original-minion', source: 'silas-directive', workRevision: 1,
    nativeCompletion: { sha: head, provenance: { original: 'immutable completion receipt',
      binding: { sessionFile, sessionId, agentId: 'original-minion' } } } });
  expect(deliver().sha).toBe(head);
  expect(appendCustomEvent).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sha: head, candidate_delivery_proven: true }) }));
  // An untracked input alone — HEAD unchanged, tracked tree clean — is no proven candidate either (#363 S08-0-02).
  writeFileSync(join(lane.path, 'untracked-input.ts'), 'export const extra = 1;\n');
  let untracked: ReturnType<typeof deliver>;
  try { untracked = deliver(); } finally { rmSync(join(lane.path, 'untracked-input.ts')); }
  expect(untracked.sha).toBe(head); expect(untracked.note).toMatch(/untracked inputs are present/u);
  expect(appendCustomEvent).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sha: head, candidate_delivery_proven: false }) }));
  writeFileSync(join(lane.path, 'src/main.ts'), 'export function answer(): number { return 43; }\n');
  const dirty = deliver();
  expect(dirty.sha).toBe(head); expect(dirty.note).toMatch(/tracked tree is dirty/u);
  expect(appendCustomEvent).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sha: head, candidate_delivery_proven: false }) }));
  writeFileSync(join(lane.path, 'src/main.ts'), 'export function answer(): number {\n  return 42;\n}\n');
  writeFileSync(join(lane.path, 'moved.txt'), 'moved\n');
  execFileSync('git', ['-C', lane.path, 'add', 'moved.txt']);
  execFileSync('git', ['-C', lane.path, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'move current head'], { stdio: 'ignore' });
  const moved = deliver();
  expect(moved.sha).toBe(head); expect(moved.note).toMatch(/HEAD moved/u);
  expect(appendCustomEvent).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sha: head, candidate_delivery_proven: false }) }));
  lanes = [{ ...lane, status: 'swept' as const }];
  expect(deliver().note).toMatch(/no unique live job lane/u);
  lanes = [];
  expect(deliver().note).toMatch(/no unique live job lane/u);
});

describe('recordFollowUpDelivery (the loop-closing signal)', () => {
  it('records job.delivered with the lane head the settled turn produced', async () => {
    const repo = makeFixtureRepo('fixture-followup-delivery');
    cleanupRepos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'gru-command-followup-lanes-'));
    cleanupDirs.push(root);
    const worktrees = new InMemoryWorktreePort(root, standaloneFixtureLedger('job-1'));
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
      workRevision: 0,
    });
    expect(result.sha).toBe(head);
    expect(result.lanePath).toBe(lane.path);
    expect(result.note).toBeNull();
    expect(ledger.events).toEqual([
      { kind: 'job.delivered', jobId: 'job-1', payload: { agentId: 'minion-1', source: 'silas-directive', sha: head, work_revision: 0 } },
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
      workRevision: 0,
    });
    expect(result.sha).toBeNull();
    expect(result.note).toContain('lane head unresolved');
    expect(ledger.events).toEqual([
      { kind: 'job.delivered', jobId: 'job-1', payload: { agentId: null, source: 'silas-rebrief', sha: null, work_revision: 0 } },
    ]);
  });

  it('resolves the head from the ACTIVE job lane, never a swept one', async () => {
    const repo = makeFixtureRepo('fixture-followup-active-lane');
    cleanupRepos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'gru-command-followup-active-'));
    cleanupDirs.push(root);
    const worktrees = new InMemoryWorktreePort(root, standaloneFixtureLedger('job-1'));
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
      workRevision: 0,
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
      workRevision: 0,
    });
    expect(result.sha).toBeNull();
    expect(result.lanePath).toBeNull();
    expect(result.note).toContain('no job lane');
    expect(ledger.events[0]?.payload).toEqual({ agentId: 'minion-3', source: 'silas-rebrief', sha: null, work_revision: 0 });
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

  it('refuses a native directive turn without onPrepared before any spawn or prompt (#362)', async () => {
    const { registry, controller, calls, prompted } = stubRegistry(null);
    // Every ledger read throws: the refusal precedes any effect at all.
    const untouched = () => { throw new Error('the ledger must not be touched'); };
    const ledger = { getAgent: untouched, listAgents: untouched, listImplementerMinions: untouched, registerAgent: untouched, getJob: untouched };
    const refusal: unknown = await routeFixDirectiveToMinion({
      registry: registry as never, ledger: ledger as never, worktrees: { listWorktrees: () => [] } as unknown as WorktreePort,
      jobId: 'job-no-prepare', directive: 'repair', signal: controller.signal,
      directiveTurn: { identity: {} as never, beforeAdmission: () => {}, onAdmitted: () => {} },
    }).then(() => null, (error: unknown) => error);
    expect(refusal, 'the route refused').not.toBeNull();
    expect(refusal).toBeInstanceOf(DirectiveRoutingContractError);
    expect((refusal as Error).message).toMatch(/^job "job-no-prepare": a native directive turn needs onPrepared/u);
    expect(calls).toEqual([]);
    expect(prompted).toEqual([]);
  });

  it('a guard stop after a positively ceased prior cleanup is a deferral; an uncertain cleanup never is (#363 S08-0-01)', async () => {
    for (const evidence of ['ceased', 'unknown', 'no-evidence', 'disposal-failed'] as const) {
      const disposed: string[] = [];
      const prior = {
        id: 'minion-prior', role: 'minion' as const, sessionFile: '/sessions/prior.jsonl', capabilities: CAPS,
        health: () => ({ state: 'idle', lastActivity: null, sessionFile: '/sessions/prior.jsonl' }),
        prompt: async () => {}, steer: async () => {}, followUp: async () => {}, subscribe: () => () => {}, dispose: async () => {},
        ...(evidence === 'no-evidence' ? {} : { cessationEvidence: () => (evidence === 'disposal-failed' ? 'unknown' : evidence) }),
      };
      const spawned: string[] = [];
      const registry = {
        getHandle: () => prior,
        disposeHandle: async (handle: { id: string }) => { disposed.push(handle.id); if (evidence === 'disposal-failed') throw new Error('disposal failed'); },
        spawn: async (role: string) => { spawned.push(role); throw new Error('no spawn is expected'); },
      };
      const ledger = {
        getAgent: () => null, listAgents: () => [], registerAgent: () => {}, getJob: () => ({ briefing: 'original contract' }),
        listImplementerMinions: () => [{ id: 'minion-prior', role: 'minion', jobId: 'job-deferral', sessionFile: '/sessions/prior.jsonl' }],
      };
      let guards = 0;
      const outcome: unknown = await routeFixDirectiveToMinion({
        registry: registry as never, ledger: ledger as never, worktrees: { listWorktrees: () => [] } as unknown as WorktreePort,
        jobId: 'job-deferral', directive: 'repair', freshSession: true, signal: new AbortController().signal,
        directiveTurn: { identity: {} as never, beforeAdmission: () => {}, onAdmitted: () => {} }, onPrepared: () => {},
        // The first guard admits the cleanup; the one after it stops the route.
        beforeTurnSideEffect: () => { guards += 1; if (guards === 2) throw new Error('authority moved'); },
      }).then(() => null, (error: unknown) => error);
      expect(disposed, evidence).toEqual(['minion-prior']);
      expect(spawned, evidence).toEqual([]);
      if (evidence === 'ceased') {
        // The prior session is proven gone: nothing of this request ran, so the stop defers.
        expect(outcome).toBeInstanceOf(DirectiveDispatchDeferredError);
      } else {
        // Unknown, absent or failed cleanup is never a deferral.
        expect(outcome, evidence).not.toBeInstanceOf(DirectiveDispatchDeferredError);
        expect(String(outcome), evidence).toMatch(evidence === 'disposal-failed' ? /disposal failed/u : /retains unproven producer ownership/u);
      }
    }
  });

  it('falls through a typed eviction rejection and resumes the FAILING logical session', async () => {
    const { WorkerDisposalInProgressError } = await import('../src/runtime/registry.js');
    const { registry, controller, calls } = stubRegistry(new WorkerDisposalInProgressError());
    const root = mkdtempSync(join(tmpdir(), 'fix-directive-evict-'));
    const worktrees = new InMemoryWorktreePort(root, standaloneFixtureLedger('job-evict'));
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
    const worktrees = new InMemoryWorktreePort(root, standaloneFixtureLedger('job-resume'));
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
      worktrees: { listWorktrees: () => [] } as never,
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

function activeJobRecord(id: string): NonNullable<ReturnType<LedgerApi['getJob']>> {
  return { ...fakeLedger().getJob('job-1')!, id, status: 'working' };
}

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
        getJob: () => activeJobRecord('job-cancel'),
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
        getJob: () => activeJobRecord('job-cancel'),
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
          getJob: () => activeJobRecord('job-regfail'),
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

  it('observes the settled turn on the exhaustion failure exit too — the scan precedes the throw (issue #339 P1)', async () => {
    const observed: { jobId: string; sessionFile: string | null }[] = [];
    const handle = {
      id: 'minion-scan-exhausted', sessionFile: '/sessions/scan.jsonl',
      prompt: async () => {},
      dispose: async () => {},
    };
    await expect(rebriefFreshMinion({
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
      briefing: 'contract',
      retrySettlement: async () => 'exhausted',
      observeBlindTurn: (jobId, sessionFile) => { observed.push({ jobId, sessionFile }); },
    })).rejects.toThrow(/automatic rate-limit retry exhausted/);
    // The observer ran BEFORE the failure exit: without this, a continuation
    // that fails before delivery leaves its prohibited reads unscanned.
    expect(observed).toEqual([{ jobId: 'job-cancel', sessionFile: '/sessions/scan.jsonl' }]);
  });

  it('a prohibited read appended by an abandoned retry turn is observed after cancellation (issue #339 N2)', async () => {
    const controller = new AbortController();
    const prompted: string[] = [];
    const observed: { jobId: string; sessionFile: string | null }[] = [];
    const handle = {
      id: 'minion-rebrief-abandoned', sessionFile: '/sessions/rebrief-abandoned.jsonl',
      prompt: async (text: string) => { prompted.push(text); },
      dispose: async () => {},
    };
    let releaseRetry: () => void = () => {};
    const retrySettled = new Promise<void>((resolve) => { releaseRetry = resolve; });
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
      retrySettlement: async () => { await retrySettled; return 'recovered'; },
      observeBlindTurn: (jobId, sessionFile) => { observed.push({ jobId, sessionFile }); },
    });
    await vi.waitFor(() => expect(prompted).toHaveLength(1));
    controller.abort();
    await expect(routing).rejects.toThrow(/cancelled before its automatic retries settled/);
    // The immediate scan ran before the abandoned retry turn settled.
    expect(observed).toHaveLength(1);
    // The retry turn settles AFTER the cancellation; its reads must still be
    // observed, so a final scan is chained onto the abandoned settlement.
    releaseRetry();
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    expect(observed[1]).toEqual({ jobId: 'job-cancel', sessionFile: '/sessions/rebrief-abandoned.jsonl' });
  });

  it('a settlement-hook rejection still observes the delivered turn before the named error propagates (issue #339 N3)', async () => {
    const observed: { jobId: string; sessionFile: string | null }[] = [];
    const handle = {
      id: 'minion-rebrief-hookfault', sessionFile: '/sessions/rebrief-hookfault.jsonl',
      prompt: async () => {},
      dispose: async () => {},
    };
    await expect(rebriefFreshMinion({
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
      retrySettlement: async () => { throw new Error('settlement hook fault'); },
      observeBlindTurn: (jobId, sessionFile) => { observed.push({ jobId, sessionFile }); },
    })).rejects.toThrow(RetrySettlementUnavailableError);
    // The prompt already ran: the scan must precede the named hook-fault error.
    expect(observed).toEqual([{ jobId: 'job-cancel', sessionFile: '/sessions/rebrief-hookfault.jsonl' }]);
  });
});

describe('directive-driven resume blind observation (issue #339 D1)', () => {
  const TARGET = 'a'.repeat(40);
  const PROHIBITED = `${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: 'docs/issues/305-review.md:1:prior assessment' } })}\n`;

  function blindDirectiveLedger(jobId: string, agentId: string, sessionFile: string): { ledger: LedgerApi; dispose(): void } {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-directive-blind-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    ledger.addJob({ id: jobId, repo: 'fixture', title: 'direct blind review' });
    ledger.setJobStatus(jobId, 'working');
    // A directly admitted blind review is a TOP-LEVEL minion (no round/lens
    // binding): it survives listImplementerMinions, so the directive router is
    // a real continuation seam for it.
    ledger.registerAgent({ id: agentId, role: 'minion', jobId, sessionFile });
    const admission = admitBlindReview({
      ledger, jobId, title: 'review (blind)', deliverable: 'review',
      briefing: 'Review the immutable package read-only.', targetSha: TARGET, repoName: 'fixture',
      inputPackage: { baseSha: 'b'.repeat(40), targetSha: TARGET, files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }] },
    });
    if (admission === null) throw new Error(`job "${jobId}" was not admitted as a blind review`);
    recordBlindAdmission(ledger, jobId, admission);
    return { ledger, dispose: () => db.close() };
  }

  it('observes a RESUMED directive fallback session and invalidates blind coverage', async () => {
    const jobId = 'job-blind-directive';
    const priorId = 'prior-reviewer';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-directive-blind-resume-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'prior.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = blindDirectiveLedger(jobId, priorId, sessionFile);
    try {
      let resumedFile: string | null | undefined;
      const handle = {
        id: 'resumed-reviewer', role: 'minion', sessionFile,
        async prompt() { appendFileSync(sessionFile, PROHIBITED); },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile }; },
        async dispose() {},
      } satisfies AgentHandle;
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'qualifying', qualifying: true, accessObserved: false });
      const outcome = await routeFixDirectiveToMinion({
        jobId, directive: 'continue the review', signal: new AbortController().signal,
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: {
          getHandle: () => null,
          spawn: async (_role, options) => { resumedFile = options?.resumeFile ?? null; return handle; },
          disposeHandle: async () => {},
        },
        observeBlindTurn: (observedJobId, observedSession) => observeBlindSessionAccess(h.ledger, observedJobId, observedSession),
      });
      expect(resumedFile).toBe(sessionFile);
      expect(outcome.delivered).toBe(true);
      // Without the directive-routing observer the resumed blind reviewer's
      // prohibited read would leave coverage qualifying (and reuse-steering).
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
        state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
      });
    } finally {
      h.dispose();
    }
  });

  it('observes a LIVE directive continuation session and invalidates blind coverage', async () => {
    const jobId = 'job-blind-directive-live';
    const agentId = 'live-reviewer';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-directive-blind-live-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'live.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = blindDirectiveLedger(jobId, agentId, sessionFile);
    try {
      const handle = {
        id: agentId, role: 'minion', sessionFile,
        async prompt() { appendFileSync(sessionFile, PROHIBITED); },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile }; },
        async dispose() {},
      } satisfies AgentHandle;
      const outcome = await routeFixDirectiveToMinion({
        jobId, directive: 'continue the review', signal: new AbortController().signal,
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
        observeBlindTurn: (observedJobId, observedSession) => observeBlindSessionAccess(h.ledger, observedJobId, observedSession),
      });
      expect(outcome).toMatchObject({ delivered: true, minionId: agentId });
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
        state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
      });
    } finally {
      h.dispose();
    }
  });

  it('F4: a pre-aborted settlement observes its deferred retry tail and invalidates coverage', async () => {
    const jobId = 'job-blind-prebort';
    const agentId = 'minion-blind-prebort';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-directive-blind-prebort-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'session.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = blindDirectiveLedger(jobId, agentId, sessionFile);
    try {
      // Shutdown already landed when the settlement call runs: the pre-aborted
      // branch of settleRetries returns 'cancelled' and hands off the STILL
      // RUNNING retry settlement.
      const controller = new AbortController();
      controller.abort();
      let completeRetry: () => void = () => {};
      const physicalRetry = new Promise<RetrySettlement>((resolve) => { completeRetry = () => resolve('recovered'); });
      const handle = {
        id: agentId, role: 'minion', sessionFile,
        async prompt() { /* the initial prompt ran; its retry completion is deferred */ },
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle' as const, lastActivity: null, sessionFile }; },
        async dispose() {},
      } satisfies AgentHandle;
      const routing = rebriefFreshMinion({
        registry: { getHandle: () => null, spawn: async () => handle, disposeHandle: async () => {} },
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        jobId, note: 'resume', briefing: 'contract', signal: controller.signal,
        retrySettlement: () => physicalRetry,
        observeBlindTurn: (observedJobId, observedSession) => observeBlindSessionAccess(h.ledger, observedJobId, observedSession),
      });
      await expect(routing).rejects.toThrow(/cancelled before its automatic retries settled/);
      // The retry turn physically completes AFTER the cancelled settlement
      // returned: it appends the prohibited read, then its settlement resolves —
      // the chained final observation must catch it.
      appendFileSync(sessionFile, PROHIBITED);
      completeRetry();
      await vi.waitFor(() => {
        expect(blindCoverageOf(h.ledger, jobId).state).toBe('invalidated');
      }, { timeout: 5_000 });
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
        state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
      });
    } finally {
      h.dispose();
    }
  });
});

describe('directive continuation physical-tail observation (issue #339 D1 tail)', () => {
  const TARGET = 'a'.repeat(40);
  const PERMITTED = 'src/feature.ts:1:export const feature = 1;';
  const PROHIBITED = `${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: 'docs/issues/305-review.md:1:prior assessment' } })}\n`;

  function observedSessionLedger(jobId: string, agentId: string, sessionFile: string, opts: { admit: boolean }): { ledger: LedgerApi; dispose: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-tail-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    ledger.addJob({ id: jobId, repo: 'fixture', title: 'directive lane' });
    ledger.setJobStatus(jobId, 'working');
    ledger.registerAgent({ id: agentId, role: 'minion', jobId, sessionFile });
    if (opts.admit) {
      const admission = admitBlindReview({
        ledger, jobId, title: 'review (blind)', deliverable: 'review',
        briefing: 'Review the immutable package read-only.', targetSha: TARGET, repoName: 'fixture',
        inputPackage: { baseSha: 'b'.repeat(40), targetSha: TARGET, files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }] },
      });
      if (admission === null) throw new Error(`job "${jobId}" was not admitted as a blind review`);
      recordBlindAdmission(ledger, jobId, admission);
    }
    return { ledger, dispose: () => db.close() };
  }

  const CAPS = { streaming: true, steer: 'native' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

  function tailHandle(input: {
    id: string; sessionFile: string; onPrompt: () => void | Promise<void>; gates?: Promise<void>;
  }) {
    return {
      id: input.id, role: 'minion' as const, sessionFile: input.sessionFile, capabilities: CAPS,
      async prompt() { await input.onPrompt(); if (input.gates !== undefined) await input.gates; },
      async steer() {}, async followUp() {},
      subscribe() { return () => {}; },
      health() { return { state: 'idle' as const, lastActivity: null, sessionFile: input.sessionFile }; },
      async dispose() {},
    } satisfies AgentHandle;
  }

  const observed = (ledger: LedgerApi) => (jobId: string, sessionFile: string | null) => observeBlindSessionAccess(ledger, jobId, sessionFile);

  it('LIVE: an abort after the prompt started does not skip the physical prompt\'s later prohibited read (no retry)', async () => {
    const jobId = 'job-tail-live';
    const agentId = 'tail-live';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-tail-live-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'live.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = observedSessionLedger(jobId, agentId, sessionFile, { admit: true });
    try {
      const controller = new AbortController();
      let started = false;
      let promptCalls = 0;
      let release: () => void = () => {};
      const physicalGate = new Promise<void>((resolve) => { release = resolve; });
      const handle = tailHandle({
        id: agentId, sessionFile,
        onPrompt: () => { promptCalls += 1; started = true; return undefined; },
        gates: physicalGate,
      });
      let settleCalls = 0;
      const routing = routeFixDirectiveToMinion({
        jobId, directive: 'continue the review', signal: controller.signal, owner: 'test',
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
        // Pre-prompt interlock resolves; the POST-prompt settlement is pending,
        // so cancellation wins as 'cancelled' and NO retry turn ever runs.
        retrySettlement: () => (++settleCalls === 1 ? Promise.resolve('none' as const) : new Promise<RetrySettlement>(() => {})),
        observeBlindTurn: observed(h.ledger),
      });
      await vi.waitFor(() => expect(started).toBe(true));
      controller.abort();
      const outcome = await routing;
      expect(outcome).toMatchObject({ delivered: false, admission: 'unknown' });
      expect(promptCalls).toBe(1);
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'qualifying', accessObserved: false });
      // The still-running physical prompt now reads prohibited material.
      appendFileSync(sessionFile, PROHIBITED);
      release();
      await vi.waitFor(() => expect(blindCoverageOf(h.ledger, jobId).state).toBe('invalidated'), { timeout: 5_000 });
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1 });
      expect(promptCalls).toBe(1); // no retry healed it
    } finally {
      h.dispose();
    }
  });

  it('RESUMED: an abort after the fallback prompt started still observes its physical read (no retry)', async () => {
    const jobId = 'job-tail-resumed';
    const agentId = 'tail-resumed';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-tail-resumed-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'resumed.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = observedSessionLedger(jobId, agentId, sessionFile, { admit: true });
    try {
      const controller = new AbortController();
      let started = false;
      let promptCalls = 0;
      let release: () => void = () => {};
      const physicalGate = new Promise<void>((resolve) => { release = resolve; });
      const handle = tailHandle({
        id: 'resumed-tail', sessionFile,
        onPrompt: () => { promptCalls += 1; started = true; return undefined; },
        gates: physicalGate,
      });
      const routing = routeFixDirectiveToMinion({
        jobId, directive: 'continue the review', signal: controller.signal, owner: 'test',
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => null, spawn: async () => handle, disposeHandle: async () => {} },
        retrySettlement: () => new Promise<RetrySettlement>(() => {}),
        observeBlindTurn: observed(h.ledger),
      });
      await vi.waitFor(() => expect(started).toBe(true));
      controller.abort();
      const outcome = await routing;
      expect(outcome).toMatchObject({ delivered: false, admission: 'unknown' });
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'qualifying', accessObserved: false });
      appendFileSync(sessionFile, PROHIBITED);
      release();
      await vi.waitFor(() => expect(blindCoverageOf(h.ledger, jobId).state).toBe('invalidated'), { timeout: 5_000 });
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1 });
      expect(promptCalls).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it('HOOK FAULT: a completed directive prompt is observed even when the settlement hook throws a named error', async () => {
    const jobId = 'job-tail-hookfault';
    const agentId = 'tail-hookfault';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-tail-hookfault-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'hookfault.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = observedSessionLedger(jobId, agentId, sessionFile, { admit: true });
    try {
      const handle = tailHandle({
        id: agentId, sessionFile,
        // The prompt COMPLETES (reads prohibited material) before the hook faults.
        onPrompt: () => { appendFileSync(sessionFile, PROHIBITED); return undefined; },
      });
      let settleCalls = 0;
      await expect(routeFixDirectiveToMinion({
        jobId, directive: 'continue the review', signal: new AbortController().signal, owner: 'test',
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
        // Pre-prompt interlock resolves; the POST-prompt settlement hook faults.
        retrySettlement: () => {
          settleCalls += 1;
          if (settleCalls === 1) return Promise.resolve('none' as const);
          throw new Error('settlement hook fault');
        },
        observeBlindTurn: observed(h.ledger),
      })).rejects.toThrow(RetrySettlementUnavailableError);
      expect(settleCalls).toBe(2);
      // The observation precedes the named error: the completed turn's read counts.
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1 });
    } finally {
      h.dispose();
    }
  });

  it('CONTROL authorized: a permitted read keeps coverage qualifying (and is observed)', async () => {
    const jobId = 'job-tail-authorized';
    const agentId = 'tail-authorized';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-tail-authorized-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'authorized.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = observedSessionLedger(jobId, agentId, sessionFile, { admit: true });
    try {
      const handle = tailHandle({
        id: agentId, sessionFile,
        onPrompt: () => { appendFileSync(sessionFile, `${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'read', content: PERMITTED } })}\n`); return undefined; },
      });
      const outcome = await routeFixDirectiveToMinion({
        jobId, directive: 'continue the review', signal: new AbortController().signal, owner: 'test',
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
        observeBlindTurn: observed(h.ledger),
      });
      expect(outcome).toMatchObject({ delivered: true, minionId: agentId });
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'qualifying', qualifying: true, accessObserved: true, prohibitedAccess: 0 });
    } finally {
      h.dispose();
    }
  });

  it('CONTROL non-blind: a directive turn on a non-blind job records no observation', async () => {
    const jobId = 'job-tail-plain';
    const agentId = 'tail-plain';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-tail-plain-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'plain.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = observedSessionLedger(jobId, agentId, sessionFile, { admit: false });
    try {
      const handle = tailHandle({
        id: agentId, sessionFile,
        onPrompt: () => { appendFileSync(sessionFile, PROHIBITED); return undefined; },
      });
      const outcome = await routeFixDirectiveToMinion({
        jobId, directive: 'continue', signal: new AbortController().signal, owner: 'test',
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
        observeBlindTurn: observed(h.ledger),
      });
      expect(outcome).toMatchObject({ delivered: true });
      expect(h.ledger.latestJobEvent(jobId, BLIND_ACCESS_EVENT)).toBeNull();
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'unclassified', accessObserved: false });
    } finally {
      h.dispose();
    }
  });

  it('CONTROL no-start: a pre-aborted directive starts no turn and fabricates no observation', async () => {
    const jobId = 'job-tail-prebort';
    const agentId = 'tail-prebort';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-tail-prebort-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'prebort.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = observedSessionLedger(jobId, agentId, sessionFile, { admit: true });
    try {
      const controller = new AbortController();
      controller.abort();
      let promptCalls = 0;
      const handle = tailHandle({
        id: agentId, sessionFile,
        onPrompt: () => { promptCalls += 1; appendFileSync(sessionFile, PROHIBITED); return undefined; },
      });
      await expect(routeFixDirectiveToMinion({
        jobId, directive: 'continue the review', signal: controller.signal, owner: 'test',
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
        observeBlindTurn: observed(h.ledger),
      })).rejects.toThrow(/review operation aborted/);
      expect(promptCalls).toBe(0);
      expect(h.ledger.latestJobEvent(jobId, BLIND_ACCESS_EVENT)).toBeNull();
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'qualifying', accessObserved: false });
    } finally {
      h.dispose();
    }
  });

  it('G4: a REJECTED live directive prompt is still observed and preserves the original failure', async () => {
    const jobId = 'job-tail-reject';
    const agentId = 'tail-reject';
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-tail-reject-'));
    cleanupDirs.push(dir);
    const sessionFile = join(dir, 'reject.jsonl');
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const h = observedSessionLedger(jobId, agentId, sessionFile, { admit: true });
    try {
      const handle = tailHandle({
        id: agentId, sessionFile,
        // The physical prompt reads prohibited material AND then rejects: the
        // rejection arm of runObservedPrompt must still observe the read.
        onPrompt: () => {
          appendFileSync(sessionFile, PROHIBITED);
          throw new Error('directive turn rejected after the read');
        },
      });
      const failure = await routeFixDirectiveToMinion({
        jobId, directive: 'continue the review', signal: new AbortController().signal, owner: 'test',
        ledger: h.ledger, worktrees: { listWorktrees: () => [laneAt(dir)] } as unknown as WorktreePort,
        registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
        observeBlindTurn: observed(h.ledger),
      }).then(() => null, (error: unknown) => error);
      // The ORIGINAL prompt failure is preserved (never replaced by a
      // coverage/bookkeeping error).
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('directive turn rejected after the read');
      // Deleting only the rejection-arm observation leaves coverage qualifying.
      expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
        state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
      });
    } finally {
      h.dispose();
    }
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
          getJob: () => activeJobRecord('job-queued'),
        } as never,
        worktrees: { listWorktrees: () => [] } as never,
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

describe('fix directive cleanup failure provenance — P18 current-behavior regressions', () => {
  function failureMessages(error: unknown): string[] {
    return [String(error),
      ...(error instanceof AggregateError ? error.errors.flatMap((nested: unknown) => failureMessages(nested)) : []),
      ...(error instanceof Error && error.cause !== undefined ? failureMessages(error.cause) : [])];
  }

  async function assertSimultaneousCleanupFailures(prior: boolean): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gru-fix-cleanup-errors-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const worktrees = new InMemoryWorktreePort(join(dir, 'lanes'));
    const promptFailure = new Error('original fresh native prompt failure');
    const disposalFailure = new Error(prior ? 'original prior rebrief disposal failure' : 'original fresh disposal failure');
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 1 });
    const target: AgentHandle = {
      id: 'cleanup-minion', role: 'minion', sessionFile: '/controlled-cleanup-native.jsonl',
      capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
      prompt: vi.fn(async () => { throw promptFailure; }),
      async steer() {}, async followUp() {},
      subscribe() { return () => {}; },
      health() { return { state: 'idle', lastActivity: null, sessionFile: this.sessionFile }; },
      // The controlled cleanup really rejects; it never reports disposal or
      // cessation just because the prompt operation rejected/settled.
      dispose: vi.fn(async () => { throw disposalFailure; }),
      cessationEvidence: () => 'unknown',
    };
    const spawn = vi.fn(async () => target);
    const onCleanup = vi.fn((handle: AgentHandle) => {
      ledger.appendCustomEvent({ kind: 'silas.directive-producer-unknown', jobId: 'cleanup-job',
        payload: { request_id: 'cleanup-request', agent_id: handle.id, session_file: handle.sessionFile } });
    });
    try {
      ledger.addJob({ id: 'cleanup-job', repo: 'fixture', title: 'cleanup', briefing: 'original contract' });
      ledger.setJobStatus('cleanup-job', 'working');
      await worktrees.createJobWorktree({ repoPath: dir, jobId: 'cleanup-job' });
      if (prior) {
        ledger.registerAgent({ id: target.id, role: 'minion', jobId: 'cleanup-job', sessionFile: target.sessionFile });
        ledger.setAgentState(target.id, 'idle');
      }
      db.handle.exec(`CREATE TRIGGER reject_cleanup_journal BEFORE INSERT ON events
        WHEN NEW.kind = 'silas.directive-producer-unknown'
        BEGIN SELECT RAISE(FAIL, 'original cleanup journal storage failure'); END`);
      const error = await routeFixDirectiveToMinion({ ledger,
        registry: { getHandle: (id) => prior && id === target.id ? target : null, spawn,
          disposeHandle: async (handle) => { await handle.dispose(); } },
        worktrees,
        jobId: 'cleanup-job', directive: 'preserve all original failures', signal: new AbortController().signal,
        freshSession: prior, workerGate: gate, onCleanup,
      }).then(() => null, (failure: unknown) => failure);
      expect(target.dispose).toHaveBeenCalledTimes(1); expect(onCleanup).toHaveBeenCalledTimes(1);
      expect(target.cessationEvidence!()).toBe('unknown');
      expect(gate.view().worker.running).toBe(0);
      expect(ledger.latestJobEvent('cleanup-job', 'silas.directive-producer-ceased')).toBeNull();
      expect(ledger.latestJobEvent('cleanup-job', 'job.delivered')).toBeNull();
      if (prior) { expect(target.prompt).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); }
      else { expect(target.prompt).toHaveBeenCalledTimes(1); expect(spawn).toHaveBeenCalledTimes(1); }
      const messages = failureMessages(error);
      expect(messages, 'cleanup journaling must not replace the original disposal failure').toContain(String(disposalFailure));
      if (!prior) expect(messages, 'fresh finally must also retain the original prompt failure').toContain(String(promptFailure));
      expect(messages.join(';')).toContain('original cleanup journal storage failure');
    } finally { db.close(); }
  }

  it('fresh prompt disposal and real SQLite journal failures retain every original failure', async () => {
    await assertSimultaneousCleanupFailures(false);
  });

  it('prior rebrief disposal and real SQLite journal failures preserve the original owner failure without spawning', async () => {
    await assertSimultaneousCleanupFailures(true);
  });
});
