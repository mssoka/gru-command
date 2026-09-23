/**
 * Deploy drift (board UX v4): is the RUNNING service build behind
 * origin/main? The incident this card exists for: a service 43 commits
 * behind main stayed up for hours because nothing surfaced the gap.
 *
 * The service reports the revision it was BUILT from (dist/build-rev.json,
 * stamped by tools/write-build-rev.mjs), and a background tracker counts
 * origin/main commits not reachable from it. The board snapshot carries
 * the cached view — one git check per interval, never one per client.
 *
 * Every git step is best-effort and loud in `checkError`: an offline host
 * still renders (against the last fetched origin/main), it never invents
 * a count.
 */
import { execFile } from 'node:child_process';
import type { LogLevel } from '../logger.js';
import type { BuildInfo } from '../build-info.js';

/** Git command runner: resolves with stdout, rejects on any failure. */
export type GitRunner = (args: readonly string[], timeoutMs: number) => Promise<string>;

export interface DeployDriftView {
  /** Git rev the running service was built from (null = unknown). */
  readonly buildRev: string | null;
  /** Commit time of the running build's rev (ISO; null = unknown). */
  readonly buildCommittedAt: string | null;
  /** origin/main as last observed (remote truth, else last local fetch). */
  readonly originMainRev: string | null;
  /** Commit time of origin/main (ISO; null = object not local). */
  readonly originMainCommittedAt: string | null;
  /** origin/main commits not reachable from the build (null = unknown). */
  readonly commitsBehind: number | null;
  /** When this view was last computed (ISO). */
  readonly checkedAt: string | null;
  /** Why the last check could not fully prove the count (null = clean). */
  readonly checkError: string | null;
}

export interface DeployDriftTrackerOptions {
  /** The service's own checkout root (defaults resolved by the caller). */
  readonly repoRoot: string;
  readonly build: BuildInfo;
  /** Test seam; defaults to `git -C <repoRoot>`. */
  readonly runGit?: GitRunner;
  /** Upstream re-check cadence; default 5 min. 0 disables the timer. */
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_INTERVAL_MS = 300_000;
const LS_REMOTE_TIMEOUT_MS = 10_000;
const REV_PARSE_TIMEOUT_MS = 5_000;
const REV_LIST_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** `git -C <root> <args>` as an async runner (never blocks the event loop). */
export function gitRunnerFor(repoRoot: string): GitRunner {
  return (args, timeoutMs) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['-C', repoRoot, ...args],
        { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) reject(error);
          else resolve(stdout);
        },
      );
    });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DeployDriftTracker {
  private readonly opts: DeployDriftTrackerOptions;
  private readonly runGit: GitRunner;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
  private readonly initial: DeployDriftView;
  private current: DeployDriftView;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<DeployDriftView> | null = null;

  constructor(opts: DeployDriftTrackerOptions) {
    this.opts = opts;
    this.runGit = opts.runGit ?? gitRunnerFor(opts.repoRoot);
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.initial = {
      buildRev: opts.build.rev,
      buildCommittedAt: opts.build.committedAt,
      originMainRev: null,
      originMainCommittedAt: null,
      commitsBehind: null,
      checkedAt: null,
      checkError: null,
    };
    this.current = this.initial;
  }

  /** Kick the first check (async — boot is never blocked by git/network)
   * and schedule the re-check cadence. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    void this.refresh();
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => void this.refresh(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** The cached view the board snapshot renders. */
  view(): DeployDriftView {
    return this.current;
  }

  /** Recompute the drift view (coalesced: overlapping calls share one run). */
  refresh(): Promise<DeployDriftView> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.compute()
      .catch((error: unknown) => {
        // compute() handles per-step errors; this is the last-resort guard.
        this.log('error', 'deploy drift refresh failed', { error: messageOf(error) });
        return this.current;
      })
      .then((view) => {
        this.current = view;
        return view;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async compute(): Promise<DeployDriftView> {
    const { rev: buildRev, committedAt: buildCommittedAt } = this.opts.build;
    const checkedAt = new Date(this.now()).toISOString();
    let checkError: string | null = null;

    // 1. Find origin/main. `ls-remote` is the remote truth; the local
    //    remote-tracking ref is the offline fallback (and is honest about
    //    its age through checkError).
    let originMainRev: string | null = null;
    let remoteRev: string | null = null;
    let localRev: string | null = null;
    try {
      remoteRev = await this.remoteMainRev();
    } catch (error) {
      checkError = `origin unreachable (${messageOf(error)})`;
    }
    try {
      localRev = await this.localMainRev();
    } catch {
      localRev = null;
    }
    if (remoteRev !== null) originMainRev = remoteRev;
    else if (localRev !== null) {
      originMainRev = localRev;
      checkError ??= 'origin unreachable — counting against the last fetched origin/main';
    } else {
      checkError =
        checkError === null
          ? 'origin/main not found (no remote reachable, no local ref)'
          : `${checkError} — no local origin/main ref`;
    }

    // 2. Count commits reachable from origin/main but not from the build.
    //    A remote sha whose objects are not local needs one fetch first.
    let commitsBehind: number | null = null;
    if (originMainRev !== null && buildRev !== null) {
      commitsBehind = await this.countBehind(buildRev, originMainRev);
      if (commitsBehind === null && remoteRev !== null) {
        try {
          await this.runGit(['fetch', '--quiet', 'origin', 'main'], FETCH_TIMEOUT_MS);
          commitsBehind = await this.countBehind(buildRev, remoteRev);
          if (commitsBehind !== null) checkError = null; // remote truth is now local
        } catch {
          // fetch offline — fall back to the local ref if it differs.
        }
      }
      if (commitsBehind === null && localRev !== null && originMainRev !== localRev) {
        commitsBehind = await this.countBehind(buildRev, localRev);
        if (commitsBehind !== null) {
          originMainRev = localRev;
          checkError = 'origin/main objects not local — counting against the last fetched origin/main';
        }
      }
      if (commitsBehind === null) {
        checkError ??= 'origin/main commit not available locally — count unknown';
      }
    } else if (buildRev === null) {
      checkError ??= 'running build revision unknown (dist/build-rev.json missing)';
    }

    // 3. Commit time of the origin tip when its object is local.
    let originMainCommittedAt: string | null = null;
    if (originMainRev !== null) {
      try {
        originMainCommittedAt = await this.commitTime(originMainRev);
      } catch {
        originMainCommittedAt = null; // not fatal — the count is the signal
      }
    }

    return {
      buildRev,
      buildCommittedAt,
      originMainRev,
      originMainCommittedAt,
      commitsBehind,
      checkedAt,
      checkError,
    };
  }

  private async remoteMainRev(): Promise<string | null> {
    const stdout = await this.runGit(['ls-remote', 'origin', 'refs/heads/main'], LS_REMOTE_TIMEOUT_MS);
    const first = stdout.trim().split('\n')[0] ?? '';
    const sha = first.split('\t')[0]?.trim() ?? '';
    return SHA_PATTERN.test(sha) ? sha : null;
  }

  private async localMainRev(): Promise<string | null> {
    const stdout = await this.runGit(
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
      REV_PARSE_TIMEOUT_MS,
    );
    const sha = stdout.trim();
    return SHA_PATTERN.test(sha) ? sha : null;
  }

  private async countBehind(buildRev: string, originMainRev: string): Promise<number | null> {
    try {
      const stdout = await this.runGit(
        ['rev-list', '--count', `${buildRev}..${originMainRev}`],
        REV_LIST_TIMEOUT_MS,
      );
      const count = Number(stdout.trim());
      return Number.isSafeInteger(count) && count >= 0 ? count : null;
    } catch {
      return null;
    }
  }

  private async commitTime(rev: string): Promise<string | null> {
    const stdout = await this.runGit(['log', '-1', '--format=%cI', rev], REV_PARSE_TIMEOUT_MS);
    const stamp = stdout.trim();
    return stamp === '' ? null : stamp;
  }
}
