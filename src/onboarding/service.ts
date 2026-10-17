import type { OnboardingConfig } from '../config.js';
import { ghHttpStatus, ghRateLimited, parseGitHubPrUrl, type GhApiPort, type GhIssueComment, type RepoRef } from '../dispatch/github-poll.js';
import type { EventBus } from '../events/bus.js';
import { NotificationDecisionRefusal, type LedgerApi, type NotificationRecord, type OnboardingProofDebt } from '../ledger/api.js';
import { LIVE_DIRECTIVE_STATES } from '../ledger/directives.js';
import { parseNotificationDecision, type NotificationDecision } from '../ledger/notification-decision.js';
import { isJobStatus, isJobTerminal, type JobStatus } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { oneLineErrorText } from '../property/error-text.js';
import { redactCredentials } from '../redaction.js';
import { displayManagedRepoName, resolveManagedRepoPath, type ManagedRepoPath } from '../repos/managed-names.js';
import type { VerificationBudget } from '../verify/server.js';
import { MANIFEST_PATH } from '../worktrees/manifest.js';
import type { OnboardingProofResult } from './proof-record.js';
import { onboardingJobId, onboardingKeyOfJob, onboardingRepoKey, onboardingTitle, renderOnboardingBriefing } from './briefing.js';
import { OnboardingConsentError, onboardingConsentPath, readOnboardingConsent, removeOnboardingConsent } from './consent.js';
import { ONBOARDING_EVENTS, OnboardingLedger, type OnboardingLaunch, type ProofAttentionRow, type ProofRecord } from './ledger.js';
import { probeOriginManifest, type OriginManifestProbe, type OriginManifestState, type VerifiedOrigin } from './origin-manifest.js';
import {
  endOrphanedProbeProcesses,
  endOrphanedProofVerifies,
  onboardingProofCommentNonce,
  onboardingProofLegacyMarker,
  onboardingProofMarker,
  onboardingProofPayload,
  renderOnboardingProofComment,
  renderOnboardingProofDirective,
  runOnboardingProof,
  sweepOnboardingProbes,
  type OnboardingProofInput,
  type OnboardingProofOutcome,
} from './proof.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Onboarding heists (#427): code finds managed repositories whose origin
 * default branch has no `.gru-command/worktree.toml` and gets each one a
 * manifest PR. `[onboarding] mode = "proposed"` posts one FOR YOU card per
 * repository (no Gru turn); `"autonomous"` dispatches and posts an FYI row;
 * `"off"` does nothing. The installer's consent skips the card.
 *
 * Scans run at start, when an onboarding job reaches a terminal status, and
 * on the propose route. A repository is acted on only when origin verifiably
 * lacks a manifest, no onboarding job is open, no card is waiting and the
 * owner has not declined. A decline (or a binned onboarding job) holds until
 * the propose route reopens it.
 *
 * Proofs (#427 PR 1b): once an onboarding job has a PR, code proves its
 * newest delivered head (src/onboarding/proof.ts), once per head and one
 * proof at a time, on a delivery or PR link, at start, and at each
 * reconcile. Each proven head gets one PR comment; a failed one goes to the
 * minion as a directive. A head that stays stuck (a third failed proof, an
 * unreadable record, no head to prove, repeated deferrals, a directive that
 * cannot be sent, was retired or went unanswered) gets one action-required
 * row for Gru per episode, naming the current reason, which onboarding
 * closes. Review waits for a pass (LedgerApi.onboardingProofDebt). Proofs
 * run in every mode: "off" stops new onboarding, never the gate on an open
 * heist.
 */

/** The owner's Accept/Decline on onboarding one repository. */
export const ONBOARDING_PROPOSAL_KIND = 'onboarding.proposal';
/** Board activity: an onboarding heist was dispatched. */
export const ONBOARDING_DISPATCHED_KIND = 'onboarding.dispatched';
/** Gru's attention: an onboarding heist could not be dispatched (retried at the next reconcile). */
export const ONBOARDING_DISPATCH_FAILED_KIND = 'onboarding.dispatch-failed';

/** Gru's attention: one row per stuck (job, head) of an onboarding proof; onboarding closes it. */
export const ONBOARDING_PROOF_ATTENTION_KIND = 'onboarding.proof-attention';
/** Failed proofs on one job before a failed head gets a row. */
export const ONBOARDING_PROOF_FAILURES_FOR_GRU = 3;
/** Consecutive deferrals of one (job, head) in this process, counted at
 * most once per reconcile, before it gets a row. */
export const ONBOARDING_PROOF_DEFERRALS_FOR_GRU = 3;
/** Directive requests per failed proof whose admission was refused before the minion is no longer asked. */
export const ONBOARDING_PROOF_DIRECTIVE_ATTEMPTS = 3;
/** Directive attempts the lane refused before any row (once per reconcile, as above) before the head gets a row. */
export const ONBOARDING_PROOF_DIRECTIVE_REFUSALS_FOR_GRU = 3;
/** Failed attempts at a head's PR comment in this process (once per
 * reconcile, as above) before it is recorded as one that cannot be posted. */
export const ONBOARDING_PROOF_COMMENT_ATTEMPTS = 3;
/** GitHub statuses that refuse a comment for good (forbidden, gone,
 * unprocessable): recorded as one that cannot be posted at once, never
 * retried. Throttling never is, whatever its status (a secondary limit or
 * the abuse detection answers 403, content created too fast 422): it is
 * retried at every reconcile and never counts as a failed attempt. */
export const ONBOARDING_PROOF_COMMENT_REFUSED_STATUSES: readonly number[] = [403, 404, 410, 422];

/** Why a head is stuck, in the order a row names them (the first is the row's reason). */
export const ONBOARDING_PROOF_STUCK_REASONS = [
  'unreadable', 'failures', 'unreachable', 'retired', 'unanswered', 'unadmitted', 'deferred', 'nohead',
] as const;
export type OnboardingProofStuckReason = (typeof ONBOARDING_PROOF_STUCK_REASONS)[number];

/** One episode's attention row: the job, its head (`nohead` when the newest
 * delivery names no commit), the delivery seq that opened the episode, and
 * the reason it names. A later episode, or a new reason, gets a new id. */
export const onboardingProofAttentionId = (jobId: string, head: string | null, deliverySeq: number, reason: OnboardingProofStuckReason): string =>
  `onboarding-proof-attention:${jobId}:${head === null ? 'nohead' : head.slice(0, 12)}:${String(deliverySeq)}:${reason}`;

/** How often undone follow-through (an accepted card, a failed dispatch, a proof) is retried. */
export const ONBOARDING_RECONCILE_INTERVAL_MS = 300_000;

/** A failed proof's directive request id: deterministic per (job, head), numbered per admission attempt. */
export const onboardingProofDirectiveId = (jobId: string, head: string, attempt: number): string =>
  `onboarding-proof-${jobId}-${head.slice(0, 12)}-${String(attempt)}`;

/** Who decided a card on the installer's behalf (consent standing in for Accept). */
const CONSENT_DECIDER = 'installer-consent';

const OWNER_PROVENANCE = { credential: 'internal', declaredActor: null } as const;

/** A refusal Gru can relay, by name. */
export class OnboardingRefusal extends Error {
  constructor(readonly code: 'onboarding_off' | 'not_managed', message: string) {
    super(message);
    this.name = 'OnboardingRefusal';
  }
}

/** What one scan did about one repository. */
export type OnboardingAction =
  | 'none'
  | 'proposed'
  | 'card-open'
  | 'dispatched'
  | 'dispatch-failed'
  | 'job-open'
  | 'declined';

export interface RepoScan {
  readonly repo: string;
  /** Origin's answer; null when the scan did not need to ask. */
  readonly origin: OriginManifestState | null;
  /** Why origin gave no answer (redacted), or what was already settled. */
  readonly detail: string | null;
  readonly action: OnboardingAction;
  readonly notificationId: string | null;
  readonly jobId: string | null;
}

export interface OnboardingDispatchInput {
  readonly jobId: string;
  readonly repoPath: string;
  readonly title: string;
  readonly briefing: string;
}

/** A failed proof handed to the minion: one durable directive request. */
export interface OnboardingProofDirective {
  readonly jobId: string;
  readonly requestId: string;
  readonly directive: string;
  readonly signal: AbortSignal;
}

export interface OnboardingProofOptions {
  /** `<data_dir>/onboarding-probes`. */
  readonly probesDir: string;
  readonly setupTimeoutMs: number;
  readonly runTimeoutMs: number;
  /** The global verification budget (late-bound: the verify server starts later). */
  readonly budget: () => VerificationBudget;
  readonly github: Pick<GhApiPort, 'commentOnPull' | 'listIssueComments'>;
  /** Begin and execute the directive (the property-campaign path). Throws
   * when the lane cannot take it now; the next reconcile retries. */
  readonly direct: (input: OnboardingProofDirective) => Promise<void>;
  /** Proof seam (default: the real throwaway-checkout proof). */
  readonly run?: (input: OnboardingProofInput) => Promise<OnboardingProofOutcome>;
}

export interface OnboardingServiceOptions {
  readonly onboarding: OnboardingConfig;
  readonly workspaceRoot: string;
  readonly managedRepos: readonly string[];
  /** Where the installer leaves its one-shot consent file. */
  readonly instanceDir: string;
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  /** The normal dispatch path (POST /api/dispatch's service). */
  readonly dispatch?: (input: OnboardingDispatchInput) => Promise<unknown>;
  /** Origin probe seam (default: the real git probe). */
  readonly probe?: (repoPath: string, opts: { readonly signal: AbortSignal }) => Promise<OriginManifestProbe>;
  readonly resolveRepoPath?: (workspaceRoot: string, name: string) => Promise<ManagedRepoPath>;
  /** Proving onboarding PRs before review; absent = no proofs (and none owed by this service). */
  readonly proof?: OnboardingProofOptions;
  readonly log?: Log;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

/** A count toward a limit and the reconcile its last counted event fell in. */
interface Spaced {
  readonly count: number;
  readonly countedAt: number;
}

const shown = (repo: string): string => displayManagedRepoName(repo);

const result = (repo: string, action: OnboardingAction, fields: Partial<Omit<RepoScan, 'repo' | 'action'>> = {}): RepoScan => ({
  repo,
  origin: fields.origin ?? null,
  detail: fields.detail ?? null,
  action,
  notificationId: fields.notificationId ?? null,
  jobId: fields.jobId ?? null,
});

export class OnboardingService {
  private readonly store: OnboardingLedger;
  private readonly log: Log;
  private readonly abort = new AbortController();
  private unsubscribe: (() => void) | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** One scan at a time per repository: no second card, no second dispatch. */
  private readonly repoLocks = new Map<string, Promise<unknown>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** One proof at a time across the service; a job is queued at most once. */
  private proofChain: Promise<void> = Promise.resolve();
  private readonly proofQueued = new Set<string>();
  /** Jobs whose failed-proof directive is being admitted or run right now. */
  private readonly directing = new Set<string>();
  // In memory, as the admission retries are (owner, #255): a restart counts
  // again. Each counts at most one event per reconcile (the start is
  // reconcile 0), so any burst of triggers between two reconciles counts
  // once, whatever the clock says.
  // Deferrals: the job's newest run of deferrals of one head.
  private readonly deferrals = new Map<string, Spaced & { readonly head: string; readonly reason: string }>();
  /** Failed comment attempts per `job\nhead`. */
  private readonly commentAttempts = new Map<string, Spaced>();
  /** Directive attempts the lane refused before any row, per `job\nhead`. */
  private readonly directRefusals = new Map<string, Spaced & { readonly reason: string }>();
  /** The reconcile in which a failed head's settled directive was first seen still standing, per `job\nhead`. */
  private readonly settledSeen = new Map<string, number>();
  /** Reconciles run so far (the start counts as 0). */
  private reconciles = 0;
  /** Ended jobs with nothing left to follow (rows closed, comments settled): the reconcile skips them. */
  private readonly settledJobs = new Set<string>();

  constructor(private readonly opts: OnboardingServiceOptions) {
    this.log = opts.log ?? (() => {});
    this.store = new OnboardingLedger(opts.ledger, this.log);
  }

  get mode(): OnboardingConfig['mode'] {
    return this.opts.onboarding.mode;
  }

  /** Boot: close what nothing will carry out any more, take the installer's
   * consent, follow decisions, scan every managed repository off the boot
   * path, and prove open onboarding heists. `off` only closes its earlier
   * cards and rows, and still proves open heists. */
  start(): void {
    this.closeStale();
    const off = this.mode === 'off';
    if (off) {
      this.log('info', `onboarding is off ([onboarding] mode = "off"): no scan, no card, no heist; installer consent is not read${this.opts.proof === undefined ? '' : '; open onboarding heists are still proven before review'}`, {
        consent_file: onboardingConsentPath(this.opts.instanceDir),
      });
      if (this.opts.proof === undefined) return;
    }
    if (this.unsubscribe !== null) return;
    // A crash's leftover checkouts go before any proof can start.
    if (this.opts.proof !== undefined) this.sweepProbes(this.opts.proof);
    this.unsubscribe = this.opts.bus.subscribe((event) => {
      try {
        // A delivery or PR link proves a head; a job's end closes its rows at once.
        if (event.jobId !== null && (event.kind === 'job.delivered' || event.kind === 'job.pr' || (event.kind === 'job.status' && endsJob(event.payload)))) {
          this.proveSoon(event.jobId);
        }
        if (off) return;
        if (event.kind === 'notification.decision') this.onDecision(event.payload);
        else if (event.kind === 'job.status' && event.jobId !== null) this.onJobStatus(event.jobId, event.payload);
      } catch (error) {
        this.log('error', 'onboarding follow-through failed; the next reconcile retries it', { kind: event.kind, error: String(error) });
      }
    });
    this.reconcileTimer = (this.opts.setInterval ?? setInterval)(() => {
      try { this.reconcile(); } catch (error) { this.log('error', 'onboarding reconcile failed; the next interval retries it', { error: String(error) }); }
    }, ONBOARDING_RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
    this.proveAll();
    if (off) return;
    try {
      this.takeConsent();
    } catch (error) {
      this.log('error', 'onboarding consent could not be taken; it is retried at the next start', { error: String(error) });
    }
    this.track(this.scan());
  }

  /** Stop following events and abort in-flight origin probes (a stopped
   * service may be mid-scan; an aborted probe is unverified and acts on nothing). */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.reconcileTimer !== null) (this.opts.clearInterval ?? clearInterval)(this.reconcileTimer);
    this.reconcileTimer = null;
    this.abort.abort();
  }

  /** Settles once every scan and follow-through started so far has finished. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Scan the given managed repositories (default: all). Never rejects. */
  async scan(repos: readonly string[] = this.opts.managedRepos): Promise<readonly RepoScan[]> {
    return Promise.all(repos.map((repo) => this.scanRepo(repo)));
  }

  /**
   * The owner asked Gru to onboard a repository (POST /api/onboarding/propose).
   * Clears a decline, then scans it: a card in "proposed" mode, a heist in
   * "autonomous" mode, or the reason nothing was needed.
   */
  async propose(repo: string): Promise<RepoScan> {
    if (this.mode === 'off') {
      throw new OnboardingRefusal('onboarding_off', 'onboarding is off: set [onboarding] mode = "proposed" (or "autonomous") in config.toml and restart the service');
    }
    if (!this.opts.managedRepos.includes(repo)) {
      throw new OnboardingRefusal('not_managed', `${shown(repo)} is not a managed repository (managed_repos: ${this.opts.managedRepos.map(shown).join(', ') || 'none'})`);
    }
    return this.track(this.withRepoLock(repo, async () => {
      if (this.store.repo(repo).declined !== null) this.store.record(ONBOARDING_EVENTS.reopened, { repo, requested_by: 'gru' });
      return this.scanUnlocked(repo);
    }));
  }

  /**
   * Every five minutes: retry what a failure left undone. A card the owner
   * answered but whose follow-through did not finish, and a repository whose
   * dispatch failed, are scanned again; nothing else is (no periodic probe).
   */
  reconcile(): void {
    this.reconciles += 1;
    if (this.mode !== 'off') {
      for (const repo of this.opts.managedRepos) {
        const failedRow = this.store.repo(repo).failedRow;
        const failed = failedRow === null ? null : this.opts.ledger.getNotification(failedRow);
        const card = this.openCard(repo);
        if ((failed !== null && failed.resolvedAt === null) || (card !== null && card.decidedOption !== null)) this.track(this.scanRepo(repo));
      }
    }
    // A deferred proof, an unposted comment and an unsent directive are
    // retried here.
    this.proveAll();
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work)).catch(() => {});
    return work;
  }

  private withRepoLock<T>(repo: string, run: () => Promise<T>): Promise<T> {
    const previous = this.repoLocks.get(repo) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch(() => {});
    this.repoLocks.set(repo, settled);
    void settled.then(() => { if (this.repoLocks.get(repo) === settled) this.repoLocks.delete(repo); });
    return next;
  }

  private scanRepo(repo: string): Promise<RepoScan> {
    return this.withRepoLock(repo, () => this.scanUnlocked(repo)).catch((error: unknown) => {
      this.log('error', 'onboarding scan failed; the next scan retries it', { repo, error: error instanceof Error ? error.message : String(error) });
      return result(repo, 'none', { detail: `scan failed: ${error instanceof Error ? error.message : String(error)}` });
    });
  }

  /** The installer's consent becomes ledger facts, then the file goes. A crash
   * before the removal re-reads the same consent; recording it twice is harmless. */
  private takeConsent(): void {
    let consent;
    try {
      consent = readOnboardingConsent(this.opts.instanceDir);
    } catch (error) {
      if (!(error instanceof OnboardingConsentError)) throw error;
      this.log('error', 'onboarding consent file is unreadable and was not applied; fix or delete it (missing repositories get FOR YOU cards instead)', { error: error.message });
      return;
    }
    if (consent === null) return;
    for (const repo of consent.repos) {
      if (!this.opts.managedRepos.includes(repo)) {
        this.log('warn', 'onboarding consent names a repository that is not managed; skipped', { repo });
        continue;
      }
      this.store.record(ONBOARDING_EVENTS.consented, { repo, source: consent.source, recorded_at: consent.recordedAt, file: onboardingConsentPath(this.opts.instanceDir) });
    }
    removeOnboardingConsent(this.opts.instanceDir);
    this.log('info', 'onboarding consent taken from the installer', { repos: consent.repos, recorded_at: consent.recordedAt });
  }

  /** The repository's latest card, while it is still unresolved. */
  private openCard(repo: string): NotificationRecord | null {
    const last = this.store.repo(repo).lastProposal;
    if (last === null) return null;
    const row = this.opts.ledger.getNotification(last.notificationId);
    return row !== null && row.resolvedAt === null ? row : null;
  }

  /** The repository's open onboarding job, else the id its next one gets and how many ended before it. */
  private jobState(repo: string): { readonly open: string | null; readonly nextId: string; readonly ended: number } {
    for (let attempt = 1; ; attempt += 1) {
      const id = onboardingJobId(repo, attempt);
      const job = this.opts.ledger.getJob(id);
      if (job === null) return { open: null, nextId: id, ended: attempt - 1 };
      if (!isJobTerminal(job.status)) return { open: id, nextId: id, ended: attempt - 1 };
    }
  }

  /** One retryable row per failure episode of a heist id (a failed dispatch
   * leaves no job, so the id stays the repository's next one). */
  private failedRowId(jobId: string, episode: number): string {
    return `onboarding-dispatch-failed:${jobId}:${String(episode)}`;
  }

  /** Close the repository's open failure row: a dispatch, or a scan that
   * found none is needed, ends its episode (only onboarding closes it). */
  private settleFailure(repo: string, by: 'onboarding-dispatched' | 'onboarding-scan', why: string): void {
    const id = this.store.repo(repo).failedRow;
    const row = id === null ? null : this.opts.ledger.getNotification(id);
    if (row === null || row.resolvedAt !== null) return;
    this.opts.ledger.resolveNotificationById(row.id, by);
    this.log('info', 'onboarding dispatch-failed row closed', { repo, notification: row.id, why });
  }

  /** A card or failure row no scan will carry out: the repository left
   * managed_repos, or onboarding is off. An undecided card is withdrawn; a
   * decided one is closed with nothing dispatched. */
  private closeRepoRows(repo: string, why: string): void {
    const card = this.openCard(repo);
    if (card !== null && card.decidedOption === null) this.opts.ledger.withdrawOwnerProposal(card.id, why);
    else if (card !== null) this.closeCard(card, why);
    this.settleFailure(repo, 'onboarding-scan', why);
  }

  private closeStale(): void {
    for (const record of this.store.all()) {
      const why = this.mode === 'off'
        ? 'onboarding is off ([onboarding] mode = "off"); nothing is dispatched'
        : this.opts.managedRepos.includes(record.repo) ? null : `${shown(record.repo)} is no longer in managed_repos; nothing is dispatched`;
      if (why === null) continue;
      try {
        this.closeRepoRows(record.repo, why);
      } catch (error) {
        this.log('error', 'onboarding could not close a stale card or row', { repo: record.repo, error: String(error) });
      }
    }
  }

  private async scanUnlocked(repo: string): Promise<RepoScan> {
    if (!this.opts.managedRepos.includes(repo)) {
      this.closeRepoRows(repo, `${shown(repo)} is not in managed_repos; nothing is dispatched`);
      return result(repo, 'none', { detail: 'not a managed repository' });
    }
    const scan = await this.assess(repo);
    // Only a failed dispatch, an unreadable origin or a stopping service
    // leaves the failure episode open for the next reconcile.
    if (scan.action !== 'dispatch-failed' && !(scan.action === 'none' && scan.origin !== 'present')) {
      this.settleFailure(repo, scan.action === 'dispatched' ? 'onboarding-dispatched' : 'onboarding-scan', scan.action);
    }
    return scan;
  }

  private async assess(repo: string): Promise<RepoScan> {
    const jobs = this.jobState(repo);
    const card = this.openCard(repo);
    if (jobs.open !== null) {
      // Accepted, dispatched, and the card was not closed before a restart.
      if (card !== null && card.decidedOption === 'accept') this.closeCard(card, `onboarding heist ${jobs.open} dispatched`);
      return result(repo, 'job-open', { jobId: jobs.open });
    }
    if (card !== null && card.decidedOption !== null) return this.followCard(repo, card);
    const record = this.store.repo(repo);
    if (record.declined !== null) return result(repo, 'declined', { detail: `declined by ${record.declined.by}: ${record.declined.detail}` });
    if (card !== null) {
      // Consent given after the card was posted (the installer's smoke boot
      // may post one) stands in for the owner's Accept.
      if (record.consent === null || jobs.ended > 0) return result(repo, 'card-open', { notificationId: card.id });
      this.opts.ledger.recordNotificationDecision(card.id, 'accept', CONSENT_DECIDER);
      return this.followCard(repo, this.opts.ledger.getNotification(card.id)!);
    }

    const located = await this.locate(repo);
    if (located.path === null) return result(repo, 'none', { origin: 'unverified', detail: located.detail });
    const probe = await this.probe(repo, located.path);
    if (probe.state === 'unverified') return result(repo, 'none', { origin: 'unverified', detail: probe.reason });
    // The probe awaited: read the state again before acting on it.
    const now = this.store.repo(repo);
    if (probe.state === 'present') {
      if (now.consent !== null) this.store.record(ONBOARDING_EVENTS.consentSettled, { repo, detail: `origin/${probe.defaultBranch} already has ${MANIFEST_PATH}` });
      return result(repo, 'none', { origin: 'present' });
    }
    if (now.declined !== null) return result(repo, 'declined', { origin: 'missing', detail: `declined by ${now.declined.by}: ${now.declined.detail}` });
    const again = this.jobState(repo);
    if (again.open !== null) return result(repo, 'job-open', { origin: 'missing', jobId: again.open });
    const waiting = this.openCard(repo);
    if (waiting !== null) return result(repo, 'card-open', { origin: 'missing', notificationId: waiting.id });
    // Consent and autonomous mode start only a repository's first heist: one
    // that ended without the manifest reaching origin is asked about instead.
    if (again.ended === 0 && now.consent !== null) return this.dispatch(repo, located.path, probe, 'installer-consent');
    if (again.ended === 0 && this.mode === 'autonomous') return this.dispatch(repo, located.path, probe, 'autonomous');
    return this.proposeCard(repo, probe, now.proposals);
  }

  private async locate(repo: string): Promise<{ readonly path: string | null; readonly detail: string | null }> {
    const resolved = await (this.opts.resolveRepoPath ?? resolveManagedRepoPath)(this.opts.workspaceRoot, repo);
    if (resolved.kind === 'available') return { path: resolved.path, detail: null };
    const detail = resolved.kind === 'unavailable' ? resolved.reason : resolved.error;
    this.log('warn', 'onboarding: managed repository unavailable — no card', { repo, detail });
    return { path: null, detail };
  }

  private async probe(repo: string, repoPath: string): Promise<OriginManifestProbe> {
    const probe = await (this.opts.probe ?? probeOriginManifest)(repoPath, { signal: this.abort.signal });
    if (probe.state === 'unverified') {
      this.log('warn', 'onboarding: origin manifest unverified — no card; rescanned at the next start', { repo, reason: probe.reason });
    } else {
      this.log('info', 'onboarding: origin manifest checked', { repo, state: probe.state, branch: probe.defaultBranch, head: probe.headSha });
    }
    return probe;
  }

  private decision(repo: string): NotificationDecision {
    return parseNotificationDecision({
      question: `Dispatch an onboarding heist for ${shown(repo)}?`,
      context: [
        `A minion reads ${shown(repo)}'s CI, build files and README, writes ${MANIFEST_PATH} (setup, verify and reclaim) and opens a PR titled "${onboardingTitle(shown(repo))}".`,
        'The PR changes no other file. Normal review applies, and merging it stays your call.',
      ].join('\n'),
      recommendation: 'Recommended: until it has a manifest, lanes in this repository run no setup and verification has no command.',
      reservedClass: 'authority-cost',
      whyNotDelegable: 'onboarding mode = "proposed": an onboarding heist spends quota and opens a PR on your repository only with your Accept.',
      options: [
        { id: 'accept', label: 'Accept: dispatch the onboarding heist', consequence: 'Gru dispatches it through the normal path; the PR waits for review and your merge.' },
        { id: 'decline', label: 'Decline', consequence: `Recorded. ${shown(repo)} is not proposed again until you ask Gru to propose it.` },
      ],
      discussion: false,
    });
  }

  private proposeCard(repo: string, probe: VerifiedOrigin, proposals: number): RepoScan {
    const notificationId = `onboarding:${onboardingRepoKey(repo)}:${String(proposals + 1)}`;
    this.opts.notifications.post({
      id: notificationId,
      kind: ONBOARDING_PROPOSAL_KIND,
      routing: 'needs-owner',
      severity: 'info',
      title: `Onboard ${shown(repo)}`,
      detail: [
        `origin/${probe.defaultBranch} at ${probe.headSha.slice(0, 12)} has no ${MANIFEST_PATH}.`,
        `Without it, GC lanes in ${shown(repo)} get no setup, verification has no command, and GC cannot tell which folders it may regenerate.`,
      ].join('\n'),
      decision: this.decision(repo),
    });
    this.store.record(ONBOARDING_EVENTS.proposed, { repo, notification_id: notificationId, default_branch: probe.defaultBranch, head_sha: probe.headSha });
    return result(repo, 'proposed', { origin: 'missing', notificationId });
  }

  /** Carry out a decided card. Idempotent: a failed dispatch leaves the card
   * decided and open, and the next reconcile carries it out. */
  private async followCard(repo: string, card: NotificationRecord): Promise<RepoScan> {
    if (card.decidedOption !== 'accept') {
      this.store.record(ONBOARDING_EVENTS.declined, { repo, by: card.decidedBy ?? 'the owner', detail: 'declined its FOR YOU card', notification_id: card.id });
      this.closeCard(card, 'decline recorded');
      return result(repo, 'declined', { notificationId: card.id });
    }
    const launchedBy: OnboardingLaunch = card.decidedBy === CONSENT_DECIDER ? 'installer-consent' : 'owner-accept';
    const located = await this.locate(repo);
    // The owner said yes: only a verified manifest on origin stops the heist.
    const probe = located.path === null ? null : await this.probe(repo, located.path);
    if (probe?.state === 'present') {
      this.closeCard(card, `origin/${probe.defaultBranch} already has ${MANIFEST_PATH}; nothing dispatched`);
      return result(repo, 'none', { origin: 'present', notificationId: card.id });
    }
    if (located.path === null) {
      return { ...this.dispatchFailed(repo, this.jobState(repo).nextId, `the repository is unavailable: ${located.detail ?? 'unknown reason'}`), notificationId: card.id };
    }
    const scan = await this.dispatch(repo, located.path, probe, launchedBy);
    if (scan.action === 'dispatched') this.closeCard(card, `onboarding heist ${scan.jobId ?? ''} dispatched`);
    return { ...scan, notificationId: card.id };
  }

  private closeCard(card: NotificationRecord, detail: string): void {
    try {
      this.opts.ledger.resolveOwnerDecision(card.id, detail, OWNER_PROVENANCE);
    } catch (error) {
      if (!(error instanceof NotificationDecisionRefusal)) throw error;
      this.log('warn', 'onboarding card could not be closed', { notification: card.id, error: error.message });
    }
  }

  /**
   * Dispatch the repository's next onboarding heist through the normal path,
   * once: a job already carrying its id counts as dispatched. A dispatch that
   * failed before its job existed is Gru's to see, and the next reconcile
   * retries it; one that failed after is a blocked job Silas owns.
   */
  private async dispatch(repo: string, repoPath: string, probe: OriginManifestProbe | null, launchedBy: OnboardingLaunch): Promise<RepoScan> {
    const { nextId: jobId } = this.jobState(repo);
    const origin = probe !== null && probe.state !== 'unverified' ? probe : null;
    let blocked: string | null = null;
    if (this.opts.ledger.getJob(jobId) === null) {
      // A stopping service aborts its probes, which then read as unverified:
      // an Accept must not dispatch on that.
      if (this.abort.signal.aborted) return result(repo, 'none', { origin: probe?.state ?? null, detail: 'the service is stopping; nothing dispatched' });
      try {
        if (this.opts.dispatch === undefined) throw new Error('no onboarding dispatch path is wired on this service');
        await this.opts.dispatch({ jobId, repoPath, title: onboardingTitle(shown(repo)), briefing: renderOnboardingBriefing({ repo, origin }) });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (this.opts.ledger.getJob(jobId) === null) return this.dispatchFailed(repo, jobId, detail, probe?.state ?? null);
        blocked = detail;
        this.log('warn', 'onboarding heist failed after its job was recorded; the job is blocked and Silas owns it', { repo, job: jobId, error: detail });
      }
    }
    const consent = this.store.repo(repo).consent;
    this.store.record(ONBOARDING_EVENTS.dispatched, {
      repo,
      job_id: jobId,
      launched_by: launchedBy,
      ...(launchedBy === 'installer-consent' && consent !== null ? { consent: { source: consent.source, recorded_at: consent.recordedAt } } : {}),
    });
    const how = launchedBy === 'autonomous'
      ? 'onboarding mode = "autonomous"'
      : launchedBy === 'installer-consent'
        ? `Consented in the installer${consent !== null ? ` (${consent.recordedAt})` : ''}`
        : 'Accepted by the owner';
    this.opts.notifications.post({
      id: `onboarding-dispatched:${jobId}`,
      kind: ONBOARDING_DISPATCHED_KIND,
      routing: 'fyi',
      severity: blocked === null ? 'info' : 'error',
      title: blocked === null ? `Onboarding heist dispatched: ${shown(repo)}` : `Onboarding heist blocked at dispatch: ${shown(repo)}`,
      detail: blocked === null
        ? `${how}; job ${jobId} opens the PR "${onboardingTitle(shown(repo))}".`
        : `${how}; job ${jobId} exists but is blocked: ${blocked}\nSilas owns the blocked job.`,
    });
    return result(repo, 'dispatched', { origin: probe?.state ?? null, jobId });
  }

  /** The retryable row: one per failure episode (the Vector fix-dispatch
   * pattern). A failure while the episode's row is open keeps that row; a
   * new episode never reuses a resolved id, which would post nothing. */
  private dispatchFailed(repo: string, jobId: string, detail: string, origin: OriginManifestState | null = null): RepoScan {
    const record = this.store.repo(repo);
    const open = record.failedRow === null ? null : this.opts.ledger.getNotification(record.failedRow);
    if (open === null || open.resolvedAt !== null) {
      let episode = record.failures + 1;
      while (this.opts.ledger.getNotification(this.failedRowId(jobId, episode))?.resolvedAt != null) episode += 1;
      const id = this.failedRowId(jobId, episode);
      this.opts.notifications.post({ id, kind: ONBOARDING_DISPATCH_FAILED_KIND, routing: 'action-required', severity: 'error',
        title: `Onboarding heist not dispatched: ${shown(repo)}`, detail: `${detail}\nThe next reconcile retries it (every five minutes); it closes itself once the heist is dispatched or no longer needed.` });
      this.store.record(ONBOARDING_EVENTS.dispatchFailed, { repo, job_id: jobId, notification_id: id, detail });
    }
    this.log('error', 'onboarding heist dispatch failed; the next reconcile retries it', { repo, job: jobId, error: detail });
    return result(repo, 'dispatch-failed', { origin, detail, jobId });
  }

  private onDecision(payload: unknown): void {
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return;
    const row = this.opts.ledger.getNotification(id);
    if (row?.kind !== ONBOARDING_PROPOSAL_KIND) return;
    const repo = this.store.repoForProposal(id);
    if (repo !== null) this.track(this.scanRepo(repo));
  }

  /** A terminal onboarding job rescans its repository; a binned one is a decline. */
  private onJobStatus(jobId: string, payload: unknown): void {
    if (!endsJob(payload)) return;
    const to = (payload as { readonly to: JobStatus }).to;
    const key = onboardingKeyOfJob(jobId);
    if (key === null) return;
    const repo = this.opts.managedRepos.find((name) => onboardingRepoKey(name) === key && this.isOnboardingJob(name, jobId));
    if (repo === undefined) return;
    if (to === 'binned' && this.store.repo(repo).declined === null) {
      this.store.record(ONBOARDING_EVENTS.declined, { repo, by: 'a binned onboarding job', detail: `job ${jobId} was binned`, job_id: jobId });
    }
    this.track(this.scanRepo(repo));
  }

  // ------------------------------------------------------------------
  // Proofs (#427 PR 1b)
  // ------------------------------------------------------------------

  /** Boot, before any proof: end every process a crashed run left carrying
   * this instance's marker, then the verifies it left (their budget slots
   * are released), then remove its leftover checkouts. */
  private sweepProbes(proof: OnboardingProofOptions): void {
    this.queueProof(async () => {
      await endOrphanedProbeProcesses(proof.probesDir, this.log);
      await endOrphanedProofVerifies(proof.budget, proof.probesDir, this.log);
      await sweepOnboardingProbes(proof.probesDir, this.log);
    });
  }

  /** Run one step on the service's single proof queue. */
  private queueProof(step: () => Promise<void>): void {
    const next = this.proofChain.then(step);
    this.proofChain = next.catch((error: unknown) => {
      this.log('error', 'onboarding proof step failed; the next reconcile retries it', { error: oneLineErrorText(error, 400) });
    });
    this.track(this.proofChain);
  }

  /** Every onboarding job with something left to do, at start and at each
   * reconcile: an ended job whose rows are closed and whose comments are
   * settled is not read again. */
  private proveAll(): void {
    if (this.opts.proof === undefined) return;
    for (const jobId of this.store.onboardingJobs()) if (!this.settledJobs.has(jobId)) this.proveSoon(jobId);
  }

  /** Queue the job's proof and follow-through, once while it waits. Only a
   * job an `onboarding.dispatched` event names is an onboarding job. */
  private proveSoon(jobId: string): void {
    const proof = this.opts.proof;
    if (proof === undefined || this.abort.signal.aborted || this.proofQueued.has(jobId) || this.store.jobRepo(jobId) === null) return;
    this.proofQueued.add(jobId);
    this.queueProof(async () => {
      this.proofQueued.delete(jobId);
      await this.proveJob(jobId, proof);
    });
  }

  /** Prove the job's newest delivered head once it has a PR, unless that
   * head was proven before; then carry each proof's follow-through. A job
   * that ended has its rows closed and its comments finished, nothing else. */
  private async proveJob(jobId: string, proof: OnboardingProofOptions): Promise<void> {
    const repo = this.store.jobRepo(jobId);
    const job = this.opts.ledger.getJob(jobId);
    if (repo === null || job === null || this.abort.signal.aborted) return;
    if (isJobTerminal(job.status)) {
      this.closeRows(jobId, () => true, `job ${jobId} is ${job.status}`);
      await this.commentAll(repo, jobId, proof);
      this.forgetHeads(jobId, null);
      const rowsOpen = this.store.attentionRows(jobId).some((row) => this.opts.ledger.getNotification(row.notificationId)?.resolvedAt === null);
      if (!rowsOpen && this.store.jobProofs(jobId).every((record) => record.comment !== null)) this.settledJobs.add(jobId);
      return;
    }
    const debt = this.opts.ledger.onboardingProofDebt(jobId);
    if (job.prUrl !== null && debt !== null && debt.head !== null && this.store.proof(jobId, debt.head) === null) {
      await this.runProof(repo, jobId, debt.head, proof);
    }
    await this.followProofs(repo, jobId, proof);
  }

  private async runProof(repo: string, jobId: string, head: string, proof: OnboardingProofOptions): Promise<void> {
    const resolved = await (this.opts.resolveRepoPath ?? resolveManagedRepoPath)(this.opts.workspaceRoot, repo);
    if (resolved.kind !== 'available') {
      const reason = `the repository is unavailable: ${resolved.kind === 'unavailable' ? resolved.reason : resolved.error}`;
      this.log('warn', 'onboarding proof deferred: the repository is unavailable; the next reconcile retries it', { repo, job: jobId, head, reason });
      this.noteDeferral(jobId, head, reason);
      return;
    }
    const outcome = await (proof.run ?? runOnboardingProof)({
      jobId, head, repoPath: resolved.path, probesDir: proof.probesDir, setupTimeoutMs: proof.setupTimeoutMs, runTimeoutMs: proof.runTimeoutMs,
      budget: proof.budget, signal: this.abort.signal, log: this.log,
    });
    if (outcome.kind === 'deferred') {
      this.log('warn', 'onboarding proof deferred; the next reconcile retries it (nothing posted, nothing sent)', { repo, job: jobId, head, reason: outcome.reason });
      this.noteDeferral(jobId, head, outcome.reason);
      return;
    }
    this.store.record(ONBOARDING_EVENTS.proof, onboardingProofPayload(repo, jobId, outcome.result), jobId);
    this.deferrals.delete(jobId);
    this.log(outcome.result.passed ? 'info' : 'warn', `onboarding proof ${outcome.result.passed ? 'passed' : 'failed'}`, {
      repo, job: jobId, head, failures: outcome.result.failures,
    });
  }

  /** One more event toward a limit, counted only when none was counted in
   * this reconcile yet. */
  private spaced(last: Spaced | undefined): Spaced {
    if (last !== undefined && last.countedAt === this.reconciles) return last;
    return { count: (last?.count ?? 0) + 1, countedAt: this.reconciles };
  }

  /** A deferral of the job's head: consecutive ones of the same head count up. */
  private noteDeferral(jobId: string, head: string, reason: string): void {
    const last = this.deferrals.get(jobId);
    this.deferrals.set(jobId, { head, reason, ...this.spaced(last?.head === head ? last : undefined) });
  }

  /** Forget what this process counted about the job's heads other than
   * `keep` (null: every head, the job ended). A comment's attempts stay
   * until that comment settles. */
  private forgetHeads(jobId: string, keep: string | null): void {
    if (this.deferrals.get(jobId)?.head !== keep) this.deferrals.delete(jobId);
    for (const counts of [this.settledSeen, this.directRefusals]) {
      for (const key of [...counts.keys()]) if (key.startsWith(`${jobId}\n`) && (keep === null || key !== `${jobId}\n${keep}`)) counts.delete(key);
    }
  }

  private async commentAll(repo: string, jobId: string, proof: OnboardingProofOptions): Promise<void> {
    for (const record of this.store.jobProofs(jobId)) {
      // One record that cannot be followed never holds up the rest.
      try {
        await this.commentProof(record, proof);
      } catch (error) {
        this.log('error', 'onboarding proof record skipped: its PR comment could not be handled; the rest of the job\'s follow-through goes on', {
          repo, job: jobId, head: record.head, error: oneLineErrorText(error, 400),
        });
      }
    }
  }

  private async followProofs(repo: string, jobId: string, proof: OnboardingProofOptions): Promise<void> {
    await this.commentAll(repo, jobId, proof);
    // The head the fence waits on (LedgerApi.newestDeliveredHead). Only that
    // head is worth a directive: a newer delivery already answers an older
    // failure. An unreadable record is Gru's, never the minion's.
    const debt = this.opts.ledger.onboardingProofDebt(jobId);
    this.forgetHeads(jobId, debt?.head ?? null);
    const current = debt === null || debt.head === null ? null : this.store.proof(jobId, debt.head);
    const directive = current !== null && current.result !== null && !current.passed
      ? this.directSoon({ ...current, result: current.result }, proof) : null;
    this.attend(repo, jobId, debt, current, directive);
  }

  /** Why the job's current head is stuck, in row order: the first names the
   * row and its title. Empty when it is not stuck. */
  private stuckReasons(repo: string, jobId: string, debt: OnboardingProofDebt, current: ProofRecord | null, directive: DirectiveStanding | null): readonly StuckReason[] {
    const reasons: StuckReason[] = [];
    const head = debt.head;
    if (head === null) {
      // No delivery yet is work in progress, not a stuck proof.
      if (debt.reason === 'no-commit') {
        reasons.push({ reason: 'nohead', title: `Onboarding proof has no head to prove: ${shown(repo)}`, failure: false,
          line: `Job ${jobId}'s newest delivery names no full commit id (or is not a proven current candidate), so GC has nothing to prove: the minion must deliver again.` });
      }
      return reasons;
    }
    const failedProofs = this.store.jobProofs(jobId).filter((entry) => !entry.passed).length;
    if (current !== null && current.result === null) {
      reasons.push({ reason: 'unreadable', title: `Onboarding proof record unreadable: ${shown(repo)}`, failure: false,
        line: `The proof record of ${head.slice(0, 12)} on job ${jobId} is unreadable: it stands as not passed and that head is never proven again, so the minion must push a new commit and deliver it.` });
    }
    if (current?.result != null && !current.passed && failedProofs >= ONBOARDING_PROOF_FAILURES_FOR_GRU) {
      reasons.push({ reason: 'failures', title: `Onboarding proof failed ${String(failedProofs)} times: ${shown(repo)}`, failure: true,
        line: `Job ${jobId}'s ${MANIFEST_PATH} failed GC's onboarding proof ${String(failedProofs)} times.` });
    }
    if (directive === 'exhausted') {
      reasons.push({ reason: 'unreachable', title: `Onboarding proof failure could not reach the minion: ${shown(repo)}`, failure: true,
        line: `${String(ONBOARDING_PROOF_DIRECTIVE_ATTEMPTS)} directives telling job ${jobId}'s minion about its failed proof were refused before any prompt; no more are sent for this head.` });
    }
    if (directive === 'retired') {
      reasons.push({ reason: 'retired', title: `Onboarding proof failure: the minion's turn was retired: ${shown(repo)}`, failure: true,
        line: `The minion's turn was retired before it finished; a continuation hold may need Gru. Job ${jobId}'s newest delivery still names the failed head ${head.slice(0, 12)}.` });
    }
    if (directive === 'settled' && this.settledAgain(jobId, head)) {
      reasons.push({ reason: 'unanswered', title: `Onboarding proof failure unanswered: ${shown(repo)}`, failure: true,
        line: `Job ${jobId}'s minion was told its proof failed and finished that turn, but its newest delivery still names the failed head ${head.slice(0, 12)}.` });
    }
    const refused = this.directRefusals.get(`${jobId}\n${head}`);
    if (directive === 'asking' && refused !== undefined && refused.count >= ONBOARDING_PROOF_DIRECTIVE_REFUSALS_FOR_GRU) {
      reasons.push({ reason: 'unadmitted', title: `Onboarding proof failure: the lane never admitted the directive: ${shown(repo)}`, failure: true,
        line: `The lane never admitted the directive: ${refused.reason} (refused in ${String(refused.count)} different reconciles).` });
    }
    const deferred = this.deferrals.get(jobId);
    if (current === null && deferred !== undefined && deferred.head === head && deferred.count >= ONBOARDING_PROOF_DEFERRALS_FOR_GRU) {
      reasons.push({ reason: 'deferred', title: `Onboarding proof deferred ${String(deferred.count)} times: ${shown(repo)}`, failure: false,
        line: `GC deferred the proof of job ${jobId}'s head ${head.slice(0, 12)} ${String(deferred.count)} times in a row, each in a different reconcile. The last reason: ${deferred.reason}` });
    }
    return reasons;
  }

  /**
   * Gru's rows for the job: at most one open row per (job, head), for the
   * head's current episode, naming its current reason. A row closes when the
   * job ends, the head's proof passes, a newer head is delivered, its reason
   * gives way to another (a new row names that one), or the head is stuck
   * for no reason and its own is known to have cleared (reasonCleared: a
   * directive the lane now admitted, a deferral whose head was proven). A
   * restart, which empties the in-memory counts, closes nothing. A later
   * episode of the same head (a re-delivery after its row closed), or a
   * reason that holds again after its row closed, gets a new row; no id is
   * posted twice.
   */
  private attend(repo: string, jobId: string, debt: OnboardingProofDebt | null, current: ProofRecord | null, directive: DirectiveStanding | null): void {
    if (debt === null) {
      this.closeRows(jobId, () => true, 'the newest delivered head\'s proof passed');
      return;
    }
    const head = debt.head;
    this.closeRows(jobId, (row) => row.head !== head, 'a newer head was delivered');
    this.closeRows(jobId, (row) => row.reason === 'deferred' && row.head !== null && this.store.proof(jobId, row.head) !== null, 'the head was proven');
    if (this.opts.ledger.getJob(jobId)?.prUrl == null) return;
    const reasons = this.stuckReasons(repo, jobId, debt, current, directive);
    const first = reasons[0];
    if (first === undefined) {
      // A row of this head closes only once its reason is known to have
      // cleared; with no reason and no known clear it stays as it is.
      const newestSeq = this.opts.ledger.newestDeliveredHead(jobId)?.seq ?? 0;
      this.closeRows(jobId, (row) => row.head === head && this.reasonCleared(jobId, row, directive, newestSeq), 'the head is no longer stuck');
      return;
    }
    this.closeRows(jobId, (row) => row.reason !== first.reason, `the head is stuck for another reason now (${first.reason})`);
    const open = this.store.attentionRows(jobId).some((row) => row.head === head && row.reason === first.reason &&
      this.opts.ledger.getNotification(row.notificationId)?.resolvedAt === null);
    if (open) return;
    const seq = this.opts.ledger.newestDeliveredHead(jobId)?.seq ?? 0;
    // A reason that holds again after its row closed gets a row of its own
    // (`:2`, `:3`, …): a resolved id is never posted again.
    const base = onboardingProofAttentionId(jobId, head, seq, first.reason);
    let id = base;
    for (let again = 2; this.opts.ledger.getNotification(id)?.resolvedAt != null; again += 1) id = `${base}:${String(again)}`;
    const existing = this.opts.ledger.getNotification(id);
    // Recorded before it is posted: a crash between the two leaves a row the
    // next pass posts, never a posted row that nothing would close.
    if (!this.store.attentionRows(jobId).some((row) => row.notificationId === id)) {
      this.store.record(ONBOARDING_EVENTS.proofAttentionPosted, { repo, job_id: jobId, head, delivery_seq: seq, notification_id: id, reason: first.reason }, jobId);
    }
    if (existing !== null) return;
    // Each failure is listed once, after the first reason that carries it.
    const failures = current?.result?.failures ?? [];
    const lines: string[] = [];
    let listed = false;
    for (const entry of reasons) {
      lines.push(entry.line);
      if (!entry.failure || listed || head === null) continue;
      listed = true;
      lines.push(`The proof of ${head.slice(0, 12)} failed:`, ...failures.map((failure) => `- ${failure}`));
    }
    this.opts.notifications.post({
      id,
      kind: ONBOARDING_PROOF_ATTENTION_KIND,
      routing: 'action-required',
      severity: 'error',
      title: first.title,
      detail: [...lines, 'Review stays fenced until a proof of the newest delivered head passes. Onboarding closes this row when one does, when a newer head is delivered, when the head is stuck for another reason (a new row names it) or no longer stuck, or when the job ends.'].join('\n'),
    });
    this.log('error', 'onboarding proof is stuck; Gru has a row', { repo, job: jobId, head, notification: id, reason: first.reason });
  }

  /**
   * Whether a row's reason is known to have cleared, on a head stuck for no
   * reason now (its proof, the head moving on and the job ending close
   * rows before this). A reason whose evidence lives only in this
   * process's memory never clears because a restart emptied it: a deferral
   * clears only on a proof of its head; an unadmitted directive once the
   * lane admitted it (live or settled); an unanswered failure on a newer
   * delivery or a new directive turn on the job. The other reasons rest on
   * the ledger, so holding no more is their clear.
   */
  private reasonCleared(jobId: string, row: ProofAttentionRow, directive: DirectiveStanding | null, newestSeq: number): boolean {
    switch (row.reason) {
      case 'deferred':
        return false;
      case 'unadmitted':
        return directive === 'live' || directive === 'settled';
      case 'unanswered':
        return newestSeq > row.deliverySeq || directive === 'live' ||
          this.opts.ledger.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES }).length > 0;
      default:
        return true;
    }
  }

  /** A failed head's directive settled while the newest delivery still
   * names that head: true from the reconcile after the one that first saw it. */
  private settledAgain(jobId: string, head: string): boolean {
    const key = `${jobId}\n${head}`;
    const first = this.settledSeen.get(key);
    if (first === undefined) {
      this.settledSeen.set(key, this.reconciles);
      return false;
    }
    return this.reconciles > first;
  }

  /** Close the job's open rows that `close` picks. */
  private closeRows(jobId: string, close: (row: ProofAttentionRow) => boolean, why: string): void {
    for (const row of this.store.attentionRows(jobId)) {
      if (!close(row)) continue;
      const notification = this.opts.ledger.getNotification(row.notificationId);
      if (notification === null || notification.resolvedAt !== null) continue;
      this.opts.ledger.resolveNotificationById(row.notificationId, 'onboarding-proof');
      this.log('info', 'onboarding proof attention row closed', { job: jobId, notification: row.notificationId, why });
    }
  }

  /** One PR comment per proven head. The attempt, with a fresh nonce for
   * its marker, is recorded before the post and the receipt after; once an
   * attempt stands, GC first looks for a comment that starts with the
   * marker of a recorded attempt, so a crash between the two never posts
   * twice. A head whose comment fails {@link ONBOARDING_PROOF_COMMENT_ATTEMPTS}
   * times in this process, counted once per reconcile (a failed
   * lookup counts, and never leads to a blind post), is recorded as one
   * that cannot be posted; so, at once, is an unreadable record or one
   * GitHub refuses for good ({@link ONBOARDING_PROOF_COMMENT_REFUSED_STATUSES}).
   * Throttling (a rate limit, the abuse detection, content created too
   * fast) is retried at every reconcile and spends no attempt. An attempt
   * recorded before markers carried a nonce is looked up by the marker that
   * build posted ({@link onboardingProofLegacyMarker}). */
  private async commentProof(record: ProofRecord, proof: OnboardingProofOptions): Promise<void> {
    if (record.comment !== null) return;
    const { repo, jobId, head } = record;
    const prUrl = this.opts.ledger.getJob(jobId)?.prUrl ?? null;
    const pr = prUrl === null ? null : parseGitHubPrUrl(prUrl);
    if (pr === null) {
      this.store.record(ONBOARDING_EVENTS.proofCommented, { repo, job_id: jobId, head, comment_id: null, comment_url: null,
        detail: `not posted: ${prUrl ?? 'the job has no PR link'} is not a GitHub pull request` }, jobId);
      return;
    }
    if (record.result === null) {
      this.store.record(ONBOARDING_EVENTS.proofCommented, { repo, job_id: jobId, head, comment_id: null, comment_url: null, detail: 'cannot be posted: unreadable record' }, jobId);
      this.log('error', 'onboarding proof record is unreadable: its PR comment cannot be posted; while it is the newest head Gru has a row', { repo, job: jobId, head });
      return;
    }
    const target = { repo: { host: pr.host, owner: pr.owner, repo: pr.repo }, number: pr.number };
    const key = `${jobId}\n${head}`;
    try {
      if (record.attemptNonces.length > 0 || record.legacyAttempt) {
        const markers = [
          ...record.attemptNonces.map((nonce) => onboardingProofMarker(jobId, head, nonce)),
          ...(record.legacyAttempt ? [onboardingProofLegacyMarker(jobId, head)] : []),
        ];
        const found = await this.markedComment(target, markers, proof);
        if (found !== null) {
          this.store.record(ONBOARDING_EVENTS.proofCommented, { repo, job_id: jobId, head, comment_id: found.id, comment_url: found.url,
            detail: 'found by its marker after an interrupted post' }, jobId);
          this.commentAttempts.delete(key);
          return;
        }
      }
      const nonce = onboardingProofCommentNonce();
      this.store.record(ONBOARDING_EVENTS.proofCommentAttempt, { repo, job_id: jobId, head, pr_url: prUrl, nonce }, jobId);
      const posted = await proof.github.commentOnPull({ ...target, body: renderOnboardingProofComment(jobId, record.result, nonce) });
      this.store.record(ONBOARDING_EVENTS.proofCommented, { repo, job_id: jobId, head, comment_id: posted.id, comment_url: posted.url, detail: 'posted' }, jobId);
      this.commentAttempts.delete(key);
    } catch (error) {
      const reason = redactCredentials(oneLineErrorText(error instanceof Error ? error.message : error, 400));
      if (ghRateLimited(error)) {
        // Throttling clears on its own: retried at every reconcile, and it
        // never spends an attempt.
        this.log('warn', 'onboarding proof comment not posted: GitHub is throttling GC; the next reconcile retries it (no attempt spent)', { repo, job: jobId, head, error: reason });
        return;
      }
      const status = ghHttpStatus(error);
      const refused = status !== null && ONBOARDING_PROOF_COMMENT_REFUSED_STATUSES.includes(status);
      const attempts = this.spaced(this.commentAttempts.get(key));
      if (!refused && attempts.count < ONBOARDING_PROOF_COMMENT_ATTEMPTS) {
        this.commentAttempts.set(key, attempts);
        this.log('warn', 'onboarding proof comment not posted; the next reconcile looks for its marker, then retries', { repo, job: jobId, head, attempt: attempts.count, error: reason });
        return;
      }
      this.commentAttempts.delete(key);
      this.store.record(ONBOARDING_EVENTS.proofCommented, { repo, job_id: jobId, head, comment_id: null, comment_url: null, detail: `cannot be posted: ${reason}` }, jobId);
      this.log('error', refused
        ? `onboarding proof comment cannot be posted: GitHub refused it (HTTP ${String(status)}); the proof stands in the ledger and is not posted`
        : `onboarding proof comment cannot be posted after ${String(attempts.count)} attempts; the proof stands in the ledger and is not posted`, {
        repo, job: jobId, head, error: reason,
      });
    }
  }

  /** GC's comment from an interrupted post: its body starts with the exact
   * marker (after leading whitespace) of one of the head's recorded
   * attempts, nonce included. A comment with the job and head but no or
   * another nonce, a quote of the marker (`> <!-- …`) or a mention of it
   * mid-body is someone else's; only an attempt an older build recorded,
   * with no nonce, accepts that build's marker. No author is asked: the gh
   * login can change, and an app token has none. */
  private async markedComment(target: { readonly repo: RepoRef; readonly number: number }, markers: readonly string[], proof: OnboardingProofOptions): Promise<GhIssueComment | null> {
    return (await proof.github.listIssueComments(target)).find((comment) => markers.some((marker) => comment.body.trimStart().startsWith(marker))) ?? null;
  }

  /** A failed proof goes to the minion as one durable directive. A request
   * refused before any prompt (state `failed`) is asked again under the next
   * id, a bounded number of times; a request the lane could not take at all
   * leaves no row, and the next reconcile asks again (each such refusal
   * counts, once per reconcile, toward Gru's row). Returns where the minion's
   * telling stands. */
  private directSoon(record: ProofRecord & { readonly result: OnboardingProofResult }, proof: OnboardingProofOptions): DirectiveStanding {
    const { jobId, head } = record;
    const key = `${jobId}\n${head}`;
    let requestId: string | null = null;
    for (let attempt = 1; attempt <= ONBOARDING_PROOF_DIRECTIVE_ATTEMPTS; attempt += 1) {
      const id = onboardingProofDirectiveId(jobId, head, attempt);
      const row = this.opts.ledger.getDirective(id);
      if (row === null) {
        requestId = id;
        break;
      }
      // Retired: the writer stopped with no terminal receipt, and a
      // continuation hold may keep automation off the lane. Settled or
      // live: told, or being told; the lane admitted it, so the refusals
      // before it count no more.
      if (row.state === 'retired') return 'retired';
      if (row.state !== 'failed') {
        this.directRefusals.delete(key);
        return (LIVE_DIRECTIVE_STATES as readonly string[]).includes(row.state) ? 'live' : 'settled';
      }
    }
    if (requestId === null) return 'exhausted';
    if (this.directing.has(jobId) || this.abort.signal.aborted) return 'asking';
    this.directing.add(jobId);
    const sent = requestId;
    this.track(proof.direct({ jobId, requestId: sent, directive: renderOnboardingProofDirective(record.result), signal: this.abort.signal })
      .then(() => {
        this.directRefusals.delete(key);
        this.log('info', 'onboarding proof: the failure was sent to the minion', { job: jobId, head, request: sent });
      })
      .catch((error: unknown) => {
        const reason = redactCredentials(oneLineErrorText(error instanceof Error ? error.message : error, 400));
        // Refused before any row: nothing was accepted, so it counts. A row
        // means the lane admitted it: the refusals before it count no more.
        if (this.opts.ledger.getDirective(sent) === null) this.directRefusals.set(key, { reason, ...this.spaced(this.directRefusals.get(key)) });
        else this.directRefusals.delete(key);
        this.log('warn', 'onboarding proof: the failure could not be sent to the minion; the next reconcile retries it', { job: jobId, head, request: sent, error: reason });
      })
      .finally(() => this.directing.delete(jobId)));
    return 'asking';
  }

  private isOnboardingJob(repo: string, jobId: string): boolean {
    for (let attempt = 1; ; attempt += 1) {
      const id = onboardingJobId(repo, attempt);
      if (id === jobId) return true;
      if (this.opts.ledger.getJob(id) === null) return false;
    }
  }
}

/** Where telling the minion about a failed head stands: a request is being
 * made (or will be), one is live, one settled, one was retired, or every
 * attempt was refused. */
type DirectiveStanding = 'asking' | 'live' | 'settled' | 'retired' | 'exhausted';

/** One reason a head is stuck, as Gru's row names it. */
interface StuckReason {
  readonly reason: OnboardingProofStuckReason;
  readonly title: string;
  readonly line: string;
  /** The head's failure is listed after this reason's line (once per row). */
  readonly failure: boolean;
}

/** A `job.status` payload that moves the job to a terminal status. */
function endsJob(payload: unknown): boolean {
  const to = (payload as { to?: unknown } | null)?.to;
  return typeof to === 'string' && isJobStatus(to) && isJobTerminal(to);
}

/** Start onboarding after the service listens. Onboarding is off the heist
 * path: a failure to start is loud, never fatal. */
export function startOnboarding(service: Pick<OnboardingService, 'start'>, log: Log): void {
  try {
    service.start();
  } catch (error) {
    log('error', 'onboarding failed to start', { error: String(error) });
  }
}

