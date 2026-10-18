import { describe, expect, it } from 'vitest';
import {
  DeployDriftTracker,
  compareReleaseTags,
  highestReleaseTag,
  parseReleaseTag,
  parseRemoteTagNames,
  type DeployDriftView,
  type GitRunner,
} from '../src/board/deploy-drift.js';
import type { BuildInfo } from '../src/build-info.js';

const BUILD: BuildInfo = {
  version: '1.0.1',
  rev: 'a'.repeat(40),
  committedAt: '2026-09-20T10:00:00.000Z',
  builtAt: '2026-09-20T10:05:00.000Z',
};

interface ScriptEntry {
  readonly output?: string;
  readonly error?: string;
}

/** A scripted git runner: keys are `args.join(' ')`, each command may be
 * scripted as a queue (repeat the last entry when the queue runs dry). */
function scriptedGit(script: Readonly<Record<string, ScriptEntry | readonly ScriptEntry[]>>): {
  runGit: GitRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const cursors = new Map<string, number>();
  const runGit: GitRunner = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    const entry = script[key];
    if (entry === undefined) throw new Error(`unexpected git call: ${key}`);
    const queue = Array.isArray(entry) ? entry : [entry as ScriptEntry];
    const index = Math.min(cursors.get(key) ?? 0, queue.length - 1);
    cursors.set(key, index + 1);
    const step = queue[index] as ScriptEntry;
    if (step.error !== undefined) throw new Error(step.error);
    return step.output ?? '';
  };
  return { runGit, calls };
}

const LS_REMOTE = 'ls-remote origin refs/heads/main';
const LS_REMOTE_TAGS = 'ls-remote --tags origin';
const LOCAL_MAIN = 'rev-parse --verify --quiet refs/remotes/origin/main';
const FETCH_MAIN = 'fetch --quiet origin main';
const FETCH_TAGS = 'fetch --quiet --tags origin';
const TAG_LIST = 'tag --list v*';
const DEFAULT_TAGS = ['v1.0.1'] as const;

function countCommand(buildRev: string, mainRev: string): string {
  return `rev-list --count ${buildRev}..${mainRev}`;
}

function logCommand(rev: string): string {
  return `log -1 --format=%cI ${rev}`;
}

function mergedCommand(rev: string): string {
  return `tag --merged ${rev} --list v*`;
}

interface TagInput {
  readonly names?: readonly string[];
  readonly error?: string;
}

function namesEntry(input: TagInput | undefined): ScriptEntry {
  if (input === undefined) return { output: '' };
  if (input.error !== undefined) return { error: input.error };
  const names = input.names ?? [];
  return { output: names.length === 0 ? '' : `${names.join('\n')}\n` };
}

function remoteEntry(input: TagInput | undefined): ScriptEntry {
  if (input === undefined) return { output: '' };
  if (input.error !== undefined) return { error: input.error };
  const names = input.names ?? [];
  return {
    output:
      names.length === 0
        ? ''
        : `${names.map((name) => `${'a'.repeat(40)}\trefs/tags/${name}`).join('\n')}\n`,
  };
}

interface ScriptOptions {
  readonly mainRev?: string;
  readonly localMain?: string;
  readonly count?: string | ScriptEntry | readonly ScriptEntry[];
  readonly log?: string;
  readonly remoteMainError?: string;
  readonly remoteTags?: TagInput;
  readonly localTags?: TagInput;
  readonly mergedMain?: TagInput;
  readonly mergedBuild?: TagInput;
  readonly fetchMain?: ScriptEntry;
  readonly fetchTags?: ScriptEntry;
}

/** The whole main-drift call graph with coherent, current release defaults:
 * origin and the build both contain `v1.0.1` unless a case says otherwise. */
function driftScript(options: ScriptOptions = {}): Record<string, ScriptEntry | readonly ScriptEntry[]> {
  const mainRev = options.mainRev ?? 'b'.repeat(40);
  const remoteNames =
    options.remoteTags !== undefined && options.remoteTags.error === undefined
      ? (options.remoteTags.names ?? DEFAULT_TAGS)
      : DEFAULT_TAGS;
  const script: Record<string, ScriptEntry | readonly ScriptEntry[]> = {
    [LS_REMOTE]:
      options.remoteMainError === undefined
        ? { output: `${mainRev}\trefs/heads/main\n` }
        : { error: options.remoteMainError },
    [LOCAL_MAIN]: { output: options.localMain ?? BUILD.rev ?? '' },
    [countCommand(BUILD.rev as string, mainRev)]:
      typeof options.count === 'string' ? { output: options.count } : (options.count ?? { output: '0\n' }),
    [logCommand(mainRev)]: { output: options.log ?? '2026-09-22T08:00:00.000Z\n' },
    [LS_REMOTE_TAGS]:
      options.remoteTags === undefined ? remoteEntry({ names: DEFAULT_TAGS }) : remoteEntry(options.remoteTags),
    [TAG_LIST]: namesEntry(options.localTags ?? { names: remoteNames }),
    [mergedCommand(mainRev)]: namesEntry(options.mergedMain ?? { names: remoteNames }),
    [mergedCommand(BUILD.rev as string)]: namesEntry(options.mergedBuild ?? { names: remoteNames }),
  };
  if (options.fetchMain !== undefined) script[FETCH_MAIN] = options.fetchMain;
  if (options.fetchTags !== undefined) script[FETCH_TAGS] = options.fetchTags;
  return script;
}

describe('deploy drift — running build vs origin/main', () => {
  it('counts the commits origin/main has beyond the build (43-commit incident shape)', async () => {
    const mainRev = 'b'.repeat(40);
    const { runGit } = scriptedGit(driftScript({ mainRev, count: '43\n' }));
    const tracker = new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit });
    const view = await tracker.refresh();
    expect(view).toMatchObject({
      buildRev: BUILD.rev,
      buildCommittedAt: BUILD.committedAt,
      originMainRev: mainRev,
      originMainCommittedAt: '2026-09-22T08:00:00.000Z',
      commitsBehind: 43,
      latestTag: 'v1.0.1',
      buildTag: 'v1.0.1',
      updateAvailable: false,
      checkError: null,
    });
    expect(view.checkedAt).not.toBeNull();
    expect(tracker.view()).toEqual(view);
  });

  it('reports zero behind when the build is current', async () => {
    const { runGit } = scriptedGit(driftScript());
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.commitsBehind).toBe(0);
    expect(view.checkError).toBeNull();
  });

  it('falls back to the last fetched origin/main when the remote is unreachable, and says so', async () => {
    const localRev = 'c'.repeat(40);
    const { runGit, calls } = scriptedGit({
      [LS_REMOTE]: { error: 'Could not resolve host: github.com' },
      [LOCAL_MAIN]: { output: localRev },
      [countCommand(BUILD.rev as string, localRev)]: { output: '5\n' },
      [logCommand(localRev)]: { output: '2026-09-21T12:00:00.000Z\n' },
      [LS_REMOTE_TAGS]: { error: 'Could not resolve host: github.com' },
      [TAG_LIST]: { output: 'v1.0.0\nv1.0.1\n' },
      [mergedCommand(localRev)]: { output: 'v1.0.1\n' },
      [mergedCommand(BUILD.rev as string)]: { output: 'v1.0.1\n' },
    });
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.originMainRev).toBe(localRev);
    expect(view.commitsBehind).toBe(5);
    expect(view.checkError).toContain('origin unreachable');
    // A completely unreachable origin is already named by the count; the
    // local tag fallback stays quiet rather than shouting twice.
    expect(view.checkError).not.toContain('release tags:');
    expect(view.latestTag).toBe('v1.0.1');
    expect(view.buildTag).toBe('v1.0.1');
    expect(view.updateAvailable).toBe(false);
    expect(calls).not.toContain(FETCH_MAIN);
  });

  it('fetches once when origin/main is remote-known but not local, then counts against remote truth', async () => {
    const mainRev = 'd'.repeat(40);
    const { runGit, calls } = scriptedGit(
      driftScript({
        mainRev,
        localMain: 'e'.repeat(40),
        count: [{ error: 'bad object' }, { output: '9\n' }],
        fetchMain: { output: '' },
      }),
    );
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.originMainRev).toBe(mainRev);
    expect(view.commitsBehind).toBe(9);
    expect(view.checkError).toBeNull();
    expect(calls).toContain(FETCH_MAIN);
  });

  it('falls back to the local ref (with a loud checkError) when the fetch cannot land the remote object', async () => {
    const mainRev = 'd'.repeat(40);
    const localRev = 'e'.repeat(40);
    const { runGit } = scriptedGit({
      [LS_REMOTE]: { output: `${mainRev}\trefs/heads/main\n` },
      [LOCAL_MAIN]: { output: localRev },
      [countCommand(BUILD.rev as string, mainRev)]: { error: 'bad object' },
      [FETCH_MAIN]: { error: 'Could not resolve host: github.com' },
      [countCommand(BUILD.rev as string, localRev)]: { output: '7\n' },
      [logCommand(localRev)]: { output: '2026-09-21T12:00:00.000Z\n' },
      [LS_REMOTE_TAGS]: { error: 'Could not resolve host: github.com' },
      [TAG_LIST]: { output: 'v1.0.1\n' },
      [mergedCommand(localRev)]: { output: 'v1.0.1\n' },
      [mergedCommand(BUILD.rev as string)]: { output: 'v1.0.1\n' },
    });
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.originMainRev).toBe(localRev);
    expect(view.commitsBehind).toBe(7);
    expect(view.checkError).toContain('origin/main objects not local');
  });

  it('never invents a count when neither remote nor local origin/main can be read', async () => {
    const { runGit } = scriptedGit({
      [LS_REMOTE]: { error: 'no such remote' },
      [LOCAL_MAIN]: { error: 'unknown revision' },
      [LS_REMOTE_TAGS]: { error: 'no such remote' },
      [TAG_LIST]: { error: 'no tags' },
    });
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.originMainRev).toBeNull();
    expect(view.commitsBehind).toBeNull();
    expect(view.latestTag).toBeNull();
    expect(view.updateAvailable).toBeNull();
    expect(view.checkError).toContain('no local origin/main ref');
  });

  it('renders an unknown build revision (missing artifact) without pretending a count', async () => {
    const mainRev = 'f'.repeat(40);
    const { runGit } = scriptedGit(
      driftScript({
        mainRev,
        localMain: mainRev,
        remoteTags: { names: ['v1.0.2'] },
        localTags: { names: ['v1.0.2'] },
        mergedMain: { names: ['v1.0.2'] },
      }),
    );
    const unknown = new DeployDriftTracker({
      repoRoot: '/repo',
      build: { version: null, rev: null, committedAt: null, builtAt: null },
      runGit,
    });
    const view = await unknown.refresh();
    expect(view.buildRev).toBeNull();
    expect(view.commitsBehind).toBeNull();
    expect(view.latestTag).toBe('v1.0.2');
    expect(view.buildTag).toBeNull();
    expect(view.updateAvailable).toBeNull();
    expect(view.checkError).toContain('build revision unknown');
  });

  it('the cached view starts from the build stamp and a null check (no fabricated numbers)', () => {
    const tracker = new DeployDriftTracker({
      repoRoot: '/repo',
      build: BUILD,
      runGit: async () => {
        throw new Error('should not run');
      },
    });
    expect(tracker.view()).toEqual({
      buildRev: BUILD.rev,
      buildCommittedAt: BUILD.committedAt,
      originMainRev: null,
      originMainCommittedAt: null,
      commitsBehind: null,
      latestTag: null,
      buildTag: null,
      updateAvailable: null,
      checkedAt: null,
      checkError: null,
    });
  });

  it('coalesces overlapping refreshes into one git run per command', async () => {
    const mainRev = 'b'.repeat(40);
    const { runGit, calls } = scriptedGit(driftScript({ mainRev, count: '1\n' }));
    const tracker = new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit });
    const [first, second] = await Promise.all([tracker.refresh(), tracker.refresh()]);
    expect(first).toEqual(second);
    for (const key of [
      LS_REMOTE,
      LOCAL_MAIN,
      countCommand(BUILD.rev as string, mainRev),
      logCommand(mainRev),
      LS_REMOTE_TAGS,
      TAG_LIST,
      mergedCommand(mainRev),
      mergedCommand(BUILD.rev as string),
    ]) {
      expect(calls.filter((call) => call === key), key).toHaveLength(1);
    }
    expect(first.updateAvailable).toBe(false);
  });

  it('start() schedules background checks and stop() clears the timer (injectable cadence)', async () => {
    const mainRev = 'b'.repeat(40);
    const script = driftScript({ mainRev, count: '2\n' });
    let refreshes = 0;
    const base = scriptedGit(script);
    const tracker = new DeployDriftTracker({
      repoRoot: '/repo',
      build: BUILD,
      intervalMs: 20,
      runGit: async (args, timeoutMs) => {
        if (args[0] === 'ls-remote' && args[1] === 'origin') refreshes += 1;
        return base.runGit(args, timeoutMs);
      },
    });
    tracker.start();
    await tracker.refresh(); // join the boot check
    await new Promise((resolve) => setTimeout(resolve, 60));
    tracker.stop();
    expect(refreshes).toBeGreaterThanOrEqual(1);
    expect(tracker.view().commitsBehind).toBe(2);
  });
});

describe('release tags — only deliverable, not-yet-contained releases are advertised', () => {
  function viewFor(options: ScriptOptions): Promise<DeployDriftView> {
    const { runGit } = scriptedGit(driftScript(options));
    return new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
  }

  it('advertises the newest release reachable from origin/main', async () => {
    const view = await viewFor({
      count: '4\n',
      remoteTags: { names: ['v1.0.1', 'v1.0.2'] },
      localTags: { names: ['v1.0.1', 'v1.0.2'] },
      mergedMain: { names: ['v1.0.2'] },
      mergedBuild: { names: ['v1.0.1'] },
    });
    expect(view.latestTag).toBe('v1.0.2');
    expect(view.buildTag).toBe('v1.0.1');
    expect(view.updateAvailable).toBe(true);
    expect(view.checkError).toBeNull();
  });

  it('never advertises a tag that origin/main cannot deliver', async () => {
    const view = await viewFor({
      remoteTags: { names: ['v1.0.2', 'v1.0.3'] },
      localTags: { names: ['v1.0.2', 'v1.0.3'] },
      mergedMain: { names: ['v1.0.2'] },
      mergedBuild: { names: ['v1.0.1'] },
    });
    expect(view.latestTag).toBe('v1.0.2');
    expect(view.updateAvailable).toBe(true);
    expect(view.checkError).toContain('release v1.0.3 is not in origin/main');
  });

  it('fetches tags on demand and clears the flag when the build already contains the release', async () => {
    const { runGit, calls } = scriptedGit({
      ...driftScript({
        remoteTags: { names: ['v1.0.1', 'v1.0.2'] },
        localTags: { names: ['v1.0.1'] },
        mergedMain: { names: ['v1.0.2'] },
        mergedBuild: { names: ['v1.0.2'] },
        fetchTags: { output: '' },
      }),
    });
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(calls).toContain(FETCH_TAGS);
    expect(view.latestTag).toBe('v1.0.2');
    expect(view.buildTag).toBe('v1.0.2');
    expect(view.updateAvailable).toBe(false);
    expect(view.checkError).toBeNull();
  });

  it('stays honest when the tag fetch fails: no claim, and the reason is named', async () => {
    const view = await viewFor({
      remoteTags: { names: ['v1.0.1', 'v1.0.2'] },
      localTags: { names: ['v1.0.1'] },
      mergedMain: { names: ['v1.0.1'] },
      mergedBuild: { names: ['v1.0.1'] },
      fetchTags: { error: 'Could not resolve host: github.com' },
    });
    expect(view.latestTag).toBe('v1.0.1');
    expect(view.updateAvailable).toBe(false);
    expect(view.checkError).toContain('could not fetch release tags');
  });

  it('uses the last fetched tags when the tag read fails, and says why', async () => {
    const view = await viewFor({
      remoteTags: { error: 'ls-remote timed out' },
      localTags: { names: ['v1.0.1'] },
      mergedMain: { names: ['v1.0.1'] },
      mergedBuild: { names: ['v1.0.1'] },
    });
    expect(view.latestTag).toBe('v1.0.1');
    expect(view.updateAvailable).toBe(false);
    expect(view.checkError).toContain('release tags: read failed');
  });

  it('never invents an update when no tag list can be read', async () => {
    const view = await viewFor({
      remoteTags: { error: 'no such remote' },
      localTags: { error: 'no tags' },
    });
    expect(view.latestTag).toBeNull();
    expect(view.buildTag).toBeNull();
    expect(view.updateAvailable).toBeNull();
    expect(view.checkError).toContain('release tags unavailable');
  });

  it('treats an origin with no release tags as "no release yet", not a warning', async () => {
    const view = await viewFor({
      remoteTags: { names: [] },
      localTags: { names: [] },
      mergedMain: { names: [] },
      mergedBuild: { names: [] },
    });
    expect(view.latestTag).toBeNull();
    expect(view.buildTag).toBeNull();
    expect(view.updateAvailable).toBeNull();
    expect(view.checkError).toBeNull();
  });

  it('is loud when the build tag list cannot be read', async () => {
    const view = await viewFor({
      remoteTags: { names: ['v1.0.2'] },
      localTags: { names: ['v1.0.2'] },
      mergedMain: { names: ['v1.0.2'] },
      mergedBuild: { error: 'unknown revision' },
    });
    expect(view.latestTag).toBe('v1.0.2');
    expect(view.buildTag).toBeNull();
    expect(view.updateAvailable).toBeNull();
    expect(view.checkError).toContain('build tag list unavailable');
  });

  it('picks the highest release tag on the build side numerically', async () => {
    const view = await viewFor({
      remoteTags: { names: ['v1.0.10'] },
      localTags: { names: ['v1.0.10'] },
      mergedMain: { names: ['v1.0.10'] },
      mergedBuild: { names: ['v1.0.2', 'v1.0.9', 'v1.0.10'] },
    });
    expect(view.buildTag).toBe('v1.0.10');
    expect(view.updateAvailable).toBe(false);
  });

  it('ignores prereleases and bookkeeping tags on both sides', async () => {
    const view = await viewFor({
      remoteTags: { names: ['v1.1.0-rc1', 'backup-pre-rebase', 'v1.0.1'] },
      localTags: { names: ['v1.1.0-rc1', 'backup-pre-rebase', 'v1.0.1'] },
      mergedMain: { names: ['v1.1.0-rc1', 'v1.0.1'] },
      mergedBuild: { names: ['backup-pre-rebase', 'v1.0.0-rc2', 'v1.0.1'] },
    });
    expect(view.latestTag).toBe('v1.0.1');
    expect(view.buildTag).toBe('v1.0.1');
    expect(view.updateAvailable).toBe(false);
  });
});

describe('release tag parsing', () => {
  it('accepts only stable vX.Y.Z without leading zeros', () => {
    expect(parseReleaseTag('v1.2.3')).not.toBeNull();
    expect(parseReleaseTag('v1.2.3-rc1')).toBeNull();
    expect(parseReleaseTag('1.2.3')).toBeNull();
    expect(parseReleaseTag('v01.2.3')).toBeNull();
    expect(parseReleaseTag('backup-pre-rebase')).toBeNull();
    expect(compareReleaseTags('v1.0.10', 'v1.0.9')).toBeGreaterThan(0);
    expect(compareReleaseTags('v1.0.1', 'v1.0.1')).toBe(0);
    expect(compareReleaseTags('v1.0.1', 'not-a-tag')).toBeNull();
    expect(highestReleaseTag(['v1.0.1', 'v2.0.0-rc1', 'v0.9.9'])).toBe('v1.0.1');
    expect(highestReleaseTag(['nope'])).toBeNull();
  });

  it('reads tag names from ls-remote output without duplicating annotated tags', () => {
    const stdout = [
      `${'1'.repeat(40)}\trefs/tags/v1.0.0`,
      `${'2'.repeat(40)}\trefs/tags/v1.0.0^{}`,
      `${'3'.repeat(40)}\trefs/heads/main`,
      `${'4'.repeat(40)}\trefs/tags/v1.0.1`,
    ].join('\n');
    expect(parseRemoteTagNames(stdout)).toEqual(['v1.0.0', 'v1.0.1']);
  });
});
