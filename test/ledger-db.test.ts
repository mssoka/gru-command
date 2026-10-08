import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { LedgerDb, MIGRATIONS } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';

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

  it('upgrades a v8 ledger without losing full titles or existing bindings', () => {
    const dir = tmpDir();
    const old = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, 8) });
    old.handle.prepare("INSERT INTO jobs (id, repo, title, status, created_at, updated_at) VALUES ('j', 'r', 'Full legacy title', 'working', 't', 't')").run();
    old.handle.prepare("INSERT INTO agents (id, role, job_id, state, created_at, updated_at) VALUES ('a', 'minion', 'j', 'idle', 't', 't')").run();
    old.close();
    const upgraded = new LedgerDb(dir);
    expect(upgraded.handle.prepare("SELECT title, display_name FROM jobs WHERE id = 'j'").get()).toMatchObject({ title: 'Full legacy title', display_name: null });
    expect(upgraded.handle.prepare("SELECT job_id FROM agents WHERE id = 'a'").get()).toMatchObject({ job_id: 'j' });
    upgraded.close();
  });

  it('upgrades a pre-retirement ledger keeping existing directive rows live and readable', () => {
    const dir = tmpDir();
    const old = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, 22) });
    old.handle.prepare("INSERT INTO jobs (id, repo, title, status, created_at, updated_at) VALUES ('j', 'r', 't', 'working', 't', 't')").run();
    old.handle
      .prepare(
        `INSERT INTO pending_directives (request_id, job_id, payload, payload_hash, state, baseline_seq, claim, attempts, created_at, updated_at)
         VALUES ('req-legacy', 'j', '{}', 'hash', 'dispatching', 1, NULL, 0, 't', 't')`,
      )
      .run();
    old.close();
    const upgraded = new LedgerDb(dir);
    expect(upgraded.handle.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 23").get()).toMatchObject({ n: 1 });
    const api = new LedgerApi(upgraded.handle);
    const row = api.getDirective('req-legacy');
    expect(row?.state).toBe('dispatching');
    expect(row?.retiredAt).toBeNull();
    expect(row?.holdReleasedBy).toBeNull();
    expect(api.hasOpenDirectiveRecoveryHold('j')).toBe(false);
    upgraded.close();
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

  it('an applied migration whose recorded name differs from code fails loud (rename/reuse)', () => {
    const dir = tmpDir();
    // A database that applied the pre-integration ordering: id 9 is the
    // never-deployed old name of the display-name migration (the 2026-10-02
    // renumbers moved it to id 11 under main's accepted worktree-base-source
    // id 9 and provider-recovery-waits id 10).
    const preRename = [
      ...MIGRATIONS.slice(0, 8),
      { id: 9, name: 'job-display-name', sql: 'ALTER TABLE jobs ADD COLUMN display_name TEXT;' },
    ];
    const old = new LedgerDb(dir, { migrations: preRename });
    old.close();
    expect(() => new LedgerDb(dir)).toThrow(/renamed migration/u);
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
