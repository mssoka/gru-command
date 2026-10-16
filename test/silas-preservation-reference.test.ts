import { createHash } from 'node:crypto';
import { nativeSeams } from './helpers/silas-native-seams.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  /** Reshapes the manifest before it is written and bound (a string is
   * written verbatim). */
  readonly manifest?: (manifest: Record<string, unknown>) => unknown;
  /** Default true: the record pins the manifest (`link_manifest_sha256`). */
  readonly bindManifest?: boolean;
  /** A raw `link_manifest_sha256` value written instead of the real digest. */
  readonly manifestBindingValue?: unknown;
}

function writeRecord(root: string, opts: RecordOptions): { readonly recordPath: string; readonly recordSha256: string; readonly treePath: string; readonly manifestSha256: string } {
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
  const manifest: Record<string, unknown> = {
    original_tree: treePath,
    relative_entries: opts.linkEntries ?? [],
    archive_sha256: opts.archive === undefined ? '' : sha256(opts.archive),
    no_external_link_dereference: true,
  };
  const shaped = opts.manifest === undefined ? manifest : opts.manifest(manifest);
  const manifestText = typeof shaped === 'string' ? shaped : JSON.stringify(shaped);
  writeFileSync(join(root, 'link-preservation-manifest.json'), manifestText);
  if (opts.bindManifest !== false) Object.assign(record, { link_manifest_sha256: 'manifestBindingValue' in opts ? opts.manifestBindingValue : sha256(manifestText) });
  if (opts.archive !== undefined) {
    writeFileSync(join(root, 'current-ignored-untracked-deliverables-links-preserved.tar.gz'), opts.archive);
  }
  const recordPath = join(root, 'original-custody-and-retention-preflight.json');
  const recordText = JSON.stringify(record);
  writeFileSync(recordPath, recordText);
  return { recordPath, recordSha256: sha256(recordText), treePath, manifestSha256: sha256(manifestText) };
}

/** A canonical temporary root: the resolver refuses symlinked directories,
 * and the platform temp directory may itself sit behind one. */
function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'silas-preservation-')));
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
      'link-preservation-manifest.json',
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
    const damages = {
      missing: [undefined, /manifest is missing or unreadable/],
      malformed: [() => '{ not json', /manifest is malformed/],
      array: [() => [], /manifest is not an object/],
      'no-entries': [(manifest: Record<string, unknown>) => ({ original_tree: manifest['original_tree'], archive_sha256: '' }), /carries no relative_entries list/],
    } as const;
    for (const [damage, [shape, guidance]] of Object.entries(damages)) {
      const root = tempRoot();
      const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', ...(shape === undefined ? {} : { manifest: shape }) });
      if (damage === 'missing') rmSync(join(root, 'link-preservation-manifest.json'));
      const verdict = resolve(record);
      expect(verdict.reusable, damage).toBe(false);
      expect(verdict.guidance, damage).toMatch(guidance);
    }
  });

  it('refuses a declared archive that is absent, and a malformed archive digest', () => {
    const absent = tempRoot();
    const record = writeRecord(absent, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', archive: Buffer.from('bytes') });
    rmSync(join(absent, 'current-ignored-untracked-deliverables-links-preserved.tar.gz'));
    expect(resolve(record)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/declared opaque archive is missing/) });
    const malformed = tempRoot();
    const second = writeRecord(malformed, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', manifest: (manifest) => ({ ...manifest, archive_sha256: 'A'.repeat(64) }) });
    expect(resolve(second)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/malformed archive digest — archive_sha256 must be "" \(no archive retained\) or 64 lowercase hex/) });
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

  it('refuses a manifest no digest pins, or one that differs from its binding; a caller binding alone suffices', () => {
    const unbound = tempRoot();
    const record = writeRecord(unbound, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', bindManifest: false });
    expect(resolve(record)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/not digest-bound — supply expectedAssets\["link-preservation-manifest\.json"\]/) });
    const withCaller = (manifestSha: string) => resolvePreservationReference({
      reference: { recordPath: record.recordPath, recordSha256: record.recordSha256, expectedAssets: { 'link-preservation-manifest.json': manifestSha } }, jobId: 'job-h1',
    });
    expect(withCaller(record.manifestSha256).reusable).toBe(true);
    expect(withCaller('c'.repeat(64))).toMatchObject({ reusable: false, guidance: expect.stringMatching(/does not match its bound digest/) });
    // A record-bound manifest swapped for one that drops its archive.
    const bound = tempRoot();
    const pinned = writeRecord(bound, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', archive: Buffer.from('bytes') });
    writeFileSync(join(bound, 'link-preservation-manifest.json'), JSON.stringify({ original_tree: pinned.treePath, relative_entries: [], archive_sha256: '' }));
    expect(resolve(pinned)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/does not match its bound digest/) });
  });

  const hardlinkCases = ['original-custody-and-retention-preflight.json', 'complete-original-report.md', 'link-preservation-manifest.json', 'current-ignored-untracked-deliverables-links-preserved.tar.gz'];
  const hardlinked = (name: string) => () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', archive: Buffer.from('bytes') });
    linkSync(join(root, name), join(tempRoot(), 'second-name'));
    expect(resolve(record)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/is not a single-link regular file/) });
  };
  it('refuses a hardlinked record', hardlinked(hardlinkCases[0]!));
  it('refuses a hardlinked asset', hardlinked(hardlinkCases[1]!));
  it('refuses a hardlinked manifest', hardlinked(hardlinkCases[2]!));
  it('refuses a hardlinked archive', hardlinked(hardlinkCases[3]!));

  const symlinked = (name: string) => () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', archive: Buffer.from('bytes') });
    const elsewhere = join(tempRoot(), name);
    renameSync(join(root, name), elsewhere);
    symlinkSync(elsewhere, join(root, name));
    expect(resolve(record)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/is a symbolic link — refused, never read through/) });
  };
  it('refuses a symlinked record leaf', symlinked(hardlinkCases[0]!));
  it('refuses a symlinked manifest', symlinked(hardlinkCases[2]!));
  it('refuses a symlinked archive', symlinked(hardlinkCases[3]!));

  it('refuses a FIFO asset without blocking on it', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    rmSync(join(root, 'original-source-session.jsonl'));
    execFileSync('mkfifo', [join(root, 'original-source-session.jsonl')]);
    expect(resolve(record)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/original-source-session\.jsonl is not a single-link regular file/) });
  });

  it('refuses a record reached through a symlinked directory, and a symlinked original tree', () => {
    const root = tempRoot();
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's' });
    const alias = join(tempRoot(), 'alias');
    symlinkSync(root, alias);
    const viaAlias = resolvePreservationReference({ reference: { recordPath: join(alias, 'original-custody-and-retention-preflight.json'), recordSha256: record.recordSha256 }, jobId: 'job-h1' });
    expect(viaAlias).toMatchObject({ reusable: false, guidance: expect.stringMatching(/record directory .*alias must be a real directory reached by no symlink/) });
    const treeRoot = tempRoot();
    const realTree = join(treeRoot, 'real-tree');
    mkdirSync(realTree);
    symlinkSync(realTree, join(treeRoot, 'tree-link'));
    const linkedTree = writeRecord(tempRoot(), { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', treePath: join(treeRoot, 'tree-link') });
    expect(resolve(linkedTree)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/original tree .*tree-link must be an absolute real directory/) });
  });

  it('refuses an entry under a dangling link or a loop as unresolvable, and "." or empty segments as escaping', () => {
    const root = tempRoot();
    const tree = join(root, 'tree');
    mkdirSync(tree, { recursive: true });
    symlinkSync(join(tempRoot(), 'not-yet-there'), join(tree, 'dangling'));
    symlinkSync(join(tree, 'loop'), join(tree, 'loop'));
    const verdictFor = (entry: string) => resolve(writeRecord(tempRoot(), { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', treePath: tree, linkEntries: [entry] }));
    for (const entry of ['dangling/node_modules', 'loop/x']) {
      expect(verdictFor(entry), entry).toMatchObject({ reusable: false, guidance: expect.stringMatching(/cannot be resolved inside the original tree .*a dangling link, a loop/u) });
    }
    for (const entry of ['.', 'a/./b', 'a//b']) {
      expect(verdictFor(entry), entry).toMatchObject({ reusable: false, guidance: expect.stringMatching(/escapes the original tree/) });
    }
  });

  it('refuses a relative original tree and a malformed manifest binding by name', () => {
    const relativeTree = writeRecord(tempRoot(), { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', treePath: 'relative/tree' });
    expect(resolve(relativeTree)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/original tree relative\/tree must be an absolute real directory/u) });
    for (const value of [null, 'F'.repeat(64), 7]) {
      const record = writeRecord(tempRoot(), { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', manifestBindingValue: value });
      expect(resolve(record), String(value)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/link_manifest_sha256 is malformed \(must be 64 lowercase hex characters\)/u) });
    }
    // The caller's binding is held to the same form, by name.
    const unbound = writeRecord(tempRoot(), { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', bindManifest: false });
    for (const value of ['F'.repeat(64), 'short']) {
      expect(resolvePreservationReference({ reference: { recordPath: unbound.recordPath, recordSha256: unbound.recordSha256, expectedAssets: { 'link-preservation-manifest.json': value } }, jobId: 'job-h1' }), value)
        .toMatchObject({ reusable: false, guidance: expect.stringMatching(/caller's expectedAssets\["link-preservation-manifest\.json"\] is malformed/u) });
    }
  });

  it.runIf(process.getuid?.() !== 0)('refuses an entry an unreadable directory hides, never treating it as archive-only', () => {
    const root = tempRoot();
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'locked'), { recursive: true });
    const record = writeRecord(root, { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', treePath: tree, linkEntries: ['locked/link'] });
    chmodSync(join(tree, 'locked'), 0o000);
    try {
      expect(resolve(record)).toMatchObject({ reusable: false, guidance: expect.stringMatching(/a link-preservation entry is unreadable \("locked\/link": .*EACCES/u) });
    } finally { chmodSync(join(tree, 'locked'), 0o700); }
  });

  it('hashes a preserved archive larger than one read chunk', () => {
    const archive = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    const record = writeRecord(tempRoot(), { jobId: 'job-h1', repo: 'fixture-repo', report: 'r', session: 's', archive });
    expect(resolve(record)).toMatchObject({ reusable: true, verifiedAssets: expect.arrayContaining(['archive(current-ignored-untracked-deliverables-links-preserved.tar.gz)']) });
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
    const other = writeRecord(tempRoot(), { jobId: 'job-h1', repo: 'fixture-repo', report: 'other report', session: 's' });
    let attempts = 0;
    const ops = opsFor(ledger, async () => {
      attempts += 1;
      if (attempts < 3) return { status: 'paused', processes: [], preserved: null, note: 'a process is using the tree' };
      return { status: 'swept', preserved: null, branch: 'none', freshHead: 'a'.repeat(40) };
    });
    const reference = { recordPath: record.recordPath, recordSha256: record.recordSha256 };
    await expect(ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack', preservationReference: reference })).rejects.toThrow(/paused/);
    await expect(ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack', preservationReference: reference })).rejects.toThrow(/paused/);
    expect(ledger.listJobEventsByKinds(job.id, ['silas.preservation-reuse'])).toHaveLength(1);
    // A DIFFERENT record is a different selection: it is recorded too.
    await ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack', preservationReference: { recordPath: other.recordPath, recordSha256: other.recordSha256 } });
    expect(attempts).toBe(3);
    expect(ledger.listJobEventsByKinds(job.id, ['silas.preservation-reuse']).map((event) => (event.payload as { record_sha256: string }).record_sha256))
      .toEqual([other.recordSha256, record.recordSha256]);
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
