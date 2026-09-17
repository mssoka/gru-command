import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { BoardClient, type BoardConnectionState } from './board-client.js';
import type { BoardSnapshot } from './board-protocol.js';

/**
 * Contract-level tests: an in-test /board/ws server (auth, snapshot push)
 * plus an in-test HTTP API for the fetch surface.
 */

const TOKEN = 'test-token';

function snapshotFor(jobId: string): BoardSnapshot {
  return {
    repos: [
      {
        name: 'demo-repo',
        jobs: [
          {
            id: jobId,
            repo: 'demo-repo',
            title: `Job ${jobId}`,
            status: 'working',
            updatedAt: '2026-01-01T00:00:00.000Z',
            prUrl: null,
            baseBranch: null,
            note: null,
            rounds: [],
          },
        ],
      },
    ],
    agents: [],
    notifications: [],
  };
}

class TestBoardServer {
  wss: WebSocketServer | null = null;
  port = 0;
  pushCount = 0;

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: 0, path: '/board/ws' });
    await new Promise<void>((resolve) => this.wss!.once('listening', resolve));
    const address = this.wss.address();
    if (typeof address === 'object' && address !== null) this.port = address.port;
    this.wss.on('connection', (socket) => {
      let authed = false;
      socket.on('message', (data) => {
        if (authed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'first frame must be auth', fatal: true }));
          socket.close();
          return;
        }
        const token =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as { type?: unknown; token?: unknown })
            : null;
        if (token === null || token.type !== 'auth' || token.token !== TOKEN) {
          socket.send(JSON.stringify({ type: 'error', message: 'invalid token', fatal: true }));
          socket.close();
          return;
        }
        authed = true;
        socket.send(JSON.stringify({ type: 'auth_ok' }));
        this.pushCount += 1;
        socket.send(JSON.stringify({ type: 'board', snapshot: snapshotFor(`initial-${this.pushCount}`) }));
      });
    });
  }

  /** Push a fresh snapshot to every connected client. */
  push(snapshot: BoardSnapshot): void {
    for (const client of this.wss?.clients ?? []) {
      client.send(JSON.stringify({ type: 'board', snapshot }));
    }
  }

  close(): void {
    this.wss?.close();
  }
}

describe('board client', () => {
  let server: TestBoardServer;
  let client: BoardClient | null = null;

  beforeEach(async () => {
    server = new TestBoardServer();
    await server.start();
  });

  afterEach(() => {
    client?.stop();
    client = null;
    server.close();
  });

  function make(
    events: {
      connection?: (state: BoardConnectionState) => void;
      snapshot?: (snapshot: BoardSnapshot) => void;
      fatal?: (message: string) => void;
    },
    token: string = TOKEN,
  ): BoardClient {
    const fetchImpl = (async (path: string) => {
      if (path === '/api/board') {
        return new Response(JSON.stringify(snapshotFor('fetched')), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    return new BoardClient(
      { token, host: `127.0.0.1:${server.port}`, fetchImpl },
      {
        connection: events.connection ?? (() => {}),
        snapshot: events.snapshot ?? (() => {}),
        fatal: events.fatal ?? (() => {}),
      },
    );
  }

  function waitFor(pred: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        if (pred()) {
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`waitFor(${label}) timed out`));
          return;
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  it('connects → authenticates → receives the immediate snapshot', async () => {
    const seen: string[] = [];
    client = make({ snapshot: (snap) => seen.push(snap.repos[0]?.jobs[0]?.id ?? '?') });
    client.connect();
    await waitFor(() => seen.length >= 2, 'fetch + ws snapshot'); // HTTP fetch + WS push
    expect(seen).toContain('fetched');
    expect(seen.some((id) => id.startsWith('initial-'))).toBe(true);
  });

  it('pushes fresh snapshots as the board changes', async () => {
    const seen: string[] = [];
    client = make({ snapshot: (snap) => seen.push(snap.repos[0]?.jobs[0]?.id ?? '?') });
    client.connect();
    await waitFor(() => seen.some((id) => id.startsWith('initial-')), 'initial snapshot');
    server.push(snapshotFor('changed'));
    await waitFor(() => seen.includes('changed'), 'pushed snapshot');
  });

  it('a bad token is fatal (no retry loop, pairing must redo)', async () => {
    let fatal = '';
    client = make({ fatal: (message) => (fatal = message) }, 'wrong-token');
    client.connect();
    await waitFor(() => fatal !== '', 'fatal');
    expect(fatal).toContain('invalid token');
    expect(client.getState()).toBe('offline');
  });

  it('ignores malformed server frames without dying', async () => {
    const seen: string[] = [];
    client = make({ snapshot: (snap) => seen.push(snap.repos[0]?.jobs[0]?.id ?? '?') });
    client.connect();
    await waitFor(() => client?.getState() === 'open', 'open');
    for (const clientSocket of server.wss?.clients ?? []) {
      clientSocket.send('garbage-not-json');
      clientSocket.send(JSON.stringify({ type: 'board', snapshot: 42 }));
    }
    server.push(snapshotFor('still-alive'));
    await waitFor(() => seen.includes('still-alive'), 'live after noise');
  });

  it('stop() halts reconnects', async () => {
    client = make({});
    client.connect();
    await waitFor(() => client?.getState() === 'open', 'open');
    client.stop();
    expect(client.getState()).toBe('offline');
    // The ws close handshake takes a tick to reach the server.
    await waitFor(() => (server.wss?.clients.size ?? 0) === 0, 'server-side close');
  });
});
