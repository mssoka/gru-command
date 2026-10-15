import { createHash } from 'node:crypto';
import { nativeSeams } from './helpers/silas-native-seams.js';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { createSilasAutopilotOps } from '../src/dispatch/silas-autopilot-ops.js';
import { resolvePreservationReference } from '../src/dispatch/silas-preservation-reference.js';

/**
 * Issue #243 F-H1 — the explicit, optional, source-bound preservation
 * reference (Root-approved decision A). Synthetic sanitized fixtures only:
 * no private ids/session/report contents or personal paths.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

interface RecordOptions {
  readonly jobId: string;
  readonly repo: string;
  readonly report: string;
  readonly session: string;
  readonly linkEntries?: readonly string[];
  readonly archive?: Buffer;
  readonly actorId?: string;
  readonly treePath?: string;
}

function writeRecord(root: string, opts: RecordOptions): { readonly recordPath: string; readonly recordSha256: string; readonly treePath: string } {
  mkdirSync(root, { recursive: true });
  const treePath = opts.treePath ?? join(root, 'tree');
  mkdirSync(treePath, { recursive: true });
  writeFileSync(join(root, 'complete-original-report.md'), opts.report);
  writeFileSync(join(root, 'original-source-session.jsonl'), opts.session);
  const record = {
    job: { id: opts.jobId, repo: opts.repo, target_sha: 'a'.repeat(40), target_ref: 'refs/heads/feature' },
    tree: { id: opts.jobId, job_id: opts.jobId, path: treePath, sha: 'b'.repeat(40) },
    registered_delivery_actor: { id: opts.actorId ?? 'actor-1', job_id: opts.jobId },
    original_report_sha256: sha256(opts.report),
    original_session_sha256: sha256(opts.session),
    retention_ONLY_complete_inputs_context_process_cleanGit_freshmain_releaseproof_notyetfully_qualified: 'unknown',
  };
  writeFileSync(
    join(root, 'link-preservation-manifest.json'),
    JSON.stringify({
      original_tree: treePath,
      relative_entries: opts.linkEntries ?? [],
      archive_sha256: opts.archive === undefined ? '' : sha256(opts.archive),
      no_external_link_dereference: true,
    }),
  );
  if (opts.archive !== undefined) {
    writeFileSync(join(root, 'current-ignored-untracked-deliverables-links-preserved.tar.gz'), opts.archive);
  }
  const recordPath = join(root, 'original-custody-and-retention-preflight.json');
  const recordText = JSON.stringify(record);
  writeFileSync(recordPath, recordText);
  return { recordPath, recordSha256: sha256(recordText), treePath };
}

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'silas-preservation-'));
  dirs.push(dir);
  return dir;
}

describe('resolvePreservationReference — reusable retained portions', () => {
  it('reuses the verified report/session/link/archive portions across an unrelated terminal actor transition', () => {
    const root = tempRoot();
    const treePath = join(root, 'tree');
    mkdirSync(treePath, { recursive: true });
    const linkPath = join(treePath, 'link-1');
    symlinkSync(join(treePath, 'target-missing'), linkPath); // a declared link; never dereferenced
    const archive = Buffer.from('synthetic-opaque-archive-bytes');
    const record = writeRecord(root, {
      jobId: 'job-h1',
      repo: 'fixture-repo',
      report: '# synthetic report body',
      session: '{"synthetic":"session"}\n',
      linkEntries: ['link-1'],
      actorId: 'actor-original',
      archive,
    });
    // The genuine actor transition is NOT an identity change: a DIFFERENT
    // actor on the SAME job/tree is still reusable for the retained portions.
    const verdict = resolvePreservationReference({
      reference: { recordPath: record.recordPath, recordSha256: record.recordSha256 },
      jobId: 'job-h1',
      expectedRepo: 'fixture-repo',
    });
    expect(verdict.reusable).toBe(true);
    expect(verdict.guidance).toBeNull();
    expect(verdict.verifiedAssets).toEqual([
      'complete-original-report.md',
      'original-source-session.jsonl',
      'link:link-1',
      'archive(current-ignored-untracked-deliverables-links-preserved.tar.gz)',
    ]);
  });

  it('reuses retained portions when the caller supplies matching independent digests (control)', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    const verdict = resolvePreservationReference({
      reference: {
        recordPath: record.recordPath,
        recordSha256: record.recordSha256,
        expectedAssets: {
          'complete-original-report.md': sha256('r'),
          'original-source-session.jsonl': sha256('s'),
        },
      },
      jobId: 'job-h1',
      expectedRepo: 'fixture-repo',
    });
    expect(verdict.reusable).toBe(true);
  });

  it('refuses when an independent digest contradicts the record (tampered self-certification)', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    const verdict = resolvePreservationReference({
      reference: {
        recordPath: record.recordPath,
        recordSha256: record.recordSha256,
        expectedAssets: { 'complete-original-report.md': sha256('DIFFERENT') },
      },
      jobId: 'job-h1',
    });
    expect(verdict.reusable).toBe(false);
    expect(verdict.guidance).toMatch(/contradicts the preservation record/);
  });
});

describe('resolvePreservationReference — fail-closed refusals', () => {
  it('refuses a wrong record digest', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    const verdict = resolvePreservationReference({
      reference: { recordPath: record.recordPath, recordSha256: 'f'.repeat(64) },
      jobId: 'job-h1',
    });
    expect(verdict.reusable).toBe(false);
    expect(verdict.guidance).toMatch(/digest does not match/);
  });

  it('refuses a record that names a different job', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'other-job', repo: 'fixture-repo', report: 'r', session: 's' });
    const verdict = resolvePreservationReference({
      reference: { recordPath: record.recordPath, recordSha256: record.recordSha256 },
      jobId: 'job-h1',
    });
    expect(verdict.reusable).toBe(false);
    expect(verdict.guidance).toMatch(/different job/);
  });

  it('refuses when a retained asset is tampered (changed bytes)', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    writeFileSync(join(root, 'complete-original-report.md'), 'tampered');
    const verdict = resolvePreservationReference({
      reference: { recordPath: record.recordPath, recordSha256: record.recordSha256 },
      jobId: 'job-h1',
    });
    expect(verdict.reusable).toBe(false);
    expect(verdict.guidance).toMatch(/does not match its recorded digest/);
  });

  it('refuses when a retained asset is missing', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    rmSync(join(root, 'original-source-session.jsonl'));
    const verdict = resolvePreservationReference({
      reference: { recordPath: record.recordPath, recordSha256: record.recordSha256 },
      jobId: 'job-h1',
    });
    expect(verdict.reusable).toBe(false);
    expect(verdict.guidance).toMatch(/unreadable/);
  });

  it('refuses an escaping link-preservation entry', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', linkEntries: ['../escape'] });
    const verdict = resolvePreservationReference({
      reference: { recordPath: record.recordPath, recordSha256: record.recordSha256 },
      jobId: 'job-h1',
    });
    expect(verdict.reusable).toBe(false);
    expect(verdict.guidance).toMatch(/escapes the original tree/);
  });

  it('refuses a non-absolute or traversing reference path', () => {
    expect(resolvePreservationReference({
      reference: { recordPath: 'relative/record.json', recordSha256: 'a'.repeat(64) },
      jobId: 'job-h1',
    }).reusable).toBe(false);
    expect(resolvePreservationReference({
      reference: { recordPath: '/tmp/../etc/record.json', recordSha256: 'a'.repeat(64) },
      jobId: 'job-h1',
    }).reusable).toBe(false);
  });

  it('refuses when the declared archive bytes do not match the manifest digest', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', archive: Buffer.from('archive-bytes') });
    writeFileSync(join(root, 'current-ignored-untracked-deliverables-links-preserved.tar.gz'), 'tampered-archive');
    const verdict = resolvePreservationReference({
      reference: { recordPath: record.recordPath, recordSha256: record.recordSha256 },
      jobId: 'job-h1',
    });
    expect(verdict.reusable).toBe(false);
    expect(verdict.guidance).toMatch(/opaque archive does not match/);
  });
});

describe('resolvePreservationReference — fails loud and never follows links (#367)', () => {
  const resolve = (record: { recordPath: string; recordSha256: string }) => resolvePreservationReference({
    reference: { recordPath: record.recordPath, recordSha256: record.recordSha256 }, jobId: 'job-h1',
  });

  it('refuses a missing, malformed or non-object link-preservation manifest — never "nothing to verify"', () => {
    for (const damage of ['missing', 'malformed', 'array', 'no-entries'] as const) {
      const root = tempRoot();
      const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
      const manifest = join(root, 'link-preservation-manifest.json');
      if (damage === 'missing') rmSync(manifest);
      if (damage === 'malformed') writeFileSync(manifest, '{ not json');
      if (damage === 'array') writeFileSync(manifest, '[]');
      if (damage === 'no-entries') writeFileSync(manifest, JSON.stringify({ original_tree: record.treePath, archive_sha256: '' }));
      const verdict = resolve(record);
      expect(verdict.reusable, damage).toBe(false);
      expect(verdict.guidance, damage).toMatch(/link-preservation manifest/);
    }
  });

  it('refuses a declared archive that is absent, and a malformed archive digest', () => {
    const absent = tempRoot();
    const record = writeRecord(absent, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', archive: Buffer.from('bytes') });
    rmSync(join(absent, 'current-ignored-untracked-deliverables-links-preserved.tar.gz'));
    expect(resolve(record)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/declared opaque archive is missing/) });
    const malformed = tempRoot();
    const second = writeRecord(malformed, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    writeFileSync(join(malformed, 'link-preservation-manifest.json'), JSON.stringify({ original_tree: second.treePath, relative_entries: [], archive_sha256: 'not-a-digest' }));
    expect(resolve(second)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/malformed archive digest/) });
  });

  it('never reads a record or asset through a symlink', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    const outside = tempRoot();
    writeFileSync(join(outside, 'report.md'), 'r');
    rmSync(join(root, 'complete-original-report.md'));
    symlinkSync(join(outside, 'report.md'), join(root, 'complete-original-report.md'));
    expect(resolve(record)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/complete-original-report\.md is unreadable/) });
  });

  it('decides link-entry containment on realpaths and exact ".." segments', () => {
    // A symlinked directory inside the tree cannot carry an entry outside it.
    const root = tempRoot();
    const outside = tempRoot();
    const tree = join(root, 'tree');
    mkdirSync(tree, { recursive: true });
    symlinkSync(outside, join(tree, 'escape-dir'));
    const escaping = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', treePath: tree, linkEntries: ['escape-dir/node_modules'] });
    expect(resolve(escaping)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/escapes the original tree/) });
    // A name merely CONTAINING ".." is not a parent segment; an archive-only
    // entry (no parent on disk) is still checked, not refused for absence.
    const fine = tempRoot();
    const ok = writeRecord(fine, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', linkEntries: ['a..b', 'only/in/archive/link'] });
    expect(resolve(ok).reusable).toBe(true);
  });
});

describe('the production release ingress consumes the preservation reference (issue #243 F-H1)', () => {
  const ledgerFor = (): LedgerApi => {
    const dir = mkdtempSync(join(tmpdir(), 'silas-preservation-ops-'));
    dirs.push(dir);
    return new LedgerApi(new LedgerDb(dir).handle, {});
  };

  const opsFor = (ledger: LedgerApi, release: () => Promise<unknown>) =>
    createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: {
        assertWriterAdmissible: () => {},
        clearLaneForWriter: async () => undefined,
        requestReview: async () => {
          throw new Error('unused');
        },
      },
      registry: {} as never,
      worktrees: {
        listWorktrees: () => [{ id: 'job-h1', kind: 'job', status: 'active', branch: 'gru/h1', path: '/tmp/h1' }],
        release,
      } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });

  it('records the explicit selector durably and releases when the reference verifies', async () => {
    const ledger = ledgerFor();
    const job = ledger.addJob({ id: 'job-h1', repo: 'fixture-repo', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', archive: Buffer.from('a') });
    let released = false;
    const ops = opsFor(ledger, async () => {
      released = true;
      return { status: 'swept', preserved: null, branch: 'none', freshHead: 'a'.repeat(40) };
    });
    await ops.releaseLane({
      jobId: job.id,
      ruleId: 'sweep-ack',
      preservationReference: { recordPath: record.recordPath, recordSha256: record.recordSha256 },
    });
    expect(released).toBe(true);
    expect(ledger.latestJobEvent(job.id, 'silas.preservation-reuse')?.payload).toMatchObject({
      record_sha256: record.recordSha256,
      rule_id: 'sweep-ack',
    });
  });

  it('refuses the release and retains the lane when the reference is not reusable', async () => {
    const ledger = ledgerFor();
    const job = ledger.addJob({ id: 'job-h1', repo: 'fixture-repo', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    writeFileSync(join(root, 'complete-original-report.md'), 'tampered');
    const release = vi.fn(async () => ({ status: 'swept', preserved: null, branch: 'none', freshHead: 'a'.repeat(40) }));
    const ops = opsFor(ledger, release);
    await expect(
      ops.releaseLane({
        jobId: job.id,
        ruleId: 'sweep-ack',
        preservationReference: { recordPath: record.recordPath, recordSha256: record.recordSha256 },
      }),
    ).rejects.toThrow(/preservation reuse refused/);
    expect(release).not.toHaveBeenCalled();
    expect(ledger.latestJobEvent(job.id, 'silas.preservation-reuse')).toBeNull();
  });

  it('records the selector once per record digest across a retried release (#368)', async () => {
    const ledger = ledgerFor();
    const job = ledger.addJob({ id: 'job-h1', repo: 'fixture-repo', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    const record = writeRecord(tempRoot(), { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', archive: Buffer.from('a') });
    let attempts = 0;
    const ops = opsFor(ledger, async () => {
      attempts += 1;
      if (attempts === 1) return { status: 'paused', processes: [], preserved: null, note: 'a process is using the tree' };
      return { status: 'swept', preserved: null, branch: 'none', freshHead: 'a'.repeat(40) };
    });
    const reference = { recordPath: record.recordPath, recordSha256: record.recordSha256 };
    await expect(ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack', preservationReference: reference })).rejects.toThrow(/paused/);
    await ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack', preservationReference: reference });
    expect(attempts).toBe(2);
    expect(ledger.listJobEventsByKinds(job.id, ['silas.preservation-reuse'])).toHaveLength(1);
  });

  it('refuses a record that names another repository than the release job (#368)', async () => {
    const ledger = ledgerFor();
    const job = ledger.addJob({ id: 'job-h1', repo: 'fixture-repo', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    const record = writeRecord(tempRoot(), { jobId: 'job-h1', repo: 'other-repo', report: 'r', session: 's', archive: Buffer.from('a') });
    const release = vi.fn(async () => ({ status: 'swept', preserved: null, branch: 'none', freshHead: 'a'.repeat(40) }));
    const ops = opsFor(ledger, release);
    await expect(
      ops.releaseLane({
        jobId: job.id,
        ruleId: 'sweep-ack',
        preservationReference: { recordPath: record.recordPath, recordSha256: record.recordSha256 },
      }),
    ).rejects.toThrow(/different repository/);
    expect(release).not.toHaveBeenCalled();
    expect(ledger.latestJobEvent(job.id, 'silas.preservation-reuse')).toBeNull();
  });
});
