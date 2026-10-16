import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { oneLineErrorText } from './error-text.js';
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
function resolveOverlayTarget(workspaceRoot: string, relPath: string, onCreatedDirectory?: (dir: string) => void): string {
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
    if (info === undefined) { mkdirSync(parent); onCreatedDirectory?.(parent); }
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

/** All-or-nothing overlay into a LIVE tree (#380): applyOverlayFiles writes
 * file by file, so a later refusal or write error would leave a partial set.
 * Every target's prior state is captured first — creating only the parent
 * directories a VALIDATED path needs, each recorded as it is made; on any
 * failure each file the call created is removed, each file it overwrote is
 * re-created byte-for-byte with its mode (never written through a link
 * swapped in meanwhile), and each directory it made is removed deepest
 * first; then the original error is rethrown, or — when part of the
 * rollback itself fails — an AggregateError carrying it and every cause. */
export function applyOverlayFilesAllOrNothing(input: Parameters<typeof applyOverlayFiles>[0]): OverlayIdentity {
  const createdDirs = new Set<string>();
  const prior: { readonly target: string; readonly state: 'absent' | 'file' | 'other'; readonly content: Buffer | null; readonly mode: number | null; readonly inode: string | null }[] = [];
  const rollback = (error: unknown): never => {
    const failures: unknown[] = [];
    for (const { target, state, content, mode, inode } of prior) {
      // A pre-existing non-file entry is never written (applyOverlayFiles
      // refuses it), so it is never touched here either.
      if (state === 'other') continue;
      try {
        if (state === 'file' && content !== null && mode !== null) {
          // A file the failed apply never touched is left exactly as it is
          // (same inode, links and times): judged by its device and inode,
          // mode and bytes. The check is only a shortcut — one that cannot
          // read the target never skips, and the target is restored.
          let untouched = false;
          try {
            const current = lstatSync(target, { throwIfNoEntry: false, bigint: true });
            untouched = current?.isFile() === true && `${String(current.dev)}:${String(current.ino)}` === inode && Number(current.mode & 0o7777n) === mode && readFileSync(target).equals(content);
          } catch { untouched = false; }
          if (untouched) continue;
          // Re-created beside the target (a short name, never too long), then
          // renamed over it in one step: the original bytes are never absent
          // from the target path, and a link swapped in meanwhile is
          // replaced, never written through. A failed step removes its copy.
          const restored = join(dirname(target), `.gru-restore-${randomUUID()}`);
          try {
            writeFileSync(restored, content, { flag: 'wx', mode });
            chmodSync(restored, mode); // exact, whatever the umask
            renameSync(restored, target);
          } catch (stepError) {
            try { rmSync(restored, { force: true }); } catch (cleanupError) {
              throw new AggregateError([stepError, cleanupError], `restoring ${target} failed and its copy ${restored} could not be removed`);
            }
            throw stepError;
          }
        } else {
          rmSync(target, { force: true });
        }
      } catch (restoreError) { failures.push(restoreError); }
    }
    for (const dir of [...createdDirs].reverse()) {
      try { rmdirSync(dir); } catch (removeError) { failures.push(removeError); }
    }
    if (failures.length > 0) throw new AggregateError([error, ...failures], `overlay write failed and its rollback was incomplete: ${oneLineErrorText(error, 300)}`);
    throw error;
  };
  try {
    for (const file of input.files) {
      const target = resolveOverlayTarget(input.workspaceRoot, file.path, (dir) => { createdDirs.add(dir); });
      // Device and inode as bigints: exact, whatever the filesystem's numbers.
      const current = lstatSync(target, { throwIfNoEntry: false, bigint: true });
      const regular = current !== undefined && current.isFile();
      prior.push({ target, state: current === undefined ? 'absent' : regular ? 'file' : 'other',
        content: regular ? readFileSync(target) : null, mode: regular ? Number(current.mode & 0o7777n) : null,
        inode: regular ? `${String(current.dev)}:${String(current.ino)}` : null });
    }
    return applyOverlayFiles(input);
  } catch (error) {
    return rollback(error);
  }
}
