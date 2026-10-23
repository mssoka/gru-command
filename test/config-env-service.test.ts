import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { pickFreePort, startRealService } from './helpers/real-service.mjs';

/**
 * `[env]` (#494) through the compiled service, never the CLI: the boot
 * applies the table before its decision provider and its clients start,
 * children inherit it under the documented precedence, provider keys stay
 * private, and no value reaches a log, the ledger or an API answer. A
 * refused table stops a direct `node dist/main.js` before anything starts.
 * Synthetic values only; the decision provider is the offline fetch double.
 */

const repoRoot = join(import.meta.dirname, '..');
const mainJs = join(repoRoot, 'dist', 'main.js');
const fetchDouble = join(import.meta.dirname, 'helpers', 'jev-fetch-double.mjs');
const CANARY = 'SYNTHETIC-ENV-CANARY-494';
const KEY_CANARY = 'SYNTHETIC-PROVIDER-KEY-CANARY-494';
const LOSING = 'SYNTHETIC-OVERRIDDEN-CANARY-494';
const INHERITED_KEY = 'SYNTHETIC-INHERITED-PROVIDER-KEY-494';
const SECRETS = [CANARY, KEY_CANARY, LOSING, INHERITED_KEY];

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gru-command-env-service-'));
  cleanupDirs.push(root);
  return root;
}

/** A `git` that records the environment the service started it with, then
 * runs the real git: the fake consumer is a real production child. */
function recordingGit(binDir: string, record: string): void {
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'git'),
    [
      '#!/bin/sh',
      `printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${SYNTH_ENV_SUPPLIED-<unset>}" "\${SYNTH_ENV_INHERITED-<unset>}" "\${SYNTH_ENV_EMPTY-<unset>}" "\${OPENROUTER_API_KEY-<unset>}" "\${TYPESAFE_API_KEY-<unset>}" >> '${record}'`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

/** Every file under `dir` but the ones a test owns (the config itself and
 * the PATH doubles). */
function instanceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => path !== join(dir, 'config.toml') && !path.startsWith(join(dir, 'bin')));
}

describe('[env] in the compiled service boot (#494)', () => {
  it('supplies [env] before the decision provider and clients start, keeps provider keys private, and shows no value anywhere', async () => {
    const root = tempRoot();
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const record = join(root, 'git-env.tsv');
    const fetchLog = join(root, 'jev-fetch.jsonl');
    recordingGit(join(home, 'bin'), record);
    const service = await startRealService({
      port: await pickFreePort(),
      token: 'env-service-token',
      home,
      workspace,
      decisionsEnabled: true,
      nodeImport: fetchDouble,
      requireWebDist: false,
      captureOutput: true,
      // TYPESAFE_API_KEY: a provider key the service unit sets, isolated as before #494.
      extraEnv: { JEV_FETCH_LOG: fetchLog, SYNTH_ENV_INHERITED: 'from-service-unit', SYNTH_ENV_EMPTY: '', TYPESAFE_API_KEY: INHERITED_KEY },
      extraConfig: [
        '[env]',
        `SYNTH_ENV_SUPPLIED = "${CANARY}"`,
        `SYNTH_ENV_INHERITED = "${LOSING}"`,
        `SYNTH_ENV_EMPTY = "${LOSING}"`,
        `OPENROUTER_API_KEY = "${KEY_CANARY}"`,
      ],
    });
    const answers: string[] = [];
    try {
      const get = async (path: string): Promise<unknown> => {
        const response = await fetch(`${service.baseUrl}${path}`, { headers: { authorization: `Bearer ${service.token}` } });
        const text = await response.text();
        answers.push(text);
        return JSON.parse(text) as unknown;
      };
      // The decision provider's startup probe resolved the [env] key from
      // the private environment, while the service's own stayed key-free.
      expect(await get('/api/decisions/status')).toMatchObject({ status: 'ready', credentialPresent: true, credentialSource: 'environment' });
      const probes = readFileSync(fetchLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(probes[0]).toMatchObject({ authorizationPresent: true, ambientKeyPresent: false });
      // A client the service started inherited the supplied name; the
      // service unit's own values won, the empty one too; no provider key.
      await vi.waitFor(() => expect(existsSync(record)).toBe(true), { timeout: 30_000 });
      const seen = readFileSync(record, 'utf8').trim().split('\n').map((line) => line.split('\t'));
      expect(seen.length).toBeGreaterThan(0);
      for (const fields of seen) expect(fields).toEqual([CANARY, 'from-service-unit', '', '<unset>', '<unset>']);
      await get('/health');
      await get('/api/board');
    } finally {
      await service.stop();
    }
    for (const answer of answers) for (const secret of SECRETS) expect(answer).not.toContain(secret);
    // stdout and stderr: what launchd keeps as launchd.{out,err}.log.
    expect(service.output()).toContain('"msg":"boot"');
    for (const secret of SECRETS) expect(service.output()).not.toContain(secret);
    // The boot log names what [env] did, and only names.
    const bootLine = readFileSync(join(home, 'logs', 'service.log'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['msg'] === 'boot');
    expect(bootLine?.['config_env']).toEqual({
      supplied: ['SYNTH_ENV_SUPPLIED', 'OPENROUTER_API_KEY'],
      inherited: ['SYNTH_ENV_INHERITED', 'SYNTH_ENV_EMPTY'],
    });
    // Nothing the service wrote — logs, ledger, sessions — holds a value.
    const written = instanceFiles(home);
    expect(written).toContain(join(home, 'logs', 'service.log'));
    for (const file of written) {
      const bytes = readFileSync(file);
      for (const secret of SECRETS) expect(bytes.includes(secret), `${file} holds ${secret}`).toBe(false);
    }
  }, 90_000);

  it('a direct boot refuses an invalid [env] before any provider, client or instance state starts, naming the field and never the value', async () => {
    const root = tempRoot();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    // Jev on: a table that slipped through would start the provider probe
    // and the fetch double would record it.
    const header = `workspace_root = "${workspace}"\n[server]\nhost = "127.0.0.1"\nport = 0\n[decisions.jev]\nenabled = true\n`;
    const cases = [
      { label: 'non-string', toml: `[env]\nTOKEN = 7\nOTHER = "${CANARY}"\n`, field: 'env.TOKEN must be a string' },
      { label: 'bad-name', toml: `[env]\n"BAD NAME" = "${CANARY}"\n`, field: 'env name \\"BAD NAME\\" is not a valid environment variable name' },
      { label: 'nul', toml: `[env]\nTOKEN = "${CANARY}\\u0000"\n`, field: 'env.TOKEN must not contain a NUL character' },
      { label: 'reserved-home', toml: `[env]\nGRU_COMMAND_HOME = "${elsewhere}"\nOTHER = "${CANARY}"\n`, field: 'env.GRU_COMMAND_HOME is reserved' },
      { label: 'reserved-port', toml: `[env]\nGRU_SERVICE_PORT = "7665"\nOTHER = "${CANARY}"\n`, field: 'env.GRU_SERVICE_PORT is reserved' },
      { label: 'malformed', toml: `[env]\nTOKEN = "${CANARY}" trailing\n`, field: 'failed to parse TOML' },
      { label: 'shared-file', toml: `[env]\nTOKEN = "${CANARY}"\n`, field: 'its mode is 0644', mode: 0o644 },
    ];
    await Promise.all(cases.map(async ({ label, toml, field, mode }) => {
      const home = join(root, label);
      mkdirSync(home);
      writeFileSync(join(home, 'config.toml'), `${header}${toml}`, 'utf-8');
      chmodSync(join(home, 'config.toml'), mode ?? 0o600);
      const record = join(root, `${label}-git-env.tsv`);
      const fetchLog = join(root, `${label}-jev-fetch.jsonl`);
      recordingGit(join(root, `${label}-bin`), record);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GRU_COMMAND_HOME: home,
        GRU_SERVICE_PORT: '0',
        JEV_FETCH_LOG: fetchLog,
        NODE_OPTIONS: `--import=${fetchDouble}`,
        PATH: `${join(root, `${label}-bin`)}:${process.env['PATH'] ?? ''}`,
      };
      delete env['OPENROUTER_API_KEY'];
      const child = spawn(process.execPath, [mainJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      // A boot that wrongly accepted the table would keep running: bound it.
      const code = await new Promise<number | null | 'running'>((resolveExit) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit('running'); }, 20_000);
        child.once('exit', (exitCode) => { clearTimeout(timer); resolveExit(exitCode); });
      });
      expect(code, `${label}: ${output}`).toBe(1);
      expect(output, label).toContain('configuration invalid — refusing to start');
      expect(output, label).toContain(field);
      for (const secret of SECRETS) expect(output, label).not.toContain(secret);
      // Refused before the provider probe, any child client, or instance state.
      expect(existsSync(fetchLog), label).toBe(false);
      expect(existsSync(record), label).toBe(false);
      expect(readdirSync(home), label).toEqual(['config.toml']);
    }));
    expect(readdirSync(elsewhere)).toEqual([]);
  }, 90_000);
});
