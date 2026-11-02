import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { BRANCH_STATE_EVENT, branchStatePayload, type CiState, type NormalizedBranchState, type RepoRef } from '../src/dispatch/github-poll.js';
import {
  GITLAB_EVIDENCE_MAX_AGE_MS,
  githubEvidence,
  isSafeHttpsUrl,
  ownerReadyPr,
  readBranchEvidence,
  readOwnerEvidence,
  type OwnerEvidence,
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
const CHECKED_AT = '2026-09-28T10:00:00.000Z';
const MR_HOST = 'gitlab.example.test';
const MR_PROJECT = 'acme/platform/app';
const MR_URL = `https://${MR_HOST}/${MR_PROJECT}/-/merge_requests/7`;

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

/** The GitHub path's normalized evidence — the whole existing gate table
 * runs through this constructor (behavioral parity with the pre-#527 shape). */
function evidence(overrides: Partial<NormalizedBranchState> = {}): OwnerEvidence {
  return githubEvidence(branchState(overrides), CHECKED_AT);
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
      checkedAt: CHECKED_AT,
      provider: 'github',
    });
  });

  // Register each case explicitly: the full-suite shape guard must pin every
  // case, not just one registration site hidden inside a loop.
  it('renders NO ready row when: job is not in-review (hold)', () => {
    expect(ownerReadyPr(job({ status: 'blocked' }), evidence())).toBeNull();
  });

  it('renders NO ready row when: job has no recorded PR', () => {
    expect(ownerReadyPr(job({ prUrl: null }), evidence())).toBeNull();
  });

  it('renders NO ready row when: prUrl is not https', () => {
    expect(ownerReadyPr(job({ prUrl: 'http://insecure.example/pr' }), evidence())).toBeNull();
  });

  it('renders NO ready row when: prUrl is https but names no supported pull request or merge request', () => {
    // #527 tightens the GitHub link to a parseable PR URL, as the GitLab
    // link already had to be a parseable MR URL.
    expect(ownerReadyPr(job({ prUrl: 'https://github.com/example/demo/issues/7' }), evidence())).toBeNull();
    expect(ownerReadyPr(job({ prUrl: 'https://example.test/somewhere' }), evidence())).toBeNull();
  });

  it('renders NO ready row when: no branch-state evidence at all', () => {
    expect(ownerReadyPr(job(), null)).toBeNull();
  });

  it('renders NO ready row when: evidence describes a different PR', () => {
    expect(ownerReadyPr(job(), evidence({ prUrl: 'https://github.com/example/demo/pull/9' }))).toBeNull();
  });

  it('renders NO ready row when: PR already merged', () => {
    // `prOpen:true` isolates the `merged` limb: the closed and never-observed
    // cases below withhold at `!open`, so dropping `if (evidence.merged)`
    // would leave only this case red.
    expect(ownerReadyPr(job(), evidence({ merged: true, prOpen: true }))).toBeNull();
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

describe('owner-action projection — GitLab merge requests (#527)', () => {
  let api: LedgerApi;

  beforeAll(() => {
    const db = new LedgerDb(tmpDir());
    api = new LedgerApi(db.handle, { bus: new EventBus() });
  });

  /** A `gitlab.mr-observed` payload exactly as the round's read records it. */
  function mrObserved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      host: MR_HOST,
      project: MR_PROJECT,
      mr_iid: 7,
      state: 'opened',
      head_sha: SHA,
      mergeable: 'clean',
      head_pipeline: {
        id: 4242, sha: SHA, status: 'success', source: 'merge_request_event',
        web_url: `https://${MR_HOST}/${MR_PROJECT}/-/pipelines/4242`,
      },
      round_id: 'round-1',
      ...overrides,
    };
  }

  function stage(id: string, prUrl: string | null = MR_URL): OwnerPrJob {
    api.addJob({ id, repo: 'demo', title: `Heist ${id}` });
    return job({ id, prUrl });
  }

  function observe(jobId: string, kind: string, payload: unknown) {
    return api.appendCustomEvent({ kind, jobId, roundId: 'round-1', payload });
  }

  /** Stage one job with one observation, then read through the production
   * reader and gate — every GitLab case exercises both. */
  function ready(id: string, observed: Record<string, unknown> = {}, now = Date.now()) {
    const jobInput = stage(id);
    observe(id, 'gitlab.mr-observed', mrObserved(observed));
    return ownerReadyPr(jobInput, readOwnerEvidence(api, jobInput, now));
  }

  it('qualifies an opened GitLab MR: exact-head success pipeline + clean mergeability + head-bound approval', () => {
    const jobInput = stage('job-gl-ready');
    const event = observe('job-gl-ready', 'gitlab.mr-observed', mrObserved());
    const row = ownerReadyPr(jobInput, readOwnerEvidence(api, jobInput, Date.now()));
    expect(row).toEqual({
      id: 'owner-pr:job-gl-ready',
      jobId: 'job-gl-ready',
      jobTitle: 'Ready heist',
      repo: 'demo',
      prUrl: MR_URL,
      sha: SHA,
      checkedAt: event.ts,
      provider: 'gitlab',
    });
  });

  it('renders NO ready row when: no GitLab evidence is recorded for the job', () => {
    const jobInput = stage('job-gl-silent');
    expect(ownerReadyPr(jobInput, readOwnerEvidence(api, jobInput, Date.now()))).toBeNull();
  });

  it('renders NO ready row when: the only observation is the other provider (attribution matches the link, never the event stream)', () => {
    const jobInput = stage('job-gl-github-only');
    api.appendCustomEvent(branchEvent('job-gl-github-only', branchState()));
    expect(ownerReadyPr(jobInput, readOwnerEvidence(api, jobInput, Date.now()))).toBeNull();

    const githubJob = stage('job-gh-gitlab-only', PR_URL);
    observe('job-gh-gitlab-only', 'gitlab.mr-observed', mrObserved({ host: 'gitlab.example.test' }));
    expect(ownerReadyPr(githubJob, readOwnerEvidence(api, githubJob, Date.now()))).toBeNull();
  });

  it('renders NO ready row when: a newer failed read supersedes the observation', () => {
    const jobInput = stage('job-gl-read-failed');
    observe('job-gl-read-failed', 'gitlab.mr-observed', mrObserved());
    observe('job-gl-read-failed', 'gitlab.mr-read-failed', {
      host: MR_HOST, project: MR_PROJECT, mr_iid: 7, error_kind: 'timeout', detail: 'timed out', round_id: 'round-1',
    });
    expect(ownerReadyPr(jobInput, readOwnerEvidence(api, jobInput, Date.now()))).toBeNull();
  });

  it('keeps the earlier observation when a newer read succeeds (newest of either kind decides)', () => {
    const jobInput = stage('job-gl-recovered');
    observe('job-gl-recovered', 'gitlab.mr-read-failed', {
      host: MR_HOST, project: MR_PROJECT, mr_iid: 7, error_kind: 'other', detail: 'boom', round_id: 'round-1',
    });
    observe('job-gl-recovered', 'gitlab.mr-observed', mrObserved());
    expect(ownerReadyPr(jobInput, readOwnerEvidence(api, jobInput, Date.now()))?.provider).toBe('gitlab');
  });

  it('renders NO ready row when: the observation names another host', () => {
    expect(ready('job-gl-host', { host: 'gitlab.other.test' })).toBeNull();
  });

  it('renders NO ready row when: the observation names another project (subgroups exact)', () => {
    expect(ready('job-gl-project', { project: 'acme/platform/other' })).toBeNull();
    expect(ready('job-gl-project-nested', { project: 'acme/app' })).toBeNull();
  });

  it('renders NO ready row when: the observation names another MR iid', () => {
    expect(ready('job-gl-iid', { mr_iid: 8 })).toBeNull();
  });

  it('renders NO ready row when: the MR is closed', () => {
    expect(ready('job-gl-closed', { state: 'closed', mergeable: 'unknown' })).toBeNull();
  });

  it('renders NO ready row when: the MR is merged', () => {
    expect(ready('job-gl-merged', { state: 'merged', mergeable: 'unknown' })).toBeNull();
  });

  it('renders NO ready row when: the MR head moved after the approval (newer observation at B)', () => {
    const jobInput = stage('job-gl-moved');
    observe('job-gl-moved', 'gitlab.mr-observed', mrObserved());
    observe('job-gl-moved', 'gitlab.mr-observed', mrObserved({
      head_sha: OTHER_SHA,
      head_pipeline: {
        id: 4243, sha: OTHER_SHA, status: 'success', source: 'merge_request_event',
        web_url: `https://${MR_HOST}/${MR_PROJECT}/-/pipelines/4243`,
      },
    }));
    expect(ownerReadyPr(jobInput, readOwnerEvidence(api, jobInput, Date.now()))).toBeNull();
  });

  it('renders NO ready row when: the MR has no head pipeline', () => {
    expect(ready('job-gl-no-pipeline', { head_pipeline: null })).toBeNull();
  });

  it('renders NO ready row when: the head pipeline is pending (running)', () => {
    expect(ready('job-gl-pending', {
      head_pipeline: { id: 4242, sha: SHA, status: 'running', source: 'merge_request_event', web_url: null },
    })).toBeNull();
  });

  it('renders NO ready row when: the head pipeline failed', () => {
    expect(ready('job-gl-failed', {
      head_pipeline: { id: 4242, sha: SHA, status: 'failed', source: 'merge_request_event', web_url: null },
    })).toBeNull();
  });

  it('renders NO ready row when: the head pipeline was skipped (GitLab binds skipped as failed)', () => {
    expect(ready('job-gl-skipped', {
      head_pipeline: { id: 4242, sha: SHA, status: 'skipped', source: 'merge_request_event', web_url: null },
    })).toBeNull();
  });

  it('renders NO ready row when: the pipeline ran on another head (merged-results or an earlier push)', () => {
    expect(ready('job-gl-merged-results', {
      head_pipeline: { id: 4242, sha: OTHER_SHA, status: 'success', source: 'merge_request_event', web_url: null },
    })).toBeNull();
  });

  it('renders NO ready row when: mergeability is not-clean (GitLab recorded `conflict`)', () => {
    expect(ready('job-gl-conflict', { mergeable: 'not-clean' })).toBeNull();
  });

  it('renders NO ready row when: mergeability is unproven (`unknown`)', () => {
    expect(ready('job-gl-unproven', { mergeable: 'unknown' })).toBeNull();
  });

  it('renders NO ready row when: the observation predates #527 and carries no mergeable field', () => {
    const legacy: Record<string, unknown> = mrObserved();
    delete legacy['mergeable'];
    const jobInput = stage('job-gl-legacy');
    observe('job-gl-legacy', 'gitlab.mr-observed', legacy);
    const evidenceRead = readOwnerEvidence(api, jobInput, Date.now());
    expect(evidenceRead?.mergeable).toBe('unknown');
    expect(ownerReadyPr(jobInput, evidenceRead)).toBeNull();
  });

  it('renders NO ready row when: the link is an MR on a host this service does not support for GitLab', () => {
    const jobInput = stage('job-gl-foreign-host', 'https://git.example.test/acme/platform/app/-/merge_requests/7');
    observe('job-gl-foreign-host', 'gitlab.mr-observed', mrObserved({ host: 'git.example.test' }));
    expect(ownerReadyPr(jobInput, readOwnerEvidence(api, jobInput, Date.now()))).toBeNull();
  });

  it('renders NO ready row when: the job has no recorded PR link', () => {
    const jobInput = stage('job-gl-no-link', null);
    observe('job-gl-no-link', 'gitlab.mr-observed', mrObserved());
    expect(ownerReadyPr(jobInput, readOwnerEvidence(api, jobInput, Date.now()))).toBeNull();
  });

  it('withholds a read older than the evidence bound and keeps one inside it (freshness, not escalation)', () => {
    const freshJob = stage('job-gl-fresh');
    const freshEvent = observe('job-gl-fresh', 'gitlab.mr-observed', mrObserved());
    const fresh = readOwnerEvidence(api, freshJob, Date.parse(freshEvent.ts) + GITLAB_EVIDENCE_MAX_AGE_MS - 1_000);
    expect(ownerReadyPr(freshJob, fresh)?.provider).toBe('gitlab');

    const staleJob = stage('job-gl-stale');
    const staleEvent = observe('job-gl-stale', 'gitlab.mr-observed', mrObserved());
    expect(readOwnerEvidence(api, staleJob, Date.parse(staleEvent.ts) + GITLAB_EVIDENCE_MAX_AGE_MS + 1_000)).toBeNull();
  });
});
