import type { AgentHandle } from '../runtime/types.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LogLevel } from '../logger.js';
import { DEFAULT_REVIEW_CHILDREN } from '../config.js';
import type { JobStatus, LedgerApi, RoundRecord, RoundVerdict } from '../ledger/api.js';
import { requireSafeRecordId } from '../ledger/api.js';
import { isJobTerminal } from '../ledger/states.js';
import type { WorktreeLane, WorktreePort } from './worktree-port.js';
import {
  BranchBusyError,
  findBusyLanes,
  laneIsBusy,
  laneBranch,
  normalizeBranch,
  resolveReviewTargetBranch,
  type BranchIdleBlocker,
  type BranchIdlePhase,
} from './branch-idle.js';
import type { AgentSpawner } from './service.js';
import type { EventBus } from '../events/bus.js';
import type { ResidentReviewRound } from '../runtime/registry.js';
import { settleRetries, type PacingGate, type PacingLease, type RateLimitBackoffPolicy, type RetrySettlement } from '../runtime/pacing.js';
import { isExactOriginBranchSpelling } from '../worktrees/manager.js';
import { deliveredTargetSha } from './silas-driver.js';
import type { CanonicalReviewVerdict, VerifiedFinding } from './perkins-review/types.js';
import { PerkinsWholeReview, type PerkinsWholeResult, type RoundBudgetRefusal } from './perkins-review/whole.js';
import { loadPerkinsPolicy, type PerkinsLens, type PerkinsPolicy } from './perkins-review/policy.js';
import {
  freezeReviewInputs,
  refMovedSinceFreeze,
  sourceMovementSinceFreeze,
  resolveGitCommit,
  resolveReviewBaseRef,
  reviewArtifactDirectory,
  writeReviewArtifact,
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
} from '../review-inputs/ci-evidence.js';
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
  VERIFICATION_COMPLETED_EVENT,
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
    readonly specialistRuns: ReadonlyArray<{ readonly lens: string; readonly status: string; readonly findingsDelivered?: boolean; readonly cleanupRecordingError?: string; readonly evidenceRecordingError?: string; readonly progressError?: string }>;
    readonly priorDispositions: ReadonlyArray<{ readonly status: string }>;
    readonly budgetRefusals?: ReadonlyArray<RoundBudgetRefusal>;
  },
  provider: PublicationProviderKind,
  /** The round's APPLICABLE catalog (full or explicit no-spec): the
   * not-used accounting is derived from what this round could run, never
   * from a historical or future catalog. */
  lenses: readonly string[],
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
  const byLens = new Map<string, { valid: number; failed: number; undelivered: boolean; cleanupGap: boolean; evidenceGap: boolean; progressGap: boolean }>();
  for (const run of review.specialistRuns) {
    const entry = byLens.get(run.lens) ?? { valid: 0, failed: 0, undelivered: false, cleanupGap: false, evidenceGap: false, progressGap: false };
    if (run.status === 'valid') entry.valid += 1;
    else entry.failed += 1;
    if (run.findingsDelivered === false) entry.undelivered = true;
    if (run.cleanupRecordingError !== undefined) entry.cleanupGap = true;
    if (run.evidenceRecordingError !== undefined) entry.evidenceGap = true;
    if (run.progressError !== undefined) entry.progressGap = true;
    byLens.set(run.lens, entry);
  }
  const ran = [...byLens.entries()].sort(([left], [right]) => left.localeCompare(right));
  const failed = ran.filter(([, entry]) => entry.failed > 0);
  const undelivered = ran.filter(([, entry]) => entry.undelivered);
  const cleanupGaps = ran.filter(([, entry]) => entry.cleanupGap);
  const evidenceGaps = ran.filter(([, entry]) => entry.evidenceGap);
  const progressGaps = ran.filter(([, entry]) => entry.progressGap);
  const notUsed = lenses.filter((lens) => !byLens.has(lens));
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
    `- Specialists run: ${ran.length === 0 ? 'none (lead-owned whole-change review)' : ran.map(([lens, entry]) => `${lens}${entry.failed > 0 ? ` (attempts: ${entry.valid} valid, ${entry.failed} failed)` : ''}`).join(', ')}`,
    ...(failed.length > 0 ? [`- Failed specialist attempts: ${failed.map(([lens, entry]) => `${lens} ×${entry.failed}`).join(', ')} — the lead judged the change on its own whole-change verification`] : []),
    ...(review.budgetRefusals !== undefined && review.budgetRefusals.length > 0
      ? [`- Round specialist budget: ${review.budgetRefusals.length} run call(s) refused by the ${review.budgetRefusals[0]!.cap}-run cap before any child started (${[...new Set(review.budgetRefusals.flatMap((refusal) => refusal.lenses))].join(', ')})`]
      : []),
    ...(undelivered.length > 0 ? [`- Specialist findings were NOT delivered to the lead: ${undelivered.map(([lens]) => lens).join(', ')} — those runs completed but the transport response failed, so the lead judged without their findings`] : []),
    ...(cleanupGaps.length > 0 ? [`- Specialist cleanup failures that could not be recorded durably: ${cleanupGaps.map(([lens]) => lens).join(', ')}`] : []),
    ...(evidenceGaps.length > 0 ? [`- Specialist evidence recording gaps: ${evidenceGaps.map(([lens]) => lens).join(', ')} — those runs stand, but at least one of their evidence artifacts could not be written; the sealed run record carries the reason`] : []),
    ...(progressGaps.length > 0 ? [`- Specialist progress observer failures: ${progressGaps.map(([lens]) => lens).join(', ')} — the runs stand, but their progress report could not be published; the sealed run record carries the reason`] : []),
    ...(notUsed.length > 0 ? [`- Lenses not used this round: ${notUsed.join(', ')}`]: []),
    ...(prior.length > 0 ? [`- Prior findings revisited: ${prior.length} (${priorFixed} fixed, ${priorStill} still present)`] : []),
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
): string {
  const body = `${reportText.trimEnd()}\n\n${hostDisclosureAppendix(review, provider, lenses)}\n`;
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
    receipt: {
      reviewId: receipt['reviewId'], actor: receipt['actor'], event: receipt['event'],
      commitId: commitId as string | null, headSha: receipt['headSha'], baseSha: receipt['baseSha'],
      bodySha256: receipt['bodySha256'],
    },
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

  constructor(opts: WaveRunnerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
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
      if ((started?.seq ?? 0) > queued.seq || (failed?.seq ?? 0) > queued.seq) continue;
      if (this.handoffs.has(job.id)) continue;
      // A terminal job or a swept lane can never admit this handoff: skip
      // truthfully (no failure, no escalation) instead of a spurious retry.
      const jobNow = this.opts.ledger.getJob(job.id);
      if (jobNow !== null && (jobNow.status === 'merged' || jobNow.status === 'done')) {
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
        this.opts.escalate?.(`Queued review handoff for job ${job.id} needs reconciliation`, error, { jobId: job.id });
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
        this.opts.escalate?.(`Queued review handoff failed for job ${job.id}`, error, { jobId: job.id });
        continue;
      }
      const pending = this.trackHandoff(input as { jobId: string }, queued.seq);
      const startedFor = (started?.payload as { requestSeq?: number } | null)?.requestSeq;
      if (startedFor !== undefined && startedFor !== queued.seq) {
        // A terminal marker for a DIFFERENT request does not satisfy this one.
      }
      const delivered = this.opts.ledger.latestJobEvent(job.id, 'job.delivered');
      if (delivered !== null && delivered.seq > queued.seq) void this.startHandoff(job.id, pending);
    }
  }

  async shutdown(): Promise<void> {
    this.stopHandoffListener();
    for (const pending of this.handoffs.values()) pending.resolve();
    this.handoffs.clear();
    this.shuttingDown = true;
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
        this.opts.escalate?.(
          'Perkins review shutdown deadline exceeded',
          `${this.activeOperations.size} review operation(s) ignored cancellation; forcing shutdown. Rounds terminalize as INCOMPLETE via startup recovery.`,
        );
        return;
      }
    }
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

  private writeInterruptedArtifacts(roundId: string, reason: string, note: string): {
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
      const contents = `# Perkins Code Review\n\n**Verdict: INCOMPLETE**\n\n${note}. Rerun a complete review against a newly frozen target.\n`;
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
      this.opts.ledger.setRoundVerdict(round.id, postedVerdict);
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
    this.opts.escalate?.(
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
      this.abortRound(round, note);
      const artifacts = this.writeInterruptedArtifacts(round.id, 'service_restart', note);
      this.opts.ledger.appendCustomEvent({
        kind: 'round.perkins-incomplete',
        jobId: round.jobId,
        roundId: round.id,
        payload: { reason: 'service_restart', artifactDirectory: artifacts.directory, reportFile: artifacts.reportFile },
      });
      this.opts.escalate?.(`Review round ${round.id} is INCOMPLETE after service restart`, note, { jobId: round.jobId, roundId: round.id });
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
        this.opts.escalate?.(
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
        this.abortRound(round, note);
        const artifacts = this.writeInterruptedArtifacts(round.id, 'service_restart_missing_review_lane', note);
        this.opts.ledger.appendCustomEvent({
          kind: 'round.perkins-incomplete',
          jobId: round.jobId,
          roundId: round.id,
          payload: {
            reason: 'service_restart_missing_review_lane',
            artifactDirectory: artifacts.directory,
            reportFile: artifacts.reportFile,
          },
        });
        this.opts.escalate?.(`Review round ${round.id} is INCOMPLETE after service restart`, note, { jobId: round.jobId, roundId: round.id });
        recovered += 1;
      }
    }
    return recovered;
  }

  private abortRound(round: RoundRecord, note: string): void {
    for (const chip of round.lenses) {
      if (chip.state === 'pending' || chip.state === 'live') {
        this.opts.ledger.setLensOutcome(round.id, chip.lens, 'error', note);
      }
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
    /** Worker tool handoff: acknowledge without waiting for its own turn. */
    handoff?: boolean;
    /** Internal replay marker; never accepted from the public HTTP endpoint. */
    fromHandoff?: boolean;
  }): Promise<ReviewRequestOutcome> {
    if (this.shuttingDown) throw new Error('Perkins review service is shutting down');
    // Branch-idle still gates the freeze. A minion's own busy turn may
    // acknowledge an intent now; it is armed only after job.delivered.
    try {
      this.enforceBranchIdleForRequest(input);
    } catch (error) {
      if (!(error instanceof BranchBusyError) || input.handoff !== true || input.force === true ||
        error.blockers.length === 0 || error.blockers.some((blocker) => blocker.jobId !== input.jobId)) throw error;
      if (this.opts.bus === undefined) throw new Error('worker review handoff requires a ledger event bus');
      const existing = this.handoffs.get(input.jobId);
      if (existing !== undefined) {
        // First-wins, but never silent: a differing duplicate records its
        // exact folded scope as a truthful conflict outcome.
        const differs =
          (input.lenses !== undefined && JSON.stringify(input.lenses) !== JSON.stringify((existing.input as { lenses?: readonly string[] }).lenses ?? undefined)) ||
          (input.targetRef !== undefined && input.targetRef !== (existing.input as { targetRef?: string }).targetRef) ||
          (input.noSpec !== undefined && input.noSpec !== (existing.input as { noSpec?: boolean }).noSpec) ||
          (input.evidence !== undefined && JSON.stringify(input.evidence) !== JSON.stringify((existing.input as { evidence?: readonly ReviewEvidenceRequest[] }).evidence ?? undefined));
        if (differs) {
          this.opts.ledger.appendCustomEvent({
            kind: 'job.review-handoff-conflict', jobId: input.jobId,
            payload: { requestSeq: existing.seq, folded: {
              ...(input.lenses !== undefined ? { lenses: input.lenses } : {}),
              ...(input.targetRef !== undefined ? { targetRef: input.targetRef } : {}),
              ...(input.noSpec !== undefined ? { noSpec: input.noSpec } : {}),
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
    const begun = await this.beginPerkinsRound({ ...input, reviewModel: result.reviewModel });
    return { route: 'perkins', round: begun.round, run: begun.run };
  }

  private trackHandoff(input: { jobId: string; targetRef?: string; lenses?: readonly string[]; noSpec?: boolean; force?: boolean; evidence?: readonly ReviewEvidenceRequest[] }, seq: number) {
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
        this.opts.escalate?.(
          `Queued review handoff for job ${jobId} is held`,
          `The durable review request can no longer be authorized automatically: job status is ${error.status}. Re-request the review after the hold clears.`,
          { jobId },
        );
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
        this.opts.escalate?.(`Queued review handoff failed for job ${jobId}`, String(error), { jobId });
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
  }): Promise<{ readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }> {
    this.enforceBranchIdleForRequest(input);
    let reviewModel: ReviewPreflightResult['reviewModel'];
    if (this.opts.reviewPreflight !== undefined) {
      const repoPath = this.resolveReviewRequestRepo(input);
      if (repoPath !== null) {
        const result = await this.opts.reviewPreflight({ repoPath });
        if (!result.ok) throw new FallbackGateRequiredError(result.failures);
        reviewModel = result.reviewModel;
      }
    }
    return this.beginPerkinsRound({ ...input, reviewModel });
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
    if (
      jobNow !== null &&
      !isJobTerminal(jobNow.status) &&
      !blockers.some((blocker) => blocker.jobId === input.job.id) &&
      this.opts.ledger.listPendingRebriefs({ jobId: input.job.id }).length > 0
    ) {
      blockers.push({
        jobId: input.job.id,
        status: jobNow.status,
        branch: input.jobLane?.branch != null && input.jobLane.branch.trim() !== ''
          ? normalizeBranch(input.jobLane.branch)
          : laneBranch(input.job.id),
      });
    }
    if (blockers.length === 0 && input.force !== true) return { targetBranch, blockers };
    this.opts.ledger.appendCustomEvent({
      kind: input.force === true ? 'branch-idle.forced' : 'branch-idle.refused',
      jobId: input.job.id,
      ...(input.roundId !== undefined ? { roundId: input.roundId } : {}),
      payload: { phase: input.phase, forced: input.force === true, targetBranch, blockers },
    });
    if (input.force !== true) throw new BranchBusyError(targetBranch, blockers, input.phase);
    return { targetBranch, blockers };
  }

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
    reviewModel?: ReviewPreflightResult['reviewModel'];
  }): Promise<{ readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }> {
    if (this.shuttingDown) throw new Error('Perkins review service is shutting down');
    const controller = new AbortController();
    return this.track(this.setupRound(input, controller.signal), controller);
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
    const job = this.opts.ledger.getJob(input.jobId);
    if (job === null || repoPath === null) throw new Error(`job "${input.jobId}" not found — nothing to review`);
    if (job.status === 'merged' || job.status === 'done') {
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
      const guidance = `Options: (1) install the BMAD review skill via onboarding; (2) restore the Perkins gate — ${failedLegs.map((leg) => leg.remediation).join(' ')}`;
      const message = `${note} ${guidance}`;
      this.opts.ledger.appendCustomEvent({
        kind: 'job.fallback-review',
        jobId: job.id,
        payload: { phase: 'unavailable', gate: true, skillInstalled: present, failedLegs, note },
      });
      this.opts.escalate?.(
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
    const run = this.track(
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
    this.opts.escalate?.(
      `Perkins gate unavailable for job ${job.id} — the bmad-review gate is engaged`,
      failedLegs.map((leg) => `${leg.leg}: ${leg.detail}`).join('; '),
      { jobId: job.id },
    );
    let blockers = 0;
    let notes = 0;
    for (let iteration = 1; iteration <= maxRounds; iteration += 1) {
      if (signal.aborted) throw new Error('review operation aborted');
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
        this.opts.escalate?.(
          `bmad-review gate PASS for job ${job.id} — clear to merge (merge stays user-held)`,
          `${notes} note(s) across ${iteration} review round(s). Reports: ${state.reportFiles.join(', ')}`,
          { jobId: job.id },
        );
        return;
      }
      if (iteration === maxRounds) break;
      let delivery: { readonly delivered: boolean; readonly minionId?: string; readonly note?: string };
      try {
        delivery = await gate.fixDirectiveSink({
          jobId: job.id,
          directive: renderFixDirective(triaged.blockers, iteration),
          blockers: triaged.blockers,
          iteration,
          signal,
        });
      } catch (error) {
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

  private terminalFallbackBlocked(
    jobId: string,
    reason: string,
    iterations: number,
    reports: readonly string[],
    fallbackEvent: (payload: Record<string, unknown>) => void,
    state?: FallbackGateState,
  ): void {
    if (state !== undefined) {
      state.iterations = iterations;
      state.note = `bmad-review gate blocked: ${reason}`;
    }
    fallbackEvent({ phase: 'blocked', iterations, reason, reports, clearToMerge: false });
    this.opts.escalate?.(
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
    if (state !== undefined) state.note = `bmad-review gate aborted: ${reason}`;
    fallbackEvent({ phase: 'aborted', iteration, reason, reports, clearToMerge: false });
    this.opts.escalate?.(
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
    reviewModel?: ReviewPreflightResult['reviewModel'];
  }, setupSignal: AbortSignal): Promise<{ readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }> {
    if (this.shuttingDown || setupSignal.aborted) throw new Error('Perkins review service is shutting down');
    const policy = (this.opts.reviewPolicyLoader ?? loadPerkinsPolicy)();
    const job = this.opts.ledger.getJob(input.jobId);
    if (job === null) throw new Error(`job "${input.jobId}" not found — nothing to review`);
    if (job.status === 'merged' || job.status === 'done') {
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
        const evidence = renderRecordedVerification(
          this.opts.ledger.latestJobEvent(job.id, VERIFICATION_COMPLETED_EVENT),
          targetSha,
        );
        if (evidence !== null) {
          spec = appendRecordedVerification({
            spec,
            evidence,
            log: (level, msg, fields) => this.log(level, msg, { job: job.id, ...fields }),
          });
        }
        spec = appendCiEvidence({
          spec,
          block: ci.block,
          maxBytes: FROZEN_SPEC_MAX_BYTES,
          log: (level, msg, fields) => this.log(level, msg, { job: job.id, ...fields }),
        });
      }
    };
    const flippedFrom = job.status === 'working' || job.status === 'blocked' ? job.status : null;
    let round: RoundRecord;
    try {
      if (flippedFrom !== null) this.opts.ledger.setJobStatus(job.id, 'in-review');
      round = this.opts.ledger.addRound({ jobId: job.id, lenses: canonicalLenses, targetRef: targetSha });
    } catch (error) {
      if (flippedFrom !== null && !isJobTerminal(this.opts.ledger.getJob(job.id)?.status ?? job.status)) {
        this.opts.ledger.setJobStatus(job.id, flippedFrom);
      }
      throw error;
    }

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
        throw new Error('Perkins review service shut down during review setup');
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
      frozenReview = freezeReviewInputs({
        roundId: round.id,
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
      if (this.opts.reserveReviewRound === undefined) this.opts.ledger.setRoundStatus(round.id, 'live');
    } catch (error) {
      const failures: unknown[] = [error];
      const interrupted = this.shuttingDown || setupSignal.aborted;
      try {
        if (interrupted) {
          const note = 'review setup interrupted by service shutdown; frozen proof is incomplete';
          this.abortRound(this.opts.ledger.getRound(round.id) ?? round, note);
          const artifacts = this.writeInterruptedArtifacts(round.id, 'service_shutdown_setup', note);
          this.opts.ledger.appendCustomEvent({
            kind: 'round.perkins-incomplete',
            jobId: job.id,
            roundId: round.id,
            payload: {
              reason: 'service_shutdown_setup',
              artifactDirectory: artifacts.directory,
              reportFile: artifacts.reportFile,
            },
          });
        } else {
          this.opts.ledger.setRoundStatus(round.id, 'aborted');
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
          this.opts.ledger.setJobStatus(job.id, flippedFrom);
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
    const run = this.track(
      this.runBuiltInReview(
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
      ),
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
        this.opts.escalate?.(
          `Perkins review for job ${input.job.id} was blocked before any round: the PR head could not be verified`,
          detail,
          { jobId: input.job.id },
        );
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
  ): Promise<WaveOutcome> {
    let reservation: ResidentReviewRound | undefined;
    let settledOutcome: WaveOutcome | null = null;
    try {
      reservation = this.opts.reserveReviewRound === undefined
        ? undefined : await this.opts.reserveReviewRound(signal);
      if (reservation !== undefined) {
        if (signal.aborted) {
          await reservation.close();
          throw new Error('review cancelled before admission');
        }
        this.opts.ledger.setRoundStatus(round.id, 'live');
        this.opts.ledger.appendCustomEvent({
          kind: 'round.residency-admitted', jobId: job.id, roundId: round.id,
          payload: { reason: 'lead and child resident slots admitted' },
        });
      }
      const outcome = await this.runOwnedReview(job, round, lenses, movementRef, noSpec, frozenReview, policy, signal, reviewModel, reservation);
      settledOutcome = outcome;
      return outcome;
    } catch (error) {
      if (this.opts.ledger.getRound(round.id)?.status === 'pending') {
        this.abortRound(this.opts.ledger.getRound(round.id) ?? round, `review admission cancelled: ${String(error)}`);
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
          this.opts.escalate?.(
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
    reviewModel?: ReviewPreflightResult['reviewModel'],
    reservation?: ResidentReviewRound,
  ): Promise<WaveOutcome> {
    // The model-resolution closure belongs to one round. A concurrent
    // preflight cannot replace the proof used by its lead or specialist
    // children, and a reserved round routes through its own admission.
    const spawnWithOptions: AgentSpawner = (role, options) => {
      if (reservation !== undefined && role !== 'perkins') {
        throw new Error(`review reservation spawns perkins sessions only, got role "${role}"`);
      }
      const resolved = {
        ...options,
        ...(reviewModel !== undefined && (options?.isolatedReview !== undefined || options?.reviewLead !== undefined)
          ? { reviewModel } : {}),
      };
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
      // silently presenting an older past as the whole history.
      let priorConsolidatedFile: string | undefined;
      const newestPredecessor = this.opts.ledger
        .listRounds(job.id)
        .filter((candidate) =>
          candidate.seq < round.seq && candidate.status === 'verdict-posted' && candidate.verdict !== null &&
          this.opts.ledger.latestRoundEvent(candidate.id, 'round.perkins-review') !== null,
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
      review = await workflow.run({
        roundId: round.id,
        roundNumber: round.seq,
        movementRef,
        noSpec,
        frozenReview,
        signal,
        ...(priorConsolidatedFile !== undefined ? { priorConsolidatedFile } : {}),
      });
    } catch (error) {
      const detail = `Perkins whole-PR workflow failed: ${String(error).replace(/[\r\n]+/gu, ' ').slice(0, 500)}`;
      this.abortRound(this.opts.ledger.getRound(round.id) ?? round, detail.slice(0, 500));
      const errorArtifact = join(frozenReview.directory, 'workflow-error.json');
      if (!existsSync(errorArtifact)) {
        writeFileSync(errorArtifact, `${JSON.stringify({ schemaVersion: 1, canonicalVerdict: 'INCOMPLETE', error: detail.slice(0, 500) }, null, 2)}\n`, {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        });
      }
      const incompleteContents = `# Perkins Code Review\n\n**Verdict: INCOMPLETE**\n\n${detail.slice(0, 500)}\n`;
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
        payload: { reason: signal.aborted ? 'cancelled' : 'workflow_error', error: detail.slice(0, 500), reportFile },
      });
      this.opts.escalate?.(`Review round ${round.id} is INCOMPLETE`, detail, { jobId: job.id, roundId: round.id });
      return {
        round: this.opts.ledger.getRound(round.id) as RoundRecord,
        results: lenses.map(() => ({ state: 'error' as const, note: detail })),
        verdict: null,
        posted: false,
        canonicalVerdict: 'INCOMPLETE',
        reportFile,
        artifactDirectory: frozenReview.directory,
        headMoved: refMovedSinceFreeze(frozenReview),
      };
    }

    try {
      if (signal.aborted) throw new Error('review operation aborted before finalization');
      const results = this.recordLensResults(round, lenses, review);
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
          publicationBody = publicationBodyFor(readFileSync(reportFile, 'utf8'), review, providerKind, lenses);
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
        };
        // R34 writer/reader symmetry invariant: the event about to be
        // persisted MUST parse through the SAME shared contract restart
        // recovery reads. A receipt shape the reader would reject is
        // refused here instead of becoming a round that can never recover.
        if (parsePostedEventPayload(postedPayload) === null) {
          throw new Error('internal: refusing to persist a round.posted payload that restart recovery cannot parse');
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
                this.opts.escalate?.(
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
          this.opts.escalate?.(
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
      this.opts.escalate?.(
        `Perkins report for round ${round.id} was recorded but has NO pull request to publish to`,
        'the job has no pull request link; a conclusive review cannot be published',
        { jobId: round.jobId, roundId: round.id },
      );
    } else if (canonical !== 'INCOMPLETE' && job.prUrl !== null) {
      deliveryError = new Error('the PR poster is unavailable');
      this.opts.escalate?.(
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
      this.opts.ledger.appendCustomEvent({
        kind: 'round.perkins-review',
        jobId: job.id,
        roundId: round.id,
        payload: {
          canonicalVerdict: canonical,
          // Blocker count for the operator-visible record (the awareness
          // digest renders it as "verdict with N blocker(s)").
          blockers: review.findings.filter((finding) => finding.severity === 'blocker').length,
          targetSha: review.targetSha,
          baseRefSha: frozenReview.manifest.baseRefSha,
          diffBaseSha: review.diffBaseSha,
          artifactDirectory: review.artifactDirectory,
          reportFile,
          headMoved,
          complete: canonical !== 'INCOMPLETE' && !headMoved,
        },
      });
      this.opts.ledger.setRoundVerdict(round.id, recordedVerdict);
    } else {
      this.opts.ledger.setRoundStatus(round.id, 'aborted');
      this.opts.ledger.appendCustomEvent({
        kind: 'round.perkins-incomplete',
        jobId: job.id,
        roundId: round.id,
        payload: {
          reason: verdict === null ? 'review_incomplete' : deliveryFailureKind,
          reportFile,
          ...(deliveryError !== undefined ? { error: String(deliveryError).slice(0, 500) } : {}),
        },
      });
      this.opts.escalate?.(
        `Review round ${round.id} is INCOMPLETE`,
        `coverage of the round's selected lenses, verification, source stability, or delivery proof did not complete. Report: ${reportFile}`,
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
    };
    } catch (error) {
      return this.finalizationIncomplete(job, round, lenses, frozenReview, error);
    }
  }

  private finalizationIncomplete(
    job: { readonly id: string },
    round: RoundRecord,
    lenses: readonly PerkinsLens[],
    frozenReview: FrozenReview,
    error: unknown,
  ): WaveOutcome {
    const detail = `Perkins finalization failed: ${String(error)}`.replace(/[\r\n]+/gu, ' ').slice(0, 500);
    try {
      this.abortRound(this.opts.ledger.getRound(round.id) ?? round, detail);
    } catch (ledgerError) {
      this.log('error', 'could not terminalize failed Perkins round in ledger', {
        round: round.id, error: String(ledgerError),
      });
    }
    const reportFile = join(frozenReview.directory, 'perkins-report.finalization-incomplete.md');
    try {
      if (!existsSync(reportFile)) {
        writeFileSync(
          reportFile,
          `# Perkins Code Review\n\n**Verdict: INCOMPLETE**\n\n${detail}\n`,
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
        payload: { reason: 'finalization_error', error: detail, reportFile },
      });
    } catch (ledgerError) {
      this.log('error', 'could not persist finalization INCOMPLETE event', {
        round: round.id, error: String(ledgerError),
      });
    }
    this.opts.escalate?.(`Review round ${round.id} is INCOMPLETE`, detail, { jobId: job.id, roundId: round.id });
    let moved = true;
    try {
      moved = refMovedSinceFreeze(frozenReview);
    } catch {
      // Unknown source state is fail-closed movement.
    }
    return {
      round: this.opts.ledger.getRound(round.id) ?? { ...round, status: 'aborted' },
      results: lenses.map(() => ({ state: 'error' as const, note: detail })),
      verdict: null,
      posted: false,
      canonicalVerdict: 'INCOMPLETE',
      reportFile,
      artifactDirectory: frozenReview.directory,
      headMoved: moved,
    };
  }

  private recordLensResults(
    round: RoundRecord,
    lenses: readonly PerkinsLens[],
    review: PerkinsWholeResult,
  ): ReviewLensResult[] {
    const results: ReviewLensResult[] = [];
    for (const lens of lenses) {
      const runs = review.specialistRuns.filter((run) => run.lens === lens);
      if (runs.length === 0) {
        // Whole-PR review: the lead owns the review; a lens it never used is
        // a truthful 'not used', never missing required coverage.
        const note = 'not used — lead-owned whole-PR review';
        this.opts.ledger.setLensOutcome(round.id, lens, 'done', note);
        results.push({ state: 'done', verdict: 'clean', evidence: note });
        continue;
      }
      const failed = runs.filter((run) => run.status !== 'valid');
      if (failed.length === runs.length) {
        // Every attempt on this lens failed: honest execution error, named
        // per attempt. The lead's own review still stands apart from it.
        const note = `specialist attempts failed: ${failed.map((run) => `a${run.attempt} ${run.failureKind ?? 'error'}: ${(run.error ?? 'no host-recorded reason').slice(0, 200)}`).join('; ')}`;
        this.opts.ledger.setLensOutcome(round.id, lens, 'error', note);
        results.push({ state: 'error', note });
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
      if (runs.some((run) => run.status === 'valid' && run.findingsDelivered === false)) {
        history.push('specialist findings for this lens were NOT delivered to the lead (transport overflow); the lead judged without them');
      }
      const note = `${verdict} — ${evidence}${history.length > 0 ? ` · ${history.join(' · ')}` : ''}`;
      this.opts.ledger.setLensOutcome(round.id, lens, 'done', note);
      results.push({ state: 'done', verdict, evidence: note });
    }
    return results;
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

  private async sweepReviewWorktree(worktreeId: string): Promise<void> {
    try {
      const result = await this.opts.worktrees.release({ worktreeId });
      if (result.status === 'paused') {
        this.opts.escalate?.(
          `Review worktree for round ${worktreeId} paused on live processes`,
          'the sweep found live processes rooted in the review tree — acknowledge to finish cleanup',
        );
      }
    } catch (error) {
      this.log('error', 'review worktree sweep failed', { round: worktreeId, error: String(error) });
      this.opts.escalate?.(`Review worktree for round ${worktreeId} could not be swept`, String(error));
    }
  }
}
