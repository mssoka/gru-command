import type { NotificationRecord } from '../ledger/api.js';

/**
 * Incident identity for the wake policy (issue #219): one wake per
 * INCIDENT — (alert kind, subject, head SHA where applicable) — never one
 * per notification ID. A re-detected incident arriving under a new row ID
 * (producer dedupe reuses a row only while it is unacked; after a
 * disposition the next poll mints a fresh ID for the SAME failing state)
 * used to burn a second full model turn to re-derive a conclusion the
 * chief already reached. The incident key is the dedupe memory that stops
 * that, and the subject/signal/basis triple is what the hold-coverage
 * query (issue #218 `coveringDecision`) is asked with.
 *
 * Everything here is derived from the durable notification ROW alone —
 * no event scans — so the wake path stays cheap and deterministic:
 *
 * - Scoped producer kinds embed their subject in the kind itself
 *   (`github.ci-failed:<job>:<sha>` carries the head SHA; `github.pr-conflict:<job>`
 *   carries the lane). For those, the kind IS the incident key: the same
 *   failing head re-detected under a new row ID collapses onto the key
 *   the first wake already claimed, and a NEW head is a NEW incident by
 *   construction (the SHA is part of the kind).
 * - Every other kind is scoped by its normalized title, which is where
 *   the dot-scoped producers (`supervision.provider-wall.<agent>.<class>`,
 *   `supervision.turn-orphaned.<lane>`) carry their subject.
 * - A red default branch (#446,
 *   `github.default-branch-ci-failed:<owner>/<repo>:<workflow id>:<sha>`)
 *   has no lane: its subject is the repository, so one hold applies to
 *   every workflow of it, and its basis is the head SHA alone.
 */

/** The minimal row shape the wake path consumes. */
export type IncidentRow = Pick<NotificationRecord, 'kind' | 'title' | 'routing'>;

/** The red default-branch alert kind prefix (#446), shared with its producer. */
export const DEFAULT_BRANCH_CI_FAILED_KIND = 'github.default-branch-ci-failed';

/** The repository and head SHA of a default-branch CI row (#446); null
 * for every other kind. */
function defaultBranchCiScope(kind: string): { readonly repo: string; readonly sha: string } | null {
  if (!kind.startsWith(`${DEFAULT_BRANCH_CI_FAILED_KIND}:`)) return null;
  const parts = kind.slice(DEFAULT_BRANCH_CI_FAILED_KIND.length + 1).split(':');
  if (parts.length !== 3 || parts.some((part) => part === '')) return null;
  return { repo: parts[0] as string, sha: parts[2] as string };
}

/** Title normalizer for unscoped kinds: case- and whitespace-insensitive,
 * bounded, so a producer's stable title template yields a stable key. */
export function normalizeIncidentTitle(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized === '' ? 'untitled' : normalized.slice(0, 80);
}

/**
 * The incident key: scoped kinds (containing `:`, by producer convention)
 * key on the kind itself — the head SHA is part of the key exactly when
 * the producer embeds it; every other kind keys on `kind + ':' +
 * normalized(title)`.
 */
export function incidentKeyOf(row: IncidentRow): string {
  if (row.kind.includes(':')) return row.kind;
  return `${row.kind}:${normalizeIncidentTitle(row.title)}`;
}

/**
 * The subject a hold/disposition must be recorded under for this row's
 * coverage to be found (issue #218 subject vocabulary): job-scoped kinds
 * map to `job:<jobId>`; every other row maps to
 * `incident:<kind>:<normalized title>`. Decision writers recording a hold
 * against a machine alert must use the SAME derivation — the awareness
 * layer consults exactly this subject.
 *
 * Job-scoped kinds are colon-scoped (`github.ci-failed:<job>:<sha>`)
 * plus the one dot-scoped producer that names its lane,
 * `silas.rebrief-unreconciled.<job>` — a job hold must defer that row,
 * so it maps to the same job subject. A red default branch is never
 * job-scoped: it maps to
 * `incident:github.default-branch-ci-failed:<owner>/<repo>`.
 */
export function incidentSubjectOf(row: IncidentRow): string {
  const defaultBranch = defaultBranchCiScope(row.kind);
  if (defaultBranch !== null) return `incident:${DEFAULT_BRANCH_CI_FAILED_KIND}:${defaultBranch.repo}`;
  const rebrief = /^silas\.rebrief-unreconciled\.([^.]+)$/.exec(row.kind);
  if (rebrief !== null) return `job:${rebrief[1] ?? ''}`;
  const colon = row.kind.indexOf(':');
  if (colon > 0 && colon < row.kind.length - 1) {
    const scope = row.kind.slice(colon + 1);
    // First `:`-separated segment of the scope is the lane/job id
    // (`github.ci-failed:<job>:<sha>`, `github.pr-conflict:<job>`).
    const jobId = scope.split(':', 1)[0] ?? '';
    if (jobId !== '') return `job:${jobId}`;
  }
  return `incident:${row.kind}:${normalizeIncidentTitle(row.title)}`;
}

/**
 * The signal family the row raises — the token a decision's `covers` list
 * names (`pr-conflict`, `ci-failed`, …). Producer namespacing
 * (`github.`, `silas.`) is stripped and the scope suffix dropped;
 * unscoped kinds are their own signal. The dot-scoped rebrief and
 * directive recovery producers map to their family tokens like the
 * colon-scoped ones (a request id would otherwise run the directive token
 * past the decision signal bound); a red default branch is the
 * `ci-failed` family.
 */
export function incidentSignalOf(row: IncidentRow): string {
  if (defaultBranchCiScope(row.kind) !== null) return 'ci-failed';
  const rebrief = /^silas\.rebrief-unreconciled\./.exec(row.kind);
  if (rebrief !== null) return 'rebrief-unreconciled';
  // The request id would run the token past the decision signal bound.
  if (row.kind.startsWith('silas.directive-unreconciled.')) return 'directive-unreconciled';
  const withoutNamespace = row.kind.replace(/^(github|silas)\./, '');
  const colon = withoutNamespace.indexOf(':');
  const family = colon > 0 ? withoutNamespace.slice(0, colon) : withoutNamespace;
  return family === '' ? row.kind : family;
}

/**
 * The basis fingerprint the coverage query compares against the
 * decision's recorded basis: the head SHA when the kind embeds one
 * (`github.ci-failed:<job>:<sha>`), else the incident key itself — a
 * stable stand-in meaning "this exact incident, unchanged". A decision
 * recorded with a null basis covers any basis; a decision recorded with a
 * different basis (a NEW sha under the same lane) does not cover this row,
 * which is exactly how a basis change re-opens a held subject. A red
 * default branch's basis is its head SHA, never the workflow id before it.
 */
export function incidentBasisOf(row: IncidentRow): string {
  const defaultBranch = defaultBranchCiScope(row.kind);
  if (defaultBranch !== null) return defaultBranch.sha;
  const parts = row.kind.split(':');
  if (parts.length >= 3 && parts[0] !== '' && parts[2] !== '') return parts.slice(2).join(':');
  return incidentKeyOf(row);
}

/**
 * Hard floors (issue #219): rows that are NEVER hold-covered-deferred —
 * a wake must open for them even when a decision claims the subject.
 * Owner stops (`needs-owner`) are the human's business and never defer;
 * breakers and provider walls (including the false-recovery escalation,
 * the same family) name conditions a hold must not silence.
 */
export function isHardFloorRow(row: IncidentRow): boolean {
  if (row.routing === 'needs-owner') return true;
  return (
    row.kind.startsWith('silas.directive-unreconciled.') ||
    row.kind.startsWith('silas.rebrief-unreconciled.') ||
    row.kind.startsWith('supervision.breaker') ||
    row.kind.startsWith('supervision.rearm-fenced') ||
    row.kind.startsWith('supervision.provider-wall.') ||
    row.kind.startsWith('provider.false-recovery.')
  );
}
