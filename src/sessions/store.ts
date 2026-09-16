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
  readonly kind: 'grew' | 'shrunk';
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
  /** Identifies locks created by THIS store instance (release safety). */
  private readonly bootId = `${process.pid}-${Date.now()}`;
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
        if (current.pid === info.pid && current.bootId === info.bootId) {
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
    const age = Date.now() - Date.parse(holder.heartbeatAt);
    // The heartbeat timestamp IS the liveness proof: a heartbeat older
    // than the steal threshold means the holder is dead or wedged — pid
    // liveness is irrelevant (pid reuse and frozen-but-alive holders are
    // both steal cases, not busy cases).
    if (Number.isFinite(age) && age > LOCK_STALE_MS) {
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
      const lockFile = this.lockFileFor(sessionFile);
      // Only unlink OUR lock: if the lock was stolen while we were
      // unresponsive, the file now belongs to the stealer — deleting it
      // would admit a third writer while the second is active.
      let ours = false;
      try {
        const current = JSON.parse(readFileSync(lockFile, 'utf-8')) as SessionLockInfo;
        ours = current.pid === process.pid && current.bootId === this.bootId;
      } catch {
        ours = false; // gone or unreadable — nothing safe to delete
      }
      if (ours) {
        try {
          unlinkSync(lockFile);
        } catch {
          // Already gone — nothing to do.
        }
      } else {
        this.log('warn', 'session lock not released: file is no longer ours', { lockFile });
      }
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
    for (const file of [...this.heldLocks.keys()]) this.releaseLock(file);
  }
}
