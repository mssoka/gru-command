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
import type { NotificationDecision, NotificationDecisionOption } from '../ledger/notification-decision.js';
import {
  OWNER_APPROVAL_CARD_KIND,
  OWNER_APPROVAL_KINDS,
  OWNER_APPROVAL_REASON_MAX_CHARS,
  ownerApprovalSubject,
  type OwnerApprovalKind,
  type OwnerApprovalProposalInput,
  type OwnerApprovalSubject,
  type RecoveryOwnerContract,
} from '../ledger/owner-approvals.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { DirectiveCheckpointError } from '../runtime/directive-checkpoint.js';
import type { PacingGate } from '../runtime/pacing.js';
import { redactCredentials } from '../redaction.js';
import { abandonLiveDirectiveFromRoute, abandonPendingRebriefFromRoute, recoveryOwnerActionFromRoute } from './directive-recovery.js';
import type { WorktreePort } from './worktree-port.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Owner approval of owner-reserved actions (#523, #565). Abandoning a request
 * whose producer custody is unknown, abandoning a pending re-brief marker
 * generation, recording a recovery ruling and confirming the governing stop
 * are all the owner's call, and the owner should not run a terminal script to
 * make them. Gru proposes one action (`POST /api/owner-approvals`); the
 * proposal is one FOR YOU card with Approve and Deny; the owner's Approve
 * makes this service carry out the same guarded route an owner's own request
 * calls, with the fences read when the proposal was made checked again first,
 * and the card closes with what actually happened.
 *
 * One mechanism, four actions. Everything the kind changes is in its
 * `OwnerApprovalPlan` (its card text, its liveness, its fences, its audit and
 * its executor); every state, transition, refusal, retry and reconcile step
 * is shared, so a new kind can never invent a second pipeline.
 *
 * Every state change of a record is one ledger transaction that appends an
 * `owner-approval.<state>` event, so a crash leaves the record in a state
 * `reconcile()` knows how to finish, and the action never runs twice.
 *
 * Attribution is the same caller-declared model as the routes: one shared
 * bearer, no verified identity. Gru never sends `by: "owner"`; the card's
 * decision names its decider, and only an exact `owner` is acted on. The
 * decision's `expectedDecision` echo stands in for `confirm_intent`.
 */

/** The card kind of each approval kind (registered in the attention registry). */
export const OWNER_APPROVAL_CARD_KINDS: Readonly<Record<OwnerApprovalKind, string>> = OWNER_APPROVAL_CARD_KIND;

/** The directive-abandonment card kind (the first action, #523). */
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

const DENY_CONSEQUENCE_DIRECTIVE = 'Nothing runs. The request stays as it is.';
const DENY_CONSEQUENCE_REBRIEF = 'Nothing runs. The marker generation stays as it is.';
const DENY_CONSEQUENCE_RESOLUTION = 'Nothing is recorded. The recovery subject stays exactly as it is.';
const DENY_CONSEQUENCE_STOP = 'Nothing is settled. The stop stays exactly as it is.';
const WHY_NOT_DELEGABLE_DIRECTIVE = 'Abandonment is owner-reserved: only the owner may close a request whose producer custody is unknown.';
const APPROVE_CONSEQUENCE_DIRECTIVE = 'Closes the request as outcome-unknown. Nothing is replayed. No completion, no-effect or cessation is recorded. ' +
  "The job's status is unchanged. The lane stays held until the job is binned or fresh owner-accepted work is admitted there.";
const WHY_NOT_DELEGABLE_REBRIEF = 'Re-brief abandonment is owner-reserved: only the owner may close a marker generation whose producer custody is unknown.';
const APPROVE_CONSEQUENCE_REBRIEF = 'Deletes the marker generation as outcome-unknown. Nothing is replayed. No completion, no-effect or cessation is recorded. ' +
  "The job's status is unchanged. The lane stays held until the job is binned or fresh owner-accepted work is admitted there.";
const WHY_NOT_DELEGABLE_RESOLUTION = 'The ruling is owner-reserved: it records the owner\'s own narrow permission for a preserved recovery subject, which no automation may grant.';
const APPROVE_CONSEQUENCE_RESOLUTION = 'Records the ruling only. No stop is released, nothing is unparked, no notification is Acked, no work is executed, and no cessation, effect or completion is claimed.';
const WHY_NOT_DELEGABLE_STOP = 'Confirming the governing stop is owner-reserved: only the owner may affirm that this exact ruling resolves the stop it was written for.';
const APPROVE_CONSEQUENCE_STOP = 'Settles only this governing stop with a confirmation receipt. Parking, other holds, cards and work execution are unchanged; nothing is unparked or Acked.';

/** The steps a crash can follow; the test seam names them. */
export const OWNER_APPROVAL_STEPS = [
  'record-written',
  'approved-written',
  'executing-written',
  'action-recorded',
  'terminal-written',
  'card-withdrawn',
] as const;
export type OwnerApprovalStep = (typeof OWNER_APPROVAL_STEPS)[number];

type ServiceLedger = Pick<LedgerApi,
  | 'proposeOwnerApproval' | 'getOwnerApproval' | 'ownerApprovalForNotification' | 'ownerApprovalHistory'
  | 'ownerApprovalDirectiveFenceReadback' | 'ownerApprovalRebriefFenceReadback' | 'ownerApprovalRecoveryFence'
  | 'approveOwnerApproval' | 'beginOwnerApprovalExecution' | 'endOwnerApproval' | 'recordOwnerApprovalAttemptFailure'
  | 'listActiveOwnerApprovalIds' | 'listEndedOwnerApprovalIdsWithOpenCard'
  | 'getNotification' | 'resolveOwnerDecision' | 'withdrawOwnerProposal'
  | 'getDirective' | 'listPendingRebriefs' | 'rebriefAbandonment' | 'abandonLiveDirective' | 'abandonPendingRebrief' | 'listAgents'
  | 'latestJobEventByRequestId' | 'latestJobEventByPayloadField'
  | 'recoverySubject' | 'recoveryOwnerResolution' | 'recoveryOwnerReadback'
  | 'recordRecoveryOwnerResolution' | 'confirmRecoveryOwnerStop'>;

export interface OwnerApprovalServiceDeps {
  readonly ledger: ServiceLedger;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  readonly bus: Pick<EventBus, 'subscribe'>;
  /** The evidence the abandonment routes read beside the ledger. */
  readonly worktrees: Pick<WorktreePort, 'listWorktrees'>;
  readonly workerGate?: Pick<PacingGate, 'view'>;
  readonly pendingProducerBlockers: (jobId: string) => readonly string[];
  readonly log?: Log;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  /** Test seam: called after a named step has been written. Throwing from it
   * stands in for a crash at that point. Production never passes it. */
  readonly afterStep?: (step: OwnerApprovalStep) => void;
  /** Test seam: the native owner abandonment the directive execution step
   * runs. Production never passes it — `abandonLiveDirectiveFromRoute` is the
   * default — and the crash/failure tests use it to make that one call throw
   * without spying on the ledger. */
  readonly abandonment?: (input: Parameters<typeof abandonLiveDirectiveFromRoute>[0]) => ReturnType<typeof abandonLiveDirectiveFromRoute>;
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
  readonly subject: {
    readonly kind: OwnerApprovalSubject['kind'];
    readonly id: string;
    /** The recovery subject's own kind; null for an abandonment. */
    readonly recovery_kind: 'directive' | 'rebrief' | null;
  };
  /** The directive subject's request id; null for every other subject. */
  readonly request_id: string | null;
  readonly job_id: string;
  readonly state: string;
  readonly attempts: number;
  readonly fences: {
    readonly job_id: string;
    readonly state: string | null;
    readonly payload_hash: string | null;
    readonly debt_generation: number | null;
  };
  /** The recovery kinds' ten-fence contract; null for an abandonment. */
  readonly contract: RecoveryOwnerContract | null;
  readonly resolution_id: string | null;
  readonly expected_resolution_fingerprint: string | null;
  readonly reason: string;
  readonly notification_id: string;
  readonly history: readonly { readonly state: string; readonly at: string; readonly detail: string | null }[];
  readonly outcome: {
    readonly audit_event_seq: number | null;
    readonly refusal: { readonly code: string; readonly blockers: readonly string[] } | null;
  };
}

/** The reason the action carries, so its audit event names the approval. */
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

/** A required non-empty string field of a proposal body. */
function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value;
}

/** A required non-negative integer field of a proposal body (a fence). */
function numberField(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

/** The recovery kinds' ten-fence contract, as the proposal body carries it.
 * Every field is required: an unfenced recovery proposal is refused rather
 * than bound to whatever the service reads later. */
function recoveryContract(body: Record<string, unknown>): RecoveryOwnerContract {
  const kind = body['recovery_kind'];
  if (kind !== 'directive' && kind !== 'rebrief') throw new Error('recovery_kind must be "directive" or "rebrief"');
  return {
    kind,
    transferEventSeq: numberField(body, 'expected_transfer_event_seq'),
    expectedTransferFingerprint: stringField(body, 'expected_transfer_fingerprint'),
    expectedSubjectSha256: stringField(body, 'expected_subject_sha256'),
    expectedTargetGeneration: numberField(body, 'expected_target_generation'),
    expectedTargetPlanRevision: numberField(body, 'expected_target_plan_revision'),
    expectedLineageSha256: stringField(body, 'expected_lineage_sha256'),
    expectedEpoch: numberField(body, 'expected_epoch'),
    expectedHead: stringField(body, 'expected_head'),
    expectedWorkRevision: numberField(body, 'expected_work_revision'),
    expectedContractSha256: stringField(body, 'expected_contract_sha256'),
  };
}

/** A proposal body, or the reason it is malformed (a 400). Each kind names
 * its target exactly: `request_id` for a directive request, `marker_id` for a
 * re-brief marker generation, and `recovery_kind` + `subject_id` +
 * `resolution_id` (+ the ruling's `expected_resolution_fingerprint` for a
 * stop) for a recovery subject. */
function parseProposal(body: Record<string, unknown>): OwnerApprovalProposalInput {
  const kind = body['kind'];
  if (typeof kind !== 'string' || !(OWNER_APPROVAL_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of ${OWNER_APPROVAL_KINDS.join(', ')}`);
  }
  if (body['by'] !== 'gru') throw new Error('by must be "gru": an owner approval is proposed by Gru, and the owner answers on the card');
  const reason = body['reason'];
  if (typeof reason !== 'string') throw new Error('reason must be a string');
  if (reason.trim() === '') throw new Error('reason must not be blank');
  if ([...reason].length > OWNER_APPROVAL_REASON_MAX_CHARS) throw new Error(`reason must be at most ${String(OWNER_APPROVAL_REASON_MAX_CHARS)} characters`);
  if (hasControlChars(reason)) throw new Error('reason must not contain control characters other than tab and newline, line or paragraph separators, or bidi override and isolate characters');
  const idempotencyKey = body['idempotency_key'];
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new Error('idempotency_key must be 1-128 characters of A-Z, a-z, 0-9, ".", "_" or "-"');
  }
  switch (kind) {
    case 'directive-abandon':
      return { kind, requestId: stringField(body, 'request_id'), reason, idempotencyKey };
    case 'rebrief-abandon':
      return { kind, markerId: stringField(body, 'marker_id'), reason, idempotencyKey };
    case 'recovery-owner-resolution':
      return { kind, subjectId: stringField(body, 'subject_id'), contract: recoveryContract(body),
        resolutionId: stringField(body, 'resolution_id'), reason, idempotencyKey };
    case 'recovery-owner-stop':
      return { kind, subjectId: stringField(body, 'subject_id'), contract: recoveryContract(body),
        resolutionId: stringField(body, 'resolution_id'),
        expectedResolutionFingerprint: stringField(body, 'expected_resolution_fingerprint'), reason, idempotencyKey };
    default:
      throw new Error(`kind "${kind}" has no proposal body`);
  }
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

/** One approval kind's own parts: its card, its liveness, its fences, its
 * audit and its executor. Everything else is shared. */
interface OwnerApprovalPlan {
  readonly kind: OwnerApprovalKind;
  readonly cardKind: string;
  card(record: OwnerApprovalRecord): { readonly title: string; readonly detail: string; readonly decision: NotificationDecision };
  /** The subject still owes this action: a `proposed` record whose subject
   * ended is withdrawn, never carried out. */
  isLive(record: OwnerApprovalRecord): boolean;
  /** The fences read again: null when they all hold, else why nothing runs. */
  revalidate(record: OwnerApprovalRecord): OwnerApprovalRefusal | null;
  /** This record's own audit event recorded after its `executing` event, if
   * any: `own` says whether the audit carries this approval's reason prefix. */
  recorded(record: OwnerApprovalRecord): { readonly seq: number; readonly own: boolean } | null;
  /** Why an audit this record did not write refuses it. */
  elsewhere(record: OwnerApprovalRecord, seq: number): OwnerApprovalRefusal;
  /** Carry the action out; answers the audit event's seq. The ledger's typed
   * refusals (`DirectiveRetirementError`, `DirectiveCheckpointError`,
   * `RecordNotFound`) refuse the record by name; every other throw is one
   * failed attempt. */
  execute(record: OwnerApprovalRecord): number;
  succeededDetail(seq: number): string;
  /** What a withdrawn card says when the subject ended some other way. */
  noLongerLive(record: OwnerApprovalRecord): string;
}

/** A card's two answers, always exactly Approve and Deny. */
function options(approveConsequence: string, denyConsequence: string): readonly NotificationDecisionOption[] {
  return [
    { id: 'approve', label: 'Approve', consequence: approveConsequence },
    { id: 'deny', label: 'Deny', consequence: denyConsequence },
  ];
}

function excerpt(reason: string): string {
  return [...reason].slice(0, REASON_EXCERPT_CHARS).join('');
}

/** The recovery fences, one per line: the owner must see the exact generation,
 * plan, epoch and head the ruling is bound to, not a summary. */
function contractLines(contract: RecoveryOwnerContract): readonly string[] {
  return [
    `recovery_kind: ${contract.kind}`,
    `transfer_event_seq: ${String(contract.transferEventSeq)}`,
    `transfer_fingerprint: ${contract.expectedTransferFingerprint}`,
    `subject_sha256: ${contract.expectedSubjectSha256}`,
    `target_generation: ${String(contract.expectedTargetGeneration)}`,
    `target_plan_revision: ${String(contract.expectedTargetPlanRevision)}`,
    `lineage_sha256: ${contract.expectedLineageSha256}`,
    `epoch: ${String(contract.expectedEpoch)}`,
    `head: ${contract.expectedHead}`,
    `work_revision: ${String(contract.expectedWorkRevision)}`,
    `contract_sha256: ${contract.expectedContractSha256}`,
  ];
}

/** What the card closes with (and what the record's history keeps). */
function refusalDetail(refusal: OwnerApprovalRefusal): string {
  return [
    `Not run: ${refusal.code}`,
    ...refusal.blockers,
    ...(refusal.code === 'retirement_available' ? ['Ordinary retirement is available; Gru retires it instead.'] : []),
  ].join('\n');
}

const DENIED_DETAIL = 'Denied by the owner; nothing was run.';

function view(ledger: ServiceLedger, record: OwnerApprovalRecord): OwnerApprovalView {
  const { subject } = record;
  const recovery = subject.kind === 'recovery' ? subject : null;
  return {
    id: record.id,
    kind: record.kind,
    subject: { kind: subject.kind, id: subject.id, recovery_kind: recovery === null ? null : recovery.fences.contract.kind },
    request_id: subject.kind === 'directive' ? subject.id : null,
    job_id: record.jobId,
    state: record.state,
    attempts: record.attempts,
    fences: {
      job_id: subject.fences.jobId,
      state: subject.kind === 'directive' ? subject.fences.state : null,
      payload_hash: subject.kind === 'recovery' ? null : subject.fences.payloadHash,
      debt_generation: subject.kind === 'recovery' ? null : subject.fences.debtGeneration,
    },
    contract: recovery === null ? null : recovery.fences.contract,
    resolution_id: recovery === null ? null : recovery.resolutionId,
    expected_resolution_fingerprint: recovery === null ? null : recovery.expectedResolutionFingerprint,
    reason: record.reason,
    notification_id: record.notificationId,
    history: ledger.ownerApprovalHistory(record.id),
    outcome: {
      audit_event_seq: record.auditEventSeq,
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
 * reconcile reads the decision and the action's audit; it never runs
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

  /** The directive plan: abandonment of one live directive request (#523). */
  const directivePlan: OwnerApprovalPlan = {
    kind: 'directive-abandon',
    cardKind: OWNER_APPROVAL_CARD_KIND['directive-abandon'],
    card(record) {
      const subject = ownerApprovalSubject(record, 'directive');
      return {
        title: `Abandon directive request ${subject.id}?`,
        detail: [
          `Gru proposes abandoning directive request ${subject.id} as outcome-unknown (approval ${record.id}).`,
          `Reason: ${record.reason}`,
          'The Approve is bound to what Gru read:',
          `job_id: ${subject.fences.jobId}`,
          `state: ${subject.fences.state}`,
          `payload_hash: ${subject.fences.payloadHash}`,
          `debt_generation: ${subject.fences.debtGeneration === null ? 'none' : String(subject.fences.debtGeneration)}`,
          'If any of them changed by the time you approve, nothing is run.',
        ].join('\n'),
        decision: {
          question: `Abandon directive request ${subject.id} as outcome-unknown?`,
          context: `Request ${subject.id} on job ${subject.fences.jobId} (${subject.fences.state}). Reason: ${excerpt(record.reason)}`,
          recommendation: null,
          reservedClass: 'destructive',
          whyNotDelegable: WHY_NOT_DELEGABLE_DIRECTIVE,
          options: options(APPROVE_CONSEQUENCE_DIRECTIVE, DENY_CONSEQUENCE_DIRECTIVE),
          discussion: false,
        },
      };
    },
    isLive(record) {
      const subject = ownerApprovalSubject(record, 'directive');
      const row = ledger.getDirective(subject.id);
      return row !== null && row.abandonedAt === null && (row.state === 'dispatching' || row.state === 'admitted');
    },
    revalidate(record) {
      const subject = ownerApprovalSubject(record, 'directive');
      const now = ledger.ownerApprovalDirectiveFenceReadback(subject.id);
      if (now === null) {
        return { code: 'stale-fence', blockers: [`request: expected directive request ${subject.id}, actual none`] };
      }
      if (now.state === 'abandoned') {
        return { code: 'abandoned-elsewhere', blockers: [`request ${subject.id} was already abandoned by another route`] };
      }
      const blockers: string[] = [];
      const compare = (field: string, expected: string | number | null, actual: string | number | null): void => {
        if (expected !== actual) blockers.push(`${field}: expected ${String(expected)}, actual ${String(actual)}`);
      };
      compare('job_id', subject.fences.jobId, now.jobId);
      compare('state', subject.fences.state, now.state);
      compare('payload_hash', subject.fences.payloadHash, now.payloadHash);
      compare('debt_generation', subject.fences.debtGeneration, now.debtGeneration);
      return blockers.length === 0 ? null : { code: 'stale-fence', blockers };
    },
    recorded(record) {
      if (record.executingSeq === null) return null;
      const subject = ownerApprovalSubject(record, 'directive');
      const event = ledger.latestJobEventByRequestId(record.jobId, 'silas.directive-abandoned', subject.id, { sinceSeq: record.executingSeq });
      if (event === null) return null;
      const reason = (event.payload as { reason?: unknown } | null)?.reason;
      return { seq: event.seq, own: typeof reason === 'string' && reason.startsWith(ownerApprovalReasonPrefix(record.id)) };
    },
    elsewhere(record, seq) {
      return { code: 'abandoned-elsewhere', blockers: [`request ${record.subject.id} was abandoned by another route (event seq ${String(seq)})`] };
    },
    execute(record) {
      const subject = ownerApprovalSubject(record, 'directive');
      const abandonment = deps.abandonment ?? abandonLiveDirectiveFromRoute;
      const outcome = abandonment({
        ledger,
        worktrees: deps.worktrees,
        ...(deps.workerGate !== undefined ? { workerGate: deps.workerGate } : {}),
        pendingProducerBlockers: deps.pendingProducerBlockers,
        requestId: subject.id,
        expected: { jobId: subject.fences.jobId, state: subject.fences.state, payloadHash: subject.fences.payloadHash },
        reason: `${ownerApprovalReasonPrefix(record.id)}${record.reason}`,
        by: 'owner',
      });
      return outcome.event.seq;
    },
    succeededDetail: (seq) => `Abandoned as outcome-unknown (abandonment event seq ${String(seq)}).`,
    noLongerLive: (record) => `Request ${record.subject.id} is no longer live; nothing from this card is run.`,
  };

  /** The re-brief plan: abandonment of one pending re-brief marker generation
   * (#565). A marker has no state; it is pending or it is gone, and its
   * never-twice proof is the `silas.rebrief-abandoned` audit keyed on
   * `marker_id` (the ledger's own idempotency is by marker id and would
   * silently replay a second run). */
  const rebriefPlan: OwnerApprovalPlan = {
    kind: 'rebrief-abandon',
    cardKind: OWNER_APPROVAL_CARD_KIND['rebrief-abandon'],
    card(record) {
      const subject = ownerApprovalSubject(record, 'rebrief-marker');
      return {
        title: `Abandon re-brief marker ${subject.id}?`,
        detail: [
          `Gru proposes abandoning re-brief marker ${subject.id} as outcome-unknown (approval ${record.id}).`,
          `Reason: ${record.reason}`,
          'The Approve is bound to what Gru read:',
          `job_id: ${subject.fences.jobId}`,
          `payload_hash: ${subject.fences.payloadHash}`,
          `debt_generation: ${subject.fences.debtGeneration === null ? 'none' : String(subject.fences.debtGeneration)}`,
          'If any of them changed, or the marker is no longer pending, nothing is run.',
        ].join('\n'),
        decision: {
          question: `Abandon re-brief marker ${subject.id} as outcome-unknown?`,
          context: `Marker ${subject.id} on job ${subject.fences.jobId}. Reason: ${excerpt(record.reason)}`,
          recommendation: null,
          reservedClass: 'destructive',
          whyNotDelegable: WHY_NOT_DELEGABLE_REBRIEF,
          options: options(APPROVE_CONSEQUENCE_REBRIEF, DENY_CONSEQUENCE_REBRIEF),
          discussion: false,
        },
      };
    },
    isLive(record) {
      return ledger.listPendingRebriefs().some((row) => row.id === record.subject.id);
    },
    revalidate(record) {
      const subject = ownerApprovalSubject(record, 'rebrief-marker');
      const now = ledger.ownerApprovalRebriefFenceReadback(subject.id);
      if (now === null) {
        if (ledger.rebriefAbandonment(subject.id) !== null) {
          return { code: 'abandoned-elsewhere', blockers: [`re-brief marker ${subject.id} was already abandoned by another route`] };
        }
        return { code: 'stale-fence', blockers: [`marker: expected re-brief marker ${subject.id}, actual none`] };
      }
      const blockers: string[] = [];
      const compare = (field: string, expected: string | number | null, actual: string | number | null): void => {
        if (expected !== actual) blockers.push(`${field}: expected ${String(expected)}, actual ${String(actual)}`);
      };
      compare('job_id', subject.fences.jobId, now.jobId);
      compare('payload_hash', subject.fences.payloadHash, now.payloadHash);
      compare('debt_generation', subject.fences.debtGeneration, now.debtGeneration);
      return blockers.length === 0 ? null : { code: 'stale-fence', blockers };
    },
    recorded(record) {
      if (record.executingSeq === null) return null;
      const event = ledger.latestJobEventByPayloadField(record.jobId, 'silas.rebrief-abandoned', 'marker_id',
        record.subject.id, { sinceSeq: record.executingSeq });
      if (event === null) return null;
      const reason = (event.payload as { reason?: unknown } | null)?.reason;
      return { seq: event.seq, own: typeof reason === 'string' && reason.startsWith(ownerApprovalReasonPrefix(record.id)) };
    },
    elsewhere(record, seq) {
      return { code: 'abandoned-elsewhere', blockers: [`re-brief marker ${record.subject.id} was abandoned by another route (event seq ${String(seq)})`] };
    },
    execute(record) {
      const subject = ownerApprovalSubject(record, 'rebrief-marker');
      const outcome = abandonPendingRebriefFromRoute({
        ledger,
        worktrees: deps.worktrees,
        ...(deps.workerGate !== undefined ? { workerGate: deps.workerGate } : {}),
        pendingProducerBlockers: deps.pendingProducerBlockers,
        markerId: subject.id,
        expected: { jobId: subject.fences.jobId, payloadHash: subject.fences.payloadHash },
        reason: `${ownerApprovalReasonPrefix(record.id)}${record.reason}`,
        by: 'owner',
      });
      return outcome.event.seq;
    },
    succeededDetail: (seq) => `Re-brief marker abandoned as outcome-unknown (abandonment event seq ${String(seq)}).`,
    noLongerLive: (record) => `Re-brief marker ${record.subject.id} is no longer pending; nothing from this card is run.`,
  };

  /** The recovery plan: record the owner's ruling, or confirm the governing
   * stop of an already-recorded one (#565). Both call the same guarded route
   * function an owner's own request calls, with the card's decision
   * attribution; the stop never records a ruling, and needs one to exist. */
  const recoveryPlan = (kind: 'recovery-owner-resolution' | 'recovery-owner-stop'): OwnerApprovalPlan => ({
    kind,
    cardKind: OWNER_APPROVAL_CARD_KIND[kind],
    card(record) {
      const subject = ownerApprovalSubject(record, 'recovery');
      const what = `${subject.fences.contract.kind} ${subject.id}`;
      const stop = kind === 'recovery-owner-stop';
      return {
        title: `${stop ? 'Confirm the governing stop for' : 'Record the owner ruling for'} ${what}?`,
        detail: [
          `Gru proposes ${stop ? 'confirming the governing stop of' : 'recording the owner ruling for'} ${what} (approval ${record.id}).`,
          `Reason: ${record.reason}`,
          'The Approve is bound to what Gru read:',
          ...contractLines(subject.fences.contract),
          ...(stop ? [`resolution_fingerprint: ${subject.expectedResolutionFingerprint ?? ''}`] : []),
          stop
            ? 'The stop is settled only if all of them still hold and the ruling is still the recorded one.'
            : 'The ruling is recorded only if all of them still hold.',
          stop
            ? 'Nothing is unparked, Acked, released or executed.'
            : 'Recording the ruling executes nothing: no stop is released, nothing is unparked, no notification is Acked, no work runs.',
        ].join('\n'),
        decision: {
          question: stop
            ? `Confirm the governing stop of ${what} and settle it?`
            : `Record your ruling on the recovery of ${what}?`,
          context: `${what} on job ${subject.fences.jobId} (epoch ${String(subject.fences.contract.expectedEpoch)}, head ${subject.fences.contract.expectedHead.slice(0, 12)}). Reason: ${excerpt(record.reason)}`,
          recommendation: null,
          reservedClass: 'destructive',
          whyNotDelegable: stop ? WHY_NOT_DELEGABLE_STOP : WHY_NOT_DELEGABLE_RESOLUTION,
          options: options(stop ? APPROVE_CONSEQUENCE_STOP : APPROVE_CONSEQUENCE_RESOLUTION,
            stop ? DENY_CONSEQUENCE_STOP : DENY_CONSEQUENCE_RESOLUTION),
          discussion: false,
        },
      };
    },
    isLive(record) {
      return this.revalidate(record) === null;
    },
    revalidate(record) {
      const subject = ownerApprovalSubject(record, 'recovery');
      const fence = ledger.ownerApprovalRecoveryFence({ kind: subject.fences.contract.kind, subjectId: subject.id,
        resolutionId: subject.resolutionId, reason: record.reason, contract: subject.fences.contract });
      if (fence.jobId === null) {
        return { code: 'stale-fence', blockers: [`subject: expected ${subject.fences.contract.kind} subject ${subject.id}, actual none`] };
      }
      if (fence.refusal !== null) return { code: 'stale-fence', blockers: [fence.refusal] };
      if (subject.expectedResolutionFingerprint !== null && fence.resolutionFingerprint !== subject.expectedResolutionFingerprint) {
        return { code: 'stale-fence', blockers: [`resolution_fingerprint: expected ${subject.expectedResolutionFingerprint}, actual ${fence.resolutionFingerprint ?? 'none'}`] };
      }
      if (subject.expectedResolutionFingerprint === null && fence.resolutionEventSeq !== null) {
        return { code: 'recorded-elsewhere', blockers: [`ruling ${subject.resolutionId} is already recorded (event seq ${String(fence.resolutionEventSeq)})`] };
      }
      return null;
    },
    recorded(record) {
      if (record.executingSeq === null) return null;
      const subject = ownerApprovalSubject(record, 'recovery');
      const fence = ledger.ownerApprovalRecoveryFence({ kind: subject.fences.contract.kind, subjectId: subject.id,
        resolutionId: subject.resolutionId, reason: record.reason, contract: subject.fences.contract });
      const seq = (kind === 'recovery-owner-stop' ? fence.confirmationEventSeq : fence.resolutionEventSeq) ?? null;
      return seq === null || seq <= record.executingSeq ? null : { seq, own: true };
    },
    elsewhere(record, seq) {
      return { code: 'recorded-elsewhere', blockers: [`recovery subject ${record.subject.id} already carries this owner action (event seq ${String(seq)})`] };
    },
    execute(record) {
      const subject = ownerApprovalSubject(record, 'recovery');
      const outcome = recoveryOwnerActionFromRoute({
        ledger,
        worktrees: deps.worktrees,
        attribution: { by: 'owner', confirmIntent: true },
        action: { ...subject.fences.contract, kind: subject.fences.contract.kind, subjectId: subject.id,
          resolutionId: subject.resolutionId, reason: `${ownerApprovalReasonPrefix(record.id)}${record.reason}` },
        expectedResolutionFingerprint: subject.expectedResolutionFingerprint,
      });
      return outcome.event.seq;
    },
    succeededDetail: (seq) => (kind === 'recovery-owner-stop'
      ? `Governing stop confirmed and settled (event seq ${String(seq)}). Parking, other holds and cards are unchanged.`
      : `Ruling recorded (event seq ${String(seq)}). Nothing was released, unparked, Acked or executed.`),
    noLongerLive: (record) => `Recovery subject ${record.subject.id} no longer matches what Gru proposed; nothing from this card is run.`,
  });

  const recoveryResolutionPlan = recoveryPlan('recovery-owner-resolution');
  const recoveryStopPlan = recoveryPlan('recovery-owner-stop');

  const planOf = (record: OwnerApprovalRecord): OwnerApprovalPlan => {
    switch (record.kind) {
      case 'directive-abandon': return directivePlan;
      case 'rebrief-abandon': return rebriefPlan;
      case 'recovery-owner-resolution': return recoveryResolutionPlan;
      case 'recovery-owner-stop': return recoveryStopPlan;
    }
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

  const finishSucceeded = (record: OwnerApprovalRecord, auditEventSeq: number): void => {
    const detail = planOf(record).succeededDetail(auditEventSeq);
    ledger.endOwnerApproval(record.id, { state: 'succeeded', auditEventSeq, detail });
    step('terminal-written');
    closeCard(record, detail);
  };

  const settleFromAudit = (record: OwnerApprovalRecord, audit: { readonly seq: number; readonly own: boolean }): void => {
    if (audit.own) finishSucceeded(record, audit.seq);
    else finishRefused(record, planOf(record).elsewhere(record, audit.seq));
  };

  /** Carry out the action the record is bound to. The ledger refuses what it
   * must (a live producer, retirement available, a stale recovery contract);
   * anything else it throws is an attempt that failed. */
  const execute = (record: OwnerApprovalRecord): void => {
    const plan = planOf(record);
    let seq: number;
    try {
      seq = plan.execute(record);
    } catch (error) {
      if (error instanceof DirectiveRetirementError) {
        finishRefused(record, { code: error.code, blockers: [...error.blockers] });
        return;
      }
      // A refused fence is the record's own named ending, never a wasted
      // attempt: the contract was already read again before this call, and a
      // race would be a stale fence, not an execution error.
      if (error instanceof DirectiveCheckpointError) {
        finishRefused(record, { code: 'stale-fence', blockers: [error.message] });
        return;
      }
      if (error instanceof RecordNotFound) {
        finishRefused(record, { code: 'stale-fence', blockers: [errorMessage(error)] });
        return;
      }
      const message = errorMessage(error);
      const after = ledger.recordOwnerApprovalAttemptFailure(record.id, message);
      log('warn', 'owner approval: the action failed', { id: record.id, kind: record.kind, attempts: after.attempts, ended: after.state !== 'executing', error: message });
      if (after.state === 'refused') {
        step('terminal-written');
        closeCard(record, refusalDetail(after.refusal ?? { code: 'execution-error', blockers: [message] }));
      }
      return;
    }
    step('action-recorded');
    settleFromAudit(record, { seq, own: true });
  };

  /** Take an `approved` or `executing` record as far as it goes (never twice). */
  const carryOut = (id: string): void => {
    let record = requireRecord(id);
    const plan = planOf(record);
    if (record.state === 'approved') {
      const refusal = plan.revalidate(record);
      if (refusal !== null) { finishRefused(record, refusal); return; }
      record = ledger.beginOwnerApprovalExecution(id, 'fences hold; carrying the action out');
      step('executing-written');
    } else if (record.state === 'executing') {
      const audit = plan.recorded(record);
      if (audit !== null) { settleFromAudit(record, audit); return; }
      const refusal = plan.revalidate(record);
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
    const plan = planOf(record);
    const card = plan.card(record);
    deps.notifications.post({
      id: record.notificationId,
      kind: plan.cardKind,
      routing: 'needs-owner',
      severity: 'error',
      title: card.title,
      detail: card.detail,
      decision: card.decision,
    });
  };

  /** Post the record's card, or end the record `refused` (`card-post-failed`)
   * when that fails for good: a record whose card can never exist must not
   * stay `proposed`, or every new proposal for its subject is answered
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

  /** The subject ended some other way before the owner answered: the card is
   * withdrawn, then the record. A decision that landed first is carried out. */
  const withdraw = (record: OwnerApprovalRecord, card: NotificationRecord): void => {
    const detail = planOf(record).noLongerLive(record);
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
    const plan = planOf(record);
    if (card === null) {
      if (!plan.isLive(record)) {
        ledger.endOwnerApproval(record.id, { state: 'withdrawn', detail: plan.noLongerLive(record) });
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
    if (!plan.isLive(record)) withdraw(record, card);
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
          : record.state === 'succeeded' ? planOf(record).succeededDetail(record.auditEventSeq ?? 0)
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

  /** The answer a refused proposal gives: one wire code per outcome, named for
   * the target the caller named. */
  const refusalFor = (proposal: OwnerApprovalProposalInput,
    result: { readonly kind: 'unknown_subject' } | { readonly kind: 'not_live'; readonly state: string; readonly detail: string | null },
  ): { readonly status: number; readonly body: Record<string, unknown> } => {
    const target = proposal.kind === 'directive-abandon' ? `directive request "${proposal.requestId}"`
      : proposal.kind === 'rebrief-abandon' ? `re-brief marker "${proposal.markerId}"`
        : `${proposal.contract.kind} recovery subject "${proposal.subjectId}"`;
    switch (result.kind) {
      case 'unknown_subject':
        return { status: 404, body: { error: proposal.kind === 'directive-abandon' ? 'owner_approval_unknown_request'
          : proposal.kind === 'rebrief-abandon' ? 'owner_approval_unknown_marker' : 'owner_approval_unknown_subject',
        detail: `${target} not found` } };
      case 'not_live':
        return { status: 409, body: { error: 'owner_approval_not_live',
          detail: result.detail ?? `${target} is ${result.state} — nothing this approval would carry out still holds` } };
    }
  };

  const propose = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let proposal: OwnerApprovalProposalInput;
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
      case 'unknown_subject':
      case 'not_live': {
        const refusal = refusalFor(proposal, result);
        json(res, refusal.status, refusal.body);
        return;
      }
      case 'pending':
        json(res, 409, { error: 'owner_approval_pending', detail: `subject "${result.approval.subject.id}" already has owner approval ${result.approval.id} (${result.approval.state})`, approval_id: result.approval.id });
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
