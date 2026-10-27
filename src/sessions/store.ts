import {
  closeSync,
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
import { join, relative, resolve } from 'node:path';
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
  /** Files that changed (grew or shrank) while the service was down. */
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
    this.sessionsDir = join(dataDir, 'sessions');
    this.backupDir = join(this.sessionsDir, 'backups');
    this.stateFile = join(this.sessionsDir, 'store-state.json');
    this.baselineFile = join(this.sessionsDir, 'backup-baseline.json');
    this.retention = opts.retention ?? 24;
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
   * written while the service was down (emergency console) or by any
   * other process; a SHRINK means the console truncated or rewrote it.
   * New files count as growth from zero.
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
    // Snapshot entries whose file VANISHED while down are findings too —
    // a console delete must never pass silently.
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
    // include bytes written while the service was up — the same class of
    // window the pre-existing post-snapshot writes already had. Do not
    // "fix" this back into a second walk.
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
      let stat: { readonly size: number; readonly mtimeMs: number };
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
    const live = new Set(sources.map((source) => source.backupKey));
    const next: Record<string, BackupBaselineEntry> = {};
    const created: string[] = [];
    const written = new Set<string>();
    let skipped = 0;
    for (const source of sources) {
      const previous = baseline[source.key];
      if (
        previous !== undefined &&
        previous.size === source.size &&
        previous.mtimeMs === source.mtimeMs &&
        previous.ctimeMs === source.ctimeMs
      ) {
        if (existsSync(join(this.backupDir, previous.backup))) {
          next[source.key] = previous; // unchanged since its last recorded backup
          skipped += 1;
          continue;
        }
        // Unchanged content, but the generation it was recorded against is
        // gone (an out-of-band reclaim of the backup dir): re-create it
        // rather than let a live source run with no snapshot at all.
        this.log('warn', 'recorded session backup is missing — re-copying its unchanged source', {
          file: source.file,
          backup: join(this.backupDir, previous.backup),
        });
      }
      const name = `${source.backupKey}.${stamp}${BACKUP_SUFFIX}`;
      const dest = join(this.backupDir, name);
      try {
        copyFileSync(source.file, dest);
        created.push(dest);
        written.add(name);
        next[source.key] = {
          size: source.size,
          mtimeMs: source.mtimeMs,
          ctimeMs: source.ctimeMs,
          backup: name,
        };
      } catch (error) {
        // Never recorded: the next pass retries this source.
        this.log('warn', 'session backup copy failed', { file: source.file, error: String(error) });
      }
    }
    const pruned = this.pruneBackups(live, written, now);
    this.persistSnapshotFromSources(sources);
    this.writeBackupBaseline(next);
    if (created.length > 0 || pruned.length > 0) {
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
   * - **Age**: delete a generation whose ISO-hour slot ended more than
   *   `backupMaxAgeMs` before this pass — an idle source would otherwise
   *   hold every generation it ever produced forever.
   * - **Floor**: the NEWEST generation of every source survives both rules.
   *   It is that source's last snapshot: a live source's is never deleted,
   *   and a dead source keeps exactly that one once its older generations
   *   age out.
   * - **This pass's own copies** are never pruned either: after a backwards
   *   clock step a fresh slot sorts before the older names, and the count
   *   rule must not delete the copy it was just asked to protect.
   */
  private pruneBackups(liveSources: ReadonlySet<string>, writtenThisPass: ReadonlySet<string>, now: Date): string[] {
    if (!existsSync(this.backupDir)) return [];
    const BACKUP_NAME = /^(.*)\.(\d{4}-\d{2}-\d{2}T\d{2})\.bak$/;
    const bySource = new Map<string, string[]>();
    for (const name of readdirSync(this.backupDir)) {
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
      if (liveSources.has(source)) {
        for (const name of names.slice(0, Math.max(0, names.length - this.retention))) doomed.add(name);
      }
      for (const name of names) {
        // A slot is current for its whole hour; it ages out when that hour ends.
        if (this.backupStampMs(name) + BACKUP_SLOT_MS <= cutoff) doomed.add(name);
      }
      doomed.delete(newest); // the floor: a source's last snapshot always survives
      for (const name of writtenThisPass) doomed.delete(name); // never prune this pass's own copy
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
    let text: string;
    try {
      text = readFileSync(this.baselineFile, 'utf-8');
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
        // The recorded generation must name a file INSIDE the backup dir.
        if (typeof backup !== 'string' || backup === '' || backup === '.' || backup === '..' || /[/\\]/u.test(backup)) {
          return { baseline: {}, state: 'corrupt' };
        }
        baseline[key] = { size, mtimeMs, ctimeMs, backup };
      }
      return { baseline, state: 'ok' };
    } catch {
      return { baseline: {}, state: 'corrupt' };
    }
  }

  /** Atomic rewrite of the change baseline (staging + rename, like the snapshot). */
  private writeBackupBaseline(sources: { readonly [key: string]: BackupBaselineEntry }): void {
    const baseline: BackupBaseline = { version: BACKUP_BASELINE_VERSION, sources };
    const staging = `${this.baselineFile}.tmp-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
    renameSync(staging, this.baselineFile);
  }

  /** All session jsonl files under the sessions dir (backups/state excluded). */
  listSessionFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
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
