import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  DEFAULT_MODEL_REFRESH,
  DEFAULT_MODEL_REFRESH_TIMEOUT_MS,
  MODEL_DEFAULT_SENTINEL,
  ROLES,
  RUNTIME_IDS,
  type GruCommandConfig,
  type Role,
  type RuntimeId,
} from './config.js';

/**
 * THE single source of truth for the instance config reference.
 *
 * Three consumers render from this module so they cannot drift:
 *   1. the wizard's generated `~/.gru-command/config.toml` (config-as-docs:
 *      every documented section, every default filled in, one-line purpose
 *      comments, and inline examples),
 *   2. the generated reference block in docs/CONFIG.md
 *      (scripts/render-config-doc.mjs),
 *   3. the tests that pin the emitted file to the documented section list.
 */

/** Thinking levels accepted per runtime (docs/RUNTIMES.md). Anything else
 * fails loud at spawn naming the valid set. */
export const RUNTIME_THINKING_LEVELS: Readonly<Record<RuntimeId, readonly string[]>> = {
  pi: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
};

export const MODEL_REFERENCE_NOTE =
  'An explicit "provider/model" reference is passed to pi as-is; ' +
  'claude-code strips the provider segment for its CLI --model flag ' +
  '(bedrock-style dotted ids survive: "bedrock/us.anthropic.x" → "us.anthropic.x"). ' +
  'The literal "default" means the runtime\'s own configuration (SPEC ruling 16).';

export const ROLE_LIST_NOTE = `valid roles: ${ROLES.join(', ')}`;

export const RUNTIMES_DOC_POINTER =
  'Full per-runtime semantics (binding, session flags, effort mapping, resolution order): docs/RUNTIMES.md.';

/** Every documented section, in emission order. Root keys are bare names;
 * tables are their bracketed headers. A commented example block still
 * "contains" its header — example blocks are part of the reference. The
 * config-as-docs test pins BOTH presence and this exact order against the
 * emitted text. */
export const CONFIG_SECTION_HEADERS: readonly string[] = [
  'workspace_root',
  'data_dir',
  '[server]',
  '[auth]',
  '[runtimes]',
  '[runtimes.roles]',
  '[models]',
  '[models.roles]',
  '[thinking]',
  '[thinking.roles]',
  '[runtimes.pi]',
  '[runtimes.pi.roles]',
  '[runtimes.claude-code]',
  '[runtimes.claude-code.roles]',
  '[supervision]',
  '[logging]',
  '[chat]',
  '[worktrees]',
  '[dispatch]',
  '[silas]',
  '[review]',
  '[verify]',
];

/** Tables that must be ACTIVE (parseable) in every generated config —
 * the per-runtime blocks ship as commented examples instead. */
export const CONFIG_ACTIVE_TABLES: readonly string[] = [
  'server',
  'auth',
  'runtimes',
  'runtimes.roles',
  'models',
  'models.roles',
  'thinking',
  'thinking.roles',
  'supervision',
  'logging',
  'chat',
  'worktrees',
  'dispatch',
  'silas',
  'review',
  'verify',
];

export interface CompleteConfigValues {
  readonly instanceDir: string;
  readonly workspaceRoot: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly runtime: RuntimeId;
  readonly model: string;
  readonly thinkingLevel: string;
  readonly roles: Readonly<Partial<Record<Role, RuntimeId>>>;
  /** Operator home — ~-anchors emitted state paths for portability.
   * Defaults to the process home. */
  readonly home?: string;
}

/**
 * Re-anchor an absolute state path under the operator's home to a `~`
 * form so a restored config re-anchors to the NEW machine's home
 * (restoring a machine-specific absolute path would redirect all state
 * to the old machine — the exact bug the portability ruling prohibits).
 * Paths outside the home (explicit GRU_COMMAND_HOME setups) are emitted
 * absolute by design and documented as such.
 */
export function portableStatePath(path: string, home: string = homedir()): string {
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/** Escape a string for a TOML basic string literal. */
export function tomlString(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\b': out += '\\b'; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\f': out += '\\f'; break;
      case '\r': out += '\\r'; break;
      default:
        if (ch < ' ' || ch === '\u007f') {
          out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
    }
  }
  return `"${out}"`;
}

const inlineTableExample = (model: string): string =>
  `{ model = ${tomlString(model)}, thinking_level = "low" }`;

function runtimePolicyLines(
  runtime: RuntimeId,
  policy: GruCommandConfig['runtimes']['policies'][RuntimeId] | undefined,
  active: boolean,
): string[] {
  const c = active ? '' : '# ';
  const model = policy?.model;
  const thinking = policy?.thinkingLevel;
  const lines: string[] = [];
  lines.push(
    `${c}[runtimes.${runtime}]`,
    `${c}# Optional runtime-wide policy; omitted keys inherit [models]/[thinking].`,
    `${c}# Thinking levels accepted: ${RUNTIME_THINKING_LEVELS[runtime].join(' | ')}` +
      (runtime === 'claude-code'
        ? ' (mapped to the CLI --effort; anything else fails loud at spawn naming the valid set).'
        : '.'),
    `${c}# ${MODEL_REFERENCE_NOTE}`,
    `${c}# ${RUNTIMES_DOC_POINTER}`,
  );
  if (model !== undefined) lines.push(`${c}model = ${tomlString(model)}`);
  else lines.push(`${c}# model = ${tomlString(MODEL_DEFAULT_SENTINEL)}`);
  if (thinking !== undefined) lines.push(`${c}thinking_level = ${tomlString(thinking)}`);
  else lines.push(`${c}# thinking_level = ${tomlString(MODEL_DEFAULT_SENTINEL)}`);
  if (runtime === 'pi') {
    const refresh = policy?.modelRefresh;
    const refreshTimeout = policy?.modelRefreshTimeoutMs;
    lines.push(
      `${c}# On an unknown model, allow ONE bounded network catalog refresh before`,
      `${c}# failing; set false for a strictly offline catalog.`,
    );
    lines.push(
      refresh === undefined
        ? `${c}# model_refresh = ${DEFAULT_MODEL_REFRESH}`
        : `${c}model_refresh = ${refresh}`,
    );
    lines.push(
      refreshTimeout === undefined
        ? `${c}# model_refresh_timeout_ms = ${DEFAULT_MODEL_REFRESH_TIMEOUT_MS}`
        : `${c}model_refresh_timeout_ms = ${refreshTimeout}`,
    );
  }
  lines.push('', `${c}[runtimes.${runtime}.roles]`);
  lines.push(
    `${c}# Optional per-role inline tables (at least one field when uncommented).`,
    `${c}# Example: minion = ${inlineTableExample(model ?? MODEL_DEFAULT_SENTINEL)}`,
  );
  for (const role of ROLES) {
    const entry = policy?.roles[role];
    if (entry === undefined) {
      lines.push(`${c}# ${role} = ${inlineTableExample(MODEL_DEFAULT_SENTINEL)}`);
      continue;
    }
    const fields: string[] = [];
    if (entry.model !== undefined) fields.push(`model = ${tomlString(entry.model)}`);
    if (entry.thinkingLevel !== undefined) {
      fields.push(`thinking_level = ${tomlString(entry.thinkingLevel)}`);
    }
    lines.push(`${c}${role} = { ${fields.join(', ')} }`);
  }
  return lines;
}

/**
 * Render the complete config-as-reference. Values that have a concrete
 * runtime default are active; optional override keys ship as teaching
 * comments/examples because activating a placeholder would change
 * precedence. When `preserved` (the previously loaded, schema-valid
 * config) is given, every user-set value outside the wizard's prompts is
 * re-emitted ACTIVE — a re-run never silently drops user configuration.
 */
export function renderReferenceConfig(
  values: CompleteConfigValues,
  preserved?: GruCommandConfig | null,
): string {
  const lines: string[] = [
    '# Gru Command configuration.',
    '# This is the live file read from <instance>/config.toml — and it doubles',
    '# as the reference: every documented section is present with its default',
    '# and a one-line purpose comment. ' + RUNTIMES_DOC_POINTER,
    '# Edit values in place, then restart only your Gru Command service.',
    '',
    '# Root: the directory containing only managed project repositories.',
    `workspace_root = ${tomlString(values.workspaceRoot)}`,
    '# Root: per-instance state. ~-anchored so a restored config re-anchors to',
    '# the NEW machine\'s home — an absolute machine-specific path would',
    '# redirect all state to the old machine on restore. Explicit',
    '# GRU_COMMAND_HOME setups emit their exact absolute dir by design.',
    `data_dir = ${tomlString(
      portableStatePath(preserved?.dataDir ?? values.instanceDir, values.home),
    )}`,
    '',
    '[server]',
    '# Bind address. Loopback is safest; use a LAN address (or 0.0.0.0 for all',
    '# interfaces) only on a trusted LAN. v1 has no TLS.',
    `host = ${tomlString(values.host)}`,
    '# Listen port; 0 chooses an ephemeral port. Integer 0–65535.',
    `port = ${values.port}`,
    '',
    '[auth]',
    '# Pairing token for authenticated browser/WebSocket access. Keep this file private.',
    `token = ${tomlString(values.token)}`,
    '',
    '[runtimes]',
    '# Session host runtime: "pi" or "claude-code".',
    `default = ${tomlString(values.runtime)}`,
    '',
    '[runtimes.roles]',
    `# Optional per-role runtime overrides (${ROLE_LIST_NOTE});`,
    '# omitted roles inherit runtimes.default.',
  ];
  const mergedRuntimeRoles: Partial<Record<Role, RuntimeId>> = {
    ...preserved?.runtimes.roles,
  };
  for (const role of ROLES) {
    if (values.roles[role] !== undefined) mergedRuntimeRoles[role] = values.roles[role];
  }
  for (const role of ROLES) {
    const selected = mergedRuntimeRoles[role];
    lines.push(
      selected === undefined
        ? `# ${role} = ${tomlString(values.runtime)}`
        : `${role} = ${tomlString(selected)}`,
    );
  }

  lines.push(
    '',
    '[models]',
    `# Default model reference. ${MODEL_REFERENCE_NOTE}`,
    `default = ${tomlString(values.model)}`,
    '',
    '[models.roles]',
    `# Optional per-role model overrides (${ROLE_LIST_NOTE});`,
    '# "default" means the runtime\'s own for that role. Per-runtime',
    '# inline-table overrides live under [runtimes.<id>.roles].',
  );
  for (const role of ROLES) {
    const override = preserved?.models.roles[role];
    lines.push(
      override === undefined
        ? `# ${role} = ${tomlString(MODEL_DEFAULT_SENTINEL)}`
        : `${role} = ${tomlString(override)}`,
    );
  }

  lines.push(
    '',
    '[thinking]',
    '# Default thinking level. "default" delegates to the runtime; explicit',
    `# levels are runtime-specific (${RUNTIME_IDS.map(
      (id) => `${id}: ${RUNTIME_THINKING_LEVELS[id].join('/')}`,
    ).join('; ')}).`,
    `default = ${tomlString(values.thinkingLevel)}`,
    '',
    '[thinking.roles]',
    `# Optional per-role thinking overrides (${ROLE_LIST_NOTE}); per-runtime`,
    '# inline-table overrides live under [runtimes.<id>.roles].',
  );
  for (const role of ROLES) {
    const override = preserved?.thinking.roles[role];
    lines.push(
      override === undefined
        ? `# ${role} = ${tomlString(MODEL_DEFAULT_SENTINEL)}`
        : `${role} = ${tomlString(override)}`,
    );
  }

  for (const runtime of RUNTIME_IDS) {
    const policy = preserved?.runtimes.policies[runtime];
    lines.push('', ...runtimePolicyLines(runtime, policy, policy !== undefined));
  }

  const supervision = preserved?.supervision ?? {
    enabled: true,
    turnSilenceMs: 900_000,
    restartWindowMs: 600_000,
    maxRestarts: 3,
    restartBackoffMs: 2_000,
  };
  lines.push(
    '',
    '[supervision]',
    '# Agent watchdog and crash-loop breaker (see SUPERVISION.md).',
    `enabled = ${supervision.enabled}`,
    `# Open turn with no runtime event, no session growth, and no live tool = hung.`,
    `turn_silence_ms = ${supervision.turnSilenceMs}`,
    `# >= max_restarts within this rolling window trips the breaker.`,
    `restart_window_ms = ${supervision.restartWindowMs}`,
    `max_restarts = ${supervision.maxRestarts}`,
    `# Backoff base between failed restart rungs (doubles, capped at 60s).`,
    `restart_backoff_ms = ${supervision.restartBackoffMs}`,
    '',
    '[logging]',
    '# service.log size-based rotation.',
    `max_bytes = ${preserved?.logging.maxBytes ?? 10_485_760}`,
    `keep = ${preserved?.logging.keep ?? 5}`,
    '',
    '[chat]',
    '# gru.frames.jsonl rotation; reconnect replay spans retained shards.',
    `frame_log_max_bytes = ${preserved?.chat.frameLogMaxBytes ?? 8_388_608}`,
    `frame_log_keep = ${preserved?.chat.frameLogKeep ?? 3}`,
    '# Gru awareness wake policy. "never" (default) injects action-required',
    '# escalations and a compact ledger digest into the NEXT Gru turn passively',
    '# — no model turn runs by itself, so it adds no turn cost. Wake modes',
    '# start a Gru turn when a notification lands: "action-required" only for',
    '# action-required notifications; "all" for every notification (FYI',
    '# included). Each wake is a full model turn (provider tokens + latency),',
    '# so it costs whenever the lane is noisy. Wakes never acknowledge',
    '# anything: the human still holds every ack.',
    `notify_wake = ${tomlString(preserved?.chat.notifyWake ?? 'never')}`,
    '',
    '[worktrees]',
    '# Job/review worktree roots follow data_dir by default; uncomment only to relocate.',
  );
  const worktrees = preserved?.worktrees;
  const dataDir = preserved?.dataDir ?? values.instanceDir;
  const defaultRoot = join(dataDir, 'worktrees');
  const defaultPreserveRoot = join(dataDir, 'worktree-preserves');
  if (worktrees !== undefined && worktrees.root !== resolve(defaultRoot)) {
    lines.push(`root = ${tomlString(worktrees.root)}`);
  } else {
    lines.push(`# root = ${tomlString(defaultRoot)}`);
  }
  if (worktrees !== undefined && worktrees.preserveRoot !== resolve(defaultPreserveRoot)) {
    lines.push(`preserve_root = ${tomlString(worktrees.preserveRoot)}`);
  } else {
    lines.push(`# preserve_root = ${tomlString(defaultPreserveRoot)}`);
  }
  lines.push(
    `# Budget per one-time bootstrap setup command.`,
    `setup_timeout_ms = ${worktrees?.setupTimeoutMs ?? 120_000}`,
    '',
    '[dispatch]',
    '# Bob consolidation interval; 0 disables the periodic trigger.',
    `bob_interval_ms = ${preserved?.dispatch.bobIntervalMs ?? 3_600_000}`,
    '',
    '[silas]',
    '# Hosted ops session (Silas): closes the delivered→PR→review loop and',
    '# breaks recurring blocker loops. enabled = false hosts no silas slot and',
    '# fires no wakes. There is no review-round cap: while blockers evolve the',
    '# loop continues; the directive/rebrief/escalate thresholds count',
    '# CONSECUTIVE verdict rounds carrying the SAME canonical blocker.',
    `enabled = ${preserved?.silas.enabled ?? true}`,
    `sweep_interval_ms = ${preserved?.silas.sweepIntervalMs ?? 300_000}`,
    `stall_threshold_ms = ${preserved?.silas.stallThresholdMs ?? 1_800_000}`,
    `directive_at = ${preserved?.silas.directiveAt ?? 2}`,
    `rebrief_at = ${preserved?.silas.rebriefAt ?? 3}`,
    `escalate_at = ${preserved?.silas.escalateAt ?? 4}`,
    '',
    '[review]',
    '# Review gate policy. true keeps Perkins as the primary gate behind the',
    '# fail-closed four-leg pre-flight (bundled resource integrity, review-model',
    '# provider auth, GitHub/GitLab token for verdict posting, review policy',
    '# enabled); a failed leg is always reported, never a silent downgrade.',
    '# false routes every review request to the installed bmad-review fallback',
    '# gate (findings triaged; blockers routed to the implementing minion as fix',
    '# directives; 0 blockers = clear to merge; merge stays user-held).',
    `enabled = ${preserved?.review.enabled ?? true}`,
    '',
    '[verify]',
    '# Verification scheduler: lanes request their project\'s verify command',
    '# through POST /api/verify; the scheduler owns ONE global test budget',
    '# across lanes. Requests beyond max_concurrent queue FIFO, a queued',
    '# request past lock_wait_timeout_ms fails loud, a holder whose pid is',
    '# dead is released, and every run is recorded for review evidence.',
    `max_concurrent = ${preserved?.verify.maxConcurrent ?? 1}`,
    '# Total test workers across runs; 0 = auto (CPU cores - 2).',
    `worker_budget = ${preserved?.verify.workerBudget ?? 0}`,
    `lock_wait_timeout_ms = ${preserved?.verify.lockWaitTimeoutMs ?? 900_000}`,
    `run_timeout_ms = ${preserved?.verify.runTimeoutMs ?? 1_800_000}`,
    '',
  );
  return `${lines.join('\n')}\n`;
}

/** Values used for the generated docs/CONFIG.md reference block. */
const DOC_EXAMPLE_VALUES: CompleteConfigValues = {
  instanceDir: '~/.gru-command',
  workspaceRoot: '~/code',
  host: '127.0.0.1',
  port: 7665,
  token: 'a-random-pairing-token',
  runtime: 'pi',
  model: MODEL_DEFAULT_SENTINEL,
  thinkingLevel: MODEL_DEFAULT_SENTINEL,
  roles: {},
};

const DOC_BLOCK_BEGIN =
  '<!-- BEGIN GENERATED CONFIG REFERENCE — source: src/config-reference.ts; regenerate: npm run config:docs -->';
const DOC_BLOCK_END = '<!-- END GENERATED CONFIG REFERENCE -->';

/** The managed, generated reference block for docs/CONFIG.md. */
export function renderConfigDocBlock(): string {
  return `${DOC_BLOCK_BEGIN}\n\`\`\`toml\n${renderReferenceConfig(DOC_EXAMPLE_VALUES)}\`\`\`\n${DOC_BLOCK_END}`;
}
