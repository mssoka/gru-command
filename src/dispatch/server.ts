import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { ChildWorkerRecord, JobDeliverable, LedgerApi } from '../ledger/api.js';
import { JOB_DISPLAY_NAME_MAX_LENGTH, AmbiguousDirectiveError, DirectiveConflictError, LaneWriterConflictError, PhaseHandoffConflictError, PipelineConflictError, RecordNotFound } from '../ledger/api.js';
import { DIRECTIVE_RETIREMENT_CONTEXT, DirectiveRetirementError, directiveAdmissionClass, type DirectiveRequestRecord, type DirectiveRetirementIntent, type LiveDirectiveState } from '../ledger/directives.js';
import { isJobTerminal, isObligationState } from '../ledger/states.js';
import { isReportDispositionOutcome, parseCompletionHandoffIntent, type CompletionHandoffIntent } from '../ledger/obligations.js';
import { parsePipelinePrerequisites, type PipelinePrerequisite } from '../ledger/pipeline.js';
import type { PipelineService } from './pipeline.js';
import type { IntakeService } from '../intake/service.js';
import { IntakeError } from '../intake/types.js';
import { IntakePartialFailure, type IntakeApprovalService } from '../intake/approval.js';
import type { IntakeSlicingService } from '../intake/slicing.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { DispatchService } from './service.js';
import { pendingPublicationAttempt } from './publication-evidence.js';
import { ReviewInProgressError, ReviewSupersessionUnconfirmedError, type WaveRunner } from './perkins.js';
import { isAmendmentEffect, type AmendmentEffect } from '../review-inputs/amendments.js';
import type { DirectiveRegistry } from './fix-directive.js';
import { recoverInterruptedDirectiveFromRoute, recoverInterruptedRebriefFromRoute, resolveRetirementLane, retireInterruptedDirectiveFromRoute } from './directive-recovery.js';
import { executeAcceptedDirective, type DirectiveProgressDeps } from './directive-progress.js';
import { surfaceRecoveryOwnerTransfer } from './recovery-owner.js';
import { resolveGitCommit } from './perkins-review/artifacts.js';
import type { RecoveryOwnerActionInput } from '../ledger/recovery-owner.js';
import { DirectiveCheckpointError } from '../runtime/directive-checkpoint.js';
import type { LessonsReferencePort } from '../lessons/types.js';
import { BranchBusyError } from './branch-idle.js';
import { deliveredTargetSha, type SilasOpsDigest } from './silas-driver.js';
import { isVerdictRungRule, parseSilasRouteRuleId, strictOptStrField } from './silas-rules.js';
import type { WorktreePort } from './worktree-port.js';
import {
  REVIEW_INPUT_LENSES,
  ReviewSourceUnavailableError,
  type ReviewRequiredInput,
  type ReviewSourcePackage,
} from './review-source.js';
import type { PacingGate, RetrySettlement } from '../runtime/pacing.js';
import { childRefusalStatus, type ChildWorkerService } from './child-workers.js';
import { REVIEW_EVIDENCE_MAX_FILES, type ReviewEvidenceRequest } from '../review-inputs/evidence.js';
import { BlindInputRefusal, parseBlindInputPackage } from './blind-input.js';
import type { PropertyCampaignService } from './property-campaigns.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Dispatch HTTP surface (EPICS E8 story 2): the authenticated, thin API
 * the Gru chat surface (and the phone) drives the heist flow through.
 * Reads live on the board's own /api surface — this hook owns only the
 * flow endpoints under /api/dispatch.
 */

/** Silas's ops surface (E8 follow-through; owner ruling 2026-09-21): the
 * narrow, authenticated endpoints the hosted silas session drives through
 * its bash tool. No new powers beyond the silas authority (dispatch, track,
 * close, escalate) — every action lands in the ledger as a silas.* event. */
export interface SilasOpsSurface {
  readonly registry: DirectiveRegistry;
  readonly worktrees: WorktreePort;
  readonly notifications: NotificationCenter;
  /** Provider-recovery claim surface (the guarded continuation
   * transition): absent = the claim endpoint answers 503 (sensor not
   * wired). */
  readonly providerRecovery?: {
    claim(waitId: string, by: string): Promise<unknown>;
  };
  /** The supervisor's guarded owned re-arm for the silas slot. */
  readonly slotReArm?: { ownedProviderReArm(agentId: string, waitId: string): boolean };
  /** Read-only digest computation for GET /api/silas/digest (issue #217):
   * returns the digest a wake prompt's delta points at. Absent = the
   * endpoint answers 503. */
  readonly digest?: () => Promise<SilasOpsDigest>;
}

export interface DispatchServerOptions {
  readonly config: GruCommandConfig;
  readonly dispatch: DispatchService;
  readonly wave: WaveRunner;
  /** The record of record — silas.* attribution events land here. */
  readonly ledger: LedgerApi;
  /** Provider pacing: worker (minion turn) admission gate for directive
   * deliveries and re-briefs. Absent = off. */
  readonly workerGate?: PacingGate;
  /** Supervisor's fresh queued/backoff producer ownership for retirement. */
  readonly pendingProducerBlockers: DirectiveProgressDeps['pendingProducerBlockers'];
  /** Provider pacing: bounded settlement of an automatic rate-limit retry
   * covering a just-delivered directive/re-brief turn (supervisor-backed
   * in production). The route records delivered only for 'none'/'recovered'. */
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  /** Issue #161: tracked child workers. Absent = /api/dispatch/child*
   * answers 503 (the child-worker subsystem is not hosted). */
  readonly childWorkers?: ChildWorkerService;
  /** Absent = /api/silas/* answers 503 (silas ops not hosted). */
  readonly silasOps?: SilasOpsSurface;
  /** Durable pipeline queue surface (approved j-239/j-1064); absent =
   * /api/pipeline/* answers 503 (queue not hosted in this build). */
  readonly pipeline?: PipelineService;
  /** Preview remains read-only; approval is a separate explicit boundary. */
  readonly intake?: IntakeService;
  readonly intakeApproval?: IntakeApprovalService;
  /** Intake slicing (#429): commission a planning minion, accept its breakdown. */
  readonly intakeSlicing?: IntakeSlicingService;
  /** Owner pairing-token actions only; never exposed as reviewer tools. */
  readonly propertyCampaigns?: PropertyCampaignService;
  /** Book of Lessons injection for directives/re-briefs (pointers only). */
  readonly lessons?: LessonsReferencePort;
  /** Observe the actual continued physical session through the shared
   * read-only blind-coverage port; absent = no observation. */
  readonly observeBlindTurn?: (jobId: string, sessionFile: string | null) => void;
  readonly log?: Log;
}

export interface DispatchServer {
  /** First-mounted hook: claims /api/dispatch*, passes everything else. */
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  dispose(): void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function strField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optStrField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A present-but-malformed optional field is a 400, never a silent drop:
 * safety-relevant fields (an owner hold) must never degrade into their
 * absent default (Perkins r1 blocker 2). */
function optStrFieldStrict(body: Record<string, unknown>, field: string): string | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string when present`);
  }
  return value.trim() === '' ? undefined : value;
}

/** The six write-boundary expectations of a retirement body. A live row
 * needs all of them (a 400 names the missing ones). A row retired before
 * they existed (its recorded authority epoch is null) replays with none, or
 * all null. Generation, plan revision and obligation state are null together
 * when no recovery obligation exists. Hashes are lowercased like every other
 * digest. */
function retirementContextFields(body: Record<string, unknown>, row: DirectiveRequestRecord):
  Partial<Pick<DirectiveRetirementIntent, keyof typeof DIRECTIVE_RETIREMENT_CONTEXT>> {
  const fields = Object.values(DIRECTIVE_RETIREMENT_CONTEXT);
  if (row.state === 'retired' && row.retireExpectedAuthorityEpoch === null &&
      fields.every((field) => body[field] === undefined || body[field] === null)) return {};
  const missing = fields.filter((field) => body[field] === undefined);
  if (missing.length > 0) throw new Error(`directive retirement requires ${missing.join(', ')} from fresh readback`);
  const count = (field: string, nullable: boolean): number | null => {
    const value = body[field];
    if (nullable && value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative safe integer${nullable ? ' or null' : ''}`);
    }
    return value;
  };
  const generation = count('expected_generation', true);
  const planRevision = count('expected_plan_revision', true);
  const obligationState = body['expected_obligation_state'];
  if (obligationState !== null && (typeof obligationState !== 'string' || !isObligationState(obligationState))) {
    throw new Error('expected_obligation_state must be an obligation state or null');
  }
  if ((generation === null) !== (planRevision === null) || (generation === null) !== (obligationState === null)) {
    throw new Error('expected_generation, expected_plan_revision and expected_obligation_state are null together (no recovery obligation) or all set');
  }
  const contract = body['expected_contract_sha256'];
  const contractSha256 = typeof contract === 'string' ? contract.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/u.test(contractSha256)) throw new Error('expected_contract_sha256 must be a SHA-256 hex digest');
  return { expectedGeneration: generation, expectedPlanRevision: planRevision, expectedObligationState: obligationState,
    expectedAuthorityEpoch: count('expected_authority_epoch', false) as number, expectedWorkRevision: count('expected_work_revision', false) as number,
    expectedContractSha256: contractSha256 };
}

/** The recorded retirement facts every retired-row readback carries, so a
 * lost-response retry rebuilds the exact intent from any of them. */
function retirementReadback(record: DirectiveRequestRecord): Record<string, unknown> {
  return {
    admission_class: directiveAdmissionClass(record),
    retired_at: record.retiredAt,
    retired_by: record.retiredBy,
    retire_reason: record.retireReason,
    retire_expected_state: record.retireExpectedState,
    retire_expected_head: record.retireExpectedHead,
    retire_expected_generation: record.retireExpectedGeneration,
    retire_expected_plan_revision: record.retireExpectedPlanRevision,
    retire_expected_obligation_state: record.retireExpectedObligationState,
    retire_expected_authority_epoch: record.retireExpectedAuthorityEpoch,
    retire_expected_work_revision: record.retireExpectedWorkRevision,
    retire_expected_contract_sha256: record.retireExpectedContractSha256,
    hold_released_by: record.holdReleasedBy,
    hold_released_at: record.holdReleasedAt,
  };
}

/** A typed retirement refusal or missing request as its HTTP
 * answer; false for any other error. An incomplete context is a malformed
 * body (400); every other refusal is a 409 naming its live ownership. */
function directiveControlRefusal(res: ServerResponse, error: unknown): boolean {
  if (error instanceof DirectiveRetirementError) {
    if (error.code === 'incomplete_context') json(res, 400, { error: 'bad_request', detail: error.message });
    else json(res, 409, { error: error.code, detail: error.message, ...(error.blockers.length > 0 ? { blockers: error.blockers } : {}) });
    return true;
  }
  if (error instanceof RecordNotFound) {
    json(res, 404, { error: 'not_found', detail: error.message });
    return true;
  }
  return false;
}

/** Issue #161: the wire shape of one tracked child worker (snake_case,
 * like the rest of the dispatch API). */
function childView(record: ChildWorkerRecord): Record<string, unknown> {
  return {
    id: record.id,
    agent_id: record.agentId,
    parent_agent_id: record.parentAgentId,
    job_id: record.jobId,
    purpose: record.purpose,
    authority: record.authority,
    task: record.task,
    label: record.label,
    idempotency_key: record.idempotencyKey,
    state: record.state,
    worktree_id: record.worktreeId,
    branch: record.branch,
    session_file: record.sessionFile,
    result_state: record.resultState,
    result_summary: record.resultSummary,
    result_ref: record.resultRef,
    created_at: record.createdAt,
    admitted_at: record.admittedAt,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    updated_at: record.updatedAt,
  };
}

function optBoolField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function optStrArray(body: Record<string, unknown>, field: string): readonly string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value as readonly string[];
}

/** Arm-time private evidence references: service-managed upload identities
 * with an honest purpose and a consent reference. Shape/bounds are checked
 * here; identity/media/bytes are validated at freeze (where a failure can
 * never leave partial evidence). */
function optEvidenceField(body: Record<string, unknown>): readonly ReviewEvidenceRequest[] | undefined {
  const value = body['evidence'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('evidence must be a non-empty array when supplied');
  }
  if (value.length > REVIEW_EVIDENCE_MAX_FILES) {
    throw new Error(`evidence carries more than ${REVIEW_EVIDENCE_MAX_FILES} attachments`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`evidence[${index}] must be an object`);
    }
    const object = entry as Record<string, unknown>;
    const allowed = new Set(['upload_path', 'purpose', 'consent_ref', 'captured_at']);
    for (const key of Object.keys(object)) {
      if (!allowed.has(key)) throw new Error(`evidence[${index}] has unknown field "${key}"`);
    }
    const uploadPath = object['upload_path'];
    const purpose = object['purpose'];
    const consentRef = object['consent_ref'];
    const capturedAt = object['captured_at'];
    if (typeof uploadPath !== 'string' || uploadPath.trim() === '') {
      throw new Error(`evidence[${index}].upload_path must be a non-empty string`);
    }
    if (typeof purpose !== 'string' || purpose.trim() === '') {
      throw new Error(`evidence[${index}].purpose must be a non-empty string`);
    }
    if (typeof consentRef !== 'string' || consentRef.trim() === '') {
      throw new Error(`evidence[${index}].consent_ref must be a non-empty string`);
    }
    if (capturedAt !== undefined && (typeof capturedAt !== 'string' || capturedAt.trim() === '')) {
      throw new Error(`evidence[${index}].captured_at must be a non-empty string when supplied`);
    }
    return {
      uploadPath,
      purpose,
      consentRef,
      ...(typeof capturedAt === 'string' ? { capturedAt } : {}),
    };
  });
}

/** Issue #317: `required_inputs` — [{path, lens}] content the review needs.
 * Only claims-needed lenses may declare inputs; a blind lens is refused here
 * so a missing spec can never become a reason to feed claims to it (#316). */
function optRequiredInputs(body: Record<string, unknown>): readonly ReviewRequiredInput[] | undefined {
  const value = body['required_inputs'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error('required_inputs must be a non-empty array when supplied');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`required_inputs[${index}] must be an object`);
    const { path, lens, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new Error(`required_inputs[${index}] has unknown field "${Object.keys(rest)[0]}"`);
    if (typeof path !== 'string' || path.trim() === '' || path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`required_inputs[${index}].path must be a non-empty repo-relative path`);
    }
    if (typeof lens !== 'string' || !(REVIEW_INPUT_LENSES as readonly string[]).includes(lens)) {
      throw new Error(`required_inputs[${index}].lens must be one of ${REVIEW_INPUT_LENSES.join('|')} (blind lenses never receive claims inputs)`);
    }
    return { path, lens: lens as ReviewRequiredInput['lens'] };
  });
}

/** Issue #317: `source_package` — {path, sha256} of a hash-pinned bundle. */
function optSourcePackage(body: Record<string, unknown>): ReviewSourcePackage | undefined {
  const value = body['source_package'];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('source_package must be an object');
  const { path, sha256, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) throw new Error(`source_package has unknown field "${Object.keys(rest)[0]}"`);
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('source_package.path must be an absolute path');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(sha256)) throw new Error('source_package.sha256 must be 64 hex characters');
  return { path, sha256 };
}

/** The optional explicit completion intent on phase-authorizing requests.
 * Absent = ordinary flow; malformed = fail loud (the handler answers 400
 * BEFORE any job/side effect runs). */
/** Validate the optional deliverable kind (E19): presence is checked
 * FIRST so a present null/number/blank fails loud — never silently
 * defaulting an implementation lane into a carve-out (or a review lane
 * into PR debt). */
function deliverableField(body: Record<string, unknown>): JobDeliverable | undefined {
  if (!Object.hasOwn(body, 'deliverable')) return undefined;
  const raw = body['deliverable'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`deliverable must be a non-empty string of pr|review|artifact|investigation (got ${JSON.stringify(raw)})`);
  }
  const value = raw.trim();
  if (value !== 'pr' && value !== 'review' && value !== 'artifact' && value !== 'investigation') {
    throw new Error(`deliverable must be one of pr|review|artifact|investigation (got "${value}")`);
  }
  return value;
}

/** The optional megaminion parent. Unlike the blank-means-absent idiom of
 * display_name, a PRESENT parent_job_id must name a job: a blank, null or
 * non-string value is a 400 — never a reviewer silently filed as an
 * unrelated top-level heist. */
function parentJobIdField(body: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(body, 'parent_job_id')) return undefined;
  const raw = body['parent_job_id'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`parent_job_id must be a non-empty job id when present (got ${JSON.stringify(raw)})`);
  }
  return raw.trim();
}

function completionHandoffField(body: Record<string, unknown>): CompletionHandoffIntent | undefined {
  const value = body['completion_handoff'];
  if (value === undefined) return undefined;
  return parseCompletionHandoffIntent(value);
}

/** Pipeline prerequisites arrive as a JSON array of `{id, milestone}`;
 * validated by the SAME codec the ledger persists (fail loud on any
 * typo'd milestone rather than silently treating it as unmet). */
function optPrerequisitesField(body: Record<string, unknown>): readonly PipelinePrerequisite[] | undefined {
  const value = body['prerequisites'];
  if (value === undefined) return undefined;
  try {
    return parsePipelinePrerequisites(JSON.stringify(value));
  } catch (error) {
    throw new Error(`prerequisites: ${String(error instanceof Error ? error.message : error)}`);
  }
}

export function createDispatchServer(options: DispatchServerOptions): DispatchServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.config.auth.token);
  const configured = tokenConfigured(options.config.auth.token);
  const inFlight = new Set<Promise<unknown>>();
  const directiveControllers = new Set<AbortController>();

  function bearerToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header.trim()) : null;
    return match === null ? null : match[1] ?? null;
  }

  /**
   * The pairing token is the ONLY HTTP authority for the child-worker
   * routes. Issue #161's parent-facing surface is GC-mediated instead: a
   * parent session gets the `request_child_worker` / `list_child_workers`
   * / `cancel_child_worker` tools bound to its identity by closure, so no
   * bearer secret is ever written into (or readable from) session space.
   */
  function authed(req: IncomingMessage, res: ServerResponse): boolean {
    if (!configured) {
      json(res, 503, { error: 'not_configured', detail: 'no pairing token configured' });
      return false;
    }
    const token = bearerToken(req);
    if (token === null || !tokenMatches(token, tokenHash)) {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    return true;
  }

  function readBody(req: IncomingMessage, destroyOnLimit = true): Promise<Record<string, unknown>> {
    return new Promise((resolveBody, rejectBody) => {
      let seen = 0;
      const chunks: Buffer[] = [];
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        seen += chunk.length;
        if (seen > 512 * 1024) {
          rejected = true;
          chunks.length = 0;
          rejectBody(new Error('request body exceeds 512 KiB'));
          if (destroyOnLimit) req.destroy();
          else req.pause();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (rejected) return;
        if (chunks.length === 0) {
          resolveBody({});
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            rejectBody(new Error('request body must be a JSON object'));
            return;
          }
          resolveBody(parsed as Record<string, unknown>);
        } catch (error) {
          rejectBody(new Error(`request body is not valid JSON: ${String(error)}`));
        }
      });
      req.on('error', (error) => {
        if (!rejected) rejectBody(error);
      });
    });
  }

  function track(promise: Promise<unknown>): void {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise)).catch(() => {});
  }

  /** Validate the optional attribution field: only 'silas' records silas.*
   * ledger events; any other non-empty value is accepted and inert. */
  function byField(body: Record<string, unknown>): string | undefined {
    return optStrField(body, 'by');
  }

  /** The silas ops surface, or null with a 503 already written — the
   * endpoints are hosted only when silas is enabled in config. */
  function silasOpsOr503(res: ServerResponse): SilasOpsSurface | null {
    if (options.silasOps === undefined) {
      json(res, 503, { error: 'silas_ops_not_hosted', detail: 'silas ops are not hosted on this service' });
      return null;
    }
    return options.silasOps;
  }

  /** The pipeline surface, or null with a 503 already written. */
  function pipelineOr503(res: ServerResponse): PipelineService | null {
    if (options.pipeline === undefined) {
      json(res, 503, { error: 'pipeline_not_hosted', detail: 'the durable pipeline queue is not hosted on this service' });
      return null;
    }
    return options.pipeline;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const property = /^\/api\/jobs\/([^/]+)\/property-campaigns(?:\/([^/]+)(?:\/(execute|repair|retain))?)?$/u.exec(path);
    if (property !== null) {
      if (!authed(req, res)) return true;
      const service = options.propertyCampaigns;
      if (service === undefined) { json(res, 503, { error: 'property_campaigns_not_hosted' }); return true; }
      const jobId = decodeURIComponent(property[1]!);
      const id = property[2] === undefined ? undefined : decodeURIComponent(property[2]);
      const action = property[3] as 'execute' | 'repair' | 'retain' | undefined;
      if (req.method === 'GET' && id !== undefined && action === undefined) { json(res, 200, service.read(jobId, id)); return true; }
      if (req.method === 'POST' && id === undefined) { json(res, 201, service.propose(jobId, await readBody(req))); return true; }
      if (req.method === 'POST' && id !== undefined && action !== undefined) { json(res, 200, await service.decide(jobId, id, action, await readBody(req))); return true; }
      return false;
    }
    if (path === '/api/intake' || path.startsWith('/api/intake/')) {
      if (!authed(req, res)) return true;
      const intake = options.intake;
      if (intake === undefined) {
        json(res, 503, { error: 'intake_not_hosted', detail: 'native intake preview is not hosted on this service' });
        return true;
      }
      try {
        if (req.method === 'POST' && ['/api/intake/preview', '/api/intake/revision', '/api/intake/review', '/api/intake/reject', '/api/intake/approve', '/api/intake/slice', '/api/intake/slice/result'].includes(path)) {
          let body: Record<string, unknown>;
          try { body = await readBody(req, false); } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new IntakeError('intake_invalid_request', message, message.includes('exceeds 512 KiB') ? 413 : 400);
          }
          if (path === '/api/intake/preview' || path === '/api/intake/revision') {
            json(res, 200, await (path.endsWith('/preview') ? intake.preview(body) : intake.revise(body)) as unknown as Record<string, unknown>);
          } else if (path === '/api/intake/slice' || path === '/api/intake/slice/result') {
            const slicing = options.intakeSlicing;
            if (slicing === undefined) throw new IntakeError('intake_slicing_not_hosted', 'Intake slicing is not hosted on this service', 503);
            if (path === '/api/intake/slice') {
              const commission = await slicing.commission(body);
              json(res, commission.dispatched ? 202 : 200, commission as unknown as Record<string, unknown>);
            } else json(res, 200, await slicing.submit(body) as unknown as Record<string, unknown>);
          } else {
            const approval = options.intakeApproval;
            if (approval === undefined) throw new IntakeError('intake_approval_not_hosted', 'Explicit intake approval is not hosted on this service', 503);
            const result = path.endsWith('/approve') ? approval.approve(body) : path.endsWith('/reject') ? approval.reject(body) : approval.review(body);
            json(res, 200, result as unknown as Record<string, unknown>);
          }
          return true;
        }
        const reviewRead = /^\/api\/intake\/([^/]+)\/review$/u.exec(path);
        if (req.method === 'GET' && reviewRead !== null) {
          if ((req.url?.length ?? 0) > 8192) throw new IntakeError('intake_invalid_request', 'intake URL exceeds 8 KiB');
          const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
          for (const key of params.keys()) if (!['repoPath', 'token'].includes(key) || params.getAll(key).length !== 1) throw new IntakeError('intake_invalid_request', 'unsupported or duplicated review query parameter');
          if (!params.get('repoPath')) throw new IntakeError('intake_invalid_request', 'missing repoPath');
          if (options.intakeApproval === undefined) throw new IntakeError('intake_approval_not_hosted', 'Explicit intake approval is not hosted on this service', 503);
          json(res, 200, options.intakeApproval.read(params.get('repoPath')!, decodeURIComponent(reviewRead[1]!), params.get('token') ?? undefined) as unknown as Record<string, unknown>);
          return true;
        }
        const read = /^\/api\/intake\/([^/]+)\/requests\/([^/]+)$/u.exec(path);
        const diff = /^\/api\/intake\/([^/]+)\/diff$/u.exec(path);
        if (req.method === 'GET' && (read !== null || diff !== null)) {
          if ((req.url?.length ?? 0) > 8192) throw new IntakeError('intake_invalid_request', 'intake URL exceeds 8 KiB');
          const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
          const keys = read !== null ? ['repoPath'] : ['repoPath', 'from', 'to'];
          for (const key of params.keys()) {
            if (!keys.includes(key) || params.getAll(key).length !== 1) throw new IntakeError('intake_invalid_request', 'unsupported or duplicated intake query parameter');
          }
          for (const key of keys) if (!params.get(key)) throw new IntakeError('intake_invalid_request', `missing intake query parameter ${key}`);
          const result = read !== null
            ? intake.read(params.get('repoPath')!, decodeURIComponent(read[1]!), decodeURIComponent(read[2]!))
            : intake.diff(params.get('repoPath')!, decodeURIComponent(diff![1]!), params.get('from')!, params.get('to')!);
          json(res, 200, result as unknown as Record<string, unknown>);
          return true;
        }
        json(res, 404, { error: 'intake_not_found', detail: 'unsupported intake route' });
      } catch (error) {
        if (error instanceof IntakeError) {
          if (error.status === 413) {
            res.setHeader('connection', 'close');
            const socket = req.socket;
            // Flush the named response, then terminate even an unfinished
            // chunked sender. Merely pausing/draining leaves it alive forever.
            res.once('finish', () => socket.destroySoon());
          }
          json(res, error.status, { error: error.code, detail: error.message, ...(error instanceof IntakePartialFailure ? { readback: error.readback } : {}) });
        } else if (error instanceof URIError) json(res, 400, { error: 'intake_invalid_request', detail: 'malformed percent escape in intake identity' });
        else json(res, 500, { error: 'intake_failed', detail: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (req.method === 'POST' && path === '/api/dispatch') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      // Optional-field idiom (target_ref and friends): an absent, null, or
      // blank display_name means "no authored name" — the job falls back
      // to its title. A real name is bounded here AND at the ledger write.
      const displayName = optStrField(body, 'display_name')?.trim();
      if (displayName !== undefined && displayName.length > JOB_DISPLAY_NAME_MAX_LENGTH) {
        throw new Error(`display_name exceeds ${JOB_DISPLAY_NAME_MAX_LENGTH} characters`);
      }
      const deliverable = deliverableField(body);
      const completionHandoff = completionHandoffField(body);
      // Issue #220 report-job closure: the commissioner (the disposition
      // debtor — explicit field, else the request's `by`, else `gru`) and
      // the review target (PR url + reviewed head). A present-but-malformed
      // field is a 400, never a silent drop (same idiom as display_name).
      const commissioner = optStrFieldStrict(body, 'commissioner');
      const by = optStrField(body, 'by');
      const targetRef = optStrFieldStrict(body, 'target_ref');
      const targetSha = optStrFieldStrict(body, 'target_sha');
      // Job family: a minion commissioning a specialist (megaminion) names
      // its own job id so the board nests the child under that heist. The
      // ledger refuses an unknown, cross-repo, self, or grandchild parent.
      const parentJobId = parentJobIdField(body);
      const targetBase = optStrFieldStrict(body, 'target_base');
      const requiredInputs = optRequiredInputs(body);
      const sourcePackage = optSourcePackage(body);
      // Issue #316: blind-review input isolation fields. Present-but-
      // malformed is a named refusal, never a silent drop.
      const reviewRole = optStrFieldStrict(body, 'review_role');
      const parentContractSha256 = optStrFieldStrict(body, 'parent_contract_sha256');
      let outcome: Awaited<ReturnType<DispatchService['dispatch']>>;
      try {
        const inputPackage = Object.hasOwn(body, 'input_package') ? parseBlindInputPackage(body['input_package']) : undefined;
        outcome = await options.dispatch.dispatch({
          jobId: strField(body, 'job_id'),
          repoPath: strField(body, 'repo_path'),
          title: strField(body, 'title'),
          ...(displayName !== undefined ? { displayName } : {}),
          ...(deliverable !== undefined ? { deliverable } : {}),
          ...(commissioner !== undefined ? { commissioner } : by !== undefined ? { commissioner: by } : {}),
          ...(targetRef !== undefined ? { targetRef } : {}),
          ...(targetSha !== undefined ? { targetSha } : {}),
          ...(targetBase !== undefined ? { targetBase } : {}),
          ...(requiredInputs !== undefined ? { requiredInputs } : {}),
          ...(sourcePackage !== undefined ? { sourcePackage } : {}),
          ...(parentJobId !== undefined ? { parentJobId } : {}),
          briefing: strField(body, 'briefing'),
          ...(completionHandoff !== undefined ? { completionHandoff } : {}),
          ...(reviewRole !== undefined ? { reviewRole } : {}),
          ...(inputPackage !== undefined ? { inputPackage } : {}),
          ...(parentContractSha256 !== undefined ? { parentContractSha256 } : {}),
        });
      } catch (error) {
        // Issue #317: the selected source cannot provide the named review
        // inputs. No job, lane or reviewer exists; this is a refusal, not a
        // report, and grants no automatic retry.
        if (error instanceof ReviewSourceUnavailableError) {
          log('warn', 'review source preflight refused dispatch', { problems: error.problems });
          json(res, 422, {
            error: 'review_source_unavailable',
            detail: error.message,
            problems: error.problems,
            retry_authorized: false,
          });
          return true;
        }
        // Issue #316: named refusal BEFORE any reviewer spawned: the
        // correction path is part of the answer, and the violations never
        // carry private text.
        if (error instanceof BlindInputRefusal) {
          json(res, error.status, {
            error: error.code,
            detail: error.message,
            correction: error.correction,
            violations: error.violations,
            ...error.details,
          });
          return true;
        }
        throw error;
      }
      // The minion's turn runs in the background; the board carries the
      // lifecycle. Track it so dispose() never orphans a live lane.
      track(outcome.settled);
      json(res, 202, {
        job_id: outcome.job.id,
        status: outcome.job.status,
        worktree: outcome.worktree.path,
        branch: outcome.worktree.branch,
        agent_id: outcome.agentId,
      });
      return true;
    }
    if (req.method === 'POST' && path.startsWith('/api/jobs/') && path.endsWith('/disposition')) {
      if (!authed(req, res)) return true;
      // Issue #220: the commissioner settles a delivered report. The whole
      // action rides one ledger transaction (disposition event + typed
      // settlement + delivered → done), so a crash can never leave the
      // obligation settled with the lane still owing, or the reverse.
      const jobId = decodeURIComponent(path.slice('/api/jobs/'.length, -'/disposition'.length));
      if (jobId === '') {
        json(res, 400, { error: 'bad_request', detail: 'job id path segment is required' });
        return true;
      }
      const body = await readBody(req);
      const rawOutcome = body['outcome'];
      if (typeof rawOutcome !== 'string' || !isReportDispositionOutcome(rawOutcome)) {
        json(res, 400, {
          error: 'bad_request',
          detail: `outcome must be one of acted|dismissed|superseded (got ${JSON.stringify(rawOutcome ?? null)})`,
        });
        return true;
      }
      const note = optStrField(body, 'note');
      const directiveJobId = optStrField(body, 'directive_job_id');
      const by = optStrField(body, 'by');
      try {
        const settled = options.ledger.settleReportDisposition({
          jobId,
          outcome: rawOutcome,
          ...(note !== undefined ? { note } : {}),
          ...(directiveJobId !== undefined ? { directiveJobId } : {}),
          ...(by !== undefined ? { by } : {}),
        });
        json(res, 200, {
          job_id: settled.job.id,
          status: settled.job.status,
          obligation_id: settled.obligation.id,
          obligation_state: settled.obligation.state,
          outcome: rawOutcome,
        });
      } catch (error) {
        if (error instanceof RecordNotFound) {
          json(res, 404, { error: 'not_found', detail: String(error.message) });
          return true;
        }
        throw error;
      }
      return true;
    }
    if (req.method === 'POST' && path === '/api/dispatch/pr') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const by = byField(body);
      const jobId = strField(body, 'job_id');
      // Firing-rule provenance (issue #243): the delivered-pr-register rule
      // fires here when Silas registers the one PR the lane actually has.
      const prRuleId = parseSilasRouteRuleId('pr', strictOptStrField(body, 'rule_id')) ?? undefined;
      if (prRuleId !== undefined && by !== 'silas') {
        throw new Error(`rule_id "${prRuleId}" fires only on a silas request`);
      }
      const job = options.dispatch.recordPr(jobId, strField(body, 'url'));
      if (by === 'silas') {
        options.ledger.appendCustomEvent({
          kind: 'silas.pr-registered',
          jobId,
          payload: {
            url: job.prUrl,
            ...(prRuleId === undefined ? {} : { rule_id: prRuleId }),
          },
        });
      }
      json(res, 200, job);
      return true;
    }
    // Issue #161: tracked child workers. The admission surface carries the
    // parent agent id, job id, purpose, bounded task authority and a
    // caller-supplied idempotency key; GC validates parent linkage before
    // admission and answers named refusal preconditions. A replay with the
    // same key returns the existing child (never a second worker).
    if (req.method === 'POST' && path === '/api/dispatch/child') {
      if (!authed(req, res)) return true;
      const service = options.childWorkers;
      if (service === undefined) {
        json(res, 503, {
          error: 'child_workers_not_hosted',
          detail: 'the tracked child-worker subsystem is not wired on this service',
        });
        return true;
      }
      const body = await readBody(req);
      // Raw (non-coerced) values reach the service's validator so EVERY
      // refusal names the failed field/precondition — a missing field is
      // `invalid_request` with the field name, never a generic parse fault.
      const rawField = (field: string): string =>
        typeof body[field] === 'string' ? (body[field] as string) : '';
      try {
        const admission = service.request({
          parentAgentId: rawField('parent_agent_id'),
          jobId: rawField('job_id'),
          purpose: rawField('purpose'),
          authority: rawField('authority'),
          task: rawField('task'),
          idempotencyKey: rawField('idempotency_key'),
          ...(optStrField(body, 'label') !== undefined ? { label: optStrField(body, 'label') } : {}),
        });
        json(res, admission.idempotent ? 200 : 202, {
          child: childView(admission.record),
          idempotent: admission.idempotent,
        });
      } catch (error) {
        const refusal = childRefusalStatus(error);
        if (refusal === null) throw error;
        json(res, refusal.status, { error: refusal.code, detail: refusal.detail });
      }
      return true;
    }
    if (req.method === 'POST' && path === '/api/dispatch/review') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const by = byField(body);
      const force = optBoolField(body, 'force');
      const ruleField = strictOptStrField(body, 'rule_id');
      // The route validator answers `null` for an absent rule; the rest of
      // this handler keys on `undefined` (an absent field never mints a
      // `rule_id: null` on the deferral receipt).
      const ruleId = parseSilasRouteRuleId('review', ruleField) ?? undefined;
      const sourceRoundId = strictOptStrField(body, 'source_round_id');
      const requestedTargetRef = optStrField(body, 'target_ref');
      const evidenceRefs = optEvidenceField(body);
      if (ruleId !== undefined && by !== 'silas') {
        throw new Error(`rule_id "${ruleId}" fires only on a silas request`);
      }
      if (sourceRoundId !== undefined && ruleId === undefined) {
        throw new Error('source_round_id must be paired with a rule_id');
      }
      if (ruleId === 'clean-abort-service-restart' && sourceRoundId === undefined) {
        throw new Error('rule_id "clean-abort-service-restart" consumes a round — source_round_id is required');
      }
      if (ruleId === 'pr-review-trigger' && sourceRoundId !== undefined) {
        throw new Error('rule_id "pr-review-trigger" is a first/re-review request — it carries no source round');
      }
      const jobId = strField(body, 'job_id');
      // The clean-abort re-arm freezes EXACTLY the proved delivered head:
      // an explicit target_ref must name that sha, and its absence binds it
      // (never a live PR head that may have moved since the delivery).
      let boundTargetRef = requestedTargetRef;
      if (sourceRoundId !== undefined) {
        if (force === true) throw new Error('mechanical clean-abort re-arm cannot force past the branch-idle guard');
        const round = options.ledger.getRound(sourceRoundId);
        const proof = options.ledger.latestRoundEvent(sourceRoundId, 'round.perkins-incomplete');
        const reason = typeof proof?.payload === 'object' && proof.payload !== null
          ? (proof.payload as { reason?: unknown }).reason : null;
        const newestRound = options.ledger.listRounds(jobId).at(-1);
        const delivered = options.ledger.latestCandidateDelivery(jobId);
        const sha = delivered === null ? null : deliveredTargetSha(delivered);
        if (round?.jobId !== jobId || round.status !== 'aborted' ||
            newestRound?.id !== sourceRoundId || sha === null || sha !== round.targetRef ||
            (reason !== 'service_restart' && reason !== 'service_restart_missing_review_lane')) {
          throw new Error('source round is not the latest clean service-restart abort on the unchanged delivered head');
        }
        // Owner rule 3: a round superseded by an approved change (even one a
        // restart interrupted mid-supersession) reviewed an obsolete
        // candidate — it is never re-armed.
        if (options.ledger.latestRoundEvent(sourceRoundId, 'round.superseded') !== null) {
          throw new Error(`source round ${sourceRoundId} was superseded by an approved change — it is never re-armed`);
        }
        // An irreversible provider write is not undone by a restart: while a
        // durable publication attempt has no conclusive outcome, re-arming a
        // new publication on the same head could duplicate an unrecorded
        // formal review. Reconcile it first (recovery does; the guard reports
        // only evidence, never a fabricated result).
        const pendingPublication = pendingPublicationAttempt(options.ledger, sourceRoundId);
        if (pendingPublication !== null) {
          throw new Error(`clean-abort re-arm refused: ${pendingPublication.detail}`);
        }
        if (requestedTargetRef !== undefined && requestedTargetRef !== sha) {
          throw new Error('clean-abort re-arm target_ref must be the proved delivered head sha');
        }
        boundTargetRef = sha;
        const latest = options.ledger.latestJobEvent(jobId, 'silas.review-triggered');
        if (latest !== null && typeof latest.payload === 'object' && latest.payload !== null &&
            (latest.payload as { source_round_id?: unknown }).source_round_id === sourceRoundId) {
          throw new Error(`clean-abort round ${sourceRoundId} was already re-armed`);
        }
      }
      const rawClaimedFixed = body['claimed_fixed_priors'];
      let claimedFixedPriors: number[] | undefined;
      if (rawClaimedFixed !== undefined) {
        if (!Array.isArray(rawClaimedFixed) || rawClaimedFixed.length > 500 ||
            rawClaimedFixed.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)) {
          throw new Error('claimed_fixed_priors must be an array of at most 500 non-negative integer prior indexes');
        }
        claimedFixedPriors = rawClaimedFixed as number[];
      }
      const input = {
        jobId,
        ...(boundTargetRef !== undefined ? { targetRef: boundTargetRef } : {}),
        // The freeze boundary re-proves this delivered head; a newer
        // delivery during the awaited setup refuses the stale re-arm.
        ...(sourceRoundId !== undefined && boundTargetRef !== undefined ? { boundDeliveredSha: boundTargetRef } : {}),
        ...(optStrArray(body, 'lenses') !== undefined ? { lenses: optStrArray(body, 'lenses') } : {}),
        ...(optBoolField(body, 'no_spec') !== undefined ? { noSpec: optBoolField(body, 'no_spec') } : {}),
        ...(force !== undefined ? { force } : {}),
        ...(evidenceRefs !== undefined ? { evidence: evidenceRefs } : {}),
        ...(claimedFixedPriors !== undefined ? { claimedFixedPriors } : {}),
        ...(by === 'minion' ? { handoff: true } : {}),
      };
      // The fallback gate can append a terminal phase BEFORE this handler
      // records its request receipt (a synchronous diff failure inside
      // beginFallbackGate reaches `blocked` before returning). Baseline the
      // job's fallback trail so a failure that belongs to THIS request is
      // recognized by its post-baseline phase, never by event order against
      // a receipt that does not exist yet.
      const fallbackBaselineSeq = options.ledger.latestJobEvent(jobId, 'job.fallback-review')?.seq ?? 0;
      let outcome: Awaited<ReturnType<WaveRunner['requestReview']>>;
      try {
        outcome = await options.wave.requestReview(input);
      } catch (error) {
        if (error instanceof BranchBusyError) {
          const refusal = error.refusal();
          if (by === 'silas') {
            // The deferred-arm note: Silas retries on the next sweep once
            // the busy lane delivers; the ledger keeps the deferral trail.
            // gate=freeze-r1 is the standing gate's firing receipt (issue
            // #117, g21): the fence refused this arm, so the deferral
            // PROVES the gate fired — alongside the deferred arm's own
            // trigger provenance when it carried one.
            options.ledger.appendCustomEvent({
              kind: 'silas.review-deferred',
              jobId: input.jobId,
              payload: {
                target_branch: error.targetBranch,
                phase: error.phase,
                gate: 'freeze-r1',
                ...(ruleId !== undefined ? { rule_id: ruleId, source_round_id: sourceRoundId } : {}),
                blockers: refusal.blockers,
                hint: refusal.hint,
              },
            });
          }
          json(res, 409, refusal);
          return true;
        }
        throw error;
      }
      if (by === 'silas') {
        // The consuming source-round receipt is ONLY an armed Perkins round.
        // Fallback/queued routes answer no round, so the clean-abort re-arm
        // stays eligible (g24); their trigger still retires the generic
        // review-overdue row because the route owns the lane. A fallback
        // that never engaged or already terminated this request engages
        // nothing at all: record a non-consuming deferral instead.
        const armed = outcome.route === 'perkins';
        const latestFallback = options.ledger.latestJobEvent(input.jobId, 'job.fallback-review');
        const fallbackPhase = latestFallback !== null && typeof latestFallback.payload === 'object' && latestFallback.payload !== null
          ? (latestFallback.payload as { phase?: unknown }).phase : undefined;
        const fallbackFailedNow = latestFallback !== null && latestFallback.seq > fallbackBaselineSeq &&
          (fallbackPhase === 'unavailable' || fallbackPhase === 'blocked' || fallbackPhase === 'aborted');
        if (outcome.route === 'bmad-review-fallback' && (!outcome.skillInstalled || fallbackFailedNow)) {
          options.ledger.appendCustomEvent({
            kind: 'silas.review-deferred',
            jobId: input.jobId,
            payload: {
              reason: outcome.skillInstalled ? 'fallback_failed' : 'fallback_unavailable',
              ...(ruleId !== undefined ? { rule_id: ruleId, source_round_id: sourceRoundId } : {}),
              note: outcome.note,
            },
          });
        } else {
          options.ledger.appendCustomEvent({
            kind: 'silas.review-triggered',
            jobId: input.jobId,
            payload: {
              route: outcome.route,
              ...(armed && ruleId !== undefined ? { rule_id: ruleId, source_round_id: sourceRoundId } : {}),
              ...(outcome.route === 'perkins' ? { round_id: outcome.round.id } : {}),
              // Issue #243 F-H5: the frozen head the round actually armed on,
              // so #214 can match a predicted bound head to the real target.
              ...(outcome.route === 'perkins' ? { target_ref: outcome.round.targetRef } : {}),
            },
          });
        }
      }
      if (outcome.route === 'queued') {
        track(outcome.run);
        json(res, 202, { route: 'queued', job_id: outcome.jobId, request_seq: outcome.requestSeq,
          status: 'awaiting minion delivery before review admission' });
        return true;
      }
      if (outcome.route !== 'perkins') {
        // bmad-review fallback gate: findings, triage, and fix directives run
        // in the background; the response names the failed pre-flight legs.
        track(outcome.run);
        json(res, 202, {
          route: outcome.route,
          ...(ruleId !== undefined ? { rule_id: ruleId, source_round_id: sourceRoundId } : {}),
          clear_to_merge: outcome.clearToMerge,
          skill_installed: outcome.skillInstalled,
          failed_legs: outcome.failedLegs.map((leg) => ({ leg: leg.leg, detail: leg.detail, remediation: leg.remediation })),
          note: outcome.note,
        });
        return true;
      }
      track(outcome.run);
      json(res, 202, {
        route: 'perkins',
        round_id: outcome.round.id,
        ...(ruleId !== undefined ? { rule_id: ruleId, source_round_id: sourceRoundId } : {}),
        status: outcome.round.status,
        lenses: outcome.round.lenses.map((chip) => chip.lens),
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/pipeline/enqueue') {
      if (!authed(req, res)) return true;
      const pipeline = pipelineOr503(res);
      if (pipeline === null) return true;
      const body = await readBody(req);
      const priorityField = body['priority'];
      if (priorityField !== undefined && typeof priorityField !== 'number') {
        throw new Error('priority must be a number');
      }
      const scopes = optStrArray(body, 'exclusive_scopes');
      let receipt: ReturnType<PipelineService['enqueue']>;
      try {
        receipt = pipeline.enqueue({
          id: strField(body, 'id'),
          ...(optStrField(body, 'request_id') !== undefined ? { requestId: optStrField(body, 'request_id') } : {}),
          repoPath: strField(body, 'repo_path'),
          title: strField(body, 'title'),
          briefing: strField(body, 'briefing'),
          ...(priorityField !== undefined ? { priority: priorityField as number } : {}),
          ...(optPrerequisitesField(body) !== undefined ? { prerequisites: optPrerequisitesField(body) } : {}),
          ...(scopes !== undefined ? { exclusiveScopes: scopes } : {}),
          ...(optStrFieldStrict(body, 'hold_reason') !== undefined ? { holdReason: optStrFieldStrict(body, 'hold_reason') } : {}),
          by: byField(body) ?? null,
        });
      } catch (error) {
        if (error instanceof PipelineConflictError) {
          json(res, 409, { error: 'conflict', detail: error.message });
          return true;
        }
        throw error;
      }
      json(res, receipt.duplicate ? 200 : 201, receipt);
      return true;
    }
    if (req.method === 'GET' && path === '/api/pipeline') {
      if (!authed(req, res)) return true;
      const pipeline = pipelineOr503(res);
      if (pipeline === null) return true;
      json(res, 200, pipeline.view());
      return true;
    }
    const pipelineEntryMatch = /^\/api\/pipeline\/entries\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && pipelineEntryMatch !== null) {
      if (!authed(req, res)) return true;
      const pipeline = pipelineOr503(res);
      if (pipeline === null) return true;
      const id = decodeURIComponent(pipelineEntryMatch[1] ?? '');
      const record = pipeline.entry(id);
      if (record === null) {
        json(res, 404, { error: 'not_found', detail: `no pipeline entry "${id}"` });
        return true;
      }
      const live = pipeline.view().entries.find((row) => row.id === id) ?? null;
      json(res, 200, {
        entry: record,
        live_state: live?.state ?? record.state,
        live_reason: live?.reason ?? (record.state === 'failed' ? record.failureReason : null),
      });
      return true;
    }
    const pipelineHoldMatch = /^\/api\/pipeline\/entries\/([^/]+)\/(hold|clear-hold|cancel)$/.exec(path);
    if (req.method === 'POST' && pipelineHoldMatch !== null) {
      if (!authed(req, res)) return true;
      const pipeline = pipelineOr503(res);
      if (pipeline === null) return true;
      const id = decodeURIComponent(pipelineHoldMatch[1] ?? '');
      const action = pipelineHoldMatch[2];
      const body = await readBody(req);
      const by = byField(body) ?? null;
      if (action === 'hold') {
        json(res, 200, pipeline.hold(id, strField(body, 'reason'), { by }));
        return true;
      }
      if (action === 'clear-hold') {
        json(res, 200, pipeline.clearHold(id, optStrField(body, 'reason') ?? null, { by }));
        return true;
      }
      json(res, 200, pipeline.cancel(id, strField(body, 'reason'), { by }));
      return true;
    }
    // Issue #161: the parent discovers its children (and their durable
    // results) without correlating external ids: by job, by parent agent,
    // or by one child id.
    const childMatch = /^\/api\/dispatch\/children\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && childMatch !== null) {
      const record = options.ledger.getChildWorker(decodeURIComponent(childMatch[1] ?? ''));
      if (record === null) {
        json(res, 404, { error: 'child_not_found', detail: 'no such tracked child worker' });
        return true;
      }
      if (!authed(req, res)) return true;
      json(res, 200, { child: childView(record) });
      return true;
    }
    const childCancelMatch = /^\/api\/dispatch\/children\/([^/]+)\/cancel$/.exec(path);
    if (req.method === 'POST' && childCancelMatch !== null) {
      if (!configured) {
        json(res, 503, { error: 'not_configured', detail: 'no pairing token configured' });
        return true;
      }
      const service = options.childWorkers;
      if (service === undefined) {
        json(res, 503, {
          error: 'child_workers_not_hosted',
          detail: 'the tracked child-worker subsystem is not wired on this service',
        });
        return true;
      }
      if (!authed(req, res)) return true;
      const childId = decodeURIComponent(childCancelMatch[1] ?? '');
      const existing = options.ledger.getChildWorker(childId);
      if (existing === null) {
        json(res, 404, { error: 'child_not_found', detail: 'no such tracked child worker' });
        return true;
      }
      const body = await readBody(req);
      const reason = optStrField(body, 'reason') ?? 'cancelled by the owner';
      try {
        const record = await service.cancel(childId, reason);
        json(res, 200, { child: childView(record) });
      } catch (error) {
        const refusal = childRefusalStatus(error);
        if (refusal === null) throw error;
        json(res, refusal.status, { error: refusal.code, detail: refusal.detail });
      }
      return true;
    }
    const jobChildrenMatch = /^\/api\/dispatch\/jobs\/([^/]+)\/children$/.exec(path);
    if (req.method === 'GET' && jobChildrenMatch !== null) {
      // The job-wide list is the OPERATOR view (a parent uses its own
      // /agents/:id/children scope).
      if (!authed(req, res)) return true;
      const jobId = decodeURIComponent(jobChildrenMatch[1] ?? '');
      if (options.ledger.getJob(jobId) === null) {
        json(res, 404, { error: 'job_not_found', detail: `job "${jobId}" not found` });
        return true;
      }
      json(res, 200, { children: options.ledger.listChildWorkers({ jobId }).map(childView) });
      return true;
    }
    const agentChildrenMatch = /^\/api\/dispatch\/agents\/([^/]+)\/children$/.exec(path);
    if (req.method === 'GET' && agentChildrenMatch !== null) {
      const parentAgentId = decodeURIComponent(agentChildrenMatch[1] ?? '');
      if (options.ledger.getAgent(parentAgentId) === null) {
        json(res, 404, { error: 'agent_not_found', detail: `agent "${parentAgentId}" not found` });
        return true;
      }
      if (!authed(req, res)) return true;
      json(res, 200, {
        children: options.ledger.listChildWorkers({ parentAgentId }).map(childView),
      });
      return true;
    }
    const worktreesMatch = /^\/api\/dispatch\/jobs\/([^/]+)\/worktrees$/.exec(path);
    if (req.method === 'GET' && worktreesMatch !== null) {
      if (!authed(req, res)) return true;
      const rows = options.dispatch.worktreesFor(decodeURIComponent(worktreesMatch[1] ?? ''));
      json(res, 200, { worktrees: rows });
      return true;
    }
    // Issue #316: blind-review validity. Derived from the admission and the
    // reviewer's observed access — settlement/disposition are not inputs.
    const blindCoverageMatch = /^\/api\/dispatch\/jobs\/([^/]+)\/blind-coverage$/.exec(path);
    if (req.method === 'GET' && blindCoverageMatch !== null) {
      if (!authed(req, res)) return true;
      const jobId = decodeURIComponent(blindCoverageMatch[1] ?? '');
      if (options.ledger.getJob(jobId) === null) {
        json(res, 404, { error: 'job_not_found', detail: `job "${jobId}" not found` });
        return true;
      }
      json(res, 200, options.dispatch.blindCoverage(jobId) as unknown as Record<string, unknown>);
      return true;
    }
    if (req.method === 'POST' && path === '/api/dispatch/blind-access') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const jobId = strField(body, 'job_id');
      const raw = body['tool_results'];
      if (!Array.isArray(raw) || raw.length === 0) {
        json(res, 400, { error: 'bad_request', detail: 'tool_results must be a non-empty array of {tool_name?, text}' });
        return true;
      }
      const results = raw.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null || typeof (entry as { text?: unknown }).text !== 'string') {
          throw new Error(`tool_results[${index}].text must be a string`);
        }
        const toolName = (entry as { tool_name?: unknown }).tool_name;
        return { index, toolName: typeof toolName === 'string' ? toolName : null, text: (entry as { text: string }).text };
      });
      if (options.ledger.getJob(jobId) === null) {
        json(res, 404, { error: 'job_not_found', detail: `job "${jobId}" not found` });
        return true;
      }
      json(res, 200, options.dispatch.observeBlindAccess(jobId, results) as unknown as Record<string, unknown>);
      return true;
    }
    // Canonical job amendments (owner ruling j-969): authenticated,
    // append-only, expected-contract-hash concurrency, audited provenance.
    // The bearer token is the service authority; approval provenance is
    // recorded but never inferred from body text or a caller-declared role.
    const contractMatch = /^\/api\/dispatch\/jobs\/([^/]+)\/contract$/.exec(path);
    if (req.method === 'GET' && contractMatch !== null) {
      if (!authed(req, res)) return true;
      const jobId = decodeURIComponent(contractMatch[1] ?? '');
      const job = options.ledger.getJob(jobId);
      if (job === null) {
        json(res, 404, { error: 'job_not_found', detail: `job "${jobId}" not found` });
        return true;
      }
      const contract = options.ledger.effectiveContract(jobId);
      const amendments = options.ledger.listJobAmendments(jobId);
      const revision = options.ledger.workRevisionState(jobId);
      json(res, 200, {
        job_id: jobId,
        version: contract?.version ?? 0,
        base_sha256: contract?.baseSha256 ?? null,
        contract_sha256: contract?.contractSha256 ?? null,
        effective_contract: contract?.text ?? null,
        // Owner rule 2: review waits until a delivery carries the required
        // revision (the highest material amendment version).
        work_revision: {
          required: revision.required,
          delivered: revision.delivered,
          pending: revision.required > revision.delivered,
        },
        amendments: amendments.map((amendment) => ({
          id: amendment.id,
          version: amendment.version,
          created_at: amendment.createdAt,
          body_sha256: amendment.bodySha256,
          supersedes: amendment.supersedes,
          approval: amendment.approval,
          effect: amendment.effect,
          previous_contract_sha256: amendment.previousContractSha256,
          contract_sha256: amendment.contractSha256,
        })),
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/dispatch/amendment') {
      if (!authed(req, res)) return true;
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (error) {
        // Authenticated but unreadable bodies are audited like every other
        // refusal (unauthenticated attempts never reach this audit).
        options.ledger.appendCustomEvent({
          kind: 'job.amendment-rejected',
          jobId: '<unparseable-body>',
          payload: {
            code: 'invalid',
            reason: `amendment body could not be read (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'})`,
          },
        });
        json(res, 400, { error: 'invalid_request', detail: 'amendment request body is malformed' });
        return true;
      }
      // Parse BEFORE any mutation: a malformed request is refused, never
      // half-applied. Approval provenance is REQUIRED (missing provenance is
      // an authorization failure, not a default), and every refusal at this
      // boundary is audited — including a null/array approval that would
      // otherwise throw before the audit.
      const rawApproval = body['approval'];
      const approvalRecord = typeof rawApproval === 'object' && rawApproval !== null && !Array.isArray(rawApproval)
        ? (rawApproval as Record<string, unknown>)
        : null;
      const approvalBy = approvalRecord === null ? undefined : optStrField(approvalRecord, 'by');
      const approvalReference = approvalRecord === null ? undefined : optStrField(approvalRecord, 'reference');
      const rawJobId = body['job_id'];
      const jobId = typeof rawJobId === 'string' && rawJobId.trim() !== '' ? rawJobId : '<invalid-or-missing-job>';
      if (approvalBy === undefined || approvalReference === undefined) {
        // An improperly authorized attempt is audited, never silently dropped.
        options.ledger.appendCustomEvent({
          kind: 'job.amendment-rejected',
          jobId,
          payload: { code: 'improper-authorization', reason: 'approval {by, reference} is required' },
        });
        json(res, 400, { error: 'improper_authorization', detail: 'approval {by, reference} is required' });
        return true;
      }
      let amendmentFields: {
        body: string;
        supersedes?: readonly string[];
        expectedContractSha256: string;
        idempotencyKey?: string;
        effect: AmendmentEffect;
      };
      try {
        const amendmentBody = strField(body, 'body');
        const supersedes = optStrArray(body, 'supersedes');
        const idempotencyKey = optStrField(body, 'idempotency_key');
        // Owner rule 1 (2026-10-08): the writer declares what the approved
        // change asks of the lane. Required — never defaulted.
        const effect = body['effect'];
        if (!isAmendmentEffect(effect)) {
          throw new Error(
            'effect is required: "material" (the approved change requires implementation — the candidate is outdated ' +
              'and any review of it is superseded) or "administrative" (a clarification, typo or bookkeeping update)',
          );
        }
        amendmentFields = {
          body: amendmentBody,
          ...(supersedes !== undefined ? { supersedes } : {}),
          expectedContractSha256: strField(body, 'expected_contract_sha256'),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          effect,
        };
      } catch (error) {
        // Malformed shapes are audited like every other refusal; the reply
        // stays generic instead of leaking internal error text.
        const reason = error instanceof Error ? error.message.slice(0, 300) : 'malformed amendment request';
        options.ledger.appendCustomEvent({
          kind: 'job.amendment-rejected',
          jobId,
          payload: { code: 'invalid', reason },
        });
        // The effect refusal is the caller's own contract, safe to echo.
        json(res, 400, {
          error: 'invalid_request',
          detail: reason.startsWith('effect is required') ? reason : 'amendment request is malformed',
        });
        return true;
      }
      const result = options.ledger.addJobAmendment({
        jobId,
        ...amendmentFields,
        approval: { by: approvalBy, reference: approvalReference },
      });
      if (result.status === 'accepted') {
        // Owner rule 3: an approved MATERIAL change makes the reviewed
        // candidate obsolete — stop spending review on it now, before any
        // continuation is sent. The writer's gate re-proves the stop.
        const revision = options.ledger.workRevisionState(jobId);
        let supersession: 'none' | 'started' = 'none';
        if (!result.idempotent && result.amendment.effect === 'material') {
          // The pass also withdraws a queued review request for the obsolete
          // candidate; `started` reports whether a review owned the lane.
          if (options.wave.activeReview(jobId) !== null) supersession = 'started';
          track(options.wave.supersedeReviews({
            jobId,
            reason: `material amendment #${result.amendment.version} accepted (${result.amendment.approval.reference.slice(0, 120)})`,
            by: result.amendment.approval.by,
          }).then(
            (outcome) => {
              log(outcome.confirmed ? 'info' : 'warn', 'review superseded by a material amendment', {
                job: jobId, rounds: outcome.roundIds.join(','), confirmed: outcome.confirmed, detail: outcome.detail,
              });
            },
            (error: unknown) => {
              log('error', 'review supersession after a material amendment failed', { job: jobId, error: String(error) });
            },
          ));
        }
        json(res, 200, {
          status: 'accepted',
          idempotent: result.idempotent,
          amendment: {
            id: result.amendment.id,
            version: result.amendment.version,
            created_at: result.amendment.createdAt,
            body_sha256: result.amendment.bodySha256,
            supersedes: result.amendment.supersedes,
            approval: result.amendment.approval,
            effect: result.amendment.effect,
            previous_contract_sha256: result.amendment.previousContractSha256,
            contract_sha256: result.amendment.contractSha256,
          },
          contract: {
            version: result.contract.version,
            base_sha256: result.contract.baseSha256,
            contract_sha256: result.contract.contractSha256,
          },
          work_revision: {
            required: revision.required,
            delivered: revision.delivered,
            pending: revision.required > revision.delivered,
          },
          review_supersession: supersession,
        });
        return true;
      }
      const status = result.code === 'job-not-found'
        ? 404
        : result.code === 'stale' || result.code === 'idempotency-conflict'
          ? 409
          : 400;
      json(res, status, {
        status: 'rejected',
        error: result.code,
        detail: result.reason,
        ...(result.currentContractSha256 !== undefined ? { current_contract_sha256: result.currentContractSha256 } : {}),
        ...(result.currentVersion !== undefined ? { current_version: result.currentVersion } : {}),
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/silas/directive') {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      const body = await readBody(req);
      const jobId = strField(body, 'job_id');
      const directive = strField(body, 'directive');
      const fingerprint = optStrField(body, 'blocker_fingerprint');
      // Firing-rule provenance (issue #117, g21): the named Silas rule the
      // digest row answered. Validated against the registry AND this
      // route's receipt contract; the receipt below carries it so the
      // chief's trackers can audit rule hits. Verdict-rung rules consume a
      // specific verdict round, so the round id is required there and must
      // belong to THIS job — a fabricated or foreign round is refused.
      const ruleField = strictOptStrField(body, 'rule_id');
      const ruleId = parseSilasRouteRuleId('directive', ruleField);
      const sourceRoundId = strictOptStrField(body, 'source_round_id');
      if (sourceRoundId !== undefined && ruleId === null) {
        throw new Error('source_round_id must be paired with a rule_id');
      }
      if (ruleId !== null && isVerdictRungRule(ruleId)) {
        if (sourceRoundId === undefined) {
          throw new Error(`rule_id "${ruleId}" consumes a verdict round — source_round_id is required`);
        }
        if (options.ledger.getRound(sourceRoundId)?.jobId !== jobId) {
          throw new Error(`source_round_id "${sourceRoundId}" is not a round of job "${jobId}"`);
        }
      }
      const requestIdField = optStrField(body, 'request_id');
      const completionHandoff = completionHandoffField(body);
      const job = options.ledger.getJob(jobId);
      if (job === null) throw new Error(`job "${jobId}" not found`);
      if (isJobTerminal(job.status)) {
        throw new Error(`job "${jobId}" is ${job.status} — terminal lanes take no directives`);
      }
      // Owner rules 3/5: a NEW writer request on a lane under review is
      // admitted only when an approved material change made the reviewed
      // candidate obsolete (the gate below supersedes the review before any
      // prompt); otherwise the branch stays frozen until the verdict. A
      // replay of an existing request id starts nothing and skips this.
      // Synchronous with the intent write below: no review can arm between.
      if (requestIdField === undefined || options.ledger.getDirective(requestIdField) === null) {
        try {
          options.wave.assertWriterAdmissible(jobId);
        } catch (error) {
          if (error instanceof ReviewInProgressError) {
            json(res, 409, { error: 'review_in_progress', detail: error.message, round_ids: error.roundIds });
            return true;
          }
          throw error;
        }
      }
      // Durable intent BEFORE any prompt/spawn side effect (the PR133
      // timeout window: the old flow awaited the whole model turn before
      // recording anything). A retry of the same request id replays to the
      // same row; any different request id while one is live fails CLOSED
      // with the live request named — never a second concurrent turn.
      let begun;
      try {
        begun = options.ledger.beginDirectiveIntent({
          jobId,
          directive,
          holder: 'silas-ops',
          sourceContext: { ...(ruleId === null ? {} : { ruleId }), ...(sourceRoundId === undefined ? {} : { sourceRoundId }) },
          ...(fingerprint !== undefined ? { blockerFingerprint: fingerprint } : {}),
          ...(requestIdField !== undefined ? { requestId: requestIdField } : {}),
          ...(completionHandoff !== undefined ? { handoff: completionHandoff } : {}),
        });
      } catch (error) {
        if (error instanceof AmbiguousDirectiveError) {
          json(res, 409, { error: 'ambiguous_repeat', detail: error.message });
          return true;
        }
        if (error instanceof DirectiveConflictError || error instanceof PhaseHandoffConflictError) {
          json(res, 409, { error: 'request_conflict', detail: error.message });
          return true;
        }
        if (error instanceof LaneWriterConflictError) {
          json(res, 409, { error: 'writer_conflict', detail: error.message });
          return true;
        }
        throw error;
      }
      const intent = begun.record;
      if (intent.state === 'settled' || intent.state === 'failed' || intent.state === 'retired') {
        // A consumed request id never re-runs (recovered capacity is not
        // permission): report the durable outcome; changed work needs a
        // NEW request id. A retired id is consumed exactly like settled/
        // failed — its control closure is not permission to replay it.
        json(res, 200, {
          request_id: intent.requestId,
          job_id: jobId,
          state: intent.state,
          replay: true,
          minion_id: intent.admissionMinion,
          fail_reason: intent.failReason,
          // A caller who only uses this replay path learns the same
          // retirement facts the GET readback exposes — the id is consumed
          // and why/when, never a success or no-effect claim.
          ...(intent.state === 'retired' ? retirementReadback(intent) : {}),
          note:
            intent.state === 'retired'
              ? 'this request id was retired after server-verified writer cessation — it never re-runs; submit changed work under a new request id'
              : 'this request id already reached a terminal state — submit changed work under a new request id',
        });
        return true;
      }
      if (!begun.created) {
        // A REPLAY of a live request (the PR133 timeout window): the same
        // durable request is already in flight — accepted again, and the
        // identical turn is never doubled. Readback carries the outcome.
        json(res, 202, {
          request_id: intent.requestId,
          job_id: jobId,
          state: intent.state,
          replay: true,
          note: 'this request is already live — no second turn was started; read back GET /api/silas/directives/{request_id}',
        });
        return true;
      }
      // The durable intent proves which request owns the lane; reserve its
      // in-process admission before the first async wait so an authenticated
      // bin cannot close the job before any minion row exists. A stale
      // historical intent after a crash is NOT permanent runtime ownership.
      const releaseAdmission = options.ledger.beginJobAdmission(jobId, `directive ${intent.requestId}`);
      // The async turn stays owned and tracked by THIS server instance
      // (the existing directiveControllers/inFlight coordinator — no
      // detached helper, no second chief). Late errors surface durably.
      const controller = new AbortController();
      directiveControllers.add(controller);
      const run = (async (): Promise<void> => {
        // Owner rule 3: writing starts only after every review that owns the
        // lane has been superseded AND proven stopped. An unproven stop
        // refuses this request with positive no-effect proof (no prompt was
        // ever handed to a worker); the gate already escalated to Gru.
        try {
          await options.wave.clearLaneForWriter({ jobId, writer: `directive ${intent.requestId}` });
        } catch (error) {
          if (!(error instanceof ReviewSupersessionUnconfirmedError)) throw error;
          const reason = `refused before any prompt: ${error.message}`;
          options.ledger.failDirective({ requestId: intent.requestId, reason });
          const phase = options.ledger.findPhaseHandoffByRequest({ jobId, requestId: intent.requestId });
          if (phase !== null && phase.state === 'awaiting') {
            options.ledger.closePhaseHandoff({ phaseId: phase.phaseId, reason: `directive request failed: ${reason}` });
          }
          directiveControllers.delete(controller);
          log('warn', 'silas directive refused: the superseded review could not be proven stopped', {
            job: jobId, request: intent.requestId, detail: error.detail,
          });
          return;
        }
        await executeAcceptedDirective({
          registry: ops.registry, ledger: options.ledger, worktrees: ops.worktrees,
          notifications: ops.notifications, pendingProducerBlockers: options.pendingProducerBlockers,
          signal: controller.signal,
          ...(options.workerGate !== undefined ? { workerGate: options.workerGate } : {}),
          ...(options.retrySettlement !== undefined ? { retrySettlement: options.retrySettlement } : {}),
          ...(options.observeBlindTurn !== undefined ? { observeBlindTurn: options.observeBlindTurn } : {}),
          ...(options.lessons !== undefined ? { lessons: options.lessons } : {}),
          ...(options.childWorkers !== undefined ? { parentTools: (agentId: string) => options.childWorkers!.parentTools(agentId) } : {}),
        }, intent.requestId);
      })().catch((error: unknown) => {
        log('error', 'silas directive bookkeeping failed after admission', {
          job: jobId,
          request: intent.requestId,
          error: String(error),
        });
        try {
          options.ledger.recordDirectiveReconcile({
            requestId: intent.requestId,
            note: `post-admission bookkeeping error: ${String(error)}`,
          });
        } catch {
          // The ledger itself failed — the event log already carries what
          // committed; boot reconciliation reads it.
        }
      }).finally(() => {
        directiveControllers.delete(controller);
        releaseAdmission();
      });
      track(run);
      // Accepted ≠ admitted: 202 reports the durable INTENT; actual native
      // admission and the terminal receipt land on the request's record
      // and are readable via GET /api/silas/directives/{request_id}.
      json(res, 202, {
        request_id: intent.requestId,
        job_id: jobId,
        state: 'dispatching',
        work_revision: intent.workRevision ?? 0,
        note: 'accepted — dispatching is not admission; read back GET /api/silas/directives/{request_id}',
      });
      return true;
    }
    const rebriefReadback = /^\/api\/silas\/rebriefs\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && rebriefReadback !== null) {
      if (!authed(req, res)) return true;
      const markerId = decodeURIComponent(rebriefReadback[1]!);
      const marker = options.ledger.listPendingRebriefs().find((row) => row.id === markerId);
      const decision = options.ledger.getRebriefRecoveryDecision(markerId);
      if (marker === undefined && decision === null) { json(res, 404, { error: 'not_found' }); return true; }
      json(res, 200, { marker_id: markerId, markers: marker === undefined ? [] : options.ledger.listPendingRebriefs({ jobId: marker.jobId }),
        recovery_decision: decision, recovery_owner: options.ledger.recoveryOwnerReadback('rebrief', markerId),
        recovery_decision_events: options.ledger.recoveryDecisionHistory('rebrief', markerId).map((history) => options.ledger.getEvent(history.eventSeq)),
        current_inspection_obligations: options.ledger.recoveryDecisionHistory('rebrief', markerId)
          .filter((history) => history.currentInspectionObligationId !== null).map((history) => options.ledger.getObligation(history.currentInspectionObligationId!)),
        current_action_obligation_lineages: options.ledger.rebriefCurrentActionObligationLineages(markerId),
        receipt_evidence: marker === undefined ? null : options.ledger.rebriefReceiptEvidence(markerId),
        receipt_evidence_sha256: marker === undefined ? null : options.ledger.rebriefReceiptEvidence(markerId).sha256,
        current_approved_authority: marker === undefined ? null : options.ledger.directiveCurrentAuthority(marker.jobId),
        recovery_subject_sha256: marker === undefined ? null : options.ledger.recoverySubject('rebrief', markerId).snapshotSha256,
        current_authority_epoch: marker === undefined ? null : options.ledger.directiveRecoveryEpoch(marker.jobId),
        recovery_obligation: marker === undefined ? null : options.ledger.recoveryObligation(marker.jobId, 'rebrief', markerId) });
      return true;
    }
    const ownerResolution = /^\/api\/silas\/(directives|rebriefs)\/([^/]+)\/owner-resolution(?:\/(confirm-stop))?$/.exec(path);
    if (req.method === 'POST' && ownerResolution !== null) {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      const body = await readBody(req);
      if (body['by'] !== 'owner' || body['confirm_intent'] !== true) {
        json(res, 400, { error: 'bad_request', detail: 'explicit owner attribution and confirm_intent=true are required; shared bearer attribution is not verified identity' });
        return true;
      }
      const number = (key: string): number => {
        const value = body[key];
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new DirectiveCheckpointError(`owner action requires ${key}`);
        return value;
      };
      try {
        const input: RecoveryOwnerActionInput = { kind: ownerResolution[1] === 'directives' ? 'directive' : 'rebrief',
          subjectId: decodeURIComponent(ownerResolution[2]!), resolutionId: strField(body, 'resolution_id'),
          transferEventSeq: number('expected_transfer_event_seq'), expectedTransferFingerprint: strField(body, 'expected_transfer_fingerprint'),
          expectedSubjectSha256: strField(body, 'expected_subject_sha256'), expectedTargetGeneration: number('expected_target_generation'),
          expectedTargetPlanRevision: number('expected_target_plan_revision'), expectedLineageSha256: strField(body, 'expected_lineage_sha256'),
          expectedEpoch: number('expected_epoch'), expectedHead: strField(body, 'expected_head'), expectedWorkRevision: number('expected_work_revision'),
          expectedContractSha256: strField(body, 'expected_contract_sha256'), reason: strField(body, 'reason') };
        // Consumed identity replay is ledger-only: a later HEAD/stop cannot
        // rewrite or re-execute the original explicit owner action.
        const priorPermission = options.ledger.recoveryOwnerResolution(input.kind, input.subjectId, input.resolutionId);
        const priorConfirmation = options.ledger.recoveryOwnerReadback(input.kind, input.subjectId).confirmation;
        const confirmationIdentity = (priorConfirmation?.payload as { resolution_id?: unknown } | undefined)?.resolution_id;
        const consumed = ownerResolution[3] === 'confirm-stop' ? confirmationIdentity === input.resolutionId : priorPermission !== null;
        if (!consumed) {
          const subject = options.ledger.recoverySubject(input.kind, input.subjectId);
          const lanes = ops.worktrees.listWorktrees({ jobId: subject.jobId }).filter((lane) => lane.kind === 'job' && lane.status !== 'swept');
          if (lanes.length !== 1 || resolveGitCommit(lanes[0]!.path, 'HEAD') !== input.expectedHead) throw new DirectiveCheckpointError('owner action original lane/HEAD is stale or unavailable');
        }
        const outcome = ownerResolution[3] === 'confirm-stop'
          ? options.ledger.confirmRecoveryOwnerStop(input, strField(body, 'expected_resolution_fingerprint'))
          : options.ledger.recordRecoveryOwnerResolution(input);
        json(res, 200, { event_seq: outcome.event.seq, idempotent: outcome.idempotent, receipt: outcome.event,
          note: 'recorded explicit owner action only — job parking, notification Ack, other holds and work execution are unchanged' });
      } catch (error) {
        if (!(error instanceof DirectiveCheckpointError || error instanceof DirectiveRetirementError)) throw error;
        json(res, 409, { error: 'owner_resolution_refused', detail: error.message });
      }
      return true;
    }
    const directiveRecovery = /^\/api\/silas\/(directives|rebriefs)\/([^/]+)\/recover$/.exec(path);
    if (req.method === 'POST' && directiveRecovery !== null) {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      const body = await readBody(req);
      const requestId = decodeURIComponent(directiveRecovery[2]!);
      const decision = body['decision'];
      const generation = body['expected_generation'];
      const epoch = body['expected_epoch'];
      if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0 ||
          typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0 ||
          typeof decision !== 'object' || decision === null || Array.isArray(decision)) {
        json(res, 400, { error: 'bad_request', detail: 'recover requires expected_generation, expected_epoch and a concrete decision' });
        return true;
      }
      const choice = decision as Record<string, unknown>;
      const direct = directiveRecovery[1] === 'directives';
      // `rebrief-successor` and `reconcile-admitted` (#470) judge native
      // directive debt only; `reconcile-completed` is legacy-marker only.
      const kinds = direct ? ['successor', 'rebrief-successor', 'owner-decision', 'reconcile-admitted'] : ['successor', 'owner-decision', 'reconcile-completed'];
      if (body['by'] !== 'gru' || typeof choice['kind'] !== 'string' || !kinds.includes(choice['kind'])) {
        json(res, 400, { error: 'bad_request', detail: `concrete recovery judgment must be attributed to Gru and be one of ${kinds.join(', ')}; generic Ops holds are not decisions` });
        return true;
      }
      // Executing judgments bind current approved authority; an owner
      // transfer or a reconciliation to a recorded admission starts no work.
      const authorityBound = choice['kind'] !== 'owner-decision' && choice['kind'] !== 'reconcile-admitted';
      const revision = body['expected_work_revision'];
      if (authorityBound && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 ||
          typeof body['expected_contract_sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(body['expected_contract_sha256']))) {
        json(res, 400, { error: 'bad_request', detail: 'successor requires current expected_work_revision and expected_contract_sha256' });
        return true;
      }
      try {
        const recoveryInput = { ledger: options.ledger, worktrees: ops.worktrees,
          pendingProducerBlockers: options.pendingProducerBlockers,
          ...(options.workerGate !== undefined ? { workerGate: options.workerGate } : {}),
          requestId, generation, expectedPayloadHash: strField(body, 'expected_payload_hash'),
          expectedHead: strField(body, 'expected_head'), expectedEpoch: epoch,
          ...(authorityBound ? { expectedWorkRevision: revision as number, expectedContractSha256: strField(body, 'expected_contract_sha256') } : {}), reason: strField(body, 'reason'),
        } as const;
        let outcome: ReturnType<typeof recoverInterruptedDirectiveFromRoute>;
        if (choice['kind'] === 'reconcile-completed') {
          outcome = recoverInterruptedRebriefFromRoute({ ...recoveryInput, markerId: requestId,
            decision: { kind: 'reconcile-completed', inspectionRequestId: strField(choice, 'inspection_request_id') },
            expectedReceiptEvidenceSha256: strField(body, 'expected_receipt_evidence_sha256') });
        } else {
          // A successor stops an active obsolete review first. Consumed
          // generations are ledger-only, even after the lane is gone: neither
          // an exact nor a conflicting replay may stop work.
          const clearObsoleteReview = async (jobId: string | undefined, consumed: boolean, writer: string,
            validate: (lane: { readonly id: string; readonly resolvedHead: string }) => string | null): Promise<void> => {
            if (consumed || jobId === undefined || options.wave.activeReview(jobId) === null) return;
            const lane = resolveRetirementLane(ops.worktrees, jobId);
            const cleared = validate({ id: lane.id, resolvedHead: resolveGitCommit(lane.path, 'HEAD') });
            if (cleared === null) return;
            try {
              options.wave.assertWriterAdmissible(cleared); // only approved obsolete candidates
              await options.wave.clearLaneForWriter({ jobId: cleared, writer });
            } catch (error) { throw new DirectiveCheckpointError(`obsolete review writer clearance remains unproven: ${String(error)}`); }
          };
          // Re-resolve/revalidate after the awaited positive stop. The
          // retirement/decision predicates are unchanged; clearance grants
          // neither cessation of any other producer nor fresh work permission.
          if (direct) {
            const nativeDecision = choice['kind'] === 'successor'
              ? { kind: 'successor' as const, requestId: strField(choice, 'request_id'), directive: strField(choice, 'directive') }
              : choice['kind'] === 'rebrief-successor'
                ? { kind: 'rebrief-successor' as const, requestId: strField(choice, 'request_id'), note: strField(choice, 'note') }
                : choice['kind'] === 'reconcile-admitted'
                  ? { kind: 'reconcile-admitted' as const, admittedRequestId: strField(choice, 'admitted_request_id') }
                  : { kind: 'owner-decision' as const, obligationId: strField(choice, 'obligation_id') };
            if (nativeDecision.kind === 'successor' || nativeDecision.kind === 'rebrief-successor') {
              await clearObsoleteReview(options.ledger.getDirective(requestId)?.jobId,
                options.ledger.recoveryDecisionHistory('directive', requestId).some((entry) => entry.generation === generation),
                `${nativeDecision.kind === 'successor' ? 'directive' : 'rebrief'} ${nativeDecision.requestId}`,
                (lane) => options.ledger.validateRecoverySuccessorBeforeWriterClearance({ ...recoveryInput, subjectKind: 'directive', decision: nativeDecision, lane }));
            }
            outcome = recoverInterruptedDirectiveFromRoute({ ...recoveryInput, decision: nativeDecision });
          } else {
            const markerDecision = choice['kind'] === 'successor'
              ? { kind: 'successor' as const, requestId: strField(choice, 'request_id'), directive: strField(choice, 'directive') }
              : { kind: 'owner-decision' as const, obligationId: strField(choice, 'obligation_id') };
            const receiptSha256 = strField(body, 'expected_receipt_evidence_sha256');
            if (markerDecision.kind === 'successor') {
              await clearObsoleteReview(options.ledger.listPendingRebriefs().find((entry) => entry.id === requestId)?.jobId,
                options.ledger.getRebriefRecoveryDecision(requestId, generation) !== null, `directive ${markerDecision.requestId}`,
                (lane) => options.ledger.validateRecoverySuccessorBeforeWriterClearance({ ...recoveryInput, subjectKind: 'rebrief', markerId: requestId,
                  expectedReceiptEvidenceSha256: receiptSha256, decision: markerDecision, lane }));
            }
            outcome = recoverInterruptedRebriefFromRoute({ ...recoveryInput, markerId: requestId, decision: markerDecision, expectedReceiptEvidenceSha256: receiptSha256 });
          }
        }
        if (choice['kind'] === 'owner-decision') surfaceRecoveryOwnerTransfer({ ledger: options.ledger, notifications: ops.notifications },
          directiveRecovery[1] === 'directives' ? 'directive' : 'rebrief', requestId);
        // Execution is owned by the same server and scheduled once only. A
        // rebrief successor clears the lane like any accepted rebrief.
        if (!outcome.idempotent && outcome.successor !== null) {
          const controller = new AbortController();
          directiveControllers.add(controller);
          const run = executeAcceptedDirective({ registry: ops.registry, ledger: options.ledger, worktrees: ops.worktrees,
            clearLaneForWriter: (input) => options.wave.clearLaneForWriter(input),
            notifications: ops.notifications, pendingProducerBlockers: options.pendingProducerBlockers, signal: controller.signal,
            ...(options.workerGate !== undefined ? { workerGate: options.workerGate } : {}),
            ...(options.retrySettlement !== undefined ? { retrySettlement: options.retrySettlement } : {}),
            ...(options.observeBlindTurn !== undefined ? { observeBlindTurn: options.observeBlindTurn } : {}),
            ...(options.lessons !== undefined ? { lessons: options.lessons } : {}),
            ...(options.childWorkers !== undefined ? { parentTools: (agentId: string) => options.childWorkers!.parentTools(agentId) } : {}),
          }, outcome.successor.requestId).finally(() => directiveControllers.delete(controller));
          track(run);
        }
        json(res, !outcome.idempotent && outcome.successor !== null ? 202 : 200,
          { request_id: requestId, idempotent: outcome.idempotent, successor_request_id: outcome.successor?.requestId ?? null });
      } catch (error) {
        if (!(error instanceof DirectiveCheckpointError || error instanceof DirectiveRetirementError)) throw error;
        json(res, 409, { error: 'recovery_refused', detail: error.message });
      }
      return true;
    }
    const directiveRetirement = /^\/api\/silas\/directives\/([^/]+)\/retire$/.exec(path);
    if (req.method === 'POST' && directiveRetirement !== null) {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      const requestId = decodeURIComponent(directiveRetirement[1] ?? '');
      const body = await readBody(req);
      const expectedJobId = strField(body, 'expected_job_id');
      const expectedStateRaw = strField(body, 'expected_state');
      if (expectedStateRaw !== 'dispatching' && expectedStateRaw !== 'admitted') {
        throw new Error('expected_state must be "dispatching" or "admitted"');
      }
      const expectedState = expectedStateRaw as LiveDirectiveState;
      // Git object ids and sha256 hex digests are lowercase; normalizing
      // before the fingerprint/compare keeps a valid uppercase spelling
      // from failing as a misdirecting `stale_head`/`request_mismatch`.
      const expectedPayloadHash = strField(body, 'expected_payload_hash').trim().toLowerCase();
      const expectedHead = strField(body, 'expected_head').trim().toLowerCase();
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(expectedHead)) {
        throw new Error('expected_head must be a full git object id (40 or 64 hex characters)');
      }
      const currentRow = options.ledger.getDirective(requestId);
      if (currentRow === null) {
        json(res, 404, { error: 'not_found', detail: `directive request "${requestId}" not found` });
        return true;
      }
      // A settled/failed row is refused by the ledger before any expectation
      // is read: its body context is not validated here.
      const context = currentRow.state === 'settled' || currentRow.state === 'failed' ? {} : retirementContextFields(body, currentRow);
      const reason = strField(body, 'reason');
      const by = strField(body, 'by');
      let outcome: ReturnType<typeof retireInterruptedDirectiveFromRoute>;
      try {
        outcome = retireInterruptedDirectiveFromRoute({
          ledger: options.ledger,
          worktrees: ops.worktrees,
          ...(options.workerGate !== undefined ? { workerGate: options.workerGate } : {}),
          pendingProducerBlockers: options.pendingProducerBlockers,
          requestId,
          expected: {
            jobId: expectedJobId,
            state: expectedState,
            payloadHash: expectedPayloadHash,
            head: expectedHead,
            context,
          },
          reason,
          by,
        });
      } catch (error) {
        if (directiveControlRefusal(res, error)) return true;
        throw error;
      }
      const record = outcome.record;
      json(res, 200, {
        request_id: record.requestId,
        job_id: record.jobId,
        state: record.state,
        idempotent: outcome.idempotent,
        admission_seq: record.admissionSeq,
        minion_id: record.admissionMinion,
        ...retirementReadback(record),
        phase_handoff_closed: outcome.phaseClosed,
        note:
          'control ownership closed after server-verified writer cessation — no delivery and no no-effect outcome is claimed; ' +
          'the work remains unfinished and lane continuation requires a fresh authorized request',
      });
      return true;
    }
    const directiveReadback = /^\/api\/silas\/directives\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && directiveReadback !== null) {
      if (!authed(req, res)) return true;
      const requestId = decodeURIComponent(directiveReadback[1] ?? '');
      const record = options.ledger.getDirective(requestId);
      if (record === null) {
        json(res, 404, { error: 'not_found', detail: `no directive request "${requestId}"` });
        return true;
      }
      json(res, 200, {
        request_id: record.requestId,
        job_id: record.jobId,
        state: record.state,
        payload_hash: record.payloadHash,
        accepted_at: record.createdAt,
        updated_at: record.updatedAt,
        admission_seq: record.admissionSeq,
        minion_id: record.admissionMinion,
        delivery_seq: record.deliverySeq,
        attempts: record.attempts,
        fail_reason: record.failReason,
        // The contract revision this request carried (owner rule 4); null
        // for a request accepted before work revisions existed.
        request_kind: record.requestKind,
        source_context: record.sourceContext,
        work_revision: record.workRevision,
        authority_epoch: record.authorityEpoch,
        current_authority_epoch: options.ledger.directiveRecoveryEpoch(record.jobId),
        current_approved_authority: options.ledger.directiveCurrentAuthority(record.jobId),
        contract_sha256: record.contractSha256,
        native_target: record.nativeTarget,
        native_binding: record.nativeBinding,
        recovery_checkpoint: record.recoveryCheckpoint,
        recovery_decision: record.recoveryDecision,
        recovery_owner: options.ledger.recoveryOwnerReadback('directive', requestId),
        recovery_subject_sha256: options.ledger.recoverySubject('directive', requestId).snapshotSha256,
        recovery_obligation: options.ledger.recoveryObligation(record.jobId, 'directive', record.requestId),
        ...(record.state === 'retired' ? retirementReadback(record) : {}),
        states: {
          dispatching:
            'accepted; a dispatch claim was taken before any side effect — native admission not yet recorded (or unknown after a crash)',
          admitted: 'a correlated silas.directive-sent event bound an actual awaited turn; terminal receipt pending',
          settled: 'the correlated job.delivered terminal receipt was recorded',
          failed: 'a durable positive no-effect failure was recorded; resubmit changed work under a new request id',
          retired:
            'control ownership closed after server-verified writer cessation; no delivery and no no-effect outcome is claimed, ' +
            'the work remains unfinished, and continuation requires a fresh authorized request',
        },
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/silas/rebrief') {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      const body = await readBody(req);
      const jobId = strField(body, 'job_id');
      const note = strField(body, 'note');
      // Firing-rule provenance (issue #117, g21): stored on the durable
      // request marker BEFORE any worker exists, so the silas.rebrief
      // receipt replays it even across a restart mid-turn. Route- and
      // round-validated like every silas rule intake.
      const ruleField = strictOptStrField(body, 'rule_id');
      const ruleId = parseSilasRouteRuleId('rebrief', ruleField);
      const sourceRoundId = strictOptStrField(body, 'source_round_id');
      if (sourceRoundId !== undefined && ruleId === null) {
        throw new Error('source_round_id must be paired with a rule_id');
      }
      if (ruleId !== null && isVerdictRungRule(ruleId)) {
        if (sourceRoundId === undefined) {
          throw new Error(`rule_id "${ruleId}" consumes a verdict round — source_round_id is required`);
        }
        if (options.ledger.getRound(sourceRoundId)?.jobId !== jobId) {
          throw new Error(`source_round_id "${sourceRoundId}" is not a round of job "${jobId}"`);
        }
      }
      const completionHandoff = completionHandoffField(body);
      const job = options.ledger.getJob(jobId);
      if (job === null) throw new Error(`job "${jobId}" not found`);
      if (isJobTerminal(job.status)) {
        throw new Error(`job "${jobId}" is ${job.status} — terminal lanes are never re-briefed`);
      }
      const requestId = strictOptStrField(body, 'request_id');
      if (requestId === undefined || options.ledger.getDirective(requestId) === null) {
        try { options.wave.assertWriterAdmissible(jobId); }
        catch (error) {
          if (!(error instanceof ReviewInProgressError)) throw error;
          json(res, 409, { error: 'review_in_progress', detail: error.message }); return true;
        }
      }
      let begun;
      try {
        begun = options.ledger.beginRebriefIntent({ jobId, note, holder: 'silas-ops',
          ...(requestId === undefined ? {} : { requestId }), ...(completionHandoff === undefined ? {} : { handoff: completionHandoff }),
          sourceContext: { ...(ruleId === null ? {} : { ruleId }), ...(sourceRoundId === undefined ? {} : { sourceRoundId }) } });
      } catch (error) {
        if (!(error instanceof LaneWriterConflictError || error instanceof AmbiguousDirectiveError || error instanceof DirectiveConflictError || error instanceof PhaseHandoffConflictError)) throw error;
        json(res, 409, { error: 'writer_conflict', detail: error.message }); return true;
      }
      const intent = begun.record;
      if (!begun.created) {
        json(res, intent.state === 'dispatching' || intent.state === 'admitted' ? 202 : 200,
          { request_id: intent.requestId, job_id: jobId, state: intent.state, replay: true });
        return true;
      }
      const release = options.ledger.beginJobAdmission(jobId, `rebrief ${intent.requestId}`);
      const controller = new AbortController();
      directiveControllers.add(controller);
      const run = (async () => {
        await executeAcceptedDirective({ registry: ops.registry, ledger: options.ledger, worktrees: ops.worktrees,
          clearLaneForWriter: (input) => options.wave.clearLaneForWriter(input),
          notifications: ops.notifications, pendingProducerBlockers: options.pendingProducerBlockers, signal: controller.signal,
          ...(options.workerGate === undefined ? {} : { workerGate: options.workerGate }),
          ...(options.retrySettlement === undefined ? {} : { retrySettlement: options.retrySettlement }),
          ...(options.observeBlindTurn === undefined ? {} : { observeBlindTurn: options.observeBlindTurn }),
          ...(options.lessons === undefined ? {} : { lessons: options.lessons }),
          ...(options.childWorkers === undefined ? {} : { parentTools: (agentId: string) => options.childWorkers!.parentTools(agentId) }),
        }, intent.requestId);
      })().catch((error: unknown) => {
        options.ledger.recordDirectiveReconcile({ requestId: intent.requestId, note: String(error) });
      }).finally(() => { release(); directiveControllers.delete(controller); });
      track(run);
      json(res, 202, { request_id: intent.requestId, job_id: jobId, state: intent.state, work_revision: intent.workRevision,
        note: 'accepted rebrief — exact native admission/completion readable via GET /api/silas/directives/{request_id}' });
      return true;
    }
    if (req.method === 'POST' && path === '/api/silas/escalate') {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      const body = await readBody(req);
      const title = strField(body, 'title');
      if (title.length > 500) throw new Error('title exceeds 500 characters');
      const detail = optStrField(body, 'detail');
      if (detail !== undefined && detail.length > 4000) throw new Error('detail exceeds 4000 characters');
      // Firing-rule provenance (issue #117, g21): the named rule whose
      // ladder rung this escalation is (verdict-rung-escalate). Route- and
      // round-validated like every silas rule intake.
      const ruleField = strictOptStrField(body, 'rule_id');
      const ruleId = parseSilasRouteRuleId('escalate', ruleField);
      const sourceRoundId = strictOptStrField(body, 'source_round_id');
      if (sourceRoundId !== undefined && ruleId === null) {
        throw new Error('source_round_id must be paired with a rule_id');
      }
      const jobId = optStrField(body, 'job_id');
      if (jobId !== undefined && options.ledger.getJob(jobId) === null) {
        throw new Error(`job "${jobId}" not found`);
      }
      if (ruleId !== null && isVerdictRungRule(ruleId)) {
        if (sourceRoundId === undefined || jobId === undefined) {
          throw new Error(`rule_id "${ruleId}" consumes a verdict round — source_round_id and job_id are required`);
        }
        if (options.ledger.getRound(sourceRoundId)?.jobId !== jobId) {
          throw new Error(`source_round_id "${sourceRoundId}" is not a round of job "${jobId}"`);
        }
      }
      // Bind the row to the lane's current worker (existing agentId
      // semantics) so a terminal lane's leftover escalation is classified
      // as a closed receipt; no bound worker → unbound and live
      // (unknown historical rows are never guessed; tracked-review A4).
      // Selection is listAgents order, as resolveEscalationAgent documents.
      const boundMinion =
        jobId !== undefined
          ? options.ledger
              .listAgents()
              .find(
                (agent) =>
                  agent.jobId === jobId && agent.role === 'minion' && agent.parentage !== 'child',
              )
          : undefined;
      const notification = ops.notifications.post({
        kind: 'silas.escalation',
        routing: 'action-required',
        severity: 'error',
        title,
        ...(detail !== undefined ? { detail } : {}),
        ...(boundMinion !== undefined ? { agentId: boundMinion.id } : {}),
      });
      options.ledger.appendCustomEvent({
        kind: 'silas.escalated',
        ...(jobId !== undefined ? { jobId } : {}),
        payload: {
          title,
          notification_id: notification.id,
          ...(ruleId !== null ? { rule_id: ruleId } : {}),
          ...(sourceRoundId !== undefined ? { source_round_id: sourceRoundId } : {}),
        },
      });
      json(res, 200, { notification_id: notification.id });
      return true;
    }
    if (req.method === 'GET' && path === '/api/silas/digest') {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      if (ops.digest === undefined) {
        json(res, 503, {
          error: 'silas_digest_not_hosted',
          detail: 'the silas digest computation is not wired on this service',
        });
        return true;
      }
      try {
        const digest = await ops.digest();
        json(res, 200, digest as unknown as Record<string, unknown>);
      } catch (error) {
        options.log?.('error', 'silas digest computation failed', { error: String(error).slice(0, 300) });
        json(res, 500, { error: 'digest_failed', detail: String(error).slice(0, 300) });
      }
      return true;
    }
    if (req.method === 'POST' && path === '/api/silas/provider-recovery/claim') {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      if (ops.providerRecovery === undefined) {
        json(res, 503, {
          error: 'provider_recovery_not_hosted',
          detail: 'the provider-recovery sensor is not wired on this service',
        });
        return true;
      }
      const body = await readBody(req);
      const waitId = strField(body, 'wait_id');
      const by = strField(body, 'by');
      if (by !== 'silas') {
        throw new Error('provider-recovery claims are recorded as silas actions; pass by: "silas"');
      }
      // Owner rules 3/5: a provider continuation is a lane writer too, on
      // the same gate as directives and re-briefs — a current review keeps
      // the branch frozen (409), an obsolete one (material correction
      // pending) is superseded and PROVEN stopped before the claim resumes.
      const waitJobId = options.ledger.getProviderWait(waitId)?.jobId ?? null;
      if (waitJobId !== null) {
        try {
          options.wave.assertWriterAdmissible(waitJobId);
          await options.wave.clearLaneForWriter({ jobId: waitJobId, writer: `provider continuation ${waitId}` });
        } catch (error) {
          if (error instanceof ReviewInProgressError) {
            json(res, 409, { error: 'review_in_progress', detail: error.message, round_ids: error.roundIds });
            return true;
          }
          if (error instanceof ReviewSupersessionUnconfirmedError) {
            json(res, 409, { error: 'review_supersession_unconfirmed', detail: error.message });
            return true;
          }
          throw error;
        }
        // Re-proved in the SAME tick as the claim's durable write (the claim
        // takes no await before `provider.recovery-claimed`, which fences
        // review): a review admitted while the gate awaited refuses here.
        const admittedMeanwhile = options.wave.activeReview(waitJobId);
        if (admittedMeanwhile !== null) {
          json(res, 409, {
            error: 'review_in_progress',
            detail: `job ${waitJobId} came under review while the writer gate waited — retry after the verdict`,
            round_ids: admittedMeanwhile.roundIds,
          });
          return true;
        }
      }
      const result = await ops.providerRecovery.claim(waitId, by);
      json(res, 200, result as Record<string, unknown>);
      return true;
    }
    return false;
  }

  return {
    requestHook(req, res, path): boolean {
      // The /api/jobs namespace belongs to the BOARD api except for the
      // report disposition endpoint this hook adds — claim only that exact
      // shape, or /api/jobs/{id}/status and friends would 404 here.
      const isDisposition = path.startsWith('/api/jobs/') && path.endsWith('/disposition');
      const isProperty = /^\/api\/jobs\/[^/]+\/property-campaigns(?:\/|$)/u.test(path);
      if (!isProperty && !path.startsWith('/api/dispatch') && !path.startsWith('/api/silas') && !path.startsWith('/api/pipeline') && path !== '/api/intake' && !path.startsWith('/api/intake/') && !isDisposition) {
        return false;
      }
      const startedAt = Date.now();
      handleApi(req, res, path)
        .then((handled) => {
          if (!handled && !res.headersSent) {
            json(res, 404, { error: 'not_found', path });
          }
        })
        .catch((error: unknown) => {
          const message = String(error instanceof Error ? error.message : error);
          log('error', 'dispatch api handler failed', { path, error: message });
          if (!res.headersSent) json(res, 400, { error: 'bad_request', detail: message });
        });
      res.on('close', () => {
        log('info', 'dispatch request', {
          method: req.method,
          path,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
        });
      });
      return true;
    },

    dispose(): void {
      // Abort any in-flight directive/re-brief turns so shutdown cannot
      // stall on a wedged minion session; tracked lanes settle on abort.
      for (const controller of directiveControllers) controller.abort();
      void options.propertyCampaigns?.dispose();
    },
  };
}
