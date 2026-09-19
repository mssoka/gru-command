#!/usr/bin/env node
/**
 * Minimal Jev decisions client — Pilot 1 lane residue (gru-command-jev-pilot).
 *
 * Zero-dependency Node >= 18 client for the OpenRouter /api/alpha/decisions
 * endpoint (user-confirmed shape, 2026-09-19; independently verified by the
 * lane's access receipts — see evidence/access-probe.json).
 *
 * NOT wired into gru-command: this is pilot tooling only. The fold-in (a
 * Jev-backed DecisionService behind config, default-off) is its own scheduled
 * change — see config-flag-schema-sketch.md for the seam sketch.
 *
 * Question schema (verified live):
 *   noul   { type: "noul",   instructions, criteria: { true, false } }
 *          → answers[q].noul = probability of `true`
 *   choice { type: "choice", instructions, options: [...], criteria: { per-option } }
 *          → answers[q].choice = pick, .probabilities = per-option, .confidence
 *   score  { type: "score",  instructions, criteria: [ ordered rubric levels ] }
 *          → answers[q].score = level index, .probabilities, .confidence
 *
 * Usage:
 *   node tools/jev-pilot/decisions-client.mjs --demo     # re-run the access
 *                                                       # probe (costs ~$0.00003)
 *   import { decide } from './decisions-client.mjs'      # library use
 */

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = '~typesafe/jev-latest'; // user-confirmed slug; resolves to the current jev-1.13 snapshot

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
 * Validate question objects against the live-verified schema before spending
 * a call — the endpoint's Zod layer rejects anything missing instructions or
 * with the wrong criteria type (choice → record, score → array).
 */
export function validateQuestions(questions) {
  for (const [id, q] of Object.entries(questions ?? {})) {
    if (!q?.type) throw new Error(`question ${id}: missing type`);
    if (!q.instructions) throw new Error(`question ${id}: missing instructions`);
    if (q.type === 'choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) throw new Error(`question ${id}: choice needs options[]`);
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria))
        throw new Error(`question ${id}: choice criteria must be a per-option record`);
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2)
        throw new Error(`question ${id}: score criteria must be an ordered rubric array`);
    } else if (q.type !== 'noul') {
      throw new Error(`question ${id}: unknown type ${q.type} (noul|choice|score)`);
    }
  }
}

/**
 * One decisions call. Returns { model, answers, usage, latencyMs, raw }.
 * Throws on HTTP error (callers fall back to deterministic defaults — the
 * fail-open behavior the config sketch specifies for the fold-in).
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

/** The access-gate probe payload (Play A shape; receipted in evidence/). */
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
      console.log(JSON.stringify(r, null, 2));
      console.error(`\nserved=${r.model}  latency=${r.latencyMs}ms  cost=$${r.usage.cost}`);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
