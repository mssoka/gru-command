import type { AgentHandle } from '../runtime/types.js';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { LogLevel } from '../logger.js';
import { DEFAULT_REVIEW_CHILDREN } from '../config.js';
import type { JobStatus, LedgerApi, RoundRecord, RoundVerdict } from '../ledger/api.js';
import { requireSafeRecordId } from '../ledger/api.js';
import { isJobTerminal, isRoundTerminal } from '../ledger/states.js';
import type { WorktreeLane, WorktreePort } from './worktree-port.js';
import {
  BranchBusyError,
  findBusyLanes,
  laneIsBusy,
  laneBranch,
  normalizeBranch,
  openAttemptStartSeq,
  pendingWorkRevision,
  resolveReviewTargetBranch,
  type BranchIdleBlocker,
  type BranchIdlePhase,
} from './branch-idle.js';
import type { AgentSpawner } from './service.js';
import type { EventBus } from '../events/bus.js';
import { validReviewOwnerGeneration, type ResidentReviewRound, type ReviewOwnerMarker } from '../runtime/registry.js';
import { settleRetries, type PacingGate, type PacingLease, type RateLimitBackoffPolicy, type RetrySettlement } from '../runtime/pacing.js';
import { isExactOriginBranchSpelling } from '../worktrees/manager.js';
import { deliveredTargetSha } from './silas-driver.js';
import type { CanonicalReviewVerdict, VerifiedFinding } from './perkins-review/types.js';
import { PerkinsWholeReview, verifiedSpecialistCheckpointResults, type PerkinsWholeResult, type RoundBudgetRefusal } from './perkins-review/whole.js';
import { publicRecoveryModelIdentity } from '../runtime/review-model-identity.js';
import { loadPerkinsPolicy, type PerkinsLens, type PerkinsPolicy } from './perkins-review/policy.js';
import { planPerkinsReviewScope, type PriorAcceptanceBinding, type PriorNativeReceipt } from './perkins-review/convergence.js';
import {
  freezeReviewInputs,
  compatibleReviewIdentity,
  proveRecoveredBaseMergeability,
  refMovedSinceFreeze,
  probeAdvertisedTipMovementAsync,
  sourceMovementSinceFreeze,
  resolveGitCommit,
  resolveReviewBaseRef,
  reviewArtifactDirectory,
  readReviewCheckpointBytes,
  writeReviewArtifact,
  FROZEN_MANIFEST_MAX_BYTES,
  FROZEN_SPEC_MAX_BYTES,
  type FreezeReviewInput,
  type FrozenReview,
} from './perkins-review/artifacts.js';
import { renderEffectiveContract } from '../review-inputs/amendments.js';
import {
  appendCiEvidence,
  renderRecordedCiEvidence,
  CI_BRANCH_STATE_EVENT,
  CI_FAILED_EVENT,
  CI_GREEN_EVENT,
  type CiEvidenceRecord,
} from '../review-inputs/ci-evidence.js';
import { admissionPreflight, ADMISSION_REMOTE_PROBE_TIMEOUT_MS, ReviewAdmissionError, type AdmissionMissingInput } from './perkins-review/admission.js';
import { evidenceRequestFingerprint, type ReviewEvidenceRequest } from '../review-inputs/evidence.js';
import { parseGitHubPrUrl } from './github-poll.js';
import {
  boundedDiff,
  isGitHubRemote,
  isGitLabRemote,
  parseFallbackFindingsReport,
  renderFixDirective,
  repoRemote,
  skillInstalled,
  triageFallbackFindings,
  type FallbackFinding,
  type ReviewCapabilityFailure,
  type ReviewPreflightResult,
} from './review-path.js';
import {
  appendRecordedVerification,
  renderRecordedVerification,
  selectNewestBoundVerification,
} from '../verify/evidence.js';
import {
  PrHeadVerificationError,
  prBranchCandidate,
  resolveFreshPrHead,
  type PrHeadProbe,
} from './perkins-review/fresh-head.js';

/** Transport wait slice for one fallback-review turn: on expiry the live
 * minion is reported still-running and the SAME session is re-attached — the
 * worker's lifetime is never bounded by this value. */
export const FALLBACK_REVIEW_TIMEOUT_MS = 15 * 60 * 1_000;

/** The agent-rail label for one Perkins specialist child. First attempts
 * mint the plain lens name; a RETRY suffixes the attempt counter
 * (`blind#2`) so two attempts on one lens can never collide into duplicate
 * agent rows and transcript labels. */
export function lensAgentLabel(lens: string, attempt: number): string {
  return attempt > 1 ? `${lens}#${attempt}` : lens;
}

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

function redaction(_value: string): string {
  // A fixed placeholder: any digest of the redacted bytes would publish an
  // offline brute-force oracle for low-entropy secrets.
  return '[REDACTED]';
}

/** Keep verification evidence private when it resembles a credential. The
 * durable local report remains unchanged; only the PR-facing copy is masked. */
export function redactReviewForPublication(body: string): string {
  const patterns = [
    /-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/gu,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
    /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu,
    /\bAKIA[0-9A-Z]{16}\b/gu,
    /(?<![A-Za-z0-9])(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|secret[_-]?key|api[_-]?secret|password|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s`'"]+)/giu,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  ];
  return patterns.reduce((text, pattern) => text.replace(pattern, redaction), body);
}

/** Publication kinds the appendix can describe truthfully. The wording
 * follows the PR/MR URL FORM (pull/N vs merge_requests/N), which is the
 * provider family the posting adapter enacts; credential routing stays
 * with the stricter isGitHubRemote/isGitLabRemote checks. */
export type PublicationProviderKind = 'github' | 'gitlab' | 'unknown';

export function publicationProviderKindFor(prUrl: string | null): PublicationProviderKind {
  if (prUrl === null) return 'unknown';
  try {
    const url = new URL(prUrl.trim());
    if (isGitHubRemote(url.host) || /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/u.test(url.pathname)) return 'github';
    if (isGitLabRemote(url.host) || /\/-\/merge_requests\/\d+\/?$/u.test(url.pathname)) return 'gitlab';
  } catch {
    // An unparsable URL never gets a provider-specific publication claim.
  }
  return 'unknown';
}

/** Render one untrusted string as ONE sanitized inline-code span (T9):
 * newlines/control characters are collapsed (an embedded heading or list
 * item can never start a line), backticks are neutralized so the span
 * cannot be escaped, and overlong values are visibly truncated. */
function renderUntrustedInline(value: string, maxChars = 240): string {
  const single = value
    .split('')
    .map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/`+/gu, "'");
  if (single === '') return '(unspecified)';
  return single.length > maxChars ? `${single.slice(0, maxChars)}…[truncated]` : single;
}

/** One deterministic appendix line for the frozen CI record: distinct
 * wordings keep missing evidence (UNAVAILABLE / NOT-MATCHED — no bound
 * receipt) apart from a measured host failure (FAILED), and neither is
 * ever a PASS (gh-169: missing CI evidence is not a CI failure). */
function ciEvidenceLine(ci: CiEvidenceRecord | null | undefined): string | null {
  if (ci === null || ci === undefined) {
    return '- CI evidence at freeze: NOT RECORDED — this round predates the frozen CI-record disclosure; absence here is not a pass and not a failure';
  }
  const bound = `observed ${ci.observedAt ?? 'unknown time'} via ${ci.sourceKind ?? 'unknown'} (ledger seq ${ci.sourceSeq ?? 'unknown'})`;
  // Q7: untrusted check/failure NAMES are individually bounded and
  // visibly elided past a small cap — a hostile long name cannot push an
  // otherwise publishable body past the provider bound, and the elision
  // is explicit rather than silent truncation.
  const boundedNames = (names: readonly string[]): string => {
    if (names.length === 0) return 'none named';
    const shown = names.slice(0, 5).map((name) => renderUntrustedInline(name, 60));
    return names.length > shown.length
      ? `${shown.join(', ')}, … +${names.length - shown.length} more (elided)`
      : shown.join(', ');
  };
  switch (ci.state) {
    case 'green':
      return `- CI evidence at freeze: GREEN (recorded observation, ${ci.checks.length} retained check(s)) — ${bound}`;
    case 'pending':
      return `- CI evidence at freeze: PENDING — NOT PASS (${ci.checks.length} retained check(s)) — ${bound}`;
    case 'failed':
      return `- CI evidence at freeze: FAILED — NOT PASS (${ci.failures.length} retained failing check(s): ${boundedNames(ci.failures.map((failure) => failure.name))}) — ${bound}`;
    case 'unavailable':
      return `- CI evidence at freeze: UNAVAILABLE — NO BOUND CI RECEIPT (missing evidence, not a measured failure): ${renderUntrustedInline(ci.reason ?? 'no reason recorded', 200)}`;
    case 'not-matched':
      return `- CI evidence at freeze: NOT-MATCHED — the recorded observation cannot certify this review target (missing evidence, not a measured failure): ${renderUntrustedInline(ci.reason ?? 'no reason recorded', 200)}`;
  }
}

/** One journaled specialist start (the budget authority) as the
 * execution accounting consumes it. */
export interface SpecialistStartFact {
  readonly lens: string;
  readonly attempt: number;
}

/** Journal-sourced start totals for the published appendix (gh-169 P2):
 * conclusive disclosure counts STARTS from the authoritative journal —
 * not settled results — and names attempts that started but never
 * committed a result, so an unsettled retry can never be published as
 * "not used" or vanish from the started count. */
export interface AppendixStartTotals {
  readonly journaled: number;
  readonly startedLenses: readonly string[];
  readonly settledValid: number;
  readonly settledFailed: number;
  /** Formatted `lens aN` identities of journaled starts with no settled result. */
  readonly unsettled: readonly string[];
}

/** Parse the round's specialist-start journal into attempt facts. */
export function specialistStartFacts(events: ReadonlyArray<{ readonly payload: unknown }>): readonly SpecialistStartFact[] {
  const facts: SpecialistStartFact[] = [];
  for (const event of events) {
    const payload = typeof event.payload === 'object' && event.payload !== null
      ? (event.payload as { readonly lens?: unknown; readonly attempt?: unknown }) : null;
    if (payload !== null && typeof payload.lens === 'string' && payload.lens !== '' &&
      (payload.attempt === 1 || payload.attempt === 2)) {
      facts.push({ lens: payload.lens, attempt: payload.attempt });
    }
  }
  return facts;
}

/** The one-line host execution summary for a settled INCOMPLETE round
 * (gh-169 P1): starts are counted from the journal AT ATTEMPT GRANULARITY
 * — a settled first attempt can never hide a charged-but-unsettled retry
 * — and settled results keep their own valid/failed counts. */
export function settledExecutionFactsLine(
  journaledStarts: readonly SpecialistStartFact[],
  specialistRuns: ReadonlyArray<{ readonly lens: string; readonly attempt: number; readonly status: string }>,
  lenses: readonly string[],
): string {
  const settledPairs = new Set(specialistRuns.map((run) => `${run.lens}#${run.attempt}`));
  const unsettled = journaledStarts
    .filter((start) => !settledPairs.has(`${start.lens}#${start.attempt}`))
    .map((start) => `${start.lens} a${start.attempt}`);
  const startedLensSet = new Set(journaledStarts.map((start) => start.lens));
  const validSettled = specialistRuns.filter((run) => run.status === 'valid').length;
  const failedSettled = specialistRuns.filter((run) => run.status !== 'valid').length;
  const neverStarted = lenses.filter((lens) => !startedLensSet.has(lens));
  return `Specialist execution: ${journaledStarts.length} journaled start(s); settled results: ${specialistRuns.length} (${validSettled} valid, ${failedSettled} failed)` +
    `${unsettled.length > 0 ? `; ${unsettled.length} started-but-unsettled (${unsettled.join(', ')}) — the round ended before their result committed` : ''}` +
    `; ${neverStarted.length} of ${lenses.length} lens(es) never started (${neverStarted.join(', ') || 'none'}).`;
}

/** Compact host-owned factual appendix for the published body: retained
 * findings and execution facts (specialists ran/failed/not-used, prior
 * dispositions) assembled deterministically from the structured result, so
 * PR readers receive the real outcome regardless of the lead's prose. No
 * model transcription is involved; substantive judgment stays with the
 * reviewer. EVERY retained finding is listed (R8): there is no silent
 * first-50 cutoff — a body that cannot fit fails publication explicitly
 * before it is posted. */
export function hostDisclosureAppendix(
  review: {
    readonly findings: ReadonlyArray<{ readonly severity: string; readonly title: string; readonly location: string; readonly source: string }>;
    readonly specialistRuns: ReadonlyArray<{ readonly lens: string; readonly status: string; readonly findingsDelivered?: boolean; readonly recoveredForLead?: true; readonly cleanupRecordingError?: string; readonly evidenceRecordingError?: string; readonly progressError?: string }>;
    readonly priorDispositions: ReadonlyArray<{ readonly status: string }>;
    readonly budgetRefusals?: ReadonlyArray<RoundBudgetRefusal>;
    readonly targetSha?: string;
    readonly convergence?: {
      readonly reviewScope: 'whole' | 'delta' | 'integration';
      readonly scopeReason?: string;
      readonly deltaUnavailable?: string;
      readonly deltaFromSha?: string;
      readonly integrationFromSha?: string;
      readonly integrationBaseSha?: string;
      readonly integrationPriorDiffBase?: string;
      readonly integrationDeltaSha256?: string;
      readonly carriedPriors?: readonly number[];
      readonly deferredFollowups?: readonly { readonly title: string; readonly location: string; readonly severity: string }[];
      readonly verdictRecomputed?: { readonly from: string; readonly to: string };
      readonly finalPassRequired?: true;
    };
  },
  provider: PublicationProviderKind,
  /** The round's APPLICABLE catalog (full or explicit no-spec): the
   * not-used accounting is derived from what this round could run, never
   * from a historical or future catalog. */
  lenses: readonly string[],
  /** The CI record as FROZEN for this round (gh-169): the published body
   * states the frozen CI evidence distinctly — missing (UNAVAILABLE /
   * NOT-MATCHED) is never rendered as a measured failure, and a measured
   * failure is never softened. Absent parameter = the round predates the
   * disclosure or carried no record; that absence is stated, not guessed. */
  ciEvidence?: CiEvidenceRecord | null,
  /** Journal-sourced start totals (gh-169 P2): when supplied, the started
   * totals and not-used classification derive from the authoritative
   * start journal — a journaled-but-unsettled attempt is disclosed, never
   * counted as "not used". */
  startTotals?: AppendixStartTotals,
): string {
  const counts = new Map<string, number>();
  for (const finding of review.findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const severityLine = ['blocker', 'warning', 'note']
    .filter((severity) => (counts.get(severity) ?? 0) > 0)
    .map((severity) => `${counts.get(severity)} ${severity}`)
    .join(', ');
  const findingsLines = review.findings.length === 0
    ? ['- none retained']
    : review.findings.map((finding) =>
        `- [${finding.severity}] \`${renderUntrustedInline(finding.title)}\` — \`${renderUntrustedInline(finding.location)}\` (source: ${renderUntrustedInline(finding.source, 40)})`);
  const byLens = new Map<string, { valid: number; failed: number; undelivered: boolean; restored: boolean; cleanupGap: boolean; evidenceGap: boolean; progressGap: boolean }>();
  for (const run of review.specialistRuns) {
    const entry = byLens.get(run.lens) ?? { valid: 0, failed: 0, undelivered: false, restored: false, cleanupGap: false, evidenceGap: false, progressGap: false };
    if (run.status === 'valid') entry.valid += 1;
    else entry.failed += 1;
    if (run.recoveredForLead === true) entry.restored = true;
    else if (run.findingsDelivered === false) entry.undelivered = true;
    if (run.cleanupRecordingError !== undefined) entry.cleanupGap = true;
    if (run.evidenceRecordingError !== undefined) entry.evidenceGap = true;
    if (run.progressError !== undefined) entry.progressGap = true;
    byLens.set(run.lens, entry);
  }
  const ran = [...byLens.entries()].sort(([left], [right]) => left.localeCompare(right));
  const failed = ran.filter(([, entry]) => entry.failed > 0);
  const undelivered = ran.filter(([, entry]) => entry.undelivered);
  const restored = ran.filter(([, entry]) => entry.restored);
  const cleanupGaps = ran.filter(([, entry]) => entry.cleanupGap);
  const evidenceGaps = ran.filter(([, entry]) => entry.evidenceGap);
  const progressGaps = ran.filter(([, entry]) => entry.progressGap);
  const notUsed = lenses.filter((lens) => !byLens.has(lens) && !(startTotals?.startedLenses.includes(lens) ?? false));
  const startedAttempts = startTotals?.journaled ?? ran.reduce((total, [, entry]) => total + entry.valid + entry.failed, 0);
  const validAttempts = startTotals?.settledValid ?? ran.reduce((total, [, entry]) => total + entry.valid, 0);
  const failedAttempts = startTotals?.settledFailed ?? ran.reduce((total, [, entry]) => total + entry.failed, 0);
  const ciLine = ciEvidenceLine(ciEvidence);
  const prior = review.priorDispositions;
  const priorFixed = prior.filter((disposition) => disposition.status === 'fixed').length;
  const priorStill = prior.length - priorFixed;
  const publicationLine = provider === 'github'
    ? 'Publication: authenticated COMMENT review on the reviewed commit by the service posting account; the substantive verdict is the independent review judgment recorded in this report, not a formal GitHub APPROVED/CHANGES_REQUESTED event.'
    : provider === 'gitlab'
      ? 'Publication: GitLab merge-request note by the service posting account — GitLab notes are not server-side commit-bound, so delivery is verified against the frozen head at post time; the substantive verdict is the independent review judgment recorded in this report, not a formal GitLab approval event.'
      : 'Publication: provider publication by the service posting account; the substantive verdict is the independent review judgment recorded in this report, not a formal provider approval event.';
  return [
    '---',
    '',
    '## Execution and findings (host-recorded facts)',
    '',
    `- Retained findings: ${review.findings.length}${severityLine === '' ? '' : ` (${severityLine})`}`,
    ...findingsLines,
    `- Available specialist lenses this round: ${lenses.length}`,
    `- Specialist attempts started: ${startedAttempts}${startTotals !== undefined ? ' journaled' : ''} (${validAttempts} valid, ${failedAttempts} failed${startTotals !== undefined && startTotals.unsettled.length > 0 ? `; ${startTotals.unsettled.length} started-but-unsettled: ${startTotals.unsettled.join(', ')}` : ''}) across ${startTotals !== undefined ? startTotals.startedLenses.length : ran.length} of ${lenses.length} available lenses`,
    ...(startTotals !== undefined && startTotals.unsettled.length > 0
      ? [`- Specialist attempts that started but never committed a result: ${startTotals.unsettled.join(', ')} — the round ended (or the wave failed) before their settlement; they are real started work, never "not used"`]
      : []),
    ...(ciLine !== null ? [ciLine] : []),
    `- Specialists run${startTotals !== undefined ? ' (settled)' : ''}: ${ran.length === 0
      ? startTotals !== undefined && startTotals.startedLenses.length > 0
        ? `none settled (${startTotals.startedLenses.length} lens(es) started — see the started-but-unsettled line)`
        : 'none (lead-owned whole-change review)'
      : ran.map(([lens, entry]) => `${lens}${entry.failed > 0 ? ` (attempts: ${entry.valid} valid, ${entry.failed} failed)` : ''}`).join(', ')}`,
    ...(failed.length > 0 ? [`- Failed specialist attempts: ${failed.map(([lens, entry]) => `${lens} ×${entry.failed}`).join(', ')} — the lead judged the change on its own whole-change verification`] : []),
    ...(review.budgetRefusals !== undefined && review.budgetRefusals.length > 0
      ? [`- Round specialist budget: ${review.budgetRefusals.length} run call(s) refused by the ${review.budgetRefusals[0]!.cap}-run cap before any child started (${[...new Set(review.budgetRefusals.flatMap((refusal) => refusal.lenses))].join(', ')})`]
      : []),
    ...(undelivered.length > 0 ? [`- Specialist findings were NOT delivered to the lead: ${undelivered.map(([lens]) => lens).join(', ')} — those runs completed but the transport response failed, so the lead judged without their findings`] : []),
    ...(restored.length > 0 ? [`- Prior-round checkpoint evidence shown to the fresh lead: ${restored.map(([lens]) => lens).join(', ')} — earlier transport delivery was not inherited; the fresh lead was required to revalidate it against the frozen head`] : []),
    ...(cleanupGaps.length > 0 ? [`- Specialist cleanup failures that could not be recorded durably: ${cleanupGaps.map(([lens]) => lens).join(', ')}`] : []),
    ...(evidenceGaps.length > 0 ? [`- Specialist evidence recording gaps: ${evidenceGaps.map(([lens]) => lens).join(', ')} — those runs stand, but at least one of their evidence artifacts could not be written; the sealed run record carries the reason`] : []),
    ...(progressGaps.length > 0 ? [`- Specialist progress observer failures: ${progressGaps.map(([lens]) => lens).join(', ')} — the runs stand, but their progress report could not be published; the sealed run record carries the reason`] : []),
    ...(notUsed.length > 0 ? [`- Lenses not used this round: ${notUsed.join(', ')}`]: []),
    ...(prior.length > 0 ? [`- Prior findings revisited: ${prior.length} (${priorFixed} fixed, ${priorStill} still present)`] : []),
    ...(review.convergence === undefined ? [] : [
      `- Review scope: ${review.convergence.reviewScope === 'integration'
        ? `integration review — prior coverage retained for the unchanged feature work; the review unit is the new integration/conflict-resolution work${review.convergence.integrationFromSha !== undefined ? ` since ${review.convergence.integrationFromSha}` : ''} integrated with base ${review.convergence.integrationBaseSha ?? 'n/a'}`
        : review.convergence.reviewScope === 'delta'
          ? `delta since the last reviewed SHA${review.convergence.deltaUnavailable !== undefined ? ` (delta UNAVAILABLE — disclosed whole-change re-verification: ${review.convergence.deltaUnavailable})` : ''}`
          : 'whole change (standing authority)'}`,
      ...(review.convergence.scopeReason !== undefined ? [`- Review scope reason: ${review.convergence.scopeReason}`] : []),
      ...(review.convergence.finalPassRequired === true
        ? ['- Final whole-change pass: STILL OWED — this round did not cover the whole candidate, so a later whole-scope pass must close at this target before the change is merge-ready']
        : []),
      ...(review.convergence.integrationFromSha !== undefined
        ? [`- Integration provenance: prior covered head ${review.convergence.integrationFromSha} -> incoming base ${review.convergence.integrationBaseSha ?? 'n/a'} -> verdict head ${review.targetSha}${review.convergence.integrationDeltaSha256 !== undefined ? ` (integration unit sha256 ${review.convergence.integrationDeltaSha256})` : ''}`]
        : []),
      ...(review.convergence.carriedPriors !== undefined && review.convergence.carriedPriors.length > 0
        ? [`- Prior findings carried forward without re-verification: ${review.convergence.carriedPriors.length} (quoted evidence unchanged, cited file untouched)`]
        : []),
      ...(review.convergence.deferredFollowups !== undefined && review.convergence.deferredFollowups.length > 0
        ? [`- Follow-ups deferred by the convergence rule: ${review.convergence.deferredFollowups.length} — new finding(s) outside this round's delta hunks, filed as follow-ups; they are recorded in full and cannot hold the PR (${review.convergence.deferredFollowups.map((followUp) => `${followUp.severity}: "${followUp.title}" at ${followUp.location}`).join('; ')})`]
        : []),
      ...(review.convergence.verdictRecomputed !== undefined
        ? [`- Canonical verdict RECOMPUTED by the host convergence rule: the lead submitted "${review.convergence.verdictRecomputed.from}", the converged blocker set determines "${review.convergence.verdictRecomputed.to}"`]
        : []),
    ]),
    publicationLine,
  ].join('\n');
}

/** Conservative provider review-body bound (GitHub's is 65,536 characters;
 * the margin absorbs transport growth). A body over this bound is NEVER
 * silently trimmed: publication fails explicitly with complete local
 * evidence instead (R8). */
export const PUBLICATION_BODY_MAX_BYTES = 60_000;

/** Assemble the exact publication body (report + host appendix) and refuse
 * one that cannot carry the complete disclosure: the caller preserves the
 * complete retained-finding evidence locally and fails loudly. */
export function publicationBodyFor(
  reportText: string,
  review: Parameters<typeof hostDisclosureAppendix>[0],
  provider: PublicationProviderKind,
  lenses: readonly string[],
  ciEvidence?: CiEvidenceRecord | null,
  startTotals?: AppendixStartTotals,
): string {
  const body = `${reportText.trimEnd()}\n\n${hostDisclosureAppendix(review, provider, lenses, ciEvidence, startTotals)}\n`;
  if (Buffer.byteLength(body, 'utf8') > PUBLICATION_BODY_MAX_BYTES) {
    throw new Error(
      `publication body (${Buffer.byteLength(body, 'utf8')} bytes) exceeds the provider review-body limit (${PUBLICATION_BODY_MAX_BYTES} bytes); ` +
      'complete retained-finding evidence is preserved locally — refusing to publish a partial disclosure',
    );
  }
  return body;
}

type ReviewLensResult =
  | { readonly state: 'done'; readonly verdict: 'blocker' | 'warning' | 'note' | 'clean'; readonly evidence: string }
  | { readonly state: 'error'; readonly note: string };

/** Mutable lens-accounting holder (gh-169 R4-3): `recordLensResults`
 * fills it INCREMENTALLY so a mid-loop ledger failure still exposes every
 * chip that durably committed — the abort path reconciles from actual
 * committed state, never from a lost snapshot. */
interface LensAccounting {
  readonly results: ReviewLensResult[];
  readonly settledLenses: Set<string>;
  readonly unusedLenses: PerkinsLens[];
}

/** The PR identity a verdict delivery was proven against. HEAD equality is
 * the delivery invariant: `headSha` is the round's frozen target on any
 * successful delivery, while `baseSha` is the live PR base observed by the
 * poster's identity probe (before POST/reconciliation on GitHub, after the
 * note on GitLab). The base may advance after that probe; base age never
 * gates delivery. The receipt is what the ledger records, not a claim that
 * the base was sampled atomically with the provider review. */
export interface PrIdentity {
  readonly headSha: string;
  readonly baseSha: string;
}

/** Provider-verified proof that ONE review was actually published: parsed
 * from the provider's own response (never from a bare CLI exit), bound to
 * the exact published body digest and — where the provider records one —
 * the commit the review is attached to. The reviewer's transport is an
 * authenticated COMMENT on the operator's account; `event` and `actor`
 * expose exactly what the provider enacted so nothing downstream can claim
 * a formal APPROVED/CHANGES_REQUESTED GitHub event that never happened. */
export interface PostedReviewReceipt extends PrIdentity {
  /** Provider review/note id (non-empty). */
  readonly reviewId: string;
  /** Provider account that authored the publication (non-empty). */
  readonly actor: string;
  /** Provider review event actually enacted (e.g. 'COMMENTED', 'note'). */
  readonly event: string;
  /** Provider-recorded commit binding when the provider records one. */
  readonly commitId: string | null;
  /** sha256 of the exact published body, UTF-8. */
  readonly bodySha256: string;
}

export interface VerdictPosterInput {
  readonly prUrl: string;
  readonly host: string;
  readonly repoPath: string;
  readonly body: string;
  readonly targetSha: string;
  readonly baseSha: string;
}

/** Optional caller context for VerdictPoster.reconcile (bounded shared
 * hook, chief ruling j-642): 'post-failure' marks the live second lookup
 * that immediately follows a FAILED post() within the same publication
 * attempt — a backend may fail such a lookup closed (it must never
 * upgrade a failed post into a receipt or an absence certificate).
 * Omitted for ordinary standalone/recovery reconciliation, which keeps
 * its prior provider-proved semantics; the unannotated call is fully
 * backward-compatible. */
export type VerdictReconcileContext = { readonly reason: 'post-failure' };

export interface VerdictPoster {
  post(input: VerdictPosterInput): Promise<PostedReviewReceipt>;
  /** Idempotent reconciliation for an ambiguous post (e.g. a timeout after
   * the provider may have committed): find an already-published review for
   * this exact head whose body digest matches, or return null. Never
   * creates anything. Optional: a poster without provider lookup leaves an
   * ambiguous failure honestly unposted. The optional context distinguishes
   * a live post-failure second lookup from ordinary recovery. */
  reconcile?(input: VerdictPosterInput, context?: VerdictReconcileContext): Promise<PostedReviewReceipt | null>;
  /** Restart-recovery evidence (R30): the provider account this poster
   * posts as on `host` RIGHT NOW, resolved through the same credential the
   * live posting path uses. `recoverInterruptedRounds` only credits a
   * posted receipt whose actor matches this evidenced account — a locally
   * persisted actor is never taken on its own authority. Optional: a
   * poster that cannot evidence its posting account leaves an otherwise
   * reclaimable round honestly unresolved instead of promoting an
   * unverified identity. Implementations must fail loudly when the
   * credential cannot be resolved. */
  authenticatedActor?(host: string): Promise<string>;
}

/** Bounded pagination for ambiguous-delivery lookups (R4): both providers
 * page past the first hundred; an exhausted bound is an UNRESOLVED error,
 * never proof of absence or permission for a second POST. */
const MAX_RECONCILE_PAGES = 10;

/** A ref whose SPELLING names an origin remote branch (origin/<branch>,
 * refs/remotes/origin/<branch>, remotes/origin/<branch>). Such a ref is
 * NEVER an explicit pin (Perkins R3): even when nothing local resolves
 * it — a remote-only branch — the manager fetches that spelling, and a
 * linked-PR review must verify the live PR head instead of freezing
 * whatever the ref fetches to. */
const ORIGIN_REF_SPELLING = /^(?:(?:refs\/)?remotes\/origin\/|origin\/)/u;

function receiptDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** The exact `round.posted` payload the production writer appends (see
 * recordDelivery). ONE shared shape for writer and restart-recovery reader
 * (R2/R21): the reader can never be more permissive than the writer. */
export interface PostedEventPayload {
  readonly verdict: RoundVerdict;
  readonly canonicalVerdict: CanonicalReviewVerdict;
  readonly url: string;
  readonly host: string;
  readonly targetSha: string;
  readonly baseSha: string;
  readonly publicationFile: string;
  readonly publicationSha256: string;
  readonly receipt: PostedReviewReceipt;
  readonly reconciled: boolean;
  /** The round's authenticated review scope/coverage/debt, persisted with the
   * posted event so restart recovery never has to infer debt from an absent
   * or damaged consolidated record. Absent on historical rounds. */
  readonly review?: PostedReviewState;
}

/** The durable posted review state: scope, whole-candidate coverage and the
 * final-pass obligation, plus the integration linkage when applicable. */
export interface PostedReviewState {
  readonly reviewScope: 'whole' | 'delta' | 'integration';
  readonly coverageComplete: boolean;
  readonly finalPassRequired: boolean;
  /** The round's own frozen diff base (persisted so promoted rounds can be
   * authenticated as predecessors without trusting the mutable file). */
  readonly diffBaseSha?: string;
  /** Retained finding identity, persisted BEFORE delivery so a
   * restart-promoted round can still authenticate its contents. */
  readonly blockers?: number;
  readonly retainedFindings?: number;
  readonly retainedFindingsSha256?: string;
  readonly integrationFromSha?: string;
  readonly integrationBaseSha?: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Strict, THROW-FREE parse of a `round.posted` payload (R1): a null
 * receipt, mistyped fields or a non-object all return null so one corrupt
 * row can never crash startup recovery; the round simply stays
 * interrupted. */
export function parsePostedEventPayload(payload: unknown): PostedEventPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const verdict = value['verdict'];
  const canonicalVerdict = value['canonicalVerdict'];
  const url = value['url'];
  const host = value['host'];
  const targetSha = value['targetSha'];
  const baseSha = value['baseSha'];
  const publicationFile = value['publicationFile'];
  const publicationSha256 = value['publicationSha256'];
  const reconciled = value['reconciled'];
  const receiptValue = value['receipt'];
  if (verdict !== 'approved' && verdict !== 'changes-requested') return null;
  if (typeof canonicalVerdict !== 'string') return null;
  // The ledger verdict and the recorded canonical verdict must agree — a
  // posted event claiming approval beside a NEEDS CHANGES review is not a
  // coherent writer product.
  if (verdict === 'approved' ? canonicalVerdict !== 'READY TO MERGE' : !['NEEDS CHANGES', 'MAJOR REWORK NEEDED'].includes(canonicalVerdict)) {
    return null;
  }
  if (!nonEmptyString(url) || !nonEmptyString(host) || !nonEmptyString(targetSha) || !nonEmptyString(baseSha)) return null;
  if (!nonEmptyString(publicationFile) || !nonEmptyString(publicationSha256)) return null;
  if (typeof reconciled !== 'boolean') return null;
  if (typeof receiptValue !== 'object' || receiptValue === null || Array.isArray(receiptValue)) return null;
  const receipt = receiptValue as Record<string, unknown>;
  if (
    !nonEmptyString(receipt['reviewId']) || (receipt['reviewId'] as string).length > 200 ||
    !nonEmptyString(receipt['actor']) || (receipt['actor'] as string).length > 200 ||
    !nonEmptyString(receipt['event']) || (receipt['event'] as string).length > 64 ||
    !nonEmptyString(receipt['headSha']) || !nonEmptyString(receipt['baseSha']) ||
    !nonEmptyString(receipt['bodySha256'])
  ) return null;
  const commitId = receipt['commitId'];
  if (commitId !== null && !nonEmptyString(commitId)) return null;
  const parsedReview = parsePostedReviewState(value['review']);
  return {
    verdict,
    canonicalVerdict: canonicalVerdict as CanonicalReviewVerdict,
    url,
    host,
    targetSha,
    baseSha,
    publicationFile,
    publicationSha256,
    reconciled,
    ...(parsedReview !== null ? { review: parsedReview } : {}),
    receipt: {
      reviewId: receipt['reviewId'], actor: receipt['actor'], event: receipt['event'],
      commitId: commitId as string | null, headSha: receipt['headSha'], baseSha: receipt['baseSha'],
      bodySha256: receipt['bodySha256'],
    },
  };
}

/** Strict, throw-free parse of the optional posted `review` block. A malformed
 * block is treated as ABSENT (recovery then falls back to the preserved
 * consolidated record and fails closed when that is unusable). */
function parsePostedReviewState(value: unknown): PostedReviewState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const review = value as Record<string, unknown>;
  const scope = review['reviewScope'];
  if (scope !== 'whole' && scope !== 'delta' && scope !== 'integration') return null;
  if (typeof review['coverageComplete'] !== 'boolean' || typeof review['finalPassRequired'] !== 'boolean') return null;
  const diffBaseSha = review['diffBaseSha'];
  if (typeof diffBaseSha !== 'string' || !/^[0-9a-f]{40}$/u.test(diffBaseSha)) return null;
  const blockers = review['blockers'];
  const retainedFindings = review['retainedFindings'];
  const retainedFindingsSha256 = review['retainedFindingsSha256'];
  if (!Number.isSafeInteger(blockers) || (blockers as number) < 0) return null;
  if (!Number.isSafeInteger(retainedFindings) || (retainedFindings as number) < 0) return null;
  if (typeof retainedFindingsSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(retainedFindingsSha256)) return null;
  const from = review['integrationFromSha'];
  const base = review['integrationBaseSha'];
  // An integration claim must carry its full linkage; a whole/delta claim
  // must not carry a partial one.
  if (scope === 'integration') {
    if (typeof from !== 'string' || !/^[0-9a-f]{40}$/u.test(from)) return null;
    if (typeof base !== 'string' || !/^[0-9a-f]{40}$/u.test(base)) return null;
  } else if (from !== undefined || base !== undefined) {
    return null;
  }
  return {
    reviewScope: scope,
    coverageComplete: review['coverageComplete'],
    finalPassRequired: review['finalPassRequired'],
    diffBaseSha,
    blockers: blockers as number,
    retainedFindings: retainedFindings as number,
    retainedFindingsSha256,
    ...(typeof from === 'string' ? { integrationFromSha: from } : {}),
    ...(typeof base === 'string' ? { integrationBaseSha: base } : {}),
  };
}

/** Host-side binding of a provider receipt before anything is recorded as
 * delivered: the receipt must name the reviewed commit, carry the digest of
 * the exact published body, and identify the provider review/actor/event. A
 * zero-exit post whose response fails any of this is NOT a delivery. */
export function verifyPostedReceipt(
  receipt: PostedReviewReceipt,
  expected: { readonly targetSha: string; readonly bodySha256: string },
): PostedReviewReceipt {
  if (receipt.headSha !== expected.targetSha) {
    throw new Error(
      `provider receipt head ${receipt.headSha || 'unknown'} does not match the reviewed commit ${expected.targetSha} — delivery not recorded`,
    );
  }
  if (receipt.commitId !== null && receipt.commitId !== expected.targetSha) {
    throw new Error(
      `provider receipt is bound to commit ${receipt.commitId}, not the reviewed commit ${expected.targetSha} — delivery not recorded`,
    );
  }
  // The shared restart reader requires a nonempty base, so a receipt
  // without one can never become a readable round.posted event (R34).
  if (receipt.baseSha.trim() === '') {
    throw new Error('provider receipt is missing the base binding — delivery not recorded');
  }
  if (receipt.bodySha256 !== expected.bodySha256) {
    throw new Error('provider receipt body digest does not match the published body — delivery not recorded');
  }
  if (receipt.reviewId.trim() === '' || receipt.reviewId.length > 200) {
    throw new Error('provider receipt is missing a review id — delivery not recorded');
  }
  if (receipt.actor.trim() === '' || receipt.event.trim() === '') {
    throw new Error('provider receipt is missing the posting actor or event — delivery not recorded');
  }
  return receipt;
}

/** GitHub poster using a commit-bound pull-request review, not an unbound
 * comment. The API's commit_id makes a head race rejectable server-side. */
export class GhPrPoster implements VerdictPoster {
  constructor(private readonly binary = 'gh') {}

  /** The account gh actually authenticates as on this host — the ONLY
   * identity a receipt's actor may match (R5). Resolved once per posting
   * operation and deliberately NEVER cached across operations: gh's
   * credential can rotate under a long-lived service (R29), and only a
   * fresh resolution can evidence which account is posting now. One
   * operation still probes once, so a stable credential costs exactly one
   * call per post/reconcile. No account is hard-coded and no new
   * credential path exists. */
  private resolveAuthenticatedLogin(host: string): string {
    const who = spawnSync(
      this.binary,
      ['api', '--hostname', host, 'user', '--jq', '.login'],
      { encoding: 'utf8', timeout: 15_000 },
    );
    if (who.error !== undefined || who.status !== 0) {
      throw new Error(`cannot resolve the authenticated gh account on ${host} (${String(who.error ?? who.stderr).trim().slice(0, 200)}) — delivery not recorded`);
    }
    const login = (who.stdout ?? '').trim();
    if (login === '') throw new Error(`gh authenticated account on ${host} is unknown — delivery not recorded`);
    return login;
  }

  /** Restart-recovery evidence (R30): the account gh authenticates as on
   * the host now — the same resolution the live posting path enforces. */
  async authenticatedActor(host: string): Promise<string> {
    return this.resolveAuthenticatedLogin(host);
  }

  /** Provider review ids are integers (or provider-quoted strings); a null
   * or otherwise unusable id must never be stringified into a receipt
   * (R13). */
  private static reviewIdOf(id: unknown): string {
    if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
    if (typeof id === 'string' && id.trim() !== '') return id;
    return '';
  }

  async post(input: VerdictPosterInput): Promise<PostedReviewReceipt> {
    const { apiPath, observedHead, observedBase } = this.githubPrIdentity(input);
    // R32: resolve the authenticated account BEFORE the irreversible POST.
    // A credential hiccup must refuse delivery loudly with no review
    // created (or stranded unrecorded); the post-POST receipt-actor
    // comparison below remains the enforcement step.
    const authenticatedLogin = this.resolveAuthenticatedLogin(input.host);
    const result = spawnSync(
      this.binary,
      ['api', '--hostname', input.host, '--method', 'POST', `${apiPath}/reviews`, '--input', '-'],
      {
        input: `${JSON.stringify({ body: input.body, event: 'COMMENT', commit_id: input.targetSha })}\n`,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    if (result.error !== undefined) {
      throw new Error(`gh is unavailable (${String(result.error)}) — SHA-bound review not delivered`);
    }
    if (result.status !== 0) {
      throw new Error(`gh api review delivery exited ${result.status}: ${(result.stderr ?? '').trim().slice(0, 500)}`);
    }
    // The receipt is the provider's own review object, never the CLI exit:
    // id, actor, enacted event, bound commit and echoed body are each
    // verified against what this delivery claimed to publish.
    let created: { id?: unknown; user?: { login?: unknown }; state?: unknown; commit_id?: unknown; body?: unknown };
    try {
      created = JSON.parse((result.stdout ?? '').trim()) as typeof created;
    } catch {
      throw new Error('gh api review delivery returned no parsable review receipt — delivery not recorded');
    }
    const reviewId = GhPrPoster.reviewIdOf(created.id);
    const actor = typeof created.user?.login === 'string' ? created.user.login : '';
    const event = typeof created.state === 'string' ? created.state : '';
    // The provider must have enacted the requested COMMENT review — a
    // response carrying any other state is not the delivery we asked for
    // (R6), and the receipt's author must be the authenticated posting
    // account, never somebody else's review (R5).
    if (event !== 'COMMENTED') {
      throw new Error(`provider enacted review state ${event === '' ? '(none)' : event} instead of COMMENTED — delivery not recorded`);
    }
    if (actor.toLowerCase() !== authenticatedLogin.toLowerCase()) {
      throw new Error(`provider receipt actor ${actor === '' ? '(none)' : actor} is not the authenticated posting account ${authenticatedLogin} — delivery not recorded`);
    }
    // A GitHub pull-request review MUST name the commit it is bound to: a
    // response without a usable commit_id is not a SHA-bound receipt, no
    // matter what else it carries (T5).
    if (typeof created.commit_id !== 'string' || created.commit_id.trim() === '') {
      throw new Error('provider receipt is missing the GitHub commit binding (commit_id) — delivery not recorded');
    }
    const commitId = created.commit_id;
    const echoedBody = typeof created.body === 'string' ? created.body : null;
    if (echoedBody === null || receiptDigest(echoedBody) !== receiptDigest(input.body)) {
      throw new Error('provider receipt body does not match the published body — delivery not recorded');
    }
    return verifyPostedReceipt(
      { reviewId, actor, event, commitId, headSha: observedHead, baseSha: observedBase, bodySha256: receiptDigest(echoedBody) },
      { targetSha: input.targetSha, bodySha256: receiptDigest(input.body) },
    );
  }

  /** Ambiguous-post reconciliation: find an existing provider review bound
   * to the frozen head whose body is byte-identical to ours, authored by
   * the authenticated account in the enacted COMMENTED state. Read-only,
   * paged past the first hundred under an explicit bound — an exhausted
   * bound is UNRESOLVED, never proof of absence or permission to repost
   * (R4). */
  async reconcile(input: VerdictPosterInput): Promise<PostedReviewReceipt | null> {
    const { apiPath, observedHead, observedBase } = this.githubPrIdentity(input);
    const authenticatedLogin = this.resolveAuthenticatedLogin(input.host);
    const reviews: Array<{ id?: unknown; user?: { login?: unknown }; state?: unknown; commit_id?: unknown; body?: unknown }> = [];
    for (let page = 1; page <= MAX_RECONCILE_PAGES; page += 1) {
      const listed = spawnSync(
        this.binary,
        ['api', '--hostname', input.host, `${apiPath}/reviews?per_page=100&page=${page}`],
        { encoding: 'utf8', timeout: 30_000 },
      );
      if (listed.error !== undefined || listed.status !== 0) {
        throw new Error(`gh api review reconciliation query failed (${(listed.stderr ?? String(listed.error ?? '')).trim().slice(0, 300)})`);
      }
      let pageReviews: ReadonlyArray<{ id?: unknown; user?: { login?: unknown }; state?: unknown; commit_id?: unknown; body?: unknown }>;
      try {
        const parsed = JSON.parse((listed.stdout ?? '').trim()) as unknown;
        if (!Array.isArray(parsed)) throw new Error('not an array');
        pageReviews = parsed as typeof pageReviews;
      } catch {
        throw new Error('gh api review reconciliation response was not a review list');
      }
      reviews.push(...pageReviews);
      if (pageReviews.length < 100) break;
      if (page === MAX_RECONCILE_PAGES) {
        // R28: hitting the bound is an exhaustion signal, not authority to
        // discard evidence already collected. A fully bound match from any
        // page returned so far IS delivery evidence; only a bounded lookup
        // with no verified match anywhere is unresolved.
        const collectedMatch = this.boundMatchFrom(reviews, input, authenticatedLogin, observedHead, observedBase);
        if (collectedMatch !== null) return collectedMatch;
        throw new Error(
          `GitHub review reconciliation exceeded the ${MAX_RECONCILE_PAGES}-page lookup bound without exhausting the review list; delivery stays unresolved — verify manually before any retry, never assume absence`,
        );
      }
    }
    return this.boundMatchFrom(reviews, input, authenticatedLogin, observedHead, observedBase);
  }

  /** The single GitHub bound-match selection shared by the ordinary exit
   * and the R28 bound-hit exit: an existing provider review bound to the
   * frozen head whose body is byte-identical to ours, authored by the
   * authenticated account in the enacted COMMENTED state. Returns null
   * when no such review exists among the collected pages. */
  private boundMatchFrom(
    reviews: ReadonlyArray<{ id?: unknown; user?: { login?: unknown }; state?: unknown; commit_id?: unknown; body?: unknown }>,
    input: VerdictPosterInput,
    authenticatedLogin: string,
    observedHead: string,
    observedBase: string,
  ): PostedReviewReceipt | null {
    const matches = reviews.filter((review) =>
      review.commit_id === input.targetSha &&
      typeof review.body === 'string' && receiptDigest(review.body) === receiptDigest(input.body) &&
      typeof review.user?.login === 'string' && review.user.login.toLowerCase() === authenticatedLogin.toLowerCase() &&
      review.state === 'COMMENTED');
    // Newest usable match wins; a later match with an unusable review id
    // must not mask an earlier fully bound one (R13/R28). If EVERY match
    // carries an unusable id, refuse loudly instead of reporting absence.
    let sawUnusableId = false;
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const found = matches[index]!;
      const reviewId = GhPrPoster.reviewIdOf(found.id);
      if (reviewId === '') {
        sawUnusableId = true;
        continue;
      }
      return verifyPostedReceipt(
        {
          reviewId,
          actor: typeof found.user?.login === 'string' ? found.user.login : '',
          event: typeof found.state === 'string' ? found.state : '',
          commitId: typeof found.commit_id === 'string' ? found.commit_id : null,
          headSha: observedHead,
          baseSha: observedBase,
          bodySha256: receiptDigest(input.body),
        },
        { targetSha: input.targetSha, bodySha256: receiptDigest(input.body) },
      );
    }
    if (sawUnusableId) throw new Error('provider receipt is missing a review id — delivery not recorded');
    return null;
  }

  /** URL/origin checks plus the live pre-POST PR identity probe. Only HEAD
   * equality gates delivery: the PR's recorded base (pinned at open/link
   * time) is expected to trail the frozen base as main moves; the frozen
   * diff is immutable, so a stale recorded base is never a refusal. */
  private githubPrIdentity(input: VerdictPosterInput): {
    readonly apiPath: string;
    readonly observedHead: string;
    readonly observedBase: string;
  } {
    let url: URL;
    try {
      url = new URL(input.prUrl.trim());
    } catch {
      throw new Error(`cannot parse pull request URL: ${input.prUrl}`);
    }
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/u.exec(url.pathname);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
      match === null || input.host !== url.host || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(input.host)
    ) {
      throw new Error(`invalid or host-mismatched GitHub pull request URL: ${input.prUrl}`);
    }
    const owner = match[1]!;
    const repo = match[2]!;
    const prNumber = match[3]!;
    const originIdentity = repoRemote(input.repoPath);
    if (
      originIdentity === null || originIdentity.host.toLowerCase() !== input.host.toLowerCase() ||
      originIdentity.owner.toLowerCase() !== owner.toLowerCase() || originIdentity.repo.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new Error('pull request URL does not match the reviewed repository origin');
    }
    const apiPath = `repos/${owner}/${repo}/pulls/${prNumber}`;
    const identity = spawnSync(
      this.binary,
      ['api', '--hostname', input.host, apiPath, '--jq', '[.head.sha,.base.sha] | @tsv'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (identity.error !== undefined) {
      throw new Error(`gh is unavailable (${String(identity.error)}) — review not delivered`);
    }
    if (identity.status !== 0) {
      throw new Error(`gh api pull identity exited ${identity.status}: ${(identity.stderr ?? '').trim().slice(0, 500)}`);
    }
    const [observedHead = '', observedBase = ''] = (identity.stdout ?? '').trim().split('\t');
    if (observedHead !== input.targetSha) {
      throw new Error(
        `pull request identity moved before delivery (expected head ${input.targetSha}, ` +
        `got ${observedHead || 'unknown'})`,
      );
    }
    // R34 shape symmetry: the shared restart reader requires a nonempty
    // receipt base, so no writer path may record a receipt without one.
    // Every provider that reports a head also reports a usable base; an
    // empty base is a malformed identity and is refused BEFORE any POST.
    if (observedBase.trim() === '') {
      throw new Error('pull request identity response is missing the base sha — refusing an unrecordable receipt; review not delivered');
    }
    return { apiPath, observedHead, observedBase };
  }
}

/** GitLab merge-request poster: same SHA-bound discipline as the GitHub
 * poster, delivered through the GitLab REST API with PRIVATE-TOKEN. */
export interface GitLabMrPosterOptions {
  readonly token?: string;
  readonly tokenResolver?: () => string | undefined;
  readonly fetchImpl?: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  readonly gitBinary?: string;
}

export class GitLabMrPoster implements VerdictPoster {
  private readonly token: string | undefined;
  private readonly tokenResolver: () => string | undefined;
  private readonly fetchImpl: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  private readonly gitBinary: string;
  /** Username per host, bound to the credential that proved it: ONE entry
   * per host holding only a sha256 discriminator (never the plaintext
   * token), so a rotated token replaces the stale identity instead of
   * accumulating retired secrets (R29). */
  private readonly authenticatedUsers = new Map<string, { readonly credentialSha256: string; readonly username: string }>();

  constructor(options: GitLabMrPosterOptions = {}) {
    this.token = options.token;
    this.tokenResolver = options.tokenResolver ?? (() => process.env['GITLAB_TOKEN'] ?? process.env['GL_TOKEN']);
    this.fetchImpl = options.fetchImpl ?? (fetch as never);
    this.gitBinary = options.gitBinary ?? 'git';
  }

  /** The account the PRIVATE-TOKEN authenticates as on this host — the only
   * author whose notes this service may claim (R5). Resolved once per
   * (host, token) credential through the SAME token, no new credential
   * path; a rotated token is a different key and probes again (R29). */
  private async resolveAuthenticatedUser(host: string, headers: { readonly 'PRIVATE-TOKEN': string; readonly 'CONTENT-TYPE': string }): Promise<string> {
    const credentialSha256 = createHash('sha256').update(headers['PRIVATE-TOKEN']).digest('hex');
    const cached = this.authenticatedUsers.get(host);
    if (cached !== undefined && cached.credentialSha256 === credentialSha256) return cached.username;
    let response: Awaited<ReturnType<typeof this.fetchImpl>>;
    try {
      response = await this.fetchImpl(`https://${host}/api/v4/user`, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new Error(`GitLab authenticated-account probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`GitLab authenticated-account probe exited HTTP ${response.status} — delivery stays unresolved`);
    }
    let user: { username?: unknown };
    try {
      user = JSON.parse((await response.text()).slice(0, 1024 * 1024)) as typeof user;
    } catch {
      throw new Error('GitLab authenticated-account response was not valid JSON');
    }
    const username = typeof user.username === 'string' ? user.username.trim() : '';
    if (username === '') throw new Error('GitLab token authenticates no named account — delivery stays unresolved');
    this.authenticatedUsers.set(host, { credentialSha256, username });
    return username;
  }

  /** Restart-recovery evidence (R30): the account the configured GitLab
   * token authenticates as on the host now, resolved through the same
   * token resolver the live posting path uses. */
  async authenticatedActor(host: string): Promise<string> {
    const token = this.token ?? this.tokenResolver();
    if (token === undefined || token.trim() === '') {
      throw new Error('GitLab delivery requires GITLAB_TOKEN — the posting account cannot be evidenced');
    }
    return this.resolveAuthenticatedUser(host, { 'PRIVATE-TOKEN': token, 'CONTENT-TYPE': 'application/json' });
  }

  /** Provider note ids are integers (or provider-quoted strings); a null,
   * absent or otherwise unusable id must never be stringified into a
   * receipt (R27), mirroring `GhPrPoster.reviewIdOf` (R13). */
  private static reviewIdOf(id: unknown): string {
    if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
    if (typeof id === 'string' && id.trim() !== '') return id;
    return '';
  }

  async post(input: VerdictPosterInput): Promise<PostedReviewReceipt> {
    const { mrUrl, headers, observedBase } = await this.gitLabIdentity(input);
    // Resolve the token's account BEFORE creating anything (V1/R5): the
    // note's echoed author must match it, and an unnamed account refuses
    // delivery before a note exists.
    const author = await this.resolveAuthenticatedUser(input.host, headers);
    let noteResponse: Awaited<ReturnType<typeof this.fetchImpl>>;
    try {
      noteResponse = await this.fetchImpl(`${mrUrl}/notes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: input.body }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`GitLab note delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!noteResponse.ok) {
      throw new Error(`GitLab note delivery exited HTTP ${noteResponse.status}: ${(await noteResponse.text()).slice(0, 300)}`);
    }
    // The receipt is the provider's own note object: id, author and the
    // echoed body are verified against what this delivery published.
    let created: { id?: unknown; body?: unknown; author?: { username?: unknown } };
    try {
      created = JSON.parse((await noteResponse.text()).slice(0, 4 * 1024 * 1024)) as typeof created;
    } catch {
      throw new Error('GitLab note delivery returned no parsable note receipt — delivery not recorded');
    }
    const reviewId = GitLabMrPoster.reviewIdOf(created.id);
    const actor = typeof created.author?.username === 'string' ? created.author.username : '';
    const echoedBody = typeof created.body === 'string' ? created.body : null;
    if (echoedBody === null || receiptDigest(echoedBody) !== receiptDigest(input.body)) {
      throw new Error('provider receipt body does not match the published body — delivery not recorded');
    }
    if (actor.toLowerCase() !== author.toLowerCase()) {
      throw new Error(`provider receipt actor ${actor === '' ? '(none)' : actor} is not the authenticated posting account ${author} — delivery not recorded`);
    }
    const confirmed = await this.confirmHead(mrUrl, headers, input.targetSha, observedBase);
    // GitLab notes are not commit-bound server-side; the post-delivery head
    // re-probe IS the binding, and the refresh record carries whatever base
    // the MR now reports so a moving main never refuses a proven head.
    return verifyPostedReceipt(
      {
        reviewId, actor, event: 'note', commitId: null,
        headSha: confirmed.headSha, baseSha: confirmed.baseSha,
        bodySha256: receiptDigest(echoedBody),
      },
      { targetSha: input.targetSha, bodySha256: receiptDigest(input.body) },
    );
  }

  /** Ambiguous-post reconciliation FAILS CLOSED (R3/T7): GitLab notes
   * carry no server-side commit binding, so a body-matching note — even by
   * the authenticated author, even on the MR's current head — proves
   * neither the head it was created on nor the attempt that created it.
   * A historical match can therefore NEVER become a delivered receipt;
   * only exhaustive pagination with zero authored matches is an honest
   * `null` (nothing was posted). No new correlation protocol exists. */
  async reconcile(input: VerdictPosterInput): Promise<PostedReviewReceipt | null> {
    const { mrUrl, headers } = await this.gitLabIdentity(input);
    const author = await this.resolveAuthenticatedUser(input.host, headers);
    const authoredMatches: Array<{ id?: unknown; body?: unknown }> = [];
    const foreignMatches: Array<{ id?: unknown; body?: unknown }> = [];
    const foreignAuthors = new Set<string>();
    let listExhausted = false;
    for (let page = 1; page <= MAX_RECONCILE_PAGES; page += 1) {
      let listResponse: Awaited<ReturnType<typeof this.fetchImpl>>;
      try {
        listResponse = await this.fetchImpl(`${mrUrl}/notes?per_page=100&page=${page}`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        throw new Error(`GitLab note reconciliation query failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!listResponse.ok) {
        throw new Error(`GitLab note reconciliation exited HTTP ${listResponse.status} — cannot verify delivery`);
      }
      let notes: ReadonlyArray<{ id?: unknown; body?: unknown; author?: { username?: unknown } }>;
      try {
        const parsed = JSON.parse((await listResponse.text()).slice(0, 8 * 1024 * 1024)) as unknown;
        if (!Array.isArray(parsed)) throw new Error('not an array');
        notes = parsed as typeof notes;
      } catch {
        throw new Error('GitLab note reconciliation response was not a note list');
      }
      // Body matches are classified by author, not filtered away: an
      // identical note by ANOTHER account is ambiguity (R35), never
      // absence. A body match with an unusable author is unattributed and
      // therefore also ambiguity, not proof this service posted.
      for (const note of notes) {
        if (typeof note.body !== 'string' || receiptDigest(note.body) !== receiptDigest(input.body)) continue;
        const noteAuthor = typeof note.author?.username === 'string' ? note.author.username.trim() : '';
        if (noteAuthor !== '' && noteAuthor.toLowerCase() === author.toLowerCase()) {
          authoredMatches.push(note);
        } else {
          foreignMatches.push(note);
          foreignAuthors.add(noteAuthor === '' ? '(unattributed)' : `@${noteAuthor}`);
        }
      }
      if (notes.length < 100) {
        listExhausted = true;
        break;
      }
      if (page === MAX_RECONCILE_PAGES) break;
    }
    // Body matches decide the outcome before an exhausted-page bound does
    // (same ordering discipline as R28 on the GitHub side): the bound is
    // not authority to discard a decisive match already collected.
    if (authoredMatches.length > 0) {
      throw new Error(
        `GitLab reconciliation found a body-matching note by ${author}, but GitLab notes carry no server-side commit binding — ` +
        'the note\'s creation head and creating attempt cannot be proved, so this historical match is NOT delivery evidence (fail closed); the round stays honestly unposted',
      );
    }
    if (foreignMatches.length > 0) {
      throw new Error(
        `GitLab reconciliation found ${foreignMatches.length} body-identical note(s) by ${[...foreignAuthors].sort().join(', ')} but none authored by ${author} — ` +
        'delivery is AMBIGUOUS, not absent (the authenticated account may or may not have posted); never attribute another account\'s note as this service\'s delivery — verify manually before any retry, never assume absence',
      );
    }
    if (!listExhausted) {
      throw new Error(
        `GitLab note reconciliation exceeded the ${MAX_RECONCILE_PAGES}-page lookup bound without exhausting the note list; delivery stays unresolved — verify manually before any retry, never assume absence`,
      );
    }
    return null;
  }

  /** URL/origin/token checks plus the live pre-POST MR identity probe. Only
   * HEAD equality gates delivery: the MR's recorded base is pinned at
   * open/link time and is expected to trail the frozen base as main moves. */
  private async gitLabIdentity(input: VerdictPosterInput): Promise<{
    readonly mrUrl: string;
    readonly headers: { readonly 'PRIVATE-TOKEN': string; readonly 'CONTENT-TYPE': string };
    readonly observedBase: string;
  }> {
    const token = this.token ?? this.tokenResolver();
    if (token === undefined || token.trim() === '') {
      throw new Error('GitLab delivery requires GITLAB_TOKEN — review not delivered');
    }
    let url: URL;
    try {
      url = new URL(input.prUrl.trim());
    } catch {
      throw new Error(`cannot parse merge request URL: ${input.prUrl}`);
    }
    const match = /^\/(.+)\/-\/merge_requests\/(\d+)\/?$/u.exec(url.pathname);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
      match === null || input.host !== url.host || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(input.host)
    ) {
      throw new Error(`invalid or host-mismatched GitLab merge request URL: ${input.prUrl}`);
    }
    // Project path may carry GitLab subgroups: repo is the final segment,
    // owner is the full leading path (used URL-encoded for the API project id).
    const projectPath = match[1]!;
    const iid = match[2]!;
    const separator = projectPath.lastIndexOf('/');
    const owner = separator === -1 ? projectPath : projectPath.slice(0, separator);
    const repo = projectPath.slice(separator + 1);
    const origin = repoRemote(input.repoPath, this.gitBinary);
    if (
      origin === null || origin.host.toLowerCase() !== url.host.toLowerCase() ||
      origin.owner.toLowerCase() !== owner.toLowerCase() || origin.repo.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new Error('merge request URL does not match the reviewed repository origin');
    }
    const project = encodeURIComponent(`${owner}/${repo}`);
    const headers = { 'PRIVATE-TOKEN': token, 'CONTENT-TYPE': 'application/json' };
    const mrUrl = `https://${input.host}/api/v4/projects/${project}/merge_requests/${iid}`;
    let identityResponse: Awaited<ReturnType<typeof this.fetchImpl>>;
    try {
      identityResponse = await this.fetchImpl(mrUrl, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new Error(`GitLab merge request identity probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!identityResponse.ok) {
      throw new Error(`GitLab merge request identity probe exited HTTP ${identityResponse.status} — review not delivered`);
    }
    let identity: { sha?: unknown; diff_refs?: { base_sha?: unknown } | null };
    try {
      identity = JSON.parse((await identityResponse.text()).slice(0, 4 * 1024 * 1024)) as typeof identity;
    } catch {
      throw new Error('GitLab merge request identity response was not valid JSON');
    }
    const observedHead = typeof identity.sha === 'string' ? identity.sha : '';
    if (observedHead !== input.targetSha) {
      throw new Error(
        `merge request identity moved before delivery (expected head ${input.targetSha}, got ${observedHead || 'unknown'})`,
      );
    }
    // R34 shape symmetry: the shared restart reader requires a nonempty
    // receipt base, so the base must be proven usable BEFORE the note POST
    // (the base itself is only informational — it need not equal the
    // frozen base as main moves). A missing diff_refs.base_sha is refused
    // loudly here, never persisted into an event recovery cannot read.
    const observedBase = typeof identity.diff_refs?.base_sha === 'string' ? identity.diff_refs.base_sha : '';
    if (observedBase.trim() === '') {
      throw new Error('merge request identity response is missing the base sha (diff_refs.base_sha) — refusing an unrecordable receipt; review not delivered');
    }
    return { mrUrl, headers, observedBase };
  }

  /** Live MR identity probe with HEAD equality enforced. The base is
   * informational and was already proven usable for this SAME head by the
   * pre-POST probe, so a transiently absent post-delivery base falls back
   * to the proven one instead of stranding a note that already exists
   * (R34). A confirmed base, when present, is preferred. */
  private async confirmHead(
    mrUrl: string,
    headers: { readonly 'PRIVATE-TOKEN': string; readonly 'CONTENT-TYPE': string },
    targetSha: string,
    provenBaseSha: string,
  ): Promise<{ readonly headSha: string; readonly baseSha: string }> {
    let response: Awaited<ReturnType<typeof this.fetchImpl>>;
    try {
      response = await this.fetchImpl(mrUrl, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new Error(`GitLab merge request identity probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`GitLab merge request identity probe exited HTTP ${response.status}`);
    }
    let identity: { sha?: unknown; diff_refs?: { base_sha?: unknown } | null };
    try {
      identity = JSON.parse((await response.text()).slice(0, 4 * 1024 * 1024)) as typeof identity;
    } catch {
      throw new Error('GitLab merge request identity response was not valid JSON');
    }
    const headSha = typeof identity.sha === 'string' ? identity.sha : '';
    if (headSha !== targetSha) {
      throw new Error(
        `merge request identity moved (expected head ${targetSha}, got ${headSha || 'unknown'}) — delivery not recorded`,
      );
    }
    const confirmedBaseSha = typeof identity.diff_refs?.base_sha === 'string' ? identity.diff_refs.base_sha : '';
    const baseSha = confirmedBaseSha.trim() === '' ? provenBaseSha : confirmedBaseSha;
    if (baseSha.trim() === '') {
      throw new Error('merge request identity response is missing the base sha (diff_refs.base_sha) — refusing an unrecordable receipt; delivery not recorded');
    }
    return { headSha, baseSha };
  }
}

/** Production poster: picks the SHA-bound backend by code host. The
 * discriminator matches the pre-flight's: github.com remotes go to the gh
 * poster, gitlab hosts to the GitLab poster, anything else fails closed. */
export class AutoVerdictPoster implements VerdictPoster {
  constructor(
    private readonly github: VerdictPoster = new GhPrPoster(),
    private readonly gitlab: VerdictPoster = new GitLabMrPoster(),
  ) {}

  async post(input: VerdictPosterInput): Promise<PostedReviewReceipt> {
    return this.select(input).post(input);
  }

  /** Reconciliation reaches the SAME host-selected provider as posting —
   * an ambiguous post must be reconciled by the backend that created it,
   * never by a hand-picked alternate. */
  async reconcile(input: VerdictPosterInput, context?: VerdictReconcileContext): Promise<PostedReviewReceipt | null> {
    const poster = this.select(input);
    if (typeof poster.reconcile !== 'function') {
      throw new Error(`the selected ${new URL(input.prUrl.trim()).host} poster does not support reconciliation — delivery stays honestly unresolved`);
    }
    // The caller context reaches the SAME host-selected backend that the
    // post used — never a hand-picked alternate.
    return poster.reconcile(input, context);
  }

  /** Restart-recovery evidence (R30) through the SAME host selection the
   * post used: the account the selected backend would post as right now.
   * A backend that cannot evidence its account leaves the receipt actor
   * unverified rather than silently trusted. */
  async authenticatedActor(host: string): Promise<string> {
    const poster = this.selectByHost(host);
    if (typeof poster.authenticatedActor !== 'function') {
      throw new Error(`the selected ${host} poster cannot evidence its authenticated posting account — the receipt actor stays unverified`);
    }
    return poster.authenticatedActor(host);
  }

  private selectByHost(host: string): VerdictPoster {
    if (isGitHubRemote(host)) return this.github;
    if (isGitLabRemote(host)) return this.gitlab;
    throw new Error(
      `unsupported code host for verdict delivery: ${host} — the review gate supports GitHub (gh) and GitLab (GITLAB_TOKEN) remotes`,
    );
  }

  private select(input: VerdictPosterInput): VerdictPoster {
    let host = '';
    try {
      host = new URL(input.prUrl.trim()).host;
    } catch {
      throw new Error(`cannot parse pull request URL: ${input.prUrl}`);
    }
    return this.selectByHost(host);
  }
}

// ---------------------------------------------------------------------------
// bmad-review fallback gate (user amendment 2026-09-20, fork-3 extension)
// ---------------------------------------------------------------------------

export interface FallbackReviewRunInput {
  readonly jobId: string;
  readonly lanePath: string;
  readonly baseRef: string;
  readonly diff: string;
  readonly skillPath: string;
  /** Where the session must write ONE JSON findings array. */
  readonly reportFile: string;
  readonly iteration: number;
  readonly signal: AbortSignal;
}

export interface FixDirectiveDelivery {
  readonly delivered: boolean;
  readonly minionId?: string;
  readonly note?: string;
}

export type FixDirectiveSink = (input: {
  readonly jobId: string;
  readonly directive: string;
  readonly blockers: readonly FallbackFinding[];
  readonly iteration: number;
  readonly signal: AbortSignal;
}) => Promise<{ readonly delivered: boolean; readonly minionId?: string; readonly note?: string }>;

/** Mutable gate state observed through the outcome's live getters. */
export interface FallbackGateState {
  clearToMerge: boolean;
  iterations: number;
  blockers: number;
  notes: number;
  reportFiles: string[];
  note: string;
}

export interface FallbackGateOptions {
  /** Installed bmad-review skill file (never bundled with the product). */
  readonly skillPath: string;
  /** Review rounds before the gate reports blocked; default 4 (3 fix rounds + final). */
  readonly maxReviewRounds?: number;
  /** Runs one bmad-review pass and returns its findings. */
  readonly runFallbackReview?: (input: FallbackReviewRunInput) => Promise<readonly FallbackFinding[]>;
  /** Routes blocker findings back to the implementing minion session. */
  readonly fixDirectiveSink: FixDirectiveSink;
}

export interface FallbackGateOutcome {
  readonly route: 'bmad-review-fallback';
  readonly failedLegs: readonly ReviewCapabilityFailure[];
  readonly skillInstalled: boolean;
  /** Gate verdict: true only after a clean triage round (merge stays user-held). */
  readonly clearToMerge: boolean;
  readonly iterations: number;
  readonly blockers: number;
  readonly notes: number;
  readonly reportFiles: readonly string[];
  readonly note: string;
  readonly run: Promise<void>;
}

export type ReviewRequestOutcome =
  | { readonly route: 'perkins'; readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }
  | { readonly route: 'queued'; readonly jobId: string; readonly requestSeq: number; readonly run: Promise<void> }
  | FallbackGateOutcome;

/** Thrown when a direct beginRound caller bypasses requestReview while the
 * pre-flight routes to the bmad-review fallback gate. */
export class FallbackGateRequiredError extends Error {
  constructor(readonly failures: readonly ReviewCapabilityFailure[]) {
    super(
      `Perkins pre-flight failed — route this review through the bmad-review fallback gate: ` +
      failures.map((leg) => `${leg.leg} (${leg.detail})`).join('; '),
    );
    this.name = 'FallbackGateRequiredError';
  }
}

function sanitizeErrorLog(error: unknown): string {
  return String(error).replace(/[\r\n]+/gu, ' ').slice(0, 300);
}

/** The durable handoff can no longer be authorized from CURRENT job
 * state; the obligation stays visible and needs a new validated request. */
export class HandoffHeldError extends Error {
  constructor(readonly status: string, readonly requestSeq: number) {
    super(`handoff held: job status ${status}`);
    this.name = 'HandoffHeldError';
  }
}

/** Bounded identity context for a wave escalation. A call site passes only
 * values it already holds (its round/job record or a concrete actor id);
 * title/detail text is never parsed for identity. Absent or contradictory
 * context leaves the notification unbound and live. */
export interface EscalationContext {
  readonly jobId?: string;
  readonly roundId?: string;
  readonly agentId?: string;
}

export interface WaveRunnerOptions {
  readonly ledger: LedgerApi;
  readonly worktrees: WorktreePort;
  readonly spawner: AgentSpawner;
  /** Service-wide paired resident admission; omitted by standalone workflow tests. */
  readonly reserveReviewRound?: (signal: AbortSignal) => Promise<ResidentReviewRound>;
  /** Stable runtime implementation identity, not a credential or model alias. */
  readonly reviewRuntimeIdentity?: () => { readonly id: string; readonly version: string };
  readonly reviewThinkingLevel?: () => string;
  /** Runtime-owned proof that an interrupted owner has actually ceased. */
  readonly reconcileReviewAgent?: (agentId: string, marker: ReviewOwnerMarker | null) => Promise<boolean>;
  readonly maxConcurrentChildren?: number;
  /** Ledger bus used to admit a worker's durable handoff after its turn delivers. */
  readonly bus?: EventBus;
  /** Provider pacing: combined lead+lens review-turn gate for Perkins
   * rounds. Absent = off; an unlimited or disabled gate admits at once. */
  readonly reviewGate?: PacingGate;
  readonly workerGate?: PacingGate;
  readonly rateLimitBackoff?: RateLimitBackoffPolicy | null;
  /** Provider pacing: the bounded settlement of an automatic rate-limit
   * retry covering a fallback-review minion turn. The review records the
   * turn as delivered only for 'none'/'recovered'; the worker lease is
   * released before the wait so the retry can reacquire admission. */
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  readonly poster?: VerdictPoster;
  readonly escalate?: (title: string, detail: string, context?: EscalationContext) => void;
  /** FYI channel, never action-required: an automatic admission retry was
   * scheduled or skipped. Absent = the durable ledger trail only. */
  readonly inform?: (title: string, detail: string, context?: EscalationContext) => void;
  /** Supersession proof (owner rule 3): which of these review session ids
   * still hold a live runtime handle. Production wires the runtime
   * registry; absent = the ledger agent state is the only session proof. */
  readonly liveReviewSessions?: (agentIds: readonly string[]) => readonly string[];
  /** Bound on waiting for a superseded review to stop (default
   * {@link REVIEW_SUPERSESSION_DEADLINE_MS}); past it the stop is
   * unconfirmed and the writer is refused, never started alongside. */
  readonly supersessionDeadlineMs?: number;
  /** Bounded automatic retry of a TRANSIENT admission refusal (owner
   * decision 2026-10-08): the wait before each retry, in order. Default
   * {@link ADMISSION_RETRY_DELAYS_MS}; the action-required escalation
   * follows only the refusal of the last retry. */
  readonly admissionRetryDelaysMs?: readonly number[];
  /** Stable service-owned root. Required for every production review. */
  readonly reviewArtifactRoot?: string;
  /** The service uploads dir (`<data_dir>/uploads`): the ONLY namespace an
   * arm may select private review evidence from. Absent = evidence intake
   * refuses loudly. */
  readonly evidenceUploadsDir?: string;
  /** Test/packaging seam. Production always uses the integrity-pinned loader. */
  readonly reviewPolicyLoader?: () => PerkinsPolicy;
  /** Fail-closed four-leg capability pre-flight, evaluated per review request
   * with the job's repository path. Absent = Perkins route (test seam). */
  readonly reviewPreflight?: (input: { readonly repoPath: string }) => Promise<ReviewPreflightResult>;
  /** Read-only instrumentation (gh-169 Q9): invoked exactly once per
   * round, immediately after the freeze receipts and BEFORE the admission
   * preflight — the single seam where tests observe (or, for refusal
   * fixtures, corrupt) the just-frozen packet without touching live
   * sources. Production leaves it unset; it never alters the packet. */
  readonly reviewFreezeObserver?: (review: FrozenReview) => void;
  /** bmad-review fallback gate configuration. Required for fallback routing
   * to be available; without it a failed pre-flight reports both options. */
  readonly fallbackGate?: FallbackGateOptions;
  /** PR-branch freeze guard seam: reads the live code-host head identity a
   * round's fetched branch tip is validated against. Production probes the
   * code host; tests inject a deterministic double. */
  readonly prHeadProbe?: PrHeadProbe;
  readonly log?: Log;
}

export interface WaveOutcome {
  readonly round: RoundRecord;
  readonly results: readonly ReviewLensResult[];
  readonly verdict: RoundVerdict | null;
  readonly posted: boolean;
  readonly canonicalVerdict: CanonicalReviewVerdict;
  readonly reportFile: string;
  readonly artifactDirectory: string;
  readonly headMoved: boolean;
  /** Stage-5 convergence: a delta round that posted READY still owes the
   * final whole-change pass. The wave chains that pass before returning; a
   * crash between the two leaves this flag durable so approval stays gated
   * on the whole-scope round actually running. */
  readonly finalPass?: { readonly required: true; readonly targetSha: string };
}

/** Bounded fallback-gate safety refusal: a re-brief request or revoked
 * handoff authorization appeared at a concrete async boundary of a running
 * bmad-review gate (iteration intake, or the default reviewer's worker-gate
 * admission). The gate stops fail-closed before the next diff intake or
 * reviewer spawn; it is never a partial round. */
class FallbackSafetyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FallbackSafetyRefusal';
  }
}

/** A late delivered STATUS after an already-recorded delivery is harmless.
 * A working hop hidden by a later status is not: the old diff is obsolete.
 * If the bounded history cannot prove no hop occurred, fail closed. */
function fallbackWorkingStartedSince(ledger: LedgerApi, jobId: string, baselineSeq: number): boolean {
  const latest = ledger.latestJobEvent(jobId, 'job.status');
  if (latest === null || latest.seq <= baselineSeq) return false;
  const events = ledger.listJobEvents(jobId, { limit: 1000 });
  if (events.length === 1000 && events[events.length - 1]!.seq > baselineSeq) return true;
  return events.some((event) => event.seq > baselineSeq && event.kind === 'job.status' &&
    typeof event.payload === 'object' && event.payload !== null &&
    (event.payload as { to?: unknown }).to === 'working');
}

/** Owner decision 2026-10-08: two automatic retries, one and five minutes
 * after a transient admission refusal. */
export const ADMISSION_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000];

/** Node's setTimeout ceiling (2^31 - 1 ms): no retry delay may exceed it. */
const MAX_TIMER_MS = 2_147_483_647;

/** The request an automatic admission retry re-submits — never `force`,
 * which authorizes only the blockers present at its own arm. A clean-abort
 * re-arm keeps its delivered-head fence (R7-23). */
interface AdmissionRetryInput {
  readonly jobId: string;
  readonly targetRef?: string;
  readonly boundDeliveredSha?: string;
  readonly lenses?: readonly string[];
  readonly noSpec?: boolean;
  readonly evidence?: readonly ReviewEvidenceRequest[];
  readonly claimedFixedPriors?: readonly number[];
}

/** One job's automatic admission retry, held IN MEMORY only (owner decision
 * 2026-10-08, revised the same day): the refused request, re-submitted as
 * it was; the refusal it answers; and which retry it is. Nothing resumes it
 * after a restart — startup escalates instead
 * ({@link WaveRunner.escalateInterruptedAdmissionRetries}). */
interface AdmissionRetry {
  readonly input: AdmissionRetryInput;
  readonly roundId: string;
  readonly deliverySeq: number;
  /** 1-based: the retry this entry runs. */
  readonly attempt: number;
  /** When it is due (epoch ms). */
  readonly dueAt: number;
  /** Its `round.admission-retry-scheduled` record — bookkeeping only, so a
   * restart can tell an interrupted retry from a settled one. */
  readonly scheduledSeq: number;
  timer: NodeJS.Timeout | null;
  /** Its own request is running: that request's refusal continues the chain. */
  running: boolean;
}

function admissionRetryInput(input: AdmissionRetryInput): AdmissionRetryInput {
  return {
    jobId: input.jobId,
    ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
    ...(input.boundDeliveredSha !== undefined ? { boundDeliveredSha: input.boundDeliveredSha } : {}),
    ...(input.lenses !== undefined ? { lenses: input.lenses } : {}),
    ...(input.noSpec !== undefined ? { noSpec: input.noSpec } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.claimedFixedPriors !== undefined ? { claimedFixedPriors: input.claimedFixedPriors } : {}),
  };
}

/** Errors already escalated to Gru where they arose: a wrapper that
 * reports failures never alerts for them twice (R7-16, R8-25). */
const ALREADY_NOTIFIED = Symbol('already-notified');

function markNotified<T extends Error>(error: T): T {
  Object.defineProperty(error, ALREADY_NOTIFIED, { value: true });
  return error;
}

function alreadyNotified(error: unknown): boolean {
  return error instanceof ReviewAdmissionError ||
    (error instanceof Error && (error as Error & { [ALREADY_NOTIFIED]?: boolean })[ALREADY_NOTIFIED] === true);
}

/** Another setup for the same job is already running. */
class RoundAdmissionInProgress extends Error {
  constructor(jobId: string) {
    super(`review round admission for job ${jobId} is already in progress; retry after setup settles`);
    this.name = 'RoundAdmissionInProgress';
  }
}

/** Default bound on a superseded review's stop (owner rule 3). */
export const REVIEW_SUPERSESSION_DEADLINE_MS = 120_000;

/** The abort reason a superseded review operation carries: an approved
 * material change made its candidate obsolete (owner rule 3). Routine — a
 * superseded round is history, never an action-required incident. */
export class ReviewSupersededError extends Error {
  constructor(readonly jobId: string, readonly reason: string) {
    super(`review superseded for job ${jobId}: ${reason}`);
    this.name = 'ReviewSupersededError';
  }
}

/** A writer asked for a lane whose review is running and whose candidate
 * is still current (no material correction pending): the delivered branch
 * stays frozen until the verdict (owner clarification 2026-10-08). */
export class ReviewInProgressError extends Error {
  constructor(readonly jobId: string, readonly roundIds: readonly string[]) {
    super(
      `job ${jobId} is under review${roundIds.length > 0 ? ` (round ${roundIds.join(', ')})` : ''} and no approved ` +
        'material change makes its candidate obsolete — the delivered branch stays frozen until the verdict; ' +
        'send this after the verdict, or record the approved change as a material amendment to supersede the review',
    );
    this.name = 'ReviewInProgressError';
  }
}

/** A superseded review could not be PROVEN stopped within the bound: the
 * writer is refused (never started alongside) and Gru is escalated. */
export class ReviewSupersessionUnconfirmedError extends Error {
  constructor(readonly jobId: string, readonly detail: string) {
    super(`review supersession for job ${jobId} is unconfirmed: ${detail}`);
    this.name = 'ReviewSupersessionUnconfirmedError';
  }
}

/** The settled result of one supersession pass. */
export interface ReviewSupersession {
  readonly jobId: string;
  /** Rounds this pass superseded (pending = withdrawn, live = cancelled). */
  readonly roundIds: readonly string[];
  /** Tracked review operations aborted (setup, run or fallback gate). */
  readonly operations: number;
  /** True when every operation settled, every round is terminal and no
   * review session is still alive. */
  readonly confirmed: boolean;
  readonly detail: string | null;
}

/** One live review operation on a job (setup, Perkins run or fallback). */
interface ReviewOperation {
  readonly kind: 'setup' | 'perkins' | 'fallback';
  readonly roundId: string | null;
  readonly controller: AbortController;
  settled: Promise<unknown>;
}

export class WaveRunner {
  private readonly opts: WaveRunnerOptions;
  private readonly log: Log;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeFallbackGates = new Set<string>();
  private readonly handoffs = new Map<string, {
    readonly input: { jobId: string; targetRef?: string; lenses?: readonly string[]; noSpec?: boolean; force?: boolean; evidence?: readonly ReviewEvidenceRequest[] };
    readonly seq: number;
    starting: boolean;
    /** Post-intake hold: visible obligation, NOT sweep-rearmable. */
    held: boolean;
    settlementReplayRequested: boolean;
    readonly run: Promise<void>;
    readonly resolve: () => void;
  }>();
  private readonly stopHandoffListener: () => void;
  private shuttingDown = false;
  /** Automatic admission retries, one per job — in memory only. */
  private readonly admissionRetries = new Map<string, AdmissionRetry>();
  private readonly admissionRetryDelaysMs: readonly number[];
  /** Every live review operation per job (owner rule 5): the one place a
   * writer learns what review owns its lane, and what supersession stops. */
  private readonly reviewOperations = new Map<string, Set<ReviewOperation>>();
  /** Rounds deliberately superseded: their incident traffic is routine. */
  private readonly supersededRounds = new Set<string>();
  /** Jobs whose RUNNING fallback gate was superseded: its terminal record
   * is a routine supersession, not a BLOCKED/ABORTED incident. Cleared
   * when that gate operation settles. */
  private readonly supersededFallbackGates = new Set<string>();
  /** One supersession pass per job at a time; a second caller joins it. */
  private readonly supersessions = new Map<string, Promise<ReviewSupersession>>();

  constructor(opts: WaveRunnerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    const delays = opts.admissionRetryDelaysMs ?? ADMISSION_RETRY_DELAYS_MS;
    if (delays.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > MAX_TIMER_MS)) {
      throw new Error(`admissionRetryDelaysMs must be whole milliseconds from 0 to ${MAX_TIMER_MS}, got [${delays.join(', ')}]`);
    }
    this.admissionRetryDelaysMs = delays;
    this.stopHandoffListener = opts.bus?.subscribe((event) => {
      if (event.jobId === null) return;
      const pending = this.handoffs.get(event.jobId);
      if (pending === undefined) return;
      if (event.kind === 'silas.rebrief-settled') {
        // The delivery was published while its durable markers still stood.
        // A replay may already be unwinding that busy refusal; retry only
        // after it has released its starting flag.
        if (pending.starting) pending.settlementReplayRequested = true;
        else void this.startHandoff(event.jobId, pending);
      } else if (event.kind === 'job.delivered' && event.seq > pending.seq) {
        void this.startHandoff(event.jobId, pending);
      } else if (event.kind === 'verification.completed' && event.seq > pending.seq) {
        // Option A (owner, 2026-10-09): a corrective delivery waits for a
        // passing verification on its head; that pass re-offers the request.
        void this.startHandoff(event.jobId, pending);
      }
    }) ?? (() => {});
  }

  /** Restore acknowledged handoffs after restart; never freeze a branch
   * until a delivery newer than the handoff has cleared the idle guard. */
  resumeQueuedHandoffs(): void {
    for (const job of this.opts.ledger.listJobs()) {
      const queued = this.opts.ledger.latestJobEvent(job.id, 'job.review-handoff-queued');
      if (queued === null) continue;
      const started = this.opts.ledger.latestJobEvent(job.id, 'job.review-handoff-started');
      const failed = this.opts.ledger.latestJobEvent(job.id, 'job.review-handoff-failed');
      // A request an approved material change withdrew (owner rule 3) is
      // terminal: a restart never replays it against the obsolete candidate.
      const withdrawn = this.opts.ledger.latestJobEvent(job.id, 'job.review-handoff-withdrawn');
      if ((started?.seq ?? 0) > queued.seq || (failed?.seq ?? 0) > queued.seq || (withdrawn?.seq ?? 0) > queued.seq) continue;
      if (this.materialAmendmentSince(job.id, queued.seq)) {
        this.opts.ledger.appendCustomEvent({
          kind: 'job.review-handoff-withdrawn',
          jobId: job.id,
          payload: { requestSeq: queued.seq, reason: 'an approved material amendment was accepted after this review request' },
        });
        continue;
      }
      if (this.handoffs.has(job.id)) continue;
      // A terminal job or a swept lane can never admit this handoff: skip
      // truthfully (no failure, no escalation) instead of a spurious retry.
      const jobNow = this.opts.ledger.getJob(job.id);
      if (jobNow !== null && isJobTerminal(jobNow.status)) {
        this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-skipped', jobId: job.id,
          payload: { requestSeq: queued.seq, reason: 'terminal-job', status: jobNow.status },
        });
        continue;
      }
      const liveLane = this.opts.worktrees
        .listWorktrees({ jobId: job.id })
        .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
      if (liveLane === undefined) {
        this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-skipped', jobId: job.id,
          payload: { requestSeq: queued.seq, reason: 'no-live-lane' },
        });
        continue;
      }
      // Crash window: a claim was recorded but no started/failed terminal
      // marker followed. Ownership of any begun round is ambiguous — fail
      // closed with evidence; restart recovery terminalizes a begun round.
      const claimed = this.opts.ledger.latestJobEvent(job.id, 'job.review-handoff-claimed');
      const requeued = this.opts.ledger.latestJobEvent(job.id, 'job.review-handoff-requeued');
      // A REQUEUED marker NEWER than the claim, for the SAME request, is a
      // PROVEN no-admission attempt (known outcome) — safe to re-arm. Only
      // a claim with no later same-request outcome stays ambiguous.
      const provenNoAdmission = requeued !== null && claimed !== null &&
        requeued.seq > claimed.seq &&
        (requeued.payload as { requestSeq?: number } | null)?.requestSeq === (claimed.payload as { requestSeq?: number } | null)?.requestSeq;
      if (claimed !== null && claimed.seq > queued.seq && !provenNoAdmission &&
        (started?.seq ?? 0) < claimed.seq && (failed?.seq ?? 0) < claimed.seq) {
        const error = 'queued review handoff was claimed but never terminalized (crash window); refusing blind replay — reconcile the begun round, then re-request';
        this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-failed', jobId: job.id,
          payload: { requestSeq: queued.seq, claimedSeq: claimed.seq, error },
        });
        this.escalate(`Queued review handoff for job ${job.id} needs reconciliation`, error, { jobId: job.id });
        continue;
      }
      const payload = queued.payload as { input?: unknown } | null;
      const input = payload?.input;
      if (typeof input !== 'object' || input === null || (input as { jobId?: unknown }).jobId !== job.id) {
        const error = 'malformed queued review handoff requires operator repair';
        this.log('error', error, { job: job.id, seq: queued.seq });
        this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-failed', jobId: job.id,
          payload: { requestSeq: queued.seq, error },
        });
        this.escalate(`Queued review handoff failed for job ${job.id}`, error, { jobId: job.id });
        continue;
      }
      const pending = this.trackHandoff(input as { jobId: string }, queued.seq);
      const startedFor = (started?.payload as { requestSeq?: number } | null)?.requestSeq;
      if (startedFor !== undefined && startedFor !== queued.seq) {
        // A terminal marker for a DIFFERENT request does not satisfy this one.
      }
      const delivered = this.opts.ledger.latestJobEvent(job.id, 'job.delivered');
      // A pass that paid a corrective delivery's verification (option A)
      // re-offers the request just like a delivery does.
      const verifiedAfter = this.opts.ledger.latestJobEvent(job.id, 'verification.completed');
      if ((delivered !== null && delivered.seq > queued.seq) || (verifiedAfter !== null && verifiedAfter.seq > queued.seq)) {
        void this.startHandoff(job.id, pending);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopHandoffListener();
    for (const pending of this.handoffs.values()) pending.resolve();
    this.handoffs.clear();
    this.shuttingDown = true;
    // A scheduled admission retry stays durable: the next start resumes it.
    // In memory only: a restart's startup check escalates what was pending.
    for (const retry of this.admissionRetries.values()) if (retry.timer !== null) clearTimeout(retry.timer);
    this.admissionRetries.clear();
    const deadline = Date.now() + 30_000;
    while (this.activeOperations.size > 0) {
      for (const controller of this.activeControllers) controller.abort();
      await Promise.race([
        Promise.allSettled([...this.activeOperations]),
        new Promise<void>((resolve) => { setTimeout(resolve, 5_000); }),
      ]);
      if (Date.now() > deadline && this.activeOperations.size > 0) {
        this.log('error', 'shutdown deadline exceeded with operations still active', {
          count: this.activeOperations.size,
        });
        this.escalate(
          'Perkins review shutdown deadline exceeded',
          `${this.activeOperations.size} review operation(s) ignored cancellation; forcing shutdown. Rounds terminalize as INCOMPLETE via startup recovery.`,
        );
        return;
      }
    }
  }

  /** Escalation of record. A deliberately superseded round's own incident
   * traffic (INCOMPLETE, cancelled finalization, disposal) is routine FYI
   * (owner: routine supersession needs no Ack); an unconfirmed stop still
   * escalates action-required from the supersession itself. */
  private escalate(title: string, detail: string, context?: EscalationContext): void {
    // Durable too: a round whose supersession a restart interrupted is
    // recovered as routine history, never an action-required incident.
    if (context?.roundId !== undefined && (this.supersededRounds.has(context.roundId) ||
        this.opts.ledger.latestRoundEvent(context.roundId, 'round.superseded') !== null)) {
      this.opts.inform?.(`${title} (superseded)`, detail, context);
      return;
    }
    this.opts.escalate?.(title, detail, context);
  }

  /** Track a review operation against its job, so supersession can find,
   * abort and await it (owner rules 3 and 5). */
  private trackReview<T>(
    jobId: string,
    kind: ReviewOperation['kind'],
    roundId: string | null,
    operation: Promise<T>,
    controller: AbortController,
  ): Promise<T> {
    const entry: ReviewOperation = { kind, roundId, controller, settled: Promise.resolve() };
    let set = this.reviewOperations.get(jobId);
    if (set === undefined) {
      set = new Set();
      this.reviewOperations.set(jobId, set);
    }
    set.add(entry);
    const tracked = this.track(operation, controller).finally(() => {
      const current = this.reviewOperations.get(jobId);
      current?.delete(entry);
      if (current !== undefined && current.size === 0) this.reviewOperations.delete(jobId);
      if (kind === 'fallback') this.supersededFallbackGates.delete(jobId);
    });
    entry.settled = tracked.then(() => undefined, () => undefined);
    return tracked;
  }

  /** The review that owns a job's lane right now: rounds the ledger holds
   * pending/live, plus tracked operations (a setup that has not created its
   * round, a fallback gate). Null when no review owns the lane. */
  activeReview(jobId: string): { readonly roundIds: readonly string[]; readonly operations: number } | null {
    // A superseded round whose stop was never PROVEN still owns the lane
    // (owner rule 3): its sessions may run, so a later writer re-proves it
    // instead of trusting the round's terminal status.
    const roundIds = this.opts.ledger.listRounds(jobId)
      .filter((round) => !isRoundTerminal(round.status) || this.supersessionUnproven(round.id))
      .map((round) => round.id);
    const operations = this.reviewOperations.get(jobId)?.size ?? 0;
    // An unproven fallback stop still owns the lane after its operation
    // settled or a restart forgot it.
    const unprovenFallback = this.fallbackSupersessionUnproven(jobId);
    return roundIds.length === 0 && operations === 0 && !unprovenFallback ? null : { roundIds, operations };
  }

  /** True while a superseded round's stop is not PROVEN: no confirmation
   * newer than its supersession (or its last unconfirmed re-proof). A
   * restart that interrupted the pass leaves exactly this shape. */
  private supersessionUnproven(roundId: string): boolean {
    const superseded = this.opts.ledger.latestRoundEvent(roundId, 'round.superseded');
    if (superseded === null) return false;
    const unconfirmed = this.opts.ledger.latestRoundEvent(roundId, 'round.supersession-unconfirmed')?.seq ?? 0;
    const confirmed = this.opts.ledger.latestRoundEvent(roundId, 'round.supersession-confirmed')?.seq ?? 0;
    return confirmed < Math.max(superseded.seq, unconfirmed);
  }

  /** The same debt for a superseded review that owned no round (the
   * bmad-review fallback gate), kept durably on the job. */
  private fallbackSupersessionUnproven(jobId: string): boolean {
    const superseded = this.opts.ledger.latestJobEvent(jobId, 'job.review-superseded');
    if (superseded === null) return false;
    const unconfirmed = this.opts.ledger.latestJobEvent(jobId, 'job.review-supersession-unconfirmed')?.seq ?? 0;
    const confirmed = this.opts.ledger.latestJobEvent(jobId, 'job.review-supersession-confirmed')?.seq ?? 0;
    return confirmed < Math.max(superseded.seq, unconfirmed);
  }

  /** The cessation proof the next round's setup already demands of every
   * prior round (owner rule 3): a trusted no-spawn receipt, or the runtime
   * proving the round's owner marker and every registered session ceased.
   * Null when proven; otherwise what is unproven. */
  private async roundCessationProblem(roundId: string): Promise<string | null> {
    const round = this.opts.ledger.getRound(roundId);
    if (round === null) return `round ${roundId} is missing`;
    if (!isRoundTerminal(round.status)) return `round ${roundId} is still ${round.status}`;
    const marker = this.reviewOwnerMarker(round);
    const agents = this.opts.ledger.listAgents().filter((entry) => entry.roundId === round.id);
    const receipt = this.opts.ledger.uniqueRoundNoSpawnReceipt(round.id);
    const proof = receipt?.payload as { roundId?: unknown; generation?: unknown; ownerGeneration?: unknown } | null;
    const noSpawn = agents.length === 0 && receipt?.jobId === round.jobId && receipt.roundId === round.id &&
      proof?.roundId === round.id && validReviewOwnerGeneration(proof.generation) &&
      proof.ownerGeneration === (marker?.generation ?? null) &&
      (marker !== null || this.opts.ledger.latestRoundEvent(round.id, 'round.review-owner') === null) &&
      this.opts.ledger.listRoundSpecialistStarts(round.id).length === 0;
    if (noSpawn) return null;
    if (marker === null && agents.length === 0) {
      return `round ${round.id} has neither a no-spawn proof nor an owner marker — a spawn before registration cannot be ruled out`;
    }
    if (marker !== null && agents.length === 0 && await this.opts.reconcileReviewAgent?.('', marker) !== true) {
      return `round ${round.id}'s review owner may still run before agent registration`;
    }
    const running: string[] = [];
    for (const agent of agents) {
      if (await this.opts.reconcileReviewAgent?.(agent.id, marker) !== true) running.push(agent.id);
    }
    return running.length === 0 ? null : `round ${round.id} review session(s) ${running.join(', ')} not proven ceased`;
  }

  /** True when a MATERIAL amendment was accepted after `seq`: anything
   * requested before it concerned a candidate that is now obsolete. */
  private materialAmendmentSince(jobId: string, seq: number): boolean {
    return this.opts.ledger.listJobEventsByKinds(jobId, ['job.amendment-accepted']).some((event) =>
      event.seq > seq && typeof event.payload === 'object' && event.payload !== null &&
      (event.payload as { effect?: unknown }).effect === 'material');
  }

  /** Owner rule 3: a queued review request made before an approved
   * material change asked for a candidate that is now obsolete — withdraw
   * it (durably, so a restart never replays it). The next review of the
   * corrected candidate is requested through the ordinary rows. */
  private withdrawQueuedHandoff(jobId: string, reason: string): boolean {
    const pending = this.handoffs.get(jobId);
    if (pending === undefined) return false;
    this.handoffs.delete(jobId);
    this.opts.ledger.appendCustomEvent({
      kind: 'job.review-handoff-withdrawn',
      jobId,
      payload: { requestSeq: pending.seq, reason: reason.slice(0, 500) },
    });
    pending.resolve();
    return true;
  }

  /** Writer admission (owner rules 3 and 5), checked synchronously in the
   * SAME tick the writer's durable intent is written: a live review whose
   * candidate is still current refuses the writer (the branch stays frozen
   * until the verdict); a live review made obsolete by a pending material
   * correction is superseded by the writer's gate before any prompt. */
  assertWriterAdmissible(jobId: string): void {
    const active = this.activeReview(jobId);
    if (active === null) return;
    const job = this.opts.ledger.getJob(jobId);
    if (job !== null && pendingWorkRevision(this.opts.ledger, job) !== null) return;
    throw new ReviewInProgressError(jobId, active.roundIds);
  }

  /** Writer gate (owner rule 3): before a writer prompts the lane's minion,
   * every review that owns the lane is superseded and PROVEN stopped. An
   * unconfirmed stop throws — the writer must not start alongside it. */
  async clearLaneForWriter(input: { readonly jobId: string; readonly writer: string }): Promise<ReviewSupersession> {
    const outcome = await this.supersedeReviews({
      jobId: input.jobId,
      reason: `writer ${input.writer} owns the lane — the reviewed candidate is obsolete`,
      by: input.writer,
    });
    if (!outcome.confirmed) throw new ReviewSupersessionUnconfirmedError(input.jobId, outcome.detail ?? 'stop not proven');
    return outcome;
  }

  /** Supersede every review that owns the job's lane (owner rule 3):
   * record the supersession (with the settled specialist checkpoints — the
   * partial findings stay on disk), withdraw a queued round or cancel a
   * running one with its specialists, drop an in-memory admission retry,
   * and confirm within a bound that everything stopped. Unconfirmed → one
   * action-required escalation; the caller must not start a writer. */
  async supersedeReviews(input: { readonly jobId: string; readonly reason: string; readonly by: string }): Promise<ReviewSupersession> {
    const inFlight = this.supersessions.get(input.jobId);
    if (inFlight !== undefined) {
      const joined = await inFlight;
      // A pass that finished cleanly may be followed by a fresh review only
      // through the fences; re-run when anything still owns the lane.
      if (!joined.confirmed || this.activeReview(input.jobId) === null) return joined;
    }
    const pass = this.runSupersession(input);
    this.supersessions.set(input.jobId, pass);
    try {
      return await pass;
    } finally {
      if (this.supersessions.get(input.jobId) === pass) this.supersessions.delete(input.jobId);
    }
  }

  private async runSupersession(input: { readonly jobId: string; readonly reason: string; readonly by: string }): Promise<ReviewSupersession> {
    const deadline = Date.now() + (this.opts.supersessionDeadlineMs ?? REVIEW_SUPERSESSION_DEADLINE_MS);
    const retry = this.admissionRetries.get(input.jobId);
    if (retry !== undefined) this.dropAdmissionRetry(retry, { outcome: 'superseded', reason: input.reason.slice(0, 300) });
    const jobRow = this.opts.ledger.getJob(input.jobId);
    if (jobRow !== null && pendingWorkRevision(this.opts.ledger, jobRow) !== null) {
      this.withdrawQueuedHandoff(input.jobId, input.reason);
    }
    const roundIds = new Set<string>();
    let operations = 0;
    // Every tracked operation this pass saw — including one an earlier pass
    // already aborted that has not settled: it still must be proven gone.
    let operationsSeen = 0;
    const sessionRoundIds = new Set<string>();
    // A fallback gate owns no round: its stop is proven on the job, and an
    // earlier unproven fallback stop is re-proven by this pass.
    let fallbackInvolved = this.fallbackSupersessionUnproven(input.jobId);
    // A setup that passed its last fence before the writer's intent landed
    // becomes a round + run synchronously: re-collect until nothing new
    // appears (bounded — each pass only aborts what exists).
    for (let pass = 0; pass < 4; pass += 1) {
      const active = this.activeReview(input.jobId);
      if (active === null) break;
      for (const roundId of active.roundIds) {
        if (roundIds.has(roundId)) continue;
        roundIds.add(roundId);
        this.supersededRounds.add(roundId);
        // One durable receipt per round: a re-proof of an earlier
        // unconfirmed stop (or a second caller) does not re-supersede it.
        if (this.opts.ledger.latestRoundEvent(roundId, 'round.superseded') === null) {
          this.recordRoundSupersession(input, roundId);
        }
      }
      const ops = [...(this.reviewOperations.get(input.jobId) ?? [])];
      operationsSeen = Math.max(operationsSeen, ops.length);
      // A run whose round is already terminal (finishing its cleanup) still
      // owns sessions: prove them too, without re-superseding the round.
      for (const op of ops) if (op.roundId !== null) sessionRoundIds.add(op.roundId);
      if (ops.length === 0 && active.roundIds.every((id) => roundIds.has(id)) && pass > 0) break;
      for (const op of ops) {
        if (!op.controller.signal.aborted) {
          if (op.kind === 'fallback') {
            this.supersededFallbackGates.add(input.jobId);
            fallbackInvolved = true;
            // Durable debt FIRST (as for rounds): a crash after the abort
            // can never lose the fact that this stop is owed a proof.
            this.opts.ledger.appendCustomEvent({
              kind: 'job.review-superseded', jobId: input.jobId,
              payload: { route: 'bmad-review-fallback', reason: input.reason.slice(0, 500), by: input.by },
            });
          }
          op.controller.abort(new ReviewSupersededError(input.jobId, input.reason));
          operations += 1;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(ops.map((op) => op.settled)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    }
    if (roundIds.size === 0 && operationsSeen === 0 && !fallbackInvolved) {
      return { jobId: input.jobId, roundIds: [], operations: 0, confirmed: true, detail: null };
    }
    // Debt already reported action-required (an earlier unconfirmed stop
    // still unproven): a re-proof that fails again is an FYI, not a second
    // alert for the same stuck review.
    // The job-level receipt carries a stop that owns no round (a setup
    // before its round, a fallback gate).
    const jobLevel = roundIds.size === 0 || fallbackInvolved;
    const jobAlreadyReported = (this.opts.ledger.latestJobEvent(input.jobId, 'job.review-supersession-unconfirmed')?.seq ?? 0) >
      (this.opts.ledger.latestJobEvent(input.jobId, 'job.review-supersession-confirmed')?.seq ?? 0);
    const alreadyReported = [...roundIds].every((id) =>
      (this.opts.ledger.latestRoundEvent(id, 'round.supersession-unconfirmed')?.seq ?? 0) >
        (this.opts.ledger.latestRoundEvent(id, 'round.supersession-confirmed')?.seq ?? 0)) &&
      (!jobLevel || jobAlreadyReported);
    // Confirmation: no tracked operation left, every superseded round is
    // terminal, and no review session of those rounds still holds a live
    // runtime handle. Anything less is unproven — never "probably stopped".
    const problems: string[] = [];
    const leftover = this.reviewOperations.get(input.jobId)?.size ?? 0;
    if (leftover > 0) problems.push(`${leftover} review operation(s) did not settle within the bound`);
    for (const roundId of roundIds) {
      const problem = await this.roundCessationProblem(roundId);
      if (problem !== null) problems.push(problem);
    }
    // Round sessions, plus the job's fallback reviewer sessions when a
    // fallback gate was superseded (they register without a round id).
    const sessions = this.opts.ledger.listAgents()
      .filter((agent) => agent.role === 'perkins' && (
        (agent.roundId !== null && (roundIds.has(agent.roundId) || sessionRoundIds.has(agent.roundId))) ||
        (fallbackInvolved && agent.roundId === null && agent.jobId === input.jobId && agent.label === 'fallback-review')));
    const live = this.opts.liveReviewSessions !== undefined
      ? this.opts.liveReviewSessions(sessions.map((agent) => agent.id))
      : sessions.filter((agent) => agent.state !== 'disposed' && agent.state !== 'error').map((agent) => agent.id);
    if (live.length > 0) problems.push(`review session(s) ${live.join(', ')} still alive`);
    const confirmed = problems.length === 0;
    const detail = confirmed ? null : problems.join('; ');
    for (const roundId of roundIds) {
      this.opts.ledger.appendCustomEvent({
        kind: confirmed ? 'round.supersession-confirmed' : 'round.supersession-unconfirmed',
        jobId: input.jobId,
        roundId,
        payload: { by: input.by, ...(detail !== null ? { detail } : {}) },
      });
    }
    if (roundIds.size === 0 || fallbackInvolved) {
      this.opts.ledger.appendCustomEvent({
        kind: confirmed ? 'job.review-supersession-confirmed' : 'job.review-supersession-unconfirmed',
        jobId: input.jobId,
        payload: { by: input.by, operations, ...(detail !== null ? { detail } : {}) },
      });
    }
    if (confirmed) {
      this.opts.inform?.(
        `Review of job ${input.jobId} superseded`,
        `${input.reason}. Stopped: ${roundIds.size > 0 ? [...roundIds].join(', ') : `${operations} review operation(s)`}. ` +
          'Partial findings stay in the round artifacts; the next candidate gets a fresh review.',
        { jobId: input.jobId },
      );
    } else if (alreadyReported) {
      this.opts.inform?.(
        `Review of job ${input.jobId} is still not proven stopped — writer refused again`,
        `${input.reason}. ${detail}. Already escalated; the writer stays refused until the stop is proven.`,
        { jobId: input.jobId },
      );
    } else {
      this.opts.escalate?.(
        `Review of job ${input.jobId} could not be confirmed stopped — its writer is blocked`,
        `${input.reason}. ${detail}. The writer was refused (never started alongside the review). ` +
          'Reconcile the review (or restart the service, which terminalizes live rounds), then resend the request.',
        { jobId: input.jobId, ...(roundIds.size === 1 ? { roundId: [...roundIds][0]! } : {}) },
      );
    }
    return { jobId: input.jobId, roundIds: [...roundIds], operations, confirmed, detail };
  }

  /** The durable supersession receipt, written BEFORE any abort: the
   * settled specialist checkpoints (partial findings) and where they live. */
  private recordRoundSupersession(input: { readonly jobId: string; readonly reason: string; readonly by: string }, roundId: string): void {
    const round = this.opts.ledger.getRound(roundId);
    const settled = this.opts.ledger.listRoundSpecialistSettlements(roundId).map((event) => {
      const payload = (event.payload ?? {}) as { lens?: unknown; attempt?: unknown; sha256?: unknown };
      return { lens: payload.lens ?? null, attempt: payload.attempt ?? null, sha256: payload.sha256 ?? null };
    });
    let artifactDirectory: string | null = null;
    try {
      if (this.opts.reviewArtifactRoot !== undefined) artifactDirectory = reviewArtifactDirectory(this.opts.reviewArtifactRoot, roundId);
    } catch {
      artifactDirectory = null;
    }
    this.opts.ledger.appendCustomEvent({
      kind: 'round.superseded',
      jobId: input.jobId,
      roundId,
      payload: {
        reason: input.reason.slice(0, 500),
        by: input.by,
        status: round?.status ?? null,
        target_sha: round?.targetRef ?? null,
        settled_specialists: settled,
        artifact_directory: artifactDirectory,
      },
    });
  }

  private track<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
    const tracked = operation.finally(() => {
      this.activeOperations.delete(tracked);
      this.activeControllers.delete(controller);
    });
    this.activeOperations.add(tracked);
    this.activeControllers.add(controller);
    return tracked;
  }

  private artifactRoot(): string {
    if (this.opts.reviewArtifactRoot === undefined) {
      throw new Error('Perkins review requires a stable reviewArtifactRoot');
    }
    return this.opts.reviewArtifactRoot;
  }

  private writeInterruptedArtifacts(roundId: string, reason: string, note: string, preAbortFacts?: string): {
    readonly directory: string | null;
    readonly reportFile: string | null;
  } {
    if (this.opts.reviewArtifactRoot === undefined) return { directory: null, reportFile: null };
    try {
      const directory = reviewArtifactDirectory(this.opts.reviewArtifactRoot, roundId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const recovery = join(directory, 'restart-recovery.json');
      if (!existsSync(recovery)) {
        writeFileSync(recovery, `${JSON.stringify({ schemaVersion: 1, canonicalVerdict: 'INCOMPLETE', reason }, null, 2)}\n`, {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        });
      }
      // P6/Q4 (gh-169): the durable restart report carries the host's
      // execution facts — started attempts and never-started lenses from
      // the SAME classification abortRound used. The caller passes the
      // PRE-ABORT facts (a live chip is `live` only before abortRound
      // flips it); without them the round's current record degrades to
      // journal-only truth — never invented counts, and a missing round
      // record degrades to the historical generic note. Q4: the incident
      // heading follows the LEDGER truth — a "parent incident" is claimed
      // only when the round.parent-incident event exists; pre-spawn
      // interruptions say so explicitly instead.
      const round = this.opts.ledger.getRound(roundId);
      const facts = preAbortFacts ??
        (round === null ? null : this.interruptedExecutionFacts(round, round.lenses.map((chip) => chip.lens as PerkinsLens)));
      const incidentHeading = this.opts.ledger.latestRoundEvent(roundId, 'round.parent-incident') !== null
        ? '**Parent incident** — the service died beneath this round; this is one parent incident, not a per-lens specialist failure.'
        : '**Setup interruption** — the round ended before any review owner spawned; zero lead turns and zero specialist children existed.';
      const contents = [
        '# Perkins Code Review',
        '',
        '**Verdict: INCOMPLETE**',
        '',
        `${note}. Rerun a complete review against a newly frozen target.`,
        '',
        incidentHeading,
        '',
        ...(facts !== null ? [facts, ''] : []),
      ].join('\n');
      const recoveryReport = join(directory, 'perkins-report.recovery-incomplete.md');
      if (!existsSync(recoveryReport)) {
        writeFileSync(recoveryReport, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
      const report = join(directory, 'perkins-report.md');
      if (!existsSync(report)) {
        writeFileSync(report, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
      return { directory, reportFile: recoveryReport };
    } catch (error) {
      this.log('error', 'could not preserve interrupted-review artifacts', {
        round: roundId,
        error: String(error),
      });
      return { directory: null, reportFile: null };
    }
  }

  /** Binding check for a parsed `round.posted` event against the
   * AUTHORITATIVE frozen facts (R2/R21): the round's frozen target, the
   * job's actual pull request, a known enacted provider event with its
   * commit-binding discipline, and the round's OWN canonical publication
   * path — never a self-declared foreign path or an alias. Returns null
   * when correctly bound, or a human-readable problem otherwise. */
  private postedEventBindingProblem(
    event: PostedEventPayload,
    round: RoundRecord,
  ): string | null {
    if (event.receipt.headSha !== round.targetRef) return 'receipt head does not match the round\'s frozen target';
    if (event.targetSha !== round.targetRef) return 'posted target does not match the round\'s frozen target';
    const job = this.opts.ledger.getJob(round.jobId);
    if (job === null || job.prUrl === null || event.url !== job.prUrl) {
      return 'posted event URL does not match the job\'s recorded pull request';
    }
    // The persisted host is a SEPARATE field and must equal the validated
    // PR URL's host: recovery resolves the authenticated account through
    // this host, so an unbound host could point a credential probe at an
    // attacker-controlled provider.
    let prHost: string;
    try {
      prHost = new URL(event.url).host;
    } catch {
      return 'posted event URL is unparsable';
    }
    if (event.host.toLowerCase() !== prHost.toLowerCase()) {
      return 'posted event host does not match its pull request URL';
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(event.receipt.reviewId)) {
      return 'receipt review id is malformed';
    }
    if (event.receipt.actor.split('').some((character) => character.charCodeAt(0) < 32)) return 'receipt actor is malformed';
    if (!/^[0-9a-f]{64}$/u.test(event.receipt.bodySha256)) return 'receipt body digest is malformed';
    // The enacted provider event is bound to the job's actual PR form: a
    // GitHub pull-request URL must carry a COMMENTED review commit-bound to
    // the frozen target; a GitLab merge-request URL must carry a note with
    // NO server-side commit binding. Any other pairing — a GitLab note on a
    // GitHub PR, an unknown event — is not a promotable publication.
    const providerKind = publicationProviderKindFor(job.prUrl);
    if (providerKind === 'github') {
      if (event.receipt.event !== 'COMMENTED') return `receipt event "${event.receipt.event}" is not the GitHub COMMENT review this pull request requires`;
      if (event.receipt.commitId !== round.targetRef) return 'COMMENTED receipt is not commit-bound to the frozen target';
    } else if (providerKind === 'gitlab') {
      if (event.receipt.event !== 'note') return `receipt event "${event.receipt.event}" is not the GitLab merge-request note this merge request requires`;
      if (event.receipt.commitId !== null) return 'note receipt must not claim a commit binding GitLab does not record';
    } else {
      // Unknown provider form: fall back to the per-event discipline so an
      // odd-but-consistent record is not rejected for its host alone.
      if (event.receipt.event === 'COMMENTED') {
        if (event.receipt.commitId !== round.targetRef) return 'COMMENTED receipt is not commit-bound to the frozen target';
      } else if (event.receipt.event === 'note') {
        if (event.receipt.commitId !== null) return 'note receipt must not claim a commit binding GitLab does not record';
      } else {
        return `receipt event "${event.receipt.event}" is not a known enacted provider event`;
      }
    }
    const canonical = join(reviewArtifactDirectory(this.artifactRoot(), round.id), 'perkins-report.publication.md');
    if (resolve(event.publicationFile) !== resolve(canonical)) {
      return 'publication path is not this round\'s canonical publication artifact';
    }
    return null;
  }

  /** R30 account binding: restart recovery only credits a posted receipt
   * whose actor matches the account the poster can evidence RIGHT NOW, on
   * the same provider credential the live posting path uses. The policy
   * decision (owner-reviewed finding R30): the persisted actor is
   * self-declared and therefore carries no authority after restart; a
   * poster that cannot evidence its account — no resolver, an unreachable
   * provider, or a failed probe — leaves the round unresolved rather than
   * promoting an identity nobody can corroborate. Account comparison is
   * case-insensitive exactly as the live writer paths compare it. */
  private async receiptActorBindingProblem(event: PostedEventPayload): Promise<string | null> {
    const poster = this.opts.poster;
    if (poster === undefined || typeof poster.authenticatedActor !== 'function') {
      return 'the poster cannot evidence the posting account after restart, so the receipt actor stays unverified';
    }
    let authenticated: string;
    try {
      authenticated = await poster.authenticatedActor(event.host);
    } catch (error) {
      return `the posting account could not be evidenced after restart (${String(error).slice(0, 200)}), so the receipt actor stays unverified`;
    }
    if (authenticated.trim() === '') {
      return 'the poster evidenced no authenticated posting account after restart, so the receipt actor stays unverified';
    }
    if (event.receipt.actor.toLowerCase() !== authenticated.toLowerCase()) {
      return `receipt actor "${event.receipt.actor}" is not the account the poster evidences as authenticated ("${authenticated}")`;
    }
    return null;
  }

  /** Attempt to promote a round whose `round.posted` event is fully bound,
   * actor-evidenced, and backed by the round's own canonical publication
   * artifact. Returns 'promoted' after recording the verdict (sweeping
   * `laneId` when a lane exists), 'unbound' when a posted verdict exists
   * but cannot be credited (an escalation is raised), or 'no-event' when
   * there is nothing to recover. The missing-lane branch calls this with
   * `laneId === null`: a lost worktree registration must not discard a
   * genuinely delivered publication.
   *
   * A delivered verdict is only recoverable when the posted event parses
   * through the SAME shared contract the writer emits and the receipt is
   * correctly bound to this round, this job's actual pull request, a known
   * enacted provider event, and the round's OWN canonical publication
   * artifact (R1/R2/R21). A bare, malformed or unbound local event —
   * forged, corrupted, or written by an older build — is NOT promoted; it
   * terminalizes honestly as an interrupted round instead. Completed
   * historical rounds are never rewritten, and one malformed round never
   * aborts the recovery of the rest. */
  private async promotePostedRound(round: RoundRecord, laneId: string | null): Promise<'promoted' | 'unbound' | 'no-event'> {
    const posted = this.opts.ledger.latestRoundEvent(round.id, 'round.posted');
    const payload = posted?.payload;
    const postedVerdict = typeof payload === 'object' && payload !== null
      ? (payload as { verdict?: unknown }).verdict
      : undefined;
    if (postedVerdict !== 'approved' && postedVerdict !== 'changes-requested') return 'no-event';
    const event = parsePostedEventPayload(payload);
    const bindingProblem = event === null
      ? 'the round.posted payload is malformed (receipt, publication or identity fields missing or mistyped)'
      : this.postedEventBindingProblem(event, round);
    // R30: the persisted actor is self-declared and is only credited when
    // the poster can evidence the SAME account right now. The probe is
    // skipped when an earlier binding already failed.
    const actorProblem = event !== null && bindingProblem === null
      ? await this.receiptActorBindingProblem(event)
      : null;
    // The preserved publication artifact is REQUIRED evidence, not an
    // optional extra: promotion verifies the round's OWN canonical
    // publication file still exists as a regular non-symlink file and
    // carries exactly the digested bytes (T3/R21).
    let bound = false;
    if (event !== null && bindingProblem === null && actorProblem === null) {
      bound = true;
      try {
        const canonical = join(reviewArtifactDirectory(this.artifactRoot(), round.id), 'perkins-report.publication.md');
        const info = lstatSync(canonical);
        if (!info.isFile() || info.isSymbolicLink()) {
          bound = false;
        } else {
          const digest = createHash('sha256').update(readFileSync(canonical, 'utf8')).digest('hex');
          bound = digest === event.publicationSha256 && digest === event.receipt.bodySha256;
        }
      } catch {
        bound = false;
      }
    }
    if (bound && event !== null) {
      // Restore a partial-coverage round's final-pass debt BEFORE approval is
      // committed: a crash between the posted event and the pre-commit marker
      // must not promote a partial approval into owner-readiness. The state is
      // the writer-persisted posted `review` block when present, else the
      // preserved consolidated record, authenticated to the posted head.
      // Absent/damaged evidence is NEVER treated as "no debt": the promotion
      // is refused and the round stays interrupted for inspection.
      if (postedVerdict === 'approved') {
        const postedReview = event.review ?? this.readPostedReviewState(round.id, event.receipt.headSha);
        if (postedReview === null) {
          this.escalate(
            `Review round ${round.id} cannot be promoted: its review coverage state is missing or damaged`,
            'restart recovery refuses to promote an approval whose authenticated scope/coverage/debt cannot be established from the posted receipt or the preserved consolidated record; the round stays interrupted for inspection',
            { jobId: round.jobId, roundId: round.id },
          );
          return 'unbound';
        }
        // Every partial scope owes the final whole-change pass: a delta
        // approval always owed it, and an integration approval owed it unless
        // the retained coverage was whole-complete. A whole-scope approval
        // owes nothing unless its own record explicitly says otherwise.
        const owesFinalPass = postedReview.finalPassRequired ||
          (postedReview.reviewScope === 'integration' && !postedReview.coverageComplete) ||
          postedReview.reviewScope === 'delta';
        if (owesFinalPass && this.opts.ledger.latestRoundEvent(round.id, 'round.final-pass-required') === null) {
          try {
            this.opts.ledger.appendCustomEvent({
              kind: 'round.final-pass-required', jobId: round.jobId, roundId: round.id,
              payload: { targetSha: event.receipt.headSha, reviewScope: postedReview.reviewScope },
            });
          } catch (markerError) {
            throw new Error(`restart recovery could not restore the required final whole-change pass before promoting round ${round.id}: ${String(markerError)}`);
          }
        }
      }
      // R6-1: reconstruct the DEFERRED lens outcomes from durable evidence
      // before promotion — the crash may have landed between the real post
      // and finalization, leaving never-started lenses pending. The
      // reconstruction commits ATOMICALLY with the verdict: a posted,
      // promoted round can never keep pending unused chips.
      const started = this.startedSpecialistLenses(round);
      const deferred = round.lenses
        .filter((chip) => chip.state === 'pending' || chip.state === 'live')
        .map((chip) => started.has(chip.lens)
          ? {
              lens: chip.lens,
              state: 'error' as const,
              note: 'attempt started; interrupted by the crash before settlement — recovered by restart promotion',
            }
          : { lens: chip.lens, state: 'done' as const, note: 'not used — lead-owned whole-PR review' });
      this.opts.ledger.finalizeRoundVerdictWithLensOutcomes(round.id, postedVerdict, deferred);
      this.opts.ledger.appendCustomEvent({
        kind: 'round.post-recovered',
        jobId: round.jobId,
        roundId: round.id,
        payload: {
          verdict: postedVerdict,
          postedEventSeq: posted?.seq ?? null,
          receipt: {
            reviewId: event.receipt.reviewId, actor: event.receipt.actor, event: event.receipt.event,
            headSha: event.receipt.headSha, bodySha256: event.receipt.bodySha256,
          },
        },
      });
      if (laneId !== null) await this.sweepReviewWorktree(laneId);
      return 'promoted';
    }
    this.escalate(
      `Review round ${round.id} carries a posted verdict without a provider-bound receipt`,
      `restart recovery cannot verify the delivery of an unbound round.posted event (${bindingProblem ?? actorProblem ?? 'the preserved publication artifact did not match the posted digest'}); the round terminalizes as interrupted rather than promoting an unverifiable approval`,
      { jobId: round.jobId, roundId: round.id },
    );
    return 'unbound';
  }

  /** Mark crash-interrupted proof INCOMPLETE and release every owned lane. */
  async recoverInterruptedRounds(): Promise<number> {
    let recovered = 0;
    const lanes = this.opts.worktrees.listWorktrees();
    const registeredRoundIds = new Set(
      lanes
        .filter((lane) => lane.kind === 'review' && lane.status !== 'swept' && lane.roundId !== null)
        .map((lane) => lane.roundId as string),
    );
    for (const lane of lanes) {
      if (lane.kind !== 'review' || lane.status === 'swept' || lane.roundId === null) continue;
      try {
      const round = this.opts.ledger.getRound(lane.roundId);
      if (round === null) {
        await this.sweepReviewWorktree(lane.id);
        recovered += 1;
        continue;
      }
      if (round.status !== 'pending' && round.status !== 'live') {
        await this.sweepReviewWorktree(lane.id);
        recovered += 1;
        continue;
      }
      const promotion = await this.promotePostedRound(round, lane.id);
      if (promotion === 'promoted') {
        recovered += 1;
        continue;
      }
      const note = 'review interrupted by service restart; selected lens/verification proof is incomplete';
      // Pre-abort classification: a live chip is a started child even when
      // its journal write was lost to the crash (P5).
      const preAbortFacts = this.interruptedExecutionFacts(round, round.lenses.map((chip) => chip.lens as PerkinsLens));
      this.abortRound(round, note);
      // A round a restart caught mid-supersession (owner rule 3) keeps its
      // true classification: superseded, never a clean service restart.
      const restartReason = this.opts.ledger.latestRoundEvent(round.id, 'round.superseded') !== null ? 'superseded' : 'service_restart';
      const artifacts = this.writeInterruptedArtifacts(round.id, restartReason, note, preAbortFacts);
      this.opts.ledger.appendCustomEvent({
        kind: 'round.perkins-incomplete',
        jobId: round.jobId,
        roundId: round.id,
        payload: { reason: restartReason, artifactDirectory: artifacts.directory, reportFile: artifacts.reportFile },
      });
      this.escalate(`Review round ${round.id} is INCOMPLETE after service restart`, note, { jobId: round.jobId, roundId: round.id });
      await this.sweepReviewWorktree(lane.id);
      recovered += 1;
      } catch (error) {
        // One unexpectedly failing row must never abort startup recovery of
        // the remaining rounds (R1): the failure is escalated loudly and
        // the round is left untouched for inspection and the next restart.
        this.log('error', 'startup recovery failed for one review round', {
          lane: lane.id,
          round: lane.roundId,
          error: String(error),
        });
        this.escalate(
          `Review round ${String(lane.roundId)} could not be processed during startup recovery`,
          `${String(error)} — the round is left as recorded for inspection; other rounds continue to recover`,
          {
            ...(lane.jobId !== null ? { jobId: lane.jobId } : {}),
            ...(lane.roundId !== null ? { roundId: lane.roundId } : {}),
          },
        );
      }
    }

    for (const job of this.opts.ledger.listJobs()) {
      for (const round of this.opts.ledger.listRounds(job.id)) {
        if ((round.status !== 'pending' && round.status !== 'live') || registeredRoundIds.has(round.id)) continue;
        // A round whose review lane registration was lost can still carry a
        // fully bound, actor-evidenced round.posted event: recover the
        // publication first, and only terminalize when there is nothing
        // promotable.
        const promotion = await this.promotePostedRound(round, null);
        if (promotion === 'promoted') {
          recovered += 1;
          continue;
        }
        const note = 'review interrupted before its detached worktree was durably registered; required proof is incomplete';
        const preAbortFacts = this.interruptedExecutionFacts(round, round.lenses.map((chip) => chip.lens as PerkinsLens));
        this.abortRound(round, note);
        const restartReason = this.opts.ledger.latestRoundEvent(round.id, 'round.superseded') !== null
          ? 'superseded' : 'service_restart_missing_review_lane';
        const artifacts = this.writeInterruptedArtifacts(round.id, restartReason, note, preAbortFacts);
        this.opts.ledger.appendCustomEvent({
          kind: 'round.perkins-incomplete',
          jobId: round.jobId,
          roundId: round.id,
          payload: {
            reason: restartReason,
            artifactDirectory: artifacts.directory,
            reportFile: artifacts.reportFile,
          },
        });
        this.escalate(`Review round ${round.id} is INCOMPLETE after service restart`, note, { jobId: round.jobId, roundId: round.id });
        recovered += 1;
      }
    }
    return recovered;
  }

  /** A write-once pre-spawn event, not a ledger lifecycle state, binds
   * the runtime host whose cessation must be proven before replacement. */
  private reviewOwnerMarker(round: RoundRecord): ReviewOwnerMarker | null {
    const event = this.opts.ledger.uniqueRoundReviewOwnerMarker(round.id);
    if (event?.jobId !== round.jobId || event.roundId !== round.id ||
      typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) return null;
    const payload = event.payload as Record<string, unknown>;
    if (payload['roundId'] !== round.id || payload['targetSha'] !== round.targetRef ||
      (payload['runtimeId'] !== 'pi' && payload['runtimeId'] !== 'claude-code') ||
      !Number.isSafeInteger(payload['pid']) || (payload['pid'] as number) <= 0 ||
      !validReviewOwnerGeneration(payload['generation'])) return null;
    return {
      roundId: round.id, runtimeId: payload['runtimeId'], pid: payload['pid'] as number,
      generation: payload['generation'],
    };
  }

  /** Lenses with a started execution this round — ONE classification
   * shared by every parent-incident surface (P5): a durable
   * `round.specialist-started` journal entry (the budget authority), a
   * live chip (a registered child), OR a lens an already-persisted
   * parent-incident event classified as started (Q8: a partial abort that
   * flipped chips before a later recovery must not relabel that child
   * never-started). */
  private startedSpecialistLenses(round: RoundRecord): ReadonlySet<string> {
    const started = new Set<string>();
    for (const event of this.opts.ledger.listRoundSpecialistStarts(round.id)) {
      const lens = typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as { readonly lens?: unknown }).lens : null;
      if (typeof lens === 'string' && lens !== '') started.add(lens);
    }
    for (const chip of round.lenses) {
      if (chip.state === 'live') started.add(chip.lens);
    }
    const incident = this.opts.ledger.latestRoundEvent(round.id, 'round.parent-incident');
    const recorded = typeof incident?.payload === 'object' && incident.payload !== null
      ? (incident.payload as { readonly startedLenses?: unknown }).startedLenses : null;
    if (Array.isArray(recorded)) {
      for (const lens of recorded) if (typeof lens === 'string' && lens !== '') started.add(lens);
    }
    return started;
  }

  /** Terminalize a round whose PARENT (lead/transport/service) failed.
   * Counter truth (gh-169): lenses with a started execution record an
   * honest execution error naming the parent cause; lenses that never
   * started stay `pending` — a not-started lens is not a failed
   * execution. Exactly ONE `round.parent-incident` event carries the
   * round-level facts (idempotent across a partial abort failure and
   * later recovery: an existing incident is never re-minted, P8). */
  private abortRound(round: RoundRecord, note: string): void {
    // Q8: the incident event is persisted FIRST (from the PRE-abort
    // classification), before any chip flips — a partial failure leaves
    // either no event plus untouched chips (a clean retry recomputes the
    // same set) or a persisted event whose startedLenses outlive chip
    // changes. The append is idempotent, so a retry never mints a second
    // incident.
    const started = this.startedSpecialistLenses(round);
    if (this.opts.ledger.latestRoundEvent(round.id, 'round.parent-incident') === null) {
      this.opts.ledger.appendCustomEvent({
        kind: 'round.parent-incident',
        jobId: round.jobId,
        roundId: round.id,
        payload: {
          note: note.slice(0, 500),
          startedAttempts: this.opts.ledger.listRoundSpecialistStarts(round.id).length,
          startedLenses: round.lenses.filter((chip) => started.has(chip.lens)).map((chip) => chip.lens),
          notStartedLenses: round.lenses.filter((chip) => !started.has(chip.lens)).map((chip) => chip.lens),
        },
      });
    }
    const settled = this.settledSpecialistLenses(round.id);
    for (const chip of round.lenses) {
      if (chip.state === 'live' || (chip.state === 'pending' && started.has(chip.lens))) {
        this.opts.ledger.setLensOutcome(round.id, chip.lens, 'error', (settled.has(chip.lens)
          ? `attempt settled (checkpoint recorded); the round ended before its result was collected — recoverable by the next round: ${note}`
          : `attempt started; interrupted by parent abort before settlement: ${note}`).slice(0, 500));
      }
      // A never-started lens keeps `pending`: the aborted round itself is
      // the parent incident; no specialist execution failed.
    }
    this.opts.ledger.setRoundStatus(round.id, 'aborted');
  }

  async runRound(input: {
    jobId: string;
    targetRef?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
    /** Human escape hatch: arm even while the target branch is busy; the
     * round is tagged in the manifest and the event log. */
    force?: boolean;
    /** Prior indexes the implementing minion claimed fixed (fix-directive
     * receipt); Stage-5 carry-forward always re-verifies claimed priors. */
    claimedFixedPriors?: readonly number[];
  }): Promise<WaveOutcome | FallbackGateOutcome> {
    const outcome = await this.requestReview(input);
    if (outcome.route === 'perkins') return outcome.run;
    if (outcome.route === 'queued') {
      throw new Error('direct round invocation cannot await a deferred worker handoff');
    }
    await outcome.run;
    return outcome;
  }

  /** Review-path selection (user amendment 2026-09-20): the fail-closed
   * four-leg pre-flight runs at request time. All legs pass -> Perkins
   * (the gate). Any leg failing -> the bmad-review fallback gate. */
  async requestReview(input: {
    jobId: string;
    targetRef?: string;
    /** Internal: a clean-abort re-arm's request-time delivered head; the
     * freeze boundary refuses when a newer delivery superseded it. */
    boundDeliveredSha?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
    force?: boolean;
    /** Authorized private evidence attachments (service upload identities). */
    evidence?: readonly ReviewEvidenceRequest[];
    /** Prior indexes the implementing minion claimed fixed (fix-directive
     * receipt); Stage-5 carry-forward always re-verifies claimed priors. */
    claimedFixedPriors?: readonly number[];
    /** Worker tool handoff: acknowledge without waiting for its own turn. */
    handoff?: boolean;
    /** Internal replay marker; never accepted from the public HTTP endpoint. */
    fromHandoff?: boolean;
    /** Internal: the automatic admission retry this request carries out;
     * never accepted from the public HTTP endpoint. */
    admissionRetry?: AdmissionRetry;
  }): Promise<ReviewRequestOutcome> {
    if (this.shuttingDown) throw new Error('Perkins review service is shutting down');
    // Branch-idle still gates the freeze. A minion's own busy turn may
    // acknowledge an intent now; it is armed only after job.delivered.
    try {
      this.enforceBranchIdleForRequest(input);
    } catch (error) {
      if (!(error instanceof BranchBusyError) || input.handoff !== true || input.force === true ||
        error.blockers.length === 0 || error.blockers.some((blocker) => blocker.jobId !== input.jobId) ||
        // Owner rule 2: a request for a candidate an approved material
        // change already made obsolete is refused, never queued.
        error.blockers.some((blocker) => blocker.revision !== undefined)) throw error;
      if (this.opts.bus === undefined) throw new Error('worker review handoff requires a ledger event bus');
      const existing = this.handoffs.get(input.jobId);
      if (existing !== undefined) {
        // First-wins, but never silent: a differing duplicate records its
        // exact folded scope as a truthful conflict outcome.
        const differs =
          (input.lenses !== undefined && JSON.stringify(input.lenses) !== JSON.stringify((existing.input as { lenses?: readonly string[] }).lenses ?? undefined)) ||
          (input.targetRef !== undefined && input.targetRef !== (existing.input as { targetRef?: string }).targetRef) ||
          (input.noSpec !== undefined && input.noSpec !== (existing.input as { noSpec?: boolean }).noSpec) ||
          (input.claimedFixedPriors !== undefined && JSON.stringify(input.claimedFixedPriors) !==
            JSON.stringify((existing.input as { claimedFixedPriors?: readonly number[] }).claimedFixedPriors ?? undefined)) ||
          (input.evidence !== undefined && JSON.stringify(input.evidence) !== JSON.stringify((existing.input as { evidence?: readonly ReviewEvidenceRequest[] }).evidence ?? undefined));
        if (differs) {
          this.opts.ledger.appendCustomEvent({
            kind: 'job.review-handoff-conflict', jobId: input.jobId,
            payload: { requestSeq: existing.seq, folded: {
              ...(input.lenses !== undefined ? { lenses: input.lenses } : {}),
              ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
              ...(input.noSpec !== undefined ? { noSpec: input.noSpec } : {}),
              ...(input.claimedFixedPriors !== undefined ? { claimedFixedPriors: input.claimedFixedPriors } : {}),
              ...(input.evidence !== undefined ? { evidence_count: input.evidence.length, evidence_request_sha256: evidenceRequestFingerprint(input.evidence) } : {}),
            } },
          });
        }
        // A genuinely NEW validated review request clears a held intent
        // (never a sweep/ACK/status flip alone); the queue keeps the
        // first-request identity (first-wins) and the fresh request is
        // audited as job.review-handoff-superseded.
        if (existing.held) this.supersedeHeldHandoff(input.jobId, input);
        return { route: 'queued', jobId: input.jobId, requestSeq: existing.seq, run: existing.run };
      }
      const safeInput = { jobId: input.jobId,
        ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
        ...(input.lenses !== undefined ? { lenses: input.lenses } : {}),
        ...(input.noSpec !== undefined ? { noSpec: input.noSpec } : {}),
        ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
        ...(input.claimedFixedPriors !== undefined ? { claimedFixedPriors: input.claimedFixedPriors } : {}),
      };
      const event = this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-queued', jobId: input.jobId, payload: { input: safeInput } });
      const pending = this.trackHandoff(safeInput, event.seq);
      return { route: 'queued', jobId: input.jobId, requestSeq: event.seq, run: pending.run };
    }
    const pendingHandoff = this.handoffs.get(input.jobId);
    if (pendingHandoff !== undefined && input.fromHandoff !== true) {
      // Reconcile on this genuine observation: the lane may have gone idle
      // without a delivery event (aborted/failed turn), in which case the
      // replay below re-runs every current fence (branch-idle, exact-head,
      // freeze, capacity) and arms the review now. Legitimate busy/capacity
      // waits stay pending (the replay re-queues, M1); nothing is skipped.
      this.reconcileQueuedHandoff(input.jobId);
      return { route: 'queued', jobId: input.jobId, requestSeq: pendingHandoff.seq, run: pendingHandoff.run };
    }
    const repoPath = this.resolveReviewRequestRepo(input);
    // Force authorizes only blockers present NOW, before the awaited
    // preflight. A marker admitted during that wait was never audited.
    const lanesAtArm = this.opts.worktrees.listWorktrees();
    const jobLaneAtArm = lanesAtArm.find((lane) => lane.kind === 'job' && lane.jobId === input.jobId && lane.status !== 'swept') ?? null;
    const targetBranch = resolveReviewTargetBranch({
      jobId: input.jobId,
      ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
      lanePath: jobLaneAtArm?.path ?? null,
      laneBranch: jobLaneAtArm?.branch ?? null,
    });
    const branchOwners = lanesAtArm.filter((lane) => lane.kind === 'job' && lane.status !== 'swept' &&
      lane.jobId !== null && normalizeBranch(lane.branch ?? laneBranch(lane.jobId)) === targetBranch)
      .map((lane) => ({
        jobId: lane.jobId!, path: lane.path,
        statusSeq: this.opts.ledger.latestJobEvent(lane.jobId!, 'job.status')?.seq ?? 0,
        deliverySeq: this.opts.ledger.latestJobEvent(lane.jobId!, 'job.delivered')?.seq ?? 0,
        markerIds: this.opts.ledger.listPendingRebriefs({ jobId: lane.jobId! }).map((marker) => marker.id),
      }));
    const fallbackBaseline = {
      targetBranch,
      branchOwners,
      busyJobIds: findBusyLanes({ ledger: this.opts.ledger, lanes: lanesAtArm, targetBranch })
        .map((blocker) => blocker.jobId),
      markerIds: this.opts.ledger.listPendingRebriefs({ jobId: input.jobId }).map((marker) => marker.id),
      deliverySeq: this.opts.ledger.latestJobEvent(input.jobId, 'job.delivered')?.seq ?? 0,
      statusSeq: this.opts.ledger.latestJobEvent(input.jobId, 'job.status')?.seq ?? 0,
      settlementSeq: this.opts.ledger.latestJobEvent(input.jobId, 'silas.rebrief-settled')?.seq ?? 0,
    };
    const preflight = this.opts.reviewPreflight;
    const result: ReviewPreflightResult = preflight !== undefined && repoPath !== null
      ? await preflight({ repoPath })
      : { ok: true, failures: [] };
    // R7-17: a shutdown during the awaited pre-flight starts nothing — no
    // fallback gate, no round.
    if (this.shuttingDown) throw new Error('Perkins review service is shutting down');
    if (!result.ok) {
      // The canonical terminal refusal owns terminal lanes FIRST: terminal
      // jobs are never busy, so a stale pending marker must not mask the
      // refusal as branch_busy, and no branch-idle audit row is written
      // for a job that can never be reviewed again.
      const jobNow = this.opts.ledger.getJob(input.jobId);
      if (jobNow !== null && isJobTerminal(jobNow.status)) {
        throw new Error(`job "${input.jobId}" is ${jobNow.status} — terminal lanes do not go back under review`);
      }
      // The fallback gate has no freeze leg of its own: the awaited
      // pre-flight is an asynchronous admission window, and a re-brief (or
      // lane re-open) admitted while it ran must fence fallback admission
      // too. Re-prove branch idleness through the SAME shared guard the
      // arm intake and the native freeze use — before any fallback reviewer
      // starts. An explicit `force` keeps its audited escape hatch, and a
      // BranchBusyError keeps its 409 refusal / same-job replay re-queue.
      // Non-forced requests retain the shared 409/re-queue behavior.
      // A forced request must FIRST reject newly arrived blockers; logging
      // another override before that proof would misstate what the owner
      // authorized at the original arm.
      if (input.force !== true) this.enforceBranchIdleForRequest(input);
      // The shared guard early-returns without a job lane, so re-prove the
      // CURRENT lane/marker/authorization facts directly at this seam
      // (fail closed on a missing lane instead of reusing the pre-await
      // repoPath), and hand the same re-proof to the gate's own async
      // boundaries: before each round's diff intake, and after the default
      // reviewer's worker-gate wait before it spawns.
      const lanePath = this.assertFallbackAdmissionCurrent(input);
      if (input.fromHandoff === true) {
        const pending = this.handoffs.get(input.jobId);
        this.assertHandoffAuthorized(input.jobId, pending?.seq ?? -1);
      }
      if (repoPath !== lanePath) {
        throw new FallbackSafetyRefusal(`job "${input.jobId}" replaced its checkout during fallback preflight — retry on the current lane`);
      }
      const admission = { lanePath, ...fallbackBaseline };
      this.assertFallbackIterationCurrent(input, admission);
      if (input.force === true) this.enforceBranchIdleForRequest(input);
      // The fallback gate cannot deliver private evidence: refuse the arm
      // rather than run the fallback review without the promised material.
      if (input.evidence !== undefined && input.evidence.length > 0) {
        throw new Error('private review evidence cannot be delivered through the bmad-review fallback route; re-arm without evidence or repair the Perkins pre-flight');
      }
      return this.beginFallbackGate(input, result.failures, lanePath, () => this.assertFallbackIterationCurrent(input, admission));
    }
    // Post-await recheck (handoff replays only): permission is re-proven
    // after preflight/capacity waits, BEFORE freeze/admission effects.
    if (input.fromHandoff === true) {
      const pending = this.handoffs.get(input.jobId);
      this.assertHandoffAuthorized(input.jobId, pending?.seq ?? -1);
    }
    const begun = await this.beginPerkinsRound({ ...input, reviewModel: result.reviewModel,
      reviewThinkingLevel: result.reviewThinkingLevel });
    return { route: 'perkins', round: begun.round, run: begun.run };
  }

  private trackHandoff(input: { jobId: string; targetRef?: string; lenses?: readonly string[]; noSpec?: boolean; force?: boolean; evidence?: readonly ReviewEvidenceRequest[]; claimedFixedPriors?: readonly number[] }, seq: number) {
    let resolve!: () => void;
    const run = new Promise<void>((done) => { resolve = done; });
    const pending = { input, seq, starting: false, held: false, settlementReplayRequested: false, run, resolve };
    this.handoffs.set(input.jobId, pending);
    return pending;
  }

  /** Review-authorizable job statuses at replay time. Branch idleness and
   * a current head are NOT authorization: a job that became blocked/parked/
   * cancelled/owner-held/terminal after the durable request was accepted
   * is HELD for reconciliation attention, never auto-reviewed. */
  private static readonly HANDOFF_AUTHORIZED_STATUSES: ReadonlySet<string> = new Set(['working', 'delivered', 'in-review']);

  /** Fence: throws when the CURRENT job state does not authorize this
   * handoff. Called BEFORE any claim/spawn/freeze effect and re-checked
   * after awaited preflight/capacity, before round admission. */
  private assertHandoffAuthorized(jobId: string, requestSeq: number): void {
    const jobNow = this.opts.ledger.getJob(jobId);
    if (jobNow === null || !WaveRunner.HANDOFF_AUTHORIZED_STATUSES.has(jobNow.status)) {
      throw new HandoffHeldError(jobNow?.status ?? 'missing', requestSeq);
    }
  }

  private async startHandoff(jobId: string, pending: NonNullable<ReturnType<WaveRunner['trackHandoff']>>): Promise<void> {
    if (pending.starting || pending.held || this.shuttingDown || this.handoffs.get(jobId) !== pending) return;
    // Owner rule 3: a request queued before an approved material change
    // asked for an obsolete candidate — even when its withdrawal was lost
    // (a crash between the amendment and the supersession pass).
    if (this.materialAmendmentSince(jobId, pending.seq)) {
      this.withdrawQueuedHandoff(jobId, 'an approved material amendment was accepted after this review request');
      return;
    }
    pending.starting = true;
    let requeued = false;
    let held = false;
    try {
      // Current-permission fence BEFORE any claim/spawn/freeze effect.
      this.assertHandoffAuthorized(jobId, pending.seq);
      // Claim binds this attempt to the request; a crash between claim and
      // the started marker reconciles fail-closed at boot.
      this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-claimed', jobId,
        payload: { requestSeq: pending.seq },
      });
      const outcome = await this.requestReview({ ...pending.input, fromHandoff: true });
      if (this.shuttingDown) return; // claim stands; boot recovery reconciles fail-closed
      if (outcome.route === 'bmad-review-fallback' && !outcome.skillInstalled) {
        this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-failed', jobId,
          payload: { requestSeq: pending.seq, error: outcome.note },
        });
        return;
      }
      this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-started', jobId, payload: {
        requestSeq: pending.seq, route: outcome.route,
        ...(outcome.route === 'perkins' ? { roundId: outcome.round.id } : {}),
      } });
      void outcome.run.catch((error: unknown) => {
        this.log('error', 'queued review run failed after admission', { job: jobId, error: String(error) });
      });
    } catch (error) {
      // HELD: a post-intake hold/status flip invalidates the prior
      // execution permission — the obligation stays visible and requires a
      // genuinely NEW validated review request to rearm (never a sweep,
      // job.delivered, ACK, or a later status flip alone).
      if (error instanceof HandoffHeldError) {
        held = true;
        pending.held = true;
        this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-held', jobId,
          payload: { requestSeq: pending.seq, reason: `job-status-${error.status}` },
        });
        this.escalate(
          `Queued review handoff for job ${jobId} is held`,
          `The durable review request can no longer be authorized automatically: job status is ${error.status}. Re-request the review after the hold clears.`,
          { jobId },
        );
        return;
      }
      // Owner rule 3: a replay whose setup an approved material change
      // superseded was withdrawn on purpose — a routine terminal, never a
      // failure or an action-required incident.
      if (error instanceof ReviewSupersededError) {
        const withdrawn = this.opts.ledger.latestJobEvent(jobId, 'job.review-handoff-withdrawn');
        const recorded = typeof withdrawn?.payload === 'object' && withdrawn.payload !== null &&
          (withdrawn.payload as { requestSeq?: unknown }).requestSeq === pending.seq;
        if (!recorded) {
          this.opts.ledger.appendCustomEvent({
            kind: 'job.review-handoff-withdrawn', jobId,
            payload: { requestSeq: pending.seq, reason: error.reason.slice(0, 500) },
          });
        }
        return;
      }
      // Same-job re-busy preserves the durable intent: re-queue for the
      // NEXT delivery; only foreign blockers terminalize the handoff.
      if (error instanceof BranchBusyError && !this.shuttingDown &&
        error.blockers.length > 0 && error.blockers.every((blocker) => blocker.jobId === jobId)) {
        requeued = true;
        this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-requeued', jobId,
          payload: { requestSeq: pending.seq, blockers: error.blockers },
        });
        return; // starting reset in finally; next delivery re-arms
      }
      if (!this.shuttingDown) {
        this.opts.ledger.appendCustomEvent({ kind: 'job.review-handoff-failed', jobId, payload: { requestSeq: pending.seq, error: String(error) } });
        // R7-16/R8-25: a refusal already notified (an admission refusal's
        // FYI or escalation, a blocked freeze) — never twice.
        if (!alreadyNotified(error)) {
          this.escalate(`Queued review handoff failed for job ${jobId}`, String(error), { jobId });
        }
      }
    } finally {
      pending.starting = false;
      if (!requeued && !held) {
        if (this.handoffs.get(jobId) === pending) this.handoffs.delete(jobId);
        pending.resolve();
      }
      // A settlement signal that arrived during the old delivery's busy
      // replay is not lost: its marker-free retry starts after this attempt
      // releases the in-flight flag. Held requests never auto-rearm.
      if (requeued && pending.settlementReplayRequested && this.handoffs.get(jobId) === pending) {
        pending.settlementReplayRequested = false;
        void this.startHandoff(jobId, pending);
      }
      // requeued: stays pending and re-armable. held: stays pending and
      // VISIBLE but not sweep-rearmable — only a new validated request
      // (which supersedes via the queue path) may clear `held`.
    }
  }

  /** Reconsider ONE job's queued handoff on a genuine observation (the
   * requestReview re-entry path): the replay re-runs every current fence
   * (branch-idle, exact-head, freeze, capacity) and arms the review now.
   * Legitimate busy/capacity waits stay pending (the replay re-queues);
   * held or in-flight pendings are left untouched by startHandoff's
   * guards. Nothing is skipped. */
  private reconcileQueuedHandoff(jobId: string): void {
    const pending = this.handoffs.get(jobId);
    if (pending !== undefined) void this.startHandoff(jobId, pending);
  }

  /** Deterministic-pass reconsideration of every queued handoff — the
   * exact callback main wires into the Silas seam. No API call, no timer,
   * no follow-through lane: each pending is offered to startHandoff, whose
   * guards keep held pendings held (only a genuinely new validated request
   * rearms them) and whose terminal bookkeeping removes settled entries, so
   * repeated passes are bounded and cannot double-start. */
  reconcilePendingHandoffs(): void {
    for (const [jobId, pending] of this.handoffs) void this.startHandoff(jobId, pending);
  }

  /** A genuinely new validated review request clears a prior hold and
   * supersedes the pending intent (queue-path rearm), keyed by identity. */
  private supersedeHeldHandoff(jobId: string, newInput: { targetRef?: string; lenses?: readonly string[]; noSpec?: boolean; evidence?: readonly ReviewEvidenceRequest[] }): boolean {
    const pending = this.handoffs.get(jobId);
    if (pending === undefined || !pending.held) return false;
    // The queue keeps the first-request identity (first-wins); the fresh
    // validated request only clears the hold. Record the fresh request so the
    // folded difference is auditable and never silent.
    this.opts.ledger.appendCustomEvent({
      kind: 'job.review-handoff-superseded',
      jobId,
      payload: {
        requestSeq: pending.seq,
        ...(newInput.targetRef !== undefined ? { targetRef: newInput.targetRef } : {}),
        ...(newInput.lenses !== undefined ? { lenses: newInput.lenses } : {}),
        ...(newInput.noSpec !== undefined ? { noSpec: newInput.noSpec } : {}),
        ...(newInput.evidence !== undefined
          ? { evidence_count: newInput.evidence.length, evidence_request_sha256: evidenceRequestFingerprint(newInput.evidence) }
          : {}),
      },
    });
    pending.held = false; // a NEW request is fresh validated intent
    return true;
  }

  /** Legacy direct entry: a failed pre-flight never silently starts a
   * Perkins round — it throws with the routing decision attached. */
  async beginRound(input: {
    jobId: string;
    targetRef?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
    force?: boolean;
    evidence?: readonly ReviewEvidenceRequest[];
    /** Prior indexes the implementing minion claimed fixed (fix-directive
     * receipt); Stage-5 carry-forward always re-verifies claimed priors. */
    claimedFixedPriors?: readonly number[];
  }): Promise<{ readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }> {
    this.enforceBranchIdleForRequest(input);
    let reviewModel: ReviewPreflightResult['reviewModel'];
    let reviewThinkingLevel: string | undefined;
    if (this.opts.reviewPreflight !== undefined) {
      const repoPath = this.resolveReviewRequestRepo(input);
      if (repoPath !== null) {
        const result = await this.opts.reviewPreflight({ repoPath });
        if (!result.ok) throw new FallbackGateRequiredError(result.failures);
        reviewModel = result.reviewModel;
        reviewThinkingLevel = result.reviewThinkingLevel;
      }
    }
    return this.beginPerkinsRound({ ...input, reviewModel, reviewThinkingLevel });
  }

  private resolveReviewRequestRepo(input: { jobId: string }): string | null {
    const job = this.opts.ledger.getJob(input.jobId);
    if (job === null) return null;
    const lane = this.opts.worktrees
      .listWorktrees({ jobId: input.jobId })
      .find((candidate) => candidate.kind === 'job') ?? null;
    return lane?.path ?? null;
  }

  /** Arm-intake branch-idle check. An unknown job is left to the round setup
   * (it reports the canonical not-found error), and so is a job with no job
   * lane yet — without a lane there is no target branch to protect, and the
   * round setup names the missing lane loudly. A known, laned job is refused
   * here before any round, worktree, or pre-flight work exists. */
  private enforceBranchIdleForRequest(input: {
    jobId: string;
    targetRef?: string;
    force?: boolean;
  }): void {
    const job = this.opts.ledger.getJob(input.jobId);
    if (job === null) return;
    const jobLane = this.opts.worktrees
      .listWorktrees({ jobId: input.jobId })
      .find((candidate) => candidate.kind === 'job') ?? null;
    if (jobLane === null) return;
    this.enforceBranchIdle({
      job,
      jobLane,
      ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
      phase: 'arm',
    });
  }

  /** Branch-idle guard for one review target (rule 2026-09-23): resolve the
   * branch under review, scan the ledger for lanes still pushing it, and
   * refuse (typed, mapped to 409 at the API) unless the request carries the
   * human `force` override. A forced arm is tagged in the event log here;
   * the freeze-phase caller also writes the manifest tag. Runs before any
   * route decision so every caller inherits one rule. */
  /** The branch-idle blockers of a request, without auditing or refusing. */
  private branchIdleBlockers(input: {
    job: { readonly id: string };
    jobLane: WorktreeLane | null;
    targetRef?: string | undefined;
    force?: boolean | undefined;
    phase: BranchIdlePhase;
    roundId?: string;
    /** Pre-setup status when this round itself flipped the reviewed job
     * (working|blocked → in-review): the flip is bookkeeping and must not
     * mask the lane it moved. */
    reviewedStatus?: { readonly jobId: string; readonly status: JobStatus } | undefined;
  }): { readonly targetBranch: string; readonly blockers: readonly BranchIdleBlocker[] } {
    const targetBranch = resolveReviewTargetBranch({
      jobId: input.job.id,
      ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
      lanePath: input.jobLane?.path ?? null,
      laneBranch: input.jobLane?.branch ?? null,
    });
    const laneMatched = findBusyLanes({
      ledger: this.opts.ledger,
      lanes: this.opts.worktrees.listWorktrees(),
      targetBranch,
      ...(input.reviewedStatus !== undefined ? { reviewedStatus: input.reviewedStatus } : {}),
    });
    // A reviewed job's OWN unresolved re-brief fences the review regardless
    // of which branch the request targets: an explicit `target_ref` naming
    // another lane must not bypass the job's own newer request. Foreign
    // lanes keep the existing branch-match semantics, and terminal jobs are
    // never busy (the canonical terminal refusal owns them).
    const blockers: BranchIdleBlocker[] = [...laneMatched];
    const jobNow = this.opts.ledger.getJob(input.job.id);
    // Owner rule 2: the job's own pending correction fences ANY target —
    // a review of an explicit ref cannot stand in for the outdated lane.
    const revision = jobNow === null ? null : pendingWorkRevision(this.opts.ledger, jobNow);
    const verification = jobNow === null || isJobTerminal(jobNow.status) || revision !== null
      ? null : this.opts.ledger.correctiveVerificationDebt(input.job.id);
    if (
      jobNow !== null &&
      !isJobTerminal(jobNow.status) &&
      !blockers.some((blocker) => blocker.jobId === input.job.id) &&
      (this.opts.ledger.listPendingRebriefs({ jobId: input.job.id }).length > 0 ||
        this.opts.ledger.hasOpenDirectiveRecoveryHold(input.job.id) ||
        revision !== null || verification !== null)
    ) {
      blockers.push({
        jobId: input.job.id,
        status: jobNow.status,
        branch: input.jobLane?.branch != null && input.jobLane.branch.trim() !== ''
          ? normalizeBranch(input.jobLane.branch)
          : laneBranch(input.job.id),
        ...(revision !== null ? { revision } : {}),
        ...(verification !== null ? { verification } : {}),
      });
    }
    return { targetBranch, blockers };
  }

  private enforceBranchIdle(input: {
    job: { readonly id: string };
    jobLane: WorktreeLane | null;
    targetRef?: string | undefined;
    force?: boolean | undefined;
    phase: BranchIdlePhase;
    roundId?: string;
    /** Pre-setup status when this round itself flipped the reviewed job
     * (working|blocked → in-review): the flip is bookkeeping and must not
     * mask the lane it moved. */
    reviewedStatus?: { readonly jobId: string; readonly status: JobStatus } | undefined;
  }): { readonly targetBranch: string; readonly blockers: readonly BranchIdleBlocker[] } {
    const { targetBranch, blockers } = this.branchIdleBlockers(input);
    // A retirement hold is a fresh-authorization boundary, not ordinary
    // branch activity. Neither force nor a foreign target may waive it. A
    // pending material correction is the same (owner rule 2): the candidate
    // is outdated by an approved change, and no override reviews it.
    const held = blockers.some((blocker) =>
      blocker.revision !== undefined || this.opts.ledger.hasOpenDirectiveRecoveryHold(blocker.jobId));
    if (blockers.length === 0 && input.force !== true) return { targetBranch, blockers };
    const forced = input.force === true && !held;
    this.opts.ledger.appendCustomEvent({
      kind: forced ? 'branch-idle.forced' : 'branch-idle.refused',
      jobId: input.job.id,
      ...(input.roundId !== undefined ? { roundId: input.roundId } : {}),
      payload: { phase: input.phase, forced, targetBranch, blockers },
    });
    if (!forced) throw new BranchBusyError(targetBranch, blockers, input.phase);
    return { targetBranch, blockers };
  }

  private readonly roundAdmission = new Set<string>();

  private async beginPerkinsRound(input: {
    jobId: string;
    targetRef?: string;
    /** Clean-abort re-arm: the exact delivered head proved at request time;
     * re-proved at the freeze boundary before any lens runs. */
    boundDeliveredSha?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
    force?: boolean;
    evidence?: readonly ReviewEvidenceRequest[];
    /** Prior indexes the implementing minion claimed fixed. */
    claimedFixedPriors?: readonly number[];
    reviewModel?: ReviewPreflightResult['reviewModel'];
    reviewThinkingLevel?: string;
    /** The automatic admission retry this round carries out. */
    admissionRetry?: AdmissionRetry;
  }): Promise<{ readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }> {
    if (this.shuttingDown) throw new Error('Perkins review service is shutting down');
    if (this.roundAdmission.has(input.jobId)) throw new RoundAdmissionInProgress(input.jobId);
    this.roundAdmission.add(input.jobId);
    const controller = new AbortController();
    try {
      return await this.trackReview(input.jobId, 'setup', null, this.setupRound(input, controller.signal), controller);
    } finally {
      this.roundAdmission.delete(input.jobId);
      // R7-15: the setup (rollback included) has unwound — only now may a
      // retry it scheduled be armed.
      const scheduled = this.admissionRetries.get(input.jobId);
      if (scheduled !== undefined && scheduled.timer === null && !scheduled.running) this.armAdmissionRetry(scheduled);
    }
  }

  /** A refused admission (owner decision 2026-10-08). A TRANSIENT refusal —
   * every missing input a head-binding git step that failed and PROVED its
   * process group stopped — schedules the next automatic retry (in memory)
   * and informs; any other refusal, or the last retry's, escalates
   * action-required. A fresh request refused while a retry waits keeps
   * that retry (R7-11): same attempt, same due time, now answering THIS
   * refusal. The retry is armed once the setup unwound (R7-15). */
  private refuseAdmission(
    roundId: string,
    input: AdmissionRetryInput & { readonly admissionRetry?: AdmissionRetry },
    missing: readonly AdmissionMissingInput[],
    reviewedDeliverySeq: number,
  ): ReviewAdmissionError {
    const { jobId } = input;
    const title = `Perkins review for job ${jobId} refused admission before any specialist started`;
    const delays = this.admissionRetryDelaysMs;
    const transient = missing.every((entry) => entry.retryable === true);
    const current = this.admissionRetries.get(jobId);
    const own = input.admissionRetry;
    const waiting = own === undefined && current !== undefined && !current.running ? current : undefined;
    const attempt = own !== undefined ? own.attempt + 1 : waiting?.attempt ?? 1;
    if (!transient || attempt > delays.length) {
      if (waiting !== undefined) this.dropAdmissionRetry(waiting, { outcome: 'superseded', roundId });
      const refusal = new ReviewAdmissionError(missing, transient && delays.length > 0
        ? `automatic retry ${delays.length} of ${delays.length} was refused too — no retries remain`
        : undefined);
      this.escalate(
        `Perkins review for job ${jobId} refused admission before any specialist started`,
        refusal.message,
        { jobId, roundId },
      );
      return refusal;
    }
    const dueAt = waiting?.dueAt ?? Date.now() + delays[attempt - 1]!;
    const refusal = new ReviewAdmissionError(missing, `automatic retry ${attempt} of ${delays.length} is scheduled for ${new Date(dueAt).toISOString()}`);
    const scheduled = this.opts.ledger.appendCustomEvent({
      kind: 'round.admission-retry-scheduled', jobId, roundId,
      payload: { attempt, of: delays.length, dueAt: new Date(dueAt).toISOString(), deliverySeq: reviewedDeliverySeq },
    });
    // R9-8: the replacement keeps the waiting retry's attempt and due time,
    // never its timer — that timer could come due while this refusal is
    // still rolling back. Setup's finally arms the replacement afterwards
    // (immediately, if it is already due).
    if (waiting?.timer != null) clearTimeout(waiting.timer);
    this.admissionRetries.set(jobId, {
      input: admissionRetryInput(input), roundId, deliverySeq: reviewedDeliverySeq, attempt, dueAt,
      scheduledSeq: scheduled.seq, timer: null, running: false,
    });
    this.opts.inform?.(title, refusal.message, { jobId, roundId });
    return refusal;
  }

  /** Forget a retry that will not run, recording why. */
  private dropAdmissionRetry(retry: AdmissionRetry, settlement: Readonly<Record<string, unknown>>): void {
    const { jobId } = retry.input;
    if (retry.timer !== null) clearTimeout(retry.timer);
    retry.timer = null;
    if (this.admissionRetries.get(jobId) === retry) this.admissionRetries.delete(jobId);
    this.settleAdmissionRetry(retry, settlement);
  }

  /** Bookkeeping only: this retry will not be pending after a restart. */
  private settleAdmissionRetry(retry: AdmissionRetry, settlement: Readonly<Record<string, unknown>>): void {
    this.opts.ledger.appendCustomEvent({
      kind: 'round.admission-retry-settled', jobId: retry.input.jobId, roundId: retry.roundId,
      payload: { attempt: retry.attempt, scheduledSeq: retry.scheduledSeq, ...settlement },
    });
  }

  private armAdmissionRetry(retry: AdmissionRetry): void {
    if (this.shuttingDown) return; // the next start's check escalates it
    const { jobId } = retry.input;
    const timer = setTimeout(() => {
      // Only the timer this job's retry still holds fires it.
      const current = this.admissionRetries.get(jobId);
      if (current === undefined || current.timer !== timer) return;
      this.fireAdmissionRetry(current).catch((error: unknown) => {
        this.log('error', 'automatic admission retry crashed', { job: jobId, error: String(error) });
        this.escalate(
          `Automatic review retry for job ${jobId} crashed`,
          `Retry ${current.attempt} after refused round ${current.roundId}: ${String(error)}`,
          { jobId, roundId: current.roundId },
        );
      });
    }, Math.max(0, retry.dueAt - Date.now()));
    timer.unref();
    retry.timer = timer;
  }

  /** Why a due retry is no longer wanted — the job moved on, or another
   * request for it is already under way — or null. */
  private admissionRetrySkipReason(retry: AdmissionRetry): string | null {
    const job = this.opts.ledger.getJob(retry.input.jobId);
    if (job === null) return 'the job no longer exists';
    if (!WaveRunner.HANDOFF_AUTHORIZED_STATUSES.has(job.status)) return `the job is ${job.status}`;
    const deliverySeq = this.opts.ledger.latestJobEvent(job.id, 'job.delivered')?.seq ?? 0;
    if (deliverySeq !== retry.deliverySeq) return 'a newer delivery replaced the refused one';
    const rounds = this.opts.ledger.listRounds(job.id);
    if (rounds[rounds.length - 1]?.id !== retry.roundId) return 'a newer review round already started';
    if (this.roundAdmission.has(job.id) || this.handoffs.has(job.id)) return 'another review request for the job is under way';
    return null;
  }

  /** A due retry: checked ONCE that its job is still where it was refused,
   * then re-submitted as an ordinary review request — every ordinary fence
   * applies from there (owner decision 2026-10-08: no durable claim, no
   * lifecycle). A busy branch or a job that moved on skips it with an FYI;
   * a shutdown leaves it to the next start's check. */
  private async fireAdmissionRetry(retry: AdmissionRetry): Promise<void> {
    const { jobId } = retry.input;
    retry.timer = null;
    if (this.shuttingDown) return;
    const context = { jobId, roundId: retry.roundId };
    const skip = (reason: string): void => {
      this.dropAdmissionRetry(retry, { outcome: 'skipped', reason });
      this.opts.inform?.(`Automatic review retry for job ${jobId} skipped`,
        `Retry ${retry.attempt} after refused round ${retry.roundId} did not run: ${reason}.`, context);
    };
    const skipped = this.admissionRetrySkipReason(retry);
    if (skipped !== null) return skip(skipped);
    retry.running = true;
    try {
      const result = await this.requestReview({ ...retry.input, admissionRetry: retry });
      this.dropAdmissionRetry(retry, result.route === 'perkins'
        ? { outcome: 'ran', route: result.route, ranRoundId: result.round.id }
        : { outcome: 'ran', route: result.route });
      void result.run.catch((error: unknown) => {
        this.log('error', 'automatic admission retry failed after admission', { job: jobId, error: String(error) });
      });
    } catch (error) {
      retry.running = false;
      if (error instanceof ReviewAdmissionError) {
        // Its refusal already scheduled the next retry, or escalated.
        this.settleAdmissionRetry(retry, { outcome: 'refused' });
        if (this.admissionRetries.get(jobId) === retry) this.admissionRetries.delete(jobId);
      } else if (this.shuttingDown) {
        return; // the next start's check escalates it
      } else if (error instanceof BranchBusyError) {
        skip(`the branch is busy again (${error.message})`);
      } else if (error instanceof RoundAdmissionInProgress) {
        skip('another review request for the job is under way');
      } else {
        this.dropAdmissionRetry(retry, { outcome: 'failed', detail: String(error).slice(0, 300) });
        if (!alreadyNotified(error)) {
          this.escalate(
            `Automatic review retry for job ${jobId} could not start`,
            `Retry ${retry.attempt} after refused round ${retry.roundId} failed before admission: ${String(error)}`,
            { jobId, roundId: retry.roundId },
          );
        }
      }
    }
  }

  /** Startup (owner decision 2026-10-08): automatic retries live in memory,
   * so one that was pending when the service stopped never resumes — each
   * job's latest scheduled retry that never settled, whose refused round is
   * still the job's latest, escalates action-required once instead. */
  escalateInterruptedAdmissionRetries(): number {
    let escalated = 0;
    for (const job of this.opts.ledger.listJobs()) {
      if (isJobTerminal(job.status)) continue;
      const scheduled = this.opts.ledger.latestJobEvent(job.id, 'round.admission-retry-scheduled');
      if (scheduled === null || scheduled.roundId === null) continue;
      const settled = this.opts.ledger
        .listJobEventsByKinds(job.id, ['round.admission-retry-settled'], { limit: 50 })
        .some((event) => (event.payload as { scheduledSeq?: unknown } | null)?.scheduledSeq === scheduled.seq);
      if (settled) continue;
      const rounds = this.opts.ledger.listRounds(job.id);
      const payload = scheduled.payload as { attempt?: unknown; dueAt?: unknown } | null;
      this.opts.ledger.appendCustomEvent({
        kind: 'round.admission-retry-settled', jobId: job.id, roundId: scheduled.roundId,
        payload: { attempt: payload?.attempt ?? null, scheduledSeq: scheduled.seq, outcome: 'interrupted' },
      });
      if (rounds[rounds.length - 1]?.id !== scheduled.roundId) continue; // a newer round already answers it
      this.escalate(
        `Automatic review retry for job ${job.id} was interrupted by a restart`,
        `Retry ${String(payload?.attempt ?? '?')} after refused round ${scheduled.roundId} was due at ` +
          `${String(payload?.dueAt ?? 'an unknown time')}, but the service stopped first. Retries are not resumed after a ` +
          'restart — request the review again.',
        { jobId: job.id, roundId: scheduled.roundId },
      );
      escalated += 1;
    }
    return escalated;
  }

  /** Direct, lane-independent re-proof of the CURRENT fallback-admission
   * facts (the shared guard early-returns without a job lane): the job's
   * own lane must still exist, no unresolved re-brief may stand without an
   * explicit audited force, and a replay must still be authorized. Bounded
   * to the fallback seam; native arm/freeze are unchanged. */
  private assertFallbackAdmissionCurrent(input: {
    jobId: string;
    targetRef?: string | undefined;
    force?: boolean | undefined;
    fromHandoff?: boolean | undefined;
  }): string {
    const lane = this.opts.worktrees
      .listWorktrees({ jobId: input.jobId })
      .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept') ?? null;
    if (lane === null) {
      throw new Error(`job "${input.jobId}" has no active job lane in the registry — the fallback review cannot start`);
    }
    if (input.force !== true) {
      const job = this.opts.ledger.getJob(input.jobId);
      // Terminal jobs are never busy (mirrors laneIsBusy): the canonical
      // terminal guard wins over a stale marker, handled before this call.
      if (job === null || !isJobTerminal(job.status)) {
        const markers = this.opts.ledger.listPendingRebriefs({ jobId: input.jobId });
        if (markers.length > 0) {
          const targetBranch = resolveReviewTargetBranch({
            jobId: input.jobId,
            ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
            lanePath: lane.path,
            laneBranch: lane.branch,
          });
          const blockers: readonly BranchIdleBlocker[] = [
            { jobId: input.jobId, status: job?.status ?? 'working', branch: targetBranch },
          ];
          this.opts.ledger.appendCustomEvent({
            kind: 'branch-idle.refused',
            jobId: input.jobId,
            payload: { phase: 'arm', forced: false, targetBranch, blockers },
          });
          throw new BranchBusyError(targetBranch, blockers, 'arm');
        }
      }
    }
    // Owner rule 2: a pending material correction refuses fallback
    // admission even under force — the candidate is outdated.
    const jobRow = this.opts.ledger.getJob(input.jobId);
    const revision = jobRow === null ? null : pendingWorkRevision(this.opts.ledger, jobRow);
    if (jobRow !== null && revision !== null) {
      const targetBranch = resolveReviewTargetBranch({
        jobId: input.jobId,
        ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
        lanePath: lane.path,
        laneBranch: lane.branch,
      });
      const blockers: readonly BranchIdleBlocker[] = [{ jobId: input.jobId, status: jobRow.status, branch: targetBranch, revision }];
      this.opts.ledger.appendCustomEvent({
        kind: 'branch-idle.refused',
        jobId: input.jobId,
        payload: { phase: 'arm', forced: false, targetBranch, blockers },
      });
      throw new BranchBusyError(targetBranch, blockers, 'arm');
    }
    if (input.fromHandoff === true) {
      const pending = this.handoffs.get(input.jobId);
      this.assertHandoffAuthorized(input.jobId, pending?.seq ?? -1);
    }
    return lane.path;
  }

  /** Re-proof for a RUNNING fallback gate at its concrete async boundaries
   * (before each round's diff intake, and after the default reviewer's
   * worker-gate admission before it spawns): the lane must still exist, an
   * unresolved re-brief stops a non-forced gate, and a replay must still be
   * authorized. A forced admission carries the operator's explicit audited
   * acceptance of the marker fence through the gate run; the lane and
   * authorization facts still fail closed. The override is restricted to
   * request generations present at its audited arm; later work is not waived. */
  private assertFallbackIterationCurrent(input: {
    jobId: string;
    force?: boolean | undefined;
    fromHandoff?: boolean | undefined;
  }, admission: {
    readonly lanePath: string;
    readonly targetBranch: string;
    readonly branchOwners: readonly {
      readonly jobId: string;
      readonly path: string;
      readonly statusSeq: number;
      readonly deliverySeq: number;
      readonly markerIds: readonly string[];
    }[];
    readonly busyJobIds: readonly string[];
    readonly markerIds: readonly string[];
    readonly deliverySeq: number;
    readonly statusSeq: number;
    readonly settlementSeq: number;
  }): void {
    const jobNow = this.opts.ledger.getJob(input.jobId);
    if (jobNow !== null && isJobTerminal(jobNow.status)) {
      throw new FallbackSafetyRefusal(
        `job "${input.jobId}" is ${jobNow.status} — terminal lanes do not continue under fallback review`,
      );
    }
    const lane = this.opts.worktrees
      .listWorktrees({ jobId: input.jobId })
      .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept') ?? null;
    if (lane === null) {
      throw new FallbackSafetyRefusal(
        `job "${input.jobId}" lost its active job lane — the fallback gate stops fail-closed`,
      );
    }
    if (lane.path !== admission.lanePath) {
      throw new FallbackSafetyRefusal(
        `job "${input.jobId}" replaced its admitted job lane — the fallback gate stops fail-closed`,
      );
    }
    const markers = this.opts.ledger.listPendingRebriefs({ jobId: input.jobId });
    if (markers.some((marker) => !admission.markerIds.includes(marker.id)) ||
        (input.force !== true && markers.length > 0)) {
      throw new FallbackSafetyRefusal(
        `a new or unresolved re-brief request owns job "${input.jobId}" — the fallback gate stops before the next review round`,
      );
    }
    // Owner rule 2: a material correction accepted while the gate runs makes
    // its diff obsolete — no override carries the gate past it.
    if (jobNow !== null && pendingWorkRevision(this.opts.ledger, jobNow) !== null) {
      throw new FallbackSafetyRefusal(
        `an approved material correction for job "${input.jobId}" is pending delivery — the old diff cannot pass`,
      );
    }
    if (fallbackWorkingStartedSince(this.opts.ledger, input.jobId, admission.statusSeq) ||
        (this.opts.ledger.latestJobEvent(input.jobId, 'job.delivered')?.seq ?? 0) !== admission.deliverySeq ||
        (this.opts.ledger.latestJobEvent(input.jobId, 'silas.rebrief-settled')?.seq ?? 0) !== admission.settlementSeq ||
        (input.force !== true && jobNow !== null && laneIsBusy(this.opts.ledger, jobNow))) {
      throw new FallbackSafetyRefusal(
        `job "${input.jobId}" changed or reopened after fallback admission — the old diff cannot pass`,
      );
    }
    if (input.fromHandoff === true) {
      const pending = this.handoffs.get(input.jobId);
      try {
        this.assertHandoffAuthorized(input.jobId, pending?.seq ?? -1);
      } catch (error) {
        throw new FallbackSafetyRefusal(
          `the review handoff for job "${input.jobId}" is no longer authorized: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const lanesNow = this.opts.worktrees.listWorktrees();
    const ownersNow = lanesNow.filter((candidate) => candidate.kind === 'job' && candidate.status !== 'swept' &&
      candidate.jobId !== null && normalizeBranch(candidate.branch ?? laneBranch(candidate.jobId)) === admission.targetBranch);
    if (ownersNow.length !== admission.branchOwners.length || ownersNow.some((candidate) => {
      const owner = admission.branchOwners.find((entry) => entry.jobId === candidate.jobId && entry.path === candidate.path);
      if (owner === undefined) return true;
      return fallbackWorkingStartedSince(this.opts.ledger, owner.jobId, owner.statusSeq) ||
        (this.opts.ledger.latestJobEvent(owner.jobId, 'job.delivered')?.seq ?? 0) !== owner.deliverySeq ||
        JSON.stringify(this.opts.ledger.listPendingRebriefs({ jobId: owner.jobId }).map((marker) => marker.id)) !==
          JSON.stringify(owner.markerIds);
    })) {
      throw new FallbackSafetyRefusal(
        `a lane on branch "${admission.targetBranch}" changed after fallback admission — the old diff cannot pass`,
      );
    }
    const busyNow = findBusyLanes({ ledger: this.opts.ledger, lanes: lanesNow, targetBranch: admission.targetBranch });
    if (busyNow.some((blocker) => input.force !== true || !admission.busyJobIds.includes(blocker.jobId))) {
      throw new FallbackSafetyRefusal(
        `a new busy lane owns branch "${admission.targetBranch}" — the fallback gate stops before the next review round`,
      );
    }
  }

  private async beginFallbackGate(
    input: { jobId: string },
    failedLegs: readonly ReviewCapabilityFailure[],
    repoPath: string | null,
    recheck?: () => void,
  ): Promise<FallbackGateOutcome> {
    if (this.shuttingDown) throw new Error('Perkins review service is shutting down');
    const job = this.opts.ledger.getJob(input.jobId);
    if (job === null || repoPath === null) throw new Error(`job "${input.jobId}" not found — nothing to review`);
    if (isJobTerminal(job.status)) {
      throw new Error(`job "${input.jobId}" is ${job.status} — terminal lanes do not go back under review`);
    }
    // Validate BEFORE the outcome returns: a failure after the 202 response
    // would be swallowed by the response path with no durable record.
    requireSafeRecordId(job.id, 'job id');
    const gate = this.opts.fallbackGate;
    const present = gate !== undefined && skillInstalled(gate.skillPath);
    if (gate === undefined || !present) {
      const note = gate === undefined
        ? 'the bmad-review fallback gate is not configured on this service'
        : `the bmad-review skill is not installed at ${gate.skillPath}`;
      const guidance = `Options: (1) install the bmad-review skill into ~/.agents/skills or the pi agent skills directory (the GC-managed BMAD runtime bundles only the build workflow); (2) restore the Perkins gate — ${failedLegs.map((leg) => leg.remediation).join(' ')}`;
      const message = `${note} ${guidance}`;
      this.opts.ledger.appendCustomEvent({
        kind: 'job.fallback-review',
        jobId: job.id,
        payload: { phase: 'unavailable', gate: true, skillInstalled: present, failedLegs, note },
      });
      this.escalate(
        `Review for job ${job.id} cannot gate: Perkins is unavailable and the fallback is not installed`,
        message,
        { jobId: job.id },
      );
      return {
        route: 'bmad-review-fallback', failedLegs, skillInstalled: present, clearToMerge: false,
        iterations: 0, blockers: 0, notes: 0, reportFiles: [], note: message, run: Promise.resolve(),
      };
    }
    const baseRef = resolveGitCommit(repoPath, resolveReviewBaseRef(repoPath, job.baseBranch));
    if (this.activeFallbackGates.has(job.id)) {
      throw new Error(`a fallback review gate is already running for job "${job.id}"`);
    }
    const controller = new AbortController();
    const state: FallbackGateState = {
      clearToMerge: false, iterations: 0, blockers: 0, notes: 0, reportFiles: [],
      note: 'bmad-review fallback gate engaged',
    };
    this.activeFallbackGates.add(job.id);
    const run = this.trackReview(
      job.id,
      'fallback',
      null,
      this.runFallbackGate(job, repoPath, baseRef, failedLegs, gate, controller.signal, state, recheck)
        .finally(() => this.activeFallbackGates.delete(job.id)),
      controller,
    );
    return {
      route: 'bmad-review-fallback',
      failedLegs,
      skillInstalled: true,
      get clearToMerge() {
        return state.clearToMerge;
      },
      get iterations() {
        return state.iterations;
      },
      get blockers() {
        return state.blockers;
      },
      get notes() {
        return state.notes;
      },
      get reportFiles() {
        return [...state.reportFiles];
      },
      get note() {
        return state.note;
      },
      run,
    };
  }

  private async runFallbackGate(
    job: { readonly id: string },
    lanePath: string,
    baseRef: string,
    failedLegs: readonly ReviewCapabilityFailure[],
    gate: FallbackGateOptions,
    signal: AbortSignal,
    state: FallbackGateState,
    recheck?: () => void,
  ): Promise<void> {
    const maxRounds = gate.maxReviewRounds ?? 4;
    const directory = join(this.artifactRoot(), 'fallback-gate', `${job.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fallbackEvent = (payload: Record<string, unknown>): void => {
      this.opts.ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: job.id, payload: { gate: true, ...payload } });
    };
    fallbackEvent({ phase: 'started', failedLegs, skill: gate.skillPath });
    this.escalate(
      `Perkins gate unavailable for job ${job.id} — the bmad-review gate is engaged`,
      failedLegs.map((leg) => `${leg.leg}: ${leg.detail}`).join('; '),
      { jobId: job.id },
    );
    let blockers = 0;
    let notes = 0;
    for (let iteration = 1; iteration <= maxRounds; iteration += 1) {
      if (signal.aborted) {
        // A superseded gate (owner rule 3) — e.g. cancelled while its fix
        // directive ran — still records its routine terminal; shutdown keeps
        // its existing unrecorded stop.
        if (this.supersededFallbackGates.has(job.id)) {
          this.terminalFallbackSuperseded(job.id, `cancelled before round ${iteration}`, iteration, [...state.reportFiles], fallbackEvent, state);
          return;
        }
        throw new Error('review operation aborted');
      }
      // The gate can outlive its admission by many rounds (review → fix
      // directive → re-review). Re-prove the CURRENT lane/marker/
      // authorization facts before this round's diff intake: a re-brief
      // request admitted mid-gate owns the lane and must stop the gate
      // before its working tree is read or another reviewer is spawned.
      if (recheck !== undefined) {
        try {
          recheck();
        } catch (error) {
          if (error instanceof FallbackSafetyRefusal) {
            this.terminalFallbackAborted(job.id, error.message, iteration, [...state.reportFiles], fallbackEvent, state);
            return;
          }
          throw error;
        }
      }
      // Presence catches an open request; this durable settlement watermark
      // also catches a request that both began and finished during an async
      // reviewer turn. Its old diff cannot be approved after that turn.
      const settlementSeq = this.opts.ledger.latestJobEvent(job.id, 'silas.rebrief-settled')?.seq ?? 0;
      const recheckRound = (): void => {
        recheck?.();
        if ((this.opts.ledger.latestJobEvent(job.id, 'silas.rebrief-settled')?.seq ?? 0) !== settlementSeq) {
          throw new FallbackSafetyRefusal(
            `a re-brief request settled during fallback round ${iteration} for job "${job.id}" — the old diff cannot pass`,
          );
        }
      };
      const reportFile = join(directory, `review-${iteration}.json`);
      // Re-read the lane's working diff every round: the fix directive may
      // have changed the tree, and the next review must see those bytes.
      // Working-tree diff against the base commit: uncommitted minion fixes
      // MUST be visible to the re-review round.
      // Mark untracked files as intent-to-add so `git diff` sees them, then
      // undo the markers — the gate reviews the full working tree.
      spawnSync('git', ['-C', lanePath, 'add', '-N', '.'], { timeout: 10_000 });
      const diffResult = spawnSync(
        'git', ['-C', lanePath, 'diff', '--no-ext-diff', '--no-color', baseRef],
        { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      );
      spawnSync('git', ['-C', lanePath, 'reset', '-q', '--'], { timeout: 10_000 });
      if (diffResult.error !== undefined || diffResult.status !== 0) {
        this.terminalFallbackBlocked(
          job.id,
          `cannot compute the working diff for fallback round ${iteration}: ${(diffResult.stderr ?? '').trim().slice(0, 200)}`,
          iteration, [...state.reportFiles], fallbackEvent, state,
        );
        return;
      }
      const diff = boundedDiff(diffResult.stdout ?? '');
      let findings: readonly FallbackFinding[];
      try {
        findings = gate.runFallbackReview !== undefined
          ? await gate.runFallbackReview({ jobId: job.id, lanePath, baseRef, diff, skillPath: gate.skillPath, reportFile, iteration, signal })
          : await this.defaultFallbackReview({ jobId: job.id, lanePath, baseRef, diff, skillPath: gate.skillPath, reportFile, iteration, signal }, recheckRound);
        // A completed review of an older diff is not a PASS on a lane that
        // acquired and possibly settled a newer request while it ran.
        recheckRound();
        // A reviewer that answers after cancellation (supersession, owner
        // rule 3, or shutdown) never records a verdict on that diff.
        if (signal.aborted) {
          throw new FallbackSafetyRefusal(`the fallback gate for job "${job.id}" was cancelled while its reviewer ran — its findings are not a verdict`);
        }
      } catch (error) {
        if (existsSync(reportFile)) state.reportFiles.push(reportFile);
        if (error instanceof FallbackSafetyRefusal) {
          this.terminalFallbackAborted(job.id, error.message, iteration, [...state.reportFiles], fallbackEvent, state);
          return;
        }
        this.terminalFallbackBlocked(job.id, `bmad-review round ${iteration} failed: ${sanitizeErrorLog(error)}`, iteration, [...state.reportFiles], fallbackEvent, state);
        return;
      }
      state.reportFiles.push(reportFile);
      state.iterations = iteration;
      const triaged = triageFallbackFindings(findings);
      blockers = triaged.blockers.length;
      notes = triaged.notes.length;
      state.blockers = blockers;
      state.notes = notes;
      fallbackEvent({ phase: 'triaged', iteration, blockers, notes, reportFile });
      if (blockers === 0) {
        state.clearToMerge = true;
        fallbackEvent({ phase: 'pass', iteration, notes, reportFile, clearToMerge: true, merge: 'user-held' });
        this.escalate(
          `bmad-review gate PASS for job ${job.id} — review/fix routing cleared (not a Perkins READY; merge stays user-held)`,
          `${notes} note(s) across ${iteration} review round(s). Reports: ${state.reportFiles.join(', ')}`,
          { jobId: job.id },
        );
        return;
      }
      if (iteration === maxRounds) break;
      let delivery: { readonly delivered: boolean; readonly minionId?: string; readonly note?: string };
      try {
        // No fix directive leaves a cancelled gate: the lane's writer now
        // belongs to whoever superseded it.
        if (signal.aborted) {
          throw new FallbackSafetyRefusal(`the fallback gate for job "${job.id}" was cancelled before its fix directive`);
        }
        delivery = await gate.fixDirectiveSink({
          jobId: job.id,
          directive: renderFixDirective(triaged.blockers, iteration),
          blockers: triaged.blockers,
          iteration,
          signal,
        });
      } catch (error) {
        if (error instanceof FallbackSafetyRefusal) {
          this.terminalFallbackAborted(job.id, error.message, iteration, [...state.reportFiles], fallbackEvent, state);
          return;
        }
        this.terminalFallbackBlocked(
          job.id,
          `fix directive for round ${iteration} failed: ${sanitizeErrorLog(error)}`,
          iteration, [...state.reportFiles], fallbackEvent, state,
        );
        return;
      }
      fallbackEvent({
        phase: 'fix-directive', iteration, blockers, delivered: delivery.delivered,
        minionId: delivery.minionId ?? null, note: delivery.note ?? null,
      });
      if (!delivery.delivered) {
        this.terminalFallbackBlocked(
          job.id,
          `fix directive for round ${iteration} could not reach the implementing minion${delivery.note !== undefined ? `: ${delivery.note}` : ''}`,
          iteration, [...state.reportFiles], fallbackEvent, state,
        );
        return;
      }
    }
    this.terminalFallbackBlocked(job.id, `release blockers remain after ${maxRounds} bmad-review rounds`, maxRounds, [...state.reportFiles], fallbackEvent, state);
  }

  /** A superseded gate's terminal record (owner rule 3): routine history
   * with an FYI, never a BLOCKED/ABORTED action-required incident. */
  private terminalFallbackSuperseded(
    jobId: string,
    reason: string,
    iteration: number,
    reports: readonly string[],
    fallbackEvent: (payload: Record<string, unknown>) => void,
    state?: FallbackGateState,
  ): void {
    if (state !== undefined) state.note = `bmad-review gate superseded: ${reason}`;
    fallbackEvent({ phase: 'aborted', iteration, reason: `superseded — ${reason}`, reports, clearToMerge: false, superseded: true });
    this.opts.inform?.(
      `bmad-review gate superseded for job ${jobId}`,
      `An approved change or the lane writer superseded this gate (${reason}). The next candidate gets a fresh review.`,
      { jobId },
    );
  }

  private terminalFallbackBlocked(
    jobId: string,
    reason: string,
    iterations: number,
    reports: readonly string[],
    fallbackEvent: (payload: Record<string, unknown>) => void,
    state?: FallbackGateState,
  ): void {
    if (this.supersededFallbackGates.has(jobId)) {
      this.terminalFallbackSuperseded(jobId, reason, iterations, reports, fallbackEvent, state);
      return;
    }
    if (state !== undefined) {
      state.iterations = iterations;
      state.note = `bmad-review gate blocked: ${reason}`;
    }
    fallbackEvent({ phase: 'blocked', iterations, reason, reports, clearToMerge: false });
    this.escalate(
      `bmad-review gate BLOCKED for job ${jobId}`,
      `${reason}. Reports: ${reports.join(', ')}. Merge is NOT clear; restore the Perkins gate for autonomous gating.`,
      { jobId },
    );
  }

  private terminalFallbackAborted(
    jobId: string,
    reason: string,
    iteration: number,
    reports: readonly string[],
    fallbackEvent: (payload: Record<string, unknown>) => void,
    state?: FallbackGateState,
  ): void {
    if (this.supersededFallbackGates.has(jobId)) {
      this.terminalFallbackSuperseded(jobId, reason, iteration, reports, fallbackEvent, state);
      return;
    }
    if (state !== undefined) state.note = `bmad-review gate aborted: ${reason}`;
    fallbackEvent({ phase: 'aborted', iteration, reason, reports, clearToMerge: false });
    this.escalate(
      `bmad-review gate ABORTED for job ${jobId}`,
      `${reason}. No further review round ran; merge is NOT clear. Restore the Perkins gate for autonomous gating.`,
      { jobId },
    );
  }

  private async defaultFallbackReview(input: FallbackReviewRunInput, recheck?: () => void): Promise<readonly FallbackFinding[]> {
    let lease: PacingLease | null = this.opts.workerGate === undefined ? null : await this.opts.workerGate.acquireWorkerTurn({
      id: input.jobId, label: `fallback review → ${input.jobId}`, jobId: input.jobId, signal: input.signal,
    });
    let handle: AgentHandle | null = null;
    try {
      // The worker-gate wait is an async admission window: re-prove the
      // current facts AFTER the slot is granted and BEFORE the reviewer
      // spawns, so a request or revocation landing in the queue cannot
      // start an obsolete reviewer. The lease releases in the finally on
      // throw.
      if (recheck !== undefined) recheck();
      handle = await this.opts.spawner('minion', { cwd: input.lanePath, signal: input.signal });
      // Spawning is asynchronous too: a newly owned lane must not receive
      // an obsolete review prompt just because the worker was allocated.
      recheck?.();
      // The ledger role is the review-worker role on purpose (Gru ruling
      // 2026-09-29): this session runs ONE review pass and is forbidden
      // from implementation edits, so it must never win an implementer
      // pick (re-brief resume, Silas digest, fix-directive routing).
      this.opts.ledger.registerAgent({
        id: handle.id,
        role: 'perkins',
        label: 'fallback-review',
        sessionFile: handle.sessionFile,
        jobId: input.jobId,
      });
      const prompt = [
        `Read ${input.skillPath} completely and follow it to review the CURRENT working diff of this repository against base ${input.baseRef}.`,
        'This session runs ONE review pass inside a release gate. The host performs triage and every gate decision afterwards: do NOT approve, merge, or gate anything yourself, and do not modify implementation code.',
        `Write your findings as ONE JSON array to exactly this file: ${input.reportFile}`,
        'Each element: { "title": string, "category": string, "location": string, "evidence": string, "detail": string }. Use a release-safety category (correctness, security, data-loss, broken-build, build-failure, crash, regression, vulnerability, injection, secret-leak) only for real release-safety defects; use any other short tag for everything else. An empty array [] is valid.',
        'Then reply DONE.',
        '',
        '--- WORKING DIFF (base → working tree) ---',
        input.diff,
      ].join('\n');
      if (input.signal.aborted) throw new Error('review operation aborted');
      const session = handle;
      let promptError: unknown = null;
      try {
        // The transport wait is a still-running REPORT boundary, never a
        // worker lifetime: a live review turn keeps running on its own
        // session across any number of wait slices (host supervision owns
        // genuine stalls), and each expired slice leaves a durable event so
        // the long wait is observable instead of silent.
        let waitedMs = 0;
        let sliceTimer: ReturnType<typeof setTimeout> | null = null;
        let abortListener: (() => void) | null = null;
        try {
          const settled = new Promise<'settled'>((resolve) => {
            void session.prompt(prompt, { owner: 'bmad-review-gate' }).then(
              () => resolve('settled'),
              (error) => { promptError = error; resolve('settled'); },
            );
          });
          const aborted = new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(new Error('review operation aborted'));
            if (input.signal.aborted) abortListener();
            else input.signal.addEventListener('abort', abortListener, { once: true });
          });
          for (;;) {
            const slice = new Promise<'slice'>((resolve) => {
              sliceTimer = setTimeout(() => resolve('slice'), FALLBACK_REVIEW_TIMEOUT_MS);
              sliceTimer.unref?.();
            });
            let outcome: 'settled' | 'slice';
            try {
              outcome = await Promise.race([settled, aborted, slice]);
            } finally {
              if (sliceTimer !== null) {
                clearTimeout(sliceTimer);
                sliceTimer = null;
              }
            }
            if (outcome === 'settled') break;
            waitedMs += FALLBACK_REVIEW_TIMEOUT_MS;
            const sessionState = session.health().state;
            if (sessionState === 'disposed' || sessionState === 'error') {
              throw new Error(
                `fallback review minion session entered terminal state "${sessionState}" while its review turn was still open`,
              );
            }
            this.log('info', 'fallback review still running at the transport wait — reattaching to the same session', {
              job: input.jobId, iteration: input.iteration, waited_ms: waitedMs,
            });
            this.opts.ledger.appendCustomEvent({
              kind: 'job.fallback-review',
              jobId: input.jobId,
              payload: { gate: true, phase: 'still-running', waited_ms: waitedMs, iteration: input.iteration },
            });
          }
        } finally {
          if (abortListener !== null) input.signal.removeEventListener('abort', abortListener);
        }
      } catch (error) {
        promptError = error;
      } finally {
        // Release before the settlement wait: the retry reacquires the slot.
        lease?.release();
        lease = null;
      }
      const disposition = await settleRetries(this.opts.retrySettlement, handle.id, input.signal);
      if (disposition === 'cancelled') throw new Error('review operation aborted');
      if (disposition === 'exhausted' || disposition === 'superseded') {
        throw new Error(`automatic rate-limit retry ${disposition} before the fallback review delivered`);
      }
      // A rejection whose automatic retry recovered IS the delivery: the
      // report file the retried turn wrote is parsed below; only a
      // rejection with no recovered retry keeps the fail-loud throw.
      if (promptError !== null && disposition !== 'recovered') throw promptError;
    } finally {
      try { await handle?.dispose(); } finally { lease?.release(); }
    }
    return parseFallbackFindingsReport(input.reportFile);
  }

  private async setupRound(input: {
    jobId: string;
    targetRef?: string;
    /** Clean-abort re-arm: the exact delivered head proved at request time;
     * re-proved at the freeze boundary before any lens runs. */
    boundDeliveredSha?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
    force?: boolean;
    evidence?: readonly ReviewEvidenceRequest[];
    /** Prior indexes the implementing minion claimed fixed. */
    claimedFixedPriors?: readonly number[];
    reviewModel?: ReviewPreflightResult['reviewModel'];
    reviewThinkingLevel?: string;
    /** The automatic admission retry this round carries out. */
    admissionRetry?: AdmissionRetry;
  }, setupSignal: AbortSignal): Promise<{ readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }> {
    if (this.shuttingDown || setupSignal.aborted) throw new Error('Perkins review service is shutting down');
    // R7-14: the delivery THIS round reviews — fixed before any await, so a
    // delivery that lands during the probe never becomes a retry's baseline.
    const reviewedDeliverySeq = this.opts.ledger.latestJobEvent(input.jobId, 'job.delivered')?.seq ?? 0;
    const policy = (this.opts.reviewPolicyLoader ?? loadPerkinsPolicy)();
    const job = this.opts.ledger.getJob(input.jobId);
    if (job === null) throw new Error(`job "${input.jobId}" not found — nothing to review`);
    if (isJobTerminal(job.status)) {
      throw new Error(`job "${input.jobId}" is ${job.status} — terminal lanes do not go back under review`);
    }
    const jobWorktree = this.opts.worktrees
      .listWorktrees({ jobId: input.jobId })
      .find((lane) => lane.kind === 'job') ?? null;
    if (jobWorktree === null) {
      throw new Error(`job "${input.jobId}" has no job worktree lane in the registry — the review reads the repo through its job lane`);
    }
    if (job.briefing === null && input.noSpec !== true) {
      throw new Error('complete review requires the job briefing/spec or explicit noSpec=true');
    }
    const canonicalLenses = input.noSpec === true
      ? [...policy.portableContract.rules.noSpecLenses]
      : [...policy.portableContract.rules.fullLenses];
    if (input.lenses !== undefined && input.lenses.length > 0 && input.lenses.join(',') !== canonicalLenses.join(',')) {
      throw new Error('Perkins review lens set is canonical and cannot be reduced or reordered');
    }
    const artifactRoot = this.artifactRoot();
    const candidateRef = input.targetRef ?? jobWorktree.branch ?? jobWorktree.sha;
    const { targetSha, movementRef } = await this.resolveFreezeTarget({
      job,
      jobWorktree,
      candidateRef,
      explicitTarget: input.targetRef !== undefined && input.targetRef.trim() !== '',
    });
    // R8-18: a shutdown during resolution starts nothing — no round, no worktree.
    if (this.shuttingDown || setupSignal.aborted) {
      throw setupSignal.reason instanceof ReviewSupersededError
        ? setupSignal.reason
        : new Error('Perkins review service shut down during review setup');
    }
    const baseRef = resolveReviewBaseRef(jobWorktree.path, job.baseBranch);
    // Effective acceptance + exact-target CI are read AS LATE AS POSSIBLE —
    // immediately before the freeze — so an amendment or CI observation
    // accepted while the review worktree is being created is not silently
    // absent from the round that freezes afterward (owner ruling j-969).
    let spec: string | undefined;
    let acceptance: FreezeReviewInput['acceptance'];
    let ci!: ReturnType<typeof renderRecordedCiEvidence>;
    const assembleReviewInputs = (): void => {
      // Zero amendments render the original briefing bytes exactly — legacy
      // jobs are unaffected.
      const amendments = this.opts.ledger.listJobAmendments(job.id);
      const contract = renderEffectiveContract(job.briefing, amendments);
      spec = contract.text ?? undefined;
      acceptance = undefined;
      // A host-recorded, repo/PR/sha-bound observation is rendered beside
      // the scheduler block; absence/staleness/another repo renders an
      // explicit limitation, never a PASS. The structured record freezes
      // into the manifest even when no spec is supplied (no-spec rounds
      // keep their mode).
      const prIdentity = job.prUrl !== null ? parseGitHubPrUrl(job.prUrl) : null;
      ci = renderRecordedCiEvidence({
        events: {
          branchState: this.opts.ledger.latestJobEvent(job.id, CI_BRANCH_STATE_EVENT),
          ciGreen: this.opts.ledger.latestJobEvent(job.id, CI_GREEN_EVENT),
          ciFailed: this.opts.ledger.latestJobEvent(job.id, CI_FAILED_EVENT),
        },
        targetSha,
        expectedRepo: prIdentity !== null ? `${prIdentity.owner}/${prIdentity.repo}` : null,
        expectedPr: prIdentity?.number ?? null,
      });
      // Recorded verification evidence (2026-09-22 fix): a completed
      // scheduler run on the exact frozen target (clean tree) is handed to
      // the review as ledger-backed context, so the tests lens weighs the
      // host's record over any pasted report. No binding run -> no block.
      if (input.noSpec !== true && spec !== undefined) {
        acceptance = {
          contractText: contract.text as string,
          version: contract.version,
          baseSha256: contract.baseSha256,
          amendmentIds: contract.amendmentIds,
        };
        // R7-5: the newest run BINDING THIS TARGET governs — a newer
        // completed run for a DIFFERENT sha must not erase an older clean
        // run for the reviewed head (and never fabricates one).
        // R8-2 (corrected, j-1594): the KIND-SCOPED history is read in
        // bounded keyset pages over the COMPLETE record with NO lifetime
        // ceiling — a job with more completed runs than one page stays
        // reviewable. The scan stops at the newest binding run; absence is
        // rendered only after the history is exhausted.
        // The iterable is newest-first: the ledger read orders by seq DESC
        // (the selector takes the FIRST binding element, so ordering governs
        // which run is "newest").
        const bindingVerification = selectNewestBoundVerification(
          this.opts.ledger.iterateJobVerificationCompleted(job.id),
          targetSha,
        );
        const evidence = renderRecordedVerification(bindingVerification, targetSha);
        // Verification evidence is ALWAYS explicit (gh-169): a binding run
        // renders its block; no binding run freezes the UNAVAILABLE
        // disclosure — never silence. The absence block that cannot fit
        // refuses the freeze (mirrors the CI omission-notice contract).
        spec = appendRecordedVerification({
          spec,
          evidence,
          log: (level, msg, fields) => this.log(level, msg, { job: job.id, ...fields }),
        });
        spec = appendCiEvidence({
          spec,
          block: ci.block,
          maxBytes: FROZEN_SPEC_MAX_BYTES,
          log: (level, msg, fields) => this.log(level, msg, { job: job.id, ...fields }),
        });
      }
    };
    // Reconcile ownership before creating a replacement round or worktree.
    // Ledger disposal metadata is not runtime cessation proof. A live/pending
    // predecessor may be executing even before its first agent is recorded.
    const predecessor = [...this.opts.ledger.listRounds(job.id)]
      .sort((left, right) => right.seq - left.seq)[0];
    for (const oldRound of this.opts.ledger.listRounds(job.id).filter((candidate) => candidate.status !== 'verdict-posted')) {
      if (oldRound.status === 'pending' || oldRound.status === 'live') {
        throw new Error(`review round ${oldRound.id} still owns this job; reconcile its live owner before replacement`);
      }
      // Head changes invalidate reuse, not writer ownership. The marker
      // precedes registration and must be reconciled even with zero agents.
      const marker = this.reviewOwnerMarker(oldRound);
      const agents = this.opts.ledger.listAgents().filter((entry) => entry.roundId === oldRound.id);
      const receipt = this.opts.ledger.uniqueRoundNoSpawnReceipt(oldRound.id);
      const proof = receipt?.payload as { roundId?: unknown; generation?: unknown; ownerGeneration?: unknown } | null;
      const noSpawn = agents.length === 0 && receipt?.jobId === job.id && receipt.roundId === oldRound.id &&
        proof?.roundId === oldRound.id && validReviewOwnerGeneration(proof.generation) &&
        proof.ownerGeneration === (marker?.generation ?? null) &&
        (marker !== null || this.opts.ledger.latestRoundEvent(oldRound.id, 'round.review-owner') === null) &&
        this.opts.ledger.listRoundSpecialistStarts(oldRound.id).length === 0;
      if (this.opts.ledger.latestRoundEvent(oldRound.id, 'round.review-no-spawn') !== null && !noSpawn) {
        throw new Error(`review round ${oldRound.id} has contradictory or duplicate no-spawn and owner evidence; reconcile ownership manually`);
      }
      if (!noSpawn && marker === null && agents.length === 0) {
        throw new Error(`review round ${oldRound.id} has no trusted no-spawn proof or owner marker; ownership is unknown (including a possible spawn-before-registration crash) — reconcile cessation manually before replacement`);
      }
      if (!noSpawn && marker !== null && agents.length === 0 &&
        await this.opts.reconcileReviewAgent?.('', marker) !== true) {
        throw new Error(`review owner marker from round ${oldRound.id} may still run before agent registration; reconcile runtime cessation before replacement`);
      }
      for (const agent of agents) {
        if (await this.opts.reconcileReviewAgent?.(agent.id, marker) !== true) {
          throw new Error(`review owner ${agent.id} from round ${oldRound.id} may still run; reconcile runtime cessation before starting a replacement writer`);
        }
      }
    }
    const latestAfterReconciliation = [...this.opts.ledger.listRounds(job.id)]
      .sort((left, right) => right.seq - left.seq)[0];
    if (latestAfterReconciliation?.id !== predecessor?.id) {
      throw new Error('review ownership changed during reconciliation; retry after the active round settles');
    }
    const flippedFrom = job.status === 'working' || job.status === 'blocked' ? job.status : null;
    // A setup failure restores `working` as the SAME attempt, never a reopen.
    const attemptStartSeq = flippedFrom === 'working' ? openAttemptStartSeq(this.opts.ledger, job.id) : undefined;
    // R8-18: nor after the reconciliation awaits.
    if (this.shuttingDown || setupSignal.aborted) {
      throw setupSignal.reason instanceof ReviewSupersededError
        ? setupSignal.reason
        : new Error('Perkins review service shut down during review setup');
    }
    // The local admission guard covers this runner's awaited setup. The
    // ledger CAS covers other runner instances (or processes) sharing its
    // database: a replaced predecessor or status cannot mint two writers.
    // R7-10/R8-10: the admission returns this round's OWN provisional
    // status event, read inside its transaction — the restore below undoes
    // exactly it, never a generation a subscriber wrote on publication.
    const { round, flipSeq } = this.opts.ledger.admitReviewRoundWithFlip({
      jobId: job.id, expectedLatestRoundId: predecessor?.id ?? null,
      expectedJobStatus: job.status, lenses: canonicalLenses, targetRef: targetSha,
    });

    let reviewWorktree: Awaited<ReturnType<WorktreePort['createReviewWorktree']>> | undefined;
    let frozenReview: FrozenReview;
    try {
      reviewWorktree = await this.opts.worktrees.createReviewWorktree({
        repoPath: jobWorktree.repoPath,
        roundId: round.id,
        ref: targetSha,
        jobId: job.id,
      });
      if (this.shuttingDown || setupSignal.aborted) {
        throw setupSignal.reason instanceof ReviewSupersededError
          ? setupSignal.reason
          : new Error('Perkins review service shut down during review setup');
      }
      const jobAtFreeze = this.opts.ledger.getJob(job.id);
      if (jobAtFreeze !== null && isJobTerminal(jobAtFreeze.status)) {
        throw new Error(`job "${job.id}" is ${jobAtFreeze.status} — terminal lanes do not go back under review`);
      }
      // Freeze-time close of the race window: a lane may have re-opened
      // between the arm intake and this freeze. The same refusal applies.
      const idle = this.enforceBranchIdle({
        job,
        jobLane: jobWorktree,
        ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
        phase: 'freeze',
        roundId: round.id,
        ...(flippedFrom !== null ? { reviewedStatus: { jobId: job.id, status: flippedFrom } } : {}),
      });
      // A clean-abort re-arm proved ONE delivered head at request time; the
      // awaited pre-flight/capacity/setup window can admit a newer delivery.
      // Re-prove the unchanged-head precondition here, at the last boundary
      // before the freeze, so the round never reviews a superseded head
      // under the clean-abort provenance (the next digest sweep offers the
      // changed-head re-review instead).
      if (input.boundDeliveredSha !== undefined) {
        const deliveredNow = this.opts.ledger.latestJobEvent(job.id, 'job.delivered');
        const shaNow = deliveredNow === null ? null : deliveredTargetSha(deliveredNow);
        if (shaNow !== input.boundDeliveredSha) {
          throw new Error(
            `the clean-abort delivered head moved during review setup (${input.boundDeliveredSha} -> ${shaNow ?? 'none'}) — request the review again`,
          );
        }
      }
      // Late binding: amendments/CI/verification are read NOW, after every
      // await in setup, so the frozen round carries the newest records.
      assembleReviewInputs();
      const runtime = this.opts.reviewRuntimeIdentity?.();
      const model = input.reviewModel;
      if (input.reviewThinkingLevel !== undefined &&
        input.reviewThinkingLevel !== this.opts.reviewThinkingLevel?.()) {
        throw new Error('review thinking level changed since preflight — retry the review request');
      }
      const thinkingLevel = input.reviewThinkingLevel ?? this.opts.reviewThinkingLevel?.();
      // Provider-routing environment is not persistable without risking
      // credential exposure. If it exists, its value could switch the
      // effective model behind an unchanged modelRef: refuse reuse instead.
      const stableProvider = model !== undefined && Object.keys(model.authEnv).every((name) =>
        ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(name)) &&
        runtime !== undefined && publicRecoveryModelIdentity({ runtimeId: runtime.id,
          modelRef: model.modelRef, settingsModel: model.settings.model,
          thinkingLevel, routingSha256: model.routingSha256 });
      const recoveryIdentity = runtime !== undefined && runtime.id !== '' && runtime.version !== '' &&
        stableProvider && model !== undefined && model.modelRef !== '' && model.modelRef !== 'default'
        ? {
            jobId: job.id,
            policySha256: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
            runtimeId: runtime.id, runtimeVersion: runtime.version,
            modelRef: model.modelRef, modelRole: model.role,
            // Never persist or hash credential values or auth environment.
            modelSettingsSha256: createHash('sha256').update(JSON.stringify({
              model: model.settings.model ?? null,
              thinkingLevel: thinkingLevel ?? null,
              routingSha256: model.routingSha256 ?? null,
            })).digest('hex'),
          } : undefined;
      frozenReview = freezeReviewInputs({
        roundId: round.id,
        ...(recoveryIdentity !== undefined ? { recoveryIdentity } : {}),
        repoPath: reviewWorktree.path,
        artifactRoot,
        baseRef,
        targetRef: targetSha,
        movementRef,
        ...(input.noSpec === true ? { noSpec: true } : { spec }),
        jobId: job.id,
        ...(acceptance !== undefined ? { acceptance } : {}),
        ...(input.evidence !== undefined && input.evidence.length > 0 ? { evidence: input.evidence } : {}),
        ...(this.opts.evidenceUploadsDir !== undefined ? { evidenceUploadsDir: this.opts.evidenceUploadsDir } : {}),
        ciEvidence: ci.record,
        ...(input.force === true
          ? { branchIdle: { forced: true as const, targetBranch: idle.targetBranch, blockers: idle.blockers } }
          : {}),
      });
      // Frozen-input audit trail: metadata hashes/provenance only (no
      // pixels, no upload paths, no contract body duplication).
      this.opts.ledger.appendCustomEvent({
        kind: 'round.review-inputs-frozen',
        jobId: job.id,
        roundId: round.id,
        payload: {
          acceptance: frozenReview.manifest.acceptance ?? null,
          evidence: (frozenReview.manifest.reviewEvidence?.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            purpose: attachment.purpose,
            media_type: attachment.mediaType,
            bytes: attachment.bytes,
            sha256: attachment.sha256,
            consent_ref: attachment.consentRef,
          })),
          ci: frozenReview.manifest.reviewEvidence?.ci ?? null,
        },
      });
      // The manifest's self-declared hashes are not its authority: pin the
      // exact frozen bytes independently in the append-only ledger before
      // any specialist can create reusable checkpoint evidence.
      this.opts.ledger.appendCustomEvent({
        kind: 'round.freeze-manifest', jobId: job.id, roundId: round.id,
        payload: { sha256: createHash('sha256').update(readFileSync(join(frozenReview.directory, 'manifest.json'))).digest('hex') },
      });
      // Durable runtime provenance BEFORE any lead/child may spawn. The
      // generation binds same-process adapter cessation; a restarted Pi
      // service may instead prove its old in-process host PID has exited.
      if (runtime?.id === 'pi' || runtime?.id === 'claude-code') {
        this.opts.ledger.appendCustomEvent({
          kind: 'round.review-owner', jobId: job.id, roundId: round.id,
          payload: { roundId: round.id, targetSha, runtimeId: runtime.id,
            pid: process.pid, generation: randomUUID() },
        });
      }
      // ADMISSION PREFLIGHT (gh-169 Stage 4): validate the complete frozen
      // packet read-only — head binding, every declared artifact digest,
      // evidence bytes, CI record, verification section — BEFORE the run
      // promise exists and before any lead or child can spawn. A refusal
      // names every missing input precisely and aborts the round without
      // spawn (the setup catch's no-spawn path); a pass is recorded with
      // its full check list so the admission evidence is durable. The
      // freeze observer (test instrumentation) sees the packet first.
      this.opts.reviewFreezeObserver?.(frozenReview);
      // R4-6: the advertised-tip remote probe runs OFF the event loop —
      // a stalled remote awaits here without blocking unrelated service
      // work, then its fail-closed outcome is injected into the preflight.
      const precomputedRemoteMovement = await probeAdvertisedTipMovementAsync(
        frozenReview, ADMISSION_REMOTE_PROBE_TIMEOUT_MS,
      );
      // R8-3: the UNIQUE freeze receipt with full identity validation — a
      // duplicate or conflicting receipt refuses under the manifest's name
      // instead of trusting whichever the latest-event lookup returned.
      const uniqueReceipt = this.opts.ledger.uniqueRoundFreezeManifestReceipt(round.id);
      const receiptPayload = uniqueReceipt?.payload as { readonly sha256?: unknown } | null;
      const receiptValid = uniqueReceipt !== null && uniqueReceipt.jobId === job.id &&
        uniqueReceipt.roundId === round.id && typeof receiptPayload?.sha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(receiptPayload.sha256);
      // The read-only preflight runs synchronously, so nothing in this
      // service can change between it and the branch recheck below.
      const admission = admissionPreflight(frozenReview, movementRef, {
        precomputedRemoteMovement,
        frozenManifestReceiptRequired: true,
        ...(receiptValid ? { frozenManifestSha256: (uniqueReceipt!.payload as { sha256: string }).sha256 } : {}),
      });
      // R9-6: a git step that would not stop is refused and escalated
      // naming its group FIRST — a branch that turned busy meanwhile never
      // masks it. Any other outcome takes the busy check before admission
      // records anything.
      if (!admission.missing.some((entry) => entry.cleanupUnconfirmed === true)) {
        // R8-16: work that made the branch busy DURING the probe stops the
        // review before any admission effect — the same shared predicate as
        // the freeze. A forced round's audited blockers stay authorized; a new
        // one never is.
        const recheck = {
          job,
          jobLane: jobWorktree,
          ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
          phase: 'freeze' as const,
          roundId: round.id,
          ...(flippedFrom !== null ? { reviewedStatus: { jobId: job.id, status: flippedFrom } } : {}),
        };
        // Unforced: the ordinary refusal (audited). Forced: its audit already
        // stands — only a blocker it never covered is refused (audited below).
        const afterProbe = input.force === true ? this.branchIdleBlockers(recheck) : this.enforceBranchIdle(recheck);
        // A pending material correction is never covered by a force audit
        // (owner rule 2), even on a job whose other busy fact was audited.
        const unaudited = afterProbe.blockers.filter((blocker) => blocker.revision !== undefined ||
          !idle.blockers.some((audited) => audited.jobId === blocker.jobId));
        if (unaudited.length > 0) {
          this.opts.ledger.appendCustomEvent({
            kind: 'branch-idle.refused', jobId: job.id, roundId: round.id,
            payload: { phase: 'freeze', forced: false, targetBranch: afterProbe.targetBranch, blockers: unaudited },
          });
          throw new BranchBusyError(afterProbe.targetBranch, unaudited, 'freeze');
        }
        // Owner rule 3: a setup superseded while it awaited (an approved
        // material change, or a writer that owns the lane) withdraws here,
        // before any admission effect — the rollback below unwinds it.
        if (setupSignal.reason instanceof ReviewSupersededError) throw setupSignal.reason;
      }
      this.opts.ledger.appendCustomEvent({
        kind: 'round.admission-preflight',
        jobId: job.id,
        roundId: round.id,
        payload: {
          ok: admission.missing.length === 0,
          checks: admission.checks,
          ...(admission.missing.length > 0 ? { missing: admission.missing } : {}),
        },
      });
      if (admission.missing.length > 0) throw this.refuseAdmission(round.id, input, admission.missing, reviewedDeliverySeq);
    } catch (error) {
      const failures: unknown[] = [error];
      const interrupted = this.shuttingDown || setupSignal.aborted;
      // Owner rule 3: a superseded setup is withdrawn, not a shutdown.
      const superseded = setupSignal.reason instanceof ReviewSupersededError;
      try {
        if (interrupted) {
          const note = superseded
            ? 'review setup withdrawn: an approved material change or the lane writer superseded this candidate'
            : 'review setup interrupted by service shutdown; frozen proof is incomplete';
          this.opts.ledger.abortReviewSetupWithoutSpawn(round.id);
          const artifacts = this.writeInterruptedArtifacts(round.id, superseded ? 'superseded' : 'service_shutdown_setup', note);
          this.opts.ledger.appendCustomEvent({
            kind: 'round.perkins-incomplete',
            jobId: job.id,
            roundId: round.id,
            payload: {
              reason: superseded ? 'superseded' : 'service_shutdown_setup',
              artifactDirectory: artifacts.directory,
              reportFile: artifacts.reportFile,
            },
          });
        } else {
          // The immutable negative receipt and abort commit together. A
          // failure after the owner marker is never eligible for this proof.
          this.opts.ledger.abortReviewSetupWithoutSpawn(round.id);
        }
      } catch (proofError) {
        failures.push(proofError);
      }
      if (reviewWorktree !== undefined) {
        try {
          await this.sweepReviewWorktree(reviewWorktree.id);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (flippedFrom !== null && !isJobTerminal(this.opts.ledger.getJob(job.id)?.status ?? job.status)) {
        try {
          this.opts.ledger.restoreReviewSetupStatus({
            jobId: job.id, roundId: round.id, priorStatus: flippedFrom,
            ...(attemptStartSeq !== undefined ? { attemptStartSeq } : {}),
            ...(flipSeq !== null ? { expectedStatusSeq: flipSeq } : {}),
          });
        } catch (restoreError) {
          failures.push(restoreError);
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'review setup rollback failed');
      throw error;
    }

    if (this.opts.reserveReviewRound !== undefined) {
      this.opts.ledger.appendCustomEvent({
        kind: 'round.residency-queued', jobId: job.id, roundId: round.id,
        payload: { reason: 'awaiting lead and child resident slots', targetSha },
      });
    }
    this.log('info', 'review round queued or live', {
      job: job.id,
      round: round.id,
      lenses: canonicalLenses.length,
      targetRef: targetSha,
      workflow: 'perkins-whole-pr',
    });
    const runController = new AbortController();
    const run = this.trackReview(
      job.id,
      'perkins',
      round.id,
      (async (): Promise<WaveOutcome> => {
        const outcome = await this.runBuiltInReview(
          job,
          round,
          canonicalLenses,
          reviewWorktree.id,
          movementRef,
          input.noSpec === true,
          frozenReview,
          policy,
          runController.signal,
          input.reviewModel,
          input.claimedFixedPriors,
        );
        // Stage-5 convergence: a delta round that posted READY still owes
        // the final whole-change pass. Chain it NOW, after this round's
        // cleanup, so approval is only ever credited by a whole-scope
        // round; a crash between the rounds leaves finalPassRequired
        // durable and the board's owner-ready gate stays closed.
        if (outcome.finalPass?.required !== true || runController.signal.aborted || this.shuttingDown) return outcome;
        try {
          const next = await this.beginPerkinsRound({
            jobId: input.jobId,
            targetRef: outcome.finalPass.targetSha,
            ...(input.noSpec === true ? { noSpec: true } : {}),
            ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
            ...(input.reviewModel !== undefined ? { reviewModel: input.reviewModel } : {}),
            ...(input.reviewThinkingLevel !== undefined ? { reviewThinkingLevel: input.reviewThinkingLevel } : {}),
          });
          return await next.run;
        } catch (error) {
          const detail = `final whole-change pass for ${outcome.finalPass.targetSha} could not run: ${String(error)}`
            .replace(/[\r\n]+/gu, ' ').slice(0, 500);
          this.log('error', 'the Stage-5 final whole-change pass could not run; approval stays gated', {
            round: round.id, error: detail,
          });
          try {
            this.opts.ledger.appendCustomEvent({
              kind: 'round.final-pass-failed', jobId: input.jobId, roundId: round.id,
              payload: { targetSha: outcome.finalPass.targetSha, error: detail },
            });
          } catch {
            // The escalation below still carries the durable fact.
          }
          // R7-16/R8-25: a refusal of the pass was already notified (and,
          // when transient, retries on its own).
          if (!alreadyNotified(error)) {
            this.escalate(
              `Perkins delta READY for job ${input.jobId} still owes its final whole-change pass`,
              `${detail}. The delta round stays recorded, but no approval can be credited until a whole-scope round closes at this target.`,
              { jobId: input.jobId, roundId: round.id },
            );
          }
          return outcome;
        }
      })(),
      runController,
    );
    return { round, run };
  }

  /** Resolve the exact SHA a round will freeze. A round reviewing a PR
   * branch reads the PR's own head branch from the code host and fetches
   * that branch from origin — the caller's candidate ref (for a default arm
   * the lane branch `gru/<jobId>`, for an explicit target whatever the
   * caller named) is a hint only, never the freeze source, so a job lane
   * that never pushed its own name cannot fail the round and a stale lane
   * can never be frozen. The fetched tip must equal the live PR head, or
   * the request aborts before a round row, a review worktree, or any lens
   * exists. Non-PR rounds and explicit commit pins keep the local
   * resolution. */
  /** The full ref name a candidate resolves to LOCALLY (shared ref store),
   * or null when nothing resolves (an unresolved spelling or an ambiguous
   * lookup — both stay on the remote route, where the fetch is the safe
   * arm). Used to distinguish an intentional local pin such as
   * refs/tags/origin/v1 from an unresolved origin/<branch> spelling
   * (Perkins R5). */
  private resolvedLocalRefName(repoPath: string, ref: string): string | null {
    const result = spawnSync('git', ['-C', repoPath, 'rev-parse', '--symbolic-full-name', '--verify', ref], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const name = result.status === 0 ? (result.stdout ?? '').trim() : '';
    return name === '' ? null : name;
  }

  /** True when origin currently advertises a branch by that name — the
   * SHORT-spelling collision bit (Perkins r6 B2). Read-only, bounded; a
   * failed probe reports a collision (the remote route — PR-head
   * verification or the manager's fetch — is the safe arm either way). */
  private originHasBranch(repoPath: string, branch: string): boolean {
    const result = spawnSync('git', ['-C', repoPath, 'ls-remote', '--refs', 'origin', `refs/heads/${branch}`], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    if (result.status !== 0) return true;
    return (result.stdout ?? '').trim() !== '';
  }

  private async resolveFreezeTarget(input: {
    job: { readonly id: string; readonly prUrl: string | null };
    jobWorktree: { readonly path: string; readonly repoPath: string };
    candidateRef: string;
    /** True when the caller explicitly named `candidateRef` (target_ref). */
    explicitTarget: boolean;
  }): Promise<{ readonly targetSha: string; readonly movementRef: string }> {
    const candidateBranch = input.job.prUrl === null
      ? null
      : prBranchCandidate(input.jobWorktree.repoPath, input.candidateRef);
    // An EXACT origin branch spelling is NEVER an explicit pin (Perkins
    // R3/R5): a remote-only origin/topic is invisible to prBranchCandidate
    // (nothing local resolves), but it still names a REMOTE BRANCH, and
    // the manager fetches that spelling — letting it through as a "pin"
    // would bypass PR-head verification and freeze unrelated bytes for a
    // linked PR. Origin-prefixed REVISION EXPRESSIONS (origin/main~1) are
    // the opposite case (Perkins R4): they ARE pins — a real branch name
    // cannot carry their operators — and must resolve to the NAMED
    // ancestor, never the live PR tip nor a literal branch named "main~1".
    // True explicit pins — SHAs, tags, revision expressions like HEAD~1 —
    // stay pins even for a PR round; everything else on a PR-linked job
    // resolves from the PR's live head branch.
    const namesOriginRef = isExactOriginBranchSpelling(input.candidateRef);
    // A locally RESOLVED origin-prefixed ref that is neither a branch nor
    // an origin tracking ref — a tag like refs/tags/origin/v1 — is an
    // INTENTIONAL pin when the caller was FULLY QUALIFIED (refs/tags/…)
    // or when the remote has NO branch by that name (Perkins R5/r6 B2):
    // a SHORT spelling (origin/topic) whose name COLLIDES with a real
    // remote branch means the REMOTE branch — pinning the local tag
    // there would bypass PR-head verification and freeze unrelated
    // bytes. A tracking-ref resolution is NOT a pin (the stale-local
    // shape the fetch exists to defeat), and only an UNRESOLVED origin
    // spelling follows the live remote branch. (Ambiguous lookups and
    // collision-probe failures both stay on the remote route — the
    // fetch/PR verification is the safe arm.)
    const resolvedName = namesOriginRef
      ? this.resolvedLocalRefName(input.jobWorktree.repoPath, input.candidateRef)
      : null;
    const resolvedNonBranchRef =
      resolvedName !== null &&
      !resolvedName.startsWith('refs/remotes/origin/') &&
      !resolvedName.startsWith('refs/heads/');
    const fullyQualifiedPin = input.candidateRef.startsWith('refs/');
    const shortSpellingCollides =
      namesOriginRef &&
      !fullyQualifiedPin &&
      this.originHasBranch(input.jobWorktree.repoPath, input.candidateRef.replace(ORIGIN_REF_SPELLING, ''));
    const resolvedOriginPin = resolvedNonBranchRef && !shortSpellingCollides;
    const explicitPin =
      input.explicitTarget && candidateBranch === null && (!namesOriginRef || resolvedOriginPin);
    if (input.job.prUrl === null || explicitPin) {
      // UNRESOLVED origin-branch spellings resolve through the manager's
      // fetch-before-freeze discipline (Perkins R3 lineage): FETCHED
      // fresh — never the stale local tracking sha — and an unfetchable
      // one refuses BEFORE any round row, review lane, or freeze exists.
      // Tracking refs live in the SHARED ref store, so resolving from
      // the host repo is equivalent to the lane. Locally resolved pins —
      // tags, shas, revision expressions, lane branches — resolve from
      // the ACTIVE JOB LANE (Perkins R3): worktree-relative refs like
      // HEAD are PER-WORKTREE and must never resolve against the host
      // checkout; branches, tags, and shas are shared and resolve
      // identically from the lane.
      if (namesOriginRef && !resolvedOriginPin) {
        const resolved = await this.opts.worktrees.resolveReviewTarget({
          repoPath: input.jobWorktree.repoPath,
          ref: input.candidateRef,
        });
        return {
          targetSha: resolved.sha,
          movementRef: input.candidateRef,
        };
      }
      return {
        targetSha: resolveGitCommit(input.jobWorktree.path, input.candidateRef),
        movementRef: input.candidateRef,
      };
    }
    try {
      const fresh = await resolveFreshPrHead({
        repoPath: input.jobWorktree.repoPath,
        prUrl: input.job.prUrl,
        // A remote-only origin ref carries its branch name in the spelling
        // — recover the hint prBranchCandidate could not see locally.
        branchRef:
          candidateBranch ??
          (namesOriginRef ? input.candidateRef.replace(ORIGIN_REF_SPELLING, '') : ''),
        ...(this.opts.prHeadProbe !== undefined ? { probe: this.opts.prHeadProbe } : {}),
      });
      this.log('info', 'freeze target refreshed from the live PR head', {
        job: input.job.id,
        branch: fresh.prHeadRefName,
        localCandidate: input.candidateRef,
        fetched: fresh.targetSha,
        movementRef: fresh.movementRef,
      });
      return { targetSha: fresh.targetSha, movementRef: fresh.movementRef };
    } catch (error) {
      if (error instanceof PrHeadVerificationError) {
        const detail = error.message.replace(/[\r\n]+/gu, ' ').slice(0, 1000);
        this.opts.ledger.appendCustomEvent({
          kind: 'job.review-freeze-blocked',
          jobId: input.job.id,
          payload: {
            code: error.code,
            prUrl: input.job.prUrl,
            branchRef: candidateBranch,
            candidateRef: input.candidateRef,
            detail,
          },
        });
        this.escalate(
          `Perkins review for job ${input.job.id} was blocked before any round: the PR head could not be verified`,
          detail,
          { jobId: input.job.id },
        );
        throw markNotified(error);
      }
      throw error;
    }
  }

  private async runBuiltInReview(
    job: { readonly id: string; readonly prUrl: string | null },
    round: RoundRecord,
    lenses: readonly PerkinsLens[],
    reviewLaneId: string,
    movementRef: string,
    noSpec: boolean,
    frozenReview: FrozenReview,
    policy: PerkinsPolicy,
    signal: AbortSignal,
    reviewModel?: ReviewPreflightResult['reviewModel'],
    claimedFixedPriors?: readonly number[],
  ): Promise<WaveOutcome> {
    let reservation: ResidentReviewRound | undefined;
    let settledOutcome: WaveOutcome | null = null;
    let spawnInitiated = false;
    const beginSpawn = (): void => {
      if (!spawnInitiated) {
        // Commit the owner boundary before invoking a spawner: a rejected
        // spawn may already have created an unregistered writer.
        this.opts.ledger.setRoundStatus(round.id, 'live');
        spawnInitiated = true;
      }
    };
    try {
      reservation = this.opts.reserveReviewRound === undefined
        ? undefined : await this.opts.reserveReviewRound(signal);
      if (reservation !== undefined) {
        if (signal.aborted) {
          await reservation.close();
          throw new Error('review cancelled before admission');
        }
        this.opts.ledger.appendCustomEvent({
          kind: 'round.residency-admitted', jobId: job.id, roundId: round.id,
          payload: { reason: 'lead and child resident slots admitted' },
        });
      }
      const outcome = await this.runOwnedReview(job, round, lenses, movementRef, noSpec, frozenReview, policy, signal, reviewModel, beginSpawn, () => spawnInitiated, reservation, claimedFixedPriors);
      settledOutcome = outcome;
      return outcome;
    } catch (error) {
      if (this.opts.ledger.getRound(round.id)?.status === 'pending') {
        if (spawnInitiated) {
          // Never invent a negative receipt after the owner may have spawned.
          this.abortRound(this.opts.ledger.getRound(round.id) ?? round, `review admission cancelled: ${String(error)}`);
        } else {
          // The guarded receipt and abort commit together, or leave the
          // uncertain owner pending for explicit reconciliation.
          this.opts.ledger.abortReviewSetupWithoutSpawn(round.id);
        }
        this.opts.ledger.appendCustomEvent({
          kind: 'round.residency-cancelled', jobId: job.id, roundId: round.id,
          payload: { error: String(error) },
        });
      }
      throw error;
    } finally {
      // A settled review outcome outranks a close-time disposal failure:
      // the verdict/record is the durable truth; the failed disposal is
      // escalated loudly without masking the returned result.
      try {
        await reservation?.close();
      } catch (closeError) {
        this.log('error', 'review reservation disposal failed', { round: round.id, error: String(closeError) });
        if (settledOutcome !== null) {
          this.escalate(
            `Review round ${round.id} disposal failed after completion`,
            `The settled review outcome was preserved, but releasing its resident handles failed: ${String(closeError)}`,
            { jobId: job.id, roundId: round.id },
          );
        }
      } finally {
        await this.sweepReviewWorktree(reviewLaneId);
      }
    }
  }

  private async runOwnedReview(
    job: { readonly id: string; readonly prUrl: string | null },
    round: RoundRecord,
    lenses: readonly PerkinsLens[],
    movementRef: string,
    noSpec: boolean,
    frozenReview: FrozenReview,
    policy: PerkinsPolicy,
    signal: AbortSignal,
    reviewModel: ReviewPreflightResult['reviewModel'] | undefined,
    beginSpawn: () => void,
    spawnInitiated: () => boolean,
    reservation?: ResidentReviewRound,
    claimedFixedPriors?: readonly number[],
  ): Promise<WaveOutcome> {
    // The model-resolution closure belongs to one round. A concurrent
    // preflight cannot replace the proof used by its lead or specialist
    // children, and a reserved round routes through its own admission.
    const owner = this.reviewOwnerMarker(round);
    const frozenThinking = this.opts.reviewThinkingLevel?.();
    if (frozenReview.manifest.recoveryIdentity !== null && reviewModel !== undefined &&
      createHash('sha256').update(JSON.stringify({
        model: reviewModel.settings.model ?? null, thinkingLevel: frozenThinking ?? null,
        routingSha256: reviewModel.routingSha256 ?? null,
      })).digest('hex') !== frozenReview.manifest.recoveryIdentity.modelSettingsSha256) {
      throw new Error('review thinking/model settings changed since freeze — a new review is required');
    }
    const spawnWithOptions: AgentSpawner = (role, options) => {
      if (frozenThinking !== undefined && this.opts.reviewThinkingLevel?.() !== frozenThinking) {
        throw new Error('review thinking level changed since freeze — a new review is required');
      }
      if (reservation !== undefined && role !== 'perkins') {
        throw new Error(`review reservation spawns perkins sessions only, got role "${role}"`);
      }
      const resolved = {
        ...options,
        ...(frozenThinking !== undefined ? { thinkingLevel: frozenThinking } : {}),
        ...(owner !== null && (options?.isolatedReview !== undefined || options?.reviewLead !== undefined)
          ? { reviewOwnerGeneration: owner.generation } : {}),
        ...(reviewModel !== undefined && (options?.isolatedReview !== undefined || options?.reviewLead !== undefined)
          ? { reviewModel } : {}),
      };
      beginSpawn();
      return reservation === undefined
        ? this.opts.spawner(role, resolved)
        : reservation.spawn(resolved);
    };
    const workflow = new PerkinsWholeReview({
      spawner: spawnWithOptions,
      ...(reservation !== undefined ? { beginChildren: () => reservation.beginChildren(this.opts.maxConcurrentChildren ?? DEFAULT_REVIEW_CHILDREN) } : {}),
      ...(this.opts.maxConcurrentChildren !== undefined ? { maxConcurrentChildren: this.opts.maxConcurrentChildren } : {}),
      ...(this.opts.reviewGate !== undefined ? { reviewGate: this.opts.reviewGate } : {}),
      rateLimitBackoff: this.opts.rateLimitBackoff ?? null,
      recordPacing: (event) => this.opts.ledger.appendCustomEvent({
        kind: event.kind, jobId: job.id, roundId: round.id, agentId: event.agentId ?? null, payload: event.payload,
      }),
      policy,
      recordSpecialistStart: (lens, attempt, originRoundId = round.id) => {
        this.opts.ledger.appendCustomEvent({
          kind: 'round.specialist-started', jobId: job.id, roundId: round.id,
          payload: { lens, attempt, originRoundId },
        });
      },
      recordSpecialistSettlement: (lens, attempt, sha256) => {
        this.opts.ledger.appendCustomEvent({
          kind: 'round.specialist-settled', jobId: job.id, roundId: round.id,
          payload: { lens, attempt, sha256 },
        });
      },
      onAgent: ({ phase, lens, attempt, handle }) => {
        this.opts.ledger.registerAgent({
          id: handle.id,
          role: 'perkins',
          label:
            phase === 'specialist' && lens !== undefined
              ? lensAgentLabel(lens, attempt ?? 1)
              : 'lead',
          sessionFile: handle.sessionFile,
          roundId: round.id,
          jobId: job.id,
        });
        if (phase === 'specialist' && lens !== undefined) this.opts.ledger.markLensLive(round.id, lens);
      },
    });

    let review: PerkinsWholeResult;
    try {
      // The NEWEST completed predecessor is the required prior record: a
      // missing or corrupt consolidated file for it fails loudly instead of
      // silently presenting an older past as the whole history. A
      // restart-PROMOTED round (round.post-recovered, no round.perkins-review)
      // is just as conclusive and must never be skipped for an older whole
      // record: its own posted review state and blockers are accounted for.
      let priorConsolidatedFile: string | undefined;
      const newestPredecessor = this.opts.ledger
        .listRounds(job.id)
        .filter((candidate) =>
          candidate.seq < round.seq && candidate.status === 'verdict-posted' && candidate.verdict !== null &&
          (this.opts.ledger.latestRoundEvent(candidate.id, 'round.perkins-review') !== null ||
            this.opts.ledger.latestRoundEvent(candidate.id, 'round.post-recovered') !== null),
        )
        .sort((left, right) => right.seq - left.seq)[0];
      if (newestPredecessor !== undefined) {
        const file = join(reviewArtifactDirectory(this.artifactRoot(), newestPredecessor.id), 'consolidated.json');
        if (newestPredecessor.targetRef === null || !this.isCompleteConsolidated(file, newestPredecessor.targetRef)) {
          throw new Error(
            `required prior review record for round ${newestPredecessor.id} is missing or invalid; ` +
            'refusing to review against a partial history — restore the record, then rerun the review',
          );
        }
        priorConsolidatedFile = file;
      }
      // Content identity may span several interrupted round ids. Take all
      // compatible owners since the last posted verdict so a second crash
      // DURING checkpoint copying cannot erase a previously charged start.
      const history = this.opts.ledger.listRounds(job.id)
        .filter((candidate) => candidate.seq < round.seq)
        .sort((left, right) => right.seq - left.seq);
      const postedIndex = history.findIndex((candidate) => candidate.status === 'verdict-posted');
      const interrupted = history.slice(0, postedIndex === -1 ? undefined : postedIndex);
      const candidates: { round: RoundRecord; directory: string; manifestSha256: string; baseRefSha: string }[] = [];
      for (const candidate of interrupted) {
        // A changed, unknown or tampered intermediate round breaks the
        // lineage. Never jump past it to credit an older compatible round.
        if (candidate.status !== 'aborted') break;
        const directory = reviewArtifactDirectory(this.artifactRoot(), candidate.id);
        const freeze = this.opts.ledger.uniqueRoundFreezeManifestReceipt(candidate.id);
        const pinned = freeze?.payload as { sha256?: unknown } | null;
        if (freeze?.jobId !== job.id || freeze.roundId !== candidate.id ||
          typeof pinned?.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(pinned.sha256)) break;
        if (!compatibleReviewIdentity(frozenReview, directory, pinned.sha256)) break;
        const manifestBytes = readReviewCheckpointBytes(directory, 'manifest.json', FROZEN_MANIFEST_MAX_BYTES);
        if (createHash('sha256').update(manifestBytes).digest('hex') !== pinned.sha256) break;
        const priorBase = (JSON.parse(manifestBytes.toString('utf8')) as { baseRefSha?: unknown }).baseRefSha;
        if (typeof priorBase !== 'string' || !/^[a-f0-9]{40}$/u.test(priorBase)) break;
        candidates.push({ round: candidate, directory, manifestSha256: pinned.sha256, baseRefSha: priorBase });
      }
      const recoveredBaseTips = [...new Set(candidates
        .map((candidate) => candidate.baseRefSha)
        .filter((tip) => tip !== frozenReview.manifest.baseRefSha))];
      if (recoveredBaseTips.length > 0) {
        try {
          proveRecoveredBaseMergeability(frozenReview, recoveredBaseTips);
        } catch {
          // Charged starts survive, but conflicting/uncertain bases cannot
          // supply specialist credit. A fresh lead may still review anew.
          candidates.length = 0;
        }
      }
      let recoveryDirectory: string | undefined;
      let recoveryStarts: { lens: PerkinsLens; attempt: 1 | 2; originRoundId: string }[] | undefined;
      let recoverySources: { lens: PerkinsLens; attempt: 1 | 2; directory: string; manifestSha256: string; sha256?: string }[] | undefined;
      // Starts are independent ledger charges, even if the output manifest
      // is gone, forged, or belongs to a different model. Only output reuse
      // depends on compatible frozen evidence.
      const chargedRounds = interrupted.filter((candidate) =>
        candidate.status === 'aborted' && candidate.targetRef === frozenReview.manifest.targetSha);
      if (chargedRounds.length > 0) {
        const startsByRound = chargedRounds.map((round) => {
          const matching = candidates.find((entry) => entry.round.id === round.id);
          const directory = matching?.directory ?? frozenReview.directory;
          const manifestSha256 = matching?.manifestSha256 ?? '';
          const events = this.opts.ledger.listRoundSpecialistStarts(round.id);
          if (events.length > 16) throw new Error(`review round ${round.id} exceeds the 16-run specialist cap`);
          const starts = events.map((event) => {
            const payload = event.payload as { lens?: unknown; attempt?: unknown; originRoundId?: unknown } | null;
            if (payload === null || typeof payload !== 'object' ||
              !lenses.includes(payload.lens as PerkinsLens) || (payload.attempt !== 1 && payload.attempt !== 2)) {
              throw new Error(`review round ${round.id} has an invalid charged specialist start event`);
            }
            const originRoundId = payload.originRoundId ?? round.id;
            if (typeof originRoundId !== 'string' ||
              !this.opts.ledger.listRounds(job.id).some((entry) => entry.id === originRoundId && entry.seq <= round.seq)) {
              throw new Error(`review round ${round.id} has an invalid charged specialist origin`);
            }
            return { lens: payload.lens as PerkinsLens, attempt: payload.attempt as 1 | 2, originRoundId };
          });
          if (new Set(starts.map((start) => `${start.lens}-${start.attempt}`)).size !== starts.length) {
            throw new Error(`review round ${round.id} has duplicate charged specialist starts`);
          }
          return { round, directory, manifestSha256, starts };
        });
        const allStarts = new Map<string, { lens: PerkinsLens; attempt: 1 | 2; originRoundId: string }>();
        for (const candidate of startsByRound) {
          for (const start of candidate.starts) {
            const key = `${start.lens}-${start.attempt}`;
            const previous = allStarts.get(key);
            if (previous !== undefined && previous.originRoundId !== start.originRoundId) {
              throw new Error(`specialist ${key} has independently charged starts from multiple rounds; attempt budget is ambiguous — reconcile before replacement`);
            }
            allStarts.set(key, start);
          }
        }
        recoveryStarts = [...allStarts.values()].sort((left, right) =>
          left.attempt - right.attempt || left.lens.localeCompare(right.lens));
        if (recoveryStarts.length > 16) throw new Error('recovered lineage exceeds the 16-run specialist cap');
        const sources = startsByRound.map((candidate) => {
          const settlements = this.opts.ledger.listRoundSpecialistSettlements(candidate.round.id).map((event) => {
            const payload = event.payload as { lens?: unknown; attempt?: unknown; sha256?: unknown } | null;
            if (payload === null || typeof payload !== 'object' ||
              !lenses.includes(payload.lens as PerkinsLens) || (payload.attempt !== 1 && payload.attempt !== 2) ||
              typeof payload.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.sha256)) {
              throw new Error(`review round ${candidate.round.id} has an invalid settled specialist receipt`);
            }
            return { lens: payload.lens as PerkinsLens, attempt: payload.attempt, sha256: payload.sha256 };
          });
          const digests = new Map(settlements.map((entry) => [`${entry.lens}-${entry.attempt}`, entry.sha256]));
          if (digests.size !== settlements.length) {
            throw new Error(`review round ${candidate.round.id} has duplicate settled specialist receipts`);
          }
          return { ...candidate, digests,
            verified: new Map(verifiedSpecialistCheckpointResults(candidate.directory, lenses, digests,
              candidate.starts.map((start) => `${start.lens}-${start.attempt}`))
              .map((result) => [result.key, result.status] as const)) };
        });
        recoveryDirectory = frozenReview.directory;
        const currentManifestSha256 = createHash('sha256').update(readFileSync(join(frozenReview.directory, 'manifest.json'))).digest('hex');
        recoverySources = recoveryStarts.map((start) => {
          const stem = `${start.lens}-${start.attempt}`;
          const chargedHere = (entry: (typeof sources)[number]) => entry.starts.some((item) =>
            item.lens === start.lens && item.attempt === start.attempt);
          const source = sources.find((entry) => entry.manifestSha256 !== '' && chargedHere(entry) && entry.verified.get(stem) === 'valid') ??
            sources.find((entry) => entry.manifestSha256 !== '' && chargedHere(entry) && entry.verified.has(stem));
          if (source === undefined) return { ...start, directory: frozenReview.directory, manifestSha256: currentManifestSha256 };
          const sha256 = source.digests.get(stem);
          return { ...start, directory: source.directory, manifestSha256: source.manifestSha256,
            ...(sha256 !== undefined ? { sha256 } : {}) };
        });
      }
      // Stage-5 convergence (issue #225) + integration coverage: the scope is
      // planned from the prior round's durable convergence record and the
      // repo's own ancestry, never from wall-clock heuristics. Retained
      // coverage is credited only when the prior record's scope/coverage and
      // acceptance are AUTHENTICATED against the prior round's native ledger
      // receipts (freeze binding + review/verdict/debt events) — a stripped,
      // forged or contradicted record reviews whole with a durable reason.
      const priorEvidence = newestPredecessor === undefined ? null : this.priorNativeEvidence(newestPredecessor);
      const scopePlan = planPerkinsReviewScope({
        ...(priorConsolidatedFile !== undefined && newestPredecessor !== undefined
          ? { priorConsolidatedFile, priorSeq: newestPredecessor.seq }
          : {}),
        repoPath: frozenReview.manifest.repoPath,
        currentTargetSha: frozenReview.manifest.targetSha,
        currentDiffBaseSha: frozenReview.manifest.diffBaseSha,
        currentAcceptance: frozenReview.manifest.acceptance,
        ...(priorEvidence !== null ? { nativeReceipt: priorEvidence.receipt, acceptanceReceipt: priorEvidence.acceptance } : {}),
        rules: {
          deltaRoundsFrom: policy.portableContract.rules.convergence.deltaRoundsFrom,
          finalWholePassAtReady: policy.portableContract.rules.convergence.finalWholePassAtReady,
          integrationCoverage: policy.portableContract.rules.convergence.integrationCoverage,
        },
      });
      review = await workflow.run({
        roundId: round.id,
        ...(recoveryDirectory !== undefined ? { recoveryDirectory, recoveryStarts, recoverySources } : {}),
        roundNumber: round.seq,
        movementRef,
        noSpec,
        frozenReview,
        signal,
        ...(recoveredBaseTips.length > 0 && candidates.length > 0 ? { recoveredBaseTips } : {}),
        ...(priorConsolidatedFile !== undefined ? { priorConsolidatedFile } : {}),
        reviewScope: scopePlan.scope,
        reviewScopeReason: scopePlan.reason,
        priorCoverageComplete: scopePlan.priorCoverageComplete,
        ...(claimedFixedPriors !== undefined ? { claimedFixedPriors } : {}),
      });
    } catch (error) {
      const detail = `Perkins whole-PR workflow failed: ${String(error).replace(/[\r\n]+/gu, ' ').slice(0, 500)}`;
      if (!spawnInitiated() && this.opts.ledger.getRound(round.id)?.status === 'pending') {
        this.opts.ledger.abortReviewSetupWithoutSpawn(round.id);
      } else {
        this.abortRound(this.opts.ledger.getRound(round.id) ?? round, detail.slice(0, 500));
      }
      const errorArtifact = join(frozenReview.directory, 'workflow-error.json');
      if (!existsSync(errorArtifact)) {
        writeFileSync(errorArtifact, `${JSON.stringify({ schemaVersion: 1, canonicalVerdict: 'INCOMPLETE', error: detail.slice(0, 500) }, null, 2)}\n`, {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        });
      }
      const executionFacts = this.interruptedExecutionFacts(this.opts.ledger.getRound(round.id) ?? round, lenses);
      // Q4/R12: the report heading follows the ledger truth — a pre-spawn
      // failure has a durable no-spawn receipt but NO parent-incident
      // event, so it must not claim one.
      const incidentHeading = spawnInitiated()
        ? '**Parent incident** — the round ended before completion; this is one parent incident, not a per-lens specialist failure.'
        : '**Setup refusal** — the round ended before any review owner spawned; zero lead turns and zero specialist children existed.';
      const refusalResults: ReviewLensResult[] = spawnInitiated()
        ? this.interruptedLensResults(this.opts.ledger.getRound(round.id) ?? round, lenses, detail)
        : lenses.map((_lens) => ({ state: 'error' as const, note: `not started — setup refusal (no review owner spawned): ${detail}`.slice(0, 500) }));
      const incompleteContents = [
        '# Perkins Code Review',
        '',
        '**Verdict: INCOMPLETE**',
        '',
        `${detail.slice(0, 500)}`,
        '',
        incidentHeading,
        '',
        executionFacts,
        '',
      ].join('\n');
      const reportFile = join(frozenReview.directory, 'perkins-report.incomplete.md');
      if (!existsSync(reportFile)) {
        writeFileSync(reportFile, incompleteContents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
      const primaryReport = join(frozenReview.directory, 'perkins-report.md');
      if (!existsSync(primaryReport)) {
        writeFileSync(primaryReport, incompleteContents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
      this.opts.ledger.appendCustomEvent({
        kind: 'round.perkins-incomplete',
        jobId: job.id,
        roundId: round.id,
        payload: {
          // A superseded round (owner rule 3) is routine history, never a
          // clean-abort re-arm candidate or an action-required incident.
          reason: signal.reason instanceof ReviewSupersededError ? 'superseded' : signal.aborted ? 'cancelled' : 'workflow_error',
          error: detail.slice(0, 500),
          reportFile,
          executionFacts,
        },
      });
      this.escalate(`Review round ${round.id} is INCOMPLETE`, `${detail}\n${executionFacts}`, { jobId: job.id, roundId: round.id });
      return {
        round: this.opts.ledger.getRound(round.id) as RoundRecord,
        // P5 (round 5): a PRE-SPAWN failure returns setup-refusal notes —
        // its ledger truth is the no-spawn receipt, not a parent incident.
        results: refusalResults,
        verdict: null,
        posted: false,
        canonicalVerdict: 'INCOMPLETE',
        reportFile,
        artifactDirectory: frozenReview.directory,
        headMoved: refMovedSinceFreeze(frozenReview),
      };
    }

    const accounting: LensAccounting = { results: [], settledLenses: new Set<string>(), unusedLenses: [] };
    const provisional: LensAccounting = accounting;
    try {
      if (signal.aborted) throw new Error('review operation aborted before finalization');
      this.recordLensResults(round, lenses, review, accounting, specialistStartFacts(this.opts.ledger.listRoundSpecialistStarts(round.id)));
      const results = accounting.results;
      const sourceMovement = review.sourceMovement ?? sourceMovementSinceFreeze(frozenReview);
      const headMoved = review.headMoved || sourceMovement !== null;
    const canonical: CanonicalReviewVerdict = headMoved ? 'INCOMPLETE' : review.canonicalVerdict;
    let reportFile = review.reportFile;
    if (headMoved && review.canonicalVerdict !== 'INCOMPLETE') {
      reportFile = writeReviewArtifact(frozenReview, 'perkins-report.head-moved.md', [
        '# Perkins Code Review',
        '',
        '**Verdict: INCOMPLETE**',
        '',
        `The review source changed after target \`${review.targetSha}\` was frozen (${sourceMovement?.cause ?? 'check-failed'}: ${sourceMovement?.detail ?? 'source movement was observed at submission'}).`,
        'The lead-authored report remains preserved as `perkins-report.md`, but it cannot authorize approval or posting.',
        '',
      ].join('\n'));
    }
    const verdict: RoundVerdict | null = canonical === 'READY TO MERGE'
      ? 'approved'
      : canonical === 'NEEDS CHANGES' || canonical === 'MAJOR REWORK NEEDED'
        ? 'changes-requested'
        : null;
    if (headMoved) {
      this.opts.ledger.appendCustomEvent({
        kind: 'round.head-moved',
        jobId: job.id,
        roundId: round.id,
        payload: { frozenTarget: review.targetSha, observedRef: movementRef, cause: sourceMovement?.cause ?? 'check-failed', detail: sourceMovement?.detail ?? 'source movement was observed at submission' },
      });
    }

    let posted = false;
    let deliveryError: unknown;
    let deliveryFailureKind: 'report_not_posted' | 'no_pr_link' = 'report_not_posted';
    if (canonical !== 'INCOMPLETE' && job.prUrl !== null && this.opts.poster !== undefined) {
      const poster = this.opts.poster;
      const providerKind = publicationProviderKindFor(job.prUrl);
      const deliveryInput = () => {
        const prUrl = new URL(job.prUrl!);
        // The publication carries the lead-authored report PLUS a compact
        // host-owned factual appendix assembled from the structured result:
        // EVERY retained finding and the real execution facts
        // (ran/failed/not-used/nondelivered) reach PR readers
        // deterministically, with no model transcription. A body that
        // cannot carry the COMPLETE disclosure is refused before posting —
        // the full evidence is preserved locally instead (R8).
        let publicationBody: string;
        try {
          const startFacts = specialistStartFacts(this.opts.ledger.listRoundSpecialistStarts(round.id));
          const settledPairs = new Set(review.specialistRuns.map((run) => `${run.lens}#${run.attempt}`));
          publicationBody = publicationBodyFor(readFileSync(reportFile, 'utf8'), review, providerKind, lenses, frozenReview.evidence.ci, {
            journaled: startFacts.length,
            startedLenses: [...new Set(startFacts.map((start) => start.lens))],
            settledValid: review.specialistRuns.filter((run) => run.status === 'valid').length,
            settledFailed: review.specialistRuns.filter((run) => run.status !== 'valid').length,
            unsettled: startFacts.filter((start) => !settledPairs.has(`${start.lens}#${start.attempt}`)).map((start) => `${start.lens} a${start.attempt}`),
          });
        } catch (overflow) {
          if (!(overflow instanceof Error) || !overflow.message.includes('exceeds the provider review-body limit')) throw overflow;
          writeReviewArtifact(frozenReview, 'perkins-report.publication-overflow.json', {
            schemaVersion: 1,
            reason: overflow.message,
            provider: providerKind,
            retainedFindings: review.findings.map((finding) => ({
              severity: finding.severity, title: finding.title, location: finding.location, source: finding.source,
            })),
            reportFile,
            specialistRuns: review.specialistRuns,
          });
          throw overflow;
        }
        const redactedBody = redactReviewForPublication(publicationBody);
        // Redaction can EXPAND the body (fixed placeholders replace short
        // matches), so the provider bound is enforced on the FINAL bytes
        // that will actually be posted.
        if (Buffer.byteLength(redactedBody, 'utf8') > PUBLICATION_BODY_MAX_BYTES) {
          writeReviewArtifact(frozenReview, 'perkins-report.publication-overflow.json', {
            schemaVersion: 1,
            reason: 'redaction expanded the assembled publication body past the provider review-body limit',
            provider: providerKind,
            retainedFindings: review.findings.map((finding) => ({
              severity: finding.severity, title: finding.title, location: finding.location, source: finding.source,
            })),
            reportFile,
            specialistRuns: review.specialistRuns,
          });
          throw new Error(
            `redacted publication body (${Buffer.byteLength(redactedBody, 'utf8')} bytes) exceeds the provider review-body limit (${PUBLICATION_BODY_MAX_BYTES} bytes); ` +
            'complete retained-finding evidence is preserved locally — refusing to publish a partial disclosure',
          );
        }
        return { prUrl, publicationBody: redactedBody };
      };
      const recordDelivery = (delivered: PostedReviewReceipt, publicationFile: string, publicationSha256: string, reconciled: boolean): void => {
        // The payload IS the shared PostedEventPayload contract: recovery
        // parses this exact shape through parsePostedEventPayload, so the
        // writer and reader can never drift apart (R2/R21).
        if (verdict === null) throw new Error('internal: delivery recorded without a conclusive verdict');
        const postedPayload: PostedEventPayload = {
            verdict, canonicalVerdict: canonical, url: job.prUrl!, host: new URL(job.prUrl!).host,
            // The delivery record carries the identity and receipt the
            // poster PROVED: the provider review id, the actual actor and
            // event (an authenticated COMMENT — never a formal
            // APPROVED/CHANGES_REQUESTED claim), the commit binding, the
            // frozen head delivered against and the base observed by the
            // poster's identity probe (which may precede delivery).
            targetSha: delivered.headSha, baseSha: delivered.baseSha,
            publicationFile, publicationSha256,
            receipt: {
              reviewId: delivered.reviewId, actor: delivered.actor, event: delivered.event,
              commitId: delivered.commitId, headSha: delivered.headSha, baseSha: delivered.baseSha, bodySha256: delivered.bodySha256,
            },
            reconciled,
            // Persist the authenticated review scope/coverage/debt AND the
            // retained finding identity WITH the posted event, BEFORE it
            // becomes promotable, so restart recovery and promoted-round
            // predecessor selection never have to trust mutable state.
            ...(review.convergence !== undefined ? {
              review: {
                reviewScope: review.convergence.reviewScope,
                coverageComplete: review.convergence.coverageComplete === true || review.convergence.reviewScope === 'whole',
                finalPassRequired: review.convergence.finalPassRequired === true,
                diffBaseSha: review.diffBaseSha,
                blockers: review.findings.filter((finding) => finding.severity === 'blocker' && finding.deferredFollowup !== true).length,
                retainedFindings: review.findings.length,
                retainedFindingsSha256: createHash('sha256').update(JSON.stringify(review.findings)).digest('hex'),
                ...(review.convergence.integrationFromSha !== undefined ? { integrationFromSha: review.convergence.integrationFromSha } : {}),
                ...(review.convergence.integrationBaseSha !== undefined ? { integrationBaseSha: review.convergence.integrationBaseSha } : {}),
              },
            } : {}),
        };
        // R34 writer/reader symmetry invariant: the event about to be
        // persisted MUST parse through the SAME shared contract restart
        // recovery reads. A receipt shape the reader would reject is
        // refused here instead of becoming a round that can never recover.
        if (parsePostedEventPayload(postedPayload) === null) {
          throw new Error('internal: refusing to persist a round.posted payload that restart recovery cannot parse');
        }
        // The final-pass obligation is durable BEFORE the posted event becomes
        // promotable: a crash between `round.posted` and a later marker write
        // must never let restart recovery (or the board's owner-ready gate)
        // promote a partial-coverage approval without its debt.
        if (verdict === 'approved' && review.convergence?.finalPassRequired === true && !headMoved &&
          this.opts.ledger.latestRoundEvent(round.id, 'round.final-pass-required') === null) {
          try {
            this.opts.ledger.appendCustomEvent({
              kind: 'round.final-pass-required', jobId: job.id, roundId: round.id,
              payload: { targetSha: review.targetSha, reviewScope: review.convergence.reviewScope },
            });
          } catch (markerError) {
            throw new Error(`could not record the required final whole-change pass before the posted event: ${String(markerError)}`);
          }
        }
        this.opts.ledger.appendCustomEvent({
          kind: 'round.posted',
          jobId: job.id,
          roundId: round.id,
          payload: postedPayload,
        });
        posted = true;
      };
      try {
        if (signal.aborted) throw new Error('review operation aborted before report delivery');
        const beforeDelivery = sourceMovementSinceFreeze(frozenReview);
        if (beforeDelivery !== null) throw new Error(`source changed immediately before report delivery (${beforeDelivery.cause}: ${beforeDelivery.detail})`);
        const { prUrl, publicationBody } = deliveryInput();
        const publicationFile = writeReviewArtifact(frozenReview, 'perkins-report.publication.md', publicationBody);
        const publicationSha256 = createHash('sha256').update(publicationBody).digest('hex');
        const delivered = verifyPostedReceipt(
          await poster.post({
            prUrl: job.prUrl!,
            host: prUrl.host,
            repoPath: frozenReview.manifest.repoPath,
            body: publicationBody,
            targetSha: review.targetSha,
            baseSha: frozenReview.manifest.baseRefSha,
          }),
          { targetSha: review.targetSha, bodySha256: publicationSha256 },
        );
        if (signal.aborted) throw new Error('review operation aborted while the report was being delivered');
        const duringDelivery = sourceMovementSinceFreeze(frozenReview);
        if (duringDelivery !== null) throw new Error(`source changed while the report was being delivered (${duringDelivery.cause}: ${duringDelivery.detail})`);
        recordDelivery(delivered, publicationFile, publicationSha256, false);
      } catch (error) {
        // Ambiguous publication (the provider may have committed our POST
        // before the failure): reconcile once against provider evidence
        // bound to the frozen head and the exact published body. A verified
        // match becomes the receipt — no duplicate post. Anything else
        // stays honestly unposted.
        let reconciledDelivery: PostedReviewReceipt | null = null;
        let reconciliationFailure: unknown;
        let recordFailure: unknown;
        if (typeof poster.reconcile === 'function' && !signal.aborted) {
          try {
            const { prUrl, publicationBody } = deliveryInput();
            const publicationSha256 = createHash('sha256').update(publicationBody).digest('hex');
            // The attempt path above already published these exact bytes;
            // write-once tolerates the collision instead of failing the
            // reconciliation before it can run.
            let publicationFile: string;
            try {
              publicationFile = writeReviewArtifact(frozenReview, 'perkins-report.publication.md', publicationBody);
            } catch (writeError) {
              if (!(writeError instanceof Error && 'code' in writeError && (writeError as { code?: string }).code === 'EEXIST')) throw writeError;
              publicationFile = join(frozenReview.directory, 'perkins-report.publication.md');
            }
            // Live post-failure second lookup: the explicit context lets
            // the backend fail it closed (j-642) instead of re-reading the
            // provider under recovery semantics after a failed post.
            const found = await poster.reconcile!({
              prUrl: job.prUrl!,
              host: prUrl.host,
              repoPath: frozenReview.manifest.repoPath,
              body: publicationBody,
              targetSha: review.targetSha,
              baseSha: frozenReview.manifest.baseRefSha,
            }, { reason: 'post-failure' });
            reconciledDelivery = found === null
              ? null
              : verifyPostedReceipt(found, { targetSha: review.targetSha, bodySha256: publicationSha256 });
            if (reconciledDelivery !== null) {
              // The SAME stale-head/cancellation safeguards as a normal
              // POST apply AFTER the lookup, before anything is recorded
              // (T4): a receipt discovered while the ref moved (or the
              // operation aborted) is preserved as evidence but never
              // recorded as delivery — the changed head was not reviewed.
              const duringReconciliation = signal.aborted ? null : sourceMovementSinceFreeze(frozenReview);
              if (signal.aborted || duringReconciliation !== null) {
                const reason = signal.aborted
                  ? 'review operation aborted while the reconciliation lookup was outstanding'
                  : `source changed while the reconciliation lookup was outstanding (${duringReconciliation!.cause}: ${duringReconciliation!.detail})`;
                try {
                  writeReviewArtifact(frozenReview, 'perkins-report.reconciled-unrecorded.json', {
                    recorded: false, reconciled: true, reason,
                    receipt: {
                      reviewId: reconciledDelivery.reviewId, actor: reconciledDelivery.actor,
                      event: reconciledDelivery.event, commitId: reconciledDelivery.commitId,
                      headSha: reconciledDelivery.headSha, baseSha: reconciledDelivery.baseSha,
                      bodySha256: reconciledDelivery.bodySha256,
                    },
                  });
                } catch (artifactError) {
                  if (!(artifactError instanceof Error && 'code' in artifactError && (artifactError as { code?: string }).code === 'EEXIST')) throw artifactError;
                }
                this.escalate(
                  `Perkins report for round ${round.id} reconciled a provider review but did NOT record it`,
                  `${reason}; the remote comment is preserved as unrecorded evidence and the round stays honestly unposted — the changed head was not reviewed`,
                  { jobId: round.jobId, roundId: round.id },
                );
                reconciledDelivery = null;
              } else {
                // Recording is the commit point: if the shared
                // writer/reader guard refuses the payload, the candidate
                // must not survive as if it had been recorded (R31).
                const toRecord = reconciledDelivery;
                reconciledDelivery = null;
                try {
                  recordDelivery(toRecord, publicationFile, publicationSha256, true);
                  reconciledDelivery = toRecord;
                  this.log('info', 'Perkins report delivery reconciled against provider evidence', {
                    round: round.id, reviewId: toRecord.reviewId,
                  });
                } catch (recordError) {
                  recordFailure = recordError;
                  this.log('error', 'Perkins report delivery reconciled a receipt that could not be recorded', {
                    round: round.id, error: String(recordError),
                  });
                }
              }
            }
          } catch (reconcileError) {
            reconciliationFailure = reconcileError;
            this.log('error', 'Perkins report delivery reconciliation failed', { round: round.id, error: String(reconcileError) });
          }
        }
        if (reconciledDelivery === null) {
          // R31: an unresolved ambiguous post must always carry the
          // manual-verification warning — a following lookup that found
          // nothing, could not run, or could not be recorded does not make
          // a blind retry safe. When a follow-up step ALSO failed, its
          // detail joins the durable record.
          const caution = 'verify manually before any retry — an unresolved lookup is not proof of absence, and a retry could duplicate a real publication';
          const followUpFailure = reconciliationFailure !== undefined
            ? `reconciliation after the ambiguous post ALSO failed: ${String(reconciliationFailure)}`
            : recordFailure !== undefined
              ? `recording the reconciled delivery ALSO failed: ${String(recordFailure)}`
              : null;
          deliveryError = followUpFailure === null
            ? new Error(`${String(error)}; ${caution}`)
            : new Error(`${caution}; ${followUpFailure}; original post failure: ${String(error)}`);
          this.escalate(
            `Perkins report for round ${round.id} was recorded but NOT posted safely to the pull request`,
            String(deliveryError),
            { jobId: round.jobId, roundId: round.id },
          );
          this.log('error', 'Perkins report post failed', { round: round.id, error: String(deliveryError) });
        }
      }
    } else if (canonical !== 'INCOMPLETE' && job.prUrl === null) {
      // No linked PR means publication is impossible: a conclusive verdict
      // can never become a completed published round.
      deliveryFailureKind = 'no_pr_link';
      deliveryError = new Error('the job has no pull request link; a conclusive review cannot be published');
      this.escalate(
        `Perkins report for round ${round.id} was recorded but has NO pull request to publish to`,
        'the job has no pull request link; a conclusive review cannot be published',
        { jobId: round.jobId, roundId: round.id },
      );
    } else if (canonical !== 'INCOMPLETE' && job.prUrl !== null) {
      deliveryError = new Error('the PR poster is unavailable');
      this.escalate(
        `Perkins report for round ${round.id} was recorded but NOT posted to the pull request`,
        'the PR poster is unavailable',
        { jobId: round.jobId, roundId: round.id },
      );
    }

    if (signal.aborted) {
      // Preserve any earlier durable detail (e.g. the R31 manual-verification
      // warning) instead of overwriting it with the abort alone.
      const abortDetail = 'review operation aborted during finalization';
      deliveryError = deliveryError === undefined
        ? new Error(abortDetail)
        : new Error(`${String(deliveryError)}; ${abortDetail}`);
    }
    // Publication is required for ANY conclusive verdict: an unposted review
    // is never complete, with or without a linked PR.
    const recordedVerdict = verdict !== null && posted && !signal.aborted ? verdict : null;
    if (recordedVerdict === null && verdict !== null) {
      reportFile = writeReviewArtifact(frozenReview, 'perkins-report.delivery-incomplete.md', [
        '# Perkins Code Review',
        '',
        '**Verdict: INCOMPLETE**',
        '',
        `The lead completed a \`${canonical}\` report for target \`${review.targetSha}\`, but delivery proof failed.`,
        'The lead-authored report remains preserved as `perkins-report.md`; no local verdict or approval was recorded.',
        '',
      ].join('\n'));
    }
    if (recordedVerdict !== null) {
      // Stage-5: the final-pass obligation is durable BEFORE the verdict
      // commits. It is normally already written by recordDelivery BEFORE the
      // posted event; this is the idempotent fallback for any delivery path
      // that did not. A failed marker write fails the round closed instead of
      // approving.
      if (recordedVerdict === 'approved' && review.convergence?.finalPassRequired === true && !headMoved &&
        this.opts.ledger.latestRoundEvent(round.id, 'round.final-pass-required') === null) {
        try {
          this.opts.ledger.appendCustomEvent({
            kind: 'round.final-pass-required', jobId: job.id, roundId: round.id,
            payload: { targetSha: review.targetSha, reviewScope: review.convergence.reviewScope },
          });
        } catch (markerError) {
          throw new Error(`could not record the required final whole-change pass before the verdict commit: ${String(markerError)}`);
        }
      }
      // gh-169 round-5 P1: the deferred not-used chips and the verdict
      // transition commit in ONE atomic ledger transaction — a failure
      // anywhere leaves NOTHING committed (round live, deferred chips
      // pending, the abort path legal), and a posted verdict can never
      // coexist with pending or mixed deferred chips.
      this.opts.ledger.finalizeRoundVerdictWithLensOutcomes(
        round.id,
        recordedVerdict,
        accounting.unusedLenses.map((lens) => ({ lens, state: 'done' as const, note: 'not used — lead-owned whole-PR review' })),
      );
      // R6-2: the complete-review event lands ONLY after the atomic commit
      // succeeded — an aborted round can never carry a complete:true
      // review event for the Silas digest to consume.
      this.opts.ledger.appendCustomEvent({
        kind: 'round.perkins-review',
        jobId: job.id,
        roundId: round.id,
        payload: {
          canonicalVerdict: canonical,
          // Blocker count for the operator-visible record (the awareness
          // digest renders it as "verdict with N blocker(s)"). Deferred
          // follow-ups cannot hold the PR, so they are not blockers here.
          blockers: review.findings.filter((finding) => finding.severity === 'blocker' && finding.deferredFollowup !== true).length,
          // Bind the retained finding CONTENTS to the native submission: a
          // record whose findings are later swapped/emptied can never be
          // credited whole-complete coverage over unresolved priors.
          retainedFindings: review.findings.length,
          retainedFindingsSha256: createHash('sha256').update(JSON.stringify(review.findings)).digest('hex'),
          targetSha: review.targetSha,
          baseRefSha: frozenReview.manifest.baseRefSha,
          diffBaseSha: review.diffBaseSha,
          artifactDirectory: review.artifactDirectory,
          reportFile,
          headMoved,
          complete: canonical !== 'INCOMPLETE' && !headMoved,
          ...(review.convergence !== undefined ? {
            reviewScope: review.convergence.reviewScope,
            ...(review.convergence.scopeReason !== undefined ? { scopeReason: review.convergence.scopeReason } : {}),
            ...(review.convergence.integrationFromSha !== undefined ? { integrationFromSha: review.convergence.integrationFromSha } : {}),
            ...(review.convergence.integrationBaseSha !== undefined ? { integrationBaseSha: review.convergence.integrationBaseSha } : {}),
            ...(review.convergence.integrationPriorDiffBase !== undefined ? { integrationPriorDiffBase: review.convergence.integrationPriorDiffBase } : {}),
            ...(review.convergence.coverageComplete === true ? { coverageComplete: true } : {}),
            ...(review.convergence.integrationDeltaSha256 !== undefined ? { integrationDeltaSha256: review.convergence.integrationDeltaSha256 } : {}),
            ...(review.convergence.carriedPriors !== undefined ? { carriedPriors: review.convergence.carriedPriors.length } : {}),
            ...(review.convergence.carriedLenses !== undefined ? { carriedLenses: review.convergence.carriedLenses } : {}),
            ...(review.convergence.deferredFollowups !== undefined ? { deferredFollowups: review.convergence.deferredFollowups.length } : {}),
            ...(review.convergence.verdictRecomputed !== undefined ? { verdictRecomputed: review.convergence.verdictRecomputed } : {}),
            ...(review.convergence.finalPassRequired === true ? { finalPassRequired: true } : {}),
          } : {}),
        },
      });
      // Stage-5: findings deferred by the convergence rule are FILED as
      // follow-ups — one durable ledger event with the complete finding
      // payloads, never silently dropped and never another review round.
      if (review.convergence?.deferredFollowups !== undefined && review.convergence.deferredFollowups.length > 0) {
        try {
          writeReviewArtifact(frozenReview, 'followups-deferred.json', {
            schemaVersion: 1,
            roundId: round.id,
            targetSha: review.targetSha,
            rule: 'stage-5 convergence: new findings outside this round\'s delta hunks are filed as follow-ups and cannot hold the PR',
            followups: review.findings.filter((finding) => finding.deferredFollowup === true),
          });
        } catch (writeError) {
          this.log('error', 'could not write the deferred follow-ups artifact', { round: round.id, error: String(writeError) });
        }
        this.opts.ledger.appendCustomEvent({
          kind: 'round.followups-deferred',
          jobId: job.id,
          roundId: round.id,
          payload: {
            targetSha: review.targetSha,
            followups: review.findings
              .filter((finding) => finding.deferredFollowup === true)
              .map((finding) => ({
                severity: finding.severity, title: finding.title, location: finding.location,
                category: finding.category, detail: finding.detail, recommended_fix: finding.recommended_fix,
                source: finding.source, roundOrigin: finding.roundOrigin,
              })),
          },
        });
        // Follow-ups are review-scoped records, deliberately not tracker
        // issues: the review surface holds no tracker scopes, creating
        // issues would duplicate the record below and grow the backlog,
        // and triage/ownership of tracker work is not the reviewer's call.
        // The guaranteed handoff is the operator escalation beside the
        // durable artifact, ledger event and PR appendix — never a silent
        // drop.
        const followupTitles = review.findings
          .filter((finding) => finding.deferredFollowup === true)
          .map((finding) => `${finding.severity}: ${finding.title} (${finding.location})`);
        this.escalate(
          `Perkins review for job ${job.id} deferred ${followupTitles.length} follow-up finding(s)`,
          `Deferred by the Stage-5 convergence rule (outside this round's delta hunks; they cannot hold the PR): ${followupTitles.join('; ')}. ` +
          `Filed as review follow-ups with full records in ${join(review.artifactDirectory, 'followups-deferred.json')}, the round.followups-deferred ledger event, the round's consolidated record and the PR review appendix — never dropped, and never another review round.`,
          { jobId: job.id, roundId: round.id },
        );
      }
    } else {
      this.opts.ledger.setRoundStatus(round.id, 'aborted');
      // R6-8: the round ABORTED, so the deferred not-used chips never
      // committed — the RETURNED results must not claim done/not-used
      // coverage their ledger chips do not hold. Settled lenses keep their
      // truthful results; unused lenses return an honest round-incomplete
      // note instead.
      const unusedSet = new Set<string>(accounting.unusedLenses);
      for (let index = 0; index < lenses.length; index += 1) {
        if (unusedSet.has(lenses[index]!)) {
          accounting.results[index] = {
            state: 'error',
            note: 'not used — lead-owned review; the round ended INCOMPLETE before the not-used coverage chips committed',
          };
        }
      }
      // P7/Q5/Q6 (gh-169): an ordinary lead-authored INCOMPLETE (or an
      // undelivered conclusive report) surfaces the host-owned execution
      // facts AT the returned report boundary: a write-once host report
      // that links the preserved, immutable lead report and carries the
      // factual counts. Counts separate JOURNALED STARTS from SETTLED
      // results — a charged-but-unsettled attempt (started, then the
      // round ended before a result committed) is never labeled "not
      // used" and never vanishes.
      const journaledStartFacts = specialistStartFacts(this.opts.ledger.listRoundSpecialistStarts(round.id));
      const executionFactsLine = settledExecutionFactsLine(journaledStartFacts, review.specialistRuns, lenses);
      let hostReportWriteFailed: string | null = null;
      try {
        reportFile = writeReviewArtifact(frozenReview, 'perkins-report.host-incomplete.md', [
          '# Perkins Code Review',
          '',
          '**Verdict: INCOMPLETE** — host-recorded execution facts',
          '',
          deliveryError !== undefined
            ? `The lead completed a report for target \`${review.targetSha}\`, but delivery proof failed (${String(deliveryError).slice(0, 300)}).`
            : `The lead judged the change INCOMPLETE for target \`${review.targetSha}\`.`,
          '',
          executionFactsLine,
          '',
          'The lead-authored report is preserved verbatim at `perkins-report.md`; this host-owned summary links it and carries the factual execution counts (gh-169).',
          '',
        ].join('\n'));
      } catch (factsError) {
        // P4 (gh-169): a failed host-report write is LOUD — the returned
        // report regresses to the preserved lead report, and the event
        // payload plus the operator escalation disclose exactly that,
        // with the factual counts still durable in the event.
        hostReportWriteFailed = String(factsError).slice(0, 300);
        this.log('error', 'could not preserve the host-owned INCOMPLETE report with execution facts', {
          round: round.id, error: hostReportWriteFailed,
        });
      }
      try {
        this.opts.ledger.appendCustomEvent({
          kind: 'round.perkins-incomplete',
          jobId: job.id,
          roundId: round.id,
          payload: {
            reason: verdict === null ? 'review_incomplete' : deliveryFailureKind,
            reportFile,
            executionFacts: executionFactsLine,
            ...(hostReportWriteFailed !== null ? { hostReportWriteFailed } : {}),
            ...(deliveryError !== undefined ? { error: String(deliveryError).slice(0, 500) } : {}),
          },
        });
      } catch (incompleteEventError) {
        // R7-2: a failed EVENT write never reclassifies the lead's
        // completed INCOMPLETE submission as a parent execution failure —
        // the disclosure fails loud, the classification stands.
        this.log('error', 'could not persist the round.perkins-incomplete event', {
          round: round.id, error: String(incompleteEventError),
        });
        this.escalate(
          `Review round ${round.id} INCOMPLETE record event could not be persisted`,
          `The lead's completed INCOMPLETE classification stands (report: ${reportFile}); the durable round.perkins-incomplete event could not be written: ${String(incompleteEventError).slice(0, 300)}`,
          { jobId: job.id, roundId: round.id },
        );
      }
      this.escalate(
        `Review round ${round.id} is INCOMPLETE`,
        `coverage of the round's selected lenses, verification, source stability, or delivery proof did not complete. ` +
        (hostReportWriteFailed !== null
          ? `NOTE: the host-owned INCOMPLETE report could NOT be written (${hostReportWriteFailed}); the durable event carries the execution facts and the report at ${basename(reportFile)} is the fallback record (the lead-authored report stays preserved at perkins-report.md).`
          : `Host report (with execution facts): ${reportFile}`),
        { jobId: job.id, roundId: round.id },
      );
    }
    return {
      round: this.opts.ledger.getRound(round.id) as RoundRecord,
      results,
      verdict: recordedVerdict,
      posted,
      canonicalVerdict: recordedVerdict === null && canonical !== 'INCOMPLETE' ? 'INCOMPLETE' : canonical,
      reportFile,
      artifactDirectory: review.artifactDirectory,
      headMoved: headMoved || (deliveryError !== undefined && refMovedSinceFreeze(frozenReview)),
      ...(recordedVerdict === 'approved' && review.convergence?.finalPassRequired === true && !headMoved
        ? { finalPass: { required: true as const, targetSha: review.targetSha } }
        : {}),
    };
    } catch (error) {
      return this.finalizationIncomplete(job, round, lenses, frozenReview, error, provisional);
    }
  }

  /** Honest per-lens outcomes for a round ended by a PARENT failure
   * (workflow exception, shutdown, finalization crash — gh-169): a lens
   * with a started attempt is an execution error naming the parent
   * cause; a never-started lens is `not started — parent incident`,
   * never a failed specialist execution. R8-4: a started lens with an
   * independently recorded round.specialist-settled event is NOT called
   * "before settlement" — its checkpointed settlement is durable truth
   * the next round recovers. */
  private interruptedLensResults(
    round: RoundRecord,
    lenses: readonly PerkinsLens[],
    detail: string,
  ): ReviewLensResult[] {
    const started = this.startedSpecialistLenses(round);
    const settled = this.settledSpecialistLenses(round.id);
    return lenses.map((lens) => {
      if (!started.has(lens)) {
        return { state: 'error' as const, note: `not started — parent incident: ${detail}`.slice(0, 500) };
      }
      return settled.has(lens)
        ? { state: 'error' as const, note: `attempt settled (checkpoint recorded); the round ended before its result was collected — recoverable by the next round: ${detail}`.slice(0, 500) }
        : { state: 'error' as const, note: `attempt started; interrupted by parent failure before settlement: ${detail}`.slice(0, 500) };
    });
  }

  /** Lenses with a durable round.specialist-settled event (R8-4). */
  private settledSpecialistLenses(roundId: string): ReadonlySet<string> {
    const settled = new Set<string>();
    for (const event of this.opts.ledger.listRoundSpecialistSettlements(roundId)) {
      const lens = typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as { readonly lens?: unknown }).lens : null;
      if (typeof lens === 'string' && lens !== '') settled.add(lens);
    }
    return settled;
  }

  /** One bounded, report-visible execution-facts line for interrupted
   * rounds: how many specialist attempts actually started and which
   * lenses never executed. The durable INCOMPLETE report carries it so a
   * reader can never mistake a parent abort for specialist failures.
   * Uses the SAME started classification as `abortRound` (journal ∪
   * live chips, P5) and names the journaled-start count separately — a
   * live child whose journal write was lost still counts as started. */
  private interruptedExecutionFacts(round: RoundRecord, lenses: readonly PerkinsLens[]): string {
    const started = this.startedSpecialistLenses(round);
    const attempts = this.opts.ledger.listRoundSpecialistStarts(round.id).length;
    const startedLenses = lenses.filter((lens) => started.has(lens));
    const notStarted = lenses.filter((lens) => !started.has(lens));
    return `Specialist execution at abort: ${attempts} journaled attempt(s) started (${startedLenses.length} of ${lenses.length} lenses: ${startedLenses.join(', ') || 'none'}); ${notStarted.length} lens(es) never started (${notStarted.join(', ') || 'none'}).`;
  }

  private finalizationIncomplete(
    job: { readonly id: string },
    round: RoundRecord,
    lenses: readonly PerkinsLens[],
    frozenReview: FrozenReview,
    error: unknown,
    provisional?: LensAccounting,
  ): WaveOutcome {
    const detail = `Perkins finalization failed: ${String(error)}`.replace(/[\r\n]+/gu, ' ').slice(0, 500);
    // R7-1: a DURABLY COMMITTED verdict outranks any later failure — a
    // post-commit event/artifact write failure must never reclassify the
    // round as a parent-aborted INCOMPLETE. Disclose loudly and return the
    // settled truth (verdict, chips and provisional results agree).
    const committed = this.opts.ledger.getRound(round.id);
    if (committed !== null && (committed.status === 'verdict-posted' || committed.verdict !== null)) {
      this.log('error', 'finalization failed after the verdict committed — returning the settled truth', {
        round: round.id, error: detail,
      });
      // R8-1: durable idempotent reconciliation — RETRY the complete-review
      // event here (a transient append failure heals; a permanent one is
      // disclosed by the escalation below, and the settled truth stands).
      try {
        this.opts.ledger.appendCustomEvent({
          kind: 'round.perkins-review',
          jobId: job.id,
          roundId: round.id,
          payload: {
            canonicalVerdict: committed.verdict === 'approved' ? 'READY TO MERGE' : 'NEEDS CHANGES',
            blockers: 0,
            targetSha: round.targetRef,
            baseRefSha: frozenReview.manifest.baseRefSha,
            diffBaseSha: frozenReview.manifest.diffBaseSha,
            artifactDirectory: frozenReview.directory,
            reportFile: join(frozenReview.directory, 'perkins-report.md'),
            headMoved: false,
            complete: true,
            reconciledAfterFinalizationFailure: detail.slice(0, 300),
          },
        });
      } catch (retryError) {
        this.log('error', 'the reconciled complete-review event could not be persisted either', {
          round: round.id, error: String(retryError),
        });
      }
      this.escalate(
        `Review round ${round.id} finalization artifact failed after its verdict committed`,
        `The round's ${committed.verdict} verdict and lens chips stand as committed; a later finalization write failed and was not reclassified: ${detail}`,
        { jobId: job.id, roundId: round.id },
      );
      return {
        round: committed,
        results: lenses.map((lens, index) => {
          const chip = committed.lenses.find((entry) => entry.lens === lens);
          const provisionalResult = provisional?.results[index];
          if ((chip?.state === 'done' || chip?.state === 'error') && provisionalResult !== undefined) {
            return provisionalResult;
          }
          return { state: 'done' as const, verdict: 'clean' as const, evidence: chip?.note ?? 'committed lens outcome' };
        }),
        verdict: committed.verdict as RoundVerdict,
        posted: true,
        canonicalVerdict: committed.verdict === 'approved' ? 'READY TO MERGE' : committed.verdict === 'changes-requested' ? 'NEEDS CHANGES' : 'MAJOR REWORK NEEDED',
        reportFile: join(frozenReview.directory, 'perkins-report.md'),
        artifactDirectory: frozenReview.directory,
        headMoved: false,
      };
    }
    let abortRoundFailed: string | null = null;
    try {
      this.abortRound(this.opts.ledger.getRound(round.id) ?? round, detail);
    } catch (ledgerError) {
      abortRoundFailed = String(ledgerError).slice(0, 300);
      this.log('error', 'could not terminalize failed Perkins round in ledger', {
        round: round.id, error: String(ledgerError),
      });
    }
    const reportFile = join(frozenReview.directory, 'perkins-report.finalization-incomplete.md');
    const executionFacts = this.interruptedExecutionFacts(this.opts.ledger.getRound(round.id) ?? round, lenses);
    // R6-7: the report heading follows the DURABLE incident marker — if
    // abortRound itself failed, the report says so instead of claiming a
    // parent-incident event that never persisted.
    const incidentMarker = this.opts.ledger.latestRoundEvent(round.id, 'round.parent-incident');
    try {
      if (!existsSync(reportFile)) {
        writeFileSync(
          reportFile,
          [
            '# Perkins Code Review',
            '',
            '**Verdict: INCOMPLETE**',
            '',
            detail,
            '',
            incidentMarker !== null
              ? '**Parent incident** — finalization ended the round; this is one parent incident, not a per-lens specialist failure.'
              : `**Terminalization incomplete** — finalization failed and the parent-incident marker could not be persisted${abortRoundFailed !== null ? ` (${abortRoundFailed})` : ''}; the ledger state above is the durable truth.`,
            '',
            executionFacts,
            '',
          ].join('\n'),
          { encoding: 'utf8', mode: 0o600, flag: 'wx' },
        );
      }
    } catch (artifactError) {
      this.log('error', 'could not preserve finalization INCOMPLETE report', {
        round: round.id, error: String(artifactError),
      });
    }
    try {
      this.opts.ledger.appendCustomEvent({
        kind: 'round.perkins-incomplete',
        jobId: job.id,
        roundId: round.id,
        payload: { reason: 'finalization_error', error: detail, reportFile, executionFacts },
      });
    } catch (ledgerError) {
      this.log('error', 'could not persist finalization INCOMPLETE event', {
        round: round.id, error: String(ledgerError),
      });
    }
    this.escalate(`Review round ${round.id} is INCOMPLETE`, `${detail}\n${executionFacts}`, { jobId: job.id, roundId: round.id });
    let moved = true;
    try {
      moved = refMovedSinceFreeze(frozenReview);
    } catch {
      // Unknown source state is fail-closed movement.
    }
    // gh-169 P3/R4-3: reconcile the RETURNED results with the chips that
    // DURABLY committed — the live ledger state, not a lost snapshot.
    // A lens whose chip is terminal (done/error) keeps its provisional
    // (truthful) result; the rest classify by the ONE started set,
    // exactly like abortRound. No child failure is ever invented.
    const currentRound = this.opts.ledger.getRound(round.id) ?? round;
    const started = this.startedSpecialistLenses(round);
    const interrupted = this.interruptedLensResults(round, lenses, detail);
    const reconciled = lenses.map((lens, index) => {
      const chip = currentRound.lenses.find((entry) => entry.lens === lens);
      const provisionalResult = provisional?.results[index];
      if ((chip?.state === 'done' || chip?.state === 'error') && provisionalResult !== undefined) {
        return provisionalResult;
      }
      return started.has(lens)
        ? interrupted[index]!
        : { state: 'error' as const, note: `not started — parent incident: ${detail}`.slice(0, 500) };
    });
    return {
      round: this.opts.ledger.getRound(round.id) ?? { ...round, status: 'aborted' },
      results: reconciled,
      verdict: null,
      posted: false,
      canonicalVerdict: 'INCOMPLETE',
      reportFile,
      artifactDirectory: frozenReview.directory,
      headMoved: moved,
    };
  }

  /** Lens accounting for a SETTLED review (gh-169 P3): settled lenses
   * (real runs) commit their truthful chips immediately — their truth is
   * independent of finalization. The not-used 'done' chips are COMMITTED
   * SEPARATELY (only once the round records its verdict) so a later
   * finalization failure aborts with never-started lenses still `pending`,
   * exactly like every other parent abort — never a `done` chip on an
   * aborted round claiming coverage that never executed. */
  private recordLensResults(
    round: RoundRecord,
    lenses: readonly PerkinsLens[],
    review: PerkinsWholeResult,
    accounting: LensAccounting,
    journaledStarts: readonly SpecialistStartFact[],
  ): void {
    const { results, settledLenses, unusedLenses } = accounting;
    for (const lens of lenses) {
      const runs = review.specialistRuns.filter((run) => run.lens === lens);
      // Attempt-level truth (round-5 P2): a settled a1 never hides a
      // journaled-but-unsettled retry on the SAME lens.
      const settledAttempts = new Set(runs.map((run) => run.attempt));
      const unsettledRetries = journaledStarts
        .filter((start) => start.lens === lens && !settledAttempts.has(start.attempt as 1 | 2))
        .map((start) => `a${start.attempt}`);
      const journaledStartLenses = new Set(journaledStarts.map((start) => start.lens));
      if (runs.length === 0 && journaledStartLenses.has(lens)) {
        // gh-169 R4-2/R7-6: a lens whose attempt(s) were JOURNALED but
        // never settled is real started work — never 'not used'. Every
        // charged attempt identity is named; the lead's whole-change
        // judgment stands apart from it.
        const charged = journaledStarts.filter((start) => start.lens === lens).map((start) => `a${start.attempt}`);
        const note = `attempt(s) started but unsettled: ${charged.join(', ')} — the wave ended before these specialist results committed; the lead judged the change on its own whole-change verification`;
        this.opts.ledger.setLensOutcome(round.id, lens, 'error', note);
        results.push({ state: 'error', note });
        settledLenses.add(lens);
        continue;
      }
      if (runs.length === 0) {
        // Whole-PR review: the lead owns the review; a lens it never used is
        // a truthful 'not used', never missing required coverage. The chip
        // commit is deferred (see the doc comment).
        const note = 'not used — lead-owned whole-PR review';
        unusedLenses.push(lens);
        results.push({ state: 'done', verdict: 'clean', evidence: note });
        continue;
      }
      const failed = runs.filter((run) => run.status !== 'valid');
      if (failed.length === runs.length) {
        // Every attempt on this lens failed: honest execution error, named
        // per attempt. The lead's own review still stands apart from it.
        const note = `specialist attempts failed: ${failed.map((run) => `a${run.attempt} ${run.failureKind ?? 'error'}: ${(run.error ?? 'no host-recorded reason').slice(0, 200)}`).join('; ')}` +
          `${unsettledRetries.length > 0 ? `; started but unsettled: ${unsettledRetries.join(', ')} (the wave ended before these results committed)` : ''}`;
        this.opts.ledger.setLensOutcome(round.id, lens, 'error', note);
        results.push({ state: 'error', note });
        settledLenses.add(lens);
        continue;
      }
      const findings = review.findings.filter((finding) => finding.sources.includes(lens));
      const verdict: 'blocker' | 'warning' | 'note' | 'clean' = this.lensVerdict(findings);
      const evidence = findings.length === 0
        ? 'lead retained no finding sourced from this specialist'
        : findings.slice(0, 10).map((finding) =>
            `${finding.severity}: ${finding.title} @ ${finding.location} — ${finding.evidence.slice(0, 240)}`,
          ).join('\n');
      // Truthful accounting on the done chip (T12/R17): an earlier FAILED
      // attempt stays visible after a later success, and valid runs whose
      // findings never reached the lead say so — 'ran' must never read as
      // 'delivered and considered'.
      const history: string[] = [];
      if (failed.length > 0) {
        history.push(`earlier failed attempts: ${failed.map((run) => `a${run.attempt} ${run.failureKind ?? 'error'}`).join(', ')}`);
      }
      if (runs.some((run) => run.status === 'valid' && run.recoveredForLead === true)) {
        history.push('validated prior checkpoint was shown to the fresh lead for revalidation; earlier delivery was not inherited');
      }
      if (runs.some((run) => run.status === 'valid' && run.findingsDelivered === false && run.recoveredForLead !== true)) {
        history.push('specialist findings for this lens were NOT delivered to the lead (transport overflow); the lead judged without them');
      }
      if (unsettledRetries.length > 0) {
        history.push(`started but unsettled: ${unsettledRetries.join(', ')} (the wave ended before these results committed)`);
      }
      const note = `${verdict} — ${evidence}${history.length > 0 ? ` · ${history.join(' · ')}` : ''}`;
      this.opts.ledger.setLensOutcome(round.id, lens, 'done', note);
      results.push({ state: 'done', verdict, evidence: note });
      // R4-3: a lens counts as settled only AFTER its chip write committed —
      // a throw mid-loop leaves the earlier writes visible in this same
      // (caller-held) accounting object, never an interrupted error for an
      // already-done chip.
      settledLenses.add(lens);
    }
  }

  private lensVerdict(findings: readonly VerifiedFinding[]): 'blocker' | 'warning' | 'note' | 'clean' {
    if (findings.some((finding) => finding.severity === 'blocker')) return 'blocker';
    if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
    if (findings.some((finding) => finding.severity === 'note')) return 'note';
    return 'clean';
  }

  private isCompleteConsolidated(file: string, expectedTargetSha: string): boolean {
    if (!existsSync(file)) return false;
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) return false;
      const bytes = readFileSync(file);
      if (bytes.byteLength !== info.size) return false;
      const parsed = JSON.parse(bytes.toString('utf8')) as {
        schemaVersion?: unknown;
        architecture?: unknown;
        canonicalVerdict?: unknown;
        completeness?: { complete?: unknown; verificationComplete?: unknown };
        complete?: unknown;
        frozen?: { targetSha?: unknown };
        headMoved?: unknown;
        findings?: unknown;
      };
      const complete = parsed.schemaVersion === 3
        ? parsed.complete === true
        : parsed.completeness?.complete === true && parsed.completeness.verificationComplete === true;
      return (parsed.architecture === 'perkins-hybrid' || parsed.architecture === 'perkins-whole-pr') &&
        parsed.frozen?.targetSha === expectedTargetSha &&
        parsed.canonicalVerdict !== 'INCOMPLETE' &&
        complete &&
        parsed.headMoved === false &&
        Array.isArray(parsed.findings);
    } catch {
      return false;
    }
  }

  /** Read the review scope/coverage/debt from a round's preserved consolidated
   * record, authenticated to the posted head. Returns null when the record is
   * absent, unreadable, malformed or bound to a different head — recovery then
   * refuses to promote rather than assume no debt. A legacy record with no
   * convergence block was a whole review and carries no debt. */
  private readPostedReviewState(roundId: string, headSha: string): PostedReviewState | null {
    const consolidated = join(reviewArtifactDirectory(this.artifactRoot(), roundId), 'consolidated.json');
    try {
      const info = lstatSync(consolidated);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) return null;
      const parsed = JSON.parse(readFileSync(consolidated, 'utf8')) as {
        architecture?: unknown;
        schemaVersion?: unknown;
        frozen?: { targetSha?: unknown; diffBaseSha?: unknown };
        findings?: unknown;
        convergence?: { reviewScope?: unknown; coverageComplete?: unknown; finalPassRequired?: unknown; integrationFromSha?: unknown; integrationBaseSha?: unknown };
      };
      if (parsed.architecture !== 'perkins-whole-pr' || parsed.schemaVersion !== 3 || parsed.frozen?.targetSha !== headSha) return null;
      // A legacy record with no convergence block WAS a whole review: it
      // carries no debt and recovers normally.
      if (parsed.convergence === undefined) {
        return { reviewScope: 'whole', coverageComplete: true, finalPassRequired: false };
      }
      // Present-but-unrecognized scope is DAMAGED, never "unknown/debt-free":
      // an empty or malformed convergence block cannot authorize promotion.
      const scope = parsed.convergence.reviewScope;
      if (scope !== 'whole' && scope !== 'delta' && scope !== 'integration') return null;
      const from = parsed.convergence.integrationFromSha;
      const base = parsed.convergence.integrationBaseSha;
      // An integration claim must carry valid, self-consistent linkage.
      if (scope === 'integration') {
        if (typeof from !== 'string' || !/^[0-9a-f]{40}$/u.test(from)) return null;
        if (typeof base !== 'string' || !/^[0-9a-f]{40}$/u.test(base)) return null;
        if (typeof parsed.frozen.diffBaseSha !== 'string' || base !== parsed.frozen.diffBaseSha) return null;
      }
      return {
        reviewScope: scope,
        coverageComplete: parsed.convergence.coverageComplete === true || scope === 'whole',
        finalPassRequired: parsed.convergence.finalPassRequired === true,
        ...(typeof parsed.frozen.diffBaseSha === 'string' ? { diffBaseSha: parsed.frozen.diffBaseSha } : {}),
        ...(typeof from === 'string' ? { integrationFromSha: from } : {}),
        ...(typeof base === 'string' ? { integrationBaseSha: base } : {}),
      };
    } catch {
      return null;
    }
  }

  /** The prior round's NATIVE ledger receipts: the durable
   * `round.perkins-review` fields (identity + scope/coverage/debt) plus the
   * pre-commit `round.final-pass-required` marker presence, and the accepted
   * contract binding recorded on the round's own freeze event. These
   * authenticate a consolidated file's retained-coverage claims. */
  private priorNativeEvidence(round: RoundRecord): { receipt: PriorNativeReceipt; acceptance: PriorAcceptanceBinding | null } {
    const reviewEvent = this.opts.ledger.latestRoundEvent(round.id, 'round.perkins-review');
    const payload = typeof reviewEvent?.payload === 'object' && reviewEvent.payload !== null
      ? reviewEvent.payload as Record<string, unknown>
      : {};
    // A restart-PROMOTED round has no round.perkins-review event; its
    // scope/coverage/debt and retained-finding identity were persisted with
    // the posted event BEFORE delivery and are the authoritative receipt.
    const postedEvent = this.opts.ledger.latestRoundEvent(round.id, 'round.posted');
    const posted = postedEvent === null ? null : parsePostedEventPayload(postedEvent.payload);
    const postedReview = posted?.review;
    const debtMarker = this.opts.ledger.latestRoundEvent(round.id, 'round.final-pass-required') !== null;
    const frozenEvent = this.opts.ledger.latestRoundEvent(round.id, 'round.review-inputs-frozen');
    const frozenPayload = typeof frozenEvent?.payload === 'object' && frozenEvent.payload !== null
      ? frozenEvent.payload as { acceptance?: unknown }
      : {};
    const rawAcceptance = frozenPayload.acceptance;
    const acceptance = typeof rawAcceptance === 'object' && rawAcceptance !== null &&
      typeof (rawAcceptance as { version?: unknown }).version === 'number' &&
      Number.isSafeInteger((rawAcceptance as { version?: number }).version) &&
      typeof (rawAcceptance as { baseSha256?: unknown }).baseSha256 === 'string' &&
      typeof (rawAcceptance as { contractSha256?: unknown }).contractSha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test((rawAcceptance as { contractSha256: string }).contractSha256) &&
      Array.isArray((rawAcceptance as { amendmentIds?: unknown }).amendmentIds) &&
      ((rawAcceptance as { amendmentIds: unknown[] }).amendmentIds).every((id) => typeof id === 'string')
      ? {
          version: (rawAcceptance as { version: number }).version,
          baseSha256: (rawAcceptance as { baseSha256: string }).baseSha256,
          contractSha256: (rawAcceptance as { contractSha256: string }).contractSha256,
          amendmentIds: [...(rawAcceptance as { amendmentIds: string[] }).amendmentIds],
        }
      : null;
    return {
      receipt: {
        targetSha: payload['targetSha'] ?? posted?.targetSha,
        diffBaseSha: payload['diffBaseSha'] ?? postedReview?.diffBaseSha,
        reviewScope: payload['reviewScope'] ?? postedReview?.reviewScope,
        coverageComplete: payload['coverageComplete'] ?? postedReview?.coverageComplete,
        finalPassRequired: payload['finalPassRequired'] === true || debtMarker || postedReview?.finalPassRequired === true,
        blockers: payload['blockers'] ?? postedReview?.blockers,
        retainedFindings: payload['retainedFindings'] ?? postedReview?.retainedFindings,
        retainedFindingsSha256: payload['retainedFindingsSha256'] ?? postedReview?.retainedFindingsSha256,
      },
      acceptance,
    };
  }

  private async sweepReviewWorktree(worktreeId: string): Promise<void> {
    try {
      const result = await this.opts.worktrees.release({ worktreeId });
      if (result.status === 'paused') {
        this.escalate(
          `Review worktree for round ${worktreeId} paused on live processes`,
          'the sweep found live processes rooted in the review tree — acknowledge to finish cleanup',
        );
      }
    } catch (error) {
      this.log('error', 'review worktree sweep failed', { round: worktreeId, error: String(error) });
      this.escalate(`Review worktree for round ${worktreeId} could not be swept`, String(error));
    }
  }
}
