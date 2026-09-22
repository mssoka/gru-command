import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  configPathFor,
  ConfigError,
  expandTilde,
  instanceDirFromEnv,
  loadConfig,
  resolveModelRefreshPolicy,
  resolveSpawnPolicy,
} from '../src/config.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-test-'));
  cleanupDirs.push(dir);
  return dir;
}

function writeConfig(home: string, toml: string): void {
  writeFileSync(configPathFor(home), toml, 'utf-8');
}

const VALID_CONFIG = `
workspace_root = "~/projects"
data_dir = "~/.gru-command"

[server]
host = "127.0.0.1"
port = 7700

[auth]
token = "pairing-token-example"

[runtimes]
default = "claude-code"

[runtimes.roles]
gru = "pi"
minion = "claude-code"

[models]
default = "provider/model-a"

[models.roles]
gru = "provider/model-b"
`;

describe('config defaults', () => {
  it('boots on pure defaults when no config file exists', () => {
    const home = tmpHome();
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.sourceFile).toBeNull();
    expect(config.workspaceRoot).toBe('/home/tester/code');
    expect(config.dataDir).toBe(home);
    expect(config.server).toEqual({ host: '127.0.0.1', port: 7665 });
    expect(config.auth).toEqual({ token: '' });
    expect(config.runtimes).toEqual({ default: 'pi', roles: {}, policies: {} });
    expect(config.models).toEqual({ default: 'default', roles: {} });
    expect(config.thinking).toEqual({ default: 'default', roles: {} });
    expect(config.instanceDir).toBe(home);
  });

  it('GRU_COMMAND_HOME overrides the instance dir', () => {
    const home = tmpHome();
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.instanceDir).toBe(home);
    expect(configPathFor(home)).toBe(join(home, 'config.toml'));
  });

  it('rejects a relative GRU_COMMAND_HOME', () => {
    expect(() => instanceDirFromEnv({ GRU_COMMAND_HOME: 'relative/path' })).toThrow(ConfigError);
  });
});

describe('decision config', () => {
  it('is strictly default-off with the verified endpoint and risk-class defaults', () => {
    const config = loadConfig({ GRU_COMMAND_HOME: tmpHome() }, '/home/tester');
    expect(config.decisions).toEqual({
      jev: {
        enabled: false,
        model: '~typesafe/jev-latest',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        timeoutMs: 2_000,
      },
      thresholds: {
        read_only: { act: 0.6, confirm: 0.4, requireConfirmOnAct: false },
        operational: { act: 0.75, confirm: 0.55, requireConfirmOnAct: false },
        destructive: { act: 0.85, confirm: 0.7, requireConfirmOnAct: true },
      },
    });
  });

  it('loads explicit Jev transport and all three threshold tables', () => {
    const home = tmpHome();
    writeConfig(home, `
[decisions.jev]
enabled = true
model = "typesafe/jev-1.13-20260917"
endpoint = "https://openrouter.ai/api/alpha/decisions"
timeout_ms = 2500

[decisions.thresholds.read_only]
act = 0.72
confirm = 0.42
require_confirm_on_act = false

[decisions.thresholds.operational]
act = 0.82
confirm = 0.62
require_confirm_on_act = false

[decisions.thresholds.destructive]
act = 0.92
confirm = 0.82
require_confirm_on_act = true
`);
    const decisions = loadConfig({ GRU_COMMAND_HOME: home }).decisions;
    expect(decisions.jev).toMatchObject({ enabled: true, timeoutMs: 2_500 });
    expect(decisions.thresholds.operational).toEqual({ act: 0.82, confirm: 0.62, requireConfirmOnAct: false });
    expect(decisions.thresholds.destructive.requireConfirmOnAct).toBe(true);
  });

  it('rejects unknown decision keys and inverted thresholds', () => {
    const unknownHome = tmpHome();
    writeConfig(unknownHome, '[decisions.jev]\nenabeld = true\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: unknownHome })).toThrow(/unknown key `enabeld`/);

    const invertedHome = tmpHome();
    writeConfig(invertedHome, '[decisions.thresholds.operational]\nact = 0.5\nconfirm = 0.5\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: invertedHome })).toThrow(/must be less than/);
  });

  it('will not allow destructive confirmation to be configured away', () => {
    const home = tmpHome();
    writeConfig(home, '[decisions.thresholds.destructive]\nrequire_confirm_on_act = false\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/must be true/);
  });
});

describe('config round-trip', () => {
  it('loads a valid file with resolved values', () => {
    const home = tmpHome();
    writeConfig(home, VALID_CONFIG);
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.sourceFile).toBe(configPathFor(home));
    expect(config.workspaceRoot).toBe('/home/tester/projects');
    expect(config.dataDir).toBe('/home/tester/.gru-command');
    expect(config.server).toEqual({ host: '127.0.0.1', port: 7700 });
    expect(config.auth).toEqual({ token: 'pairing-token-example' });
    expect(config.runtimes).toEqual({
      default: 'claude-code',
      roles: { gru: 'pi', minion: 'claude-code' },
      policies: {},
    });
    expect(config.models).toEqual({
      default: 'provider/model-a',
      roles: { gru: 'provider/model-b' },
    });
    expect(config.thinking).toEqual({ default: 'default', roles: {} });
  });

  it('a reloaded identical file yields an identical config', () => {
    const home = tmpHome();
    writeConfig(home, VALID_CONFIG);
    const first = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const second = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(second).toEqual(first);
  });

  it('expands bare ~ and ~/-prefixed paths', () => {
    expect(expandTilde('~', '/home/tester')).toBe('/home/tester');
    expect(expandTilde('~/code', '/home/tester')).toBe('/home/tester/code');
    expect(expandTilde('/opt/absolute', '/home/tester')).toBe('/opt/absolute');
  });
});

describe('config fail-loud validation', () => {
  it('rejects unparsable TOML naming the file', () => {
    const home = tmpHome();
    writeConfig(home, 'workspace_root = [unclosed');
    try {
      loadConfig({ GRU_COMMAND_HOME: home });
      expect.unreachable('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('failed to parse TOML');
      expect(message).toContain(configPathFor(home));
    }
  });

  it('rejects unknown top-level keys', () => {
    const home = tmpHome();
    writeConfig(home, 'worskapce_root = "~/code"');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/unknown top-level key `worskapce_root`/);
  });

  it('rejects wrong types', () => {
    const home = tmpHome();
    writeConfig(home, 'workspace_root = 42');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/workspace_root must be a string/);
  });

  it('rejects empty strings for required paths', () => {
    const home = tmpHome();
    writeConfig(home, 'workspace_root = ""');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/workspace_root must not be empty/);
  });

  it('rejects unknown runtime ids', () => {
    const home = tmpHome();
    writeConfig(home, '[runtimes]\ndefault = "terminator"');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/unknown runtime `terminator`/);
  });

  it('rejects unknown roles in runtime overrides', () => {
    const home = tmpHome();
    writeConfig(home, '[runtimes.roles]\nbruce = "pi"');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/unknown role `bruce`/);
  });

  it('rejects invalid ports', () => {
    const home = tmpHome();
    writeConfig(home, '[server]\nport = 99999');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/server.port must be an integer/);
  });

  it('rejects empty auth tokens', () => {
    const home = tmpHome();
    writeConfig(home, '[auth]\ntoken = ""');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/auth.token must not be empty/);
  });

  it('rejects unknown keys inside tables', () => {
    const home = tmpHome();
    writeConfig(home, '[server]\nhostname = "x"');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/unknown key `hostname` in \[server\]/);
  });

  it('rejects a TOML datetime where a table is expected (no silent empty table)', () => {
    const home = tmpHome();
    writeConfig(home, 'server = 2024-01-01T00:00:00Z');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/server must be a table/);
  });

  it('rejects relative paths that never resolve to absolute', () => {
    const home = tmpHome();
    writeConfig(home, 'workspace_root = "relative/path"');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester')).toThrow(
      /workspace_root must resolve to an absolute path/,
    );
    const home2 = tmpHome();
    writeConfig(home2, 'data_dir = "relative/data"');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home2 }, '/home/tester')).toThrow(
      /data_dir must resolve to an absolute path/,
    );
  });

  it('rejects data_dir nested inside workspace_root (SPEC ruling 7)', () => {
    const home = tmpHome();
    writeConfig(home, 'workspace_root = "/home/tester/code"\ndata_dir = "/home/tester/code/state"');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester')).toThrow(
      /data_dir must not live inside workspace_root/,
    );
    const home2 = tmpHome();
    writeConfig(home2, 'workspace_root = "/home/tester/code"\ndata_dir = "/home/tester/code"');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home2 }, '/home/tester')).toThrow(
      /data_dir must not live inside workspace_root/,
    );
  });

  it('rejects an empty GRU_COMMAND_HOME like any non-absolute value', () => {
    expect(() => instanceDirFromEnv({ GRU_COMMAND_HOME: '' })).toThrow(ConfigError);
  });

  it('rejects empty model role overrides (default may be empty; overrides may not)', () => {
    const home = tmpHome();
    writeConfig(home, '[models.roles]\ngru = ""');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(
      /models.roles.gru must not be empty/,
    );
  });

  it('rejects out-of-range and non-integer ports (all documented legs)', () => {
    for (const leg of ['port = -1', 'port = 7.5', 'port = "8080"']) {
      const home = tmpHome();
      writeConfig(home, `[server]\n${leg}`);
      expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(
        /server.port must be an integer/,
      );
    }
  });

  it('reports an unreadable config file distinctly (EACCES, not a parse error)', () => {
    const home = tmpHome();
    writeConfig(home, 'workspace_root = "~/code"');
    chmodSync(configPathFor(home), 0o000);
    try {
      expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(
        /cannot read config file: EACCES/,
      );
    } finally {
      chmodSync(configPathFor(home), 0o644);
    }
  });

  it('fails loud on a dangling config symlink instead of booting on defaults', () => {
    const home = tmpHome();
    symlinkSync(join(home, 'does-not-exist.toml'), configPathFor(home));
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(/dangling symlink/);
  });

  it('rejects data_dir reaching inside workspace_root through a symlink (realpath check)', () => {
    const realWorkspace = tmpHome();
    const aliasParent = tmpHome();
    const alias = join(aliasParent, 'ws-alias');
    symlinkSync(realWorkspace, alias);
    mkdirSync(join(alias, 'state')); // created through the alias = inside the real root
    const home = tmpHome();
    writeConfig(
      home,
      `workspace_root = "${realWorkspace}"\ndata_dir = "${join(alias, 'state')}"`,
    );
    expect(() => loadConfig({ GRU_COMMAND_HOME: home })).toThrow(
      /data_dir must not live inside workspace_root/,
    );
  });
});

describe('model & thinking policy (SPEC ruling 16)', () => {
  const POLICY_CONFIG = `
[models]
default = "default"

[models.roles]
minion = "provider/model-b"

[thinking]
default = "high"

[thinking.roles]
perkins = "max"

[runtimes.pi]
model = "provider/pi-model"
thinking_level = "default"

[runtimes.pi.roles]
gru = { model = "provider/gru-model", thinking_level = "low" }
bob = { thinking_level = "medium" }
`;

  it('parses the full policy surface with per-runtime tables and role entries', () => {
    const home = tmpHome();
    writeConfig(home, POLICY_CONFIG);
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.models).toEqual({
      default: 'default',
      roles: { minion: 'provider/model-b' },
    });
    expect(config.thinking).toEqual({ default: 'high', roles: { perkins: 'max' } });
    expect(config.runtimes.policies['pi']).toEqual({
      model: 'provider/pi-model',
      thinkingLevel: 'default',
      roles: {
        gru: { model: 'provider/gru-model', thinkingLevel: 'low' },
        bob: { thinkingLevel: 'medium' },
      },
    });
  });

  it('resolves spawn policy most-specific-wins with "default" passthrough', () => {
    const home = tmpHome();
    writeConfig(home, POLICY_CONFIG);
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    // per-runtime-per-role beats everything:
    expect(resolveSpawnPolicy(config, 'pi', 'gru')).toEqual({
      model: 'provider/gru-model',
      thinkingLevel: 'low',
    });
    // per-role model beats per-runtime model; thinking falls to per-runtime:
    expect(resolveSpawnPolicy(config, 'pi', 'minion')).toEqual({
      model: 'provider/model-b',
      thinkingLevel: 'default',
    });
    // thinking-only role entry keeps the runtime model:
    expect(resolveSpawnPolicy(config, 'pi', 'bob')).toEqual({
      model: 'provider/pi-model',
      thinkingLevel: 'medium',
    });
    // plain role: per-runtime model, and the runtime's explicit
    // thinking_level="default" PINS (an explicit sentinel at a narrower
    // tier shadows wider tiers — you can un-set a global per runtime):
    expect(resolveSpawnPolicy(config, 'pi', 'silas')).toEqual({
      model: 'provider/pi-model',
      thinkingLevel: 'default',
    });
    // other runtime (no policy table): globals only:
    expect(resolveSpawnPolicy(config, 'claude-code', 'silas')).toEqual({
      model: 'default',
      thinkingLevel: 'high',
    });
    // spawn options override everything; "default" passes through:
    expect(
      resolveSpawnPolicy(config, 'pi', 'gru', { model: 'default', thinkingLevel: 'max' }),
    ).toEqual({ model: 'default', thinkingLevel: 'max' });
  });

  it('treats empty strings as the default sentinel (E1 configs keep working)', () => {
    const home = tmpHome();
    writeConfig(home, '[models]\ndefault = ""\n');
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(resolveSpawnPolicy(config, 'pi', 'gru')).toEqual({
      model: 'default',
      thinkingLevel: 'default',
    });
  });

  it('rejects unknown keys and empty role entries in policy tables', () => {
    const home = tmpHome();
    writeConfig(home, '[runtimes.pi]\nbananas = "x"\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester')).toThrow(
      /unknown key `bananas` in \[runtimes\.pi\]/,
    );
    const home2 = tmpHome();
    writeConfig(home2, '[runtimes.pi.roles]\ngru = {}\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home2 }, '/home/tester')).toThrow(
      /must set at least one of model, thinking_level/,
    );
    const home3 = tmpHome();
    writeConfig(home3, '[runtimes.not-a-runtime]\nmodel = "x"\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home3 }, '/home/tester')).toThrow(
      /unknown key `not-a-runtime` in \[runtimes\]/,
    );
    const home4 = tmpHome();
    writeConfig(home4, '[thinking]\nbananas = "x"\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home4 }, '/home/tester')).toThrow(
      /unknown key `bananas` in \[thinking\]/,
    );
  });

  it('defaults the pi catalog refresh ON with a bounded timeout; config can pin it off', () => {
    const home = tmpHome();
    const defaults = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(resolveModelRefreshPolicy(defaults)).toEqual({ enabled: true, timeoutMs: 10_000 });

    writeConfig(
      home,
      '[runtimes.pi]\nmodel_refresh = false\nmodel_refresh_timeout_ms = 2500\n',
    );
    const configured = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(configured.runtimes.policies['pi']).toMatchObject({
      modelRefresh: false,
      modelRefreshTimeoutMs: 2500,
    });
    expect(resolveModelRefreshPolicy(configured)).toEqual({ enabled: false, timeoutMs: 2500 });
  });

  it('rejects malformed model-refresh knobs (fail-loud, no silent coercion)', () => {
    const home = tmpHome();
    writeConfig(home, '[runtimes.pi]\nmodel_refresh = "yes"\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester')).toThrow(
      /runtimes\.pi\.model_refresh must be a boolean/,
    );
    const home2 = tmpHome();
    writeConfig(home2, '[runtimes.pi]\nmodel_refresh_timeout_ms = 0\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home2 }, '/home/tester')).toThrow(
      /runtimes\.pi\.model_refresh_timeout_ms must be a positive integer/,
    );
  });

  it('rejects the pi-only refresh knobs under [runtimes.claude-code] instead of ignoring them', () => {
    const home = tmpHome();
    writeConfig(home, '[runtimes.claude-code]\nmodel_refresh = false\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester')).toThrow(
      /unknown key `model_refresh` in \[runtimes\.claude-code\] \(valid keys: model, thinking_level, roles\)/,
    );
    const home2 = tmpHome();
    writeConfig(home2, '[runtimes.claude-code]\nmodel_refresh_timeout_ms = 2500\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home2 }, '/home/tester')).toThrow(
      /unknown key `model_refresh_timeout_ms` in \[runtimes\.claude-code\]/,
    );
  });
});

describe('docs/example.config.toml', () => {
  it('parses and validates through the loader (docs drift guard)', () => {
    const example = readFileSync(join(import.meta.dirname, '..', 'docs', 'example.config.toml'), 'utf-8');
    const home = tmpHome();
    writeConfig(home, example);
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.runtimes.default).toBe('pi');
    expect(config.models.default).toBe('default');
    expect(config.thinking.default).toBe('default');
    expect(config.runtimes.policies['pi']?.roles).toEqual({});
  });
});

describe('Perkins r1 regression pins', () => {
  it('rejects empty overrides in [thinking.roles] (N11)', () => {
    const home = tmpHome();
    writeConfig(home, '[thinking.roles]\ngru = ""\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester')).toThrow(
      /thinking\.roles\.gru must not be empty/,
    );
  });

  it('rejects an unknown role and unknown entry key inside [runtimes.<id>.roles] (N18)', () => {
    const home = tmpHome();
    writeConfig(home, '[runtimes.pi.roles]\nnot-a-role = { model = "x" }\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester')).toThrow(
      /unknown role `not-a-role`/,
    );
    const home2 = tmpHome();
    writeConfig(home2, '[runtimes.pi.roles]\ngru = { model = "x", bananas = "y" }\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home2 }, '/home/tester')).toThrow(
      /unknown key `bananas` in \[runtimes\.pi\.roles\.gru\]/,
    );
  });
});

describe('supervision / logging / chat tables (E7)', () => {
  it('defaults: supervision on, 15-min watchdog, 3-in-10-min breaker; bounded logs', () => {
    const home = tmpHome();
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.supervision).toEqual({
      enabled: true,
      turnSilenceMs: 900_000,
      restartWindowMs: 600_000,
      maxRestarts: 3,
      restartBackoffMs: 2_000,
    });
    expect(config.logging).toEqual({ maxBytes: 10_485_760, keep: 5 });
    expect(config.chat).toEqual({ frameLogMaxBytes: 8_388_608, frameLogKeep: 3, notifyWake: 'never' });
  });

  it('loads explicit [supervision] / [logging] / [chat] values', () => {
    const home = tmpHome();
    writeFileSync(
      join(home, 'config.toml'),
      [
        '[supervision]',
        'enabled = false',
        'turn_silence_ms = 5000',
        'restart_window_ms = 120000',
        'max_restarts = 2',
        'restart_backoff_ms = 250',
        '[logging]',
        'max_bytes = 1024',
        'keep = 1',
        '[chat]',
        'frame_log_max_bytes = 2048',
        'frame_log_keep = 2',
        'notify_wake = "action-required"',
        '',
      ].join('\n'),
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.supervision).toEqual({
      enabled: false,
      turnSilenceMs: 5_000,
      restartWindowMs: 120_000,
      maxRestarts: 2,
      restartBackoffMs: 250,
    });
    expect(config.logging).toEqual({ maxBytes: 1_024, keep: 1 });
    expect(config.chat).toEqual({ frameLogMaxBytes: 2_048, frameLogKeep: 2, notifyWake: 'action-required' });
  });

  it('fail-loud: unknown wake policies are rejected, all documented modes load', () => {
    const home = tmpHome();
    writeConfig(home, '[chat]\nnotify_wake = "sometimes"\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester')).toThrow(
      /unknown wake policy `sometimes` \(valid: never, action-required, all\)/,
    );
    for (const mode of ['never', 'action-required', 'all'] as const) {
      const modeHome = tmpHome();
      writeConfig(modeHome, `[chat]\nnotify_wake = "${mode}"\n`);
      expect(loadConfig({ GRU_COMMAND_HOME: modeHome }, '/home/tester').chat.notifyWake).toBe(mode);
    }
  });

  it('fail-loud: unknown keys and non-positive integers are rejected', () => {
    const bad: readonly string[] = [
      '[supervision]\nunknown_key = 1\n',
      '[supervision]\nturn_silence_ms = 0\n',
      '[supervision]\nmax_restarts = -1\n',
      '[supervision]\nenabled = "yes"\n',
      '[logging]\nkeep = 0\n',
      '[chat]\nframe_log_keep = 1.5\n',
    ];
    for (const text of bad) {
      const home = tmpHome();
      writeFileSync(join(home, 'config.toml'), text, 'utf-8');
      expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester'), text).toThrow(ConfigError);
    }
  });
});

describe('worktrees config (E8, manager lane)', () => {
  it('defaults: worktrees live under data_dir', () => {
    const home = tmpHome();
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.worktrees).toEqual({
      root: join(home, 'worktrees'),
      preserveRoot: join(home, 'worktree-preserves'),
      setupTimeoutMs: 120_000,
    });
  });

  it('honors custom roots (tilde-expanded) and the setup budget', () => {
    const home = tmpHome();
    writeConfig(
      home,
      ['[worktrees]', 'root = "~/wt"', 'preserve_root = "~/kept"', 'setup_timeout_ms = 5000', ''].join('\n'),
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.worktrees.root).toBe('/home/tester/wt');
    expect(config.worktrees.preserveRoot).toBe('/home/tester/kept');
    expect(config.worktrees.setupTimeoutMs).toBe(5_000);
  });

  it('fail-loud: unknown keys, empty root, non-positive budget', () => {
    const bad: readonly string[] = [
      '[worktrees]\nunknown = 1\n',
      '[worktrees]\nsetup_timeout_ms = 0\n',
      '[worktrees]\nroot = ""\n',
    ];
    for (const text of bad) {
      const home = tmpHome();
      writeFileSync(join(home, 'config.toml'), text, 'utf-8');
      expect(() => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester'), text).toThrow(ConfigError);
    }
  });
});

describe('dispatch config (E8)', () => {
  it('Bob runs hourly by default', () => {
    const home = tmpHome();
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.dispatch).toEqual({ bobIntervalMs: 3_600_000 });
  });

  it('a disabled Bob trigger is legal; garbage is not', () => {
    const home = tmpHome();
    writeConfig(home, '[dispatch]\nbob_interval_ms = 0\n');
    expect(loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').dispatch.bobIntervalMs).toBe(0);
    const bad: readonly string[] = [
      '[dispatch]\nunknown = 1\n',
      '[dispatch]\nbob_interval_ms = -1\n',
      '[dispatch]\nbob_interval_ms = 1.5\n',
    ];
    for (const text of bad) {
      const h2 = tmpHome();
      writeFileSync(join(h2, 'config.toml'), text, 'utf-8');
      expect(() => loadConfig({ GRU_COMMAND_HOME: h2 }, '/home/tester'), text).toThrow(ConfigError);
    }
  });

  it('the [silas] section boots enabled by default (owner ruling: live, not dark)', () => {
    const home = tmpHome();
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    expect(config.silas).toEqual({
      enabled: true,
      sweepIntervalMs: 300_000,
      stallThresholdMs: 1_800_000,
      directiveAt: 2,
      rebriefAt: 3,
      escalateAt: 4,
    });
  });

  it('a full [silas] section parses; garbage and non-ascending thresholds refuse boot', () => {
    const home = tmpHome();
    writeConfig(home, '[silas]\nenabled = false\nsweep_interval_ms = 0\nstall_threshold_ms = 600000\ndirective_at = 1\nrebrief_at = 2\nescalate_at = 3\n');
    expect(loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').silas).toEqual({
      enabled: false,
      sweepIntervalMs: 0,
      stallThresholdMs: 600_000,
      directiveAt: 1,
      rebriefAt: 2,
      escalateAt: 3,
    });
    const bad: readonly string[] = [
      '[silas]\nunknown = 1\n',
      '[silas]\nsweep_interval_ms = -1\n',
      '[silas]\nstall_threshold_ms = 1.5\n',
      '[silas]\ndirective_at = 3\nrebrief_at = 3\n',
      '[silas]\ndirective_at = 2\nrebrief_at = 4\nescalate_at = 4\n',
      '[silas]\nenabled = "yes"\n',
    ];
    for (const text of bad) {
      const h2 = tmpHome();
      writeFileSync(join(h2, 'config.toml'), text, 'utf-8');
      expect(() => loadConfig({ GRU_COMMAND_HOME: h2 }, '/home/tester'), text).toThrow(ConfigError);
    }
  });
});
