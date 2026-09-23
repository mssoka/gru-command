import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  defaultListenerProbe,
  foreignListener,
  type ListenerOwner,
} from '../src/listener-probe.js';
import { configPathFor } from '../src/config.js';
import { pickFreePort } from './helpers/real-service.mjs';

/**
 * Listener ownership probe (owner incident 2026-09-23, item 3): the pid
 * that actually LISTENS on the instance port is the fact a /health 200
 * must never override. These tests pin the fake-probe contract AND prove
 * the real platform probe (lsof on macOS, /proc on Linux) finds listeners
 * — our own and a foreign child's.
 */

const SUPPORTED = process.platform === 'darwin' || process.platform === 'linux';
const repoRoot = join(import.meta.dirname, '..');
const children: ReturnType<typeof spawn>[] = [];
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('foreignListener: the pid evidence a /health 200 cannot override', () => {
  it('filters self, reports the first foreign owner, and stays null when the probe is unavailable', async () => {
    const owners: readonly ListenerOwner[] = [
      { pid: 1, command: 'node squatter' },
      { pid: 4242, command: 'node real-service' },
    ];
    expect(
      await foreignListener({ probe: async () => owners, host: '127.0.0.1', port: 7665, selfPid: 1 }),
    ).toEqual({ pid: 4242, command: 'node real-service' });
    expect(
      await foreignListener({ probe: async () => [owners[1] as ListenerOwner], host: '127.0.0.1', port: 7665, selfPid: 4242 }),
    ).toBeNull();
    expect(
      await foreignListener({ probe: async () => [], host: '127.0.0.1', port: 7665, selfPid: 1 }),
    ).toBeNull();
    // null = no probe on this platform — never read as "port is free".
    expect(
      await foreignListener({ probe: async () => null, host: '127.0.0.1', port: 7665, selfPid: 1 }),
    ).toBeNull();
  });
});

describe('defaultListenerProbe: the real platform probe', () => {
  it.skipIf(!SUPPORTED)('finds this process listening on an OS-assigned port', async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const port = (server.address() as { port: number }).port;
    try {
      const owners = await defaultListenerProbe('127.0.0.1', port);
      expect(owners).not.toBeNull();
      expect(owners?.some((owner) => owner.pid === process.pid)).toBe(true);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it.skipIf(!SUPPORTED)('finds a FOREIGN child listener by pid (the squatter shape)', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { createServer } = require('node:net');",
          'const server = createServer(() => {});',
          "server.listen(0, '127.0.0.1', () => { console.log(server.address().port); });",
        ].join('\n'),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(child);
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const match = /^(\d+)$/m.exec(buffer);
        if (match !== null && match[1] !== undefined) resolvePort(Number(match[1]));
      });
      child.once('error', rejectPort);
      child.once('exit', () => rejectPort(new Error('child exited before listening')));
    });
    const owners = await defaultListenerProbe('127.0.0.1', port);
    expect(owners?.some((owner) => owner.pid === child.pid)).toBe(true);
    const foreign = await foreignListener({
      probe: defaultListenerProbe,
      host: '127.0.0.1',
      port,
      selfPid: process.pid,
    });
    expect(foreign?.pid).toBe(child.pid);
    child.kill('SIGKILL');
  });

  it.skipIf(!SUPPORTED)('returns no owners for a free port', async () => {
    const port = await pickFreePort();
    const owners = await defaultListenerProbe('127.0.0.1', port);
    expect(owners ?? []).toHaveLength(0);
  });
});

describe('the boot guard: a coexisting foreign wildcard listener (the incident shape)', () => {
  it.skipIf(process.platform !== 'darwin')(
    'a service that binds alongside the squatter refuses loud instead of serving loopback 503s',
    async () => {
      // macOS specific+wildcard coexistence: the squatter holds the
      // wildcard, the service binds 127.0.0.1 — the LISTEN SUCCEEDS, so
      // only the listener-pid check can catch the squat.
      const squatter = createServer();
      await new Promise<void>((resolveListen) => squatter.listen(0, '0.0.0.0', resolveListen));
      const port = (squatter.address() as { port: number }).port;
      const home = mkdtempSync(join(tmpdir(), 'gru-command-bootguard-'));
      cleanupDirs.push(home);
      writeFileSync(configPathFor(home), `[server]\nhost = "127.0.0.1"\nport = ${port}\n`, 'utf-8');
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'main.js')], {
        env: {
          ...process.env,
          GRU_COMMAND_HOME: home,
          GRU_SERVICE_PORT: String(port), // the explicit harness override (item 1)
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      try {
        const exitCode = await new Promise<number | null>((resolveExit) => {
          child.on('exit', (code) => resolveExit(code));
        });
        expect(exitCode).toBe(1);
        expect(stderr).toContain('foreign listener owns the instance port');
        // The reported squatter pid is THIS test process (the wildcard
        // listener above) — the taskbook evidence, not a guess.
        expect(stderr).toContain(`"foreign_pid":${process.pid}`);
      } finally {
        await new Promise<void>((resolveClose) => squatter.close(() => resolveClose()));
      }
    },
    30_000,
  );
});
