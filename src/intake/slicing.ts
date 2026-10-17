import type { LedgerApi } from '../ledger/api.js';
import type { NotificationCenter } from '../notifications/center.js';
import { REQUIRED_SLICING_WORKFLOW_FILE } from '../workflows/manifest.js';
import { loadBundledWorkflowRuntime, type BundledWorkflowRuntime } from '../workflows/runtime.js';
import { slicingPlan } from './breakdown.js';
import { validatePlan } from './planner.js';
import { INTAKE_MAX_OUTPUT_BYTES, type IntakeService } from './service.js';
import { boundedCanonical, canonical, digest, IntakeError, type Proposal } from './types.js';

export const SLICING_HELPER = REQUIRED_SLICING_WORKFLOW_FILE;
/** FOR YOU: a planning minion's sliced plan landed in intake (#429). */
export const INTAKE_SLICING_RESULT_KIND = 'intake.slicing-result';

export interface IntakeSlicingDispatchInput {
  readonly jobId: string;
  readonly repoPath: string;
  readonly title: string;
  readonly briefing: string;
  readonly deliverable: 'investigation';
}
export interface IntakeSlicingOptions {
  readonly intake: IntakeService;
  readonly ledger: Pick<LedgerApi, 'getJob' | 'getApprovedIntakeReview'>;
  /** The normal dispatch path (POST /api/dispatch's service). */
  readonly dispatch: (input: IntakeSlicingDispatchInput) => Promise<unknown>;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  readonly workflow?: () => BundledWorkflowRuntime;
  /** The service's local base URL, named in the minion's briefing. */
  readonly apiBase?: () => string | null;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}
export interface IntakeSlicingCommission {
  readonly repoPath: string;
  readonly intakeId: string;
  readonly requestId: string;
  readonly revisionId: string;
  readonly jobId: string;
  readonly resultRequestId: string;
  /** False when the planning minion was already commissioned. */
  readonly dispatched: boolean;
  /** The planning job's current ledger status, e.g. `blocked` after a failed spawn. */
  readonly jobStatus: string;
}

function fields(value: unknown, keys: readonly string[]): Record<string, string> & { readonly breakdown?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new IntakeError('intake_invalid_request', 'slicing request must be an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !keys.includes(key))) throw new IntakeError('intake_invalid_request', 'slicing request contains unsupported fields');
  for (const key of keys.filter((key) => key !== 'breakdown')) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '' || raw[key].length > 4096) throw new IntakeError('intake_invalid_request', `missing or invalid ${key}`);
  }
  return raw as Record<string, string>;
}

/** One planning minion per exact captured revision; its refinement has one
 * request id, so a retry converges instead of minting another. */
export function slicingIdentity(proposal: Pick<Proposal, 'projectKey' | 'intakeId' | 'revisionId'>): { readonly jobId: string; readonly resultRequestId: string } {
  const key = digest(canonical(['intake-slice', proposal.projectKey, proposal.intakeId, proposal.revisionId])).slice(0, 32);
  return { jobId: `intake-slice-${key}`, resultRequestId: `slice-${key}` };
}

/** Commissions a planning-only minion for an epic with no breakdown and
 * turns its breakdown into an intake refinement. It never approves, admits
 * or enqueues work: the owner's intake approval stays the only gate. */
export class IntakeSlicingService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly options: IntakeSlicingOptions) {}

  private exact(raw: Record<string, string>): Proposal {
    const proposal = this.options.intake.read(raw['repoPath']!, raw['intakeId']!, raw['requestId']!);
    if (proposal.revisionId !== raw['revisionId']) throw new IntakeError('intake_stale_revision', 'Slicing does not bind the exact captured proposal; read the revision again', 409);
    return proposal;
  }

  private helper(): { readonly id: string; readonly sha256: string; readonly text: string } {
    let runtime: BundledWorkflowRuntime;
    try { runtime = (this.options.workflow ?? loadBundledWorkflowRuntime)(); } catch (error) {
      throw new IntakeError('intake_workflow_unavailable', error instanceof Error ? error.message : String(error), 503);
    }
    const bytes = runtime.files.get(SLICING_HELPER);
    const sha256 = runtime.manifest.files[SLICING_HELPER];
    if (bytes === undefined || sha256 === undefined) throw new IntakeError('intake_workflow_unavailable', `the slicing helper ${SLICING_HELPER} is missing from the verified GC workflow package ${runtime.id}`, 503);
    return { id: runtime.id, sha256, text: bytes.toString('utf-8') };
  }

  private briefing(proposal: Proposal, resultRequestId: string, helper: ReturnType<IntakeSlicingService['helper']>): string {
    const api = this.options.apiBase?.() ?? null;
    const at = (path: string): string => `${api ?? '<the service API>'}${path}`;
    const binding = { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: proposal.requestId, revisionId: proposal.revisionId };
    return [
      `Planning-only heist (#429): slice captured intake ${proposal.intakeId} into ordered heists. The artifact you hand back is the accepted intake revision itself, not code, a file or a pull request: there is nothing to commit.`,
      '',
      'Binding (exact; never change it):',
      `- repoPath: ${proposal.repoPath}`,
      `- intakeId: ${proposal.intakeId}`,
      `- requestId: ${proposal.requestId} (the captured proposal you slice)`,
      `- revisionId: ${proposal.revisionId}`,
      `- result requestId: ${resultRequestId} (GC assigns it)`,
      '',
      'Steps:',
      `1. Read the captured proposal: GET ${at(`/api/intake/${encodeURIComponent(proposal.intakeId)}/requests/${encodeURIComponent(proposal.requestId)}?repoPath=${encodeURIComponent(proposal.repoPath)}`)}, authenticated with the [auth] token from the service's instance config (Authorization: Bearer; never print it).`,
      '2. Read the codebase of this worktree, then slice the epic by the GC slicing helper below.',
      `3. Submit: POST ${at('/api/intake/slice/result')} with ${JSON.stringify(binding).slice(0, -1)},"breakdown":<your breakdown>}. A 400 intake_invalid_plan says what to fix: fix it and submit again. A 200 returns the new revision.`,
      `4. End with a completion report naming result request ${resultRequestId}, its revisionId, the slice count and every open question.`,
      '',
      `GC slicing helper (${helper.id} ${SLICING_HELPER}, sha256 ${helper.sha256}):`,
      '',
      helper.text,
    ].join('\n');
  }

  async commission(value: unknown): Promise<IntakeSlicingCommission> {
    const raw = fields(value, ['repoPath', 'intakeId', 'requestId', 'revisionId']);
    const proposal = this.exact(raw);
    if (proposal.gaps.length > 0) throw new IntakeError('intake_incomplete_sources', `Resolve the ${proposal.gaps.length} captured source gap(s) with a new preview before slicing; a planning minion cannot slice unknown sources`, 409);
    if (proposal.requirements.length === 0) throw new IntakeError('intake_incomplete_sources', 'The captured proposal has no source lines to slice', 409);
    if (this.options.ledger.getApprovedIntakeReview(proposal.repoPath, proposal.intakeId, proposal.revisionId) !== null) throw new IntakeError('intake_slicing_approved', 'This revision already has accepted work; slicing it would plan that work twice', 409);
    const helper = this.helper();
    const { jobId, resultRequestId } = slicingIdentity(proposal);
    const commission = { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: proposal.requestId, revisionId: proposal.revisionId, jobId, resultRequestId };
    const status = (dispatched: boolean): IntakeSlicingCommission => {
      const job = this.options.ledger.getJob(jobId);
      if (job === null) throw new IntakeError('intake_slicing_dispatch_failed', `The dispatch returned without recording planning job ${jobId}; nothing is slicing this revision. Retry the identical request.`, 503);
      return { ...commission, dispatched, jobStatus: job.status };
    };
    if (this.options.ledger.getJob(jobId) !== null) return status(false);
    let pending = this.inflight.get(jobId);
    if (pending === undefined) {
      // The dispatcher records the job before its first await, so the
      // caller learns of the commission at once instead of waiting out the
      // worker gate. A later failure is the dispatcher's to record on the
      // job; it is logged once here, and a retry reports the job's status.
      pending = this.options.dispatch({ jobId, repoPath: proposal.repoPath, title: `Slice intake ${proposal.intakeId} into heists`, briefing: this.briefing(proposal, resultRequestId, helper), deliverable: 'investigation' })
        .finally(() => this.inflight.delete(jobId));
      pending.catch((error: unknown) => {
        // Detached: an unreadable ledger (closed at shutdown) must not become
        // an unhandled rejection, and the dispatch error is still logged.
        const detail = { job: jobId, error: error instanceof Error ? error.message : String(error) };
        let recorded: boolean | null = null;
        try { recorded = this.options.ledger.getJob(jobId) !== null; } catch { /* logged below without the job check */ }
        if (recorded !== false) this.options.log?.('error', recorded === true ? 'intake planning minion dispatch failed after its job was recorded' : 'intake planning minion dispatch failed; its job record could not be read', detail);
      });
      this.inflight.set(jobId, pending);
      if (this.options.ledger.getJob(jobId) !== null) return status(true);
    }
    try { await pending; } catch (error) {
      if (this.options.ledger.getJob(jobId) !== null) return status(true);
      throw new IntakeError('intake_slicing_dispatch_failed', `The planning minion was not dispatched: ${error instanceof Error ? error.message : String(error)}. Retry the identical request.`, 503);
    }
    return status(true);
  }

  /** The minion's breakdown becomes the refinement of the exact revision it
   * sliced. A breakdown refused by validation or the output bound writes
   * nothing under the result request; the identical one converges. */
  async submit(value: unknown): Promise<Proposal> {
    const raw = fields(value, ['repoPath', 'intakeId', 'requestId', 'revisionId', 'breakdown']);
    const proposal = this.exact(raw);
    const { jobId, resultRequestId } = slicingIdentity(proposal);
    // An identical retry of a landed breakdown converges below even after
    // approval; only a new sliced plan of approved work is refused.
    const landed = (): boolean => {
      try { this.options.intake.read(proposal.repoPath, proposal.intakeId, resultRequestId); return true; } catch (error) {
        if (error instanceof IntakeError && error.code === 'intake_not_found') return false;
        throw error;
      }
    };
    if (this.options.ledger.getApprovedIntakeReview(proposal.repoPath, proposal.intakeId, proposal.revisionId) !== null && !landed()) throw new IntakeError('intake_slicing_approved', 'The sliced revision gained accepted work after its planning minion was commissioned; a sliced plan of it would plan that work twice', 409);
    if (this.options.ledger.getJob(jobId) === null) throw new IntakeError('intake_slicing_not_commissioned', `No planning minion was commissioned for revision ${proposal.revisionId}; commission one with POST /api/intake/slice`, 409);
    const plan = slicingPlan(raw['breakdown'], proposal);
    validatePlan(plan, proposal);
    // revise() records its request before the proposal's output bound, so the
    // exact proposal it would publish is bounded here, leaving an oversized
    // plan's result request unwritten.
    const questions = [...new Set([...plan.questions, ...proposal.gaps.map(({ question }) => question), ...plan.unmapped.map(({ question }) => question)])];
    boundedCanonical({
      schemaVersion: 1, executable: false, projectKey: proposal.projectKey, repoPath: proposal.repoPath, intakeId: proposal.intakeId,
      requestId: resultRequestId, previousRequestId: proposal.requestId, workflow: proposal.workflow,
      snapshots: proposal.snapshots, gaps: proposal.gaps, requirements: proposal.requirements, plan: { ...plan, questions }, revisionId: '0'.repeat(64),
    }, INTAKE_MAX_OUTPUT_BYTES);
    const result = await this.options.intake.revise({ repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: resultRequestId, previousRequestId: proposal.requestId, revisionId: proposal.revisionId, plan });
    this.announce(result, jobId);
    return result;
  }

  private announce(result: Proposal, jobId: string): void {
    // plan.questions already holds every gap and unmapped question.
    const open = [...new Set([
      ...result.plan.questions,
      ...result.plan.heists.flatMap(({ id, unresolvedQuestions }) => unresolvedQuestions.map((question) => `${id}: ${question}`)),
    ])];
    const conflicts = open.filter((question) => /source conflict/iu.test(question));
    const rest = open.filter((question) => !conflicts.includes(question));
    const listed = [...conflicts, ...rest];
    this.options.notifications.post({
      id: `intake-slicing:${jobId}`,
      kind: INTAKE_SLICING_RESULT_KIND,
      routing: 'needs-owner',
      severity: 'info',
      title: conflicts.length > 0 ? `Sliced plan has ${conflicts.length} source conflict(s): ${result.intakeId}` : `Sliced plan ready for review: ${result.intakeId}`,
      detail: [
        `Planning minion ${jobId} sliced request ${result.previousRequestId ?? ''} into ${result.plan.heists.length} heist(s) as request ${result.requestId} (revision ${result.revisionId}).`,
        open.length === 0 ? 'It has no open questions.' : `${conflicts.length} source conflict(s) and ${rest.length} other open question(s) block approval until a refinement settles them:`,
        ...listed.slice(0, 20).map((question) => `- ${question}`),
        ...(listed.length > 20 ? [`- …and ${listed.length - 20} more in the proposal.`] : []),
        'Open Review source intake and load the sliced revision to review it. Which heists run, and how each conflict is settled, stays your call.',
      ].join('\n'),
    });
  }
}
