import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DECISIONS_CONFIG, loadConfig, type DecisionsConfig } from '../src/config.js';
import {
  isolateDecisionEnvironment,
  parseCredentialStdin,
  resolveCredential,
  writeCredential,
} from '../src/decisions/credentials.js';
import {
  eventDecisionRequest,
  filteredState,
  supervisionDecisionRequest,
} from '../src/decisions/questions.js';
import { JevDecisionService, JevProvider } from '../src/decisions/provider.js';
import { DecisionRuntime } from '../src/decisions/runtime.js';
import {
  decisionRoute,
  validateAnswer,
  validateThresholdConfig,
} from '../src/decisions/service.js';
import type { BusEvent } from '../src/events/bus.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';

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

function cloneConfig(enabled: boolean): DecisionsConfig {
  return {
    jev: { ...DEFAULT_DECISIONS_CONFIG.jev, enabled },
    thresholds: {
      read_only: { ...DEFAULT_DECISIONS_CONFIG.thresholds.read_only },
      operational: { ...DEFAULT_DECISIONS_CONFIG.thresholds.operational },
      destructive: { ...DEFAULT_DECISIONS_CONFIG.thresholds.destructive },
    },
  };
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
    model: 'typesafe/jev-test',
    answers,
    usage: { input_tokens: 12, output_tokens: 5, cost: 0.000001 },
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

describe('decision config schema', () => {
  it('loads the complete default-off Jev section and strict per-risk thresholds', () => {
    const instance = temp('gru-decisions-config-');
    writeFileSync(join(instance, 'config.toml'), [
      '[decisions.jev]',
      'enabled = true',
      'model = "~typesafe/jev-latest"',
      'endpoint = "https://openrouter.ai/api/alpha/decisions"',
      'timeout_ms = 1234',
      '[decisions.thresholds.read_only]',
      'act = 0.61',
      'confirm = 0.41',
      'require_confirm_on_act = false',
      '[decisions.thresholds.operational]',
      'act = 0.76',
      'confirm = 0.56',
      'require_confirm_on_act = false',
      '[decisions.thresholds.destructive]',
      'act = 0.86',
      'confirm = 0.71',
      'require_confirm_on_act = true',
    ].join('\n'));
    const loaded = loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'));
    expect(loaded.decisions).toMatchObject({
      jev: { enabled: true, timeoutMs: 1234 },
      thresholds: { destructive: { act: 0.86, confirm: 0.71, requireConfirmOnAct: true } },
    });
  });

  it('rejects threshold equality/out-of-range, unknown keys and destructive no-confirm', () => {
    for (const body of [
      '[decisions.thresholds.read_only]\nact=0.5\nconfirm=0.5\n',
      '[decisions.thresholds.operational]\nact=1.1\n',
      '[decisions.thresholds.destructive]\nrequire_confirm_on_act=false\n',
      '[decisions.jev]\nkey="must-never-be-in-toml"\n',
    ]) {
      const instance = temp('gru-decisions-bad-config-');
      writeFileSync(join(instance, 'config.toml'), body);
      expect(() => loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'))).toThrow();
    }
  });
});

describe('typed decision semantics', () => {
  it('routes noul on probability and choice/score on confidence at exact boundaries', () => {
    const thresholds = cloneConfig(false).thresholds;
    expect(decisionRoute({ type: 'noul', noul: 0.6 }, 'read_only', thresholds)).toMatchObject({ path: 'act', metricKind: 'probability' });
    expect(decisionRoute({ type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 0.4 }, 'read_only', thresholds)).toMatchObject({ path: 'confirm', metricKind: 'confidence' });
    expect(decisionRoute({ type: 'score', score: 0, probabilities: { 0: 1 }, confidence: 0.39 }, 'read_only', thresholds).path).toBe('fallback');
    expect(decisionRoute({ type: 'noul', noul: 0.9 }, 'destructive', thresholds).requiresConfirm).toBe(true);
  });

  it('rejects malformed/out-of-range fields, unexpected choices and incompatible score schemas', () => {
    const choice = { type: 'choice', instructions: 'pick', options: ['a', 'b'], criteria: { a: 'a', b: 'b' } } as const;
    expect(() => validateAnswer(choice, { type: 'choice', choice: 'c', probabilities: { a: 0, b: 1 }, confidence: 1 }, 'q')).toThrow(/requested options/);
    expect(() => validateAnswer(choice, { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 }, 'q')).toThrow(/exactly/);
    expect(() => validateAnswer(choice, { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.8 }, confidence: 1 }, 'q')).toThrow(/sum to 1/);
    expect(() => validateAnswer({ type: 'noul', instructions: 'x' }, { type: 'noul', noul: Number.NaN }, 'q')).toThrow(/finite/);
    const scoreQuestion = { type: 'score', instructions: 'x', criteria: ['lo', 'hi'] } as const;
    expect(() => validateAnswer(scoreQuestion, { type: 'score', score: 2, probabilities: { 0: 0, 1: 1 }, confidence: 1 }, 'q')).toThrow(/rubric/);
    expect(validateAnswer(scoreQuestion, {
      type: 'score', score: 0, legend: { 0: 'lo', 1: 'hi' }, probabilities: { 0: 1, 1: 0 }, confidence: 1,
    }, 'q')).toMatchObject({ type: 'score', score: 0, legend: { 0: 'lo', 1: 'hi' } });
    expect(() => validateAnswer(scoreQuestion, {
      type: 'score', score: 0, legend: { 0: 'wrong', 1: 'hi' }, probabilities: { 0: 1, 1: 0 }, confidence: 1,
    }, 'q')).toThrow(/does not match/);
  });

  it('accepts the API-documented probability-weighted score BETWEEN rubric levels', () => {
    // docs.typesafe.ai/api: a Score answer's `score` is probability-weighted
    // and can land between levels (e.g. 1.05). Integer-only validation would
    // malformed_response every such live answer.
    const scoreQuestion = { type: 'score', instructions: 'x', criteria: ['lo', 'mid', 'hi'] } as const;
    expect(validateAnswer(scoreQuestion, {
      type: 'score', score: 1.05, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.9,
    }, 'q')).toMatchObject({ type: 'score', score: 1.05 });
    expect(() => validateAnswer(scoreQuestion, {
      type: 'score', score: 3.5, probabilities: { 0: 0.34, 1: 0.33, 2: 0.33 }, confidence: 1,
    }, 'q')).toThrow(/rubric/);
    expect(() => validateAnswer(scoreQuestion, {
      type: 'score', score: Number.NaN, probabilities: { 0: 0.34, 1: 0.33, 2: 0.33 }, confidence: 1,
    }, 'q')).toThrow(/rubric/);
  });

  it('rejects unsafe thresholds including a destructive no-confirm configuration', () => {
    expect(() => validateThresholdConfig({
      ...cloneConfig(false).thresholds,
      operational: { act: 0.5, confirm: 0.5, requireConfirmOnAct: false },
    })).toThrow(/less than/);
    expect(() => validateThresholdConfig({
      ...cloneConfig(false).thresholds,
      destructive: { act: 0.85, confirm: 0.7, requireConfirmOnAct: false },
    })).toThrow(/must be true/);
  });
});

describe('trusted Jev provider', () => {
  async function expectHttpFallback(status: number, reason: string): Promise<void> {
    const service = new JevDecisionService(
      new JevProvider({
        config: cloneConfig(true).jev,
        key: 'test-key',
        fetchImpl: (async () => new Response('private provider body', { status })) as typeof fetch,
      }),
      cloneConfig(true).thresholds,
    );
    const outcome = await service.decide(eventDecisionRequest(EVENT));
    expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: reason });
    expect(JSON.stringify(outcome)).not.toContain('private provider body');
    service.dispose();
  }

  it('sends one batched call, disables redirects and preserves honest provenance/usage', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 }));
    const service = new JevDecisionService(
      new JevProvider({ config: cloneConfig(true).jev, key: 'test-key', fetchImpl: fetchImpl as typeof fetch }),
      cloneConfig(true).thresholds,
    );
    const outcome = await service.decide(eventDecisionRequest(EVENT));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(String(init?.body)).questions).toHaveProperty('event_class');
    expect(outcome.provenance).toMatchObject({ source: 'jev', model: 'typesafe/jev-test' });
    expect(outcome.provenance.usage?.costUsd).toBe(0.000001);
    service.dispose();
  });

  it('never sends a resolved credential to custom/http/userinfo/redirect endpoints', async () => {
    const fetchImpl = vi.fn();
    for (const endpoint of [
      'http://openrouter.ai/api/alpha/decisions',
      'https://evil.example/api/alpha/decisions',
      'https://user@openrouter.ai/api/alpha/decisions',
      'https://openrouter.ai/api/alpha/decisions?next=evil',
    ]) {
      expect(() => new JevProvider({
        config: { ...cloneConfig(true).jev, endpoint },
        key: 'secret-test-key',
        credentialMode: 'resolved',
        fetchImpl: fetchImpl as typeof fetch,
      })).toThrow(/endpoint_untrusted/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows an explicitly injected in-process key to use another secure HTTPS endpoint', async () => {
    const endpoint = 'https://decision-stub.example/v1/decide';
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 }));
    const provider = new JevProvider({
      config: { ...cloneConfig(true).jev, endpoint },
      key: 'explicit-test-key',
      credentialMode: 'explicit',
      fetchImpl: fetchImpl as typeof fetch,
    });
    await provider.request(eventDecisionRequest(EVENT));
    expect(fetchImpl).toHaveBeenCalledWith(endpoint, expect.objectContaining({ redirect: 'manual' }));
    provider.dispose();
  });

  it('bounds provider response bytes before parsing', async () => {
    const service = new JevDecisionService(
      new JevProvider({
        config: cloneConfig(true).jev,
        key: 'test-key',
        fetchImpl: (async () => new Response('x', {
          status: 200,
          headers: { 'content-length': String(1024 * 1024 + 1) },
        })) as typeof fetch,
      }),
      cloneConfig(true).thresholds,
    );
    const outcome = await service.decide(eventDecisionRequest(EVENT));
    expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'malformed_response' });
    service.dispose();
  });

  it('caps concurrent provider requests at four and recovers when they settle', async () => {
    const pending: { body: string; resolve: (response: Response) => void }[] = [];
    const provider = new JevProvider({
      config: cloneConfig(true).jev,
      key: 'test-key',
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve) => pending.push({ body: String(init?.body), resolve }))) as typeof fetch,
    });
    const request = eventDecisionRequest(EVENT);
    const firstFour = Array.from({ length: 4 }, () => provider.request(request));
    expect(pending).toHaveLength(4);
    await expect(provider.request(request)).rejects.toMatchObject({ reason: 'capacity_limited' });
    for (const entry of pending) {
      entry.resolve(new Response(JSON.stringify(answerEnvelope(entry.body)), { status: 200 }));
    }
    await expect(Promise.all(firstFour)).resolves.toHaveLength(4);
    const afterSettlement = provider.request(request);
    expect(pending).toHaveLength(5);
    pending[4]!.resolve(new Response(JSON.stringify(answerEnvelope(pending[4]!.body)), { status: 200 }));
    await expect(afterSettlement).resolves.toMatchObject({ model: 'typesafe/jev-test' });
    provider.dispose();
  });

  it('falls back for malformed JSON and valid JSON missing required answers', async () => {
    for (const body of ['{', JSON.stringify({ model: 'test', answers: {} })]) {
      const service = new JevDecisionService(
        new JevProvider({
          config: cloneConfig(true).jev,
          key: 'test-key',
          fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
        }),
        cloneConfig(true).thresholds,
      );
      await expect(service.decide(eventDecisionRequest(EVENT))).resolves.toMatchObject({
        provenance: { source: 'deterministic', fallbackReason: 'malformed_response' },
      });
      service.dispose();
    }
  });

  it('classifies timeout/network failures and cancels rejected response bodies', async () => {
    const timeoutService = new JevDecisionService(
      new JevProvider({
        config: { ...cloneConfig(true).jev, timeoutMs: 10 },
        key: 'test-key',
        fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        })) as typeof fetch,
      }),
      cloneConfig(true).thresholds,
    );
    await expect(timeoutService.decide(eventDecisionRequest(EVENT))).resolves.toMatchObject({
      provenance: { source: 'deterministic', fallbackReason: 'timeout' },
    });

    const bodyTimeoutService = new JevDecisionService(
      new JevProvider({
        config: { ...cloneConfig(true).jev, timeoutMs: 10 },
        key: 'test-key',
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          let streamController!: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
          init?.signal?.addEventListener('abort', () => {
            streamController.error(new DOMException('body aborted', 'AbortError'));
          }, { once: true });
          return new Response(stream, { status: 200 });
        }) as typeof fetch,
      }),
      cloneConfig(true).thresholds,
    );
    await expect(bodyTimeoutService.decide(eventDecisionRequest(EVENT))).resolves.toMatchObject({
      provenance: { source: 'deterministic', fallbackReason: 'timeout' },
    });

    const networkService = new JevDecisionService(
      new JevProvider({
        config: cloneConfig(true).jev,
        key: 'test-key',
        fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
      }),
      cloneConfig(true).thresholds,
    );
    await expect(networkService.decide(eventDecisionRequest(EVENT))).resolves.toMatchObject({
      provenance: { source: 'deterministic', fallbackReason: 'network_error' },
    });

    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const provider = new JevProvider({
      config: cloneConfig(true).jev,
      key: 'test-key',
      fetchImpl: (async () => new Response(body, { status: 500 })) as typeof fetch,
    });
    await expect(provider.request(eventDecisionRequest(EVENT))).rejects.toMatchObject({ reason: 'provider_degraded' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('falls back with a safe reason for HTTP 401', async () => {
    await expectHttpFallback(401, 'auth_rejected');
  });

  it('falls back with a safe reason for HTTP 403', async () => {
    await expectHttpFallback(403, 'forbidden');
  });

  it('falls back with a safe reason for HTTP 429', async () => {
    await expectHttpFallback(429, 'provider_degraded');
  });
});

describe('outbound state filtering', () => {
  it('redacts labeled, URL-userinfo, opaque-key, environment, and CLI secrets before provider egress', async () => {
    const secret = 'CANARY-private-secret';
    const state = filteredState({
      detail: `Authorization: Bearer ${secret}`,
      command: `tool --token ${secret} --password "${secret} with spaces" OPENROUTER_API_KEY=${secret} run`,
      jsonLog: `request failed: {"token":"${secret}","next":"safe"}`,
      nested: { api_key: secret },
    });
    expect(state).not.toContain(secret);
    expect(state).toContain('[redacted]');

    const dsnPassword = 'DSN-PASSWORD-CANARY';
    const providerState = eventDecisionRequest({
      seq: 1,
      ts: new Date(0).toISOString(),
      kind: 'agent.state',
      agentId: 'a1',
      jobId: null,
      roundId: null,
      lens: null,
      payload: { error: `const dsn = 'postgres://reviewer:${dsnPassword}@db.internal/app'; const opaque = 'sk-or-v1-abcdefghijklmnop';` },
    }).state;
    expect(providerState).not.toContain(dsnPassword);
    expect(providerState).not.toContain('sk-or-v1-abcdefghijklmnop');
    expect(providerState).toContain('postgres://reviewer:[redacted]@db.internal/app');
    const outboundBodies: string[] = [];
    const service = new JevDecisionService(
      new JevProvider({
        config: cloneConfig(true).jev,
        key: 'transport-key',
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          outboundBodies.push(String(init?.body));
          return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
        }) as typeof fetch,
      }),
      cloneConfig(true).thresholds,
    );
    await service.decide(eventDecisionRequest({
      seq: 2,
      ts: new Date(0).toISOString(),
      kind: 'agent.state',
      agentId: 'a1',
      jobId: null,
      roundId: null,
      lens: null,
      payload: { error: `const dsn = 'postgres://reviewer:${dsnPassword}@db.internal/app';` },
    }));
    expect(outboundBodies).toHaveLength(1);
    expect(outboundBodies[0]).not.toContain(dsnPassword);
    service.dispose();
  });
});

describe('portable credential resolver', () => {
  it('captures the provider environment once and removes the key before child-process inheritance', () => {
    const ambient: NodeJS.ProcessEnv = { PATH: process.env.PATH, OPENROUTER_API_KEY: 'private-test-key' };
    const isolated = isolateDecisionEnvironment(ambient);
    expect(isolated.OPENROUTER_API_KEY).toBe('private-test-key');
    expect(ambient.OPENROUTER_API_KEY).toBeUndefined();
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.OPENROUTER_API_KEY ?? "absent")'], {
      env: ambient,
      encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('absent');
  });

  it('writes atomically with 0700/0600, survives a fresh resolution and honors env precedence', () => {
    const home = temp('gru-decisions-cred-');
    expect(parseCredentialStdin('file-key\n')).toBe('file-key');
    expect(() => parseCredentialStdin('two\nlines\n')).toThrow(/one non-empty line/);
    writeCredential(home, 'file-key');
    expect(lstatSync(join(home, 'credentials')).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(home, 'credentials', 'openrouter.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, 'credentials', 'openrouter.key'), 'utf8')).toBe('file-key');
    expect(resolveCredential(home, {}).source).toBe('file');
    expect(resolveCredential(home, { OPENROUTER_API_KEY: 'env-key' })).toMatchObject({ state: 'present', source: 'environment', key: 'env-key' });
  });

  it('rejects symlinks, loose modes, empty values and does not repair unsafe stores', () => {
    const home = temp('gru-decisions-unsafe-');
    const dir = join(home, 'credentials');
    mkdirSync(dir, { mode: 0o700 });
    const target = join(home, 'target');
    writeFileSync(target, 'not-secret');
    symlinkSync(target, join(dir, 'openrouter.key'));
    expect(resolveCredential(home, {})).toMatchObject({ state: 'unsafe', source: 'file' });
    expect(() => writeCredential(home, 'new-key')).toThrow(/unsafe/);

    rmSync(join(dir, 'openrouter.key'));
    writeFileSync(join(dir, 'openrouter.key'), 'key', { mode: 0o600 });
    chmodSync(dir, 0o755);
    expect(resolveCredential(home, {}).state).toBe('unsafe');
    expect(lstatSync(dir).mode & 0o777).toBe(0o755);
    expect(resolveCredential(home, { OPENROUTER_API_KEY: '  ' }).state).toBe('invalid');
  });
});

describe('runtime startup, degradation and generation safety', () => {
  it('default-off starts and serves every request with zero provider calls', async () => {
    const fetchImpl = vi.fn();
    const runtime = new DecisionRuntime(cloneConfig(false), {
      instanceDir: temp('gru-decisions-off-'),
      env: {},
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
    });
    expect(await runtime.start()).toMatchObject({ status: 'disabled', enabled: false });
    const event = await runtime.decide(eventDecisionRequest(EVENT));
    const supervision = await runtime.decide(supervisionDecisionRequest({
      reason: 'network failed', agentId: 'a1', role: 'minion', restartCount: 1, breakerLimit: 3,
    }));
    for (const outcome of [event, supervision]) {
      expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'disabled' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('keeps routing usable when status and notification side effects throw', async () => {
    const logs: string[] = [];
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir: temp('gru-decisions-side-effects-'),
      env: {},
      watchConfig: false,
      notifications: {
        postIncident() { throw new Error('notification store unavailable'); },
        resolveIncidents() { throw new Error('resolution store unavailable'); },
      } as unknown as NotificationCenter,
      onStatusChange() { throw new Error('status bus unavailable'); },
      log: (_level, message) => logs.push(message),
    });
    expect(await runtime.start()).toMatchObject({ status: 'degraded', reason: 'credential_missing' });
    expect((await runtime.decide(eventDecisionRequest(EVENT))).provenance.source).toBe('deterministic');
    expect(logs.some((message) => message.includes('failed; routing state remains usable'))).toBe(true);
    runtime.dispose();
  });

  it('missing credential stays usable, posts one durable actionable incident across restarts', async () => {
    const data = temp('gru-decisions-notify-');
    const db = new LedgerDb(data);
    const bus = new EventBus();
    const ledger = new LedgerApi(db.handle, { bus });
    const center = new NotificationCenter({ ledger, bus });
    for (let index = 0; index < 2; index += 1) {
      const runtime = new DecisionRuntime(cloneConfig(true), {
        instanceDir: join(data, 'instance'),
        env: {},
        notifications: center,
        watchConfig: false,
      });
      expect(await runtime.start()).toMatchObject({ status: 'degraded', reason: 'credential_missing' });
      runtime.dispose();
    }
    const incidents = ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === 'decisions.degraded.credential_missing');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ routing: 'action-required', severity: 'error' });
    db.close();
  });

  it('records a durable FYI recovery after a degraded provider becomes ready', async () => {
    const data = temp('gru-decisions-recovery-');
    const db = new LedgerDb(data);
    const bus = new EventBus();
    const ledger = new LedgerApi(db.handle, { bus });
    const center = new NotificationCenter({ ledger, bus });
    const instanceDir = join(data, 'instance');
    mkdirSync(instanceDir);
    writeFileSync(join(instanceDir, 'config.toml'), '[decisions.jev]\nenabled = true\n');
    const env: NodeJS.ProcessEnv = { GRU_COMMAND_HOME: instanceDir };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 }));
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir,
      env,
      fetchImpl: fetchImpl as typeof fetch,
      notifications: center,
      watchConfig: false,
    });
    expect(await runtime.start()).toMatchObject({ status: 'degraded', reason: 'credential_missing' });
    env.OPENROUTER_API_KEY = 'test-key';
    expect(await runtime.recheck()).toMatchObject({ status: 'ready', reason: null });
    const incidents = ledger.listNotifications({ limit: 50 });
    expect(incidents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'decisions.degraded.credential_missing',
        routing: 'action-required',
        ackedAt: null,
        resolvedAt: expect.any(String),
        resolvedBy: 'decisions-runtime',
      }),
      expect.objectContaining({ kind: 'decisions.recovered', routing: 'fyi', severity: 'info' }),
    ]));
    runtime.dispose();
    db.close();
  });

  it('starts ready from the protected credential file without an environment key', async () => {
    const instanceDir = temp('gru-decisions-file-ready-');
    writeCredential(instanceDir, 'file-only-key');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer file-only-key');
      return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
    });
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir,
      env: {},
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready', credentialSource: 'file' });
    runtime.dispose();

    // A fresh process-level runtime resolves the same protected file again;
    // readiness must not depend on an inherited environment secret.
    const restarted = new DecisionRuntime(cloneConfig(true), {
      instanceDir,
      env: {},
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
    });
    expect(await restarted.start()).toMatchObject({ status: 'ready', credentialSource: 'file' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    restarted.dispose();
  });

  it('requires semantically healthy startup answers, not merely an HTTP 200 schema', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const envelope = answerEnvelope(String(init?.body));
      const answers = envelope.answers as Record<string, unknown>;
      answers.provider_alive = { type: 'noul', noul: 0.1 };
      return new Response(JSON.stringify(envelope), { status: 200 });
    });
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir: temp('gru-decisions-probe-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
    });
    expect(await runtime.start()).toMatchObject({ status: 'degraded', reason: 'probe_failed' });
    runtime.dispose();
  });

  it('health probing ignores operator confirmation preferences while still validating semantic answers', async () => {
    const config = cloneConfig(true);
    const configured: DecisionsConfig = {
      ...config,
      thresholds: {
        ...config.thresholds,
        read_only: { ...config.thresholds.read_only, requireConfirmOnAct: true },
      },
    };
    const runtime = new DecisionRuntime(configured, {
      instanceDir: temp('gru-decisions-probe-confirm-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 })) as typeof fetch,
      watchConfig: false,
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready' });
    runtime.dispose();
  });

  it('serializes a config edit/recheck that arrives during the startup probe', async () => {
    let releaseStartup!: (response: Response) => void;
    let startupBody = '';
    const disabled = cloneConfig(false);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      startupBody = String(init?.body);
      return await new Promise<Response>((resolve) => { releaseStartup = resolve; });
    });
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir: temp('gru-decisions-start-race-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
      loadConfig: () => ({ decisions: disabled } as ReturnType<typeof loadConfig>),
    });
    const startup = runtime.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    expect(runtime.recheck()).toBe(startup);
    releaseStartup(new Response(JSON.stringify(answerEnvelope(startupBody)), { status: 200 }));
    await expect(startup).resolves.toMatchObject({ status: 'disabled', reason: 'disabled' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it('invalid configuration arriving during the startup probe aborts stale readiness', async () => {
    let invalid = false;
    const enabled = cloneConfig(true);
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }));
    const runtime = new DecisionRuntime(enabled, {
      instanceDir: temp('gru-decisions-invalid-startup-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
      loadConfig: () => {
        if (invalid) throw new Error('malformed config');
        return { decisions: enabled } as ReturnType<typeof loadConfig>;
      },
    });
    const startup = runtime.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    invalid = true;
    expect(runtime.recheck()).toBe(startup);
    await expect(startup).resolves.toMatchObject({ status: 'degraded', reason: 'config_invalid' });
    expect(runtime.status()).toMatchObject({ status: 'degraded', reason: 'config_invalid' });
    runtime.dispose();
  });

  it('invalid configuration arriving during a recheck probe aborts stale readiness', async () => {
    let invalid = false;
    let next = cloneConfig(true);
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir: temp('gru-decisions-invalid-recheck-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
      loadConfig: () => {
        if (invalid) throw new Error('malformed config');
        return { decisions: next } as ReturnType<typeof loadConfig>;
      },
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready' });
    next = { ...next, jev: { ...next.jev, model: '~typesafe/jev-recheck' } };
    const recheck = runtime.recheck();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    invalid = true;
    expect(runtime.recheck()).toBe(recheck);
    await expect(recheck).resolves.toMatchObject({ status: 'degraded', reason: 'config_invalid' });
    runtime.dispose();
  });

  it('coalesces concurrent rechecks into one active probe plus at most one trailing probe', async () => {
    let releaseFirst!: (response: Response) => void;
    let firstBody = '';
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        firstBody = String(init?.body);
        return await new Promise<Response>((resolve) => { releaseFirst = resolve; });
      }
      return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
    });
    const enabled = cloneConfig(true);
    const runtime = new DecisionRuntime(cloneConfig(false), {
      instanceDir: temp('gru-decisions-coalesce-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
      loadConfig: () => ({ decisions: enabled } as ReturnType<typeof loadConfig>),
    });
    const checks = Array.from({ length: 10 }, () => runtime.recheck());
    expect(new Set(checks).size).toBe(1);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releaseFirst(new Response(JSON.stringify(answerEnvelope(firstBody)), { status: 200 }));
    await expect(Promise.all(checks)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'ready' })]));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('does not lose a disable edit arriving during a trailing probe', async () => {
    const enabled = cloneConfig(true);
    const disabled = cloneConfig(false);
    let selected = enabled;
    const pending: { body: string; resolve: (response: Response) => void }[] = [];
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve) => pending.push({ body: String(init?.body), resolve })));
    const runtime = new DecisionRuntime(cloneConfig(false), {
      instanceDir: temp('gru-decisions-coalesce-disable-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
      loadConfig: () => ({ decisions: selected } as ReturnType<typeof loadConfig>),
    });
    const operation = runtime.recheck();
    expect(runtime.recheck()).toBe(operation);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.resolve(new Response(JSON.stringify(answerEnvelope(pending[0]!.body)), { status: 200 }));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    selected = disabled;
    expect(runtime.recheck()).toBe(operation);
    pending[1]!.resolve(new Response(JSON.stringify(answerEnvelope(pending[1]!.body)), { status: 200 }));
    await expect(operation).resolves.toMatchObject({ status: 'disabled', reason: 'disabled' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('hot reload observes atomic config replacement without a restart', async () => {
    const instanceDir = temp('gru-decisions-watch-');
    const configFile = join(instanceDir, 'config.toml');
    writeFileSync(configFile, '[decisions.jev]\nenabled = false\n');
    const env = { GRU_COMMAND_HOME: instanceDir };
    const runtime = new DecisionRuntime(loadConfig(env, temp('gru-decisions-home-')).decisions, {
      instanceDir,
      env,
      home: temp('gru-decisions-home-'),
      watchConfig: true,
    });
    expect(await runtime.start()).toMatchObject({ status: 'disabled' });

    const replacement = join(instanceDir, 'config.toml.next');
    writeFileSync(replacement, '[decisions.jev]\nenabled = true\n');
    const { renameSync } = await import('node:fs');
    renameSync(replacement, configFile);
    await vi.waitFor(() => expect(runtime.status()).toMatchObject({ status: 'degraded', reason: 'credential_missing' }), { timeout: 10_000 });

    writeFileSync(replacement, '[decisions.jev]\nenabled = false\n');
    renameSync(replacement, configFile);
    await vi.waitFor(() => expect(runtime.status()).toMatchObject({ status: 'disabled', reason: 'disabled' }), { timeout: 10_000 });
    runtime.dispose();
  });

  it('disable during an in-flight answer discards it, starts no further request, and can re-enable through a fresh probe', async () => {
    const instanceDir = temp('gru-decisions-reload-');
    const configFile = join(instanceDir, 'config.toml');
    writeFileSync(configFile, '[decisions.jev]\nenabled = true\n');
    const env = { GRU_COMMAND_HOME: instanceDir, OPENROUTER_API_KEY: 'test-key' };
    const config = loadConfig(env, temp('gru-decisions-home-'));
    let releaseLate: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (fetchImpl.mock.calls.length === 1 || fetchImpl.mock.calls.length === 3) {
        return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
      }
      return await new Promise<Response>((resolve) => { releaseLate = resolve; });
    });
    const runtime = new DecisionRuntime(config.decisions, {
      instanceDir,
      env,
      home: temp('gru-decisions-home-'),
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready' });
    const pending = runtime.decide(eventDecisionRequest(EVENT));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    writeFileSync(configFile, '[decisions.jev]\nenabled = false\n');
    expect(await runtime.recheck()).toMatchObject({ status: 'disabled' });
    releaseLate!(new Response(JSON.stringify(answerEnvelope(JSON.stringify({ questions: eventDecisionRequest(EVENT).questions }))), { status: 200 }));
    expect((await pending).provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'stale_generation' });
    await runtime.decide(eventDecisionRequest(EVENT));
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    writeFileSync(configFile, '[decisions.jev]\nenabled = true\n');
    expect(await runtime.recheck()).toMatchObject({ status: 'ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    runtime.dispose();
  });

  it('invalid reload aborts an active answer, degrades immediately, and recovers only through a fresh probe', async () => {
    let invalid = false;
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1 || calls === 3) {
        return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    });
    const enabled = cloneConfig(true);
    const runtime = new DecisionRuntime(enabled, {
      instanceDir: temp('gru-decisions-invalid-active-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
      loadConfig: () => {
        if (invalid) throw new Error('malformed config');
        return { decisions: enabled } as ReturnType<typeof loadConfig>;
      },
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready' });
    const pending = runtime.decide(eventDecisionRequest(EVENT));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    invalid = true;
    expect(await runtime.recheck()).toMatchObject({ status: 'degraded', reason: 'config_invalid' });
    expect((await pending).provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'stale_generation' });
    invalid = false;
    expect(await runtime.recheck()).toMatchObject({ status: 'ready' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    runtime.dispose();
  });
});
