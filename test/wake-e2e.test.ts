import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { pickFreePort, startRealService, type RealServiceHandle } from './helpers/real-service.mjs';

/**
 * Wake-on-alert e2e (owner ruling 2026-09-23): an action-required
 * notification must OPEN a Gru turn on the REAL service — no user message,
 * no ping. Always runs in `npm test` after the build, using the offline
 * claude CLI double; no live model or paid API calls.
 *
 * The whole path is real: config load → ledger → event bus → awareness
 * wake policy → chat session spawn → turn frames on the wire. Only the
 * model binary is the suite's stream-json double.
 */

interface WireFrame {
  readonly type: string;
  readonly state?: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

async function waitForFrame(
  frames: readonly WireFrame[],
  predicate: (frame: WireFrame) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<WireFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function authedSocket(service: RealServiceHandle): Promise<{ socket: WebSocket; frames: WireFrame[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/ws`);
  const frames: WireFrame[] = [];
  socket.on('message', (data) => {
    try {
      frames.push(JSON.parse(String(data)) as WireFrame);
    } catch {
      /* the contract emits JSON only; ignore noise rather than crash the test */
    }
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', token: service.token }));
  await waitForFrame(frames, (frame) => frame.type === 'auth_ok', 'auth_ok');
  return { socket, frames };
}

describe('wake-on-alert real service (offline)', () => {
  let service: RealServiceHandle | null = null;
  afterAll(async () => {
    await service?.stop();
  });

  it('boots a seeded machine backlog only after the live disposition API is available', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-wake-boot-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-wake-space-'));
    const db = new LedgerDb(home);
    const ledger = new LedgerApi(db.handle);
    const alert = ledger.recordNotification({ id: 'seeded-boot-alert', kind: 'test.boot', routing: 'action-required', severity: 'error', title: 'Seeded before listen' });
    db.close();
    try {
      service = await startRealService({ port: await pickFreePort(), home, workspace,
        notifyWake: 'action-required', requireWebDist: false });
      const { socket, frames } = await authedSocket(service);
      try {
        await waitForFrame(frames, (frame) => frame.type === 'turn' && frame.state === 'start', 'seeded wake receipt');
        const disposition = await fetch(`${service.baseUrl}/api/notifications/${alert.id}/disposition`, {
          method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ detail: 'Opened a repair lane during the first wake' }),
        });
        expect(disposition.status).toBe(200);
        expect(await disposition.json()).toMatchObject({ id: alert.id, routing: 'action-required', resolvedBy: 'gru' });
        const board = await fetch(`${service.baseUrl}/api/board`, { headers: { Authorization: `Bearer ${service.token}` } });
        expect(((await board.json()) as { notifications: { id: string }[] }).notifications.find((row) => row.id === alert.id))
          .toMatchObject({ resolvedBy: 'gru' });
      } finally { socket.close(); }
    } finally {
      await service?.stop();
      service = null;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('refused foreign-listener startup never consumes a seeded wake', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-wake-refused-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-wake-refused-space-'));
    const db = new LedgerDb(home);
    const api = new LedgerApi(db.handle);
    api.recordNotification({ id: 'seeded-refused-alert', kind: 'test.boot', routing: 'action-required',
      severity: 'error', title: 'Must remain pending on refused boot' });
    db.close();
    const port = await pickFreePort();
    const foreign = createServer();
    // Track squatter connections: the boot loop's /health probe can leave
    // a lingering socket, and net.Server.close() never settles while one
    // is open — destroy them before close or the test hangs (net.Server
    // has no closeAllConnections; that is an http.Server method).
    const squatterSockets = new Set<import('node:net').Socket>();
    foreign.on('connection', (socket) => {
      squatterSockets.add(socket);
      socket.once('close', () => squatterSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      foreign.once('error', reject);
      foreign.listen(port, '127.0.0.1', resolve);
    });
    try {
      await expect(startRealService({ port, home, workspace, notifyWake: 'action-required', requireWebDist: false }))
        .rejects.toThrow(/service exited|service never answered/);
      const reread = new LedgerDb(home);
      try {
        const history = new LedgerApi(reread.handle);
        expect(history.listEventsAfter(0, { kinds: ['gru.wake'] })).toEqual([]);
        expect(history.getNotification('seeded-refused-alert')).toMatchObject({ ackedAt: null, resolvedAt: null });
      } finally { reread.close(); }
    } finally {
      for (const socket of squatterSockets) socket.destroy();
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('an injected action-required notification opens a Gru turn with its payload', async () => {
    const port = await pickFreePort();
    const logFile = `/tmp/gru-command-wake-e2e-${process.pid}-${Date.now()}.jsonl`;
    service = await startRealService({
      port,
      notifyWake: 'action-required',
      requireWebDist: false,
      extraEnv: { CLAUDE_DOUBLE_LOG: logFile },
    });
    const { socket, frames } = await authedSocket(service);
    try {
      const posted = await fetch(`${service.baseUrl}/api/silas/escalate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${service.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Wake e2e: lane interruption needs a machine disposition',
          detail: 'injected by the wake-on-alert e2e — no user message is waiting',
        }),
      });
      expect(posted.status).toBe(200);

      // No user frame was sent: any turn here was opened by the wake policy.
      const turnStart = await waitForFrame(
        frames,
        (frame) => frame.type === 'turn' && frame.state === 'start',
        'wake turn start',
      );
      expect(turnStart.type).toBe('turn');
      await waitForFrame(
        frames,
        (frame) => frame.type === 'turn' && frame.state === 'end',
        'wake turn end',
      );

      // Board observability: the wake is a durable gru.wake event.
      const board = await fetch(`${service.baseUrl}/api/board`, {
        headers: { Authorization: `Bearer ${service.token}` },
      });
      expect(board.status).toBe(200);
      const snapshot = (await board.json()) as { wakes: { count: number; lastAt: string | null } };
      expect(snapshot.wakes.count).toBeGreaterThanOrEqual(1);
      expect(snapshot.wakes.lastAt).not.toBeNull();
    } finally {
      socket.close();
    }

    // The turn payload is service context, clearly marked, carrying the
    // notification content — read from the CLI double's invocation log.
    await service.stop();
    service = null;
    const invocations = readFileSync(logFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { prompt?: string });
    const wakePrompt = invocations.find((entry) =>
      (entry.prompt ?? '').includes('[gru awareness · service context'),
    );
    expect(wakePrompt).toBeDefined();
    expect(wakePrompt?.prompt).toContain('Wake e2e: lane interruption needs a machine disposition');
    expect(wakePrompt?.prompt).toContain('This turn was started by the service wake policy');
  });
});
