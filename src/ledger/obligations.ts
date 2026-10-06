/**
 * Durable follow-through obligations — typed domain (phase 2 foundation).
 *
 * A blocked lane is not a dead end; it is work someone owes a next action
 * on. This module is the pure vocabulary that makes that debt durable and
 * NON-EXECUTABLE: types, validation, the firing-rule registry that maps a
 * typed blocker context to a default next action, and pure
 * due-selection/projection helpers. Persistence lives in
 * `src/ledger/api.ts` (the central transactional boundary); execution,
 * scheduling, wakes and notification wiring are deliberately NOT here.
 *
 * Binding corrections honored (chief ruling 2026-09-28):
 * - Identity is job + logical step + incident key (+ generation for
 *   staleness), never one-row-per-job or newest-blocker-wins. Duplicate
 *   observations of the SAME incident coalesce without advancing
 *   generation; distinct simultaneous blockers coexist.
 * - nextAction / wakeCondition / settlement / authority are discriminated,
 *   validated unions. Free text, a file path, a note or a caller-supplied
 *   `by` field is NEVER execution authority. Missing/ambiguous authority
 *   means ATTENTION ONLY. The shared bearer token means attribution is a
 *   claim, not identity proof (documented limitation, unchanged).
 * - A generic receipt (e.g. job.delivered) may re-open a decision; it
 *   never establishes an accepted product gate or heist completion.
 */

// ------------------------------------------------------------------
// Identity vocabulary
// ------------------------------------------------------------------

export const OBLIGATION_LOGICAL_STEPS = [
  'implementation',
  'review',
  'verification',
  'audit',
  'operation',
] as const;
export type ObligationLogicalStep = (typeof OBLIGATION_LOGICAL_STEPS)[number];

export function isObligationLogicalStep(value: string): value is ObligationLogicalStep {
  return (OBLIGATION_LOGICAL_STEPS as readonly string[]).includes(value);
}

/** Closed category set. Anything outside it is `unknown` — recorded as
 * triage owed to Gru, never guessed into execution authority. */
export const KNOWN_BLOCKER_CATEGORIES = [
  'owner-hold',
  'provider-wait',
  'quality-gate',
  'verification-failure',
  'review-verdict',
  'lane-unavailable',
  'phase-completion',
] as const;
export type KnownBlockerCategory = (typeof KNOWN_BLOCKER_CATEGORIES)[number];

export type ObligationCategory =
  | { readonly kind: 'known'; readonly category: KnownBlockerCategory }
  | { readonly kind: 'unknown' };

export function categoryKey(category: ObligationCategory): string {
  return category.kind === 'known' ? `known:${category.category}` : 'unknown';
}

/** Mechanical actions Silas may eventually be granted for an obligation —
 * a CLOSED list. No firing rule grants one without explicit typed
 * authority; phase 2 grants none at all (registry entries below route to
 * attention owners only). */
export const SILAS_MECHANICAL_ACTIONS = [
  'register-pr',
  'request-review',
  'hand-back-ruling',
] as const;
export type SilasMechanicalAction = (typeof SILAS_MECHANICAL_ACTIONS)[number];

// ------------------------------------------------------------------
// Discriminated, validated unions
// ------------------------------------------------------------------

/** What the obligation's owner must do next. `silas-mechanical` requires
 * typed authority AND a registered action id; otherwise validation throws
 * (fail loud — a silent downgrade to attention would hide a caller bug,
 * and a silent upgrade would mint authority). */
export type ObligationNextAction =
  | { readonly kind: 'silas-mechanical'; readonly action: SilasMechanicalAction }
  | { readonly kind: 'gru-decision'; readonly decision: string }
  | { readonly kind: 'owner-decision'; readonly decision: string }
  | { readonly kind: 'external-wait'; readonly condition: string };

export type ObligationWakeCondition =
  | { readonly kind: 'event'; readonly eventKind: string }
  | { readonly kind: 'receipt'; readonly receiptKind: string }
  | { readonly kind: 'sweep' };

/** Validate/canonicalize an ISO timestamp at the write/read boundary
 * (ruling D): elapsed-time reasoning never trusts lexicographic strings
 * that were never checked to parse. Returns the canonical form. */
export function canonicalIsoTimestamp(value: string, what: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${what} must be a parseable ISO timestamp, got "${value}"`);
  return new Date(parsed).toISOString();
}

/** Typed authority binding an obligation's continuation to a concrete
 * accepted operation or ruling VERSION. `rulingRef` is a stable ruling
 * identifier (e.g. a ledger-anchored ruling id), never a filesystem path
 * and never prose. Absent authority = attention only, always. Current
 * validity is a LEDGER question, not a string question: the api's
 * `verifyObligationAuthority` checks the referenced fact durably exists
 * and applies to this obligation (ruling E) — an unverifiable reference
 * is a visible NON-EXECUTABLE decision, never a grant. */
export type ObligationAuthority =
  | { readonly source: 'accepted-operation'; readonly operationId: string; readonly version: string }
  | { readonly source: 'chief-ruling'; readonly rulingRef: string; readonly version: string }
  | { readonly source: 'owner-ruling'; readonly rulingRef: string; readonly version: string };

/** How an obligation ends. Receipts NEVER settle; only an explicit,
 * validated settlement call does. Evidence kinds name the exact ledger
 * event kind they cite — the api validates the event EXISTS, belongs to
 * the obligation's job, and carries that kind, so no fabricated sequence
 * or wrong-job/gate event can settle debt (ruling A).
 * `job-terminal`/`superseded`/`cancelled` close (history preserved); the
 * evidence kinds settle. */
export type ObligationSettlement =
  | {
      readonly kind: 'executed-action'
      readonly action: string
      readonly evidenceEventSeq: number
      readonly evidenceEventKind: string
    }
  | {
      readonly kind: 'accepted-evidence'
      readonly gate: string
      readonly evidenceEventSeq: number
      readonly evidenceEventKind: string
    }
  | { readonly kind: 'superseded'; readonly byObligationId: string | null; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly reason: string }
  | { readonly kind: 'job-terminal'; readonly jobStatus: 'done' | 'merged' };

/** The delegated phase's identity an armed receipt expectation may pin
 * itself to. Present ⇒ a receipt event whose payload lacks the matching
 * correlation is recorded as evidence but NEVER satisfies the
 * expectation — a later unrelated event of the same kind cannot answer
 * an older phase's debt (ruling A). */
export interface ReceiptCorrelation {
  readonly requestId?: string;
  readonly minionId?: string;
}

// ------------------------------------------------------------------
// Firing rules (closed registry — issue #117 provenance)
// ------------------------------------------------------------------

export const FIRING_RULE_IDS = [
  'owner-hold-needs-owner',
  'provider-wait-external',
  'quality-gate-gru-decision',
  'verification-failure-gru-decision',
  'review-verdict-gru-decision',
  'lane-unavailable-gru-decision',
  'phase-completion-gru-decision',
  'unknown-triage-gru',
] as const;
export type FiringRuleId = (typeof FIRING_RULE_IDS)[number];

export interface FiringRule {
  readonly id: FiringRuleId;
  readonly category: ObligationCategory;
  readonly nextAction: ObligationNextAction;
  readonly wakeCondition: ObligationWakeCondition;
}

export const FIRING_RULES: readonly FiringRule[] = [
  {
    id: 'owner-hold-needs-owner',
    category: { kind: 'known', category: 'owner-hold' },
    nextAction: { kind: 'owner-decision', decision: 'owner hold: resolve or release the hold' },
    wakeCondition: { kind: 'sweep' },
  },
  {
    id: 'provider-wait-external',
    category: { kind: 'known', category: 'provider-wait' },
    nextAction: { kind: 'external-wait', condition: 'external provider dependency recovers (PR132 owns the wait)' },
    wakeCondition: { kind: 'sweep' },
  },
  {
    id: 'quality-gate-gru-decision',
    category: { kind: 'known', category: 'quality-gate' },
    nextAction: { kind: 'gru-decision', decision: 'quality gate outcome requires a ruling' },
    wakeCondition: { kind: 'sweep' },
  },
  {
    id: 'verification-failure-gru-decision',
    category: { kind: 'known', category: 'verification-failure' },
    nextAction: { kind: 'gru-decision', decision: 'failed verification requires a recovery ruling' },
    wakeCondition: { kind: 'sweep' },
  },
  {
    id: 'review-verdict-gru-decision',
    category: { kind: 'known', category: 'review-verdict' },
    nextAction: { kind: 'gru-decision', decision: 'review verdict follow-through requires a ruling' },
    wakeCondition: { kind: 'sweep' },
  },
  {
    id: 'lane-unavailable-gru-decision',
    category: { kind: 'known', category: 'lane-unavailable' },
    nextAction: { kind: 'gru-decision', decision: 'lane unavailability requires a recovery ruling' },
    wakeCondition: { kind: 'sweep' },
  },
  {
    // Same-head/terminal hand-back (incident 131/132/133): a bounded
    // silas-directive/rebrief phase settled while the lane stayed blocked
    // — the next Gru ruling is owed durably, no owner prompting needed.
    id: 'phase-completion-gru-decision',
    category: { kind: 'known', category: 'phase-completion' },
    nextAction: { kind: 'gru-decision', decision: 'bounded phase completed on a still-blocked lane — rule on the follow-through' },
    wakeCondition: { kind: 'sweep' },
  },
  {
    id: 'unknown-triage-gru',
    category: { kind: 'unknown' },
    nextAction: { kind: 'gru-decision', decision: 'triage: blocker category unclassified' },
    wakeCondition: { kind: 'sweep' },
  },
];

/** The default rule for a typed category (unknown included). Fail loud on
 * an unmapped category — the registry is closed and must stay complete. */
export function defaultFiringRule(category: ObligationCategory): FiringRule {
  const key = categoryKey(category);
  const rule = FIRING_RULES.find((candidate) => categoryKey(candidate.category) === key);
  if (rule === undefined) {
    throw new Error(`no firing rule registered for blocker category "${key}" — extend the closed registry first`);
  }
  return rule;
}

export function isFiringRuleId(value: string): value is FiringRuleId {
  return (FIRING_RULE_IDS as readonly string[]).includes(value);
}

// ------------------------------------------------------------------
// Blocker context (the typed optional input at the status boundary)
// ------------------------------------------------------------------

/** What a blocked-transition writer supplies. `description` is optional
 * human context and carries NO authority. `observedAtSeq` is the ledger
 * event watermark of the observation (required: staleness and duplicate
 * detection are seq-based, never wall-clock-only). */
export interface BlockerContext {
  readonly logicalStep: ObligationLogicalStep;
  readonly category: ObligationCategory;
  /** Stable incident discriminator (e.g. a gate name, provider id,
   * ruling id). Defaults to the category key. NEVER the origin seq — a
   * changing key would break duplicate coalescing. */
  readonly incidentKey?: string;
  readonly description?: string;
  readonly observedAtSeq: number;
  /** Explicit validated override; without typed authority a mechanical
   * override is rejected (attention-only default). */
  readonly nextAction?: ObligationNextAction;
  readonly authority?: ObligationAuthority;
  readonly wakeCondition?: ObligationWakeCondition;
  readonly dueAt?: string | null;
  readonly receiptKind?: string | null;
  readonly deadlineAt?: string | null;
  /** Pin a receipt expectation to the delegated phase's actual identity
   * (request/minion) — without the match, a same-kind event is evidence
   * but never satisfaction (ruling A). */
  readonly receiptCorrelation?: ReceiptCorrelation;
  readonly firingRule?: FiringRuleId;
}

/** A context with the derived defaults resolved (what actually persists). */
export interface ResolvedObligation {
  readonly id: string;
  readonly jobId: string;
  readonly logicalStep: ObligationLogicalStep;
  readonly incidentKey: string;
  readonly category: ObligationCategory;
  readonly nextAction: ObligationNextAction;
  readonly wakeCondition: ObligationWakeCondition;
  readonly authority: ObligationAuthority | null;
  readonly firingRule: FiringRuleId;
  /** Optional human context as supplied (persisted verbatim, never
   * parsed for authority or used in plan identity). */
  readonly description: string | null;
  readonly dueAt: string | null;
  readonly receiptKind: string | null;
  readonly deadlineAt: string | null;
  readonly receiptCorrelation: ReceiptCorrelation | null;
}

/** Validate + resolve a blocker context against the registry. Throws
 * named, actionable errors on invalid shapes; synthesizes a NON-EXECUTABLE
 * Gru-triage obligation for the unknown category (never a rejection). */
export function resolveObligation(context: BlockerContext, jobId: string): ResolvedObligation {
  if (context.observedAtSeq < 0 || !Number.isSafeInteger(context.observedAtSeq)) {
    throw new Error('blocker context requires a safe non-negative observedAtSeq watermark');
  }
  const rule =
    context.firingRule !== undefined
      ? (FIRING_RULES.find((candidate) => candidate.id === context.firingRule) ??
        (() => {
          throw new Error(`unknown firing rule "${context.firingRule}" — the registry is closed`);
        })())
      : defaultFiringRule(context.category);
  // Rule/category compatibility (ruling E): a caller may pick a rule by
  // id for provenance, never mislabel the category it fired on.
  if (categoryKey(rule.category) !== categoryKey(context.category)) {
    throw new Error(
      `firing rule "${rule.id}" is registered for category "${categoryKey(rule.category)}", ` +
        `not the observed "${categoryKey(context.category)}" — fix the category or drop the explicit rule`,
    );
  }
  const nextAction = context.nextAction ?? rule.nextAction;
  if (nextAction.kind === 'silas-mechanical') {
    if (!(SILAS_MECHANICAL_ACTIONS as readonly string[]).includes(nextAction.action)) {
      throw new Error(`silas-mechanical action "${nextAction.action}" is not in the closed action list`);
    }
    if (context.authority === undefined) {
      throw new Error(
        `silas-mechanical next action "${nextAction.action}" requires typed authority — without it the obligation is attention-only`,
      );
    }
  }
  const incidentKey = context.incidentKey ?? categoryKey(context.category);
  if (incidentKey.trim() === '') throw new Error('incident key must be non-empty');
  return {
    id: obligationId(jobId, context.logicalStep, incidentKey),
    jobId,
    logicalStep: context.logicalStep,
    incidentKey,
    category: context.category,
    nextAction,
    wakeCondition: context.wakeCondition ?? rule.wakeCondition,
    authority: context.authority ?? null,
    firingRule: rule.id,
    description: context.description === undefined || context.description.trim() === '' ? null : context.description,
    // Bounds are compared lexicographically by the due selectors: a
    // date-only or offset input must be canonicalized at the write
    // boundary or it silently mis-schedules (same rule as claim expiry).
    dueAt:
      context.dueAt === undefined || context.dueAt === null
        ? null
        : canonicalIsoTimestamp(context.dueAt, 'blocker context dueAt'),
    receiptKind: context.receiptKind ?? null,
    deadlineAt:
      context.deadlineAt === undefined || context.deadlineAt === null
        ? null
        : canonicalIsoTimestamp(context.deadlineAt, 'blocker context deadlineAt'),
    receiptCorrelation: context.receiptCorrelation ?? null,
  };
}

/** Stable obligation identity: job + logical step + incident key. Stable
 * across duplicate observations (refreshes keep the same row); distinct
 * incidents (and distinct steps) are distinct obligations that coexist. */
export function obligationId(jobId: string, logicalStep: ObligationLogicalStep, incidentKey: string): string {
  return `${jobId}:${logicalStep}:${incidentKey}`;
}

// ------------------------------------------------------------------
// Receipts (evidence, never authority)
// ------------------------------------------------------------------

export interface RecordedReceipt {
  readonly kind: string;
  readonly eventSeq: number;
  readonly at: string;
  /** true when the receipt postdated the obligation's watermark and was
   * allowed to change state; false when recorded as stale evidence only. */
  readonly applied: boolean;
}

// ------------------------------------------------------------------
// Pure due-selection / projection contract
// ------------------------------------------------------------------

/** Owner obligations project to the existing needs-owner surface (FOR
 * YOU); Gru machine decisions to action-required; authorized mechanical
 * work to the Silas machine lane; external waits stay passive (no bell).
 * Normal machine follow-through never rings the owner. */
export type ObligationAttentionRouting = 'needs-owner' | 'action-required' | 'machine-silas' | 'external-passive';

export function obligationRouting(nextAction: ObligationNextAction): ObligationAttentionRouting {
  switch (nextAction.kind) {
    case 'owner-decision':
      return 'needs-owner';
    case 'gru-decision':
      return 'action-required';
    case 'silas-mechanical':
      return 'machine-silas';
    case 'external-wait':
      return 'external-passive';
  }
}

/** The minimal view of an obligation row the pure selectors need (the
 * persisted record satisfies it; tests can construct it directly). */
export interface ObligationDueView {
  readonly id: string;
  readonly state: 'open' | 'waiting' | 'settled' | 'suspended' | 'closed';
  readonly nextAction: ObligationNextAction;
  readonly dueAt: string | null;
  readonly deadlineAt: string | null;
}

export interface DueSelection {
  /** Open obligations whose due boundary has arrived (or never had one):
   * the attention/machine candidates. */
  readonly due: readonly ObligationDueView[];
  /** Waiting obligations whose receipt deadline passed WITHOUT evidence:
   * escalate the missed boundary — do NOT duplicate or kill a legitimately
   * live phase (the boundary is a signal, never a writer license). */
  readonly missedDeadlines: readonly ObligationDueView[];
}

export function selectDueObligations(
  obligations: readonly ObligationDueView[],
  nowIsoTimestamp: string,
): DueSelection {
  const due = obligations.filter(
    (row) => row.state === 'open' && (row.dueAt === null || row.dueAt <= nowIsoTimestamp),
  );
  const missedDeadlines = obligations.filter(
    (row) => row.state === 'waiting' && row.deadlineAt !== null && row.deadlineAt <= nowIsoTimestamp,
  );
  return { due, missedDeadlines };
}

// ------------------------------------------------------------------
// Claims (request/generation-fenced; NEVER a writer license)
// ------------------------------------------------------------------

/** A durable hold on an obligation's next action. Lease expiry alone
 * NEVER permits a replacement writer — the reconciliation path must
 * record a positive disposition of the old claim (with proof) before a
 * new holder may take over (ruling D). An attention-only lease
 * coordinates WHO is minding the decision; it never grants execution —
 * only typed authority on the obligation itself can do that. */
export interface ObligationClaim {
  readonly requestId: string;
  readonly holder: string;
  readonly generation: number;
  readonly expiresAt: string | null;
}

/** The full identity of a prior claim and how it left: persisted per
 * replacement/release — never reduced to an integer counter. `proof` is
 * the reconciliation evidence that justified the handover;
 * `supersededByRequest` names the taker. */
export interface ClaimLogEntry {
  readonly requestId: string;
  readonly holder: string;
  readonly generation: number;
  readonly expiresAt: string | null;
  readonly disposition: 'released' | 'superseded-expired-reconciled' | 'plan-revision' | 'terminal-close';
  readonly at: string;
  readonly proof: string | null;
  readonly supersededByRequest: string | null;
}

// ------------------------------------------------------------------
// Typed JSON codecs (rows carry discriminated unions as JSON)
// ------------------------------------------------------------------

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function reqStr(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what}.${key} must be a non-empty string`);
  }
  return value;
}

function optStr(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function reqSeq(source: Record<string, unknown>, key: string, what: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what}.${key} must be a safe non-negative event seq`);
  }
  return value;
}

export function parseCategory(raw: string): ObligationCategory {
  const record = asRecord(JSON.parse(raw), 'obligation category');
  if (record['kind'] === 'unknown') return { kind: 'unknown' };
  if (record['kind'] !== 'known') throw new Error('obligation category kind must be "known" or "unknown"');
  const category = reqStr(record, 'category', 'obligation category');
  if (!(KNOWN_BLOCKER_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`obligation category "${category}" is not in the closed category list`);
  }
  return { kind: 'known', category: category as KnownBlockerCategory };
}

export function parseNextAction(raw: string): ObligationNextAction {
  const record = asRecord(JSON.parse(raw), 'obligation next action');
  const kind = reqStr(record, 'kind', 'obligation next action');
  switch (kind) {
    case 'silas-mechanical': {
      const action = reqStr(record, 'action', 'silas-mechanical next action');
      if (!(SILAS_MECHANICAL_ACTIONS as readonly string[]).includes(action)) {
        throw new Error(`silas-mechanical action "${action}" is not in the closed action list`);
      }
      return { kind: 'silas-mechanical', action: action as SilasMechanicalAction };
    }
    case 'gru-decision':
      return { kind: 'gru-decision', decision: reqStr(record, 'decision', 'gru-decision next action') };
    case 'owner-decision':
      return { kind: 'owner-decision', decision: reqStr(record, 'decision', 'owner-decision next action') };
    case 'external-wait':
      return { kind: 'external-wait', condition: reqStr(record, 'condition', 'external-wait next action') };
    default:
      throw new Error(`obligation next action kind "${kind}" is unknown`);
  }
}

export function parseWakeCondition(raw: string): ObligationWakeCondition {
  const record = asRecord(JSON.parse(raw), 'obligation wake condition');
  const kind = reqStr(record, 'kind', 'obligation wake condition');
  if (kind === 'event') return { kind: 'event', eventKind: reqStr(record, 'eventKind', 'event wake condition') };
  if (kind === 'receipt') return { kind: 'receipt', receiptKind: reqStr(record, 'receiptKind', 'receipt wake condition') };
  if (kind === 'sweep') return { kind: 'sweep' };
  throw new Error(`obligation wake condition kind "${kind}" is unknown`);
}

export function parseAuthority(raw: string | null): ObligationAuthority | null {
  if (raw === null || raw === '') return null;
  const record = asRecord(JSON.parse(raw), 'obligation authority');
  const source = reqStr(record, 'source', 'obligation authority');
  const version = reqStr(record, 'version', 'obligation authority');
  if (source === 'accepted-operation') {
    return { source, operationId: reqStr(record, 'operationId', 'accepted-operation authority'), version };
  }
  if (source === 'chief-ruling' || source === 'owner-ruling') {
    return { source, rulingRef: reqStr(record, 'rulingRef', `${source} authority`), version };
  }
  throw new Error(`obligation authority source "${source}" is unknown`);
}

export function parseSettlement(raw: string): ObligationSettlement {
  const record = asRecord(JSON.parse(raw), 'obligation settlement');
  const kind = reqStr(record, 'kind', 'obligation settlement');
  switch (kind) {
    case 'executed-action':
      return {
        kind,
        action: reqStr(record, 'action', 'executed-action settlement'),
        evidenceEventSeq: reqSeq(record, 'evidenceEventSeq', 'executed-action settlement'),
        evidenceEventKind: reqStr(record, 'evidenceEventKind', 'executed-action settlement'),
      };
    case 'accepted-evidence':
      return {
        kind,
        gate: reqStr(record, 'gate', 'accepted-evidence settlement'),
        evidenceEventSeq: reqSeq(record, 'evidenceEventSeq', 'accepted-evidence settlement'),
        evidenceEventKind: reqStr(record, 'evidenceEventKind', 'accepted-evidence settlement'),
      };
    case 'superseded':
      return { kind, byObligationId: optStr(record, 'byObligationId'), reason: reqStr(record, 'reason', 'superseded settlement') };
    case 'cancelled':
      return { kind, reason: reqStr(record, 'reason', 'cancelled settlement') };
    case 'job-terminal': {
      const jobStatus = reqStr(record, 'jobStatus', 'job-terminal settlement');
      if (jobStatus !== 'done' && jobStatus !== 'merged') {
        throw new Error(`job-terminal settlement jobStatus "${jobStatus}" must be done or merged`);
      }
      return { kind, jobStatus };
    }
    default:
      throw new Error(`obligation settlement kind "${kind}" is unknown`);
  }
}

export function parseClaim(raw: string | null): ObligationClaim | null {
  if (raw === null || raw === '') return null;
  const record = asRecord(JSON.parse(raw), 'obligation claim');
  const generation = record['generation'];
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation)) {
    throw new Error('obligation claim generation must be a safe integer');
  }
  const expiresAt = optStr(record, 'expiresAt');
  if (expiresAt !== null) canonicalIsoTimestamp(expiresAt, 'obligation claim expiresAt');
  return {
    requestId: reqStr(record, 'requestId', 'obligation claim'),
    holder: reqStr(record, 'holder', 'obligation claim'),
    generation,
    expiresAt,
  };
}

const CLAIM_LOG_DISPOSITIONS = [
  'released',
  'superseded-expired-reconciled',
  'plan-revision',
  'terminal-close',
] as const;
export type ClaimLogDisposition = (typeof CLAIM_LOG_DISPOSITIONS)[number];

export function parseClaimLog(raw: string): readonly ClaimLogEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('obligation claim log must be a JSON array');
  return parsed.map((entry) => {
    const record = asRecord(entry, 'claim log entry');
    const generation = record['generation'];
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation)) {
      throw new Error('claim log entry generation must be a safe integer');
    }
    const disposition = reqStr(record, 'disposition', 'claim log entry');
    if (!(CLAIM_LOG_DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw new Error(`claim log entry disposition "${disposition}" is unknown`);
    }
    const expiresAt = optStr(record, 'expiresAt');
    if (expiresAt !== null) canonicalIsoTimestamp(expiresAt, 'claim log entry expiresAt');
    return {
      requestId: reqStr(record, 'requestId', 'claim log entry'),
      holder: reqStr(record, 'holder', 'claim log entry'),
      generation,
      expiresAt,
      disposition: disposition as ClaimLogDisposition,
      at: canonicalIsoTimestamp(reqStr(record, 'at', 'claim log entry'), 'claim log entry at'),
      proof: optStr(record, 'proof'),
      supersededByRequest: optStr(record, 'supersededByRequest'),
    };
  });
}

export function parseReceipts(raw: string): readonly RecordedReceipt[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('obligation recorded receipts must be a JSON array');
  return parsed.map((entry) => {
    const record = asRecord(entry, 'recorded receipt');
    const eventSeq = record['eventSeq'];
    if (typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq)) {
      throw new Error('recorded receipt eventSeq must be a safe integer');
    }
    return {
      kind: reqStr(record, 'kind', 'recorded receipt'),
      eventSeq,
      at: reqStr(record, 'at', 'recorded receipt'),
      applied: record['applied'] === true,
    };
  });
}

export function parseReceiptCorrelation(raw: string | null): ReceiptCorrelation | null {
  if (raw === null || raw === '') return null;
  const record = asRecord(JSON.parse(raw), 'obligation receipt correlation');
  const requestId = optStr(record, 'requestId');
  const minionId = optStr(record, 'minionId');
  if (requestId === null && minionId === null) {
    throw new Error('obligation receipt correlation must name at least a requestId or minionId');
  }
  return {
    ...(requestId !== null ? { requestId } : {}),
    ...(minionId !== null ? { minionId } : {}),
  };
}

// ------------------------------------------------------------------
// Explicit phase-completion handoffs (pr136-chief-handoff)
// ------------------------------------------------------------------

/** The typed intent a caller attaches to an authorized bounded phase:
 * WHEN that phase reaches a VALIDATED terminal completion, the named
 * decision is owed durably. The intent is a target plus a decision label
 * — never authority, never identity (the host mints the phase id) and
 * never a success claim. Exactly one target exists today (Gru); the
 * shape is validated, not speculatively extended. */
export interface CompletionHandoffIntent {
  readonly kind: 'gru-decision';
  readonly decision: string;
}

/** Bounded so a request cannot smuggle a document into the ledger. */
export const MAX_COMPLETION_HANDOFF_DECISION = 500;

/** Validate a caller-supplied completion-handoff intent at the boundary
 * (HTTP body → typed value). Throws a named, actionable error; the
 * caller decides the transport status. */
export function parseCompletionHandoffIntent(raw: unknown): CompletionHandoffIntent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('completion_handoff must be an object {kind:"gru-decision", decision:"..."}');
  }
  const record = raw as Record<string, unknown>;
  if (record['kind'] !== 'gru-decision') {
    throw new Error('completion_handoff.kind must be "gru-decision" — no other handoff target is authorized here');
  }
  const decision = record['decision'];
  if (typeof decision !== 'string' || decision.trim() === '') {
    throw new Error('completion_handoff.decision must be a non-empty string');
  }
  const trimmed = decision.trim();
  if (trimmed.length > MAX_COMPLETION_HANDOFF_DECISION) {
    throw new Error(`completion_handoff.decision exceeds ${MAX_COMPLETION_HANDOFF_DECISION} characters`);
  }
  return { kind: 'gru-decision', decision: trimmed };
}

/** The phase-authorizing request families a handoff intent can ride. */
export const PHASE_HANDOFF_SOURCES = ['dispatch', 'silas-directive', 'silas-rebrief'] as const;
export type PhaseHandoffSource = (typeof PHASE_HANDOFF_SOURCES)[number];

export function isPhaseHandoffSource(value: string): value is PhaseHandoffSource {
  return (PHASE_HANDOFF_SOURCES as readonly string[]).includes(value);
}

/** `awaiting` = the intent is durable, the phase has not completed;
 * `completed` = a validated correlated terminal delivery landed (the
 * obligation and publication are reconciled from here); `closed` =
 * terminal without a hand-back (cancelled/failed/superseded/parked or the
 * job reached a terminal state first). closed is terminal. */
export const PHASE_HANDOFF_STATES = ['awaiting', 'completed', 'closed'] as const;
export type PhaseHandoffState = (typeof PHASE_HANDOFF_STATES)[number];

export function isPhaseHandoffState(value: string): value is PhaseHandoffState {
  return (PHASE_HANDOFF_STATES as readonly string[]).includes(value);
}

/** One durable phase-handoff guard row. Persisted BEFORE any admission or
 * side effect; identity is host-owned (`phase-handoff:<job>:<source>:<n>`),
 * never the delivery event's sequence. */
export interface PhaseHandoffRecord {
  readonly phaseId: string;
  readonly jobId: string;
  readonly source: PhaseHandoffSource;
  /** Directive request id (provenance + delivery correlation), when a
   * directive request authorized this phase. */
  readonly requestId: string | null;
  /** Per-job monotonic generation: a genuinely new phase advances it; a
   * replay of the same request returns the same row. */
  readonly generation: number;
  /** The decision the completed phase owes (label only — no authority). */
  readonly decision: string;
  readonly state: PhaseHandoffState;
  /** events.seq watermark at intent acceptance; completion must postdate it. */
  readonly intentSeq: number;
  /** The bound admitted worker (dispatch path — minion binding after spawn). */
  readonly minionId: string | null;
  /** The correlated terminal `job.delivered` seq, once validated. */
  readonly completionSeq: number | null;
  /** The owed obligation recorded for this phase. */
  readonly obligationId: string | null;
  /** The published action-required row for this phase (stable kind). */
  readonly notificationId: string | null;
  readonly closeReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Stable host-owned phase identity: a replay/reconciliation derives the
 * same id from job+source+generation; the delivery event sequence never
 * participates. */
export function phaseHandoffId(jobId: string, source: PhaseHandoffSource, generation: number): string {
  if (jobId.trim() === '') throw new Error('phase handoff requires a non-empty job id');
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('phase handoff generation must be a positive safe integer');
  }
  return `phase-handoff:${jobId}:${source}:${generation}`;
}

// ------------------------------------------------------------------
// Report-job closure (issue #220): commissioner obligation on a
// delivered report-type job, the dispositions that settle it, and the
// code auto-supersede. One incident per job: `report:<jobId>`.
// ------------------------------------------------------------------

/** The report-type deliverables — a delivered one owes the commissioner a
 * disposition, never a PR chase. The E19 `pr` kind (and legacy NULL) are
 * excluded by definition. */
export const REPORT_DELIVERABLES = ['review', 'artifact', 'investigation'] as const;
export type ReportDeliverable = (typeof REPORT_DELIVERABLES)[number];

export function isReportDeliverable(value: string): value is ReportDeliverable {
  return (REPORT_DELIVERABLES as readonly string[]).includes(value);
}

/** The logical step the commissioner owes, chosen by the report kind:
 * a review's findings route as review follow-through, an artifact's
 * handback owes verification, an investigation's report owes an audit
 * ruling. The mapping is total over REPORT_DELIVERABLES. */
export function reportLogicalStep(deliverable: ReportDeliverable): ObligationLogicalStep {
  switch (deliverable) {
    case 'review':
      return 'review';
    case 'artifact':
      return 'verification';
    case 'investigation':
      return 'audit';
  }
}

/** The one report-closure incident key per job — stable across duplicate
 * deliveries and restarts, so a handback can never mint a second debt. */
export function reportIncidentKey(jobId: string): string {
  return `report:${jobId}`;
}

/** The commissioner's disposition of a delivered report. `acted` routes
 * the findings as a directive to the target lane (requires the directive
 * job id); `dismissed` and `superseded` carry a written reason. */
export const REPORT_DISPOSITION_OUTCOMES = ['acted', 'dismissed', 'superseded'] as const;
export type ReportDispositionOutcome = (typeof REPORT_DISPOSITION_OUTCOMES)[number];

export function isReportDispositionOutcome(value: string): value is ReportDispositionOutcome {
  return (REPORT_DISPOSITION_OUTCOMES as readonly string[]).includes(value);
}

/** The ledger event the disposition and the auto-supersede append — the
 * durable receipt a stranger can audit. */
export const REPORT_DISPOSITION_EVENT = 'job.report-disposition';
export const REPORT_SUPERSEDED_EVENT = 'report.superseded';
export const REPORT_BACKFILL_EVENT = 'report.backfilled';
