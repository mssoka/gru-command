import { createHash, createPrivateKey, createSign } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { PostedReviewReceipt, PrIdentity, VerdictPoster, VerdictPosterInput, VerdictReconcileContext } from './perkins.js';
import { AutoVerdictPoster, cancelAwareSignal, enactedStateFor, GhPrPoster, verifyPostedReceipt } from './perkins.js';
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
    // The END marker may be absent (a display bound or a hostile truncation)
    // and the subtype is optional (PKCS#8 emits `BEGIN PRIVATE KEY`): any
    // private-key BEGIN marker is secret-bearing through END or EOF. Same
    // handling as the questions redactor (src/decisions/questions.ts).
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gu, '[REDACTED]')
    // Token shapes are matched unanchored: a credential pasted without a
    // clean separator before its prefix must still be redacted.
    .replace(/gh[pousra]_[A-Za-z0-9_]{16,}/gu, '[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{16,}/gu, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, '[REDACTED]')
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

/** Credential files are a few KB; anything orders of magnitude larger is
 * not a bundle file, and buffering it would stall (or exhaust) the round. */
const MAX_BUNDLE_FILE_BYTES = 1_048_576;

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
      // Sanitize the FULL line before any shortening — truncating first can
      // leave a still-identifiable credential prefix below the redaction
      // threshold (a separator-free github_pat_ token).
      throw new PerkinsAppError(
        `${sourceLabel}: line ${index + 1} is not KEY=VALUE (key/line prefix: ${sanitize(line)})`,
      );
    }
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (!KEY_PATTERN.test(key)) {
      // Sanitize the FULL value before any shortening — truncating first
      // can leave a still-identifiable credential prefix.
      throw new PerkinsAppError(
        `${sourceLabel}: line ${index + 1} has an invalid key (${sanitize(key)})`,
      );
    }
    // The bundle contract is closed: a key outside it is a provisioning
    // misspelling, and silently ignoring it would take effect as a partial
    // config. Name the line instead.
    if (key !== 'app_id' && key !== 'key_path' && !key.startsWith('installation_id_')) {
      // Config-derived bytes are never echoed raw: KEY_PATTERN happily
      // admits credential-shaped unknown keys (a pasted ghs_/github_pat_
      // token). Sanitize the FULL value before any shortening — truncating
      // first can leave a still-identifiable credential prefix. The line
      // number stays for actionable provisioning repair.
      throw new PerkinsAppError(
        `${sourceLabel}: line ${index + 1} has an unrecognized key (${sanitize(key)}) — the bundle accepts app_id, key_path and installation_id_<owner> entries only`,
      );
    }
    const prior = seen.get(key);
    if (prior !== undefined && prior !== value) {
      throw new PerkinsAppError(
        `${sourceLabel}: key "${sanitize(key)}" appears twice with different values — resolve the bundle to one value per key`,
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
          `${sourceLabel}: installation owner "${sanitize(owner)}" is configured twice with different values — resolve the bundle to one id per owner`,
        );
      }
      installationIds.set(owner, value);
    }
  });
  const appIdRaw = seen.get('app_id');
  if (appIdRaw === undefined || !/^[1-9][0-9]*$/u.test(appIdRaw)) {
    throw new PerkinsAppError(`${sourceLabel}: missing or invalid required entry "app_id" (expected a positive integer)`);
  }
  const appId = Number(appIdRaw);
  if (!Number.isSafeInteger(appId)) {
    throw new PerkinsAppError(`${sourceLabel}: app_id is outside the safe integer range — refusing an id that would lose precision or become Infinity`);
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
      throw new PerkinsAppError(`${sourceLabel}: installation id for owner "${sanitize(owner)}" is not a positive integer`);
    }
    if (!Number.isSafeInteger(Number(id))) {
      throw new PerkinsAppError(`${sourceLabel}: installation id for owner "${sanitize(owner)}" is outside the safe integer range — refusing an id that would lose precision or aim a different installation`);
    }
  }
  return {
    appId,
    keyPath: keyPathRaw,
    installationIds,
  };
}

interface LoadedBundle {
  readonly config: PerkinsAppBundleConfig;
  readonly privateKeyPem: string;
}

/** Resolve the configured key_path to an absolute path. Absolute POSIX
 * paths are used as written; anything else — including `..` segments —
 * resolves against the trusted bundle dir, never the CWD or a repository.
 * Windows drive (`C:\...`, `C:/...`) and UNC (`\\server\share\...`) forms
 * are absolute on Windows and are used as written there; on the supported
 * POSIX deployment they are NOT absolute, so using one verbatim would
 * silently resolve it against the process working directory — they are
 * refused by name instead. A single leading backslash is NOT an absolute
 * form (only the UNC double backslash is): it resolves against the bundle
 * dir like any other relative path. Exported so the resolution rule itself
 * is directly testable. */
export function resolvePerkinsAppKeyPath(bundleDir: string, keyPath: string): string {
  if (keyPath.startsWith('/')) return keyPath;
  const windowsForm = keyPath.startsWith('\\\\') || /^[A-Za-z]:[\\/]/u.test(keyPath);
  if (windowsForm) {
    if (process.platform !== 'win32') {
      throw new PerkinsAppError(
        `configured key_path "${sanitize(keyPath)}" is a Windows path form on a POSIX host — bundle key paths must be POSIX-absolute or relative to the bundle dir; refusing to resolve it against the process working directory`,
      );
    }
    return keyPath;
  }
  return join(bundleDir, keyPath);
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
    if ((info.mode & 0o7777) !== 0o700) {
      throw new PerkinsAppError(
        `${sourceLabel}: bundle directory must have mode 0700 exactly (found ${(info.mode & 0o7777).toString(8).padStart(3, '0')}) — another local user could otherwise replace the bundle files`,
      );
    }
  }
}

/** Test seam: replaces the descriptor read in the byte-ceiling backstop
 * (grow-after-stat) so that branch is deterministically pinnable without a
 * real file changing size mid-read. Never used by production wiring. */
export interface BundleFileReadSeam {
  readonly readImpl?: (fd: number, buffer: Buffer, offset: number, length: number) => number;
}

/** Read one bundle credential file with its safety checks bound to the
 * same inode (open with O_NOFOLLOW, then fstat the open descriptor): a
 * regular file, owned by the service user on unix, readable by the owner
 * and by nobody else, with no setuid/setgid/sticky bits. Fail-closed with
 * an actionable message carrying the errno where one exists. */
function readBundleFileChecked(path: string, label: string, sourceLabel: string, seam?: BundleFileReadSeam): string {
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
    if (info.size > MAX_BUNDLE_FILE_BYTES) {
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
    // Read through the SAME descriptor with a hard byte ceiling as the
    // backstop to the fstat check: a file that grows (or lies about its
    // size) between fstat and read still cannot push unbounded bytes into
    // memory.
    const read = seam?.readImpl ?? ((readFd: number, readBuffer: Buffer, offset: number, length: number) => readSync(readFd, readBuffer, offset, length, null));
    const buffer = Buffer.allocUnsafe(MAX_BUNDLE_FILE_BYTES + 1);
    let filled = 0;
    for (;;) {
      const readBytes = read(fd, buffer, filled, MAX_BUNDLE_FILE_BYTES + 1 - filled);
      if (readBytes === 0) break;
      filled += readBytes;
      if (filled > MAX_BUNDLE_FILE_BYTES) {
        throw new PerkinsAppError(`${sourceLabel}: ${label} exceeded ${MAX_BUNDLE_FILE_BYTES} bytes when read (its stat reported ${info.size}) — check the perkins bundle deployment`);
      }
    }
    return buffer.subarray(0, filled).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** Read and validate the bundle at publication time (never at service
 * boot): a broken bundle fails THIS review loudly, it never bricks the
 * service. Key bytes never appear in any diagnostic. */
export function loadPerkinsAppBundle(instanceDir: string, seam?: BundleFileReadSeam): LoadedBundle {
  const dir = perkinsAppBundleDir(instanceDir);
  const configPath = join(dir, 'config');
  const sourceLabel = 'perkins app bundle';
  bundleDirSafe(dir, sourceLabel);
  const text = readBundleFileChecked(configPath, 'bundle config', sourceLabel, seam);
  const config = parsePerkinsAppConfig(text, sourceLabel);
  // The key path resolves against the trusted bundle dir, not the repo.
  // An absolute key_path is permitted (the deployed bundle may keep the
  // key outside the bundle dir); that file passes the same file-level
  // safety checks, and the bundle dir remains the audit boundary for the
  // config that names it.
  const keyPath = resolvePerkinsAppKeyPath(dir, config.keyPath);
  const pem = readBundleFileChecked(keyPath, 'configured private key file', sourceLabel, seam);
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
  /** Production fetch exposes the reply byte stream; when present the
   * reader applies the byte ceiling without buffering past it (the bound
   * is the ceiling plus at most one stream chunk held whole). A response
   * without a stream falls back to text() — that path exists for test
   * doubles, which return finite fixture bodies. */
  readonly body?: ReadableStream<Uint8Array> | null;
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

/** Read a provider reply under a hard byte ceiling. Production fetch
 * exposes a byte stream, so the reader stops at the ceiling instead of
 * buffering past it; a test double that only offers `text()` gets the same
 * ceiling applied to the returned string (the bytes-read bound is exact;
 * when a boundary splits a multi-byte UTF-8 sequence the re-encoded string
 * can carry at most two replacement bytes more). `overflowed` tells the
 * caller the reply was truncated at the ceiling (status classification
 * uses the truncated text; oversized OK replies fail closed). */
async function readResponseBodyCapped(
  response: AppFetchResponse,
  maxBytes: number,
): Promise<{ readonly text: string; readonly overflowed: boolean }> {
  const stream = response.body ?? null;
  if (stream !== null && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          // Keep the prefix of the boundary chunk under the ceiling so a
          // truncated refusal body still carries as much classifier-visible
          // text as the budget allows.
          const keep = maxBytes - (total - value.byteLength);
          if (keep > 0) chunks.push(Buffer.from(value.subarray(0, keep)));
          try {
            await reader.cancel();
          } catch {
            // The overflow error owns the outcome; a cancel failure is not one.
          }
          return { text: Buffer.concat(chunks).toString('utf8'), overflowed: true };
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return { text: Buffer.concat(chunks).toString('utf8'), overflowed: false };
  }
  const text = await response.text();
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength > maxBytes) {
    return { text: bytes.subarray(0, maxBytes).toString('utf8'), overflowed: true };
  }
  return { text, overflowed: false };
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
  /** Reply-size ceiling for provider bodies (defense against a runaway or
   * hostile response; the largest legitimate review-list page is a few MiB). */
  readonly maxProviderBodyBytes?: number;
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
  if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 1) return String(id);
  // Provider-quoted ids keep the shared receipt contract's charset, so a
  // certified receipt can never fail the ledger's promotion gate later.
  if (typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(id)) return id;
  return null;
}

/** The delivery predicate without the provider-id requirement: author
 * login+type, the ENACTED state this delivery intended, frozen head, and
 * byte-identical body. With a
 * recency bound (the ambiguous-POST path) only submissions inside this
 * round's window — POST start minus the 60 s clock-skew margin — count;
 * null (the idempotent recovery seam) matches any identical publication.
 * Older rounds' identical bytes outside the margin are never credited as
 * this delivery, and a review in any other state (a COMMENTED review
 * beside an approval intent, an unexpected APPROVED beside a change-request
 * intent) is never a match. A null `wantedState` matches ANY enacted state
 * — the wrong-state evidence test below, never a credit predicate. */
function matchesDeliveryPredicates(review: ProviderReview, botLogin: string, targetSha: string, body: string, wantedState: string | null, notBeforeMs: number | null): boolean {
  if (review.user?.login !== botLogin || review.user?.type !== 'Bot') return false;
  if ((wantedState !== null && review.state !== wantedState) || review.commit_id !== targetSha || review.body !== body) return false;
  if (notBeforeMs === null) return true;
  const submittedAt = typeof review.submitted_at === 'string' ? Date.parse(review.submitted_at) : Number.NaN;
  return Number.isFinite(submittedAt) && submittedAt >= notBeforeMs;
}

/** A review matching this publication's author, frozen head, body and
 * window in ANY SUBMITTED state — evidence the publication exists, but NOT
 * in the state this delivery intended. It can neither be credited nor read
 * as absence: the delivery stays explicitly unresolved. A PENDING draft is
 * not delivered evidence at all (it was never submitted), so it is skipped
 * exactly like any unrelated review. */
function isMatchingAppReviewInAnyState(review: ProviderReview, botLogin: string, targetSha: string, body: string, notBeforeMs: number | null): boolean {
  return review.state !== 'PENDING' && matchesDeliveryPredicates(review, botLogin, targetSha, body, null, notBeforeMs);
}

/** Provider-proved evidence that OUR App bot published exactly this review
 * during this round: every delivery predicate plus a usable provider id
 * (a receipt can only be certified with one). */
function isMatchingAppReview(review: ProviderReview, botLogin: string, targetSha: string, body: string, wantedState: string, notBeforeMs: number | null): boolean {
  return usableProviderReviewId(review.id) !== null && matchesDeliveryPredicates(review, botLogin, targetSha, body, wantedState, notBeforeMs);
}

/** A review matching every delivery predicate but carrying an unusable (or
 * absent) provider id: it can never become a receipt, yet it may still BE
 * this round's landed publication. The walk must neither credit it nor
 * silently skip it into an absence certificate — one such review keeps the
 * delivery unresolved. */
function isMatchingAppReviewWithUnusableId(review: ProviderReview, botLogin: string, targetSha: string, body: string, wantedState: string, notBeforeMs: number | null): boolean {
  return usableProviderReviewId(review.id) === null && matchesDeliveryPredicates(review, botLogin, targetSha, body, wantedState, notBeforeMs);
}

/** A review identical on author/commit/body whose submission time is
 * missing or unparseable: with a recency bound it can be neither credited
 * (its window is unprovable) nor excluded as an older round's, so it also
 * forbids an absence certificate — REGARDLESS of the enacted state. A
 * body-identical review in a different state with an unverifiable window may
 * be this attempt's publication in the wrong state, so it must hold the
 * delivery unresolved instead of letting a fully covered list claim the
 * POST did not land. A PENDING draft is undelivered and is skipped. */
function isMatchingAppReviewWithUnverifiableTime(review: ProviderReview, botLogin: string, targetSha: string, body: string, notBeforeMs: number | null): boolean {
  if (notBeforeMs === null) return false;
  if (review.user?.login !== botLogin || review.user?.type !== 'Bot') return false;
  if (review.state === 'PENDING' || review.commit_id !== targetSha || review.body !== body) return false;
  const submittedAt = typeof review.submitted_at === 'string' ? Date.parse(review.submitted_at) : Number.NaN;
  return !Number.isFinite(submittedAt);
}

/** Whether a review-list entry is a decidable review record that an
 * absence proof may rest on: a plain record (never an array), carrying the
 * provider's numeric review id, and — when present — the fields the
 * delivery predicates read, in their provider types. Anything else —
 * `[[]]`, `[{}]`, `[{user: …}]`, `[42]` — is a broken list, not a review
 * that happens to differ: its non-match proves nothing, so a walk over it
 * must stay unresolved rather than certify absence. */
function isDecidableReviewEntry(entry: unknown): entry is ProviderReview {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'number' || !Number.isFinite(id)) return false;
  if (!('user' in record)) return false;
  const user = record['user'];
  if (user !== null) {
    if (typeof user !== 'object' || Array.isArray(user)) return false;
    // The nested author fields are read by every delivery predicate: a
    // record whose login/type are not provider-typed strings (an array, a
    // number, a missing key) is malformed author evidence. Its non-match
    // proves nothing — one such record must keep the whole walk from
    // certifying absence.
    const author = user as Record<string, unknown>;
    for (const field of ['login', 'type'] as const) {
      if (typeof author[field] !== 'string') return false;
    }
  }
  for (const field of ['state', 'commit_id', 'body', 'submitted_at'] as const) {
    const value = record[field];
    if (!(value === null || value === undefined || typeof value === 'string')) return false;
  }
  return true;
}

/** GitHub error bodies/markers that mean rate limiting, not permission. */
function providerIndicatesRateLimit(error: PerkinsAppHttpError): boolean {
  const documentationUrl = error.documentationUrl;
  return (documentationUrl !== null && /rate-limit/u.test(documentationUrl)) ||
    /\brate[- ]?limits?\b|\brate[- ]?limited\b|\brate[- ]?limiting\b|abuse detection/iu.test(error.providerMessage);
}

/** HTTP-level provider rejection carrying only sanitized classification
 * state: the sanitized provider message and the extracted
 * `documentation_url` marker. Raw provider bytes are never retained on the
 * error object — a future structured log or snapshot must not be able to
 * echo credential-shaped provider bytes. */
export class PerkinsAppHttpError extends PerkinsAppError {
  readonly providerMessage: string;
  readonly documentationUrl: string | null;

  constructor(label: string, readonly status: number, body: unknown, text: string) {
    const providerBody = body as { readonly message?: unknown; readonly documentation_url?: unknown } | null;
    let providerMessage = sanitize(typeof providerBody?.message === 'string' ? providerBody.message : text);
    if (providerMessage === '') providerMessage = 'no provider message';
    super(`${label} exited HTTP ${status}: ${providerMessage}`);
    this.name = 'PerkinsAppHttpError';
    this.providerMessage = providerMessage;
    this.documentationUrl = typeof providerBody?.documentation_url === 'string' ? sanitize(providerBody.documentation_url) : null;
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
  private readonly maxProviderBodyBytes: number;

  constructor(private readonly options: PerkinsAppPosterOptions) {
    // The exported class is a public boundary: a direct construction with
    // a relative root must fail before any probe of the process CWD.
    requireBundleRoot(options.instanceDir, 'instance directory');
    this.fetchImpl = options.fetchImpl ?? ((fetch as unknown) as AppFetch);
    this.now = options.now ?? (() => Date.now());
    this.gitBinary = options.gitBinary ?? 'git';
    // Bounded like the shared receipt contract: up to ten review-list pages
    // (the jump-to-last walk normally resolves in two or three fetches; the
    // extra headroom is for the idempotent recovery lookup on busy PRs,
    // which may search deeper than the in-round ambiguous-POST case).
    const requestedPages = options.maxReconciliationPages;
    if (requestedPages !== undefined && (!Number.isSafeInteger(requestedPages) || requestedPages < 1)) {
      throw new PerkinsAppError(
        `maxReconciliationPages must be an integer >= 1 (received: ${sanitize(String(requestedPages))}) — refusing to arm a broken lookup window`,
      );
    }
    this.maxReconciliationPages = requestedPages ?? 10;
    const requestedBodyCap = options.maxProviderBodyBytes;
    if (requestedBodyCap !== undefined && (!Number.isSafeInteger(requestedBodyCap) || requestedBodyCap < 1024)) {
      throw new PerkinsAppError(
        `maxProviderBodyBytes must be an integer >= 1024 (received: ${sanitize(String(requestedBodyCap))}) — refusing to arm a broken reply-size ceiling`,
      );
    }
    this.maxProviderBodyBytes = requestedBodyCap ?? 16 * 1024 * 1024;
    // Timeouts are wiring, not provider state: an unarmed (<=0) or
    // non-integer value must fail here by name — never later as an
    // "ambiguous" delivery that sends the operator to the provider.
    const requestedProbeTimeout = options.probeTimeoutMs;
    if (requestedProbeTimeout !== undefined && (!Number.isSafeInteger(requestedProbeTimeout) || requestedProbeTimeout < 1)) {
      throw new PerkinsAppError(
        `probeTimeoutMs must be an integer >= 1 (received: ${sanitize(String(requestedProbeTimeout))}) — refusing to arm a broken timeout`,
      );
    }
    this.probeTimeoutMs = requestedProbeTimeout ?? 15_000;
    const requestedPostTimeout = options.postTimeoutMs;
    if (requestedPostTimeout !== undefined && (!Number.isSafeInteger(requestedPostTimeout) || requestedPostTimeout < 1)) {
      throw new PerkinsAppError(
        `postTimeoutMs must be an integer >= 1 (received: ${sanitize(String(requestedPostTimeout))}) — refusing to arm a broken timeout`,
      );
    }
    this.postTimeoutMs = requestedPostTimeout ?? 30_000;
  }

  /** Restart-recovery evidence (R30): the verified App bot account this
   * poster publishes as, proven from the installed bundle through the
   * SAME identity chain the live prepare/post path uses. Recovery must
   * never credit a persisted actor on its own authority. */
  async authenticatedActor(host: string): Promise<string> {
    if (host !== 'github.com') {
      throw new PerkinsAppError(
        `Perkins App publication is configured, but host "${sanitize(host)}" is not github.com — the App's credentials are bound to api.github.com and cannot evidence an account for this host`,
      );
    }
    const { config, privateKeyPem } = loadPerkinsAppBundle(this.options.instanceDir);
    const jwt = mintAppJwt(config.appId, privateKeyPem, this.now());
    return this.verifyAppIdentity(jwt, config.appId);
  }

  async post(input: VerdictPosterInput): Promise<PostedReviewReceipt> {
    // The wanted formal event travels WITH the delivery (owner ruling
    // j-1615): an eligible native READY enacts APPROVE, a confirmed blocker
    // set enacts REQUEST_CHANGES, everything else stays a COMMENT. The
    // provider's enacted state is verified against exactly this below.
    const wantedState = enactedStateFor(input.reviewEvent);
    const { grant, botLogin, owner, repo, prNumber, headSha, baseSha } = await this.prepare(input);
    const postStartMs = this.now();
    // The round may have been cancelled/superseded while the preparation
    // probes were outstanding: never start the irreversible POST for an
    // already-cancelled round (the round signal is combined with every
    // probe and POST timeout above and below).
    if (input.signal?.aborted) {
      throw new PerkinsAppError('review delivery cancelled before the irreversible POST — no review was created');
    }
    // Bind the prepared App-bot identity durably BEFORE the write so a
    // restart can prove the reconciliation lookup ran as the same account.
    input.onPreparedIdentity?.(botLogin);
    let review: unknown;
    try {
      review = (await this.callApi('POST review delivery', `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
        method: 'POST',
        headers: this.bearerHeaders(grant.token),
        body: JSON.stringify({ body: input.body, event: input.reviewEvent, commit_id: input.targetSha }),
        signal: cancelAwareSignal(input.signal, this.postTimeoutMs),
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
      return await this.reconcileAmbiguousPost(grant, owner, repo, prNumber, botLogin, input.targetSha, input.body, wantedState, baseSha, error, postStartMs, input.signal);
    }
    try {
      return verifyPostedReceipt(
        this.receiptFromReview(review, botLogin, input.targetSha, headSha, baseSha, input.body, wantedState),
        { targetSha: input.targetSha, bodySha256: receiptDigest(input.body), event: wantedState },
      );
    } catch (error) {
      if (error instanceof PerkinsAppError) {
        // A 2xx whose receipt cannot be proved (foreign author, enacted
        // event, wrong commit, mismatched or unreadable body) leaves the
        // delivery identity ambiguous — the same bounded reconciliation
        // decides it, never a blind retry.
        return await this.reconcileAmbiguousPost(grant, owner, repo, prNumber, botLogin, input.targetSha, input.body, wantedState, baseSha, error, postStartMs, input.signal);
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
  async reconcile(input: VerdictPosterInput, context?: VerdictReconcileContext): Promise<PostedReviewReceipt | null> {
    // The live post-failure second lookup (the WaveRunner failure seam)
    // FAILS CLOSED before any provider read: post() already owns its one
    // bounded strict-window reconciliation, and a thrown post error must
    // never be upgraded into a receipt — or an absence certificate — by a
    // second recovery lookup. Ordinary unannotated reconciliation below
    // keeps its distinct prior provider-proved recovery semantics, safe
    // under concurrent jobs (no per-instance state exists to interleave).
    if (context?.reason === 'post-failure') {
      throw new PerkinsAppError(
        'review reconciliation is refused for a failed publication attempt: a failed post is never upgraded into a receipt by a second recovery lookup — whether any review landed stays unresolved; verify the pull request manually before any retry, never assume absence',
      );
    }
    const { grant, botLogin, owner, repo, prNumber, baseSha } = await this.prepare(input);
    const wantedState = enactedStateFor(input.reviewEvent);
    const { matched, provablyAbsent, matchedButUnreceiptable, matchedButWrongState } = await this.lookupMatchingReview(grant, owner, repo, prNumber, botLogin, input.targetSha, input.body, wantedState, null, input.signal);
    if (matched !== null) {
      return verifyPostedReceipt(
        this.receiptFromReview(matched, botLogin, input.targetSha, input.targetSha, baseSha, input.body, wantedState),
        { targetSha: input.targetSha, bodySha256: receiptDigest(input.body), event: wantedState },
      );
    }
    if (matchedButWrongState !== null) {
      // A body-identical review in the wrong state is real evidence of a
      // DIFFERENT delivery: it neither fulfills the intent nor certifies
      // that the intended review is absent.
      throw new PerkinsAppError(
        `review reconciliation found a review matching the intended publication's author, frozen head and body in state ${sanitize(matchedButWrongState)} instead of the intended ${wantedState} — delivery stays unresolved; verify that review manually before any retry, never assume absence`,
      );
    }
    if (matchedButUnreceiptable) {
      throw new PerkinsAppError(
        'review reconciliation found a review matching every delivery predicate except its provider id or its submission time — delivery stays unresolved; verify that review manually before any retry, never assume absence',
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
        `Perkins App publication is configured, but host "${sanitize(input.host)}" is not github.com — the App's credentials are bound to api.github.com and are never used for other hosts; github.com is the only GitHub host supported while the bundle is installed. Remove the App bundle to restore the legacy publisher for this host, or escalate an explicit publisher decision`,
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
      // Every untrusted echo in this diagnostic is sanitized in FULL: a
      // valid parsed bundle may legitimately carry a credential-shaped
      // owner key, and the missing-mapping message lists configured owners.
      const owners = [...config.installationIds.keys()].sort().map((entry) => sanitize(entry)).join(', ');
      throw new PerkinsAppError(
        `Perkins App bundle has no installation_id mapping for repository owner "${sanitize(owner)}" (configured owners: ${owners === '' ? 'none' : owners}) — add the mapping to the bundle config; App publication never falls back to a personal credential`,
      );
    }

    const nowMs = this.now();
    const jwt = mintAppJwt(config.appId, privateKeyPem, nowMs);
    const grant = await this.mintInstallationToken(jwt, installationId, owner, repo, nowMs, input.signal);
    const botLogin = await this.verifyAppIdentity(jwt, config.appId, input.signal);
    const { headSha, baseSha } = await this.verifyPullRequest(grant, owner, repo, prNumber, input.targetSha, input.signal);
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
    let overflowed = false;
    try {
      ({ text, overflowed } = await readResponseBodyCapped(response, this.maxProviderBodyBytes));
    } catch (error) {
      // The status line arrived even though the body did not: a 4xx is the
      // provider's definitive refusal and keeps that classification no
      // matter how its body read failed. An unreadable refusal must never
      // degrade into an unknown outcome that a reconciliation could upgrade
      // into a receipt for the refused attempt. The raw read-error text is
      // discarded (it is never sanitized provider evidence).
      if (response.status >= 400 && response.status < 500) {
        throw new PerkinsAppHttpError(label, response.status, null, 'refusal body could not be read');
      }
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
    // JSON (a proxy's HTML refusal is still a definitive refusal with a
    // status, never a JSON-parse error that hides it) — and an oversized
    // refusal body is still classified by its status, not as an unknown
    // outcome. The byte ceiling only decides whether an OK reply is
    // parseable.
    if (!response.ok) {
      throw new PerkinsAppHttpError(label, response.status, parseJsonBestEffort(text), text);
    }
    if (overflowed) {
      if (seam.ambiguousOutcome === true) {
        throw new PerkinsAppError(`${label} response exceeded ${this.maxProviderBodyBytes} bytes — delivery identity is unproven (if this is unexpected, check maxProviderBodyBytes)`);
      }
      throw new PerkinsAppError(`${label} response exceeded ${this.maxProviderBodyBytes} bytes — refusing to parse an oversized body (if this is unexpected, check maxProviderBodyBytes)`);
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
    cancel?: AbortSignal,
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
        signal: cancelAwareSignal(cancel, this.probeTimeoutMs),
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

  private async verifyAppIdentity(jwt: string, expectedAppId: number, cancel?: AbortSignal): Promise<string> {
    const { body } = await this.callApi('App identity', `${API_ROOT}/app`, {
      headers: { ...API_HEADERS, 'AUTHORIZATION': `Bearer ${jwt}` },
      signal: cancelAwareSignal(cancel, this.probeTimeoutMs),
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
    // The shared receipt contract bounds the recorded actor at 200 chars
    // and the derived login is '<slug>[bot]': an over-long slug would mint
    // receipts the ledger's own reader must reject on restart.
    if (parsed.slug.length > 195) {
      throw new PerkinsAppError('App identity slug is longer than the shared receipt contract allows (max 195 characters before "[bot]") — refusing an unrecordable bot identity; review not delivered');
    }
    return `${parsed.slug}[bot]`;
  }

  private async verifyPullRequest(
    grant: TokenGrant,
    owner: string,
    repo: string,
    prNumber: string,
    targetSha: string,
    cancel?: AbortSignal,
  ): Promise<PrIdentity> {
    const { body } = await this.callApi('pull request identity', `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers: this.bearerHeaders(grant.token),
      signal: cancelAwareSignal(cancel, this.probeTimeoutMs),
    });
    const parsed = body as { head?: { sha?: unknown }; base?: { sha?: unknown } } | null;
    const headSha = typeof parsed?.head?.sha === 'string' ? parsed.head.sha : '';
    const baseSha = typeof parsed?.base?.sha === 'string' ? parsed.base.sha : '';
    // Only HEAD equality gates delivery; the PR's recorded base is expected
    // to trail the frozen base as main moves (same rule as GhPrPoster).
    if (headSha !== targetSha) {
      throw new PerkinsAppError(
        `pull request identity moved before delivery (expected head ${sanitize(targetSha)}, got ${headSha === '' ? 'unknown' : sanitize(headSha)})`,
      );
    }
    if (baseSha === '') {
      throw new PerkinsAppError('pull request identity response is missing the base sha — refusing an unrecordable receipt; review not delivered');
    }
    return { headSha, baseSha };
  }

  /** Parse the provider's review object into a PostedReviewReceipt,
   * proving on the way: the author is the verified App bot (a Bot), the
   * enacted event is the state this delivery intended, the provider bound
   * the review to the reviewed commit, and the echoed body is byte-
   * identical to what this delivery published. Any failure throws — the
   * delivery identity stays unproven. */
  private receiptFromReview(
    review: unknown,
    botLogin: string,
    targetSha: string,
    headSha: string,
    baseSha: string,
    publishedBody: string,
    wantedState: string,
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
    if (parsed?.state !== wantedState) {
      throw new PerkinsAppError(
        `review publication state mismatch: provider review ${reviewId} enacted ${parsed?.state === undefined || parsed?.state === null ? '(none)' : sanitize(String(parsed?.state))} instead of the required ${wantedState} — delivery identity is unproven`,
      );
    }
    if (parsed?.commit_id !== targetSha) {
      throw new PerkinsAppError(
        `review publication receipt mismatch: provider review ${reviewId} committed to ${sanitize(String(parsed?.commit_id))}, expected ${sanitize(targetSha)}`,
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
      event: wantedState,
      commitId: parsed?.commit_id ?? null,
      headSha,
      baseSha,
      bodySha256: receiptDigest(echoedBody),
    };
  }

  /** Link evidence is untrusted: parse complete entries/parameters before allowing
   * any page bound to certify absence. Malformed or oversized headers poison
   * negative proof, but never suppress a matching review on the same page. */
  private parsePagination(linkHeader: string | null, route: string, responsePage: number):
    { readonly kind: 'absent' } | { readonly kind: 'contradictory' } |
    { readonly kind: 'parsed'; readonly last: number | null; readonly next: number | null } {
    if (linkHeader === null) return { kind: 'absent' };
    if (linkHeader.length > 16_384) return { kind: 'contradictory' };
    // Delimiters inside quoted strings, escaped quotes and angle-bracket
    // URLs are data, not entry/parameter boundaries.
    const split = (text: string, delimiter: string): string[] | null => {
      const parts: string[] = [];
      let start = 0;
      let quoted = false;
      let angled = false;
      let escaped = false;
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]!;
        if (escaped) { escaped = false; continue; }
        if (quoted && char === '\\') { escaped = true; continue; }
        if (char === '"') { quoted = !quoted; continue; }
        if (!quoted && char === '<') { if (angled) return null; angled = true; continue; }
        if (!quoted && char === '>') { if (!angled) return null; angled = false; continue; }
        if (!quoted && !angled && char === delimiter) {
          parts.push(text.slice(start, index).trim());
          start = index + 1;
        }
      }
      if (quoted || angled || escaped) return null;
      parts.push(text.slice(start).trim());
      return parts;
    };
    const entries = split(linkHeader, ',');
    if (entries === null) return { kind: 'contradictory' };
    let last: number | null = null;
    let next: number | null = null;
    for (const entry of entries) {
      const fields = split(entry, ';');
      if (fields === null) return { kind: 'contradictory' };
      const urlMatch = /^<([^<>]+)>$/u.exec(fields[0]!);
      if (urlMatch === null) return { kind: 'contradictory' };
      let relation: string | null = null;
      for (const field of fields.slice(1)) {
        const param = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))$/u.exec(field);
        if (param === null) return { kind: 'contradictory' };
        if (param[1]!.toLowerCase() === 'rel') {
          if (relation !== null) return { kind: 'contradictory' };
          relation = (param[2] ?? param[3] ?? '').replace(/\\(.)/gu, '$1').toLowerCase();
        }
      }
      let url: URL;
      try { url = new URL(urlMatch[1]!); } catch { return { kind: 'contradictory' }; }
      // GitHub repository owner/name spelling is case-insensitive; the PR
      // identity and all other URL constraints are not.
      const linkRoute = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)\/reviews$/u.exec(url.pathname);
      const expectedRoute = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)\/reviews$/u.exec(route);
      const sameRoute = linkRoute !== null && expectedRoute !== null &&
        linkRoute[1]!.toLowerCase() === expectedRoute[1]!.toLowerCase() &&
        linkRoute[2]!.toLowerCase() === expectedRoute[2]!.toLowerCase() && linkRoute[3] === expectedRoute[3];
      const params = [...url.searchParams.keys()];
      if (url.origin !== API_ROOT || url.username !== '' || url.password !== '' ||
          !sameRoute || url.hash !== '' || params.length !== 2 ||
          params.filter((key) => key === 'page').length !== 1 ||
          params.filter((key) => key === 'per_page').length !== 1 ||
          url.searchParams.get('per_page') !== '100') return { kind: 'contradictory' };
      const value = url.searchParams.get('page')!;
      if (!/^\d+$/u.test(value)) return { kind: 'contradictory' };
      const page = Number(value);
      if (!Number.isSafeInteger(page) || page < 1) return { kind: 'contradictory' };
      // A relation-free entry is neutral metadata, not permission to skip
      // validating its URL. Likewise first/prev convey no page bound.
      const relations = relation?.split(/\s+/u) ?? [];
      if (relations.includes('last')) {
        if (last !== null && last !== page) return { kind: 'contradictory' };
        last = page;
      }
      if (relations.includes('next')) {
        if (page <= responsePage || (next !== null && next !== page)) return { kind: 'contradictory' };
        next = page;
      }
    }
    // A single response claiming both an end before its continuation is
    // internally contradictory even when an earlier, larger bound means
    // the walked page set happens to cover the next target.
    if (last !== null && next !== null && next > last) return { kind: 'contradictory' };
    return { kind: 'parsed', last, next };
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
    wantedState: string,
    baseSha: string,
    cause: unknown,
    postStartMs: number,
    cancel?: AbortSignal,
  ): Promise<PostedReviewReceipt> {
    const causeText = cause instanceof Error ? sanitize(cause.message) : 'network error';
    const unproven = (what: string): PerkinsAppError => new PerkinsAppError(
      `review POST outcome is ambiguous (${causeText}) and ${what} — delivery stays unproven; the review was NOT re-posted. Resolve the pull request manually before retrying (expected author ${botLogin} on head ${sanitize(targetSha)}; the round's publication body is in the review artifact report).`,
    );
    // Skew margin only: a submission up to 60 s before the POST began still
    // counts as this round's (provider clock drift); anything older is
    // another round's bytes.
    const notBeforeMs = postStartMs - 60_000;
    let walked: { readonly matched: ProviderReview | null; readonly provablyAbsent: boolean; readonly matchedButUnreceiptable: boolean; readonly matchedButWrongState: string | null };
    try {
      walked = await this.lookupMatchingReview(grant, owner, repo, prNumber, botLogin, targetSha, body, wantedState, notBeforeMs, cancel);
    } catch (lookupError) {
      throw unproven(
        `the bounded proof lookup itself failed (${lookupError instanceof Error ? sanitize(lookupError.message) : 'lookup error'})`,
      );
    }
    if (walked.matched !== null) {
      return verifyPostedReceipt(
        this.receiptFromReview(walked.matched, botLogin, targetSha, targetSha, baseSha, body, wantedState),
        { targetSha, bodySha256: receiptDigest(body), event: wantedState },
      );
    }
    if (walked.matchedButWrongState !== null) {
      throw unproven(
        `a review matching this publication's author, frozen head and body was found in state ${sanitize(walked.matchedButWrongState)} instead of the intended ${wantedState}; whether the intended delivery landed stays unresolved`,
      );
    }
    if (walked.matchedButUnreceiptable) {
      throw unproven(
        'a review matching every delivery predicate except its provider id or its submission time was found, so the POST can be neither credited nor proved absent',
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
   * backward; a validated next can jump forward when last is unknown.
   * Skipped pages are backfilled within the same request bound.
   * `notBeforeMs` bounds credit to this round's submissions when given;
   * null matches any identical publication (the idempotent recovery
   * seam). `wantedState` is the enacted state this delivery intended —
   * only a review in that exact state can be this publication.
   * `provablyAbsent` is true ONLY when the walk provably covered
   * the ENTIRE review list: the last-page number is tracked as the MAXIMUM
   * any response reported, so a list that grows mid-walk can never be
   * certified absent from a stale snapshot, and the short-page end signal
   * requires a response with no Link header at all — lookup failures and
   * malformed bodies throw, they are never absence. `matchedButUnreceiptable`
   * records a review that matched every delivery predicate but cannot form a
   * this-round receipt (unusable provider id, or unverifiable submission
   * time): it can never be credited, but it also forbids an absence
   * certificate (the publication may have landed). */
  private async lookupMatchingReview(
    grant: TokenGrant,
    owner: string,
    repo: string,
    prNumber: string,
    botLogin: string,
    targetSha: string,
    body: string,
    wantedState: string,
    notBeforeMs: number | null,
    cancel?: AbortSignal,
  ): Promise<{ readonly matched: ProviderReview | null; readonly provablyAbsent: boolean; readonly matchedButUnreceiptable: boolean; readonly matchedButWrongState: string | null }> {
    const visited = new Set<number>();
    let lastPage: number | null = null;
    // Set when a response's rel="last" evidence is malformed or
    // self-contradictory: the walk may keep looking, but it can never
    // certify absence — not even from an earlier valid bound.
    let contradictoryPagination = false;
    const observedNextPages = new Set<number>();
    let page = 1;
    let shortEndPage: number | null = null;
    // Search only within the number of requests already made, never across
    // a provider-sized page number. This finds a skipped page when a jump
    // leaves a gap and there is still a request in the budget.
    const missingPageThrough = (bound: number): number | null => {
      for (let candidate = 1; candidate <= Math.min(bound, visited.size + 1); candidate += 1) {
        if (!visited.has(candidate)) return candidate;
      }
      return null;
    };
    let matchedButUnreceiptable = false;
    // The enacted state observed on a review that matches this publication's
    // author, frozen head, body and window but NOT the intended state: it
    // forbids an absence certificate exactly like an unusable id does.
    let matchedButWrongState: string | null = null;
    for (let fetched = 0; fetched < this.maxReconciliationPages; fetched += 1) {
      visited.add(page);
      const result = await this.callApi(
        'review reconciliation',
        `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
        { headers: this.bearerHeaders(grant.token), signal: cancelAwareSignal(cancel, this.probeTimeoutMs) },
      );
      const list = result.body;
      const linkHeader = result.header('link');
      const seenPagination = this.parsePagination(linkHeader, `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, page);
      if (seenPagination.kind === 'contradictory') {
        // The provider's own pagination evidence disagrees with itself or
        // is malformed: no completeness certificate may rest on this walk,
        // even where an earlier bound looked valid. Independently proved
        // exact matches remain creditable; absence never is.
        contradictoryPagination = true;
      } else if (seenPagination.kind === 'parsed') {
        if (seenPagination.last !== null) lastPage = lastPage === null ? seenPagination.last : Math.max(lastPage, seenPagination.last);
        if (seenPagination.next !== null) observedNextPages.add(seenPagination.next);
      }
      if (!Array.isArray(list)) {
        // Never report "searched and not found" when no usable list was read.
        throw new PerkinsAppError('review reconciliation lookup returned a malformed list body — delivery stays unresolved; never assume absence');
      }
      if (list.some((entry) => !isDecidableReviewEntry(entry))) {
        // A null, primitive, array-valued or otherwise undecidable entry is
        // a broken list, not absence: a lookup we cannot trust must never
        // become a certificate.
        throw new PerkinsAppError('review reconciliation lookup returned a malformed list body — delivery stays unresolved; never assume absence');
      }
      const reviews = list as readonly ProviderReview[];
      const match = reviews.find((review) => isMatchingAppReview(review, botLogin, targetSha, body, wantedState, notBeforeMs));
      if (match !== undefined) {
        return { matched: match, provablyAbsent: false, matchedButUnreceiptable: false, matchedButWrongState: null };
      }
      if (matchedButWrongState === null) {
        const wrongState = reviews.find((review) => isMatchingAppReviewInAnyState(review, botLogin, targetSha, body, notBeforeMs));
        if (wrongState !== undefined) {
          matchedButWrongState = typeof wrongState.state === 'string' && wrongState.state !== '' ? wrongState.state : '(none)';
        }
      }
      if (
        !matchedButUnreceiptable &&
        reviews.some((review) =>
          isMatchingAppReviewWithUnusableId(review, botLogin, targetSha, body, wantedState, notBeforeMs) ||
          isMatchingAppReviewWithUnverifiableTime(review, botLogin, targetSha, body, notBeforeMs))
      ) {
        // A predicate-complete publication that cannot form a this-round
        // receipt (unusable id, or an unverifiable submission time) — keep
        // walking for a credit-able copy, but never read this walk as
        // absence afterwards.
        matchedButUnreceiptable = true;
      }
      let next: number;
      if (lastPage !== null) {
        // Jump to the newest page once for a stable list, then walk backward
        // one page at a time for the rest of the window: re-checking the
        // jump on every iteration would pin the walk to {1, last, last-1}
        // whatever the bound. A response revealing a strictly larger
        // lastPage (mid-walk growth) re-fires the jump toward the new
        // newest page — fail-closed, since the max-tracked bound then keeps
        // any growth-uncovered state unresolved.
        next = visited.has(lastPage) || page >= lastPage ? page - 1 : lastPage;
        if (next < 1 || visited.has(next)) {
          next = missingPageThrough(lastPage) ?? 0;
        }
      } else {
        // The classic short-page end-of-list heuristic applies ONLY when no
        // Link header is present at all. A Link header that exists but
        // carries no usable rel="last" is not an end-of-list signal — an
        // intermediary could be rewriting it — so that walk stays unresolved
        // rather than certifying absence from a short page.
        if (linkHeader === null && reviews.length < 100) {
          shortEndPage = Math.max(shortEndPage ?? 0, page);
        }
        if (shortEndPage !== null) {
          next = missingPageThrough(shortEndPage) ?? 0;
        } else {
          next = seenPagination.kind === 'parsed' && seenPagination.next !== null &&
            !visited.has(seenPagination.next) ? seenPagination.next : page + 1;
        }
      }
      if (next < 1 || visited.has(next)) break;
      page = next;
    }
    // Coverage is bounded by actual requests, never an allocation sized by
    // a provider-supplied page count. Even a short final page cannot erase
    // an earlier next link to a page we did not visit.
    const coveredThrough = (bound: number): boolean => visited.size >= bound &&
      [...visited].every((visitedPage) => visitedPage <= bound);
    const provablyAbsent = !contradictoryPagination &&
      [...observedNextPages].every((nextPage) => visited.has(nextPage) && (lastPage === null || nextPage <= lastPage)) &&
      (lastPage !== null ? coveredThrough(lastPage) : shortEndPage !== null && coveredThrough(shortEndPage));
    return { matched: null, provablyAbsent, matchedButUnreceiptable, matchedButWrongState };
  }
}

/** Options for the startup factories. `githubPosterOverride` is a TEST
 * seam: it replaces the selected github.com leg so the composite's
 * routing can be exercised without a real `gh` binary — for bundle-absent
 * deployments only. When a Perkins App bundle is configured the override
 * is refused by name instead of silently replacing the installed App. */
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
 * poster and its behavior byte-for-byte. GitLab routing is untouched, and
 * the test-only override is refused while a bundle is configured — an
 * installed App is never silently replaced. */
export function createGithubVerdictPoster(
  instanceDir: string,
  options?: StartupPosterOptions,
): VerdictPoster {
  requireBundleRoot(instanceDir, 'instance directory');
  const { githubPosterOverride, ...appOptions } = options ?? {};
  const appConfigured = perkinsAppBundleConfigured(instanceDir);
  if (githubPosterOverride !== undefined) {
    if (appConfigured) {
      throw new PerkinsAppError(
        'refusing githubPosterOverride while a Perkins App bundle is configured — the override is a bundle-absent test seam and must never replace the installed-App publisher; remove the override to publish through the App',
      );
    }
    return githubPosterOverride;
  }
  return appConfigured ? new PerkinsAppPrPoster({ instanceDir, ...appOptions }) : new GhPrPoster();
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
