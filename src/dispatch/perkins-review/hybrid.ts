import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentSpawner } from '../service.js';
import type { AgentHandle, NativeAgentTool } from '../../runtime/types.js';
import { MAX_TRANSPORT_CHUNK_BYTES, assertFrozenPromptBounds, refMovedSinceFreeze, writeReviewArtifact, type FrozenReview } from './artifacts.js';
import { finalAssistantText } from './session-output.js';
import { PERKINS_LENSES, type PerkinsLens, type PerkinsPolicy } from './policy.js';
import {
  dedupeVerifiedFindings,
  parseFindingsSubmission,
  parseFindingsWithRecovery,
  safeFixPath,
  verdictForFindings,
  type CanonicalReviewVerdict,
  type ChildFailureKind,
  type FixAuditResult,
  type LensEnvelope,
  type LensOutputRecovery,
  type ReviewCompleteness,
  type ReviewFinding,
  type VerifiedFinding,
  type VerificationDisposition,
} from './types.js';

const CHILD_CONCURRENCY = 4;
const CHILD_SPAWN_TIMEOUT_MS = 60 * 1_000;
const CHILD_TURN_TIMEOUT_MS = 10 * 60 * 1_000;
const LEAD_SPAWN_TIMEOUT_MS = 60 * 1_000;
/** Wall-clock bound on the whole lead run (one prompt = many turns). */
const LEAD_TOTAL_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_LEAD_TURNS = 80;
const MAX_TOOL_RUNS = 4;
const MAX_TOTAL_CANDIDATES = 1_000;
const MAX_TERMINAL_ATTEMPTS = 2;
const MAX_LEAD_ARTIFACTS = 20;
const MAX_LEAD_ARTIFACT_BYTES = 100 * 1024;
/** Response bound for an aggregated submission-validation rejection. The MCP
 * transport caps one tool response at 1 MiB; this keeps the exhaustive list
 * well inside it for every real submission. */
const MAX_VALIDATION_MESSAGE_BYTES = 256 * 1024;
export const PERKINS_REPORT_MAX_BYTES = 128 * 1024;
/** One real submission arrives through a <=1 MiB tool transport. A rejected
 * submission kept as the delta base is stored only within that same bound;
 * an over-bound rejection cannot be amended and must be resubmitted whole. */
export const PERKINS_STORED_SUBMISSION_MAX_BYTES = 1024 * 1024;
const REVIEW_OWNER = 'perkins-hybrid-review';

const BLIND_SYSTEM_PROMPT =
  'You are one blind Perkins lens child. The user prompt is your entire context. You have no repository context, skills, extensions, or delegation authority. Follow the user prompt exactly.';
const LENS_SYSTEM_PROMPT =
  'You are one Perkins lens child. Use only the read-only frozen-tree tools and the supplied prompt. Never edit, delegate, invoke skills, or start another review. Follow the user prompt exactly.';

/** The one native channel a lens child may submit structured findings through. */
export const FINDINGS_TOOL_NAME = 'perkins_submit_findings';
/** Exact per-finding keys of the structured submission: the host owns the
 * lens identity, so `source` is deliberately absent from tool input. */
const SUBMITTED_FINDING_KEYS = [
  'severity',
  'category',
  'title',
  'location',
  'evidence',
  'detail',
  'recommended_fix',
] as const;
/** JSON schema for perkins_submit_findings. Bounds mirror validateFindingEntries
 * exactly (the runtime enforces JSON shape; the host enforces the schema). */
const FINDINGS_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...SUBMITTED_FINDING_KEYS],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'warning', 'note'] },
          category: { type: 'string', minLength: 1, maxLength: 80 },
          title: { type: 'string', minLength: 1, maxLength: 240 },
          location: { type: 'string', minLength: 1, maxLength: 500 },
          evidence: { type: 'string', minLength: 1, maxLength: 4_000 },
          detail: { type: 'string', minLength: 1, maxLength: 320 },
          recommended_fix: { type: 'string', minLength: 1, maxLength: 320 },
        },
      },
    },
  },
};

/** How a child receives its findings contract: through the native tool when
 * the hosting runtime wired it, otherwise through the strict text envelope. */
type ChildOutputMode = 'nativeTool' | 'text';

export interface ReviewProgress {
  readonly lens: PerkinsLens;
  readonly chunk: string;
  readonly state: 'running' | 'done' | 'error';
  readonly note?: string;
}

export interface PerkinsHybridReviewOptions {
  readonly spawner: AgentSpawner;
  readonly policy: PerkinsPolicy;
  readonly onProgress?: (progress: ReviewProgress) => void;
  readonly onAgent?: (input: {
    readonly phase: 'lead' | 'lens';
    readonly lens?: PerkinsLens;
    readonly chunk?: string;
    /** Which wave attempt spawned this child (the retry-bound counter;
     * 1 = first run). Callers minting agent labels suffix it on retries so
     * two attempts on one chunk never mint duplicate rows. */
    readonly attempt?: 1 | 2;
    readonly handle: AgentHandle;
  }) => void;
}

export interface RunPerkinsHybridInput {
  readonly roundId: string;
  readonly roundNumber: number;
  readonly frozenReview: FrozenReview;
  readonly movementRef: string;
  readonly noSpec: boolean;
  readonly priorConsolidatedFile?: string;
  /** Service shutdown or caller cancellation. Cancellation is always INCOMPLETE. */
  readonly signal?: AbortSignal;
}

export interface VerificationSummary {
  readonly candidates: number;
  readonly confirmed: number;
  readonly rejected: number;
  readonly unverified: number;
  readonly speculative: number;
  readonly deduplicated: number;
}

export interface PerkinsHybridResult {
  readonly canonicalVerdict: CanonicalReviewVerdict;
  readonly findings: readonly VerifiedFinding[];
  readonly completeness: ReviewCompleteness;
  readonly artifactDirectory: string;
  readonly reportFile: string;
  readonly targetSha: string;
  readonly diffBaseSha: string;
  readonly headMoved: boolean;
  readonly lensEnvelopes: readonly LensEnvelope[];
  readonly priorAudit: readonly FixAuditResult[];
  readonly verificationSummary: VerificationSummary;
}

interface ChildCandidate extends ReviewFinding {
  readonly ref: string;
  readonly chunk: string;
  readonly resultId: string;
  readonly findingIndex: number;
}

interface ChildResult {
  readonly resultId: string;
  readonly agentId: string;
  readonly lens: PerkinsLens;
  readonly chunk: string;
  readonly attempt: 1 | 2;
  readonly status: 'valid' | 'invalid' | 'failed';
  readonly findings: readonly ChildCandidate[];
  /** Present when status is not valid: the precise failure class. */
  readonly failureKind?: ChildFailureKind;
  /** Host-carried tests-lens coverage gate status (undefined for other lenses). */
  readonly coverageGate?: 'PASS' | 'CONCERNS' | 'FAIL';
  readonly error?: string;
}

/** One host-recorded non-valid attempt for a required lens/chunk. */
export interface CoverageAttemptFailure {
  readonly attempt: number;
  readonly status: 'invalid' | 'failed';
  readonly failureKind: ChildFailureKind;
  readonly error: string;
}

/** A required lens/chunk whose full attempt budget was spent without a valid
 * result: no further attempt can satisfy the coverage gate. */
export interface ExhaustedCoverage {
  readonly lens: PerkinsLens;
  readonly chunk: string;
  readonly attempts: readonly CoverageAttemptFailure[];
}

interface CandidateDecision {
  readonly candidate_ref: string;
  readonly disposition: VerificationDisposition;
  readonly evidence: string;
  readonly reason: string;
}

interface LeadSubmission {
  readonly canonical_verdict: CanonicalReviewVerdict;
  readonly candidate_decisions: readonly CandidateDecision[];
  readonly prior_audit: readonly FixAuditResult[];
  readonly report_markdown: string;
}

/** Host state a candidate submission resolves against: decisions validated
 * and recorded as the lead verified them, plus the last rejected submission
 * that a delta may amend. */
interface SubmissionState {
  readonly recordedDecisions: ReadonlyMap<string, CandidateDecision>;
  readonly lastRejected: LeadSubmission | null;
  /** True when a coherent submission was rejected but exceeded the delta
   * base bound, so the lead must resubmit it whole instead of amending. */
  readonly lastRejectionOversized: boolean;
}

/** A delta resolved over stored host state: the merged whole plus every
 * delta-envelope violation encountered while applying it. */
interface ResolvedDelta {
  /** Full-submission-shaped object; validated by the same collect-all pass. */
  readonly merged: {
    readonly canonical_verdict: unknown;
    readonly candidate_decisions: readonly CandidateDecision[];
    readonly prior_audit: readonly FixAuditResult[];
    readonly report_markdown: unknown;
  };
  readonly errors: readonly SubmissionValidationIssue[];
}

/** One exhaustive submission-validation violation, addressable by the lead. */
interface SubmissionValidationIssue {
  /** `candidate_ref`, `prior audit N`, `finding <title>`, `report`, or `submission`. */
  readonly subject: string;
  /** Stable rule code naming the violated host rule. */
  readonly rule: string;
  /** Actionable detail; the same wording the fail-fast validator used. */
  readonly message: string;
}

interface ParsedDecision {
  readonly index: number;
  readonly decision: CandidateDecision | null;
}

interface ParsedAudit {
  readonly index: number;
  readonly audit: FixAuditResult | null;
}

/** Schema-valid parsed pieces plus per-entry violations, never fail-fast. */
interface ParsedSubmission {
  readonly verdict: CanonicalReviewVerdict | null;
  readonly decisions: readonly ParsedDecision[] | null;
  readonly audits: readonly ParsedAudit[] | null;
  readonly report: string | null;
  /** Present only when every schema rule passed (the old parse contract). */
  readonly submission: LeadSubmission | null;
  readonly errors: readonly SubmissionValidationIssue[];
}

interface SubmissionValidationContext {
  readonly review: FrozenReview;
  readonly movementRef: string;
  readonly roundNumber: number;
  readonly candidates: ReadonlyMap<string, ChildCandidate>;
  readonly prior: readonly VerifiedFinding[];
  readonly priorTargetSha: string | null;
  readonly expected: ReadonlySet<string>;
  readonly validCoverage: ReadonlySet<string>;
  readonly readChunks: ReadonlySet<string>;
  readonly results: ReadonlyMap<string, ChildResult>;
  readonly lenses: readonly PerkinsLens[];
}

interface SubmissionValidationSuccess {
  readonly ok: true;
  readonly submission: LeadSubmission;
  readonly findings: readonly VerifiedFinding[];
  readonly priorAudit: readonly FixAuditResult[];
  readonly completeness: ReviewCompleteness;
  readonly canonicalVerdict: CanonicalReviewVerdict;
  readonly headMoved: boolean;
  readonly verificationSummary: VerificationSummary;
}

interface SubmissionValidationFailure {
  readonly ok: false;
  /** Best-effort parsed payload; null when a schema rule failed. */
  readonly submission: LeadSubmission | null;
  readonly errors: readonly SubmissionValidationIssue[];
}

type SubmissionValidation = SubmissionValidationSuccess | SubmissionValidationFailure;

const SUBMISSION_KEYS = ['canonical_verdict', 'candidate_decisions', 'prior_audit', 'report_markdown'];
const DELTA_KEYS = ['mode', 'canonical_verdict', 'candidate_decisions', 'prior_audit', 'report_markdown'];
const CANDIDATE_DECISION_KEYS = ['candidate_ref', 'disposition', 'evidence', 'reason'];
const PRIOR_AUDIT_KEYS = ['prior_index', 'status', 'evidence', 'reason'];
const CANONICAL_VERDICTS = ['READY TO MERGE', 'NEEDS CHANGES', 'MAJOR REWORK NEEDED', 'INCOMPLETE'];

function isDeltaEnvelope(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (value as { mode?: unknown }).mode === 'delta';
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function headMovedSinceFreeze(review: FrozenReview, movementRef: string): boolean {
  if (refMovedSinceFreeze(review)) return true;
  if (movementRef === review.manifest.targetSha || movementRef === review.manifest.targetRef) return false;
  try {
    return execFileSync(
      'git', ['-C', review.manifest.repoPath, 'rev-parse', '--verify', `${movementRef}^{commit}`],
      { encoding: 'utf8', timeout: GIT_PROOF_TIMEOUT_MS },
    ).trim() !== review.manifest.targetSha;
  } catch {
    return true;
  }
}

/** Exact N-byte UTF-8 prefix of a string (never splitting a code point). */
function bytePrefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut).toString('utf8');
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`${name} keys do not match the required schema`);
  }
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  if (Buffer.byteLength(value, 'utf8') > max) throw new Error(`${name} exceeds ${max} UTF-8 bytes`);
  return value;
}

/** Collecting twin of boundedString: records the violation and keeps going. */
function collectBoundedString(
  value: unknown,
  name: string,
  max: number,
  subject: string,
  rule: string,
  errors: SubmissionValidationIssue[],
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({ subject, rule, message: `${name} must be a non-empty string` });
    return null;
  }
  if (Buffer.byteLength(value, 'utf8') > max) {
    errors.push({ subject, rule, message: `${name} exceeds ${max} UTF-8 bytes` });
    return null;
  }
  return value;
}

function parseDecisionEntry(entry: unknown, index: number, errors: SubmissionValidationIssue[]): ParsedDecision {
  const subject = `candidate decision ${index}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push({ subject, rule: 'candidate-decision-shape', message: `${subject} must be an object` });
    return { index, decision: null };
  }
  const decision = entry as Record<string, unknown>;
  if (Object.keys(decision).sort().join('\0') !== [...CANDIDATE_DECISION_KEYS].sort().join('\0')) {
    errors.push({ subject, rule: 'candidate-decision-schema', message: `${subject} keys do not match the required schema` });
  }
  const candidateRef = collectBoundedString(
    decision.candidate_ref, `${subject} ref`, 240, subject, 'candidate-decision-ref', errors,
  );
  const evidence = collectBoundedString(
    decision.evidence, `${subject} evidence`, 4_000, subject, 'candidate-decision-evidence', errors,
  );
  const reason = collectBoundedString(
    decision.reason, `${subject} reason`, 1_000, subject, 'candidate-decision-reason', errors,
  );
  let disposition: VerificationDisposition | null = null;
  if (typeof decision.disposition !== 'string' || !['confirmed', 'rejected', 'unverifiable-speculative'].includes(decision.disposition)) {
    errors.push({ subject, rule: 'candidate-decision-disposition', message: `${subject} disposition is invalid` });
  } else {
    disposition = decision.disposition as VerificationDisposition;
  }
  if (candidateRef === null || evidence === null || reason === null || disposition === null) {
    return { index, decision: null };
  }
  return { index, decision: { candidate_ref: candidateRef, disposition, evidence, reason } };
}

function parseAuditEntry(
  entry: unknown,
  index: number,
  priorCount: number,
  errors: SubmissionValidationIssue[],
): ParsedAudit {
  const subject = `prior audit ${index}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push({ subject, rule: 'prior-audit-shape', message: `${subject} must be an object` });
    return { index, audit: null };
  }
  const audit = entry as Record<string, unknown>;
  const expectedKeys = audit.fix_location === undefined ? PRIOR_AUDIT_KEYS : [...PRIOR_AUDIT_KEYS, 'fix_location'];
  if (Object.keys(audit).sort().join('\0') !== [...expectedKeys].sort().join('\0')) {
    errors.push({ subject, rule: 'prior-audit-schema', message: `${subject} keys do not match the required schema` });
  }
  let fixLocation: FixAuditResult['fix_location'];
  if (audit.fix_location !== undefined) {
    const location = audit.fix_location;
    if (typeof location !== 'object' || location === null || Array.isArray(location) ||
        Object.keys(location).sort().join('\0') !== 'change\0path') {
      errors.push({ subject, rule: 'prior-audit-fix-location', message: `${subject} fix_location requires exactly path and change` });
    } else {
      const value = location as Record<string, unknown>;
      if (typeof value.path !== 'string' || !safeFixPath(value.path)) {
        errors.push({ subject, rule: 'prior-audit-fix-location', message: `${subject} fix_location path must be a bounded safe relative file path` });
      } else if (value.change !== 'added' && value.change !== 'removed') {
        errors.push({ subject, rule: 'prior-audit-fix-location', message: `${subject} fix_location change must be added or removed` });
      } else {
        fixLocation = { path: value.path, change: value.change };
      }
    }
    if (audit.status !== 'fixed') {
      errors.push({ subject, rule: 'prior-audit-fix-location', message: `${subject} fix_location is supported only for fixed status` });
    }
    if (typeof audit.evidence !== 'string' || /[\r\n]/u.test(audit.evidence) || audit.evidence === 'N/A' || audit.evidence.startsWith('PATH ABSENT: ')) {
      errors.push({ subject, rule: 'prior-audit-fix-location', message: `${subject} fix_location requires a single changed-line evidence payload` });
    }
  }
  let priorIndex: number | null = null;
  if (
    !Number.isSafeInteger(audit.prior_index) || Number(audit.prior_index) < 0 || Number(audit.prior_index) >= priorCount
  ) {
    errors.push({ subject, rule: 'prior-audit-index', message: `${subject} index is invalid` });
  } else {
    priorIndex = Number(audit.prior_index);
  }
  let status: FixAuditResult['status'] | null = null;
  if (typeof audit.status !== 'string' || !['fixed', 'still-present'].includes(audit.status)) {
    errors.push({ subject, rule: 'prior-audit-status', message: `${subject} status is invalid` });
  } else {
    status = audit.status as FixAuditResult['status'];
  }
  const evidence = collectBoundedString(audit.evidence, `${subject} evidence`, 4_000, subject, 'prior-audit-evidence', errors);
  const reason = collectBoundedString(audit.reason, `${subject} reason`, 1_000, subject, 'prior-audit-reason', errors);
  if (priorIndex === null || status === null || evidence === null || reason === null) {
    return { index, audit: null };
  }
  return { index, audit: { prior_index: priorIndex, status, evidence, reason, ...(fixLocation === undefined ? {} : { fix_location: fixLocation }) } };
}

/** One bounded, line-addressable rejection listing every violation at once. */
function rejectionMessage(errors: readonly SubmissionValidationIssue[]): string {
  const lines = [
    `terminal submission rejected with ${errors.length} error(s); every listed rule must be fixed before a real submission is accepted:`,
  ];
  let bytes = Buffer.byteLength(lines[0]!, 'utf8') + 1;
  let shown = 0;
  for (const error of errors) {
    const line = `- [${error.subject}] ${error.rule}: ${error.message}`;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + lineBytes > MAX_VALIDATION_MESSAGE_BYTES) break;
    lines.push(line);
    bytes += lineBytes;
    shown += 1;
  }
  if (shown < errors.length) lines.push(`- (+${errors.length - shown} further error(s) omitted from this bounded response)`);
  return lines.join('\n');
}

/** Thrown rejection carrying the complete issue list for the audit artifact. */
class SubmissionRejection extends Error {
  readonly issues: readonly SubmissionValidationIssue[];

  constructor(issues: readonly SubmissionValidationIssue[]) {
    super(rejectionMessage(issues));
    this.name = 'SubmissionRejection';
    this.issues = issues;
  }
}

/** Same byte bound for the preflight channel's structured error list. */
function boundedIssues(errors: readonly SubmissionValidationIssue[]): {
  readonly errors: readonly SubmissionValidationIssue[];
  readonly omitted: number;
} {
  let bytes = 0;
  let included = 0;
  for (const error of errors) {
    const size = Buffer.byteLength(JSON.stringify(error), 'utf8') + 1;
    if (bytes + size > MAX_VALIDATION_MESSAGE_BYTES) break;
    bytes += size;
    included += 1;
  }
  return { errors: errors.slice(0, included), omitted: errors.length - included };
}

function findingPath(finding: Pick<ReviewFinding, 'location'>): string | null {
  const token = finding.location.split(':', 1)[0]?.trim() ?? '';
  if (
    token === '' || token === 'N/A' || token.startsWith('-') || token.startsWith('/') ||
    token.includes('\\') || token.split('/').some((component) => component === '' || component === '.' || component === '..')
  ) return null;
  return token;
}

const GIT_PROOF_TIMEOUT_MS = 30_000;

/** Per-validation memo for the frozen-tree proof lookups. The round's SHAs are
 * immutable, so identical queries are wasted subprocesses; one validation pass
 * (and each repeated preflight) shares this cache. */
interface ProofCache {
  readonly blobContains: Map<string, boolean>;
  readonly pathDiffs: Map<string, string>;
  readonly pathAbsent: Map<string, boolean>;
  readonly anywhere: Map<string, boolean>;
  readonly changeStatus: Map<string, readonly DeltaPath[]>;
  readonly changedLines: Map<string, ReadonlySet<string>>;
  readonly canonicalPatches: Map<string, string>;
}

interface DeltaPath {
  readonly oldPath: string | null;
  readonly newPath: string | null;
}

function newProofCache(): ProofCache {
  return {
    blobContains: new Map(), pathDiffs: new Map(), pathAbsent: new Map(), anywhere: new Map(),
    changeStatus: new Map(), changedLines: new Map(), canonicalPatches: new Map(),
  };
}

function frozenBlobContains(review: FrozenReview, path: string, evidence: string, cache?: ProofCache): boolean {
  const key = `${path}\0${evidence}`;
  const cached = cache?.blobContains.get(key);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    const blob = execFileSync('git', ['-C', review.manifest.repoPath, 'show', `${review.manifest.targetSha}:${path}`], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    result = blob.includes(evidence);
  } catch {
    result = false;
  }
  cache?.blobContains.set(key, result);
  return result;
}

function frozenPathDiff(
  review: FrozenReview,
  path: string,
  baseSha = review.manifest.diffBaseSha,
  cache?: ProofCache,
): string {
  const key = `${baseSha}\0${path}`;
  const cached = cache?.pathDiffs.get(key);
  if (cached !== undefined) return cached;
  let diff = '';
  try {
    diff = execFileSync('git', [
      '-C', review.manifest.repoPath, 'diff', '--no-ext-diff', '--no-color', '--unified=3',
      baseSha, review.manifest.targetSha, '--', `:(literal)${path}`,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    diff = '';
  }
  cache?.pathDiffs.set(key, diff);
  return diff;
}

function evidenceAtCitedLocation(
  review: FrozenReview,
  finding: ReviewFinding,
  evidence: string,
  cache?: ProofCache,
): boolean {
  if (evidence === 'N/A' || evidence.trim() === '') return false;
  const path = findingPath(finding);
  // Binding is to the CITED FILE in the frozen tree (blob or its diff), not
  // to the chunk's changed-file list: lens children read the whole frozen
  // tree and may cite an unchanged file with a real defect.
  if (path === null) return false;
  return frozenBlobContains(review, path, evidence, cache) ||
    frozenPathDiff(review, path, review.manifest.diffBaseSha, cache).includes(evidence);
}

function evidenceAnywhere(review: FrozenReview, evidence: string, cache?: ProofCache): boolean {
  if (evidence === 'N/A' || evidence.trim() === '') return false;
  if (review.chunks.some((chunk) => chunk.diff.includes(evidence))) return true;
  const cached = cache?.anywhere.get(evidence);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    result = execFileSync('git', [
      '-C', review.manifest.repoPath, 'grep', '-F', '--full-name', '--', evidence, review.manifest.targetSha, '--',
    ], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() !== '';
  } catch {
    result = false;
  }
  cache?.anywhere.set(evidence, result);
  return result;
}

function fixedAuditEvidence(
  review: FrozenReview,
  finding: VerifiedFinding,
  evidence: string,
  priorTargetSha: string | null,
  cache?: ProofCache,
): boolean {
  const path = findingPath(finding);
  if (path === null) return false;
  if (evidence === `PATH ABSENT: ${path}`) {
    const cached = cache?.pathAbsent.get(path);
    if (cached !== undefined) return cached;
    let absent = false;
    try {
      execFileSync('git', ['-C', review.manifest.repoPath, 'cat-file', '-e', `${review.manifest.targetSha}:${path}`], {
        timeout: GIT_PROOF_TIMEOUT_MS, stdio: 'ignore',
      });
      absent = false;
    } catch {
      absent = true;
    }
    cache?.pathAbsent.set(path, absent);
    return absent;
  }
  const diff = frozenPathDiff(review, path, priorTargetSha ?? review.manifest.diffBaseSha, cache);
  return diff.split('\n').some((line) => line.startsWith('-') && !line.startsWith('---') && line.slice(1) === evidence);
}

const MAX_INDIRECT_PROOF_BYTES = 8 * 1024 * 1024;

/** Read bounded Git bytes at two fixed commits, never from the checkout. A
 * failed query must fail proof, not devolve into a weaker current-tree check. */
function proofGitBytes(review: FrozenReview, args: readonly string[]): Buffer {
  const raw = execFileSync('git', ['-C', review.manifest.repoPath, ...args], {
    maxBuffer: MAX_INDIRECT_PROOF_BYTES, timeout: GIT_PROOF_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (raw.byteLength > MAX_INDIRECT_PROOF_BYTES) throw new Error('frozen delta exceeds the proof byte bound');
  return raw;
}

function proofGit(review: FrozenReview, args: readonly string[]): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(proofGitBytes(review, args));
}

/** Git attributes can label a binary blob as text (or text as binary). The
 * objects, not the diff driver's classification, decide whether proof exists. */
function canonicalTextBlob(review: FrozenReview, sha: string, path: string): string | null {
  const bytes = proofGitBytes(review, ['cat-file', 'blob', `${sha}:${path}`]);
  if (bytes.some((byte) => byte === 0 || byte === 127 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Rename detection runs BEFORE path selection. Filtering first reclassifies
 * an unchanged renamed file as a wholly added file. */
function deltaPaths(review: FrozenReview, priorSha: string, cache: ProofCache): readonly DeltaPath[] {
  const cached = cache.changeStatus.get(priorSha);
  if (cached !== undefined) return cached;
  const fields = proofGit(review, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames',
    '--name-status', '-z', priorSha, review.manifest.targetSha, '--',
  ]).split('\0');
  if (fields.at(-1) !== '') throw new Error('frozen delta path metadata is incomplete');
  fields.pop();
  const paths: DeltaPath[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (status === undefined) throw new Error('frozen delta path metadata is incomplete');
    if (/^R[0-9]{1,3}$/u.test(status)) {
      const oldPath = fields[i++];
      const newPath = fields[i++];
      if (!oldPath || !newPath) throw new Error('frozen rename metadata is incomplete');
      paths.push({ oldPath, newPath });
    } else if (status === 'A' || status === 'D' || status === 'M') {
      const path = fields[i++];
      if (!path) throw new Error('frozen delta path metadata is incomplete');
      paths.push({ oldPath: status === 'A' ? null : path, newPath: status === 'D' ? null : path });
    } else {
      // Unknown types are never usable as indirect proof, but other files in
      // the delta must not prevent a genuine changed caller being inspected.
      const path = fields[i++];
      if (!path) throw new Error('frozen delta path metadata is incomplete');
    }
  }
  cache.changeStatus.set(priorSha, paths);
  return paths;
}

function regularFrozenBlob(review: FrozenReview, sha: string, path: string): boolean {
  const entries = proofGit(review, ['ls-tree', '-z', sha, '--', `:(literal)${path}`]);
  return /^(?:100644|100755) blob [0-9a-f]{40}\t/u.test(entries) &&
    entries.slice(entries.indexOf('\t') + 1) === `${path}\0`;
}

/** Do not mix another file's hunks into a renamed caller's path pair. */
function isolatedDeltaPath(paths: readonly DeltaPath[], path: string, change?: 'added' | 'removed'): DeltaPath {
  const matches = paths.filter((entry) => change === 'added' ? entry.newPath === path :
    change === 'removed' ? entry.oldPath === path : entry.oldPath === path || entry.newPath === path);
  if (matches.length !== 1) throw new Error(`fix_location ${path} has no unique changed path in the frozen prior-target delta`);
  const entry = matches[0]!;
  if (paths.some((other) => other !== entry && [entry.oldPath, entry.newPath].some((candidate) =>
    candidate !== null && (other.oldPath === candidate || other.newPath === candidate)))) {
    throw new Error(`fix_location ${path} overlaps another changed path in the frozen delta`);
  }
  return entry;
}

/** The same path-paired zero-context patch is supplied to the lead and checked
 * at submission. Both blobs must be regular canonical UTF-8 text regardless
 * of `.gitattributes`, diff drivers or textconv; --text then defeats -diff. */
function canonicalPathPatch(review: FrozenReview, priorSha: string, entry: DeltaPath, cache: ProofCache): string | null {
  const key = `${priorSha}\0${entry.oldPath ?? ''}\0${entry.newPath ?? ''}`;
  const cached = cache.canonicalPatches.get(key);
  if (cached !== undefined) return cached;
  for (const [sha, path] of [[priorSha, entry.oldPath], [review.manifest.targetSha, entry.newPath]] as const) {
    if (path === null) continue;
    if (!regularFrozenBlob(review, sha, path)) throw new Error(`frozen delta path ${path} is not a regular blob`);
    if (canonicalTextBlob(review, sha, path) === null) return null;
  }
  const paths = [...new Set([entry.oldPath, entry.newPath].filter((path): path is string => path !== null))]
    .map((path) => `:(literal)${path}`);
  const patch = proofGit(review, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--text', '--find-renames', '--unified=0',
    priorSha, review.manifest.targetSha, '--', ...paths,
  ]);
  cache.canonicalPatches.set(key, patch);
  return patch;
}

/** Null means located; otherwise return a specific, bounded rejection. */
function indirectFixEvidence(
  review: FrozenReview, finding: VerifiedFinding, audit: FixAuditResult,
  priorSha: string | null, cache: ProofCache,
): string | null {
  const location = audit.fix_location!;
  const citedPath = findingPath(finding);
  if (citedPath === null || location.path === citedPath) return 'fix_location must name a changed file distinct from the original cited path';
  if (priorSha === null) return 'fix_location requires a frozen prior target revision';
  try {
    if (!regularFrozenBlob(review, priorSha, citedPath) ||
        !proofGit(review, ['show', `${priorSha}:${citedPath}`]).includes(finding.evidence)) {
      return `fix_location ${location.path} prior target revision does not contain the original cited finding`;
    }
    const entry = isolatedDeltaPath(deltaPaths(review, priorSha, cache), location.path, location.change);
    const patch = canonicalPathPatch(review, priorSha, entry, cache);
    if (patch === null) return `fix_location ${location.path} has a binary caller blob, not canonical text proof`;
    const key = `${priorSha}\0${entry.oldPath ?? ''}\0${entry.newPath ?? ''}\0${location.change}`;
    let lines = cache.changedLines.get(key);
    if (lines === undefined) {
      const changed = new Set<string>();
      let inHunk = false;
      for (const line of patch.split('\n')) {
        if (line.startsWith('diff --git ')) inHunk = false;
        else if (/^@@ -[0-9]+(?:,[0-9]+)? \+[0-9]+(?:,[0-9]+)? @@/u.test(line)) inHunk = true;
        else if (inHunk && line.startsWith(location.change === 'added' ? '+' : '-')) changed.add(line.slice(1));
      }
      lines = changed;
      cache.changedLines.set(key, lines);
    }
    return lines.has(audit.evidence) ? null : `fix_location ${location.path} evidence is not an actual ${location.change} changed hunk line in the frozen prior-target delta`;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('fix_location ')) return error.message;
    return `fix_location ${location.path} frozen delta is unavailable or exceeds bounds at the prior target revision`;
  }
}

interface PriorReview {
  readonly findings: readonly VerifiedFinding[];
  readonly targetSha: string | null;
}

function loadPriorReview(file: string | undefined): PriorReview {
  if (file === undefined) return { findings: [], targetSha: null };
  const size = statSync(file).size;
  if (size > 8 * 1024 * 1024) throw new Error('prior consolidated review exceeds 8 MiB');
  const bytes = readFileSync(file);
  if (bytes.byteLength !== size || bytes.byteLength > 8 * 1024 * 1024) {
    throw new Error('prior consolidated review changed while bounded bytes were read');
  }
  const parsed = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: unknown; findings?: unknown; frozen?: { targetSha?: unknown } };
  if (
    parsed.schemaVersion !== 2 ||
    !Array.isArray(parsed.findings) || parsed.findings.length > 10_000 ||
    typeof parsed.frozen?.targetSha !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.frozen.targetSha)
  ) {
    throw new Error('prior consolidated review has an invalid findings array');
  }
  const lenses = PERKINS_LENSES;
  const findings = parsed.findings.map((entry, index) => {
    const finding = record(entry, `prior finding ${index}`) as Partial<VerifiedFinding>;
    const verification = finding.verification as Partial<VerifiedFinding['verification']> | undefined;
    if (
      typeof finding.source !== 'string' || !lenses.includes(finding.source as typeof lenses[number]) ||
      typeof finding.severity !== 'string' || !['blocker', 'warning', 'note'].includes(finding.severity) ||
      typeof finding.category !== 'string' || typeof finding.title !== 'string' ||
      typeof finding.location !== 'string' || typeof finding.evidence !== 'string' ||
      typeof finding.detail !== 'string' || typeof finding.recommended_fix !== 'string' ||
      !Number.isSafeInteger(finding.roundOrigin) || Number(finding.roundOrigin) < 1 ||
      !Array.isArray(finding.sources) || finding.sources.length === 0 ||
      finding.sources.some((source) => typeof source !== 'string' || !lenses.includes(source as typeof lenses[number])) ||
      !Array.isArray(finding.chunks) || finding.chunks.length === 0 ||
      finding.chunks.some((chunk) => typeof chunk !== 'string' || chunk.trim() === '') ||
      verification === undefined ||
      typeof verification.disposition !== 'string' ||
      !['confirmed', 'unverifiable-speculative'].includes(verification.disposition) ||
      typeof verification.evidence !== 'string' || typeof verification.reason !== 'string'
    ) throw new Error(`prior finding ${index} failed the durable schema`);
    return finding as VerifiedFinding;
  });
  return { findings, targetSha: parsed.frozen.targetSha };
}

function renderTemplateOnce(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(?:PROJECT_CONVENTIONS|DIFF|SPEC_CONTEXT|LENS_BRIEF|LENS|CHUNK_FILES)\}\}/g, (placeholder) =>
    values[placeholder] ?? placeholder,
  );
}

function renderLensPrompt(
  policy: PerkinsPolicy,
  review: FrozenReview,
  lens: PerkinsLens,
  chunk: string,
  output: ChildOutputMode,
  retry?: { readonly attempt: 1 | 2; readonly previous: CoverageAttemptFailure },
): string {
  const selected = review.chunks.find((candidate) => candidate.id === chunk);
  if (selected === undefined) throw new Error(`missing frozen chunk ${chunk}`);
  const contracts = policy.portableContract.outputContracts;
  const rawContract = lens === 'blind'
    ? (output === 'nativeTool' ? contracts.blindNativeTool : contracts.blindText)
    : (output === 'nativeTool' ? contracts.nativeTool : contracts.text);
  const contract = rawContract.split('{{LENS}}').join(lens);
  if (/\{\{[A-Z_]+\}\}/u.test(contract)) throw new Error('child output contract has unresolved placeholders');
  const template = lens === 'blind' ? policy.portableContract.blindPrompt : policy.portableContract.sharedPrompt;
  if (!template.includes('{{OUTPUT_CONTRACT}}')) throw new Error('policy prompt is missing the output contract placeholder');
  const rendered = template.replace('{{OUTPUT_CONTRACT}}', () => contract);
  const prompt = lens === 'blind'
    ? renderTemplateOnce(rendered, {
      // The blind child's only grounding: the exact paths its location
      // fields may cite, alongside the diff those citations are checked
      // against. Prose in location was the recurring blind failure.
      '{{CHUNK_FILES}}': selected.files.map((file) => `- ${file}`).join('\n'),
      '{{DIFF}}': selected.diff,
    })
    : renderTemplateOnce(rendered, {
      '{{PROJECT_CONVENTIONS}}': review.projectConventions,
      '{{DIFF}}': selected.diff,
      '{{SPEC_CONTEXT}}': review.specContext,
      '{{LENS_BRIEF}}': policy.portableContract.lenses[lens],
      '{{LENS}}': lens,
    });
  // A retry is corrective, not a blind repeat: the host delivers the previous
  // attempt's exact failure class and reason in the child's own contract.
  if (retry === undefined || retry.attempt <= 1) return prompt;
  const correction = retryCorrection(output, retry.previous);
  if (lens !== 'blind') return `${prompt}\n\n--- RETRY CORRECTION (attempt ${retry.attempt}) ---\n${correction}`;
  // Blind children cannot re-read anything, so their retry restates the
  // locatable-evidence contract on top of the exact rejection: the recurring
  // failure is prose inside location even when the snippet was verbatim.
  return `${prompt}\n\n--- RETRY CORRECTION (attempt ${retry.attempt}) ---\n${correction}\n${blindEvidenceCorrection(retry.previous)}`;
}

/** The reason carried by an abort signal, or the generic cancellation error
 * for signals aborted without one. */
function abortReasonFor(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('review operation aborted');
}

function coverageAttemptLine(failure: CoverageAttemptFailure): string {
  const reason = failure.error.replace(/[\r\n]+/gu, ' ').trim().slice(0, 200);
  return `attempt ${failure.attempt} ${failure.status} (${failure.failureKind}): ${reason}`;
}

/** Thrown the moment a required lens/chunk has spent every allowed attempt
 * without a valid result: the round cannot complete, so the host aborts it
 * before the lead can consume terminal submissions against a dead gate. */
export class CoverageExhaustedError extends Error {
  readonly roundId: string;
  readonly exhausted: readonly ExhaustedCoverage[];

  constructor(roundId: string, exhausted: readonly ExhaustedCoverage[]) {
    const details = exhausted
      .map((entry) => `${entry.lens}/${entry.chunk} (${entry.attempts.map(coverageAttemptLine).join('; ')})`)
      .join(' | ');
    super(`round cannot complete: coverage exhausted (round ${roundId}): ${details}`);
    this.name = 'CoverageExhaustedError';
    this.roundId = roundId;
    this.exhausted = exhausted;
  }
}

/** Corrective instruction for a retry attempt, built from the host's exact
 * previous rejection so the child can fix what failed. The instruction keeps
 * the child's own output contract (native tool vs. bare text array). */
function retryCorrection(output: ChildOutputMode, previous: CoverageAttemptFailure): string {
  const reason = previous.error.replace(/[\r\n]+/gu, ' ').trim().slice(0, 400);
  if (output === 'nativeTool') {
    return `Previous attempt rejected (${previous.failureKind}): ${reason}. Retry the same task and call ${FINDINGS_TOOL_NAME} exactly once with the full corrected { "findings": [...] } payload; findings in assistant text are ignored.`;
  }
  return `Previous output rejected (${previous.failureKind}): ${reason}; output ONLY the bare JSON array.`;
}

/** Blind retries reply to the exact rejection with the locatable-evidence
 * contract instead of only naming it. The host's own check failed the cited
 * location; the child must re-cite as `<path>:<line>` and recite the snippet. */
function blindEvidenceCorrection(previous: CoverageAttemptFailure): string {
  const reason = previous.error.replace(/[\r\n]+/gu, ' ').trim().slice(0, 400);
  return `Your previous submission was rejected because ${reason}. Re-cite every finding with ` +
    '"location" as "<path>:<line>" — the exact file path from FILES IN THIS CHUNK, a colon, then the line or line range, with NO function names or prose inside location — and ' +
    '"evidence" as ONE contiguous snippet recited verbatim from that path\'s hunks.';
}

/** Every required coverage key whose full attempt budget was spent without a
 * valid result: those keys can never become valid again. */
function exhaustedRequiredCoverage(
  expected: ReadonlySet<string>,
  attempts: ReadonlyMap<string, number>,
  validCoverage: ReadonlySet<string>,
  failureLog: ReadonlyMap<string, readonly CoverageAttemptFailure[]>,
  maxAttempts: number,
): readonly ExhaustedCoverage[] {
  const exhausted: ExhaustedCoverage[] = [];
  for (const key of expected) {
    if (validCoverage.has(key) || (attempts.get(key) ?? 0) < maxAttempts) continue;
    const separator = key.indexOf('\0');
    exhausted.push({
      lens: key.slice(0, separator) as PerkinsLens,
      chunk: key.slice(separator + 1),
      attempts: failureLog.get(key) ?? [],
    });
  }
  return exhausted;
}

/** A review turn exceeded its host budget. Classified separately from output
 * failures so the audit distinguishes load from a rejected output. */
class ReviewTurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`review turn timed out after ${timeoutMs}ms`);
    this.name = 'ReviewTurnTimeoutError';
  }
}

async function boundedPrompt(
  handle: AgentHandle,
  prompt: string,
  timeoutMs: number,
  signals: readonly (AbortSignal | undefined)[] = [],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectAbort: ((error: Error) => void) | null = null;
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    for (const signal of signals) {
      if (signal === undefined) continue;
      if (signal.aborted) {
        reject(abortReasonFor(signal));
        return;
      }
      const listener = () => rejectAbort?.(abortReasonFor(signal));
      listeners.push({ signal, listener });
      signal.addEventListener('abort', listener, { once: true });
    }
  });
  try {
    await Promise.race([
      handle.prompt(prompt, { owner: REVIEW_OWNER }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReviewTurnTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
      abort,
    ]);
  } finally {
    rejectAbort = null;
    if (timer !== null) clearTimeout(timer);
    for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
  }
}

async function boundedSpawn(
  spawn: () => Promise<AgentHandle>,
  timeoutMs: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<AgentHandle> {
  const preAborted = signals.find((signal) => signal?.aborted === true);
  if (preAborted !== undefined) throw abortReasonFor(preAborted);
  const spawning = spawn();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = new Promise<never>((_resolve, reject) => {
    for (const signal of signals) {
      if (signal === undefined) continue;
      if (signal.aborted) {
        reject(abortReasonFor(signal));
        return;
      }
      const listener = () => reject(abortReasonFor(signal));
      listeners.push({ signal, listener });
      signal.addEventListener('abort', listener, { once: true });
    }
  });
  try {
    return await Promise.race([
      spawning,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`review spawn timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
      abort,
    ]);
  } catch (error) {
    // A runtime spawn may not accept AbortSignal. If it resolves after our
    // bound, dispose it immediately so no unowned session survives.
    void spawning.then((handle) => handle.dispose()).catch(() => {});
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
  }
}

async function pool<T, U>(items: readonly T[], concurrency: number, run: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  return results;
}

export class PerkinsHybridReview {
  private readonly spawner: AgentSpawner;
  private readonly policy: PerkinsPolicy;
  private readonly onProgress: (progress: ReviewProgress) => void;
  private readonly onAgent: NonNullable<PerkinsHybridReviewOptions['onAgent']>;

  constructor(options: PerkinsHybridReviewOptions) {
    this.spawner = options.spawner;
    this.policy = options.policy;
    this.onProgress = options.onProgress ?? (() => {});
    this.onAgent = options.onAgent ?? (() => {});
  }

  async run(input: RunPerkinsHybridInput): Promise<PerkinsHybridResult> {
    const review = input.frozenReview;
    assertFrozenPromptBounds(review);
    const lenses = input.noSpec
      ? this.policy.portableContract.rules.noSpecLenses
      : this.policy.portableContract.rules.fullLenses;
    const expected = new Set(review.chunks.flatMap((chunk) => lenses.map((lens) => `${lens}\0${chunk.id}`)));
    const priorReview = loadPriorReview(input.priorConsolidatedFile);
    const prior = priorReview.findings;
    const attempts = new Map<string, number>();
    // Host-side bounds restore attempt counters so coverage stays retryable;
    // every child run therefore writes artifacts under a unique run token so
    // a restored retry cannot collide with the write-once artifact store.
    const restoreAttempts = (scheduled: ReadonlyArray<{ key: string }> ): void => {
      for (const run of scheduled) {
        const priorAttempt = attempts.get(run.key) ?? 0;
        if (priorAttempt <= 1) attempts.delete(run.key);
        else attempts.set(run.key, (priorAttempt - 1) as 1 | 2);
      }
    };
    const validCoverage = new Set<string>();
    const results = new Map<string, ChildResult>();
    const candidates = new Map<string, ChildCandidate>();
    // Host-recorded non-valid attempts per coverage key: the corrective retry
    // instruction and the round-abort escalation both read from here.
    const failureLog = new Map<string, CoverageAttemptFailure[]>();
    // The host's immediate stop signal: aborting it cancels the lead turn and
    // every child prompt the moment the round can no longer complete.
    const roundAbort = new AbortController();
    const roundAbortReason = (): Error => abortReasonFor(roundAbort.signal);
    const externallyAborted = (): boolean => input.signal?.aborted === true;
    const envelopes: LensEnvelope[] = [];
    const leadArtifacts = new Set<string>();
    const readChunks = new Set<string>();
    const agentIds = new Set<string>();
    const sessionFiles = new Set<string>();
    // Frozen-tree proof lookups are immutable per round: one cache per run
    // serves child-side evidence checks and every preflight/submission pass.
    const proofCache = newProofCache();
    const recordedDecisions = new Map<string, CandidateDecision>();
    let lastRejectedSubmission: LeadSubmission | null = null;
    let lastRejectionOversized = false;
    let recordAttempts = 0;
    let deltaSubmissions = 0;
    let terminalAttempts = 0;
    let preflightAttempts = 0;
    let accepted: PerkinsHybridResult | null = null;

    const registerIsolatedHandle = (handle: AgentHandle, phase: 'lead' | 'lens'): void => {
      if (handle.reviewIsolation !== true) throw new Error(`${phase} handle is not review-isolated`);
      if (handle.id.trim() === '' || agentIds.has(handle.id)) throw new Error(`duplicate or empty review agent id: ${handle.id}`);
      if (handle.sessionFile === null || !isAbsolute(handle.sessionFile)) throw new Error(`${phase} session is not durably identified`);
      const sessionFile = resolve(handle.sessionFile);
      if (sessionFiles.has(sessionFile)) throw new Error(`duplicate review session file: ${sessionFile}`);
      agentIds.add(handle.id);
      sessionFiles.add(sessionFile);
    };

    const runChild = async (
      lens: PerkinsLens,
      chunk: string,
      attempt: 1 | 2,
      previous: CoverageAttemptFailure | undefined,
      signal?: AbortSignal,
    ): Promise<ChildResult> => {
      this.onProgress({ lens, chunk, state: 'running' });
      let handle: AgentHandle | null = null;
      let raw: string | null = null;
      /** Set only when the child's own output failed recovery/validation or
       * construction-time evidence pairing: host errors stay 'error'. */
      let outputRejected = false;
      /** Valid structured submission captured from perkins_submit_findings
       * (native-tool children); its exact JSON bytes are the durable output. */
      let submitted: { readonly json: string; readonly findings: readonly ReviewFinding[] } | null = null;
      /** Read through a getter: the tool handler assigns during the awaited
       * turn, so outer control flow must not assume the captured value. */
      const capturedSubmission = (): { readonly json: string; readonly findings: readonly ReviewFinding[] } | null => submitted;
      /** Last schema rejection the tool reported, so a no-submission run can
       * name the precise failure instead of a generic absence. */
      let submissionError: string | null = null;
      /** Last rejected structured submission, kept as durable audit evidence. */
      let rejectedSubmission: string | null = null;
      /** Transport outcome; a captured submission outranks it. */
      let turnError: unknown = null;
      let promptResolved = false;
      let nativeSubmit = false;
      const runToken = randomUUID().slice(0, 8);
      // The child's only findings channel on a native-tool runtime: the
      // runtime enforces JSON shape, the host validates the exact schema,
      // and no assistant text is ever parsed back.
      const submitFindingsTool: NativeAgentTool = {
        name: FINDINGS_TOOL_NAME,
        description:
          'Submit ALL findings for this lens run as structured JSON: { findings: [...] }. ' +
          'The host validates every entry against the exact finding schema and records the run; ' +
          'findings in assistant text are ignored. Call exactly once; an empty findings array is a valid result.',
        inputSchema: FINDINGS_INPUT_SCHEMA,
        execute: async (toolInput, toolSignal) => {
          if (input.signal?.aborted === true || signal?.aborted === true || toolSignal?.aborted === true) {
            throw new Error('review operation aborted');
          }
          if (submitted !== null) throw new Error('findings were already submitted for this lens run');
          try {
            const findings = parseFindingsSubmission(toolInput, lens);
            submitted = { json: JSON.stringify(toolInput), findings };
            return {
              text: JSON.stringify({ accepted: true, lens, findingCount: findings.length }),
              details: { accepted: true, lens, findingCount: findings.length },
              terminate: true,
            };
          } catch (error) {
            submissionError = sanitizeError(error);
            rejectedSubmission = JSON.stringify(toolInput);
            throw error;
          }
        },
      };
      try {
        handle = await boundedSpawn(() => this.spawner('perkins', {
          // The blind child is rooted OUTSIDE the repository: even a future
          // tool leak would find no repo to read. Other children read the
          // frozen tree.
          cwd: lens === 'blind' ? review.directory : review.manifest.repoPath,
          isolatedReview: {
            systemPrompt: lens === 'blind' ? BLIND_SYSTEM_PROMPT : LENS_SYSTEM_PROMPT,
            tools: lens === 'blind' ? [] : ['read', 'grep', 'find', 'ls'],
            nativeTools: [submitFindingsTool],
          },
        }), CHILD_SPAWN_TIMEOUT_MS, [signal, input.signal, roundAbort.signal]);
        registerIsolatedHandle(handle, 'lens');
        this.onAgent({ phase: 'lens', lens, chunk, attempt, handle });
        // The hosting runtime declares the tools it actually wired: a
        // native-tool child is tool-only, a text child (non-pi runtimes)
        // keeps the tolerant text path. The request alone proves nothing.
        nativeSubmit = handle.reviewTools?.includes(FINDINGS_TOOL_NAME) === true;
        await boundedPrompt(
          handle,
          renderLensPrompt(
            this.policy, review, lens, chunk, nativeSubmit ? 'nativeTool' : 'text',
            attempt > 1 && previous !== undefined ? { attempt, previous } : undefined,
          ),
          CHILD_TURN_TIMEOUT_MS,
          [signal, input.signal, roundAbort.signal],
        );
        promptResolved = true;
      } catch (error) {
        turnError = error;
      }
      try {
        if (handle === null) throw turnError ?? new Error('lens child did not spawn');
        if (handle.sessionFile === null) throw new Error('lens child session is not durable');
        let reviewFindings: readonly ReviewFinding[];
        let outputBytes: string;
        let recovery: LensOutputRecovery | undefined;
        if (nativeSubmit) {
          const submission = capturedSubmission();
          if (submission === null) {
            // A captured submission outranks a later turn failure; a run
            // without one is invalid (retriable) and names the last schema
            // rejection rather than a generic absence.
            if (turnError !== null) throw turnError;
            outputRejected = true;
            throw new Error(submissionError ?? `lens child did not submit findings via ${FINDINGS_TOOL_NAME}`);
          }
          reviewFindings = submission.findings;
          outputBytes = submission.json;
        } else {
          if (turnError !== null) throw turnError;
          const text = finalAssistantText(handle.sessionFile);
          raw = text;
          let parsed: ReturnType<typeof parseFindingsWithRecovery>;
          try {
            parsed = parseFindingsWithRecovery(text, lens);
          } catch (error) {
            outputRejected = true;
            throw error;
          }
          reviewFindings = parsed.findings;
          recovery = parsed.recovery;
          outputBytes = text;
        }
        const visibleFindings = reviewFindings.filter((finding) =>
          !(finding.source === 'tests' && finding.category === 'coverage-gate'),
        );
        // Evidence pairing is enforced at envelope construction: a finding
        // that cites a real file must quote that file (or its frozen diff),
        // not a sibling file. The cheapest failure point is the child attempt
        // itself, so the lead never inherits an unmixable candidate; a failed
        // attempt stays retryable within the pinned lens bound.
        for (const [findingIndex, finding] of reviewFindings.entries()) {
          if (finding.evidence === 'N/A' || finding.evidence.trim() === '') continue;
          const citedPath = findingPath(finding);
          if (citedPath === null || finding.location === 'N/A') continue;
          if (!evidenceAtCitedLocation(review, finding, finding.evidence, proofCache)) {
            outputRejected = true;
            throw new Error(
              `lens finding ${findingIndex} evidence is not locatable at its cited file/hunk: ${finding.location}`,
            );
          }
        }
        // The tests lens's validated coverage gate is host-owned evidence:
        // carried into terminal proof so a FAIL gate blocks the verdict.
        const gate = reviewFindings.find((finding) => finding.source === 'tests' && finding.category === 'coverage-gate');
        const coverageGate = gate === undefined ? undefined : (/^Coverage gate: (PASS|CONCERNS|FAIL)$/u.exec(gate.title)?.[1] as 'PASS' | 'CONCERNS' | 'FAIL' | undefined);
        const resultId = `${lens}-${chunk}-a${attempt}-${hash(handle.id).slice(0, 16)}`;
        const childCandidates = visibleFindings.map((finding, findingIndex): ChildCandidate => ({
          ...finding,
          ref: `${resultId}#${findingIndex}`,
          chunk,
          resultId,
          findingIndex,
        }));
        const envelope: LensEnvelope = {
          schemaVersion: 1, lens, chunk, attempt, status: 'valid', outputSha256: hash(outputBytes), findings: reviewFindings,
          ...(recovery !== undefined ? { recovery } : {}),
        };
        envelopes.push(envelope);
        writeReviewArtifact(review, `lenses/${chunk}/${lens}.attempt-${attempt}-${runToken}.raw.json`, `${outputBytes}\n`);
        writeReviewArtifact(review, `lenses/${chunk}/${lens}.attempt-${attempt}-${runToken}.envelope.json`, envelope);
        const result: ChildResult = {
          resultId, agentId: handle.id, lens, chunk, attempt, status: 'valid', findings: childCandidates,
          ...(coverageGate !== undefined ? { coverageGate } : {}),
        };
        writeReviewArtifact(review, `children/${resultId}.json`, result);
        this.onProgress({ lens, chunk, state: 'done', note: `${visibleFindings.length} candidate(s)` });
        return result;
      } catch (error) {
        const message = sanitizeError(error);
        // A tool-capable child that finished its turn without submitting still
        // leaves assistant output behind: keep it as failure evidence (never
        // parsed back into findings).
        if (raw === null && nativeSubmit && promptResolved && handle !== null && handle.sessionFile !== null) {
          try {
            raw = finalAssistantText(handle.sessionFile);
          } catch {
            // No durable assistant text: the tool failure reason stands alone.
          }
        }
        // A child that finished its turn without a recordable result is an
        // output failure (invalid, retriable); a failed spawn/turn with no
        // output at all stays a transport failure. The failure kind records
        // precisely which class fired: timeout (host turn budget), output
        // (rejected/submitted output), or error (host/runtime).
        const failureKind: ChildFailureKind = error instanceof ReviewTurnTimeoutError
          ? 'timeout'
          : outputRejected ? 'output' : 'error';
        const hadOutput = nativeSubmit ? capturedSubmission() !== null || promptResolved : raw !== null;
        const status: ChildResult['status'] = hadOutput ? 'invalid' : 'failed';
        const outputBytes = raw ?? capturedSubmission()?.json ?? rejectedSubmission;
        const envelope: LensEnvelope = {
          schemaVersion: 1, lens, chunk, attempt, status,
          outputSha256: outputBytes === null ? null : hash(outputBytes), findings: [], failureKind, error: message,
        };
        envelopes.push(envelope);
        if (outputBytes !== null) {
          // The try block may have already written this exact run-token path
          // before a later step threw; tolerate the collision (write-once).
          try {
            writeReviewArtifact(review, `lenses/${chunk}/${lens}.attempt-${attempt}-${runToken}.raw.json`, `${outputBytes}\n`);
          } catch (writeError) {
            if (!(writeError instanceof Error && 'code' in writeError && (writeError as { code?: string }).code === 'EEXIST')) throw writeError;
          }
        }
        for (const [suffix, value] of [
          [`.error.json`, { error: message } as unknown],
          [`.envelope.json`, envelope as unknown],
        ] as const) {
          try {
            writeReviewArtifact(review, `lenses/${chunk}/${lens}.attempt-${attempt}-${runToken}${suffix}`, value);
          } catch (writeError) {
            if (!(writeError instanceof Error && 'code' in writeError && (writeError as { code?: string }).code === 'EEXIST')) throw writeError;
          }
        }
        this.onProgress({ lens, chunk, state: 'error', note: `${failureKind}: ${message}` });
        return {
          resultId: `failed-${lens}-${chunk}-a${attempt}`,
          agentId: handle?.id ?? 'spawn-failed', lens, chunk, attempt,
          status, findings: [], failureKind, error: message,
        };
      } finally {
        await handle?.dispose();
      }
    };

    // Tool protocols may deliver multiple calls concurrently. Serialize the
    // scheduling mutation so attempt accounting is atomic and the child pool's
    // concurrency bound applies to the whole round, not merely one tool call.
    let runToolTail: Promise<void> = Promise.resolve();
    const serializeRunTool = <T>(operation: () => Promise<T>): Promise<T> => {
      const current = runToolTail.then(operation, operation);
      runToolTail = current.then(() => undefined, () => undefined);
      return current;
    };

    const runTool: NativeAgentTool = {
      name: 'perkins_run_lenses',
      description: `Start and await 1-${MAX_TOOL_RUNS} host-tracked lens children. Each run must name one required lens and frozen chunk. The host enforces isolation, attempts, concurrency, output validation, durability and ownership.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['runs'],
        properties: {
          runs: {
            type: 'array', minItems: 1, maxItems: MAX_TOOL_RUNS,
            items: {
              type: 'object', additionalProperties: false, required: ['lens', 'chunk'],
              properties: {
                lens: { type: 'string', enum: [...lenses] },
                chunk: { type: 'string', enum: review.chunks.map((chunk) => chunk.id) },
              },
            },
          },
        },
      },
      execute: (raw, signal) => serializeRunTool(async () => {
        if (roundAbort.signal.aborted) throw roundAbortReason();
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        if (accepted !== null) throw new Error('review already has an accepted terminal submission');
        const value = record(raw, 'perkins_run_lenses input');
        exactKeys(value, ['runs'], 'perkins_run_lenses input');
        if (!Array.isArray(value.runs) || value.runs.length < 1 || value.runs.length > MAX_TOOL_RUNS) {
          throw new Error(`runs must contain 1-${MAX_TOOL_RUNS} entries`);
        }
        const requested = value.runs.map((entry, index) => {
          const run = record(entry, `run ${index}`);
          exactKeys(run, ['lens', 'chunk'], `run ${index}`);
          if (typeof run.lens !== 'string' || !lenses.includes(run.lens as PerkinsLens)) throw new Error(`run ${index} lens is not required`);
          if (typeof run.chunk !== 'string' || !review.chunks.some((chunk) => chunk.id === run.chunk)) throw new Error(`run ${index} chunk is unknown`);
          return { lens: run.lens as PerkinsLens, chunk: run.chunk };
        });
        const keys = requested.map((run) => `${run.lens}\0${run.chunk}`);
        if (new Set(keys).size !== keys.length) throw new Error('one tool call cannot duplicate a lens/chunk');
        const scheduled = requested.map((run, index) => {
          const key = keys[index]!;
          if (!expected.has(key)) throw new Error(`run ${index} is outside required coverage`);
          if (validCoverage.has(key)) throw new Error(`coverage ${run.lens}/${run.chunk} is already valid`);
          const priorAttempt = attempts.get(key) ?? 0;
          if (priorAttempt >= this.policy.portableContract.rules.maxLensAttempts) throw new Error(`coverage ${run.lens}/${run.chunk} exhausted its attempts`);
          return { ...run, key, attempt: (priorAttempt + 1) as 1 | 2, previous: failureLog.get(key)?.at(-1) };
        });
        for (const run of scheduled) attempts.set(run.key, run.attempt);
        let childResults: readonly ChildResult[];
        try {
          childResults = await pool(scheduled, CHILD_CONCURRENCY, (run) => runChild(run.lens, run.chunk, run.attempt, run.previous, signal));
        } catch (error) {
          restoreAttempts(scheduled);
          throw error;
        }
        if (accepted !== null) {
          restoreAttempts(scheduled);
          throw new Error('review already has an accepted terminal submission');
        }
        const payload = JSON.stringify({ results: childResults });
        const nextCandidates = childResults.flatMap((result) => result.status === 'valid' ? result.findings : []);
        try {
          if (Buffer.byteLength(payload) > MAX_TRANSPORT_CHUNK_BYTES) {
            throw new Error('lens result batch exceeds the bounded tool response');
          }
          if (candidates.size + nextCandidates.length > MAX_TOTAL_CANDIDATES) {
            throw new Error(`review exceeds ${MAX_TOTAL_CANDIDATES} candidates`);
          }
          if (nextCandidates.some((candidate) => candidates.has(candidate.ref))) {
            throw new Error('lens result batch contains a duplicate candidate reference');
          }
        } catch (error) {
          // Host-side bounds are not child-quality failures: restore the
          // attempt counters so the lens/chunk stays retryable.
          restoreAttempts(scheduled);
          throw error;
        }
        // Commit ownership/coverage only after the exact response bytes have
        // passed every host-side bound. A rejected response cannot silently
        // satisfy terminal proof.
        for (const result of childResults) {
          results.set(result.resultId, result);
          const key = `${result.lens}\0${result.chunk}`;
          if (result.status !== 'valid') {
            const failures = failureLog.get(key) ?? [];
            failureLog.set(key, [...failures, {
              attempt: result.attempt,
              status: result.status,
              failureKind: result.failureKind ?? 'error',
              error: result.error ?? 'no host-recorded reason',
            }]);
            continue;
          }
          validCoverage.add(key);
          for (const candidate of result.findings) candidates.set(candidate.ref, candidate);
        }
        // A required lens/chunk that spent its whole attempt budget without a
        // valid result can never satisfy the coverage gate. Abort the round
        // now — before the lead burns terminal submissions on a dead gate —
        // and hand the lead turn the exact per-attempt failure record.
        if (!externallyAborted() && !roundAbort.signal.aborted) {
          const exhausted = exhaustedRequiredCoverage(
            expected,
            attempts,
            validCoverage,
            failureLog,
            this.policy.portableContract.rules.maxLensAttempts,
          );
          if (exhausted.length > 0) {
            const error = new CoverageExhaustedError(input.roundId, exhausted);
            try {
              writeReviewArtifact(review, 'coverage-exhausted.json', {
                schemaVersion: 1,
                roundId: input.roundId,
                reason: 'coverage_exhausted',
                exhausted,
              });
            } catch (writeError) {
              if (!(writeError instanceof Error && 'code' in writeError && (writeError as { code?: string }).code === 'EEXIST')) throw writeError;
            }
            roundAbort.abort(error);
            throw error;
          }
        }
        return {
          text: payload,
          details: { resultCount: childResults.length, candidateCount: nextCandidates.length },
        };
      }),
    };

    const artifactTool: NativeAgentTool = {
      name: 'perkins_store_artifact',
      description: 'Store a bounded lead-authored investigation note under this round. It cannot write the repository or historical review artifacts.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['name', 'content'],
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\\.(md|json)$' },
          content: { type: 'string', minLength: 1, maxLength: MAX_LEAD_ARTIFACT_BYTES },
        },
      },
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        const value = record(raw, 'perkins_store_artifact input');
        exactKeys(value, ['name', 'content'], 'perkins_store_artifact input');
        const name = boundedString(value.name, 'artifact name', 86);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:md|json)$/.test(name)) throw new Error('artifact name is invalid');
        const content = boundedString(value.content, 'artifact content', MAX_LEAD_ARTIFACT_BYTES);
        if (leadArtifacts.size >= MAX_LEAD_ARTIFACTS || leadArtifacts.has(name)) throw new Error('lead artifact limit or duplicate reached');
        const file = writeReviewArtifact(review, `lead/notes/${name}`, content);
        leadArtifacts.add(name);
        return { text: JSON.stringify({ stored: name, sha256: hash(content) }), details: { file, sha256: hash(content) } };
      },
    };

    const chunkTool: NativeAgentTool = {
      name: 'perkins_read_chunk',
      description: 'Read one frozen diff chunk (id, files, line count, full diff bytes) from this round. Read-only.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['chunk'],
        properties: { chunk: { type: 'string', enum: review.chunks.map((chunk) => chunk.id) } },
      },
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        const value = record(raw, 'perkins_read_chunk input');
        exactKeys(value, ['chunk'], 'perkins_read_chunk input');
        const selected = review.chunks.find((chunk) => chunk.id === value.chunk);
        if (selected === undefined) throw new Error('unknown frozen chunk');
        const payload = JSON.stringify(selected);
        if (Buffer.byteLength(payload) > MAX_TRANSPORT_CHUNK_BYTES) throw new Error('frozen chunk exceeds the bounded tool response');
        readChunks.add(selected.id);
        return { text: payload, details: { id: selected.id } };
      },
    };

    const priorDeltaTool: NativeAgentTool | null = priorReview.targetSha === null ? null : {
      name: 'perkins_read_prior_delta',
      description: 'List changed paths between the prior frozen target and this frozen target with {}, or read one path-paired canonical text hunk with {"path":"relative/file"}. Read-only; binary callers cannot supply proof.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1, maxLength: 500 } },
      },
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        const value = record(raw, 'perkins_read_prior_delta input');
        exactKeys(value, value.path === undefined ? [] : ['path'], 'perkins_read_prior_delta input');
        const priorTargetSha = priorReview.targetSha!;
        const changes = deltaPaths(review, priorTargetSha, proofCache);
        const selection = value.path;
        let payload: string;
        if (selection === undefined) {
          payload = JSON.stringify({ priorTargetSha, targetSha: review.manifest.targetSha, changes });
        } else {
          if (typeof selection !== 'string' || !safeFixPath(selection)) throw new Error('prior delta path must be a bounded safe relative file path');
          const entry = isolatedDeltaPath(changes, selection);
          const patch = canonicalPathPatch(review, priorTargetSha, entry, proofCache);
          if (patch === null) throw new Error(`prior delta path ${selection} has a binary caller blob`);
          payload = JSON.stringify({ priorTargetSha, targetSha: review.manifest.targetSha, ...entry, diff: patch });
        }
        if (Buffer.byteLength(payload, 'utf8') > MAX_TRANSPORT_CHUNK_BYTES) {
          throw new Error('prior delta response exceeds the bounded tool transport; select a smaller caller path');
        }
        return { text: payload, details: { priorTargetSha, targetSha: review.manifest.targetSha } };
      },
    };

    const validationContext: SubmissionValidationContext = {
      review,
      movementRef: input.movementRef,
      roundNumber: input.roundNumber,
      candidates,
      prior,
      priorTargetSha: priorReview.targetSha,
      expected,
      validCoverage,
      readChunks,
      results,
      lenses,
    };

    const priorAuditItemSchema = {
      type: 'object', additionalProperties: false,
      required: [...PRIOR_AUDIT_KEYS],
      properties: {
        prior_index: { type: 'integer', minimum: 0 },
        status: { type: 'string', enum: ['fixed', 'still-present'] },
        evidence: { type: 'string', minLength: 1, maxLength: 4_000 },
        reason: { type: 'string', minLength: 1, maxLength: 1_000 },
        fix_location: {
          type: 'object', additionalProperties: false, required: ['path', 'change'],
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 500 },
            change: { type: 'string', enum: ['added', 'removed'] },
          },
        },
      },
    };
    const fullSubmissionSchema = {
      type: 'object', additionalProperties: false,
      required: ['canonical_verdict', 'candidate_decisions', 'prior_audit', 'report_markdown'],
      properties: {
        canonical_verdict: { type: 'string', enum: ['READY TO MERGE', 'NEEDS CHANGES', 'MAJOR REWORK NEEDED', 'INCOMPLETE'] },
        candidate_decisions: { type: 'array', maxItems: MAX_TOTAL_CANDIDATES, items: { type: 'object' } },
        prior_audit: { type: 'array', maxItems: 10_000, items: priorAuditItemSchema },
        report_markdown: { type: 'string', minLength: 1, maxLength: PERKINS_REPORT_MAX_BYTES },
      },
    };
    const deltaSubmissionSchema = {
      type: 'object', additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['delta'] },
        canonical_verdict: { type: 'string', enum: ['READY TO MERGE', 'NEEDS CHANGES', 'MAJOR REWORK NEEDED', 'INCOMPLETE'] },
        candidate_decisions: { type: 'array', maxItems: MAX_TOTAL_CANDIDATES, items: { type: 'object' } },
        prior_audit: { type: 'array', maxItems: 10_000, items: priorAuditItemSchema },
        report_markdown: { type: 'string', minLength: 1, maxLength: PERKINS_REPORT_MAX_BYTES },
      },
    };
    // Provider-facing declaration only: the code validator is the exhaustive
    // authority. The root MUST carry `type: 'object'`: OpenAI-compatible
    // providers (deepseek) reject any function whose schema root has no
    // object type before reading the `oneOf` branches, with a 400 that
    // misreports the root as `type: null`. Both submission shapes remain
    // declared beneath the typed root.
    const submissionSchema = {
      type: 'object',
      oneOf: [fullSubmissionSchema, deltaSubmissionSchema],
    };

    /** Validate-at-store entry point: the same single decision validator the
     * terminal pass runs, applied to one candidate decision. Clean decisions
     * are kept in the round record and merged into the final submission. */
    const recordTool: NativeAgentTool = {
      name: 'perkins_record_decision',
      description: 'Validate one candidate decision immediately with the exact rules perkins_submit_review enforces for it and, when clean, record it in the round decision record. A final submission may then carry only changed fields; recorded decisions are merged host-side and re-validated as the whole. Recording spends no terminal attempt and accepts nothing.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: [...CANDIDATE_DECISION_KEYS],
        properties: {
          candidate_ref: { type: 'string' },
          disposition: { type: 'string', enum: ['confirmed', 'rejected', 'unverifiable-speculative'] },
          evidence: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        if (accepted !== null) throw new Error('review already has an accepted terminal submission');
        recordAttempts += 1;
        const issues: SubmissionValidationIssue[] = [];
        let decision: CandidateDecision | null = null;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          issues.push({ subject: 'candidate decision', rule: 'candidate-decision-shape', message: 'candidate decision must be an object' });
        } else {
          decision = parseDecisionEntry(raw, 0, issues).decision;
          if (decision !== null) issues.push(...this.validateDecision(validationContext, decision, proofCache));
        }
        const ok = issues.length === 0 && decision !== null;
        if (ok) recordedDecisions.set(decision!.candidate_ref, decision!);
        const bounded = boundedIssues(issues);
        writeReviewArtifact(review, `lead/record-attempt-${recordAttempts}.json`, {
          schemaVersion: 1,
          ok,
          ...(decision !== null ? { decision } : { raw_decision: raw }),
          errorCount: issues.length,
          errors: issues,
        });
        return {
          text: JSON.stringify({
            record: true,
            recorded: ok,
            ok,
            ...(decision !== null ? { candidate_ref: decision.candidate_ref } : {}),
            recordedCount: recordedDecisions.size,
            errorCount: issues.length,
            errors: bounded.errors,
            ...(bounded.omitted > 0 ? { omittedErrorCount: bounded.omitted } : {}),
          }),
          details: {
            record: true, recorded: ok, ok, errorCount: issues.length,
            recordAttempt: recordAttempts, recordedCount: recordedDecisions.size,
          },
        };
      },
    };

    /** Validation-only entry point: the exact same validator as submission,
     * no terminal attempt consumed, no sealing, no termination. */
    const preflightTool: NativeAgentTool = {
      name: 'perkins_preflight_submission',
      description: 'Validate a candidate terminal submission — a full payload or a {"mode":"delta"} amendment over the stored rejection/decision record — with the exact rules perkins_submit_review enforces, without spending a terminal attempt and without sealing the round. Returns the complete exhaustive error list in one response; ok=true means the same payload would be accepted. Preflight accepts nothing and never terminates.',
      inputSchema: submissionSchema,
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        if (accepted !== null) throw new Error('review already has an accepted terminal submission');
        preflightAttempts += 1;
        const state: SubmissionState = { recordedDecisions, lastRejected: lastRejectedSubmission, lastRejectionOversized };
        const validation = this.validateSubmission(validationContext, raw, state, proofCache);
        const errors = validation.ok ? [] : validation.errors;
        const bounded = boundedIssues(errors);
        const mode = isDeltaEnvelope(raw) ? 'delta' : 'full';
        writeReviewArtifact(review, `lead/preflight-attempt-${preflightAttempts}.json`, {
          schemaVersion: 1,
          mode,
          ok: validation.ok,
          errorCount: errors.length,
          errors,
          submission: validation.submission,
          ...(validation.submission === null ? { raw_submission: raw } : {}),
        });
        return {
          text: JSON.stringify({
            preflight: true,
            mode,
            ok: validation.ok,
            errorCount: errors.length,
            errors: bounded.errors,
            ...(bounded.omitted > 0 ? { omittedErrorCount: bounded.omitted } : {}),
          }),
          details: {
            preflight: true,
            mode,
            ok: validation.ok,
            errorCount: errors.length,
            preflightAttempt: preflightAttempts,
          },
        };
      },
    };

    const submitTool: NativeAgentTool = {
      name: 'perkins_submit_review',
      description: 'Submit the lead-authored terminal proof and report, either as a full payload or as {"mode":"delta"} carrying only changed fields over the stored rejection/decision record. The host rejects missing coverage, foreign/missing candidates, unsupported verification, incomplete prior audits, changed HEAD, or incorrect verdict arithmetic; one rejection lists every violation in a single response.',
      inputSchema: submissionSchema,
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        terminalAttempts += 1;
        if (terminalAttempts > MAX_TERMINAL_ATTEMPTS) throw new Error('terminal submission attempts exhausted');
        const attempt = terminalAttempts;
        if (isDeltaEnvelope(raw)) deltaSubmissions += 1;
        try {
          if (accepted !== null) throw new Error('review already has an accepted terminal submission');
          if (isDeltaEnvelope(raw)) {
            writeReviewArtifact(review, `lead/submission-attempt-${attempt}.delta.json`, { schemaVersion: 1, delta: raw });
          }
          const state: SubmissionState = { recordedDecisions, lastRejected: lastRejectedSubmission, lastRejectionOversized };
          const validation = this.validateSubmission(validationContext, raw, state, proofCache);
          if (!validation.ok) {
            if (validation.submission !== null) {
              writeReviewArtifact(review, `lead/submission-attempt-${attempt}.json`, validation.submission);
              // A rejected submission becomes the amend base within the same
              // byte bound the full path can receive; an over-bound rejection
              // is not stored and must be resubmitted whole.
              if (Buffer.byteLength(JSON.stringify(validation.submission), 'utf8') <= PERKINS_STORED_SUBMISSION_MAX_BYTES) {
                lastRejectedSubmission = validation.submission;
                lastRejectionOversized = false;
              } else {
                lastRejectedSubmission = null;
                lastRejectionOversized = true;
              }
            }
            throw new SubmissionRejection(validation.errors);
          }
          const submission = validation.submission;
          writeReviewArtifact(review, `lead/submission-attempt-${attempt}.json`, submission);
          const reportFile = writeReviewArtifact(review, 'perkins-report.md', submission.report_markdown.endsWith('\n') ? submission.report_markdown : `${submission.report_markdown}\n`);
          writeReviewArtifact(review, 'consolidated.json', {
            schemaVersion: 2,
            architecture: 'perkins-hybrid',
            canonicalVerdict: validation.canonicalVerdict,
            completeness: validation.completeness,
            headMoved: validation.headMoved,
            findings: validation.findings,
            priorAudit: validation.priorAudit,
            verificationSummary: validation.verificationSummary,
            frozen: review.manifest,
            childResults: [...results.values()].map((result) => ({
              resultId: result.resultId, agentId: result.agentId, lens: result.lens,
              chunk: result.chunk, attempt: result.attempt, status: result.status,
            })),
          });
          accepted = {
            canonicalVerdict: validation.canonicalVerdict, findings: validation.findings,
            completeness: validation.completeness,
            artifactDirectory: review.directory, reportFile,
            targetSha: review.manifest.targetSha, diffBaseSha: review.manifest.diffBaseSha,
            headMoved: validation.headMoved, lensEnvelopes: [...envelopes],
            priorAudit: validation.priorAudit, verificationSummary: validation.verificationSummary,
          };
          return {
            text: JSON.stringify({ accepted: true, canonicalVerdict: validation.canonicalVerdict, findingCount: validation.findings.length }),
            details: { accepted: true, canonicalVerdict: validation.canonicalVerdict, findingCount: validation.findings.length },
            terminate: true,
          };
        } catch (error) {
          writeReviewArtifact(review, `lead/submission-attempt-${attempt}.error.json`, {
            error: sanitizeError(error),
            ...(error instanceof SubmissionRejection ? { issues: error.issues } : {}),
          });
          throw error;
        }
      },
    };

    const leadTools = [chunkTool, ...(priorDeltaTool === null ? [] : [priorDeltaTool]), runTool, artifactTool, recordTool, preflightTool, submitTool];
    const systemPrompt = [
      this.policy.portableContract.leadWorkflow,
      '',
      '--- PRODUCT-NATIVE TOOL CONTRACT ---',
      'Use perkins_read_chunk to read frozen diff chunks; use perkins_run_lenses to start and receive tracked lens children; use perkins_store_artifact only for optional lead notes; use perkins_record_decision to validate and record each candidate decision as you verify it; use perkins_preflight_submission to validate a candidate terminal submission (full or delta) without spending a terminal attempt; finish by calling perkins_submit_review.',
      ...(priorReview.targetSha === null ? [] : ['On a re-review use perkins_read_prior_delta to list prior-target changes and read canonical caller hunks, including removed files.']),
      'A terminal submission is either a full payload or {"mode":"delta", ...} carrying only changed fields; recorded decisions and the last rejected submission are applied host-side, then the merged whole is validated with the same exhaustive rules. An accepted delta is indistinguishable from an accepted full submission of the same content.',
      'Lens children never inherit these tools. You, the lead, must independently inspect and decide every returned candidate. Do not write implementation files.',
    ].join('\n');
    const initialPrompt = this.leadPrompt(review, lenses, prior, priorReview.targetSha);
    let lead: AgentHandle | null = null;
    let unsubscribe = (): void => {};
    let turns = 0;
    try {
      lead = await boundedSpawn(() => this.spawner('perkins', {
        cwd: review.manifest.repoPath,
        reviewLead: {
          systemPrompt,
          tools: ['read', 'grep', 'find', 'ls'],
          nativeTools: leadTools,
        },
      }), LEAD_SPAWN_TIMEOUT_MS, [input.signal, roundAbort.signal]);
      registerIsolatedHandle(lead, 'lead');
      this.onAgent({ phase: 'lead', handle: lead });
      unsubscribe = lead.subscribe((event) => {
        if (event.type === 'turn_end') {
          turns += 1;
          if (turns > MAX_LEAD_TURNS) void lead?.dispose();
        }
      });
      await boundedPrompt(lead, initialPrompt, LEAD_TOTAL_TIMEOUT_MS, [input.signal, roundAbort.signal]);
      if (roundAbort.signal.aborted) throw roundAbortReason();
      if (input.signal?.aborted === true) throw new Error('review operation aborted');
      if (turns > MAX_LEAD_TURNS) throw new Error(`Perkins lead exceeded ${MAX_LEAD_TURNS} turns`);
      if (accepted === null) throw new Error('Perkins lead exited without an accepted terminal submission');
      writeReviewArtifact(review, 'lead/receipt.json', {
        schemaVersion: 1,
        leadAgentId: lead.id,
        leadSessionFile: lead.sessionFile,
        turns,
        preflightCalls: preflightAttempts,
        decisionRecords: recordAttempts,
        deltaSubmissions,
        nativeTools: leadTools.map((tool) => tool.name),
      });
      return accepted;
    } finally {
      unsubscribe();
      await lead?.dispose();
    }
  }

  private parseSubmission(value: unknown, candidateCount: number, priorCount: number): ParsedSubmission {
    const errors: SubmissionValidationIssue[] = [];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push({ subject: 'submission', rule: 'submission-shape', message: 'terminal submission must be an object' });
      return { verdict: null, decisions: null, audits: null, report: null, submission: null, errors };
    }
    const input = value as Record<string, unknown>;
    if (Object.keys(input).sort().join('\0') !== [...SUBMISSION_KEYS].sort().join('\0')) {
      errors.push({ subject: 'submission', rule: 'submission-shape', message: 'terminal submission keys do not match the required schema' });
    }
    let verdict: CanonicalReviewVerdict | null = null;
    if (typeof input.canonical_verdict !== 'string' || !CANONICAL_VERDICTS.includes(input.canonical_verdict)) {
      errors.push({ subject: 'submission', rule: 'submission-verdict', message: 'terminal canonical_verdict is invalid' });
    } else {
      verdict = input.canonical_verdict as CanonicalReviewVerdict;
    }
    let decisions: ParsedDecision[] | null = null;
    if (!Array.isArray(input.candidate_decisions) || input.candidate_decisions.length > Math.max(candidateCount, MAX_TOTAL_CANDIDATES)) {
      errors.push({ subject: 'submission', rule: 'submission-decisions', message: 'candidate_decisions is invalid' });
    } else {
      decisions = input.candidate_decisions.map((entry, index) => parseDecisionEntry(entry, index, errors));
    }
    let audits: ParsedAudit[] | null = null;
    if (!Array.isArray(input.prior_audit) || input.prior_audit.length > Math.max(priorCount, 10_000)) {
      errors.push({ subject: 'submission', rule: 'submission-prior-audit', message: 'prior_audit is invalid' });
    } else {
      audits = input.prior_audit.map((entry, index) => parseAuditEntry(entry, index, priorCount, errors));
    }
    const report = collectBoundedString(
      input.report_markdown, 'report_markdown', PERKINS_REPORT_MAX_BYTES, 'report', 'report-shape', errors,
    );
    const submission: LeadSubmission | null =
      errors.length === 0 && verdict !== null && decisions !== null && audits !== null && report !== null
        ? {
            canonical_verdict: verdict,
            candidate_decisions: decisions.map((entry) => entry.decision as CandidateDecision),
            prior_audit: audits.map((entry) => entry.audit as FixAuditResult),
            report_markdown: report,
          }
        : null;
    return { verdict, decisions, audits, report, submission, errors };
  }

  /**
   * Resolve a candidate payload (full or delta) and validate it. A delta is
   * applied host-side over the stored rejection, or over the decision record
   * when no rejection has been stored, and the merged whole is then validated
   * exactly like a full submission of the same content.
   */
  private validateSubmission(
    context: SubmissionValidationContext,
    raw: unknown,
    state: SubmissionState,
    proofCache: ProofCache,
  ): SubmissionValidation {
    const delta = this.resolveDeltaSubmission(context, raw, state);
    if (delta === null) return this.validateResolvedSubmission(context, raw, proofCache);
    const validation = this.validateResolvedSubmission(context, delta.merged, proofCache);
    if (delta.errors.length === 0) return validation;
    // The delta envelope did not resolve cleanly: nothing is sealed and the
    // merged state is not advanced. Report the envelope violations together
    // with whatever the merged whole still fails.
    return { ok: false, submission: null, errors: [...delta.errors, ...(validation.ok ? [] : validation.errors)] };
  }

  /** Apply a delta payload over host state without validating it. Returns
   * null for a full-submission payload. */
  private resolveDeltaSubmission(
    context: SubmissionValidationContext,
    raw: unknown,
    state: SubmissionState,
  ): ResolvedDelta | null {
    if (!isDeltaEnvelope(raw)) return null;
    const value = raw as Record<string, unknown>;
    const errors: SubmissionValidationIssue[] = [];
    const unknownKeys = Object.keys(value).filter((key) => !DELTA_KEYS.includes(key));
    if (unknownKeys.length > 0) {
      errors.push({ subject: 'submission', rule: 'delta-shape', message: `delta submission contains unsupported keys: ${unknownKeys.join(', ')}` });
    }
    const base = state.lastRejected;
    const baseDecisions = base?.candidate_decisions ?? [...state.recordedDecisions.values()];
    const baseAudits = base?.prior_audit ?? [];
    if (base === null && state.recordedDecisions.size === 0) {
      errors.push({
        subject: 'submission',
        rule: 'delta-base',
        message: state.lastRejectionOversized
          ? 'the rejected submission exceeded the delta base byte bound; resubmit the full submission'
          : 'delta submission has no stored rejection or recorded decisions to amend',
      });
    }
    // Decisions: replace by candidate_ref, append new refs, first entry wins.
    let deltaDecisions: readonly CandidateDecision[] = [];
    if (value.candidate_decisions !== undefined) {
      if (
        !Array.isArray(value.candidate_decisions) ||
        value.candidate_decisions.length > Math.max(context.candidates.size, MAX_TOTAL_CANDIDATES)
      ) {
        errors.push({ subject: 'submission', rule: 'delta-decisions', message: 'delta candidate_decisions is invalid' });
      } else {
        deltaDecisions = value.candidate_decisions
          .map((entry, index) => parseDecisionEntry(entry, index, errors))
          .flatMap((entry) => entry.decision === null ? [] : [entry.decision]);
      }
    }
    const seenRefs = new Set<string>();
    for (const decision of deltaDecisions) {
      if (seenRefs.has(decision.candidate_ref)) {
        errors.push({ subject: decision.candidate_ref, rule: 'delta-decisions', message: `delta decides ${decision.candidate_ref} more than once` });
      }
      seenRefs.add(decision.candidate_ref);
    }
    const decisionReplacement = new Map<string, CandidateDecision>();
    for (const decision of deltaDecisions) {
      if (!decisionReplacement.has(decision.candidate_ref)) decisionReplacement.set(decision.candidate_ref, decision);
    }
    const mergedDecisions = baseDecisions.map((decision) => decisionReplacement.get(decision.candidate_ref) ?? decision);
    const knownRefs = new Set(baseDecisions.map((decision) => decision.candidate_ref));
    for (const decision of deltaDecisions) {
      if (knownRefs.has(decision.candidate_ref)) continue;
      if (decisionReplacement.get(decision.candidate_ref) !== decision) continue;
      knownRefs.add(decision.candidate_ref);
      mergedDecisions.push(decision);
    }
    // Audits: replace by prior_index, append new indexes, first entry wins.
    let deltaAudits: readonly FixAuditResult[] = [];
    if (value.prior_audit !== undefined) {
      if (!Array.isArray(value.prior_audit) || value.prior_audit.length > Math.max(context.prior.length, 10_000)) {
        errors.push({ subject: 'submission', rule: 'delta-prior-audit', message: 'delta prior_audit is invalid' });
      } else {
        deltaAudits = value.prior_audit
          .map((entry, index) => parseAuditEntry(entry, index, context.prior.length, errors))
          .flatMap((entry) => entry.audit === null ? [] : [entry.audit]);
      }
    }
    const seenAuditIndexes = new Set<number>();
    for (const audit of deltaAudits) {
      if (seenAuditIndexes.has(audit.prior_index)) {
        errors.push({ subject: `prior audit ${audit.prior_index}`, rule: 'delta-prior-audit', message: `delta audits prior finding ${audit.prior_index} more than once` });
      }
      seenAuditIndexes.add(audit.prior_index);
    }
    const auditReplacement = new Map<number, FixAuditResult>();
    for (const audit of deltaAudits) {
      if (!auditReplacement.has(audit.prior_index)) auditReplacement.set(audit.prior_index, audit);
    }
    const mergedAudits = baseAudits.map((audit) => auditReplacement.get(audit.prior_index) ?? audit);
    const knownAuditIndexes = new Set(baseAudits.map((audit) => audit.prior_index));
    for (const audit of deltaAudits) {
      if (knownAuditIndexes.has(audit.prior_index)) continue;
      if (auditReplacement.get(audit.prior_index) !== audit) continue;
      knownAuditIndexes.add(audit.prior_index);
      mergedAudits.push(audit);
    }
    // Verdict/report: a supplied value replaces; a malformed supplied value is
    // reported and leaves the base value in place.
    let verdict: unknown = base?.canonical_verdict;
    if (value.canonical_verdict !== undefined) {
      if (typeof value.canonical_verdict !== 'string' || !CANONICAL_VERDICTS.includes(value.canonical_verdict)) {
        errors.push({ subject: 'submission', rule: 'submission-verdict', message: 'terminal canonical_verdict is invalid' });
      } else {
        verdict = value.canonical_verdict;
      }
    }
    let report: unknown = base?.report_markdown;
    if (value.report_markdown !== undefined) {
      const checked = collectBoundedString(
        value.report_markdown, 'report_markdown', PERKINS_REPORT_MAX_BYTES, 'report', 'report-shape', errors,
      );
      if (checked !== null) report = checked;
    }
    return {
      merged: {
        canonical_verdict: verdict,
        candidate_decisions: mergedDecisions,
        prior_audit: mergedAudits,
        report_markdown: report,
      },
      errors,
    };
  }

  /**
   * The single per-decision implementation shared by store-time recording,
   * preflight and terminal submission. Returns every decision-scoped
   * violation in stable order; an unowned reference is reported here too.
   */
  private validateDecision(
    context: SubmissionValidationContext,
    decision: CandidateDecision,
    proofCache: ProofCache,
  ): readonly SubmissionValidationIssue[] {
    const issues: SubmissionValidationIssue[] = [];
    const candidate = context.candidates.get(decision.candidate_ref);
    if (candidate === undefined) {
      issues.push({ subject: decision.candidate_ref, rule: 'decision-coverage', message: 'candidate reference is not owned by this review' });
      return issues;
    }
    const ref = candidate.ref;
    const review = context.review;
    if (decision.disposition === 'rejected') {
      const anchored = findingPath(candidate) !== null && candidate.location !== 'N/A';
      const located = anchored
        ? evidenceAtCitedLocation(review, candidate, decision.evidence, proofCache)
        : evidenceAnywhere(review, decision.evidence, proofCache);
      if (!located || decision.evidence === candidate.evidence) {
        issues.push({ subject: ref, rule: 'rejected-evidence', message: `rejected candidate lacks contradictory frozen evidence at its cited location: ${ref}` });
      }
      return issues;
    }
    const forcedSpeculative = candidate.location === 'N/A' || candidate.evidence === 'N/A' || findingPath(candidate) === null;
    if (!forcedSpeculative && decision.disposition === 'unverifiable-speculative') {
      issues.push({ subject: ref, rule: 'anchored-disposition', message: `anchored candidate must be confirmed or rejected: ${ref}` });
      return issues;
    }
    const disposition = forcedSpeculative ? 'unverifiable-speculative' : decision.disposition;
    if (disposition === 'confirmed') {
      if (!evidenceAtCitedLocation(review, candidate, candidate.evidence, proofCache)) {
        issues.push({ subject: ref, rule: 'confirmed-evidence', message: `candidate evidence is not locatable at its cited file/hunk: ${ref}` });
      }
      if (!evidenceAnywhere(review, decision.evidence, proofCache)) {
        issues.push({ subject: ref, rule: 'verification-evidence', message: `lead verification evidence is not locatable in the frozen review: ${ref}` });
      }
    }
    return issues;
  }

  /**
   * One exhaustive pass over a resolved full submission. Collects every rule
   * violation — schema, host state, candidate decisions, prior audit, verdict
   * arithmetic, and report structure — in stable order instead of throwing on
   * the first one, so a single rejection (or preflight) lets the lead fix
   * everything at once. Same rules and strictness as the original fail-fast
   * validator; only the reporting changed.
   */
  private validateResolvedSubmission(
    context: SubmissionValidationContext,
    raw: unknown,
    proofCache: ProofCache,
  ): SubmissionValidation {
    const parsed = this.parseSubmission(raw, context.candidates.size, context.prior.length);
    const errors: SubmissionValidationIssue[] = [...parsed.errors];
    const review = context.review;
    const report = parsed.report;
    const push = (subject: string, rule: string, message: string): void => {
      errors.push({ subject, rule, message });
    };

    // Host-state facts are independent of the submission body: report all.
    const missingChunks = review.chunks.filter((chunk) => !context.readChunks.has(chunk.id)).map((chunk) => chunk.id);
    if (missingChunks.length > 0) {
      push('submission', 'host-read-missing', `lead has not read every frozen chunk (${missingChunks.join(', ')})`);
    }
    const missingCoverage = [...context.expected].filter((key) => !context.validCoverage.has(key));
    if (missingCoverage.length > 0) {
      push('submission', 'coverage-missing', `required lens/chunk coverage is missing (${missingCoverage.length} run(s))`);
    }

    // Candidate ownership/coverage. The first valid decision per ref is the
    // one used for semantic checks; every violation is still reported.
    const decidedByRef = new Map<string, CandidateDecision>();
    if (parsed.decisions !== null) {
      const duplicates = new Set<string>();
      const unowned = new Set<string>();
      for (const entry of parsed.decisions) {
        if (entry.decision === null) continue;
        const ref = entry.decision.candidate_ref;
        if (!context.candidates.has(ref)) {
          unowned.add(ref);
          continue;
        }
        if (decidedByRef.has(ref)) {
          duplicates.add(ref);
          continue;
        }
        decidedByRef.set(ref, entry.decision);
      }
      const missing = [...context.candidates.keys()].filter((ref) => !decidedByRef.has(ref));
      if (parsed.decisions.length !== context.candidates.size) {
        push('submission', 'decision-coverage', 'terminal submission must decide every child candidate exactly once');
      }
      if (duplicates.size > 0 || unowned.size > 0 || missing.length > 0) {
        push('submission', 'decision-coverage', 'terminal submission contains missing, duplicate, or unowned candidate references');
      }
      for (const ref of duplicates) push(ref, 'decision-coverage', 'candidate is decided more than once');
      for (const ref of unowned) push(ref, 'decision-coverage', 'candidate reference is not owned by this review');
      for (const ref of missing) push(ref, 'decision-coverage', 'candidate has no decision entry');
    }

    // Prior audit: exact coverage plus locatable proof for every entry that
    // parsed, not merely the first failing one.
    const locatedAudits = new Map<number, FixAuditResult>();
    if (parsed.audits !== null) {
      const byIndex = new Map<number, FixAuditResult[]>();
      for (const entry of parsed.audits) {
        if (entry.audit === null) continue;
        const list = byIndex.get(entry.audit.prior_index) ?? [];
        list.push(entry.audit);
        byIndex.set(entry.audit.prior_index, list);
      }
      let coverageBroken = parsed.audits.length !== context.prior.length;
      for (let priorIndex = 0; priorIndex < context.prior.length; priorIndex += 1) {
        const list = byIndex.get(priorIndex) ?? [];
        if (list.length === 0) {
          push(`prior audit ${priorIndex}`, 'prior-audit-coverage', `prior finding ${priorIndex} has no audit entry`);
          coverageBroken = true;
        } else if (list.length > 1) {
          push(`prior audit ${priorIndex}`, 'prior-audit-coverage', `prior finding ${priorIndex} is audited more than once`);
          coverageBroken = true;
        }
      }
      if (coverageBroken) push('submission', 'prior-audit-coverage', 'prior audit must contain every prior finding exactly once');
      const ordered = [...byIndex.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([, list]) => list);
      for (const audit of ordered) {
        const finding = context.prior[audit.prior_index]!;
        const speculativeNa = finding.verification.disposition === 'unverifiable-speculative' && audit.evidence === 'N/A';
        const path = findingPath(finding);
        const indirectIssue = audit.fix_location === undefined ? null :
          indirectFixEvidence(review, finding, audit, context.priorTargetSha, proofCache);
        const located = speculativeNa || (indirectIssue === null && (
          audit.fix_location !== undefined || (path !== null && (
            audit.status === 'still-present'
              ? frozenBlobContains(review, path, audit.evidence, proofCache)
              : fixedAuditEvidence(review, finding, audit.evidence, context.priorTargetSha, proofCache)
          ))
        ));
        if (!located) {
          push(`prior audit ${audit.prior_index}`, 'prior-audit-evidence', indirectIssue ??
            `prior audit ${audit.prior_index} evidence is not locatable at the finding's cited frozen file/hunk`);
          continue;
        }
        if (!locatedAudits.has(audit.prior_index)) locatedAudits.set(audit.prior_index, audit);
      }
    }
    const priorAudit = [...locatedAudits.entries()].sort(([left], [right]) => left - right).map(([, audit]) => audit);

    // Carried prior findings enter first so a fresh rediscovery of the same
    // issue merges INTO the original round marker, never replaces it.
    const findings: VerifiedFinding[] = [];
    for (const audit of priorAudit) {
      if (audit.status !== 'still-present') continue;
      const carried = context.prior[audit.prior_index]!;
      findings.push({
        ...carried,
        evidence: audit.evidence,
        verification: {
          disposition: carried.verification.disposition,
          evidence: audit.evidence,
          reason: audit.reason,
        },
      });
    }

    // Candidate decisions: the exact old disposition/evidence rules, all
    // errors reported in submission order.
    let confirmed = 0;
    let rejected = 0;
    let speculative = 0;
    for (const decision of decidedByRef.values()) {
      const candidate = context.candidates.get(decision.candidate_ref)!;
      const decisionIssues = this.validateDecision(context, decision, proofCache);
      errors.push(...decisionIssues);
      if (decision.disposition === 'rejected') {
        if (decisionIssues.length === 0) rejected += 1;
        continue;
      }
      const forcedSpeculative = candidate.location === 'N/A' || candidate.evidence === 'N/A' || findingPath(candidate) === null;
      const disposition = forcedSpeculative ? 'unverifiable-speculative' : decision.disposition;
      if (decisionIssues.length > 0) continue;
      if (disposition === 'confirmed') {
        confirmed += 1;
      } else {
        speculative += 1;
      }
      findings.push({
        source: candidate.source,
        severity: disposition === 'unverifiable-speculative' && candidate.severity === 'blocker' ? 'warning' : candidate.severity,
        category: candidate.category,
        title: candidate.title,
        location: candidate.location,
        evidence: candidate.evidence,
        detail: candidate.detail,
        recommended_fix: candidate.recommended_fix,
        verification: { disposition, evidence: decision.evidence, reason: decision.reason },
        chunks: [candidate.chunk],
        sources: [candidate.source],
        roundOrigin: context.roundNumber,
      });
    }
    const deduped = [...dedupeVerifiedFindings(findings)];
    // Host-carried coverage gates: a FAIL coverage gate is a confirmed
    // blocker owned by the host, not by lead discretion.
    for (const result of context.results.values()) {
      if (result.status === 'valid' && result.coverageGate === 'FAIL') {
        deduped.push({
          source: 'tests',
          severity: 'blocker',
          category: 'coverage-gate',
          title: 'Coverage gate: FAIL',
          location: `chunk ${result.chunk}`,
          evidence: 'Coverage gate: FAIL',
          detail: 'The tests lens reported a failing coverage gate; the review cannot be complete.',
          recommended_fix: 'Restore the coverage the tests lens requires, then rerun the review.',
          verification: { disposition: 'confirmed', evidence: 'Coverage gate: FAIL', reason: 'host-carried coverage gate reported FAIL' },
          chunks: [result.chunk],
          sources: ['tests'],
          roundOrigin: context.roundNumber,
        });
      }
    }
    const finalFindings = dedupeVerifiedFindings(deduped);
    // A moved source ref never retargets this frozen review, but it also
    // cannot authorize the now-different head. The lead may correct an
    // initial conclusive proposal to INCOMPLETE on its second terminal
    // attempt; only that fail-closed submission can be accepted.
    const headMoved = headMovedSinceFreeze(review, context.movementRef);
    const completeness: ReviewCompleteness = {
      complete: !headMoved,
      requiredLensRuns: context.expected.size,
      validLensRuns: context.validCoverage.size,
      failedRuns: [],
      verificationComplete: true,
    };
    const canonicalVerdict = verdictForFindings(finalFindings, completeness);
    // Verdict arithmetic is exact only when the finding set is the exact one
    // the host would accept. While any semantic error stands, the actionable
    // errors come first; preflight makes the follow-up check free.
    const exact = parsed.submission;
    if (errors.length === 0 && exact !== null) {
      if (exact.canonical_verdict !== canonicalVerdict) {
        push('submission', 'verdict-arithmetic', `proposed verdict ${exact.canonical_verdict} conflicts with canonical ${canonicalVerdict}`);
      }
      if (!exact.report_markdown.includes(`**Verdict: ${canonicalVerdict}**`)) {
        push('report', 'report-verdict', 'lead report does not state the canonical verdict');
      }
    }
    // Report structure: every violation in this pass too.
    if (report !== null) {
      if (!report.includes(review.manifest.targetSha) || !report.includes(review.manifest.diffBaseSha)) {
        push('report', 'report-identity', 'lead report omits the frozen target/base identity');
      }
      for (const lens of context.lenses) {
        if (!report.includes(lens)) push('report', 'report-lens', `lead report omits required lens coverage: ${lens}`);
      }
      for (const finding of finalFindings) {
        // Host-carried coverage gates are host evidence, not lead-authored
        // report content (the lead never receives the gate finding).
        if (finding.category === 'coverage-gate' && finding.verification.reason.startsWith('host-carried')) continue;
        // Verbatim proof is anchored: the full evidence must appear, or --
        // for evidence longer than 200 bytes -- its exact 200-byte prefix.
        // This keeps a 200-candidate report inside the bounded envelope.
        const evidencePrefix = Buffer.byteLength(finding.evidence, 'utf8') > 200 ? bytePrefix(finding.evidence, 200) : finding.evidence;
        const required: ReadonlyArray<readonly [string, string]> = [
          ['title', finding.title],
          ['severity', finding.severity],
          ['location', finding.location],
          ['evidence', evidencePrefix],
          ['recommended_fix', finding.recommended_fix],
        ];
        const missingProof = required.filter(([, value]) => !report.includes(value)).map(([label]) => label);
        if (missingProof.length > 0) {
          push(`finding ${finding.title}`, 'report-finding-proof', `lead report omits required finding proof: ${finding.title} (missing: ${missingProof.join(', ')})`);
        }
      }
      for (const audit of priorAudit) {
        // Same byte-anchored proof as findings: full evidence, or its
        // exact 200-byte prefix for long evidence (bounded report).
        const auditPrefix = Buffer.byteLength(audit.evidence, 'utf8') > 200 ? bytePrefix(audit.evidence, 200) : audit.evidence;
        if (!report.includes(audit.status) || !report.includes(auditPrefix)) {
          push(`prior audit ${audit.prior_index}`, 'report-prior-proof', `lead report omits prior audit proof: ${audit.prior_index}`);
        }
        if (audit.fix_location !== undefined &&
            (!report.includes(audit.fix_location.path) || !report.includes(context.prior[audit.prior_index]!.location))) {
          push(`prior audit ${audit.prior_index}`, 'report-prior-proof', `lead report must identify both the original citation and fix_location ${audit.fix_location.path}`);
        }
      }
    }
    if (errors.length > 0) return { ok: false, submission: parsed.submission, errors };
    if (parsed.submission === null) throw new Error('internal: schema-clean submission did not parse');
    return {
      ok: true,
      submission: parsed.submission,
      findings: finalFindings,
      priorAudit,
      completeness,
      canonicalVerdict,
      headMoved,
      verificationSummary: {
        candidates: context.candidates.size,
        confirmed,
        rejected,
        unverified: speculative,
        speculative,
        deduplicated: finalFindings.length,
      },
    };
  }

  private leadPrompt(review: FrozenReview, lenses: readonly PerkinsLens[], prior: readonly VerifiedFinding[], priorTargetSha: string | null): string {
    const coverage = review.chunks.flatMap((chunk) => lenses.map((lens) => ({ lens, chunk: chunk.id, files: chunk.files })));
    return [
      'Conduct the complete Perkins review as the lead. You own scheduling, investigation, candidate verification, prior-finding audit, synthesis and report authorship. The host owns safety and terminal proof validation.',
      '',
      `Frozen target SHA: ${review.manifest.targetSha}`,
      `Frozen diff base SHA: ${review.manifest.diffBaseSha}`,
      ...(priorTargetSha === null ? [] : [`Frozen prior target SHA: ${priorTargetSha}`]),
      `Spec mode: ${review.manifest.specMode}`,
      '',
      '--- FROZEN SPECIFICATION / CONTEXT ---',
      review.specContext,
      '',
      '--- FROZEN PROJECT CONVENTIONS ---',
      review.projectConventions,
      '',
      '--- REQUIRED CHILD COVERAGE ---',
      JSON.stringify(coverage, null, 2),
      '',
      '--- PRIOR VERIFIED FINDINGS TO AUDIT ---',
      JSON.stringify(prior.map((finding, prior_index) => ({ prior_index, ...finding })), null, 2),
      '',
      'Call perkins_run_lenses until every required lens/chunk has a valid owned result. Read any frozen chunk with perkins_read_chunk. Inspect the returned candidates against the frozen tree. Submit one candidate_decisions entry for every candidate ref and one prior_audit entry for every prior_index.',
      'Record each decision with perkins_record_decision as you verify it: it validates the decision immediately with the same exhaustive rules and keeps clean decisions in the round record, so the final submission can carry only what is still missing.',
      'A rejected candidate still requires a concise reason. confirmed evidence must be one contiguous verbatim current-tree substring. N/A claims are speculative and cannot remain blockers.',
      'Pairing rules are enforced at cited locations: a rejected candidate needs contradictory evidence locatable at its cited file/hunk, confirmed candidate evidence must be locatable at its cited file/hunk, and your verification evidence must be locatable in the frozen review.',
      ...(priorTargetSha === null ? [] : ['Call perkins_read_prior_delta with {} to list changed paths and {"path":"relative/caller.ts"} to read a selected frozen prior-target hunk; deleted callers are absent from the current tree but their removed lines remain available here. The tool is read-only, bounded, and rejects binary callers.']),
      'For a fixed prior finding whose cited file remains unchanged, optionally give fix_location: {path: "relative/changed-caller.ts", change: "added" or "removed"} with evidence equal to ONE actual added or removed line in the prior-target-to-frozen-target delta. The location must differ from the original citation; explain in reason why this caller change fixes that finding and name both paths in the report. A path alone, unchanged diff context, a rename with no changed hunk, or another revision is not proof. Old cited deletion/PATH ABSENT proofs remain valid without fix_location.',
      'Before the terminal submission, call perkins_preflight_submission with the exact candidate submission (full, or {"mode":"delta", ...} to amend the rejection record after a failed attempt). It spends no terminal attempt, accepts nothing, and returns every violation in one response; fix them all and preflight again until it reports no errors, then submit once.',
      'After a rejected terminal submission, resubmit a delta: {"mode":"delta", "candidate_decisions": [only the changed/added decisions], ...changed report fields}. The host applies it over the rejected submission and re-validates the merged whole with the same rules. A delta is still a real terminal attempt.',
      'Write a complete Markdown report containing `**Verdict: ...**` and every retained finding title, then call perkins_submit_review. Never claim completion from missing/failed runs.',
    ].join('\n');
  }
}
