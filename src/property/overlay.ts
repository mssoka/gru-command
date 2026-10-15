import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { OverlayIdentity } from './types.js';

/**
 * Explicit test-overlay application (GH350 seam B).
 *
 * The overlay is the honest representation of reviewer-proposed test bytes:
 * the source SHA alone never identifies what was actually executed. Every
 * applied file is hashed (sha256 + byte length) and the aggregate
 * `overlaySha256` binds the whole overlay as one identity.
 *
 * This module only ADDS the overlay representation; it never writes into a
 * source tree and never weakens clean-tree/exact-head verification living
 * elsewhere. Files land inside the isolated workspace handed in by the
 * executor, never next to the source.
 */

/** One proposed test file: workspace-relative path plus exact bytes. */
export interface OverlayInputFile {
  readonly path: string;
  readonly content: string;
}

/** Bounds for overlay application; exceeding any bound is a named error. */
export interface OverlayBounds {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const OVERLAY_DEFAULT_BOUNDS: OverlayBounds = {
  maxFiles: 64,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
};

export class OverlayPathError extends Error {
  readonly code = 'overlay-path';
  constructor(message: string) {
    super(message);
    this.name = 'OverlayPathError';
  }
}

export class OverlayBoundsError extends Error {
  readonly code = 'overlay-bounds';
  constructor(message: string) {
    super(message);
    this.name = 'OverlayBoundsError';
  }
}

export class OverlayIntegrityError extends Error {
  readonly code = 'overlay-integrity';
  constructor(message: string) {
    super(message);
    this.name = 'OverlayIntegrityError';
  }
}

/** Digest one overlay file's identity (path stays the caller's business). */
export function overlayFileIdentity(content: string): { readonly sha256: string; readonly bytes: number } {
  return { sha256: sha256Hex(content), bytes: Buffer.byteLength(content, 'utf-8') };
}

/**
 * Aggregate overlay identity: sha256 over the canonical, path-sorted list
 * of per-file identities. Input order never changes the aggregate, so the
 * same overlay always carries the same identity bytes.
 */
export function computeOverlayIdentity(
  files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[],
): string {
  const canonical = [...files]
    .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\n${file.sha256}\n${file.bytes}\n`)
    .join('');
  return sha256Hex(canonical);
}

/** sha256 of a string's utf-8 bytes, hex-encoded. */
export function sha256Hex(data: string): string {
  return createHash('sha256').update(Buffer.from(data, 'utf-8')).digest('hex');
}

/**
 * Validate one overlay path against the isolated workspace and return the
 * absolute target. Rejects absolute paths, `..` segments, empty paths and
 * any path whose parent chain resolves (through copied symlinks) outside
 * the workspace root.
 */
function resolveOverlayTarget(workspaceRoot: string, relPath: string): string {
  const segments = relPath.split('/');
  if (!relPath || isAbsolute(relPath) || /[\\:]/u.test(relPath) || [...relPath].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || relPath.startsWith('-') || segments.some((part) => !part || part === '.' || part === '..')) {
    throw new OverlayPathError(`overlay path must be a safe relative path: ${JSON.stringify(relPath)}`);
  }
  // Check BEFORE mkdir: a planted link must not even create an empty
  // directory outside the workspace. No untrusted process is running yet.
  let parent = realpathSync(workspaceRoot);
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    const info = lstatSync(parent, { throwIfNoEntry: false });
    if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) throw new OverlayPathError(`overlay parent is not an ordinary directory: ${parent}`);
    if (info === undefined) mkdirSync(parent);
  }
  return join(parent, segments.at(-1)!);
}

/**
 * Apply proposed test files as an explicit overlay inside the isolated
 * workspace. Returns the overlay identity computed from the bytes actually
 * written — callers comparing against a pre-computed identity get tamper
 * detection for free (mismatch ⇒ {@link OverlayIntegrityError}).
 */
export function applyOverlayFiles(input: {
  readonly workspaceRoot: string;
  readonly files: readonly OverlayInputFile[];
  readonly bounds?: OverlayBounds;
  readonly expectedIdentity?: string | null;
}): OverlayIdentity {
  const { workspaceRoot, files } = input;
  const bounds = input.bounds ?? OVERLAY_DEFAULT_BOUNDS;
  if (files.length > bounds.maxFiles) {
    throw new OverlayBoundsError(`overlay exceeds maxFiles=${bounds.maxFiles}, got ${files.length} files`);
  }
  const identities: { path: string; sha256: string; bytes: number }[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (seen.has(file.path)) throw new OverlayPathError(`duplicate overlay path: ${file.path}`);
    seen.add(file.path);
    const bytes = Buffer.byteLength(file.content, 'utf-8');
    if (bytes > bounds.maxFileBytes) {
      throw new OverlayBoundsError(
        `overlay file ${file.path} is ${bytes} bytes, over maxFileBytes=${bounds.maxFileBytes}`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > bounds.maxTotalBytes) {
      throw new OverlayBoundsError(`overlay exceeds maxTotalBytes=${bounds.maxTotalBytes}`);
    }
    const target = resolveOverlayTarget(workspaceRoot, file.path);
    // An existing regular file (from the workspace copy) is replaced by the
    // overlay byte-for-byte; the overlay is the explicit authority for these
    // paths. A SYMLINK at the target is refused — lstat, never stat, so a
    // link is never silently written through.
    const current = lstatSync(target, { throwIfNoEntry: false });
    if (current !== undefined && (!current.isFile() || current.nlink !== 1)) {
      throw new OverlayPathError(
        `overlay path ${file.path} currently names a non-file entry; refusing to replace it (${target})`,
      );
    }
    writeFileSync(target, file.content);
    identities.push({ path: file.path, ...overlayFileIdentity(file.content) });
  }
  const overlaySha256 = computeOverlayIdentity(identities);
  if (
    input.expectedIdentity !== null &&
    input.expectedIdentity !== undefined &&
    input.expectedIdentity !== overlaySha256
  ) {
    throw new OverlayIntegrityError(
      `applied overlay identity ${overlaySha256} does not match the recorded overlay identity ${input.expectedIdentity} — the tested bytes are not the recorded bytes`,
    );
  }
  return { files: identities, overlaySha256 };
}
