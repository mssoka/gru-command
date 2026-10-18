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
const TAG_LIST = 'tag --list v*';

function countCommand(buildRev: string, mainRev: string): string {
  return `rev-list --count ${buildRev}..${mainRev}`;
}

function logCommand(rev: string): string {
  return `log -1 --format=%cI ${rev}`;
}

function mergedTags(rev: string): string {
  return `tag --merged ${rev} --list v*`;
}

interface TagScript {
  readonly remote?: ScriptEntry | readonly ScriptEntry[];
  readonly local?: ScriptEntry | readonly ScriptEntry[];
  readonly merged?: ScriptEntry | readonly ScriptEntry[];
}

/** The main-drift tests are about the count, not the release channel:
 * give them a clean, current tag pair unless the case says otherwise. */
function withTags(
  script: Readonly<Record<string, ScriptEntry | readonly ScriptEntry[]>>,
  tags: TagScript = {},
): Readonly<Record<string, ScriptEntry | readonly ScriptEntry[]>> {
  return {
    ...script,
    [LS_REMOTE_TAGS]: tags.remote ?? { output: `${'c'.repeat(40)}\trefs/tags/v1.0.1\n` },
    ...(tags.local === undefined ? {} : { [TAG_LIST]: tags.local }),
    [mergedTags(BUILD.rev as string)]: tags.merged ?? { output: 'v1.0.1\n' },
  };
}

describe('deploy drift — running build vs origin/main', () => {
  it('counts the commits origin/main has beyond the build (43-commit incident shape)', async () => {
    const mainRev = 'b'.repeat(40);
    const { runGit } = scriptedGit(
      withTags({
        [LS_REMOTE]: { output: `${mainRev}\trefs/heads/main\n` },
        [LOCAL_MAIN]: { output: BUILD.rev ?? '' },
        [countCommand(BUILD.rev as string, mainRev)]: { output: '43\n' },
        [logCommand(mainRev)]: { output: '2026-09-22T08:00:00.000Z\n' },
      }),
    );
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
    const { runGit } = scriptedGit(
      withTags({
        [LS_REMOTE]: { output: `${BUILD.rev}\trefs/heads/main\n` },
        [LOCAL_MAIN]: { output: BUILD.rev ?? '' },
        [countCommand(BUILD.rev as string, BUILD.rev as string)]: { output: '0\n' },
        [logCommand(BUILD.rev as string)]: { output: '2026-09-20T10:00:00.000Z\n' },
      }),
    );
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.commitsBehind).toBe(0);
    expect(view.checkError).toBeNull();
  });

  it('falls back to the last fetched origin/main when the remote is unreachable, and says so', async () => {
    const localRev = 'c'.repeat(40);
    const { runGit, calls } = scriptedGit(
      withTags(
        {
          [LS_REMOTE]: { error: 'Could not resolve host: github.com' },
          [LOCAL_MAIN]: { output: localRev },
          [countCommand(BUILD.rev as string, localRev)]: { output: '5\n' },
          [logCommand(localRev)]: { output: '2026-09-21T12:00:00.000Z\n' },
        },
        {
          remote: { error: 'Could not resolve host: github.com' },
          local: { output: 'v1.0.0\nv1.0.1\n' },
        },
      ),
    );
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.originMainRev).toBe(localRev);
    expect(view.commitsBehind).toBe(5);
    expect(view.checkError).toContain('origin unreachable');
    // A completely unreachable origin is already named by the count; the
    // local tag fallback stays quiet rather than shouting twice.
    expect(view.checkError).not.toContain('release tags:');
    expect(view.latestTag).toBe('v1.0.1');
    expect(calls).not.toContain(FETCH_MAIN);
  });

  it('fetches once when origin/main is remote-known but not local, then counts against remote truth', async () => {
    const mainRev = 'd'.repeat(40);
    const { runGit, calls } = scriptedGit(
      withTags({
        [LS_REMOTE]: { output: `${mainRev}\trefs/heads/main\n` },
        [LOCAL_MAIN]: { output: 'e'.repeat(40) },
        [countCommand(BUILD.rev as string, mainRev)]: [
          { error: 'bad object' }, // not fetched yet
          { output: '9\n' }, // after fetch
        ],
        [FETCH_MAIN]: { output: '' },
        [logCommand(mainRev)]: { output: '2026-09-22T07:00:00.000Z\n' },
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
    const { runGit } = scriptedGit(
      withTags(
        {
          [LS_REMOTE]: { output: `${mainRev}\trefs/heads/main\n` },
          [LOCAL_MAIN]: { output: localRev },
          [countCommand(BUILD.rev as string, mainRev)]: { error: 'bad object' },
          [FETCH_MAIN]: { error: 'Could not resolve host: github.com' },
          [countCommand(BUILD.rev as string, localRev)]: { output: '7\n' },
          [logCommand(localRev)]: { output: '2026-09-21T12:00:00.000Z\n' },
        },
        {
          remote: { error: 'Could not resolve host: github.com' },
          local: { output: 'v1.0.1\n' },
        },
      ),
    );
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.originMainRev).toBe(localRev);
    expect(view.commitsBehind).toBe(7);
    expect(view.checkError).toContain('origin/main objects not local');
  });

  it('never invents a count when neither remote nor local origin/main can be read', async () => {
    const { runGit } = scriptedGit(
      withTags(
        {
          [LS_REMOTE]: { error: 'no such remote' },
          [LOCAL_MAIN]: { error: 'unknown revision' },
        },
        {
          remote: { error: 'no such remote' },
          local: { error: 'no tags' },
        },
      ),
    );
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.originMainRev).toBeNull();
    expect(view.commitsBehind).toBeNull();
    expect(view.latestTag).toBeNull();
    expect(view.updateAvailable).toBeNull();
    expect(view.checkError).toContain('no local origin/main ref');
  });

  it('renders an unknown build revision (missing artifact) without pretending a count', async () => {
    const mainRev = 'f'.repeat(40);
    const { runGit } = scriptedGit({
      [LS_REMOTE]: { output: `${mainRev}\trefs/heads/main\n` },
      [LOCAL_MAIN]: { output: mainRev },
      [LS_REMOTE_TAGS]: { output: `${'c'.repeat(40)}\trefs/tags/v1.0.2\n` },
      [logCommand(mainRev)]: { output: '2026-09-22T08:00:00.000Z\n' },
    });
    const unknown = new DeployDriftTracker({
      repoRoot: '/repo',
      build: { rev: null, committedAt: null, builtAt: null },
      runGit,
    });
    const view = await unknown.refresh();
    expect(view.buildRev).toBeNull();
    expect(view.commitsBehind).toBeNull();
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

  it('coalesces overlapping refreshes into one git run', async () => {
    let runs = 0;
    const mainRev = 'b'.repeat(40);
    const runGit: GitRunner = async (args) => {
      runs += 1;
      const key = args.join(' ');
      if (key === LS_REMOTE) return `${mainRev}\trefs/heads/main\n`;
      if (key === LOCAL_MAIN) return BUILD.rev ?? '';
      if (key === countCommand(BUILD.rev as string, mainRev)) return '1\n';
      if (key === logCommand(mainRev)) return '2026-09-22T08:00:00.000Z\n';
      if (key === LS_REMOTE_TAGS) return `${'c'.repeat(40)}\trefs/tags/v1.0.2\n`;
      if (key === mergedTags(BUILD.rev as string)) return 'v1.0.1\n';
      throw new Error(`unexpected git call: ${key}`);
    };
    const tracker = new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit });
    const [first, second] = await Promise.all([tracker.refresh(), tracker.refresh()]);
    expect(first).toEqual(second);
    expect(runs).toBe(6); // one ls-remote each for main/tags, local main, count, log, merged tags
    expect(first.updateAvailable).toBe(true);
  });

  it('start() schedules background checks and stop() clears the timer (injectable cadence)', async () => {
    let refreshes = 0;
    const mainRev = 'b'.repeat(40);
    const tracker = new DeployDriftTracker({
      repoRoot: '/repo',
      build: BUILD,
      intervalMs: 20,
      runGit: async (args) => {
        const key = args.join(' ');
        if (key === LS_REMOTE) {
          refreshes += 1;
          return `${mainRev}\trefs/heads/main\n`;
        }
        if (key === LOCAL_MAIN) return BUILD.rev ?? '';
        if (key === countCommand(BUILD.rev as string, mainRev)) return '2\n';
        if (key === logCommand(mainRev)) return '2026-09-22T08:00:00.000Z\n';
        if (key === LS_REMOTE_TAGS) return `${'c'.repeat(40)}\trefs/tags/v1.0.1\n`;
        if (key === mergedTags(BUILD.rev as string)) return 'v1.0.1\n';
        throw new Error(`unexpected git call: ${key}`);
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

describe('release tags — the update signal a self-hosted operator can read', () => {
  function tagsView(
    remoteTags: ScriptEntry | readonly ScriptEntry[],
    merged: string,
    localTags?: ScriptEntry,
  ): Promise<DeployDriftView> {
    const mainRev = 'b'.repeat(40);
    const { runGit } = scriptedGit(
      withTags(
        {
          [LS_REMOTE]: { output: `${mainRev}\trefs/heads/main\n` },
          [LOCAL_MAIN]: { output: mainRev },
          [countCommand(BUILD.rev as string, mainRev)]: { output: '4\n' },
          [logCommand(mainRev)]: { output: '2026-09-22T08:00:00.000Z\n' },
        },
        { remote: remoteTags, merged: { output: merged }, ...(localTags === undefined ? {} : { local: localTags }) },
      ),
    );
    return new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
  }

  it('names the newest origin release and flags an update when the build is older', async () => {
    const view = await tagsView(
      {
        output: [
          `${'1'.repeat(40)}\trefs/tags/v1.0.1`,
          `${'2'.repeat(40)}\trefs/tags/v1.0.1^{}`,
          `${'3'.repeat(40)}\trefs/tags/v1.0.2`,
          `${'4'.repeat(40)}\trefs/tags/v1.0.2^{}`,
        ].join('\n'),
      },
      'v1.0.1\n',
    );
    expect(view.latestTag).toBe('v1.0.2');
    expect(view.buildTag).toBe('v1.0.1');
    expect(view.updateAvailable).toBe(true);
    expect(view.checkError).toBeNull();
  });

  it('orders tags numerically — v1.0.10 beats v1.0.9', async () => {
    const view = await tagsView(
      { output: `${'1'.repeat(40)}\trefs/tags/v1.0.10\n${'2'.repeat(40)}\trefs/tags/v1.0.9\n` },
      'v1.0.9\n',
    );
    expect(view.latestTag).toBe('v1.0.10');
    expect(view.updateAvailable).toBe(true);
  });

  it('ignores prereleases and bookkeeping tags on both sides', async () => {
    const view = await tagsView(
      {
        output: [
          `${'1'.repeat(40)}\trefs/tags/v1.1.0-rc1`,
          `${'2'.repeat(40)}\trefs/tags/backup-pre-rebase`,
          `${'3'.repeat(40)}\trefs/tags/v1.0.1`,
        ].join('\n'),
      },
      'v1.0.1\nbackup-pre-rebase\nv1.0.0-rc2\n',
    );
    expect(view.latestTag).toBe('v1.0.1');
    expect(view.buildTag).toBe('v1.0.1');
    expect(view.updateAvailable).toBe(false);
  });

  it('stays quiet (unknown) when the build contains no readable release tag', async () => {
    const view = await tagsView({ output: `${'1'.repeat(40)}\trefs/tags/v1.0.2\n` }, 'backup-pre-rebase\n');
    expect(view.latestTag).toBe('v1.0.2');
    expect(view.buildTag).toBeNull();
    expect(view.updateAvailable).toBeNull();
  });

  it('falls back to the last fetched tags when origin is unreachable, and says so', async () => {
    const view = await tagsView(
      { error: 'Could not resolve host: github.com' },
      'v1.0.0\n',
      { output: 'v1.0.0\nv1.0.1\n' },
    );
    expect(view.latestTag).toBe('v1.0.1');
    expect(view.buildTag).toBe('v1.0.0');
    expect(view.updateAvailable).toBe(true);
    expect(view.checkError).toContain('release tags: origin unreachable');
    expect(view.checkError).toContain('using last fetched tags');
  });

  it('never invents an update when no tag list can be read', async () => {
    const view = await tagsView(
      { error: 'no such remote' },
      'v1.0.0\n',
      { error: 'no tags' },
    );
    expect(view.latestTag).toBeNull();
    expect(view.buildTag).toBe('v1.0.0');
    expect(view.updateAvailable).toBeNull();
    expect(view.checkError).toContain('release tags unavailable');
  });
});

describe('release tag parsing', () => {
  it('accepts only stable vX.Y.Z', () => {
    expect(parseReleaseTag('v1.2.3')).not.toBeNull();
    expect(parseReleaseTag('v1.2.3-rc1')).toBeNull();
    expect(parseReleaseTag('1.2.3')).toBeNull();
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
