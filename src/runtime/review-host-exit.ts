import { execFile } from 'node:child_process';
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
 * - the marker's host is gone: its pid is dead, or now names a process that
 *   started after the marker was written (a reused pid), or is this process
 *   restarted under the same pid;
 * - no live process is rooted (argv or cwd) in the round's review worktree;
 * - no live process names one of the round's session ids (a Claude review
 *   CLI carries `--session-id`/`--resume <id>` in argv);
 * - no session lock of the round is held by a live pid other than the gone
 *   host.
 *
 * Evidence that cannot be read refuses, naming what to clear; every later
 * review request re-checks.
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
  /** How the host was found gone. */
  readonly host: 'dead' | 'pid-reused' | 'restarted';
}

export type ReviewHostExitResult =
  | { readonly ok: true; readonly evidence: ReviewHostExitEvidence }
  | { readonly ok: false; readonly problem: string };

export interface ReviewHostExitProbes {
  readonly pidState: (pid: number) => 'dead' | 'alive' | 'unknown';
  /** When the process now holding `pid` started (epoch ms), or null. */
  readonly pidStartedAt: (pid: number) => Promise<number | null>;
  readonly processTable: () => Promise<ProcessTable>;
  /** The session directory a review session rooted at `cwd` writes to. */
  readonly sessionDir: (cwd: string) => string;
  readonly lockFileFor: (sessionFile: string) => string;
  /** Whether THIS process holds the session's lock. */
  readonly heldHere: (sessionFile: string) => boolean;
}

const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;

/** This process's start (epoch ms), from its own uptime. */
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

/** The marker was written by an earlier process that held this same pid:
 * it predates this process's start by more than a second. */
function earlierIncarnation(marker: ReviewOwnerMarker): boolean {
  const recordedAt = marker.recordedAt === undefined ? Number.NaN : Date.parse(marker.recordedAt);
  return marker.pid === process.pid && Number.isFinite(recordedAt) && recordedAt + 1000 < PROCESS_STARTED_AT;
}

/** Whether THIS process hosts the marker's owner (its own adapter evidence
 * then decides, never a dead-host proof). */
export function hostedByThisProcess(marker: ReviewOwnerMarker): boolean {
  return marker.pid === process.pid && !earlierIncarnation(marker);
}

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

/** `ps -o lstart=` (whole seconds, C locale) for one pid; null when it
 * cannot be read. */
export function pidStartedAt(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => {
        const startedAt = error === null ? Date.parse(stdout.trim()) : Number.NaN;
        resolve(Number.isFinite(startedAt) ? startedAt : null);
      });
  });
}

function named(processes: readonly TreeProcess[]): string {
  const shown = processes.slice(0, 5).map((entry) => `pid ${String(entry.pid)} (${entry.evidence})`).join(', ');
  return processes.length > 5 ? `${shown} and ${String(processes.length - 5)} more` : shown;
}

/** The marker's host is gone: dead, its pid reused by a process that
 * started after the marker, or this process restarted under that pid. */
async function hostGone(marker: ReviewOwnerMarker, probes: ReviewHostExitProbes): Promise<ReviewHostExitEvidence['host'] | string> {
  if (earlierIncarnation(marker)) return 'restarted';
  const state = probes.pidState(marker.pid);
  if (state === 'dead') return 'dead';
  const recordedAt = marker.recordedAt === undefined ? Number.NaN : Date.parse(marker.recordedAt);
  if (state === 'alive' && Number.isFinite(recordedAt)) {
    // lstart is whole seconds, never later than the true start: a start
    // after the marker proves a different process holds the pid.
    const startedAt = await probes.pidStartedAt(marker.pid);
    if (startedAt !== null && startedAt > recordedAt) return 'pid-reused';
  }
  return state === 'alive'
    ? `its host pid ${String(marker.pid)} is still running; the replacement starts once it exits`
    : `its host pid ${String(marker.pid)} cannot be probed`;
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

/** A session lock is free when absent, left by the gone host itself, or
 * left by another dead pid on this host. */
function heldLock(sessionFile: string, host: number, probes: ReviewHostExitProbes): string | null {
  const lockFile = probes.lockFileFor(sessionFile);
  if (probes.heldHere(sessionFile)) return `session lock ${lockFile} is held by this process`;
  let holder: { host?: unknown; pid?: unknown };
  try {
    holder = JSON.parse(readFileSync(lockFile, 'utf8')) as { host?: unknown; pid?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `session lock ${lockFile} is unreadable (${String(error)}); remove it once no process holds it`;
  }
  if (typeof holder !== 'object' || holder === null || !Number.isSafeInteger(holder.pid) || (holder.pid as number) <= 0) {
    return `session lock ${lockFile} names no owner pid; remove it once no process holds it`;
  }
  // The host's own lock, whatever hostname it recorded: that host is gone.
  if (holder.pid === host) return null;
  if (holder.host !== hostname()) {
    return `session lock ${lockFile} is held on host ${String(holder.host)}; remove it once no process holds it`;
  }
  const state = probes.pidState(holder.pid as number);
  return state === 'dead' ? null : `session lock ${lockFile} is held by ${state} pid ${String(holder.pid)}`;
}

export async function proveReviewHostExit(input: ReviewHostExitInput, probes: ReviewHostExitProbes): Promise<ReviewHostExitResult> {
  const { marker } = input;
  const host = await hostGone(marker, probes);
  if (host !== 'dead' && host !== 'pid-reused' && host !== 'restarted') return { ok: false, problem: host };
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
  if (rooted.length > 0) {
    return { ok: false, problem: `${named(rooted)} still rooted in review worktree ${input.worktreePath}; the replacement starts once it exits` };
  }
  for (const id of sessions.ids) {
    const naming = table.naming(id);
    if (naming.length > 0) {
      return { ok: false, problem: `${named(naming)} still names review session ${id}; the replacement starts once it exits` };
    }
  }
  for (const file of sessions.files) {
    const held = heldLock(file, marker.pid, probes);
    if (held !== null) return { ok: false, problem: held };
  }
  return {
    ok: true,
    evidence: { worktreePath: input.worktreePath, sessionIds: [...sessions.ids].sort(), sessionFiles: sessions.files.size, host },
  };
}
