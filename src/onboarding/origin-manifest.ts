import { spawn } from 'node:child_process';
import { redactedText } from '../decisions/questions.js';
import { gitProbeEnvironment } from '../repos/managed-names.js';
import { MANIFEST_PATH } from '../worktrees/manifest.js';

/**
 * Does a managed repository's origin default branch carry a GC manifest
 * (#427)? The same default-branch rules as lane bases (src/worktrees/
 * manager.ts): only the remote's LIVE HEAD symref names the default, the
 * branch is fetched fresh with its exact refspec, and every git step runs
 * with prompts off, a deadline and redacted errors. Unlike a lane, there is
 * no local fallback: anything short of a verified answer is `unverified`,
 * which callers never treat as missing.
 *
 * Async and off the event loop: a scan never blocks boot or the wizard.
 */

export type OriginManifestState = 'present' | 'missing' | 'unverified';

/** A verified answer: origin named its default branch and it was fetched. */
export interface VerifiedOrigin {
  readonly defaultBranch: string;
  /** The fetched default-branch tip the answer is about. */
  readonly headSha: string;
}

export type OriginManifestProbe =
  | (VerifiedOrigin & { readonly state: 'present' })
  | (VerifiedOrigin & { readonly state: 'missing' })
  | {
      readonly state: 'unverified';
      /** Why no answer, redacted: git stderr can carry credential-bearing URLs. */
      readonly reason: string;
    };

/** Budget for one repository's whole probe (live HEAD, fetch, tree read). */
export const ORIGIN_PROBE_TIMEOUT_MS = 30_000;

const OUTPUT_CAP_BYTES = 64 * 1024;
const REASON_MAX_CHARS = 300;
/** After the deadline's SIGTERM (git removes its own lockfiles), the group
 * gets this long before SIGKILL. */
const KILL_GRACE_MS = 1_000;
/** A descendant that left the group can hold the pipes open past SIGKILL;
 * the probe settles this long after the SIGKILL whether or not 'close' comes. */
const SETTLE_AFTER_KILL_MS = 1_000;

interface GitRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn failure or deadline, when git never answered for itself. */
  readonly error: string | null;
}

/** One git step in its own session (no controlling terminal, so ssh cannot
 * prompt either) and process group (a deadline kill reaches git's helpers:
 * SIGTERM first, SIGKILL after a grace). */
function runGit(repoPath: string, args: readonly string[], signal: AbortSignal): Promise<GitRun> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ code: null, stdout: '', stderr: '', error: 'the probe deadline passed before git started' });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
        cwd: repoPath,
        env: { ...gitProbeEnvironment(), GIT_TERMINAL_PROMPT: '0' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: `git failed to start: ${String(error)}` });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => { if (outBytes < OUTPUT_CAP_BYTES) { out.push(chunk); outBytes += chunk.length; } });
    child.stderr?.on('data', (chunk: Buffer) => { if (errBytes < OUTPUT_CAP_BYTES) { err.push(chunk); errBytes += chunk.length; } });
    let timedOut = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const signalGroup = (name: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch { /* already gone */ } }
    };
    const deadlineRun = (): GitRun => ({ code: null, stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8'), error: 'git did not answer within the probe deadline' });
    const kill = (): void => {
      timedOut = true;
      signalGroup('SIGTERM');
      timers.push(setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS));
      timers.push(setTimeout(() => finish(deadlineRun()), KILL_GRACE_MS + SETTLE_AFTER_KILL_MS));
    };
    signal.addEventListener('abort', kill, { once: true });
    let settled = false;
    const finish = (run: GitRun): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', kill);
      for (const timer of timers) clearTimeout(timer);
      resolve(run);
    };
    child.once('error', (error) => finish({ code: null, stdout: '', stderr: '', error: `git failed to start: ${String(error)}` }));
    child.once('close', (code) => finish(timedOut ? deadlineRun() : {
      code,
      stdout: Buffer.concat(out).toString('utf-8'),
      stderr: Buffer.concat(err).toString('utf-8'),
      error: null,
    }));
  });
}

function failure(step: string, run: GitRun): string {
  const detail = run.error ?? (run.stderr.trim() || run.stdout.trim() || `exited ${String(run.code)}`);
  return redactedText(`${step}: ${detail}`, REASON_MAX_CHARS);
}

/**
 * Probe one repository checkout. Reads origin and fetches only its default
 * branch's remote-tracking ref (the lane-base refspec); the working tree,
 * index and local branches are never touched. Never throws.
 */
export async function probeOriginManifest(
  repoPath: string,
  opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<OriginManifestProbe> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), opts.timeoutMs ?? ORIGIN_PROBE_TIMEOUT_MS);
  const stop = (): void => deadline.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  if (opts.signal?.aborted === true) deadline.abort();
  try {
    const live = await runGit(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD'], deadline.signal);
    if (live.code !== 0 || live.error !== null) return { state: 'unverified', reason: failure('origin could not be read', live) };
    const branch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/mu.exec(live.stdout)?.[1];
    // A reachable remote whose HEAD names no branch has no default to read;
    // the cached origin/HEAD is only a guess, never an answer.
    if (branch === undefined || branch === '') return { state: 'unverified', reason: 'origin names no default branch (its HEAD carries no branch symref)' };
    const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
    // No auto gc or maintenance: the probe writes this one ref and nothing else.
    const fetched = await runGit(repoPath, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--no-tags', '--quiet', 'origin', refspec], deadline.signal);
    if (fetched.code !== 0 || fetched.error !== null) return { state: 'unverified', reason: failure(`fetching origin/${branch} failed`, fetched) };
    const tip = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], deadline.signal);
    const headSha = tip.stdout.trim();
    if (tip.code !== 0 || tip.error !== null || headSha === '') return { state: 'unverified', reason: failure(`origin/${branch} did not resolve after the fetch`, tip) };
    const entry = await runGit(repoPath, ['ls-tree', '--full-tree', headSha, '--', MANIFEST_PATH], deadline.signal);
    if (entry.code !== 0 || entry.error !== null) return { state: 'unverified', reason: failure(`reading origin/${branch}'s tree failed`, entry) };
    return entry.stdout.trim() === '' ? { state: 'missing', defaultBranch: branch, headSha } : { state: 'present', defaultBranch: branch, headSha };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
}
