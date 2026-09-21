import { DEFAULT_DECISIONS_CONFIG } from '../config.js';

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

/** Complete installer-owned append fragment; every supported key is taught here. */
export function decisionsConfigTemplate(enabled = false): string {
  const defaults = DEFAULT_DECISIONS_CONFIG;
  return [
    '# Optional Jev decision routing. Default OFF: deterministic behavior, zero decision requests.',
    '# Credentials never belong in TOML. Store locally with:',
    '#   node dist/decisions/cli.js credentials set --stdin',
    '[decisions.jev]',
    `enabled = ${bool(enabled)} # One reversible flag. false never resolves credentials or contacts the provider.`,
    `model = "${defaults.jev.model}" # OpenRouter Jev alias; served-model provenance remains visible.`,
    `endpoint = "${defaults.jev.endpoint}" # Credential-bearing traffic is restricted to this exact HTTPS endpoint.`,
    `timeout_ms = ${defaults.jev.timeoutMs} # Per-call hard limit; timeout falls back deterministically.`,
    '',
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
