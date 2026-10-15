import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DECISIONS_CONFIG,
  loadConfig,
  type DecisionsConfig,
} from '../src/config.js';
import { decisionsConfigTemplate } from '../src/decisions/config-template.js';
import {
  assertEnforceGate,
  BACKTEST_RECORD_SCHEMA_VERSION,
  backtestMeetsThreshold,
  backtestRecordPath,
  EnforceGateError,
} from '../src/decisions/enforce.js';
import { eventDecisionRequest, supervisionDecisionRequest } from '../src/decisions/questions.js';
import { DecisionRuntime, SHADOW_MISS_DEGRADE_THRESHOLD } from '../src/decisions/runtime.js';
import { backtestRecordFromReport, saveBacktestRecord, type BacktestReport } from '../src/decisions/backtest.js';
import { EventBus, type BusEvent } from '../src/events/bus.js';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { buildShadowRecord } from '../src/decisions/shadow.js';
import { computeDecisionShadowMeasures } from '../src/telemetry/yield.js';
import { decisionRoute, deterministicOutcome } from '../src/decisions/service.js';
import { requestFromCase, surfaceCaseSpec } from '../src/decisions/cases/registry.js';
import type {
  Answer,
  AnswersFor,
  ChoiceAnswer,
  DecisionOutcome,
  DecisionRequest,
  QuestionSet,
  RiskClass,
  ShadowDecisionRecord,
} from '../src/decisions/types.js';

const cleanups: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function configWithSurfaces(surfaces: DecisionsConfig['surfaces'], enabled = true): DecisionsConfig {
  return {
    jev: { ...DEFAULT_DECISIONS_CONFIG.jev, enabled },
    providers: {},
    surfaces,
    thresholds: {
      read_only: { ...DEFAULT_DECISIONS_CONFIG.thresholds.read_only },
      operational: { ...DEFAULT_DECISIONS_CONFIG.thresholds.operational },
      destructive: { ...DEFAULT_DECISIONS_CONFIG.thresholds.destructive },
    },
  };
}

const EVENT: BusEvent = {
  seq: 1,
  ts: new Date(0).toISOString(),
  kind: 'agent.error',
  agentId: 'a1',
  jobId: null,
  roundId: null,
  lens: null,
  payload: { error: 'boom' },
};

const STATE_CANARY = 'SHADOW-CANARY-STATE-TEXT';

function eventRequest(): ReturnType<typeof eventDecisionRequest> {
  return eventDecisionRequest({ ...EVENT, payload: { error: STATE_CANARY } });
}

function answerEnvelope(body: string): Record<string, unknown> {
  const request = JSON.parse(body) as { questions: Record<string, { type: string; options?: string[]; criteria?: string[] }> };
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.96 };
    if (question.type === 'choice') {
      const options = question.options ?? [];
      answers[id] = {
        type: 'choice',
        choice: options[0],
        probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0])),
        confidence: 0.94,
      };
    }
    if (question.type === 'score') {
      const levels = question.criteria?.length ?? 2;
      answers[id] = {
        type: 'score',
        score: 0,
        legend: Object.fromEntries((question.criteria ?? []).map((criterion, index) => [String(index), criterion])),
        probabilities: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), index === 0 ? 1 : 0])),
        confidence: 0.92,
      };
    }
  }
  return {
    model: 'laya-421m-test',
    answers,
    usage: { input_tokens: 12, output_tokens: 5, cost: 0.000002 },
  };
}

function stubFetch(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    void url;
    return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
  }) as typeof fetch;
}

/** The event_triage surface routed to the keyless `local` loopback
 * profile: the runtime constructs it offline (no startup probe) and the
 * stub fetch serves every ask. */
function surfaceEntry(profile: string, mode?: 'off' | 'shadow' | 'enforce'): { provider: string } & ({ mode?: undefined } | { mode: 'off' | 'shadow' | 'enforce' }) {
  return mode === undefined ? { provider: profile } : { provider: profile, mode };
}

async function startedRuntime(
  surfaces: DecisionsConfig['surfaces'],
  options: {
    dataDir?: string;
    onShadowRecord?: (record: ShadowDecisionRecord) => void;
    notifications?: import('../src/notifications/center.js').NotificationCenter;
  } = {},
): Promise<DecisionRuntime> {
  const runtime = new DecisionRuntime(configWithSurfaces(surfaces), {
    instanceDir: temp('gru-decisions-shadow-'),
    // The default profile resolves its startup-probe credential from the
    // env; the stub fetch answers the probe itself.
    env: { OPENROUTER_API_KEY: 'test-key' },
    fetchImpl: stubFetch(),
    watchConfig: false,
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.onShadowRecord !== undefined ? { onShadowRecord: options.onShadowRecord } : {}),
    ...(options.notifications !== undefined ? { notifications: options.notifications } : {}),
  });
  const status = await runtime.start();
  expect(status).toMatchObject({ status: 'ready' });
  return runtime;
}

describe('surface mode config parsing (issue #223)', () => {
  it('parses the shorthand, mode-only and provider+mode table forms', () => {
    const instance = temp('gru-decisions-mode-config-');
    writeFileSync(join(instance, 'config.toml'), [
      '[decisions.jev]',
      'enabled = true',
      '[decisions.surfaces]',
      'event_triage = "local"',
      '[decisions.surfaces.supervision_guidance]',
      'mode = "shadow"',
      '[decisions.surfaces.report_conclusion]',
      'provider = "typesafe-direct"',
      'mode = "enforce"',
    ].join('\n'));
    const loaded = loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'));
    expect(loaded.decisions.surfaces).toEqual({
      event_triage: { provider: 'local' },
      supervision_guidance: { mode: 'shadow' },
      report_conclusion: { provider: 'typesafe-direct', mode: 'enforce' },
    });
  });

  it('rejects an invalid mode, an unknown table key, and an empty entry', () => {
    for (const fragment of [
      ['[decisions.surfaces.event_triage]', 'mode = "yolo"'],
      ['[decisions.surfaces.event_triage]', 'profile = "local"'],
      ['[decisions.surfaces.event_triage]', 'provider = "local"', 'extra = "x"'],
      ['[decisions.surfaces.event_triage]', 'provider = "nope"', 'mode = "off"'],
    ]) {
      const instance = temp('gru-decisions-mode-bad-');
      writeFileSync(join(instance, 'config.toml'), ['[decisions.jev]', 'enabled = true', ...fragment].join('\n'));
      expect(() => loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'))).toThrow();
    }
  });

  it('teaches the mode keys in the installer config template', () => {
    const template = decisionsConfigTemplate(true);
    expect(template).toContain('mode = "shadow"');
    expect(template).toContain('decisions/backtests/');
  });
});

describe('per-surface mode semantics (issue #223)', () => {
  it('mode "off" serves the deterministic answer and never contacts the provider', async () => {
    const fetchImpl = vi.fn(stubFetch());
    const runtime = new DecisionRuntime(configWithSurfaces({ event_triage: surfaceEntry('local', 'off') }), {
      instanceDir: temp('gru-decisions-off-'),
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      watchConfig: false,
    });
    await runtime.start();
    const callsAtStart = fetchImpl.mock.calls.length; // startup probe only
    const outcome = await runtime.decide(eventRequest(), { surface: 'event_triage' });
    expect(outcome.provenance).toMatchObject({ source: 'deterministic' });
    expect(outcome.answers.needs_action).toEqual({ type: 'noul', noul: 0 });
    expect(fetchImpl.mock.calls.length).toBe(callsAtStart);
    runtime.dispose();
  });

  it('mode "shadow" asks the provider, records the ask, and STILL serves the deterministic answer', async () => {
    const records: ShadowDecisionRecord[] = [];
    const runtime = await startedRuntime(
      { event_triage: surfaceEntry('local', 'shadow') },
      { onShadowRecord: (record) => records.push(record) },
    );
    const outcome = await runtime.decide(eventRequest(), { surface: 'event_triage' });
    // Behavior cannot change in shadow: the deterministic answer is served.
    expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'shadow_mode' });
    expect(outcome.answers.needs_action).toEqual({ type: 'noul', noul: 0 });
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.surface).toBe('event_triage');
    expect(record.provider).toBe('local');
    expect(record.model).toBe('laya-421m-test');
    expect(record.provenance_source).toBe('jev');
    expect(record.disagrees).toBe(true); // provider answered 0.96 noul → act band; baseline noul 0 → fallback
    expect(record.request_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.cost).toBeCloseTo(0.000002);
    // The provider's would-be answers and the baseline both travel; the
    // request state text NEVER does.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(STATE_CANARY);
    expect(serialized).not.toContain('agent.error');
    expect((record.answers as { needs_action: { noul: number } }).needs_action.noul).toBe(0.96);
    expect((record.deterministic_answers as { needs_action: { noul: number } }).needs_action.noul).toBe(0);
    runtime.dispose();
  });

  it('a shadow ask whose provider falls back still returns deterministic and never degrades a non-default profile into an incident', async () => {
    const records: ShadowDecisionRecord[] = [];
    const runtime = new DecisionRuntime(configWithSurfaces({ event_triage: surfaceEntry('local', 'shadow') }), {
      instanceDir: temp('gru-decisions-shadow-miss-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      // The default profile's startup probe succeeds; the loopback `local`
      // ask fails — a per-call miss for a non-default profile.
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).startsWith('http://127.0.0.1')) throw new TypeError('loopback down');
        return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
      }) as unknown as typeof fetch,
      watchConfig: false,
      onShadowRecord: (record) => records.push(record),
    });
    await runtime.start();
    const outcome = await runtime.decide(eventRequest(), { surface: 'event_triage' });
    expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'shadow_mode' });
    expect(records).toHaveLength(1);
    expect(records[0]!.provenance_source).toBe('deterministic');
    expect(records[0]!.disagrees).toBe(false);
    expect(runtime.status()).toMatchObject({ status: 'ready' }); // non-default fallback is per-call, not an incident
    runtime.dispose();
  });

  it('a surface with no mode key keeps the pre-#223 behavior unchanged (provider answer, no gate)', async () => {
    const runtime = await startedRuntime({ event_triage: surfaceEntry('local') });
    const outcome = await runtime.decide(eventRequest(), { surface: 'event_triage' });
    expect(outcome.provenance).toMatchObject({ source: 'jev', model: 'laya-421m-test' });
    runtime.dispose();
  });
});

describe('the enforce gate (issue #223)', () => {
  const surface = 'escalation_triage';
  const profile = 'local';
  const configuredModel = 'laya-421m';
  const gate = (dataDir: string): ReturnType<typeof assertEnforceGate> =>
    assertEnforceGate({ dataDir, surface, provider: profile, model: configuredModel });
  const minimalReport: BacktestReport = {
    schemaVersion: BACKTEST_RECORD_SCHEMA_VERSION,
    surface,
    provider: profile,
    model: 'laya-421m-test',
    configuredModel,
    n: 12,
    agreement: 0.92,
    actions: { act: { predicted: 5, correct: 5 }, defer: { predicted: 7, correct: 6 } },
    precision: { act: 1, defer: 0.8571428571428571, actionable: 1 },
    recall: { act: 1, defer: 0.8571428571428571, actionable: 1 },
    actionable_label: 'needs_ruling',
    calibration: [{ lo: 0.8, hi: 1, n: 12, meanCorrect: 0.92 }],
    costUsd: 0.001,
    latencyMs: { p50: 100, p95: 200 },
    replayed: true,
    recordedDir: null,
    generatedAt: '2026-10-06T00:00:00.000Z',
  };

  it('threshold evaluation is recomputed from the metric, never from the stored flag', () => {
    const base = backtestRecordFromReport(minimalReport, { metric: 'precision', label: null, min: 0.9 });
    expect(base.met).toBe(true);
    expect(backtestMeetsThreshold({ ...base, met: false })).toBe(true);
    const failing = backtestRecordFromReport(minimalReport, { metric: 'agreement', label: null, min: 0.99 });
    expect(failing.met).toBe(false);
    const junk = backtestRecordFromReport(minimalReport, { metric: 'precision', label: null, min: 1.5 });
    expect(junk.met).toBe(false);
  });

  it('mode "enforce" without recorded evidence fails loud with a stranger-actionable message', async () => {
    const dataDir = temp('gru-decisions-gate-empty-');
    const runtime = await startedRuntime({ [surface]: surfaceEntry(profile, 'enforce') }, { dataDir });
    await expect(runtime.decide(eventRequest(), { surface })).rejects.toThrow(EnforceGateError);
    await expect(runtime.decide(eventRequest(), { surface })).rejects.toThrow(
      /escalation_triage.*backtests.*backtest --surface escalation_triage/s,
    );
    runtime.dispose();
  });

  it('mode "enforce" with meeting evidence for the ROUTED provider serves the provider answer', async () => {
    const dataDir = temp('gru-decisions-gate-ok-');
    const record = backtestRecordFromReport(minimalReport, { metric: 'precision', label: null, min: 0.9 });
    expect(saveBacktestRecord(dataDir, record)).toBe(backtestRecordPath(dataDir, surface));
    const runtime = await startedRuntime({ [surface]: surfaceEntry(profile, 'enforce') }, { dataDir });
    const outcome = await runtime.decide(eventRequest(), { surface });
    expect(outcome.provenance).toMatchObject({ source: 'jev', model: 'laya-421m-test' });
    runtime.dispose();
  });

  it('a passing gated call resolves the surface owner-only enforce-gate incident', async () => {
    const dataDir = temp('gru-decisions-gate-resolve-');
    const ledgerDir = temp('gru-decisions-gate-ledger-');
    const db = new LedgerDb(ledgerDir);
    const bus = new EventBus();
    const ledger = new LedgerApi(db.handle, { bus });
    const notifications = new NotificationCenter({ ledger, bus });
    const incident = notifications.postIncident({
      kind: `decisions.enforce-gate.${surface}`,
      routing: 'needs-owner',
      severity: 'error',
      title: `Decision enforce gate blocked for ${surface}`,
      detail: 'no recorded backtest evidence yet',
      dedupe: 'active',
    });
    // A lookalike kind that EXTENDS the surface name must stay open: the
    // consumer must settle the exact kind, never a LIKE prefix (the CONSUMER,
    // not just the helper, is what this test discriminates).
    const lookalike = notifications.postIncident({
      kind: `decisions.enforce-gate.${surface}-extra`,
      routing: 'needs-owner',
      severity: 'error',
      title: `Decision enforce gate blocked for ${surface}-extra`,
      detail: 'a different surface, still gated',
      dedupe: 'active',
    });
    expect(incident.routing).toBe('needs-owner');
    saveBacktestRecord(dataDir, backtestRecordFromReport(minimalReport, { metric: 'precision', label: null, min: 0.9 }));
    const runtime = await startedRuntime({ [surface]: surfaceEntry(profile, 'enforce') }, { dataDir, notifications });
    const outcome = await runtime.decide(eventRequest(), { surface });
    expect(outcome.provenance).toMatchObject({ source: 'jev' });
    expect(ledger.getNotification(incident.id)?.resolvedBy).toBe('enforce-gate-passed');
    expect(ledger.getNotification(lookalike.id)?.resolvedAt).toBeNull();
    runtime.dispose();
  });

  it('evidence earned on another profile or model never licenses enforce', () => {
    const dataDir = temp('gru-decisions-gate-bad-');
    saveBacktestRecord(dataDir, backtestRecordFromReport(
      { ...minimalReport, provider: 'typesafe-direct' }, { metric: 'precision', label: null, min: 0.9 },
    ));
    expect(() => gate(dataDir)).toThrow(/profile/u);
    saveBacktestRecord(dataDir, backtestRecordFromReport(
      { ...minimalReport, configuredModel: 'new-model' }, { metric: 'precision', label: null, min: 0.9 },
    ));
    expect(() => gate(dataDir)).toThrow(/configured for model/u);
    saveBacktestRecord(dataDir, backtestRecordFromReport(minimalReport, { metric: 'agreement', label: null, min: 0.99 }));
    expect(() => gate(dataDir)).toThrow(/does not meet its stated threshold/u);
  });

  it('posts one durable owner-visible gate incident when production callers catch the rejection', async () => {
    const db = new LedgerDb(temp('gru-decisions-gate-incident-'));
    try {
      const bus = new EventBus();
      const ledger = new LedgerApi(db.handle, { bus });
      const notifications = new NotificationCenter({ ledger, bus });
      const runtime = new DecisionRuntime(configWithSurfaces({ event_triage: surfaceEntry('local', 'enforce') }), {
        instanceDir: temp('gru-decisions-gate-instance-'), dataDir: temp('gru-decisions-gate-evidence-'),
        env: { OPENROUTER_API_KEY: 'test-key' }, fetchImpl: stubFetch(), watchConfig: false, notifications,
      });
      await runtime.start();
      await expect(runtime.decide(eventRequest(), { surface: 'event_triage' })).rejects.toThrow(EnforceGateError);
      await expect(runtime.decide(eventRequest(), { surface: 'event_triage' })).rejects.toThrow(EnforceGateError);
      expect(ledger.listNotifications({ limit: 20 }).filter((row) => row.kind === 'decisions.enforce-gate.event_triage'))
        .toMatchObject([{ routing: 'needs-owner', severity: 'error' }]);
      runtime.dispose();
    } finally { db.close(); }
  });

  it('rejects enforce for unbacktestable production surfaces even with fabricated evidence', async () => {
    const dataDir = temp('gru-decisions-unregistered-');
    saveBacktestRecord(dataDir, backtestRecordFromReport({ ...minimalReport, surface: 'event_triage' }, { metric: 'precision', label: null, min: 0.9 }));
    const runtime = await startedRuntime({ event_triage: surfaceEntry(profile, 'enforce') }, { dataDir });
    await expect(runtime.decide(eventRequest(), { surface: 'event_triage' })).rejects.toThrow(/no registered backtest/u);
    runtime.dispose();
  });

  it('rejects malformed or foreign-surface evidence and enforce without a dataDir', async () => {
    const dataDir = temp('gru-decisions-gate-junk-');
    mkdirSync(join(dataDir, 'decisions', 'backtests'), { recursive: true });
    writeFileSync(backtestRecordPath(dataDir, surface), '{ not json');
    expect(() => gate(dataDir)).toThrow(/not valid JSON/u);
    writeFileSync(backtestRecordPath(dataDir, surface), JSON.stringify({ ...minimalReport, surface: 'other_surface', met: true }));
    expect(() => gate(dataDir)).toThrow(/does not match schema/u);
    const runtime = await startedRuntime({ [surface]: surfaceEntry(profile, 'enforce') });
    await expect(runtime.decide(eventRequest(), { surface })).rejects.toThrow(/no data directory is available/u);
    runtime.dispose();
  });
});

describe('shadow misses are evidence, not incidents (2026-10-06 owner page)', () => {
  type Step = 'ok' | 'timeout' | 'auth';

  /** Call 1 is the default profile's startup probe; each later call is one
   * shadow ask. A timeout is the provider's own abort, as in production. */
  function scriptedFetch(steps: readonly Step[]): typeof fetch {
    let call = 0;
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      const step = steps[call] ?? 'ok';
      call += 1;
      if (step === 'timeout') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      if (step === 'auth') return new Response('denied', { status: 401 });
      return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
    }) as unknown as typeof fetch;
  }

  function notificationStub(): { readonly center: NotificationCenter; readonly postIncident: ReturnType<typeof vi.fn> } {
    const postIncident = vi.fn();
    const center = { postIncident, post: vi.fn(), resolveIncidents: vi.fn(() => []) } as unknown as NotificationCenter;
    return { center, postIncident };
  }

  async function shadowRuntime(
    surfaces: DecisionsConfig['surfaces'],
    steps: readonly Step[],
    sinks: { readonly notifications: NotificationCenter; readonly records: ShadowDecisionRecord[] },
  ): Promise<DecisionRuntime> {
    const runtime = new DecisionRuntime(configWithSurfaces(surfaces), {
      instanceDir: temp('gru-decisions-shadow-misses-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: scriptedFetch(steps),
      watchConfig: false,
      notifications: sinks.notifications,
      onShadowRecord: (record) => sinks.records.push(record),
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready' });
    return runtime;
  }

  const ALL_SHADOW: DecisionsConfig['surfaces'] = {
    event_triage: surfaceEntry('openrouter-jev', 'shadow'),
    supervision_guidance: surfaceEntry('openrouter-jev', 'shadow'),
  };

  it('one transient shadow miss is recorded: the runtime stays ready and nobody is paged', async () => {
    const { center, postIncident } = notificationStub();
    const records: ShadowDecisionRecord[] = [];
    const runtime = await shadowRuntime(ALL_SHADOW, ['ok', 'timeout'], { notifications: center, records });
    postIncident.mockClear(); // drop the startup "ready" FYI
    const outcome = await runtime.decide(eventRequest(), { surface: 'event_triage' });
    expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'shadow_mode' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provenance_source: 'deterministic', model: null });
    expect(runtime.status()).toMatchObject({ status: 'ready', reason: null });
    expect(postIncident).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it(`degrades only after ${SHADOW_MISS_DEGRADE_THRESHOLD} consecutive transient misses; a success resets the run`, async () => {
    const { center } = notificationStub();
    const records: ShadowDecisionRecord[] = [];
    const runtime = await shadowRuntime(
      ALL_SHADOW,
      ['ok', 'timeout', 'timeout', 'ok', 'timeout', 'timeout', 'timeout'],
      { notifications: center, records },
    );
    await runtime.decide(eventRequest(), { surface: 'event_triage' }); // miss 1
    await runtime.decide(eventRequest(), { surface: 'event_triage' }); // miss 2
    expect(runtime.status()).toMatchObject({ status: 'ready' });
    await runtime.decide(eventRequest(), { surface: 'event_triage' }); // success → reset
    await runtime.decide(eventRequest(), { surface: 'event_triage' }); // miss 1
    await runtime.decide(eventRequest(), { surface: 'event_triage' }); // miss 2
    expect(runtime.status()).toMatchObject({ status: 'ready' });
    await runtime.decide(eventRequest(), { surface: 'event_triage' }); // miss 3 → degrade
    expect(runtime.status()).toMatchObject({ status: 'degraded', reason: 'timeout' });
    expect(records).toHaveLength(6);
    runtime.dispose();
  });

  it('a transient degrade with every acting surface in shadow goes to the board feed, not the owner bell', async () => {
    const { center, postIncident } = notificationStub();
    const runtime = await shadowRuntime(ALL_SHADOW, ['ok', 'timeout', 'timeout', 'timeout'], { notifications: center, records: [] });
    postIncident.mockClear();
    for (let i = 0; i < SHADOW_MISS_DEGRADE_THRESHOLD; i += 1) {
      await runtime.decide(eventRequest(), { surface: 'event_triage' });
    }
    expect(runtime.status()).toMatchObject({ status: 'degraded', reason: 'timeout' });
    expect(postIncident).toHaveBeenCalledTimes(1);
    expect(postIncident.mock.calls[0]![0]).toMatchObject({ kind: 'decisions.degraded.timeout', routing: 'fyi' });
    runtime.dispose();
  });

  it('still pages the owner when a modeless (pre-#223) host acts on Jev or when the failure needs a human', async () => {
    // supervision_guidance has no mode: it ACTS on Jev's answer, so even a
    // transient degrade is owner-visible.
    const legacy = notificationStub();
    const actingRuntime = await shadowRuntime(
      { event_triage: surfaceEntry('openrouter-jev', 'shadow') },
      ['ok', 'timeout', 'timeout', 'timeout'],
      { notifications: legacy.center, records: [] },
    );
    legacy.postIncident.mockClear();
    for (let i = 0; i < SHADOW_MISS_DEGRADE_THRESHOLD; i += 1) {
      await actingRuntime.decide(eventRequest(), { surface: 'event_triage' });
    }
    expect(legacy.postIncident.mock.calls[0]![0]).toMatchObject({ routing: 'needs-owner' });
    actingRuntime.dispose();

    // An auth failure needs a human: it degrades on the FIRST shadow miss
    // and pages the owner even when every surface is in shadow.
    const auth = notificationStub();
    const authRuntime = await shadowRuntime(ALL_SHADOW, ['ok', 'auth'], { notifications: auth.center, records: [] });
    auth.postIncident.mockClear();
    await authRuntime.decide(eventRequest(), { surface: 'event_triage' });
    expect(authRuntime.status()).toMatchObject({ status: 'degraded', reason: 'auth_rejected' });
    expect(auth.postIncident.mock.calls[0]![0]).toMatchObject({ kind: 'decisions.degraded.auth_rejected', routing: 'needs-owner' });
    authRuntime.dispose();
  });
});

describe('shadow record disagreement is what the consumer would do (2026-10-11)', () => {
  const thresholds = DEFAULT_DECISIONS_CONFIG.thresholds;

  // Routes come from the real banding, exactly as the provider service
  // would assign them for these answers.
  function jevOutcome<Q extends QuestionSet>(request: DecisionRequest<Q>, answers: AnswersFor<Q>): DecisionOutcome<Q> {
    const routes = Object.fromEntries(Object.keys(request.questions).map((id) => [
      id,
      decisionRoute((answers as Record<string, Answer>)[id]!, (request.risks as Record<string, RiskClass>)[id]!, thresholds),
    ])) as DecisionOutcome<Q>['routes'];
    return {
      answers,
      routes,
      provenance: { source: 'jev', fallbackReason: null, model: 'laya-421m-test', latencyMs: 10, usage: null, profile: 'local' },
    };
  }

  function recordFor<Q extends QuestionSet>(surface: string, request: DecisionRequest<Q>, answers: AnswersFor<Q>): ShadowDecisionRecord {
    return buildShadowRecord({
      surface,
      provider: 'local',
      request,
      providerOutcome: jevOutcome(request, answers),
      deterministicOutcome: deterministicOutcome(request, thresholds, 'shadow_mode'),
      thresholds,
    });
  }

  const pathOf = (record: ShadowDecisionRecord, id: string): string =>
    (record.routes as Record<string, { path: string }>)[id]!.path;

  it('event triage disagrees only when the notification would be promoted to action-required', () => {
    const request = eventRequest();
    const { fallback } = request;
    // Class and severity differ in the act band, but needs_action stays in
    // the fallback band: the notification stays FYI; only its detail text
    // would change.
    const detailOnly = recordFor('event_triage', request, {
      needs_action: { type: 'noul', noul: 0.2 },
      event_class: { ...fallback.event_class, choice: 'operator_attention', confidence: 0.9 },
      severity: { ...fallback.severity, score: 1.1, confidence: 0.9 },
    });
    expect(pathOf(detailOnly, 'event_class')).toBe('act');
    expect(pathOf(detailOnly, 'needs_action')).toBe('fallback');
    expect(detailOnly.disagrees).toBe(false);
    // A confirm-band needs_action (0.6 on operational) routes it UP.
    const promoted = recordFor('event_triage', request, { ...fallback, needs_action: { type: 'noul', noul: 0.6 } });
    expect(pathOf(promoted, 'needs_action')).toBe('confirm');
    expect(promoted.disagrees).toBe(true);
    // The baseline routes and the thresholds they were banded at travel
    // with the record.
    expect((promoted.deterministic_routes as Record<string, { path: string }>)['event_class']!.path).toBe('act');
    expect(promoted.thresholds).toEqual(thresholds);
  });

  it('supervision disagrees only when the supervisor would stop instead of restart, or for another reason', () => {
    // The ladder restarts a network failure: baseline restart_advised 1 (act).
    const request = supervisionDecisionRequest({ reason: 'socket hang up: network unreachable', agentId: 'm1', role: 'minion', restartCount: 0, breakerLimit: 3 });
    const { fallback } = request;
    expect(fallback.failure_class.choice).toBe('network_failure');
    const record = (failureClass: string, classConfidence: number, restart: number, severityScore = fallback.severity.score) =>
      recordFor('supervision_guidance', request, {
        failure_class: { ...fallback.failure_class, choice: failureClass as typeof fallback.failure_class.choice, confidence: classConfidence },
        restart_advised: { type: 'noul', noul: restart },
        severity: { ...fallback.severity, score: severityScore },
      });
    // Agrees a restart helps, below the act band: the human gate owns it.
    const confirmGated = record('network_failure', 0.9, 0.6);
    expect(pathOf(confirmGated, 'restart_advised')).toBe('confirm');
    expect(confirmGated.disagrees).toBe(true);
    // Uncertain restart advice (fallback band) restarts via the ladder, and
    // a different non-wall class changes nothing the supervisor does.
    const ladder = record('unknown', 0.9, 0.3);
    expect(pathOf(ladder, 'restart_advised')).toBe('fallback');
    expect(ladder.disagrees).toBe(false);
    // The supervisor never reads the severity answer.
    expect(record('network_failure', 0.9, 0.9, 2).disagrees).toBe(false);
    // A model-classified wall stops the agent the ladder would restart.
    expect(record('quota_wall', 0.9, 0.1).disagrees).toBe(true);
  });

  it('records the thresholds the runtime banded at, and the report measures the record at them', async () => {
    const records: ShadowDecisionRecord[] = [];
    // The stub answers needs_action 0.96: act at the defaults (0.75), but
    // only confirm at an operational act threshold of 0.97.
    const configured = {
      ...configWithSurfaces({ event_triage: surfaceEntry('local', 'shadow') }),
      thresholds: { ...thresholds, operational: { act: 0.97, confirm: 0.3, requireConfirmOnAct: false } },
    };
    const runtime = new DecisionRuntime(configured, {
      instanceDir: temp('gru-decisions-shadow-thresholds-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: stubFetch(),
      watchConfig: false,
      onShadowRecord: (record) => records.push(record),
    });
    await runtime.start();
    await runtime.decide(eventRequest(), { surface: 'event_triage' });
    runtime.dispose();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.thresholds).toEqual(configured.thresholds);
    expect(pathOf(record, 'needs_action')).toBe('confirm');
    const measures = computeDecisionShadowMeasures([
      { seq: 1, ts: '2026-10-11T00:00:00.000Z', kind: 'decisions.shadow', jobId: null, payload: JSON.parse(JSON.stringify(record)) as Record<string, unknown> },
    ]);
    expect(measures.bySurfaceProvider[0]).toMatchObject({ answered: 1, unmeasured: 0, assumedThresholds: 0, disagreements: 1 });
  });

  it('escalation triage and same-blocker disagree only when their case-spec action differs', () => {
    // Baseline: every escalation needs a ruling (wake Gru) at confidence 1.
    const escalation = requestFromCase(surfaceCaseSpec('escalation_triage'), 'escalation state');
    const baselineTriage = escalation.fallback['triage'] as ChoiceAnswer;
    const triage = (choice: string, confidence: number) => recordFor('escalation_triage', escalation, {
      ...escalation.fallback,
      triage: { ...baselineTriage, choice, confidence },
    } as AnswersFor<QuestionSet>);
    // Agrees less confidently (confirm band on operational): still a ruling.
    const lessConfident = triage('needs_ruling', 0.6);
    expect(pathOf(lessConfident, 'triage')).toBe('confirm');
    expect(lessConfident.disagrees).toBe(false);
    // Another ruling class is the same action.
    expect(triage('needs_owner', 0.9).disagrees).toBe(false);
    // Covered by an open item: no ruling owed.
    expect(triage('covered_by_open_item', 0.9).disagrees).toBe(true);
    // Baseline: different fingerprints are different defects (act on it).
    const sameBlocker = requestFromCase(surfaceCaseSpec('same_blocker'), 'blocker pair');
    const sameDefect = (noul: number) =>
      recordFor('same_blocker', sameBlocker, { same_defect: { type: 'noul', noul } } as AnswersFor<QuestionSet>);
    expect(sameDefect(0.6).disagrees).toBe(true);
    expect(sameDefect(0.45).disagrees).toBe(false);
  });
});
