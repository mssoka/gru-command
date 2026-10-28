import {
  accessSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { withSessionLockCoordination } from './lock-coordination.js';
import type { LogLevel } from '../logger.js';

/** Minimal structured-log sink the store depends on. */
export type StoreLog = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export interface SessionLockInfo {
  readonly host?: string;
  readonly pid: number;
  readonly bootId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

export class LockBusyError extends Error {
  constructor(
    readonly file: string,
    readonly holder: SessionLockInfo,
  ) {
    super(
      `session file ${file} is locked by pid ${holder.pid} (acquired ${holder.acquiredAt}); ` +
        'refusing second writer — single-writer rule (SPEC ruling 1/12)',
    );
    this.name = 'LockBusyError';
  }
}

/** The lock file cannot be parsed — refuse to steal; loud, never silent. */
export class LockUnreadableError extends Error {
  constructor(
    readonly file: string,
    readonly detail: string,
  ) {
    super(
      `session lock ${file} is unreadable (${detail}); refusing to steal — ` +
        'investigate the lock file (a corrupt lock is never auto-deleted)',
    );
    this.name = 'LockUnreadableError';
  }
}

export interface GrowthFinding {
  readonly file: string;
  readonly kind: 'grew' | 'shrunk' | 'deleted';
  readonly grewByBytes: number;
  readonly previousBytes: number;
  readonly currentBytes: number;
}

export interface GrowthReport {
  /** Files that changed since the last persisted snapshot — normally while
   * the service was down; a hard stop during a pass can also cover bytes
   * written just before it. */
  readonly findings: readonly GrowthFinding[];
  /** ok = baseline read; missing = first boot ever; corrupt = baseline unreadable (degraded — findings are against an empty baseline). */
  readonly snapshotState: 'ok' | 'missing' | 'corrupt';
  readonly scannedAt: string;
}

/**
 * One tracked session file as the backup pass sees it: enumerated once and
 * stat'ed once, then reused for the copy decision, the prune and the size
 * snapshot (SPEC ruling 12).
 */
export interface SessionSourceScan {
  /** Absolute path of the live session file. */
  readonly file: string;
  /** Path relative to the sessions dir — the change-baseline key. */
  readonly key: string;
  /** Flattened key the backup file name is built from. */
  readonly backupKey: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/** Fingerprint of the content last copied into a source's backup. */
export interface BackupBaselineEntry {
  /** Size of the source when the pass scanned it for the copy. */
  readonly size: number;
  /** Modification time when the pass scanned it for the copy. */
  readonly mtimeMs: number;
  /**
   * Status-change time when the pass scanned it. A write cannot restore it
   * through the filesystem API (unlike mtime), so a same-size rewrite with a
   * restored mtime still reads as changed.
   */
  readonly ctimeMs: number;
  /**
   * File name (inside the backup dir) of the generation this entry records.
   * The pass verifies it still exists: an out-of-band reclaim of the backup
   * dir must never silence a source's backups forever.
   */
  readonly backup: string;
}

/** What one backup pass did (`skipped` = unchanged sources left alone). */
export interface BackupPassResult {
  readonly created: string[];
  readonly pruned: string[];
  readonly skipped: number;
}

/**
 * `sessions/backup-baseline.json` — the recorded change baseline of the
 * hourly backup pass. Keys are source paths relative to the sessions dir.
 * Deliberately a SEPARATE file from `store-state.json`: that one is a bare
 * size map whose keys growth detection reads as session files.
 */
export interface BackupBaseline {
  readonly version: typeof BACKUP_BASELINE_VERSION;
  readonly sources: { readonly [relativePath: string]: BackupBaselineEntry };
}

interface SizeSnapshot {
  readonly [file: string]: number;
}

const LOCK_HEARTBEAT_MS = 5_000;
/** Heartbeat age permits bounded inspection, never proves owner absence. */
const LOCK_STALE_MS = 60_000;
const BACKUP_INTERVAL_MS = 60 * 60 * 1000; // hourly (SPEC ruling 12)
/** One ISO-hour slot: the span a generation's stamp stands for. */
const BACKUP_SLOT_MS = 60 * 60 * 1000;
const BACKUP_SUFFIX = '.bak';
const BACKUP_BASELINE_VERSION = 1;
/**
 * Maximum backup-generation age. A source that stopped changing would
 * otherwise hold every generation it ever produced: the count retention only
 * bounds sources that keep producing. Seven days matches the measured idle
 * threshold of the live instance (sources idle longer than a week held the
 * bulk of the generations nobody would ever restore from).
 */
export const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Generations kept per live source (the default the docs state). */
export const DEFAULT_BACKUP_RETENTION = 24;

/**
 * Durable session store (EPICS E2 story 3; SPEC ruling 12).
 *
 * Owns everything AROUND the session files: directory layout, the exclusive
 * inter-process lock for the active file, hourly rolling backups with
 * retention, and boot-time growth detection (the emergency-console reload
 * contract). The files themselves are written append-only by the runtime
 * adapter — this store never rewrites them.
 */
export class SessionStore {
  readonly sessionsDir: string;
  /** Identifies locks created by THIS store instance (release safety). */
  private readonly bootId = `${process.pid}-${Date.now()}`;
  private readonly backupDir: string;
  private readonly stateFile: string;
  private readonly baselineFile: string;
  /** The intended baseline, written before the pass's copies (see runBackup). */
  private readonly baselinePendingFile: string;
  private readonly retention: number;
  private readonly backupMaxAgeMs: number;
  private readonly log: StoreLog;
  private readonly heldLocks = new Set<string>();
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    readonly dataDir: string,
    opts: { retention?: number; backupMaxAgeMs?: number; log?: StoreLog } = {},
  ) {
    if (opts.backupMaxAgeMs !== undefined && (!Number.isSafeInteger(opts.backupMaxAgeMs) || opts.backupMaxAgeMs < 0)) {
      throw new Error(
        `session store backupMaxAgeMs must be a non-negative safe integer of milliseconds (got ${String(opts.backupMaxAgeMs)})`,
      );
    }
    if (opts.retention !== undefined && (!Number.isSafeInteger(opts.retention) || opts.retention < 0)) {
      throw new Error(`session store retention must be a non-negative safe integer (got ${String(opts.retention)})`);
    }
    this.sessionsDir = join(dataDir, 'sessions');
    this.backupDir = join(this.sessionsDir, 'backups');
    this.stateFile = join(this.sessionsDir, 'store-state.json');
    this.baselineFile = join(this.sessionsDir, 'backup-baseline.json');
    this.baselinePendingFile = join(this.sessionsDir, 'backup-baseline.json.pending');
    this.retention = opts.retention ?? DEFAULT_BACKUP_RETENTION;
    this.backupMaxAgeMs = opts.backupMaxAgeMs ?? BACKUP_MAX_AGE_MS;
    this.log = opts.log ?? (() => {});
    // Session transcripts carry full prompt/tool content — the sessions
    // dir is owner-only; nothing else should traverse it.
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Role + cwd scoped session dir, mirroring the standard pi pattern
   * (`--<dashed-cwd>--`) under the instance data dir (SPEC rulings 7/12).
   * An 8-hex cwd-hash suffix makes distinct-but-dash-colliding cwds
   * (/a-b/c vs /a/b-c) unique while keeping the pi-flavored prefix.
   */
  sessionDirFor(role: string, cwd: string): string {
    const resolved = resolve(cwd);
    const dashed = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
    return join(this.sessionsDir, role, `${dashed}-${hash}`);
  }

  lockFileFor(sessionFile: string): string {
    return `${sessionFile}.lock`;
  }

  private unlinkLockFile(lockFile: string): void {
    unlinkSync(lockFile);
  }

  /** Whether THIS store instance currently holds the file's lock. */
  isHeld(sessionFile: string): boolean {
    return this.heldLocks.has(sessionFile);
  }

  /**
   * Acquire the exclusive lock for a session file. The lock is a sidecar
   * `.lock` file created with O_EXCL holding pid + heartbeat; a second
   * writer is rejected loudly (LockBusyError naming the holder). A stale
   * heartbeat permits inspection only; reclaim requires a bound local
   * owner positively absent at the exact unchanged lock pathname.
   */
  acquireLock(sessionFile: string, allowStaleTakeover = true): void {
    if (this.disposed) throw new Error('session store disposed');
    withSessionLockCoordination(sessionFile, () => this.acquireLockWithinCoordination(sessionFile, allowStaleTakeover));
  }

  private acquireLockWithinCoordination(sessionFile: string, allowStaleTakeover: boolean): void {
    if (this.heldLocks.has(sessionFile)) return; // already ours (re-entrant)
    const lockFile = this.lockFileFor(sessionFile);
    const info: SessionLockInfo = {
      host: hostname(),
      pid: process.pid,
      bootId: this.bootId,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    // Each EEXIST either throws LockBusyError (genuinely held) or steals a
    // stale/unreadable lock; the bounded counter keeps a pathological
    // steal-lose-retry race from spinning forever.
    let steals = 0;
    for (;;) {
      let fd: number;
      try {
        fd = openSync(lockFile, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (steals >= 3) {
          throw new Error(`cannot acquire session lock ${lockFile}: lock keeps reappearing`);
        }
        steals += 1;
        if (!allowStaleTakeover) throw new LockBusyError(lockFile, JSON.parse(readFileSync(lockFile, 'utf8')) as SessionLockInfo);
        this.stealIfStale(lockFile);
        continue;
      }
      try {
        writeFileSync(fd, `${JSON.stringify(info)}\n`, 'utf-8');
      } finally {
        closeSync(fd);
      }
      break;
    }
    this.heldLocks.add(sessionFile);
    const heartbeat = setInterval(() => {
      try {
        withSessionLockCoordination(sessionFile, () => {
          const current = JSON.parse(readFileSync(lockFile, 'utf-8')) as SessionLockInfo;
          if (current.host === info.host && current.pid === info.pid && current.bootId === info.bootId) {
            const next = `${JSON.stringify({ ...current, heartbeatAt: new Date().toISOString() })}\n`;
            // Fixed-length rewrite keeps the lock file tiny (pid, bootId
            // and ISO heartbeat timestamps are constant width); O_EXCL
            // ownership was proven above and the heartbeat owns this file.
            const wfd = openSync(lockFile, 'r+');
            writeFileSync(wfd, next, 'utf-8');
            closeSync(wfd);
          }
        });
      } catch {
        // A stolen/unreadable lock file is re-evaluated on release; never
        // take the process down from housekeeping.
      }
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    this.heartbeats.set(sessionFile, heartbeat);
  }

  /** Bounded checkpoint recovery: reclaim only the exact absent original
   * PID's lock, never heartbeat expiry or logical-minion reuse. */
  ownedLockIdentity(sessionFile: string): { readonly host: string; readonly pid: number; readonly bootId: string } {
    return withSessionLockCoordination(sessionFile, () => {
      const lockFile = this.lockFileFor(sessionFile);
      const holder = JSON.parse(readFileSync(lockFile, 'utf8')) as SessionLockInfo;
      if (!this.heldLocks.has(sessionFile) || holder.host !== hostname() || holder.pid !== process.pid || holder.bootId !== this.bootId) {
        throw new LockBusyError(lockFile, holder);
      }
      return { host: holder.host, pid: holder.pid, bootId: holder.bootId };
    });
  }

  acquireLockAfterHostExit(sessionFile: string, expectedPid: number, expectedOwner?: { readonly host: string; readonly pid: number; readonly bootId: string }): void {
    if (this.disposed) throw new Error('session store disposed');
    withSessionLockCoordination(sessionFile, () => this.acquireLockAfterHostExitWithinCoordination(sessionFile, expectedPid, expectedOwner));
  }

  private acquireLockAfterHostExitWithinCoordination(sessionFile: string, expectedPid: number,
    expectedOwner?: { readonly host: string; readonly pid: number; readonly bootId: string }): void {
    const lockFile = this.lockFileFor(sessionFile);
    let holder: SessionLockInfo;
    try { holder = JSON.parse(readFileSync(lockFile, 'utf8')) as SessionLockInfo; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.acquireLockWithinCoordination(sessionFile, false); return; }
      throw new LockUnreadableError(lockFile, String(error));
    }
    const snapshot = statSync(lockFile);
    if (expectedOwner === undefined || expectedOwner.pid !== expectedPid || expectedOwner.host !== hostname() || holder.host !== expectedOwner.host ||
        holder.pid !== expectedOwner.pid || holder.bootId !== expectedOwner.bootId) throw new LockBusyError(lockFile, holder);
    try { process.kill(expectedPid, 0); throw new LockBusyError(lockFile, holder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    // Re-read exact content before unlink; the coordinator keeps replacement
    // owners from entering between this identity check and pathname removal.
    const current = statSync(lockFile);
    if (current.ino !== snapshot.ino || current.dev !== snapshot.dev || JSON.stringify(JSON.parse(readFileSync(lockFile, 'utf8'))) !== JSON.stringify(holder)) throw new LockBusyError(lockFile, holder);
    this.unlinkLockFile(lockFile);
    this.acquireLockWithinCoordination(sessionFile, false);
  }

  private stealIfStale(lockFile: string): void {
    let holder: SessionLockInfo;
    try {
      holder = JSON.parse(readFileSync(lockFile, 'utf-8')) as SessionLockInfo;
    } catch (firstError) {
      // Transient read failures (racing the holder's own heartbeat rewrite,
      // momentary I/O) must NOT unlink a live lock — retry once, then
      // refuse loudly. A corrupt lock is never auto-deleted.
      try {
        holder = JSON.parse(readFileSync(lockFile, 'utf-8')) as SessionLockInfo;
      } catch (secondError) {
        throw new LockUnreadableError(lockFile, String(secondError ?? firstError));
      }
    }
    if (typeof holder !== 'object' || holder === null || Array.isArray(holder)) throw new LockUnreadableError(lockFile, 'owner identity is not an object');
    const age = Date.now() - Date.parse(holder.heartbeatAt);
    if (!Number.isFinite(age) || age <= LOCK_STALE_MS || holder?.host !== hostname() ||
        !Number.isSafeInteger(holder.pid) || holder.pid <= 0 || typeof holder.bootId !== 'string' || holder.bootId.trim() === '') {
      throw new LockBusyError(lockFile, holder);
    }
    const snapshot = statSync(lockFile);
    try { process.kill(holder.pid, 0); throw new LockBusyError(lockFile, holder); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new LockBusyError(lockFile, holder);
    }
    // The coordinator serializes cooperative owners. Re-read the inode and
    // complete identity as well: absence of a predecessor never permits
    // deleting a replacement installed during observation.
    const current = statSync(lockFile);
    if (current.ino !== snapshot.ino || current.dev !== snapshot.dev ||
        JSON.stringify(JSON.parse(readFileSync(lockFile, 'utf8'))) !== JSON.stringify(holder)) {
      throw new LockBusyError(lockFile, holder);
    }
    this.unlinkLockFile(lockFile);
    this.log('warn', 'stale session lock reclaimed after local owner absence', {
      lockFile, holder_pid: holder.pid, heartbeat_age_ms: age,
    });
  }

  releaseLock(sessionFile: string): void {
    if (!this.heldLocks.has(sessionFile) && !this.heartbeats.has(sessionFile)) return;
    withSessionLockCoordination(sessionFile, () => {
      const heartbeat = this.heartbeats.get(sessionFile);
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        this.heartbeats.delete(sessionFile);
      }
      this.releaseLockWithinCoordination(sessionFile);
    });
  }

  private releaseLockWithinCoordination(sessionFile: string): void {
    if (!this.heldLocks.delete(sessionFile)) return;
    const lockFile = this.lockFileFor(sessionFile);
    // Only unlink OUR lock: if the lock was stolen while we were
    // unresponsive, the file now belongs to the stealer — deleting it
    // would admit a third writer while the second is active.
    let ours = false;
    try {
      const current = JSON.parse(readFileSync(lockFile, 'utf-8')) as SessionLockInfo;
      ours = current.host === hostname() && current.pid === process.pid && current.bootId === this.bootId;
    } catch {
      ours = false; // gone or unreadable — nothing safe to delete
    }
    if (ours) {
      try {
        this.unlinkLockFile(lockFile);
      } catch {
        // Already gone — nothing to do.
      }
    } else {
      this.log('warn', 'session lock not released: file is no longer ours', { lockFile });
    }
  }

  /**
   * Boot-time change detection (SPEC ruling 12): compare current session
   * file sizes against the persisted snapshot. Growth means the file was
   * written since the last snapshot — normally while the service was down
   * (emergency console), but a hard stop during a pass also covers writes
   * just before it — or by any other process; a SHRINK means the console
   * truncated or rewrote it. New files count as growth from zero.
   */
  detectGrowth(): GrowthReport {
    const { snapshot: previous, state: snapshotState } = this.readSnapshot();
    if (snapshotState === 'corrupt') {
      this.log('warn', 'session store-state.json is corrupt — growth baseline reset', {
        stateFile: this.stateFile,
      });
    }
    const findings: GrowthFinding[] = [];
    for (const file of this.listSessionFiles()) {
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      const prev = previous[file];
      if (prev === undefined && size > 0) {
        findings.push({
          file,
          kind: 'grew',
          grewByBytes: size,
          previousBytes: 0,
          currentBytes: size,
        });
      } else if (prev !== undefined && size > prev) {
        findings.push({
          file,
          kind: 'grew',
          grewByBytes: size - prev,
          previousBytes: prev,
          currentBytes: size,
        });
      } else if (prev !== undefined && size < prev) {
        findings.push({
          file,
          kind: 'shrunk',
          grewByBytes: size - prev,
          previousBytes: prev,
          currentBytes: size,
        });
      }
    }
    // Snapshot entries whose file VANISHED since the last snapshot are
    // findings too — a console delete must never pass silently.
    const present = new Set(this.listSessionFiles());
    for (const [file, prev] of Object.entries(previous)) {
      if (!present.has(file) && prev > 0) {
        findings.push({
          file,
          kind: 'deleted',
          grewByBytes: -prev,
          previousBytes: prev,
          currentBytes: 0,
        });
      }
    }
    return { findings, snapshotState, scannedAt: new Date().toISOString() };
  }

  /** Persist the current size snapshot (atomic write). */
  persistSnapshot(): void {
    const snapshot: Record<string, number> = {};
    for (const file of this.listSessionFiles()) {
      try {
        snapshot[file] = statSync(file).size;
      } catch {
        /* vanished mid-scan */
      }
    }
    this.writeSnapshot(snapshot);
  }

  /** The snapshot a backup pass persists, built from its single scan. */
  private persistSnapshotFromSources(sources: readonly SessionSourceScan[]): void {
    const snapshot: Record<string, number> = {};
    for (const source of sources) snapshot[source.file] = source.size;
    this.writeSnapshot(snapshot);
    // Deliberate: the scan is the pass's one traversal, so these sizes are
    // the pass's start-of-pass view, not a post-copy re-stat (Required 3 in
    // the approved intent forbids a second stat walk here). A hard stop
    // during the pass can therefore make the next boot's growth report
    // include bytes written (or a file removed) while the service was up —
    // the same class of window the pre-existing post-snapshot writes already
    // had. Do not "fix" this back into a second walk.
  }

  /** Bare size map at `sessions/store-state.json` (shape pinned by tests). */
  private writeSnapshot(snapshot: Record<string, number>): void {
    const staging = `${this.stateFile}.tmp-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
    renameSync(staging, this.stateFile);
  }

  /**
   * Issue #243 F-H4 — the DISTINCT durable shutdown checkpoint artifact. A
   * pre-first-await record of the still-owned pending autopilot producers
   * plus the last-seen session sizes, written while locks and the ledger
   * remain OPEN. It reuses the same atomic staging+rename mechanics as
   * {@link persistSnapshot} but writes a SEPARATE file, so the original final
   * snapshot's path/count/exactly-once semantics are untouched. The artifact
   * is recoverable on boot only as last-seen / pending debt — never as
   * successful delivery or proven cessation. It never releases a lock.
   */
  writeShutdownCheckpoint(input: { readonly pending: readonly unknown[] }): void {
    const snapshot: Record<string, number> = {};
    for (const file of this.listSessionFiles()) {
      try {
        snapshot[file] = statSync(file).size;
      } catch {
        /* vanished mid-scan */
      }
    }
    const checkpointFile = join(this.sessionsDir, 'store-shutdown-checkpoint.json');
    const staging = `${checkpointFile}.tmp-${process.pid}`;
    writeFileSync(
      staging,
      `${JSON.stringify(
        {
          phase: 'shutdown-checkpoint',
          printedAt: new Date().toISOString(),
          bootId: this.bootId,
          sessions: snapshot,
          pendingWork: input.pending,
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    renameSync(staging, checkpointFile);
  }

  /**
   * ONE directory walk plus ONE stat per source: the data the whole pass
   * reuses (copy decision, prune live-source test, size snapshot). A pass
   * that called this twice would pay a second full-tree stat walk.
   */
  scanSessionSources(): readonly SessionSourceScan[] {
    const sources: SessionSourceScan[] = [];
    for (const file of this.listSessionFiles()) {
      let stat: { readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number };
      try {
        stat = this.statSource(file);
      } catch (error) {
        // A vanished source is ordinary; any other failure is not — never
        // drop a live source from the pass without a trace.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.log('warn', 'session source could not be inspected — left out of this pass', {
            file,
            error: String(error),
          });
        }
        continue;
      }
      sources.push({
        file,
        key: relative(this.sessionsDir, file).replace(/\\/g, '/'),
        backupKey: this.backupKeyFor(file),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      });
    }
    return sources;
  }

  /** Stat seam: exactly one call per source per pass (the cost test counts it). */
  private statSource(file: string): { readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number } {
    const stat = statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  }

  /** Flattened source key the backup file name is built from. */
  private backupKeyFor(file: string): string {
    return relative(this.sessionsDir, file).replace(/[/\\]/g, '__');
  }

  /** The only generation name shape this source's entry may record. */
  private backupNameFor(key: string): RegExp {
    const flattened = key.replace(/[/\\]/g, '__').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${flattened}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}\\.bak$`, 'u');
  }

  /**
   * Remove staging files a hard stop left behind (a mid-copy crash leaves a
   * partial `<generation>.bak.tmp-<pid>`, and a crashed baseline write leaves
   * `backup-baseline.json.tmp-<pid>`) so the backup dir cannot grow without
   * bound and recovery listings stay clean. Best effort: a cleanup failure
   * warns and the pass continues.
   */
  private sweepStagingArtifacts(
    backupNames: ReadonlySet<string>,
    recorded: ReadonlyMap<string, BackupBaselineEntry>,
  ): void {
    const targets: string[] = [];
    for (const name of backupNames) {
      const match = /^(.*)\.tmp-\d+$/u.exec(name);
      if (match === null) continue;
      const generation = match[1]!;
      const stagingPath = join(this.backupDir, name);
      const destination = join(this.backupDir, generation);
      const entry = recorded.get(generation);
      // A staged copy left by an interrupted rename is COMPLETE: if the
      // baseline records that generation and the destination is not a usable
      // snapshot, promote the staged file into place (an unusable destination
      // is replaced by the rename) instead of deleting the newest bytes.
      const destinationSize = this.statGeneration(generation);
      if (entry !== undefined && (destinationSize === null || destinationSize < entry.size)) {
        try {
          if (statSync(stagingPath).size >= entry.size) {
            renameSync(stagingPath, destination);
            continue;
          }
        } catch {
          /* fall through */
        }
        // The copy is recorded but cannot be promoted: keep it (and say so)
        // rather than deleting a possible only copy of the newest bytes.
        this.log('warn', 'session staging copy could not be promoted', { staging: name });
        continue;
      }
      targets.push(stagingPath);
    }
    const stagingNames = [
      basename(this.baselineFile),
      basename(this.baselinePendingFile),
      basename(this.stateFile),
      'store-shutdown-checkpoint.json',
    ].map(
      (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp-\\d+$`, 'u'),
    );
    for (const name of this.listSessionDirEntries()) {
      // Only this process's own staging shape: a hand-made copy such as
      // `store-state.json.tmp-before-upgrade` (or a tracked `.jsonl` that
      // merely starts with a staging prefix) is never deleted.
      if (stagingNames.some((pattern) => pattern.test(name))) targets.push(join(this.sessionsDir, name));
    }
    for (const path of targets) {
      try {
        unlinkSync(path);
      } catch (error) {
        this.log('warn', 'session staging cleanup failed', { path, error: String(error) });
      }
    }
  }

  /** Flat listing of the sessions dir (the staging sweep's seam, never a walk). */
  private listSessionDirEntries(): readonly string[] {
    try {
      return readdirSync(this.sessionsDir);
    } catch (error) {
      this.log('warn', 'session staging sweep could not list the sessions dir', { error: String(error) });
      return [];
    }
  }

  /**
   * One flat listing of the staged copies an interrupted rename can leave
   * (`<generation>.tmp-<pid>`): generation name -> largest staged size. Never
   * a per-entry rescan (the boot pass is synchronous and unguarded).
   */
  private stagedCompleteCopies(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    let names: readonly string[];
    try {
      names = readdirSync(this.backupDir);
    } catch {
      return out;
    }
    for (const name of names) {
      const match = /^(.*)\.tmp-\d+$/u.exec(name);
      if (match === null) continue;
      try {
        const stat = statSync(join(this.backupDir, name));
        if (!stat.isFile()) continue;
        const generation = match[1]!;
        out.set(generation, Math.max(out.get(generation) ?? 0, stat.size));
      } catch {
        /* vanishing staging */
      }
    }
    return out;
  }

  /** Size of a readable recorded generation, or null when it is unusable. */
  private statGeneration(name: string): number | null {
    const path = join(this.backupDir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return null;
      // A generation the service cannot read is not a snapshot it can
      // restore: force the repair path (and its warn) instead of skipping.
      accessSync(path, fsConstants.R_OK);
      return stat.size;
    } catch {
      return null;
    }
  }

  /** One flat listing of the backup dir's regular files — never a tree walk. */
  private listBackupGenerations(): ReadonlySet<string> {
    try {
      return new Set(
        readdirSync(this.backupDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name),
      );
    } catch (error) {
      // The directory can vanish between mkdirSync and here (an out-of-band
      // reclaim racing the scan). Treat it as empty so the pass takes the
      // recorded-generation repair path: the boot pass is NOT guarded, and a
      // throw here would refuse service startup.
      this.log('warn', 'session backup directory could not be listed — treating recorded generations as missing', {
        backupDir: this.backupDir,
        error: String(error),
      });
      return new Set();
    }
  }

  /**
   * One backup pass: copy the tracked session files whose content changed
   * since that source's last recorded backup into the backup dir with an
   * ISO-hour suffix (the slot IS the hour — a second pass in the same hour
   * refreshes the slot), prune, and persist both the size snapshot and the
   * change baseline. Unchanged sources are not copied at all, however
   * recently they were written — the one exception is a source whose
   * recorded generation has gone missing: that snapshot is re-created, not
   * copied on a time window.
   */
  runBackup(now: Date = new Date()): BackupPassResult {
    mkdirSync(this.backupDir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 13); // ISO hour
    const { baseline, state: baselineState } = this.readBackupBaseline();
    if (baselineState === 'corrupt') {
      this.log('warn', 'session backup baseline is corrupt — copying every source once and rewriting it', {
        baselineFile: this.baselineFile,
      });
    }
    const sources = this.scanSessionSources();
    const liveFiles = new Map(sources.map((source) => [source.backupKey, source.file]));
    // One flat listing taken BEFORE the copies, for the staging sweep (the
    // skip decision stats the recorded generation itself). The prune takes its
    // own fresh listing afterwards, so the count rule still sees the copies
    // this pass adds.
    const presentBefore = this.listBackupGenerations();
    this.sweepStagingArtifacts(
      presentBefore,
      new Map(Object.values(baseline).map((entry) => [entry.backup, entry])),
    );
    const scanned = new Set(sources.map((source) => source.key));
    const next: Record<string, BackupBaselineEntry> = {};
    // A source that is gone (or could not be inspected) keeps its recorded
    // entry: it names that source's last copy, which the prune must keep even
    // when a backwards clock makes an older generation sort later.
    for (const [key, entry] of Object.entries(baseline)) {
      if (!scanned.has(key)) next[key] = entry;
    }
    // Decide first, copy second: the baseline that records this pass's
    // intended copies is written BEFORE the copies, so a copy's identity is
    // durable before any prune can act on it. A crash, or an unpublishable
    // final baseline, then leaves a recorded generation that exists or that
    // the next pass repairs — never an unrecorded copy that a later prune can
    // delete.
    const copies: {
      readonly source: SessionSourceScan;
      readonly dest: string;
      readonly entry: BackupBaselineEntry;
    }[] = [];
    let skipped = 0;
    for (const source of sources) {
      const previous = baseline[source.key];
      if (
        previous !== undefined &&
        previous.size === source.size &&
        previous.mtimeMs === source.mtimeMs &&
        previous.ctimeMs === source.ctimeMs
      ) {
        // The recorded generation must still be a usable copy: present, a
        // regular file, and at least as large as the source was when the copy
        // was taken (a prefix/truncated file is not a snapshot). An
        // out-of-band reclaim or a damaged generation is re-created rather
        // than letting a live source run with no usable snapshot at all.
        const recordedSize = this.statGeneration(previous.backup);
        if (recordedSize !== null && recordedSize >= previous.size) {
          next[source.key] = previous; // unchanged since its last recorded backup
          skipped += 1;
          continue;
        }
        this.log('warn', 'recorded session backup is missing or unusable — re-copying its unchanged source', {
          file: source.file,
          backup: join(this.backupDir, previous.backup),
        });
      }
      const name = `${source.backupKey}.${stamp}${BACKUP_SUFFIX}`;
      const entry: BackupBaselineEntry = {
        size: source.size,
        mtimeMs: source.mtimeMs,
        ctimeMs: source.ctimeMs,
        backup: name,
      };
      // The pre-copy record must never pair the new fingerprint with a
      // generation this pass did not write: a same-slot refresh, or any
      // destination name that already exists (a same-hour pass after an
      // upgrade/corrupt baseline, or a backwards clock step), keeps the
      // PREVIOUS entry — or no entry at all. A failed or interrupted copy
      // then retries next pass instead of trusting stale bytes whose size
      // happens to satisfy the new fingerprint. A genuinely new slot is
      // recorded up front (a missing generation is repaired), so no completed
      // copy can ever be unrecorded.
      let destinationTaken: boolean;
      try {
        statSync(join(this.backupDir, name));
        destinationTaken = true; // a file or a directory already occupies it
      } catch (error) {
        // Absence is only proven by ENOENT: any other error refuses to adopt.
        destinationTaken = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      }
      if (destinationTaken) {
        if (previous !== undefined) next[source.key] = previous;
        else delete next[source.key];
      } else {
        next[source.key] = entry;
      }
      copies.push({ source, dest: join(this.backupDir, name), entry });
    }
    // The size snapshot belongs to every pass, including a pass that cannot
    // record its copies and defers them.
    this.persistSnapshotFromSources(sources);
    try {
      this.writeBaseline(next, this.baselinePendingFile);
    } catch (error) {
      // A pass that cannot record what it is about to write must not write
      // it: no copies and no prune. The previous baseline (and its
      // generations) stay exactly as they were, and the next pass retries.
      this.log('warn', "session backup baseline could not be written — this pass's copies are deferred", {
        baselineFile: this.baselineFile,
        error: String(error),
      });
      return { created: [], pruned: [], skipped };
    }
    const created: string[] = [];
    for (const copy of copies) {
      // Copy to a staging name and rename into the slot: a failed copy (disk
      // full, source gone mid-copy) must never truncate the generation this
      // same slot may already hold and the baseline may already record.
      const staging = `${copy.dest}.tmp-${process.pid}`;
      try {
        copyFileSync(copy.source.file, staging);
      } catch (error) {
        try {
          unlinkSync(staging);
        } catch {
          /* nothing was written, or the cleanup raced the failure */
        }
        // The recorded generation is now missing; the next pass repairs it
        // from the recorded fingerprint. The previous generation is protected
        // this pass, so a failed copy never costs the source its last good
        // snapshot.
        const previous = baseline[copy.source.key];
        if (previous !== undefined) {
          // Publish the last generation that actually exists, not the
          // intended-but-absent one: the old fingerprint makes the next pass
          // retry.
          next[copy.source.key] = previous;
        }
        // With no previous entry (a cold start) no entry is adopted here.
        this.log('warn', 'session backup copy failed', { file: copy.source.file, error: String(error) });
        continue;
      }
      try {
        renameSync(staging, copy.dest);
        created.push(copy.dest);
        next[copy.source.key] = copy.entry;
      } catch (error) {
        // The staged copy is COMPLETE: keep it for the staging sweep to
        // promote (the record already names this generation when the slot was
        // new) instead of deleting the only copy of the newest bytes.
        this.log('warn', 'session backup rename failed — the staged copy is kept for recovery', {
          staging,
          dest: copy.dest,
          error: String(error),
        });
      }
    }
    this.persistSnapshotFromSources(sources);
    // The size snapshot belongs to every pass, including a pass that cannot
    // record its copies and defers them.
    let recordIsCurrent = true;
    try {
      this.writeBaseline(next, this.baselinePendingFile);
    } catch (error) {
      // The pre-copy record is what will be published. The prune may only
      // delete what that record does not name, so it is skipped: pruning
      // against the un-recorded post-copy state could delete a generation the
      // published record still names.
      recordIsCurrent = false;
      this.log('warn', 'session backup baseline could not be rewritten after the copies — publishing the pre-copy record without pruning', {
        baselineFile: this.baselineFile,
        error: String(error),
      });
    }
    // Every generation the baseline records — this pass's landed copies, an
    // unchanged source's recorded copy, and the previous generation of a
    // source whose copy failed — is protected from this pass's prune, so the
    // baseline never names a file the pass deleted and a failed copy never
    // costs the source its last good snapshot.
    const recordedGenerations = new Set(Object.values(next).map((entry) => entry.backup));
    // A fresh flat listing for the prune, taken AFTER the copies so the count
    // rule sees the generations this pass added.
    const pruned = recordIsCurrent
      ? this.pruneBackups(liveFiles, recordedGenerations, this.listBackupGenerations(), now)
      : [];
    try {
      this.publishBaseline();
    } catch (error) {
      // The unguarded boot pass must not refuse startup over an
      // un-replaceable final path: the pending record stays and is preferred
      // by the next pass, so no recorded identity is lost.
      this.log('warn', 'session backup baseline could not be published — the pending record is kept', {
        baselineFile: this.baselineFile,
        pendingFile: this.baselinePendingFile,
        error: String(error),
      });
    }
    if (created.length > 0 || pruned.length > 0 || skipped > 0) {
      this.log('info', 'session backup pass', {
        created: created.length,
        pruned: pruned.length,
        unchanged: skipped,
      });
    }
    return { created, pruned, skipped };
  }

  /** Start the hourly rolling backup (unref'd — never holds the event
   * loop). A transient fs failure inside a pass logs an error; it must
   * never escape as an uncaughtException and kill the service. */
  startHourlyBackup(): void {
    if (this.backupTimer !== null || this.disposed) return;
    this.backupTimer = setInterval(() => {
      try {
        this.runBackup();
      } catch (error) {
        this.log('error', 'hourly session backup pass failed', { error: String(error) });
      }
    }, BACKUP_INTERVAL_MS);
    this.backupTimer.unref();
  }

  /**
   * Retention prune, two rules and two floors. Names parse as
   * `<flattened source>.<YYYY-MM-DDTHH>.bak` and sort chronologically.
   *
   * - **Count** (live sources only, unchanged): keep the newest `retention`
   *   generations. A source whose live file is gone can never produce
   *   another generation, so its generations are bounded by age instead.
   * - **Age**: delete a generation whose ISO-hour slot ended MORE than
   *   `backupMaxAgeMs` before this pass — an idle source would otherwise
   *   hold every generation it ever produced forever.
   * - **Floor**: the generation the baseline records (that source's last
   *   snapshot) survives both rules; a source the baseline does not know
   *   falls back to its newest name. A live source's last snapshot is never
   *   deleted, and a source that is gone keeps its newest backup while its
   *   older generations age out (up to a week of hourly generations).
   * - **Recorded generations** (the entry the baseline names, whether it was
   *   copied this pass, an unchanged source's recorded copy, or the last copy
   *   of a source that is gone) are never pruned either: after a backwards
   *   clock step a fresh slot sorts before the older names, and the count rule
   *   must not delete the very copy the baseline points at.
   */
  private pruneBackups(
    liveSources: ReadonlyMap<string, string>,
    recordedGenerations: ReadonlySet<string>,
    present: ReadonlySet<string>,
    now: Date,
  ): string[] {
    const BACKUP_NAME = /^(.*)\.(\d{4}-\d{2}-\d{2}T\d{2})\.bak$/;
    const bySource = new Map<string, string[]>();
    for (const name of present) {
      const match = BACKUP_NAME.exec(name);
      if (match === null) continue;
      const source = match[1]!;
      const list = bySource.get(source) ?? [];
      list.push(name);
      bySource.set(source, list);
    }
    const cutoff = now.getTime() - this.backupMaxAgeMs;
    const pruned: string[] = [];
    for (const [source, names] of bySource) {
      names.sort(); // ISO-hour stamps sort chronologically
      const newest = names[names.length - 1]!;
      const doomed = new Set<string>();
      const liveFile = liveSources.get(source);
      // Count rule for a live source — but re-test that the source is still
      // there: a transcript deleted after the scan must not be count-pruned
      // as if it were live.
      if (liveFile !== undefined && existsSync(liveFile)) {
        for (const name of names.slice(0, Math.max(0, names.length - this.retention))) doomed.add(name);
      }
      for (const name of names) {
        // A slot is current for its whole hour, so it ages out only once that
        // hour ended MORE than the maximum age ago.
        if (this.backupStampMs(name) + BACKUP_SLOT_MS < cutoff) doomed.add(name);
      }
      // Floor: both candidates for a source's last snapshot survive. The
      // baseline's recorded generation is the last copy the pass knows it
      // made; the newest generation name is the fallback for a source the
      // baseline does not know, and the survivor of a pass whose baseline
      // write never landed. A backwards clock makes the two differ, and the
      // pass cannot tell which holds the last bytes, so neither is deleted.
      doomed.delete(newest);
      for (const name of recordedGenerations) doomed.delete(name); // never prune a recorded copy
      for (const name of names) {
        if (!doomed.has(name)) continue;
        const target = join(this.backupDir, name);
        try {
          rmSync(target);
          pruned.push(target);
        } catch (error) {
          this.log('warn', 'backup prune failed', { target, error: String(error) });
        }
      }
    }
    return pruned;
  }

  /** Epoch ms of a backup name's ISO-hour stamp, parsed by hand (UTC). */
  private backupStampMs(name: string): number {
    const match = /^(.*)\.(\d{4})-(\d{2})-(\d{2})T(\d{2})\.bak$/.exec(name);
    if (match === null) return Number.NaN;
    return Date.UTC(Number(match[2]), Number(match[3]) - 1, Number(match[4]), Number(match[5]));
  }

  /**
   * The persisted change baseline. `missing` is the first-ever pass;
   * `corrupt` (unreadable, wrong version/shape, or any malformed entry) is
   * treated as no baseline at all — every source is copied once and the
   * baseline is rewritten, never silently half-trusted.
   */
  private readBackupBaseline(): {
    readonly baseline: { readonly [key: string]: BackupBaselineEntry };
    readonly state: 'ok' | 'missing' | 'corrupt';
  } {
    // A pending record is the previous pass's intended baseline, written
    // before its copies; it is preferred when it is valid (the final file may
    // be older, or unpublishable). An entry whose generation never landed is
    // intent-only: when the final baseline names a generation that does
    // exist for the same source, that entry wins, so a crash cannot make the
    // record point away from the real last copy.
    const pending = this.readBaselineFile(this.baselinePendingFile);
    if (pending.state !== 'ok') return this.readBaselineFile(this.baselineFile);
    const final = this.readBaselineFile(this.baselineFile);
    if (final.state !== 'ok') return pending;
    const staged = this.stagedCompleteCopies();
    const merged: Record<string, BackupBaselineEntry> = { ...pending.baseline };
    for (const [key, entry] of Object.entries(pending.baseline)) {
      const size = this.statGeneration(entry.backup);
      if (size !== null && size >= entry.size) continue;
      // An interrupted rename's complete staging copy is this entry's
      // generation: the sweep will promote it, so the pending entry stands.
      const stagedSize = staged.get(entry.backup);
      if (stagedSize !== undefined && stagedSize >= entry.size) continue;
      const fallback = Object.hasOwn(final.baseline, key) ? final.baseline[key] : undefined;
      if (fallback === undefined) continue;
      const fallbackSize = this.statGeneration(fallback.backup);
      if (fallbackSize !== null && fallbackSize >= fallback.size) merged[key] = fallback;
    }
    return { baseline: merged, state: 'ok' };
  }

  private readBaselineFile(file: string): {
    readonly baseline: { readonly [key: string]: BackupBaselineEntry };
    readonly state: 'ok' | 'missing' | 'corrupt';
  } {
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (error) {
      return {
        baseline: {},
        state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt',
      };
    }
    try {
      const parsed = JSON.parse(text) as { version?: unknown; sources?: unknown } | null;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { baseline: {}, state: 'corrupt' };
      if (parsed.version !== BACKUP_BASELINE_VERSION) return { baseline: {}, state: 'corrupt' };
      const raw = parsed.sources;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { baseline: {}, state: 'corrupt' };
      const baseline: Record<string, BackupBaselineEntry> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = value as { size?: unknown; mtimeMs?: unknown; ctimeMs?: unknown; backup?: unknown } | null;
        const size = entry?.size;
        const mtimeMs = entry?.mtimeMs;
        const ctimeMs = entry?.ctimeMs;
        const backup = entry?.backup;
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return { baseline: {}, state: 'corrupt' };
        if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return { baseline: {}, state: 'corrupt' };
        if (typeof ctimeMs !== 'number' || !Number.isFinite(ctimeMs)) return { baseline: {}, state: 'corrupt' };
        // The recorded generation must be a generation OF THIS SOURCE (a
        // bare file name derived from the key), so a hand-edited baseline
        // cannot point one source at another's backup or outside the dir.
        if (typeof backup !== 'string' || !this.backupNameFor(key).test(backup)) {
          return { baseline: {}, state: 'corrupt' };
        }
        baseline[key] = { size, mtimeMs, ctimeMs, backup };
      }
      return { baseline, state: 'ok' };
    } catch {
      return { baseline: {}, state: 'corrupt' };
    }
  }

  /** Atomic write of a baseline record to `path` (staging + rename). */
  private writeBaseline(sources: { readonly [key: string]: BackupBaselineEntry }, path: string): void {
    const baseline: BackupBaseline = { version: BACKUP_BASELINE_VERSION, sources };
    const staging = `${path}.tmp-${process.pid}`;
    try {
      writeFileSync(staging, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
      renameSync(staging, path);
    } catch (error) {
      try {
        unlinkSync(staging);
      } catch {
        /* nothing to clean up */
      }
      throw error;
    }
  }

  /** Publish the pass's pending record as the baseline the next pass reads. */
  private publishBaseline(): void {
    renameSync(this.baselinePendingFile, this.baselineFile);
  }

  /** All session jsonl files under the sessions dir (backups/state excluded). */
  listSessionFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        // A vanished directory is ordinary; any other failure silently drops
        // every source under it from the pass, so it is named.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.log('warn', 'session directory could not be listed — its subtree is left out of this pass', {
            dir,
            error: String(error),
          });
        }
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'backups') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl')) out.push(full);
      }
    };
    walk(this.sessionsDir);
    return out.sort();
  }

  private readSnapshot(): { snapshot: SizeSnapshot; state: 'ok' | 'missing' | 'corrupt' } {
    let text: string;
    try {
      text = readFileSync(this.stateFile, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { snapshot: {}, state: 'missing' };
      }
      return { snapshot: {}, state: 'corrupt' };
    }
    try {
      const parsed = JSON.parse(text) as SizeSnapshot;
      return {
        snapshot: typeof parsed === 'object' && parsed !== null ? parsed : {},
        state: 'ok',
      };
    } catch {
      return { snapshot: {}, state: 'corrupt' };
    }
  }

  /** Release every held lock and stop timers. Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.backupTimer !== null) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    const failures: unknown[] = [];
    for (const file of [...this.heldLocks]) {
      try { this.releaseLock(file); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'failed to release every session lock during disposal');
  }
}
