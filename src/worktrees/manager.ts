import { readWorktreeMetadata, repositoryCommonDirectory, capturePortLaneHandoff, captureCwdHandoff, beginLaneHandoff, completeLaneHandoff, rememberManagedLane, registerHandoffManager, assertPendingLaneHandoff, captureCleanupHandoff, assertLaneResourcesAbsent, WorktreeHandoffUnresolvedError, prepareLaneRebind, publishLaneRebind, settleLaneRebind, laneReceiptStale } from './handoff.js';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
  utimesSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import {
  copyFile as copyFileAsync,
  cp as cpAsync,
  lstat as lstatAsync,
  mkdir as mkdirAsync,
  mkdtemp as mkdtempAsync,
  readdir as readdirAsync,
  readlink as readlinkAsync,
  rm as rmAsync,
  symlink as symlinkAsync,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { LedgerApi, WorktreeBaseSource, WorktreeRecord } from '../ledger/api.js';
import { applyWorktreeManifest, loadWorktreeManifest, MANIFEST_PATH, parseWorktreeManifest, WorktreeSetupError, type WorktreeManifest } from './manifest.js';
import { reclaimIgnored, reclaimState, reclaimTrackedFiles, removeTree, treeUsage } from './reclaim.js';
import { redactedText } from '../decisions/questions.js';
import { boundedTail, recordedTail, redactCredentialWindow } from '../redaction.js';
import { oneLineErrorText } from '../property/error-text.js';
import { repositoryGitEnv } from '../dispatch/perkins-review/artifacts.js';
import type { ManagedRepoPath } from '../repos/managed-names.js';

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
        `${staleDiscard === null ? '' : ` (the discard named ${staleDiscard}, which is not the work the lane holds now: ${SUBMODULE_WORK_CHANGING})`}; the tree is retained`,
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
 * verify makes them), and any whose cut-short delete could not be finished. */
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
  readonly snapshot: SweepSnapshot | null;
  readonly discarded: string | null;
}

/** What the nested-repository check found (#427): the work a removal
 * would destroy, its digest, and the untracked files of the nested
 * repositories (by their paths in the lane) that the preserve copy takes. */
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
  /** A release was refused for submodule work (#427): called at every
   * refusal, so Gru hears about it ({@link submoduleWorkNotice}, one row per
   * lane and digest). `previousDigest`: the lane's earlier refusal this one
   * supersedes, when the digest changed. `staleDiscard`: the digest an
   * operator's discard named, when the work changed since. */
  readonly onSubmoduleWorkRefused?: (input: {
    readonly worktree: WorktreeRecord;
    readonly submodules: readonly SubmoduleWork[];
    readonly digest: string;
    readonly previousDigest: string | null;
    readonly staleDiscard: string | null;
  }) => void;
  /** A release was refused because the lane is a sparse checkout (#427):
   * called at every refusal, so Gru hears about it
   * ({@link sparseCheckoutNotice}, one row per lane). */
  readonly onSparseCheckoutRefused?: (input: { readonly worktree: WorktreeRecord }) => void;
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

/** A repository's identity (#427 PR 2b): its root commits and its
 * `origin` URL (null when it has none). Two places hold the same repository
 * when they share a root commit and, when both have one, their origin. */
export interface RepoIdentity {
  readonly roots: readonly string[];
  readonly origin: string | null;
}

/** The record of the repository a lane was made in (#427 PR 2b):
 * `worktree.repo-identity { id, repo_path, roots, origin }`, written when the
 * lane is created and by a moved-repository check that finds a lane's
 * repository with none for its place. */
export const REPO_IDENTITY_EVENT = 'worktree.repo-identity';

/** What the moved-repository check found for one lane (#427 PR 2b):
 * repaired (its registry `repo_path` moved from `from` to `to`), a
 * different repository under its name (`candidate`: the caller proposes the
 * discard), or not judged now (`reason`, judged again at the next check). */
export type RepoMoveOutcome =
  | { readonly status: 'repaired'; readonly lane: WorktreeRecord; readonly from: string; readonly to: string }
  | { readonly status: 'mismatch'; readonly lane: WorktreeRecord; readonly candidate: string; readonly reason: string }
  | { readonly status: 'unresolved'; readonly lane: WorktreeRecord; readonly reason: string }
  /** Its administration changed with no move of its repository to explain
   * it: nothing is re-bound or recorded, and its custody stays refused. */
  | { readonly status: 'tampered'; readonly lane: WorktreeRecord; readonly reason: string };

/** The lanes one moved-repository check repairs at most (#427 PR 2b): the
 * check runs on the event loop, so the rest wait for the next check. */
export const MOVED_LANES_PER_CHECK = 100;

/** What one moved-repository check reads once (#427 PR 2b): each
 * candidate's identity (its root set), and the root commits of a base
 * commit in a candidate (`<candidate>\0<sha>`), and how many lanes it
 * repaired so far. */
interface MoveCheckCache {
  readonly identities: Map<string, RepoIdentity | { readonly error: unknown }>;
  readonly baseRoots: Map<string, BaseRoots>;
  repairs: number;
}

/** A lane's base commit in a candidate: its root commits, missing there,
 * or a git failure. */
type BaseRoots = { readonly roots: readonly string[] } | { readonly missing: true } | { readonly error: unknown };

/** Whether a candidate holds the lane's repository: `same` (by its base
 * commit's roots only when the lane has no recorded identity), or
 * `different` or `unknown` (a git failure, never a mismatch), with the
 * reason. */
type RepositoryVerdict =
  | { readonly kind: 'same'; readonly byBaseOnly: boolean }
  | { readonly kind: 'different' | 'unknown'; readonly reason: string };

/** How an owner's discard of a lane whose repository is not there ended
 * (#427 PR 2b): discarded, or not, because the lane is swept or gone,
 * because it reaches its repository again, or because it is kept for now
 * (processes run in it, or its folder is not a real one under the lanes
 * root), with the reason. */
export type LaneDiscard = 'discarded' | 'gone' | 'reconnected' | { readonly kept: string };

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

/** {@link runGit} off the event loop (#427), for git whose cost grows with
 * the tree (a full checkout, a listing of what a removal left). Resolves with
 * stdout as git printed it (untrimmed); rejects as runGit throws. */
function runGitAsync(repoPath: string, args: readonly string[], opts: Pick<SpawnGitOptions, 'indexFile' | 'input' | 'maxBuffer'> = {}): Promise<string> {
  return new Promise((resolveOut, reject) => {
    const child = execFile('git', [...args], {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      env: { ...repositoryGitEnv(false), ...(opts.indexFile !== undefined ? { GIT_INDEX_FILE: opts.indexFile } : {}) },
    }, (error, stdout, stderr) => {
      if (error === null) resolveOut(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (exit ${String(error.code ?? error.signal)}) in ${repoPath}: ${stderr.trim() || error.message}`));
    });
    child.stdin?.on('error', reject);
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
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
  /** Why each lane the moved-repository check could not judge was not
   * judged, logged once per change (#427 PR 2b). */
  private readonly moveNotes = new Map<string, string>();
  /** Released lanes found `different` from their name's repository, by
   * the candidate and its identity: not judged again while it holds the
   * same repository (#427 PR 2b). */
  private readonly sweptDifferent = new Map<string, string>();

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
        bootstrapped = await this.bootstrap(repo.repoPath, path, custody.sha);
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
      this.recordRepoIdentity(record);
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
      this.recordRepoIdentity(record);
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
        if (input.authority === 'writer') bootstrapped = await this.bootstrap(repo.repoPath, path, custody.sha);
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
      this.recordRepoIdentity(record);
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
  private async bootstrap(sourceRoot: string, worktreePath: string, sha: string): Promise<LaneBootstrap | null> {
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
    // The blob at the commit the lane was made from, read in the source
    // checkout: git in the lane reads its HEAD and refs, which only the
    // creation's custody proof, after this, may touch (GH-270).
    const blob = spawnGit(sourceRoot, ['rev-parse', '--verify', '--quiet', `${sha}:${MANIFEST_PATH}`]).stdout.trim();
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

  /**
   * Moved repositories (#427 PR 2b), at service start and at the hourly
   * maintenance reconcile. A lane (active or paused, its folder on disk)
   * whose git link no longer reaches the repository at its registry
   * `repo_path` is matched with the managed repository of the same name,
   * resolved now. They are the same repository when the root commits of all
   * their refs overlap and, when both have one, their `origin` URLs are the
   * same once normalised ({@link sameOriginUrl}). The lane's side is its
   * `worktree.repo-identity`; a lane made before identities were recorded,
   * whose repository is already gone, has only its base commit (the
   * registry's `sha`), whose roots are read in the candidate, and no origin
   * to compare (logged). The same repository is repaired
   * ({@link repairMovedLane}); a different one is a `mismatch`, for the
   * caller's discard proposal. A lane that cannot be judged now (no managed
   * repository of that name, an unavailable one, a git failure) is
   * `unresolved`: nothing changes, the reason is logged once, and the next
   * check judges it again.
   *
   * A lane whose link works records its repository's identity when none
   * names that place, finishes a rebinding a stop interrupted, and is
   * re-bound when its handoff names other paths than the ones its link
   * reaches as the filesystem resolves them: the repository moved with a
   * link left at its old place, or its own git directory moved. An
   * administration that changed with no such move to explain it is
   * `tampered`. Each repository's identity, and each base commit's roots,
   * are read once per check; at most {@link MOVED_LANES_PER_CHECK} lanes are
   * repaired per check (it runs on the event loop), the rest at the next.
   * Released lanes follow at {@link followSweptLanes}.
   */
  checkMovedRepositories(input: {
    readonly managedRepos: readonly string[];
    readonly resolve: (name: string) => ManagedRepoPath;
  }): readonly RepoMoveOutcome[] {
    const outcomes: RepoMoveOutcome[] = [];
    const cache: MoveCheckCache = { identities: new Map(), baseRoots: new Map(), repairs: 0 };
    for (const row of this.opts.ledger.listWorktrees()) {
      if (row.status === 'swept' || !existsSync(row.path)) continue;
      let outcome: RepoMoveOutcome | null;
      try {
        outcome = this.checkMovedLane(row, input, cache);
      } catch (error) {
        outcome = { status: 'unresolved', lane: row, reason: `the check failed: ${oneLineErrorText(error instanceof Error ? error.message : error, 400)}` };
      }
      if (outcome === null) {
        this.moveNotes.delete(row.id);
        continue;
      }
      if (outcome.status !== 'repaired') {
        const note = outcome.status === 'mismatch' ? `mismatch: ${outcome.candidate}: ${outcome.reason}` : `${outcome.status}: ${outcome.reason}`;
        if (this.moveNotes.get(row.id) !== note) {
          this.moveNotes.set(row.id, note);
          this.log('warn', outcome.status === 'mismatch'
            ? 'a lane\'s repository is gone and the managed repository of its name is a different repository'
            : outcome.status === 'tampered'
              ? 'a lane\'s git administration changed with no move of its repository to explain it: it is not re-bound and its custody stays refused'
              : 'a lane\'s repository is gone and the lane cannot be reconnected now; the next check tries again', {
            id: row.id, repo_path: row.repoPath, ...(outcome.status === 'mismatch' ? { candidate: outcome.candidate } : {}), reason: outcome.reason,
          });
        }
      } else {
        this.moveNotes.delete(row.id);
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private checkMovedLane(row: WorktreeRecord, input: {
    readonly managedRepos: readonly string[];
    readonly resolve: (name: string) => ManagedRepoPath;
  }, cache: MoveCheckCache): RepoMoveOutcome | null {
    const deferred = (): RepoMoveOutcome => ({ status: 'unresolved', lane: row, reason: `this check repaired ${String(MOVED_LANES_PER_CHECK)} lanes already; the next check repairs this one` });
    if (laneReachesRepository(row.path, row.repoPath)) {
      if (settleLaneRebind(row, this.opts.ledger)) {
        this.log('info', 'a moved lane\'s re-bound handoff receipt was published after an interrupted repair', { id: row.id });
      }
      if (laneReceiptStale(row)) {
        // The link reaches the repository only through a link left at its
        // old place, or its own git directory moved: the lane follows the
        // managed repository of its name when that is the same place.
        const resolved = input.managedRepos.includes(row.repoName) ? input.resolve(row.repoName) : null;
        const candidate = resolved?.kind === 'available' && samePlace(resolved.path, row.repoPath) ? resolved.path : row.repoPath;
        return cache.repairs >= MOVED_LANES_PER_CHECK ? deferred() : this.repairMovedLane(row, candidate, cache, true);
      }
      this.recordRepoIdentity(row, cache);
      return null;
    }
    if (!input.managedRepos.includes(row.repoName)) {
      return { status: 'unresolved', lane: row, reason: `its git link does not reach ${row.repoPath}, and ${row.repoName} is not a managed repository` };
    }
    const resolved = input.resolve(row.repoName);
    if (resolved.kind !== 'available') {
      return { status: 'unresolved', lane: row, reason: `its git link does not reach ${row.repoPath}, and the managed repository ${row.repoName} cannot be used: ${resolved.kind === 'unavailable' ? resolved.reason : resolved.error}` };
    }
    const verdict = this.sameRepository(row, resolved.path, cache);
    if (verdict.kind !== 'same') {
      return verdict.kind === 'unknown'
        ? { status: 'unresolved', lane: row, reason: verdict.reason }
        : { status: 'mismatch', lane: row, candidate: resolved.path, reason: verdict.reason };
    }
    if (verdict.byBaseOnly) {
      this.log('info', 'a lane made before repository identities were recorded was matched by its base commit\'s root commits only: its repository was already gone, so no origin could be compared', { id: row.id, repo_path: row.repoPath, candidate: resolved.path });
    }
    return cache.repairs >= MOVED_LANES_PER_CHECK ? deferred() : this.repairMovedLane(row, resolved.path, cache, false);
  }

  /**
   * Released lanes follow their repository's move (#427 PR 2b): a swept
   * row whose `repo_path` no longer holds a repository moves to the managed
   * repository of its name when that holds the same one, so expiry still
   * finds its snapshot refs and its card names where they are. Nothing is
   * repaired (the lane has no folder); `worktree.repo-moved` is recorded.
   * Off the event loop: its git runs as child processes awaited, each
   * repository's identity and each base commit's roots are read once per
   * call, and it yields between rows. A row found `different` is not judged
   * again while its candidate holds the same repository.
   */
  async followSweptLanes(input: {
    readonly managedRepos: readonly string[];
    readonly resolve: (name: string) => ManagedRepoPath;
  }): Promise<void> {
    const cache: MoveCheckCache = { identities: new Map(), baseRoots: new Map(), repairs: 0 };
    const present = new Map<string, boolean>();
    const places = new Map<string, ManagedRepoPath>();
    const followed = new Map<string, { readonly from: string; readonly to: string; lanes: number; byBaseOnly: number }>();
    for (const row of this.opts.ledger.listWorktrees()) {
      if (row.status !== 'swept' || !input.managedRepos.includes(row.repoName)) continue;
      if (!present.has(row.repoPath)) present.set(row.repoPath, holdsRepository(row.repoPath));
      if (present.get(row.repoPath) === true) continue;
      try {
        if (!places.has(row.repoName)) places.set(row.repoName, input.resolve(row.repoName));
        const resolved = places.get(row.repoName)!;
        if (resolved.kind !== 'available' || resolved.path === row.repoPath) continue;
        if (!cache.identities.has(resolved.path)) {
          cache.identities.set(resolved.path, await repoIdentityAsync(resolved.path).catch((error: unknown) => ({ error })));
        }
        const found = cache.identities.get(resolved.path)!;
        const remembered = 'error' in found ? null : `${resolved.path}\0${JSON.stringify(found)}`;
        if (remembered !== null && this.sweptDifferent.get(row.id) === remembered) continue;
        const recorded = this.recordedIdentity(row);
        const key = `${resolved.path}\0${row.sha}`;
        if (recorded === null && remembered !== null && !cache.baseRoots.has(key)) cache.baseRoots.set(key, await baseRootsAsync(resolved.path, row.sha));
        const verdict = repositoryVerdict(resolved.path, found, recorded, recorded === null ? cache.baseRoots.get(key)! : null, row.sha);
        if (verdict.kind === 'different' && remembered !== null) this.sweptDifferent.set(row.id, remembered);
        if (verdict.kind !== 'same') continue;
        this.sweptDifferent.delete(row.id);
        this.opts.ledger.moveWorktreeRepo({ id: row.id, repoPath: resolved.path, rebind: null });
        const move = followed.get(`${row.repoPath}\0${resolved.path}`) ?? { from: row.repoPath, to: resolved.path, lanes: 0, byBaseOnly: 0 };
        move.lanes += 1;
        if (verdict.byBaseOnly) move.byBaseOnly += 1;
        followed.set(`${row.repoPath}\0${resolved.path}`, move);
      } catch (error) {
        this.log('warn', 'a released lane could not follow its moved repository; the next check tries again', { id: row.id, repo_path: row.repoPath, error: String(error) });
      }
      // Timers and requests run between rows.
      await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    }
    for (const move of followed.values()) {
      this.log('info', 'released lanes follow their moved repository: their saved work is found there', {
        from: move.from, to: move.to, lanes: move.lanes, matched_by_base_commit_only: move.byBaseOnly,
      });
    }
  }

  /** Whether `candidate` holds the repository the lane was made in, its
   * git read synchronously and once per check ({@link MoveCheckCache}). */
  private sameRepository(row: WorktreeRecord, candidate: string, cache: MoveCheckCache): RepositoryVerdict {
    const found = cachedIdentity(candidate, cache);
    const recorded = this.recordedIdentity(row);
    const key = `${candidate}\0${row.sha}`;
    if (recorded === null && !('error' in found) && !cache.baseRoots.has(key)) cache.baseRoots.set(key, baseRoots(candidate, row.sha));
    return repositoryVerdict(candidate, found, recorded, recorded === null ? cache.baseRoots.get(key) ?? null : null, row.sha);
  }

  /**
   * Reconnect a lane to its repository's place (#427 PR 2b):
   * `git worktree repair <lane>` from there (not for a lane whose link
   * works), then the lane's git link must reach it. The lane's creation
   * handoff is re-bound to the paths it now reaches (`prepareLaneRebind`;
   * also when only the repository's own git directory moved and
   * `candidate` is the registry's `repo_path`), and the registry's
   * `repo_path` moves there with `worktree.repo-moved` and the rebinding,
   * in one transaction, before the re-bound receipt is published (a stop
   * between the two is finished by the next check). A new administration is
   * taken only when a move explains it ({@link unexplainedAdminChange}),
   * else the lane is `tampered`. The lane's identity is recorded for its new
   * place.
   */
  private repairMovedLane(row: WorktreeRecord, candidate: string, cache: MoveCheckCache, linked: boolean): RepoMoveOutcome {
    cache.repairs += 1;
    if (!linked) {
      try {
        runGit(candidate, ['worktree', 'repair', row.path]);
      } catch (error) {
        return { status: 'unresolved', lane: row, reason: `git worktree repair failed in ${candidate}: ${oneLineErrorText(error instanceof Error ? error.message : error, 400)}` };
      }
    }
    if (!laneReachesRepository(row.path, candidate)) {
      return { status: 'unresolved', lane: row, reason: `git worktree repair in ${candidate} did not reconnect the lane: that repository has no record of it` };
    }
    const rebind = prepareLaneRebind(row, candidate, this.opts.ledger);
    if (rebind === null && candidate === row.repoPath) {
      this.log('info', 'a lane\'s git link was repaired in place', { id: row.id, repo_path: row.repoPath });
      return { status: 'repaired', lane: row, from: row.repoPath, to: candidate };
    }
    if (rebind !== null && rebind.from.admin !== rebind.admin) {
      const unexplained = unexplainedAdminChange(row.path, rebind.from.admin, rebind.admin, rebind.to.common);
      if (unexplained !== null) return { status: 'tampered', lane: row, reason: unexplained };
    }
    const moved = this.opts.ledger.moveWorktreeRepo({ id: row.id, repoPath: candidate, rebind });
    if (rebind !== null) publishLaneRebind(rebind);
    rememberManagedLane(moved, this.opts.ledger);
    this.recordRepoIdentity(moved, cache);
    this.log('info', 'lane reconnected to its moved repository', { id: row.id, from: row.repoPath, to: candidate, rebound: rebind !== null });
    return { status: 'repaired', lane: moved, from: row.repoPath, to: candidate };
  }

  /** The newest repository identity recorded for this lane (the place it
   * last reached), or null when none was recorded. */
  private recordedIdentity(row: WorktreeRecord): RepoIdentity | null {
    const event = row.jobId === null
      ? this.opts.ledger.latestEventByPayloadField(REPO_IDENTITY_EVENT, 'id', row.id)
      : this.opts.ledger.latestJobEventByPayloadField(row.jobId, REPO_IDENTITY_EVENT, 'id', row.id);
    const payload = (event?.payload ?? null) as { readonly roots?: unknown; readonly origin?: unknown } | null;
    if (payload === null || !Array.isArray(payload.roots) || !payload.roots.every((root) => typeof root === 'string')) return null;
    return { roots: payload.roots as string[], origin: typeof payload.origin === 'string' ? payload.origin : null };
  }

  /** Record the identity of the repository at the lane's `repo_path`
   * (`worktree.repo-identity`) unless the lane's newest record names that
   * place already; a check reads it from its cache. Best-effort: a failure
   * is logged, and the next check records it. */
  private recordRepoIdentity(row: WorktreeRecord, cache?: MoveCheckCache): void {
    try {
      const event = row.jobId === null
        ? this.opts.ledger.latestEventByPayloadField(REPO_IDENTITY_EVENT, 'id', row.id)
        : this.opts.ledger.latestJobEventByPayloadField(row.jobId, REPO_IDENTITY_EVENT, 'id', row.id);
      if ((event?.payload as { readonly repo_path?: unknown } | null)?.repo_path === row.repoPath) return;
      const identity = cache === undefined ? repoIdentity(row.repoPath) : cachedIdentity(row.repoPath, cache);
      if ('error' in identity) throw identity.error;
      this.opts.ledger.appendCustomEvent({
        kind: REPO_IDENTITY_EVENT,
        jobId: row.jobId,
        roundId: row.roundId,
        payload: { id: row.id, repo_path: row.repoPath, roots: identity.roots, origin: identity.origin },
      });
    } catch (error) {
      this.log('warn', 'the identity of a lane\'s repository could not be recorded; the next check records it', { id: row.id, repo_path: row.repoPath, error: String(error) });
    }
  }

  /**
   * The owner's discard of a lane whose repository is not there (#427 PR
   * 2b: they accepted the proposal a `mismatch` made). Under the lane's
   * lock, before anything is deleted: a lane swept or gone since is `gone`;
   * one whose git link reaches its repository again (the repository came
   * back, or the check reconnected it) is `reconnected`; a lane paused over
   * live processes, one with any process rooted in it, or one whose folder
   * is not a real folder under the lanes root is `kept` with the reason
   * (the caller keeps the card and asks again later). Otherwise
   * `worktree.discarded { id, path, repo_path, reason }` is recorded once
   * (when it cannot be, nothing is deleted), the lane's folder is deleted
   * with whatever it held, and the lane is marked swept.
   */
  async discardLane(laneId: string, reason: string): Promise<LaneDiscard> {
    return this.withLaneLock(laneId, async () => {
      const row = this.opts.ledger.getWorktree(laneId);
      if (row === null || row.status === 'swept') return 'gone';
      const present = existsSync(row.path);
      if (present && laneReachesRepository(row.path, row.repoPath)) return 'reconnected';
      if (row.status === 'paused') return { kept: 'the lane is paused over processes that still run in it' };
      if (present) {
        const rooted = this.enumerate(row.path);
        if (rooted.length > 0) return { kept: `${String(rooted.length)} process(es) are rooted in the lane (pids ${rooted.map((proc) => proc.pid).join(', ')})` };
        if (!realFolderUnder(this.opts.root, row.path)) return { kept: `${row.path} is not a real folder under the lanes root ${this.opts.root} (a link, or reached through one)` };
      }
      const recorded = row.jobId === null
        ? this.opts.ledger.latestEventByPayloadField('worktree.discarded', 'id', row.id)
        : this.opts.ledger.latestJobEventByPayloadField(row.jobId, 'worktree.discarded', 'id', row.id);
      if (recorded === null) {
        this.opts.ledger.appendCustomEvent({
          kind: 'worktree.discarded',
          jobId: row.jobId,
          roundId: row.roundId,
          payload: { id: row.id, path: row.path, repo_path: row.repoPath, reason },
        });
      }
      await removeTree(row.path);
      this.opts.ledger.setWorktreeStatus(row.id, 'swept', `discarded by the owner: ${reason}`);
      this.log('warn', 'lane discarded by the owner: its repository is not there', { id: row.id, path: row.path, repo_path: row.repoPath, reason });
      try {
        this.opts.onSwept?.({ worktree: row });
      } catch (error) {
        this.log('warn', 'sweep-completion notice resolution failed', { id: row.id, error: String(error) });
      }
      return 'discarded';
    });
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

  /** The entries of the lane's newest slim whose delete began and did not
   * finish (#427), less those a restore has finished since
   * (`worktree.slim-completed`, which lists every one finished so far):
   * those `worktree.slim-incomplete` names `partial`, or, when the slim
   * recorded no outcome at all (it was cut off), every entry it planned. */
  private partlyDeleted(row: WorktreeRecord, slimmedSeq: number, entries: readonly string[]): { readonly partial: readonly string[]; readonly completed: readonly string[] } {
    const after = (kind: string): { readonly payload: unknown } | null => {
      const event = this.opts.ledger.latestJobEventByPayloadField(row.jobId!, kind, 'id', row.id);
      return event !== null && event.seq > slimmedSeq ? event : null;
    };
    const named = (event: { readonly payload: unknown } | null, field: string): readonly string[] | null => {
      const value = (event?.payload as Record<string, unknown> | null | undefined)?.[field];
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null;
    };
    if (after('worktree.slim-done') !== null) return { partial: [], completed: [] };
    const completed = named(after('worktree.slim-completed'), 'entries') ?? [];
    const incomplete = after('worktree.slim-incomplete');
    const begun = incomplete === null ? entries : named(incomplete, 'partial') ?? entries;
    return { partial: entries.filter((entry) => begun.includes(entry) && !completed.includes(entry)), completed };
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
   * throws {@link BaseManifestContentError} (it cannot change). Git runs in
   * `at` (the lane, or the repository once the lane's git folder is gone). */
  private baseManifest(row: WorktreeRecord, at: string = row.path): { readonly blob: string; readonly manifest: WorktreeManifest } | null {
    const listed = runGit(at, ['ls-tree', '-z', row.sha, '--', MANIFEST_PATH]);
    if (listed === '') return null;
    const blob = /^\d+ blob ([0-9a-f]{40,64})\t/u.exec(listed)?.[1];
    if (blob === undefined) throw new BaseManifestContentError(`${MANIFEST_PATH} at the lane's base ${row.sha} is not a file`);
    return { blob, manifest: this.manifestBlob(at, blob) };
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
      // Entries whose delete began and did not finish: part of each is gone.
      const partial: string[] = [];
      for (const entry of planned) {
        // A stop between entries leaves the rest: the lane is slim already.
        if (stopped()) {
          failed.push({ path: entry.path, reason: 'the service stopped before it was deleted' });
          continue;
        }
        let begun = false;
        try {
          // A link that appeared on the path since the plan is never followed.
          const state = await reclaimState(row.path, entry.path);
          if (state !== 'present') throw new Error(state === 'link' ? 'a link appeared on its path after the slim was planned' : 'it was gone when its delete ran');
          begun = true;
          await removeTree(join(row.path, entry.path), input.signal);
          deleted.push(entry);
        } catch (error) {
          if (begun) partial.push(entry.path);
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
          ? { kind: 'worktree.slim-incomplete', jobId: row.jobId, payload: { id: row.id, failed, partial, freed_bytes: freedBytes, shared_bytes: sharedBytes } }
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
   * An entry the slim began and did not finish deleting is deleted whole
   * first (`worktree.slim-completed`), so a half-deleted folder never counts
   * as restored; one whose delete cannot be finished never counts as there.
   * A setup that succeeds must bring back what the lane's setup made when it
   * was created (`worktree.bootstrapped`'s `setup_made`, which a restore
   * never rewrites). When it did, GC records `worktree.rehydrated`, naming
   * any other deleted entry still absent (`not_recreated`: a build or verify
   * makes it); the lane is no longer slim. When it did not (a stamp file
   * outside `reclaim` can make setup skip its work), GC records
   * `worktree.rehydrate-failed` ("setup did not recreate X"): the lane stays
   * slim, is never slimmed again, and Gru hears about it once. A setup that fails or is stopped records
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
      const slimmed = this.opts.ledger.latestJobEventByPayloadField(row.jobId, 'worktree.slimmed', 'id', row.id);
      const record = slimRecord(slimmed);
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
      // An entry the slim began and did not finish deleting is no entry: its
      // delete is finished first (once, recorded), so setup makes it whole or
      // the check below finds it missing.
      const { partial, completed } = this.partlyDeleted(row, slimmed!.seq, record.entries);
      // One whose delete cannot be finished either is never counted whole.
      const unfinished = new Map<string, string>();
      for (const entry of partial) {
        try {
          if ((await reclaimState(row.path, entry)) === 'present') await removeTree(join(row.path, entry), signal);
        } catch (error) {
          if (signal?.aborted === true) throw error;
          unfinished.set(entry, oneLineErrorText(error instanceof Error ? error.message : error, 200));
        }
      }
      if (partial.length > unfinished.size) {
        this.opts.ledger.appendCustomEvent({ kind: 'worktree.slim-completed', jobId: row.jobId, payload: { id: row.id, entries: [...completed, ...partial.filter((entry) => !unfinished.has(entry))] } });
      }
      await applyWorktreeManifest({ ...manifest, links: [], copies: [] }, {
        sourceRoot: row.repoPath,
        worktreePath: row.path,
        setupTimeoutMs: this.opts.setupTimeoutMs,
        log: this.log,
        ...(signal !== undefined ? { signal } : {}),
      });
      const after = await presentReclaimEntries(row.path, [...new Set([...reclaim, ...required, ...record.entries])]);
      for (const entry of unfinished.keys()) after.delete(entry);
      const unfinishedRequired = required.filter((entry) => unfinished.has(entry));
      if (unfinishedRequired.length > 0) {
        return failedRestore(`the slim's delete of ${unfinishedRequired.map((entry) => `${entry} (${unfinished.get(entry)!})`).join(', ')} was cut short and could not be finished, so setup cannot be trusted to have made ${unfinishedRequired.length === 1 ? 'it' : 'them'} whole; the lane stays slim and the next turn retries`);
      }
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
      // What setup made at the lane's creation stays what a restore requires:
      // a restore never rewrites that record (#427).
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
    // A removal git left part way (#427): git deleted the lane's git folder
    // and part of its tree, so no git command runs in what is left. The
    // release deletes the rest and reconciles the lane as removed below.
    // What is left is kept first unless an aborted release of GC's already
    // saved the lane's work before its removal began.
    if (existsSync(row.path) && this.laneAdminGone(row)) {
      await this.withRepoLock(row.repoPath, async () => {
        if (!existsSync(row.path) || !this.laneAdminGone(row)) return;
        const aborted = this.abortedRelease(row);
        const remains = aborted === null ? await this.preserveRemains(row) : null;
        try {
          this.removeLaneRemains(row);
        } catch (error) {
          // The copy is on the record: a retry reuses it, never copying again.
          if (remains !== null) this.recordAbortedRelease(row, { preserved: remains, snapshot: null, discarded: null }, error);
          throw error;
        }
        this.recordRemovalFinished(row, 'a git worktree remove failed part way, after git had deleted the lane\'s git folder');
        const saved = aborted ?? { snapshot: null, preserved: remains };
        if (saved.snapshot === null && saved.preserved === null) return;
        try {
          this.opts.onWorkSaved?.({ worktree: row, snapshot: saved.snapshot, preserved: saved.preserved });
        } catch (error) {
          this.log('warn', 'saved-work notice failed; what was saved is on the lane\'s records', { id: row.id, error: String(error) });
        }
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
      const preserved = await this.preserveUntracked(row, submodules.untracked, attempt);
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
    await this.disableSparseCheckout(path);
  }

  /** A lane is never sparse (#427): `git worktree add` gives a lane the
   * owner checkout's sparse-checkout, and a sparse lane's release is refused
   * ({@link LaneSparseCheckoutError}). With per-worktree config
   * (`extensions.worktreeConfig`, which `git sparse-checkout` turns on) the
   * lane's sparse checkout is disabled, in the lane only, before anything
   * runs in it. With the older shared `core.sparseCheckout` it is left as it
   * is: disabling it there would change the owner's repository config. The
   * disable checks the whole tree out, so it runs off the event loop. */
  private async disableSparseCheckout(path: string): Promise<void> {
    if (spawnGit(path, ['config', '--bool', '--get', 'core.sparseCheckout']).stdout.trim() !== 'true') return;
    if (spawnGit(path, ['config', '--bool', '--get', 'extensions.worktreeConfig']).stdout.trim() !== 'true') {
      this.log('warn', 'lane is sparse through the repository\'s shared core.sparseCheckout; it is left sparse, and its release is refused until the sparse checkout is disabled in it', { path });
      return;
    }
    await runGitAsync(path, ['sparse-checkout', 'disable']);
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
   * removal step. The copy runs off the event loop. */
  private async preserveUntracked(row: WorktreeRecord, nested: readonly string[], attempt: SweepAttempt): Promise<SweepPreservation | null> {
    // `--untracked-files=all` overrides the repository's own
    // `status.showUntrackedFiles` (#427): a repository that hides untracked
    // files from `git status` still has every one copied. An untracked
    // folder holding a `.git` is copied whole, its `.git` with it, all but
    // what that repository ignores ({@link nestedIgnored}). The
    // untracked files of nested repositories (#427, at any depth) are
    // copied too, under their paths, unless an untracked folder holds them
    // already (a submodule folder only the lane's git folder still names).
    const listed = porcelainUntracked(runGit(row.path, ['status', '--porcelain', '-z', '--untracked-files=all']));
    const folders = listed.filter((rel) => rel.endsWith('/'));
    const untracked = [...new Set([...listed, ...nested.filter((rel) => !folders.some((folder) => rel !== folder && rel.startsWith(folder)))])];
    if (untracked.length === 0) return null;
    const excluded = await this.nestedIgnored(row.path, untracked);
    // A retry of a release that aborted after its records (#427) reuses that
    // release's copy while the untracked files are unchanged: no new folder
    // and no new record.
    const reused = this.reusablePreservation(row, untracked, excluded, attempt.aborted);
    if (reused !== null) {
      attempt.preserveReused = true;
      attempt.copyRecorded = true;
      this.log('info', 'untracked deliverables unchanged since an aborted release; its preserve copy is reused', { id: row.id, destination: reused.destination });
      return reused;
    }
    const destination = join(this.opts.preserveRoot, row.id, new Date().toISOString().replace(/[:.]/g, '-'));
    let preservedCount = 0;
    try {
      preservedCount = await this.copyUntracked(row, untracked, destination, excluded);
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
   * lane's untracked files (the same paths, links and bytes, `excluded`
   * left out as the copy leaves them out); else null. */
  private reusablePreservation(row: WorktreeRecord, untracked: readonly string[], excluded: ReadonlySet<string>, aborted: AbortedRelease | null): SweepPreservation | null {
    const copy = aborted?.preserved ?? null;
    if (copy === null || !existsSync(copy.destination)) return null;
    try {
      return contentFingerprint(row.path, untracked, excluded) === contentFingerprint(copy.destination, null) ? copy : null;
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

  /** Copy paths of a lane into `destination`, off the event loop (#427). A
   * FIFO, socket or device, named or met inside a folder, is skipped with a
   * warn naming it and never opened: opening a FIFO waits for a writer. A
   * path in `excluded` (by its path in the lane) met inside a folder is not
   * copied. */
  private async copyUntracked(row: WorktreeRecord, untracked: readonly string[], destination: string, excluded: ReadonlySet<string>): Promise<number> {
    let preservedCount = 0;
    const special = (rel: string): void => {
      this.log('warn', 'special file not preserved: a FIFO, socket or device is never opened', { id: row.id, rel });
    };
    for (const rel of untracked) {
      const source = join(row.path, rel);
      let info: Stats;
      try {
        info = await lstatAsync(source);
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
      if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) {
        special(rel);
        continue;
      }
      const dest = join(destination, rel);
      try {
        await mkdirAsync(dirname(dest), { recursive: true });
        if (info.isSymbolicLink()) {
          // Perkins r4 B1: a manifest [[link]] (or any symlink deliverable)
          // is preserved AS A LINK — copyFileSync on a symlink-to-dir is
          // ENOTSUP/EISDIR and used to make the lane unreleasable forever.
          // The link is the deliverable; recreate it verbatim.
          await symlinkAsync(await readlinkAsync(source), dest);
        } else if (info.isDirectory()) {
          await cpAsync(source, dest, {
            recursive: true,
            filter: async (from) => {
              if (excluded.has(relative(row.path, from))) return false;
              const entry = await lstatAsync(from);
              if (entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()) return true;
              special(relative(row.path, from));
              return false;
            },
          });
        } else {
          await copyFileAsync(source, dest);
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
      try {
        runGit(row.repoPath, ['worktree', 'remove', '--force', row.path]);
      } catch (removal) {
        // Git deletes the lane's git folder even when it could not delete all
        // of its tree (#427): no git command runs in what is left, so GC
        // finishes the removal rather than leave a lane no release completes.
        if (!this.laneAdminGone(row)) throw removal;
        this.removeLaneRemains(row);
        this.recordRemovalFinished(row, `git worktree remove failed part way (${oneLineErrorText(removal instanceof Error ? removal.message : removal, 400)}), after git had deleted the lane's git folder`);
      }
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
   * without risking a wrong tree ({@link LaneSparseCheckoutError}). Gru is
   * told at every refusal (one row per lane). */
  private assertNotSparse(row: WorktreeRecord): void {
    const sparse = spawnGit(row.path, ['config', '--bool', '--get', 'core.sparseCheckout']);
    if (sparse.status !== 0 || sparse.stdout.trim() !== 'true') return;
    try {
      this.opts.onSparseCheckoutRefused?.({ worktree: row });
    } catch (error) {
      this.log('warn', 'sparse-checkout notice failed; the refusal names the lane', { id: row.id, error: String(error) });
    }
    throw new LaneSparseCheckoutError(row.path);
  }

  /**
   * Work in the lane's nested repositories that the removal would destroy
   * (#427). A nested repository is every git repository inside the lane
   * other than the lane itself: its submodules at any depth, and any
   * repository its index or HEAD records as a gitlink (an embedded
   * repository committed or staged with no `.gitmodules`); every git folder
   * under the lane's own `modules` (a submodule the lane initialized, which
   * no path may name any more); and every repository in an ignored folder,
   * at most {@link IGNORED_REPO_DEPTH} levels below it and never inside a
   * `node_modules` (a deeper one is not found: a documented limit). Each
   * keeps its git data in the lane's own git folder or in a `.git` inside
   * its checkout, which the removal deletes, and the snapshot holds at most
   * its gitlink. An untracked folder holding a `.git` is no gitlink: the
   * preserve copy takes it whole, `.git` included. A gitlink folder holding
   * files but no `.git` (a submodule never initialized there) is untracked
   * content: the preserve copy takes it. Detection ignores every display
   * setting (`--ignore-submodules=none`, `diff.ignoreSubmodules=none`). A
   * nested repository is safe to remove with the lane only when:
   *
   * - **its index and working tree are clean** (its own `status`, untracked
   *   files included). Untracked content is no loss: the preserve copy takes
   *   it under its path, unless the `.gitmodules` that records it (at the
   *   lane's base) sets `ignore = untracked` or `ignore = all` (the user
   *   declared it disposable). A nested repository's own changes are judged
   *   in it, never in the repository around it;
   * - **every commit it can reach survives**: each commit reachable from its
   *   HEAD, branches, tags, stash and the reflogs of those is the gitlink the
   *   lane's base records for it (or an ancestor of that), is in one of its
   *   remote-tracking refs, or is in the main checkout's own copy
   *   (`<git common dir>/modules/<name>`), which outlives the lane. A tag in
   *   the lane's own copy is no evidence: it goes with the lane.
   *
   * Work at risk is refused by name ({@link LaneSubmoduleWorkError},
   * recorded once per lane and digest as `worktree.submodule-work-refused`,
   * with Gru told), unless an operator release's discard carries the digest
   * of exactly this work. Returns what is discarded, and the untracked files
   * of the nested repositories (by their paths in the lane) that the
   * preserve copy takes.
   */
  private assertSubmoduleWork(row: WorktreeRecord, discard: string | null): { readonly discarded: readonly SubmoduleWork[]; readonly untracked: readonly string[] } {
    const scan = this.submoduleWork(row);
    if (scan.work.length === 0) return { discarded: [], untracked: scan.untracked };
    if (discard === scan.digest) return { discarded: scan.work, untracked: scan.untracked };
    this.recordSubmoduleRefusal(row, scan.work, scan.digest, discard);
    throw new LaneSubmoduleWorkError(row.path, scan.work, scan.digest, discard);
  }

  private submoduleWork(row: WorktreeRecord): SubmoduleScan {
    const work: SubmoduleWork[] = [];
    const fingerprints: string[] = [];
    const untracked: string[] = [];
    const seen = new Set<string>();
    const common = resolve(row.repoPath, runGit(row.repoPath, ['rev-parse', '--git-common-dir']));
    const judge = (child: NestedRepo, depth: number): void => {
      seen.add(directoryKey(child.gitDir!));
      const checkout = child.populated ? join(row.path, child.path) : null;
      const head = spawnGit(child.gitDir!, ['--git-dir', child.gitDir!, '--work-tree', child.gitDir!, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).stdout.trim() || null;
      const commits = nestedLostCommits(child, head);
      const status = checkout === null ? null : nestedStatus(checkout);
      if (status !== null && !child.disposable) untracked.push(...status.untracked.map((rel) => `${child.path}/${rel}`));
      const deeper = checkout !== null && depth >= NESTED_DEPTH_LIMIT && this.nestedRepos(nestedParent(child, checkout)).length > 0;
      const states = [
        ...commits.states,
        ...(status?.modified === true ? ['modified tracked content'] : []),
        ...(deeper ? [`repositories nested more than ${String(NESTED_DEPTH_LIMIT)} levels deep, which GC does not check`] : []),
      ];
      if (states.length > 0) {
        work.push({ path: child.path, state: states, head });
        fingerprints.push(this.submoduleContentFingerprint(checkout, commits.lost));
      }
      if (checkout !== null && !deeper) visit(nestedParent(child, checkout), depth + 1);
    };
    const visit = (parent: NestedParent, depth: number): void => {
      for (const child of [...this.nestedRepos(parent), ...this.ignoredRepos(parent)]) {
        // A gitlink folder holding files but no `.git`: a submodule never
        // initialized there, where something wrote files git does not list.
        // They are untracked content: the preserve copy takes them, all but
        // what the repository around it ignores.
        if (!child.populated && !child.disposable && child.gitlinks.some(([sha]) => sha !== undefined) && folderHoldsFiles(join(row.path, child.path))) {
          const rel = parent.path === '' ? child.path : child.path.slice(parent.path.length + 1);
          // An index that does not exist holds no gitlink to hide the folder.
          const listed = runGit(parent.checkout, ['ls-files', '-z', '--others', '--exclude-standard', '--', `${rel}/`], {
            indexFile: join(tmpdir(), `gru-no-index-${randomUUID()}`, 'index'),
            maxBuffer: LISTING_MAX_BUFFER,
          });
          untracked.push(...listed.split('\0').filter((entry) => entry !== '').map((entry) => (parent.path === '' ? entry : `${parent.path}/${entry}`)));
        }
        // Never initialized in the lane: nothing else of it is the lane's to lose.
        if (child.gitDir === null || seen.has(directoryKey(child.gitDir))) continue;
        judge(child, depth);
      }
    };
    const modules = resolve(row.path, runGit(row.path, ['rev-parse', '--git-path', 'modules']));
    visit({ path: '', checkout: row.path, modules, basePin: row.sha, mainModules: join(common, 'modules') }, 1);
    // Every submodule repository the lane ever initialized is in its git
    // folder's `modules`, whether or not any path names it now (a folder
    // holding only its gitfile, a gitlink reset away): each one not met
    // above is judged by its git folder.
    for (const child of this.adminModules(row, modules, join(common, 'modules'))) {
      if (!seen.has(directoryKey(child.gitDir!))) judge(child, 1);
    }
    return { work, digest: submoduleWorkDigest(work, fingerprints), untracked };
  }

  /** The submodule repositories in the lane's own git folder (#427): every
   * git folder under its `modules` (each one's own submodules under that
   * one's `modules`), by its name there. Its checkout in the lane is the
   * folder its `core.worktree` names, when that folder's `.git` leads back to
   * it; its base pin, the gitlink the lane's base records at that path. */
  private adminModules(row: WorktreeRecord, modules: string, mainModules: string): readonly NestedRepo[] {
    if (!existsSync(modules)) return [];
    const lane = realpathSync(row.path);
    const repos: NestedRepo[] = [];
    const walk = (dir: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (!entries.some((entry) => entry.name === 'HEAD' && entry.isFile()) || !entries.some((entry) => entry.name === 'objects' && entry.isDirectory())) {
        for (const entry of entries) if (entry.isDirectory()) walk(join(dir, entry.name));
        return;
      }
      const name = relative(modules, dir);
      const worktree = spawnGit(dir, ['--git-dir', dir, 'config', '--get', 'core.worktree']).stdout.trim();
      const checkout = worktree === '' ? null : resolve(realpathSync(dir), worktree);
      const inLane = checkout === null ? null : relative(lane, checkout);
      const path = inLane !== null && inLane !== '' && !inLane.startsWith('..') && !isAbsolute(inLane) ? inLane : null;
      const populated = path !== null && pathOnDisk(join(lane, path, '.git'))
        && directoryKey(spawnGit(join(lane, path), ['rev-parse', '--absolute-git-dir']).stdout.trim()) === directoryKey(dir);
      repos.push({
        path: path ?? name,
        name,
        populated,
        gitDir: dir,
        basePin: path === null ? null : gitlinks(spawnGit(row.repoPath, ['ls-tree', '-z', row.sha, '--', path]).stdout, 'tree').get(path) ?? null,
        mainCopy: join(mainModules, name),
        disposable: false,
        gitlinks: [],
      });
      if (existsSync(join(dir, 'modules'))) walk(join(dir, 'modules'));
    };
    walk(modules);
    return repos;
  }

  /** The repositories in folders a repository's ignore rules hide (#427):
   * each ignored folder `git ls-files --others --ignored --exclude-standard
   * --directory` lists (which never descends into one) that is a repository
   * or holds one at most {@link IGNORED_REPO_DEPTH} levels below it, found
   * by its `.git`, never through a link or into a `node_modules`. A deeper
   * one, or one inside a `node_modules`, is not found: a documented limit. */
  private ignoredRepos(parent: NestedParent): readonly NestedRepo[] {
    const listed = runGit(parent.checkout, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { maxBuffer: LISTING_MAX_BUFFER });
    const repos: NestedRepo[] = [];
    for (const entry of listed.split('\0')) {
      if (!entry.endsWith('/')) continue;
      for (const rel of this.repositoryFolders(parent.checkout, entry.slice(0, -1))) {
        const dir = join(parent.checkout, rel);
        const found = spawnGit(dir, ['rev-parse', '--absolute-git-dir', '--show-toplevel']);
        const [gitDir = '', top = ''] = found.stdout.trim().split('\n');
        // Git found the repository around it: the `.git` there is none.
        if (found.status !== 0 || directoryKey(top) !== directoryKey(dir)) {
          this.log('warn', 'an ignored folder holds a .git that git does not read as a repository; nothing in it is checked', { path: dir });
          continue;
        }
        repos.push({
          path: parent.path === '' ? rel : `${parent.path}/${rel}`,
          name: rel,
          populated: true,
          gitDir,
          basePin: null,
          mainCopy: null,
          disposable: false,
          gitlinks: [],
        });
      }
    }
    return repos;
  }

  /** {@link repositoryFolders}, a folder that cannot be read logged by name. */
  private repositoryFolders(root: string, rel: string): string[] {
    return repositoryFolders(root, rel, (dir, error) => {
      this.log('warn', 'a folder could not be read; GC does not look for repositories in it', { path: dir, error: String(error) });
    });
  }

  /** What a copy of whole folders leaves out (#427): each folder in
   * `untracked` (a path ending in `/`), and each folder in it, that holds a
   * `.git` git reads as its own is a repository whose ignored paths (`git
   * ls-files --others --ignored --exclude-standard --directory` there) are
   * not copied, `.env.local` with them. An ignored folder that is, or holds,
   * a repository is copied (its repositories judged the same way): its
   * commits live nowhere else. By their paths below `root`. */
  private async nestedIgnored(root: string, untracked: readonly string[]): Promise<ReadonlySet<string>> {
    const excluded = new Set<string>();
    const queue = untracked.filter((rel) => rel.endsWith('/')).flatMap((rel) => this.repositoryFolders(root, rel.slice(0, -1)));
    for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) {
      const dir = join(root, repo);
      // An error is an answer here: git does not read it as a repository.
      const top = (await runGitAsync(dir, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
      if (top === '' || directoryKey(top) !== directoryKey(dir)) {
        this.log('warn', 'a folder being copied holds a .git that git does not read as its own repository; what it ignores is copied with it', { path: dir });
        continue;
      }
      for (const entry of (await runGitAsync(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { maxBuffer: LISTING_MAX_BUFFER })).split('\0')) {
        if (entry === '') continue;
        const rel = `${repo}/${entry.replace(/\/$/u, '')}`;
        const held = entry.endsWith('/') ? this.repositoryFolders(root, rel) : [];
        if (held.length > 0) queue.push(...held);
        else excluded.add(rel);
      }
    }
    return excluded;
  }

  /** The repositories nested directly in one (#427): every gitlink its index
   * records (one bounded `ls-files -s`), every gitlink its HEAD records that
   * the index no longer does (a staged removal), and every path its
   * `.gitmodules` names (at its base, at HEAD and in its working tree). */
  private nestedRepos(parent: NestedParent): readonly NestedRepo[] {
    const at = parent.checkout;
    const staged = gitlinks(runGit(at, ['ls-files', '-s', '-z'], { maxBuffer: LISTING_MAX_BUFFER }), 'index');
    const removed = removedGitlinks(runGit(at, [
      '-c', 'diff.ignoreSubmodules=none', 'diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--ignore-submodules=none', '--diff-filter=DT', 'HEAD', '--',
    ], { maxBuffer: LISTING_MAX_BUFFER }));
    const names = new Map<string, string>();
    const ignore = new Map<string, string>();
    const declared = [
      ...(parent.basePin === null ? [] : gitmodulesEntries(at, ['--blob', `${parent.basePin}:.gitmodules`]).map((entry) => [...entry, true] as const)),
      ...gitmodulesEntries(at, ['--blob', 'HEAD:.gitmodules']).map((entry) => [...entry, false] as const),
      ...gitmodulesEntries(at, ['--file', '.gitmodules']).map((entry) => [...entry, false] as const),
    ];
    for (const [name, key, value, atBase] of declared) {
      if (key === 'path') names.set(value, name);
      // What the user declared at the lane's base, never a minion's later edit.
      if (key === 'ignore' && atBase) ignore.set(name, value);
    }
    const paths = [...new Set([...staged.keys(), ...removed, ...names.keys()])].sort();
    if (paths.length === 0) return [];
    const recorded = gitlinks(runGit(at, ['ls-tree', '-z', 'HEAD', '--', ...paths], { maxBuffer: LISTING_MAX_BUFFER }), 'tree');
    const base = parent.basePin === null ? new Map<string, string>() : gitlinks(spawnGit(at, ['ls-tree', '-z', parent.basePin, '--', ...paths], { maxBuffer: LISTING_MAX_BUFFER }).stdout, 'tree');
    const where = parent.path === '' ? 'the lane\'s' : `${parent.path}'s`;
    return paths.map((path) => {
      const name = names.get(path) ?? path;
      const checkout = join(at, path);
      const populated = pathOnDisk(join(checkout, '.git'));
      const modules = join(parent.modules, name);
      return {
        path: parent.path === '' ? path : `${parent.path}/${path}`,
        name,
        populated,
        gitDir: populated ? runGit(checkout, ['rev-parse', '--absolute-git-dir']) : existsSync(modules) ? modules : null,
        basePin: base.get(path) ?? null,
        mainCopy: parent.mainModules === null ? null : join(parent.mainModules, name),
        disposable: ignore.get(name) === 'untracked' || ignore.get(name) === 'all',
        gitlinks: [[recorded.get(path), `recorded in ${where} HEAD`], [staged.get(path), `staged in ${where} index`]],
      };
    });
  }

  /** What a refused nested repository holds, as a hash (#427): the commits
   * found at risk and its tracked content against its HEAD (`git diff
   * --binary HEAD`). More edits or commits after a refusal change it; its
   * untracked files do not (the preserve copy takes them, no discard covers
   * them). */
  private submoduleContentFingerprint(checkout: string | null, commits: readonly string[]): string {
    const hash = createHash('sha256').update(JSON.stringify(commits));
    if (checkout === null) return hash.digest('hex');
    const diff = spawnGit(checkout, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], { maxBuffer: LISTING_MAX_BUFFER });
    hash.update(`\0${String(diff.status)}\0`).update(diff.stdout);
    return hash.digest('hex');
  }

  /** A submodule refusal on the record, once per lane and digest (a lane
   * with no job too): what the operator was shown, so a discard can name
   * it. Gru is told at every refusal; the notice's row id (lane and digest)
   * keeps it to one row per digest, so a notice that failed once is posted
   * by the next refusal. */
  private recordSubmoduleRefusal(row: WorktreeRecord, work: readonly SubmoduleWork[], digest: string, staleDiscard: string | null): void {
    let previousDigest: string | null = null;
    try {
      const last = (this.opts.ledger.latestEventByPayloadField('worktree.submodule-work-refused', 'id', row.id)?.payload ?? null) as { readonly digest?: unknown } | null;
      if (last?.digest !== digest) {
        previousDigest = typeof last?.digest === 'string' ? last.digest : null;
        this.opts.ledger.appendCustomEvent({
          kind: 'worktree.submodule-work-refused',
          jobId: row.jobId,
          roundId: row.roundId,
          payload: { id: row.id, path: row.path, digest, submodules: work },
        });
      }
    } catch (error) {
      this.log('error', 'worktree.submodule-work-refused event write failed; the refusal still names its digest', { id: row.id, error: String(error) });
    }
    try {
      this.opts.onSubmoduleWorkRefused?.({ worktree: row, submodules: work, digest, previousDigest, staleDiscard });
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
   *   is hashed again, as the real index would have it), in the system's
   *   temporary folder, else in the preserve root. A readable index that
   *   cannot be copied to either refuses: HEAD would lose what it stages
   *   new. Only when the lane's index cannot be read at all (it is missing
   *   or unreadable) is the temporary index read from HEAD, with a warn
   *   saying the files it staged new cannot be known.
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
    const scratches: string[] = [];
    const oneLine = (error: unknown): string => oneLineErrorText(error instanceof Error ? error.message : error, 400);
    const cannotBuild = (error: unknown): LaneSnapshotError => {
      const file = gitNamedFile(error instanceof Error ? error.message : String(error));
      return new LaneSnapshotError(row.path, `could not be built${file === null ? '' : `: git could not read ${file}`} (${oneLine(error)})`);
    };
    // A temporary index in the system's temporary folder, else in the
    // preserve root (a full temporary folder must not cost the snapshot).
    const roots: readonly (readonly [string, string])[] = [[tmpdir(), 'gru-sweep-snapshot-'], [this.opts.preserveRoot, '.gru-sweep-snapshot-']];
    const temporaryIndex = (write: (file: string) => void): { readonly file: string | null; readonly failures: readonly string[] } => {
      const failures: string[] = [];
      for (const [root, prefix] of roots) {
        try {
          const scratch = mkdtempSync(join(root, prefix));
          scratches.push(scratch);
          const file = join(scratch, 'index');
          write(file);
          return { file, failures };
        } catch (error) {
          failures.push(`${root}: ${oneLine(error)}`);
        }
      }
      return { file: null, failures };
    };
    try {
      let head: string;
      let tree: string;
      let index: SpawnGitOptions;
      try {
        head = runGit(row.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
        const laneIndex = resolve(row.path, runGit(row.path, ['rev-parse', '--git-path', 'index']));
        let readable = true;
        try {
          closeSync(openSync(laneIndex, 'r'));
        } catch (unreadable) {
          readable = false;
          this.warnIndexFallback(row, unreadable);
        }
        if (readable) {
          // The times before the bytes: an index rewritten meanwhile leaves
          // the copy older than its content, which only makes more entries racy.
          const { atime, mtime } = statSync(laneIndex);
          const copied = temporaryIndex((file) => {
            copyFileSync(laneIndex, file);
            utimesSync(file, atime, mtime);
          });
          // A readable index is never traded for HEAD: what it stages new
          // would be in neither the snapshot nor the preserve copy.
          if (copied.file === null) {
            const staged = spawnGit(row.path, ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=A', '-z', head, '--']);
            const stagedNew = staged.status === 0 ? staged.stdout.split('\0').filter((entry) => entry !== '').length : null;
            throw new LaneSnapshotError(row.path, `could not be built: the lane's index could not be copied to a temporary location (${copied.failures.join('; ')})${
              stagedNew === null ? '' : `, and it stages ${String(stagedNew)} new file(s) a snapshot from HEAD would lose`}`);
          }
          index = { indexFile: copied.file };
        } else {
          const fromHead = temporaryIndex((file) => { runGit(row.path, ['read-tree', head], { indexFile: file }); });
          if (fromHead.file === null) throw new Error(`no temporary index could be made (${fromHead.failures.join('; ')})`);
          index = { indexFile: fromHead.file };
        }
        this.clearHiddenEntryBits(row, index);
        runGit(row.path, ['add', '-u'], index);
        tree = runGit(row.path, ['write-tree'], index);
      } catch (error) {
        throw error instanceof LaneSnapshotError ? error : cannotBuild(error);
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
      for (const scratch of scratches) rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** The snapshot falls back to HEAD (#427) only when the lane's index
   * cannot be read at all (it is missing or unreadable): which files it
   * staged new cannot be known then, and none is in the snapshot. With no
   * index, git counts every file in the lane untracked, so the preserve copy
   * holds them all. */
  private warnIndexFallback(row: WorktreeRecord, error: unknown): void {
    this.log('warn', 'the lane\'s index cannot be read, so the snapshot is built from HEAD: any file staged new in that index cannot be known and is not in it (with no index, git counts every file untracked, so the preserve copy holds them)', {
      id: row.id,
      error: oneLineErrorText(error instanceof Error ? error.message : error, 400),
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
    const snapshot = payload.snapshot as { readonly ref?: unknown; readonly sha?: unknown; readonly files?: unknown } | null | undefined;
    return {
      preserved: typeof preserved?.destination === 'string' && typeof preserved.files === 'number' ? { destination: preserved.destination, count: preserved.files } : null,
      snapshot: typeof snapshot?.ref === 'string' && typeof snapshot.sha === 'string'
        ? { ref: snapshot.ref, sha: snapshot.sha, files: typeof snapshot.files === 'number' ? snapshot.files : 0 }
        : null,
      discarded: typeof payload.discarded === 'string' ? payload.discarded : null,
    };
  }

  /** Whether git already deleted the lane's own git folder (#427): a
   * `worktree remove` that fails part way deletes it whatever happened to the
   * tree. The repository decides: no folder under its `worktrees` names this
   * tree (the lane's `.git` file may be gone too, or name a folder that is). */
  private laneAdminGone(row: WorktreeRecord): boolean {
    try {
      const text = readWorktreeMetadata(join(row.path, '.git')).trim();
      if (text.startsWith('gitdir: ') && existsSync(resolve(row.path, text.slice('gitdir: '.length)))) return false;
    } catch {
      // missing or not a plain file: the repository's records decide
    }
    const container = join(repositoryCommonDirectory(row.repoPath), 'worktrees');
    if (!existsSync(container)) return true;
    const tree = new Set([join(row.path, '.git'), join(realpathSync(dirname(row.path)), basename(row.path), '.git')]);
    for (const entry of readdirSync(container, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const admin = join(container, entry.name);
      let backlink: string;
      try {
        backlink = resolve(admin, readWorktreeMetadata(join(admin, 'gitdir')).trim());
      } catch {
        continue; // a folder with no backlink names no tree
      }
      if (tree.has(backlink) || (existsSync(dirname(backlink)) && tree.has(join(realpathSync(dirname(backlink)), '.git')))) return false;
    }
    return true;
  }

  /** Finish a removal git left part way (#427): delete what is left of the
   * lane's tree (read-only folders made writable first, a link removed as a
   * link) and prune the repository's worktree records. When the tree cannot
   * be deleted, refuses by name with what is left in place. */
  private removeLaneRemains(row: WorktreeRecord): void {
    try {
      removeTreeSync(row.path);
    } catch (error) {
      throw new Error(
        `sweep refused: git deleted the git folder of ${row.path} but not all of its tree, and GC could not delete the rest ` +
          `(${oneLineErrorText(error instanceof Error ? error.message : error, 400)}) — free what holds it (a busy mount, a read-only file system), then release again`,
      );
    }
    try {
      runGit(row.repoPath, ['worktree', 'prune']);
    } catch (error) {
      this.log('warn', 'git worktree prune failed after a removal GC finished; the lane\'s tree is gone', { id: row.id, error: String(error) });
    }
  }

  /** Say how a removal was finished (#427): `worktree.sweep-tail-failed
   * { id, stage: 'remove', error }`, best-effort. */
  private recordRemovalFinished(row: WorktreeRecord, cause: string): void {
    const error = `${cause}; GC deleted the rest of the tree and pruned the worktree`;
    this.log('warn', 'lane removal finished by GC after git stopped part way', { id: row.id, error });
    try {
      this.opts.ledger.appendCustomEvent({ kind: 'worktree.sweep-tail-failed', jobId: row.jobId, roundId: row.roundId, payload: { id: row.id, stage: 'remove', error } });
    } catch (eventError) {
      this.log('error', 'sweep-tail-failed event write failed', { id: row.id, error: String(eventError) });
    }
  }

  /** Copy what a part-way removal left of a lane into the preserve root
   * (#427), off the event loop: no record says what was saved before that
   * removal began. Only what {@link remainsToCopy} keeps is copied. Recorded
   * as `worktree.preserved` with `remains: true`. */
  private async preserveRemains(row: WorktreeRecord): Promise<SweepPreservation | null> {
    const remains = await this.remainsToCopy(row);
    if (remains.paths.length === 0) return null;
    const destination = join(this.opts.preserveRoot, row.id, new Date().toISOString().replace(/[:.]/g, '-'));
    let count: number;
    try {
      count = await this.copyUntracked(row, remains.paths, destination, remains.excluded);
    } catch (error) {
      this.withdrawPreservation(row, { count: 0, destination });
      throw error;
    }
    if (count === 0) return null;
    const preserved = { count, destination };
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.preserved',
      jobId: row.jobId,
      roundId: row.roundId,
      payload: { id: row.id, files: count, destination, remains: true },
    });
    return preserved;
  }

  /** What a part-way removal left that the preserve copy takes (#427): what
   * `git ls-files --cached --others --exclude-standard` lists in the remains
   * (an untracked repository as its folder), with the repository's git
   * folder and a temporary index of the lane's commit (its branch, else its
   * base) in the system's temporary folder, else the preserve root. Each
   * `.gitignore` in that index is marked skip-worktree, so git reads one it
   * already deleted from the commit: the repository's ignore rules decide,
   * as they did in the lane, and an ignored file (`.env.local`,
   * `node_modules`) is never copied. Every gitlink leaves that index: a
   * submodule folder holding a `.git` is then listed as a repository, and
   * one holding none (never initialized, or its git folder gone with the
   * lane's) file by file under those rules. An ignored folder that is, or
   * holds, a repository ({@link repositoryFolders}) is kept whole. Never
   * copied: a path gone from disk, a manifest `[[copy]]` destination (the
   * manifest at the lane's base), and what a repository copied whole
   * ignores ({@link nestedIgnored}); `excluded` names those last two. */
  private async remainsToCopy(row: WorktreeRecord): Promise<{ readonly paths: readonly string[]; readonly excluded: ReadonlySet<string> }> {
    const common = repositoryCommonDirectory(row.repoPath);
    const branch = row.branch === null ? '' : spawnGit(row.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}^{commit}`]).stdout.trim();
    const copies = (this.baseManifest(row, row.repoPath)?.manifest.copies ?? []).map((copy) => normalizedManifestPath(copy.to));
    let scratch: string;
    try {
      scratch = await mkdtempAsync(join(tmpdir(), 'gru-remains-index-'));
    } catch {
      await mkdirAsync(this.opts.preserveRoot, { recursive: true });
      scratch = await mkdtempAsync(join(this.opts.preserveRoot, '.gru-remains-index-'));
    }
    try {
      const index = join(scratch, 'index');
      const git = (args: readonly string[], input?: string): Promise<string> => runGitAsync(row.path, ['--git-dir', common, '--work-tree', row.path, ...args], {
        indexFile: index,
        maxBuffer: LISTING_MAX_BUFFER,
        ...(input === undefined ? {} : { input }),
      });
      const paths = (listing: string): string[] => listing.split('\0').filter((entry) => entry !== '');
      await git(['read-tree', branch === '' ? row.sha : branch]);
      const rules = paths(await git(['ls-files', '-z', '--', ':(glob)**/.gitignore']));
      if (rules.length > 0) await git(['update-index', '--skip-worktree', '-z', '--stdin'], `${rules.join('\0')}\0`);
      const links = [...gitlinks(await git(['ls-files', '-s', '-z']), 'index').keys()];
      if (links.length > 0) await git(['update-index', '--force-remove', '-z', '--stdin'], `${links.join('\0')}\0`);
      const repositories = paths(await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']))
        .filter((rel) => rel.endsWith('/') && this.repositoryFolders(row.path, rel.slice(0, -1)).length > 0);
      const kept: string[] = [];
      for (const rel of new Set([...paths(await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])), ...repositories])) {
        const bare = rel.replace(/\/$/u, '');
        if (copies.some((to) => bare === to || bare.startsWith(`${to}/`))) continue;
        try {
          await lstatAsync(join(row.path, bare));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') continue; // tracked, and git deleted it
          throw error;
        }
        kept.push(rel);
      }
      return { paths: kept, excluded: new Set([...await this.nestedIgnored(row.path, kept), ...copies]) };
    } finally {
      await rmAsync(scratch, { recursive: true, force: true });
    }
  }

  /** A release that failed after its records (#427): `worktree.release-
   * aborted { id, path, preserved, snapshot, discarded, error }` names the
   * preserve folder and any snapshot ref already written, once per change
   * of them (a retry that reused both and failed again adds no row). */
  private recordAbortedRelease(row: WorktreeRecord, saved: { readonly preserved: SweepPreservation | null; readonly snapshot: SweepSnapshot | null; readonly discarded: string | null }, error: unknown): void {
    const preserved = saved.preserved === null ? null : { destination: saved.preserved.destination, files: saved.preserved.count };
    const snapshot = saved.snapshot === null ? null : { ref: saved.snapshot.ref, sha: saved.snapshot.sha, files: saved.snapshot.files };
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
 * that stays linked from outside it). An entry that is, or holds, a git
 * repository ({@link repositoryFolders}) is never deleted: its commits may
 * live nowhere else. */
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
  const [repository] = repositoryFolders(lanePath, entry, (dir, error) => {
    throw new Error(`${dir} could not be read to look for a git repository: ${oneLineErrorText(error instanceof Error ? error.message : error, 200)}`);
  });
  if (repository !== undefined) return `it holds a git repository (${repository}/.git)`;
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

/** The paths of the gitlinks a `git diff --cached --raw -z` shows leaving
 * the index (deleted, or replaced by a file): HEAD records them, the index
 * no longer does. */
function removedGitlinks(raw: string): string[] {
  const fields = raw.split('\0');
  const paths: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (/^:160000 \d{6} /u.test(fields[index]!)) paths.push(fields[index + 1]!);
  }
  return paths;
}

/** How deep GC looks for repositories nested in repositories (#427). */
const NESTED_DEPTH_LIMIT = 16;

/** How many levels below an ignored folder GC looks for a repository (#427). */
const IGNORED_REPO_DEPTH = 3;

/** The folders below `root` that are `rel` or lie in it and hold a `.git`
 * (#427), by their paths below `root`: `rel` itself and folders at most
 * {@link IGNORED_REPO_DEPTH} levels below it, never through a link, never
 * into a `node_modules`, never below a folder holding one. A folder that
 * cannot be read goes to `unreadable`. */
function repositoryFolders(root: string, rel: string, unreadable: (dir: string, error: unknown) => void): string[] {
  const found: string[] = [];
  const look = (at: string, depth: number): void => {
    if (basename(at) === 'node_modules') return;
    const dir = join(root, at);
    if (pathOnDisk(join(dir, '.git'))) {
      found.push(at);
      return;
    }
    if (depth >= IGNORED_REPO_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // A file holds no repository.
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') unreadable(dir, error);
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) look(`${at}/${entry.name}`, depth + 1);
  };
  look(rel, 0);
  return found;
}

/** How many commits at risk GC lists per nested repository (#427). */
const NESTED_COMMIT_LIMIT = 1000;

/** How many commits at risk a refusal names per nested repository. */
const NESTED_COMMITS_NAMED = 5;

/** A repository whose nested repositories are looked for (#427): the lane,
 * or a nested repository with a checkout. */
interface NestedParent {
  /** Its path in the lane ('' for the lane). */
  readonly path: string;
  /** Its checkout. */
  readonly checkout: string;
  /** Where its submodules keep their git data (`<git dir>/modules`). */
  readonly modules: string;
  /** The commit of it the lane's base records (`row.sha` for the lane). */
  readonly basePin: string | null;
  /** The main checkout's copy's `modules` folder, when there is one. */
  readonly mainModules: string | null;
}

/** A repository nested in the lane (#427). */
interface NestedRepo {
  /** Its path in the lane. */
  readonly path: string;
  /** Its submodule name (its path in its parent when `.gitmodules` names none). */
  readonly name: string;
  /** Its checkout holds a `.git`. */
  readonly populated: boolean;
  /** Its git data in the lane; null when the lane never initialized it. */
  readonly gitDir: string | null;
  /** The gitlink the lane's base records for it. */
  readonly basePin: string | null;
  /** The main checkout's own copy of it (it may not exist). */
  readonly mainCopy: string | null;
  /** Its `.gitmodules` at the lane's base declares its untracked content disposable. */
  readonly disposable: boolean;
  /** The commits its parent's HEAD and index record for it, named. */
  readonly gitlinks: readonly (readonly [string | undefined, string])[];
}

function nestedParent(child: NestedRepo, checkout: string): NestedParent {
  return {
    path: child.path,
    checkout,
    modules: join(child.gitDir ?? join(checkout, '.git'), 'modules'),
    basePin: child.basePin,
    mainModules: child.mainCopy !== null && existsSync(child.mainCopy) ? join(child.mainCopy, 'modules') : null,
  };
}

/** A nested repository's own state (#427): whether its index or working
 * tree holds a tracked change (staged or not; a change inside a repository
 * nested in it is judged there), and its untracked paths. */
function nestedStatus(checkout: string): { readonly modified: boolean; readonly untracked: readonly string[] } {
  const records = runGit(checkout, ['-c', 'diff.ignoreSubmodules=none', 'status', '--porcelain=v2', '-z', '--ignore-submodules=none', '--untracked-files=all'], { maxBuffer: LISTING_MAX_BUFFER }).split('\0');
  let modified = false;
  const untracked: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const kind = record.charAt(0);
    // A rename's original path follows it as its own field.
    if (kind === '2') index += 1;
    if (kind === '?') {
      if (record.length > 2) untracked.push(record.slice(2));
      continue;
    }
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
    const [, xy = '..', sub = 'N...'] = record.split(' ');
    if (sub.startsWith('S') && xy.charAt(0) === '.') continue;
    modified = true;
  }
  return { modified, untracked };
}

/** The commits a nested repository can reach that survive nowhere else
 * (#427): every commit reachable from its HEAD, branches, tags and stash,
 * from the reflogs of those, and from the gitlinks its parent records, that
 * is neither the lane's base pin for it (nor an ancestor of that), nor in
 * one of its remote-tracking refs, nor in the main checkout's own copy.
 * Bounded; the refusal's words name the first few. */
function nestedLostCommits(repo: NestedRepo, head: string | null): { readonly lost: readonly string[]; readonly states: readonly string[] } {
  const gitDir = repo.gitDir!;
  // `--work-tree` at the git folder itself: a module's core.worktree may name
  // a checkout that is gone (a staged git rm), and none of this reads one.
  const git = (dir: string, args: readonly string[], opts: SpawnGitOptions = {}): string => runGit(dir, ['--git-dir', dir, '--work-tree', dir, ...args], opts);
  const labels = new Map<string, string>();
  const name = (sha: string | null | undefined, what: string): void => {
    if (sha != null && /^[0-9a-f]{40,64}$/u.test(sha) && !labels.has(sha)) labels.set(sha, what);
  };
  name(head, 'its HEAD');
  for (const [sha, what] of repo.gitlinks) name(sha, what);
  for (const line of git(gitDir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', 'refs/stash']).split('\n')) {
    const [sha, ref = ''] = line.split(' ');
    name(sha, ref.startsWith('refs/heads/') ? `branch ${ref.slice('refs/heads/'.length)}` : ref.startsWith('refs/tags/') ? `tag ${ref.slice('refs/tags/'.length)}` : 'stash@{0}');
  }
  const reflogs = [...(head === null ? [] : ['HEAD']), '--branches', '--glob=refs/stas[h]'];
  for (const line of git(gitDir, ['log', '-g', '--format=%H %gd', ...reflogs, '--'], { maxBuffer: LISTING_MAX_BUFFER }).split('\n')) {
    const [sha, selector = ''] = line.split(' ');
    name(sha, selector.startsWith('stash@') ? selector : `in its reflog as ${selector}`);
  }
  if (labels.size === 0) return { lost: [], states: [] };
  const outside = (also: readonly string[]): string[] => git(gitDir, ['rev-list', '--ignore-missing', `--max-count=${String(NESTED_COMMIT_LIMIT + 1)}`, '--stdin'], {
    input: `${[...labels.keys(), '--not', '--remotes', ...(repo.basePin === null ? [] : [repo.basePin]), ...also].join('\n')}\n`,
  }).split('\n').filter((sha) => sha !== '');
  let lost = outside([]);
  // The main checkout's copy outlives the lane: what it holds survives.
  if (lost.length > 0 && repo.mainCopy !== null && existsSync(repo.mainCopy)) {
    const main = repo.mainCopy;
    const tips = [...git(main, ['for-each-ref', '--format=%(objectname)']).split('\n'), spawnGit(main, ['--git-dir', main, '--work-tree', main, 'rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim()]
      .filter((sha) => /^[0-9a-f]{40,64}$/u.test(sha));
    if (tips.length > 0) lost = outside(tips);
    if (lost.length > 0) {
      const present = new Set(git(main, ['cat-file', '--batch-check'], { input: `${lost.join('\n')}\n` }).split('\n')
        .filter((line) => !line.endsWith(' missing')).map((line) => line.split(' ')[0]));
      lost = lost.filter((sha) => !present.has(sha));
    }
  }
  const truncated = lost.length > NESTED_COMMIT_LIMIT;
  const named = [...lost].sort((left, right) => Number(!labels.has(left)) - Number(!labels.has(right))).slice(0, NESTED_COMMITS_NAMED);
  const rest = Math.min(lost.length, NESTED_COMMIT_LIMIT) - named.length;
  return {
    lost: lost.slice(0, NESTED_COMMIT_LIMIT),
    states: [
      ...named.map((sha) => `commit ${sha} (${labels.get(sha) ?? 'reachable from them'}) is on no remote-tracking ref and not in the main checkout's copy`),
      ...(rest > 0 ? [`${truncated ? 'more than ' : ''}${String(rest)} other commit(s) like them`] : []),
    ],
  };
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

/** Remove a tree, a link inside it as a link; a failed removal makes the
 * tree's folders writable (never following a link) and tries once more. */
function removeTreeSync(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // retried below once the tree is writable
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    try {
      if (!lstatSync(current).isDirectory()) continue;
      chmodSync(current, 0o700);
      for (const name of readdirSync(current)) stack.push(join(current, name));
    } catch {
      // gone, or not ours to change: the retry reports what stays
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/** A folder as the file system names it, to tell two spellings of one apart. */
function directoryKey(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir); // gone: its spelling is all there is
  }
}

/** Whether a path is a folder (never through a link) holding anything. */
function folderHoldsFiles(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
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
 * following a link, and nothing at a path in `excluded`. `rels` null:
 * everything under `root`. */
function contentFingerprint(root: string, rels: readonly string[] | null, excluded: ReadonlySet<string> = new Set()): string {
  const entries = new Set<string>();
  const visit = (rel: string): void => {
    if (excluded.has(rel)) return;
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
    // A FIFO, socket or device is never opened, as the copy never takes one.
    else if (stat.isFile()) entries.add(`${rel}\0file\0${fileHash(path)}`);
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
 * lane and digest (its id), naming each nested repository and what it
 * holds, what to do, and the digest; and, when an operator's discard named
 * an older digest, that the work changed (stop what writes into it). It
 * closes once the lane is gone. */
export function submoduleWorkNotice(input: { readonly worktree: WorktreeRecord; readonly submodules: readonly SubmoduleWork[]; readonly digest: string; readonly staleDiscard?: string | null }): {
  readonly id: string;
  readonly kind: typeof SUBMODULE_WORK_NOTICE_KIND;
  readonly routing: 'action-required';
  readonly severity: 'error';
  readonly title: string;
  readonly detail: string;
} {
  const { worktree, submodules, digest, staleDiscard = null } = input;
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
      `or ask the owner to discard exactly this work with an operator release that passes discard_submodule_work: "${digest}". Digest: ${digest}.` +
      `${staleDiscard === null ? '' : ` A discard named ${staleDiscard}, but the work changed since it was shown: ${SUBMODULE_WORK_CHANGING}.`}`,
  };
}

/** What a refusal says when a discard's digest no longer matches (#427):
 * the work changed, and if it keeps changing something is writing into it. */
const SUBMODULE_WORK_CHANGING = 'if it keeps changing, something is still writing into the submodule (a minion, a watcher or a build), so stop that process first, then discard the newest digest';

/** The kind of {@link submoduleWorkNotice}'s rows. */
export const SUBMODULE_WORK_NOTICE_KIND = 'worktree.submodule-work';

/** The id of a lane's submodule-work row for one digest. */
export function submoduleWorkNoticeId(laneId: string, digest: string): string {
  return `worktree-submodule-work:${laneId}:${digest}`;
}

/** Gru's row for a lane whose restore ran setup and did not get back what
 * setup made at bootstrap (#427): one per lane (its id). The lane stays
 * slim and is never slimmed again; the row closes once the lane is gone. */
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

/** Gru's row for a lane whose release is refused because it is a sparse
 * checkout (#427): one per lane (its id). It closes once the lane is gone. */
export function sparseCheckoutNotice(input: { readonly worktree: WorktreeRecord }): {
  readonly id: string;
  readonly kind: typeof SPARSE_CHECKOUT_NOTICE_KIND;
  readonly routing: 'action-required';
  readonly severity: 'error';
  readonly title: string;
  readonly detail: string;
} {
  const { worktree } = input;
  return {
    id: sparseCheckoutNoticeId(worktree.id),
    kind: SPARSE_CHECKOUT_NOTICE_KIND,
    routing: 'action-required',
    severity: 'error',
    title: `Lane ${worktree.id} (${worktree.repoName}) cannot be released: it is a sparse checkout`,
    detail:
      `Lane ${worktree.id} (job ${worktree.jobId ?? 'none'}) at ${worktree.path} is a sparse checkout (core.sparseCheckout is on), and GC cannot save its uncommitted work without risking a wrong tree, so its release is refused. ` +
      'Tell the minion to commit and push the lane\'s work, or to run git sparse-checkout disable in the lane, then release it again. ' +
      'GC disables the sparse checkout of new lanes itself when the repository keeps per-worktree config; a repository whose sparse checkout is in its shared config (core.sparseCheckout in .git/config) gives every new lane one.',
  };
}

/** The kind of {@link sparseCheckoutNotice}'s rows. */
export const SPARSE_CHECKOUT_NOTICE_KIND = 'worktree.sparse-checkout';

/** The id of a lane's sparse-checkout row. */
export function sparseCheckoutNoticeId(laneId: string): string {
  return `worktree-sparse-checkout:${laneId}`;
}

/** The kind of {@link restoreIncompleteNotice}'s rows. */
export const RESTORE_INCOMPLETE_NOTICE_KIND = 'worktree.restore-incomplete';

/** The id of a lane's restore-incomplete row. */
export function restoreIncompleteNoticeId(laneId: string): string {
  return `worktree-restore-incomplete:${laneId}`;
}

/** Whether a lane's git link reaches the repository at `repoPath` (#427 PR
 * 2b): the common git directory its `.git` file leads to is that
 * repository's. Read from the files, never through git, so a dangling link
 * is an answer, not a walk up to some repository around the lane. */
function laneReachesRepository(lanePath: string, repoPath: string): boolean {
  try {
    return repositoryCommonDirectory(lanePath) === repositoryCommonDirectory(repoPath);
  } catch {
    return false;
  }
}

/** Whether `repoPath` holds a repository (its common git directory can be
 * read from the files). */
function holdsRepository(repoPath: string): boolean {
  try {
    repositoryCommonDirectory(repoPath);
    return true;
  } catch {
    return false;
  }
}

/** Whether two paths are one place as the filesystem resolves them. */
function samePlace(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Whether `path` is a real folder (not a link) inside `root` as the
 * filesystem resolves both, so a delete never follows a link out of it. */
function realFolderUnder(root: string, path: string): boolean {
  const inside = (outer: string, inner: string): boolean => {
    const rel = relative(outer, inner);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  try {
    return inside(root, path) && lstatSync(path).isDirectory() && inside(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
}

/** An `origin` URL as the place it names (#427 PR 2b): host (lower case)
 * and path, with no scheme, user, port, trailing `/` or `.git`, so the
 * https and ssh spellings of one repository are the same
 * (`https://H/o/r.git`, `git@h:o/r`, `ssh://git@h:22/o/r/` → `h/o/r`). A
 * local path keeps its spelling, without a trailing `/` or `.git`. */
export function normalizedOriginUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, '').replace(/\.git$/u, '').replace(/\/+$/u, '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d*)?(\/.*)?$/iu.exec(trimmed);
  if (scheme !== null && !trimmed.toLowerCase().startsWith('file://')) return `${scheme[1]!.toLowerCase()}${scheme[2] ?? ''}`;
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/u.exec(trimmed);
  if (scp !== null && !/^[a-z]:$/iu.test(`${scp[1]!}:`)) return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+/u, '')}`;
  return trimmed;
}

/** Whether two `origin` URLs name the same repository once normalised. */
export function sameOriginUrl(a: string, b: string): boolean {
  return normalizedOriginUrl(a) === normalizedOriginUrl(b);
}

/** The identity of the repository at `repoPath` (#427 PR 2b): the root
 * commits reachable from all its refs (`--all`, so an orphan branch checked
 * out or a deepened shallow clone still overlaps) and its `origin` URL
 * (null when it has none). A git failure throws. */
export function repoIdentity(repoPath: string): RepoIdentity {
  return identityOf(repoPath, runGit(repoPath, ['rev-list', '--max-parents=0', '--all']), spawnGit(repoPath, ['config', '--get', 'remote.origin.url']));
}

/** {@link repoIdentity} off the event loop. */
async function repoIdentityAsync(repoPath: string): Promise<RepoIdentity> {
  return identityOf(repoPath, await runGitAsync(repoPath, ['rev-list', '--max-parents=0', '--all']), await spawnGitAsync(repoPath, ['config', '--get', 'remote.origin.url']));
}

function identityOf(repoPath: string, roots: string, origin: { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error: string | null }): RepoIdentity {
  if (origin.status !== 0 && origin.status !== 1) {
    throw new Error(`git config --get remote.origin.url failed (exit ${String(origin.status)}) in ${repoPath}: ${origin.stderr.trim() || origin.error || ''}`);
  }
  const url = origin.stdout.trim();
  return { roots: roots.split('\n').map((line) => line.trim()).filter((line) => line !== ''), origin: origin.status === 0 && url !== '' ? url : null };
}

/** A candidate's identity, read once per check. */
function cachedIdentity(candidate: string, cache: MoveCheckCache): RepoIdentity | { readonly error: unknown } {
  let found = cache.identities.get(candidate);
  if (found === undefined) {
    try {
      found = repoIdentity(candidate);
    } catch (error) {
      found = { error };
    }
    cache.identities.set(candidate, found);
  }
  return found;
}

/** The root commits of a lane's base commit in a candidate, or that the
 * candidate does not hold it. */
function baseRoots(candidate: string, sha: string): BaseRoots {
  const base = spawnGit(candidate, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (base.status === 1) return { missing: true };
  if (base.status !== 0) return { error: base.stderr.trim() || base.error || `git rev-parse exited ${String(base.status)}` };
  try {
    return { roots: runGit(candidate, ['rev-list', '--max-parents=0', sha]).split('\n').filter((line) => line !== '') };
  } catch (error) {
    return { error };
  }
}

/** {@link baseRoots} off the event loop. */
async function baseRootsAsync(candidate: string, sha: string): Promise<BaseRoots> {
  const base = await spawnGitAsync(candidate, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (base.status === 1) return { missing: true };
  if (base.status !== 0) return { error: base.stderr.trim() || base.error || `git rev-parse exited ${String(base.status)}` };
  try {
    return { roots: (await runGitAsync(candidate, ['rev-list', '--max-parents=0', sha])).split('\n').map((line) => line.trim()).filter((line) => line !== '') };
  } catch (error) {
    return { error };
  }
}

/** Whether `candidate` (its identity `found`) holds the repository a lane
 * was made in (#427 PR 2b): by the lane's recorded identity, or, with none,
 * by its base commit's roots in the candidate (`base`). A git failure is
 * `unknown`, never a mismatch. */
function repositoryVerdict(candidate: string, found: RepoIdentity | { readonly error: unknown }, recorded: RepoIdentity | null, base: BaseRoots | null, sha: string): RepositoryVerdict {
  const unknown = (error: unknown): RepositoryVerdict =>
    ({ kind: 'unknown', reason: `${candidate} could not be compared with the lane's repository: ${oneLineErrorText(error instanceof Error ? error.message : error, 400)}` });
  if ('error' in found) return unknown(found.error);
  let roots: readonly string[];
  if (recorded !== null) {
    roots = recorded.roots;
  } else if (base === null) {
    return unknown(`the root commits of the lane's base commit ${sha} were not read`);
  } else if ('missing' in base) {
    return { kind: 'different', reason: `${candidate} does not hold the lane's base commit ${sha}` };
  } else if ('error' in base) {
    return unknown(base.error);
  } else {
    roots = base.roots;
  }
  if (!roots.some((root) => found.roots.includes(root))) {
    return { kind: 'different', reason: `${candidate} shares no root commit with the lane's repository (${roots.join(', ') || 'none recorded'})` };
  }
  if (recorded?.origin != null && found.origin !== null && !sameOriginUrl(recorded.origin, found.origin)) {
    return { kind: 'different', reason: `${candidate}'s origin is ${found.origin}, the lane's repository's was ${recorded.origin}` };
  }
  return { kind: 'same', byBaseOnly: recorded === null };
}

/** {@link spawnGit} off the event loop (#427 PR 2b): git's exit status and
 * output, never a rejection. */
function spawnGitAsync(repoPath: string, args: readonly string[]): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error: string | null }> {
  return new Promise((resolveOut) => {
    const child = execFile('git', [...args], { cwd: repoPath, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, env: repositoryGitEnv(false) }, (error, stdout, stderr) => {
      const code = (error as { readonly code?: unknown } | null)?.code;
      resolveOut({
        status: error === null ? 0 : typeof code === 'number' ? code : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: error === null || typeof code === 'number' ? null : String(error),
      });
    });
    child.stdin?.end();
  });
}

/**
 * Why a lane's administration changing from `previous` (the one its handoff
 * was issued with) to `admin` is not explained by a move of its repository
 * (#427 PR 2b), or null when it is. A move, or a link left at the
 * repository's old place, keeps the administration's id (its name under
 * `worktrees/`), leaves nothing at the old place but a link to the new one,
 * and leaves git registering the lane exactly once in its common directory
 * (`git worktree list`); a second administration pointed at the lane is
 * none of these.
 */
function unexplainedAdminChange(lanePath: string, previous: string, admin: string, common: string): string | null {
  if (basename(previous) !== basename(admin)) {
    return `its .git file names the administration ${admin}, not the one its handoff was issued with (${previous}): the administration's id changed, which no move does`;
  }
  let earlier: string | null = null;
  try {
    earlier = realpathSync(previous);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  if (earlier !== null && earlier !== admin) return `the administration its handoff was issued with (${previous}) is still there beside ${admin}`;
  const lane = realpathSync(lanePath);
  const listing = runGit(common, ['--git-dir', common, 'worktree', 'list', '--porcelain', '-z']);
  const registered = listing.split('\0').filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length))
    .filter((tree) => {
      try {
        return realpathSync(tree) === lane;
      } catch {
        return tree === lane;
      }
    }).length;
  return registered === 1 ? null : `git registers the lane ${String(registered)} times in ${common}, not once`;
}

/** A word a POSIX shell reads back as itself: as it is when it holds only
 * characters no shell treats specially, else single-quoted. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replace(/'/gu, `'\\''`)}'`;
}

/** A lane id as one ref-name component: as it is when git accepts it there,
 * else hex-encoded (a job's lane id already names its `gru/<id>` branch). */
export function preservedRefComponent(id: string): string {
  const plain = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(id) && !id.includes('..') && !id.endsWith('.lock') && !id.endsWith('.');
  return plain ? id : `x-${Buffer.from(id, 'utf8').toString('hex')}`;
}

/** Directory sanity for option wiring (fail loud at boot, not mid-heist). */
export function ensureDirectoryEmptyOrMissing(path: string): boolean {
  if (!existsSync(path)) return true;
  return readdirSync(path).length === 0;
}
