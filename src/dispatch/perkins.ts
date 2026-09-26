import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { JobStatus, LedgerApi, RoundRecord, RoundVerdict } from '../ledger/api.js';
import { requireSafeRecordId } from '../ledger/api.js';
import type { WorktreeLane, WorktreePort } from './worktree-port.js';
import {
  BranchBusyError,
  findBusyLanes,
  resolveReviewTargetBranch,
  type BranchIdleBlocker,
  type BranchIdlePhase,
} from './branch-idle.js';
import type { AgentSpawner } from './service.js';
import type { CanonicalReviewVerdict, VerifiedFinding } from './perkins-review/types.js';
import { PerkinsWholeReview, type PerkinsWholeResult } from './perkins-review/whole.js';
import { loadPerkinsPolicy, type PerkinsLens, type PerkinsPolicy } from './perkins-review/policy.js';
import {
  freezeReviewInputs,
  refMovedSinceFreeze,
  resolveGitCommit,
  resolveReviewBaseRef,
  reviewArtifactDirectory,
  writeReviewArtifact,
  type FrozenReview,
} from './perkins-review/artifacts.js';
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

/** Compact host-owned factual appendix for the published body: retained
 * findings and execution facts (specialists ran/failed/not-used, prior
 * dispositions) assembled deterministically from the structured result, so
 * PR readers receive the real outcome regardless of the lead's prose. No
 * model transcription is involved; substantive judgment stays with the
 * reviewer. */
export function hostDisclosureAppendix(review: {
  readonly findings: ReadonlyArray<{ readonly severity: string; readonly title: string; readonly location: string; readonly source: string }>;
  readonly specialistRuns: ReadonlyArray<{ readonly lens: string; readonly status: string }>;
  readonly priorDispositions: ReadonlyArray<{ readonly status: string }>;
}): string {
  const counts = new Map<string, number>();
  for (const finding of review.findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const severityLine = ['blocker', 'warning', 'note']
    .filter((severity) => (counts.get(severity) ?? 0) > 0)
    .map((severity) => `${counts.get(severity)} ${severity}`)
    .join(', ');
  const findingsLines = review.findings.length === 0
    ? ['- none retained']
    : review.findings.slice(0, 50).map((finding) =>
        `- [${finding.severity}] ${finding.title} — ${finding.location} (source: ${finding.source})`);
  const byLens = new Map<string, { valid: number; failed: number }>();
  for (const run of review.specialistRuns) {
    const entry = byLens.get(run.lens) ?? { valid: 0, failed: 0 };
    if (run.status === 'valid') entry.valid += 1;
    else entry.failed += 1;
    byLens.set(run.lens, entry);
  }
  const ran = [...byLens.entries()].sort(([left], [right]) => left.localeCompare(right));
  const failed = ran.filter(([, entry]) => entry.failed > 0);
  const notUsed = ['blind', 'edge', 'acceptance', 'security', 'architecture', 'codebase', 'tests']
    .filter((lens) => !byLens.has(lens));
  const prior = review.priorDispositions;
  const priorFixed = prior.filter((disposition) => disposition.status === 'fixed').length;
  const priorStill = prior.length - priorFixed;
  return [
    '---',
    '',
    '## Execution and findings (host-recorded facts)',
    '',
    `- Retained findings: ${review.findings.length}${severityLine === '' ? '' : ` (${severityLine})`}`,
    ...findingsLines,
    `- Specialists run: ${ran.length === 0 ? 'none (lead-owned whole-change review)' : ran.map(([lens, entry]) => `${lens}${entry.failed > 0 ? ` (attempts: ${entry.valid} valid, ${entry.failed} failed)` : ''}`).join(', ')}`,
    ...(failed.length > 0 ? [`- Failed specialist attempts: ${failed.map(([lens, entry]) => `${lens} ×${entry.failed}`).join(', ')} — the lead judged the change on its own whole-change verification`] : []),
    ...(notUsed.length > 0 ? [`- Lenses not used this round: ${notUsed.join(', ')}`]: []),
    ...(prior.length > 0 ? [`- Prior findings revisited: ${prior.length} (${priorFixed} fixed, ${priorStill} still present)`] : []),
    '- Publication: authenticated COMMENT review on the reviewed commit by the service posting account; the substantive verdict is the independent review judgment recorded in this report, not a formal GitHub APPROVED/CHANGES_REQUESTED event.',
  ].join('\n');
}

type ReviewLensResult =
  | { readonly state: 'done'; readonly verdict: 'blocker' | 'warning' | 'note' | 'clean'; readonly evidence: string }
  | { readonly state: 'error'; readonly note: string };

/** The PR identity a verdict delivery was proven against. HEAD equality is
 * the delivery invariant: `headSha` is the round's frozen target on any
 * successful delivery, while `baseSha` is the PR's LIVE base at delivery —
 * a pinned PR base is recorded at open/link time and is expected to trail
 * a moving main, so base age never gates delivery. The receipt is what the
 * ledger refreshes the round's recorded delivery identity from. */
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

export interface VerdictPoster {
  post(input: VerdictPosterInput): Promise<PostedReviewReceipt>;
  /** Idempotent reconciliation for an ambiguous post (e.g. a timeout after
   * the provider may have committed): find an already-published review for
   * this exact head whose body digest matches, or return null. Never
   * creates anything. Optional: a poster without provider lookup leaves an
   * ambiguous failure honestly unposted. */
  reconcile?(input: VerdictPosterInput): Promise<PostedReviewReceipt | null>;
}

function receiptDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
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

  async post(input: VerdictPosterInput): Promise<PostedReviewReceipt> {
    const { apiPath, observedHead, observedBase } = this.githubPrIdentity(input);
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
    const reviewId = created.id !== undefined ? String(created.id) : '';
    const actor = typeof created.user?.login === 'string' ? created.user.login : '';
    const event = typeof created.state === 'string' ? created.state : '';
    const commitId = typeof created.commit_id === 'string' ? created.commit_id : null;
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
   * to the frozen head whose body is byte-identical to ours. Read-only. */
  async reconcile(input: VerdictPosterInput): Promise<PostedReviewReceipt | null> {
    const { apiPath, observedHead, observedBase } = this.githubPrIdentity(input);
    const listed = spawnSync(
      this.binary,
      ['api', '--hostname', input.host, `${apiPath}/reviews?per_page=100`],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (listed.error !== undefined || listed.status !== 0) {
      throw new Error(`gh api review reconciliation query failed (${(listed.stderr ?? String(listed.error ?? '')).trim().slice(0, 300)})`);
    }
    let reviews: ReadonlyArray<{ id?: unknown; user?: { login?: unknown }; state?: unknown; commit_id?: unknown; body?: unknown }>;
    try {
      const parsed = JSON.parse((listed.stdout ?? '').trim()) as unknown;
      if (!Array.isArray(parsed)) throw new Error('not an array');
      reviews = parsed as typeof reviews;
    } catch {
      throw new Error('gh api review reconciliation response was not a review list');
    }
    const matches = reviews.filter((review) =>
      review.commit_id === input.targetSha &&
      typeof review.body === 'string' && receiptDigest(review.body) === receiptDigest(input.body));
    if (matches.length === 0) return null;
    const found = matches[matches.length - 1]!;
    return verifyPostedReceipt(
      {
        reviewId: found.id !== undefined ? String(found.id) : '',
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

  constructor(options: GitLabMrPosterOptions = {}) {
    this.token = options.token;
    this.tokenResolver = options.tokenResolver ?? (() => process.env['GITLAB_TOKEN'] ?? process.env['GL_TOKEN']);
    this.fetchImpl = options.fetchImpl ?? (fetch as never);
    this.gitBinary = options.gitBinary ?? 'git';
  }

  async post(input: VerdictPosterInput): Promise<PostedReviewReceipt> {
    const { mrUrl, headers } = await this.gitLabIdentity(input);
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
    const reviewId = created.id !== undefined ? String(created.id) : '';
    const actor = typeof created.author?.username === 'string' ? created.author.username : '';
    const echoedBody = typeof created.body === 'string' ? created.body : null;
    if (echoedBody === null || receiptDigest(echoedBody) !== receiptDigest(input.body)) {
      throw new Error('provider receipt body does not match the published body — delivery not recorded');
    }
    const confirmed = await this.confirmHead(mrUrl, headers, input.targetSha);
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

  /** Ambiguous-post reconciliation: find an existing note byte-identical to
   * ours on the same head. Read-only. */
  async reconcile(input: VerdictPosterInput): Promise<PostedReviewReceipt | null> {
    const { mrUrl, headers } = await this.gitLabIdentity(input);
    let listResponse: Awaited<ReturnType<typeof this.fetchImpl>>;
    try {
      listResponse = await this.fetchImpl(`${mrUrl}/notes?per_page=100`, {
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
    const matches = notes.filter((note) => typeof note.body === 'string' && receiptDigest(note.body) === receiptDigest(input.body));
    if (matches.length === 0) return null;
    const found = matches[matches.length - 1]!;
    const confirmed = await this.confirmHead(mrUrl, headers, input.targetSha);
    return verifyPostedReceipt(
      {
        reviewId: found.id !== undefined ? String(found.id) : '',
        actor: typeof found.author?.username === 'string' ? found.author.username : '',
        event: 'note',
        commitId: null,
        headSha: confirmed.headSha,
        baseSha: confirmed.baseSha,
        bodySha256: receiptDigest(input.body),
      },
      { targetSha: input.targetSha, bodySha256: receiptDigest(input.body) },
    );
  }

  /** URL/origin/token checks plus the live pre-POST MR identity probe. Only
   * HEAD equality gates delivery: the MR's recorded base is pinned at
   * open/link time and is expected to trail the frozen base as main moves. */
  private async gitLabIdentity(input: VerdictPosterInput): Promise<{
    readonly mrUrl: string;
    readonly headers: { readonly 'PRIVATE-TOKEN': string; readonly 'CONTENT-TYPE': string };
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
    let identity: { sha?: unknown };
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
    return { mrUrl, headers };
  }

  /** Live MR identity probe with HEAD equality enforced. */
  private async confirmHead(
    mrUrl: string,
    headers: { readonly 'PRIVATE-TOKEN': string; readonly 'CONTENT-TYPE': string },
    targetSha: string,
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
    return { headSha, baseSha: typeof identity.diff_refs?.base_sha === 'string' ? identity.diff_refs.base_sha : '' };
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
    let host = '';
    try {
      host = new URL(input.prUrl.trim()).host;
    } catch {
      throw new Error(`cannot parse pull request URL: ${input.prUrl}`);
    }
    if (isGitHubRemote(host)) return this.github.post(input);
    if (isGitLabRemote(host)) return this.gitlab.post(input);
    throw new Error(
      `unsupported code host for verdict delivery: ${host} — the review gate supports GitHub (gh) and GitLab (GITLAB_TOKEN) remotes`,
    );
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

export interface WaveRunnerOptions {
  readonly ledger: LedgerApi;
  readonly worktrees: WorktreePort;
  readonly spawner: AgentSpawner;
  readonly poster?: VerdictPoster;
  readonly escalate?: (title: string, detail: string) => void;
  /** Stable service-owned root. Required for every production review. */
  readonly reviewArtifactRoot?: string;
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

export class WaveRunner {
  private readonly opts: WaveRunnerOptions;
  private readonly log: Log;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeFallbackGates = new Set<string>();
  private shuttingDown = false;

  constructor(opts: WaveRunnerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  async shutdown(): Promise<void> {
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
      const posted = this.opts.ledger.latestRoundEvent(round.id, 'round.posted');
      const payload = posted?.payload;
      const postedVerdict = typeof payload === 'object' && payload !== null
        ? (payload as { verdict?: unknown }).verdict
        : undefined;
      // A delivered verdict is only recoverable when the posted event
      // carries a provider-bound receipt that still matches the round's
      // frozen target and the preserved publication artifact. A bare or
      // unbound local event — forged or written by an older build — is NOT
      // promoted to a delivered approval; it terminalizes honestly as an
      // interrupted round instead. Completed historical rounds are never
      // rewritten.
      if (postedVerdict === 'approved' || postedVerdict === 'changes-requested') {
        const receipt = typeof payload === 'object' && payload !== null
          ? (payload as { receipt?: { reviewId?: unknown; headSha?: unknown; bodySha256?: unknown } }).receipt
          : undefined;
        const publication = typeof payload === 'object' && payload !== null
          ? (payload as { publicationFile?: unknown; publicationSha256?: unknown }).publicationFile
          : undefined;
        const publicationSha256 = typeof payload === 'object' && payload !== null
          ? (payload as { publicationSha256?: unknown }).publicationSha256
          : undefined;
        let bound = receipt !== undefined &&
          typeof receipt.reviewId === 'string' && receipt.reviewId.trim() !== '' &&
          receipt.headSha === round.targetRef &&
          typeof receipt.bodySha256 === 'string' && receipt.bodySha256 === publicationSha256;
        if (bound && typeof publication === 'string') {
          // Verify the durable artifact still carries the digested bytes.
          try {
            const body = readFileSync(publication, 'utf8');
            bound = createHash('sha256').update(body).digest('hex') === publicationSha256;
          } catch {
            bound = false;
          }
        }
        if (bound) {
          this.opts.ledger.setRoundVerdict(round.id, postedVerdict);
          this.opts.ledger.appendCustomEvent({
            kind: 'round.post-recovered',
            jobId: round.jobId,
            roundId: round.id,
            payload: {
              verdict: postedVerdict,
              postedEventSeq: posted?.seq ?? null,
              receipt: { reviewId: receipt!.reviewId, headSha: receipt!.headSha, bodySha256: receipt!.bodySha256 },
            },
          });
          await this.sweepReviewWorktree(lane.id);
          recovered += 1;
          continue;
        }
        this.opts.escalate?.(
          `Review round ${round.id} carries a posted verdict without a provider-bound receipt`,
          'restart recovery cannot verify the delivery of an unbound round.posted event; the round terminalizes as interrupted rather than promoting an unverifiable approval',
        );
      }
      const note = 'review interrupted by service restart; required lens/verification proof is incomplete';
      this.abortRound(round, note);
      const artifacts = this.writeInterruptedArtifacts(round.id, 'service_restart', note);
      this.opts.ledger.appendCustomEvent({
        kind: 'round.perkins-incomplete',
        jobId: round.jobId,
        roundId: round.id,
        payload: { reason: 'service_restart', artifactDirectory: artifacts.directory, reportFile: artifacts.reportFile },
      });
      this.opts.escalate?.(`Review round ${round.id} is INCOMPLETE after service restart`, note);
      await this.sweepReviewWorktree(lane.id);
      recovered += 1;
    }

    for (const job of this.opts.ledger.listJobs()) {
      for (const round of this.opts.ledger.listRounds(job.id)) {
        if ((round.status !== 'pending' && round.status !== 'live') || registeredRoundIds.has(round.id)) continue;
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
        this.opts.escalate?.(`Review round ${round.id} is INCOMPLETE after service restart`, note);
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
    await outcome.run;
    return outcome;
  }

  /** Review-path selection (user amendment 2026-09-20): the fail-closed
   * four-leg pre-flight runs at request time. All legs pass -> Perkins
   * (the gate). Any leg failing -> the bmad-review fallback gate. */
  async requestReview(input: {
    jobId: string;
    targetRef?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
    force?: boolean;
  }): Promise<ReviewRequestOutcome> {
    if (this.shuttingDown) throw new Error('Perkins review service is shutting down');
    // Branch-idle guard FIRST, before any route decision: manual, Silas, and
    // integration callers all inherit one rule, Perkins and fallback alike.
    this.enforceBranchIdleForRequest(input);
    const repoPath = this.resolveReviewRequestRepo(input);
    const preflight = this.opts.reviewPreflight;
    const result: ReviewPreflightResult = preflight !== undefined && repoPath !== null
      ? await preflight({ repoPath })
      : { ok: true, failures: [] };
    if (!result.ok) return this.beginFallbackGate(input, result.failures, repoPath);
    const begun = await this.beginPerkinsRound({ ...input, reviewModel: result.reviewModel });
    return { route: 'perkins', round: begun.round, run: begun.run };
  }

  /** Legacy direct entry: a failed pre-flight never silently starts a
   * Perkins round — it throws with the routing decision attached. */
  async beginRound(input: {
    jobId: string;
    targetRef?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
    force?: boolean;
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
    const blockers = findBusyLanes({
      ledger: this.opts.ledger,
      lanes: this.opts.worktrees.listWorktrees(),
      targetBranch,
      ...(input.reviewedStatus !== undefined ? { reviewedStatus: input.reviewedStatus } : {}),
    });
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
    lenses?: readonly string[];
    noSpec?: boolean;
    force?: boolean;
    reviewModel?: ReviewPreflightResult['reviewModel'];
  }): Promise<{ readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }> {
    if (this.shuttingDown) throw new Error('Perkins review service is shutting down');
    const controller = new AbortController();
    return this.track(this.setupRound(input, controller.signal), controller);
  }

  private async beginFallbackGate(
    input: { jobId: string },
    failedLegs: readonly ReviewCapabilityFailure[],
    repoPath: string | null,
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
      this.runFallbackGate(job, repoPath, baseRef, failedLegs, gate, controller.signal, state)
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
    );
    let blockers = 0;
    let notes = 0;
    for (let iteration = 1; iteration <= maxRounds; iteration += 1) {
      if (signal.aborted) throw new Error('review operation aborted');
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
          : await this.defaultFallbackReview({ jobId: job.id, lanePath, baseRef, diff, skillPath: gate.skillPath, reportFile, iteration, signal });
      } catch (error) {
        if (existsSync(reportFile)) state.reportFiles.push(reportFile);
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
    );
  }

  private async defaultFallbackReview(input: FallbackReviewRunInput): Promise<readonly FallbackFinding[]> {
    const handle = await this.opts.spawner('minion', { cwd: input.lanePath });
    try {
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
      let reviewTimer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        handle.prompt(prompt, { owner: 'bmad-review-gate' }),
        new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('review operation aborted')), { once: true });
          reviewTimer = setTimeout(() => reject(new Error(`fallback review timed out after ${FALLBACK_REVIEW_TIMEOUT_MS}ms`)), FALLBACK_REVIEW_TIMEOUT_MS);
          reviewTimer.unref?.();
        }),
      ]);
      if (reviewTimer !== null) clearTimeout(reviewTimer);
    } finally {
      await handle.dispose();
    }
    return parseFallbackFindingsReport(input.reportFile);
  }

  private async setupRound(input: {
    jobId: string;
    targetRef?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
    force?: boolean;
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
    // Recorded verification evidence (2026-09-22 fix): a completed
    // scheduler run on the exact frozen target (clean tree) is handed to
    // the review as ledger-backed context, so the tests lens weighs the
    // host's record over any pasted report. No binding run -> no block.
    let spec = job.briefing ?? undefined;
    if (input.noSpec !== true && spec !== undefined) {
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
    }
    const flippedFrom = job.status === 'working' || job.status === 'blocked' ? job.status : null;
    let round: RoundRecord;
    try {
      if (flippedFrom !== null) this.opts.ledger.setJobStatus(job.id, 'in-review');
      round = this.opts.ledger.addRound({ jobId: job.id, lenses: canonicalLenses, targetRef: targetSha });
    } catch (error) {
      if (flippedFrom !== null) this.opts.ledger.setJobStatus(job.id, flippedFrom);
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
      frozenReview = freezeReviewInputs({
        roundId: round.id,
        repoPath: reviewWorktree.path,
        artifactRoot,
        baseRef,
        targetRef: targetSha,
        movementRef,
        ...(input.noSpec === true ? { noSpec: true } : { spec }),
        ...(input.force === true
          ? { branchIdle: { forced: true as const, targetBranch: idle.targetBranch, blockers: idle.blockers } }
          : {}),
      });
      this.opts.ledger.setRoundStatus(round.id, 'live');
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
      if (flippedFrom !== null) {
        try {
          this.opts.ledger.setJobStatus(job.id, flippedFrom);
        } catch (restoreError) {
          failures.push(restoreError);
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'review setup rollback failed');
      throw error;
    }

    this.log('info', 'review round live', {
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
    // An explicit commit pin (a SHA, a tag, a revision expression) stays a
    // pin even for a PR round. Everything else on a PR-linked job resolves
    // from the PR's live head branch — never from a lane name synthesized
    // from the job id.
    const explicitPin = input.explicitTarget && candidateBranch === null;
    if (input.job.prUrl === null || explicitPin) {
      return {
        targetSha: resolveGitCommit(input.jobWorktree.path, input.candidateRef),
        movementRef: input.candidateRef,
      };
    }
    try {
      const fresh = await resolveFreshPrHead({
        repoPath: input.jobWorktree.repoPath,
        prUrl: input.job.prUrl,
        branchRef: candidateBranch ?? '',
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
    try {
      return await this.runOwnedReview(job, round, lenses, movementRef, noSpec, frozenReview, policy, signal, reviewModel);
    } finally {
      await this.sweepReviewWorktree(reviewLaneId);
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
  ): Promise<WaveOutcome> {
    const workflow = new PerkinsWholeReview({
      // This closure belongs to one round. A concurrent preflight cannot
      // replace the proof used by its lead or specialist children.
      spawner: (role, options) => this.opts.spawner(role, {
        ...options,
        ...(reviewModel !== undefined && (options?.isolatedReview !== undefined || options?.reviewLead !== undefined)
          ? { reviewModel } : {}),
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
      this.opts.escalate?.(`Review round ${round.id} is INCOMPLETE`, detail);
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
      const headMoved = review.headMoved || refMovedSinceFreeze(frozenReview);
    const canonical: CanonicalReviewVerdict = headMoved ? 'INCOMPLETE' : review.canonicalVerdict;
    let reportFile = review.reportFile;
    if (headMoved && review.canonicalVerdict !== 'INCOMPLETE') {
      reportFile = writeReviewArtifact(frozenReview, 'perkins-report.head-moved.md', [
        '# Perkins Code Review',
        '',
        '**Verdict: INCOMPLETE**',
        '',
        `The source ref \`${movementRef}\` or frozen checkout changed after target \`${review.targetSha}\` was frozen.`,
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
        payload: { frozenTarget: review.targetSha, observedRef: movementRef },
      });
    }

    let posted = false;
    let deliveryError: unknown;
    let deliveryFailureKind: 'report_not_posted' | 'no_pr_link' = 'report_not_posted';
    if (canonical !== 'INCOMPLETE' && job.prUrl !== null && this.opts.poster !== undefined) {
      const poster = this.opts.poster;
      const deliveryInput = () => {
        const prUrl = new URL(job.prUrl!);
        // The publication carries the lead-authored report PLUS a compact
        // host-owned factual appendix assembled from the structured result:
        // retained findings and real execution facts (ran/failed/not-used)
        // reach PR readers deterministically, with no model transcription.
        const privateBody = `${readFileSync(reportFile, 'utf8').trimEnd()}\n\n${hostDisclosureAppendix(review)}\n`;
        const publicationBody = redactReviewForPublication(privateBody);
        return { prUrl, publicationBody };
      };
      const recordDelivery = (delivered: PostedReviewReceipt, publicationFile: string, publicationSha256: string, reconciled: boolean): void => {
        this.opts.ledger.appendCustomEvent({
          kind: 'round.posted',
          jobId: job.id,
          roundId: round.id,
          payload: {
            verdict, canonicalVerdict: canonical, url: job.prUrl, host: new URL(job.prUrl!).host,
            // The delivery record carries the identity and receipt the
            // poster PROVED: the provider review id, the actual actor and
            // event (an authenticated COMMENT — never a formal
            // APPROVED/CHANGES_REQUESTED claim), the commit binding, the
            // frozen head delivered against and the PR's live base at
            // delivery.
            targetSha: delivered.headSha, baseSha: delivered.baseSha,
            publicationFile, publicationSha256,
            receipt: {
              reviewId: delivered.reviewId, actor: delivered.actor, event: delivered.event,
              commitId: delivered.commitId, bodySha256: delivered.bodySha256,
            },
            reconciled,
          },
        });
        posted = true;
      };
      try {
        if (signal.aborted) throw new Error('review operation aborted before report delivery');
        if (refMovedSinceFreeze(frozenReview)) throw new Error('source head/base moved immediately before report delivery');
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
        if (refMovedSinceFreeze(frozenReview)) throw new Error('source head/base moved while the report was being delivered');
        recordDelivery(delivered, publicationFile, publicationSha256, false);
      } catch (error) {
        // Ambiguous publication (the provider may have committed our POST
        // before the failure): reconcile once against provider evidence
        // bound to the frozen head and the exact published body. A verified
        // match becomes the receipt — no duplicate post. Anything else
        // stays honestly unposted.
        let reconciledDelivery: PostedReviewReceipt | null = null;
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
            const found = await poster.reconcile!({
              prUrl: job.prUrl!,
              host: prUrl.host,
              repoPath: frozenReview.manifest.repoPath,
              body: publicationBody,
              targetSha: review.targetSha,
              baseSha: frozenReview.manifest.baseRefSha,
            });
            reconciledDelivery = found === null
              ? null
              : verifyPostedReceipt(found, { targetSha: review.targetSha, bodySha256: publicationSha256 });
            if (reconciledDelivery !== null) {
              recordDelivery(reconciledDelivery, publicationFile, publicationSha256, true);
              this.log('info', 'Perkins report delivery reconciled against provider evidence', {
                round: round.id, reviewId: reconciledDelivery.reviewId,
              });
            }
          } catch (reconcileError) {
            this.log('error', 'Perkins report delivery reconciliation failed', { round: round.id, error: String(reconcileError) });
          }
        }
        if (reconciledDelivery === null) {
          deliveryError = error;
          this.opts.escalate?.(
            `Perkins report for round ${round.id} was recorded but NOT posted safely to the pull request`,
            String(error),
          );
          this.log('error', 'Perkins report post failed', { round: round.id, error: String(error) });
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
      );
    } else if (canonical !== 'INCOMPLETE' && job.prUrl !== null) {
      deliveryError = new Error('the PR poster is unavailable');
      this.opts.escalate?.(
        `Perkins report for round ${round.id} was recorded but NOT posted to the pull request`,
        'the PR poster is unavailable',
      );
    }

    if (signal.aborted) deliveryError = new Error('review operation aborted during finalization');
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
        `required coverage, verification, source stability, or delivery proof did not complete. Report: ${reportFile}`,
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
    this.opts.escalate?.(`Review round ${round.id} is INCOMPLETE`, detail);
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
      this.opts.ledger.setLensOutcome(round.id, lens, 'done', `${verdict} — ${evidence}`);
      results.push({ state: 'done', verdict, evidence });
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
