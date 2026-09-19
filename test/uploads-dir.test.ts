import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseListeningPort } from '../src/wizard/main.js';

/**
 * Uploads-dir scaffolding (E9 / SPEC ruling 19): boot creates
 * <data_dir>/uploads/ next to logs/ and chat/ — directory creation only.
 * Spawns the BUILT dist/main.js on a fixture instance dir, confirms
 * liveness briefly, then asserts the directory and a clean shutdown.
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('uploads dir scaffolding (SPEC ruling 19)', () => {
  it('boot creates <data_dir>/uploads/ and logs an uploads_dir boot line', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-uploads-'));
    cleanupDirs.push(home);
    writeFileSync(join(home, 'config.toml'), '[server]\nhost = "127.0.0.1"\nport = 0\n', 'utf-8');

    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'main.js')], {
      env: { ...process.env, GRU_COMMAND_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    try {
      const deadline = Date.now() + 20_000;
      let port: number | null = null;
      while (port === null) {
        port = parseListeningPort(stderr);
        if (port !== null) break;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`service exited early — stderr:\n${stderr.slice(-1_000)}`);
        }
        if (Date.now() > deadline) throw new Error(`service never listened — stderr:\n${stderr.slice(-1_000)}`);
        await new Promise((wake) => setTimeout(wake, 150));
      }

      // Liveness briefly (the boot completed far enough to serve /health)
      // and the structured uploads_dir boot line is on the log stream.
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(res.ok).toBe(true);
      // The FULL smoke oracle, not just res.ok (Perkins r1 W8): the
      // default suite boots the real service, so it asserts the same
      // three liveness signals + fingerprint the wizard's smoke does.
      const health = (await res.json()) as {
        identity?: { install_id?: unknown };
        liveness?: {
          signals?: {
            health_reachable?: { value?: unknown };
            agent_session?: { state?: unknown };
            session_growth?: { value?: unknown };
          };
        };
      };
      expect(health.liveness?.signals?.health_reachable?.value).toBe(true);
      expect(typeof health.liveness?.signals?.agent_session?.state).toBe('string');
      expect(health.liveness?.signals?.session_growth?.value).toBeDefined();
      expect(typeof health.identity?.install_id).toBe('string');
      expect(stderr).toContain('"msg":"uploads_dir"');
      expect(stderr).toContain(join(home, 'uploads'));

      // The scaffolding itself: directory creation only, instance state
      // under the data dir (ruling 7).
      expect(existsSync(join(home, 'uploads'))).toBe(true);
      expect(existsSync(join(home, 'logs'))).toBe(true);

      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);

  it('uploads-path obstruction fails boot LOUD and named (exit 1, no raw stack) — Perkins r1 W14', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-uploads-block-'));
    cleanupDirs.push(home);
    writeFileSync(join(home, 'config.toml'), '[server]\nhost = "127.0.0.1"\nport = 0\n', 'utf-8');
    // A FILE named uploads blocks the directory scaffolding.
    writeFileSync(join(home, 'uploads'), 'not a directory', 'utf-8');

    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'main.js')], {
      env: { ...process.env, GRU_COMMAND_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('exit', (code) => resolveExit(code));
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('uploads dir creation failed');
    expect(stderr).toContain(join(home, 'uploads'));
  }, 30_000);
});
