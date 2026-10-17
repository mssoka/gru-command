import { DEFAULT_DECISIONS_CONFIG, type DecisionsConfig } from '../config.js';
import { tomlString } from '../config-reference.js';

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

const DEFAULT_SURFACES = ['event_triage', 'supervision_guidance', 'escalation_triage', 'same_blocker'] as const;

function tableKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
}

/** Fresh installs (and re-runs over a config that never configured Jev)
 * start every surface in shadow. A config that already enabled Jev or named
 * surfaces keeps exactly its own entries: an absent mode is the legacy
 * pre-#223 behavior and must not silently become shadow. */
function surfaceLines(prior: DecisionsConfig | null): string[] {
  const configured = prior !== null && (prior.jev.enabled || Object.keys(prior.surfaces).length > 0);
  const surfaces: Readonly<Record<string, { readonly provider?: string; readonly mode?: string }>> = configured
    ? prior.surfaces
    : Object.fromEntries(DEFAULT_SURFACES.map((name) => [name, { provider: 'openrouter-jev', mode: 'shadow' }]));
  return Object.entries(surfaces).flatMap(([name, surface]) => [
    `[decisions.surfaces.${tableKey(name)}]`,
    ...(surface.provider === undefined ? [] : [`provider = ${tomlString(surface.provider)}`]),
    ...(surface.mode === undefined ? [] : [`mode = ${tomlString(surface.mode)}`]),
    '',
  ]);
}

/** Operator-defined profiles survive a regenerate as active tables. */
function providerLines(prior: DecisionsConfig | null): string[] {
  return Object.entries(prior?.providers ?? {}).flatMap(([name, profile]) => [
    '',
    `[decisions.providers.${tableKey(name)}]`,
    `protocol = ${tomlString(profile.protocol)}`,
    `endpoint = ${tomlString(profile.endpoint)}`,
    `model = ${tomlString(profile.model)}`,
    `credential = ${tomlString(profile.credential)}`,
    `timeout_ms = ${profile.timeoutMs}`,
    `input_price_per_mtok = ${profile.inputPricePerMtok}`,
  ]);
}

/** Complete installer-owned append fragment; every supported key is taught here. */
export function decisionsConfigTemplate(enabled = false, prior?: DecisionsConfig | null): string {
  const defaults = prior ?? DEFAULT_DECISIONS_CONFIG;
  const enabledValue = prior?.jev.enabled ?? enabled;
  return [
    '# ── Jev decisions (optional) ─────────────────────────────────────────',
    '# Jev is a small, cheap "System One" decision model (TypeSafe, via OpenRouter).',
    '# Gru Command runs fully without it: with Jev off, deterministic code makes',
    '# every decision and no provider is ever contacted.',
    '#',
    '# Credentials never belong in TOML. Store the OpenRouter key from stdin with:',
    '#   pbpaste | node dist/decisions/cli.js credentials set --stdin           # macOS clipboard',
    '#   node dist/decisions/cli.js credentials set --slot typesafe --stdin     # TypeSafe direct',
    '# then verify (no key material printed):',
    '#   node dist/decisions/cli.js status --json   and   node dist/decisions/cli.js check --json',
    '[decisions.jev]',
    `enabled = ${bool(enabledValue)} # MASTER SWITCH. Off = no surface ever asks a provider. Hot-reloads; store the key first.`,
    `model = "${defaults.jev.model}" # OpenRouter Jev alias; feeds the openrouter-jev profile below.`,
    `endpoint = "${defaults.jev.endpoint}" # Credential-bearing traffic is restricted to this exact HTTPS endpoint.`,
    `timeout_ms = ${defaults.jev.timeoutMs} # Per-call limit; on timeout the deterministic answer is used. Raise it if timeouts recur on a healthy network.`,
    '',
    '# ── Surface modes: how each decision point uses Jev ──────────────────',
    '# With the master switch on, every [decisions.surfaces.<surface>] picks a mode:',
    '#',
    '#   mode = "off"      Deterministic only. Jev is never asked; zero cost.',
    '#   mode = "shadow"   Jev IS asked and its answer is recorded next to the',
    '#                     deterministic one (ledger event decisions.shadow), but',
    '#                     Gru Command always USES the deterministic answer:',
    '#                     behavior cannot change. START HERE. A single slow or',
    '#                     failed ask is recorded, not an incident; 3 in a row',
    '#                     mark Jev degraded (a board FYI while every acting',
    '#                     surface is shadow/off) with automatic rechecks.',
    '#   mode = "enforce"  Gru Command USES Jev\'s answer (deterministic fallback on',
    '#                     failure or low confidence). Refuses to run until a',
    '#                     recorded backtest meets its threshold, saved at',
    '#                     <data_dir>/decisions/backtests/<surface>.json by:',
    '#                       node dist/decisions/cli.js extract-cases --surface <s> --out <jsonl>',
    '#                       node dist/decisions/cli.js backtest --surface <s> --profile <p> --cases <jsonl> --threshold <min> --save',
    '#   (no mode key)     Legacy, pre-#223: for event_triage and supervision_guidance',
    '#                     Gru Command USES Jev\'s answer with NO backtest gate.',
    '#                     Keep those two listed explicitly (as below) unless you',
    '#                     mean that.',
    '#',
    '# Surfaces:',
    '#   event_triage          does an orchestration event need attention? (may only raise attention, never lower it)',
    '#   supervision_guidance  classifies a runtime failure: restart vs escalate (restart counters stay deterministic)',
    '#   escalation_triage     is a Silas escalation a ruling or a status report? (shadow only today)',
    '#   same_blocker          is this review blocker the same defect as last round? (shadow only today)',
    '#   report_conclusion     clean pass / findings / inconclusive (backtest only; no live host yet)',
    '#',
    '# `provider` routes a surface to a provider profile (default: openrouter-jev).',
    '# Shorthand for routing only:  [decisions.surfaces]  event_triage = "typesafe-direct"',
    ...surfaceLines(prior ?? null),
    '# ── Provider profiles (optional) ─────────────────────────────────────',
    '# Built-ins always exist: openrouter-jev (default), typesafe-direct and local.',
    '# Override one by re-declaring it, or define your own under a new name.',
    '# Probe any of them (master switch on) with:',
    '#   node dist/decisions/cli.js check --profile <name>',
    '# [decisions.providers.typesafe-direct]',
    '# protocol = "systemone"',
    '# endpoint = "https://api.typesafe.ai/v1/systemone"',
    '# model = "jev-latest"',
    '# credential = "typesafe" # env TYPESAFE_API_KEY or credentials/typesafe.key; bound to api.typesafe.ai',
    '# timeout_ms = 5000',
    '# input_price_per_mtok = 0.042 # cost fallback when a response carries no usage.cost',
    '#',
    '# [decisions.providers.local]',
    '# protocol = "systemone"',
    '# endpoint = "http://127.0.0.1:8088/v1/systemone"',
    '# model = "laya-421m"',
    '# credential = "none" # keyless is allowed ONLY for loopback hosts',
    '# timeout_ms = 5000',
    ...providerLines(prior ?? null),
    '',
    '# ── Confidence thresholds (by risk class) ────────────────────────────',
    '# Read-only classification: mistakes are recoverable, so confidence bars are lower.',
    '[decisions.thresholds.read_only]',
    `act = ${defaults.thresholds.read_only.act} # metric >= act enters the high band.`,
    `confirm = ${defaults.thresholds.read_only.confirm} # confirm <= metric < act flags for confirmation.`,
    `require_confirm_on_act = ${bool(defaults.thresholds.read_only.requireConfirmOnAct)} # High read-only routes need no added confirmation.`,
    '',
    '# Operational routing can spend turns/quota or alter restart guidance.',
    '[decisions.thresholds.operational]',
    `act = ${defaults.thresholds.operational.act} # High-confidence operational guidance is eligible within existing authority.`,
    `confirm = ${defaults.thresholds.operational.confirm} # Medium confidence flags; below this uses deterministic fallback.`,
    `require_confirm_on_act = ${bool(defaults.thresholds.operational.requireConfirmOnAct)} # Existing operational guards still apply.`,
    '',
    '# Destructive routing never grants permission: every passable band still requires a human.',
    '[decisions.thresholds.destructive]',
    `act = ${defaults.thresholds.destructive.act} # High bar for destructive triage.`,
    `confirm = ${defaults.thresholds.destructive.confirm} # Medium band pauses/asks; below uses deterministic fallback.`,
    `require_confirm_on_act = ${bool(defaults.thresholds.destructive.requireConfirmOnAct)} # Must stay true; config validation rejects false.`,
    '',
  ].join('\n');
}
