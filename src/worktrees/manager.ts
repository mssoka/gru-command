import { readWorktreeMetadata, repositoryCommonDirectory, capturePortLaneHandoff, captureCwdHandoff, beginLaneHandoff, pendingLaneHandoffPublished, completeLaneHandoff, rememberManagedLane, registerHandoffManager, assertPendingLaneHandoff, captureCleanupHandoff, assertLaneResourcesAbsent, WorktreeHandoffUnresolvedError, prepareLaneRebind, publishLaneRebind, settleLaneRebind, laneReceiptStale, laneCompletionsOnce, type LaneCompletions } from './handoff.js';
import { CreationIntentError, RetainedCreationFailedError, RetainedCreationRefusalError, clearCreationIntent, readCreationIntent, writeCreationIntent, type CreationIntent, type CreationIntentLane, type RetainedReceiptExpectation } from './creation-intent.js';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
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
import type { Socket } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { LedgerApi, WorktreeBaseSource, WorktreeRecord } from '../ledger/api.js';
import { applyWorktreeManifest, loadWorktreeManifest, MANIFEST_PATH, parseWorktreeManifest, WorktreeSetupError, type WorktreeManifest } from './manifest.js';
import { reclaimIgnored, reclaimState, reclaimTrackedFiles, removeTree, treeUsage } from './reclaim.js';
import { redactedText } from '../decisions/questions.js';
import { boundedTail, recordedTail, redactCredentialWindow } from '../redaction.js';
import { oneLineErrorText } from '../property/error-text.js';
import { repositoryGitEnv } from '../dispatch/perkins-review/artifacts.js';
import { readLaneTokens, readProcessFacts, type LaneTokenRead, type LaneTokenReader, type ProcessFacts } from './lane-provenance.js';
import type { ManagedRepoPath } from '../repos/managed-names.js';
import { assertSafeRequirementsPatch, originIdentitySha256, readPreBootstrapDependencyPatchPackage, PreBootstrapPatchError, type LoadedPreBootstrapPatch } from './prebootstrap-patch.js';

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
 *     FIRST, processes rooted in the tree enumerated BEFORE removal; the
 *     lane's own (GC's tracked services, and processes carrying the lane's
 *     token, #486) are reaped, any other live process PAUSES the sweep and
 *     asks (fail-loud escalation, never a silent kill); then worktree
 *     removal + containment-verified branch delete.
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
  /** Its working directory, when the listing read it (#486: the owner's
   * card names it). */
  readonly cwd?: string;
}

/** #486: why GC did not stop a process a sweep paused on by itself. */
export type PausedProcessProvenance =
  /** It carries this lane's token, but a session GC runs in the lane was
   * busy, or it outlived the stop. */
  | 'this-lane'
  /** It carries another lane's token. */
  | 'other-lane'
  /** GC read its environment, and it carries no lane token. */
  | 'no-token'
  /** GC cannot read its environment (a system binary such as `/bin/sh` on
   * macOS, a non-dumpable process on Linux, another platform) or it is gone. */
  | 'unreadable';

/** #486: a process a sweep paused on, as the owner's card describes it. */
export interface PausedProcess {
  readonly pid: number;
  readonly command: string;
  /** The executable's name (`agent-browser`), else the command's first word. */
  readonly name: string;
  /** When it started (ISO), null when unknown. */
  readonly startedAt: string | null;
  readonly cwd: string | null;
  readonly provenance: PausedProcessProvenance;
  /** The lane whose token it carries (`other-lane`), else null. */
  readonly otherLane: string | null;
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

/** A process cwd belongs to the tree when it IS the tree or sits under it.
 * Linux names a removed directory `<path> (deleted)`: a process that
 * outlived its swept tree is still rooted in it (#464). */
function cwdInsideTree(cwd: string, treePath: string): boolean {
  const path = cwd.endsWith(' (deleted)') ? cwd.slice(0, -' (deleted)'.length) : cwd;
  return path === treePath || path.startsWith(`${treePath}/`);
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
  return treeProcesses(treePath, listedProcesses(execFileSyncGuard('ps', ['-axo', 'pid=,command='])), processCwds());
}

/** The processes a `ps -axo pid=,command=` listing and the per-process
 * cwds tie to a tree (by argv path boundary, or by cwd). */
function treeProcesses(treePath: string, listed: readonly { readonly pid: number; readonly command: string }[],
  cwds: Map<number, string> | null): readonly TreeProcess[] {
  // Compare against BOTH the registered path and its realpath: the OS
  // reports resolved paths (/var → /private/var) while argv keeps the
  // spelling the spawner used.
  const candidates = new Set([treePath]);
  try {
    candidates.add(realpathSync(treePath));
  } catch {
    // A swept tree is resolved through its nearest surviving ancestor, so a
    // process that outlived it is still matched by its resolved cwd (#464).
    for (let ancestor = dirname(treePath); ; ancestor = dirname(ancestor)) {
      try {
        candidates.add(join(realpathSync(ancestor), relative(ancestor, treePath)));
        break;
      } catch {
        if (dirname(ancestor) === ancestor) break; /* the sweep's own guards handle a missing tree */
      }
    }
  }
  const processes: TreeProcess[] = [];
  for (const { pid, command } of listed) {
    // Registry paths only: every match names the registered tree itself.
    if ([...candidates].some((candidate) => commandReferencesTree(command, candidate))) {
      const cwd = cwds?.get(pid);
      processes.push({ pid, command, evidence: 'argv', ...(cwd !== undefined ? { cwd } : {}) });
      continue;
    }
    if (cwds !== null) {
      const cwd = cwds.get(pid);
      if (cwd !== undefined && [...candidates].some((candidate) => cwdInsideTree(cwd, candidate))) {
        processes.push({ pid, command, evidence: 'cwd', cwd });
      }
    }
  }
  return processes;
}

/** Every other process a `ps -axo pid=,command=` listing names. */
function listedProcesses(out: string): readonly { readonly pid: number; readonly command: string }[] {
  const listed: { pid: number; command: string }[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const command = trimmed.slice(space + 1).trim();
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    listed.push({ pid, command });
  }
  return listed;
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
export async function psEnumeratorAsync(treePath: string, opts: ProcessListingOptions): Promise<readonly TreeProcess[]> {
  return (await processListingAsync(opts))(treePath);
}

/** {@link psEnumeratorAsync}'s options. */
export interface ProcessListingOptions {
  readonly timeoutMs?: number;
  readonly onCwdError: (error: unknown) => void;
  readonly listCwds?: (timeoutMs: number) => Promise<Map<number, string> | null>;
}

/** One process listing (`ps` and the working directories, read once, off
 * the event loop, as {@link psEnumeratorAsync} reads them) that answers for
 * any number of trees (#427 PR 3: the disk budget lists once per pass, not
 * once per lane). */
export async function processListingAsync(opts: ProcessListingOptions): Promise<(treePath: string) => readonly TreeProcess[]> {
  return (await processTableAsync(opts)).rootedIn;
}

/** {@link processListingAsync}'s one listing, which also answers which
 * processes name a token in their command line (#464: a Claude review CLI
 * carries its session id in argv). `cwdsListed` is false when no working
 * directories were read (`onCwdError` was told, or the platform has no
 * source), so a caller that needs the whole picture refuses rather than
 * trusting argv alone. */
export interface ProcessTable {
  readonly rootedIn: (treePath: string) => readonly TreeProcess[];
  readonly naming: (token: string) => readonly TreeProcess[];
  readonly cwdsListed: boolean;
}

export async function processTableAsync(opts: ProcessListingOptions): Promise<ProcessTable> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const [listed, cwds] = await Promise.allSettled([
    execFileBounded('ps', ['-axo', 'pid=,command='], timeoutMs),
    (opts.listCwds ?? processCwdsAsync)(timeoutMs),
  ]);
  if (listed.status === 'rejected') throw listed.reason instanceof Error ? listed.reason : new Error(String(listed.reason));
  if (cwds.status === 'rejected') opts.onCwdError(cwds.reason);
  const out = listed.value;
  const cwdMap = cwds.status === 'fulfilled' ? cwds.value : null;
  const processes = listedProcesses(out);
  return {
    rootedIn: (treePath) => treeProcesses(treePath, processes, cwdMap),
    naming: (token) => processes.filter((entry) => entry.command.includes(token))
      .map((entry) => ({ ...entry, evidence: 'argv' as const })),
    cwdsListed: cwdMap !== null,
  };
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

/** A release that does not pause to ask (#427 PR 3: the disk budget's,
 * which nobody answers) met processes rooted in the lane. Refused by name
 * before anything is removed: the tree is retained, nothing is killed and
 * no owner card is raised. */
export class LaneLiveProcessError extends Error {
  constructor(readonly path: string, readonly processes: readonly TreeProcess[]) {
    super(`sweep refused: ${String(processes.length)} live process(es) rooted in ${path} (pids ${processes.map((proc) => proc.pid).join(', ')}), and this release does not pause to ask — the tree is retained and nothing is killed`);
    this.name = 'LaneLiveProcessError';
  }
}

/** A disk budget release (#427 PR 3) could not read the working
 * directories of the processes it listed (`lsof` timed out or failed,
 * `/proc` could not be read, or the platform has no such listing), and a
 * listing by command line alone misses a process rooted in the lane only
 * by its working directory. Refused by name before anything is removed:
 * the tree is retained and nothing is killed. */
export class LaneProcessListingError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`sweep refused: cannot prove no process works in ${path} — the processes' working directories could not be listed (${detail}), and a listing by command line alone is partial; the tree is retained and nothing is killed`);
    this.name = 'LaneProcessListingError';
  }
}

/** A disk budget release (#427 PR 3, which a timer drives) asked origin
 * off the event loop, and origin did not answer within the manager's fetch
 * budget. Refused by name before anything is touched: the tree is retained,
 * and nothing waits on the remote. */
export class LaneRemoteTimeoutError extends Error {
  constructor(readonly path: string, readonly command: string, readonly timeoutMs: number) {
    super(`sweep refused: origin did not answer git ${command} within ${String(timeoutMs)} ms, so fresh required containment cannot be proven for ${path} — the tree is retained; release again once origin answers`);
    this.name = 'LaneRemoteTimeoutError';
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
  /** #427 PR 3: what a live process rooted in the lane does to the release.
   * `pause` (the default) records it and asks ({@link onSweepPaused});
   * `refuse` throws {@link LaneLiveProcessError} instead, for a caller nobody
   * answers (the disk budget): no pause, no card, and no process is reaped
   * or killed, GC's own services included. */
  readonly onLiveProcess?: 'pause' | 'refuse';
  /** #486: with `confirmKill`, the pids the owner acknowledged (the card
   * they answered names them): only recorded live processes among them are
   * killed. Omitted = every recorded live process. */
  readonly confirmKillPids?: readonly number[];
  /** #427 PR 3: a release the disk budget starts (a timer drives it, and
   * nobody waits on it) never blocks the event loop on the network or on a
   * large tree:
   * - a lane whose folder is already gone is reconciled without asking
   *   origin anything;
   * - otherwise it first proves fresh required containment (as
   *   `requireReleaseProofs` does) off the event loop, each call to origin
   *   bounded by the manager's fetch budget: origin not answering in time
   *   refuses it by name ({@link LaneRemoteTimeoutError}) before anything is
   *   touched, never a wait;
   * - its process check lists off the event loop, and a listing that could
   *   not read the processes' working directories refuses it
   *   ({@link LaneProcessListingError}) rather than trust command lines
   *   alone;
   * - its removal runs off the event loop;
   * - after the removal it never asks origin again: the lane's branch is
   *   retained (lossless; `branch: 'retained-budget'` on `worktree.swept`
   *   and `worktree.reconciled`) for a later release or the autopilot to
   *   dispose of, and its `freshHead` is the one its proof resolved. */
  readonly diskBudget?: boolean;
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
  /** A disk budget release ({@link SweepRequest.diskBudget}), with the head
   * its proof resolved; null for every other release. */
  readonly budget: { readonly freshHead: string } | null;
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
  /** Private instance-owned package root required for pre-bootstrap edits. */
  readonly preBootstrapPatchRoot?: string;
  /** Grace between the acknowledged SIGTERM and the SIGKILL (ms). */
  readonly killGraceMs?: number;
  /** How long an exited job branch-creation Git child's pipes are still
   * read for their own close, the producer's settlement (default 10 min). */
  readonly creationCloseWindowMs?: number;
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
  /** Escalation when a sweep pauses on live processes (fail-loud ask).
   * `pauseId` names this pause (its `worktree.paused` event carries it as
   * `pause_id`); `details` say what each process is and why GC did not stop
   * it on its own (#486). */
  readonly onSweepPaused?: (input: {
    readonly worktree: WorktreeRecord;
    readonly processes: readonly TreeProcess[];
    readonly pauseId: string;
    readonly details: readonly PausedProcess[];
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
  /** The processes rooted in a tree (default {@link psEnumerator}). A disk
   * budget release ({@link SweepRequest.diskBudget}) lists off the event
   * loop ({@link psEnumeratorAsync}), unless this is given: then it answers
   * that release too. */
  readonly enumerateProcesses?: ProcessEnumerator;
  /** Seam: the processes' working directories a disk budget release's
   * listing reads (default `/proc` on Linux, `lsof` on macOS). */
  readonly listProcessCwds?: (timeoutMs: number) => Promise<Map<number, string> | null>;
  /** #486 seam: reads the lane tokens of listed processes (default
   * {@link readLaneTokens}). */
  readonly readLaneTokens?: LaneTokenReader;
  /** #486 seam: the executable name and start time of the processes a pause
   * names (default {@link readProcessFacts}). */
  readonly readProcessFacts?: (pids: readonly number[]) => Promise<ReadonlyMap<number, ProcessFacts>>;
  /** #486: no session GC runs in the lane is busy (the runtime registry's
   * `laneQuiet`). While one is, the processes carrying the lane's token may
   * be that session's own, and none is stopped. Omitted = quiet. */
  readonly laneQuiet?: (laneId: string) => boolean;
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
 * discard), not judged now (`reason`, judged again at the next check), or
 * deferred (the check spent its repairs, {@link MOVED_LANES_PER_CHECK}
 * lanes or {@link MOVED_CHECK_REPAIR_MS}; the caller's next slice repairs
 * it). */
export type RepoMoveOutcome =
  | { readonly status: 'repaired'; readonly lane: WorktreeRecord; readonly from: string; readonly to: string }
  | { readonly status: 'mismatch'; readonly lane: WorktreeRecord; readonly candidate: string; readonly reason: string }
  | { readonly status: 'unresolved'; readonly lane: WorktreeRecord; readonly reason: string }
  /** Its administration changed with no move of its repository to explain
   * it: nothing is re-bound or recorded, and its custody stays refused. */
  | { readonly status: 'tampered'; readonly lane: WorktreeRecord; readonly reason: string }
  | { readonly status: 'deferred'; readonly lane: WorktreeRecord };

/** The lanes one moved-repository check repairs at most (#427 PR 2b): the
 * check runs on the event loop, and a repair takes tens of milliseconds, so
 * one check stays well under a second; the rest are deferred to the next
 * slice (the maintenance reconcile runs slices, yielding between them,
 * until no lane is deferred). */
export const MOVED_LANES_PER_CHECK = 10;

/** How long one moved-repository check repairs (#427 PR 2b): once this much
 * has passed since it began, it starts no further repair (it always makes
 * one), so a slow disk or a loaded machine still keeps it well under a
 * second. */
export const MOVED_CHECK_REPAIR_MS = 250;

/** What one moved-repository check reads once (#427 PR 2b): where each
 * managed name resolves, each candidate's identity (its root set), the root
 * commits of a base commit in a candidate (`<candidate>\0<sha>`), every
 * lane's completion facts (on first use); and when it began
 * (`performance.now()`) and how many lanes it repaired so far. */
interface MoveCheckCache {
  readonly began: number;
  readonly places: Map<string, ManagedRepoPath>;
  readonly identities: Map<string, RepoIdentity | { readonly error: unknown }>;
  readonly baseRoots: Map<string, BaseRoots>;
  readonly completions: LaneCompletions;
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

function preBootstrapSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function syncPatchDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    try { fsyncSync(fd); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
    }
  } finally { closeSync(fd); }
}

function gitTreeWithRequirementsPatch(repoPath: string, baseSha: string, requirementsBytes: Buffer): string {
  // Compute the virtual tree hash without a temporary index or writing any
  // blobs/trees into the source repository's shared object store.
  const format = runGit(repoPath, ['rev-parse', '--show-object-format']);
  if (format !== 'sha1' && format !== 'sha256') throw new Error(`unsupported Git object format ${format}`);
  const listing = spawnSync('git', ['ls-tree', '-z', baseSha], {
    cwd: repoPath,
    encoding: null,
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
    env: repositoryGitEnv(false),
  });
  if (listing.status !== 0 || listing.stdout === null) {
    throw new Error(`git ls-tree failed while computing the prebootstrap tree (${String(listing.stderr ?? listing.error ?? 'unknown error')})`);
  }
  const hashObject = (type: 'blob' | 'tree', body: Buffer): Buffer => createHash(format)
    .update(`${type} ${body.length}\0`, 'ascii').update(body).digest();
  const replacementBlob = hashObject('blob', requirementsBytes);
  const entries: Buffer[] = [];
  let offset = 0;
  let replaced = false;
  while (offset < listing.stdout.length) {
    const end = listing.stdout.indexOf(0, offset);
    if (end < 0) throw new Error('git ls-tree returned a truncated NUL-delimited listing');
    const record = listing.stdout.subarray(offset, end);
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('git ls-tree returned a malformed entry');
    const [mode, type, objectId] = record.subarray(0, tab).toString('ascii').split(' ');
    const name = record.subarray(tab + 1);
    if (mode === undefined || type === undefined || objectId === undefined) throw new Error('git ls-tree returned an incomplete entry header');
    const objectBytes = name.equals(Buffer.from('requirements.txt', 'utf8'))
      ? (() => {
          if (type !== 'blob' || replaced) throw new Error('base tree has an invalid requirements.txt entry');
          replaced = true;
          return replacementBlob;
        })()
      : Buffer.from(objectId, 'hex');
    const serializedMode = mode === '040000' ? '40000' : mode;
    entries.push(Buffer.concat([Buffer.from(`${serializedMode} `, 'ascii'), name, Buffer.from([0]), objectBytes]));
    offset = end + 1;
  }
  if (!replaced) throw new Error('base tree has no root requirements.txt entry');
  return hashObject('tree', Buffer.concat(entries)).toString('hex');
}

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
  /** The lane this creation belongs to (issue #453). */
  readonly lane: CreationIntentLane;
  readonly baseSource: WorktreeBaseSource | null;
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

/** The origin default branch as resolved ({@link WorktreeManager}'s
 * `resolveDefaultBranch`). */
interface DefaultBranch {
  readonly branch: string | null;
  readonly liveDetail: string | null;
  readonly authoritativeAbsence: boolean;
  /** True ONLY when the LIVE probe named the branch — a cache-guessed
   * default is never verified freshness (Perkins r6 B1). */
  readonly verified: boolean;
}

/** A fetched origin branch's tip, or why it could not be had. */
type OriginTip = { ok: true; sha: string } | { ok: false; detail: string };

/** One git call of a base resolution (#427 PR 3). The resolution is written
 * once, as the calls it makes ({@link GitSteps}), and run on the event loop
 * ({@link runGitSteps}, as every lane creation and release does) or off it
 * ({@link runGitStepsAsync}, the proof of a release a timer drives). */
interface GitStep {
  readonly args: readonly string[];
  readonly opts: Pick<SpawnGitOptions, 'timeoutMs' | 'noPrompt'>;
}
type GitOutcome = ReturnType<typeof spawnGit>;
type GitSteps<T> = Generator<GitStep, T, GitOutcome>;

/** Run the steps' git calls on the event loop, as {@link spawnGit} runs them. */
function runGitSteps<T>(repoPath: string, steps: GitSteps<T>): T {
  let step = steps.next();
  while (step.done !== true) step = steps.next(spawnGit(repoPath, step.value.args, step.value.opts));
  return step.value;
}

/** Run the steps' git calls off the event loop (#427 PR 3). A call that
 * runs past its `timeoutMs` is ended and rejects with `timedOut`'s error:
 * the caller refuses, it never waits on the remote. */
async function runGitStepsAsync<T>(repoPath: string, steps: GitSteps<T>, timedOut: (command: string, timeoutMs: number) => Error): Promise<T> {
  let step = steps.next();
  while (step.done !== true) {
    const { args, opts } = step.value;
    const outcome = await spawnGitAsync(repoPath, args, opts);
    if (outcome.timedOut) throw timedOut(args.join(' '), opts.timeoutMs ?? 0);
    step = steps.next(outcome);
  }
  return step.value;
}

/** A git call that must succeed: its trimmed output, or a throw as
 * {@link runGit} throws. */
function* gitOk(repoPath: string, args: readonly string[]): GitSteps<string> {
  const { status, stdout, stderr, error } = yield { args, opts: {} };
  if (status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${status}) in ${repoPath}: ${stderr.trim() || error || stdout.trim()}`);
  }
  return stdout.trim();
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
  /** {@link enumerate} off the event loop, for a disk budget release (#427
   * PR 3): a listing that could not read the processes' working directories
   * rejects ({@link LaneProcessListingError}), never answers by command
   * lines alone. */
  private readonly enumerateAsync: (treePath: string) => Promise<readonly TreeProcess[]>;
  private readonly fetchTimeoutMs: number;
  /** Same-repo serialization (ruling 18e): one creation at a time. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();
  /** Per-lane serialization of a slim and the restore before a turn or a
   * verification (#427): a restore that waits here runs after the slim. */
  private readonly laneLocks = new Map<string, Promise<unknown>>();
  /** Set by finishSweep's tail guard; drained by recordSweepEvent. */
  private tailFailure: string | null = null;
  /** #486: lanes with an after-turn reap waiting for the lane's lock. */
  private readonly laneReapsWaiting = new Set<string>();
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
    const injected = opts.enumerateProcesses;
    const listCwds = opts.listProcessCwds ?? processCwdsAsync;
    this.enumerateAsync = injected !== undefined
      ? async (treePath) => injected(treePath)
      : (treePath) => psEnumeratorAsync(treePath, {
        listCwds: async (timeoutMs) => {
          const cwds = await listCwds(timeoutMs);
          if (cwds === null) throw new Error(`${process.platform} has no listing of process working directories GC can read`);
          return cwds;
        },
        onCwdError: (error) => {
          throw new LaneProcessListingError(treePath, oneLineErrorText(error instanceof Error ? error.message : error, 400));
        },
      });
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
   * surfaced by an FYI) — staleness is visible, never silent. Each call to
   * origin is bounded by the manager's fetch budget.
   */
  private resolveBase(repoPath: string): ResolvedBase {
    return runGitSteps(repoPath, this.baseSteps(repoPath, this.fetchTimeoutMs));
  }

  /** {@link resolveBase}'s git calls, which {@link runGitSteps} runs on the
   * event loop and {@link runGitStepsAsync} off it (#427 PR 3). */
  private *baseSteps(repoPath: string, timeoutMs: number): GitSteps<ResolvedBase> {
    const resolved = yield* this.defaultBranchSteps(timeoutMs);
    const defaultBranch = resolved.branch;
    const localHead = (): GitSteps<string> => gitOk(repoPath, ['rev-parse', 'HEAD']);
    if (defaultBranch === null) {
      const detail = resolved.authoritativeAbsence
        ? `origin default branch is unresolvable — the reachable remote's HEAD names no branch ` +
          `(${resolved.liveDetail ?? 'no symref'}); cached origin/HEAD deliberately not trusted`
        : `origin default branch is unresolvable — live probe: ${
            resolved.liveDetail ?? 'named no branch'
          }, no cached origin/HEAD`;
      this.log('warn', 'base resolution degraded to the local checkout', { repo: repoPath, detail });
      return { sha: yield* localHead(), baseSource: 'local-head-fallback', defaultBranch: null, fallbackDetail: detail };
    }
    const fetched = yield* this.originTipSteps(defaultBranch, timeoutMs);
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
        sha: yield* localHead(),
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
      sha: yield* localHead(),
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
  private *liveDefaultBranchSteps(
    timeoutMs: number,
  ): GitSteps<{
    readonly branch: string | null;
    readonly detail: string | null;
    /** True when the probe SUCCEEDED and authoritatively found no default
     * (exit 0, no symref line): the reachable remote names no branch, so
     * no cached value may speak for it (Perkins R5 — consulting the
     * cache here selected a demoted-but-fetchable branch and recorded it
     * as 'origin'). False when the probe failed/unreachable — the cache
     * remains the declared offline guess. */
    readonly authoritativeAbsence: boolean;
  }> {
    const live = yield { args: ['ls-remote', '--symref', 'origin', 'HEAD'], opts: { timeoutMs, noPrompt: true } };
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
  private resolveDefaultBranch(repoPath: string): DefaultBranch {
    return runGitSteps(repoPath, this.defaultBranchSteps(this.fetchTimeoutMs));
  }

  /** {@link resolveDefaultBranch}'s git calls (#427 PR 3). */
  private *defaultBranchSteps(timeoutMs: number): GitSteps<DefaultBranch> {
    const live = yield* this.liveDefaultBranchSteps(timeoutMs);
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
    const cached = yield { args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], opts: {} };
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
  private fetchOriginTip(repoPath: string, branch: string): OriginTip {
    return runGitSteps(repoPath, this.originTipSteps(branch, this.fetchTimeoutMs));
  }

  /** {@link fetchOriginTip}'s git calls (#427 PR 3). */
  private *originTipSteps(branch: string, timeoutMs: number): GitSteps<OriginTip> {
    const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
    const fetched = yield { args: ['fetch', '--no-tags', 'origin', refspec], opts: { timeoutMs, noPrompt: true } };
    if (fetched.status !== 0) {
      const detail = fetched.stderr.trim() || fetched.error || fetched.stdout.trim();
      return {
        ok: false,
        detail: redactedText(detail === '' ? `git fetch exited ${String(fetched.status)}` : detail, 500),
      };
    }
    const tip = yield { args: ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], opts: {} };
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

  private assertPreBootstrapAuthority(jobId: string, patch: LoadedPreBootstrapPatch): void {
    const expected = patch.package.authority;
    const current = this.opts.ledger.directiveCurrentAuthority(jobId);
    if (current.contractSha256 !== expected.contractSha256 || current.workRevision !== expected.workRevision || current.authorityEpoch !== expected.authorityEpoch) {
      throw new PreBootstrapPatchError('authority_mismatch', `job "${jobId}" prebootstrap contract/revision/authority changed`);
    }
    if (this.opts.ledger.getJob(jobId)?.status !== 'working') {
      throw new PreBootstrapPatchError('authority_mismatch', `job "${jobId}" is no longer working; prebootstrap patch refused`);
    }
  }

  private assertPreBootstrapAdmission(jobId: string, patch: LoadedPreBootstrapPatch): void {
    const rows = this.opts.ledger.listJobEvents(jobId, { kinds: ['job.prebootstrap-patch-admitted'], limit: 10 });
    const event = rows.at(-1);
    const payload = event?.payload as Record<string, unknown> | null;
    const pkg = patch.package;
    if (event === undefined || rows.length !== 1 || typeof payload !== 'object' || payload === null ||
        payload['version'] !== 1 || payload['package_file'] !== patch.reference.packageFile ||
        payload['package_sha256'] !== patch.packageBytesSha256 ||
        payload['request_payload_sha256'] !== patch.requestPayloadSha256 ||
        payload['intake_identity_sha256'] !== patch.intakeIdentitySha256 ||
        payload['repository_path'] !== pkg.repository.path || payload['origin_sha256'] !== pkg.repository.originSha256 ||
        payload['expected_base_sha'] !== pkg.base.commit || payload['expected_base_tree'] !== pkg.base.tree ||
        payload['contract_sha256'] !== pkg.authority.contractSha256 || payload['work_revision'] !== pkg.authority.workRevision ||
        payload['authority_epoch'] !== pkg.authority.authorityEpoch || JSON.stringify(payload['allowlist']) !== JSON.stringify(pkg.allowlist)) {
      throw new PreBootstrapPatchError('admission_receipt_mismatch', `job "${jobId}" has no exact durable prebootstrap admission receipt`);
    }
  }

  private assertPreBootstrapSource(repoPath: string, patch: LoadedPreBootstrapPatch, baseSha?: string, baseTree?: string, baseSource?: WorktreeBaseSource | null): string {
    const pkg = patch.package;
    if (realpathSync(repoPath) !== pkg.repository.path) {
      throw new PreBootstrapPatchError('source_mismatch', 'prebootstrap package names a different canonical repository path');
    }
    const origin = spawnGit(repoPath, ['remote', 'get-url', 'origin'], { noPrompt: true });
    if (origin.status !== 0 || origin.stdout.trim() === '') throw new PreBootstrapPatchError('source_mismatch', 'prebootstrap patch requires the repository origin identity');
    const originSha256 = originIdentitySha256(origin.stdout);
    if (originSha256 !== pkg.repository.originSha256) throw new PreBootstrapPatchError('source_mismatch', 'prebootstrap package names a different repository origin');
    if (baseSha !== undefined && (baseSource !== 'origin' || baseSha !== pkg.base.commit)) {
      throw new PreBootstrapPatchError('base_mismatch', 'prebootstrap package base is not the exact freshly fetched origin head');
    }
    const actualSha = baseSha ?? pkg.base.commit;
    const actualTree = baseTree ?? runGit(repoPath, ['rev-parse', '--verify', `${actualSha}^{tree}`]);
    if (actualTree !== pkg.base.tree) throw new PreBootstrapPatchError('base_mismatch', 'prebootstrap package tree does not match its exact base commit');
    return originSha256;
  }

  private assertPreBootstrapBaseFile(repoPath: string, baseSha: string, patch: LoadedPreBootstrapPatch): void {
    const treeEntry = spawnGit(repoPath, ['ls-tree', '-z', baseSha, '--', 'requirements.txt']);
    const treeRecord = treeEntry.stdout.split('\u0000')[0] ?? '';
    const treeHeader = treeRecord.split('\t', 1)[0] ?? '';
    const [mode, type] = treeHeader.split(' ');
    if (treeEntry.status !== 0 || type !== 'blob' || mode !== '100644' && mode !== '100755') {
      throw new PreBootstrapPatchError('file_mismatch', 'exact base requirements.txt must be a tracked regular Git blob, not a symlink or special file');
    }
    const entry = patch.package.files[0];
    const baseFile = spawnGit(repoPath, ['show', `${baseSha}:requirements.txt`], { maxBuffer: 1024 * 1024 });
    if (baseFile.status !== 0) throw new PreBootstrapPatchError('file_mismatch', 'exact base does not contain a readable requirements.txt');
    const before = Buffer.from(baseFile.stdout, 'utf8');
    if (preBootstrapSha256(before) !== entry.beforeSha256) throw new PreBootstrapPatchError('file_mismatch', 'exact base requirements.txt does not match before_sha256');
    assertSafeRequirementsPatch(before.toString('utf8'), entry.content);
  }

  private applyPreBootstrapPatch(input: {
    readonly repoPath: string;
    readonly worktreePath: string;
    readonly jobId: string;
    readonly custody: CreationCustody;
    readonly patch: LoadedPreBootstrapPatch;
  }): { readonly beforeTree: string; readonly afterTree: string; readonly beforeSha256: string; readonly afterSha256: string } {
    const { repoPath, worktreePath, jobId, custody, patch } = input;
    this.assertPreBootstrapAuthority(jobId, patch);
    this.assertPreBootstrapAdmission(jobId, patch);
    this.assertCreationIdentity(worktreePath, custody);
    this.assertCreationCustody(repoPath, worktreePath, custody);
    if (this.opts.preBootstrapPatchRoot === undefined) throw new PreBootstrapPatchError('package_unavailable', 'private prebootstrap package root is not wired');
    const current = readPreBootstrapDependencyPatchPackage(this.opts.preBootstrapPatchRoot, patch.reference);
    if (current.packageBytesSha256 !== patch.packageBytesSha256 || JSON.stringify(current.package) !== JSON.stringify(patch.package) ||
        current.requestPayloadSha256 !== patch.requestPayloadSha256 || current.intakeIdentitySha256 !== patch.intakeIdentitySha256) {
      throw new PreBootstrapPatchError('package_changed', 'prebootstrap package changed after admission');
    }
    const baseTree = runGit(worktreePath, ['rev-parse', '--verify', `${custody.sha}^{tree}`]);
    this.assertPreBootstrapSource(repoPath, patch, custody.sha, baseTree, custody.baseSource);
    const manifestBefore = spawnGit(worktreePath, ['rev-parse', '--verify', '--quiet', `${custody.sha}:${MANIFEST_PATH}`]);
    const manifestBlob = manifestBefore.status === 0 ? manifestBefore.stdout.trim() : null;
    const filePath = join(worktreePath, 'requirements.txt');
    let fileStat: Stats;
    try { fileStat = lstatSync(filePath); } catch (error) { throw new PreBootstrapPatchError('file_mismatch', 'base requirements.txt is unavailable', { cause: error }); }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new PreBootstrapPatchError('file_mismatch', 'base requirements.txt is not a regular non-symlink file');
    if (realpathSync(filePath) !== join(realpathSync(worktreePath), 'requirements.txt')) {
      throw new PreBootstrapPatchError('file_mismatch', 'base requirements.txt escapes the owned worktree');
    }
    const before = readFileSync(filePath);
    const entry = patch.package.files[0];
    if (preBootstrapSha256(before) !== entry.beforeSha256) throw new PreBootstrapPatchError('file_mismatch', 'base requirements.txt bytes do not match the package before_sha256');
    assertSafeRequirementsPatch(before.toString('utf8'), entry.content);
    const afterBytes = Buffer.from(entry.content, 'utf8');
    const beforeTree = runGit(worktreePath, ['rev-parse', '--verify', `${custody.sha}^{tree}`]);
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.prebootstrap-patch-started',
      jobId,
      payload: {
        version: 1,
        package_sha256: patch.packageBytesSha256,
        request_payload_sha256: patch.requestPayloadSha256,
        intake_identity_sha256: patch.intakeIdentitySha256,
        worktree_path: worktreePath,
        branch: custody.branch,
        base_sha: custody.sha,
        base_tree: beforeTree,
        manifest_blob: manifestBlob,
        allowlist: ['requirements.txt'],
        producer_host: hostname(),
        producer_pid: process.pid,
        creation_token_sha256: preBootstrapSha256(custody.token),
        file_before_sha256: entry.beforeSha256,
        file_after_sha256: entry.afterSha256,
      },
    });

    const tempPath = join(worktreePath, `.requirements.txt.prebootstrap-${randomUUID()}.tmp`);
    let renamed = false;
    try {
      const fd = openSync(tempPath, 'wx', fileStat.mode & 0o777);
      try {
        writeFileSync(fd, afterBytes);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(tempPath, filePath);
      renamed = true;
      syncPatchDirectory(worktreePath);
    } finally {
      if (!renamed) {
        try { rmSync(tempPath, { force: true }); } catch { /* keep the primary patch failure; the lane receipt remains */ }
      }
    }

    this.assertCreationIdentity(worktreePath, custody);
    this.assertCreationCustody(repoPath, worktreePath, custody);
    const after = readFileSync(filePath);
    if (preBootstrapSha256(after) !== entry.afterSha256) throw new PreBootstrapPatchError('file_mismatch', 'applied requirements.txt bytes do not match the package after_sha256');
    const listed = (args: readonly string[]): readonly string[] => runGit(worktreePath, args).split('\n').filter((line) => line !== '');
    const changed = listed(['diff', '--name-only', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
    const untracked = listed(['ls-files', '--others', '--exclude-standard']);
    const staged = listed(['diff', '--cached', '--name-only', '--']);
    // The receipt records this measured set, so it can never claim a set the
    // lane did not have.
    const changedPaths = [...changed, ...staged, ...untracked];
    if (changed.length !== 1 || changed[0] !== 'requirements.txt' || staged.length > 0 || untracked.length > 0) {
      throw new PreBootstrapPatchError('changed_paths', `prebootstrap patch produced unapproved tracked/untracked changes (tracked=${JSON.stringify(changed)}, staged=${JSON.stringify(staged)}, untracked=${JSON.stringify(untracked)})`);
    }
    const afterTree = gitTreeWithRequirementsPatch(worktreePath, custody.sha, afterBytes);
    this.assertPreBootstrapAuthority(jobId, patch);
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.prebootstrap-patch-applied',
      jobId,
      payload: {
        version: 1,
        package_sha256: patch.packageBytesSha256,
        request_payload_sha256: patch.requestPayloadSha256,
        intake_identity_sha256: patch.intakeIdentitySha256,
        worktree_path: worktreePath,
        branch: custody.branch,
        base_sha: custody.sha,
        before_tree: beforeTree,
        after_tree: afterTree,
        manifest_blob: manifestBlob,
        changed_paths: changedPaths,
        file_before_sha256: entry.beforeSha256,
        file_after_sha256: entry.afterSha256,
        producer_host: hostname(),
        producer_pid: process.pid,
        creation_token_sha256: preBootstrapSha256(custody.token),
      },
    });
    return { beforeTree, afterTree, beforeSha256: entry.beforeSha256, afterSha256: entry.afterSha256 };
  }

  private setupAudit(jobId: string, patch: LoadedPreBootstrapPatch, custody: CreationCustody, worktreePath: string): {
    readonly onCommandStart: (index: number, command: string) => void;
    readonly onSpawn: (pid: number, index: number, command: string) => void;
    readonly onCommandOutcome: (index: number, command: string, result: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean; readonly stopped: boolean }) => void;
  } {
    const base = {
      version: 1,
      package_sha256: patch.packageBytesSha256,
      request_payload_sha256: patch.requestPayloadSha256,
      intake_identity_sha256: patch.intakeIdentitySha256,
      worktree_path: worktreePath,
      branch: custody.branch,
      base_sha: custody.sha,
      producer_host: hostname(),
      producer_pid: process.pid,
      creation_token_sha256: preBootstrapSha256(custody.token),
    } as const;
    return {
      onCommandStart: (index, command) => {
        this.assertPreBootstrapAuthority(jobId, patch);
        this.opts.ledger.appendCustomEvent({ kind: 'worktree.prebootstrap-setup-started', jobId,
          payload: { ...base, setup_index: index, command_sha256: preBootstrapSha256(command) } });
      },
      onSpawn: (pid, index, command) => this.opts.ledger.appendCustomEvent({ kind: 'worktree.prebootstrap-setup-spawned', jobId,
        payload: { ...base, setup_index: index, command_sha256: preBootstrapSha256(command), pid, process_group_id: pid } }),
      onCommandOutcome: (index, command, result) => this.opts.ledger.appendCustomEvent({ kind: 'worktree.prebootstrap-setup-process-settled', jobId,
        payload: { ...base, setup_index: index, command_sha256: preBootstrapSha256(command), exit_code: result.code,
          signal: result.signal, timed_out: result.timedOut, stopped: result.stopped } }),
    };
  }

  private async publishPreBootstrapFailureLane(input: {
    readonly repo: { readonly repoPath: string; readonly repoName: string };
    readonly branch: string;
    readonly path: string;
    readonly sha: string;
    readonly base: ResolvedBase;
    readonly custody: CreationCustody;
    readonly jobId: string;
  }): Promise<WorktreeRecord> {
    const existing = this.opts.ledger.getWorktree(input.jobId);
    if (existing !== null) return existing;
    this.assertCreationIdentity(input.path, input.custody);
    const completion = this.assertCreationCustody(input.repo.repoPath, input.path, input.custody);
    const lane = { id: input.jobId, kind: 'job', jobId: input.jobId, roundId: null, repoPath: input.repo.repoPath,
      path: input.path, branch: input.branch, sha: input.sha } as const;
    // A failed registration may follow this creation's own published receipt.
    if (!pendingLaneHandoffPublished(lane, completion, input.custody.token)) beginLaneHandoff(lane, completion, input.custody.token);
    const record = this.opts.ledger.registerWorktree({
      id: input.jobId, kind: 'job', repoPath: input.repo.repoPath, repoName: input.repo.repoName,
      path: input.path, branch: input.branch, sha: input.sha, baseSource: input.base.baseSource, jobId: input.jobId,
    });
    // A consumed pre-bootstrap request never spends its creation receipt on
    // patch/setup failure: it is part of the retained recovery evidence and
    // prevents any later manager from adopting or replaying this lane.
    this.handoffLane(input.repo.repoPath, input.path, input.custody, record);
    this.recordRepoIdentity(record);
    return record;
  }

  /** Spends a patched lane's creation receipt once dispatch recorded the
   * lane's worker. Anything short of that exact proof refuses by name and
   * keeps the receipt. */
  completePreBootstrapWorkerAdmission(input: { repoPath: string; jobId: string }): void {
    const repo = this.assertRepo(input.repoPath);
    const branch = `gru/${input.jobId}`;
    const record = this.opts.ledger.getWorktree(input.jobId);
    const spawned = this.opts.ledger.latestJobEvent(input.jobId, 'job.minion-spawned');
    const spawnedPayload = spawned?.payload as Record<string, unknown> | null | undefined;
    if (record === null || record.kind !== 'job' || record.status !== 'active' || record.repoPath !== repo.repoPath || record.branch !== branch ||
        spawnedPayload?.['worktree'] !== record.path || spawnedPayload['branch'] !== branch) {
      throw new PreBootstrapPatchError('admission_unproven', `job "${input.jobId}" has no recorded worker on its patched lane; its creation receipt is kept`);
    }
    const common = this.creationCommonDirectory(repo.repoPath);
    const receipt = readCreationIntent(common, branch);
    if (receipt === null || receipt.lane.id !== input.jobId || receipt.lane.path !== record.path || receipt.sha !== record.sha) {
      throw new PreBootstrapPatchError('creation_receipt_mismatch', `job "${input.jobId}" patched lane has no exact retained creation receipt`);
    }
    clearCreationIntent(common, branch, receipt.token);
  }

  /**
   * Branch-for-jobs (ruling 18d): one worktree per job, on its own
   * branch `gru/<jobId>`, created at the FETCHED origin head —
   * sequential per repo (ruling 18e), manifest auto-applied (18a),
   * registry row written (18b) with the base's provenance (18b).
   */
  createJobWorktreeWithPreBootstrapPatch(input: { repoPath: string; jobId: string; preBootstrapPatch: LoadedPreBootstrapPatch }): Promise<WorktreeRecord> {
    return this.createJobWorktreeUsingReceiptPolicy(input, null);
  }

  async createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeRecord> {
    return this.createJobWorktreeUsingReceiptPolicy(input, null);
  }

  /** Read-only preflight for the one supported same-job retained-creation
   * continuation. The existing reconciler is used in inspect-only mode, so
   * no checkout/admin cleanup or new-base resolution can happen here. */
  async inspectRetainedJobCreation(input: { repoPath: string; jobId: string }): Promise<{
    readonly jobId: string; readonly repoPath: string; readonly branch: string; readonly sha: string;
    readonly baseSource: Exclude<WorktreeBaseSource, null>; readonly receiptTokenSha256: string;
    readonly producerSettlementSeq: number;
  }> {
    if (input.jobId === '') throw new Error('job id must be non-empty');
    return this.withRepoLock(input.repoPath, async () => {
      const repo = this.assertRepo(input.repoPath);
      const branch = `gru/${input.jobId}`;
      const path = join(this.opts.root, repo.repoName, `job-${input.jobId}`);
      const lane = { id: input.jobId, kind: 'job' as const, jobId: input.jobId, roundId: null, path };
      const retained = await this.reconcileInterruptedCreation(repo.repoPath, lane, branch, { requireRetained: true, inspectOnly: true });
      if (retained === null || retained.baseSource === null) throw new CreationIntentError(`retained creation receipt for branch ${branch} cannot establish a fixed base`);
      const tokenSha256 = createHash('sha256').update(retained.token, 'utf8').digest('hex');
      const producer = this.opts.ledger.hasSettledCreationProducer({ jobId: input.jobId, branch, sha: retained.sha, tokenSha256 });
      if (producer === null) throw new CreationIntentError(`original producer cessation for retained branch ${branch} is UNKNOWN — no exact positive close receipt; resources retained`);
      return { jobId: input.jobId, repoPath: repo.repoPath, branch, sha: retained.sha, baseSource: retained.baseSource,
        receiptTokenSha256: tokenSha256, producerSettlementSeq: producer.seq };
    });
  }

  /** The only creation entry that requires an existing exact receipt: the
   * one, with the settlement, that the continuation accepted. `adopting` is
   * called once every check passed, before the first checkout work. */
  async createRetainedJobWorktree(input: {
    repoPath: string; jobId: string; expected: RetainedReceiptExpectation; adopting?: () => void;
  }): Promise<WorktreeRecord> {
    return this.createJobWorktreeUsingReceiptPolicy(input, { expected: input.expected, adopting: input.adopting ?? (() => {}) });
  }

  private async createJobWorktreeUsingReceiptPolicy(
    input: { repoPath: string; jobId: string; preBootstrapPatch?: LoadedPreBootstrapPatch },
    retainedPolicy: { readonly expected: RetainedReceiptExpectation; readonly adopting: () => void } | null,
  ): Promise<WorktreeRecord> {
    const requireRetained = retainedPolicy !== null;
    const expected = retainedPolicy?.expected ?? null;
    if (input.jobId === '') throw new Error('job id must be non-empty');
    return this.withRepoLock(input.repoPath, async () => {
      const repo = this.assertRepo(input.repoPath);
      const patch = input.preBootstrapPatch;
      const branch = `gru/${input.jobId}`;
      const path = join(this.opts.root, repo.repoName, `job-${input.jobId}`);
      const lane = { id: input.jobId, kind: 'job' as const, jobId: input.jobId, roundId: null, path };
      // A patched lane is always a fresh claim and a continuation is always
      // a retained adoption: the two never compose.
      if (patch !== undefined && requireRetained) {
        throw new PreBootstrapPatchError('lane_unsupported', `job "${input.jobId}": prebootstrap_patch never composes with a retained-creation continuation`);
      }
      // A continuation's guard refusals are named, before adoption and
      // after it: they stop with every resource retained.
      const asRefusal = (error: unknown): unknown => !requireRetained ? error
        : new RetainedCreationRefusalError(error instanceof Error ? error.message : String(error), { cause: error });
      const guarded = <T>(check: () => T): T => {
        try { return check(); } catch (error) { throw asRefusal(error); }
      };
      if (patch !== undefined) {
        if (this.opts.preBootstrapPatchRoot === undefined) throw new PreBootstrapPatchError('package_unavailable', 'private prebootstrap package root is not wired');
        if (this.opts.ledger.getWorktree(input.jobId) !== null) throw new PreBootstrapPatchError('foreign_lane', `job "${input.jobId}" already owns a worktree; prebootstrap patch requires a fresh lane`);
        const receipt = readCreationIntent(this.creationCommonDirectory(repo.repoPath), branch);
        if (receipt !== null) throw new PreBootstrapPatchError('foreign_receipt', `branch ${branch} has a retained creation receipt; prebootstrap patch will not adopt or replay it`);
        const currentPackage = readPreBootstrapDependencyPatchPackage(this.opts.preBootstrapPatchRoot, patch.reference);
        if (currentPackage.packageBytesSha256 !== patch.packageBytesSha256 || JSON.stringify(currentPackage.package) !== JSON.stringify(patch.package)) {
          throw new PreBootstrapPatchError('package_changed', 'prebootstrap package changed before worktree creation');
        }
        this.assertPreBootstrapAdmission(input.jobId, patch);
        this.assertPreBootstrapAuthority(input.jobId, patch);
      }
      // An interrupted ordinary creation may be adopted by its exact receipt.
      // Patch lanes are intentionally different: any prior receipt is a hard
      // refusal above, never an invitation to replay the consumed package.
      let retained: CreationIntent | null;
      try {
        retained = patch === undefined ? await this.reconcileInterruptedCreation(repo.repoPath, lane, branch, { requireRetained, ...(expected === null ? {} : { expected }) }) : null;
      } catch (error) {
        throw asRefusal(error);
      }
      if (requireRetained && retained === null) throw new RetainedCreationRefusalError(`retained creation receipt for branch ${branch} is absent — new-base creation is forbidden for a continuation`);
      if (retained === null) {
        const existing = spawnGit(repo.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
        if (existing.status === 0) {
          if (patch !== undefined) throw new PreBootstrapPatchError('foreign_ref', `branch ${branch} already exists — prebootstrap patch will not adopt or overwrite a held branch`);
          throw new Error(`branch ${branch} already exists — one lane per job, never a reused held branch`);
        }
        if (existsSync(path)) {
          if (patch !== undefined) throw new PreBootstrapPatchError('foreign_lane', `worktree path already exists: ${path} — prebootstrap patch will not adopt or overwrite it`);
          throw new Error(`worktree path already exists: ${path}`);
        }
      }
      if (patch !== undefined) {
        // One claim per request: the request is bound to its job id, and
        // dispatch creates that job row once, so no second claim can follow.
        this.opts.ledger.appendCustomEvent({ kind: 'worktree.prebootstrap-patch-creation-claimed', jobId: input.jobId,
          payload: { version: 1, package_sha256: patch.packageBytesSha256, request_payload_sha256: patch.requestPayloadSha256,
            intake_identity_sha256: patch.intakeIdentitySha256, repository_path: repo.repoPath,
            expected_base_sha: patch.package.base.commit, expected_base_tree: patch.package.base.tree,
            producer_host: hostname(), producer_pid: process.pid } });
      }
      // The base is resolved ONCE, and the SAME sha is branched from and
      // recorded. A patch package is bound to this exact fetched origin tip
      // and tree; local fallback is not an authorized substitute.
      const base = retained !== null ? this.adoptedBase(retained) : this.resolveBase(repo.repoPath);
      const sha = base.sha;
      if (patch !== undefined) {
        const tree = runGit(repo.repoPath, ['rev-parse', '--verify', `${sha}^{tree}`]);
        this.assertPreBootstrapSource(repo.repoPath, patch, sha, tree, base.baseSource);
        this.assertPreBootstrapBaseFile(repo.repoPath, sha, patch);
      }
      const custody = retained !== null ? this.adoptedCustody(retained, lane) : this.creationCustody(branch, sha, lane, base.baseSource);
      let record;
      let bootstrapped: LaneBootstrap | null;
      let patchConsumed = false;
      let phase: 'patch' | 'setup' | 'publication' = 'patch';
      retainedPolicy?.adopting();
      try {
        await this.addLane(repo.repoPath, path, custody, undefined, asRefusal);
        if (patch !== undefined) {
          guarded(() => this.assertCreationIdentity(path, custody));
          guarded(() => this.assertCreationCustody(repo.repoPath, path, custody));
          // Set before publishing the start event: if its transaction's
          // acknowledgement is lost, neither retry nor rollback is safe.
          patchConsumed = true;
          const patchReceipt = this.applyPreBootstrapPatch({ repoPath: repo.repoPath, worktreePath: path, jobId: input.jobId, custody, patch });
          phase = 'setup';
          this.assertPreBootstrapAuthority(input.jobId, patch);
          bootstrapped = await this.bootstrap(repo.repoPath, path, custody.sha, this.setupAudit(input.jobId, patch, custody, path));
          this.opts.ledger.appendCustomEvent({ kind: 'worktree.prebootstrap-setup-succeeded', jobId: input.jobId,
            payload: { version: 1, package_sha256: patch.packageBytesSha256, request_payload_sha256: patch.requestPayloadSha256,
              intake_identity_sha256: patch.intakeIdentitySha256, worktree_path: path, branch, base_sha: custody.sha,
              before_tree: patchReceipt.beforeTree, patched_tree: patchReceipt.afterTree,
              manifest_blob: bootstrapped?.blob ?? null, setup_made: bootstrapped?.setupMade ?? [] } });
          phase = 'publication';
        } else {
          bootstrapped = await this.bootstrap(repo.repoPath, path, custody.sha);
        }
        guarded(() => this.assertCreationIdentity(path, custody));
        guarded(() => this.assertCreationCustody(repo.repoPath, path, custody));
        beginLaneHandoff({ id: input.jobId, kind: 'job', jobId: input.jobId, roundId: null, repoPath: repo.repoPath, path, branch: custody.branch, sha: custody.sha },
          guarded(() => this.assertCreationCustody(repo.repoPath, path, custody)), custody.token);
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
        // A patched lane keeps its receipt until dispatch records its worker
        // (completePreBootstrapWorkerAdmission): a later failure retains both.
        if (patch === undefined) this.clearCreationIntent(repo.repoPath, custody);
      } catch (error) {
        if (patchConsumed) {
          const errorText = error instanceof Error ? error.message : String(error);
          try {
            this.opts.ledger.appendCustomEvent({
              kind: phase === 'patch' ? 'worktree.prebootstrap-patch-failed' : phase === 'setup' ? 'worktree.prebootstrap-setup-failed' : 'worktree.prebootstrap-publication-failed',
              jobId: input.jobId,
              payload: { version: 1, package_sha256: patch!.packageBytesSha256, request_payload_sha256: patch!.requestPayloadSha256,
                intake_identity_sha256: patch!.intakeIdentitySha256, worktree_path: path, branch, base_sha: custody.sha,
                stage: phase, error_class: error instanceof Error ? error.name : typeof error,
                error_sha256: preBootstrapSha256(errorText) },
            });
          } catch { /* the prior consumed/start event remains the honest unknown state */ }
          if (this.opts.ledger.getWorktree(input.jobId) === null) {
            try {
              record = await this.publishPreBootstrapFailureLane({ repo, branch, path, sha, base, custody, jobId: input.jobId });
            } catch (publishError) {
              throw new AggregateError([error, publishError], `prebootstrap lane ${input.jobId} failed and its owned lane could not be published; creation custody is retained`);
            }
            this.log('warn', 'prebootstrap worktree setup failed; lane retained without worker admission', { job: input.jobId, path, phase });
          }
          throw error;
        }
        // Committed publication retains unresolved custody: the registry row
        // holds the lane and the receipt may already be spent.
        if (this.opts.ledger.getWorktree(input.jobId) !== null) throw error;
        if (requireRetained) {
          // A refusal retains everything, and so does anything still running
          // there: a setup step's process group, or any process rooted in
          // the checkout (a detached daemon a step started included). Any
          // other failure rolls the checkout back under the receipt's own
          // token and keeps the ref and receipt, so a later continuation
          // adopts them again.
          if (error instanceof RetainedCreationRefusalError || (error instanceof WorktreeSetupError && error.processesRemain) ||
              await this.processesRootedIn(path)) throw error;
          await this.rollbackPartialLane(repo.repoPath, path, custody, error, { keepRef: true });
          throw new RetainedCreationFailedError(`retained creation of branch ${branch} failed after adoption; its checkout was rolled back and its ref and receipt are kept: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        await this.rollbackPartialLane(repo.repoPath, path, custody, error);
        // Only a proven ownership is spent with the rollback. An unproven
        // create keeps its receipt: the ref it names may outlive the process.
        if (custody.branchCreated) this.clearCreationIntent(repo.repoPath, custody);
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
      const custody = this.creationCustody(null, resolved.sha, { id: input.roundId, kind: 'review', jobId: input.jobId ?? null, roundId: input.roundId, path }, resolved.baseSource);
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
      const branch = input.authority === 'writer' ? `gru/${input.jobId}-child-${input.childId}` : null;
      const lane = { id: input.childId, kind: 'child' as const, jobId: input.jobId, roundId: null, path };
      // Issue #453: the same retained-receipt reconciliation as a job lane.
      // A writer child's branch is its own creation; a read-only child has
      // none to reconcile.
      const retained = branch === null ? null : await this.reconcileInterruptedCreation(repo.repoPath, lane, branch);
      if (retained === null) {
        if (existsSync(path)) {
          throw new Error(`worktree path already exists: ${path}`);
        }
        if (branch !== null) {
          const existing = spawnGit(repo.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
          if (existing.status === 0) {
            throw new Error(`branch ${branch} already exists — one lane per child, never a reused held branch`);
          }
        }
      }
      const custody = retained !== null
        ? this.adoptedCustody(retained, lane)
        : this.creationCustody(branch, parentHead, lane, null);
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
        this.clearCreationIntent(repo.repoPath, custody);
      } catch (error) {
        if (this.opts.ledger.getWorktree(input.childId) !== null) throw error; // committed publication retains unresolved custody
        await this.rollbackPartialLane(repo.repoPath, path, custody, error);
        if (custody.branchCreated) this.clearCreationIntent(repo.repoPath, custody);
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
  private async bootstrap(sourceRoot: string, worktreePath: string, sha: string, setupAudit?: ReturnType<WorktreeManager['setupAudit']>): Promise<LaneBootstrap | null> {
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
      ...(setupAudit ?? {}),
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
   * `tampered`. Each managed name's place, each repository's identity, each
   * base commit's roots, and the completion facts every settled or re-bound
   * lane's handoff is read from, are read once per check. It runs on the
   * event loop, so it repairs at most {@link MOVED_LANES_PER_CHECK} lanes,
   * and starts none but the first after {@link MOVED_CHECK_REPAIR_MS}: the
   * rest are `deferred` to the next slice, which checks only `lanes` (the
   * ones the slice before deferred). Released lanes follow at
   * {@link followSweptLanes}.
   */
  checkMovedRepositories(input: {
    readonly managedRepos: readonly string[];
    readonly resolve: (name: string) => ManagedRepoPath;
    readonly lanes?: ReadonlySet<string>;
  }): readonly RepoMoveOutcome[] {
    const outcomes: RepoMoveOutcome[] = [];
    const cache: MoveCheckCache = { began: performance.now(), places: new Map(), identities: new Map(), baseRoots: new Map(), completions: laneCompletionsOnce(this.opts.ledger), repairs: 0 };
    for (const row of this.opts.ledger.listWorktrees()) {
      if (row.status === 'swept' || !existsSync(row.path) || (input.lanes !== undefined && !input.lanes.has(row.id))) continue;
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
      if (outcome.status === 'deferred') {
        outcomes.push(outcome);
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
    const deferred = outcomes.filter((outcome) => outcome.status === 'deferred').length;
    if (deferred > 0) this.log('info', 'moved lanes wait for the next slice of the check: one slice repairs a bounded number of lanes', { attempted: cache.repairs, deferred });
    return outcomes;
  }

  private checkMovedLane(row: WorktreeRecord, input: {
    readonly managedRepos: readonly string[];
    readonly resolve: (name: string) => ManagedRepoPath;
  }, cache: MoveCheckCache): RepoMoveOutcome | null {
    const deferred = (): RepoMoveOutcome => ({ status: 'deferred', lane: row });
    const spent = (): boolean => cache.repairs >= MOVED_LANES_PER_CHECK || (cache.repairs > 0 && performance.now() - cache.began >= MOVED_CHECK_REPAIR_MS);
    const place = (name: string): ManagedRepoPath => {
      if (!cache.places.has(name)) cache.places.set(name, input.resolve(name));
      return cache.places.get(name)!;
    };
    if (laneReachesRepository(row.path, row.repoPath)) {
      if (settleLaneRebind(row, this.opts.ledger, cache.completions)) {
        this.log('info', 'a moved lane\'s re-bound handoff receipt was published after an interrupted repair', { id: row.id });
      }
      if (laneReceiptStale(row)) {
        // The link reaches the repository only through a link left at its
        // old place, or its own git directory moved: the lane follows the
        // managed repository of its name when that is the same place.
        const resolved = input.managedRepos.includes(row.repoName) ? place(row.repoName) : null;
        const candidate = resolved?.kind === 'available' && samePlace(resolved.path, row.repoPath) ? resolved.path : row.repoPath;
        return spent() ? deferred() : this.repairMovedLane(row, candidate, cache, true);
      }
      this.recordRepoIdentity(row, cache);
      return null;
    }
    if (!input.managedRepos.includes(row.repoName)) {
      return { status: 'unresolved', lane: row, reason: `its git link does not reach ${row.repoPath}, and ${row.repoName} is not a managed repository` };
    }
    const resolved = place(row.repoName);
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
    return spent() ? deferred() : this.repairMovedLane(row, resolved.path, cache, false);
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
    const cache: MoveCheckCache = { began: performance.now(), places: new Map(), identities: new Map(), baseRoots: new Map(), completions: laneCompletionsOnce(this.opts.ledger), repairs: 0 };
    const present = new Map<string, boolean>();
    const { places } = cache;
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
    const rebind = prepareLaneRebind(row, candidate, this.opts.ledger, cache.completions);
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

  /** Why the ledger says a slim of the lane would be refused for good
   * (#427 PR 3: the disk budget's estimate leaves such a lane out), or null:
   * it has no bootstrap record, or a restore of it did not get back what
   * setup made. What its base manifest says is the caller's to read. */
  slimRecordRefusal(laneId: string): string | null {
    const row = this.opts.ledger.getWorktree(laneId);
    if (row === null) return 'the lane is not in the registry';
    if (this.setupMade(row) === null) return 'the lane has no bootstrap record, so a restore could not tell what it must bring back';
    if (this.restoreWasIncomplete(row)) return 'a restore of the lane did not get back what setup made, so it is never slimmed again';
    return null;
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
   *
   * `only` (#427 PR 3: the entries an owner's Accept of a disk card listed)
   * limits the slim to those entries: any other is never deleted, and is
   * skipped by name when it is there.
   */
  async slim(input: { readonly worktreeId: string; readonly idle: () => string | null; readonly signal?: AbortSignal; readonly only?: readonly string[] }): Promise<SlimResult> {
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
        if (input.only !== undefined && !input.only.includes(entry)) {
          if ((await reclaimState(row.path, entry).catch(() => 'unreadable' as const)) !== 'absent') {
            skipped.push({ path: entry, reason: 'the list this slim runs from (the card the owner accepted) does not name it' });
          }
          continue;
        }
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
   *   1.5 reap the lane's own processes: GC's tracked services, and those
   *      carrying the lane's token (#486),
   *   2. enumerate processes rooted in the tree,
   *   3. any other live process → PAUSE and ask (never a silent kill),
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

  /**
   * #486: every session GC runs in the lane has settled its turns (the
   * runtime registry's `onLaneQuiet`): stop the processes rooted in the
   * lane that carry its token now, not only at its sweep
   * ({@link reapLaneTokenProcesses}). Skipped for a lane that is not active
   * (a paused one waits on its ask, a swept one is gone), for one with no
   * token, and while a verification run GC spawned owns the tree (a live
   * `registry` process row: the run may use what the minion started).
   * Under the lane's lock, so it never overlaps a release, a slim or a
   * restore; at most one waits there per lane. The listing runs off the
   * event loop. Once `stop` aborts (the service is stopping), nothing more
   * is signalled. Never throws: a failure is logged, and the sweep reaps
   * what is left.
   */
  async reapLaneAfterTurn(laneId: string, stop?: AbortSignal): Promise<readonly number[]> {
    if (this.laneReapsWaiting.has(laneId) || stop?.aborted === true) return [];
    this.laneReapsWaiting.add(laneId);
    try {
      return await this.withLaneLock(laneId, async () => {
        this.laneReapsWaiting.delete(laneId);
        const row = this.opts.ledger.getWorktree(laneId);
        if (row === null || row.status !== 'active' || row.laneToken === null || !existsSync(row.path)) return [];
        if (this.opts.ledger.listWorktreeProcesses(row.id).some((proc) => proc.state === 'live' && proc.evidence === 'registry')) return [];
        if (!(this.opts.laneQuiet?.(row.id) ?? true)) return [];
        return this.reapLaneTokenProcesses(row, () => this.enumerateListed(row.path), 'turn-settled', stop);
      });
    } catch (error) {
      this.laneReapsWaiting.delete(laneId);
      this.log('warn', 'the processes a lane\'s sessions left could not be reaped after their turns; its sweep reaps them', { id: laneId, error: String(error) });
      return [];
    }
  }

  /** Whether any process is rooted in a tree. A listing that fails says
   * yes, and so does one that could not read the working directories:
   * command lines alone miss a daemon whose only tie is its cwd. */
  private async processesRootedIn(treePath: string): Promise<boolean> {
    try {
      if (this.opts.enumerateProcesses !== undefined) return this.opts.enumerateProcesses(treePath).length > 0;
      let cwdError: unknown = `${process.platform} has no listing of process working directories GC can read`;
      const table = await processTableAsync({
        ...(this.opts.listProcessCwds !== undefined ? { listCwds: this.opts.listProcessCwds } : {}),
        onCwdError: (error) => { cwdError = error; },
      });
      if (!table.cwdsListed) throw new Error(`process working directories could not be listed: ${String(cwdError)}`);
      return table.rootedIn(treePath).length > 0;
    } catch (error) {
      this.log('warn', 'the processes rooted in a tree could not be listed; it is kept', { path: treePath, error: String(error) });
      return true;
    }
  }

  /** The processes rooted in a tree, listed off the event loop; when the
   * working directories cannot be read, the command-line matches still
   * count, with a warn (what the listing missed waits for the sweep). */
  private async enumerateListed(treePath: string): Promise<readonly TreeProcess[]> {
    if (this.opts.enumerateProcesses !== undefined) return this.opts.enumerateProcesses(treePath);
    return psEnumeratorAsync(treePath, {
      onCwdError: (error) => this.log('warn', 'process working directories could not be listed; only command lines tie processes to the lane', { path: treePath, error: String(error) }),
    });
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
        if (input.diskBudget === true) {
          // A disk budget release never asks origin after a removal (#427
          // PR 3): a branch still there is kept for a later release.
          branchOutcome = this.budgetBranch(row);
        } else if ((row.kind === 'job' || row.kind === 'child') && row.branch !== null) {
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
        const freshHead = input.diskBudget === true ? '' : this.safeFreshHead(row.repoPath);
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
        // note — and the response reports the TRUE outcome. A disk budget
        // release asks origin nothing here (#427 PR 3): the branch is kept.
        const reconciled = this.reconcileMissingTree(row, input.baseBranch, input.diskBudget === true);
        return { status: 'swept', preserved: null, ...reconciled } as const;
      }
      // (0.9) AUTOMATIC RELEASE PROOFS (issue #243 F-H1): an unattended sweep
      // must refuse BEFORE the forced removal when fresh required containment
      // cannot be proven. Dirty tracked work no longer refuses it: the
      // removal tail snapshots it first (#427). A disk budget release (#427
      // PR 3) proves off the event loop: origin not answering within the
      // fetch budget refuses it before anything is touched, and the head
      // its proof resolved is the one it reports (it never asks origin after
      // the removal).
      const budget = input.diskBudget === true ? { freshHead: await this.assertAutomaticReleaseProofsAsync(row) } : null;
      if (input.requireReleaseProofs === true && budget === null) {
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
        budget,
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
    const refuse = input.onLiveProcess === 'refuse';
    const tracked = refuse ? [] : await this.reapTrackedServiceProcesses(row);
    assertCleanup();
    // (1.6) Reap what the lane's own sessions left (#486): a process rooted
    // in the tree that carries the lane's token was started by a session GC
    // spawned in the lane, however it detached. Never while one of those
    // sessions is still busy there; anything else keeps the ask below.
    const reaped = refuse ? tracked : [...tracked, ...await this.reapLaneTokenProcesses(row, () => this.enumerateListed(row.path), 'sweep')];
    assertCleanup();

    // (2) Enumerate processes rooted in the tree BEFORE removal (off the
    // event loop for a disk budget release, which refuses on a listing that
    // could not read working directories, #427 PR 3).
    const rooted = attempt.budget === null ? this.enumerate(row.path) : await this.enumerateAsync(row.path);
    const processes = rooted.filter((proc) => !reaped.includes(proc.pid));
    // #464: a recorded process this enumeration no longer finds rooted here,
    // and that is dead, left on its own. Its row leaves `live`, so it can
    // never fence a writer. One still alive stays live (an enumeration that
    // could not read working directories cannot clear it) until the tree is
    // swept; the reaper owns registry rows.
    const enumerated = new Set(rooted.map((proc) => proc.pid));
    const gone = this.opts.ledger.listWorktreeProcesses(row.id)
      .filter((proc) => proc.state === 'live' && proc.evidence !== 'registry' && !enumerated.has(proc.pid) && !pidAlive(proc.pid))
      .map((proc) => proc.pid);
    if (gone.length > 0) this.opts.ledger.recordWorktreeProcessesExited({ worktreeId: row.id, pids: gone, reason: 'not-enumerated' });
    // A release nobody answers refuses instead of pausing (#427 PR 3): the
    // caller's catch withdraws the preserve copy, and the tree is retained.
    if (processes.length > 0 && refuse) throw new LaneLiveProcessError(row.path, processes);
    if (processes.length > 0) {
      // Perkins r2 B2: confirmKill is answered against the RECORDED set
      // (ruling 18b rows from a prior pause), never a fresh enumeration
      // — pids that appeared since were never acknowledged by anyone.
      // No recorded pause → confirmKill is not honored; the ask comes first.
      // #486: an answer from the owner's card covers only the pids it named,
      // and an acknowledged pid is killed only while this enumeration still
      // finds it rooted here running the command it was recorded with (an
      // answer given late, or carried out after a restart, never reaches a
      // recycled pid).
      const named = input.confirmKillPids === undefined ? null : new Set(input.confirmKillPids);
      const running = new Map(processes.map((proc) => [proc.pid, proc.command]));
      const acknowledged =
        input.confirmKill === true && row.status === 'paused'
          ? this.opts.ledger
              .listWorktreeProcesses(row.id)
              .filter((proc) => proc.state === 'live' && (named === null || named.has(proc.pid)) && running.get(proc.pid) === proc.command)
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
      await this.announcePause(row, processes, null, input.baseBranch);
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

  /**
   * #486: stop the processes rooted in the lane that carry its own token.
   * Every session GC spawns in a lane carries it, and so does every process
   * that session starts, a daemon that double-forked or was reparented to
   * pid 1 included, so such a process is the lane's: it is reaped like a
   * tracked service (process group SIGTERM, grace, SIGKILL), never asked
   * about. Never while a session GC runs in the lane is busy there
   * ({@link WorktreeManagerOptions.laneQuiet}): a busy session's own
   * processes carry the token too. Dual-keyed like the registry reaper: a
   * pid is signalled only when it was enumerated in the tree and its token,
   * read again just before each signal, still matches, so a recycled pid is
   * never signalled. Recorded `killed` with evidence `lane-token`, with a
   * `worktree.lane-processes-reaped` event; a survivor stays to be asked
   * about. A token that cannot be read stops nothing. `list` lists the
   * processes rooted in the tree (only once the lane is known quiet).
   * Returns the pids proven dead.
   */
  private async reapLaneTokenProcesses(row: WorktreeRecord, list: () => Promise<readonly TreeProcess[]>, trigger: 'sweep' | 'turn-settled', stop?: AbortSignal): Promise<readonly number[]> {
    const token = row.laneToken;
    const quiet = (): boolean => stop?.aborted !== true && (this.opts.laneQuiet?.(row.id) ?? true);
    if (token === null || !quiet()) return [];
    const carrying = async (procs: readonly TreeProcess[]): Promise<readonly TreeProcess[]> => {
      if (procs.length === 0) return [];
      const reads = await this.laneTokens(procs);
      return procs.filter((proc) => { const read = reads.get(proc.pid); return read?.readable === true && read.token === token; });
    };
    const targets = await carrying(await list());
    if (targets.length === 0) return [];
    // Both keys again just before each signal, with nothing awaited between
    // the checks and the signal: still the lane's, and the lane still quiet
    // (a turn that started meanwhile may be using what it finds running).
    const signalled = await carrying(targets);
    if (signalled.length === 0 || !quiet()) return [];
    for (const proc of signalled) {
      if (!signalProcessGroup(proc.pid, 'SIGTERM')) this.log('warn', 'lane process SIGTERM failed (already gone?)', { id: row.id, pid: proc.pid });
    }
    await new Promise((resolve) => setTimeout(resolve, this.opts.killGraceMs ?? 1_500));
    const stubborn = await carrying(signalled.filter((candidate) => pidAlive(candidate.pid)));
    if (quiet()) {
      for (const proc of stubborn) {
        if (pidAlive(proc.pid)) signalProcessGroup(proc.pid, 'SIGKILL');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(this.opts.killGraceMs ?? 1_500, 300)));
    const killed = signalled.filter((proc) => !pidAlive(proc.pid));
    const survivors = signalled.filter((proc) => pidAlive(proc.pid)).map((proc) => proc.pid);
    this.opts.ledger.recordWorktreeProcesses({
      worktreeId: row.id,
      processes: killed.map((proc) => ({ pid: proc.pid, command: proc.command, evidence: 'lane-token' })),
      state: 'killed',
    });
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.lane-processes-reaped',
      jobId: row.jobId,
      roundId: row.roundId,
      payload: { id: row.id, path: row.path, trigger, pids: killed.map((proc) => proc.pid), survivors },
    });
    this.log('info', 'lane processes carrying the lane token reaped', { id: row.id, trigger, pids: killed.map((proc) => proc.pid), survivors });
    return killed.map((proc) => proc.pid);
  }

  /** The lane tokens of `procs`; a failed read reads as unreadable (it
   * stops nothing). */
  private async laneTokens(procs: readonly TreeProcess[]): Promise<ReadonlyMap<number, LaneTokenRead>> {
    try {
      return await (this.opts.readLaneTokens ?? readLaneTokens)(procs);
    } catch (error) {
      this.log('warn', 'lane tokens of the processes in a lane could not be read; none is stopped by its token', { error: String(error) });
      return new Map();
    }
  }

  /** Record a pause (its `worktree.paused` event, with this pause's id and
   * the base branch its release named, which the owner's answer releases
   * with) and tell the owner what each process is and why GC did not stop
   * it (#486). */
  private async announcePause(row: WorktreeRecord, processes: readonly TreeProcess[], reason: string | null, baseBranch: string | undefined): Promise<void> {
    const pauseId = randomUUID();
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.paused',
      jobId: row.jobId,
      roundId: row.roundId,
      payload: {
        id: row.id, path: row.path, processes, pause_id: pauseId,
        ...(reason !== null ? { reason } : {}), ...(baseBranch !== undefined ? { base_branch: baseBranch } : {}),
      },
    });
    if (this.opts.onSweepPaused === undefined) return;
    const details = await this.describePaused(row, processes);
    this.opts.onSweepPaused({ worktree: row, processes, pauseId, details });
  }

  /** What each paused-on process is (best effort, display only). */
  private async describePaused(row: WorktreeRecord, processes: readonly TreeProcess[]): Promise<readonly PausedProcess[]> {
    const reads = await this.laneTokens(processes);
    let facts: ReadonlyMap<number, ProcessFacts> = new Map();
    try {
      facts = await (this.opts.readProcessFacts ?? readProcessFacts)(processes.map((proc) => proc.pid));
    } catch (error) {
      this.log('warn', 'the names and start times of a paused lane\'s processes could not be read', { id: row.id, error: String(error) });
    }
    return processes.map((proc) => {
      const read = reads.get(proc.pid);
      const other = read?.readable === true && read.token !== null && read.token !== row.laneToken
        ? this.opts.ledger.findWorktreeByLaneToken(read.token) : null;
      const provenance: PausedProcessProvenance = read === undefined || !read.readable ? 'unreadable'
        : read.token === null ? 'no-token'
        : read.token === row.laneToken ? 'this-lane' : 'other-lane';
      const fact = facts.get(proc.pid);
      return {
        pid: proc.pid,
        command: proc.command,
        name: fact?.name ?? basename(proc.command.split(' ')[0] ?? proc.command),
        startedAt: fact?.startedAt ?? null,
        cwd: proc.cwd ?? null,
        provenance,
        otherLane: provenance === 'other-lane' ? other?.id ?? 'an unknown lane' : null,
      };
    });
  }

  private creationCustody(branch: string | null, sha: string, lane: CreationIntentLane, baseSource: WorktreeBaseSource | null): CreationCustody {
    return { token: `gru-creation:${randomUUID()}`, branch, sha, lane, baseSource, branchCreated: false, addAttempted: false };
  }

  /** Issue #453: a retained receipt's fixed base and token are adopted as
   * the ONLY authority for finishing that same creation. */
  /** A retained job receipt records the provenance its creation resolved.
   * A guessed source would make the registry row claim a base it never had. */
  private adoptedBase(retained: CreationIntent): ResolvedBase {
    if (retained.baseSource === null) {
      throw new CreationIntentError(`retained creation receipt for branch ${retained.branch} has no base provenance — refusing to record a guess`);
    }
    return { sha: retained.sha, baseSource: retained.baseSource, defaultBranch: null, fallbackDetail: null };
  }

  private adoptedCustody(retained: CreationIntent, lane: CreationIntentLane): CreationCustody {
    return { token: retained.token, branch: retained.branch, sha: retained.sha, lane, baseSource: retained.baseSource, branchCreated: true, addAttempted: true };
  }

  /** The receipt is durable BEFORE the ref transaction it authorizes. */
  private recordCreationIntent(repoPath: string, custody: CreationCustody): void {
    if (custody.branch === null) return;
    writeCreationIntent(this.creationCommonDirectory(repoPath), {
      lane: custody.lane, repoPath, branch: custody.branch, sha: custody.sha, baseSource: custody.baseSource, token: custody.token,
    });
  }

  /** The receipt is spent once the lane is published or rolled back. */
  private clearCreationIntent(repoPath: string, custody: CreationCustody): void {
    if (custody.branch === null) return;
    clearCreationIntent(this.creationCommonDirectory(repoPath), custody.branch, custody.token);
  }

  /** A checkout may only be finished from a ref that is STILL exactly the
   * transaction the retained receipt names: same tip, same token, same
   * reflog entry, no unsettled lock, no foreign holder. Anything else
   * refuses with the resources retained. */
  private async assertRetainedCreation(repoPath: string, custody: CreationCustody): Promise<void> {
    await this.assertBranchCreationCustody(repoPath, custody, null, this.creationCommonDirectory(repoPath), () => {});
  }

  /** Issue #453: reconcile only THIS lane's retained creation. The receipt
   * names the lane, the fixed base, the branch and the token; the ref and
   * the ref lock are the only other evidence consulted. A half-made
   * checkout of ours is rolled back under its own token, a foreign one is
   * refused, and a transaction that never committed is closed as spent. */
  private async reconcileInterruptedCreation(
    repoPath: string,
    lane: CreationIntentLane,
    branch: string,
    policy: { readonly requireRetained?: boolean; readonly inspectOnly?: boolean; readonly expected?: RetainedReceiptExpectation } = {},
  ): Promise<CreationIntent | null> {
    const common = this.creationCommonDirectory(repoPath);
    const retained = readCreationIntent(common, branch);
    const refuse = (detail: string): never => {
      throw new CreationIntentError(`retained creation receipt for branch ${branch} ${detail} — resources retained, inspect before retrying`);
    };
    if (retained === null) {
      if (policy.requireRetained === true) refuse('is absent; a continuation cannot resolve a new base');
      return null; // ordinary initial creation retains its established behavior
    }
    // Publication owns a registered lane; this receipt never may. A swept
    // row is not publication's authority, but the id is still not reusable
    // (registerWorktree refuses any existing row), so the status is said and
    // the receipt stays for the operator who repairs it.
    const registered = this.opts.ledger.getWorktree(lane.id);
    if (registered !== null) {
      refuse(`names a lane the ledger already holds as ${registered.status} (${registered.path}) — that id is not reusable, and the receipt is not its authority`);
    }
    const ref = `refs/heads/${branch}`;
    const lock = join(common, 'refs/heads', `${branch}.lock`);
    const tip = spawnGit(repoPath, ['rev-parse', '--verify', '--quiet', ref]);
    // Only git's own "no such ref" is absence. A failed probe proves nothing
    // and must not unlink the only record of a ref that may exist.
    if (tip.status !== 0 && (tip.status !== 1 || tip.error !== null)) {
      refuse(`could not be read (git exited ${String(tip.status)}: ${tip.stderr.trim() || tip.error || 'no diagnostic'})`);
    }
    const checkout = existsSync(retained.lane.path);
    const admins = this.creationAdminEntries(retained.lane.path, common);
    if (policy.requireRetained === true && tip.status === 1) {
      refuse('has no branch ref; a continuation cannot clear the receipt or resolve a new base');
    }
    // A receipt whose every resource is gone protects nothing. Close it and
    // let ordinary initial creation proceed. Same-job continuation opts out.
    if (tip.status === 1 && !existsSync(lock) && admins.length === 0 && !checkout) {
      clearCreationIntent(common, branch, retained.token);
      this.log('info', 'retained lane creation receipt closed with nothing left to protect', { branch, lane: retained.lane.id });
      return null;
    }
    // A live ref transaction is git's own lock, not this receipt's to judge.
    if (existsSync(lock)) refuse(`has an unsettled ref transaction (${lock})`);
    if (retained.repoPath !== repoPath) refuse(`names repository ${retained.repoPath}, not ${repoPath}`);
    if (retained.lane.id !== lane.id || retained.lane.kind !== lane.kind || retained.lane.jobId !== lane.jobId ||
        retained.lane.roundId !== lane.roundId || retained.lane.path !== lane.path) {
      refuse(`belongs to another lane (${retained.lane.kind} ${retained.lane.id} at ${retained.lane.path})`);
    }
    if (policy.requireRetained === true) {
      const tokenSha256 = createHash('sha256').update(retained.token, 'utf8').digest('hex');
      const producer = this.opts.ledger.hasSettledCreationProducer({ jobId: lane.id, branch, sha: retained.sha, tokenSha256 });
      if (producer === null) return refuse('has no exact positive original-producer close receipt; cessation is UNKNOWN');
      if (policy.expected !== undefined && (tokenSha256 !== policy.expected.receiptTokenSha256 || producer.seq !== policy.expected.producerSettlementSeq)) {
        refuse(`is not the receipt this continuation accepted (token digest ${tokenSha256}, settlement ${producer.seq}; accepted ${policy.expected.receiptTokenSha256}, settlement ${policy.expected.producerSettlementSeq})`);
      }
    }
    const custody: CreationCustody = { token: retained.token, branch, sha: retained.sha, lane: retained.lane,
      baseSource: retained.baseSource, branchCreated: tip.status === 0, addAttempted: true };
    const abandon = async (): Promise<null> => {
      await this.rollbackPartialLane(repoPath, lane.path, custody,
        new CreationIntentError(`interrupted creation of branch ${branch} was retained without a lane — reconciling it under its own receipt`));
      this.clearCreationIntent(repoPath, custody);
      return null;
    };
    // A checkout at our path is ours only when its admin entry carries this
    // receipt's token; orphanCreationAdmin refuses a different token by name.
    const orphan = this.orphanCreationAdmin(repoPath, lane.path, custody, common);
    if (orphan !== null) {
      if (policy.requireRetained === true) refuse(`has an existing receipt-owned worktree administration at ${orphan}; continuation requires a clean checkout path`);
      if (policy.inspectOnly === true) refuse(`has an existing receipt-owned worktree administration at ${orphan}; read-only inspection will not reconcile it`);
      return abandon();
    }
    if (existsSync(lane.path)) refuse(`has a checkout at ${lane.path} that this receipt does not own`);
    if (tip.status !== 0) {
      // The transaction never committed (or was rolled back): the receipt is
      // spent, and nothing it protected exists.
      this.clearCreationIntent(repoPath, custody);
      this.log('info', 'retained lane creation receipt closed without a ref', { branch, lane: lane.id });
      return null;
    }
    if (tip.stdout.trim() !== retained.sha) refuse(`names base ${retained.sha} but the branch is at ${tip.stdout.trim()}`);
    const reflog = spawnGit(repoPath, ['reflog', 'show', '-1', '--format=%H%x00%gs', ref]);
    if (reflog.status !== 0 || reflog.stdout.trim() !== `${retained.sha}\0${retained.token}`) refuse('no longer carries its own creation reflog entry');
    if (spawnGit(repoPath, ['symbolic-ref', '--quiet', '--no-recurse', ref]).status !== 1) refuse('is a symbolic ref');
    const trees = spawnGit(repoPath, ['worktree', 'list', '--porcelain', '-z']);
    if (trees.status !== 0) refuse('cannot read the worktree registry');
    if (this.branchHasForeignHolder(trees.stdout, ref, null)) refuse('is held by a worktree that this receipt does not own');
    if (policy.inspectOnly !== true) this.log('warn', 'resuming an interrupted lane creation from its retained receipt', { branch, lane: lane.id, sha: retained.sha });
    return retained;
  }

  private async addLane(repoPath: string, path: string, custody: CreationCustody, assertSource?: () => void,
    asRefusal: (error: unknown) => unknown = (error) => error): Promise<void> {
    if (custody.branch !== null) {
      if (custody.branchCreated) {
        try { await this.assertRetainedCreation(repoPath, custody); } catch (error) { throw asRefusal(error); }
      } else {
        this.recordCreationIntent(repoPath, custody);
        await this.updateDirectCreationRef(repoPath, custody, 'create');
        custody.branchCreated = true;
      }
    }
    assertSource?.(); // original parent after the awaited named-ref transaction
    custody.addAttempted = true;
    runGit(repoPath, ['worktree', 'add', '--lock', '--reason', custody.token,
      ...(custody.branch === null ? ['--detach'] : []), path, custody.branch ?? custody.sha]);
    assertSource?.();
    try { this.assertCreationIdentity(path, custody); } catch (error) { throw asRefusal(error); }
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
    // Set before we destroy our own pipe ends: a close that follows proves
    // nothing about the producer.
    let released = false;
    const transactionError = (detail: string): Error => new Error(
      `git update-ref ${operation} ${ref}: ${detail} — transaction authority unconfirmed; resources retained`,
    );
    // A job branch creation journals its producer's settlement when the
    // child's own close shows it exited and every holder released its
    // pipes. The receipt token correlates it; a failed write is logged and
    // never fails the creation.
    const settles = operation === 'create' && custody.lane.kind === 'job' && custody.branch === `gru/${custody.lane.id}`;
    const settle = (): void => {
      if (released || !settles || child.pid === undefined) return;
      try {
        this.opts.ledger.recordCreationProducerSettlement({
          jobId: custody.lane.id, branch: custody.branch, sha: custody.sha,
          tokenSha256: createHash('sha256').update(custody.token, 'utf8').digest('hex'),
          pid: child.pid, exitCode: status, signal,
        });
      } catch (error) {
        this.log('error', 'owned Git child closed but its producer settlement could not be recorded; the retained receipt stays UNKNOWN', {
          branch: custody.branch, lane: custody.lane.id, error: String(error),
        });
      }
    };
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
    const stopped = new Promise<void>((done) => child.on('close', (code, killedBy) => {
      closed = true;
      if (status === null) status = code;
      if (signal === null) signal = killedBy;
      if (expected.length > 0 || pending.length > 0) {
        fail(transactionError(`missing or unterminated confirmation: ${stderrTail.toString('utf8').trim()}`));
      }
      settle();
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
      if (!closed && exited && settles) {
        // The child exited but something still holds our pipes. Keep reading
        // them, without holding the service open, until their own close
        // settles the producer or the window ends; then release them,
        // proving nothing.
        child.unref();
        (child.stdout as Socket).unref();
        (child.stderr as Socket).unref();
        setTimeout(() => {
          released = true;
          child.stdout.destroy();
          child.stderr.destroy();
        }, this.opts.creationCloseWindowMs ?? 10 * 60_000).unref();
      } else {
        released = true;
        child.stdout.destroy();
        child.stderr.destroy();
        if (!closed && !exited) {
          stopFailure = transactionError(`owned Git child ${child.pid ?? 'unspawned'} termination unconfirmed`);
          child.unref();
        }
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
  /** Administration entries whose backlink names exactly `path`. An entry
   * that names no path at all is skipped: one unrelated half-written
   * administration must not make every creation in the repository fail. */
  private creationAdminEntries(path: string, common: string): readonly string[] {
    const container = join(common, 'worktrees');
    if (!existsSync(container)) return [];
    let expected: string;
    try { expected = join(realpathSync(dirname(path)), basename(path), '.git'); }
    catch { expected = join(dirname(path), basename(path), '.git'); } // a removed lane root is compared as written
    const admins: string[] = [];
    for (const entry of readdirSync(container, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const admin = join(container, entry.name);
      let backlink: string;
      try { backlink = resolve(admin, readWorktreeMetadata(join(admin, 'gitdir')).trim()); }
      catch { continue; } // an unrelated, torn administration is not this lane's evidence
      if (backlink === expected) admins.push(admin);
    }
    return admins;
  }

  private orphanCreationAdmin(repoPath: string, path: string, custody: CreationCustody,
    common = realpathSync(runGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']))): string | null {
    const admins = this.creationAdminEntries(path, common);
    if (admins.length === 0) return null;
    if (admins.length > 1) {
      throw new CreationIntentError(`several worktree administrations claim ${path} (${admins.join(', ')}) — inspect them before retrying`);
    }
    const admin = admins[0]!;
    try {
      readWorktreeMetadata(join(admin, 'HEAD'));
      if (realpathSync(resolve(admin, readWorktreeMetadata(join(admin, 'commondir')).trim())) !== common) {
        throw new Error('names a different common directory');
      }
      if (readWorktreeMetadata(join(admin, 'locked')).trim() !== custody.token) {
        throw new Error(`is locked for another creation, not ${custody.token}`);
      }
    } catch (error) {
      throw new CreationIntentError(`lane administration ${admin} belongs to ${path} but ${error instanceof Error ? error.message : String(error)} — inspect it before retrying`, { cause: error });
    }
    return admin;
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
    if (existsSync(join(common, 'refs/heads', `${custody.branch}.lock`))) {
      throw new Error(`created branch ${ref} is locked by an unsettled ref transaction`);
    }
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
    // A removed lane root is compared as written: a missing directory is a
    // refusal reason, not a bare ENOENT out of the custody proof.
    const canonical = (path: string): string => {
      try { return join(realpathSync(dirname(path)), basename(path)); } catch { return join(dirname(path), basename(path)); }
    };
    return trees.split('\0\0').some((entry) => {
      const fields = entry.split('\0');
      if (!fields.includes(`branch ${ref}`)) return false;
      const tree = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
      return ownedPath === null || tree === undefined ||
        canonical(tree) !== canonical(ownedPath);
    });
  }

  /** Only matching Git-native invocation receipts permit destructive
   * rollback. Check ALL custody before any cleanup; uncertainty retains the
   * resources and reports both the original failure and the missing proof. */
  private async rollbackPartialLane(repoPath: string, path: string, custody: CreationCustody, originalError: unknown,
    options: { readonly keepRef?: boolean } = {}): Promise<void> {
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
      if (custody.branchCreated && custody.branch !== null && options.keepRef !== true) {
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

  /** {@link assertAutomaticReleaseProofs} off the event loop, each call to
   * origin bounded by the manager's fetch budget (#427 PR 3): origin slow
   * to answer within it costs the event loop nothing, and origin not
   * answering in time refuses the release ({@link LaneRemoteTimeoutError}),
   * never a wait. Resolves with the head the proof resolved. */
  private async assertAutomaticReleaseProofsAsync(row: WorktreeRecord): Promise<string> {
    try {
      const base = await runGitStepsAsync(row.repoPath, this.baseSteps(row.repoPath, this.fetchTimeoutMs), (command, bound) => new LaneRemoteTimeoutError(row.path, command, bound));
      return base.sha;
    } catch (error) {
      if (error instanceof LaneRemoteTimeoutError) throw error;
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
      const surviving = fresh.filter((proc) => survivors.includes(proc.pid));
      // #486: the answered card closes, so the survivors are asked about
      // again with their own (and are on the record for that answer).
      this.opts.ledger.recordWorktreeProcesses({
        worktreeId: row.id,
        processes: surviving.map((proc) => ({ pid: proc.pid, command: proc.command, evidence: proc.evidence })),
        state: 'live',
      });
      this.opts.ledger.setWorktreeStatus(row.id, 'paused', note);
      await this.announcePause(row, surviving, 'survived-acknowledged-kill', baseBranch);
      return { status: 'paused', processes: surviving, preserved, note };
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
      const note = `sweep paused: ${unacknowledged.length} process(es) the acknowledged kill did not cover (new since the pause, or not acknowledged by it; pids ${unacknowledged
        .map((p) => p.pid)
        .join(', ')}) — each kill needs its own acknowledgment`;
      this.opts.ledger.setWorktreeStatus(row.id, 'paused', note);
      await this.announcePause(row, unacknowledged, 'post-kill-new-processes', baseBranch);
      return { status: 'paused', processes: unacknowledged, preserved, note };
    }
    return this.finishSweep(row, preserved, baseBranch, assertCleanup, attempt);
  }

  /** Removal + containment branch delete + fresh head (shared tail). A
   * disk budget release (#427 PR 3) removes off the event loop and asks
   * origin nothing after the removal: its branch is retained. */
  private async finishSweep(
    row: WorktreeRecord,
    preserved: SweepPreservation | null,
    baseBranch: string | undefined,
    assertCleanup: () => void,
    attempt: SweepAttempt,
  ): Promise<SweepResult> {
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
        // The removal's cost grows with the tree, and the disk budget
        // releases the largest lanes first: its removal runs off the event
        // loop (#427 PR 3), after the same records and ref.
        if (attempt.budget === null) runGit(row.repoPath, ['worktree', 'remove', '--force', row.path]);
        else await runGitAsync(row.repoPath, ['worktree', 'remove', '--force', row.path]);
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
      if (attempt.budget !== null) {
        // A disk budget release never asks origin after the removal (#427
        // PR 3): a timer drives it, so a slow origin must cost nothing here.
        // Its head is the one its proof resolved before the removal, and
        // the lane's branch is retained (lossless) for a later release or
        // the autopilot to dispose of.
        freshHead = attempt.budget.freshHead;
        assertLaneResourcesAbsent(row);
        branchOutcome = this.budgetBranch(row);
      } else {
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
    const recordedBranch = attempt.budget !== null && branchOutcome === 'retained' ? 'retained-budget' : branchOutcome;
    this.recordSweepEvent(row, preserved, recordedBranch, freshHead, snapshot);
    this.log('info', 'worktree swept', { id: row.id, branch: recordedBranch, freshHead, snapshot: snapshot?.ref ?? null });
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
   * branch outcome for the release response. A disk budget release (#427
   * PR 3) asks origin nothing: the branch is retained, and no head is
   * resolved. */
  private reconcileMissingTree(
    row: WorktreeRecord,
    baseBranch: string | undefined,
    diskBudget: boolean,
  ): { readonly branch: 'deleted' | 'retained' | 'none'; readonly freshHead: string } {
    assertLaneResourcesAbsent(row);
    this.log('warn', 'worktree tree missing under a non-swept row — reconciling swept', {
      id: row.id,
      path: row.path,
      status: row.status,
    });
    let branchOutcome: 'deleted' | 'retained' | 'none';
    let freshHead = '';
    if (diskBudget) {
      branchOutcome = this.budgetBranch(row);
    } else {
      // DISPOSE FIRST, flip second (Perkins lane-B r4: mirror finishSweep —
      // flipping first re-opened the r3 wedge silently: a crash between the
      // flip and the disposal left every retry early-returning 'none').
      // The disposal resolves FRESH remote state first (Perkins r8): a
      // retry must never delete on the witness of stale tracking refs.
      const remote = this.safeFreshRemoteBranch(row.repoPath);
      assertLaneResourcesAbsent(row);
      branchOutcome = this.disposeLaneBranch(row, baseBranch, remote);
      freshHead = this.safeFreshHead(row.repoPath);
    }
    assertLaneResourcesAbsent(row);
    try {
      this.opts.ledger.setWorktreeStatus(row.id, 'swept');
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.reconciled',
        jobId: row.jobId,
        roundId: row.roundId,
        payload: { id: row.id, path: row.path, priorStatus: row.status, branch: diskBudget && branchOutcome === 'retained' ? 'retained-budget' : branchOutcome },
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

  /** What a disk budget release leaves of the lane's branch (#427 PR 3):
   * it asks origin nothing after a removal, so it disposes of nothing; a
   * branch still there is retained (lossless) for a later release or the
   * autopilot, which prove containment against a fresh fetch. */
  private budgetBranch(row: WorktreeRecord): 'retained' | 'none' {
    if ((row.kind !== 'job' && row.kind !== 'child') || row.branch === null) return 'none';
    const present = spawnGit(row.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`]);
    return present.status === 0 ? 'retained' : 'none';
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
    branchOutcome: 'deleted' | 'retained' | 'retained-budget' | 'none',
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
export function normalizedManifestPath(path: string): string {
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
 * output, never a rejection. With `timeoutMs` (#427 PR 3), git runs in its
 * own process group, and once the bound passes the group is killed (a
 * transport helper such as ssh with it) and the call answers `timedOut`
 * at once, without waiting for the output to close. */
function spawnGitAsync(repoPath: string, args: readonly string[], opts: Pick<SpawnGitOptions, 'timeoutMs' | 'noPrompt'> = {}): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error: string | null; readonly timedOut: boolean }> {
  return new Promise((resolveOut) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = (outcome: { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error: string | null; readonly timedOut: boolean }): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolveOut(outcome);
    };
    const child = execFile('git', [...args], {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...repositoryGitEnv(false), ...(opts.noPrompt === true ? { GIT_TERMINAL_PROMPT: '0' } : {}) },
      ...(opts.timeoutMs !== undefined ? { detached: true } : {}),
    }, (error, stdout, stderr) => {
      const code = (error as { readonly code?: unknown } | null)?.code;
      settle({
        status: error === null ? 0 : typeof code === 'number' ? code : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: error === null || typeof code === 'number' ? null : String(error),
        timedOut: false,
      });
    });
    child.stdin?.end();
    if (opts.timeoutMs !== undefined) {
      const timeoutMs = opts.timeoutMs;
      timer = setTimeout(() => {
        if (child.pid !== undefined) signalProcessGroup(child.pid, 'SIGKILL');
        settle({ status: null, stdout: '', stderr: '', error: `git ${args.join(' ')} timed out after ${String(timeoutMs)} ms`, timedOut: true });
      }, timeoutMs);
    }
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
