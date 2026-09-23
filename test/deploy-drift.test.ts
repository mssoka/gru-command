import { describe, expect, it } from 'vitest';
import {
  DeployDriftTracker,
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
const LOCAL_MAIN = 'rev-parse --verify --quiet refs/remotes/origin/main';
const FETCH_MAIN = 'fetch --quiet origin main';

function countCommand(buildRev: string, mainRev: string): string {
  return `rev-list --count ${buildRev}..${mainRev}`;
}

function logCommand(rev: string): string {
  return `log -1 --format=%cI ${rev}`;
}

describe('deploy drift — running build vs origin/main', () => {
  it('counts the commits origin/main has beyond the build (43-commit incident shape)', async () => {
    const mainRev = 'b'.repeat(40);
    const { runGit } = scriptedGit({
      [LS_REMOTE]: { output: `${mainRev}\trefs/heads/main\n` },
      [LOCAL_MAIN]: { output: BUILD.rev ?? '' },
      [countCommand(BUILD.rev as string, mainRev)]: { output: '43\n' },
      [logCommand(mainRev)]: { output: '2026-09-22T08:00:00.000Z\n' },
    });
    const tracker = new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit });
    const view = await tracker.refresh();
    expect(view).toMatchObject({
      buildRev: BUILD.rev,
      buildCommittedAt: BUILD.committedAt,
      originMainRev: mainRev,
      originMainCommittedAt: '2026-09-22T08:00:00.000Z',
      commitsBehind: 43,
      checkError: null,
    });
    expect(view.checkedAt).not.toBeNull();
    expect(tracker.view()).toEqual(view);
  });

  it('reports zero behind when the build is current', async () => {
    const { runGit } = scriptedGit({
      [LS_REMOTE]: { output: `${BUILD.rev}\trefs/heads/main\n` },
      [LOCAL_MAIN]: { output: BUILD.rev ?? '' },
      [countCommand(BUILD.rev as string, BUILD.rev as string)]: { output: '0\n' },
      [logCommand(BUILD.rev as string)]: { output: '2026-09-20T10:00:00.000Z\n' },
    });
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
    });
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.originMainRev).toBe(localRev);
    expect(view.commitsBehind).toBe(5);
    expect(view.checkError).toContain('origin unreachable');
    expect(calls).not.toContain(FETCH_MAIN);
  });

  it('fetches once when origin/main is remote-known but not local, then counts against remote truth', async () => {
    const mainRev = 'd'.repeat(40);
    const { runGit, calls } = scriptedGit({
      [LS_REMOTE]: { output: `${mainRev}\trefs/heads/main\n` },
      [LOCAL_MAIN]: { output: 'e'.repeat(40) },
      [countCommand(BUILD.rev as string, mainRev)]: [
        { error: 'bad object' }, // not fetched yet
        { output: '9\n' }, // after fetch
      ],
      [FETCH_MAIN]: { output: '' },
      [logCommand(mainRev)]: { output: '2026-09-22T07:00:00.000Z\n' },
    });
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
    });
    const view = await new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit }).refresh();
    expect(view.originMainRev).toBeNull();
    expect(view.commitsBehind).toBeNull();
    expect(view.checkError).toContain('no local origin/main ref');
  });

  it('renders an unknown build revision (missing artifact) without pretending a count', async () => {
    const { runGit } = scriptedGit({
      [LS_REMOTE]: { output: `${'f'.repeat(40)}\trefs/heads/main\n` },
      [LOCAL_MAIN]: { output: 'f'.repeat(40) },
      [logCommand('f'.repeat(40))]: { output: '2026-09-22T08:00:00.000Z\n' },
    });
    const unknown = new DeployDriftTracker({
      repoRoot: '/repo',
      build: { rev: null, committedAt: null, builtAt: null },
      runGit,
    });
    const view = await unknown.refresh();
    expect(view.buildRev).toBeNull();
    expect(view.commitsBehind).toBeNull();
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
      throw new Error(`unexpected git call: ${key}`);
    };
    const tracker = new DeployDriftTracker({ repoRoot: '/repo', build: BUILD, runGit });
    const [first, second] = await Promise.all([tracker.refresh(), tracker.refresh()]);
    expect(first).toEqual(second);
    expect(runs).toBe(4); // one ls-remote, one local rev-parse, one count, one log
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
