import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { ChatClient, type ChatMessage, type ConnectionState } from './chat-client.js';
import { parseClientFrame, type LoggedFrame, type ServerFrame } from './protocol.js';
import type { StorageLike } from '../theme.js';

/**
 * Contract-level tests: a minimal in-test server implementing the same
 * protocol as web/mock/server.ts (auth, seq log, replay, instant replies).
 */

const TOKEN = 'test-token';

class TestServer {
  wss: WebSocketServer | null = null;
  port = 0;
  log: LoggedFrame[] = [];
  seq = 0;
  sockets = new Set<WebSocket>();

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ port: 0, path: '/ws' });
    await new Promise<void>((resolve) => this.wss!.once('listening', resolve));
    const address = this.wss.address();
    if (typeof address === 'object' && address !== null) this.port = address.port;
    this.wss.on('connection', (socket) => {
      this.sockets.add(socket);
      let authed = false;
      socket.on('message', (data) => {
        const frame = parseClientFrame(String(data));
        if (frame === null) return;
        if (!authed) {
          if (frame.type !== 'auth' || frame.token !== TOKEN) {
            this.send(socket, { type: 'error', message: 'unauthorized', fatal: true });
            socket.close();
            return;
          }
          authed = true;
          const lastSeen = frame.last_seen_seq ?? 0;
          this.send(socket, { type: 'auth_ok', seq: this.seq });
          for (const logged of this.log) {
            const s = 'seq' in logged && typeof logged.seq === 'number' ? logged.seq : 0;
            if (s > lastSeen) this.send(socket, logged);
          }
          return;
        }
        if (frame.type !== 'user') return;
        if (this.log.some((l) => l.type === 'user' && l.client_msg_id === frame.client_msg_id)) {
          this.send(socket, { type: 'ack', client_msg_id: frame.client_msg_id, seq: ++this.seq });
          return;
        }
        this.record({
          type: 'user',
          text: frame.text,
          client_msg_id: frame.client_msg_id,
          ...(frame.attachments !== undefined ? { attachments: frame.attachments } : {}),
          seq: ++this.seq,
        });
        this.send(socket, { type: 'ack', client_msg_id: frame.client_msg_id, seq: ++this.seq });
        this.reply(socket, frame.text);
      });
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  record(frame: LoggedFrame): void {
    this.log.push(frame);
  }

  send(socket: WebSocket, frame: ServerFrame): void {
    socket.send(JSON.stringify(frame));
  }

  reply(socket: WebSocket, text: string): void {
    for (const frame of [
      { type: 'turn', state: 'start' },
      { type: 'delta', text: `echo:${text}` },
      { type: 'tool', name: 'echo-tool', state: 'start' },
      { type: 'tool', name: 'echo-tool', state: 'end' },
      { type: 'turn', state: 'end' },
    ] as const) {
      const full = { ...frame, seq: ++this.seq } as LoggedFrame;
      this.record(full);
      this.send(socket, full);
    }
  }

  /** Simulate another client chatting while our client is away. */
  injectBackgroundTraffic(text: string): void {
    const id = `bg-${this.seq}`;
    this.record({ type: 'user', text, client_msg_id: id, seq: ++this.seq });
    const frames: LoggedFrame[] = [
      { type: 'turn', state: 'start', seq: ++this.seq },
      { type: 'delta', text: `echo:${text}`, seq: ++this.seq },
      { type: 'turn', state: 'end', seq: ++this.seq },
    ];
    frames.forEach((f) => this.record(f));
  }

  dropAll(): void {
    for (const socket of this.sockets) socket.terminate();
  }

  async stop(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
  }
}

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

interface Harness {
  client: ChatClient;
  frames: LoggedFrame[];
  statuses: ChatMessage[];
  states: ConnectionState[];
  fatals: string[];
  replayStarts: boolean[];
  replayEnds: number;
}

function makeClient(server: TestServer, storage: StorageLike, token = TOKEN): Harness {
  const frames: LoggedFrame[] = [];
  const statuses: ChatMessage[] = [];
  const states: ConnectionState[] = [];
  const fatals: string[] = [];
  const replayStarts: boolean[] = [];
  let replayEnds = 0;
  const client = new ChatClient(
    {
      token,
      host: `localhost:${server.port}`,
      secure: false,
      storage,
      webSocketCtor: WebSocket as unknown as ConstructorParameters<typeof ChatClient>[0]['webSocketCtor'],
      idgen: () => `m${Math.random().toString(36).slice(2, 10)}`,
    },
    {
      connection: (s) => states.push(s),
      messageStatus: (m) => statuses.push(m),
      frame: (f) => frames.push(f),
      replayStart: (full) => replayStarts.push(full),
      replayEnd: () => {
        replayEnds += 1;
      },
      fatal: (m) => fatals.push(m),
    },
  );
  return {
    client,
    frames,
    statuses,
    states,
    fatals,
    replayStarts,
    get replayEnds() {
      return replayEnds;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ChatClient', () => {
  let server: TestServer;
  let clients: ChatClient[];

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.stop();
    await server.stop();
  });

  it('SEND: message flows queued → sent → acked and the reply streams', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    // Fresh connect = full replay request.
    expect(h.replayStarts).toEqual([true]);
    h.client.send('hello boss');
    await waitFor(() => h.statuses.some((m) => m.status === 'acked'));
    const order = h.statuses.map((m) => m.status);
    expect(order).toEqual(['queued', 'sent', 'acked']);
    await waitFor(() => h.frames.some((f) => f.type === 'turn' && f.state === 'end'));
    const deltaTexts = h.frames.filter((f) => f.type === 'delta').map((f) => f.text);
    expect(deltaTexts.join('')).toContain('echo:hello boss');
    expect(h.frames.some((f) => f.type === 'tool' && f.name === 'echo-tool')).toBe(true);
  });

  it('OFFLINE-SEND: typed while down → queued, persisted, flushed on connect', async () => {
    const storage = memStorage();
    const h = makeClient(server, storage);
    clients.push(h.client);
    // Never connected: message queues and persists.
    h.client.send('do it later');
    expect(storage.map.get('gru-outbox')).toContain('do it later');
    h.client.connect();
    await waitFor(() => h.statuses.some((m) => m.status === 'acked'));
    expect(storage.map.has('gru-outbox')).toBe(false);
    expect(server.log.some((f) => f.type === 'user' && f.text === 'do it later')).toBe(true);
  });

  it('queue survives a page reload (new client, same storage)', async () => {
    const storage = memStorage();
    const first = makeClient(server, storage);
    clients.push(first.client);
    first.client.send('remember me');
    const second = makeClient(server, storage);
    clients.push(second.client);
    second.client.connect();
    await waitFor(() => second.statuses.some((m) => m.text === 'remember me' && m.status === 'acked'));
  });

  it('RECONNECT: missed history replays exactly once, no duplicates', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    h.client.send('first');
    await waitFor(() => h.frames.some((f) => f.type === 'turn' && f.state === 'end'));

    const seenBefore = h.frames.length;
    h.client.stop();
    h.states.length = 0;

    // Traffic happens while we are away.
    server.injectBackgroundTraffic('while away');

    const h2 = makeClient(server, memStorage());
    clients.push(h2.client);
    h2.client.connect();
    await waitFor(() => h2.frames.some((f) => f.type === 'delta'));
    // Fresh load: full history including our own first message + its reply.
    expect(h2.frames.filter((f) => f.type === 'user' && f.text === 'first').length).toBe(1);
    expect(h2.frames.filter((f) => f.type === 'delta').length).toBe(2);
    const seqs = h2.frames.map((f) => ('seq' in f ? f.seq : 0));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seenBefore).toBeGreaterThan(0);
  });

  it('socket drop mid-session reconnects with last_seen_seq (no full replay)', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    h.client.send('before drop');
    await waitFor(() => h.frames.some((f) => f.type === 'turn' && f.state === 'end'));
    const countBefore = h.frames.length;

    server.dropAll();
    // DEGRADED: offline state surfaces (drives the banner), then recovery.
    await waitFor(() => h.client.getState() === 'offline');
    expect(h.states).toContain('offline');
    await waitFor(() => h.client.getState() === 'open', 15_000);
    expect(h.states).toEqual(expect.arrayContaining(['connecting', 'open', 'offline']));
    // Same-client reconnect = incremental replay (full === false), so the
    // UI must NOT wipe the log.
    expect(h.replayStarts).toEqual([true, false]);

    // Nothing new happened while down → zero frames replayed.
    await new Promise((r) => setTimeout(r, 200));
    expect(h.frames.length).toBe(countBefore);
    // Still usable: another send works on the new socket.
    h.client.send('after drop');
    await waitFor(() =>
      h.frames.some((f) => f.type === 'delta' && f.text.includes('after drop')),
    );
  });

  it('bad token → fatal error, no reconnect loop', async () => {
    const h = makeClient(server, memStorage(), 'wrong-token');
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.fatals.length > 0);
    expect(h.fatals[0]).toContain('unauthorized');
    await new Promise((r) => setTimeout(r, 300));
    expect(h.client.getState()).not.toBe('open');
  });

  it('stop() settles the client to idle', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    h.client.stop();
    expect(h.client.getState()).toBe('idle');
  });

  it('send() rejects empty and oversized text without queueing', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    expect(() => h.client.send('   ')).toThrow('empty message');
    expect(() => h.client.send('x'.repeat(4_001))).toThrow('too long');
    expect(h.client.getMessages().length).toBe(0);
  });

  it('server log reset is detected and resynced with a full replay', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    h.client.send('before reset');
    await waitFor(() => h.frames.some((f) => f.type === 'turn' && f.state === 'end'));

    // Simulate E4-style log truncation: counter restarts at zero.
    server.log.length = 0;
    server.seq = 0;
    server.dropAll();

    await waitFor(() => h.client.getState() === 'open', 15_000);
    h.client.send('after reset');
    await waitFor(() =>
      h.frames.some((f) => f.type === 'delta' && f.text.includes('after reset')),
    );
  });

  it('non-fatal server errors surface as frames, session stays open', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    for (const socket of server.sockets) {
      socket.send(JSON.stringify({ type: 'error', message: 'gru is thinking slowly', seq: 999 }));
    }
    await waitFor(() => h.frames.some((f) => f.type === 'error'));
    expect(h.client.getState()).toBe('open');
  });

  it('malformed frames are ignored without killing the session', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    for (const socket of server.sockets) socket.send('{"type":');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.client.getState()).toBe('open');
    h.client.send('still alive');
    await waitFor(() => h.statuses.some((m) => m.status === 'acked'));
  });
});

describe('attachments ride the outbox (SPEC ruling 19)', () => {
  let server: TestServer;
  let clients: ChatClient[];

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.stop();
    await server.stop();
  });

  it('send(text, chips) queues a message carrying the chips and ships them on the wire', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    const chips = [{ path: '/ws/repo/notes.md', name: 'notes.md', kind: 'file' as const }];
    const message = h.client.send('read this', chips);
    expect(message.attachments).toEqual(chips);
    await waitFor(() => server.log.some((f) => f.type === 'user' && 'attachments' in f));
    const shipped = server.log.find((f) => f.type === 'user' && 'attachments' in f);
    expect(shipped).toMatchObject({ type: 'user', client_msg_id: message.client_msg_id, attachments: chips });
    await waitFor(() => h.statuses.some((m) => m.status === 'acked'));
  });

  it('invalid chips throw at send(); a corrupted outbox restore degrades to text-only (review r1)', async () => {
    const storage = memStorage();
    storage.setItem(
      'gru-outbox',
      JSON.stringify([
        {
          client_msg_id: 'corrupt-1',
          text: 'survives with chips dropped',
          attachments: [{ path: '/ok.png', name: 'ok.png', kind: 'image' }, { path: '', name: 'bad', kind: 'video' }],
        },
      ]),
    );
    const h = makeClient(server, storage);
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    // The corrupted entry restored WITHOUT its chips (still sends).
    await waitFor(() => h.statuses.some((m) => m.client_msg_id === 'corrupt-1'));
    const restored = h.client.getMessages().find((m) => m.client_msg_id === 'corrupt-1');
    expect(restored?.attachments).toBeUndefined();

    // Over-cap chips are refused at the seam, never queued.
    expect(() =>
      h.client.send('too many', Array.from({ length: 9 }, (_, i) => ({ path: `/f${i}`, name: `f${i}`, kind: 'file' as const }))),
    ).toThrow(/invalid attachments/);
  });

  it('restores outbox entries independently: non-array chips cannot drop siblings or create an immortal empty frame', async () => {
    const storage = memStorage();
    const validChips = [{ path: '/data/uploads/ok.png', name: 'ok.png', kind: 'image' as const }];
    storage.setItem(
      'gru-outbox',
      JSON.stringify([
        { client_msg_id: 'corrupt-text', text: 'keep my text', attachments: { length: 1 } },
        { client_msg_id: 'corrupt-empty', text: '', attachments: { length: 1 } },
        { client_msg_id: 'valid-chip', text: '', attachments: validChips },
        { client_msg_id: 'overlong-with-chip', text: 'x'.repeat(4_001), attachments: validChips },
        { client_msg_id: 'healthy-after', text: 'still here' },
      ]),
    );
    const h = makeClient(server, storage);
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.statuses.some((m) => m.client_msg_id === 'healthy-after' && m.status === 'acked'));
    await waitFor(() => h.statuses.some((m) => m.client_msg_id === 'valid-chip' && m.status === 'acked'));
    await waitFor(() => h.statuses.some((m) => m.client_msg_id === 'overlong-with-chip' && m.status === 'acked'));
    await waitFor(() => h.statuses.some((m) => m.client_msg_id === 'corrupt-text' && m.status === 'acked'));

    expect(h.client.getMessages().some((m) => m.client_msg_id === 'corrupt-empty')).toBe(false);
    expect(server.log.find((f) => f.type === 'user' && f.client_msg_id === 'corrupt-empty')).toBeUndefined();
    expect(server.log.find((f) => f.type === 'user' && f.client_msg_id === 'corrupt-text')).toMatchObject({
      text: 'keep my text',
    });
    expect(server.log.find((f) => f.type === 'user' && f.client_msg_id === 'valid-chip')).toMatchObject({
      attachments: validChips,
    });
    expect(server.log.find((f) => f.type === 'user' && f.client_msg_id === 'overlong-with-chip')).toMatchObject({
      text: '',
      attachments: validChips,
    });
  });

  it('attachment-only sends are legal; empty sends still throw', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open');
    const chips = [{ path: '/data/uploads/1-shot.png', name: 'shot.png', kind: 'image' as const }];
    const message = h.client.send('', chips);
    expect(message.text).toBe('');
    await waitFor(() => h.statuses.some((m) => m.client_msg_id === message.client_msg_id && m.status === 'acked'));
    expect(() => h.client.send('   ')).toThrow(/empty message/);
  });
});
