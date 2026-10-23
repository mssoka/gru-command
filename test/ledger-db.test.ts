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

  it('upgrades a v29 ledger keeping every lane process row, exiting those a sweep stranded, and admits the exited state (#464)', () => {
    const dir = tmpDir();
    const old = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, 29) });
    old.handle.prepare(`INSERT INTO worktrees (id, kind, repo_path, repo_name, path, branch, sha, status, created_at, updated_at)
      VALUES ('wt', 'review', '/r', 'r', '/r/wt', NULL, 'abc', 'swept', 't', 't')`).run();
    const row = old.handle.prepare(`INSERT INTO worktree_processes (worktree_id, pid, command, evidence, state, first_seen, last_seen)
      VALUES ('wt', ?, ?, ?, ?, 't1', 't2')`);
    row.run(9619, 'node -e probe', 'argv', 'live');
    row.run(9644, 'git ls-remote', 'argv', 'live');
    row.run(9645, 'ssh git@host', 'cwd', 'killed');
    row.run(9700, 'npm test', 'registry', 'live');
    old.handle.prepare(`INSERT INTO worktrees (id, kind, repo_path, repo_name, path, branch, sha, status, created_at, updated_at)
      VALUES ('wt-active', 'job', '/r', 'r', '/r/active', 'b', 'abc', 'active', 't', 't')`).run();
    old.handle.prepare(`INSERT INTO worktree_processes (worktree_id, pid, command, evidence, state, first_seen, last_seen)
      VALUES ('wt-active', 8001, 'dev server', 'cwd', 'live', 't1', 't2')`).run();
    expect(() => row.run(1, 'x', 'argv', 'exited')).toThrow(/CHECK constraint/u);
    old.close();
    const upgraded = new LedgerDb(dir);
    // Rows a sweep left live under a swept tree exited with it, audited; the
    // registry row stays with its own reconcile, an active tree's row stays.
    expect(upgraded.handle.prepare('SELECT worktree_id, pid, command, evidence, state, first_seen, last_seen FROM worktree_processes ORDER BY pid').all()).toEqual([
      { worktree_id: 'wt-active', pid: 8001, command: 'dev server', evidence: 'cwd', state: 'live', first_seen: 't1', last_seen: 't2' },
      { worktree_id: 'wt', pid: 9619, command: 'node -e probe', evidence: 'argv', state: 'exited', first_seen: 't1', last_seen: 't2' },
      { worktree_id: 'wt', pid: 9644, command: 'git ls-remote', evidence: 'argv', state: 'exited', first_seen: 't1', last_seen: 't2' },
      { worktree_id: 'wt', pid: 9645, command: 'ssh git@host', evidence: 'cwd', state: 'killed', first_seen: 't1', last_seen: 't2' },
      { worktree_id: 'wt', pid: 9700, command: 'npm test', evidence: 'registry', state: 'live', first_seen: 't1', last_seen: 't2' },
    ]);
    const audited = upgraded.handle.prepare("SELECT ts, payload FROM events WHERE kind = 'worktree.processes-exited'").all() as { ts: string; payload: string }[];
    expect(audited.map((event) => JSON.parse(event.payload) as unknown)).toEqual([{ id: 'wt', pids: [9619, 9644], reason: 'worktree-swept' }]);
    expect(audited[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    upgraded.handle.prepare("UPDATE worktree_processes SET state = 'exited' WHERE pid = 9700").run();
    expect(() => upgraded.handle.prepare("UPDATE worktree_processes SET state = 'gone' WHERE pid = 9700").run()).toThrow(/CHECK constraint/u);
    expect(upgraded.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_worktree_processes_wt'").get()).toBeDefined();
    expect(upgraded.handle.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    upgraded.close();
  });

  it('upgrades a v30 ledger giving every lane not yet swept its own token and admitting lane-token evidence (#486)', () => {
    const dir = tmpDir();
    const old = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, 30) });
    const lane = old.handle.prepare(`INSERT INTO worktrees (id, kind, repo_path, repo_name, path, branch, sha, status, created_at, updated_at)
      VALUES (?, 'review', '/r', 'r', ?, NULL, 'abc', ?, 't', 't')`);
    lane.run('wt-active', '/r/active', 'active');
    lane.run('wt-paused', '/r/paused', 'paused');
    lane.run('wt-swept', '/r/swept', 'swept');
    old.handle.prepare(`INSERT INTO worktree_processes (worktree_id, pid, command, evidence, state, first_seen, last_seen)
      VALUES ('wt-paused', 4242, 'node server.js', 'cwd', 'live', 't1', 't2')`).run();
    old.close();
    const upgraded = new LedgerDb(dir);
    const tokens = upgraded.handle.prepare('SELECT id, lane_token FROM worktrees ORDER BY id').all() as { id: string; lane_token: string | null }[];
    expect(tokens.map((row) => [row.id, row.lane_token === null ? null : /^[0-9a-f]{32}$/u.test(row.lane_token)])).toEqual([
      ['wt-active', true], ['wt-paused', true], ['wt-swept', null],
    ]);
    expect(tokens[0]!.lane_token).not.toBe(tokens[1]!.lane_token);
    expect(upgraded.handle.prepare('SELECT worktree_id, pid, command, evidence, state FROM worktree_processes').all())
      .toEqual([{ worktree_id: 'wt-paused', pid: 4242, command: 'node server.js', evidence: 'cwd', state: 'live' }]);
    upgraded.handle.prepare(`INSERT INTO worktree_processes (worktree_id, pid, command, evidence, state, first_seen, last_seen)
      VALUES ('wt-active', 65215, 'agent-browser', 'lane-token', 'killed', 't', 't')`).run();
    expect(() => upgraded.handle.prepare("UPDATE worktree_processes SET evidence = 'guess' WHERE pid = 65215").run()).toThrow(/CHECK constraint/u);
    expect(() => upgraded.handle.prepare("UPDATE worktrees SET lane_token = ? WHERE id = 'wt-swept'").run(tokens[0]!.lane_token)).toThrow(/UNIQUE constraint/u);
    expect(upgraded.handle.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const api = new LedgerApi(upgraded.handle);
    expect(api.findWorktreeByLaneToken(tokens[1]!.lane_token!)?.id).toBe('wt-paused');
    expect(api.findLiveWorktreeAtPath('/r/active')?.laneToken).toBe(tokens[0]!.lane_token);
    expect(api.findLiveWorktreeAtPath('/r/swept')).toBeNull();
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
    const columns = upgraded.handle
      .prepare(
        `SELECT retired_at, retired_by, retire_reason, retire_fingerprint, retire_expected_state, retire_expected_head,
                hold_released_by, hold_released_at
           FROM pending_directives WHERE request_id = 'req-legacy'`,
      )
      .get();
    expect(columns).toMatchObject({
      retired_at: null,
      retired_by: null,
      retire_reason: null,
      retire_fingerprint: null,
      retire_expected_state: null,
      retire_expected_head: null,
      hold_released_by: null,
      hold_released_at: null,
    });
    const indexes = upgraded.handle.prepare("PRAGMA index_list('pending_directives')").all() as { name: string }[];
    expect(indexes.map((index) => index.name)).toContain('idx_pending_directives_hold');
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

it('directive native progress migration preserves legacy truth without inventing request authority or admission', () => {
  const dir = tmpDir();
  const old = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, 24) });
  old.handle.prepare("INSERT INTO jobs (id, repo, title, status, created_at, updated_at) VALUES ('legacy-progress', 'r', 't', 'working', 't', 't')").run();
  old.handle.prepare("INSERT INTO pending_directives (request_id, job_id, payload, payload_hash, state, baseline_seq, attempts, created_at, updated_at) VALUES ('legacy-request', 'legacy-progress', '{}', 'hash', 'dispatching', 0, 0, 't', 't')").run();
  old.close();
  const upgraded = new LedgerDb(dir);
  expect(upgraded.handle.prepare('SELECT state, authority_epoch, native_binding, recovery_checkpoint, recovery_decision, request_kind FROM pending_directives WHERE request_id = ?').get('legacy-request')).toMatchObject({
    state: 'dispatching', authority_epoch: null, native_binding: null, recovery_checkpoint: null, recovery_decision: null, request_kind: null,
  });
  upgraded.close();
});
