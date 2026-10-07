import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import {
  GhRepoOverviewApi,
  ManagedRepoOverviewTracker,
  REPO_OVERVIEW_FETCH_BUDGET_MS,
  REPO_OVERVIEW_RESOLVE_BUDGET_MS,
  REPO_OVERVIEW_STALE_AFTER_MS,
  classifyGhError,
  classifyRemote,
  freshnessOf,
  githubRepoLink,
  runStateOf,
  safeRunUrl,
  selectLatestRun,
  type ActionsAvailability,
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
    updatedAt: '2026-10-07T10:05:00.000Z',
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
  resolveError: boolean;
  resolveDelayMs: number;
  readonly clock: { ms: number };
  readonly sleeps: number[];
  failure: string | null;
}

const T0 = Date.parse('2026-10-07T12:00:00.000Z');

function harness(options: {
  names?: readonly string[];
  refs?: ReadonlyMap<string, RepoRef | null>;
  api?: FakeApi;
  maxCallsPerRefresh?: number;
  staleAfterMs?: number;
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
    resolveError: false,
    resolveDelayMs: 0,
    clock,
    sleeps,
    failure: null,
  };
  state.tracker = new ManagedRepoOverviewTracker({
    workspaceRoot: '/ws',
    api,
    scanRepos: () => state.names,
    resolveRemote: async (repoPath) => {
      const name = repoPath.split('/').pop() as string;
      const gate = state.resolveGates.get(name);
      if (gate !== undefined) await gate;
      if (state.resolveError) throw new Error('git origin lookup exploded');
      if (state.resolveDelayMs > 0) state.clock.ms += state.resolveDelayMs;
      return state.refs.get(name) ?? null;
    },
    intervalMs: 300_000,
    ...(options.maxCallsPerRefresh !== undefined ? { maxCallsPerRefresh: options.maxCallsPerRefresh } : {}),
    ...(options.staleAfterMs !== undefined ? { staleAfterMs: options.staleAfterMs } : {}),
    now: () => state.clock.ms,
    sleep: async (ms) => {
      sleeps.push(ms);
      state.clock.ms += ms;
    },
    log: (level, msg) => {
      if (level === 'warn') state.failure = msg;
    },
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
              run_started_at: '2026-10-07T10:00:00Z',
              updated_at: '2026-10-07T10:05:00Z',
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
          createdAt: '2026-10-07T10:00:00Z',
          updatedAt: '2026-10-07T10:05:00Z',
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

  it('advances rotation past a partial observation when the budget cannot fit one', async () => {
    const api = new FakeApi().set('alpha', {}).set('beta', {}).set('gamma', {});
    const h = harness({ names: ['alpha', 'beta', 'gamma'], api, maxCallsPerRefresh: 3 });
    await h.tracker.refresh();
    await h.tracker.refresh();
    await h.tracker.refresh();
    // The more likely truncation mode (budget runs out mid-observation)
    // leaves an operator-visible trace, not just the loop pre-check.
    expect(h.failure).toContain('budget exhausted');
    const touched = new Set(api.calls.map((call) => call.split(':')[1]));
    expect(touched).toEqual(new Set(['acme/alpha', 'acme/beta', 'acme/gamma']));
    for (const key of ['alpha', 'beta', 'gamma']) {
      expect(row(h.tracker.view(), key).lastAttemptAt).toBeNull();
      expect(row(h.tracker.view(), key).checkedAt).toBeNull();
    }
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
    expect(result.value[0]?.createdAt).toBeNull();
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
    expect(result.value[1]?.updatedAt).toBe('2026-10-07T10:05:00.000Z');
  });

  it('drives the production default registry scan and origin resolver over a real workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-repo-overview-defaults-'));
    try {
      execFileSync('git', ['init', '-q', join(root, 'alpha')]);
      execFileSync('git', ['-C', join(root, 'alpha'), 'remote', 'add', 'origin', 'https://github.com/acme/alpha.git']);
      execFileSync('git', ['init', '-q', join(root, 'no-origin')]);
      execFileSync('git', ['init', '-q', join(root, 'gitlab-repo')]);
      execFileSync('git', ['-C', join(root, 'gitlab-repo'), 'remote', 'add', 'origin', 'https://gitlab.com/acme/gl.git']);
      mkdirSync(join(root, 'broken'));
      writeFileSync(join(root, 'broken', '.git'), 'gitdir: /nonexistent/gru-repo-overview-test\n');
      mkdirSync(join(root, 'plain'));
      const api = new FakeApi().set('alpha', { openPrs: 1, openIssues: 2, workflows: { kind: 'ok', value: 0 } });
      const tracker = new ManagedRepoOverviewTracker({ workspaceRoot: root, api, now: () => T0, sleep: async () => {} });
      const view = await tracker.refresh();
      // The production default scan discovers only real `.git` entries.
      expect(view?.rows.map((entry) => entry.key)).toEqual(['alpha', 'broken', 'gitlab-repo', 'no-origin']);
      const entry = row(view, 'alpha');
      expect(entry.linked).toBe(true);
      expect(entry.fullName).toBe('acme/alpha');
      expect(entry.link).toBe('https://github.com/acme/alpha');
      expect(entry.openPrs).toBe(1);
      expect(entry.run?.state).toBe('no-workflow');
      // The default resolver's failure paths through the REAL seam:
      expect(row(view, 'no-origin').linkReason).toBe('no usable origin remote');
      expect(row(view, 'gitlab-repo').linkReason).toBe('non-GitHub remote');
      // A corrupt/unreadable repository is a READ failure, not evidence
      // the user never configured an origin.
      expect(row(view, 'broken').linkReason).toBe('origin remote could not be read yet');
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
        api,
        scanRepos: () => ['alpha'],
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

  it('renders an invisible-only registry name as visible escapes the web validator accepts', async () => {
    const h = harness({ names: ['\u200b'] });
    const view = await h.tracker.refresh();
    expect(isValidSnapshot(validBoardSnapshot(view))).toBe(true);
    const entry = row(view, '\u200b');
    expect(entry.displayName).not.toBe('\u200b');
    expect(entry.displayName.length).toBeGreaterThan(0);
    // A bidi override beside visible text is escaped, so the name cannot
    // spoof its display; combining marks in a visible name survive.
    h.names.splice(0, h.names.length, 'repo\u202E', 'caf\u0065\u0301');
    h.refs.set('repo\u202E', githubRef('repo-e'));
    h.refs.set('caf\u0065\u0301', githubRef('cafe'));
    const second = await h.tracker.refresh();
    expect(row(second, 'repo\u202E').displayName).toBe('repo\\u{202e}');
    expect(row(second, 'caf\u0065\u0301').displayName).toBe('caf\u0065\u0301');
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
      const expected = ['repo-dir', 'repo-file', 'repo-link', 'target'];
      expect(discoverManagedRepos(root)).toEqual(expected);
      expect(await discoverManagedReposAsync(root)).toEqual(expected);
      expect(discoverManagedRepos(join(root, 'absent'))).toEqual([]);
      expect(await discoverManagedReposAsync(join(root, 'absent'))).toEqual([]);
    } finally {
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
      api,
      scanRepos: () => ['alpha', 'beta', 'gamma'],
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
      api,
      scanRepos: () => ['alpha'],
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
      api,
      scanRepos: () => ['alpha', 'beta'],
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
  });
});