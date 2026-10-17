import { readWorktreeMetadata, repositoryCommonDirectory, capturePortLaneHandoff, captureCwdHandoff, beginLaneHandoff, completeLaneHandoff, rememberManagedLane, registerHandoffManager, assertPendingLaneHandoff, captureCleanupHandoff, assertLaneResourcesAbsent, WorktreeHandoffUnresolvedError } from './handoff.js';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  type Stats,
} from 'node:fs';
import { readdir as readdirAsync, readlink as readlinkAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { LedgerApi, WorktreeBaseSource, WorktreeRecord } from '../ledger/api.js';
import { applyWorktreeManifest, loadWorktreeManifest, MANIFEST_PATH, parseWorktreeManifest, WorktreeSetupError, type WorktreeManifest } from './manifest.js';
import { reclaimIgnored, reclaimState, reclaimTrackedFiles, removeTree, treeUsage } from './reclaim.js';
import { redactedText } from '../decisions/questions.js';
import { boundedTail, recordedTail, redactCredentialWindow } from '../redaction.js';
import { oneLineErrorText } from '../property/error-text.js';
import { repositoryGitEnv } from '../dispatch/perkins-review/artifacts.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Worktree manager (SPEC ruling 18): the dispatch flow's first-class
 * worktree subsystem.
 *
 * (a) Bootstrap manifest — `<repo>/.gru-command/worktree.toml`, applied
 *     automatically at creation (see manifest.ts).
 * (b) Registry — the LEDGER is the authoritative map job → worktree →
 *     branch; creation happens at a freshly-FETCHED origin sha (the base
 *     SOURCE is recorded — 'origin' vs 'local-head-fallback', never a
 *     silent stale base; owner incident 2026-09-23); sweeps match
 *     registry paths only — never id-proximity, never labels.
 * (c) Preserve-first ordered sweep — untracked deliverables preserved
 *     FIRST, processes rooted in the tree enumerated BEFORE removal; any
 *     live process PAUSES the sweep and asks (fail-loud escalation,
 *     never a silent kill); then worktree removal + containment-verified
 *     branch delete.
 * (d) Detached-for-reviews, branch-for-jobs — review rounds check out
 *     detached worktrees; job minions run branches. No review-branch
 *     debris, ever.
 * (e) Concurrency — same-repo worktree creation is sequential (git
 *     index/refs contention); releases re-resolve the FRESH head at
 *     release, never the held sha.
 */

/** One process believed to be rooted in a worktree (pid + evidence). */
export interface TreeProcess {
  readonly pid: number;
  readonly command: string;
  /** How the process was tied to the tree (the pause-and-ask evidence). */
  readonly evidence: 'argv' | 'cwd';
}

/** Injectable process enumeration (default: `ps` argv boundary-match +
 * per-process cwd resolution — see ruling 18b/c). */
export type ProcessEnumerator = (treePath: string) => readonly TreeProcess[];

/**
 * Path-boundary argv match (Perkins r1 B2): the registered tree path must
 * appear as a WHOLE path — never as a substring of a longer name. Sweeping
 * `…/job-a` must find `…/job-a/server.js` but NEVER touch `…/job-a-2` — a
 * substring match would confirm-kill a sibling lane the human never
 * acknowledged (the exact silent-kill class ruling 18c forbids).
 */
export function commandReferencesTree(command: string, treePath: string): boolean {
  const escaped = treePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Preceded by a path char (word, '/', '.', '-') → the match is the tail
  // of a DIFFERENT path; followed by a name-continuation char (word, '.',
  // '-') → the match is the head of a different name ('job-a-2', 'job-a.c').
  const pattern = new RegExp(`(?<![\\w./-])${escaped}(?![\\w.-])`);
  return pattern.test(command);
}

/** A process cwd belongs to the tree when it IS the tree or sits under it. */
function cwdInsideTree(cwd: string, treePath: string): boolean {
  return cwd === treePath || cwd.startsWith(`${treePath}/`);
}

/** Liveness without EPERM confusion (EPERM still proves the pid exists). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signal the process GROUP first (spawned verification runs are detached
 * group leaders, so workers cannot survive the shell), then the pid itself.
 * Returns true when a signal was delivered. */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** Per-process working directories, or null where the platform cannot
 * resolve them (argv-only then — the gap is declared, never guessed). */
function processCwds(): Map<number, string> | null {
  if (process.platform === 'linux') {
    const cwds = new Map<number, string>();
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cwd = readlinkSync(`/proc/${entry}/cwd`);
        cwds.set(Number(entry), cwd);
      } catch {
        // Not ours / gone — unresolvable pids are simply not cwd-evidence.
      }
    }
    return cwds;
  }
  if (process.platform === 'darwin') {
    let out: string;
    try {
      out = execFileSync('lsof', ['-w', '-a', '-d', 'cwd', '-Fn'], {
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      return null;
    }
    const cwds = new Map<number, string>();
    let pid: number | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p') && /^p\d+$/.test(line)) {
        pid = Number(line.slice(1));
      } else if (line.startsWith('n') && pid !== null) {
        cwds.set(pid, line.slice(1));
        pid = null;
      }
    }
    return cwds;
  }
  return null; // other platforms: argv-boundary only (declared gap)
}

/** The system process table, tied to a registered worktree by argv
 * (path-boundary) OR by the process's actual working directory — a
 * `node server.js` spawned inside the tree carries no path in argv but
 * its cwd is the tree (Perkins r1 B3: argv-only enumeration removed
 * trees under live agents). */
export function psEnumerator(treePath: string): readonly TreeProcess[] {
  return treeProcesses(treePath, execFileSyncGuard('ps', ['-axo', 'pid=,command=']), processCwds());
}

/** The processes a `ps -axo pid=,command=` listing and the per-process
 * cwds tie to a tree (by argv path boundary, or by cwd). */
function treeProcesses(treePath: string, out: string, cwds: Map<number, string> | null): readonly TreeProcess[] {
  // Compare against BOTH the registered path and its realpath: the OS
  // reports resolved paths (/var → /private/var) while argv keeps the
  // spelling the spawner used.
  const candidates = new Set([treePath]);
  try {
    candidates.add(realpathSync(treePath));
  } catch {
    /* the sweep's own guards handle a missing tree */
  }
  const processes: TreeProcess[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const command = trimmed.slice(space + 1).trim();
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    // Registry paths only: every match names the registered tree itself.
    if ([...candidates].some((candidate) => commandReferencesTree(command, candidate))) {
      processes.push({ pid, command, evidence: 'argv' });
      continue;
    }
    if (cwds !== null) {
      const cwd = cwds.get(pid);
      if (cwd !== undefined && [...candidates].some((candidate) => cwdInsideTree(cwd, candidate))) {
        processes.push({ pid, command, evidence: 'cwd' });
      }
    }
  }
  return processes;
}

function execFileSyncGuard(bin: string, args: readonly string[]): string {
  return execFileSync(bin, args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
}

/** One listing command, off the event loop and bounded; rejects, naming
 * the command, when it cannot run, fails or runs past its bound. */
function execFileBounded(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile(bin, args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs }, (error, stdout) => {
      if (error === null) resolveOut(stdout);
      else reject(new Error(error.killed ? `${bin} timed out after ${String(timeoutMs)} ms` : `${bin} failed: ${error.message.split('\n')[0] ?? ''}`));
    });
  });
}

/** {@link processCwds} off the event loop: Linux `/proc`, macOS `lsof`
 * (bounded); null on any other platform. Rejects when the listing fails
 * (`/proc` cannot be read, `lsof` failed or timed out), so its caller is
 * told ({@link psEnumeratorAsync}'s `onCwdError`) rather than lose the cwd
 * evidence silently. */
async function processCwdsAsync(timeoutMs: number): Promise<Map<number, string> | null> {
  if (process.platform === 'linux') {
    const cwds = new Map<number, string>();
    for (const entry of await readdirAsync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        cwds.set(Number(entry), await readlinkAsync(`/proc/${entry}/cwd`));
      } catch {
        // Not ours / gone — unresolvable pids are simply not cwd-evidence.
      }
    }
    return cwds;
  }
  if (process.platform !== 'darwin') return null;
  const out = await execFileBounded('lsof', ['-w', '-a', '-d', 'cwd', '-Fn'], timeoutMs);
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p') && /^p\d+$/.test(line)) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && pid !== null) {
      cwds.set(pid, line.slice(1));
      pid = null;
    }
  }
  return cwds;
}

/** {@link psEnumerator} off the event loop, each listing bounded by
 * `timeoutMs` (#427 onboarding proof: a slow `lsof` on a loaded host must
 * not stall the service). Rejects when `ps` fails or times out, whatever
 * the working directories did. When `ps` answered and only the working
 * directories cannot be listed (`/proc` unreadable, `lsof` failed or timed
 * out), `onCwdError` is told and the argv matches still count, as the
 * synchronous enumerator's null cwds do: never silently. That enumerator,
 * which the sweep uses, is unchanged. `listCwds`: its tests' seam. */
export async function psEnumeratorAsync(treePath: string, opts: {
  readonly timeoutMs?: number;
  readonly onCwdError: (error: unknown) => void;
  readonly listCwds?: (timeoutMs: number) => Promise<Map<number, string> | null>;
}): Promise<readonly TreeProcess[]> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const [listed, cwds] = await Promise.allSettled([
    execFileBounded('ps', ['-axo', 'pid=,command='], timeoutMs),
    (opts.listCwds ?? processCwdsAsync)(timeoutMs),
  ]);
  if (listed.status === 'rejected') throw listed.reason instanceof Error ? listed.reason : new Error(String(listed.reason));
  if (cwds.status === 'rejected') opts.onCwdError(cwds.reason);
  return treeProcesses(treePath, listed.value, cwds.status === 'fulfilled' ? cwds.value : null);
}

export interface SweepPreservation {
  readonly count: number;
  readonly destination: string;
}

/** The lane's uncommitted tracked work, saved before its removal (#427):
 * one commit whose parent is the lane's HEAD and whose tree is the lane's
 * index with every tracked edit and deletion added (`git add -u`).
 * Untracked files are not in it: the preserve copy keeps them.
 * `git cherry-pick --no-commit <ref>` applies it to a checkout. */
export interface SweepSnapshot {
  /** `refs/gru/preserved/<lane>/<UTC stamp>`, never a branch or tag;
   * `<lane>` is the lane id, or `x-` and its hex when git refuses the id
   * as one ref-name component. */
  readonly ref: string;
  /** The snapshot commit the ref names. */
  readonly sha: string;
  /** Tracked paths the snapshot changes against the lane's HEAD. */
  readonly files: number;
}

/** Where a lane's snapshots live (#427): outside refs/heads and refs/tags,
 * so no branch or tag list ever shows one. */
export const PRESERVED_REF_PREFIX = 'refs/gru/preserved';

/** A sweep met a git operation that is not finished (a merge, rebase,
 * cherry-pick, revert, bisect or multi-commit sequence, or unmerged index
 * entries). The tree is retained: a snapshot taken now would not say what
 * the lane meant. */
export class LaneOperationInProgressError extends Error {
  constructor(readonly path: string, readonly operation: string, readonly clear: string) {
    super(`sweep refused: ${operation} is in progress in ${path} — run ${clear} in the lane, then release again; the tree is retained`);
    this.name = 'LaneOperationInProgressError';
  }
}

/** The lane's snapshot could not be built or proven (#427). The tree is
 * retained: it is built and proven in the removal tail, after the lane's
 * processes are handled and before anything is removed. */
export class LaneSnapshotError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`sweep refused: the snapshot of the uncommitted work in ${path} ${detail} — the tree is retained; resolve what git reported (or stop what still writes in the lane), then release again`);
    this.name = 'LaneSnapshotError';
  }
}

/** A sparse checkout (#427): entries outside its cone carry skip-worktree
 * and are absent from disk, so GC cannot tell an entry the cone left out
 * from one a minion deleted, and a snapshot could record the wrong tree.
 * Refused by name, with the tree retained. */
export class LaneSparseCheckoutError extends Error {
  constructor(readonly path: string) {
    super(`sweep refused: ${path} is a sparse checkout (core.sparseCheckout is on), and GC cannot save its uncommitted work without risking a wrong tree — commit and push the lane's work (or run git sparse-checkout disable in the lane), then release again; the tree is retained`);
    this.name = 'LaneSparseCheckoutError';
  }
}

/** A submodule of the lane holds work the removal would destroy (#427). */
export interface SubmoduleWork {
  /** The submodule's path in the lane. */
  readonly path: string;
  /** What it holds, in words: a commit that survives nowhere else (its
   * HEAD, a gitlink, a local branch or a stash entry), modified tracked
   * content. */
  readonly state: readonly string[];
  /** The submodule's HEAD in the lane, null when it has none. */
  readonly head: string | null;
}

/** A release would destroy submodule work (#427): a lane's submodules keep
 * their git data in the lane's own git folder, which the removal deletes,
 * and a snapshot of the superproject records only the gitlink. Refused by
 * name, with the tree retained, unless an operator release discards exactly
 * this work by its `digest` (the submodules, their states, HEADs, content
 * and commits). */
export class LaneSubmoduleWorkError extends Error {
  constructor(
    readonly path: string,
    readonly submodules: readonly SubmoduleWork[],
    readonly digest: string,
    /** The digest a discard carried that no longer matches, if any. */
    readonly staleDiscard: string | null = null,
  ) {
    super(
      `sweep refused: submodule work in ${path} would be destroyed with the lane (${submodules
        .map((sub) => `${sub.path}: ${sub.state.join(', ')}`)
        .join('; ')}) — push the submodule commit (git push inside the submodule), and commit and push ` +
        'modified content inside each submodule, ' +
        `or discard exactly this work with an operator release that passes discard_submodule_work: "${digest}"` +
        `${staleDiscard === null ? '' : ` (the discard named ${staleDiscard}, which is not the work the lane holds now)`}; the tree is retained`,
    );
    this.name = 'LaneSubmoduleWorkError';
  }
}

/** How a slim attempt ended (#427): what was deleted, what was skipped by
 * name, or why the lane was not slimmed at all. */
export type SlimResult =
  | {
      readonly status: 'slimmed';
      /** What was deleted (an entry whose delete failed is in `skipped`). */
      readonly entries: readonly { readonly path: string; readonly bytes: number }[];
      readonly freedBytes: number;
      /** Bytes of deleted files whose inodes are still linked from outside
       * the entries (a package store's hard links): not freed. */
      readonly sharedBytes: number;
      readonly skipped: readonly { readonly path: string; readonly reason: string }[];
    }
  | {
      readonly status: 'not-slimmed';
      readonly reason: string;
      /** The answer cannot change for this lane: it comes from the content
       * of its base manifest (none, no reclaim, no setup, unparseable, or
       * every entry holds a link or copy destination), from a lane with no
       * bootstrap record, or from a restore whose setup did not recreate
       * what it made at bootstrap. A git or ledger failure never makes it
       * permanent. */
      readonly permanent: boolean;
      /** Every entry was checked (the skipped list is the whole plan's);
       * false for a lane declined before its plan ran. */
      readonly planned: boolean;
      readonly skipped: readonly { readonly path: string; readonly reason: string }[];
    };

/** What a restore before a turn or a verification did for one lane (#427).
 * `notRecreated`: deleted entries setup did not bring back (a build or
 * verify makes them). */
export type LaneRestore =
  | { readonly id: string; readonly status: 'ready' }
  | { readonly id: string; readonly status: 'rehydrated'; readonly ms: number; readonly notRecreated: readonly string[] }
  | { readonly id: string; readonly status: 'rehydrate-failed'; readonly error: string };

export type SweepResult =
  | {
      readonly status: 'paused';
      readonly processes: readonly TreeProcess[];
      readonly preserved: SweepPreservation | null;
      readonly note: string;
    }
  | {
      readonly status: 'swept';
      readonly preserved: SweepPreservation | null;
      readonly branch: 'deleted' | 'retained' | 'none';
      readonly freshHead: string;
      /** The uncommitted work saved before this removal; null when there
       * was none. Absent when this call removed nothing (an earlier sweep
       * did). */
      readonly snapshot?: SweepSnapshot | null;
    };

/** A release request ({@link WorktreeManager.release}). */
export interface SweepRequest {
  readonly worktreeId: string;
  readonly confirmKill?: boolean;
  readonly baseBranch?: string;
  /** Issue #243 F-H1: the UNATTENDED autopilot release must prove fresh
   * required containment BEFORE any forced removal — an operator release
   * keeps its current answer/confirm authority and leaves this false.
   * Uncommitted work no longer refuses it: every release snapshots it
   * (#427). */
  readonly requireReleaseProofs?: boolean;
  /** #427: an OPERATOR release may discard submodule work the removal
   * destroys (a commit that survives nowhere else, modified tracked
   * content), which every other release refuses by name. It carries the
   * digest that refusal named ({@link LaneSubmoduleWorkError.digest}): the
   * discard covers only that work, and the release refuses again when the
   * lane's submodule work changed since. The discard is audited with
   * `worktree.submodule-work-discarded`, naming each submodule. The
   * autopilot never passes it. */
  readonly discardSubmoduleWork?: string;
}

/** One release attempt's state across its steps (#427). */
interface SweepAttempt {
  readonly discardSubmoduleWork: string | null;
  /** Set once the preserve copy is on the record (`worktree.preserved`, or
   * an earlier aborted release's copy this one reuses): from then on a
   * refusal keeps it, so no record names a missing copy. */
  copyRecorded: boolean;
  /** The lane's last aborted release, whose preserve copy, snapshot ref
   * and discard record a retry reuses while the work is unchanged. */
  readonly aborted: AbortedRelease | null;
  /** This attempt reuses the aborted release's preserve copy. */
  preserveReused: boolean;
}

/** What `worktree.release-aborted` names (#427): a release that failed
 * after its records, so a retry can reuse what it saved. */
interface AbortedRelease {
  readonly preserved: SweepPreservation | null;
  readonly snapshot: { readonly ref: string; readonly sha: string } | null;
  readonly discarded: string | null;
}

/** What the submodule check found (#427): the work a removal would
 * destroy, its digest, and the submodules whose untracked content the
 * preserve copy takes. */
interface SubmoduleScan {
  readonly work: readonly SubmoduleWork[];
  readonly digest: string;
  readonly untracked: readonly string[];
}

export interface WorktreeManagerOptions {
  readonly ledger: LedgerApi;
  /** Root under which worktrees are created (`<root>/<repo>/…`). */
  readonly root: string;
  /** Root for preserved untracked deliverables. */
  readonly preserveRoot: string;
  /** One-time setup command budget per worktree bootstrap. */
  readonly setupTimeoutMs: number;
  /** Grace between the acknowledged SIGTERM and the SIGKILL (ms). */
  readonly killGraceMs?: number;
  /** Fetch budget for origin base resolution (default 30 s) — a network
   * op degrades to the declared local fallback, it never hangs the lane. */
  readonly fetchTimeoutMs?: number;
  /** FYI sink when a lane could not fetch origin and fell back to local
   * HEAD (the degraded path is also recorded in the registry row; owner
   * incident 2026-09-23 — staleness is visible, never silent). Wired to
   * the notification center in main.ts. A sink failure never fails the
   * lane: the registry row is the durable record. */
  readonly onBaseFallback?: (input: {
    readonly worktreeId: string;
    readonly jobId: string;
    readonly repoPath: string;
    readonly repoName: string;
    readonly defaultBranch: string | null;
    readonly sha: string;
    readonly detail: string;
  }) => void;
  /** Escalation when a sweep pauses on live processes (fail-loud ask). */
  readonly onSweepPaused?: (input: {
    readonly worktree: WorktreeRecord;
    readonly processes: readonly TreeProcess[];
  }) => void;
  /** Positive evidence that a lane tree is gone and its row is swept:
   * producer-side resolution for any pause notice about that worktree
   * (owner release 2026-10-11) — the condition ended, so the notice does. */
  readonly onSwept?: (input: { readonly worktree: WorktreeRecord }) => void;
  /** A completed release saved the lane's work (#427): a snapshot of its
   * uncommitted tracked work, a preserve copy of its untracked files, or
   * both. Called once per release that saved either, after the sweep, so
   * the owner can be told where it is ({@link sweepWorkNotice}). */
  readonly onWorkSaved?: (input: SavedWork) => void;
  /** A release was refused for submodule work (#427): called once per lane
   * and digest, so Gru hears about it ({@link submoduleWorkNotice}).
   * `previousDigest`: the lane's earlier refusal this one supersedes. */
  readonly onSubmoduleWorkRefused?: (input: {
    readonly worktree: WorktreeRecord;
    readonly submodules: readonly SubmoduleWork[];
    readonly digest: string;
    readonly previousDigest: string | null;
  }) => void;
  /** A restore's setup succeeded but did not recreate what it made when
   * the lane was bootstrapped (#427): the lane stays slim and is never
   * slimmed again, and Gru hears about it once per lane
   * ({@link restoreIncompleteNotice}). */
  readonly onRestoreIncomplete?: (input: { readonly worktree: WorktreeRecord; readonly missing: readonly string[] }) => void;
  readonly enumerateProcesses?: ProcessEnumerator;
  readonly log?: Log;
}

interface SpawnGitOptions {
  /** Kill the git process after this budget (a service degrades, never hangs). */
  readonly timeoutMs?: number;
  /** Suppress interactive credential prompts (same reason). */
  readonly noPrompt?: boolean;
  /** Author and commit as GC: a sweep snapshot is GC's commit, and a host
   * with no git identity must still be able to make one. */
  readonly gcIdentity?: boolean;
  /** Use this index instead of the lane's own (`GIT_INDEX_FILE`): a sweep
   * snapshot never writes the real index. */
  readonly indexFile?: string;
  /** Output bound (default 16 MiB): a whole-tree listing needs more. */
  readonly maxBuffer?: number;
  /** Bytes on the command's stdin (`--stdin` path lists). */
  readonly input?: string;
}

/** What a completed release saved (#427), for the owner's notice. */
export interface SavedWork {
  readonly worktree: WorktreeRecord;
  readonly snapshot: SweepSnapshot | null;
  readonly preserved: SweepPreservation | null;
}

/** The bound for a listing of every path in a lane (`ls-files -s`). */
const LISTING_MAX_BUFFER = 512 * 1024 * 1024;

/** A snapshot built and proven, before it is committed (#427). */
interface BuiltSnapshot {
  readonly head: string;
  readonly tree: string;
  readonly files: number;
}

const GC_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Gru Command',
  GIT_AUTHOR_EMAIL: 'gru-command@localhost',
  GIT_COMMITTER_NAME: 'Gru Command',
  GIT_COMMITTER_EMAIL: 'gru-command@localhost',
} as const;

function runGit(repoPath: string, args: readonly string[], opts: SpawnGitOptions = {}): string {
  const { status, stdout, stderr, error } = spawnGit(repoPath, args, opts);
  if (status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${status}) in ${repoPath}: ${
        stderr.trim() || error || stdout.trim()
      }`,
    );
  }
  return stdout.trim();
}

function spawnGit(
  repoPath: string,
  args: readonly string[],
  opts: SpawnGitOptions = {},
): { status: number | null; stdout: string; stderr: string; error: string | null } {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    env: {
      ...repositoryGitEnv(false),
      ...(opts.noPrompt === true ? { GIT_TERMINAL_PROMPT: '0' } : {}),
      ...(opts.gcIdentity === true ? GC_GIT_IDENTITY : {}),
      ...(opts.indexFile !== undefined ? { GIT_INDEX_FILE: opts.indexFile } : {}),
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error !== undefined ? String(result.error) : null,
  };
}

/** Git's locked worktree reason survives a failed post-checkout hook and
 * identifies this invocation, unlike a pre-add absence check. Branches are
 * created atomically with a matching reflog receipt, never claimed via DWIM. */
interface CreationCustody {
  readonly token: string;
  readonly branch: string | null;
  readonly sha: string;
  branchCreated: boolean;
  addAttempted: boolean;
}

/** A lane base resolved to a concrete commit, with its provenance. */
interface ResolvedBase {
  readonly sha: string;
  readonly baseSource: WorktreeBaseSource;
  readonly defaultBranch: string | null;
  /** Why the degraded path was taken (null when `baseSource` is 'origin'). */
  readonly fallbackDetail: string | null;
}

/** True when a ref's SPELLING names an EXACT origin remote branch — the
 * origin prefix stripped, the remainder is a syntactically plausible
 * branch name. Origin-prefixed REVISION EXPRESSIONS (origin/main~1,
 * origin/main^, origin/main@{u}) are NOT branch spellings: a real branch
 * name cannot contain their operators, and routing one to the fetch would
 * fetch a literal branch named "main~1" instead of resolving the named
 * ancestor. Such spellings keep pin semantics (resolved exactly as
 * named, refusing loudly when unresolvable). */
export function isExactOriginBranchSpelling(ref: string): boolean {
  const stripped = ref.replace(/^(?:refs\/)?remotes\/origin\/|^origin\//u, '');
  if (stripped === '' || stripped === ref) return false; // no origin prefix
  // Revision-expression operators and git's forbidden ref-name sequences.
  // A misclassification here can only land on a loud refusal (a fetch of a
  // name the remote rejects), never on wrong bytes.
  return !/[~^:@\s]|\.\./u.test(stripped) && !stripped.startsWith('-');
}

export class WorktreeManager {
  private readonly opts: WorktreeManagerOptions;
  private readonly log: Log;
  private readonly enumerate: ProcessEnumerator;
  private readonly fetchTimeoutMs: number;
  /** Same-repo serialization (ruling 18e): one creation at a time. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();
  /** Per-lane serialization of a slim and the restore before a turn or a
   * verification (#427): a restore that waits here runs after the slim. */
  private readonly laneLocks = new Map<string, Promise<unknown>>();
  /** Set by finishSweep's tail guard; drained by recordSweepEvent. */
  private tailFailure: string | null = null;

  constructor(opts: WorktreeManagerOptions) {
    registerHandoffManager(this, opts.ledger);
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.enumerate = opts.enumerateProcesses ?? psEnumerator;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 30_000;
  }

  /** Serialize per-repo mutations (worktree add/remove, branch deletes). */
  private withRepoLock<T>(repoPath: string, run: () => Promise<T>): Promise<T> {
    const key = realpathSync(repoPath);
    const previous = this.repoLocks.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch(() => {});
    this.repoLocks.set(key, settled);
    void settled.then(() => {
      if (this.repoLocks.get(key) === settled) this.repoLocks.delete(key);
    });
    return next;
  }

  /** Serialize a slim with the restores of the same lane (#427). */
  private withLaneLock<T>(laneId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.laneLocks.get(laneId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch(() => {});
    this.laneLocks.set(laneId, settled);
    void settled.then(() => {
      if (this.laneLocks.get(laneId) === settled) this.laneLocks.delete(laneId);
    });
    return next;
  }

  /**
   * The base-resolution contract (owner incident 2026-09-23): a lane
   * branches from the FETCHED origin default-branch tip — never from the
   * worktree-host clone's local checkout, which can be hours stale. The
   * degraded path is DECLARED: a fetch failure falls back to local HEAD
   * with baseSource 'local-head-fallback' (recorded in the registry row,
   * surfaced by an FYI) — staleness is visible, never silent.
   */
  private resolveBase(repoPath: string): ResolvedBase {
    const resolved = this.resolveDefaultBranch(repoPath);
    const defaultBranch = resolved.branch;
    const localHead = (): string => runGit(repoPath, ['rev-parse', 'HEAD']);
    if (defaultBranch === null) {
      const detail = resolved.authoritativeAbsence
        ? `origin default branch is unresolvable — the reachable remote's HEAD names no branch ` +
          `(${resolved.liveDetail ?? 'no symref'}); cached origin/HEAD deliberately not trusted`
        : `origin default branch is unresolvable — live probe: ${
            resolved.liveDetail ?? 'named no branch'
          }, no cached origin/HEAD`;
      this.log('warn', 'base resolution degraded to the local checkout', { repo: repoPath, detail });
      return { sha: localHead(), baseSource: 'local-head-fallback', defaultBranch: null, fallbackDetail: detail };
    }
    const fetched = this.fetchOriginTip(repoPath, defaultBranch);
    // A cache-guessed default (the live probe FAILED — offline or
    // transient) is NEVER verified freshness, even when the fetch
    // succeeds (Perkins r6 B1): the fetch proves the branch exists, not
    // that the remote still calls it default. Only a LIVE-probed default
    // may record 'origin'; the cache-guessed path takes the APPROVED
    // declared local-HEAD fallback with a visible FYI — no fail-closed
    // redesign, no new provenance label.
    if (!resolved.verified) {
      const detail = fetched.ok
        ? `origin default UNVERIFIED — live probe failed (${resolved.liveDetail ?? 'unreachable'}); ` +
          `origin/${defaultBranch} fetched at ${fetched.sha} proves the branch exists, not that it is the default — ` +
          'degraded to local HEAD'
        : fetched.detail;
      this.log('warn', 'base resolution degraded to the local checkout (default unverified)', {
        repo: repoPath,
        branch: defaultBranch,
        detail,
      });
      return {
        sha: localHead(),
        baseSource: 'local-head-fallback',
        defaultBranch,
        fallbackDetail: detail,
      };
    }
    if (fetched.ok) {
      return { sha: fetched.sha, baseSource: 'origin', defaultBranch, fallbackDetail: null };
    }
    this.log('warn', 'base resolution degraded to the local checkout (origin fetch failed)', {
      repo: repoPath,
      branch: defaultBranch,
      detail: fetched.detail,
    });
    return {
      sha: localHead(),
      baseSource: 'local-head-fallback',
      defaultBranch,
      fallbackDetail: fetched.detail,
    };
  }

  /** The remote's own HEAD symref, asked live — the AUTHORITY for the
   * default branch. The cached `refs/remotes/origin/HEAD` can name a
   * branch the remote has since demoted (Perkins blocker: default
   * renamed main→trunk while main stayed fetchable — lanes branched
   * from the stale main recorded as 'origin'); only the live answer
   * proves what the remote calls default TODAY. */
  private liveDefaultBranch(
    repoPath: string,
  ): {
    readonly branch: string | null;
    readonly detail: string | null;
    /** True when the probe SUCCEEDED and authoritatively found no default
     * (exit 0, no symref line): the reachable remote names no branch, so
     * no cached value may speak for it (Perkins R5 — consulting the
     * cache here selected a demoted-but-fetchable branch and recorded it
     * as 'origin'). False when the probe failed/unreachable — the cache
     * remains the declared offline guess. */
    readonly authoritativeAbsence: boolean;
  } {
    const live = spawnGit(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD'], {
      timeoutMs: this.fetchTimeoutMs,
      noPrompt: true,
    });
    if (live.status === 0) {
      const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu.exec(live.stdout);
      if (match !== null && match[1] !== undefined && match[1] !== '') {
        return { branch: match[1], detail: null, authoritativeAbsence: false };
      }
      // Exit 0 but no symref line: the reachable remote names no default
      // HEAD — an AUTHORITATIVE absence, never a cache consultation.
      return { branch: null, detail: 'remote HEAD carries no branch symref', authoritativeAbsence: true };
    }
    const detail = live.stderr.trim() || live.error || live.stdout.trim();
    return {
      branch: null,
      // Redacted at the source (Perkins r6 W3): raw git stderr can carry
      // credential-bearing remote URLs into logs and persisted FYIs.
      detail: redactedText(detail === '' ? `ls-remote exited ${String(live.status)}` : detail, 500),
      authoritativeAbsence: false,
    };
  }

  /**
   * The origin default branch, resolved PER-REPO — never a hardcoded
   * 'main': (1) the remote's LIVE HEAD symref (the authority — a cached
   * value can go stale exactly when the remote renames its default),
   * else (2) offline, the cached remote HEAD (`refs/remotes/origin/HEAD`)
   * as a declared guess that the fetch must still validate. The repo's
   * checked-out branch is deliberately NOT consulted — a host clone on
   * a lane branch must never be taken to name the default (Perkins
   * blocker). Null = nothing names a default; the caller declares the
   * degraded fallback.
   */
  private resolveDefaultBranch(repoPath: string): {
    readonly branch: string | null;
    readonly liveDetail: string | null;
    readonly authoritativeAbsence: boolean;
    /** True ONLY when the LIVE probe named the branch — a cache-guessed
     * default is never verified freshness (Perkins r6 B1). */
    readonly verified: boolean;
  } {
    const live = this.liveDefaultBranch(repoPath);
    if (live.branch !== null) {
      return { branch: live.branch, liveDetail: null, authoritativeAbsence: false, verified: true };
    }
    // A SUCCESSFUL probe that names no branch is authoritative (Perkins
    // R5): the reachable remote has no default HEAD, so the cached
    // origin/HEAD must NOT speak for it — a stale cache naming a
    // demoted-but-fetchable branch would base the lane on a non-default
    // and record it as 'origin'. The cache is a fallback ONLY when the
    // probe failed (offline), where the fetch still validates the guess.
    if (live.authoritativeAbsence) {
      return { branch: null, liveDetail: live.detail, authoritativeAbsence: true, verified: false };
    }
    const cached = spawnGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (cached.status === 0) {
      const name = cached.stdout.trim();
      const prefix = 'origin/';
      if (name.startsWith(prefix) && name.length > prefix.length) {
        return {
          branch: name.slice(prefix.length),
          liveDetail: live.detail,
          authoritativeAbsence: false,
          verified: false,
        };
      }
    }
    return {
      branch: null,
      liveDetail: live.detail,
      authoritativeAbsence: live.authoritativeAbsence,
      verified: false,
    };
  }

  /** `git fetch origin <branch>` with an explicit refspec so the
   * remote-tracking ref updates deterministically, then resolve its tip
   * commit. Never throws: the caller owns the declared fallback. */
  private fetchOriginTip(
    repoPath: string,
    branch: string,
  ): { ok: true; sha: string } | { ok: false; detail: string } {
    const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
    const fetched = spawnGit(repoPath, ['fetch', '--no-tags', 'origin', refspec], {
      timeoutMs: this.fetchTimeoutMs,
      noPrompt: true,
    });
    if (fetched.status !== 0) {
      const detail = fetched.stderr.trim() || fetched.error || fetched.stdout.trim();
      return {
        ok: false,
        detail: redactedText(detail === '' ? `git fetch exited ${String(fetched.status)}` : detail, 500),
      };
    }
    const tip = spawnGit(repoPath, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
    const sha = tip.stdout.trim();
    if (tip.status !== 0 || sha === '') {
      const detail = tip.stderr.trim() || tip.error || 'empty revision';
      return { ok: false, detail: `origin/${branch} did not resolve after the fetch: ${detail}`.slice(0, 500) };
    }
    return { ok: true, sha };
  }

  /** Freshly-resolved base sha — the fetched origin tip; local HEAD only in
   * the declared degraded path. Always at creation/release time, never
   * held. */
  private freshHead(repoPath: string): string {
    return this.resolveBase(repoPath).sha;
  }

  /** The degraded-path FYI (owner incident 2026-09-23): the registry row
   * records baseSource; this sink surfaces it to the operator. A sink
   * failure never fails the lane. */
  private announceBaseFallback(repoName: string, jobId: string, repoPath: string, base: ResolvedBase): void {
    try {
      this.opts.onBaseFallback?.({
        worktreeId: jobId,
        jobId,
        repoPath,
        repoName,
        defaultBranch: base.defaultBranch,
        sha: base.sha,
        detail: base.fallbackDetail ?? 'origin base unavailable',
      });
    } catch (error) {
      this.log('error', 'base-fallback FYI sink failed (registry row still records base_source)', {
        repo: repoPath,
        job: jobId,
        error: String(error),
      });
    }
  }

  /**
   * Detached review ref resolution (ruling 18d). A ref that names a
   * tracking ref of the origin remote is FETCHED fresh first — the same
   * fetch discipline as job lanes: a review must never check out a stale
   * origin tip, and an unfetchable origin ref REFUSES rather than degrade
   * (a stale review is a wrong review, not an offline one). Explicit
   * commits and local refs are pinned exactly as before — the merged
   * PR-head freeze resolves its target to a fetched sha upstream and that
   * sha resolves unchanged here.
   */
  private resolveReviewRef(
    repoPath: string,
    ref: string,
  ): { sha: string; baseSource: WorktreeBaseSource | null; trackingRef: string | null } {
    const prefix = 'refs/remotes/origin/';
    const strip = /^(?:refs\/)?remotes\/origin\/|^origin\//u;
    /** The fetch discipline one origin-branch spelling always gets. */
    const fetchedOriginBranch = (branch: string | null, namedAs: string, unverifiedDetail: string | null = null): {
      sha: string;
      baseSource: WorktreeBaseSource | null;
      trackingRef: string;
    } => {
      if (branch === null) {
        throw new Error(
          `review ref ${namedAs} names origin/HEAD but the origin default branch is unresolvable — ` +
            'refusing to check out a possibly stale origin tip',
        );
      }
      if (unverifiedDetail !== null) {
        // A cache-guessed default is never verified freshness (Perkins r6
        // B1): reviewing a possibly-non-default tip is a wrong review.
        throw new Error(
          `review ref ${namedAs} names origin/HEAD but the default could not be verified live (${unverifiedDetail}) — ` +
            'refusing to check out a possibly non-default origin tip; verify the remote and retry',
        );
      }
      const fetched = this.fetchOriginTip(repoPath, branch);
      if (!fetched.ok) {
        throw new Error(
          `review ref ${namedAs} names origin/${branch} but fetching it fresh failed: ${fetched.detail} — ` +
            'refusing to check out a possibly stale origin tip; verify the remote and retry',
        );
      }
      return { sha: fetched.sha, baseSource: 'origin', trackingRef: `refs/remotes/origin/${branch}` };
    };
    // (1) An EXACT origin-branch spelling classifies FIRST (Perkins R5):
    // git's ambiguous DWIM lets a local refs/heads/origin/topic or
    // refs/tags/origin/topic SHADOW refs/remotes/origin/topic — the
    // spelling would resolve to LOCAL bytes posing as the remote and pin
    // them without a fetch. The spelling means the REMOTE branch: fetch
    // it fresh, fail closed (origin/HEAD resolves through the default
    // branch; origin-prefixed revision expressions like origin/main~1
    // are NOT exact spellings and never take this path — Perkins R4).
    if (isExactOriginBranchSpelling(ref)) {
      const stripped = ref.replace(strip, '');
      if (stripped === 'HEAD') {
        const resolvedDefault = this.resolveDefaultBranch(repoPath);
        return fetchedOriginBranch(
          resolvedDefault.branch,
          ref,
          resolvedDefault.branch === null || resolvedDefault.verified ? null : (resolvedDefault.liveDetail ?? 'unreachable'),
        );
      }
      return fetchedOriginBranch(stripped, ref);
    }
    // (2) Everything else resolves locally — DWIM symbolic lookup first
    // (a local branch, tag, or another remote's tracking ref), else the
    // exact pin (SHAs, tags, revision expressions). Exact origin
    // spellings never reach here; should a pathological spelling still
    // DWIM-resolve onto an origin tracking ref, it gets the same fetch
    // discipline — never a possibly-stale local pin.
    const symbolic = spawnGit(repoPath, ['rev-parse', '--symbolic-full-name', '--verify', ref]);
    const fullName = symbolic.status === 0 ? symbolic.stdout.trim() : '';
    if (fullName.startsWith(prefix) && fullName.length > prefix.length) {
      const suffix = fullName.slice(prefix.length);
      const branch = suffix === 'HEAD' ? this.resolveDefaultBranch(repoPath).branch : suffix;
      return fetchedOriginBranch(branch, ref);
    }
    return { sha: runGit(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]), baseSource: null, trackingRef: null };
  }

  /** Resolve a review target exactly as `createReviewWorktree` does —
   * same resolver, no worktree: origin tracking refs are FETCHED fresh
   * (refusing when unfetchable), everything else pins exactly. The
   * Perkins freeze path resolves its non-PR targets here so the frozen
   * round identity and the checked-out bytes share ONE fetch-aware
   * resolution (Perkins blocker: pre-resolving locally froze stale
   * bytes the manager could never fetch). */
  async resolveReviewTarget(input: {
    repoPath: string;
    ref: string;
  }): Promise<{ readonly sha: string; readonly baseSource: WorktreeBaseSource | null; readonly trackingRef: string | null }> {
    return this.withRepoLock(input.repoPath, async () => this.resolveReviewRef(input.repoPath, input.ref));
  }

  private assertRepo(repoPath: string): { repoPath: string; repoName: string } {
    const canonical = realpathSync(repoPath);
    const topLevel = runGit(canonical, ['rev-parse', '--show-toplevel']);
    if (realpathSync(topLevel) !== canonical) {
      throw new Error(
        `worktree root mismatch: ${repoPath} resolves to ${canonical} but its repo top-level is ${topLevel}`,
      );
    }
    return { repoPath: canonical, repoName: basename(canonical) };
  }

  /**
   * Branch-for-jobs (ruling 18d): one worktree per job, on its own
   * branch `gru/<jobId>`, created at the FETCHED origin head —
   * sequential per repo (ruling 18e), manifest auto-applied (18a),
   * registry row written (18b) with the base's provenance (18b).
   */
  async createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeRecord> {
    if (input.jobId === '') throw new Error('job id must be non-empty');
    return this.withRepoLock(input.repoPath, async () => {
      const repo = this.assertRepo(input.repoPath);
      const branch = `gru/${input.jobId}`;
      const existing = spawnGit(repo.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (existing.status === 0) {
        throw new Error(`branch ${branch} already exists — one lane per job, never a reused held branch`);
      }
      const path = join(this.opts.root, repo.repoName, `job-${input.jobId}`);
      if (existsSync(path)) {
        throw new Error(`worktree path already exists: ${path}`);
      }
      // The base is resolved ONCE, and the SAME sha is branched from and
      // recorded: the registry row can never name a commit the lane did
      // not actually branch from (the 'freshHead lie' of 2026-09-23).
      const base = this.resolveBase(repo.repoPath);
      const sha = base.sha;
      const custody = this.creationCustody(branch, sha);
      let record;
      let bootstrapped: LaneBootstrap | null;
      try {
        await this.addLane(repo.repoPath, path, custody);
        bootstrapped = await this.bootstrap(repo.repoPath, path);
        this.assertCreationIdentity(path, custody);
        this.assertCreationCustody(repo.repoPath, path, custody);
        beginLaneHandoff({ id: input.jobId, kind: 'job', jobId: input.jobId, roundId: null, repoPath: repo.repoPath, path, branch: custody.branch, sha: custody.sha },
          this.assertCreationCustody(repo.repoPath, path, custody), custody.token);
        record = this.opts.ledger.registerWorktree({
          id: input.jobId,
          kind: 'job',
          repoPath: repo.repoPath,
          repoName: repo.repoName,
          path,
          branch,
          sha,
          baseSource: base.baseSource,
          jobId: input.jobId,
        });
      } catch (error) {
        if (this.opts.ledger.getWorktree(input.jobId) !== null) throw error; // committed publication retains unresolved custody
        await this.rollbackPartialLane(repo.repoPath, path, custody, error);
        throw error;
      }
      this.handoffLane(repo.repoPath, path, custody, record);
      this.recordBootstrap(record, bootstrapped);
      this.log('info', 'job worktree created', {
        job: input.jobId,
        path,
        branch,
        sha,
        base_source: base.baseSource,
      });
      if (base.baseSource === 'local-head-fallback') {
        this.announceBaseFallback(repo.repoName, input.jobId, repo.repoPath, base);
      }
      return record;
    });
  }

  /**
   * Detached-for-reviews (ruling 18d): review rounds check out a
   * DETACHED worktree at the ref under review — reviews never grow
   * branch debris. Origin tracking refs are fetched fresh first (the
   * same discipline as job lanes); an unfetchable origin ref REFUSES,
   * never a silent stale checkout.
   */
  async createReviewWorktree(input: {
    repoPath: string;
    roundId: string;
    ref: string;
    /** Perkins r3 B3: the review lane belongs to its job — linkage is
     * recorded at creation so a paused review tree is answerable through
     * the job's own release path, never orphanable. */
    jobId?: string;
  }): Promise<WorktreeRecord> {
    if (input.roundId === '' || input.ref === '') {
      throw new Error('round id and ref must be non-empty');
    }
    return this.withRepoLock(input.repoPath, async () => {
      const repo = this.assertRepo(input.repoPath);
      const path = join(this.opts.root, repo.repoName, `review-${input.roundId}`);
      if (existsSync(path)) {
        throw new Error(`worktree path already exists: ${path}`);
      }
      const resolved = this.resolveReviewRef(repo.repoPath, input.ref);
      const custody = this.creationCustody(null, resolved.sha);
      let record;
      try {
        await this.addLane(repo.repoPath, path, custody);
        // Review lanes must contain only bytes tracked by the frozen commit.
        // Job bootstrap links/setup outputs are intentionally not applied.
        const sha = runGit(path, ['rev-parse', 'HEAD']);
        this.assertCreationIdentity(path, custody);
        this.assertCreationCustody(repo.repoPath, path, custody);
        beginLaneHandoff({ id: input.roundId, kind: 'review', jobId: input.jobId ?? null, roundId: input.roundId, repoPath: repo.repoPath, path, branch: custody.branch, sha: custody.sha },
          this.assertCreationCustody(repo.repoPath, path, custody), custody.token);
        record = this.opts.ledger.registerWorktree({
          id: input.roundId,
          kind: 'review',
          repoPath: repo.repoPath,
          repoName: repo.repoName,
          path,
          branch: null,
          sha,
          baseSource: resolved.baseSource,
          roundId: input.roundId,
          ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
        });
      } catch (error) {
        if (this.opts.ledger.getWorktree(input.roundId) !== null) throw error; // committed publication retains unresolved custody
        await this.rollbackPartialLane(repo.repoPath, path, custody, error);
        throw error;
      }
      this.handoffLane(repo.repoPath, path, custody, record);
      this.log('info', 'review worktree created (detached)', {
        round: input.roundId,
        path,
        ref: input.ref,
        sha: resolved.sha,
      });
      return record;
    });
  }

  /**
   * Issue #161: a child worker's own lane, based at the parent lane's
   * current HEAD. Authority decides isolation:
   * - `read-only` children get a DETACHED lane at the parent's committed
   *   HEAD (no branch, no write authority);
   * - `writer` children get their own branch
   *   `gru/<jobId>-child-<childId>`, so a child can never mutate the
   *   parent's working tree implicitly and its authority is explicit.
   * Read-only lanes skip the bootstrap manifest (only committed bytes,
   * like review lanes); writer lanes apply it (they are workers).
   */
  async createChildWorktree(input: {
    repoPath: string;
    jobId: string;
    childId: string;
    parentPath: string;
    authority: 'read-only' | 'writer';
  }): Promise<WorktreeRecord> {
    if (input.jobId === '' || input.childId === '') {
      throw new Error('child worktree requires a non-empty job id and child id');
    }
    if (input.authority !== 'read-only' && input.authority !== 'writer') {
      throw new Error(`unknown child worker authority "${String(input.authority)}"`);
    }
    // Bind the injected SERVICE ledger's original parent before queuing;
    // neither later receipt bytes nor a replacement HEAD may choose it.
    const parent = this.listWorktrees({ jobId: input.jobId }).find((lane) =>
      lane.path === input.parentPath || existsSync(lane.path) && existsSync(input.parentPath) &&
        realpathSync.native(lane.path) === realpathSync.native(input.parentPath));
    if (parent === undefined) throw new WorktreeHandoffUnresolvedError(input.parentPath);
    const originalParent = capturePortLaneHandoff(this, parent);
    const originalCwd = captureCwdHandoff(input.parentPath);
    const assertParent = (): void => { originalParent(); originalCwd(); };
    return this.withRepoLock(input.repoPath, async () => {
      assertParent();
      const repo = this.assertRepo(input.repoPath);
      if (!existsSync(input.parentPath)) {
        throw new Error(
          `parent lane path ${input.parentPath} does not exist — a child lane must base on a live parent lane`,
        );
      }
      assertParent();
      const parentHead = runGit(input.parentPath, ['rev-parse', 'HEAD']);
      const path = join(this.opts.root, repo.repoName, `child-${input.childId}`);
      if (existsSync(path)) {
        throw new Error(`worktree path already exists: ${path}`);
      }
      const branch = input.authority === 'writer' ? `gru/${input.jobId}-child-${input.childId}` : null;
      if (branch !== null) {
        const existing = spawnGit(repo.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
        if (existing.status === 0) {
          throw new Error(`branch ${branch} already exists — one lane per child, never a reused held branch`);
        }
      }
      const custody = this.creationCustody(branch, parentHead);
      let record;
      let bootstrapped: LaneBootstrap | null = null;
      try {
        await this.addLane(repo.repoPath, path, custody, assertParent);
        assertParent();
        if (input.authority === 'writer') bootstrapped = await this.bootstrap(repo.repoPath, path);
        assertParent();
        this.assertCreationIdentity(path, custody);
        const sha = runGit(path, ['rev-parse', 'HEAD']);
        this.assertCreationCustody(repo.repoPath, path, custody);
        beginLaneHandoff({ id: input.childId, kind: 'child', jobId: input.jobId, roundId: null, repoPath: repo.repoPath, path, branch: custody.branch, sha: custody.sha },
          this.assertCreationCustody(repo.repoPath, path, custody), custody.token);
        record = this.opts.ledger.registerWorktree({
          id: input.childId,
          kind: 'child',
          repoPath: repo.repoPath,
          repoName: repo.repoName,
          path,
          branch,
          sha,
          // The child's base is the parent lane's HEAD, not a remote
          // default — provenance is the parent lane itself (declared).
          baseSource: null,
          jobId: input.jobId,
        });
      } catch (error) {
        if (this.opts.ledger.getWorktree(input.childId) !== null) throw error; // committed publication retains unresolved custody
        await this.rollbackPartialLane(repo.repoPath, path, custody, error);
        throw error;
      }
      assertParent(); // registration observers cannot invalidate the original source
      this.handoffLane(repo.repoPath, path, custody, record, assertParent);
      assertParent();
      this.recordBootstrap(record, bootstrapped);
      this.log('info', 'child worktree created', {
        child: input.childId,
        job: input.jobId,
        authority: input.authority,
        path,
        branch,
        base: parentHead,
      });
      return record;
    });
  }

  /** Bootstrap manifest (18a): auto-apply at creation; missing = no-op.
   * Async: setup commands run off the event loop, so a slow bootstrap
   * (npm ci) never freezes chat/supervision while dispatch awaits the lane. */
  private async bootstrap(sourceRoot: string, worktreePath: string): Promise<LaneBootstrap | null> {
    // The lane's own committed manifest is applied (#427): a job lane is
    // fresh from origin, so a merged manifest takes effect before the user's
    // checkout pulls it, and an uncommitted local one never does. Its
    // [[link]]/[[copy]] entries still resolve from the source checkout.
    const manifest = loadWorktreeManifest(worktreePath, this.log);
    this.warnOnSourceManifestDrift(sourceRoot, worktreePath);
    if (manifest === null) return null;
    // What setup makes (#427): the reclaim entries absent before the
    // manifest is applied and present after it, which a restore must bring
    // back.
    const reclaim = manifest.reclaim ?? [];
    const before = await presentReclaimEntries(worktreePath, reclaim);
    await applyWorktreeManifest(manifest, {
      sourceRoot,
      worktreePath,
      setupTimeoutMs: this.opts.setupTimeoutMs,
      log: this.log,
    });
    const after = await presentReclaimEntries(worktreePath, reclaim);
    const blob = spawnGit(worktreePath, ['rev-parse', '--verify', '--quiet', `HEAD:${MANIFEST_PATH}`]).stdout.trim();
    return { blob: blob === '' ? null : blob, setupMade: reclaim.filter((entry) => after.has(entry) && !before.has(entry)) };
  }

  /** Record what a lane's bootstrap or restore made (#427):
   * `worktree.bootstrapped { id, manifest_blob, setup_made }`. A lane with
   * no such record is never slimmed. A failed write is logged: the lane is
   * then never slimmed, which is safe. */
  private recordBootstrap(row: WorktreeRecord, bootstrap: LaneBootstrap | null): void {
    if (bootstrap === null) return;
    try {
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.bootstrapped',
        jobId: row.jobId,
        payload: { id: row.id, manifest_blob: bootstrap.blob, setup_made: bootstrap.setupMade },
      });
    } catch (error) {
      this.log('error', 'worktree.bootstrapped event write failed; the lane will not be slimmed', { id: row.id, error: String(error) });
    }
  }

  /** A source checkout whose manifest differs from the lane's (or a lane
   * with none) is stale or carries local edits: say which file GC used. */
  private warnOnSourceManifestDrift(sourceRoot: string, worktreePath: string): void {
    const read = (root: string): { readonly path: string; readonly text: string | null; readonly error: string | null } => {
      const path = join(root, MANIFEST_PATH);
      if (!existsSync(path)) return { path, text: null, error: null };
      try {
        return { path, text: readFileSync(path, 'utf-8'), error: null };
      } catch (error) {
        return { path, text: null, error: String(error) };
      }
    };
    const source = read(sourceRoot);
    const lane = read(worktreePath);
    if (source.text === null && source.error === null) return;
    // An unreadable source manifest always warns, even beside a lane with none.
    if (source.error === null && source.text === lane.text) return;
    this.log('warn', 'worktree manifest: the source checkout\'s manifest differs from the lane\'s; bootstrap used the lane\'s (none means no setup)', {
      source_manifest: source.path,
      lane_manifest: lane.path,
      lane_has_manifest: lane.text !== null,
      ...(source.error !== null ? { source_error: source.error } : {}),
    });
  }

  /** Registry rows (18b) — the manager never guesses paths. */
  listWorktrees(
    opts: { status?: 'active' | 'paused' | 'swept'; jobId?: string } = {},
  ): readonly WorktreeRecord[] {
    const filtered = opts.status !== undefined || opts.jobId !== undefined;
    return (filtered ? this.opts.ledger.listWorktrees(opts) : this.opts.ledger.listWorktrees()).map((lane) => rememberManagedLane(lane, this.opts.ledger));
  }

  getWorktree(id: string): WorktreeRecord | null {
    const lane = this.opts.ledger.getWorktree(id);
    return lane === null ? null : rememberManagedLane(lane, this.opts.ledger);
  }

  /** Slim state is a projection of the lane's events, not a column (#427):
   * a lane is slim when its newest `worktree.slimmed` is newer than its
   * newest `worktree.rehydrated`. A slim lane is an ordinary active lane. */
  isSlim(laneId: string): boolean {
    const row = this.opts.ledger.getWorktree(laneId);
    return row !== null && this.slimRow(row);
  }

  private slimRow(row: WorktreeRecord): boolean {
    if (row.jobId === null) return false;
    const slimmed = this.opts.ledger.latestJobEventByPayloadField(row.jobId, 'worktree.slimmed', 'id', row.id);
    if (slimmed === null) return false;
    const rehydrated = this.opts.ledger.latestJobEventByPayloadField(row.jobId, 'worktree.rehydrated', 'id', row.id);
    return rehydrated === null || slimmed.seq > rehydrated.seq;
  }

  /** The reclaim entries the lane's setup made, by its newest
   * `worktree.bootstrapped` (#427): what a restore must bring back. Null
   * when the lane has no such record (it was made before GC recorded one). */
  private setupMade(row: WorktreeRecord): readonly string[] | null {
    if (row.jobId === null) return null;
    const payload = this.opts.ledger.latestJobEventByPayloadField(row.jobId, 'worktree.bootstrapped', 'id', row.id)?.payload as { readonly setup_made?: unknown } | undefined;
    if (payload === undefined) return null;
    return Array.isArray(payload.setup_made) ? payload.setup_made.filter((entry): entry is string => typeof entry === 'string') : [];
  }

  /** Whether a restore of this lane ever ran setup and found something it
   * made at bootstrap missing (#427): such a lane is never slimmed again. */
  private restoreWasIncomplete(row: WorktreeRecord): boolean {
    return row.jobId !== null && this.opts.ledger.hasJobEventWithPayloadValues(row.jobId, ['worktree.rehydrate-failed'],
      [{ key: 'id', value: row.id }, { key: 'reason', value: SETUP_INCOMPLETE }], 0);
  }

  /** The manifest the lane was built from (#427): the one committed at its
   * base (the registry row's `sha`, which bootstrap applied), never its
   * HEAD, so a minion's commit chooses neither what a slim deletes nor what
   * a restore runs. Null when the base has none. A git failure throws as it
   * is (it may pass); a manifest that is not a file or does not parse
   * throws {@link BaseManifestContentError} (it cannot change). */
  private baseManifest(row: WorktreeRecord): { readonly blob: string; readonly manifest: WorktreeManifest } | null {
    const listed = runGit(row.path, ['ls-tree', '-z', row.sha, '--', MANIFEST_PATH]);
    if (listed === '') return null;
    const blob = /^\d+ blob ([0-9a-f]{40,64})\t/u.exec(listed)?.[1];
    if (blob === undefined) throw new BaseManifestContentError(`${MANIFEST_PATH} at the lane's base ${row.sha} is not a file`);
    return { blob, manifest: this.manifestBlob(row.path, blob) };
  }

  /** A manifest blob, parsed: a git failure throws as it is, a parse
   * failure as {@link BaseManifestContentError}. */
  private manifestBlob(lanePath: string, blob: string): WorktreeManifest {
    const text = runGit(lanePath, ['cat-file', 'blob', blob]);
    try {
      return parseWorktreeManifest(text, `${MANIFEST_PATH} (blob ${blob})`);
    } catch (error) {
      throw new BaseManifestContentError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Slim an idle lane (#427): delete the `reclaim` folders of the manifest
   * the lane was built from, keeping the folder, its git state and its
   * edits. That manifest's `[[setup]]` restores them before the lane's next
   * minion turn or verification ({@link ensureReady}). Runs under the lane's
   * lock, which that restore and a release also take.
   *
   * A lane is slimmed only when it is active, of kind job or writer child,
   * its base manifest declares `reclaim` and `[[setup]]` (with no setup,
   * nothing could restore it), its bootstrap is on the record (what its
   * setup made, which a restore must bring back) and no restore of it ever
   * found that missing, the caller's `idle` proof holds (it returns why not,
   * or null) and no process is rooted in the tree. An entry is deleted only
   * when it exists, no part of its path is a link, it holds no manifest
   * `[[link]]` or `[[copy]]` destination, git tracks nothing under it and
   * git ignores it; any other entry is skipped by name, a missing one
   * silently, and one whose check throws by name too.
   *
   * The slim is recorded (`worktree.slimmed`, with the planned entries, their
   * `planned_bytes` and the manifest blob) before the first delete, so the
   * lane is slim from then on and a crash mid-delete leaves a lane the next
   * turn restores. If that record cannot be written, nothing is deleted.
   * What was really freed follows: `worktree.slim-done`, or, when a delete
   * failed or the `signal` (the service's stop, checked between entries and
   * at every path of a delete) cut the pass short, `worktree.slim-incomplete`.
   */
  async slim(input: { readonly worktreeId: string; readonly idle: () => string | null; readonly signal?: AbortSignal }): Promise<SlimResult> {
    return this.withLaneLock(input.worktreeId, async () => {
      const notSlimmed = (reason: string, permanent = false, skipped: SlimResult['skipped'] | null = null): SlimResult =>
        ({ status: 'not-slimmed', reason, permanent, planned: skipped !== null, skipped: skipped ?? [] });
      const stopping = 'the service is stopping';
      const stopped = (): boolean => input.signal?.aborted === true;
      const row = this.opts.ledger.getWorktree(input.worktreeId);
      if (row === null) return notSlimmed('the lane is not in the registry');
      if (row.status !== 'active') return notSlimmed(`the lane is ${row.status}`);
      if (!writerLane(row)) return notSlimmed('only job and writer-child lanes are slimmed');
      if (!existsSync(row.path)) return notSlimmed('the lane folder is missing');
      if (this.slimRow(row)) return notSlimmed('the lane is already slim');
      let base: { readonly blob: string; readonly manifest: WorktreeManifest } | null;
      try {
        base = this.baseManifest(row);
      } catch (error) {
        // Only what the manifest says is final; git may answer next time.
        const content = error instanceof BaseManifestContentError;
        return notSlimmed(`the manifest the lane was built from ${content ? 'cannot be used' : 'could not be read'}: ${oneLineErrorText(error instanceof Error ? error.message : error, 400)}`, content);
      }
      if (base === null) return notSlimmed('the lane was built from no manifest', true);
      const { manifest } = base;
      if (manifest.reclaim === undefined || manifest.reclaim.length === 0) {
        return notSlimmed('the manifest the lane was built from declares no reclaim', true);
      }
      if (manifest.setup.length === 0) {
        return notSlimmed('the manifest the lane was built from has no [[setup]], so nothing could restore its reclaim folders', true);
      }
      if (this.setupMade(row) === null) {
        return notSlimmed('the lane has no bootstrap record (it was made before GC recorded what its setup makes), so a restore could not tell what it must bring back', true);
      }
      if (this.restoreWasIncomplete(row)) {
        return notSlimmed('a restore of the lane ran setup and did not get back what setup made when the lane was bootstrapped, so it is never slimmed again', true);
      }
      const busy = input.idle();
      if (busy !== null) return notSlimmed(busy);
      const rooted = this.enumerate(row.path);
      if (rooted.length > 0) {
        return notSlimmed(`${rooted.length} process(es) rooted in the lane (pids ${rooted.map((proc) => proc.pid).join(', ')})`);
      }
      // Plan: every entry's checks, each on its own, before anything is deleted.
      const destinations = [...manifest.links.map((link) => link.at), ...manifest.copies.map((copy) => copy.to)].map(normalizedManifestPath);
      const planned: { path: string; bytes: number; sharedBytes: number }[] = [];
      const skipped: { path: string; reason: string }[] = [];
      let fixedSkips = 0;
      for (const entry of manifest.reclaim) {
        if (stopped()) return notSlimmed(stopping);
        const destination = destinations.find((path) => path === entry || path.startsWith(`${entry}/`));
        if (destination !== undefined) {
          skipped.push({ path: entry, reason: `the manifest's [[link]] or [[copy]] destination ${destination} lies at or under it, and a restore runs only [[setup]]` });
          fixedSkips += 1;
          continue;
        }
        try {
          const verdict = await reclaimVerdict(row.path, entry);
          if (verdict === null) continue;
          if (typeof verdict === 'string') skipped.push({ path: entry, reason: verdict });
          else planned.push({ path: entry, ...verdict });
        } catch (error) {
          skipped.push({ path: entry, reason: `its check failed: ${oneLineErrorText(error instanceof Error ? error.message : error, 400)}` });
        }
      }
      if (planned.length === 0) return notSlimmed('nothing to reclaim', fixedSkips === manifest.reclaim.length, skipped);
      if (stopped()) return notSlimmed(stopping, false, skipped);
      const entries = planned.map(({ path, bytes }) => ({ path, bytes }));
      const plannedBytes = planned.reduce((total, entry) => total + entry.bytes, 0);
      try {
        this.opts.ledger.appendCustomEvent({
          kind: 'worktree.slimmed',
          jobId: row.jobId,
          payload: { id: row.id, manifest: base.blob, entries, planned_bytes: plannedBytes, skipped },
        });
      } catch (error) {
        this.log('error', 'lane slim could not be recorded; nothing was deleted', { id: row.id, error: String(error) });
        return notSlimmed(`the slim could not be recorded, so nothing was deleted: ${String(error)}`, false, skipped);
      }
      // The lane is slim from here on: whatever happens below, the next turn
      // runs setup.
      const deleted: { path: string; bytes: number; sharedBytes: number }[] = [];
      const failed: { path: string; reason: string }[] = [];
      for (const entry of planned) {
        // A stop between entries leaves the rest: the lane is slim already.
        if (stopped()) {
          failed.push({ path: entry.path, reason: 'the service stopped before it was deleted' });
          continue;
        }
        try {
          // A link that appeared on the path since the plan is never followed.
          const state = await reclaimState(row.path, entry.path);
          if (state !== 'present') throw new Error(state === 'link' ? 'a link appeared on its path after the slim was planned' : 'it was gone when its delete ran');
          await removeTree(join(row.path, entry.path), input.signal);
          deleted.push(entry);
        } catch (error) {
          // A delete the stop cut short freed an unknown part: none is counted.
          failed.push({ path: entry.path, reason: stopped()
            ? 'the service stopped while it was being deleted'
            : `deleting it failed: ${oneLineErrorText(error instanceof Error ? error.message : error, 400)}` });
        }
      }
      const freedBytes = deleted.reduce((total, entry) => total + entry.bytes, 0);
      const sharedBytes = deleted.reduce((total, entry) => total + entry.sharedBytes, 0);
      if (failed.length > 0) {
        this.log('warn', 'lane slim incomplete; the lane is slim and its next turn runs setup', { id: row.id, failed, freed_bytes: freedBytes });
      }
      try {
        this.opts.ledger.appendCustomEvent(failed.length > 0
          ? { kind: 'worktree.slim-incomplete', jobId: row.jobId, payload: { id: row.id, failed, freed_bytes: freedBytes, shared_bytes: sharedBytes } }
          : { kind: 'worktree.slim-done', jobId: row.jobId, payload: { id: row.id, freed_bytes: freedBytes, shared_bytes: sharedBytes } });
      } catch (error) {
        this.log('error', `worktree.${failed.length > 0 ? 'slim-incomplete' : 'slim-done'} event write failed`, { id: row.id, error: String(error) });
      }
      const kept = deleted.map(({ path, bytes }) => ({ path, bytes }));
      this.log('info', 'lane slimmed', { id: row.id, entries: kept, freed_bytes: freedBytes, shared_bytes: sharedBytes, skipped: [...skipped, ...failed] });
      return { status: 'slimmed', entries: kept, freedBytes, sharedBytes, skipped: [...skipped, ...failed] };
    });
  }

  /**
   * Restore the job's slim lanes before a minion turn or a verification
   * (#427): each active job or writer-child lane of the job that is slim
   * runs the `[[setup]]` of exactly the manifest blob its slim recorded
   * (links and copies were never deleted), under the lane's lock, so a
   * restore that arrives while a slim runs waits and then restores.
   *
   * A setup that succeeds must bring back what the lane's setup made when it
   * was bootstrapped (`worktree.bootstrapped`'s `setup_made`). When it did,
   * GC records `worktree.rehydrated`, naming any other deleted entry still
   * absent (`not_recreated`: a build or verify makes it), and
   * `worktree.bootstrapped` for what this setup made; the lane is no longer
   * slim. When it did not (a stamp file outside `reclaim` can make setup
   * skip its work), GC records `worktree.rehydrate-failed` ("setup did not
   * recreate X"): the lane stays slim, is never slimmed again, and Gru hears
   * about it once. A setup that fails or is stopped records
   * `worktree.rehydrate-failed` with a warn log: the lane stays slim so the
   * next turn retries. Either way the caller proceeds. The signal (the
   * turn's, the run's or the continuation's stop) ends setup's process
   * group. Never rejects.
   */
  async ensureReady(jobId: string, opts: { readonly signal?: AbortSignal } = {}): Promise<readonly LaneRestore[]> {
    let lanes: readonly WorktreeRecord[];
    try {
      lanes = this.opts.ledger.listWorktrees({ jobId, status: 'active' }).filter(writerLane);
    } catch (error) {
      this.log('error', 'lane restore could not list the job\'s lanes; the turn proceeds', { job: jobId, error: String(error) });
      return [];
    }
    const outcomes: LaneRestore[] = [];
    for (const lane of lanes) outcomes.push(await this.withLaneLock(lane.id, async () => this.restoreLane(lane.id, opts.signal)));
    return outcomes;
  }

  private async restoreLane(laneId: string, signal: AbortSignal | undefined): Promise<LaneRestore> {
    let row: WorktreeRecord | null = null;
    let blob: string | null = null;
    const failedRestore = (error: string, missing: readonly string[] = []): LaneRestore => {
      this.log('warn', 'slim lane restore failed; the lane stays slim and the next turn retries it', { id: laneId, error });
      try {
        this.opts.ledger.appendCustomEvent({
          kind: 'worktree.rehydrate-failed',
          jobId: row?.jobId ?? null,
          payload: { id: laneId, error, ...(blob !== null ? { manifest: blob } : {}), ...(missing.length > 0 ? { missing, reason: SETUP_INCOMPLETE } : {}) },
        });
      } catch (eventError) {
        this.log('error', 'worktree.rehydrate-failed event write failed', { id: laneId, error: String(eventError) });
      }
      return { id: laneId, status: 'rehydrate-failed', error };
    };
    try {
      row = this.opts.ledger.getWorktree(laneId);
      if (row === null || row.status !== 'active' || row.jobId === null || !existsSync(row.path) || !this.slimRow(row)) return { id: laneId, status: 'ready' };
      const started = Date.now();
      const record = slimRecord(this.opts.ledger.latestJobEventByPayloadField(row.jobId, 'worktree.slimmed', 'id', row.id));
      let manifest: WorktreeManifest;
      if (record.blob === null) {
        // A slim recorded before slims named their manifest: the base's.
        this.log('warn', 'slim record names no manifest blob; restoring from the manifest the lane was built from', { id: row.id });
        const base = this.baseManifest(row);
        if (base === null) throw new Error('the slim record names no manifest blob and the lane was built from no manifest, so its restore cannot run');
        blob = base.blob;
        manifest = base.manifest;
      } else {
        blob = record.blob;
        manifest = this.manifestBlob(row.path, record.blob);
      }
      const required = this.setupMade(row) ?? [];
      const reclaim = manifest.reclaim ?? [];
      const before = await presentReclaimEntries(row.path, reclaim);
      await applyWorktreeManifest({ ...manifest, links: [], copies: [] }, {
        sourceRoot: row.repoPath,
        worktreePath: row.path,
        setupTimeoutMs: this.opts.setupTimeoutMs,
        log: this.log,
        ...(signal !== undefined ? { signal } : {}),
      });
      const after = await presentReclaimEntries(row.path, [...new Set([...reclaim, ...required, ...record.entries])]);
      const missing = required.filter((entry) => !after.has(entry));
      if (missing.length > 0) {
        const first = !this.restoreWasIncomplete(row);
        const outcome = failedRestore(
          `setup did not recreate ${missing.join(', ')}, which it made when the lane was bootstrapped (a stamp file outside reclaim can make setup skip its work); ` +
            'the lane stays slim and is never slimmed again',
          missing,
        );
        if (first) {
          try {
            this.opts.onRestoreIncomplete?.({ worktree: row, missing });
          } catch (error) {
            this.log('warn', 'restore-incomplete notice failed; the rehydrate-failed record names it', { id: row.id, error: String(error) });
          }
        }
        return outcome;
      }
      const notRecreated = record.entries.filter((entry) => !after.has(entry));
      const ms = Date.now() - started;
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.rehydrated',
        jobId: row.jobId,
        payload: { id: row.id, ms, ...(notRecreated.length > 0 ? { not_recreated: notRecreated } : {}) },
      });
      this.recordBootstrap(row, { blob, setupMade: reclaim.filter((entry) => after.has(entry) && !before.has(entry)) });
      this.log('info', 'slim lane restored', { id: row.id, ms, ...(notRecreated.length > 0 ? { not_recreated: notRecreated } : {}) });
      return { id: laneId, status: 'rehydrated', ms, notRecreated };
    } catch (error) {
      return failedRestore(restoreErrorText(error));
    }
  }

  /**
   * Preserve-first ordered sweep (ruling 18c). Order is law:
   *   0. refuse early (#427): an unfinished git operation, a sparse
   *      checkout or submodule work the removal would destroy refuses
   *      before anything is copied or killed,
   *   1. preserve untracked deliverables (never lost; a submodule's
   *      untracked content too),
   *   2. enumerate processes rooted in the tree,
   *   3. live process → PAUSE and ask (never a silent kill),
   *   4. snapshot the uncommitted tracked work (built, proven and
   *      committed; its ref is written last, after the records the removal
   *      depends on), remove the worktree, containment-verified branch
   *      delete.
   * `confirmKill` is the human's ANSWER to the ask: it kills exactly the
   * enumerated pids, records the decision, and re-checks before removal.
   * A release runs under the lane's lock (#427), which a slim and a
   * restore of the lane also take, so it never overlaps a slim; it takes
   * the lane lock before the repository lock, and nothing takes them the
   * other way round.
   */
  async release(input: SweepRequest): Promise<SweepResult> {
    return this.withLaneLock(input.worktreeId, async () => this.releaseLane(input));
  }

  private async releaseLane(input: SweepRequest): Promise<SweepResult> {
    const row = this.opts.ledger.getWorktree(input.worktreeId);
    if (row === null) {
      throw new Error(
        `worktree "${input.worktreeId}" is not in the registry — sweeps match registry paths only (SPEC ruling 18b)`,
      );
    }
    if (row.status === 'swept') {
      // HEAL (Perkins lane-B r4): a swept row may still carry a surviving
      // job branch when a dispose-then-flip window crashed between the
      // two, or when an older build flipped first. Verify-and-dispose on
      // every swept retry — never early-return 'none' over debris.
      // A GONE tree is positive evidence the worktree is swept: re-fire the
      // producer-resolution hook so a pause notice whose first resolution
      // was lost (crash between the flip and the hook) still settles.
      const treeGone = !existsSync(row.path);
      if (!existsSync(row.repoPath)) {
        if (treeGone) {
          try {
            this.opts.onSwept?.({ worktree: row });
          } catch (error) {
            this.log('warn', 'sweep-completion notice resolution failed', { id: row.id, error: String(error) });
          }
        }
        return {
          status: 'swept',
          preserved: null,
          branch: 'none',
          freshHead: '',
        };
      }
      return this.withRepoLock(row.repoPath, async () => {
        assertLaneResourcesAbsent(row);
        let branchOutcome: 'deleted' | 'retained' | 'none' = 'none';
        if ((row.kind === 'job' || row.kind === 'child') && row.branch !== null) {
          const present = spawnGit(row.repoPath, [
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${row.branch}`,
          ]);
          if (present.status === 0) {
            // Fresh remote state BEFORE the retry disposal (Perkins r8):
            // the old tracking refs must not witness containment.
            const remote = this.safeFreshRemoteBranch(row.repoPath);
            assertLaneResourcesAbsent(row);
            branchOutcome = this.disposeLaneBranch(row, input.baseBranch, remote);
          }
        }
        if (treeGone) {
          try {
            this.opts.onSwept?.({ worktree: row });
          } catch (error) {
            this.log('warn', 'sweep-completion notice resolution failed', { id: row.id, error: String(error) });
          }
        }
        const freshHead = this.safeFreshHead(row.repoPath);
        assertLaneResourcesAbsent(row);
        return { status: 'swept', preserved: null, branch: branchOutcome, freshHead } as const;
      });
    }
    // An unfinished merge, rebase, cherry-pick, revert or bisect refuses
    // every release by name before anything is touched (#427): a snapshot
    // of the uncommitted work could not say what the lane meant. Checked
    // before the custody proof, which a rebase's or bisect's detached HEAD
    // would fail unnamed.
    if (existsSync(row.path)) this.assertNoOperationInProgress(row);
    const assertCleanup = captureCleanupHandoff(rememberManagedLane(row, this.opts.ledger));
    return this.withRepoLock(row.repoPath, async () => {
      assertCleanup();
      // (0) Crash-window reconciliation (Perkins lane-B r2 c): the tree is
      // gone but the row never flipped (a kill between removal and the
      // registry write). Reconcile — swept + loud event — instead of
      // rejecting forever in preserveUntracked's missing cwd.
      if (!existsSync(row.path)) {
        // The reconcile disposes the branch exactly like finishSweep
        // (Perkins lane-B r3): containment-verified delete, or retain +
        // note — and the response reports the TRUE outcome.
        const reconciled = this.reconcileMissingTree(row, input.baseBranch);
        return { status: 'swept', preserved: null, ...reconciled } as const;
      }
      // (0.9) AUTOMATIC RELEASE PROOFS (issue #243 F-H1): an unattended sweep
      // must refuse BEFORE the forced removal when fresh required containment
      // cannot be proven. Dirty tracked work no longer refuses it: the
      // removal tail snapshots it first (#427).
      if (input.requireReleaseProofs === true) {
        this.assertAutomaticReleaseProofs(row);
      }
      // (0.95) REFUSE EARLY (#427): the structural checks run before an
      // untracked file is copied or a process is reaped, paused on or
      // killed: an unfinished git operation, a sparse checkout, and
      // submodule work the removal would destroy (unless an operator
      // discards exactly that work). The snapshot is not built here: what a
      // live writer does to a build is a race, never a reason to refuse, and
      // it is the pause below that names the writer. The removal tail checks
      // all of it again, after the processes are handled, and builds and
      // proves the snapshot there.
      this.assertNoOperationInProgress(row);
      this.assertNotSparse(row);
      const submodules = this.assertSubmoduleWork(row, input.discardSubmoduleWork ?? null);
      const attempt: SweepAttempt = {
        discardSubmoduleWork: input.discardSubmoduleWork ?? null,
        copyRecorded: false,
        aborted: this.abortedRelease(row),
        preserveReused: false,
      };
      // (1) Preserve untracked deliverables FIRST — before any process
      // decision, before any removal. Deliverables are never hostages.
      const preserved = this.preserveUntracked(row, submodules.untracked, attempt);
      try {
        const result = await this.sweepPreserved(row, input, preserved, attempt, assertCleanup);
        // A pause keeps the copy: the answered release copies afresh.
        if (result.status === 'paused') this.recordPreservation(row, preserved, attempt);
        return result;
      } catch (error) {
        // A refusal leaves no new preserve folder (#427): the tree, with
        // every deliverable, is retained. A copy already on the record
        // stays, so no record names a missing copy.
        if (!attempt.copyRecorded) this.withdrawPreservation(row, preserved);
        throw error;
      }
    });
  }

  /** Steps 1.5–4 of a release, after its untracked deliverables were
   * copied (see {@link release}). */
  private async sweepPreserved(
    row: WorktreeRecord,
    input: SweepRequest,
    preserved: SweepPreservation | null,
    attempt: SweepAttempt,
    assertCleanup: () => void,
  ): Promise<SweepResult> {
    // (1.5) Reap services THIS orchestrator spawned for the lane (owner
    // incident 2026-09-23): verification runs are recorded in
    // worktree_processes with evidence 'registry' at spawn, so a sweep
    // reaps its own children instead of pausing forever on them. The kill
    // is dual-keyed (registry row live AND still enumerated in the tree)
    // so a recycled pid can never redirect it; foreign processes keep the
    // full pause-and-ask contract below.
    const reaped = await this.reapTrackedServiceProcesses(row);
    assertCleanup();

    // (2) Enumerate processes rooted in the tree BEFORE removal.
    const processes = this.enumerate(row.path).filter((proc) => !reaped.includes(proc.pid));
    if (processes.length > 0) {
      // Perkins r2 B2: confirmKill is answered against the RECORDED set
      // (ruling 18b rows from a prior pause), never a fresh enumeration
      // — pids that appeared since were never acknowledged by anyone.
      // No recorded pause → confirmKill is not honored; the ask comes first.
      const acknowledged =
        input.confirmKill === true && row.status === 'paused'
          ? this.opts.ledger
              .listWorktreeProcesses(row.id)
              .filter((proc) => proc.state === 'live')
              .map((proc) => ({ pid: proc.pid, command: proc.command, evidence: proc.evidence }))
          : [];
      if (input.confirmKill === true && acknowledged.length > 0) {
        return this.killAcknowledgedAndContinue(row, acknowledged, preserved, input.baseBranch, assertCleanup, attempt);
      }

      // (3) PAUSE AND ASK — a live process is never silently killed.
      // The evidence lands in the registry (ruling 18b): the ask names
      // exactly what was live, by pid, with how it was tied to the tree.
      this.opts.ledger.recordWorktreeProcesses({
        worktreeId: row.id,
        processes: processes.map((proc) => ({
          pid: proc.pid,
          command: proc.command,
          evidence: proc.evidence,
        })),
        state: 'live',
      });
      const note = `sweep paused: ${processes.length} live process(es) rooted in ${row.path} (pids ${processes
        .map((p) => p.pid)
        .join(', ')}) — acknowledge to proceed`;
      this.opts.ledger.setWorktreeStatus(row.id, 'paused', note);
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.paused',
        jobId: row.jobId,
        roundId: row.roundId,
        payload: { id: row.id, path: row.path, processes },
      });
      this.opts.onSweepPaused?.({ worktree: row, processes });
      this.log('warn', 'worktree sweep paused on live processes', {
        id: row.id,
        pids: processes.map((p) => p.pid),
      });
      return { status: 'paused', processes, preserved, note };
    }

    // No live processes: straight to the removal tail.
    return this.finishSweep(row, preserved, input.baseBranch, assertCleanup, attempt);
  }

  /**
   * Reap the lane's orchestrator-spawned services (owner incident
   * 2026-09-23): rows the verification scheduler recorded at spawn carry
   * evidence 'registry' — they are OUR children, so teardown does not wait
   * for a human. A pid is signalled only when BOTH the ledger row says
   * live AND the process currently enumerates as rooted in the tree (a
   * recycled pid can never redirect the kill). Dead or no-longer-rooted
   * rows are reconciled to 'killed' without a signal; survivors stay live
   * and fall through to the normal pause-and-ask. Returns the pids proven
   * dead by the grace ladder.
   */
  private async reapTrackedServiceProcesses(row: WorktreeRecord): Promise<readonly number[]> {
    const tracked = this.opts.ledger
      .listWorktreeProcesses(row.id)
      .filter((proc) => proc.state === 'live' && proc.evidence === 'registry');
    if (tracked.length === 0) return [];
    const inTree = new Set(this.enumerate(row.path).map((proc) => proc.pid));
    const targets = tracked.filter((proc) => inTree.has(proc.pid) && pidAlive(proc.pid));
    const targetPids = new Set(targets.map((proc) => proc.pid));
    const stranded = tracked.filter((proc) => !targetPids.has(proc.pid));
    if (stranded.length > 0) {
      // Never signal a pid that is dead or no longer belongs to this lane:
      // reconcile the registry row and move on (the row's truth ends here).
      this.opts.ledger.recordWorktreeProcesses({
        worktreeId: row.id,
        processes: stranded.map((proc) => ({
          pid: proc.pid,
          command: proc.command,
          evidence: proc.evidence,
        })),
        state: 'killed',
      });
    }
    if (targets.length === 0) return [];
    const pids = targets.map((proc) => proc.pid);
    for (const pid of pids) {
      if (!signalProcessGroup(pid, 'SIGTERM')) {
        this.log('warn', 'tracked service SIGTERM failed (already gone?)', { id: row.id, pid });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, this.opts.killGraceMs ?? 1_500));
    for (const pid of pids) {
      if (pidAlive(pid)) signalProcessGroup(pid, 'SIGKILL');
    }
    // Settle, then confirm: only pids actually dead are reported reaped;
    // survivors stay 'live' and the caller's enumeration re-asks on them.
    await new Promise((resolve) => setTimeout(resolve, Math.min(this.opts.killGraceMs ?? 1_500, 300)));
    const killed = pids.filter((pid) => !pidAlive(pid));
    if (killed.length > 0) {
      const killedSet = new Set(killed);
      this.opts.ledger.recordWorktreeProcesses({
        worktreeId: row.id,
        processes: targets
          .filter((proc) => killedSet.has(proc.pid))
          .map((proc) => ({ pid: proc.pid, command: proc.command, evidence: proc.evidence })),
        state: 'killed',
      });
    }
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.service-reaped',
      jobId: row.jobId,
      roundId: row.roundId,
      payload: { id: row.id, path: row.path, pids: killed, survivors: pids.filter((pid) => !killed.includes(pid)) },
    });
    this.log('info', 'tracked service processes reaped on sweep', { id: row.id, pids: killed });
    return killed;
  }

  private creationCustody(branch: string | null, sha: string): CreationCustody {
    return { token: `gru-creation:${randomUUID()}`, branch, sha, branchCreated: false, addAttempted: false };
  }

  private async addLane(repoPath: string, path: string, custody: CreationCustody, assertSource?: () => void): Promise<void> {
    if (custody.branch !== null) {
      await this.updateDirectCreationRef(repoPath, custody, 'create');
      custody.branchCreated = true;
    }
    assertSource?.(); // original parent after the awaited named-ref transaction
    custody.addAttempted = true;
    runGit(repoPath, ['worktree', 'add', '--lock', '--reason', custody.token,
      ...(custody.branch === null ? ['--detach'] : []), path, custody.branch ?? custody.sha]);
    assertSource?.();
    this.assertCreationIdentity(path, custody);
  }

  /** Read-only creation metadata while a ref transaction owns its lock.
   * Bound output and settlement without blocking the event loop or signalling
   * any process other than this invocation's exact child handle. */
  private async creationMetadata(repoPath: string, args: readonly string[]): Promise<{ readonly status: number | null; readonly stdout: string }> {
    const child = spawn('git', [...args], { cwd: repoPath, env: repositoryGitEnv(false), stdio: ['ignore', 'pipe', 'pipe'] });
    const limit = 16 * 1024 * 1024;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let failure: Error | undefined;
    let exited = false, closed = false;
    let status: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let wake: () => void = () => {};
    const failed = new Promise<void>((done) => { wake = done; });
    const fail = (detail: string): void => {
      failure ??= new Error(`creation metadata ${args[0]}: ${detail} — authority unconfirmed; resources retained`);
      wake();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure !== undefined) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > limit) fail('stdout output exceeded 16 MiB');
      else if (stdoutBytes + stderrBytes > limit) fail('combined output exceeded 16 MiB');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (failure !== undefined) return;
      stderrBytes += chunk.length;
      if (stderrBytes > limit) fail('stderr output exceeded 16 MiB');
      else if (stdoutBytes + stderrBytes > limit) fail('combined output exceeded 16 MiB');
      else stderrTail = Buffer.concat([stderrTail, chunk.subarray(-4096)]).subarray(-4096);
    });
    child.on('error', (error) => fail(error.message));
    child.stdout.on('error', (error: Error) => fail(error.message));
    child.stderr.on('error', (error: Error) => fail(error.message));
    child.on('exit', (code, killedBy) => { exited = true; status = code; signal = killedBy; });
    const stopped = new Promise<void>((done) => child.on('close', () => { closed = true; done(); }));
    const timer = setTimeout(() => fail('query timed out after 30000ms'), 30_000);
    await Promise.race([stopped, failed]);
    clearTimeout(timer);
    const wait = async (): Promise<void> => {
      if (closed) return;
      await new Promise<void>((done) => {
        const bound = setTimeout(done, 1_000);
        void stopped.then(() => { clearTimeout(bound); done(); });
      });
    };
    if (!closed) {
      for (const killSignal of ['SIGTERM', 'SIGKILL'] as const) {
        if (!exited && child.pid !== undefined) {
          try { child.kill(killSignal); } catch (error) { fail(String(error)); }
        }
        await wait();
        if (closed) break;
      }
    }
    child.stdout.destroy(); child.stderr.destroy();
    if (!closed) {
      const detail = exited ? 'owned pipes did not settle' : 'termination unconfirmed';
      failure = new AggregateError([failure, new Error(detail)], `${failure?.message ?? 'creation metadata settlement failed'}; ${detail}`);
      child.unref();
    }
    if (signal !== null || status === null) fail(`exit ${status}, signal ${signal}: ${stderrTail.toString('utf8').trim()}`);
    if (failure !== undefined) throw failure;
    return { status, stdout: Buffer.concat(stdout).toString('utf8') };
  }

  /** A prepared no-deref transaction holds the exact ref-name lock. Git's
   * zero-old/create guard alone accepts dangling symrefs, even with no-deref;
   * inspect the still-unmodified name UNDER that lock before committing. */
  private async updateDirectCreationRef(repoPath: string, custody: CreationCustody, operation: 'create' | 'delete', ownedPath?: string): Promise<void> {
    if (custody.branch === null) throw new Error('branchless creation cannot mutate a branch ref');
    const ref = `refs/heads/${custody.branch}`;
    // Ref names enter Git's line-oriented transaction protocol, not argv.
    runGit(repoPath, ['check-ref-format', ref]);
    const child = spawn('git', ['update-ref', '--stdin', '--no-deref', '--create-reflog', '-m', custody.token], {
      cwd: repoPath, env: repositoryGitEnv(false),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outputLimit = 16 * 1024 * 1024;
    const confirmationTimeoutMs = 30_000;
    const stopTimeoutMs = 1_000;
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let pending = Buffer.alloc(0);
    const expected = ['start', 'prepare'];
    const confirmed = new Set<string>();
    let notify: (() => void) | undefined;
    let failure: Error | undefined;
    let exited = false;
    let closed = false;
    let status: number | null = null;
    let signal: NodeJS.Signals | null = null;
    const transactionError = (detail: string): Error => new Error(
      `git update-ref ${operation} ${ref}: ${detail} — transaction authority unconfirmed; resources retained`,
    );
    const fail = (error: Error): void => {
      failure ??= error;
      notify?.();
    };
    // Count bytes even when retaining only a diagnostic tail. Hooks still run
    // normally, but neither an unterminated line nor queued replies can grow.
    child.stderr.on('data', (chunk: Buffer) => {
      if (failure !== undefined) return;
      stderrBytes += chunk.length;
      if (stderrBytes > outputLimit) fail(transactionError('stderr output exceeded 16 MiB'));
      else stderrTail = Buffer.concat([stderrTail, chunk.subarray(-4096)]).subarray(-4096);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure !== undefined) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimit) return fail(transactionError('stdout output exceeded 16 MiB'));
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(10);
      while (newline !== -1) {
        if (newline > 64) return fail(transactionError('stdout confirmation exceeded 64 bytes'));
        const reply = pending.subarray(0, newline).toString('utf8').replace(/\r$/u, '');
        pending = pending.subarray(newline + 1);
        const phase = expected.shift();
        if (phase === undefined || reply !== `${phase}: ok`) {
          return fail(transactionError(`invalid ${phase ?? 'unsolicited'} confirmation`));
        }
        confirmed.add(phase);
        notify?.();
        newline = pending.indexOf(10);
      }
      if (pending.length > 64) fail(transactionError('stdout confirmation exceeded 64 bytes'));
    });
    child.on('error', (error) => { fail(transactionError(error.message)); });
    child.stdin.on('error', (error: Error) => { fail(transactionError(error.message)); });
    child.stdout.on('error', (error: Error) => { fail(transactionError(error.message)); });
    child.stderr.on('error', (error: Error) => { fail(transactionError(error.message)); });
    child.on('exit', (code, killedBy) => { exited = true; status = code; signal = killedBy; });
    const stopped = new Promise<void>((done) => child.on('close', () => {
      closed = true;
      if (expected.length > 0 || pending.length > 0) {
        fail(transactionError(`missing or unterminated confirmation: ${stderrTail.toString('utf8').trim()}`));
      }
      done();
    }));
    const confirm = async (phase: string): Promise<void> => {
      if (failure !== undefined) throw failure;
      if (confirmed.has(phase)) return;
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => fail(transactionError(`${phase} confirmation timed out after 30000ms`)), confirmationTimeoutMs);
        notify = () => {
          if (failure === undefined && !confirmed.has(phase)) return;
          clearTimeout(timer);
          notify = undefined;
          if (failure !== undefined) reject(failure);
          else done();
        };
      });
    };
    const waitForStop = async (): Promise<boolean> => {
      if (closed) return true;
      return new Promise<boolean>((done) => {
        const timer = setTimeout(() => done(false), stopTimeoutMs);
        void stopped.then(() => { clearTimeout(timer); done(true); });
      });
    };
    let committed = false;
    let stopFailure: Error | undefined;
    try {
      child.stdin.write(`start\n${operation} ${ref} ${custody.sha}\nprepare\n`);
      await confirm('start');
      await confirm('prepare');
      const symbolic = await this.creationMetadata(repoPath, ['symbolic-ref', '--quiet', '--no-recurse', ref]);
      if (symbolic.status !== 1) {
        throw new Error(`branch name ${ref} is symbolic or unverifiable — refusing ${operation} without changing its alias or referent`);
      }
      if (operation === 'delete') {
        if (ownedPath === undefined) throw new Error('deletion has no invocation-owned checkout reservation');
        const query = async (path: string, args: readonly string[]): Promise<string> => {
          const result = await this.creationMetadata(path, args);
          if (result.status !== 0) throw new Error(`creation custody query ${args[0]} failed`);
          return result.stdout.trim();
        };
        const common = realpathSync(await query(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
        const trees = await query(repoPath, ['worktree', 'list', '--porcelain', '-z']);
        if (this.branchHasForeignHolder(trees, ref, ownedPath)) throw new Error(`created branch ${ref} acquired a foreign holder`);
        const receipt = await query(repoPath, ['reflog', 'show', '-1', '--format=%H%x00%gs', ref]);
        if (receipt !== `${custody.sha}\0${custody.token}`) throw new Error(`created branch ${ref} receipt changed under deletion lock`);
        this.assertRollbackBranchMetadata(repoPath, custody, common);
        // No await after the final nonce/backlink/HEAD proof and before commit.
        const admin = existsSync(ownedPath) ? this.assertCreationCustody(repoPath, ownedPath, custody, common)
          : this.orphanCreationAdmin(repoPath, ownedPath, custody, common);
        if (admin === null || readWorktreeMetadata(join(admin, 'HEAD')).trim() !== `ref: ${ref}`) {
          throw new Error(`created branch ${ref} lost its invocation-owned checkout reservation`);
        }
      }
      if (failure !== undefined) throw failure;
      expected.push('commit');
      child.stdin.write('commit\n');
      await confirm('commit');
      if (failure !== undefined) throw failure;
      committed = true;
    } catch (error) {
      fail(error instanceof Error ? error : transactionError(String(error)));
    } finally {
      try { child.stdin.end(committed ? '' : 'abort\n'); }
      catch (error) { fail(transactionError(String(error))); }
      if (!await waitForStop()) {
        stopFailure = transactionError(`owned Git child ${child.pid ?? 'unspawned'} did not close within 1000ms`);
        // Signal only the ChildProcess we spawned, never a group, discovered
        // PID or ref lock. An exited child may just have inherited pipes open.
        if (!exited && child.pid !== undefined) {
          try { child.kill('SIGTERM'); } catch (error) { fail(transactionError(String(error))); }
        }
        if (!await waitForStop() && !exited && child.pid !== undefined) {
          try { child.kill('SIGKILL'); } catch (error) { fail(transactionError(String(error))); }
          await waitForStop();
        }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!closed && !exited) {
        stopFailure = transactionError(`owned Git child ${child.pid ?? 'unspawned'} termination unconfirmed`);
        child.unref();
      }
    }
    if (stopFailure !== undefined) {
      throw new AggregateError([...(failure === undefined ? [] : [failure]), stopFailure],
        `${failure?.message ?? 'Git transaction settlement failed'}; ${stopFailure.message}`);
    }
    if (failure !== undefined) throw failure;
    if (status !== 0 || signal !== null) throw transactionError(`exit ${status}, signal ${signal}: ${stderrTail.toString('utf8').trim()}`);
  }

  /** Registration requires the requested checkout authority, independently
   * of the receipts that permit destructive rollback. */
  private assertCreationIdentity(path: string, custody: CreationCustody): void {
    const gitFile = readWorktreeMetadata(join(path, '.git')).trim();
    if (!gitFile.startsWith('gitdir: ')) throw new Error('missing linked-worktree gitdir');
    const admin = realpathSync(resolve(path, gitFile.slice('gitdir: '.length)));
    const head = readWorktreeMetadata(join(admin, 'HEAD')).trim();
    const common = realpathSync(resolve(admin, readWorktreeMetadata(join(admin, 'commondir')).trim()));
    if (dirname(admin) !== join(common, 'worktrees') ||
      realpathSync(resolve(admin, readWorktreeMetadata(join(admin, 'gitdir')).trim())) !== realpathSync(join(path, '.git'))) throw new Error('creation metadata backlink changed');
    const expected = custody.branch === null ? null : `refs/heads/${custody.branch}`;
    if (head !== (expected === null ? custody.sha : `ref: ${expected}`)) throw new Error(`worktree creation target changed: ${path} — refusing registration or handoff`);
    if (expected !== null) {
      const ref = join(common, expected);
      if (existsSync(ref)) {
        if (realpathSync(ref) !== ref || readWorktreeMetadata(ref).trim() !== custody.sha) throw new Error(`worktree creation target changed: ${path} — refusing registration or handoff`);
      } else readWorktreeMetadata(join(common, 'packed-refs'), 16 * 1024 * 1024);
    }
    const symbolic = spawnGit(path, ['symbolic-ref', '--quiet', 'HEAD']);
    if (runGit(path, ['rev-parse', 'HEAD']) !== custody.sha ||
      (expected === null ? symbolic.status !== 1 : symbolic.status !== 0 || symbolic.stdout.trim() !== expected)) {
      throw new Error(`worktree creation target changed: ${path} — refusing registration or handoff`);
    }
  }

  private assertCreationCustody(repoPath: string, path: string, custody: CreationCustody,
    common = realpathSync(runGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']))): string {
    const gitFile = readWorktreeMetadata(join(path, '.git')).trim();
    if (!gitFile.startsWith('gitdir: ')) throw new Error('missing linked-worktree gitdir');
    const admin = realpathSync(resolve(path, gitFile.slice('gitdir: '.length)));
    readWorktreeMetadata(join(admin, 'HEAD'));
    if (realpathSync(resolve(admin, readWorktreeMetadata(join(admin, 'commondir')).trim())) !== common) throw new Error('creation common directory changed');
    if (dirname(admin) !== join(common, 'worktrees') ||
      realpathSync(resolve(admin, readWorktreeMetadata(join(admin, 'gitdir')).trim())) !== realpathSync(join(path, '.git')) ||
      readWorktreeMetadata(join(admin, 'locked')).trim() !== custody.token) {
      throw new Error('linked-worktree custody receipt does not match this invocation');
    }
    return admin;
  }

  /** A failed hook can remove the checkout while leaving Git's locked
   * administration entry. Its backlink and nonce still prove custody. */
  private orphanCreationAdmin(repoPath: string, path: string, custody: CreationCustody,
    common = realpathSync(runGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']))): string | null {
    const container = join(common, 'worktrees');
    if (!existsSync(container)) return null;
    const expected = join(realpathSync(dirname(path)), basename(path), '.git');
    for (const entry of readdirSync(container, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const admin = join(container, entry.name);
      const backlink = resolve(admin, readWorktreeMetadata(join(admin, 'gitdir')).trim());
      if (backlink !== expected) continue;
      readWorktreeMetadata(join(admin, 'HEAD'));
      if (realpathSync(resolve(admin, readWorktreeMetadata(join(admin, 'commondir')).trim())) !== common) throw new Error('orphan creation common directory changed');
      if (readWorktreeMetadata(join(admin, 'locked')).trim() !== custody.token) {
        throw new Error('orphaned worktree custody receipt does not match this invocation');
      }
      return admin;
    }
    return null;
  }

  private handoffLane(repoPath: string, path: string, custody: CreationCustody, record: WorktreeRecord, assertSource?: () => void): void {
    try {
      assertSource?.();
      this.assertCreationIdentity(path, custody);
      const admin = this.assertCreationCustody(repoPath, path, custody);
      assertPendingLaneHandoff(record, admin, custody.token);
      assertSource?.();
      runGit(repoPath, ['worktree', 'unlock', path]);
      this.assertCreationIdentity(path, custody);
      assertSource?.();
      completeLaneHandoff(record, admin, custody.token, this.opts.ledger);
      assertSource?.();
    } catch (error) {
      throw new Error(`worktree creation custody handoff failed for ${path}; registered lane retained — inspect before retry`, { cause: error });
    }
  }

  /** Derive the assigned common directory without letting Git read an
   * unproven ref/HEAD before rollback's finite metadata checks. */
  private creationCommonDirectory(repoPath: string): string {
    // The same layout reading as the handoff proof (#372): a .git directory,
    // a linked worktree (through commondir) or a --separate-git-dir checkout.
    return repositoryCommonDirectory(repoPath);
  }

  private assertRollbackBranchMetadata(repoPath: string, custody: CreationCustody, common: string): void {
    if (this.creationCommonDirectory(repoPath) !== common) throw new Error('creation common directory changed during rollback');
    if (custody.branch === null) return;
    const ref = `refs/heads/${custody.branch}`, file = join(common, ref);
    if (existsSync(file)) {
      if (realpathSync(file) !== file || readWorktreeMetadata(file).trim() !== custody.sha) throw new Error(`created branch ${ref} changed`);
    } else readWorktreeMetadata(join(common, 'packed-refs'), 16 * 1024 * 1024);
  }

  private async assertBranchCreationCustody(repoPath: string, custody: CreationCustody, ownedPath: string | null, common: string, assertResources: () => void): Promise<void> {
    if (!custody.branchCreated || custody.branch === null) return;
    const ref = `refs/heads/${custody.branch}`;
    const query = async (args: readonly string[]) => {
      assertResources();
      this.assertRollbackBranchMetadata(repoPath, custody, common);
      const result = await this.creationMetadata(repoPath, args);
      assertResources();
      this.assertRollbackBranchMetadata(repoPath, custody, common); // reprove after every awaited query
      return result;
    };
    if ((await query(['symbolic-ref', '--quiet', '--no-recurse', ref])).status !== 1) {
      throw new Error(`created branch ${ref} is no longer a direct ref`);
    }
    const read = async (args: readonly string[]): Promise<string> => {
      const result = await query(args);
      if (result.status !== 0) throw new Error(`creation custody query ${args[0]} failed`);
      return result.stdout.trim();
    };
    const receipt = await read(['reflog', 'show', '-1', '--format=%H%x00%gs', ref]);
    const tip = await read(['rev-parse', '--verify', ref]);
    const trees = await read(['worktree', 'list', '--porcelain', '-z']);
    if (tip !== custody.sha || receipt !== `${custody.sha}\0${custody.token}` || this.branchHasForeignHolder(trees, ref, ownedPath)) {
      throw new Error(`created branch ${ref} changed or is held by another worktree`);
    }
  }

  private branchHasForeignHolder(trees: string, ref: string, ownedPath: string | null): boolean {
    return trees.split('\0\0').some((entry) => {
      const fields = entry.split('\0');
      if (!fields.includes(`branch ${ref}`)) return false;
      const tree = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
      return ownedPath === null || tree === undefined ||
        join(realpathSync(dirname(tree)), basename(tree)) !== join(realpathSync(dirname(ownedPath)), basename(ownedPath));
    });
  }

  /** Only matching Git-native invocation receipts permit destructive
   * rollback. Check ALL custody before any cleanup; uncertainty retains the
   * resources and reports both the original failure and the missing proof. */
  private async rollbackPartialLane(repoPath: string, path: string, custody: CreationCustody, originalError: unknown): Promise<void> {
    try {
      const common = this.creationCommonDirectory(repoPath);
      const present = custody.addAttempted && existsSync(path);
      const orphanAdmin = custody.addAttempted && !present ? this.orphanCreationAdmin(repoPath, path, custody, common) : null;
      const ownedPath = present || orphanAdmin !== null ? path : null;
      const assertResources = (): void => {
        if (this.creationCommonDirectory(repoPath) !== common) throw new Error('creation common directory changed during rollback');
        if (present) this.assertCreationCustody(repoPath, path, custody, common);
        else if (orphanAdmin !== null && this.orphanCreationAdmin(repoPath, path, custody, common) !== orphanAdmin) throw new Error('orphaned worktree custody changed during rollback');
      };
      assertResources();
      await this.assertBranchCreationCustody(repoPath, custody, ownedPath, common, assertResources);
      assertResources();
      if (custody.branchCreated && custody.branch !== null) {
        // Keep the invocation-owned checkout holding this branch until its
        // compare-and-delete finishes. Dropping the checkout first opens a
        // window for an ordinary external worktree to adopt the same tip.
        // No owned holder means no destructive authority: retain the ref.
        let heldRef: string | null = null;
        if (orphanAdmin !== null) heldRef = readWorktreeMetadata(join(orphanAdmin, 'HEAD')).trim().replace(/^ref: /u, '');
        else if (ownedPath !== null) {
          const result = await this.creationMetadata(ownedPath, ['symbolic-ref', 'HEAD']);
          if (result.status !== 0) throw new Error('creation custody HEAD query failed');
          heldRef = result.stdout.trim();
        }
        assertResources();
        if (ownedPath === null || heldRef !== `refs/heads/${custody.branch}`) {
          throw new Error(`created branch ${custody.branch} has no invocation-owned checkout reservation`);
        }
        this.assertRollbackBranchMetadata(repoPath, custody, common);
        await this.updateDirectCreationRef(repoPath, custody, 'delete', ownedPath);
      }
      if (ownedPath !== null) {
        // The awaited transaction may run configured hooks or external actors.
        // Never remove a path/admin entry using the pre-await custody proof.
        if (this.creationCommonDirectory(repoPath) !== common) throw new Error('creation common directory changed during rollback');
        if (existsSync(path)) this.assertCreationCustody(repoPath, path, custody, common);
        else if (this.orphanCreationAdmin(repoPath, path, custody, common) !== orphanAdmin || orphanAdmin === null) {
          throw new Error('orphaned worktree custody changed during rollback');
        }
        // Git protects locked lanes even against a single --force.
        runGit(repoPath, ['worktree', 'remove', '--force', '--force', path]);
      }
    } catch (error) {
      this.log('error', 'creation rollback custody unconfirmed; resources retained', { path, error: String(error) });
      throw new AggregateError([originalError, error],
        `worktree creation failed (${String(originalError)}); rollback custody unconfirmed for ${path} — inspect retained resources before retry`);
    }
  }

  /** Issue #243 F-H1: the pre-removal proof an UNATTENDED release owes
   * BEFORE `worktree remove --force`. Refuses (tree retained) when fresh
   * required containment cannot be proven (the base cannot be freshly
   * resolved, so the missing-fresh-evidence removal is refused). Dirty
   * tracked work is not refused here any more: the removal tail snapshots
   * it (#427). A live process is NOT handled here: the preserve/pause-and-ask
   * tail owns it and the human answer stays absolute. */
  private assertAutomaticReleaseProofs(row: WorktreeRecord): void {
    try {
      this.resolveBase(row.repoPath);
    } catch (error) {
      throw new Error(
        `automatic sweep refused: fresh required containment cannot be proven for ${row.path} (${String(error)}) — the tree is retained`,
      );
    }
  }

  /** Copy untracked-not-ignored deliverables into the preserve root.
   *
   * Perkins r1 B1: paths come from `--porcelain -z` — NUL-delimited and
   * NEVER C-quoted (a quoted `"my file.txt"` under the old text parser
   * failed statSync, logged "vanished", and the remove --force deleted
   * the deliverable). A deliverable that genuinely vanished mid-sweep
   * (ENOENT) is skipped and logged; ANY OTHER preserve failure ABORTS the
   * sweep with the tree intact — deliverables are never sacrificed to a
   * removal step. */
  private preserveUntracked(row: WorktreeRecord, submodules: readonly string[], attempt: SweepAttempt): SweepPreservation | null {
    // `--untracked-files=all` overrides the repository's own
    // `status.showUntrackedFiles` (#427): a repository that hides untracked
    // files from `git status` still has every one copied. A submodule's
    // untracked content (#427) is copied too, under its path.
    const untracked = [
      ...porcelainUntracked(runGit(row.path, ['status', '--porcelain', '-z', '--untracked-files=all'])),
      ...submodules.flatMap((sub) => porcelainUntracked(runGit(join(row.path, sub), ['status', '--porcelain', '-z', '--untracked-files=all'])).map((rel) => `${sub}/${rel}`)),
    ];
    if (untracked.length === 0) return null;
    // A retry of a release that aborted after its records (#427) reuses that
    // release's copy while the untracked files are unchanged: no new folder
    // and no new record.
    const reused = this.reusablePreservation(row, untracked, attempt.aborted);
    if (reused !== null) {
      attempt.preserveReused = true;
      attempt.copyRecorded = true;
      this.log('info', 'untracked deliverables unchanged since an aborted release; its preserve copy is reused', { id: row.id, destination: reused.destination });
      return reused;
    }
    const destination = join(this.opts.preserveRoot, row.id, new Date().toISOString().replace(/[:.]/g, '-'));
    let preservedCount = 0;
    try {
      preservedCount = this.copyUntracked(row, untracked, destination);
    } catch (error) {
      // A copy that failed part way is not kept (#427): the tree is.
      this.withdrawPreservation(row, { count: 0, destination });
      throw error;
    }
    if (preservedCount === 0) return null;
    this.log('info', 'untracked deliverables preserved before sweep', {
      id: row.id,
      files: preservedCount,
      destination,
    });
    return { count: preservedCount, destination };
  }

  /** An aborted release's preserve copy, when it still holds exactly the
   * lane's untracked files (the same paths, links and bytes); else null. */
  private reusablePreservation(row: WorktreeRecord, untracked: readonly string[], aborted: AbortedRelease | null): SweepPreservation | null {
    const copy = aborted?.preserved ?? null;
    if (copy === null || !existsSync(copy.destination)) return null;
    try {
      return contentFingerprint(row.path, untracked) === contentFingerprint(copy.destination, null) ? copy : null;
    } catch (error) {
      this.log('warn', 'an aborted release\'s preserve copy could not be compared with the lane; the untracked files are copied afresh', { id: row.id, destination: copy.destination, error: String(error) });
      return null;
    }
  }

  /** Record a preserve copy the release keeps (#427: recorded once the
   * release either pauses or reaches the removal, so a refusal leaves no
   * record of a copy it withdrew; a reused copy is on the record already). */
  private recordPreservation(row: WorktreeRecord, preserved: SweepPreservation | null, attempt: SweepAttempt): void {
    if (preserved === null || attempt.preserveReused) return;
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.preserved',
      jobId: row.jobId,
      roundId: row.roundId,
      payload: { id: row.id, files: preserved.count, destination: preserved.destination },
    });
  }

  /** Remove the preserve copy a refused release made (#427), and the lane's
   * preserve folder when this copy was all it held: a refusal never leaves
   * a new folder under the preserve root. */
  private withdrawPreservation(row: WorktreeRecord, preserved: SweepPreservation | null): void {
    if (preserved === null) return;
    try {
      rmSync(preserved.destination, { recursive: true, force: true });
      try {
        rmdirSync(dirname(preserved.destination));
      } catch {
        // earlier copies live there: the folder is not this attempt's
      }
    } catch (error) {
      this.log('warn', 'a refused release could not remove its preserve copy', { id: row.id, destination: preserved.destination, error: String(error) });
    }
  }

  private copyUntracked(row: WorktreeRecord, untracked: readonly string[], destination: string): number {
    let preservedCount = 0;
    for (const rel of untracked) {
      const source = join(row.path, rel);
      let info: Stats;
      try {
        info = lstatSync(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.log('warn', 'untracked deliverable vanished before preserve — skipping', {
            id: row.id,
            rel,
          });
          continue;
        }
        throw new Error(
          `sweep aborted: deliverable "${rel}" is present but unverifiable (${String(error)}) — the tree is retained; resolve and re-release`,
        );
      }
      const dest = join(destination, rel);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        if (info.isSymbolicLink()) {
          // Perkins r4 B1: a manifest [[link]] (or any symlink deliverable)
          // is preserved AS A LINK — copyFileSync on a symlink-to-dir is
          // ENOTSUP/EISDIR and used to make the lane unreleasable forever.
          // The link is the deliverable; recreate it verbatim.
          symlinkSync(readlinkSync(source), dest);
        } else if (info.isDirectory()) {
          cpSync(source, dest, { recursive: true });
        } else {
          copyFileSync(source, dest);
        }
        preservedCount += 1;
      } catch (error) {
        throw new Error(
          `sweep aborted: deliverable "${rel}" could not be preserved (${String(error)}) — the tree is retained; resolve and re-release`,
        );
      }
    }
    return preservedCount;
  }

  /**
   * The answered ask (Perkins r2 B2): kill EXACTLY the acknowledged pids
   * — the 18b rows recorded at the pause — with a SIGTERM grace before
   * SIGKILL. Survivors re-pause; NEW processes (not in the acknowledged
   * set) get their own ask — every kill is individually acknowledged.
   */
  private async killAcknowledgedAndContinue(
    row: WorktreeRecord,
    acknowledged: readonly { pid: number; command: string; evidence: string }[],
    preserved: SweepPreservation | null,
    baseBranch: string | undefined,
    assertCleanup: () => void,
    attempt: SweepAttempt,
  ): Promise<SweepResult> {
    const pids = acknowledged.map((proc) => proc.pid);
    this.opts.ledger.recordWorktreeProcesses({
      worktreeId: row.id,
      processes: acknowledged,
      state: 'killed',
    });
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.kill-confirmed',
      jobId: row.jobId,
      roundId: row.roundId,
      payload: { id: row.id, pids },
    });
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        this.log('warn', 'acknowledged SIGTERM failed (already gone?)', { pid, error: String(error) });
      }
    }
    // Grace: give the acknowledged processes time to honor SIGTERM.
    await new Promise((resolve) => setTimeout(resolve, this.opts.killGraceMs ?? 1_500));
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (const pid of pids) {
      if (!alive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL'); // grace expired — still the acknowledged pid
      } catch (error) {
        this.log('warn', 'acknowledged SIGKILL failed', { pid, error: String(error) });
      }
    }
    // Settle, then decide: a survivor is a pid still alive AND still
    // enumerated in the tree (zombies die on the enumeration check).
    await new Promise((resolve) => setTimeout(resolve, Math.min(this.opts.killGraceMs ?? 1_500, 300)));
    const fresh = this.enumerate(row.path);
    const survivors = pids.filter((pid) => alive(pid) && fresh.some((proc) => proc.pid === pid));
    if (survivors.length > 0) {
      const note = `sweep paused: pids ${survivors.join(', ')} survived the acknowledged kill (SIGTERM + SIGKILL)`;
      this.opts.ledger.setWorktreeStatus(row.id, 'paused', note);
      return {
        status: 'paused',
        processes: fresh.filter((proc) => survivors.includes(proc.pid)),
        preserved,
        note,
      };
    }
    // NEW processes since the pause are NOT covered by this ask — they
    // get their own pause (their own ask), never a ride-along kill.
    const unacknowledged = fresh.filter((proc) => !pids.includes(proc.pid));
    if (unacknowledged.length > 0) {
      this.opts.ledger.recordWorktreeProcesses({
        worktreeId: row.id,
        processes: unacknowledged.map((proc) => ({
          pid: proc.pid,
          command: proc.command,
          evidence: proc.evidence,
        })),
        state: 'live',
      });
      const note = `sweep paused: ${unacknowledged.length} NEW process(es) appeared after the acknowledged kill (pids ${unacknowledged
        .map((p) => p.pid)
        .join(', ')}) — each kill needs its own acknowledgment`;
      this.opts.ledger.setWorktreeStatus(row.id, 'paused', note);
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.paused',
        jobId: row.jobId,
        roundId: row.roundId,
        payload: { id: row.id, path: row.path, processes: unacknowledged, reason: 'post-kill-new-processes' },
      });
      this.opts.onSweepPaused?.({ worktree: row, processes: unacknowledged });
      return { status: 'paused', processes: unacknowledged, preserved, note };
    }
    return this.finishSweep(row, preserved, baseBranch, assertCleanup, attempt);
  }

  /** Removal + containment branch delete + fresh head (shared tail). */
  private finishSweep(
    row: WorktreeRecord,
    preserved: SweepPreservation | null,
    baseBranch: string | undefined,
    assertCleanup: () => void,
    attempt: SweepAttempt,
  ): SweepResult {
    // (4a) Worktree removal. A failure HERE throws with the tree intact
    // and the row unchanged — retry-safe.
    assertCleanup();
    // (4a.0) Lossless (#427): `remove --force` keeps only the untracked
    // deliverables preserved above, so the lane's uncommitted tracked work
    // is saved to a ref first. The early checks run again (the tree may have
    // changed while the release waited or killed), and the snapshot is built
    // and proven now that the lane's processes are handled; a refusal here
    // throws with the tree intact and withdraws the preserve copy.
    this.assertNoOperationInProgress(row);
    this.assertNotSparse(row);
    const { discarded } = this.assertSubmoduleWork(row, attempt.discardSubmoduleWork);
    const built = this.buildSnapshot(row);
    // The records the removal depends on come first, and the ref last, just
    // before the removal: a refusal on the way leaves no ref behind.
    this.recordPreservation(row, preserved, attempt);
    attempt.copyRecorded = true;
    const discardedDigest = discarded.length > 0 ? attempt.discardSubmoduleWork : null;
    if (discardedDigest !== null && attempt.aborted?.discarded !== discardedDigest) {
      // The operator's discard is on the record before anything is lost
      // (once: a retry of an aborted release that recorded it reuses it).
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.submodule-work-discarded',
        jobId: row.jobId,
        roundId: row.roundId,
        payload: { id: row.id, path: row.path, digest: discardedDigest, submodules: discarded },
      });
      this.log('warn', 'submodule work discarded by an operator release', { id: row.id, submodules: discarded });
    }
    let snapshot: SweepSnapshot | null = null;
    try {
      snapshot = built === null ? null : this.reusableSnapshot(row, built, attempt.aborted) ?? this.saveSnapshot(row, built);
      runGit(row.repoPath, ['worktree', 'remove', '--force', row.path]);
    } catch (error) {
      // After the records (#427): say what is saved, so the copy and the ref
      // are accounted for, and a retry reuses them while the work is the same.
      this.recordAbortedRelease(row, { preserved, snapshot, discarded: discardedDigest }, error);
      throw error;
    }

    // (4b/5) POST-REMOVAL TAIL (Perkins lane-B r1 B2): the tree is GONE —
    // the registry must follow even if the tail hiccups. A stranded
    // non-swept row over a removed tree wedges every retry
    // (preserveUntracked dies on the missing tree). Catch-and-mark.
    let branchOutcome: 'deleted' | 'retained' | 'none' = 'none';
    let freshHead = '';
    try {
      // Release re-resolves the FRESH head FIRST (ruling 18e; Perkins
      // r7/r8): the fetch makes the CURRENT remote state known BEFORE the
      // branch decision, and ONLY a successfully-fetched, verified default
      // yields a remote witness for the disposal — a fetch failure or an
      // unverified default means stale tracking refs witness nothing.
      // (A freshHead failure here skips the disposition — fail-safe: the
      // branch is retained.)
      const base = this.resolveBase(row.repoPath);
      freshHead = base.sha;
      assertLaneResourcesAbsent(row);
      // Containment-verified branch delete — job and writer-child lanes;
      // a branch is deleted only when its tip is provably contained in a
      // durable local ref or the freshly verified remote default;
      // otherwise it is RETAINED, noted, and the reason reported.
      if ((row.kind === 'job' || row.kind === 'child') && row.branch !== null) {
        branchOutcome = this.deleteBranchContained(
          row,
          baseBranch,
          base.baseSource === 'origin' ? base.defaultBranch : null,
        );
      }
    } catch (error) {
      if (error instanceof WorktreeHandoffUnresolvedError) throw error;
      this.log('error', 'sweep tail failed after removal — row still flips swept', {
        id: row.id,
        error: String(error),
      });
      this.tailFailure = String(error);
    }
    assertLaneResourcesAbsent(row);
    // FLIP FIRST (Perkins lane-B r2 a/b): the registry must reflect the
    // removed tree even if the EVENT writes then fail — and the flip
    // itself is guarded (a DB-down window reconciles on retry via the
    // missing-tree path). Events are best-effort, never flip-blockers.
    try {
      this.opts.ledger.setWorktreeStatus(row.id, 'swept');
    } catch (flipError) {
      this.log('error', 'swept flip failed — retry reconciles over the missing tree', {
        id: row.id,
        error: String(flipError),
      });
    }
    this.recordSweepEvent(row, preserved, branchOutcome, freshHead, snapshot);
    this.log('info', 'worktree swept', { id: row.id, branch: branchOutcome, freshHead, snapshot: snapshot?.ref ?? null });
    try {
      this.opts.onSwept?.({ worktree: row });
    } catch (error) {
      // The sweep already completed; a notification hiccup must not undo it.
      this.log('warn', 'sweep-completion notice resolution failed', { id: row.id, error: String(error) });
    }
    if (snapshot !== null || preserved !== null) {
      try {
        this.opts.onWorkSaved?.({ worktree: row, snapshot, preserved });
      } catch (error) {
        this.log('warn', 'saved-work notice failed; what was saved is on the swept and preserved records', { id: row.id, ref: snapshot?.ref ?? null, error: String(error) });
      }
    }
    return { status: 'swept', preserved, branch: branchOutcome, freshHead, snapshot };
  }

  /** Refuse while git is mid-operation in the lane (#427): a merge, rebase,
   * cherry-pick, revert or bisect in progress, a multi-commit cherry-pick
   * or revert with commits still to go, or unmerged index entries. The
   * error names the state and the command that clears it. */
  private assertNoOperationInProgress(row: WorktreeRecord): void {
    const operations = [
      ['MERGE_HEAD', 'a merge (MERGE_HEAD)', '`git merge --abort` (or commit the merge)'],
      ['rebase-merge', 'a rebase (rebase-merge)', '`git rebase --abort` (or finish it with `git rebase --continue`)'],
      ['rebase-apply', 'a rebase or `git am` (rebase-apply)', '`git rebase --abort` or `git am --abort`'],
      ['CHERRY_PICK_HEAD', 'a cherry-pick (CHERRY_PICK_HEAD)', '`git cherry-pick --abort` (or finish it with `git cherry-pick --continue`)'],
      ['REVERT_HEAD', 'a revert (REVERT_HEAD)', '`git revert --abort` (or finish it with `git revert --continue`)'],
      ['BISECT_LOG', 'a bisect (BISECT_LOG)', '`git bisect reset`'],
      ['sequencer/todo', 'a multi-commit cherry-pick or revert (sequencer)', '`git cherry-pick --continue` or `git revert --continue` to finish it (`--quit` to stop it)'],
    ] as const;
    for (const [name, operation, clear] of operations) {
      const path = resolve(row.path, runGit(row.path, ['rev-parse', '--git-path', name]));
      if (existsSync(path)) throw new LaneOperationInProgressError(row.path, operation, clear);
    }
    const unmerged = new Set(runGit(row.path, ['ls-files', '--unmerged', '-z'])
      .split('\0')
      .filter((entry) => entry !== '')
      .map((entry) => entry.slice(entry.indexOf('\t') + 1)));
    if (unmerged.size > 0) {
      throw new LaneOperationInProgressError(
        row.path,
        `an unresolved conflict (${unmerged.size} unmerged path(s) in the index: ${[...unmerged].slice(0, 5).join(', ')})`,
        '`git add` on each resolved path (or `git reset --merge` to drop the conflict)',
      );
    }
  }

  /** Refuse a sparse checkout by name (#427): GC cannot save its work
   * without risking a wrong tree ({@link LaneSparseCheckoutError}). */
  private assertNotSparse(row: WorktreeRecord): void {
    const sparse = spawnGit(row.path, ['config', '--bool', '--get', 'core.sparseCheckout']);
    if (sparse.status === 0 && sparse.stdout.trim() === 'true') throw new LaneSparseCheckoutError(row.path);
  }

  /**
   * Submodule work the removal would destroy (#427). A lane's submodules
   * keep their git data under the lane's own git folder (or in a `.git`
   * inside their checkout), which the removal deletes, and the snapshot
   * holds only their gitlinks. Detection ignores every display setting
   * (`--ignore-submodules=none`, `diff.ignoreSubmodules=none`); what counts
   * as work is GC's policy:
   *
   * - **a commit that survives nowhere else** is refused: the submodule's
   *   HEAD, the gitlink the lane's HEAD or index records, the tip of any of
   *   its copy's local branches, or any stash entry, when it is in the
   *   lane's copy of the submodule but in none of that copy's
   *   remote-tracking refs or tags and not in the main checkout's own copy
   *   (`<git common dir>/modules/<name>`), which outlives the lane. The
   *   gitlink the lane's base (`row.sha`) records is never the lane's work;
   * - **modified tracked content** is always refused, whatever `.gitmodules`
   *   `ignore =` says;
   * - **untracked content** is never refused: the preserve copy takes it,
   *   unless the base's `.gitmodules` sets `ignore = untracked` or
   *   `ignore = all` for that submodule (the user declared it disposable).
   *
   * Work at risk is refused by name ({@link LaneSubmoduleWorkError},
   * recorded once per lane and digest as `worktree.submodule-work-refused`,
   * and Gru told once), unless an operator release's discard carries the
   * digest of exactly this work. Returns what is discarded, and the
   * submodules whose untracked content the preserve copy takes.
   */
  private assertSubmoduleWork(row: WorktreeRecord, discard: string | null): { readonly discarded: readonly SubmoduleWork[]; readonly untracked: readonly string[] } {
    const scan = this.submoduleWork(row);
    if (scan.work.length === 0) return { discarded: [], untracked: scan.untracked };
    if (discard === scan.digest) return { discarded: scan.work, untracked: scan.untracked };
    this.recordSubmoduleRefusal(row, scan.work, scan.digest);
    throw new LaneSubmoduleWorkError(row.path, scan.work, scan.digest, discard);
  }

  private submoduleWork(row: WorktreeRecord): SubmoduleScan {
    const none: SubmoduleScan = { work: [], digest: '', untracked: [] };
    // Cheap first (#427): with no `.gitmodules` at HEAD or in the working
    // tree, only a staged gitlink (an embedded repository added) can be a
    // submodule, and the staged change shows it without listing the tree.
    const gitmodules = spawnGit(row.path, ['cat-file', '-e', 'HEAD:.gitmodules']).status === 0 || pathOnDisk(join(row.path, '.gitmodules'));
    if (!gitmodules && !stagedGitlink(spawnGit(row.path, ['diff', '--cached', '--raw', '-z', '--no-renames', 'HEAD', '--']).stdout)) return none;
    // Content, with nothing hidden by any config.
    const content = new Map<string, { readonly modified: boolean; readonly untracked: boolean }>();
    const records = runGit(row.path, ['-c', 'diff.ignoreSubmodules=none', 'status', '--porcelain=v2', '-z', '--ignore-submodules=none', '--untracked-files=all'], { maxBuffer: LISTING_MAX_BUFFER }).split('\0');
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const kind = record.charAt(0);
      // A rename's original path follows it as its own field.
      if (kind === '2') index += 1;
      if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
      const fields = record.split(' ');
      const sub = fields[2] ?? 'N...';
      if (!sub.startsWith('S')) continue;
      const state = { modified: sub.charAt(2) === 'M', untracked: sub.charAt(3) === 'U' };
      if (state.modified || state.untracked) content.set(fields.slice(kind === '1' ? 8 : kind === '2' ? 9 : 10).join(' '), state);
    }
    // Commits: the gitlinks the index records (one bounded listing), and
    // those the lane's HEAD and its base record at the submodule paths.
    const staged = gitlinks(runGit(row.path, ['ls-files', '-s', '-z'], { maxBuffer: LISTING_MAX_BUFFER }), 'index');
    const names = this.submoduleNames(row, 'HEAD');
    const paths = [...new Set([...names.keys(), ...staged.keys(), ...content.keys()])].sort();
    if (paths.length === 0) return none;
    const recorded = gitlinks(runGit(row.path, ['ls-tree', '-z', 'HEAD', '--', ...paths], { maxBuffer: LISTING_MAX_BUFFER }), 'tree');
    const base = gitlinks(spawnGit(row.path, ['ls-tree', '-z', row.sha, '--', ...paths], { maxBuffer: LISTING_MAX_BUFFER }).stdout, 'tree');
    const baseIgnore = this.submoduleIgnore(row);
    const mainModules = resolve(row.repoPath, runGit(row.repoPath, ['rev-parse', '--git-common-dir']), 'modules');
    const work: SubmoduleWork[] = [];
    const fingerprints: string[] = [];
    const untracked: string[] = [];
    for (const path of paths) {
      const name = names.get(path) ?? path;
      const state = content.get(path);
      const ignore = baseIgnore.get(name);
      if (state?.untracked === true && ignore !== 'untracked' && ignore !== 'all') untracked.push(path);
      const gitDir = this.laneSubmoduleGitDir(row, path, name);
      const head = gitDir === null ? null : spawnGit(gitDir, ['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).stdout.trim() || null;
      const commits = new Map<string, string>();
      const candidates: (readonly [string | null | undefined, string])[] = [
        [head, 'its HEAD'],
        [recorded.get(path), 'recorded in the lane\'s HEAD'],
        [staged.get(path), 'staged in the lane\'s index'],
        ...(gitDir === null ? [] : submoduleLocalCommits(gitDir)),
      ];
      // The gitlink the lane's base records is the pin it started from.
      for (const [commit, where] of candidates) if (commit != null && commit !== base.get(path) && !commits.has(commit)) commits.set(commit, where);
      const lost = gitDir === null ? [] : [...commits].filter(([commit]) => !submoduleCommitSurvives(gitDir, join(mainModules, name), commit));
      const states = [
        ...lost.map(([commit, where]) => `commit ${commit} (${where}) is on no remote-tracking ref or tag and not in the main checkout's copy`),
        ...(state?.modified === true ? ['modified tracked content'] : []),
      ];
      if (states.length === 0) continue;
      work.push({ path, state: states, head });
      fingerprints.push(this.submoduleContentFingerprint(row, path, lost.map(([commit]) => commit), state?.untracked === true && ignore !== 'untracked' && ignore !== 'all'));
    }
    return { work, digest: submoduleWorkDigest(work, fingerprints), untracked };
  }

  /** What a refused submodule holds, as a hash (#427): its tracked content
   * against its HEAD (`git diff --binary HEAD`), its untracked paths, and the
   * commits found at risk. More edits after a refusal change it. */
  private submoduleContentFingerprint(row: WorktreeRecord, path: string, commits: readonly string[], withUntracked: boolean): string {
    const checkout = join(row.path, path);
    const hash = createHash('sha256').update(JSON.stringify(commits));
    if (!pathOnDisk(join(checkout, '.git'))) return hash.digest('hex');
    const diff = spawnGit(checkout, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], { maxBuffer: LISTING_MAX_BUFFER });
    hash.update(`\0${String(diff.status)}\0`).update(diff.stdout);
    if (withUntracked) hash.update('\0').update(JSON.stringify([...porcelainUntracked(spawnGit(checkout, ['status', '--porcelain', '-z', '--untracked-files=all'], { maxBuffer: LISTING_MAX_BUFFER }).stdout)].sort()));
    return hash.digest('hex');
  }

  /** Submodule names by path, from `.gitmodules` at a revision and in the
   * lane's working tree (which wins); a path with neither is its own name. */
  private submoduleNames(row: WorktreeRecord, revision: string): Map<string, string> {
    const names = new Map<string, string>();
    for (const [name, key, value] of [...gitmodulesEntries(row.path, ['--blob', `${revision}:.gitmodules`]), ...gitmodulesEntries(row.path, ['--file', '.gitmodules'])]) {
      if (key === 'path') names.set(value, name);
    }
    return names;
  }

  /** Each submodule's `ignore =` by name, from `.gitmodules` at the lane's
   * base (#427): what the user declared, never a minion's later edit. */
  private submoduleIgnore(row: WorktreeRecord): Map<string, string> {
    const ignore = new Map<string, string>();
    for (const [name, key, value] of gitmodulesEntries(row.path, ['--blob', `${row.sha}:.gitmodules`])) if (key === 'ignore') ignore.set(name, value);
    return ignore;
  }

  /** The lane's own copy of a submodule's git data: a `.git` inside its
   * checkout, else `modules/<name>` under the lane's git folder; null when
   * the lane has none (it never initialized the submodule). */
  private laneSubmoduleGitDir(row: WorktreeRecord, path: string, name: string): string | null {
    const checkout = join(row.path, path);
    if (existsSync(join(checkout, '.git'))) return runGit(checkout, ['rev-parse', '--absolute-git-dir']);
    const modules = resolve(row.path, runGit(row.path, ['rev-parse', '--git-path', `modules/${name}`]));
    return existsSync(modules) ? modules : null;
  }

  /** A submodule refusal on the record, once per lane and digest (a lane
   * with no job too): what the operator was shown, so a discard can name
   * it. Gru is told once per lane and digest. */
  private recordSubmoduleRefusal(row: WorktreeRecord, work: readonly SubmoduleWork[], digest: string): void {
    let previousDigest: string | null = null;
    try {
      const last = (this.opts.ledger.latestEventByPayloadField('worktree.submodule-work-refused', 'id', row.id)?.payload ?? null) as { readonly digest?: unknown } | null;
      if (last?.digest === digest) return;
      previousDigest = typeof last?.digest === 'string' ? last.digest : null;
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.submodule-work-refused',
        jobId: row.jobId,
        roundId: row.roundId,
        payload: { id: row.id, path: row.path, digest, submodules: work },
      });
    } catch (error) {
      this.log('error', 'worktree.submodule-work-refused event write failed; the refusal still names its digest', { id: row.id, error: String(error) });
    }
    try {
      this.opts.onSubmoduleWorkRefused?.({ worktree: row, submodules: work, digest, previousDigest });
    } catch (error) {
      this.log('warn', 'submodule-work notice failed; the refusal and its record name the digest', { id: row.id, error: String(error) });
    }
  }

  /**
   * The lane's uncommitted tracked work as a tree, built without writing
   * the lane's own index (#427), in the removal tail once the lane's
   * processes are handled:
   *
   * - The lane's index file is copied to a temporary one, its times with it
   *   (a plain read that takes no `index.lock`; the stat cache comes along,
   *   so an unchanged file is not hashed again, and the index's own mtime
   *   keeps git's racy-clean check: an entry written in the index's second
   *   is hashed again, as the real index would have it). Only when that
   *   copy cannot be made (the lane's index is missing or unreadable) is the
   *   temporary index read from HEAD, with a warn naming the staged new
   *   files that are then not in the snapshot.
   * - The assume-unchanged and skip-worktree bits are cleared on every entry
   *   whose file is on disk, so an edit behind either is saved.
   * - `git add -u` adds every tracked edit and deletion, `git write-tree`
   *   writes the tree, and `git diff --quiet <tree> --` with the same index
   *   proves it equals the tracked working tree (submodule work was refused
   *   or discarded before).
   *
   * Untracked files are left to the preserve copy. Null when the tree is
   * HEAD's. A tree that cannot be built or proven refuses
   * ({@link LaneSnapshotError}), naming the file when git does.
   */
  private buildSnapshot(row: WorktreeRecord): BuiltSnapshot | null {
    const scratch = mkdtempSync(join(tmpdir(), 'gru-sweep-snapshot-'));
    const index = { indexFile: join(scratch, 'index') };
    const oneLine = (error: unknown): string => oneLineErrorText(error instanceof Error ? error.message : error, 400);
    const cannotBuild = (error: unknown): LaneSnapshotError => {
      const file = gitNamedFile(error instanceof Error ? error.message : String(error));
      return new LaneSnapshotError(row.path, `could not be built${file === null ? '' : `: git could not read ${file}`} (${oneLine(error)})`);
    };
    try {
      let head: string;
      let tree: string;
      try {
        head = runGit(row.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
        const laneIndex = resolve(row.path, runGit(row.path, ['rev-parse', '--git-path', 'index']));
        try {
          // The times before the bytes: an index rewritten meanwhile leaves
          // the copy older than its content, which only makes more entries racy.
          const { atime, mtime } = statSync(laneIndex);
          copyFileSync(laneIndex, index.indexFile);
          utimesSync(index.indexFile, atime, mtime);
        } catch (copied) {
          this.warnIndexFallback(row, head, copied);
          rmSync(index.indexFile, { force: true });
          runGit(row.path, ['read-tree', head], index);
        }
        this.clearHiddenEntryBits(row, index);
        runGit(row.path, ['add', '-u'], index);
        tree = runGit(row.path, ['write-tree'], index);
      } catch (error) {
        throw cannotBuild(error);
      }
      const differs = spawnGit(row.path, ['diff', '--quiet', '--ignore-submodules=all', tree, '--'], index);
      if (differs.status !== 0) {
        throw new LaneSnapshotError(row.path, `does not match the working tree (git diff --quiet exited ${String(differs.status)}${
          differs.stderr.trim() === '' ? '' : `: ${oneLine(differs.stderr)}`})`);
      }
      if (tree === runGit(row.path, ['rev-parse', `${head}^{tree}`])) return null;
      const files = runGit(row.path, ['diff-tree', '-r', '--no-renames', '--name-only', '-z', head, tree]).split('\0').filter((entry) => entry !== '').length;
      return { head, tree, files };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** The snapshot falls back to HEAD (#427): files staged new in the
   * lane's index are then in neither the snapshot nor the preserve copy, so
   * the warn names them when the lane's index can be listed at all. */
  private warnIndexFallback(row: WorktreeRecord, head: string, error: unknown): void {
    const listed = spawnGit(row.path, ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=A', '-z', head, '--']);
    const stagedNew = listed.status === 0 ? listed.stdout.split('\0').filter((entry) => entry !== '') : null;
    this.log('warn', 'the snapshot could not be built from a copy of the lane\'s index; building it from HEAD (files staged new in the lane\'s index are not in it)', {
      id: row.id,
      error: oneLineErrorText(error instanceof Error ? error.message : error, 400),
      ...(stagedNew === null ? { staged_new: 'the lane\'s index cannot be listed' } : { staged_new: stagedNew.slice(0, 50), staged_new_count: stagedNew.length }),
    });
  }

  /** Clear the assume-unchanged and skip-worktree bits on the temporary
   * index for every entry whose file is on disk (#427): `add -u` and the
   * proof would otherwise trust them and miss an edit. An entry absent from
   * disk keeps its bits. */
  private clearHiddenEntryBits(row: WorktreeRecord, index: SpawnGitOptions): void {
    const assumed: string[] = [];
    const skipped: string[] = [];
    for (const entry of runGit(row.path, ['ls-files', '-v', '-z'], { ...index, maxBuffer: LISTING_MAX_BUFFER }).split('\0')) {
      const tag = entry.charAt(0);
      const path = entry.slice(2);
      const assume = tag !== tag.toUpperCase();
      const skip = tag.toUpperCase() === 'S';
      if ((!assume && !skip) || path === '' || !pathOnDisk(join(row.path, path))) continue;
      if (assume) assumed.push(path);
      if (skip) skipped.push(path);
    }
    if (assumed.length > 0) runGit(row.path, ['update-index', '--no-assume-unchanged', '-z', '--stdin'], { ...index, input: `${assumed.join('\0')}\0` });
    if (skipped.length > 0) runGit(row.path, ['update-index', '--no-skip-worktree', '-z', '--stdin'], { ...index, input: `${skipped.join('\0')}\0` });
  }

  /** Commit a built snapshot as GC (parent: the lane's HEAD) and name it
   * `refs/gru/preserved/<lane>/<UTC stamp>` (#427): never a branch or a
   * tag, and no reflog is needed to keep it. GC never deletes the ref. */
  private saveSnapshot(row: WorktreeRecord, built: BuiltSnapshot): SweepSnapshot {
    const sha = runGit(row.path, [
      'commit-tree', '--no-gpg-sign', built.tree, '-p', built.head,
      '-m', `gru: lane ${row.id} uncommitted work, saved before its sweep`,
    ], { gcIdentity: true });
    const stamp = new Date().toISOString().replace(/[-:]/gu, '');
    const ref = `${PRESERVED_REF_PREFIX}/${preservedRefComponent(row.id)}/${stamp}`;
    // An empty old value: the ref must not exist yet (never overwrite one).
    runGit(row.repoPath, ['update-ref', '--no-deref', ref, sha, '']);
    this.log('info', 'uncommitted work saved before the sweep', { id: row.id, ref, sha, files: built.files });
    return { ref, sha, files: built.files };
  }

  /** An aborted release's snapshot (#427), when its ref still names a
   * commit of exactly this tree on this HEAD; else null. */
  private reusableSnapshot(row: WorktreeRecord, built: BuiltSnapshot, aborted: AbortedRelease | null): SweepSnapshot | null {
    const saved = aborted?.snapshot ?? null;
    if (saved === null) return null;
    const named = spawnGit(row.repoPath, ['rev-parse', '--verify', '--quiet', `${saved.ref}^{commit}`]).stdout.trim();
    if (named !== saved.sha) return null;
    const parsed = spawnGit(row.repoPath, ['rev-parse', `${saved.sha}^{tree}`, `${saved.sha}^1`]).stdout.trim().split('\n');
    if (parsed[0] !== built.tree || parsed[1] !== built.head) return null;
    this.log('info', 'uncommitted work unchanged since an aborted release; its snapshot is reused', { id: row.id, ref: saved.ref });
    return { ref: saved.ref, sha: saved.sha, files: built.files };
  }

  /** The lane's newest `worktree.release-aborted` (#427), or null. */
  private abortedRelease(row: WorktreeRecord): AbortedRelease | null {
    let payload: { readonly preserved?: unknown; readonly snapshot?: unknown; readonly discarded?: unknown } | null;
    try {
      payload = (this.opts.ledger.latestEventByPayloadField('worktree.release-aborted', 'id', row.id)?.payload ?? null) as typeof payload;
    } catch (error) {
      this.log('warn', 'the lane\'s aborted releases could not be read; nothing of theirs is reused', { id: row.id, error: String(error) });
      return null;
    }
    if (payload === null) return null;
    const preserved = payload.preserved as { readonly destination?: unknown; readonly files?: unknown } | null | undefined;
    const snapshot = payload.snapshot as { readonly ref?: unknown; readonly sha?: unknown } | null | undefined;
    return {
      preserved: typeof preserved?.destination === 'string' && typeof preserved.files === 'number' ? { destination: preserved.destination, count: preserved.files } : null,
      snapshot: typeof snapshot?.ref === 'string' && typeof snapshot.sha === 'string' ? { ref: snapshot.ref, sha: snapshot.sha } : null,
      discarded: typeof payload.discarded === 'string' ? payload.discarded : null,
    };
  }

  /** A release that failed after its records (#427): `worktree.release-
   * aborted { id, path, preserved, snapshot, discarded, error }` names the
   * preserve folder and any snapshot ref already written, once per change
   * of them (a retry that reused both and failed again adds no row). */
  private recordAbortedRelease(row: WorktreeRecord, saved: { readonly preserved: SweepPreservation | null; readonly snapshot: SweepSnapshot | null; readonly discarded: string | null }, error: unknown): void {
    const preserved = saved.preserved === null ? null : { destination: saved.preserved.destination, files: saved.preserved.count };
    const snapshot = saved.snapshot === null ? null : { ref: saved.snapshot.ref, sha: saved.snapshot.sha };
    const detail = oneLineErrorText(error instanceof Error ? error.message : error, 400);
    this.log('error', 'release aborted after its records; the tree is retained and a retry reuses what was saved', { id: row.id, preserved, snapshot, error: detail });
    try {
      const last = this.abortedRelease(row);
      if (last !== null && last.preserved?.destination === preserved?.destination && last.snapshot?.ref === snapshot?.ref && last.discarded === saved.discarded) return;
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.release-aborted',
        jobId: row.jobId,
        roundId: row.roundId,
        payload: { id: row.id, path: row.path, preserved, snapshot, discarded: saved.discarded, error: detail },
      });
    } catch (eventError) {
      this.log('error', 'worktree.release-aborted event write failed', { id: row.id, error: String(eventError) });
    }
  }

  /** The registry follows disk truth for a removed-but-unflipped lane —
   * INCLUDING the branch (Perkins lane-B r3): the same
   * containment-verified disposal finishSweep runs. Abandoning the
   * branch here left merged lanes unreusable ('branch already exists')
   * behind a swept row that early-returns forever. Returns the true
   * branch outcome for the release response. */
  private reconcileMissingTree(
    row: WorktreeRecord,
    baseBranch: string | undefined,
  ): { readonly branch: 'deleted' | 'retained' | 'none'; readonly freshHead: string } {
    assertLaneResourcesAbsent(row);
    this.log('warn', 'worktree tree missing under a non-swept row — reconciling swept', {
      id: row.id,
      path: row.path,
      status: row.status,
    });
    // DISPOSE FIRST, flip second (Perkins lane-B r4: mirror finishSweep —
    // flipping first re-opened the r3 wedge silently: a crash between the
    // flip and the disposal left every retry early-returning 'none').
    // The disposal resolves FRESH remote state first (Perkins r8): a
    // retry must never delete on the witness of stale tracking refs.
    const remote = this.safeFreshRemoteBranch(row.repoPath);
    assertLaneResourcesAbsent(row);
    const branchOutcome = this.disposeLaneBranch(row, baseBranch, remote);
    const freshHead = this.safeFreshHead(row.repoPath);
    assertLaneResourcesAbsent(row);
    try {
      this.opts.ledger.setWorktreeStatus(row.id, 'swept');
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.reconciled',
        jobId: row.jobId,
        roundId: row.roundId,
        payload: { id: row.id, path: row.path, priorStatus: row.status, branch: branchOutcome },
      });
    } catch (error) {
      this.log('error', 'reconciliation write failed — retry will reconcile again', {
        id: row.id,
        error: String(error),
      });
    }
    try {
      this.opts.onSwept?.({ worktree: row });
    } catch (error) {
      this.log('warn', 'sweep-completion notice resolution failed', { id: row.id, error: String(error) });
    }
    return { branch: branchOutcome, freshHead };
  }

  /** Guarded containment-verified disposal for an owner lane's branch.
   * Shared by the reconcile and the swept-heal paths; a disposal failure
   * never throws — it is logged and recorded loudly (the branch survives
   * and a later retry heals). */
  private disposeLaneBranch(
    row: WorktreeRecord,
    baseBranch: string | undefined,
    freshRemoteBranch: string | null,
  ): 'deleted' | 'retained' | 'none' {
    if ((row.kind !== 'job' && row.kind !== 'child') || row.branch === null) return 'none';
    try {
      return this.deleteBranchContained(row, baseBranch, freshRemoteBranch);
    } catch (error) {
      this.log('error', 'lane branch disposal failed — recorded for retry', {
        id: row.id,
        error: String(error),
      });
      try {
        this.opts.ledger.appendCustomEvent({
          kind: 'worktree.sweep-tail-failed',
          jobId: row.jobId,
          roundId: row.roundId,
          payload: { id: row.id, error: String(error) },
        });
      } catch (eventError) {
        this.log('error', 'sweep-tail-failed event write failed during disposal', {
          id: row.id,
          error: String(eventError),
        });
      }
      return 'none';
    }
  }

  private safeFreshHead(repoPath: string): string {
    try {
      return this.freshHead(repoPath);
    } catch {
      return '';
    }
  }

  /** The remote default branch FRESHLY VERIFIED for a disposal decision
   * (Perkins r8): resolveBase with a successful, verified fetch names the
   * one remote ref this decision may trust as a containment witness; a
   * fetch failure, an unverified default, or any resolution error yields
   * null — stale tracking refs then witness nothing. Never throws. */
  private safeFreshRemoteBranch(repoPath: string): string | null {
    try {
      const base = this.resolveBase(repoPath);
      return base.baseSource === 'origin' ? base.defaultBranch : null;
    } catch {
      return null;
    }
  }

  /** Best-effort sweep events (Perkins lane-B r2): a ledger hiccup after
   * the flip must never wedge the sweep — each write is guarded. */
  private recordSweepEvent(
    row: WorktreeRecord,
    preserved: SweepPreservation | null,
    branchOutcome: 'deleted' | 'retained' | 'none',
    freshHead: string,
    snapshot: SweepSnapshot | null,
  ): void {
    if (this.tailFailure !== null) {
      try {
        this.opts.ledger.appendCustomEvent({
          kind: 'worktree.sweep-tail-failed',
          jobId: row.jobId,
          roundId: row.roundId,
          payload: { id: row.id, error: this.tailFailure },
        });
      } catch (eventError) {
        this.log('error', 'sweep-tail-failed event write failed', { id: row.id, error: String(eventError) });
      }
      this.tailFailure = null;
    }
    try {
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.swept',
        jobId: row.jobId,
        roundId: row.roundId,
        payload: {
          id: row.id,
          path: row.path,
          preserved: preserved === null ? 0 : preserved.count,
          branch: branchOutcome,
          freshHead,
          snapshot,
        },
      });
    } catch (eventError) {
      this.log('error', 'worktree.swept event write failed', { id: row.id, error: String(eventError) });
    }
  }

  /** Containment-verified delete: prove the tip survives in a durable
   * local ref or the freshly verified origin default before deleting.
   * Never use `git branch -d`: it can trust a stale lane upstream. */
  private deleteBranchContained(
    row: WorktreeRecord,
    baseBranch: string | undefined,
    freshRemoteBranch: string | null,
  ): 'deleted' | 'retained' {
    const branch = row.branch as string;
    // Already gone (a healed retry, a prior disposal): disposal is
    // idempotent — never a misleading 'retained' for a missing branch.
    const present = spawnGit(row.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (present.status !== 0) return 'deleted';
    const laneRef = `refs/heads/${branch}`;
    const freshRemoteRef = freshRemoteBranch === null ? null : `refs/remotes/origin/${freshRemoteBranch}`;
    const baseRef = spawnGit(row.repoPath, baseBranch === undefined
      ? ['symbolic-ref', '--quiet', 'HEAD']
      : ['rev-parse', '--symbolic-full-name', '--verify', baseBranch]);
    const base = baseRef.status === 0 ? baseRef.stdout.trim() : '';
    // An explicit base must obey the SAME witness rule, never bypass it
    // with a stale tracking ref, a bare SHA, or the lane itself.
    const durableBase = base !== laneRef && base !== '' && (
      base.startsWith('refs/heads/') || base.startsWith('refs/tags/') || base === freshRemoteRef
    );
    if (durableBase && spawnGit(row.repoPath, ['merge-base', '--is-ancestor', laneRef, base]).status === 0) {
      runGit(row.repoPath, ['branch', '-D', branch]);
      return 'deleted';
    }
    // Detached HEAD or an unresolvable base is not proof of containment;
    // the remaining durable refs can still witness the tip below.
    // The lane's tip must survive in a DURABLE ref — never a stale
    // remote-tracking ref (Perkins r7/r8): after a remote force-push the
    // old tracking ref still names the tip, but it is transient — the
    // next successful fetch of that branch overwrites it, orphaning the
    // tip if the lane branch was deleted on its witness. Durable
    // witnesses: another LOCAL branch or tag (they never move under a
    // fetch), plus the ONE remote ref freshly verified for THIS
    // decision — the default branch this release actually fetched
    // (freshRemoteBranch; null when the fetch failed or the default was
    // unverified). A stale/unverified tracking ref witnesses nothing.
    const branchTip = spawnGit(row.repoPath, ['rev-parse', `refs/heads/${branch}^{commit}`]);
    if (branchTip.status === 0 && branchTip.stdout.trim() !== '') {
      const tip = branchTip.stdout.trim();
      const durableLocal = spawnGit(row.repoPath, [
        'for-each-ref',
        `--contains=${tip}`,
        '--format=%(refname)',
        'refs/heads',
        'refs/tags',
      ]);
      if (durableLocal.status === 0) {
        const others = durableLocal.stdout
          .split('\n')
          .map((name) => name.trim())
          .filter((name) => name !== '' && name !== `refs/heads/${branch}`);
        const freshRemoteWitness =
          freshRemoteBranch !== null &&
          spawnGit(row.repoPath, [
            'merge-base',
            '--is-ancestor',
            tip,
            `refs/remotes/origin/${freshRemoteBranch}`,
          ]).status === 0;
        if (others.length > 0 || freshRemoteWitness) {
          runGit(row.repoPath, ['branch', '-D', branch]);
          return 'deleted';
        }
      }
    }
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.branch-retained',
      jobId: row.jobId,
      payload: {
        id: row.id,
        branch,
        reason:
          'tip not contained in any durable local or freshly verified remote ref (remote force-pushed?); retained to preserve the commits',
      },
    });
    this.opts.ledger.noteWorktree(
      row.id,
      `branch ${branch} retained: no durable local or freshly verified remote ref contains the tip`,
    );
    this.log('warn', 'worktree branch retained (no surviving ref for the tip)', {
      id: row.id,
      branch,
    });
    return 'retained';
  }
}

/** Lanes slimming may reclaim (#427): job lanes and writer-child lanes
 * (those carry a branch). Review and read-only child lanes hold only
 * committed bytes. */
function writerLane(row: WorktreeRecord): boolean {
  return row.kind === 'job' || (row.kind === 'child' && row.branch !== null);
}

/** What a reclaim entry's on-disk checks say (#427): null when it is
 * missing (skipped silently), the reason it is skipped by name, or its
 * size when it may be deleted (what deleting it frees, and what it holds
 * that stays linked from outside it). */
async function reclaimVerdict(lanePath: string, entry: string): Promise<string | { readonly bytes: number; readonly sharedBytes: number } | null> {
  const linked = 'it is, or lies under, a link';
  const state = await reclaimState(lanePath, entry);
  if (state === 'absent') return null;
  if (state === 'link') return linked;
  const tracked = await reclaimTrackedFiles(lanePath, entry);
  if (tracked === 'link') return linked;
  if (tracked > 0) return `git tracks ${tracked} file(s) under it`;
  const ignored = await reclaimIgnored(lanePath, entry);
  if (ignored === 'link') return linked;
  if (!ignored) return 'git does not ignore it';
  return treeUsage(join(lanePath, entry));
}

/** A manifest `[[link]]` `at` or `[[copy]]` `to` in the form of a reclaim
 * entry (`./a/b/` → `a/b`). */
function normalizedManifestPath(path: string): string {
  return path.trim().split(/[\\/]/u).filter((segment) => segment !== '' && segment !== '.').join('/');
}

/** A lane's newest `worktree.slimmed` as its restore reads it (#427): the
 * manifest blob to run (null for a slim recorded before slims named one)
 * and the entries it deleted. */
function slimRecord(event: { readonly payload: unknown } | null): { readonly blob: string | null; readonly entries: readonly string[] } {
  const payload = (event?.payload ?? null) as { readonly manifest?: unknown; readonly entries?: unknown } | null;
  const blob = payload?.manifest;
  const entries = payload?.entries;
  if (!Array.isArray(entries) || (blob !== undefined && (typeof blob !== 'string' || !/^[0-9a-f]{40,64}$/u.test(blob)))) {
    throw new Error('the lane\'s worktree.slimmed record names no entries or a malformed manifest blob, so its restore cannot run');
  }
  return {
    blob: typeof blob === 'string' ? blob : null,
    entries: entries.map((entry) => String((entry as { readonly path?: unknown } | null)?.path ?? '')).filter((entry) => entry !== ''),
  };
}

/** The base manifest says something that cannot change (#427): it is not a
 * file, or it does not parse. A slim refused for it is refused for good. */
class BaseManifestContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaseManifestContentError';
  }
}

/** Gitlinks (mode 160000) by path, from `ls-tree -r -z` (`<mode> commit
 * <sha>\t<path>`) or `ls-files -s -z` (`<mode> <sha> <stage>\t<path>`). */
function gitlinks(listing: string, from: 'tree' | 'index'): Map<string, string> {
  const links = new Map<string, string>();
  for (const entry of listing.split('\0')) {
    if (!entry.startsWith('160000 ')) continue;
    const tab = entry.indexOf('\t');
    const fields = entry.slice(0, tab).split(' ');
    const sha = from === 'tree' ? fields[2] : fields[1];
    if (tab !== -1 && sha !== undefined) links.set(entry.slice(tab + 1), sha);
  }
  return links;
}

/** Whether a submodule commit outlives the lane (#427): one of the remote-
 * tracking refs or tags of the lane's copy contains it, or the main
 * checkout's own copy has it. A commit the lane's copy lacks is not the
 * lane's to lose. */
function submoduleCommitSurvives(gitDir: string, mainCopy: string, commit: string): boolean {
  if (spawnGit(gitDir, ['--git-dir', gitDir, 'cat-file', '-e', `${commit}^{commit}`]).status !== 0) return true;
  if (runGit(gitDir, ['--git-dir', gitDir, 'for-each-ref', '--count=1', '--contains', commit, '--format=%(refname)', 'refs/remotes', 'refs/tags']) !== '') return true;
  return existsSync(mainCopy) && spawnGit(mainCopy, ['--git-dir', mainCopy, 'cat-file', '-e', `${commit}^{commit}`]).status === 0;
}

/** The commits a submodule copy holds beyond its HEAD (#427): the tip of
 * each local branch, and each stash entry, named for the refusal. */
function submoduleLocalCommits(gitDir: string): (readonly [string, string])[] {
  const commits: (readonly [string, string])[] = [];
  for (const line of spawnGit(gitDir, ['--git-dir', gitDir, 'for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads']).stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) commits.push([line.slice(0, space), `branch ${line.slice(space + 1)}`]);
  }
  const stash = spawnGit(gitDir, ['--git-dir', gitDir, 'log', '-g', '--format=%H', 'refs/stash', '--']);
  if (stash.status === 0) stash.stdout.split('\n').filter((sha) => sha !== '').forEach((sha, index) => commits.push([sha, `stash@{${String(index)}}`]));
  return commits;
}

/** Whether `git diff --cached --raw -z` shows a gitlink (mode 160000) on
 * either side: an embedded repository staged with no `.gitmodules`. */
function stagedGitlink(raw: string): boolean {
  return raw.split('\0').some((field) => /^:\d{6} \d{6} /u.test(field) && (field.slice(1, 7) === '160000' || field.slice(8, 14) === '160000'));
}

/** `submodule.<name>.<key> = value` triples (path and ignore) from a
 * `.gitmodules` (`--blob <rev>:.gitmodules` or `--file .gitmodules`); none
 * when it is missing or names no submodule. */
function gitmodulesEntries(lanePath: string, source: readonly string[]): (readonly [string, string, string])[] {
  const listed = spawnGit(lanePath, ['config', ...source, '-z', '--get-regexp', '^submodule\\..*\\.(path|ignore)$']);
  if (listed.status !== 0) return [];
  const entries: (readonly [string, string, string])[] = [];
  for (const entry of listed.stdout.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline === -1) continue;
    const key = entry.slice(0, newline);
    const dot = key.lastIndexOf('.');
    entries.push([key.slice('submodule.'.length, dot), key.slice(dot + 1), entry.slice(newline + 1)]);
  }
  return entries;
}

/** What a submodule refusal showed, as the digest a discard must carry
 * (#427): each submodule's path, states and HEAD, and the fingerprint of
 * its content and commits. */
function submoduleWorkDigest(work: readonly SubmoduleWork[], fingerprints: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(work.map(({ path, state, head }, index) => [path, state, head, fingerprints[index] ?? '']))).digest('hex').slice(0, 16);
}

/** The untracked paths in `git status --porcelain -z` output. */
function porcelainUntracked(status: string): string[] {
  return status.split('\0').filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3)).filter((rel) => rel !== '');
}

/** Whether something (a link included, never followed) is at a path. */
function pathOnDisk(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The file git names in an error it printed while indexing (an unreadable
 * file), or null. */
function gitNamedFile(message: string): string | null {
  return /unable to index file '([^']+)'/u.exec(message)?.[1] ?? /open\("([^"]+)"\)/u.exec(message)?.[1] ?? null;
}

/** The bytes and links under paths of a tree, as one hash (#427): each
 * file's content and each link's target, by its path below `root`, never
 * following a link. `rels` null: everything under `root`. */
function contentFingerprint(root: string, rels: readonly string[] | null): string {
  const entries = new Set<string>();
  const visit = (rel: string): void => {
    const path = join(root, rel);
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) entries.add(`${rel}\0link\0${readlinkSync(path)}`);
    else if (stat.isDirectory()) for (const name of readdirSync(path)) visit(rel === '' ? name : `${rel}/${name}`);
    else entries.add(`${rel}\0file\0${fileHash(path)}`);
  };
  if (rels === null) visit('');
  else for (const rel of rels) visit(rel.replace(/\/+$/u, ''));
  return createHash('sha256').update([...entries].sort().join('\0\0')).digest('hex');
}

/** A file's sha256, read in chunks. */
function fileHash(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** The reclaim entries present (not absent, not under a link) in a lane. */
async function presentReclaimEntries(lanePath: string, entries: readonly string[]): Promise<Set<string>> {
  const present = new Set<string>();
  for (const entry of entries) if ((await reclaimState(lanePath, entry)) === 'present') present.add(entry);
  return present;
}

/** What a lane's bootstrap or restore made (#427): the manifest blob it
 * ran and the reclaim entries setup made. */
interface LaneBootstrap {
  readonly blob: string | null;
  readonly setupMade: readonly string[];
}

/** `worktree.rehydrate-failed`'s `reason` when setup succeeded but did not
 * recreate what it made at bootstrap (#427). */
const SETUP_INCOMPLETE = 'setup-incomplete';

/** Bytes of a failed restore's error kept on the record (#427). */
const RESTORE_ERROR_TAIL_BYTES = 4 * 1024;

/** A failed restore's error as recorded, at most 4 KiB, redacted before
 * any cut. A setup command's failure is its reason line (redacted, then cut
 * to one line) and its output tail cut from the raw streams as the
 * onboarding proof cuts it ({@link recordedTail}): each stream redacted
 * whole, then from a line start, or of one longer line its last words
 * marked as starting mid-line, or with no word to start at a note that the
 * line is not shown; a stream whose dropped start ended mid-line loses that
 * first line (or, with no line break, is only noted as cut), so no fragment
 * of a token is ever kept. Any other error: redacted whole (a key whose
 * BEGIN line was cut off is masked too), then its last 4 KiB the same way
 * ({@link boundedTail}). */
function restoreErrorText(error: unknown): string {
  if (error instanceof WorktreeSetupError) {
    const at = error.message.indexOf('\noutput tail:\n');
    const reason = oneLineErrorText(redactCredentialWindow(at === -1 ? error.message : error.message.slice(0, at)), 400);
    const header = `${reason}\noutput tail:\n`;
    return `${header}${recordedTail([error.output.stdout, error.output.stderr], RESTORE_ERROR_TAIL_BYTES - Buffer.byteLength(header, 'utf8'))}`;
  }
  return boundedTail(redactCredentialWindow(error instanceof Error ? error.message : String(error)), RESTORE_ERROR_TAIL_BYTES);
}

/** The owner's FYI for a release that saved a lane's work (#427): a board
 * row, never FOR YOU, naming the lane and job and what was saved: the
 * snapshot's ref, its count of tracked files and the command that applies
 * it (the repository path and the ref shell-quoted), and the preserve
 * folder with its count of untracked files. One per release: its id is the
 * ref, or the preserve folder when there is no snapshot. */
export function sweepWorkNotice(input: SavedWork): {
  readonly id: string;
  readonly kind: 'worktree-work-saved';
  readonly routing: 'fyi';
  readonly severity: 'info';
  readonly title: string;
  readonly detail: string;
} {
  const { worktree, snapshot, preserved } = input;
  const lane = `Lane ${worktree.id} (job ${worktree.jobId ?? 'none'})`;
  const parts = snapshot === null
    ? [`${lane} was released with ${String(preserved?.count ?? 0)} untracked file(s), copied to ${preserved?.destination ?? '(nowhere)'}.`]
    : [
      `${lane} was released with ${String(snapshot.files)} tracked file(s) changed and not committed. They are saved at ${snapshot.ref} (commit ${snapshot.sha}).`,
      ...(preserved === null ? [] : [`Its ${String(preserved.count)} untracked file(s) were copied to ${preserved.destination}.`]),
      `To apply the tracked changes to a checkout: git -C ${shellWord(worktree.repoPath)} cherry-pick --no-commit ${shellWord(snapshot.ref)}`,
    ];
  return {
    id: snapshot === null ? `worktree-preserved:${preserved?.destination ?? worktree.id}` : `worktree-snapshot:${snapshot.ref}`,
    kind: 'worktree-work-saved',
    routing: 'fyi',
    severity: 'info',
    title: `Uncommitted minion work saved from lane ${worktree.id} (${worktree.repoName})`,
    detail: parts.join(' '),
  };
}

/** Gru's row for a release refused over submodule work (#427): one per
 * lane and digest (its id), naming each submodule and what it holds, what
 * to do, and the digest. The lane's release closes it. */
export function submoduleWorkNotice(input: { readonly worktree: WorktreeRecord; readonly submodules: readonly SubmoduleWork[]; readonly digest: string }): {
  readonly id: string;
  readonly kind: typeof SUBMODULE_WORK_NOTICE_KIND;
  readonly routing: 'action-required';
  readonly severity: 'error';
  readonly title: string;
  readonly detail: string;
} {
  const { worktree, submodules, digest } = input;
  return {
    id: submoduleWorkNoticeId(worktree.id, digest),
    kind: SUBMODULE_WORK_NOTICE_KIND,
    routing: 'action-required',
    severity: 'error',
    title: `Lane ${worktree.id} (${worktree.repoName}) cannot be released: its submodule work would be lost`,
    detail:
      `Lane ${worktree.id} (job ${worktree.jobId ?? 'none'}) holds submodule work its removal would destroy: ` +
      `${submodules.map((sub) => `${sub.path}: ${sub.state.join(', ')}`).join('; ')}. ` +
      'Tell the minion to push the submodule commit (git push inside the submodule) and to commit and push modified content inside each submodule, then release the lane again; ' +
      `or ask the owner to discard exactly this work with an operator release that passes discard_submodule_work: "${digest}". Digest: ${digest}.`,
  };
}

/** The kind of {@link submoduleWorkNotice}'s rows. */
export const SUBMODULE_WORK_NOTICE_KIND = 'worktree.submodule-work';

/** The id of a lane's submodule-work row for one digest. */
export function submoduleWorkNoticeId(laneId: string, digest: string): string {
  return `worktree-submodule-work:${laneId}:${digest}`;
}

/** Gru's row for a lane whose restore ran setup and did not get back what
 * setup made at bootstrap (#427): one per lane (its id). The lane stays
 * slim and is never slimmed again; its release closes the row. */
export function restoreIncompleteNotice(input: { readonly worktree: WorktreeRecord; readonly missing: readonly string[] }): {
  readonly id: string;
  readonly kind: typeof RESTORE_INCOMPLETE_NOTICE_KIND;
  readonly routing: 'action-required';
  readonly severity: 'error';
  readonly title: string;
  readonly detail: string;
} {
  const { worktree, missing } = input;
  return {
    id: restoreIncompleteNoticeId(worktree.id),
    kind: RESTORE_INCOMPLETE_NOTICE_KIND,
    routing: 'action-required',
    severity: 'error',
    title: `Lane ${worktree.id} (${worktree.repoName}): its setup did not recreate ${missing.join(', ')}`,
    detail:
      `A restore of lane ${worktree.id} (job ${worktree.jobId ?? 'none'}) before a minion turn or verification ran the manifest's [[setup]], which succeeded but did not recreate ` +
      `${missing.join(', ')}, although setup made ${missing.length === 1 ? 'it' : 'them'} when the lane was built. A likely cause is a stamp file outside reclaim that makes setup think its work is done. ` +
      'The lane stays slim (each turn runs setup again) and is never slimmed again. Tell the minion to rebuild what is missing, and fix the manifest (list the stamp file under reclaim, or make setup check what it makes).',
  };
}

/** The kind of {@link restoreIncompleteNotice}'s rows. */
export const RESTORE_INCOMPLETE_NOTICE_KIND = 'worktree.restore-incomplete';

/** The id of a lane's restore-incomplete row. */
export function restoreIncompleteNoticeId(laneId: string): string {
  return `worktree-restore-incomplete:${laneId}`;
}

/** A word a POSIX shell reads back as itself: as it is when it holds only
 * characters no shell treats specially, else single-quoted. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`;
}

/** A lane id as one ref-name component: as it is when git accepts it there,
 * else hex-encoded (a job's lane id already names its `gru/<id>` branch). */
function preservedRefComponent(id: string): string {
  const plain = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(id) && !id.includes('..') && !id.endsWith('.lock') && !id.endsWith('.');
  return plain ? id : `x-${Buffer.from(id, 'utf8').toString('hex')}`;
}

/** Directory sanity for option wiring (fail loud at boot, not mid-heist). */
export function ensureDirectoryEmptyOrMissing(path: string): boolean {
  if (!existsSync(path)) return true;
  return readdirSync(path).length === 0;
}
