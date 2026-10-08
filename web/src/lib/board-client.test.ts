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
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
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
  it('a stopped (re-paired) client never calls back: no late 401 unpairs its successor, no late snapshot renders', async () => {
    let answer: (response: Response) => void = () => {};
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;
    const events = { connection: vi.fn(), snapshot: vi.fn(), fatal: vi.fn() };
    const old = new BoardClient({ token: TOKEN, host: '127.0.0.1:9', fetchImpl, webSocketCtor: class { close() {} } as unknown as new (url: string) => WebSocket }, events);
    const loading = old.getLessonProposal();
    old.stop(); // the owner re-paired; the old client's request is still in flight
    answer(new Response('{"error":"unauthorized"}', { status: 401 }));
    await expect(loading).rejects.toThrow();
    const refetch = old.refetchSnapshot();
    answer(new Response(JSON.stringify({
      repos: [],
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
        incarnation: 'old-pairing',
        generation: 0,
      },
      unackedActionRequired: 0,
      unackedNeedsOwner: 0,
      wakes: { count: 0, lastAt: null },
      pipeline: { entries: [], pending: 0 },
    }), { status: 200 }));
    await refetch;
    expect(events.fatal).not.toHaveBeenCalled();
    expect(events.snapshot).not.toHaveBeenCalled();
  });
  /** A complete, valid board snapshot tagged by its decision incarnation. */
  const tagged = (tag: string): BoardSnapshot => ({
    repos: [],
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
      incarnation: tag,
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    pipeline: { entries: [], pending: 0 },
  } as unknown as BoardSnapshot);

  it('an older HTTP snapshot never overwrites newer truth — reverse-order replies, and a push that came after the request', async () => {
    const answers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { answers.push(resolve); })) as unknown as typeof fetch;
    const sockets: { onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null }[] = [];
    class FakeSocket {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
    }
    const delivered: string[] = [];
    const ok = (snapshot: BoardSnapshot) => new Response(JSON.stringify(snapshot), { status: 200 });
    const tracked = new BoardClient(
      { token: TOKEN, host: 'localhost', fetchImpl, webSocketCtor: FakeSocket as unknown as new (url: string) => WebSocket },
      { connection: () => {}, snapshot: (snapshot) => delivered.push(snapshot.decisions.incarnation), fatal: () => {} },
    );
    const first = tracked.refetchSnapshot();
    const second = tracked.refetchSnapshot();
    answers[1]!(ok(tagged('second')));
    await second;
    answers[0]!(ok(tagged('first'))); // answered last, asked first: stale
    await first;
    expect(delivered).toEqual(['second']);
    tracked.connect(); // asks over HTTP, then opens the socket
    const socket = sockets.at(-1)!;
    socket.onopen!();
    socket.onmessage!({ data: JSON.stringify({ type: 'auth_ok' }) });
    socket.onmessage!({ data: JSON.stringify({ type: 'board', snapshot: tagged('pushed') }) });
    answers[2]!(ok(tagged('stale-http'))); // requested before the push
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivered).toEqual(['second', 'pushed']);
    tracked.stop();
  });

  it('a fresh HTTP answer discarded only because an OLDER queued push won is refetched once — no further push needed (C13)', async () => {
    const answers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { answers.push(resolve); })) as unknown as typeof fetch;
    const sockets: { onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null }[] = [];
    class FakeSocket {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
    }
    const delivered: string[] = [];
    const ok = (snapshot: BoardSnapshot) => new Response(JSON.stringify(snapshot), { status: 200 });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const client = new BoardClient(
      { token: TOKEN, host: 'localhost', fetchImpl, webSocketCtor: FakeSocket as unknown as new (url: string) => WebSocket },
      { connection: () => {}, snapshot: (snapshot) => delivered.push(snapshot.decisions.incarnation), fatal: () => {} },
    );
    client.connect();
    answers[0]!(ok(tagged('boot')));
    await tick();
    const socket = sockets.at(-1)!;
    socket.onopen!();
    socket.onmessage!({ data: JSON.stringify({ type: 'auth_ok' }) });
    // A decision finished; the board asks for the authoritative snapshot...
    const refresh = client.refetchSnapshot();
    // ...and a push queued BEFORE the decision lands while that is in flight.
    socket.onmessage!({ data: JSON.stringify({ type: 'board', snapshot: tagged('pre-decision-push') }) });
    answers[1]!(ok(tagged('resolved')));
    await refresh;
    await tick();
    expect(delivered).toEqual(['boot', 'pre-decision-push']);
    expect(answers).toHaveLength(3); // exactly one trailing refetch
    answers[2]!(ok(tagged('resolved')));
    await tick();
    await tick();
    expect(delivered).toEqual(['boot', 'pre-decision-push', 'resolved']);
    expect(answers).toHaveLength(3);
    client.stop();
  });

  it('refresh demand that arrives while the trailing refetch runs is drained after it — two stale pushes, an overlapping wake (R6-04)', async () => {
    const answers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { answers.push(resolve); })) as unknown as typeof fetch;
    const sockets: { onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null }[] = [];
    class FakeSocket {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
    }
    const delivered: string[] = [];
    const ok = (snapshot: BoardSnapshot) => new Response(JSON.stringify(snapshot), { status: 200 });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const client = new BoardClient(
      { token: TOKEN, host: 'localhost', fetchImpl, webSocketCtor: FakeSocket as unknown as new (url: string) => WebSocket },
      { connection: () => {}, snapshot: (snapshot) => delivered.push(snapshot.decisions.incarnation), fatal: () => {} },
    );
    client.connect();
    answers[0]!(ok(tagged('boot')));
    await tick();
    const socket = sockets.at(-1)!;
    socket.onopen!();
    socket.onmessage!({ data: JSON.stringify({ type: 'auth_ok' }) });
    const push = (tag: string) => socket.onmessage!({ data: JSON.stringify({ type: 'board', snapshot: tagged(tag) }) });
    // A refresh; a stale push lands; its answer is discarded -> one trailing refetch.
    const refresh = client.refetchSnapshot();
    push('stale-1');
    answers[1]!(ok(tagged('fresh-1')));
    await refresh;
    await tick();
    expect(answers).toHaveLength(3);
    // A SECOND stale push lands while the trailing refetch runs: its answer
    // is discarded too, and the demand is drained once it settles.
    push('stale-2');
    answers[2]!(ok(tagged('fresh-2')));
    await tick();
    await tick();
    expect(answers).toHaveLength(4);
    answers[3]!(ok(tagged('fresh-3')));
    await tick();
    await tick();
    expect(delivered).toEqual(['boot', 'stale-1', 'stale-2', 'fresh-3']);
    expect(answers).toHaveLength(4); // drained once, nothing more owed
    // An overlapping wake: its answer is discarded while a trailing refetch
    // is still in flight — the demand waits for that one, then is drained.
    const again = client.refetchSnapshot();
    push('stale-3');
    answers[4]!(ok(tagged('fresh-4')));
    await again;
    await tick();
    expect(answers).toHaveLength(6); // the trailing refetch
    const wake = client.refetchSnapshot();
    push('stale-4');
    answers[6]!(ok(tagged('wake-answer'))); // discarded: a push landed, a refetch trails
    await wake;
    answers[5]!(ok(tagged('older-trailing'))); // superseded by the wake's newer request
    await tick();
    await tick();
    expect(answers).toHaveLength(8); // the owed successor
    answers[7]!(ok(tagged('fresh-5')));
    await tick();
    await tick();
    expect(delivered.slice(-3)).toEqual(['stale-3', 'stale-4', 'fresh-5']);
    client.stop();
  });

  /** A board client over a scripted fetch and a fake socket — every GET
   * waits for the test, answered with a plain response object (no body
   * stream), so fake timers alone drive time. */
  function scriptedClient() {
    const requests: Array<{ answer: (snapshot: BoardSnapshot) => void; hang: () => void; fail: () => void; refuse: (status: number) => void; refuseHung: (status: number) => void; signal: AbortSignal | undefined }> = [];
    const fetchImpl = vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      requests.push({
        answer: (snapshot) => resolve({ ok: true, status: 200, json: async () => snapshot } as unknown as Response),
        // The headers arrive but the body never finishes.
        hang: () => resolve({ ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response),
        fail: () => reject(new TypeError('fetch failed')),
        refuse: (status) => resolve({ ok: false, status, json: async () => ({ error: 'refused' }) } as unknown as Response),
        // The status arrives; its error body never does.
        refuseHung: (status) => resolve({ ok: false, status, json: () => new Promise(() => {}) } as unknown as Response),
        signal: init?.signal ?? undefined,
      });
    })) as unknown as typeof fetch;
    const sockets: { onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null }[] = [];
    class FakeSocket {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
    }
    const delivered: string[] = [];
    const fatals: string[] = [];
    const client = new BoardClient(
      { token: TOKEN, host: 'localhost', fetchImpl, webSocketCtor: FakeSocket as unknown as new (url: string) => WebSocket },
      // Like production's failPairing(): it reports, it does not stop the client.
      { connection: () => {}, snapshot: (snapshot) => delivered.push(snapshot.decisions.incarnation), fatal: (message) => fatals.push(message) },
    );
    const settle = () => vi.advanceTimersByTimeAsync(0);
    const open = async () => {
      client.connect();
      requests[0]!.answer(tagged('boot'));
      await settle();
      authenticate();
      return (tag: string) => sockets.at(-1)!.onmessage!({ data: JSON.stringify({ type: 'board', snapshot: tagged(tag) }) });
    };
    const authenticate = () => {
      const socket = sockets.at(-1)!;
      socket.onopen!();
      socket.onmessage!({ data: JSON.stringify({ type: 'auth_ok' }) });
    };
    return { client, requests, delivered, fatals, settle, open, authenticate };
  }

  it('sustained pushes with slower HTTP never loop GETs unbounded — a short burst, then capped backoff; the owed answer lands once pushes stop, and stop() cancels the queued one (R7-04)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { client, requests, delivered, settle, open, authenticate } = scriptedClient();
      const push = await open();
      void client.refetchSnapshot();
      // 30 s of pushes every 150 ms; every GET is answered only after the
      // next push landed, so every answer is discarded.
      let answered = 1;
      for (let t = 0; t < 30_000; t += 150) {
        push(`push-${t}`);
        while (answered < requests.length) requests[answered++]!.answer(tagged(`late-${answered}`));
        await settle();
        await vi.advanceTimersByTimeAsync(150);
      }
      // Without a bound this is one GET per push (~200); the burst of 2 and
      // the 1-2-4-8-8… s backoff allow at most a handful.
      expect(requests.length).toBeGreaterThan(3);
      expect(requests.length).toBeLessThanOrEqual(10);
      // Pushes stop: the demand was kept, so the waiting refetch still runs
      // and its answer — the authoritative one — is delivered.
      await vi.advanceTimersByTimeAsync(8_000);
      while (answered < requests.length) requests[answered++]!.answer(tagged('authoritative'));
      await settle();
      expect(delivered.at(-1)).toBe('authoritative');
      const quiet = requests.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(quiet); // the chain ended: nothing more owed
      // A fresh chain driven into backoff, then stop(): the queued refetch never runs.
      void client.refetchSnapshot();
      for (let i = 0; i < 4; i += 1) {
        push(`again-${i}`);
        while (answered < requests.length) requests[answered++]!.answer(tagged(`again-late-${i}`));
        await settle();
      }
      const beforeStop = requests.length;
      client.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(beforeStop);
      // Reconnected after a stop that interrupted a backoff: the old chain
      // stays dead — only the reconnect's own snapshot request runs.
      client.connect();
      requests[answered++]!.answer(tagged('back'));
      await settle();
      authenticate();
      void client.refetchSnapshot();
      for (let i = 0; i < 4; i += 1) {
        push(`pre-stop-${i}`);
        while (answered < requests.length) requests[answered++]!.answer(tagged(`pre-stop-late-${i}`));
        await settle();
      }
      const queued = requests.length;
      client.stop();
      client.connect();
      expect(requests).toHaveLength(queued + 1);
      requests[queued]!.answer(tagged('reconnected'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(queued + 1);
      expect(delivered.at(-1)).toBe('reconnected');
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hung trailing GET — at the fetch or in the body — is abandoned at its deadline, so newer owed demand drains without the old request ever answering; stop() cancels an in-flight one (R7-05)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { client, requests, delivered, settle, open } = scriptedClient();
      const push = await open();
      // A refresh discarded by a push -> a trailing refetch, which hangs at the fetch.
      void client.refetchSnapshot();
      push('stale-1');
      requests[1]!.answer(tagged('fresh-1'));
      await settle();
      expect(requests).toHaveLength(3); // the trailing refetch, never answered
      // A newer wake completes, is discarded by another push: demand owed behind the hung one.
      void client.refetchSnapshot();
      push('stale-2');
      requests[3]!.answer(tagged('wake'));
      await settle();
      expect(requests).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(requests[2]!.signal?.aborted).toBe(true); // the hung one was cancelled
      expect(requests).toHaveLength(5); // and the owed refresh ran
      // This one gets its headers, then its body hangs: abandoned the same way.
      requests[4]!.hang();
      void client.refetchSnapshot();
      push('stale-3');
      requests[5]!.answer(tagged('discarded-again'));
      await settle();
      expect(requests).toHaveLength(5 + 1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(requests[4]!.signal?.aborted).toBe(true);
      expect(requests).toHaveLength(6); // the chain's third refetch backs off (R7-04)...
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requests).toHaveLength(7); // ...and then runs
      requests[6]!.answer(tagged('fresh'));
      await settle();
      expect(delivered.at(-1)).toBe('fresh');
      // stop() cancels an in-flight snapshot request at once.
      void client.refetchSnapshot();
      expect(requests).toHaveLength(8);
      client.stop();
      expect(requests[7]!.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a trailing refetch that fails or times out keeps the owed answer — retried on the bounded schedule with no further push or wake; a delivery cancels a waiting retry (R8-02)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { client, requests, delivered, settle, open } = scriptedClient();
      const push = await open();
      // A decision's refresh loses to a queued pre-decision push...
      void client.refetchSnapshot();
      push('pre-decision');
      requests[1]!.answer(tagged('discarded'));
      await settle();
      expect(requests).toHaveLength(3);
      // ...its trailing replacement fails on the network: asked again at once.
      requests[2]!.fail();
      await settle();
      expect(requests).toHaveLength(4);
      // That one times out: the chain backs off, then asks again.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(requests).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requests).toHaveLength(5);
      requests[4]!.answer(tagged('authoritative'));
      await settle();
      expect(delivered.at(-1)).toBe('authoritative');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(5); // met: the chain ends
      // A retry waiting out its backoff is cancelled by a delivery from elsewhere.
      void client.refetchSnapshot();
      push('stale');
      requests[5]!.answer(tagged('discarded-again'));
      await settle();
      requests[6]!.fail();
      await settle();
      requests[7]!.fail();
      await settle();
      expect(requests).toHaveLength(8); // the third waits 1 s
      void client.refetchSnapshot(); // a wake, answered with no push in between
      requests[8]!.answer(tagged('woken'));
      await settle();
      expect(delivered.at(-1)).toBe('woken');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(9);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the newest ordinary refresh that times out, hangs in its body or fails — with no push at all — is asked again on the bounded chain; a refused pairing is not (R9-01)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { client, requests, delivered, settle, open } = scriptedClient();
      await open();
      // An owner decision's wake: its request outlives the deadline at the fetch...
      void client.refetchSnapshot();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(requests[1]!.signal?.aborted).toBe(true);
      expect(requests).toHaveLength(3); // asked again at once
      // ...its replacement hangs in the body, then the next fails outright.
      requests[2]!.hang();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(requests).toHaveLength(4);
      requests[3]!.fail();
      await settle();
      expect(requests).toHaveLength(4); // the burst is spent: it backs off
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requests).toHaveLength(5);
      requests[4]!.answer(tagged('after-failures'));
      await settle();
      expect(delivered.at(-1)).toBe('after-failures');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(5); // met: nothing more
      // A server error is transient too.
      void client.refetchSnapshot();
      requests[5]!.refuse(503);
      await settle();
      expect(requests).toHaveLength(7);
      requests[6]!.answer(tagged('recovered'));
      await settle();
      expect(delivered.at(-1)).toBe('recovered');
      // An OLDER request failing after a newer one was asked owes nothing.
      void client.refetchSnapshot();
      void client.refetchSnapshot();
      requests[7]!.fail();
      await settle();
      expect(requests).toHaveLength(9);
      requests[8]!.answer(tagged('newest'));
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(9);
      expect(delivered.at(-1)).toBe('newest');
      // stop() during a failure-driven backoff: nothing runs, and a reconnect revives nothing.
      void client.refetchSnapshot();
      requests[9]!.fail();
      await settle();
      requests[10]!.fail();
      await settle();
      requests[11]!.fail();
      await settle();
      expect(requests).toHaveLength(12); // the next waits 1 s
      client.stop();
      client.connect();
      expect(requests).toHaveLength(13);
      requests[12]!.answer(tagged('reconnected'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(13);
      client.stop();
      // A refused pairing is fatal, never retried.
      const refused = scriptedClient();
      await refused.open();
      void refused.client.refetchSnapshot();
      refused.requests[1]!.refuse(401);
      await refused.settle();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refused.requests).toHaveLength(2);
      refused.client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refused pairing (401) ends the client at once — an established refresh chain and a 401 whose error body hangs alike; nothing polls after it (R10-01)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // A refresh chain owes an answer; its trailing request is refused 401.
      const chain = scriptedClient();
      const push = await chain.open();
      void chain.client.refetchSnapshot();
      push('stale');
      chain.requests[1]!.answer(tagged('discarded'));
      await chain.settle();
      expect(chain.requests).toHaveLength(3);
      chain.requests[2]!.refuse(401);
      await chain.settle();
      expect(chain.fatals).toEqual(['unauthorized (board api)']);
      expect(chain.client.getState()).toBe('offline');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(chain.requests).toHaveLength(3); // no successor, no waiting retry
      // An ordinary refresh refused 401 whose error body never arrives: the
      // client ends on the status, not after the deadline.
      const hung = scriptedClient();
      await hung.open();
      void hung.client.refetchSnapshot();
      hung.requests[1]!.refuseHung(401);
      await hung.settle();
      expect(hung.fatals).toEqual(['unauthorized (board api)']);
      expect(hung.client.getState()).toBe('offline');
      expect(hung.requests[1]!.signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(hung.requests).toHaveLength(2);
      expect(hung.fatals).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a malformed review is refused before anything renders it — a valid one passes', async () => {
    const review = (removed: unknown) => ({
      id: 'prop-1',
      createdAt: '2026-10-07T00:00:00.000Z',
      notificationId: 'lp-1',
      entries: 1,
      throughSeq: 1,
      decision: null,
      recovery: null,
      index: [],
      chapters: [{
        slug: 'ops',
        title: { before: 'Ops', after: 'Ops' },
        retired: false,
        summary: { before: 'S.', after: 'S.' },
        tags: { before: [], after: [] },
        added: [],
        changed: [],
        removed: [removed],
        provenanceTrimmed: 0,
        bodiesTrimmed: 0,
      }],
    });
    let body: unknown = review({ slug: 'gone', body: 'Text.', recurred: 1, reason: 'cap' }); // no tags
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const reviewing = new BoardClient({ token: TOKEN, host: 'localhost', fetchImpl }, { connection: () => {}, snapshot: () => {}, fatal: () => {} });
    await expect(reviewing.getLessonProposal()).rejects.toThrow('lesson proposal review is malformed');
    body = review({ slug: 'gone', body: 'Text.', recurred: 1, tags: ['ops'], reason: 'cap' });
    await expect(reviewing.getLessonProposal()).resolves.toMatchObject({ id: 'prop-1' });
  });
});
