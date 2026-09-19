#!/usr/bin/env node
/* global process, console, fetch, setTimeout, clearTimeout, performance, AbortController, URL */
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
 *    validateQuestions + routeDecision(single answer, explicit risk class).
 * C. BATCHING: parallel questions in ONE call are ~12x cheaper — the
 *    client's default shape is the batched QuestionSet; single-question
 *    calls warn.
 *
 * Usage:
 *   node tools/jev-pilot/decisions-client.mjs --demo   # re-run access probe (~$0.00003)
 *   node --test tools/jev-pilot/decisions-client.test.mjs   # offline interface tests (file-path form;
 *                                                          # the directory form MODULE_NOT_FOUNDs on Node 22)
 *   import { decide, routeDecision, RISK_CLASSES } from './decisions-client.mjs'
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = '~typesafe/jev-latest'; // user-confirmed slug; resolves to the pinned jev-1.13 snapshot
const DEFAULT_TIMEOUT_MS = 2000; // aligned with the fold-in sketch's timeout_ms (the authoritative figure)

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
  { id: 'atomic-questions', rule: 'One gut-check judgment per question; decompose multi-factor judgments and combine in code.', source: 'model-jaggedness/jev-1.13.md (reminders: "hiding several judgments inside one question")' },
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

/**
 * Resolve the OpenRouter key: env first, then the factory keychain slot
 * (macOS). `exec` is injectable for offline tests of the precedence chain.
 */
export async function resolveKey(exec) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const run = exec ?? (async () => {
    const { execFileSync } = await import('node:child_process');
    return execFileSync('security', [
      'find-generic-password', '-s', 'omnigent', '-a', 'openrouter', '-w',
    ], { encoding: 'utf8' }).trim();
  })();
  try {
    const k = await run();
    const trimmed = typeof k === 'string' ? k.trim() : '';
    if (trimmed.length > 0) return trimmed;
    throw new Error('empty');
  } catch {
    throw new Error('no OpenRouter key: set OPENROUTER_API_KEY or provision keychain omnigent/openrouter');
  }
}

/**
 * The auto-resolved keychain key is only ever sent to OpenRouter: a caller
 * cannot point the factory credential at an arbitrary endpoint. Explicitly
 * caller-supplied keys (`key` param) may target anything (tests, proxies).
 */
function assertEndpointAllowed(endpoint, autoResolvedKey) {
  if (!autoResolvedKey) return;
  let host = '';
  try { host = new URL(endpoint).hostname; } catch { throw new Error(`invalid endpoint URL: ${endpoint}`); }
  if (host !== 'openrouter.ai' && !host.endsWith('.openrouter.ai')) {
    throw new Error('auto-resolved key is endpoint-restricted to openrouter.ai; pass an explicit key for other endpoints');
  }
}

/**
 * Validate question objects against the live-verified endpoint schema
 * (missing instructions / wrong criteria type = 400 Zod) and the lane's
 * encoding of the jaggedness rules that are mechanically checkable.
 */
export function validateQuestions(questions) {
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new Error('questions must be a record of question objects (the endpoint schema is a record, not an array)');
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new Error('questions must carry at least one question');
  for (const [id, q] of entries) {
    if (!q?.type) throw new Error(`question ${id}: missing type`);
    if (!q.instructions) throw new Error(`question ${id}: missing instructions`);
    if (q.type === 'choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) throw new Error(`question ${id}: choice needs options[]`);
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria))
        throw new Error(`question ${id}: choice criteria must be a per-option record`);
      const missing = q.options.filter((o) => !Object.hasOwn(q.criteria, o));
      if (missing.length) throw new Error(`question ${id}: criteria missing for option(s): ${missing.join(', ')}`);
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2)
        throw new Error(`question ${id}: score criteria must be an ordered rubric array`);
    } else if (q.type === 'noul') {
      // noul criteria are OPTIONAL (our 200 receipt sent noul without) — but
      // if present they must be a record of descriptions, not an array.
      if (q.criteria !== undefined && (typeof q.criteria !== 'object' || Array.isArray(q.criteria)))
        throw new Error(`question ${id}: noul criteria must be a record (e.g. {true: "...", false: "..."})`);
    } else {
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
 * that is VALID to threshold on for that answer type. Both fields are
 * guarded: a malformed answer is loud, never silently routed.
 */
export function decisionMetric(answer) {
  if (answer?.type === 'noul') {
    if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
      throw new Error('noul answer missing finite probability (noul field)');
    }
    return { metric: answer.noul, metricKind: 'probability' };
  }
  if (answer?.type === 'choice' || answer?.type === 'score') {
    if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) {
      throw new Error(`${answer.type} answer missing finite confidence`);
    }
    return { metric: answer.confidence, metricKind: 'confidence' };
  }
  throw new Error(`unknown answer type: ${answer?.type}`);
}

/** Validate a risk-class threshold table: bad config must be loud, never silent. */
export function validateThresholds(t) {
  if (!t || typeof t !== 'object') throw new Error('thresholds object required (pick an explicit RISK_CLASSES entry — risk class is not optional)');
  for (const f of ['act', 'confirm']) {
    if (typeof t[f] !== 'number' || !Number.isFinite(t[f])) throw new Error(`thresholds.${f} must be a finite number`);
  }
  if (!(t.confirm < t.act)) throw new Error(`thresholds inverted: confirm (${t.confirm}) must be < act (${t.act})`);
}

/**
 * A. Three-path routing (confidence.md + confidence-routing.md):
 *   high  → 'act'      (automatic; destructive still carries confirm)
 *   medium→ 'confirm'  (flag / ask a human / gather more)
 *   low   → 'fallback' (deterministic default — the seam's fail-open path)
 * B. Takes exactly ONE answer and an EXPLICIT risk class: no cross-question
 * composition, and no silent default to the loosest thresholds (N26) —
 * omitting the class is a programmer error and throws.
 */
export function routeDecision(answer, thresholds) {
  validateThresholds(thresholds);
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
 * Validate the response envelope before it flows to callers: a 200 without
 * answers for EVERY asked question id is a contract break, not an empty
 * result. Returns the answers record.
 */
function requireAnswers(raw, questions) {
  if (!raw || typeof raw !== 'object' || !raw.answers || typeof raw.answers !== 'object') {
    throw new Error('response envelope invalid: missing answers object');
  }
  const asked = Object.keys(questions);
  const missing = asked.filter((id) => !Object.hasOwn(raw.answers, id));
  if (missing.length) throw new Error(`response envelope invalid: no answer for question(s): ${missing.join(', ')}`);
  return raw.answers;
}

/**
 * One BATCHED decisions call (C: the default shape — all questions ride in
 * a single request). Returns { model, answers, usage, latencyMs, raw }.
 * Throws on HTTP/validation/envelope error; callers fall back to
 * deterministic defaults (fail-open, per the config sketch).
 */
export async function decide({ state, questions, model = DEFAULT_MODEL, endpoint = DEFAULT_ENDPOINT, timeoutMs = DEFAULT_TIMEOUT_MS, key }) {
  if (typeof state !== 'string' || state.length === 0) {
    throw new Error('state must be a non-empty string (filter it first — context rot, jaggedness #5)');
  }
  validateQuestions(questions);
  const explicitKey = typeof key === 'string' && key.length > 0;
  const apiKey = explicitKey ? key : await resolveKey();
  assertEndpointAllowed(endpoint, !explicitKey);
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
    requireAnswers(raw, questions);
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

const invokedDirectly = process.argv[1]
  && process.argv.includes('--demo')
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
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
