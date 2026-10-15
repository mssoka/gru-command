import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DECISIONS_CONFIG, type DecisionsConfig } from '../src/config.js';
import { ProfileDecisionService, ProfileProvider } from '../src/decisions/provider.js';
import { DecisionRuntime } from '../src/decisions/runtime.js';
import * as decisionSemantics from '../src/decisions/service.js';
import type { DecisionRequest, ShadowDecisionRecord } from '../src/decisions/types.js';

const questions = { needed: { type: 'noul', instructions: 'Does this need attention?' } } as const;
const request: DecisionRequest<typeof questions> = {
  state: 'STATE-CANARY-private-content', questions,
  risks: { needed: 'operational' }, fallback: { needed: { type: 'noul', noul: 0 } },
};
const envelope = { model: 'jev-test', answers: { needed: { type: 'noul', noul: 0.9 } } };
const cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  // The provider uses perf_hooks' monotonic clock, not the fake global object.
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function response(): Response { return new Response(JSON.stringify(envelope)); }
function provider(fetchImpl: typeof fetch): ProfileProvider {
  const result = new ProfileProvider({
    profile: {
      protocol: 'openrouter-decisions', endpoint: DEFAULT_DECISIONS_CONFIG.jev.endpoint,
      model: '~typesafe/jev-latest', credential: 'openrouter', timeoutMs: 20, inputPricePerMtok: 0.042,
    }, key: 'KEY-CANARY-private', fetchImpl,
  });
  cleanups.push(() => result.dispose());
  return result;
}
function service(fetchImpl: typeof fetch): ProfileDecisionService {
  return new ProfileDecisionService(provider(fetchImpl), DEFAULT_DECISIONS_CONFIG.thresholds);
}
function capture(promise: Promise<unknown>): unknown[] {
  const results: unknown[] = [];
  void promise.then((value) => results.push(value), (error: unknown) => results.push(error));
  return results;
}
function config(): DecisionsConfig {
  return {
    ...DEFAULT_DECISIONS_CONFIG,
    jev: { ...DEFAULT_DECISIONS_CONFIG.jev, enabled: true, timeoutMs: 20 },
    surfaces: { event_triage: { provider: 'openrouter-jev', mode: 'shadow' } },
  };
}
function probeResponse(body: string): Response {
  const parsed = JSON.parse(body) as { questions: Record<string, { type: string; options?: string[] }> };
  const answers = Object.fromEntries(Object.entries(parsed.questions).map(([id, question]) => [id,
    question.type === 'noul' ? { type: 'noul', noul: 0.9 } : {
      type: 'choice', choice: question.options![0], confidence: 1,
      probabilities: Object.fromEntries(question.options!.map((option, i) => [option, i === 0 ? 1 : 0])),
    },
  ]));
  return new Response(JSON.stringify({ model: 'jev-test', answers }));
}
async function runtime(fetchImpl: typeof fetch, records: ShadowDecisionRecord[], log = vi.fn(), configuration = config()): Promise<DecisionRuntime> {
  const result = new DecisionRuntime(configuration, {
    instanceDir: '/unused-decision-test-instance', env: { OPENROUTER_API_KEY: 'KEY-CANARY-private' },
    watchConfig: false, fetchImpl, log, onShadowRecord: (record) => records.push(record),
  });
  cleanups.push(() => result.dispose());
  expect(await result.start()).toMatchObject({ status: 'ready' });
  return result;
}

describe('decision request deadlines and evidence', () => {
  it('settles at the deadline even when fetch ignores abort', async () => {
    const signals: AbortSignal[] = [];
    const client = service((_url, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>(() => {});
    });
    const results = capture(client.decide(request));
    await vi.advanceTimersByTimeAsync(20);
    expect(signals[0]!.aborted).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provenance: {
      source: 'deterministic', fallbackReason: 'timeout', latencyMs: 20,
      diagnostics: { phase: 'request', timeoutMs: 20, deadlineExpired: true, headersMs: null, bodyMs: null, httpStatus: null },
    } });
  });

  it('settles and cancels a stalled body even when the stream ignores the fetch signal', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const client = service(async () => new Response(new ReadableStream<Uint8Array>({ cancel })));
    const results = capture(client.decide(request));
    await vi.advanceTimersByTimeAsync(20);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provenance: {
      fallbackReason: 'timeout', latencyMs: 20,
      diagnostics: { phase: 'response_body', headersMs: 0, bodyMs: null, httpStatus: 200, deadlineExpired: true },
    } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('never waits indefinitely for a rejected HTTP response to cancel', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const client = service(async () => new Response(new ReadableStream({ cancel }), { status: 401 }));
    const results = capture(client.decide(request));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provenance: {
      fallbackReason: 'auth_rejected', diagnostics: { httpStatus: 401, deadlineExpired: false },
    } });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('frees all four admission slots after uncooperative calls expire', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const client = provider(fetchImpl);
    const pending = Array.from({ length: 4 }, () => capture(client.request(request)));
    await expect(client.request(request)).rejects.toMatchObject({ reason: 'capacity_limited' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(20);
    for (const results of pending) {
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ reason: 'timeout' });
    }
    fetchImpl.mockImplementation(async () => response());
    await expect(client.request(request)).resolves.toMatchObject({ model: 'jev-test' });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('disposal promptly settles a fetch ignoring abort as disposed, not timeout', async () => {
    const client = provider(() => new Promise<Response>(() => {}));
    const results = capture(client.request(request));
    await vi.advanceTimersByTimeAsync(3);
    client.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ reason: 'disposed' });
    await expect(client.request(request)).rejects.toMatchObject({ reason: 'disposed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cooperative transport disposal is not misclassified as a timeout', async () => {
    const client = service((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const results = capture(client.decide(request));
    await vi.advanceTimersByTimeAsync(3);
    client.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(results[0]).toMatchObject({ provenance: {
      fallbackReason: 'disposed', latencyMs: 3, diagnostics: { deadlineExpired: false },
    } });
  });

  it('cancels a response arriving after timeout without consuming or routing it', async () => {
    let deliver!: (response: Response) => void;
    const client = service(() => new Promise<Response>((resolve) => { deliver = resolve; }));
    const results = capture(client.decide(request));
    await vi.advanceTimersByTimeAsync(20);
    expect(results).toHaveLength(1);
    const cancel = vi.fn();
    deliver(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provenance: { fallbackReason: 'timeout' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes a transport rejection that arrives after the deadline', async () => {
    let rejectLater!: (error: Error) => void;
    const client = service(() => new Promise<Response>((_resolve, reject) => { rejectLater = reject; }));
    const results = capture(client.decide(request));
    await vi.advanceTimersByTimeAsync(20);
    expect(results).toHaveLength(1);
    rejectLater(new Error('RAW-ERROR-CANARY-private'));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1); // Vitest also fails on any unhandled late rejection.
    expect(JSON.stringify(results)).not.toContain('RAW-ERROR-CANARY');
  });

  it('reports successful header/body milestones and clears deadline timers', async () => {
    let deliver!: (response: Response) => void;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const client = service(() => new Promise<Response>((resolve) => { deliver = resolve; }));
    const pending = client.decide(request);
    await vi.advanceTimersByTimeAsync(5);
    deliver(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })));
    await vi.advanceTimersByTimeAsync(7);
    stream.enqueue(new TextEncoder().encode(JSON.stringify(envelope)));
    stream.close();
    await expect(pending).resolves.toMatchObject({ provenance: {
      source: 'jev', latencyMs: 12,
      diagnostics: { phase: 'response_validation', headersMs: 5, bodyMs: 12, httpStatus: 200, deadlineExpired: false },
    } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains elapsed time and safe phase information for a network rejection', async () => {
    let fail!: (error: Error) => void;
    const client = service(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
    const pending = client.decide(request);
    await vi.advanceTimersByTimeAsync(6);
    fail(new Error('RAW-ERROR-CANARY-secret'));
    const outcome = await pending;
    expect(outcome.provenance).toMatchObject({
      fallbackReason: 'network_error', latencyMs: 6,
      diagnostics: { phase: 'request', headersMs: null, httpStatus: null, deadlineExpired: false },
    });
    expect(JSON.stringify(outcome.provenance)).not.toContain('CANARY');
  });

  it('identifies response validation failures separately from transport waits', async () => {
    const client = service(async () => new Response('{'));
    await expect(client.decide(request)).resolves.toMatchObject({ provenance: {
      fallbackReason: 'malformed_response',
      diagnostics: { phase: 'response_validation', headersMs: 0, bodyMs: 0, httpStatus: 200, deadlineExpired: false },
    } });
  });

  it('rejects a late success even if a blocked loop has not run the timer callback yet', async () => {
    const origin = performance.now();
    const client = service(async () => {
      vi.spyOn(performance, 'now').mockReturnValue(origin + 25);
      return response();
    });
    await expect(client.decide(request)).resolves.toMatchObject({ provenance: {
      source: 'deterministic', fallbackReason: 'timeout', latencyMs: 25,
      diagnostics: { deadlineExpired: true },
    } });
  });

  it('records exact timeout evidence in shadow while still serving the deterministic baseline', async () => {
    const records: ShadowDecisionRecord[] = [];
    const log = vi.fn();
    let call = 0;
    const client = await runtime((_url, init) => {
      if (++call === 1) return Promise.resolve(probeResponse(String(init!.body)));
      return new Promise<Response>(() => {});
    }, records, log);
    const results = capture(client.decide(request, { surface: 'event_triage' }));
    await vi.advanceTimersByTimeAsync(20);
    expect(results[0]).toMatchObject({ provenance: { fallbackReason: 'shadow_mode' } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      fallback_reason: 'timeout', latency_ms: 20, provenance_source: 'deterministic',
      request_diagnostics: { phase: 'request', timeoutMs: 20, deadlineExpired: true },
    });
    expect(client.status()).toMatchObject({ status: 'ready' });
    expect(log).toHaveBeenCalledWith('warn', 'decision provider request fell back', expect.objectContaining({
      reason: 'timeout', latency_ms: 20, profile: 'openrouter-jev', surface: 'event_triage',
    }));
    expect(JSON.stringify([records, log.mock.calls])).not.toContain('CANARY');
  });

  it('records and logs capacity refusals without treating them as remote outages', async () => {
    const records: ShadowDecisionRecord[] = [];
    const log = vi.fn();
    const pending: ((response: Response) => void)[] = [];
    let call = 0;
    const client = await runtime((_url, init) => {
      if (++call === 1) return Promise.resolve(probeResponse(String(init!.body)));
      return new Promise<Response>((resolve) => pending.push(resolve));
    }, records, log);
    const firstFour = Array.from({ length: 4 }, () => client.decide(request, { surface: 'event_triage' }));
    await client.decide(request, { surface: 'event_triage' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      fallback_reason: 'capacity_limited', latency_ms: 0,
      request_diagnostics: { phase: 'not_started', deadlineExpired: false },
    });
    expect(log).toHaveBeenCalledWith('warn', 'decision provider request fell back', expect.objectContaining({ reason: 'capacity_limited' }));
    expect(client.status()).toMatchObject({ status: 'ready' });
    for (const resolve of pending) resolve(response());
    await Promise.all(firstFour);
    expect(records).toHaveLength(5);
    expect(records.slice(1)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ fallback_reason: null })));
  });

  it('distinguishes a no-provider fallback from a request that actually expired', async () => {
    const records: ShadowDecisionRecord[] = [];
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new DecisionRuntime(config(), {
      instanceDir: '/unused-decision-test-instance', env: {}, watchConfig: false,
      fetchImpl, onShadowRecord: (record) => records.push(record),
    });
    cleanups.push(() => client.dispose());
    expect(await client.start()).toMatchObject({ status: 'degraded', reason: 'credential_missing' });
    await client.decide(request, { surface: 'event_triage' });
    expect(records[0]).toMatchObject({ fallback_reason: 'credential_missing', request_diagnostics: null, latency_ms: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runtime disposal never emits an expired-request record or accepts a late answer', async () => {
    const records: ShadowDecisionRecord[] = [];
    let deliver!: (response: Response) => void;
    let call = 0;
    const client = await runtime((_url, init) => {
      if (++call === 1) return Promise.resolve(probeResponse(String(init!.body)));
      return new Promise<Response>((resolve) => { deliver = resolve; });
    }, records);
    const results = capture(client.decide(request, { surface: 'event_triage' }));
    client.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ provenance: { fallbackReason: 'stale_generation' } });
    expect(records).toHaveLength(0);
    deliver(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(records).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies an expired fetch rejection before the timer callback as timeout', async () => {
    const origin = performance.now();
    const client = service(async () => {
      vi.spyOn(performance, 'now').mockReturnValue(origin + 25);
      throw new Error('RAW-ERROR-CANARY-late-network-failure');
    });
    await expect(client.decide(request)).resolves.toMatchObject({ provenance: {
      fallbackReason: 'timeout', latencyMs: 25,
      diagnostics: { phase: 'request', deadlineExpired: true, headersMs: null },
    } });
  });

  it('classifies synchronous validation crossing the deadline before the timer as timeout', async () => {
    const origin = performance.now();
    vi.spyOn(decisionSemantics, 'validatedAnswers').mockImplementation(() => {
      vi.spyOn(performance, 'now').mockReturnValue(origin + 25);
      throw new Error('RAW-ERROR-CANARY-late-validation-failure');
    });
    const client = service(async () => response());
    await expect(client.decide(request)).resolves.toMatchObject({ provenance: {
      fallbackReason: 'timeout', latencyMs: 25,
      diagnostics: { phase: 'response_validation', deadlineExpired: true, headersMs: 0, bodyMs: 0 },
    } });
  });

  it('identifies HTTP status rejections as headers, not a body read', async () => {
    for (const status of [301, 401, 403, 422, 500]) {
      const client = service(async () => new Response('RAW-BODY-CANARY-private', { status }));
      const outcome = await client.decide(request);
      expect(outcome.provenance).toMatchObject({ diagnostics: {
        phase: 'response_headers', httpStatus: status, headersMs: 0, bodyMs: null, deadlineExpired: false,
      } });
      expect(JSON.stringify(outcome)).not.toContain('RAW-BODY-CANARY');
    }
  });

  it('a throwing logger cannot prevent a capacity record or deterministic shadow routing', async () => {
    const records: ShadowDecisionRecord[] = [];
    const log = vi.fn();
    const pending: ((response: Response) => void)[] = [];
    let call = 0;
    const client = await runtime((_url, init) => {
      if (++call === 1) return Promise.resolve(probeResponse(String(init!.body)));
      return new Promise<Response>((resolve) => pending.push(resolve));
    }, records, log);
    const firstFour = Array.from({ length: 4 }, () => client.decide(request, { surface: 'event_triage' }));
    log.mockImplementation(() => { throw new Error('logging unavailable'); });
    await expect(client.decide(request, { surface: 'event_triage' })).resolves.toMatchObject({
      provenance: { fallbackReason: 'shadow_mode' },
    });
    expect(records[0]).toMatchObject({ fallback_reason: 'capacity_limited' });
    expect(client.status()).toMatchObject({ status: 'ready' });
    for (const resolve of pending) resolve(response());
    await Promise.all(firstFour);
  });

  it('non-shadow request warnings retain the attempted timeout timing and diagnostics', async () => {
    const records: ShadowDecisionRecord[] = [];
    const log = vi.fn();
    let call = 0;
    const legacy = { ...config(), surfaces: { event_triage: { provider: 'openrouter-jev' } } };
    const client = await runtime((_url, init) => {
      if (++call === 1) return Promise.resolve(probeResponse(String(init!.body)));
      return new Promise<Response>(() => {});
    }, records, log, legacy);
    const results = capture(client.decide(request, { surface: 'event_triage' }));
    await vi.advanceTimersByTimeAsync(20);
    expect(results[0]).toMatchObject({ provenance: {
      fallbackReason: 'timeout', latencyMs: 20, diagnostics: { phase: 'request', deadlineExpired: true },
    } });
    expect(log).toHaveBeenCalledWith('warn', 'decision provider request fell back', expect.objectContaining({
      reason: 'timeout', latency_ms: 20, surface: 'event_triage', profile: 'openrouter-jev',
      request_diagnostics: expect.objectContaining({ phase: 'request', deadlineExpired: true }),
    }));
    expect(records).toHaveLength(0);
  });

  it('non-shadow capacity warnings do not degrade remote-provider health', async () => {
    const log = vi.fn();
    const pending: ((response: Response) => void)[] = [];
    let call = 0;
    const legacy = { ...config(), surfaces: { event_triage: { provider: 'openrouter-jev' } } };
    const client = await runtime((_url, init) => {
      if (++call === 1) return Promise.resolve(probeResponse(String(init!.body)));
      return new Promise<Response>((resolve) => pending.push(resolve));
    }, [], log, legacy);
    const firstFour = Array.from({ length: 4 }, () => client.decide(request, { surface: 'event_triage' }));
    await expect(client.decide(request, { surface: 'event_triage' })).resolves.toMatchObject({
      provenance: { fallbackReason: 'capacity_limited', diagnostics: { phase: 'not_started' } },
    });
    expect(log).toHaveBeenCalledWith('warn', 'decision provider request fell back', expect.objectContaining({
      reason: 'capacity_limited', latency_ms: 0, surface: 'event_triage',
    }));
    expect(client.status()).toMatchObject({ status: 'ready' });
    for (const resolve of pending) resolve(response());
    await Promise.all(firstFour);
  });

  it('failed startup probes log their bounded request evidence', async () => {
    const log = vi.fn();
    const client = new DecisionRuntime(config(), {
      instanceDir: '/unused-decision-test-instance', env: { OPENROUTER_API_KEY: 'KEY-CANARY-private' },
      watchConfig: false, fetchImpl: () => new Promise<Response>(() => {}), log,
    });
    cleanups.push(() => client.dispose());
    const results = capture(client.start());
    await vi.advanceTimersByTimeAsync(20);
    expect(results[0]).toMatchObject({ status: 'degraded', reason: 'timeout' });
    expect(log).toHaveBeenCalledWith('warn', 'decision provider request fell back', expect.objectContaining({
      reason: 'timeout', latency_ms: 20, profile: 'openrouter-jev', surface: null,
      request_diagnostics: expect.objectContaining({ phase: 'request', deadlineExpired: true }),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('CANARY');
  });

  it('records exact successful shadow header and body milestones', async () => {
    const records: ShadowDecisionRecord[] = [];
    let deliver!: (response: Response) => void;
    let call = 0;
    const client = await runtime((_url, init) => {
      if (++call === 1) return Promise.resolve(probeResponse(String(init!.body)));
      return new Promise<Response>((resolve) => { deliver = resolve; });
    }, records);
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const deciding = client.decide(request, { surface: 'event_triage' });
    await vi.advanceTimersByTimeAsync(5);
    deliver(new Response(body, { status: 200 }));
    await vi.advanceTimersByTimeAsync(7);
    stream.enqueue(new TextEncoder().encode(await response().text()));
    stream.close();
    await deciding;
    expect(records[0]).toMatchObject({
      provenance_source: 'jev', fallback_reason: null, latency_ms: 12,
      request_diagnostics: {
        phase: 'response_validation', headersMs: 5, bodyMs: 12, httpStatus: 200, deadlineExpired: false,
      },
    });
    expect(JSON.stringify(records)).not.toContain('CANARY');
  });

  it('logs real non-default failures without degrading the ready default', async () => {
    const log = vi.fn();
    let reject!: (error: Error) => void;
    const configuration = { ...config(), surfaces: { event_triage: { provider: 'local' } } };
    const client = await runtime((url, init) => {
      if (String(url).startsWith('http://127.0.0.1')) {
        return new Promise<Response>((_resolve, fail) => { reject = fail; });
      }
      return Promise.resolve(probeResponse(String(init!.body)));
    }, [], log, configuration);
    const deciding = client.decide(request, { surface: 'event_triage' });
    await vi.advanceTimersByTimeAsync(6);
    reject(new Error('RAW-ERROR-CANARY-local-network'));
    await expect(deciding).resolves.toMatchObject({ provenance: {
      fallbackReason: 'network_error', latencyMs: 6, diagnostics: { phase: 'request', deadlineExpired: false },
    } });
    expect(log).toHaveBeenCalledWith('warn', 'decision provider request fell back', expect.objectContaining({
      reason: 'network_error', latency_ms: 6, profile: 'local', surface: 'event_triage',
      request_diagnostics: expect.objectContaining({ phase: 'request', deadlineExpired: false }),
    }));
    expect(client.status()).toMatchObject({ status: 'ready' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('CANARY');
  });

  it('successful startup logs retain exact probe milestones and no secrets', async () => {
    const log = vi.fn();
    let deliver!: (response: Response) => void;
    let probeRequest = '';
    const starting = runtime((_url, init) => {
      probeRequest = String(init!.body);
      return new Promise<Response>((resolve) => { deliver = resolve; });
    }, [], log);
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    await vi.advanceTimersByTimeAsync(5);
    deliver(new Response(body, { status: 200 }));
    await vi.advanceTimersByTimeAsync(7);
    stream.enqueue(new TextEncoder().encode(await probeResponse(probeRequest).text()));
    stream.close();
    await starting;
    expect(log).toHaveBeenCalledWith('info', 'Jev decision service ready', expect.objectContaining({
      latency_ms: 12, model: 'jev-test',
      request_diagnostics: {
        phase: 'response_validation', timeoutMs: 20, deadlineExpired: false,
        headersMs: 5, bodyMs: 12, httpStatus: 200,
      },
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('CANARY');
  });

  it('declared-size refusals cancel unread bodies without waiting or retaining admission', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const readers: ReturnType<typeof vi.spyOn>[] = [];
    let call = 0;
    const client = service(async () => {
      if (++call > 4) return response();
      const body = new ReadableStream<Uint8Array>({ cancel });
      readers.push(vi.spyOn(body, 'getReader'));
      return new Response(body, { status: 200, headers: { 'content-length': '2000000' } });
    });
    const results = capture(Promise.all(Array.from({ length: 4 }, () => client.decide(request))));
    await vi.advanceTimersByTimeAsync(0);
    expect(results[0]).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ provenance: expect.objectContaining({
      fallbackReason: 'malformed_response', latencyMs: 0,
      diagnostics: expect.objectContaining({ phase: 'response_headers', deadlineExpired: false, bodyMs: null }),
    }) })));
    expect(cancel).toHaveBeenCalledTimes(4);
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
    await expect(client.decide(request)).resolves.toMatchObject({ provenance: { source: 'jev' } });
    expect(call).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('streaming overflow cancels best-effort and releases admission before the deadline', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let call = 0;
    const client = service(async () => {
      if (++call > 4) return response();
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel,
      });
      return new Response(body, { status: 200 }); // no oversized header: must hit streaming limit
    });
    const results = capture(Promise.all(Array.from({ length: 4 }, () => client.decide(request))));
    await vi.advanceTimersByTimeAsync(0);
    expect(results[0]).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ provenance: expect.objectContaining({
      fallbackReason: 'malformed_response', latencyMs: 0,
      diagnostics: expect.objectContaining({ phase: 'response_body', deadlineExpired: false, bodyMs: null }),
    }) })));
    expect(cancel).toHaveBeenCalledTimes(4);
    await expect(client.decide(request)).resolves.toMatchObject({ provenance: { source: 'jev' } });
    expect(call).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});
