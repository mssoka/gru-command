import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { LedgerApi } from '../ledger/api.js';
import { AmbiguousDirectiveError, DirectiveConflictError, PhaseHandoffConflictError } from '../ledger/api.js';
import { isJobTerminal } from '../ledger/states.js';
import { parseCompletionHandoffIntent, type CompletionHandoffIntent } from '../ledger/obligations.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { DispatchService } from './service.js';
import type { WaveRunner } from './perkins.js';
import { flipJobToWorking, rebriefFreshMinion, recordFollowUpDelivery, routeFixDirectiveToMinion, type DirectiveRegistry } from './fix-directive.js';
import { checkRebriefTurn, finalizeRebriefRequest, RebriefTurnCancelled } from './rebrief-recovery.js';
import type { LessonsReferencePort } from '../lessons/types.js';
import { BranchBusyError } from './branch-idle.js';
import { deliveredTargetSha } from './silas-driver.js';
import type { WorktreePort } from './worktree-port.js';
import type { PacingGate, RetrySettlement } from '../runtime/pacing.js';

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
  /** Provider pacing: bounded settlement of an automatic rate-limit retry
   * covering a just-delivered directive/re-brief turn (supervisor-backed
   * in production). The route records delivered only for 'none'/'recovered'. */
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  /** Absent = /api/silas/* answers 503 (silas ops not hosted). */
  readonly silasOps?: SilasOpsSurface;
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

/** The optional explicit completion intent on phase-authorizing requests.
 * Absent = ordinary flow; malformed = fail loud (the handler answers 400
 * BEFORE any job/side effect runs). */
function completionHandoffField(body: Record<string, unknown>): CompletionHandoffIntent | undefined {
  const value = body['completion_handoff'];
  if (value === undefined) return undefined;
  return parseCompletionHandoffIntent(value);
}

export function createDispatchServer(options: DispatchServerOptions): DispatchServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.config.auth.token);
  const configured = tokenConfigured(options.config.auth.token);
  const inFlight = new Set<Promise<unknown>>();
  const directiveControllers = new Set<AbortController>();

  function authed(req: IncomingMessage, res: ServerResponse): boolean {
    if (!configured) {
      json(res, 503, { error: 'not_configured', detail: 'no pairing token configured' });
      return false;
    }
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header.trim()) : null;
    const token = match === null ? null : match[1] ?? null;
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

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (req.method === 'POST' && path === '/api/dispatch') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const completionHandoff = completionHandoffField(body);
      const outcome = await options.dispatch.dispatch({
        jobId: strField(body, 'job_id'),
        repoPath: strField(body, 'repo_path'),
        title: strField(body, 'title'),
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
    if (req.method === 'POST' && path === '/api/dispatch/review') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const by = byField(body);
      const force = optBoolField(body, 'force');
      const ruleId = optStrField(body, 'rule_id');
      const sourceRoundId = optStrField(body, 'source_round_id');
      if ((ruleId === undefined) !== (sourceRoundId === undefined) ||
          (ruleId !== undefined && (by !== 'silas' || ruleId !== 'clean-abort-service-restart'))) {
        throw new Error('rule_id/source_round_id must be paired and only silas may use clean-abort-service-restart');
      }
      const input = {
        jobId: strField(body, 'job_id'),
        ...(optStrField(body, 'target_ref') !== undefined ? { targetRef: optStrField(body, 'target_ref') } : {}),
        ...(optStrArray(body, 'lenses') !== undefined ? { lenses: optStrArray(body, 'lenses') } : {}),
        ...(optBoolField(body, 'no_spec') !== undefined ? { noSpec: optBoolField(body, 'no_spec') } : {}),
        ...(force !== undefined ? { force } : {}),
        ...(by === 'minion' ? { handoff: true } : {}),
      };
      if (sourceRoundId !== undefined) {
        if (force === true) throw new Error('mechanical clean-abort re-arm cannot force past the branch-idle guard');
        const round = options.ledger.getRound(sourceRoundId);
        const proof = options.ledger.latestRoundEvent(sourceRoundId, 'round.perkins-incomplete');
        const reason = typeof proof?.payload === 'object' && proof.payload !== null
          ? (proof.payload as { reason?: unknown }).reason : null;
        const newestRound = options.ledger.listRounds(input.jobId).at(-1);
        const delivered = options.ledger.latestJobEvent(input.jobId, 'job.delivered');
        const sha = delivered === null ? null : deliveredTargetSha(delivered);
        if (round?.jobId !== input.jobId || round.status !== 'aborted' ||
            newestRound?.id !== sourceRoundId || sha === null || sha !== round.targetRef ||
            (reason !== 'service_restart' && reason !== 'service_restart_missing_review_lane')) {
          throw new Error('source round is not the latest clean service-restart abort on the unchanged delivered head');
        }
        const latest = options.ledger.latestJobEvent(input.jobId, 'silas.review-triggered');
        if (latest !== null && typeof latest.payload === 'object' && latest.payload !== null &&
            (latest.payload as { source_round_id?: unknown }).source_round_id === sourceRoundId) {
          throw new Error(`clean-abort round ${sourceRoundId} was already re-armed`);
        }
      }
      let outcome: Awaited<ReturnType<WaveRunner['requestReview']>>;
      try {
        outcome = await options.wave.requestReview(input);
      } catch (error) {
        if (error instanceof BranchBusyError) {
          const refusal = error.refusal();
          if (by === 'silas') {
            // The deferred-arm note: Silas retries on the next sweep once
            // the busy lane delivers; the ledger keeps the deferral trail.
            options.ledger.appendCustomEvent({
              kind: 'silas.review-deferred',
              jobId: input.jobId,
              payload: {
                target_branch: error.targetBranch,
                phase: error.phase,
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
        options.ledger.appendCustomEvent({
          kind: 'silas.review-triggered',
          jobId: input.jobId,
          payload: {
            route: outcome.route,
            ...(ruleId !== undefined ? { rule_id: ruleId, source_round_id: sourceRoundId } : {}),
            ...(outcome.route === 'perkins' ? { round_id: outcome.round.id } : {}),
          },
        });
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
    const worktreesMatch = /^\/api\/dispatch\/jobs\/([^/]+)\/worktrees$/.exec(path);
    if (req.method === 'GET' && worktreesMatch !== null) {
      if (!authed(req, res)) return true;
      const rows = options.dispatch.worktreesFor(decodeURIComponent(worktreesMatch[1] ?? ''));
      json(res, 200, { worktrees: rows });
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
      const requestIdField = optStrField(body, 'request_id');
      const completionHandoff = completionHandoffField(body);
      const job = options.ledger.getJob(jobId);
      if (job === null) throw new Error(`job "${jobId}" not found`);
      if (job.status === 'merged' || job.status === 'done') {
        throw new Error(`job "${jobId}" is ${job.status} — terminal lanes take no directives`);
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
        throw error;
      }
      const intent = begun.record;
      if (intent.state === 'settled' || intent.state === 'failed') {
        // A consumed request id never re-runs (recovered capacity is not
        // permission): report the durable outcome; changed work needs a
        // NEW request id.
        json(res, 200, {
          request_id: intent.requestId,
          job_id: jobId,
          state: intent.state,
          replay: true,
          minion_id: intent.admissionMinion,
          fail_reason: intent.failReason,
          note: 'this request id already reached a terminal state — submit changed work under a new request id',
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
      // The async turn stays owned and tracked by THIS server instance
      // (the existing directiveControllers/inFlight coordinator — no
      // detached helper, no second chief). Late errors surface durably.
      const controller = new AbortController();
      directiveControllers.add(controller);
      const run = (async (): Promise<void> => {
        let delivery: Awaited<ReturnType<typeof routeFixDirectiveToMinion>>;
        try {
          delivery = await routeFixDirectiveToMinion({
            registry: ops.registry,
            ledger: options.ledger,
            worktrees: ops.worktrees,
            jobId,
            directive,
            signal: controller.signal,
            owner: 'silas-ops',
            ...(options.workerGate !== undefined ? { workerGate: options.workerGate } : {}),
            ...(options.retrySettlement !== undefined ? { retrySettlement: options.retrySettlement } : {}),
            ...(options.lessons !== undefined ? { lessons: options.lessons } : {}),
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
      });
      track(run);
      // Accepted ≠ admitted: 202 reports the durable INTENT; actual native
      // admission and the terminal receipt land on the request's record
      // and are readable via GET /api/silas/directives/{request_id}.
      json(res, 202, {
        request_id: intent.requestId,
        job_id: jobId,
        state: 'dispatching',
        note: 'accepted — dispatching is not admission; read back GET /api/silas/directives/{request_id}',
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
        accepted_at: record.createdAt,
        updated_at: record.updatedAt,
        admission_seq: record.admissionSeq,
        minion_id: record.admissionMinion,
        delivery_seq: record.deliverySeq,
        attempts: record.attempts,
        fail_reason: record.failReason,
        states: {
          dispatching:
            'accepted; a dispatch claim was taken before any side effect — native admission not yet recorded (or unknown after a crash)',
          admitted: 'a correlated silas.directive-sent event bound an actual awaited turn; terminal receipt pending',
          settled: 'the correlated job.delivered terminal receipt was recorded',
          failed: 'a durable positive no-effect failure was recorded; resubmit changed work under a new request id',
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
      const completionHandoff = completionHandoffField(body);
      const job = options.ledger.getJob(jobId);
      if (job === null) throw new Error(`job "${jobId}" not found`);
      if (job.status === 'merged' || job.status === 'done') {
        throw new Error(`job "${jobId}" is ${job.status} — terminal lanes are never re-briefed`);
      }
      // Restart-safe by construction: the request markers are durable
      // BEFORE any worker exists, and clear only when their events land.
      // A restart mid-turn leaves them for the boot reconciler.
      const markers = options.ledger.beginPendingRebrief({
        jobId,
        note,
        briefing: job.briefing,
        ...(completionHandoff !== undefined ? { handoff: completionHandoff } : {}),
      });
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
          jobId,
          note,
          briefing: job.briefing,
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
      const jobId = optStrField(body, 'job_id');
      if (jobId !== undefined && options.ledger.getJob(jobId) === null) {
        throw new Error(`job "${jobId}" not found`);
      }
      // Bind the row to the lane's current worker (existing agentId
      // semantics) so a terminal lane's leftover escalation is classified
      // as a closed receipt; no bound worker → unbound and live
      // (unknown historical rows are never guessed; tracked-review A4).
      // Selection is listAgents order, as resolveEscalationAgent documents.
      const boundMinion =
        jobId !== undefined
          ? options.ledger.listAgents().find((agent) => agent.jobId === jobId && agent.role === 'minion')
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
        payload: { title, notification_id: notification.id },
      });
      json(res, 200, { notification_id: notification.id });
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
      const result = await ops.providerRecovery.claim(waitId, by);
      json(res, 200, result as Record<string, unknown>);
      return true;
    }
    return false;
  }

  return {
    requestHook(req, res, path): boolean {
      if (!path.startsWith('/api/dispatch') && !path.startsWith('/api/silas')) return false;
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
