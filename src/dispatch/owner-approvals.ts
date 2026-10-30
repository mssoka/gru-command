import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventBus } from '../events/bus.js';
import {
  NotificationDecisionRefusal,
  RecordNotFound,
  type LedgerApi,
  type NotificationRecord,
  type OwnerApprovalRecord,
  type OwnerApprovalRefusal,
} from '../ledger/api.js';
import { DirectiveRetirementError } from '../ledger/directives.js';
import type { NotificationDecision } from '../ledger/notification-decision.js';
import {
  OWNER_APPROVAL_CARD_KIND,
  OWNER_APPROVAL_KINDS,
  OWNER_APPROVAL_REASON_MAX_CHARS,
  type OwnerApprovalKind,
} from '../ledger/owner-approvals.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { PacingGate } from '../runtime/pacing.js';
import { redactCredentials } from '../redaction.js';
import { abandonLiveDirectiveFromRoute } from './directive-recovery.js';
import type { WorktreePort } from './worktree-port.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Owner approval of abandonment (#523). Abandoning a directive request whose
 * producer custody is unknown is the owner's call, and the owner should not
 * run a terminal script to make it. Gru proposes it (`POST /api/owner-approvals`);
 * the proposal is one FOR YOU card with Approve and Deny; the owner's Approve
 * makes this service carry out the native owner abandonment
 * (`abandonLiveDirectiveFromRoute`, `by: 'owner'`), with the fences read when
 * the proposal was made checked again first, and the card closes with what
 * actually happened.
 *
 * Every state change of a record is one ledger transaction that appends an
 * `owner-approval.<state>` event, so a crash leaves the record in a state
 * `reconcile()` knows how to finish, and the abandonment never runs twice.
 *
 * Attribution is the same caller-declared model as `/abandon`: one shared
 * bearer, no verified identity. Gru never sends `by: "owner"`; the card's
 * decision names its decider, and only an exact `owner` is acted on. The
 * decision's `expectedDecision` echo stands in for `confirm_intent`.
 */

/** The card kind (registered in the attention registry). */
export const DIRECTIVE_ABANDON_CARD_KIND = OWNER_APPROVAL_CARD_KIND['directive-abandon'];

/** How often an approved record that did not finish is retried. */
export const OWNER_APPROVAL_RECONCILE_INTERVAL_MS = 60_000;

/** The attribution of a decision that was carried out, as the board's
 * follow-through records it (a credential class, no claimed identity). */
const OWNER_PROVENANCE = { credential: 'internal', declaredActor: null } as const;

/** The only decider whose Approve is carried out. Exact, never trimmed or folded. */
const OWNER_DECIDER = 'owner';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{1,128}$/u;
const REASON_EXCERPT_CHARS = 200;
const ERROR_MESSAGE_CHARS = 300;
const BODY_LIMIT_BYTES = 64 * 1024;

const WHY_NOT_DELEGABLE = 'Abandonment is owner-reserved: only the owner may close a request whose producer custody is unknown.';
const APPROVE_CONSEQUENCE = 'Closes the request as outcome-unknown. Nothing is replayed. No completion, no-effect or cessation is recorded. ' +
  "The job's status is unchanged. The lane stays held until the job is binned or fresh owner-accepted work is admitted there.";
const DENY_CONSEQUENCE = 'Nothing runs. The request stays as it is.';

/** The steps a crash can follow; the test seam names them. */
export const OWNER_APPROVAL_STEPS = [
  'record-written',
  'approved-written',
  'executing-written',
  'ledger-abandoned',
  'terminal-written',
  'card-withdrawn',
] as const;
export type OwnerApprovalStep = (typeof OWNER_APPROVAL_STEPS)[number];

type ServiceLedger = Pick<LedgerApi,
  | 'proposeOwnerApproval' | 'getOwnerApproval' | 'ownerApprovalForNotification' | 'ownerApprovalHistory' | 'ownerApprovalFenceReadback'
  | 'approveOwnerApproval' | 'beginOwnerApprovalExecution' | 'endOwnerApproval' | 'recordOwnerApprovalAttemptFailure'
  | 'listActiveOwnerApprovalIds' | 'listEndedOwnerApprovalIdsWithOpenCard'
  | 'getNotification' | 'resolveOwnerDecision' | 'withdrawOwnerProposal'
  | 'getDirective' | 'abandonLiveDirective' | 'listAgents' | 'latestJobEventByRequestId'>;

export interface OwnerApprovalServiceDeps {
  readonly ledger: ServiceLedger;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  readonly bus: Pick<EventBus, 'subscribe'>;
  /** The evidence the abandonment route reads beside the ledger. */
  readonly worktrees: Pick<WorktreePort, 'listWorktrees'>;
  readonly workerGate?: Pick<PacingGate, 'view'>;
  readonly pendingProducerBlockers: (jobId: string) => readonly string[];
  readonly log?: Log;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  /** Test seam: called after a named step has been written. Throwing from it
   * stands in for a crash at that point. Production never passes it. */
  readonly afterStep?: (step: OwnerApprovalStep) => void;
}

export interface OwnerApprovalService {
  /** Follow owner decisions and retry what is undone on an interval. */
  start(): void;
  stop(): void;
  /** One pass over every record that is not finished and every finished
   * record whose card is still open. */
  reconcile(): void;
  /** `/api/owner-approvals*`, already authenticated by the server. False for
   * a path or method it does not own. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
}

/** The wire shape of a record: what POST answers and GET reads. */
export interface OwnerApprovalView {
  readonly id: string;
  readonly kind: OwnerApprovalKind;
  readonly request_id: string;
  readonly job_id: string;
  readonly state: string;
  readonly attempts: number;
  readonly fences: { readonly job_id: string; readonly state: string; readonly payload_hash: string; readonly debt_generation: number | null };
  readonly reason: string;
  readonly notification_id: string;
  readonly history: readonly { readonly state: string; readonly at: string; readonly detail: string | null }[];
  readonly outcome: {
    readonly abandonment_event_seq: number | null;
    readonly refusal: { readonly code: string; readonly blockers: readonly string[] } | null;
  };
}

/** The reason the abandonment carries, so its audit event names the approval. */
export const ownerApprovalReasonPrefix = (id: string): string => `[owner-approval ${id}] `;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    let seen = 0;
    const chunks: Buffer[] = [];
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      seen += chunk.length;
      if (seen > BODY_LIMIT_BYTES) {
        rejected = true;
        rejectBody(new Error('request body exceeds 64 KiB'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const parsed = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          rejectBody(new Error('request body must be a JSON object'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        rejectBody(new Error(`request body is not valid JSON: ${String(error)}`));
      }
    });
    req.on('error', (error) => { if (!rejected) rejectBody(error); });
  });
}

/** A character a reason may not carry: every control character (`\p{Cc}`: C0,
 * DEL and C1) but tab and LF, the line and paragraph separators (U+2028,
 * U+2029) and the bidi embedding, override and isolate controls (U+202A-U+202E,
 * U+2066-U+2069), which reorder what the owner reads on the card. No raw
 * control range literal. */
function isRefusedReasonCharacter(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    if (isRefusedReasonCharacter(char.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** A proposal body, or the reason it is malformed (a 400). */
function parseProposal(body: Record<string, unknown>): { readonly kind: OwnerApprovalKind; readonly requestId: string; readonly reason: string; readonly idempotencyKey: string } {
  const kind = body['kind'];
  if (typeof kind !== 'string' || !(OWNER_APPROVAL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of ${OWNER_APPROVAL_KINDS.join(', ')}`);
  }
  if (body['by'] !== 'gru') throw new Error('by must be "gru": an owner approval is proposed by Gru, and the owner answers on the card');
  const requestId = body['request_id'];
  if (typeof requestId !== 'string' || requestId.trim() === '') throw new Error('request_id must be a non-empty string');
  const reason = body['reason'];
  if (typeof reason !== 'string') throw new Error('reason must be a string');
  if (reason.trim() === '') throw new Error('reason must not be blank');
  if ([...reason].length > OWNER_APPROVAL_REASON_MAX_CHARS) throw new Error(`reason must be at most ${String(OWNER_APPROVAL_REASON_MAX_CHARS)} characters`);
  if (hasControlChars(reason)) throw new Error('reason must not contain control characters other than tab and newline, line or paragraph separators, or bidi override and isolate characters');
  const idempotencyKey = body['idempotency_key'];
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new Error('idempotency_key must be 1-128 characters of A-Z, a-z, 0-9, ".", "_" or "-"');
  }
  return { kind: kind as OwnerApprovalKind, requestId, reason, idempotencyKey };
}

/** The message of an unexpected error, redacted and cut: it reaches the
 * ledger, a card and a response. */
function errorMessage(error: unknown): string {
  return redactCredentials(error instanceof Error ? error.message : String(error)).slice(0, ERROR_MESSAGE_CHARS);
}

/** A card post that failed only because the store was busy or locked (SQLITE_BUSY,
 * SQLITE_LOCKED): the card is fine and the same post can succeed later. Every
 * other failure (a decision outside its bounds, a constraint, a store that is
 * gone) cannot be cured by asking again. */
export function isTransientCardPostFailure(error: unknown): boolean {
  const failed = error as { errcode?: unknown; message?: unknown } | null;
  const code = typeof failed?.errcode === 'number' ? failed.errcode % 256 : null;
  return code === 5 || code === 6 ||
    (typeof failed?.message === 'string' && /database (?:table )?is (?:locked|busy)/iu.test(failed.message));
}

/** The card's decision for a record, built from its stored facts alone. */
function cardDecision(record: OwnerApprovalRecord): NotificationDecision {
  const prefix = `Request ${record.requestId} on job ${record.jobId} (${record.fences.state}). Reason: `;
  return {
    question: `Abandon directive request ${record.requestId} as outcome-unknown?`,
    context: `${prefix}${[...record.reason].slice(0, REASON_EXCERPT_CHARS).join('')}`,
    recommendation: null,
    reservedClass: 'destructive',
    whyNotDelegable: WHY_NOT_DELEGABLE,
    options: [
      { id: 'approve', label: 'Approve', consequence: APPROVE_CONSEQUENCE },
      { id: 'deny', label: 'Deny', consequence: DENY_CONSEQUENCE },
    ],
    discussion: false,
  };
}

/** The card's full text: the whole reason and the four fences the Approve is bound to. */
function cardDetail(record: OwnerApprovalRecord): string {
  return [
    `Gru proposes abandoning directive request ${record.requestId} as outcome-unknown (approval ${record.id}).`,
    `Reason: ${record.reason}`,
    'The Approve is bound to what Gru read:',
    `job_id: ${record.fences.jobId}`,
    `state: ${record.fences.state}`,
    `payload_hash: ${record.fences.payloadHash}`,
    `debt_generation: ${record.fences.debtGeneration === null ? 'none' : String(record.fences.debtGeneration)}`,
    'If any of them changed by the time you approve, nothing is run.',
  ].join('\n');
}

/** What the card closes with (and what the record's history keeps). */
function refusalDetail(refusal: OwnerApprovalRefusal): string {
  return [
    `Not run: ${refusal.code}`,
    ...refusal.blockers,
    ...(refusal.code === 'retirement_available' ? ['Ordinary retirement is available; Gru retires it instead.'] : []),
  ].join('\n');
}

const succeededDetail = (seq: number): string => `Abandoned as outcome-unknown (abandonment event seq ${String(seq)}).`;
const DENIED_DETAIL = 'Denied by the owner; nothing was run.';

function view(ledger: ServiceLedger, record: OwnerApprovalRecord): OwnerApprovalView {
  return {
    id: record.id,
    kind: record.kind,
    request_id: record.requestId,
    job_id: record.jobId,
    state: record.state,
    attempts: record.attempts,
    fences: { job_id: record.fences.jobId, state: record.fences.state, payload_hash: record.fences.payloadHash, debt_generation: record.fences.debtGeneration },
    reason: record.reason,
    notification_id: record.notificationId,
    history: ledger.ownerApprovalHistory(record.id),
    outcome: {
      abandonment_event_seq: record.abandonmentEventSeq,
      refusal: record.refusal === null ? null : { code: record.refusal.code, blockers: [...record.refusal.blockers] },
    },
  };
}

/** What a boot without the service did to the records an earlier boot left. */
export interface UnhostedOwnerApprovalOutcome {
  /** Undecided cards withdrawn and their records ended `withdrawn`. */
  readonly withdrawn: readonly string[];
  /** Records left alone for the boot that hosts the service again. */
  readonly kept: readonly string[];
}

/** Why a record ended `withdrawn` on an unhosted boot (the history detail starts with it). */
export const OWNER_APPROVAL_UNHOSTED_REASON = 'service-unhosted';
const UNHOSTED_WITHDRAWN_DETAIL = `${OWNER_APPROVAL_UNHOSTED_REASON}: owner approvals need the service hosted ([silas] enabled = true), ` +
  'so nothing from this card is run. Ask Gru to propose it again once they are on.';

/**
 * Approval cards need the service hosted (`[silas] enabled = true`). A boot
 * that does not host it must not leave an undecided approval card open: the
 * owner's Approve would be recorded and nothing would carry it out. So every
 * open, undecided card of an earlier boot is withdrawn and its record ends
 * `withdrawn` with the reason `service-unhosted`.
 *
 * A decided, `approved` or `executing` record is left alone: the owner already
 * answered (or the operation is under way and may already have run), and the
 * next boot that hosts the service processes it as it always does (its
 * reconcile reads the decision and the abandonment audit; it never runs
 * twice). Each record is handled on its own; one that cannot be ended is
 * logged and kept, and never stops the boot.
 */
export function withdrawUnhostedOwnerApprovals(deps: {
  readonly ledger: Pick<ServiceLedger, 'listActiveOwnerApprovalIds' | 'getOwnerApproval' | 'getNotification' | 'withdrawOwnerProposal' | 'endOwnerApproval'>;
  readonly log?: Log;
}): UnhostedOwnerApprovalOutcome {
  const { ledger } = deps;
  const log: Log = deps.log ?? (() => {});
  const withdrawn: string[] = [];
  const kept: string[] = [];
  for (const id of ledger.listActiveOwnerApprovalIds()) {
    try {
      const record = ledger.getOwnerApproval(id);
      if (record === null) continue;
      if (record.state !== 'proposed') { kept.push(id); continue; }
      const card = ledger.getNotification(record.notificationId);
      if (card !== null && card.decidedAt !== null) { kept.push(id); continue; }
      if (card !== null && card.resolvedAt === null) {
        try {
          ledger.withdrawOwnerProposal(card.id, UNHOSTED_WITHDRAWN_DETAIL);
        } catch (error) {
          // A decision landed between the read and the withdrawal: it stands.
          if (error instanceof NotificationDecisionRefusal && error.code === 'decision_recorded') { kept.push(id); continue; }
          throw error;
        }
      }
      ledger.endOwnerApproval(id, { state: 'withdrawn', detail: UNHOSTED_WITHDRAWN_DETAIL });
      withdrawn.push(id);
    } catch (error) {
      kept.push(id);
      log('error', 'owner approval: could not end a record while the service is not hosted', { id, error: String(error) });
    }
  }
  if (withdrawn.length + kept.length > 0) {
    log('info', 'owner approvals are not hosted: open undecided approvals were withdrawn', { withdrawn, kept });
  }
  return { withdrawn, kept };
}

export function createOwnerApprovalService(deps: OwnerApprovalServiceDeps): OwnerApprovalService {
  const { ledger } = deps;
  const log: Log = deps.log ?? (() => {});
  const step = (name: OwnerApprovalStep): void => deps.afterStep?.(name);
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const requireRecord = (id: string): OwnerApprovalRecord => {
    const record = ledger.getOwnerApproval(id);
    if (record === null) throw new RecordNotFound(`owner approval "${id}" not found`);
    return record;
  };

  /** A request still owes completion (`dispatching` or `admitted`). */
  const requestIsLive = (requestId: string): boolean => {
    const row = ledger.getDirective(requestId);
    return row !== null && row.abandonedAt === null && (row.state === 'dispatching' || row.state === 'admitted');
  };

  /** Close the record's card with what happened. An undecided card of an ended
   * record is withdrawn instead: no choice was made on it. */
  const closeCard = (record: OwnerApprovalRecord, detail: string): void => {
    const card = ledger.getNotification(record.notificationId);
    if (card === null || card.resolvedAt !== null) return;
    if (card.decidedAt === null) ledger.withdrawOwnerProposal(card.id, detail);
    else ledger.resolveOwnerDecision(card.id, detail, OWNER_PROVENANCE);
  };

  const finishRefused = (record: OwnerApprovalRecord, refusal: OwnerApprovalRefusal): void => {
    const detail = refusalDetail(refusal);
    ledger.endOwnerApproval(record.id, { state: 'refused', refusal, detail });
    step('terminal-written');
    closeCard(record, detail);
  };

  const finishSucceeded = (record: OwnerApprovalRecord, abandonmentEventSeq: number): void => {
    const detail = succeededDetail(abandonmentEventSeq);
    ledger.endOwnerApproval(record.id, { state: 'succeeded', abandonmentEventSeq, detail });
    step('terminal-written');
    closeCard(record, detail);
  };

  /** The fences the Approve is bound to, read again: null when they all hold,
   * else why nothing runs. An abandonment by another route comes first. */
  const revalidate = (record: OwnerApprovalRecord): OwnerApprovalRefusal | null => {
    const now = ledger.ownerApprovalFenceReadback(record.requestId);
    if (now === null) {
      return { code: 'stale-fence', blockers: [`request: expected directive request ${record.requestId}, actual none`] };
    }
    if (now.state === 'abandoned') {
      return { code: 'abandoned-elsewhere', blockers: [`request ${record.requestId} was already abandoned by another route`] };
    }
    const blockers: string[] = [];
    const compare = (field: string, expected: string | number | null, actual: string | number | null): void => {
      if (expected !== actual) blockers.push(`${field}: expected ${String(expected)}, actual ${String(actual)}`);
    };
    compare('job_id', record.fences.jobId, now.jobId);
    compare('state', record.fences.state, now.state);
    compare('payload_hash', record.fences.payloadHash, now.payloadHash);
    compare('debt_generation', record.fences.debtGeneration, now.debtGeneration);
    return blockers.length === 0 ? null : { code: 'stale-fence', blockers };
  };

  /** The abandonment of the record's request recorded after its `executing`
   * event, if any: this record's own or another route's. */
  const abandonmentAfterExecuting = (record: OwnerApprovalRecord): { readonly seq: number; readonly own: boolean } | null => {
    if (record.executingSeq === null) return null;
    const event = ledger.latestJobEventByRequestId(record.jobId, 'silas.directive-abandoned', record.requestId, { sinceSeq: record.executingSeq });
    if (event === null) return null;
    const reason = (event.payload as { reason?: unknown } | null)?.reason;
    return { seq: event.seq, own: typeof reason === 'string' && reason.startsWith(ownerApprovalReasonPrefix(record.id)) };
  };

  const settleFromAbandonment = (record: OwnerApprovalRecord, abandonment: { readonly seq: number; readonly own: boolean }): void => {
    if (abandonment.own) finishSucceeded(record, abandonment.seq);
    else finishRefused(record, { code: 'abandoned-elsewhere', blockers: [`request ${record.requestId} was abandoned by another route (event seq ${String(abandonment.seq)})`] });
  };

  /** Carry out the abandonment the record is bound to. The ledger refuses what
   * it must (a live producer, retirement available); anything else it throws
   * is an attempt that failed. */
  const execute = (record: OwnerApprovalRecord): void => {
    let outcome: ReturnType<typeof abandonLiveDirectiveFromRoute>;
    try {
      outcome = abandonLiveDirectiveFromRoute({
        ledger,
        worktrees: deps.worktrees,
        ...(deps.workerGate !== undefined ? { workerGate: deps.workerGate } : {}),
        pendingProducerBlockers: deps.pendingProducerBlockers,
        requestId: record.requestId,
        expected: { jobId: record.fences.jobId, state: record.fences.state, payloadHash: record.fences.payloadHash },
        reason: `${ownerApprovalReasonPrefix(record.id)}${record.reason}`,
        by: 'owner',
      });
    } catch (error) {
      if (error instanceof DirectiveRetirementError) {
        finishRefused(record, { code: error.code, blockers: [...error.blockers] });
        return;
      }
      const message = errorMessage(error);
      const after = ledger.recordOwnerApprovalAttemptFailure(record.id, message);
      log('warn', 'owner approval: the abandonment failed', { id: record.id, request: record.requestId, attempts: after.attempts, ended: after.state !== 'executing', error: message });
      if (after.state === 'refused') {
        step('terminal-written');
        closeCard(record, refusalDetail(after.refusal ?? { code: 'execution-error', blockers: [message] }));
      }
      return;
    }
    step('ledger-abandoned');
    const reason = (outcome.event.payload as { reason?: unknown } | null)?.reason;
    settleFromAbandonment(record, { seq: outcome.event.seq, own: typeof reason === 'string' && reason.startsWith(ownerApprovalReasonPrefix(record.id)) });
  };

  /** Take an `approved` or `executing` record as far as it goes (never twice). */
  const carryOut = (id: string): void => {
    let record = requireRecord(id);
    if (record.state === 'approved') {
      const refusal = revalidate(record);
      if (refusal !== null) { finishRefused(record, refusal); return; }
      record = ledger.beginOwnerApprovalExecution(id, 'fences hold; abandoning the request');
      step('executing-written');
    } else if (record.state === 'executing') {
      const abandonment = abandonmentAfterExecuting(record);
      if (abandonment !== null) { settleFromAbandonment(record, abandonment); return; }
      const refusal = revalidate(record);
      if (refusal !== null) { finishRefused(record, refusal); return; }
    } else {
      return;
    }
    execute(record);
  };

  /** A `proposed` record whose card has a recorded decision. */
  const processDecision = (record: OwnerApprovalRecord, card: NotificationRecord): void => {
    if (record.state !== 'proposed' || card.decidedAt === null) return;
    if (card.decidedBy !== OWNER_DECIDER) {
      finishRefused(record, { code: 'decider-not-owner', blockers: [`decided by ${JSON.stringify(card.decidedBy)}, not "${OWNER_DECIDER}"`] });
      return;
    }
    if (card.decidedOption === 'deny') {
      ledger.endOwnerApproval(record.id, { state: 'denied', detail: DENIED_DETAIL });
      step('terminal-written');
      closeCard(record, DENIED_DETAIL);
      return;
    }
    if (card.decidedOption !== 'approve') {
      throw new Error(`owner approval "${record.id}": card "${card.id}" records option "${String(card.decidedOption)}", which is neither approve nor deny`);
    }
    ledger.approveOwnerApproval(record.id, 'approved by the owner');
    step('approved-written');
    carryOut(record.id);
  };

  const postCard = (record: OwnerApprovalRecord): void => {
    deps.notifications.post({
      id: record.notificationId,
      kind: DIRECTIVE_ABANDON_CARD_KIND,
      routing: 'needs-owner',
      severity: 'error',
      title: `Abandon directive request ${record.requestId}?`,
      detail: cardDetail(record),
      decision: cardDecision(record),
    });
  };

  /** Post the record's card, or end the record `refused` (`card-post-failed`)
   * when that fails for good: a record whose card can never exist must not
   * stay `proposed`, or every new proposal for its request is answered
   * pending. A transient failure (the store busy or locked) leaves the record
   * `proposed` for the next reconcile to post again, and so does a failure
   * after the card itself was committed. The proposal and the
   * reconcile's repost both go through here, so they classify alike. */
  const postCardOrRefuse = (record: OwnerApprovalRecord): void => {
    try {
      postCard(record);
    } catch (error) {
      const message = errorMessage(error);
      // The write is what matters: a post commits the card and then runs hooks
      // (the owner bell), and one of them can throw. A card that is there is
      // posted - refusing the record would leave an open, decidable card whose
      // Approve is recorded and ignored.
      if (ledger.getNotification(record.notificationId) !== null) {
        log('warn', 'owner approval: something after the card was posted failed; the card stands', { id: record.id, error: message });
        return;
      }
      if (isTransientCardPostFailure(error)) {
        log('warn', 'owner approval: the card could not be posted yet; the next reconcile retries it', { id: record.id, error: message });
        return;
      }
      log('error', 'owner approval: the card could not be posted', { id: record.id, error: message });
      ledger.endOwnerApproval(record.id, { state: 'refused', refusal: { code: 'card-post-failed', blockers: [message] }, detail: `Not run: card-post-failed\n${message}` });
    }
  };

  /** The request ended some other way before the owner answered: the card is
   * withdrawn, then the record. A decision that landed first is carried out. */
  const withdraw = (record: OwnerApprovalRecord, card: NotificationRecord): void => {
    const detail = `Request ${record.requestId} is no longer live; nothing from this card is run.`;
    try {
      ledger.withdrawOwnerProposal(card.id, detail);
    } catch (error) {
      if (error instanceof NotificationDecisionRefusal && error.code === 'decision_recorded') {
        const decided = ledger.getNotification(card.id);
        if (decided !== null) processDecision(record, decided);
        return;
      }
      throw error;
    }
    step('card-withdrawn');
    ledger.endOwnerApproval(record.id, { state: 'withdrawn', detail });
    step('terminal-written');
  };

  const reconcileProposed = (record: OwnerApprovalRecord): void => {
    const card = ledger.getNotification(record.notificationId);
    if (card === null) {
      if (!requestIsLive(record.requestId)) {
        ledger.endOwnerApproval(record.id, { state: 'withdrawn', detail: `Request ${record.requestId} is no longer live; no card was posted.` });
        return;
      }
      postCardOrRefuse(record);
      return;
    }
    if (card.decidedAt !== null) { processDecision(record, card); return; }
    if (card.resolvedAt !== null) {
      ledger.endOwnerApproval(record.id, { state: 'withdrawn', detail: 'The card was withdrawn before the owner answered.' });
      step('terminal-written');
      return;
    }
    if (!requestIsLive(record.requestId)) withdraw(record, card);
  };

  const guarded = (what: string, id: string, work: () => void): void => {
    try { work(); } catch (error) { log('error', `owner approval: ${what} failed; the next reconcile retries it`, { id, error: String(error) }); }
  };

  const reconcile = (): void => {
    for (const id of ledger.listActiveOwnerApprovalIds()) {
      guarded('reconcile', id, () => {
        const record = requireRecord(id);
        if (record.state === 'proposed') reconcileProposed(record);
        else carryOut(id);
      });
    }
    for (const id of ledger.listEndedOwnerApprovalIdsWithOpenCard()) {
      guarded('card closure', id, () => {
        const record = requireRecord(id);
        closeCard(record, record.refusal !== null ? refusalDetail(record.refusal)
          : record.state === 'succeeded' ? succeededDetail(record.abandonmentEventSeq ?? 0)
            : record.state === 'denied' ? DENIED_DETAIL : 'The proposal ended without being carried out.');
      });
    }
  };

  const onDecision = (notificationId: string): void => {
    const record = ledger.ownerApprovalForNotification(notificationId);
    if (record === null || record.state !== 'proposed') return;
    const card = ledger.getNotification(notificationId);
    if (card !== null) processDecision(record, card);
  };

  const propose = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let proposal: ReturnType<typeof parseProposal>;
    try {
      proposal = parseProposal(await readBody(req));
    } catch (error) {
      json(res, 400, { error: 'bad_request', detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    const result = ledger.proposeOwnerApproval(proposal);
    switch (result.kind) {
      case 'replayed':
        json(res, 200, { approval: view(ledger, result.approval) });
        return;
      case 'key_conflict':
        json(res, 409, { error: 'owner_approval_key_conflict', detail: `idempotency_key "${proposal.idempotencyKey}" was already used for a different proposal (${result.approval.id})` });
        return;
      case 'unknown_request':
        json(res, 404, { error: 'owner_approval_unknown_request', detail: `directive request "${proposal.requestId}" not found` });
        return;
      case 'not_live':
        json(res, 409, { error: 'owner_approval_not_live', detail: `directive request "${proposal.requestId}" is ${result.state} — only a live request can be proposed for abandonment` });
        return;
      case 'pending':
        json(res, 409, { error: 'owner_approval_pending', detail: `directive request "${proposal.requestId}" already has owner approval ${result.approval.id} (${result.approval.state})`, approval_id: result.approval.id });
        return;
      case 'created': {
        step('record-written');
        postCardOrRefuse(result.approval);
        json(res, 201, { approval: view(ledger, requireRecord(result.approval.id)) });
        return;
      }
    }
  };

  const service: OwnerApprovalService = {
    start(): void {
      if (unsubscribe !== null) return;
      unsubscribe = deps.bus.subscribe((event) => {
        if (event.kind !== 'notification.decision') return;
        const id = (event.payload as { id?: unknown } | null)?.id;
        if (typeof id !== 'string') return;
        guarded('decision follow-through', id, () => onDecision(id));
      });
      timer = (deps.setInterval ?? setInterval)(() => {
        try { service.reconcile(); } catch (error) { log('error', 'owner approval reconcile failed; the next interval retries it', { error: String(error) }); }
      }, OWNER_APPROVAL_RECONCILE_INTERVAL_MS);
      timer.unref?.();
      try { service.reconcile(); } catch (error) { log('error', 'owner approval boot reconcile failed; the next interval retries it', { error: String(error) }); }
    },

    stop(): void {
      unsubscribe?.();
      unsubscribe = null;
      if (timer !== null) (deps.clearInterval ?? clearInterval)(timer);
      timer = null;
    },

    reconcile,

    async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
      if (path === '/api/owner-approvals') {
        if (req.method !== 'POST') return false;
        await propose(req, res);
        return true;
      }
      const read = /^\/api\/owner-approvals\/([^/]+)$/u.exec(path);
      if (read !== null && req.method === 'GET') {
        const id = decodeURIComponent(read[1] ?? '');
        const record = ledger.getOwnerApproval(id);
        if (record === null) json(res, 404, { error: 'owner_approval_not_found', detail: `no owner approval "${id}"` });
        else json(res, 200, view(ledger, record));
        return true;
      }
      return false;
    },
  };
  return service;
}
