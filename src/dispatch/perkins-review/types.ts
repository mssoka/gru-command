import type { PerkinsFindingSource, PerkinsLens } from './policy.js';

export type FindingSeverity = 'blocker' | 'warning' | 'note';

export interface ReviewFinding {
  readonly source: PerkinsFindingSource;
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly title: string;
  readonly location: string;
  readonly evidence: string;
  readonly detail: string;
  readonly recommended_fix: string;
}

/** A lead's disposition of one prior-round finding: substantive reviewer
 * judgment with a bounded note — deliberately free of the retired
 * removed-line/distinct-file/PATH-ABSENT proof shapes. */
export interface PriorDisposition {
  readonly prior_index: number;
  readonly status: 'fixed' | 'still-present';
  readonly note: string;
}

/** A verified finding in a round's durable consolidated record. Legacy
 * schemaVersion-2 records may still carry a `chunks: string[]` field; it is
 * read tolerantly and never written by new rounds. */
export interface VerifiedFinding extends ReviewFinding {
  readonly verification: {
    readonly disposition: 'confirmed' | 'unverifiable-speculative';
    readonly evidence: string;
    readonly reason: string;
  };
  readonly sources: readonly PerkinsFindingSource[];
  readonly roundOrigin: number;
}

export interface LensEnvelope {
  readonly schemaVersion: 1;
  readonly lens: PerkinsLens;
  readonly attempt: 1 | 2;
  readonly status: 'valid' | 'invalid' | 'failed';
  readonly outputSha256: string | null;
  readonly findings: readonly ReviewFinding[];
  /** Present when a text-path child's output required tolerant recovery
   * (whitespace/fence/preamble/embedded array) before strict validation. */
  readonly recovery?: LensOutputRecovery;
  /** Present when status is not valid: the precise failure class. */
  readonly failureKind?: ChildFailureKind;
  readonly error?: string;
}

/** How a non-bare text-path child output was recovered before the strict
 * finding schema validated it. */
export type LensOutputRecovery =
  | 'parsed-from-whitespace'
  | 'parsed-from-fence'
  | 'parsed-from-preamble'
  | 'parsed-from-embedded-array';

/** Precise class of a child run that produced no valid output: a review turn
 * that spent its budget ('timeout'), a rejected/invalid output ('output'), or
 * a host/runtime failure before any valid output existed ('error'). */
export type ChildFailureKind = 'timeout' | 'output' | 'error';

export type CanonicalReviewVerdict =
  | 'READY TO MERGE'
  | 'NEEDS CHANGES'
  | 'MAJOR REWORK NEEDED'
  | 'INCOMPLETE';

export interface RecoveredFindings {
  readonly findings: readonly ReviewFinding[];
  /** Present only when strict recovery was required and applied. */
  readonly recovery?: LensOutputRecovery;
}

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
/** The perkins_submit_findings tool input mirrors the finding shape minus
 * `source`: the host owns the lens identity on the structured path. */
const SUBMITTED_FINDING_KEYS = [
  'severity',
  'category',
  'title',
  'location',
  'evidence',
  'detail',
  'recommended_fix',
] as const;

/** Literal Git path only; no pathspecs, escape components or control bytes. */
export function safeFixPath(path: string): boolean {
  return path !== '' && Buffer.byteLength(path, 'utf8') <= 500 &&
    !path.startsWith('/') && !path.startsWith('-') && !path.includes('\\') &&
    !path.includes(':') && ![...path].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    }) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

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

/** First balanced top-level JSON array in arbitrary text. Bracket pairs
 * that are not valid JSON (prose like "[see below]") are skipped so the
 * search continues; the returned span is still validated strictly by the
 * caller after parsing. */
function firstJsonArraySpan(text: string): { readonly json: string; readonly start: number; readonly end: number } | null {
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf('[', searchFrom);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '[') depth += 1;
      else if (character === ']') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end === -1) {
      searchFrom = start + 1;
      continue;
    }
    const json = text.slice(start, end);
    try {
      if (Array.isArray(JSON.parse(json))) return { json, start, end };
    } catch {
      // Not a JSON array: keep scanning after this bracket pair.
    }
    searchFrom = end;
  }
}

/** Contents of every closed Markdown code fence, in order. */
function fencedContents(text: string): readonly string[] {
  const lines = text.split('\n');
  const contents: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const open = /^\s*(`{3,}|~{3,})[^\n]*$/u.exec(lines[index]!);
    if (open === null) {
      index += 1;
      continue;
    }
    const marker = open[1]!;
    let matched = false;
    for (let probe = index + 1; probe < lines.length; probe += 1) {
      const close = /^\s*(`{3,}|~{3,})\s*$/u.exec(lines[probe]!);
      if (close !== null && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
        contents.push(lines.slice(index + 1, probe).join('\n'));
        index = probe + 1;
        matched = true;
        break;
      }
    }
    if (!matched) index += 1;
  }
  return contents;
}

interface FindingsCandidate {
  readonly json: string;
  readonly recovery?: LensOutputRecovery;
}

function findingsCandidates(text: string): readonly FindingsCandidate[] {
  const candidates: FindingsCandidate[] = [{ json: text }];
  const trimmed = text.trim();
  if (trimmed !== text) candidates.push({ json: trimmed, recovery: 'parsed-from-whitespace' });
  for (const content of fencedContents(text)) {
    const span = firstJsonArraySpan(content);
    if (span !== null) candidates.push({ json: span.json, recovery: 'parsed-from-fence' });
  }
  const extracted = firstJsonArraySpan(text);
  if (extracted !== null) {
    const before = text.slice(0, extracted.start).trim() !== '';
    const after = text.slice(extracted.end).trim() !== '';
    candidates.push({
      json: extracted.json,
      recovery: before ? (after ? 'parsed-from-embedded-array' : 'parsed-from-preamble') : 'parsed-from-embedded-array',
    });
  }
  return candidates;
}

/**
 * Strict tolerant recovery for a NON-tool (text-path) specialist child: try
 * the bare array first, then whitespace/fence/preamble/prose recovery, and
 * validate every candidate with the exact strict schema. Recovery only
 * locates the JSON array — a recovered array whose findings fail validation
 * is still invalid. The primary pi path never uses this: native calls are
 * validated directly.
 */
export function parseFindingsWithRecovery(text: string, expectedLens: PerkinsLens): RecoveredFindings {
  let structuralError: Error | null = null;
  let schemaError: Error | null = null;
  for (const candidate of findingsCandidates(text)) {
    let entries: unknown[];
    try {
      entries = parseArray(candidate.json, 'lens output');
    } catch (error) {
      structuralError ??= error instanceof Error ? error : new Error(String(error));
      continue;
    }
    try {
      const findings = validateFindingEntries(entries, expectedLens, true);
      return candidate.recovery === undefined ? { findings } : { findings, recovery: candidate.recovery };
    } catch (error) {
      // A located array that fails the finding schema outranks the
      // structural "not a bare array" complaint from the surrounding text.
      schemaError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  throw schemaError ?? structuralError ?? new Error('lens output produced no JSON array');
}

function validateFindingEntries(
  entries: readonly unknown[],
  expectedLens: PerkinsLens,
  sourceIncluded: boolean,
): readonly ReviewFinding[] {
  const findings = entries.map((entry, index) => {
    const candidate = object(entry, `finding ${index}`);
    exactKeys(candidate, sourceIncluded ? FINDING_KEYS : SUBMITTED_FINDING_KEYS, `finding ${index}`);
    if (sourceIncluded && candidate.source !== expectedLens) {
      throw new Error(`finding ${index} source must be ${expectedLens}`);
    }
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
  return findings;
}

export function parseFindings(text: string, expectedLens: PerkinsLens): readonly ReviewFinding[] {
  return validateFindingEntries(parseArray(text, 'lens output'), expectedLens, true);
}

/** Validate the exact JSON input of the perkins_submit_findings tool: the
 * findings array mirrors the finding shape with the host-owned `source`
 * deliberately absent. Same strictness as the text envelope. */
export function parseFindingsSubmission(input: unknown, expectedLens: PerkinsLens): readonly ReviewFinding[] {
  const value = object(input, 'perkins_submit_findings input');
  exactKeys(value, ['findings'], 'perkins_submit_findings input');
  if (!Array.isArray(value.findings)) throw new Error('perkins_submit_findings input findings must be an array');
  if (value.findings.length > 200) throw new Error('perkins_submit_findings input exceeds 200 findings');
  return validateFindingEntries(value.findings, expectedLens, false);
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
      sources: [...new Set([...prior.sources, ...finding.sources])].sort(),
      roundOrigin: Math.min(prior.roundOrigin, finding.roundOrigin),
    });
  }
  return [...byKey.values()].sort((left, right) => {
    const severity = severityRank[right.severity] - severityRank[left.severity];
    return severity !== 0 ? severity : `${left.location}\0${left.title}`.localeCompare(`${right.location}\0${right.title}`);
  });
}
