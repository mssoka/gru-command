import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { LedgerApi } from '../ledger/api.js';
import {
  BlindInputRefusal,
  DEFAULT_BLIND_ISOLATION_RULE,
  deriveBlindIsolationRule,
  evaluateBlindBriefing,
  evaluateBlindPackage,
  reviewRoleFor,
  reviveBlindIsolationRule,
  scanObservedAccess,
  type BlindInputPackage,
  type BlindIsolationRule,
  type BlindPackageProvenance,
  type BlindViolation,
  type ObservedToolResult,
  type ProhibitedAccess,
  type ReviewRole,
} from './blind-input.js';

/**
 * Blind-review admission, validity and reuse (issue #316), on the ledger.
 *
 * Three durable facts, none of which rewrite a report or a settlement:
 *  - `review.blind-input-admitted` (job): the commissioning decision — role,
 *    the effective parent rule it was validated against, and the validated
 *    package provenance (digests only, never the private bytes).
 *  - `review.blind-access-observed` (job): what the reviewer's tool results
 *    actually returned, checked against that same rule.
 *  - `review.blind-input-refused` (requested job id, no job row): the audited
 *    refusal that spent no reviewer turn.
 *
 * Validity is DERIVED from those facts (`blindCoverageOf`): lifecycle
 * settlement (`delivered`/`done`, disposition `acted`) is deliberately not an
 * input, so a settled report can never read as independent coverage.
 */

export const BLIND_ADMITTED_EVENT = 'review.blind-input-admitted';
export const BLIND_ACCESS_EVENT = 'review.blind-access-observed';
export const BLIND_REFUSED_EVENT = 'review.blind-input-refused';

export type BlindCoverageState = 'qualifying' | 'invalidated' | 'unattested' | 'not-blind' | 'unclassified';

export interface BlindCoverage {
  readonly jobId: string;
  readonly state: BlindCoverageState;
  /** True only for `qualifying`: the one fact "independent blind coverage" rests on. */
  readonly qualifying: boolean;
  readonly role: ReviewRole | null;
  readonly targetSha: string | null;
  readonly packageSha256: string | null;
  readonly ruleSha256: string | null;
  readonly accessObserved: boolean;
  readonly prohibitedAccess: number;
  readonly reasons: readonly string[];
  /** The report, its findings and its settlement stay exactly as recorded. */
  readonly reportPreserved: true;
}

interface RulePayload {
  readonly excludeGlobs: readonly string[];
  readonly permitPaths: readonly string[];
  readonly requirePackage: boolean;
  readonly directives: number;
  readonly sha256: string;
}

interface AdmittedPayload {
  readonly role: ReviewRole;
  readonly attested: boolean;
  readonly target_sha: string | null;
  readonly parent_job_id: string | null;
  readonly parent_contract_sha256: string | null;
  readonly parent_contract_version: number | null;
  readonly rule: RulePayload | null;
  readonly package: BlindPackageProvenance | null;
  readonly replaces: readonly string[];
}

function ruleToPayload(rule: BlindIsolationRule): RulePayload {
  return {
    excludeGlobs: rule.excludeGlobs,
    permitPaths: rule.permitPaths,
    requirePackage: rule.requirePackage,
    directives: rule.directives,
    sha256: rule.sha256,
  };
}

/** Rebuild the exact rule a job was admitted under (digest-checked). */
function ruleFromPayload(payload: RulePayload): BlindIsolationRule {
  return reviveBlindIsolationRule(payload);
}

export interface BlindAdmission {
  readonly payload: AdmittedPayload;
}

function violationsForRecord(violations: readonly BlindViolation[]): readonly { code: string; where: string; detail: string }[] {
  return violations.map(({ code, where, detail }) => ({ code, where, detail }));
}

function sameTarget(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left.trim() === right.trim();
}

function refuse(
  ledger: LedgerApi,
  input: { readonly jobId: string; readonly parentJobId: string | null },
  refusal: BlindInputRefusal,
  ruleSha256: string | null,
): never {
  ledger.appendCustomEvent({
    kind: BLIND_REFUSED_EVENT,
    jobId: input.jobId,
    payload: {
      code: refusal.code,
      parent_job_id: input.parentJobId,
      rule_sha256: ruleSha256,
      violations: violationsForRecord(refusal.violations),
      correction: refusal.correction,
      details: refusal.details,
    },
  });
  throw refusal;
}

/**
 * Validate a review commission BEFORE any job row, worktree or reviewer
 * exists. Returns null for non-review and unclassified lanes (historical
 * bindings unchanged); `claims` reviewers are recorded and left alone.
 */
export function admitBlindReview(input: {
  readonly ledger: LedgerApi;
  readonly jobId: string;
  readonly title: string;
  readonly displayName?: string | undefined;
  readonly deliverable?: string | undefined;
  readonly reviewRole?: string | undefined;
  readonly briefing: string;
  readonly targetRef?: string | undefined;
  readonly targetSha?: string | undefined;
  readonly parentJobId?: string | undefined;
  readonly repoName: string;
  readonly inputPackage?: BlindInputPackage | undefined;
  readonly parentContractSha256?: string | undefined;
}): BlindAdmission | null {
  const { ledger } = input;
  if (input.deliverable !== 'review') {
    if (input.reviewRole !== undefined || input.inputPackage !== undefined || input.parentContractSha256 !== undefined) {
      throw new BlindInputRefusal({
        code: 'invalid_review_role',
        status: 400,
        message: `job "${input.jobId}": review_role / input_package / parent_contract_sha256 apply to deliverable "review" only`,
        violations: [],
        correction: 'Drop the blind-review fields, or commission a deliverable "review" job.',
      });
    }
    return null;
  }
  const role = reviewRoleFor({ explicit: input.reviewRole, title: input.title, displayName: input.displayName });
  const parentJobId = input.parentJobId ?? null;
  const targetSha = input.targetSha?.trim() ?? null;
  if (role === null) return null;
  if (role === 'claims') {
    return {
      payload: {
        role,
        attested: false,
        target_sha: targetSha,
        parent_job_id: parentJobId,
        parent_contract_sha256: null,
        parent_contract_version: null,
        rule: null,
        package: null,
        replaces: [],
      },
    };
  }

  // (1) The parent's EFFECTIVE contract, administrative clarifications included.
  const parent = parentJobId === null ? null : ledger.getJob(parentJobId);
  const contract = parent === null ? null : ledger.effectiveContract(parent.id);
  let rule = DEFAULT_BLIND_ISOLATION_RULE;
  if (parent !== null) {
    try {
      rule = deriveBlindIsolationRule({ briefing: parent.briefing, amendments: ledger.listJobAmendments(parent.id) });
    } catch (error) {
      refuse(
        ledger,
        { jobId: input.jobId, parentJobId },
        new BlindInputRefusal({
          code: 'blind_input_refused',
          status: 422,
          message: `parent job "${parent.id}" carries an unusable blind-isolation directive: ${error instanceof Error ? error.message : String(error)}`,
          violations: [],
          correction: `Correct the directive with an administrative amendment on "${parent.id}" (supersede the bad line), then commission the blind review again.`,
        }),
        null,
      );
    }
  }
  if (
    input.parentContractSha256 !== undefined &&
    contract !== null &&
    input.parentContractSha256.trim() !== contract.contractSha256
  ) {
    refuse(
      ledger,
      { jobId: input.jobId, parentJobId },
      new BlindInputRefusal({
        code: 'stale_parent_contract',
        status: 409,
        message: `blind review "${input.jobId}" was composed against a stale parent contract — "${parentJobId}" is now at version ${contract.version}`,
        violations: [],
        correction: `Re-read GET /api/dispatch/jobs/${parentJobId}/contract, rebuild the input package under its current blind-isolation rule, and send parent_contract_sha256 = ${contract.contractSha256}.`,
        details: { current_contract_sha256: contract.contractSha256, current_contract_version: contract.version, rule_sha256: rule.sha256 },
      }),
      rule.sha256,
    );
  }

  // (2) The input: briefing + package, validated before anything spawns.
  const violations: BlindViolation[] = [...evaluateBlindBriefing(input.briefing, rule)];
  let provenance: BlindPackageProvenance | null = null;
  if (input.inputPackage === undefined) {
    if (rule.requirePackage) {
      violations.push({
        code: 'package-required',
        where: 'input_package',
        detail: 'the parent isolation rule requires a validated input package for blind reviewers',
      });
    }
  } else {
    if (!sameTarget(input.inputPackage.targetSha, targetSha)) {
      violations.push({
        code: 'target-mismatch',
        where: 'input_package.target_sha',
        detail: `package target ${input.inputPackage.targetSha} is not the review target ${targetSha ?? '(none)'}`,
      });
    }
    const evaluated = evaluateBlindPackage(input.inputPackage, rule);
    violations.push(...evaluated.violations);
    provenance = evaluated.provenance;
  }
  if (violations.length > 0) {
    refuse(
      ledger,
      { jobId: input.jobId, parentJobId },
      new BlindInputRefusal({
        code: 'blind_input_refused',
        status: 422,
        message: `blind review "${input.jobId}" refused before any reviewer was spawned: ${violations.map((v) => `${v.code} ${v.where}`).join('; ')}`,
        violations,
        correction:
          'Rebuild input_package from the frozen target blobs and the base-to-target diff only: drop the listed paths, ' +
          'replace history-bearing documents with source/test/config at the target, and keep permitted versioned config ' +
          'by naming it in a "blind-isolation: permit <path>" directive. If this reviewer genuinely needs the claims, ' +
          'commission it with review_role "claims" instead — that is a separate contract and not blind coverage.',
        details: { rule_sha256: rule.sha256 },
      }),
      rule.sha256,
    );
  }

  // (3) Reuse: already-owned qualifying coverage of this exact target is
  // never replaced blindly. Disqualified siblings are named as replaced.
  const replaces: string[] = [];
  for (const sibling of ledger.listJobs(input.repoName)) {
    if (sibling.id === input.jobId || sibling.deliverable !== 'review') continue;
    if (!sameTarget(sibling.targetSha, targetSha) || sibling.targetRef !== (input.targetRef?.trim() ?? null)) continue;
    if ((sibling.parentJobId ?? null) !== parentJobId) continue;
    if (sibling.status === 'blocked' || sibling.status === 'parked' || sibling.status === 'binned') continue;
    let coverage: BlindCoverage;
    try {
      coverage = blindCoverageOf(ledger, sibling.id);
    } catch (error) {
      // A sibling whose coverage cannot be read is never silently replaced.
      refuse(
        ledger,
        { jobId: input.jobId, parentJobId },
        new BlindInputRefusal({
          code: 'blind_coverage_unreadable',
          status: 409,
          message: `blind coverage of sibling review "${sibling.id}" cannot be read: ${error instanceof Error ? error.message : String(error)}`,
          violations: [],
          correction: `Inspect and repair "${sibling.id}"'s ${BLIND_ACCESS_EVENT} events in the ledger (its coverage cannot be computed until they are readable), then commission again.`,
          details: { coverage_job_id: sibling.id },
        }),
        rule.sha256,
      );
    }
    if (coverage.qualifying) {
      refuse(
        ledger,
        { jobId: input.jobId, parentJobId },
        new BlindInputRefusal({
          code: 'blind_coverage_owned',
          status: 409,
          message: `blind coverage of ${targetSha ?? 'this target'} is already owned by "${sibling.id}" — no replacement reviewer is needed`,
          violations: [],
          correction: `Reuse "${sibling.id}" (GET /api/dispatch/jobs/${sibling.id}/blind-coverage). Commission a new blind review only for a new target_sha, or after that coverage is invalidated by observed access.`,
          details: { coverage_job_id: sibling.id, package_sha256: coverage.packageSha256 },
        }),
        rule.sha256,
      );
    }
    if (coverage.role === 'blind') replaces.push(sibling.id);
  }

  return {
    payload: {
      role,
      attested: provenance !== null,
      target_sha: targetSha,
      parent_job_id: parentJobId,
      parent_contract_sha256: contract?.contractSha256 ?? null,
      parent_contract_version: contract?.version ?? null,
      rule: ruleToPayload(rule),
      package: provenance,
      replaces,
    },
  };
}

/** Persist the admission on the created job row (provenance of the commissioning). */
export function recordBlindAdmission(ledger: LedgerApi, jobId: string, admission: BlindAdmission): void {
  ledger.appendCustomEvent({ kind: BLIND_ADMITTED_EVENT, jobId, payload: admission.payload });
}

function admittedOf(ledger: LedgerApi, jobId: string): AdmittedPayload | null {
  const event = ledger.latestJobEvent(jobId, BLIND_ADMITTED_EVENT);
  return event === null ? null : (event.payload as AdmittedPayload);
}

/** What makes two recorded prohibited reads the same read (#355). Events
 * recorded before #355 carry no `session` and count as one unknown session. */
const BLIND_READ_IDENTITY = {
  event: ['source', 'session'],
  entry: ['index', 'toolName', 'code', 'path', 'excerptSha256'],
} as const;

/** A transcript's identity for distinct-read counting: the sha256 of its
 * canonical path, so a symlinked spelling of the same file is the same
 * session, and the ledger never stores the local path itself. The path must
 * be absolute; a transcript gone since it was read keeps its absolute
 * spelling, and any other resolution failure is thrown. */
export function blindSessionIdentity(sessionFile: string): string {
  if (!isAbsolute(sessionFile)) throw new Error(`blind session file must be an absolute path (got ${JSON.stringify(sessionFile)})`);
  return createHash('sha256').update(canonicalPathOf(sessionFile)).digest('hex');
}

/** A path's canonical form, even once it (or its directories) is gone: the
 * nearest ancestor that still resolves, canonical, plus the names below it —
 * and a link whose target is gone names that target, joined to the link's
 * canonical directory WITHOUT lexical `..` collapse, so realpath walks it
 * physically, as it did while the target existed. The whole walk shares one
 * budget (as realpath bounds its own), and any failure other than absence is
 * raised. */
function canonicalPathOf(path: string): string {
  let budget = 64;
  const walk = (current: string): string => {
    if ((budget -= 1) < 0) throw Object.assign(new Error(`too many levels of links resolving ${path}`), { code: 'ELOOP' });
    try {
      return realpathSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) throw error;
      const canonicalParent = walk(parent);
      const link = danglingLinkTarget(current);
      if (link === null) return join(canonicalParent, basename(current));
      return walk(isAbsolute(link) ? link : `${canonicalParent}/${link}`);
    }
  };
  return walk(path);
}
/** What a symbolic link at `path` holds, or null when there is none (absent,
 * or replaced by a non-link meanwhile); any other failure is raised. */
function danglingLinkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL') return null;
    throw error;
  }
}

/** The identity a scan records: the canonical one, or — when the transcript
 * path cannot be resolved — an explicit unresolved one, so a read that was
 * scanned is never dropped for want of an identity (#356). */
function scanSessionIdentity(sessionFile: string): string {
  // Deliberately broad: the observer never throws and never drops a scanned
  // read (#356). The fallback hashes the resolved path, so repeated scans of
  // one unresolvable transcript count once.
  try {
    return blindSessionIdentity(sessionFile);
  } catch {
    return `unresolved:${createHash('sha256').update(resolve(sessionFile)).digest('hex')}`;
  }
}

/**
 * Validity of one review job as blind coverage. Derived ONLY from the
 * admission and the observed-access facts; job status and report
 * disposition are not inputs (settlement is not validity).
 */
export function blindCoverageOf(ledger: LedgerApi, jobId: string): BlindCoverage {
  const admitted = admittedOf(ledger, jobId);
  if (admitted === null) {
    return {
      jobId, state: 'unclassified', qualifying: false, role: null, targetSha: null, packageSha256: null, ruleSha256: null,
      accessObserved: false, prohibitedAccess: 0, reportPreserved: true,
      reasons: ['no blind-input admission was recorded for this job (historical or unclassified review)'],
    };
  }
  // Distinct reads (#355): a re-scan of the same transcript (a settle scan
  // plus a late physical-completion scan) re-reports a read without growing
  // the count; a read in another session, or a new one, still counts. An
  // operator re-posting the same observation is the same read; events from
  // before #355 carry no session and count as one unknown session.
  const access = ledger.countJobEventsAndDistinctArrayEntries(jobId, BLIND_ACCESS_EVENT, 'prohibited', BLIND_READ_IDENTITY);
  const prohibited = access.distinct;
  const base = {
    jobId,
    role: admitted.role,
    targetSha: admitted.target_sha,
    packageSha256: admitted.package?.packageSha256 ?? null,
    ruleSha256: admitted.rule?.sha256 ?? null,
    accessObserved: access.events > 0,
    prohibitedAccess: prohibited,
    reportPreserved: true as const,
  };
  if (admitted.role === 'claims') {
    return { ...base, state: 'not-blind', qualifying: false, reasons: ['claims-needed reviewer: a separate input contract, never blind coverage'] };
  }
  if (prohibited > 0) {
    return {
      ...base,
      state: 'invalidated',
      qualifying: false,
      reasons: [
        `the reviewer's tool results returned excluded or history-bearing material (${prohibited} observation${prohibited === 1 ? '' : 's'}); the report and its independently justified findings are preserved but are not independent blind coverage`,
      ],
    };
  }
  if (!admitted.attested) {
    return {
      ...base,
      state: 'unattested',
      qualifying: false,
      reasons: ['no validated input package was supplied at commissioning, so isolation was never established'],
    };
  }
  return { ...base, state: 'qualifying', qualifying: true, reasons: [] };
}

/**
 * Record what a reviewer's tool results actually returned, judged against
 * the rule it was admitted under. Callable repeatedly (a LATER prohibited
 * read is still observed); each call appends one fact and never edits the
 * report or its settlement.
 */
export function recordObservedAccess(
  ledger: LedgerApi,
  jobId: string,
  results: readonly ObservedToolResult[],
  source: 'session' | 'operator',
  /** The identity of the transcript the results were read from (session
   * scans, {@link blindSessionIdentity}): the same index in another session
   * is another read. Operator posts carry none. */
  session: string | null = null,
): BlindCoverage {
  const admitted = admittedOf(ledger, jobId);
  if (admitted === null || admitted.role !== 'blind' || admitted.rule === null) {
    throw new Error(`job "${jobId}" was not admitted as a blind review — no isolation rule to judge observed access against`);
  }
  const rule = ruleFromPayload(admitted.rule);
  const prohibited: readonly ProhibitedAccess[] = scanObservedAccess(results, rule);
  ledger.appendCustomEvent({
    kind: BLIND_ACCESS_EVENT,
    jobId,
    payload: { source, session, scanned: results.length, rule_sha256: rule.sha256, prohibited },
  });
  return blindCoverageOf(ledger, jobId);
}

/** Whether a job was admitted as a blind review (observation applies). */
export function isAdmittedBlind(ledger: LedgerApi, jobId: string): boolean {
  return admittedOf(ledger, jobId)?.role === 'blind';
}

/**
 * Record the observed tool access of a FINISHED blind reviewer session
 * against the rule the job was admitted under. This is the one seam shared by
 * the initial dispatch settle (issue #316) and the resume/re-brief settle
 * (issue #339): a prohibited read performed during a continuation therefore
 * invalidates coverage exactly like one at the first briefing. A non-blind
 * job is a no-op, and an unreadable session (`readResults` returns null)
 * records nothing rather than inventing a clean pass.
 *
 * A resumed session's jsonl is cumulative, so a settle scan re-reads results
 * an earlier scan already saw, and the same session can be observed MORE THAN
 * ONCE (a settle scan plus a chained or independent physical-completion
 * scan): scan scheduling is deliberately NOT exactly-once, so a late retry or
 * cancellation observation is never lost. Every scan appends its fact; the
 * derived verdict is idempotent, and `blindCoverageOf` counts DISTINCT reads
 * (session + tool-result index + classification + excerpt digest), so a
 * re-scan never inflates the informational `prohibitedAccess` count
 * (issue #355). The single owner of the scan/classification logic is this
 * helper.
 */
export function observeBlindSessionAccess(
  ledger: LedgerApi,
  jobId: string,
  sessionFile: string | null,
  readResults: (sessionFile: string | null) => readonly ObservedToolResult[] | null = readSessionToolResults,
): void {
  if (!isAdmittedBlind(ledger, jobId)) return;
  const results = readResults(sessionFile);
  if (results === null) return;
  recordObservedAccess(ledger, jobId, results, 'session', sessionFile === null ? null : scanSessionIdentity(sessionFile));
}

const MAX_SESSION_BYTES = 64 * 1024 * 1024;

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .join('');
}

/**
 * Tool results from a session jsonl: pi `toolResult` messages and
 * claude-code `tool_result` blocks. A torn tail line is skipped, a missing
 * file reads as nothing (the caller records no observation rather than
 * inventing a clean one).
 */
export function readSessionToolResults(sessionFile: string | null): readonly ObservedToolResult[] | null {
  if (sessionFile === null) return null;
  let raw: string;
  try {
    if (statSync(sessionFile).size > MAX_SESSION_BYTES) return null;
    raw = readFileSync(sessionFile, 'utf-8');
  } catch {
    return null;
  }
  const out: ObservedToolResult[] = [];
  let index = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const message = record['message'];
    if (record['type'] === 'message' && typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'toolResult') {
      const m = message as { content?: unknown; toolName?: unknown };
      out.push({ index, toolName: typeof m.toolName === 'string' ? m.toolName : null, text: blockText(m.content) });
    } else if (record['type'] === 'user' && typeof message === 'object' && message !== null) {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_result') {
            out.push({ index, toolName: null, text: blockText((block as { content?: unknown }).content) });
          }
        }
      }
    }
    index += 1;
  }
  return out;
}
