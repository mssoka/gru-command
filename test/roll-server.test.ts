import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createRollServer, type RollControllerPort } from '../src/roll/server.js';
import type { RollState } from '../src/roll/state.js';

/**
 * POST/GET /api/roll surface: operator-guarded (pairing token, same
 * discipline as every write endpoint), 202-on-accept, 409 while a roll is
 * already running, and GET reading the live-or-on-disk record.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempConfig(token: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-roll-server-'));
  cleanupDirs.push(dir);
  writeFileSync(
    join(dir, 'config.toml'),
    `[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "${token}"\n`,
    'utf-8',
  );
  return loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
}

function rollState(phase: RollState['phase'], rollId = 'roll-1'): RollState {
  return {
    schemaVersion: 1,
    rollId,
    phase,
    reason: null,
    requestedBy: 'test',
    repoRoot: '/fixture/deploy',
    fromSha: 'a'.repeat(40),
    toSha: 'b'.repeat(40),
    startedAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    preflight: null,
    drain: null,
    error: null,
    verify: null,
  };
}

async function boot(options: {
  token?: string;
  controller?: Partial<RollControllerPort>;
  loadState?: () => RollState | null;
}): Promise<{ port: number; close: () => Promise<void>; invoked: { reason?: string; requestedBy?: string }[] }> {
  const config = { ...tempConfig('roll-test-token'), auth: { token: options.token ?? 'roll-test-token' } };
  const invoked: { reason?: string; requestedBy?: string }[] = [];
  let current: RollState | null = null;
  const controller: RollControllerPort = {
    isBusy: () => false,
    state: () => current,
    roll: async (input = {}) => {
      invoked.push(input as { reason?: string; requestedBy?: string });
      current = rollState('preflight');
      return current;
    },
    ...options.controller,
  };
  const server = createRollServer({
    config,
    controller,
    loadState: options.loadState ?? (() => null),
  });
  const http: HttpServer = createServer((req, res) => {
    if (!server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}\n');
    }
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    invoked,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

const AUTH = { authorization: 'Bearer roll-test-token' };

describe('POST /api/roll', () => {
  it('answers 503 when no pairing token is configured (locked door)', async () => {
    const harness = await boot({ token: '' });
    try {
      const res = await fetch(`http://127.0.0.1:${harness.port}/api/roll`, { method: 'POST' });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('not_configured');
      expect(harness.invoked).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('answers 401 for a missing or wrong token', async () => {
    const harness = await boot({});
    try {
      const missing = await fetch(`http://127.0.0.1:${harness.port}/api/roll`, { method: 'POST' });
      expect(missing.status).toBe(401);
      const wrong = await fetch(`http://127.0.0.1:${harness.port}/api/roll`, {
        method: 'POST',
        headers: { authorization: 'Bearer not-it' },
      });
      expect(wrong.status).toBe(401);
      expect(harness.invoked).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('accepts with 202 and forwards reason + requested_by', async () => {
    const harness = await boot({});
    try {
      const res = await fetch(`http://127.0.0.1:${harness.port}/api/roll`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'config changed', requested_by: 'operator' }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string; roll: RollState };
      expect(body.status).toBe('accepted');
      expect(body.roll.phase).toBe('preflight');
      expect(harness.invoked).toEqual([{ reason: 'config changed', requestedBy: 'operator' }]);
    } finally {
      await harness.close();
    }
  });

  it('answers 409 with the live record while a roll is already running', async () => {
    const live = rollState('drain', 'roll-live');
    const harness = await boot({
      controller: { isBusy: () => true, state: () => live },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${harness.port}/api/roll`, {
        method: 'POST',
        headers: AUTH,
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; roll: RollState };
      expect(body.error).toBe('roll_in_progress');
      expect(body.roll.rollId).toBe('roll-live');
      expect(harness.invoked).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('answers 405 for non-GET/POST methods', async () => {
    const harness = await boot({});
    try {
      const res = await fetch(`http://127.0.0.1:${harness.port}/api/roll`, { method: 'PUT', headers: AUTH });
      expect(res.status).toBe(405);
      expect(((await res.json()) as { allowed: string[] }).allowed).toEqual(['GET', 'POST']);
    } finally {
      await harness.close();
    }
  });
});

describe('GET /api/roll', () => {
  it('requires the token and returns the live-or-on-disk record', async () => {
    const stored = rollState('done', 'roll-from-disk');
    const harness = await boot({ loadState: () => stored });
    try {
      const unauthorized = await fetch(`http://127.0.0.1:${harness.port}/api/roll`);
      expect(unauthorized.status).toBe(401);
      const res = await fetch(`http://127.0.0.1:${harness.port}/api/roll`, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roll: RollState };
      expect(body.roll.rollId).toBe('roll-from-disk');
      expect(body.roll.phase).toBe('done');
    } finally {
      await harness.close();
    }
  });

  it('does not claim unrelated paths', async () => {
    const harness = await boot({});
    try {
      const res = await fetch(`http://127.0.0.1:${harness.port}/api/other`, { headers: AUTH });
      expect(res.status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});
