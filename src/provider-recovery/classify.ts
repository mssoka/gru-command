/**
 * Provider-aware failure classification for the provider-recovery sensor
 * (owner-approved 2026-09-28; plan-v3 + owner-approval.json).
 *
 * The sensor's automatic recovery is scoped to EXPLICIT evidence that a
 * SUPPORTED provider returned a temporary, recoverable usage limit on a
 * real runtime rejection. It is deliberately narrower than
 * `deterministicFailureClass`: that text classifier lumps 402/403/429/
 * balance/quota into one `quota_wall` and stays the supervisor's
 * stop-decision oracle. This module decides ONLY whether a wall may become
 * an automatic provider wait:
 *
 * - `temporary-recoverable` — the provider itself reported a usage-window
 *   limit that resets with time (HTTP 429 usage limit per the Z.AI API
 *   reference; GLM business codes 1302/1308 inside the error body). These,
 *   and only these, are eligible for automatic recovery.
 * - `owner-controlled` — authentication (401), permission (403), billing
 *   (402 / GLM 1113 insufficient balance), or anything ambiguous. Owner
 *   control is preserved; no wait row is created.
 *
 * Evidence discipline (briefing acceptance 1/5/8): classification is
 * evidence-based — a structured provider/protocol identity plus a machine-
 * composed error line — never free-text prose, generic blocked status, or
 * backlog membership. Unknown or partial evidence fails toward the owner.
 */

/** Structured evidence extracted from a runtime provider rejection. */
export interface ProviderRejectionEvidence {
  /** Provider id as the runtime reported it (e.g. "zai-coding-cn"). */
  readonly provider: string;
  /** Model id as the runtime reported it (e.g. "glm-5.3"). */
  readonly model: string;
  /** HTTP status of the provider response, when the error carried one. */
  readonly status?: number;
  /** Provider business code from the parsed error body (e.g. "1302"). */
  readonly bodyCode?: string;
  /** Trustworthy Retry-After hint (ms), when the provider supplied one. */
  readonly retryAfterMs?: number;
  /** The machine-composed error line (diagnostics; never the sole basis). */
  readonly errorMessage: string;
}

/** GLM business codes the Z.AI error body uses for usage-window quota
 * limits (the codes that stopped the two heists; same codes the
 * deterministic text classifier treats as quota signals). */
const GLM_TEMPORARY_QUOTA_CODES: ReadonlySet<string> = new Set(['1302', '1308']);

/** GLM business code for insufficient account balance — billing, not a
 * usage window: owner-controlled even though the HTTP layer says quota-ish. */
const GLM_BILLING_CODES: ReadonlySet<string> = new Set(['1113']);

export type ProviderLimitClass =
  | { readonly kind: 'temporary-recoverable'; readonly retryAfterMs: number | null }
  | {
      readonly kind: 'owner-controlled';
      readonly reason: 'authentication' | 'permission' | 'billing' | 'unsupported-provider' | 'ambiguous';
    };

/**
 * Classify structured provider rejection evidence. Pure and deterministic.
 *
 * Precedence: a known GLM temporary-quota body code wins over the HTTP
 * status (the Z.AI API wraps quota-limit rejections; the body code is the
 * precise signal). Then 429 → temporary; 401/403/402 → owner; GLM billing
 * code → owner; a provider without a wait-capable rejection → owner
 * (unsupported); everything else → owner (ambiguous). Missing
 * provider/model identity is ambiguous: a wait cannot bind a route without
 * it.
 */
export function classifyProviderRejection(
  evidence: ProviderRejectionEvidence,
): ProviderLimitClass {
  if (evidence.provider === '' || evidence.model === '') {
    return { kind: 'owner-controlled', reason: 'ambiguous' };
  }
  const bodyCode = evidence.bodyCode;
  if (bodyCode !== undefined && GLM_TEMPORARY_QUOTA_CODES.has(bodyCode)) {
    return { kind: 'temporary-recoverable', retryAfterMs: evidence.retryAfterMs ?? null };
  }
  if (bodyCode !== undefined && GLM_BILLING_CODES.has(bodyCode)) {
    return { kind: 'owner-controlled', reason: 'billing' };
  }
  switch (evidence.status) {
    case 429:
      return { kind: 'temporary-recoverable', retryAfterMs: evidence.retryAfterMs ?? null };
    case 401:
      return { kind: 'owner-controlled', reason: 'authentication' };
    case 403:
      return { kind: 'owner-controlled', reason: 'permission' };
    case 402:
      return { kind: 'owner-controlled', reason: 'billing' };
    default:
      return { kind: 'owner-controlled', reason: 'ambiguous' };
  }
}

/**
 * Providers whose rejections this sensor version understands. v1 is the
 * actual installed China coding route (owner pin); other providers get
 * verified adapters later — until then their walls stay owner-controlled
 * even when the status looks like 429.
 */
export const SENSOR_SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(['zai-coding-cn']);

/** Is this provider's evidence eligible for automatic recovery at all? */
export function providerSupportsSensor(provider: string): boolean {
  return SENSOR_SUPPORTED_PROVIDERS.has(provider);
}

/**
 * Extract structured evidence from a machine-composed provider error line.
 *
 * pi-ai composes provider HTTP failures as `"<status>: <json-body>"`
 * (`formatProviderError` in pi-ai's error-body utils — status and body come
 * from the SDK error object, not free text), and the Z.AI body carries
 * `{"error":{"code":"...","message":"..."}}`. This parser accepts ONLY that
 * machine shape: a numeric status before the first colon, and a strict JSON
 * body whose `error.code` is a string/number. Anything else yields partial
 * evidence (status only, or none) — the classifier then fails toward owner
 * control rather than guessing from prose.
 */
export function extractProviderRejectionEvidence(input: {
  readonly provider: string;
  readonly model: string;
  readonly errorMessage: string;
  readonly retryAfterMs?: number;
}): ProviderRejectionEvidence {
  const evidence: ProviderRejectionEvidence = {
    provider: input.provider,
    model: input.model,
    errorMessage: input.errorMessage,
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
  };
  const colon = input.errorMessage.indexOf(':');
  const head = colon > 0 ? input.errorMessage.slice(0, colon).trim() : input.errorMessage.trim();
  const status = /^\d{3}$/.test(head) ? Number(head) : undefined;
  const bodyText = colon > 0 ? input.errorMessage.slice(colon + 1).trim() : '';
  const bodyCode = parseBodyErrorCode(bodyText);
  return {
    ...evidence,
    ...(status !== undefined ? { status } : {}),
    ...(bodyCode !== undefined ? { bodyCode } : {}),
  };
}

/** Strict `{"error":{"code":...}}` probe; returns undefined for anything
 * that is not exactly that machine shape. */
function parseBodyErrorCode(bodyText: string): string | undefined {
  if (bodyText === '' || !bodyText.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    if (typeof code === 'string' && code !== '') return code;
    if (typeof code === 'number' && Number.isInteger(code)) return String(code);
    return undefined;
  } catch {
    return undefined;
  }
}
