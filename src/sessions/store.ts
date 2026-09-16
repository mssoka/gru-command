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
import { join, relative, resolve } from 'node:path';
import type { LogLevel } from '../logger.js';

/** Minimal structured-log sink the store depends on. */
export type StoreLog = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export interface SessionLockInfo {
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

export interface GrowthFinding {
  readonly file: string;
  readonly grewByBytes: number;
  readonly previousBytes: number;
  readonly currentBytes: number;
}

export interface GrowthReport {
  /** Files that grew (or appeared) while the service was down. */
  readonly findings: readonly GrowthFinding[];
  readonly scannedAt: string;
}

interface SizeSnapshot {
  readonly [file: string]: number;
}

const LOCK_HEARTBEAT_MS = 5_000;
/** A lock whose heartbeat is older than this is considered abandoned (dead holder). */
const LOCK_STALE_MS = 60_000;
const BACKUP_INTERVAL_MS = 60 * 60 * 1000; // hourly (SPEC ruling 12)
const BACKUP_SUFFIX = '.bak';

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
  private readonly backupDir: string;
  private readonly stateFile: string;
  private readonly retention: number;
  private readonly log: StoreLog;
  private readonly heldLocks = new Map<string, { fd: number }>();
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    readonly dataDir: string,
    opts: { retention?: number; log?: StoreLog } = {},
  ) {
    this.sessionsDir = join(dataDir, 'sessions');
    this.backupDir = join(this.sessionsDir, 'backups');
    this.stateFile = join(this.sessionsDir, 'store-state.json');
    this.retention = opts.retention ?? 24;
    this.log = opts.log ?? (() => {});
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  /**
   * Role + cwd scoped session dir, mirroring the standard pi pattern
   * (`--<dashed-cwd>--`) under the instance data dir (SPEC rulings 7/12).
   */
  sessionDirFor(role: string, cwd: string): string {
    const dashed = `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    return join(this.sessionsDir, role, dashed);
  }

  lockFileFor(sessionFile: string): string {
    return `${sessionFile}.lock`;
  }

  /**
   * Acquire the exclusive lock for a session file. The lock is a sidecar
   * `.lock` file created with O_EXCL holding pid + heartbeat; a second
   * writer is rejected loudly (LockBusyError naming the holder), and a
   * stale lock (heartbeat older than LOCK_STALE_MS) is stolen and logged.
   */
  acquireLock(sessionFile: string): void {
    if (this.disposed) throw new Error('session store disposed');
    if (this.heldLocks.has(sessionFile)) return; // already ours (re-entrant)
    const lockFile = this.lockFileFor(sessionFile);
    const info: SessionLockInfo = {
      pid: process.pid,
      bootId: `${process.pid}-${Date.now()}`,
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
    this.heldLocks.set(sessionFile, { fd: -1 });
    const heartbeat = setInterval(() => {
      try {
        const current = JSON.parse(readFileSync(lockFile, 'utf-8')) as SessionLockInfo;
        if (current.pid === info.pid) {
          const next = `${JSON.stringify({ ...current, heartbeatAt: new Date().toISOString() })}\n`;
          // Truncating rewrite keeps the lock file tiny; O_EXCL ownership was
          // already proven above, and the heartbeat interval owns this file.
          const wfd = openSync(lockFile, 'r+');
          writeFileSync(wfd, next, 'utf-8');
          closeSync(wfd);
        }
      } catch {
        // A stolen/unreadable lock file is re-evaluated on release; never
        // take the process down from housekeeping.
      }
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    this.heartbeats.set(sessionFile, heartbeat);
  }

  private stealIfStale(lockFile: string): void {
    let holder: SessionLockInfo;
    try {
      holder = JSON.parse(readFileSync(lockFile, 'utf-8')) as SessionLockInfo;
    } catch {
      this.log('warn', 'session lock unreadable — stealing', { lockFile });
      try {
        unlinkSync(lockFile);
      } catch {
        /* raced away; the retry below sees the winner */
      }
      return;
    }
    const age = Date.now() - Date.parse(holder.heartbeatAt);
    const holderAlive = holder.pid === process.pid || processExists(holder.pid);
    if (Number.isFinite(age) && age > LOCK_STALE_MS && !holderAlive) {
      this.log('warn', 'stale session lock stolen', {
        lockFile,
        holder_pid: holder.pid,
        heartbeat_age_ms: age,
      });
      try {
        unlinkSync(lockFile);
      } catch {
        /* raced away */
      }
      return;
    }
    throw new LockBusyError(lockFile, holder);
  }

  releaseLock(sessionFile: string): void {
    const heartbeat = this.heartbeats.get(sessionFile);
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      this.heartbeats.delete(sessionFile);
    }
    if (this.heldLocks.delete(sessionFile)) {
      try {
        unlinkSync(this.lockFileFor(sessionFile));
      } catch {
        // Already gone (stolen while we were unresponsive) — nothing to do.
      }
    }
  }

  /**
   * Boot-time growth detection (SPEC ruling 12): compare current session
   * file sizes against the persisted snapshot. Growth means the file was
   * written while the service was down (emergency console) or by any other
   * process. New files count as growth from zero.
   */
  detectGrowth(): GrowthReport {
    const previous = this.readSnapshot();
    const findings: GrowthFinding[] = [];
    for (const file of this.listSessionFiles()) {
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      const prev = previous[file];
      if (prev === undefined ? size > 0 : size > prev) {
        findings.push({
          file,
          grewByBytes: size - (prev ?? 0),
          previousBytes: prev ?? 0,
          currentBytes: size,
        });
      }
    }
    return { findings, scannedAt: new Date().toISOString() };
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
    const staging = `${this.stateFile}.tmp-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
    renameSync(staging, this.stateFile);
  }

  /**
   * One backup pass: copy every tracked session file (and the size
   * snapshot) into the backup dir with an ISO-hour suffix, then prune
   * oldest beyond retention. Safe to call at boot and hourly.
   */
  runBackup(now: Date = new Date()): { created: string[]; pruned: string[] } {
    mkdirSync(this.backupDir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 13); // ISO hour
    const created: string[] = [];
    for (const file of this.listSessionFiles()) {
      const base = relative(this.sessionsDir, file).replace(/[/\\]/g, '__');
      const dest = join(this.backupDir, `${base}.${stamp}${BACKUP_SUFFIX}`);
      try {
        copyFileSync(file, dest);
        created.push(dest);
      } catch (error) {
        this.log('warn', 'session backup copy failed', { file, error: String(error) });
      }
    }
    const pruned = this.pruneBackups();
    this.persistSnapshot();
    if (created.length > 0) {
      this.log('info', 'session backup pass', { created: created.length, pruned: pruned.length });
    }
    return { created, pruned };
  }

  /** Start the hourly rolling backup (unref'd — never holds the event loop). */
  startHourlyBackup(): void {
    if (this.backupTimer !== null || this.disposed) return;
    this.backupTimer = setInterval(() => {
      this.runBackup();
    }, BACKUP_INTERVAL_MS);
    this.backupTimer.unref();
  }

  /**
   * Retention prune: for each source file keep only the newest `retention`
   * backups (the ISO-hour stamp in the name sorts chronologically), delete
   * the rest. Names parse as `<source>.<YYYY-MM-DDTHH>.bak`.
   */
  private pruneBackups(): string[] {
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
    const pruned: string[] = [];
    for (const names of bySource.values()) {
      names.sort(); // ISO-hour stamps sort chronologically
      const excess = names.slice(0, Math.max(0, names.length - this.retention));
      for (const name of excess) {
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

  private readSnapshot(): SizeSnapshot {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf-8')) as SizeSnapshot;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Release every held lock and stop timers. Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.backupTimer !== null) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    for (const file of [...this.heldLocks.keys()]) this.releaseLock(file);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
