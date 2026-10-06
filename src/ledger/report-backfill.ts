import type { JobRecord, LedgerApi } from './api.js';
import { isReportDeliverable, REPORT_DELIVERABLES, type ReportDeliverable } from './obligations.js';

/**
 * Legacy report-job backfill (issue #220). Delivered, PR-less jobs whose
 * `deliverable` was never recorded are pre-E19 report lanes: the Silas
 * digest still chases them as missing PRs and nothing tracks the
 * commissioner's decision. The backfill is a THREE-way split — nothing
 * here guesses:
 *
 *  - `superseded` — the ledger PROVES the report's target is gone (the
 *    target PR merged, or a newer report covers the same target);
 *  - `obligation-opened` — the kind is inferable, so the row is stamped
 *    and the one `report:<jobId>` obligation opens for the owner's
 *    disposition;
 *  - `owner-list` — nothing is provable or inferable; the row is listed
 *    for the owner and re-listed on every run until they rule.
 *
 * `--dry-run` (the default) writes nothing. `--apply` is idempotent:
 * stamps land only on NULL columns, superseded rows leave the scan set
 * (status done), stamped rows leave it (deliverable set), and every
 * applied row records `report.backfilled`.
 */

/** What the backfill proposes for one legacy row. */
export type BackfillOutcome = 'superseded' | 'obligation-opened' | 'owner-list';

export interface BackfillProposal {
  readonly job: JobRecord;
  readonly outcome: BackfillOutcome;
  /** The inferred report kind, when the classifier found one. */
  readonly deliverable: ReportDeliverable | null;
  /** Why this outcome: the matched pattern, the merged target, or what is
   * missing. Always present — a stranger-readable row. */
  readonly reason: string;
  /** The target fields the ledger could infer (stamped on apply). */
  readonly targetRef: string | null;
  readonly targetSha: string | null;
}

export interface BackfillPlan {
  readonly proposals: readonly BackfillProposal[];
  readonly superseded: number;
  readonly obligationOpened: number;
  readonly ownerList: number;
}

export interface BackfillApplyReport extends Record<string, unknown> {
  readonly applied: number;
  readonly superseded: number;
  readonly obligationOpened: number;
  readonly skipped: number;
  readonly failed: number;
}

/** The job-id pattern classes, in priority order — the first match wins
 * (a `...-review-verification-gap-...` lane is a review lens, not a
 * verification run). Each entry maps to its report deliverable. */
const ID_PATTERNS: readonly { readonly pattern: RegExp; readonly deliverable: ReportDeliverable }[] = [
  { pattern: /(?:^|-)(review|perkins|lens|adversarial|blind|edge)(?:-|$)/i, deliverable: 'review' },
  { pattern: /(?:^|-)(verification|verify|artifact)(?:-|$)/i, deliverable: 'artifact' },
  { pattern: /(?:^|-)(investigat\w*)(?:-|$)/i, deliverable: 'investigation' },
  // `final-` is deliberately LAST: `...-final-adversarial-...` must hit its
  // lens class above; a bare `final-...` lane was the final review pass.
  { pattern: /(?:^|-)final(?:-|$)/i, deliverable: 'review' },
];

/** Briefing fallbacks, same priority discipline. */
const BRIEFING_PATTERNS: readonly { readonly pattern: RegExp; readonly deliverable: ReportDeliverable }[] = [
  { pattern: /\breview\b/i, deliverable: 'review' },
  { pattern: /\bverif/i, deliverable: 'artifact' },
  { pattern: /\binvestigat/i, deliverable: 'investigation' },
];

/** Classify one legacy job id (+ briefing fallback). Null = unclassified. */
export function classifyLegacyReportJob(id: string, briefing: string | null): { deliverable: ReportDeliverable; reason: string } | null {
  for (const { pattern, deliverable } of ID_PATTERNS) {
    const match = id.match(pattern);
    if (match !== null) {
      return { deliverable, reason: `job id matches /${String(pattern)}/ ("${match[1]}")` };
    }
  }
  if (briefing !== null) {
    for (const { pattern, deliverable } of BRIEFING_PATTERNS) {
      if (pattern.test(briefing)) {
        return { deliverable, reason: `briefing matches /${String(pattern)}/` };
      }
    }
  }
  return null;
}

/** The PR number a legacy job id carries (`...-pr144-...`), or null. */
export function legacyJobPrNumber(id: string): number | null {
  const match = id.match(/(?:^|-)pr(\d{1,9})(?:-|$)/i);
  return match === null ? null : Number(match[1]);
}

/** The PR number of a recorded PR url (`.../pull/144`), or null. */
export function prUrlNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d{1,9})(?:$|[/?#])/);
  return match === null ? null : Number(match[1]);
}

/** The repository name a PR url points at (`.../mssoka/gru-command/pull/1`
 * → `gru-command`), or null. Repository identity joins the PR number in
 * the sibling key: PR #31 in another repository must never supersede this
 * repo's report. */
export function prUrlRepo(url: string): string | null {
  const match = url.match(/\/([^/]+)\/pull\/\d{1,9}(?:$|[/?#])/);
  const repo = match?.[1];
  return repo === undefined ? null : repo.toLowerCase();
}

/** The keyset page size the planner reads legacy rows with — it pages
 * until exhausted, so an owner-list prefix of any size cannot hide older
 * classifiable rows from the dry run. */
const LEGACY_SCAN_PAGE = 1000;

/** One sibling-index key: repository + PR number. */
function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}##${number}`;
}

/** True when a job looks like a report lane: an explicit non-PR
 * deliverable, or a legacy id/briefing the classifier recognizes. Only
 * report-shaped siblings can supersede an older report — a later
 * implementation or administrative job sharing the PR is not a
 * re-review. */
function isReportShaped(job: JobRecord): boolean {
  if (job.deliverable !== null && job.deliverable !== 'pr') return true;
  if (job.deliverable !== null) return false;
  return classifyLegacyReportJob(job.id, job.briefing) !== null;
}

/**
 * Plan the backfill over the ledger's legacy scan set. Reads only — safe
 * on a live instance, safe to re-run. The legacy scan is fully paged:
 * every eligible row reaches the dry run.
 */
export function planLegacyReportBackfill(
  ledger: Pick<LedgerApi, 'listLegacyDeliveredJobs' | 'listJobs'>,
  opts: { pageSize?: number } = {},
): BackfillPlan {
  // repo+pr number → jobs carrying that PR, so merge/re-supersede evidence
  // is one map lookup per proposal. Both the job's own PR (`prUrl`) and a
  // report's reviewed target (`targetRef`) index: a newer REVIEW job
  // carries its target in targetRef, never as its own PR.
  const jobsByPr = new Map<string, JobRecord[]>();
  const index = (url: string | null, job: JobRecord): void => {
    if (url === null) return;
    const number = prUrlNumber(url);
    const repo = prUrlRepo(url);
    if (number === null || repo === null) return;
    const key = prKey(repo, number);
    const bucket = jobsByPr.get(key) ?? [];
    bucket.push(job);
    jobsByPr.set(key, bucket);
  };
  for (const job of ledger.listJobs()) index(job.prUrl, job);
  for (const job of ledger.listJobs()) index(job.targetRef, job);

  const legacy: JobRecord[] = [];
  const pageSize = opts.pageSize ?? LEGACY_SCAN_PAGE;
  let cursor: number | undefined;
  for (;;) {
    const page = ledger.listLegacyDeliveredJobs(pageSize, cursor === undefined ? {} : { cursor });
    legacy.push(...page);
    if (page.length < pageSize) break;
    const last = page[page.length - 1];
    const rowid = last === undefined ? null : legacyJobRowid(ledger, last.id);
    if (rowid === null) break;
    cursor = rowid;
  }

  const proposals: BackfillProposal[] = [];
  for (const job of legacy) {
    const classified = classifyLegacyReportJob(job.id, job.briefing);
    if (classified === null) {
      proposals.push({
        job,
        outcome: 'owner-list',
        deliverable: null,
        reason: 'no job-id or briefing pattern matched — the owner classifies this lane',
        targetRef: null,
        targetSha: null,
      });
      continue;
    }
    const prNumber = legacyJobPrNumber(job.id);
    const siblings =
      prNumber === null ? [] : (jobsByPr.get(prKey(job.repo, prNumber)) ?? []).filter((candidate) => candidate.id !== job.id);
    // Provable supersede (a): the target PR merged. The PR number comes
    // from the job id; the merge fact from the job that carried the PR in
    // the SAME repository.
    const merged = siblings.find((candidate) => candidate.status === 'merged');
    if (prNumber !== null && merged !== undefined) {
      proposals.push({
        job,
        outcome: 'superseded',
        deliverable: classified.deliverable,
        reason: `target PR #${prNumber} merged (job ${merged.id}) — the findings can no longer apply`,
        targetRef: merged.prUrl ?? null,
        targetSha: null,
      });
      continue;
    }
    // Provable supersede (b): a NEWER REPORT-SHAPED job already covers the
    // same repo+PR (later creation) — the older findings were superseded
    // by re-review. A later implementation lane is NOT evidence.
    const newer = siblings
      .filter((candidate) => candidate.createdAt > job.createdAt && isReportShaped(candidate))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (prNumber !== null && newer !== undefined) {
      proposals.push({
        job,
        outcome: 'superseded',
        deliverable: classified.deliverable,
        reason: `a newer report job for PR #${prNumber} exists (${newer.id}, created ${newer.createdAt}) — this report was superseded by re-review`,
        targetRef: newer.targetRef ?? newer.prUrl,
        targetSha: null,
      });
      continue;
    }
    proposals.push({
      job,
      outcome: 'obligation-opened',
      deliverable: classified.deliverable,
      reason: `${classified.reason} — deliverable stamped, the commissioner's disposition is now owed and tracked`,
      targetRef: null,
      targetSha: null,
    });
  }
  return {
    proposals,
    superseded: proposals.filter((proposal) => proposal.outcome === 'superseded').length,
    obligationOpened: proposals.filter((proposal) => proposal.outcome === 'obligation-opened').length,
    ownerList: proposals.filter((proposal) => proposal.outcome === 'owner-list').length,
  };
}

/** The planner only needs the rowid anchor for paging; the ledger exposes
 * it for obligations through `obligationRowid` and for jobs here. The
 * optional method keeps test doubles that pre-date the cursor contract
 * usable (a page shorter than the limit always terminates the scan). */
function legacyJobRowid(ledger: Pick<LedgerApi, 'listLegacyDeliveredJobs' | 'listJobs'> & { jobRowid?(id: string): number | null }, id: string): number | null {
  return ledger.jobRowid === undefined ? null : ledger.jobRowid(id);
}

/**
 * Apply one plan. Idempotent by construction: stamps land only on NULL
 * columns (`applyReportBackfill` guards each UPDATE), superseded rows
 * close to `done` (leaving the legacy scan), stamped rows leave it
 * (deliverable set), and `owner-list` proposals are never written. Every
 * applied row records `report.backfilled` with its proposed outcome.
 */
export function applyLegacyReportBackfill(
  ledger: Pick<LedgerApi, 'applyReportBackfill'>,
  plan: BackfillPlan,
): BackfillApplyReport {
  let superseded = 0;
  let obligationOpened = 0;
  let skipped = 0;
  let failed = 0;
  for (const proposal of plan.proposals) {
    if (proposal.outcome === 'owner-list' || proposal.deliverable === null || !isReportDeliverable(proposal.deliverable)) {
      skipped += 1;
      continue;
    }
    try {
      const result = ledger.applyReportBackfill({
        jobId: proposal.job.id,
        deliverable: proposal.deliverable,
        outcome: proposal.outcome,
        reason: proposal.reason,
        targetRef: proposal.targetRef,
        targetSha: proposal.targetSha,
      });
      if (!result.applied) {
        skipped += 1;
        continue;
      }
      if (proposal.outcome === 'superseded') superseded += 1;
      else obligationOpened += 1;
    } catch {
      // One row's failure never aborts the batch: the row re-proposes on
      // the next run (nothing was stamped) and the CLI reports the count.
      failed += 1;
    }
  }
  return {
    applied: superseded + obligationOpened,
    superseded,
    obligationOpened,
    skipped,
    failed,
  };
}

/** The deliverables the backfill can stamp — re-exported for the CLI's
 * usage text. */
export const BACKFILL_DELIVERABLES = REPORT_DELIVERABLES;
