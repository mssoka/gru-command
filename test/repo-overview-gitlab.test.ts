import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidSnapshot } from '../web/src/lib/board-protocol.js';
import {
  repoCiView,
  repoRowAriaLabel,
  repoRowBadge,
  repoRowNote,
  repoRunContextTitle,
} from '../web/src/lib/repo-overview.js';
import { GhRateLimitedError, repoFullName, type RepoRef } from '../src/dispatch/github-poll.js';
import { parseRepoRemote } from '../src/dispatch/review-path.js';
import {
  GITLAB_OVERVIEW_TIMEOUT_MS,
  GitLabRepoOverviewApi,
  type GitLabFetch,
} from '../src/repos/gitlab-overview.js';
import {
  ManagedRepoOverviewTracker,
  REPO_OVERVIEW_RUNS_PER_FETCH,
  RepoProviderError,
  classifyGhError,
  classifyRemote,
  gitLabPipelineStateOf,
  gitLabProjectMetaOf,
  gitlabRepoLink,
  type ActionsAvailability,
  type DefaultBranchRunsObservation,
  type GitLabPipelineRaw,
  type GitLabProjectMeta,
  type GitLabRepoOverviewApiPort,
  type RepoOverviewApiPort,
  type RepoOverviewMeta,
  type RepoOverviewRowView,
  type RepoOverviewRunRaw,
  type RepoOverviewView,
} from '../src/repos/overview.js';

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const TOKEN = 'glpat-test-secret-0123456789';

function githubRef(repo: string): RepoRef {
  return { host: 'github.com', owner: 'acme', repo };
}

function gitlabRef(repo: string, host = 'gitlab.example.com', owner = 'group/sub'): RepoRef {
  return { host, owner, repo };
}

function pipeline(over: Partial<GitLabPipelineRaw> = {}): GitLabPipelineRaw {
  return {
    id: 9001,
    iid: 41,
    name: null,
    status: 'success',
    source: 'push',
    ref: 'main',
    url: 'https://gitlab.example.com/group/sub/project/-/pipelines/9001',
    createdAt: '2026-10-22T10:00:00.000Z',
    startedAt: '2026-10-22T10:00:05.000Z',
    updatedAt: '2026-10-22T10:05:00.000Z',
    ...over,
  };
}

type GitLabCall = 'fetchProject' | 'countOpenMergeRequests' | 'countOpenIssues' | 'latestPipelines';

interface GitLabFacts {
  readonly project?: GitLabProjectMeta;
  readonly openMrs?: number;
  readonly openIssues?: number;
  readonly pipelines?: readonly GitLabPipelineRaw[];
  readonly errors?: Partial<Record<GitLabCall, unknown>>;
}

/** Deterministic GitLab port: every call is recorded as `call:host/path`. */
class FakeGitLab implements GitLabRepoOverviewApiPort {
  readonly calls: string[] = [];
  readonly facts = new Map<string, GitLabFacts>();

  set(repo: string, facts: GitLabFacts): this {
    this.facts.set(repo, facts);
    return this;
  }

  private record(name: GitLabCall, repo: RepoRef): GitLabFacts {
    this.calls.push(`${name}:${repo.host}/${repoFullName(repo)}`);
    const facts = this.facts.get(repo.repo) ?? {};
    const error = facts.errors?.[name];
    if (error !== undefined) throw error;
    return facts;
  }

  async fetchProject(input: { readonly repo: RepoRef }): Promise<GitLabProjectMeta> {
    return this.record('fetchProject', input.repo).project ?? { defaultBranch: 'main', ciEnabled: true };
  }

  async countOpenMergeRequests(input: { readonly repo: RepoRef }): Promise<number> {
    return this.record('countOpenMergeRequests', input.repo).openMrs ?? 0;
  }

  async countOpenIssues(input: { readonly repo: RepoRef }): Promise<number> {
    return this.record('countOpenIssues', input.repo).openIssues ?? 0;
  }

  async latestPipelines(input: {
    readonly repo: RepoRef;
    readonly branch: string;
    readonly limit: number;
  }): Promise<readonly GitLabPipelineRaw[]> {
    const facts = this.record('latestPipelines', input.repo);
    expect(input.limit).toBe(REPO_OVERVIEW_RUNS_PER_FETCH);
    return facts.pipelines ?? [pipeline({ ref: input.branch })];
  }
}

/** The GitHub port, answering every repository with one passing run. */
class FakeGitHub implements RepoOverviewApiPort {
  readonly calls: string[] = [];
  readonly errors = new Map<string, unknown>();

  private record(name: string, repo: RepoRef): void {
    this.calls.push(`${name}:${repoFullName(repo)}`);
    const error = this.errors.get(`${name}:${repo.repo}`);
    if (error !== undefined) throw error;
  }

  async fetchRepo(input: { readonly repo: RepoRef }): Promise<RepoOverviewMeta> {
    this.record('fetchRepo', input.repo);
    return { defaultBranch: 'main' };
  }

  async countOpenPulls(input: { readonly repo: RepoRef }): Promise<number> {
    this.record('countOpenPulls', input.repo);
    return 2;
  }

  async countOpenIssues(input: { readonly repo: RepoRef }): Promise<number> {
    this.record('countOpenIssues', input.repo);
    return 3;
  }

  async countWorkflows(input: { readonly repo: RepoRef }): Promise<ActionsAvailability<number>> {
    this.record('countWorkflows', input.repo);
    return { kind: 'ok', value: 1 };
  }

  async latestRuns(input: {
    readonly repo: RepoRef;
    readonly branch: string;
    readonly limit: number;
  }): Promise<ActionsAvailability<readonly RepoOverviewRunRaw[]>> {
    this.record('latestRuns', input.repo);
    return {
      kind: 'ok',
      value: [
        {
          id: 1,
          name: 'checks',
          status: 'completed',
          conclusion: 'success',
          url: `https://github.com/acme/${input.repo.repo}/actions/runs/1`,
          runNumber: 1,
          createdAt: '2026-10-22T10:00:00.000Z',
          startedAt: '2026-10-22T10:00:00.000Z',
          updatedAt: '2026-10-22T10:05:00.000Z',
          workflowId: 101,
          headSha: '3684087c0000000000000000000000000000beef',
          event: 'push',
          fromFork: false,
        },
      ],
    };
  }
}

/** Today's exact GitHub call sequence for one repository. */
function githubCalls(repo: string): string[] {
  return ['fetchRepo', 'countOpenPulls', 'countOpenIssues', 'countWorkflows', 'latestRuns'].map(
    (call) => `${call}:acme/${repo}`,
  );
}

interface Harness {
  readonly tracker: ManagedRepoOverviewTracker;
  readonly github: FakeGitHub;
  readonly refs: Map<string, RepoRef | null>;
  readonly clock: { ms: number };
  readonly logs: { level: string; msg: string; fields: Record<string, unknown> | null }[];
  readonly alerts: DefaultBranchRunsObservation[];
}

function harness(options: {
  refs: ReadonlyMap<string, RepoRef | null>;
  gitlabApi?: GitLabRepoOverviewApiPort | null;
  github?: FakeGitHub;
}): Harness {
  const github = options.github ?? new FakeGitHub();
  const refs = new Map(options.refs);
  const clock = { ms: T0 };
  const logs: Harness['logs'] = [];
  const alerts: DefaultBranchRunsObservation[] = [];
  const names = [...refs.keys()];
  const tracker = new ManagedRepoOverviewTracker({
    workspaceRoot: '/ws',
    managedRepos: names,
    api: github,
    ...(options.gitlabApi === null ? {} : { gitlabApi: options.gitlabApi ?? new FakeGitLab() }),
    scanRepos: () => names,
    resolveRepoPath: (_workspaceRoot, name) => ({ kind: 'available', path: `/ws/${name}` }),
    resolveRemote: (repoPath) => refs.get(repoPath.split('/').pop() as string) ?? null,
    intervalMs: 300_000,
    now: () => clock.ms,
    sleep: async (ms) => {
      clock.ms += ms;
    },
    log: (level, msg, fields) => logs.push({ level, msg, fields: fields ?? null }),
    onDefaultBranchRuns: (observation) => alerts.push(observation),
  });
  return { tracker, github, refs, clock, logs, alerts };
}

function row(view: RepoOverviewView | null, key: string): RepoOverviewRowView {
  const found = view?.rows.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`row ${key} missing`);
  return found;
}

/** The server view must pass the mirrored web validator unchanged. */
function expectValidOnBoard(view: RepoOverviewView | null): void {
  const snapshot = {
    repos: [],
    agents: [],
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'gitlab-overview-test',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    repoOverview: view,
  };
  expect(isValidSnapshot(snapshot), JSON.stringify(view)).toBe(true);
}

interface FetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly redirect: string;
  readonly signal: AbortSignal;
}

/** A fetch double answering each request from `answer` and recording it. */
function fakeFetch(answer: (url: string) => Response | Promise<Response>): { fetchImpl: GitLabFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: GitLabFetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, redirect: init.redirect, signal: init.signal });
    return answer(url);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, init: { status?: number; total?: string | null } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.total !== undefined && init.total !== null) headers.set('x-total', init.total);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ------------------------------------------------------------------
// Classification, links and pure projections
// ------------------------------------------------------------------

describe('managed repo overview — GitLab classification', () => {
  it('links SSH (nested groups) and HTTPS GitLab origins and reads other hosts as unsupported', () => {
    const classify = (url: string) => classifyRemote('/ws/a', () => parseRepoRemote(url));
    const nested = classify('git@gitlab.example.com:group/sub/project.git');
    expect(nested).toEqual({
      kind: 'linked',
      ref: { host: 'gitlab.example.com', owner: 'group/sub', repo: 'project' },
      provider: 'gitlab',
    });
    if (nested.kind !== 'linked') throw new Error('expected linked');
    expect(gitlabRepoLink(nested.ref)).toBe('https://gitlab.example.com/group/sub/project');
    expect(repoFullName(nested.ref)).toBe('group/sub/project');
    const https = classify('https://gitlab.com/group/project.git');
    expect(https).toEqual({ kind: 'linked', ref: { host: 'gitlab.com', owner: 'group', repo: 'project' }, provider: 'gitlab' });
    if (https.kind !== 'linked') throw new Error('expected linked');
    expect(gitlabRepoLink(https.ref)).toBe('https://gitlab.com/group/project');
    // Hosts `isGitLabRemote` rejects never become GitLab rows: the token
    // could never be sent to them.
    for (const url of [
      'git@bitbucket.org:a/b.git',
      'git@evil.gitlab.attacker.test:a/b.git',
      'https://mygitlab.example.com/a/b.git',
    ]) {
      expect(classify(url), url).toEqual({ kind: 'unlinked', reason: 'unsupported code host' });
    }
    // A GitLab host whose identity cannot form a safe link stays unlinked.
    expect(classify('https://gitlab.example.com:8443/group/project.git')).toEqual({
      kind: 'unlinked',
      reason: 'unrecognized remote',
    });
    expect(gitlabRepoLink({ host: 'gitlab.com', owner: 'group/..', repo: 'project' })).toBeNull();
    expect(gitlabRepoLink({ host: 'gitlab.com', owner: 'group/a b', repo: 'project' })).toBeNull();
    expect(gitlabRepoLink({ host: 'gitlab.com', owner: 'group//sub', repo: 'project' })).toBeNull();
    expect(gitlabRepoLink({ host: 'gitlab..com', owner: 'group', repo: 'project' })).toBeNull();
    expect(gitlabRepoLink({ host: 'github.com', owner: 'group', repo: 'project' })).toBeNull();
  });

  it('maps every GitLab pipeline status to the fixed run states', () => {
    const cases: ReadonlyArray<readonly [string | null, string]> = [
      ['success', 'passed'],
      ['failed', 'failed'],
      ['canceled', 'cancelled'],
      ['canceling', 'cancelled'],
      ['skipped', 'skipped'],
      ['running', 'running'],
      ['created', 'queued'],
      ['waiting_for_resource', 'queued'],
      ['preparing', 'queued'],
      ['pending', 'queued'],
      ['scheduled', 'queued'],
      ['manual', 'action-required'],
      ['SUCCESS', 'passed'],
      ['vibes', 'unknown'],
      [null, 'unknown'],
    ];
    for (const [status, state] of cases) expect(gitLabPipelineStateOf(status), String(status)).toBe(state);
  });

  it('reads the project default branch, empty repositories and explicit CI-off flags', () => {
    const label = 'project group/p on gitlab.com';
    expect(gitLabProjectMetaOf(label, { default_branch: 'trunk' })).toEqual({ defaultBranch: 'trunk', ciEnabled: true });
    // GitLab reports the instance default for an empty repository.
    expect(gitLabProjectMetaOf(label, { default_branch: 'main', empty_repo: true })).toEqual({
      defaultBranch: null,
      ciEnabled: true,
    });
    expect(gitLabProjectMetaOf(label, { default_branch: null })).toEqual({ defaultBranch: null, ciEnabled: true });
    expect(gitLabProjectMetaOf(label, { default_branch: 'main', builds_access_level: 'disabled' }).ciEnabled).toBe(false);
    expect(gitLabProjectMetaOf(label, { default_branch: 'main', jobs_enabled: false }).ciEnabled).toBe(false);
    // Only the explicit flags read as off.
    expect(gitLabProjectMetaOf(label, { default_branch: 'main', builds_access_level: 'private' }).ciEnabled).toBe(true);
    expect(gitLabProjectMetaOf(label, { default_branch: 'main', jobs_enabled: 'no' }).ciEnabled).toBe(true);
    expect(() => gitLabProjectMetaOf(label, { default_branch: 7 })).toThrow(/default_branch must be a non-empty string/u);
    expect(() => gitLabProjectMetaOf(label, [])).toThrow(/not a JSON object/u);
    expect(classifyGhError(new RepoProviderError('rate-limit', 'project x on gitlab.com: HTTP 429'))).toBe('rate-limit');
    // The kind is authoritative: a project named like a provider condition
    // cannot change it.
    expect(classifyGhError(new RepoProviderError('other', 'rate limit HTTP 401 authentication'))).toBe('other');
  });
});

// ------------------------------------------------------------------
// REST adapter
// ------------------------------------------------------------------

describe('GitLab overview REST adapter', () => {
  it('reads project, exact counts and pipelines over https with PRIVATE-TOKEN, no redirects and a bounded timeout', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      const path = new URL(url).pathname + new URL(url).search;
      if (path === '/api/v4/projects/group%2Fsub%2Fproject') return json({ default_branch: 'main', empty_repo: false });
      if (path.startsWith('/api/v4/projects/group%2Fsub%2Fproject/merge_requests?')) return json([{ iid: 1 }], { total: '7' });
      if (path.startsWith('/api/v4/projects/group%2Fsub%2Fproject/issues?')) return json([], { total: '0' });
      if (path.startsWith('/api/v4/projects/group%2Fsub%2Fproject/pipelines?')) {
        return json([
          {
            id: 9001,
            iid: 41,
            status: 'running',
            source: 'push',
            ref: 'main',
            web_url: 'https://gitlab.example.com/group/sub/project/-/pipelines/9001',
            created_at: '2026-10-22T10:00:00.000Z',
            updated_at: '2026-10-22T10:01:00.000Z',
          },
        ]);
      }
      return json({ message: '404 Not Found' }, { status: 404 });
    });
    const api = new GitLabRepoOverviewApi({ fetchImpl, tokenResolver: () => TOKEN });
    const ref = gitlabRef('project');
    expect(await api.fetchProject({ repo: ref })).toEqual({ defaultBranch: 'main', ciEnabled: true });
    expect(await api.countOpenMergeRequests({ repo: ref })).toBe(7);
    expect(await api.countOpenIssues({ repo: ref })).toBe(0);
    expect(await api.latestPipelines({ repo: ref, branch: 'main', limit: 20 })).toEqual([
      {
        id: 9001,
        iid: 41,
        name: null,
        status: 'running',
        source: 'push',
        ref: 'main',
        url: 'https://gitlab.example.com/group/sub/project/-/pipelines/9001',
        createdAt: '2026-10-22T10:00:00.000Z',
        startedAt: null,
        updatedAt: '2026-10-22T10:01:00.000Z',
      },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      'https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject',
      'https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests?state=opened&scope=all&per_page=1',
      'https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/issues?state=opened&scope=all&per_page=1',
      'https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/pipelines?ref=main&order_by=id&sort=desc&per_page=20',
    ]);
    for (const call of calls) {
      expect(call.headers['PRIVATE-TOKEN']).toBe(TOKEN);
      expect(call.redirect).toBe('error');
      expect(call.signal).toBeInstanceOf(AbortSignal);
      // The token rides the header only, never the URL.
      expect(call.url).not.toContain(TOKEN);
    }
    expect(GITLAB_OVERVIEW_TIMEOUT_MS).toBe(15_000);
    // The per-request signal really bounds a stalled call.
    const stalled = new GitLabRepoOverviewApi({
      tokenResolver: () => TOKEN,
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason as Error));
        }),
    });
    const timedOut = await stalled.fetchProject({ repo: ref }).catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(RepoProviderError);
    expect((timedOut as RepoProviderError).kind).toBe('other');
    expect((timedOut as RepoProviderError).message).toContain('project group/sub/project on gitlab.example.com: request failed');
  });

  it('fails a count loud when X-Total is missing or invalid, or the body is not an array', async () => {
    const answers: Response[] = [
      json([{ iid: 1 }]),
      json([], { total: 'many' }),
      json([], { total: '-1' }),
      json([], { total: '1e3' }),
      json({ not: 'a list' }, { total: '3' }),
    ];
    const { fetchImpl } = fakeFetch(() => answers.shift() as Response);
    const api = new GitLabRepoOverviewApi({ fetchImpl, tokenResolver: () => TOKEN });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const error = await api.countOpenMergeRequests({ repo: gitlabRef('project') }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RepoProviderError);
      expect((error as RepoProviderError).message).toContain('count not exact');
      expect((error as RepoProviderError).kind).toBe('other');
    }
    await expect(api.countOpenIssues({ repo: gitlabRef('project') })).rejects.toThrow(/not a JSON array/u);
    // A malformed pipeline page never shrinks into "no pipeline".
    const pages: Response[] = [json({ pipelines: [] }), json([{ id: 1, ref: 'main' }, 'junk'])];
    const listing = new GitLabRepoOverviewApi({ fetchImpl: fakeFetch(() => pages.shift() as Response).fetchImpl, tokenResolver: () => TOKEN });
    await expect(listing.latestPipelines({ repo: gitlabRef('project'), branch: 'main', limit: 20 })).rejects.toThrow(/not a JSON array/u);
    await expect(listing.latestPipelines({ repo: gitlabRef('project'), branch: 'main', limit: 20 })).rejects.toThrow(
      /malformed pipeline entry/u,
    );
  });

  it('maps HTTP status to error kinds, names host and label, and never echoes the token', async () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [401, 'auth'],
      [403, 'permission'],
      [404, 'not-found'],
      [429, 'rate-limit'],
      [500, 'other'],
      [502, 'other'],
    ];
    for (const [status, kind] of cases) {
      const { fetchImpl } = fakeFetch(() =>
        json({ message: `${status} refused for token ${TOKEN} ${'x'.repeat(400)}` }, { status }),
      );
      const api = new GitLabRepoOverviewApi({ fetchImpl, tokenResolver: () => TOKEN });
      const error = (await api.fetchProject({ repo: gitlabRef('project') }).catch((caught: unknown) => caught)) as RepoProviderError;
      expect(error).toBeInstanceOf(RepoProviderError);
      expect(error.kind).toBe(kind);
      expect(error.message).toContain(`project group/sub/project on gitlab.example.com: HTTP ${status} (${status} refused`);
      expect(error.message).not.toContain(TOKEN);
      // GitLab's own message is bounded.
      expect(error.message.length).toBeLessThan(80 + 160);
    }
    const network = new GitLabRepoOverviewApi({
      tokenResolver: () => TOKEN,
      fetchImpl: async () => {
        throw new TypeError(`fetch failed: redirect refused (${TOKEN})`);
      },
    });
    const failed = (await network.countOpenIssues({ repo: gitlabRef('project') }).catch((caught: unknown) => caught)) as RepoProviderError;
    expect(failed.kind).toBe('other');
    expect(failed.message).toContain('open issues group/sub/project on gitlab.example.com: request failed');
    expect(failed.message).not.toContain(TOKEN);
    const garbled = new GitLabRepoOverviewApi({
      tokenResolver: () => TOKEN,
      fetchImpl: async () => new Response('<html>', { status: 200 }),
    });
    await expect(garbled.fetchProject({ repo: gitlabRef('project') })).rejects.toThrow(/not valid JSON/u);
  });

  it('sends nothing without a token, to a host isGitLabRemote rejects, or to a non-default port', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({}));
    for (const token of [undefined, '', '   ']) {
      const api = new GitLabRepoOverviewApi({ fetchImpl, tokenResolver: () => token });
      const error = (await api.fetchProject({ repo: gitlabRef('project') }).catch((caught: unknown) => caught)) as RepoProviderError;
      expect(error).toBeInstanceOf(RepoProviderError);
      expect(error.kind).toBe('auth');
      expect(error.message).toMatch(/^no GitLab token configured for gitlab\.example\.com — set GITLAB_TOKEN/u);
    }
    const api = new GitLabRepoOverviewApi({ fetchImpl, tokenResolver: () => TOKEN });
    for (const host of ['evil.example', 'evil.gitlab.attacker.test', 'gitlab.example.com:8443', 'gitlab.example.com@evil']) {
      await expect(api.fetchProject({ repo: gitlabRef('project', host) }), host).rejects.toBeInstanceOf(RepoProviderError);
    }
    expect(calls).toEqual([]);
  });

  it('resolves the token from GITLAB_TOKEN, falling back to GL_TOKEN', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ default_branch: 'main' }));
    vi.stubEnv('GITLAB_TOKEN', undefined);
    vi.stubEnv('GL_TOKEN', 'gl-fallback-token');
    await new GitLabRepoOverviewApi({ fetchImpl }).fetchProject({ repo: gitlabRef('project') });
    vi.stubEnv('GITLAB_TOKEN', 'gitlab-primary-token');
    await new GitLabRepoOverviewApi({ fetchImpl }).fetchProject({ repo: gitlabRef('project') });
    expect(calls.map((call) => call.headers['PRIVATE-TOKEN'])).toEqual(['gl-fallback-token', 'gitlab-primary-token']);
  });
});

// ------------------------------------------------------------------
// Tracker
// ------------------------------------------------------------------

describe('managed repo overview tracker — GitLab rows', () => {
  it('observes a GitLab row: provider, link, exact counts and the newest default-branch pipeline', async () => {
    const gitlab = new FakeGitLab().set('project', {
      openMrs: 7,
      openIssues: 0,
      pipelines: [
        pipeline({ id: 10, iid: 4, status: 'success', createdAt: '2026-10-22T09:00:00.000Z' }),
        // Same creation time: the higher id is newer.
        pipeline({ id: 12, iid: 6, status: 'failed', createdAt: '2026-10-22T10:00:00.000Z' }),
        pipeline({ id: 11, iid: 5, status: 'success', createdAt: '2026-10-22T10:00:00.000Z' }),
        // Newer, but none of these tested the branch itself.
        pipeline({ id: 20, iid: 9, status: 'running', source: 'merge_request_event', createdAt: '2026-10-22T11:00:00.000Z' }),
        pipeline({ id: 21, iid: 10, status: 'running', source: 'parent_pipeline', createdAt: '2026-10-22T11:00:00.000Z' }),
        pipeline({ id: 22, iid: 11, status: 'running', ref: 'feature', createdAt: '2026-10-22T11:00:00.000Z' }),
      ],
    });
    const h = harness({ refs: new Map([['project', gitlabRef('project')]]), gitlabApi: gitlab });
    const view = await h.tracker.refresh();
    const entry = row(view, 'project');
    expect(entry).toMatchObject({
      linked: true,
      provider: 'gitlab',
      host: 'gitlab.example.com',
      link: 'https://gitlab.example.com/group/sub/project',
      fullName: 'group/sub/project',
      openPrs: 7,
      openIssues: 0,
      freshness: 'fresh',
      error: null,
    });
    expect(entry.run).toEqual({
      state: 'failed',
      status: 'failed',
      conclusion: null,
      workflow: null,
      branch: 'main',
      runNumber: 6,
      url: 'https://gitlab.example.com/group/sub/project/-/pipelines/9001',
      runCreatedAt: '2026-10-22T10:00:00.000Z',
      runStartedAt: '2026-10-22T10:00:05.000Z',
      runUpdatedAt: '2026-10-22T10:05:00.000Z',
    });
    expect(gitlab.calls).toEqual([
      'fetchProject:gitlab.example.com/group/sub/project',
      'countOpenMergeRequests:gitlab.example.com/group/sub/project',
      'countOpenIssues:gitlab.example.com/group/sub/project',
      'latestPipelines:gitlab.example.com/group/sub/project',
    ]);
    expect(h.github.calls).toEqual([]);
    expectValidOnBoard(view);

    // An off-host pipeline URL is dropped, never rewritten; a pipeline
    // name is the CI label when the project sets one.
    gitlab.set('project', {
      pipelines: [pipeline({ name: 'release train', url: 'https://evil.example/group/sub/project/-/pipelines/1' })],
    });
    const next = row(await h.tracker.refresh(), 'project');
    expect(next.run?.url).toBeNull();
    expect(next.run?.workflow).toBe('release train');
  });

  it('reads never-run when no default-branch pipeline is on the page, never no-workflow', async () => {
    const gitlab = new FakeGitLab()
      .set('empty-page', { pipelines: [] })
      .set('mr-only', { pipelines: [pipeline({ source: 'merge_request_event' }), pipeline({ ref: 'develop' })] });
    const h = harness({
      refs: new Map([
        ['empty-page', gitlabRef('empty-page')],
        ['mr-only', gitlabRef('mr-only')],
      ]),
      gitlabApi: gitlab,
    });
    const view = await h.tracker.refresh();
    for (const key of ['empty-page', 'mr-only']) {
      expect(row(view, key).run).toMatchObject({ state: 'never-run', branch: 'main', status: null, url: null });
      expect(row(view, key).freshness).toBe('fresh');
      expect(repoRowNote(row(view, key))).toBe('No pipeline on main yet.');
    }
    expectValidOnBoard(view);
  });

  it('reads CI off as unavailable with fresh counts and no pipelines call', async () => {
    const gitlab = new FakeGitLab().set('project', {
      project: { defaultBranch: 'main', ciEnabled: false },
      openMrs: 2,
      openIssues: 5,
    });
    const h = harness({ refs: new Map([['project', gitlabRef('project')]]), gitlabApi: gitlab });
    const view = await h.tracker.refresh();
    const entry = row(view, 'project');
    expect(entry.run).toMatchObject({ state: 'unavailable', branch: 'main', status: null });
    expect(entry).toMatchObject({ openPrs: 2, openIssues: 5, freshness: 'fresh' });
    expect(gitlab.calls.some((call) => call.startsWith('latestPipelines'))).toBe(false);
    expect(repoRowNote(entry)).toBe('GitLab CI/CD is unavailable for this repository.');
    expectValidOnBoard(view);
  });

  it('reads an empty repository as no-branch and keeps its counts', async () => {
    const gitlab = new FakeGitLab().set('project', {
      project: { defaultBranch: null, ciEnabled: true },
      openMrs: 0,
      openIssues: 4,
    });
    const h = harness({ refs: new Map([['project', gitlabRef('project')]]), gitlabApi: gitlab });
    const view = await h.tracker.refresh();
    const entry = row(view, 'project');
    expect(entry.run).toMatchObject({ state: 'no-branch', branch: null });
    expect(entry).toMatchObject({ openPrs: 0, openIssues: 4, freshness: 'fresh' });
    expect(gitlab.calls.some((call) => call.startsWith('latestPipelines'))).toBe(false);
    expectValidOnBoard(view);
  });

  it('with no GitLab token, GitHub rows stay fresh with today\'s calls and the GitLab rows name the missing token', async () => {
    const { fetchImpl, calls: sent } = fakeFetch(() => json({}));
    const gitlabApi = new GitLabRepoOverviewApi({ fetchImpl, tokenResolver: () => undefined });
    const h = harness({
      refs: new Map<string, RepoRef>([
        ['alpha', githubRef('alpha')],
        ['gl-a', gitlabRef('gl-a')],
        ['gl-b', gitlabRef('gl-b')],
        ['gl-other', gitlabRef('gl-other', 'gitlab.other.test', 'team')],
        ['zeta', githubRef('zeta')],
      ]),
      gitlabApi,
    });
    const view = await h.tracker.refresh();
    expect(sent).toEqual([]);
    // GitHub: exactly today's calls, fresh rows, the #446 hook fed.
    expect(h.github.calls).toEqual([...githubCalls('alpha'), ...githubCalls('zeta')]);
    for (const key of ['alpha', 'zeta']) {
      expect(row(view, key)).toMatchObject({ provider: 'github', freshness: 'fresh', error: null, openPrs: 2 });
    }
    expect(h.alerts.map((alert) => alert.repo.repo)).toEqual(['alpha', 'zeta']);
    // The first GitLab row on the host names the missing token…
    expect(row(view, 'gl-a').freshness).toBe('unavailable');
    expect(row(view, 'gl-a').error).toMatch(/^no GitLab token configured for gitlab\.example\.com — set GITLAB_TOKEN/u);
    // …later rows on that host are disclosed aborted with no call, and a
    // different GitLab host is its own scope.
    expect(row(view, 'gl-b').freshness).toBe('unavailable');
    expect(row(view, 'gl-b').error).toContain('refresh aborted before this repository was checked: auth: no GitLab token');
    expect(row(view, 'gl-other').error).toMatch(/^no GitLab token configured for gitlab\.other\.test/u);
    // Unknown data stays unknown: no zero counts, no run.
    expect(row(view, 'gl-b')).toMatchObject({ openPrs: null, openIssues: null, run: null, checkedAt: null });
    expectValidOnBoard(view);
  });

  it('a GitLab 401 or 429 aborts only that host scope; other hosts and GitHub rows continue', async () => {
    const gitlab = new FakeGitLab()
      .set('gl-a', { errors: { countOpenMergeRequests: new RepoProviderError('rate-limit', 'open merge requests group/sub/gl-a on gitlab.example.com: HTTP 429') } })
      .set('gl-b', { openMrs: 1 })
      .set('gl-c', { errors: { fetchProject: new RepoProviderError('auth', 'project team/gl-c on gitlab.other.test: HTTP 401') } })
      .set('gl-d', { openMrs: 4 });
    const h = harness({
      refs: new Map<string, RepoRef>([
        ['alpha', githubRef('alpha')],
        ['gl-a', gitlabRef('gl-a')],
        ['gl-b', gitlabRef('gl-b')],
        ['gl-c', gitlabRef('gl-c', 'gitlab.other.test', 'team')],
        ['gl-d', gitlabRef('gl-d', 'gitlab.third.test', 'team')],
        ['zeta', githubRef('zeta')],
      ]),
      gitlabApi: gitlab,
    });
    const view = await h.tracker.refresh();
    expect(row(view, 'gl-a').error).toContain('HTTP 429');
    expect(row(view, 'gl-b').error).toContain('refresh aborted before this repository was checked: rate-limit:');
    expect(gitlab.calls.some((call) => call.includes('/group/sub/gl-b'))).toBe(false);
    expect(row(view, 'gl-c').error).toContain('HTTP 401');
    expect(row(view, 'gl-d')).toMatchObject({ freshness: 'fresh', openPrs: 4 });
    expect(h.github.calls).toEqual([...githubCalls('alpha'), ...githubCalls('zeta')]);
    expect(row(view, 'zeta').freshness).toBe('fresh');
    expect(h.logs.some((line) => line.msg.includes('refresh aborted (provider/rate-limit condition)'))).toBe(true);
    expectValidOnBoard(view);
  });

  it('a GitHub rate limit never aborts GitLab rows, and the next pass resumes at the first skipped repository', async () => {
    const github = new FakeGitHub();
    github.errors.set('fetchRepo:alpha', new GhRateLimitedError('alpha: GitHub rate limit', 'HTTP 403: API rate limit exceeded'));
    const gitlab = new FakeGitLab().set('gl-a', { openMrs: 3 });
    const h = harness({
      refs: new Map<string, RepoRef>([
        ['alpha', githubRef('alpha')],
        ['beta', githubRef('beta')],
        ['gl-a', gitlabRef('gl-a')],
      ]),
      github,
      gitlabApi: gitlab,
    });
    const view = await h.tracker.refresh();
    expect(github.calls).toEqual(['fetchRepo:acme/alpha']);
    expect(row(view, 'beta').error).toContain('refresh aborted before this repository was checked: rate-limit:');
    expect(row(view, 'gl-a')).toMatchObject({ freshness: 'fresh', openPrs: 3, error: null });
    github.errors.clear();
    github.calls.length = 0;
    const recovered = await h.tracker.refresh();
    // beta was the first repository the aborted scope skipped: it goes first.
    expect(github.calls[0]).toBe('fetchRepo:acme/beta');
    expect(row(recovered, 'alpha').freshness).toBe('fresh');
    expect(row(recovered, 'beta').freshness).toBe('fresh');
  });

  it('keeps cached GitLab data on a per-repository failure and renders it stale with the failure', async () => {
    const gitlab = new FakeGitLab().set('project', { openMrs: 7, openIssues: 1 }).set('other', { openMrs: 2 });
    const h = harness({
      refs: new Map([
        ['other', gitlabRef('other')],
        ['project', gitlabRef('project')],
      ]),
      gitlabApi: gitlab,
    });
    const first = row(await h.tracker.refresh(), 'project');
    expect(first.freshness).toBe('fresh');
    const failures: readonly unknown[] = [
      new RepoProviderError('permission', 'open issues group/sub/project on gitlab.example.com: HTTP 403 (403 Forbidden)'),
      new RepoProviderError('not-found', 'project group/sub/project on gitlab.example.com: HTTP 404 (404 Project Not Found)'),
      new RepoProviderError('other', 'pipelines group/sub/project@main on gitlab.example.com: HTTP 503'),
      new RepoProviderError('other', 'project group/sub/project on gitlab.example.com: request failed (fetch failed)'),
    ];
    const calls: GitLabCall[] = ['countOpenIssues', 'fetchProject', 'latestPipelines', 'fetchProject'];
    for (const [index, failure] of failures.entries()) {
      h.clock.ms += 60_000;
      gitlab.set('project', { openMrs: 99, errors: { [calls[index] as GitLabCall]: failure } });
      const view = await h.tracker.refresh();
      const stale = row(view, 'project');
      expect(stale.freshness).toBe('stale');
      expect(stale.checkedAt).toBe(first.checkedAt);
      // The atomic observation is kept whole: counts and run from the
      // last complete pass, never the partial new count.
      expect(stale.openPrs).toBe(7);
      expect(stale.run).toEqual(first.run);
      expect(stale.error).toBe((failure as Error).message);
      expect(repoRowBadge(stale).text).toBe('STALE · last passed');
      expect(repoRowNote(stale)).toBe(`Cached result — not current health; the fresh fetch failed: ${(failure as Error).message}`);
      // A per-repository failure never aborts the scope.
      expect(row(view, 'other').freshness).toBe('fresh');
      expect(row(view, 'other').lastAttemptAt).toBe(new Date(h.clock.ms).toISOString());
      expectValidOnBoard(view);
    }
  });

  it('never feeds GitLab pipelines to the default-branch CI alert', async () => {
    const gitlab = new FakeGitLab().set('project', { pipelines: [pipeline({ status: 'failed' })] });
    const h = harness({
      refs: new Map<string, RepoRef>([
        ['alpha', githubRef('alpha')],
        ['project', gitlabRef('project')],
      ]),
      gitlabApi: gitlab,
    });
    const view = await h.tracker.refresh();
    expect(row(view, 'project').run?.state).toBe('failed');
    expect(h.alerts.map((alert) => `${alert.repo.host}/${repoFullName(alert.repo)}`)).toEqual(['github.com/acme/alpha']);
  });

  it('fails a GitLab row by name when no GitLab adapter is wired, leaving other rows observed', async () => {
    const h = harness({
      refs: new Map<string, RepoRef>([
        ['alpha', githubRef('alpha')],
        ['gl-a', gitlabRef('gl-a')],
        ['gl-b', gitlabRef('gl-b')],
      ]),
      gitlabApi: null,
    });
    const view = await h.tracker.refresh();
    for (const key of ['gl-a', 'gl-b']) {
      expect(row(view, key).freshness).toBe('unavailable');
      expect(row(view, key).error).toBe(
        `GitLab overview adapter is not wired — group/sub/${key} on gitlab.example.com cannot be observed`,
      );
    }
    expect(row(view, 'alpha').freshness).toBe('fresh');
    expectValidOnBoard(view);
  });

  it('drops the cached observation when a row changes provider', async () => {
    const gitlab = new FakeGitLab();
    const h = harness({ refs: new Map<string, RepoRef>([['moving', githubRef('moving')]]), gitlabApi: gitlab });
    expect(row(await h.tracker.refresh(), 'moving')).toMatchObject({ provider: 'github', openPrs: 2 });
    h.refs.set('moving', gitlabRef('moving'));
    gitlab.set('moving', { errors: { fetchProject: new RepoProviderError('other', 'project group/sub/moving on gitlab.example.com: HTTP 500') } });
    const moved = row(await h.tracker.refresh(), 'moving');
    // The GitHub counts and run never attach to the GitLab identity.
    expect(moved).toMatchObject({ provider: 'gitlab', freshness: 'unavailable', openPrs: null, run: null, checkedAt: null });
  });

  it('words every GitLab row without GitHub, Actions or PRs on the board', async () => {
    const gitlab = new FakeGitLab()
      .set('passed', {})
      .set('running', { pipelines: [pipeline({ status: 'running' })] })
      .set('manual', { pipelines: [pipeline({ status: 'manual', url: null })] })
      .set('never', { pipelines: [] })
      .set('off', { project: { defaultBranch: 'main', ciEnabled: false } })
      .set('empty', { project: { defaultBranch: null, ciEnabled: true } })
      .set('broken', { errors: { fetchProject: new RepoProviderError('other', 'project group/sub/broken on gitlab.example.com: HTTP 500') } });
    const names = ['passed', 'running', 'manual', 'never', 'off', 'empty', 'broken'];
    const h = harness({ refs: new Map(names.map((name) => [name, gitlabRef(name)] as const)), gitlabApi: gitlab });
    await h.tracker.refresh();
    h.clock.ms += 60_000;
    gitlab.set('passed', { errors: { countOpenIssues: new RepoProviderError('permission', 'open issues group/sub/passed on gitlab.example.com: HTTP 403') } });
    const view = await h.tracker.refresh();
    expectValidOnBoard(view);
    expect(row(view, 'passed').freshness).toBe('stale');
    expect(repoCiView(row(view, 'running')).label).toBe('pipeline #41');
    for (const name of names) {
      const entry = row(view, name);
      const badge = repoRowBadge(entry);
      const words = [
        badge.text,
        repoRowNote(entry) ?? '',
        repoRowAriaLabel(entry, badge),
        repoCiView(entry).label,
        repoRunContextTitle(entry) ?? '',
        entry.error ?? '',
      ].join('\n');
      expect(words, name).not.toMatch(/GitHub|Actions|PRs|pull request/u);
    }
  });

  it('links a real nested GitLab SSH origin through the default resolver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-gitlab-'));
    try {
      execFileSync('git', ['init', '-q', join(root, 'project')]);
      execFileSync('git', ['-C', join(root, 'project'), 'remote', 'add', 'origin', 'git@gitlab.example.com:group/sub/project.git']);
      execFileSync('git', ['init', '-q', join(root, 'elsewhere')]);
      execFileSync('git', ['-C', join(root, 'elsewhere'), 'remote', 'add', 'origin', 'git@bitbucket.org:a/b.git']);
      const gitlab = new FakeGitLab().set('project', { openMrs: 7 });
      const github = new FakeGitHub();
      const tracker = new ManagedRepoOverviewTracker({
        workspaceRoot: root,
        managedRepos: ['elsewhere', 'project'],
        api: github,
        gitlabApi: gitlab,
        now: () => T0,
        sleep: async () => {},
      });
      const view = await tracker.refresh();
      expect(row(view, 'project')).toMatchObject({
        linked: true,
        provider: 'gitlab',
        link: 'https://gitlab.example.com/group/sub/project',
        fullName: 'group/sub/project',
        openPrs: 7,
        freshness: 'fresh',
      });
      expect(row(view, 'elsewhere')).toMatchObject({ linked: false, provider: null, linkReason: 'unsupported code host' });
      expect(repoRowNote(row(view, 'elsewhere'))).toBe('Not linked (unsupported code host) — no repository data is fetched.');
      expect(github.calls).toEqual([]);
      expectValidOnBoard(view);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
