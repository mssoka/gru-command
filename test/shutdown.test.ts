import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPathFor } from '../src/config.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

interface LogLine {
  level: string;
  msg: string;
  [key: string]: unknown;
}

function readLogLines(home: string): LogLine[] {
  const logFile = join(home, 'logs', 'service.log');
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogLine);
}

function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const value = probe();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${what}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function spawnService(home: string) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, GRU_COMMAND_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });
  return { child, getStderr: () => stderr };
}

async function waitForHealthyPort(home: string, stderr: () => string): Promise<number> {
  return waitFor(
    () => {
      const listening = readLogLines(home).find((line) => line.msg === 'listening');
      if (listening === undefined) return undefined;
      return listening['port'] as number;
    },
    15_000,
    `service listening (stderr: ${stderr()})`,
  );
}

describe('graceful shutdown', () => {
  it('a corrupt chat frame log refuses boot — named, before listening', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-corruptlog-'));
    cleanupDirs.push(home);
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n',
      'utf-8',
    );
    // Mid-file corruption in the durable frame log (garbage BETWEEN two
    // valid lines): boot must fail loud naming the file, and must never
    // report listening (r2 W6': the load runs before the server accepts
    // anything).
    mkdirSync(join(home, 'chat'), { recursive: true });
    writeFileSync(
      join(home, 'chat', 'gru.frames.jsonl'),
      '{"type":"turn","state":"start","seq":1}\nGARBAGE\n{"type":"turn","state":"end","seq":3}\n',
      'utf-8',
    );

    const { child, getStderr } = spawnService(home);
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('exit', (code) => resolveExit(code));
    });
    expect(exitCode).not.toBe(0);
    expect(getStderr()).toContain('chat frame log');
    expect(getStderr()).toContain('gru.frames.jsonl');
    // Refused BEFORE listening: no listening line was ever logged.
    const msgs = readLogLines(home).map((line) => line.msg);
    expect(msgs).not.toContain('listening');
  });

  it('SIGTERM: stop accepting, exit 0, structured shutdown lines in the data dir log', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-sigterm-'));
    cleanupDirs.push(home);
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n',
      'utf-8',
    );

    const { child, getStderr } = spawnService(home);
    try {
      const port = await waitForHealthyPort(home, getStderr);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);

      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);

      const lines = readLogLines(home);
      const msgs = lines.map((line) => line.msg);
      expect(msgs).toContain('boot');
      expect(msgs).toContain('listening');
      expect(msgs).toContain('shutdown begin');
      expect(msgs).toContain('shutdown complete');
      const boot = lines.find((line) => line.msg === 'boot');
      expect(boot?.['version']).toBeTypeOf('string');
      expect(boot?.['install_id']).toBeTypeOf('string');
      // Per-request structured logging is exercised and asserted, not just wired:
      const requestLine = lines.find((line) => line.msg === 'request');
      expect(requestLine?.['status']).toBe(200);
      expect(requestLine?.['level']).toBe('info');
      expect(requestLine?.['request_id']).toBeTypeOf('string');

      const afterStop = await fetch(`http://127.0.0.1:${port}/health`).then(
        () => 'reachable',
        () => 'unreachable',
      );
      expect(afterStop).toBe('unreachable');

      // W8 (ruling-12 effect): the graceful shutdown persisted the session
      // size snapshot — the next boot's growth detection has a baseline.
      const snapshotFile = join(home, 'sessions', 'store-state.json');
      expect(existsSync(snapshotFile)).toBe(true);
      expect(JSON.parse(readFileSync(snapshotFile, 'utf-8'))).toEqual({});
      // And the boot line reported the session store wiring:
      const storeLine = lines.find((line) => line.msg === 'session store ready');
      expect(storeLine).toBeDefined();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('SIGINT: same graceful path, exit 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-sigint-'));
    cleanupDirs.push(home);
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n',
      'utf-8',
    );

    const { child, getStderr } = spawnService(home);
    try {
      await waitForHealthyPort(home, getStderr);
      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGINT');
      });
      expect(exitCode).toBe(0);
      const msgs = readLogLines(home).map((line) => line.msg);
      expect(msgs).toContain('shutdown complete');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('invalid config: service refuses to start, exits non-zero with a clear error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-badcfg-'));
    cleanupDirs.push(home);
    writeFileSync(configPathFor(home), 'workspace_root = 42\n', 'utf-8');

    const { child } = spawnService(home);
    const [exitCode, stderr] = await new Promise<[number | null, string]>((resolveExit) => {
      let err = '';
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf-8');
      });
      child.on('exit', (code) => resolveExit([code, err]));
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('configuration invalid');
    expect(stderr).toContain('workspace_root');
    expect(stderr).toContain(configPathFor(home));
  });
});
