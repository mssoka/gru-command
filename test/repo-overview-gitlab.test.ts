import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidSnapshot } from '../web/src/lib/board-protocol.js';
import {
  repoCiView,
  repoRowAriaLabel,
  repoRowBadge,
  repoRowNote,
  repoRunContextTitle,
} from '../web/src/lib/repo-overview.js';
import {
  GhRateLimitedError,
  repoFullName,
  type GhCommandResult,
  type GhCommandRunner,
  type RepoRef,
} from '../src/dispatch/github-poll.js';
import { parseRepoRemote } from '../src/dispatch/review-path.js';
import { GITLAB_OVERVIEW_TIMEOUT_MS, GitLabRepoOverviewApi } from '../src/repos/gitlab-overview.js';
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
const ESC = String.fromCharCode(0x1b);

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
    // The list-pipelines entity carries no start time.
    startedAt: null,
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

/** Deterministic GitLab port: every call is recorded as `call:host/path`
 * (pass one array to both fakes to read the cross-provider order). */
class FakeGitLab implements GitLabRepoOverviewApiPort {
  readonly facts = new Map<string, GitLabFacts>();

  constructor(readonly calls: string[] = []) {}

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
  readonly errors = new Map<string, unknown>();

  constructor(readonly calls: string[] = []) {}

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
  maxCallsPerRefresh?: number;
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
    ...(options.maxCallsPerRefresh !== undefined ? { maxCallsPerRefresh: options.maxCallsPerRefresh } : {}),
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

/** A glab runner double: records each argv and answers it. */
function fakeGlab(answer: (args: readonly string[]) => GhCommandResult): { run: GhCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      return answer(args);
    },
  };
}

const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  304: 'Not Modified',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

/** A simplified `glab api --include` output: a status line, `Name: value`
 * headers, a blank line, then the body, all with one line terminator.
 * Real glab 1.89 mixes them (LF after the status line, CRLF after each
 * header) over HTTP/1.1; the verbatim-captures test pins that shape. On an
 * HTTP error glab exits 1 with the same stdout and `glab: … (HTTP n)` on
 * stderr. */
function included(
  body: unknown,
  init: { status?: number; total?: string; headers?: readonly string[]; eol?: string } = {},
): GhCommandResult {
  const status = init.status ?? 200;
  const headers = [
    'Content-Type: application/json',
    ...(init.headers ?? []),
    ...(init.total !== undefined ? [`X-Total: ${init.total}`] : []),
  ];
  return {
    status: status >= 400 ? 1 : 0,
    stdout: [`HTTP/2.0 ${status} ${REASONS[status] ?? ''}`, ...headers, '', typeof body === 'string' ? body : JSON.stringify(body)].join(
      init.eol ?? '\n',
    ),
    stderr: status >= 400 ? `glab: ${REASONS[status] ?? 'error'} (HTTP ${status})` : '',
  };
}

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
    // Hosts `isGitLabRemote` rejects never become GitLab rows: glab is
    // never run for them.
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
// glab transport
// ------------------------------------------------------------------

describe('GitLab overview glab transport', () => {
  const label = 'project group/sub/project on gitlab.example.com';
  const login = '`glab auth login --hostname gitlab.example.com`';
  const failureOf = async (api: GitLabRepoOverviewApi): Promise<RepoProviderError> =>
    (await api.fetchProject({ repo: gitlabRef('project') }).catch((caught: unknown) => caught)) as RepoProviderError;

  it('runs glab api --include for each read and parses the status line, headers and body', async () => {
    const { run, calls } = fakeGlab((args) => {
      const path = args[4] ?? '';
      if (path === 'projects/group%2Fsub%2Fproject') return included({ default_branch: 'main', empty_repo: false });
      if (path.startsWith('projects/group%2Fsub%2Fproject/merge_requests?')) return included([{ iid: 1 }], { total: '7' });
      // CRLF line ends and any header case parse the same.
      if (path.startsWith('projects/group%2Fsub%2Fproject/issues?')) return included([], { headers: ['x-total: 0'], eol: '\r\n' });
      if (path.startsWith('projects/group%2Fsub%2Fproject/pipelines?')) {
        return included([
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
      return included({ message: '404 Not Found' }, { status: 404 });
    });
    const api = new GitLabRepoOverviewApi(run);
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
    const call = (path: string): string[] => ['api', '--hostname', 'gitlab.example.com', '--include', path];
    expect(calls).toEqual([
      call('projects/group%2Fsub%2Fproject'),
      call('projects/group%2Fsub%2Fproject/merge_requests?state=opened&scope=all&per_page=1'),
      call('projects/group%2Fsub%2Fproject/issues?state=opened&scope=all&per_page=1'),
      call('projects/group%2Fsub%2Fproject/pipelines?ref=main&order_by=id&sort=desc&per_page=20'),
    ]);
    expect(GITLAB_OVERVIEW_TIMEOUT_MS).toBe(15_000);
  });

  it('fails a count loud when X-Total is missing or invalid, and a malformed body as other', async () => {
    const answers: GhCommandResult[] = [
      included([{ iid: 1 }]),
      included([], { total: 'many' }),
      included([], { total: '-1' }),
      included([], { total: '1e3' }),
      included({ not: 'a list' }, { total: '3' }),
      included({ pipelines: [] }),
      included([{ id: 1, ref: 'main' }, 'junk']),
      included('<html>'),
    ];
    const api = new GitLabRepoOverviewApi(fakeGlab(() => answers.shift() as GhCommandResult).run);
    const ref = gitlabRef('project');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const error = await api.countOpenMergeRequests({ repo: ref }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RepoProviderError);
      expect((error as RepoProviderError).kind).toBe('other');
      expect((error as RepoProviderError).message).toBe(
        'open merge requests group/sub/project on gitlab.example.com: response carries no valid X-Total header (count not exact)',
      );
    }
    await expect(api.countOpenIssues({ repo: ref })).rejects.toThrow(/not a JSON array/u);
    // A malformed pipeline page never shrinks into "no pipeline".
    await expect(api.latestPipelines({ repo: ref, branch: 'main', limit: 20 })).rejects.toThrow(/not a JSON array/u);
    await expect(api.latestPipelines({ repo: ref, branch: 'main', limit: 20 })).rejects.toThrow(/malformed pipeline entry/u);
    const garbled = await failureOf(api);
    expect(garbled.kind).toBe('other');
    expect(garbled.message).toBe(`${label}: response is not valid JSON`);
  });

  it('maps the HTTP status line to error kinds and names host and label', async () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [403, 'permission'],
      [404, 'not-found'],
      [429, 'rate-limit'],
      [500, 'other'],
      [502, 'other'],
    ];
    for (const [status, kind] of cases) {
      const answer = included({ message: `${status} refused ${'x'.repeat(400)}` }, { status });
      const error = await failureOf(new GitLabRepoOverviewApi(fakeGlab(() => answer).run));
      expect(error.kind, String(status)).toBe(kind);
      // GitLab's own message is appended, bounded.
      expect(error.message).toBe(`${label}: HTTP ${status} (${`${status} refused ${'x'.repeat(400)}`.slice(0, 160)})`);
    }
    // A non-2xx status below 400 is no success either.
    const notModified = await failureOf(new GitLabRepoOverviewApi(fakeGlab(() => included('', { status: 304 })).run));
    expect(notModified.kind).toBe('other');
    expect(notModified.message).toBe(`${label}: HTTP 304`);
  });

  it('reads OAuth-style error bodies and aborts the host on a 403 insufficient_scope', async () => {
    const remedy = `glab's login for gitlab.example.com lacks the read_api or api scope — run ${login} with a read_api or api token`;
    const insufficient = {
      error: 'insufficient_scope',
      error_description: 'The request requires higher privileges than provided by the access token.',
      scope: 'api read_api',
    };
    const cases: ReadonlyArray<readonly [GhCommandResult, string, string]> = [
      // A missing scope leads with what to do, never GitLab's generic text.
      [included(insufficient, { status: 403 }), 'auth', `${remedy}; GitLab accepts api read_api (${label}: HTTP 403)`],
      [
        included({ error: 'insufficient_scope', error_description: insufficient.error_description }, { status: 403 }),
        'auth',
        `${remedy} (${label}: HTTP 403)`,
      ],
      // A `scope` that is not a short list of scope names is never echoed.
      [included({ ...insufficient, scope: 'api <script>' }, { status: 403 }), 'auth', `${remedy} (${label}: HTTP 403)`],
      [included({ ...insufficient, scope: 'api, read_api' }, { status: 403 }), 'auth', `${remedy} (${label}: HTTP 403)`],
      [
        included({ ...insufficient, scope: 'api read_api read_repository write_repository' }, { status: 403 }),
        'auth',
        `${remedy} (${label}: HTTP 403)`,
      ],
      [included({ error: 'forbidden' }, { status: 403 }), 'permission', `${label}: HTTP 403 (forbidden)`],
      [included({ message: '403 Forbidden', error: 'ignored' }, { status: 403 }), 'permission', `${label}: HTTP 403 (403 Forbidden)`],
    ];
    for (const [answer, kind, message] of cases) {
      const error = await failureOf(new GitLabRepoOverviewApi(fakeGlab(() => answer).run));
      expect(error.kind, message).toBe(kind);
      expect(error.message).toBe(message);
    }
    // A login without read_api fails every project alike: the first row
    // aborts the host, and the rest spend no glab run. The remedy survives
    // the row bound on the aborted row even behind a long nested path.
    const owner = 'platform-engineering/continuous-delivery-tooling/internal-services';
    const { run, calls } = fakeGlab(() => included(insufficient, { status: 403 }));
    const h = harness({
      refs: new Map([
        ['gl-a', gitlabRef('gl-a-release-orchestration-service', 'gitlab.example.com', owner)],
        ['gl-b', gitlabRef('gl-b-release-orchestration-service', 'gitlab.example.com', owner)],
      ]),
      gitlabApi: new GitLabRepoOverviewApi(run),
    });
    const view = await h.tracker.refresh();
    expect(calls).toHaveLength(1);
    expect(row(view, 'gl-a').error?.startsWith(`${remedy}; GitLab accepts api read_api (project ${owner}/`)).toBe(true);
    const aborted = row(view, 'gl-b').error ?? '';
    expect(aborted).toHaveLength(300);
    expect(aborted.startsWith(`refresh aborted before this repository was checked: auth: ${remedy}; GitLab accepts api read_api`)).toBe(true);
  });

  it('parses verbatim glab 1.89.0 --include captures (LF status line, CRLF headers, HTTP/1.1)', async () => {
    const head = (status: string): string =>
      `HTTP/1.1 ${status}\nConnection: keep-alive\r\nContent-Type: application/json\r\n` +
      'Date: Thu, 22 Oct 2026 16:26:09 GMT\r\nKeep-Alive: timeout=5\r\n';
    const captures: GhCommandResult[] = [
      {
        status: 0,
        stdout: `${head('200 OK')}\r\n{"default_branch":"main","path":"/api/v4/projects/a%2Fb","auth":"pt"}`,
        stderr: '',
      },
      { status: 0, stdout: `${head('200 OK')}X-Total: 7\r\nX-Total-Pages: 7\r\n\r\n[{"iid":1}]`, stderr: '' },
      {
        status: 1,
        stdout: `${head('404 Not Found')}\r\n{"message":"404 Project Not Found"}`,
        stderr: 'glab: 404 Project Not Found (HTTP 404)\n',
      },
      {
        status: 1,
        stdout: `${head('403 Forbidden')}\r\n{"error":"insufficient_scope","error_description":"x","scope":"api read_api"}`,
        stderr: 'glab: HTTP 403\n',
      },
      {
        status: 1,
        stdout: '',
        stderr: `          \n   ERROR  \n          \n  Unauthenticated.${' '.repeat(100)}\n\n`,
      },
    ];
    const api = new GitLabRepoOverviewApi(fakeGlab(() => captures.shift() as GhCommandResult).run);
    const ref = gitlabRef('project');
    expect(await api.fetchProject({ repo: ref })).toEqual({ defaultBranch: 'main', ciEnabled: true });
    expect(await api.countOpenMergeRequests({ repo: ref })).toBe(7);
    const missing = await failureOf(api);
    expect(missing.kind).toBe('not-found');
    expect(missing.message).toBe(`${label}: HTTP 404 (404 Project Not Found)`);
    const scope = await failureOf(api);
    expect(scope.kind).toBe('auth');
    expect(scope.message).toBe(
      `glab's login for gitlab.example.com lacks the read_api or api scope — run ${login} with a read_api or api ` +
        `token; GitLab accepts api read_api (${label}: HTTP 403)`,
    );
    const anonymous = await failureOf(api);
    expect(anonymous.kind).toBe('auth');
    expect(anonymous.message).toBe(`glab is not logged in to gitlab.example.com — run ${login}`);
  });

  it('reads a rejected glab login (HTTP 401) remedy-first and aborts the host', async () => {
    const remedy =
      `glab's login for gitlab.example.com was rejected — run ${login} (a GITLAB_TOKEN in the service ` +
      "environment overrides glab's login)";
    const rejected = included({ error: 'invalid_token', error_description: 'Token was revoked.' }, { status: 401 });
    const error = await failureOf(new GitLabRepoOverviewApi(fakeGlab(() => rejected).run));
    expect(error.kind).toBe('auth');
    // GitLab's own reason follows the status.
    expect(error.message).toBe(`${remedy} (${label}: HTTP 401 — Token was revoked.)`);
    const bare = await failureOf(new GitLabRepoOverviewApi(fakeGlab(() => included({}, { status: 401 })).run));
    expect(bare.message).toBe(`${remedy} (${label}: HTTP 401)`);
    // The remedy survives the row bound on an aborted row behind a long path.
    const owner = 'platform-engineering/continuous-delivery-tooling/internal-services';
    const { run, calls } = fakeGlab(() => rejected);
    const h = harness({
      refs: new Map([
        ['gl-a', gitlabRef('gl-a-release-orchestration-service', 'gitlab.example.com', owner)],
        ['gl-b', gitlabRef('gl-b-release-orchestration-service', 'gitlab.example.com', owner)],
      ]),
      gitlabApi: new GitLabRepoOverviewApi(run),
    });
    const view = await h.tracker.refresh();
    expect(calls).toHaveLength(1);
    // The row that got the 401 leads with the remedy too.
    expect(row(view, 'gl-a')).toMatchObject({ freshness: 'unavailable' });
    expect(row(view, 'gl-a').error?.startsWith(`${remedy} (project ${owner}/gl-a-release-orchestration-service`)).toBe(true);
    const aborted = row(view, 'gl-b').error ?? '';
    expect(aborted).toHaveLength(300);
    expect(aborted.startsWith(`refresh aborted before this repository was checked: auth: ${remedy}`)).toBe(true);
  });

  it('never runs glab for a host isGitLabRemote rejects or one that is not a plain hostname', async () => {
    const { run, calls } = fakeGlab(() => included({}));
    const api = new GitLabRepoOverviewApi(run);
    for (const host of ['evil.example', 'evil.gitlab.attacker.test', 'gitlab.example.com:8443', 'gitlab.example.com@evil']) {
      const error = (await api.fetchProject({ repo: gitlabRef('project', host) }).catch((caught: unknown) => caught)) as RepoProviderError;
      expect(error, host).toBeInstanceOf(RepoProviderError);
      expect(error.message).toContain('not a GitLab host — glab is never run for it');
    }
    expect(calls).toEqual([]);
  });

  it('reads a host glab holds no login for as auth, naming glab auth login', async () => {
    const stderrs = [
      // glab 1.89's verdict block, coloured, its line padded.
      `          \n   ${ESC}[41m ERROR ${ESC}[0m  \n          \n  Unauthenticated.${' '.repeat(100)}\r\n\n`,
      'You are not logged into any GitLab hosts. Run glab auth login to authenticate.',
      'glab: no token found for gitlab.example.com',
      // The verdict line after a preamble longer than the display bound.
      `${'warning: a newer glab release is available. '.repeat(8)}\n  ERROR\n  Unauthenticated.\n`,
    ];
    for (const stderr of stderrs) {
      const error = await failureOf(new GitLabRepoOverviewApi(fakeGlab(() => ({ status: 1, stdout: '', stderr })).run));
      expect(error.kind, stderr).toBe('auth');
      expect(error.message).toBe(`glab is not logged in to gitlab.example.com — run ${login}`);
    }
    // glab finds logins by exact hostname: a remote's host case never
    // reaches it, and the fix names the lowercased host.
    const { run, calls } = fakeGlab(() => ({ status: 1, stdout: '', stderr: 'Unauthenticated.' }));
    const mixed = (await new GitLabRepoOverviewApi(run)
      .fetchProject({ repo: gitlabRef('project', 'GitLab.Example.com') })
      .catch((caught: unknown) => caught)) as RepoProviderError;
    expect(calls[0]?.slice(0, 3)).toEqual(['api', '--hostname', 'gitlab.example.com']);
    expect(mixed.message).toBe(`glab is not logged in to gitlab.example.com — run ${login}`);
  });

  it('reads a missing glab as auth with the install fix, and a run past its bound as other', async () => {
    const missing = await failureOf(
      new GitLabRepoOverviewApi(fakeGlab(() => ({ status: -1, stdout: '', stderr: '', error: 'Error: spawn glab ENOENT' })).run),
    );
    expect(missing.kind).toBe('auth');
    const unavailable = (detail: string): string =>
      `glab is unavailable (${detail}) — install the GitLab CLI (or make it executable) and run ${login}`;
    expect(missing.message).toBe(unavailable('Error: spawn glab ENOENT'));
    const denied = await failureOf(
      new GitLabRepoOverviewApi(fakeGlab(() => ({ status: -1, stdout: '', stderr: '', error: 'Error: spawn glab EACCES' })).run),
    );
    expect(denied.kind).toBe('auth');
    expect(denied.message).toBe(unavailable('Error: spawn glab EACCES'));
    // Node throws some spawn errnos synchronously, so the run rejects
    // instead of resolving with `error`: classified the same way.
    const rejecting = (error: Error): GitLabRepoOverviewApi =>
      new GitLabRepoOverviewApi(async () => {
        throw error;
      });
    const gone = await failureOf(rejecting(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })));
    expect(gone.kind).toBe('auth');
    expect(gone.message).toBe(unavailable('Error: spawn glab ENOENT'));
    const starved = await failureOf(rejecting(Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' })));
    expect(starved.kind).toBe('other');
    expect(starved.message).toBe(`${label}: Error: spawn ENOMEM`);
    for (const [error, message] of [
      ['gh api timed out after 15000 ms', 'glab api timed out after 15000 ms'],
      ['gh api output exceeds 16777216 bytes', 'glab api output exceeds 16777216 bytes'],
      // A transient spawn failure is one failed read, never "install glab".
      ['Error: spawn glab EAGAIN', 'Error: spawn glab EAGAIN'],
    ] as const) {
      const failed = await failureOf(new GitLabRepoOverviewApi(fakeGlab(() => ({ status: -1, stdout: '', stderr: '', error })).run));
      expect(failed.kind, error).toBe('other');
      expect(failed.message).toBe(`${label}: ${message}`);
    }
  });

  it('reads any other failing glab run as other, with its stderr flattened, ANSI-stripped and bounded', async () => {
    const answers: GhCommandResult[] = [
      { status: 2, stdout: '', stderr: `${ESC}[33mglab:${ESC}[0m something\n\n   broke ${'z'.repeat(400)}` },
      { status: 1, stdout: '', stderr: '' },
      // Exit 0 without a status line is no response either.
      { status: 0, stdout: '{"id":1}', stderr: '' },
      // A failing run is never a success, whatever status line it printed.
      { ...included({ default_branch: 'main' }), status: 1, stderr: 'glab: write /dev/stdout: broken pipe\n' },
      // A project path that merely contains "unauthenticated" is no login
      // verdict: a DNS failure reads as other, never as "log in".
      {
        status: 1,
        stdout: '',
        stderr:
          'glab: Get "https://gitlab.example.com/api/v4/projects/group%2Funauthenticated-api%2Fproject": ' +
          'dial tcp: lookup gitlab.example.com: no such host\n',
      },
    ];
    const api = new GitLabRepoOverviewApi(fakeGlab(() => answers.shift() as GhCommandResult).run);
    const noisy = await failureOf(api);
    expect(noisy.kind).toBe('other');
    expect(noisy.message).toBe(`${label}: glab exited 2: ${`glab: something broke ${'z'.repeat(400)}`.slice(0, 160)}`);
    expect((await failureOf(api)).message).toBe(`${label}: glab exited 1`);
    const silent = await failureOf(api);
    expect(silent.kind).toBe('other');
    expect(silent.message).toBe(`${label}: glab api printed no HTTP status line`);
    const contradicted = await failureOf(api);
    expect(contradicted.kind).toBe('other');
    expect(contradicted.message).toBe(`${label}: glab exited 1: glab: write /dev/stdout: broken pipe`);
    const dns = await failureOf(api);
    expect(dns.kind).toBe('other');
    expect(dns.message).toBe(
      `${label}: glab exited 1: glab: Get "https://gitlab.example.com/api/v4/projects/group%2Funauthenticated-api%2Fproject": ` +
        'dial tcp: lookup gitlab.example.com: no such host',
    );
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
      runStartedAt: null,
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

  it('with glab not logged in, GitHub rows stay fresh with today\'s calls and the GitLab rows name glab auth login', async () => {
    const { run, calls } = fakeGlab(() => ({ status: 1, stdout: '', stderr: ' ERROR \n  Unauthenticated.  \n' }));
    const h = harness({
      refs: new Map<string, RepoRef>([
        ['alpha', githubRef('alpha')],
        ['gl-a', gitlabRef('gl-a')],
        ['gl-b', gitlabRef('gl-b')],
        ['gl-other', gitlabRef('gl-other', 'gitlab.other.test', 'team')],
        ['zeta', githubRef('zeta')],
      ]),
      gitlabApi: new GitLabRepoOverviewApi(run),
    });
    const view = await h.tracker.refresh();
    // One glab run per host: the first row's verdict aborts that host.
    expect(calls.map((args) => args[2])).toEqual(['gitlab.example.com', 'gitlab.other.test']);
    // GitHub: exactly today's calls, fresh rows, the #446 hook fed.
    expect(h.github.calls).toEqual([...githubCalls('alpha'), ...githubCalls('zeta')]);
    for (const key of ['alpha', 'zeta']) {
      expect(row(view, key)).toMatchObject({ provider: 'github', freshness: 'fresh', error: null, openPrs: 2 });
    }
    expect(h.alerts.map((alert) => alert.repo.repo)).toEqual(['alpha', 'zeta']);
    // The first GitLab row on the host names the fix…
    expect(row(view, 'gl-a').freshness).toBe('unavailable');
    expect(row(view, 'gl-a').error).toBe(
      'glab is not logged in to gitlab.example.com — run `glab auth login --hostname gitlab.example.com`',
    );
    // …later rows on that host are disclosed aborted with no run, and a
    // different GitLab host is its own scope.
    expect(row(view, 'gl-b').freshness).toBe('unavailable');
    expect(row(view, 'gl-b').error).toBe(
      'refresh aborted before this repository was checked: auth: glab is not logged in to gitlab.example.com — run ' +
        '`glab auth login --hostname gitlab.example.com`',
    );
    expect(row(view, 'gl-other').error).toBe(
      'glab is not logged in to gitlab.other.test — run `glab auth login --hostname gitlab.other.test`',
    );
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
    const abort = h.logs.find((line) => line.msg.includes('refresh aborted (provider/rate-limit condition)'));
    expect(abort?.fields).toEqual({
      scopes: ['gitlab:gitlab.example.com', 'gitlab:gitlab.other.test'],
      details: {
        'gitlab:gitlab.example.com': 'rate-limit: open merge requests group/sub/gl-a on gitlab.example.com: HTTP 429',
        'gitlab:gitlab.other.test': 'auth: project team/gl-c on gitlab.other.test: HTTP 401',
      },
    });
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

  it('spends GitLab calls from the per-pass budget and discards a cut-off observation', async () => {
    const gitlab = new FakeGitLab().set('gl-a', { openMrs: 1 }).set('gl-b', { openMrs: 2, openIssues: 3 });
    const h = harness({
      refs: new Map([
        ['gl-a', gitlabRef('gl-a')],
        ['gl-b', gitlabRef('gl-b')],
      ]),
      gitlabApi: gitlab,
      maxCallsPerRefresh: 6,
    });
    const first = await h.tracker.refresh();
    expect(row(first, 'gl-a')).toMatchObject({ freshness: 'fresh', openPrs: 1 });
    // gl-b's project and MR count fit (calls 5 and 6); its issue count does
    // not, so nothing partial is committed and nothing is recorded as failed.
    expect(gitlab.calls.filter((call) => call.endsWith('/gl-b'))).toEqual([
      'fetchProject:gitlab.example.com/group/sub/gl-b',
      'countOpenMergeRequests:gitlab.example.com/group/sub/gl-b',
    ]);
    expect(row(first, 'gl-b')).toMatchObject({
      freshness: 'unchecked',
      openPrs: null,
      openIssues: null,
      run: null,
      error: null,
      lastAttemptAt: null,
    });
    const budget = h.logs.find((line) => line.msg.includes('call budget exhausted'));
    expect(budget?.fields).toMatchObject({ budget: 6, calls: 6 });
    gitlab.calls.length = 0;
    const second = await h.tracker.refresh();
    // The discarded repository goes first on the next pass.
    expect(gitlab.calls[0]).toBe('fetchProject:gitlab.example.com/group/sub/gl-b');
    expect(row(second, 'gl-b')).toMatchObject({ freshness: 'fresh', openPrs: 2, openIssues: 3 });
  });

  it('discloses an aborted scope past a budget stop and resumes at the discarded repository', async () => {
    const order: string[] = [];
    const github = new FakeGitHub(order);
    github.errors.set('fetchRepo:alpha', new GhRateLimitedError('alpha: GitHub rate limit', 'HTTP 403: API rate limit exceeded'));
    const gitlab = new FakeGitLab(order);
    const h = harness({
      refs: new Map<string, RepoRef>([
        ['alpha', githubRef('alpha')],
        ['gl-a', gitlabRef('gl-a')],
        ['gl-b', gitlabRef('gl-b')],
        ['gl-c', gitlabRef('gl-c')],
        ['zeta', githubRef('zeta')],
      ]),
      github,
      gitlabApi: gitlab,
      maxCallsPerRefresh: 7,
    });
    const view = await h.tracker.refresh();
    // alpha (1 call) aborts GitHub; gl-a spends 4; gl-b is cut at its third.
    expect(order).toEqual([
      'fetchRepo:acme/alpha',
      'fetchProject:gitlab.example.com/group/sub/gl-a',
      'countOpenMergeRequests:gitlab.example.com/group/sub/gl-a',
      'countOpenIssues:gitlab.example.com/group/sub/gl-a',
      'latestPipelines:gitlab.example.com/group/sub/gl-a',
      'fetchProject:gitlab.example.com/group/sub/gl-b',
      'countOpenMergeRequests:gitlab.example.com/group/sub/gl-b',
    ]);
    // zeta sits past the stop, in the aborted GitHub scope: disclosed.
    expect(row(view, 'zeta').error).toContain('refresh aborted before this repository was checked: rate-limit:');
    // gl-b was discarded and gl-c deferred: neither carries an error.
    expect(row(view, 'gl-b').error).toBeNull();
    expect(row(view, 'gl-c').error).toBeNull();
    const abort = h.logs.find((line) => line.msg.includes('refresh aborted (provider/rate-limit condition)'));
    expect(abort?.fields).toEqual({ scopes: ['github'], details: { github: 'rate-limit: alpha: GitHub rate limit' } });
    expect(h.logs.some((line) => line.msg.includes('call budget exhausted'))).toBe(true);
    github.errors.clear();
    order.length = 0;
    await h.tracker.refresh();
    expect(order[0]).toBe('fetchProject:gitlab.example.com/group/sub/gl-b');
  });

  it('resumes at the budget stop, not at an earlier skipped repository', async () => {
    const order: string[] = [];
    const github = new FakeGitHub(order);
    github.errors.set('fetchRepo:alpha', new GhRateLimitedError('alpha: GitHub rate limit', 'HTTP 403: API rate limit exceeded'));
    const gitlab = new FakeGitLab(order);
    const h = harness({
      refs: new Map<string, RepoRef>([
        ['alpha', githubRef('alpha')],
        ['beta', githubRef('beta')],
        ['gl-a', gitlabRef('gl-a')],
        ['gl-b', gitlabRef('gl-b')],
      ]),
      github,
      gitlabApi: gitlab,
      maxCallsPerRefresh: 5,
    });
    const view = await h.tracker.refresh();
    // alpha aborts GitHub (beta skipped), gl-a spends the rest, and the pass
    // stops before gl-b.
    expect(row(view, 'beta').error).toContain('refresh aborted before this repository was checked: rate-limit:');
    expect(row(view, 'gl-b')).toMatchObject({ freshness: 'unchecked', error: null });
    github.errors.clear();
    order.length = 0;
    await h.tracker.refresh();
    // The tail behind the stop goes first; rewinding to beta would starve it.
    expect(order[0]).toBe('fetchProject:gitlab.example.com/group/sub/gl-b');
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
