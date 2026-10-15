import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import type { FixtureRepo } from './fixture-repo.js';

/**
 * Reaping git-shim fixtures (R7-19, R8-20, R8-23, R9-13, R9-18, R9-19).
 * Every shim invocation appends "<pid> <pgid> <start-time>" to a registry;
 * whatever an assertion skipped, a recorded wrapper and its group are
 * SIGKILLed — and proven gone — before any marker, directory or
 * registration is deleted. A record is signalled only while its wrapper
 * (the group's anchor) is provably the SAME process that wrote it: same
 * pid, same group, same start time. A retired record whose numbers may have
 * been reused is never signalled; when its group is still present the
 * reaper reports it as unproven instead. This worker's OWN group is never
 * signalled, so a reaper that cannot establish it refuses to run.
 */

/** This process's own process group. A failed or malformed answer throws
 * (R8-23): a reaper that does not know its own group could SIGKILL it. */
export function discoverOwnGroup(
  query: () => Pick<SpawnSyncReturns<string>, 'status' | 'stdout'> = () =>
    spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }),
): number {
  const answer = query();
  const text = typeof answer.stdout === 'string' ? answer.stdout.trim() : '';
  const pgid = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
  if (answer.status !== 0 || !Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new Error(`cannot establish this worker's process group (ps status ${String(answer.status)}, output ${JSON.stringify(text)}) — reaping shims would be unsafe`);
  }
  return pgid;
}

export interface ProcessIdentity {
  readonly pgid: number;
  /** Start time with whitespace removed (`ps -o lstart=`). */
  readonly started: string;
}

export interface ReapSeams {
  readonly kill: (target: number, signal: NodeJS.Signals | 0) => void;
  /** Does `target` (a pid, or -pgid for a group) still exist? */
  readonly exists: (target: number) => boolean;
  readonly sleep: (ms: number) => void;
  /** Who is alive at `pid` right now? null when nobody. */
  readonly identity: (pid: number) => ProcessIdentity | null;
}

const DEFAULT_SEAMS: ReapSeams = {
  kill: (target, signal) => {
    process.kill(target, signal);
  },
  exists: (target) => {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  },
  sleep: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
  identity: (pid) => {
    const answer = spawnSync('/bin/ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], { encoding: 'utf8' });
    const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(answer.stdout);
    if (answer.status !== 0 || match === null) return null;
    return { pgid: Number(match[1]), started: match[2]!.replace(/\s+/gu, '') };
  },
};

export interface ReapOutcome {
  /** Targets we owned and signalled that are still present. */
  readonly survivors: readonly number[];
  /** Records whose group is still present but whose ownership cannot be
   * proven (wrapper gone or replaced, record malformed). Never signalled. */
  readonly unproven: readonly string[];
}

interface ShimRecord {
  readonly pid: number;
  readonly pgid: number;
  readonly started: string;
}

function parseRecord(line: string): ShimRecord | null {
  const [pidText, pgidText, ...rest] = line.trim().split(/\s+/u);
  const pid = Number(pidText);
  const pgid = Number(pgidText);
  const started = rest.join('');
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid <= 0 || started === '') return null;
  return { pid, pgid, started };
}

/** SIGKILL every recorded wrapper and group whose ownership is proven
 * (never `ownGroup`), then wait up to `settleMs` for all of them to be
 * gone. Records whose ownership cannot be proven are not signalled. */
export function reapShimRegistries(
  registries: readonly string[],
  ownGroup: number,
  seams: ReapSeams = DEFAULT_SEAMS,
  settleMs = 2_000,
): ReapOutcome {
  if (!Number.isSafeInteger(ownGroup) || ownGroup <= 0) throw new Error(`refusing to reap with an unknown own group (${ownGroup})`);
  const targets = new Set<number>();
  const unprovenGroups = new Map<number, string>();
  const malformed: string[] = [];
  for (const registry of registries) {
    let lines: string[] = [];
    try {
      lines = readFileSync(registry, 'utf8').split('\n').filter((line) => line.trim() !== '');
    } catch {
      continue; // never invoked
    }
    for (const line of lines) {
      const record = parseRecord(line);
      if (record === null) {
        malformed.push(`${registry}: unreadable record ${JSON.stringify(line)}`);
        continue;
      }
      const { pid, pgid, started } = record;
      const live = seams.identity(pid);
      const anchored = live !== null && live.pgid === pgid && live.started === started;
      if (anchored) {
        if (pid !== process.pid) targets.add(pid);
        if (pgid !== ownGroup) targets.add(-pgid);
      } else if (pgid !== ownGroup) {
        const why = live === null ? 'wrapper ended' : 'wrapper id reused by another process';
        unprovenGroups.set(pgid, `${registry}: group ${pgid} (${why}; pid ${pid})`);
      }
    }
  }
  for (const target of targets) {
    try {
      seams.kill(target, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + settleMs;
  let left = [...targets].filter((target) => seams.exists(target));
  // A retired group that is already empty is nothing to prove; one that is
  // still present gets the same settle window, then is reported unsignalled.
  let unclear = [...unprovenGroups.keys()].filter((pgid) => !targets.has(-pgid) && seams.exists(-pgid));
  while ((left.length > 0 || unclear.length > 0) && Date.now() < deadline) {
    seams.sleep(25);
    left = left.filter((target) => seams.exists(target));
    unclear = unclear.filter((pgid) => seams.exists(-pgid));
  }
  return { survivors: left, unproven: [...malformed, ...unclear.map((pgid) => unprovenGroups.get(pgid)!)] };
}

export interface FixtureCleanupOptions {
  readonly ownGroup: number;
  readonly seams?: ReapSeams;
  readonly settleMs?: number;
  /** Test seam for pid-file kills (default: process.kill). */
  readonly killPid?: (pid: number) => void;
}

/** The one cleanup hook shared by shim-spawning test files. Order matters
 * (R9-13): survivors are proven gone BEFORE any marker, directory or
 * registration is deleted; when that cannot be proven everything is kept
 * and the failure names the paths. */
export interface FixtureCleanup {
  trackRegistry(path: string): void;
  trackPidFile(path: string): void;
  trackDir(path: string): void;
  trackRepo(repo: FixtureRepo): void;
  /** The afterEach body. */
  run(): void;
}

export function createFixtureCleanup(options: FixtureCleanupOptions): FixtureCleanup {
  const registries: string[] = [];
  const pidFiles: string[] = [];
  const dirs: string[] = [];
  const repos: FixtureRepo[] = [];
  const killPid = options.killPid ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  return {
    trackRegistry: (path) => void registries.push(path),
    trackPidFile: (path) => void pidFiles.push(path),
    trackDir: (path) => void dirs.push(path),
    trackRepo: (repo) => void repos.push(repo),
    run() {
      // Test-owned children first: their pid files are our own evidence.
      for (const pidFile of pidFiles) {
        let pid = Number.NaN;
        try {
          pid = Number(readFileSync(pidFile, 'utf8').trim());
        } catch {
          /* never written */
        }
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        try {
          killPid(pid);
        } catch {
          /* already gone */
        }
      }
      const { survivors, unproven } = reapShimRegistries(registries, options.ownGroup, options.seams, options.settleMs);
      if (survivors.length > 0 || unproven.length > 0) {
        throw new Error(
          `git-shim fixtures not proven stopped — markers, directories and registrations kept: survivors [${survivors.join(', ')}]; unproven [${unproven.join('; ')}]; registries [${registries.join(', ')}]`,
        );
      }
      registries.length = 0;
      pidFiles.length = 0;
      while (repos.length > 0) repos.pop()?.cleanup();
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}
