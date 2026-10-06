import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filteredState } from '../questions.js';
import { reportLabelFromCanonicalVerdict } from './report-conclusion.js';
import type { LabelledCase } from './registry.js';

/**
 * Report-conclusion labelled-case extractor (issue #223).
 *
 * Label source per the issue: "#220 or the report's verdict line". #220's
 * disposition records do not exist yet, so the extractor labels from the
 * report's durable verdict line — `consolidated.json`'s canonicalVerdict:
 *   READY TO MERGE → clean_pass
 *   NEEDS CHANGES / MAJOR REWORK NEEDED → findings_need_action
 *   INCOMPLETE → inconclusive
 * anything else (or a file that fails the durable schema) is skipped.
 *
 * Read-only over the review artifact tree; the state is the bounded,
 * redacted structural summary of the report — never its prose.
 */

export function extractReportConclusionCases(artifactRoot: string): LabelledCase[] {
  let entries: string[];
  try {
    entries = readdirSync(artifactRoot, { encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const cases: LabelledCase[] = [];
  for (const entry of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(entry) || entry === '.' || entry === '..') continue;
    let raw: string;
    try {
      raw = readFileSync(join(artifactRoot, entry, 'consolidated.json'), 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const c = parsed as Record<string, unknown>;
    if (c['schemaVersion'] !== 3 || typeof c['canonicalVerdict'] !== 'string') continue;
    const label = reportLabelFromCanonicalVerdict(c['canonicalVerdict']);
    if (label === null) continue;
    const findings = Array.isArray(c['findings']) ? (c['findings'] as unknown[]) : [];
    const severities = findings
      .map((finding) => (typeof finding === 'object' && finding !== null ? (finding as Record<string, unknown>)['severity'] : null))
      .filter((severity): severity is string => typeof severity === 'string');
    cases.push({
      id: `reportconclusion-${entry}`,
      state: filteredState({
        canonical_verdict: c['canonicalVerdict'],
        complete: c['complete'] === true,
        head_moved: c['headMoved'] === true,
        finding_count: findings.length,
        blocker_count: severities.filter((severity) => severity === 'blocker').length,
        warning_count: severities.filter((severity) => severity === 'warning').length,
        prior_disposition_count: Array.isArray(c['priorDispositions']) ? c['priorDispositions'].length : 0,
      }),
      label,
    });
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}
