import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configPathFor,
  ConfigError,
  expandTilde,
  instanceDirFromEnv,
  loadConfig,
} from '../src/config.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'gru-command-test-'));
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
    expect(config.runtimes).toEqual({ default: 'pi', roles: {} });
    expect(config.models).toEqual({ default: '', roles: {} });
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
    const home = mkdtempSync(join(tmpdir(), 'gru-command-rt-'));
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
    });
    expect(config.models).toEqual({
      default: 'provider/model-a',
      roles: { gru: 'provider/model-b' },
    });
  });

  it('a reloaded identical file yields an identical config', () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-rt2-'));
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
});
