import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VectorConfig } from '../config.js';
import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { createPropertyExecutor, resolveSandboxBackend } from '../property/executor.js';
import { createPropertyCampaignHost, type PropertyCampaignResult, type ReviewedPropertyCampaign } from '../property/pipeline.js';
import { parsePropertyProposal } from '../property/proposal.js';
import { resolvePropertyCapabilities } from '../property/resolve.js';
import type { PackageResolution, RetainedCounterexample } from '../property/types.js';
import type { PacingLease } from '../runtime/pacing.js';
import type { AgentHandle, IsolatedReviewPolicy } from '../runtime/types.js';
import { renderRoundPrompt, VECTOR_SYSTEM_PROMPT, vectorAttackTool, type Attack, type AttackFile } from './attack.js';
import { repositoryRollups, VECTOR_EVENTS, VectorLedger, type BreakInRecord, type RaidOutcome, type RaidRecord } from './ledger.js';

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

/** The least one attack costs: its known-bad control, its healthy control and the attack. */
export const RUNS_PER_ATTACK = 3;

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

export function raidOutcomeLabel(outcome: RaidOutcome, detail: string, attacks: number): string {
  switch (outcome) {
    case 'found': return 'Vector broke in';
    case 'budget-exhausted': return `Raid over: no break-in found in ${String(attacks)} attack${attacks === 1 ? '' : 's'} — not proof the code is safe`;
    case 'no-qualified-proposals': return 'Raid over: no attack survived qualification';
    case 'refused': return `Raid not run: ${detail}`;
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
  /** Refresh the cached origin default branch (default: a bounded `git fetch origin`). */
  readonly fetchDefault?: (repoPath: string) => void;
  readonly resolvePackages?: (repoPath: string) => readonly PackageResolution[];
  readonly now?: () => Date;
  readonly log?: Log;
  readonly tickIntervalMs?: number;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

const GIT_ENV = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

/** Git for raid roots: no hooks, no fsmonitor, a fixed identity for control commits. */
function raidGit(cwd: string, args: readonly string[], timeoutMs = 120_000): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Vector', '-c', 'user.email=vector@gru-command.invalid', ...args], {
    cwd, encoding: 'utf8', timeout: timeoutMs, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  attacks: number;
  qualified: number;
  runs: number;
  tokens: number;
  tokensKnown: boolean;
  breakIns: number;
  readonly verdicts: Record<string, number>;
  replayed: number;
  reproduced: number;
}

export class VectorRaidRunner {
  private readonly store: VectorLedger;
  private readonly log: Log;
  private readonly now: () => Date;
  private running: Promise<string | null> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stopController = new AbortController();

  constructor(private readonly opts: RaidRunnerOptions) {
    this.store = new VectorLedger(opts.ledger);
    this.log = opts.log ?? (() => {});
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

  /** Run the oldest queued raid when the host is free. Resolves with its id, or null. */
  tick(): Promise<string | null> {
    if (this.running !== null || !this.opts.vector.enabled || this.stopController.signal.aborted) return Promise.resolve(null);
    if (this.opts.heistWorkWaiting()) return Promise.resolve(null);
    const next = this.store.raids().filter((raid) => raid.state === 'queued')
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
      this.finishWith(raid, 'refused', `no sandbox backend on this host (${sandbox.reason ?? 'none found'}); a worktree is not a sandbox`, null);
      return;
    }
    this.fetch(repoPath);
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
    mkdirSync(raidDir, { recursive: true });
    this.store.record(VECTOR_EVENTS.started, { raid_id: raid.id, head_sha: headSha });
    const ctx: RaidContext = { raid, repoPath, raidDir, headSha, startedMs: this.now().getTime(), rounds: 0, attacks: 0, qualified: 0, runs: 0, tokens: 0, tokensKnown: true, breakIns: 0, verdicts: {}, replayed: 0, reproduced: 0 };
    const abort = new AbortController();
    const onStop = (): void => abort.abort();
    this.stopController.signal.addEventListener('abort', onStop, { once: true });
    const deadline = setTimeout(() => abort.abort(), Math.max(1, this.opts.vector.maxRaidMs));
    deadline.unref?.();
    const roots = { target: join(raidDir, 'target'), knownBad: join(raidDir, 'known-bad'), healthy: join(raidDir, 'healthy') };
    try {
      for (const root of Object.values(roots)) this.makeRoot(repoPath, root, headSha, raid.target.packageDir);
      const row = (this.opts.resolvePackages ?? ((root: string) => resolvePropertyCapabilities({ repoRoot: root }).packages))(roots.target)
        .find((entry) => entry.packageDir === raid.target.packageDir);
      if (row === undefined || row.status !== 'resolved' || row.adapterId !== 'vitest-fast-check' || row.tooling?.executable !== true) {
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
      else this.finishWith(raid, abort.signal.aborted && !this.stopController.signal.aborted ? (ctx.qualified > 0 ? 'budget-exhausted' : 'no-qualified-proposals') : 'infrastructure-error', abort.signal.aborted && !this.stopController.signal.aborted ? `the ${String(Math.round(this.opts.vector.maxRaidMs / 60_000))}-minute raid time cap ran out` : oneLineError(error), ctx);
    } finally {
      clearTimeout(deadline);
      this.stopController.signal.removeEventListener('abort', onStop);
      for (const root of Object.values(roots)) rmSync(root, { recursive: true, force: true });
    }
  }

  /** Round-boundary checks: every budget dimension, heist priority, and main. */
  private boundary(ctx: RaidContext, signal: AbortSignal): void {
    const v = this.opts.vector;
    const exhausted = (why: string): RaidStop => new RaidStop(ctx.qualified > 0 ? 'budget-exhausted' : 'no-qualified-proposals', why);
    if (this.stopController.signal.aborted) throw new RaidStop('infrastructure-error', 'the service is stopping');
    if (signal.aborted || this.now().getTime() - ctx.startedMs >= v.maxRaidMs) throw exhausted(`the ${String(Math.round(v.maxRaidMs / 60_000))}-minute raid time cap ran out`);
    if (ctx.rounds >= v.maxRounds) throw exhausted(`all ${String(v.maxRounds)} attacks were spent`);
    if (ctx.runs + RUNS_PER_ATTACK > v.maxRuns) throw exhausted(`${String(v.maxRuns - ctx.runs)} of ${String(v.maxRuns)} sandboxed runs left, fewer than one attack needs`);
    if (ctx.tokensKnown && ctx.tokens >= v.maxRaidTokens) throw exhausted(`the ${String(v.maxRaidTokens)}-token cap was reached`);
    if (this.opts.heistWorkWaiting()) throw new RaidStop('yielded', 'heist work arrived; Gru may pick this target again later');
    this.fetch(ctx.repoPath);
    if (cachedDefaultHead(ctx.repoPath) !== ctx.headSha) throw new RaidStop('invalidated', 'main moved during the raid; no evidence crosses heads');
  }

  private async round(ctx: RaidContext, roots: { readonly target: string; readonly knownBad: string; readonly healthy: string }, campaign: RaidCampaign, signal: AbortSignal): Promise<void> {
    const raid = ctx.raid;
    const prefix = raid.target.packageDir === '.' ? '' : `${raid.target.packageDir}/`;
    const testPath = `${prefix}test/vector/r${String(ctx.rounds)}-${raid.id.slice(-8)}.test.mjs`;
    const tried = this.store.raid(raid.id)!.rounds.map((entry) => entry.description).filter((entry): entry is string => entry !== null);
    const retained = this.store.breakIns().filter((entry) => entry.target.repo === raid.target.repo && entry.target.packageDir === raid.target.packageDir).map((entry) => entry.invariant);
    const attack = await this.askVector(ctx, roots.target, renderRoundPrompt({
      repo: raid.target.repo, packageDir: raid.target.packageDir, headSha: ctx.headSha, round: ctx.rounds, maxRounds: this.opts.vector.maxRounds, testPath, tried, retained,
    }), signal);
    const roundBase = { raid_id: raid.id, round: ctx.rounds };
    if (attack === null) {
      this.store.record(VECTOR_EVENTS.round, { ...roundBase, verdict: 'no-submission', detail: 'Vector submitted no valid attack this round' });
      return;
    }
    ctx.attacks += 1;
    const artifactSha256 = sha256(attack.testContent);
    const seenBefore = this.store.raids()
      .filter((entry) => entry.target.repo === raid.target.repo && entry.target.packageDir === raid.target.packageDir && entry.sourceIdentity === raid.sourceIdentity)
      .some((entry) => entry.rounds.some((previous) => previous.artifactSha256 === artifactSha256));
    if (seenBefore) {
      this.store.record(VECTOR_EVENTS.round, { ...roundBase, description: attack.description, verdict: 'duplicate', artifact_sha256: artifactSha256, detail: 'an exact duplicate of a test already run at this source identity; not executed' });
      return;
    }
    if (!this.commitControl(roots.knownBad, ctx.headSha, attack.knownBad, 'known-bad control')) {
      this.store.record(VECTOR_EVENTS.round, { ...roundBase, description: attack.description, verdict: 'invalid-attack', artifact_sha256: artifactSha256, detail: 'the known-bad control changes nothing' });
      return;
    }
    this.commitControl(roots.healthy, ctx.headSha, attack.reference, 'reference control');
    const spec: ReviewedPropertyCampaign = {
      proposal: parsePropertyProposal({
        requirementRef: attack.requirementRef, invariant: attack.invariant, inputDomain: attack.inputDomain, invalidInputBehavior: attack.invalidInputBehavior,
        targetPackageDir: raid.target.packageDir, adapterId: 'vitest-fast-check', testArtifactRefs: [{ path: testPath, sha256: artifactSha256 }],
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
    const result = await campaign.run(spec, evidenceDir);
    ctx.runs += result.metrics.executedRuns;
    // Evidence binds the head it ran at: when main moved during the attack,
    // nothing from it counts (not even a break-in).
    this.fetch(ctx.repoPath);
    if (cachedDefaultHead(ctx.repoPath) !== ctx.headSha) throw new RaidStop('invalidated', 'main moved during the raid; no evidence crosses heads');
    const verdict = result.qualification?.verdict ?? 'not-run';
    ctx.verdicts[verdict] = (ctx.verdicts[verdict] ?? 0) + 1;
    if (result.mode === 'disabled') throw new RaidStop('refused', 'property execution is disabled (.gru-command/property.toml) at this head');
    if (verdict === 'escalated' && result.disclosure.startsWith('sandbox execution refused')) throw new RaidStop('refused', result.disclosure);
    if (verdict === 'qualified') ctx.qualified += 1;
    const replay = result.replay;
    if (verdict === 'qualified' && result.candidateOutcome === 'property-failure' && replay !== 'not-run') {
      ctx.replayed += 1;
      if (replay === 'reproduced') ctx.reproduced += 1;
    }
    this.store.record(VECTOR_EVENTS.round, {
      ...roundBase, description: attack.description, verdict, candidate_outcome: result.candidateOutcome, replay, artifact_sha256: artifactSha256,
      executed_runs: result.metrics.executedRuns,
      detail: verdict !== 'qualified'
        ? `rejected before attacking: ${(result.qualification?.reasons ?? [result.disclosure]).join('; ').slice(0, 600)}`
        : result.candidateOutcome === 'property-failure' && replay !== 'reproduced'
          ? `inconclusive: the failure did not reproduce on a fresh replay (${replay}); nondeterminism disclosed: ${result.disclosure.slice(0, 400)}`
          : result.disclosure.slice(0, 600),
    });
    if (verdict === 'qualified' && result.candidateOutcome === 'property-failure' && replay === 'reproduced' && result.frozen !== null) {
      this.recordBreakIn(ctx, attack, testPath, artifactSha256, result, campaign.counterexample(result), evidenceDir);
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
      const usage = handle.getContextUsage?.() ?? null;
      if (usage === null) ctx.tokensKnown = false;
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

  /** Reset a control root to the head, write the control's files, commit. False when it changes nothing. */
  private commitControl(root: string, headSha: string, files: readonly AttackFile[], label: string): boolean {
    raidGit(root, ['reset', '--quiet', '--hard', headSha]);
    if (files.length === 0) return false;
    for (const file of files) {
      mkdirSync(dirname(join(root, file.path)), { recursive: true });
      writeFileSync(join(root, file.path), file.content);
    }
    raidGit(root, ['add', '--', ...files.map((file) => file.path)]);
    try {
      raidGit(root, ['diff', '--cached', '--quiet']);
      return false;
    } catch {
      raidGit(root, ['commit', '--quiet', '-m', label]);
      return true;
    }
  }

  private recordBreakIn(ctx: RaidContext, attack: Attack, testPath: string, testSha256: string, result: PropertyCampaignResult, example: RetainedCounterexample | null, evidenceDir: string): void {
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
      receipts: result.candidateRef === null ? [] : [result.candidateRef.receiptId],
    });
    ctx.breakIns += 1;
    const recorded = this.store.breakIn(breakInId)!;
    try { this.opts.onBreakIn?.(recorded); } catch (error) {
      this.log('error', 'vector break-in follow-through failed; the break-in stays recorded', { breakIn: breakInId, error: oneLineError(error) });
    }
  }

  private fetch(repoPath: string): void {
    try {
      (this.opts.fetchDefault ?? ((path: string) => { raidGit(path, ['fetch', '--quiet', 'origin'], 60_000); }))(repoPath);
    } catch (error) {
      this.log('warn', 'vector raid fetch failed; the cached default branch decides', { repo: repoPath, error: oneLineError(error) });
    }
  }

  private finishWith(raid: RaidRecord, outcome: RaidOutcome, detail: string, ctx: RaidContext | null): void {
    const attacks = ctx?.attacks ?? 0;
    const label = raidOutcomeLabel(outcome, detail, attacks);
    const current = this.store.raid(raid.id) ?? raid;
    const invalidOracles = ctx === null ? 0 : Object.entries(ctx.verdicts).filter(([verdict]) => verdict !== 'qualified').reduce((sum, [, count]) => sum + count, 0);
    const wallClockMs = ctx === null ? 0 : this.now().getTime() - ctx.startedMs;
    const tokens = ctx === null ? null : ctx.tokensKnown ? ctx.tokens : null;
    const metrics = {
      proposals: attacks,
      qualified: ctx?.qualified ?? 0,
      rejected_by_verdict: Object.fromEntries(Object.entries(ctx?.verdicts ?? {}).filter(([verdict]) => verdict !== 'qualified')),
      invalid_oracles: invalidOracles,
      invalid_oracle_rate: attacks === 0 ? null : invalidOracles / attacks,
      executed_runs: ctx?.runs ?? 0,
      break_ins: ctx?.breakIns ?? 0,
      replay_reliability: { replayed: ctx?.replayed ?? 0, reproduced: ctx?.reproduced ?? 0 },
      wall_clock_ms: wallClockMs,
      tokens,
      token_usage: tokens === null ? 'unavailable: the runtime did not report usage, so only the round, run and time caps bound this raid' : 'the Vector sessions\' context size at the end of each round, as the runtime reported it',
      cost_per_break_in: tokens === null || (ctx?.breakIns ?? 0) === 0 ? null : tokens / ctx!.breakIns,
    };
    const report = {
      raid: raid.id,
      target: raid.target,
      reason: raid.reason,
      requested_by: raid.requestedBy,
      launched_by: raid.launchedBy,
      head_sha: ctx?.headSha ?? null,
      source_identity: raid.sourceIdentity,
      proposals: current.rounds,
      outcome,
      label,
      detail,
      metrics,
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
      detail: `${detail}\n${String(attacks)} attack(s), ${String(metrics.executed_runs)} sandboxed run(s), ${String(metrics.break_ins)} break-in(s).${reportFile === null ? '' : ` Report: ${reportFile}`}${flag === null ? '' : `\n${flag}`}`,
    });
  }

  /** Test seam: the raid in flight, if any. */
  settled(): Promise<string | null> {
    return this.running ?? Promise.resolve(null);
  }
}
