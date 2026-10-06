import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filteredState } from '../questions.js';
import { caseHash } from './escalation-triage-extract.js';
import type { LabelledCase } from './registry.js';

/**
 * Same-blocker labelled-case extractor (issue #223).
 *
 * Pairs review findings across Perkins review rounds of the same target
 * commit (grouped by `consolidated.json`'s frozen targetSha):
 *  - POSITIVE (`same`): a finding the lead CARRIED into a later round —
 *    its normalized title+location key (the same key
 *    `dedupeVerifiedFindings` merges on) already exists in a prior
 *    round's consolidated findings. The lead's own carry is the ground
 *    truth that both records describe one defect.
 *  - NEGATIVE (`different`): a FRESH finding of a later round (its own
 *    roundOrigin) sharing file and category with a prior-round finding
 *    but a different carry key — the lead saw both and kept them
 *    separate despite the overlap.
 *
 * Read-only over the review artifact tree; every case state is built
 * through `filteredState` (redacted, bounded).
 */

interface ConsolidatedFile {
  readonly roundId: string;
  readonly targetSha: string | null;
  readonly roundNumber: number;
  readonly findings: readonly FindingBrief[];
}

interface FindingBrief {
  readonly title: string;
  readonly category: string;
  readonly location: string;
  readonly severity: string;
  readonly detail: string;
  readonly roundOrigin: number;
}

/** The carry-merge key, mirroring dedupeVerifiedFindings' normalize. */
export function findingCarryKey(finding: { readonly title: string; readonly location: string }): string {
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/gu, ' ');
  return `${normalize(finding.title)}\0${normalize(finding.location)}`;
}

function toBrief(value: unknown): FindingBrief | null {
  if (typeof value !== 'object' || value === null) return null;
  const f = value as Record<string, unknown>;
  if (
    typeof f['title'] !== 'string' || typeof f['category'] !== 'string' ||
    typeof f['location'] !== 'string' || typeof f['severity'] !== 'string' ||
    typeof f['detail'] !== 'string' || !Number.isSafeInteger(f['roundOrigin'])
  ) return null;
  return {
    title: f['title'],
    category: f['category'],
    location: f['location'],
    severity: f['severity'],
    detail: f['detail'],
    roundOrigin: f['roundOrigin'] as number,
  };
}

export function parseConsolidatedFile(roundId: string, raw: string): ConsolidatedFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (c['schemaVersion'] !== 3 || !Array.isArray(c['findings'])) return null;
  const findings = c['findings'].map(toBrief);
  if (findings.some((finding) => finding === null)) return null;
  const frozen = c['frozen'];
  const targetSha =
    typeof frozen === 'object' && frozen !== null && typeof (frozen as Record<string, unknown>)['targetSha'] === 'string'
      ? (frozen as Record<string, unknown>)['targetSha'] as string
      : null;
  const rounds = (findings as FindingBrief[]).map((finding) => finding.roundOrigin);
  const roundNumber = rounds.length > 0 ? Math.max(...rounds) : 0;
  if (roundNumber < 1) return null;
  return { roundId, targetSha, roundNumber, findings: findings as FindingBrief[] };
}

export function listConsolidatedFiles(artifactRoot: string): ConsolidatedFile[] {
  let entries: string[];
  try {
    entries = readdirSync(artifactRoot, { encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: ConsolidatedFile[] = [];
  for (const entry of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(entry) || entry === '.' || entry === '..') continue;
    const path = join(artifactRoot, entry, 'consolidated.json');
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue; // a round without a consolidated file contributes nothing
    }
    const parsed = parseConsolidatedFile(entry, raw);
    if (parsed !== null) files.push(parsed);
  }
  return files.sort((a, b) => a.roundNumber - b.roundNumber || a.roundId.localeCompare(b.roundId));
}

/** Extract same-blocker pair cases from a review artifact tree. Pure over
 * the directory contents. */
export function extractSameBlockerCases(artifactRoot: string): LabelledCase[] {
  const files = listConsolidatedFiles(artifactRoot);
  const byTarget = new Map<string, ConsolidatedFile[]>();
  for (const file of files) {
    if (file.targetSha === null) continue;
    const group = byTarget.get(file.targetSha) ?? [];
    group.push(file);
    byTarget.set(file.targetSha, group);
  }

  const cases: LabelledCase[] = [];
  for (const group of byTarget.values()) {
    for (let index = 1; index < group.length; index++) {
      const prior = group[index - 1]!;
      const current = group[index]!;
      if (current.roundNumber <= prior.roundNumber) continue;
      const priorKeys = new Map<string, FindingBrief>();
      for (const finding of prior.findings) priorKeys.set(findingCarryKey(finding), finding);
      const priorOverlaps = prior.findings;

      for (const finding of current.findings) {
        const key = findingCarryKey(finding);
        const origin = priorKeys.get(key);
        if (origin !== undefined) {
          cases.push({
            id: `sameblocker-${caseHash(prior.roundId, current.roundId, key)}`,
            state: pairState(origin, finding),
            label: 'same',
          });
          continue;
        }
        // Fresh this round (not carried), overlapping file+category with
        // a prior finding the lead did NOT merge into: kept separate.
        if (finding.roundOrigin !== current.roundNumber) continue;
        const overlap = priorOverlaps.find(
          (candidate) => candidate.location === finding.location && candidate.category === finding.category,
        );
        if (overlap === undefined) continue;
        cases.push({
          id: `sameblocker-${caseHash(prior.roundId, current.roundId, key)}`,
          state: pairState(overlap, finding),
          label: 'different',
        });
      }
    }
  }
  return cases;
}

function pairState(prior: FindingBrief, current: FindingBrief): string {
  return filteredState({
    prior_finding: {
      title: prior.title,
      category: prior.category,
      location: prior.location,
      severity: prior.severity,
      detail: prior.detail,
      round_origin: prior.roundOrigin,
    },
    current_finding: {
      title: current.title,
      category: current.category,
      location: current.location,
      severity: current.severity,
      detail: current.detail,
      round_origin: current.roundOrigin,
    },
  });
}
