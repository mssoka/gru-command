import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admissionPreflight, ReviewAdmissionError } from '../src/dispatch/perkins-review/admission.js';
import {
  defaultProbeExec,
  parseKernWaketime,
  probeAdvertisedTipMovementAsync,
  parseProcUptimeMs,
  readKernWaketime,
  remainingTimeoutMs,
  runOwnedGitSync,
  sourceMovementSinceFreeze,
  OWNED_GIT_SEAMS,
  executingMember,
  groupHasLiveMember,
  procGroupMembers,
  psGroupMembers,
  refUnresolved,
  runOwnedGit,
  type SourceMovement,
  SUSPEND_EVIDENCE_ALLOWANCE_MS,
  type SuspendEvidenceIo,
} from '../src/dispatch/perkins-review/artifacts.js';
import {
  freezeReviewInputs,
  type FrozenReview,
} from '../src/dispatch/perkins-review/artifacts.js';
import { appendCiEvidence, renderRecordedCiEvidence } from '../src/review-inputs/ci-evidence.js';
import { appendRecordedVerification } from '../src/verify/evidence.js';
import { minimalPng } from './helpers/images.js';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { discoverOwnGroup, reapShimRegistries } from './helpers/shim-reaper.js';

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
/** Pid files of fixture processes (R6-7): whatever an assertion skipped,
 * each recorded process is killed here BEFORE its file is deleted. */
const pidFiles: string[] = [];
/** R7-19: every git-shim invocation appends "<pid> <pgid>" here, so its
 * wrapper, group and same-group descendants are reaped — and proven gone —
 * even when an assertion failed first; never this worker's own group,
 * which must be known first (R8-23). */
const shimRegistries: string[] = [];
const ownGroup = discoverOwnGroup();

afterEach(() => {
  const survivors = reapShimRegistries(shimRegistries.splice(0), ownGroup);
  for (const pidFile of pidFiles.splice(0)) {
    let pid = Number.NaN;
    try {
      pid = Number(readFileSync(pidFile, 'utf8').trim());
    } catch {
      /* never written */
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  while (repos.length > 0) repos.pop()?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (survivors.length > 0) throw new Error(`git-shim fixtures still running after the reaper: ${survivors.join(', ')}`);
});

/** A fresh pid-file path the afterEach reaper owns. */
function pidFileFor(prefix: string, name: string): string {
  const pidFile = join(temp(prefix), name);
  pidFiles.push(pidFile);
  return pidFile;
}

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
  function branchTargetReview(name: string, options: { readonly qualified?: boolean } = {}) {
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
      movementRef: options.qualified === true ? `refs/remotes/origin/feature/${name}` : `origin/feature/${name}`,
      spec,
      ciEvidence: ci.record,
    });
  }

  /** OS suspend evidence as macOS reports it: the kernel's last wake,
   * `wakeOffsetMs` after the probe started (null: sysctl unreadable). */
  const WALL0 = 1_790_000_000_000;
  function macWake(wakeOffsetMs: number | null, reads: { count: number } = { count: 0 }): SuspendEvidenceIo {
    return {
      platform: 'darwin',
      wallNow: () => WALL0,
      kernWaketime: async () => {
        reads.count += 1;
        if (wakeOffsetMs === null) throw new Error('sysctl: unknown oid');
        const wake = WALL0 + wakeOffsetMs;
        return `{ sec = ${Math.floor(wake / 1000)}, usec = ${(wake % 1000) * 1000} } Wed Oct  7 09:56:48 2026\n`;
      },
      procUptime: async () => {
        throw new Error('ENOENT: /proc/uptime');
      },
    };
  }
  /** The last wake predates the probe: no suspend. */
  const NO_SUSPEND = macWake(-3_600_000);

  it('a wall-clock jump mid-probe (clock correction) does not refuse admission', async () => {
    const review = branchTargetReview('wall-jump');
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const steps: string[] = [];
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, {
        // Real git; the wall clock is corrected 60 s forward once the first
        // step has settled — a wall-clock budget would now be spent.
        exec: async (repo, args, timeoutMs) => {
          const stdout = await defaultProbeExec(repo, args, timeoutMs);
          steps.push(args[0]!);
          offset = 60_000;
          return stdout;
        },
        evidence: NO_SUSPEND,
      });
      expect(steps[0]).toBe('check-ref-format');
      expect(steps).toContain('ls-remote');
      expect(movement).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  /** A scripted git for a branch-target probe: answers every step, records
   * each call, and can run a hook (a clock jump, a failure) per call. */
  function scriptedGit(targetSha: string, hook: (args: readonly string[], call: number) => void = () => {}) {
    const calls: string[] = [];
    const exec = async (_repo: string, args: readonly string[]): Promise<string> => {
      calls.push(args[0]!);
      hook(args, calls.length);
      if (args[0] === 'rev-parse') return `refs/remotes/origin/${String(args.at(-1)).replace(/^origin\//u, '')}\n`;
      if (args[0] === 'remote') return 'origin\n';
      if (args[0] === 'ls-remote') return `${targetSha}\trefs/heads/feature\n`;
      return '';
    };
    return { calls, exec };
  }

  it('a suspend between probe steps (OS evidence) restarts identification exactly once with a fresh budget', async () => {
    const review = branchTargetReview('sleep-between');
    for (const evidence of [true, false]) {
      let t = 0;
      // The machine suspends right after the first step: the budget clock is
      // 60 s further on when that step settles (macOS clocks count sleep).
      const git = scriptedGit(review.manifest.targetSha, (args, call) => {
        if (call === 1) t += 60_000;
      });
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, {
        now: () => t,
        exec: git.exec,
        evidence: evidence ? macWake(30_000) : NO_SUSPEND,
      });
      if (evidence) {
        expect(movement).toBeNull();
        expect(git.calls).toEqual(['check-ref-format', 'check-ref-format', 'rev-parse', 'remote', 'ls-remote']);
      } else {
        expect(movement?.cause).toBe('check-failed');
        expect(movement?.detail).toContain('budget exhausted after: git check-ref-format');
        expect(git.calls).toEqual(['check-ref-format']);
      }
    }
  });

  it('a suspend while a real git step is outstanding: its kill lands on wake, the one retry admits', async () => {
    const review = branchTargetReview('sleep-outstanding');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = temp('admission-sleep-shim-');
    const marker = join(shimDir, 'stalled-once');
    const calls = join(shimDir, 'rev-parse-calls');
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\ncase " $* " in *"rev-parse"*) echo x >> "${calls}"; if [ ! -f "${marker}" ]; then : > "${marker}"; sleep 3; fi;; esac\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);
    let offset = 0;
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    try {
      const movement = await probeAdvertisedTipMovementAsync(review, 1_500, {
        now: () => performance.now() + offset,
        // Barrier: the moment the first rev-parse is launched, the machine
        // "sleeps" 60 s — the real execFile kill then fires on wake.
        exec: (repo, args, timeoutMs) => {
          const running = defaultProbeExec(repo, args, timeoutMs);
          if (args[0] === 'rev-parse' && offset === 0) offset = 60_000;
          return running;
        },
        evidence: macWake(30_000),
      });
      expect(movement).toBeNull();
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('a failed retry is final: its own check-failed detail, and never a third attempt', async () => {
    const review = branchTargetReview('retry-fails');
    let t = 0;
    const git = scriptedGit(review.manifest.targetSha, (args, call) => {
      if (call === 1) t += 60_000; // suspend during the first attempt
      if (call >= 2 && args[0] === 'rev-parse') throw new Error('fatal: unable to access the remote');
    });
    const movement = await probeAdvertisedTipMovementAsync(review, 5_000, {
      now: () => t,
      exec: git.exec,
      evidence: macWake(30_000), // evidence even after the retry
    });
    expect(movement?.cause).toBe('check-failed');
    expect(movement?.detail).toContain('unable to access the remote');
    expect(git.calls.filter((call) => call === 'check-ref-format')).toHaveLength(2);
  });

  it('without OS suspend evidence a blocked event loop earns no retry — refused within the single deadline', async () => {
    const review = branchTargetReview('stall-no-evidence');
    let t = 0;
    const git = scriptedGit(review.manifest.targetSha, (_args, call) => {
      if (call === 1) t += 5_500; // the service's own work blocked the loop
    });
    const asked = { count: 0 };
    const movement = await probeAdvertisedTipMovementAsync(review, 5_000, {
      now: () => t,
      exec: git.exec,
      evidence: macWake(-3_600_000, asked),
    });
    expect(movement?.cause).toBe('check-failed');
    expect(git.calls).toEqual(['check-ref-format']);
    expect(asked.count).toBe(1);
  });

  it('the production detector decides the one retry from the OS inputs alone (macOS wake, raw /proc/uptime)', async () => {
    const review = branchTargetReview('evidence-table');
    type Case = {
      readonly name: string;
      readonly retry: boolean;
      readonly mac?: number | null;
      readonly platform?: NodeJS.Platform;
      /** Linux: how far each clock advances while the first step runs. */
      readonly linux?: { readonly monoMs: number; readonly bootMs: number; readonly onWake?: 'unreadable' | 'garbled' | 'overflowing' };
    };
    const cases: Case[] = [
      { name: 'macOS woke after the start', retry: true, mac: 30_000 },
      { name: 'macOS woke at the start instant', retry: false, mac: 0 },
      { name: 'macOS last wake is stale', retry: false, mac: -3_600_000 },
      { name: 'macOS wake unreadable', retry: false, mac: null },
      { name: 'Linux suspended 60 s: boot clock ran on, monotonic paused', retry: true, linux: { monoMs: 0, bootMs: 60_000 } },
      { name: 'Linux 5.5 s stall on both clocks is no suspend', retry: false, linux: { monoMs: 5_500, bootMs: 5_500 } },
      { name: 'Linux boot clock ahead by exactly 1 s', retry: false, linux: { monoMs: 5_500, bootMs: 6_500 } },
      { name: 'Linux boot clock ahead by 1.01 s', retry: true, linux: { monoMs: 5_500, bootMs: 6_510 } },
      { name: 'Linux /proc/uptime unreadable on wake', retry: false, linux: { monoMs: 0, bootMs: 60_000, onWake: 'unreadable' } },
      { name: 'Linux /proc/uptime garbled on wake', retry: false, linux: { monoMs: 0, bootMs: 60_000, onWake: 'garbled' } },
      { name: 'Linux /proc/uptime overflowing on wake', retry: false, linux: { monoMs: 0, bootMs: 60_000, onWake: 'overflowing' } },
      { name: 'no evidence source on this platform', retry: false, platform: 'win32' },
    ];
    for (const c of cases) {
      let t = 0;
      let bootMs = 500_000;
      let uptimeReads = 0;
      // The first step is broken by the suspend: on macOS the budget clock
      // jumped; on Linux the clocks moved as the case says and the
      // connection dropped.
      const git = scriptedGit(review.manifest.targetSha, (_args, call) => {
        if (call !== 1) return;
        if (c.linux !== undefined) {
          t += c.linux.monoMs;
          bootMs += c.linux.bootMs;
          throw new Error('fatal: the remote end hung up unexpectedly');
        }
        t += 60_000;
      });
      // Raw /proc/uptime text — the production parser converts it.
      const uptime = async (): Promise<string> => {
        uptimeReads += 1;
        if (uptimeReads > 1 && c.linux?.onWake === 'unreadable') throw new Error('EACCES: /proc/uptime');
        if (uptimeReads > 1 && c.linux?.onWake === 'garbled') return 'not an uptime';
        if (uptimeReads > 1 && c.linux?.onWake === 'overflowing') return `${'9'.repeat(400)} 1234.56\n`;
        return `${(bootMs / 1000).toFixed(2)} 1234.56\n`;
      };
      const evidence: SuspendEvidenceIo = c.linux !== undefined
        ? { platform: 'linux', wallNow: () => WALL0, kernWaketime: async () => { throw new Error('not macOS'); }, procUptime: uptime }
        : c.platform !== undefined
          ? { ...macWake(30_000), platform: c.platform }
          : macWake(c.mac ?? null);
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, { now: () => t, exec: git.exec, evidence });
      expect({ name: c.name, admitted: movement === null, attempts: git.calls.filter((call) => call === 'check-ref-format').length })
        .toEqual({ name: c.name, admitted: c.retry, attempts: c.retry ? 2 : 1 });
    }
    expect(parseProcUptimeMs('560.25 1234.56\n')).toBe(560_250);
    expect(parseProcUptimeMs('')).toBeNull();
    expect(parseProcUptimeMs(`${'9'.repeat(400)} 0.00`)).toBeNull();
  });

  it('evidence that arrives at or past its allowance is no evidence — whether the reader or the loop was slow', async () => {
    const review = branchTargetReview('evidence-late');
    for (const slow of ['before answering', 'while answering'] as const) {
      let t = 0;
      const git = scriptedGit(review.manifest.targetSha, (_args, call) => {
        if (call === 1) t += 60_000;
      });
      const wake = macWake(30_000);
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, {
        now: () => t,
        exec: git.exec,
        evidence: {
          ...wake,
          kernWaketime: (timeoutMs) => {
            if (slow === 'before answering') t += 1_200; // a synchronous stall inside the reader
            return wake.kernWaketime(timeoutMs).then((text) => {
              if (slow === 'while answering') t += 1_200; // the answer lands late
              return text;
            });
          },
        },
      });
      expect({ slow, cause: movement?.cause, attempts: git.calls.filter((call) => call === 'check-ref-format').length })
        .toEqual({ slow, cause: 'check-failed', attempts: 1 });
    }
  });

  it('a retry that finds the advertised tip moved refuses with target-moved — and preflight refuses head-binding', async () => {
    const review = branchTargetReview('retry-moved');
    const moved = 'f'.repeat(40);
    let t = 0;
    const calls: string[] = [];
    const exec = async (_repo: string, args: readonly string[]): Promise<string> => {
      calls.push(args[0]!);
      if (calls.length === 1) t += 60_000; // suspended during the first attempt
      if (args[0] === 'rev-parse') return `refs/remotes/origin/feature/retry-moved\n`;
      if (args[0] === 'remote') return 'origin\n';
      if (args[0] === 'ls-remote') return `${moved}\trefs/heads/feature/retry-moved\n`; // pushed during the sleep
      return '';
    };
    const movement = await probeAdvertisedTipMovementAsync(review, 5_000, { now: () => t, exec, evidence: macWake(30_000) });
    expect(movement?.cause).toBe('target-moved');
    expect(movement?.detail).toContain(moved);
    expect(movement?.detail).toContain(review.manifest.targetSha);
    expect(calls.filter((call) => call === 'check-ref-format')).toHaveLength(2);
    const result = admissionPreflight(review, 'origin/feature/retry-moved', { precomputedRemoteMovement: movement });
    expect(result.checks.find((check) => check.name === 'head-binding')?.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining([expect.objectContaining({ input: 'head-binding' })]));
    expect(result.missing.find((entry) => entry.input === 'head-binding')?.detail).toContain('target-moved');
  });

  it('only git’s own refusal of the spelling skips the remote proof — an operational failure fails closed', async () => {
    const review = branchTargetReview('operational');
    const failing = (step: string, error: Error) => {
      const calls: string[] = [];
      const exec = async (_repo: string, args: readonly string[]): Promise<string> => {
        calls.push(args[0]!);
        if (args[0] === step) throw error;
        if (args[0] === 'rev-parse') return 'refs/remotes/origin/feature/operational\n';
        if (args[0] === 'remote') return 'origin\n';
        if (args[0] === 'ls-remote') return `${review.manifest.targetSha}\trefs/heads/feature/operational\n`;
        return '';
      };
      return { calls, exec };
    };
    const git128 = (stderr: string) => Object.assign(new Error(stderr), { code: 128, stderr });
    // An unreadable repository exits 128 too — it proves nothing.
    for (const [step, error] of [
      ['check-ref-format', git128("fatal: cannot change to '/repo': No such file or directory")],
      ['rev-parse', git128('fatal: Needed a single revision')],
    ] as const) {
      const git = failing(step, error);
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, { now: () => 0, exec: git.exec, evidence: NO_SUSPEND });
      expect({ step, cause: movement?.cause }).toEqual({ step, cause: 'check-failed' });
      expect(git.calls).not.toContain('ls-remote');
    }
    // In time, git's own invalid-name answer is a spelling, not a branch: skip.
    const named = failing('check-ref-format', git128(`fatal: '${review.manifest.targetRef}' is not a valid branch name`));
    expect(await probeAdvertisedTipMovementAsync(review, 5_000, { now: () => 0, exec: named.exec, evidence: NO_SUSPEND })).toBeNull();
    // A real unreadable repository, end to end.
    const away = `${review.manifest.repoPath}-away`;
    renameSync(review.manifest.repoPath, away);
    try {
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, { evidence: NO_SUSPEND });
      expect(movement?.cause).toBe('check-failed');
    } finally {
      renameSync(away, review.manifest.repoPath);
    }
  });

  it('the synchronous movement probe fails closed on an operational check-ref-format failure, not "not a branch"', () => {
    const review = branchTargetReview('sync-operational');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = temp('admission-sync-operational-');
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\ncase " $* " in *"check-ref-format"*) echo "fatal: cannot change to '/repo': No such file or directory" >&2; exit 128;; esac\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    try {
      expect(sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 5_000 })?.cause).toBe('check-failed');
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  /** Still executing — a zombie (killed, not yet reaped by whatever
   * adopted it) is not. Linux reads /proc; elsewhere ps. */
  function processRunning(pid: number): boolean {
    if (process.platform === 'linux') {
      let stat: string;
      try {
        stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      return state !== 'Z' && state !== 'X';
    }
    const state = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    return state !== '' && !state.startsWith('Z');
  }
  /** Waits briefly for `pid` to stop; kills it regardless, so no fixture
   * process outlives the test. */
  async function stoppedOnItsOwn(pidFile: string): Promise<boolean> {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    for (let attempt = 0; attempt < 20 && processRunning(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const gone = !processRunning(pid);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    rmSync(pidFile, { force: true });
    return gone;
  }
  /** A git on PATH that runs `script` for the `step` subcommand and the
   * real git for everything else; returns the restore function. */
  function gitShim(step: string, script: string): () => void {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = temp('admission-git-shim-');
    const registry = join(shimDir, 'invocations');
    shimRegistries.push(registry);
    writeFileSync(join(shimDir, 'git'),
      `#!/bin/sh\necho "$$ $(ps -o pgid= -p $$ | tr -d ' ')" >> "${registry}"\ncase " $* " in *" ${step} "*) ${script};; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(shimDir, 'git'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    return () => {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    };
  }

  it('nothing a timed-out probe step spawned outlives it — async admission step and sync remote probe alike', async () => {
    const review = branchTargetReview('descendants');
    const pidFile = pidFileFor('admission-descendant-', 'descendant.pid');
    const restore = gitShim('ls-remote', `sleep 30 & echo $! > "${pidFile}"; trap '' TERM; exec sleep 10`);
    try {
      // A bound long enough for the wrapper to have spawned its descendant.
      await expect(defaultProbeExec(review.manifest.repoPath, ['ls-remote', 'origin'], 1_500)).rejects.toThrow(/timed out/);
      expect(await stoppedOnItsOwn(pidFile)).toBe(true);
      expect(sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 1_500 })?.cause).toBe('check-failed');
      expect(await stoppedOnItsOwn(pidFile)).toBe(true);
    } finally {
      restore();
    }
  });

  it('nothing a SUCCESSFUL probe step spawned outlives it either — async admission and sync movement alike', async () => {
    const review = branchTargetReview('descendants-ok');
    const pidFile = pidFileFor('admission-descendant-ok-', 'descendant.pid');
    // Starts a background child that lets go of the output, then falls
    // through to the real git: a natural end, so the answer stands.
    const restore = gitShim('ls-remote', `sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"`);
    try {
      expect(await probeAdvertisedTipMovementAsync(review, 5_000, { evidence: NO_SUSPEND })).toBeNull();
      expect(await stoppedOnItsOwn(pidFile)).toBe(true);
      expect(sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 5_000 })).toBeNull();
      expect(await stoppedOnItsOwn(pidFile)).toBe(true);
    } finally {
      restore();
    }
  });

  it('the synchronous probe kills its group when the wrapper floods its output; a runner cut off by the outer guard leaves a group it can no longer prove its own — refused, never signalled (R6-2, R8-6)', async () => {
    const review = branchTargetReview('flood');
    const pidFile = pidFileFor('admission-flood-', 'descendant.pid');
    let restore = gitShim('ls-remote', `sleep 30 & echo $! > "${pidFile}"; head -c 3000000 /dev/zero; exec sleep 10`);
    try {
      // The runner's own bound fires — not the outer buffer guard.
      expect(sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 5_000 })).toMatchObject({
        cause: 'check-failed',
        detail: expect.stringContaining('printed more than'),
      });
      expect(await stoppedOnItsOwn(pidFile)).toBe(true);
    } finally {
      restore();
    }
    const wrapperFile = pidFileFor('admission-flood-wrapper-', 'wrapper.pid');
    restore = gitShim('ls-remote', `echo $$ > "${wrapperFile}"; sleep 30 & echo $! > "${pidFile}"; exec sleep 20`);
    try {
      // The outer guard cuts the runner off mid-step: spawnSync reaps it, so
      // its group id is no longer provably ours — observed, refused, and
      // left for the operator the escalation names.
      expect(() => runOwnedGitSync(review.manifest.repoPath, ['ls-remote', 'origin'], 10_000, 1_500))
        .toThrow(/cleanup unconfirmed: process group \d+ still running — git ls-remote origin did not stop after SIGKILL \(runner ended\)/);
      expect(await stoppedOnItsOwn(pidFile)).toBe(false);
      expect(await stoppedOnItsOwn(wrapperFile)).toBe(false);
    } finally {
      restore();
    }
  });

  it('a step whose output pipe a process outside its group still holds is incomplete — never an answer', async () => {
    const review = branchTargetReview('held-pipe');
    const pidFile = pidFileFor('admission-held-pipe-', 'escaped.pid');
    // Prints part of an answer, leaves an escaped (own-session) child holding stdout, exits 0.
    const escape = `"${process.execPath}" -e "const c = require('node:child_process').spawn('/bin/sleep', ['30'], { detached: true, stdio: 'inherit' }); require('node:fs').writeFileSync('${pidFile}', String(c.pid)); c.unref()"`;
    let restore = gitShim('rev-parse', `${escape}; printf 'refs/remotes/orig'; exit 0`);
    try {
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, { evidence: NO_SUSPEND });
      expect(movement?.cause).toBe('check-failed');
      expect(movement?.detail).toContain('incomplete');
    } finally {
      restore();
      await stoppedOnItsOwn(pidFile);
    }
    restore = gitShim('ls-remote', `${escape}; printf '0000'; exit 0`);
    try {
      expect(sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 5_000 })).toMatchObject({ cause: 'check-failed', detail: expect.stringContaining('incomplete') });
    } finally {
      restore();
      await stoppedOnItsOwn(pidFile);
    }
  });

  it('a helper that detaches into its own session and lets go of the output is outside the contract — left alone, the answer stands', async () => {
    const review = branchTargetReview('detached-daemon');
    const pidFile = pidFileFor('admission-daemon-', 'daemon.pid');
    // Like ssh ControlPersist: a detached child with its stdio closed, then the real git.
    const daemon = `"${process.execPath}" -e "const c = require('node:child_process').spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync('${pidFile}', String(c.pid)); c.unref()"`;
    const restore = gitShim('ls-remote', daemon);
    try {
      expect(await probeAdvertisedTipMovementAsync(review, 5_000, { evidence: NO_SUSPEND })).toBeNull();
      expect(processRunning(Number(readFileSync(pidFile, 'utf8').trim()))).toBe(true); // out of scope by contract
    } finally {
      restore();
      await stoppedOnItsOwn(pidFile);
    }
  });

  it('a diagnostic that merely CONTAINS the refusal words is operational — async and sync alike', async () => {
    const review = branchTargetReview('misleading');
    const misleading = "fatal: cannot change to '/nonexistent-gru-r5/is not a valid branch name': No such file or directory";
    const scripted = async (_repo: string, args: readonly string[]): Promise<string> => {
      if (args[0] === 'check-ref-format') throw Object.assign(new Error(misleading), { code: 128, stderr: misleading });
      return '';
    };
    expect((await probeAdvertisedTipMovementAsync(review, 5_000, { now: () => 0, exec: scripted, evidence: NO_SUSPEND }))?.cause).toBe('check-failed');
    const unavailable = { ...review, manifest: { ...review.manifest, repoPath: '/nonexistent-gru-r5/is not a valid branch name' } };
    expect((await probeAdvertisedTipMovementAsync(unavailable, 5_000, { evidence: NO_SUSPEND }))?.cause).toBe('check-failed');
    const restore = gitShim('check-ref-format', `echo "${misleading}" >&2; exit 128`);
    try {
      expect(sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 5_000 })?.cause).toBe('check-failed');
    } finally {
      restore();
    }
  });

  it('a refusal line embedded in a longer, multiline diagnostic is operational — async and sync alike (R6-1)', async () => {
    const review = branchTargetReview('multiline');
    const name = review.manifest.targetRef;
    const embedded = `fatal: cannot change to '/nonexistent-gru-r6\nfatal: '${name}' is not a valid branch name\n': No such file or directory\n`;
    const scripted = async (_repo: string, args: readonly string[]): Promise<string> => {
      if (args[0] === 'check-ref-format') throw Object.assign(new Error(embedded), { code: 128, stderr: embedded });
      return '';
    };
    expect((await probeAdvertisedTipMovementAsync(review, 5_000, { now: () => 0, exec: scripted, evidence: NO_SUSPEND }))?.cause).toBe('check-failed');
    // Real git, with a repository path that embeds the refusal line.
    const unavailable = { ...review, manifest: { ...review.manifest, repoPath: `/nonexistent-gru-r6\nfatal: '${name}' is not a valid branch name\n` } };
    expect((await probeAdvertisedTipMovementAsync(unavailable, 5_000, { evidence: NO_SUSPEND }))?.cause).toBe('check-failed');
    const restore = gitShim('check-ref-format', `printf "fatal: cannot change to '/x\\nfatal: '%s' is not a valid branch name\\n': No such file or directory\\n" "${name}" >&2; exit 128`);
    try {
      expect(sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 5_000 })?.cause).toBe('check-failed');
    } finally {
      restore();
    }
  });

  it('git exiting with its output still open is never waited out — a same-group writer, fast or slow, makes the answer incomplete and is killed with the group (R8-1)', async () => {
    const review = branchTargetReview('late-writer');
    const repo = review.manifest.repoPath;
    for (const delay of ['0.2', '2']) {
      const writerFile = pidFileFor('admission-late-writer-', `writer-${delay}.pid`);
      // git exits 0 after printing a prefix; a same-group child would print the rest.
      const restore = gitShim('rev-parse', `printf 'refs/remotes/orig'; (sleep ${delay}; printf 'in/feature/late-writer\\n') & echo $! > "${writerFile}"; exit 0`);
      try {
        await expect(defaultProbeExec(repo, ['rev-parse', 'x'], 5_000), delay).rejects.toThrow(/output was still held open — the answer is incomplete/);
        expect(await stoppedOnItsOwn(writerFile), delay).toBe(true);
        expect(() => runOwnedGitSync(repo, ['rev-parse', 'x'], 5_000), delay).toThrow(/the answer is incomplete/);
        expect(await stoppedOnItsOwn(writerFile), delay).toBe(true);
      } finally {
        restore();
      }
    }
  });

  it('the Linux baseline read is charged to the first budget: two slow reads and a failed probe stay inside budget + allowance (R6-4)', async () => {
    const review = branchTargetReview('linux-baseline');
    let t = 0;
    let reads = 0;
    const budgets: number[] = [];
    const movement = await probeAdvertisedTipMovementAsync(review, 5_000, {
      now: () => t,
      exec: async (_repo, _args, timeoutMs) => {
        budgets.push(timeoutMs);
        t += timeoutMs; // the step uses all it is given, then fails
        throw new Error('fatal: the remote end hung up unexpectedly');
      },
      evidence: {
        platform: 'linux',
        wallNow: () => WALL0,
        kernWaketime: async () => {
          throw new Error('not macOS');
        },
        procUptime: async () => {
          reads += 1;
          t += 999; // each read is slow, inside its allowance
          return reads === 1 ? '500.00 0.00\n' : '501.00 0.00\n';
        },
      },
    });
    expect(movement?.cause).toBe('check-failed');
    expect(reads).toBe(2);
    expect(budgets).toEqual([5_000 - 999]);
    expect(t).toBeLessThanOrEqual(5_000 + SUSPEND_EVIDENCE_ALLOWANCE_MS);
  });

  it('a killed step whose group never stops is refused within its bound naming the group, earns no retry, and blocks nothing after it (R6-5, owner decision 2026-10-08)', async () => {
    const review = branchTargetReview('unkillable');
    const countFile = join(temp('admission-unkillable-'), 'ls-remote.count');
    const stuckFile = join(temp('admission-unkillable-groups-'), 'groups');
    const count = (): number => readFileSync(countFile, 'utf8').trim().split('\n').length;
    const restore = gitShim('ls-remote', `ps -o pgid= -p $$ | tr -d ' ' >> "${stuckFile}"; echo run >> "${countFile}"; exec sleep 10`);
    // Uninterruptible I/O, simulated: the ls-remote groups are never
    // confirmed gone; every other group is read for real.
    const stuck = (pgid: number): boolean => existsSync(stuckFile) && readFileSync(stuckFile, 'utf8').split('\n').includes(String(pgid));
    const realSync = OWNED_GIT_SEAMS.groupHasLiveMember;
    const realAsync = OWNED_GIT_SEAMS.groupHasLiveMemberAsync;
    const sync = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMember').mockImplementation((pgid, budget) => stuck(pgid) || realSync(pgid, budget));
    const async = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMemberAsync').mockImplementation(async (pgid, budget) => stuck(pgid) || realAsync(pgid, budget));
    try {
      const started = performance.now();
      // OS evidence says the host slept, which would otherwise earn one retry.
      const movement = await probeAdvertisedTipMovementAsync(review, 1_500, { evidence: macWake(30_000) });
      expect(movement).toMatchObject({ cause: 'check-failed', cleanupUnconfirmed: true });
      expect(movement!.detail).toMatch(/^cleanup unconfirmed: process group \d+ still running — git ls-remote .* did not stop after SIGKILL \(timeout\)/u);
      expect(movement).not.toHaveProperty('stopped');
      expect(performance.now() - started).toBeLessThan(1_500 + 1_000 + 1_500);
      expect(count()).toBe(1);
      // No quarantine: the next step in the same repository runs — and is
      // refused on its own account, again within its bound.
      const syncStarted = performance.now();
      expect(() => runOwnedGitSync(review.manifest.repoPath, ['ls-remote', 'origin'], 300))
        .toThrow(/cleanup unconfirmed: process group \d+ still running — git ls-remote origin did not stop after SIGKILL \(timeout\)/);
      expect(performance.now() - syncStarted).toBeLessThan(300 + 1_000 + 2_000);
      expect(count()).toBe(2);
      await expect(defaultProbeExec(review.manifest.repoPath, ['rev-parse', 'HEAD'], 5_000)).resolves.toMatch(/^[0-9a-f]{40}/u);
    } finally {
      sync.mockRestore();
      async.mockRestore();
      restore();
    }
    // Admission keeps a cleanup veto from EITHER probe (R7-6), and retries
    // only a failure that proved its git stopped (R7-7).
    const headBinding = (movement: SourceMovement) => admissionPreflight(review, review.manifest.targetRef, { precomputedRemoteMovement: movement })
      .missing.find((entry) => entry.input === 'head-binding');
    expect(headBinding({ cause: 'check-failed', detail: 'git ls-remote did not stop', cleanupUnconfirmed: true })).not.toHaveProperty('retryable');
    expect(headBinding({ cause: 'check-failed', detail: 'fatal: the remote end hung up unexpectedly' })).not.toHaveProperty('retryable');
    expect(headBinding({ cause: 'check-failed', detail: 'fatal: the remote end hung up unexpectedly', stopped: true })).toMatchObject({ retryable: true });
  });

  it('a local failure never erases the remote cleanup veto — the stuck group is what the refusal names — and an owned local failure proves its helper gone (R7-6, R7-7)', async () => {
    const review = branchTargetReview('local-veto');
    const helperFile = pidFileFor('admission-local-helper-', 'helper.pid');
    // `git status` fails and leaves a same-group helper running.
    const restore = gitShim('status', `sleep 30 >/dev/null 2>&1 & echo $! > "${helperFile}"; echo "fatal: index file locked" >&2; exit 128`);
    try {
      const transient = admissionPreflight(review, review.manifest.targetRef, { precomputedRemoteMovement: null })
        .missing.find((entry) => entry.input === 'head-binding');
      expect(transient).toMatchObject({ detail: expect.stringContaining('check-failed'), retryable: true });
      expect(await stoppedOnItsOwn(helperFile)).toBe(true); // the owned step took its helper down
      const vetoed = admissionPreflight(review, review.manifest.targetRef, {
        precomputedRemoteMovement: { cause: 'check-failed', detail: 'cleanup unconfirmed: process group 4242 still running — git ls-remote did not stop', cleanupUnconfirmed: true },
      }).missing.find((entry) => entry.input === 'head-binding');
      expect(vetoed?.detail).toContain('process group 4242 still running'); // the stuck group leads the refusal...
      expect(vetoed).not.toHaveProperty('retryable'); // ...and is never retried
    } finally {
      restore();
    }
  });

  it('a group of zombies is not executing, but membership that cannot be read completely always is (R7-9, R8-3)', async () => {
    // `sh` forks a short child and execs into `sleep`, which never reaps it.
    const child = spawn('/bin/sh', ['-c', 'sleep 0.1 & exec sleep 30'], { detached: true, stdio: 'ignore' });
    const pgid = child.pid!;
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(groupHasLiveMember(pgid, 1_000)).toBe(true); // `sleep 30` executes
    } finally {
      process.kill(-pgid, 'SIGKILL');
    }
    expect(groupHasLiveMember(0, 1_000)).toBe(false);
    expect(groupHasLiveMember(-1, 1_000)).toBe(false);
    // ps listings: zombies alone are not executing; an unreadable line is unknown, so executing.
    expect(executingMember(psGroupMembers('  10    10 S\n  11    10 Z+\n  12    99 R\n', 10))).toBe(true);
    expect(executingMember(psGroupMembers('  11    10 Z\n  12    99 R\n', 10))).toBe(false);
    expect(psGroupMembers('  11    10 Z\ngarbage\n', 10)).toBeNull();
    expect(executingMember(null)).toBe(true);
    // /proc: only a process that ENDED while listed may be skipped (R8-3).
    const stat = (state: string, group: number) => `1 (git) ${state} 1 ${group} ${group} 0 -1`;
    const proc = (files: Record<string, string | NodeJS.ErrnoException>) => ({
      list: () => Object.keys(files),
      read: (path: string) => {
        const entry = files[path.split('/')[2]!]!;
        if (typeof entry !== 'string') throw entry;
        return entry;
      },
    });
    const errno = (code: string) => Object.assign(new Error(code), { code });
    expect(procGroupMembers(10, proc({ 20: stat('S', 10), 21: errno('ENOENT'), 22: stat('R', 99) }))).toEqual([{ pid: 20, state: 'S' }]);
    expect(procGroupMembers(10, proc({ 20: stat('Z', 10), 21: errno('EACCES') }))).toBeNull(); // a denied entry might be a live member
    expect(procGroupMembers(10, proc({ 20: stat('Z', 10), 21: 'malformed' }))).toBeNull();
    expect(executingMember(procGroupMembers(10, proc({ 20: stat('Z', 10), 21: errno('EACCES') })))).toBe(true);
    expect(executingMember(procGroupMembers(10, proc({ 20: stat('Z', 10), 21: errno('ESRCH') })))).toBe(false);
  });

  it('a runner that cannot be spawned never signals group 0 — the caller’s own group (R7-1)', () => {
    const review = branchTargetReview('no-runner');
    const realKill = process.kill.bind(process);
    const signalled: number[] = [];
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      signalled.push(pid);
      return pid === 0 ? true : realKill(pid, signal); // never let a regression kill this worker's group
    }) as typeof process.kill);
    const realExec = process.execPath;
    process.execPath = join(temp('admission-no-node-'), 'node-missing');
    try {
      expect(() => runOwnedGitSync(review.manifest.repoPath, ['rev-parse', 'HEAD'], 1_000)).toThrow(/the probe runner could not be started/);
    } finally {
      process.execPath = realExec;
      kill.mockRestore();
    }
    expect(signalled.filter((pid) => pid === 0 || Object.is(pid, -0))).toEqual([]);
  });

  it('a refusal line followed by a diagnostic cut at its bound is not a refusal — async and sync alike (R7-2)', async () => {
    const review = branchTargetReview('truncated');
    const name = review.manifest.targetRef;
    // The exact refusal line, then (as a separate write) a long operational tail.
    const restore = gitShim('check-ref-format', `printf "fatal: '%s' is not a valid branch name\\n" "${name}" >&2; sleep 0.2; head -c 70000 /dev/zero | tr '\\0' x >&2; exit 128`);
    try {
      expect((await probeAdvertisedTipMovementAsync(review, 5_000, { evidence: NO_SUSPEND }))?.cause).toBe('check-failed');
      expect(sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 5_000 })?.cause).toBe('check-failed');
    } finally {
      restore();
    }
  });

  it('output a detached helper finishes after git exits is never an answer — the helper is left alone (R7-3)', async () => {
    const review = branchTargetReview('detached-writer');
    const repo = review.manifest.repoPath;
    const helperFile = pidFileFor('admission-detached-writer-', 'helper.pid');
    // git prints a prefix and exits 0; a helper in its OWN session prints the rest 100 ms later.
    const writer = `"${process.execPath}" -e "const c = require('node:child_process').spawn('/bin/sh', ['-c', 'sleep 0.1; printf in/feature/detached-writer'], { detached: true, stdio: 'inherit' }); require('node:fs').writeFileSync('${helperFile}', String(c.pid)); c.unref()"`;
    const restore = gitShim('rev-parse', `printf 'refs/remotes/orig'; ${writer}; exit 0`);
    try {
      await expect(defaultProbeExec(repo, ['rev-parse', 'x'], 5_000)).rejects.toThrow(/output was still held open — the answer is incomplete/);
      expect(() => runOwnedGitSync(repo, ['rev-parse', 'x'], 5_000)).toThrow(/the answer is incomplete/);
      expect((await probeAdvertisedTipMovementAsync(review, 5_000, { evidence: NO_SUSPEND }))?.cause).toBe('check-failed');
    } finally {
      restore();
    }
  });

  it('the sync runner’s report lives in a private 0700 directory, removed afterwards (R7-4)', () => {
    const review = branchTargetReview('private-report');
    const modes = join(temp('admission-report-modes-'), 'modes');
    const stat = process.platform === 'darwin' ? 'stat -f %Lp' : 'stat -c %a';
    // While git runs, record THIS runner's report directory (its parent's
    // argument) and that directory's mode.
    const restore = gitShim('rev-parse', `d=$(dirname "$(ps -ww -o args= -p $PPID | tr ' ' '\\n' | grep '/gru-probe-' | head -1)"); echo "$d $(${stat} "$d")" >> "${modes}"`);
    try {
      expect(runOwnedGitSync(review.manifest.repoPath, ['rev-parse', 'HEAD'], 5_000)).toMatch(/^[0-9a-f]{40}/u);
    } finally {
      restore();
    }
    const seen = readFileSync(modes, 'utf8').trim().split('\n').map((line) => line.split(' '));
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toContain('gru-probe-');
    expect(seen[0]![1]).toBe('700');
    for (const [dir] of seen) expect(existsSync(dir!), dir).toBe(false); // removed once the step settled
  });

  it('every outcome — success included — settles only once the whole group is confirmed gone (R7-5)', async () => {
    const review = branchTargetReview('settle-success');
    const sync = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMember').mockReturnValue(true);
    const async = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMemberAsync').mockResolvedValue(true);
    try {
      await expect(defaultProbeExec(review.manifest.repoPath, ['rev-parse', 'HEAD'], 5_000))
        .rejects.toThrow(/cleanup unconfirmed: process group \d+ still running — git rev-parse HEAD did not stop after SIGKILL \(ok\)/);
      expect(() => runOwnedGitSync(branchTargetReview('settle-success-sync').manifest.repoPath, ['rev-parse', 'HEAD'], 5_000))
        .toThrow(/cleanup unconfirmed: process group \d+ still running — git rev-parse HEAD did not stop after SIGKILL \(ok\)/);
    } finally {
      sync.mockRestore();
      async.mockRestore();
    }
  });

  it('cessation is observed within ONE settle deadline — every inspection gets only what is left, and the async side never blocks the event loop (R8-4)', async () => {
    const review = branchTargetReview('settle-budget');
    const budgets: number[] = [];
    // A slow inspection (a stalled ps): each takes what it is given, up to 300 ms.
    const async = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMemberAsync').mockImplementation(async (_pgid, budget) => {
      budgets.push(budget);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(budget, 300))));
      return true;
    });
    let gap = 0;
    let last = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      gap = Math.max(gap, now - last);
      last = now;
    }, 10);
    try {
      const started = performance.now();
      await expect(defaultProbeExec(review.manifest.repoPath, ['rev-parse', 'HEAD'], 5_000)).rejects.toThrow(/cleanup unconfirmed/);
      const settled = performance.now() - started;
      expect(budgets.length).toBeGreaterThan(1);
      expect(budgets.every((budget, index) => budget <= 1_000 && (index === 0 || budget < budgets[index - 1]!))).toBe(true);
      expect(settled).toBeLessThan(1_000 + 300 + 1_000); // the step itself, plus one inspection past the deadline
      expect(gap).toBeLessThan(200); // never blocked
    } finally {
      clearInterval(heartbeat);
      async.mockRestore();
    }
    const syncBudgets: number[] = [];
    const sync = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMember').mockImplementation((_pgid, budget) => {
      syncBudgets.push(budget);
      const until = performance.now() + Math.max(0, Math.min(budget, 300));
      while (performance.now() < until) { /* a stalled ps */ }
      return true;
    });
    try {
      const started = performance.now();
      expect(() => runOwnedGitSync(review.manifest.repoPath, ['rev-parse', 'HEAD'], 5_000)).toThrow(/cleanup unconfirmed/);
      expect(syncBudgets.every((budget, index) => budget <= 1_000 && (index === 0 || budget < syncBudgets[index - 1]!))).toBe(true);
      expect(performance.now() - started).toBeLessThan(1_000 + 300 + 1_500);
    } finally {
      sync.mockRestore();
    }
  });

  it('once its runner — the group anchor — is gone, the group is only observed, never signalled: a reused group id is never hit (R8-6)', async () => {
    const review = branchTargetReview('anchor');
    const realKill = process.kill.bind(process);
    const signals: { target: number; signal: string | number | undefined }[] = [];
    const kill = vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
      signals.push({ target, signal });
      return realKill(target, signal);
    }) as typeof process.kill);
    // The group looks alive after the runner ended (a reused id would too).
    const sync = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMember').mockReturnValue(true);
    const async = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMemberAsync').mockResolvedValue(true);
    try {
      expect(() => runOwnedGitSync(review.manifest.repoPath, ['rev-parse', 'HEAD'], 5_000)).toThrow(/cleanup unconfirmed/);
      await expect(runOwnedGit(review.manifest.repoPath, ['rev-parse', 'HEAD'], 5_000)).rejects.toThrow(/cleanup unconfirmed/);
    } finally {
      kill.mockRestore();
      sync.mockRestore();
      async.mockRestore();
    }
    // Only the runner signals its own group, while it is alive; this
    // process sends nothing destructive to any group.
    expect(signals.filter((entry) => entry.target < 0 && entry.signal !== 0)).toEqual([]);
  });

  it('base and target resolution: only git’s own "no such commit" is movement; a timeout, spawn or I/O failure is a check failure, retryable once proven stopped (R8-11)', () => {
    const review = branchTargetReview('resolution');
    const { baseRef, targetRef } = review.manifest;
    const local = (shimmed: string, script: string) => {
      const restore = gitShim('rev-parse', `case " $* " in *" ${shimmed}^{commit} "*) ${script};; esac`);
      try {
        return admissionPreflight(review, review.manifest.targetRef, { precomputedRemoteMovement: null })
          .missing.find((entry) => entry.input === 'head-binding');
      } finally {
        restore();
      }
    };
    for (const ref of [baseRef, targetRef]) {
      expect(local(ref, 'echo "fatal: unable to read 0123abcd: Input/output error" >&2; exit 128'), ref)
        .toMatchObject({ detail: expect.stringContaining('check-failed: fatal: unable to read'), retryable: true });
      expect(local(ref, 'echo "fatal: Needed a single revision" >&2; exit 128'), ref).not.toHaveProperty('retryable');
    }
    expect(local(baseRef, 'echo "fatal: Needed a single revision" >&2; exit 128')?.detail).toContain('base-unresolvable');
    expect(local(targetRef, 'echo "fatal: Needed a single revision" >&2; exit 128')?.detail).toContain('target-moved');
    expect(refUnresolved(Object.assign(new Error('x'), { status: 128, stderr: 'fatal: Needed a single revision\n' }))).toBe(true);
    expect(refUnresolved(Object.assign(new Error('x'), { status: 128, stderr: 'fatal: Needed a single revision\n', stderrTruncated: true }))).toBe(false);
    expect(refUnresolved(Object.assign(new Error('timed out'), { killed: true }))).toBe(false);
  });

  it('git runs in the repository it was given — an inherited GIT_DIR or GIT_WORK_TREE never routes a step elsewhere (R8-22)', async () => {
    const review = branchTargetReview('routed');
    const other = makeFixtureRepo('admission-routed-other');
    repos.push(other);
    other.commitFile('elsewhere.txt', 'another repository\n');
    const ours = execFileSync('git', ['-C', review.manifest.repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const theirs = execFileSync('git', ['-C', other.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(theirs).not.toBe(ours);
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other.path, '.git');
    process.env.GIT_WORK_TREE = other.path;
    try {
      expect(runOwnedGitSync(review.manifest.repoPath, ['rev-parse', 'HEAD'], 5_000).trim()).toBe(ours);
      expect((await runOwnedGit(review.manifest.repoPath, ['rev-parse', 'HEAD'], 5_000)).trim()).toBe(ours);
      // The plain (submission-gate) movement check and the admission alike.
      expect(sourceMovementSinceFreeze(review, { skipRemoteProbe: true })).toBeNull();
      expect(admissionPreflight(review, review.manifest.targetRef, { precomputedRemoteMovement: null })
        .missing.find((entry) => entry.input === 'head-binding')).toBeUndefined();
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.tree;
    }
  });

  it('the shim reaper knows its own process group or refuses to run, and never signals that group (R8-23)', () => {
    expect(() => discoverOwnGroup(() => ({ status: 1, stdout: '' }))).toThrow(/cannot establish this worker's process group/);
    expect(() => discoverOwnGroup(() => ({ status: 0, stdout: '\n' }))).toThrow(/cannot establish/);
    expect(() => discoverOwnGroup(() => ({ status: 0, stdout: '0\n' }))).toThrow(/cannot establish/);
    expect(discoverOwnGroup(() => ({ status: 0, stdout: ' 4242\n' }))).toBe(4242);
    expect(() => reapShimRegistries([], 0)).toThrow(/unknown own group/);
    const registry = join(temp('admission-reaper-'), 'invocations');
    // A shim that ran in THIS group (a plain, non-owned step) and one in its own.
    writeFileSync(registry, `111 ${ownGroup}\n222 333\n`);
    const sent: number[] = [];
    const left = reapShimRegistries([registry], ownGroup, {
      kill: (target) => {
        sent.push(target);
      },
      exists: () => false,
      sleep: () => {},
    });
    expect(left).toEqual([]);
    expect(sent.sort((a, b) => a - b)).toEqual([-333, 111, 222]);
    expect(sent).not.toContain(-ownGroup);
  });

  it('a fixture that fails early is still reaped — wrapper, group and same-group helper proven stopped before its registry goes (R7-19, R8-20)', async () => {
    const dir = temp('admission-early-failure-');
    const registry = join(dir, 'invocations');
    const helperFile = join(dir, 'helper.pid');
    // A wrapper in its own group (like a runner's git), NOT this process's
    // child, registers itself and leaves a same-group helper running...
    const script = `echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" >> "${registry}"; sleep 30 & echo $! > "${helperFile}"; exec sleep 30`;
    spawnSync(process.execPath, ['-e', `require('node:child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(script)}], { detached: true, stdio: 'ignore' }).unref()`]);
    for (let attempt = 0; attempt < 100 && !existsSync(helperFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const [wrapper, group] = readFileSync(registry, 'utf8').trim().split(/\s+/u).map(Number);
    const helper = Number(readFileSync(helperFile, 'utf8').trim());
    const present = (target: number): boolean => {
      try {
        process.kill(target, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect([wrapper!, helper, -group!].every(present)).toBe(true);
    // ...then the test fails at its first assertion; the reaper still runs.
    expect(() => expect('early assertion').toBe('never reached')).toThrow();
    expect(reapShimRegistries([registry], ownGroup)).toEqual([]);
    expect(existsSync(registry)).toBe(true); // the marker outlives the proof
    expect([wrapper!, helper, -group!].filter(present)).toEqual([]);
  });

  it('a timed-out step leaves no timer behind, and the sync probe returns at its own bound (R6-6)', async () => {
    const review = branchTargetReview('timer-leak');
    const restore = gitShim('ls-remote', 'exec sleep 10');
    const timers = (): number => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    try {
      const before = timers();
      await expect(defaultProbeExec(review.manifest.repoPath, ['ls-remote', 'origin'], 250)).rejects.toThrow(/timed out after 250 ms/);
      await new Promise((resolve) => setTimeout(resolve, 50)); // let a late 'exit' land
      expect(timers()).toBeLessThanOrEqual(before);
      const started = performance.now();
      expect(() => runOwnedGitSync(review.manifest.repoPath, ['ls-remote', 'origin'], 300)).toThrow(/timed out after 300 ms/);
      // Far below the outer guard (5.8 s) and the stalled git (10 s).
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      restore();
    }
  });

  it('an async step that floods its output is refused even when it leads with the right tip, and its group stops (R6-8)', async () => {
    const review = branchTargetReview('async-flood');
    const pidFile = pidFileFor('admission-async-flood-', 'descendant.pid');
    const restore = gitShim('ls-remote',
      `sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"; printf '%s\\trefs/heads/feature/async-flood\\n' "${review.manifest.targetSha}"; head -c 3000000 /dev/zero; exit 0`);
    try {
      expect(await probeAdvertisedTipMovementAsync(review, 5_000, { evidence: NO_SUSPEND })).toMatchObject({
        cause: 'check-failed',
        detail: expect.stringContaining('printed more than'),
      });
      expect(await stoppedOnItsOwn(pidFile)).toBe(true);
    } finally {
      restore();
    }
  });

  it('a qualified tracking ref: an operational check-ref-format failure fails closed; only exit 1 is a refusal', async () => {
    const review = branchTargetReview('qualified', { qualified: true });
    const movementRef = review.manifest.targetRef;
    expect(movementRef).toBe('refs/remotes/origin/feature/qualified');
    const scripted = (failure: Error) => async (_repo: string, args: readonly string[]): Promise<string> => {
      if (args[0] === 'check-ref-format') throw failure;
      if (args[0] === 'remote') return 'origin\n';
      if (args[0] === 'ls-remote') return `${review.manifest.targetSha}\trefs/heads/feature/qualified\n`;
      return '';
    };
    const operational = Object.assign(new Error('fatal: not a git repository'), { code: 128, stderr: 'fatal: not a git repository' });
    const movement = await probeAdvertisedTipMovementAsync(review, 5_000, { now: () => 0, exec: scripted(operational), evidence: NO_SUSPEND });
    expect(movement?.cause).toBe('check-failed');
    const preflight = admissionPreflight(review, movementRef, { precomputedRemoteMovement: movement });
    expect(preflight.checks.find((check) => check.name === 'head-binding')?.ok).toBe(false);
    const refused = Object.assign(new Error(''), { code: 1, stderr: '' });
    expect(await probeAdvertisedTipMovementAsync(review, 5_000, { now: () => 0, exec: scripted(refused), evidence: NO_SUSPEND })).toBeNull();
    const restore = gitShim('check-ref-format', 'echo "fatal: not a git repository" >&2; exit 128');
    try {
      expect(sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 5_000 })?.cause).toBe('check-failed');
    } finally {
      restore();
    }
  });

  it('Linux suspend evidence must arrive inside the allowance too', async () => {
    const review = branchTargetReview('linux-allowance');
    for (const [delay, retry] of [[999, true], [1_000, false], [1_200, false]] as const) {
      let t = 0;
      let reads = 0;
      const git = scriptedGit(review.manifest.targetSha, (_args, call) => {
        if (call === 1) throw new Error('fatal: the remote end hung up unexpectedly');
      });
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, {
        now: () => t,
        exec: git.exec,
        evidence: {
          platform: 'linux',
          wallNow: () => WALL0,
          kernWaketime: async () => {
            throw new Error('not macOS');
          },
          procUptime: async () => {
            reads += 1;
            if (reads === 1) return '500.00 0.00\n';
            t += delay; // the wake-time read is slow
            return '560.00 0.00\n';
          },
        },
      });
      expect({ delay, admitted: movement === null }).toEqual({ delay, admitted: retry });
    }
  });

  it('a failed probe waits at most the separate evidence allowance for a stalled evidence read, then refuses', async () => {
    const review = branchTargetReview('evidence-stall');
    let t = 0;
    const git = scriptedGit(review.manifest.targetSha, (_args, call) => {
      if (call === 1) t += 60_000;
    });
    const asked: number[] = [];
    const startedAt = performance.now();
    const movement = await probeAdvertisedTipMovementAsync(review, 5_000, {
      now: () => t,
      exec: git.exec,
      evidence: {
        ...macWake(30_000),
        kernWaketime: (timeoutMs) => {
          asked.push(timeoutMs);
          return new Promise<string>(() => {}); // never answers
        },
      },
    });
    const elapsed = performance.now() - startedAt;
    expect(movement?.cause).toBe('check-failed');
    expect(git.calls).toEqual(['check-ref-format']);
    expect(asked).toEqual([SUSPEND_EVIDENCE_ALLOWANCE_MS]);
    expect(elapsed).toBeGreaterThanOrEqual(SUSPEND_EVIDENCE_ALLOWANCE_MS - 50);
    expect(elapsed).toBeLessThan(SUSPEND_EVIDENCE_ALLOWANCE_MS + 1_500);
  });

  it.skipIf(process.platform !== 'darwin')('reads the real kernel wake by absolute path, even when PATH lacks /usr/sbin', async () => {
    const review = branchTargetReview('sysctl-path');
    let t = 0;
    const git = scriptedGit(review.manifest.targetSha, (_args, call) => {
      if (call === 1) t += 60_000;
    });
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      // The probe "started" at the epoch, so the machine's real last wake
      // is positive evidence — if, and only if, sysctl can be run.
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, {
        now: () => t,
        exec: git.exec,
        evidence: {
          platform: 'darwin',
          wallNow: () => 0,
          kernWaketime: readKernWaketime,
          procUptime: async () => {
            throw new Error('ENOENT: /proc/uptime');
          },
        },
      });
      expect(movement).toBeNull();
      expect(git.calls.filter((call) => call === 'check-ref-format')).toHaveLength(2);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('a git that ignores SIGTERM still ends at its bound — async admission step and sync remote probe alike', async () => {
    const review = branchTargetReview('sigterm-ignored');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = temp('admission-sigterm-shim-');
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\ncase " $* " in *"ls-remote"*) trap '' TERM; exec sleep 4;; esac\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    try {
      let startedAt = performance.now();
      await expect(defaultProbeExec(review.manifest.repoPath, ['ls-remote', 'origin'], 250)).rejects.toThrow();
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      startedAt = performance.now();
      const movement = sourceMovementSinceFreeze(review, { remoteProbeTimeoutMs: 250 });
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      expect(movement?.cause).toBe('check-failed');
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('a git rejection that settles past the deadline is refused, never read as "not a branch"', async () => {
    const review = branchTargetReview('late-rejection');
    for (const late of [true, false]) {
      let t = 0;
      const git = scriptedGit(review.manifest.targetSha, (args, call) => {
        if (call !== 1) return;
        if (late) t = 5_001;
        throw Object.assign(new Error(`fatal: '${String(args.at(-1))}' is not a valid branch name`), { code: 128 });
      });
      const movement = await probeAdvertisedTipMovementAsync(review, 5_000, { now: () => t, exec: git.exec, evidence: NO_SUSPEND });
      expect(git.calls).toEqual(['check-ref-format']);
      if (late) {
        expect(movement?.cause).toBe('check-failed');
        expect(movement?.detail).toContain('budget exhausted after: git check-ref-format');
      } else {
        expect(movement).toBeNull(); // an in-time rejection: not a branch spelling, nothing to probe
      }
    }
  });

  it('reads macOS kernel wake evidence exactly', () => {
    expect(parseKernWaketime('{ sec = 1790944289, usec = 208542 } Fri Oct  2 13:31:29 2026\n')).toBe(1_790_944_289_208);
    expect(parseKernWaketime('sysctl: unknown oid')).toBeNull();
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
