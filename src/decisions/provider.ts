import { performance } from 'node:perf_hooks';
import { DEFAULT_DECISION_PROFILE, type DecisionProviderTable } from '../config.js';
import {
  assertProfileEndpoint,
  type DecisionProviderProfile,
  inputPricePerMtokOf,
  KEYLESS_CREDENTIAL,
} from './profile.js';
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
  constructor(
    readonly reason: DecisionFailureReason,
    detail?: string,
  ) {
    super(`decision provider unavailable (${reason})${detail !== undefined ? `: ${detail}` : ''}`);
    this.name = 'DecisionProviderError';
  }
}

function safeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Honest cost provenance: `usage.cost` wins when the provider reports it
 * (OpenRouter); otherwise the systemone protocol computes the input cost
 * from the profile's `input_price_per_mtok`; when neither is possible the
 * cost is null, never invented.
 */
function usageOf(raw: unknown, profile: DecisionProviderProfile): DecisionUsage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  const inputTokens = safeNumber(usage.input_tokens);
  const reportedCost = safeNumber(usage.cost);
  const computedCost =
    reportedCost ??
    (profile.protocol === 'systemone' && inputTokens !== null
      ? (inputTokens * inputPricePerMtokOf(profile)) / 1_000_000
      : null);
  return {
    inputTokens,
    outputTokens: safeNumber(usage.output_tokens),
    costUsd: computedCost,
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

/** Endpoint/credential binding failures are endpoint_untrusted — the same
 * failure class the single-provider runtime surfaced — with the validator's
 * stranger-actionable detail preserved in the message. */
function assertEndpointTrusted(
  profile: DecisionProviderProfile,
  mode: 'resolved' | 'explicit',
): URL {
  try {
    return assertProfileEndpoint(profile, mode);
  } catch (error) {
    throw new DecisionProviderError('endpoint_untrusted', error instanceof Error ? error.message : String(error));
  }
}

export interface ProfileProviderOptions {
  /** The effective profile (see `effectiveDecisionProviders`). */
  readonly profile: DecisionProviderTable | DecisionProviderProfile;
  /** Resolved slot key; null ONLY for a keyless (`credential = "none"`)
   * loopback profile. */
  readonly key: string | null;
  /** Resolved env/file keys are restricted to the slot's pinned origin;
   * explicitly injected in-process keys only need the protocol shape. */
  readonly credentialMode?: 'resolved' | 'explicit';
  /** Test seam. Production uses global fetch with redirect disabled. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * One decision-provider profile (issue #222): speaks `openrouter-decisions`
 * or `systemone`, sends `{ model, state, questions }`, validates the typed
 * `{ model, answers, usage }` envelope exactly as before, and re-checks the
 * endpoint/credential binding immediately before every request so a slot's
 * key can never travel to another host (redirects included).
 */
export class ProfileProvider {
  private readonly profile: DecisionProviderProfile;
  private readonly key: string | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly credentialMode: 'resolved' | 'explicit';
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(options: ProfileProviderOptions) {
    this.credentialMode = options.credentialMode ?? 'explicit';
    this.profile = options.profile;
    // Validate once at construction so a misbound profile fails loud
    // before any request exists.
    assertEndpointTrusted(this.profile, this.credentialMode);
    if (this.profile.credential === KEYLESS_CREDENTIAL) {
      if (options.key !== null) throw new DecisionProviderError('credential_invalid');
    } else if (
      options.key === null ||
      options.key.trim() === '' ||
      /[\r\n\0]/.test(options.key)
    ) {
      throw new DecisionProviderError('credential_invalid');
    }
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
    // Validate immediately before constructing credential-bearing headers:
    // the binding check is the last gate in front of the wire.
    const endpoint = assertEndpointTrusted(this.profile, this.credentialMode).href;
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), this.profile.timeoutMs);
    timer.unref?.();
    const started = performance.now();
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (this.key !== null) headers['authorization'] = `Bearer ${this.key}`;
      if (this.profile.protocol === 'openrouter-decisions') {
        headers['http-referer'] = 'https://github.com/mssoka/gru-command';
        headers['x-title'] = 'gru-command';
      }
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers,
        body: JSON.stringify({
          model: this.profile.model,
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
        // A structurally rejected request (TypeSafe documents 422) is the
        // caller's shape, not the provider's health: a distinct reason so
        // wiring bugs surface as wiring bugs.
        if (response.status === 422) throw new DecisionProviderError('malformed_request');
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
        usage: usageOf(record.usage, this.profile),
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

/** One profile's decision service: provider failures always fall back to
 * the deterministic outcome; nothing here ever throws to the caller. */
export class ProfileDecisionService implements DecisionService {
  constructor(
    private readonly provider: ProfileProvider,
    private readonly thresholds: ThresholdsConfig,
    private readonly profileName: string = DEFAULT_DECISION_PROFILE,
  ) {}

  async decide<Q extends QuestionSet>(
    request: DecisionRequest<Q>,
    _opts?: { readonly surface?: string },
  ): Promise<DecisionOutcome<Q>> {
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
          profile: this.profileName,
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
