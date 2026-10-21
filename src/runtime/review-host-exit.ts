import { readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProcessTable, TreeProcess } from '../worktrees/manager.js';
import type { ReviewOwnerMarker } from './registry.js';

/**
 * The dead-host proof (#464, owner ruling 2026-10-21): a review owner hosted
 * by ANOTHER process that left no durable cessation record (a crash, or a
 * round older than the record) is proven gone only when every check holds.
 * PID death alone is never enough for Claude, whose CLI child can outlive
 * its host:
 *
 * - the marker's host pid is dead;
 * - no live process is rooted (argv or cwd) in the round's review worktree;
 * - no live process names one of the round's session ids (a Claude review
 *   CLI carries `--session-id`/`--resume <id>` in argv);
 * - no session lock of the round is held by a live pid.
 *
 * Evidence that cannot be read refuses; the caller retries on the next
 * review request.
 */

/** What a later process knows of a review owner's sessions. */
export interface ReviewHostExitInput {
  readonly marker: ReviewOwnerMarker;
  /** The round's registered review worktree; it may already be swept. */
  readonly worktreePath: string | null;
  /** The round's registered review sessions. */
  readonly sessions: readonly { readonly agentId: string; readonly sessionFile: string | null }[];
}

/** What a passing proof checked, kept with its durable record. */
export interface ReviewHostExitEvidence {
  readonly worktreePath: string;
  readonly sessionIds: readonly string[];
  readonly sessionFiles: number;
}

export type ReviewHostExitResult =
  | { readonly ok: true; readonly evidence: ReviewHostExitEvidence }
  | { readonly ok: false; readonly problem: string };

export interface ReviewHostExitProbes {
  readonly pidState: (pid: number) => 'dead' | 'alive' | 'unknown';
  readonly processTable: () => Promise<ProcessTable>;
  /** The session directory a review session rooted at `cwd` writes to. */
  readonly sessionDir: (cwd: string) => string;
  readonly lockFileFor: (sessionFile: string) => string;
}

const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;

/** OS liveness: EPERM still proves the pid exists. */
export function pidState(pid: number): 'dead' | 'alive' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? 'dead' : code === 'EPERM' ? 'alive' : 'unknown';
  }
}

function named(processes: readonly TreeProcess[]): string {
  return processes.slice(0, 5).map((entry) => `pid ${String(entry.pid)} (${entry.evidence})`).join(', ');
}

/** Every session the round may own: its registered sessions, plus any
 * session file in their directories (a session spawned just before a crash
 * may never have been registered). */
function roundSessions(input: ReviewHostExitInput, worktreePath: string, probes: ReviewHostExitProbes):
  { readonly ids: ReadonlySet<string>; readonly files: ReadonlySet<string> } | { readonly problem: string } {
  const ids = new Set<string>();
  const files = new Set<string>();
  const dirs = new Set<string>([probes.sessionDir(worktreePath)]);
  for (const session of input.sessions) {
    if (session.agentId.trim() !== '') ids.add(session.agentId);
    if (session.sessionFile !== null) {
      files.add(session.sessionFile);
      dirs.add(dirname(session.sessionFile));
    }
  }
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { problem: `session directory ${dir} cannot be listed (${String(error)})` };
    }
    for (const entry of entries) {
      const id = SESSION_FILE.exec(entry)?.[1];
      if (id === undefined) continue;
      ids.add(id);
      files.add(join(dir, entry));
    }
  }
  return { ids, files };
}

/** A session lock is free when absent, or left by a dead pid on this host. */
function heldLock(sessionFile: string, probes: ReviewHostExitProbes): string | null {
  const lockFile = probes.lockFileFor(sessionFile);
  let holder: { host?: unknown; pid?: unknown };
  try {
    holder = JSON.parse(readFileSync(lockFile, 'utf8')) as { host?: unknown; pid?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `session lock ${lockFile} is unreadable (${String(error)})`;
  }
  if (typeof holder !== 'object' || holder === null || !Number.isSafeInteger(holder.pid) || (holder.pid as number) <= 0) {
    return `session lock ${lockFile} names no owner pid`;
  }
  if (holder.host !== hostname()) return `session lock ${lockFile} is held on host ${String(holder.host)}`;
  const state = probes.pidState(holder.pid as number);
  return state === 'dead' ? null : `session lock ${lockFile} is held by ${state} pid ${String(holder.pid)}`;
}

export async function proveReviewHostExit(input: ReviewHostExitInput, probes: ReviewHostExitProbes): Promise<ReviewHostExitResult> {
  const { marker } = input;
  const host = probes.pidState(marker.pid);
  if (host !== 'dead') return { ok: false, problem: `its host pid ${String(marker.pid)} is ${host === 'alive' ? 'still running' : 'not probeable'}` };
  if (input.worktreePath === null) return { ok: false, problem: `round ${marker.roundId} has no registered review worktree to check` };
  const sessions = roundSessions(input, input.worktreePath, probes);
  if ('problem' in sessions) return { ok: false, problem: sessions.problem };
  let table: ProcessTable;
  try {
    table = await probes.processTable();
  } catch (error) {
    return { ok: false, problem: `the process table cannot be listed (${String(error)})` };
  }
  if (!table.cwdsListed) return { ok: false, problem: 'the working directories of running processes cannot be listed' };
  const rooted = table.rootedIn(input.worktreePath);
  if (rooted.length > 0) return { ok: false, problem: `${named(rooted)} still rooted in review worktree ${input.worktreePath}` };
  for (const id of sessions.ids) {
    const naming = table.naming(id);
    if (naming.length > 0) return { ok: false, problem: `${named(naming)} still names review session ${id}` };
  }
  for (const file of sessions.files) {
    const held = heldLock(file, probes);
    if (held !== null) return { ok: false, problem: held };
  }
  return {
    ok: true,
    evidence: { worktreePath: input.worktreePath, sessionIds: [...sessions.ids].sort(), sessionFiles: sessions.files.size },
  };
}
