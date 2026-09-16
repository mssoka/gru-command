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
    expect(config.runtimes.policies['pi']).toEqual({
      model: 'default',
      thinkingLevel: 'default',
      roles: {
        minion: { model: 'provider/model-c', thinkingLevel: 'low' },
        bob: { thinkingLevel: 'medium' },
      },
    });
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
