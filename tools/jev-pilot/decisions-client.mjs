#!/usr/bin/env node
/**
 * Minimal Jev decisions client — Pilot 1 lane residue (gru-command-jev-pilot).
 * Amendment 2 (2026-09-19): encodes the JEV DOCS KIT as interface-level
 * requirements, not comments. Sources (all fetched + verified 2026-09-19):
 *   - docs.typesafe.ai/confidence.md
 *   - docs.typesafe.ai/model-jaggedness/jev-1.13.md
 *   - docs.typesafe.ai/patterns/confidence-routing.md
 *   - docs.typesafe.ai/cookbooks/parallel_questions.md (12.2x cheaper, 10.0x faster)
 *
 * Zero-dependency Node >= 18 client for the OpenRouter /api/alpha/decisions
 * endpoint (user-confirmed shape; receipts in evidence/).
 *
 * NOT wired into gru-command: pilot tooling only. Fold-in = its own change;
 * see config-flag-schema-sketch.md for the seam sketch.
 *
 * ---- Interface-level requirements (Amendment 2) ----
 * A. CONFIDENCE SEMANTICS: `confidence` ships on Choice/Score answers ONLY.
 *    Noul carries a bare probability. Therefore: noul gates threshold on
 *    PROBABILITY, choice/score gates threshold on CONFIDENCE. Both stay
 *    exposed on the answer objects — never collapsed into one field.
 * B. JEVi-1.13 JAGGEDNESS: arithmetic/counting/dates stay in code; filter
 *    state before sending; criteria are literal with boundary cases; the
 *    vendor does NOT treat state as hostile (adversarial caveat on the
 *    destructive gate); NO cross-question invariants (never compose a noul
 *    answer with a choice answer). Encoded in QUESTION_DESIGN_RULES +
 *    validateQuestions + routeDecision(single answer).
 * C. BATCHING: parallel questions in ONE call are ~12x cheaper — the
 *    client's default shape is the batched QuestionSet; single-question
 *    calls warn.
 *
 * Usage:
 *   node tools/jev-pilot/decisions-client.mjs --demo   # re-run access probe (~$0.00003)
 *   node --test tools/jev-pilot/                       # offline interface tests
 *   import { decide, routeDecision, RISK_CLASSES } from './decisions-client.mjs'
 */

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = '~typesafe/jev-latest'; // user-confirmed slug; resolves to the pinned jev-1.13 snapshot

/* ------------------------------------------------------------------ */
/* A. Answer types — confidence ONLY on Choice/Score.                  */
/* (JSDoc because .mjs; the fold-in's TS interface mirrors these.)     */
/** @typedef {{type:'noul', noul:number}} NoulAnswer — probability ONLY, no confidence (confidence.md) */
/** @typedef {{type:'choice', choice:string, probabilities:Object<string,number>, confidence:number}} ChoiceAnswer */
/** @typedef {{type:'score', score:number, probabilities:Object<string,number>, confidence:number}} ScoreAnswer */
/** @typedef {NoulAnswer|ChoiceAnswer|ScoreAnswer} Answer */
/** @typedef {'noul'|'choice'|'score'} QuestionType */
/** @typedef {{act:number, confirm:number, requireConfirmOnAct?:boolean}} RiskThresholds */
/** @typedef {'act'|'confirm'|'fallback'} RoutePath */
/** @typedef {{path:RoutePath, metric:number, metricKind:'probability'|'confidence', requiresConfirm:boolean}} Route */

/**
 * B. Question-design rules (jev-1.13 jaggedness), machine-readable so the
 * fold-in can surface them in review/lint. Each rule cites its vendor doc.
 */
export const QUESTION_DESIGN_RULES = Object.freeze([
  { id: 'literal-criteria', rule: 'State the exact condition in instructions; put boundary cases in criteria — jev-1.13 reads literally, not intent.', source: 'model-jaggedness/jev-1.13.md #1' },
  { id: 'math-in-code', rule: 'Arithmetic, counting, dates: compute in code, never the model. Pass computed values or named buckets as state.', source: 'model-jaggedness/jev-1.13.md #2,#3' },
  { id: 'filter-state', rule: 'Filter state before sending — unrelated detail is a distractor and costs accuracy (context rot).', source: 'model-jaggedness/jev-1.13.md #5' },
  { id: 'adversarial-caveat', rule: 'The vendor does NOT treat state as hostile. Any gate over untrusted text (esp. destructive-call) must be tested against adversarial command text.', source: 'model-jaggedness/jev-1.13.md #6' },
  { id: 'aligned-criteria', rule: 'instructions and criteria must ask for the same thing; inverted true/false mappings degrade accuracy.', source: 'model-jaggedness/jev-1.13.md #7' },
  { id: 'no-cross-invariants', rule: 'No cross-question invariants: never compose a noul answer with a choice answer; enforce identities in code.', source: 'model-jaggedness/jev-1.13.md #8' },
  { id: 'atomic-questions', rule: 'One gut-check judgment per question; decompose multi-factor judgments and combine in code.', source: 'vendor discipline + lane doctrine' },
]);

/**
 * A. Per-risk-class threshold defaults (confidence-routing.md: thresholds
 * scale with risk; the banking example floors at ~0.5-0.6 and gates
 * destructive acts at >0.85 WITH confirm). Config-overridable in the
 * fold-in; these are the sketch defaults.
 */
export const RISK_CLASSES = Object.freeze({
  /** Read-only routing (misroute is recoverable): low bar. */
  read_only: Object.freeze({ act: 0.6, confirm: 0.4 }),
  /** Routing that consumes ops turns / quota: medium. */
  operational: Object.freeze({ act: 0.75, confirm: 0.55 }),
  /** Destructive/irreversible: high bar (~0.85) and even the act band
   *  carries a human confirm (pause-and-ask; Jev triages, never verdicts). */
  destructive: Object.freeze({ act: 0.85, confirm: 0.7, requireConfirmOnAct: true }),
});

/** Resolve the OpenRouter key: env first, then the factory keychain slot (macOS). */
async function resolveKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const { execFileSync } = await import('node:child_process');
  try {
    return execFileSync('security', [
      'find-generic-password', '-s', 'omnigent', '-a', 'openrouter', '-w',
    ], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('no OpenRouter key: set OPENROUTER_API_KEY or provision keychain omnigent/openrouter');
  }
}

/**
 * Validate question objects against the live-verified endpoint schema
 * (missing instructions / wrong criteria type = 400 Zod) and the lane's
 * encoding of the jaggedness rules that are mechanically checkable.
 */
export function validateQuestions(questions) {
  const entries = Object.entries(questions ?? {});
  if (entries.length === 0) throw new Error('questions must carry at least one question');
  for (const [id, q] of entries) {
    if (!q?.type) throw new Error(`question ${id}: missing type`);
    if (!q.instructions) throw new Error(`question ${id}: missing instructions`);
    if (q.type === 'choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) throw new Error(`question ${id}: choice needs options[]`);
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria))
        throw new Error(`question ${id}: choice criteria must be a per-option record`);
      const missing = q.options.filter((o) => !(o in q.criteria));
      if (missing.length) throw new Error(`question ${id}: criteria missing for option(s): ${missing.join(', ')}`);
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2)
        throw new Error(`question ${id}: score criteria must be an ordered rubric array`);
    } else if (q.type !== 'noul') {
      throw new Error(`question ${id}: unknown type ${q.type} (noul|choice|score)`);
    }
  }
  // C. batching economics: one call per question set; single-question calls
  // are ~12x more expensive per answer (cookbooks/parallel_questions.md).
  if (entries.length === 1) {
    console.warn('[decisions] single-question call: batching N questions into one call is ~12.2x cheaper and ~10x faster (docs.typesafe.ai/cookbooks/parallel_questions.md)');
  }
}

/**
 * A. The semantically valid gate metric for one answer. Noul → probability;
 * Choice/Score → confidence. Exposing BOTH (never collapsing) is the
 * caller's right via the answer object itself; this returns only the field
 * that is VALID to threshold on for that answer type.
 */
export function decisionMetric(answer) {
  if (answer?.type === 'noul') return { metric: answer.noul, metricKind: 'probability' };
  if (answer?.type === 'choice' || answer?.type === 'score') {
    if (typeof answer.confidence !== 'number') throw new Error(`${answer.type} answer missing confidence`);
    return { metric: answer.confidence, metricKind: 'confidence' };
  }
  throw new Error(`unknown answer type: ${answer?.type}`);
}

/**
 * A. Three-path routing (confidence.md + confidence-routing.md):
 *   high  → 'act'      (automatic; destructive still carries confirm)
 *   medium→ 'confirm'  (flag / ask a human / gather more)
 *   low   → 'fallback' (deterministic default — the seam's fail-open path)
 * B. Takes exactly ONE answer: no cross-question composition here, ever.
 */
export function routeDecision(answer, thresholds = RISK_CLASSES.read_only) {
  const { metric, metricKind } = decisionMetric(answer);
  let path;
  if (metric >= thresholds.act) path = 'act';
  else if (metric >= thresholds.confirm) path = 'confirm';
  else path = 'fallback';
  const requiresConfirm =
    path === 'confirm' || (path === 'act' && thresholds.requireConfirmOnAct === true);
  return { path, metric, metricKind, requiresConfirm };
}

/**
 * One BATCHED decisions call (C: the default shape — all questions ride in
 * a single request). Returns { model, answers, usage, latencyMs, raw }.
 * Throws on HTTP/validation error; callers fall back to deterministic
 * defaults (fail-open, per the config sketch).
 */
export async function decide({ state, questions, model = DEFAULT_MODEL, endpoint = DEFAULT_ENDPOINT, timeoutMs = 5000, key }) {
  validateQuestions(questions);
  const apiKey = key ?? (await resolveKey());
  const body = JSON.stringify({ model, state, questions });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/mssoka/gru-command',
        'X-Title': 'gru-command-jev-pilot',
      },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`decisions HTTP ${res.status}: ${text.slice(0, 400)}`);
    const raw = JSON.parse(text);
    return {
      model: raw.model,
      answers: raw.answers,
      usage: raw.usage, // { input_tokens, output_tokens, cost }
      latencyMs: Math.round(performance.now() - t0),
      raw,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The access-gate probe payload (Play A shape; receipted in evidence/).
 *  Three questions batched in ONE call — the client's default shape. */
export const DEMO = {
  state: 'Orchestrator health probe: minion pane replied to a 1-word liveness probe with: OK — I am here and working! (probe exit code 0, model id glm-5.3, last 3 dispatch outcomes: ok / ok / ok)',
  questions: {
    provider_alive: {
      type: 'noul',
      instructions: 'Classify the probe outcome',
      criteria: { true: 'The provider responded and can serve requests', false: 'The provider failed, refused, or cannot serve requests' },
    },
    read_class: {
      type: 'choice',
      instructions: 'Classify the probe reply text into exactly one class',
      options: ['clean_ok', 'chatty_ok', 'quota_403_monthly', 'quota_403_5h', 'balance_402', 'burst_1302', 'wall_1308', 'network_error'],
      criteria: {
        clean_ok: 'A bare OK or minimal acknowledgement, nothing more',
        chatty_ok: 'A clearly-alive reply with extra words, emojis or enthusiasm',
        quota_403_monthly: 'HTTP 403 wording indicating a monthly quota is exhausted',
        quota_403_5h: 'HTTP 403 wording indicating a 5-hour window quota is exhausted',
        balance_402: 'HTTP 402 payment-required / insufficient balance wording',
        burst_1302: 'HTTP 1302 burst/short-window rate limit wording',
        wall_1308: 'HTTP 1308 hard cap / quota wall wording',
        network_error: 'Connection failure, timeout or DNS error instead of a reply',
      },
    },
    severity: {
      type: 'score',
      instructions: 'How severe is this probe outcome for orchestration routing',
      criteria: ['low: routine probe, no action needed', 'high: provider dead or misrouted; action required now'],
    },
  },
};

if (process.argv[1].endsWith('decisions-client.mjs') && process.argv.includes('--demo')) {
  decide(DEMO)
    .then((r) => {
      const routes = {};
      for (const [id, a] of Object.entries(r.answers)) {
        routes[id] = routeDecision(a, RISK_CLASSES.operational); // probe reads gate routing: operational risk
      }
      console.log(JSON.stringify({ ...r, routes }, null, 2));
      console.error(`\nserved=${r.model}  latency=${r.latencyMs}ms  cost=$${r.usage.cost}`);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
