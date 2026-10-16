import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_VECTOR_CONFIG, type VectorConfig } from '../src/config.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { propertyCampaignRunningForReview, propertyEvidenceForReview, type PropertyCampaignResult } from '../src/property/pipeline.js';
import type { PackageResolution, RetainedCounterexample } from '../src/property/types.js';
import type { AgentHandle, IsolatedReviewPolicy } from '../src/runtime/types.js';
import { metricsOf, RAID_OUTCOMES, repositoryRollups, VECTOR_EVENTS, ZERO_BREAK_IN_FLAG_RAIDS, type RaidRecord } from '../src/vector/ledger.js';
import { raidOutcomeLabel, VectorRaidRunner, type RaidCampaign } from '../src/vector/runner.js';
import { FIX_DISPATCH_FAILED_KIND, FIX_DISPATCHED_KIND, FIX_PROPOSAL_KIND, VectorService } from '../src/vector/service.js';

/**
 * Vector's raids, running half (#351 §3–5): Silas's raid queue with a
 * scripted Vector (the tool calls a real session would make) and a scripted
 * campaign (the verdicts #350's host would issue). Real git, a real ledger.
 */

const cleanups: (() => void)[] = [];
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const runnable = (): readonly PackageResolution[] => [{
  packageDir: 'src/refunds', ecosystem: 'node', status: 'resolved', adapterId: 'vitest-fast-check',
  tooling: { runner: 'runnable', libraries: {}, executable: true, reasons: [] }, reasons: [], evidence: [], resolutionKey: 'fixture',
}];

/** What Vector submits in one round (the tool input a real session sends). */
function attackInput(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: `vector ${String(n)}: negative refunds`,
    requirement_ref: 'README#refunds',
    invariant: 'a refund never exceeds the charged amount',
    input_domain: 'integer cents in [0, 10^6]',
    invalid_input_behavior: 'negative amounts are rejected',
    establishes: 'refund bounds for the sampled domain',
    does_not_establish: 'currency conversion',
    test: `import {it} from 'vitest'; // attack ${String(n)}\n`,
    known_bad: [{ path: 'src/refunds/refund.js', content: 'export const refund = (amount) => amount * 2;\n' }],
    ...overrides,
  };
}

type Script = { readonly attack?: Record<string, unknown> | null; readonly result?: Partial<PropertyCampaignResult> & { readonly runs?: number }; readonly onRun?: () => void | Promise<void> };

function campaignResult(script: Script): PropertyCampaignResult {
  const result = script.result ?? {};
  return {
    id: 'property-fixture', mode: 'observation', trigger: 'scheduled', candidateRoot: '/x', candidateSha: 'x', configHash: null,
    qualification: { verdict: 'qualified', reasons: ['controls held'], frozen: null }, attribution: 'baseline-also-fails',
    frozen: null, candidateRef: { receiptId: 'receipt-1' }, candidateOutcome: 'pass', replay: 'not-run', blocking: false,
    disclosure: 'candidate=pass', repairAttempts: 0, mergeAuthority: 'none',
    ...result,
    metrics: { actionableDefects: 0, invalidOracles: 0, unknownValidity: 0, totalQualificationAttempts: 1, replayReliability: { replayed: 0, reproduced: 0 }, escapedRegressions: 0, executedRuns: result.runs ?? 3, totalExecutionMs: 10, totalTokenCost: null },
  } as unknown as PropertyCampaignResult;
}

const FAILING: Script['result'] = {
  candidateOutcome: 'property-failure', replay: 'reproduced', runs: 5,
  frozen: { frozenAtSha256: 'f'.repeat(64) } as PropertyCampaignResult['frozen'],
};

function fakeVector(script: () => Script, tokens: number | null): (input: { readonly policy: IsolatedReviewPolicy }) => Promise<AgentHandle> {
  let count = 0;
  return async ({ policy }) => {
    count += 1;
    const id = `vector-${String(count)}`;
    return {
      role: 'perkins', id, sessionFile: `/sessions/${id}.jsonl`,
      capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
      async prompt() {
        const attack = script().attack;
        if (attack !== null && attack !== undefined) await policy.nativeTools![0]!.execute(attack);
      },
      async steer() {}, async followUp() {},
      subscribe() { return () => {}; },
      health() { return { state: 'idle', lastActivity: null, sessionFile: null }; },
      ...(tokens === null ? {} : { getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: 1 }) }),
      async dispose() {},
    } as AgentHandle;
  };
}

interface RunnerHarness {
  readonly ledger: LedgerApi;
  readonly repo: string;
  readonly service: VectorService;
  readonly runner: VectorRaidRunner;
  readonly runs: Script[];
  readonly dispatched: { jobId: string; briefing: string }[];
  spawned: number;
  heistWaiting: boolean;
  now: number;
  /** Launch one raid on billing/src/refunds (autonomous mode). */
  launch(): string;
  rows(kind: string): ReturnType<LedgerApi['listNotifications']>;
  moveMain(): void;
}

type DispatchFix = (input: { readonly jobId: string; readonly briefing: string }, ledger: LedgerApi) => Promise<void>;

function harness(opts: { readonly scripts: Script[]; readonly vector?: Partial<VectorConfig>; readonly tokens?: number | null; readonly sandbox?: string;
  /** Extra repository content, committed with the seed. */
  readonly seed?: (repo: string) => void;
  /** The fix-heist dispatch path (default: records the dispatch). */
  readonly dispatchFix?: DispatchFix; } ): RunnerHarness {
  const root = tempDir('gru-vector-runner-');
  const repo = join(root, 'billing');
  mkdirSync(join(repo, 'src', 'refunds'), { recursive: true });
  mkdirSync(join(repo, '.gru-command'), { recursive: true });
  writeFileSync(join(repo, '.gru-command', 'property.toml'), 'mode = "observation"\n');
  writeFileSync(join(repo, 'src', 'refunds', 'refund.js'), 'export const refund = (amount) => amount;\n');
  opts.seed?.(repo);
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const dataDir = tempDir('gru-vector-runner-ledger-');
  const db = new LedgerDb(dataDir);
  cleanups.push(() => db.close());
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const vector: VectorConfig = { ...DEFAULT_VECTOR_CONFIG, enabled: true, raidMode: 'autonomous', planIntervalMs: 0, maxRounds: 4, maxRuns: 40, ...opts.vector };
  const dispatched: { jobId: string; briefing: string }[] = [];
  const service = new VectorService({ vector, workspaceRoot: root, managedRepos: ['billing'], ledger, bus, notifications, resolvePackages: runnable,
    dispatchFix: async (input) => {
      if (opts.dispatchFix !== undefined) await opts.dispatchFix(input, ledger);
      dispatched.push({ jobId: input.jobId, briefing: input.briefing });
    } });
  cleanups.push(() => service.stop());
  const queue = [...opts.scripts];
  const h = {
    ledger, repo, service, runs: [] as Script[], dispatched, spawned: 0, heistWaiting: false, now: Date.parse('2026-10-16T09:00:00Z'),
  } as unknown as RunnerHarness;
  let current: Script = {};
  const spawnVector = fakeVector(() => { current = queue.shift() ?? { attack: null }; return current; }, opts.tokens === undefined ? 1000 : opts.tokens);
  const campaign: RaidCampaign = {
    run: async (_spec, artifactsDir) => {
      h.runs.push(current);
      await current.onRun?.();
      const result = campaignResult(current);
      // The host writes one receipt per run, and its report beside them.
      mkdirSync(artifactsDir, { recursive: true });
      for (let run = 0; run < result.metrics.executedRuns; run += 1) writeFileSync(join(artifactsDir, `receipt-${String(h.runs.length)}-${String(run)}.json`), '{}');
      writeFileSync(join(artifactsDir, 'property-report.json'), '{}');
      return result;
    },
    counterexample: (): RetainedCounterexample => ({ minimizedInput: '[-1]', replay: { seed: '42', shrinkPath: ['0:1'], schedule: null, environmentProfile: 'fixture', replaySupported: true, replayDisclosure: null } }),
  };
  const runner = new VectorRaidRunner({
    vector, workspaceRoot: root, ledger, raidsDir: join(dataDir, 'vector', 'raids'),
    spawnVector: async (input) => { h.spawned += 1; return spawnVector(input); },
    disposeVector: async () => {},
    heistWorkWaiting: () => h.heistWaiting,
    notifications,
    onBreakIn: (breakIn) => { void service.onBreakIn(breakIn.id); },
    campaign: () => campaign,
    sandbox: () => ({ backend: opts.sandbox ?? 'macos-sandbox-exec', reason: opts.sandbox === 'none-found' ? 'no sandbox-exec on linux' : null }),
    fetchDefault: () => {},
    resolvePackages: runnable,
    now: () => new Date(h.now),
  });
  cleanups.push(() => runner.stop());
  Object.assign(h, {
    runner,
    launch: () => service.pick({ picks: [{ repo: 'billing', packageDir: 'src/refunds', reason: 'fresh refunds code' }], digest: null, requestedBy: 'gru' }).raids[0]!.id,
    rows: (kind: string) => ledger.listNotifications({ limit: 500 }).filter((row) => row.kind === kind),
    moveMain: () => {
      writeFileSync(join(repo, 'README.md'), `moved ${String(Math.random())}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'main moves');
      git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    },
  });
  return h;
}

const raid = (h: RunnerHarness, id: string) => h.service.raids().find((entry) => entry.id === id)!;

describe('Silas\'s raid queue (#351 §3)', () => {
  it('no raid starts while heist work is queued; a running raid yields at the next round boundary', async () => {
    const h = harness({ scripts: [{ attack: attackInput(1), onRun: () => { h.heistWaiting = true; } }] });
    const id = h.launch();
    h.heistWaiting = true;
    expect(await h.runner.tick()).toBeNull();
    expect(raid(h, id).state).toBe('queued');
    h.heistWaiting = false;
    expect(await h.runner.tick()).toBe(id);
    expect(raid(h, id)).toMatchObject({ state: 'finished', outcome: 'yielded', outcomeLabel: 'Raid stopped for heist work' });
    expect(h.runs).toHaveLength(1);
  });

  it('a host with no sandbox backend refuses before any Vector session: a worktree is not a sandbox', async () => {
    const h = harness({ scripts: [{ attack: attackInput(1) }], sandbox: 'none-found' });
    const id = h.launch();
    await h.runner.tick();
    expect(raid(h, id)).toMatchObject({ outcome: 'refused', outcomeLabel: expect.stringMatching(/^Raid not run: not-run: no sandbox backend on this host \(no sandbox-exec on linux\)/u) });
    expect(h.spawned).toBe(0);
    expect(h.runs).toEqual([]);
  });

  it('a rejected verdict never attacks, is recorded and counts toward invalid oracles', async () => {
    const h = harness({ vector: { maxRounds: 2 }, scripts: [
      { attack: attackInput(1), result: { qualification: { verdict: 'rejected-vacuous', reasons: ['the known-bad control passed'], frozen: null }, candidateOutcome: null, runs: 2 } },
      { attack: attackInput(2), result: { qualification: { verdict: 'rejected-contradictory', reasons: ['the reference failed'], frozen: null }, candidateOutcome: null, runs: 2 } },
    ] });
    const id = h.launch();
    await h.runner.tick();
    const done = raid(h, id);
    expect(done.rounds.map((round) => [round.outcome, round.verdict, round.candidateOutcome])).toEqual([['rejected', 'rejected-vacuous', null], ['rejected', 'rejected-contradictory', null]]);
    expect(done.rounds[0]!.detail).toMatch(/^rejected before attacking: the known-bad control passed/u);
    // The rounds cap is a budget dimension: budget-exhausted, whatever qualified.
    expect(done).toMatchObject({ outcome: 'budget-exhausted' });
    const report = JSON.parse(readFileSync(done.reportFile!, 'utf8')) as { metrics: Record<string, unknown>; invalid_oracle_rate: number };
    expect(report.metrics).toMatchObject({ proposals: 2, qualified: 0, invalidOracles: 2, totalQualificationAttempts: 2, rejectedByVerdict: { 'rejected-vacuous': 1, 'rejected-contradictory': 1 } });
    expect(report.invalid_oracle_rate).toBe(1);
  });

  it('an exact-duplicate test at the same source identity is rejected without execution', async () => {
    const h = harness({ vector: { maxRounds: 2 }, scripts: [{ attack: attackInput(1) }, { attack: attackInput(1, { description: 'the same test again' }) }] });
    const id = h.launch();
    await h.runner.tick();
    expect(raid(h, id).rounds.map((round) => round.verdict)).toEqual(['qualified', 'duplicate']);
    expect(h.runs).toHaveLength(1);
  });

  it('a break-in counts only after a fresh replay reproduces it; a non-reproducing failure is inconclusive', async () => {
    const h = harness({ scripts: [
      { attack: attackInput(1), result: { ...FAILING, replay: 'not-reproduced', disclosure: 'replay=not-reproduced; nondeterministic' } },
      { attack: attackInput(2), result: FAILING },
    ] });
    const id = h.launch();
    await h.runner.tick();
    const done = raid(h, id);
    expect(done.rounds[0]).toMatchObject({ outcome: 'inconclusive', verdict: 'qualified', candidateOutcome: 'property-failure', replay: 'not-reproduced', detail: expect.stringMatching(/^inconclusive: the failure did not reproduce on a fresh replay \(not-reproduced\); nondeterminism disclosed/u) });
    expect(done).toMatchObject({ outcome: 'found', outcomeLabel: 'Vector broke in' });
    expect(done.rounds).toHaveLength(2);
    expect(h.service.breakIns()).toHaveLength(1);
    const [breakIn] = h.service.breakIns();
    expect(breakIn!.id).toMatch(/-r2$/u);
    expect(breakIn).toMatchObject({ raidId: id, counterexample: '[-1]', seed: '42', frozenSha256: 'f'.repeat(64), receipts: ['receipt-2-0.json', 'receipt-2-1.json', 'receipt-2-2.json', 'receipt-2-3.json', 'receipt-2-4.json'] });
    // Every round keeps its receipts (or says why it has none), typed by outcome.
    expect(done.rounds.map((round) => [round.outcome, round.receipts.length, round.noReceiptReason])).toEqual([['inconclusive', 5, null], ['break-in', 5, null]]);
    expect(existsSync(join(breakIn!.evidenceDir, 'break-in.json'))).toBe(true);
  });

  it('every budget dimension ends the raid as budget-exhausted, and nothing raises a budget', async () => {
    const pass = (n: number): Script => ({ attack: attackInput(n) });
    const rounds = harness({ vector: { maxRounds: 2 }, scripts: [pass(1), pass(2), pass(3)] });
    const r = rounds.launch(); await rounds.runner.tick();
    expect(raid(rounds, r)).toMatchObject({ outcome: 'budget-exhausted', outcomeLabel: 'Raid over: no break-in found in 2 attacks — not proof the code is safe' });
    const runs = harness({ vector: { maxRuns: 5 }, scripts: [pass(1), pass(2)] });
    const u = runs.launch(); await runs.runner.tick();
    expect(raid(runs, u)).toMatchObject({ outcome: 'budget-exhausted' });
    expect(runs.runs).toHaveLength(1);
    const time = harness({ vector: { maxRaidMs: 60_000 }, scripts: [{ attack: attackInput(1), onRun: () => { time.now += 61_000; } }, pass(2)] });
    const t = time.launch(); await time.runner.tick();
    expect(raid(time, t)).toMatchObject({ outcome: 'budget-exhausted' });
    expect(time.runs).toHaveLength(1);
    const tokens = harness({ vector: { maxRaidTokens: 1500 }, tokens: 1000, scripts: [pass(1), pass(2), pass(3)] });
    const k = tokens.launch(); await tokens.runner.tick();
    expect(raid(tokens, k)).toMatchObject({ outcome: 'budget-exhausted' });
    expect(tokens.runs).toHaveLength(2);
  });

  it('with no token usage reported, the other caps still bind and the report says so', async () => {
    const h = harness({ vector: { maxRounds: 1 }, tokens: null, scripts: [{ attack: attackInput(1) }] });
    const id = h.launch();
    await h.runner.tick();
    const report = JSON.parse(readFileSync(raid(h, id).reportFile!, 'utf8')) as { metrics: { tokens: number; roundsWithoutTokenUsage: number }; token_usage: string; cost_per_break_in: unknown };
    expect(report.metrics).toMatchObject({ tokens: 0, roundsWithoutTokenUsage: 1 });
    expect(report).toMatchObject({ cost_per_break_in: null, token_usage: expect.stringMatching(/^1 round\(s\) reported no usage; the token cap counted the rounds that did/u) });
  });

  it('main moving mid-raid voids it: no evidence crosses heads, not even a break-in', async () => {
    const h = harness({ scripts: [{ attack: attackInput(1), result: FAILING, onRun: () => h.moveMain() }] });
    const id = h.launch();
    await h.runner.tick();
    expect(raid(h, id)).toMatchObject({ outcome: 'invalidated', outcomeLabel: 'Raid void: main moved during the raid' });
    expect(h.service.breakIns()).toEqual([]);
  });

  it('a raid a previous process left running is closed out at boot, and its target may be picked again', async () => {
    const h = harness({ scripts: [] });
    const id = h.launch();
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.started, payload: { raid_id: id, head_sha: 'a'.repeat(40) } });
    h.runner.start();
    expect(raid(h, id)).toMatchObject({ outcome: 'infrastructure-error', outcomeLabel: 'Raid failed: the service stopped mid-raid; nothing from that raid counts' });
    expect(h.service.candidates().candidates).toHaveLength(1);
  });

  it('with [vector] enabled = false the queue never runs: no Vector session, no raid', async () => {
    const h = harness({ vector: { enabled: false }, scripts: [{ attack: attackInput(1) }] });
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.picked, payload: { raid_id: 'raid-queued-before', repo: 'billing', package_dir: 'src/refunds', source_identity: 'x', head_sha: 'h', reason: 'r', requested_by: 'gru' } });
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.queued, payload: { raid_id: 'raid-queued-before', launched_by: 'autonomous' } });
    h.runner.start();
    expect(await h.runner.tick()).toBeNull();
    expect(h.spawned).toBe(0);
    expect(raid(h, 'raid-queued-before').state).toBe('queued');
  });

  it('a known-bad control that changes nothing, or that writes through a link in the clone, is an invalid attack and never runs', async () => {
    const noop = harness({ vector: { maxRounds: 1 }, scripts: [{ attack: attackInput(1, { known_bad: [{ path: 'src/refunds/refund.js', content: 'export const refund = (amount) => amount;\n' }] }) }] });
    const n = noop.launch();
    await noop.runner.tick();
    expect(raid(noop, n).rounds.map((round) => [round.outcome, round.detail, round.executedRuns, round.noReceiptReason]))
      .toEqual([['invalid-attack', 'the known-bad control changes nothing', 0, 'not executed: the round ended invalid-attack']]);
    expect(noop.runs).toEqual([]);
    const linked = harness({ vector: { maxRounds: 1 }, seed: (repo) => symlinkSync('../..', join(repo, 'src', 'refunds', 'up')),
      scripts: [{ attack: attackInput(1, { known_bad: [{ path: 'src/refunds/up/escape.js', content: 'x\n' }] }) }] });
    const l = linked.launch();
    await linked.runner.tick();
    expect(raid(linked, l).rounds.map((round) => [round.outcome, round.detail]))
      .toEqual([['invalid-attack', 'refused: known-bad control path src/refunds/up/escape.js passes through a link in the clone']]);
    expect(linked.runs).toEqual([]);
    expect(raid(linked, l).metrics).toMatchObject({ invalidAttacks: 1, proposals: 0, executedRuns: 0 });
  });

  it('a repository that opted out, or turned property execution off, after the pick is refused at start: no Vector session', async () => {
    const opted = harness({ scripts: [{ attack: attackInput(1) }] });
    const o = opted.launch();
    writeFileSync(join(opted.repo, '.gru-command', 'worktree.toml'), '[vector]\nenabled = false\n');
    await opted.runner.tick();
    expect(raid(opted, o)).toMatchObject({ outcome: 'refused', outcomeLabel: 'Raid not run: the repository opted out ([vector] enabled = false in .gru-command/worktree.toml)' });
    const off = harness({ scripts: [{ attack: attackInput(1) }] });
    const d = off.launch();
    writeFileSync(join(off.repo, '.gru-command', 'property.toml'), 'mode = "disabled"\n');
    await off.runner.tick();
    expect(raid(off, d)).toMatchObject({ outcome: 'refused', outcomeLabel: 'Raid not run: property execution is disabled in the repository (.gru-command/property.toml)' });
    expect([opted.spawned, off.spawned, opted.runs.length, off.runs.length]).toEqual([0, 0, 0, 0]);
  });

  it('the time cap running out mid-round is budget-exhausted, and keeps what the round in flight ended with', async () => {
    const h = harness({ vector: { maxRaidMs: 30 }, scripts: [{ attack: attackInput(1), onRun: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      throw new Error('the sandbox run was aborted');
    } }] });
    const id = h.launch();
    await h.runner.tick();
    expect(raid(h, id)).toMatchObject({ outcome: 'budget-exhausted' });
    const report = JSON.parse(readFileSync(raid(h, id).reportFile!, 'utf8')) as { detail: string };
    expect(report.detail).toMatch(/raid time cap ran out \(the round in flight ended with: the sandbox run was aborted\)$/u);
  });

  it('no label renders an empty raid as a pass, verified or free of defects', () => {
    for (const outcome of RAID_OUTCOMES) {
      expect(raidOutcomeLabel(outcome, 'detail', 3), outcome).not.toMatch(/\bpass(ed)?\b|verified|no defects|\bclean\b/iu);
    }
    expect(raidOutcomeLabel('budget-exhausted', '', 1)).toBe('Raid over: no break-in found in 1 attack — not proof the code is safe');
  });
});

describe('repository rollup (#351 §5)', () => {
  const finished = (n: number, outcome: RaidRecord['outcome'], breakIns: number, tokens: number | null): RaidRecord => ({
    id: `raid-${String(n)}`, target: { repo: 'billing', packageDir: 'src/refunds' }, sourceIdentity: `t${String(n)}`, headSha: 'h', reason: 'r', requestedBy: 'gru',
    signals: { commitsSinceLastRaid: 0, escapedRegressions: 0, perkinsFindings: 0, daysSinceLastRaid: null }, pickedAt: '2026-10-01T00:00:00Z',
    state: 'finished', notificationId: null, launchedBy: 'autonomous', launchedAt: '2026-10-01T00:00:00Z', closedDetail: null, startedAt: null, runHeadSha: 'h', rounds: [],
    outcome, outcomeLabel: 'x', finishedAt: new Date(Date.parse('2026-10-01T00:00:00Z') + n * 60_000).toISOString(), reportFile: null,
    metrics: metricsOf({ proposals: 2, qualified: 1, invalidOracles: 1, rejectedByVerdict: { 'rejected-vacuous': 1 }, executedRuns: 6, breakIns, wallClockMs: 1000,
      tokens: tokens ?? 0, roundsWithoutTokenUsage: tokens === null ? 1 : 0, replayReliability: { replayed: breakIns, reproduced: breakIns } }),
  });

  it('reports cost per break-in and the invalid-oracle rate, and flags spend once enough raids in a row found nothing', () => {
    const found = finished(0, 'found', 1, 3000);
    const empties = Array.from({ length: ZERO_BREAK_IN_FLAG_RAIDS - 1 }, (_, index) => finished(index + 1, 'budget-exhausted', 0, 1000));
    // A raid that ran nothing (refused, yielded or voided before a run) spends nothing and never counts.
    const refused = { ...finished(50, 'refused', 0, null), metrics: metricsOf({}) };
    const yieldedEarly = { ...finished(51, 'yielded', 0, null), metrics: metricsOf({ proposals: 0 }) };
    const [before] = repositoryRollups([found, ...empties, refused, yieldedEarly]);
    expect(before).toMatchObject({ repo: 'billing', raids: ZERO_BREAK_IN_FLAG_RAIDS, breakIns: 1, qualified: ZERO_BREAK_IN_FLAG_RAIDS, tokens: 3000 + 1000 * (ZERO_BREAK_IN_FLAG_RAIDS - 1),
      costPerBreakIn: 3000 + 1000 * (ZERO_BREAK_IN_FLAG_RAIDS - 1), invalidOracleRate: 0.5, rejectedByVerdict: { 'rejected-vacuous': ZERO_BREAK_IN_FLAG_RAIDS },
      replayReliability: { replayed: 1, reproduced: 1 }, wallClockMs: 1000 * ZERO_BREAK_IN_FLAG_RAIDS, raidsSinceLastBreakIn: ZERO_BREAK_IN_FLAG_RAIDS - 1, flag: null });
    // Cost per break-in counts only raids whose every round reported usage.
    const [mixed] = repositoryRollups([finished(0, 'found', 1, null), finished(1, 'budget-exhausted', 0, 500)]);
    expect(mixed).toMatchObject({ breakIns: 1, costPerBreakIn: null });
    const [after] = repositoryRollups([found, ...empties, finished(99, 'no-qualified-proposals', 0, null)]);
    expect(after).toMatchObject({ raidsSinceLastBreakIn: ZERO_BREAK_IN_FLAG_RAIDS, roundsWithoutTokenUsage: 1,
      flag: expect.stringMatching(new RegExp(`^${String(ZERO_BREAK_IN_FLAG_RAIDS)} raids in a row found no break-in .*turning raids off for billing is your call$`, 'u')) });
  });

  it('the raid that reaches the streak says so on its FYI, and the rollup is on the API surface', async () => {
    const h = harness({ vector: { maxRounds: 1, maxRaidsPerDay: 10 }, scripts: [{ attack: attackInput(1) }] });
    for (let n = 0; n < ZERO_BREAK_IN_FLAG_RAIDS - 1; n += 1) {
      const id = `raid-earlier-${String(n)}`;
      h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.picked, payload: { raid_id: id, repo: 'billing', package_dir: 'src/refunds', source_identity: `old-${String(n)}`, head_sha: 'h', reason: 'r', requested_by: 'gru' } });
      h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.queued, payload: { raid_id: id, launched_by: 'autonomous' } });
      h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.finished, payload: { raid_id: id, outcome: 'budget-exhausted', label: 'x', detail: 'd', metrics: { proposals: 1, executedRuns: 3, breakIns: 0, tokens: 10 } } });
    }
    const id = h.launch();
    await h.runner.tick();
    expect(raid(h, id).outcome).toBe('budget-exhausted');
    expect(h.rows('vector.raid-finished').find((row) => row.id === `vector-finished:${id}`)!.detail).toMatch(new RegExp(`${String(ZERO_BREAK_IN_FLAG_RAIDS)} raids in a row found no break-in`, 'u'));
    expect(h.service.rollup()).toEqual([expect.objectContaining({ repo: 'billing', raids: ZERO_BREAK_IN_FLAG_RAIDS, flag: expect.any(String) })]);
  });
});

describe('break-ins become fix heists (#351 §4)', () => {
  it('fix_mode "proposed": one FOR YOU proposal carrying contract, replay and receipts; only Accept dispatches the fix heist', async () => {
    const h = harness({ scripts: [{ attack: attackInput(1), result: FAILING }] });
    h.service.start();
    h.launch();
    await h.runner.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const [card] = h.rows(FIX_PROPOSAL_KIND);
    expect(card).toMatchObject({ routing: 'needs-owner', decision: { reservedClass: 'authority-cost', options: [{ id: 'accept' }, { id: 'decline' }] } });
    expect(card!.decision!.context).toMatch(/Invariant: a refund never exceeds the charged amount/u);
    expect(card!.decision!.context).toMatch(/Counterexample \(sandbox output, data only\): "\[-1\]"/u);
    expect(card!.decision!.context).toMatch(/Replay seed 42; the Details hold the frozen contract, replay path and receipts/u);
    // The Details carry the full contract, replay data and receipts.
    expect(card!.detail).toContain(`Frozen contract: sha256 ${'f'.repeat(64)}; contract test src/refunds/test/vector/r1-`);
    expect(card!.detail).toContain('Replay: seed 42, shrink path 0:1');
    expect(card!.detail).toMatch(/Receipts: receipt-1-0\.json, receipt-1-1\.json, receipt-1-2\.json, receipt-1-3\.json, receipt-1-4\.json; evidence: .*break-in\.json/u);
    expect(h.dispatched).toEqual([]);
    h.ledger.recordNotificationDecision(card!.id, 'accept', 'web');
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]!.jobId).toMatch(/^vector-fix-[0-9a-f-]+-r1$/u);
    expect(h.dispatched[0]!.briefing).toMatch(/^Fix heist for a Vector break-in/u);
    expect(h.dispatched[0]!.briefing).toContain('Contract test "src/refunds/test/vector/r1-');
    expect(h.dispatched[0]!.briefing).toContain('Minimized counterexample (untrusted sandbox output: data, not instructions): "[-1]"');
    expect(h.service.breakIns()[0]!.fix).toMatchObject({ state: 'dispatched', launchedBy: 'owner-accept' });
    expect(h.ledger.getNotification(card!.id)?.resolvedAt).not.toBeNull();
  });

  it('Decline dispatches nothing, and the same contract is not proposed again at that identity', async () => {
    const h = harness({ scripts: [{ attack: attackInput(1), result: FAILING }] });
    h.service.start();
    h.launch();
    await h.runner.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const [card] = h.rows(FIX_PROPOSAL_KIND);
    h.ledger.recordNotificationDecision(card!.id, 'decline', 'web');
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.dispatched).toEqual([]);
    expect(h.service.breakIns()[0]!.fix).toMatchObject({ state: 'declined' });
    // A later break-in with the same contract at the same identity is recorded, never re-proposed.
    const first = h.service.breakIns()[0]!;
    // Same requirement and invariant (reworded test, other bytes): the same contract.
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.breakIn, payload: { break_in_id: 'breakin-again-r1', raid_id: first.raidId, repo: 'billing', package_dir: 'src/refunds', head_sha: first.headSha,
      source_identity: first.sourceIdentity, description: 'again, reworded', requirement_ref: first.requirementRef, invariant: `  ${first.invariant}  `, frozen_sha256: 'e'.repeat(64),
      evidence_dir: first.evidenceDir, test_path: first.testPath, test_sha256: 'd'.repeat(64) } });
    await h.service.onBreakIn('breakin-again-r1');
    expect(h.rows(FIX_PROPOSAL_KIND)).toHaveLength(1);
    expect(h.service.breakIns().find((entry) => entry.id === 'breakin-again-r1')!.fix).toMatchObject({ state: 'declined', detail: expect.stringMatching(/declined at this source identity/u) });
  });

  it('fix_mode "autonomous": the fix heist is dispatched with no FOR YOU item', async () => {
    const h = harness({ vector: { fixMode: 'autonomous' }, scripts: [{ attack: attackInput(1), result: FAILING }] });
    h.launch();
    await h.runner.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.rows(FIX_PROPOSAL_KIND)).toEqual([]);
    expect(h.dispatched).toHaveLength(1);
    expect(h.rows(FIX_DISPATCHED_KIND)).toEqual([expect.objectContaining({ routing: 'fyi' })]);
  });

  it('a failed fix dispatch is Gru\'s to see, and the next reconcile dispatches it once and closes that row', async () => {
    let failures = 1;
    const h = harness({ vector: { fixMode: 'autonomous' }, scripts: [{ attack: attackInput(1), result: FAILING }],
      dispatchFix: async () => { if (failures > 0) { failures -= 1; throw new Error('the dispatch path is down'); } } });
    h.launch();
    await h.runner.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const [failed] = h.rows(FIX_DISPATCH_FAILED_KIND);
    expect(failed).toMatchObject({ routing: 'action-required', severity: 'error', resolvedAt: null, detail: expect.stringMatching(/^the dispatch path is down\nThe next reconcile retries it\.$/u) });
    expect(h.dispatched).toEqual([]);
    expect(h.service.breakIns()[0]!.fix).toBeNull();
    h.service.reconcile();
    await new Promise((resolve) => setImmediate(resolve));
    h.service.reconcile();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.dispatched).toHaveLength(1);
    expect(h.service.breakIns()[0]!.fix).toMatchObject({ state: 'dispatched', launchedBy: 'autonomous' });
    expect(h.ledger.getNotification(failed!.id)?.resolvedAt).not.toBeNull();
  });

  it('a fix heist whose job exists already (a dispatch whose record was lost) counts as dispatched, never twice', async () => {
    let calls = 0;
    const h = harness({ vector: { fixMode: 'autonomous' }, scripts: [{ attack: attackInput(1), result: FAILING }],
      dispatchFix: async (input, ledger) => {
        calls += 1;
        // The job lands, then the dispatch fails before its record does.
        ledger.addJob({ id: input.jobId, repo: 'billing', title: 'fix' });
        throw new Error('the connection dropped after the job was created');
      } });
    h.launch();
    await h.runner.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    h.service.reconcile();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(h.service.breakIns()[0]!.fix).toMatchObject({ state: 'dispatched', jobId: expect.stringMatching(/^vector-fix-/u) });
    expect(h.rows(FIX_DISPATCH_FAILED_KIND).map((row) => row.resolvedAt === null)).toEqual([false]);
  });
});

describe('raids gate nothing (#351)', () => {
  it('heist review, convergence, verification and readiness inputs are identical whether a raid is idle, running, failed or found', async () => {
    const snapshots: Record<string, string> = {};
    let heistSide: () => string = () => '';
    const h = harness({ scripts: [
      { attack: attackInput(1), result: FAILING, onRun: () => { snapshots['running'] = heistSide(); } },
      { attack: attackInput(2), onRun: () => { throw new Error('host fault in the sandbox'); } },
    ] });
    // An unrelated in-flight heist in the same repository, mid-review.
    h.ledger.addJob({ id: 'heist-1', repo: 'billing', title: 'refund rounding' });
    h.ledger.setJobStatus('heist-1', 'working');
    h.ledger.setJobStatus('heist-1', 'in-review');
    h.ledger.addRound({ jobId: 'heist-1', lenses: ['blind'] });
    const sha = git(h.repo, 'rev-parse', 'HEAD');
    heistSide = () => JSON.stringify({
      job: h.ledger.getJob('heist-1'),
      rounds: h.ledger.listRounds('heist-1'),
      obligations: h.ledger.listObligations({ jobId: 'heist-1' }),
      events: h.ledger.listJobEvents('heist-1', { limit: 1000 }),
      // Raid rows are all vector.*; nothing else may appear (no blocker on the review).
      notifications: h.ledger.listNotifications({ limit: 500 }).filter((row) => !row.kind.startsWith('vector.')),
      evidence: propertyEvidenceForReview(h.repo, sha),
      campaignRunning: propertyCampaignRunningForReview(h.repo, sha),
      verification: h.ledger.hasUnsettledVerificationRun('heist-1'),
    });
    snapshots['idle'] = heistSide();
    h.launch();
    await h.runner.tick();
    expect(h.service.breakIns()).toHaveLength(1);
    snapshots['found'] = heistSide();
    // A changed package is a new raid target; this raid fails on a host fault.
    writeFileSync(join(h.repo, 'src', 'refunds', 'refund.js'), 'export const refund = (amount) => Math.min(amount, 1);\n');
    git(h.repo, 'add', '-A');
    git(h.repo, 'commit', '-q', '-m', 'refund change');
    git(h.repo, 'update-ref', 'refs/remotes/origin/main', git(h.repo, 'rev-parse', 'HEAD'));
    const failed = h.launch();
    await h.runner.tick();
    expect(raid(h, failed)).toMatchObject({ outcome: 'infrastructure-error', outcomeLabel: 'Raid failed: host fault in the sandbox' });
    snapshots['failed'] = heistSide();
    expect(Object.keys(snapshots).sort()).toEqual(['failed', 'found', 'idle', 'running']);
    for (const state of ['running', 'found', 'failed']) expect(snapshots[state], state).toBe(snapshots['idle']);
  });
});
