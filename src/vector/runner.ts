import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VECTOR_MAX_RUNS_PER_ATTACK, type VectorConfig } from '../config.js';
import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { loadPropertyConfig } from '../property/config.js';
import { createPropertyExecutor, resolveSandboxBackend } from '../property/executor.js';
import { createPropertyCampaignHost, type PropertyCampaignResult, type ReviewedPropertyCampaign } from '../property/pipeline.js';
import { parsePropertyProposal } from '../property/proposal.js';
import { resolvePropertyCapabilities } from '../property/resolve.js';
import type { PackageResolution, RetainedCounterexample } from '../property/types.js';
import type { PacingGateView, PacingLease } from '../runtime/pacing.js';
import type { AgentHandle, IsolatedReviewPolicy } from '../runtime/types.js';
import { loadWorktreeManifest } from '../worktrees/manifest.js';
import { renderRoundPrompt, VECTOR_SYSTEM_PROMPT, vectorAttackTool, type Attack, type AttackFile } from './attack.js';
import { RAID_ADAPTER } from './candidates.js';
import { repositoryRollups, VECTOR_EVENTS, VectorLedger, type BreakInRecord, type RaidMetrics, type RaidOutcome, type RaidRecord, type RoundOutcome } from './ledger.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Vector's raids, running half (#351 §3–5). Silas's raid queue: one raid per
 * host, never while heist work waits, yielding at the next round boundary
 * when heist work arrives. Each round Vector (read-only) proposes one
 * attack; the host qualifies it against its known-bad and reference
 * controls, runs it against the default-branch head in the sandbox, and
 * counts a break-in only after a fresh replay reproduces the failure.
 * Raids gate nothing and edit no product code: every root is a throwaway
 * clone, and no outcome is ever a pass.
 */

/** Board activity: a raid ended (its label says how). */
export const RAID_FINISHED_KIND = 'vector.raid-finished';

/** The most one attack can cost: both controls, the attack, then the baseline and the replay when it fails. */
export const MAX_RUNS_PER_ATTACK = VECTOR_MAX_RUNS_PER_ATTACK;

/** One reviewed attack campaign, host evidence only (seam B/C). */
export interface RaidCampaign {
  run(spec: ReviewedPropertyCampaign, artifactsDir: string): Promise<PropertyCampaignResult>;
  /** The attack run's retained counterexample, when it kept one. */
  counterexample(result: PropertyCampaignResult): RetainedCounterexample | null;
}

/** Production campaign: a per-raid executor and host (#350 seams B and C, unchanged). */
export function defaultRaidCampaign(signal: AbortSignal): RaidCampaign {
  const executor = createPropertyExecutor({ signal });
  const host = createPropertyCampaignHost(executor);
  return {
    run: (spec, artifactsDir) => host.execute(host.approveReviewedCampaign(spec), { artifactsDir, trigger: 'scheduled' }),
    counterexample: (result) => (result.candidateRef === null ? null : executor.resolveReceiptRef(result.candidateRef)?.counterexample ?? null),
  };
}

/** Heist work is waiting: a queued worker turn, or a queued review turn that is not Vector's own. */
export function heistWorkWaiting(view: PacingGateView): boolean {
  return view.worker.queued.length > 0 || view.review.queued.some((entry) => !entry.id.startsWith('vector:'));
}

export function raidOutcomeLabel(outcome: RaidOutcome, detail: string, attacks: number): string {
  switch (outcome) {
    case 'found': return 'Vector broke in';
    case 'budget-exhausted': return `Raid over: no break-in found in ${String(attacks)} attack${attacks === 1 ? '' : 's'} — not proof the code is safe`;
    case 'no-qualified-proposals': return 'Raid over: no attack survived qualification';
    // The detail keeps the executor's own `not-run:` word; the label says it once.
    case 'refused': return `Raid not run: ${detail.replace(/^not-run: /u, '')}`;
    case 'unsupported': return `Raid not run: target unsupported (${detail})`;
    case 'infrastructure-error': return `Raid failed: ${detail}`;
    case 'yielded': return 'Raid stopped for heist work';
    case 'invalidated': return 'Raid void: main moved during the raid';
  }
}

export interface RaidRunnerOptions {
  readonly vector: VectorConfig;
  readonly workspaceRoot: string;
  readonly ledger: LedgerApi;
  /** Where raid roots, evidence and reports live (<data_dir>/vector/raids). */
  readonly raidsDir: string;
  /** Spawn Vector on Perkins's read-only role with this isolated policy. */
  readonly spawnVector: (input: { readonly raidId: string; readonly policy: IsolatedReviewPolicy; readonly cwd: string; readonly signal: AbortSignal }) => Promise<AgentHandle>;
  readonly disposeVector: (handle: AgentHandle) => Promise<void>;
  /** The shared pacing path every role uses (src/runtime/pacing.ts). */
  readonly acquireTurn?: (input: { readonly id: string; readonly label: string; readonly signal: AbortSignal }) => Promise<PacingLease>;
  /** Heist work is queued (workers or reviews). Raids never start then, and yield to it. */
  readonly heistWorkWaiting: () => boolean;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  /** Called once per confirmed break-in (fix proposals and heists). */
  readonly onBreakIn?: (breakIn: BreakInRecord) => void;
  readonly campaign?: (signal: AbortSignal) => RaidCampaign;
  readonly sandbox?: () => { readonly backend: string; readonly reason: string | null };
  /** Refresh the cached origin default branch (default: a bounded `git fetch origin` with the user's own git setup). */
  readonly fetchDefault?: (repoPath: string) => void;
  /** The file operations that write controls into a clone (test seam for host faults; default: node:fs). */
  readonly controlFs?: ControlFs;
  readonly resolvePackages?: (repoPath: string) => readonly PackageResolution[];
  readonly now?: () => Date;
  readonly log?: Log;
  readonly tickIntervalMs?: number;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  /** The raid's wall-clock deadline timer (test seam). */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/** The file operations commitControl uses on a clone. */
export interface ControlFs {
  readonly lstat: (path: string) => { isSymbolicLink(): boolean; isDirectory(): boolean };
  readonly writeFile: (path: string, content: string) => void;
}

const NODE_CONTROL_FS: ControlFs = { lstat: (path) => lstatSync(path), writeFile: (path, content) => writeFileSync(path, content) };

/** Git for raid roots: no hooks, no fsmonitor, no user config, a fixed identity for control commits; the host's own PATH. */
function raidGit(cwd: string, args: readonly string[], timeoutMs = 120_000): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Vector', '-c', 'user.email=vector@gru-command.invalid', ...args], {
    cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
}

/** A fetch needs the user's own credential helpers and ssh setup; hooks stay off. */
function fetchOrigin(repoPath: string): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'fetch', '--quiet', 'origin'], { cwd: repoPath, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function cachedDefaultHead(repoPath: string): string | null {
  try {
    return raidGit(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD^{commit}'], 10_000).trim() || null;
  } catch {
    return null;
  }
}

function packageTree(repoPath: string, headSha: string, packageDir: string): string | null {
  try {
    return raidGit(repoPath, ['rev-parse', '--verify', '--quiet', packageDir === '.' ? `${headSha}^{tree}` : `${headSha}:${packageDir}`], 10_000).trim() || null;
  } catch {
    return null;
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A control write failed because of the path the attack chose (under a file, onto a directory, too long), not the host. */
export function isAttackPathFault(code: string | undefined): boolean {
  // mkdir onto an existing file reports EEXIST (macOS) or ENOTDIR (Linux).
  return code === 'ENOTDIR' || code === 'EEXIST' || code === 'EISDIR' || code === 'ENAMETOOLONG';
}
const oneLineError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);

class RaidStop extends Error {
  constructor(readonly outcome: RaidOutcome, readonly detail: string) {
    super(detail);
    this.name = 'RaidStop';
  }
}

interface RaidContext {
  readonly raid: RaidRecord;
  readonly repoPath: string;
  readonly raidDir: string;
  readonly headSha: string;
  readonly startedMs: number;
  rounds: number;
  /** Attacks that reached qualification. */
  attacks: number;
  qualified: number;
  inconclusive: number;
  invalidAttacks: number;
  duplicates: number;
  runs: number;
  executionMs: number;
  tokens: number;
  roundsWithoutTokenUsage: number;
  breakIns: number;
  readonly verdicts: Record<string, number>;
  replayed: number;
  reproduced: number;
  /** A fetch failed at some boundary: the head's freshness is unverified. */
  fetchFailed: boolean;
  timedOut: boolean;
}

export class VectorRaidRunner {
  private readonly store: VectorLedger;
  private readonly log: Log;
  private readonly now: () => Date;
  private running: Promise<string | null> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stopController = new AbortController();

  constructor(private readonly opts: RaidRunnerOptions) {
    this.log = opts.log ?? (() => {});
    this.store = new VectorLedger(opts.ledger, this.log);
    this.now = opts.now ?? (() => new Date());
  }

  /** Boot: close out raids a previous process left running, then poll the queue. */
  start(): void {
    if (!this.opts.vector.enabled || this.timer !== null) return;
    for (const raid of this.store.raids().filter((entry) => entry.state === 'running')) {
      this.finishWith(raid, 'infrastructure-error', 'the service stopped mid-raid; nothing from that raid counts', null);
    }
    this.timer = (this.opts.setInterval ?? setInterval)(() => { void this.tick(); }, this.opts.tickIntervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopController.abort();
    if (this.timer !== null) {
      (this.opts.clearInterval ?? clearInterval)(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run the oldest queued raid whose repository is under its daily cap, when
   * the host is free. Resolves with its id, or null.
   */
  tick(): Promise<string | null> {
    if (this.running !== null || !this.opts.vector.enabled || this.stopController.signal.aborted) return Promise.resolve(null);
    if (this.opts.heistWorkWaiting()) return Promise.resolve(null);
    const raids = this.store.raids();
    const now = this.now();
    // Started raids count toward the cap; a queued raid only waits for room.
    const startedToday = (repo: string): number => raids.filter((raid) => raid.target.repo === repo && raid.startedAt !== null && now.getTime() - Date.parse(raid.startedAt) < 86_400_000).length;
    const next = raids.filter((raid) => raid.state === 'queued' && startedToday(raid.target.repo) < this.opts.vector.maxRaidsPerDay)
      .sort((left, right) => Date.parse(left.launchedAt ?? left.pickedAt) - Date.parse(right.launchedAt ?? right.pickedAt))[0];
    if (next === undefined) return Promise.resolve(null);
    this.running = this.run(next).then(() => next.id, (error: unknown) => {
      this.log('error', 'vector raid runner failed', { raid: next.id, error: oneLineError(error) });
      return next.id;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async run(raid: RaidRecord): Promise<void> {
    const repoPath = join(this.opts.workspaceRoot, raid.target.repo);
    const sandbox = (this.opts.sandbox ?? resolveSandboxBackend)();
    if (sandbox.backend === 'none-found') {
      // The executor's own word for this is `not-run`: nothing executes.
      this.finishWith(raid, 'refused', `not-run: no sandbox backend on this host (${sandbox.reason ?? 'none found'}); a worktree is not a sandbox`, null);
      return;
    }
    // The repository may have opted out, or turned property execution off, since the pick.
    let optedOut: string | null = null;
    try {
      if (loadWorktreeManifest(repoPath)?.vector?.enabled === false) optedOut = 'the repository opted out ([vector] enabled = false in .gru-command/worktree.toml)';
      else if ((loadPropertyConfig(repoPath)?.mode ?? 'disabled') === 'disabled') optedOut = 'property execution is disabled in the repository (.gru-command/property.toml)';
    } catch (error) {
      optedOut = `the repository configuration does not load: ${oneLineError(error)}`;
    }
    if (optedOut !== null) {
      this.finishWith(raid, 'refused', optedOut, null);
      return;
    }
    const fetchFailed = !this.fetch(repoPath);
    const headSha = cachedDefaultHead(repoPath);
    if (headSha === null) {
      this.finishWith(raid, 'infrastructure-error', 'the default branch cannot be resolved (refs/remotes/origin/HEAD)', null);
      return;
    }
    const tree = packageTree(repoPath, headSha, raid.target.packageDir);
    if (tree !== raid.sourceIdentity) {
      this.finishWith(raid, 'invalidated', `main moved before the raid started: the package is ${tree === null ? 'gone' : `now ${tree.slice(0, 12)}`}, not the picked ${raid.sourceIdentity.slice(0, 12)}`, null);
      return;
    }
    const raidDir = join(this.opts.raidsDir, raid.id);
    const ctx: RaidContext = { raid, repoPath, raidDir, headSha, startedMs: this.now().getTime(), rounds: 0, attacks: 0, qualified: 0, inconclusive: 0, invalidAttacks: 0, duplicates: 0,
      runs: 0, executionMs: 0, tokens: 0, roundsWithoutTokenUsage: 0, breakIns: 0, verdicts: {}, replayed: 0, reproduced: 0, fetchFailed, timedOut: false };
    const abort = new AbortController();
    const onStop = (): void => abort.abort();
    this.stopController.signal.addEventListener('abort', onStop, { once: true });
    if (this.stopController.signal.aborted) abort.abort();
    const deadline = (this.opts.setTimeout ?? setTimeout)(() => { ctx.timedOut = true; abort.abort(); }, Math.max(1, this.opts.vector.maxRaidMs));
    deadline.unref?.();
    const roots = { target: join(raidDir, 'target'), knownBad: join(raidDir, 'known-bad'), healthy: join(raidDir, 'healthy') };
    try {
      mkdirSync(raidDir, { recursive: true });
      this.store.record(VECTOR_EVENTS.started, { raid_id: raid.id, head_sha: headSha });
      for (const root of Object.values(roots)) this.makeRoot(repoPath, root, headSha, raid.target.packageDir);
      const row = (this.opts.resolvePackages ?? ((root: string) => resolvePropertyCapabilities({ repoRoot: root }).packages))(roots.target)
        .find((entry) => entry.packageDir === raid.target.packageDir);
      if (row === undefined || row.status !== 'resolved' || row.adapterId !== RAID_ADAPTER || row.tooling?.executable !== true) {
        throw new RaidStop('unsupported', row === undefined ? 'the package is not discovered at this head' : `${row.adapterId ?? 'no adapter'}: ${[row.status, ...row.reasons].join('; ')}`);
      }
      const campaign = (this.opts.campaign ?? defaultRaidCampaign)(abort.signal);
      for (;;) {
        this.boundary(ctx, abort.signal);
        ctx.rounds += 1;
        await this.round(ctx, roots, campaign, abort.signal);
        if (ctx.breakIns > 0) throw new RaidStop('found', `break-in confirmed by a fresh replay in round ${String(ctx.rounds)}`);
      }
    } catch (error) {
      if (error instanceof RaidStop) this.finishWith(raid, error.outcome, error.detail, ctx);
      else if (ctx.timedOut) this.finishWith(raid, 'budget-exhausted', `the ${String(Math.round(this.opts.vector.maxRaidMs / 60_000))}-minute raid time cap ran out (the round in flight ended with: ${oneLineError(error)})`, ctx);
      else this.finishWith(raid, 'infrastructure-error', this.stopController.signal.aborted ? `the service is stopping (${oneLineError(error)})` : oneLineError(error), ctx);
    } finally {
      (this.opts.clearTimeout ?? clearTimeout)(deadline);
      this.stopController.signal.removeEventListener('abort', onStop);
      for (const root of Object.values(roots)) rmSync(root, { recursive: true, force: true });
    }
  }

  /** Round-boundary checks: every budget dimension, heist priority, and main. */
  private boundary(ctx: RaidContext, signal: AbortSignal): void {
    const v = this.opts.vector;
    // Every budget dimension ends the raid as budget-exhausted (#351).
    const exhausted = (why: string): RaidStop => new RaidStop('budget-exhausted', why);
    if (this.stopController.signal.aborted) throw new RaidStop('infrastructure-error', 'the service is stopping');
    if (ctx.timedOut || this.now().getTime() - ctx.startedMs >= v.maxRaidMs) throw exhausted(`the ${String(Math.round(v.maxRaidMs / 60_000))}-minute raid time cap ran out`);
    if (signal.aborted) throw new RaidStop('infrastructure-error', 'the raid was aborted');
    if (ctx.rounds >= v.maxRounds) throw exhausted(`all ${String(v.maxRounds)} attacks were spent`);
    if (ctx.runs + MAX_RUNS_PER_ATTACK > v.maxRuns) throw exhausted(`${String(v.maxRuns - ctx.runs)} of ${String(v.maxRuns)} sandboxed runs left, fewer than one attack may need (${String(MAX_RUNS_PER_ATTACK)})`);
    if (ctx.tokens >= v.maxRaidTokens) throw exhausted(`the ${String(v.maxRaidTokens)}-token cap was reached`);
    if (this.opts.heistWorkWaiting()) throw new RaidStop('yielded', 'heist work arrived; Gru may pick this target again later');
    if (!this.fetch(ctx.repoPath)) ctx.fetchFailed = true;
    if (cachedDefaultHead(ctx.repoPath) !== ctx.headSha) throw new RaidStop('invalidated', 'main moved during the raid; no evidence crosses heads');
  }

  private recordRound(ctx: RaidContext, fields: { readonly outcome: RoundOutcome; readonly verdict: string; readonly description?: string | null; readonly detail: string;
    readonly artifactSha256?: string | null; readonly candidateOutcome?: string | null; readonly replay?: string | null; readonly executedRuns?: number; readonly receipts?: readonly string[] }): void {
    const receipts = fields.receipts ?? [];
    this.store.record(VECTOR_EVENTS.round, {
      raid_id: ctx.raid.id, round: ctx.rounds, outcome: fields.outcome, verdict: fields.verdict, description: fields.description ?? null, detail: fields.detail,
      artifact_sha256: fields.artifactSha256 ?? null, candidate_outcome: fields.candidateOutcome ?? null, replay: fields.replay ?? null,
      executed_runs: fields.executedRuns ?? 0, receipts,
      ...(receipts.length > 0 ? {} : { no_receipt_reason: fields.executedRuns === undefined || fields.executedRuns === 0 ? `not executed: the round ended ${fields.outcome}` : 'executed, but the host kept no receipt file for it' }),
    });
  }

  private async round(ctx: RaidContext, roots: { readonly target: string; readonly knownBad: string; readonly healthy: string }, campaign: RaidCampaign, signal: AbortSignal): Promise<void> {
    const raid = ctx.raid;
    const prefix = raid.target.packageDir === '.' ? '' : `${raid.target.packageDir}/`;
    const testPath = `${prefix}test/vector/r${String(ctx.rounds)}-${raid.id.slice(-8)}.test.mjs`;
    const tried = this.store.raid(raid.id)!.rounds.map((entry) => entry.description).filter((entry): entry is string => entry !== null);
    const known = this.store.breakIns().filter((entry) => entry.target.repo === raid.target.repo && entry.target.packageDir === raid.target.packageDir).map((entry) => entry.invariant);
    const attack = await this.askVector(ctx, roots.target, renderRoundPrompt({
      repo: raid.target.repo, packageDir: raid.target.packageDir, headSha: ctx.headSha, round: ctx.rounds, maxRounds: this.opts.vector.maxRounds, testPath, tried, retained: known,
    }), signal);
    // A session cut short by the time cap or a stop is no Vector decision:
    // the catch in run() classifies it (time cap: budget-exhausted). An attack
    // it already submitted is recorded as never run.
    if (signal.aborted) {
      if (attack !== null) {
        const submitted: Attack = attack;
        this.recordRound(ctx, { outcome: 'not-run', verdict: 'not-run', description: submitted.description, artifactSha256: sha256(submitted.testContent),
          detail: 'not run: the raid was cut short before this attack could run' });
      }
      throw new Error('the Vector session was cut short mid-round');
    }
    if (attack === null) {
      this.recordRound(ctx, { outcome: 'no-submission', verdict: 'no-submission', detail: 'Vector submitted no valid attack this round' });
      // Vector stopped without one attack ever surviving qualification.
      if (ctx.qualified === 0) throw new RaidStop('no-qualified-proposals', `round ${String(ctx.rounds)} brought no attack, and none before it survived qualification`);
      return;
    }
    const artifactSha256 = sha256(attack.testContent);
    // Only a test that actually ran at this identity, and whose run counted, is
    // a duplicate: a voided or not-run round settled nothing.
    const seenBefore = this.store.raids()
      .filter((entry) => entry.target.repo === raid.target.repo && entry.target.packageDir === raid.target.packageDir && entry.sourceIdentity === raid.sourceIdentity)
      .some((entry) => entry.rounds.some((previous) => previous.artifactSha256 === artifactSha256 && previous.executedRuns > 0 &&
        previous.outcome !== 'voided' && previous.outcome !== 'not-run'));
    if (seenBefore) {
      ctx.duplicates += 1;
      this.recordRound(ctx, { outcome: 'duplicate', verdict: 'duplicate', description: attack.description, artifactSha256, detail: 'an exact duplicate of a test already run at this source identity; not executed' });
      return;
    }
    let knownBad: ReturnType<VectorRaidRunner['commitControl']>;
    let reference: ReturnType<VectorRaidRunner['commitControl']>;
    try {
      knownBad = this.commitControl(roots.knownBad, ctx.headSha, attack.knownBad, 'known-bad control');
      reference = knownBad === 'changed' ? this.commitControl(roots.healthy, ctx.headSha, attack.reference, 'reference control') : 'unchanged';
    } catch (error) {
      // A host fault while preparing the controls: the attack is still listed, never run.
      this.recordRound(ctx, { outcome: 'not-run', verdict: 'not-run', description: attack.description, artifactSha256,
        detail: `not run: the host failed while preparing its controls (${oneLineError(error)})` });
      throw error;
    }
    if (knownBad !== 'changed' || reference.startsWith('refused')) {
      ctx.invalidAttacks += 1;
      this.recordRound(ctx, { outcome: 'invalid-attack', verdict: 'invalid-attack', description: attack.description, artifactSha256,
        detail: knownBad === 'unchanged' ? 'the known-bad control changes nothing' : knownBad !== 'changed' ? knownBad : reference });
      return;
    }
    // A cap or a stop that came while the controls were prepared: the attack
    // never runs (the catch in run() classifies it, as for a cut-short session).
    if (signal.aborted) {
      this.recordRound(ctx, { outcome: 'not-run', verdict: 'not-run', description: attack.description, artifactSha256,
        detail: 'not run: the raid was cut short before this attack could run' });
      throw new Error('the raid was cut short before the attack ran');
    }
    ctx.attacks += 1;
    const spec: ReviewedPropertyCampaign = {
      proposal: parsePropertyProposal({
        requirementRef: attack.requirementRef, invariant: attack.invariant, inputDomain: attack.inputDomain, invalidInputBehavior: attack.invalidInputBehavior,
        targetPackageDir: raid.target.packageDir, adapterId: RAID_ADAPTER, testArtifactRefs: [{ path: testPath, sha256: artifactSha256 }],
        establishes: attack.establishes, doesNotEstablish: attack.doesNotEstablish,
      }),
      overlayFiles: [{ path: testPath, content: attack.testContent }],
      knownBadRoot: roots.knownBad,
      healthyRoot: roots.healthy,
      candidateRoot: roots.target,
      // The target is its own baseline: a defect on main is pre-existing by
      // definition (baselineAttribution 'baseline-also-fails').
      baselineRoot: roots.target,
    };
    const evidenceDir = join(ctx.raidDir, 'evidence', `round-${String(ctx.rounds)}`);
    let result: PropertyCampaignResult;
    try {
      result = await campaign.run(spec, evidenceDir);
    } catch (error) {
      // An attack that did not finish (time cap, stop, host fault) is still
      // listed, with whatever receipts it left. No evidence from it counts;
      // the runs it spent, one `pex-` receipt each, do count toward the budget
      // (a run cut off before its receipt was written is not seen).
      const receipts = this.receiptsIn(evidenceDir);
      const executedRuns = receipts.filter((name) => name.startsWith('pex-')).length;
      ctx.runs += executedRuns;
      this.recordRound(ctx, { outcome: 'voided', verdict: 'not-finished', description: attack.description, artifactSha256,
        receipts, executedRuns, detail: `voided: the attack did not finish (${oneLineError(error)})` });
      throw error;
    }
    ctx.runs += result.metrics.executedRuns;
    ctx.executionMs += result.metrics.totalExecutionMs;
    const receipts = this.receiptsIn(evidenceDir);
    const verdict = result.qualification?.verdict ?? 'not-run';
    // A round that ends the raid is still recorded, with its receipts, so the
    // report lists every proposal (#351 §5).
    const endRound = (outcome: 'not-run' | 'voided', stop: RaidStop): never => {
      this.recordRound(ctx, { outcome, verdict, description: attack.description, artifactSha256, candidateOutcome: result.candidateOutcome, replay: result.replay,
        executedRuns: result.metrics.executedRuns, receipts, detail: stop.detail });
      throw stop;
    };
    if (result.mode === 'disabled') endRound('not-run', new RaidStop('refused', 'not-run: property execution is disabled (.gru-command/property.toml) at this head'));
    if (verdict === 'escalated' && result.disclosure.startsWith('sandbox execution refused')) endRound('not-run', new RaidStop('refused', `not-run: ${result.disclosure}`));
    // Evidence binds the head it ran at: when main moved during the attack,
    // nothing from it counts (not even a break-in).
    if (!this.fetch(ctx.repoPath)) ctx.fetchFailed = true;
    if (cachedDefaultHead(ctx.repoPath) !== ctx.headSha) endRound('voided', new RaidStop('invalidated', 'main moved during the raid; no evidence crosses heads'));
    if (verdict === 'qualified') ctx.qualified += 1;
    else ctx.verdicts[verdict] = (ctx.verdicts[verdict] ?? 0) + 1;
    const replay = result.replay;
    const failed = verdict === 'qualified' && result.candidateOutcome === 'property-failure';
    if (failed && replay !== 'not-run') {
      ctx.replayed += 1;
      if (replay === 'reproduced') ctx.reproduced += 1;
    }
    const brokeIn = failed && replay === 'reproduced' && result.frozen !== null;
    const outcome: RoundOutcome = verdict !== 'qualified' ? 'rejected' : brokeIn ? 'break-in' : result.candidateOutcome === 'pass' ? 'pass' : 'inconclusive';
    if (outcome === 'inconclusive') ctx.inconclusive += 1;
    this.recordRound(ctx, {
      outcome, verdict, description: attack.description, artifactSha256, candidateOutcome: result.candidateOutcome, replay, executedRuns: result.metrics.executedRuns, receipts,
      detail: outcome === 'rejected'
        ? `rejected before attacking: ${(result.qualification?.reasons ?? [result.disclosure]).join('; ').slice(0, 600)}`
        : outcome === 'inconclusive'
          ? (failed
            ? `inconclusive: the failure did not reproduce on a fresh replay (${replay}); nondeterminism disclosed: ${result.disclosure.slice(0, 400)}`
            : `inconclusive: the attack run settled nothing (${result.candidateOutcome ?? 'no outcome'}): ${result.disclosure.slice(0, 400)}`)
          : result.disclosure.slice(0, 600),
    });
    if (brokeIn) this.recordBreakIn(ctx, attack, testPath, artifactSha256, result, campaign.counterexample(result), evidenceDir, receipts);
  }

  /** The host's receipt files the campaign wrote for a round: one `pex-<id>.json` per execution and `replay-<id>.json` per replay (#350's names; its result and the break-in record are not receipts). */
  private receiptsIn(evidenceDir: string): readonly string[] {
    try {
      return readdirSync(evidenceDir).filter((name) => /^(?:pex|replay)-[A-Za-z0-9-]+\.json$/u.test(name)).sort();
    } catch {
      return [];
    }
  }

  /** One fresh Vector session per round: prompt, capture, dispose. */
  private async askVector(ctx: RaidContext, cwd: string, prompt: string, signal: AbortSignal): Promise<Attack | null> {
    let attack: Attack | null = null;
    const policy: IsolatedReviewPolicy = {
      systemPrompt: VECTOR_SYSTEM_PROMPT,
      tools: ['read', 'grep', 'find', 'ls'],
      nativeTools: [vectorAttackTool(ctx.raid.target.packageDir, (submitted) => { attack = submitted; })],
    };
    const lease = this.opts.acquireTurn === undefined ? null : await this.opts.acquireTurn({ id: `vector:${ctx.raid.id}`, label: `Vector raid → ${ctx.raid.target.repo}`, signal });
    let handle: AgentHandle | null = null;
    try {
      handle = await this.opts.spawnVector({ raidId: ctx.raid.id, policy, cwd, signal });
      await handle.prompt(prompt, { owner: 'vector' });
      // Token usage is the session's context size as the runtime reports it.
      const usage = handle.getContextUsage?.() ?? null;
      if (usage === null) ctx.roundsWithoutTokenUsage += 1;
      else ctx.tokens += usage.tokens;
    } finally {
      if (handle !== null) await this.opts.disposeVector(handle);
      lease?.release();
    }
    return attack;
  }

  private makeRoot(repoPath: string, root: string, headSha: string, packageDir: string): void {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(dirname(root), { recursive: true });
    raidGit(dirname(root), ['clone', '--quiet', '--shared', '--no-checkout', repoPath, root]);
    raidGit(root, ['checkout', '--quiet', '--detach', headSha]);
    // The sandbox copies installed dependencies; absolute links out of the
    // root are refused, so they are copied, never linked.
    for (const rel of new Set(['.', packageDir])) {
      const source = join(repoPath, rel, 'node_modules');
      if (existsSync(source)) cpSync(source, join(root, rel, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    }
  }

  /**
   * Reset a control root to the head, write the control's files, commit.
   * `unchanged` when it changes nothing; `refused: …` when a path would pass
   * through a link in the clone (a control writes only inside its clone).
   */
  private commitControl(root: string, headSha: string, files: readonly AttackFile[], label: string): 'changed' | 'unchanged' | `refused: ${string}` {
    raidGit(root, ['reset', '--quiet', '--hard', headSha]);
    if (files.length === 0) return 'unchanged';
    const fs = this.opts.controlFs ?? NODE_CONTROL_FS;
    for (const file of files) {
      const parts = file.path.split('/');
      for (let depth = 1; depth <= parts.length; depth += 1) {
        // lstat, not exists: a dangling link is still a link. Only a path that
        // does not exist (yet) ends the walk; any other failure refuses.
        let link: boolean;
        try {
          link = fs.lstat(join(root, ...parts.slice(0, depth))).isSymbolicLink();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') break;
          // As for writes: a path fault is the attack's, anything else the host's.
          if (isAttackPathFault(code)) return `refused: ${label} path ${file.path} cannot be checked in the clone (${String(code)})`;
          throw error;
        }
        if (link) return `refused: ${label} path ${file.path} passes through a link in the clone`;
      }
    }
    const attempted: string[] = [];
    const createdDirs: string[] = [];
    for (const file of files) {
      const target = join(root, file.path);
      try {
        // The first directory this write would create, recorded before mkdir:
        // a recursive mkdir that fails part-way returns nothing.
        let missing = dirname(target);
        while (dirname(missing) !== missing && !existsSync(dirname(missing))) missing = dirname(missing);
        if (!existsSync(missing)) createdDirs.push(missing);
        mkdirSync(dirname(target), { recursive: true });
        attempted.push(target);
        fs.writeFile(target, file.content);
      } catch (error) {
        // A path the clone cannot hold is the attack's fault; any other write
        // failure is the host's. Either way the clone goes back to the head:
        // every file it wrote (part-written too) and every directory made for
        // it are removed, and a tracked file it overwrote is restored. A
        // cleanup that fails leaves the clone unknown: that is the host's.
        try {
          for (const path of attempted) {
            // Never a directory: writing onto an existing one is the attack's EISDIR.
            if (existsSync(path) && !fs.lstat(path).isDirectory()) rmSync(path, { force: true });
          }
          for (const dir of [...createdDirs].reverse()) rmSync(dir, { recursive: true, force: true });
          raidGit(root, ['reset', '--quiet', '--hard', headSha]);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], `${label} could not be written, and the clone could not be put back: ${oneLineError(cleanup)}`);
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (isAttackPathFault(code)) return `refused: ${label} path ${file.path} cannot be written in the clone (${String(code)})`;
        throw error;
      }
    }
    // Forced: a control may touch a path the repository ignores.
    raidGit(root, ['add', '--force', '--', ...files.map((file) => file.path)]);
    try {
      raidGit(root, ['diff', '--cached', '--quiet']);
      return 'unchanged';
    } catch {
      raidGit(root, ['commit', '--quiet', '-m', label]);
      return 'changed';
    }
  }

  private recordBreakIn(ctx: RaidContext, attack: Attack, testPath: string, testSha256: string, result: PropertyCampaignResult, example: RetainedCounterexample | null, evidenceDir: string, receipts: readonly string[]): void {
    const breakInId = `breakin-${ctx.raid.id.slice('raid-'.length)}-r${String(ctx.rounds)}`;
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'break-in.json'), `${JSON.stringify({ breakInId, frozen: result.frozen, test: { path: testPath, content: attack.testContent }, counterexample: example, attack: { ...attack, testContent: undefined } }, null, 2)}\n`, { mode: 0o600 });
    this.store.record(VECTOR_EVENTS.breakIn, {
      break_in_id: breakInId,
      raid_id: ctx.raid.id,
      repo: ctx.raid.target.repo,
      package_dir: ctx.raid.target.packageDir,
      head_sha: ctx.headSha,
      source_identity: ctx.raid.sourceIdentity,
      description: attack.description,
      requirement_ref: attack.requirementRef,
      invariant: attack.invariant,
      frozen_sha256: result.frozen!.frozenAtSha256,
      counterexample: (example?.minimizedInput ?? '').slice(0, 4096),
      seed: example?.replay.seed ?? null,
      shrink_path: example?.replay.shrinkPath ?? [],
      evidence_dir: evidenceDir,
      test_path: testPath,
      test_sha256: testSha256,
      receipts: receipts.length > 0 ? receipts : result.candidateRef === null ? [] : [`${result.candidateRef.receiptId}.json`],
    });
    ctx.breakIns += 1;
    const recorded = this.store.breakIn(breakInId)!;
    try { this.opts.onBreakIn?.(recorded); } catch (error) {
      this.log('error', 'vector break-in follow-through failed; the break-in stays recorded', { breakIn: breakInId, error: oneLineError(error) });
    }
  }

  /** Refresh the cached default branch. False (logged) when the fetch failed: the cached head then decides. */
  private fetch(repoPath: string): boolean {
    try {
      (this.opts.fetchDefault ?? fetchOrigin)(repoPath);
      return true;
    } catch (error) {
      this.log('warn', 'vector raid fetch failed; the cached default branch decides', { repo: repoPath, error: oneLineError(error) });
      return false;
    }
  }

  private finishWith(raid: RaidRecord, outcome: RaidOutcome, detail: string, ctx: RaidContext | null): void {
    const attacks = ctx?.attacks ?? 0;
    const label = raidOutcomeLabel(outcome, detail, attacks);
    const current = this.store.raid(raid.id) ?? raid;
    const invalidOracles = ctx === null ? 0 : Object.values(ctx.verdicts).reduce((sum, count) => sum + count, 0);
    const wallClockMs = ctx === null ? 0 : this.now().getTime() - ctx.startedMs;
    const metrics: RaidMetrics = {
      // #350's snapshot, as a raid fills it.
      actionableDefects: ctx?.breakIns ?? 0,
      invalidOracles,
      unknownValidity: ctx?.inconclusive ?? 0,
      totalQualificationAttempts: attacks,
      replayReliability: { replayed: ctx?.replayed ?? 0, reproduced: ctx?.reproduced ?? 0 },
      escapedRegressions: 0,
      executedRuns: ctx?.runs ?? 0,
      totalExecutionMs: ctx?.executionMs ?? 0,
      // Unknown, not zero, when a round reported no usage.
      totalTokenCost: ctx === null || ctx.roundsWithoutTokenUsage > 0 ? null : ctx.tokens,
      // The raid's own.
      proposals: attacks,
      qualified: ctx?.qualified ?? 0,
      rejectedByVerdict: { ...(ctx?.verdicts ?? {}) },
      inconclusive: ctx?.inconclusive ?? 0,
      invalidAttacks: ctx?.invalidAttacks ?? 0,
      duplicates: ctx?.duplicates ?? 0,
      breakIns: ctx?.breakIns ?? 0,
      wallClockMs,
      tokens: ctx?.tokens ?? 0,
      roundsWithoutTokenUsage: ctx?.roundsWithoutTokenUsage ?? 0,
    };
    const report = {
      raid: raid.id,
      target: raid.target,
      reason: raid.reason,
      requested_by: raid.requestedBy,
      launched_by: raid.launchedBy,
      head_sha: ctx?.headSha ?? null,
      head_freshness: ctx === null ? 'not reached' : ctx.fetchFailed ? 'unverified: a fetch of origin failed, so the cached default branch decided' : 'fetched at every boundary',
      source_identity: raid.sourceIdentity,
      proposals: current.rounds,
      outcome,
      label,
      detail,
      metrics,
      invalid_oracle_rate: attacks === 0 ? null : invalidOracles / attacks,
      cost_per_break_in: metrics.breakIns === 0 || metrics.roundsWithoutTokenUsage > 0 ? null : metrics.tokens / metrics.breakIns,
      token_usage: metrics.roundsWithoutTokenUsage === 0
        ? 'the Vector sessions\' context size at the end of each round, as the runtime reported it'
        : `${String(metrics.roundsWithoutTokenUsage)} round(s) reported no usage; the token cap counted the rounds that did, and the round, run and time caps bound the rest`,
      merge_authority: 'none',
    };
    let reportFile: string | null = null;
    try {
      const dir = join(this.opts.raidsDir, raid.id);
      mkdirSync(dir, { recursive: true });
      reportFile = join(dir, 'report.json');
      writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      reportFile = null;
      this.log('error', 'vector raid report write failed; the ledger keeps the outcome', { raid: raid.id, error: oneLineError(error) });
    }
    this.store.record(VECTOR_EVENTS.finished, { raid_id: raid.id, outcome, label, detail, report_file: reportFile, metrics });
    const flag = repositoryRollups(this.store.raids()).find((rollup) => rollup.repo === raid.target.repo)?.flag ?? null;
    const name = raid.target.packageDir === '.' ? raid.target.repo : `${raid.target.repo}/${raid.target.packageDir}`;
    this.opts.notifications.post({
      id: `vector-finished:${raid.id}`,
      kind: RAID_FINISHED_KIND,
      routing: 'fyi',
      severity: outcome === 'infrastructure-error' ? 'error' : 'info',
      title: `Vector raid on ${name.length > 120 ? `${name.slice(0, 119)}…` : name}: ${label.length > 160 ? `${label.slice(0, 159)}…` : label}`,
      detail: `${detail}\n${String(attacks)} attack(s), ${String(metrics.executedRuns)} sandboxed run(s), ${String(metrics.breakIns)} break-in(s).${reportFile === null ? '' : ` Report: ${reportFile}`}${flag === null ? '' : `\n${flag}`}`,
    });
  }

  /** Test seam: the raid in flight, if any. */
  settled(): Promise<string | null> {
    return this.running ?? Promise.resolve(null);
  }
}
