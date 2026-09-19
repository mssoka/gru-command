import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { loadConfig, ROLES, RUNTIME_IDS } from '../src/config.js';
import { renderDecisionsConfig } from '../src/config-template.js';
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

function run(
  instance: string,
  cli: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [join(repoRoot, 'dist', 'cli', 'config-generate.js'), ...args],
    {
      env: {
        ...process.env,
        ...env,
        GRU_COMMAND_HOME: instance,
        GRU_COMMAND_TEST_DECISIONS_CLI: cli,
      },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );
}

describe('config-generate CLI', () => {
  it('writes the complete teaching config to the actual application read path', () => {
    const root = tempDir('gru-command-config-generate-');
    const instance = join(root, 'instance');
    const cli = writeDecisionsCliFixture(join(root, 'cli'));
    const result = run(instance, cli);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const file = join(instance, 'config.toml');
    const text = readFileSync(file, 'utf-8');
    const raw = parse(text) as Record<string, unknown>;

    expect(Object.keys(raw)).toEqual([
      'workspace_root',
      'data_dir',
      'server',
      'auth',
      'runtimes',
      'models',
      'thinking',
      'supervision',
      'logging',
      'chat',
      'worktrees',
      'dispatch',
    ]);
    for (const section of [
      '[server]',
      '[auth]',
      '[runtimes]',
      '[models]',
      '[thinking]',
      '[supervision]',
      '[logging]',
      '[chat]',
      '[worktrees]',
      '[dispatch]',
      '[decisions.jev]',
    ]) {
      expect(text).toContain(section);
    }
    for (const role of ROLES) {
      expect(text).toContain(`# ${role} =`);
    }
    for (const runtime of RUNTIME_IDS) {
      expect(text).toContain(`[runtimes.${runtime}]`);
      expect(text).toContain(`[runtimes.${runtime}.roles]`);
    }
    expect(text).toContain('# This is the live file read from <instance>/config.toml');
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const loaded = loadConfig({ GRU_COMMAND_HOME: instance }, root);
    expect(loaded.sourceFile).toBe(file);
    expect(loaded.dataDir).toBe(instance);
    expect(loaded.models.default).toBe('default');
    expect(loaded.thinking.default).toBe('default');
    expect(loaded.supervision).toMatchObject({
      enabled: true,
      turnSilenceMs: 900_000,
      restartWindowMs: 600_000,
      maxRestarts: 3,
      restartBackoffMs: 2_000,
    });
  });

  it('writes an active enabled Jev table when --enable-jev is explicit', () => {
    const root = tempDir('gru-command-config-jev-enabled-');
    const instance = join(root, 'instance');
    const cli = writeDecisionsCliFixture(join(root, 'cli'));
    const result = run(instance, cli, ['--enable-jev'], {
      JEV_FIXTURE_ACTIVE_CONFIG: '1',
      JEV_FIXTURE_BAD_CHECK: '1',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('Jev readiness: degraded');
    const raw = parse(readFileSync(join(instance, 'config.toml'), 'utf-8')) as {
      decisions?: { jev?: { enabled?: unknown } };
    };
    expect(raw.decisions?.jev?.enabled).toBe(true);
  });

  it('rejects a mismatched active Jev section without reflecting child stderr', () => {
    const instance = tempDir('gru-command-generate-bad-jev-');
    const badCli = join(instance, 'bad-decisions-cli.mjs');
    writeFileSync(
      badCli,
      `process.stderr.write('CHILD-SECRET-MUST-NOT-REFLECT\\n'); process.stdout.write('[decisions.jev]\\nenabled = false\\n');`,
      'utf-8',
    );
    const result = run(instance, badCli, ['--enable-jev']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not emit an active enabled = true');
    expect(result.stderr).not.toContain('CHILD-SECRET-MUST-NOT-REFLECT');
    expect(existsSync(join(instance, 'config.toml'))).toBe(false);
  });

  it('bounds a hung decisions config CLI with a named timeout', () => {
    const instance = tempDir('gru-command-generate-jev-timeout-');
    const slowCli = join(instance, 'slow-decisions-cli.mjs');
    writeFileSync(slowCli, `setTimeout(() => {}, 10_000);`, 'utf-8');
    expect(() =>
      renderDecisionsConfig({
        repoRoot,
        instanceDir: instance,
        enabled: false,
        cliPath: slowCli,
        timeoutMs: 25,
      }),
    ).toThrow(/timed out after 25ms/);
  });

  it('refuses overwrite without --force and creates a timestamped 0600 backup with force', () => {
    const root = tempDir('gru-command-config-force-');
    const instance = join(root, 'instance');
    const cli = writeDecisionsCliFixture(join(root, 'cli'));
    expect(run(instance, cli).status).toBe(0);
    const before = readFileSync(join(instance, 'config.toml'), 'utf-8');

    const refused = run(instance, cli);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('without --force');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe(before);

    const forced = run(instance, cli, ['--force']);
    expect(forced.status, `${forced.stdout}\n${forced.stderr}`).toBe(0);
    const backup = forced.stdout.match(/Previous configuration backed up: (.+)/)?.[1]?.trim();
    expect(backup).toMatch(/config\.toml\.backup-\d{8}T\d{6}\d{3}Z$/);
    expect(statSync(backup!).mode & 0o777).toBe(0o600);
    expect(readFileSync(backup!, 'utf-8')).toBe(before);
  });
});
