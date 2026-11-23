import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { SessionManager } from '@earendil-works/pi-coding-agent';

/** Enough for a session header plus room for a provider prefix; the header is
 * the first line of the file and is never megabytes long. */
const HEADER_SCAN_BYTES = 64 * 1024;

/**
 * What a resumed transcript can be when this runtime must not adopt it.
 *
 * All three are UNRECOVERABLE AT THE BOUNDARY: retrying the same file can
 * never work, so the chat layer mints a fresh session instead of feeding the
 * spawn-retry gate (which would back off, then report a transient
 * "temporarily unavailable" for a file that will never heal).
 */
export class ForeignSessionRuntimeError extends Error {
  constructor(
    readonly file: string,
    readonly found: string,
    readonly expected: string,
  ) {
    super(
      `session ${file} was written by runtime ${found}; this spawn runs ${expected} — ` +
        'refusing to project a foreign transcript',
    );
    this.name = 'ForeignSessionRuntimeError';
  }
}

/** The file does not start with the session header its runtime always writes,
 * so whoever wrote it, it was not this runtime. */
export class UnrecognisedSessionError extends Error {
  constructor(
    readonly file: string,
    readonly expected: string,
    readonly detail: string,
  ) {
    super(
      `session ${file} is not a ${expected} transcript (${detail}) — ` +
        'refusing to adopt a file this runtime did not write',
    );
    this.name = 'UnrecognisedSessionError';
  }
}

export class CorruptSessionTreeError extends Error {
  constructor(
    readonly file: string,
    readonly id: string,
    readonly reason: 'duplicate-id' | 'cycle',
  ) {
    super(
      `session ${file} has an unwalkable entry tree: ${reason} at entry id ${id} ` +
        '(the runtime projects the parent chain and cannot finish on a tree that ' +
        'revisits an entry)',
    );
    this.name = 'CorruptSessionTreeError';
  }
}

/** Whether the chat layer must replace the resume boundary rather than retry. */
export function isUnusableBoundaryError(error: unknown): boolean {
  return (
    error instanceof ForeignSessionRuntimeError ||
    error instanceof UnrecognisedSessionError ||
    error instanceof CorruptSessionTreeError
  );
}

interface SessionHeader {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly runtime?: unknown;
}

/** The parsed first line of `file`, or null when the file is empty. */
function readHeadLine(file: string): string | null {
  const size = statSync(file).size;
  if (size === 0) return null;
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(size, HEADER_SCAN_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString('utf-8');
    const end = text.indexOf('\n');
    return end === -1 ? text : text.slice(0, end);
  } finally {
    closeSync(fd);
  }
}

function parseHeader(line: string): SessionHeader | null {
  if (line.trim() === '') return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as SessionHeader)
      : null;
  } catch {
    return null;
  }
}

/**
 * Pre-open gate for a pi resume candidate, run BEFORE `SessionManager.open`.
 *
 * Order matters: pi's `open` migrates a v1 transcript in place (`_loadEntries`
 * → `migrateToCurrentVersion` → `_rewriteFile`), and that migration is what
 * corrupts a claude-code transcript (its id minting never checks collisions).
 * Checking the first line here means a foreign file is refused before pi can
 * rewrite a single byte of it.
 *
 * pi always writes this header itself, so a file that lacks it was not written
 * by pi: the SDK would silently synthesise a fresh header and mint a NEW
 * session file, and the chat layer would then reject the identity change as a
 * retryable spawn failure — the incident's symptom by another road.
 */
export function assertPiResumeHeader(file: string): void {
  const line = readHeadLine(file);
  if (line === null) return; // empty file: the adapter initialises it
  const header = parseHeader(line);
  if (header === null || header.type !== 'session' || typeof header.id !== 'string') {
    throw new UnrecognisedSessionError(file, 'pi', 'its first record is not a session header');
  }
  const runtime = header.runtime;
  // pi's own headers carry NO runtime field; only a positive foreign label is
  // evidence of another writer.
  if (typeof runtime === 'string' && runtime !== '' && runtime !== 'pi') {
    throw new ForeignSessionRuntimeError(file, runtime, 'pi');
  }
}

/**
 * Pre-resume gate for the claude-code adapter, run on the head it already read.
 *
 * A Claude Code transcript starts with a frame, not a header. A file that DOES
 * start with a session header was written by something that groups a session —
 * pi (no label) or this adapter (labelled `claude-code`). A migrated-from-
 * claude pi transcript still carries every frame's `session_id`, so without
 * this check the adapter would adopt it and append raw CLI frames to a pi
 * tree, silently mixing two formats.
 */
export function assertClaudeResumeHeader(file: string, head: string): void {
  const end = head.indexOf('\n');
  const header = parseHeader(end === -1 ? head : head.slice(0, end));
  if (header === null || header.type !== 'session') return;
  const runtime = header.runtime;
  if (runtime !== 'claude-code') {
    throw new ForeignSessionRuntimeError(
      file,
      typeof runtime === 'string' && runtime !== '' ? runtime : 'pi',
      'claude-code',
    );
  }
}

/** The slice of the SDK session manager this guard reads (type-only import:
 * the chat layer may import this module without loading the SDK). */
type SessionTreeSource = Pick<SessionManager, 'getHeader' | 'getEntries'>;

interface TreeEntry {
  readonly id?: unknown;
  readonly parentId?: unknown;
}

/**
 * Post-open preflight on a resume candidate, run AFTER the session is opened
 * and BEFORE anything projects it.
 *
 * Why this exists (2026-11-23): pi's v1→v2 migration mints an id per entry
 * through a collision set it never fills, so a 163k-entry transcript lands
 * duplicate ids by simple birthday odds (~3 expected). pi's `buildSessionPath`
 * then walks `parentId` links with no visited set: a duplicated id makes the
 * index resolve to the later entry, the walk re-enters its own chain, and V8
 * ends it ~5s later with `RangeError: Invalid array length` — from deep inside
 * a projection nobody can point at. Fail here instead, by name, before the
 * spin, and let the caller mint a fresh session.
 *
 * The assumed entry shape (`id` / `parentId` strings) is pi 1.x's. An entry
 * that stops carrying them is skipped, so a future SDK change makes this guard
 * quiet rather than wrong — the pre-open header gate still refuses foreign
 * files.
 */
export function assertResumableTree(
  sessionManager: SessionTreeSource,
  file: string,
  expectedRuntime: string,
): void {
  const header = sessionManager.getHeader() as SessionHeader | null;
  const found = header?.runtime;
  if (typeof found === 'string' && found !== '' && found !== expectedRuntime) {
    throw new ForeignSessionRuntimeError(file, found, expectedRuntime);
  }

  const parentOf = new Map<string, string | null>();
  for (const raw of sessionManager.getEntries()) {
    const entry = raw as TreeEntry;
    const id = entry.id;
    if (typeof id !== 'string' || id === '') continue;
    if (parentOf.has(id)) throw new CorruptSessionTreeError(file, id, 'duplicate-id');
    parentOf.set(id, typeof entry.parentId === 'string' ? entry.parentId : null);
  }

  // One pass, iterative: each entry has at most one parent, so a chain is
  // either acyclic (ends at null / an unknown id) or a cycle. Entries proven
  // safe are remembered, keeping the whole check O(n).
  const safe = new Set<string>();
  for (const start of parentOf.keys()) {
    if (safe.has(start)) continue;
    const walked: string[] = [];
    const onPath = new Set<string>();
    let current: string | null = start;
    while (current !== null && !safe.has(current)) {
      if (onPath.has(current)) throw new CorruptSessionTreeError(file, current, 'cycle');
      onPath.add(current);
      walked.push(current);
      current = parentOf.get(current) ?? null;
    }
    for (const id of walked) safe.add(id);
  }
}
