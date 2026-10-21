import { execFile, execFileSync } from 'node:child_process';
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
 * - the marker's host is gone: its pid is dead, or the process now holding
 *   it has a different start identity than the one the marker recorded (a
 *   reused pid, or this service restarted under the same pid). A marker
 *   with no identity under a live foreign pid cannot be told apart and
 *   refuses;
 * - no live process is rooted (argv or cwd) in the round's review worktree;
 * - no live process names one of the round's session ids (a Claude review
 *   CLI carries `--session-id`/`--resume <id>` in argv);
 * - no session lock of the round is held by this process, or by a live pid
 *   other than the gone host.
 *
 * Evidence that cannot be read refuses, naming the file to clear where
 * there is one; every later review request re-checks.
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
  /** The start identities compared (`pid-reused`, `restarted`): the one the
   * marker recorded and the one now holding the pid. */
  readonly markerIdentity?: string | null;
  readonly observedIdentity?: string | null;
}

export type ReviewHostExitResult =
  | { readonly ok: true; readonly evidence: ReviewHostExitEvidence }
  | { readonly ok: false; readonly problem: string };

export interface ReviewHostExitProbes {
  readonly pidState: (pid: number) => 'dead' | 'alive' | 'unknown';
  /** The start identity of the process now holding `pid`, or null. */
  readonly processIdentity: (pid: number) => Promise<string | null>;
  readonly processTable: () => Promise<ProcessTable>;
  /** The session directory a review session rooted at `cwd` writes to. */
  readonly sessionDir: (cwd: string) => string;
  readonly lockFileFor: (sessionFile: string) => string;
  /** Whether THIS process holds the session's lock. */
  readonly heldHere: (sessionFile: string) => boolean;
}

const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u;

/** The start time in clock ticks since boot from one `/proc/<pid>/stat`
 * line: field 22, counted past the parenthesized name (which may itself hold
 * spaces or parentheses). */
export function linuxStartTicks(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const ticks = stat.slice(close + 2).split(' ')[19];
  return ticks !== undefined && /^\d+$/u.test(ticks) ? ticks : null;
}

/** Linux: the boot id and the start ticks of `/proc/<pid>/stat`. */
function linuxIdentity(pid: number): string | null {
  try {
    const ticks = linuxStartTicks(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'));
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return ticks === null || boot === '' ? null : `linux:${boot}:${ticks}`;
  } catch {
    return null;
  }
}

/** macOS keeps a process's start as an absolute time, which `ps` prints in
 * the zone it is given: read in UTC it never moves. (The BSDs derive it
 * from a boot time a clock step adjusts, so they get no identity.) */
const PS = '/bin/ps';
const PS_START = ['-o', 'lstart=', '-p'] as const;
const PS_ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C' };

/** A clock-free start identity for the process now holding `pid`: Linux's
 * boot id and start ticks, or macOS's UTC `ps -o lstart`. Null when it
 * cannot be read, or on any other platform. */
export async function processIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'linux') return linuxIdentity(pid);
  if (process.platform !== 'darwin') return null;
  return new Promise((resolve) => {
    execFile(PS, [...PS_START, String(pid)], { encoding: 'utf8', timeout: 10_000, env: PS_ENV }, (error, stdout) => {
      const started = error === null ? stdout.trim() : '';
      resolve(started === '' ? null : `ps:${started}`);
    });
  });
}

let ownIdentity: string | undefined;

/** This process's start identity, read synchronously (the owner marker is
 * written where setup must not yield) and kept once read. A failed read is
 * retried at the next call, never cached; the service reads it at boot so a
 * failure is reported there. */
export function thisProcessIdentity(): string | null {
  if (ownIdentity !== undefined) return ownIdentity;
  let read: string | null = null;
  if (process.platform === 'linux') {
    read = linuxIdentity(process.pid);
  } else if (process.platform === 'darwin') {
    try {
      const started = execFileSync(PS, [...PS_START, String(process.pid)], { encoding: 'utf8', timeout: 10_000, env: PS_ENV }).trim();
      read = started === '' ? null : `ps:${started}`;
    } catch {
      read = null;
    }
  }
  if (read !== null) ownIdentity = read;
  return read;
}

/** Whether THIS process hosts the marker's owner (its own adapter evidence
 * then decides, never a dead-host proof). Every marker this process writes
 * carries its identity, so one under this pid with another identity, or
 * with none, was left by an earlier process; only when this process cannot
 * read its own identity is a same-pid marker taken as its own. */
export function hostedByThisProcess(marker: ReviewOwnerMarker, own: string | null = thisProcessIdentity()): boolean {
  return marker.pid === process.pid && (own === null || marker.hostIdentity === own);
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

function named(processes: readonly TreeProcess[]): string {
  const shown = processes.slice(0, 5).map((entry) => `pid ${String(entry.pid)} (${entry.evidence})`).join(', ');
  return processes.length > 5 ? `${shown} and ${String(processes.length - 5)} more` : shown;
}

type HostCheck =
  | { readonly gone: ReviewHostExitEvidence['host']; readonly observedIdentity?: string | null }
  | { readonly problem: string };

/** The marker's host is gone: dead, its pid now held by a process with
 * another start identity, or this service restarted under that pid. */
async function hostGone(marker: ReviewOwnerMarker, probes: ReviewHostExitProbes): Promise<HostCheck> {
  const pid = String(marker.pid);
  if (marker.pid === process.pid) return { gone: 'restarted', observedIdentity: thisProcessIdentity() };
  const state = probes.pidState(marker.pid);
  if (state === 'dead') return { gone: 'dead' };
  if (state === 'unknown') return { problem: `its host pid ${pid} cannot be probed` };
  if (marker.hostIdentity === undefined) {
    return { problem: `its host pid ${pid} is still running (the marker records no host identity to tell a reused pid apart); the replacement starts once it exits` };
  }
  const identity = await probes.processIdentity(marker.pid);
  if (identity === null) return { problem: `its host pid ${pid} is alive and its start identity cannot be read` };
  return identity === marker.hostIdentity
    ? { problem: `its host pid ${pid} is still running; the replacement starts once it exits` }
    : { gone: 'pid-reused', observedIdentity: identity };
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
 * left by another dead pid on this host. Only GC writes these locks, and a
 * finished review session is never reopened: a lock naming the gone host's
 * pid is that host's, unless this process holds it. */
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
  if (hostedByThisProcess(marker)) {
    return { ok: false, problem: 'its host is this process, so only its own adapter evidence proves cessation' };
  }
  const host = await hostGone(marker, probes);
  if ('problem' in host) return { ok: false, problem: host.problem };
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
    evidence: {
      worktreePath: input.worktreePath, sessionIds: [...sessions.ids].sort(), sessionFiles: sessions.files.size, host: host.gone,
      ...(host.gone === 'dead' ? {} : { markerIdentity: marker.hostIdentity ?? null, observedIdentity: host.observedIdentity ?? null }),
    },
  };
}
