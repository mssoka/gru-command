import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Wizard OS-service registration step (Perkins r1 W9): the REAL built
 * wizard binary runs against a fixture repo root whose install.sh is a
 * recorder stub — proving the wizard invokes `bash <repo>/install.sh
 * --service` after a green path, and fails loud when registration fails.
 * (Service registration stays the E7 path — one mechanism, spec'd.)
 */

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

/** A runnable product-shaped repo root: real dist/, real node_modules
 * (symlink), stub install.sh that records its argv to a marker file. */
function buildFixture(exitCode: number): { fixture: string; marker: string; instance: string } {
  const stage = tempDir('gru-command-reg-');
  const fixture = join(stage, 'repo');
  const instance = join(stage, 'instance');
  mkdirSync(fixture, { recursive: true });
  mkdirSync(instance, { recursive: true });
  cpSync(join(repoRoot, 'dist'), join(fixture, 'dist'), { recursive: true });
  // The wizard's module graph reads the role prompt files at import —
  // the fixture repo root ships them like a real checkout.
  cpSync(join(repoRoot, 'roles'), join(fixture, 'roles'), { recursive: true });
  symlinkSync(join(repoRoot, 'node_modules'), join(fixture, 'node_modules'));
  const marker = join(stage, 'service-args.txt');
  writeFileSync(
    join(fixture, 'install.sh'),
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" > ${JSON.stringify(marker)}`,
      `exit ${exitCode}`,
      '',
    ].join('\n'),
    { encoding: 'utf-8', mode: 0o755 },
  );
  return { fixture, marker, instance };
}

function runWizard(fixture: string, instance: string, answers: string) {
  return spawnSync(
    process.execPath,
    [join(fixture, 'dist', 'wizard', 'main.js'), '--answers', answers],
    {
      env: {
        ...process.env,
        GRU_COMMAND_HOME: instance,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    },
  );
}

describe('wizard service registration (Perkins r1 W9)', () => {
  it('register_service spawns bash <repo>/install.sh --service (the E7 path, one mechanism)', () => {
    const { fixture, marker, instance } = buildFixture(0);
    const res = runWizard(fixture, instance, '{"register_service":true,"smoke":false,"port":0}');
    const out = `${res.stdout?.toString('utf-8') ?? ''}${res.stderr?.toString('utf-8') ?? ''}`;
    expect(res.status, out).toBe(0);
    // The stub ran with exactly the service-registration argv.
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf-8').trim()).toBe('--service');
    // And the wizard still wrote the config first.
    expect(existsSync(join(instance, 'config.toml'))).toBe(true);
  });

  it('a failing registration fails the wizard loud (named exit)', () => {
    const { fixture, marker, instance } = buildFixture(3);
    const res = runWizard(fixture, instance, '{"register_service":true,"smoke":false,"port":0}');
    expect(res.status).toBe(1);
    expect(res.stderr?.toString('utf-8') ?? '').toContain('service registration failed');
    expect(readFileSync(marker, 'utf-8').trim()).toBe('--service');
  });
});
