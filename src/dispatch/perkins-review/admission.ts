import { createHash } from 'node:crypto';
import {
  FROZEN_CHANGED_FILES_MAX_BYTES,
  FROZEN_CONVENTIONS_MAX_BYTES,
  FROZEN_DIFF_MAX_BYTES,
  FROZEN_MANIFEST_MAX_BYTES,
  FROZEN_SPEC_MAX_BYTES,
  readReviewCheckpointBytes,
  type FrozenReview,
} from './artifacts.js';
import { CI_EVIDENCE_STATES, type CiEvidenceRecord } from '../../review-inputs/ci-evidence.js';
import { REVIEW_EVIDENCE_MAX_FILE_BYTES } from '../../review-inputs/evidence.js';
import { headMovedSinceFreeze } from './whole.js';

/**
 * Admission preflight (gh-169 Stage 4).
 *
 * One host-owned, read-only gate between the freeze and ANY review spawn.
 * It validates the complete frozen packet from its own bytes — never from
 * live sources — and refuses with ONE exhaustive list of precisely named
 * missing inputs before a lead or specialist child can start. A pass
 * proves the packet the reviewer will read is complete, accessible and
 * still head-bound; a refusal aborts the round without spawn.
 *
 * Missing evidence is never a failure here: the CI check requires the
 * record to EXIST and be well-formed (an explicit UNAVAILABLE record is a
 * pass); it is the display/report layer that keeps missing distinct from
 * failed. Only inaccessible/corrupt/unbound material refuses admission.
 */

/** One failed preflight check: a stable named input plus actionable detail. */
export interface AdmissionMissingInput {
  /** Stable machine-readable input name, e.g. `frozen-packet:diff.patch`. */
  readonly input: string;
  /** Actionable detail naming exactly what is missing/inaccessible. */
  readonly detail: string;
}

/** One executed check (pass or fail); `missing` is the failed subset. */
export interface AdmissionCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string | null;
}

export interface AdmissionPreflightResult {
  readonly checks: readonly AdmissionCheck[];
  readonly missing: readonly AdmissionMissingInput[];
}

/** Typed refusal carrying every named missing input (never just the first). */
export class ReviewAdmissionError extends Error {
  readonly missing: readonly AdmissionMissingInput[];
  constructor(missing: readonly AdmissionMissingInput[]) {
    super(
      `review admission preflight refused: ${missing.length} missing input(s): ` +
      missing.map((entry) => `[${entry.input}] ${entry.detail}`).join('; ').slice(0, 2000),
    );
    this.name = 'ReviewAdmissionError';
    this.missing = missing;
  }
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Collapse an arbitrary error into one bounded, newline-free detail line. */
function sanitizeDetail(value: unknown): string {
  return String(value instanceof Error ? value.message : value).replace(/[\r\n]+/gu, ' ').trim().slice(0, 300);
}

function isCiEvidenceRecord(value: unknown): value is CiEvidenceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['state'] === 'string' && (CI_EVIDENCE_STATES as readonly string[]).includes(record['state']);
}

/**
 * Validate the complete frozen packet. Every check runs (exhaustive), every
 * read is bounded and read-only, and the returned `missing` list names each
 * inaccessible input precisely. An empty `missing` list is the pass.
 */
export function admissionPreflight(review: FrozenReview, movementRef: string): AdmissionPreflightResult {
  const checks: AdmissionCheck[] = [];
  const missing: AdmissionMissingInput[] = [];
  const fail = (input: string, detail: string): void => {
    checks.push({ name: input, ok: false, detail: sanitizeDetail(detail) });
    missing.push({ input, detail: sanitizeDetail(detail) });
  };
  const pass = (name: string): void => {
    checks.push({ name, ok: true, detail: null });
  };
  const readFrozen = (relativePath: string, maxBytes: number): Buffer | Error => {
    try {
      return readReviewCheckpointBytes(review.directory, relativePath, maxBytes);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  // 1. Head binding: the frozen target is still exactly what was frozen
  //    (local ref, advertised remote tip, HEAD and pristine checkout).
  const movement = headMovedSinceFreeze(review, movementRef);
  if (movement === null) pass('head-binding');
  else fail('head-binding', `${movement.cause}: ${movement.detail}`);

  // 2. Frozen packet completeness: every declared artifact is re-read from
  //    the frozen copy and proven byte-identical to its manifest digest.
  const manifestBytes = readFrozen('manifest.json', FROZEN_MANIFEST_MAX_BYTES);
  if (manifestBytes instanceof Error) {
    fail('frozen-packet:manifest.json', `the frozen manifest cannot be read: ${sanitizeDetail(manifestBytes)}`);
  } else {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
      if (JSON.stringify(parsed) !== JSON.stringify(review.manifest)) {
        fail('frozen-packet:manifest.json', 'the frozen manifest on disk does not match the in-memory freeze record');
      } else pass('frozen-packet:manifest.json');
    } catch (error) {
      fail('frozen-packet:manifest.json', `the frozen manifest is not parseable: ${sanitizeDetail(error)}`);
    }
  }

  const declaredFiles = [
    { path: 'diff.patch', digest: review.manifest.diffSha256, bound: FROZEN_DIFF_MAX_BYTES, name: 'frozen-packet:diff.patch' },
    { path: 'spec-context.md', digest: review.manifest.specSha256, bound: FROZEN_SPEC_MAX_BYTES, name: 'frozen-packet:spec-context.md' },
    { path: 'project-conventions.md', digest: review.manifest.conventionsSha256, bound: FROZEN_CONVENTIONS_MAX_BYTES, name: 'frozen-packet:project-conventions.md' },
    { path: 'changed-files.json', digest: review.manifest.changedFilesSha256, bound: FROZEN_CHANGED_FILES_MAX_BYTES, name: 'frozen-packet:changed-files.json' },
  ] as const;
  const fileBytes = new Map<string, Buffer | null>();
  for (const declared of declaredFiles) {
    const bytes = readFrozen(declared.path, declared.bound);
    if (bytes instanceof Error) {
      fail(declared.name, `cannot be read from the frozen packet: ${sanitizeDetail(bytes)}`);
      fileBytes.set(declared.path, null);
    } else if (sha256(bytes) !== declared.digest) {
      fail(declared.name, 'bytes no longer match the digest declared in the frozen manifest');
      fileBytes.set(declared.path, bytes);
    } else {
      pass(declared.name);
      fileBytes.set(declared.path, bytes);
    }
  }

  const specBytes = fileBytes.get('spec-context.md') ?? null;
  const specText = specBytes === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(specBytes);
  if (specText !== null) {
    const supplied = review.manifest.specMode === 'supplied';
    // 3. Spec context truth: the declared mode is what the bytes say, and a
    //    supplied spec carries the prompt-visible CI limitation section.
    if (supplied) {
      if (specText.trim() === '' || specText.trimEnd() === 'EXPLICIT NO-SPEC REVIEW') {
        fail('spec-context', 'spec mode is "supplied" but the frozen spec context is empty or carries the no-spec marker');
      } else if (!specText.includes('--- HOST-RECORDED CI EVIDENCE')) {
        fail('spec-context', 'the supplied spec context carries no HOST-RECORDED CI EVIDENCE section (missing evidence must be explicit, never silent)');
      } else pass('spec-context');
      // 4. Verification evidence: embedded record OR the explicit absence
      //    disclosure — silence is the one shape a supplied spec may not
      //    take (missing ≠ verified, but missing must be visible).
      if (!specText.includes('--- HOST-RECORDED VERIFICATION') || !specText.includes('--- END HOST-RECORDED VERIFICATION ---')) {
        fail('verification-evidence', 'the supplied spec context carries no HOST-RECORDED VERIFICATION section (neither recorded evidence nor its explicit UNAVAILABLE disclosure)');
      } else pass('verification-evidence');
    } else {
      if (specText.trimEnd() !== 'EXPLICIT NO-SPEC REVIEW') {
        fail('spec-context', 'spec mode is "explicit-no-spec" but the frozen spec context carries spec bytes');
      } else pass('spec-context');
      pass('verification-evidence');
    }
  } else {
    // The spec file itself already failed; its derived sections cannot be
    // checked — record the dependent checks as failed with the dependency
    // named so the refusal stays exhaustive and precise.
    fail('spec-context', 'not checkable: the frozen spec-context.md is missing or corrupt');
    fail('verification-evidence', 'not checkable: the frozen spec-context.md is missing or corrupt');
  }

  // 5. Exact-target CI record: present and well-formed. An explicit
  //    UNAVAILABLE/NOT-MATCHED record PASSES (missing evidence is a
  //    disclosed limitation, never an admission failure); a bound
  //    green/pending/failed record must name the frozen head.
  const ciRecord: unknown = review.manifest.reviewEvidence?.ci ?? null;
  if (ciRecord === null) {
    fail('ci-evidence', 'no exact-target CI record froze with the packet; arm the review through the supported review-inputs handoff so the CI state (or its explicit UNAVAILABLE limitation) is frozen and visible');
  } else if (!isCiEvidenceRecord(ciRecord)) {
    fail('ci-evidence', 'the frozen CI record is malformed (unknown state)');
  } else if (ciRecord.state === 'green' || ciRecord.state === 'pending' || ciRecord.state === 'failed') {
    if (ciRecord.sha !== review.manifest.targetSha) {
      fail('ci-evidence', `the bound CI record names sha ${ciRecord.sha ?? 'none'}, not the frozen target ${review.manifest.targetSha}`);
    } else if (ciRecord.repo === null) {
      fail('ci-evidence', 'the bound CI record is not repository-bound');
    } else pass('ci-evidence');
  } else if (typeof ciRecord.reason !== 'string' || ciRecord.reason.trim() === '') {
    fail('ci-evidence', `the ${ciRecord.state} CI record carries no reason`);
  } else pass('ci-evidence');

  // 6. Private evidence attachments: every declared attachment is readable
  //    from the frozen copy, correctly sized and hash-identical.
  const attachments = review.manifest.reviewEvidence?.attachments ?? [];
  if (attachments.length === 0) pass('evidence:none-declared');
  for (const attachment of attachments) {
    const bytes = readFrozen(attachment.frozenFile, REVIEW_EVIDENCE_MAX_FILE_BYTES);
    if (bytes instanceof Error) {
      fail(`evidence:${attachment.id}`, `frozen evidence ${attachment.frozenFile} cannot be read: ${sanitizeDetail(bytes)}`);
    } else if (bytes.length !== attachment.bytes || sha256(bytes) !== attachment.sha256) {
      fail(`evidence:${attachment.id}`, `frozen evidence ${attachment.frozenFile} no longer matches its frozen size/hash receipt`);
    } else pass(`evidence:${attachment.id}`);
  }

  return { checks, missing };
}
