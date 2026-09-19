import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { MODEL_DEFAULT_SENTINEL, ROLES, RUNTIME_IDS, type Role, type RuntimeId } from './config.js';

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
  readonly jevEnabled: boolean;
}

export interface DecisionsTemplateOptions {
  readonly repoRoot: string;
  readonly instanceDir: string;
  readonly enabled: boolean;
  /** Test-only contract seam. Production always uses dist/decisions/cli.js. */
  readonly cliPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
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

/**
 * Render every generic Gru Command option. Values that have a concrete
 * runtime default are active. Optional override keys are present as teaching
 * comments because activating a placeholder would change precedence (notably
 * the model "default" sentinel pinning a wider explicit policy).
 */
export function renderGenericConfig(values: CompleteConfigValues): string {
  const lines: string[] = [
    '# Gru Command configuration.',
    '# This is the live file read from <instance>/config.toml, not a docs example.',
    '# Edit values in place, then restart only your Gru Command service.',
    '',
    '# Directory containing only managed project repositories.',
    `workspace_root = ${tomlString(values.workspaceRoot)}`,
    '# Per-instance state. Keep this outside workspace_root.',
    `data_dir = ${tomlString(values.instanceDir)}`,
    '',
    '[server]',
    '# Loopback is safest. Use a LAN address only on a trusted LAN; v1 has no TLS.',
    `host = ${tomlString(values.host)}`,
    '# 0 chooses an ephemeral port; 7665 is the stable default.',
    `port = ${values.port}`,
    '',
    '[auth]',
    '# Pairing token for authenticated browser/WebSocket access. Keep this file private.',
    `token = ${tomlString(values.token)}`,
    '',
    '[runtimes]',
    '# Session host: "pi" or "claude-code".',
    `default = ${tomlString(values.runtime)}`,
    '',
    '[runtimes.roles]',
    '# Optional role overrides. Omitted roles inherit runtimes.default.',
  ];
  for (const role of ROLES) {
    const selected = values.roles[role];
    lines.push(
      selected === undefined
        ? `# ${role} = ${tomlString(values.runtime)}`
        : `${role} = ${tomlString(selected)}`,
    );
  }

  lines.push(
    '',
    '[models]',
    '# "default" delegates to the selected runtime; an explicit value is provider/model.',
    `default = ${tomlString(values.model)}`,
    '',
    '[models.roles]',
    '# Optional per-role model overrides; leave commented to inherit.',
  );
  for (const role of ROLES) lines.push(`# ${role} = ${tomlString(MODEL_DEFAULT_SENTINEL)}`);

  lines.push(
    '',
    '[thinking]',
    '# "default" delegates to the runtime; explicit levels are runtime-specific.',
    `default = ${tomlString(values.thinkingLevel)}`,
    '',
    '[thinking.roles]',
    '# Optional per-role thinking overrides; leave commented to inherit.',
  );
  for (const role of ROLES) lines.push(`# ${role} = ${tomlString(MODEL_DEFAULT_SENTINEL)}`);

  for (const runtime of RUNTIME_IDS) {
    lines.push(
      '',
      `[runtimes.${runtime}]`,
      '# Optional runtime-wide policy. Omitted keys inherit [models]/[thinking].',
      `# model = ${tomlString(MODEL_DEFAULT_SENTINEL)}`,
      `# thinking_level = ${tomlString(MODEL_DEFAULT_SENTINEL)}`,
      '',
      `[runtimes.${runtime}.roles]`,
      '# Optional inline role policies; at least one field is required when uncommented.',
    );
    for (const role of ROLES) {
      lines.push(
        `# ${role} = { model = ${tomlString(MODEL_DEFAULT_SENTINEL)}, thinking_level = ${tomlString(MODEL_DEFAULT_SENTINEL)} }`,
      );
    }
  }

  lines.push(
    '',
    '[supervision]',
    '# Agent watchdog and crash-loop breaker.',
    'enabled = true',
    'turn_silence_ms = 900000',
    'restart_window_ms = 600000',
    'max_restarts = 3',
    'restart_backoff_ms = 2000',
    '',
    '[logging]',
    '# service.log rotation.',
    'max_bytes = 10485760',
    'keep = 5',
    '',
    '[chat]',
    '# gru.frames.jsonl rotation; reconnect replay spans retained shards.',
    'frame_log_max_bytes = 8388608',
    'frame_log_keep = 3',
    '',
    '[worktrees]',
    '# root and preserve_root follow data_dir by default. Uncomment only to relocate them.',
    `# root = ${tomlString(join(values.instanceDir, 'worktrees'))}`,
    `# preserve_root = ${tomlString(join(values.instanceDir, 'worktree-preserves'))}`,
    'setup_timeout_ms = 120000',
    '',
    '[dispatch]',
    '# Bob consolidation interval; 0 disables the periodic trigger.',
    'bob_interval_ms = 3600000',
    '',
  );
  return `${lines.join('\n')}\n`;
}

/** Invoke the sibling-owned Jev CLI contract without a shell or secret argv. */
export function renderDecisionsConfig(options: DecisionsTemplateOptions): string {
  const cliPath = options.cliPath ?? join(options.repoRoot, 'dist', 'decisions', 'cli.js');
  if (!existsSync(cliPath)) {
    throw new Error(
      `Jev config template CLI is unavailable at ${cliPath} — build the complete product before generating config`,
    );
  }
  const args = [cliPath, 'config-template'];
  if (options.enabled) args.push('--enabled', 'true');
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    GRU_COMMAND_HOME: options.instanceDir,
  };
  delete childEnv.OPENROUTER_API_KEY;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 256 * 1024,
  });
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new Error(`Jev config template timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Jev config template failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Jev config template failed with ${
        result.status === null ? `signal ${result.signal ?? 'unknown'}` : `exit ${result.status}`
      } (child output withheld)`,
    );
  }
  const fragment = (result.stdout ?? '').trim();
  let enabled: unknown;
  try {
    const parsed = parse(fragment) as { decisions?: { jev?: { enabled?: unknown } } };
    enabled = parsed.decisions?.jev?.enabled;
  } catch {
    throw new Error('Jev config template returned malformed TOML');
  }
  if (typeof enabled !== 'boolean' || enabled !== options.enabled) {
    const explicitPreSchemaFixture =
      options.cliPath !== undefined &&
      fragment.includes('# TEST-ONLY PRE-JEV SCHEMA FRAGMENT') &&
      fragment.includes(`# enabled = ${String(options.enabled)}`);
    if (!explicitPreSchemaFixture) {
      throw new Error(
        `Jev config template did not emit an active enabled = ${String(options.enabled)} value`,
      );
    }
  }
  return `${fragment}\n`;
}

export function renderCompleteConfig(
  values: CompleteConfigValues,
  decisions: Omit<DecisionsTemplateOptions, 'instanceDir' | 'enabled'>,
): string {
  return `${renderGenericConfig(values)}\n${renderDecisionsConfig({
    ...decisions,
    instanceDir: values.instanceDir,
    enabled: values.jevEnabled,
  })}`;
}
