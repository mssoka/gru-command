import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb, MIGRATIONS } from '../src/ledger/db.js';

// Narrow integration decision: landed main0a864076 ids1–27 are immutable;
// never-shipped candidate2ca952 native26 may only become28, SQL/name intact.
// All databases below are newly created isolated fixtures, never archived
// candidate evidence or live instances.
const dirs: string[] = [];
const handles: LedgerDb[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-gh286-schema-integration-'));
  dirs.push(dir);
  return dir;
}
function assertShape(db: LedgerDb): void {
  const columns = db.handle.prepare('PRAGMA table_info(pending_directives)').all().map((row) => row['name']);
  expect(columns).toEqual(expect.arrayContaining(['request_kind', 'source_context', 'authority_epoch', 'contract_snapshot',
    'contract_sha256', 'dispatch_started_at', 'native_target', 'native_binding', 'recovery_checkpoint', 'recovery_decision']));
  const objects = db.handle.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','index')").all().map((row) => row['name']);
  expect(objects).toEqual(expect.arrayContaining(['gru_mailbox', 'intake_reviews', 'intake_review_heads', 'intake_one_approval',
    'idx_intake_reviews_scope', 'idx_pipeline_enqueued_entry', 'rebrief_recovery_decisions', 'directive_recovery_generation',
    'rebrief_recovery_generation', 'recovery_owner_resolution_identity', 'recovery_owner_confirmation_identity',
    'request_closeouts', 'idx_request_closeouts_active']));
  expect(db.handle.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all()).toEqual(
    MIGRATIONS.map(({ id, name }) => ({ id, name })),
  );
  expect(db.handle.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

describe('GH286 approved integration schema', () => {
  it('preserves every landed migration and the exact original native SQL with unique contiguous ids through28', () => {
    expect(MIGRATIONS.map(({ id }) => id)).toEqual(Array.from({ length: 33 }, (_, index) => index + 1));
    expect(new Set(MIGRATIONS.map(({ id }) => id)).size).toBe(33);
    expect(hash(JSON.stringify(MIGRATIONS.slice(0, 27)))).toBe('3771e4175b5a3080bdff216886e4cc00722083af185eddec184f15f5281400d2');
    expect(MIGRATIONS[27]).toMatchObject({ id: 28, name: 'directive-native-progress' });
    expect(MIGRATIONS[28]).toMatchObject({ id: 29, name: 'notification-owner-decisions' });
    expect(MIGRATIONS[29]).toMatchObject({ id: 30, name: 'worktree-processes-exited' });
    expect(MIGRATIONS[30]).toMatchObject({ id: 31, name: 'worktree-lane-token' });
    expect(MIGRATIONS[31]).toMatchObject({ id: 32, name: 'directive-retirement-context' });
    expect(MIGRATIONS[32]).toMatchObject({ id: 33, name: 'request-closeouts' });
    // A landed table rebuild is immutable: its exact SQL is pinned (#464).
    expect(hash(MIGRATIONS[29]!.sql)).toBe('c565137621d2940683321d684c746a2a5fef27690f15340c38248f3378e9d1c8');
    expect(hash(MIGRATIONS[30]!.sql)).toBe('2a8faa5918ef35a11fecee2464363f39eb2471059352536670ad66cb0ff4b9de');
    expect(hash(MIGRATIONS[27]!.sql)).toBe('3fe446722711a74bcb5ae577b7b47ed8f65f243ea5f059fbc3ebff1250ea546e');
  });

  it('the ledger docs name each migration by its real id: every `Migration N (name)` is MIGRATIONS[N - 1] (#363)', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'LEDGER.md'), 'utf8');
    const named = [...doc.matchAll(/Migration (\d+) \(`([a-z0-9-]+)`\)/gu)].map((match) => ({ id: Number(match[1]), name: match[2]! }));
    expect(named.length).toBeGreaterThan(0);
    for (const { id, name } of named) expect(MIGRATIONS.find((migration) => migration.name === name)?.id, name).toBe(id);
    // The native progress prose names the same ordinal as its heading line.
    expect(doc).toContain('Migration 28 adds nullable native progress');
  });

  it('creates the complete fresh schema and applies native28 exactly once across an ordinary reopen', () => {
    const dir = directory(); const fresh = new LedgerDb(dir);
    try { assertShape(fresh); } finally { fresh.close(); }
    const reopened = new LedgerDb(dir); handles.push(reopened);
    assertShape(reopened);
    expect(reopened.handle.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 28').get()?.['count']).toBe(1);
  });

  it('upgrades newly built landed27 fixtures while retaining intake data/indexes and adding only the native schema once', () => {
    const dir = directory(); const landed = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, 27) });
    try {
      landed.handle.prepare('INSERT INTO intake_reviews(token, repo_path, intake_id, revision_id, status, record) VALUES (?,?,?,?,?,?)')
        .run('isolated-token', '/isolated/schema-repo', 'isolated-intake', 'isolated-revision', 'reviewed', '{"isolated":true}');
      landed.handle.prepare('INSERT INTO intake_review_heads(repo_path, intake_id, token) VALUES (?,?,?)')
        .run('/isolated/schema-repo', 'isolated-intake', 'isolated-token');
      expect(landed.handle.prepare("SELECT name FROM sqlite_schema WHERE name = 'rebrief_recovery_decisions'").get()).toBeUndefined();
    } finally { landed.close(); }
    const upgraded = new LedgerDb(dir);
    try {
      assertShape(upgraded);
      expect(upgraded.handle.prepare('SELECT token, record FROM intake_reviews').all()).toEqual([{ token: 'isolated-token', record: '{"isolated":true}' }]);
      expect(upgraded.handle.prepare('SELECT token FROM intake_review_heads').all()).toEqual([{ token: 'isolated-token' }]);
    } finally { upgraded.close(); }
    const reopened = new LedgerDb(dir); handles.push(reopened); assertShape(reopened);
    expect(reopened.handle.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 28').get()?.['count']).toBe(1);
  });
});
