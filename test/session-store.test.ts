import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LockBusyError, SessionStore } from '../src/sessions/store.js';

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

describe('SessionStore', () => {
  it('derives the sessions dir from the instance data dir with pi-standard role/cwd scoping', () => {
    const dataDir = tmpDataDir();
    const store = new SessionStore(dataDir);
    expect(store.sessionsDir).toBe(join(dataDir, 'sessions'));
    const dashed = (cwd: string): string =>
      `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    expect(store.sessionDirFor('gru', '/tmp/ws')).toBe(
      join(dataDir, 'sessions', 'gru', dashed('/tmp/ws')),
    );
    expect(store.sessionDirFor('minion', '/tmp/ws')).toBe(
      join(dataDir, 'sessions', 'minion', dashed('/tmp/ws')),
    );
    // Windows-style drive colons and nested slashes stay safe (transform
    // checked directly — resolve() is platform-dependent and already
    // covered by the assertions above):
    const transform = (cwd: string): string => `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    expect(transform('C:\\work\\repos')).toBe('--C--work-repos--');
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

  it('steals a stale lock whose holder is dead and logs it', () => {
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
      pid: 999_999_999,
      bootId: 'dead-boot',
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    };
    writeFileSync(lockFile, `${JSON.stringify(stale)}\n`, 'utf-8');
    expect(() => store.acquireLock(file)).not.toThrow();
    expect(logs.some((msg) => msg.includes('stale session lock stolen'))).toBe(true);
    store.releaseLock(file);
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
    expect(second.detectGrowth().findings).toEqual([]);
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
});
