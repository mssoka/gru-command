import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Reaping git-shim fixtures (R7-19, R8-20, R8-23). Every shim invocation
 * appends "<pid> <pgid>" to a registry; whatever an assertion skipped, the
 * recorded wrapper, its group and that group's descendants are SIGKILLed —
 * and proven gone — before the registry is deleted. This worker's OWN group
 * is never signalled, so a reaper that cannot establish it refuses to run.
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

export interface ReapSeams {
  readonly kill: (target: number, signal: NodeJS.Signals | 0) => void;
  /** Does `target` (a pid, or -pgid for a group) still exist? */
  readonly exists: (target: number) => boolean;
  readonly sleep: (ms: number) => void;
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
};

/** SIGKILL every recorded wrapper and group (never `ownGroup`), then wait
 * up to `settleMs` for all of them to be gone. Returns the targets still
 * present — empty when every one is proven stopped. */
export function reapShimRegistries(
  registries: readonly string[],
  ownGroup: number,
  seams: ReapSeams = DEFAULT_SEAMS,
  settleMs = 2_000,
): number[] {
  if (!Number.isSafeInteger(ownGroup) || ownGroup <= 0) throw new Error(`refusing to reap with an unknown own group (${ownGroup})`);
  const targets = new Set<number>();
  for (const registry of registries) {
    let lines: string[] = [];
    try {
      lines = readFileSync(registry, 'utf8').trim().split('\n');
    } catch {
      continue; // never invoked
    }
    for (const line of lines) {
      const [pid, pgid] = line.trim().split(/\s+/u).map(Number);
      if (pgid !== undefined && Number.isSafeInteger(pgid) && pgid > 0 && pgid !== ownGroup) targets.add(-pgid);
      if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) targets.add(pid);
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
  while (left.length > 0 && Date.now() < deadline) {
    seams.sleep(25);
    left = left.filter((target) => seams.exists(target));
  }
  return left;
}
