import { createHash } from 'node:crypto';

/**
 * Nefario, the pre-dispatch briefing review (GH-505). This module owns the
 * vocabulary every other briefing-review module shares: the tiers and their
 * lens sets, the deterministic identities, the bounded shapes a request may
 * carry, and the review markers that make the exact reviewed briefing
 * durable on each lens job row.
 */

/** Risk tiers Gru declares at commission. The tier picks the lens set; it
 * never changes what the review may block (it is binding on readiness and
 * advisory on content at every tier). */
export const BRIEFING_REVIEW_TIERS = ['low', 'medium', 'high'] as const;
export type BriefingReviewTier = (typeof BRIEFING_REVIEW_TIERS)[number];

/** The adversarial lenses. `stranger` alone is the low tier; `high` runs all
 * five. A tier raise only ever unions lenses, so the order here is the
 * record's order too. */
export const BRIEFING_REVIEW_LENSES = ['stranger', 'acceptance', 'verification', 'repo', 'scope'] as const;
export type BriefingReviewLens = (typeof BRIEFING_REVIEW_LENSES)[number];

export const TIER_LENSES: Readonly<Record<BriefingReviewTier, readonly BriefingReviewLens[]>> = {
  low: ['stranger'],
  medium: ['stranger', 'acceptance', 'verification'],
  high: [...BRIEFING_REVIEW_LENSES],
};

/** The two verdicts a lens (and the aggregate) can hold. */
export const BRIEFING_REVIEW_VERDICTS = ['READY', 'CHANGES-NEEDED'] as const;
export type BriefingReviewVerdict = (typeof BRIEFING_REVIEW_VERDICTS)[number];

/** The recorded provenance verdicts: a push-back admits a dispatch without a
 * READY review, so it is its own value on the job. */
export const BRIEFING_REVIEW_PROVENANCE_VERDICTS = ['READY', 'CHANGES-NEEDED', 'PUSHED-BACK'] as const;
export type BriefingReviewProvenanceVerdict = (typeof BRIEFING_REVIEW_PROVENANCE_VERDICTS)[number];

/** Enforcement: `auto` follows the tier (high + medium enforced, low
 * advisory); 1/2/3 are explicit floor overrides. `auto` is the default. */
export const BRIEFING_REVIEW_STAGES = ['auto', 1, 2, 3] as const;
export type BriefingReviewStage = (typeof BRIEFING_REVIEW_STAGES)[number];

/** Finding severities: `blocking` forces CHANGES-NEEDED, `advisory` does not. */
export const FINDING_SEVERITIES = ['blocking', 'advisory'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** One evidence-bound finding. `evidence` must be a verbatim span of the
 * marked briefing; `why_it_blocks` says what the lane would get wrong. */
export interface BriefingReviewFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly evidence: string;
  readonly whyItBlocks: string;
}

// ------------------------------------------------------------------
// Bounds (the SPEC's Bounds ruling, one constant per bound)
// ------------------------------------------------------------------

export const BRIEFING_REVIEW_MAX_BRIEFING_BYTES = 128 * 1024;
export const BRIEFING_REVIEW_TITLE_MAX = 200;
export const BRIEFING_REVIEW_REPO_PATH_MAX = 4096;
export const BRIEFING_REVIEW_JUSTIFICATION_MAX = 500;
export const BRIEFING_REVIEW_PUSHBACK_REASON_MAX = 2000;
export const BRIEFING_REVIEW_FINDINGS_MAX = 50;
export const BRIEFING_REVIEW_CODE_MAX = 80;
export const BRIEFING_REVIEW_EVIDENCE_MIN = 8;
export const BRIEFING_REVIEW_EVIDENCE_MAX = 2000;
export const BRIEFING_REVIEW_WHY_MAX = 1000;
/** Trailing CHANGES-NEEDED rounds after which a further revision is a
 * disagreement for the owner, not a drafting problem. */
export const BRIEFING_REVIEW_ROUND_CAP = 3;
/** The owner escalation a capped chain is routed through. */
export const BRIEFING_REVIEW_OWNER_ESCALATION =
  'POST /api/notifications/needs-owner with reserved class scope-design';

const FINDING_CODE = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

// ------------------------------------------------------------------
// Named refusals
// ------------------------------------------------------------------

/** Every refusal is a named `{ error, detail }` with the status below. */
export type BriefingReviewErrorCode =
  | 'briefing_review_not_hosted'
  | 'briefing_review_disabled'
  | 'briefing_review_workflow_unavailable'
  | 'briefing_review_invalid_request'
  | 'briefing_review_not_found'
  | 'briefing_review_not_commissioned'
  | 'briefing_review_not_dispatched'
  | 'briefing_review_job_mismatch'
  | 'briefing_review_lens_unknown'
  | 'briefing_review_result_conflict'
  | 'briefing_review_decided'
  | 'briefing_review_round_cap'
  | 'briefing_review_already_ready'
  | 'briefing_review_pushback_conflict'
  | 'briefing_review_mismatch'
  | 'briefing_review_unknown'
  | 'briefing_review_pending'
  | 'briefing_review_not_ready'
  | 'briefing_review_required';

export class BriefingReviewError extends Error {
  constructor(
    readonly code: BriefingReviewErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BriefingReviewError';
  }
}

export function invalidRequest(detail: string): BriefingReviewError {
  return new BriefingReviewError('briefing_review_invalid_request', detail, 400);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ------------------------------------------------------------------
// Deterministic identity
// ------------------------------------------------------------------

/** The stable review identity: one record per exact briefing + repository,
 * across tier raises. `commissionKey` adds the tier (the issue's tier-scoped
 * commission identity, recorded for provenance); `chainKey` anchors the
 * title's revisions so a round cap and `caught` never mix heists. */
export interface BriefingReviewIdentity {
  readonly reviewId: string;
  readonly commissionKey: string;
  readonly briefingSha256: string;
  readonly chainKey: string;
}

export function briefingReviewIdentity(input: {
  readonly briefing: string;
  readonly repoPath: string;
  readonly title: string;
  readonly tier: BriefingReviewTier;
}): BriefingReviewIdentity {
  const briefingSha256 = sha256(input.briefing);
  return {
    reviewId: sha256(`${input.briefing}\0${input.repoPath}`),
    commissionKey: sha256(`${input.briefing}\0${input.repoPath}\0${input.tier}`),
    briefingSha256,
    chainKey: sha256(`${input.repoPath}\0${input.title}`),
  };
}

export function briefingSha256Of(briefing: string): string {
  return sha256(briefing);
}

/** Every Nefario lens job id starts here; a reconcile trusts this prefix to
 * identify one without reading the review. */
export const BRIEFING_REVIEW_JOB_PREFIX = 'briefing-review-';

/** Tier-independent lens job ids: a tier raise reuses the existing jobs and
 * only dispatches the lenses it added. */
export function lensJobId(reviewId: string, lens: BriefingReviewLens): string {
  return `${BRIEFING_REVIEW_JOB_PREFIX}${reviewId.slice(0, 32)}-${lens}`;
}

export function tierRank(tier: BriefingReviewTier): number {
  return BRIEFING_REVIEW_TIERS.indexOf(tier);
}

/** Which tiers a stage holds to readiness: auto follows the tier (high +
 * medium; low advisory), 1 enforces none, 2 high only, 3 high + medium. */
export function tierEnforcedAt(tier: BriefingReviewTier, stage: BriefingReviewStage): boolean {
  if (stage === 1) return false;
  if (stage === 2) return tier === 'high';
  if (stage === 3) return tier === 'high' || tier === 'medium';
  // Auto follows the tier ladder: every non-low tier is enforced, so a tier
  // added later is covered without a config edit. Stage 3 pins today's set.
  if (stage === 'auto') return tier !== 'low';
  throw new Error(`unhandled briefing review stage ${String(stage)}`);
}

export function isBriefingReviewTier(value: unknown): value is BriefingReviewTier {
  return typeof value === 'string' && (BRIEFING_REVIEW_TIERS as readonly string[]).includes(value);
}

export function isBriefingReviewLens(value: unknown): value is BriefingReviewLens {
  return typeof value === 'string' && (BRIEFING_REVIEW_LENSES as readonly string[]).includes(value);
}

export function isBriefingReviewVerdict(value: unknown): value is BriefingReviewVerdict {
  return typeof value === 'string' && (BRIEFING_REVIEW_VERDICTS as readonly string[]).includes(value);
}

/** A union of lens sets in the canonical lens order (a raise never removes
 * a lens the review already armed). */
export function unionLenses(left: readonly BriefingReviewLens[], right: readonly BriefingReviewLens[]): readonly BriefingReviewLens[] {
  const armed = new Set([...left, ...right]);
  return BRIEFING_REVIEW_LENSES.filter((lens) => armed.has(lens));
}

// ------------------------------------------------------------------
// The durable-briefing markers
// ------------------------------------------------------------------

/** The review-specific markers around the exact briefing on a lens job row.
 * Result evidence is validated against that span only, so a quote from the
 * helper or the standing orders can never pass. */
export function briefingMarkers(reviewId: string): { readonly open: string; readonly close: string } {
  return { open: `<<<NEFARIO-BRIEFING ${reviewId}>>>`, close: `<<<END NEFARIO-BRIEFING ${reviewId}>>>>` };
}

export function markedBriefing(briefing: string, reviewId: string): string {
  const { open, close } = briefingMarkers(reviewId);
  return `${open}\n${briefing}\n${close}`;
}

/** The exact reviewed briefing carried by one lens job row, or null when the
 * row is not a marked Nefario briefing (never a guessed span). */
export function reviewedBriefing(jobBriefing: string | null, reviewId: string): string | null {
  if (jobBriefing === null) return null;
  const { open, close } = briefingMarkers(reviewId);
  const start = jobBriefing.indexOf(open);
  const end = jobBriefing.lastIndexOf(close);
  if (start < 0 || end < 0 || end <= start) return null;
  return jobBriefing.slice(start + open.length, end).replace(/^\n/u, '').replace(/\n$/u, '');
}

// ------------------------------------------------------------------
// Strict request shapes (camelCase on the wire)
// ------------------------------------------------------------------

export interface BriefingReviewCommissionRequest {
  readonly repoPath: string;
  readonly title: string;
  readonly briefing: string;
  readonly tier: BriefingReviewTier;
  readonly justification: string;
}

export interface BriefingReviewResultRequest {
  readonly repoPath: string;
  readonly briefingSha256: string;
  readonly jobId: string;
  readonly lens: BriefingReviewLens;
  readonly verdict: BriefingReviewVerdict;
  readonly findings: readonly BriefingReviewFinding[];
}

export interface BriefingReviewPushbackRequest {
  readonly repoPath: string;
  readonly briefingSha256: string;
  readonly reason: string;
  readonly by: 'gru';
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRequest(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(raw: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw invalidRequest(`${what} has unknown field "${key}"`);
  }
}

function boundedString(raw: Record<string, unknown>, field: string, min: number, max: number): string {
  const value = raw[field];
  if (typeof value !== 'string') throw invalidRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw invalidRequest(`${field} must be at least ${String(min)} characters`);
  if (value.length > max) throw invalidRequest(`${field} must be at most ${String(max)} characters`);
  return value;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

export function parseCommissionRequest(value: unknown): BriefingReviewCommissionRequest {
  const raw = record(value, 'the commission request');
  exactFields(raw, ['repoPath', 'title', 'briefing', 'tier', 'justification'], 'the commission request');
  const repoPath = boundedString(raw, 'repoPath', 1, BRIEFING_REVIEW_REPO_PATH_MAX);
  const title = boundedString(raw, 'title', 1, BRIEFING_REVIEW_TITLE_MAX);
  const justification = boundedString(raw, 'justification', 1, BRIEFING_REVIEW_JUSTIFICATION_MAX);
  const briefing = raw['briefing'];
  if (typeof briefing !== 'string' || briefing.trim() === '') {
    throw invalidRequest('briefing must be a non-empty string');
  }
  if (byteLength(briefing) > BRIEFING_REVIEW_MAX_BRIEFING_BYTES) {
    throw invalidRequest(`briefing exceeds ${String(BRIEFING_REVIEW_MAX_BRIEFING_BYTES)} bytes`);
  }
  const tier = raw['tier'];
  if (!isBriefingReviewTier(tier)) {
    throw invalidRequest(`tier must be one of ${BRIEFING_REVIEW_TIERS.join('|')}`);
  }
  return { repoPath, title, briefing, tier, justification };
}

function parseFinding(value: unknown, index: number): BriefingReviewFinding {
  const raw = record(value, `findings[${String(index)}]`);
  exactFields(raw, ['code', 'severity', 'evidence', 'why_it_blocks'], `findings[${String(index)}]`);
  const code = raw['code'];
  if (typeof code !== 'string' || code.length < 1 || code.length > BRIEFING_REVIEW_CODE_MAX || !FINDING_CODE.test(code)) {
    throw invalidRequest(`findings[${String(index)}].code must be 1–${String(BRIEFING_REVIEW_CODE_MAX)} characters matching ${FINDING_CODE.source}`);
  }
  const severity = raw['severity'];
  if (severity !== 'blocking' && severity !== 'advisory') {
    throw invalidRequest(`findings[${String(index)}].severity must be blocking|advisory`);
  }
  const evidence = raw['evidence'];
  if (typeof evidence !== 'string') throw invalidRequest(`findings[${String(index)}].evidence must be a string`);
  const why = raw['why_it_blocks'];
  if (typeof why !== 'string' || why.trim().length < 1 || why.length > BRIEFING_REVIEW_WHY_MAX) {
    throw invalidRequest(`findings[${String(index)}].why_it_blocks must be 1–${String(BRIEFING_REVIEW_WHY_MAX)} characters`);
  }
  return { code, severity, evidence, whyItBlocks: why };
}

export function parseResultRequest(value: unknown): BriefingReviewResultRequest {
  const raw = record(value, 'the result request');
  exactFields(raw, ['repoPath', 'briefingSha256', 'jobId', 'lens', 'verdict', 'findings'], 'the result request');
  const repoPath = boundedString(raw, 'repoPath', 1, BRIEFING_REVIEW_REPO_PATH_MAX);
  const sha = raw['briefingSha256'];
  if (typeof sha !== 'string' || !SHA256_HEX.test(sha)) {
    throw invalidRequest('briefingSha256 must be a lowercase sha256 hex digest');
  }
  const jobId = boundedString(raw, 'jobId', 1, 128);
  const lens = raw['lens'];
  if (!isBriefingReviewLens(lens)) throw invalidRequest(`lens must be one of ${BRIEFING_REVIEW_LENSES.join('|')}`);
  const verdict = raw['verdict'];
  if (!isBriefingReviewVerdict(verdict)) throw invalidRequest(`verdict must be one of ${BRIEFING_REVIEW_VERDICTS.join('|')}`);
  const findings = raw['findings'];
  if (!Array.isArray(findings)) throw invalidRequest('findings must be an array');
  if (findings.length > BRIEFING_REVIEW_FINDINGS_MAX) {
    throw invalidRequest(`findings carries more than ${String(BRIEFING_REVIEW_FINDINGS_MAX)} entries`);
  }
  return { repoPath, briefingSha256: sha, jobId, lens, verdict, findings: findings.map(parseFinding) };
}

export function parsePushbackRequest(value: unknown): BriefingReviewPushbackRequest {
  const raw = record(value, 'the push-back request');
  exactFields(raw, ['repoPath', 'briefingSha256', 'reason', 'by'], 'the push-back request');
  const repoPath = boundedString(raw, 'repoPath', 1, BRIEFING_REVIEW_REPO_PATH_MAX);
  const sha = raw['briefingSha256'];
  if (typeof sha !== 'string' || !SHA256_HEX.test(sha)) {
    throw invalidRequest('briefingSha256 must be a lowercase sha256 hex digest');
  }
  const reason = boundedString(raw, 'reason', 1, BRIEFING_REVIEW_PUSHBACK_REASON_MAX);
  if (raw['by'] !== 'gru') throw invalidRequest('by must be "gru"');
  return { repoPath, briefingSha256: sha, reason, by: 'gru' };
}

/** Findings are evidence-bound: every blocking one quotes the marked
 * briefing, and the verdict must agree with the severities it carries. */
export function assertFindingEvidence(input: {
  readonly findings: readonly BriefingReviewFinding[];
  readonly verdict: BriefingReviewVerdict;
  readonly reviewed: string;
}): void {
  const trimmed = input.reviewed.trim();
  let blocking = 0;
  input.findings.forEach((finding, index) => {
    const evidence = finding.evidence.replace(/\s+$/u, '');
    if (evidence.length < BRIEFING_REVIEW_EVIDENCE_MIN || evidence.length > BRIEFING_REVIEW_EVIDENCE_MAX) {
      throw invalidRequest(
        `findings[${String(index)}].evidence must be ${String(BRIEFING_REVIEW_EVIDENCE_MIN)}–${String(BRIEFING_REVIEW_EVIDENCE_MAX)} characters after trimming end whitespace`,
      );
    }
    if (!trimmed.includes(evidence)) {
      throw invalidRequest(
        `findings[${String(index)}].evidence is not a verbatim span of the reviewed briefing between the review markers`,
      );
    }
    if (finding.severity === 'blocking') blocking += 1;
  });
  if (input.verdict === 'READY' && blocking > 0) {
    throw invalidRequest('a READY verdict may not carry a blocking finding');
  }
  if (input.verdict === 'CHANGES-NEEDED' && blocking === 0) {
    throw invalidRequest('a CHANGES-NEEDED verdict requires at least one blocking finding');
  }
}

/** The canonical finding identity a retry must match exactly. */
export function canonicalFindings(findings: readonly BriefingReviewFinding[]): string {
  return JSON.stringify(findings.map((finding) => [finding.code, finding.severity, finding.evidence, finding.whyItBlocks]));
}

export function blockingFindings(findings: readonly BriefingReviewFinding[]): number {
  return findings.filter((finding) => finding.severity === 'blocking').length;
}
