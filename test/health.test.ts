import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { createService, type ServiceHandle } from '../src/server.js';
import { VERSION } from '../src/version.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-health-'));
  cleanupDirs.push(dir);
  return dir;
}

async function bootService(home: string): Promise<ServiceHandle> {
  // Ephemeral port: the suite must never collide with a dev instance on
  // the configured default port.
  writeFileSync(configPathFor(home), '[server]\nhost = "127.0.0.1"\nport = 0\n', 'utf-8');
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const identity = loadOrCreateIdentity(config.dataDir);
  const service = createService(config, identity);
  return service.start();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('GET /health', () => {
  it('returns 200 with the full declared field shape', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as Record<string, unknown>;

      expect(body['service']).toBe('gru-command');
      expect(body['version']).toBe(VERSION);
      expect(typeof body['uptime_ms']).toBe('number');
      expect(body['uptime_ms'] as number).toBeGreaterThanOrEqual(0);

      const config = body['config'] as Record<string, string>;
      expect(config['workspace_root']).toBe('/home/tester/code');
      expect(config['data_dir']).toBe(home);

      const identity = body['identity'] as Record<string, string>;
      expect(identity['install_id']).toMatch(UUID_RE);

      const liveness = body['liveness'] as Record<string, unknown>;
      expect(liveness['healthy']).toBe(true);
      const signals = liveness['signals'] as Record<string, Record<string, unknown>>;
      expect(Object.keys(signals).sort()).toEqual([
        'agent_session',
        'health_reachable',
        'session_growth',
      ]);
      expect(signals['health_reachable']?.['value']).toBe(true);
      expect(signals['health_reachable']?.['stubbed']).toBe(true);
      expect(signals['agent_session']?.['stubbed']).toBe(true);
      expect(signals['agent_session']?.['last_activity']).toBeNull();
      expect(signals['session_growth']?.['stubbed']).toBe(true);

      const session = body['session'] as Record<string, unknown>;
      expect(session['path']).toBe(join(home, 'sessions'));
      expect(session['declared']).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('identity.install_id is stable across restarts on the same data dir', async () => {
    const home = tmpHome();
    const first = await bootService(home);
    const firstBody = (await (
      await fetch(`http://127.0.0.1:${first.port}/health`)
    ).json()) as Record<string, Record<string, string>>;
    await first.stop();

    const second = await bootService(home);
    const secondBody = (await (
      await fetch(`http://127.0.0.1:${second.port}/health`)
    ).json()) as Record<string, Record<string, string>>;
    await second.stop();

    expect(secondBody['identity']?.['install_id']).toBe(firstBody['identity']?.['install_id']);
  });

  it('returns 404 for unknown routes', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/other`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['error']).toBe('not_found');
    } finally {
      await handle.stop();
    }
  });

  it('returns 405 for non-GET methods on /health', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`, { method: 'POST' });
      expect(res.status).toBe(405);
    } finally {
      await handle.stop();
    }
  });

  it('returns 400 for a malformed request target without dying', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const { connect } = await import('node:net');
      const statusLine = await new Promise<string>((resolveStatus, rejectStatus) => {
        const sock = connect(handle.port, '127.0.0.1', () => {
          sock.write('GET http://x:70000/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
        });
        sock.once('data', (d: Buffer) => resolveStatus(d.toString('utf-8').split('\r\n')[0] ?? ''));
        sock.once('error', rejectStatus);
        setTimeout(() => rejectStatus(new Error('no response')), 5_000);
      });
      expect(statusLine).toContain('400');
      // Service still alive afterwards:
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await handle.stop();
    }
  });

  it('returns 413 for an oversized body on /health (or resets the uploader)', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const outcome = await fetch(`http://127.0.0.1:${handle.port}/health`, {
        method: 'GET',
        headers: { 'content-length': String(2_000_000) },
        body: 'x'.repeat(2_000_000),
      }).then(
        (r) => `status:${r.status}`,
        () => 'upload-reset',
      );
      // 413 delivered, or the connection reset while the client streamed
      // past the limit — either way the service must still be alive:
      expect(['status:413', 'upload-reset']).toContain(outcome);
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await handle.stop();
    }
  });

  it('uptime resets across restarts (fresh hrtime baseline)', async () => {
    const home = tmpHome();
    const first = await bootService(home);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const firstBody = (await (
      await fetch(`http://127.0.0.1:${first.port}/health`)
    ).json()) as Record<string, number>;
    const firstUptime = firstBody['uptime_ms']!;
    await first.stop();

    const second = await bootService(home);
    const secondBody = (await (
      await fetch(`http://127.0.0.1:${second.port}/health`)
    ).json()) as Record<string, number>;
    const secondUptime = secondBody['uptime_ms']!;
    await second.stop();

    // Boot 1 had a guaranteed 200ms head start; boot 2 answers within that
    // window, so its uptime baseline is provably fresh.
    expect(firstUptime).toBeGreaterThanOrEqual(200);
    expect(secondUptime).toBeLessThan(200);
  });
});
