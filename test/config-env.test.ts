import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, configPathFor, loadConfig } from '../src/config.js';
import { renderReferenceConfig } from '../src/config-reference.js';
import { bootServiceEnvironment, withConfiguredEnvironment } from '../src/service-environment.js';
import { parseAnswers } from '../src/wizard/answers.js';
import { writeInstanceConfig } from '../src/wizard/steps.js';

/**
 * `[env]` in config.toml (#494): parsing and validation, the boot step the
 * service runs before anything spawns (src/service-environment.ts, called
 * by main.ts), and the paths that must never show a value. The compiled
 * service boot is covered by test/config-env-service.test.ts.
 */

const CANARY = 'SYNTHETIC-ENV-CANARY-494';
const KEY_CANARY = 'SYNTHETIC-PROVIDER-KEY-CANARY-494';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function instance(toml: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-env-'));
  cleanupDirs.push(dir);
  writeFileSync(configPathFor(dir), toml, { encoding: 'utf-8', mode });
  chmodSync(configPathFor(dir), mode);
  return dir;
}

/** The ConfigError message `toml` produces; fails when it loads. */
function rejection(toml: string, mode = 0o600): string {
  const home = instance(toml, mode);
  try {
    loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error('expected a ConfigError');
}

describe('[env] parsing', () => {
  it('is optional: no section means no names', () => {
    const home = instance('[server]\nport = 0\n');
    expect(loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').env.names).toEqual([]);
  });

  it('reads a string table in file order, empty strings included', () => {
    const home = instance(`[env]\nGITLAB_TOKEN = "${CANARY}"\n_lower_ok = ""\nCUSTOM_SERVICE_OPTION = "enabled"\n`);
    const env = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').env;
    expect(env.names).toEqual(['GITLAB_TOKEN', '_lower_ok', 'CUSTOM_SERVICE_OPTION']);
    expect(env.entries()).toEqual([['GITLAB_TOKEN', CANARY], ['_lower_ok', ''], ['CUSTOM_SERVICE_OPTION', 'enabled']]);
  });

  it.each([
    ['an integer', `TOKEN = 42`, 'env.TOKEN must be a string, got number'],
    ['a boolean', `TOKEN = true`, 'env.TOKEN must be a string, got boolean'],
    ['an array', `TOKEN = ["${CANARY}"]`, 'env.TOKEN must be a string, got object'],
    ['a table', `TOKEN = { value = "${CANARY}" }`, 'env.TOKEN must be a string, got object'],
    ['a date', `TOKEN = 2026-10-23T00:00:00Z`, 'env.TOKEN must be a string, got object'],
  ])('rejects %s value, naming the field and never the value', (_label, line, expected) => {
    const message = rejection(`[env]\n${line}\n`);
    expect(message).toContain(expected);
    expect(message).not.toContain(CANARY);
  });

  it.each([
    ['1STARTS_WITH_DIGIT', '"1STARTS_WITH_DIGIT"'],
    ['HAS SPACE', '"HAS SPACE"'],
    ['A=B', '"A=B"'],
    ['DASHED-NAME', '"DASHED-NAME"'],
    ['', '""'],
  ])('rejects the invalid environment name %j', (name, quoted) => {
    const message = rejection(`[env]\n${JSON.stringify(name)} = "${CANARY}"\n`);
    expect(message).toContain(`env name ${quoted} is not a valid environment variable name`);
    expect(message).not.toContain(CANARY);
  });

  it('rejects a NUL character in a value without showing it', () => {
    const message = rejection(`[env]\nTOKEN = "${CANARY}\\u0000tail"\n`);
    expect(message).toContain('env.TOKEN must not contain a NUL character');
    expect(message).not.toContain(CANARY);
  });

  it.each(['GRU_COMMAND_HOME', 'GRU_SERVICE_PORT', 'GRU_LANE_TOKEN', 'gru_command_home'])(
    'refuses the reserved name %s: [env] can never select the instance or carry GC authority',
    (name) => {
      const message = rejection(`[env]\n${name} = "${CANARY}"\n`);
      expect(message).toContain(`env.${name} is reserved`);
      expect(message).not.toContain(CANARY);
    },
  );

  it('rejects a non-table [env] without showing its value', () => {
    const message = rejection(`env = "${CANARY}"\n`);
    expect(message).toContain('env must be a table');
    expect(message).not.toContain(CANARY);
  });

  it('refuses [env] values in a file its group or others can read, and names the fix', () => {
    const message = rejection(`[env]\nTOKEN = "${CANARY}"\n`, 0o644);
    expect(message).toContain('its mode is 0644');
    expect(message).toContain('chmod 600');
    expect(message).not.toContain(CANARY);
    // An empty table holds no values, so a shared file stays loadable.
    const home = instance('[env]\n', 0o644);
    expect(loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').env.names).toEqual([]);
  });

  it.each([
    ['a stray token after a value', `[env]\nTOKEN = "${CANARY}" junk\n`],
    ['an unquoted value', `[env]\nTOKEN = ${CANARY}\n`],
    ['an unterminated string', `[env]\nTOKEN = "${CANARY}\n`],
    ['a redefined key', `[env]\nTOKEN = "${CANARY}"\nTOKEN = "${CANARY}"\n`],
  ])('reports malformed TOML (%s) by position without quoting the file', (_label, toml) => {
    const message = rejection(toml);
    expect(message).toContain('failed to parse TOML: Invalid TOML document:');
    expect(message).toMatch(/\(line \d+, column \d+\)/);
    expect(message).not.toContain(CANARY);
  });

  it('never shows values when the config is serialized, inspected or printed', () => {
    const home = instance(`[env]\nGITLAB_TOKEN = "${CANARY}"\n`);
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    for (const text of [JSON.stringify(config), inspect(config, { depth: null }), String(config.env), `${JSON.stringify({ ...config })}`]) {
      expect(text).not.toContain(CANARY);
    }
    expect(JSON.stringify(config.env)).toBe('{"names":["GITLAB_TOKEN"]}');
    expect(inspect(config.env)).toBe('ConfiguredEnvironment [GITLAB_TOKEN]');
    expect(Object.keys(config.env)).toEqual([]);
  });
});

describe('[env] at service boot', () => {
  it('leaves the environment and credential isolation unchanged without an [env] section', () => {
    const home = instance('[server]\nport = 0\n');
    const ambient: NodeJS.ProcessEnv = { GRU_COMMAND_HOME: home, PATH: '/usr/bin:/bin', OPENROUTER_API_KEY: KEY_CANARY, KEEP: 'kept' };
    const before = { ...ambient };
    const boot = bootServiceEnvironment(ambient, '/home/tester');
    const { OPENROUTER_API_KEY: _isolated, ...rest } = before;
    expect(ambient).toEqual(rest);
    expect(boot.decisionEnvironment).toEqual(before);
    expect(boot.supplied).toEqual([]);
    expect(boot.inherited).toEqual([]);
  });

  it('supplies unset names; an inherited value wins, an explicitly empty one too', () => {
    const home = instance([
      '[env]',
      `SYNTH_SUPPLIED = "${CANARY}"`,
      'SYNTH_INHERITED = "from-config"',
      'SYNTH_INHERITED_EMPTY = "from-config"',
      '',
    ].join('\n'));
    const ambient: NodeJS.ProcessEnv = { GRU_COMMAND_HOME: home, SYNTH_INHERITED: 'from-unit', SYNTH_INHERITED_EMPTY: '' };
    const boot = bootServiceEnvironment(ambient, '/home/tester');
    expect(ambient.SYNTH_SUPPLIED).toBe(CANARY);
    expect(ambient.SYNTH_INHERITED).toBe('from-unit');
    expect(ambient.SYNTH_INHERITED_EMPTY).toBe('');
    expect(boot.supplied).toEqual(['SYNTH_SUPPLIED']);
    expect(boot.inherited).toEqual(['SYNTH_INHERITED', 'SYNTH_INHERITED_EMPTY']);
  });

  it('routes an [env] provider key to the private decision environment only, never the ambient one children inherit', () => {
    const home = instance(`[env]\nOPENROUTER_API_KEY = "${KEY_CANARY}"\nTYPESAFE_API_KEY = "${KEY_CANARY}-typesafe"\nSYNTH_SUPPLIED = "${CANARY}"\n`);
    const ambient: NodeJS.ProcessEnv = { GRU_COMMAND_HOME: home, PATH: process.env['PATH'] };
    const boot = bootServiceEnvironment(ambient, '/home/tester');
    expect(boot.decisionEnvironment.OPENROUTER_API_KEY).toBe(KEY_CANARY);
    expect(boot.decisionEnvironment.TYPESAFE_API_KEY).toBe(`${KEY_CANARY}-typesafe`);
    expect(ambient.OPENROUTER_API_KEY).toBeUndefined();
    expect(ambient.TYPESAFE_API_KEY).toBeUndefined();
    expect(boot.supplied).toEqual(['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'SYNTH_SUPPLIED']);
    // A process started from the service environment sees the supplied
    // variable and no provider key.
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.SYNTH_SUPPLIED ?? null, process.env.OPENROUTER_API_KEY ?? null, process.env.TYPESAFE_API_KEY ?? null]))'], {
      env: ambient,
      encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([CANARY, null, null]);
  });

  it('keeps an inherited provider key over [env] and still isolates it', () => {
    const home = instance(`[env]\nOPENROUTER_API_KEY = "${KEY_CANARY}"\n`);
    const ambient: NodeJS.ProcessEnv = { GRU_COMMAND_HOME: home, OPENROUTER_API_KEY: 'from-unit' };
    const boot = bootServiceEnvironment(ambient, '/home/tester');
    expect(boot.decisionEnvironment.OPENROUTER_API_KEY).toBe('from-unit');
    expect(ambient.OPENROUTER_API_KEY).toBeUndefined();
    expect(boot.inherited).toEqual(['OPENROUTER_API_KEY']);
  });

  it('selects the instance from the inherited environment before reading [env], and refuses an invalid table before supplying anything', () => {
    const home = instance(`[env]\nSYNTH_SUPPLIED = "${CANARY}"\nNOT_STRING = 7\n`);
    const ambient: NodeJS.ProcessEnv = { GRU_COMMAND_HOME: home, OPENROUTER_API_KEY: KEY_CANARY };
    expect(() => bootServiceEnvironment(ambient, '/home/tester')).toThrow(/env\.NOT_STRING must be a string/);
    expect(ambient.SYNTH_SUPPLIED).toBeUndefined();
    // Isolation ran first, as before #494: a refused boot never re-exposes the key.
    expect(ambient.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('withConfiguredEnvironment returns a new object and leaves its input alone', () => {
    const home = instance(`[env]\nSYNTH_SUPPLIED = "${CANARY}"\nKEEP = "from-config"\n`);
    const configured = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').env;
    const inherited: NodeJS.ProcessEnv = { KEEP: 'inherited' };
    expect(withConfiguredEnvironment(configured, inherited)).toEqual({ KEEP: 'inherited', SYNTH_SUPPLIED: CANARY });
    expect(inherited).toEqual({ KEEP: 'inherited' });
  });
});

describe('[env] in the decisions CLI', () => {
  it('reports an [env] provider key as present from the environment, without printing it', () => {
    const home = instance(`[env]\nOPENROUTER_API_KEY = "${KEY_CANARY}"\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, GRU_COMMAND_HOME: home };
    delete env['OPENROUTER_API_KEY'];
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'dist', 'decisions', 'cli.js'), 'status', '--json'], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ credential_present: true, credential_source: 'environment', credential_state: 'present' });
    expect(`${result.stdout}${result.stderr}`).not.toContain(KEY_CANARY);
  });
});

describe('[env] in the generated config', () => {
  const values = {
    instanceDir: '/home/tester/.gru-command',
    workspaceRoot: '~/code',
    managedRepos: [],
    host: '127.0.0.1',
    port: 7665,
    token: 'token',
    runtime: 'claude-code' as const,
    model: 'default',
    thinkingLevel: 'default',
    roles: {},
  };

  it('ships a commented example on a fresh config', () => {
    const text = renderReferenceConfig(values);
    expect(text).toContain('# [env]\n');
    expect(text).toContain('# GITLAB_TOKEN = "replace-locally"');
    expect(text).not.toMatch(/^\[env\]$/m);
  });

  it('a wizard re-run writes [env] back, values intact, and keeps the file private', () => {
    const tricky = 'quote " backslash \\ newline \n tab \t unicode é';
    const home = instance([
      'workspace_root = "/tmp/gru-env-workspace"',
      '[env]',
      `GITLAB_TOKEN = "${CANARY}"`,
      `TRICKY = ${JSON.stringify(tricky)}`,
      'EMPTY = ""',
      '',
    ].join('\n'));
    const result = writeInstanceConfig({ instanceDir: home, answers: parseAnswers('{}', '/home/tester'), force: true, home: '/home/tester' });
    expect(result.backupPath).not.toBeNull();
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    expect(statSync(configPathFor(home)).mode & 0o777).toBe(0o600);
    const reloaded = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').env;
    expect(reloaded.entries()).toEqual([['GITLAB_TOKEN', CANARY], ['TRICKY', tricky], ['EMPTY', '']]);
    expect(readFileSync(configPathFor(home), 'utf-8')).toMatch(/^\[env\]$/m);
  });
});
