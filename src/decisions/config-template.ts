import {
  DEFAULT_DECISION_PROFILE,
  DEFAULT_DECISIONS_CONFIG,
  tomlString,
  type DecisionsConfig,
  type DecisionSurfaceConfig,
} from '../config.js';
import {
  DECISION_SURFACE_ESCALATION_TRIAGE,
  DECISION_SURFACE_EVENT_TRIAGE,
  DECISION_SURFACE_SAME_BLOCKER,
  DECISION_SURFACE_SUPERVISION,
} from './questions.js';

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

/** Every live surface, listed explicitly so none rides the legacy no-mode behavior. */
const FRESH_SURFACES: Readonly<Record<string, DecisionSurfaceConfig>> = Object.fromEntries(
  [
    DECISION_SURFACE_EVENT_TRIAGE,
    DECISION_SURFACE_SUPERVISION,
    DECISION_SURFACE_ESCALATION_TRIAGE,
    DECISION_SURFACE_SAME_BLOCKER,
  ].map((name) => [name, { provider: DEFAULT_DECISION_PROFILE, mode: 'shadow' }]),
);

/** Surface and profile names are bare TOML keys: the loader only accepts
 * the `DECISION_SURFACES` names and `[A-Za-z0-9_-]+` profiles. */
function surfaceLines(surfaces: Readonly<Record<string, DecisionSurfaceConfig>>): string[] {
  return Object.entries(surfaces).flatMap(([name, surface]) => [
    `[decisions.surfaces.${name}]`,
    ...(surface.provider === undefined ? [] : [`provider = ${tomlString(surface.provider)}`]),
    ...(surface.mode === undefined ? [] : [`mode = ${tomlString(surface.mode)}`]),
    '',
  ]);
}

function providerLines(providers: DecisionsConfig['providers']): string[] {
  return Object.entries(providers).flatMap(([name, profile]) => [
    '',
    `[decisions.providers.${name}]`,
    `protocol = ${tomlString(profile.protocol)}`,
    `endpoint = ${tomlString(profile.endpoint)}`,
    `model = ${tomlString(profile.model)}`,
    `credential = ${tomlString(profile.credential)}`,
    `timeout_ms = ${profile.timeoutMs}`,
    `input_price_per_mtok = ${profile.inputPricePerMtok}`,
  ]);
}

/** Complete installer-owned fragment for a fresh config; every supported key is taught here. */
export function decisionsConfigTemplate(enabled = false): string {
  const config = { ...DEFAULT_DECISIONS_CONFIG, jev: { ...DEFAULT_DECISIONS_CONFIG.jev, enabled } };
  return renderDecisions(config, FRESH_SURFACES);
}

/**
 * The fragment for a regenerated config: every value comes from `prior`, the
 * loaded config. A config that enabled Jev or named surfaces keeps exactly its
 * own surface entries, because an absent mode is the legacy pre-#223 behavior
 * and must not silently become shadow. A config with Jev off and no surfaces
 * (every config written before the fragment shipped, or one switched off
 * after legacy use) has no surface behavior to keep, so it gets the fresh
 * shadow entries: turning Jev on later only records, never acts.
 */
export function decisionsConfigFor(prior: DecisionsConfig | null): string {
  if (prior === null) return decisionsConfigTemplate();
  const configured = prior.jev.enabled || Object.keys(prior.surfaces).length > 0;
  return renderDecisions(prior, configured ? prior.surfaces : FRESH_SURFACES);
}

function renderDecisions(
  config: DecisionsConfig,
  surfaces: Readonly<Record<string, DecisionSurfaceConfig>>,
): string {
  const { jev, thresholds } = config;
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
    `enabled = ${bool(jev.enabled)} # MASTER SWITCH. Off = no surface ever asks a provider. Hot-reloads; store the key first.`,
    `model = ${tomlString(jev.model)} # OpenRouter Jev alias; feeds the openrouter-jev profile below.`,
    `endpoint = ${tomlString(jev.endpoint)} # Credential-bearing traffic is restricted to this exact HTTPS endpoint.`,
    `timeout_ms = ${jev.timeoutMs} # Per-call limit; on timeout the deterministic answer is used. Raise it if timeouts recur on a healthy network.`,
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
    '#                     Not usable on any surface yet (see each one below).',
    '#                     Setting it anywhere still makes a transient (timeout,',
    '#                     network or provider-error) outage of the default',
    '#                     openrouter-jev profile page you instead of a board FYI.',
    '#   (no mode key)     Legacy, pre-#223: for event_triage and supervision_guidance',
    '#                     Gru Command USES Jev\'s answer with NO backtest gate;',
    '#                     escalation_triage, same_blocker and report_conclusion are never asked.',
    '#                     A mode-less event_triage or supervision_guidance also makes',
    '#                     a transient outage page you.',
    '#                     Give every surface an explicit mode unless you mean that.',
    '#',
    '# Surfaces (the complete list; any other name fails to load):',
    '#   event_triage          does an orchestration event need attention? (may only raise attention, never lower it)',
    '#                         off or shadow today: no registered backtest, so enforce rejects every',
    '#                         Jev ask (the deterministic answer still serves) and opens an owner incident',
    '#   supervision_guidance  classifies a runtime failure: restart vs escalate (restart counters stay deterministic)',
    '#                         a known auth or quota wall stops at once, without asking',
    '#                         off or shadow today: no registered backtest, so enforce rejects every',
    '#                         Jev ask (the deterministic answer still serves) and opens an owner incident',
    '#                         (its host asks even with the master switch off, so this incident opens then too)',
    '#   escalation_triage     is a Silas escalation a ruling or a status report?',
    '#                         off or shadow today: it asks Jev only in shadow, so enforce never asks',
    '#   same_blocker          is this review blocker the same defect as last round?',
    '#                         off or shadow today: it asks Jev only in shadow, so enforce never asks',
    '#   report_conclusion     clean pass / findings / inconclusive',
    '#                         backtest only: no live host yet, so enforce never asks',
    '#',
    '# `provider` routes a surface to a provider profile (default: openrouter-jev);',
    '# change it in the surface\'s own table.',
    ...surfaceLines(surfaces),
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
    '# input_price_per_mtok = 0 # an omitted price falls back to 0.042, not the built-in\'s 0',
    ...providerLines(config.providers),
    '',
    '# ── Confidence thresholds (by risk class) ────────────────────────────',
    '# Read-only classification: mistakes are recoverable, so confidence bars are lower.',
    '[decisions.thresholds.read_only]',
    `act = ${thresholds.read_only.act} # metric >= act enters the high band.`,
    `confirm = ${thresholds.read_only.confirm} # confirm <= metric < act flags for confirmation.`,
    `require_confirm_on_act = ${bool(thresholds.read_only.requireConfirmOnAct)} # High read-only routes need no added confirmation.`,
    '',
    '# Operational routing can spend turns/quota or alter restart guidance.',
    '[decisions.thresholds.operational]',
    `act = ${thresholds.operational.act} # High-confidence operational guidance is eligible within existing authority.`,
    `confirm = ${thresholds.operational.confirm} # Medium confidence flags; below this uses deterministic fallback.`,
    `require_confirm_on_act = ${bool(thresholds.operational.requireConfirmOnAct)} # Existing operational guards still apply.`,
    '',
    '# Destructive routing never grants permission: every passable band still requires a human.',
    '[decisions.thresholds.destructive]',
    `act = ${thresholds.destructive.act} # High bar for destructive triage.`,
    `confirm = ${thresholds.destructive.confirm} # Medium band pauses/asks; below uses deterministic fallback.`,
    `require_confirm_on_act = ${bool(thresholds.destructive.requireConfirmOnAct)} # Must stay true; config validation rejects false.`,
    '',
  ].join('\n');
}
