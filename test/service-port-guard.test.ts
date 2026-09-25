import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig, ConfigError, DEFAULT_INSTANCE_PORT } from '../src/config.js';
import {
  assertWorktreeListenPort,
  inWorktreeContext,
  isLinkedWorktree,
  WORKTREE_CONTEXT_ENV,
  WorktreePortSquatRefused,
} from '../src/service-port-guard.js';
import {
  assertSafeTestServicePort,
  INSTANCE_PORT,
  parseListeningPort,
  pickFreePort,
} from './helpers/real-service.mjs';

/**
 * Worktree port-squat prevention, item 1 (owner incident 2026-09-23):
 * e2e/test-spawned services must never bind the instance port.
 *
 *  - the harness-side guard refuses the instance port and privileged ports
 *    for any spawned service;
 *  - the service-side assertion refuses a worktree-context listen on the
 *    configured instance port (or any fixed port not explicitly handed in
 *    via GRU_SERVICE_PORT) before anything binds;
 *  - the end-to-end spawns prove the contract: worktree-context + port 0
 *    picks an ephemeral port; worktree-context + port 7665 refuses LOUD.
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

describe('wake boot ordering', () => {
  it('binds backlog wake only after the HTTP listener, board routes and post-bind foreign-listener check', () => {
    const source = readFileSync(join(repoRoot, 'src', 'main.ts'), 'utf-8');
    const bind = source.indexOf('awareness.setWakeSink(() => chat.wakeAwareness())');
    const listen = source.indexOf('state.handle = await service.start()');
    const routes = source.indexOf('board.attach(handle.httpServer)');
    const foreign = source.indexOf('const foreign = await instancePortForeignListener(config)', listen);
    for (const prerequisite of [bind, listen, routes, foreign]) expect(prerequisite).toBeGreaterThanOrEqual(0);
    expect(bind).toBeGreaterThan(routes);
    expect(bind).toBeGreaterThan(foreign);
    expect(source.indexOf('awareness.setWakeSink(', bind + 1)).toBe(-1);
  });
});

describe('the harness guard (test/e2e spawned services)', () => {
  it('pins the harness instance-port literal against the product default', () => {
    expect(INSTANCE_PORT).toBe(DEFAULT_INSTANCE_PORT);
  });

  it('refuses the instance port, privileged ports, and junk; allows 0 and high ports', () => {
    expect(() => assertSafeTestServicePort(DEFAULT_INSTANCE_PORT)).toThrow(/instance port 7665/);
    expect(() => assertSafeTestServicePort(80)).toThrow(/privileged port/);
    expect(() => assertSafeTestServicePort(Number.NaN)).toThrow(/integer 0-65535/);
    expect(() => assertSafeTestServicePort(0)).not.toThrow();
    expect(() => assertSafeTestServicePort(7790)).not.toThrow();
  });
});

describe('worktree context detection', () => {
  it('a linked worktree has .git as a FILE; the main checkout has it as a directory', () => {
    const main = tempDir('gru-command-guard-main-');
    mkdirSync(join(main, '.git'));
    const linked = tempDir('gru-command-guard-linked-');
    writeFileSync(join(linked, '.git'), 'gitdir: /somewhere/.git/worktrees/linked\n', 'utf-8');
    const bare = tempDir('gru-command-guard-bare-');
    expect(isLinkedWorktree(main)).toBe(false);
    expect(isLinkedWorktree(linked)).toBe(true);
    expect(isLinkedWorktree(bare)).toBe(false);
  });

  it('the explicit marker forces context on/off; otherwise detection decides', () => {
    const main = tempDir('gru-command-guard-ctx-main-');
    mkdirSync(join(main, '.git'));
    const linked = tempDir('gru-command-guard-ctx-linked-');
    writeFileSync(join(linked, '.git'), 'gitdir: /somewhere\n', 'utf-8');
    expect(inWorktreeContext({ checkoutRoot: main, env: { [WORKTREE_CONTEXT_ENV]: '1' } })).toBe(true);
    expect(inWorktreeContext({ checkoutRoot: linked, env: { [WORKTREE_CONTEXT_ENV]: '0' } })).toBe(false);
    expect(inWorktreeContext({ checkoutRoot: linked, env: {} })).toBe(true);
    expect(inWorktreeContext({ checkoutRoot: main, env: {} })).toBe(false);
  });
});

describe('the service-side assertion (refuses to listen on the instance port from a worktree)', () => {
  const checkoutRoot = '/fixture/worktree';

  it('is a no-op outside a worktree context — a normal checkout keeps its configured port', () => {
    expect(() =>
      assertWorktreeListenPort({
        checkoutRoot,
        port: DEFAULT_INSTANCE_PORT,
        env: {},
        worktreeContext: false,
      }),
    ).not.toThrow();
  });

  it('always allows an ephemeral bind', () => {
    expect(() =>
      assertWorktreeListenPort({ checkoutRoot, port: 0, env: {}, worktreeContext: true }),
    ).not.toThrow();
  });

  it('NEVER binds the instance port from a worktree — even with the env override', () => {
    expect(() =>
      assertWorktreeListenPort({ checkoutRoot, port: DEFAULT_INSTANCE_PORT, env: {}, worktreeContext: true }),
    ).toThrowError(/instance port 7665/);
    expect(() =>
      assertWorktreeListenPort({
        checkoutRoot,
        port: DEFAULT_INSTANCE_PORT,
        env: { GRU_SERVICE_PORT: String(DEFAULT_INSTANCE_PORT) },
        worktreeContext: true,
      }),
    ).toThrowError(WorktreePortSquatRefused);
  });

  it('refuses a fixed port that came from configuration, not an explicit override', () => {
    expect(() =>
      assertWorktreeListenPort({ checkoutRoot, port: 7790, env: {}, worktreeContext: true }),
    ).toThrowError(/explicit override/);
    expect(() =>
      assertWorktreeListenPort({
        checkoutRoot,
        port: 7790,
        env: { GRU_SERVICE_PORT: '7790' },
        worktreeContext: true,
      }),
    ).not.toThrow();
  });

  it('refuses a privileged port handed in via the override', () => {
    expect(() =>
      assertWorktreeListenPort({
        checkoutRoot,
        port: 80,
        env: { GRU_SERVICE_PORT: '80' },
        worktreeContext: true,
      }),
    ).toThrowError(/privileged port 80/);
  });

  it('loadConfig applies GRU_SERVICE_PORT explicitly and fails loud on junk', () => {
    const home = tempDir('gru-command-guard-cfg-');
    writeFileSync(configPathFor(home), '[server]\nhost = "127.0.0.1"\nport = 7790\n', 'utf-8');
    expect(loadConfig({ GRU_COMMAND_HOME: home, GRU_SERVICE_PORT: '41234' }, '/home/tester').server).toEqual({
      host: '127.0.0.1',
      port: 41234,
    });
    expect(() => loadConfig({ GRU_COMMAND_HOME: home, GRU_SERVICE_PORT: 'soon' }, '/home/tester')).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ GRU_COMMAND_HOME: home, GRU_SERVICE_PORT: '70000' }, '/home/tester')).toThrow(
      /GRU_SERVICE_PORT must be an integer between 0 and 65535/,
    );
  });
});

function spawnService(home: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [join(repoRoot, 'dist', 'main.js')], {
    env: { ...process.env, GRU_COMMAND_HOME: home, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });
  return { child, getStderr: () => stderr };
}

async function waitForPort(stderr: () => string, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const port = parseListeningPort(stderr());
    if (port !== null) return port;
    if (Date.now() > deadline) throw new Error(`service never listened — stderr:\n${stderr().slice(-1_000)}`);
    await new Promise((wake) => setTimeout(wake, 100));
  }
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.status;
    } catch {
      if (Date.now() > deadline) throw new Error(`service never answered /health on port ${port}`);
      await new Promise((wake) => setTimeout(wake, 100));
    }
  }
}

describe('worktree-context service spawns (the acceptance shape)', () => {
  it('spawns from a worktree context, picks an EPHEMERAL port, and never touches 7665', async () => {
    const home = tempDir('gru-command-guard-spawn-ephemeral-');
    writeFileSync(configPathFor(home), '[server]\nhost = "127.0.0.1"\nport = 0\n', 'utf-8');
    const { child, getStderr } = spawnService(home, { [WORKTREE_CONTEXT_ENV]: '1' });
    try {
      const port = await waitForPort(getStderr);
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(DEFAULT_INSTANCE_PORT);
      expect(await waitForHealth(port)).toBe(200);
      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);

  it('REFUSES a worktree-context listen on the configured instance port — loud, named, before binding', async () => {
    const home = tempDir('gru-command-guard-spawn-squat-');
    writeFileSync(
      configPathFor(home),
      `[server]\nhost = "127.0.0.1"\nport = ${DEFAULT_INSTANCE_PORT}\n`,
      'utf-8',
    );
    const { child, getStderr } = spawnService(home, { [WORKTREE_CONTEXT_ENV]: '1' });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('exit', (code) => resolveExit(code));
    });
    expect(exitCode).toBe(1);
    expect(getStderr()).toContain('refusing to listen from a worktree checkout');
    expect(getStderr()).toContain(`instance port ${DEFAULT_INSTANCE_PORT}`);
    expect(existsSync(join(home, 'logs'))).toBe(false); // refused before any instance state
  }, 30_000);

  it('honors an explicit GRU_SERVICE_PORT override from a worktree context', async () => {
    const home = tempDir('gru-command-guard-spawn-override-');
    const port = await pickFreePort();
    writeFileSync(configPathFor(home), '[server]\nhost = "127.0.0.1"\nport = 0\n', 'utf-8');
    const { child, getStderr } = spawnService(home, {
      [WORKTREE_CONTEXT_ENV]: '1',
      GRU_SERVICE_PORT: String(port),
    });
    try {
      const listening = await waitForPort(getStderr);
      expect(listening).toBe(port);
      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);
});
