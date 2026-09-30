import { createHash, createPrivateKey, createSign } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { PostedReviewReceipt, PrIdentity, VerdictPoster, VerdictPosterInput } from './perkins.js';
import { AutoVerdictPoster, GhPrPoster, verifyPostedReceipt } from './perkins.js';
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
 * counts, and a racing unreadable stat must never be mistaken for absence):
 * selection must never silently degrade App mode to a personal credential;
 * a broken bundle fails loudly at publication time instead. */
export function perkinsAppBundleConfigured(instanceDir: string): boolean {
  const configPath = join(perkinsAppBundleDir(instanceDir), 'config');
  try {
    lstatSync(configPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    // ENOENT can mean a dangling perkins-dir symlink rather than genuine
    // absence — that is a broken bundle, not a missing one. Only a
    // definitive ENOENT on the directory itself is absence; any other
    // stat failure (EACCES, ELOOP, a race) stays fail-closed as present.
    try {
      return lstatSync(perkinsAppBundleDir(instanceDir)).isSymbolicLink();
    } catch (dirError) {
      return (dirError as NodeJS.ErrnoException).code !== 'ENOENT';
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

/** Resolve the configured key_path to an absolute path. Absolute POSIX
 * paths, Windows drive paths and Windows UNC paths (`\\server\share\...`)
 * are used as written; anything else — including `..` segments — resolves
 * against the trusted bundle dir, never the CWD or a repository. Exported
 * so the resolution rule itself is directly testable. */
export function resolvePerkinsAppKeyPath(bundleDir: string, keyPath: string): string {
  return /^\\|^\/|[A-Za-z]:[\\/]/u.test(keyPath) ? keyPath : join(bundleDir, keyPath);
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
    // A credential file is a few KB; anything orders of magnitude larger is
    // not a bundle file, and buffering it would stall the round.
    if (info.size > 1_048_576) {
      throw new PerkinsAppError(`${sourceLabel}: ${label} is implausibly large (${info.size} bytes) for a credential file — check the perkins bundle deployment`);
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
  const keyPath = resolvePerkinsAppKeyPath(dir, config.keyPath);
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

/** Same body digest the provider receipts bind to (sha256, UTF-8). */
function receiptDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
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
  /** Root holding `perkins/`: the service instance dir, or the data dir
   * when the startup factory resolved the bundle there (relocated
   * deployments). See resolvePerkinsAppBundleRoot. */
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

/** Provider review ids: safe integers, or a provider-quoted non-empty
 * string (the legacy receipts accept both); anything else is unusable and
 * must fail closed rather than being stringified into a receipt. */
function usableProviderReviewId(id: unknown): string | null {
  if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
  if (typeof id === 'string' && id.trim() !== '' && id.length <= 200) return id;
  return null;
}

/** Provider-proved evidence that OUR App bot published exactly this review
 * during this round: author login+type, event state, frozen head,
 * byte-identical body, and a submission time inside the round's window —
 * an older round's identical bytes are never credited as this delivery. */
function isMatchingAppReview(review: ProviderReview, botLogin: string, targetSha: string, body: string, notBeforeMs: number | null): boolean {
  const base = review.user?.login === botLogin &&
    review.user?.type === 'Bot' &&
    review.state === 'COMMENTED' &&
    review.commit_id === targetSha &&
    review.body === body &&
    usableProviderReviewId(review.id) !== null;
  if (!base) return false;
  // With a recency bound (the ambiguous-POST path), only submissions from
  // this round's window count; null (the idempotent recovery seam) matches
  // any identical publication.
  if (notBeforeMs === null) return true;
  const submittedAt = typeof review.submitted_at === 'string' ? Date.parse(review.submitted_at) : Number.NaN;
  return Number.isFinite(submittedAt) && submittedAt >= notBeforeMs;
}

/** GitHub error bodies/markers that mean rate limiting, not permission. */
function providerIndicatesRateLimit(error: PerkinsAppHttpError): boolean {
  const documentationUrl = (error.body as { readonly documentation_url?: unknown } | null)?.documentation_url;
  return (typeof documentationUrl === 'string' && /rate-limit|abuse/u.test(documentationUrl)) ||
    /rate limit|abuse/iu.test(error.providerMessage);
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
    // Bounded like the shared receipt contract: up to ten review-list pages
    // (the jump-to-last walk normally resolves in two or three fetches; the
    // extra headroom is for the idempotent recovery lookup on busy PRs,
    // which may search deeper than the in-round ambiguous-POST case).
    this.maxReconciliationPages = options.maxReconciliationPages ?? 10;
  }

  async post(input: VerdictPosterInput): Promise<PostedReviewReceipt> {
    const { grant, botLogin, owner, repo, prNumber, headSha, baseSha } = await this.prepare(input);
    const postStartMs = this.now();
    let review: unknown;
    try {
      review = (await this.callApi('POST review delivery', `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
        method: 'POST',
        headers: this.bearerHeaders(grant.token),
        body: JSON.stringify({ body: input.body, event: 'COMMENT', commit_id: input.targetSha }),
        signal: AbortSignal.timeout(this.postTimeoutMs),
      }, { ambiguousOutcome: true })).body;
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
      return await this.reconcileAmbiguousPost(grant, owner, repo, prNumber, botLogin, input.targetSha, input.body, baseSha, error, postStartMs);
    }
    try {
      return verifyPostedReceipt(
        this.receiptFromReview(review, botLogin, input.targetSha, headSha, baseSha, input.body),
        { targetSha: input.targetSha, bodySha256: receiptDigest(input.body) },
      );
    } catch (error) {
      if (error instanceof PerkinsAppError) {
        // A 2xx whose receipt cannot be proved (foreign author, enacted
        // event, wrong commit, mismatched or unreadable body) leaves the
        // delivery identity ambiguous — the same bounded reconciliation
        // decides it, never a blind retry.
        return await this.reconcileAmbiguousPost(grant, owner, repo, prNumber, botLogin, input.targetSha, input.body, baseSha, error, postStartMs);
      }
      throw error;
    }
  }

  /** Idempotent recovery lookup (the VerdictPoster seam): find an
   * already-published App review for this exact head whose body digest
   * matches — read-only, never creates anything. `null` is returned ONLY
   * when the bounded walk provably covered the whole review list; an
   * exhausted window without that proof is an UNRESOLVED error, never
   * proof of absence. */
  async reconcile(input: VerdictPosterInput): Promise<PostedReviewReceipt | null> {
    const { grant, botLogin, owner, repo, prNumber, baseSha } = await this.prepare(input);
    const { matched, provablyAbsent } = await this.lookupMatchingReview(grant, owner, repo, prNumber, botLogin, input.targetSha, input.body, null);
    if (matched !== null) {
      return verifyPostedReceipt(
        this.receiptFromReview(matched, botLogin, input.targetSha, input.targetSha, baseSha, input.body),
        { targetSha: input.targetSha, bodySha256: receiptDigest(input.body) },
      );
    }
    if (provablyAbsent) return null;
    throw new PerkinsAppError(
      `review reconciliation exceeded its ${this.maxReconciliationPages}-page lookup bound without exhausting the review list; delivery stays unresolved — verify manually before any retry, never assume absence`,
    );
  }

  /** The shared pre-delivery chain (both post and reconcile are held to
   * the same standard): host binding, URL/origin validation, bundle load,
   * owner installation mapping, least-scope token mint, App identity
   * proof, and the live PR head check. */
  private async prepare(input: VerdictPosterInput): Promise<{
    readonly grant: TokenGrant;
    readonly botLogin: string;
    readonly owner: string;
    readonly repo: string;
    readonly prNumber: string;
    readonly headSha: string;
    readonly baseSha: string;
  }> {
    if (input.host !== 'github.com') {
      throw new PerkinsAppError(
        `Perkins App publication is configured, but host "${input.host}" is not github.com — the App's credentials are bound to api.github.com and are never used for other hosts; github.com is the only GitHub host supported while the bundle is installed. Remove the App bundle to restore the legacy publisher for this host, or escalate an explicit publisher decision`,
      );
    }
    let url: URL;
    try {
      url = new URL(input.prUrl.trim());
    } catch {
      // A malformed URL can carry credential-shaped bytes; sanitize it the
      // same way provider text is sanitized before it reaches the record.
      throw new PerkinsAppError(`cannot parse pull request URL: ${sanitize(input.prUrl)}`);
    }
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/u.exec(url.pathname);
    if (
      url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
      match === null || input.host !== url.host || !/^[A-Za-z0-9.-]+$/u.test(input.host)
    ) {
      throw new PerkinsAppError(`invalid or host-mismatched GitHub pull request URL: ${sanitize(input.prUrl)}`);
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
    return { grant, botLogin, owner, repo, prNumber, headSha, baseSha };
  }

  private bearerHeaders(token: string): Record<string, string> {
    return { ...API_HEADERS, 'AUTHORIZATION': `Bearer ${token}`, 'CONTENT-TYPE': 'application/json' };
  }

  private async callApi(
    label: string,
    url: string,
    init: AppFetchInit,
    seam: { readonly ambiguousOutcome?: boolean } = {},
  ): Promise<{ readonly body: unknown; readonly header: (name: string) => string | null }> {
    let response: AppFetchResponse;
    try {
      response = await this.fetchImpl(url, { redirect: 'error', ...init });
    } catch (error) {
      // A delivery-POST failure must stay unclassified so post() can treat
      // the outcome as unknown and reconcile against provider evidence;
      // every other request failure is a definite setup/lookup failure and
      // gets the named wrapper.
      if (seam.ambiguousOutcome === true) throw error;
      throw new PerkinsAppError(`${label} request failed: ${error instanceof Error ? sanitize(error.message) : 'network error'}`);
    }
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      if (seam.ambiguousOutcome === true) throw error;
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

  /** Parse the provider's review object into a PostedReviewReceipt,
   * proving on the way: the author is the verified App bot (a Bot), the
   * enacted event is COMMENTED, the provider bound the review to the
   * reviewed commit, and the echoed body is byte-identical to what this
   * delivery published. Any failure throws — the delivery identity stays
   * unproven. */
  private receiptFromReview(
    review: unknown,
    botLogin: string,
    targetSha: string,
    headSha: string,
    baseSha: string,
    publishedBody: string,
  ): PostedReviewReceipt {
    const parsed = review as { id?: unknown; user?: { login?: unknown; type?: unknown }; state?: unknown; commit_id?: unknown; body?: unknown } | null;
    const reviewId = usableProviderReviewId(parsed?.id);
    if (reviewId === null) {
      throw new PerkinsAppError(
        `provider review id is not usable (${parsed?.id === undefined ? 'absent' : sanitize(String(parsed?.id))}) — delivery identity is unproven`,
      );
    }
    const loginText = typeof parsed?.user?.login === 'string' ? parsed.user.login : '<absent>';
    const typeText = typeof parsed?.user?.type === 'string' ? parsed.user.type : '<absent>';
    if (parsed?.user?.login !== botLogin || parsed?.user?.type !== 'Bot') {
      throw new PerkinsAppError(
        `review publication identity mismatch: provider review ${reviewId} is authored by ${sanitize(loginText)} (${sanitize(typeText)}), expected the verified App bot ${botLogin} — delivery identity is unproven`,
      );
    }
    if (parsed?.state !== 'COMMENTED') {
      throw new PerkinsAppError(
        `review publication state mismatch: provider review ${reviewId} enacted ${parsed?.state === undefined || parsed?.state === null ? '(none)' : sanitize(String(parsed?.state))} instead of COMMENTED — delivery identity is unproven`,
      );
    }
    if (parsed?.commit_id !== targetSha) {
      throw new PerkinsAppError(
        `review publication receipt mismatch: provider review ${reviewId} committed to ${sanitize(String(parsed?.commit_id))}, expected ${targetSha}`,
      );
    }
    const echoedBody = typeof parsed?.body === 'string' ? parsed.body : null;
    if (echoedBody === null || receiptDigest(echoedBody) !== receiptDigest(publishedBody)) {
      throw new PerkinsAppError(
        `review publication body mismatch: provider review ${reviewId} echoed a body whose digest does not match the published body — delivery identity is unproven`,
      );
    }
    return {
      reviewId,
      actor: botLogin,
      event: 'COMMENTED',
      commitId: parsed?.commit_id ?? null,
      headSha,
      baseSha,
      bodySha256: receiptDigest(echoedBody),
    };
  }

  /** Parse the last page number out of a GitHub Link header, if present.
   * Only a sane integer >= 1 counts — a provider or intermediary reporting
   * `page=0` must never be read as "zero pages remain" (which would certify
   * full coverage it never had). */
  private parseLastPage(linkHeader: string | null): number | null {
    if (linkHeader === null) return null;
    const last = /<([^>]+)>;\s*rel="last"/u.exec(linkHeader);
    if (last === null) return null;
    const page = /[?&]page=(\d+)/u.exec(last[1]!);
    if (page === null) return null;
    const parsed = Number(page[1]);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
  }

  /** Bounded ambiguous-POST reconciliation (the delivery path): a bounded
   * walk of the provider's review list for OUR bot's byte-identical
   * COMMENT review on the exact frozen head, submitted in this round's
   * window. A proved match is the delivery receipt; a fully-covered list
   * with no match PROVES the POST did not land; anything less stays an
   * explicit unproven failure. Never a second POST. */
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
  ): Promise<PostedReviewReceipt> {
    const causeText = cause instanceof Error ? sanitize(cause.message) : 'network error';
    const unproven = (what: string): PerkinsAppError => new PerkinsAppError(
      `review POST outcome is ambiguous (${causeText}) and ${what} — delivery stays unproven; the review was NOT re-posted. Resolve the pull request manually before retrying (expected author ${botLogin} on head ${targetSha}; the round's publication body is in the review artifact report).`,
    );
    // Skew margin only: the review this round may have created was submitted
    // after the POST began; anything older is another round's bytes.
    const notBeforeMs = postStartMs - 60_000;
    let walked: { readonly matched: ProviderReview | null; readonly provablyAbsent: boolean };
    try {
      walked = await this.lookupMatchingReview(grant, owner, repo, prNumber, botLogin, targetSha, body, notBeforeMs);
    } catch (lookupError) {
      throw unproven(
        `the bounded proof lookup itself failed (${lookupError instanceof Error ? sanitize(lookupError.message) : 'lookup error'})`,
      );
    }
    if (walked.matched !== null) {
      return verifyPostedReceipt(
        this.receiptFromReview(walked.matched, botLogin, targetSha, targetSha, baseSha, body),
        { targetSha, bodySha256: receiptDigest(body) },
      );
    }
    if (walked.provablyAbsent) {
      throw new PerkinsAppError(
        `review POST outcome is ambiguous (${causeText}) but the bounded lookup covered the whole review list and proved no matching App review from this round exists — the POST did not land; the review was NOT re-posted. A retry on a NEW frozen head is safe.`,
      );
    }
    throw unproven('no provider-proved matching App review was found in the bounded lookup');
  }

  /** Shared bounded review-list walk. GitHub lists reviews oldest-first
   * and the review being reconciled is the newest, so once the Link
   * header reveals the last page the window jumps there and then walks
   * backward (without a Link header the walk stays sequential).
   * `notBeforeMs` bounds credit to this round's submissions when given;
   * null matches any identical publication (the idempotent recovery
   * seam). `provablyAbsent` is true ONLY when the walk provably covered
   * the ENTIRE review list: the last-page number is tracked as the MAXIMUM
   * any response reported, so a list that grows mid-walk can never be
   * certified absent from a stale snapshot — lookup failures and malformed
   * bodies throw, they are never absence. */
  private async lookupMatchingReview(
    grant: TokenGrant,
    owner: string,
    repo: string,
    prNumber: string,
    botLogin: string,
    targetSha: string,
    body: string,
    notBeforeMs: number | null,
  ): Promise<{ readonly matched: ProviderReview | null; readonly provablyAbsent: boolean }> {
    const visited = new Set<number>();
    let lastPage: number | null = null;
    let page = 1;
    let sequentialEnd = false;
    for (let fetched = 0; fetched < this.maxReconciliationPages; fetched += 1) {
      visited.add(page);
      const result = await this.callApi(
        'review reconciliation',
        `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
        { headers: this.bearerHeaders(grant.token), signal: AbortSignal.timeout(this.probeTimeoutMs) },
      );
      const list = result.body;
      const seenLast = this.parseLastPage(result.header('link'));
      if (seenLast !== null) lastPage = lastPage === null ? seenLast : Math.max(lastPage, seenLast);
      if (!Array.isArray(list)) {
        // Never report "searched and not found" when no usable list was read.
        throw new PerkinsAppError('review reconciliation lookup returned a malformed list body — delivery stays unresolved; never assume absence');
      }
      const reviews = list as readonly ProviderReview[];
      const match = reviews.find((review) => isMatchingAppReview(review, botLogin, targetSha, body, notBeforeMs));
      if (match !== undefined) {
        return { matched: match, provablyAbsent: false };
      }
      let next: number;
      if (lastPage !== null) {
        // Jump to the newest page once, then walk backward one page at a
        // time for the rest of the window: re-checking the jump on every
        // iteration would pin the walk to {1, last, last-1} and silently
        // cap the covered set no matter how large the bound is.
        next = visited.has(lastPage) || page >= lastPage ? page - 1 : lastPage;
      } else {
        // No Link header: the classic short-page end-of-list heuristic.
        if (reviews.length < 100) {
          sequentialEnd = true;
          break;
        }
        next = page + 1;
      }
      if (next < 1 || visited.has(next)) break;
      page = next;
    }
    const provablyAbsent = lastPage !== null ? visited.size >= lastPage : sequentialEnd;
    return { matched: null, provablyAbsent };
  }
}

/** Options for the startup factories. `githubPosterOverride` is a TEST
 * seam: it replaces the selected github.com leg so the composite's
 * routing can be exercised without a real `gh` binary. */
export interface StartupPosterOptions extends Omit<PerkinsAppPosterOptions, 'instanceDir'> {
  readonly githubPosterOverride?: VerdictPoster;
}

/** A malformed wiring root must fail with a named, actionable error
 * instead of silently joining a relative path (which would probe the CWD)
 * or leaking a raw TypeError out of service boot. */
function requireBundleRoot(root: unknown, label: string): asserts root is string {
  if (typeof root !== 'string' || root === '' || !isAbsolute(root)) {
    throw new PerkinsAppError(
      `Perkins App publication wiring requires an absolute ${label} (received: ${sanitize(String(root))}) — check the service configuration passed to the startup poster factory`,
    );
  }
}

/** The root the `perkins/` bundle is read from. The service instance dir
 * (where config.toml lives) is authoritative; a relocated deployment that
 * keeps its state under `data_dir` is honored as a fallback when the
 * instance dir holds no bundle. Absent from both keeps the legacy poster.
 * Documented in docs/PERKINS-APP-PUBLICATION.md. */
export function resolvePerkinsAppBundleRoot(config: {
  readonly instanceDir: string;
  readonly dataDir?: string;
}): string {
  requireBundleRoot(config.instanceDir, 'instance directory');
  if (config.dataDir !== undefined && config.dataDir !== '') {
    requireBundleRoot(config.dataDir, 'data directory');
  }
  if (perkinsAppBundleConfigured(config.instanceDir)) return config.instanceDir;
  const dataDir = config.dataDir;
  if (dataDir !== undefined && dataDir !== '' && dataDir !== config.instanceDir && perkinsAppBundleConfigured(dataDir)) {
    return dataDir;
  }
  return config.instanceDir;
}

/** Startup selection: an existing App bundle routes github.com publication
 * through the App poster; deployments with no bundle keep the legacy `gh`
 * poster and its behavior byte-for-byte. GitLab routing is untouched. */
export function createGithubVerdictPoster(
  instanceDir: string,
  options?: StartupPosterOptions,
): VerdictPoster {
  requireBundleRoot(instanceDir, 'instance directory');
  const { githubPosterOverride, ...appOptions } = options ?? {};
  if (githubPosterOverride !== undefined) return githubPosterOverride;
  return perkinsAppBundleConfigured(instanceDir)
    ? new PerkinsAppPrPoster({ instanceDir, ...appOptions })
    : new GhPrPoster();
}

/** The one seam `main()` wires: the auto host router with the App-selected
 * github.com leg. Takes the CONFIG OBJECT (any `{ instanceDir, dataDir? }`),
 * not a bare path, so the property selection itself lives inside this
 * tested unit; the wiring site is additionally pinned by a source assertion
 * in the suite, so a dropped call cannot silently restore the personal
 * poster. */
export function createStartupVerdictPoster(
  config: { readonly instanceDir: string; readonly dataDir?: string },
  options?: StartupPosterOptions,
): AutoVerdictPoster {
  return new AutoVerdictPoster(createGithubVerdictPoster(resolvePerkinsAppBundleRoot(config), options));
}
