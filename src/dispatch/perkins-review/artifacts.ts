import { execFile as execFileCallback, execFileSync, spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { readFile as readFileAsync } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsPromised = promisify(execFileCallback);
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BranchIdleTag } from '../branch-idle.js';
import type { CiEvidenceRecord } from '../../review-inputs/ci-evidence.js';
import {
  freezeEvidenceAttachments,
  REVIEW_EVIDENCE_MAX_FILE_BYTES,
  REVIEW_EVIDENCE_MAX_FILES,
  REVIEW_EVIDENCE_MAX_TOTAL_BYTES,
  type FrozenEvidenceAttachment,
  type FrozenEvidenceRuntimeAttachment,
  type ReviewEvidenceRequest,
} from '../../review-inputs/evidence.js';

const GIT_MAX_BUFFER = 128 * 1024 * 1024;
export const FROZEN_DIFF_MAX_BYTES = 8 * 1024 * 1024;
export const FROZEN_SPEC_MAX_BYTES = 256 * 1024;
export const FROZEN_CONVENTIONS_MAX_BYTES = 256 * 1024;
export const FROZEN_MANIFEST_MAX_BYTES = 256 * 1024;
export const FROZEN_CHANGED_FILES_MAX_BYTES = 256 * 1024;
export const SPECIALIST_CHECKPOINT_MAX_BYTES = 1024 * 1024;

export interface FrozenAcceptance {
  readonly version: number;
  /** sha256 of the original briefing bytes ('' when none was recorded). */
  readonly baseSha256: string;
  /** sha256 of the frozen effective acceptance text. */
  readonly contractSha256: string;
  readonly amendmentIds: readonly string[];
}

export interface FrozenReviewEvidenceManifest {
  /** Frozen attachment metadata (round-relative paths, no bytes). */
  readonly attachments: readonly FrozenEvidenceAttachment[];
  /** The exact-target CI record as bound at freeze, or null when none was
   * requested/recorded. Historical: late results never rewrite it. */
  readonly ci: CiEvidenceRecord | null;
}

export interface FrozenReviewInputs {
  readonly schemaVersion: 2;
  readonly roundId: string;
  /** Absent provenance makes an older manifest ineligible for recovery. */
  readonly recoveryIdentity: ReviewRecoveryIdentity | null;
  readonly repoPath: string;
  readonly targetRef: string;
  readonly baseRef: string;
  readonly targetSha: string;
  readonly baseRefSha: string;
  readonly diffBaseSha: string;
  readonly diffSha256: string;
  readonly specMode: 'supplied' | 'explicit-no-spec';
  readonly specSha256: string;
  readonly conventionsSha256: string;
  readonly changedFilesSha256: string;
  readonly createdAt: string;
  /** Changed file paths of the frozen diff (the whole-PR review unit). */
  readonly changedFiles: readonly string[];
  /** Effective acceptance binding: which contract version/hashes and which
   * amendment ids the frozen spec was rendered from. Present for supplied
   * specs (version 0 = original briefing only). */
  readonly acceptance?: FrozenAcceptance;
  /** Private frozen evidence + exact-target CI, when any was supplied. */
  readonly reviewEvidence?: FrozenReviewEvidenceManifest;
  /** Present only for a `force: true` arm: the branch-idle blockers the
   * override bypassed (the audit tag for a forced round). */
  readonly branchIdle?: BranchIdleTag;
}

export interface ReviewRecoveryIdentity {
  readonly jobId: string;
  readonly policySha256: string;
  readonly runtimeId: string;
  readonly runtimeVersion: string;
  readonly modelRef: string;
  readonly modelRole: string;
  readonly modelSettingsSha256: string;
  /** Entire tracked target tree, including assets not shown in the diff. */
  readonly trackedTreeSha: string;
}

export interface FreezeReviewInput {
  readonly recoveryIdentity?: Omit<ReviewRecoveryIdentity, 'trackedTreeSha'>;
  readonly roundId: string;
  readonly repoPath: string;
  readonly artifactRoot: string;
  readonly baseRef: string;
  readonly targetRef: string;
  /** Symbolic ref observed before the exact target SHA was selected. */
  readonly movementRef?: string;
  readonly spec?: string;
  readonly noSpec?: boolean;
  readonly now?: () => Date;
  /** Forced-arm tag (branch-idle override) recorded in the manifest. */
  readonly branchIdle?: BranchIdleTag;
  /** Owning job id, recorded in the private evidence receipt when known. */
  readonly jobId?: string;
  /** Effective-contract binding: the exact contract text the supplied spec
   * starts with, plus its version/hashes/provenance ids. */
  readonly acceptance?: {
    readonly contractText: string;
    readonly version: number;
    readonly baseSha256: string;
    readonly amendmentIds: readonly string[];
  };
  /** Authorized private evidence attachments to freeze this round. */
  readonly evidence?: readonly ReviewEvidenceRequest[];
  /** The configured service uploads dir (required when evidence is present). */
  readonly evidenceUploadsDir?: string;
  /** Bound exact-target CI record (from the ledger), stored in the manifest. */
  readonly ciEvidence?: CiEvidenceRecord | null;
}

export interface FrozenReview {
  readonly directory: string;
  readonly manifest: FrozenReviewInputs;
  readonly diff: string;
  readonly specContext: string;
  readonly projectConventions: string;
  /** Changed file paths of the complete frozen diff. */
  readonly changedFiles: readonly string[];
  /** Frozen private evidence (empty attachments when none was supplied) and
   * the bound exact-target CI record. */
  readonly evidence: {
    readonly attachments: readonly FrozenEvidenceRuntimeAttachment[];
    readonly ci: CiEvidenceRecord | null;
  };
}

function gitRaw(
  repoPath: string,
  args: readonly string[],
  timeoutMs = 30_000,
  killSignal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
  /** Diagnostics in the C locale, so an expected refusal is recognized by
   * git's own words. */
  cLocale = false,
): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout: timeoutMs,
    killSignal,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: repositoryGitEnv(cLocale),
  });
}

/** The exit code and diagnostics of a failed git step — async (`code`) or
 * sync (`status`) alike. A spawn failure or a kill has no numeric code. */
function gitFailure(error: unknown): { readonly code: number | null; readonly stderr: string } {
  const failed = error as { code?: unknown; status?: unknown; stderr?: unknown; message?: unknown } | null;
  const code = typeof failed?.code === 'number' ? failed.code : typeof failed?.status === 'number' ? failed.status : null;
  const stderr = typeof failed?.stderr === 'string' && failed.stderr !== ''
    ? failed.stderr
    : Buffer.isBuffer(failed?.stderr) && failed.stderr.length > 0
      ? failed.stderr.toString('utf8')
      : typeof failed?.message === 'string' ? failed.message : '';
  return { code, stderr };
}

/** `git check-ref-format --branch <name>` refused THIS NAME — git's own
 * complete invalid-name diagnostic for exactly this spelling (exit 128, C
 * locale). Any other failure — an unreadable repository also exits 128, and
 * its path may even contain those words — is operational; so is a
 * diagnostic cut at its bound (R7-2): the lost tail could be the
 * operational part. */
export function refusedBranchName(error: unknown, name: string): boolean {
  if ((error as { stderrTruncated?: unknown } | null)?.stderrTruncated === true) return false;
  const { code, stderr } = gitFailure(error);
  // The WHOLE diagnostic, with at most its terminal newline: a refusal line
  // embedded in a longer (operational) diagnostic proves nothing.
  return code === 128 && stderr.replace(/\n$/u, '') === `fatal: '${name}' is not a valid branch name`;
}

/** `git rev-parse --verify <ref>^{commit}` found no such commit — git's own
 * complete diagnostic (exit 128, C locale). Any other failure, a cut
 * diagnostic included, is operational (R8-11): a timeout, spawn or I/O
 * error proves nothing about the ref. */
export function refUnresolved(error: unknown): boolean {
  if ((error as { stderrTruncated?: unknown } | null)?.stderrTruncated === true) return false;
  const { code, stderr } = gitFailure(error);
  return code === 128 && stderr.replace(/\n$/u, '') === 'fatal: Needed a single revision';
}

/** `git check-ref-format <ref>` refused the FORMAT: exit 1 is its only
 * "invalid" answer; 128 and every other failure are operational. */
export function refusedRefFormat(error: unknown): boolean {
  return gitFailure(error).code === 1;
}

/** Ceiling on what one probe step may print (a ref listing, a name). */
const PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
/** Diagnostics kept per step; anything longer is marked truncated. */
const STDERR_MAX_BYTES = 64 * 1024;

/** Once git exits, output already in its pipes is read within a few event-
 * loop turns. Pipes still open after them are held by another process —
 * possibly still writing — so the answer is incomplete (R7-3, R8-1). No
 * writer, owned or not, is waited for. */
const DRAIN_TURNS = 10;
/** After the group was SIGKILLed, how long its cessation may take to
 * observe before the step is refused as "cleanup unconfirmed" (owner
 * decision 2026-10-07, R6-5: bounded refusal — never an unbounded wait).
 * Every inspection is charged against this one deadline (R8-4). */
const KILL_SETTLE_MS = 1_000;

/** Environment variables that route git to ANOTHER repository (R8-22):
 * `git rev-parse --local-env-vars` less its config carriers, plus the
 * discovery controls. They are removed for every review git step, so the
 * repository git touches is exactly the one passed with -C. Transport and
 * auth settings (GIT_SSH*, GIT_ASKPASS, credential helpers, config
 * parameters) are kept. */
const GIT_ROUTING_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_QUARANTINE_PATH',
] as const;

/** The environment of a review git step: the service's own, minus every
 * repository-routing override (R8-22); C-locale diagnostics on request. */
export function repositoryGitEnv(cLocale: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of GIT_ROUTING_ENV) delete env[name];
  return cLocale ? { ...env, LC_ALL: 'C' } : env;
}

export type GroupMember = { readonly pid: number; readonly state: string };

/** Members of process group `pgid` from /proc, or null when membership
 * cannot be established completely: only a process that ENDED while being
 * listed may be skipped — an unreadable or malformed entry might be a live
 * member (R8-3). `fs` is a test seam. */
export function procGroupMembers(
  pgid: number,
  fs: { readonly list: () => string[]; readonly read: (path: string) => string } = {
    list: () => readdirSync('/proc'),
    read: (path) => readFileSync(path, 'utf8'),
  },
): GroupMember[] | null {
  let entries: string[];
  try {
    entries = fs.list();
  } catch {
    return null;
  }
  const members: GroupMember[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    let stat: string;
    try {
      stat = fs.read(`/proc/${entry}/stat`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') continue; // ended while listing
      return null;
    }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const group = Number(fields[2]);
    if (stat.lastIndexOf(')') === -1 || !Number.isSafeInteger(group) || (fields[0] ?? '') === '') return null;
    if (group === pgid) members.push({ pid: Number(entry), state: fields[0]! });
  }
  return members;
}

/** Members of group `pgid` from `ps -A -o pid=,pgid=,stat=` output, or null
 * when any line cannot be read (R8-3). */
export function psGroupMembers(stdout: string, pgid: number): GroupMember[] | null {
  const members: GroupMember[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
    if (match === null) return null;
    if (Number(match[2]) === pgid) members.push({ pid: Number(match[1]), state: match[3]! });
  }
  return members;
}

/** Does group `pgid` exist at all? 'gone' only on ESRCH: EPERM means a
 * member exists that is not ours to signal. Signal 0 never acts. */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Unknown membership, or any member not a zombie (R7-9): still running. */
export const executingMember = (members: readonly GroupMember[] | null): boolean =>
  members === null || members.some((member) => !/^[ZX]/u.test(member.state));

/** Is a member of group `pgid` still EXECUTING — not merely a zombie
 * awaiting its reaper (R7-9)? Membership that cannot be established within
 * `budgetMs` — or completely — counts as yes: cessation is never assumed
 * (R8-3, R8-4). Synchronous: the sync runner's settle only. */
export function groupHasLiveMember(pgid: number, budgetMs: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
  if (!groupExists(pgid)) return false;
  if (process.platform === 'linux') return executingMember(procGroupMembers(pgid));
  const listed = spawnSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], {
    encoding: 'utf8', timeout: Math.max(1, Math.floor(budgetMs)), killSignal: 'SIGKILL',
  });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return true;
  return executingMember(psGroupMembers(listed.stdout, pgid));
}

/** groupHasLiveMember without blocking the event loop (R8-4): `ps` runs as
 * an async child bounded by the remaining budget. */
export async function groupHasLiveMemberAsync(pgid: number, budgetMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
  if (!groupExists(pgid)) return false;
  if (process.platform === 'linux') return executingMember(procGroupMembers(pgid));
  try {
    const { stdout } = await execFileAsPromised('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], {
      encoding: 'utf8', timeout: Math.max(1, Math.floor(budgetMs)), killSignal: 'SIGKILL',
    });
    return executingMember(psGroupMembers(stdout, pgid));
  } catch {
    return true;
  }
}

/** Test seam: how a finished step's group is observed — production always
 * uses the two functions above; a test can stand in an unkillable group. */
export const OWNED_GIT_SEAMS: {
  groupHasLiveMember: (pgid: number, budgetMs: number) => boolean;
  groupHasLiveMemberAsync: (pgid: number, budgetMs: number) => Promise<boolean>;
} = { groupHasLiveMember, groupHasLiveMemberAsync };

/** A git step whose process group was still running after KILL_SETTLE_MS:
 * refused, never retried, and escalated naming the group (owner decision
 * 2026-10-08) — nothing is quarantined. */
function cleanupUnconfirmed(pgid: number, message: string): Error {
  // The verdict leads: refusal details are cut to a bounded length.
  return Object.assign(
    new Error(`cleanup unconfirmed: process group ${pgid} still running — ${message}`),
    { cleanupUnconfirmed: true, pgid },
  );
}

/** The probe runner. Its parent starts it detached, so it LEADS its own
 * process group, and git (spawned normally) joins that group. It enforces
 * the step's rules itself — natural end, the buffered-output drain, time
 * and output bounds — writes its outcome to a private result file, then
 * SIGKILLs its whole group, itself included. It is the group's anchor: it
 * is alive while it signals, so the group id cannot be anyone else's
 * (R8-6), and its own timer bounds the step even if its parent dies (the
 * service crashing mid-step). Its stdio is ignored, so nothing git spawned
 * can hold the parent's pipes. */
const OWNED_GROUP_RUNNER = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const [resultFile, limit, maxBytes, maxErrBytes, drainTurns, file, ...args] = process.argv.slice(1);
const self = process.pid;
try { process.kill(-self, 0); } catch {
  writeFileSync(resultFile, JSON.stringify({ outcome: 'spawn-error', message: 'the probe runner does not lead its own process group' }), { mode: 0o600 });
  process.exit(127);
}
const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const out = []; const err = []; let outBytes = 0; let errBytes = 0; let done = false; let closed = false;
const report = (result) => {
  if (done) return; done = true;
  const stderr = Buffer.concat(err).toString('utf8');
  try { writeFileSync(resultFile, JSON.stringify({ ...result, stderr, stderrTruncated: errBytes > Number(maxErrBytes) }), { mode: 0o600 }); } catch {}
  try { process.kill(-self, 'SIGKILL'); } catch {}
  process.exit(125);
};
setTimeout(() => report({ outcome: 'timeout' }), Number(limit));
child.stdout.on('data', (chunk) => { outBytes += chunk.length; if (outBytes > Number(maxBytes)) report({ outcome: 'overflow' }); else out.push(chunk); });
child.stderr.on('data', (chunk) => { errBytes += chunk.length; if (errBytes <= Number(maxErrBytes)) err.push(chunk); });
child.on('error', (error) => report({ outcome: 'spawn-error', message: String(error) }));
child.on('exit', () => {
  const drain = (turns) => { if (done || closed) return; if (turns === 0) return report({ outcome: 'incomplete' }); setImmediate(() => drain(turns - 1)); };
  drain(Number(drainTurns));
});
child.on('close', (code, signal) => { closed = true; report({ outcome: code === 0 ? 'ok' : 'failed', code, signal, stdout: code === 0 ? Buffer.concat(out).toString('utf8') : '' }); });
`;

/** Block for `ms` without spinning (the sync probe's bounded settle). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A private 0700 directory for one runner's result (it can carry raw
 * diagnostics — R7-4), the runner's argv, and its environment. */
function runnerLaunch(repoPath: string, args: readonly string[], timeoutMs: number, maxBytes: number) {
  const privateDir = mkdtempSync(join(tmpdir(), 'gru-probe-'));
  const resultFile = join(privateDir, 'result.json');
  const argv = ['-e', OWNED_GROUP_RUNNER, resultFile, String(timeoutMs), String(maxBytes), String(STDERR_MAX_BYTES),
    String(DRAIN_TURNS), 'git', '-C', repoPath, ...args];
  return { privateDir, resultFile, argv, env: repositoryGitEnv(true) };
}

type RunnerReport = {
  outcome?: unknown; code?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown; stderrTruncated?: unknown; message?: unknown;
};

function readRunnerReport(resultFile: string): RunnerReport | null {
  try {
    return JSON.parse(readFileSync(resultFile, 'utf8')) as RunnerReport;
  } catch {
    return null;
  }
}

/** A runner's report as the step's answer — or the step's failure, which
 * carries `ownedStopped`: its whole group was observed gone. */
function runnerAnswer(
  report: RunnerReport | null,
  command: string,
  timeoutMs: number,
  maxBytes: number,
  launch: { readonly started: boolean; readonly error?: string },
): string {
  const stopped = { ownedStopped: true };
  if (report === null) {
    throw Object.assign(new Error(
      `${command}: the probe runner ${launch.started ? 'ended without a result' : 'could not be started'}` +
        `${launch.error !== undefined ? ` (${launch.error})` : ''}`,
    ), stopped);
  }
  const stderr = typeof report.stderr === 'string' ? report.stderr : '';
  switch (report.outcome) {
    case 'ok':
      return typeof report.stdout === 'string' ? report.stdout : '';
    case 'failed':
      throw Object.assign(new Error(stderr.trim() || `${command} exited ${String(report.code ?? report.signal)}`), {
        ...(typeof report.code === 'number' ? { code: report.code, status: report.code } : { status: null }),
        signal: report.signal ?? null,
        stderr,
        ...(report.stderrTruncated === true ? { stderrTruncated: true } : {}),
        ...stopped,
      });
    case 'timeout':
      throw Object.assign(new Error(`${command} timed out after ${timeoutMs} ms`), { killed: true, ...stopped });
    case 'overflow':
      throw Object.assign(new Error(`${command} printed more than ${maxBytes} bytes`), stopped);
    case 'incomplete':
      throw Object.assign(new Error(`${command} exited, but its output was still held open — the answer is incomplete`), stopped);
    default:
      throw Object.assign(new Error(`${command}: ${typeof report.message === 'string' ? report.message : 'the probe runner failed'}`), stopped);
  }
}

/** One read-only git step in its OWN process group, led by the runner (see
 * OWNED_GROUP_RUNNER), without blocking the event loop. The runner ends
 * every outcome by SIGKILLing its group; this side only OBSERVES the group
 * afterwards (R8-6) — within KILL_SETTLE_MS, or the step is refused as
 * "cleanup unconfirmed". Should the runner itself wedge, it is still this
 * process's unreaped child, so its group is provably ours: killed here.
 * Contract (owner decision 2026-10-07, R5-4): cleanup covers the step's
 * process group; a helper that deliberately detaches into its own session
 * is outside it and left alone — and if it holds the output, the answer is
 * refused as incomplete. Diagnostics are in the C locale. Rejections carry
 * the numeric exit `code`, `stderr` (with `stderrTruncated` when cut), and
 * `ownedStopped` — proof the step's group stopped; a timeout, kill, spawn
 * failure or incomplete answer has no code. */
export function runOwnedGit(repoPath: string, args: readonly string[], timeoutMs: number, maxBytes = PROBE_MAX_OUTPUT_BYTES): Promise<string> {
  const command = `git ${args.join(' ')}`;
  const launch = runnerLaunch(repoPath, args, timeoutMs, maxBytes);
  return new Promise<string>((resolve, reject) => {
    const runner = spawn(process.execPath, launch.argv, { detached: true, stdio: 'ignore', env: launch.env });
    // R7-1: only a real process id names a group; 0 or absent never does.
    const pid = runner.pid !== undefined && Number.isSafeInteger(runner.pid) && runner.pid > 0 ? runner.pid : null;
    let spawnError: string | undefined;
    let ended = false;
    // A wedged runner: still unreaped (no 'exit' yet), so the group id is ours.
    const guard = setTimeout(() => {
      if (pid !== null && !ended) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, timeoutMs + 5_000);
    const settle = (): void => {
      if (ended) return;
      ended = true;
      clearTimeout(guard);
      void (async () => {
        try {
          const report = readRunnerReport(launch.resultFile);
          if (pid !== null) {
            const until = performance.now() + KILL_SETTLE_MS;
            for (;;) {
              const remaining = until - performance.now();
              if (!(await OWNED_GIT_SEAMS.groupHasLiveMemberAsync(pid, remaining))) break;
              if (performance.now() >= until) {
                throw cleanupUnconfirmed(pid, `${command} did not stop after SIGKILL (${String(report?.outcome ?? 'runner ended')})`);
              }
              await new Promise((wait) => setTimeout(wait, 25));
            }
          }
          resolve(runnerAnswer(report, command, timeoutMs, maxBytes, {
            started: pid !== null, ...(spawnError !== undefined ? { error: spawnError } : {}),
          }));
        } catch (error) {
          reject(error);
        } finally {
          rmSync(launch.privateDir, { recursive: true, force: true });
        }
      })();
    };
    runner.on('error', (error) => {
      spawnError = error.message;
      if (pid === null) settle();
    });
    runner.on('exit', settle);
  });
}

/** runOwnedGit, synchronously (the submission gate and the admission's
 * local checks run inside synchronous code). The runner is reaped before
 * spawnSync returns, so this side never signals its group (R8-6): it only
 * observes it stop within KILL_SETTLE_MS, or refuses the step as "cleanup
 * unconfirmed". The outer guard is a backstop for a wedged runner only —
 * the runner's own timer bounds the step. */
export function runOwnedGitSync(
  repoPath: string,
  args: readonly string[],
  timeoutMs: number,
  outerTimeoutMs = timeoutMs + 5_000,
  maxBytes = PROBE_MAX_OUTPUT_BYTES,
): string {
  const command = `git ${args.join(' ')}`;
  const launch = runnerLaunch(repoPath, args, timeoutMs, maxBytes);
  try {
    // `detached` makes the runner lead its own process group. Node honors
    // it for spawnSync (libuv UV_PROCESS_DETACHED) although its type
    // definitions omit it; the runner refuses to run git if it does not
    // lead a group.
    const options: SpawnSyncOptions & { readonly detached: boolean } = {
      detached: true,
      stdio: 'ignore',
      timeout: outerTimeoutMs,
      killSignal: 'SIGKILL',
      env: launch.env,
    };
    const result = spawnSync(process.execPath, launch.argv, options);
    const report = readRunnerReport(launch.resultFile);
    // R7-1: a failed spawn reports pid 0 — never a group to observe.
    const pid = typeof result.pid === 'number' && Number.isSafeInteger(result.pid) && result.pid > 0 ? result.pid : null;
    if (pid !== null) {
      const until = performance.now() + KILL_SETTLE_MS;
      for (;;) {
        if (!OWNED_GIT_SEAMS.groupHasLiveMember(pid, until - performance.now())) break;
        if (performance.now() >= until) {
          throw cleanupUnconfirmed(pid, `${command} did not stop after SIGKILL (${String(report?.outcome ?? 'runner ended')})`);
        }
        sleepSync(25);
      }
    }
    return runnerAnswer(report, command, timeoutMs, maxBytes, {
      started: pid !== null, ...(result.error !== undefined ? { error: result.error.message } : {}),
    });
  } finally {
    rmSync(launch.privateDir, { recursive: true, force: true });
  }
}

function git(repoPath: string, args: readonly string[], timeoutMs = 30_000): string {
  return gitRaw(repoPath, args, timeoutMs).trimEnd();
}

/** One synchronous git step of a movement check: plain (execFileSync), or
 * owned (R7-7) — its whole process group proven stopped, so a failure can
 * carry that proof. Diagnostics in the C locale either way. */
type MovementGit = (repoPath: string, args: readonly string[]) => string;
const plainMovementGit: MovementGit = (repoPath, args) => gitRaw(repoPath, args, 30_000, 'SIGTERM', true);
const ownedMovementGit: MovementGit = (repoPath, args) => runOwnedGitSync(repoPath, args, 30_000, undefined, GIT_MAX_BUFFER);

export function resolveGitCommit(repoPath: string, ref: string, run?: MovementGit): string {
  if (ref.trim() === '') throw new Error('git ref must be non-empty');
  const args = ['rev-parse', '--verify', `${ref}^{commit}`];
  return (run === undefined ? gitRaw(repoPath, args) : run(repoPath, args)).trimEnd();
}

/** Resolve an explicit base, otherwise use the repository's real default branch. */
export function resolveReviewBaseRef(repoPath: string, explicit?: string | null): string {
  if (explicit !== undefined && explicit !== null && explicit.trim() !== '') return explicit;
  try {
    return git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  } catch {
    for (const candidate of ['main', 'master']) {
      try {
        resolveGitCommit(repoPath, candidate);
        return candidate;
      } catch {
        // Try the next conventional default; never guess beyond an existing ref.
      }
    }
  }
  throw new Error('complete review requires job.baseBranch or a resolvable origin/HEAD, main, or master base');
}

function hash(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function contained(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function ensureDirectoryWithoutSymlinks(path: string, boundary = path): string {
  const absolute = resolve(path);
  const root = resolve(boundary);
  if (!contained(root, absolute)) throw new Error(`review artifact directory escapes its trusted boundary: ${absolute}`);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`review artifact root must be a real directory: ${root}`);
  }
  let cursor = root;
  const rel = relative(root, absolute);
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) mkdirSync(cursor, { recursive: true, mode: 0o700 });
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`review artifact directory component must be a real directory: ${cursor}`);
    }
  }
  if (!contained(realpathSync(root), realpathSync(absolute))) {
    throw new Error(`review artifact directory resolves outside its trusted boundary: ${absolute}`);
  }
  return absolute;
}

function atomicWrite(path: string, contents: string, boundary = dirname(path)): void {
  ensureDirectoryWithoutSymlinks(dirname(path), boundary);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`review artifact destination must not be a symlink: ${path}`);
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    // A hard-link publish is atomic and fails with EEXIST instead of replacing
    // frozen evidence. Temp and destination share a directory/filesystem.
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}

/** Resolve one review-round directory without treating ledger-controlled ids
 * as paths. This also protects startup recovery of rows created by older
 * builds that did not validate identifiers at ingress. */
export function reviewArtifactDirectory(artifactRoot: string, roundId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(roundId) || roundId === '.' || roundId === '..') {
    throw new Error('review round id is not a safe artifact path component');
  }
  const root = ensureDirectoryWithoutSymlinks(artifactRoot);
  const directory = resolve(root, roundId);
  if (!contained(root, directory) || directory === root) {
    throw new Error('review artifact directory escapes the configured root');
  }
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`review round artifact path must be a real directory: ${directory}`);
    }
    if (!contained(realpathSync(root), realpathSync(directory))) {
      throw new Error(`review round artifact path resolves outside the configured root: ${directory}`);
    }
  }
  return directory;
}

function assertFrozenTreeHasNoSymlinks(repoPath: string, targetSha: string): void {
  const entries = gitRaw(repoPath, ['ls-tree', '-r', '-z', targetSha, '--']).split('\0').filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const metadata = tab === -1 ? entry : entry.slice(0, tab);
    const path = tab === -1 ? '(unknown)' : entry.slice(tab + 1);
    if (metadata.startsWith('120000 ')) {
      throw new Error(`frozen target contains a symlink, which review tools may not observe: ${path}`);
    }
  }
}

function assertReviewCheckoutClean(repoPath: string, run?: MovementGit): void {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'];
  const status = run === undefined ? gitRaw(repoPath, args) : run(repoPath, args);
  if (status !== '') {
    const first = status.split('\0').find(Boolean)?.slice(0, 300) ?? 'unknown checkout mutation';
    throw new Error(`detached review checkout is not pristine (tracked/staged/untracked/ignored content: ${first})`);
  }
}

/** Changed file paths of the frozen delta, straight from the same frozen
 * revisions the diff came from (rename-aware destination names). */
function changedFilePaths(repoPath: string, diffBaseSha: string, targetSha: string): readonly string[] {
  return gitRaw(repoPath, ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--name-only', '-z', diffBaseSha, targetSha, '--'])
    .split('\0')
    .filter(Boolean);
}

function conventionPaths(changedFiles: readonly string[], tracked: ReadonlySet<string>): readonly string[] {
  const wanted = new Set<string>();
  for (const rootFile of ['AGENTS.md', 'CONTRIBUTING.md']) {
    if (tracked.has(rootFile)) wanted.add(rootFile);
  }
  for (const file of changedFiles) {
    const parts = file.split('/').filter(Boolean);
    parts.pop();
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const candidate = `${parts.slice(0, depth).join('/')}/AGENTS.md`;
      if (tracked.has(candidate)) wanted.add(candidate);
    }
  }
  return [...wanted].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length;
    return depth !== 0 ? depth : left.localeCompare(right);
  });
}

function readConventions(repoPath: string, targetSha: string, changedFiles: readonly string[]): string {
  const tracked = new Set(gitRaw(repoPath, ['ls-tree', '-r', '--name-only', '-z', targetSha, '--']).split('\0').filter(Boolean));
  const parts: string[] = [];
  let totalBytes = 0;
  for (const name of conventionPaths(changedFiles, tracked)) {
    const object = `${targetSha}:${name}`;
    const type = git(repoPath, ['cat-file', '-t', object]);
    const size = Number(git(repoPath, ['cat-file', '-s', object]));
    if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`project convention ${name} is not a regular tracked blob`);
    }
    totalBytes += size;
    if (size > FROZEN_CONVENTIONS_MAX_BYTES || totalBytes > FROZEN_CONVENTIONS_MAX_BYTES) {
      throw new Error(`frozen project conventions exceed ${FROZEN_CONVENTIONS_MAX_BYTES} UTF-8 bytes`);
    }
    const contents = gitRaw(repoPath, ['show', object]);
    if (contents.includes('\uFFFD')) {
      throw new Error(`project convention ${name} is not valid UTF-8 text`);
    }
    if (Buffer.byteLength(contents) !== size) {
      throw new Error(`project convention ${name} changed while frozen bytes were read`);
    }
    parts.push(`--- ${name} ---\n${contents.trimEnd()}`);
  }
  return parts.length === 0 ? 'No repository convention file was supplied.' : `${parts.join('\n\n')}\n`;
}

export function assertFrozenPromptBounds(review: Pick<FrozenReview, 'diff' | 'specContext' | 'projectConventions'>): void {
  const diffBytes = Buffer.byteLength(review.diff, 'utf8');
  if (diffBytes > FROZEN_DIFF_MAX_BYTES) {
    throw new Error(`frozen diff exceeds ${FROZEN_DIFF_MAX_BYTES} UTF-8 bytes`);
  }
  const specBytes = Buffer.byteLength(`${review.specContext}\n`, 'utf8');
  if (specBytes > FROZEN_SPEC_MAX_BYTES) {
    throw new Error(`frozen spec context exceeds ${FROZEN_SPEC_MAX_BYTES} UTF-8 bytes`);
  }
  const conventionBytes = Buffer.byteLength(review.projectConventions, 'utf8');
  if (conventionBytes > FROZEN_CONVENTIONS_MAX_BYTES) {
    throw new Error(`frozen project conventions exceed ${FROZEN_CONVENTIONS_MAX_BYTES} UTF-8 bytes`);
  }
}

export function freezeReviewInputs(input: FreezeReviewInput): FrozenReview {
  if (input.spec !== undefined && input.noSpec === true) throw new Error('review cannot supply both spec and explicit no-spec');
  if ((input.spec === undefined || input.spec.trim() === '') && input.noSpec !== true) {
    throw new Error('complete review requires frozen spec/context or explicit noSpec=true');
  }
  if (input.baseRef.trim() === '' || input.targetRef.trim() === '') throw new Error('review base and target refs are required');
  if (input.recoveryIdentity !== undefined &&
    (Object.keys(input.recoveryIdentity).sort().join(',') !== [
      'jobId', 'policySha256', 'runtimeId', 'runtimeVersion', 'modelRef', 'modelRole', 'modelSettingsSha256',
    ].sort().join(',') || Object.values(input.recoveryIdentity).some((value) =>
      typeof value !== 'string' || value.trim() === ''))) {
    throw new Error('recovery identity must contain every non-empty provenance field');
  }

  const targetSha = resolveGitCommit(input.repoPath, input.targetRef);
  const baseRefSha = resolveGitCommit(input.repoPath, input.baseRef);
  const diffBaseSha = git(input.repoPath, ['merge-base', baseRefSha, targetSha]);
  assertReviewCheckoutClean(input.repoPath);
  assertFrozenTreeHasNoSymlinks(input.repoPath, targetSha);
  const diff = gitRaw(input.repoPath, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--find-renames',
    '--find-copies',
    '--unified=3',
    diffBaseSha,
    targetSha,
    '--',
  ]);
  const changedFiles = changedFilePaths(input.repoPath, diffBaseSha, targetSha);
  if (changedFiles.length === 0) throw new Error(`frozen review diff is empty for ${diffBaseSha}..${targetSha}`);

  const specContext = input.noSpec === true ? 'EXPLICIT NO-SPEC REVIEW' : input.spec!;
  const specBytes = `${specContext}\n`;
  const projectConventions = readConventions(input.repoPath, targetSha, changedFiles);
  assertFrozenPromptBounds({ diff, specContext, projectConventions });
  // The effective acceptance must be the prefix the caller says it is: a
  // mismatched binding refuses rather than freezing a spec whose provenance
  // record would be a lie.
  let acceptance: FrozenAcceptance | undefined;
  if (input.acceptance !== undefined) {
    const contractText = input.acceptance.contractText.trimEnd();
    if (!specContext.startsWith(contractText)) {
      throw new Error('frozen spec context does not start with the bound effective contract; refusing to freeze a mismatched acceptance');
    }
    acceptance = {
      version: input.acceptance.version,
      baseSha256: input.acceptance.baseSha256,
      contractSha256: hash(input.acceptance.contractText),
      amendmentIds: [...input.acceptance.amendmentIds],
    };
  }
  const directory = reviewArtifactDirectory(input.artifactRoot, input.roundId);
  ensureDirectoryWithoutSymlinks(directory);
  // Private review evidence freezes FIRST (all requests validate before any
  // byte is published): a refused intake leaves the round directory without
  // partial evidence a later reader could mistake for a frozen record.
  const requestedEvidence = input.evidence ?? [];
  let frozenEvidence: {
    readonly attachments: readonly FrozenEvidenceRuntimeAttachment[];
    readonly receipt: readonly FrozenEvidenceAttachment[];
  } | null = null;
  if (requestedEvidence.length > 0) {
    if (input.evidenceUploadsDir === undefined || input.evidenceUploadsDir.trim() === '') {
      throw new Error('review evidence was requested but no evidence uploads directory is configured');
    }
    const frozen = freezeEvidenceAttachments({
      requests: requestedEvidence,
      uploadsDir: input.evidenceUploadsDir,
      roundDirectory: directory,
      roundId: input.roundId,
      jobId: input.jobId ?? null,
      targetSha,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    frozenEvidence = { attachments: frozen.attachments, receipt: frozen.receipt };
  }
  const ciEvidence = input.ciEvidence ?? null;
  atomicWrite(join(directory, 'diff.patch'), diff, directory);
  atomicWrite(join(directory, 'spec-context.md'), specBytes, directory);
  atomicWrite(join(directory, 'project-conventions.md'), projectConventions, directory);
  const changedFilesBytes = `${JSON.stringify(changedFiles, null, 2)}\n`;
  if (Buffer.byteLength(changedFilesBytes) > FROZEN_CHANGED_FILES_MAX_BYTES) {
    throw new Error('frozen changed-file list exceeds recovery byte limit');
  }
  atomicWrite(join(directory, 'changed-files.json'), changedFilesBytes, directory);

  const manifest: FrozenReviewInputs = {
    schemaVersion: 2,
    roundId: input.roundId,
    recoveryIdentity: input.recoveryIdentity === undefined ? null : {
      ...input.recoveryIdentity,
      trackedTreeSha: git(input.repoPath, ['rev-parse', `${targetSha}^{tree}`]),
    },
    repoPath: input.repoPath,
    targetRef: input.movementRef ?? input.targetRef,
    baseRef: input.baseRef,
    targetSha,
    baseRefSha,
    diffBaseSha,
    diffSha256: hash(diff),
    specMode: input.noSpec === true ? 'explicit-no-spec' : 'supplied',
    specSha256: hash(specBytes),
    conventionsSha256: hash(projectConventions),
    changedFilesSha256: hash(changedFilesBytes),
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    changedFiles,
    ...(acceptance !== undefined ? { acceptance } : {}),
    ...(frozenEvidence !== null || ciEvidence !== null
      ? {
          reviewEvidence: {
            attachments: frozenEvidence?.receipt ?? [],
            ci: ciEvidence,
          },
        }
      : {}),
    ...(input.branchIdle !== undefined ? { branchIdle: input.branchIdle } : {}),
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestBytes) > FROZEN_MANIFEST_MAX_BYTES) {
    throw new Error('frozen manifest exceeds recovery byte limit');
  }
  atomicWrite(join(directory, 'manifest.json'), manifestBytes, directory);
  return {
    directory,
    manifest,
    diff,
    specContext,
    projectConventions,
    changedFiles,
    evidence: { attachments: frozenEvidence?.attachments ?? [], ci: ciEvidence },
  };
}

export type SourceMovementCause = 'target-moved' | 'base-rewritten' | 'base-unresolvable' | 'checkout-changed' | 'check-failed';
export interface SourceMovement {
  readonly cause: SourceMovementCause;
  readonly detail: string;
  /** A killed git step would not stop: never retried; escalated naming its
   * process group (owner decision 2026-10-08). */
  readonly cleanupUnconfirmed?: true;
  /** Proof the failed step's whole process group stopped (owned execution,
   * R7-7): only such a failure may be retried. */
  readonly stopped?: true;
}

function isUnstopped(error: unknown): boolean {
  return (error as { cleanupUnconfirmed?: unknown } | null)?.cleanupUnconfirmed === true;
}

/** A failed probe step as fail-closed movement — carrying, when the step
 * would not stop, that nothing may retry while it might live, and when it
 * provably stopped, that proof. */
function failedCheck(error: unknown): SourceMovement {
  const failed = movement('check-failed', gitErrorDetail(error));
  const facts = error as { cleanupUnconfirmed?: unknown; ownedStopped?: unknown } | null;
  if (facts?.cleanupUnconfirmed === true) return { ...failed, cleanupUnconfirmed: true };
  return facts?.ownedStopped === true ? { ...failed, stopped: true } : failed;
}

function movement(cause: SourceMovementCause, detail: string): SourceMovement {
  // Git can echo a credential-bearing remote URL in stderr. Mask it before
  // bounding the detail that is persisted in reports, events and errors.
  const safeDetail = detail.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, '[REDACTED URL]');
  return { cause, detail: safeDetail.replace(/[\r\n]+/gu, ' ').slice(0, 300) };
}

function gitErrorDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text = stderr instanceof Buffer ? stderr.toString('utf8') : typeof stderr === 'string' ? stderr : '';
  return text.trim() || (error instanceof Error ? error.message : String(error));
}

/** Only the local base is read: an advance is valid while the frozen
 * merge-base remains reachable; no remote base tip is consulted or fetched. */
function baseMovementSinceFreeze(review: FrozenReview, run: MovementGit): SourceMovement | null {
  const { repoPath, baseRef, baseRefSha, diffBaseSha } = review.manifest;
  let live: string;
  try {
    live = resolveGitCommit(repoPath, baseRef, run);
  } catch (error) {
    // Only git's own "no such commit" is a base that is gone; a timeout,
    // spawn or I/O failure is operational — retryable once proven stopped
    // (R8-11) — and a step that would not stop is never hidden.
    if (!refUnresolved(error)) return failedCheck(error);
    return movement('base-unresolvable', `base ${baseRef} cannot resolve: ${gitErrorDetail(error)}`);
  }
  if (live === baseRefSha) return null;
  try {
    run(repoPath, ['merge-base', '--is-ancestor', diffBaseSha, live]);
    return null;
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 1) {
      return movement('base-rewritten', `base ${baseRef} no longer descends from ${diffBaseSha}`);
    }
    return failedCheck(error);
  }
}

/** The configured-remote branch a movement ref names, or null when the ref
 * is not a remote-tracking branch spelling (a SHA, a tag, a revision
 * expression like origin/topic~1, or a local branch whose leading segment
 * is not a configured remote — a local `feature/x` is NOT
 * `remote feature`).
 *
 * gh-169: the advertised-tip comparison applies ONLY to refs that resolve
 * to refs/remotes/<remote>/<branch>. A revision expression (origin/topic~1)
 * is not that branch spelling — probing refs/heads/<branch-with-operators>
 * exits 2 and poisoned every pin round as `check-failed` movement; a tag
 * like origin/v1 resolves to refs/tags/… and never names an advertised
 * branch. Both now correctly skip this check; their pins still bind through
 * the local resolution and pristine-checkout proofs. */
function advertisedRemoteBranch(repoPath: string, ref: string, run: MovementGit): { remote: string; branch: string } | null {
  let remoteRef: string;
  if (ref.startsWith('refs/remotes/')) {
    // gh-169 P9: a fully-qualified spelling is not automatically a tracking
    // REF — `refs/remotes/origin/topic~1` is a resolvable revision
    // EXPRESSION whose ls-remote probe would false-alarm exactly like the
    // short spelling. Validate the ref format before treating the prefix
    // as proof; a genuine tracking ref keeps its advertised-tip check.
    try {
      run(repoPath, ['check-ref-format', ref]);
    } catch (error) {
      if (refusedRefFormat(error)) return null; // git refused the format: an expression, not a tracking ref
      throw error; // an operational failure proves nothing — fail closed
    }
    remoteRef = ref.slice('refs/remotes/'.length);
  } else {
    // Fully-qualified non-tracking refs (tags, heads) are exact and never
    // advertised-branch spellings.
    if (ref.startsWith('refs/')) return null;
    // A valid branch spelling only: revision operators (~ ^ : .. @{}) make
    // the ref an EXPRESSION, not the branch itself.
    try {
      run(repoPath, ['check-ref-format', '--branch', ref]);
    } catch (error) {
      if (refusedBranchName(error, ref)) return null; // git refused the name: not a branch spelling
      throw error; // an operational failure proves nothing — fail closed
    }
    // The ref must actually RESOLVE to a remote-tracking ref — a tag whose
    // name carries a slash (origin/v1) resolves to refs/tags/origin/v1 and
    // never names an advertised branch. A ref that no longer resolves at
    // all is not "unadvertised": the frozen target vanished — fail closed.
    const fullName = run(repoPath, ['rev-parse', '--symbolic-full-name', '--verify', ref]).trimEnd();
    if (!fullName.startsWith('refs/remotes/')) return null;
    remoteRef = fullName.slice('refs/remotes/'.length);
  }
  const slash = remoteRef.indexOf('/');
  if (slash <= 0 || slash === remoteRef.length - 1) return null;
  const remote = remoteRef.slice(0, slash);
  const branch = remoteRef.slice(slash + 1);
  return run(repoPath, ['remote']).trimEnd().split('\n').includes(remote) ? { remote, branch } : null;
}

/** Compare the locally resolved base ancestry, movement ref (local and
 * advertised target tip), HEAD and pristine checkout with the frozen target.
 * A base advance is not movement; frozen SHAs stay provenance. Any failed
 * check returns a cause, so the boolean wrapper fails closed on every error. */
/** Movement probe options (gh-169 P5): `remoteProbeTimeoutMs` bounds the
 * advertised-tip ls-remote at REQUEST-TIME admission so a stalled remote
 * cannot block the service event loop for the full 30 s proof budget — a
 * probe that exceeds the bound reports check-failed (fail-closed,
 * retryable) instead of stalling. The submission gate keeps the full
 * budget by omitting the option. */
export interface SourceMovementOptions {
  readonly remoteProbeTimeoutMs?: number;
  /** Skip the advertised-tip probe (the caller supplies a precomputed
   * async result — gh-169 R4-6: request-time admission probes the remote
   * OFF the event loop and injects the outcome). */
  readonly skipRemoteProbe?: boolean;
  /** Run every local step owned (R7-7): admission retries a failure only
   * with proof its process group stopped. */
  readonly ownedLocalSteps?: boolean;
}

export function sourceMovementSinceFreeze(review: FrozenReview, options?: SourceMovementOptions): SourceMovement | null {
  const { repoPath, targetRef, targetSha } = review.manifest;
  const run = options?.ownedLocalSteps === true ? ownedMovementGit : plainMovementGit;
  try {
    const base = baseMovementSinceFreeze(review, run);
    if (base !== null) return base;
    let localTarget: string;
    try {
      localTarget = resolveGitCommit(repoPath, targetRef, run);
    } catch (error) {
      if (!refUnresolved(error)) return failedCheck(error); // operational (R8-11)
      return movement('target-moved', `target ${targetRef} cannot resolve: ${gitErrorDetail(error)}`);
    }
    if (localTarget !== targetSha) return movement('target-moved', `target ${targetRef} is ${localTarget}, frozen at ${targetSha}`);
    // A push may move the host tip without moving the local tracking ref.
    if (options?.skipRemoteProbe === true) {
      // The caller owns the advertised-tip proof (async path).
    } else {
      const remoteTarget = advertisedRemoteBranch(repoPath, targetRef, run);
      if (remoteTarget !== null) {
      // An owned process group, killed at its bound: this call blocks the
      // event loop, so neither a SIGTERM-ignoring git (or wrapper) nor
      // anything it spawned may outlive the bound.
      const advertised = runOwnedGitSync(
        repoPath,
        ['ls-remote', '--exit-code', remoteTarget.remote, `refs/heads/${remoteTarget.branch}`],
        options?.remoteProbeTimeoutMs ?? 30_000,
      ).trim();
        const tip = advertised.split(/\s+/u)[0] ?? '';
        if (tip !== targetSha) return movement('target-moved', `advertised ${remoteTarget.remote}/${remoteTarget.branch} is ${tip}, frozen at ${targetSha}`);
      }
    }
    if (resolveGitCommit(repoPath, 'HEAD', run) !== targetSha) {
      return movement('checkout-changed', `review checkout HEAD no longer matches ${targetSha}`);
    }
    try {
      assertReviewCheckoutClean(repoPath, run);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('detached review checkout is not pristine')) {
        return movement('checkout-changed', error.message);
      }
      throw error;
    }
    return null;
  } catch (error) {
    return failedCheck(error);
  }
}

/** Where a probe started, on every clock the OS suspend evidence needs. */
export interface ProbeStart {
  /** Wall clock (epoch ms) — compared with macOS's kernel wake time. */
  readonly wallMs: number;
  /** The budget clock. */
  readonly monoMs: number;
  /** Linux boot clock (ms, counts suspend), when available. */
  readonly bootMs: number | null;
}

/** The OS boundary the suspend evidence is read from. Production reads
 * the real kernel; tests substitute only these inputs, so the evidence
 * logic itself always runs. */
export interface SuspendEvidenceIo {
  readonly platform: NodeJS.Platform;
  /** Wall clock (epoch ms). */
  readonly wallNow: () => number;
  /** `sysctl -n kern.waketime` output (macOS), bounded by `timeoutMs`. */
  readonly kernWaketime: (timeoutMs: number) => Promise<string>;
  /** Raw `/proc/uptime` text (Linux; its first field keeps counting through
   * suspend). Rejects when unreadable. Asynchronous, so a stalled read can
   * never block the evidence allowance's timer. */
  readonly procUptime: () => Promise<string>;
}

/** Test seams for the admission probe; production uses the defaults. */
export interface AdmissionProbeSeams {
  /** Budget clock (default performance.now). */
  readonly now?: () => number;
  /** One bounded git invocation (default execFile, killed at timeoutMs). */
  readonly exec?: (repoPath: string, args: readonly string[], timeoutMs: number) => Promise<string>;
  /** Where suspend evidence is read (default: the real OS). */
  readonly evidence?: SuspendEvidenceIo;
}

/** How long a FAILED probe may spend reading suspend evidence (owner
 * decision 2026-10-07, round 3: a separate, bounded allowance — the probe's
 * own budget is usually what the suspend spent, so the evidence cannot be
 * made to fit inside it). Git never gets a renewed budget without positive
 * evidence. */
export const SUSPEND_EVIDENCE_ALLOWANCE_MS = 1_000;

/** Whole milliseconds left for the next git step, or null once the budget
 * is spent. execFile rejects a fractional timeout (ERR_OUT_OF_RANGE), and
 * rounding down could pass 0, which disables the kill — so round up. */
export function remainingTimeoutMs(deadline: number, now: number): number | null {
  const remaining = deadline - now;
  return remaining > 0 ? Math.ceil(remaining) : null;
}

/** Every admission git step is read-only (check-ref-format, rev-parse,
 * remote, ls-remote) and runs in its own process group, SIGKILLed at its
 * bound and when it ends: neither a git or wrapper that ignores SIGTERM nor
 * anything it spawned can hold admission open or overlap a retry. */
export const defaultProbeExec = (repoPath: string, args: readonly string[], timeoutMs: number): Promise<string> =>
  runOwnedGit(repoPath, args, timeoutMs);

/** `sysctl -n kern.waketime` by absolute path — the service's PATH need
 * not include /usr/sbin. */
export const readKernWaketime = async (timeoutMs: number): Promise<string> =>
  (await execFileAsPromised('/usr/sbin/sysctl', ['-n', 'kern.waketime'], {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
  })).stdout;

/** Linux CLOCK_BOOTTIME in ms from `/proc/uptime` text (its first field,
 * seconds, keeps counting through suspend, unlike Node's CLOCK_MONOTONIC).
 * Null when the text is not that. */
export function parseProcUptimeMs(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s/u.exec(text);
  if (match === null) return null;
  const ms = Number(match[1]) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/** The Linux boot clock, read within the evidence allowance; null when it
 * cannot be read in time. */
async function bootClockMs(io: SuspendEvidenceIo, now: () => number, deadline?: number): Promise<number | null> {
  try {
    return parseProcUptimeMs(await withinEvidenceAllowance(() => io.procUptime(), now, deadline));
  } catch {
    return null;
  }
}

/** Parse `sysctl -n kern.waketime` ("{ sec = 1790944289, usec = 208542 } …"). */
export function parseKernWaketime(output: string): number | null {
  const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u.exec(output);
  return match === null ? null : Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000);
}

const OS_EVIDENCE: SuspendEvidenceIo = {
  platform: process.platform,
  wallNow: () => Date.now(),
  kernWaketime: readKernWaketime,
  procUptime: () => readFileAsync('/proc/uptime', 'utf8'),
};

/** The reader's answer only if it arrives inside the evidence allowance:
 * the deadline and the timer exist BEFORE the reader runs, and an answer
 * that lands at or past the deadline (a slow reader, a stalled event loop)
 * is no evidence. */
async function withinEvidenceAllowance<T>(
  read: () => Promise<T>,
  now: () => number,
  deadline: number = now() + SUSPEND_EVIDENCE_ALLOWANCE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('suspend evidence unavailable within its allowance')),
      Math.max(0, deadline - now()),
    );
  });
  try {
    const reading = read();
    reading.catch(() => {}); // a late failure after the timer won is not unhandled
    const value = await Promise.race([reading, expired]);
    if (now() >= deadline) throw new Error('suspend evidence arrived after its allowance');
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/** Real OS evidence that the machine suspended after `start` — never a
 * timer-lateness guess, so a long event-loop stall is not mistaken for
 * sleep and a short sleep is not missed. macOS: the kernel's last wake is
 * after the start. Linux: the boot clock ran ahead of the monotonic clock
 * by more than a second. Anything unreadable, or not read within the
 * allowance, is "no evidence" (fail closed: no retry). */
async function osSuspendedSince(start: ProbeStart, now: () => number, io: SuspendEvidenceIo): Promise<boolean> {
  try {
    if (io.platform === 'darwin') {
      const wakeMs = parseKernWaketime(await withinEvidenceAllowance(() => io.kernWaketime(SUSPEND_EVIDENCE_ALLOWANCE_MS), now));
      return wakeMs !== null && wakeMs > start.wallMs;
    }
    if (io.platform === 'linux' && start.bootMs !== null) {
      const bootNow = await bootClockMs(io, now);
      return bootNow !== null && (bootNow - start.bootMs) - (now() - start.monoMs) > 1_000;
    }
  } catch {
    /* no evidence */
  }
  return false;
}

/** Async advertised-tip probe (gh-169 R4-6): the SAME fail-closed
 * comparison `sourceMovementSinceFreeze` performs, executed with the
 * non-blocking execFile so a stalled remote never blocks the service
 * event loop at request-time admission. Null = no movement; errors and
 * timeouts return an explicit check-failed movement (fail-closed,
 * retryable), never silence and never a stall.
 *
 * Suspend (owner incident 2026-10-07, owner decision "retry once on real
 * sleep evidence"): on macOS every Node clock — performance.now() and the
 * timers that kill a git step — keeps counting through sleep (libuv uses
 * mach_continuous_time); on Linux the clock pauses but a suspend can still
 * break a git step's connection. When the OS proves it suspended during a
 * probe that failed, the probe re-runs ONCE with a fresh budget and that
 * second outcome is final. Without that evidence — a genuine stall, or an
 * event loop blocked by the service's own work — the probe is refused
 * within the single deadline (R7-3), plus at most the bounded evidence
 * allowance (SUSPEND_EVIDENCE_ALLOWANCE_MS) spent looking for a suspend. */
export async function probeAdvertisedTipMovementAsync(
  review: FrozenReview,
  timeoutMs: number,
  seams: AdmissionProbeSeams = {},
): Promise<SourceMovement | null> {
  const now = seams.now ?? (() => performance.now());
  const exec = seams.exec ?? defaultProbeExec;
  const io = seams.evidence ?? OS_EVIDENCE;
  // The first attempt's budget starts NOW: reading the Linux baseline is
  // charged against it (R6-4), so it can never add to the bound.
  const firstDeadline = now() + timeoutMs;
  const start: ProbeStart = {
    wallMs: io.wallNow(),
    monoMs: now(),
    bootMs: io.platform === 'linux' ? await bootClockMs(io, now, firstDeadline) : null,
  };
  const first = await probeAdvertisedTipOnce(review, firstDeadline, now, exec);
  if (first === null || first.cause !== 'check-failed') return first;
  // A git step that would not stop may still be running: never start
  // another while it might live (owner decision 2026-10-07, R6-5).
  if (first.cleanupUnconfirmed === true) return first;
  if (!(await osSuspendedSince(start, now, io))) return first;
  return probeAdvertisedTipOnce(review, now() + timeoutMs, now, exec);
}

async function probeAdvertisedTipOnce(
  review: FrozenReview,
  deadline: number,
  now: () => number,
  exec: NonNullable<AdmissionProbeSeams['exec']>,
): Promise<SourceMovement | null> {
  const { targetRef, targetSha } = review.manifest;
  // R6-4: ONE cumulative admission budget (an absolute deadline) across
  // every async step — each call gets only the remaining time, and
  // exhaustion fails closed both before a step starts and after it settles
  // (a step that finishes past the deadline proves nothing, success or git
  // rejection alike).
  const run = async (args: readonly string[]): Promise<string> => {
    const timeout = remainingTimeoutMs(deadline, now());
    if (timeout === null) {
      // Nothing was started, so nothing can still be running.
      throw Object.assign(new Error(`admission remote-probe budget exhausted before: git ${args.join(' ')}`), { ownedStopped: true });
    }
    const late = (stopped: boolean): Error => Object.assign(
      new Error(`admission remote-probe budget exhausted after: git ${args.join(' ')}`),
      stopped ? { ownedStopped: true } : {},
    );
    let stdout: string;
    try {
      stdout = await exec(review.manifest.repoPath, args, timeout);
    } catch (error) {
      // A step that might still be running keeps saying so (R6-5): the
      // late-budget message must never launder it into a retryable one —
      // nor claim a stop the step did not prove.
      if (isUnstopped(error)) throw error;
      if (now() >= deadline) throw late((error as { ownedStopped?: unknown } | null)?.ownedStopped === true);
      throw error;
    }
    // The step returned: an owned step returns only once its group stopped.
    if (now() >= deadline) throw late(true);
    return stdout;
  };
  // R6-3 / round 4: only git's OWN refusal of the spelling may skip the
  // remote proof — the invalid-name answer of check-ref-format --branch, or
  // exit 1 of check-ref-format. Any other failure (an unreadable repository
  // exits 128 too), every timeout, kill and spawn failure fails closed.
  // Round-5 P3: EVERY preparation step is async and bounded — the sync
  // advertisedRemoteBranch helper (30 s execFileSync defaults) is never
  // touched at admission, so no slow config/filesystem/helper step can
  // block the service event loop. Semantics mirror the sync helper: a
  // spelling that is not a valid branch/ref name SKIPS the probe (no
  // movement); only genuine probe errors are fail-closed check-failed.
  const identify = async (): Promise<{ remote: string; branch: string } | null> => {
    if (targetRef.startsWith('refs/') && !targetRef.startsWith('refs/remotes/')) return null;
    if (!targetRef.startsWith('refs/remotes/')) {
      try {
        await run(['check-ref-format', '--branch', targetRef]);
      } catch (error) {
        if (refusedBranchName(error, targetRef)) return null; // not a branch spelling (e.g. origin/topic~1)
        throw error; // operational failure, timeout, kill, spawn failure — fail closed
      }
      // A target ref that no longer resolves did not become "unadvertised":
      // the frozen target vanished — fail closed.
      const fullName = (await run(['rev-parse', '--symbolic-full-name', '--verify', targetRef])).trimEnd();
      if (!fullName.startsWith('refs/remotes/')) return null;
      const remoteRef = fullName.slice('refs/remotes/'.length);
      const slash = remoteRef.indexOf('/');
      if (slash <= 0 || slash === remoteRef.length - 1) return null;
      const remote = remoteRef.slice(0, slash);
      const remotes = (await run(['remote'])).split('\n');
      return remotes.includes(remote) ? { remote, branch: remoteRef.slice(slash + 1) } : null;
    }
    try {
      await run(['check-ref-format', targetRef]);
    } catch (error) {
      if (refusedRefFormat(error)) return null; // a qualified revision expression, not a tracking ref
      throw error;
    }
    const remoteRef = targetRef.slice('refs/remotes/'.length);
    const slash = remoteRef.indexOf('/');
    if (slash <= 0 || slash === remoteRef.length - 1) return null;
    const remote = remoteRef.slice(0, slash);
    const remotes = (await run(['remote'])).split('\n');
    return remotes.includes(remote) ? { remote, branch: remoteRef.slice(slash + 1) } : null;
  };
  let remoteTarget: { remote: string; branch: string } | null = null;
  try {
    remoteTarget = await identify();
  } catch (error) {
    return failedCheck(error);
  }
  if (remoteTarget === null) return null;
  try {
    // R7-3: the FINAL call flows through run() — the remaining budget at
    // the moment of the probe is what ls-remote gets, and exhaustion
    // fails closed.
    const stdout = await run(['ls-remote', '--exit-code', remoteTarget.remote, `refs/heads/${remoteTarget.branch}`]);
    const tip = stdout.trim().split(/\s+/u)[0] ?? '';
    if (tip !== targetSha) {
      return movement('target-moved', `advertised ${remoteTarget.remote}/${remoteTarget.branch} is ${tip}, frozen at ${targetSha}`);
    }
    return null;
  } catch (error) {
    return failedCheck(error);
  }
}

export function refMovedSinceFreeze(review: FrozenReview): boolean {
  return sourceMovementSinceFreeze(review) !== null;
}

/** Only the terminal retry may compare a previously published report. A
 * no-follow descriptor and byte bound keep this check inside the same safe
 * round directory without relaxing write-once artifact publication. */
export function publishedReportMatches(review: FrozenReview, expected: string): boolean {
  const descriptor = openCheckpoint(review.directory, 'perkins-report.md');
  try {
    const info = fstatSync(descriptor);
    const bytes = Buffer.from(expected, 'utf8');
    if (!info.isFile() || info.size !== bytes.length) return false;
    const actual = Buffer.allocUnsafe(bytes.length);
    let count = 0;
    while (count < actual.length) {
      const read = readSync(descriptor, actual, count, actual.length - count, null);
      if (read === 0) return false;
      count += read;
    }
    return fstatSync(descriptor).size === count && actual.equals(bytes);
  } finally {
    closeSync(descriptor);
  }
}

/** Each open must be anchored in one kernel path walk. Darwin's
 * O_NOFOLLOW_ANY rejects symlinks anywhere in that walk; Linux resolves each
 * component relative to a held no-follow directory descriptor through procfs.
 * An lstat followed by a pathname open is not an ownership proof. */
export function openCheckpoint(directory: string, relativePath: string): number {
  const absolute = resolve(directory, relativePath);
  if (process.platform === 'darwin') {
    // Only the OS-owned /var alias may be normalized; never realpath a
    // caller-controlled ancestor (doing so would conceal a substitution).
    const path = absolute.startsWith('/var/') ? `/private${absolute}` : absolute;
    // Darwin sys/fcntl.h O_NOFOLLOW_ANY; unlike O_NOFOLLOW this applies to
    // the entire kernel pathname walk, including ancestor directories.
    return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
  }
  if (process.platform !== 'linux') throw new Error('no race-safe checkpoint directory traversal on this platform');
  const descriptors: number[] = [];
  try {
    let parent = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(parent);
    const parts = absolute.slice(1).split('/');
    for (const part of parts.slice(0, -1)) {
      parent = openSync(`/proc/self/fd/${parent}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(parent);
    }
    return openSync(`/proc/self/fd/${parent}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } finally {
    for (const fd of descriptors.reverse()) closeSync(fd);
  }
}

/** Read exact original bytes with a bound on the read itself, not merely the
 * pre-read stat: a concurrent append cannot cause an unbounded allocation. */
export function readReviewCheckpointBytes(directory: string, relativePath: string, maxBytes = 256 * 1024): Buffer {
  const components = relativePath.split('/');
  if (components.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > FROZEN_DIFF_MAX_BYTES) {
    throw new Error('invalid review checkpoint path or byte limit');
  }
  const descriptor = openCheckpoint(directory, relativePath);
  try {
    return readBoundedCheckpointDescriptor(descriptor, maxBytes);
  } finally {
    closeSync(descriptor);
  }
}

/** @internal The reader seam makes concurrent growth deterministic in tests;
 * production always uses readSync on the no-follow descriptor. */
export function readBoundedCheckpointDescriptor(
  descriptor: number, maxBytes: number,
  readChunk: (fd: number, bytes: Buffer, offset: number, length: number, position: null) => number = readSync,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > FROZEN_DIFF_MAX_BYTES) {
    throw new Error('invalid review checkpoint byte limit');
  }
  const info = fstatSync(descriptor);
  if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error('review checkpoint is not a bounded regular file');
  const bytes = Buffer.allocUnsafe(maxBytes + 1);
  let count = 0;
  while (count < bytes.length) {
    const read = readChunk(descriptor, bytes, count, bytes.length - count, null);
    if (read === 0) break;
    count += read;
  }
  const after = fstatSync(descriptor);
  if (count !== info.size || after.size !== info.size || after.ino !== info.ino || count > maxBytes) {
    throw new Error('review checkpoint changed during bounded read');
  }
  return bytes.subarray(0, count);
}

export function readReviewCheckpoint(directory: string, relativePath: string, maxBytes = 256 * 1024): string {
  // Preserve a UTF-8 BOM as U+FEFF so callers that re-encode a checkpoint
  // never confuse BOM-prefixed bytes with the original receipted source.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(readReviewCheckpointBytes(directory, relativePath, maxBytes));
}

/** A base-only recovered lens is usable only while the same pinned base
 * still merges cleanly with the frozen target. merge-tree writes Git objects,
 * never the index or checkout; nonzero/conflict/ambiguous output refuses.
 * Re-run at submission so movement after lead spawn cannot authorize READY. */
export function proveRecoveredBaseMergeability(review: FrozenReview, priorBaseTips: readonly string[]): void {
  const { repoPath, baseRef, baseRefSha, targetSha, diffBaseSha } = review.manifest;
  if (priorBaseTips.length === 0 || priorBaseTips.length > 16 ||
    priorBaseTips.some((tip) => !/^[0-9a-f]{40}$/u.test(tip) || tip === baseRefSha)) {
    throw new Error('recovered base mergeability requires bounded distinct prior base tips');
  }
  if (resolveGitCommit(repoPath, baseRef) !== baseRefSha || resolveGitCommit(repoPath, targetSha) !== targetSha) {
    throw new Error('recovered base moved before mergeability proof');
  }
  for (const tip of priorBaseTips) gitRaw(repoPath, ['merge-base', '--is-ancestor', tip, baseRefSha]);
  if (git(repoPath, ['merge-base', baseRefSha, targetSha]) !== diffBaseSha) {
    throw new Error('recovered base changed the frozen merge-base');
  }
  const mergedTree = execFileSync('git', ['-C', repoPath, 'merge-tree', '--write-tree', baseRefSha, targetSha], {
    encoding: 'utf8', env: repositoryGitEnv(false), maxBuffer: 1024 * 1024, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(mergedTree) || git(repoPath, ['cat-file', '-t', mergedTree]) !== 'tree') {
    throw new Error('recovered base mergeability proof did not produce one verified tree');
  }
  if (resolveGitCommit(repoPath, baseRef) !== baseRefSha || resolveGitCommit(repoPath, targetSha) !== targetSha) {
    throw new Error('recovered base moved during mergeability proof');
  }
}

function effectiveEvidenceIdentity(evidence: FrozenReviewEvidenceManifest | undefined): unknown {
  if (evidence === undefined) return undefined;
  return {
    ci: evidence.ci,
    // Each manifest keeps its own freeze time. It is provenance of the copy,
    // not a change to the bytes or owner-authorized purpose/consent.
    attachments: evidence.attachments.map(({ frozenAt: _frozenAt, ...effective }) => effective),
  };
}

function authenticateFrozenAttachments(directory: string, evidence: FrozenReviewEvidenceManifest | undefined): boolean {
  if (evidence === undefined) return true;
  if (!Array.isArray(evidence.attachments) || evidence.attachments.length > REVIEW_EVIDENCE_MAX_FILES) return false;
  let total = 0;
  for (const [index, attachment] of evidence.attachments.entries()) {
    if (attachment?.id !== `ev${index + 1}` || attachment.frozenFile !== `evidence/ev${index + 1}.bin` ||
      !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0 || attachment.bytes > REVIEW_EVIDENCE_MAX_FILE_BYTES ||
      typeof attachment.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(attachment.sha256) ||
      attachment.sourceSha256 !== attachment.sha256) return false;
    total += attachment.bytes;
    if (total > REVIEW_EVIDENCE_MAX_TOTAL_BYTES) return false;
    const bytes = readReviewCheckpointBytes(directory, attachment.frozenFile, REVIEW_EVIDENCE_MAX_FILE_BYTES);
    if (bytes.length !== attachment.bytes || hash(bytes) !== attachment.sha256) return false;
  }
  return true;
}

export function compatibleReviewIdentity(
  current: FrozenReview, predecessorDirectory: string, expectedManifestSha256?: string,
): boolean {
  try {
    const manifestBytes = readReviewCheckpointBytes(predecessorDirectory, 'manifest.json', FROZEN_MANIFEST_MAX_BYTES);
    if (expectedManifestSha256 !== undefined && hash(manifestBytes) !== expectedManifestSha256) return false;
    const prior = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as FrozenReviewInputs;
    const identity = current.manifest.recoveryIdentity;
    if (prior.schemaVersion !== 2 || prior.roundId !== basename(predecessorDirectory) ||
      identity === null || prior.recoveryIdentity === null ||
      JSON.stringify(prior.recoveryIdentity) !== JSON.stringify(identity)) return false;
    for (const key of ['targetSha', 'baseRef', 'diffBaseSha', 'diffSha256', 'specMode', 'specSha256', 'conventionsSha256', 'changedFiles', 'acceptance'] as const) {
      if (JSON.stringify(prior[key]) !== JSON.stringify(current.manifest[key])) return false;
    }
    if (JSON.stringify(effectiveEvidenceIdentity(prior.reviewEvidence)) !==
      JSON.stringify(effectiveEvidenceIdentity(current.manifest.reviewEvidence)) ||
      !authenticateFrozenAttachments(predecessorDirectory, prior.reviewEvidence)) return false;
    // A moving symbolic base is provenance, not an effective frozen input.
    // Only a proven fast-forward with the same target merge-base can reuse
    // specialist work; missing/replaced commits and inconclusive git proofs
    // fail closed. Both manifests retain their own observed base tips.
    if (typeof prior.baseRefSha !== 'string' || !/^[0-9a-f]{40}$/u.test(prior.baseRefSha)) return false;
    if (prior.baseRefSha !== current.manifest.baseRefSha) {
      gitRaw(current.manifest.repoPath, ['merge-base', '--is-ancestor', prior.baseRefSha, current.manifest.baseRefSha]);
      if (git(current.manifest.repoPath, ['merge-base', current.manifest.baseRefSha, current.manifest.targetSha]) !== prior.diffBaseSha) return false;
    }
    const files = [
      ['diff.patch', prior.diffSha256, FROZEN_DIFF_MAX_BYTES],
      ['spec-context.md', prior.specSha256, FROZEN_SPEC_MAX_BYTES],
      ['project-conventions.md', prior.conventionsSha256, FROZEN_CONVENTIONS_MAX_BYTES],
    ] as const;
    for (const [name, digest, limit] of files) {
      if (hash(readReviewCheckpointBytes(predecessorDirectory, name, limit)) !== digest) return false;
    }
    if (typeof prior.changedFilesSha256 !== 'string' || prior.changedFilesSha256 !== current.manifest.changedFilesSha256) return false;
    const changed = readReviewCheckpointBytes(predecessorDirectory, 'changed-files.json', FROZEN_CHANGED_FILES_MAX_BYTES);
    if (hash(changed) !== prior.changedFilesSha256 ||
      JSON.stringify(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(changed))) !== JSON.stringify(prior.changedFiles)) return false;
    return true;
  } catch {
    return false;
  }
}

function reviewArtifactPath(review: FrozenReview, relativePath: string): { root: string; path: string } {
  const components = relativePath.split('/');
  if (
    relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0') ||
    components.some((component) => component === '' || component === '.' || component === '..')
  ) throw new Error('review artifact path escapes round directory');
  const root = ensureDirectoryWithoutSymlinks(review.directory);
  const path = resolve(root, ...components);
  if (!contained(root, path) || path === root) throw new Error('review artifact path escapes round directory');
  return { root, path };
}

/** Read a review artifact with the same path-safety rules as writes. A
 * write-once collision is idempotent ONLY when the existing bytes equal
 * what the rejected write would have published; callers use this to tell
 * an idempotent retry apart from a missing-or-stale evidence gap. */
export function readReviewArtifact(review: FrozenReview, relativePath: string): string {
  const { path } = reviewArtifactPath(review, relativePath);
  return readFileSync(path, 'utf8');
}

export function writeReviewArtifact(review: FrozenReview, relativePath: string, value: unknown): string {
  const { root, path } = reviewArtifactPath(review, relativePath);
  const bytes = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  if ((/^attempts\/[a-z]+-[12]\.settled\.json$/u.test(relativePath) ||
    /^specialists\/[a-z]+\.attempt-[12]-[a-f0-9]{8}\.envelope\.json$/u.test(relativePath) ||
    /^children\/[A-Za-z0-9._-]+\.json$/u.test(relativePath)) &&
    Buffer.byteLength(bytes, 'utf8') > SPECIALIST_CHECKPOINT_MAX_BYTES) {
    throw new Error('specialist checkpoint exceeds its recovery byte limit');
  }
  atomicWrite(path, bytes, root);
  return path;
}
