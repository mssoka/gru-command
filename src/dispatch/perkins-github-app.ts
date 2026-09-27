import { createPrivateKey, createSign } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrIdentity, VerdictPoster } from './perkins.js';
import { GhPrPoster } from './perkins.js';
import { repoRemote } from './review-path.js';

/**
 * Perkins GitHub App publication (2026-09-27 owner ruling).
 *
 * Reviews on github.com are published by the installed Perkins GitHub App
 * (`perkins-review[bot]`), not the operator's personal `gh` credential.
 * The existing literal runtime bundle — `<instanceDir>/perkins/config`
 * plus the referenced PEM key — is the ONLY credential source: it is read
 * as literal KEY=VALUE data (never eval'd or sourced), and every failure
 * fails closed with sanitized diagnostics. No personal-account fallback
 * exists anywhere in this module.
 */

export class PerkinsAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PerkinsAppError';
  }
}

/** Strip credential-shaped bytes before any provider text reaches an error
 * message or log line. Fixed placeholder: a digest would be an offline
 * brute-force oracle for low-entropy secrets. */
function sanitize(text: string): string {
  return text
    .replace(/-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/gu, '[REDACTED]')
    .replace(/\bgh[pousra]_[A-Za-z0-9_]{16,}\b/gu, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/gu, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 300);
}

// ---------------------------------------------------------------------------
// Bundle: literal KEY=VALUE config under the trusted runtime instance dir
// ---------------------------------------------------------------------------

/** Directory holding the Perkins App bundle (config + key), under the
 * service's trusted instance dir — never a repository checkout. */
export function perkinsAppBundleDir(instanceDir: string): string {
  return join(instanceDir, 'perkins');
}

/** True when an App bundle config exists. Presence selects App publication
 * for github.com; absence keeps the legacy `gh` poster exactly as-is. */
export function perkinsAppBundleConfigured(instanceDir: string): boolean {
  return existsSync(join(perkinsAppBundleDir(instanceDir), 'config'));
}

export interface PerkinsAppBundleConfig {
  readonly appId: number;
  /** Resolved absolute path of the private key file (diagnostics only). */
  readonly keyPath: string;
  /** Lowercased repository owner -> installation id. */
  readonly installationIds: ReadonlyMap<string, string>;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]!;
    const last = value[value.length - 1]!;
    if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Parse the installed literal bundle: `app_id=`, `key_path=` (quoted or
 * unquoted), and `installation_id_<owner>=` entries where owner keeps its
 * literal spelling — hyphenated organization names included. Values are
 * never shell-interpolated: `$HOME` stays the literal four characters. */
export function parsePerkinsAppConfig(text: string, sourceLabel: string): PerkinsAppBundleConfig {
  const seen = new Map<string, string>();
  const installationIds = new Map<string, string>();
  text.split(/\r?\n/u).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new PerkinsAppError(
        `${sourceLabel}: line ${index + 1} is not KEY=VALUE (key/line prefix: ${sanitize(line.slice(0, 24))})`,
      );
    }
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (!KEY_PATTERN.test(key)) {
      throw new PerkinsAppError(
        `${sourceLabel}: line ${index + 1} has an invalid key (${sanitize(key.slice(0, 24))})`,
      );
    }
    const prior = seen.get(key);
    if (prior !== undefined && prior !== value) {
      throw new PerkinsAppError(
        `${sourceLabel}: key "${key}" appears twice with different values — resolve the bundle to one value per key`,
      );
    }
    seen.set(key, value);
    if (key.startsWith('installation_id_')) {
      const owner = key.slice('installation_id_'.length).toLowerCase();
      if (owner !== '') installationIds.set(owner, value);
    }
  });
  const appIdRaw = seen.get('app_id');
  if (appIdRaw === undefined || !/^[1-9][0-9]*$/u.test(appIdRaw)) {
    throw new PerkinsAppError(`${sourceLabel}: missing or invalid required entry "app_id" (expected a positive integer)`);
  }
  const keyPathRaw = seen.get('key_path');
  if (keyPathRaw === undefined || keyPathRaw === '') {
    throw new PerkinsAppError(`${sourceLabel}: missing required entry "key_path"`);
  }
  if (installationIds.size === 0) {
    throw new PerkinsAppError(
      `${sourceLabel}: no installation_id_<owner> entries — add one per reviewed repository owner (e.g. installation_id_<owner>=<installation id>)`,
    );
  }
  for (const [owner, id] of installationIds) {
    if (!/^[1-9][0-9]*$/u.test(id)) {
      throw new PerkinsAppError(`${sourceLabel}: installation id for owner "${owner}" is not a positive integer`);
    }
  }
  return {
    appId: Number(appIdRaw),
    keyPath: keyPathRaw,
    installationIds,
  };
}

interface LoadedBundle {
  readonly config: PerkinsAppBundleConfig;
  readonly privateKeyPem: string;
}

/** Read and validate the bundle at publication time (never at service
 * boot): a broken bundle fails THIS review loudly, it never bricks the
 * service. Key bytes never appear in any diagnostic. */
export function loadPerkinsAppBundle(instanceDir: string): LoadedBundle {
  const dir = perkinsAppBundleDir(instanceDir);
  const configPath = join(dir, 'config');
  const sourceLabel = 'perkins app bundle';
  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    throw new PerkinsAppError(
      `${sourceLabel}: cannot read ${errno !== undefined ? `(${errno})` : ''} the configured bundle config under the service instance dir — check the perkins bundle deployment (App publication is selected; no personal-credential fallback exists)`,
    );
  }
  const config = parsePerkinsAppConfig(text, sourceLabel);
  // The key path resolves against the trusted bundle dir, not the repo.
  const keyPath = /^\/|[A-Za-z]:[\\/]/u.test(config.keyPath) ? config.keyPath : join(dir, config.keyPath);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(keyPath);
  } catch {
    throw new PerkinsAppError(`${sourceLabel}: configured private key file is missing or inaccessible — check key_path in the bundle config`);
  }
  if (!stat.isFile()) {
    throw new PerkinsAppError(`${sourceLabel}: configured key_path is not a regular file`);
  }
  let pem: string;
  try {
    pem = readFileSync(keyPath, 'utf-8');
  } catch {
    throw new PerkinsAppError(`${sourceLabel}: cannot read the configured private key file — check file permissions`);
  }
  try {
    const keyObject = createPrivateKey({ key: pem, format: 'pem' });
    if (keyObject.asymmetricKeyType !== 'rsa') {
      throw new PerkinsAppError(`${sourceLabel}: configured private key is ${keyObject.asymmetricKeyType}, not RSA — GitHub App JWTs require RS256`);
    }
  } catch (error) {
    if (error instanceof PerkinsAppError) throw error;
    throw new PerkinsAppError(`${sourceLabel}: configured private key file is not a valid PEM private key (GitHub App keys are RSA PEM downloads)`);
  }
  return { config: { ...config, keyPath }, privateKeyPem: pem };
}

// ---------------------------------------------------------------------------
// GitHub App JWT (RS256) and installation access tokens
// ---------------------------------------------------------------------------

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

/** Mint the App JWT GitHub requires: RS256, iss = app id, ≤ 10 minutes. */
function mintAppJwt(appId: number, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1_000) - 60;
  const exp = iat + 9 * 60;
  const encoded = `${base64urlJson({ alg: 'RS256', typ: 'JWT' })}.${base64urlJson({ iat, exp, iss: String(appId) })}`;
  const signature = createSign('RSA-SHA256').update(encoded).sign(privateKeyPem, 'base64url');
  return `${encoded}.${signature}`;
}

export interface AppFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly redirect?: 'error';
  readonly signal?: AbortSignal;
}

export interface AppFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}

export type AppFetch = (input: string, init?: AppFetchInit) => Promise<AppFetchResponse>;

/** api.github.com is the ONLY host the App's credentials ever touch; every
 * request refuses redirects so a redirect can never re-target the
 * Authorization header. */
const API_ROOT = 'https://api.github.com';
const API_HEADERS = {
  'ACCEPT': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

interface TokenGrant {
  readonly token: string;
  readonly expiresAtMs: number;
}

// ---------------------------------------------------------------------------
// The poster
// ---------------------------------------------------------------------------

export interface PerkinsAppPosterOptions {
  readonly instanceDir: string;
  /** Test seam; production uses the global fetch. */
  readonly fetchImpl?: AppFetch;
  readonly now?: () => number;
  readonly gitBinary?: string;
  readonly probeTimeoutMs?: number;
  readonly postTimeoutMs?: number;
  /** Bounded reviews-list pages consulted when reconciling an ambiguous POST. */
  readonly maxReconciliationPages?: number;
}

interface ProviderReview {
  readonly id?: unknown;
  readonly user?: { readonly login?: unknown; readonly type?: unknown } | null;
  readonly body?: unknown;
  readonly state?: unknown;
  readonly commit_id?: unknown;
  readonly submitted_at?: unknown;
}

/** Provider-proved evidence that OUR App bot published exactly this review:
 * author login+type, event state, frozen head, byte-identical body. */
function isMatchingAppReview(review: ProviderReview, botLogin: string, targetSha: string, body: string): boolean {
  return review.user?.login === botLogin &&
    review.user?.type === 'Bot' &&
    review.state === 'COMMENTED' &&
    review.commit_id === targetSha &&
    review.body === body &&
    typeof review.id === 'number';
}

/** GitHub App poster: the same SHA-bound COMMENT-only delivery contract as
 * `GhPrPoster`, executed with short-lived down-scoped installation
 * credentials, an identity chain proven before the irreversible POST, and
 * bounded ambiguous-POST reconciliation that never re-posts. Serves
 * github.com ONLY — any other host fails closed rather than borrowing the
 * App's key. */
export class PerkinsAppPrPoster implements VerdictPoster {
  private readonly fetchImpl: AppFetch;
  private readonly now: () => number;
  private readonly gitBinary: string;
  private readonly probeTimeoutMs: number;
  private readonly postTimeoutMs: number;
  private readonly maxReconciliationPages: number;

  constructor(private readonly options: PerkinsAppPosterOptions) {
    this.fetchImpl = options.fetchImpl ?? ((fetch as unknown) as AppFetch);
    this.now = options.now ?? (() => Date.now());
    this.gitBinary = options.gitBinary ?? 'git';
    this.probeTimeoutMs = options.probeTimeoutMs ?? 15_000;
    this.postTimeoutMs = options.postTimeoutMs ?? 30_000;
    this.maxReconciliationPages = options.maxReconciliationPages ?? 2;
  }

  async post(input: {
    readonly prUrl: string;
    readonly host: string;
    readonly repoPath: string;
    readonly body: string;
    readonly targetSha: string;
    readonly baseSha: string;
  }): Promise<PrIdentity> {
    if (input.host !== 'github.com') {
      throw new PerkinsAppError(
        `Perkins App publication is configured, but host "${input.host}" is not github.com — the App's credentials are bound to api.github.com and are never used for other hosts; configure a host-appropriate publisher or remove the App bundle`,
      );
    }
    let url: URL;
    try {
      url = new URL(input.prUrl.trim());
    } catch {
      throw new PerkinsAppError(`cannot parse pull request URL: ${input.prUrl}`);
    }
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/u.exec(url.pathname);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
      match === null || input.host !== url.host || !/^[A-Za-z0-9.-]+(?::\d+)?$/u.test(input.host)
    ) {
      throw new PerkinsAppError(`invalid or host-mismatched GitHub pull request URL: ${input.prUrl}`);
    }
    const owner = match[1]!;
    const repo = match[2]!;
    const prNumber = match[3]!;
    const originIdentity = repoRemote(input.repoPath, this.gitBinary);
    if (
      originIdentity === null || originIdentity.host.toLowerCase() !== input.host.toLowerCase() ||
      originIdentity.owner.toLowerCase() !== owner.toLowerCase() || originIdentity.repo.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new PerkinsAppError('pull request URL does not match the reviewed repository origin');
    }

    const { config, privateKeyPem } = loadPerkinsAppBundle(this.options.instanceDir);
    const installationId = config.installationIds.get(owner.toLowerCase());
    if (installationId === undefined) {
      const owners = [...config.installationIds.keys()].sort().join(', ');
      throw new PerkinsAppError(
        `Perkins App bundle has no installation_id mapping for repository owner "${owner}" (configured owners: ${owners === '' ? 'none' : owners}) — add the mapping to the bundle config; App publication never falls back to a personal credential`,
      );
    }

    const nowMs = this.now();
    const jwt = mintAppJwt(config.appId, privateKeyPem, nowMs);
    const grant = await this.mintInstallationToken(jwt, installationId, owner, repo, nowMs);
    const botLogin = await this.verifyAppIdentity(jwt, config.appId);
    const { headSha, baseSha } = await this.verifyPullRequest(grant, owner, repo, prNumber, input.targetSha);

    let review: unknown;
    try {
      review = await this.callApi('POST review delivery', `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
        method: 'POST',
        headers: this.bearerHeaders(grant.token),
        body: JSON.stringify({ body: input.body, event: 'COMMENT', commit_id: input.targetSha }),
        signal: AbortSignal.timeout(this.postTimeoutMs),
      });
    } catch (error) {
      // A 4xx is the provider's definitive refusal — no review exists; the
      // rejection surfaces directly. Anything else (network loss after
      // send, unreadable response, 5xx) leaves the outcome genuinely
      // unknown: bounded reconciliation only — a proved match credits the
      // delivery, anything else stays an explicit failure. Never a second
      // POST.
      if (error instanceof PerkinsAppHttpError && error.status < 500) throw error;
      const reconciled = await this.reconcileAmbiguousPost(grant, owner, repo, prNumber, botLogin, input.targetSha, input.body, baseSha, error);
      return reconciled;
    }
    this.verifyReviewAuthor(review, botLogin, input.targetSha);
    return { headSha, baseSha };
  }

  private bearerHeaders(token: string): Record<string, string> {
    return { ...API_HEADERS, 'AUTHORIZATION': `Bearer ${token}`, 'CONTENT-TYPE': 'application/json' };
  }

  private async callApi(label: string, url: string, init: AppFetchInit): Promise<unknown> {
    let response: AppFetchResponse;
    try {
      response = await this.fetchImpl(url, { redirect: 'error', ...init });
    } catch (error) {
      if (init.method === 'POST' && url.endsWith('/reviews')) throw error;
      throw new PerkinsAppError(`${label} request failed: ${error instanceof Error ? sanitize(error.message) : 'network error'}`);
    }
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      if (init.method === 'POST' && url.endsWith('/reviews')) throw error;
      throw new PerkinsAppError(`${label} response could not be read: ${error instanceof Error ? sanitize(error.message) : 'unreadable body'}`);
    }
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        throw new PerkinsAppError(`${label} response (HTTP ${response.status}) was not valid JSON: ${sanitize(text)}`);
      }
    }
    if (!response.ok) {
      throw new PerkinsAppHttpError(label, response.status, body, text);
    }
    return body;
  }

  private async mintInstallationToken(
    jwt: string,
    installationId: string,
    owner: string,
    repo: string,
    nowMs: number,
  ): Promise<TokenGrant> {
    let body: unknown;
    try {
      body = await this.callApi('installation token', `${API_ROOT}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: { ...API_HEADERS, 'AUTHORIZATION': `Bearer ${jwt}`, 'CONTENT-TYPE': 'application/json' },
        // Least scope: this one repository, only the permission review
        // publication needs. Requesting a subset never widens the grant.
        body: JSON.stringify({
          repositories: [repo],
          permissions: { 'pull_requests': 'write', 'metadata': 'read' },
        }),
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
    } catch (error) {
      if (error instanceof PerkinsAppHttpError) {
        if (error.status === 401) {
          throw new PerkinsAppError('installation token mint returned HTTP 401 — the App JWT was rejected (check the bundle app_id and private key); review not delivered');
        }
        if (error.status === 403) {
          throw new PerkinsAppError(`installation token mint returned HTTP 403 — the installation may be suspended or the App forbidden: ${error.providerMessage}`);
        }
        if (error.status === 404) {
          throw new PerkinsAppError('installation token mint returned HTTP 404 — the configured installation id does not belong to the configured App (check app_id and installation_id mappings); review not delivered');
        }
      }
      throw error;
    }
    const parsed = body as { token?: unknown; expires_at?: unknown; permissions?: Record<string, unknown>; repositories?: unknown } | null;
    const token = parsed?.token;
    if (typeof token !== 'string' || token === '') {
      throw new PerkinsAppError('installation token response did not contain a token — review not delivered');
    }
    const expiresAt = typeof parsed?.expires_at === 'string' ? Date.parse(parsed.expires_at) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs + 30_000) {
      throw new PerkinsAppError('installation token is already expired or expires too soon — review not delivered');
    }
    const granted = parsed?.permissions?.['pull_requests'];
    if (granted !== 'write') {
      throw new PerkinsAppError(
        `installation token does not carry pull_requests:write (granted: ${sanitize(String(granted))}) — the installation must grant the App pull-request write access; review not delivered`,
      );
    }
    const repositories = Array.isArray(parsed?.repositories) ? parsed!.repositories as ReadonlyArray<{ full_name?: unknown }> : [];
    const covered = repositories.some(
      (entry) => typeof entry?.full_name === 'string' && entry.full_name.toLowerCase() === `${owner}/${repo}`.toLowerCase(),
    );
    if (!covered) {
      throw new PerkinsAppError(
        `the installation does not cover repository ${owner}/${repo} — add the repository to the Perkins App installation; review not delivered`,
      );
    }
    return { token, expiresAtMs: expiresAt };
  }

  private async verifyAppIdentity(jwt: string, expectedAppId: number): Promise<string> {
    const body = await this.callApi('App identity', `${API_ROOT}/app`, {
      headers: { ...API_HEADERS, 'AUTHORIZATION': `Bearer ${jwt}` },
      signal: AbortSignal.timeout(this.probeTimeoutMs),
    });
    const parsed = body as { id?: unknown; slug?: unknown } | null;
    if (parsed?.id !== expectedAppId) {
      throw new PerkinsAppError(
        `App identity mismatch: api.github.com authenticated App id ${sanitize(String(parsed?.id))}, expected ${expectedAppId} — refusing to publish under an unexpected App`,
      );
    }
    if (typeof parsed?.slug !== 'string' || parsed.slug === '' || /[^\w-]/u.test(parsed.slug)) {
      throw new PerkinsAppError('App identity response did not contain a usable slug — cannot derive the expected bot identity; review not delivered');
    }
    return `${parsed.slug}[bot]`;
  }

  private async verifyPullRequest(
    grant: TokenGrant,
    owner: string,
    repo: string,
    prNumber: string,
    targetSha: string,
  ): Promise<PrIdentity> {
    const body = await this.callApi('pull request identity', `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers: this.bearerHeaders(grant.token),
      signal: AbortSignal.timeout(this.probeTimeoutMs),
    });
    const parsed = body as { head?: { sha?: unknown }; base?: { sha?: unknown } } | null;
    const headSha = typeof parsed?.head?.sha === 'string' ? parsed.head.sha : '';
    const baseSha = typeof parsed?.base?.sha === 'string' ? parsed.base.sha : '';
    // Only HEAD equality gates delivery; the PR's recorded base is expected
    // to trail the frozen base as main moves (same rule as GhPrPoster).
    if (headSha !== targetSha) {
      throw new PerkinsAppError(
        `pull request identity moved before delivery (expected head ${targetSha}, got ${headSha || 'unknown'})`,
      );
    }
    return { headSha, baseSha };
  }

  private verifyReviewAuthor(review: unknown, botLogin: string, targetSha: string): void {
    const parsed = review as { user?: { login?: unknown; type?: unknown }; commit_id?: unknown } | null;
    if (parsed?.user?.login !== botLogin || parsed?.user?.type !== 'Bot') {
      throw new PerkinsAppError(
        `review publication identity mismatch: response author is ${sanitize(String(parsed?.user?.login))} (${sanitize(String(parsed?.user?.type))}), expected the verified App bot ${botLogin} — delivery identity is unproven`,
      );
    }
    if (parsed?.commit_id !== targetSha) {
      throw new PerkinsAppError(
        `review publication receipt mismatch: provider committed to ${sanitize(String(parsed?.commit_id))}, expected ${targetSha}`,
      );
    }
  }

  /** Bounded ambiguous-POST reconciliation: consult a bounded window of the
   * provider's review list for OUR bot's byte-identical COMMENT review on
   * the exact frozen head. A proved match is the delivery receipt; an
   * exhausted lookup, a lookup error, or a foreign author with the same
   * bytes is NEVER absence — the delivery stays explicitly unproven. */
  private async reconcileAmbiguousPost(
    grant: TokenGrant,
    owner: string,
    repo: string,
    prNumber: string,
    botLogin: string,
    targetSha: string,
    body: string,
    baseSha: string,
    cause: unknown,
  ): Promise<PrIdentity> {
    for (let page = 1; page <= this.maxReconciliationPages; page += 1) {
      const list = await this.callApi(
        'review reconciliation',
        `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
        { headers: this.bearerHeaders(grant.token), signal: AbortSignal.timeout(this.probeTimeoutMs) },
      );
      const reviews = Array.isArray(list) ? list as readonly ProviderReview[] : [];
      const match = reviews.find((review) => isMatchingAppReview(review, botLogin, targetSha, body));
      if (match !== undefined) {
        return { headSha: targetSha, baseSha };
      }
      if (reviews.length < 100) break;
    }
    throw new PerkinsAppError(
      `review POST outcome is ambiguous (${cause instanceof Error ? sanitize(cause.message) : 'network error'}) and no provider-proved matching App review was found in the bounded lookup — delivery stays unproven; the review was NOT re-posted. Resolve the pull request manually before retrying.`,
    );
  }
}

/** HTTP-level provider rejection with a sanitized provider message. */
export class PerkinsAppHttpError extends PerkinsAppError {
  readonly providerMessage: string;

  constructor(label: string, readonly status: number, body: unknown, text: string) {
    const providerBody = body as { readonly message?: unknown } | null;
    let providerMessage = sanitize(typeof providerBody?.message === 'string' ? providerBody.message : text);
    if (providerMessage === '') providerMessage = 'no provider message';
    super(`${label} exited HTTP ${status}: ${providerMessage}`);
    this.name = 'PerkinsAppHttpError';
    this.providerMessage = providerMessage;
  }
}

/** Startup selection: an existing App bundle routes github.com publication
 * through the App poster; deployments with no bundle keep the legacy `gh`
 * poster and its behavior byte-for-byte. GitLab routing is untouched. */
export function createGithubVerdictPoster(
  instanceDir: string,
  options?: Omit<PerkinsAppPosterOptions, 'instanceDir'>,
): VerdictPoster {
  return perkinsAppBundleConfigured(instanceDir)
    ? new PerkinsAppPrPoster({ instanceDir, ...options })
    : new GhPrPoster();
}
