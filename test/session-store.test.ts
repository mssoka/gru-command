import { chmodSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LockBusyError, LockUnreadableError, SessionStore } from '../src/sessions/store.js';
import { SessionLockCoordinationError, withSessionLockCoordination } from '../src/sessions/lock-coordination.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-store-'));
  cleanupDirs.push(dir);
  return dir;
}

function seedSession(store: SessionStore, role = 'gru', text = '{"type":"session","version":3}\n'): string {
  const dir = store.sessionDirFor(role, '/tmp/workspace');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '2026-09-16T00-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl');
  writeFileSync(file, text, 'utf-8');
  return file;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** One named source file in the role/cwd-scoped session dir. */
function seedSource(store: SessionStore, role: string, name: string, text: string): string {
  const dir = store.sessionDirFor(role, '/tmp/workspace');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, text, 'utf-8');
  return file;
}

/** Backup file names (no directory), sorted, as the pass left them. */
function backupNames(store: SessionStore): string[] {
  return readdirSync(join(store.sessionsDir, 'backups')).filter((name) => name.endsWith('.bak')).sort();
}

/** The named state file the changed-only pass records its baseline in. */
const baselinePath = (store: SessionStore): string => join(store.sessionsDir, 'backup-baseline.json');

/** The flattened source key the backup file name is built from. */
const relativeKey = (store: SessionStore, file: string): string =>
  relative(store.sessionsDir, file).replace(/[/\\]/g, '__');

interface ParsedBaseline {
  readonly version: number;
  readonly sources: Record<string, { size: number; mtimeMs: number; ctimeMs: number; backup: string }>;
}

const readBaseline = (store: SessionStore): ParsedBaseline =>
  JSON.parse(readFileSync(baselinePath(store), 'utf-8')) as ParsedBaseline;

describe('SessionStore', () => {
  function replacementForeignHostLockFixture() {
    const store = new SessionStore(tmpDataDir());
    const file = seedSession(store);
    store.acquireLock(file);
    const lock = store.lockFileFor(file);
    const owned = JSON.parse(readFileSync(lock, 'utf8'));
    const foreign = JSON.stringify({ ...owned, host: 'foreign-owner-must-not-be-mutated' }) + '\n';
    writeFileSync(lock, foreign);
    return { store, file, lock, foreign };
  }

  it('PR334 shard03 heartbeat preserves a replacement foreign owner with matching PID and boot', () => {
    vi.useFakeTimers();
    const f = replacementForeignHostLockFixture();
    try {
      vi.advanceTimersByTime(5001);
      expect(readFileSync(f.lock, 'utf8')).toBe(f.foreign);
    } finally { f.store.dispose(); vi.useRealTimers(); }
  });

  it('PR334 shard03 release preserves a replacement foreign owner with matching PID and boot', () => {
    const f = replacementForeignHostLockFixture();
    try {
      f.store.releaseLock(f.file);
      expect(existsSync(f.lock)).toBe(true);
      expect(readFileSync(f.lock, 'utf8')).toBe(f.foreign);
    } finally { f.store.dispose(); }
  });

  function assertOrdinaryOwnerFence(mode: 'live' | 'foreign' | 'legacy' | 'eperm' | 'changed') {
    const store = new SessionStore(tmpDataDir()); const file = seedSession(store);
    const holder = { host: mode === 'foreign' ? 'other-owner-host' : mode === 'legacy' ? undefined : hostname(), pid: mode === 'live' ? process.pid : 2_000_000_000, bootId: 'original-ordinary-owner', acquiredAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z' };
    const bytes = JSON.stringify(holder); writeFileSync(`${file}.lock`, bytes);
    const changed = JSON.stringify({ ...holder, bootId: 'replacement-observed-during-probe' });
    const probe = mode === 'live' ? undefined : vi.spyOn(process, 'kill').mockImplementation(() => {
      if (mode === 'changed') writeFileSync(`${file}.lock`, changed);
      throw Object.assign(new Error(mode === 'eperm' ? 'permission denied' : 'absent local owner'), { code: mode === 'eperm' ? 'EPERM' : 'ESRCH' });
    });
    try {
      expect(() => store.acquireLock(file)).toThrow(LockBusyError);
      expect(store.isHeld(file)).toBe(false);
      expect(readFileSync(`${file}.lock`, 'utf8')).toBe(mode === 'changed' ? changed : bytes);
      if (mode === 'foreign' || mode === 'legacy') expect(probe).not.toHaveBeenCalled();
    } finally { probe?.mockRestore(); store.dispose(); }
  }
  it('P53 ordinary acquisition refuses a stale live original PID without changing its lock', () => assertOrdinaryOwnerFence('live'));
  it('P53 ordinary acquisition never probes or steals a stale foreign-host lock', () => assertOrdinaryOwnerFence('foreign'));
  it('P53 ordinary acquisition never probes or steals a stale unbound legacy owner', () => assertOrdinaryOwnerFence('legacy'));
  it('P53 ordinary acquisition treats EPERM as retained ownership, not absence', () => assertOrdinaryOwnerFence('eperm'));
  it('P53 ordinary acquisition preserves a changed owner observed during its absence probe', () => assertOrdinaryOwnerFence('changed'));
  it('P53 ordinary acquisition permits only a stale positively absent local bound owner', () => {
    const store = new SessionStore(tmpDataDir()); const file = seedSession(store);
    const holder = { host: hostname(), pid: 2_000_000_000, bootId: 'original-absent-ordinary-owner', acquiredAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z' };
    writeFileSync(`${file}.lock`, JSON.stringify(holder));
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('exact local owner absent'), { code: 'ESRCH' }); });
    try { store.acquireLock(file); expect(probe).toHaveBeenCalledWith(holder.pid, 0); expect(store.ownedLockIdentity(file)).toMatchObject({ host: hostname(), pid: process.pid }); }
    finally { probe.mockRestore(); store.dispose(); }
  });
  it('native recovery refuses foreign, legacy and unbound current lock owners despite predecessor PID absence', () => {
    const store = new SessionStore(tmpDataDir()); const file = seedSession(store);
    const original = { host: hostname(), pid: 2_000_000_000, bootId: 'original-native-boot', acquiredAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z' };
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('absent predecessor'), { code: 'ESRCH' }); });
    try {
      for (const holder of [{ ...original, host: 'foreign-storage-host' }, { ...original, host: undefined }, { ...original, bootId: 'later-same-pid-owner' }]) {
        const bytes = JSON.stringify(holder); writeFileSync(`${file}.lock`, bytes);
        expect(() => store.acquireLockAfterHostExit(file, original.pid, original)).toThrow(LockBusyError);
        expect(readFileSync(`${file}.lock`, 'utf8')).toBe(bytes);
      }
      writeFileSync(`${file}.lock`, JSON.stringify(original));
      expect(() => store.acquireLockAfterHostExit(file, original.pid)).toThrow(LockBusyError);
    } finally { probe.mockRestore(); store.dispose(); }
  });

  it('native lock recovery retains live and EPERM owners even when stale', () => {
    const store = new SessionStore(tmpDataDir()); const file = seedSession(store);
    const owner = { host: hostname(), pid: process.pid, bootId: 'live-native-boot', acquiredAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z' };
    const bytes = JSON.stringify(owner); writeFileSync(`${file}.lock`, bytes);
    expect(() => store.acquireLockAfterHostExit(file, owner.pid, owner)).toThrow(LockBusyError);
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
    try { expect(() => store.acquireLockAfterHostExit(file, owner.pid, owner)).toThrow(/permission denied/); expect(readFileSync(`${file}.lock`, 'utf8')).toBe(bytes); }
    finally { probe.mockRestore(); store.dispose(); }
  });

  it('native lock recovery reclaims only a bound absent original owner and never steals a changed owner observed during its probe', () => {
    const store = new SessionStore(tmpDataDir()); const file = seedSession(store);
    const owner = { host: hostname(), pid: 2_000_000_000, bootId: 'original-bound-boot', acquiredAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z' };
    writeFileSync(`${file}.lock`, JSON.stringify(owner));
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      writeFileSync(`${file}.lock`, JSON.stringify({ ...owner, bootId: 'changed-owner' }));
      throw Object.assign(new Error('absent predecessor'), { code: 'ESRCH' });
    });
    try {
      expect(() => store.acquireLockAfterHostExit(file, owner.pid, owner)).toThrow(LockBusyError);
      expect(JSON.parse(readFileSync(`${file}.lock`, 'utf8')).bootId).toBe('changed-owner');
      probe.mockImplementation(() => { throw Object.assign(new Error('absent predecessor'), { code: 'ESRCH' }); });
      writeFileSync(`${file}.lock`, JSON.stringify(owner)); store.acquireLockAfterHostExit(file, owner.pid, owner);
      expect(store.ownedLockIdentity(file)).toMatchObject({ host: hostname(), pid: process.pid });
    } finally { probe.mockRestore(); store.dispose(); }
  });

  it('serializes concurrent native lock reclaimers so neither can delete the replacement owner lock', () => {
    const dataDir = tmpDataDir(); const first = new SessionStore(dataDir); const second = new SessionStore(dataDir);
    const file = seedSession(first); const lockFile = first.lockFileFor(file);
    const predecessor = { host: hostname(), pid: 2_000_000_000, bootId: 'reclaim-race-original', acquiredAt: '2000-01-01T00:00:00.000Z', heartbeatAt: '2000-01-01T00:00:00.000Z' };
    writeFileSync(lockFile, JSON.stringify(predecessor));
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('absent predecessor'), { code: 'ESRCH' }); });
    const lockFileAccess = first as unknown as { unlinkLockFile(path: string): void };
    const unlink = lockFileAccess.unlinkLockFile.bind(first);
    let nested = false; let secondError: unknown = null;
    const unlinkSpy = vi.spyOn(lockFileAccess, 'unlinkLockFile').mockImplementation((path) => {
      if (path === lockFile && !nested) {
        nested = true;
        try { second.acquireLockAfterHostExit(file, predecessor.pid, predecessor); } catch (error) { secondError = error; }
      }
      unlink(path);
    });
    try {
      first.acquireLockAfterHostExit(file, predecessor.pid, predecessor);
      expect(nested).toBe(true);
      expect(secondError).toBeInstanceOf(SessionLockCoordinationError);
      expect(second.isHeld(file)).toBe(false);
      expect(first.isHeld(file)).toBe(true);
      const owner = first.ownedLockIdentity(file);
      expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject(owner);
    } finally { unlinkSpy.mockRestore(); probe.mockRestore(); first.dispose(); second.dispose(); }
  });

  it('P49 refuses real SQLite contention without waiting or entering the native lock critical section', () => {
    const store = new SessionStore(tmpDataDir()); const file = seedSession(store);
    const bytes = JSON.stringify({ host: hostname(), pid: process.pid, bootId: 'still-owned' }); writeFileSync(`${file}.lock`, bytes);
    const coordinator = new DatabaseSync(`${file}.lock-coordination.sqlite`); coordinator.exec('BEGIN IMMEDIATE');
    const operation = vi.fn(() => 'serialized observation'); const pragmas: string[] = [];
    const exec = DatabaseSync.prototype.exec;
    const observe = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('PRAGMA busy_timeout')) pragmas.push(sql);
      return exec.call(this, sql);
    });
    try {
      expect(() => withSessionLockCoordination(file, operation)).toThrow(SessionLockCoordinationError);
      expect(operation).not.toHaveBeenCalled(); expect(readFileSync(`${file}.lock`, 'utf8')).toBe(bytes);
      // Check the actual SQLite no-wait configuration, not a flaky elapsed-time threshold.
      expect(pragmas).toEqual(['PRAGMA busy_timeout = 0']);
    } finally { observe.mockRestore(); coordinator.exec('ROLLBACK'); coordinator.close(); }
    expect(withSessionLockCoordination(file, operation)).toBe('serialized observation');
    expect(operation).toHaveBeenCalledTimes(1); expect(readFileSync(`${file}.lock`, 'utf8')).toBe(bytes); store.dispose();
  });

  it('derives the sessions dir from the instance data dir with pi-standard role/cwd scoping', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir);
    expect(store.sessionsDir).toBe(join(dataDir, 'sessions'));
    const dashed = (cwd: string): string => {
      const resolved = resolve(cwd);
      const base = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
      return `${base}-${createHash('sha256').update(resolved).digest('hex').slice(0, 8)}`;
    };
    expect(store.sessionDirFor('gru', '/tmp/ws')).toBe(
      join(dataDir, 'sessions', 'gru', dashed('/tmp/ws')),
    );
    expect(store.sessionDirFor('minion', '/tmp/ws')).toBe(
      join(dataDir, 'sessions', 'minion', dashed('/tmp/ws')),
    );
    // The hash suffix keeps dash-colliding cwds distinct (pi's own
    // transform collides these):
    const a = store.sessionDirFor('gru', '/tmp/a-b/c');
    const b = store.sessionDirFor('gru', '/tmp/a/b-c');
    expect(a).not.toBe(b);
  });

  it('acquires the exclusive lock and rejects a second writer loudly, naming the holder', () => {
    const store = new SessionStore(tmpDataDir());
    const file = seedSession(store);
    store.acquireLock(file);
    const second = new SessionStore(store.dataDir);
    let caught: unknown;
    try {
      second.acquireLock(file);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LockBusyError);
    const busy = caught as LockBusyError;
    expect(busy.file).toBe(`${file}.lock`);
    expect((busy.holder as { pid: number }).pid).toBe(process.pid);
    // Re-entrant acquire by the SAME store is a no-op, not an error.
    expect(() => store.acquireLock(file)).not.toThrow();
    store.releaseLock(file);
    // After release the next writer acquires cleanly.
    expect(() => second.acquireLock(file)).not.toThrow();
    second.releaseLock(file);
  });

  it('reclaims stale local absent ownership but preserves a stale live PID lock', () => {
    const logs: string[] = [];
    const store = new SessionStore(tmpDataDir(), {
      log: (level, msg) => {
        if (level === 'warn') logs.push(msg);
      },
    });
    const file = seedSession(store);
    // Forge a stale lock: dead pid + heartbeat older than the steal threshold.
    const lockFile = store.lockFileFor(file);
    const stale = {
      host: hostname(),
      pid: 999_999_999,
      bootId: 'dead-boot',
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    };
    writeFileSync(lockFile, `${JSON.stringify(stale)}\n`, 'utf-8');
    expect(() => store.acquireLock(file)).not.toThrow();
    expect(logs.some((msg) => msg.includes('local owner absence'))).toBe(true);
    store.releaseLock(file);
    // A stale heartbeat never revokes a LIVE owner's single-writer lock.
    writeFileSync(
      lockFile,
      `${JSON.stringify({ ...stale, pid: process.pid, bootId: 'old-boot' })}\n`,
      'utf-8',
    );
    const bytes = readFileSync(lockFile, 'utf8');
    expect(() => store.acquireLock(file)).toThrow(LockBusyError);
    expect(readFileSync(lockFile, 'utf8')).toBe(bytes); store.dispose();
  });

  it('refuses to steal an unreadable lock (loud, never auto-deleted)', () => {
    const store = new SessionStore(tmpDataDir());
    const file = seedSession(store);
    const lockFile = store.lockFileFor(file);
    writeFileSync(lockFile, 'not-json-at-all', 'utf-8');
    expect(() => store.acquireLock(file)).toThrow(LockUnreadableError);
    // And the corrupt file is left in place for the operator.
    expect(readFileSync(lockFile, 'utf-8')).toBe('not-json-at-all');
  });

  it('release does not delete a lock that a stealer has re-created', () => {
    const store = new SessionStore(tmpDataDir());
    const file = seedSession(store);
    // Forge OUR-looking stale lock, then a second store steals it.
    store.acquireLock(file);
    // Simulate: our heartbeat stalled; the stealer replaced the lock file.
    const lockFile = store.lockFileFor(file);
    const stealerInfo = {
      pid: 424_242,
      bootId: 'stealer-boot',
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    writeFileSync(lockFile, `${JSON.stringify(stealerInfo)}\n`, 'utf-8');
    // Our release must NOT delete the stealer's lock file.
    store.releaseLock(file);
    expect(readFileSync(lockFile, 'utf-8')).toContain('stealer-boot');
    // And a normal release (own lock intact) still deletes:
    rmSync(lockFile); // simulated stealer goes away
    store.acquireLock(file);
    store.releaseLock(file);
    expect(() => readFileSync(lockFile, 'utf-8')).toThrow();
  });

  it('detects jsonl growth that happened while the service was down', () => {
    const dataDir = tmpDataDir();
    const first = new SessionStore(dataDir);
    const file = seedSession(first);
    first.persistSnapshot(); // what the previous process last saw

    // "Emergency console" writes while the service is down:
    appendFileSync(file, '{"type":"message"}\n', 'utf-8');

    const second = new SessionStore(dataDir);
    const report = second.detectGrowth();
    expect(report.findings.length).toBe(1);
    const finding = report.findings[0]!;
    expect(finding.file).toBe(file);
    expect(finding.grewByBytes).toBeGreaterThan(0);
    expect(finding.previousBytes).toBeLessThan(finding.currentBytes);
  });

  it('reports no growth on a clean boot with unchanged files', () => {
    const dataDir = tmpDataDir();
    const first = new SessionStore(dataDir);
    seedSession(first);
    first.persistSnapshot();
    const second = new SessionStore(dataDir);
    const report = second.detectGrowth();
    expect(report.findings).toEqual([]);
    expect(report.snapshotState).toBe('ok');
  });

  it('detects a TRUNCATED file (shrink) written while down', () => {
    const dataDir = tmpDataDir();
    const first = new SessionStore(dataDir);
    const file = seedSession(first, 'gru', 'line-one\nline-two\nline-three\n');
    first.persistSnapshot();
    writeFileSync(file, 'line-one\n', 'utf-8');
    const report = new SessionStore(dataDir).detectGrowth();
    expect(report.findings.length).toBe(1);
    expect(report.findings[0]!.kind).toBe('shrunk');
    expect(report.findings[0]!.grewByBytes).toBeLessThan(0);
  });

  it('a corrupt snapshot reports state corrupt instead of silently re-baselining', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir);
    seedSession(store);
    store.persistSnapshot();
    writeFileSync(join(dataDir, 'sessions', 'store-state.json'), 'corrupted!', 'utf-8');
    const report = new SessionStore(dataDir).detectGrowth();
    expect(report.snapshotState).toBe('corrupt');
    // The existing file IS still reported (against the empty baseline) —
    // but the corrupt state is what the operator sees first.
    expect(report.findings.length).toBe(1);
  });

  it('treats a new file appearing while down as growth from zero', () => {
    const dataDir = tmpDataDir();
    const first = new SessionStore(dataDir);
    first.persistSnapshot();
    const second = new SessionStore(dataDir);
    seedSession(second);
    const report = second.detectGrowth();
    expect(report.findings.length).toBe(1);
    expect(report.findings[0]!.previousBytes).toBe(0);
  });

  it('backs up tracked files hourly-named and prunes beyond retention', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir, { retention: 2 });
    const file = seedSession(store, 'gru', 'one\n');
    expect(store.runBackup(new Date('2026-09-16T10:20:00Z')).created.length).toBe(1);
    appendFileSync(file, 'two\n', 'utf-8');
    const second = store.runBackup(new Date('2026-09-16T11:20:00Z'));
    appendFileSync(file, 'three\n', 'utf-8');
    const third = store.runBackup(new Date('2026-09-16T12:20:00Z'));
    // retention 2: the third pass prunes the first backup (same source)
    expect(third.pruned.length).toBe(1);
    expect(third.pruned[0]!).toContain('2026-09-16T10');
    // The surviving backups reflect real content at their copy time.
    const eleven = second.created.find((p) => p.includes('T11'))!;
    expect(readFileSync(eleven, 'utf-8')).toBe('one\ntwo\n');
    // Backup passes persist the size snapshot (growth baseline).
    const clean = new SessionStore(dataDir);
    expect(clean.detectGrowth().findings).toEqual([]);
  });

  it('dispose releases held locks and stops timers', () => {
    const store = new SessionStore(tmpDataDir());
    const file = seedSession(store);
    store.acquireLock(file);
    store.startHourlyBackup();
    store.dispose();
    const fresh = new SessionStore(store.dataDir);
    expect(() => fresh.acquireLock(file)).not.toThrow();
    fresh.releaseLock(file);
  });

  it('dispose keeps releasing every other lock past one whose release meets coordination contention, then reports that failure (#363 S03-2-02)', () => {
    const store = new SessionStore(tmpDataDir());
    const contested = seedSession(store, 'gru');
    const other = seedSession(store, 'minion');
    store.acquireLock(contested);
    store.acquireLock(other);
    const release = store.releaseLock.bind(store);
    const spy = vi.spyOn(store, 'releaseLock').mockImplementation((file: string) => {
      if (file === contested) throw new SessionLockCoordinationError(file, new Error('coordination contention'));
      release(file);
    });
    let thrown: unknown = null;
    try { store.dispose(); } catch (error) { thrown = error; } finally { spy.mockRestore(); }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([expect.any(SessionLockCoordinationError)]);
    // The contested ownership is preserved; the other lock was still released.
    const fresh = new SessionStore(store.dataDir);
    expect(() => fresh.acquireLock(other)).not.toThrow();
    expect(() => fresh.acquireLock(contested)).toThrow();
    fresh.releaseLock(other);
  });
});

describe('Perkins r1 regressions', () => {
  it('W9: a second pass in the same ISO hour refreshes the slot (freshest wins)', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir, { retention: 5 });
    const file = seedSession(store, 'gru', 'early\n');
    const first = store.runBackup(new Date('2026-09-16T10:05:00Z'));
    appendFileSync(file, 'later\n', 'utf-8');
    const second = store.runBackup(new Date('2026-09-16T10:45:00Z'));
    // Same hour → same slot: no new backup file appears, and its content
    // is the freshest in-slot state.
    expect(second.created.length).toBe(1);
    expect(second.created[0]).toBe(first.created[0]);
    expect(readFileSync(second.created[0]!, 'utf-8')).toBe('early\nlater\n');
    // And the slot is one file, not a second generation.
    expect(backupNames(store)).toHaveLength(1);
  });
  it('N28: a session file deleted while down is reported', () => {
    const dataDir = tmpDataDir();
    const first = new SessionStore(dataDir);
    const file = seedSession(first);
    first.persistSnapshot();
    rmSync(file);
    const report = new SessionStore(dataDir).detectGrowth();
    expect(report.findings.length).toBe(1);
    expect(report.findings[0]!.kind).toBe('deleted');
    expect(report.findings[0]!.currentBytes).toBe(0);
  });
});

describe('SessionStore changed-only backup pass', () => {
  it('copies a source on change and skips it on a later unchanged pass', () => {
    const store = new SessionStore(tmpDataDir());
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    const first = store.runBackup(new Date('2026-10-01T10:05:00Z'));
    expect(first.created.length).toBe(1);
    expect(first.skipped).toBe(0);

    const second = store.runBackup(new Date('2026-10-01T11:05:00Z'));
    expect(second.created).toEqual([]);
    expect(second.skipped).toBe(1);
    expect(backupNames(store)).toHaveLength(1); // no slot for an unchanged source

    appendFileSync(file, 'two\n', 'utf-8');
    const third = store.runBackup(new Date('2026-10-01T12:05:00Z'));
    expect(third.created.length).toBe(1);
    expect(third.created[0]).toContain('2026-10-01T12');
    expect(backupNames(store)).toHaveLength(2);
  });

  it('a second store over the same data dir reads the persisted baseline and copies nothing for unchanged sources', () => {
    const dataDir = tmpDataDir();
    const first = new SessionStore(dataDir);
    const gruFile = seedSource(first, 'gru', 'a.jsonl', 'one\n');
    seedSource(first, 'minion', 'b.jsonl', 'two\n');
    // Cold start: no baseline exists yet, so both sources are copied once.
    expect(first.runBackup(new Date('2026-10-01T10:05:00Z')).created.length).toBe(2);

    // A restart is a fresh store over the same data dir: it must read the
    // persisted baseline instead of re-copying everything.
    const restarted = new SessionStore(dataDir);
    const pass = restarted.runBackup(new Date('2026-10-01T11:05:00Z'));
    expect(pass.created).toEqual([]);
    expect(pass.skipped).toBe(2);
    expect(backupNames(restarted)).toHaveLength(2);

    appendFileSync(gruFile, 'more\n', 'utf-8');
    const changed = restarted.runBackup(new Date('2026-10-01T12:05:00Z'));
    expect(changed.created.length).toBe(1);
    expect(changed.skipped).toBe(1);
  });

  it('a missing baseline copies every source once and records a fresh one', () => {
    const store = new SessionStore(tmpDataDir());
    const gruFile = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    seedSource(store, 'minion', 'b.jsonl', 'two\n');
    expect(existsSync(baselinePath(store))).toBe(false);

    const pass = store.runBackup(new Date('2026-10-01T10:05:00Z'));
    expect(pass.created.length).toBe(2);
    expect(pass.skipped).toBe(0);
    const baseline = readBaseline(store);
    expect(baseline.version).toBe(1);
    // Keys are sessions-relative source paths (never absolute machine paths),
    // and the recorded fingerprint is the copied content's size.
    const keys = Object.keys(baseline.sources).sort();
    expect(keys.every((key) => key.endsWith('.jsonl') && !key.startsWith('/'))).toBe(true);
    expect(keys).toHaveLength(2);
    const gruKey = keys.find((key) => key.startsWith('gru/'))!;
    const recorded = baseline.sources[gruKey]!;
    // The recorded shape is fixed: the copied content's fingerprint plus the
    // generation file name the pass verifies on every later skip.
    expect(Object.keys(recorded).sort()).toEqual(['backup', 'ctimeMs', 'mtimeMs', 'size']);
    expect(recorded.size).toBe(statSync(gruFile).size);
    expect(recorded.mtimeMs).toBe(statSync(gruFile).mtimeMs);
    expect(recorded.ctimeMs).toBe(statSync(gruFile).ctimeMs);
    expect(backupNames(store)).toContain(recorded.backup);
  });

  it('a baseline that is unreadable copies every source once and rewrites a valid one', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir);
    seedSource(store, 'gru', 'a.jsonl', 'one\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z'));
    writeFileSync(baselinePath(store), 'not-json-at-all', 'utf-8');

    const warnings: string[] = [];
    const restarted = new SessionStore(dataDir, {
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    const pass = restarted.runBackup(new Date('2026-10-01T11:05:00Z'));
    expect(pass.created.length).toBe(1);
    expect(pass.skipped).toBe(0);
    expect(warnings.some((msg) => msg.includes('baseline is corrupt'))).toBe(true);
    const baseline = readBaseline(restarted);
    expect(baseline.version).toBe(1);
    expect(Object.keys(baseline.sources)).toHaveLength(1);
    // The rewritten baseline is trusted again: the next pass copies nothing.
    expect(restarted.runBackup(new Date('2026-10-01T12:05:00Z')).created).toEqual([]);
  });

  it('a malformed entry discards the whole baseline, including its valid sibling entries', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir);
    seedSource(store, 'gru', 'a.jsonl', 'one\n');
    seedSource(store, 'minion', 'b.jsonl', 'two\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z'));
    // A would-be valid entry for one source and a malformed entry for the
    // other: half-trusting the file would skip one source, so it must copy
    // both. The keys must match the real sources for this to discriminate.
    const real = readBaseline(store).sources;
    const keys = Object.keys(real);
    expect(keys).toHaveLength(2);
    const [first, second] = keys as [string, string];
    const tampered = { version: 1, sources: { ...real, [first]: { ...real[first]!, size: 'nope' } } };
    writeFileSync(baselinePath(store), JSON.stringify(tampered), 'utf-8');
    expect(second).toBeDefined();

    const pass = new SessionStore(dataDir).runBackup(new Date('2026-10-01T11:05:00Z'));
    expect(pass.created.length).toBe(2);
    expect(pass.skipped).toBe(0);
    const rewritten = readBaseline(store).sources;
    expect(Object.keys(rewritten).sort()).toEqual(keys.sort());
    for (const entry of Object.values(rewritten)) {
      expect(Object.keys(entry).sort()).toEqual(['backup', 'ctimeMs', 'mtimeMs', 'size']);
    }
  });

  it('an unknown baseline version copies every source once and rewrites version 1', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir);
    seedSource(store, 'gru', 'a.jsonl', 'one\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z'));
    const valid = readBaseline(store);
    writeFileSync(baselinePath(store), JSON.stringify({ ...valid, version: 2 }), 'utf-8');

    const pass = new SessionStore(dataDir).runBackup(new Date('2026-10-01T11:05:00Z'));
    expect(pass.created.length).toBe(1);
    expect(pass.skipped).toBe(0);
    expect(readBaseline(store).version).toBe(1);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'a baseline the process cannot read takes the cold-start path',
    () => {
      const dataDir = tmpDataDir();
      const store = new SessionStore(dataDir);
      seedSource(store, 'gru', 'a.jsonl', 'one\n');
      store.runBackup(new Date('2026-10-01T10:05:00Z'));
      chmodSync(baselinePath(store), 0o000);

      const warnings: string[] = [];
      const restarted = new SessionStore(dataDir, {
        log: (level, msg) => {
          if (level === 'warn') warnings.push(msg);
        },
      });
      let pass: ReturnType<SessionStore['runBackup']>;
      try {
        pass = restarted.runBackup(new Date('2026-10-01T11:05:00Z'));
      } finally {
        chmodSync(baselinePath(store), 0o600);
      }
      expect(pass.created.length).toBe(1);
      expect(pass.skipped).toBe(0);
      expect(warnings.some((msg) => msg.includes('baseline is corrupt'))).toBe(true);
      expect(Object.keys(readBaseline(restarted).sources)).toHaveLength(1);
    },
  );

  it('one pass performs one tree walk, flat backup listings and one stat per source for N sources with M changed copies', () => {
    const store = new SessionStore(tmpDataDir());
    const files = Array.from({ length: 6 }, (_, index) => seedSource(store, 'gru', `s${index}.jsonl`, `${index}\n`));
    store.runBackup(new Date('2026-10-01T10:05:00Z'));
    for (const file of files.slice(0, 2)) appendFileSync(file, 'changed\n', 'utf-8');

    const walk = vi.spyOn(store, 'listSessionFiles');
    const scan = vi.spyOn(store, 'scanSessionSources');
    const listing = vi.spyOn(store as unknown as { listBackupGenerations(): unknown }, 'listBackupGenerations');
    const stat = vi.spyOn(store as unknown as { statSource(file: string): unknown }, 'statSource');
    const pass = store.runBackup(new Date('2026-10-01T11:05:00Z'));
    // Exactly M copies for M changed sources; the rest are skipped.
    expect(pass.created.length).toBe(2);
    expect(pass.skipped).toBe(4);
    // Cost: one directory walk (it used to walk twice per pass), one scan, one
    // pre-copy flat backup-dir listing (not a tree walk; it answers "is the
    // recorded generation still there?" — the prune takes its own flat
    // listing), and one stat per source — the same data feeds the copy
    // decision, the prune and the size snapshot.
    expect(walk).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(listing).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(files.length);
    walk.mockRestore();
    scan.mockRestore();
    listing.mockRestore();
    stat.mockRestore();
  });

  it('re-creates only the missing recorded generation, not the whole backup set', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir);
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    const sibling = seedSource(store, 'minion', 'b.jsonl', 'two\n');
    const first = store.runBackup(new Date('2026-10-01T10:05:00Z'));
    expect(first.created.length).toBe(2);
    appendFileSync(file, 'more\n', 'utf-8');
    expect(store.runBackup(new Date('2026-10-01T11:05:00Z')).created.length).toBe(1);

    // Only the generation the baseline records for `file` disappears; the
    // older generation of the same source stays and must not be mistaken for
    // the recorded snapshot.
    const recorded = readBaseline(store).sources;
    const fileKey = Object.keys(recorded).find((key) => key.startsWith('gru/'))!;
    const removed = recorded[fileKey]!.backup;
    const older = backupNames(store).find((name) => name.includes('gru__') && name.includes('2026-10-01T10'))!;
    expect(backupNames(store)).toContain(removed);
    rmSync(join(store.sessionsDir, 'backups', removed));

    const warnings: string[] = [];
    const restarted = new SessionStore(dataDir, {
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    const pass = restarted.runBackup(new Date('2026-10-01T12:05:00Z'));
    // Exactly the one source whose recorded generation vanished is copied; the
    // untouched sibling is skipped, so this is not a cold-start pass.
    expect(pass.created.length).toBe(1);
    expect(pass.skipped).toBe(1);
    expect(warnings.some((msg) => msg.includes('recorded session backup is missing'))).toBe(true);
    expect(existsSync(join(restarted.sessionsDir, 'backups', older))).toBe(true);
    const refreshed = backupNames(restarted).filter((name) => name.includes('gru__') && name.includes('2026-10-01T12'));
    expect(refreshed).toHaveLength(1);
    expect(readFileSync(join(restarted.sessionsDir, 'backups', refreshed[0]!), 'utf-8')).toBe('one\nmore\n');
    // Both sources are unchanged again: the next pass skips both.
    expect(restarted.runBackup(new Date('2026-10-01T13:05:00Z')).created).toEqual([]);
    expect(existsSync(sibling)).toBe(true);
  });

  it('copies a same-size rewrite even when the original mtime is restored', () => {
    const store = new SessionStore(tmpDataDir());
    const file = seedSource(store, 'gru', 'a.jsonl', 'aaaa\n');
    // A whole-second mtime restores exactly, so the size and mtime a later
    // pass compares are identical to the recorded ones — only the ctime moves.
    const fixedSeconds = 1_790_000_000;
    utimesSync(file, fixedSeconds, fixedSeconds);
    const before = statSync(file);
    expect(before.mtimeMs).toBe(fixedSeconds * 1000);
    store.runBackup(new Date('2026-10-01T10:05:00Z'));

    writeFileSync(file, 'bbbb\n', 'utf-8'); // same length: the size does not move
    utimesSync(file, fixedSeconds, fixedSeconds); // the editor restores the mtime
    expect(statSync(file).size).toBe(before.size);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file).ctimeMs).not.toBe(before.ctimeMs);

    const pass = store.runBackup(new Date('2026-10-01T11:05:00Z'));
    expect(pass.created.length).toBe(1);
    expect(readFileSync(pass.created[0]!, 'utf-8')).toBe('bbbb\n');
  });

  it('re-copies a metadata-only change to unchanged content (conservative direction)', () => {
    const store = new SessionStore(tmpDataDir());
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z'));
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(store.runBackup(new Date('2026-10-01T11:05:00Z')).created.length).toBe(1);
  });
});

describe('SessionStore backup pass preservation', () => {
  it('never modifies or removes a live session file', () => {
    const store = new SessionStore(tmpDataDir());
    const changed = seedSource(store, 'gru', 'changed.jsonl', 'one\n');
    const unchanged = seedSource(store, 'minion', 'unchanged.jsonl', 'two\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z'));
    appendFileSync(changed, 'more\n', 'utf-8');

    const before = [changed, unchanged].map((file) => ({ file, bytes: readFileSync(file), stat: statSync(file) }));
    // Whatever the pass copies (both sources before changed-only copies, one
    // after), it must never write to or remove a live session file.
    store.runBackup(new Date('2026-10-01T11:05:00Z'));
    for (const snapshot of before) {
      expect(existsSync(snapshot.file)).toBe(true);
      expect(readFileSync(snapshot.file)).toEqual(snapshot.bytes);
      expect(statSync(snapshot.file).size).toBe(snapshot.stat.size);
      expect(statSync(snapshot.file).mtimeMs).toBe(snapshot.stat.mtimeMs);
    }
  });

  it('still writes the bare size snapshot growth detection reads', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir);
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z'));

    const snapshot = JSON.parse(readFileSync(join(dataDir, 'sessions', 'store-state.json'), 'utf-8')) as Record<string, number>;
    // A bare size map keyed by session file — the new baseline is a separate
    // file precisely so this shape (and growth detection's input) is untouched.
    expect(Object.keys(snapshot)).toEqual([file]);
    expect(snapshot[file]).toBe(statSync(file).size);
    expect(new SessionStore(dataDir).detectGrowth().findings).toEqual([]);
  });
});

describe('SessionStore backup prune safety', () => {
  it('age-prunes an over-age generation even below the retention count', () => {
    const store = new SessionStore(tmpDataDir(), { retention: 24, backupMaxAgeMs: 7 * DAY_MS });
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    const first = store.runBackup(new Date('2026-10-01T10:05:00Z'));
    appendFileSync(file, 'two\n', 'utf-8');
    const second = store.runBackup(new Date('2026-10-10T10:05:00Z')); // nine days later

    expect(second.created.length).toBe(1);
    expect(second.pruned).toEqual([first.created[0]]);
    expect(backupNames(store)).toEqual([second.created[0]!.split('/').pop()!]);
  });

  it('never deletes the newest generation of a live source, however old it is', () => {
    const store = new SessionStore(tmpDataDir(), { backupMaxAgeMs: 7 * DAY_MS });
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    const only = store.runBackup(new Date('2026-10-01T10:05:00Z')); // no baseline yet: copied once
    expect(existsSync(file)).toBe(true);

    // A month later the source is still live but unchanged: its single
    // generation is over-age, and it is that source's last snapshot.
    const later = store.runBackup(new Date('2026-11-01T10:05:00Z'));
    expect(later.created).toEqual([]);
    expect(later.pruned).toEqual([]);
    expect(backupNames(store)).toEqual([only.created[0]!.split('/').pop()!]);
  });

  it('a dead source keeps exactly its newest backup while older generations are age-pruned', () => {
    const store = new SessionStore(tmpDataDir(), { backupMaxAgeMs: 7 * DAY_MS });
    const file = seedSource(store, 'gru', 'gone.jsonl', 'one\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z'));
    appendFileSync(file, 'two\n', 'utf-8');
    store.runBackup(new Date('2026-10-01T12:05:00Z'));
    appendFileSync(file, 'three\n', 'utf-8');
    const third = store.runBackup(new Date('2026-10-01T14:05:00Z'));
    expect(backupNames(store)).toHaveLength(3);

    rmSync(file); // the live session file is gone
    const pass = store.runBackup(new Date('2026-11-01T10:05:00Z'));
    expect(pass.created).toEqual([]);
    expect(pass.pruned).toHaveLength(2);
    expect(backupNames(store)).toEqual([third.created[0]!.split('/').pop()!]);
    // Its recorded entry stays, naming the backup that is its last snapshot.
    const entries = Object.entries(readBaseline(store).sources);
    expect(entries).toHaveLength(1);
    expect(entries[0]![1].backup).toBe(third.created[0]!.split('/').pop()!);
  });

  it('a dead source keeps the copy it actually wrote last, even when the clock steps back', () => {
    const store = new SessionStore(tmpDataDir(), { backupMaxAgeMs: 7 * DAY_MS });
    const file = seedSource(store, 'gru', 'gone.jsonl', 'one\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z')); // generation stamped 10-01T10
    appendFileSync(file, 'two\n', 'utf-8');
    store.runBackup(new Date('2026-10-03T10:05:00Z')); // newer name, older content
    appendFileSync(file, 'three\n', 'utf-8');
    const last = store.runBackup(new Date('2026-10-02T10:05:00Z')); // clock stepped back: the ACTUAL last copy
    expect(last.created.length).toBe(1);
    expect(existsSync(file)).toBe(true);
    rmSync(file); // now the source is gone

    // Every generation is over-age; the name-newest (10-03) holds stale
    // content, so the recorded generation is the one that must survive — and
    // the stale over-age name-newest is pruned with the rest.
    const pruned = store.runBackup(new Date('2026-10-20T10:05:00Z'));
    expect(pruned.created).toEqual([]);
    expect(existsSync(last.created[0]!)).toBe(true);
    expect(readFileSync(last.created[0]!, 'utf-8')).toBe('one\ntwo\nthree\n');
    expect(backupNames(store)).toEqual([last.created[0]!.split('/').pop()!]);
  });

  it('a dead source keeps its recent generations: age bounds it, not the count rule', () => {
    const dataDir = tmpDataDir();
    const first = new SessionStore(dataDir);
    const file = seedSource(first, 'gru', 'gone.jsonl', 'one\n');
    first.runBackup(new Date('2026-10-01T10:05:00Z'));
    appendFileSync(file, 'two\n', 'utf-8');
    first.runBackup(new Date('2026-10-01T12:05:00Z'));
    appendFileSync(file, 'three\n', 'utf-8');
    first.runBackup(new Date('2026-10-01T14:05:00Z'));
    rmSync(file);

    // A narrowed count retention would prune two if the count rule applied
    // to a source that can no longer produce generations.
    const narrowed = new SessionStore(dataDir, { retention: 1 });
    const pass = narrowed.runBackup(new Date('2026-10-02T10:05:00Z')); // all within the age window
    expect(pass.created).toEqual([]);
    expect(pass.pruned).toEqual([]);
    expect(backupNames(narrowed)).toHaveLength(3);
  });

  it('never prunes a generation the pass just wrote when the clock steps backwards', () => {
    const store = new SessionStore(tmpDataDir(), { retention: 2 });
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z'));
    appendFileSync(file, 'two\n', 'utf-8');
    store.runBackup(new Date('2026-10-01T11:05:00Z'));
    appendFileSync(file, 'three\n', 'utf-8');

    // The wall clock steps back past the existing slots: the fresh copy sorts
    // BEFORE them, so the count rule must not delete what it just wrote.
    const pass = store.runBackup(new Date('2026-10-01T09:05:00Z'));
    expect(pass.created.length).toBe(1);
    expect(pass.created[0]).toContain('2026-10-01T09');
    expect(pass.pruned).toEqual([]);
    expect(existsSync(pass.created[0]!)).toBe(true);
    expect(backupNames(store)).toContain(pass.created[0]!.split('/').pop()!);
    expect(readFileSync(pass.created[0]!, 'utf-8')).toBe('one\ntwo\nthree\n');

    // The next unchanged pass may not prune the generation the baseline now
    // records, even though it is the lexicographically oldest name.
    const next = store.runBackup(new Date('2026-10-01T09:35:00Z'));
    expect(next.created).toEqual([]);
    expect(next.pruned).toEqual([]);
    expect(existsSync(pass.created[0]!)).toBe(true);
    expect(Object.values(readBaseline(store).sources)[0]!.backup).toBe(pass.created[0]!.split('/').pop()!);
  });

  it('ages a generation out only when its ISO hour has ended more than the maximum age ago', () => {
    const store = new SessionStore(tmpDataDir(), { backupMaxAgeMs: 7 * DAY_MS });
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    const aged = store.runBackup(new Date('2026-10-01T10:05:00Z')); // slot 10:00-11:00
    appendFileSync(file, 'two\n', 'utf-8');
    store.runBackup(new Date('2026-10-03T10:05:00Z'));

    // 7 days minus a minute on the slot's end: still inside the window.
    const inside = store.runBackup(new Date('2026-10-08T10:59:00Z'));
    expect(inside.pruned).toEqual([]);
    expect(existsSync(aged.created[0]!)).toBe(true);

    // The slot's hour ended exactly 7 days ago: NOT more than the maximum age.
    const atBoundary = store.runBackup(new Date('2026-10-08T11:00:00Z'));
    expect(atBoundary.pruned).toEqual([]);
    expect(existsSync(aged.created[0]!)).toBe(true);

    // One minute past the boundary it ages out.
    const outside = store.runBackup(new Date('2026-10-08T11:01:00Z'));
    expect(outside.pruned).toEqual([aged.created[0]]);
  });

  it('applies the default 7-day maximum age to a store constructed without the option', () => {
    const store = new SessionStore(tmpDataDir());
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    const day0 = store.runBackup(new Date('2026-10-01T10:05:00Z'));
    appendFileSync(file, 'two\n', 'utf-8');
    const day6 = store.runBackup(new Date('2026-10-07T10:05:00Z'));
    expect(day6.pruned).toEqual([]); // six days: inside the DEFAULT window
    appendFileSync(file, 'three\n', 'utf-8');
    const day9 = store.runBackup(new Date('2026-10-09T10:05:00Z'));
    expect(day9.pruned).toContain(day0.created[0]); // eight days: aged out
    expect(existsSync(day6.created[0]!)).toBe(true);
  });
});

describe('SessionStore backup pass failure handling', () => {
  it('records nothing for a failed copy and retries it on the next pass', () => {
    const store = new SessionStore(tmpDataDir());
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    const stamp = '2026-10-01T11';
    const destName = `${relativeKey(store, file)}.${stamp}.bak`;
    mkdirSync(join(store.sessionsDir, 'backups'), { recursive: true });
    // A directory sitting on the destination name makes copyFileSync fail.
    mkdirSync(join(store.sessionsDir, 'backups', destName));

    const warnings: string[] = [];
    const logging = new SessionStore(store.dataDir, {
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    const failed = logging.runBackup(new Date('2026-10-01T11:05:00Z'));
    expect(failed.created).toEqual([]);
    expect(warnings.some((msg) => msg.includes('session backup copy failed'))).toBe(true);
    // Not recorded: the next pass must retry instead of trusting it forever.
    expect(Object.keys(readBaseline(store).sources)).toEqual([]);

    rmSync(join(store.sessionsDir, 'backups', destName), { recursive: true, force: true });
    const retried = store.runBackup(new Date('2026-10-01T12:05:00Z'));
    expect(retried.created.length).toBe(1);
    expect(Object.keys(readBaseline(store).sources)).toHaveLength(1);
  });

  it('keeps the previous recorded generation when a copy fails', () => {
    const store = new SessionStore(tmpDataDir(), { retention: 1 });
    const file = seedSource(store, 'gru', 'a.jsonl', 'one\n');
    const first = store.runBackup(new Date('2026-10-01T10:05:00Z'));
    const recorded = readBaseline(store).sources[Object.keys(readBaseline(store).sources)[0]!]!.backup;
    expect(backupNames(store)).toContain(recorded);

    appendFileSync(file, 'two\n', 'utf-8');
    const destName = `${relativeKey(store, file)}.2026-10-01T11.bak`;
    mkdirSync(join(store.sessionsDir, 'backups', destName));
    const warnings: string[] = [];
    const logging = new SessionStore(store.dataDir, {
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    const failed = logging.runBackup(new Date('2026-10-01T11:05:00Z'));
    expect(failed.created).toEqual([]);
    expect(warnings.some((msg) => msg.includes('session backup copy failed'))).toBe(true);
    // The last good snapshot is still the recorded one and survives the prune.
    expect(readBaseline(store).sources[Object.keys(readBaseline(store).sources)[0]!]!.backup).toBe(recorded);
    expect(existsSync(first.created[0]!)).toBe(true);

    rmSync(join(store.sessionsDir, 'backups', destName), { recursive: true, force: true });
    expect(store.runBackup(new Date('2026-10-01T12:05:00Z')).created.length).toBe(1);
  });

  it('rejects invalid retention knobs instead of silently changing the policy', () => {
    expect(() => new SessionStore(tmpDataDir(), { backupMaxAgeMs: -1 })).toThrow(/backupMaxAgeMs/);
    expect(() => new SessionStore(tmpDataDir(), { backupMaxAgeMs: Number.NaN })).toThrow(/backupMaxAgeMs/);
    expect(() => new SessionStore(tmpDataDir(), { backupMaxAgeMs: 1.5 })).toThrow(/backupMaxAgeMs/);
    expect(() => new SessionStore(tmpDataDir(), { retention: -1 })).toThrow(/retention/);
    expect(() => new SessionStore(tmpDataDir(), { retention: Number.NaN })).toThrow(/retention/);
  });

  it('logs an unchanged pass, so a healthy idle hour is still a heartbeat', () => {
    const store = new SessionStore(tmpDataDir());
    seedSource(store, 'gru', 'a.jsonl', 'one\n');
    store.runBackup(new Date('2026-10-01T10:05:00Z'));
    const lines: { readonly msg: string; readonly fields?: Record<string, unknown> }[] = [];
    const logging = new SessionStore(store.dataDir, {
      log: (level, msg, fields) => {
        if (level === 'info') lines.push({ msg, fields });
      },
    });
    const quiet = logging.runBackup(new Date('2026-10-01T11:05:00Z'));
    expect(quiet.created).toEqual([]);
    expect(quiet.skipped).toBe(1);
    const passLine = lines.find((line) => line.msg === 'session backup pass');
    expect(passLine).toBeDefined();
    expect(passLine!.fields).toMatchObject({ created: 0, pruned: 0, unchanged: 1 });
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'degrades to the repair path when the backup directory cannot be listed',
    () => {
      const store = new SessionStore(tmpDataDir());
      seedSource(store, 'gru', 'a.jsonl', 'one\n');
      store.runBackup(new Date('2026-10-01T10:05:00Z'));
      const backups = join(store.sessionsDir, 'backups');
      chmodSync(backups, 0o000);
      const warnings: string[] = [];
      const logging = new SessionStore(store.dataDir, {
        log: (level, msg) => {
          if (level === 'warn') warnings.push(msg);
        },
      });
      let thrown: unknown = null;
      let pass: ReturnType<SessionStore['runBackup']> | null = null;
      try {
        pass = logging.runBackup(new Date('2026-10-01T11:05:00Z'));
      } catch (error) {
        thrown = error;
      } finally {
        chmodSync(backups, 0o700);
      }
      // An unlistable backup dir must not abort the pass (the boot pass is
      // unguarded): it warns and treats every recorded generation as missing.
      expect(thrown).toBeNull();
      expect(warnings.some((msg) => msg.includes('could not be listed'))).toBe(true);
      expect(pass?.created ?? []).toEqual([]);
    },
  );

  it('warns when a live source cannot be inspected, and stays quiet for one that vanished', () => {
    const store = new SessionStore(tmpDataDir());
    seedSource(store, 'gru', 'a.jsonl', 'one\n');
    const warnings: string[] = [];
    const logging = new SessionStore(store.dataDir, {
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    const stat = vi.spyOn(logging as unknown as { statSource(file: string): unknown }, 'statSource');
    stat.mockImplementation(() => {
      throw Object.assign(new Error('input/output error'), { code: 'EIO' });
    });
    expect(logging.runBackup(new Date('2026-10-01T10:05:00Z')).created).toEqual([]);
    expect(warnings.some((msg) => msg.includes('could not be inspected'))).toBe(true);

    warnings.length = 0;
    stat.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
    expect(logging.runBackup(new Date('2026-10-01T11:05:00Z')).created).toEqual([]);
    expect(warnings).toEqual([]); // a vanished source is ordinary, not a warning
    stat.mockRestore();
  });
});
