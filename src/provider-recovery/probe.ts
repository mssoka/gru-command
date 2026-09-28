import { createHash } from 'node:crypto';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Context, Model } from '@earendil-works/pi-ai';

/**
 * Bounded same-route readiness probe (owner-approved fallback,
 * owner-approval.json 2026-09-28): a fixed short NO-history / NO-tools
 * generation on the EXACT configured provider/model/credential binding.
 *
 * Bounds, pinned by the approval and verified against the pi-ai transport
 * contract in this dependency tree:
 * - maxTokens 64 (approval pin; sent as StreamOptions.maxTokens)
 * - maxRetries 0, maxRetryDelayMs 0 (pi-ai's OpenAI-SDK client defaults to
 *   2 hidden retries; the probe passes 0 through ProviderRequestOptions so
 *   no SDK/transport retry expansion can occur)
 * - finite timeout: PROBE_TIMEOUT_MS both as the request timeoutMs and an
 *   AbortSignal hard stop
 * - no tools and a single fixed user message — nothing from any session,
 *   worktree, or briefing is ever sent (privacy)
 *
 * A documented authenticated NON-generation endpoint is preferred when one
 * exists that proves the relevant access; none has been established for
 * zai-coding-cn, so this module ships the generation fallback only. Any
 * probe envelope a provider contract does not support fails closed (the
 * wait is never cleared on unknown/partial evidence).
 */

/** Owner-approved probe output cap. Never raised by config. */
export const PROBE_MAX_OUTPUT_TOKENS = 64;

/**
 * Conservative finite timeout for one probe generation. Small generations
 * on a healthy route complete in low single-digit seconds; 30 s bounds a
 * congested-but-alive route generously while keeping the sensor tick
 * responsive. Exceeded = probe failure (backoff), never a recovery.
 */
export const PROBE_TIMEOUT_MS = 30_000;

/** The fixed probe prompt. Constant on purpose: no context, no history. */
export const PROBE_PROMPT = 'Reply with exactly: ok';

/** The route identity one probe proves. credentialFingerprint is a
 * truncated sha256 of the resolved credential — never the credential. */
export interface ProbeRoute {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly credentialFingerprint: string;
}

/** Non-secret digest of completed producer evidence (ledger-safe). */
export interface ProducerEvidence {
  readonly provider: string;
  readonly model: string;
  readonly stopReason: string;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly responseId: string | null;
  readonly responseModel: string | null;
  readonly completedAt: string;
}

export type ProbeOutcome =
  | { readonly kind: 'completed'; readonly evidence: ProducerEvidence }
  | {
      readonly kind: 'still-limited';
      readonly status?: number;
      readonly bodyCode?: string;
      readonly retryAfterMs: number | null;
      readonly detail: string;
    }
  | { readonly kind: 'probe-failed'; readonly reason: string; readonly retryAfterMs: number | null };

/** The transport port the sensor consumes. Real installs get the pi-ai
 * ModelRuntime probe; tests inject a deterministic fake. */
export interface ProviderProbePort {
  probe(route: ProbeRoute): Promise<ProbeOutcome>;
  /** The current credential fingerprint for a provider (non-secret
   * binding); null when no credential resolves. */
  credentialFingerprint(provider: string): Promise<string | null>;
}

/**
 * The recovery evidence gate (briefing acceptance 5): only a FRESH,
 * SUCCESSFUL, COMPLETED provider-protocol message bound to the route being
 * probed counts. Literal OK text, elapsed time, shell success, partial or
 * malformed messages never clear a wait.
 */
export function isCompletedProducerEvidence(
  message: AssistantMessage,
  route: ProbeRoute,
): boolean {
  if (message.stopReason !== 'stop' && message.stopReason !== 'length') return false;
  if (message.errorMessage !== undefined && message.errorMessage !== '') return false;
  if (message.provider !== route.provider) return false;
  if (message.model !== route.model) return false;
  if (message.usage === undefined || typeof message.usage.totalTokens !== 'number') return false;
  if (message.content.length === 0) return false;
  return true;
}

/** Ledger-safe digest of a completed message (drops content text). */
export function producerEvidence(
  message: AssistantMessage,
  now: () => Date = () => new Date(),
): ProducerEvidence {
  return {
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    outputTokens: typeof message.usage.output === 'number' ? message.usage.output : null,
    totalTokens: typeof message.usage.totalTokens === 'number' ? message.usage.totalTokens : null,
    responseId: message.responseId ?? null,
    responseModel: message.responseModel ?? null,
    completedAt: now().toISOString(),
  };
}

/** Truncated sha256 of a credential value — the non-secret binding. */
export function credentialFingerprintOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/**
 * The pi-ai ModelRuntime probe. The runtime is INJECTED (the same shared
 * offline ModelRuntime the pi adapter uses — never a second network
 * catalog build). Route resolution failures are probe failures (fail
 * closed), never recoveries.
 */
export class ModelRuntimeProbe implements ProviderProbePort {
  private readonly runtime: () => Promise<ModelRuntime>;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(opts: {
    runtime: () => Promise<ModelRuntime>;
    timeoutMs?: number;
    now?: () => Date;
  }) {
    this.runtime = opts.runtime;
    this.timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.now = opts.now ?? (() => new Date());
  }

  async credentialFingerprint(provider: string): Promise<string | null> {
    try {
      const runtime = await this.runtime();
      const auth = await runtime.getAuth(provider);
      const current = auth?.auth.apiKey;
      return current === undefined ? null : credentialFingerprintOf(current);
    } catch {
      return null;
    }
  }

  async probe(route: ProbeRoute): Promise<ProbeOutcome> {
    let model: Model<never> | undefined;
    try {
      const runtime = await this.runtime();
      const resolved = runtime.getModel(route.provider, route.model);
      if (resolved === undefined) {
        return {
          kind: 'probe-failed',
          reason: `model ${route.provider}/${route.model} not in the registered catalog`,
          retryAfterMs: null,
        };
      }
      model = resolved as unknown as Model<never>;
      // Credential binding check: the fingerprint must still match the
      // credential this wait was established under. A rotated credential
      // is a route change — fail closed and let the sensor supersede.
      const auth = await runtime.getAuth(route.provider);
      const current = auth?.auth.apiKey;
      if (current === undefined) {
        return {
          kind: 'probe-failed',
          reason: `no resolved credential for provider ${route.provider}`,
          retryAfterMs: null,
        };
      }
      if (credentialFingerprintOf(current) !== route.credentialFingerprint) {
        return {
          kind: 'probe-failed',
          reason: 'credential rotated since the wait was established',
          retryAfterMs: null,
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      const context: Context = {
        messages: [{ role: 'user', content: PROBE_PROMPT, timestamp: this.now().getTime() }],
      };
      try {
        const message = await runtime.completeSimple(model as never, context, {
          maxTokens: PROBE_MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          maxRetryDelayMs: 0,
          timeoutMs: this.timeoutMs,
          signal: controller.signal,
        });
        if (message.stopReason === 'error') {
          return {
            kind: 'still-limited',
            ...(parseStatusFromBody(message.errorMessage ?? '') ?? {}),
            retryAfterMs: null,
            detail: (message.errorMessage ?? 'provider returned an error stop reason').slice(0, 300),
          };
        }
        if (!isCompletedProducerEvidence(message as AssistantMessage, route)) {
          return {
            kind: 'probe-failed',
            reason: 'probe response was not completed producer evidence for this route',
            retryAfterMs: null,
          };
        }
        return {
          kind: 'completed',
          evidence: producerEvidence(message as AssistantMessage, this.now),
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const detail = String(error);
      const parsed = parseStatusFromBody(detail);
      if (parsed !== null) {
        return {
          kind: 'still-limited',
          ...parsed,
          retryAfterMs: null,
          detail: detail.slice(0, 300),
        };
      }
      return {
        kind: 'probe-failed',
        reason: detail.slice(0, 300),
        retryAfterMs: null,
      };
    }
  }
}

/** Machine-composed `"<status>: <json-body>"` probe (same shape the
 * classifier accepts): status + body error code, or null. */
function parseStatusFromBody(text: string): { status: number; bodyCode?: string } | null {
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const head = text.slice(0, colon).trim();
  if (!/^\d{3}$/.test(head)) return null;
  const status = Number(head);
  const bodyText = text.slice(colon + 1).trim();
  if (bodyText === '' || !bodyText.startsWith('{')) return { status };
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    if (typeof code === 'string' && code !== '') return { status, bodyCode: code };
    if (typeof code === 'number' && Number.isInteger(code)) return { status, bodyCode: String(code) };
    return { status };
  } catch {
    return { status };
  }
}
