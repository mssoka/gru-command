import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReviewedCampaign } from '../cli/property-check.js';
import { isJobTerminal } from '../ledger/states.js';
import { oneLineErrorText } from '../property/error-text.js';
import type { LedgerApi } from '../ledger/api.js';
import { loadPropertyConfig } from '../property/config.js';
import { createPropertyExecutor, propertyWorkspaceIdentity } from '../property/executor.js';
import { createPropertyCampaignHost, isHostPropertyRepairDirective, type PropertyCampaignResult, type PropertyRepairDirective, type ReviewedPropertyCampaign } from '../property/pipeline.js';
import { buildSourceIdentity, propertyConfigIdentity, propertyGit } from '../property/receipts.js';
import { executeAcceptedDirective } from './directive-progress.js';
import type { DirectiveRoutingDeps } from './fix-directive.js';
import type { RecoveryNotifications } from './rebrief-recovery.js';
import type { WaveRunner } from './perkins.js';

/** An error as one bounded line of text, even when it cannot print. */
const printable = (error: unknown): string => oneLineErrorText(error, 300);

export class PropertyOwnerActionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'PropertyOwnerActionError'; }
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
  /** Process-local proposal retention (default 128; test seam). */
  readonly maxRetainedProposals?: number;
}
/** What the owner can do next with a campaign (#380): a machine-readable
 * `kind` plus accurate text. A failed entry is terminal: its allocation is
 * spent and its report may be stale. */
export type PropertyNextActionKind = 'decide-execute' | 'decide-repair' | 'decide-retain' | 'propose-again' | 'none';
export function nextAction(entry: Pick<Entry, 'state' | 'report'>): { readonly kind: PropertyNextActionKind; readonly detail: string } {
  const blocking = entry.report?.blocking === true;
  switch (entry.state) {
    case 'proposed': return { kind: 'decide-execute', detail: 'approve execution at the reviewed head, or leave it' };
    case 'executed': return blocking
      ? { kind: 'decide-repair', detail: 'approve a bounded repair, or keep the blocker for review' }
      : { kind: 'none', detail: 'no qualified blocker; review proceeds as usual' };
    case 'repaired': return blocking
      ? { kind: 'decide-repair', detail: 'the repair did not clear the blocker: approve another bounded repair, or keep the blocker for review' }
      : { kind: 'decide-retain', detail: 'approve retention of the reviewed regression, or leave it' };
    case 'retained': return { kind: 'none', detail: 'the reviewed regression is in the lane; commit and review it as usual' };
    case 'failed': return { kind: 'propose-again', detail: 'this entry is terminal: if it started a repair directive, let that settle through ordinary reconciliation first; then propose the reviewed campaign again at the current head' };
  }
}
/** Only settled entries that owe the owner no decision are ever evicted to
 * make room (#380): a pending proposal, an unresolved blocker or a repair
 * awaiting its retention decision is the owner's to decide. */
export function evictable(entry: Pick<Entry, 'state' | 'report'>): boolean {
  return entry.state === 'failed' || entry.state === 'retained' || (entry.state === 'executed' && entry.report?.blocking !== true);
}
/** The entry a full cache gives up for a new proposal (#380): the OLDEST
 * evictable one, the proposing job's own first, never the one being decided
 * right now; undefined when none may go. `entries` is in insertion order. */
export function evictionVictim<T extends Pick<Entry, 'id' | 'jobId' | 'state' | 'report'>>(entries: Iterable<T>, jobId: string, activeId: string | null): T | undefined {
  const candidates = [...entries].filter((entry) => evictable(entry) && entry.id !== activeId);
  return candidates.find((entry) => entry.jobId === jobId) ?? candidates[0];
}

/** How many evicted ids a service remembers; an older one reads as unknown. */
export const EVICTED_IDS_REMEMBERED = 1024;

/** Remembers an evicted id (bounded, oldest forgotten first) so a later read
 * says "evicted" by name rather than "unknown". */
export function rememberEvicted<V>(evicted: Map<string, V>, id: string, value: V, limit = EVICTED_IDS_REMEMBERED): void {
  evicted.delete(id);
  evicted.set(id, value);
  for (const oldest of evicted.keys()) {
    if (evicted.size <= limit) break;
    evicted.delete(oldest);
  }
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
  // The ONE campaign being decided right now (decide is single-flight), or null.
  let activeId: string | null = null;
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
  // Ids evicted to make room, kept (bounded) so a later read says so by name.
  const evictedIds = new Map<string, { readonly jobId: string; readonly artifactsDir: string }>();
  const get = (jobId: string, id: string): Entry => {
    const entry = entries.get(id);
    const gone = evictedIds.get(id);
    if (entry === undefined && gone !== undefined && gone.jobId === jobId) {
      throw new PropertyOwnerActionError(`campaign ${id} was evicted to make room for newer proposals; its audit files remain in ${gone.artifactsDir}; propose it again`);
    }
    if (entry === undefined || entry.jobId !== jobId) throw new PropertyOwnerActionError('no process-local campaign for this job/id; serialized reports cannot restore it');
    bind(jobId, entry.spec.candidateRoot);
    return entry;
  };
  const view = (entry: Entry) => clone({ id: entry.id, jobId: entry.jobId, candidateRoot: entry.spec.candidateRoot, candidateSha: entry.report?.candidateSha ?? entry.heads[2], state: entry.state, nextAction: nextAction(entry), reviewedSourceHeads: entry.heads, reviewedTreeDigests: entry.treeDigests, campaign: entry.spec, report: entry.report, retainedPaths: entry.retainedPaths, repairProposed: entry.report?.blocking === true && entry.state !== 'failed', mergeAuthority: 'none' as const });
  const maxRetainedProposals = options.maxRetainedProposals ?? 128;
  if (!Number.isSafeInteger(maxRetainedProposals) || maxRetainedProposals < 1 || maxRetainedProposals > 128) throw new Error('maxRetainedProposals must be 1..128');
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
      // Validate, bind and BUILD the new proposal first — and audit it —
      // so a malformed, unbound or unreadable proposal never costs a
      // retained campaign its slot.
      const spec = clone(parseReviewedCampaign(body.campaign));
      bind(jobId, spec.candidateRoot);
      const id = `campaign-${randomUUID()}`;
      const entry: Entry = { id, jobId, spec, heads: roots(spec).map(head), treeDigests: roots(spec).map((root) => propertyWorkspaceIdentity(root).digest), configHash: propertyConfigIdentity(spec.candidateRoot), artifactsDir: join(options.artifactsRoot, id), state: 'proposed', report: null, retainedPaths: [] };
      const victim = entries.size >= maxRetainedProposals ? evictionVictim(entries.values(), jobId, activeId) : undefined;
      if (entries.size >= maxRetainedProposals && victim === undefined) throw new PropertyOwnerActionError('process-local proposal retention limit reached: every retained campaign is a pending proposal, an unresolved blocker, a repair awaiting retention or the campaign being decided right now; decide those first');
      let evictionAudit: { readonly path: string; readonly victimId: string } | null = null;
      if (victim !== undefined) {
        // The eviction is audited beside the victim's own records FIRST —
        // before the new proposal leaves any record and before the victim
        // leaves memory: a failed write evicts and records nothing.
        const path = join(victim.artifactsDir, `owner-evicted-${randomUUID()}.json`);
        let madeDir: string | undefined;
        try {
          madeDir = mkdirSync(victim.artifactsDir, { recursive: true, mode: 0o700 });
          writeFileSync(path, `${JSON.stringify({ evicted: view(victim), byProposal: id }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          // Only what this call made is removed — a directory it created
          // (with its partial record), else its partial record; a record a
          // `wx` write found already there is never touched. Nothing is left
          // that claims an eviction, or what is left is named.
          const made = madeDir ?? ((error as NodeJS.ErrnoException).code === 'EEXIST' ? undefined : path);
          let partial = '';
          let cause: unknown = error;
          if (made !== undefined) {
            try { rmSync(made, { recursive: true, force: true }); } catch (removeError) {
              partial = ` (${made} could not be removed: ${printable(removeError)} — remove it by hand)`;
              cause = new AggregateError([error, removeError], 'eviction audit and its cleanup failed');
            }
          }
          throw new PropertyOwnerActionError(`the cache is full and campaign ${victim.id} could not be evicted: its audit could not be written in ${victim.artifactsDir} (${printable(error)}); fix that directory, or decide a pending campaign, then propose again${partial}`, { cause });
        }
        evictionAudit = { path, victimId: victim.id };
      }
      try {
        audit(entry);
      } catch (error) {
        // The new proposal was never admitted: its victim was never evicted,
        // so the eviction record is withdrawn with it, and whatever the
        // failed audit left under the proposal's fresh directory goes too. A
        // cleanup that fails itself fails loud, carrying the original error.
        // Only what is still on disk is named for removal by hand.
        const cleanup: unknown[] = [];
        const leftovers: string[] = [];
        if (evictionAudit !== null) {
          try { rmSync(evictionAudit.path, { force: true }); } catch (withdrawError) { cleanup.push(withdrawError); leftovers.push(`${evictionAudit.path} (campaign ${evictionAudit.victimId} was not evicted)`); }
        }
        try { rmSync(entry.artifactsDir, { recursive: true, force: true }); } catch (removeError) { cleanup.push(removeError); leftovers.push(entry.artifactsDir); }
        if (cleanup.length > 0) {
          throw new PropertyOwnerActionError(`proposal ${id} could not be recorded (${printable(error)}) and its cleanup failed: ${cleanup.map(printable).join('; ')} — remove ${leftovers.join(' and ')} by hand`, { cause: new AggregateError([error, ...cleanup], 'proposal record and cleanup failed') });
        }
        throw error;
      }
      if (victim !== undefined) {
        entries.delete(victim.id);
        rememberEvicted(evictedIds, victim.id, { jobId: victim.jobId, artifactsDir: victim.artifactsDir });
      }
      entries.set(id, entry); return view(entry);
    },
    read(jobId: string, id: string) { return view(get(jobId, id)); },
    async decide(jobId: string, id: string, action: 'execute' | 'repair' | 'retain', body: Record<string, unknown>) {
      const entry = get(jobId, id);
      keys(body, ['decision', 'expectedHead', ...(action === 'execute' ? ['approvedRepairAttempts'] : action === 'repair' ? ['maxAttempts'] : [])]);
      if (body.decision === undefined || body.decision === 'propose') return { ...view(entry), proposedAction: action };
      if (body.decision !== 'approve') throw new PropertyOwnerActionError('decision must be propose or approve');
      const expected = entry.report?.candidateSha ?? entry.heads[2];
      if (typeof body.expectedHead !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(body.expectedHead) || body.expectedHead !== expected || head(entry.spec.candidateRoot) !== expected) throw new PropertyOwnerActionError('approval must name this exact current candidate head');
      if (activeId !== null || disposed) throw new PropertyOwnerActionError('property host busy/disposed; no concurrent allocation');
      idle(jobId, entry.spec.candidateRoot);
      activeId = entry.id;
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
      finally { release?.(); activeId = null; settled = null; resolveSettlement(); }
    },
    async dispose() { disposed = true; hostController.abort(); for (const controller of controllers) controller.abort(); await settled; },
  };
}
export type PropertyCampaignService = ReturnType<typeof createPropertyCampaignService>;
