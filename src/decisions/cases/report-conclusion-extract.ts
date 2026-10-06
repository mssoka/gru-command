import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filteredState, summariseReportBody } from '../questions.js';
import { reportLabelFromCanonicalVerdict } from './report-conclusion.js';
import type { LabelledCase } from './registry.js';

/**
 * Extract report-type job handbacks, not Perkins review-round verdicts.
 * The artifact root contains one directory per delivered job, each with a
 * `handback.json` export: { schemaVersion: 1, jobId, deliverable: 'review',
 * report: <final report text> }. Only reports with an unambiguous verdict
 * line are labelled; the verdict line is stripped from the provider state.
 * Missing and ambiguous handbacks never become guessed training cases.
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
      raw = readFileSync(join(artifactRoot, entry, 'handback.json'), 'utf8');
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
    const handback = parsed as Record<string, unknown>;
    if (
      handback['schemaVersion'] !== 1 || handback['deliverable'] !== 'review' ||
      typeof handback['jobId'] !== 'string' || handback['jobId'].trim() === '' ||
      typeof handback['report'] !== 'string'
    ) continue;
    const lines = handback['report'].split(/\r?\n/u);
    const verdictLines = lines.map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*(?:\*\*)?Verdict:\s*(READY TO MERGE|NEEDS CHANGES|MAJOR REWORK NEEDED|INCOMPLETE)(?:\*\*)?\s*$/iu.test(line));
    if (verdictLines.length !== 1) continue;
    const verdict = verdictLines[0]!;
    const text = verdict.line.replace(/^\s*(?:\*\*)?Verdict:\s*/iu, '').replace(/\*\*\s*$/u, '').trim();
    const label = reportLabelFromCanonicalVerdict(text);
    if (label === null) continue;
    // The verdict is ground truth, not part of the question. Remove other
    // explicit verdict lines too if a report format later adds them, then
    // summarise with the SAME bounded function production uses so a long
    // report is summarised, never tail-truncated, on both sides.
    const body = summariseReportBody(lines.filter((_, index) => index !== verdict.index).join('\n').trim());
    if (body === '') continue;
    cases.push({
      id: `reportconclusion-${handback['jobId']}`,
      state: filteredState({ report: body }),
      label,
    });
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}
