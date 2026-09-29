import { createHash } from 'node:crypto';
import type { LogLevel } from '../logger.js';

/**
 * Non-generation quota READINESS adapters for the owner-approved
 * multi-provider scope (multi-provider-approved-overlay.md, 2026-09-28):
 *
 * - openai-codex: GET https://chatgpt.com/backend-api/wham/usage through the
 *   EXISTING Pi OAuth credential resolver (source-traced contract; no new
 *   auth/refresh framework, no scope expansion, no API-key billing route).
 * - native Claude (claude.ai Pro OAuth): GET
 *   https://api.anthropic.com/api/oauth/usage through the ACTUAL selected
 *   native store/platform/context (injected resolver — no hardcoded
 *   account, home directory, or keychain discovery; never another
 *   provider's key).
 *
 * ZERO generation for both. A failed/unusable metadata read NEVER falls back
 * to a generation probe (that path exists only for the bounded GLM
 * fallback, which the overlay keeps DISABLED in production via config).
 * Metadata is authoritative ONLY for the matching temporary QUOTA blocker:
 * auth/permission/billing/unsupported-contract failures classify to
 * owner-controlled; null/unknown/exhausted/contradictory data fails closed.
 * Reset timestamps are SCHEDULING HINTS, never recovery proof. Reads are
 * side-effect free: no credits/billing/extra-usage/notification mutation,
 * no tokens in argv/logs (credential material stays inside the injected
 * resolver and is reduced to a truncated sha256 fingerprint).
 */

/** One non-generation usage read, shared with the sensor's probe vocabulary. */
export type MetadataReadOutcome =
  | { readonly kind: 'available'; readonly evidence: Record<string, unknown>; readonly retryAfterMs: null }
  | { readonly kind: 'exhausted'; readonly retryAfterMs: number | null; readonly detail: string }
  | { readonly kind: 'owner-controlled'; readonly reason: 'authentication' | 'permission' | 'billing' | 'unsupported-contract' }
  | { readonly kind: 'read-failed'; readonly reason: string; readonly retryAfterMs: number | null };

/** Credentials injected per adapter — fakes in tests; production wires the
 * existing Pi OAuth resolver (codex) and the native selected OAuth
 * platform/store/context (claude). Adapters never discover credentials. */
export interface MetadataCredential {
  /** Authorization header VALUE (never logged, never persisted). */
  readonly authorization: string;
  /** Non-secret identity the response account must match (binding). */
  readonly accountBinding: string;
}

export interface MetadataFetchPort {
  /** ONE bounded GET; no redirects followed, TLS verified, no retries.
   * `extraHeaders` carries the credential-claim-derived request binding
   * (Codex: ChatGPT-Account-Id from the snapshot's own JWT claim) — never
   * secrets beyond the already-authorized authorization header. */
  get(input: {
    readonly url: string;
    readonly authorization: string;
    readonly accept: string;
    readonly timeoutMs: number;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

export interface MetadataRouteBinding {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly credentialFingerprint: string;
}

/** Conservative finite read timeout (well under the tick cadence). */
export const METADATA_READ_TIMEOUT_MS = 15_000;

/** Truncated sha256 — the only credential-derived value ever persisted. */
export function metadataFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------
// Codex (openai-codex) — wham/usage contract (source-traced)
// ------------------------------------------------------------------

/** Strict shape of the traced wham/usage response (2026-09-28 capture +
 * codex-rate-limit-source.rs). Optional fields interpreted ONLY when the
 * contract defines them; anything else is unsupported-contract (fail
 * closed). */
interface CodexWindow {
  readonly used_percent: number;
  readonly limit_window_seconds: number;
  readonly reset_after_seconds: number;
  readonly reset_at: number;
}
interface CodexUsageBody {
  readonly rateLimit: {
    readonly allowed: boolean;
    readonly limit_reached: boolean;
    readonly primary_window: CodexWindow | null;
    readonly secondary_window?: CodexWindow | null;
  };
  readonly codeReviewRateLimit?: unknown;
  readonly additionalRateLimits?: readonly unknown[];
}

/** Validate the codex body STRICTLY. Returns null for any deviation. */
export function validateCodexUsageBody(raw: string): CodexUsageBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const rateLimit = root['rateLimit'];
  if (typeof rateLimit !== 'object' || rateLimit === null) return null;
  const rl = rateLimit as Record<string, unknown>;
  if (typeof rl['allowed'] !== 'boolean') return null;
  if (typeof rl['limit_reached'] !== 'boolean') return null;
  const primary = rl['primary_window'];
  const windows: CodexWindow[] = [];
  if (primary !== null) {
    const w = validateCodexWindow(primary);
    if (w === null) return null;
    windows.push(w);
  }
  const secondary = rl['secondary_window'];
  if (secondary !== undefined && secondary !== null) {
    const w = validateCodexWindow(secondary);
    if (w === null) return null;
    windows.push(w);
  }
  if (primary === null && (secondary === undefined || secondary === null)) {
    // No windows at all: unknown, not unlimited.
    return null;
  }
  return {
    rateLimit: {
      allowed: rl['allowed'],
      limit_reached: rl['limit_reached'],
      primary_window: primary === null ? null : (validateCodexWindow(primary) as CodexWindow),
      secondary_window: secondary === undefined ? null : (secondary === null ? null : validateCodexWindow(secondary)),
    },
    ...(root['codeReviewRateLimit'] !== undefined ? { codeReviewRateLimit: root['codeReviewRateLimit'] } : {}),
    ...(Array.isArray(root['additionalRateLimits'])
      ? { additionalRateLimits: root['additionalRateLimits'] as readonly unknown[] }
      : {}),
  };
}

function validateCodexWindow(value: unknown): CodexWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const w = value as Record<string, unknown>;
  if (
    typeof w['used_percent'] !== 'number' ||
    typeof w['limit_window_seconds'] !== 'number' ||
    typeof w['reset_after_seconds'] !== 'number' ||
    typeof w['reset_at'] !== 'number'
  ) {
    return null;
  }
  return {
    used_percent: w['used_percent'],
    limit_window_seconds: w['limit_window_seconds'],
    reset_after_seconds: w['reset_after_seconds'],
    reset_at: w['reset_at'],
  };
}

/** Map a validated codex body to a readiness outcome. */
export function codexUsageOutcome(body: CodexUsageBody): MetadataReadOutcome {
  if (body.rateLimit.limit_reached || body.rateLimit.allowed !== true) {
    const reset = earliestResetSeconds([body.rateLimit.primary_window, body.rateLimit.secondary_window ?? null]);
    return {
      kind: 'exhausted',
      retryAfterMs: reset === null ? null : Math.max(0, reset * 1000 - Date.now()),
      detail: 'codex usage window limit reached',
    };
  }
  // Available — but only evidence, never a capacity promise for all work.
  const primary = body.rateLimit.primary_window;
  return {
    kind: 'available',
    retryAfterMs: null,
    evidence: {
      adapter: 'codex-wham-usage',
      allowed: body.rateLimit.allowed,
      limit_reached: body.rateLimit.limit_reached,
      primary_used_percent: primary === null ? null : primary.used_percent,
      primary_reset_at: primary === null ? null : primary.reset_at,
      secondary_window: body.rateLimit.secondary_window === null || body.rateLimit.secondary_window === undefined ? null : 'present',
    },
  };
}

// ------------------------------------------------------------------
// Native Claude (claude.ai Pro OAuth) — /api/oauth/usage contract
// ------------------------------------------------------------------

interface ClaudeWindow {
  readonly utilization: number;
  readonly resetsAtUtc: string;
}
interface ClaudeUsageBody {
  readonly windows: {
    readonly five_hour: ClaudeWindow;
    readonly seven_day: ClaudeWindow;
    readonly seven_day_oauth_apps?: ClaudeWindow | null;
    readonly seven_day_opus?: ClaudeWindow | null;
    readonly seven_day_sonnet?: ClaudeWindow | null;
    readonly seven_day_cowork?: ClaudeWindow | null;
  };
  readonly scopedLimits?: readonly { readonly percent: number; readonly resetsAtUtc: string }[];
}

/** Strict validation of the traced oauth/usage shape. Null windows for
 * OPTIONAL model buckets stay unknown (never "unlimited"); five_hour and
 * seven_day are REQUIRED by the traced contract. */
export function validateClaudeUsageBody(raw: string): ClaudeUsageBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const windows = root['windows'];
  if (typeof windows !== 'object' || windows === null) return null;
  const w = windows as Record<string, unknown>;
  const five = validateClaudeWindow(w['five_hour']);
  const seven = validateClaudeWindow(w['seven_day']);
  if (five === null || seven === null) return null;
  return {
    windows: {
      five_hour: five,
      seven_day: seven,
    },
    ...(Array.isArray(root['scopedLimits'])
      ? {
          scopedLimits: (root['scopedLimits'] as unknown[]).flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null) return [];
            const limit = entry as Record<string, unknown>;
            if (typeof limit['percent'] !== 'number' || typeof limit['resetsAtUtc'] !== 'string') return [];
            return [{ percent: limit['percent'], resetsAtUtc: limit['resetsAtUtc'] }];
          }),
        }
      : {}),
  };
}

function validateClaudeWindow(value: unknown): ClaudeWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const w = value as Record<string, unknown>;
  if (typeof w['utilization'] !== 'number' || typeof w['resetsAtUtc'] !== 'string') return null;
  if (!Number.isFinite(w['utilization']) || w['utilization'] < 0 || w['utilization'] > 1) return null;
  if (Number.isNaN(Date.parse(w['resetsAtUtc']))) return null;
  return { utilization: w['utilization'], resetsAtUtc: w['resetsAtUtc'] };
}

/** Map a validated claude body: any REQUIRED window at 1.0 = exhausted
 * (reset hint from that window); optional model windows only ADD exhaustion
 * (they never prove availability). */
export function claudeUsageOutcome(body: ClaudeUsageBody, now: () => Date = () => new Date()): MetadataReadOutcome {
  const required: readonly ClaudeWindow[] = [body.windows.five_hour, body.windows.seven_day];
  const exhausted = required.find((window) => window.utilization >= 1);
  if (exhausted !== undefined) {
    return {
      kind: 'exhausted',
      retryAfterMs: Math.max(0, Date.parse(exhausted.resetsAtUtc) - now().getTime()),
      detail: 'claude usage window exhausted',
    };
  }
  return {
    kind: 'available',
    retryAfterMs: null,
    evidence: {
      adapter: 'claude-oauth-usage',
      five_hour_utilization: body.windows.five_hour.utilization,
      seven_day_utilization: body.windows.seven_day.utilization,
      scoped_limit_count: body.scopedLimits?.length ?? 0,
    },
  };
}

function earliestResetSeconds(windows: readonly (CodexWindow | null | undefined)[]): number | null {
  let earliest: number | null = null;
  for (const window of windows) {
    if (window === null || window === undefined) continue;
    if (earliest === null || window.reset_at < earliest) earliest = window.reset_at;
  }
  return earliest;
}

// ------------------------------------------------------------------
// The adapters
// ------------------------------------------------------------------

/** Shared HTTP-status triage: metadata read failures map to the sensor
 * vocabulary with owner statuses preserved and NEVER a generation
 * fallback. */
export function metadataStatusOutcome(status: number, detail: string): MetadataReadOutcome {
  if (status === 401) return { kind: 'owner-controlled', reason: 'authentication' };
  if (status === 403) return { kind: 'owner-controlled', reason: 'permission' };
  if (status === 402) return { kind: 'owner-controlled', reason: 'billing' };
  if (status === 429) {
    // The metadata ENDPOINT itself is rate limited — a read failure with a
    // bounded retry hint, never a quota verdict and never a fallback.
    return { kind: 'read-failed', reason: `metadata endpoint rate limited: ${detail}`, retryAfterMs: null };
  }
  return { kind: 'read-failed', reason: `metadata read failed (${status}): ${detail}`, retryAfterMs: null };
}

export interface MetadataAdapterOptions {
  readonly fetch: MetadataFetchPort;
  readonly resolveCredential: () => Promise<MetadataCredential | null>;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly log?: Log;
}

export class CodexUsageAdapter {
  private readonly opts: MetadataAdapterOptions;
  constructor(opts: MetadataAdapterOptions) {
    this.opts = opts;
  }
  async read(): Promise<MetadataReadOutcome> {
    return readUsage({
      opts: this.opts,
      url: 'https://chatgpt.com/backend-api/wham/usage',
      accept: 'application/json',
      validate: validateCodexUsageBody,
      toOutcome: (body) => codexUsageOutcome(body),
      adapterName: 'codex',
      // The Codex client's request-side account binding (codex-client-source.rs):
      // ChatGPT-Account-Id = the credential's OWN JWT auth claim.
      extraHeaders: (credential) => ({ 'chatgpt-account-id': credential.accountBinding }),
    });
  }
}

export class ClaudeUsageAdapter {
  private readonly opts: MetadataAdapterOptions;
  constructor(opts: MetadataAdapterOptions) {
    this.opts = opts;
  }
  async read(): Promise<MetadataReadOutcome> {
    return readUsage({
      opts: this.opts,
      url: 'https://api.anthropic.com/api/oauth/usage',
      accept: 'application/json',
      validate: validateClaudeUsageBody,
      toOutcome: (body) => claudeUsageOutcome(body, this.opts.now ?? (() => new Date())),
      adapterName: 'claude',
    });
  }
}

/** Shared single-read driver: resolve credential → ONE bounded GET →
 * strict validate → map. No retries, no redirects, no generation, no
 * credential logging (only the pre-computed fingerprint travels on). */
async function readUsage<T>(input: {
  readonly opts: MetadataAdapterOptions;
  readonly url: string;
  readonly accept: string;
  readonly validate: (raw: string) => T | null;
  readonly toOutcome: (body: T) => MetadataReadOutcome;
  readonly adapterName: string;
  readonly extraHeaders?: (credential: MetadataCredential) => Readonly<Record<string, string>>;
}): Promise<MetadataReadOutcome> {
  const credential = await input.opts.resolveCredential().catch(() => null);
  if (credential === null) {
    // Missing/stale/unavailable credentials are NOT a reason to bypass
    // owner control — a failed read, fail closed.
    return { kind: 'read-failed', reason: `${input.adapterName} credential unavailable`, retryAfterMs: null };
  }
  let response: { readonly status: number; readonly body: string };
  try {
    response = await input.opts.fetch.get({
      url: input.url,
      authorization: credential.authorization,
      accept: input.accept,
      timeoutMs: input.opts.timeoutMs ?? METADATA_READ_TIMEOUT_MS,
      ...(input.extraHeaders !== undefined ? { extraHeaders: input.extraHeaders(credential) } : {}),
    });
  } catch (error) {
    return { kind: 'read-failed', reason: `${input.adapterName} metadata transport failure: ${String(error).slice(0, 160)}`, retryAfterMs: null };
  }
  if (response.status !== 200) {
    return metadataStatusOutcome(response.status, input.adapterName);
  }
  const body = input.validate(response.body);
  if (body === null) {
    // Partial/malformed/unknown schema — unsupported contract, fail closed.
    return { kind: 'owner-controlled', reason: 'unsupported-contract' };
  }
  return input.toOutcome(body);
}

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
