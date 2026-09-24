import { spawnSync } from 'node:child_process';
import type { ClaudeReviewSnapshot } from '../runtime/claude-review-settings.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
export { buildClaudeCodeAuthArgs } from '../runtime/claude-model.js';

/**
 * Review-path selection (user amendment 2026-09-20, bmad-review fallback
 * rulings 1-4 + fork-3 extension): Perkins is the PRIMARY gate. At review
 * request time a fail-closed four-leg capability pre-flight decides the
 * route. Every leg passing -> Perkins review. Any leg failing -> the
 * bmad-review skill, which carries FULL GATE semantics: findings are
 * triaged (release-safety defects are blockers), blockers route back to
 * the implementing MINION as a fix directive, and the loop re-reviews
 * until clean or the bound is exhausted. Merge authority never moves:
 * only an exact-head Perkins READY can authorize a merge.
 */

export const REVIEW_CAPABILITY_LEGS = [
  'resource-integrity',
  'model-provider',
  'code-host',
  'review-policy',
] as const;

export type ReviewCapabilityLeg = (typeof REVIEW_CAPABILITY_LEGS)[number];

export interface ReviewCapabilityFailure {
  readonly leg: ReviewCapabilityLeg;
  readonly detail: string;
  /** User-facing instruction for restoring the Perkins gate. */
  readonly remediation: string;
}

export interface ReviewPreflightResult {
  readonly ok: boolean;
  readonly failures: readonly ReviewCapabilityFailure[];
  /** In-memory request-owned proof, never included in fallback findings. */
  readonly reviewModel?: ClaudeReviewSnapshot;
}

const LEG_REMEDIATION: Readonly<Record<ReviewCapabilityLeg, string>> = {
  'resource-integrity':
    'Reinstall the product so the integrity-pinned Perkins policy and MCP server match the compiled pins (npm run build; node tools/verify-perkins-resource.mjs <product-root>).',
  'model-provider':
    'Configure and authenticate the review model provider for the perkins role (runtimes/models config; provider login or API key), then retry.',
  'code-host':
    'Authenticate the code host for the repository remote — GitHub: `gh auth login` (token valid for the remote repo); GitLab: set GITLAB_TOKEN with access to the remote project — then retry.',
  'review-policy':
    'Enable the Perkins review gate in config: set [review] enabled = true in the instance config.',
};

/** A pre-flight leg check: resolves quietly on success, throws a
 * user-facing reason on failure. Never mutates repository state. */
export type ReviewLegCheck = () => void | Promise<void>;

export function preflightFailure(leg: ReviewCapabilityLeg, detail: string): ReviewCapabilityFailure {
  return { leg, detail, remediation: LEG_REMEDIATION[leg] };
}

/** Fail-closed four-leg pre-flight. Every check runs; failures accumulate
 * so the report names every unavailable leg at once. */
export async function runReviewPreflight(checks: Readonly<Record<ReviewCapabilityLeg, ReviewLegCheck>>): Promise<ReviewPreflightResult> {
  const failures: ReviewCapabilityFailure[] = [];
  for (const leg of REVIEW_CAPABILITY_LEGS) {
    try {
      await checks[leg]();
    } catch (error) {
      failures.push(preflightFailure(leg, error instanceof Error ? error.message : String(error)));
    }
  }
  return { ok: failures.length === 0, failures };
}

export interface RepoRemote {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

/** Parse https/ssh Git remotes into host/owner/repo. */
export function parseRepoRemote(url: string): RepoRemote | null {
  const text = url.trim();
  // The final path segment is the repo; everything before it is the owner
  // path (GitHub: one segment; GitLab subgroups: multiple segments).
  const https = /^https:\/\/([^/]+)\/(.+)$/u.exec(text);
  if (https !== null) {
    if (https[1]!.includes('@')) return null;
    const project = https[2]!.replace(/\/+$/u, '').replace(/\.git$/u, '');
    const separator = project.lastIndexOf('/');
    if (separator === -1) return null;
    return { host: https[1]!, owner: project.slice(0, separator), repo: project.slice(separator + 1) };
  }
  const ssh = /^(?:ssh:\/\/)?git@([^/:@]+)(?::\d+)?[:/](.+)$/u.exec(text);
  if (ssh !== null) {
    const project = ssh[2]!.replace(/\/+$/u, '').replace(/\.git$/u, '');
    const separator = project.lastIndexOf('/');
    if (separator === -1) return null;
    return { host: ssh[1]!, owner: project.slice(0, separator), repo: project.slice(separator + 1) };
  }
  return null;
}

export function repoRemote(repoPath: string, gitBinary = 'git'): RepoRemote | null {
  const origin = spawnSync(gitBinary, ['-C', repoPath, 'remote', 'get-url', 'origin'], {
    encoding: 'utf-8', timeout: 10_000,
  });
  if (origin.error !== undefined || origin.status !== 0) return null;
  return parseRepoRemote((origin.stdout ?? '').trim());
}

export function isGitHubRemote(host: string): boolean {
  return /(^|\.)github\.com$/iu.test(host) || host.toLowerCase().endsWith('.github');
}

/** GitLab hosts: gitlab.com and self-hosted hosts whose first hostname
 * label starts with 'gitlab' (e.g. gitlab.example.test). Other hosts are
 * unsupported for verdict delivery — neither probe nor poster will send
 * credentials to them. */
export function isGitLabRemote(host: string): boolean {
  if (host.includes('@') || host.includes('/') || host.includes(' ')) return false;
  const lowered = host.toLowerCase();
  // Only gitlab.com and self-hosted hosts whose FIRST hostname label is
  // exactly 'gitlab' (e.g. gitlab.example.test). This prevents credential
  // leakage to lookalike hosts like evil.gitlab.attacker.test.
  return lowered === 'gitlab.com' || lowered.split('.')[0] === 'gitlab';
}

/** Cheap GitHub probe: the gh token must read the exact remote repo. */
export function probeGitHubRemote(remote: RepoRemote, binary = 'gh'): void {
  const result = spawnSync(
    binary,
    ['api', '--hostname', remote.host, `repos/${remote.owner}/${remote.repo}`, '--jq', '.full_name'],
    { encoding: 'utf-8', timeout: 15_000 },
  );
  if (result.error !== undefined) {
    throw new Error(`gh is unavailable (${String(result.error)})`);
  }
  if (result.status !== 0) {
    throw new Error(
      `gh cannot read ${remote.owner}/${remote.repo} on ${remote.host} (exit ${result.status}): ${(result.stderr ?? '').trim().slice(0, 300)}`,
    );
  }
}

export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/** Cheap GitLab probe: PRIVATE-TOKEN must read the exact remote project. */
export async function probeGitLabRemote(
  remote: RepoRemote,
  token: string | undefined,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
  if (token === undefined || token.trim() === '') {
    throw new Error(`no GitLab token configured for ${remote.host} — set GITLAB_TOKEN`);
  }
  const project = encodeURIComponent(`${remote.owner}/${remote.repo}`);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`https://${remote.host}/api/v4/projects/${project}`, {
      headers: { 'PRIVATE-TOKEN': token },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`GitLab probe for ${remote.host} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`GitLab token cannot read ${remote.owner}/${remote.repo} on ${remote.host} (HTTP ${response.status})`);
  }
}

/** Leg 4 seam. */
export interface ReviewPolicyProbe {
  reviewEnabled(): boolean;
}

export function probeReviewPolicy(probe: ReviewPolicyProbe): void {
  if (!probe.reviewEnabled()) {
    throw new Error('the Perkins review gate is disabled in config ([review] enabled = false)');
  }
}

// ---------------------------------------------------------------------------
// Fallback gate triage (fork-3 extension): the bmad-review path carries FULL
// gate semantics. Release-safety defects block; everything else is a note.
// ---------------------------------------------------------------------------

export interface FallbackFinding {
  readonly title: string;
  readonly category: string;
  readonly location: string;
  readonly evidence: string;
  readonly detail: string;
}

export interface TriagedFallbackFindings {
  readonly blockers: readonly FallbackFinding[];
  readonly notes: readonly FallbackFinding[];
}

const BLOCKER_CATEGORIES = new Set([
  'correctness',
  'security',
  'data-loss',
  'data-loss-bug',
  'broken-build',
  'build-failure',
  'crash',
  'regression',
  'vulnerability',
  'injection',
  'secret-leak',
]);

function normalizeCategory(category: string): string {
  return category.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
}

/** Host-owned triage: only classified release-safety defects are blockers;
 * unknown categories are notes (the amendment's "the rest are notes"). */
export function triageFallbackFindings(findings: readonly FallbackFinding[]): TriagedFallbackFindings {
  const blockers: FallbackFinding[] = [];
  const notes: FallbackFinding[] = [];
  for (const finding of findings) {
    if (BLOCKER_CATEGORIES.has(normalizeCategory(finding.category))) blockers.push(finding);
    else notes.push(finding);
  }
  return { blockers, notes };
}

/** The fix directive routed to the implementing MINION session. */
export function renderFixDirective(blockers: readonly FallbackFinding[], iteration: number): string {
  const lines = [
    `[bmad-review gate] Fix directive (round ${iteration}): the review found ${blockers.length} release-safety blocker(s) on this lane. Fix each one in this worktree, then reply DONE.`,
    '',
  ];
  blockers.forEach((blocker, index) => {
    lines.push(
      `BLOCKER ${index + 1}: ${blocker.title}`,
      `  category: ${blocker.category}`,
      `  location: ${blocker.location}`,
      `  evidence: ${blocker.evidence}`,
      `  detail: ${blocker.detail}`,
      '',
    );
  });
  lines.push('These blockers gate release. Correct the implementation and any affected tests; do not weaken the review findings.');
  return lines.join('\n');
}

/** Bound the diff handed to the fallback review session. */
export function boundedDiff(diff: string, maxBytes = 512 * 1024): string {
  const bytes = Buffer.byteLength(diff, 'utf8');
  if (bytes <= maxBytes) return diff;
  const clipped = Buffer.from(diff, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${clipped}\n...[diff truncated at ${maxBytes} bytes of ${bytes}]...\n`;
}

/** Read and validate the JSON findings array a fallback review session wrote. */
export function parseFallbackFindingsReport(file: string): readonly FallbackFinding[] {
  const info = statSync(file);
  if (info.size > 4 * 1024 * 1024) throw new Error(`fallback review report exceeds 4 MiB: ${file}`);
  const bytes = readFileSync(file);
  if (bytes.byteLength !== info.size) throw new Error('fallback review report changed while being read');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`fallback review report is malformed JSON (${String(error)})`);
  }
  if (!Array.isArray(parsed) || parsed.length > 200) {
    throw new Error('fallback review report must be a JSON array of at most 200 findings');
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`fallback finding ${index} must be an object`);
    }
    const value = entry as Record<string, unknown>;
    const field = (key: string): string => {
      const raw = value[key];
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error(`fallback finding ${index} field ${key} must be a non-empty string`);
      }
      if (Buffer.byteLength(raw, 'utf8') > 4_000) {
        throw new Error(`fallback finding ${index} field ${key} exceeds 4000 UTF-8 bytes`);
      }
      return raw;
    };
    return {
      title: field('title'),
      category: field('category'),
      location: field('location'),
      evidence: field('evidence'),
      detail: field('detail'),
    };
  });
}

export function skillInstalled(skillPath: string): boolean {
  if (!existsSync(skillPath)) return false;
  try {
    return statSync(skillPath).isFile();
  } catch {
    return false;
  }
}
