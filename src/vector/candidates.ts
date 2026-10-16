import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadPropertyConfig } from '../property/config.js';
import { propertyGit } from '../property/receipts.js';
import { resolvePropertyCapabilities } from '../property/resolve.js';
import type { PackageResolution } from '../property/types.js';
import { loadWorktreeManifest } from '../worktrees/manifest.js';
import { raidsTowardCap, type RaidRecord, type RaidSignals, type RaidTarget } from './ledger.js';

/**
 * Raid candidates (#351 §2): code builds and ranks the list from structured
 * state only; Gru decides what to raid from it, and can never raid a target
 * this list excluded. Every exclusion names its reason.
 */

export interface RaidCandidate {
  readonly target: RaidTarget;
  readonly repoPath: string;
  /** The cached origin default-branch head the candidate was read at. */
  readonly headSha: string;
  /** Git tree id of the package at that head: the raid's source identity. */
  readonly sourceIdentity: string;
  readonly adapterId: string;
  readonly signals: RaidSignals;
  /** Higher ranks first; see rankScore. */
  readonly score: number;
}

export interface RaidExclusion {
  readonly repo: string;
  /** null when the whole repository is excluded. */
  readonly packageDir: string | null;
  readonly reason: string;
}

export interface RaidCandidateList {
  readonly candidates: readonly RaidCandidate[];
  readonly exclusions: readonly RaidExclusion[];
  /** Identity of the decision situation: the ranked targets at their source
   * identities. Signals that only age (days) are not part of it, so an
   * unchanged situation is never re-decided. */
  readonly digest: string;
}

export interface CandidateInputs {
  readonly workspaceRoot: string;
  readonly managedRepos: readonly string[];
  readonly maxRaidsPerDay: number;
  /** Every raid record so far (the projection). */
  readonly raids: readonly RaidRecord[];
  /** Changes-requested Perkins verdicts on a repository's jobs since an instant (null = ever). */
  readonly perkinsFindings: (repo: string, since: string | null) => number;
  /** Break-ins earlier raids found on a target. */
  readonly escapedRegressions: (target: RaidTarget) => number;
  /** Seam A capability resolution (default: the real resolver). */
  readonly resolvePackages?: (repoPath: string) => readonly PackageResolution[];
  readonly now: Date;
}

const DAY_MS = 86_400_000;

const sameTarget = (left: RaidTarget, right: RaidTarget): boolean => left.repo === right.repo && left.packageDir === right.packageDir;

/** Outcomes that leave a target eligible again at the same source identity:
 * the raid stopped for heist work, main moved under it, the host failed, or
 * the host could not run it (a sandbox can be installed later). */
export const RETRYABLE_OUTCOMES: ReadonlySet<string> = new Set(['yielded', 'invalidated', 'infrastructure-error', 'refused']);

/** The one adapter the raid runner executes (#350's shipped pilot). */
export const RAID_ADAPTER = 'vitest-fast-check';

/** A launched raid that settled this target at this identity. */
const raidedHere = (raid: RaidRecord): boolean =>
  raid.launchedAt !== null && !(raid.state === 'finished' && raid.outcome !== null && RETRYABLE_OUTCOMES.has(raid.outcome));

/** Never-raided targets first; then weighted signals. Deterministic. */
export function rankScore(signals: RaidSignals): number {
  const age = signals.daysSinceLastRaid === null ? 1_000 : signals.daysSinceLastRaid;
  return age + signals.commitsSinceLastRaid * 3 + signals.perkinsFindings * 2 + signals.escapedRegressions * 5;
}

/** The cached origin default-branch head, or null when the clone never learned it. */
function defaultHead(repoPath: string): string | null {
  try {
    return propertyGit(repoPath, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD^{commit}']).trim() || null;
  } catch {
    return null;
  }
}

function packageTree(repoPath: string, headSha: string, packageDir: string): string | null {
  try {
    const spec = packageDir === '.' ? `${headSha}^{tree}` : `${headSha}:${packageDir}`;
    return propertyGit(repoPath, ['rev-parse', '--verify', '--quiet', spec]).trim() || null;
  } catch {
    return null;
  }
}

function commitsSince(repoPath: string, headSha: string, packageDir: string, sinceSha: string | null): number {
  const range = sinceSha === null ? headSha : `${sinceSha}..${headSha}`;
  try {
    const out = propertyGit(repoPath, ['rev-list', '--count', range, '--', `:(literal)${packageDir}`]).trim();
    const count = Number.parseInt(out, 10);
    return Number.isSafeInteger(count) ? count : 0;
  } catch {
    // A pruned or unrelated earlier head: count the whole history instead.
    return sinceSha === null ? 0 : commitsSince(repoPath, headSha, packageDir, null);
  }
}


export function buildRaidCandidates(inputs: CandidateInputs): RaidCandidateList {
  const candidates: RaidCandidate[] = [];
  const exclusions: RaidExclusion[] = [];
  for (const repo of [...inputs.managedRepos].sort()) {
    const repoPath = join(inputs.workspaceRoot, repo);
    const exclude = (reason: string, packageDir: string | null = null): void => { exclusions.push({ repo, packageDir, reason }); };
    if (!existsSync(join(repoPath, '.git'))) { exclude('not a git checkout under the workspace root'); continue; }
    let optedOut: boolean;
    try {
      optedOut = loadWorktreeManifest(repoPath)?.vector?.enabled === false;
    } catch (error) {
      exclude(`its .gru-command/worktree.toml does not load: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (optedOut) { exclude('opted out: [vector] enabled = false in .gru-command/worktree.toml'); continue; }
    let mode: string;
    try {
      mode = loadPropertyConfig(repoPath)?.mode ?? 'disabled';
    } catch (error) {
      exclude(`its .gru-command/property.toml does not load: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (mode === 'disabled') { exclude('property execution is disabled (.gru-command/property.toml mode is missing or "disabled")'); continue; }
    const headSha = defaultHead(repoPath);
    if (headSha === null) { exclude('no cached origin default branch (refs/remotes/origin/HEAD); fetch the repository'); continue; }
    if (raidsTowardCap(inputs.raids, repo, inputs.now) >= inputs.maxRaidsPerDay) {
      exclude(`daily raid cap reached (${String(inputs.maxRaidsPerDay)} in the last 24 hours)`);
      continue;
    }
    let packages;
    try {
      packages = (inputs.resolvePackages ?? ((root: string) => resolvePropertyCapabilities({ repoRoot: root }).packages))(repoPath);
    } catch (error) {
      exclude(`capability resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const row of packages) {
      const packageDir = row.packageDir;
      if (row.status !== 'resolved' || row.adapterId === null || row.tooling?.executable !== true) {
        exclude(`no runnable property adapter (${row.status}${row.reasons.length > 0 ? `: ${row.reasons.join('; ')}` : ''})`, packageDir);
        continue;
      }
      if (row.adapterId !== RAID_ADAPTER) { exclude(`raids run only the ${RAID_ADAPTER} adapter today (this package resolves to ${row.adapterId})`, packageDir); continue; }
      const sourceIdentity = packageTree(repoPath, headSha, packageDir);
      if (sourceIdentity === null) { exclude('the package is not in the default-branch head', packageDir); continue; }
      const target: RaidTarget = { repo, packageDir };
      const history = inputs.raids.filter((raid) => sameTarget(raid.target, target));
      const atIdentity = history.filter((raid) => raid.sourceIdentity === sourceIdentity);
      if (history.some((raid) => raid.state === 'proposed')) { exclude('a raid proposal for it is pending', packageDir); continue; }
      if (history.some((raid) => raid.state === 'queued' || raid.state === 'running')) { exclude('a raid on it is queued or running', packageDir); continue; }
      if (atIdentity.some(raidedHere)) { exclude('already raided at this source identity', packageDir); continue; }
      if (atIdentity.some((raid) => raid.state === 'declined')) { exclude('declined at this source identity', packageDir); continue; }
      const last = history.filter((raid) => raid.launchedAt !== null).sort((left, right) => Date.parse(right.launchedAt!) - Date.parse(left.launchedAt!))[0];
      const signals: RaidSignals = {
        commitsSinceLastRaid: commitsSince(repoPath, headSha, packageDir, last?.headSha ?? null),
        escapedRegressions: inputs.escapedRegressions(target),
        perkinsFindings: inputs.perkinsFindings(repo, last?.launchedAt ?? null),
        daysSinceLastRaid: last === undefined ? null : Math.floor((inputs.now.getTime() - Date.parse(last.launchedAt!)) / DAY_MS),
      };
      candidates.push({ target, repoPath, headSha, sourceIdentity, adapterId: row.adapterId, signals, score: rankScore(signals) });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.target.repo.localeCompare(right.target.repo) || left.target.packageDir.localeCompare(right.target.packageDir));
  const digest = createHash('sha256')
    .update(JSON.stringify(candidates.map((candidate) => [candidate.target.repo, candidate.target.packageDir, candidate.sourceIdentity])))
    .digest('hex');
  return { candidates, exclusions, digest };
}
