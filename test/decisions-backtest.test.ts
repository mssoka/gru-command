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
import { choiceProbabilities, EVENT_QUESTIONS, FAILURE_CLASSES } from '../src/decisions/questions.js';
import { decisionRoute } from '../src/decisions/service.js';
import type { Answer, RiskClass } from '../src/decisions/types.js';
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
  // Rows shaped exactly like production `decisions.shadow` payloads: the
  // answers pass production validation and every route is the one
  // decisionRoute builds for its answer. `disagrees` carries what an older
  // recorder stored; the report must ignore it.
  type Path = 'act' | 'confirm' | 'fallback';
  const THRESHOLDS = DEFAULT_DECISIONS_CONFIG.thresholds;
  const ts = (seq: number): string => `2026-10-01T00:00:${String(seq).padStart(2, '0')}.000Z`;
  const shadowRow = (seq: number, payload: Record<string, unknown>): LedgerEventRecord =>
    ({ seq, ts: ts(seq), kind: 'decisions.shadow', jobId: null, payload });
  const noul = (value: number): Answer => ({ type: 'noul', noul: value });
  const choiceOf = (options: readonly string[]) => (value: string, confidence: number): Answer =>
    ({ type: 'choice', choice: value, probabilities: choiceProbabilities(options, value), confidence });
  const score = (level: number, confidence: number): Answer =>
    ({ type: 'score', score: level, probabilities: choiceProbabilities(['0', '1', '2'], String(level)), confidence });
  const routesFor = (answers: Record<string, Answer>, risks: Record<string, RiskClass>, thresholds = THRESHOLDS) =>
    Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, decisionRoute(answer, risks[id]!, thresholds)]));
  const pathOf = (row: LedgerEventRecord, id: string): Path =>
    ((row.payload as { routes: Record<string, { path: Path }> }).routes)[id]!.path;

  const eventClass = choiceOf(EVENT_QUESTIONS.event_class.options);
  const EVENT_RISKS: Record<string, RiskClass> = { needs_action: 'operational', event_class: 'read_only', severity: 'read_only' };
  const EVENT_BASELINE = { needs_action: noul(0), event_class: eventClass('routine_fyi', 1), severity: score(0, 1) };
  function eventAnswered(seq: number, fields: {
    readonly provider?: string;
    readonly model: string;
    readonly needsAction: number;
    readonly eventClass: string;
    readonly storedDisagrees?: boolean;
    readonly latencyMs?: number;
    readonly thresholds?: typeof THRESHOLDS;
  }): LedgerEventRecord {
    const thresholds = fields.thresholds ?? THRESHOLDS;
    const answers = { needs_action: noul(fields.needsAction), event_class: eventClass(fields.eventClass, 0.9), severity: score(0, 1) };
    return shadowRow(seq, {
      surface: 'event_triage', provider: fields.provider ?? 'local', model: fields.model, provenance_source: 'jev',
      answers, routes: routesFor(answers, EVENT_RISKS, thresholds),
      deterministic_answers: EVENT_BASELINE, deterministic_routes: routesFor(EVENT_BASELINE, EVENT_RISKS, thresholds),
      thresholds, fallback_reason: null, disagrees: fields.storedDisagrees ?? false,
      ...(fields.latencyMs === undefined ? {} : { latency_ms: fields.latencyMs }),
      cost: 0.001,
    });
  }
  // A provider miss serves the baseline itself. `cause` undefined: a row
  // predating fallback_reason/request_diagnostics.
  // `phase` undefined: the request_diagnostics field itself is absent.
  function eventMiss(seq: number, latencyMs: number, cause?: { readonly reason: string; readonly phase?: string | null }): LedgerEventRecord {
    const diagnostics = cause?.phase === undefined ? {} : {
      request_diagnostics: cause.phase === null ? null : { phase: cause.phase, timeoutMs: 8000, deadlineExpired: cause.reason === 'timeout', headersMs: null, bodyMs: null, httpStatus: null },
    };
    return shadowRow(seq, {
      surface: 'event_triage', provider: 'local', model: null, provenance_source: 'deterministic',
      answers: EVENT_BASELINE, routes: routesFor(EVENT_BASELINE, EVENT_RISKS),
      deterministic_answers: EVENT_BASELINE, deterministic_routes: routesFor(EVENT_BASELINE, EVENT_RISKS),
      ...(cause === undefined ? {} : { fallback_reason: cause.reason, ...diagnostics }),
      disagrees: false, latency_ms: latencyMs, cost: null,
    });
  }

  // A network failure the ladder restarts (baseline restart_advised 1).
  const failureClass = choiceOf(FAILURE_CLASSES);
  const SUPERVISION_RISKS: Record<string, RiskClass> = { failure_class: 'operational', restart_advised: 'operational', severity: 'read_only' };
  const SUPERVISION_BASELINE = { failure_class: failureClass('network_failure', 1), restart_advised: noul(1), severity: score(1, 1) };
  // Recorded before 2026-10-11: no `deterministic_routes` or `thresholds`;
  // the report rebuilds the baseline routes at the default thresholds.
  function legacySupervisionRow(seq: number, restart: number): LedgerEventRecord {
    const answers = { ...SUPERVISION_BASELINE, restart_advised: noul(restart) };
    return shadowRow(seq, {
      surface: 'supervision_guidance', provider: 'openrouter-jev', model: 'jev-a', provenance_source: 'jev',
      answers, routes: routesFor(answers, SUPERVISION_RISKS), deterministic_answers: SUPERVISION_BASELINE,
      disagrees: false, latency_ms: 400, cost: 0.001,
    });
  }

  const events: LedgerEventRecord[] = [
    // Class differs in the act band, needs_action stays fallback: still FYI.
    eventAnswered(1, { model: 'jev-a', needsAction: 0.2, eventClass: 'operator_attention', storedDisagrees: true, latencyMs: 100 }),
    // needs_action clears the fallback band: promoted to action-required.
    eventAnswered(2, { model: 'jev-a', needsAction: 0.6, eventClass: 'routine_fyi', latencyMs: 300 }),
    eventAnswered(3, { model: 'jev-b', needsAction: 0.1, eventClass: 'routine_fyi', storedDisagrees: true, latencyMs: 200 }),
    // Answered without a usable latency: outside the latency sample.
    eventAnswered(4, { model: 'jev-b', needsAction: 0.1, eventClass: 'routine_fyi' }),
    // Misses: a call that began and timed out, a capacity refusal, a
    // stand-in served while degraded (no call recorded), and a legacy row.
    eventMiss(5, 9000, { reason: 'timeout', phase: 'request' }),
    eventMiss(6, 0, { reason: 'capacity_limited', phase: 'not_started' }),
    eventMiss(7, 0, { reason: 'malformed_response', phase: null }),
    eventMiss(8, 0),
    // Restart advised below the act band: the supervisor stops for a human.
    legacySupervisionRow(9, 0.6),
    // Uncertain advice: the ladder restarts exactly as the baseline does.
    legacySupervisionRow(10, 0.3),
    // No consumer effect defined: listed, but disagreement is unmeasured.
    shadowRow(11, { surface: 'custom_surface', provider: 'local', provenance_source: 'jev', answers: {}, routes: {}, deterministic_answers: {}, latency_ms: 50, cost: null }),
    // Every ask missed: nothing answered, so nothing to measure.
    shadowRow(12, { surface: 'same_blocker', provider: 'openrouter-jev', provenance_source: 'deterministic', latency_ms: 2500, cost: null }),
    { seq: 13, ts: ts(13), kind: 'gru.wake', jobId: null, payload: { notification_ids: [], count: 0 } },
    // A second attempted reason, with its own elapsed time.
    eventMiss(14, 40, { reason: 'network_error', phase: 'request' }),
    // Known reasons without a readable cause: an unknown phase, and a row
    // whose diagnostics field is absent. Both stay unrecorded, by reason.
    eventMiss(15, 0, { reason: 'timeout', phase: 'bogus' }),
    eventMiss(16, 0, { reason: 'network_error' }),
  ];

  // Damaged answered rows stay in their group (with their cost and
  // latency) as unmeasurable; only unattributable rows are skipped. The
  // `damaged` group also holds one valid, disagreeing row, so its share
  // must divide by measurable asks only.
  const promoted = eventAnswered(26, { provider: 'damaged', model: 'jev-a', needsAction: 0.6, eventClass: 'routine_fyi', latencyMs: 90 });
  function tampered(seq: number, edit: (payload: Record<string, unknown>) => Record<string, unknown>): LedgerEventRecord {
    const base = eventAnswered(seq, { provider: 'damaged', model: 'jev-a', needsAction: 0.6, eventClass: 'routine_fyi', latencyMs: 60 + seq });
    return shadowRow(seq, edit(base.payload as Record<string, unknown>));
  }
  const routesOf = (payload: Record<string, unknown>) => payload['routes'] as Record<string, Record<string, unknown>>;
  const damaged: LedgerEventRecord[] = [
    shadowRow(20, 'torn' as unknown as Record<string, unknown>),
    shadowRow(21, { provider: 'damaged', provenance_source: 'jev' }),
    // No answers at all.
    tampered(22, ({ answers: _answers, ...rest }) => rest),
    // Truncated: a valid answer, but not every question the surface asks.
    tampered(23, (payload) => ({ ...payload, answers: { event_class: eventClass('routine_fyi', 0.9) } })),
    // A route whose metric is not its answer's probability.
    tampered(24, (payload) => ({ ...payload, routes: { ...routesOf(payload), needs_action: { ...routesOf(payload)['needs_action'], metric: 0.5 } } })),
    // A route in a band its metric does not reach (act at 0.6 on operational).
    tampered(25, (payload) => ({ ...payload, routes: { ...routesOf(payload), needs_action: { ...routesOf(payload)['needs_action'], path: 'act', requiresConfirm: false } } })),
    promoted,
    // Recorded thresholds that fail validation.
    tampered(27, (payload) => ({ ...payload, thresholds: { ...THRESHOLDS, operational: { act: 0.4, confirm: 0.6, requireConfirmOnAct: false } } })),
    // A choice answer missing its probability distribution.
    tampered(28, (payload) => ({ ...payload, answers: { ...(payload['answers'] as Record<string, unknown>), event_class: { type: 'choice', choice: 'routine_fyi', confidence: 0.9 } } })),
    // A route coherent with the wrong risk class (needs_action is operational).
    tampered(29, (payload) => ({ ...payload, routes: { ...routesOf(payload), needs_action: decisionRoute(noul(0.6), 'read_only', THRESHOLDS) } })),
    // An answer for a question the surface does not ask.
    tampered(31, (payload) => ({ ...payload, answers: { ...(payload['answers'] as Record<string, unknown>), extra: noul(0.5) } })),
    // A route carrying a field decisionRoute never writes.
    tampered(32, (payload) => ({ ...payload, routes: { ...routesOf(payload), severity: { ...routesOf(payload)['severity'], note: 'x' } } })),
    // A recorded but damaged baseline route set is never rebuilt.
    tampered(33, (payload) => ({ ...payload, deterministic_routes: null })),
  ];

  const rowFor = (measures: ReturnType<typeof computeDecisionShadowMeasures>, surface: string, provider: string) =>
    measures.bySurfaceProvider.find((row) => row.surface === surface && row.provider === provider)!;

  it('counts asks the consumer would act on differently, over answered asks, with misses kept apart', () => {
    expect(pathOf(events[1]!, 'needs_action')).toBe('confirm');
    const measures = computeDecisionShadowMeasures(events);
    expect(measures).toMatchObject({ records: 15, skipped: 0 });
    const triage = rowFor(measures, 'event_triage', 'local');
    expect(triage).toMatchObject({
      records: 11, answered: 4, unmeasured: 0, providerMisses: 7, missCostUsd: 0, assumedThresholds: 0,
      disagreements: 1, disagreementShare: 0.25,
      latencySamples: 3, latencyP50Ms: 200, latencyP95Ms: 300,
    });
    expect(triage.costUsd).toBeCloseTo(0.004);
    // Legacy rows carry no thresholds: measured at the assumed defaults.
    expect(rowFor(measures, 'supervision_guidance', 'openrouter-jev')).toMatchObject({
      records: 2, answered: 2, providerMisses: 0, disagreements: 1, disagreementShare: 0.5, assumedThresholds: 2,
    });
  });

  it('breaks misses down by kind and reason, and splits every answered measure by model', () => {
    const triage = rowFor(computeDecisionShadowMeasures(events), 'event_triage', 'local');
    const none = { latencySamples: 0, latencyP50Ms: null, latencyP95Ms: null };
    expect(triage.misses).toEqual([
      // Each attempted reason keeps its own elapsed time.
      { kind: 'attempted', reason: 'network_error', count: 1, latencySamples: 1, latencyP50Ms: 40, latencyP95Ms: 40 },
      { kind: 'attempted', reason: 'timeout', count: 1, latencySamples: 1, latencyP50Ms: 9000, latencyP95Ms: 9000 },
      { kind: 'refused', reason: 'capacity_limited', count: 1, ...none },
      { kind: 'stand_in', reason: 'malformed_response', count: 1, ...none },
      { kind: 'unrecorded', reason: 'network_error', count: 1, ...none },
      { kind: 'unrecorded', reason: 'timeout', count: 1, ...none },
      { kind: 'unrecorded', reason: 'unrecorded', count: 1, ...none },
    ]);
    expect(triage.models).toEqual([
      expect.objectContaining({ model: 'jev-a', answered: 2, unmeasured: 0, disagreements: 1, disagreementShare: 0.5, latencySamples: 2, latencyP50Ms: 100, latencyP95Ms: 300 }),
      expect.objectContaining({ model: 'jev-b', answered: 2, unmeasured: 0, disagreements: 0, disagreementShare: 0, latencySamples: 1, latencyP50Ms: 200 }),
    ]);
    expect(triage.models[0]!.costUsd).toBeCloseTo(0.002);
  });

  it('measures new rows at their recorded thresholds, never the defaults', () => {
    // At these thresholds needs_action 0.4 clears confirm (0.3): promoted.
    // At the defaults (confirm 0.55) the same route would be incoherent.
    const custom = { ...THRESHOLDS, operational: { act: 0.7, confirm: 0.3, requireConfirmOnAct: false } };
    const row = eventAnswered(30, { model: 'jev-a', needsAction: 0.4, eventClass: 'routine_fyi', latencyMs: 10, thresholds: custom });
    expect(pathOf(row, 'needs_action')).toBe('confirm');
    expect(rowFor(computeDecisionShadowMeasures([row]), 'event_triage', 'local')).toMatchObject({ answered: 1, unmeasured: 0, disagreements: 1 });
  });

  it('keeps damaged answered rows in their group as unmeasurable and reports unmeasured values as null', () => {
    const measures = computeDecisionShadowMeasures([...events, ...damaged]);
    expect(measures).toMatchObject({ records: 26, skipped: 2 });
    const damagedTriage = rowFor(measures, 'event_triage', 'damaged');
    // Ten damaged rows and one valid, disagreeing row: 1 of 1 measurable.
    expect(damagedTriage).toMatchObject({ records: 11, answered: 11, unmeasured: 10, disagreements: 1, disagreementShare: 1, latencySamples: 11 });
    expect(damagedTriage.costUsd).toBeCloseTo(0.011);
    expect(damagedTriage.models).toEqual([expect.objectContaining({ model: 'jev-a', answered: 11, unmeasured: 10, disagreements: 1, disagreementShare: 1 })]);
    expect(rowFor(measures, 'custom_surface', 'local')).toMatchObject({ answered: 1, disagreements: null, disagreementShare: null, latencyP50Ms: 50 });
    expect(rowFor(measures, 'same_blocker', 'openrouter-jev')).toMatchObject({
      records: 1, answered: 0, providerMisses: 1,
      disagreements: 0, disagreementShare: null, latencyP50Ms: null, latencyP95Ms: null, latencySamples: 0,
    });
  });

  it('flows through buildYieldReport and the text renderer', () => {
    // Ledger-derived labels cannot inject report lines, long model names
    // stay distinguishable, and a negative elapsed time is never sampled.
    const odd = [
      eventAnswered(40, { provider: 'od\nd', model: 'jev\nINJECTED line', needsAction: 0.1, eventClass: 'routine_fyi', latencyMs: -5 }),
      eventAnswered(41, { provider: 'od\nd', model: `${'x'.repeat(90)}A`, needsAction: 0.1, eventClass: 'routine_fyi', latencyMs: 10 }),
      eventAnswered(42, { provider: 'od\nd', model: `${'x'.repeat(90)}B`, needsAction: 0.1, eventClass: 'routine_fyi', latencyMs: 10 }),
    ];
    const report = buildYieldReport({
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-02T00:00:00.000Z',
      generatedAt: '2026-10-02T00:00:00.000Z',
      parseSkips: { unparsableLines: 0, unattributedCompactions: 0 },
      turns: [],
      sweepSignatures: [],
      ledger: { since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T00:00:00.000Z', events: [...events, ...damaged, ...odd], notifications: [], jobs: [] },
    });
    expect(report.decisionsShadow).toMatchObject({ records: 29, skipped: 2 });
    const text = renderTextReport(report);
    expect(text).toContain('Decisions (shadow');
    expect(text).toContain(
      'event_triage / local: records 11, answered 4, provider misses 7 (attempted 2: network_error 1 (p50 40ms / p95 40ms, n=1), timeout 1 (p50 9,000ms / p95 9,000ms, n=1); refused 1: capacity_limited 1; stand-in 1: malformed_response 1; unrecorded 3: network_error 1, timeout 1, no reason 1), would act differently 1 of 4 answered (25.0%), cost $0.0040, answered latency p50 200ms / p95 300ms (n=3)',
    );
    expect(text).toContain('    model jev-a: answered 2, would act differently 1 of 2 answered (50.0%), cost $0.0020, answered latency p50 100ms / p95 300ms (n=2)');
    expect(text).toContain('    model jev-b: answered 2, would act differently 0 of 2 answered (0.0%), cost $0.0020, answered latency p50 200ms / p95 200ms (n=1)');
    expect(text).toContain('supervision_guidance / openrouter-jev: records 2, answered 2, provider misses 0, would act differently 1 of 2 answered (50.0%), cost $0.0020, answered latency p50 400ms / p95 400ms (n=2), 2 at assumed default thresholds');
    expect(text).toContain('event_triage / damaged: records 11, answered 11, provider misses 0, would act differently 1 of 1 measurable (100.0%; 10 unmeasurable)');
    expect(text).toContain('custom_surface / local: records 1, answered 1, provider misses 0, would act differently n/a (no consumer effect defined)');
    expect(text).toContain('same_blocker / openrouter-jev: records 1, answered 0, provider misses 1 (unrecorded 1), would act differently 0 of 0 answered (n/a), cost $0.0000, answered latency n/a (n=0)');
    expect(text).toContain('event_triage / od?d: records 3, answered 3');
    expect(text).toContain('    model jev?INJECTED line: answered 1, would act differently 0 of 1 answered (0.0%), cost $0.0010, answered latency n/a (n=0)');
    expect(text).not.toContain('\nINJECTED');
    expect(text).not.toContain('\nd: records');
    const longModels = text.split('\n').filter((line) => line.startsWith(`    model ${'x'.repeat(64)}…#`));
    expect(longModels).toHaveLength(2);
    expect(new Set(longModels.map((line) => line.split(':')[0])).size).toBe(2);
    expect(text).toContain('2 unreadable shadow row(s) skipped');
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
