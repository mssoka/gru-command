import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, configPathFor, loadConfig, MAX_ENV_TABLE_BYTES } from '../src/config.js';
import { renderReferenceConfig } from '../src/config-reference.js';
import { bootServiceEnvironment, withConfiguredEnvironment } from '../src/service-environment.js';
import { parseAnswers } from '../src/wizard/answers.js';
import { writeConfigText, writeInstanceConfig } from '../src/wizard/steps.js';

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

  it('rejects a non-string value, naming the field and never the value', () => {
    for (const [line, expected] of [
      ['TOKEN = 42', 'env.TOKEN must be a string, got number'],
      ['TOKEN = true', 'env.TOKEN must be a string, got boolean'],
      [`TOKEN = ["${CANARY}"]`, 'env.TOKEN must be a string, got object'],
      [`TOKEN = { value = "${CANARY}" }`, 'env.TOKEN must be a string, got object'],
      ['TOKEN = 2026-10-23T00:00:00Z', 'env.TOKEN must be a string, got object'],
    ] as const) {
      const message = rejection(`[env]\n${line}\n`);
      expect(message, line).toContain(expected);
      expect(message, line).not.toContain(CANARY);
    }
  });

  it('rejects an invalid environment name', () => {
    for (const name of ['1STARTS_WITH_DIGIT', 'HAS SPACE', 'A=B', 'DASHED-NAME', '']) {
      const message = rejection(`[env]\n${JSON.stringify(name)} = "${CANARY}"\n`);
      expect(message, name).toContain(`env name ${JSON.stringify(name)} is not a valid environment variable name`);
      expect(message, name).not.toContain(CANARY);
    }
  });

  it('rejects a NUL character in a value without showing it', () => {
    const message = rejection(`[env]\nTOKEN = "${CANARY}\\u0000tail"\n`);
    expect(message).toContain('env.TOKEN must not contain a NUL character');
    expect(message).not.toContain(CANARY);
  });

  it('refuses reserved GRU_* names: [env] can never select the instance or carry GC authority', () => {
    for (const name of ['GRU_COMMAND_HOME', 'GRU_SERVICE_PORT', 'GRU_LANE_TOKEN', 'gru_command_home', 'HOME', 'home']) {
      const message = rejection(`[env]\n${name} = "${CANARY}"\n`);
      expect(message, name).toContain(`env.${name} is reserved`);
      expect(message, name).not.toContain(CANARY);
    }
  });

  it('refuses an [env] too large for the processes the service starts to launch, and accepts one at the limit', () => {
    // `NAME=value` plus its terminator, summed over the table.
    const fill = (bytes: number) => `${CANARY}${'x'.repeat(bytes - CANARY.length)}`;
    const atLimit = fill(MAX_ENV_TABLE_BYTES - 'BIG='.length - 1);
    const home = instance(`[env]\nBIG = "${atLimit}"\n`);
    expect(loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').env.names).toEqual(['BIG']);
    const message = rejection(`[env]\nBIG = "${atLimit}"\nMORE = "x"\n`);
    expect(message).toContain(`[env] holds ${MAX_ENV_TABLE_BYTES + 'MORE=x'.length + 1} bytes of names and values, over the ${MAX_ENV_TABLE_BYTES}-byte limit`);
    expect(message).not.toContain(CANARY);
  });

  it('rejects a non-table [env] without showing its value', () => {
    const message = rejection(`env = "${CANARY}"\n`);
    expect(message).toContain('env must be a table');
    expect(message).not.toContain(CANARY);
  });

  it('refuses [env] values in a file its group or others can read, and names the fix', () => {
    const message = rejection(`[env]\nTOKEN = "${CANARY}"\n`, 0o644);
    expect(message).toContain('its mode is 0644');
    expect(message).toMatch(/run: chmod 600 \/\S+\/config\.toml \(file:/);
    expect(message).not.toContain(CANARY);
    // The command pastes as one word when the instance path has a space.
    const spaced = mkdtempSync(join(tmpdir(), "gru command env's-"));
    cleanupDirs.push(spaced);
    writeFileSync(configPathFor(spaced), `[env]\nTOKEN = "${CANARY}"\n`, { encoding: 'utf-8' });
    chmodSync(configPathFor(spaced), 0o644);
    expect(() => loadConfig({ GRU_COMMAND_HOME: spaced }, '/home/tester')).toThrow(
      `run: chmod 600 '${configPathFor(spaced).replaceAll("'", "'\\''")}'`,
    );
    // An empty table holds no values, so a shared file stays loadable.
    const home = instance('[env]\n', 0o644);
    expect(loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').env.names).toEqual([]);
  });

  it('reports malformed TOML by position without quoting the file', () => {
    for (const toml of [
      `[env]\nTOKEN = "${CANARY}" junk\n`,
      `[env]\nTOKEN = ${CANARY}\n`,
      `[env]\nTOKEN = "${CANARY}\n`,
      `[env]\nTOKEN = "${CANARY}"\nTOKEN = "${CANARY}"\n`,
    ]) {
      const message = rejection(toml);
      expect(message, toml).toContain('failed to parse TOML: Invalid TOML document:');
      expect(message, toml).toMatch(/\(line \d+, column \d+\)/);
      expect(message, toml).not.toContain(CANARY);
    }
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

  it('supplies names that shadow Object.prototype members like any other name', () => {
    const home = instance(`[env]\ntoString = "${CANARY}"\nconstructor = "${CANARY}"\n`);
    const ambient: NodeJS.ProcessEnv = { GRU_COMMAND_HOME: home };
    const boot = bootServiceEnvironment(ambient, '/home/tester');
    expect(boot.supplied).toEqual(['toString', 'constructor']);
    expect(boot.inherited).toEqual([]);
    expect(Object.hasOwn(ambient, 'toString') && ambient['toString']).toBe(CANARY);
    expect(withConfiguredEnvironment(loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').env, {})['constructor']).toBe(CANARY);
  });

  it('withConfiguredEnvironment returns a new object and leaves its input alone', () => {
    const home = instance(`[env]\nSYNTH_SUPPLIED = "${CANARY}"\nKEEP = "from-config"\n`);
    const configured = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester').env;
    const inherited: NodeJS.ProcessEnv = { KEEP: 'inherited' };
    expect(withConfiguredEnvironment(configured, inherited)).toEqual({ KEEP: 'inherited', SYNTH_SUPPLIED: CANARY });
    expect(inherited).toEqual({ KEEP: 'inherited' });
  });
});

describe('[env] and the processes the service starts', () => {
  it('ps reads the service environment as it is when it runs: no isolated provider key, [env] names present', () => {
    const module = join(import.meta.dirname, '..', 'dist', 'runtime', 'review-host-exit.js');
    const script = [
      `const { psEnvironment } = await import(${JSON.stringify(module)});`,
      // The boot step runs after every import: isolate, then supply.
      'delete process.env.OPENROUTER_API_KEY;',
      `process.env.SYNTH_SUPPLIED = ${JSON.stringify(CANARY)};`,
      'const env = psEnvironment();',
      'process.stdout.write(JSON.stringify([env.OPENROUTER_API_KEY ?? null, env.SYNTH_SUPPLIED ?? null, env.TZ]));',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { PATH: process.env['PATH'], OPENROUTER_API_KEY: KEY_CANARY },
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([null, CANARY, 'UTC']);
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

describe('[env] in the decisions CLI check', () => {
  it('check resolves an [env] provider key for the default and a named profile, privately and without printing it', () => {
    const home = instance(`[decisions.jev]\nenabled = true\n[env]\nOPENROUTER_API_KEY = "${KEY_CANARY}"\n`);
    const fetchLog = join(home, 'jev-fetch.jsonl');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GRU_COMMAND_HOME: home,
      JEV_FETCH_LOG: fetchLog,
      NODE_OPTIONS: `--import=${join(import.meta.dirname, 'helpers', 'jev-fetch-double.mjs')}`,
    };
    delete env['OPENROUTER_API_KEY'];
    const cli = join(import.meta.dirname, '..', 'dist', 'decisions', 'cli.js');
    for (const args of [['check', '--json'], ['check', '--profile', 'openrouter-jev', '--json']]) {
      const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 20_000 });
      expect(result.status, `${args.join(' ')}: ${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout), args.join(' ')).toMatchObject({ ok: true, status: 'ready' });
      expect(`${result.stdout}${result.stderr}`).not.toContain(KEY_CANARY);
    }
    const probes = readFileSync(fetchLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(probes.length).toBeGreaterThanOrEqual(2);
    for (const probe of probes) expect(probe).toMatchObject({ authorizationPresent: true, ambientKeyPresent: false });
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

  it('a generated config that fails its TOML self-check is reported without quoting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-env-selfcheck-'));
    cleanupDirs.push(dir);
    expect(() => writeConfigText(dir, `[env]\nTOKEN = "${CANARY}" junk\n`)).toThrow(/generated config failed its TOML self-check: Invalid TOML document: .* \(line 2, column \d+\)/);
    try {
      writeConfigText(dir, `[env]\nTOKEN = "${CANARY}" junk\n`);
    } catch (error) {
      expect((error as Error).message).not.toContain(CANARY);
    }
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
