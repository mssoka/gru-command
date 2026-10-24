import type { NotificationRecord } from '../ledger/api.js';
import { createHash } from 'node:crypto';
import { DECISION_SUBJECT_MAX_LENGTH, isDecisionSignal } from '../ledger/decision-memory.js';

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
 * Job-scoped kinds are the colon-scoped producers (`COLON_SCOPED_HEADS`:
 * `github.ci-failed:<job>:<sha>`, …) plus the one dot-scoped producer that
 * names its lane, `silas.rebrief-unreconciled.<job>` — a job hold must
 * defer that row, so it maps to the same job subject. A red default branch
 * is never job-scoped: it maps to
 * `incident:github.default-branch-ci-failed:<owner>/<repo>`. Every subject
 * fits the decision-subject bound (`fittedSubject`).
 */
export function incidentSubjectOf(row: IncidentRow): string {
  const defaultBranch = defaultBranchCiScope(row.kind);
  if (defaultBranch !== null) return fittedSubject(`incident:${DEFAULT_BRANCH_CI_FAILED_KIND}:${defaultBranch.repo}`);
  const rebrief = /^silas\.rebrief-unreconciled\.([^.]+)$/.exec(row.kind);
  if (rebrief !== null) return fittedSubject(`job:${rebrief[1] ?? ''}`);
  if (isColonScoped(row.kind)) {
    // First `:`-separated segment of the scope is the job id
    // (`github.ci-failed:<job>:<sha>`, `github.pr-conflict:<job>`).
    const jobId = row.kind.slice(row.kind.indexOf(':') + 1).split(':', 1)[0] ?? '';
    if (jobId !== '') return fittedSubject(`job:${jobId}`);
  }
  return fittedSubject(`incident:${row.kind}:${normalizeIncidentTitle(row.title)}`);
}

/** The producer kinds scoped by `:` to a job, `<head>:<job>[:<instance>]`
 * (#503). A `:` anywhere else — inside a caller-chosen request id in
 * `silas.directive-unreconciled.<id>`, say — is part of a dot-scoped
 * instance: it never re-scopes the row to a job or splits its basis. */
const COLON_SCOPED_HEADS: readonly string[] = [
  'github.ci-failed', 'github.pr-conflict', 'silas.phase-handback.phase-handoff', 'silas.escalated', 'job-stop-unproven',
];

function isColonScoped(kind: string): boolean {
  const colon = kind.indexOf(':');
  return colon > 0 && colon < kind.length - 1 && COLON_SCOPED_HEADS.includes(kind.slice(0, colon));
}

/** #503: a subject always fits the decision-subject bound. One over it
 * keeps a readable prefix and ends `~<sha256 of the whole subject>`, so the
 * card's mailbox item, the coverage query and a decision recorded on the
 * item all derive the same exact subject. */
function fittedSubject(subject: string): string {
  if (subject.length <= DECISION_SUBJECT_MAX_LENGTH) return subject;
  const digest = createHash('sha256').update(subject, 'utf8').digest('hex');
  // Never end the prefix inside a surrogate pair.
  const prefix = subject.slice(0, DECISION_SUBJECT_MAX_LENGTH - digest.length - 1).replace(/[\uD800-\uDBFF]$/u, '');
  return `${prefix}~${digest}`;
}

/** Producer namespaces the signal vocabulary drops (`github.ci-failed` →
 * `ci-failed`, `silas.directive-unreconciled` → `directive-unreconciled`). */
const SIGNAL_NAMESPACE = /^(github|silas)\./;

/** The report producer (#314): its signal is the exact, case-preserved job
 * identity, never a family. */
const REPORT_HANDBACK_KIND_PREFIX = 'silas.report-handback.';

/** Namespace stripped and `:` scope dropped, every `.` segment kept —
 * instance ids included. */
function exactSignalOf(kind: string): string {
  const withoutNamespace = kind.replace(SIGNAL_NAMESPACE, '');
  const colon = withoutNamespace.indexOf(':');
  const signal = colon > 0 ? withoutNamespace.slice(0, colon) : withoutNamespace;
  return signal === '' ? kind : signal;
}

/**
 * The signal family the row raises — the token a decision's `covers` list
 * names (`pr-conflict`, `ci-failed`, `directive-unreconciled`, …). Producer
 * kinds are `<namespace>.<family>`, scoped to an instance by `:`
 * (`github.ci-failed:<job>:<sha>`) or by further `.` segments
 * (`silas.directive-unreconciled.<request>`,
 * `supervision.provider-wall.<agent>.<class>`). The family is the first two
 * dot segments of the unscoped head with the `github.`/`silas.` namespace
 * dropped, so no instance id enters the signal (issue #503: a caller-chosen
 * id overran the decision write boundary and made the exact disposition
 * unrecordable). Exactness comes from the subject and the basis, which keep
 * the whole kind. Two rulings stand apart: a red default branch is the
 * `ci-failed` family (#446), and a report handback keeps its exact job
 * identity (#314).
 */
export function incidentSignalOf(row: IncidentRow): string {
  if (defaultBranchCiScope(row.kind) !== null) return 'ci-failed';
  if (row.kind.startsWith(REPORT_HANDBACK_KIND_PREFIX)) return exactSignalOf(row.kind);
  const head = row.kind.split(':', 1)[0] ?? '';
  const family = head.split('.').slice(0, 2).join('.').replace(SIGNAL_NAMESPACE, '');
  return family === '' ? row.kind : family;
}

/** The `silas.`/`github.` families whose kinds name an instance after the
 * family (`silas.directive-unreconciled.<request>`): their pre-#503 signals
 * were `<family>.<instance>`. */
const NAMESPACED_INSTANCE_FAMILIES: readonly string[] = ['directive-unreconciled', 'phase-handback', 'rebrief-unreconciled', 'recovery-owner-transfer'];

/**
 * #503: the family to name instead, when `token` is a signal the current
 * derivation can no longer produce — a namespaced spelling
 * (`silas.directive-unreconciled.<request>`), an instance of a namespaced
 * family (`directive-unreconciled.<request>`), or any token of three or
 * more dot segments (`supervision.turn-orphaned.<agent>`), which no family
 * has. Null for every token a row can raise today; the
 * report handback's exact job identity (#314) stays. A decision naming a
 * retired token would be stored and never match: the write boundary
 * refuses it instead.
 */
export function retiredSignalFamily(token: string): string | null {
  // A namespaced spelling is never raised (the namespace is dropped): name
  // the token the derivation gives it, e.g. the bare `directive-unreconciled`.
  if (SIGNAL_NAMESPACE.test(token)) return incidentSignalOf({ kind: token, title: '', routing: 'fyi' });
  if (token.startsWith(REPORT_HANDBACK_KIND_PREFIX.slice('silas.'.length))) return null;
  const segments = token.split('.');
  if (segments.length >= 2 && NAMESPACED_INSTANCE_FAMILIES.includes(segments[0]!)) return segments[0]!;
  return segments.length >= 3 ? segments.slice(0, 2).join('.') : null;
}

/** The pre-#503 derivation, verbatim: the default branch and the re-brief
 * producer were families already; every other kind kept its instance. */
function preFamilySignalOf(kind: string): string {
  if (defaultBranchCiScope(kind) !== null) return 'ci-failed';
  if (kind.startsWith('silas.rebrief-unreconciled.')) return 'rebrief-unreconciled';
  return exactSignalOf(kind);
}

/**
 * Compatibility (#503): the signal the pre-family derivation gave this row —
 * what a decision recorded before migration 32 meant when it named one, and
 * the only token such a decision matches (`coveringDecision`). Null when that
 * token was no decision signal (over 64 characters, mixed case, `@`): the
 * write boundary never accepted one and every read re-validates stored
 * `covers`, so no old decision can match the row. For a kind whose signal did
 * not change it is the family itself.
 */
export function preFamilyIncidentSignalOf(row: IncidentRow): string | null {
  const legacy = preFamilySignalOf(row.kind);
  return isDecisionSignal(legacy) ? legacy : null;
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
  if (isColonScoped(row.kind) && parts.length >= 3 && parts[2] !== '') return parts.slice(2).join(':');
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
