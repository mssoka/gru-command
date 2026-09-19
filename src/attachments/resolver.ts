import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The ONE attach flow's resolution seam (SPEC ruling 19, this lane).
 *
 * Exactly one mechanism serves every surface (chat AND dispatch — no
 * per-surface side doors): material brought into a conversation resolves
 * to a PATH the agent reads itself.
 *
 *  - On-disk files: the picker browses the WORKSPACE ROOT (the canonical
 *    namespace, ruling 19(a)) and the picked file's absolute path is the
 *    reference — METADATA ONLY, never a byte copy (ruling 19(c)).
 *  - Clipboard paste and phone-origin content arrive as bytes with no
 *    path; they MATERIALIZE into the instance uploads dir
 *    (`<data_dir>/uploads/`, 0700 per ruling 19(e)) and the sent path
 *    points at the materialized file.
 */

/** Uploads ride JSON+base64; 8 MiB of material is generous for
 * screenshots and snippets while staying well under any ws/body cap. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** One composer gesture carries a handful of files; 8 is the cap. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/** Uploads count cap (review r1: no quota meant unbounded accumulation —
 * a stuck client could fill the disk with 8 MiB posts). 507-class. */
export const MAX_UPLOAD_FILES = 1_000;

/** Browse listing cap: one serialized response stays bounded even in a
 * 100k-entry directory; `truncated` tells the picker to say so. */
export const MAX_BROWSE_ENTRIES = 500;

/** Path/name length caps (protocol validation mirrors these). */
export const MAX_ATTACHMENT_PATH_CHARS = 1024;
export const MAX_ATTACHMENT_NAME_CHARS = 200;

/** Error with an HTTP-shaped class: the surface maps it to a status. */
export class AttachError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AttachError';
  }
}

export type AttachmentKind = 'file' | 'image';

/** A ready-to-send chip as it travels on the user frame (both protocol
 * twins mirror this shape; validation lives there, constants here). */
export interface AttachmentChip {
  readonly path: string;
  readonly name: string;
  readonly kind: AttachmentKind;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export function attachmentKindFor(name: string): AttachmentKind {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
}

function isInsideOrEqual(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Keep materialized basenames below filesystem NAME_MAX even when the
 * client supplied multi-byte Unicode (the protocol's 200-char cap alone
 * is not a byte cap). The timestamp/collision prefix gets the remaining
 * 55+ bytes on common filesystems. */
const MAX_UPLOAD_NAME_BYTES = 200;

function truncateUtf8(value: string, maxBytes: number): string {
  let out = '';
  let used = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char);
    if (used + bytes > maxBytes) break;
    out += char;
    used += bytes;
  }
  return out;
}

function fitUploadNameBytes(value: string): string {
  if (Buffer.byteLength(value) <= MAX_UPLOAD_NAME_BYTES) return value;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return truncateUtf8(value, MAX_UPLOAD_NAME_BYTES);
  const extension = truncateUtf8(value.slice(dot), 32);
  const stemBudget = MAX_UPLOAD_NAME_BYTES - Buffer.byteLength(extension);
  return `${truncateUtf8(value.slice(0, dot), stemBudget)}${extension}`;
}

// ---------------------------------------------------------------------------
// Materialization (clipboard + phone origin → uploads dir → that path)
// ---------------------------------------------------------------------------

/**
 * Sanitize a client-supplied filename into a safe uploads basename:
 * basename only (no client paths ever), control characters stripped,
 * extension preserved (lowercased, bounded), overall length bounded.
 */
export function sanitizeUploadName(name: string): string {
  // Path separators (both flavors) never survive: client paths must not
  // leak into the uploads dir — take the final segment, then scrub.
  const base = (name.split(/[\\/]/).pop() ?? '').normalize('NFKD');
  let cleaned = '';
  for (const char of base) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32) continue;
    cleaned += char;
  }
  cleaned = cleaned.replace(/[^\p{L}\p{N}._ +-]/gu, '_').replace(/^\.+/, '');
  if (cleaned.length > MAX_ATTACHMENT_NAME_CHARS) {
    const dot = cleaned.lastIndexOf('.');
    const ext = dot > 0 ? cleaned.slice(dot).slice(0, 17) : '';
    cleaned = `${cleaned.slice(0, MAX_ATTACHMENT_NAME_CHARS - ext.length)}${ext}`;
  }
  if (cleaned === '' || cleaned === '.' || cleaned === '..') cleaned = 'upload';
  return fitUploadNameBytes(cleaned);
}

export interface MaterializedUpload {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
}

const UPLOAD_CLAIM_PREFIX = '.gru-upload-claim-';
const UPLOAD_CLAIM_SUFFIX = '.claim';
const UPLOAD_LEGACY_RESERVATION_PREFIX = '.gru-upload-reservation-';
const UPLOAD_CLAIM_STALE_MS = 30_000;

/** Upload quota admission (Perkins r2 B1/W1/W2).
 *
 * A writer's payload bytes land FIRST in a uniquely named claim file
 * (`.gru-upload-claim-<ts>-<pid>-<uuid>.claim`); ownership lives in the
 * FILENAME, so a claim is never observed half-initialized (r2 W1: a
 * torn marker body was reclaimed as dead while its writer lived and
 * admitted 1,001 payloads). Claims plus payloads are the committed
 * count; writers elect FIFO by claim timestamp so two racers at the
 * last slot deterministically produce ONE winner (r2 B1: both-writer
 * rejection left the final slot unused). Commit is a rename of the
 * claim onto its final name — capacity-neutral, so admission cannot be
 * lost between check and write. A post-commit audit re-counts payloads
 * and sheds this writer's file if a readdir anomaly let two writers
 * commit into the last slot: conservative (a retryable 507), never an
 * overbook. Generation safety (r1 lock-race): every claim name is
 * unique; a stale generation is never reused, reclaimers unlink only
 * the exact UUID file they inspected, and no successor's claim can be
 * evicted by a late observation. Cleanup reclaims a claim only when its
 * owner pid is dead and it has aged, or immediately when it is residue
 * of THIS process (materialize is synchronous, so a self-owned claim
 * visible at entry is never mid-flight — r2 W2: a failed release must
 * not strand a slot for the process lifetime). Legacy
 * `.gru-upload-reservation-*.json` markers from the prior scheme count
 * as claims and are reclaimed once aged and not provably live. */
function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another account.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isUploadClaim(name: string): boolean {
  return name.startsWith(UPLOAD_CLAIM_PREFIX) && name.endsWith(UPLOAD_CLAIM_SUFFIX);
}

function isLegacyUploadReservation(name: string): boolean {
  return name.startsWith(UPLOAD_LEGACY_RESERVATION_PREFIX) && name.endsWith('.json');
}

function parseUploadClaim(name: string): { ts: number; pid: number } | null {
  const body = name.slice(UPLOAD_CLAIM_PREFIX.length, name.length - UPLOAD_CLAIM_SUFFIX.length);
  const [tsRaw, pidRaw] = body.split('-');
  const ts = Number(tsRaw);
  const pid = Number(pidRaw);
  if (!Number.isSafeInteger(ts) || ts <= 0) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { ts, pid };
}

function scanUploadsDir(uploadsDir: string): { payloads: string[]; claims: string[] } {
  let entries: string[];
  try {
    entries = readdirSync(uploadsDir);
  } catch (error) {
    throw new AttachError(500, `uploads quota scan failed: ${String(error)}`);
  }
  const payloads: string[] = [];
  const claims: string[] = [];
  for (const entry of entries) {
    if (isUploadClaim(entry) || isLegacyUploadReservation(entry)) claims.push(entry);
    else payloads.push(entry);
  }
  return { payloads, claims };
}

/** FIFO by creation stamp (filename ts; name breaks same-ms ties so every
 * racer computes the identical order from the same snapshot). Malformed
 * or legacy claim names rank last: they consume capacity but never steal
 * an earlier slot. */
function rankUploadClaims(claims: readonly string[]): Array<{ name: string; ts: number }> {
  return claims
    .map((name) => ({ name, ts: parseUploadClaim(name)?.ts ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function reclaimAbandonedClaim(uploadsDir: string, entry: string): void {
  try {
    unlinkSync(join(uploadsDir, entry));
  } catch (error) {
    // A concurrent reclaimer may have removed this exact generation.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new AttachError(500, `stale uploads claim cleanup failed: ${String(error)}`);
    }
  }
}

function cleanupAbandonedUploadClaims(uploadsDir: string): void {
  const { claims } = scanUploadsDir(uploadsDir);
  for (const entry of claims) {
    if (isUploadClaim(entry)) {
      const owner = parseUploadClaim(entry);
      if (owner === null) continue; // foreign/malformed name — leave it
      // Self-owned residue is never mid-flight (materialize is
      // synchronous): reclaim immediately (r2 W2). Foreign claims need
      // age AND a dead owner — a live hung writer keeps its slot (r2 W1).
      const isSelfResidue = owner.pid === process.pid;
      if (!isSelfResidue) {
        if (Date.now() - owner.ts <= UPLOAD_CLAIM_STALE_MS) continue;
        if (processIsAlive(owner.pid)) continue;
      }
      reclaimAbandonedClaim(uploadsDir, entry);
      continue;
    }
    // Legacy marker from the previous scheme: aged and not provably live.
    const marker = join(uploadsDir, entry);
    let aged = false;
    try {
      aged = Date.now() - statSync(marker).mtimeMs > UPLOAD_CLAIM_STALE_MS;
    } catch {
      continue;
    }
    if (!aged) continue;
    let live = false;
    try {
      const owner = JSON.parse(readFileSync(marker, 'utf-8')) as { pid?: unknown };
      live = typeof owner.pid === 'number' && processIsAlive(owner.pid);
    } catch {
      // Torn legacy marker: its creating build is gone once upgraded.
    }
    if (live) continue;
    reclaimAbandonedClaim(uploadsDir, entry);
  }
}

/**
 * Write clipboard/phone-origin bytes into the uploads dir and return the
 * materialized file's absolute path (ruling 19(c): THAT path is sent).
 * The dir is (re-)hardened 0700 on every write — a pre-existing loose
 * dir never stays loose past an attach (W-D discipline, write-path side).
 */
export function materializeUpload(
  uploadsDir: string,
  input: { readonly filename: string; readonly bytes: Uint8Array },
): MaterializedUpload {
  if (input.bytes.byteLength === 0) {
    throw new AttachError(400, 'upload is empty — nothing to materialize');
  }
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new AttachError(
      413,
      `upload exceeds the ${MAX_UPLOAD_BYTES} byte cap (${input.bytes.byteLength} bytes)`,
    );
  }
  mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  hardenUploadsDir(uploadsDir);
  const name = sanitizeUploadName(input.filename);
  cleanupAbandonedUploadClaims(uploadsDir);
  const stamp = Date.now();
  const claimName = `${UPLOAD_CLAIM_PREFIX}${stamp}-${process.pid}-${randomUUID()}${UPLOAD_CLAIM_SUFFIX}`;
  const claim = join(uploadsDir, claimName);
  try {
    // The claim carries the payload bytes themselves: admission, content,
    // and ownership (pid in the filename) publish atomically at dirent
    // creation — there is no initializing window a peer can misread.
    writeFileSync(claim, input.bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new AttachError(500, `uploads quota claim failed: ${String(error)}`);
  }
  let target: string;
  try {
    const { payloads, claims } = scanUploadsDir(uploadsDir);
    const free = MAX_UPLOAD_FILES - payloads.length;
    const mine = rankUploadClaims(claims).findIndex((ranked) => ranked.name === claimName);
    if (free <= 0 || mine < 0 || mine >= free) {
      throw new AttachError(
        507,
        `uploads quota exceeded (${MAX_UPLOAD_FILES} files) — prune ${uploadsDir}`,
      );
    }
    target = join(uploadsDir, `${stamp}-${randomUUID()}-${name}`);
    // Commit = rename of the claim onto its final name: capacity-neutral
    // (claim and payload each count one), and ENOENT would prove the
    // claim was reclaimed from us — the reservation is verified by the
    // commit itself, never assumed (r2 W1).
    renameSync(claim, target);
  } catch (error) {
    try {
      unlinkSync(claim);
    } catch {
      // Residue is owned by stale/self cleanup; never widen the fault.
    }
    if (error instanceof AttachError) throw error;
    throw new AttachError(500, `uploads materialization failed: ${String(error)}`);
  }
  // Hard invariant audit: if a readdir anomaly let two writers each win
  // an election that missed the other's claim, the committed count can
  // exceed the cap. Shed THIS writer's payload — conservative (a
  // retryable 507), never an overbook.
  if (scanUploadsDir(uploadsDir).payloads.length > MAX_UPLOAD_FILES) {
    try {
      unlinkSync(target);
    } catch (error) {
      throw new AttachError(500, `uploads quota audit rollback failed: ${String(error)}`);
    }
    throw new AttachError(
      507,
      `uploads quota exceeded (${MAX_UPLOAD_FILES} files) — prune ${uploadsDir}`,
    );
  }
  return { path: target, name, bytes: input.bytes.byteLength };
}

// ---------------------------------------------------------------------------
// On-disk browse (workspace root = the canonical namespace; no bytes)
// ---------------------------------------------------------------------------

export interface BrowseEntry {
  readonly name: string;
  readonly kind: 'dir' | 'file';
  readonly size: number | null;
  readonly image: boolean;
  /** False for a symlink whose real target leaves the workspace root. */
  readonly pickable: boolean;
}

export interface BrowseResult {
  /** The workspace root's ABSOLUTE path — chips join it onto relative
   * picks so the agent receives a real absolute path to read. */
  readonly root: string;
  /** Normalized workspace-relative path ('' at the root). */
  readonly path: string;
  /** Parent dir's relative path, or null at the root. */
  readonly parent: string | null;
  readonly entries: readonly BrowseEntry[];
  /** True when the listing hit MAX_BROWSE_ENTRIES (the picker says so). */
  readonly truncated: boolean;
}

/**
 * List one directory under the workspace root. Containment is enforced
 * on REALPATHS (symlinks cannot tunnel out — ruling: the workspace root
 * is the canonical namespace, nothing escapes it). Returns metadata
 * only: no file bytes ever move through browse (ruling 19(c) no-copy).
 */
export function browseWorkspace(workspaceRoot: string, relPath: string): BrowseResult {
  if (relPath.includes('\0')) throw new AttachError(400, 'invalid browse path');
  const rootReal = realpathOrThrow(workspaceRoot, 500, 'workspace root is unreadable');
  const wanted = resolve(workspaceRoot, relPath);
  const wantedReal = realpathOrThrow(wanted, 404, `no such directory under the workspace root: ${relPath}`);
  if (!isInsideOrEqual(rootReal, wantedReal)) {
    throw new AttachError(400, 'browse path escapes the workspace root');
  }
  const stats = statSync(wantedReal);
  if (!stats.isDirectory()) {
    throw new AttachError(404, `not a directory: ${relPath}`);
  }
  const dirents = readdirSync(wantedReal, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    // Dot entries (.git, .env) never show on the pick surface.
    if (dirent.name.startsWith('.')) continue;
    // Symlinks are part of the namespace (review r1: silently hiding
    // them made symlinked repos/dirs invisible): resolve the TARGET's
    // type; broken targets drop out. The PATH sent on pick is the
    // lexical in-workspace path — containment holds on the reference.
    let isDir: boolean;
    let isFile: boolean;
    let pickable = true;
    if (dirent.isSymbolicLink()) {
      try {
        const entryPath = join(wantedReal, dirent.name);
        const targetReal = realpathSync(entryPath);
        const target = statSync(targetReal);
        isDir = target.isDirectory();
        isFile = target.isFile();
        pickable = isInsideOrEqual(rootReal, targetReal);
      } catch {
        continue; // broken symlink — not listable
      }
    } else {
      isDir = dirent.isDirectory();
      isFile = dirent.isFile();
    }
    if (!isDir && !isFile) continue; // sockets/fifos are not pickable
    // Count only entries the picker could render. Dot entries, broken
    // symlinks, and sockets beyond item 500 must not create a false
    // "listing truncated" warning.
    if (entries.length >= MAX_BROWSE_ENTRIES) {
      truncated = true;
      break;
    }
    if (isDir) {
      entries.push({ name: dirent.name, kind: 'dir', size: null, image: false, pickable });
      continue;
    }
    let size: number | null = null;
    try {
      size = statSync(join(wantedReal, dirent.name)).size;
    } catch {
      /* raced away — list it without a size */
    }
    entries.push({
      name: dirent.name,
      kind: 'file',
      size,
      image: attachmentKindFor(dirent.name) === 'image',
      pickable,
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const rel =
    wantedReal === rootReal ? '' : safeRelative(rootReal, wantedReal);
  const parent = rel === '' ? null : (rel.split('/').slice(0, -1).join('/') || '');
  return { root: rootReal, path: rel, parent, entries, truncated };
}

/** True when `dir` exists with a mode looser than 0700 on its permission
 * bits (W-D: creation-only 0700 left pre-existing 0755 dirs untouched). */
export function uploadsDirNeedsHardening(dir: string): boolean {
  try {
    const mode = statSync(dir).mode & 0o777;
    return mode !== 0o700;
  } catch {
    return false; // absent → the creator path (mkdir 0700) owns it
  }
}

/** chmod the uploads dir to 0700; throws on failure (boot refuses). */
export function hardenUploadsDir(dir: string): void {
  chmodSync(dir, 0o700);
}

/**
 * Chip-path provenance (review r1): a chip the product sends must point
 * into the workspace root (on-disk picks) or the instance uploads dir
 * (materialized content) — the two homes the ONE flow produces. True =
 * allowed; false = the delivery layer degrades gracefully (drops the
 * chip from the manifest + surfaces a notice — never a silent pass).
 */
export function chipPathAllowed(
  workspaceRoot: string,
  uploadsDir: string,
  chipPath: string,
): boolean {
  if (isAbsolute(chipPath) !== true) return false;
  let chipReal: string;
  try {
    chipReal = realpathSync(chipPath);
  } catch {
    return false; // nonexistent is never a deliverable path
  }
  for (const home of [workspaceRoot, uploadsDir]) {
    try {
      if (isInsideOrEqual(realpathSync(home), chipReal)) return true;
    } catch {
      // One home may not exist yet (fresh uploads dir); check the other.
    }
  }
  return false;
}

function realpathOrThrow(path: string, status: number, message: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new AttachError(status, `${message} (${String(error)})`);
  }
}

function safeRelative(from: string, to: string): string {
  const rel = relative(from, to);
  // Normalize only the host separator. On POSIX, a literal backslash is a
  // valid filename character and must not be rewritten into navigation.
  return rel.split(sep).join('/');
}
