import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { JobParentError, LedgerApi } from '../src/ledger/api.js';
import { LedgerDb, MIGRATIONS } from '../src/ledger/db.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-job-parent-'));
  cleanupDirs.push(dir);
  return dir;
}

function fresh(): LedgerApi {
  return new LedgerApi(new LedgerDb(tmpDir()).handle);
}

const REVIEW = {
  deliverable: 'review' as const,
  targetRef: 'https://github.com/acme/demo/pull/7',
  targetSha: 'c3f3b35',
};

describe('job families — the megaminion parent link', () => {
  it('records the commissioning job and announces it on job.created', () => {
    const api = fresh();
    api.addJob({ id: 'impl', repo: 'demo', title: 'Implementation' });
    const child = api.addJob({ id: 'impl-blind', repo: 'demo', title: 'Review (blind)', ...REVIEW, parentJobId: 'impl' });
    expect(child.parentJobId).toBe('impl');
    expect(api.getJob('impl')?.parentJobId).toBeNull();
    const created = api.listEvents().find((event) => event.jobId === 'impl-blind' && event.kind === 'job.created');
    expect(created?.payload).toMatchObject({ parent_job_id: 'impl' });
  });

  it('refuses an unknown, self, cross-repo, grandchild or blank parent with a named error — and writes nothing', () => {
    const api = fresh();
    api.addJob({ id: 'impl', repo: 'demo', title: 'Implementation' });
    api.addJob({ id: 'other-repo', repo: 'elsewhere', title: 'Elsewhere' });
    api.addJob({ id: 'impl-blind', repo: 'demo', title: 'Review (blind)', ...REVIEW, parentJobId: 'impl' });
    for (const [id, parentJobId, message] of [
      ['orphan', 'no-such-job', /names parent job "no-such-job", which does not exist/u],
      ['selfish', 'selfish', /cannot name itself as its parent/u],
      ['cross', 'other-repo', /from another repo \(elsewhere\)/u],
      ['grandchild', 'impl-blind', /job families are one level deep/u],
      ['blank', '  ', /parent_job_id must be a non-empty string/u],
    ] as const) {
      expect(() => api.addJob({ id, repo: 'demo', title: id, ...REVIEW, parentJobId })).toThrow(message);
      expect(() => api.addJob({ id, repo: 'demo', title: id, ...REVIEW, parentJobId })).toThrow(JobParentError);
      expect(api.getJob(id)).toBeNull();
    }
  });

  it('only report-type specialists nest: a PR-owing lane naming a parent is refused', () => {
    const api = fresh();
    api.addJob({ id: 'impl', repo: 'demo', title: 'Implementation' });
    for (const deliverable of [undefined, 'pr'] as const) {
      const id = `sub-lane-${deliverable ?? 'legacy'}`;
      expect(() => api.addJob({ id, repo: 'demo', title: id, parentJobId: 'impl', ...(deliverable ? { deliverable } : {}) })).toThrow(
        /is not a report-type job/u,
      );
      expect(api.getJob(id)).toBeNull();
    }
    for (const deliverable of ['artifact', 'investigation'] as const) {
      expect(api.addJob({ id: `impl-${deliverable}`, repo: 'demo', title: deliverable, deliverable, parentJobId: 'impl' }).parentJobId).toBe('impl');
    }
  });

  it('fails loud when a parent is supplied on a ledger older than migration job-parent', () => {
    const db = new LedgerDb(tmpDir(), { migrations: MIGRATIONS.filter((migration) => migration.id <= 21) });
    const api = new LedgerApi(db.handle);
    api.addJob({ id: 'impl', repo: 'demo', title: 'Implementation' });
    expect(() => api.addJob({ id: 'impl-blind', repo: 'demo', title: 'Review', ...REVIEW, parentJobId: 'impl' })).toThrow(
      /requires migration job-parent/u,
    );
    expect(api.getJob('impl-blind')).toBeNull();
    // Top-level jobs keep working on the older schema.
    expect(api.addJob({ id: 'plain', repo: 'demo', title: 'Plain' }).parentJobId).toBeNull();
  });

  it('backfills only what the ledger proves: commissioner job ids and unique PR-url matches', () => {
    const dir = tmpDir();
    const v21 = new LedgerDb(dir, { migrations: MIGRATIONS.filter((migration) => migration.id <= 21) });
    const insert = v21.handle.prepare(
      `INSERT INTO jobs (id, repo, title, status, pr_url, deliverable, commissioner, target_ref, created_at, updated_at)
       VALUES (?, ?, ?, 'working', ?, ?, ?, ?, 't', 't')`,
    );
    const pr7 = 'https://github.com/acme/demo/pull/7';
    const pr8 = 'https://github.com/acme/demo/pull/8';
    insert.run('impl', 'demo', 'Implementation', null, 'pr', null, null);
    insert.run('legacy-impl', 'demo', 'Legacy lane', pr7, null, null, null);
    insert.run('dup-a', 'demo', 'Duplicate A', pr8, 'pr', null, null);
    insert.run('dup-b', 'demo', 'Duplicate B', pr8, 'pr', null, null);
    insert.run('elsewhere', 'other', 'Other repo', null, 'pr', null, null);
    // (1) commissioner names a PR-owing job in the same repo → linked.
    insert.run('rev-by-commissioner', 'demo', 'Review', null, 'review', 'impl', pr8);
    // (2) target_ref equals exactly one PR-owing job's pr_url → linked.
    insert.run('rev-by-pr', 'demo', 'Review', null, 'review', 'gru', pr7);
    // Ambiguous PR url, actor commissioner, cross-repo commissioner, a
    // report-job commissioner and a PR-owing lane all stay top-level.
    insert.run('rev-ambiguous', 'demo', 'Review', null, 'review', 'gru', pr8);
    insert.run('rev-cross-repo', 'demo', 'Review', null, 'review', 'elsewhere', null);
    insert.run('rev-of-review', 'demo', 'Review', null, 'artifact', 'rev-by-pr', null);
    insert.run('impl-with-commissioner', 'demo', 'Lane', null, 'pr', 'impl', null);
    v21.close();

    const upgraded = new LedgerDb(dir);
    const parents = Object.fromEntries(
      (upgraded.handle.prepare('SELECT id, parent_job_id FROM jobs ORDER BY id').all() as { id: string; parent_job_id: string | null }[])
        .map((row) => [row.id, row.parent_job_id]),
    );
    expect(parents).toEqual({
      'dup-a': null,
      'dup-b': null,
      elsewhere: null,
      impl: null,
      'impl-with-commissioner': null,
      'legacy-impl': null,
      'rev-ambiguous': null,
      'rev-by-commissioner': 'impl',
      'rev-by-pr': 'legacy-impl',
      'rev-cross-repo': null,
      'rev-of-review': null,
    });
    upgraded.close();
  });
});
