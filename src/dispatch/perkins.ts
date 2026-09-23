import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import type { LedgerApi, RoundRecord, RoundVerdict } from '../ledger/api.js';
import { requireSafeRecordId } from '../ledger/api.js';
import type { WorktreePort } from './worktree-port.js';
import type { AgentSpawner } from './service.js';
import type { CanonicalReviewVerdict, LensEnvelope, VerifiedFinding } from './perkins-review/types.js';
import { PerkinsHybridReview, type PerkinsHybridResult } from './perkins-review/hybrid.js';
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

/** The agent-rail label for one Perkins lens child. First attempts mint
 * the classic `${lens}:${chunk}`; a RETRY suffixes the wave's attempt
 * counter (`blind:001#2`) so two attempts on one chunk can never collide
 * into duplicate agent rows and transcript labels. */
export function lensAgentLabel(lens: string, chunk: string, attempt: number): string {
  const base = `${lens}:${chunk}`;
  return attempt > 1 ? `${base}#${attempt}` : base;
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

export interface VerdictPoster {
  post(input: {
    readonly prUrl: string;
    readonly host: string;
    readonly repoPath: string;
    readonly body: string;
    readonly targetSha: string;
    readonly baseSha: string;
  }): Promise<PrIdentity>;
}

/** GitHub poster using a commit-bound pull-request review, not an unbound
 * comment. The API's commit_id makes a head race rejectable server-side. */
export class GhPrPoster implements VerdictPoster {
  constructor(private readonly binary = 'gh') {}

  async post(input: {
    readonly prUrl: string;
    readonly host: string;
    readonly repoPath: string;
    readonly body: string;
    readonly targetSha: string;
    readonly baseSha: string;
  }): Promise<PrIdentity> {
    let url: URL;
    try {
      url = new URL(input.prUrl.trim());
    } catch {
      throw new Error(`cannot parse pull request URL: ${input.prUrl}`);
    }
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/u.exec(url.pathname);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
      match === null || input.host !== url.host || !/^[A-Za-z0-9.-]+(?::\d+)?$/u.test(input.host)
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
      { encoding: 'utf-8', timeout: 30_000 },
    );
    if (identity.error !== undefined) {
      throw new Error(`gh is unavailable (${String(identity.error)}) — review not delivered`);
    }
    if (identity.status !== 0) {
      throw new Error(`gh api pull identity exited ${identity.status}: ${(identity.stderr ?? '').trim().slice(0, 500)}`);
    }
    const [observedHead = '', observedBase = ''] = (identity.stdout ?? '').trim().split('\t');
    // Only HEAD equality gates delivery. The PR's recorded base (GitHub
    // pins `.base.sha` at open/link time) is expected to trail the round's
    // frozen base as main moves during a long round; the frozen diff is
    // immutable, so a stale recorded base is never a refusal reason.
    if (observedHead !== input.targetSha) {
      throw new Error(
        `pull request identity moved before delivery (expected head ${input.targetSha}, ` +
        `got ${observedHead || 'unknown'})`,
      );
    }
    const result = spawnSync(
      this.binary,
      ['api', '--hostname', input.host, '--method', 'POST', `${apiPath}/reviews`, '--input', '-'],
      {
        input: `${JSON.stringify({ body: input.body, event: 'COMMENT', commit_id: input.targetSha })}\n`,
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    if (result.error !== undefined) {
      throw new Error(`gh is unavailable (${String(result.error)}) — SHA-bound review not delivered`);
    }
    if (result.status !== 0) {
      throw new Error(`gh api review delivery exited ${result.status}: ${(result.stderr ?? '').trim().slice(0, 500)}`);
    }
    return { headSha: observedHead, baseSha: observedBase };
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

  async post(input: {
    readonly prUrl: string;
    readonly host: string;
    readonly repoPath: string;
    readonly body: string;
    readonly targetSha: string;
    readonly baseSha: string;
  }): Promise<PrIdentity> {
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
      match === null || input.host !== url.host || !/^[A-Za-z0-9.-]+(?::\d+)?$/u.test(input.host)
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
    // HEAD equality is the delivery invariant. The MR's recorded base
    // (diff_refs.base_sha is pinned at open/link time) is expected to trail
    // the round's frozen base as main moves during a long round, so base
    // age is refreshed into the delivery record below, never a refusal
    // reason.
    if (observedHead !== input.targetSha) {
      throw new Error(
        `merge request identity moved before delivery (expected head ${input.targetSha}, got ${observedHead || 'unknown'})`,
      );
    }
    let noteResponse: Awaited<ReturnType<typeof this.fetchImpl>>;
    try {
      noteResponse = await this.fetchImpl(`${mrUrl}/notes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: input.body }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`GitLab merge request note delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!noteResponse.ok) {
      throw new Error(`GitLab merge request note delivery exited HTTP ${noteResponse.status}: ${(await noteResponse.text()).slice(0, 300)}`);
    }
    // GitLab notes are not commit-bound server-side; re-probe the MR after
    // delivery and fail loudly when the HEAD moved under the note. The
    // re-probe IS the refreshed record: whatever base the MR now reports is
    // delivered onward, so a moving main never refuses a proven head.
    let confirmResponse: Awaited<ReturnType<typeof this.fetchImpl>>;
    try {
      confirmResponse = await this.fetchImpl(mrUrl, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new Error(`GitLab merge request post-delivery probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!confirmResponse.ok) {
      throw new Error(`GitLab merge request post-delivery probe exited HTTP ${confirmResponse.status} — delivery cannot be confirmed`);
    }
    let confirmed: { sha?: unknown; diff_refs?: { base_sha?: unknown } | null };
    try {
      confirmed = JSON.parse((await confirmResponse.text()).slice(0, 4 * 1024 * 1024)) as typeof confirmed;
    } catch {
      throw new Error('GitLab merge request post-delivery response was not valid JSON');
    }
    const confirmedHead = typeof confirmed.sha === 'string' ? confirmed.sha : '';
    const confirmedBase = typeof confirmed.diff_refs?.base_sha === 'string' ? confirmed.diff_refs.base_sha : '';
    if (confirmedHead !== observedHead) {
      throw new Error(
        `merge request identity moved after delivery (expected head ${observedHead}, got ${confirmedHead || 'unknown'})`,
      );
    }
    return { headSha: confirmedHead, baseSha: confirmedBase };
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

  async post(input: Parameters<VerdictPoster['post']>[0]): Promise<PrIdentity> {
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
      if (postedVerdict === 'approved' || postedVerdict === 'changes-requested') {
        this.opts.ledger.setRoundVerdict(round.id, postedVerdict);
        this.opts.ledger.appendCustomEvent({
          kind: 'round.post-recovered',
          jobId: round.jobId,
          roundId: round.id,
          payload: { verdict: postedVerdict, postedEventSeq: posted?.seq ?? null },
        });
        await this.sweepReviewWorktree(lane.id);
        recovered += 1;
        continue;
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
  }): Promise<ReviewRequestOutcome> {
    if (this.shuttingDown) throw new Error('Perkins review service is shutting down');
    const repoPath = this.resolveReviewRequestRepo(input);
    const preflight = this.opts.reviewPreflight;
    const result: ReviewPreflightResult = preflight !== undefined && repoPath !== null
      ? await preflight({ repoPath })
      : { ok: true, failures: [] };
    if (!result.ok) return this.beginFallbackGate(input, result.failures, repoPath);
    const begun = await this.beginPerkinsRound(input);
    return { route: 'perkins', round: begun.round, run: begun.run };
  }

  /** Legacy direct entry: a failed pre-flight never silently starts a
   * Perkins round — it throws with the routing decision attached. */
  async beginRound(input: {
    jobId: string;
    targetRef?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
  }): Promise<{ readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }> {
    if (this.opts.reviewPreflight !== undefined) {
      const repoPath = this.resolveReviewRequestRepo(input);
      if (repoPath !== null) {
        const result = await this.opts.reviewPreflight({ repoPath });
        if (!result.ok) throw new FallbackGateRequiredError(result.failures);
      }
    }
    return this.beginPerkinsRound(input);
  }

  private resolveReviewRequestRepo(input: { jobId: string }): string | null {
    const job = this.opts.ledger.getJob(input.jobId);
    if (job === null) return null;
    const lane = this.opts.worktrees
      .listWorktrees({ jobId: input.jobId })
      .find((candidate) => candidate.kind === 'job') ?? null;
    return lane?.path ?? null;
  }

  private async beginPerkinsRound(input: {
    jobId: string;
    targetRef?: string;
    lenses?: readonly string[];
    noSpec?: boolean;
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
    const { targetSha, movementRef } = await this.resolveFreezeTarget({ job, jobWorktree, candidateRef });
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
      frozenReview = freezeReviewInputs({
        roundId: round.id,
        repoPath: reviewWorktree.path,
        artifactRoot,
        baseRef,
        targetRef: targetSha,
        movementRef,
        chunkLineThreshold: policy.portableContract.rules.chunkLineThreshold,
        ...(input.noSpec === true ? { noSpec: true } : { spec }),
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
      workflow: 'perkins-hybrid',
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
      ),
      runController,
    );
    return { round, run };
  }

  /** Resolve the exact SHA a round will freeze. A round reviewing a PR
   * branch fetches that branch from origin and cross-checks the fetched tip
   * against the live pull/merge-request head: the recorded lane identity is
   * only a hint, never the freeze source. A disagreement aborts before a
   * round row, a review worktree, or any lens exists. Non-PR rounds and
   * explicit commit pins keep the local resolution. */
  private async resolveFreezeTarget(input: {
    job: { readonly id: string; readonly prUrl: string | null };
    jobWorktree: { readonly path: string; readonly repoPath: string };
    candidateRef: string;
  }): Promise<{ readonly targetSha: string; readonly movementRef: string }> {
    const branchRef = input.job.prUrl === null
      ? null
      : prBranchCandidate(input.jobWorktree.repoPath, input.candidateRef);
    if (input.job.prUrl === null || branchRef === null) {
      return {
        targetSha: resolveGitCommit(input.jobWorktree.path, input.candidateRef),
        movementRef: input.candidateRef,
      };
    }
    try {
      const fresh = await resolveFreshPrHead({
        repoPath: input.jobWorktree.repoPath,
        prUrl: input.job.prUrl,
        branchRef,
        ...(this.opts.prHeadProbe !== undefined ? { probe: this.opts.prHeadProbe } : {}),
      });
      this.log('info', 'freeze target refreshed from the live PR head', {
        job: input.job.id,
        branch: branchRef,
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
            branchRef,
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
  ): Promise<WaveOutcome> {
    try {
      return await this.runOwnedReview(job, round, lenses, movementRef, noSpec, frozenReview, policy, signal);
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
  ): Promise<WaveOutcome> {
    const workflow = new PerkinsHybridReview({
      spawner: this.opts.spawner,
      policy,
      onAgent: ({ phase, lens, chunk, attempt, handle }) => {
        this.opts.ledger.registerAgent({
          id: handle.id,
          role: 'perkins',
          label:
            phase === 'lens' && lens !== undefined
              ? lensAgentLabel(lens, chunk ?? '', attempt ?? 1)
              : 'lead',
          sessionFile: handle.sessionFile,
          roundId: round.id,
          jobId: job.id,
        });
        if (phase === 'lens' && lens !== undefined) this.opts.ledger.markLensLive(round.id, lens);
      },
    });

    let review: PerkinsHybridResult;
    try {
      const priorConsolidatedFile = this.opts.ledger
        .listRounds(job.id)
        .filter((candidate) =>
          candidate.seq < round.seq && candidate.status === 'verdict-posted' && candidate.verdict !== null &&
          this.opts.ledger.latestRoundEvent(candidate.id, 'round.perkins-review') !== null,
        )
        .sort((left, right) => right.seq - left.seq)
        .map((candidate) => ({
          file: join(reviewArtifactDirectory(this.artifactRoot(), candidate.id), 'consolidated.json'),
          targetSha: candidate.targetRef,
        }))
        .find(({ file, targetSha }) => targetSha !== null && this.isCompleteConsolidated(file, targetSha))?.file;
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
      const detail = `Perkins hybrid workflow failed: ${String(error).replace(/[\r\n]+/gu, ' ').slice(0, 500)}`;
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
    if (canonical !== 'INCOMPLETE' && job.prUrl !== null && this.opts.poster !== undefined) {
      try {
        if (signal.aborted) throw new Error('review operation aborted before report delivery');
        if (refMovedSinceFreeze(frozenReview)) throw new Error('source head/base moved immediately before report delivery');
        const prUrl = new URL(job.prUrl);
        const privateBody = `${readFileSync(reportFile, 'utf8').trimEnd()}\n`;
        const publicationBody = redactReviewForPublication(privateBody);
        const publicationFile = writeReviewArtifact(frozenReview, 'perkins-report.publication.md', publicationBody);
        const publicationSha256 = createHash('sha256').update(publicationBody).digest('hex');
        const delivered = await this.opts.poster.post({
          prUrl: job.prUrl,
          host: prUrl.host,
          repoPath: frozenReview.manifest.repoPath,
          body: publicationBody,
          targetSha: review.targetSha,
          baseSha: frozenReview.manifest.baseRefSha,
        });
        if (signal.aborted) throw new Error('review operation aborted while the report was being delivered');
        if (refMovedSinceFreeze(frozenReview)) throw new Error('source head/base moved while the report was being delivered');
        this.opts.ledger.appendCustomEvent({
          kind: 'round.posted',
          jobId: job.id,
          roundId: round.id,
          payload: {
            verdict, canonicalVerdict: canonical, url: job.prUrl, host: prUrl.host,
            // The delivery record carries the identity the poster PROVED:
            // the frozen head it delivered against and the PR's live base
            // at delivery. The frozen base stays in round.perkins-review;
            // recording it here asserted a pairing the PR never had once
            // main moved on.
            targetSha: delivered.headSha, baseSha: delivered.baseSha,
            publicationFile, publicationSha256,
          },
        });
        posted = true;
      } catch (error) {
        deliveryError = error;
        this.opts.escalate?.(
          `Perkins report for round ${round.id} was recorded but NOT posted safely to the pull request`,
          String(error),
        );
        this.log('error', 'Perkins report post failed', { round: round.id, error: String(error) });
      }
    } else if (canonical !== 'INCOMPLETE' && job.prUrl !== null) {
      deliveryError = new Error('the PR poster is unavailable');
      this.opts.escalate?.(
        `Perkins report for round ${round.id} was recorded but NOT posted to the pull request`,
        'the PR poster is unavailable',
      );
    }

    if (signal.aborted) deliveryError = new Error('review operation aborted during finalization');
    const postingRequired = job.prUrl !== null;
    const recordedVerdict = verdict !== null && (!postingRequired || posted) && !signal.aborted ? verdict : null;
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
          complete: review.completeness.complete && !headMoved,
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
          reason: verdict === null ? 'review_incomplete' : 'report_not_posted',
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
    review: PerkinsHybridResult,
  ): ReviewLensResult[] {
    const results: ReviewLensResult[] = [];
    for (const lens of lenses) {
      const finalByChunk = new Map<string, LensEnvelope>();
      for (const envelope of review.lensEnvelopes) {
        if (envelope.lens !== lens) continue;
        const prior = finalByChunk.get(envelope.chunk);
        if (prior === undefined || envelope.attempt > prior.attempt) finalByChunk.set(envelope.chunk, envelope);
      }
      const failed = [...finalByChunk.values()].filter((entry) => entry.status !== 'valid');
      if (failed.length > 0 || finalByChunk.size === 0 || !review.completeness.verificationComplete) {
        const note = failed.length > 0
          ? `incomplete chunks: ${failed.map((entry) => entry.chunk).join(', ')}`
          : 'independent verification did not complete';
        this.opts.ledger.setLensOutcome(round.id, lens, 'error', note);
        results.push({ state: 'error', note });
        continue;
      }
      const findings = review.findings.filter((finding) => finding.sources.includes(lens));
      const verdict: 'blocker' | 'warning' | 'note' | 'clean' = this.lensVerdict(findings);
      const evidence = findings.length === 0
        ? 'lead verification retained no finding for this lens'
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
        architecture?: unknown;
        canonicalVerdict?: unknown;
        completeness?: { complete?: unknown; verificationComplete?: unknown };
        frozen?: { targetSha?: unknown };
        headMoved?: unknown;
        findings?: unknown;
      };
      return parsed.architecture === 'perkins-hybrid' &&
        parsed.frozen?.targetSha === expectedTargetSha &&
        parsed.canonicalVerdict !== 'INCOMPLETE' &&
        parsed.completeness?.complete === true &&
        parsed.completeness.verificationComplete === true &&
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
