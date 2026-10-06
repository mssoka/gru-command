import type { BusEvent } from '../events/bus.js';
import type { DecisionRequest, QuestionSet, ScoreAnswer } from './types.js';

/**
 * The stable decision surface names (issues #222/#224). Each production
 * caller passes its surface to `decide` so `[decisions.surfaces]` can
 * route it to a provider profile; an unrouted surface rides the default
 * profile. The three #224 surfaces ship in `shadow` first: ask, record,
 * and still serve the deterministic answer (see README of the backtest
 * harness — `mode = "enforce"` additionally requires recorded backtest
 * evidence and an owner decision, and escalation-triage enforcement also
 * requires #219's deferral mechanism).
 */
export const DECISION_SURFACE_EVENT_TRIAGE = 'event_triage';
export const DECISION_SURFACE_SUPERVISION = 'supervision_guidance';
export const DECISION_SURFACE_ESCALATION_TRIAGE = 'escalation_triage';
export const DECISION_SURFACE_SAME_BLOCKER = 'same_blocker';
export const DECISION_SURFACE_REPORT_CONCLUSION = 'report_conclusion';

const SECRET_KEY_CANONICAL = /(?:authorization|proxyauthorization|apikey|token|accesstoken|refreshtoken|idtoken|password|passwd|secret|clientsecret|credential|cookie|sessionid|sessionkey|sessiontoken|awssecretaccesskey|privatekey)/i;
const SECRET_FIELD = String.raw`(?:authorization|proxy[-_\s]?authorization|api[-_\s]?key|(?:access|refresh|id)[-_\s]?token|token|password|passwd|(?:client[-_\s]?)?secret|credential|cookie|session[-_\s]?(?:id|key|token)|aws[-_\s]?secret[-_\s]?access[-_\s]?key|private[-_\s]?key)`;
// Free-text failures often contain `Authorization: Bearer <key>`,
// `access_token=<value> remaining text`, or env-var-style
// `OPENROUTER_API_KEY=<value>` (word characters around the field name, so
// no \b boundary applies). Redact the whole line tail rather than one
// whitespace-delimited token; over-redaction is safer than sending a
// second token to the provider.
const INLINE_SECRET = new RegExp(`([A-Za-z0-9_.-]*?${SECRET_FIELD}[A-Za-z0-9_.-]*?\\s*[:=]\\s*)[^\\r\\n]*`, 'gi');
const QUOTED_SECRET = new RegExp(`((?:"|')${SECRET_FIELD}(?:"|')\\s*:\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*')`, 'gi');
const CLI_SECRET = new RegExp(`((?:--${SECRET_FIELD})\\s+)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;]+)`, 'gi');
const AUTH_SCHEME_SECRET = /\b(bearer|basic)\s+[^\s,;]+/gi;
// Findings often quote the very credential leak they report. URL userinfo
// is secret-bearing even when no field is named "password".
const URL_USERINFO_SECRET = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
// Common opaque-key formats are redacted even when embedded in source text
// under an unhelpful variable name. Keep this intentionally conservative.
const OPAQUE_KEY_SECRET = /\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|(?:ghp|github_pat)_[A-Za-z0-9_]{12,})\b/g;
// The END marker may already have been lost to an upstream display bound.
// Treat any private-key BEGIN marker as secret-bearing through END or EOF.
const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_CANONICAL.test(key.replace(/[^a-z0-9]/gi, ''));
}

export function redactedText(value: string, max = 800): string {
  // Bound the scan window BEFORE any pattern pass: these regexes run on the
  // synchronous event path and untrusted single-line blocks can be
  // arbitrarily long. The 4x window leaves room for redaction markers while
  // the final slice enforces the caller's bound; every pattern pass is then
  // linear in a constant-size window, not in the raw input length.
  const bounded = value.length > max * 4 ? value.slice(0, max * 4) : value;
  return bounded
    .replace(PRIVATE_KEY_BLOCK, '[redacted private key]')
    .replace(URL_USERINFO_SECRET, '$1$2:[redacted]@')
    .replace(QUOTED_SECRET, '$1"[redacted]"')
    .replace(INLINE_SECRET, '$1[redacted]')
    .replace(CLI_SECRET, '$1[redacted]')
    .replace(AUTH_SCHEME_SECRET, '$1 [redacted]')
    .replace(OPAQUE_KEY_SECRET, '[redacted]')
    .slice(0, max);
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return redactedText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => safeValue(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      out[key] = isSecretKey(key) ? '[redacted]' : safeValue(item, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 120);
}

export function filteredState(value: unknown): string {
  return JSON.stringify(safeValue(value)).slice(0, 4_000);
}

export function choiceProbabilities<Choice extends string>(
  choices: readonly Choice[],
  selected: Choice,
): Record<Choice, number> {
  return Object.fromEntries(choices.map((choice) => [choice, choice === selected ? 1 : 0])) as Record<Choice, number>;
}

function scoreFallback(score: number, levels: number): ScoreAnswer {
  return {
    type: 'score',
    score,
    probabilities: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), index === score ? 1 : 0])),
    confidence: 1,
  };
}

const EVENT_CLASSES = [
  'routine_fyi',
  'operator_attention',
  'action_required',
  'settle_noise',
  'unknown',
] as const;

const EVENT_QUESTIONS = {
  needs_action: {
    type: 'noul',
    instructions: 'Does this orchestration transition require an operator action rather than informational display?',
    criteria: {
      true: 'A human or operator must make a decision, repair state, or respond now.',
      false: 'The transition is informational, already settled, or requires no response.',
    },
  },
  event_class: {
    type: 'choice',
    instructions: 'Classify this single orchestration event by the attention it needs.',
    options: EVENT_CLASSES,
    criteria: {
      routine_fyi: 'Useful progress or status information with no response needed.',
      operator_attention: 'Worth highlighting for inspection, but not an immediate decision.',
      action_required: 'A human decision or repair is required.',
      settle_noise: 'A duplicate, settled transition, or non-actionable echo.',
      unknown: 'Evidence is insufficient for the other classes.',
    },
  },
  severity: {
    type: 'score',
    instructions: 'Rate the operational attention of this event using the ordered rubric.',
    criteria: ['low: routine informational state', 'medium: inspect soon', 'high: action is required now'],
  },
} as const satisfies QuestionSet;

export interface EventDecisionContext {
  /** Bounded redacted tail of the event's primary text (the transcript
   * surface for error events) — never a whole session history. */
  readonly transcriptTail?: string | null;
  /** Recent same-source history summary from the durable ledger. */
  readonly recentSameSourceEvents?: number;
  readonly recentSameKindEvents?: number;
}

export function eventDecisionRequest(
  event: BusEvent,
  context: EventDecisionContext = {},
): DecisionRequest<typeof EVENT_QUESTIONS> {
  return {
    state: filteredState({
      kind: event.kind,
      agent_id: event.agentId,
      job_id: event.jobId,
      round_id: event.roundId,
      lens: event.lens,
      payload: event.payload,
      transcript_tail: context.transcriptTail ?? null,
      recent_same_source: {
        events: context.recentSameSourceEvents ?? 0,
        same_kind: context.recentSameKindEvents ?? 0,
      },
    }),
    questions: EVENT_QUESTIONS,
    risks: { needs_action: 'operational', event_class: 'read_only', severity: 'read_only' },
    fallback: {
      needs_action: { type: 'noul', noul: 0 },
      event_class: {
        type: 'choice',
        choice: 'routine_fyi',
        probabilities: choiceProbabilities(EVENT_CLASSES, 'routine_fyi'),
        confidence: 1,
      },
      severity: scoreFallback(0, 3),
    },
  };
}

export const FAILURE_CLASSES = [
  'transient_runtime',
  'authentication_wall',
  'quota_wall',
  'network_failure',
  'turn_hang',
  'fatal_runtime',
  'unknown',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export function deterministicFailureClass(reason: string): FailureClass {
  // Word-bounded signals: bare substrings wall-classified unrelated text
  // ("author" hit `auth`; "port 13020" hit `1302`). The stems still admit
  // snake/camel/compound spellings (oauth, auth_error, RateLimited, crashed)
  // so real walls keep their deterministic stop.
  if (
    /\b(?:unauthorized|oauth|auth(?:entication|orization|orized|n|[_-]error|[_-]failure)?)\b|invalid api.?key|\b401\b/i.test(reason)
  ) return 'authentication_wall';
  if (
    /\bquota\b|\brate[- ]?limit(?:ed)?\b|insufficient (?:balance|credit)|\b402\b|\b403\b|\b429\b|\b1302\b|\b1308\b/i.test(reason)
  ) return 'quota_wall';
  if (/network|connect|dns|socket|econn|fetch failed/i.test(reason)) return 'network_failure';
  if (/turn hang|compaction hang|silence|watchdog/i.test(reason)) return 'turn_hang';
  if (/\bfatal\b|\bpanic\b|\bcrash(?:ed|ing)?\b|disposed/i.test(reason)) return 'fatal_runtime';
  return 'unknown';
}

const SUPERVISION_QUESTIONS = {
  failure_class: {
    type: 'choice',
    instructions: 'Classify the observed runtime failure signature into exactly one operational class.',
    options: FAILURE_CLASSES,
    criteria: {
      transient_runtime: 'A temporary runtime failure where one bounded restart is reasonable.',
      authentication_wall: 'Credentials are absent, invalid, rejected, or unauthorized; blind restart will not fix it.',
      quota_wall: 'Quota, rate, plan, balance, or provider capacity blocks requests; blind restart will not fix it.',
      network_failure: 'DNS, connection, socket, or transport failure.',
      turn_hang: 'An open turn has no events and no session-file growth past the deterministic timeout.',
      fatal_runtime: 'The runtime process/session reported an unrecoverable fatal error or crash.',
      unknown: 'The signature cannot be reliably classified.',
    },
  },
  restart_advised: {
    type: 'noul',
    instructions: 'Would one bounded runtime restart plausibly recover this exact failure?',
    criteria: {
      true: 'A restart can plausibly restore service without retrying a known authentication or quota wall.',
      false: 'A restart is futile or unsafe; operator escalation is required instead.',
    },
  },
  severity: {
    type: 'score',
    instructions: 'Rate the urgency of this runtime failure using the ordered rubric.',
    criteria: ['low: transient and recoverable', 'medium: degraded; inspect', 'high: operator intervention required'],
  },
} as const satisfies QuestionSet;

export function supervisionDecisionRequest(input: {
  readonly reason: string;
  readonly agentId: string;
  readonly role: string;
  readonly restartCount: number;
  readonly breakerLimit: number;
}): DecisionRequest<typeof SUPERVISION_QUESTIONS> {
  const failureClass = deterministicFailureClass(input.reason);
  const restart = failureClass !== 'authentication_wall' && failureClass !== 'quota_wall';
  return {
    state: filteredState(input),
    questions: SUPERVISION_QUESTIONS,
    risks: { failure_class: 'operational', restart_advised: 'operational', severity: 'read_only' },
    fallback: {
      failure_class: {
        type: 'choice',
        choice: failureClass,
        probabilities: choiceProbabilities(FAILURE_CLASSES, failureClass),
        confidence: 1,
      },
      restart_advised: { type: 'noul', noul: restart ? 1 : 0 },
      severity: scoreFallback(restart ? 1 : 2, 3),
    },
  };
}

// ------------------------------------------------------------------
// The three shadow surfaces (issue #224)
//
// Question sets are the SINGLE production home of the vocabulary the
// backtest harness (issue #223) measures: the `cases/` specs import them
// from here so a backtest can never drift from what production asks.
// Every surface is `operational`-risk with a deterministic fallback that
// FAILS TOWARD THE WAKE / THE NEW BLOCKER / THE COMMISSIONER REVIEW —
// the conservative side is the side that keeps a human in the loop.
// ------------------------------------------------------------------

/**
 * ESCALATION TRIAGE (machine wakes only). Classifies a Silas-authored
 * escalation at wake-candidate time: does it ask the chief for a decision
 * that is not already recorded (decision memory, issue #218), or is it a
 * status report / already-covered item? The deterministic baseline is
 * today's behavior — every escalation reaches Gru (`needs_ruling`, noul
 * 1) — so an unavailable or low-confidence answer always wakes.
 */
export const ESCALATION_TRIAGE_QUESTIONS = {
  triage: {
    type: 'choice',
    instructions: 'Classify this machine-authored escalation by the attention it needs.',
    options: ['needs_ruling', 'needs_owner', 'status_report', 'covered_by_open_item'] as const,
    criteria: {
      needs_ruling: 'The escalation asks for a decision a human or the chief must make now.',
      needs_owner: 'Only the repository owner can decide this (credentials, spend, policy).',
      status_report: 'The escalation only reports progress or status; no response is needed.',
      covered_by_open_item: 'The ask is already covered by an open item, hold or disposition.',
    },
  },
  needs_decision: {
    type: 'noul',
    instructions: 'Does this escalation ask the chief for a decision not already recorded in the listed holds/dispositions?',
    criteria: {
      true: 'A new decision is being asked for.',
      false: 'No new decision is asked for; the escalation is informational or already covered.',
    },
  },
} as const satisfies QuestionSet;

/** One escalation row as the request state carries it: the ledger
 * notification's stable identity fields (already durable, already
 * redacted at write time; `filteredState` re-redacts defensively). */
export interface EscalationFacts {
  readonly kind: string;
  readonly title: string | null;
  readonly detail: string | null;
}

/** One decision-memory row (issue #218) reduced to what triage needs.
 * `covers` and `basis_fingerprint` ride along so a hold scoped to another
 * signal — or one made against a stale basis — cannot read as an
 * applicable open item. */
export interface DecisionMemoryFacts {
  readonly decision: string;
  readonly reason: string;
  readonly by: string;
  /** The decision's covered signals, canonical order, joined — a string
   * survives `filteredState`'s bounded-depth rendering without
   * truncation. */
  readonly covers: string;
  readonly basis_fingerprint: string | null;
  readonly recheck_at: string | null;
}

export interface EscalationTriageInput {
  /** The Silas-authored escalation rows in this wake candidate batch. */
  readonly escalations: readonly EscalationFacts[];
  /** The wake policy mode the candidate arrived under (e.g.
   * `action-required`), for provenance of "machine wake". */
  readonly mode: string | null;
  /** Open decision-memory rows for the escalated subject (issue #218).
   * Empty until decision memory records one — the key is omitted so the
   * state matches the labelled extractor's shape exactly. */
  readonly openDecisions?: readonly DecisionMemoryFacts[];
  /** Recent dispositions for the escalated subject (issue #218), newest
   * first. Omitted for the same parity reason. */
  readonly recentDispositions?: readonly DecisionMemoryFacts[];
}

export function escalationTriageDecisionRequest(input: EscalationTriageInput): DecisionRequest<typeof ESCALATION_TRIAGE_QUESTIONS> {
  const state: Record<string, unknown> = {
    wake: { notification_count: input.escalations.length, mode: input.mode },
    escalations: input.escalations,
  };
  if (input.openDecisions !== undefined && input.openDecisions.length > 0) state['open_decisions'] = input.openDecisions;
  if (input.recentDispositions !== undefined && input.recentDispositions.length > 0) state['recent_dispositions'] = input.recentDispositions;
  return {
    state: filteredState(state),
    questions: ESCALATION_TRIAGE_QUESTIONS,
    risks: { triage: 'operational', needs_decision: 'read_only' },
    // Fail toward a wake: the baseline IS "reach Gru".
    fallback: {
      triage: {
        type: 'choice',
        choice: 'needs_ruling',
        probabilities: choiceProbabilities(ESCALATION_TRIAGE_QUESTIONS.triage.options, 'needs_ruling'),
        confidence: 1,
      },
      needs_decision: { type: 'noul', noul: 1 },
    },
  };
}

/**
 * SAME-BLOCKER IDENTITY. Asked when two review findings carry DIFFERENT
 * #216 stable fingerprints but overlap on file and category: do they
 * describe the same underlying defect? The deterministic baseline is
 * today's rule — different fingerprints are DIFFERENT blockers (noul 0)
 * — so a wrongly-merged pair stays impossible without a confident
 * provider answer (a hidden live defect is worse than a duplicate rung).
 */
export const SAME_BLOCKER_QUESTIONS = {
  same_defect: {
    type: 'noul',
    instructions: 'Do these two review findings describe the same underlying defect?',
    criteria: {
      true: 'The two findings are the same defect and should share one recurrence ladder entry.',
      false: 'The two findings are distinct defects even if they touch the same file.',
    },
  },
} as const satisfies QuestionSet;

/** One side of a same-blocker pair. The digest's `RoundBlocker` carries
 * the first three; severity/detail ride along when the caller has them
 * (the labelled extractor always does). */
export interface BlockerFacts {
  readonly category: string;
  readonly location: string;
  readonly title: string;
  readonly severity?: string | null;
  readonly detail?: string | null;
}

/** A finding's file: the SAME normalization #216's blockerLocationKey
 * applies (separators, `#L`/line/range suffixes, case) plus one trailing
 * `:column` strip for `path:line:col` locations — a strict superset, so
 * a candidate pair's file check can never contradict the fingerprint
 * identity that guards it while still matching plain file-level overlap.
 * Shared by the production pairing and the labelled extractor. */
export function fileOfLocation(location: string): string {
  return location
    .trim()
    .replace(/\\+/gu, '/')
    .replace(/(?:#L\d+(?:-L\d+)?|:\d+(?:-\d+)?)$/u, '')
    .replace(/:\d+$/u, '')
    .toLowerCase()
    .trim();
}

function blockerFactsState(facts: BlockerFacts): Record<string, unknown> {
  const state: Record<string, unknown> = { title: facts.title, category: facts.category, location: facts.location };
  if (facts.severity != null) state['severity'] = facts.severity;
  if (facts.detail != null) state['detail'] = facts.detail;
  return state;
}

export function sameBlockerDecisionRequest(
  prior: BlockerFacts,
  current: BlockerFacts,
): DecisionRequest<typeof SAME_BLOCKER_QUESTIONS> {
  return {
    state: filteredState({ prior_finding: blockerFactsState(prior), current_finding: blockerFactsState(current) }),
    questions: SAME_BLOCKER_QUESTIONS,
    risks: { same_defect: 'operational' },
    // Deterministic fingerprint equality — and when fingerprints differ
    // (the only time this is asked), "different" is the baseline.
    fallback: { same_defect: { type: 'noul', noul: 0 } },
  };
}

/**
 * REPORT CONCLUSION (report-type handbacks, issue #220's host). One
 * choice over the handback: did the report pass clean, do its findings
 * need action, or is it inconclusive? The deterministic baseline is
 * today's behavior — every delivered report still owes the commissioner
 * a review (`findings_need_action`) — so a missing answer always wakes
 * the commissioner. The production ask wires at #220's report handback
 * path; until that host exists this surface stays shadow-measurable via
 * the backtest harness only.
 */
export const REPORT_CONCLUSION_QUESTIONS = {
  conclusion: {
    type: 'choice',
    instructions: 'Conclude this report-type handback for the commissioner.',
    options: ['clean_pass', 'findings_need_action', 'inconclusive'] as const,
    criteria: {
      clean_pass: 'The report supports closing the obligation with no further work.',
      findings_need_action: 'The report contains findings someone must act on.',
      inconclusive: 'The report does not contain enough evidence to conclude either way.',
    },
  },
} as const satisfies QuestionSet;

/** The explicit `Verdict:` line is the LABEL (ground truth from the
 * canonical Perkins vocabulary), never part of the question — strip every
 * explicit verdict line the way the labelled extractor does. Long bodies
 * are then SUMMARISED (issue #224's input limit), not tail-truncated: the
 * head of the report (its summary sections lead) plus every finding-title
 * line, up to the bound. Shared by production and the labelled extractor
 * so a backtest measures exactly what production sends. */
/** `filteredState` bounds every string field through `redactedText` at
 * 800 characters, so the summarised body must land under that — a longer
 * body loses its tail, and the finding titles live at the tail. */
export const REPORT_BODY_BOUND = 700;

const FINDING_TITLE_LINE = /^\s*(?:#{1,6}\s|[-*]\s|\d+\.\s)/u;

export function reportConclusionState(report: string): string {
  const body = summariseReportBody(
    report
      .split(/\r?\n/u)
      .filter((line) => !/^\s*(?:\*\*)?Verdict:\s*(?:READY TO MERGE|NEEDS CHANGES|MAJOR REWORK NEEDED|INCOMPLETE)(?:\*\*)?\s*$/iu.test(line))
      .join('\n')
      .trim(),
  );
  return filteredState({ report: body });
}

/** Deterministic bounded summary: bodies at or under the bound pass
 * through untouched (the labelled history's regime); longer bodies keep
 * their head plus every finding-title line. */
export function summariseReportBody(body: string, bound: number = REPORT_BODY_BOUND): string {
  if (body.length <= bound) return body;
  const lines = body.split(/\r?\n/u);
  const head: string[] = [];
  let headLength = 0;
  const headBudget = Math.floor(bound * 0.6);
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (headLength + line.length + 1 > headBudget) break;
    head.push(line);
    headLength += line.length + 1;
  }
  const titles: string[] = [];
  let titlesLength = 0;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (!FINDING_TITLE_LINE.test(line)) continue;
    if (headLength + titlesLength + line.length + 2 > bound) break;
    titles.push(line.trim());
    titlesLength += line.length + 2;
  }
  return [...head, ...(titles.length > 0 ? ['', '… finding titles:', ...titles] : [])].join('\n').trim();
}

export function reportConclusionDecisionRequest(report: string): DecisionRequest<typeof REPORT_CONCLUSION_QUESTIONS> {
  return {
    state: reportConclusionState(report),
    questions: REPORT_CONCLUSION_QUESTIONS,
    risks: { conclusion: 'operational' },
    // The baseline is today's behavior: every delivered report still owes
    // the commissioner a review (`findings_need_action`) — never a silent
    // clean pass. (#223's case spec pins the same constant, so backtests
    // measure production exactly.)
    fallback: {
      conclusion: {
        type: 'choice',
        choice: 'findings_need_action',
        probabilities: choiceProbabilities(REPORT_CONCLUSION_QUESTIONS.conclusion.options, 'findings_need_action'),
        confidence: 1,
      },
    },
  };
}

