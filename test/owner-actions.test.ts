import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { BRANCH_STATE_EVENT, branchStatePayload, type CiState, type NormalizedBranchState, type RepoRef } from '../src/dispatch/github-poll.js';
import {
  isSafeHttpsUrl,
  ownerReadyPr,
  readBranchEvidence,
  type BranchEvidence,
  type OwnerPrJob,
} from '../src/board/owner-actions.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-owner-actions-'));
  cleanupDirs.push(dir);
  return dir;
}

const SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const OTHER_SHA = 'ffff0000aaaa1111bbbb2222cccc3333dddd4444';
const PR_URL = 'https://github.com/example/demo/pull/7';

function greenCi(sha: string): CiState {
  return { sha, status: 'green', signature: '', failures: [], checks: ['ci'] };
}

/** A branch-state event exactly as github-poll writes it. */
function branchEvent(jobId: string, state: NormalizedBranchState) {
  const lane = {
    jobId,
    repo: { host: 'github.com', owner: 'example', repo: 'demo' } as RepoRef,
    branch: `gru/${jobId}`,
    prNumber: state.prNumber,
    prUrl: state.prUrl,
  };
  return { kind: BRANCH_STATE_EVENT, jobId: lane.jobId, payload: branchStatePayload(lane, state) };
}

function branchState(overrides: Partial<NormalizedBranchState> = {}): NormalizedBranchState {
  return {
    sha: SHA,
    merged: false,
    prOpen: true,
    mergeableState: 'clean',
    ci: greenCi(SHA),
    prNumber: 7,
    prUrl: PR_URL,
    mergeCommitSha: null,
    ...overrides,
  };
}

function evidence(overrides: Partial<NormalizedBranchState> = {}): BranchEvidence {
  return { state: branchState(overrides), checkedAt: '2026-09-28T10:00:00.000Z' };
}

function job(overrides: Partial<OwnerPrJob> = {}): OwnerPrJob {
  return {
    id: 'job-ready',
    repo: 'demo',
    title: 'Ready heist',
    status: 'in-review',
    prUrl: PR_URL,
    rounds: [{ status: 'verdict-posted', verdict: 'approved', targetRef: SHA }],
    ...overrides,
  };
}

describe('owner-action projection — fail-closed readiness gate', () => {
  it('qualifies the exact conjunction: in-review + matching PR + clean + green CI at the exact sha + head-bound approved round', () => {
    const row = ownerReadyPr(job(), evidence());
    expect(row).toEqual({
      id: 'owner-pr:job-ready',
      jobId: 'job-ready',
      jobTitle: 'Ready heist',
      repo: 'demo',
      prUrl: PR_URL,
      sha: SHA,
      checkedAt: '2026-09-28T10:00:00.000Z',
    });
  });

  // Register each case explicitly: the full-suite shape guard must pin all
  // 28 cases, not just one registration site hidden inside a loop.
  it('renders NO ready row when: job is not in-review (hold)', () => {
    expect(ownerReadyPr(job({ status: 'blocked' }), evidence())).toBeNull();
  });

  it('renders NO ready row when: job has no recorded PR', () => {
    expect(ownerReadyPr(job({ prUrl: null }), evidence())).toBeNull();
  });

  it('renders NO ready row when: prUrl is not https', () => {
    expect(ownerReadyPr(job({ prUrl: 'http://insecure.example/pr' }), evidence())).toBeNull();
  });

  it('renders NO ready row when: no branch-state evidence at all', () => {
    expect(ownerReadyPr(job(), null)).toBeNull();
  });

  it('renders NO ready row when: evidence describes a different PR', () => {
    expect(ownerReadyPr(job(), evidence({ prUrl: 'https://github.com/example/demo/pull/9' }))).toBeNull();
  });

  it('renders NO ready row when: PR already merged', () => {
    expect(ownerReadyPr(job(), evidence({ merged: true, prOpen: false }))).toBeNull();
  });

  it('renders NO ready row when: PR closed without merging', () => {
    expect(ownerReadyPr(job(), evidence({ prOpen: false }))).toBeNull();
  });

  it('renders NO ready row when: PR open/closed status never observed (legacy event)', () => {
    expect(ownerReadyPr(job(), evidence({ prOpen: null }))).toBeNull();
  });

  it('renders NO ready row when: head sha missing', () => {
    expect(ownerReadyPr(job(), evidence({ sha: null }))).toBeNull();
  });

  it('renders NO ready row when: mergeable dirty (conflicts)', () => {
    expect(ownerReadyPr(job(), evidence({ mergeableState: 'dirty' }))).toBeNull();
  });

  it('renders NO ready row when: mergeable blocked (required gate)', () => {
    expect(ownerReadyPr(job(), evidence({ mergeableState: 'blocked' }))).toBeNull();
  });

  it('renders NO ready row when: mergeable unknown', () => {
    expect(ownerReadyPr(job(), evidence({ mergeableState: null }))).toBeNull();
  });

  it('renders NO ready row when: mergeable unstable', () => {
    expect(ownerReadyPr(job(), evidence({ mergeableState: 'unstable' }))).toBeNull();
  });

  it('renders NO ready row when: CI unobserved', () => {
    expect(ownerReadyPr(job(), evidence({ ci: null }))).toBeNull();
  });

  it('renders NO ready row when: CI pending', () => {
    expect(ownerReadyPr(job(), evidence({ ci: { sha: SHA, status: 'pending', signature: '', failures: [], checks: [] } }))).toBeNull();
  });

  it('renders NO ready row when: CI failed', () => {
    expect(ownerReadyPr(job(), evidence({ ci: { sha: SHA, status: 'failed', signature: 'ci|lint', failures: [{ name: 'ci', conclusion: 'failure', url: null }], checks: [] } }))).toBeNull();
  });

  it('renders NO ready row when: CI green but at an older sha (head moved)', () => {
    expect(ownerReadyPr(job(), evidence({ sha: OTHER_SHA, ci: greenCi(SHA) }))).toBeNull();
  });

  it('renders NO ready row when: no review rounds', () => {
    expect(ownerReadyPr(job({ rounds: [] }), evidence())).toBeNull();
  });

  it('renders NO ready row when: newest round not verdict-posted', () => {
    expect(ownerReadyPr(job({ rounds: [{ status: 'live', verdict: null, targetRef: SHA }] }), evidence())).toBeNull();
  });

  it('renders NO ready row when: newest round changes-requested', () => {
    expect(ownerReadyPr(job({ rounds: [{ status: 'verdict-posted', verdict: 'changes-requested', targetRef: SHA }] }), evidence())).toBeNull();
  });

  it('renders NO ready row when: approval bound to an older head', () => {
    expect(ownerReadyPr(job({ rounds: [{ status: 'verdict-posted', verdict: 'approved', targetRef: OTHER_SHA }] }), evidence())).toBeNull();
  });

  it('an approved round followed by a newer aborted round fails closed (newest verdict must be the approval)', () => {
    const jobInput = job({
      rounds: [
        { status: 'verdict-posted', verdict: 'approved', targetRef: SHA },
        { status: 'aborted', verdict: null, targetRef: null },
      ],
    });
    expect(ownerReadyPr(jobInput, evidence())).toBeNull();
  });

  it('a re-approved round at the moved head qualifies again (head-change invalidation is positional, not permanent)', () => {
    const jobInput = job({
      rounds: [
        { status: 'verdict-posted', verdict: 'approved', targetRef: SHA },
        { status: 'aborted', verdict: null, targetRef: null },
        { status: 'verdict-posted', verdict: 'approved', targetRef: OTHER_SHA },
      ],
    });
    const row = ownerReadyPr(jobInput, evidence({ sha: OTHER_SHA, ci: greenCi(OTHER_SHA) }));
    expect(row?.sha).toBe(OTHER_SHA);
  });

  it('isSafeHttpsUrl accepts only https URLs', () => {
    expect(isSafeHttpsUrl(PR_URL)).toBe(true);
    expect(isSafeHttpsUrl('http://github.com/x')).toBe(false);
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpsUrl('not a url')).toBe(false);
    expect(isSafeHttpsUrl('')).toBe(false);
  });
});

describe('owner-action projection — evidence reader over the durable ledger', () => {
  let api: LedgerApi;

  beforeAll(() => {
    const db = new LedgerDb(tmpDir());
    api = new LedgerApi(db.handle, { bus: new EventBus() });
  });

  it('reads the newest branch-state event through the poll\'s own parser (no second parser drifts)', () => {
    api.addJob({ id: 'job-evidence', repo: 'demo', title: 'Evidence' });
    api.appendCustomEvent(branchEvent('job-evidence', branchState({ sha: OTHER_SHA })));
    api.appendCustomEvent(branchEvent('job-evidence', branchState()));
    const ev = readBranchEvidence(api, 'job-evidence');
    expect(ev?.state.sha).toBe(SHA);
    expect(ev?.state.mergeableState).toBe('clean');
    expect(typeof ev?.checkedAt).toBe('string');
  });

  it('returns null evidence when no branch-state event exists (never a guess)', () => {
    api.addJob({ id: 'job-silent', repo: 'demo', title: 'Silent' });
    expect(readBranchEvidence(api, 'job-silent')).toBeNull();
  });

  it('returns null evidence for a malformed payload (fail closed, the poll re-observes)', () => {
    api.addJob({ id: 'job-mangled', repo: 'demo', title: 'Mangled' });
    api.appendCustomEvent({ kind: BRANCH_STATE_EVENT, jobId: 'job-mangled', payload: 'not-an-object' });
    expect(readBranchEvidence(api, 'job-mangled')).toBeNull();
  });
});
