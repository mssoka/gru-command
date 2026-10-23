import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';

/**
 * Lane provenance (#486). Every session GC spawns in a registered lane
 * carries the lane's token in its environment, and so does every process
 * its tool calls start: a daemon that double-forks or is reparented to
 * pid 1 still inherits it. A process rooted in the lane that carries the
 * lane's own token is the lane's, and GC stops it without asking; any other
 * process rooted there keeps the pause-and-ask.
 *
 * The token is random per lane incarnation (a `worktrees` row) and lives on
 * that row. It is provenance, not a secret: a process that could forge it
 * already runs as the same user and could signal the process itself.
 */

/** The lane's random token, exact-matched at sweep and at kill time. */
export const LANE_TOKEN_ENV = 'GRU_LANE_TOKEN';
/** The lane's job id (absent for a review lane with no job). */
export const LANE_JOB_ENV = 'GRU_LANE_JOB';

const TOKEN = /^[0-9a-f]{32}$/u;

/** Who a spawned session's processes belong to. */
export interface LaneProvenance {
  /** The lane's registry id (job, round or child id). */
  readonly laneId: string;
  readonly jobId: string | null;
  readonly token: string;
}

/** A fresh token for a new lane incarnation (128 random bits, hex). */
export function newLaneToken(): string {
  return randomBytes(16).toString('hex');
}

export function isLaneToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

/** The variables a lane's session (and everything it starts) carries. */
export function laneProvenanceEnv(lane: LaneProvenance): Readonly<Record<string, string>> {
  if (!isLaneToken(lane.token)) throw new Error(`lane ${lane.laneId} has no valid lane token`);
  return { [LANE_TOKEN_ENV]: lane.token, ...(lane.jobId !== null ? { [LANE_JOB_ENV]: lane.jobId } : {}) };
}

/** The lane a session spawned at `cwd` belongs to: the lane not yet
 * swept whose registered path is exactly that cwd (GC spawns sessions at
 * their lane's registered path), or null. A live lane with no token (its
 * row was written without one) is logged, never guessed. */
export function laneProvenanceFromLedger(
  ledger: Pick<LedgerApi, 'findLiveWorktreeAtPath'>,
  log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void,
): (cwd: string) => LaneProvenance | null {
  return (cwd) => {
    const lane = ledger.findLiveWorktreeAtPath(cwd);
    if (lane === null) return null;
    if (lane.laneToken === null) {
      log('warn', 'lane has no token: its session carries none, and what it leaves running is asked about at its sweep', { id: lane.id, path: lane.path });
      return null;
    }
    return { laneId: lane.id, jobId: lane.jobId, token: lane.laneToken };
  };
}

/** Whether an environment carries lane variables (GC itself inherited them
 * when it was started from inside a lane). */
export function carriesLaneEnv(env: NodeJS.ProcessEnv): boolean {
  return env[LANE_TOKEN_ENV] !== undefined || env[LANE_JOB_ENV] !== undefined;
}

/** `env` without lane variables: a session carries only the lane GC
 * assigned it, never one GC inherited. */
export function withoutLaneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { [LANE_TOKEN_ENV]: _token, [LANE_JOB_ENV]: _job, ...rest } = env;
  return rest;
}

/** What GC could read of one process's environment: the lane token it
 * carries (null: none), or `readable: false` when the platform hides it
 * (macOS shows no environment for a system binary such as `/bin/sh`;
 * Linux hides a non-dumpable process's) or the process is gone. */
export type LaneTokenRead =
  | { readonly readable: true; readonly token: string | null }
  | { readonly readable: false };

/** A process to read, with the command line its listing showed. */
export interface ListedProcess {
  readonly pid: number;
  readonly command: string;
}

/** Reads the lane tokens of listed processes (seam for tests). */
export type LaneTokenReader = (processes: readonly ListedProcess[]) => Promise<ReadonlyMap<number, LaneTokenRead>>;

/** The token an environment block carries, or null. A malformed value is
 * no token. */
function tokenIn(entries: readonly string[]): string | null {
  const prefix = `${LANE_TOKEN_ENV}=`;
  const entry = entries.find((candidate) => candidate.startsWith(prefix));
  const value = entry?.slice(prefix.length) ?? null;
  return value !== null && isLaneToken(value) ? value : null;
}

/** `ps` output even when it exits 1 because some pid is gone. */
function psOutput(args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile('ps', [...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => {
        if (error === null) resolveOut(stdout);
        else if (!error.killed && typeof error.code === 'number' && error.code === 1) resolveOut(stdout);
        else reject(new Error(error.killed ? `ps timed out after ${String(timeoutMs)} ms` : `ps failed: ${error.message.split('\n')[0] ?? ''}`));
      });
  });
}

/** Lines of `ps -o pid=,…` output, keyed by pid. */
function byPid(out: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/u.exec(line);
    if (match !== null) lines.set(Number(match[1]), match[2] ?? '');
  }
  return lines;
}

/**
 * The lane tokens of `processes`, read now: `/proc/<pid>/environ` on
 * Linux, `ps -E` on macOS (its environment follows the command line, which
 * must still be the one the listing showed: a process that exec'd since,
 * or a recycled pid, reads as unreadable). Any other platform reads
 * nothing, so no process there is ever reaped by its token.
 */
export async function readLaneTokens(processes: readonly ListedProcess[], timeoutMs = 30_000): Promise<ReadonlyMap<number, LaneTokenRead>> {
  const reads = new Map<number, LaneTokenRead>();
  if (processes.length === 0) return reads;
  if (process.platform === 'linux') {
    for (const { pid } of processes) {
      try {
        const environ = await readFile(`/proc/${String(pid)}/environ`, 'utf-8');
        reads.set(pid, { readable: true, token: tokenIn(environ.split('\0')) });
      } catch {
        reads.set(pid, { readable: false });
      }
    }
    return reads;
  }
  if (process.platform !== 'darwin') {
    for (const { pid } of processes) reads.set(pid, { readable: false });
    return reads;
  }
  const lines = byPid(await psOutput(['-E', '-ww', '-o', 'pid=,command=', '-p', processes.map(({ pid }) => String(pid)).join(',')], timeoutMs));
  for (const { pid, command } of processes) {
    const line = lines.get(pid)?.trim();
    if (line === undefined || !(line === command || line.startsWith(`${command} `))) {
      reads.set(pid, { readable: false });
      continue;
    }
    const environment = line.slice(command.length).trim();
    // ps prints the entries space-separated; only the token's own entry is
    // read, so a value holding spaces elsewhere does not matter.
    reads.set(pid, environment === '' ? { readable: false } : { readable: true, token: tokenIn(environment.split(' ')) });
  }
  return reads;
}

/** What the owner's card says about a process GC would not stop. */
export interface ProcessFacts {
  /** The executable's name (`agent-browser`), or, for one inside a macOS
   * app bundle, the outermost bundle's (a Chrome helper is `Google Chrome`). */
  readonly name: string;
  /** When it started (ISO, to the second), null when unknown. */
  readonly startedAt: string | null;
}

/** The name the card groups a process under: the outermost `.app`
 * bundle of its executable's path when it has one (its helpers then group
 * with it), else the executable's basename. */
export function processName(executable: string): string {
  const bundle = /(?:^|\/)([^/]+)\.app\//u.exec(executable)?.[1];
  if (bundle !== undefined) return bundle;
  return executable.slice(executable.lastIndexOf('/') + 1) || executable;
}

/** `[[dd-]hh:]mm:ss` elapsed time in seconds, null when unparseable. */
export function elapsedSeconds(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(etime.trim());
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** The executable name and start time of each pid still running (best
 * effort: display only, never a reason to signal anything). */
export async function readProcessFacts(pids: readonly number[], now = Date.now(), timeoutMs = 30_000): Promise<ReadonlyMap<number, ProcessFacts>> {
  const facts = new Map<number, ProcessFacts>();
  if (pids.length === 0) return facts;
  let out: string;
  try {
    out = await psOutput(['-ww', '-o', 'pid=,etime=,comm=', '-p', pids.map(String).join(',')], timeoutMs);
  } catch {
    return facts;
  }
  for (const [pid, rest] of byPid(out)) {
    const match = /^\s*(\S+)\s+(.*)$/u.exec(rest);
    if (match === null) continue;
    const elapsed = elapsedSeconds(match[1] ?? '');
    facts.set(pid, {
      name: processName((match[2] ?? '').trim()),
      startedAt: elapsed === null ? null : new Date(Math.floor(now / 1000) * 1000 - elapsed * 1000).toISOString().replace('.000Z', 'Z'),
    });
  }
  return facts;
}
