import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFollowUpDelivery } from '../src/dispatch/fix-directive.js';
import type { WorktreeLane } from '../src/dispatch/worktree-port.js';
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
