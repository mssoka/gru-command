import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admissionPreflight, ReviewAdmissionError } from '../src/dispatch/perkins-review/admission.js';
import { probeAdvertisedTipMovementAsync, remainingTimeoutMs } from '../src/dispatch/perkins-review/artifacts.js';
import {
  freezeReviewInputs,
  type FrozenReview,
} from '../src/dispatch/perkins-review/artifacts.js';
import { appendCiEvidence, renderRecordedCiEvidence } from '../src/review-inputs/ci-evidence.js';
import { appendRecordedVerification } from '../src/verify/evidence.js';
import { minimalPng } from './helpers/images.js';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Admission preflight (gh-169 Stage 4): the read-only gate between the
 * freeze and ANY review spawn. It validates the complete frozen packet from
 * its own bytes and refuses with ONE exhaustive, precisely named
 * missing-input list — before a lead or specialist child can start.
 *
 * Fail-before: on 6cdd5ab this module and its named refusals do not exist;
 * a corrupt frozen packet surfaced only later (or never), and a parent
 * abort painted every lens red. Every test here fails on the pre-change
 * sources (module missing) and pins the honest shapes after.
 */

const repos: FixtureRepo[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  dirs.push(dir);
  return dir;
}

const IMAGE = minimalPng(Buffer.from('admission-preflight-reference-pixels'));

function makeUpload(uploadsDir: string, name: string, bytes: Buffer): string {
  const path = join(uploadsDir, `${Date.now()}-${randomUUID()}-${name}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

interface PreflightHarness {
  readonly review: FrozenReview;
  readonly repo: FixtureRepo;
  readonly uploadsDir: string;
  /** sha256 of every packet file at freeze time (immutability proofs). */
  readonly packetHashes: ReadonlyMap<string, string>;
}

/** Build a production-shaped freeze: a supplied spec carrying BOTH explicit
 * evidence sections (verification UNAVAILABLE disclosure + CI UNAVAILABLE
 * block, exactly what a no-observation job freezes), a CI record in the
 * manifest, and one private evidence attachment. */
function preflightHarness(options: { readonly withEvidence?: boolean } = {}): PreflightHarness {
  const repo = makeFixtureRepo('admission-preflight');
  repos.push(repo);
  const base = repo.head();
  repo.git(['checkout', '-b', 'feature/admission']);
  const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
  const artifactRoot = temp('admission-artifacts-');
  const uploadsDir = temp('admission-uploads-');
  const ci = renderRecordedCiEvidence({
    events: { branchState: null, ciGreen: null, ciFailed: null },
    targetSha: target,
    expectedRepo: 'acme/fixture',
    expectedPr: 7,
  });
  let spec = appendRecordedVerification({ spec: 'Acceptance: answer returns 43.', evidence: null });
  spec = appendCiEvidence({ spec, block: ci.block, maxBytes: 256 * 1024 });
  const review = freezeReviewInputs({
    roundId: 'round-admission',
    repoPath: repo.path,
    artifactRoot,
    baseRef: base,
    targetRef: target,
    movementRef: 'feature/admission',
    spec,
    ciEvidence: ci.record,
    jobId: 'job-admission',
    ...(options.withEvidence === true
      ? {
          evidence: [{
            uploadPath: makeUpload(uploadsDir, 'reference.png', IMAGE),
            purpose: 'owner reference render',
            consentRef: 'owner approval gh-169',
            capturedAt: '2026-10-05',
          }],
          evidenceUploadsDir: uploadsDir,
        }
      : {}),
  });
  const packetHashes = new Map<string, string>();
  for (const name of ['manifest.json', 'diff.patch', 'spec-context.md', 'project-conventions.md', 'changed-files.json']) {
    packetHashes.set(name, createHash('sha256').update(readFileSync(join(review.directory, name))).digest('hex'));
  }
  return { review, repo, uploadsDir, packetHashes };
}

/** Re-parse the on-disk manifest into the in-memory review, so a tampered
 * disk record is judged on its own shape (not as a disk/memory mismatch). */
function withDiskManifest(review: FrozenReview): FrozenReview {
  return {
    ...review,
    manifest: JSON.parse(readFileSync(join(review.directory, 'manifest.json'), 'utf8')) as FrozenReview['manifest'],
  };
}

describe('Perkins admission preflight (gh-169)', () => {
  it('passes a complete production-shaped packet and names every check it ran', () => {
    const { review } = preflightHarness({ withEvidence: true });
    const result = admissionPreflight(review, 'feature/admission');
    expect(result.missing).toEqual([]);
    const names = result.checks.map((check) => check.name);
    for (const expected of [
      'head-binding',
      'frozen-packet:manifest.json',
      'frozen-packet:diff.patch',
      'frozen-packet:spec-context.md',
      'frozen-packet:project-conventions.md',
      'frozen-packet:changed-files.json',
      'spec-context',
      'verification-evidence',
      'ci-evidence',
      'evidence:ev1',
    ]) {
      expect(names, expected).toContain(expected);
    }
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it('refuses inaccessible material with EVERY named missing input at once, before any spawn', () => {
    const { review } = preflightHarness({ withEvidence: true });
    // Two independent corruptions: a mutated frozen diff and a deleted
    // evidence copy. The refusal is exhaustive, not first-error.
    writeFileSync(join(review.directory, 'diff.patch'), `${review.diff}\n// mutated after freeze\n`);
    rmSync(join(review.directory, 'evidence', 'ev1.bin'));
    const result = admissionPreflight(review, 'feature/admission');
    const inputs = result.missing.map((entry) => entry.input);
    expect(inputs).toContain('frozen-packet:diff.patch');
    expect(inputs).toContain('evidence:ev1');
    const error = new ReviewAdmissionError(result.missing);
    expect(error.message).toContain('review admission preflight refused: 2 missing input(s)');
    expect(error.message).toContain('[frozen-packet:diff.patch]');
    expect(error.message).toContain('[evidence:ev1]');
  });

  it('refuses a moved head with the precise head-binding input', () => {
    const { review, repo } = preflightHarness();
    const resultBefore = admissionPreflight(review, 'feature/admission');
    expect(resultBefore.missing).toEqual([]);
    // The target branch advances after the freeze: the packet is no longer
    // head-bound and admission must refuse BEFORE any specialist runs.
    repo.commitFile('src/moved.ts', 'export const moved = true;\n');
    const result = admissionPreflight(review, 'feature/admission');
    expect(result.missing.map((entry) => entry.input)).toEqual(['head-binding']);
    expect(result.missing[0]!.detail).toContain('target-moved');
  });

  it('refuses a packet whose frozen CI record is absent while the spec carries the section', () => {
    const { review } = preflightHarness();
    // Strip the CI record from the manifest (the spec keeps its explicit
    // UNAVAILABLE section): the record itself is the missing input.
    const manifest = JSON.parse(readFileSync(join(review.directory, 'manifest.json'), 'utf8')) as FrozenReview['manifest'];
    const { reviewEvidence: _dropped, ...withoutEvidence } = manifest;
    const stripped: FrozenReview['manifest'] = withoutEvidence;
    const result = admissionPreflight({ ...review, manifest: stripped }, 'feature/admission');
    expect(result.missing.map((entry) => entry.input)).toEqual(['frozen-packet:manifest.json', 'ci-evidence']);
    expect(result.missing[1]!.detail).toContain('no exact-target CI record froze with the packet');
  });

  it('refuses a malformed or unbound frozen CI record, and never treats missing as failed', () => {
    const { review } = preflightHarness();
    // Malformed state: named precisely, distinct from a measured failure.
    const tampered = JSON.parse(readFileSync(join(review.directory, 'manifest.json'), 'utf8')) as FrozenReview['manifest'];
    const malformedManifest = {
      ...tampered,
      reviewEvidence: {
        attachments: [],
        ci: { ...tampered.reviewEvidence!.ci!, state: 'bogus' },
      },
    };
    writeFileSync(join(review.directory, 'manifest.json'), `${JSON.stringify(malformedManifest, null, 2)}\n`);
    const malformed = admissionPreflight(withDiskManifest(review), 'feature/admission');
    expect(malformed.missing.map((entry) => entry.input)).toEqual(['ci-evidence']);
    expect(malformed.missing[0]!.detail).toContain('malformed');

    // A "green" record bound to a DIFFERENT sha is not bound to this head.
    const { review: other } = preflightHarness();
    const unboundManifest = JSON.parse(readFileSync(join(other.directory, 'manifest.json'), 'utf8')) as FrozenReview['manifest'];
    const unboundCi = {
      ...unboundManifest,
      reviewEvidence: {
        attachments: [],
        ci: { ...unboundManifest.reviewEvidence!.ci!, state: 'green', sha: 'f'.repeat(40), repo: 'acme/fixture', reason: null },
      },
    };
    writeFileSync(join(other.directory, 'manifest.json'), `${JSON.stringify(unboundCi, null, 2)}\n`);
    const unboundResult = admissionPreflight(withDiskManifest(other), 'feature/admission');
    expect(unboundResult.missing.map((entry) => entry.input)).toEqual(['ci-evidence']);
    expect(unboundResult.missing[0]!.detail).toContain('not the frozen target');
  });

  it('accepts an explicit UNAVAILABLE CI record — missing evidence is a disclosed limitation, never an admission failure', () => {
    const { review } = preflightHarness();
    const result = admissionPreflight(review, 'feature/admission');
    expect(result.missing).toEqual([]);
    const ciCheck = result.checks.find((check) => check.name === 'ci-evidence');
    expect(ciCheck?.ok).toBe(true);
  });

  it('refuses a supplied spec that carries no verification section — absence must be explicit, never silent', () => {
    const repo = makeFixtureRepo('admission-no-verification');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/no-verification']);
    const target = repo.commitFile('src/main.ts', 'export const x = 1;\n');
    const artifactRoot = temp('admission-artifacts-');
    const ci = renderRecordedCiEvidence({
      events: { branchState: null, ciGreen: null, ciFailed: null },
      targetSha: target,
      expectedRepo: 'acme/fixture',
      expectedPr: 8,
    });
    // CI section present, verification section absent (the pre-change
    // silent shape): the preflight names exactly that.
    const spec = appendCiEvidence({ spec: 'Acceptance: x is 1.', block: ci.block, maxBytes: 256 * 1024 });
    const review = freezeReviewInputs({
      roundId: 'round-no-verification',
      repoPath: repo.path,
      artifactRoot,
      baseRef: base,
      targetRef: target,
      movementRef: 'feature/no-verification',
      spec,
      ciEvidence: ci.record,
    });
    const result = admissionPreflight(review, 'feature/no-verification');
    expect(result.missing.map((entry) => entry.input)).toEqual(['verification-evidence']);
    expect(result.missing[0]!.detail).toContain('neither recorded evidence nor its explicit UNAVAILABLE disclosure');
  });

  it('exempts explicit no-spec rounds from the spec sections while keeping every other check', () => {
    const repo = makeFixtureRepo('admission-nospec');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/nospec']);
    const target = repo.commitFile('src/main.ts', 'export const y = 2;\n');
    const artifactRoot = temp('admission-artifacts-');
    const ci = renderRecordedCiEvidence({
      events: { branchState: null, ciGreen: null, ciFailed: null },
      targetSha: target,
      expectedRepo: 'acme/fixture',
      expectedPr: 9,
    });
    const review = freezeReviewInputs({
      roundId: 'round-nospec',
      repoPath: repo.path,
      artifactRoot,
      baseRef: base,
      targetRef: target,
      movementRef: 'feature/nospec',
      noSpec: true,
      ciEvidence: ci.record,
    });
    const result = admissionPreflight(review, 'feature/nospec');
    expect(result.missing).toEqual([]);
    const specCheck = result.checks.find((check) => check.name === 'spec-context');
    const verificationCheck = result.checks.find((check) => check.name === 'verification-evidence');
    expect(specCheck?.ok).toBe(true);
    expect(verificationCheck?.ok).toBe(true);
  });

  it('refuses invalid UTF-8 spec bytes with a named exhaustive refusal instead of an uncaught decode (P1)', () => {
    const { review } = preflightHarness();
    // Digest-consistent but non-UTF-8 spec bytes: the manifest hashes raw
    // bytes, so a matching digest does NOT prove decodable text. The fatal
    // decode is part of the guarded check, so admission still returns the
    // exhaustive named refusal (and the ledger event) rather than throwing
    // past them.
    const binarySpec = Buffer.concat([Buffer.from('binary: '), Buffer.from([0xff, 0xfe, 0x00])]);
    writeFileSync(join(review.directory, 'spec-context.md'), binarySpec);
    const manifest = JSON.parse(readFileSync(join(review.directory, 'manifest.json'), 'utf8')) as FrozenReview['manifest'];
    const tampered = {
      ...manifest,
      specSha256: createHash('sha256').update(binarySpec).digest('hex'),
    };
    writeFileSync(join(review.directory, 'manifest.json'), `${JSON.stringify(tampered, null, 2)}\n`);
    const result = admissionPreflight({ ...review, manifest: tampered }, 'feature/admission');
    const inputs = result.missing.map((entry) => entry.input);
    expect(inputs).toContain('spec-context');
    expect(inputs).toContain('verification-evidence');
    // Independent checks still ran and passed.
    expect(result.checks.find((check) => check.name === 'head-binding')?.ok).toBe(true);
    expect(result.checks.find((check) => check.name === 'ci-evidence')?.ok).toBe(true);
    expect(result.missing.find((entry) => entry.input === 'spec-context')!.detail).toContain('not valid UTF-8');
    // Q3: exactly ONE verdict for the spec file's name — the digest pass
    // is never contradicted by a same-name decode failure.
    const specChecks = result.checks.filter((check) => check.name === 'frozen-packet:spec-context.md');
    expect(specChecks).toHaveLength(1);
    expect(specChecks[0]!.ok).toBe(false);
    expect(specChecks[0]!.detail).toContain('not valid UTF-8');
  });

  it('refuses a hash-consistent changed-file list that is malformed or diverges from the manifest (Q1)', () => {
    const { review } = preflightHarness();
    const original = JSON.parse(readFileSync(join(review.directory, 'changed-files.json'), 'utf8')) as readonly string[];
    const malformed = `${JSON.stringify({ files: original })}\n`;
    writeFileSync(join(review.directory, 'changed-files.json'), malformed);
    const manifest = JSON.parse(readFileSync(join(review.directory, 'manifest.json'), 'utf8')) as FrozenReview['manifest'];
    const tampered = {
      ...manifest,
      changedFilesSha256: createHash('sha256').update(malformed).digest('hex'),
    };
    writeFileSync(join(review.directory, 'manifest.json'), `${JSON.stringify(tampered, null, 2)}\n`);
    const result = admissionPreflight({ ...review, manifest: tampered }, 'feature/admission');
    expect(result.missing.map((entry) => entry.input)).toEqual(['frozen-packet:changed-files.json']);
    expect(result.missing[0]!.detail).toContain('malformed or does not match the manifest list');
    const checks = result.checks.filter((check) => check.name === 'frozen-packet:changed-files.json');
    expect(checks).toHaveLength(1);
  });

  it('refuses a CI failure entry without its required conclusion (Q2)', () => {
    const { review } = preflightHarness();
    const onDisk = JSON.parse(readFileSync(join(review.directory, 'manifest.json'), 'utf8')) as FrozenReview['manifest'];
    const malformedManifest = {
      ...onDisk,
      reviewEvidence: {
        attachments: [],
        ci: {
          ...onDisk.reviewEvidence!.ci!,
          state: 'failed',
          sha: onDisk.targetSha,
          repo: 'acme/fixture',
          failures: [{ name: 'unit-tests', url: null }],
        },
      },
    };
    writeFileSync(join(review.directory, 'manifest.json'), `${JSON.stringify(malformedManifest, null, 2)}\n`);
    const result = admissionPreflight(withDiskManifest(review), 'feature/admission');
    expect(result.missing.map((entry) => entry.input)).toEqual(['ci-evidence']);
    expect(result.missing[0]!.detail).toContain('conclusion is required');
  });

  it('refuses a hash-consistent CI record whose consumed fields are malformed (P2)', () => {
    const { review } = preflightHarness();
    const tampered = JSON.parse(readFileSync(join(review.directory, 'manifest.json'), 'utf8')) as FrozenReview['manifest'];
    const malformedManifest = {
      ...tampered,
      reviewEvidence: {
        attachments: [],
        // Known state, bound to the right head — but the failures field the
        // report layer dereferences is not an array.
        ci: { ...tampered.reviewEvidence!.ci!, state: 'failed', sha: tampered.targetSha, repo: 'acme/fixture', failures: 'unit-tests' },
      },
    };
    writeFileSync(join(review.directory, 'manifest.json'), `${JSON.stringify(malformedManifest, null, 2)}\n`);
    const result = admissionPreflight(withDiskManifest(review), 'feature/admission');
    expect(result.missing.map((entry) => entry.input)).toEqual(['ci-evidence']);
    expect(result.missing[0]!.detail).toContain('failures');
    expect(result.missing[0]!.detail).toContain('malformed');
  });

  it('keeps EVERY missing-input name in the refusal message when details overflow the bound (P4)', () => {
    const missing = Array.from({ length: 40 }, (_unused, index) => ({
      input: `evidence:ev${index + 1}`,
      detail: 'x'.repeat(300),
    }));
    const error = new ReviewAdmissionError(missing);
    for (let index = 1; index <= 40; index += 1) {
      expect(error.message).toContain(`[evidence:ev${index}]`);
    }
    expect(error.message).toContain('40 missing input(s)');
    expect(error.message.length).toBeLessThan(2_200);
    expect(error.missing).toHaveLength(40);
  });

  it('refuses a CI record that omits a contract-required nullable key (Q2/P7)', () => {
    const { review } = preflightHarness();
    const onDisk = JSON.parse(readFileSync(join(review.directory, 'manifest.json'), 'utf8')) as FrozenReview['manifest'];
    const { reason: _omitted, ...withoutReason } = onDisk.reviewEvidence!.ci!;
    const absentManifest = {
      ...onDisk,
      reviewEvidence: { attachments: [], ci: withoutReason },
    };
    writeFileSync(join(review.directory, 'manifest.json'), `${JSON.stringify(absentManifest, null, 2)}\n`);
    const result = admissionPreflight(withDiskManifest(review), 'feature/admission');
    expect(result.missing.map((entry) => entry.input)).toEqual(['ci-evidence']);
    expect(result.missing[0]!.detail).toContain('reason field is absent');
  });

  it('bounds the advertised-remote probe at admission: a stalled remote refuses fail-closed in seconds, never stalls (P5)', () => {
    const repo = makeFixtureRepo('admission-stalled-remote');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/stalled']);
    const target = repo.commitFile('src/main.ts', 'export const s = 1;\n');
    attachBareOrigin(repo);
    const artifactRoot = temp('admission-artifacts-');
    const ci = renderRecordedCiEvidence({
      events: { branchState: null, ciGreen: null, ciFailed: null },
      targetSha: target,
      expectedRepo: 'acme/fixture',
      expectedPr: 11,
    });
    let spec = appendRecordedVerification({ spec: 'Acceptance: s is 1.', evidence: null });
    spec = appendCiEvidence({ spec, block: ci.block, maxBytes: 256 * 1024 });
    const review = freezeReviewInputs({
      roundId: 'round-stalled',
      repoPath: repo.path,
      artifactRoot,
      baseRef: base,
      targetRef: target,
      movementRef: 'origin/feature/stalled',
      spec,
      ciEvidence: ci.record,
    });
    // A tracking-ref spelling whose remote probe hangs: the shim sleeps
    // far past the admission bound (but under the 30 s full budget).
    repo.git(['update-ref', 'refs/remotes/origin/feature/stalled', target]);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = temp('admission-shim-');
    const shim = join(shimDir, 'git');
    writeFileSync(shim, `#!/bin/sh\ncase " $* " in *"ls-remote"*) sleep 20;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(shim, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    try {
      const startedAt = performance.now();
      const result = admissionPreflight(review, 'origin/feature/stalled', { remoteProbeTimeoutMs: 1_000 });
      const elapsed = performance.now() - startedAt;
      expect(elapsed).toBeLessThan(10_000);
      expect(result.missing.map((entry) => entry.input)).toEqual(['head-binding']);
      expect(result.missing[0]!.detail).toContain('check-failed');
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('probes the advertised tip OFF the event loop: unrelated work completes while a stalled remote waits (R4-6)', async () => {
    const repo = makeFixtureRepo('admission-async-probe');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/asyncprobe']);
    const target = repo.commitFile('src/main.ts', 'export const a = 1;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/asyncprobe']);
    const artifactRoot = temp('admission-artifacts-');
    const ci = renderRecordedCiEvidence({
      events: { branchState: null, ciGreen: null, ciFailed: null },
      targetSha: target,
      expectedRepo: 'acme/fixture',
      expectedPr: 12,
    });
    let spec = appendRecordedVerification({ spec: 'Acceptance: a is 1.', evidence: null });
    spec = appendCiEvidence({ spec, block: ci.block, maxBytes: 256 * 1024 });
    const review = freezeReviewInputs({
      roundId: 'round-asyncprobe',
      repoPath: repo.path,
      artifactRoot,
      baseRef: 'main',
      targetRef: target,
      movementRef: 'origin/feature/asyncprobe',
      spec,
      ciEvidence: ci.record,
    });
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = temp('admission-shim-');
    const shim = join(shimDir, 'git');
    writeFileSync(shim, `#!/bin/sh\ncase " $* " in *"ls-remote"*) sleep 8;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(shim, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    try {
      const stalled = probeAdvertisedTipMovementAsync(review, 3_000);
      // Unrelated event-loop work completes WHILE the stalled probe waits —
      // the probe is genuinely off the loop, not a bounded stall.
      const timers: number[] = [];
      const responsive = await Promise.race([
        new Promise<'responsive'>((resolve) => { setTimeout(() => resolve('responsive'), 50).unref?.(); }),
        stalled.then(() => 'probe-finished-first'),
      ]);
      expect(responsive).toBe('responsive');
      const movement = await stalled;
      expect(movement?.cause).toBe('check-failed');
      expect(timers).toEqual([]);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('enforces ONE cumulative budget: slow identification then a stalled remote refuse within the single deadline (R7-3)', async () => {
    const repo = makeFixtureRepo('admission-cumulative-budget');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/cumulative']);
    const target = repo.commitFile('src/main.ts', 'export const c = 1;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/cumulative']);
    const artifactRoot = temp('admission-artifacts-');
    const ci = renderRecordedCiEvidence({
      events: { branchState: null, ciGreen: null, ciFailed: null },
      targetSha: target,
      expectedRepo: 'acme/fixture',
      expectedPr: 13,
    });
    let spec = appendRecordedVerification({ spec: 'Acceptance: c is 1.', evidence: null });
    spec = appendCiEvidence({ spec, block: ci.block, maxBytes: 256 * 1024 });
    const review = freezeReviewInputs({
      roundId: 'round-cumulative',
      repoPath: repo.path,
      artifactRoot,
      baseRef: 'main',
      targetRef: target,
      movementRef: 'origin/feature/cumulative',
      spec,
      ciEvidence: ci.record,
    });
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = temp('admission-shim-');
    const shim = join(shimDir, 'git');
    // Identification is SLOW (600 ms per rev-parse/remote) and the remote
    // probe STALLS: the single 1.5 s budget must cover both and refuse.
    writeFileSync(shim, `#!/bin/sh\ncase " $* " in *"rev-parse"*|*" remote "*) sleep 0.6;; *"ls-remote"*) sleep 20;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(shim, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    try {
      const startedAt = performance.now();
      const movement = await probeAdvertisedTipMovementAsync(review, 1_500);
      const elapsed = performance.now() - startedAt;
      expect(movement?.cause).toBe('check-failed');
      // R8-5: DISCRIMINATING bound — under the cumulative budget the probe
      // refuses at ~1.5 s; a reverted per-call timeout (0.6+0.6+1.5 s)
      // would take ~2.7 s and fail this threshold.
      expect(elapsed).toBeLessThan(2_200);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  /** A frozen review whose target is a pushed branch, so admission runs
   * the full identification + advertised-tip probe against a real remote. */
  function branchTargetReview(name: string) {
    const repo = makeFixtureRepo(`admission-${name}`);
    repos.push(repo);
    repo.git(['checkout', '-b', `feature/${name}`]);
    const target = repo.commitFile('src/main.ts', `export const s = '${name}';\n`);
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', `refs/heads/feature/${name}`]);
    const ci = renderRecordedCiEvidence({
      events: { branchState: null, ciGreen: null, ciFailed: null },
      targetSha: target,
      expectedRepo: 'acme/fixture',
      expectedPr: 14,
    });
    let spec = appendRecordedVerification({ spec: 'Acceptance: s is set.', evidence: null });
    spec = appendCiEvidence({ spec, block: ci.block, maxBytes: 256 * 1024 });
    return freezeReviewInputs({
      roundId: `round-${name}`,
      repoPath: repo.path,
      artifactRoot: temp('admission-artifacts-'),
      baseRef: 'main',
      targetRef: target,
      movementRef: `origin/feature/${name}`,
      spec,
      ciEvidence: ci.record,
    });
  }

  it('a wall-clock jump mid-probe (clock correction) does not refuse admission', async () => {
    const review = branchTargetReview('wall-jump');
    const realNow = Date.now.bind(Date);
    let reads = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (reads++ === 0 ? 0 : 60_000));
    try {
      expect(await probeAdvertisedTipMovementAsync(review, 5_000)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('a system sleep between probe steps re-runs the probe once with a fresh budget (owner incident 2026-10-07)', async () => {
    // macOS: Node's monotonic clock (mach_continuous_time) keeps counting
    // through sleep. Model the incident's 51 s sleep: after the first read,
    // the budget clock is 60 s ahead.
    const review = branchTargetReview('sleep-between');
    const realNow = performance.now.bind(performance);
    let reads = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + (reads++ === 0 ? 0 : 60_000));
    try {
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000);
      expect(movement?.detail ?? '').not.toContain('budget exhausted');
      expect(movement).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('a sleep while a git step is outstanding: its kill fires on wake, the probe re-runs once and admits', async () => {
    const review = branchTargetReview('sleep-outstanding');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = temp('admission-sleep-shim-');
    const marker = join(shimDir, 'stalled-once');
    const calls = join(shimDir, 'rev-parse-calls');
    // The first rev-parse outlives the budget (the Mac slept under it); the
    // retry's rev-parse answers normally.
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\ncase " $* " in *"rev-parse"*) echo x >> "${calls}"; if [ ! -f "${marker}" ]; then : > "${marker}"; sleep 3; fi;; esac\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);
    const realNow = performance.now.bind(performance);
    let offset = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);
    const sleeping = setTimeout(() => {
      offset = 60_000; // 60 s of sleep passes while rev-parse is outstanding
    }, 700);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    try {
      expect(await probeAdvertisedTipMovementAsync(review, 1_500)).toBeNull();
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      clearTimeout(sleeping);
      clock.mockRestore();
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('a step that settles after the deadline fails closed — late success and late git rejection alike', async () => {
    const review = branchTargetReview('late-settle');
    let t = 0;
    const late = (settle: 'resolve' | 'reject') =>
      probeAdvertisedTipMovementAsync(review, 1_000, {
        now: () => t,
        suspensionGapMs: Number.POSITIVE_INFINITY,
        exec: async () => {
          t += 1_500; // event-loop work delayed this completion past the budget
          if (settle === 'reject') throw Object.assign(new Error('git: not a branch'), { code: 1 });
          return 'refs/remotes/origin/feature/late-settle\n';
        },
      });
    const success = await late('resolve');
    expect(success).toMatchObject({ cause: 'check-failed' });
    expect(success?.detail).toContain('budget exhausted after: git check-ref-format');
    t = 0;
    const rejection = await late('reject');
    expect(rejection).toMatchObject({ cause: 'check-failed' });
    expect(rejection?.detail).toContain('budget exhausted after: git check-ref-format');
  });

  it('rounds a fractional remainder up for execFile and refuses a spent budget', () => {
    expect(remainingTimeoutMs(100, 99.5)).toBe(1);
    expect(remainingTimeoutMs(100, 0)).toBe(100);
    expect(remainingTimeoutMs(100, 100)).toBeNull();
    expect(remainingTimeoutMs(100, 100.2)).toBeNull();
  });

  it('is read-only: a pass and a refusal leave every frozen packet byte identical', () => {
    const { review, packetHashes } = preflightHarness({ withEvidence: true });
    admissionPreflight(review, 'feature/admission'); // pass
    writeFileSync(join(review.directory, 'diff.patch'), 'tampered');
    admissionPreflight(review, 'feature/admission'); // refusal
    for (const [name, digest] of packetHashes) {
      if (name === 'diff.patch') continue; // the deliberate corruption
      expect(
        createHash('sha256').update(readFileSync(join(review.directory, name))).digest('hex'),
        name,
      ).toBe(digest);
    }
    // The corrupted file is still the only change — the evidence copy and
    // every digest-bearing artifact survive both preflight runs untouched.
    expect(existsSync(join(review.directory, 'evidence', 'ev1.bin'))).toBe(true);
  });
});
