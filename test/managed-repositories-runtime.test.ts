import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import {
  generateConfigToml,
  writeConfigText,
} from '../src/wizard/steps.js';
import { parseAnswers } from '../src/wizard/answers.js';
import { validateRepositorySetup } from '../src/wizard/repository-setup.js';
import type { RepoRef } from '../src/dispatch/github-poll.js';
import {
  createManagedRepoOverviewTracker,
} from '../src/repos/runtime.js';
import { resolveManagedRepoPathSync } from '../src/repos/managed-names.js';
import {
  defaultRemoteResolver,
  type ActionsAvailability,
  type GitLabRepoOverviewApiPort,
  type RepoOverviewApiPort,
  type RepoOverviewMeta,
  type RepoOverviewRunRaw,
} from '../src/repos/overview.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function makeRepo(workspace: string, name: string): string {
  const path = join(workspace, name);
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`]);
  return path;
}

class ProviderSpy implements RepoOverviewApiPort {
  readonly calls: string[] = [];

  private record(kind: string, repo: RepoRef): string {
    const identity = `${repo.owner}/${repo.repo}`;
    this.calls.push(`${kind}:${identity}`);
    return identity;
  }

  async fetchRepo(input: { readonly repo: RepoRef }): Promise<RepoOverviewMeta> {
    this.record('repository', input.repo);
    return { defaultBranch: 'main' };
  }

  async countOpenPulls(input: { readonly repo: RepoRef }): Promise<number> {
    this.record('pulls', input.repo);
    return 2;
  }

  async countOpenIssues(input: { readonly repo: RepoRef }): Promise<number> {
    this.record('issues', input.repo);
    return 3;
  }

  async countWorkflows(input: { readonly repo: RepoRef }): Promise<ActionsAvailability<number>> {
    this.record('workflows', input.repo);
    return { kind: 'ok', value: 1 };
  }

  async latestRuns(input: {
    readonly repo: RepoRef;
    readonly branch: string;
    readonly limit: number;
  }): Promise<ActionsAvailability<readonly RepoOverviewRunRaw[]>> {
    this.record('runs', input.repo);
    return { kind: 'ok', value: [] };
  }
}

/** The required GitLab port for GitHub-only registries: never called. */
const unusedGitLab: GitLabRepoOverviewApiPort = {
  fetchProject: async () => {
    throw new Error('GitLab port called in a GitHub-only test');
  },
  countOpenMergeRequests: async () => {
    throw new Error('GitLab port called in a GitHub-only test');
  },
  countOpenIssues: async () => {
    throw new Error('GitLab port called in a GitHub-only test');
  },
  latestPipelines: async () => {
    throw new Error('GitLab port called in a GitHub-only test');
  },
};

function configFor(instance: string, workspace: string, selected: readonly string[]) {
  const answers = parseAnswers(JSON.stringify({ workspace_root: workspace, repos: selected }));
  const text = generateConfigToml({ answers, instanceDir: instance });
  writeConfigText(instance, text);
  return { config: loadConfig({ GRU_COMMAND_HOME: instance }), text };
}

describe('managed repository config-to-runtime wiring', () => {
  it('persists alpha/gamma and drives only those real roots through the main runtime adapter', async () => {
    const root = tempDir('gru-managed-repositories-runtime-');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    for (const name of ['alpha', 'beta', 'gamma']) makeRepo(workspace, name);
    // Provision markers are not a management source; a selected repo remains
    // selected and an unselected repo remains out of the overview.
    mkdirSync(join(workspace, 'alpha', '_bmad', 'project'), { recursive: true });
    mkdirSync(join(workspace, 'beta', '_bmad', 'project'), { recursive: true });

    const instance = join(root, 'instance-selected');
    const { config, text } = configFor(instance, workspace, ['alpha', 'gamma']);
    expect(config.managedRepos).toEqual(['alpha', 'gamma']);
    expect(text).toContain('managed_repos = ["alpha", "gamma"]');

    const api = new ProviderSpy();
    const resolvedPaths: string[] = [];
    const defaultBranchPages: string[] = [];
    const tracker = createManagedRepoOverviewTracker(config, {
      api,
      gitlabApi: unusedGitLab,
      intervalMs: 0,
      now: () => Date.parse('2026-10-10T12:00:00.000Z'),
      sleep: async () => {},
      resolveRemote: async (path) => {
        resolvedPaths.push(path);
        return defaultRemoteResolver(path);
      },
      // The default-branch CI alert (#446) hook passes through the adapter.
      onDefaultBranchRuns: (observation) => defaultBranchPages.push(`${observation.repo.owner}/${observation.repo.repo}@${observation.branch}`),
    });
    const view = await tracker.refresh();
    expect(view?.rows.map((row) => row.key)).toEqual(['alpha', 'gamma']);
    expect(resolvedPaths.map((path) => path.split('/').at(-1))).toEqual(['alpha', 'gamma']);
    expect(defaultBranchPages).toEqual(['acme/alpha@main', 'acme/gamma@main']);
    expect(new Set(api.calls.map((call) => call.split(':')[1])).size).toBe(2);
    expect(api.calls.some((call) => call.includes('/beta'))).toBe(false);

    // A later sibling cannot become managed merely because it appears under
    // workspace_root after startup; both remote resolution and provider reads
    // remain fenced to the loaded config set.
    makeRepo(workspace, 'delta');
    await tracker.refresh();
    expect(resolvedPaths.map((path) => path.split('/').at(-1))).toEqual([
      'alpha', 'gamma', 'alpha', 'gamma',
    ]);
    expect(api.calls.some((call) => call.includes('/delta'))).toBe(false);
    expect(api.calls.some((call) => call.includes('/beta'))).toBe(false);

    const changed = configFor(join(root, 'instance-changed'), workspace, ['beta']).config;
    const changedApi = new ProviderSpy();
    const changedPaths: string[] = [];
    const changedTracker = createManagedRepoOverviewTracker(changed, {
      api: changedApi,
      gitlabApi: unusedGitLab,
      intervalMs: 0,
      sleep: async () => {},
      resolveRemote: async (path) => {
        changedPaths.push(path);
        return defaultRemoteResolver(path);
      },
    });
    expect((await changedTracker.refresh())?.rows.map((row) => row.key)).toEqual(['beta']);
    expect(changedPaths.map((path) => path.split('/').at(-1))).toEqual(['beta']);
    expect(changedApi.calls.every((call) => call.endsWith('/beta'))).toBe(true);
  });

  it('passes the GitLab port through the main runtime adapter to a GitLab origin', async () => {
    const root = tempDir('gru-managed-repositories-gitlab-');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const repo = join(workspace, 'x');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@gitlab.example.com:group/sub/x.git']);
    const { config } = configFor(join(root, 'instance'), workspace, ['x']);

    const api = new ProviderSpy();
    const gitlabCalls: string[] = [];
    const record = (kind: string, ref: RepoRef): void => {
      gitlabCalls.push(`${kind}:${ref.host}/${ref.owner}/${ref.repo}`);
    };
    const gitlabApi: GitLabRepoOverviewApiPort = {
      fetchProject: async ({ repo: ref }) => {
        record('project', ref);
        return { defaultBranch: 'main', ciEnabled: true };
      },
      countOpenMergeRequests: async ({ repo: ref }) => {
        record('merge-requests', ref);
        return 4;
      },
      countOpenIssues: async ({ repo: ref }) => {
        record('issues', ref);
        return 1;
      },
      latestPipelines: async ({ repo: ref, branch }) => {
        record(`pipelines@${branch}`, ref);
        return [];
      },
    };
    const tracker = createManagedRepoOverviewTracker(config, {
      api,
      gitlabApi,
      intervalMs: 0,
      now: () => Date.parse('2026-10-22T12:00:00.000Z'),
      sleep: async () => {},
    });
    const view = await tracker.refresh();
    expect(view?.rows).toHaveLength(1);
    expect(view?.rows[0]).toMatchObject({
      key: 'x',
      provider: 'gitlab',
      fullName: 'group/sub/x',
      freshness: 'fresh',
      openPrs: 4,
      openIssues: 1,
    });
    expect(gitlabCalls).toEqual([
      'project:gitlab.example.com/group/sub/x',
      'merge-requests:gitlab.example.com/group/sub/x',
      'issues:gitlab.example.com/group/sub/x',
      'pipelines@main:gitlab.example.com/group/sub/x',
    ]);
    expect(api.calls).toEqual([]);
  });

  it('treats absent and empty config lists as no management and no provider calls', async () => {
    const root = tempDir('gru-managed-repositories-empty-');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    makeRepo(workspace, 'alpha');
    makeRepo(workspace, 'beta');

    const oldInstance = join(root, 'instance-old');
    mkdirSync(oldInstance);
    const oldText = `workspace_root = ${JSON.stringify(workspace)}\n`;
    writeFileSync(configPathFor(oldInstance), oldText);
    const oldConfig = loadConfig({ GRU_COMMAND_HOME: oldInstance });
    expect(oldConfig.managedRepos).toEqual([]);
    const oldApi = new ProviderSpy();
    const oldPaths: string[] = [];
    const oldTracker = createManagedRepoOverviewTracker(oldConfig, {
      api: oldApi,
      gitlabApi: unusedGitLab,
      intervalMs: 0,
      sleep: async () => {},
      resolveRemote: async (path) => {
        oldPaths.push(path);
        return defaultRemoteResolver(path);
      },
    });
    expect((await oldTracker.refresh())?.rows).toEqual([]);
    expect(oldApi.calls).toEqual([]);
    expect(oldPaths).toEqual([]);
    expect(readFileSync(configPathFor(oldInstance), 'utf8')).toBe(oldText);

    const emptyInstance = join(root, 'instance-empty');
    const { config: emptyConfig } = configFor(emptyInstance, workspace, []);
    expect(emptyConfig.managedRepos).toEqual([]);
    const emptyApi = new ProviderSpy();
    const emptyPaths: string[] = [];
    const emptyTracker = createManagedRepoOverviewTracker(emptyConfig, {
      api: emptyApi,
      gitlabApi: unusedGitLab,
      intervalMs: 0,
      sleep: async () => {},
      resolveRemote: async (path) => {
        emptyPaths.push(path);
        return defaultRemoteResolver(path);
      },
    });
    expect((await emptyTracker.refresh())?.rows).toEqual([]);
    expect(emptyApi.calls).toEqual([]);
    expect(emptyPaths).toEqual([]);
  });

  it('keeps unavailable selections fenced and resolves accepted Unicode trailing spaces consistently', async () => {
    const root = tempDir('gru-managed-repositories-unavailable-');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    makeRepo(workspace, 'alpha');
    makeRepo(workspace, 'beta');
    const unicodeSpaceName = 'unicode\u00a0';
    const unicodeSpaceRepo = join(workspace, unicodeSpaceName);
    mkdirSync(unicodeSpaceRepo);
    execFileSync('git', ['-C', unicodeSpaceRepo, 'init', '-q']);
    const canonicalUnicodeSpaceRepo = realpathSync(unicodeSpaceRepo);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    makeRepo(outside, 'outside-project');
    symlinkSync(join(workspace, 'alpha'), join(workspace, 'alias-alpha'));
    symlinkSync(join(outside, 'outside-project'), join(workspace, 'outside-link'));

    expect(parseAnswers(JSON.stringify({ workspace_root: workspace, repos: [unicodeSpaceName] })).repos)
      .toEqual([unicodeSpaceName]);
    const instance = join(root, 'instance');
    mkdirSync(instance);
    const configText = [
      `workspace_root = ${JSON.stringify(workspace)}`,
      `managed_repos = ${JSON.stringify(['alpha', 'alias-alpha', 'missing', 'outside-link', unicodeSpaceName])}`,
      '',
    ].join('\n');
    writeFileSync(configPathFor(instance), configText);
    const config = loadConfig({ GRU_COMMAND_HOME: instance });
    expect(resolveManagedRepoPathSync(workspace, 'alpha.').kind).toBe('unavailable');
    expect(resolveManagedRepoPathSync(workspace, 'alpha ').kind).toBe('unavailable');
    const api = new ProviderSpy();
    const resolvedPaths: string[] = [];
    const tracker = createManagedRepoOverviewTracker(config, {
      api,
      gitlabApi: unusedGitLab,
      intervalMs: 0,
      now: () => Date.parse('2026-10-10T12:00:00.000Z'),
      sleep: async () => {},
      resolveRemote: async (path) => {
        resolvedPaths.push(path);
        return path === canonicalUnicodeSpaceRepo ? null : defaultRemoteResolver(path);
      },
    });
    const syncResolution = resolveManagedRepoPathSync(workspace, unicodeSpaceName);
    let setupPath: string | null = null;
    let setupError: string | null = null;
    try {
      setupPath = validateRepositorySetup(workspace, unicodeSpaceName);
    } catch (error) {
      setupError = error instanceof Error ? error.message : String(error);
    }
    const view = await tracker.refresh();
    expect({
      syncKind: syncResolution.kind,
      syncPath: syncResolution.kind === 'available' ? syncResolution.path : null,
      setupPath,
      setupError,
      asyncResolvedNames: resolvedPaths.map((path) => path.split('/').at(-1)),
      rowKeys: view?.rows.map((row) => row.key),
    }).toEqual({
      syncKind: 'available',
      syncPath: canonicalUnicodeSpaceRepo,
      setupPath: canonicalUnicodeSpaceRepo,
      setupError: null,
      asyncResolvedNames: ['alpha', unicodeSpaceName],
      rowKeys: ['alias-alpha', 'alpha', 'missing', 'outside-link', unicodeSpaceName],
    });
    expect(rowByKey(view, 'missing')?.linkReason).toContain('unavailable');
    expect(rowByKey(view, 'alias-alpha')?.linkReason).toContain('unavailable');
    expect(rowByKey(view, 'outside-link')?.linkReason).toContain('unavailable');
    expect(api.calls.every((call) => call.endsWith('/alpha'))).toBe(true);
    expect(api.calls.some((call) => call.includes('/beta') || call.includes('/outside-project'))).toBe(false);
  });
});

function rowByKey<T extends { readonly key: string }>(view: { readonly rows: readonly T[] } | null, key: string): T | undefined {
  return view?.rows.find((row) => row.key === key);
}
