import { capturePortLaneHandoff } from '../worktrees/handoff.js';
import { createHash, randomUUID } from 'node:crypto';
import { requireArtifactJobId } from '../artifacts/context.js';
import type { LogLevel } from '../logger.js';
import type { CreationContinuationState, CreationContinuationTimeline, JobDeliverable, LedgerApi, JobRecord } from '../ledger/api.js';
import { LaneWriterConflictError, RecordNotFound, creationContinuationJobRefusal, creationContinuationRepoMismatch, requireSafeRecordId } from '../ledger/api.js';
import type { CompletionHandoffIntent } from '../ledger/obligations.js';
import { isJobStatus, isJobTerminal } from '../ledger/states.js';
import type { Role } from '../config.js';
import type { AgentHandle, NativeAgentTool, SpawnOptions } from '../runtime/types.js';
import { requireSpawnCwd } from '../roles.js';
import { renderLessonsSection } from '../lessons/references.js';
import type { LessonPointer, LessonsReferencePort } from '../lessons/types.js';
import type { LessonCapturePort } from '../lessons/capture.js';
import type { RetainedJobCreationInspection, WorktreeLane, WorktreePort, WorktreeSweepResult } from './worktree-port.js';
import { RetainedCreationFailedError, RetainedCreationRefusalError, redactCreationTokens, type RetainedReceiptExpectation } from '../worktrees/creation-intent.js';
import { recordFollowUpDelivery } from './fix-directive.js';
import { isPromptTurnVerdict, promptVerdictFromHealth } from '../runtime/prompt-verdict.js';
import type { PromptTurnVerdict } from '../runtime/types.js';
import { settleRetries, RetrySettlementUnavailableError, type PacingGate, type PacingLease, type RetrySettlement } from '../runtime/pacing.js';
import type { DiskFloorGate, FloorAdmission } from '../maintenance/disk.js';
import type { EventBus } from '../events/bus.js';
import { WORKER_RULE_BLOCKS } from './worker-rules.js';
import {
  assertLaneUsesBoundStore,
  blobText,
  changedPaths,
  isAncestorCommit,
  renderReviewSourceBlock,
  storeCommit,
  targetBlob,
  type ReviewRequiredInput,
  type ReviewSourceBinding,
  type ReviewSourcePackage,
  type ReviewSourcePreflight,
} from './review-source.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export interface CreationContinuationReadback {
  readonly job_id: string;
  readonly request_id: string;
  readonly generation: number;
  readonly payload_sha256: string;
  readonly state: CreationContinuationState;
  readonly active: boolean;
  readonly job_status: string | null;
  readonly original: {
    readonly handoff_seq: number | null;
    readonly briefing_sha256: string | null;
    readonly handoff_repo_path: string | null;
    readonly repo_path: string | null;
    readonly branch: string | null;
    readonly base_sha: string | null;
    readonly base_source: string | null;
    readonly producer_settlement_seq: number | null;
  };
  /** The registered lane, or (`retained-receipt`) the ref and receipt a
   * failed continuation kept after rolling its checkout back. */
  readonly custody: {
    readonly worktree_id: string | null;
    readonly path: string | null;
    readonly branch: string | null;
    readonly sha: string | null;
    readonly base_source: string | null;
    readonly status: string;
    readonly evidence: 'manager-reconciliation' | 'ledger-registry-only' | 'retained-receipt';
  } | null;
  readonly queue: { readonly gate: string; readonly reason: string | null } | null;
  readonly admission: { readonly agent_id: string; readonly event_seq: number } | null;
  readonly delivery: { readonly event_seq: number; readonly agent_id: string | null; readonly sha: string | null } | null;
  readonly reason: string | null;
  readonly timeline: readonly { readonly seq: number; readonly ts: string; readonly state: string; readonly stage: string }[];
}

export interface CreationContinuationRequestResult {
  readonly created: boolean;
  readonly readback: CreationContinuationReadback;
}

interface CreationContinuationExecution {
  readonly job: JobRecord;
  readonly timeline: CreationContinuationTimeline;
  readonly expected: RetainedReceiptExpectation;
}

import {
  admitBlindReview,
  blindCoverageOf,
  observeBlindSessionAccess,
  readSessionToolResults,
  recordBlindAdmission,
  recordObservedAccess,
  renderBlindPackageBlock,
  type BlindCoverage,
} from './blind-review.js';
import { blindDiffSections, gitBlobSha, normalizeRepoPath, shownPath, shownWhere, type BlindInputPackage, type BlindViolation, type DiffHunk, type ObservedToolResult } from './blind-input.js';

/** A file's lines as a diff counts them (a final newline ends the last). */
function fileLines(text: string): readonly string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Whether a hunk side's lines are the file's own lines from `start`. */
function hunkSideHolds(text: string | null, start: number, lines: readonly string[]): boolean {
  if (lines.length === 0) return true;
  if (text === null || start < 1) return false;
  const file = fileLines(text);
  return start - 1 + lines.length <= file.length && lines.every((line, at) => file[start - 1 + at] === line);
}

/** The selected object store's reading of a blind package (#360 R5-B2): it
 * names the preflight-verified target and a base that is the target's own
 * ancestor; every file is that target's own blob; every path its diff names
 * is one `base..target` really changes; and every line a hunk shows is that
 * file's own line where the hunk header says — removals and context at the
 * base, additions and context at the target. Self-consistent digests alone
 * bind nothing. */
function bindBlindPackage(binding: ReviewSourceBinding): (pkg: BlindInputPackage) => readonly BlindViolation[] {
  return (pkg) => {
    const store = binding.objectStore;
    const unbound = (where: string, detail: string): BlindViolation => ({ code: 'unbound-package', where, detail });
    const target = storeCommit(store, pkg.targetSha);
    if (target !== binding.targetSha) return [unbound('input_package.target_sha', `package target ${pkg.targetSha} is not the verified review target ${binding.targetSha}`)];
    const violations: BlindViolation[] = [];
    const base = storeCommit(store, pkg.baseSha);
    const baseHolds = base !== null && isAncestorCommit(store, base, target);
    if (base === null) violations.push(unbound('input_package.base_sha', `package base ${pkg.baseSha} is not in the object store`));
    else if (!baseHolds) violations.push(unbound('input_package.base_sha', `package base ${pkg.baseSha} is not an ancestor of the review target ${target}`));
    for (const file of pkg.files ?? []) {
      const path = normalizeRepoPath(file.path);
      const blob = targetBlob(store, target, path);
      if (blob === null) violations.push(unbound(shownWhere(path), `${shownPath(path)} is not a file in the target tree`));
      else if (blob !== gitBlobSha(file.content)) violations.push(unbound(shownWhere(path), `the bytes supplied for ${shownPath(path)} are not the target's blob ${blob}`));
    }
    if (pkg.diff !== undefined && base !== null && baseHolds) {
      const changed = changedPaths(store, base, target);
      if (changed === null) violations.push(unbound('diff', `the range ${pkg.baseSha}..${pkg.targetSha} cannot be read`));
      else {
        for (const section of blindDiffSections(pkg.diff.text)) {
          const named = [...new Set([section.oldPath, section.path])].filter((path) => !changed.has(path));
          for (const path of named) violations.push(unbound(shownWhere(path), `the diff names ${shownPath(path)}, which ${pkg.baseSha}..${pkg.targetSha} does not change`));
          if (named.length > 0 || section.hunks.length === 0) continue;
          const before = blobText(store, base, section.oldPath);
          const after = blobText(store, target, section.path);
          const side = (hunk: DiffHunk, old: boolean): string => old ? `-${String(hunk.oldStart)}` : `+${String(hunk.newStart)}`;
          for (const hunk of section.hunks) {
            if (!hunkSideHolds(before, hunk.oldStart, hunk.oldLines)) {
              violations.push(unbound(shownWhere(section.oldPath), `the hunk at ${side(hunk, true)} shows lines that are not ${shownPath(section.oldPath)} at ${pkg.baseSha}`));
            }
            if (!hunkSideHolds(after, hunk.newStart, hunk.newLines)) {
              violations.push(unbound(shownWhere(section.path), `the hunk at ${side(hunk, false)} shows lines that are not ${shownPath(section.path)} at ${pkg.targetSha}`));
            }
          }
        }
      }
    }
    return violations;
  };
}

/**
 * Dispatch flow (EPICS E8 story 2; SPEC rulings 2/17/18): the Gru-authored
 * briefing becomes a job, ops (the Silas role's mechanical hand) hands it
 * to a minion on a FRESH WORKTREE per job, the minion runs rooted in the
 * project (cwd = the worktree — ruling 17), and the lifecycle lands on the
 * board via the ledger. The PR link and review loop follow.
 */

/** The spawn surface the dispatcher needs (RuntimeRegistry.spawn in
 * production; a plain function so lambdas and bound methods both fit). */
export type AgentSpawner = (
  role: Role,
  options?: SpawnOptions,
) => Promise<AgentHandle>;

export interface DispatchOutcome {
  readonly job: JobRecord;
  readonly worktree: WorktreeLane;
  readonly agentId: string;
  /** Resolves when the minion's briefing turn settles (ok | error).
   * `outcomeUnknown`: the turn failed while the service was stopping, so
   * whether the sent prompt delivered is not known. */
  readonly settled: Promise<{ readonly ok: boolean; readonly error?: string; readonly outcomeUnknown?: boolean }>;
}

export interface DispatchServiceOptions {
  readonly ledger: LedgerApi;
  /** The worktree subsystem (ruling 18) — a port since the Perkins r4
   * split: the manager implementation is its own lane. */
  readonly worktrees: WorktreePort;
  readonly spawner: AgentSpawner;
  /** Provider pacing: FIFO worker (minion turn) admission gate. Absent =
   * off; an unlimited or disabled gate admits immediately. */
  readonly workerGate?: PacingGate;
  /** Provider pacing: the bounded settlement of an automatic rate-limit
   * retry covering a just-delivered worker turn (supervisor-backed in
   * production). The delivery records success only for 'none'/'recovered'
   * and releases its worker lease before waiting so the retry can
   * reacquire admission. Absent = no interlock. */
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  /** Service-stopping signal: aborts a QUEUED admission wait and lets the
   * settlement wait below observe shutdown instead of hanging. Absent =
   * settlement is hook-owned and the queue wait is uncancellable. */
  readonly stopSignal?: AbortSignal;
  /** The disk floor (#427 PR 3): awaited before the job's admission is
   * reserved and its lane created. Absent = no floor. */
  readonly diskFloor?: Pick<DiskFloorGate, 'admitLane'>;
  /** The job events (#427 PR 3): a lane waiting at the disk floor ends when
   * its job is binned, parked, blocked or finished meanwhile. Absent = only
   * the service's stop ends that wait. */
  readonly bus?: Pick<EventBus, 'subscribe'>;
  /** Book of Lessons injection: pointer lines only, never chapter bodies. */
  readonly lessons?: LessonsReferencePort;
  /** Extracts a minion's opt-in lessons block at delivery settle. */
  readonly lessonsCapture?: LessonCapturePort;
  /** Issue #161: the GC-mediated parent tools injected into a dispatched
   * parent session (request/list/cancel child workers, bound to the
   * parent's agent id by closure). Absent = no child-request path. */
  readonly parentTools?: (agentId: string) => readonly NativeAgentTool[];
  /** Issue #317: the review-source preflight (git against the actual
   * selected object store). Absent = report reviews carry no source proof
   * and may not name a base, required inputs or a source package. */
  readonly reviewSource?: ReviewSourcePreflight;
  /** #360 R5-B2: admit a blind input package with no preflight to bind it
   * against. Test harnesses only; production always wires the preflight. */
  readonly allowUnboundBlindPackages?: boolean;
  /** Issue #316: reads a finished blind reviewer's tool results from its
   * session file (default: the session jsonl on disk). null = unobservable. */
  readonly sessionToolResults?: (sessionFile: string | null) => readonly ObservedToolResult[] | null;
  readonly log?: Log;
}

/** Render the prompt handed to a dispatched minion (contract-shaped). */
export function renderMinionBriefing(input: {
  jobId: string;
  repoName: string;
  branch: string;
  worktreePath: string;
  sha: string;
  briefing: string;
  /** Your own agent id — the durable identity a child-worker request must
   * carry as `parent_agent_id` (issue #161). Optional for callers that
   * render the briefing before a session is bound. */
  agentId?: string;
  /** Progressive-disclosure reference lines (no chapter bodies). */
  lessons?: readonly LessonPointer[];
  /** Issue #161: this parent has GC-mediated child-worker tools wired. */
  childWorkerTools?: boolean;
  /** The job's deliverable kind (E19). Non-PR kinds get their own closing
   *  orders: a review job's deliverable is its findings — it commits
   *  nothing, and an unmodified tree is the expected result; artifact and
   *  investigation jobs hand back their artifacts without opening a PR. */
  deliverable?: JobDeliverable;
  /** Issue #317: the preflight-verified review source, bound verbatim. */
  reviewSource?: ReviewSourceBinding;
  /** #360 R5-B3: an admitted blind reviewer's package — its input. */
  blindPackage?: BlindInputPackage;
}): string {
  const lessonsSection = renderLessonsSection(input.lessons ?? []);
  return [
    `Dispatch briefing — job ${input.jobId}`,
    `Repo: ${input.repoName}`,
    `Branch: ${input.branch} (worktree: ${input.worktreePath})`,
    `Base head at dispatch: ${input.sha}`,
    ...(input.agentId === undefined ? [] : [`Your agent id: ${input.agentId}`]),
    '',
    'BRIEFING:',
    input.briefing,
    ...(input.reviewSource === undefined ? [] : ['', ...renderReviewSourceBlock(input.reviewSource)]),
    ...(input.blindPackage === undefined ? [] : ['', ...renderBlindPackageBlock(input.blindPackage)]),
    ...(lessonsSection === '' ? [] : ['', lessonsSection]),
    ...WORKER_RULE_BLOCKS.flatMap((block) => ['', block]),
    '',
    ...(input.childWorkerTools === true
      ? [
          'Independent capacity (ad-hoc helper work only): if the briefing calls',
          'for one independent helper (e.g. read-only verification), use the',
          'GC-owned `request_child_worker` tool to commission one tracked child,',
          '`list_child_workers` to discover its durable result, and',
          '`cancel_child_worker` to stop it. This is NOT the build workflow\'s',
          'independent reviewer: that review runs as its own tracked review job',
          '(a megaminion) commissioned through `POST /api/dispatch` with',
          `\`"deliverable": "review"\` and \`"parent_job_id": "${input.jobId}"\` — never as a`,
          'generic child. Children cannot commission children; never launch',
          'external or headless agents yourself.',
          '',
        ]
      : []),
    ...(input.deliverable === 'review'
      ? [
          'Execute the briefing inside this worktree. Standing orders: work only',
          'inside this tree; this brief is READ-ONLY — change nothing, commit',
          'nothing (an unmodified tree is the expected result); read the named',
          'immutable head and diff via git show/git diff inside your tree; never',
          'merge; end with your findings and a completion report.',
        ]
      : input.deliverable === 'artifact' || input.deliverable === 'investigation'
        ? [
            'Execute the briefing inside this worktree. Standing orders: work only',
            'inside this tree; commit your work to the branch; verify it; hand back',
            'the named artifact and end with a completion report; do not open a',
            'pull request — this job owes an artifact handback, not a PR.',
          ]
        : [
            'Execute the briefing inside this worktree. Standing orders: work only',
            'inside this tree; commit your work to the branch; verify it (build,',
            'tests, lint — whatever this project calls green) before finishing;',
            'never merge your own pull request. End with a completion report.',
          ]),
  ].join('\n');
}

export class DispatchService {
  private readonly opts: DispatchServiceOptions;
  private readonly log: Log;
  private readonly activeCreationContinuations = new Set<string>();

  constructor(opts: DispatchServiceOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  private continuationKey(jobId: string, requestId: string): string {
    return `${jobId}\0${requestId}`;
  }

  private safeContinuationReason(error: unknown): string {
    return redactCreationTokens(error instanceof Error ? error.message : String(error)).slice(0, 1000);
  }

  /** Authenticated route entry: inspect only, durably fence one identity,
   * then run the same dispatch body in the background. Retries only return
   * the recorded request; they never start it again. */
  async requestCreationContinuation(input: { readonly jobId: string; readonly requestId: string }): Promise<CreationContinuationRequestResult> {
    requireSafeRecordId(input.jobId, 'job id');
    requireSafeRecordId(input.requestId, 'creation continuation request id');
    const existing = this.opts.ledger.getCreationContinuation(input.jobId, input.requestId);
    if (existing !== null) return { created: false, readback: this.creationContinuationReadback(existing) };

    const job = this.opts.ledger.getJob(input.jobId);
    if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
    const handoffs = this.opts.ledger.listJobEventsByKinds(input.jobId, ['job.handoff'], { limit: 2 });
    const handoff = handoffs.length === 1 ? handoffs[0]! : null;
    const handoffPayload = handoff?.payload as Record<string, unknown> | undefined;
    const handoffRepoPath = typeof handoffPayload?.['repoPath'] === 'string' ? handoffPayload['repoPath'] : null;
    let repoPath: string | null = null;
    const briefingSha256 = typeof job.briefing === 'string'
      ? createHash('sha256').update(job.briefing, 'utf8').digest('hex') : null;
    let inspection: RetainedJobCreationInspection | null = null;
    let refusalReason = creationContinuationJobRefusal(job) ?? undefined;
    if (refusalReason !== undefined) {
      // Refused at job scope; nothing else is read.
    } else if (handoff === null || handoffRepoPath === null) refusalReason = `job "${job.id}" has no unique original job.handoff with its repository path`;
    else if (this.opts.ledger.listJobAmendments(input.jobId).length > 0) refusalReason = `job "${job.id}" has an amended contract outside initial-dispatch continuation`;
    else if (this.opts.worktrees.inspectRetainedJobCreation === undefined || this.opts.worktrees.createRetainedJobWorktree === undefined) {
      refusalReason = 'retained-creation inspection and strict manager continuation are not wired';
    } else {
      try {
        refusalReason = creationContinuationRepoMismatch(job, handoffRepoPath, null) ?? undefined;
        if (refusalReason === undefined) {
          inspection = await this.opts.worktrees.inspectRetainedJobCreation({ repoPath: handoffRepoPath, jobId: input.jobId });
          refusalReason = creationContinuationRepoMismatch(job, handoffRepoPath, inspection.repoPath) ?? (
            inspection.jobId !== input.jobId || inspection.branch !== `gru/${input.jobId}` || inspection.sha.length < 40 || inspection.baseSource === null
              ? 'WorktreeManager returned a retained-creation identity that does not match the original job handoff' : undefined);
          if (refusalReason === undefined) repoPath = inspection.repoPath;
          else inspection = null;
        }
      } catch (error) {
        refusalReason = this.safeContinuationReason(error);
      }
    }
    const identityPayload = {
      schema: 'same-job-retained-creation-continuation-v1', job_id: input.jobId, request_id: input.requestId,
      handoff_seq: handoff?.seq ?? null, briefing_sha256: briefingSha256, handoff_repo_path: handoffRepoPath, repo_path: repoPath,
      branch: inspection?.branch ?? null, base_sha: inspection?.sha ?? null, base_source: inspection?.baseSource ?? null,
      producer_settlement_seq: inspection?.producerSettlementSeq ?? null,
      receipt_token_sha256: inspection?.receiptTokenSha256 ?? null,
    };
    const payloadSha256 = createHash('sha256').update(JSON.stringify(identityPayload), 'utf8').digest('hex');
    const accepted = this.opts.ledger.acceptCreationContinuation({
      jobId: input.jobId, requestId: input.requestId, payloadSha256,
      handoffSeq: handoff?.seq ?? null, briefingSha256, handoffRepoPath, repoPath,
      branch: inspection?.branch ?? null, baseSha: inspection?.sha ?? null,
      baseSource: inspection?.baseSource ?? null, producerSettlementSeq: inspection?.producerSettlementSeq ?? null,
      receiptTokenSha256: inspection?.receiptTokenSha256 ?? null,
      ...(refusalReason !== undefined ? { refusalReason } : {}),
    });
    if (!accepted.created || accepted.timeline.state !== 'accepted') {
      return { created: accepted.created, readback: this.creationContinuationReadback(accepted.timeline) };
    }

    const { identity } = accepted.timeline;
    const record = (state: CreationContinuationState | undefined, stage: string, details: Readonly<Record<string, unknown>>): void => {
      this.opts.ledger.recordCreationContinuationState({
        jobId: input.jobId, requestId: input.requestId, generation: identity.generation,
        ...(state === undefined ? {} : { state }), stage, details,
      });
    };
    const key = this.continuationKey(input.jobId, input.requestId);
    this.activeCreationContinuations.add(key);
    let custodyAttempted = false;
    let custodyAdopted = false;
    let disposedBeforePrompt = false;
    const execution: CreationContinuationExecution = {
      job, timeline: accepted.timeline,
      expected: { receiptTokenSha256: identity.receiptTokenSha256!, producerSettlementSeq: identity.producerSettlementSeq! },
    };
    void Promise.resolve().then(async () => {
      try {
        const continuation = {
          ...execution,
          custodyAttempted: () => { custodyAttempted = true; },
          custodyAdopted: (lane: WorktreeLane) => {
            custodyAdopted = true;
            record(undefined, 'custody-adopted', {
              worktree_id: lane.id, path: lane.path, branch: lane.branch, sha: lane.sha,
              base_source: identity.baseSource, worktree_status: lane.status,
            });
          },
          queued: (gate: string, reason: string) => record('queued', 'queued', { gate, reason }),
          disposedBeforePrompt: () => { disposedBeforePrompt = true; },
        };
        // The handoff path, as the original dispatch had it: its leaf is
        // the job's repository name, a symlinked path included.
        const outcome = await this.dispatch({
          jobId: job.id, repoPath: handoffRepoPath!, title: job.title,
          ...(job.displayName !== null ? { displayName: job.displayName } : {}),
          ...(job.deliverable !== null ? { deliverable: job.deliverable } : {}),
          ...(job.parentJobId !== null ? { parentJobId: job.parentJobId } : {}),
          briefing: job.briefing!, creationContinuation: continuation,
        });
        const settled = await outcome.settled;
        // The prompt was sent: a turn whose retries shutdown cancelled has
        // an unknown outcome, never a known failure.
        if (!settled.ok) {
          const reason = this.safeContinuationReason(settled.error ?? 'minion turn failed');
          if (settled.outcomeUnknown === true) record('custody-unknown', 'turn-outcome-unknown', { reason });
          else record('failed', 'turn-settled-failure', { reason });
        }
      } catch (error) {
        const reason = this.safeContinuationReason(error);
        if (error instanceof RetainedCreationRefusalError) {
          record('refused', 'manager-guard-refused', { reason });
        } else if (error instanceof RetainedCreationFailedError) {
          record('failed', 'retained-custody-kept', { reason, custody: 'retained' });
        } else if (!custodyAttempted && error instanceof LaneWriterConflictError) {
          record('refused', 'admission-refused', { reason });
        } else if (!custodyAttempted) {
          record('failed', 'failed-before-manager', { reason });
        } else {
          const lane = this.opts.ledger.getWorktree(input.jobId);
          const admitted = this.opts.ledger.getCreationContinuationDispatchEvidence(input.jobId, input.requestId, identity.generation).spawned;
          if (custodyAdopted && lane?.status === 'swept' && (admitted === null || disposedBeforePrompt)) {
            record('failed', admitted === null ? 'known-swept-failure' : 'failed-before-prompt', { reason, worktree_status: lane.status });
          } else if (!custodyAdopted && lane !== null) {
            // Registered, then failed: the registry row holds the lane and
            // the receipt may already be spent.
            record('custody-unknown', 'registered-unsettled', { reason, worktree_status: lane.status });
          } else {
            record('custody-unknown', 'unsettled-failure', {
              reason, manager_attempted: true, custody_adopted: custodyAdopted,
              worktree_status: lane?.status ?? null, agent_spawn_event_observed: admitted !== null,
            });
          }
        }
      } finally {
        this.activeCreationContinuations.delete(key);
      }
    }).catch((error: unknown) => {
      this.log('error', 'creation continuation settlement could not be durably recorded', {
        job: input.jobId, request: input.requestId, error: this.safeContinuationReason(error),
      });
    });
    return { created: true, readback: this.creationContinuationReadback(accepted.timeline) };
  }

  getCreationContinuationReadback(jobId: string, requestId: string): CreationContinuationReadback | null {
    const timeline = this.opts.ledger.getCreationContinuation(jobId, requestId);
    return timeline === null ? null : this.creationContinuationReadback(timeline);
  }

  private creationContinuationReadback(timeline: CreationContinuationTimeline): CreationContinuationReadback {
    const { identity } = timeline;
    const active = this.activeCreationContinuations.has(this.continuationKey(identity.jobId, identity.requestId));
    const job = this.opts.ledger.getJob(identity.jobId);
    const evidence = this.opts.ledger.getCreationContinuationDispatchEvidence(identity.jobId, identity.requestId, identity.generation);
    const lane = this.opts.ledger.getWorktree(identity.jobId);
    const managerCustodyRecorded = timeline.events.some((event) => (event.payload as Record<string, unknown>)['stage'] === 'custody-adopted');
    let state = timeline.state;
    if (evidence.delivery !== null) state = 'delivered';
    else if (state !== 'failed' && state !== 'refused' && state !== 'delivered' && !active) state = 'custody-unknown';
    else if (evidence.spawned !== null && state !== 'failed' && state !== 'refused') state = 'admitted';
    const latestPayload = timeline.events.at(-1)!.payload as Record<string, unknown>;
    const queueEvent = [...timeline.events].reverse().find((event) => (event.payload as Record<string, unknown>)['state'] === 'queued');
    const queuePayload = queueEvent?.payload as Record<string, unknown> | undefined;
    const spawnPayload = evidence.spawned?.payload as Record<string, unknown> | undefined;
    const deliveryPayload = evidence.delivery?.payload as Record<string, unknown> | undefined;
    return {
      job_id: identity.jobId, request_id: identity.requestId, generation: identity.generation,
      payload_sha256: identity.payloadSha256, state, active, job_status: job?.status ?? null,
      original: {
        handoff_seq: identity.handoffSeq, briefing_sha256: identity.briefingSha256,
        handoff_repo_path: identity.handoffRepoPath, repo_path: identity.repoPath,
        branch: identity.branch, base_sha: identity.baseSha, base_source: identity.baseSource,
        producer_settlement_seq: identity.producerSettlementSeq,
      },
      custody: lane !== null ? {
        worktree_id: lane.id, path: lane.path, branch: lane.branch, sha: lane.sha,
        base_source: lane.baseSource, status: lane.status,
        evidence: managerCustodyRecorded ? 'manager-reconciliation' : 'ledger-registry-only',
      } : latestPayload['custody'] === 'retained' ? {
        worktree_id: null, path: null, branch: identity.branch, sha: identity.baseSha,
        base_source: identity.baseSource, status: 'retained', evidence: 'retained-receipt',
      } : null,
      queue: queuePayload === undefined ? null : {
        gate: typeof queuePayload['gate'] === 'string' ? queuePayload['gate'] : 'unknown',
        reason: typeof queuePayload['reason'] === 'string' ? queuePayload['reason'] : null,
      },
      admission: evidence.spawned === null || typeof spawnPayload?.['agentId'] !== 'string' ? null : {
        agent_id: spawnPayload['agentId'], event_seq: evidence.spawned.seq,
      },
      delivery: evidence.delivery === null ? null : {
        event_seq: evidence.delivery.seq,
        agent_id: typeof deliveryPayload?.['agentId'] === 'string' ? deliveryPayload['agentId'] : null,
        sha: typeof deliveryPayload?.['sha'] === 'string' ? deliveryPayload['sha'] : null,
      },
      reason: typeof latestPayload['reason'] === 'string' ? latestPayload['reason'] : null,
      timeline: timeline.events.map((event) => {
        const payload = event.payload as Record<string, unknown>;
        return { seq: event.seq, ts: event.ts, state: String(payload['state']), stage: String(payload['stage']) };
      }),
    };
  }

  /**
   * Gru authors the briefing; this is the ops handoff. Steps are ordered
   * and loud: job row → worktree (fresh head, own branch) → minion spawn
   * rooted in the worktree → briefing prompt. A failure at any step
   * blocks the job (with note) instead of leaking half a lane; a spawn
   * failure also sweeps the fresh worktree back out.
   */
  async dispatch(input: {
    jobId: string;
    repoPath: string;
    title: string;
    displayName?: string;
    /** The deliverable kind (E19): reviewers dispatch with `review`,
     * artifact-only lanes with `artifact`/`investigation`; omitted = a
     * PR-owing implementation lane. */
    deliverable?: JobDeliverable;
    /** Issue #220 report-job closure: who commissioned this report (the
     * disposition debtor) and what it reviewed. The commissioner defaults
     * to the parent job on a megaminion (the minion that asked for the
     * review acts on it — owner ruling 2026-10-08), else to `gru` on
     * report-type jobs; a review job WITHOUT a target fails
     * loud — findings that cannot name what they reviewed are not a
     * commissioned report. Rejected on PR-owing lanes (the lane's own PR
     * is the deliverable, recorded via recordPr). */
    commissioner?: string;
    targetRef?: string;
    targetSha?: string;
    /** Issue #317 review-source preflight inputs (review jobs only): the
     * focused-delta base, content the review needs (claims lenses), and an
     * optional hash-pinned git bundle authorizing a source repair. */
    targetBase?: string;
    requiredInputs?: readonly ReviewRequiredInput[];
    sourcePackage?: ReviewSourcePackage;
    /** The commissioning job: a minion dispatching a specialist
     * (megaminion) names its own job so the child nests under that heist. */
    parentJobId?: string;
    briefing: string;
    /** Issue #316: `blind` (isolated input, validated before spawn) or
     * `claims` (a reviewer that legitimately needs claims — a separate
     * contract). Omitted = inferred from a lane named blind, else unclassified. */
    reviewRole?: string;
    /** Issue #316: the blind reviewer's exact immutable input package. */
    inputPackage?: BlindInputPackage;
    /** Issue #316: the parent contract hash the child was composed against;
     * a stale hash is refused so a clarification cannot be missed. */
    parentContractSha256?: string;
    /** Explicit completion intent: when present, the phase-handoff guard
     * row is persisted BEFORE any side effect and this exact phase's
     * validated completion owes the named decision durably. Omitted =
     * ordinary Silas completion. */
    completionHandoff?: CompletionHandoffIntent;
    /** Internal only: an authenticated same-job continuation has already
     * persisted its request; it reuses the job row and handoff and enters
     * only the strict retained-receipt manager path. */
    creationContinuation?: CreationContinuationExecution & {
      readonly custodyAttempted: () => void;
      readonly custodyAdopted: (lane: WorktreeLane) => void;
      readonly queued: (gate: string, reason: string) => void;
      readonly disposedBeforePrompt: () => void;
    };
  }): Promise<DispatchOutcome> {
    if (input.jobId.trim() === '' || input.title.trim() === '' || input.briefing.trim() === '') {
      throw new Error('dispatch requires a non-empty job id, title, and briefing');
    }
    // Preserve the existing public identifier diagnostics before applying
    // the narrower new-artifact storage precondition, both before effects.
    requireSafeRecordId(input.jobId, 'job id');
    requireArtifactJobId(input.jobId);
    const isReportKind = input.deliverable !== undefined && input.deliverable !== 'pr';
    if (isReportKind) {
      if (input.targetRef !== undefined && input.targetRef.trim() === '') {
        throw new Error(`report job "${input.jobId}" target_ref must be a non-empty string when present`);
      }
      if (input.targetSha !== undefined && input.targetSha.trim() === '') {
        throw new Error(`report job "${input.jobId}" target_sha must be a non-empty string when present`);
      }
      if (input.deliverable === 'review' &&
          (input.targetRef === undefined || input.targetRef.trim() === '' ||
           input.targetSha === undefined || input.targetSha.trim() === '')) {
        throw new Error(
          `report review job "${input.jobId}" requires a review target: target_ref (the PR url) and target_sha ` +
            '(the reviewed head) — findings that cannot name their target are not a commissioned report',
        );
      }
    } else if (input.targetRef !== undefined || input.targetSha !== undefined) {
      throw new Error(
        `job "${input.jobId}" is a PR-owing lane — target_ref/target_sha are report-job fields`,
      );
    }
    // An explicit commissioner always wins; a megaminion's default debtor
    // is its parent job (owner ruling 2026-10-08), never Gru by default.
    const commissioner = isReportKind
      ? (input.commissioner?.trim() || input.parentJobId?.trim() || 'gru')
      : undefined;
    const targetRef = isReportKind ? input.targetRef?.trim() : undefined;
    const targetSha = isReportKind ? input.targetSha?.trim() : undefined;
    const repoName = input.repoPath.split('/').filter(Boolean).pop() ?? input.repoPath;

    // (0b) Issue #317: prove the ACTUAL selected object store holds the
    // review inputs BEFORE any job row, worktree or reviewer turn exists. A
    // refusal throws ReviewSourceUnavailableError — never a report.
    const namesSourceFields = input.targetBase !== undefined || input.requiredInputs !== undefined || input.sourcePackage !== undefined;
    if (namesSourceFields && input.deliverable !== 'review') {
      throw new Error(`job "${input.jobId}": target_base/required_inputs/source_package only apply to review jobs`);
    }
    if (namesSourceFields && this.opts.reviewSource === undefined) {
      throw new Error(`job "${input.jobId}": review source preflight is not wired — refusing to admit a review whose source cannot be proven`);
    }
    // #360 R5-B2: a blind package is bound to the target's git objects by
    // the preflight; without it the package is refused by name, unless the
    // embedding explicitly admits unbound packages (test harnesses only).
    if (input.deliverable === 'review' && input.inputPackage !== undefined && this.opts.reviewSource === undefined &&
        this.opts.allowUnboundBlindPackages !== true) {
      throw new Error(`job "${input.jobId}": review source preflight is not wired — refusing to admit a blind input package whose bytes cannot be bound to the target's git objects`);
    }
    const reviewSource: ReviewSourceBinding | null =
      input.deliverable === 'review' && targetSha !== undefined && this.opts.reviewSource !== undefined
        ? this.opts.reviewSource({
            jobId: input.jobId,
            repoPath: input.repoPath,
            targetSha,
            ...(input.targetBase !== undefined ? { targetBase: input.targetBase.trim() } : {}),
            ...(input.requiredInputs !== undefined ? { requiredInputs: input.requiredInputs } : {}),
            ...(input.sourcePackage !== undefined ? { sourcePackage: input.sourcePackage } : {}),
          })
        : null;

    // The durable record binds the RESOLVED commit the preflight proved,
    // never the caller's possibly-abbreviated spelling: durable-reconcile
    // compares the recorded target_sha to full oids by exact string. The
    // raw value is the fallback only when no preflight ran.
    const recordedTargetSha = reviewSource?.targetSha ?? targetSha;

    // (0) Issue #316: a blind reviewer's input is validated against the
    // parent's EFFECTIVE isolation rule before any job, worktree or reviewer
    // exists. A refusal spends no reviewer turn and names its correction.
    const blindAdmission = admitBlindReview({
      ledger: this.opts.ledger,
      jobId: input.jobId,
      title: input.title,
      displayName: input.displayName,
      deliverable: input.deliverable,
      reviewRole: input.reviewRole,
      briefing: input.briefing,
      targetRef: input.targetRef,
      // The resolved target (#360 R5-E3): already-owned coverage is recorded
      // under it, so an abbreviated spelling can never split it.
      targetSha: recordedTargetSha,
      requestedTargetSha: input.targetSha,
      parentJobId: input.parentJobId,
      repoName,
      inputPackage: input.inputPackage,
      parentContractSha256: input.parentContractSha256,
      requiredInputs: input.requiredInputs,
      ...(reviewSource !== null ? { bindPackage: bindBlindPackage(reviewSource) } : {}),
    });

    // (1) The job row: the briefing IS the contract (recorded verbatim).
    // A continuation uses that exact existing row and never calls addJob.
    const job = input.creationContinuation?.job ?? this.opts.ledger.addJob({
      id: input.jobId,
      repo: repoName,
      title: input.title,
      displayName: input.displayName,
      briefing: input.briefing,
      ...(input.deliverable !== undefined ? { deliverable: input.deliverable } : {}),
      ...(commissioner !== undefined ? { commissioner } : {}),
      ...(targetRef !== undefined ? { targetRef } : {}),
      ...(recordedTargetSha !== undefined ? { targetSha: recordedTargetSha } : {}),
      ...(input.parentJobId !== undefined ? { parentJobId: input.parentJobId } : {}),
    });

    if (reviewSource !== null) {
      this.opts.ledger.appendCustomEvent({
        kind: 'job.review-source-verified',
        jobId: job.id,
        payload: {
          object_store: reviewSource.objectStore,
          target_sha: reviewSource.targetSha,
          target_base: reviewSource.targetBase,
          range_commits: reviewSource.rangeCommits,
          inputs: reviewSource.inputs,
          source: reviewSource.source,
          package_sha256: reviewSource.packageSha256,
        },
      });
    }

    if (blindAdmission !== null) recordBlindAdmission(this.opts.ledger, job.id, blindAdmission, input.inputPackage);

    // (2) Ops handoff: dispatched → working, on the record. An existing
    // continuation reuses its original handoff and never writes another.
    if (input.creationContinuation === undefined) {
      this.opts.ledger.appendCustomEvent({
        kind: 'job.handoff',
        jobId: job.id,
        payload: { repo: repoName, repoPath: input.repoPath },
      });
    }

    let handoffPhaseId: string | null = null;
    // Tracks whether THIS run committed the terminal delivery event: a
    // later bookkeeping failure must not close a phase whose completion
    // evidence already exists (the boot reconciler finishes it instead).
    let deliveredRecorded = false;
    let workerLease: PacingLease | null = null;
    let floorAdmission: FloorAdmission | null = null;
    let releaseAdmission: (() => void) | null = null;
    const releaseJobAdmission = (): void => {
      const release = releaseAdmission;
      releaseAdmission = null;
      release?.();
    };
    const assertAdmissible = (): void => {
      const current = this.opts.ledger.getJob(job.id);
      if (current === null || isJobTerminal(current.status) || current.status === 'parked' || current.status === 'blocked') {
        throw new Error(`initial dispatch refused — job "${job.id}" is ${current?.status ?? 'missing'}`);
      }
    };
    const releaseWorker = (): void => {
      const lease = workerLease;
      workerLease = null;
      lease?.release();
    };
    try {
      const working = this.opts.ledger.setJobStatus(job.id, 'working');

      // (2b) Explicit completion intent BEFORE admission/side effects: the
      // durable guard row exists before any worktree or spawn, so a crash
      // mid-dispatch is provably not a completion and the intent survives.
      if (input.completionHandoff !== undefined) {
        handoffPhaseId = this.opts.ledger.beginPhaseHandoff({
          jobId: job.id,
          source: 'dispatch',
          intent: input.completionHandoff,
        }).record.phaseId;
      }

      // (3a) The disk floor (#427 PR 3): below [worktrees] min_free_disk_gb
      // the lane waits, FIFO, with the honest reason on the job, while GC
      // frees space; it is created once the free space is back at the floor.
      // The wait comes before the admission is reserved, so the owner may
      // bin or park the job meanwhile; that ends the wait. With no floor
      // there is no wait, not even a turn of the event loop: the job reaches
      // the worker gate as promptly as before (#429: a commission answers
      // with the recorded job while that gate holds it).
      const floor = this.opts.diskFloor;
      if (floor !== undefined) floorAdmission = await this.waitAtDiskFloor(
        floor, job.id, input.title,
        input.creationContinuation === undefined ? undefined : (reason) => input.creationContinuation!.queued('disk-floor', reason),
      );
      assertAdmissible();

      // No registered agent exists yet while worktree/pacing/spawn awaits.
      // Reserve that runtime side effect so a concurrent bin cannot close
      // the lane then receive a late briefing.
      releaseAdmission = this.opts.ledger.beginJobAdmission(job.id, input.creationContinuation === undefined
        ? 'initial dispatch' : `initial creation continuation ${input.creationContinuation.timeline.identity.requestId}`);
      // A lane owner may have started while the continuation waited at the
      // floor; the admission now fences any later one.
      if (input.creationContinuation !== undefined) {
        const owner = this.opts.ledger.creationContinuationLaneOwner(job.id);
        if (owner !== null) throw new LaneWriterConflictError(owner);
      }

      // (3) One worktree per job. Only a continuation enters the strict
      // retained-receipt manager method; it can never resolve a fresh base.
      let worktree: WorktreeLane;
      try {
        if (input.creationContinuation !== undefined) {
          const createRetained = this.opts.worktrees.createRetainedJobWorktree;
          if (createRetained === undefined) throw new Error('strict retained-creation manager path is not wired');
          // A failure before the manager starts adopting has touched nothing.
          worktree = await createRetained.call(this.opts.worktrees, {
            repoPath: input.repoPath, jobId: job.id, expected: input.creationContinuation.expected,
            adopting: input.creationContinuation.custodyAttempted,
          });
          input.creationContinuation.custodyAdopted(worktree);
        } else {
          worktree = await this.opts.worktrees.createJobWorktree({ repoPath: input.repoPath, jobId: job.id });
        }
      } finally {
        floorAdmission?.done();
      }
      const assertHandoff = capturePortLaneHandoff(this.opts.worktrees, worktree);
      if (reviewSource !== null) {
        try {
          assertLaneUsesBoundStore(job.id, reviewSource, worktree.path);
        } catch (error) {
          await this.sweepQuietly(worktree.id);
          throw error;
        }
      }

      // (4) The minion: a fresh agent session rooted in the PROJECT
      // worktree (ruling 17: dispatch cwd = project root, all runtimes).
      // Provider pacing: the minion turn waits FIFO for a worker slot when
      // at the configured cap — the lane lands queued on the board with the
      // honest reason and is admitted in order (never rejected, never
      // preempted). Unlimited default admits immediately: zero change.
      if (this.opts.workerGate !== undefined) {
        let queuedReason: string | null = null;
        const lease = await this.opts.workerGate.acquireWorkerTurn({
          id: job.id,
          label: input.title,
          jobId: job.id,
          ...(this.opts.stopSignal !== undefined ? { signal: this.opts.stopSignal } : {}),
          queued: (info) => {
            queuedReason = info.reason;
            this.opts.ledger.noteJob(job.id, info.reason);
            input.creationContinuation?.queued('worker-pacing', info.reason);
          },
        });
        workerLease = lease;
        if (queuedReason !== null) {
          // The lane waited at the cap and is now admitted: replace the queue
          // note so the durable note never keeps claiming a running lane is
          // still queued (the live gate view carries the queue truth).
          this.opts.ledger.noteJob(
            job.id,
            `pacing: admitted after ${lease.waitedMs} ms queue wait`,
          );
        }
      }
      let handle: AgentHandle;
      try {
        assertHandoff();
        assertAdmissible();
        const cwd = requireSpawnCwd('minion', worktree.path);
        // Issue #161: a dispatched parent gets a product-owned identity and
        // the GC-mediated child tools bound to it — no bearer secret ever
        // reaches the session (the tools execute in the service process;
        // a runtime that cannot host them returns none).
        const parentAgentId =
          this.opts.parentTools === undefined ? undefined : `minion_${randomUUID()}`;
        const parentNativeTools =
          parentAgentId === undefined ? [] : (this.opts.parentTools?.(parentAgentId) ?? []);
        handle = await this.opts.spawner('minion', {
          cwd,
          ...(parentAgentId !== undefined ? { agentId: parentAgentId } : {}),
          ...(parentNativeTools.length > 0 ? { nativeTools: parentNativeTools } : {}),
        });
        try {
          assertHandoff();
        assertAdmissible();
        } catch (error) {
          await handle.dispose();
          throw error;
        }
      } catch (error) {
        // The lane cannot start — release the pacing slot, sweep the fresh
        // worktree (preserve first, per ruling 18c) and block the job.
        releaseWorker();
        await this.sweepQuietly(worktree.id);
        throw error;
      }
      // Register the minion lane binding OURSELVES (idempotent): the
      // board engine's spawn-envelope registration is an observer, never
      // a precondition — dispatch must not depend on listener ordering.
      // Issue #161: a dispatched minion is explicitly TOP-LEVEL (legacy
      // rows stay unknown; the marker is never retro-fitted).
      // A minion abandoned before its prompt is disposed. Its row says so and
      // its lane is released as a refused spawn's is only once the disposal
      // resolved; a failed one may leave it running, so nothing is released.
      const abandonBeforePrompt = async (error: unknown, agentRow: boolean): Promise<never> => {
        try {
          await handle.dispose();
        } catch (disposeFailure) {
          this.log('error', 'minion disposal before its prompt failed', { job: job.id, agent: handle.id, error: String(disposeFailure) });
          throw new AggregateError([error, disposeFailure], `${String(error)}; disposing the spawned minion also failed: ${String(disposeFailure)}`);
        }
        if (agentRow) this.opts.ledger.setAgentState(handle.id, 'disposed');
        input.creationContinuation?.disposedBeforePrompt();
        releaseWorker();
        await this.sweepQuietly(worktree.id);
        throw error;
      };
      // A throw from any write after the spawn abandons the minion: no
      // unprompted minion outlives a failed dispatch.
      let registered = false;
      try {
        this.opts.ledger.registerAgent({
          id: handle.id,
          role: 'minion',
          sessionFile: handle.sessionFile,
          jobId: job.id,
          parentage: 'top-level',
        });
        registered = true;
        assertHandoff();
        // Bind the admitted worker to the marked phase BEFORE its prompt runs:
        // a delivery from any other worker can never complete this phase.
        if (handoffPhaseId !== null) {
          this.opts.ledger.bindPhaseHandoffMinion({ phaseId: handoffPhaseId, minionId: handle.id });
        }
        const spawned = this.opts.ledger.appendCustomEvent({
          kind: 'job.minion-spawned',
          jobId: job.id,
          payload: {
            agentId: handle.id, worktree: worktree.path, branch: worktree.branch,
            ...(input.creationContinuation === undefined ? {} : {
              creation_continuation_request_id: input.creationContinuation.timeline.identity.requestId,
              creation_continuation_generation: input.creationContinuation.timeline.identity.generation,
            }),
          },
        });
        if (input.creationContinuation !== undefined) {
          this.opts.ledger.recordCreationContinuationState({
            jobId: job.id, requestId: input.creationContinuation.timeline.identity.requestId,
            generation: input.creationContinuation.timeline.identity.generation,
            state: 'admitted', stage: 'minion-spawned', details: {
              agent_id: handle.id, spawn_event_seq: spawned.seq, worktree_id: worktree.id,
              path: worktree.path, branch: worktree.branch, sha: worktree.sha,
              base_source: input.creationContinuation.timeline.identity.baseSource,
            },
          });
        }
      } catch (error) {
        await abandonBeforePrompt(error, registered);
      }
      this.log('info', 'minion dispatched', {
        job: job.id,
        agent: handle.id,
        worktree: worktree.path,
      });

      // (5) Deliver the briefing. The turn runs in the background; the
      // board shows the arc through ledger events, not this await. A
      // rate-limited turn stays pending until its bounded automatic retry
      // path concludes — never recorded as delivered while a retry could
      // still carry it, never disposed out from under that retry.
      const lessons = this.opts.lessons?.referencesFor(`${input.title}\n${input.briefing}`) ?? [];
      // A failure that settles while the service is stopping leaves the sent
      // prompt's outcome unknown, whichever branch settles it.
      const unlessStopping = (result: { readonly ok: false; readonly error: string }) =>
        this.opts.stopSignal?.aborted === true ? { ...result, outcomeUnknown: true } : result;
      const settleTurn = async (
        failure: unknown | null,
        verdict: PromptTurnVerdict | null,
      ): Promise<{ readonly ok: boolean; readonly error?: string; readonly outcomeUnknown?: boolean }> => {
        // Issue #316/#356: whatever the reviewer's tools actually returned is
        // judged against the rule it was admitted under the moment the
        // initial prompt physically settled — before anything else, before
        // any retry wait and before every disposition-specific exit — so a
        // read-then-reject turn invalidates coverage even when its retries
        // never conclude. The observer never throws.
        this.observeBlindSession(job.id, handle.sessionFile);
        // Release the slot first: the retry reacquires admission per attempt.
        releaseWorker();
        const settlement = await settleRetries(this.opts.retrySettlement, handle.id, this.opts.stopSignal).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        // Judged again once the retries concluded: a retry turn's own reads
        // count too, and a re-scan of reads already seen never inflates the
        // distinct count (#355).
        this.observeBlindSession(job.id, handle.sessionFile);
        if (!settlement.ok) {
          if (!(settlement.error instanceof RetrySettlementUnavailableError)) throw settlement.error;
          // A settlement-system fault is not a rate-limit narrative: block
          // the lane loudly with the internal error instead of narrating a
          // retry that never ran.
          const detail = String(settlement.error);
          this.opts.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId: job.id,
            payload: { agentId: handle.id, error: detail },
          });
          this.recordSettleOutcome(job.id, 'blocked');
          this.opts.ledger.noteJob(job.id, `pacing settlement unavailable — internal error: ${detail.slice(0, 200)}`);
          this.log('error', 'briefing turn settlement unavailable', {
            job: job.id,
            agent: handle.id,
            error: detail,
          });
          // A failed attempt never masquerades as a completed marked phase:
          // no delivery was recorded, so the guard row closes with reason.
          this.closeHandoffQuietly(
            handoffPhaseId,
            `dispatch turn failed: pacing settlement unavailable — internal error: ${detail.slice(0, 200)}`,
          );
          return unlessStopping({ ok: false as const, error: detail });
        }
        const disposition = settlement.value;
        if (disposition === 'cancelled') {
          // Service stopping: the turn's outcome is unknown. Never report it
          // delivered, and leave a named note instead of claiming the lane is
          // still queued.
          const detail = 'dispatch stopped before the automatic retries settled';
          this.opts.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId: job.id,
            payload: { agentId: handle.id, error: detail },
          });
          this.recordSettleOutcome(job.id, 'blocked');
          this.opts.ledger.noteJob(job.id, `pacing: ${detail}`);
          this.log('warn', 'briefing turn settlement cancelled by shutdown', {
            job: job.id,
            agent: handle.id,
          });
          // The turn recorded no delivery, so the marked phase cannot have
          // completed: close the guard row instead of leaving a stale intent.
          this.closeHandoffQuietly(handoffPhaseId, 'dispatch turn failed: service stopped before the automatic retries settled');
          return { ok: false as const, error: detail, outcomeUnknown: true };
        }
        const retryFailed = disposition === 'exhausted' || disposition === 'superseded';
        if (failure !== null && disposition !== 'recovered') {
          const error = String(failure);
          this.opts.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId: job.id,
            payload: { agentId: handle.id, error },
          });
          this.recordSettleOutcome(job.id, 'blocked');
          this.log('error', 'minion briefing turn failed', {
            job: job.id,
            agent: handle.id,
            error,
          });
          if (!deliveredRecorded) {
            this.closeHandoffQuietly(handoffPhaseId, `dispatch turn failed: ${error}`);
          }
          return unlessStopping({ ok: false as const, error });
        }
        if (retryFailed) {
          const error = `automatic rate-limit retry ${disposition} — the briefing turn did not deliver`;
          this.opts.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId: job.id,
            payload: { agentId: handle.id, error },
          });
          this.recordSettleOutcome(job.id, 'blocked');
          this.log('error', 'minion briefing turn did not survive its automatic retries', {
            job: job.id,
            agent: handle.id,
            disposition,
          });
          this.closeHandoffQuietly(handoffPhaseId, `dispatch turn failed: ${error}`);
          return unlessStopping({ ok: false as const, error });
        }
        // Terminal/error correlation (r4 blocker 1): a resolved prompt is
        // not success — both adapters settle fulfilled prompts that ended in
        // an in-band error (Claude result.isError; Pi stopReason 'error').
        // Terminal/error correlation (r4/r5 blocker 1): the verdict was
        // captured by the transport when THIS prompt settled — before any
        // queued successor turn could start — and is held across the retry
        // settlement above. A failed turn never records a phase-tagged
        // delivery and never publishes a completed phase; a retry-recovered
        // disposition is the retry's own clean turn (the supervisor
        // supersedes itself on any further in-band error).
        const evidence =
          disposition === 'recovered'
            ? ({ ok: true, error: null } as const)
            : (verdict ?? promptVerdictFromHealth(handle));
        if (!evidence.ok) {
          return unlessStopping(this.recordTurnFailure(
            job.id,
            handle.id,
            handoffPhaseId,
            deliveredRecorded,
            evidence.error ?? 'runtime settled the briefing turn with an in-band error',
          ));
        }
        // The initial briefing carries the original contract only — revision
        // 0. A material amendment accepted while this turn ran stays pending
        // until a continuation carrying it delivers (owner rule 2).
        const continuationIdentity = input.creationContinuation?.timeline.identity;
        const delivery = recordFollowUpDelivery({ ledger: this.opts.ledger,
          worktrees: this.opts.worktrees, jobId: job.id, agentId: handle.id, source: 'dispatch',
          ...(continuationIdentity === undefined ? {} : {
            creationContinuation: { requestId: continuationIdentity.requestId, generation: continuationIdentity.generation },
          }),
          ...(handoffPhaseId !== null ? { phaseId: handoffPhaseId } : {}), workRevision: 0 });
        // The job.delivered receipt is the delivery; its continuation state
        // is a best-effort mirror that never keeps the job from settling.
        if (continuationIdentity !== undefined) {
          try {
            this.opts.ledger.recordCreationContinuationState({
              jobId: job.id, requestId: continuationIdentity.requestId, generation: continuationIdentity.generation,
              state: 'delivered', stage: 'job-delivered', details: {
                delivery_event_seq: delivery.eventSeq, agent_id: handle.id, sha: delivery.sha,
              },
            });
          } catch (error) {
            this.log('error', 'creation continuation delivered state could not be recorded; its job.delivered receipt stands', {
              job: job.id, request: continuationIdentity.requestId, error: this.safeContinuationReason(error),
            });
          }
        }
        deliveredRecorded = true;
        if (delivery.note !== null) this.log('warn', 'initial delivery has no resolvable lane head', {
          job: job.id, note: delivery.note, lane: delivery.lanePath,
        });
        this.recordSettleOutcome(job.id, 'delivered');
        this.captureLessons(handle, job.id);
        this.log('info', 'minion briefing turn completed', { job: job.id, agent: handle.id, disposition });
        return { ok: true as const };
      };
      // The prompt promise resolves with captured per-turn evidence when
      // the handle attests (`promptWithVerdict`); the fallback handle keeps
      // the legacy void. The verdict is derived INSIDE this first `.then`
      // (never an extra helper hop): the worker-admission release below is
      // settle-leaf ordered and must not gain a microtask.
      const briefing = renderMinionBriefing({
        jobId: job.id,
        repoName,
        branch: worktree.branch ?? `gru/${job.id}`,
        worktreePath: worktree.path,
        sha: worktree.sha,
        briefing: input.briefing,
        ...(input.deliverable !== undefined ? { deliverable: input.deliverable } : {}),
        ...(reviewSource !== null ? { reviewSource } : {}),
        ...(blindAdmission?.payload.role === 'blind' && input.inputPackage !== undefined ? { blindPackage: input.inputPackage } : {}),
        agentId: handle.id,
        ...(this.opts.parentTools !== undefined && this.opts.parentTools(handle.id).length > 0
          ? { childWorkerTools: true }
          : {}),
        ...(lessons.length > 0 ? { lessons } : {}),
      });
      // A synchronous spawn listener can change job state before briefing.
      // No await separates this last check from actual prompt delivery.
      try {
        assertHandoff();
        assertAdmissible();
      } catch (error) {
        await abandonBeforePrompt(error, true);
      }
      const promptRun: Promise<unknown> =
        handle.promptWithVerdict !== undefined
          ? handle.promptWithVerdict(briefing, { owner: `dispatch:${job.id}` })
          : handle.prompt(briefing, { owner: `dispatch:${job.id}` });
      const settled = promptRun
        .then(
          (value) =>
            settleTurn(
              null,
              isPromptTurnVerdict(value) ? value : promptVerdictFromHealth(handle),
            ),
          (error: unknown) => settleTurn(error, null),
        )
        .finally(() => {
          releaseWorker();
          releaseJobAdmission();
        });

      return { job: working, worktree, agentId: handle.id, settled };
    } catch (error) {
      floorAdmission?.done();
      releaseWorker();
      releaseJobAdmission();
      const current = this.opts.ledger.getJob(job.id);
      if (current !== null && !isJobTerminal(current.status) && current.status !== 'parked') {
        this.opts.ledger.setJobStatus(job.id, 'blocked');
        this.opts.ledger.noteJob(job.id, `dispatch failed: ${redactCreationTokens(String(error))}`);
      }
      this.closeHandoffQuietly(handoffPhaseId, `dispatch failed before admission: ${redactCreationTokens(String(error))}`);
      throw error;
    }
  }

  /** The disk floor's wait for one job lane (#427 PR 3), with the queue
   * note on the job (updated as GC's answer changes) and the admission
   * noted. The service's stop ends the wait, and so does the job leaving
   * the states a lane may still be made in (binned, parked, blocked,
   * finished). */
  private async waitAtDiskFloor(
    floor: Pick<DiskFloorGate, 'admitLane'>,
    jobId: string,
    label: string,
    onQueued?: (reason: string) => void,
  ): Promise<FloorAdmission> {
    const jobEnded = new AbortController();
    const unsubscribe = this.opts.bus?.subscribe((event) => {
      if (event.kind !== 'job.status' || event.jobId !== jobId) return;
      const to = (event.payload as { readonly to?: unknown } | null)?.to;
      if (typeof to === 'string' && isJobStatus(to) && (isJobTerminal(to) || to === 'parked' || to === 'blocked')) jobEnded.abort(`job "${jobId}" is ${to}`);
    });
    let floorQueued = false;
    try {
      const admitted = await floor.admitLane({
        id: jobId,
        label,
        jobId,
        signal: this.opts.stopSignal === undefined ? jobEnded.signal : AbortSignal.any([jobEnded.signal, this.opts.stopSignal]),
        queued: (info) => {
          floorQueued = true;
          this.opts.ledger.noteJob(jobId, info.reason);
          onQueued?.(info.reason);
        },
      });
      if (floorQueued) this.opts.ledger.noteJob(jobId, `disk floor: admitted after ${admitted.waitedMs} ms queue wait`);
      return admitted;
    } finally {
      unsubscribe?.();
    }
  }

  /** One failure path for a rejected prompt AND a fulfilled-but-error
   * turn: durable error event, blocked lane, and the marked guard row
   * closed only when no delivery was recorded (a recorded delivery means
   * the completion reconcile owns the phase). A failed attempt can never
   * masquerade as a completed marked phase. */
  private recordTurnFailure(
    jobId: string,
    agentId: string,
    phaseId: string | null,
    deliveredRecorded: boolean,
    error: string,
  ): { ok: false; error: string } {
    this.opts.ledger.appendCustomEvent({
      kind: 'job.minion-error',
      jobId,
      payload: { agentId, error },
    });
    this.recordSettleOutcome(jobId, 'blocked');
    if (!deliveredRecorded) {
      this.closeHandoffQuietly(phaseId, `dispatch turn failed: ${error}`);
    }
    this.log('error', 'minion briefing turn failed', { job: jobId, agent: agentId, error });
    return { ok: false as const, error };
  }

  /** Close an awaiting marked-phase guard row after a positive failure.
   * Never closes a completed phase (a recorded delivery already owns it),
   * and a close failure is logged — the row stays awaiting, which is
   * honest, and no completion evidence exists to fabricate a hand-back. */
  private closeHandoffQuietly(phaseId: string | null, reason: string): void {
    if (phaseId === null) return;
    try {
      const phase = this.opts.ledger.getPhaseHandoff(phaseId);
      if (phase !== null && phase.state === 'awaiting') {
        this.opts.ledger.closePhaseHandoff({ phaseId, reason });
      }
    } catch (error) {
      this.log('error', 'phase handoff close after failure also failed', { phase: phaseId, error: String(error) });
    }
  }

  /** Issue #316/#339: record the finished blind reviewer's observed tool
   * access. This is the dispatch settle seam AND the observer the
   * resume/re-brief settle seam is wired to (so a prohibited read during a
   * continuation invalidates coverage). An unreadable session records nothing
   * (never a fabricated clean pass); a failure here is logged and never
   * blocks the report's delivery. */
  observeBlindSession(jobId: string, sessionFile: string | null): void {
    try {
      observeBlindSessionAccess(
        this.opts.ledger,
        jobId,
        sessionFile,
        this.opts.sessionToolResults ?? readSessionToolResults,
      );
    } catch (error) {
      this.log('error', 'blind review access observation failed', { job: jobId, error: String(error) });
    }
  }

  /** Issue #316: blind-coverage validity of one review job (derived from the
   * admission and observed access — never from settlement). */
  blindCoverage(jobId: string): BlindCoverage {
    return blindCoverageOf(this.opts.ledger, jobId);
  }

  /** Issue #316: record tool results observed outside the settle path (a
   * LATER read by the same reviewer still invalidates its coverage). */
  observeBlindAccess(jobId: string, results: readonly ObservedToolResult[]): BlindCoverage {
    return recordObservedAccess(this.opts.ledger, jobId, results, 'operator');
  }

  /** Capture the minion's opt-in lessons block (a bonus, never the
   * delivery contract — a failure is logged, not surfaced). */
  private captureLessons(handle: AgentHandle, jobId: string): void {
    if (this.opts.lessonsCapture === undefined) return;
    try {
      this.opts.lessonsCapture.capture({ sessionFile: handle.sessionFile, source: `minion:${jobId}` });
    } catch (error) {
      this.log('error', 'minion lessons capture failed', { job: jobId, error: String(error) });
    }
  }

  /** Record the PR link (the minion's lane artifact; merging is review's).
   * A registered PR opens the review window: working|delivered → in-review.
   * Later states (blocked/parked/merged/done/binned) are left as-is — a
   * link never resurrects a lane. Merge DETECTION is not here: nothing in this
   * service writes 'merged'; that stays the external sweep's (Silas's)
   * call — the remaining external caller of the job machine. */
  recordPr(jobId: string, url: string): JobRecord {
    const job = this.opts.ledger.setJobPr(jobId, url);
    this.opts.ledger.appendCustomEvent({
      kind: 'job.pr-linked',
      jobId,
      payload: { url },
    });
    if (job.status === 'working' || job.status === 'delivered') {
      return this.opts.ledger.setJobStatus(jobId, 'in-review');
    }
    return job;
  }

  /** The job's worktree lanes (the registry is the map — ruling 18b). */
  worktreesFor(jobId: string): readonly WorktreeLane[] {
    return this.opts.worktrees.listWorktrees({ jobId });
  }

  /** Release the job's lane (the port's sweep; the manager lane owns the
   * preserve-first/pause-and-ask mechanics). */
  async release(
    jobId: string,
    opts: { confirmKill?: boolean; baseBranch?: string } = {},
  ): Promise<WorktreeSweepResult | null> {
    // Issue #161: a job release never abandons a live child worker.
    const outstanding = this.opts.ledger
      .listChildWorkers({ jobId })
      .filter((child) => child.resultState === null);
    if (outstanding.length > 0) {
      throw new Error(
        `job "${jobId}" has ${outstanding.length} non-terminal child worker(s) — cancel them first ` +
          '(POST /api/dispatch/children/:id/cancel)',
      );
    }
    // Only the JOB's own lane — a linked child (or review) lane that shares
    // the job scope must never be swept in its place.
    const lanes = this.opts.worktrees.listWorktrees({ jobId });
    const active = lanes.find((lane) => lane.kind === 'job' && lane.status !== 'swept');
    if (active === undefined) return null;
    return this.opts.worktrees.release({
      worktreeId: active.id,
      ...(opts.confirmKill !== undefined ? { confirmKill: opts.confirmKill } : {}),
      ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
    });
  }

  /**
   * Settle status truth (owner report 2026-09-22): the briefing turn
   * settling IS the delivery point — `delivered` on ok, `blocked` on
   * error. `delivered` is legal only from `working` (its sole predecessor
   * in the ledger machine); `blocked` is legal from every non-terminal
   * state. When the job already advanced past the settle point (a PR
   * registered mid-turn lands `in-review` first), the newer truth wins —
   * the settle leaves it in place rather than forcing an illegal hop.
   * Merge detection is NOT here: `merged` remains the external sweep's
   * (Silas's) call — the remaining external caller of the job machine.
   */
  private recordSettleOutcome(jobId: string, status: 'delivered' | 'blocked'): void {
    const current = this.opts.ledger.getJob(jobId);
    if (current === null || current.status === status) return;
    // Issue #455: a producer disposed by the owner hold settles as an error.
    // That error is the CONSEQUENCE of the hold, not a fresh blocker: parking
    // stays parked until the owner resumes, while `job.minion-error` keeps
    // the failure itself on the record. A genuine completed turn still walks
    // the ordinary (illegal-from-parked) settle path.
    if (status === 'blocked' && current.status === 'parked') {
      this.log('info', 'settle status skipped — job is under an explicit owner hold', {
        job: jobId,
        status: current.status,
        settle: status,
      });
      return;
    }
    const legal = status === 'blocked' ? !isJobTerminal(current.status) : current.status === 'working';
    if (!legal) {
      this.log('info', 'settle status skipped — job already advanced', {
        job: jobId,
        status: current.status,
        settle: status,
      });
      return;
    }
    this.opts.ledger.setJobStatus(jobId, status);
  }

  private async sweepQuietly(worktreeId: string): Promise<void> {
    try {
      await this.opts.worktrees.release({ worktreeId });
    } catch (error) {
      this.log('error', 'worktree sweep after failed dispatch also failed', {
        worktreeId,
        error: String(error),
      });
    }
  }
}
