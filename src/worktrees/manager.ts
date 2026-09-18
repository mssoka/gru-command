import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
}

/** Injectable process enumeration (default: `ps` matched on the
 * REGISTERED path — see ruling 18b/c). */
export type ProcessEnumerator = (treePath: string) => readonly TreeProcess[];

/** The system process table, filtered by a registered worktree path. */
export function psEnumerator(treePath: string): readonly TreeProcess[] {
  const out = execFileSyncGuard('ps', ['-axo', 'pid=,command=']);
  const processes: TreeProcess[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const command = trimmed.slice(space + 1).trim();
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    // Registry paths only: a process counts when the registered tree
    // path appears in its command line (cwd-anchored shells, editors,
    // watchers spawned inside the tree all reference it).
    if (command.includes(treePath)) {
      processes.push({ pid, command });
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
      try {
        this.bootstrap(repo.repoPath, path);
      } catch (error) {
        // A half-bootstrapped tree is never handed out — roll it back.
        runGit(repo.repoPath, ['worktree', 'remove', '--force', path]);
        throw error;
      }
      const record = this.opts.ledger.registerWorktree({
        id: input.jobId,
        kind: 'job',
        repoPath: repo.repoPath,
        repoName: repo.repoName,
        path,
        branch,
        sha,
        jobId: input.jobId,
      });
      this.log('info', 'job worktree created', { job: input.jobId, path, branch, sha });
      return record;
    });
  }

  /**
   * Detached-for-reviews (ruling 18d): review rounds check out a
   * DETACHED worktree at the ref under review — reviews never grow
   * branch debris.
   */
  async createReviewWorktree(input: { repoPath: string; roundId: string; ref: string }): Promise<WorktreeRecord> {
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
      try {
        this.bootstrap(repo.repoPath, path);
      } catch (error) {
        runGit(repo.repoPath, ['worktree', 'remove', '--force', path]);
        throw error;
      }
      const sha = runGit(path, ['rev-parse', 'HEAD']);
      const record = this.opts.ledger.registerWorktree({
        id: input.roundId,
        kind: 'review',
        repoPath: repo.repoPath,
        repoName: repo.repoName,
        path,
        branch: null,
        sha,
        roundId: input.roundId,
      });
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
  listWorktrees(status?: 'active' | 'paused' | 'swept'): readonly WorktreeRecord[] {
    return status === undefined
      ? this.opts.ledger.listWorktrees()
      : this.opts.ledger.listWorktrees({ status });
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
      // (1) Preserve untracked deliverables FIRST — before any process
      // decision, before any removal. Deliverables are never hostages.
      const preserved = this.preserveUntracked(row);

      // (2) Enumerate processes rooted in the tree BEFORE removal.
      const processes = this.enumerate(row.path);
      if (processes.length > 0) {
        // (3) PAUSE AND ASK — a live process is never silently killed.
        if (input.confirmKill !== true) {
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
        // The ask was answered: kill EXACTLY the enumerated pids, on the
        // record, then re-check. Survivors pause the sweep again.
        this.opts.ledger.appendCustomEvent({
          kind: 'worktree.kill-confirmed',
          jobId: row.jobId,
          roundId: row.roundId,
          payload: { id: row.id, pids: processes.map((p) => p.pid) },
        });
        for (const proc of processes) {
          try {
            process.kill(proc.pid, 'SIGTERM');
          } catch (error) {
            this.log('warn', 'confirmed kill failed for pid', { pid: proc.pid, error: String(error) });
          }
        }
        const survivors = this.enumerate(row.path).filter((p) => processes.some((prev) => prev.pid === p.pid));
        if (survivors.length > 0) {
          const note = `sweep paused: pids ${survivors.map((p) => p.pid).join(', ')} survived SIGTERM`;
          this.opts.ledger.setWorktreeStatus(row.id, 'paused', note);
          return { status: 'paused', processes: survivors, preserved, note };
        }
      }

      // (4a) Worktree removal.
      runGit(row.repoPath, ['worktree', 'remove', '--force', row.path]);

      // (4b) Containment-verified branch delete — job lanes only; a
      // branch is deleted only when its commits are provably contained
      // in an existing ref; otherwise it is RETAINED and noted (never
      // force-deleted on faith).
      let branchOutcome: 'deleted' | 'retained' | 'none' = 'none';
      if (row.kind === 'job' && row.branch !== null) {
        branchOutcome = this.deleteBranchContained(row, input.baseBranch);
      }

      // (5) Release re-resolves the FRESH head (ruling 18e): follow-on
      // work starts from now, never from the held sha.
      const freshHead = this.freshHead(row.repoPath);
      this.opts.ledger.setWorktreeStatus(row.id, 'swept');
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
      this.log('info', 'worktree swept', { id: row.id, branch: branchOutcome, freshHead });
      return { status: 'swept', preserved, branch: branchOutcome, freshHead };
    });
  }

  /** Copy untracked-not-ignored deliverables into the preserve root. */
  private preserveUntracked(row: WorktreeRecord): SweepPreservation | null {
    const status = runGit(row.path, ['status', '--porcelain', '--untracked-files=all']);
    const untracked = status
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('?? '))
      .map((line) => line.slice(3).trim())
      .filter((rel) => rel !== '');
    if (untracked.length === 0) return null;
    const destination = join(this.opts.preserveRoot, row.id, new Date().toISOString().replace(/[:.]/g, '-'));
    for (const rel of untracked) {
      const source = join(row.path, rel);
      if (!statSync(source).isFile()) continue; // nested oddities: files only
      const dest = join(destination, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
    }
    this.opts.ledger.appendCustomEvent({
      kind: 'worktree.preserved',
      jobId: row.jobId,
      roundId: row.roundId,
      payload: { id: row.id, files: untracked.length, destination },
    });
    this.log('info', 'untracked deliverables preserved before sweep', {
      id: row.id,
      files: untracked.length,
      destination,
    });
    return { count: untracked.length, destination };
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
    const base = baseBranch ?? runGit(row.repoPath, ['symbolic-ref', '--short', 'HEAD']);
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
