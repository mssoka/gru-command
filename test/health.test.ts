import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { createService, type ServiceHandle } from '../src/server.js';
import { VERSION } from '../src/version.js';
import { DecisionRuntime } from '../src/decisions/runtime.js';

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
  // the configured default port. A pairing token ships in the fixture —
  // /health's full payload is token-gated (W-C) and the suite proves
  // both sides of that gate.
  writeFileSync(
    configPathFor(home),
    '[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "health-test-token"\n',
    'utf-8',
  );
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const identity = loadOrCreateIdentity(config.dataDir);
  const service = createService(config, identity);
  return service.start();
}

/** The authed fetch (full HealthPayload; W-C gates it behind the token). */
async function authedHealth(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/health`, {
    headers: { authorization: 'Bearer health-test-token' },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('GET /health', () => {
  it('returns 200 with the full declared field shape', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const res = await authedHealth(handle.port);
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

  it('flips liveness REAL when a runtime status is wired (E2)', async () => {
    const home = tmpHome();
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "health-test-token"\n',
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const identity = loadOrCreateIdentity(config.dataDir);
    const wiredAt = new Date('2026-09-16T00:00:00Z').toISOString();
    const status = () => ({
      agentSession: { state: 'idle' as const, lastActivity: wiredAt },
      sessionGrowth: {
        findings: [
          {
            file: join(home, 'sessions', 'grew.jsonl'),
            kind: 'grew' as const,
            grewByBytes: 42,
            previousBytes: 10,
            currentBytes: 52,
          },
        ],
        snapshotState: 'ok' as const,
        scannedAt: wiredAt,
      },
      activeSessions: 1,
      adapters: [],
    });
    const service = createService(config, identity, () => {}, status);
    const handle = await service.start();
    try {
      const res = await authedHealth(handle.port);
      const body = (await res.json()) as Record<string, unknown>;
      const liveness = body['liveness'] as Record<string, unknown>;
      const signals = liveness['signals'] as Record<string, Record<string, unknown>>;
      expect(signals['health_reachable']?.['stubbed']).toBe(false);
      expect(signals['agent_session']).toEqual({
        state: 'idle',
        last_activity: wiredAt,
        stubbed: false,
      });
      const growth = signals['session_growth']?.['value'] as Array<Record<string, unknown>>;
      expect(signals['session_growth']?.['stubbed']).toBe(false);
      expect(growth.length).toBe(1);
      expect(growth[0]).toMatchObject({ grew_by_bytes: 42, current_bytes: 52 });
      const session = body['session'] as Record<string, unknown>;
      expect(session['note']).toContain('append-only jsonl');
    } finally {
      await handle.stop();
    }
  });

  it('carries the supervision block when a supervisor status is wired (E7)', async () => {
    const home = tmpHome();
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "health-test-token"\n',
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const identity = loadOrCreateIdentity(config.dataDir);
    const service = createService(
      config,
      identity,
      () => {},
      () => null,
      {
        supervisionStatus: () => ({
          enabled: true,
          turnSilenceMs: 900_000,
          restartWindowMs: 600_000,
          maxRestarts: 3,
          agents: [
            {
              agentId: 'gru-main',
              role: 'gru',
              slotId: 'gru-main',
              state: 'watching',
              restarts: 1,
              breakerOpen: false,
              openTurn: false,
              openToolCalls: 0,
              lastEventAt: '2026-09-18T00:00:00.000Z',
              lastFileBytes: 1024,
            },
          ],
        }),
      },
    );
    const handle = await service.start();
    try {
      const res = await authedHealth(handle.port);
      const body = (await res.json()) as Record<string, unknown>;
      const supervision = body['supervision'] as Record<string, unknown>;
      expect(supervision['enabled']).toBe(true);
      expect(supervision['turnSilenceMs']).toBe(900_000);
      const agents = supervision['agents'] as Array<Record<string, unknown>>;
      expect(agents[0]).toMatchObject({ agentId: 'gru-main', state: 'watching', restarts: 1 });
    } finally {
      await handle.stop();
    }
  });

  it('publishes durable decision readiness without exposing credential material', async () => {
    const home = tmpHome();
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "health-test-token"\n',
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const identity = loadOrCreateIdentity(config.dataDir);
    const decisions = new DecisionRuntime(config.decisions, {
      instanceDir: config.instanceDir,
      watchConfig: false,
    });
    const service = createService(config, identity, () => {}, () => null, {
      decisionsStatus: () => decisions.status(),
    });
    const handle = await service.start();
    try {
      const body = (await (await authedHealth(handle.port)).json()) as Record<string, unknown>;
      expect(body['decisions']).toMatchObject({
        enabled: false,
        status: 'disabled',
        credentialPresent: false,
        credentialSource: 'none',
      });
      expect(JSON.stringify(body)).not.toContain('apiKey');
    } finally {
      decisions.dispose();
      await handle.stop();
    }
  });

  it('reports supervision: null when no supervisor is wired (pre-E7 shape)', async () => {
    const home = tmpHome();
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "health-test-token"\n',
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const identity = loadOrCreateIdentity(config.dataDir);
    const service = createService(config, identity, () => {}, () => null);
    const handle = await service.start();
    try {
      const res = await authedHealth(handle.port);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['supervision']).toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it('reports no-session honestly when the registry is empty but wired', async () => {
    const home = tmpHome();
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "health-test-token"\n',
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const identity = loadOrCreateIdentity(config.dataDir);
    const service = createService(
      config,
      identity,
      () => {},
      () => ({
        agentSession: { state: 'no-session' as const, lastActivity: null },
        sessionGrowth: { findings: [], snapshotState: 'ok' as const, scannedAt: new Date().toISOString() },
        activeSessions: 0,
        adapters: [],
      }),
    );
    const handle = await service.start();
    try {
      const res = await authedHealth(handle.port);
      const body = (await res.json()) as Record<string, unknown>;
      const signals = (body['liveness'] as Record<string, unknown>)['signals'] as Record<
        string,
        Record<string, unknown>
      >;
      expect(signals['agent_session']).toEqual({
        state: 'no-session',
        last_activity: null,
        stubbed: false,
      });
      expect(signals['session_growth']).toEqual({ value: 'none', stubbed: false });
    } finally {
      await handle.stop();
    }
  });

  it('identity.install_id is stable across restarts on the same data dir', async () => {
    const home = tmpHome();
    const first = await bootService(home);
    const firstBody = (await (
      await authedHealth(first.port)
    ).json()) as Record<string, Record<string, string>>;
    await first.stop();

    const second = await bootService(home);
    const secondBody = (await (
      await authedHealth(second.port)
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

  it('returns 413 to a raw client streaming an oversized body on /health', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const { connect } = await import('node:net');
      const statusLine = await new Promise<string>((resolveStatus, rejectStatus) => {
        const sock = connect(handle.port, '127.0.0.1', () => {
          sock.write(
            'GET /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2000000\r\n\r\n',
          );
          const chunk = Buffer.alloc(100_000, 97);
          for (let i = 0; i < 11; i += 1) sock.write(chunk);
        });
        sock.once('data', (d: Buffer) => {
          const line = d.toString('utf-8').split('\r\n')[0] ?? '';
          sock.destroy();
          resolveStatus(line);
        });
        sock.once('error', rejectStatus);
        const timer = setTimeout(() => rejectStatus(new Error('no response within 5s')), 5_000);
        timer.unref();
      });
      expect(statusLine).toContain('413');
      // Service still alive afterwards:
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await handle.stop();
    }
  });

  it('serves HEAD /health with 200 and an empty body', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
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

describe('Perkins r1 regression pins', () => {
  it("N14: session_growth reports 'not-scanned' before the store has scanned", async () => {
    const home = tmpHome();
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "health-test-token"\n',
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const identity = loadOrCreateIdentity(config.dataDir);
    const service = createService(config, identity, () => {}, () => ({
      agentSession: { state: 'no-session' as const, lastActivity: null },
      sessionGrowth: null,
      activeSessions: 0,
      adapters: [],
    }));
    const handle = await service.start();
    try {
      const res = await authedHealth(handle.port);
      const body = (await res.json()) as Record<string, unknown>;
      const signals = (body['liveness'] as Record<string, unknown>)['signals'] as Record<string, Record<string, unknown>>;
      expect(signals['session_growth']).toEqual({ value: 'not-scanned', stubbed: false });
    } finally {
      await handle.stop();
    }
  });

  it('W4: liveness.healthy goes false when an adapter is down', async () => {
    const home = tmpHome();
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "health-test-token"\n',
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const identity = loadOrCreateIdentity(config.dataDir);
    const service = createService(config, identity, () => {}, () => ({
      agentSession: { state: 'no-session' as const, lastActivity: null },
      sessionGrowth: { findings: [], snapshotState: 'ok' as const, scannedAt: new Date().toISOString() },
      activeSessions: 0,
      adapters: [{ id: 'pi', state: 'down' }],
    }));
    const handle = await service.start();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      const body = (await res.json()) as Record<string, unknown>;
      const liveness = body['liveness'] as Record<string, unknown>;
      expect(liveness['healthy']).toBe(false);
    } finally {
      await handle.stop();
    }
  });
});

describe('W-C (E9 r3 carry): /health disclosure split', () => {
  it('unauthenticated /health answers 200 with LIVENESS ONLY — no paths, no fingerprint', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // Public shape: service/version/uptime + health_reachable liveness.
      expect(body['service']).toBe('gru-command');
      expect(body['version']).toBe(VERSION);
      expect(typeof body['uptime_ms']).toBe('number');
      const liveness = body['liveness'] as Record<string, unknown>;
      expect(liveness['healthy']).toBe(true);
      const signals = liveness['signals'] as Record<string, unknown>;
      expect(signals['health_reachable']).toEqual({ value: true, stubbed: true });
      // Operator material NEVER leaves unauthenticated (W-C):
      expect(body['config']).toBeUndefined();
      expect(body['identity']).toBeUndefined();
      expect(body['session']).toBeUndefined();
      expect(body['supervision']).toBeUndefined();
      expect(signals['agent_session']).toBeUndefined();
      expect(signals['session_growth']).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it('a WRONG token still answers 200 with the public shape (health is the liveness oracle, not an auth gate)', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/health`, {
        headers: { authorization: 'Bearer definitely-not-it' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['identity']).toBeUndefined();
      expect(body['config']).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it('the pairing token unlocks the FULL payload (operator view)', async () => {
    const home = tmpHome();
    const handle = await bootService(home);
    try {
      const res = await authedHealth(handle.port);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const config = body['config'] as Record<string, string>;
      expect(config['workspace_root']).toBe('/home/tester/code');
      expect(config['data_dir']).toBe(home);
      expect((body['identity'] as Record<string, string>)['install_id']).toMatch(UUID_RE);
      expect(body['supervision']).toBeNull();
    } finally {
      await handle.stop();
    }
  });
});
