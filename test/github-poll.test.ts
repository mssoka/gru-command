import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRANCH_STATE_EVENT,
  GhApiError,
  GhCliApi,
  GhRateLimitedError,
  GitHubSignalPoll,
  branchStatePayload,
  ciFailureTier,
  classifyCheck,
  diffBranchState,
  nextBranchState,
  parseGitHubPrUrl,
  readBranchState,
  repoFullName,
  sameBranchState,
  summarizeCheckRuns,
  trackedLanes,
  type CiState,
  type GhApiPort,
  type GhCheckRun,
  type GhCommandResult,
  type GhCommandRunner,
  type GhPull,
  type GitHubPollNotifications,
  type GitHubSignalContext,
  type NormalizedBranchState,
  type RepoRef,
  type TrackedLane,
} from '../src/dispatch/github-poll.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';

/**
 * GitHub signal ingestion, POLL-ONLY (owner ruling 2026-09-23):
 * state-change mapping + dedupe (merged/conflict/ci-fail/ci-green), the
 * `gh api` adapter, tracked-lane resolution, and the per-tick budget.
 * The ledger is real wherever the dedupe cursor matters.
 */

const REPO: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' };
const CTX: GitHubSignalContext = { jobId: 'job-1', repo: REPO, branch: 'gru/job-1' };

function state(overrides: Partial<NormalizedBranchState> = {}): NormalizedBranchState {
  return {
    sha: null,
    merged: false,
    mergeableState: null,
    ci: null,
    prNumber: null,
    prUrl: null,
    mergeCommitSha: null,
    ...overrides,
  };
}

function ci(overrides: Partial<CiState> = {}): CiState {
  return {
    sha: 'sha-1',
    status: 'failed',
    signature: 'suite',
    failures: [{ name: 'suite', conclusion: 'failure', url: 'https://runs.example/1' }],
    checks: [],
    ...overrides,
  };
}

function pull(overrides: Partial<GhPull> = {}): GhPull {
  return {
    number: 1,
    headRef: 'gru/job-1',
    headSha: 'sha-1',
    state: 'open',
    merged: false,
    mergeableState: null,
    mergeCommitSha: null,
    url: 'https://github.com/acme/app/pull/1',
    ...overrides,
  };
}

// ------------------------------------------------------------------
// Pure state-change mapping
// ------------------------------------------------------------------

describe('branch state-change mapping', () => {
  it('merged fires once on the observed transition and never again', () => {
    const merged = state({ merged: true, sha: 'sha-1', prNumber: 10, mergeCommitSha: 'mc-10' });
    const first = diffBranchState(CTX, null, merged);
    expect(first.map((signal) => signal.kind)).toEqual(['pr-merged']);
    expect(first[0]).toMatchObject({ jobId: 'job-1', mergeCommitSha: 'mc-10', prNumber: 10 });
    // the recorded state equals the observation: a second diff writes nothing
    expect(diffBranchState(CTX, merged, merged)).toEqual([]);
  });

  it('conflict fires when the state becomes dirty, stays silent on resolution, and re-arms on the next dirty observation', () => {
    const dirty = state({ mergeableState: 'dirty', prNumber: 11 });
    const clean = state({ mergeableState: 'clean', prNumber: 11 });
    expect(diffBranchState(CTX, clean, dirty).map((signal) => signal.kind)).toEqual(['pr-conflict']);
    // resolution is a recorded state change WITHOUT a signal — never a duplicate cascade
    expect(diffBranchState(CTX, dirty, clean)).toEqual([]);
    // a later re-conflict is a NEW observed change: the cascade fires again
    expect(diffBranchState(CTX, clean, dirty).map((signal) => signal.kind)).toEqual(['pr-conflict']);
    // no double-apply for the unchanged dirty state
    expect(diffBranchState(CTX, dirty, dirty)).toEqual([]);
  });

  it('an unknown mergeable_state never counts as a change (GitHub computes it asynchronously)', () => {
    const prev = state({ mergeableState: 'dirty' });
    const next = nextBranchState(prev, { pull: pull({ mergeableState: 'unknown' }), ci: null });
    expect(next.mergeableState).toBe('dirty');
    expect(diffBranchState(CTX, prev, next)).toEqual([]);
    // unknown first, then dirty: the transition still fires exactly once
    const fromUnknown = nextBranchState(null, { pull: pull({ mergeableState: 'unknown' }), ci: null });
    expect(fromUnknown.mergeableState).toBeNull();
    expect(diffBranchState(CTX, fromUnknown, state({ mergeableState: 'dirty' })).map((s) => s.kind)).toEqual([
      'pr-conflict',
    ]);
  });

  it('CI failure fires per moved sha and per extended failing set, never for the same recorded state', () => {
    const failed = state({ ci: ci({ sha: 's1', signature: 'build' }) });
    expect(diffBranchState(CTX, null, failed).map((signal) => signal.kind)).toEqual(['ci-failed']);
    expect(diffBranchState(CTX, failed, failed)).toEqual([]);
    // the failing set grew on the same sha: a new observation, a new signal
    const extended = state({
      ci: ci({
        sha: 's1',
        signature: 'build|test',
        failures: [
          { name: 'build', conclusion: 'failure', url: 'u1' },
          { name: 'test', conclusion: 'failure', url: 'u2' },
        ],
      }),
    });
    expect(diffBranchState(CTX, failed, extended).map((signal) => signal.kind)).toEqual(['ci-failed']);
    // the head moved and failed again: a new signal for the new sha
    const moved = state({ ci: ci({ sha: 's2', signature: 'build' }) });
    expect(diffBranchState(CTX, extended, moved).map((signal) => signal.kind)).toEqual(['ci-failed']);
    // a flaky re-run of the same failing checks is NOT a state change
    expect(diffBranchState(CTX, moved, state({ ci: ci({ sha: 's2', signature: 'build' }) }))).toEqual([]);
  });

  it('CI green fires once per sha and re-arms on a moved head or a failed-to-green recovery', () => {
    const green = state({ ci: ci({ sha: 's1', status: 'green', signature: '', failures: [] }) });
    expect(diffBranchState(CTX, null, green).map((signal) => signal.kind)).toEqual(['ci-green']);
    expect(diffBranchState(CTX, green, green)).toEqual([]);
    const greenMoved = state({ ci: ci({ sha: 's2', status: 'green', signature: '', failures: [] }) });
    expect(diffBranchState(CTX, green, greenMoved).map((signal) => signal.kind)).toEqual(['ci-green']);
    // the same sha failing then going green again is a real recovery change
    const failedSameSha = state({ ci: ci({ sha: 's1', signature: 'build' }) });
    expect(diffBranchState(CTX, failedSameSha, green).map((signal) => signal.kind)).toEqual(['ci-green']);
  });

  it('merged is monotonic and carries forward when a later tick cannot see the PR', () => {
    const merged = state({ merged: true, sha: 'sha-1', prNumber: 10 });
    const later = nextBranchState(merged, { pull: null, ci: null });
    expect(later.merged).toBe(true);
    expect(later.sha).toBe('sha-1');
    expect(diffBranchState(CTX, merged, later)).toEqual([]);
  });

  it('summarizeCheckRuns reports failure over pending over green, and no runs as unobserved', () => {
    expect(summarizeCheckRuns('s1', [])).toBeNull();
    const runs: GhCheckRun[] = [
      { name: 'build', status: 'in_progress', conclusion: null, url: 'u1' },
      { name: 'test', status: 'completed', conclusion: 'failure', url: 'u2' },
    ];
    expect(summarizeCheckRuns('s1', runs)).toMatchObject({ status: 'failed', signature: 'test' });
    const pending: GhCheckRun[] = [
      { name: 'build', status: 'in_progress', conclusion: null, url: 'u1' },
      { name: 'test', status: 'completed', conclusion: 'success', url: 'u2' },
    ];
    expect(summarizeCheckRuns('s1', pending)).toMatchObject({ status: 'pending', signature: '' });
    const allGreen: GhCheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success', url: 'u1' },
      { name: 'test', status: 'completed', conclusion: 'skipped', url: 'u2' },
    ];
    expect(summarizeCheckRuns('s1', allGreen)).toMatchObject({ status: 'green', checks: ['build', 'test'] });
  });

  it('classifyCheck and ciFailureTier split mechanical from judgment, failing toward attention', () => {
    expect(classifyCheck('Full suite (Node 22)')).toBe('mechanical');
    expect(classifyCheck('lint / typecheck')).toBe('mechanical');
    expect(classifyCheck('build-image')).toBe('mechanical');
    expect(classifyCheck('Perkins review')).toBe('judgment');
    expect(classifyCheck('Security scan')).toBe('judgment');
    expect(
      ciFailureTier([
        { name: 'build', conclusion: 'failure', url: null },
        { name: 'Perkins review', conclusion: 'failure', url: null },
      ]),
    ).toBe('judgment');
    expect(ciFailureTier([{ name: 'unit tests', conclusion: 'failure', url: null }])).toBe('mechanical');
  });

  it('nextBranchState carries the sha and CI only for the same head, and resets CI on a moved head', () => {
    const prev = state({ sha: 's1', ci: ci({ sha: 's1' }) });
    const same = nextBranchState(prev, { pull: pull({ headSha: 's1' }), ci: null });
    expect(same.sha).toBe('s1');
    expect(same.ci?.sha).toBe('s1');
    const moved = nextBranchState(prev, { pull: pull({ headSha: 's2' }), ci: null });
    expect(moved.sha).toBe('s2');
    // CI was not observed for the new head: never mislabel the old conclusion
    expect(moved.ci).toBeNull();
    expect(sameBranchState(prev, same)).toBe(false);
    expect(sameBranchState(same, nextBranchState(prev, { pull: pull({ headSha: 's1' }), ci: null }))).toBe(true);
  });

  it('readBranchState round-trips the dedupe cursor and re-observes on a malformed payload', () => {
    const h = makeLedger();
    try {
      const lane: TrackedLane = { jobId: 'job-1', repo: REPO, branch: 'gru/job-1', prNumber: 1, prUrl: null };
      const recorded = state({ sha: 's1', mergeableState: 'dirty', ci: ci({ sha: 's1', status: 'pending', signature: '', failures: [] }), prNumber: 1 });
      h.ledger.appendCustomEvent({ kind: BRANCH_STATE_EVENT, jobId: 'job-1', payload: branchStatePayload(lane, recorded) });
      expect(readBranchState(h.ledger, 'job-1')).toEqual(recorded);

      h.ledger.appendCustomEvent({ kind: BRANCH_STATE_EVENT, jobId: 'job-1', payload: 'not-an-object' });
      const messages: string[] = [];
      expect(readBranchState(h.ledger, 'job-1', (_level, msg) => messages.push(msg))).toBeNull();
      expect(messages.join(' ')).toContain('re-observing');
    } finally {
      h.cleanup();
    }
  });

  it('parseGitHubPrUrl accepts clean https PR URLs only', () => {
    expect(parseGitHubPrUrl('https://github.com/acme/app/pull/42')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
      number: 42,
    });
    expect(parseGitHubPrUrl(' https://github.com/acme/app/pull/42 ')).toMatchObject({ number: 42 });
    expect(parseGitHubPrUrl('https://github.com/acme/app/pull/42?diff=split')).toBeNull();
    expect(parseGitHubPrUrl('https://gitlab.com/acme/app/-/merge_requests/42')).toBeNull();
    expect(parseGitHubPrUrl('git@github.com:acme/app.git')).toBeNull();
    expect(parseGitHubPrUrl('not a url')).toBeNull();
  });
});

// ------------------------------------------------------------------
// Tracked lanes + gh adapter
// ------------------------------------------------------------------

describe('tracked lanes', () => {
  it('prefers the recorded PR URL, falls back to the lane origin remote, and skips non-GitHub or terminal lanes', () => {
    const h = makeLedger();
    try {
      const register = (jobId: string, branch: string | null, repoPath: string): void => {
        h.ledger.registerWorktree({
          id: `wt-${jobId}`,
          kind: 'job',
          repoPath,
          repoName: 'app',
          path: `/lanes/${jobId}`,
          branch,
          sha: 'sha-0',
          jobId,
        });
      };
      const mkJob = (jobId: string, status: string, prUrl: string | null): void => {
        h.ledger.addJob({ id: jobId, repo: 'fixture-app', title: 't', briefing: 'b' });
        h.ledger.setJobStatus(jobId, 'working');
        if (prUrl !== null) h.ledger.setJobPr(jobId, prUrl);
        if (status !== 'working') h.ledger.setJobStatus(jobId, status);
      };

      mkJob('job-url', 'in-review', 'https://github.com/acme/app/pull/7');
      register('job-url', 'gru/job-url', '/repos/app');
      mkJob('job-remote', 'working', null);
      register('job-remote', 'gru/job-remote', '/repos/remote-app');
      mkJob('job-gitlab', 'working', null);
      register('job-gitlab', 'gru/job-gitlab', '/repos/gitlab-app');
      mkJob('job-no-lane', 'in-review', 'https://github.com/acme/app/pull/8');
      mkJob('job-merged', 'done', 'https://github.com/acme/app/pull/9');
      register('job-merged', 'gru/job-merged', '/repos/app');

      const remotes = new Map<string, RepoRef>([
        ['/repos/app', REPO],
        ['/repos/remote-app', { host: 'github.com', owner: 'other', repo: 'remote-app' }],
        ['/repos/gitlab-app', { host: 'gitlab.com', owner: 'other', repo: 'gitlab-app' }],
      ]);
      const lanes = trackedLanes({
        ledger: h.ledger,
        resolveRemote: (repoPath) => remotes.get(repoPath) ?? null,
      });
      expect(lanes.map((lane) => ({ jobId: lane.jobId, repo: repoFullName(lane.repo), branch: lane.branch }))).toEqual([
        { jobId: 'job-no-lane', repo: 'acme/app', branch: 'gru/job-no-lane' },
        { jobId: 'job-remote', repo: 'other/remote-app', branch: 'gru/job-remote' },
        { jobId: 'job-url', repo: 'acme/app', branch: 'gru/job-url' },
      ]);
      expect(lanes.find((lane) => lane.jobId === 'job-url')?.prNumber).toBe(7);
      expect(lanes.find((lane) => lane.jobId === 'job-remote')?.prNumber).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe('gh CLI adapter', () => {
  it('builds hostname-scoped paths and maps pulls, detail, and check runs', async () => {
    const calls: string[][] = [];
    const responses: GhCommandResult[] = [
      {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 7,
            head: { ref: 'gru/job-1', sha: 'sha-1' },
            state: 'open',
            merged_at: null,
            mergeable_state: null,
            merge_commit_sha: null,
            html_url: 'https://github.com/acme/app/pull/7',
          },
        ]),
        stderr: '',
      },
      {
        status: 0,
        stdout: JSON.stringify({
          number: 7,
          head: { ref: 'gru/job-1', sha: 'sha-1' },
          state: 'open',
          merged_at: null,
          mergeable_state: 'dirty',
          merge_commit_sha: null,
          html_url: 'https://github.com/acme/app/pull/7',
        }),
        stderr: '',
      },
      {
        status: 0,
        stdout: JSON.stringify({
          total_count: 1,
          check_runs: [
            { name: 'Full suite', status: 'completed', conclusion: 'failure', details_url: 'https://runs/1' },
          ],
        }),
        stderr: '',
      },
    ];
    const runner: GhCommandRunner = async (args) => {
      calls.push([...args]);
      const response = responses.shift();
      if (response === undefined) throw new Error('no scripted gh response');
      return response;
    };
    const api = new GhCliApi(runner);
    const pulls = await api.listPulls({ repo: REPO, limit: 5 });
    expect(pulls).toEqual([
      {
        number: 7,
        headRef: 'gru/job-1',
        headSha: 'sha-1',
        state: 'open',
        merged: false,
        mergeableState: null,
        mergeCommitSha: null,
        url: 'https://github.com/acme/app/pull/7',
      },
    ]);
    expect(await api.getPull({ repo: REPO, number: 7 })).toMatchObject({ mergeableState: 'dirty' });
    expect(await api.listCheckRuns({ repo: REPO, sha: 'sha-1' })).toEqual([
      { name: 'Full suite', status: 'completed', conclusion: 'failure', url: 'https://runs/1' },
    ]);
    expect(calls[0]).toEqual([
      'api',
      '--hostname',
      'github.com',
      'repos/acme/app/pulls?state=all&sort=updated&direction=desc&per_page=5',
    ]);
    expect(calls[1]).toEqual(['api', '--hostname', 'github.com', 'repos/acme/app/pulls/7']);
    expect(calls[2]).toEqual([
      'api',
      '--hostname',
      'github.com',
      'repos/acme/app/commits/sha-1/check-runs?per_page=100&filter=latest',
    ]);
  });

  it('fails loud on unavailability, rate limits, and malformed responses', async () => {
    const unavailable = new GhCliApi(async () => ({ status: -1, stdout: '', stderr: '', error: 'spawn gh ENOENT' }));
    await expect(unavailable.listPulls({ repo: REPO, limit: 1 })).rejects.toThrow(/gh is unavailable/);

    const limited = new GhCliApi(async () => ({
      status: 1,
      stdout: '',
      stderr: 'HTTP 403: API rate limit exceeded for user ID 1 (https://docs.github.com/rest/rate-limits)',
      error: undefined,
    }));
    await expect(limited.listPulls({ repo: REPO, limit: 1 })).rejects.toBeInstanceOf(GhRateLimitedError);

    const malformed = new GhCliApi(async () => ({ status: 0, stdout: 'not json', stderr: '' }));
    await expect(malformed.getPull({ repo: REPO, number: 1 })).rejects.toThrow(/invalid JSON/);

    const wrongShape = new GhCliApi(async () => ({ status: 0, stdout: JSON.stringify({ message: 'nope' }), stderr: '' }));
    await expect(wrongShape.listPulls({ repo: REPO, limit: 1 })).rejects.toThrow(/expected a JSON array/);
    await expect(wrongShape.listCheckRuns({ repo: REPO, sha: 'sha-1' })).rejects.toThrow(/no check_runs array/);
  });
});

// ------------------------------------------------------------------
// The poll tick (real ledger; scripted gh)
// ------------------------------------------------------------------

interface FakeCall {
  readonly kind: 'listPulls' | 'getPull' | 'listCheckRuns';
  readonly repo: string;
  readonly arg: number | string | null;
}

class FakeGhApi implements GhApiPort {
  readonly calls: FakeCall[] = [];
  readonly pulls = new Map<string, GhPull[]>();
  readonly details = new Map<string, GhPull>();
  readonly checks = new Map<string, GhCheckRun[]>();
  readonly failList = new Map<string, Error>();
  readonly failDetail = new Map<string, Error>();

  async listPulls(input: { repo: RepoRef; limit: number }): Promise<readonly GhPull[]> {
    const repo = repoFullName(input.repo);
    this.calls.push({ kind: 'listPulls', repo, arg: input.limit });
    const failure = this.failList.get(repo);
    if (failure !== undefined) throw failure;
    return this.pulls.get(repo) ?? [];
  }

  async getPull(input: { repo: RepoRef; number: number }): Promise<GhPull> {
    const repo = repoFullName(input.repo);
    this.calls.push({ kind: 'getPull', repo, arg: input.number });
    const key = `${repo}#${input.number}`;
    const failure = this.failDetail.get(key);
    if (failure !== undefined) throw failure;
    const detail = this.details.get(key);
    if (detail === undefined) throw new Error(`no fake detail for ${key}`);
    return detail;
  }

  async listCheckRuns(input: { repo: RepoRef; sha: string }): Promise<readonly GhCheckRun[]> {
    const repo = repoFullName(input.repo);
    this.calls.push({ kind: 'listCheckRuns', repo, arg: input.sha });
    return this.checks.get(`${repo}@${input.sha}`) ?? [];
  }

  count(kind: FakeCall['kind']): number {
    return this.calls.filter((call) => call.kind === kind).length;
  }
}

interface FakePost {
  readonly kind: string;
  readonly routing: string;
  readonly severity: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly dedupe: string;
}

class FakeNotifications implements GitHubPollNotifications {
  readonly posts: FakePost[] = [];
  postIncident(input: FakePost): FakePost {
    this.posts.push(input);
    return input;
  }
}

function makeLedger(): { ledger: LedgerApi; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-github-poll-'));
  const db = new LedgerDb(dir);
  return {
    ledger: new LedgerApi(db.handle),
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function addTrackedJob(ledger: LedgerApi, jobId: string, prUrl: string | null, status = 'in-review'): void {
  ledger.addJob({ id: jobId, repo: 'fixture-app', title: `t-${jobId}`, briefing: 'b' });
  ledger.setJobStatus(jobId, 'working');
  if (prUrl !== null) ledger.setJobPr(jobId, prUrl);
  if (status !== 'working') ledger.setJobStatus(jobId, status);
}

function makePoll(input: {
  ledger: LedgerApi;
  api: FakeGhApi;
  notifications?: FakeNotifications;
  maxCallsPerTick?: number;
  logs?: string[];
}): GitHubSignalPoll {
  const notifications = input.notifications ?? new FakeNotifications();
  return new GitHubSignalPoll({
    ledger: input.ledger,
    notifications,
    api: input.api,
    resolveRemote: () => null,
    ...(input.maxCallsPerTick !== undefined ? { maxCallsPerTick: input.maxCallsPerTick } : {}),
    log: (level, msg, fields) => {
      input.logs?.push(`${level} ${msg}${fields !== undefined ? ` ${JSON.stringify(fields)}` : ''}`);
    },
  });
}

function eventCount(ledger: LedgerApi, jobId: string, kind: string): number {
  return ledger.listJobEvents(jobId, { limit: 100 }).filter((event) => event.kind === kind).length;
}

describe('github signal poll tick', () => {
  it('one tick applies the merged and conflict mappings against a real ledger, with one cursor event per change', async () => {
    const h = makeLedger();
    try {
      addTrackedJob(h.ledger, 'job-merge', 'https://github.com/acme/app/pull/10');
      addTrackedJob(h.ledger, 'job-conflict', 'https://github.com/acme/app/pull/11');
      const api = new FakeGhApi();
      api.pulls.set('acme/app', [
        pull({ number: 10, headRef: 'gru/job-merge', headSha: 'sha-10', merged: true, mergeCommitSha: 'mc-10', url: 'https://github.com/acme/app/pull/10' }),
        pull({ number: 11, headRef: 'gru/job-conflict', headSha: 'sha-11', url: 'https://github.com/acme/app/pull/11' }),
      ]);
      api.details.set('acme/app#11', pull({ number: 11, headRef: 'gru/job-conflict', headSha: 'sha-11', mergeableState: 'dirty', url: 'https://github.com/acme/app/pull/11' }));
      const notifications = new FakeNotifications();
      const poll = makePoll({ ledger: h.ledger, api, notifications });

      const result = await poll.pollOnce();
      expect(result.tracked).toBe(2);
      expect(result.observed).toBe(2);
      expect(result.budgetExhausted).toBe(false);
      expect(result.rateLimited).toBe(false);
      expect(result.signals.map((signal) => signal.kind).sort()).toEqual(['pr-conflict', 'pr-merged']);

      expect(h.ledger.getJob('job-merge')?.status).toBe('merged');
      expect(h.ledger.latestJobEvent('job-merge', 'github.pr-merged')?.payload).toMatchObject({
        applied: true,
        pr: 10,
        merge_commit_sha: 'mc-10',
      });
      // merged is terminal: exactly one transition event
      expect(eventCount(h.ledger, 'job-merge', 'github.pr-merged')).toBe(1);

      expect(h.ledger.latestJobEvent('job-conflict', 'github.pr-conflict')?.payload).toMatchObject({
        pr: 11,
        mergeable_state: 'dirty',
      });
      expect(notifications.posts).toHaveLength(1);
      expect(notifications.posts[0]).toMatchObject({
        kind: 'github.pr-conflict:job-conflict',
        routing: 'action-required',
        severity: 'error',
        dedupe: 'unacked',
      });
      expect(notifications.posts[0]?.detail).toContain('rebase');

      // one dedupe cursor per job, recording the observed state
      for (const jobId of ['job-merge', 'job-conflict']) {
        expect(eventCount(h.ledger, jobId, BRANCH_STATE_EVENT)).toBe(1);
      }
      expect(readBranchState(h.ledger, 'job-merge')?.merged).toBe(true);
      expect(readBranchState(h.ledger, 'job-conflict')?.mergeableState).toBe('dirty');
    } finally {
      h.cleanup();
    }
  });

  it('a second identical tick applies nothing: no notifications, no events, no transitions', async () => {
    const h = makeLedger();
    try {
      addTrackedJob(h.ledger, 'job-merge', 'https://github.com/acme/app/pull/10');
      addTrackedJob(h.ledger, 'job-conflict', 'https://github.com/acme/app/pull/11');
      addTrackedJob(h.ledger, 'job-green', 'https://github.com/acme/app/pull/12');
      const api = new FakeGhApi();
      api.pulls.set('acme/app', [
        pull({ number: 10, headRef: 'gru/job-merge', headSha: 'sha-10', merged: true }),
        pull({ number: 11, headRef: 'gru/job-conflict', headSha: 'sha-11' }),
        pull({ number: 12, headRef: 'gru/job-green', headSha: 'sha-12' }),
      ]);
      api.details.set('acme/app#11', pull({ number: 11, headRef: 'gru/job-conflict', headSha: 'sha-11', mergeableState: 'dirty' }));
      api.details.set('acme/app#12', pull({ number: 12, headRef: 'gru/job-green', headSha: 'sha-12', mergeableState: 'clean' }));
      api.checks.set('acme/app@sha-12', [{ name: 'Full suite', status: 'completed', conclusion: 'success', url: 'https://runs/12' }]);
      const notifications = new FakeNotifications();
      const poll = makePoll({ ledger: h.ledger, api, notifications });

      const first = await poll.pollOnce();
      expect(first.signals.map((signal) => signal.kind).sort()).toEqual(['ci-green', 'pr-conflict', 'pr-merged']);
      const firstCounts = {
        mergeEvents: eventCount(h.ledger, 'job-merge', 'github.pr-merged'),
        conflictEvents: eventCount(h.ledger, 'job-conflict', 'github.pr-conflict'),
        greenEvents: eventCount(h.ledger, 'job-green', 'github.ci-green'),
        cursorEvents: eventCount(h.ledger, 'job-conflict', BRANCH_STATE_EVENT),
        posts: notifications.posts.length,
      };

      const second = await poll.pollOnce();
      expect(second.signals).toEqual([]);
      expect(eventCount(h.ledger, 'job-merge', 'github.pr-merged')).toBe(firstCounts.mergeEvents);
      expect(eventCount(h.ledger, 'job-conflict', 'github.pr-conflict')).toBe(firstCounts.conflictEvents);
      expect(eventCount(h.ledger, 'job-green', 'github.ci-green')).toBe(firstCounts.greenEvents);
      expect(eventCount(h.ledger, 'job-conflict', BRANCH_STATE_EVENT)).toBe(firstCounts.cursorEvents);
      expect(notifications.posts).toHaveLength(firstCounts.posts);
    } finally {
      h.cleanup();
    }
  });

  it('a merged PR closes a blocked or delivered lane through the legal in-review hop', async () => {
    const h = makeLedger();
    try {
      addTrackedJob(h.ledger, 'job-blocked', 'https://github.com/acme/app/pull/20', 'blocked');
      addTrackedJob(h.ledger, 'job-delivered', 'https://github.com/acme/app/pull/21', 'delivered');
      const api = new FakeGhApi();
      api.pulls.set('acme/app', [
        pull({ number: 20, headRef: 'gru/job-blocked', headSha: 'sha-20', merged: true }),
        pull({ number: 21, headRef: 'gru/job-delivered', headSha: 'sha-21', merged: true }),
      ]);
      const poll = makePoll({ ledger: h.ledger, api });
      await poll.pollOnce();
      expect(h.ledger.getJob('job-blocked')?.status).toBe('merged');
      expect(h.ledger.getJob('job-delivered')?.status).toBe('merged');
      expect(h.ledger.getJob('job-blocked')?.status).not.toBe('done');
    } finally {
      h.cleanup();
    }
  });

  it('routes CI failure by check kind: judgment is action-required, mechanical is fyi', async () => {
    const h = makeLedger();
    try {
      addTrackedJob(h.ledger, 'job-mech', 'https://github.com/acme/app/pull/30');
      addTrackedJob(h.ledger, 'job-judge', 'https://github.com/acme/app/pull/31');
      const api = new FakeGhApi();
      api.pulls.set('acme/app', [
        pull({ number: 30, headRef: 'gru/job-mech', headSha: 'sha-30' }),
        pull({ number: 31, headRef: 'gru/job-judge', headSha: 'sha-31' }),
      ]);
      api.details.set('acme/app#30', pull({ number: 30, headRef: 'gru/job-mech', headSha: 'sha-30', mergeableState: 'clean' }));
      api.details.set('acme/app#31', pull({ number: 31, headRef: 'gru/job-judge', headSha: 'sha-31', mergeableState: 'clean' }));
      api.checks.set('acme/app@sha-30', [{ name: 'Full suite (Node 22)', status: 'completed', conclusion: 'failure', url: 'https://runs/30' }]);
      api.checks.set('acme/app@sha-31', [{ name: 'Perkins review', status: 'completed', conclusion: 'failure', url: 'https://runs/31' }]);
      const notifications = new FakeNotifications();
      const poll = makePoll({ ledger: h.ledger, api, notifications });

      await poll.pollOnce();
      const byJob = new Map(notifications.posts.map((post) => [post.kind, post]));
      const mechanical = byJob.get('github.ci-failed:job-mech:sha-30');
      const judgment = byJob.get('github.ci-failed:job-judge:sha-31');
      expect(mechanical).toMatchObject({ routing: 'fyi', severity: 'error', dedupe: 'unacked' });
      expect(mechanical?.detail).toContain('https://runs/30');
      expect(mechanical?.detail).toContain('tier 1 (mechanical)');
      expect(judgment).toMatchObject({ routing: 'action-required', severity: 'error' });
      expect(judgment?.detail).toContain('tier 2 (judgment)');
      expect(h.ledger.latestJobEvent('job-mech', 'github.ci-failed')?.payload).toMatchObject({ tier: 'mechanical' });
      expect(h.ledger.latestJobEvent('job-judge', 'github.ci-failed')?.payload).toMatchObject({ tier: 'judgment' });
    } finally {
      h.cleanup();
    }
  });

  it('poll tick budget: one pulls call per repo, one detail per open PR, one check-runs call per unique sha', async () => {
    const h = makeLedger();
    try {
      addTrackedJob(h.ledger, 'job-a1', 'https://github.com/acme/app/pull/40');
      addTrackedJob(h.ledger, 'job-a2', 'https://github.com/acme/app/pull/41');
      addTrackedJob(h.ledger, 'job-b1', 'https://github.com/acme/other/pull/42');
      const api = new FakeGhApi();
      api.pulls.set('acme/app', [
        pull({ number: 40, headRef: 'gru/job-a1', headSha: 'sha-shared' }),
        pull({ number: 41, headRef: 'gru/job-a2', headSha: 'sha-shared' }),
      ]);
      api.pulls.set('acme/other', [pull({ number: 42, headRef: 'gru/job-b1', headSha: 'sha-b1' })]);
      for (const number of [40, 41]) {
        api.details.set(`acme/app#${number}`, pull({ number, headRef: number === 40 ? 'gru/job-a1' : 'gru/job-a2', headSha: 'sha-shared', mergeableState: 'clean' }));
      }
      api.details.set('acme/other#42', pull({ number: 42, headRef: 'gru/job-b1', headSha: 'sha-b1', mergeableState: 'clean' }));

      const poll = makePoll({ ledger: h.ledger, api });
      const result = await poll.pollOnce();
      // 2 repos x 1 list + 3 open PRs x 1 detail + 2 unique shas x 1 check-runs
      expect(result.calls).toBe(7);
      expect(api.count('listPulls')).toBe(2);
      expect(api.count('getPull')).toBe(3);
      expect(api.count('listCheckRuns')).toBe(2);
      expect(result.observed).toBe(3);
    } finally {
      h.cleanup();
    }
  });

  it('the per-tick call cap defers the remainder of the tick loudly', async () => {
    const h = makeLedger();
    try {
      addTrackedJob(h.ledger, 'job-a1', 'https://github.com/acme/app/pull/50');
      addTrackedJob(h.ledger, 'job-a2', 'https://github.com/acme/app/pull/51');
      const api = new FakeGhApi();
      api.pulls.set('acme/app', [
        pull({ number: 50, headRef: 'gru/job-a1', headSha: 'sha-a1' }),
        pull({ number: 51, headRef: 'gru/job-a2', headSha: 'sha-a2' }),
      ]);
      api.details.set('acme/app#50', pull({ number: 50, headRef: 'gru/job-a1', headSha: 'sha-a1', mergeableState: 'clean' }));
      api.details.set('acme/app#51', pull({ number: 51, headRef: 'gru/job-a2', headSha: 'sha-a2', mergeableState: 'clean' }));
      const logs: string[] = [];
      const poll = makePoll({ ledger: h.ledger, api, maxCallsPerTick: 3, logs });

      const result = await poll.pollOnce();
      expect(result.calls).toBe(3);
      expect(result.budgetExhausted).toBe(true);
      expect(api.count('listPulls')).toBe(1);
      // the second lane's detail call was never attempted
      expect(api.count('getPull')).toBe(1);
      expect(result.observed).toBe(1);
      expect(logs.join('\n')).toContain('budget exhausted');
    } finally {
      h.cleanup();
    }
  });

  it('a GitHub rate limit aborts the tick and is reported, never hammered', async () => {
    const h = makeLedger();
    try {
      addTrackedJob(h.ledger, 'job-rl', 'https://github.com/acme/app/pull/60');
      const api = new FakeGhApi();
      api.failList.set('acme/app', new GhRateLimitedError('HTTP 403: API rate limit exceeded'));
      const logs: string[] = [];
      const poll = makePoll({ ledger: h.ledger, api, logs });
      const result = await poll.pollOnce();
      expect(result.rateLimited).toBe(true);
      expect(result.budgetExhausted).toBe(false);
      expect(result.calls).toBe(1);
      expect(result.observed).toBe(0);
      expect(logs.join('\n')).toContain('rate limit');
    } finally {
      h.cleanup();
    }
  });

  it('a failing repo does not blind the others: its lanes are skipped, the rest observe', async () => {
    const h = makeLedger();
    try {
      addTrackedJob(h.ledger, 'job-bad', 'https://github.com/acme/broken/pull/70');
      addTrackedJob(h.ledger, 'job-good', 'https://github.com/acme/app/pull/71');
      const api = new FakeGhApi();
      api.failList.set('acme/broken', new GhApiError('boom'));
      api.pulls.set('acme/app', [pull({ number: 71, headRef: 'gru/job-good', headSha: 'sha-71', merged: true })]);
      const logs: string[] = [];
      const poll = makePoll({ ledger: h.ledger, api, logs });

      const result = await poll.pollOnce();
      expect(result.rateLimited).toBe(false);
      expect(result.budgetExhausted).toBe(false);
      expect(result.observed).toBe(1);
      expect(h.ledger.getJob('job-good')?.status).toBe('merged');
      expect(h.ledger.getJob('job-bad')?.status).toBe('in-review');
      expect(logs.join('\n')).toContain('boom');
    } finally {
      h.cleanup();
    }
  });
});
