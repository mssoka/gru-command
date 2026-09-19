import {
  chmodSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { relative } from 'node:path';

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
  return cleaned;
}

export interface MaterializedUpload {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
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
  // Count quota (review r1): unbounded writes could fill the data dir —
  // fail loud with a 507-class error instead of an ENOSPC boot later.
  let existing = 0;
  try {
    existing = readdirSync(uploadsDir).length;
  } catch {
    /* fresh dir — the count is zero */
  }
  if (existing >= MAX_UPLOAD_FILES) {
    throw new AttachError(507, `uploads quota exceeded (${MAX_UPLOAD_FILES} files) — prune ${uploadsDir}`);
  }
  const name = sanitizeUploadName(input.filename);
  const stamped = `${Date.now()}-${name}`;
  let target = join(uploadsDir, stamped);
  for (let n = 2; ; n++) {
    try {
      // Exclusive create: never clobber an existing materialized file.
      writeFileSync(target, input.bytes, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw new AttachError(500, `uploads write failed: ${String(error)}`);
      }
      target = join(uploadsDir, `${Date.now()}-${n}-${name}`);
    }
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
    if (entries.length >= MAX_BROWSE_ENTRIES) {
      truncated = true;
      break;
    }
    // Symlinks are part of the namespace (review r1: silently hiding
    // them made symlinked repos/dirs invisible): resolve the TARGET's
    // type; broken targets drop out. The PATH sent on pick is the
    // lexical in-workspace path — containment holds on the reference.
    let isDir: boolean;
    let isFile: boolean;
    if (dirent.isSymbolicLink()) {
      try {
        const target = statSync(join(wantedReal, dirent.name));
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue; // broken symlink — not pickable
      }
    } else {
      isDir = dirent.isDirectory();
      isFile = dirent.isFile();
    }
    if (isDir) {
      entries.push({ name: dirent.name, kind: 'dir', size: null, image: false });
      continue;
    }
    if (!isFile) continue; // sockets/fifos are not pickable
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
  if (isInsideOrEqual(uploadsDir, chipPath)) return true;
  try {
    const rootReal = realpathSync(workspaceRoot);
    const chipReal = realpathSync(chipPath);
    return isInsideOrEqual(rootReal, chipReal);
  } catch {
    // Workspace unreachable or the path does not resolve — not provably
    // one of ours.
    return false;
  }
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
  return rel.split('\\').join('/');
}
