import type { SessionManager } from '@earendil-works/pi-coding-agent';

/**
 * What a resumed transcript can be when this runtime must not adopt it.
 *
 * Both errors are UNRECOVERABLE AT THE BOUNDARY: retrying the same file can
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
  return error instanceof ForeignSessionRuntimeError || error instanceof CorruptSessionTreeError;
}

/** The slice of the SDK session manager this guard reads (type-only import:
 * the chat layer may import this module without loading the SDK). */
type SessionTreeSource = Pick<SessionManager, 'getHeader' | 'getEntries'>;

interface TreeEntry {
  readonly id?: unknown;
  readonly parentId?: unknown;
}

/**
 * Bounded preflight on a resume candidate, run AFTER the session is opened and
 * BEFORE anything projects it.
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
 * Also refuses a transcript whose header names another runtime: the label is
 * written by whoever created the file (claude-code always does), and a
 * migrated-in-place pi transcript keeps it.
 */
export function assertResumableTree(
  sessionManager: SessionTreeSource,
  file: string,
  expectedRuntime: string,
): void {
  const header = sessionManager.getHeader() as { readonly runtime?: unknown } | null;
  const found = header?.runtime;
  // pi's own headers carry NO runtime field, so only a positive foreign label
  // is evidence; an unlabelled header is the normal pi shape.
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
