import { performance } from 'node:perf_hooks';
import type { JevConfig } from '../config.js';
import {
  decisionRoute,
  deterministicOutcome,
  validateRequest,
  validatedAnswers,
} from './service.js';
import type {
  DecisionFailureReason,
  DecisionOutcome,
  DecisionRequest,
  DecisionService,
  DecisionUsage,
  QuestionSet,
  ThresholdsConfig,
} from './types.js';

export const OPENROUTER_DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

export class DecisionProviderError extends Error {
  constructor(readonly reason: DecisionFailureReason) {
    super(`decision provider unavailable (${reason})`);
    this.name = 'DecisionProviderError';
  }
}

function secureEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new DecisionProviderError('endpoint_untrusted');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new DecisionProviderError('endpoint_untrusted');
  }
  return parsed;
}

export function assertTrustedOpenRouterEndpoint(endpoint: string): URL {
  const parsed = secureEndpoint(endpoint);
  if (
    parsed.hostname !== 'openrouter.ai' ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.pathname !== '/api/alpha/decisions'
  ) {
    throw new DecisionProviderError('endpoint_untrusted');
  }
  return parsed;
}

function endpointForCredential(endpoint: string, mode: 'resolved' | 'explicit'): URL {
  return mode === 'resolved' ? assertTrustedOpenRouterEndpoint(endpoint) : secureEndpoint(endpoint);
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageOf(raw: unknown): DecisionUsage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  return {
    inputTokens: safeNumber(usage.input_tokens),
    outputTokens: safeNumber(usage.output_tokens),
    costUsd: safeNumber(usage.cost),
  };
}

function providerReason(error: unknown): DecisionFailureReason {
  if (error instanceof DecisionProviderError) return error.reason;
  if (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))) {
    return 'timeout';
  }
  return 'network_error';
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 4;

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new DecisionProviderError('malformed_response');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new DecisionProviderError('malformed_response');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof DecisionProviderError) throw error;
    // The request deadline owns the body stream as well as header receipt.
    // Preserve timeout semantics when aborting reader.read(); only genuine
    // decoding/stream corruption is a malformed response.
    if (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))) {
      throw new DecisionProviderError('timeout');
    }
    throw new DecisionProviderError('malformed_response');
  }
}

export interface JevProviderOptions {
  readonly config: JevConfig;
  readonly key: string;
  /** Resolved env/file keys are restricted to the exact trusted endpoint. */
  readonly credentialMode?: 'resolved' | 'explicit';
  /** Test seam. Production uses global fetch with redirect disabled. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** Owns every in-flight request so disable/reload can abort the old generation. */
export class JevProvider {
  private readonly config: JevConfig;
  private readonly key: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly credentialMode: 'resolved' | 'explicit';
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(options: JevProviderOptions) {
    this.credentialMode = options.credentialMode ?? 'explicit';
    endpointForCredential(options.config.endpoint, this.credentialMode);
    if (options.key.trim() === '' || /[\r\n\0]/.test(options.key)) {
      throw new DecisionProviderError('credential_invalid');
    }
    this.config = options.config;
    this.key = options.key;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async request<Q extends QuestionSet>(request: DecisionRequest<Q>): Promise<{
    readonly answers: DecisionOutcome<Q>['answers'];
    readonly model: string | null;
    readonly latencyMs: number;
    readonly usage: DecisionUsage | null;
  }> {
    if (this.disposed) throw new DecisionProviderError('disposed');
    if (this.active.size >= MAX_CONCURRENT_REQUESTS) {
      // Local backpressure is not evidence that the remote provider failed.
      // This call falls back, but the shared ready provider remains usable.
      throw new DecisionProviderError('capacity_limited');
    }
    validateRequest(request);
    // Validate immediately before constructing credential-bearing headers.
    const endpoint = endpointForCredential(this.config.endpoint, this.credentialMode).href;
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();
    const started = performance.now();
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.key}`,
          'content-type': 'application/json',
          'http-referer': 'https://github.com/mssoka/gru-command',
          'x-title': 'gru-command',
        },
        body: JSON.stringify({
          model: this.config.model,
          state: request.state,
          questions: request.questions,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // The request controller is also aborted in finally; body text is
          // never read or surfaced on an error response.
        }
        if (response.status >= 300 && response.status < 400) {
          throw new DecisionProviderError('endpoint_untrusted');
        }
        if (response.status === 401) throw new DecisionProviderError('auth_rejected');
        if (response.status === 403) throw new DecisionProviderError('forbidden');
        throw new DecisionProviderError('provider_degraded');
      }
      const responseText = await boundedResponseText(response);
      let envelope: unknown;
      try {
        envelope = JSON.parse(responseText) as unknown;
      } catch {
        throw new DecisionProviderError('malformed_response');
      }
      if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
        throw new DecisionProviderError('malformed_response');
      }
      const record = envelope as Record<string, unknown>;
      let answers: DecisionOutcome<Q>['answers'];
      try {
        answers = validatedAnswers(request.questions, record.answers);
      } catch {
        throw new DecisionProviderError('malformed_response');
      }
      return {
        answers,
        model: typeof record.model === 'string' && record.model.trim() !== '' ? record.model : null,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        usage: usageOf(record.usage),
      };
    } catch (error) {
      throw new DecisionProviderError(providerReason(error));
    } finally {
      clearTimeout(timer);
      // If fetch resolved on headers and an error body is still streaming,
      // retain ownership long enough to cancel it before releasing the slot.
      controller.abort();
      this.active.delete(controller);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}

export class JevDecisionService implements DecisionService {
  constructor(
    private readonly provider: JevProvider,
    private readonly thresholds: ThresholdsConfig,
  ) {}

  async decide<Q extends QuestionSet>(request: DecisionRequest<Q>): Promise<DecisionOutcome<Q>> {
    try {
      const result = await this.provider.request(request);
      const routes: Record<string, ReturnType<typeof decisionRoute>> = {};
      for (const id of Object.keys(request.questions)) {
        routes[id] = decisionRoute(
          result.answers[id]!,
          request.risks[id]!,
          this.thresholds,
        );
      }
      return {
        answers: result.answers,
        routes: routes as DecisionOutcome<Q>['routes'],
        provenance: {
          source: 'jev',
          fallbackReason: null,
          model: result.model,
          latencyMs: result.latencyMs,
          usage: result.usage,
        },
      };
    } catch (error) {
      return deterministicOutcome(request, this.thresholds, providerReason(error));
    }
  }

  dispose(): void {
    this.provider.dispose();
  }
}
