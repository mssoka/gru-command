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

  const notReady: readonly (readonly [string, OwnerPrJob, BranchEvidence | null])[] = [
    ['job is not in-review (hold)', job({ status: 'blocked' }), evidence()],
    ['job has no recorded PR', job({ prUrl: null }), evidence()],
    ['prUrl is not https', job({ prUrl: 'http://insecure.example/pr' }), evidence()],
    ['no branch-state evidence at all', job(), null],
    ['evidence describes a different PR', job(), evidence({ prUrl: 'https://github.com/example/demo/pull/9' })],
    ['PR already merged', job(), evidence({ merged: true, prOpen: false })],
    ['PR closed without merging', job(), evidence({ prOpen: false })],
    ['PR open/closed status never observed (legacy event)', job(), evidence({ prOpen: null })],
    ['head sha missing', job(), evidence({ sha: null })],
    ['mergeable dirty (conflicts)', job(), evidence({ mergeableState: 'dirty' })],
    ['mergeable blocked (required gate)', job(), evidence({ mergeableState: 'blocked' })],
    ['mergeable unknown', job(), evidence({ mergeableState: null })],
    ['mergeable unstable', job(), evidence({ mergeableState: 'unstable' })],
    ['CI unobserved', job(), evidence({ ci: null })],
    ['CI pending', job(), evidence({ ci: { sha: SHA, status: 'pending', signature: '', failures: [], checks: [] } })],
    ['CI failed', job(), evidence({ ci: { sha: SHA, status: 'failed', signature: 'ci|lint', failures: [{ name: 'ci', conclusion: 'failure', url: null }], checks: [] } })],
    ['CI green but at an older sha (head moved)', job(), evidence({ sha: OTHER_SHA, ci: greenCi(SHA) })],
    ['no review rounds', job({ rounds: [] }), evidence()],
    ['newest round not verdict-posted', job({ rounds: [{ status: 'live', verdict: null, targetRef: SHA }] }), evidence()],
    ['newest round changes-requested', job({ rounds: [{ status: 'verdict-posted', verdict: 'changes-requested', targetRef: SHA }] }), evidence()],
    ['approval bound to an older head', job({ rounds: [{ status: 'verdict-posted', verdict: 'approved', targetRef: OTHER_SHA }] }), evidence()],
  ];
  for (const [name, jobInput, ev] of notReady) {
    it(`renders NO ready row when: ${name}`, () => {
      expect(ownerReadyPr(jobInput, ev)).toBeNull();
    });
  }

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
