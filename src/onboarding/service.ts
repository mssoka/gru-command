import type { OnboardingConfig } from '../config.js';
import type { EventBus } from '../events/bus.js';
import { NotificationDecisionRefusal, type LedgerApi, type NotificationRecord } from '../ledger/api.js';
import { parseNotificationDecision, type NotificationDecision } from '../ledger/notification-decision.js';
import { isJobStatus, isJobTerminal } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { displayManagedRepoName, resolveManagedRepoPath, type ManagedRepoPath } from '../repos/managed-names.js';
import { MANIFEST_PATH } from '../worktrees/manifest.js';
import { onboardingJobId, onboardingKeyOfJob, onboardingRepoKey, onboardingTitle, renderOnboardingBriefing } from './briefing.js';
import { OnboardingConsentError, onboardingConsentPath, readOnboardingConsent, removeOnboardingConsent } from './consent.js';
import { ONBOARDING_EVENTS, OnboardingLedger, type OnboardingLaunch } from './ledger.js';
import { probeOriginManifest, type OriginManifestProbe, type OriginManifestState, type VerifiedOrigin } from './origin-manifest.js';

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
 */

/** The owner's Accept/Decline on onboarding one repository. */
export const ONBOARDING_PROPOSAL_KIND = 'onboarding.proposal';
/** Board activity: an onboarding heist was dispatched. */
export const ONBOARDING_DISPATCHED_KIND = 'onboarding.dispatched';
/** Gru's attention: an onboarding heist could not be dispatched (retried at the next reconcile). */
export const ONBOARDING_DISPATCH_FAILED_KIND = 'onboarding.dispatch-failed';

/** How often undone follow-through (an accepted card, a failed dispatch) is retried. */
export const ONBOARDING_RECONCILE_INTERVAL_MS = 300_000;

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

  constructor(private readonly opts: OnboardingServiceOptions) {
    this.log = opts.log ?? (() => {});
    this.store = new OnboardingLedger(opts.ledger, this.log);
  }

  get mode(): OnboardingConfig['mode'] {
    return this.opts.onboarding.mode;
  }

  /** Boot: close what nothing will carry out any more, take the installer's
   * consent, follow decisions, scan every managed repository off the boot
   * path. `off` only closes its earlier cards and rows. */
  start(): void {
    this.closeStale();
    if (this.mode === 'off') {
      this.log('info', 'onboarding is off ([onboarding] mode = "off"): no scan, no card, no heist; installer consent is not read', {
        consent_file: onboardingConsentPath(this.opts.instanceDir),
      });
      return;
    }
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.opts.bus.subscribe((event) => {
      try {
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
    for (const repo of this.opts.managedRepos) {
      const failedRow = this.store.repo(repo).failedRow;
      const failed = failedRow === null ? null : this.opts.ledger.getNotification(failedRow);
      const card = this.openCard(repo);
      if ((failed !== null && failed.resolvedAt === null) || (card !== null && card.decidedOption !== null)) this.track(this.scanRepo(repo));
    }
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

