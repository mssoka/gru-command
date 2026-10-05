import { createHash } from 'node:crypto';
import type { SourceMovement } from './artifacts.js';
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

/** Admission options (gh-169 P5): `remoteProbeTimeoutMs` bounds the
 * advertised-tip ls-remote so a stalled remote cannot block the service
 * event loop at request time. A probe that exceeds the bound yields a
 * fail-closed, retryable `head-binding` refusal — never a silent pass and
 * never an unbounded stall. Default: 5 seconds. */
export const ADMISSION_REMOTE_PROBE_TIMEOUT_MS = 5_000;

export interface AdmissionPreflightOptions {
  readonly remoteProbeTimeoutMs?: number;
  /** R6-6/R7-4: the ledger's independent round.freeze-manifest sha256
   * receipt. The byte proof is REQUIRED at the built-in admission gate —
   * a missing or malformed receipt refuses (never a silently skipped
   * byte proof), and a whitespace-only rewrite of a semantically
   * identical manifest refuses under frozen-packet:manifest.json. */
  readonly frozenManifestSha256?: string;
  /** True at the built-in gate: the freeze receipt must exist and be a
   * valid sha256 for the manifest bytes to be trusted at all. */
  readonly frozenManifestReceiptRequired?: boolean;
  /** Precomputed ASYNC advertised-tip result (gh-169 R4-6): when supplied,
   * the sync probe is skipped and this outcome is merged into
   * head-binding — the remote lookup never blocks the event loop. */
  readonly precomputedRemoteMovement?: SourceMovement | null;
}

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

/** Typed refusal carrying every named missing input (never just the
 * first). EVERY input NAME always reaches the message (a refusal that
 * truncates a name would hide a missing input from the operator); only
 * per-input DETAIL is elided when the bound demands it. */
export class ReviewAdmissionError extends Error {
  readonly missing: readonly AdmissionMissingInput[];
  constructor(missing: readonly AdmissionMissingInput[]) {
    // Names are stable machine identifiers (bounded set, bounded length):
    // they are never cut. Details are bounded per input and elided as a
    // group when the whole message would overflow — the elision marker
    // says so explicitly instead of silently dropping later inputs.
    const names = missing.map((entry) => `[${entry.input}]`).join(' ');
    const detailBudget = 1_400;
    let details = missing.map((entry) => `${entry.input}: ${entry.detail.slice(0, 160)}`).join('; ');
    if (Buffer.byteLength(details, 'utf8') > detailBudget) {
      details = `${details.slice(0, detailBudget)}… (remaining details elided; every missing input name is listed)`;
    }
    super(
      `review admission preflight refused: ${missing.length} missing input(s): ${names} — ${details}`,
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

/** Full CI-record shape validation (P2/Q2): the admission boundary must
 * not accept a hash-consistent manifest whose record the report layer
 * would dereference blindly. Validates the state AND every persisted
 * field of the frozen `CiEvidenceRecord` contract (typed nullable
 * provenance, arrays with well-formed items, the REQUIRED failure
 * `conclusion`) — an explicit UNAVAILABLE/NOT-MATCHED record with a
 * reason stays a valid MISSING record, never a measured failure. */
function ciRecordShapeProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'the CI record is not an object';
  const record = value as Record<string, unknown>;
  const state = record['state'];
  if (typeof state !== 'string' || !(CI_EVIDENCE_STATES as readonly string[]).includes(state)) {
    return 'unknown state (malformed record)';
  }
  for (const [field, kind] of [
    ['repo', 'string'], ['sha', 'string'], ['observedAt', 'string'], ['sourceKind', 'string'], ['reason', 'string'],
  ] as const) {
    // Q2/P7 (round 3): the persisted contract declares these fields on
    // every record — a hash-consistent manifest that OMITS one is
    // malformed. Null stays permitted (the declared nullable contract);
    // absence does not.
    if (!(field in record)) {
      return `the ${field} field is absent (the frozen CI record contract requires the key, null permitted)`;
    }
    const raw = record[field];
    if (raw !== null && raw !== undefined && typeof raw !== kind) {
      return `the ${field} field is not ${kind === 'string' ? 'a string or null' : kind}`;
    }
  }
  if (!('pr' in record)) return 'the pr field is absent (the frozen CI record contract requires the key, null permitted)';
  if (!('sourceSeq' in record)) return 'the sourceSeq field is absent (the frozen CI record contract requires the key, null permitted)';
  if (record['pr'] !== null && record['pr'] !== undefined &&
    (typeof record['pr'] !== 'number' || !Number.isSafeInteger(record['pr']))) {
    return 'the pr field is not an integer or null';
  }
  if (record['sourceSeq'] !== null && record['sourceSeq'] !== undefined &&
    (typeof record['sourceSeq'] !== 'number' || !Number.isSafeInteger(record['sourceSeq']))) {
    return 'the sourceSeq field is not an integer or null';
  }
  if (!Array.isArray(record['checks'])) return 'the checks field is not an array';
  if (!Array.isArray(record['failures'])) return 'the failures field is not an array';
  for (const [index, check] of record['checks'].entries()) {
    if (typeof check !== 'object' || check === null || typeof (check as Record<string, unknown>)['name'] !== 'string' ||
      (check as Record<string, unknown>)['name'] === '') {
      return `checks[${index}] is malformed (a non-empty name is required)`;
    }
    if (!('url' in (check as Record<string, unknown>))) return `checks[${index}].url is absent (null permitted, omission is not)`;
    const url = (check as Record<string, unknown>)['url'];
    if (url !== undefined && url !== null && typeof url !== 'string') return `checks[${index}].url is malformed`;
  }
  for (const [index, failure] of record['failures'].entries()) {
    const entry = failure as Record<string, unknown>;
    if (typeof failure !== 'object' || failure === null || typeof entry['name'] !== 'string' || entry['name'] === '') {
      return `failures[${index}] is malformed (a non-empty name is required)`;
    }
    if (!('url' in entry)) return `failures[${index}].url is absent (null permitted, omission is not)`;
    const url = entry['url'];
    if (url !== undefined && url !== null && typeof url !== 'string') return `failures[${index}].url is malformed`;
    // The frozen CiEvidenceFailure contract REQUIRES a conclusion — a
    // failure entry without one is malformed, not merely sparse.
    if (typeof entry['conclusion'] !== 'string' || entry['conclusion'] === '') {
      return `failures[${index}].conclusion is required (a non-empty string)`;
    }
  }
  return null;
}

/**
 * Validate the complete frozen packet. Every check runs (exhaustive), every
 * read is bounded and read-only, and the returned `missing` list names each
 * inaccessible input precisely. An empty `missing` list is the pass.
 */
export function admissionPreflight(review: FrozenReview, movementRef: string, options?: AdmissionPreflightOptions): AdmissionPreflightResult {
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
  //    (local ref, advertised remote tip, HEAD and pristine checkout). The
  //    advertised probe is BOUNDED at admission (P5): a stalled remote
  //    refuses fail-closed within seconds instead of blocking the request.
  // R4-6: with a precomputed ASYNC probe result the sync path skips its
  // own remote lookup entirely; the merged outcome keeps the identical
  // fail-closed semantics.
  const movement = options?.precomputedRemoteMovement !== undefined
    ? ((): SourceMovement | null => {
        const local = headMovedSinceFreeze(review, movementRef, { skipRemoteProbe: true });
        return local ?? options.precomputedRemoteMovement ?? null;
      })()
    : headMovedSinceFreeze(review, movementRef, {
        ...(options?.remoteProbeTimeoutMs !== undefined ? { remoteProbeTimeoutMs: options.remoteProbeTimeoutMs } : { remoteProbeTimeoutMs: ADMISSION_REMOTE_PROBE_TIMEOUT_MS }),
      });
  if (movement === null) pass('head-binding');
  else fail('head-binding', `${movement.cause}: ${movement.detail}`);

  // 2. Frozen packet completeness: every declared artifact is re-read from
  //    the frozen copy and proven byte-identical to its manifest digest.
  const manifestBytes = readFrozen('manifest.json', FROZEN_MANIFEST_MAX_BYTES);
  if (manifestBytes instanceof Error) {
    fail('frozen-packet:manifest.json', `the frozen manifest cannot be read: ${sanitizeDetail(manifestBytes)}`);
  } else if (options?.frozenManifestReceiptRequired === true &&
    (options.frozenManifestSha256 === undefined || !/^[a-f0-9]{64}$/u.test(options.frozenManifestSha256))) {
    // R7-4: no independent receipt, no trusted bytes — the gate refuses
    // instead of silently dropping the byte proof.
    fail('frozen-packet:manifest.json', 'the ledger freeze receipt (round.freeze-manifest) is missing or malformed — the frozen manifest bytes cannot be independently proven');
  } else if (options?.frozenManifestSha256 !== undefined && sha256(manifestBytes) !== options.frozenManifestSha256) {
    // R6-6: byte identity against the independently pinned receipt — a
    // rewritten-but-equivalent manifest is a mutated frozen packet.
    fail('frozen-packet:manifest.json', 'the frozen manifest bytes do not match the ledger-pinned freeze receipt (round.freeze-manifest)');
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
    fileBytes.set(declared.path, bytes instanceof Error ? null : bytes);
  }
  // Plain digest-checked artifacts (one check each). The spec context and
  // the changed-file list get richer single checks below — Q3 guarantees
  // EXACTLY ONE verdict per named check, so a digest pass is never later
  // contradicted by a same-name failure.
  for (const declared of declaredFiles) {
    if (declared.path === 'spec-context.md' || declared.path === 'changed-files.json') continue;
    const bytes = fileBytes.get(declared.path) ?? null;
    if (bytes === null) {
      const error = readFrozen(declared.path, declared.bound);
      fail(declared.name, `cannot be read from the frozen packet: ${sanitizeDetail(error instanceof Error ? error : new Error('unreadable'))}`);
    } else if (sha256(bytes) !== declared.digest) {
      fail(declared.name, 'bytes no longer match the digest declared in the frozen manifest');
    } else pass(declared.name);
  }
  // Q1: the changed-file list is a SHAPE-checked packet input, not just a
  // hashed blob — a hash-consistent malformed list refuses admission under
  // its own single name.
  {
    const bytes = fileBytes.get('changed-files.json') ?? null;
    const digest = bytes === null ? null : sha256(bytes);
    if (bytes === null) {
      fail('frozen-packet:changed-files.json', 'cannot be read from the frozen packet');
    } else if (digest !== review.manifest.changedFilesSha256) {
      fail('frozen-packet:changed-files.json', 'bytes no longer match the digest declared in the frozen manifest');
    } else {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const shapeOk = Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string' && entry !== '');
        if (!shapeOk || JSON.stringify(parsed) !== JSON.stringify(review.manifest.changedFiles)) {
          fail('frozen-packet:changed-files.json', 'the frozen changed-file list is malformed or does not match the manifest list');
        } else pass('frozen-packet:changed-files.json');
      } catch (error) {
        fail('frozen-packet:changed-files.json', `the frozen changed-file list is not valid UTF-8 JSON: ${sanitizeDetail(error)}`);
      }
    }
  }

  const specBytes = fileBytes.get('spec-context.md') ?? null;
  // Q3/P1: digest AND UTF-8 decodability are ONE combined check on the
  // spec file's single name — a digest pass is never contradicted by a
  // later same-name decode failure, and invalid bytes still yield the
  // exhaustive named refusal (never an uncaught exception).
  if (specBytes === null) {
    fail('frozen-packet:spec-context.md', 'cannot be read from the frozen packet');
  } else if (sha256(specBytes) !== review.manifest.specSha256) {
    fail('frozen-packet:spec-context.md', 'bytes no longer match the digest declared in the frozen manifest');
  } else {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(specBytes);
      pass('frozen-packet:spec-context.md');
    } catch (error) {
      fail('frozen-packet:spec-context.md', `the frozen spec context is not valid UTF-8 text: ${sanitizeDetail(error)}`);
    }
  }
  // The decode was already judged inside the combined spec-file check
  // above; here it only derives the dependent section checks (a failure
  // can no longer throw — the bytes proved decodable or the check failed).
  let specText: string | null = null;
  try {
    specText = specBytes === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(specBytes);
  } catch {
    specText = null;
  }
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
    fail('spec-context', 'not checkable: the frozen spec-context.md is missing, corrupt or not valid UTF-8');
    fail('verification-evidence', 'not checkable: the frozen spec-context.md is missing, corrupt or not valid UTF-8');
  }

  // 5. Exact-target CI record: present and well-formed IN FULL SHAPE. An explicit
  //    UNAVAILABLE/NOT-MATCHED record PASSES (missing evidence is a
  //    disclosed limitation, never an admission failure); a bound
  //    green/pending/failed record must name the frozen head.
  const ciRecord: unknown = review.manifest.reviewEvidence?.ci ?? null;
  const ciShapeProblem = ciRecord === null ? null : ciRecordShapeProblem(ciRecord);
  if (ciRecord === null) {
    fail('ci-evidence', 'no exact-target CI record froze with the packet; arm the review through the supported review-inputs handoff so the CI state (or its explicit UNAVAILABLE limitation) is frozen and visible');
  } else if (ciShapeProblem !== null) {
    fail('ci-evidence', `the frozen CI record is malformed: ${ciShapeProblem}`);
  } else {
    // Shape proven by ciRecordShapeProblem above; the cast only restores
    // the narrowed view the validator guarantees.
    const ci = ciRecord as CiEvidenceRecord;
    if (ci.state === 'green' || ci.state === 'pending' || ci.state === 'failed') {
      if (ci.sha !== review.manifest.targetSha) {
        fail('ci-evidence', `the bound CI record names sha ${ci.sha ?? 'none'}, not the frozen target ${review.manifest.targetSha}`);
      } else if (ci.repo === null) {
        fail('ci-evidence', 'the bound CI record is not repository-bound');
      } else pass('ci-evidence');
    } else if (typeof ci.reason !== 'string' || ci.reason.trim() === '') {
      fail('ci-evidence', `the ${ci.state} CI record carries no reason`);
    } else pass('ci-evidence');
  }

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
