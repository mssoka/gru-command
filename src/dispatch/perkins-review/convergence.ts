import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { repositoryGitEnv } from './artifacts.js';
import type { CanonicalReviewVerdict, VerifiedFinding } from './types.js';

/**
 * Stage-5 review convergence (issue #225): delta rounds with carry-forward,
 * a deterministic convergence rule from round 3, and the final whole-change
 * pass at the READY candidate.
 *
 * Ownership split (unchanged): the lead keeps verdict authority over which
 * findings exist and what they say; the HOST owns this policy — which prior
 * findings are carried forward without re-verification, which new findings
 * may hold the PR, and when the whole-change authority re-runs. Every
 * classification is deterministic and disclosed in the consolidated record.
 */

/** Bound for the prior-target..target delta diff, mirroring the frozen
 * whole-diff bound: a delta larger than a reviewable diff cannot drive a
 * delta round and is disclosed as unavailable (whole-change authority). */
export const DELTA_DIFF_MAX_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

/** One changed-line range in the NEW file of the reviewed branch. `added`
 * ranges are lines the delta introduced (exact, context excluded); `seam`
 * ranges anchor removals — the new-file line where content was deleted and
 * its neighbour — so a finding about deleted code can still intersect. */
export interface DeltaHunk {
  readonly path: string;
  readonly kind: 'added' | 'seam' | 'metadata';
  /** Inclusive 1-based new-file line range. */
  readonly startLine: number;
  readonly endLine: number;
}

/** The reviewed delta between one last-reviewed SHA and this round's frozen
 * target: the raw bounded diff, its parsed hunks, and the touched paths
 * (EVERY file the delta names, including mode-only changes). */
export interface DeltaSince {
  readonly fromSha: string;
  readonly toSha: string;
  readonly diff: string;
  readonly hunks: readonly DeltaHunk[];
  readonly touchedPaths: ReadonlySet<string>;
}

export interface ParsedFindingLocation {
  readonly path: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
}

/** A location line number is usable only as a bounded safe integer: an
 * oversized digit run becomes Infinity and would otherwise silently defer
 * a blocker on a touched file. */
function boundedLineNumber(text: string): number | null {
  if (!/^\d{1,9}$/u.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** Parse the review location contract (`path:line`, `path:start-end`,
 * `path:hunk`, `N/A`). Paths cannot contain colons (the finding schema
 * forbids them), so the first colon separates path from the line part.
 * Returns null for a location that names no real file path — the same
 * rule as the host's findingPath: no absolute paths, no traversal, no
 * empty components. */
export function parseFindingLocation(location: string): ParsedFindingLocation | null {
  const trimmed = location.trim();
  const colon = trimmed.indexOf(':');
  const path = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
  if (path === '' || path === 'N/A' || path.startsWith('-') || path.startsWith('/') ||
    path.includes('\\') || path.split('/').some((component) => component === '' || component === '.' || component === '..')) {
    return null;
  }
  if (colon === -1) return { path, startLine: null, endLine: null };
  const match = /^(\d+)(?:\s*-\s*(\d+))?/u.exec(trimmed.slice(colon + 1).trim());
  if (match === null) return { path, startLine: null, endLine: null };
  const startLine = boundedLineNumber(match[1]!);
  const endLine = match[2] !== undefined ? boundedLineNumber(match[2]) : startLine;
  if (startLine === null || endLine === null) return { path, startLine: null, endLine: null };
  return { path, startLine, endLine: Math.max(startLine, endLine) };
}

/** Decode one Git C-quoted path (the `"..."` form git uses for names with
 * spaces, quotes or control bytes). Escapes are BYTES: octal escapes decode
 * as their byte value and plain characters as UTF-8 bytes, then the whole
 * sequence decodes as UTF-8 (so `\303\251` is `é`, not `Ã©`). Iteration is
 * by CODE POINT so a non-BMP character (an emoji) is never split into
 * surrogate halves. Unknown escapes keep their literal byte; malformed
 * quoting returns null so the caller fails closed. */
function unquoteGitPath(text: string): string | null {
  if (!text.startsWith('"')) return text;
  if (!text.endsWith('"') || text.length < 2) return null;
  const bytes: number[] = [];
  const inner = text.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]!;
    if (character !== '\\') {
      // Re-encode the full code point, never a lone surrogate.
      const codePoint = inner.codePointAt(index)!;
      const full = String.fromCodePoint(codePoint);
      for (const byte of Buffer.from(full, 'utf8')) bytes.push(byte);
      index += full.length - 1;
      continue;
    }
    index += 1;
    if (index >= inner.length) return null;
    const escaped = inner[index]!;
    const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
    if (simple[escaped] !== undefined) {
      bytes.push(simple[escaped]!);
      continue;
    }
    const octal = /^[0-7]{1,3}/u.exec(inner.slice(index))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += octal.length - 1;
      continue;
    }
    for (const byte of Buffer.from(escaped, 'utf8')) bytes.push(byte);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Every well-formed `a/<path> b/<path>` split of a `diff --git` line,
 * quoted or bare. Bare paths may contain ` b/` themselves, so more than one
 * split can be well-formed; the consumer resolves the ambiguity only after
 * seeing whether rename/copy metadata or ---/+++ headers name the real
 * paths. A quoted header (git quotes when the name needs it) is exact. */
function parseDiffHeaderCandidates(rest: string): { readonly oldPath: string; readonly newPath: string }[] {
  if (rest.startsWith('"')) {
    let cursor = 0;
    let inString = false;
    let escaped = false;
    for (; cursor < rest.length; cursor += 1) {
      const character = rest[cursor]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === ' ' && cursor > 0) break;
    }
    const oldPath = unquoteGitPath(rest.slice(0, cursor));
    const newPath = unquoteGitPath(rest.slice(cursor + 1));
    if (oldPath === null || newPath === null) return [];
    return [{ oldPath, newPath }];
  }
  const candidates: { oldPath: string; newPath: string }[] = [];
  for (let index = 2; index < rest.length; index += 1) {
    if (rest[index] !== ' ') continue;
    const left = rest.slice(0, index);
    const right = rest.slice(index + 1);
    if (left.startsWith('a/') && right.startsWith('b/')) candidates.push({ oldPath: left, newPath: right });
  }
  return candidates;
}

/** Strip the `a/` / `b/` prefix a diff path carries (quoted or bare). */
function stripDiffPrefix(value: string, prefix: 'a' | 'b'): string | null {
  if (value === '/dev/null') return null;
  const unquoted = value.startsWith('"') ? unquoteGitPath(value) : value;
  if (unquoted === null) return null;
  return unquoted.startsWith(`${prefix}/`) ? unquoted.slice(2) : unquoted;
}

/**
 * Parse one unified diff into (a) the exact NEW-file line ranges the delta
 * ADDED — context lines are deliberately excluded, so unchanged hunk
 * context can never hold another round — (b) removal seams (the new-file
 * position where lines were deleted and its neighbour, so a grounded
 * finding about removed code still intersects), and (c) every path the
 * delta names, including mode-only changes that emit no hunks.
 */
export function parseDeltaStructure(diff: string): {
  readonly hunks: readonly DeltaHunk[];
  readonly paths: ReadonlySet<string>;
} {
  const hunks: DeltaHunk[] = [];
  const paths = new Set<string>();
  const unhunked = new Set<string>();
  const hunked = new Set<string>();
  let path: string | null = null;
  let headerCandidates: { readonly oldPath: string; readonly newPath: string }[] | null = null;
  let newLine = 0;
  let addedStart: number | null = null;
  let inHunk = false;
  const flushAdded = (): void => {
    if (addedStart !== null && path !== null) {
      hunks.push({ path, kind: 'added', startLine: addedStart, endLine: newLine - 1 });
      hunked.add(path);
    }
    addedStart = null;
  };
  const notePath = (next: string | null): void => {
    path = next;
    if (next !== null) paths.add(next);
  };
  /** A `diff --git` header is authoritative only when nothing better names
   * the paths: rename/copy metadata DISCARDS it, ---/+++ headers override
   * it, and a mode-only change (no other lines) falls back to the
   * same-path pair — the only case where the ambiguous bare split must be
   * resolved from the header alone. */
  const resolveHeaderCandidates = (): void => {
    const candidates = headerCandidates;
    headerCandidates = null;
    if (candidates === null || candidates.length === 0) return;
    const preferred = candidates.find((candidate) =>
      candidate.oldPath.slice(2) === candidate.newPath.slice(2)) ?? candidates[candidates.length - 1]!;
    const next = stripDiffPrefix(preferred.newPath, 'b');
    if (next !== null) {
      notePath(next);
      unhunked.add(next);
    }
  };
  for (const line of diff.split('\n')) {
    // Hunk BODY first: inside a hunk, a line like `+++ foo;` is added
    // content (`++ foo;`), never a file header. Only when the parser is
    // OUTSIDE a hunk may the header spellings be interpreted.
    if (inHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) {
      if (line.startsWith('+')) {
        if (addedStart === null) addedStart = newLine;
        newLine += 1;
        continue;
      }
      if (line.startsWith('-')) {
        flushAdded();
        // The removed lines occupied the position before `newLine`: anchor
        // the seam at the surviving neighbour and the insertion point.
        if (path !== null) {
          hunks.push({ path, kind: 'seam', startLine: Math.max(1, newLine - 1), endLine: Math.max(1, newLine) });
          hunked.add(path);
        }
        continue;
      }
      if (line.startsWith(' ')) {
        flushAdded();
        newLine += 1;
        continue;
      }
      continue; // `\ No newline at end of file`
    }
    // Outside a hunk: any line that is not a structural marker ends it.
    flushAdded();
    inHunk = false;
    if (line.startsWith('diff --git ')) {
      resolveHeaderCandidates();
      headerCandidates = parseDiffHeaderCandidates(line.slice('diff --git '.length));
      continue;
    }
    if (line.startsWith('--- ')) {
      resolveHeaderCandidates();
      const previous = stripDiffPrefix(line.slice(4).trimEnd(), 'a');
      if (previous !== null) notePath(previous);
      continue;
    }
    if (line.startsWith('+++ ')) {
      // A deletion's `/dev/null` keeps the path from the rename metadata or
      // the `---`/diff header (the deleted file's own path).
      resolveHeaderCandidates();
      const next = stripDiffPrefix(line.slice(4).trimEnd(), 'b');
      if (next !== null) notePath(next);
      continue;
    }
    if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      // Rename/copy metadata is authoritative: the ambiguous bare header
      // split must not contribute a bogus destination. The SOURCE stays a
      // touched path (the file was removed there) without a line span.
      headerCandidates = null;
      const source = line.slice(line.indexOf(' from ') + 6);
      const decoded = source.startsWith('"') ? unquoteGitPath(source) : source;
      if (decoded !== null && decoded !== '') paths.add(decoded);
      continue;
    }
    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      headerCandidates = null;
      const destination = line.slice(line.indexOf(' to ') + 4);
      const decoded = destination.startsWith('"') ? unquoteGitPath(destination) : destination;
      if (decoded !== null && decoded !== '') {
        notePath(decoded);
        unhunked.add(decoded);
      }
      continue;
    }
    const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunkHeader !== null) {
      inHunk = true;
      newLine = boundedLineNumber(hunkHeader[1]!) ?? 1;
      continue;
    }
    // Any other metadata (index/old mode/new mode/similarity) is ignored.
  }
  flushAdded();
  resolveHeaderCandidates();
  // A touched path with NO line hunk at all (mode-only or other metadata
  // change) still changed: findings on it can never be proven outside the
  // delta, so the whole file intersects.
  for (const untouched of unhunked) {
    if (!hunked.has(untouched)) {
      hunks.push({ path: untouched, kind: 'metadata', startLine: 0, endLine: Number.MAX_SAFE_INTEGER });
    }
  }
  return { hunks, paths };
}

/** Back-compat thin wrapper over parseDeltaStructure for hunk consumers. */
export function parseDeltaHunks(diff: string): readonly DeltaHunk[] {
  return parseDeltaStructure(diff).hunks;
}

/** Read one bounded `git diff` and parse it into delta structure. Used by
 * the commit-to-commit delta; the integration unit reads its bytes through
 * `diffForPaths`, which mirrors the same spawn, byte bound and timeout.
 * Throws when git cannot produce the diff. */
function boundedDelta(repoPath: string, fromSha: string, toSha: string, label: string): DeltaSince {
  let diff: string;
  try {
    diff = execFileSync('git', ['-C', repoPath, 'diff', '--no-ext-diff', '--no-color', '--unified=3', fromSha, toSha, '--'], {
      encoding: 'utf8', env: repositoryGitEnv(false), maxBuffer: 128 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    throw new Error(`${label} could not be read: ${String(error)}`);
  }
  if (Buffer.byteLength(diff, 'utf8') > DELTA_DIFF_MAX_BYTES) {
    throw new Error(`${label} exceeds ${DELTA_DIFF_MAX_BYTES} UTF-8 bytes`);
  }
  const { hunks, paths } = parseDeltaStructure(diff);
  return {
    fromSha, toSha, diff, hunks,
    touchedPaths: new Set([...paths, ...hunks.map((hunk) => hunk.path)]),
  };
}

/** Read the bounded prior-target..target delta from the frozen repository.
 * Throws when git cannot produce the delta: callers decide the fail-closed
 * direction (carry-forward narrows; the convergence rule disables). */
export function deltaSince(repoPath: string, fromSha: string, toSha: string): DeltaSince {
  if (!/^[0-9a-f]{40}$/u.test(fromSha) || !/^[0-9a-f]{40}$/u.test(toSha)) {
    throw new Error('delta endpoints must be full commit SHAs');
  }
  return boundedDelta(repoPath, fromSha, toSha, `delta since ${fromSha.slice(0, 12)}`);
}

/** The integration review unit: the feature head H0 a prior round covered,
 * the prior pinned base B0, and the advanced incoming base B1. The unit is
 * the part of the new whole diff `B1..H1` whose per-path content OR file
 * mode differs from the prior round's frozen whole diff `B0..H0`: unchanged
 * feature work (identical per-path blobs and modes) and incoming-base-only
 * files (absent from `B1..H1`) drop out, while manual conflict resolutions
 * that leave the candidate differing from the incoming base, new feature
 * edits and BOTH-sides interaction sites are all reviewed. A resolution that
 * makes H1 match B1 on a feature-touched path leaves no candidate change to
 * review (the path is absent from `B1..H1`), so it is not in the unit.
 * `carryPaths` is every path whose content or mode changed between H0 and H1
 * — the sound "changed since the prior covered head" set for carry-forward,
 * so a base-changed file is re-verified even when it is not in the unit. */
export interface IntegrationDelta extends DeltaSince {
  readonly priorTargetSha: string;
  readonly priorDiffBaseSha: string;
  readonly incomingBaseSha: string;
  /** The integration-unit paths (new/changed review work). */
  readonly integrationPaths: readonly string[];
  /** Paths whose content or mode changed between H0 and H1 (carry scope). */
  readonly carryPaths: ReadonlySet<string>;
  /** Paths the PRIOR round changed that the current candidate no longer
   * differs from its base on: a resolution discarded the reviewed feature
   * change. Nothing textual remains to diff, but the review must still owe
   * the whole-candidate authority rather than certify it. */
  readonly droppedFeaturePaths: readonly string[];
}

interface RawChange {
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldSha: string;
  readonly newSha: string;
}

/** Per-path blob pair and modes of a `git diff --raw -z --no-renames
 * --abbrev=40` change set. The NUL-delimited form needs no C-unquote
 * decoding; a path that does not decode as UTF-8 refuses (the caller falls
 * back to a whole review). Modes are kept so a mode-only change is not lost. */
function rawChanges(repoPath: string, fromSha: string, toSha: string): Map<string, RawChange> {
  let bytes: Buffer;
  try {
    bytes = execFileSync('git', ['-C', repoPath, 'diff', '--raw', '-z', '--no-ext-diff', '--no-renames', '--abbrev=40', fromSha, toSha, '--'], {
      env: repositoryGitEnv(false), maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    }) as Buffer;
  } catch (error) {
    throw new Error(`change set ${fromSha.slice(0, 12)}..${toSha.slice(0, 12)} could not be read: ${String(error)}`);
  }
  // Paths are raw bytes: decode strictly so an invalid UTF-8 path fails
  // closed instead of being silently mangled into a path that matches
  // nothing. A legitimate U+FFFD is valid UTF-8 and is preserved.
  let output: string;
  try {
    output = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('a changed path is not valid UTF-8');
  }
  const changes = new Map<string, RawChange>();
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index]!;
    if (!header.startsWith(':')) continue;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [A-Z]\d*$/u.exec(header);
    // A header that starts a raw record but does not parse is unexpected
    // output: fail closed (the caller reviews whole) rather than silently
    // shrink the reviewed unit and the carry scope.
    if (match === null) throw new Error('git diff --raw produced an unparseable record');
    const path = fields[index + 1];
    // A missing/empty path field is the same fail-open class: refuse it.
    if (path === undefined || path === '') throw new Error('git diff --raw produced a record with no path');
    index += 1;
    changes.set(path, { oldMode: match[1]!, newMode: match[2]!, oldSha: match[3]!, newSha: match[4]! });
  }
  return changes;
}

/** The exact new-whole-diff bytes for a selected path set, bounded like the
 * frozen diff. Read-only git — no `merge-tree`, no object-store writes. */
function diffForPaths(repoPath: string, fromSha: string, toSha: string, paths: readonly string[]): string {
  if (paths.length === 0) return '';
  let diff: string;
  try {
    diff = execFileSync('git', [
      '-C', repoPath, 'diff', '--no-ext-diff', '--no-color', '--find-renames', '--find-copies', '--unified=3',
      fromSha, toSha, '--', ...paths.map((path) => `:(literal)${path}`),
    ], { encoding: 'utf8', env: repositoryGitEnv(false), maxBuffer: 128 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    throw new Error(`integration unit for ${toSha.slice(0, 12)} could not be read: ${String(error)}`);
  }
  if (Buffer.byteLength(diff, 'utf8') > DELTA_DIFF_MAX_BYTES) {
    throw new Error(`integration unit for ${toSha.slice(0, 12)} exceeds ${DELTA_DIFF_MAX_BYTES} UTF-8 bytes`);
  }
  return diff;
}

/** A path argument list this long is well past any bounded review diff; the
 * round then refuses rather than truncate (the caller reviews whole). */
const INTEGRATION_UNIT_MAX_PATHS = 4000;

/** Read the integration review unit for a forward-integrated candidate. The
 * caller must already have proven the lineage (see probeIntegrationLineage);
 * this only reads bytes and fails closed when git cannot produce the unit. */
export function integrationSince(
  repoPath: string, priorTargetSha: string, priorDiffBaseSha: string, incomingBaseSha: string, currentTargetSha: string,
): IntegrationDelta {
  const endpoints = [priorTargetSha, priorDiffBaseSha, incomingBaseSha, currentTargetSha];
  if (endpoints.some((sha) => !/^[0-9a-f]{40}$/u.test(sha))) throw new Error('integration endpoints must be full commit SHAs');
  const prior = rawChanges(repoPath, priorDiffBaseSha, priorTargetSha);
  const now = rawChanges(repoPath, incomingBaseSha, currentTargetSha);
  const integrationPaths = [...now.keys()].filter((path) => {
    const before = prior.get(path);
    const after = now.get(path)!;
    // Untouched since the prior review: same old AND new blobs and modes. A
    // path the feature never changed (absent from the prior diff) is new work.
    if (before === undefined) return true;
    return before.oldSha !== after.oldSha || before.newSha !== after.newSha ||
      before.oldMode !== after.oldMode || before.newMode !== after.newMode;
  }).sort();
  if (integrationPaths.length > INTEGRATION_UNIT_MAX_PATHS) {
    throw new Error(`integration unit touches ${integrationPaths.length} paths, over the ${INTEGRATION_UNIT_MAX_PATHS}-path bound`);
  }
  const diff = diffForPaths(repoPath, incomingBaseSha, currentTargetSha, integrationPaths);
  const { hunks, paths } = parseDeltaStructure(diff);
  // EVERY path whose content or mode changed between H0 and H1: the sound
  // "changed since the prior covered head" set for carry-forward.
  const carryPaths = new Set(rawChanges(repoPath, priorTargetSha, currentTargetSha).keys());
  // A prior-diff path that vanished from the current candidate is DISCARDED
  // reviewed work only when its reviewed content actually changed H0..H1. A
  // base that independently adopted the same blob/mode leaves H0==H1 on that
  // path, so it is not a loss.
  const droppedFeaturePaths = [...prior.keys()]
    .filter((path) => !now.has(path) && carryPaths.has(path))
    .sort();
  return {
    fromSha: incomingBaseSha, toSha: currentTargetSha, diff, hunks,
    touchedPaths: new Set([...paths, ...hunks.map((hunk) => hunk.path)]),
    priorTargetSha, priorDiffBaseSha, incomingBaseSha, integrationPaths, droppedFeaturePaths,
    carryPaths,
  };
}

/** Git-probed ancestry of a candidate against the last covered round.
 * Every field is a necessary condition for retaining coverage: the base only
 * ADVANCED (B0 is an ancestor of B1), the feature head INTEGRATED FORWARD
 * (H0 is an ancestor of H1), and the two work streams share exactly the
 * pinned prior base (merge-base(H0,B1) === B0) rather than one already
 * containing the other. */
export interface IntegrationLineage {
  readonly baseAdvanced: boolean;
  readonly featureIntegrated: boolean;
  readonly commonBasePinned: boolean;
  /** The candidate did not change: the frozen target is the SAME commit, and
   * the new base is a descendant of the prior base AND an ancestor of that
   * target (the base adopted commits already inside the reviewed history). */
  readonly sameHeadAdoptedBase: boolean;
}

function gitIsAncestor(repoPath: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'merge-base', '--is-ancestor', ancestor, descendant], {
      env: repositoryGitEnv(false), stdio: ['ignore', 'ignore', 'ignore'], timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 1) return false;
    throw error;
  }
}

/** Probe the integration lineage in the frozen object store. Returns null
 * when the probe cannot be established (malformed SHAs or a git failure):
 * callers then review whole rather than inherit coverage. */
export function probeIntegrationLineage(
  repoPath: string,
  input: { readonly priorDiffBaseSha: string; readonly priorTargetSha: string; readonly currentDiffBaseSha: string; readonly currentTargetSha: string },
): IntegrationLineage | null {
  const shas = [input.priorDiffBaseSha, input.priorTargetSha, input.currentDiffBaseSha, input.currentTargetSha];
  if (shas.some((sha) => !/^[0-9a-f]{40}$/u.test(sha))) return null;
  try {
    const baseAdvanced = gitIsAncestor(repoPath, input.priorDiffBaseSha, input.currentDiffBaseSha);
    const featureIntegrated = gitIsAncestor(repoPath, input.priorTargetSha, input.currentTargetSha);
    // Same candidate: the base only advanced onto history already inside the
    // reviewed target (descendant of the prior base, ancestor of the head).
    const sameHeadAdoptedBase = input.priorTargetSha === input.currentTargetSha && baseAdvanced &&
      gitIsAncestor(repoPath, input.currentDiffBaseSha, input.currentTargetSha);
    if (!baseAdvanced || !featureIntegrated) {
      return { baseAdvanced, featureIntegrated, commonBasePinned: false, sameHeadAdoptedBase };
    }
    const mergeBase = execFileSync('git', ['-C', repoPath, 'merge-base', input.priorTargetSha, input.currentDiffBaseSha], {
      encoding: 'utf8', env: repositoryGitEnv(false), maxBuffer: 1024 * 1024, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { baseAdvanced, featureIntegrated, commonBasePinned: mergeBase === input.priorDiffBaseSha, sameHeadAdoptedBase };
  } catch {
    return null;
  }
}

/** Whether one finding's location intersects the delta hunks. Fail-closed
 * toward BLOCKING: a location that names no file (N/A, prose) or cannot
 * resolve to lines inside a touched file can never be proven outside the
 * delta, so it keeps its blocking power. A finding whose cited file has no
 * delta hunks at all is on untouched code by construction. */
export function findingIntersectsDelta(location: string, hunks: readonly DeltaHunk[]): boolean {
  const parsed = parseFindingLocation(location);
  if (parsed === null) return true;
  // A location that is prose rather than a plausible Git path (no path
  // separator, no file extension) can never be proven outside the delta.
  const pathIsPlausible = parsed.path.includes('/') || /\.[A-Za-z0-9_-]+$/u.test(parsed.path);
  if (!pathIsPlausible) return true;
  const pathHunks = hunks.filter((hunk) => hunk.path === parsed.path);
  if (pathHunks.length === 0) return false;
  if (parsed.startLine === null) return true;
  const start = parsed.startLine;
  const end = parsed.endLine ?? start;
  return pathHunks.some((hunk) => start <= hunk.endLine && end >= hunk.startLine);
}

export type PriorCarryStatus = 'carried' | 'reverify';

/** One deterministic host classification of a prior-round finding. */
export interface PriorCarryClassification {
  readonly priorIndex: number;
  readonly status: PriorCarryStatus;
  /** Deterministic reason, disclosed in the consolidated record. */
  readonly reason: string;
}

/** Classify every prior finding for an incremental (delta or integration)
 * round. A prior is CARRIED only when the minion did not claim it fixed, its
 * cited file is NOT in the round's "changed since the prior reviewed head"
 * path set, and its quoted evidence still appears verbatim in the frozen
 * tree at that path. Everything else is re-verified by the lead. */
export function classifyPriorFindings(input: {
  readonly prior: readonly VerifiedFinding[];
  readonly touchedPaths: ReadonlySet<string>;
  readonly claimedFixedPriors?: readonly number[];
  /** Frozen-tree evidence presence at the cited path (host-owned read). */
  readonly frozenBlobContains: (path: string, evidence: string) => boolean;
}): readonly PriorCarryClassification[] {
  const claimed = new Set(input.claimedFixedPriors ?? []);
  return input.prior.map((finding, priorIndex): PriorCarryClassification => {
    if (claimed.has(priorIndex)) {
      return { priorIndex, status: 'reverify', reason: 'claimed fixed by the implementing minion' };
    }
    const parsed = parseFindingLocation(finding.location);
    if (parsed === null) {
      return { priorIndex, status: 'reverify', reason: 'location names no reviewable file path' };
    }
    if (input.touchedPaths.has(parsed.path)) {
      return { priorIndex, status: 'reverify', reason: 'code at the cited file changed since the prior reviewed head' };
    }
    const evidence = finding.evidence;
    if (evidence !== 'N/A' && evidence.trim() !== '' && input.frozenBlobContains(parsed.path, evidence)) {
      return { priorIndex, status: 'carried', reason: 'quoted evidence unchanged in the frozen tree and the cited file unchanged since the prior reviewed head' };
    }
    return { priorIndex, status: 'reverify', reason: 'quoted evidence could not be confirmed unchanged in the frozen tree' };
  });
}

/** The convergence rule (policy: from round 3 on a delta round) applied to
 * the round's ASSEMBLED and deduped findings: a finding whose location does
 * not intersect this round's delta hunks is deferred as a follow-up —
 * recorded and disclosed, never dropped — and a deferred blocker loses its
 * hold on the PR. Applying it after dedupe means a rediscovery, a
 * restatement and a host-carried still-present finding are all judged by
 * the same location rule; the final whole-change pass is where an untouched
 * blocker holds again. */
export function applyConvergenceDeferral(input: {
  readonly roundNumber: number;
  readonly fromRound: number;
  readonly findings: readonly VerifiedFinding[];
  readonly hunks: readonly DeltaHunk[];
}): {
  readonly findings: VerifiedFinding[];
  readonly deferred: readonly { readonly finding: VerifiedFinding; readonly reason: string }[];
} {
  if (input.roundNumber < input.fromRound) return { findings: [...input.findings], deferred: [] };
  const findings: VerifiedFinding[] = [];
  const deferred: { finding: VerifiedFinding; reason: string }[] = [];
  for (const finding of input.findings) {
    if (findingIntersectsDelta(finding.location, input.hunks)) {
      findings.push(finding);
      continue;
    }
    const reason = `outside this round's delta hunks (round ${input.roundNumber} convergence rule): filed as a follow-up, cannot hold the PR THIS ROUND`;
    // The flag and the convergence record carry the deferral; the lead's
    // original verification reason stays untouched (a later whole pass that
    // re-activates the finding must not carry a stale "cannot hold" note).
    findings.push({ ...finding, deferredFollowup: true });
    deferred.push({ finding, reason });
  }
  return { findings, deferred };
}

/** Deterministic policy verdict mapping over the CONVERGED blocker set
 * (identical to the lead's guidance: 0 blockers READY, 1-3 NEEDS CHANGES,
 * 4+ MAJOR REWORK). */
export function convergedVerdict(blockerCount: number): Exclude<CanonicalReviewVerdict, 'INCOMPLETE'> {
  if (blockerCount === 0) return 'READY TO MERGE';
  if (blockerCount <= 3) return 'NEEDS CHANGES';
  return 'MAJOR REWORK NEEDED';
}

/** The review scope of the round that FOLLOWS `prior`:
 *
 * - no prior -> whole (a job's first review);
 * - same candidate (target AND diff base unchanged) -> whole: there is no
 *   delta to review, and a re-review at an unchanged head is a request for
 *   the whole-change authority, not a delta scan;
 * - moved diff base WITH proven integration lineage and retained coverage
 *   -> integration: the reviewed feature head integrated with a descendant
 *   base, so the prior coverage stands and only the new integration work is
 *   reviewed;
 * - moved diff base without that proof -> whole: the review CONTEXT changed
 *   (a new merge base puts base-merged changes under review), so a
 *   target-only delta would silently defer findings the new base introduced;
 * - the prior round was a DELTA round that posted READY -> whole: the
 *   READY candidate gets one whole-change authority pass before approval
 *   means approval;
 * - otherwise -> delta (the normal fix-then-review increment).
 */
export interface ReviewScopePlan {
  readonly scope: 'whole' | 'delta' | 'integration';
  /** Deterministic, durable explanation of the decision (disclosed on the
   * convergence record and in the ledger review event). */
  readonly reason: string;
  /** The authenticated whole-candidate coverage of the prior round, as the
   * engine must consume it (false when unauthenticated/partial/mismatched). */
  readonly priorCoverageComplete: boolean;
}

/** The production scope plan: the shared decision plus the PIN of the exact
 * prior-record bytes it was derived from. The engine must consume only bytes
 * that still hash to this digest — a changed file refuses rather than
 * silently substituting retained coverage. */
export interface PerkinsReviewScopePlan extends ReviewScopePlan {
  readonly priorConsolidatedSha256?: string;
}

export function planReviewScope(input: {
  readonly prior: PriorConvergenceMeta | null;
  readonly currentTargetSha: string;
  readonly currentDiffBaseSha: string;
  readonly deltaRoundsFrom: number;
  readonly finalWholePassAtReady: boolean;
  /** Policy gate: when not exactly true, a moved base always reviews whole. */
  readonly integrationCoverage?: boolean;
  /** Git-probed lineage; null when the probe could not be established. */
  readonly integrationLineage?: IntegrationLineage | null;
  /** Whether the prior and current rounds bind the SAME effective acceptance.
   * Retained coverage requires an explicit true; an absent field never
   * retains coverage. */
  readonly acceptanceCompatible: boolean;
}): ReviewScopePlan {
  if (input.prior === null) {
    return { scope: 'whole', reason: 'first review of this change (no conclusive prior record)', priorCoverageComplete: false };
  }
  const prior = input.prior;
  const coverageNote = prior.coverageComplete
    ? 'the retained prior coverage covers the whole candidate'
    : 'the retained prior coverage is only partial, so this READY still owes the final whole pass';
  const sameCandidate = prior.targetSha === input.currentTargetSha &&
    prior.diffBaseSha === input.currentDiffBaseSha;
  if (sameCandidate) {
    return { scope: 'whole', reason: 're-review at an unchanged candidate (target and merge base unchanged)', priorCoverageComplete: prior.coverageComplete };
  }
  if (prior.diffBaseSha !== input.currentDiffBaseSha) {
    const lineage = input.integrationLineage ?? null;
    const integratedForward = prior.targetSha !== input.currentTargetSha &&
      lineage !== null && lineage.baseAdvanced && lineage.featureIntegrated && lineage.commonBasePinned;
    const sameHeadAdoptedBase = prior.targetSha === input.currentTargetSha &&
      lineage !== null && lineage.sameHeadAdoptedBase;
    if (input.integrationCoverage === true && input.acceptanceCompatible === true &&
      (integratedForward || sameHeadAdoptedBase)) {
      const kind = sameHeadAdoptedBase
        ? `the candidate is unchanged (${input.currentTargetSha.slice(0, 12)}) and the base only advanced onto already-reviewed history, so the prior coverage stands`
        : `reviewed feature head ${prior.targetSha.slice(0, 12)} integrated forward into the current candidate`;
      return {
        scope: 'integration',
        reason: `prior coverage retained: merge base ${prior.diffBaseSha.slice(0, 12)} advanced to ${input.currentDiffBaseSha.slice(0, 12)} and ${kind}; ${coverageNote}`,
        priorCoverageComplete: prior.coverageComplete,
      };
    }
    const fallback = input.integrationCoverage !== true
      ? 'merge base moved and integration coverage is disabled by policy — whole-change re-verification'
      : input.acceptanceCompatible !== true
        ? 'merge base moved and the effective acceptance changed since the retained round — whole-change re-verification'
        : prior.targetSha === input.currentTargetSha
          ? 'merge base moved with an unchanged candidate, but the new base is not an ancestor of the reviewed head (the base advanced beyond already-reviewed history) — whole-change re-verification'
          : lineage === null
            ? 'merge base moved and the integration lineage could not be established — whole-change re-verification'
            : !lineage.baseAdvanced
              ? 'merge base moved and the prior base no longer descends into the current base (rewritten base) — whole-change re-verification'
              : !lineage.featureIntegrated
                ? 'merge base moved and the reviewed feature head no longer descends into the current candidate (rebased/rewritten head) — whole-change re-verification'
                : 'merge base moved and the prior base is no longer the shared ancestor of the reviewed head and the current base — whole-change re-verification';
    return { scope: 'whole', reason: fallback, priorCoverageComplete: prior.coverageComplete };
  }
  if (
    input.finalWholePassAtReady &&
    prior.reviewScope === 'delta' &&
    prior.canonicalVerdict === 'READY TO MERGE'
  ) {
    return { scope: 'whole', reason: 'a delta round posted READY: the final whole-change authority pass is required', priorCoverageComplete: prior.coverageComplete };
  }
  return prior.seq + 1 >= input.deltaRoundsFrom
    ? { scope: 'delta', reason: `incremental fix round ${prior.seq + 1} since the last reviewed SHA`, priorCoverageComplete: prior.coverageComplete }
    : { scope: 'whole', reason: 'before the delta-round threshold (standing whole-change authority)', priorCoverageComplete: prior.coverageComplete };
}

/** What a caller must know about a completed round's convergence record to
 * plan the next round. `reviewScope: 'unknown'` marks consolidated records
 * written before Stage 5: they still schedule delta rounds from the policy
 * threshold. */
export interface PriorConvergenceMeta {
  readonly seq: number;
  readonly reviewScope: 'whole' | 'delta' | 'integration' | 'unknown';
  readonly canonicalVerdict: string;
  readonly targetSha: string;
  readonly diffBaseSha: string;
  /** The prior round's bound acceptance (null when none was recorded):
   * retained coverage only applies while the WHOLE binding matches. */
  readonly acceptance: {
    readonly version: number;
    readonly baseSha256: string;
    readonly contractSha256: string;
    readonly amendmentIds: readonly string[];
  } | null;
  /** The prior round's durable whole-candidate coverage bit (false for a
   * partial delta/integration round or a legacy record without the field). */
  readonly coverageComplete: boolean;
  /** True when the record carries NO convergence block at all: a genuine
   * pre-Stage-5 whole review, whole-complete only when its native receipt
   * also carries no Stage-5 scope/coverage evidence. */
  readonly legacyWhole: boolean;
  /** The retained findings as the record holds them (null when absent/not an
   * array): bound to the native submission by count and digest so tampering
   * can never be credited whole-complete coverage. */
  readonly findings: { readonly blockers: number; readonly count: number; readonly sha256: string } | null;
  /** The record's immutable integration linkage when its scope is
   * `integration` (null for whole/delta/unknown/legacy records). Every
   * reader must accept a recognized integration claim only with the FULL
   * linkage validated by `validateRetainedReviewLinkage`. */
  readonly integration: RetainedIntegrationLinkage | null;
}

/** The immutable linkage every retained `integration` coverage claim must
 * carry: the prior covered feature head (H0), the advanced incoming base
 * (B1, which must be the record's own frozen diff base) and the prior
 * round's own pinned base (B0). */
export interface RetainedIntegrationLinkage {
  readonly fromSha: string;
  readonly baseSha: string;
  readonly priorDiffBase: string;
}

/** ONE shared verdict on a retained-coverage claim's scope + linkage, used
 * by the scope planner, the posted-state parser and the recovery readers so
 * no surface accepts a state another rejects: an `integration` claim must
 * carry ALL THREE immutable linkage fields and its recorded incoming base
 * must be its own frozen diff base; a `whole`/`delta` claim must carry none
 * (a stray linkage field is damaged provenance, never coverage). */
export function validateRetainedReviewLinkage(input: {
  readonly reviewScope: unknown;
  readonly diffBaseSha?: unknown;
  readonly integrationFromSha?: unknown;
  readonly integrationBaseSha?: unknown;
  readonly integrationPriorDiffBase?: unknown;
}): { readonly ok: true } | { readonly ok: false; readonly defect: string } {
  const { reviewScope, integrationFromSha, integrationBaseSha, integrationPriorDiffBase } = input;
  if (reviewScope !== 'whole' && reviewScope !== 'delta' && reviewScope !== 'integration') {
    return { ok: false, defect: 'the review scope is missing or unrecognized' };
  }
  const linkage = [integrationFromSha, integrationBaseSha, integrationPriorDiffBase];
  if (reviewScope !== 'integration') {
    return linkage.some((value) => value !== undefined)
      ? { ok: false, defect: `${reviewScope} coverage must not carry integration linkage fields` }
      : { ok: true };
  }
  const names = ['integrationFromSha', 'integrationBaseSha', 'integrationPriorDiffBase'] as const;
  for (const [index, value] of linkage.entries()) {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
      return { ok: false, defect: `integration linkage field ${names[index]} is missing or not a full commit SHA` };
    }
  }
  if (typeof input.diffBaseSha !== 'string' || !/^[0-9a-f]{40}$/u.test(input.diffBaseSha)) {
    return { ok: false, defect: 'the record\'s own frozen diff base is missing or not a full commit SHA' };
  }
  if (integrationBaseSha !== input.diffBaseSha) {
    return { ok: false, defect: 'the recorded incoming base is not the record\'s own frozen diff base' };
  }
  return { ok: true };
}

const MAX_CONSOLIDATED_META_BYTES = 8 * 1024 * 1024;

/** Parse one prior consolidated record from the EXACT bytes a reader
 * obtained. Returns null when the record is not a complete whole-PR record —
 * the caller then plans as if no prior existed (whole authority); it never
 * guesses a scope from a damaged history. An `integration` scope whose
 * immutable linkage is missing or inconsistent reads as damaged, never as
 * inherited approval. */
export function parsePriorConvergenceMeta(bytes: Buffer, seq: number): PriorConvergenceMeta | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as {
      schemaVersion?: unknown;
      architecture?: unknown;
      canonicalVerdict?: unknown;
      complete?: unknown;
      headMoved?: unknown;
      frozen?: { targetSha?: unknown; diffBaseSha?: unknown; acceptance?: unknown };
      findings?: unknown;
      convergence?: { reviewScope?: unknown; coverageComplete?: unknown; integrationFromSha?: unknown; integrationBaseSha?: unknown; integrationPriorDiffBase?: unknown };
    };
    if (parsed.schemaVersion !== 3 || parsed.architecture !== 'perkins-whole-pr' ||
      parsed.complete !== true || parsed.headMoved !== false ||
      parsed.canonicalVerdict === 'INCOMPLETE' ||
      typeof parsed.frozen?.targetSha !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.frozen.targetSha) ||
      typeof parsed.frozen?.diffBaseSha !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.frozen.diffBaseSha)) {
      return null;
    }
    const scope = parsed.convergence?.reviewScope;
    // ONE shared full-linkage verdict: a recognized scope with missing,
    // inconsistent or stray linkage is damaged, never coverage. An
    // unrecognized scope keeps its tolerant 'unknown' read (pre-Stage-5
    // records) but can never be credited whole-complete coverage.
    if (scope === 'whole' || scope === 'delta' || scope === 'integration') {
      const linkageCheck = validateRetainedReviewLinkage({
        reviewScope: scope,
        diffBaseSha: parsed.frozen.diffBaseSha,
        integrationFromSha: parsed.convergence?.integrationFromSha,
        integrationBaseSha: parsed.convergence?.integrationBaseSha,
        integrationPriorDiffBase: parsed.convergence?.integrationPriorDiffBase,
      });
      if (!linkageCheck.ok) return null;
    }
    const integration: RetainedIntegrationLinkage | null = scope === 'integration'
      ? {
          fromSha: parsed.convergence!.integrationFromSha as string,
          baseSha: parsed.convergence!.integrationBaseSha as string,
          priorDiffBase: parsed.convergence!.integrationPriorDiffBase as string,
        }
      : null;
    const rawAcceptance = parsed.frozen.acceptance as { version?: unknown; baseSha256?: unknown; contractSha256?: unknown; amendmentIds?: unknown } | null | undefined;
    // A PRESENT acceptance binding must be fully well-formed: a partial or
    // malformed one is damaged provenance, not an absent one, so it fails
    // closed (no inherited coverage).
    if (rawAcceptance !== undefined && rawAcceptance !== null) {
      const wellFormed = typeof rawAcceptance === 'object' &&
        typeof rawAcceptance.version === 'number' && Number.isSafeInteger(rawAcceptance.version) &&
        typeof rawAcceptance.baseSha256 === 'string' && (rawAcceptance.baseSha256 === '' || /^[a-f0-9]{64}$/u.test(rawAcceptance.baseSha256)) &&
        typeof rawAcceptance.contractSha256 === 'string' && /^[a-f0-9]{64}$/u.test(rawAcceptance.contractSha256) &&
        Array.isArray(rawAcceptance.amendmentIds) &&
        rawAcceptance.amendmentIds.every((id) => typeof id === 'string');
      if (!wellFormed) return null;
    }
    const acceptance = rawAcceptance === null || rawAcceptance === undefined
      ? null
      : {
          version: rawAcceptance.version as number,
          baseSha256: rawAcceptance.baseSha256 as string,
          contractSha256: rawAcceptance.contractSha256 as string,
          amendmentIds: [...(rawAcceptance.amendmentIds as string[])],
        };
    // A record with NO convergence block predates Stage 5: it was a
    // whole-change review, so its coverage is whole-complete by construction.
    const legacyWhole = parsed.convergence === undefined;
    const coverageComplete = parsed.convergence?.coverageComplete === true
      ? (scope === 'whole' || scope === 'integration')
      : parsed.convergence?.coverageComplete === undefined && (legacyWhole || scope === 'whole');
    // The retained findings are bound to the native submission by their count
    // and digest: a record whose findings were swapped/emptied can never be
    // credited whole-complete coverage over unresolved priors.
    const rawFindings = parsed.findings;
    const findings = Array.isArray(rawFindings)
      ? {
          blockers: rawFindings.filter((entry) => typeof entry === 'object' && entry !== null &&
            (entry as { severity?: unknown }).severity === 'blocker' &&
            (entry as { deferredFollowup?: unknown }).deferredFollowup !== true).length,
          count: rawFindings.length,
          sha256: createHash('sha256').update(JSON.stringify(rawFindings)).digest('hex'),
        }
      : null;
    return {
      seq,
      reviewScope: scope === 'whole' || scope === 'delta' || scope === 'integration' ? scope : 'unknown',
      canonicalVerdict: typeof parsed.canonicalVerdict === 'string' ? parsed.canonicalVerdict : '',
      targetSha: parsed.frozen.targetSha,
      diffBaseSha: parsed.frozen.diffBaseSha,
      acceptance,
      coverageComplete,
      legacyWhole,
      findings,
      integration,
    };
  } catch {
    return null;
  }
}

/** One bounded read of a prior round's consolidated file: the parsed meta
 * plus the sha256 of the EXACT bytes the meta was parsed from. The caller
 * pins that digest into the engine, so the engine consumes only bytes that
 * were authenticated together with their scope/coverage claims — a changed
 * file refuses rather than silently substituting retained coverage. */
export interface PriorConvergenceRead {
  readonly meta: PriorConvergenceMeta | null;
  readonly sha256: string | null;
}

export function readPriorConvergenceFile(file: string, seq: number): PriorConvergenceRead {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONSOLIDATED_META_BYTES) return { meta: null, sha256: null };
    const bytes = readFileSync(file);
    // A bounded read that did not obtain exactly the statted file is not
    // trustworthy enough to pin: fail closed without a digest.
    if (bytes.byteLength !== info.size || bytes.byteLength > MAX_CONSOLIDATED_META_BYTES) return { meta: null, sha256: null };
    return {
      meta: parsePriorConvergenceMeta(bytes, seq),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return { meta: null, sha256: null };
  }
}

/** Tolerant read of one prior round's consolidated record for scope
 * planning: the parsed meta or null (see `parsePriorConvergenceMeta`). */
export function readPriorConvergenceMeta(file: string, seq: number): PriorConvergenceMeta | null {
  return readPriorConvergenceFile(file, seq).meta;
}

/** The ledger-native publication receipt for one prior round: the durable
 * `round.perkins-review` fields plus the pre-commit `round.final-pass-required`
 * marker presence. A consolidated file's scope/coverage claims are credited
 * only when this receipt corroborates them. */
export interface PriorNativeReceipt {
  readonly targetSha?: unknown;
  readonly diffBaseSha?: unknown;
  readonly reviewScope?: unknown;
  readonly coverageComplete?: unknown;
  readonly finalPassRequired?: unknown;
  /** Non-deferred blocker count of the native submission. */
  readonly blockers?: unknown;
  /** Total retained finding count and exact digest of the native submission. */
  readonly retainedFindings?: unknown;
  readonly retainedFindingsSha256?: unknown;
  /** The native submission's full integration linkage; required to corroborate
   * an `integration` record's own linkage (all three or none). */
  readonly integrationFromSha?: unknown;
  readonly integrationBaseSha?: unknown;
  readonly integrationPriorDiffBase?: unknown;
}

/** The prior round's accepted contract binding as recorded on the round's own
 * `round.review-inputs-frozen` ledger event (authoritative). */
export interface PriorAcceptanceBinding {
  readonly version: number;
  readonly baseSha256: string;
  readonly contractSha256: string;
  readonly amendmentIds: readonly string[];
}

function acceptanceEqual(left: PriorAcceptanceBinding, right: PriorAcceptanceBinding): boolean {
  return left.version === right.version && left.baseSha256 === right.baseSha256 &&
    left.contractSha256 === right.contractSha256 &&
    left.amendmentIds.join('\0') === [...right.amendmentIds].join('\0');
}

/** Authenticate a prior record's scope/coverage against its round's native
 * ledger receipt. Returns the meta with an authenticated `coverageComplete`,
 * or null when the record and the receipt disagree (stripped/forged/corrupted
 * metadata) — the caller then reviews whole and cannot credit retained
 * coverage. A genuine pre-Stage-5 whole record is credited only when the
 * receipt carries NO Stage-5 scope/coverage evidence either. */
export function authenticatePriorMeta(
  meta: PriorConvergenceMeta | null,
  receipt: PriorNativeReceipt | null,
): PriorConvergenceMeta | null {
  if (meta === null || receipt === null) return null;
  // The record's own frozen identity must match the round's native receipt.
  if (typeof receipt.targetSha !== 'string' || receipt.targetSha !== meta.targetSha) return null;
  if (typeof receipt.diffBaseSha !== 'string' || receipt.diffBaseSha !== meta.diffBaseSha) return null;
  const receiptScope = typeof receipt.reviewScope === 'string' ? receipt.reviewScope : undefined;
  if (receiptScope !== undefined && receiptScope !== meta.reviewScope) return null;
  // A Stage-5 scope claim must be corroborated by the receipt; only a genuine
  // pre-Stage-5 record (no convergence block) may carry no receipt scope.
  if (receiptScope === undefined && !meta.legacyWhole) return null;
  // Every required integration linkage field must be corroborated by the
  // round's native receipt: an `integration` record is credited only when all
  // three immutable linkage fields match the receipt exactly, and a
  // non-integration record must carry none (a stray linkage field is damaged
  // provenance, never coverage).
  if (meta.reviewScope === 'integration') {
    if (meta.integration === null ||
      receipt.integrationFromSha !== meta.integration.fromSha ||
      receipt.integrationBaseSha !== meta.integration.baseSha ||
      receipt.integrationPriorDiffBase !== meta.integration.priorDiffBase) return null;
  } else if (receipt.integrationFromSha !== undefined || receipt.integrationBaseSha !== undefined ||
    receipt.integrationPriorDiffBase !== undefined) {
    return null;
  }
  // The retained findings must match the native submission exactly: a record
  // whose findings were swapped/emptied ("[]" over a genuine NEEDS CHANGES
  // review) can never be credited whole-complete coverage.
  if (receipt.blockers !== undefined) {
    if (!Number.isSafeInteger(receipt.blockers) || meta.findings === null || meta.findings.blockers !== receipt.blockers) return null;
  }
  if (receipt.retainedFindings !== undefined) {
    if (!Number.isSafeInteger(receipt.retainedFindings) || meta.findings === null || meta.findings.count !== receipt.retainedFindings) return null;
  }
  if (typeof receipt.retainedFindingsSha256 === 'string') {
    if (!/^[a-f0-9]{64}$/u.test(receipt.retainedFindingsSha256) || meta.findings === null ||
      meta.findings.sha256 !== receipt.retainedFindingsSha256) return null;
  }
  const receiptDebt = receipt.finalPassRequired === true;
  const receiptComplete = receipt.coverageComplete === true;
  // The retained FINDING CONTENTS must be authenticated before a record can
  // be credited whole-complete coverage. A digest binds them exactly; a
  // trivially EMPTY finding set needs no further proof. A count-only baseline
  // receipt over findings cannot prove the contents were not substituted
  // same-count (a schema-valid replacement blocker keeps every count intact),
  // so whole-complete credit is withheld and the caller reviews the
  // uncovered work instead.
  const contentAuthenticated = typeof receipt.retainedFindingsSha256 === 'string' ||
    (meta.findings !== null && meta.findings.count === 0 &&
      (receipt.retainedFindings === undefined || receipt.retainedFindings === 0) &&
      (receipt.blockers === undefined || receipt.blockers === 0));
  if (meta.legacyWhole) {
    // A stripped/forged convergence block on a Stage-5 round is caught here:
    // the legacy credit is granted ONLY when the native receipt also carries
    // no Stage-5 scope/coverage/debt evidence at all, and the retained
    // findings are content-authenticated.
    if (receiptScope !== undefined || receiptComplete || receiptDebt) return null;
    if (!contentAuthenticated) return null;
    return { ...meta, coverageComplete: true };
  }
  if (receiptDebt) {
    // A round that still owed the final pass can never be whole-complete.
    if (meta.coverageComplete) return null;
    return { ...meta, coverageComplete: false };
  }
  // A whole-scope round covered the whole candidate by construction, but only
  // content-authenticated findings may be credited: a baseline receipt whose
  // digest is absent cannot prove the contents are the ones the round found.
  if (meta.reviewScope === 'whole') {
    if (!contentAuthenticated) return null;
    return { ...meta, coverageComplete: true };
  }
  if (meta.coverageComplete && !receiptComplete) return null;
  return { ...meta, coverageComplete: meta.coverageComplete && receiptComplete };
}

/** One call that plans the production round scope: read the prior durable
 * record, authenticate its coverage/acceptance against the round's native
 * receipt, probe the integration lineage in the repo, and decide. Keeps the
 * perkins.ts wiring testable end to end. */
export function planPerkinsReviewScope(input: {
  readonly priorConsolidatedFile?: string;
  readonly priorSeq?: number;
  readonly repoPath: string;
  readonly currentTargetSha: string;
  readonly currentDiffBaseSha: string;
  readonly currentAcceptance: PriorAcceptanceBinding | undefined;
  /** The prior round's native ledger receipt; absent = unauthenticated. */
  readonly nativeReceipt?: PriorNativeReceipt | null;
  /** The prior round's ledger-native accepted contract binding. */
  readonly acceptanceReceipt?: PriorAcceptanceBinding | null;
  readonly rules: {
    readonly deltaRoundsFrom: number;
    readonly finalWholePassAtReady: boolean;
    readonly integrationCoverage: boolean;
  };
}): PerkinsReviewScopePlan {
  const priorFileProvided = input.priorConsolidatedFile !== undefined && input.priorSeq !== undefined;
  const priorRead = priorFileProvided
    ? readPriorConvergenceFile(input.priorConsolidatedFile!, input.priorSeq!)
    : { meta: null, sha256: null };
  const rawPrior = priorRead.meta;
  const pin = priorRead.sha256 !== null ? { priorConsolidatedSha256: priorRead.sha256 } : {};
  // Distinguish "no prior round" from "a prior record that is not a
  // conclusive whole-PR record": the latter must be disclosed, not mislabelled
  // as the job's first review.
  if (priorFileProvided && rawPrior === null) {
    return {
      scope: 'whole',
      reason: 'a prior review record exists but is not a conclusive whole-PR record — whole-change re-verification',
      priorCoverageComplete: false,
      ...pin,
    };
  }
  const prior = authenticatePriorMeta(rawPrior, input.nativeReceipt ?? null);
  if (priorFileProvided && prior === null) {
    return {
      scope: 'whole',
      reason: 'the prior record\'s scope/coverage could not be authenticated against its native ledger receipt — whole-change re-verification',
      priorCoverageComplete: false,
      ...pin,
    };
  }
  // The record's acceptance must equal its own round's ledger-native freeze
  // binding; an altered acceptance can never retain coverage.
  const fileAcceptance = rawPrior?.acceptance ?? null;
  const receiptAcceptance = input.acceptanceReceipt ?? null;
  const acceptanceAuthenticated = fileAcceptance === null
    ? receiptAcceptance === null
    : receiptAcceptance !== null && acceptanceEqual(fileAcceptance, receiptAcceptance);
  const priorAcceptance = receiptAcceptance ?? fileAcceptance;
  const acceptanceCompatible = acceptanceAuthenticated && (input.currentAcceptance === undefined
    ? priorAcceptance === null
    : priorAcceptance !== null && acceptanceEqual(priorAcceptance, input.currentAcceptance));
  const integrationLineage = prior !== null && prior.diffBaseSha !== input.currentDiffBaseSha
    ? probeIntegrationLineage(input.repoPath, {
        priorDiffBaseSha: prior.diffBaseSha,
        priorTargetSha: prior.targetSha,
        currentDiffBaseSha: input.currentDiffBaseSha,
        currentTargetSha: input.currentTargetSha,
      })
    : null;
  const plan = planReviewScope({
    prior,
    currentTargetSha: input.currentTargetSha,
    currentDiffBaseSha: input.currentDiffBaseSha,
    deltaRoundsFrom: input.rules.deltaRoundsFrom,
    finalWholePassAtReady: input.rules.finalWholePassAtReady,
    integrationCoverage: input.rules.integrationCoverage,
    integrationLineage,
    acceptanceCompatible,
  });
  // A record whose own acceptance is not corroborated by its round's native
  // freeze binding can never carry retained coverage into the engine.
  return acceptanceAuthenticated ? { ...plan, ...pin } : { ...plan, priorCoverageComplete: false, ...pin };
}
