import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import type { CanonicalReviewVerdict, ReviewFinding, VerifiedFinding } from './types.js';

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

/** One changed-line range in the NEW file of the reviewed branch. */
export interface DeltaHunk {
  readonly path: string;
  /** Inclusive 1-based new-file line range; startLine > endLine marks a
   * pure deletion (no new lines to intersect). */
  readonly startLine: number;
  readonly endLine: number;
}

/** The reviewed delta between one last-reviewed SHA and this round's frozen
 * target: the raw bounded diff, its parsed hunks, and the touched paths. */
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
  const startLine = Number(match[1]);
  const endLine = match[2] !== undefined ? Number(match[2]) : startLine;
  return { path, startLine, endLine };
}

/** Parse the `@@ -a,b +c,d @@` hunk headers of one unified diff into
 * new-file line ranges grouped by their file. The path comes from the
 * `+++ b/<path>` line; a deletion's `+++ /dev/null` keeps the path from
 * the `diff --git a/<path> b/<path>` header (the deleted file's own
 * path — pure deletions add no new lines to intersect). */
export function parseDeltaHunks(diff: string): readonly DeltaHunk[] {
  const hunks: DeltaHunk[] = [];
  let path: string | null = null;
  for (const line of diff.split('\n')) {
    const gitHeader = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (gitHeader !== null) {
      path = gitHeader[2]!;
      continue;
    }
    const newFile = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (newFile !== null) {
      path = newFile[1]!;
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header === null || path === null) continue;
    const startLine = Number(header[1]);
    const count = header[2] !== undefined ? Number(header[2]) : 1;
    // A zero-count new range is a pure deletion: it adds no new lines, so
    // its empty range can never intersect (startLine > endLine encodes it).
    hunks.push({ path, startLine, endLine: count === 0 ? startLine - 1 : startLine + count - 1 });
  }
  return hunks;
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
  const hunks = parseDeltaHunks(diff);
  return {
    fromSha, toSha, diff, hunks,
    touchedPaths: new Set(hunks.map((hunk) => hunk.path)),
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
 * ONE round's NEW findings: a finding whose location does not intersect
 * this round's delta hunks is deferred as a follow-up — recorded and
 * disclosed, never dropped — and a deferred BLOCKER loses its hold on the
 * PR. Warnings and notes never blocked; deferral only annotates them. */
export interface ConvergedPartition<F> {
  /** New findings that keep their full severity semantics. */
  readonly converged: readonly F[];
  /** New findings outside this round's delta, with the deterministic
   * deferral reason. */
  readonly deferred: readonly { readonly finding: F; readonly reason: string }[];
}

export function partitionConvergedFindings<F extends ReviewFinding>(input: {
  readonly roundNumber: number;
  readonly fromRound: number;
  readonly findings: readonly F[];
  readonly hunks: readonly DeltaHunk[];
}): ConvergedPartition<F> {
  if (input.roundNumber < input.fromRound) return { converged: [...input.findings], deferred: [] };
  const converged: F[] = [];
  const deferred: { finding: F; reason: string }[] = [];
  for (const finding of input.findings) {
    if (findingIntersectsDelta(finding.location, input.hunks)) {
      converged.push(finding);
      continue;
    }
    deferred.push({
      finding,
      reason: `outside this round's delta hunks (round ${input.roundNumber} convergence rule): filed as a follow-up, cannot hold the PR`,
    });
  }
  return { converged, deferred };
}

/** Deterministic policy verdict mapping over the CONVERGED blocker set
 * (identical to the lead's guidance: 0 blockers READY, 1-3 NEEDS CHANGES,
 * 4+ MAJOR REWORK). */
export function convergedVerdict(blockerCount: number): Exclude<CanonicalReviewVerdict, 'INCOMPLETE'> {
  if (blockerCount === 0) return 'READY TO MERGE';
  if (blockerCount <= 3) return 'NEEDS CHANGES';
  return 'MAJOR REWORK NEEDED';
}

/** The review scope of the round that FOLLOWS `prior`. The final
 * whole-change pass runs exactly when the prior round was a DELTA round
 * that posted READY: the READY candidate gets one whole-change authority
 * round before approval means approval. Every other round after a prior is
 * a delta round; a job's first review is whole. */
export function nextReviewScope(input: {
  readonly prior: PriorConvergenceMeta | null;
  readonly deltaRoundsFrom: number;
  readonly finalWholePassAtReady: boolean;
}): 'whole' | 'delta' {
  if (input.prior === null) return 'whole';
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
      frozen?: { targetSha?: unknown };
      convergence?: { reviewScope?: unknown };
    };
    if (parsed.schemaVersion !== 3 || parsed.architecture !== 'perkins-whole-pr' ||
      parsed.complete !== true || parsed.headMoved !== false ||
      parsed.canonicalVerdict === 'INCOMPLETE' ||
      typeof parsed.frozen?.targetSha !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.frozen.targetSha)) {
      return null;
    }
    const scope = parsed.convergence?.reviewScope;
    return {
      seq,
      reviewScope: scope === 'whole' || scope === 'delta' ? scope : 'unknown',
      canonicalVerdict: typeof parsed.canonicalVerdict === 'string' ? parsed.canonicalVerdict : '',
      targetSha: parsed.frozen.targetSha,
    };
  } catch {
    return null;
  }
}
