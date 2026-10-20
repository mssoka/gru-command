import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isValidSnapshot } from '../web/src/lib/board-protocol.js';
import {
  GhApiError,
  GhRateLimitedError,
  repoFullName,
  type GhCommandResult,
  type GhCommandRunner,
  type RepoRef,
} from '../src/dispatch/github-poll.js';
import { repoRemote } from '../src/dispatch/review-path.js';
import {
  gitProbeEnvironment,
  resolveManagedRepoPath,
  resolveManagedRepoPathSync,
} from '../src/repos/managed-names.js';
import {
  GhRepoOverviewApi,
  ManagedRepoOverviewTracker,
  REPO_OVERVIEW_FETCH_BUDGET_MS,
  REPO_OVERVIEW_REFRESH_MS,
  REPO_OVERVIEW_RESOLVE_BUDGET_MS,
  REPO_OVERVIEW_RUNS_PER_FETCH,
  REPO_OVERVIEW_STALE_AFTER_MS,
  classifyGhError,
  classifyRemote,
  freshnessOf,
  githubRepoLink,
  isDefaultBranchRun,
  runStateOf,
  safeRunUrl,
  selectLatestRun,
  type ActionsAvailability,
  type DefaultBranchRunsObservation,
  type RepoOverviewApiPort,
  type RepoOverviewMeta,
  type RepoOverviewRunRaw,
  type RepoOverviewRowView,
  defaultRemoteResolver,
} from '../src/repos/overview.js';
import { discoverManagedRepos, discoverManagedReposAsync } from '../src/repos/discovery.js';

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

function githubRef(repo: string, owner = 'acme'): RepoRef {
  return { host: 'github.com', owner, repo };
}

function rawRun(over: Partial<RepoOverviewRunRaw> = {}): RepoOverviewRunRaw {
  return {
    id: 1,
    name: 'checks',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/acme/alpha/actions/runs/1',
    runNumber: 1,
    createdAt: '2026-10-07T10:00:00.000Z',
    startedAt: '2026-10-07T10:00:00.000Z',
    updatedAt: '2026-10-07T10:05:00.000Z',
    workflowId: 101,
    headSha: '3684087c0000000000000000000000000000beef',
    event: 'push',
    fromFork: false,
    ...over,
  };
}

type CallName = 'fetchRepo' | 'countOpenPulls' | 'countOpenIssues' | 'countWorkflows' | 'latestRuns';

interface FakeFacts {
  readonly defaultBranch?: string | null;
  readonly openPrs?: number;
  readonly openIssues?: number;
  readonly workflows?: ActionsAvailability<number>;
  readonly runs?: ActionsAvailability<readonly RepoOverviewRunRaw[]>;
  readonly errors?: Partial<Record<CallName, unknown>>;
}

/** Deterministic in-memory port: every call is recorded by repo name. */
class FakeApi implements RepoOverviewApiPort {
  readonly calls: string[] = [];
  readonly runQueries: { repo: string; branch: string; limit: number }[] = [];
  readonly facts = new Map<string, FakeFacts>();

  set(repo: string, facts: FakeFacts): this {
    this.facts.set(repo, facts);
    return this;
  }

  private factsFor(repo: RepoRef): FakeFacts {
    return this.facts.get(repo.repo) ?? this.facts.get('*') ?? {};
  }

  private record(name: CallName, repo: RepoRef): FakeFacts {
    this.calls.push(`${name}:${repoFullName(repo)}`);
    const facts = this.factsFor(repo);
    const error = facts.errors?.[name];
    if (error !== undefined) throw error;
    return facts;
  }

  async fetchRepo(input: { readonly repo: RepoRef }): Promise<RepoOverviewMeta> {
    const facts = this.record('fetchRepo', input.repo);
    return { defaultBranch: facts.defaultBranch === undefined ? 'main' : facts.defaultBranch };
  }

  async countOpenPulls(input: { readonly repo: RepoRef }): Promise<number> {
    const facts = this.record('countOpenPulls', input.repo);
    return facts.openPrs ?? 0;
  }

  async countOpenIssues(input: { readonly repo: RepoRef }): Promise<number> {
    const facts = this.record('countOpenIssues', input.repo);
    return facts.openIssues ?? 0;
  }

  async countWorkflows(input: { readonly repo: RepoRef }): Promise<ActionsAvailability<number>> {
    const facts = this.record('countWorkflows', input.repo);
    return facts.workflows ?? { kind: 'ok', value: 1 };
  }

  async latestRuns(input: {
    readonly repo: RepoRef;
    readonly branch: string;
    readonly limit: number;
  }): Promise<ActionsAvailability<readonly RepoOverviewRunRaw[]>> {
    const facts = this.record('latestRuns', input.repo);
    this.runQueries.push({ repo: repoFullName(input.repo), branch: input.branch, limit: input.limit });
    return facts.runs ?? { kind: 'ok', value: [rawRun()] };
  }
}

interface Harness {
  tracker: ManagedRepoOverviewTracker;
  readonly api: FakeApi;
  readonly names: string[];
  readonly refs: Map<string, RepoRef | null>;
  /** Per-repo gates that postpone (or fail) remote resolution. */
  readonly resolveGates: Map<string, Promise<void>>;
  readonly unavailableNames: Set<string>;
  resolveError: boolean;
  resolveRootError: boolean;
  resolveDelayMs: number;
  readonly clock: { ms: number };
  readonly sleeps: number[];
  failure: string | null;
  failureFields: Record<string, unknown> | null;
  /** Every log line, any level. */
  readonly logs: { level: string; msg: string; fields: Record<string, unknown> | null }[];
}

const T0 = Date.parse('2026-10-07T12:00:00.000Z');

function harness(options: {
  names?: readonly string[];
  refs?: ReadonlyMap<string, RepoRef | null>;
  api?: FakeApi;
  maxCallsPerRefresh?: number;
  staleAfterMs?: number;
  /** Leave `intervalMs` unset so the tracker's own default cadence applies. */
  defaultCadence?: boolean;
  onDefaultBranchRuns?: (observation: DefaultBranchRunsObservation) => void;
} = {}): Harness {
  const names = [...(options.names ?? ['alpha'])];
  const api = options.api ?? new FakeApi();
  const refs = new Map<string, RepoRef | null>(
    options.refs ?? names.map((name) => [name, githubRef(name)] as const),
  );
  const clock = { ms: T0 };
  const sleeps: number[] = [];
  const state: Harness = {
    tracker: null as unknown as ManagedRepoOverviewTracker,
    api,
    names,
    refs,
    resolveGates: new Map<string, Promise<void>>(),
    unavailableNames: new Set<string>(),
    resolveError: false,
    resolveRootError: false,
    resolveDelayMs: 0,
    clock,
    sleeps,
    failure: null,
    failureFields: null,
    logs: [],
  };
  state.tracker = new ManagedRepoOverviewTracker({
    workspaceRoot: '/ws',
    managedRepos: names,
    api,
    scanRepos: () => state.names,
    resolveRepoPath: (_workspaceRoot, name) => {
      if (state.resolveRootError) throw new Error('temporary Git root probe failure');
      return state.unavailableNames.has(name)
        ? { kind: 'unavailable', reason: 'selected repository is unavailable under workspace_root' }
        : { kind: 'available', path: `/ws/${name}` };
    },
    resolveRemote: async (repoPath) => {
      const name = repoPath.split('/').pop() as string;
      const gate = state.resolveGates.get(name);
      if (gate !== undefined) await gate;
      if (state.resolveError) throw new Error('git origin lookup exploded');
      if (state.resolveDelayMs > 0) state.clock.ms += state.resolveDelayMs;
      return state.refs.get(name) ?? null;
    },
    ...(options.defaultCadence === true ? {} : { intervalMs: 300_000 }),
    ...(options.maxCallsPerRefresh !== undefined ? { maxCallsPerRefresh: options.maxCallsPerRefresh } : {}),
    ...(options.staleAfterMs !== undefined ? { staleAfterMs: options.staleAfterMs } : {}),
    now: () => state.clock.ms,
    sleep: async (ms) => {
      sleeps.push(ms);
      state.clock.ms += ms;
    },
    log: (level, msg, fields) => {
      state.logs.push({ level, msg, fields: fields ?? null });
      if (level === 'warn') {
        state.failure = msg;
        state.failureFields = fields ?? null;
      }
    },
    ...(options.onDefaultBranchRuns !== undefined ? { onDefaultBranchRuns: options.onDefaultBranchRuns } : {}),
  });
  return state;
}

function row(view: ReturnType<ManagedRepoOverviewTracker['view']>, key: string): RepoOverviewRowView {
  const found = view?.rows.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`row ${key} missing`);
  return found;
}

// ------------------------------------------------------------------
// Registry, identity, links
// ------------------------------------------------------------------

describe('managed repo overview tracker — registry and identity', () => {
  it('renders no view until the first refresh pass has classified the registry', async () => {
    const h = harness({ names: ['alpha'] });
    expect(h.tracker.view()).toBeNull();
    await h.tracker.refresh();
    expect(h.tracker.view()?.rows.map((entry) => entry.key)).toEqual(['alpha']);
  });

  it('derives rows from the registry in stable sorted order and never duplicates', async () => {
    const h = harness({ names: ['zeta', 'alpha', 'alpha'] });
    const view = await h.tracker.refresh();
    expect(view?.rows.map((entry) => entry.key)).toEqual(['alpha', 'zeta']);
    // A registry change is picked up on the next refresh: additions appear,
    // removals drop, and no duplicated identity survives a rescan.
    h.names.splice(0, h.names.length, 'beta', 'alpha');
    const next = await h.tracker.refresh();
    expect(next?.rows.map((entry) => entry.key)).toEqual(['alpha', 'beta']);
  });

  it('handles an empty registry with an explicit empty row set', async () => {
    const h = harness({ names: [] });
    expect(h.api.calls).toEqual([]);
    const view = await h.tracker.refresh();
    expect(view?.rows).toEqual([]);
    expect(h.api.calls).toEqual([]);
  });

  it('classifies missing/non-GitHub/unrecognized remotes as unlinked with a reason and spends no calls', async () => {
    const h = harness({
      names: ['missing', 'gitlab', 'weird'],
      refs: new Map<string, RepoRef | null>([
        ['missing', null],
        ['gitlab', { host: 'gitlab.example.com', owner: 'acme', repo: 'gitlab' }],
        ['weird', { host: 'github.com', owner: 'acme/evil', repo: 'weird' }],
      ]),
    });
    const view = await h.tracker.refresh();
    expect(h.api.calls).toEqual([]);
    for (const key of ['missing', 'gitlab', 'weird']) {
      const entry = row(view, key);
      expect(entry.linked).toBe(false);
      expect(entry.link).toBeNull();
      expect(entry.linkReason).not.toBeNull();
      expect(entry.openPrs).toBeNull();
      expect(entry.openIssues).toBeNull();
      expect(entry.run).toBeNull();
      expect(entry.checkedAt).toBeNull();
      expect(entry.freshness).toBe('unchecked');
    }
    expect(row(view, 'missing').linkReason).toBe('no usable origin remote');
    expect(row(view, 'gitlab').linkReason).toBe('non-GitHub remote');
    expect(row(view, 'weird').linkReason).toBe('unrecognized remote');
  });

  it('exposes the safe https link and full name for a linked GitHub remote', async () => {
    const h = harness({ names: ['alpha'] });
    const view = await h.tracker.refresh();
    const entry = row(view, 'alpha');
    expect(entry.linked).toBe(true);
    expect(entry.link).toBe('https://github.com/acme/alpha');
    expect(entry.linkReason).toBeNull();
    expect(entry.fullName).toBe('acme/alpha');
  });

  it('preserves cached observations and withholds provider polling after a transient root-probe failure', async () => {
    const api = new FakeApi().set('alpha', { openPrs: 7, openIssues: 8 });
    const h = harness({ api });
    const successful = await h.tracker.refresh();
    const original = row(successful, 'alpha');
    const callsBeforeFailure = api.calls.length;

    h.clock.ms += 1_000;
    h.resolveRootError = true;
    const failed = await h.tracker.refresh();
    const stale = row(failed, 'alpha');
    expect(stale.linked).toBe(true);
    expect(stale.fullName).toBe(original.fullName);
    expect(stale.openPrs).toBe(original.openPrs);
    expect(stale.openIssues).toBe(original.openIssues);
    expect(stale.run).toEqual(original.run);
    expect(stale.checkedAt).toBe(original.checkedAt);
    expect(stale.lastAttemptAt).not.toBe(original.lastAttemptAt);
    expect(stale.error).toContain('temporary Git root probe failure');
    expect(stale.freshness).toBe('stale');
    expect(api.calls).toHaveLength(callsBeforeFailure);

    h.resolveRootError = false;
    const recovered = await h.tracker.refresh();
    expect(row(recovered, 'alpha').freshness).toBe('fresh');
    expect(row(recovered, 'alpha').error).toBeNull();
    expect(api.calls.length).toBeGreaterThan(callsBeforeFailure);
  });

  it('drops the previous observation when the remote identity changes or disappears', async () => {
    const api = new FakeApi().set('alpha', { openPrs: 3 });
    const h = harness({ names: ['alpha'], api });
    await h.tracker.refresh();
    expect(row(h.tracker.view(), 'alpha').openPrs).toBe(3);

    // Same directory, different GitHub identity: the new identity is read
    // fresh — the previous identity's data must not attach to it.
    api.set('renamed', { openPrs: 9 });
    h.refs.set('alpha', githubRef('renamed'));
    const renamed = await h.tracker.refresh();
    expect(row(renamed, 'alpha').fullName).toBe('acme/renamed');
    expect(row(renamed, 'alpha').openPrs).toBe(9);
    expect(row(renamed, 'alpha').freshness).toBe('fresh');

    h.refs.set('alpha', null);
    const unlinked = await h.tracker.refresh();
    expect(row(unlinked, 'alpha').linked).toBe(false);
    expect(row(unlinked, 'alpha').openPrs).toBeNull();
  });
});

// ------------------------------------------------------------------
// Counts and runs
// ------------------------------------------------------------------

describe('managed repo overview tracker — exact counts and runs', () => {
  it('passes exact zero counts through as successful observations, never manufacturing data', async () => {
    const api = new FakeApi().set('alpha', { openPrs: 0, openIssues: 0, runs: { kind: 'ok', value: [rawRun()] } });
    const h = harness({ api });
    const view = await h.tracker.refresh();
    const entry = row(view, 'alpha');
    expect(entry.openPrs).toBe(0);
    expect(entry.openIssues).toBe(0);
    expect(entry.freshness).toBe('fresh');
    expect(entry.error).toBeNull();
  });

  it('carries large multi-page totals exactly (search aggregates, not page slices)', async () => {
    const api = new FakeApi().set('alpha', { openPrs: 313, openIssues: 1002 });
    const h = harness({ api });
    const entry = row(await h.tracker.refresh(), 'alpha');
    expect(entry.openPrs).toBe(313);
    expect(entry.openIssues).toBe(1002);
  });

  it('keeps the previous exact counts when an incomplete search degrades the observation', async () => {
    const api = new FakeApi().set('alpha', { openPrs: 5, openIssues: 4 });
    const h = harness({ api });
    await h.tracker.refresh();
    api.set('alpha', { openPrs: 5, openIssues: 4, errors: { countOpenPulls: new GhApiError('search: incomplete_results') } });
    const stale = row(await h.tracker.refresh(), 'alpha');
    expect(stale.openPrs).toBe(5);
    expect(stale.openIssues).toBe(4);
    expect(stale.freshness).toBe('stale');
    expect(stale.error).toContain('incomplete');
  });

  it('reads the actual discovered default branch, never an assumed one', async () => {
    const api = new FakeApi().set('alpha', {
      defaultBranch: 'trunk',
      runs: { kind: 'ok', value: [rawRun({ url: 'https://github.com/acme/alpha/actions/runs/9', id: 9 })] },
    });
    const h = harness({ api });
    const entry = row(await h.tracker.refresh(), 'alpha');
    expect(entry.run?.branch).toBe('trunk');
    expect(h.api.calls).toContain('latestRuns:acme/alpha');
  });

  it('shows the newest queued/running run instead of an older passed run, independent of list order', () => {
    const running = rawRun({ id: 2, status: 'in_progress', conclusion: null, createdAt: '2026-10-07T11:00:00.000Z' });
    const passed = rawRun({ id: 1, status: 'completed', conclusion: 'success', createdAt: '2026-10-07T10:00:00.000Z' });
    expect(selectLatestRun([running, passed])?.id).toBe(2);
    expect(selectLatestRun([passed, running])?.id).toBe(2);
    // A queued run wins the same way.
    const queued = rawRun({ id: 3, status: 'queued', conclusion: null, createdAt: '2026-10-07T11:30:00.000Z' });
    expect(selectLatestRun([passed, queued, running])?.id).toBe(3);
  });

  it('breaks an equal created_at by run id and falls back to id for unparseable stamps', () => {
    expect(selectLatestRun([rawRun({ id: 1 }), rawRun({ id: 7 })])?.id).toBe(7);
    expect(selectLatestRun([rawRun({ id: 2, createdAt: null }), rawRun({ id: 5, createdAt: null })])?.id).toBe(5);
    // Mixed pairs: a datable run always beats an undatable one, in either
    // list order, whatever the ids.
    expect(selectLatestRun([rawRun({ id: 9, createdAt: null }), rawRun({ id: 1 })])?.id).toBe(1);
    expect(selectLatestRun([rawRun({ id: 1 }), rawRun({ id: 9, createdAt: null })])?.id).toBe(1);
    expect(selectLatestRun([rawRun({ id: 9, createdAt: 'not-a-date' }), rawRun({ id: 1 })])?.id).toBe(1);
    expect(selectLatestRun([])).toBeNull();
  });

  it('maps every completed outcome class to its own honest state', () => {
    const cases: ReadonlyArray<readonly [string | null, string | null, string]> = [
      ['completed', 'success', 'passed'],
      ['completed', 'failure', 'failed'],
      ['completed', 'timed_out', 'timed-out'],
      ['completed', 'cancelled', 'cancelled'],
      ['completed', 'skipped', 'skipped'],
      ['completed', 'neutral', 'neutral'],
      ['completed', 'action_required', 'action-required'],
      ['completed', 'stale', 'stale-run'],
      ['completed', 'startup_failure', 'startup-failure'],
      ['completed', null, 'unknown'],
      ['completed', 'mystery', 'unknown'],
      [null, 'success', 'unknown'],
      ['in_progress', null, 'running'],
      ['queued', null, 'queued'],
      ['waiting', null, 'queued'],
      ['requested', null, 'queued'],
      ['pending', null, 'queued'],
      ['mystery', null, 'unknown'],
    ];
    for (const [status, conclusion, expected] of cases) {
      expect(runStateOf(status, conclusion), `${status}/${conclusion}`).toBe(expected);
    }
  });

  it('reports no-workflow only when the workflows endpoint proves there are none, without reading runs', async () => {
    const api = new FakeApi().set('alpha', { workflows: { kind: 'ok', value: 0 } });
    const h = harness({ api });
    const entry = row(await h.tracker.refresh(), 'alpha');
    expect(entry.run?.state).toBe('no-workflow');
    expect(h.api.calls).toContain('countWorkflows:acme/alpha');
    expect(h.api.calls).not.toContain('latestRuns:acme/alpha');
    // The exact server-emitted absence shape must pass the mirrored web
    // validator — no GitHub call means no provider strings.
    expect(isValidSnapshot(validBoardSnapshot(h.tracker.view()))).toBe(true);
  });

  it('distinguishes workflows-with-no-run (never-run) from genuinely no workflow', async () => {
    const api = new FakeApi().set('alpha', { workflows: { kind: 'ok', value: 2 }, runs: { kind: 'ok', value: [] } });
    const h = harness({ api });
    const entry = row(await h.tracker.refresh(), 'alpha');
    expect(entry.run?.state).toBe('never-run');
    expect(entry.run?.branch).toBe('main');
    expect(isValidSnapshot(validBoardSnapshot(h.tracker.view()))).toBe(true);
  });

  it('keeps counts fresh when Actions is permanently unavailable, marking only the run unavailable', async () => {
    const workflowsOff = new FakeApi().set('alpha', { openPrs: 2, openIssues: 1, workflows: { kind: 'actions-unavailable' } });
    const h1 = harness({ api: workflowsOff });
    const entry1 = row(await h1.tracker.refresh(), 'alpha');
    expect(entry1.openPrs).toBe(2);
    expect(entry1.run?.state).toBe('unavailable');
    expect(entry1.freshness).toBe('fresh');

    const runsOff = new FakeApi().set('alpha', {
      openPrs: 2,
      openIssues: 1,
      workflows: { kind: 'ok', value: 1 },
      runs: { kind: 'actions-unavailable' },
    });
    const h2 = harness({ api: runsOff });
    const entry2 = row(await h2.tracker.refresh(), 'alpha');
    expect(entry2.openPrs).toBe(2);
    expect(entry2.run?.state).toBe('unavailable');
  });

  it('keeps provider strings as inert data for the render layer to escape', async () => {
    const api = new FakeApi().set('alpha', {
      runs: { kind: 'ok', value: [rawRun({ name: '<script>alert(1)</script> & "quotes"' })] },
    });
    const h = harness({ api });
    const entry = row(await h.tracker.refresh(), 'alpha');
    expect(entry.run?.workflow).toBe('<script>alert(1)</script> & "quotes"');
  });
});

// ------------------------------------------------------------------
// Failure, freshness, recovery
// ------------------------------------------------------------------

describe('managed repo overview tracker — failure, freshness and recovery', () => {
  it('degrades only the failing repo: others refresh, the failed one keeps cached data as stale with age and error', async () => {
    const api = new FakeApi()
      .set('alpha', { openPrs: 1, openIssues: 1 })
      .set('beta', { openPrs: 2, openIssues: 2 });
    const h = harness({ names: ['alpha', 'beta'], api });
    await h.tracker.refresh();
    h.clock.ms += 60_000;
    api.set('beta', { errors: { fetchRepo: new GhApiError('beta: HTTP 403: Resource not accessible') } });
    const view = await h.tracker.refresh();
    const alpha = row(view, 'alpha');
    const beta = row(view, 'beta');
    expect(alpha.freshness).toBe('fresh');
    expect(alpha.openPrs).toBe(1);
    expect(beta.freshness).toBe('stale');
    expect(beta.openPrs).toBe(2);
    expect(beta.openIssues).toBe(2);
    expect(beta.error).toContain('HTTP 403');
    expect(beta.checkedAt).not.toBeNull();
    expect(Date.parse(beta.lastAttemptAt as string)).toBeGreaterThan(Date.parse(beta.checkedAt as string));
    expect(alpha.error).toBeNull();
  });

  it('recovers to fresh on the next successful refresh and clears the error', async () => {
    const api = new FakeApi().set('alpha', { errors: { fetchRepo: new GhApiError('alpha: HTTP 500') } });
    const h = harness({ api });
    const unavailable = row(await h.tracker.refresh(), 'alpha');
    expect(unavailable.freshness).toBe('unavailable');
    expect(unavailable.openPrs).toBeNull();
    api.set('alpha', { openPrs: 7, openIssues: 8 });
    const recovered = row(await h.tracker.refresh(), 'alpha');
    expect(recovered.freshness).toBe('fresh');
    expect(recovered.openPrs).toBe(7);
    expect(recovered.error).toBeNull();
  });

  it('reads a success older than the freshness window as stale even without a recorded failure', async () => {
    const h = harness({ names: ['alpha'] });
    await h.tracker.refresh();
    h.clock.ms += REPO_OVERVIEW_STALE_AFTER_MS + 1;
    expect(row(h.tracker.view(), 'alpha').freshness).toBe('stale');
    h.clock.ms += 1;
  });

  it('uses the 5-minute cadence by default: the 3-cadence window keeps data fresh to its boundary', async () => {
    // No `intervalMs` is injected: the tracker's own default must be the
    // documented 5-minute cadence (300000 ms), whose freshness window is
    // three cadences. A drift in either value fails here.
    const h = harness({ names: ['alpha'], defaultCadence: true });
    await h.tracker.refresh();
    expect(REPO_OVERVIEW_REFRESH_MS).toBe(5 * 60_000);
    expect(REPO_OVERVIEW_STALE_AFTER_MS).toBe(REPO_OVERVIEW_REFRESH_MS * 3);
    expect(row(h.tracker.view(), 'alpha').freshness).toBe('fresh');
    h.clock.ms += REPO_OVERVIEW_REFRESH_MS * 3;
    expect(row(h.tracker.view(), 'alpha').freshness).toBe('fresh');
    h.clock.ms += 1;
    expect(row(h.tracker.view(), 'alpha').freshness).toBe('stale');
  });

  it('never publishes a credentialed or alternate-port provider run URL', async () => {
    // The server-side guard is the layer that keeps a strict client from
    // rejecting (and freezing) the whole board on a GHE-style run URL.
    const api = new FakeApi()
      .set('alpha', {
        runs: {
          kind: 'ok',
          value: [rawRun({ id: 7, url: 'https://user:secret@github.com/acme/alpha/actions/runs/7' })],
        },
      })
      .set('beta', {
        runs: {
          kind: 'ok',
          value: [rawRun({ id: 8, url: 'https://github.com:8443/acme/beta/actions/runs/8' })],
        },
      });
    const h = harness({ names: ['alpha', 'beta'], api });
    const view = await h.tracker.refresh();
    const alpha = row(view, 'alpha');
    const beta = row(view, 'beta');
    // The rows survive (the observation is complete) but carry no link.
    expect(alpha.run?.url).toBeNull();
    expect(beta.run?.url).toBeNull();
    expect(alpha.openPrs).not.toBeNull();
    expect(beta.openPrs).not.toBeNull();
    expect(alpha.run?.runNumber).toBe(1);
  });

  it('computes freshness purely from the fetch completion and attempt ordering', () => {
    const checked = '2026-10-07T12:00:00.000Z';
    expect(freshnessOf({ checkedAt: null, lastAttemptAt: null, nowMs: T0, staleAfterMs: 1000 })).toBe('unchecked');
    expect(freshnessOf({ checkedAt: null, lastAttemptAt: checked, nowMs: T0, staleAfterMs: 1000 })).toBe('unavailable');
    expect(freshnessOf({ checkedAt: checked, lastAttemptAt: checked, nowMs: T0 + 100, staleAfterMs: 1000 })).toBe('fresh');
    expect(freshnessOf({ checkedAt: checked, lastAttemptAt: checked, nowMs: T0 + 1000, staleAfterMs: 1000 })).toBe('fresh');
    expect(freshnessOf({ checkedAt: checked, lastAttemptAt: checked, nowMs: T0 + 1001, staleAfterMs: 1000 })).toBe('stale');
    expect(
      freshnessOf({ checkedAt: checked, lastAttemptAt: '2026-10-07T12:00:30.000Z', nowMs: T0 + 100, staleAfterMs: 1000 }),
    ).toBe('stale');
    // A recorded failure is authoritative even in the same millisecond.
    expect(freshnessOf({ checkedAt: checked, lastAttemptAt: checked, failed: true, nowMs: T0, staleAfterMs: 1000 })).toBe(
      'stale',
    );
  });

  it('aborts the refresh on a rate limit: the failing repo is recorded, later repos are untouched, next cadence recovers', async () => {
    const api = new FakeApi()
      .set('alpha', { errors: { fetchRepo: new GhRateLimitedError('alpha: GitHub rate limit (HTTP 403)') } })
      .set('beta', { openPrs: 3 });
    const h = harness({ names: ['alpha', 'beta'], api });
    const aborted = await h.tracker.refresh();
    expect(api.calls.some((call) => call.endsWith('acme/beta'))).toBe(false);
    expect(row(aborted, 'alpha').error).toContain('rate limit');
    expect(row(aborted, 'beta').checkedAt).toBeNull();

    api.set('alpha', { openPrs: 1 });
    const recovered = await h.tracker.refresh();
    expect(row(recovered, 'alpha').freshness).toBe('fresh');
    expect(row(recovered, 'beta').openPrs).toBe(3);
  });

  it('aborts the refresh when gh is unavailable (auth-level condition), without hammering every repo', async () => {
    const api = new FakeApi().set('*', {
      errors: { fetchRepo: new GhApiError('repo: gh is unavailable (spawn failed)', 'Error: spawn gh ENOENT') },
    });
    const h = harness({ names: ['alpha', 'beta', 'gamma'], api });
    const view = await h.tracker.refresh();
    expect(api.calls).toHaveLength(1);
    expect(row(view, 'alpha').freshness).toBe('unavailable');
    expect(row(view, 'beta').checkedAt).toBeNull();
  });

  it('continues past a per-repo permission failure (not a global condition)', async () => {
    const api = new FakeApi()
      .set('alpha', { errors: { countOpenPulls: new GhApiError('alpha: HTTP 403: Forbidden') } })
      .set('beta', { openPrs: 4 });
    const h = harness({ names: ['alpha', 'beta'], api });
    const view = await h.tracker.refresh();
    expect(row(view, 'alpha').freshness).toBe('unavailable');
    expect(row(view, 'beta').freshness).toBe('fresh');
    expect(api.calls.some((call) => call === 'fetchRepo:acme/beta')).toBe(true);
  });

  it('defers at the per-refresh call budget and rotates fairly across cycles', async () => {
    const api = new FakeApi()
      .set('alpha', { openPrs: 1 })
      .set('beta', { openPrs: 2 })
      .set('gamma', { openPrs: 3 });
    const h = harness({ names: ['alpha', 'beta', 'gamma'], api, maxCallsPerRefresh: 5 });
    const first = await h.tracker.refresh();
    // One complete 5-call observation fits; beta/gamma wait their turn.
    expect(row(first, 'alpha').freshness).toBe('fresh');
    expect(row(first, 'beta').checkedAt).toBeNull();
    expect(row(first, 'gamma').checkedAt).toBeNull();
    const second = await h.tracker.refresh();
    expect(row(second, 'beta').freshness).toBe('fresh');
    expect(row(second, 'alpha').freshness).toBe('fresh');
    const third = await h.tracker.refresh();
    expect(row(third, 'gamma').freshness).toBe('fresh');
  });

  it('coalesces overlapping refresh calls into one pass', async () => {
    const h = harness({ names: ['alpha'] });
    const first = h.tracker.refresh();
    const second = h.tracker.refresh();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(h.api.calls.filter((call) => call.startsWith('fetchRepo')).length).toBe(1);
  });

  it('start() is idempotent and never doubles the refresh work', async () => {
    const h = harness({ names: ['alpha'] });
    h.tracker.start();
    h.tracker.start();
    try {
      await h.tracker.refresh();
    } finally {
      h.tracker.stop();
    }
    expect(h.api.calls.filter((call) => call.startsWith('fetchRepo')).length).toBe(1);
  });

  it('records only the bounded provider detail and never invents a zero on failure', async () => {
    const api = new FakeApi().set('alpha', { errors: { fetchRepo: new GhApiError(`alpha: ${'x'.repeat(4000)}`) } });
    const h = harness({ api });
    const entry = row(await h.tracker.refresh(), 'alpha');
    expect(entry.openPrs).toBeNull();
    expect(entry.freshness).toBe('unavailable');
    expect((entry.error as string).length).toBeLessThanOrEqual(300);
  });
});

// ------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------

describe('managed repo overview — pure helpers', () => {
  it('classifies remote reasons without guessing an identity', () => {
    const resolver = (value: RepoRef | null) => () => value;
    expect(classifyRemote('/ws/a', resolver(null)).kind).toBe('unlinked');
    expect(classifyRemote('/ws/a', resolver({ host: 'gitlab.com', owner: 'o', repo: 'r' }))).toEqual({
      kind: 'unlinked',
      reason: 'non-GitHub remote',
    });
    expect(classifyRemote('/ws/a', resolver({ host: 'github.com', owner: '..', repo: 'r' })).kind).toBe('unlinked');
    expect(classifyRemote('/ws/a', resolver(githubRef('alpha')))).toEqual({ kind: 'linked', ref: githubRef('alpha') });
  });

  it('builds safe https links only for safe GitHub identities', () => {
    expect(githubRepoLink(githubRef('alpha'))).toBe('https://github.com/acme/alpha');
    expect(githubRepoLink({ host: 'gitlab.com', owner: 'acme', repo: 'alpha' })).toBeNull();
    expect(githubRepoLink({ host: 'github.com', owner: 'acme evil', repo: 'alpha' })).toBeNull();
    expect(githubRepoLink({ host: 'github.com', owner: '..', repo: 'alpha' })).toBeNull();
    // The client validator's safe-host contract is enforced here too.
    expect(githubRepoLink({ host: 'foo_bar.github', owner: 'acme', repo: 'alpha' })).toBeNull();
    expect(githubRepoLink({ host: 'foo..bar.github', owner: 'acme', repo: 'alpha' })).toBeNull();
    expect(githubRepoLink({ host: '..', owner: 'acme', repo: 'alpha' })).toBeNull();
    expect(githubRepoLink({ host: '.github', owner: 'acme', repo: 'alpha' })).toBeNull();
    expect(githubRepoLink({ host: 'github.com.', owner: 'acme', repo: 'alpha' })).toBeNull();
  });

  it('accepts run URLs only on the repository host over https', () => {
    expect(safeRunUrl('https://github.com/acme/alpha/actions/runs/1', 'github.com')).toBe(
      'https://github.com/acme/alpha/actions/runs/1',
    );
    expect(safeRunUrl('http://github.com/acme/alpha/actions/runs/1', 'github.com')).toBeNull();
    expect(safeRunUrl('https://evil.example/actions/runs/1', 'github.com')).toBeNull();
    expect(safeRunUrl('javascript:alert(1)', 'github.com')).toBeNull();
    expect(safeRunUrl(null, 'github.com')).toBeNull();
    // Credentials never ride a rendered link, and an explicit non-default
    // port is a different origin than the repository host. The default
    // https port normalizes away and stays acceptable.
    expect(safeRunUrl('https://user:secret@github.com/acme/alpha/actions/runs/1', 'github.com')).toBeNull();
    expect(safeRunUrl('https://github.com:8443/acme/alpha/actions/runs/1', 'github.com')).toBeNull();
    expect(safeRunUrl('https://github.com:443/acme/alpha/actions/runs/1', 'github.com')).toBe(
      'https://github.com/acme/alpha/actions/runs/1',
    );
  });

  it('classifies provider failures from the structured cause, never the annotated label', () => {
    expect(classifyGhError(new GhRateLimitedError('x'))).toBe('rate-limit');
    expect(classifyGhError(new GhApiError('x', 'HTTP 403: API rate limit exceeded'))).toBe('rate-limit');
    expect(classifyGhError(new GhApiError('x', 'Error: spawn gh ENOENT'))).toBe('auth');
    expect(classifyGhError(new GhApiError('x', 'HTTP 401: Bad credentials'))).toBe('auth');
    expect(classifyGhError(new GhApiError('x', 'HTTP 403: Forbidden'))).toBe('permission');
    expect(classifyGhError(new GhApiError('x', 'HTTP 404: Not Found'))).toBe('not-found');
    expect(classifyGhError(new GhApiError('x', 'HTTP 500: server error'))).toBe('other');
    // A timed-out or capped call is one repository's problem, not a global
    // provider condition.
    expect(classifyGhError(new GhApiError('x', 'gh api timed out after 30000 ms'))).toBe('other');
    expect(classifyGhError(new GhApiError('x', 'gh api output exceeds 100 bytes'))).toBe('other');
    // Adapter/shape failures carry no cause: per-repository.
    expect(classifyGhError(new GhApiError('repo authentication-service: response carries no default_branch'))).toBe('other');
    // Non-GhApiError test fakes still fall back to their own text.
    expect(classifyGhError(new Error('HTTP 403: Forbidden'))).toBe('permission');
  });
});

// ------------------------------------------------------------------
// gh CLI adapter
// ------------------------------------------------------------------

interface RecordingRunner {
  readonly calls: string[][];
  readonly runner: GhCommandRunner;
}

function ghRunner(results: readonly GhCommandResult[]): RecordingRunner {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    runner: async (args) => {
      calls.push([...args]);
      const result = results[index];
      index += 1;
      return result ?? { status: 1, stdout: '', stderr: 'runner exhausted' };
    },
  };
}

function ok(stdout: string): GhCommandResult {
  return { status: 0, stdout, stderr: '' };
}

describe('managed repo overview — gh adapter', () => {
  it('reads repo metadata, exact search counts, workflows and default-branch runs over the documented paths', async () => {
    const recorder = ghRunner([
      ok(JSON.stringify({ default_branch: 'trunk' })),
      ok(JSON.stringify({ total_count: 3, incomplete_results: false })),
      ok(JSON.stringify({ total_count: 39, incomplete_results: false })),
      ok(JSON.stringify({ total_count: 1 })),
      ok(
        JSON.stringify({
          workflow_runs: [
            {
              id: 42,
              name: 'CI',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.com/acme/alpha/actions/runs/42',
              run_number: 12,
              created_at: '2026-10-07T09:59:00Z',
              run_started_at: '2026-10-07T10:00:00Z',
              updated_at: '2026-10-07T10:05:00Z',
              workflow_id: 7001,
              head_sha: '3684087cabcdef0123456789abcdef0123456789',
              event: 'push',
              repository: { id: 900, full_name: 'acme/alpha' },
              head_repository: { id: 900, full_name: 'acme/alpha' },
            },
          ],
        }),
      ),
    ]);
    const api = new GhRepoOverviewApi(recorder.runner);
    const repo = githubRef('alpha');
    expect(await api.fetchRepo({ repo })).toEqual({ defaultBranch: 'trunk' });
    expect(await api.countOpenPulls({ repo })).toBe(3);
    expect(await api.countOpenIssues({ repo })).toBe(39);
    expect(await api.countWorkflows({ repo })).toEqual({ kind: 'ok', value: 1 });
    expect(await api.latestRuns({ repo, branch: 'trunk', limit: 3 })).toEqual({
      kind: 'ok',
      value: [
        {
          id: 42,
          name: 'CI',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/acme/alpha/actions/runs/42',
          runNumber: 12,
          createdAt: '2026-10-07T09:59:00Z',
          startedAt: '2026-10-07T10:00:00Z',
          updatedAt: '2026-10-07T10:05:00Z',
          workflowId: 7001,
          headSha: '3684087cabcdef0123456789abcdef0123456789',
          event: 'push',
          fromFork: false,
        },
      ],
    });
    const paths = recorder.calls.map((args) => args[3]);
    expect(paths[0]).toBe('repos/acme/alpha');
    expect(paths[1]).toBe('search/issues?q=repo%3Aacme%2Falpha+is%3Aopen+is%3Apr&per_page=1');
    expect(paths[2]).toBe('search/issues?q=repo%3Aacme%2Falpha+is%3Aopen+is%3Aissue&per_page=1');
    expect(paths[3]).toBe('repos/acme/alpha/actions/workflows?per_page=1');
    expect(paths[4]).toBe('repos/acme/alpha/actions/runs?branch=trunk&per_page=3');
    for (const args of recorder.calls) {
      expect(args.slice(0, 2)).toEqual(['api', '--hostname']);
      expect(args[2]).toBe('github.com');
    }
  });

  it('carries the spawn failure as a structured cause through the adapter', async () => {
    const adapter = new GhRepoOverviewApi(
      ghRunner([{ status: -1, stdout: '', stderr: '', error: 'Error: spawn gh ENOENT' }]).runner,
    );
    let captured: unknown = null;
    try {
      await adapter.fetchRepo({ repo: githubRef('alpha') });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(GhApiError);
    expect((captured as GhApiError).causeText).toBe('Error: spawn gh ENOENT');
    expect(classifyGhError(captured)).toBe('auth');
  });

  it('raises a rate-limit error on a rate-limit stderr and a plain error otherwise', async () => {
    const limited = new GhRepoOverviewApi(ghRunner([{ status: 1, stdout: '', stderr: 'gh: rate limit exceeded (HTTP 403)' }]).runner);
    await expect(limited.countOpenPulls({ repo: githubRef('alpha') })).rejects.toBeInstanceOf(GhRateLimitedError);
    const refused = new GhRepoOverviewApi(ghRunner([{ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }]).runner);
    await expect(refused.fetchRepo({ repo: githubRef('alpha') })).rejects.toBeInstanceOf(GhApiError);
  });

  it('treats Actions-disabled (404/409) as an observable state, never as repo metadata failure', async () => {
    const workflows404 = new GhRepoOverviewApi(
      ghRunner([{ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }]).runner,
    );
    expect(await workflows404.countWorkflows({ repo: githubRef('alpha') })).toEqual({ kind: 'actions-unavailable' });

    const runs409 = new GhRepoOverviewApi(
      ghRunner([{ status: 1, stdout: '', stderr: 'gh: GitHub Actions is disabled for this repository. (HTTP 409)' }]).runner,
    );
    expect(await runs409.latestRuns({ repo: githubRef('alpha'), branch: 'main', limit: 3 })).toEqual({
      kind: 'actions-unavailable',
    });
  });

  it('rejects incomplete search aggregates instead of presenting them as exact', async () => {
    const api = new GhRepoOverviewApi(
      ghRunner([ok(JSON.stringify({ total_count: 3, incomplete_results: true }))]).runner,
    );
    await expect(api.countOpenPulls({ repo: githubRef('alpha') })).rejects.toThrow(/incomplete/);
    // Only an explicit `false` proves exactness: a truthy non-boolean or a
    // missing flag fails closed.
    const truthyFlag = new GhRepoOverviewApi(
      ghRunner([ok(JSON.stringify({ total_count: 3, incomplete_results: 1 }))]).runner,
    );
    await expect(truthyFlag.countOpenPulls({ repo: githubRef('alpha') })).rejects.toThrow(/incomplete/);
    const missingFlag = new GhRepoOverviewApi(ghRunner([ok(JSON.stringify({ total_count: 3 }))]).runner);
    await expect(missingFlag.countOpenPulls({ repo: githubRef('alpha') })).rejects.toThrow(/incomplete/);
  });

  it('fails loud on malformed provider shapes', async () => {
    const badTotal = new GhRepoOverviewApi(ghRunner([ok('{}')]).runner);
    await expect(badTotal.countOpenPulls({ repo: githubRef('alpha') })).rejects.toThrow(/total_count/);
    // A JSON object without default_branch is an empty repository (null
    // branch), not a malformed response; a non-object response is malformed.
    const emptyRepo = new GhRepoOverviewApi(ghRunner([ok('{}')]).runner);
    expect(await emptyRepo.fetchRepo({ repo: githubRef('alpha') })).toEqual({ defaultBranch: null });
    const badBranch = new GhRepoOverviewApi(ghRunner([ok('null')]).runner);
    await expect(badBranch.fetchRepo({ repo: githubRef('alpha') })).rejects.toThrow(/JSON object/);
    const badRuns = new GhRepoOverviewApi(ghRunner([ok('{}')]).runner);
    await expect(badRuns.latestRuns({ repo: githubRef('alpha'), branch: 'main', limit: 3 })).rejects.toThrow(
      /workflow_runs/,
    );
    const badWorkflowTotal = new GhRepoOverviewApi(ghRunner([ok('{}')]).runner);
    await expect(badWorkflowTotal.countWorkflows({ repo: githubRef('alpha') })).rejects.toThrow(/total_count/);
    const nonStringBranch = new GhRepoOverviewApi(ghRunner([ok(JSON.stringify({ default_branch: 123 }))]).runner);
    await expect(nonStringBranch.fetchRepo({ repo: githubRef('alpha') })).rejects.toThrow(/default_branch/);
    const emptyBranch = new GhRepoOverviewApi(ghRunner([ok(JSON.stringify({ default_branch: '' }))]).runner);
    await expect(emptyBranch.fetchRepo({ repo: githubRef('alpha') })).rejects.toThrow(/default_branch/);
    const badJson = new GhRepoOverviewApi(ghRunner([ok('not-json')]).runner);
    await expect(badJson.fetchRepo({ repo: githubRef('alpha') })).rejects.toThrow(/invalid JSON/);
  });
});

// ------------------------------------------------------------------
// Review-round fixes (independent review r1)
// ------------------------------------------------------------------

describe('managed repo overview tracker — review-round guarantees', () => {
  it('never claims stale or failed while an observation is actually in flight', async () => {
    const h = harness({ names: ['alpha'] });
    await h.tracker.refresh();
    const before = row(h.tracker.view(), 'alpha');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = h.api.fetchRepo.bind(h.api);
    h.api.fetchRepo = async (input) => {
      await gate;
      return original(input);
    };

    const pending = h.tracker.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const during = row(h.tracker.view(), 'alpha');
    expect(during.freshness).toBe('fresh');
    expect(during.error).toBeNull();
    expect(during.checkedAt).toBe(before.checkedAt);
    expect(during.lastAttemptAt).toBe(before.lastAttemptAt);

    release();
    await pending;
    expect(row(h.tracker.view(), 'alpha').freshness).toBe('fresh');
  });

  it('prioritizes a discarded observation then rotates fairly when the budget cannot finish one', async () => {
    const api = new FakeApi().set('alpha', {}).set('beta', {}).set('gamma', {});
    const h = harness({ names: ['alpha', 'beta', 'gamma'], api, maxCallsPerRefresh: 3 });
    const firstAttempted: string[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      h.api.calls.length = 0;
      await h.tracker.refresh();
      firstAttempted.push(h.api.calls[0]?.split(':')[1] ?? '');
    }
    // Each discarded repository is resumed FIRST on the next pass, and a
    // repeated discard rotates on: no repository is starved, and the cursor
    // never pins to one entry.
    expect(firstAttempted).toEqual([
      'acme/alpha',
      'acme/alpha',
      'acme/beta',
      'acme/beta',
      'acme/gamma',
      'acme/gamma',
    ]);
    for (const key of ['alpha', 'beta', 'gamma']) {
      expect(row(h.tracker.view(), key).lastAttemptAt).toBeNull();
      expect(row(h.tracker.view(), key).checkedAt).toBeNull();
    }
    expect(h.failure).toContain('budget exhausted');
  });

  it('resumes the truncated last repository on the next pass (production-shaped 21-repo budget)', async () => {
    const names = Array.from({ length: 21 }, (_, index) => `repo-${String(index).padStart(2, '0')}`);
    const api = new FakeApi();
    // The first repository has no workflows (4 calls); the next 19 cost 5
    // each = 99, so the 21st is truncated mid-observation at the 100-call
    // budget exactly as the production shape does.
    api.set(names[0] as string, { workflows: { kind: 'ok', value: 0 } });
    for (const name of names.slice(1)) {
      api.set(name, { workflows: { kind: 'ok', value: 1 }, runs: { kind: 'ok', value: [rawRun()] } });
    }
    const h = harness({ names, api, maxCallsPerRefresh: 100 });
    const first = await h.tracker.refresh();
    expect(row(first, names[20] as string).checkedAt).toBeNull();
    expect(row(first, names[19] as string).checkedAt).not.toBeNull();

    h.api.calls.length = 0;
    const second = await h.tracker.refresh();
    // The truncated tail is the FIRST repository observed on the next pass.
    expect(h.api.calls[0]).toBe(`fetchRepo:acme/${names[20]}`);
    expect(row(second, names[20] as string).checkedAt).not.toBeNull();
    expect(row(second, names[0] as string).checkedAt).not.toBeNull();
  });

  it('paces search calls to the sustained GitHub search quota', async () => {
    const api = new FakeApi().set('alpha', {}).set('beta', {});
    const h = harness({ names: ['alpha', 'beta'], api });
    await h.tracker.refresh();
    // Four search calls in one close pass: the first is free, each of the
    // next three waits out the 2 s pacing interval.
    expect(h.sleeps).toEqual([2_000, 2_000, 2_000]);
  });

  it('never reads repository names as provider semantics (auth/actions labels)', async () => {
    const api = new FakeApi()
      .set('authentication-service', {
        errors: {
          fetchRepo: new GhApiError(
            'repo acme/authentication-service: gh exited 1: HTTP 500: server error',
            'HTTP 500: server error',
          ),
        },
      })
      .set('beta', { openPrs: 2 });
    const h = harness({ names: ['authentication-service', 'beta'], api });
    const view = await h.tracker.refresh();
    expect(row(view, 'authentication-service').freshness).toBe('unavailable');
    expect(row(view, 'authentication-service').error).toContain('HTTP 500');
    // The refresh continued: a name containing "authentication" is not a
    // global auth condition.
    expect(row(view, 'beta').freshness).toBe('fresh');
  });

  it('never converts a real failure into Actions-unavailable through a name or a timeout', async () => {
    const named = new GhRepoOverviewApi(
      ghRunner([{ status: 1, stdout: '', stderr: 'gh: HTTP 500: server error' }]).runner,
    );
    await expect(
      named.countWorkflows({ repo: { host: 'github.com', owner: 'acme', repo: 'actions-disabled-tests' } }),
    ).rejects.toThrow(/HTTP 500/);

    const timedOut = new GhRepoOverviewApi(
      ghRunner([{ status: -1, stdout: '', stderr: '', error: 'gh api timed out after 30000 ms' }]).runner,
    );
    await expect(timedOut.countWorkflows({ repo: githubRef('alpha') })).rejects.toThrow(/timed out/);
  });

  it('fails loud on a malformed runs entry instead of manufacturing never-run', async () => {
    const adapter = new GhRepoOverviewApi(
      ghRunner([ok(JSON.stringify({ workflow_runs: [null, { id: 1 }] }))]).runner,
    );
    await expect(adapter.latestRuns({ repo: githubRef('alpha'), branch: 'main', limit: 3 })).rejects.toThrow(
      /malformed workflow_runs/,
    );

    // Tracker-level: the failed observation retains the previous exact
    // counts and run rather than presenting a fresh NO RUNS.
    const api = new FakeApi().set('alpha', { openPrs: 4, runs: { kind: 'ok', value: [rawRun()] } });
    const h = harness({ api });
    await h.tracker.refresh();
    api.set('alpha', {
      openPrs: 4,
      errors: { latestRuns: new GhApiError('runs acme/alpha@main: response carries a malformed workflow_runs entry') },
    });
    const stale = row(await h.tracker.refresh(), 'alpha');
    expect(stale.freshness).toBe('stale');
    expect(stale.run?.state).toBe('passed');
    expect(stale.openPrs).toBe(4);
  });

  it('normalizes provider run values so a malformed field can never fail the web validator', async () => {
    const adapter = new GhRepoOverviewApi(
      ghRunner([
        ok(
          JSON.stringify({
            workflow_runs: [
              {
                id: 7,
                name: 'CI',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://github.com/acme/alpha/actions/runs/7',
                run_number: -3,
                run_started_at: 'not-a-date',
                updated_at: 12345,
              },
              {
                id: 8,
                name: 'CI',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://github.com/acme/alpha/actions/runs/8',
                run_number: 2.5,
                created_at: '2026-10-07T10:00:00.000Z',
                updated_at: '2026-10-07T10:05:00.000Z',
              },
            ],
          }),
        ),
      ]).runner,
    );
    const result = await adapter.latestRuns({ repo: githubRef('alpha'), branch: 'main', limit: 3 });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.value[0]?.runNumber).toBeNull();
    // `run_started_at` no longer substitutes for the creation key: a run
    // without `created_at` has no creation time and sorts by id only.
    expect(result.value[0]?.createdAt).toBeNull();
    expect(result.value[0]?.startedAt).toBeNull();
    expect(result.value[0]?.updatedAt).toBeNull();
    // A malformed run id never participates in the newest-run tie-break.
    expect(result.value[0]?.id).toBe(7);
    const badId = new GhRepoOverviewApi(
      ghRunner([ok(JSON.stringify({ workflow_runs: [{ id: -2, status: 'completed', conclusion: 'success' }] }))]).runner,
    );
    const badIdResult = await badId.latestRuns({ repo: githubRef('alpha'), branch: 'main', limit: 3 });
    if (badIdResult.kind !== 'ok') throw new Error('expected ok');
    expect(badIdResult.value[0]?.id).toBeNull();
    expect(result.value[1]?.runNumber).toBeNull();
    expect(result.value[1]?.createdAt).toBe('2026-10-07T10:00:00.000Z');
    expect(result.value[1]?.startedAt).toBeNull();
    expect(result.value[1]?.updatedAt).toBe('2026-10-07T10:05:00.000Z');
  });

  it('drives the configured registry and origin resolver over a real workspace without enrolling siblings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-defaults-'));
    try {
      execFileSync('git', ['init', '-q', join(root, 'alpha')]);
      execFileSync('git', ['-C', join(root, 'alpha'), 'remote', 'add', 'origin', 'https://github.com/acme/alpha.git']);
      execFileSync('git', ['init', '-q', join(root, 'no-origin')]);
      execFileSync('git', ['init', '-q', join(root, 'gitlab-repo')]);
      execFileSync('git', ['-C', join(root, 'gitlab-repo'), 'remote', 'add', 'origin', 'https://gitlab.com/acme/gl.git']);
      mkdirSync(join(root, 'broken'));
      writeFileSync(join(root, 'broken', '.git'), 'gitdir: /nonexistent/gru-repo-overview-test\n');
      execFileSync('git', ['init', '-q', join(root, 'unselected')]);
      mkdirSync(join(root, 'plain'));
      const api = new FakeApi().set('alpha', { openPrs: 1, openIssues: 2, workflows: { kind: 'ok', value: 0 } });
      const tracker = new ManagedRepoOverviewTracker({
        workspaceRoot: root,
        managedRepos: ['alpha', 'broken', 'gitlab-repo', 'no-origin'],
        api,
        now: () => T0,
        sleep: async () => {},
      });
      const view = await tracker.refresh();
      expect(view?.rows.map((entry) => entry.key)).toEqual(['alpha', 'broken', 'gitlab-repo', 'no-origin']);
      expect(view?.rows.some((entry) => entry.key === 'unselected')).toBe(false);
      const entry = row(view, 'alpha');
      expect(entry.linked).toBe(true);
      expect(entry.fullName).toBe('acme/alpha');
      expect(entry.link).toBe('https://github.com/acme/alpha');
      expect(entry.openPrs).toBe(1);
      expect(entry.run?.state).toBe('no-workflow');
      // The default resolver's failure paths through the REAL seam:
      expect(row(view, 'no-origin').linkReason).toBe('no usable origin remote');
      expect(row(view, 'gitlab-repo').linkReason).toBe('non-GitHub remote');
      // A stale worktree pointer is unavailable, never an origin-read failure
      // that could preserve or classify a remote identity.
      expect(row(view, 'broken').linkReason).toBe('selected repository is unavailable under workspace_root');
      expect(api.calls.every((call) => call.endsWith('acme/alpha'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------
// Round-2 review fixes: interleaving, disclosure and edge states
// ------------------------------------------------------------------

function validBoardSnapshot(repoOverview: unknown): unknown {
  return {
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
      incarnation: 'test-incarnation',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    repoOverview,
  };
}

describe('managed repo overview tracker — round-2 guarantees', () => {
  it('renders an empty repository as exact counts + NO BRANCH, not a fetch failure', async () => {
    const api = new FakeApi().set('empty', { defaultBranch: null, openPrs: 0, openIssues: 2 });
    const h = harness({ names: ['empty'], api });
    const entry = row(await h.tracker.refresh(), 'empty');
    expect(entry.freshness).toBe('fresh');
    expect(entry.openPrs).toBe(0);
    expect(entry.openIssues).toBe(2);
    expect(entry.run?.state).toBe('no-branch');
    expect(entry.run?.branch).toBeNull();
    // Without a branch there is nothing to query runs/workflows for.
    expect(api.calls).not.toContain('countWorkflows:acme/empty');
    expect(api.calls).not.toContain('latestRuns:acme/empty');
    expect(isValidSnapshot(validBoardSnapshot(h.tracker.view()))).toBe(true);
  });

  it('never exposes a half-classified registry entry to the web validator mid-refresh', async () => {
    const h = harness({ names: ['alpha'] });
    await h.tracker.refresh();

    h.names.push('beta');
    h.refs.set('beta', githubRef('beta'));
    let release!: () => void;
    h.resolveGates.set('beta', new Promise<void>((resolve) => { release = resolve; }));

    const pending = h.tracker.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const mid = h.tracker.view();
    // The view a board push/heartbeat can take during classification must
    // satisfy the production web validator, and the unclassified entry is
    // not published early.
    expect(isValidSnapshot(validBoardSnapshot(mid))).toBe(true);
    expect(mid?.rows.map((entry) => entry.key)).toEqual(['alpha']);

    release();
    await pending;
    expect(row(h.tracker.view(), 'beta').linked).toBe(true);
  });

  it('keeps the previous classification and cached observation when origin resolution fails transiently', async () => {
    const h = harness({ names: ['alpha'] });
    await h.tracker.refresh();
    const before = row(h.tracker.view(), 'alpha');
    h.resolveError = true;
    h.api.set('alpha', { errors: { fetchRepo: new GhApiError('alpha: HTTP 500: server error', 'HTTP 500: server error') } });
    const after = row(await h.tracker.refresh(), 'alpha');
    expect(after.linked).toBe(true);
    expect(after.link).toBe(before.link);
    expect(after.fullName).toBe(before.fullName);
    expect(after.linkReason).toBeNull();
    expect(after.openPrs).toBe(before.openPrs);
    expect(after.freshness).toBe('stale');
  });

  it('withholds provider polling and marks cached data stale until origin resolution recovers', async () => {
    const api = new FakeApi().set('alpha', { openPrs: 7, openIssues: 3 });
    const h = harness({ names: ['alpha'], api });
    const initial = await h.tracker.refresh();
    const before = row(initial, 'alpha');
    const initialCallCount = h.api.calls.length;
    expect(before.freshness).toBe('fresh');

    h.resolveError = true;
    h.api.set('alpha', { openPrs: 99, openIssues: 101 });
    h.clock.ms += 1;
    const failed = await h.tracker.refresh();
    const stale = row(failed, 'alpha');
    expect(h.api.calls).toHaveLength(initialCallCount);
    expect(stale.link).toBe(before.link);
    expect(stale.openPrs).toBe(before.openPrs);
    expect(stale.openIssues).toBe(before.openIssues);
    expect(stale.checkedAt).toBe(before.checkedAt);
    expect(stale.freshness).toBe('stale');
    expect(stale.error).toContain('origin resolution failed');
    expect(stale.lastAttemptAt).not.toBeNull();

    h.resolveError = false;
    h.clock.ms += 1;
    const recovered = await h.tracker.refresh();
    const current = row(recovered, 'alpha');
    expect(h.api.calls.length).toBeGreaterThan(initialCallCount);
    expect(current.openPrs).toBe(99);
    expect(current.openIssues).toBe(101);
    expect(current.freshness).toBe('fresh');
    expect(current.error).toBeNull();
    expect(current.checkedAt).not.toBe(before.checkedAt);
  });

  it('discloses a global abort on every repository the pass never reached', async () => {
    const api = new FakeApi()
      .set('alpha', {
        errors: { fetchRepo: new GhRateLimitedError('alpha: GitHub rate limit', 'HTTP 403: API rate limit exceeded') },
      })
      .set('beta', { openPrs: 5 })
      .set('gamma', { openPrs: 6 });
    const h = harness({ names: ['alpha', 'beta', 'gamma'], api });
    const view = await h.tracker.refresh();
    expect(row(view, 'alpha').error).toContain('rate limit');
    for (const key of ['beta', 'gamma']) {
      expect(row(view, key).freshness).toBe('unavailable');
      expect(row(view, key).error).toContain('refresh aborted before this repository was checked');
      expect(row(view, key).lastAttemptAt).not.toBeNull();
    }
  });

  it('start() schedules background refreshes, stop() clears them, and start() can resume', async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeApi().set('alpha', { openPrs: 1 });
      const tracker = new ManagedRepoOverviewTracker({
        workspaceRoot: '/ws',
        managedRepos: ['alpha'],
        api,
        scanRepos: () => ['alpha'],
        resolveRepoPath: (_workspaceRoot, name) => ({ kind: 'available', path: `/ws/${name}` }),
        resolveRemote: () => githubRef('alpha'),
        intervalMs: 25,
        now: () => T0,
        sleep: async () => {},
        log: () => {},
      });
      const count = (): number => api.calls.filter((call) => call.startsWith('fetchRepo')).length;
      tracker.start();
      await vi.advanceTimersByTimeAsync(75);
      const running = count();
      expect(running).toBeGreaterThanOrEqual(2);
      tracker.stop();
      await vi.advanceTimersByTimeAsync(75);
      expect(count()).toBe(running);
      tracker.start();
      await vi.advanceTimersByTimeAsync(50);
      expect(count()).toBeGreaterThan(running);
      tracker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders invisible-only names and separator spaces as visible escapes the web validator accepts', async () => {
    const h = harness({ names: ['\u200b'] });
    const view = await h.tracker.refresh();
    expect(isValidSnapshot(validBoardSnapshot(view))).toBe(true);
    const entry = row(view, '\u200b');
    expect(entry.displayName).not.toBe('\u200b');
    expect(entry.displayName.length).toBeGreaterThan(0);
    // A bidi override beside visible text is escaped, so the name cannot
    // spoof its display; combining marks in a visible name survive.
    const leadingMarkName = '\u0301alpha';
    h.names.splice(0, h.names.length, 'repo\u202E', 'caf\u0065\u0301', leadingMarkName);
    h.refs.set('repo\u202E', githubRef('repo-e'));
    h.refs.set('caf\u0065\u0301', githubRef('cafe'));
    h.refs.set(leadingMarkName, githubRef('marked'));
    const second = await h.tracker.refresh();
    expect(isValidSnapshot(validBoardSnapshot(second))).toBe(true);
    expect(row(second, 'repo\u202E').displayName).toBe('repo\\u{202e}');
    expect(row(second, 'caf\u0065\u0301').displayName).toBe('caf\u0065\u0301');
    expect(row(second, leadingMarkName).displayName).toBe('\\u{301}alpha');

    const thinSpaceName = 'alpha\u2009';
    const nbspName = 'alpha\u00a0';
    h.names.splice(0, h.names.length, thinSpaceName, nbspName);
    h.refs.set(thinSpaceName, githubRef('alpha-thin'));
    h.refs.set(nbspName, githubRef('alpha-nbsp'));
    const third = await h.tracker.refresh();
    expect(isValidSnapshot(validBoardSnapshot(third))).toBe(true);
    expect(row(third, thinSpaceName).displayName).toBe('alpha\\u{2009}');
    expect(row(third, nbspName).displayName).toBe('alpha\\u{a0}');
  });

  it('leaves a .github-suffixed host with unsafe characters unlinked instead of freezing the board', async () => {
    const h = harness({
      names: ['alpha'],
      refs: new Map([['alpha', { host: 'foo_bar.github', owner: 'acme', repo: 'alpha' }]]),
    });
    const view = await h.tracker.refresh();
    const entry = row(view, 'alpha');
    expect(entry.linked).toBe(false);
    expect(entry.linkReason).toBe('unrecognized remote');
    expect(isValidSnapshot(validBoardSnapshot(view))).toBe(true);
    expect(h.api.calls).toEqual([]);
  });

  it('does not poll a cached identity when its selected root was skipped by the resolution budget', async () => {
    const h = harness({ names: ['alpha', 'beta', 'gamma'] });
    await h.tracker.refresh();
    expect(row(h.tracker.view(), 'gamma').linked).toBe(true);

    h.api.calls.length = 0;
    h.unavailableNames.add('gamma');
    h.resolveDelayMs = REPO_OVERVIEW_RESOLVE_BUDGET_MS + 10_000;
    const view = await h.tracker.refresh();

    // The resolver budget expires on the first attempted root; gamma is
    // never revalidated and must not be polled using its cached origin.
    expect(row(view, 'gamma').linked).toBe(true);
    expect(h.api.calls.some((call) => call.endsWith(':acme/gamma'))).toBe(false);
  });

  it('keeps every managed repo visible with a read-failure reason when resolution fails', async () => {
    const h = harness({ names: ['alpha', 'beta'] });
    h.resolveError = true;
    const view = await h.tracker.refresh();
    expect(view?.rows.map((entry) => entry.key)).toEqual(['alpha', 'beta']);
    for (const key of ['alpha', 'beta']) {
      const entry = row(view, key);
      expect(entry.linked).toBe(false);
      expect(entry.linkReason).toBe('origin remote could not be read yet');
      expect(entry.openPrs).toBeNull();
      expect(entry.run).toBeNull();
    }
    expect(h.api.calls).toEqual([]);
    expect(isValidSnapshot(validBoardSnapshot(view))).toBe(true);
  });

  it('keeps first-refresh unavailable roots within the board protocol shape', async () => {
    const h = harness({ names: ['alpha'] });
    h.unavailableNames.add('alpha');
    const view = await h.tracker.refresh();
    const entry = row(view, 'alpha');

    expect(entry.linked).toBe(false);
    expect(entry.linkReason).toBe('selected repository is unavailable under workspace_root');
    expect(entry.freshness).toBe('unchecked');
    expect(entry.lastAttemptAt).toBeNull();
    expect(entry.error).toBeNull();
    expect(h.api.calls).toEqual([]);
    expect(isValidSnapshot(validBoardSnapshot(view))).toBe(true);
  });

  it('keeps first-refresh root-probe failures distinct and valid under the board protocol', async () => {
    const h = harness({ names: ['alpha'] });
    h.resolveRootError = true;
    const view = await h.tracker.refresh();
    const entry = row(view, 'alpha');

    expect(entry.linked).toBe(false);
    expect(entry.linkReason).toBe('origin remote could not be read yet');
    expect(entry.freshness).toBe('unchecked');
    expect(entry.lastAttemptAt).toBeNull();
    expect(entry.error).toBeNull();
    expect(h.api.calls).toEqual([]);
    expect(isValidSnapshot(validBoardSnapshot(view))).toBe(true);
  });

  it('bounds the remote-resolution phase by wall clock and keeps prior rows', async () => {
    const h = harness({ names: ['alpha', 'beta', 'gamma'] });
    h.resolveDelayMs = REPO_OVERVIEW_RESOLVE_BUDGET_MS + 10_000;
    const view = await h.tracker.refresh();
    expect(row(view, 'alpha').linked).toBe(true);
    for (const key of ['beta', 'gamma']) {
      expect(row(view, key).linkReason).toBe('origin remote could not be read yet');
    }
    expect(h.failure).toContain('origin-resolution budget');
  });

  it('keeps the async registry scan in exact parity with the sync wizard rule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-parity-'));
    try {
      mkdirSync(join(root, 'plain'));
      mkdirSync(join(root, '.hidden'));
      writeFileSync(join(root, '.hidden', '.git'), '');
      mkdirSync(join(root, 'repo-dir'));
      mkdirSync(join(root, 'repo-dir', '.git'));
      mkdirSync(join(root, 'repo-file'));
      writeFileSync(join(root, 'repo-file', '.git'), 'gitdir: ./work\n');
      mkdirSync(join(root, 'target'));
      mkdirSync(join(root, 'target', '.git'));
      symlinkSync(join(root, 'target'), join(root, 'repo-link'));
      symlinkSync(join(root, 'missing'), join(root, 'broken-link'));
      const expected = ['.hidden', 'repo-dir', 'repo-file', 'repo-link', 'target'];
      expect(discoverManagedRepos(root)).toEqual(expected);
      expect(await discoverManagedReposAsync(root)).toEqual(expected);
      expect(discoverManagedRepos(join(root, 'absent'))).toEqual([]);
      expect(await discoverManagedReposAsync(join(root, 'absent'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps inherited Git routing and command-scope config from selecting an unconfigured origin for provider calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-git-routing-'));
    const selected = join(root, 'selected');
    const foreign = join(root, 'foreign');
    const trustedHome = join(root, 'trusted-home');
    mkdirSync(trustedHome);
    const environmentForTrustedHome = gitProbeEnvironment as unknown as (
      home: string,
    ) => NodeJS.ProcessEnv;
    const trustedEnvironment = environmentForTrustedHome(trustedHome);
    try {
      execFileSync('git', ['init', '-q', selected]);
      execFileSync('git', ['-C', selected, 'remote', 'add', 'origin', 'https://github.com/acme/selected.git']);
      execFileSync('git', ['init', '-q', foreign]);
      execFileSync('git', ['-C', foreign, 'remote', 'add', 'origin', 'https://github.com/acme/foreign.git']);
      const expectSelectedProviderCalls = async (): Promise<void> => {
        expect(repoRemote(selected, 'git', trustedEnvironment)).toEqual({ host: 'github.com', owner: 'acme', repo: 'selected' });
        const api = new FakeApi();
        const tracker = new ManagedRepoOverviewTracker({
          workspaceRoot: root,
          managedRepos: ['selected'],
          api,
          intervalMs: 0,
          resolveRemote: async (path) => {
            const remote = repoRemote(path, 'git', trustedEnvironment);
            return remote === null ? null : { host: remote.host, owner: remote.owner, repo: remote.repo };
          },
        });
        const view = await tracker.refresh();
        expect(row(view, 'selected').fullName).toBe('acme/selected');
        expect(api.calls).toContain('fetchRepo:acme/selected');
        expect(api.calls.some((call) => call.endsWith(':acme/foreign'))).toBe(false);
      };

      vi.stubEnv('GIT_DIR', join(foreign, '.git'));
      vi.stubEnv('GIT_WORK_TREE', selected);
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', 'remote.origin.url');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/acme/foreign.git');
      await expectSelectedProviderCalls();
      vi.unstubAllEnvs();

      vi.stubEnv('GIT_CONFIG_PARAMETERS', "'remote.origin.url'='https://github.com/acme/foreign.git'");
      await expectSelectedProviderCalls();
      vi.unstubAllEnvs();

      vi.stubEnv('git_dir', join(foreign, '.git'));
      vi.stubEnv('git_work_tree', selected);
      vi.stubEnv('git_config_count', '1');
      vi.stubEnv('git_config_key_0', 'remote.origin.url');
      vi.stubEnv('git_config_value_0', 'https://github.com/acme/foreign.git');
      const inheritedGitNames = Object.keys(gitProbeEnvironment()).map((name) => name.toUpperCase());
      expect(inheritedGitNames).not.toContain('GIT_DIR');
      expect(inheritedGitNames).not.toContain('GIT_WORK_TREE');
      expect(inheritedGitNames.some((name) => /^GIT_CONFIG_(?:COUNT|(?:KEY|VALUE)_\d+)$/u.test(name))).toBe(false);
      await expectSelectedProviderCalls();
      vi.unstubAllEnvs();

      const homeRoot = join(root, 'home');
      mkdirSync(homeRoot);
      execFileSync('git', ['config', '--file', join(homeRoot, '.gitconfig'), 'url.https://github.com/acme/foreign.git.insteadOf', 'https://github.com/acme/selected.git']);
      const redirectedHome = execFileSync('git', ['-C', selected, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8', env: { ...process.env, HOME: homeRoot },
      }).trim();
      expect(redirectedHome).toBe('https://github.com/acme/foreign.git');
      vi.stubEnv('HOME', homeRoot);
      expect(gitProbeEnvironment()).toHaveProperty('HOME', userInfo().homedir);
      await expectSelectedProviderCalls();
      vi.unstubAllEnvs();

      const rewriteConfig = join(root, 'rewrite.gitconfig');
      execFileSync('git', ['config', '--file', rewriteConfig, 'url.https://github.com/acme/foreign.git.insteadOf', 'https://github.com/acme/selected.git']);
      for (const variable of ['GIT_CONFIG_GLOBAL'] as const) {
        const redirected = execFileSync('git', ['-C', selected, 'remote', 'get-url', 'origin'], {
          encoding: 'utf8', env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', [variable]: rewriteConfig },
        }).trim();
        expect(redirected).toBe('https://github.com/acme/foreign.git');
        vi.stubEnv('HOME', root);
        vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
        vi.stubEnv(variable, rewriteConfig);
        await expectSelectedProviderCalls();
        vi.unstubAllEnvs();
      }

      const xdgConfigRoot = join(root, 'xdg');
      mkdirSync(join(xdgConfigRoot, 'git'), { recursive: true });
      const xdgConfig = join(xdgConfigRoot, 'git', 'config');
      execFileSync('git', ['config', '--file', xdgConfig, 'url.https://github.com/acme/foreign.git.insteadOf', 'https://github.com/acme/selected.git']);
      const redirectedXdg = execFileSync('git', ['-C', selected, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8', env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: xdgConfigRoot },
      }).trim();
      expect(redirectedXdg).toBe('https://github.com/acme/foreign.git');
      vi.stubEnv('HOME', root);
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      vi.stubEnv('XDG_CONFIG_HOME', xdgConfigRoot);
      await expectSelectedProviderCalls();
      vi.unstubAllEnvs();

      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      expect(gitProbeEnvironment()).not.toHaveProperty('GIT_CONFIG_NOSYSTEM');
      vi.unstubAllEnvs();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects (never nulls) when the production resolver cannot spawn git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-path-'));
    const emptyPath = mkdtempSync(join(tmpdir(), 'gru-repo-overview-emptypath-'));
    const savedPath = process.env.PATH;
    try {
      execFileSync('git', ['init', '-q', join(root, 'alpha')]);
      execFileSync('git', ['-C', join(root, 'alpha'), 'remote', 'add', 'origin', 'https://github.com/acme/alpha.git']);
      process.env.PATH = emptyPath;
      await expect(defaultRemoteResolver(join(root, 'alpha'))).rejects.toBeInstanceOf(Error);
    } finally {
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  it('preserves trusted global Git config while replacing inherited home and config overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-trusted-git-home-'));
    const workspace = join(root, 'workspace');
    const trustedHome = join(root, 'account-home');
    const inheritedHome = join(root, 'inherited-home');
    const selected = join(workspace, 'selected');
    try {
      mkdirSync(workspace);
      mkdirSync(trustedHome);
      mkdirSync(inheritedHome);
      execFileSync('git', ['init', '-q', selected]);
      execFileSync('git', ['-C', selected, 'remote', 'add', 'origin', 'https://github.com/acme/selected.git']);
      const globalConfig = join(trustedHome, '.gitconfig');
      execFileSync('git', ['config', '--file', globalConfig, 'safe.directory', selected]);
      execFileSync('git', [
        'config', '--file', globalConfig,
        'url.https://github.com/acme/rewritten.git.insteadOf',
        'https://github.com/acme/selected.git',
      ]);

      vi.stubEnv('HOME', inheritedHome);
      vi.stubEnv('XDG_CONFIG_HOME', join(inheritedHome, 'xdg'));
      vi.stubEnv('GIT_CONFIG_GLOBAL', join(inheritedHome, 'foreign.gitconfig'));
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1');
      vi.stubEnv('LANG', 'fr_FR.UTF-8');
      vi.stubEnv('LC_ALL', 'fr_FR.UTF-8');
      const environmentForTrustedHome = gitProbeEnvironment as unknown as (
        home: string,
      ) => NodeJS.ProcessEnv;
      const env = environmentForTrustedHome(trustedHome);
      expect(env.HOME).toBe(trustedHome);
      const invalidRepo = join(workspace, 'invalid-marker');
      mkdirSync(invalidRepo);
      writeFileSync(join(invalidRepo, '.git'), 'not-a-gitdir\n');
      const invalidRepoResolution = resolveManagedRepoPathSync(workspace, 'invalid-marker');
      expect({ locale: env.LC_ALL, invalidRepoKind: invalidRepoResolution.kind }).toEqual({
        locale: 'C',
        invalidRepoKind: 'unavailable',
      });
      expect(env).not.toHaveProperty('XDG_CONFIG_HOME');
      expect(env).not.toHaveProperty('GIT_CONFIG_GLOBAL');
      expect(env).not.toHaveProperty('GIT_CONFIG_NOSYSTEM');
      expect(env.GIT_TEST_ASSUME_DIFFERENT_OWNER).toBe('1');

      const validatedRoot = execFileSync('git', ['-C', selected, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8', env,
      }).trim();
      expect(validatedRoot).toBe(realpathSync(selected));
      const rewritten = execFileSync('git', ['-C', selected, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8', env,
      }).trim();
      expect(rewritten).toBe('https://github.com/acme/rewritten.git');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains cached overview as stale when a previously valid .git directory becomes unreadable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-git-permission-'));
    const repo = join(root, 'alpha');
    const gitDir = join(repo, '.git');
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/alpha.git']);
      const api = new FakeApi().set('alpha', { openPrs: 4, openIssues: 2 });
      const clock = { ms: T0 };
      const tracker = new ManagedRepoOverviewTracker({
        workspaceRoot: root,
        managedRepos: ['alpha'],
        api,
        now: () => clock.ms,
        sleep: async () => {},
        intervalMs: 300_000,
      });

      const initial = row(await tracker.refresh(), 'alpha');
      expect(initial).toMatchObject({ linked: true, freshness: 'fresh', openPrs: 4, openIssues: 2 });
      const callsBeforeFailure = api.calls.length;

      chmodSync(gitDir, 0);
      expect(resolveManagedRepoPathSync(root, 'alpha')).toMatchObject({ kind: 'error' });
      clock.ms += 1;
      const unreadable = row(await tracker.refresh(), 'alpha');
      expect(unreadable).toMatchObject({ linked: true, freshness: 'stale', openPrs: 4, openIssues: 2 });
      expect(unreadable.error).toMatch(/EACCES|permission denied/iu);
      expect(api.calls).toHaveLength(callsBeforeFailure);

      chmodSync(gitDir, 0o755);
      clock.ms += 1;
      const recovered = row(await tracker.refresh(), 'alpha');
      expect(recovered).toMatchObject({ linked: true, freshness: 'fresh', openPrs: 4, openIssues: 2 });
      expect(api.calls.length).toBeGreaterThan(callsBeforeFailure);
    } finally {
      if (existsSync(gitDir)) chmodSync(gitDir, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains cached overview when a linked-worktree gitdir becomes unreadable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-worktree-permission-'));
    const seed = join(root, 'seed');
    const repo = join(root, 'alpha');
    let gitDirPath = '';
    try {
      execFileSync('git', ['init', '-q', seed]);
      execFileSync('git', [
        '-C', seed, '-c', 'user.name=Test User', '-c', 'user.email=test@example.invalid',
        'commit', '--allow-empty', '-m', 'initial',
      ]);
      execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', 'https://github.com/acme/alpha.git']);
      execFileSync('git', ['-C', seed, 'worktree', 'add', '--detach', repo, 'HEAD']);
      gitDirPath = execFileSync(
        'git',
        ['-C', repo, 'rev-parse', '--absolute-git-dir'],
        { encoding: 'utf8' },
      ).trim();

      const api = new FakeApi().set('alpha', { openPrs: 7, openIssues: 3 });
      const clock = { ms: T0 };
      const tracker = new ManagedRepoOverviewTracker({
        workspaceRoot: root,
        managedRepos: ['alpha'],
        api,
        now: () => clock.ms,
        sleep: async () => {},
        intervalMs: 300_000,
      });

      const initial = row(await tracker.refresh(), 'alpha');
      expect(initial).toMatchObject({ linked: true, freshness: 'fresh', openPrs: 7, openIssues: 3 });
      const callsBeforeFailure = api.calls.length;

      chmodSync(gitDirPath, 0);
      expect(resolveManagedRepoPathSync(root, 'alpha')).toMatchObject({ kind: 'error' });
      clock.ms += 1;
      const unreadable = row(await tracker.refresh(), 'alpha');
      expect(unreadable).toMatchObject({
        linked: true,
        freshness: 'stale',
        openPrs: 7,
        openIssues: 3,
      });
      expect(unreadable.error).toMatch(/EACCES|permission denied/iu);
      expect(api.calls).toHaveLength(callsBeforeFailure);

      chmodSync(gitDirPath, 0o755);
      clock.ms += 1;
      const recovered = row(await tracker.refresh(), 'alpha');
      expect(recovered).toMatchObject({ linked: true, freshness: 'fresh', openPrs: 7, openIssues: 3 });
      expect(api.calls.length).toBeGreaterThan(callsBeforeFailure);
    } finally {
      if (gitDirPath !== '' && existsSync(gitDirPath)) chmodSync(gitDirPath, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies Git root-probe spawn failures as read errors, not confirmed unavailable roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-root-spawn-'));
    const emptyPath = mkdtempSync(join(tmpdir(), 'gru-repo-overview-root-empty-path-'));
    const workspace = join(root, 'workspace');
    const repo = join(workspace, 'alpha');
    const savedPath = process.env.PATH;
    try {
      mkdirSync(workspace);
      execFileSync('git', ['init', '-q', repo]);
      process.env.PATH = emptyPath;
      await expect(resolveManagedRepoPath(workspace, 'alpha')).resolves.toMatchObject({ kind: 'error' });
      expect(resolveManagedRepoPathSync(workspace, 'alpha')).toMatchObject({ kind: 'error' });
    } finally {
      process.env.PATH = savedPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  it('classifies Git root-probe timeouts as read errors rather than unavailable roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-root-timeout-'));
    const fakeBin = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const repo = join(workspace, 'alpha');
    mkdirSync(fakeBin);
    mkdirSync(workspace);
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(fakeBin, 'git'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o755 });
    try {
      vi.stubEnv('PATH', fakeBin);
      await expect(resolveManagedRepoPath(workspace, 'alpha')).resolves.toMatchObject({ kind: 'error' });
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds stalled managed-root validation and resumes on a later refresh', async () => {
    vi.useFakeTimers();
    const api = new FakeApi();
    const clock = { ms: T0 };
    const rootAttempts: string[] = [];
    let alphaStalls = true;
    const tracker = new ManagedRepoOverviewTracker({
      workspaceRoot: '/ws',
      managedRepos: ['alpha', 'beta'],
      api,
      intervalMs: 0,
      now: () => clock.ms,
      sleep: async () => {},
      resolveRepoPath: (_workspaceRoot, name) => {
        rootAttempts.push(name);
        return name === 'alpha' && alphaStalls
          ? new Promise(() => {})
          : { kind: 'available', path: `/ws/${name}` };
      },
      resolveRemote: async (path) => githubRef(path.split('/').at(-1) as string),
    });
    try {
      const completes = tracker.refresh().then((view) => ({ kind: 'completed' as const, view }));
      const guard = new Promise<{ kind: 'guard' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'guard' }), REPO_OVERVIEW_RESOLVE_BUDGET_MS * 2);
      });
      const outcomePromise = Promise.race([completes, guard]);
      await vi.advanceTimersByTimeAsync(REPO_OVERVIEW_RESOLVE_BUDGET_MS * 2);
      const outcome = await outcomePromise;
      expect(outcome.kind).toBe('completed');
      if (outcome.kind !== 'completed') return;
      const alpha = row(outcome.view, 'alpha');
      expect(alpha.linked).toBe(false);
      expect(alpha.linkReason).toBe('origin remote could not be read yet');
      expect(alpha.freshness).toBe('unchecked');
      expect(alpha.checkedAt).toBeNull();
      expect(alpha.lastAttemptAt).toBeNull();
      expect(alpha.error).toBeNull();
      expect(isValidSnapshot(validBoardSnapshot(outcome.view))).toBe(true);
      expect(api.calls).toHaveLength(0);

      alphaStalls = false;
      const recovered = await tracker.refresh();
      expect(rootAttempts.slice(1, 3)).toEqual(['beta', 'alpha']);
      expect(row(recovered, 'alpha').linked).toBe(true);
      expect(row(recovered, 'beta').linked).toBe(true);
      expect(api.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains cached data as stale while managed-root validation stalls and recovers later', async () => {
    vi.useFakeTimers();
    const api = new FakeApi().set('alpha', { openPrs: 7, openIssues: 3 });
    const clock = { ms: T0 };
    const rootAttempts: string[] = [];
    let alphaStalls = false;
    const tracker = new ManagedRepoOverviewTracker({
      workspaceRoot: '/ws',
      managedRepos: ['alpha'],
      api,
      intervalMs: 0,
      now: () => clock.ms,
      sleep: async () => {},
      resolveRepoPath: (_workspaceRoot, name) => {
        rootAttempts.push(name);
        return name === 'alpha' && alphaStalls
          ? new Promise(() => {})
          : { kind: 'available', path: `/ws/${name}` };
      },
      resolveRemote: async (path) => githubRef(path.split('/').at(-1) as string),
    });
    try {
      const initial = await tracker.refresh();
      const initialAlpha = row(initial, 'alpha');
      expect(initialAlpha.linked).toBe(true);
      expect(initialAlpha.openPrs).toBe(7);
      expect(initialAlpha.openIssues).toBe(3);
      expect(initialAlpha.run).not.toBeNull();
      expect(initialAlpha.checkedAt).not.toBeNull();
      const callsAfterInitial = api.calls.length;
      expect(callsAfterInitial).toBeGreaterThan(0);

      alphaStalls = true;
      const completes = tracker.refresh().then((view) => ({ kind: 'completed' as const, view }));
      const guard = new Promise<{ kind: 'guard' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'guard' }), REPO_OVERVIEW_RESOLVE_BUDGET_MS * 4);
      });
      const outcomePromise = Promise.race([completes, guard]);
      await vi.advanceTimersByTimeAsync(REPO_OVERVIEW_RESOLVE_BUDGET_MS * 5);
      const outcome = await outcomePromise;
      expect(outcome.kind).toBe('completed');
      if (outcome.kind !== 'completed') return;

      const stalledAlpha = row(outcome.view, 'alpha');
      expect(stalledAlpha.linked).toBe(true);
      expect(stalledAlpha.freshness).toBe('stale');
      expect(stalledAlpha.openPrs).toBe(initialAlpha.openPrs);
      expect(stalledAlpha.openIssues).toBe(initialAlpha.openIssues);
      expect(stalledAlpha.run).toEqual(initialAlpha.run);
      expect(stalledAlpha.checkedAt).toBe(initialAlpha.checkedAt);
      expect(stalledAlpha.lastAttemptAt).not.toBeNull();
      expect(stalledAlpha.error).toContain('root validation exceeded the origin-resolution budget');
      expect(api.calls).toHaveLength(callsAfterInitial);
      expect(isValidSnapshot(validBoardSnapshot(outcome.view))).toBe(true);

      alphaStalls = false;
      clock.ms += 1;
      const recovered = await tracker.refresh();
      expect(rootAttempts).toEqual(['alpha', 'alpha', 'alpha']);
      expect(row(recovered, 'alpha').linked).toBe(true);
      expect(row(recovered, 'alpha').freshness).toBe('fresh');
      expect(row(recovered, 'alpha').error).toBeNull();
      expect(api.calls.length).toBeGreaterThan(callsAfterInitial);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coordinates root validation and provider cursors so joint budgets eventually observe every selected root', async () => {
    const names = Array.from({ length: 60 }, (_value, index) => `repo-${String(index).padStart(2, '0')}`);
    const api = new FakeApi();
    const clock = { ms: T0 };
    const validatedThisRefresh = new Set<string>();
    const tracker = new ManagedRepoOverviewTracker({
      workspaceRoot: '/ws',
      managedRepos: names,
      api,
      intervalMs: 0,
      maxCallsPerRefresh: 100,
      now: () => clock.ms,
      sleep: async () => {},
      resolveRepoPath: (_workspaceRoot, name) => ({ kind: 'available', path: `/ws/${name}` }),
      resolveRemote: async (path) => {
        const name = path.split('/').at(-1) as string;
        validatedThisRefresh.add(name);
        clock.ms += 2_001;
        return githubRef(name);
      },
    });
    const providerObserved = new Set<string>();
    for (let pass = 0; pass < 10 && providerObserved.size < names.length; pass += 1) {
      validatedThisRefresh.clear();
      const before = api.calls.length;
      await tracker.refresh();
      const calls = api.calls.slice(before);
      for (const call of calls) {
        const fullName = call.slice(call.indexOf(':') + 1);
        const name = fullName.split('/').at(-1) as string;
        expect(validatedThisRefresh.has(name), `${call} had no same-pass validated root`).toBe(true);
        if (call.startsWith('fetchRepo:')) providerObserved.add(name);
      }
    }
    expect([...providerObserved].sort()).toEqual(names);
  });

  it('rotates the classification start when the resolution budget cuts a pass short', async () => {
    const h = harness({ names: ['alpha', 'beta', 'gamma'] });
    h.resolveDelayMs = REPO_OVERVIEW_RESOLVE_BUDGET_MS + 10_000;
    const first = await h.tracker.refresh();
    expect(row(first, 'alpha').linked).toBe(true);
    expect(row(first, 'beta').linkReason).toBe('origin remote could not be read yet');
    expect(row(first, 'gamma').linkReason).toBe('origin remote could not be read yet');

    const second = await h.tracker.refresh();
    expect(row(second, 'beta').linked).toBe(true);
    expect(row(second, 'alpha').linked).toBe(true);
    expect(row(second, 'gamma').linkReason).toBe('origin remote could not be read yet');

    const third = await h.tracker.refresh();
    expect(row(third, 'gamma').linked).toBe(true);
    expect(row(third, 'alpha').linked).toBe(true);
    expect(row(third, 'beta').linked).toBe(true);
  });

  it('rotates the classification start when leading resolutions fail slowly', async () => {
    const api = new FakeApi().set('alpha', {}).set('beta', {}).set('gamma', {});
    const clock = { ms: T0 };
    const attempted: string[] = [];
    const tracker = new ManagedRepoOverviewTracker({
      workspaceRoot: '/ws',
      managedRepos: ['alpha', 'beta', 'gamma'],
      api,
      scanRepos: () => ['alpha', 'beta', 'gamma'],
      resolveRepoPath: (_workspaceRoot, name) => ({ kind: 'available', path: `/ws/${name}` }),
      resolveRemote: async (repoPath) => {
        attempted.push(repoPath.split('/').pop() as string);
        clock.ms += REPO_OVERVIEW_RESOLVE_BUDGET_MS + 1;
        throw new Error('git hung');
      },
      now: () => clock.ms,
      sleep: async () => {},
      log: () => {},
    });
    await tracker.refresh();
    await tracker.refresh();
    // Failures count as attempts: the second pass starts at beta instead
    // of re-burning the budget on the same failing entry forever.
    expect(attempted).toEqual(['alpha', 'beta']);
    expect(row(tracker.view(), 'gamma').linkReason).toBe('origin remote could not be read yet');
  });

  it('never lets one stalled observation run past the fetch wall-clock budget', async () => {
    const h = harness({ names: ['alpha', 'beta'] });
    const original = h.api.fetchRepo.bind(h.api);
    // The first call of the observation burns the whole pass budget; the
    // per-call deadline then aborts the partial observation — nothing is
    // recorded and the pass defers instead of stretching the cadence.
    h.api.fetchRepo = async (input) => {
      const result = await original(input);
      h.clock.ms += REPO_OVERVIEW_FETCH_BUDGET_MS + 1;
      return result;
    };
    const view = await h.tracker.refresh();
    expect(row(view, 'alpha').freshness).toBe('unchecked');
    expect(row(view, 'alpha').lastAttemptAt).toBeNull();
    expect(row(view, 'beta').lastAttemptAt).toBeNull();
    expect(h.failure).toContain('fetch wall-clock budget');
  });

  it('defers the remainder when the wall-clock budget is spent between completed observations', async () => {
    const h = harness({ names: ['alpha', 'beta'] });
    const original = h.api.latestRuns.bind(h.api);
    h.api.latestRuns = async (input) => {
      const result = await original(input);
      h.clock.ms += REPO_OVERVIEW_FETCH_BUDGET_MS + 1;
      return result;
    };
    const view = await h.tracker.refresh();
    expect(row(view, 'alpha').freshness).toBe('fresh');
    expect(row(view, 'beta').freshness).toBe('unchecked');
    expect(h.failure).toContain('fetch wall-clock budget');
  });

  it('keeps the documented freshness window when the timer is disabled', async () => {
    const api = new FakeApi().set('alpha', { openPrs: 1 });
    const clock = { ms: T0 };
    const tracker = new ManagedRepoOverviewTracker({
      workspaceRoot: '/ws',
      managedRepos: ['alpha'],
      api,
      scanRepos: () => ['alpha'],
      resolveRepoPath: (_workspaceRoot, name) => ({ kind: 'available', path: `/ws/${name}` }),
      resolveRemote: () => githubRef('alpha'),
      intervalMs: 0,
      now: () => clock.ms,
      sleep: async () => {},
      log: () => {},
    });
    await tracker.refresh();
    clock.ms += 1_000;
    expect(row(tracker.view(), 'alpha').freshness).toBe('fresh');
  });

  it('never emits an empty error disclosure that would fail the web validator', async () => {
    const api = new FakeApi().set('alpha', { errors: { fetchRepo: new Error('') } });
    const h = harness({ api });
    const view = await h.tracker.refresh();
    const entry = row(view, 'alpha');
    expect(entry.error).not.toBe('');
    expect(entry.error).not.toBeNull();
    expect(isValidSnapshot(validBoardSnapshot(view))).toBe(true);
  });

  it('never turns a backward clock step into an unbounded pacing sleep', async () => {
    const h = harness({ names: ['alpha', 'beta'] });
    const original = h.api.countOpenPulls.bind(h.api);
    let steppedBack = false;
    h.api.countOpenPulls = async (input) => {
      const result = await original(input);
      if (!steppedBack) {
        steppedBack = true;
        h.clock.ms -= 3_600_000;
      }
      return result;
    };
    await h.tracker.refresh();
    expect(steppedBack).toBe(true);
    expect(h.sleeps.every((ms) => ms <= 2000)).toBe(true);
    expect(row(h.tracker.view(), 'beta').freshness).toBe('fresh');
  });

  it('paces searches even when the clock epoch starts at zero', async () => {
    const api = new FakeApi().set('alpha', {}).set('beta', {});
    const sleeps: number[] = [];
    const tracker = new ManagedRepoOverviewTracker({
      workspaceRoot: '/ws',
      managedRepos: ['alpha', 'beta'],
      api,
      scanRepos: () => ['alpha', 'beta'],
      resolveRepoPath: (_workspaceRoot, name) => ({ kind: 'available', path: `/ws/${name}` }),
      resolveRemote: (repoPath) => githubRef(repoPath.split('/').pop() as string),
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: () => {},
    });
    await tracker.refresh();
    expect(api.calls.filter((call) => call.startsWith('countOpenPulls')).length).toBe(2);
    expect(api.calls.filter((call) => call.startsWith('countOpenIssues')).length).toBe(2);
    // First search is free, the remaining three are paced: a `0` sentinel
    // would silently disable pacing on an epoch-0 clock.
    expect(sleeps).toEqual([2000, 2000, 2000]);
  });

  it('defers when the pacing sleep itself crosses the fetch wall-clock budget', async () => {
    const h = harness({ names: ['alpha', 'beta'] });
    const start = h.clock.ms;
    const original = h.api.fetchRepo.bind(h.api);
    h.api.fetchRepo = async (input) => {
      const result = await original(input);
      if (input.repo.repo === 'beta') h.clock.ms = start + REPO_OVERVIEW_FETCH_BUDGET_MS - 500;
      return result;
    };
    const view = await h.tracker.refresh();
    expect(row(view, 'alpha').freshness).toBe('fresh');
    expect(row(view, 'beta').lastAttemptAt).toBeNull();
    expect(h.failure).toContain('fetch wall-clock budget');
    // Discriminator: the search whose pacing sleep crossed the deadline is
    // WITHHELD — beta stops after its countOpenPulls call, and the
    // countOpenIssues call that a pre-fix build issues post-deadline never
    // goes out.
    expect(h.api.calls.filter((call) => call.endsWith('acme/beta'))).toEqual([
      'fetchRepo:acme/beta',
      'countOpenPulls:acme/beta',
    ]);
    // The deferred call also did NOT consume a budget unit: `calls` is the
    // exact provider-call record (alpha 5 + beta fetch + beta pull = 7; a
    // phantom-unit build books 8).
    expect(h.failureFields?.calls).toBe(7);
  });

  it('fast-fails an already-crossed fetch deadline before any pacing wait', async () => {
    const h = harness({ names: ['alpha', 'beta'] });
    const start = h.clock.ms;
    const originalFetch = h.api.fetchRepo.bind(h.api);
    const originalPulls = h.api.countOpenPulls.bind(h.api);
    h.api.fetchRepo = async (input) => {
      const result = await originalFetch(input);
      // Park beta's first search 500 ms before the deadline so its entry
      // check passes.
      if (input.repo.repo === 'beta') h.clock.ms = start + REPO_OVERVIEW_FETCH_BUDGET_MS - 500;
      return result;
    };
    h.api.countOpenPulls = async (input) => {
      const result = await originalPulls(input);
      // ...then let that call finish just PAST the deadline: the next
      // search enters with a crossed deadline AND is pacing-eligible
      // (600 ms after the previous search's issue, so a post-wait-only
      // build would sleep the remaining ~1.4 s).
      if (input.repo.repo === 'beta') h.clock.ms = start + REPO_OVERVIEW_FETCH_BUDGET_MS + 100;
      return result;
    };
    const view = await h.tracker.refresh();
    // Alpha's observation is intact (the jump only makes it age-stale).
    expect(row(view, 'alpha').checkedAt).not.toBeNull();
    // beta: fetch and its first search go out, the second is refused.
    expect(h.api.calls.filter((call) => call.endsWith('acme/beta'))).toEqual([
      'fetchRepo:acme/beta',
      'countOpenPulls:acme/beta',
    ]);
    // Exactly one pacing wait happened — alpha's second search. A build
    // that only checks the deadline after pacing would add a ~1.4 s wait
    // for beta's refused call (elapsed 600 ms).
    expect(h.sleeps.length).toBe(1);
    expect(h.failure).toContain('fetch wall-clock budget');
  });

  it('withholds a search call when the per-refresh call budget is already exhausted', async () => {
    const api = new FakeApi().set('alpha', {}).set('beta', {});
    const h = harness({ names: ['alpha', 'beta'], api, maxCallsPerRefresh: 7 });
    const view = await h.tracker.refresh();
    expect(row(view, 'alpha').freshness).toBe('fresh');
    expect(row(view, 'beta').lastAttemptAt).toBeNull();
    // alpha 5 + beta fetch + beta pull = 7; the next search is refused
    // BEFORE it goes out (a guard-less build records the extra call).
    expect(h.api.calls.filter((call) => call.endsWith('acme/beta'))).toEqual([
      'fetchRepo:acme/beta',
      'countOpenPulls:acme/beta',
    ]);
    expect(h.failure).toContain('budget exhausted');
    // The exact unit count is an exact provider-call record: 5 (alpha) +
    // 2 (beta) = 7; a guard-less or phantom-unit build books 8.
    expect(h.failureFields?.calls).toBe(7);

    // The discarded beta observation resumes FIRST on the next pass rather
    // than waiting behind alpha for a full rotation.
    h.api.calls.length = 0;
    const second = await h.tracker.refresh();
    expect(h.api.calls[0]).toBe('fetchRepo:acme/beta');
    expect(row(second, 'beta').freshness).toBe('fresh');
  });

  it('queries the port for the branch it discovered, including after a default-branch move', async () => {
    const api = new FakeApi().set('alpha', {
      defaultBranch: 'main',
      workflows: { kind: 'ok', value: 1 },
      runs: { kind: 'ok', value: [rawRun({ name: 'CI' })] },
    });
    const h = harness({ names: ['alpha'], api });
    await h.tracker.refresh();
    expect(api.runQueries).toEqual([{ repo: 'acme/alpha', branch: 'main', limit: REPO_OVERVIEW_RUNS_PER_FETCH }]);

    api.set('alpha', {
      defaultBranch: 'trunk',
      workflows: { kind: 'ok', value: 1 },
      runs: { kind: 'ok', value: [rawRun({ name: 'CI', id: 22, url: 'https://github.com/acme/alpha/actions/runs/22' })] },
    });
    const moved = await h.tracker.refresh();
    expect(api.runQueries.at(-1)).toEqual({ repo: 'acme/alpha', branch: 'trunk', limit: REPO_OVERVIEW_RUNS_PER_FETCH });
    expect(row(moved, 'alpha').run?.branch).toBe('trunk');
    expect(row(moved, 'alpha').run?.url).toContain('/runs/22');
  });

  it('selects the newest run at the tracker call site even from an out-of-order page', async () => {
    const older = rawRun({
      id: 3,
      status: 'completed',
      conclusion: 'failure',
      createdAt: '2026-10-07T09:00:00.000Z',
      url: 'https://github.com/acme/alpha/actions/runs/3',
    });
    const newer = rawRun({
      id: 9,
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-10-07T11:00:00.000Z',
      url: 'https://github.com/acme/alpha/actions/runs/9',
    });
    // Provider page ascending: the tracker must not trust page order.
    const api = new FakeApi().set('alpha', { workflows: { kind: 'ok', value: 1 }, runs: { kind: 'ok', value: [older, newer] } });
    const h = harness({ names: ['alpha'], api });
    const entry = row(await h.tracker.refresh(), 'alpha');
    expect(entry.run?.state).toBe('passed');
    expect(entry.run?.url).toContain('/runs/9');
  });
});

describe('managed repo overview tracker — run timestamp semantics', () => {
  it('selects by actual creation through the real adapter and tracker (a delayed older run never displaces a newer queued run)', async () => {
    const olderDelayedStart = {
      id: 1,
      name: 'CI',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/acme/alpha/actions/runs/1',
      run_number: 1,
      created_at: '2026-10-07T10:00:00.000Z',
      run_started_at: '2026-10-07T12:00:00.000Z',
      updated_at: '2026-10-07T12:10:00.000Z',
    };
    const newerQueued = {
      id: 2,
      name: 'CI',
      status: 'queued',
      conclusion: null,
      html_url: 'https://github.com/acme/alpha/actions/runs/2',
      run_number: 2,
      created_at: '2026-10-07T11:00:00.000Z',
      run_started_at: null,
      updated_at: '2026-10-07T11:00:00.000Z',
    };
    const runner: GhCommandRunner = async (args) => {
      const path = args[3] ?? '';
      if (path === 'repos/acme/alpha') {
        return { status: 0, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' };
      }
      if (path.startsWith('search/issues')) {
        return { status: 0, stdout: JSON.stringify({ total_count: 0, incomplete_results: false }), stderr: '' };
      }
      if (path.startsWith('repos/acme/alpha/actions/workflows')) {
        return { status: 0, stdout: JSON.stringify({ total_count: 1 }), stderr: '' };
      }
      if (path.startsWith('repos/acme/alpha/actions/runs')) {
        return { status: 0, stdout: JSON.stringify({ workflow_runs: [olderDelayedStart, newerQueued] }), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected path ${path}` };
    };
    const adapter = new GhRepoOverviewApi(runner);

    // Adapter level: creation and start are distinct, never conflated.
    const runs = await adapter.latestRuns({ repo: githubRef('alpha'), branch: 'main', limit: 3 });
    if (runs.kind !== 'ok') throw new Error('expected ok');
    expect(runs.value[0]).toMatchObject({
      createdAt: '2026-10-07T10:00:00.000Z',
      startedAt: '2026-10-07T12:00:00.000Z',
    });
    expect(runs.value[1]).toMatchObject({
      createdAt: '2026-10-07T11:00:00.000Z',
      startedAt: null,
    });

    // Tracker level: the NEWER-CREATED queued run wins even though the
    // older run has the later start time (never PASSED in its place).
    const tracker = new ManagedRepoOverviewTracker({
      workspaceRoot: '/ws',
      managedRepos: ['alpha'],
      api: adapter,
      scanRepos: () => ['alpha'],
      resolveRepoPath: (_workspaceRoot, name) => ({ kind: 'available', path: `/ws/${name}` }),
      resolveRemote: () => githubRef('alpha'),
      now: () => T0,
      sleep: async () => {},
      log: () => {},
    });
    const entry = row(await tracker.refresh(), 'alpha');
    expect(entry.run?.state).toBe('queued');
    expect(entry.run?.runCreatedAt).toBe('2026-10-07T11:00:00.000Z');
    expect(entry.run?.runStartedAt).toBeNull();
    expect(isValidSnapshot(validBoardSnapshot(tracker.view()))).toBe(true);
  });
});

describe('managed repo overview tracker — default-branch CI hook (#446)', () => {
  it('reads 20 runs in the one runs call, through the real adapter', async () => {
    expect(REPO_OVERVIEW_RUNS_PER_FETCH).toBe(20);
    const paths: string[] = [];
    const runner: GhCommandRunner = async (args) => {
      const path = args[3] ?? '';
      paths.push(path);
      if (path === 'repos/acme/alpha') return ok(JSON.stringify({ default_branch: 'develop' }));
      if (path.startsWith('search/issues')) return ok(JSON.stringify({ total_count: 0, incomplete_results: false }));
      if (path.startsWith('repos/acme/alpha/actions/workflows')) return ok(JSON.stringify({ total_count: 2 }));
      if (path.startsWith('repos/acme/alpha/actions/runs')) return ok(JSON.stringify({ workflow_runs: [] }));
      return { status: 1, stdout: '', stderr: `unexpected path ${path}` };
    };
    const seen: DefaultBranchRunsObservation[] = [];
    const tracker = new ManagedRepoOverviewTracker({
      workspaceRoot: '/ws',
      managedRepos: ['alpha'],
      api: new GhRepoOverviewApi(runner),
      scanRepos: () => ['alpha'],
      resolveRepoPath: (_workspaceRoot, name) => ({ kind: 'available', path: `/ws/${name}` }),
      resolveRemote: () => githubRef('alpha'),
      now: () => T0,
      sleep: async () => {},
      onDefaultBranchRuns: (observation) => seen.push(observation),
    });
    await tracker.refresh();
    // The same five calls as before: the alert costs no extra GitHub call.
    expect(paths).toHaveLength(5);
    expect(paths.filter((path) => path.includes('/actions/runs'))).toEqual(['repos/acme/alpha/actions/runs?branch=develop&per_page=20']);
    expect(seen).toEqual([{ repo: githubRef('alpha'), branch: 'develop', runs: [] }]);
  });

  it('hands the committed observation run page to the hook after the row is recorded; the chip keeps the newest run overall', async () => {
    const page = [
      rawRun({ id: 9, conclusion: 'failure', createdAt: '2026-10-07T10:00:00.000Z' }),
      rawRun({ id: 10, status: 'queued', conclusion: null, createdAt: '2026-10-07T11:00:00.000Z', workflowId: 202 }),
    ];
    const api = new FakeApi().set('alpha', { defaultBranch: 'develop', runs: { kind: 'ok', value: page } });
    const seen: { observation: DefaultBranchRunsObservation; row: RepoOverviewRowView }[] = [];
    const h: Harness = harness({
      api,
      onDefaultBranchRuns: (observation) => seen.push({ observation, row: row(h.tracker.view(), 'alpha') }),
    });
    await h.tracker.refresh();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.observation).toEqual({ repo: githubRef('alpha'), branch: 'develop', runs: page });
    // Called after the commit: the row it sees is already this observation.
    expect(seen[0]?.row).toMatchObject({ freshness: 'fresh', error: null, run: { state: 'queued' } });
    expect(row(h.tracker.view(), 'alpha').run?.state).toBe('queued');
  });

  it('never calls the hook for a failed observation or one without a run page', async () => {
    const cases: readonly FakeFacts[] = [
      { errors: { latestRuns: new GhApiError('runs acme/alpha@main: response carries a malformed workflow_runs entry') } },
      { errors: { countOpenIssues: new GhApiError('search: incomplete_results') } },
      { defaultBranch: null },
      { workflows: { kind: 'ok', value: 0 } },
      { workflows: { kind: 'actions-unavailable' } },
      { runs: { kind: 'actions-unavailable' } },
    ];
    for (const facts of cases) {
      const seen: DefaultBranchRunsObservation[] = [];
      const h = harness({ api: new FakeApi().set('alpha', facts), onDefaultBranchRuns: (observation) => seen.push(observation) });
      await h.tracker.refresh();
      expect(seen, JSON.stringify(facts)).toEqual([]);
    }
  });

  it('a throwing hook keeps the observed row, finishes the pass and logs at error level', async () => {
    const api = new FakeApi()
      .set('alpha', { openPrs: 2, runs: { kind: 'ok', value: [rawRun({ id: 9, conclusion: 'failure' })] } })
      .set('beta', { openPrs: 5 });
    const h = harness({
      names: ['alpha', 'beta'],
      api,
      onDefaultBranchRuns: (observation) => {
        if (observation.repo.repo === 'alpha') throw new Error('database is locked');
      },
    });
    const view = await h.tracker.refresh();
    expect(row(view, 'alpha')).toMatchObject({ freshness: 'fresh', error: null, openPrs: 2, run: { state: 'failed', runNumber: 1 } });
    expect(row(view, 'beta')).toMatchObject({ freshness: 'fresh', error: null, openPrs: 5 });
    expect(h.logs).toContainEqual({
      level: 'error',
      msg: 'repo overview: default-branch CI watch failed — the row is unaffected',
      fields: { repo: 'alpha', error: 'database is locked' },
    });
    expect(h.logs.some((entry) => entry.level === 'warn')).toBe(false);
    expect(isValidSnapshot(validBoardSnapshot(h.tracker.view()))).toBe(true);
  });

  it('maps workflow_id, head_sha (lowercased) and event, dropping a malformed value to null', async () => {
    const adapter = new GhRepoOverviewApi(
      ghRunner([
        ok(
          JSON.stringify({
            workflow_runs: [
              { id: 1, status: 'completed', conclusion: 'failure', workflow_id: 55, head_sha: '3684087C', event: 'pull_request' },
              { id: 2, status: 'completed', conclusion: 'failure', workflow_id: -1, head_sha: 'abc:def0', event: 7 },
              { id: 3, status: 'completed', conclusion: 'failure', workflow_id: '55', head_sha: 'not-a-sha' },
              { id: 4, status: 'completed', conclusion: 'failure' },
            ],
          }),
        ),
      ]).runner,
    );
    const result = await adapter.latestRuns({ repo: githubRef('alpha'), branch: 'main', limit: 20 });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.value.map((entry) => [entry.workflowId, entry.headSha, entry.event])).toEqual([
      [55, '3684087c', 'pull_request'],
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ]);
  });

  it('reads the fork flag from the run payload itself, never the configured name (a renamed repository still counts)', async () => {
    const run = (id: number, extra: Record<string, unknown>) => ({ id, status: 'completed', conclusion: 'failure', ...extra });
    const adapter = new GhRepoOverviewApi(
      ghRunner([
        ok(
          JSON.stringify({
            workflow_runs: [
              // Renamed/transferred: the origin still says acme/alpha, the payload the new name; ids match.
              run(1, { repository: { id: 5, full_name: 'acme-org/alpha-renamed' }, head_repository: { id: 5, full_name: 'acme-org/alpha-renamed' } }),
              // A fork: ids differ even when the names look alike.
              run(2, { repository: { id: 5, full_name: 'acme/alpha' }, head_repository: { id: 6, full_name: 'acme/alpha' } }),
              // No ids: the full-name pair decides, case-insensitively.
              run(3, { repository: { full_name: 'acme/alpha' }, head_repository: { full_name: 'ACME/Alpha' } }),
              run(4, { repository: { full_name: 'acme/alpha' }, head_repository: { full_name: 'someone/alpha' } }),
              // Unknown: counts as not a fork.
              run(5, { head_repository: { id: 6, full_name: 'someone/alpha' } }),
              run(6, {}),
            ],
          }),
        ),
      ]).runner,
    );
    const result = await adapter.latestRuns({ repo: githubRef('alpha'), branch: 'develop', limit: 20 });
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.value.map((entry) => entry.fromFork)).toEqual([false, true, false, true, null, null]);
    expect(result.value.map((entry) => isDefaultBranchRun(entry))).toEqual([true, false, true, false, true, true]);
  });

  it('pull_request* runs are never default-branch runs; workflow_run and every other event are', () => {
    for (const event of ['pull_request', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment']) {
      expect(isDefaultBranchRun({ event, fromFork: false }), event).toBe(false);
    }
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'workflow_run', 'merge_group', null]) {
      expect(isDefaultBranchRun({ event, fromFork: null }), String(event)).toBe(true);
    }
    expect(isDefaultBranchRun({ event: 'push', fromFork: true })).toBe(false);
  });

  it('the chip never takes a newer pull_request or fork run named like the default branch; the hook still gets the full page', async () => {
    const own = rawRun({ id: 9, conclusion: 'failure', createdAt: '2026-10-07T10:00:00.000Z', url: 'https://github.com/acme/alpha/actions/runs/9' });
    const pullRequest = rawRun({ id: 10, event: 'pull_request', createdAt: '2026-10-07T11:00:00.000Z', url: 'https://github.com/acme/alpha/actions/runs/10' });
    const fork = rawRun({ id: 11, fromFork: true, createdAt: '2026-10-07T12:00:00.000Z', url: 'https://github.com/acme/alpha/actions/runs/11' });
    const seen: DefaultBranchRunsObservation[] = [];
    const api = new FakeApi().set('alpha', { defaultBranch: 'develop', runs: { kind: 'ok', value: [own, pullRequest] } });
    const h = harness({ api, onDefaultBranchRuns: (observation) => seen.push(observation) });
    expect(row(await h.tracker.refresh(), 'alpha').run).toMatchObject({ state: 'failed', url: 'https://github.com/acme/alpha/actions/runs/9' });
    api.set('alpha', { defaultBranch: 'develop', runs: { kind: 'ok', value: [own, fork] } });
    expect(row(await h.tracker.refresh(), 'alpha').run).toMatchObject({ state: 'failed', url: 'https://github.com/acme/alpha/actions/runs/9' });
    expect(seen.map((observation) => observation.runs)).toEqual([[own, pullRequest], [own, fork]]);
  });

  it('a page of only pull-request runs reads never-run', async () => {
    const api = new FakeApi().set('alpha', {
      runs: { kind: 'ok', value: [rawRun({ id: 10, event: 'pull_request' }), rawRun({ id: 11, event: 'pull_request_target' })] },
    });
    const h = harness({ api });
    expect(row(await h.tracker.refresh(), 'alpha').run?.state).toBe('never-run');
    expect(isValidSnapshot(validBoardSnapshot(h.tracker.view()))).toBe(true);
  });
});
