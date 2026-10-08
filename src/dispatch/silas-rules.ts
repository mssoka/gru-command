/**
 * The named Silas mechanical rules (issue #117, review finding g21): the
 * single provenance vocabulary for every rule the ops-dispatch skill
 * promises. This is NOT a rules engine — there is no pluggable condition,
 * no registration, no inference. Each entry is one bounded reaction the
 * skill names, with its exact firing surface (the digest row or request
 * state that marks it) and the receipt event kind that must carry its id.
 *
 * The promise set and the executable rule set are kept identical by
 * construction: a rule that has no firing surface and receipt MUST NOT be
 * added here, and the skill MUST NOT name a rule that is absent here.
 */

/** Action rules: a digest-marked state Silas answers through the ops
 * surface; the action's receipt carries `rule_id` (and `source_round_id`
 * when the rule consumes a specific round). */
export type SilasActionRuleId =
  | 'clean-abort-service-restart'
  | 'verdict-rung-directive'
  | 'verdict-rung-rebrief'
  | 'verdict-rung-escalate'
  | 'verification-repair'
  | 'pr-conflict-rebase'
  | 'revision-continuation'
  | 'sweep-ack';

/** Gate rules: standing fences, not triggers. A gate's receipt proves the
 * fence FIRED (a refusal), never that work was triggered. */
export type SilasGateRuleId = 'freeze-r1';

export type SilasRuleId = SilasActionRuleId | SilasGateRuleId;

export interface SilasRuleSpec {
  readonly id: SilasRuleId;
  readonly kind: 'action' | 'gate';
  /** The exact firing condition: the digest row (or request state) whose
   * presence marks this rule. Prose, but OPERATIONAL prose — a stranger
   * can find the surface in code from this line. */
  readonly firesOn: string;
  /** The receipt event kind(s) that carry the rule id when the rule
   * fires. Every named kind is written by code that validates the id. */
  readonly receipt: readonly string[];
  readonly summary: string;
}

/** The complete registry, in skill order. Bounded by review finding g21:
 * adding a rule is a deliberate decision that lands with firing/provenance
 * tests, never an inference from a new digest row. */
export const SILAS_RULES: readonly SilasRuleSpec[] = [
  {
    id: 'clean-abort-service-restart',
    kind: 'action',
    firesOn:
      'prWithoutReview row carrying cleanAbort: the newest round aborted with reason ' +
      'service_restart | service_restart_missing_review_lane on the unchanged delivered head',
    receipt: ['silas.review-triggered', 'silas.review-deferred'],
    summary:
      'Re-arm ONE review on the proved delivered head; the armed round (or the 409 deferral) carries rule_id + source_round_id.',
  },
  {
    id: 'verdict-rung-directive',
    kind: 'action',
    firesOn:
      'verdictsAwaitingDirective row whose recurring blocker advice is directive (first or evolving blocker, or the rung the recurrence count advises)',
    receipt: ['silas.directive-sent'],
    summary:
      'Fix directive naming each blocker with its evidence; the receipt carries rule_id + source_round_id + blocker_fingerprint.',
  },
  {
    id: 'verdict-rung-rebrief',
    kind: 'action',
    firesOn: 'verdictsAwaitingDirective row whose recurring blocker advice is rebrief',
    receipt: ['silas.rebrief'],
    summary:
      'Fresh worker on the lane; the durable request marker carries the rule, and the silas.rebrief receipt replays it (restart-safe).',
  },
  {
    id: 'verdict-rung-escalate',
    kind: 'action',
    firesOn: 'verdictsAwaitingDirective row whose recurring blocker advice is escalate',
    receipt: ['silas.escalated'],
    summary: 'Escalate with pointers; the receipt carries rule_id + source_round_id.',
  },
  {
    id: 'verification-repair',
    kind: 'action',
    firesOn: 'verificationFailures row (newest completed verification FAILED, no repair rung landed since)',
    receipt: ['silas.directive-sent'],
    summary:
      'Repair directive with the exact blocker_fingerprint verification-failure:<scope>@<run_id>; the receipt carries rule_id.',
  },
  {
    id: 'pr-conflict-rebase',
    kind: 'action',
    firesOn: 'conflictingPrs row (open PR head dirty against its base, no operation owns the lane)',
    receipt: ['silas.directive-sent'],
    summary:
      'ONE rebase directive with blocker_fingerprint pr-conflict:<head_sha>; the receipt carries rule_id.',
  },
  {
    id: 'revision-continuation',
    kind: 'action',
    firesOn:
      'revisionContinuations row (accepted material amendments the newest delivery did not carry, no writer owns the lane)',
    receipt: ['silas.directive-sent'],
    summary:
      'ONE continuation directive with blocker_fingerprint contract-revision:<required>; the service attaches every pending ' +
      'amendment and stamps the revision, and the receipt carries rule_id.',
  },
  {
    id: 'sweep-ack',
    kind: 'action',
    firesOn:
      'releaseEligible row: a terminal (merged/done/binned) job still holding its own kind=job lane, with no non-terminal child worker',
    receipt: ['silas.lane-released'],
    summary:
      'Release the lane through the worktree surface with by=silas + rule_id=sweep-ack; the release records the receipt on the job.',
  },
  {
    id: 'freeze-r1',
    kind: 'gate',
    firesOn:
      'a review arm attempted while a lane is actively working/pushing the target branch or an unresolved re-brief stands (the branch-idle guard answers 409 branch_busy)',
    receipt: ['silas.review-deferred'],
    summary:
      'Defer the arm to the next sweep; the deferral receipt carries gate=freeze-r1 proving the fence fired. Never force.',
  },
] as const;

const RULES_BY_ID: ReadonlyMap<string, SilasRuleSpec> = new Map(SILAS_RULES.map((rule) => [rule.id, rule]));

/** Every named rule id (actions + gates), for validation. */
export const SILAS_RULE_IDS: ReadonlySet<string> = new Set(RULES_BY_ID.keys());

/** Action rules only — the ids a trigger/directive/rebrief/escalate
 * request may carry as its firing rule. */
export const SILAS_ACTION_RULE_IDS: ReadonlySet<string> = new Set(
  SILAS_RULES.filter((rule) => rule.kind === 'action').map((rule) => rule.id),
);

/** Validate a raw request field as a known action rule id. Returns null
 * for absent (undefined) input; throws a boundary-grade message for a
 * present-but-unknown or gate id — refusals name the failed field. */
export function parseSilasActionRuleId(raw: string | undefined): SilasActionRuleId | null {
  if (raw === undefined) return null;
  const spec = RULES_BY_ID.get(raw);
  if (spec === undefined) {
    throw new Error(`rule_id "${raw}" is not a named Silas rule (named: ${[...SILAS_RULE_IDS].sort().join(', ')})`);
  }
  if (spec.kind !== 'action') {
    throw new Error(`rule_id "${raw}" is a gate, not an action rule — gates are proven by refusals, never requested`);
  }
  return raw as SilasActionRuleId;
}

/** The receipt contract is per-route: each silas endpoint records exactly
 * one event kind, so only the rules whose registry receipt IS that event
 * may fire there. A rule id on the wrong route would mint a receipt the
 * registry never assigned (issue #117 review: cross-route rule claims). */
export const SILAS_RULE_ROUTES: Readonly<{
  directive: ReadonlySet<string>;
  rebrief: ReadonlySet<string>;
  escalate: ReadonlySet<string>;
}> = {
  directive: new Set(['verdict-rung-directive', 'verification-repair', 'pr-conflict-rebase', 'revision-continuation']),
  rebrief: new Set(['verdict-rung-rebrief']),
  escalate: new Set(['verdict-rung-escalate']),
};

/** Validate a rule id for a specific route: known action rule AND allowed
 * on that route. Absent input → null; anything else refuses loud. */
export function parseSilasRouteRuleId(
  route: 'directive' | 'rebrief' | 'escalate',
  raw: string | undefined,
): SilasActionRuleId | null {
  const parsed = parseSilasActionRuleId(raw);
  if (parsed === null) return null;
  if (!SILAS_RULE_ROUTES[route].has(parsed)) {
    throw new Error(`rule_id "${parsed}" does not fire on the ${route} route (allowed: ${[...SILAS_RULE_ROUTES[route]].sort().join(', ')})`);
  }
  return parsed;
}

/** Verdict-rung rules consume a specific verdict round: their provenance
 * is incomplete without the round id they answered. */
export function isVerdictRungRule(ruleId: string): boolean {
  return ruleId === 'verdict-rung-directive' || ruleId === 'verdict-rung-rebrief' || ruleId === 'verdict-rung-escalate';
}

/** Strict optional string field: present-but-empty or non-string values
 * refuse loud instead of silently reading as absent (a malformed rule_id
 * must never downgrade to an action without provenance). */
export function strictOptStrField(body: Record<string, unknown>, field: string): string | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string when present`);
  }
  return value;
}
