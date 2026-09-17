import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { LedgerDb, MIGRATIONS } from '../src/ledger/db.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-ledger-'));
  cleanupDirs.push(dir);
  return dir;
}

describe('ledger db + migration runner', () => {
  it('a fresh data dir applies all migrations in order, exactly once', () => {
    const dir = tmpDir();
    const db = new LedgerDb(dir);
    expect(existsSync(db.dbPath)).toBe(true);
    const applied = db.handle
      .prepare('SELECT id, name FROM schema_migrations ORDER BY id')
      .all() as { id: number; name: string }[];
    expect(applied).toEqual(MIGRATIONS.map((m) => ({ id: m.id, name: m.name })));
    // Every E6 table exists.
    for (const table of ['jobs', 'rounds', 'agents', 'lens_states', 'events']) {
      const row = db.handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      expect(row, `table ${table}`).toBeDefined();
    }
    db.close();
  });

  it('re-opening an up-to-date DB is a no-op (no re-applied migrations)', () => {
    const dir = tmpDir();
    const first = new LedgerDb(dir);
    first.close();
    const second = new LedgerDb(dir); // must not throw, must not re-apply
    const applied = second.handle
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };
    expect(applied.n).toBe(MIGRATIONS.length);
    second.close();
  });

  it('an applied-but-unknown schema version fails loud (older binary vs newer DB)', () => {
    const dir = tmpDir();
    const db = new LedgerDb(dir);
    db.handle
      .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
      .run(999, 'from-the-future', new Date().toISOString());
    db.close();
    expect(() => new LedgerDb(dir)).toThrow(/unknown to this build/u);
  });

  it('a numbering gap in the migration list fails loud before applying anything', () => {
    const dir = tmpDir();
    const gapped = [
      ...MIGRATIONS,
      { id: MIGRATIONS.length + 2, name: 'gap', sql: 'CREATE TABLE never (x)' },
    ];
    expect(() => new LedgerDb(dir, { migrations: gapped as never })).toThrow(/contiguous/u);
    // Nothing was applied: no entity tables, no recorded migrations.
    const raw = new DatabaseSync(join(dir, 'ledger', 'ledger.db'));
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(tables.some((t) => t.name === 'never')).toBe(false);
    expect(tables.some((t) => t.name === 'jobs')).toBe(false);
    raw.close();
  });

  it('a failing migration rolls back its transaction (nothing half-applied)', () => {
    const dir = tmpDir();
    const bad = [
      ...MIGRATIONS,
      {
        id: MIGRATIONS.length + 1,
        name: 'broken',
        sql: 'CREATE TABLE half_applied (a); INSERT INTO nonexistent_table VALUES (1);',
      },
    ];
    expect(() => new LedgerDb(dir, { migrations: bad as never })).toThrow(/rolled back/u);
    // The DB file may exist but the broken migration left no trace.
    const raw = new DatabaseSync(join(dir, 'ledger', 'ledger.db'));
    const row = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_applied'")
      .get();
    expect(row).toBeUndefined();
    raw.close();
  });

  it('WAL journaling is active and foreign keys are enforced', () => {
    const dir = tmpDir();
    const db = new LedgerDb(dir);
    expect((db.handle.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.handle.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(() =>
      db.handle
        .prepare('INSERT INTO rounds (id, job_id, seq, status, lenses, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('orphan-r1', 'no-such-job', 1, 'pending', '[]', new Date().toISOString(), new Date().toISOString()),
    ).toThrow();
    db.close();
  });
});
