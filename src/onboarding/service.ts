import type { OnboardingConfig } from '../config.js';
import { parseGitHubPrUrl, type GhApiPort } from '../dispatch/github-poll.js';
import type { EventBus } from '../events/bus.js';
import { NotificationDecisionRefusal, type LedgerApi, type NotificationRecord } from '../ledger/api.js';
import { parseNotificationDecision, type NotificationDecision } from '../ledger/notification-decision.js';
import { isJobStatus, isJobTerminal } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { oneLineErrorText } from '../property/error-text.js';
import { displayManagedRepoName, resolveManagedRepoPath, type ManagedRepoPath } from '../repos/managed-names.js';
import type { VerificationBudget } from '../verify/server.js';
import { MANIFEST_PATH } from '../worktrees/manifest.js';
import { onboardingJobId, onboardingKeyOfJob, onboardingRepoKey, onboardingTitle, renderOnboardingBriefing } from './briefing.js';
import { OnboardingConsentError, onboardingConsentPath, readOnboardingConsent, removeOnboardingConsent } from './consent.js';
import { ONBOARDING_EVENTS, OnboardingLedger, type OnboardingLaunch, type ProofRecord } from './ledger.js';
import { probeOriginManifest, type OriginManifestProbe, type OriginManifestState, type VerifiedOrigin } from './origin-manifest.js';
import {
  onboardingProofMarker,
  onboardingProofPayload,
  readOnboardingProof,
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
 * minion as a directive, and a third failure on a job reaches Gru. Review
 * waits for a pass (LedgerApi.onboardingProofDebt). Proofs run in every
 * mode: "off" stops new onboarding, never the gate on an open heist.
 */

/** The owner's Accept/Decline on onboarding one repository. */
export const ONBOARDING_PROPOSAL_KIND = 'onboarding.proposal';
/** Board activity: an onboarding heist was dispatched. */
export const ONBOARDING_DISPATCHED_KIND = 'onboarding.dispatched';
/** Gru's attention: an onboarding heist could not be dispatched (retried at the next reconcile). */
export const ONBOARDING_DISPATCH_FAILED_KIND = 'onboarding.dispatch-failed';

/** Gru's attention: an onboarding job's manifest failed its proof this many times. */
export const ONBOARDING_PROOF_FAILING_KIND = 'onboarding.proof-failing';
/** Failed proofs on one job before Gru gets a row. */
export const ONBOARDING_PROOF_FAILURES_FOR_GRU = 3;
/** Directive requests per failed proof whose admission was refused before the minion is no longer asked. */
export const ONBOARDING_PROOF_DIRECTIVE_ATTEMPTS = 3;

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
        if ((event.kind === 'job.delivered' || event.kind === 'job.pr') && event.jobId !== null) this.proveSoon(event.jobId);
        else if (off) return;
        else if (event.kind === 'notification.decision') this.onDecision(event.payload);
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
    const to = (payload as { to?: unknown } | null)?.to;
    if (typeof to !== 'string' || !isJobStatus(to) || !isJobTerminal(to)) return;
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

  private sweepProbes(proof: OnboardingProofOptions): void {
    this.queueProof(async () => {
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

  /** Every open onboarding job, at start and at each reconcile. */
  private proveAll(): void {
    if (this.opts.proof === undefined) return;
    for (const jobId of this.store.onboardingJobs()) this.proveSoon(jobId);
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
   * head was proven before; then carry each proof's follow-through. */
  private async proveJob(jobId: string, proof: OnboardingProofOptions): Promise<void> {
    const repo = this.store.jobRepo(jobId);
    const job = this.opts.ledger.getJob(jobId);
    if (repo === null || job === null || isJobTerminal(job.status) || this.abort.signal.aborted) return;
    const debt = this.opts.ledger.onboardingProofDebt(jobId);
    if (job.prUrl !== null && debt !== null && debt.head !== null && this.store.proof(jobId, debt.head) === null) {
      await this.runProof(repo, jobId, debt.head, proof);
    }
    await this.followProofs(repo, jobId, proof);
  }

  private async runProof(repo: string, jobId: string, head: string, proof: OnboardingProofOptions): Promise<void> {
    const resolved = await (this.opts.resolveRepoPath ?? resolveManagedRepoPath)(this.opts.workspaceRoot, repo);
    if (resolved.kind !== 'available') {
      this.log('warn', 'onboarding proof deferred: the repository is unavailable; the next reconcile retries it', {
        repo, job: jobId, head, detail: resolved.kind === 'unavailable' ? resolved.reason : resolved.error,
      });
      return;
    }
    const outcome = await (proof.run ?? runOnboardingProof)({
      jobId, head, repoPath: resolved.path, probesDir: proof.probesDir, setupTimeoutMs: proof.setupTimeoutMs, runTimeoutMs: proof.runTimeoutMs,
      budget: proof.budget, signal: this.abort.signal, log: this.log,
    });
    if (outcome.kind === 'deferred') {
      this.log('warn', 'onboarding proof deferred; the next reconcile retries it (nothing posted, nothing sent)', { repo, job: jobId, head, reason: outcome.reason });
      return;
    }
    this.store.record(ONBOARDING_EVENTS.proof, onboardingProofPayload(repo, jobId, outcome.result), jobId);
    this.log(outcome.result.passed ? 'info' : 'warn', `onboarding proof ${outcome.result.passed ? 'passed' : 'failed'}`, {
      repo, job: jobId, head, failures: outcome.result.failures,
    });
  }

  private async followProofs(repo: string, jobId: string, proof: OnboardingProofOptions): Promise<void> {
    const proofs = this.store.jobProofs(jobId);
    for (const record of proofs) await this.commentProof(record, proof);
    const last = proofs.at(-1);
    const delivered = this.opts.ledger.latestJobEvent(jobId, 'job.delivered');
    const head = (delivered?.payload as { sha?: unknown } | null)?.sha;
    // Only the head the minion stands on is worth a directive: a newer
    // delivery already answers an older failure.
    if (last !== undefined && !last.passed && last.head === head) this.directSoon(last, proof);
    const failed = proofs.filter((entry) => !entry.passed);
    if (failed.length >= ONBOARDING_PROOF_FAILURES_FOR_GRU) {
      const newest = failed.at(-1)!;
      const result = readOnboardingProof(newest.payload);
      this.opts.notifications.post({
        id: `onboarding-proof-failing:${jobId}`,
        kind: ONBOARDING_PROOF_FAILING_KIND,
        routing: 'action-required',
        severity: 'error',
        title: `Onboarding proof failed ${String(failed.length)} times: ${shown(repo)}`,
        detail: [
          `Job ${jobId}'s ${MANIFEST_PATH} failed GC's onboarding proof ${String(failed.length)} times. The last, at ${newest.head.slice(0, 12)}:`,
          ...(result?.failures ?? ['(the proof record is unreadable)']).map((failure) => `- ${failure}`),
          'Each failure went back to the minion; review stays fenced until a proof passes.',
        ].join('\n'),
      });
    }
  }

  /** One PR comment per proven head. The attempt is recorded before the
   * post and the receipt after; once an attempt stands, the marker is looked
   * for first, so a crash between the two never posts twice. */
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
    const result = readOnboardingProof(record.payload);
    if (result === null) throw new Error(`the onboarding proof of ${head} on job ${jobId} is unreadable`);
    const target = { repo: { host: pr.host, owner: pr.owner, repo: pr.repo }, number: pr.number };
    const marker = onboardingProofMarker(jobId, head);
    try {
      if (record.commentAttempted) {
        const found = (await proof.github.listIssueComments(target)).find((comment) => comment.body.includes(marker));
        if (found !== undefined) {
          this.store.record(ONBOARDING_EVENTS.proofCommented, { repo, job_id: jobId, head, comment_id: found.id, comment_url: found.url,
            detail: 'found by its marker after an interrupted post' }, jobId);
          return;
        }
      }
      this.store.record(ONBOARDING_EVENTS.proofCommentAttempt, { repo, job_id: jobId, head, pr_url: prUrl }, jobId);
      const posted = await proof.github.commentOnPull({ ...target, body: renderOnboardingProofComment(jobId, result) });
      this.store.record(ONBOARDING_EVENTS.proofCommented, { repo, job_id: jobId, head, comment_id: posted.id, comment_url: posted.url, detail: 'posted' }, jobId);
    } catch (error) {
      this.log('warn', 'onboarding proof comment not posted; the next reconcile looks for its marker, then retries', { repo, job: jobId, head, error: oneLineErrorText(error, 400) });
    }
  }

  /** A failed proof goes to the minion as one durable directive. A request
   * refused before any prompt (state `failed`) is asked again under the next
   * id, a bounded number of times; a request the lane could not take at all
   * leaves no row, and the next reconcile asks again. */
  private directSoon(record: ProofRecord, proof: OnboardingProofOptions): void {
    const { jobId, head } = record;
    if (this.directing.has(jobId) || this.abort.signal.aborted) return;
    let requestId: string | null = null;
    for (let attempt = 1; attempt <= ONBOARDING_PROOF_DIRECTIVE_ATTEMPTS; attempt += 1) {
      const id = onboardingProofDirectiveId(jobId, head, attempt);
      const row = this.opts.ledger.getDirective(id);
      if (row === null) {
        requestId = id;
        break;
      }
      // Settled, live, or closed by its own recovery: told, being told, or
      // not for this service to resume.
      if (row.state !== 'failed') return;
    }
    if (requestId === null) {
      this.log('error', `onboarding proof: ${String(ONBOARDING_PROOF_DIRECTIVE_ATTEMPTS)} directives about this failed proof were refused before any prompt; no more are sent for this head`, { job: jobId, head });
      return;
    }
    const result = readOnboardingProof(record.payload);
    if (result === null) return;
    this.directing.add(jobId);
    const sent = requestId;
    this.track(proof.direct({ jobId, requestId: sent, directive: renderOnboardingProofDirective(result), signal: this.abort.signal })
      .then(() => this.log('info', 'onboarding proof: the failure was sent to the minion', { job: jobId, head, request: sent }))
      .catch((error: unknown) => this.log('warn', 'onboarding proof: the failure could not be sent to the minion; the next reconcile retries it', {
        job: jobId, head, request: sent, error: oneLineErrorText(error, 400),
      }))
      .finally(() => this.directing.delete(jobId)));
  }

  private isOnboardingJob(repo: string, jobId: string): boolean {
    for (let attempt = 1; ; attempt += 1) {
      const id = onboardingJobId(repo, attempt);
      if (id === jobId) return true;
      if (this.opts.ledger.getJob(id) === null) return false;
    }
  }
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

