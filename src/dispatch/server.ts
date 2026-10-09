import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { ChildWorkerRecord, JobDeliverable, LedgerApi } from '../ledger/api.js';
import { JOB_DISPLAY_NAME_MAX_LENGTH, AmbiguousDirectiveError, DirectiveConflictError, LaneWriterConflictError, PhaseHandoffConflictError, PipelineConflictError, RecordNotFound } from '../ledger/api.js';
import { DirectiveRetirementError, directiveAdmissionClass, type LiveDirectiveState } from '../ledger/directives.js';
import { isJobTerminal } from '../ledger/states.js';
import { isReportDispositionOutcome, parseCompletionHandoffIntent, type CompletionHandoffIntent } from '../ledger/obligations.js';
import { parsePipelinePrerequisites, type PipelinePrerequisite } from '../ledger/pipeline.js';
import type { PipelineService } from './pipeline.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { DispatchService } from './service.js';
import { ReviewInProgressError, ReviewSupersessionUnconfirmedError, type WaveRunner } from './perkins.js';
import { amendmentSupersessions, isAmendmentEffect, pendingMaterialAmendments, type AmendmentEffect } from '../review-inputs/amendments.js';
import { renderFreshRevisionNote, renderRevisionContinuation } from './work-revision.js';
import { flipJobToWorking, rebriefFreshMinion, recordFollowUpDelivery, routeFixDirectiveToMinion, type DirectiveRegistry } from './fix-directive.js';
import { checkRebriefTurn, finalizeRebriefRequest, RebriefTurnCancelled } from './rebrief-recovery.js';
import { retireInterruptedDirectiveFromRoute } from './directive-recovery.js';
import type { LessonsReferencePort } from '../lessons/types.js';
import { BranchBusyError } from './branch-idle.js';
import { deliveredTargetSha, type SilasOpsDigest } from './silas-driver.js';
import { isVerdictRungRule, parseSilasRouteRuleId, strictOptStrField } from './silas-rules.js';
import type { WorktreePort } from './worktree-port.js';
import type { PacingGate, RetrySettlement } from '../runtime/pacing.js';
import { childRefusalStatus, type ChildWorkerService } from './child-workers.js';
import { REVIEW_EVIDENCE_MAX_FILES, type ReviewEvidenceRequest } from '../review-inputs/evidence.js';

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
  readonly pendingProducerBlockers: (jobId: string) => readonly string[];
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
  /** Book of Lessons injection for directives/re-briefs (pointers only). */
  readonly lessons?: LessonsReferencePort;
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

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolveBody, rejectBody) => {
      let seen = 0;
      const chunks: Buffer[] = [];
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        seen += chunk.length;
        if (seen > 512 * 1024) {
          rejected = true;
          rejectBody(new Error('request body exceeds 512 KiB'));
          req.destroy();
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
      const outcome = await options.dispatch.dispatch({
        jobId: strField(body, 'job_id'),
        repoPath: strField(body, 'repo_path'),
        title: strField(body, 'title'),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(deliverable !== undefined ? { deliverable } : {}),
        ...(commissioner !== undefined ? { commissioner } : by !== undefined ? { commissioner: by } : {}),
        ...(targetRef !== undefined ? { targetRef } : {}),
        ...(targetSha !== undefined ? { targetSha } : {}),
        ...(parentJobId !== undefined ? { parentJobId } : {}),
        briefing: strField(body, 'briefing'),
        ...(completionHandoff !== undefined ? { completionHandoff } : {}),
      });
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
      const job = options.dispatch.recordPr(jobId, strField(body, 'url'));
      if (by === 'silas') {
        options.ledger.appendCustomEvent({
          kind: 'silas.pr-registered',
          jobId,
          payload: { url: job.prUrl },
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
      const ruleId = optStrField(body, 'rule_id');
      const sourceRoundId = optStrField(body, 'source_round_id');
      const requestedTargetRef = optStrField(body, 'target_ref');
      const evidenceRefs = optEvidenceField(body);
      if ((ruleId === undefined) !== (sourceRoundId === undefined) ||
          (ruleId !== undefined && (by !== 'silas' || ruleId !== 'clean-abort-service-restart'))) {
        throw new Error('rule_id/source_round_id must be paired and only silas may use clean-abort-service-restart');
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
        const delivered = options.ledger.latestJobEvent(jobId, 'job.delivered');
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
          ...(intent.state === 'retired'
            ? {
                admission_class: directiveAdmissionClass(intent),
                retired_at: intent.retiredAt,
                retired_by: intent.retiredBy,
                retire_reason: intent.retireReason,
                retire_expected_state: intent.retireExpectedState,
                retire_expected_head: intent.retireExpectedHead,
                hold_released_by: intent.holdReleasedBy,
                hold_released_at: intent.holdReleasedAt,
              }
            : {}),
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
      // The contract a FRESH fallback session reads is fixed in the same tick
      // as the intent's revision stamp (owner rule 4): an amendment accepted
      // while the writer gate waits travels with the NEXT continuation.
      const contractAtIntent = options.ledger.effectiveContract(jobId)?.text ?? null;
      // Owner rule 4: the approved material amendments this lane has not
      // delivered travel ONCE with this request — canonical text, version
      // order, stamped with the revision the intent recorded, and rendered
      // from the amendment set of the SAME tick (a later supersession can
      // never withhold a body the stamp claims).
      const workRevision = intent.workRevision ?? 0;
      const deliveredRevision = options.ledger.workRevisionState(jobId).delivered;
      const amendmentsAtIntent = options.ledger.listJobAmendments(jobId);
      const continuation = renderRevisionContinuation({
        jobId,
        revision: workRevision,
        deliveredRevision,
        pending: pendingMaterialAmendments(amendmentsAtIntent, deliveredRevision, workRevision),
        supersededBy: amendmentSupersessions(amendmentsAtIntent),
      });
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
        let delivery: Awaited<ReturnType<typeof routeFixDirectiveToMinion>>;
        try {
          delivery = await routeFixDirectiveToMinion({
            registry: ops.registry,
            ledger: options.ledger,
            worktrees: ops.worktrees,
            jobId,
            directive,
            ...(continuation !== ''
              ? { continuation: { block: continuation, freshNote: renderFreshRevisionNote(workRevision) } }
              : {}),
            contract: contractAtIntent,
            signal: controller.signal,
            owner: 'silas-ops',
            ...(options.workerGate !== undefined ? { workerGate: options.workerGate } : {}),
            ...(options.retrySettlement !== undefined ? { retrySettlement: options.retrySettlement } : {}),
            ...(options.lessons !== undefined ? { lessons: options.lessons } : {}),
            ...(options.childWorkers !== undefined
              ? { parentTools: (agentId: string) => options.childWorkers!.parentTools(agentId) }
              : {}),
          });
        } catch (error) {
          // The turn errored with no positive outcome. A prompt may or may
          // not have been delivered (shutdown abort vs prompt failure):
          // admission stays UNKNOWN — record the attempt, never fabricate
          // an outcome, never auto-retry (boot reconciliation reconciles).
          options.ledger.recordDirectiveReconcile({
            requestId: intent.requestId,
            note: `turn interrupted before admission evidence: ${String(error)}`,
          });
          log('error', 'silas directive turn interrupted — request left for reconciliation', {
            job: jobId,
            request: intent.requestId,
            error: String(error),
          });
          return;
        } finally {
          directiveControllers.delete(controller);
        }
        if (!delivery.delivered) {
          if (delivery.admission === 'unknown') {
            // The router cannot prove non-admission: cancellation or a
            // spent/superseded retry AFTER the prompt call. Marking the
            // request failed would release the single-writer guard while a
            // prior writer's recovery may still be live. Keep it live with
            // a durable reconcile note — boot reconciliation escalates it
            // for a Gru decision, never an automatic retry.
            options.ledger.recordDirectiveReconcile({
              requestId: intent.requestId,
              note:
                `turn interrupted with unknown admission: ${delivery.note ?? 'no proof of non-delivery'}` +
                ' — no delivery recorded; reconcile settlement/cessation before releasing the request',
            });
            log('warn', 'silas directive turn interrupted — request left live for reconciliation', {
              job: jobId,
              request: intent.requestId,
              note: delivery.note ?? null,
            });
            return;
          }
          // Positive no-effect proof (no live minion and no job lane): a
          // durable failure is honest; the caller resubmits fresh work.
          const reason = delivery.note ?? 'no implementing minion session and no job lane';
          options.ledger.failDirective({
            requestId: intent.requestId,
            reason,
          });
          // A marked phase whose request failed with positive no-effect
          // proof can never complete: close the guard row (no hand-back).
          const phase = options.ledger.findPhaseHandoffByRequest({ jobId, requestId: intent.requestId });
          if (phase !== null && phase.state === 'awaiting') {
            options.ledger.closePhaseHandoff({ phaseId: phase.phaseId, reason: `directive request failed: ${reason}` });
          }
          log('warn', 'silas directive undelivered — durable no-effect failure recorded', {
            job: jobId,
            request: intent.requestId,
            note: delivery.note ?? null,
          });
          return;
        }
        const sent = options.ledger.appendCustomEvent({
          kind: 'silas.directive-sent',
          jobId,
          payload: {
            request_id: intent.requestId,
            minion_id: delivery.minionId ?? null,
            ...(fingerprint !== undefined ? { blocker_fingerprint: fingerprint } : {}),
            ...(ruleId !== null ? { rule_id: ruleId } : {}),
            ...(sourceRoundId !== undefined ? { source_round_id: sourceRoundId } : {}),
            directive_bytes: Buffer.byteLength(directive, 'utf-8'),
          },
        });
        if (delivery.minionId === undefined) {
          // Admission evidence without the actor identity cannot bind the
          // request: leave it live for reconciliation, never guess.
          options.ledger.recordDirectiveReconcile({
            requestId: intent.requestId,
            note: 'admission evidence lacked minion identity',
          });
          return;
        }
        // Native admission evidence: the request is now bound to an actual
        // awaited turn — recordDirectiveAdmission validates the event.
        options.ledger.recordDirectiveAdmission({
          requestId: intent.requestId,
          minionId: delivery.minionId,
          eventSeq: sent.seq,
        });
        // In-band runtime error (resolved-but-failed: Claude result.isError,
        // Pi stopReason 'error'): the prompt WAS admitted, so the admission
        // evidence stands — but there is no successful delivery and NO
        // phase completion. The request stays admitted with a durable
        // reconcile note (the boot pass escalates it for a Gru
        // reconciliation); the recovery decision is preserved without
        // claiming phase evidence and without auto-retry.
        if (delivery.outcome === 'error') {
          options.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId,
            payload: { agentId: delivery.minionId, error: delivery.error ?? 'runtime error' },
          });
          options.ledger.recordDirectiveReconcile({
            requestId: intent.requestId,
            note:
              'admitted turn settled with an in-band runtime error' +
              `${delivery.error === undefined ? '' : `: ${delivery.error}`} — no delivery recorded; reconcile before recording completion`,
          });
          log('warn', 'silas directive turn settled with an in-band error — no delivery/completion recorded', {
            job: jobId,
            request: intent.requestId,
            error: delivery.error ?? null,
          });
          return;
        }
        flipJobToWorking(options.ledger, jobId);
        // The follow-up delivery signal: the directive turn settled, so record
        // the delivery (with the lane head it produced) that re-arms review —
        // correlated to THIS request, so a later unrelated delivery cannot
        // clear this marker.
        const markedPhase = options.ledger.findPhaseHandoffByRequest({ jobId, requestId: intent.requestId });
        const markedPhaseId = markedPhase?.phaseId ?? null;
        const followUp = recordFollowUpDelivery({
          ledger: options.ledger,
          worktrees: ops.worktrees,
          jobId,
          agentId: delivery.minionId,
          source: 'silas-directive',
          requestId: intent.requestId,
          // A marked phase carries its host-owned phase id on the delivery:
          // the completion observer matches on that id, never the event seq.
          ...(markedPhaseId !== null ? { phaseId: markedPhaseId } : {}),
          // The service-bound acknowledgement of the revision this request
          // carried (owner rule 4).
          workRevision,
        });
        if (followUp.note !== null) {
          log('warn', 'silas follow-up delivery has no resolvable lane head', {
            job: jobId,
            lane: followUp.lanePath,
            note: followUp.note,
          });
        }
        options.ledger.recordDirectiveDelivery({ requestId: intent.requestId, eventSeq: followUp.eventSeq });
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
          },
          reason,
          by,
        });
      } catch (error) {
        if (error instanceof DirectiveRetirementError) {
          json(res, 409, {
            error: error.code,
            detail: error.message,
            ...(error.blockers.length > 0 ? { blockers: error.blockers } : {}),
          });
          return true;
        }
        if (error instanceof RecordNotFound) {
          json(res, 404, { error: 'not_found', detail: error.message });
          return true;
        }
        throw error;
      }
      const record = outcome.record;
      json(res, 200, {
        request_id: record.requestId,
        job_id: record.jobId,
        state: record.state,
        idempotent: outcome.idempotent,
        admission_class: directiveAdmissionClass(record),
        admission_seq: record.admissionSeq,
        minion_id: record.admissionMinion,
        retired_at: record.retiredAt,
        retired_by: record.retiredBy,
        retire_reason: record.retireReason,
        retire_expected_state: record.retireExpectedState,
        retire_expected_head: record.retireExpectedHead,
        hold_released_by: record.holdReleasedBy,
        hold_released_at: record.holdReleasedAt,
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
        work_revision: record.workRevision,
        ...(record.state === 'retired'
          ? {
              admission_class: directiveAdmissionClass(record),
              retired_at: record.retiredAt,
              retired_by: record.retiredBy,
              retire_reason: record.retireReason,
              retire_expected_state: record.retireExpectedState,
              retire_expected_head: record.retireExpectedHead,
              hold_released_by: record.holdReleasedBy,
              hold_released_at: record.holdReleasedAt,
            }
          : {}),
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
      // Owner rules 3/5: same writer admission as a directive — a lane under
      // review takes a re-brief only when an approved material change made
      // the reviewed candidate obsolete. That review is superseded and
      // PROVEN stopped before the durable request exists (a re-brief marker
      // cannot be withdrawn without fabricating its guarded events), then
      // admission is re-proved synchronously with the marker write.
      const admitWriter = (): boolean => {
        try {
          options.wave.assertWriterAdmissible(jobId);
          return true;
        } catch (error) {
          if (error instanceof ReviewInProgressError) {
            json(res, 409, { error: 'review_in_progress', detail: error.message, round_ids: error.roundIds });
            return false;
          }
          throw error;
        }
      };
      if (!admitWriter()) return true;
      try {
        await options.wave.clearLaneForWriter({ jobId, writer: `re-brief for job ${jobId}` });
      } catch (error) {
        if (!(error instanceof ReviewSupersessionUnconfirmedError)) throw error;
        log('warn', 'silas re-brief refused: the superseded review could not be proven stopped', {
          job: jobId, detail: error.detail,
        });
        json(res, 409, { error: 'review_supersession_unconfirmed', detail: error.message });
        return true;
      }
      const jobAtMarker = options.ledger.getJob(jobId);
      if (jobAtMarker === null) throw new Error(`job "${jobId}" not found`);
      if (isJobTerminal(jobAtMarker.status)) {
        throw new Error(`job "${jobId}" is ${jobAtMarker.status} — terminal lanes are never re-briefed`);
      }
      if (!admitWriter()) return true;
      // A fresh worker has no memory of accepted amendments: it is briefed
      // with the EFFECTIVE contract (owner rule 4), recorded on the durable
      // marker so a restart re-delivers exactly this contract.
      const contract = options.ledger.effectiveContract(jobId)?.text ?? jobAtMarker.briefing;
      // Restart-safe by construction: the request markers are durable
      // BEFORE any worker exists, and clear only when their events land.
      // A restart mid-turn leaves them for the boot reconciler.
      let markers: ReturnType<typeof options.ledger.beginPendingRebrief>;
      try {
        markers = options.ledger.beginPendingRebrief({
          jobId,
          note,
          briefing: contract,
          ...(ruleId !== null ? { ruleId } : {}),
          ...(sourceRoundId !== undefined ? { sourceRoundId } : {}),
          ...(completionHandoff !== undefined ? { handoff: completionHandoff } : {}),
        });
      } catch (error) {
        if (error instanceof LaneWriterConflictError) {
          json(res, 409, { error: 'writer_conflict', detail: error.message });
          return true;
        }
        throw error;
      }
      const workRevision = markers.find((marker) => marker.workRevision !== null)?.workRevision ?? 0;
      const rebriefPhaseId = markers.find((marker) => marker.phaseId !== null)?.phaseId ?? null;
      const closeFailedTerminalTurn = (error: unknown): ReturnType<typeof finalizeRebriefRequest> | null => {
        const currentJob = options.ledger.getJob(jobId);
        if (currentJob === null || !isJobTerminal(currentJob.status)) return null;
        // Failure evidence remains, but the obsolete request cannot be
        // retried on a terminal job. Close only the admitted generation.
        const closed = finalizeRebriefRequest({
          ledger: options.ledger, worktrees: ops.worktrees, jobId,
          minionId: null, lanePath: null, note, expectedMarkers: markers,
        });
        log('info', 'silas re-brief failed after terminality — request closed', {
          job: jobId, error: String(error), retired: closed.retired,
          superseded: closed.superseded,
          ...(closed.retirement !== null ? { refused: closed.retirement.refused, skipped: closed.retirement.skippedIds } : {}),
        });
        return closed;
      };
      const controller = new AbortController();
      directiveControllers.add(controller);
      let result: Awaited<ReturnType<typeof rebriefFreshMinion>>;
      try {
        result = await rebriefFreshMinion({
          registry: ops.registry,
          ledger: options.ledger,
          worktrees: ops.worktrees,
          signal: controller.signal,
          ...(options.workerGate !== undefined ? { workerGate: options.workerGate } : {}),
          ...(options.retrySettlement !== undefined ? { retrySettlement: options.retrySettlement } : {}),
          ...(options.childWorkers !== undefined
            ? { parentTools: (agentId: string) => options.childWorkers!.parentTools(agentId) }
            : {}),
          jobId,
          note,
          briefing: contract,
          workRevision,
          beforeTurnSideEffect: () => checkRebriefTurn(options.ledger, jobId, markers),
          onSpawned: (worker) => {
            options.ledger.bindPendingRebriefWorker({
              ids: markers.map((marker) => marker.id),
              agentId: worker.id,
              sessionFile: worker.sessionFile,
            });
          },
          ...(options.lessons !== undefined ? { lessons: options.lessons } : {}),
        });
      } catch (error) {
        if (!(error instanceof RebriefTurnCancelled)) {
          let closed: ReturnType<typeof finalizeRebriefRequest> | null = null;
          try {
            closed = closeFailedTerminalTurn(error);
          } catch (closureError) {
            log('error', 'silas re-brief failure could not close terminal request', {
              job: jobId, error: String(error), closure_error: String(closureError),
            });
          }
          if (closed === null && !isJobTerminal(options.ledger.getJob(jobId)?.status ?? 'working')) throw error;
          json(res, 400, {
            error: 'bad_request',
            detail: String(error instanceof Error ? error.message : error),
            ...(closed?.retired === true ? { retired: true } : {}),
            ...(closed?.superseded === true ? { superseded: true } : {}),
            ...(closed?.retirement !== undefined && closed.retirement !== null
              ? { retirement: { refused: closed.retirement.refused, skipped_ids: closed.retirement.skippedIds } } : {}),
          });
          return true;
        }
        const cancelled = finalizeRebriefRequest({
          ledger: options.ledger, worktrees: ops.worktrees, jobId,
          minionId: null, lanePath: null, note, expectedMarkers: markers,
        });
        log('info', 'silas re-brief cancelled before admission', {
          job: jobId, reason: error.reason, retired: cancelled.retired,
          superseded: cancelled.superseded,
          ...(cancelled.retirement !== null
            ? { refused: cancelled.retirement.refused, skipped: cancelled.retirement.skippedIds } : {}),
        });
        json(res, 200, {
          job_id: jobId, minion_id: null, delivered_sha: null,
          ...(cancelled.retired ? { retired: true } : {}),
          ...(cancelled.superseded ? { superseded: true } : {}),
          ...(cancelled.retirement !== null
            ? { retirement: { refused: cancelled.retirement.refused, skipped_ids: cancelled.retirement.skippedIds } } : {}),
        });
        return true;
      } finally {
        directiveControllers.delete(controller);
      }
      if (result.outcome === 'error') {
        // In-band runtime error: the re-brief turn resolved but failed. No
        // delivery, no `silas.rebrief`, no phase completion — the durable
        // markers stay pending for the boot recovery ladder, and the error
        // is on the record honestly. The request was NOT a successful
        // completion and must never complete a marked phase.
        options.ledger.appendCustomEvent({
          kind: 'job.minion-error',
          jobId,
          payload: { agentId: result.minionId, error: result.error ?? 'runtime error' },
        });
        const closed = closeFailedTerminalTurn(result.error ?? 'runtime error');
        log('warn', 're-brief turn settled with an in-band error — no delivery recorded', {
          job: jobId,
          minion: result.minionId,
          error: result.error ?? null,
          retired: closed?.retired ?? false,
        });
        json(res, 202, {
          job_id: jobId,
          minion_id: result.minionId,
          state: 'turn-error',
          error: result.error ?? null,
          ...(closed?.retired === true ? { retired: true } : {}),
          ...(closed?.superseded === true ? { superseded: true } : {}),
          ...(closed?.retirement !== undefined && closed.retirement !== null
            ? { retirement: { refused: closed.retirement.refused, skipped_ids: closed.retirement.skippedIds } } : {}),
          note:
            'the re-brief turn settled with an in-band runtime error; no delivery or phase completion ' +
            (closed?.retired === true
              ? 'was recorded and the terminal request was retired'
              : 'was recorded and the request markers stay pending for restart reconciliation'),
        });
        return true;
      }
      // The follow-up delivery signal: the fresh minion's re-brief turn
      // settled; record the delivery that re-arms the re-review. Both
      // events land before their markers clear (idempotent on replay).
      const followUp = finalizeRebriefRequest({
        ledger: options.ledger,
        worktrees: ops.worktrees,
        jobId,
        minionId: result.minionId,
        lanePath: result.lanePath,
        note,
        expectedPhaseId: rebriefPhaseId,
        expectedMarkers: markers,
      });
      if (followUp.retired) {
        // The job reached terminal while the turn was in flight: the
        // request was administratively retired; no events were fabricated.
        // A partial retirement carries its kept-marker ids here too — the
        // response already carries `retirement`, and this log must not
        // silently drop the same disposition.
        log('info', 'silas re-brief retired: job went terminal before the turn settled', {
          job: jobId,
          minion_id: result.minionId,
          ...(followUp.retirement !== null
            ? { refused: followUp.retirement.refused, skipped: followUp.retirement.skippedIds }
            : {}),
        });
      } else if (followUp.retirement !== null) {
        // A defensive boundary refused the retirement or the marker identity
        // drifted: the markers stay for the next pass and nothing was
        // fabricated. Surface it instead of an unexplained ordinary 200.
        log('warn', 'silas re-brief retirement incomplete: markers kept for the next pass', {
          job: jobId,
          refused: followUp.retirement.refused,
          skipped: followUp.retirement.skippedIds,
        });
      }
      if (followUp.superseded) {
        log('warn', 're-brief request superseded while its turn ran — newer request owns the lane', {
          job: jobId,
          request_phase: rebriefPhaseId,
        });
      }
      if (followUp.deliveryNote !== null) {
        log('warn', 'silas follow-up delivery has no resolvable lane head', {
          job: jobId,
          lane: result.lanePath,
          note: followUp.deliveryNote,
        });
      }
      json(res, 200, {
        job_id: jobId,
        minion_id: result.minionId,
        lane: result.lanePath,
        delivered_sha: followUp.deliveredSha,
        ...(followUp.retired ? { retired: true } : {}),
        ...(followUp.superseded ? { superseded: true } : {}),
        ...(followUp.retirement !== null
          ? { retirement: { refused: followUp.retirement.refused, skipped_ids: followUp.retirement.skippedIds } }
          : {}),
      });
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
      if (!path.startsWith('/api/dispatch') && !path.startsWith('/api/silas') && !path.startsWith('/api/pipeline') && !isDisposition) {
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
    },
  };
}
