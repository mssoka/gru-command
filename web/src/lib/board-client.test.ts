import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
            prState: null,
            baseBranch: null,
            note: null,
            rounds: [],
            lane: null,
            lastAgentActivity: null,
          },
        ],
      },
    ],
    agents: [],
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'test-incarnation',
      generation: 0,
    },
    unackedActionRequired: 0,
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

  it('posts an authenticated decision recheck and rejects malformed status replies', async () => {
    const ready = { ...snapshotFor('recheck').decisions, enabled: true, status: 'ready' as const, reason: null, credentialPresent: true, credentialSource: 'file' as const, generation: 4 };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ready), { status: 200 })) as unknown as typeof fetch;
    client = new BoardClient(
      { token: TOKEN, host: `127.0.0.1:${server.port}`, fetchImpl },
      { connection: () => {}, snapshot: () => {}, fatal: () => {} },
    );
    await expect(client.recheckDecisions()).resolves.toMatchObject({ status: 'ready', generation: 4 });
    const [path, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(path).toBe('/api/decisions/recheck');
    expect(init).toMatchObject({ method: 'POST', headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }) });

    vi.mocked(fetchImpl).mockResolvedValueOnce(new Response('{"status":"ready"}', { status: 200 }));
    await expect(client.recheckDecisions()).rejects.toThrow(/malformed status/);
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

  it('detects a silently-dead socket via the liveness clock and recovers without a manual reload', async () => {
    const seen: string[] = [];
    const states: BoardConnectionState[] = [];
    let fetches = 0;
    const fetchImpl = (async (path: string) => {
      if (path === '/api/board') {
        fetches += 1;
        return new Response(JSON.stringify(snapshotFor('fetched')), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    client = new BoardClient(
      {
        token: TOKEN,
        host: `127.0.0.1:${server.port}`,
        fetchImpl,
        livenessWindowMs: 120,
        livenessCheckMs: 20,
      },
      {
        connection: (state) => states.push(state),
        snapshot: (snap) => seen.push(snap.repos[0]?.jobs[0]?.id ?? '?'),
        fatal: () => {},
      },
    );
    client.connect();
    await waitFor(() => seen.some((id) => id.startsWith('initial-')), 'initial ws snapshot');
    const fetchesBeforeRecovery = fetches;
    // The test server sends NO keepalive frames: the socket goes silent and
    // must be declared stale — the zombie shape that used to freeze the board.
    await waitFor(() => states.includes('stale'), 'stale detection');
    // Recovery happens on its own: reconnect → fresh auth → new snapshot,
    // and the reconnect path refetched over HTTP first.
    await waitFor(() => seen.some((id) => id.startsWith('initial-2')), 'self-recovered snapshot');
    expect(fetches).toBeGreaterThan(fetchesBeforeRecovery);
    expect(client.getState()).toBe('open');
  });

  it('keepalive ping frames refresh the liveness clock — a quiet-but-live socket is never reopened', async () => {
    const states: BoardConnectionState[] = [];
    client = new BoardClient(
      {
        token: TOKEN,
        host: `127.0.0.1:${server.port}`,
        fetchImpl: (async () => new Response(JSON.stringify(snapshotFor('fetched')), { status: 200 })) as typeof fetch,
        livenessWindowMs: 100,
        livenessCheckMs: 20,
      },
      { connection: (state) => states.push(state), snapshot: () => {}, fatal: () => {} },
    );
    client.connect();
    await waitFor(() => client?.getState() === 'open', 'open');
    // The server pings every 30 ms — well inside the 100 ms window — for
    // long enough that a silent socket would have gone stale twice.
    const pingers: ReturnType<typeof setInterval>[] = [];
    for (const socket of server.wss?.clients ?? []) {
      pingers.push(setInterval(() => socket.send(JSON.stringify({ type: 'ping' })), 30));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const pinger of pingers) clearInterval(pinger);
    expect(states).not.toContain('stale');
    expect(client.getState()).toBe('open');
  });

  it('wake() refetches the snapshot unconditionally and reopens a socket silent past the window', async () => {
    const seen: string[] = [];
    let fetches = 0;
    const fetchImpl = (async (path: string) => {
      if (path === '/api/board') {
        fetches += 1;
        return new Response(JSON.stringify(snapshotFor('fetched')), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    client = new BoardClient(
      {
        token: TOKEN,
        host: `127.0.0.1:${server.port}`,
        fetchImpl,
        livenessWindowMs: 100,
        livenessCheckMs: 60_000, // the periodic check stays out of the way
      },
      {
        connection: () => {},
        snapshot: (snap) => seen.push(snap.repos[0]?.jobs[0]?.id ?? '?'),
        fatal: () => {},
      },
    );
    client.connect();
    await waitFor(() => seen.some((id) => id.startsWith('initial-')), 'initial ws snapshot');
    const fetchesBeforeWake = fetches;
    await new Promise((resolve) => setTimeout(resolve, 160)); // silent past the window
    client.wake();
    // Wake always refetches, even when the liveness clock has not expired…
    await waitFor(() => fetches > fetchesBeforeWake, 'wake refetch');
    // …and reopens the silent socket so the board resumes without a reload.
    await waitFor(() => seen.some((id) => id.startsWith('initial-2')), 'wake reopen');
  });
});
