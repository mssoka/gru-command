import type { PerkinsLens } from './policy.js';

export type FindingSeverity = 'blocker' | 'warning' | 'note';

export interface ReviewFinding {
  readonly source: PerkinsLens;
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly title: string;
  readonly location: string;
  readonly evidence: string;
  readonly detail: string;
  readonly recommended_fix: string;
}

export type VerificationDisposition = 'confirmed' | 'rejected' | 'unverifiable-speculative';

export interface VerificationResult {
  readonly candidate: number;
  readonly disposition: VerificationDisposition;
  readonly evidence: string;
  readonly reason: string;
}

export interface FixAuditResult {
  readonly prior_index: number;
  readonly status: 'fixed' | 'still-present';
  readonly evidence: string;
  readonly reason: string;
}

export interface VerifiedFinding extends ReviewFinding {
  readonly verification: {
    readonly disposition: Exclude<VerificationDisposition, 'rejected'>;
    readonly evidence: string;
    readonly reason: string;
  };
  readonly chunks: readonly string[];
  readonly sources: readonly PerkinsLens[];
  readonly roundOrigin: number;
}

export interface LensEnvelope {
  readonly schemaVersion: 1;
  readonly lens: PerkinsLens;
  readonly chunk: string;
  readonly attempt: 1 | 2;
  readonly status: 'valid' | 'invalid' | 'failed';
  readonly outputSha256: string | null;
  readonly findings: readonly ReviewFinding[];
  readonly error?: string;
}

export interface ReviewCompleteness {
  readonly complete: boolean;
  readonly requiredLensRuns: number;
  readonly validLensRuns: number;
  readonly failedRuns: readonly { readonly lens: PerkinsLens; readonly chunk: string; readonly reason: string }[];
  readonly verificationComplete: boolean;
}

export type CanonicalReviewVerdict =
  | 'READY TO MERGE'
  | 'NEEDS CHANGES'
  | 'MAJOR REWORK NEEDED'
  | 'INCOMPLETE';

const FINDING_KEYS = [
  'source',
  'severity',
  'category',
  'title',
  'location',
  'evidence',
  'detail',
  'recommended_fix',
] as const;
const VERIFICATION_KEYS = ['candidate', 'disposition', 'evidence', 'reason'] as const;
const FIX_AUDIT_KEYS = ['prior_index', 'status', 'evidence', 'reason'] as const;

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) throw new Error(`${name} keys do not match the required schema`);
}

function boundedString(value: unknown, name: string, max = 2_000): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  if (Buffer.byteLength(value, 'utf8') > max) throw new Error(`${name} exceeds ${max} UTF-8 bytes`);
  return value;
}

function enforceWordLimit(value: string, name: string, maxWords: number): string {
  const words = value.trim().split(/\s+/u).filter(Boolean).length;
  if (words > maxWords) throw new Error(`${name} exceeds ${maxWords} words`);
  return value;
}

function parseArray(text: string, name: string): unknown[] {
  if (text.trim() !== text || !text.startsWith('[') || !text.endsWith(']')) {
    throw new Error(`${name} must be a bare JSON array with no preamble or markdown fence`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is malformed JSON (${String(error)})`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  if (parsed.length > 200) throw new Error(`${name} exceeds 200 entries`);
  return parsed;
}

export function parseFindings(text: string, expectedLens: PerkinsLens): readonly ReviewFinding[] {
  const findings = parseArray(text, 'lens output').map((entry, index) => {
    const candidate = object(entry, `finding ${index}`);
    exactKeys(candidate, FINDING_KEYS, `finding ${index}`);
    if (candidate.source !== expectedLens) throw new Error(`finding ${index} source must be ${expectedLens}`);
    if (typeof candidate.severity !== 'string' || !['blocker', 'warning', 'note'].includes(candidate.severity)) {
      throw new Error(`finding ${index} severity is invalid`);
    }
    const detail = enforceWordLimit(
      boundedString(candidate.detail, `finding ${index} detail`, 320),
      `finding ${index} detail`,
      40,
    );
    const fix = enforceWordLimit(
      boundedString(candidate.recommended_fix, `finding ${index} recommended_fix`, 320),
      `finding ${index} recommended_fix`,
      40,
    );
    return {
      source: expectedLens,
      severity: candidate.severity as FindingSeverity,
      category: boundedString(candidate.category, `finding ${index} category`, 80),
      title: boundedString(candidate.title, `finding ${index} title`, 240),
      location: boundedString(candidate.location, `finding ${index} location`, 500),
      evidence: boundedString(candidate.evidence, `finding ${index} evidence`, 4_000),
      detail,
      recommended_fix: fix,
    };
  });
  const gates = findings.filter((finding) => finding.category === 'coverage-gate');
  if (expectedLens === 'tests') {
    if (gates.length !== 1) throw new Error('tests lens output must contain exactly one coverage-gate finding');
    const gate = gates[0]!;
    const status = /^Coverage gate: (PASS|CONCERNS|FAIL)$/u.exec(gate.title)?.[1];
    const expectedSeverity: Readonly<Record<string, FindingSeverity>> = {
      PASS: 'note', CONCERNS: 'warning', FAIL: 'blocker',
    };
    if (status === undefined || gate.severity !== expectedSeverity[status]) {
      throw new Error('tests coverage-gate must use title "Coverage gate: PASS|CONCERNS|FAIL" and matching note|warning|blocker severity');
    }
  } else if (gates.length > 0) {
    throw new Error('coverage-gate findings are owned only by the tests lens');
  }
  return findings;
}

export function parseFixAuditResults(text: string, findingCount: number): readonly FixAuditResult[] {
  const results = parseArray(text, 'fix-audit output').map((entry, index) => {
    const result = object(entry, `fix audit ${index}`);
    exactKeys(result, FIX_AUDIT_KEYS, `fix audit ${index}`);
    if (!Number.isSafeInteger(result.prior_index) || Number(result.prior_index) < 0 || Number(result.prior_index) >= findingCount) {
      throw new Error(`fix audit ${index} prior_index is invalid`);
    }
    if (typeof result.status !== 'string' || !['fixed', 'still-present'].includes(result.status)) throw new Error(`fix audit ${index} status is invalid`);
    return {
      prior_index: Number(result.prior_index),
      status: result.status as FixAuditResult['status'],
      evidence: boundedString(result.evidence, `fix audit ${index} evidence`, 4_000),
      reason: boundedString(result.reason, `fix audit ${index} reason`, 1_000),
    };
  });
  if (results.length !== findingCount || new Set(results.map((result) => result.prior_index)).size !== findingCount) {
    throw new Error('fix-audit output must contain every prior finding exactly once');
  }
  return [...results].sort((left, right) => left.prior_index - right.prior_index);
}

export function parseVerificationResults(text: string, candidateCount: number): readonly VerificationResult[] {
  const results = parseArray(text, 'verification output').map((entry, index) => {
    const result = object(entry, `verification ${index}`);
    exactKeys(result, VERIFICATION_KEYS, `verification ${index}`);
    if (!Number.isSafeInteger(result.candidate) || Number(result.candidate) < 0 || Number(result.candidate) >= candidateCount) {
      throw new Error(`verification ${index} candidate index is invalid`);
    }
    if (typeof result.disposition !== 'string' || !['confirmed', 'rejected', 'unverifiable-speculative'].includes(result.disposition)) {
      throw new Error(`verification ${index} disposition is invalid`);
    }
    return {
      candidate: Number(result.candidate),
      disposition: result.disposition as VerificationDisposition,
      evidence: boundedString(result.evidence, `verification ${index} evidence`, 4_000),
      reason: boundedString(result.reason, `verification ${index} reason`, 1_000),
    };
  });
  if (results.length !== candidateCount || new Set(results.map((result) => result.candidate)).size !== candidateCount) {
    throw new Error('verification output must contain every candidate exactly once');
  }
  return [...results].sort((left, right) => left.candidate - right.candidate);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function dedupeVerifiedFindings(findings: readonly VerifiedFinding[]): readonly VerifiedFinding[] {
  const severityRank: Record<FindingSeverity, number> = { blocker: 3, warning: 2, note: 1 };
  const byKey = new Map<string, VerifiedFinding>();
  for (const finding of findings) {
    const key = `${normalize(finding.title)}\0${normalize(finding.location)}`;
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, finding);
      continue;
    }
    const preferred = severityRank[finding.severity] > severityRank[prior.severity] ? finding : prior;
    byKey.set(key, {
      ...preferred,
      chunks: [...new Set([...prior.chunks, ...finding.chunks])].sort(),
      sources: [...new Set([...prior.sources, ...finding.sources])].sort(),
      roundOrigin: Math.min(prior.roundOrigin, finding.roundOrigin),
    });
  }
  return [...byKey.values()].sort((left, right) => {
    const severity = severityRank[right.severity] - severityRank[left.severity];
    return severity !== 0 ? severity : `${left.location}\0${left.title}`.localeCompare(`${right.location}\0${right.title}`);
  });
}

export function verdictForFindings(
  findings: readonly VerifiedFinding[],
  completeness: ReviewCompleteness,
): CanonicalReviewVerdict {
  if (!completeness.complete || !completeness.verificationComplete) return 'INCOMPLETE';
  const blockers = findings.filter((finding) => finding.severity === 'blocker').length;
  if (blockers === 0) return 'READY TO MERGE';
  if (blockers <= 3) return 'NEEDS CHANGES';
  return 'MAJOR REWORK NEEDED';
}
