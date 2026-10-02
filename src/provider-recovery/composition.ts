import { createHash } from 'node:crypto';
import { readStoredCredential } from '@earendil-works/pi-coding-agent';
import type { LogLevel } from '../logger.js';
import type { ProviderRecoveryConfig } from '../config.js';
import {
  ClaudeUsageAdapter,
  CodexUsageAdapter,
  type MetadataCredential,
  type MetadataFetchPort,
  type MetadataReadOutcome,
} from './metadata.js';
import type { MetadataReaderPort } from './sensor.js';
import type { ProbeOutcome, ProbeRoute } from './probe.js';

/**
 * PRODUCTION metadata composition (phase3 ruling):
 *
 * - CODEX snapshot: `readStoredCredential` — the installed source's genuine
 *   NONMUTATING one-off auth.json read (no store instantiation, no resolver
 *   run, no refresh: `ModelRuntime.getAuth` is NEVER called on this path).
 *   The snapshot must be a subscription OAuth credential (`type: 'oauth'`,
 *   unexpired); API-key credentials, proxies/overrides, wrong-account or
 *   expired contexts are rejected BEFORE any I/O. The account claim is
 *   decoded from the credential's OWN access-token JWT (`chatgpt_account_id`
 *   under the auth claim — the exact identity the Codex client sends as the
 *   ChatGPT-Account-Id request header, per codex-client-source.rs and the
 *   10:31 preflight) — never `auth.source` labels.
 * - CLAUDE snapshot: the ACTUAL selected native platform/store/context via
 *   the traced macOS keychain protocol (`security find-generic-password`),
 *   behind an injected COMMAND PORT. The keychain item's presence + OAuth
 *   shape PROVE the claude.ai first-party OAuth context (no hardcoded brand
 *   flag: API-key-only contexts have no such item and fail closed); only
 *   the traced pro/max subscription kinds qualify. Tests inject fakes ONLY;
 *   production wiring passes the real port and runs only when the sensor is
 *   enabled. The snapshot rejects API-key/env-override contexts and expired
 *   credentials before any I/O.
 * - ENDPOINT MAPPING is explicit and SEPARATE: the failed MODEL endpoint
 *   (catalog route binding) and the fixed METADATA endpoints are different
 *   constants; the reader binds by PROVIDER + credential-generation
 *   fingerprint (rotation fails closed; the waiter's fingerprint is
 *   VERIFIED, never overwritten by a newly resolved credential).
 * - ZERO generation on these paths; every metadata error class stays a
 *   read failure or owner-controlled hold — never a generation fallback.
 * - Credential exceptions log SAFE CATEGORIES only (never raw error text,
 *   which could carry token material).
 * - GLM fallback stays a config activation guard (default off).
 *
 * DORMANT (r4 finding 5): the native-claude reader below is composed but
 * cannot fire in production yet — the claude-code runtime does not emit
 * provider/model/typed provenance and `anthropic-claude-native` has no pi
 * catalog route. The overlay path is marked unshipped/dormant in the spec
 * and gate matrix; grounding it needs a runtime provenance + route-
 * resolution contract, not a relaxed fence.
 */

import { CLAUDE_METADATA_ENDPOINT, CODEX_METADATA_ENDPOINT } from './metadata.js';
export { CLAUDE_METADATA_ENDPOINT, CODEX_METADATA_ENDPOINT };

/** Safe error categories for credential-path logging (no raw text). */
export type CredentialIssueCategory =
  | 'store-unreadable'
  | 'credential-missing'
  | 'credential-wrong-kind'
  | 'credential-expired'
  | 'account-claim-missing'
  | 'fingerprint-mismatch'
  | 'context-override-present'
  | 'transport-unavailable';

function logCredentialIssue(
  log: ((level: LogLevel, msg: string, fields?: Record<string, unknown>) => void) | undefined,
  category: CredentialIssueCategory,
  provider: string,
): void {
  log?.('info', 'credential snapshot rejected (safe category)', { category, provider });
}

/** A proven nonmutating credential snapshot for one provider. */
export interface ProviderCredentialSnapshot {
  readonly provider: string;
  readonly authorization: string;
  /** Account claim decoded from the credential itself (JWT sub/account id),
   * never a resolver label. */
  readonly accountClaim: string;
  /** Fingerprint of the exact credential material (truncated sha256). */
  readonly credentialFingerprint: string;
  readonly store: string;
  readonly generation: number;
}

/** Decode the account claim from an access-token JWT payload (local claim
 * inventory only — signature verification is the transport's job). The
 * Codex client's request-side identity is `chatgpt_account_id` under the
 * auth claim (codex-client-source.rs); other claims are fallbacks only. */
export function accountClaimFromAccessToken(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const auth = payload['https://api.openai.com/auth'];
    const authClaim = typeof auth === 'object' && auth !== null ? (auth as Record<string, unknown>) : undefined;
    const candidate =
      (authClaim !== undefined && typeof authClaim['chatgpt_account_id'] === 'string'
        ? authClaim['chatgpt_account_id']
        : undefined) ??
      (authClaim !== undefined && typeof authClaim['user_id'] === 'string' ? authClaim['user_id'] : undefined) ??
      payload['sub'] ??
      payload['email'] ??
      payload['account_id'];
    if (typeof candidate === 'string' && candidate !== '') return candidate;
    return null;
  } catch {
    return null;
  }
}

function fingerprintOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/** Nonmutating Codex snapshot: ONE synchronous `readStoredCredential` call
 * against the installed auth.json (or the injected fake path in tests).
 * Never refreshes, never writes, never resolves configured key commands. */
export async function codexSnapshot(input: {
  readonly authPath?: string;
  readonly now?: () => number;
}): Promise<ProviderCredentialSnapshot | CredentialIssueCategory> {
  const nowMs = input.now !== undefined ? input.now() : Date.now();
  let credential: ReturnType<typeof readStoredCredential>;
  try {
    credential = readStoredCredential('openai-codex', input.authPath);
  } catch {
    return 'store-unreadable';
  }
  if (credential === undefined) return 'credential-missing';
  if (credential.type !== 'oauth') return 'credential-wrong-kind'; // API-key billing route excluded
  if (typeof credential.access !== 'string' || credential.access === '') return 'credential-wrong-kind';
  // pi-ai stores `expires` as epoch MILLISECONDS (auth/oauth source:
  // `Date.now() + expires_in * 1000`); verified from this dependency tree.
  if (typeof credential.expires !== 'number' || credential.expires <= nowMs) return 'credential-expired';
  const accountClaim = accountClaimFromAccessToken(credential.access);
  if (accountClaim === null) return 'account-claim-missing';
  return {
    provider: 'openai-codex',
    authorization: `Bearer ${credential.access}`,
    accountClaim,
    credentialFingerprint: fingerprintOf(credential.access),
    store: 'pi-auth-json-readonly',
    generation: credential.expires, // generation epoch: rotated tokens change it
  };
}

/** Command port for the native keychain protocol (fakes in tests). */
export interface NativeCommandPort {
  /** ONE bounded invocation of the traced lookup; never interactive. */
  findGenericPassword(input: {
    readonly service: string;
    readonly account: string;
  }): Promise<{ readonly exitCode: number; readonly stdout: string } | null>;
}

/** Env-context port: proves NO API-key/proxy/override context is selected.
 * Only OBSERVED booleans — the selected platform is never asserted here; it
 * is PROVEN by the keychain item itself (the 'Claude Code-credentials' item
 * exists only for a claude.ai first-party OAuth login; API-key-only
 * installs have no such item and fail closed as credential-missing). */
export interface NativeContextPort {
  readonly overridesPresent: boolean;
}

/** Traced native store constants (Claude Code macOS keychain selection). */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Nonmutating native-Claude snapshot: ONE bounded keychain lookup +
 * context guards. The item's PRESENCE and OAuth shape prove the selected
 * claude.ai first-party OAuth context (never a hardcoded brand flag);
 * API-key-only contexts have no item and fail closed. Token/expiry come
 * from the item's own JSON (`claudeAiOauth` wrapper — the native client's
 * stored shape — with a flat fallback); nothing here refreshes or writes. */
export async function claudeSnapshot(input: {
  readonly command: NativeCommandPort;
  readonly context: NativeContextPort;
  readonly account: string;
  readonly now?: () => number;
}): Promise<ProviderCredentialSnapshot | CredentialIssueCategory> {
  const now = input.now ?? Date.now;
  if (input.context.overridesPresent) return 'context-override-present';
  if (input.account === '') return 'account-claim-missing';
  let result: { readonly exitCode: number; readonly stdout: string } | null;
  try {
    result = await input.command.findGenericPassword({
      service: CLAUDE_KEYCHAIN_SERVICE,
      account: input.account,
    });
  } catch {
    return 'transport-unavailable';
  }
  if (result === null || result.exitCode !== 0) return 'credential-missing';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return 'credential-wrong-kind';
  }
  const wrapper = parsed['claudeAiOauth'];
  const oauth: Record<string, unknown> =
    typeof wrapper === 'object' && wrapper !== null ? (wrapper as Record<string, unknown>) : parsed;
  const token = oauth['accessToken'];
  if (typeof token !== 'string' || token === '') return 'credential-missing';
  const expires = oauth['expiresAt'];
  if (typeof expires !== 'number' || expires <= now()) return 'credential-expired';
  // Subscription kind: only the traced claude.ai first-party OAuth kinds
  // qualify; anything else (enterprise/team/unknown brands) fails closed.
  const subscription = oauth['subscription'];
  if (subscription !== undefined && subscription !== 'pro' && subscription !== 'max') {
    return 'credential-wrong-kind';
  }
  const email = oauth['emailAddress'] ?? parsed['emailAddress'];
  // Account claim: an explicit email field when the store carries one,
  // else the ACTUAL selected keychain account (the macOS user the item is
  // bound to) — an observed identity, never a label.
  const accountClaim = typeof email === 'string' && email !== '' ? email : input.account;
  return {
    provider: 'anthropic-claude-native',
    authorization: `Bearer ${token}`,
    accountClaim,
    credentialFingerprint: fingerprintOf(token),
    store: `macos-keychain:${CLAUDE_KEYCHAIN_SERVICE}`,
    generation: typeof expires === 'number' ? expires : now(),
  };
}

/** Reader: binds by PROVIDER + credential-generation fingerprint (rotation
 * fails closed; waiter fingerprints are VERIFIED, never restamped). */
class BoundMetadataReader implements MetadataReaderPort {
  constructor(
    private readonly provider: string,
    private readonly expectedFingerprint: string | null,
    private readonly snapshot: () => Promise<ProviderCredentialSnapshot | CredentialIssueCategory>,
    private readonly adapt: (credential: MetadataCredential) => Promise<MetadataReadOutcome>,
    private readonly log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void,
  ) {}
  async read(route: ProbeRoute): Promise<ProbeOutcome> {
    if (route.provider !== this.provider) {
      return { kind: 'probe-failed', reason: `metadata reader bound to ${this.provider}`, retryAfterMs: null };
    }
    const snapshot = await this.snapshot();
    if (typeof snapshot === 'string') {
      logCredentialIssue(this.log, snapshot, this.provider);
      return { kind: 'probe-failed', reason: `credential snapshot rejected (${snapshot})`, retryAfterMs: null };
    }
    if (this.expectedFingerprint !== null && snapshot.credentialFingerprint !== this.expectedFingerprint) {
      logCredentialIssue(this.log, 'fingerprint-mismatch', this.provider);
      return { kind: 'probe-failed', reason: 'credential rotated since the wait was established', retryAfterMs: null };
    }
    const outcome = await this.adapt({
      authorization: snapshot.authorization,
      accountBinding: snapshot.accountClaim,
    });
    switch (outcome.kind) {
      case 'available': {
        // Adapter identity is required evidence; a read whose outcome lacks
        // it is unsupported evidence — fail closed (never clear a wait).
        const adapter = outcome.evidence['adapter'];
        if (typeof adapter !== 'string' || adapter === '') {
          return { kind: 'probe-failed', reason: 'metadata evidence missing adapter identity', retryAfterMs: null };
        }
        return {
          kind: 'completed',
          evidence: {
            adapter,
            ...outcome.evidence,
            account_claim: snapshot.accountClaim,
            store: snapshot.store,
            credential_generation: snapshot.generation,
          },
        };
      }
      case 'exhausted':
        return { kind: 'still-limited', status: 429, retryAfterMs: outcome.retryAfterMs, detail: outcome.detail };
      case 'owner-controlled':
        return { kind: 'probe-failed', reason: `owner-controlled (${outcome.reason}) — hold preserved`, retryAfterMs: null };
      case 'read-failed':
      default:
        return { kind: 'probe-failed', reason: outcome.reason, retryAfterMs: outcome.retryAfterMs ?? null };
    }
  }
}

/** Compose the production readers. `expectedFingerprint` comes from the
 * requesting wait's route (verification, not stamping). */
export function composeMetadataReaders(input: {
  config: ProviderRecoveryConfig;
  fetch: MetadataFetchPort;
  codexAuthPath?: string;
  claude: {
    readonly command: NativeCommandPort;
    readonly context: () => NativeContextPort;
    readonly account: () => string;
  };
  log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
}): Record<string, MetadataReaderPort> {
  const readers: Record<string, MetadataReaderPort> = {};
  readers['openai-codex'] = {
    read: (route) =>
      new BoundMetadataReader(
        'openai-codex',
        route.credentialFingerprint,
        () => codexSnapshot({ ...(input.codexAuthPath !== undefined ? { authPath: input.codexAuthPath } : {}) }),
        (credential) =>
          new CodexUsageAdapter({
            fetch: input.fetch,
            resolveCredential: () => Promise.resolve(credential),
            timeoutMs: input.config.probeTimeoutMs,
          }).read(),
        input.log,
      ).read(route),
  };
  readers['anthropic-claude-native'] = {
    read: (route) =>
      new BoundMetadataReader(
        'anthropic-claude-native',
        route.credentialFingerprint,
        () =>
          claudeSnapshot({
            command: input.claude.command,
            context: input.claude.context(),
            account: input.claude.account(),
          }),
        (credential) =>
          new ClaudeUsageAdapter({
            fetch: input.fetch,
            resolveCredential: () => Promise.resolve(credential),
            timeoutMs: input.config.probeTimeoutMs,
            model: route.model,
          }).read(),
        input.log,
      ).read(route),
  };
  return readers;
}
