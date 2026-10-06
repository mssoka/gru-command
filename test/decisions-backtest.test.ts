import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DECISIONS_CONFIG, loadConfig, type DecisionsConfig } from '../src/config.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  backtestRecordFromReport,
  countRecordedResponses,
  defaultCasesPath,
  readCasesJsonl,
  replayingFetch,
  runBacktest,
  saveBacktestRecord,
  type BacktestReport,
} from '../src/decisions/backtest.js';
import { assertEnforceGate, backtestRecordPath, EnforceGateError } from '../src/decisions/enforce.js';
import { extractEscalationTriageCases } from '../src/decisions/cases/escalation-triage-extract.js';
import { extractSameBlockerCases, findingCarryKey } from '../src/decisions/cases/same-blocker-extract.js';
import { extractReportConclusionCases } from '../src/decisions/cases/report-conclusion-extract.js';
import { surfaceCaseSpec, requestFromCase, type LabelledCase } from '../src/decisions/cases/registry.js';
import { buildYieldReport, computeDecisionShadowMeasures, renderTextReport, type LedgerEventRecord } from '../src/telemetry/yield.js';

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function decisionsConfig(): DecisionsConfig {
  return {
    jev: { ...DEFAULT_DECISIONS_CONFIG.jev, enabled: false },
    providers: {},
    surfaces: {},
    thresholds: {
      read_only: { ...DEFAULT_DECISIONS_CONFIG.thresholds.read_only },
      operational: { ...DEFAULT_DECISIONS_CONFIG.thresholds.operational },
      destructive: { ...DEFAULT_DECISIONS_CONFIG.thresholds.destructive },
    },
  };
}

// ------------------------------------------------------------------
// Escalation-triage extractor over a real ledger fixture
// ------------------------------------------------------------------

describe('escalation-triage case extractor (issue #223)', () => {
  it('labels wakes from Gru outcomes and skips ambiguous evidence', () => {
    const dataDir = temp('gru-backtest-escalation-');
    const db = new LedgerDb(dataDir);
    try {
      const insertEvent = db.handle.prepare(
        'INSERT INTO events (ts, kind, agent_id, job_id, round_id, lens, payload) VALUES (?, ?, NULL, NULL, NULL, NULL, ?)',
      );
      insertEvent.run('2026-10-01T02:00:00.000Z', 'gru.wake', JSON.stringify({ notification_ids: ['n1'], count: 1, mode: 'action-required' }));
      insertEvent.run('2026-10-01T02:05:00.000Z', 'notification.resolved', JSON.stringify({ id: 'n1', by: 'gru', detail: 'duplicate of a covered item — nothing actionable' }));
      insertEvent.run('2026-10-01T03:00:00.000Z', 'gru.wake', JSON.stringify({ notification_ids: ['n2'], count: 1, mode: 'action-required' }));
      db.handle.prepare('INSERT INTO events (ts, kind, agent_id, job_id, round_id, lens, payload) VALUES (?, ?, NULL, ?, NULL, NULL, ?)')
        .run('2026-10-01T03:10:00.000Z', 'silas.directive-sent', 'job-2', JSON.stringify({ request_id: 'r1' }));
      insertEvent.run('2026-10-01T04:00:00.000Z', 'gru.wake', JSON.stringify({ notification_ids: ['n3'], count: 1, mode: 'action-required' }));
      const insertNotification = db.handle.prepare(
        'INSERT INTO notifications (id, ts, kind, routing, severity, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      insertNotification.run('n1', '2026-10-01T01:59:00.000Z', 'silas.escalated:job-1', 'action', 'error', 'typecheck failed', 'ONE scheduled typecheck RAN');
      insertNotification.run('n2', '2026-10-01T02:59:00.000Z', 'silas.escalated:job-2', 'action', 'error', 'proposal ready', 'compiler-diagnostic proposal needs a ruling');
      insertNotification.run('n3', '2026-10-01T03:59:00.000Z', 'silas.escalated:job-3', 'action', 'error', 'unclear', 'no follow-up ever recorded');

      const cases = extractEscalationTriageCases(db.handle as never);
      expect(cases.map((c) => c.label)).toEqual(['defer_ok', 'needs_ruling']);
      expect(cases[0]!.id).toMatch(/^escalation-wake-\d+$/u);
      const state = JSON.parse(cases[0]!.state) as { escalations: { kind: string; detail: string }[] };
      expect(state.escalations[0]!.kind).toBe('silas.escalated:job-1');
      // The ambiguous third wake is never guessed into a label.
      expect(cases.some((c) => c.state.includes('job-3'))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('requires a linked dispatch and ignores unrelated Silas actions in the same wake window', () => {
    const dir = temp('gru-backtest-attribution-');
    const db = new LedgerDb(dir);
    try {
      const add = db.handle.prepare('INSERT INTO events (ts, kind, agent_id, job_id, round_id, lens, payload) VALUES (?, ?, NULL, ?, NULL, NULL, ?)');
      add.run('2026-10-01T00:00:00Z', 'gru.wake', null, JSON.stringify({ notification_ids: ['n1'] }));
      add.run('2026-10-01T00:01:00Z', 'silas.directive-sent', 'unrelated', '{}');
      add.run('2026-10-01T00:02:00Z', 'notification.resolved', null, JSON.stringify({ id: 'n1', detail: 'duplicate' }));
      add.run('2026-10-01T01:00:00Z', 'gru.wake', null, JSON.stringify({ notification_ids: ['n2'] }));
      add.run('2026-10-01T01:01:00Z', 'job.created', 'job-2', '{}');
      const notification = db.handle.prepare('INSERT INTO notifications (id, ts, kind, routing, severity, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?)');
      notification.run('n1', '2026-10-01T00:00:00Z', 'silas.escalated:job-1', 'action', 'error', 'duplicate', 'already covered');
      notification.run('n2', '2026-10-01T01:00:00Z', 'silas.escalated:job-2', 'action', 'error', 'dispatch', 'needs work');
      expect(extractEscalationTriageCases(db.handle as never).map((c) => c.label)).toEqual(['defer_ok', 'needs_ruling']);
    } finally { db.close(); }
  });
});

// ------------------------------------------------------------------
// Artifact-based extractors
// ------------------------------------------------------------------

function finding(overrides: Partial<{ title: string; category: string; location: string; severity: string; detail: string; roundOrigin: number }> = {}): Record<string, unknown> {
  return {
    source: 'adversarial',
    severity: 'warning',
    category: 'crash',
    title: 'Null deref on empty list',
    location: 'src/a.ts',
    evidence: 'e',
    detail: 'd',
    recommended_fix: 'f',
    roundOrigin: 1,
    ...overrides,
  };
}

function writeConsolidated(root: string, roundId: string, verdict: string, findings: readonly unknown[], targetSha: string): void {
  mkdirSync(join(root, roundId), { recursive: true });
  writeFileSync(join(root, roundId, 'consolidated.json'), `${JSON.stringify({
    schemaVersion: 3,
    architecture: 'perkins-whole-pr',
    canonicalVerdict: verdict,
    complete: true,
    headMoved: false,
    findings,
    priorDispositions: [],
    frozen: { targetSha, createdAt: roundId === 'round-b' ? '2026-10-02T00:00:00Z' : '2026-10-01T00:00:00Z' },
    specialistRuns: [],
  }, null, 2)}\n`);
}

describe('same-blocker case extractor (issue #223)', () => {
  it('pairs carried blockers as same and overlapping fresh blockers as different', () => {
    const root = temp('gru-backtest-blocker-');
    writeConsolidated(root, 'round-a', 'NEEDS CHANGES', [
      finding({ title: 'Null deref on empty list', location: 'src/a.ts', category: 'crash', roundOrigin: 1 }),
    ], 'sha-a');
    writeConsolidated(root, 'round-b', 'NEEDS CHANGES', [
      // Carried: same normalized title+location key as round-a's finding.
      finding({ title: 'null deref on empty list', location: 'src/a.ts', category: 'crash', roundOrigin: 1 }),
      // Fresh this round: overlaps file+category with round-a's finding
      // but a different carry key — the lead kept them separate.
      finding({ title: 'Null deref on EMPTY MAP', location: 'src/a.ts', category: 'crash', roundOrigin: 2 }),
    ], 'sha-a');
    const cases = extractSameBlockerCases(root);
    expect(cases.map((c) => c.label).sort()).toEqual(['different', 'same']);
    const same = cases.find((c) => c.label === 'same')!;
    expect((JSON.parse(same.state) as { prior_finding: { title: string } }).prior_finding.title).toBe('Null deref on empty list');
  });

  it('keeps carried-only rounds and same-file negatives at different line locations', () => {
    const root = temp('gru-backtest-blocker-carried-');
    writeConsolidated(root, 'round-a', 'NEEDS CHANGES', [finding({ location: 'src/a.ts:10' })], 'sha-a');
    writeConsolidated(root, 'round-b', 'NEEDS CHANGES', [
      finding({ location: 'src/a.ts:10' }),
      finding({ title: 'Another crash', location: 'src/a.ts:20', roundOrigin: 2 }),
    ], 'sha-a');
    expect(extractSameBlockerCases(root).map((c) => c.label).sort()).toEqual(['different', 'same']);
    const carried = extractSameBlockerCases(root).find((c) => c.label === 'same')!;
    expect(carried.state).not.toContain('round_origin');
  });

  it('pairs a carried-only later round even though every finding has the old origin', () => {
    const root = temp('gru-backtest-blocker-carry-only-');
    writeConsolidated(root, 'round-a', 'NEEDS CHANGES', [finding({ roundOrigin: 1 })], 'sha-a');
    writeConsolidated(root, 'round-b', 'NEEDS CHANGES', [finding({ roundOrigin: 1 })], 'sha-a');
    expect(extractSameBlockerCases(root).map((c) => c.label)).toEqual(['same']);
  });

  it('ignores rounds of different targets, invalid files, and single-round groups', () => {
    const root = temp('gru-backtest-blocker-none-');
    writeConsolidated(root, 'round-x', 'NEEDS CHANGES', [finding()], 'sha-x');
    mkdirSync(join(root, 'round-y'), { recursive: true });
    writeFileSync(join(root, 'round-y', 'consolidated.json'), '{broken');
    expect(extractSameBlockerCases(root)).toEqual([]);
    expect(findingCarryKey({ title: '  A  B ', location: 'p/q.ts' })).toBe(findingCarryKey({ title: 'a b', location: 'P/Q.TS' }));
  });
});

describe('report-conclusion case extractor (issue #223)', () => {
  it('uses delivered report handbacks, excludes the verdict from state, and ignores review rounds', () => {
    const root = temp('gru-backtest-report-');
    for (const [id, verdict] of [['r-pass', 'READY TO MERGE'], ['r-changes', 'NEEDS CHANGES'], ['r-incomplete', 'INCOMPLETE']] as const) {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, 'handback.json'), JSON.stringify({
        schemaVersion: 1, jobId: id, deliverable: 'review',
        report: `Found concrete evidence in the submitted work.\n**Verdict: ${verdict}**`,
      }));
    }
    writeConsolidated(root, 'perkins-round', 'READY TO MERGE', [], 'sha-p');
    const cases = extractReportConclusionCases(root);
    expect(cases.map((c) => [c.id, c.label])).toEqual([
      ['reportconclusion-r-changes', 'findings_need_action'],
      ['reportconclusion-r-incomplete', 'inconclusive'],
      ['reportconclusion-r-pass', 'clean_pass'],
    ]);
    expect(cases.every((c) => !c.state.includes('Verdict') && !c.state.includes('READY TO MERGE'))).toBe(true);
  });
});

// ------------------------------------------------------------------
// Backtest engine: record → replay offline
// ------------------------------------------------------------------

/** Provider stub for the escalation_triage surface: defers (low
 * confidence status_report) exactly when the case's escalation text says
 * "duplicate", rules otherwise. */
function escalationFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { state: string };
    const defer = body.state.includes('duplicate');
    const answer = {
      model: 'laya-421m-test',
      answers: {
        triage: defer
          ? { type: 'choice', choice: 'status_report', probabilities: { needs_ruling: 0, needs_owner: 0, status_report: 1, covered_by_open_item: 0 }, confidence: 0.94 }
          : { type: 'choice', choice: 'needs_ruling', probabilities: { needs_ruling: 1, needs_owner: 0, status_report: 0, covered_by_open_item: 0 }, confidence: 0.94 },
        needs_decision: defer ? { type: 'noul', noul: 0.1 } : { type: 'noul', noul: 0.97 },
      },
      usage: { input_tokens: 100, output_tokens: 10, cost: 0.0001 },
    };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
}

const ESCALATION_CASES: LabelledCase[] = [
  { id: 'c1', state: JSON.stringify({ escalations: [{ detail: 'duplicate of covered work' }] }), label: 'defer_ok' },
  { id: 'c2', state: JSON.stringify({ escalations: [{ detail: 'proposal needs a ruling' }] }), label: 'needs_ruling' },
  { id: 'c3', state: JSON.stringify({ escalations: [{ detail: 'resolved duplicate, nothing actionable' }] }), label: 'defer_ok' },
];

describe('backtest engine (issue #223)', () => {
  it('computes agreement, action precision/recall, calibration, cost and latency; records then replays offline', async () => {
    const recordDir = temp('gru-backtest-record-');
    const live = await runBacktest({
      surface: 'escalation_triage',
      profileName: 'local',
      cases: ESCALATION_CASES,
      config: decisionsConfig(),
      instanceDir: temp('gru-backtest-instance-'),
      env: {},
      fetchImpl: escalationFetch(),
      recordDir,
      now: () => new Date('2026-10-06T00:00:00.000Z'),
    });
    expect(live.n).toBe(3);
    // Two defer predictions vs an always-act baseline → 1/3 agreement.
    expect(live.agreement).toBeCloseTo(1 / 3);
    expect(live.actions.act).toEqual({ predicted: 1, correct: 1 });
    expect(live.actions.defer).toEqual({ predicted: 2, correct: 2 });
    expect(live.precision.actionable).toBe(1); // actionable class = needs_ruling → act
    expect(live.recall.actionable).toBe(1);
    expect(live.precision.defer).toBe(1);
    expect(live.recall.defer).toBe(1);
    expect(live.calibration.reduce((total, bucket) => total + bucket.n, 0)).toBe(3);
    expect(live.calibration.find((bucket) => bucket.lo === 0.8)!.n).toBe(3);
    expect(live.costUsd).toBeCloseTo(0.0003);
    expect(live.latencyMs.p50).toBeGreaterThanOrEqual(0);
    expect(live.latencyMs.p95).toBeGreaterThanOrEqual(live.latencyMs.p50);
    expect(live.replayed).toBe(false);
    expect(countRecordedResponses(recordDir)).toBe(3);

    const replay = await runBacktest({
      surface: 'escalation_triage',
      profileName: 'local',
      cases: ESCALATION_CASES,
      config: decisionsConfig(),
      instanceDir: temp('gru-backtest-instance-2-'),
      env: {},
      replayDir: recordDir,
      now: () => new Date('2026-10-06T00:00:00.000Z'),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.agreement).toBe(live.agreement);
    expect(replay.actions).toEqual(live.actions);
    expect(replay.costUsd).toBeCloseTo(live.costUsd);
  });

  it('rejects a live provider fallback before it can become enforce evidence', async () => {
    await expect(runBacktest({
      surface: 'escalation_triage', profileName: 'local', cases: ESCALATION_CASES,
      config: decisionsConfig(), instanceDir: temp('i'), env: {},
      fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
    })).rejects.toThrow(/live backtest provider fell back/u);
  });

  it('scores chosen answers and deterministic fallback actions rather than route bands', async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const same = Object.hasOwn(body.questions, 'same_defect');
      const answers = same
        ? { same_defect: { type: 'noul', noul: 0.96 } }
        : { conclusion: { type: 'choice', choice: 'clean_pass', probabilities: { clean_pass: 1, findings_need_action: 0, inconclusive: 0 }, confidence: 0.95 } };
      return new Response(JSON.stringify({ model: 'laya-421m', answers }), { status: 200 });
    }) as typeof fetch;
    const same = await runBacktest({ surface: 'same_blocker', profileName: 'local',
      cases: [{ id: 'same', state: '{}', label: 'same' }], config: decisionsConfig(),
      instanceDir: temp('same-i'), env: {}, fetchImpl });
    const report = await runBacktest({ surface: 'report_conclusion', profileName: 'local',
      cases: [{ id: 'pass', state: '{}', label: 'clean_pass' }], config: decisionsConfig(),
      instanceDir: temp('report-i'), env: {}, fetchImpl });
    expect(same.actions.defer).toEqual({ predicted: 1, correct: 1 });
    expect(report.actions.defer).toEqual({ predicted: 1, correct: 1 });
    expect(same.agreement).toBe(0);
    expect(report.agreement).toBe(0);
  });

  it('uses the baseline action for a fallback-band provider answer', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: 'laya-421m', answers: {
        triage: { type: 'choice', choice: 'status_report', probabilities: { needs_ruling: 0, needs_owner: 0, status_report: 1, covered_by_open_item: 0 }, confidence: 0.1 },
        needs_decision: { type: 'noul', noul: 0.1 },
      },
    }), { status: 200 })) as typeof fetch;
    const report = await runBacktest({ surface: 'escalation_triage', profileName: 'local',
      cases: [{ id: 'c', state: '{}', label: 'needs_ruling' }], config: decisionsConfig(),
      instanceDir: temp('fallback-i'), env: {}, fetchImpl });
    expect(report.actions.act).toEqual({ predicted: 1, correct: 1 });
    expect(report.agreement).toBe(1);
  });

  it('a replay miss fails loud instead of inventing an answer, and unknown profiles/surfaces/labels are rejected', async () => {
    const fetch = replayingFetch(temp('gru-backtest-empty-'));
    await expect(fetch('https://x', { body: '{}' } as RequestInit)).rejects.toThrow(/replay miss/u);
    await expect(runBacktest({
      surface: 'escalation_triage', profileName: 'nope', cases: ESCALATION_CASES,
      config: decisionsConfig(), instanceDir: temp('i'), env: {},
    })).rejects.toThrow(/unknown decision profile/u);
    await expect(runBacktest({
      surface: 'nope', profileName: 'local', cases: ESCALATION_CASES,
      config: decisionsConfig(), instanceDir: temp('i'), env: {},
    })).rejects.toThrow(/unknown backtest surface/u);
    // An out-of-vocabulary label fails loud before any provider spend.
    await expect(runBacktest({
      surface: 'escalation_triage', profileName: 'local', cases: [{ ...ESCALATION_CASES[0]!, label: 'bogus' }],
      config: decisionsConfig(), instanceDir: temp('i'), env: {}, fetchImpl: escalationFetch(),
    })).rejects.toThrow(/outside the escalation_triage vocabulary/u);
    // A replay run over an incomplete recording set fails loud instead of
    // producing a fallback-flavored bogus report.
    await expect(runBacktest({
      surface: 'escalation_triage', profileName: 'local', cases: ESCALATION_CASES,
      config: decisionsConfig(), instanceDir: temp('i'), env: {}, replayDir: temp('gru-backtest-empty-2-'),
    })).rejects.toThrow(/recording set is incomplete/u);
  });

  it('saves the enforce evidence with its stated threshold and the gate honors it end to end', async () => {
    const dataDir = temp('gru-backtest-save-');
    const report: BacktestReport = await runBacktest({
      surface: 'escalation_triage',
      profileName: 'local',
      cases: ESCALATION_CASES,
      config: decisionsConfig(),
      instanceDir: temp('gru-backtest-save-instance-'),
      env: {},
      fetchImpl: escalationFetch(),
      now: () => new Date('2026-10-06T00:00:00.000Z'),
    });
    const record = backtestRecordFromReport(report, { metric: 'precision', label: null, min: 0.9 });
    saveBacktestRecord(dataDir, record);
    expect(JSON.parse(readFileSync(backtestRecordPath(dataDir, 'escalation_triage'), 'utf8'))).toMatchObject({ n: 3, met: true });
    expect(assertEnforceGate({ dataDir, surface: 'escalation_triage', provider: 'local', model: 'laya-421m' }).n).toBe(3);
    const stricter = backtestRecordFromReport(report, { metric: 'agreement', label: null, min: 0.9 });
    expect(stricter.met).toBe(false);
    saveBacktestRecord(dataDir, stricter);
    expect(() => assertEnforceGate({ dataDir, surface: 'escalation_triage', provider: 'local', model: 'laya-421m' })).toThrow(EnforceGateError);
  });

  it('rebuilds the surface request from a case state with the canonical questions and baseline', () => {
    const spec = surfaceCaseSpec('same_blocker');
    const request = requestFromCase(spec, '{"prior_finding":{}}');
    expect(Object.keys(request.questions)).toEqual(['same_defect']);
    expect((request.fallback.same_defect as { noul: number }).noul).toBe(0);
    expect(request.state).toBe('{"prior_finding":{}}');
  });
});

// ------------------------------------------------------------------
// Yield telemetry: shadow disagreement per surface and provider
// ------------------------------------------------------------------

describe('yield report shadow measures (issue #223)', () => {
  const events: LedgerEventRecord[] = [
    { seq: 1, ts: '2026-10-01T00:00:01.000Z', kind: 'decisions.shadow', jobId: null, payload: { surface: 'event_triage', provider: 'local', disagrees: true, provenance_source: 'jev', latency_ms: 100, cost: 0.001 } },
    { seq: 2, ts: '2026-10-01T00:00:02.000Z', kind: 'decisions.shadow', jobId: null, payload: { surface: 'event_triage', provider: 'local', disagrees: false, provenance_source: 'jev', latency_ms: 300, cost: 0.001 } },
    { seq: 3, ts: '2026-10-01T00:00:03.000Z', kind: 'decisions.shadow', jobId: null, payload: { surface: 'supervision_guidance', provider: 'openrouter-jev', disagrees: false, provenance_source: 'deterministic', latency_ms: 5, cost: null } },
    { seq: 4, ts: '2026-10-01T00:00:04.000Z', kind: 'gru.wake', jobId: null, payload: { notification_ids: [], count: 0 } },
  ];

  it('aggregates disagreement rates per surface and provider', () => {
    const measures = computeDecisionShadowMeasures(events);
    expect(measures.records).toBe(3);
    const triage = measures.bySurfaceProvider.find((row) => row.surface === 'event_triage')!;
    expect(triage).toMatchObject({ provider: 'local', records: 2, disagreements: 1, disagreementShare: 0.5, providerMisses: 0 });
    expect(triage.latencyP50Ms).toBe(100);
    expect(triage.latencyP95Ms).toBe(300);
    const supervision = measures.bySurfaceProvider.find((row) => row.surface === 'supervision_guidance')!;
    expect(supervision).toMatchObject({ records: 1, disagreements: 0, providerMisses: 1 });
  });

  it('flows through buildYieldReport and the text renderer, skipping torn rows', () => {
    const report = buildYieldReport({
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-02T00:00:00.000Z',
      generatedAt: '2026-10-02T00:00:00.000Z',
      parseSkips: { unparsableLines: 0, unattributedCompactions: 0 },
      turns: [],
      sweepSignatures: [],
      ledger: { since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T00:00:00.000Z', events: [...events, { seq: 5, ts: '2026-10-01T00:00:05.000Z', kind: 'decisions.shadow', jobId: null, payload: 'torn' }], notifications: [], jobs: [] },
    });
    expect(report.decisionsShadow.records).toBe(3);
    const text = renderTextReport(report);
    expect(text).toContain('Decisions (shadow');
    expect(text).toContain('event_triage / local');
    expect(text).toContain('50.0%');
  });
});

// ------------------------------------------------------------------
// CLI seam (compiled dist, like decisions-cli.test.ts)
// ------------------------------------------------------------------

describe('decisions CLI backtest/extract seam (issue #223)', () => {
  const CLI = join(process.cwd(), 'dist', 'decisions', 'cli.js');

  function cliEnv(instance: string): NodeJS.ProcessEnv {
    return { ...process.env, HOME: temp('gru-backtest-cli-home-'), GRU_COMMAND_HOME: instance, OPENROUTER_API_KEY: undefined };
  }

  it('extract-cases writes JSONL and backtest --replay reports offline; --save writes enforce evidence', async () => {
    const dataDir = temp('gru-backtest-cli-data-');
    const instance = join(dataDir, '.gru-command');
    mkdirSync(instance, { recursive: true });
    const env = cliEnv(instance);
    // The CLI loads config from the instance; give it a dataDir via env? The
    // instance IS the default data dir, so point extraction at a fixture
    // ledger explicitly and write cases next to the worktree default.
    const ledgerDir = temp('gru-backtest-cli-ledger-');
    const db = new LedgerDb(ledgerDir);
    try {
      const insertEvent = db.handle.prepare(
        'INSERT INTO events (ts, kind, agent_id, job_id, round_id, lens, payload) VALUES (?, ?, NULL, NULL, NULL, NULL, ?)',
      );
      insertEvent.run('2026-10-01T02:00:00.000Z', 'gru.wake', JSON.stringify({ notification_ids: ['n9'], count: 1, mode: 'action-required' }));
      insertEvent.run('2026-10-01T02:05:00.000Z', 'notification.resolved', JSON.stringify({ id: 'n9', by: 'gru', detail: 'duplicate — nothing actionable' }));
      db.handle.prepare('INSERT INTO notifications (id, ts, kind, routing, severity, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('n9', '2026-10-01T01:59:00.000Z', 'silas.escalated:job-9', 'action', 'error', 't', 'duplicate sweep');
    } finally {
      db.close();
    }
    const casesPath = join(temp('gru-backtest-cli-out-'), 'escalation_triage.jsonl');

    // 1. extract-cases over the fixture ledger.
    const extracted = spawnSync(process.execPath, [CLI, 'extract-cases', '--surface', 'escalation_triage', '--ledger-db', join(ledgerDir, 'ledger', 'ledger.db'), '--out', casesPath], { env, encoding: 'utf8', timeout: 15_000 });
    expect(extracted.status).toBe(0);
    expect(JSON.parse(extracted.stdout)).toMatchObject({ surface: 'escalation_triage', n: 1 });
    const cases = readCasesJsonl(casesPath);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.label).toBe('defer_ok');

    // 2. Record provider responses in-process for the SAME cases/config the
    // CLI will use, then run the CLI backtest fully offline via --replay.
    const recordDir = temp('gru-backtest-cli-record-');
    const config = loadConfig(env, process.env['HOME'] ?? undefined).decisions;
    await runBacktest({
      surface: 'escalation_triage',
      profileName: 'local',
      cases,
      config: { ...config, jev: { ...config.jev } },
      instanceDir: instance,
      env,
      fetchImpl: escalationFetch(),
      recordDir,
    });
    const replayed = spawnSync(process.execPath, [CLI, 'backtest', '--surface', 'escalation_triage', '--profile', 'local', '--cases', casesPath, '--replay', recordDir, '--threshold', '0.5', '--save'], { env, encoding: 'utf8', timeout: 15_000 });
    // A backtest that fails its own stated threshold exits nonzero — the
    // recorded evidence still lands, with met recomputed honestly.
    expect(replayed.status).toBe(1);
    const parsed = JSON.parse(replayed.stdout) as { report: BacktestReport; saved: string };
    expect(parsed.report.n).toBe(1);
    expect(parsed.report.replayed).toBe(true);
    expect(parsed.report.agreement).toBe(0); // defer prediction vs always-act baseline
    expect(parsed.report.precision.actionable).toBe(0);
    expect(existsSync(parsed.saved)).toBe(true);
    expect(JSON.parse(readFileSync(parsed.saved, 'utf8'))).toMatchObject({ n: 1, met: false });
    expect(existsSync(defaultCasesPath(dataDir, 'escalation_triage'))).toBe(false); // explicit --out honored

    // Meeting the stated threshold exits 0.
    const passing = spawnSync(process.execPath, [CLI, 'backtest', '--surface', 'escalation_triage', '--profile', 'local', '--cases', casesPath, '--replay', recordDir, '--threshold', '0', '--save'], { env, encoding: 'utf8', timeout: 15_000 });
    expect(passing.status).toBe(0);
    expect(JSON.parse(passing.stdout).report.agreement).toBe(0);

    // 3. Unknown surface fails loud with the registry in the message.
    const unknown = spawnSync(process.execPath, [CLI, 'backtest', '--surface', 'nope', '--profile', 'local'], { env, encoding: 'utf8', timeout: 15_000 });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown backtest surface');
  }, 30_000);
});
