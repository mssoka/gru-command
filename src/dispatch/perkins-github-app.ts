import { createPrivateKey, createSign } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrIdentity, VerdictPoster } from './perkins.js';
import { AutoVerdictPoster, GhPrPoster } from './perkins.js';
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
 * for github.com; absence keeps the legacy `gh` poster exactly as-is.
 * ANY successful lstat — regular file, symlink (even dangling), directory,
 * anything else — counts as present, and so does any lstat error other than
 * a definitive ENOENT (a dangling perkins-dir symlink is detected and also
 * counts): selection must never silently degrade App mode to a personal
 * credential; a broken bundle fails loudly at publication time instead. */
export function perkinsAppBundleConfigured(instanceDir: string): boolean {
  const configPath = join(perkinsAppBundleDir(instanceDir), 'config');
  try {
    lstatSync(configPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    // ENOENT can mean a dangling perkins-dir symlink rather than genuine
    // absence — that is a broken bundle, not a missing one.
    try {
      return lstatSync(perkinsAppBundleDir(instanceDir)).isSymbolicLink();
    } catch {
      return false;
    }
  }
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
    // The bundle contract is closed: a key outside it is a provisioning
    // misspelling, and silently ignoring it would take effect as a partial
    // config. Name the line instead.
    if (key !== 'app_id' && key !== 'key_path' && !key.startsWith('installation_id_')) {
      throw new PerkinsAppError(
        `${sourceLabel}: line ${index + 1} has an unrecognized key "${key}" — the bundle accepts app_id, key_path and installation_id_<owner> entries only`,
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
      if (owner === '') {
        throw new PerkinsAppError(
          `${sourceLabel}: installation_id_ entry has no owner — expected installation_id_<owner>=<installation id>`,
        );
      }
      // Owner lookup lowercases, so case-variant keys collide here too:
      // two different ids for one owner is a bundle conflict, never a
      // silent last-one-wins.
      const priorOwner = installationIds.get(owner);
      if (priorOwner !== undefined && priorOwner !== value) {
        throw new PerkinsAppError(
          `${sourceLabel}: installation owner "${owner}" is configured twice with different values — resolve the bundle to one id per owner`,
        );
      }
      installationIds.set(owner, value);
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

/** The bundle directory must mirror the credential-store rules: an
 * owner-owned 0700 directory (never a symlink) so no other local uid can
 * swap the bundle files underneath the file checks. */
function bundleDirSafe(dir: string, sourceLabel: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(dir);
  } catch {
    throw new PerkinsAppError(`${sourceLabel}: bundle directory is missing or inaccessible — check the perkins bundle deployment`);
  }
  if (info.isSymbolicLink()) {
    throw new PerkinsAppError(`${sourceLabel}: bundle directory is a symbolic link — the bundle must live in a real directory so its permissions are the App credential's own`);
  }
  if (!info.isDirectory()) {
    throw new PerkinsAppError(`${sourceLabel}: bundle path is not a directory — check the perkins bundle deployment`);
  }
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      throw new PerkinsAppError(`${sourceLabel}: bundle directory is owned by another user — the App credential must be owned by the service user`);
    }
    if ((info.mode & 0o777) !== 0o700) {
      throw new PerkinsAppError(
        `${sourceLabel}: bundle directory must have mode 0700 (found ${(info.mode & 0o777).toString(8).padStart(3, '0')}) — another local user could otherwise replace the bundle files`,
      );
    }
  }
}

/** Read one bundle credential file with its safety checks bound to the
 * same inode (open with O_NOFOLLOW, then fstat the open descriptor): a
 * regular file, owned by the service user on unix, readable by the owner
 * and by nobody else, with no setuid/setgid/sticky bits. Fail-closed with
 * an actionable message carrying the errno where one exists. */
function readBundleFileChecked(path: string, label: string, sourceLabel: string): string {
  // lstat pre-check: rejects symlinks on EVERY platform (O_NOFOLLOW is not
  // available on win32) and carries the errno for missing paths.
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new PerkinsAppError(`${sourceLabel}: ${label} is a symbolic link — bundle files must be regular files so their permissions are the App credential's own`);
    }
  } catch (error) {
    if (error instanceof PerkinsAppError) throw error;
    const errno = (error as NodeJS.ErrnoException).code;
    throw new PerkinsAppError(
      `${sourceLabel}: ${label} is missing or inaccessible${errno !== undefined ? ` (${errno})` : ''} — check the perkins bundle deployment`,
    );
  }
  let fd: number;
  try {
    // O_NONBLOCK so a FIFO named at the path cannot hold the round hostage:
    // the open returns and the fstat below rejects the non-regular file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ELOOP') {
      throw new PerkinsAppError(`${sourceLabel}: ${label} is a symbolic link — bundle files must be regular files so their permissions are the App credential's own`);
    }
    throw new PerkinsAppError(
      `${sourceLabel}: ${label} is missing or inaccessible${errno !== undefined ? ` (${errno})` : ''} — check the perkins bundle deployment`,
    );
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new PerkinsAppError(`${sourceLabel}: ${label} is not a regular file`);
    }
    if (process.platform !== 'win32') {
      const uid = process.getuid?.();
      if (uid !== undefined && info.uid !== uid) {
        throw new PerkinsAppError(`${sourceLabel}: ${label} is owned by another user — the App credential must be owned by the service user`);
      }
      const mode = info.mode & 0o777;
      if ((info.mode & 0o7000) !== 0 || (mode & 0o077) !== 0 || (mode & 0o400) === 0) {
        throw new PerkinsAppError(
          `${sourceLabel}: ${label} must be owner-only and owner-readable (0600 recommended; found ${mode.toString(8).padStart(3, '0')}) — tighten the file mode; App publication is selected and no personal-credential fallback exists`,
        );
      }
    }
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

/** Read and validate the bundle at publication time (never at service
 * boot): a broken bundle fails THIS review loudly, it never bricks the
 * service. Key bytes never appear in any diagnostic. */
export function loadPerkinsAppBundle(instanceDir: string): LoadedBundle {
  const dir = perkinsAppBundleDir(instanceDir);
  const configPath = join(dir, 'config');
  const sourceLabel = 'perkins app bundle';
  bundleDirSafe(dir, sourceLabel);
  const text = readBundleFileChecked(configPath, 'bundle config', sourceLabel);
  const config = parsePerkinsAppConfig(text, sourceLabel);
  // The key path resolves against the trusted bundle dir, not the repo.
  // An absolute key_path is permitted (the deployed bundle may keep the
  // key outside the bundle dir); that file passes the same file-level
  // safety checks, and the bundle dir remains the audit boundary for the
  // config that names it.
  const keyPath = /^\/|[A-Za-z]:[\\/]/u.test(config.keyPath) ? config.keyPath : join(dir, config.keyPath);
  const pem = readBundleFileChecked(keyPath, 'configured private key file', sourceLabel);
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
  /** Production fetch supplies a `Headers` instance; test doubles may
   * supply a plain record. Both are supported. */
  readonly headers?: Headers | Readonly<Record<string, string>>;
  readonly text: () => Promise<string>;
}

export type AppFetch = (input: string, init?: AppFetchInit) => Promise<AppFetchResponse>;

/** Provider bodies are JSON when parseable; anything else surfaces as raw
 * (sanitized) text so a non-JSON refusal still carries its status. */
function parseJsonBestEffort(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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

/** Provider-proved evidence that OUR App bot published exactly this review
 * during this round: author login+type, event state, frozen head,
 * byte-identical body, and a submission time inside the round's window —
 * an older round's identical bytes are never credited as this delivery. */
function isMatchingAppReview(review: ProviderReview, botLogin: string, targetSha: string, body: string, notBeforeMs: number): boolean {
  const submittedAt = typeof review.submitted_at === 'string' ? Date.parse(review.submitted_at) : Number.NaN;
  return review.user?.login === botLogin &&
    review.user?.type === 'Bot' &&
    review.state === 'COMMENTED' &&
    review.commit_id === targetSha &&
    review.body === body &&
    typeof review.id === 'number' &&
    Number.isFinite(submittedAt) &&
    submittedAt >= notBeforeMs;
}

/** GitHub error bodies/markers that mean rate limiting, not permission. */
function providerIndicatesRateLimit(error: PerkinsAppHttpError): boolean {
  const documentationUrl = (error.body as { readonly documentation_url?: unknown } | null)?.documentation_url;
  return (typeof documentationUrl === 'string' && /rate-limit|abuse/u.test(documentationUrl)) ||
    /rate limit|abuse/iu.test(error.providerMessage);
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
    // Three pages: page 1 (Link discovery) + the jump to the newest page +
    // one decrement, so the default window can prove a delivery even when
    // newer reviews pushed ours off the newest page.
    this.maxReconciliationPages = options.maxReconciliationPages ?? 3;
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
        `Perkins App publication is configured, but host "${input.host}" is not github.com — the App's credentials are bound to api.github.com and are never used for other hosts; github.com is the only GitHub host supported while the bundle is installed. Remove the App bundle to restore the legacy publisher for this host, or escalate an explicit publisher decision`,
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
      match === null || input.host !== url.host || !/^[A-Za-z0-9.-]+$/u.test(input.host)
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

    const postStartMs = this.now();
    let review: unknown;
    try {
      review = (await this.callApi('POST review delivery', `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
        method: 'POST',
        headers: this.bearerHeaders(grant.token),
        body: JSON.stringify({ body: input.body, event: 'COMMENT', commit_id: input.targetSha }),
        signal: AbortSignal.timeout(this.postTimeoutMs),
      })).body;
    } catch (error) {
      // Only a 4xx is the provider's definitive refusal — no review exists;
      // the rejection surfaces directly (a rate-limit refusal says so by
      // name). Anything else (a 3xx that slipped past redirect refusal,
      // network loss after send, an unreadable response, 5xx) leaves the
      // outcome genuinely unknown: bounded reconciliation only — a proved
      // match credits the delivery, anything else stays an explicit
      // failure. Never a second POST.
      if (error instanceof PerkinsAppHttpError && error.status >= 400 && error.status < 500) {
        if ((error.status === 403 || error.status === 429) && providerIndicatesRateLimit(error)) {
          throw new PerkinsAppError(
            `review POST refused with HTTP ${error.status} — GitHub rate limiting (${error.providerMessage}); the provider created no review; wait for the window to reset before the next round — no retry was attempted`,
          );
        }
        throw error;
      }
      const reconciled = await this.reconcileAmbiguousPost(grant, owner, repo, prNumber, botLogin, input.targetSha, input.body, baseSha, error, postStartMs);
      return reconciled;
    }
    try {
      this.verifyReviewAuthor(review, botLogin, input.targetSha);
    } catch (error) {
      // A 2xx whose receipt cannot be proved (foreign author, wrong commit,
      // an unreadable body) leaves the delivery identity ambiguous — the
      // same bounded reconciliation decides it, never a blind retry.
      return await this.reconcileAmbiguousPost(grant, owner, repo, prNumber, botLogin, input.targetSha, input.body, baseSha, error, postStartMs);
    }
    return { headSha, baseSha };
  }

  private bearerHeaders(token: string): Record<string, string> {
    return { ...API_HEADERS, 'AUTHORIZATION': `Bearer ${token}`, 'CONTENT-TYPE': 'application/json' };
  }

  private async callApi(label: string, url: string, init: AppFetchInit): Promise<{ readonly body: unknown; readonly header: (name: string) => string | null }> {
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
    const rawHeaders = response.headers ?? {};
    // Production fetch returns a `Headers` instance (no own enumerable
    // entries); the test double supplies a plain record. Support both.
    const header = (name: string): string | null => {
      if (typeof (rawHeaders as Headers).get === 'function') return (rawHeaders as Headers).get(name);
      const lowered = name.toLowerCase();
      for (const [key, value] of Object.entries(rawHeaders as Readonly<Record<string, string>>)) {
        if (key.toLowerCase() === lowered) return value;
      }
      return null;
    };
    // The provider's status is authoritative even when the body is not
    // JSON: a proxy's HTML refusal is still a definitive refusal with a
    // status, never a JSON-parse error that hides it.
    if (!response.ok) {
      throw new PerkinsAppHttpError(label, response.status, parseJsonBestEffort(text), text);
    }
    if (text === '') return { body: null, header };
    try {
      return { body: JSON.parse(text), header };
    } catch {
      throw new PerkinsAppError(`${label} response (HTTP ${response.status}) was not valid JSON: ${sanitize(text)}`);
    }
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
      ({ body } = await this.callApi('installation token', `${API_ROOT}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: { ...API_HEADERS, 'AUTHORIZATION': `Bearer ${jwt}`, 'CONTENT-TYPE': 'application/json' },
        // Least scope: this one repository, only the permission review
        // publication needs. Requesting a subset never widens the grant.
        body: JSON.stringify({
          repositories: [repo],
          permissions: { 'pull_requests': 'write', 'metadata': 'read' },
        }),
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      }));
    } catch (error) {
      if (error instanceof PerkinsAppHttpError) {
        if (error.status === 401) {
          throw new PerkinsAppError('installation token mint returned HTTP 401 — the App JWT was rejected (check the bundle app_id and private key); review not delivered');
        }
        if (error.status === 403 || error.status === 429) {
          if (providerIndicatesRateLimit(error)) {
            throw new PerkinsAppError(
              `installation token mint returned HTTP ${error.status} — GitHub rate limiting, primary or secondary (${error.providerMessage}); wait for the window to reset before the next round; review not delivered`,
            );
          }
          if (error.status === 429) {
            throw new PerkinsAppError(`installation token mint returned HTTP 429 — ${error.providerMessage}; review not delivered`);
          }
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
    const { body } = await this.callApi('App identity', `${API_ROOT}/app`, {
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
    const { body } = await this.callApi('pull request identity', `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}`, {
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
    const parsed = review as { id?: unknown; user?: { login?: unknown; type?: unknown }; commit_id?: unknown } | null;
    const reviewId = typeof parsed?.id === 'number' ? String(parsed.id) : 'unknown';
    const loginText = typeof parsed?.user?.login === 'string' ? parsed.user.login : '<absent>';
    const typeText = typeof parsed?.user?.type === 'string' ? parsed.user.type : '<absent>';
    if (parsed?.user?.login !== botLogin || parsed?.user?.type !== 'Bot') {
      throw new PerkinsAppError(
        `review publication identity mismatch: provider review ${reviewId} is authored by ${sanitize(loginText)} (${sanitize(typeText)}), expected the verified App bot ${botLogin} — delivery identity is unproven`,
      );
    }
    if (parsed?.commit_id !== targetSha) {
      throw new PerkinsAppError(
        `review publication receipt mismatch: provider review ${reviewId} committed to ${sanitize(String(parsed?.commit_id))}, expected ${targetSha}`,
      );
    }
  }

  /** Parse the last page number out of a GitHub Link header, if present. */
  private parseLastPage(linkHeader: string | null): number | null {
    if (linkHeader === null) return null;
    const last = /<([^>]+)>;\s*rel="last"/u.exec(linkHeader);
    if (last === null) return null;
    const page = /[?&]page=(\d+)/u.exec(last[1]!);
    return page === null ? null : Number(page[1]);
  }

  /** Bounded ambiguous-POST reconciliation: consult a bounded window of the
   * provider's review list for OUR bot's byte-identical COMMENT review on
   * the exact frozen head, submitted at or after this round's POST. GitHub
   * lists reviews oldest-first and the review being reconciled is the
   * newest, so once the Link header reveals the last page the window jumps
   * there and then walks backward (without a Link header the walk stays
   * sequential). A proved match is the delivery receipt; an exhausted
   * lookup, a failing or malformed lookup, or a foreign author with the
   * same bytes is NEVER absence — the delivery stays explicitly unproven. */
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
    postStartMs: number,
  ): Promise<PrIdentity> {
    const causeText = cause instanceof Error ? sanitize(cause.message) : 'network error';
    const unproven = (what: string): PerkinsAppError => new PerkinsAppError(
      `review POST outcome is ambiguous (${causeText}) and ${what} — delivery stays unproven; the review was NOT re-posted. Resolve the pull request manually before retrying (expected author ${botLogin} on head ${targetSha}; the round's publication body is in the review artifact report).`,
    );
    // Skew margin only: the review this round may have created was submitted
    // after the POST began; anything older is another round's bytes.
    const notBeforeMs = postStartMs - 60_000;
    const visited = new Set<number>();
    let lastPage: number | null = null;
    let page = 1;
    for (let fetched = 0; fetched < this.maxReconciliationPages; fetched += 1) {
      visited.add(page);
      let list: unknown;
      let linkHeader: string | null = null;
      try {
        const result = await this.callApi(
          'review reconciliation',
          `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
          { headers: this.bearerHeaders(grant.token), signal: AbortSignal.timeout(this.probeTimeoutMs) },
        );
        list = result.body;
        linkHeader = result.header('link');
      } catch (lookupError) {
        // A failing lookup is NEVER absence — the ambiguity stands, stated
        // explicitly so nobody concludes "nothing was delivered" and
        // re-posts.
        throw unproven(
          `the bounded proof lookup itself failed (${lookupError instanceof Error ? sanitize(lookupError.message) : 'lookup error'})`,
        );
      }
      if (lastPage === null) lastPage = this.parseLastPage(linkHeader);
      if (!Array.isArray(list)) {
        // Never report "searched and not found" when no usable list was read.
        throw unproven('the bounded proof lookup returned a malformed list body');
      }
      const reviews = list as readonly ProviderReview[];
      const match = reviews.find((review) => isMatchingAppReview(review, botLogin, targetSha, body, notBeforeMs));
      if (match !== undefined) {
        return { headSha: targetSha, baseSha };
      }
      if (reviews.length === 0) break;
      let next: number;
      if (lastPage !== null) {
        // Jump to the newest page first, then walk backward through it.
        next = page < lastPage ? lastPage : page - 1;
      } else {
        // No Link header: the classic short-page end-of-list heuristic.
        if (reviews.length < 100) break;
        next = page + 1;
      }
      if (next < 1 || visited.has(next)) break;
      page = next;
    }
    throw unproven('no provider-proved matching App review was found in the bounded lookup');
  }
}

/** HTTP-level provider rejection with a sanitized provider message. */
export class PerkinsAppHttpError extends PerkinsAppError {
  readonly providerMessage: string;

  constructor(label: string, readonly status: number, readonly body: unknown, text: string) {
    const providerBody = body as { readonly message?: unknown } | null;
    let providerMessage = sanitize(typeof providerBody?.message === 'string' ? providerBody.message : text);
    if (providerMessage === '') providerMessage = 'no provider message';
    super(`${label} exited HTTP ${status}: ${providerMessage}`);
    this.name = 'PerkinsAppHttpError';
    this.providerMessage = providerMessage;
  }
}

/** Options for the startup factories. `githubPosterOverride` is a TEST
 * seam: it replaces the selected github.com leg so the composite's
 * routing can be exercised without a real `gh` binary. */
export interface StartupPosterOptions extends Omit<PerkinsAppPosterOptions, 'instanceDir'> {
  readonly githubPosterOverride?: VerdictPoster;
}

/** Startup selection: an existing App bundle routes github.com publication
 * through the App poster; deployments with no bundle keep the legacy `gh`
 * poster and its behavior byte-for-byte. GitLab routing is untouched. */
export function createGithubVerdictPoster(
  instanceDir: string,
  options?: StartupPosterOptions,
): VerdictPoster {
  const { githubPosterOverride, ...appOptions } = options ?? {};
  if (githubPosterOverride !== undefined) return githubPosterOverride;
  return perkinsAppBundleConfigured(instanceDir)
    ? new PerkinsAppPrPoster({ instanceDir, ...appOptions })
    : new GhPrPoster();
}

/** The one seam `main()` wires: the auto host router with the App-selected
 * github.com leg. Takes the CONFIG OBJECT (any `{ instanceDir }`), not a
 * bare path, so the property selection itself lives inside this tested
 * unit — a wrong-property or dropped-call edit at the wiring site fails
 * the selection tests instead of silently restoring the personal poster. */
export function createStartupVerdictPoster(
  config: { readonly instanceDir: string },
  options?: StartupPosterOptions,
): AutoVerdictPoster {
  return new AutoVerdictPoster(createGithubVerdictPoster(config.instanceDir, options));
}
