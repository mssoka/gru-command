import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
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

/** Read the bounded prior-target..target delta from the frozen repository.
 * Throws when git cannot produce the delta: callers decide the fail-closed
 * direction (carry-forward narrows; the convergence rule disables). */
export function deltaSince(repoPath: string, fromSha: string, toSha: string): DeltaSince {
  if (!/^[0-9a-f]{40}$/u.test(fromSha) || !/^[0-9a-f]{40}$/u.test(toSha)) {
    throw new Error('delta endpoints must be full commit SHAs');
  }
  let diff: string;
  try {
    diff = execFileSync('git', ['-C', repoPath, 'diff', '--no-ext-diff', '--no-color', '--unified=3', fromSha, toSha, '--'], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    throw new Error(`delta since ${fromSha.slice(0, 12)} could not be read: ${String(error)}`);
  }
  if (Buffer.byteLength(diff, 'utf8') > DELTA_DIFF_MAX_BYTES) {
    throw new Error(`delta since ${fromSha.slice(0, 12)} exceeds ${DELTA_DIFF_MAX_BYTES} UTF-8 bytes`);
  }
  const { hunks, paths } = parseDeltaStructure(diff);
  return {
    fromSha, toSha, diff, hunks,
    touchedPaths: new Set([...paths, ...hunks.map((hunk) => hunk.path)]),
  };
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

/** Classify every prior finding for a delta round. A prior is CARRIED only
 * when the minion did not claim it fixed, its cited file was untouched by
 * this round's delta, and its quoted evidence still appears verbatim in the
 * frozen tree at that path. Everything else is re-verified by the lead. */
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
      return { priorIndex, status: 'reverify', reason: 'code at the cited file changed in this round\'s delta' };
    }
    const evidence = finding.evidence;
    if (evidence !== 'N/A' && evidence.trim() !== '' && input.frozenBlobContains(parsed.path, evidence)) {
      return { priorIndex, status: 'carried', reason: 'quoted evidence unchanged in the frozen tree and the cited file untouched' };
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
 * - moved diff base -> whole: the review CONTEXT changed (a new merge base
 *   puts base-merged changes under review), so a target-only delta would
 *   silently defer findings the new base introduced;
 * - the prior round was a DELTA round that posted READY -> whole: the
 *   READY candidate gets one whole-change authority pass before approval
 *   means approval;
 * - otherwise -> delta (the normal fix-then-review increment). */
export function nextReviewScope(input: {
  readonly prior: PriorConvergenceMeta | null;
  readonly currentTargetSha: string;
  readonly currentDiffBaseSha: string;
  readonly deltaRoundsFrom: number;
  readonly finalWholePassAtReady: boolean;
}): 'whole' | 'delta' {
  if (input.prior === null) return 'whole';
  const sameCandidate = input.prior.targetSha === input.currentTargetSha &&
    input.prior.diffBaseSha === input.currentDiffBaseSha;
  if (sameCandidate) return 'whole';
  if (input.prior.diffBaseSha !== input.currentDiffBaseSha) return 'whole';
  if (
    input.finalWholePassAtReady &&
    input.prior.reviewScope === 'delta' &&
    input.prior.canonicalVerdict === 'READY TO MERGE'
  ) return 'whole';
  return input.prior.seq + 1 >= input.deltaRoundsFrom ? 'delta' : 'whole';
}

/** What a caller must know about a completed round's convergence record to
 * plan the next round. `reviewScope: 'unknown'` marks consolidated records
 * written before Stage 5: they still schedule delta rounds from the policy
 * threshold. */
export interface PriorConvergenceMeta {
  readonly seq: number;
  readonly reviewScope: 'whole' | 'delta' | 'unknown';
  readonly canonicalVerdict: string;
  readonly targetSha: string;
  readonly diffBaseSha: string;
}

const MAX_CONSOLIDATED_META_BYTES = 8 * 1024 * 1024;

/** Tolerant read of one prior round's consolidated record for scope
 * planning. Returns null when the file is missing, unreadable or not a
 * complete whole-PR record — the caller then plans as if no prior existed
 * (whole authority); it never guesses a scope from a damaged history. */
export function readPriorConvergenceMeta(file: string, seq: number): PriorConvergenceMeta | null {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONSOLIDATED_META_BYTES) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      schemaVersion?: unknown;
      architecture?: unknown;
      canonicalVerdict?: unknown;
      complete?: unknown;
      headMoved?: unknown;
      frozen?: { targetSha?: unknown; diffBaseSha?: unknown };
      convergence?: { reviewScope?: unknown };
    };
    if (parsed.schemaVersion !== 3 || parsed.architecture !== 'perkins-whole-pr' ||
      parsed.complete !== true || parsed.headMoved !== false ||
      parsed.canonicalVerdict === 'INCOMPLETE' ||
      typeof parsed.frozen?.targetSha !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.frozen.targetSha) ||
      typeof parsed.frozen?.diffBaseSha !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.frozen.diffBaseSha)) {
      return null;
    }
    const scope = parsed.convergence?.reviewScope;
    return {
      seq,
      reviewScope: scope === 'whole' || scope === 'delta' ? scope : 'unknown',
      canonicalVerdict: typeof parsed.canonicalVerdict === 'string' ? parsed.canonicalVerdict : '',
      targetSha: parsed.frozen.targetSha,
      diffBaseSha: parsed.frozen.diffBaseSha,
    };
  } catch {
    return null;
  }
}
