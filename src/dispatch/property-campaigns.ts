import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReviewedCampaign } from '../cli/property-check.js';
import { isJobTerminal } from '../ledger/states.js';
import type { LedgerApi } from '../ledger/api.js';
import { loadPropertyConfig } from '../property/config.js';
import { createPropertyExecutor, propertyWorkspaceIdentity } from '../property/executor.js';
import { createPropertyCampaignHost, isHostPropertyRepairDirective, type PropertyCampaignResult, type PropertyRepairDirective, type ReviewedPropertyCampaign } from '../property/pipeline.js';
import { buildSourceIdentity, propertyConfigIdentity, propertyGit } from '../property/receipts.js';
import { executeAcceptedDirective } from './directive-progress.js';
import type { DirectiveRoutingDeps } from './fix-directive.js';
import type { RecoveryNotifications } from './rebrief-recovery.js';
import type { WaveRunner } from './perkins.js';

export class PropertyOwnerActionError extends Error {
  constructor(message: string) { super(message); this.name = 'PropertyOwnerActionError'; }
}
interface Entry {
  readonly id: string;
  readonly jobId: string;
  readonly spec: ReviewedPropertyCampaign;
  readonly heads: readonly string[];
  readonly treeDigests: readonly string[];
  readonly configHash: string | null;
  readonly artifactsDir: string;
  state: 'proposed' | 'executed' | 'repaired' | 'retained' | 'failed';
  report: PropertyCampaignResult | null;
  retainedPaths: readonly string[];
}
export interface PropertyCampaignServiceOptions extends DirectiveRoutingDeps {
  readonly ledger: LedgerApi;
  readonly wave: Pick<WaveRunner, 'assertWriterAdmissible' | 'clearLaneForWriter'>;
  readonly notifications: RecoveryNotifications;
  readonly artifactsRoot: string;
  readonly pendingProducerBlockers: (jobId: string) => readonly string[];
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function head(root: string): string {
  const source = buildSourceIdentity(root);
  if (source.kind !== 'clean-sha') throw new PropertyOwnerActionError('owner action needs clean committed candidate/control bytes');
  return source.sha;
}
function roots(spec: ReviewedPropertyCampaign): readonly string[] { return [spec.knownBadRoot, spec.healthyRoot, spec.candidateRoot, ...(spec.baselineRoot === null ? [] : [spec.baselineRoot])]; }
function keys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new PropertyOwnerActionError(`only ${allowed.join(', ')} accepted; reports, commands and install requests never grant authority`);
}
function attempts(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 3) throw new PropertyOwnerActionError('owner-approved repair allocation must be 1..3');
  return value as number;
}
/** ONE service instance owns ONE campaign host. Audit files are never loaded
 * as issuance; restart requires new reviewed proposals and explicit approval.
 * No reviewer native tool invokes this owner-only surface. */
export function createPropertyCampaignService(options: PropertyCampaignServiceOptions, suppliedHost?: ReturnType<typeof createPropertyCampaignHost>) {
  const hostController = new AbortController();
  const host = suppliedHost ?? createPropertyCampaignHost(createPropertyExecutor({ signal: hostController.signal }));
  const entries = new Map<string, Entry>();
  const controllers = new Set<AbortController>();
  let active = false;
  let settled: Promise<void> | null = null;
  let disposed = false;
  const bind = (jobId: string, root: string): void => {
    const job = options.ledger.getJob(jobId);
    const lane = options.worktrees.getWorktree(jobId);
    if (job === null || isJobTerminal(job.status) || lane?.kind !== 'job' || lane.jobId !== jobId || lane.status !== 'active' || lane.branch === null || realpathSync(lane.path) !== realpathSync(root) || propertyGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() !== lane.branch) throw new PropertyOwnerActionError('campaign candidate must be the active managed job lane of this nonterminal job');
  };
  const idle = (jobId: string, root: string): void => {
    bind(jobId, root);
    const busy = options.ledger.listImplementerMinions(jobId).some((agent) => {
      const handle = options.registry.getHandle(agent.id);
      return handle === null ? agent.state === 'streaming' || agent.state === 'spawning' : handle.health().state !== 'idle' || handle.hasLiveProcess?.() === true || handle.isCompacting?.() === true;
    });
    if (busy || options.pendingProducerBlockers(jobId).length > 0 || options.ledger.listJobAdmissions(jobId).length > 0 || options.ledger.listPendingDirectives({ jobId, states: ['dispatching', 'admitted'] }).length > 0 || options.ledger.listPendingRebriefs({ jobId }).length > 0 || options.ledger.hasUnsettledVerificationRun(jobId)) throw new PropertyOwnerActionError('job lane has an active or unresolved minion, producer, directive, re-brief or verification; settle it before property execution/writing');
  };
  const get = (jobId: string, id: string): Entry => {
    const entry = entries.get(id);
    if (entry === undefined || entry.jobId !== jobId) throw new PropertyOwnerActionError('no process-local campaign for this job/id; serialized reports cannot restore it');
    bind(jobId, entry.spec.candidateRoot);
    return entry;
  };
  const view = (entry: Entry) => clone({ id: entry.id, jobId: entry.jobId, candidateRoot: entry.spec.candidateRoot, candidateSha: entry.report?.candidateSha ?? entry.heads[2], state: entry.state, reviewedSourceHeads: entry.heads, reviewedTreeDigests: entry.treeDigests, campaign: entry.spec, report: entry.report, retainedPaths: entry.retainedPaths, repairProposed: entry.report?.blocking === true && entry.state !== 'failed', mergeAuthority: 'none' as const });
  const audit = (entry: Entry): void => {
    mkdirSync(entry.artifactsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(entry.artifactsDir, `owner-${entry.state}-${randomUUID()}.json`), `${JSON.stringify(view(entry), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  };
  const consumedDirectives = new WeakSet<PropertyRepairDirective>();
  const repair = async (entry: Entry, maxAttempts: number): Promise<void> => {
    const report = entry.report;
    if (report === null || !report.blocking) throw new PropertyOwnerActionError('repair needs this process\'s unresolved qualified enforced report');
    // Durable single-writer ownership stays live through ALL native turns
    // and frozen-oracle validation, not just through the first minion turn.
    options.wave.assertWriterAdmissible(entry.jobId);
    const admissionKind = `property repair ${entry.id}`;
    const release = options.ledger.beginJobAdmission(entry.jobId, admissionKind);
    const controller = new AbortController(); controllers.add(controller);
    try {
      await options.wave.clearLaneForWriter({ jobId: entry.jobId, writer: admissionKind });
      bind(entry.jobId, entry.spec.candidateRoot);
      if (head(entry.spec.candidateRoot) !== report.candidateSha) throw new PropertyOwnerActionError('candidate moved while repair admission waited; requalify');
      // Each host-issued directive is an ordinary durable directive request
      // executed by the same native-admission path as every other directive
      // (adapter-owned admission, producer fences, settlement, recovery).
      const deliver = async (issued: PropertyRepairDirective): Promise<void> => {
        if (!isHostPropertyRepairDirective(issued) || consumedDirectives.has(issued)) throw new PropertyOwnerActionError('property repair refused: unissued, changed or already delivered directive');
        consumedDirectives.add(issued);
        const intent = options.ledger.beginDirectiveIntent({ jobId: entry.jobId, directive: issued.text, holder: 'property-contract-repair' }).record;
        await executeAcceptedDirective({ registry: options.registry, ledger: options.ledger, worktrees: options.worktrees, notifications: options.notifications,
          pendingProducerBlockers: options.pendingProducerBlockers, signal: controller.signal, ownAdmissionKinds: [admissionKind],
          ...(options.workerGate !== undefined ? { workerGate: options.workerGate } : {}),
          ...(options.retrySettlement !== undefined ? { retrySettlement: options.retrySettlement } : {}),
          ...(options.observeBlindTurn !== undefined ? { observeBlindTurn: options.observeBlindTurn } : {}),
          ...(options.lessons !== undefined ? { lessons: options.lessons } : {}),
          ...(options.parentTools !== undefined ? { parentTools: options.parentTools } : {}) }, intent.requestId);
        const state = options.ledger.getDirective(intent.requestId)?.state;
        if (state !== 'settled') throw new PropertyOwnerActionError(`repair directive ${intent.requestId} did not settle (state ${String(state)}); no clearance, reconcile it through the ordinary directive path`);
      };
      entry.report = await host.repair(report, deliver, { artifactsDir: entry.artifactsDir, maxAttempts });
      bind(entry.jobId, entry.spec.candidateRoot);
      if (head(entry.spec.candidateRoot) !== entry.report.candidateSha) throw new PropertyOwnerActionError('validated repair head moved before delivery; no clearance');
      entry.state = 'repaired';
    } finally { controllers.delete(controller); release(); }
  };
  return {
    propose(jobId: string, body: Record<string, unknown>) {
      if (disposed) throw new PropertyOwnerActionError('property campaign service disposed');
      keys(body, ['campaign']);
      if (entries.size >= 128) throw new PropertyOwnerActionError('process-local proposal retention limit reached; no automatic eviction of blockers');
      const spec = clone(parseReviewedCampaign(body.campaign));
      bind(jobId, spec.candidateRoot);
      const id = `campaign-${randomUUID()}`;
      const entry: Entry = { id, jobId, spec, heads: roots(spec).map(head), treeDigests: roots(spec).map((root) => propertyWorkspaceIdentity(root).digest), configHash: propertyConfigIdentity(spec.candidateRoot), artifactsDir: join(options.artifactsRoot, id), state: 'proposed', report: null, retainedPaths: [] };
      entries.set(id, entry); audit(entry); return view(entry);
    },
    read(jobId: string, id: string) { return view(get(jobId, id)); },
    async decide(jobId: string, id: string, action: 'execute' | 'repair' | 'retain', body: Record<string, unknown>) {
      const entry = get(jobId, id);
      keys(body, ['decision', 'expectedHead', ...(action === 'execute' ? ['approvedRepairAttempts'] : action === 'repair' ? ['maxAttempts'] : [])]);
      if (body.decision === undefined || body.decision === 'propose') return { ...view(entry), proposedAction: action };
      if (body.decision !== 'approve') throw new PropertyOwnerActionError('decision must be propose or approve');
      const expected = entry.report?.candidateSha ?? entry.heads[2];
      if (typeof body.expectedHead !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(body.expectedHead) || body.expectedHead !== expected || head(entry.spec.candidateRoot) !== expected) throw new PropertyOwnerActionError('approval must name this exact current candidate head');
      if (active || disposed) throw new PropertyOwnerActionError('property host busy/disposed; no concurrent allocation');
      idle(jobId, entry.spec.candidateRoot);
      active = true;
      let resolveSettlement!: () => void;
      settled = new Promise<void>((resolve) => { resolveSettlement = resolve; });
      let release: (() => void) | null = null;
      try {
        if (action === 'execute') {
          if (entry.state !== 'proposed' || JSON.stringify(roots(entry.spec).map(head)) !== JSON.stringify(entry.heads) || JSON.stringify(roots(entry.spec).map((root) => propertyWorkspaceIdentity(root).digest)) !== JSON.stringify(entry.treeDigests) || propertyConfigIdentity(entry.spec.candidateRoot) !== entry.configHash) throw new PropertyOwnerActionError('proposal source/config moved or execution allocation spent; propose and review again');
          const automaticAttempts = body.approvedRepairAttempts === undefined ? 0 : attempts(body.approvedRepairAttempts);
          release = options.ledger.beginJobAdmission(jobId, `property campaign ${id}`);
          // Approval originates HERE, in this service process, after the
          // authenticated owner's exact-head decision. No JSON is issuance.
          entry.report = await host.execute(host.approveReviewedCampaign(entry.spec), { artifactsDir: entry.artifactsDir, trigger: 'pull-request' });
          entry.state = 'executed';
          release(); release = null;
          if (entry.report.blocking && automaticAttempts > 0 && loadPropertyConfig(entry.spec.candidateRoot)?.automation === 'approved-repair') {
            idle(jobId, entry.spec.candidateRoot);
            await repair(entry, automaticAttempts);
          }
        } else if (action === 'repair') {
          await repair(entry, attempts(body.maxAttempts));
        } else {
          options.wave.assertWriterAdmissible(jobId);
          release = options.ledger.beginJobAdmission(jobId, `property retention ${id}`);
          await options.wave.clearLaneForWriter({ jobId, writer: `reviewed property regression retention ${id}` });
          bind(jobId, entry.spec.candidateRoot);
          if (entry.report === null || head(entry.spec.candidateRoot) !== expected) throw new PropertyOwnerActionError('retention needs the exact reviewed host repair, not a supplied report');
          entry.retainedPaths = host.retainReviewedRegression(entry.report);
          entry.state = 'retained';
        }
        audit(entry); return view(entry);
      } catch (error) { entry.state = 'failed'; audit(entry); throw error; }
      finally { release?.(); active = false; settled = null; resolveSettlement(); }
    },
    async dispose() { disposed = true; hostController.abort(); for (const controller of controllers) controller.abort(); await settled; },
  };
}
export type PropertyCampaignService = ReturnType<typeof createPropertyCampaignService>;
