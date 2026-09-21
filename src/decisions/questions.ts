import type { BusEvent } from '../events/bus.js';
import type { DecisionRequest, QuestionSet, ScoreAnswer } from './types.js';

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

function choiceProbabilities<Choice extends string>(
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
  // ("author" hit `auth`; "port 13020" hit `1302`).
  if (/\bauth\b|\bauth(?:entication|orized|orization)\b|unauthorized|invalid api.?key|\b401\b/i.test(reason)) return 'authentication_wall';
  if (/\bquota\b|\brate[- ]?limit\b|insufficient (?:balance|credit)|\b402\b|\b403\b|\b429\b|\b1302\b|\b1308\b/i.test(reason)) return 'quota_wall';
  if (/network|connect|dns|socket|econn|fetch failed/i.test(reason)) return 'network_failure';
  if (/turn hang|compaction hang|silence|watchdog/i.test(reason)) return 'turn_hang';
  if (/\bfatal\b|panic|\bcrash\b|disposed/i.test(reason)) return 'fatal_runtime';
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

