import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { LedgerApi, WorktreeRecord } from '../ledger/api.js';
import { applyWorktreeManifest, loadWorktreeManifest } from './manifest.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Worktree manager (SPEC ruling 18): the dispatch flow's first-class
 * worktree subsystem.
 *
 * (a) Bootstrap manifest — `<repo>/.gru-command/worktree.toml`, applied
 *     automatically at creation (see manifest.ts).
 * (b) Registry — the LEDGER is the authoritative map job → worktree →
 *     branch; creation happens at a freshly-resolved sha; sweeps match
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
  const out = execFileSyncGuard('ps', ['-axo', 'pid=,command=']);
  // Compare against BOTH the registered path and its realpath: the OS
  // reports resolved paths (/var → /private/var) while argv keeps the
  // spelling the spawner used.
  const candidates = new Set([treePath]);
  try {
    candidates.add(realpathSync(treePath));
  } catch {
    /* the sweep's own guards handle a missing tree */
  }
  const cwds = processCwds();
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

export interface SweepPreservation {
  readonly count: number;
  readonly destination: string;
}

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
    };

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
  /** Escalation when a sweep pauses on live processes (fail-loud ask). */
  readonly onSweepPaused?: (input: {
    readonly worktree: WorktreeRecord;
    readonly processes: readonly TreeProcess[];
  }) => void;
  readonly enumerateProcesses?: ProcessEnumerator;
  readonly log?: Log;
}

function runGit(repoPath: string, args: readonly string[]): string {
  const { status, stdout, stderr } = spawnGit(repoPath, args);
  if (status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${status}) in ${repoPath}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout.trim();
}

function spawnGit(
  repoPath: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export class WorktreeManager {
  private readonly opts: WorktreeManagerOptions;
  private readonly log: Log;
  private readonly enumerate: ProcessEnumerator;
  /** Same-repo serialization (ruling 18e): one creation at a time. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();
  /** Set by finishSweep's tail guard; drained by recordSweepEvent. */
  private tailFailure: string | null = null;

  constructor(opts: WorktreeManagerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.enumerate = opts.enumerateProcesses ?? psEnumerator;
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

  /** Freshly-resolved HEAD sha — always at creation/release time, never held. */
  private freshHead(repoPath: string): string {
    return runGit(repoPath, ['rev-parse', 'HEAD']);
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
   * branch `gru/<jobId>`, created at the CURRENT head of the repo —
   * sequential per repo (ruling 18e), manifest auto-applied (18a),
   * registry row written (18b).
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
      const sha = this.freshHead(repo.repoPath);
      runGit(repo.repoPath, ['worktree', 'add', '-b', branch, path, sha]);
      // Perkins lane-B r1 B1: the guard covers BOOTSTRAP *AND REGISTRATION*
      // — a registration failure (missing owner row, DB error) used to
      // leave tree+branch on disk with no registry row: retries wedged on
      // 'path already exists' and registry-paths-only sweeps never saw
      // the debris.
      let record;
      try {
        this.bootstrap(repo.repoPath, path);
        record = this.opts.ledger.registerWorktree({
          id: input.jobId,
          kind: 'job',
          repoPath: repo.repoPath,
          repoName: repo.repoName,
          path,
          branch,
          sha,
          jobId: input.jobId,
        });
      } catch (error) {
        this.rollbackPartialLane(repo.repoPath, path, branch, error);
        throw error;
      }
      this.log('info', 'job worktree created', { job: input.jobId, path, branch, sha });
      return record;
    });
  }

  /**
   * Detached-for-reviews (ruling 18d): review rounds check out a
   * DETACHED worktree at the ref under review — reviews never grow
   * branch debris.
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
      runGit(repo.repoPath, ['worktree', 'add', '--detach', path, input.ref]);
      // Same guard as job lanes (Perkins lane-B r1 B1): registration
      // failures roll the detached tree back — no unregistered debris.
      let record;
      try {
        this.bootstrap(repo.repoPath, path);
        const sha = runGit(path, ['rev-parse', 'HEAD']);
        record = this.opts.ledger.registerWorktree({
        id: input.roundId,
        kind: 'review',
        repoPath: repo.repoPath,
        repoName: repo.repoName,
        path,
        branch: null,
        sha,
        roundId: input.roundId,
          ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
        });
      } catch (error) {
        this.rollbackPartialLane(repo.repoPath, path, null, error);
        throw error;
      }
      this.log('info', 'review worktree created (detached)', { round: input.roundId, path, ref: input.ref });
      return record;
    });
  }

  /** Bootstrap manifest (18a): auto-apply at creation; missing = no-op. */
  private bootstrap(sourceRoot: string, worktreePath: string): void {
    const manifest = loadWorktreeManifest(sourceRoot, this.log);
    if (manifest === null) return;
    applyWorktreeManifest(manifest, {
      sourceRoot,
      worktreePath,
      setupTimeoutMs: this.opts.setupTimeoutMs,
      log: this.log,
    });
  }

  /** Registry rows (18b) — the manager never guesses paths. */
  listWorktrees(
    opts: { status?: 'active' | 'paused' | 'swept'; jobId?: string } = {},
  ): readonly WorktreeRecord[] {
    const filtered = opts.status !== undefined || opts.jobId !== undefined;
    return filtered ? this.opts.ledger.listWorktrees(opts) : this.opts.ledger.listWorktrees();
  }

  getWorktree(id: string): WorktreeRecord | null {
    return this.opts.ledger.getWorktree(id);
  }

  /**
   * Preserve-first ordered sweep (ruling 18c). Order is law:
   *   1. preserve untracked deliverables (never lost),
   *   2. enumerate processes rooted in the tree,
   *   3. live process → PAUSE and ask (never a silent kill),
   *   4. remove the worktree, containment-verified branch delete.
   * `confirmKill` is the human's ANSWER to the ask: it kills exactly the
   * enumerated pids, records the decision, and re-checks before removal.
   */
  async release(input: {
    worktreeId: string;
    confirmKill?: boolean;
    baseBranch?: string;
  }): Promise<SweepResult> {
    const row = this.opts.ledger.getWorktree(input.worktreeId);
    if (row === null) {
      throw new Error(
        `worktree "${input.worktreeId}" is not in the registry — sweeps match registry paths only (SPEC ruling 18b)`,
      );
    }
    if (row.status === 'swept') {
      return {
        status: 'swept',
        preserved: null,
        branch: 'none',
        freshHead: this.freshHead(row.repoPath),
      };
    }
    return this.withRepoLock(row.repoPath, async () => {
      // (0) Crash-window reconciliation (Perkins lane-B r2 c): the tree is
      // gone but the row never flipped (a kill between removal and the
      // registry write). Reconcile — swept + loud event — instead of
      // rejecting forever in preserveUntracked's missing cwd.
      if (!existsSync(row.path)) {
        // The reconcile disposes the branch exactly like finishSweep
        // (Perkins lane-B r3): containment-verified delete, or retain +
        // note — and the response reports the TRUE outcome.
        const branchOutcome = this.reconcileMissingTree(row, input.baseBranch);
        return {
          status: 'swept',
          preserved: null,
          branch: branchOutcome,
          freshHead: this.safeFreshHead(row.repoPath),
        } as const;
      }
      // (1) Preserve untracked deliverables FIRST — before any process
      // decision, before any removal. Deliverables are never hostages.
      const preserved = this.preserveUntracked(row);

      // (2) Enumerate processes rooted in the tree BEFORE removal.
      const processes = this.enumerate(row.path);
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
          return this.killAcknowledgedAndContinue(row, acknowledged, preserved, input.baseBranch);
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
      return this.finishSweep(row, preserved, input.baseBranch);
    });
  }

  /** Roll back a failed creation: remove the tree; delete a branch only
   * when THIS call created it (reviews are detached — nothing to delete).
   * Rollback failures are logged loudly but never mask the original error. */
  private rollbackPartialLane(
    repoPath: string,
    path: string,
    branchCreatedByThisCall: string | null,
    originalError: unknown,
  ): void {
    try {
      runGit(repoPath, ['worktree', 'remove', '--force', path]);
    } catch (rollbackError) {
      this.log('error', 'rollback failed to remove the partial worktree', {
        path,
        error: String(rollbackError),
      });
    }
    if (branchCreatedByThisCall !== null) {
      try {
        runGit(repoPath, ['branch', '-D', branchCreatedByThisCall]);
      } catch (rollbackError) {
        this.log('error', 'rollback failed to delete the partial branch (job id may be wedged)', {
          branch: branchCreatedByThisCall,
          error: String(rollbackError),
        });
      }
    }
    void originalError;
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
  private preserveUntracked(row: WorktreeRecord): SweepPreservation | null {
    const status = runGit(row.path, ['status', '--porcelain', '-z', '--untracked-files=all']);
    const untracked = status
      .split('\0')
      .filter((entry) => entry !== '')
      .filter((entry) => entry.startsWith('?? '))
      .map((entry) => entry.slice(3))
      .filter((rel) => rel !== '');
    if (untracked.length === 0) return null;
    const destination = join(this.opts.preserveRoot, row.id, new Date().toISOString().replace(/[:.]/g, '-'));
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
    if (preservedCount === 0) return null;
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.preserved',
      jobId: row.jobId,
      roundId: row.roundId,
      payload: { id: row.id, files: preservedCount, destination },
    });
    this.log('info', 'untracked deliverables preserved before sweep', {
      id: row.id,
      files: preservedCount,
      destination,
    });
    return { count: preservedCount, destination };
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
    return this.finishSweep(row, preserved, baseBranch);
  }

  /** Removal + containment branch delete + fresh head (shared tail). */
  private finishSweep(
    row: WorktreeRecord,
    preserved: SweepPreservation | null,
    baseBranch: string | undefined,
  ): SweepResult {
    // (4a) Worktree removal. A failure HERE throws with the tree intact
    // and the row unchanged — retry-safe.
    runGit(row.repoPath, ['worktree', 'remove', '--force', row.path]);

    // (4b/5) POST-REMOVAL TAIL (Perkins lane-B r1 B2): the tree is GONE —
    // the registry must follow even if the tail hiccups. A stranded
    // non-swept row over a removed tree wedges every retry
    // (preserveUntracked dies on the missing tree). Catch-and-mark.
    let branchOutcome: 'deleted' | 'retained' | 'none' = 'none';
    let freshHead = '';
    try {
      // Containment-verified branch delete — job lanes only; a branch
      // is deleted only when its commits are provably contained in an
      // existing ref; otherwise it is RETAINED and noted.
      if (row.kind === 'job' && row.branch !== null) {
        branchOutcome = this.deleteBranchContained(row, baseBranch);
      }
      // Release re-resolves the FRESH head (ruling 18e).
      freshHead = this.freshHead(row.repoPath);
    } catch (error) {
      this.log('error', 'sweep tail failed after removal — row still flips swept', {
        id: row.id,
        error: String(error),
      });
      this.tailFailure = String(error);
    }
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
    this.recordSweepEvent(row, preserved, branchOutcome, freshHead);
    this.log('info', 'worktree swept', { id: row.id, branch: branchOutcome, freshHead });
    return { status: 'swept', preserved, branch: branchOutcome, freshHead };
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
  ): 'deleted' | 'retained' | 'none' {
    this.log('warn', 'worktree tree missing under a non-swept row — reconciling swept', {
      id: row.id,
      path: row.path,
      status: row.status,
    });
    try {
      this.opts.ledger.setWorktreeStatus(row.id, 'swept');
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.reconciled',
        jobId: row.jobId,
        roundId: row.roundId,
        payload: { id: row.id, path: row.path, priorStatus: row.status },
      });
    } catch (error) {
      this.log('error', 'reconciliation write failed — retry will reconcile again', {
        id: row.id,
        error: String(error),
      });
    }
    let branchOutcome: 'deleted' | 'retained' | 'none' = 'none';
    if (row.kind === 'job' && row.branch !== null) {
      try {
        branchOutcome = this.deleteBranchContained(row, baseBranch);
      } catch (error) {
        // Disposal failure must not wedge the reconciliation: the row is
        // already swept; record the failure loudly for the operator.
        this.log('error', 'reconciled lane branch disposal failed', {
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
          this.log('error', 'sweep-tail-failed event write failed during reconcile', {
            id: row.id,
            error: String(eventError),
          });
        }
      }
    }
    return branchOutcome;
  }

  private safeFreshHead(repoPath: string): string {
    try {
      return this.freshHead(repoPath);
    } catch {
      return '';
    }
  }

  /** Best-effort sweep events (Perkins lane-B r2): a ledger hiccup after
   * the flip must never wedge the sweep — each write is guarded. */
  private recordSweepEvent(
    row: WorktreeRecord,
    preserved: SweepPreservation | null,
    branchOutcome: 'deleted' | 'retained' | 'none',
    freshHead: string,
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
        },
      });
    } catch (eventError) {
      this.log('error', 'worktree.swept event write failed', { id: row.id, error: String(eventError) });
    }
  }

  /**
   * Containment-verified delete: `git branch -d` proves merge-containment
   * itself; when it refuses (unmerged into HEAD), check containment
   * against the job's base branch before any force; otherwise retain.
   */
  private deleteBranchContained(
    row: WorktreeRecord,
    baseBranch: string | undefined,
  ): 'deleted' | 'retained' {
    const branch = row.branch as string;
    const soft = spawnGit(row.repoPath, ['branch', '-d', branch]);
    if (soft.status === 0) return 'deleted';
    let base: string;
    if (baseBranch !== undefined) {
      base = baseBranch;
    } else {
      try {
        base = runGit(row.repoPath, ['symbolic-ref', '--short', 'HEAD']);
      } catch {
        // No explicit base and the main checkout is detached: containment
        // is UNPROVABLE — retain loudly, never throw (Perkins lane-B r1).
        this.opts.ledger.appendCustomEvent({
          kind: 'worktree.branch-retained',
          jobId: row.jobId,
          payload: { id: row.id, branch, reason: 'base branch unresolvable (detached HEAD, none given)' },
        });
        this.opts.ledger.noteWorktree(row.id, `branch ${branch} retained: base branch unresolvable`);
        return 'retained';
      }
    }
    const contained = spawnGit(row.repoPath, ['merge-base', '--is-ancestor', branch, base]);
    if (contained.status === 0) {
      runGit(row.repoPath, ['branch', '-D', branch]);
      return 'deleted';
    }
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.branch-retained',
      jobId: row.jobId,
      payload: { id: row.id, branch, reason: `commits not contained in ${base}` },
    });
    this.opts.ledger.noteWorktree(row.id, `branch ${branch} retained: not contained in ${base}`);
    this.log('warn', 'worktree branch retained (uncontained commits)', { id: row.id, branch, base });
    return 'retained';
  }
}

/** Directory sanity for option wiring (fail loud at boot, not mid-heist). */
export function ensureDirectoryEmptyOrMissing(path: string): boolean {
  if (!existsSync(path)) return true;
  return readdirSync(path).length === 0;
}
