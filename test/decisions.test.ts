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
import {
  DEFAULT_DECISIONS_CONFIG,
  effectiveDecisionProviders,
  DEFAULT_DECISION_PROFILE,
  loadConfig,
  type DecisionProviderTable,
  type DecisionsConfig,
  type GruCommandConfig,
} from '../src/config.js';
import {
  isolateDecisionEnvironment,
  parseCredentialStdin,
  resolveCredential,
  writeCredential,
} from '../src/decisions/credentials.js';
import {
  ESCALATION_TRIAGE_QUESTIONS,
  REPORT_CONCLUSION_QUESTIONS,
  SAME_BLOCKER_QUESTIONS,
  deterministicFailureClass,
  eventDecisionRequest,
  escalationTriageDecisionRequest,
  fileOfLocation,
  filteredState,
  redactedText,
  reportConclusionDecisionRequest,
  reportConclusionState,
  summariseReportBody,
  sameBlockerDecisionRequest,
  supervisionDecisionRequest,
} from '../src/decisions/questions.js';
import type { EscalationFacts } from '../src/decisions/questions.js';
import { surfaceCaseSpec } from '../src/decisions/cases/registry.js';
import { ProfileDecisionService, ProfileProvider } from '../src/decisions/provider.js';
import { checkDecisionProfile, DecisionRuntime, TRANSIENT_RECHECK_FACTORS } from '../src/decisions/runtime.js';
import { deterministicOutcome } from '../src/decisions/service.js';
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
    providers: {},
    surfaces: {},
    thresholds: {
      read_only: { ...DEFAULT_DECISIONS_CONFIG.thresholds.read_only },
      operational: { ...DEFAULT_DECISIONS_CONFIG.thresholds.operational },
      destructive: { ...DEFAULT_DECISIONS_CONFIG.thresholds.destructive },
    },
  };
}

/** One full provider profile mirroring the legacy `[decisions.jev]` block
 * the old single-provider tests were written against. */
function providerProfile(overrides: Partial<DecisionProviderTable> = {}): DecisionProviderTable {
  return {
    protocol: 'openrouter-decisions',
    endpoint: DEFAULT_DECISIONS_CONFIG.jev.endpoint,
    model: DEFAULT_DECISIONS_CONFIG.jev.model,
    credential: 'openrouter',
    timeoutMs: DEFAULT_DECISIONS_CONFIG.jev.timeoutMs,
    inputPricePerMtok: 0.042,
    ...overrides,
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  it('wall classification requires real auth/quota signals, not bare substrings', () => {
    expect(deterministicFailureClass('HTTP 401 unauthorized')).toBe('authentication_wall');
    expect(deterministicFailureClass('invalid api key rejected')).toBe('authentication_wall');
    expect(deterministicFailureClass('quota exceeded (HTTP 429)')).toBe('quota_wall');
    expect(deterministicFailureClass('rate limit hit')).toBe('quota_wall');
    expect(deterministicFailureClass('the author of the review paused the run')).toBe('unknown');
    expect(deterministicFailureClass('connection to port 13020 failed')).toBe('network_failure');
    expect(deterministicFailureClass('turn hang detected')).toBe('turn_hang');
    expect(deterministicFailureClass('compaction hang detected')).toBe('turn_hang');
    expect(deterministicFailureClass('fatal opaque runtime failure')).toBe('fatal_runtime');
    // Compound/camel spellings keep their walls (the r1 word-boundary fix
    // must not trade recall for precision).
    expect(deterministicFailureClass('oauth token rejected by provider')).toBe('authentication_wall');
    expect(deterministicFailureClass('auth_error: invalid credentials')).toBe('authentication_wall');
    expect(deterministicFailureClass('authn failure: bad key')).toBe('authentication_wall');
    expect(deterministicFailureClass('RateLimited by upstream')).toBe('quota_wall');
    expect(deterministicFailureClass('agent crashed on boot')).toBe('fatal_runtime');
  });

  it('bounds the redaction scan cost: the pre-slice order is load-bearing on hostile single-line blocks', () => {
    // One long single line of word-character filler with secret markers —
    // the shape that makes the labeled-secret scans quadratic when they run
    // before any bound (the r2 battery measured ~448,000 ms slice-last on
    // this class; the shipped pre-slice order stays in milliseconds).
    // The measured worst case: a long MATCH-FREE word-char run. Every start
    // position expands the lazy labeled-secret prefixes to the end of the
    // line when no match exists — O(n²) slice-last (300k chars ≈ 129 s
    // measured); the shipped pre-slice bounds every pass to the 4× window.
    const hostile = 'q'.repeat(80_000) + 'CANARY-beyond-any-window'; // slice-last on this shape measured ~9 s (quadratic in the run length)
    const started = Date.now();
    const out = redactedText(hostile, 800);
    const elapsed = Date.now() - started;
    // The marker sits beyond every window: truncation (not redaction)
    // removes it, and the output stays bounded.
    expect(out).not.toContain('CANARY');
    expect(out.length).toBeLessThanOrEqual(800);
    // A reverted order must blow this budget — and the test timeout —
    // instead of passing on output shape.
    expect(elapsed).toBeLessThan(1_500);
  }, 2_000);

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
    const service = new ProfileDecisionService(
      new ProfileProvider({
        profile: providerProfile(),
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
    const service = new ProfileDecisionService(
      new ProfileProvider({ profile: providerProfile(), key: 'test-key', fetchImpl: fetchImpl as typeof fetch }),
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
      expect(() => new ProfileProvider({
        profile: providerProfile({ endpoint }),
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
    const provider = new ProfileProvider({
      profile: providerProfile({ endpoint }),
      key: 'explicit-test-key',
      credentialMode: 'explicit',
      fetchImpl: fetchImpl as typeof fetch,
    });
    await provider.request(eventDecisionRequest(EVENT));
    expect(fetchImpl).toHaveBeenCalledWith(endpoint, expect.objectContaining({ redirect: 'manual' }));
    provider.dispose();
  });

  it('bounds provider response bytes before parsing', async () => {
    const service = new ProfileDecisionService(
      new ProfileProvider({
        profile: providerProfile(),
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
    const provider = new ProfileProvider({
      profile: providerProfile(),
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
      const service = new ProfileDecisionService(
        new ProfileProvider({
          profile: providerProfile(),
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
    const timeoutService = new ProfileDecisionService(
      new ProfileProvider({
        profile: providerProfile({ timeoutMs: 10 }),
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

    const bodyTimeoutService = new ProfileDecisionService(
      new ProfileProvider({
        profile: providerProfile({ timeoutMs: 10 }),
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

    const networkService = new ProfileDecisionService(
      new ProfileProvider({
        profile: providerProfile(),
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
    const provider = new ProfileProvider({
      profile: providerProfile(),
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
    const service = new ProfileDecisionService(
      new ProfileProvider({
        profile: providerProfile(),
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

  it('accepts a key file saved by an editor with one final newline, still rejecting a second line', () => {
    const home = temp('gru-decisions-eol-');
    writeCredential(home, 'file-key');
    const file = join(home, 'credentials', 'openrouter.key');
    writeFileSync(file, 'file-key\n', { mode: 0o600 });
    expect(resolveCredential(home, {})).toMatchObject({ state: 'present', source: 'file', key: 'file-key' });
    writeFileSync(file, 'file-key\r\n', { mode: 0o600 });
    expect(resolveCredential(home, {})).toMatchObject({ state: 'present', source: 'file', key: 'file-key' });
    writeFileSync(file, 'file-key\nsecond\n', { mode: 0o600 });
    expect(resolveCredential(home, {}).state).toBe('invalid');
    writeFileSync(file, 'file-key\n\n', { mode: 0o600 });
    expect(resolveCredential(home, {}).state).toBe('invalid');
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
  it('packages the amendment-specified sensor context into the event request state', () => {
    const state = eventDecisionRequest(EVENT, {
      transcriptTail: 'last bounded tail of the error surface',
      recentSameSourceEvents: 3,
      recentSameKindEvents: 2,
    }).state;
    const parsed = JSON.parse(state) as {
      transcript_tail?: string;
      recent_same_source?: { events?: number; same_kind?: number };
    };
    expect(parsed.transcript_tail).toBe('last bounded tail of the error surface');
    expect(parsed.recent_same_source).toEqual({ events: 3, same_kind: 2 });
    // Default context stays shape-stable for callers without a sensor.
    const bare = JSON.parse(eventDecisionRequest(EVENT).state) as {
      transcript_tail?: unknown;
      recent_same_source?: unknown;
    };
    expect(bare.transcript_tail).toBeNull();
    expect(bare.recent_same_source).toEqual({ events: 0, same_kind: 0 });
  });

  it('bounds the redaction scan window: long tails truncate without leaking and in-window secrets still redact', () => {
    const inWindow = `${'x'.repeat(1_000)} Authorization: Bearer CANARY-in-window`;
    expect(redactedText(inWindow, 800)).not.toContain('CANARY-in-window');
    const out = redactedText(`${'x'.repeat(100_000)}\nCANARY-beyond-window`, 800);
    expect(out).not.toContain('CANARY-beyond-window');
    expect(out).toHaveLength(800);
  });

  it('an unrelated config typo never flips a Jev-off instance on or invents an incident', async () => {
    const postIncident = vi.fn();
    const runtime = new DecisionRuntime(cloneConfig(false), {
      instanceDir: temp('gru-decisions-off-invalid-'),
      env: {},
      watchConfig: false,
      loadConfig: () => {
        throw new Error('boom: unrelated config typo');
      },
      notifications: {
        postIncident,
        post: vi.fn(),
        resolveIncidents: vi.fn(() => []),
      } as unknown as NotificationCenter,
    });
    expect(await runtime.start()).toMatchObject({ status: 'disabled', enabled: false });
    const status = await runtime.recheck(); // configureFromDisk throws → degradeInvalidConfig
    expect(status).toMatchObject({ enabled: false, status: 'disabled', reason: 'config_invalid' });
    expect(postIncident).not.toHaveBeenCalled();
    const outcome = await runtime.decide(eventDecisionRequest(EVENT));
    expect(outcome.provenance).toMatchObject({ source: 'deterministic' });
    runtime.dispose();
  });

  it('a transient decide-time failure degrades, then ONE bounded automatic recheck PER INCIDENT recovers without operator action', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      // Odd calls are startup/recheck probes (succeed); even calls are
      // decide-time requests (fail) — two incidents, two bounded recoveries.
      if (calls % 2 === 0) throw new TypeError('transient decide-time network blip');
      return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
    }) as unknown as typeof fetch;
    const notifications = {
      postIncident: vi.fn(),
      post: vi.fn(),
      resolveIncidents: vi.fn(() => []),
    };
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir: temp('gru-decisions-transient-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl,
      watchConfig: false,
      transientRecoveryMs: 10,
      loadConfig: () => ({ decisions: cloneConfig(true) } as unknown as GruCommandConfig),
      notifications: notifications as unknown as NotificationCenter,
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready' }); // probe 1
    const first = await runtime.decide(eventDecisionRequest(EVENT)); // call 2 fails
    expect(first.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'network_error' });
    expect(await runtime.status()).toMatchObject({ status: 'degraded', reason: 'network_error' });
    await vi.waitFor(() => expect(runtime.status()).toMatchObject({ status: 'ready' })); // probe 3: incident 1 healed
    // Re-armed by recovery: a SECOND incident gets its own single recheck.
    const second = await runtime.decide(eventDecisionRequest(EVENT)); // call 4 fails
    expect(second.provenance).toMatchObject({ source: 'deterministic' });
    await vi.waitFor(() => expect(runtime.status()).toMatchObject({ status: 'ready' })); // probe 5: incident 2 healed
    // resolveIncidents fires on every ready transition: boot + 2 recoveries.
    expect(notifications.resolveIncidents).toHaveBeenCalledTimes(3);
    runtime.dispose();
  });

  it('a still-down provider gets a bounded backoff of automatic rechecks and then stops retrying on its own', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('provider down');
    }) as unknown as typeof fetch;
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir: temp('gru-decisions-loop-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl,
      watchConfig: false,
      transientRecoveryMs: 10, // base: rechecks at 10, 50, 150 and 600 ms
      loadConfig: () => ({ decisions: cloneConfig(true) } as unknown as GruCommandConfig),
    });
    await runtime.start(); // probe 1 fails → degrade → schedules recheck 1
    expect(await runtime.status()).toMatchObject({ status: 'degraded', reason: 'network_error' });
    const budget = TRANSIENT_RECHECK_FACTORS.length;
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1 + budget), { timeout: 5_000 });
    await sleep(800); // longer than the last backoff step: nothing else may fire
    expect(fetchImpl).toHaveBeenCalledTimes(1 + budget); // bounded: no further attempt, no loop
    expect(await runtime.status()).toMatchObject({ status: 'degraded', reason: 'network_error' });
    runtime.dispose();
  });

  it('non-transient decide-time failures (auth) degrade without any automatic recheck', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 401 })) as unknown as typeof fetch;
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir: temp('gru-decisions-auth-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl,
      watchConfig: false,
      transientRecoveryMs: 10,
      // ENABLED on-disk config: if auth were (wrongly) treated as transient,
      // the automatic recheck would re-probe here — this stub makes that
      // mutation visible as fetch call #2 instead of hiding behind a
      // default-off disk read.
      loadConfig: () => ({ decisions: cloneConfig(true) } as unknown as GruCommandConfig),
    });
    await runtime.start(); // probe 401 → auth_rejected (human action, no auto retry)
    expect(await runtime.status()).toMatchObject({ status: 'degraded', reason: 'auth_rejected' });
    await sleep(60);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the mutated list would re-probe (2+)
    runtime.dispose();
  });

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
    expect(incidents[0]).toMatchObject({ routing: 'needs-owner', severity: 'error' });
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
        routing: 'needs-owner',
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

  it('asks a startup liveness noul that its own probe state can answer', async () => {
    // Live Jev 1.13 answered the original self-referential question ("did the
    // provider receive and answer this?") at 0.35-0.37 every time, never the
    // 0.5 bar: no state can evidence it. The noul's TRUE criterion must be
    // stated by the probe state itself, or a healthy provider can never pass.
    const captured: { body?: string } = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body ??= String(init?.body);
      return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
    });
    const runtime = new DecisionRuntime(cloneConfig(true), {
      instanceDir: temp('gru-decisions-probe-state-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
    });
    await runtime.start();
    runtime.dispose();
    const probe = JSON.parse(captured.body ?? 'null') as {
      readonly state: string;
      readonly questions: Readonly<Record<string, { readonly criteria?: { readonly true?: string } }>>;
    } | null;
    expect(probe).not.toBeNull();
    const state = probe?.state.toLowerCase() ?? '';
    expect(state).toContain('synthetic');
    expect(state).toContain('health check');
    expect(state).toContain('decision provider is reachable');
    expect(probe?.questions['provider_alive']?.criteria?.true?.toLowerCase()).toContain('decision provider is reachable');
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

// ------------------------------------------------------------------
// Issue #222 — decision provider profiles
// ------------------------------------------------------------------

describe('decision provider profiles (issue #222)', () => {
  const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
  const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

  function systemoneProfile(overrides: Partial<DecisionProviderTable> = {}): DecisionProviderTable {
    return providerProfile({
      protocol: 'systemone',
      endpoint: TYPESAFE_ENDPOINT,
      model: 'jev-latest',
      credential: 'typesafe',
      ...overrides,
    });
  }

  function writeInstanceConfig(instance: string, body: string): string {
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'config.toml'), body);
    return instance;
  }

  describe('config schema', () => {
    it('parses a full provider table and a surface routing entry (fail-before: unknown keys)', () => {
      const instance = writeInstanceConfig(temp('gru-decisions-222-config-'), [
        '[decisions.jev]',
        'enabled = true',
        '[decisions.providers.typesafe-direct]',
        'protocol = "systemone"',
        `endpoint = "${TYPESAFE_ENDPOINT}"`,
        'model = "jev-latest"',
        'credential = "typesafe"',
        'timeout_ms = 2500',
        'input_price_per_mtok = 0.05',
        '[decisions.surfaces]',
        'event_triage = "typesafe-direct"',
      ].join('\n'));
      const loaded = loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'));
      expect(loaded.decisions.providers['typesafe-direct']).toEqual({
        protocol: 'systemone',
        endpoint: TYPESAFE_ENDPOINT,
        model: 'jev-latest',
        credential: 'typesafe',
        timeoutMs: 2500,
        inputPricePerMtok: 0.05,
      });
      expect(loaded.decisions.surfaces).toEqual({ event_triage: { provider: 'typesafe-direct' } });
    });

    it('always exposes the three built-in profiles and feeds openrouter-jev from the legacy [decisions.jev] block', () => {
      const instance = writeInstanceConfig(temp('gru-decisions-222-builtin-'), [
        '[decisions.jev]',
        'enabled = true',
        'endpoint = "https://openrouter.ai/api/alpha/decisions"',
        'model = "~typesafe/jev-latest"',
        'timeout_ms = 4321',
      ].join('\n'));
      const loaded = loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'));
      const effective = effectiveDecisionProviders(loaded.decisions);
      expect(Object.keys(effective).sort()).toEqual(['local', 'openrouter-jev', 'typesafe-direct']);
      // Legacy block keeps feeding the default profile.
      expect(effective[DEFAULT_DECISION_PROFILE]).toMatchObject({
        protocol: 'openrouter-decisions',
        endpoint: OPENROUTER_ENDPOINT,
        model: '~typesafe/jev-latest',
        credential: 'openrouter',
        timeoutMs: 4321,
      });
      expect(effective['typesafe-direct']).toMatchObject({ protocol: 'systemone', endpoint: TYPESAFE_ENDPOINT, credential: 'typesafe' });
      expect(effective['local']).toMatchObject({ protocol: 'systemone', endpoint: 'http://127.0.0.1:8088/v1/systemone', credential: 'none' });
    });

    it('a re-declared built-in overrides it; validation still applies to the merge', () => {
      const instance = writeInstanceConfig(temp('gru-decisions-222-override-'), [
        '[decisions.providers.local]',
        'protocol = "systemone"',
        'endpoint = "http://localhost:9988/v1/systemone"',
        'model = "kev-1b"',
        'credential = "none"',
        'timeout_ms = 1500',
      ].join('\n'));
      const loaded = loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'));
      expect(effectiveDecisionProviders(loaded.decisions)['local']).toMatchObject({ model: 'kev-1b', timeoutMs: 1500 });
    });

    it('rejects unknown/missing keys, wrong protocol, unknown slot, cross-host slots and keyless non-loopback', () => {
      const header = '[decisions.jev]\nenabled = true\n';
      for (const body of [
        // unknown key in a profile table
        `${header}[decisions.providers.x]\nprotocol = "systemone"\nendpoint = "${TYPESAFE_ENDPOINT}"\nmodel = "m"\ncredential = "typesafe"\ntimeout_ms = 10\nsurf = 1\n`,
        // missing required keys
        `${header}[decisions.providers.x]\nprotocol = "systemone"\nendpoint = "${TYPESAFE_ENDPOINT}"\nmodel = "m"\n`,
        // wrong protocol
        `${header}[decisions.providers.x]\nprotocol = "openai"\nendpoint = "${TYPESAFE_ENDPOINT}"\nmodel = "m"\ncredential = "typesafe"\ntimeout_ms = 10\n`,
        // unknown credential slot
        `${header}[decisions.providers.x]\nprotocol = "systemone"\nendpoint = "${TYPESAFE_ENDPOINT}"\nmodel = "m"\ncredential = "custom-slot"\ntimeout_ms = 10\n`,
        // a resolved openrouter key can never be bound to another host
        `${header}[decisions.providers.x]\nprotocol = "openrouter-decisions"\nendpoint = "${TYPESAFE_ENDPOINT}"\nmodel = "m"\ncredential = "openrouter"\ntimeout_ms = 10\n`,
        // keyless is loopback-only
        `${header}[decisions.providers.x]\nprotocol = "systemone"\nendpoint = "${TYPESAFE_ENDPOINT}"\nmodel = "m"\ncredential = "none"\ntimeout_ms = 10\n`,
        // keyless is https-or-loopback only
        `${header}[decisions.providers.x]\nprotocol = "systemone"\nendpoint = "http://example.com/v1/systemone"\nmodel = "m"\ncredential = "none"\ntimeout_ms = 10\n`,
        // surfaces must name a known profile
        `${header}[decisions.surfaces]\nevent_triage = "nonexistent"\n`,
        // surface names are machine identifiers
        `${header}[decisions.surfaces]\n"bad surface" = "local"\n`,
        // profile names are machine identifiers
        `${header}[decisions.providers."bad name"]\nprotocol = "systemone"\nendpoint = "${TYPESAFE_ENDPOINT}"\nmodel = "m"\ncredential = "typesafe"\ntimeout_ms = 10\n`,
      ]) {
        const instance = writeInstanceConfig(temp('gru-decisions-222-bad-'), body);
        expect(() => loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'))).toThrow();
      }
    });
  });

  describe('protocol behavior and credential binding', () => {
    it('systemone sends the same body with bearer auth and no OpenRouter attribution headers', async () => {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 }));
      const provider = new ProfileProvider({
        profile: systemoneProfile(),
        key: 'typesafe-test-key',
        credentialMode: 'resolved',
        fetchImpl: fetchImpl as typeof fetch,
      });
      await provider.request(eventDecisionRequest(EVENT));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(TYPESAFE_ENDPOINT);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer typesafe-test-key');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('http-referer')).toBeNull();
      expect(headers.get('x-title')).toBeNull();
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'jev-latest',
        questions: expect.objectContaining({ event_class: expect.anything() }),
      });
      provider.dispose();
    });

    it('a keyless loopback systemone profile sends no authorization header at all', async () => {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 }));
      const provider = new ProfileProvider({
        profile: systemoneProfile({ endpoint: 'http://127.0.0.1:8088/v1/systemone', credential: 'none' }),
        key: null,
        fetchImpl: fetchImpl as typeof fetch,
      });
      await provider.request(eventDecisionRequest(EVENT));
      const headers = new Headers(fetchImpl.mock.calls[0]![1]?.headers);
      expect(headers.get('authorization')).toBeNull();
      provider.dispose();
    });

    it('a slot key is never sent to another host: constructor refuses before any fetch', async () => {
      const fetchImpl = vi.fn();
      // openrouter key + systemone/typesafe endpoint
      expect(() => new ProfileProvider({
        profile: providerProfile({ endpoint: TYPESAFE_ENDPOINT }),
        key: 'secret-openrouter-key',
        credentialMode: 'resolved',
        fetchImpl: fetchImpl as typeof fetch,
      })).toThrow(/endpoint_untrusted/);
      // typesafe key + openrouter endpoint (slot stays typesafe)
      expect(() => new ProfileProvider({
        profile: systemoneProfile({ endpoint: OPENROUTER_ENDPOINT }),
        key: 'secret-typesafe-key',
        credentialMode: 'resolved',
        fetchImpl: fetchImpl as typeof fetch,
      })).toThrow(/endpoint_untrusted/);
      // keyless non-loopback
      expect(() => new ProfileProvider({
        profile: systemoneProfile({ credential: 'none' }),
        key: null,
        fetchImpl: fetchImpl as typeof fetch,
      })).toThrow(/endpoint_untrusted/);
      // keyless with a key is a programmer error
      expect(() => new ProfileProvider({
        profile: systemoneProfile({ endpoint: 'http://127.0.0.1:8088/v1/systemone', credential: 'none' }),
        key: 'should-not-exist',
        fetchImpl: fetchImpl as typeof fetch,
      })).toThrow(/credential_invalid/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('maps HTTP 422 to malformed_request — a caller-shape failure, not provider health', async () => {
      const service = new ProfileDecisionService(
        new ProfileProvider({
          profile: systemoneProfile(),
          key: 'typesafe-test-key',
          credentialMode: 'resolved',
          fetchImpl: (async () => new Response('bad request shape', { status: 422 })) as typeof fetch,
        }),
        cloneConfig(true).thresholds,
        'typesafe-direct',
      );
      const outcome = await service.decide(eventDecisionRequest(EVENT));
      expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'malformed_request', profile: null });
      service.dispose();
    });

    it('records honest costs: usage.cost wins, systemone computes from input_price_per_mtok, openrouter never invents', async () => {
      const makeService = (profile: DecisionProviderTable, usage: unknown): ProfileDecisionService =>
        new ProfileDecisionService(
          new ProfileProvider({
            profile,
            key: 'cost-test-key',
            fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) =>
              new Response(JSON.stringify({ ...answerEnvelope(String(init?.body)), usage }), { status: 200 })) as typeof fetch,
          }),
          cloneConfig(true).thresholds,
        );
      // TypeSafe reports token counts only: input cost computed from the price.
      const systemone = makeService(systemoneProfile({ inputPricePerMtok: 0.05 }), { input_tokens: 1000, output_tokens: 10 });
      expect((await systemone.decide(eventDecisionRequest(EVENT))).provenance.usage).toMatchObject({
        inputTokens: 1000,
        outputTokens: 10,
        costUsd: 1000 * 0.05 / 1_000_000,
      });
      systemone.dispose();
      // A reported cost always wins.
      const reported = makeService(systemoneProfile(), { input_tokens: 1000, output_tokens: 10, cost: 0.5 });
      expect((await reported.decide(eventDecisionRequest(EVENT))).provenance.usage?.costUsd).toBe(0.5);
      reported.dispose();
      // OpenRouter without usage.cost records null, never a fabricated price.
      const openrouter = makeService(providerProfile(), { input_tokens: 1000, output_tokens: 10 });
      expect((await openrouter.decide(eventDecisionRequest(EVENT))).provenance.usage?.costUsd).toBeNull();
      openrouter.dispose();
    });

    it('a resolved slot key survives a hostile redirect answer as endpoint_untrusted (redirect: manual)', async () => {
      const fetchImpl = vi.fn(async () => new Response('moved', {
        status: 302,
        headers: { location: 'https://evil.example/v1/systemone' },
      })) as unknown as typeof fetch;
      const service = new ProfileDecisionService(
        new ProfileProvider({
          profile: systemoneProfile(),
          key: 'typesafe-test-key',
          credentialMode: 'resolved',
          fetchImpl,
        }),
        cloneConfig(true).thresholds,
      );
      const outcome = await service.decide(eventDecisionRequest(EVENT));
      expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'endpoint_untrusted' });
      service.dispose();
    });
  });

  describe('runtime surface routing', () => {
    function fetchRecordingDouble(): { fetch: ReturnType<typeof vi.fn>; urls: string[] } {
      const urls: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
      });
      return { fetch, urls };
    }
    it('routes a configured surface to its profile and an omitted surface to the default, with provenance', async () => {
      const { fetch, urls } = fetchRecordingDouble();
      const config = {
        ...cloneConfig(true),
        surfaces: { event_triage: { provider: 'typesafe-direct' } },
      };
      const runtime = new DecisionRuntime(config, {
        instanceDir: temp('gru-decisions-222-route-'),
        env: { OPENROUTER_API_KEY: 'test-key', TYPESAFE_API_KEY: 'typesafe-test-key' },
        fetchImpl: fetch as typeof fetch,
        watchConfig: false,
      });
      expect(await runtime.start()).toMatchObject({ status: 'ready' }); // probe: default profile
      const triaged = await runtime.decide(eventDecisionRequest(EVENT), { surface: 'event_triage' });
      expect(triaged.provenance).toMatchObject({ source: 'jev', profile: 'typesafe-direct' });
      const defaulted = await runtime.decide(eventDecisionRequest(EVENT));
      expect(defaulted.provenance).toMatchObject({ source: 'jev', profile: 'openrouter-jev' });
      const unknown = await runtime.decide(eventDecisionRequest(EVENT), { surface: 'not_configured' });
      expect(unknown.provenance).toMatchObject({ source: 'jev', profile: 'openrouter-jev' });
      expect(urls[0]).toBe(OPENROUTER_ENDPOINT); // startup probe
      expect(urls[1]).toBe(TYPESAFE_ENDPOINT); // event_triage surface
      expect(urls[2]).toBe(OPENROUTER_ENDPOINT); // default surface
      runtime.dispose();
    });

    it('a non-default profile with a missing credential falls back per call and never invents an owner incident', async () => {
      const postIncident = vi.fn();
      const { fetch } = fetchRecordingDouble();
      const config = {
        ...cloneConfig(true),
        surfaces: { event_triage: { provider: 'typesafe-direct' } },
      };
      const runtime = new DecisionRuntime(config, {
        instanceDir: temp('gru-decisions-222-missing-key-'),
        env: { OPENROUTER_API_KEY: 'test-key' }, // no TYPESAFE_API_KEY
        fetchImpl: fetch as typeof fetch,
        watchConfig: false,
        notifications: { postIncident, post: vi.fn(), resolveIncidents: vi.fn(() => []) } as unknown as NotificationCenter,
      });
      // The runtime is READY: only the default profile is probed/required.
      expect(await runtime.start()).toMatchObject({ status: 'ready' });
      const outcome = await runtime.decide(eventDecisionRequest(EVENT), { surface: 'event_triage' });
      expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'credential_missing', profile: null });
      // Runtime health untouched; no owner-facing incident beyond ready.
      expect(runtime.status()).toMatchObject({ status: 'ready' });
      expect(postIncident).toHaveBeenCalledTimes(1);
      expect(postIncident.mock.calls[0]?.[0]).toMatchObject({ kind: 'decisions.ready' });
      // The default surface still routes to Jev.
      expect((await runtime.decide(eventDecisionRequest(EVENT))).provenance).toMatchObject({ source: 'jev', profile: 'openrouter-jev' });
      runtime.dispose();
    });

    it('hot reload swaps a surface profile without a restart and discards in-flight answers across the switch', async () => {
      let releaseLate: (() => void) | null = null;
      const urls: string[] = [];
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        if (urls.length === 3) {
          // Call 3 hangs until the test releases it — an in-flight answer
          // straddling the surface-profile switch.
          await new Promise<void>((resolve) => {
            releaseLate = () => resolve();
          });
        }
        return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
      });
      let current = {
        ...cloneConfig(true),
        surfaces: { event_triage: { provider: 'typesafe-direct' } },
      };
      const runtime = new DecisionRuntime(current, {
        instanceDir: temp('gru-decisions-222-hot-'),
        env: { OPENROUTER_API_KEY: 'test-key', TYPESAFE_API_KEY: 'typesafe-test-key' },
        fetchImpl: fetchImpl as typeof fetch,
        watchConfig: false,
        loadConfig: () => ({ decisions: current } as unknown as GruCommandConfig),
      });
      expect(await runtime.start()).toMatchObject({ status: 'ready' }); // probe 1 (openrouter)
      expect((await runtime.decide(eventDecisionRequest(EVENT), { surface: 'event_triage' })).provenance)
        .toMatchObject({ profile: 'typesafe-direct' }); // call 2 (typesafe)
      // An in-flight call on the surface, then the switch.
      const pending = runtime.decide(eventDecisionRequest(EVENT), { surface: 'event_triage' }); // call 3 (typesafe, hangs)
      await vi.waitFor(() => expect(releaseLate).not.toBeNull());
      current = {
        ...cloneConfig(true),
        surfaces: { event_triage: { provider: 'local' } },
      };
      expect(await runtime.recheck()).toMatchObject({ status: 'ready' }); // probe 4 (openrouter)
      releaseLate!();
      // The answer belongs to the disposed generation: discarded.
      expect((await pending).provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'stale_generation' });
      // The NEXT call on the same surface rides the new profile without a restart.
      expect((await runtime.decide(eventDecisionRequest(EVENT), { surface: 'event_triage' })).provenance)
        .toMatchObject({ source: 'jev', profile: 'local' });
      expect(urls).toEqual([
        OPENROUTER_ENDPOINT,
        TYPESAFE_ENDPOINT,
        TYPESAFE_ENDPOINT,
        OPENROUTER_ENDPOINT,
        'http://127.0.0.1:8088/v1/systemone',
      ]);
      runtime.dispose();
    });
  });

  describe('checkDecisionProfile (check --profile)', () => {
    const fetchRecordingDouble = (): { fetch: ReturnType<typeof vi.fn>; urls: string[] } => {
      const urls: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
      });
      return { fetch, urls };
    };

    it('probes a keyless loopback profile without touching any other profile', async () => {
      const { fetch } = fetchRecordingDouble();
      const config = cloneConfig(true);
      const result = await checkDecisionProfile(config, 'local', {
        instanceDir: temp('gru-decisions-222-check-'),
        env: {},
        fetchImpl: fetch as typeof fetch,
      });
      expect(result).toMatchObject({ profile: 'local', ok: true, status: 'ready', reason: null, model: 'typesafe/jev-test' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:8088/v1/systemone');
    });

    it('reports an honest degraded reason for a missing slot credential and throws for unknown profiles', async () => {
      const config = cloneConfig(true);
      const missing = await checkDecisionProfile(config, 'typesafe-direct', {
        instanceDir: temp('gru-decisions-222-check-missing-'),
        env: {},
        fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
      });
      expect(missing).toMatchObject({ profile: 'typesafe-direct', ok: false, status: 'degraded', reason: 'credential_missing' });
      expect(() => checkDecisionProfile(config, 'nonexistent', {
        instanceDir: temp('gru-decisions-222-check-unknown-'),
        env: {},
      })).rejects.toThrow(/unknown decision profile/);
      // Master switch off: every profile reports disabled.
      expect(await checkDecisionProfile(cloneConfig(false), 'local', {
        instanceDir: temp('gru-decisions-222-check-off-'),
        env: {},
      })).toMatchObject({ ok: true, status: 'disabled' });
    });
  });
});

// ------------------------------------------------------------------
// Issue #222 review fixes (blind-hunter / edge-case-hunter / verification-gap /
// acceptance-auditor findings)
// ------------------------------------------------------------------

describe('decision profile review fixes', () => {
  const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
  const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

  function systemoneProfile(overrides: Partial<DecisionProviderTable> = {}): DecisionProviderTable {
    return providerProfile({
      protocol: 'systemone',
      endpoint: TYPESAFE_ENDPOINT,
      model: 'jev-latest',
      credential: 'typesafe',
      ...overrides,
    });
  }

  function writeInstanceConfig(instance: string, body: string): string {
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'config.toml'), body);
    return instance;
  }

  it('binds a resolved slot to its request path, not just its origin', () => {
    const fetchImpl = vi.fn();
    // The single-provider path pin is restored: a resolved OpenRouter key
    // may never POST to another same-origin route.
    expect(() => new ProfileProvider({
      profile: providerProfile({ endpoint: 'https://openrouter.ai/api/v1/chat' }),
      key: 'secret-openrouter-key',
      credentialMode: 'resolved',
      fetchImpl: fetchImpl as typeof fetch,
    })).toThrow(/endpoint_untrusted/);
    // ...and a resolved TypeSafe key never reaches another api.typesafe.ai
    // path, including through an openrouter-decisions protocol miswiring.
    expect(() => new ProfileProvider({
      profile: providerProfile({ endpoint: 'https://api.typesafe.ai/api/other', credential: 'typesafe' }),
      key: 'secret-typesafe-key',
      credentialMode: 'resolved',
      fetchImpl: fetchImpl as typeof fetch,
    })).toThrow(/endpoint_untrusted/);
    // The pinned paths themselves still pass.
    expect(() => new ProfileProvider({
      profile: providerProfile(),
      key: 'secret-openrouter-key',
      credentialMode: 'resolved',
      fetchImpl: fetchImpl as typeof fetch,
    })).not.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    const instance = writeInstanceConfig(temp('gru-222-review-pathpin-'), [
      '[decisions.providers.x]',
      'protocol = "openrouter-decisions"',
      'endpoint = "https://openrouter.ai/wrong/path"',
      'model = "m"',
      'credential = "openrouter"',
      'timeout_ms = 10',
    ].join('\n'));
    expect(() => loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'))).toThrow(/binds to the \/api\/alpha\/decisions path/);
  });

  it('restricts keyless endpoints to http/https on loopback — exotic schemes fail at config time', () => {
    const instance = writeInstanceConfig(temp('gru-222-review-ftp-'), [
      '[decisions.providers.x]',
      'protocol = "systemone"',
      'endpoint = "ftp://localhost/v1/systemone"',
      'model = "m"',
      'credential = "none"',
      'timeout_ms = 10',
    ].join('\n'));
    expect(() => loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'))).toThrow(/http: or https:/);
    expect(() => new ProfileProvider({
      profile: systemoneProfile({ endpoint: 'ftp://127.0.0.1:9000/v1/systemone', credential: 'none' }),
      key: null,
    })).toThrow(/endpoint_untrusted/);
  });

  it('treats reserved object names as ordinary names: no prototype inheritance in profile maps', () => {
    const hostile = cloneConfig(true);
    const protoProfile = systemoneProfile({ model: 'injected' });
    Object.defineProperty(hostile.providers, '__proto__', {
      value: protoProfile,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const merged = effectiveDecisionProviders(hostile);
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(true);
    expect(merged['__proto__']).toMatchObject({ model: 'injected' });
    // A surface naming an inherited member is rejected loudly — by the name
    // pattern for mixed-case members, and by the own-property existence
    // check for any that slipped through (never silently accepted as a
    // valid profile route).
    const instance = writeInstanceConfig(temp('gru-222-review-proto-'), [
      '[decisions.surfaces]',
      'toString = "local"',
    ].join('\n'));
    expect(() => loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'))).toThrow(/surface name|unknown provider profile/);
  });

  it('defaults to resolved credential mode: an omitted mode can never free-route a slot key', () => {
    expect(() => new ProfileProvider({
      profile: systemoneProfile({ endpoint: 'https://evil.example/v1/systemone' }),
      key: 'secret-typesafe-key',
    })).toThrow(/endpoint_untrusted/);
  });

  it('records null, never a non-finite number, when token count and price overflow', async () => {
    const service = new ProfileDecisionService(
      new ProfileProvider({
        profile: systemoneProfile({ inputPricePerMtok: 1e308 }),
        key: 'typesafe-test-key',
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) =>
          new Response(JSON.stringify({
            ...answerEnvelope(String(init?.body)),
            usage: { input_tokens: 100, output_tokens: 1 },
          }), { status: 200 })) as typeof fetch,
      }),
      cloneConfig(true).thresholds,
    );
    const outcome = await service.decide(eventDecisionRequest(EVENT));
    expect(outcome.provenance.usage?.inputTokens).toBe(100);
    expect(outcome.provenance.usage?.costUsd).toBeNull();
    service.dispose();
  });

  it('a default-profile degrade keeps healthy non-default profiles serving their surfaces', async () => {
    const urls: string[] = [];
    let failDefault = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      if (failDefault && String(url) === OPENROUTER_ENDPOINT) {
        return new Response('provider down', { status: 503 });
      }
      return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
    });
    const config = {
      ...cloneConfig(true),
      surfaces: { event_triage: { provider: 'local' } },
    };
    const runtime = new DecisionRuntime(config, {
      instanceDir: temp('gru-222-review-degrade-'),
      env: { OPENROUTER_API_KEY: 'test-key' },
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready' });
    // The default profile degrades (a default-routed call fails), but the
    // routed keyless local profile keeps answering event_triage.
    failDefault = true;
    const degraded = await runtime.decide(eventDecisionRequest(EVENT));
    expect(degraded.provenance).toMatchObject({ source: 'deterministic', fallbackReason: 'provider_degraded' });
    expect(runtime.status()).toMatchObject({ status: 'degraded' });
    const outcome = await runtime.decide(eventDecisionRequest(EVENT), { surface: 'event_triage' });
    expect(outcome.provenance).toMatchObject({ source: 'jev', profile: 'local' });
    // Readiness is surface-aware: the routed surface is usable, the
    // degraded default is not.
    expect(runtime.readyFor('event_triage')).toBe(true);
    expect(runtime.readyFor(undefined)).toBe(false);
    runtime.dispose();
  });

  it('a keyless override of the default profile starts and serves without resolving a slot', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 }));
    const config = {
      ...cloneConfig(true),
      providers: {
        [DEFAULT_DECISION_PROFILE]: systemoneProfile({
          endpoint: 'http://127.0.0.1:9001/v1/systemone',
          credential: 'none',
        }),
      },
    };
    const runtime = new DecisionRuntime(config, {
      instanceDir: temp('gru-222-review-keyless-default-'),
      env: {}, // no slot keys at all
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready', credentialSource: 'none' });
    expect((await runtime.decide(eventDecisionRequest(EVENT))).provenance)
      .toMatchObject({ source: 'jev', profile: 'openrouter-jev' });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:9001/v1/systemone');
    runtime.dispose();
  });

  it('check --profile rejects an unknown profile even with the master switch off', async () => {
    const config = cloneConfig(false);
    await expect(checkDecisionProfile(config, 'nonexistent', {
      instanceDir: temp('gru-222-review-off-unknown-'),
      env: {},
    })).rejects.toThrow(/unknown decision profile/);
  });

  it('production callers pass their stable surface names to the decision service', async () => {
    const { NotificationCenter } = await import('../src/notifications/center.js');
    const { LedgerApi } = await import('../src/ledger/api.js');
    const { LedgerDb } = await import('../src/ledger/db.js');
    const { EventBus } = await import('../src/events/bus.js');
    const seen: (string | undefined)[] = [];
    const recordingService = {
      decide: vi.fn(async (_request: unknown, opts?: { readonly surface?: string }) => {
        seen.push(opts?.surface);
        return deterministicOutcome(
          eventDecisionRequest(EVENT),
          cloneConfig(true).thresholds,
          'disabled',
        );
      }),
    };
    const db = new LedgerDb(temp('gru-222-review-surface-'));
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    const center = new NotificationCenter({ ledger: api, bus });
    center.setDecisionService(recordingService as never, () => true);
    // A job going blocked derives a triage event through the real pipeline.
    api.addJob({ id: 'surface-canary', repo: 'demo', title: 'Surface canary' });
    api.setJobStatus('surface-canary', 'working');
    api.setJobStatus('surface-canary', 'blocked');
    await vi.waitFor(() => expect(recordingService.decide).toHaveBeenCalled());
    expect(seen[0]).toBe('event_triage');
  });
});

describe('decision profile review follow-ups (isolation, surfaces form, slots, refresh)', () => {
  const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

  it('child-process isolation removes every slot key from the inherited environment', () => {
    const ambient: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      OPENROUTER_API_KEY: 'private-openrouter-key',
      TYPESAFE_API_KEY: 'private-typesafe-key',
    };
    const isolated = isolateDecisionEnvironment(ambient);
    expect(isolated.OPENROUTER_API_KEY).toBe('private-openrouter-key');
    expect(isolated.TYPESAFE_API_KEY).toBe('private-typesafe-key');
    expect(ambient.OPENROUTER_API_KEY).toBeUndefined();
    expect(ambient.TYPESAFE_API_KEY).toBeUndefined();
    const child = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.env.OPENROUTER_API_KEY === undefined && process.env.TYPESAFE_API_KEY === undefined))'],
      { env: ambient, encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('true');
  });

  it("accepts the spec's explicit surfaces table form alongside the shorthand", () => {
    const instance = temp('gru-222-surfaces-table-');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'config.toml'), [
      '[decisions.jev]',
      'enabled = true',
      '[decisions.surfaces.event_triage]',
      'provider = "local"',
    ].join('\n'));
    const loaded = loadConfig({ GRU_COMMAND_HOME: instance }, temp('gru-decisions-home-'));
    expect(loaded.decisions.surfaces).toEqual({ event_triage: { provider: 'local' } });
    // Unknown keys inside the explicit form are rejected, and a missing
    // provider key is a config error, not a silent default.
    const bad = temp('gru-222-surfaces-table-bad-');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'config.toml'), [
      '[decisions.surfaces.event_triage]',
      'profile = "local"',
    ].join('\n'));
    expect(() => loadConfig({ GRU_COMMAND_HOME: bad }, temp('gru-decisions-home-'))).toThrow();
  });

  it("status top-level credential fields follow the DEFAULT profile's slot, not hardcoded OpenRouter", async () => {
    const { checkDecisionProfile } = await import('../src/decisions/runtime.js');
    void checkDecisionProfile;
    const config = {
      ...cloneConfig(true),
      providers: {
        [DEFAULT_DECISION_PROFILE]: {
          protocol: 'systemone',
          endpoint: TYPESAFE_ENDPOINT,
          model: 'jev-latest',
          credential: 'typesafe',
          timeoutMs: 2000,
          inputPricePerMtok: 0.042,
        },
      },
    };
    // The offline resolver reads the default profile's slot: with only a
    // TYPESAFE_API_KEY present, the default profile's credential is found.
    const resolved = resolveCredential(temp('gru-222-status-slot-'), { TYPESAFE_API_KEY: 'ts-key' }, 'typesafe');
    expect(resolved).toMatchObject({ state: 'present', source: 'environment', key: 'ts-key' });
    expect(config.providers[DEFAULT_DECISION_PROFILE]!.credential).toBe('typesafe');
  });

  it('a recheck adopts a freshly stored slot credential for a routed profile', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      return new Response(JSON.stringify(answerEnvelope(String(init?.body))), { status: 200 });
    });
    const current = {
      ...cloneConfig(true),
      surfaces: { event_triage: { provider: 'typesafe-direct' } },
    };
    const instance = temp('gru-222-recheck-slot-');
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'test-key' }; // no TYPESAFE_API_KEY yet
    const runtime = new DecisionRuntime(current, {
      instanceDir: instance,
      env,
      fetchImpl: fetchImpl as typeof fetch,
      watchConfig: false,
      loadConfig: () => ({ decisions: current } as unknown as GruCommandConfig),
    });
    expect(await runtime.start()).toMatchObject({ status: 'ready' });
    // No key yet: the surface falls back per call, health untouched.
    expect((await runtime.decide(eventDecisionRequest(EVENT), { surface: 'event_triage' })).provenance)
      .toMatchObject({ source: 'deterministic', fallbackReason: 'credential_missing' });
    // The operator stores the TypeSafe key, then rechecks (the documented
    // workflow — the same one the default profile has always used).
    env['TYPESAFE_API_KEY'] = 'fresh-typesafe-key';
    expect(await runtime.recheck()).toMatchObject({ status: 'ready' });
    expect((await runtime.decide(eventDecisionRequest(EVENT), { surface: 'event_triage' })).provenance)
      .toMatchObject({ source: 'jev', profile: 'typesafe-direct' });
    runtime.dispose();
  });
});

describe('systemone failure-path mapping (review: both protocols covered)', () => {
  const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

  async function expectSystemoneFallback(
    status: number,
    reason: string,
    mode: 'reject' | 'hang' = 'reject',
  ): Promise<void> {
    const service = new ProfileDecisionService(
      new ProfileProvider({
        profile: {
          protocol: 'systemone',
          endpoint: TYPESAFE_ENDPOINT,
          model: 'jev-latest',
          credential: 'typesafe',
          timeoutMs: 20,
          inputPricePerMtok: 0.042,
        },
        key: 'typesafe-test-key',
        fetchImpl: mode === 'hang'
          ? ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
            })) as typeof fetch
          : (async () => new Response('provider refusal body', { status })) as typeof fetch,
      }),
      cloneConfig(true).thresholds,
      'typesafe-direct',
    );
    const outcome = await service.decide(eventDecisionRequest(EVENT));
    expect(outcome.provenance).toMatchObject({ source: 'deterministic', fallbackReason: reason });
    expect(JSON.stringify(outcome)).not.toContain('provider refusal body');
    service.dispose();
  }

  it('maps 401 → auth_rejected on the systemone protocol', async () => {
    await expectSystemoneFallback(401, 'auth_rejected');
  });
  it('maps 403 → forbidden on the systemone protocol', async () => {
    await expectSystemoneFallback(403, 'forbidden');
  });
  it('maps 429 → provider_degraded on the systemone protocol', async () => {
    await expectSystemoneFallback(429, 'provider_degraded');
  });
  it('maps 5xx → provider_degraded on the systemone protocol', async () => {
    await expectSystemoneFallback(503, 'provider_degraded');
  });
  it('maps timeouts on the systemone protocol', async () => {
    await expectSystemoneFallback(0, 'timeout', 'hang');
  });
});

// ------------------------------------------------------------------
// Issue #224: the three shadow surfaces — question sets, builders,
// and exact parity with the labelled-history measurement contract.
// ------------------------------------------------------------------

describe('issue #224 shadow surfaces — question sets, builders, backtest parity', () => {
  const esc = (over: Partial<EscalationFacts> = {}): EscalationFacts => ({
    kind: 'silas.escalated:job-1',
    title: 'typecheck blocked',
    detail: 'ONE scheduled typecheck RAN (run 567a1364)',
    ...over,
  });

  it('pins the escalation-triage vocabulary: options, risks and the fail-toward-a-wake fallback', () => {
    expect(ESCALATION_TRIAGE_QUESTIONS.triage.options).toEqual([
      'needs_ruling',
      'needs_owner',
      'status_report',
      'covered_by_open_item',
    ]);
    const request = escalationTriageDecisionRequest({ escalations: [esc()], mode: 'action-required' });
    expect(request.risks).toEqual({ triage: 'operational', needs_decision: 'read_only' });
    expect(request.fallback.triage).toMatchObject({ type: 'choice', choice: 'needs_ruling', confidence: 1 });
    expect(request.fallback.needs_decision).toEqual({ type: 'noul', noul: 1 });
  });

  it('builds the escalation state in the labelled extractor\'s shape and omits empty memory keys', () => {
    const request = escalationTriageDecisionRequest({ escalations: [esc()], mode: 'action-required' });
    expect(request.state).toBe(filteredState({
      wake: { notification_count: 1, mode: 'action-required' },
      escalations: [esc()],
    }));
    const withMemory = escalationTriageDecisionRequest({
      escalations: [esc()],
      mode: 'action-required',
      openDecisions: [{ decision: 'hold', reason: 'waiting on upstream', by: 'owner', covers: 'typecheck', basis_fingerprint: 'sha-1', recheck_at: '2026-10-08T00:00:00.000Z' }],
      recentDispositions: [{ decision: 'acted', reason: 'directive sent', by: 'silas', covers: '', basis_fingerprint: null, recheck_at: null }],
    });
    expect(withMemory.state).toContain('open_decisions');
    expect(withMemory.state).toContain('recent_dispositions');
    expect(withMemory.state).toContain('waiting on upstream');
  });

  it('redacts secrets inside escalation facts before they reach the state', () => {
    const request = escalationTriageDecisionRequest({
      escalations: [esc({ detail: 'leaked OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop in logs' })],
      mode: null,
    });
    expect(request.state).not.toContain('sk-or-v1-abcdefghijklmnop');
    expect(request.state).toContain('[redacted]');
  });

  it('pins the same-blocker vocabulary and pair-state parity with the extractor', () => {
    const request = sameBlockerDecisionRequest(
      { category: 'correctness', location: 'src/a.ts:10', title: 'null deref' },
      { category: 'correctness', location: 'src/a.ts:42', title: 'null deref on empty path', detail: 'crash in parse' },
    );
    expect(request.risks).toEqual({ same_defect: 'operational' });
    expect(request.fallback.same_defect).toEqual({ type: 'noul', noul: 0 });
    // Exact shape the labelled extractor measures (severity/detail appear
    // only when the caller carries them).
    expect(request.state).toBe(filteredState({
      prior_finding: { title: 'null deref', category: 'correctness', location: 'src/a.ts:10' },
      current_finding: { title: 'null deref on empty path', category: 'correctness', location: 'src/a.ts:42', detail: 'crash in parse' },
    }));
  });

  it('fileOfLocation strips line/column suffixes', () => {
    expect(fileOfLocation('src/a.ts')).toBe('src/a.ts');
    expect(fileOfLocation(' src/a.ts:12 ')).toBe('src/a.ts');
    expect(fileOfLocation('src/a.ts:12:34')).toBe('src/a.ts');
  });

  it('pins the report-conclusion vocabulary: never a silent clean pass', () => {
    const request = reportConclusionDecisionRequest('## Summary\nall good\n\n**Verdict: READY TO MERGE**');
    expect(request.risks).toEqual({ conclusion: 'operational' });
    expect(request.fallback.conclusion).toMatchObject({ type: 'choice', choice: 'findings_need_action', confidence: 1 });
    // The verdict line is the LABEL: it never rides in the request state.
    expect(request.state).toBe(filteredState({ report: '## Summary\nall good' }));
  });

  it('strips verdict lines in every canonical spelling but keeps everything else', () => {
    const state = reportConclusionState('verdict: needs changes\nbody line\nVerdict: MAJOR REWORK NEEDED\nmore body');
    expect(state).toBe(filteredState({ report: 'body line\nmore body' }));
  });

  it('the backtest registry measures exactly the production question sets and baselines', () => {
    expect(surfaceCaseSpec('escalation_triage').questions).toBe(ESCALATION_TRIAGE_QUESTIONS);
    expect(surfaceCaseSpec('same_blocker').questions).toBe(SAME_BLOCKER_QUESTIONS);
    expect(surfaceCaseSpec('report_conclusion').questions).toBe(REPORT_CONCLUSION_QUESTIONS);
    // Baseline parity: the specs' deterministic fallbacks are the same
    // constants the production builders pin.
    expect(surfaceCaseSpec('escalation_triage').fallback)
      .toEqual(escalationTriageDecisionRequest({ escalations: [esc()], mode: null }).fallback);
    expect(surfaceCaseSpec('same_blocker').fallback)
      .toEqual(sameBlockerDecisionRequest(
        { category: 'c', location: 'a.ts', title: 't' },
        { category: 'c', location: 'a.ts', title: 'u' },
      ).fallback);
    expect(surfaceCaseSpec('report_conclusion').fallback)
      .toEqual(reportConclusionDecisionRequest('body').fallback);
  });
});

describe('issue #224 review fixes — normalization, summarisation', () => {
  it('fileOfLocation mirrors #216 location identity plus one column strip', () => {
    expect(fileOfLocation('src/a.ts')).toBe('src/a.ts');
    expect(fileOfLocation(' src/A.ts:12 ')).toBe('src/a.ts');
    expect(fileOfLocation('src/a.ts:12:34')).toBe('src/a.ts');
    expect(fileOfLocation('src/a.ts#L42')).toBe('src/a.ts');
    expect(fileOfLocation('src/a.ts#L42-L48')).toBe('src/a.ts');
    expect(fileOfLocation('src/a.ts:42-58')).toBe('src/a.ts');
    expect(fileOfLocation('src\\win\\path.ts:7')).toBe('src/win/path.ts');
  });

  it('summariseReportBody passes short bodies through and summarises long ones', () => {
    const short = '## Summary\nall good';
    expect(summariseReportBody(short)).toBe(short);
    const filler = Array.from({ length: 200 }, (_, index) => `prose line ${index} with some length to it`).join('\n');
    const long = `## Summary\nthe head matters\n\n${filler}\n\n- finding one: real\n- finding two: also real`;
    const summarised = summariseReportBody(long, 1_000);
    expect(summarised.length).toBeLessThanOrEqual(1_000);
    expect(summarised).toContain('the head matters');
    expect(summarised).toContain('- finding one: real');
    expect(summarised).toContain('- finding two: also real');
    expect(summarised).not.toContain('prose line 150');
  });

  it('reportConclusionState summarises instead of tail-truncating', () => {
    const filler = Array.from({ length: 300 }, (_, index) => `prose ${index}`).join('\n');
    const report = `## Summary\nhead section\n\n${filler}\n\n- the real finding\n\n**Verdict: NEEDS CHANGES**`;
    const state = reportConclusionState(report);
    expect(state).toContain('head section');
    // The finding title survives — summarised, never tail-truncated.
    expect(state).toContain('the real finding');
    expect(state).not.toContain('Verdict');
  });
});
