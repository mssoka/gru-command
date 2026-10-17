import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import { readOnboardingProof, type OnboardingProofResult } from './proof-record.js';

/**
 * Onboarding records (#427), kept as append-only `onboarding.*` ledger
 * events and projected per repository (and, for proofs, per job) in memory
 * (the src/vector/ledger.ts pattern): no table, no migration. Jobs, cards,
 * decisions and directives keep their own rows; these events record only
 * what onboarding itself decided or proved.
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
  /** Code proved (passed or failed) an onboarding job's delivered head (#427 PR 1b); a job event. */
  proof: 'onboarding.proof',
  /** A proof's PR comment is about to be posted, with its marker's nonce: after a crash, look for that marker first. */
  proofCommentAttempt: 'onboarding.proof-comment-attempt',
  /** A proof's PR comment exists (posted, or found by its marker), or cannot be posted. */
  proofCommented: 'onboarding.proof-commented',
  /** Gru's attention row for one stuck (job, head) episode was posted, with its reason; a job event. */
  proofAttentionPosted: 'onboarding.proof-attention-posted',
  /** Gru's row for a crashed proof's verify slot the boot judge kept was posted (its repository when known). */
  proofSlotHeldPosted: 'onboarding.proof-slot-held-posted',
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

/** One proven head of an onboarding job, and what its PR comment did. */
export interface ProofRecord {
  readonly repo: string;
  readonly jobId: string;
  readonly head: string;
  /** True only for a readable record of a pass. */
  readonly passed: boolean;
  readonly at: string;
  /** The record as the one proof reader reads it; null when it cannot be
   * read (an unknown outcome, malformed failures): that head's proof
   * stands as not passed and is never run again. */
  readonly result: OnboardingProofResult | null;
  /** The marker nonce of each recorded comment attempt, oldest first: only
   * a comment whose marker carries one of them is GC's. */
  readonly attemptNonces: readonly string[];
  /** When each attempt a build whose marker carried no nonce recorded was
   * recorded, oldest first: its comment starts with that build's marker
   * and was created soon after. */
  readonly legacyAttempts: readonly string[];
  readonly comment: { readonly id: number | null; readonly url: string | null; readonly detail: string } | null;
}

/** One attention row onboarding posted for Gru about a stuck (job, head). */
export interface ProofAttentionRow {
  readonly notificationId: string;
  /** Null for a delivery that names no commit. */
  readonly head: string | null;
  /** The delivery seq that opened the episode. */
  readonly deliverySeq: number;
  /** Why the head was stuck when the row was posted. */
  readonly reason: string;
  /** The seq of the event that recorded the row. */
  readonly postedSeq: number;
}

/** One row onboarding posted for Gru about a verify slot the boot judge kept. */
export interface ProofSlotRow {
  readonly notificationId: string;
  /** The budget slot's run id. */
  readonly runId: string;
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
  /** Onboarding job → its repository: only an `onboarding.dispatched` event makes a job one. */
  private readonly jobs = new Map<string, string>();
  /** Per job, its proven heads in proof order (the first proof of a head stands). */
  private readonly proofs = new Map<string, ProofRecord[]>();
  /** Per job, the attention rows posted for it, oldest first. */
  private readonly attention = new Map<string, ProofAttentionRow[]>();
  /** The kept verify slots' rows, oldest first. */
  private readonly slots: ProofSlotRow[] = [];

  constructor(private readonly ledger: LedgerApi, private readonly log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void = () => {}) {}

  /** An event that cannot apply is logged at error with its seq and skipped, never a wedge. */
  refresh(): void {
    for (;;) {
      const page = this.ledger.listEventsAfter(this.cursor, { kinds: ONBOARDING_EVENT_KINDS, limit: PAGE });
      for (const event of page) {
        try {
          this.apply(event.kind, (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Payload, event.ts, event.seq);
        } catch (error) {
          this.log('error', 'onboarding event skipped: it does not apply to the projection', { seq: event.seq, kind: event.kind, error: error instanceof Error ? error.message : String(error) });
        } finally {
          this.cursor = event.seq;
        }
      }
      if (page.length < PAGE) return;
    }
  }

  /** Append one `onboarding.*` fact and apply it. A proof fact names its
   * job, so it is also a job event (the review fence and its replay read it). */
  record(kind: string, payload: Payload, jobId: string | null = null): void {
    if (!ONBOARDING_EVENT_KINDS.includes(kind)) throw new OnboardingRecordError(`unknown onboarding event kind "${kind}"`);
    this.refresh();
    const event = this.ledger.appendCustomEvent({ kind, payload, ...(jobId === null ? {} : { jobId }) });
    this.apply(kind, payload, event.ts, event.seq);
    this.cursor = Math.max(this.cursor, event.seq);
  }

  /** The repository of an onboarding job; null for any other job. */
  jobRepo(jobId: string): string | null {
    this.refresh();
    return this.jobs.get(jobId) ?? null;
  }

  /** Every onboarding job ever dispatched. */
  onboardingJobs(): readonly string[] {
    this.refresh();
    return [...this.jobs.keys()];
  }

  /** The job's proven heads, oldest first. */
  jobProofs(jobId: string): readonly ProofRecord[] {
    this.refresh();
    return this.proofs.get(jobId) ?? [];
  }

  proof(jobId: string, head: string): ProofRecord | null {
    return this.jobProofs(jobId).find((entry) => entry.head === head) ?? null;
  }

  /** The attention rows posted for the job, oldest first. */
  attentionRows(jobId: string): readonly ProofAttentionRow[] {
    this.refresh();
    return this.attention.get(jobId) ?? [];
  }

  /** The rows posted for kept verify slots, oldest first. */
  slotRows(): readonly ProofSlotRow[] {
    this.refresh();
    return this.slots;
  }

  private updateProof(payload: Payload, change: (proof: ProofRecord) => ProofRecord): void {
    const jobId = text(payload, 'job_id');
    const head = text(payload, 'head');
    const list = this.proofs.get(jobId) ?? [];
    const index = list.findIndex((entry) => entry.head === head);
    if (index === -1) throw new OnboardingRecordError(`no onboarding proof of ${head} on job ${jobId} to attach a comment to`);
    this.proofs.set(jobId, list.map((entry, at) => (at === index ? change(entry) : entry)));
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

  private apply(kind: string, payload: Payload, ts: string, seq: number): void {
    if (kind === ONBOARDING_EVENTS.proofSlotHeldPosted) {
      // A slot's job may not be one an `onboarding.dispatched` event names.
      const row = { notificationId: text(payload, 'notification_id'), runId: text(payload, 'run_id') };
      if (!this.slots.some((entry) => entry.notificationId === row.notificationId)) this.slots.push(row);
      return;
    }
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
        this.jobs.set(text(payload, 'job_id'), repo);
        return;
      }
      case ONBOARDING_EVENTS.dispatchFailed:
        this.repos.set(repo, { ...current, failures: current.failures + 1, failedRow: text(payload, 'notification_id') });
        return;
      case ONBOARDING_EVENTS.proof: {
        // Kept even when unreadable (the ledger's fence reads it the same
        // way): it stands for its head, as not passed.
        const jobId = text(payload, 'job_id');
        const head = text(payload, 'head');
        const list = this.proofs.get(jobId) ?? [];
        if (list.some((entry) => entry.head === head)) return;
        const result = readOnboardingProof(payload);
        this.proofs.set(jobId, [...list, { repo, jobId, head, passed: result?.passed === true, at: ts, result, attemptNonces: [], legacyAttempts: [], comment: null }]);
        return;
      }
      case ONBOARDING_EVENTS.proofCommentAttempt: {
        // An attempt recorded before markers carried a nonce has none: its
        // comment carries that build's marker, with no nonce.
        const nonce = payload['nonce'];
        const carried = typeof nonce === 'string' && nonce !== '';
        this.updateProof(payload, (proof) => ({
          ...proof,
          attemptNonces: carried ? [...proof.attemptNonces, nonce] : proof.attemptNonces,
          legacyAttempts: carried ? proof.legacyAttempts : [...proof.legacyAttempts, ts],
        }));
        return;
      }
      case ONBOARDING_EVENTS.proofCommented: {
        const id = payload['comment_id'];
        const url = payload['comment_url'];
        this.updateProof(payload, (proof) => ({
          ...proof,
          comment: { id: typeof id === 'number' ? id : null, url: typeof url === 'string' ? url : null, detail: text(payload, 'detail') },
        }));
        return;
      }
      case ONBOARDING_EVENTS.proofAttentionPosted: {
        const jobId = text(payload, 'job_id');
        const head = payload['head'];
        const deliverySeq = payload['delivery_seq'];
        if (head !== null && (typeof head !== 'string' || head === '')) throw new OnboardingRecordError('onboarding attention row names no head');
        if (typeof deliverySeq !== 'number' || !Number.isSafeInteger(deliverySeq)) throw new OnboardingRecordError('onboarding attention row names no delivery seq');
        const row = { notificationId: text(payload, 'notification_id'), head, deliverySeq, reason: text(payload, 'reason'), postedSeq: seq };
        const rows = this.attention.get(jobId) ?? [];
        if (!rows.some((entry) => entry.notificationId === row.notificationId)) this.attention.set(jobId, [...rows, row]);
        return;
      }
      default:
        throw new OnboardingRecordError(`unhandled onboarding event kind "${kind}"`);
    }
  }
}
