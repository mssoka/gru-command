import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import {
  GITLAB_EVIDENCE_MAX_AGE_MS,
  GITLAB_MR_MERGED_EVENT,
  GitLabSignalPoll,
} from '../src/dispatch/gitlab-poll.js';
import type { RepoRemote } from '../src/dispatch/review-path.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { GITLAB_MR_OBSERVED_EVENT, GITLAB_MR_READ_FAILED_EVENT } from '../src/review-inputs/ci-evidence.js';

/**
 * The GitLab signal poll (#568): one read per tracked merge request per tick,
 * the merge mapping through the shared merge map, the record-on-change
 * dedupe, and the two ways a tick ends early. The reader itself (the one
 * request, every classification, redaction) is pinned in
 * gitlab-mr-read.test.ts; the GitHub arm's unchanged behavior is pinned in
 * github-poll.test.ts, and the driver's timer in silas-driver.test.ts.
 */

const HOST = 'gitlab.example.test';
const PROJECT = 'acme/platform/app';
const SIBLING = 'acme/platform/app-extra';
const ORIGIN: RepoRemote = { host: HOST, owner: 'acme/platform', repo: 'app' };
const REPO_PATH = '/fixtures/acme-platform-app';
const TARGET = 'c7d2f34d633457c225732ed04fe82554d14c4501';
const MERGE_SHA = '3a1f0e6c2d9b47a85311627f0a1be0c9a2d4e7f5';
const SENTINEL = 'glpat-SENTINEL-9f3b1c7e5a2d4086';
const ENV = { GITLAB_TOKEN: SENTINEL } as const;
const MR_IID = 7;

const mrUrl = (project = PROJECT, iid = MR_IID, host = HOST): string =>
  `https://${host}/${project}/-/merge_requests/${iid}`;
const MR_URL = mrUrl();
const API_URL = `https://${HOST}/api/v4/projects/acme%2Fplatform%2Fapp/merge_requests/${MR_IID}`;

function mrBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: MR_IID,
    state: 'opened',
    sha: TARGET,
    web_url: MR_URL,
    head_pipeline: {
      id: 4242, sha: TARGET, status: 'success', source: 'merge_request_event',
      web_url: `https://${HOST}/${PROJECT}/-/pipelines/4242`,
    },
    merge_commit_sha: null,
    detailed_merge_status: 'mergeable',
    ...overrides,
  };
}

/** A merged merge request: the state, the merge commit, no head pipeline. */
function mergedBody(project = PROJECT, iid = MR_IID, host = HOST): Record<string, unknown> {
  return mrBody({
    iid,
    state: 'merged',
    web_url: mrUrl(project, iid, host),
    head_pipeline: null,
    merge_commit_sha: MERGE_SHA,
  });
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fetchDouble(answer: (call: Call) => Response): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

interface LogEntry {
  readonly level: string;
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeLedger(): LedgerApi {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-gitlab-poll-'));
  const db = new LedgerDb(dir);
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new LedgerApi(db.handle, { bus: new EventBus() });
}

/** A live lane with a recorded merge-request link and a live worktree row. */
function addLane(
  api: LedgerApi,
  jobId: string,
  options: { readonly prUrl?: string | null; readonly status?: string; readonly repoPath?: string } = {},
): void {
  api.addJob({ id: jobId, repo: 'fixture-app', title: `t-${jobId}`, briefing: 'b' });
  api.setJobStatus(jobId, 'working');
  const prUrl = options.prUrl === undefined ? MR_URL : options.prUrl;
  if (prUrl !== null) api.setJobPr(jobId, prUrl);
  api.registerWorktree({
    id: `wt-${jobId}`,
    kind: 'job',
    repoPath: options.repoPath ?? REPO_PATH,
    repoName: 'app',
    path: `/lanes/${jobId}`,
    branch: `gru/${jobId}`,
    sha: TARGET,
    jobId,
  });
  const status = options.status ?? 'in-review';
  if (status !== 'working') api.setJobStatus(jobId, status);
}

function makePoll(input: {
  readonly ledger: LedgerApi;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly resolveRemote?: (repoPath: string) => RepoRemote | null;
  readonly logs?: LogEntry[];
}): GitLabSignalPoll {
  return new GitLabSignalPoll({
    ledger: input.ledger,
    resolveRemote: input.resolveRemote ?? (() => ORIGIN),
    deps: { fetch: input.fetch, env: ENV },
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    log: (level, msg, fields) => {
      input.logs?.push({ level, msg, ...(fields !== undefined ? { fields } : {}) });
    },
  });
}

const jobEvents = (api: LedgerApi, jobId: string, kind: string): readonly { readonly payload: unknown }[] =>
  api.listJobEvents(jobId, { limit: 200 }).filter((event) => event.kind === kind);
const count = (api: LedgerApi, jobId: string, kind: string): number => jobEvents(api, jobId, kind).length;
const jobKinds = (api: LedgerApi, jobId: string): readonly string[] =>
  api.listJobEvents(jobId, { limit: 200 }).map((event) => event.kind);
const gitlabKinds = (api: LedgerApi, jobId: string): readonly string[] =>
  jobKinds(api, jobId).filter((kind) => kind.startsWith('gitlab.'));
const githubKinds = (api: LedgerApi, jobId: string): readonly string[] =>
  jobKinds(api, jobId).filter((kind) => kind.startsWith('github.'));

describe('gitlab signal poll tick', () => {
  it('A1: a merged MR closes each live lane status through the legal in-review hop, once', async () => {
    for (const status of ['working', 'delivered', 'in-review', 'blocked', 'parked']) {
      const api = makeLedger();
      addLane(api, 'job-merged', { status });
      const { calls, fetch } = fetchDouble(() => json(mergedBody()));
      const result = await makePoll({ ledger: api, fetch }).pollOnce();
      expect(result, status).toEqual({
        tracked: 1, reads: 1, observed: 1, merged: 1, deadlineExceeded: false, rateLimited: false,
      });
      expect(calls, status).toHaveLength(1);
      expect(calls[0]!.url, status).toBe(API_URL);
      expect(calls[0]!.init?.headers, status).toEqual({ 'PRIVATE-TOKEN': SENTINEL });
      expect(api.getJob('job-merged')?.status, status).toBe('merged');
      const merged = jobEvents(api, 'job-merged', GITLAB_MR_MERGED_EVENT);
      expect(merged, status).toHaveLength(1);
      expect(merged[0]!.payload, status).toEqual({
        host: HOST,
        project: PROJECT,
        mr_iid: MR_IID,
        url: MR_URL,
        sha: TARGET,
        merge_commit_sha: MERGE_SHA,
        applied: true,
      });
      // the GitHub arm records nothing for a merge request
      expect(githubKinds(api, 'job-merged'), status).toEqual([]);
      expect(count(api, 'job-merged', GITLAB_MR_OBSERVED_EVENT), status).toBe(1);
    }
  });

  it('A2: an unchanged observation is recorded once while every tick still reads; a head move records again', async () => {
    const api = makeLedger();
    addLane(api, 'job-dedupe');
    let body = mrBody();
    const { calls, fetch } = fetchDouble(() => json(body));
    const poll = makePoll({ ledger: api, fetch });

    const first = await poll.pollOnce();
    expect(first).toEqual({ tracked: 1, reads: 1, observed: 1, merged: 0, deadlineExceeded: false, rateLimited: false });
    const second = await poll.pollOnce();
    expect(second).toEqual({ tracked: 1, reads: 1, observed: 0, merged: 0, deadlineExceeded: false, rateLimited: false });
    // the read happens every tick; only the RECORD is deduped
    expect(calls).toHaveLength(2);
    expect(count(api, 'job-dedupe', GITLAB_MR_OBSERVED_EVENT)).toBe(1);
    expect(api.getJob('job-dedupe')?.status).toBe('in-review');

    const nextHead = 'ffff0000aaaa1111bbbb2222cccc3333dddd4444';
    body = mrBody({
      sha: nextHead,
      head_pipeline: { id: 5000, sha: nextHead, status: 'running', source: 'merge_request_event', web_url: null },
    });
    const third = await poll.pollOnce();
    expect(third.observed).toBe(1);
    expect(third.merged).toBe(0);
    expect(count(api, 'job-dedupe', GITLAB_MR_OBSERVED_EVENT)).toBe(2);
    expect(api.getJob('job-dedupe')?.status).toBe('in-review');
  });

  it('A2: a merged MR applies once — a second tick and a fresh poller add neither event nor status change', async () => {
    const api = makeLedger();
    addLane(api, 'job-replay');
    const { fetch } = fetchDouble(() => json(mergedBody()));
    const poll = makePoll({ ledger: api, fetch });
    await poll.pollOnce();
    expect(api.getJob('job-replay')?.status).toBe('merged');
    expect(count(api, 'job-replay', GITLAB_MR_MERGED_EVENT)).toBe(1);

    const replay = await poll.pollOnce();
    expect(replay).toEqual({ tracked: 0, reads: 0, observed: 0, merged: 0, deadlineExceeded: false, rateLimited: false });
    expect(count(api, 'job-replay', GITLAB_MR_MERGED_EVENT)).toBe(1);
    expect(count(api, 'job-replay', GITLAB_MR_OBSERVED_EVENT)).toBe(1);

    // a restart reads the same ledger cursor: nothing double-applies
    const restarted = await makePoll({ ledger: api, fetch }).pollOnce();
    expect(restarted.merged).toBe(0);
    expect(restarted.observed).toBe(0);
    expect(count(api, 'job-replay', GITLAB_MR_MERGED_EVENT)).toBe(1);
    expect(api.getJob('job-replay')?.status).toBe('merged');
  });

  it('A2: a mergeable-only change at the same head records a second observation', async () => {
    const api = makeLedger();
    addLane(api, 'job-mergeable');
    // GitLab has not computed detailed_merge_status yet: mergeability unknown.
    let body = mrBody({ detailed_merge_status: undefined });
    const { fetch } = fetchDouble(() => json(body));
    const poll = makePoll({ ledger: api, fetch });

    expect(await poll.pollOnce()).toMatchObject({ tracked: 1, reads: 1, observed: 1, merged: 0 });
    const first = api.latestJobEvent('job-mergeable', GITLAB_MR_OBSERVED_EVENT);
    expect(first?.payload).toMatchObject({ mergeable: 'unknown', state: 'opened', head_sha: TARGET });

    // Same state, head and head pipeline; only mergeability moves to clean.
    body = mrBody();
    const second = await poll.pollOnce();
    expect(second).toEqual({ tracked: 1, reads: 1, observed: 1, merged: 0, deadlineExceeded: false, rateLimited: false });
    expect(count(api, 'job-mergeable', GITLAB_MR_OBSERVED_EVENT)).toBe(2);
    const newest = api.latestJobEvent('job-mergeable', GITLAB_MR_OBSERVED_EVENT);
    expect(newest?.payload).toMatchObject({ mergeable: 'clean', state: 'opened', head_sha: TARGET });

    // The clean tuple then dedupes as usual.
    expect((await poll.pollOnce()).observed).toBe(0);
    expect(count(api, 'job-mergeable', GITLAB_MR_OBSERVED_EVENT)).toBe(2);
  });

  it('A2: a merged observation an earlier read recorded still closes the lane on the next tick, once', async () => {
    const api = makeLedger();
    addLane(api, 'job-round-merged');
    // A review round (round-scoped) recorded this exact observation while the
    // lane was still live, so the poll's identical read is not re-recorded.
    api.appendCustomEvent({
      kind: GITLAB_MR_OBSERVED_EVENT,
      jobId: 'job-round-merged',
      roundId: 'round-1',
      payload: {
        host: HOST, project: PROJECT, mr_iid: MR_IID, state: 'merged',
        head_sha: TARGET, head_pipeline: null, merge_commit_sha: MERGE_SHA,
        mergeable: 'clean', round_id: 'round-1',
      },
    });
    const { fetch } = fetchDouble(() => json(mergedBody()));
    const poll = makePoll({ ledger: api, fetch });

    const first = await poll.pollOnce();
    expect(first).toEqual({
      tracked: 1, reads: 1, observed: 0, merged: 1, deadlineExceeded: false, rateLimited: false,
    });
    expect(api.getJob('job-round-merged')?.status).toBe('merged');
    const merged = jobEvents(api, 'job-round-merged', GITLAB_MR_MERGED_EVENT);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.payload).toMatchObject({ applied: true, mr_iid: MR_IID, merge_commit_sha: MERGE_SHA });
    expect(count(api, 'job-round-merged', GITLAB_MR_OBSERVED_EVENT)).toBe(1);

    const second = await poll.pollOnce();
    expect(second).toEqual({ tracked: 0, reads: 0, observed: 0, merged: 0, deadlineExceeded: false, rateLimited: false });
    expect(count(api, 'job-round-merged', GITLAB_MR_MERGED_EVENT)).toBe(1);
    expect(count(api, 'job-round-merged', GITLAB_MR_OBSERVED_EVENT)).toBe(1);
  });

  it('A2: an idle lane observation is re-recorded once it ages, not once per tick', async () => {
    const api = makeLedger();
    addLane(api, 'job-idle');
    let clock = Date.now();
    const { fetch } = fetchDouble(() => json(mrBody()));
    const poll = makePoll({ ledger: api, fetch, now: () => clock });

    await poll.pollOnce();
    const first = api.latestJobEvent('job-idle', GITLAB_MR_OBSERVED_EVENT);
    expect(first).not.toBeNull();
    if (first === null) throw new Error('the first tick recorded no observation');

    clock = Date.parse(first.ts);
    expect((await poll.pollOnce()).observed).toBe(0);
    expect(count(api, 'job-idle', GITLAB_MR_OBSERVED_EVENT)).toBe(1);

    // unchanged facts, but old enough to stop certifying owner readiness
    clock = Date.parse(first.ts) + GITLAB_EVIDENCE_MAX_AGE_MS + 1;
    expect((await poll.pollOnce()).observed).toBe(1);
    expect(count(api, 'job-idle', GITLAB_MR_OBSERVED_EVENT)).toBe(2);
    const refreshed = api.latestJobEvent('job-idle', GITLAB_MR_OBSERVED_EVENT);
    if (refreshed === null) throw new Error('the aged re-record wrote no event');
    clock = Date.parse(refreshed.ts);
    expect((await poll.pollOnce()).observed).toBe(0);
    expect(count(api, 'job-idle', GITLAB_MR_OBSERVED_EVENT)).toBe(2);
  });

  it('A3: a lane that cannot take the in-review hop records the exact refusal and keeps its status', async () => {
    const api = makeLedger();
    addLane(api, 'job-dispatched', { status: 'blocked' });
    const logs: LogEntry[] = [];
    const { fetch } = fetchDouble(() => {
      // the status moves while the read is in flight: dispatched -> in-review
      // has no edge, so the merge must be refused, never coerced.
      api.setJobStatus('job-dispatched', 'dispatched');
      return json(mergedBody());
    });
    const result = await makePoll({ ledger: api, fetch, logs }).pollOnce();
    expect(result).toEqual({ tracked: 1, reads: 1, observed: 1, merged: 0, deadlineExceeded: false, rateLimited: false });
    expect(api.getJob('job-dispatched')?.status).toBe('dispatched');
    const receipt = jobEvents(api, 'job-dispatched', GITLAB_MR_MERGED_EVENT);
    expect(receipt).toHaveLength(1);
    expect(receipt[0]!.payload).toEqual({
      host: HOST,
      project: PROJECT,
      mr_iid: MR_IID,
      url: MR_URL,
      sha: TARGET,
      merge_commit_sha: MERGE_SHA,
      applied: false,
      reason: 'Error: job illegal transition dispatched → in-review (legal: working, blocked, parked, binned)',
    });
    const refusal = logs.find((entry) => entry.level === 'error');
    expect(refusal?.msg).toBe('gitlab poll: merged MR could not close the lane');
    expect(refusal?.fields).toMatchObject({
      job: 'job-dispatched', host: HOST, project: PROJECT, mr_iid: MR_IID, status: 'dispatched',
    });
    expect(String(refusal?.fields?.['error'])).toContain('illegal transition dispatched → in-review');
  });

  it('A4: a lane binned while its read is in flight gets exactly one no-effect receipt', async () => {
    const api = makeLedger();
    addLane(api, 'job-binned', { status: 'working' });
    const { fetch } = fetchDouble(() => {
      api.setJobStatus('job-binned', 'binned');
      return json(mergedBody());
    });
    const poll = makePoll({ ledger: api, fetch });
    const first = await poll.pollOnce();
    expect(first).toMatchObject({ tracked: 1, reads: 1, observed: 1, merged: 0 });
    expect(api.getJob('job-binned')?.status).toBe('binned');
    const receipts = jobEvents(api, 'job-binned', GITLAB_MR_MERGED_EVENT);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.payload).toMatchObject({ applied: false, reason: 'job is binned' });

    // a binned lane is never tracked again: no read, no second receipt
    const second = await poll.pollOnce();
    expect(second).toMatchObject({ tracked: 0, reads: 0, merged: 0 });
    expect(count(api, 'job-binned', GITLAB_MR_MERGED_EVENT)).toBe(1);
  });

  it('A4: a lane that settles as merged or done during the read records nothing', async () => {
    for (const settled of ['merged', 'done']) {
      const api = makeLedger();
      addLane(api, 'job-settled');
      const { fetch } = fetchDouble(() => {
        api.setJobStatus('job-settled', settled);
        return json(mergedBody());
      });
      const result = await makePoll({ ledger: api, fetch }).pollOnce();
      expect(result, settled).toMatchObject({ tracked: 1, reads: 1, observed: 1, merged: 0 });
      expect(api.getJob('job-settled')?.status, settled).toBe(settled);
      expect(count(api, 'job-settled', GITLAB_MR_MERGED_EVENT), settled).toBe(0);
    }
  });

  it('A5: a link that is not the lane origin, or is on an unsupported host, is never read', async () => {
    const api = makeLedger();
    addLane(api, 'job-other-project', { prUrl: mrUrl('acme/other-app') });
    addLane(api, 'job-other-host', { prUrl: mrUrl(PROJECT, MR_IID, 'gitlab.other.test') });
    addLane(api, 'job-unsupported', { prUrl: 'https://git.example.test/acme/platform/app/-/merge_requests/7' });
    const logs: LogEntry[] = [];
    const { calls, fetch } = fetchDouble(() => json(mergedBody()));
    const poll = makePoll({ ledger: api, fetch, logs });

    const result = await poll.pollOnce();
    expect(result).toEqual({ tracked: 0, reads: 0, observed: 0, merged: 0, deadlineExceeded: false, rateLimited: false });
    // not one request: no token leaves the lane's own host
    expect(calls).toEqual([]);
    for (const jobId of ['job-other-project', 'job-other-host', 'job-unsupported']) {
      expect(api.getJob(jobId)?.status, jobId).toBe('in-review');
      expect(gitlabKinds(api, jobId), jobId).toEqual([]);
    }
    // one deduped line per skipped lane, never one per tick
    expect(logs).toHaveLength(3);
    expect(logs.every((entry) => entry.level === 'warn')).toBe(true);
    await poll.pollOnce();
    expect(logs).toHaveLength(3);
  });

  it('A5: a lane with no resolvable origin is never read, records nothing, and logs its skip once', async () => {
    const api = makeLedger();
    // No worktree row for this job: there is no origin to bind the link to.
    api.addJob({ id: 'job-no-lane', repo: 'fixture-app', title: 't-job-no-lane', briefing: 'b' });
    api.setJobStatus('job-no-lane', 'working');
    api.setJobPr('job-no-lane', MR_URL);
    const logs: LogEntry[] = [];
    const { calls, fetch } = fetchDouble(() => json(mergedBody()));
    const poll = makePoll({ ledger: api, fetch, logs });

    const result = await poll.pollOnce();
    expect(result).toEqual({ tracked: 0, reads: 0, observed: 0, merged: 0, deadlineExceeded: false, rateLimited: false });
    expect(calls).toEqual([]);
    expect(gitlabKinds(api, 'job-no-lane')).toEqual([]);
    expect(api.getJob('job-no-lane')?.status).toBe('working');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 'warn',
      msg: 'gitlab poll: merge request link is not the lane origin; not read',
      fields: {
        job: 'job-no-lane',
        host: HOST,
        project: PROJECT,
        mr_iid: MR_IID,
        reason: expect.stringContaining('no resolvable origin remote'),
      },
    });
    // one deduped line per skipped lane, never one per tick
    await poll.pollOnce();
    expect(logs).toHaveLength(1);
  });

  it('A5: a response that names another project, iid or host never merges the lane', async () => {
    const answers: readonly (readonly [string, Record<string, unknown>])[] = [
      ['another project', mrBody({ state: 'merged', merge_commit_sha: MERGE_SHA, web_url: mrUrl('acme/platform/other') })],
      ['another iid', mrBody({ iid: 8, state: 'merged', merge_commit_sha: MERGE_SHA, web_url: mrUrl(PROJECT, 8) })],
      ['another host', mrBody({ state: 'merged', merge_commit_sha: MERGE_SHA, web_url: mrUrl(PROJECT, MR_IID, 'gitlab.other.test') })],
    ];
    for (const [label, body] of answers) {
      const api = makeLedger();
      addLane(api, 'job-identity');
      const { fetch } = fetchDouble(() => json(body));
      const result = await makePoll({ ledger: api, fetch }).pollOnce();
      expect(result, label).toMatchObject({ tracked: 1, reads: 1, observed: 1, merged: 0 });
      expect(api.getJob('job-identity')?.status, label).toBe('in-review');
      expect(count(api, 'job-identity', GITLAB_MR_MERGED_EVENT), label).toBe(0);
    }
  });

  it('A5: sibling subgroups and a case-differing project each merge their own lane; a GitHub PR is untouched', async () => {
    const api = makeLedger();
    const remotes: Record<string, RepoRemote> = {
      '/lanes/exact': ORIGIN,
      '/lanes/sibling': { host: HOST, owner: 'acme/platform', repo: 'app-extra' },
      '/lanes/case': ORIGIN,
    };
    addLane(api, 'job-exact', { repoPath: '/lanes/exact' });
    addLane(api, 'job-sibling', { repoPath: '/lanes/sibling', prUrl: mrUrl(SIBLING) });
    addLane(api, 'job-case', { repoPath: '/lanes/case', prUrl: mrUrl('ACME/Platform/App') });
    addLane(api, 'job-github', { repoPath: '/lanes/github', prUrl: 'https://github.com/acme/app/pull/7' });
    const { calls, fetch } = fetchDouble((call) =>
      json(call.url.includes('app-extra') ? mergedBody(SIBLING) : mergedBody()),
    );
    const result = await makePoll({ ledger: api, fetch, resolveRemote: (repoPath) => remotes[repoPath] ?? null })
      .pollOnce();
    expect(result).toMatchObject({ tracked: 3, reads: 3, observed: 3, merged: 3, rateLimited: false });
    expect(calls.map((call) => call.url).sort()).toEqual([
      `https://${HOST}/api/v4/projects/ACME%2FPlatform%2FApp/merge_requests/${MR_IID}`,
      `https://${HOST}/api/v4/projects/acme%2Fplatform%2Fapp-extra/merge_requests/${MR_IID}`,
      `https://${HOST}/api/v4/projects/acme%2Fplatform%2Fapp/merge_requests/${MR_IID}`,
    ].sort());
    for (const jobId of ['job-exact', 'job-sibling', 'job-case']) {
      expect(api.getJob(jobId)?.status, jobId).toBe('merged');
      expect(count(api, jobId, GITLAB_MR_MERGED_EVENT), jobId).toBe(1);
    }
    // the GitHub arm's lane: same number, no GitLab read, no GitLab event
    expect(api.getJob('job-github')?.status).toBe('in-review');
    expect(gitlabKinds(api, 'job-github')).toEqual([]);
    expect(calls.some((call) => call.url.includes('github'))).toBe(false);
  });

  it('A6: closed, locked, opened and failed reads leave the lane unchanged; the merged read is the control', async () => {
    const api = makeLedger();
    const bodies = new Map<number, () => Response>([
      [11, () => json(mrBody({ iid: 11, web_url: mrUrl(PROJECT, 11), state: 'closed' }))],
      [12, () => json(mrBody({ iid: 12, web_url: mrUrl(PROJECT, 12), state: 'locked' }))],
      [13, () => json(mrBody({ iid: 13, web_url: mrUrl(PROJECT, 13), state: 'opened' }))],
      [14, () => new Response(`boom ${SENTINEL}`, { status: 503 })],
      [15, () => json(mergedBody(PROJECT, 15))],
    ]);
    const lanes: readonly (readonly [string, number])[] = [
      ['job-closed', 11], ['job-locked', 12], ['job-opened', 13], ['job-failed', 14], ['job-merged-control', 15],
    ];
    for (const [jobId, iid] of lanes) addLane(api, jobId, { prUrl: mrUrl(PROJECT, iid) });
    const { fetch } = fetchDouble((call) => {
      const iid = Number(/merge_requests\/(\d+)$/u.exec(call.url)?.[1]);
      const answer = bodies.get(iid);
      if (answer === undefined) throw new Error(`unexpected request ${call.url}`);
      return answer();
    });
    const result = await makePoll({ ledger: api, fetch }).pollOnce();
    expect(result).toMatchObject({ tracked: 5, reads: 5, observed: 4, merged: 1 });
    for (const jobId of ['job-closed', 'job-locked', 'job-opened', 'job-failed']) {
      expect(api.getJob(jobId)?.status, jobId).toBe('in-review');
      expect(count(api, jobId, GITLAB_MR_MERGED_EVENT), jobId).toBe(0);
    }
    const failed = jobEvents(api, 'job-failed', GITLAB_MR_READ_FAILED_EVENT);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ host: HOST, project: PROJECT, mr_iid: 14, error_kind: 'other' });
    expect(JSON.stringify(failed[0]!.payload)).not.toContain(SENTINEL);
    // control: the one merged read still merges
    expect(api.getJob('job-merged-control')?.status).toBe('merged');
    expect(count(api, 'job-merged-control', GITLAB_MR_MERGED_EVENT)).toBe(1);
  });

  it('A6: a run of the same failed read records once, ends the tick on a rate limit, and a success supersedes it', async () => {
    const api = makeLedger();
    addLane(api, 'job-a');
    addLane(api, 'job-b');
    let answer: () => Response = () => new Response('slow down', { status: 429 });
    const { calls, fetch } = fetchDouble(() => answer());
    const poll = makePoll({ ledger: api, fetch });

    const first = await poll.pollOnce();
    expect(first).toMatchObject({ tracked: 2, reads: 1, observed: 0, merged: 0, rateLimited: true });
    // the rate limit ends the tick: the remaining lane is not read
    expect(calls).toHaveLength(1);
    expect(count(api, 'job-a', GITLAB_MR_READ_FAILED_EVENT)).toBe(1);
    expect(gitlabKinds(api, 'job-b')).toEqual([]);

    const second = await poll.pollOnce();
    expect(second).toMatchObject({ tracked: 2, reads: 1, rateLimited: true });
    // one failed event per error kind: the repeat records nothing
    expect(count(api, 'job-a', GITLAB_MR_READ_FAILED_EVENT)).toBe(1);

    answer = () => json(mrBody());
    const third = await poll.pollOnce();
    expect(third).toMatchObject({ tracked: 2, reads: 2, observed: 2, rateLimited: false });
    // the live observation supersedes the recorded failure
    expect(count(api, 'job-a', GITLAB_MR_READ_FAILED_EVENT)).toBe(1);
    expect(count(api, 'job-a', GITLAB_MR_OBSERVED_EVENT)).toBe(1);
    const newest = api.latestJobEvent('job-a', GITLAB_MR_OBSERVED_EVENT);
    const failure = api.latestJobEvent('job-a', GITLAB_MR_READ_FAILED_EVENT);
    expect(newest).not.toBeNull();
    expect(failure).not.toBeNull();
    expect(newest!.seq).toBeGreaterThan(failure!.seq);
  });

  it('A6: a tick stops starting reads once its wall-clock deadline has passed', async () => {
    const api = makeLedger();
    addLane(api, 'job-a');
    addLane(api, 'job-b');
    let clock = 1_000;
    const { calls, fetch } = fetchDouble(() => {
      clock += 30_000;
      return json(mrBody());
    });
    const result = await makePoll({ ledger: api, fetch, now: () => clock, deadlineMs: 30_000 }).pollOnce();
    expect(result).toMatchObject({ tracked: 2, reads: 1, observed: 1, deadlineExceeded: true });
    expect(calls).toHaveLength(1);
    expect(api.getJob('job-b')?.status).toBe('in-review');
    expect(gitlabKinds(api, 'job-b')).toEqual([]);
  });

  it('A7: a parent merge leaves the child job, its events, obligations, directive requests, decisions and worktrees untouched', async () => {
    const api = makeLedger();
    addLane(api, 'job-parent');
    api.addJob({
      id: 'job-child', repo: 'fixture-app', title: 'child', deliverable: 'review', parentJobId: 'job-parent',
    });
    api.setJobStatus('job-child', 'blocked');
    api.registerWorktree({
      id: 'wt-job-child', kind: 'job', repoPath: REPO_PATH, repoName: 'app',
      path: '/lanes/job-child', branch: 'gru/job-child', sha: TARGET, jobId: 'job-child',
    });
    api.beginDirectiveIntent({ jobId: 'job-child', directive: 'inspect the child report', holder: 'minion-1' });
    api.recordDecision({ subject: 'job:job-child', decision: 'hold', covers: ['gitlab.mr-merged'], reason: 'fixture', by: 'silas' });
    const snapshot = () => ({
      job: api.getJob('job-child'),
      events: api.listJobEvents('job-child', { limit: 200 }),
      obligations: api.listObligations({ jobId: 'job-child' }),
      directives: api.listPendingDirectives({ jobId: 'job-child' }),
      decisions: api.listDecisions({ subject: 'job:job-child' }),
      worktrees: api.listWorktrees({ jobId: 'job-child' }),
    });
    const before = snapshot();
    const { fetch } = fetchDouble(() => json(mergedBody()));
    const result = await makePoll({ ledger: api, fetch }).pollOnce();

    // positive control: the parent really did merge, exactly once
    expect(result).toMatchObject({ tracked: 1, reads: 1, merged: 1 });
    expect(api.getJob('job-parent')?.status).toBe('merged');
    expect(count(api, 'job-parent', GITLAB_MR_MERGED_EVENT)).toBe(1);
    // and the child is untouched in every durable shape
    expect(snapshot()).toEqual(before);
    expect(api.getJob('job-child')?.status).toBe('blocked');
  });
});
