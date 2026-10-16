import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';

/**
 * Onboarding records (#427), kept as append-only `onboarding.*` ledger
 * events and projected per repository in memory (the src/vector/ledger.ts
 * pattern): no table, no migration. Jobs, cards and decisions keep their own
 * rows; these events record only what onboarding itself decided.
 */

export const ONBOARDING_EVENTS = {
  /** A FOR YOU card asked the owner to onboard the repository. */
  proposed: 'onboarding.proposed',
  /** The owner declined, or binned an onboarding job: never proposed again until reopened. */
  declined: 'onboarding.declined',
  /** The propose route (the owner asking Gru) cleared a decline. */
  reopened: 'onboarding.reopened',
  /** The installer recorded the owner's consent: the repository skips the card. */
  consented: 'onboarding.consented',
  /** A consent that needed no heist (origin already had a manifest). */
  consentSettled: 'onboarding.consent-settled',
  /** An onboarding heist was dispatched through the normal dispatch path. */
  dispatched: 'onboarding.dispatched',
  /** A dispatch failed before its job existed: a new retryable row was posted for Gru. */
  dispatchFailed: 'onboarding.dispatch-failed',
} as const;

export const ONBOARDING_EVENT_KINDS: readonly string[] = Object.values(ONBOARDING_EVENTS);

export type OnboardingLaunch = 'owner-accept' | 'autonomous' | 'installer-consent';

export interface RepoOnboarding {
  readonly repo: string;
  /** Cards ever posted for this repository (each new card gets the next id). */
  readonly proposals: number;
  /** The latest card; whether it is still open is the notification row's to say. */
  readonly lastProposal: { readonly notificationId: string; readonly at: string } | null;
  readonly declined: { readonly at: string; readonly by: string; readonly detail: string } | null;
  /** Installer consent not yet used by a dispatch, a decline or a present manifest. */
  readonly consent: { readonly source: string; readonly recordedAt: string; readonly at: string } | null;
  readonly dispatches: readonly { readonly jobId: string; readonly launchedBy: OnboardingLaunch; readonly at: string }[];
  /** Failure episodes ever posted; the latest one's row, open until a dispatch or a scan that needs none closes it. */
  readonly failures: number;
  readonly failedRow: string | null;
}

export class OnboardingRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingRecordError';
  }
}

type Payload = Record<string, unknown>;

function text(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') throw new OnboardingRecordError(`onboarding event is missing "${key}"`);
  return value;
}

const LAUNCHES: readonly OnboardingLaunch[] = ['owner-accept', 'autonomous', 'installer-consent'];

const PAGE = 500;

const empty = (repo: string): RepoOnboarding => ({ repo, proposals: 0, lastProposal: null, declined: null, consent: null, dispatches: [], failures: 0, failedRow: null });

/** The per-repository projection. It reads only `onboarding.*` events after
 * the last seq it applied, so a long ledger costs one indexed page per refresh. */
export class OnboardingLedger {
  private cursor = 0;
  private readonly repos = new Map<string, RepoOnboarding>();

  constructor(private readonly ledger: LedgerApi, private readonly log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void = () => {}) {}

  /** An event that cannot apply is logged at error with its seq and skipped, never a wedge. */
  refresh(): void {
    for (;;) {
      const page = this.ledger.listEventsAfter(this.cursor, { kinds: ONBOARDING_EVENT_KINDS, limit: PAGE });
      for (const event of page) {
        try {
          this.apply(event.kind, (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Payload, event.ts);
        } catch (error) {
          this.log('error', 'onboarding event skipped: it does not apply to the projection', { seq: event.seq, kind: event.kind, error: error instanceof Error ? error.message : String(error) });
        } finally {
          this.cursor = event.seq;
        }
      }
      if (page.length < PAGE) return;
    }
  }

  /** Append one `onboarding.*` fact and apply it. */
  record(kind: string, payload: Payload): void {
    if (!ONBOARDING_EVENT_KINDS.includes(kind)) throw new OnboardingRecordError(`unknown onboarding event kind "${kind}"`);
    this.refresh();
    const event = this.ledger.appendCustomEvent({ kind, payload });
    this.apply(kind, payload, event.ts);
    this.cursor = Math.max(this.cursor, event.seq);
  }

  repo(name: string): RepoOnboarding {
    this.refresh();
    return this.repos.get(name) ?? empty(name);
  }

  /** Every repository onboarding has recorded anything for. */
  all(): readonly RepoOnboarding[] {
    this.refresh();
    return [...this.repos.values()];
  }

  /** The repository a card belongs to, by its notification id. */
  repoForProposal(notificationId: string): string | null {
    this.refresh();
    for (const record of this.repos.values()) if (record.lastProposal?.notificationId === notificationId) return record.repo;
    return null;
  }

  private apply(kind: string, payload: Payload, ts: string): void {
    const repo = text(payload, 'repo');
    const current = this.repos.get(repo) ?? empty(repo);
    switch (kind) {
      case ONBOARDING_EVENTS.proposed:
        this.repos.set(repo, { ...current, proposals: current.proposals + 1, lastProposal: { notificationId: text(payload, 'notification_id'), at: ts } });
        return;
      case ONBOARDING_EVENTS.declined:
        this.repos.set(repo, { ...current, declined: { at: ts, by: text(payload, 'by'), detail: text(payload, 'detail') }, consent: null });
        return;
      case ONBOARDING_EVENTS.reopened:
        this.repos.set(repo, { ...current, declined: null });
        return;
      case ONBOARDING_EVENTS.consented:
        this.repos.set(repo, { ...current, consent: { source: text(payload, 'source'), recordedAt: text(payload, 'recorded_at'), at: ts } });
        return;
      case ONBOARDING_EVENTS.consentSettled:
        this.repos.set(repo, { ...current, consent: null });
        return;
      case ONBOARDING_EVENTS.dispatched: {
        const launchedBy = text(payload, 'launched_by');
        if (!(LAUNCHES as readonly string[]).includes(launchedBy)) throw new OnboardingRecordError(`onboarding dispatch names an unknown launch "${launchedBy}"`);
        this.repos.set(repo, { ...current, consent: null, dispatches: [...current.dispatches, { jobId: text(payload, 'job_id'), launchedBy: launchedBy as OnboardingLaunch, at: ts }] });
        return;
      }
      case ONBOARDING_EVENTS.dispatchFailed:
        this.repos.set(repo, { ...current, failures: current.failures + 1, failedRow: text(payload, 'notification_id') });
        return;
      default:
        throw new OnboardingRecordError(`unhandled onboarding event kind "${kind}"`);
    }
  }
}
