import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkJev, persistJevCredential, readJevStatus } from '../src/wizard/jev-setup.js';
import { writeDecisionsCliFixture } from './helpers/decisions-cli.js';

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function runWizard(
  instance: string,
  cliPath: string,
  answers: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      join(repoRoot, 'dist', 'wizard', 'main.js'),
      '--no-interact',
      '--answers',
      JSON.stringify(answers),
    ],
    {
      env: {
        ...process.env,
        ...env,
        GRU_COMMAND_HOME: instance,
        GRU_COMMAND_TEST_DECISIONS_CLI: cliPath,
      },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    },
  );
}

describe('Jev installer-side CLI contract', () => {
  it('passes credentials only through child stdin and exposes sanitized status/check results', () => {
    const root = tempDir('gru-command-jev-adapter-');
    const instance = join(root, 'instance');
    const cliPath = writeDecisionsCliFixture(join(root, 'cli'));
    const log = join(root, 'ops.log');
    const secret = 'sk-or-v1-private-fixture';
    const options = {
      repoRoot,
      instanceDir: instance,
      cliPath,
      env: { JEV_FIXTURE_LOG: log },
    };

    persistJevCredential(options, secret);
    const status = readJevStatus(options);
    expect(status).toMatchObject({ credential_present: true, credential_source: 'file' });
    const degraded = checkJev({
      ...options,
      env: { JEV_FIXTURE_LOG: log, JEV_FIXTURE_DEGRADED: '1' },
    });
    expect(degraded).toEqual({ ok: false, status: 'degraded', reason: 'provider_unavailable' });

    expect(readFileSync(join(instance, 'credentials', 'openrouter.key'), 'utf-8')).toBe(
      `${secret}\n`,
    );
    expect(statSync(join(instance, 'credentials', 'openrouter.key')).mode & 0o777).toBe(0o600);
    const operations = readFileSync(log, 'utf-8');
    expect(operations).toContain('credentials set --stdin');
    expect(operations).toContain('status --json');
    expect(operations).toContain('check --json');
    expect(operations).not.toContain(secret);
  });

  it('disabled non-interactive setup performs no status, credential, or check operation', () => {
    const root = tempDir('gru-command-jev-disabled-');
    const instance = join(root, 'instance');
    const cliPath = writeDecisionsCliFixture(join(root, 'cli'));
    const log = join(root, 'ops.log');
    const result = runWizard(
      instance,
      cliPath,
      { smoke: false, port: 0, token: 'pairing-only' },
      { JEV_FIXTURE_LOG: log },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(log, 'utf-8').trim()).toBe('config-template');
  });

  it('reports malformed readiness output as degraded without aborting completed setup', () => {
    const root = tempDir('gru-command-jev-malformed-readiness-');
    const instance = join(root, 'instance');
    const cliPath = writeDecisionsCliFixture(join(root, 'cli'));
    const result = runWizard(
      instance,
      cliPath,
      { smoke: false, port: 0, token: 'pairing-only', jev_enabled: true },
      { JEV_FIXTURE_BAD_STATUS: '1' },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain('Jev readiness: degraded');
    expect(output).toContain('Gru Command remains usable with deterministic fallback');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toContain('token = "pairing-only"');
  });

  it('persists an explicitly approved environment key without leaking it to config, argv, output, or backups', () => {
    const root = tempDir('gru-command-jev-persist-');
    const instance = join(root, 'instance');
    const cliPath = writeDecisionsCliFixture(join(root, 'cli'));
    const log = join(root, 'ops.log');
    const envLog = join(root, 'child-env.log');
    const secret = 'sk-or-v1-never-print-this';
    const env = {
      JEV_FIXTURE_LOG: log,
      JEV_FIXTURE_ENV_LOG: envLog,
      JEV_FIXTURE_READY: '1',
      OPENROUTER_API_KEY: secret,
    };
    const answers = {
      smoke: false,
      port: 0,
      token: 'pairing-token',
      jev_enabled: true,
      persist_env_credential: true,
    };
    const first = runWizard(instance, cliPath, answers, env);
    const firstOutput = `${first.stdout}\n${first.stderr}`;
    expect(first.status, firstOutput).toBe(0);
    expect(firstOutput).toContain('Jev readiness: ready');
    expect(firstOutput).not.toContain(secret);
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).not.toContain(secret);
    expect(readFileSync(log, 'utf-8')).not.toContain(secret);
    expect(readFileSync(envLog, 'utf-8').split('\n').filter(Boolean)).not.toContain('present');

    const second = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'dist', 'wizard', 'main.js'),
        '--no-interact',
        '--force',
        '--answers',
        JSON.stringify({ smoke: false, port: 0, token: 'new-pairing-token' }),
      ],
      {
        env: {
          ...process.env,
          GRU_COMMAND_HOME: instance,
          GRU_COMMAND_TEST_DECISIONS_CLI: cliPath,
        },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      },
    );
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    const backup = second.stdout.match(/Previous config backed up: (.+)/)?.[1]?.trim();
    expect(backup).toBeDefined();
    expect(readFileSync(backup!, 'utf-8')).not.toContain(secret);
    expect(readFileSync(join(instance, 'credentials', 'openrouter.key'), 'utf-8')).toBe(
      `${secret}\n`,
    );
  });
});
