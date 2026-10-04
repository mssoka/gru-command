import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentSpawner } from '../service.js';
import type { AgentHandle, NativeAgentTool, PromptOptions } from '../../runtime/types.js';
import type { PacingGate, PacingLease, PacingEventRecorder, RateLimitBackoffPolicy } from '../../runtime/pacing.js';
import { withRateLimitRetries, type RateLimitRetryOptions } from '../../runtime/rate-limit-retry.js';
import { assertFrozenPromptBounds, sourceMovementSinceFreeze, writeReviewArtifact, type FrozenReview, type SourceMovement } from './artifacts.js';
import { readFrozenEvidenceBytes, renderEvidencePromptSection } from '../../review-inputs/evidence.js';
import { finalAssistantText } from './session-output.js';
import { PERKINS_FINDING_SOURCES, type PerkinsFindingSource, type PerkinsLens, type PerkinsPolicy } from './policy.js';
import {
  dedupeVerifiedFindings,
  parseFindingsSubmission,
  parseFindingsWithRecovery,
  safeFixPath,
  type CanonicalReviewVerdict,
  type ChildFailureKind,
  type LensEnvelope,
  type LensOutputRecovery,
  type PriorDisposition,
  type ReviewFinding,
  type VerifiedFinding,
} from './types.js';

export type { CanonicalReviewVerdict } from './types.js';

/** Standalone/unconfigured engine default (tests and direct use). Production
 * always passes the configured `[review] max_concurrent_children` ceiling from
 * config.ts — this constant never overrides it. */
export const STANDALONE_SPECIALIST_CONCURRENCY = 4;
const CHILD_SPAWN_TIMEOUT_MS = 60 * 1_000;
const LEAD_SPAWN_TIMEOUT_MS = 60 * 1_000;
/** Wall-clock bound on the whole lead run (one prompt = many turns). */
const LEAD_TOTAL_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_LEAD_TURNS = 80;
/** Specialists per tool call. The batch size is a scheduling bound, not a
 * lifetime: a wave that outlives the transport wait reports still-running
 * and is re-attached by an identical call, so this never cuts a run short. */
const MAX_TOOL_RUNS = 4;
const MAX_SPECIALISTS_PER_ROUND = 16;
const MAX_TOTAL_FINDINGS = 500;
const MAX_TERMINAL_ATTEMPTS = 2;
const MAX_LEAD_ARTIFACTS = 20;
const MAX_LEAD_ARTIFACT_BYTES = 100 * 1024;
/** Response bound for one native-tool response, measured on the FULL wire
 * frame the Claude MCP bridge serializes (result text re-serialized inside
 * a JSON-RPC frame whose server rejects >1 MiB), leaving margin for ids and
 * protocol growth. Pi's in-process path has the same ceiling by symmetry. */
const MAX_TOOL_RESPONSE_BYTES = 900 * 1024;
const MAX_WIRE_FRAME_BYTES = 1024 * 1024 - 64 * 1024;

/** Assert a tool response fits the serialized MCP wire frame the server
 * will actually accept (inner payload AND its frame). */
function assertToolResponseFits(text: string, details: Readonly<Record<string, unknown>>, what: string): void {
  const frame = JSON.stringify({ id: 'x'.repeat(256), ok: true, result: { text, details } });
  if (Buffer.byteLength(frame, 'utf8') > MAX_WIRE_FRAME_BYTES) {
    throw new Error(`${what} exceeds the bounded serialized tool response; select a smaller scope`);
  }
}
/** Response bound for the aggregated submission-validation rejection. */
const MAX_VALIDATION_MESSAGE_BYTES = 256 * 1024;
export const PERKINS_REPORT_MAX_BYTES = 128 * 1024;
const REVIEW_OWNER = 'perkins-whole-review';

const BLIND_SYSTEM_PROMPT =
  'You are one blind Perkins lens child. The user prompt is your entire context. You have no repository context, skills, extensions, or delegation authority. Follow the user prompt exactly.';
const LENS_SYSTEM_PROMPT =
  'You are one Perkins lens child. Use only the read-only frozen-tree tools and the supplied prompt. Never edit, delegate, invoke skills, or start another review. Follow the user prompt exactly.';

/** The one native channel a specialist child may submit structured findings through. */
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
/** Exact per-finding keys of the lead's terminal submission findings. */
const SUBMISSION_FINDING_KEYS = ['source', ...SUBMITTED_FINDING_KEYS] as const;
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
  readonly state: 'running' | 'done' | 'error';
  readonly note?: string;
}

export interface PerkinsWholeReviewOptions {
  readonly spawner: AgentSpawner;
  readonly policy: PerkinsPolicy;
  /** Optional admitted round: holds a lead and first child together. */
  readonly beginChildren?: () => { readonly concurrency: number; finish(): void };
  /** Effective specialist ceiling for this round; bounded by the host's
   * per-call input bound below. */
  readonly maxConcurrentChildren?: number;
  /** Provider pacing: FIFO combined lead+lens review-turn gate. Absent =
   * off; an unlimited or disabled gate admits immediately. */
  readonly reviewGate?: PacingGate;
  readonly rateLimitBackoff?: RateLimitBackoffPolicy | null;
  readonly recordPacing?: PacingEventRecorder;
  readonly pacingSleep?: RateLimitRetryOptions['sleep'];
  readonly pacingJitter?: RateLimitRetryOptions['jitter'];
  /** Clock seam for the shared per-turn retry budget (tests pin
   * remaining/elapsed deterministically; default Date.now). */
  readonly pacingNow?: () => number;
  readonly onProgress?: (progress: ReviewProgress) => void;
  readonly onAgent?: (input: {
    readonly phase: 'lead' | 'specialist';
    readonly lens?: PerkinsLens;
    /** Which attempt spawned this child (the retry-bound counter; 1 = first
     * run). Callers minting agent labels suffix it on retries so two
     * attempts on one lens never mint duplicate rows. */
    readonly attempt?: 1 | 2;
    readonly handle: AgentHandle;
  }) => void;
}

export interface RunWholeReviewInput {
  readonly roundId: string;
  readonly roundNumber: number;
  readonly frozenReview: FrozenReview;
  readonly movementRef: string;
  readonly noSpec: boolean;
  readonly priorConsolidatedFile?: string;
  /** Service shutdown or caller cancellation. Cancellation is always INCOMPLETE. */
  readonly signal?: AbortSignal;
}

export interface SpecialistRun {
  readonly lens: PerkinsLens;
  readonly attempt: 1 | 2;
  readonly status: 'valid' | 'invalid' | 'failed';
  readonly failureKind?: ChildFailureKind;
  readonly error?: string;
  /** False when the run completed validly but its findings never reached
   * the lead (over-bound tool response): 'ran' must never read as
   * 'delivered' (R17). Absent = delivered. */
  readonly findingsDelivered?: boolean;
  /** Set when the run settled but its cleanup failure could not be
   * recorded durably — the settled work stands, the recording gap is
   * disclosed (R10). */
  readonly cleanupRecordingError?: string;
}

export interface PerkinsWholeResult {
  readonly canonicalVerdict: CanonicalReviewVerdict;
  readonly findings: readonly VerifiedFinding[];
  readonly priorDispositions: readonly PriorDisposition[];
  readonly specialistRuns: readonly SpecialistRun[];
  readonly artifactDirectory: string;
  readonly reportFile: string;
  readonly targetSha: string;
  readonly diffBaseSha: string;
  readonly headMoved: boolean;
  readonly sourceMovement?: SourceMovement;
  readonly lensEnvelopes: readonly LensEnvelope[];
}

interface SpecialistResult extends SpecialistRun {
  readonly resultId: string;
  readonly agentId: string;
  readonly findings: readonly ReviewFinding[];
}

/** One host-recorded non-valid specialist attempt. */
export interface SpecialistAttemptFailure {
  readonly attempt: number;
  readonly status: 'invalid' | 'failed';
  readonly failureKind: ChildFailureKind;
  readonly error: string;
}

interface LeadSubmission {
  readonly verdict: CanonicalReviewVerdict;
  readonly findings: readonly ReviewFinding[];
  readonly prior_dispositions: readonly PriorDisposition[];
  readonly report_markdown: string;
}

/** One exhaustive submission-validation violation, addressable by the lead. */
interface SubmissionValidationIssue {
  /** `findings[N]`, `prior disposition N`, `report`, or `submission`. */
  readonly subject: string;
  /** Stable rule code naming the violated host rule. */
  readonly rule: string;
  /** Actionable detail. */
  readonly message: string;
}

interface SubmissionValidationContext {
  readonly review: FrozenReview;
  readonly movementRef: string;
  readonly prior: readonly VerifiedFinding[];
  readonly priorTargetSha: string | null;
  /** Lenses with a committed VALID specialist result; a lead finding may
   * never be attributed to a lens that did not actually run. */
  readonly validLenses: ReadonlySet<PerkinsLens>;
  /** Per lens, the exact titles of the findings its valid runs actually
   * DELIVERED to the lead (R12): crediting a lens requires the specialist
   * to have reported that finding — a valid-but-empty (or undelivered)
   * result cannot originate a lead-invented finding. */
  readonly deliveredLensFindingTitles: ReadonlyMap<PerkinsLens, ReadonlySet<string>>;
}

interface SubmissionValidationSuccess {
  readonly ok: true;
  readonly submission: LeadSubmission;
}

interface SubmissionValidationFailure {
  readonly ok: false;
  readonly issues: readonly SubmissionValidationIssue[];
}

type SubmissionValidation = SubmissionValidationSuccess | SubmissionValidationFailure;

const CANONICAL_VERDICTS = ['READY TO MERGE', 'NEEDS CHANGES', 'MAJOR REWORK NEEDED', 'INCOMPLETE'];

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function headMovedSinceFreeze(review: FrozenReview, movementRef: string): SourceMovement | null {
  // The target ref, HEAD, and the pristine detached checkout must ALL still
  // be exactly what was frozen, and the base must not have been rewritten
  // past the frozen merge-base; unknown movement can never authorize the
  // now-different head.
  const observed = sourceMovementSinceFreeze(review);
  if (observed !== null) return observed;
  if (movementRef === review.manifest.targetSha || movementRef === review.manifest.targetRef) return null;
  try {
    return execFileSync(
      'git', ['-C', review.manifest.repoPath, 'rev-parse', '--verify', `${movementRef}^{commit}`],
      { encoding: 'utf8', timeout: GIT_PROOF_TIMEOUT_MS },
    ).trim() === review.manifest.targetSha ? null : { cause: 'target-moved', detail: `movement ref ${movementRef} no longer matches ${review.manifest.targetSha}` };
  } catch {
    return { cause: 'target-moved', detail: `movement ref ${movementRef} cannot resolve` };
  }
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
  issues: SubmissionValidationIssue[],
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ subject, rule, message: `${name} must be a non-empty string` });
    return null;
  }
  if (Buffer.byteLength(value, 'utf8') > max) {
    issues.push({ subject, rule, message: `${name} exceeds ${max} UTF-8 bytes` });
    return null;
  }
  return value;
}

/** One bounded, line-addressable rejection listing every violation at once. */
function rejectionMessage(issues: readonly SubmissionValidationIssue[]): string {
  const lines = [
    `terminal submission rejected with ${issues.length} error(s); every listed rule must be fixed before a real submission is accepted:`,
  ];
  let bytes = Buffer.byteLength(lines[0]!, 'utf8') + 1;
  let shown = 0;
  for (const issue of issues) {
    const line = `- [${issue.subject}] ${issue.rule}: ${issue.message}`;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + lineBytes > MAX_VALIDATION_MESSAGE_BYTES) break;
    lines.push(line);
    bytes += lineBytes;
    shown += 1;
  }
  if (shown < issues.length) lines.push(`- (+${issues.length - shown} further error(s) omitted from this bounded response)`);
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

function findingPath(finding: Pick<ReviewFinding, 'location'>): string | null {
  const token = finding.location.split(':', 1)[0]?.trim() ?? '';
  if (
    token === '' || token === 'N/A' || token.startsWith('-') || token.startsWith('/') ||
    token.includes('\\') || token.split('/').some((component) => component === '' || component === '.' || component === '..')
  ) return null;
  return token;
}

const GIT_PROOF_TIMEOUT_MS = 30_000;

/** Frozen-blob reads memoized per review: many findings can cite one path,
 * and each read is a subprocess. The SHAs are immutable, so the cache is
 * safe for the whole round. */
const blobCache = new WeakMap<FrozenReview, Map<string, string | null>>();

function frozenBlob(review: FrozenReview, path: string): string | null {
  let cache = blobCache.get(review);
  if (cache === undefined) {
    cache = new Map();
    blobCache.set(review, cache);
  }
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  let blob: string | null;
  try {
    blob = execFileSync('git', ['-C', review.manifest.repoPath, 'show', `${review.manifest.targetSha}:${path}`], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    blob = null;
  }
  cache.set(path, blob);
  return blob;
}

function frozenBlobContains(review: FrozenReview, path: string, evidence: string): boolean {
  const blob = frozenBlob(review, path);
  return blob !== null && blob.includes(evidence);
}

/** Frozen path diffs memoized per review (same immutability argument). */
const pathDiffCache = new WeakMap<FrozenReview, Map<string, string>>();

function frozenPathDiff(review: FrozenReview, path: string): string {
  let cache = pathDiffCache.get(review);
  if (cache === undefined) {
    cache = new Map();
    pathDiffCache.set(review, cache);
  }
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  let diff = '';
  try {
    diff = execFileSync('git', [
      '-C', review.manifest.repoPath, 'diff', '--no-ext-diff', '--no-color', '--unified=3',
      review.manifest.diffBaseSha, review.manifest.targetSha, '--', `:(literal)${path}`,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    diff = '';
  }
  cache.set(path, diff);
  return diff;
}

/** Child grounding: a finding that cites a real file must quote that file
 * (or its frozen diff), not a sibling file. Binding is to the CITED FILE in
 * the frozen tree — specialists read the whole frozen tree and may cite an
 * unchanged file with a real defect. */
function evidenceAtCitedLocation(review: FrozenReview, finding: ReviewFinding, evidence: string): boolean {
  if (evidence === 'N/A' || evidence.trim() === '') return false;
  const path = findingPath(finding);
  if (path === null) return false;
  return frozenBlobContains(review, path, evidence) || frozenPathDiff(review, path).includes(evidence);
}

interface PriorReview {
  readonly findings: readonly VerifiedFinding[];
  readonly targetSha: string | null;
}

/** Load the prior round's consolidated record. schemaVersion 2 is the retired
 * chunk-protocol shape (read-only compatibility; its `chunks` field is
 * tolerated and ignored); schemaVersion 3 is the whole-PR shape. */
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
    (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) ||
    !Array.isArray(parsed.findings) || parsed.findings.length > 10_000 ||
    typeof parsed.frozen?.targetSha !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.frozen.targetSha)
  ) {
    throw new Error('prior consolidated review has an invalid findings array');
  }
  const sources = new Set<string>(PERKINS_FINDING_SOURCES);
  const findings = parsed.findings.map((entry, index) => {
    const finding = record(entry, `prior finding ${index}`) as Partial<VerifiedFinding> & { chunks?: unknown };
    const verification = finding.verification as Partial<VerifiedFinding['verification']> | undefined;
    if (
      typeof finding.source !== 'string' || !sources.has(finding.source) ||
      typeof finding.severity !== 'string' || !['blocker', 'warning', 'note'].includes(finding.severity) ||
      typeof finding.category !== 'string' || typeof finding.title !== 'string' ||
      typeof finding.location !== 'string' || typeof finding.evidence !== 'string' ||
      typeof finding.detail !== 'string' || typeof finding.recommended_fix !== 'string' ||
      !Number.isSafeInteger(finding.roundOrigin) || Number(finding.roundOrigin) < 1 ||
      !Array.isArray(finding.sources) || finding.sources.length === 0 ||
      finding.sources.some((source) => typeof source !== 'string' || !sources.has(source)) ||
      verification === undefined ||
      typeof verification.disposition !== 'string' ||
      !['confirmed', 'unverifiable-speculative'].includes(verification.disposition) ||
      typeof verification.evidence !== 'string' || typeof verification.reason !== 'string'
    ) throw new Error(`prior finding ${index} failed the durable schema`);
    // schemaVersion 2 records carry chunk provenance; verified compat only.
    return finding as VerifiedFinding;
  });
  return { findings, targetSha: parsed.frozen.targetSha };
}

function renderTemplateOnce(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(?:PROJECT_CONVENTIONS|DIFF|SPEC_CONTEXT|LENS_BRIEF|LENS|CHANGED_FILES)\}\}/g, (placeholder) =>
    values[placeholder] ?? placeholder,
  );
}

function renderSpecialistPrompt(
  policy: PerkinsPolicy,
  review: FrozenReview,
  lens: PerkinsLens,
  output: ChildOutputMode,
  retry?: { readonly attempt: 1 | 2; readonly previous: SpecialistAttemptFailure },
): string {
  const contracts = policy.portableContract.outputContracts;
  const rawContract = lens === 'blind'
    ? (output === 'nativeTool' ? contracts.blindNativeTool : contracts.blindText)
    : (output === 'nativeTool' ? contracts.nativeTool : contracts.text);
  const contract = rawContract.split('{{LENS}}').join(lens);
  if (/\{\{[A-Z_]+\}\}/u.test(contract)) throw new Error('child output contract has unresolved placeholders');
  const template = lens === 'blind' ? policy.portableContract.blindPrompt : policy.portableContract.sharedPrompt;
  if (!template.includes('{{OUTPUT_CONTRACT}}')) throw new Error('policy prompt is missing the output contract placeholder');
  const rendered = template.replace('{{OUTPUT_CONTRACT}}', () => contract);
  // Non-blind paths receive the promised frozen evidence as untrusted text
  // beside the attachment images the host attaches to the same prompt.
  const evidenceSection = lens === 'blind' ? '' : renderEvidencePromptSection(review.evidence.attachments, review.manifest.targetSha);
  const prompt = (lens === 'blind'
    ? renderTemplateOnce(rendered, {
      // The blind child's only grounding: the exact paths its location
      // fields may cite, alongside the whole diff those citations are
      // checked against.
      '{{CHANGED_FILES}}': review.changedFiles.map((file) => `- ${file}`).join('\n'),
      '{{DIFF}}': review.diff,
    })
    : renderTemplateOnce(rendered, {
      '{{PROJECT_CONVENTIONS}}': review.projectConventions,
      '{{DIFF}}': review.diff,
      '{{SPEC_CONTEXT}}': review.specContext,
      '{{LENS_BRIEF}}': policy.portableContract.lenses[lens],
      '{{LENS}}': lens,
    })) + (evidenceSection === '' ? '' : `\n\n${evidenceSection}`);
  // A retry is corrective, not a blind repeat: the host delivers the previous
  // attempt's exact failure class and reason in the child's own contract.
  if (retry === undefined || retry.attempt <= 1) return prompt;
  const correction = retryCorrection(output, retry.previous);
  if (lens !== 'blind') return `${prompt}\n\n--- RETRY CORRECTION (attempt ${retry.attempt}) ---\n${correction}`;
  // Blind children cannot re-read anything, so their retry restates the
  // locatable-evidence contract on top of the exact rejection.
  return `${prompt}\n\n--- RETRY CORRECTION (attempt ${retry.attempt}) ---\n${correction}\n${blindEvidenceCorrection(retry.previous)}`;
}

/** Exact frozen evidence pixels for one prompt, re-verified against the
 * frozen hash/size on every read (a mutated frozen copy refuses loudly). */
function reviewEvidenceImages(review: FrozenReview): PromptOptions['images'] {
  return review.evidence.attachments.map((attachment) => ({
    mediaType: attachment.mediaType,
    data: readFrozenEvidenceBytes(attachment).toString('base64'),
  }));
}

/** The promise is delivery of the frozen content or a named refusal — never a
 * text-only substitute for material the model cannot see. */
function assertEvidenceCapability(
  handle: AgentHandle,
  images: PromptOptions['images'] | undefined,
  what: string,
): void {
  if (images === undefined || images.length === 0) return;
  if (handle.capabilities.images === true) return;
  throw new Error(
    `${what} does not declare image input; refusing to deliver the ${images.length} frozen evidence attachment(s) as an unverified text-only substitute`,
  );
}

/** The reason carried by an abort signal, or the generic cancellation error
 * for signals aborted without one. */
function abortReasonFor(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('review operation aborted');
}

/** Corrective instruction for a retry attempt, built from the host's exact
 * previous rejection so the child can fix what failed. */
function retryCorrection(output: ChildOutputMode, previous: SpecialistAttemptFailure): string {
  const reason = previous.error.replace(/[\r\n]+/gu, ' ').trim().slice(0, 400);
  if (output === 'nativeTool') {
    return `Previous attempt rejected (${previous.failureKind}): ${reason}. Retry the same task and call ${FINDINGS_TOOL_NAME} exactly once with the full corrected { "findings": [...] } payload; findings in assistant text are ignored.`;
  }
  return `Previous output rejected (${previous.failureKind}): ${reason}; output ONLY the bare JSON array.`;
}

/** Blind retries reply to the exact rejection with the locatable-evidence
 * contract instead of only naming it. */
function blindEvidenceCorrection(previous: SpecialistAttemptFailure): string {
  const reason = previous.error.replace(/[\r\n]+/gu, ' ').trim().slice(0, 400);
  return `Your previous submission was rejected because ${reason}. Re-cite every finding with ` +
    '"location" as "<path>:<line>" — the exact file path from FILES IN THIS CHANGE, a colon, then the line or line range, with NO function names or prose inside location — and ' +
    '"evidence" as ONE contiguous snippet recited verbatim from that path\'s hunks.';
}

/** A review turn exceeded its host budget. Classified separately from output
 * failures so the audit distinguishes load from a rejected output. Only the
 * lead still holds a whole-run wall-clock budget; specialist turns carry no
 * lifetime deadline — host supervision owns stall diagnosis for them. */
class ReviewTurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`review turn timed out after ${timeoutMs}ms`);
    this.name = 'ReviewTurnTimeoutError';
  }
}

async function boundedPrompt(
  handle: AgentHandle,
  prompt: string,
  timeoutMs: number | null,
  signals: readonly (AbortSignal | undefined)[] = [],
  images?: PromptOptions['images'],
): Promise<void> {
  let failure: string | null = null;
  const unsubscribe = handle.subscribe((event) => {
    if (event.type === 'error' || (event.type === 'state' && event.state === 'error')) {
      failure = event.error ?? 'review model turn failed';
    }
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectAbort: ((error: Error) => void) | null = null;
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    for (const signal of signals) {
      if (signal === undefined) continue;
      if (signal.aborted) {
        rejectAbort?.(abortReasonFor(signal));
        return;
      }
      const listener = () => rejectAbort?.(abortReasonFor(signal));
      listeners.push({ signal, listener });
      signal.addEventListener('abort', listener, { once: true });
    }
  });
  try {
    await Promise.race([
      handle.prompt(prompt, {
        owner: REVIEW_OWNER,
        ...(images !== undefined && images.length > 0 ? { images } : {}),
      }),
      ...(timeoutMs === null
        ? []
        : [new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ReviewTurnTimeoutError(timeoutMs)), timeoutMs);
            timer.unref?.();
          })]),
      abort,
    ]);
    if (failure !== null) throw new Error(failure);
  } finally {
    rejectAbort = null;
    unsubscribe();
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

interface PoolOutcome<U> {
  /** Settled results in input order; undefined where a run rejected. */
  readonly results: ReadonlyArray<U | undefined>;
  /** First rejection reason, or null when every run settled to a value. */
  readonly error: unknown | null;
}

async function pool<T, U>(items: readonly T[], concurrency: number, run: (item: T) => Promise<U>): Promise<PoolOutcome<U>> {
  const results = new Array<U | undefined>(items.length).fill(undefined);
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
  // Settled work is never discarded: the caller receives every result that
  // completed plus the first error, and decides accounting itself (T13).
  return { results, error: failed !== undefined ? failed.reason : null };
}

/** One whole-PR Perkins review: a lead that owns the complete change, with
 * optional isolated whole-change specialists and host-owned soundness
 * validation (schema, accounting, identity) — never substantive truth. */
export class PerkinsWholeReview {
  private readonly spawner: AgentSpawner;
  private readonly policy: PerkinsPolicy;
  private readonly beginChildren: NonNullable<PerkinsWholeReviewOptions['beginChildren']>;
  private readonly maxConcurrentChildren: number;
  private readonly reviewGate: PacingGate | null;
  private readonly pacingOptions: PerkinsWholeReviewOptions;
  private readonly onProgress: (progress: ReviewProgress) => void;
  private readonly onAgent: NonNullable<PerkinsWholeReviewOptions['onAgent']>;

  constructor(options: PerkinsWholeReviewOptions) {
    this.pacingOptions = options;
    this.spawner = options.spawner;
    this.policy = options.policy;
    this.maxConcurrentChildren = options.maxConcurrentChildren ?? STANDALONE_SPECIALIST_CONCURRENCY;
    this.beginChildren = options.beginChildren ?? (() => ({ concurrency: this.maxConcurrentChildren, finish: () => {} }));
    this.reviewGate = options.reviewGate ?? null;
    this.onProgress = options.onProgress ?? (() => {});
    this.onAgent = options.onAgent ?? (() => {});
  }

  /** Provider pacing (review-turn gate): claim one combined review slot
   * BEFORE the spawn — a queued FIFO wait never consumes the spawn or turn
   * timeouts. The caller releases the lease in its own finally, beside the
   * child disposal. Null when the gate is absent. */
  private async acquireReviewTurnSlot(
    label: string,
    signal: AbortSignal | undefined,
  ): Promise<PacingLease | null> {
    const gate = this.reviewGate;
    if (gate === null) return null;
    return gate.acquireReviewTurn({
      id: label,
      label,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /** Provider pacing: the wave's own fan-out width. When a review-turn cap
   * is configured, a wave never starts more lens tasks than the global cap;
   * the shared FIFO gate still enforces the combined lead+lens limit across
   * rounds (extra tasks simply wait their turn). */
  private specialistWaveWidth(): number {
    const limit = this.reviewGate?.view().review.limit ?? 0;
    return limit > 0 ? Math.max(1, Math.min(this.maxConcurrentChildren, limit)) : this.maxConcurrentChildren;
  }

  async run(input: RunWholeReviewInput): Promise<PerkinsWholeResult> {
    const review = input.frozenReview;
    assertFrozenPromptBounds(review);
    const catalog = input.noSpec
      ? this.policy.portableContract.rules.noSpecLenses
      : this.policy.portableContract.rules.fullLenses;
    const priorReview = loadPriorReview(input.priorConsolidatedFile);
    const prior = priorReview.findings;
    const attempts = new Map<string, number>();
    const results = new Map<string, SpecialistResult>();
    const envelopes: LensEnvelope[] = [];
    const leadArtifacts = new Set<string>();
    const agentIds = new Set<string>();
    const sessionFiles = new Set<string>();
    const failureLog = new Map<string, SpecialistAttemptFailure[]>();
    // Host-side bounds restore attempt counters so specialists stay retryable;
    // every child run therefore writes artifacts under a unique run token so
    // a restored retry cannot collide with the write-once artifact store.
    const restoreAttempts = (scheduled: ReadonlyArray<{ readonly lens: PerkinsLens }>): void => {
      for (const run of scheduled) {
        const priorAttempt = attempts.get(run.lens) ?? 0;
        if (priorAttempt <= 1) attempts.delete(run.lens);
        else attempts.set(run.lens, (priorAttempt - 1) as 1 | 2);
      }
    };
    let specialistsStarted = 0;
    let preflightAttempts = 0;
    let terminalAttempts = 0;
    let accepted: PerkinsWholeResult | null = null;

    const registerIsolatedHandle = (handle: AgentHandle, phase: 'lead' | 'specialist'): void => {
      if (handle.reviewIsolation !== true) throw new Error(`${phase} handle is not review-isolated`);
      if (handle.id.trim() === '' || agentIds.has(handle.id)) throw new Error(`duplicate or empty review agent id: ${handle.id}`);
      if (handle.sessionFile === null || !isAbsolute(handle.sessionFile)) throw new Error(`${phase} session is not durably identified`);
      const sessionFile = resolve(handle.sessionFile);
      if (sessionFiles.has(sessionFile)) throw new Error(`duplicate review session file: ${sessionFile}`);
      agentIds.add(handle.id);
      sessionFiles.add(sessionFile);
    };

    const retryPrompt = async (
      handle: AgentHandle, prompt: string, budgetMs: number | null, label: string,
      signals: readonly (AbortSignal | undefined)[], acquire: () => Promise<void>, release: () => void,
      hasSubmission: () => boolean, images?: PromptOptions['images'],
    ): Promise<void> => {
      const now = this.pacingOptions.pacingNow ?? Date.now;
      let remaining = budgetMs ?? 0;
      await withRateLimitRetries(async () => {
        await acquire();
        const start = now();
        try {
          if (budgetMs !== null && remaining <= 0) throw new ReviewTurnTimeoutError(budgetMs);
          await boundedPrompt(handle, prompt, budgetMs === null ? null : remaining, signals, images);
        } catch (error) {
          // A terminal native submission outranks later transport noise.
          if (hasSubmission()) return;
          release();
          throw error;
        } finally {
          if (budgetMs !== null) remaining -= Math.max(0, now() - start);
        }
      }, {
        policy: this.pacingOptions.rateLimitBackoff ?? null,
        signals,
        ...(this.pacingOptions.pacingSleep !== undefined ? { sleep: this.pacingOptions.pacingSleep } : {}),
        ...(this.pacingOptions.pacingJitter !== undefined ? { jitter: this.pacingOptions.pacingJitter } : {}),
        record: (event) => {
          // Ledger payloads stay canonical across both producers (the
          // supervisor and this workflow loop): per-producer context rides
          // the event envelope, never the payload (pacing.ts contract).
          // The round artifact keeps the fuller context for local evidence.
          writeReviewArtifact(review, `pacing/${randomUUID()}.json`, { kind: event.kind, ...event.payload, round_id: input.roundId, label, agent_id: handle.id });
          this.pacingOptions.recordPacing?.({ kind: event.kind, agentId: handle.id, payload: event.payload });
        },
      });
    };

    // Frozen evidence pixels are read and hash-verified from the frozen copy
    // on EVERY prompt (a mutated copy refuses that prompt loudly); no
    // cross-prompt byte memoization.
    const evidenceImages = (): PromptOptions['images'] => reviewEvidenceImages(review);

    const runSpecialist = async (
      lens: PerkinsLens,
      attempt: 1 | 2,
      previous: SpecialistAttemptFailure | undefined,
      signal?: AbortSignal,
    ): Promise<SpecialistResult> => {
      this.onProgress({ lens, state: 'running' });
      let handle: AgentHandle | null = null;
      let reviewLease: PacingLease | null = null;
      let settled: SpecialistResult | null = null;
      let disposeArtifactError: unknown | null = null;
      let raw: string | null = null;
      /** Set only when the child's own output failed recovery/validation or
       * construction-time evidence pairing: host errors stay 'error'. */
      let outputRejected = false;
      /** Valid structured submission captured from perkins_submit_findings
       * (native-tool children); its exact JSON bytes are the durable output. */
      let submitted: { readonly json: string; readonly findings: readonly ReviewFinding[] } | null = null;
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
        reviewLease = await this.acquireReviewTurnSlot(`lens:${lens}#${attempt}`, signal);
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
        }), CHILD_SPAWN_TIMEOUT_MS, [signal, input.signal]);
        registerIsolatedHandle(handle, 'specialist');
        this.onAgent({ phase: 'specialist', lens, attempt, handle });
        // The hosting runtime declares the tools it actually wired: a
        // native-tool child is tool-only, a text child (non-pi runtimes)
        // keeps the tolerant text path. The request alone proves nothing.
        nativeSubmit = handle.reviewTools?.includes(FINDINGS_TOOL_NAME) === true;
        // A specialist turn has no wall-clock lifetime deadline: the host
        // supervisor owns stall diagnosis (silence + live-tool/compaction
        // evidence) and the workflow waits for the child's settled turn or
        // an explicit cancellation. Visible prose silence is not idleness.
        // Blind children never receive the evidence (isolation); every other
        // child receives the same frozen bytes as the lead or refuses loudly.
        const childImages = lens === 'blind' ? undefined : evidenceImages();
        assertEvidenceCapability(handle, childImages, `specialist lens ${lens}`);
        await retryPrompt(
          handle,
          renderSpecialistPrompt(
            this.policy, review, lens, nativeSubmit ? 'nativeTool' : 'text',
            attempt > 1 && previous !== undefined ? { attempt, previous } : undefined,
          ),
          null, `lens:${lens}#${attempt}`,
          [signal, input.signal],
          async () => { reviewLease ??= await this.acquireReviewTurnSlot(`lens:${lens}#${attempt}`, signal ?? input.signal); },
          () => { const lease = reviewLease; reviewLease = null; lease?.release(); },
          () => capturedSubmission() !== null,
          childImages,
        );
        promptResolved = true;
      } catch (error) {
        turnError = error;
      }
      try {
        if (handle === null) throw turnError ?? new Error('specialist child did not spawn');
        if (handle.sessionFile === null) throw new Error('specialist child session is not durable');
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
            throw new Error(submissionError ?? `specialist child did not submit findings via ${FINDINGS_TOOL_NAME}`);
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
        // Evidence pairing is enforced at envelope construction: a finding
        // that cites a real file must quote that file (or its frozen diff),
        // not a sibling file. The cheapest failure point is the child
        // attempt itself, so the lead never inherits an ungrounded finding.
        for (const [findingIndex, finding] of reviewFindings.entries()) {
          if (finding.evidence === 'N/A' || finding.evidence.trim() === '') continue;
          const citedPath = findingPath(finding);
          if (citedPath === null || finding.location === 'N/A') continue;
          if (!evidenceAtCitedLocation(review, finding, finding.evidence)) {
            outputRejected = true;
            throw new Error(
              `specialist finding ${findingIndex} evidence is not locatable at its cited file/hunk: ${finding.location}`,
            );
          }
        }
        const resultId = `${lens}-a${attempt}-${hash(handle.id).slice(0, 16)}`;
        const envelope: LensEnvelope = {
          schemaVersion: 1, lens, attempt, status: 'valid', outputSha256: hash(outputBytes), findings: reviewFindings,
          ...(recovery !== undefined ? { recovery } : {}),
        };
        envelopes.push(envelope);
        writeReviewArtifact(review, `specialists/${lens}.attempt-${attempt}-${runToken}.raw.json`, `${outputBytes}\n`);
        writeReviewArtifact(review, `specialists/${lens}.attempt-${attempt}-${runToken}.envelope.json`, envelope);
        const result: SpecialistResult = {
          resultId, agentId: handle.id, lens, attempt, status: 'valid', findings: reviewFindings,
        };
        writeReviewArtifact(review, `children/${resultId}.json`, result);
        this.onProgress({ lens, state: 'done', note: `${reviewFindings.length} finding(s)` });
        settled = result;
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
        // output at all stays a transport failure.
        const failureKind: ChildFailureKind = error instanceof ReviewTurnTimeoutError
          ? 'timeout'
          : outputRejected ? 'output' : 'error';
        const hadOutput = nativeSubmit ? capturedSubmission() !== null || promptResolved : raw !== null;
        const status: SpecialistResult['status'] = hadOutput ? 'invalid' : 'failed';
        const outputBytes = raw ?? capturedSubmission()?.json ?? rejectedSubmission;
        const envelope: LensEnvelope = {
          schemaVersion: 1, lens, attempt, status,
          outputSha256: outputBytes === null ? null : hash(outputBytes), findings: [], failureKind, error: message,
        };
        envelopes.push(envelope);
        if (outputBytes !== null) {
          // The try block may have already written this exact run-token path
          // before a later step threw; tolerate the collision (write-once).
          try {
            writeReviewArtifact(review, `specialists/${lens}.attempt-${attempt}-${runToken}.raw.json`, `${outputBytes}\n`);
          } catch (writeError) {
            if (!(writeError instanceof Error && 'code' in writeError && (writeError as { code?: string }).code === 'EEXIST')) throw writeError;
          }
        }
        for (const [suffix, value] of [
          [`.error.json`, { error: message } as unknown],
          [`.envelope.json`, envelope as unknown],
        ] as const) {
          try {
            writeReviewArtifact(review, `specialists/${lens}.attempt-${attempt}-${runToken}${suffix}`, value);
          } catch (writeError) {
            if (!(writeError instanceof Error && 'code' in writeError && (writeError as { code?: string }).code === 'EEXIST')) throw writeError;
          }
        }
        this.onProgress({ lens, state: 'error', note: `${failureKind}: ${message}` });
        settled = {
          resultId: `failed-${lens}-a${attempt}`,
          agentId: handle?.id ?? 'spawn-failed', lens, attempt,
          status, findings: [], failureKind, error: message,
        };
      } finally {
        // Cleanup is best-effort by design (T13): a rejected dispose must
        // never discard the settled result above it. The cleanup failure
        // is recorded distinctly as a durable artifact — the child's work
        // stands, and the leak is visible to operators. When recording the
        // failure ALSO fails (R10), one alternate artifact name is tried;
        // if that fails too the fact travels in-memory on the settled run
        // record — it is NEVER rethrown after settlement, so the pool can
        // neither drop the result nor refund the executed attempt.
        if (handle !== null) {
          try {
            await handle.dispose();
          } catch (disposeError) {
            try {
              writeReviewArtifact(review, `specialists/${lens}.attempt-${attempt}-${runToken}.dispose-error.json`, {
                error: sanitizeError(disposeError),
                agentId: handle.id,
              });
            } catch (artifactError) {
              if (!(artifactError instanceof Error && 'code' in artifactError && (artifactError as { code?: string }).code === 'EEXIST')) {
                try {
                  writeReviewArtifact(review, `specialists/${lens}.attempt-${attempt}-${runToken}.dispose-error-${randomUUID().slice(0, 8)}.json`, {
                    error: sanitizeError(disposeError),
                    recordingError: sanitizeError(artifactError),
                    agentId: handle.id,
                  });
                } catch (alternateError) {
                  if (!(alternateError instanceof Error && 'code' in alternateError && (alternateError as { code?: string }).code === 'EEXIST')) {
                    disposeArtifactError = alternateError;
                  }
                }
              }
            }
          }
        }
        reviewLease?.release();
        reviewLease = null;
      }
      if (disposeArtifactError !== null && settled !== null) {
        settled = {
          ...settled,
          cleanupRecordingError: `could not record the dispose failure durably: ${sanitizeError(disposeArtifactError)}`,
        };
      }
      return settled as SpecialistResult;
    };

    // Tool protocols may deliver multiple calls concurrently. Serialize the
    // scheduling mutation so attempt accounting is atomic and the specialist
    // pool's concurrency bound applies to the whole round, not merely one
    // tool call.
    let runToolTail: Promise<void> = Promise.resolve();
    const serializeRunTool = <T>(operation: () => Promise<T>): Promise<T> => {
      const current = runToolTail.then(operation, operation);
      runToolTail = current.then(() => undefined, () => undefined);
      return current;
    };

    const resultsHaveValid = (lens: PerkinsLens): boolean =>
      [...results.values()].some((result) => result.lens === lens && result.status === 'valid');

    const runTool: NativeAgentTool = {
      name: 'perkins_run_specialists',
      description: `Start and await 1-${Math.max(MAX_TOOL_RUNS, this.maxConcurrentChildren)} host-tracked specialist children. Each run names one lens and reviews the WHOLE change in isolation. One call starts all its runs together: the host admits at most this round's resident wave per call (a smaller wave is refused with a split-the-batch error, never a lens failure) and the round is bounded to ${MAX_SPECIALISTS_PER_ROUND} total runs. The host enforces isolation, attempt bounds, concurrency, output validation, durability and ownership. If a call reports the wave still running at the transport wait, call this same tool again with the SAME runs to attach to the running wave and collect its results; never start a second run for a lens that is already running. Specialists are optional: use the lenses that help this change.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['runs'],
        properties: {
          runs: {
            type: 'array', minItems: 1, maxItems: Math.max(MAX_TOOL_RUNS, this.maxConcurrentChildren),
            items: {
              type: 'object', additionalProperties: false, required: ['lens'],
              properties: {
                lens: { type: 'string', enum: [...catalog] },
              },
            },
          },
        },
      },
      execute: (raw, signal) => serializeRunTool(async () => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        if (accepted !== null) throw new Error('review already has an accepted terminal submission');
        const value = record(raw, 'perkins_run_specialists input');
        exactKeys(value, ['runs'], 'perkins_run_specialists input');
        const maxToolRuns = Math.max(MAX_TOOL_RUNS, this.maxConcurrentChildren);
        if (!Array.isArray(value.runs) || value.runs.length < 1 || value.runs.length > maxToolRuns) {
          throw new Error(`runs must contain 1-${maxToolRuns} entries`);
        }
        const requested = value.runs.map((entry, index) => {
          const run = record(entry, `run ${index}`);
          exactKeys(run, ['lens'], `run ${index}`);
          if (typeof run.lens !== 'string' || !catalog.includes(run.lens as PerkinsLens)) {
            throw new Error(`run ${index} lens is not in this review's specialist catalog`);
          }
          return { lens: run.lens as PerkinsLens };
        });
        const lensesRun = requested.map((run) => run.lens);
        if (new Set(lensesRun).size !== lensesRun.length) throw new Error('one tool call cannot duplicate a lens');
        const scheduled = requested.map((run) => {
          if (resultsHaveValid(run.lens)) throw new Error(`specialist ${run.lens} already has a valid result`);
          const priorAttempt = attempts.get(run.lens) ?? 0;
          if (priorAttempt >= this.policy.portableContract.rules.maxLensAttempts) {
            throw new Error(`specialist ${run.lens} exhausted its attempts`);
          }
          return { ...run, attempt: (priorAttempt + 1) as 1 | 2, previous: failureLog.get(run.lens)?.at(-1) };
        });
        // Capacity is checked BEFORE any child starts: a bound the host
        // could have known up front must never strand started children.
        if (specialistsStarted + scheduled.length > MAX_SPECIALISTS_PER_ROUND) {
          throw new Error(`review exceeds ${MAX_SPECIALISTS_PER_ROUND} specialist runs; finish with what has run`);
        }
        for (const run of scheduled) attempts.set(run.lens, run.attempt);
        specialistsStarted += scheduled.length;
        // Refusals happen BEFORE any child starts, so neither an admission
        // race (prior wave still settling) nor a wave-size refusal may
        // consume lens attempts or the round's specialist budget — only
        // real starts do. The lead still sees a named error and retries
        // within its existing safeguards (no unlimited retries added).
        //
        // Provider pacing liveness (r5): a lead waiting on its lens wave is
        // not generating a turn, so it YIELDS its review slot for the whole
        // wave — the children (and concurrent rounds) can then be admitted
        // up to the combined cap. The slot is re-acquired before the result
        // returns to the model, so the next lead turn is gated again.
        const yieldedLeadSlot = reviewLease !== null;
        const runWave = async (): Promise<{
          readonly outcome: PoolOutcome<SpecialistResult | undefined>;
          readonly acquireError: unknown | null;
        }> => {
          if (yieldedLeadSlot) {
            reviewLease!.release();
            reviewLease = null;
          }
          let outcome: PoolOutcome<SpecialistResult | undefined> | null = null;
          let acquireError: unknown = null;
          try {
            let batch: { concurrency: number; finish(): void };
            try {
              batch = this.beginChildren();
              if (scheduled.length > batch.concurrency) {
                batch.finish();
                throw new Error(
                  `perkins_run_specialists: ${scheduled.length} runs exceed this round's admitted wave of ${batch.concurrency}; split them across multiple calls`,
                );
              }
            } catch (error) {
              restoreAttempts(scheduled);
              specialistsStarted -= scheduled.length;
              throw error;
            }
            try {
              // The resident wave admission (beginChildren) and the provider
              // pacing cap both bound the fan-out: run the narrower of the
              // two. Pacing never refuses a wave, it only throttles width.
              const waveWidth = Math.max(1, Math.min(batch.concurrency, this.specialistWaveWidth()));
              outcome = await pool(scheduled, waveWidth, (run) =>
                runSpecialist(run.lens, run.attempt, run.previous, signal));
            } finally {
              batch.finish();
            }
          } finally {
            if (yieldedLeadSlot) {
              // A failed re-acquire must not erase the settled pool outcome:
              // carry the error back so the caller commits the children
              // before it surfaces (T13/R17).
              try {
                reviewLease = await this.acquireReviewTurnSlot('lead', input.signal);
              } catch (error) {
                acquireError = error;
              }
            }
          }
          if (outcome === null) {
            // Unreachable: a thrown body propagates before this point.
            throw new Error('perkins_run_specialists: the wave settled without an outcome');
          }
          return { outcome, acquireError };
        };
        const { outcome: poolOutcome, acquireError } = await runWave();
        // Every settled child is REAL work (T13): commit its result before
        // any error handling, so executed runs are never restored to
        // "not used" or hidden from the durable record.
        const committed = poolOutcome.results.filter((result): result is SpecialistResult => result !== undefined);
        const commitSettled = (): void => {
          for (const result of committed) {
            results.set(result.resultId, result);
            if (result.status !== 'valid') {
              const failures = failureLog.get(result.lens) ?? [];
              failureLog.set(result.lens, [...failures, {
                attempt: result.attempt,
                status: result.status,
                failureKind: result.failureKind ?? 'error',
                error: result.error ?? 'no host-recorded reason',
              }]);
            }
          }
        };
        if (poolOutcome.error !== null) {
          // The lead receives NO response for this batch either: every
          // committed valid run's findings were not delivered (R17), and
          // the durable record must say so.
          for (const result of committed) {
            if (result.findingsDelivered !== false) {
              results.set(result.resultId, { ...result, findingsDelivered: false });
            }
          }
          commitSettled();
          // Only lenses that produced NO result never ran: restore their
          // attempt budget and started count. Lenses that ran keep their
          // accounted state — their evidence already stands.
          const ran = new Set(committed.map((result) => result.lens));
          const neverRan = scheduled.filter((run) => !ran.has(run.lens));
          restoreAttempts(neverRan);
          specialistsStarted -= neverRan.length;
          throw poolOutcome.error;
        }
        const childResults: readonly SpecialistResult[] = committed;
        /** Runs of THIS batch whose findings never reached the lead (R17):
         * commitResults stamps them undelivered even on the error path. */
        const undeliveredRuns = new Set<string>();
        const payload = JSON.stringify({ results: childResults });
        const commitResults = (): void => {
          // Real executed children are committed to the durable run record
          // and the lens state, whatever happens to the response: their
          // work must never silently become "not used".
          for (const result of childResults) {
            results.set(result.resultId, undeliveredRuns.has(result.resultId)
              ? { ...result, findingsDelivered: false }
              : result);
            if (result.status !== 'valid') {
              const failures = failureLog.get(result.lens) ?? [];
              failureLog.set(result.lens, [...failures, {
                attempt: result.attempt,
                status: result.status,
                failureKind: result.failureKind ?? 'error',
                error: result.error ?? 'no host-recorded reason',
              }]);
            }
          }
        };
        if (accepted !== null) {
          commitResults();
          throw new Error('review already has an accepted terminal submission');
        }
        try {
          if (Buffer.byteLength(payload, 'utf8') > MAX_TOOL_RESPONSE_BYTES) {
            throw new Error('specialist result batch exceeds the bounded tool response');
          }
          assertToolResponseFits(payload, { resultCount: childResults.length }, 'specialist result batch');
        } catch (error) {
          // The children really ran: their envelopes/artifacts/run records
          // stay committed (never restored or hidden) — only the response
          // failed, so the lead learns the transport fact honestly. The
          // run records carry findingsDelivered:false so the durable
          // consolidated record, the ledger note and the published
          // appendix can never present these findings as received (R17).
          for (const result of childResults) undeliveredRuns.add(result.resultId);
          commitResults();
          throw new Error(`${(error instanceof Error ? error.message : String(error))}; the completed runs are recorded but their findings were not delivered to you`);
        }
        if (acquireError !== null) {
          // The wave completed, but the lead could not re-acquire its review
          // slot before this result would return to it. The tool call fails,
          // so no finding reaches the lead: commit the real runs as
          // undelivered instead of erasing them (T13/R17). End the round as
          // well — error results must not let the lead run later turns
          // WITHOUT a review slot (the combined cap would be exceeded).
          for (const result of childResults) undeliveredRuns.add(result.resultId);
          commitResults();
          // Fire-and-forget disposal must not surface as an unhandled
          // rejection (main exits 1 on one); the wave's own error is the
          // outcome that matters and it is thrown below.
          void lead?.dispose().catch(() => {});
          throw acquireError instanceof Error ? acquireError : new Error(String(acquireError));
        }
        commitResults();
        return {
          text: payload,
          details: { resultCount: childResults.length, findingCount: childResults.reduce((sum, result) => sum + result.findings.length, 0) },
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

    const priorRevisionTool: NativeAgentTool | null = priorReview.targetSha === null ? null : {
      name: 'perkins_read_prior_revision',
      description: 'Inspect the frozen delta between the prior round target and this round target: with {} list changed paths, or with {"path":"relative/file"} read one bounded exact-file diff. Read-only investigative material for revisiting prior findings.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1, maxLength: 500 } },
      },
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        const value = record(raw, 'perkins_read_prior_revision input');
        exactKeys(value, value.path === undefined ? [] : ['path'], 'perkins_read_prior_revision input');
        const priorTargetSha = priorReview.targetSha!;
        let payload: string;
        if (value.path === undefined) {
          const listing = execFileSync('git', [
            '-C', review.manifest.repoPath, 'diff', '--no-ext-diff', '--no-color', '--find-renames',
            '--name-status', '-z', priorTargetSha, review.manifest.targetSha, '--',
          ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
          // Truthful per-status parsing: an added file has NO old path and a
          // deleted file has NO new path — a re-reviewer must not be shown a
          // prior version of a file that did not exist.
          const fields = listing.split('\0').filter(Boolean);
          const changes: { status: string; oldPath: string | null; newPath: string | null }[] = [];
          for (let i = 0; i < fields.length;) {
            const status = fields[i++]!;
            if (/^R[0-9]{1,3}$/u.test(status)) {
              const oldPath = fields[i++];
              const newPath = fields[i++];
              if (oldPath !== undefined && newPath !== undefined) changes.push({ status: 'R', oldPath, newPath });
            } else if (status === 'A' || status === 'D' || status === 'M') {
              const path = fields[i++];
              if (path !== undefined) {
                changes.push({
                  status,
                  oldPath: status === 'A' ? null : path,
                  newPath: status === 'D' ? null : path,
                });
              }
            } else {
              i += 1; // unknown types are skipped without mislabeling others
            }
          }
          payload = JSON.stringify({ priorTargetSha, targetSha: review.manifest.targetSha, changes });
        } else {
          if (typeof value.path !== 'string' || !safeFixPath(value.path)) {
            throw new Error('prior revision path must be a bounded safe relative file path');
          }
          // Exact-file selection (R11/T10): --text defeats `-diff`
          // attribute binary marking and --no-textconv defeats textconv
          // drivers, so the earlier text of a deleted caller stays
          // readable. EXACTNESS is decided by machine-readable
          // `diff --name-only -z` under the SAME literal pathspec (raw
          // NUL-separated paths — Git quoting can never hide a match):
          // exactly one selected path, identical to the request. A literal
          // pathspec that selected a directory's descendants, a
          // masquerading replacement, or a path that is a file in neither
          // revision is refused — zero matches no longer bypass the check.
          const selectedPaths = execFileSync('git', [
            '-C', review.manifest.repoPath, 'diff', '--name-only', '-z', '--no-ext-diff', '--no-color',
            priorTargetSha, review.manifest.targetSha, '--', `:(literal)${value.path}`,
          ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\0')
            .filter((entry) => entry !== '');
          const blobIn = (revision: string): boolean => {
            try {
              return execFileSync('git', [
                '-C', review.manifest.repoPath, 'cat-file', '-t', `${revision}:${value.path}`,
              ], { encoding: 'utf8', timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'blob';
            } catch {
              return false;
            }
          };
          if (selectedPaths.length === 1 && selectedPaths[0] === value.path) {
            // exact file — fall through and read its diff
          } else if (selectedPaths.length === 0) {
            // Unchanged between the revisions is a valid empty read — but
            // only for a path that IS a file in one of the two trees.
            if (!blobIn(priorTargetSha) && !blobIn(review.manifest.targetSha)) {
              throw new Error(`prior revision path ${value.path} is not a file in either revision; select an exact file that exists`);
            }
          } else {
            throw new Error(`prior revision path ${value.path} is ambiguous (${selectedPaths.length} paths selected — a directory may have replaced it); select an exact file`);
          }
          const diff = execFileSync('git', [
            '-C', review.manifest.repoPath, 'diff', '--no-ext-diff', '--no-color', '--no-textconv', '--text',
            '--unified=3', priorTargetSha, review.manifest.targetSha, '--', `:(literal)${value.path}`,
          ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
          payload = JSON.stringify({ priorTargetSha, targetSha: review.manifest.targetSha, path: value.path, diff });
        }
        if (Buffer.byteLength(payload, 'utf8') > MAX_TOOL_RESPONSE_BYTES) {
          throw new Error('prior revision response exceeds the bounded tool response; select a smaller path');
        }
        assertToolResponseFits(payload, { priorTargetSha, targetSha: review.manifest.targetSha }, 'prior revision response');
        return { text: payload, details: { priorTargetSha, targetSha: review.manifest.targetSha } };
      },
    };

    const submissionSchema = {
      type: 'object', additionalProperties: false,
      required: ['verdict', 'findings', 'prior_dispositions', 'report_markdown'],
      properties: {
        verdict: { type: 'string', enum: CANONICAL_VERDICTS },
        findings: { type: 'array', maxItems: MAX_TOTAL_FINDINGS, items: { type: 'object' } },
        prior_dispositions: { type: 'array', maxItems: 10_000, items: { type: 'object' } },
        report_markdown: { type: 'string', minLength: 1, maxLength: PERKINS_REPORT_MAX_BYTES },
      },
    };

    // The valid-lens set is read live at each validation: submission must
    // see every specialist run committed so far (the tools are serialized,
    // so no run can commit mid-validation).
    const validationContext: SubmissionValidationContext = {
      review,
      movementRef: input.movementRef,
      prior,
      priorTargetSha: priorReview.targetSha,
      get validLenses() {
        const valid = new Set<PerkinsLens>();
        for (const result of results.values()) {
          if (result.status === 'valid') valid.add(result.lens);
        }
        return valid;
      },
      get deliveredLensFindingTitles() {
        const byLens = new Map<PerkinsLens, ReadonlySet<string>>();
        for (const result of results.values()) {
          if (result.status !== 'valid' || result.findingsDelivered === false) continue;
          const titles = byLens.get(result.lens) ?? new Set<string>();
          for (const finding of result.findings) (titles as Set<string>).add(finding.title.trim());
          byLens.set(result.lens, titles);
        }
        return byLens;
      },
    };

    const preflightTool: NativeAgentTool = {
      name: 'perkins_preflight_submission',
      description: 'Validate a candidate terminal submission with the exact rules perkins_submit_review enforces, without spending a terminal attempt and without sealing the round. Returns the complete exhaustive error list in one response; ok=true means the same payload would be accepted. Preflight accepts nothing and never terminates.',
      inputSchema: submissionSchema,
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        if (accepted !== null) throw new Error('review already has an accepted terminal submission');
        preflightAttempts += 1;
        const validation = this.validateSubmission(
          validationContext, raw, headMovedSinceFreeze(review, input.movementRef));
        const issues = validation.ok ? [] : validation.issues;
        const artifact = `lead/preflight-attempt-${preflightAttempts}.json`;
        writeReviewArtifact(review, artifact, {
          schemaVersion: 1,
          ok: validation.ok,
          errorCount: issues.length,
          errors: issues,
        });
        // The response is wire-bounded: every issue stays durable in the
        // artifact above; the response carries as many as fit plus an
        // explicit omitted count and pointer — never silent truncation.
        const included: SubmissionValidationIssue[] = [];
        for (const issue of issues) {
          const candidate = JSON.stringify({
            preflight: true, ok: validation.ok, errorCount: issues.length,
            errors: [...included, issue],
            omittedErrorCount: issues.length - included.length - 1,
            fullList: artifact,
          });
          if (Buffer.byteLength(JSON.stringify({ id: 'x'.repeat(256), ok: true, result: { text: candidate } }), 'utf8') > MAX_WIRE_FRAME_BYTES) break;
          included.push(issue);
        }
        return {
          text: JSON.stringify({
            preflight: true, ok: validation.ok, errorCount: issues.length,
            errors: included,
            ...(included.length < issues.length
              ? { omittedErrorCount: issues.length - included.length, fullList: artifact }
              : {}),
          }),
          details: { preflight: true, ok: validation.ok, errorCount: issues.length, preflightAttempt: preflightAttempts },
        };
      },
    };

    const submitTool: NativeAgentTool = {
      name: 'perkins_submit_review',
      description: 'Submit the lead-authored terminal review: your verdict, your final verified findings, one disposition per prior finding, and the coherent Markdown report. The host validates schema, prior-finding accounting, and identity anchors — substantive truth is yours. A rejected submission lists every violation in one response.',
      inputSchema: submissionSchema,
      // Serialized with specialist scheduling: a terminal submission can
      // never seal while children are still in flight or discard their
      // finished results — it executes only after every started batch has
      // committed its run record.
      execute: (raw, signal) => serializeRunTool(async () => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        terminalAttempts += 1;
        if (terminalAttempts > MAX_TERMINAL_ATTEMPTS) throw new Error('terminal submission attempts exhausted');
        const attempt = terminalAttempts;
        try {
          if (accepted !== null) throw new Error('review already has an accepted terminal submission');
          // ONE head-move observation decides both validation and the
          // sealed artifact, so a result can never internally disagree with
          // itself (READY with headMoved:true).
          const headMovedAtSubmit = headMovedSinceFreeze(review, input.movementRef);
          const validation = this.validateSubmission(validationContext, raw, headMovedAtSubmit);
          if (!validation.ok) {
            writeReviewArtifact(review, `lead/submission-attempt-${attempt}.error.json`, {
              error: rejectionMessage(validation.issues),
              issues: validation.issues,
            });
            throw new SubmissionRejection(validation.issues);
          }
          const submission = validation.submission;
          writeReviewArtifact(review, `lead/submission-attempt-${attempt}.json`, submission);
          const reportFile = writeReviewArtifact(review, 'perkins-report.md', submission.report_markdown.endsWith('\n') ? submission.report_markdown : `${submission.report_markdown}\n`);
          const headMoved = headMovedAtSubmit !== null;
          // The reviewer owns the verdict; the host owns assembly of the
          // durable record from the accepted submission.
          const leadFindings: VerifiedFinding[] = submission.findings.map((finding) => ({
            ...finding,
            verification: {
              disposition: 'confirmed' as const,
              evidence: finding.evidence,
              reason: 'retained by the lead after whole-change verification',
            },
            sources: [finding.source],
            roundOrigin: input.roundNumber,
          }));
          // Still-present prior findings carry their original round marker so
          // a fresh rediscovery merges INTO the original, never replaces it.
          // An optional refresh updates the CURRENT citation/severity for
          // moved code without touching the origin; legacy v2 chunk fields
          // are stripped — v3 records never carry them.
          const carried: VerifiedFinding[] = [];
          for (const disposition of submission.prior_dispositions) {
            if (disposition.status !== 'still-present') continue;
            const original = prior[disposition.prior_index]!;
            const { chunks: _legacyChunks, ...clean } = original as VerifiedFinding & { chunks?: unknown };
            const refresh = disposition.refresh;
            carried.push({
              ...clean,
              ...(refresh?.location !== undefined ? { location: refresh.location } : {}),
              ...(refresh?.severity !== undefined ? { severity: refresh.severity } : {}),
              ...(refresh?.evidence !== undefined
                ? {
                    evidence: refresh.evidence,
                    verification: {
                      disposition: clean.verification.disposition,
                      evidence: refresh.evidence,
                      reason: disposition.note,
                    },
                  }
                : {}),
            });
          }
          const findings = dedupeVerifiedFindings([...carried, ...leadFindings]);
          const specialistRuns = [...results.values()].map((result) => ({
            lens: result.lens, attempt: result.attempt, status: result.status,
            ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
            ...(result.findingsDelivered === false ? { findingsDelivered: false } : {}),
            ...(result.cleanupRecordingError !== undefined ? { cleanupRecordingError: result.cleanupRecordingError } : {}),
          }));
          writeReviewArtifact(review, 'consolidated.json', {
            schemaVersion: 3,
            architecture: 'perkins-whole-pr',
            canonicalVerdict: submission.verdict,
            complete: submission.verdict !== 'INCOMPLETE' && !headMoved,
            headMoved,
            findings,
            priorDispositions: submission.prior_dispositions,
            frozen: review.manifest,
            specialistRuns,
          });
          accepted = {
            canonicalVerdict: submission.verdict, findings, priorDispositions: submission.prior_dispositions,
            specialistRuns, artifactDirectory: review.directory, reportFile,
            targetSha: review.manifest.targetSha, diffBaseSha: review.manifest.diffBaseSha,
            headMoved, ...(headMovedAtSubmit !== null ? { sourceMovement: headMovedAtSubmit } : {}), lensEnvelopes: [...envelopes],
          };
          return {
            text: JSON.stringify({ accepted: true, canonicalVerdict: submission.verdict, findingCount: findings.length }),
            details: { accepted: true, canonicalVerdict: submission.verdict, findingCount: findings.length },
            terminate: true,
          };
        } catch (error) {
          if (!(error instanceof SubmissionRejection)) {
            writeReviewArtifact(review, `lead/submission-attempt-${attempt}.error.json`, { error: sanitizeError(error) });
          }
          throw error;
        }
      }),
    };

    const leadTools = [
      runTool,
      artifactTool,
      ...(priorRevisionTool === null ? [] : [priorRevisionTool]),
      preflightTool,
      submitTool,
    ];
    const systemPrompt = [
      this.policy.portableContract.leadWorkflow,
      '',
      '--- PRODUCT-NATIVE TOOL CONTRACT ---',
      'Use perkins_run_specialists to start optional whole-change specialist children; use perkins_store_artifact only for optional lead notes; use perkins_preflight_submission to validate a candidate terminal submission without spending a terminal attempt; finish by calling perkins_submit_review.',
      ...(priorReview.targetSha === null ? [] : ['On a re-review use perkins_read_prior_revision to list prior-target changes and read bounded path diffs while revisiting prior findings.']),
      'Specialists never inherit these tools. You, the lead, own every retained finding, every prior-finding disposition, and the verdict. Do not write implementation files.',
    ].join('\n');
    const initialPrompt = this.leadPrompt(review, prior, priorReview.targetSha);
    let lead: AgentHandle | null = null;
    let reviewLease: PacingLease | null = null;
    let unsubscribe = (): void => {};
    let turns = 0;
    try {
      reviewLease = await this.acquireReviewTurnSlot('lead', input.signal);
      lead = await boundedSpawn(() => this.spawner('perkins', {
        cwd: review.manifest.repoPath,
        reviewLead: {
          systemPrompt,
          tools: ['read', 'grep', 'find', 'ls'],
          nativeTools: leadTools,
        },
      }), LEAD_SPAWN_TIMEOUT_MS, [input.signal]);
      registerIsolatedHandle(lead, 'lead');
      this.onAgent({ phase: 'lead', handle: lead });
      unsubscribe = lead.subscribe((event) => {
        if (event.type === 'turn_end') {
          turns += 1;
          if (turns > MAX_LEAD_TURNS) void lead?.dispose().catch(() => {});
        }
      });
      // The lead owns the verdict: if the frozen evidence cannot be delivered
      // as pixels, the round refuses to run text-only instead of pretending.
      const leadImages = evidenceImages();
      assertEvidenceCapability(lead, leadImages, 'review lead');
      await retryPrompt(lead, initialPrompt, LEAD_TOTAL_TIMEOUT_MS, 'lead', [input.signal],
        async () => { reviewLease ??= await this.acquireReviewTurnSlot('lead', input.signal); },
        () => { const lease = reviewLease; reviewLease = null; lease?.release(); },
        () => accepted !== null,
        leadImages,
      );
      if (input.signal?.aborted === true) throw new Error('review operation aborted');
      if (turns > MAX_LEAD_TURNS) throw new Error(`Perkins lead exceeded ${MAX_LEAD_TURNS} turns`);
      if (accepted === null) throw new Error('Perkins lead exited without an accepted terminal submission');
      writeReviewArtifact(review, 'lead/receipt.json', {
        schemaVersion: 1,
        leadAgentId: lead.id,
        leadSessionFile: lead.sessionFile,
        turns,
        preflightCalls: preflightAttempts,
        specialistRuns: specialistsStarted,
        nativeTools: leadTools.map((tool) => tool.name),
      });
      return accepted;
    } finally {
      try {
        unsubscribe();
        await lead?.dispose();
      } finally {
        reviewLease?.release();
      }
    }
  }

  /**
   * One exhaustive pass over a submission. Collects every rule violation —
   * schema, prior-finding accounting, identity anchors, head-move safety —
   * in stable order instead of throwing on the first one, so a single
   * rejection (or preflight) lets the lead fix everything at once. The
   * reviewer's substantive judgments (which findings to keep, which prior
   * issues are fixed, the verdict itself) are deliberately NOT validated:
   * the host checks soundness, not truth.
   */
  private validateSubmission(
    context: SubmissionValidationContext,
    raw: unknown,
    headMovedObserved: SourceMovement | null,
  ): SubmissionValidation {
    const issues: SubmissionValidationIssue[] = [];
    const push = (subject: string, rule: string, message: string): void => {
      issues.push({ subject, rule, message });
    };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      push('submission', 'submission-shape', 'terminal submission must be an object');
      return { ok: false, issues };
    }
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).sort().join('\0') !== ['findings', 'prior_dispositions', 'report_markdown', 'verdict'].sort().join('\0')) {
      push('submission', 'submission-shape', 'terminal submission keys do not match the required schema');
    }
    let verdict: CanonicalReviewVerdict | null = null;
    if (typeof value.verdict !== 'string' || !CANONICAL_VERDICTS.includes(value.verdict)) {
      push('submission', 'submission-verdict', 'terminal verdict is invalid');
    } else {
      verdict = value.verdict as CanonicalReviewVerdict;
    }
    const sources = new Set<string>(PERKINS_FINDING_SOURCES);
    let findings: ReviewFinding[] | null = null;
    if (!Array.isArray(value.findings) || value.findings.length > MAX_TOTAL_FINDINGS) {
      push('submission', 'submission-findings', `findings is invalid (at most ${MAX_TOTAL_FINDINGS})`);
    } else {
      const collected: ReviewFinding[] = [];
      findings = collected;
      value.findings.forEach((entry, index) => {
        const subject = `findings[${index}]`;
        const finding = entry;
        if (typeof finding !== 'object' || finding === null || Array.isArray(finding)) {
          push(subject, 'finding-shape', `${subject} must be an object`);
          return;
        }
        const candidate = finding as Record<string, unknown>;
        if (Object.keys(candidate).sort().join('\0') !== [...SUBMISSION_FINDING_KEYS].sort().join('\0')) {
          push(subject, 'finding-schema', `${subject} keys do not match the required schema`);
        }
        if (typeof candidate.source !== 'string' || !sources.has(candidate.source)) {
          push(subject, 'finding-source', `${subject} source must be a lens or "lead"`);
        } else if (candidate.source !== 'lead' && !context.validLenses.has(candidate.source as PerkinsLens)) {
          push(subject, 'finding-source', `${subject} source "${candidate.source}" names a lens with no valid specialist result; source it as "lead" or run that specialist`);
        }
        if (typeof candidate.severity !== 'string' || !['blocker', 'warning', 'note'].includes(candidate.severity)) {
          push(subject, 'finding-severity', `${subject} severity is invalid`);
        }
        const category = collectBoundedString(candidate.category, `${subject} category`, 80, subject, 'finding-category', issues);
        const title = collectBoundedString(candidate.title, `${subject} title`, 240, subject, 'finding-title', issues);
        const location = collectBoundedString(candidate.location, `${subject} location`, 500, subject, 'finding-location', issues);
        const evidence = collectBoundedString(candidate.evidence, `${subject} evidence`, 4_000, subject, 'finding-evidence', issues);
        const detail = collectBoundedString(candidate.detail, `${subject} detail`, 320, subject, 'finding-detail', issues);
        const fix = collectBoundedString(candidate.recommended_fix, `${subject} recommended_fix`, 320, subject, 'finding-fix', issues);
        // Provenance (R12): crediting a lens requires that specialist to
        // have actually DELIVERED a finding with this exact title — a
        // valid-but-empty or undelivered run cannot originate a
        // lead-invented finding; the lead's own judgments source "lead".
        if (
          title !== null && typeof candidate.source === 'string' && candidate.source !== 'lead' &&
          sources.has(candidate.source) && context.validLenses.has(candidate.source as PerkinsLens)
        ) {
          const deliveredTitles = context.deliveredLensFindingTitles.get(candidate.source as PerkinsLens);
          if (deliveredTitles === undefined || !deliveredTitles.has(title.trim())) {
            push(subject, 'finding-source', `${subject} source "${candidate.source}" did not report a finding titled "${title.trim().slice(0, 120)}"; keep the specialist's exact title to credit it, or attribute your own judgment to "lead"`);
          }
        }
        if (
          category === null || title === null || location === null || evidence === null || detail === null || fix === null ||
          typeof candidate.source !== 'string' || !sources.has(candidate.source) ||
          typeof candidate.severity !== 'string' || !['blocker', 'warning', 'note'].includes(candidate.severity)
        ) return;
        collected.push({
          source: candidate.source as PerkinsFindingSource,
          severity: candidate.severity as ReviewFinding['severity'],
          category, title, location, evidence, detail, recommended_fix: fix,
        });
      });
    }
    let dispositions: PriorDisposition[] | null = null;
    if (!Array.isArray(value.prior_dispositions) || value.prior_dispositions.length > Math.max(context.prior.length, 1) * 2 + 10_000) {
      push('submission', 'submission-prior', 'prior_dispositions is invalid');
    } else {
      const collectedDispositions: PriorDisposition[] = [];
      dispositions = collectedDispositions;
      const byIndex = new Map<number, PriorDisposition[]>();
      value.prior_dispositions.forEach((entry, index) => {
        const subject = `prior disposition ${index}`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          push(subject, 'prior-shape', `${subject} must be an object`);
          return;
        }
        const candidate = entry as Record<string, unknown>;
        const expectedKeys = candidate.refresh === undefined
          ? ['note', 'prior_index', 'status']
          : ['note', 'prior_index', 'refresh', 'status'];
        if (Object.keys(candidate).sort().join('\0') !== [...expectedKeys].sort().join('\0')) {
          push(subject, 'prior-schema', `${subject} keys do not match the required schema`);
        }
        if (!Number.isSafeInteger(candidate.prior_index) || Number(candidate.prior_index) < 0 || Number(candidate.prior_index) >= context.prior.length) {
          push(subject, 'prior-index', `${subject} index is invalid`);
          return;
        }
        if (typeof candidate.status !== 'string' || !['fixed', 'still-present'].includes(candidate.status)) {
          push(subject, 'prior-status', `${subject} status is invalid`);
          return;
        }
        // Optional refresh: a truthful current citation for a still-present
        // prior (the code moved, the finding did not). Bounded like the
        // finding schema; judgment stays with the reviewer.
        let refresh: PriorDisposition['refresh'];
        if (candidate.refresh !== undefined) {
          if (typeof candidate.refresh !== 'object' || candidate.refresh === null || Array.isArray(candidate.refresh)) {
            push(subject, 'prior-refresh', `${subject} refresh must be an object`);
            return;
          }
          const rawRefresh = candidate.refresh as Record<string, unknown>;
          if (Object.keys(rawRefresh).length === 0 ||
              Object.keys(rawRefresh).some((key) => !['location', 'evidence', 'severity'].includes(key))) {
            push(subject, 'prior-refresh', `${subject} refresh allows only location, evidence and severity`);
            return;
          }
          const location = rawRefresh.location === undefined
            ? null
            : collectBoundedString(rawRefresh.location, `${subject} refresh location`, 500, subject, 'prior-refresh', issues);
          const evidence = rawRefresh.evidence === undefined
            ? null
            : collectBoundedString(rawRefresh.evidence, `${subject} refresh evidence`, 4_000, subject, 'prior-refresh', issues);
          let severity: VerifiedFinding['severity'] | null = null;
          if (rawRefresh.severity !== undefined) {
            if (typeof rawRefresh.severity !== 'string' || !['blocker', 'warning', 'note'].includes(rawRefresh.severity)) {
              push(subject, 'prior-refresh', `${subject} refresh severity is invalid`);
              severity = null;
            } else {
              severity = rawRefresh.severity as VerifiedFinding['severity'];
            }
          }
          if (location === null && evidence === null && severity === null) {
            push(subject, 'prior-refresh', `${subject} refresh carries no usable field`);
            return;
          }
          refresh = {
            ...(location !== null ? { location } : {}),
            ...(evidence !== null ? { evidence } : {}),
            ...(severity !== null ? { severity } : {}),
          };
        }
        const note = collectBoundedString(candidate.note, `${subject} note`, 1_000, subject, 'prior-note', issues);
        if (note === null) return;
        const disposition = {
          prior_index: Number(candidate.prior_index),
          status: candidate.status as PriorDisposition['status'],
          note,
          ...(refresh === undefined ? {} : { refresh }),
        };
        collectedDispositions.push(disposition);
        const list = byIndex.get(disposition.prior_index) ?? [];
        list.push(disposition);
        byIndex.set(disposition.prior_index, list);
      });
      // Honest accounting: every prior finding is revisited exactly once.
      for (let priorIndex = 0; priorIndex < context.prior.length; priorIndex += 1) {
        const list = byIndex.get(priorIndex) ?? [];
        if (list.length === 0) push(`prior disposition ${priorIndex}`, 'prior-coverage', `prior finding ${priorIndex} has no disposition`);
        else if (list.length > 1) push(`prior disposition ${priorIndex}`, 'prior-coverage', `prior finding ${priorIndex} is dispositioned more than once`);
      }
    }
    const report = collectBoundedString(value.report_markdown, 'report_markdown', PERKINS_REPORT_MAX_BYTES, 'report', 'report-shape', issues);
    if (report !== null && verdict !== null) {
      if (!report.includes(`**Verdict: ${verdict}**`)) {
        push('report', 'report-verdict', 'report does not state the submitted verdict as "**Verdict: <verdict>**"');
      }
      if (!report.includes(context.review.manifest.targetSha) || !report.includes(context.review.manifest.diffBaseSha)) {
        push('report', 'report-identity', 'report omits the frozen target/base identity');
      }
      // Coherence, not transcription (T11): when findings are retained, the
      // prose must account for EVERY one of them — a report that reads as
      // issue-free (or names only a token finding) beside retained findings
      // disagrees with its own record. Whitespace-normalized matching keeps
      // quoted and wrapped titles working; nuanced scoping ("the blind lens
      // found no issues of its own") stays legitimate because the titles
      // themselves are still present.
      const retainedTitles = [
        ...(findings ?? []).map((finding) => finding.title),
        ...(dispositions ?? [])
          .filter((disposition) => disposition.status === 'still-present')
          .map((disposition) => context.prior[disposition.prior_index]?.title ?? ''),
      ].filter((title) => title !== '');
      if (retainedTitles.length > 0) {
        // Hidden HTML comments are not visible prose: titles buried there
        // do not account for a finding the reader can see (E6).
        const normalizedReport = report.replace(/<!--[\s\S]*?-->/gu, '').replace(/\s+/gu, ' ');
        const uniqueRetained = [...new Set(retainedTitles)];
        const missing = uniqueRetained.filter((title) => !normalizedReport.includes(title.replace(/\s+/gu, ' ')));
        if (missing.length > 0) {
          const shown = missing.slice(0, 5).map((title) => `"${title.replace(/\s+/gu, ' ').slice(0, 120)}"`);
          push(
            'report',
            'report-coherence',
            `the report prose does not account for ${missing.length} of ${uniqueRetained.length} retained finding(s) — missing ${shown.join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}; ` +
              'a coherent report references every retained finding (quote or restate its title, including still-present priors), or honestly resolves it in the dispositions',
          );
        }
      }
    }
    // A moved source ref never retargets this frozen review, and it can never
    // authorize the now-different head: only a fail-closed INCOMPLETE
    // submission can be accepted against a moved ref. The observation is
    // supplied by the caller (one per submission) so validation and the
    // sealed artifact can never disagree.
    if (headMovedObserved !== null && verdict !== null && verdict !== 'INCOMPLETE') {
      push('submission', 'head-moved', `source changed after target ${context.review.manifest.targetSha} was frozen (${headMovedObserved.cause}: ${headMovedObserved.detail}); only an INCOMPLETE submission can be accepted`);
    }
    if (issues.length > 0) return { ok: false, issues };
    if (verdict === null || findings === null || dispositions === null) {
      throw new Error('internal: schema-clean submission did not parse');
    }
    return { ok: true, submission: { verdict, findings, prior_dispositions: dispositions, report_markdown: report! } };
  }

  private leadPrompt(review: FrozenReview, prior: readonly VerifiedFinding[], priorTargetSha: string | null): string {
    const evidenceSection = renderEvidencePromptSection(review.evidence.attachments, review.manifest.targetSha);
    return [
      'Conduct the complete Perkins review of this whole change as the lead. You own investigation, verification, prior-finding revisiting, the final report, and the verdict. The host owns safety and terminal validation.',
      '',
      `Frozen target SHA: ${review.manifest.targetSha}`,
      `Frozen diff base SHA: ${review.manifest.diffBaseSha}`,
      ...(priorTargetSha === null ? [] : [`Frozen prior target SHA: ${priorTargetSha}`]),
      `Spec mode: ${review.manifest.specMode}`,
      `Changed files (${review.changedFiles.length}): ${review.changedFiles.join(', ')}`,
      ...(evidenceSection === '' ? [] : ['', evidenceSection]),
      '',
      '--- FROZEN SPECIFICATION / CONTEXT ---',
      review.specContext,
      '',
      '--- FROZEN PROJECT CONVENTIONS ---',
      review.projectConventions,
      '',
      '--- COMPLETE FROZEN DIFF (the whole change under review) ---',
      review.diff,
      '',
      '--- PRIOR FINDINGS TO REVISIT ---',
      JSON.stringify(prior.map((finding, prior_index) => ({ prior_index, ...finding })), null, 2),
      '',
      'Investigate the frozen tree with your confined read tools (the review worktree you are rooted in IS the frozen snapshot). Decide yourself whether perkins_run_specialists helps; each specialist sees the whole change.',
      'For the terminal submission call perkins_submit_review with: your verdict, your final verified findings (source may be "lead" or a lens that actually ran), one prior_dispositions entry per prior_index above (fixed or still-present, each with a short grounded note; for a still-present finding whose code moved, optionally refresh {location, evidence, severity} to the truthful current citation), and the coherent report containing `**Verdict: ...**` and both frozen SHAs.',
      'Prefer fewer grounded findings; [] findings is honest. Never claim completion from work you could not do — submit INCOMPLETE instead, and remember INCOMPLETE never approves.',
    ].join('\n');
  }
}
