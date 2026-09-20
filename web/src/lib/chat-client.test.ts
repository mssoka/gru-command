import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { ChatClient, type ChatMessage, type ConnectionState } from './chat-client.js';
import {
  parseClientFrame,
  type ContextFrame,
  type ControlResultFrame,
  type LoggedFrame,
  type ServerFrame,
} from './protocol.js';
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
  epoch = 0;
  replayFloorSeq = 0;
  contextState: 'idle' | 'busy' | 'compacting' | 'resetting' = 'idle';
  usage: ContextFrame['usage'] = null;
  controls: Array<{ action: 'compact' | 'new_chat'; request_id: string }> = [];
  failNextNewChat = false;
  deferNextNewChat = false;
  deferNextCompact = false;
  writer = true;
  omitNextContext = false;
  authCount = 0;
  deferredNewChat: { socket: WebSocket; request_id: string } | null = null;
  deferredCompact: { socket: WebSocket; request_id: string } | null = null;
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
          this.authCount += 1;
          const lastSeen = frame.last_seen_seq ?? 0;
          this.send(socket, { type: 'auth_ok', seq: this.seq });
          if (this.omitNextContext) {
            this.omitNextContext = false;
            return;
          }
          this.send(socket, {
            type: 'context',
            epoch: this.epoch,
            replay_floor_seq: this.replayFloorSeq,
            state: this.contextState,
            usage: this.usage,
            compact_supported: true,
            session_active: true,
            writer: this.writer,
          });
          for (const logged of this.log) {
            const s = 'seq' in logged && typeof logged.seq === 'number' ? logged.seq : 0;
            if (s > Math.max(lastSeen, this.replayFloorSeq)) this.send(socket, logged);
          }
          return;
        }
        if (frame.type === 'control') {
          this.controls.push({ action: frame.action, request_id: frame.request_id });
          if (frame.action === 'compact' && this.deferNextCompact) {
            this.deferNextCompact = false;
            this.contextState = 'compacting';
            this.deferredCompact = { socket, request_id: frame.request_id };
            this.broadcastContext();
            return;
          }
          if (frame.action === 'new_chat' && this.deferNextNewChat) {
            this.deferNextNewChat = false;
            this.contextState = 'resetting';
            this.deferredNewChat = { socket, request_id: frame.request_id };
            this.broadcastContext();
            return;
          }
          const failNewChat = frame.action === 'new_chat' && this.failNextNewChat;
          this.failNextNewChat = false;
          if (frame.action === 'new_chat' && !failNewChat) {
            this.epoch += 1;
            this.replayFloorSeq = this.seq;
          }
          this.send(socket, failNewChat
            ? {
                type: 'control_result',
                action: frame.action,
                request_id: frame.request_id,
                ok: false,
                epoch: this.epoch,
                code: 'failed',
                message: 'fresh spawn failed',
              }
            : {
                type: 'control_result',
                action: frame.action,
                request_id: frame.request_id,
                ok: true,
                epoch: this.epoch,
              });
          this.contextState = 'idle';
          this.send(socket, {
            type: 'context',
            epoch: this.epoch,
            replay_floor_seq: this.replayFloorSeq,
            state: this.contextState,
            usage: this.usage,
            compact_supported: true,
            session_active: true,
            writer: true,
          });
          return;
        }
        if (frame.type !== 'user') return;
        if (
          frame.epoch !== this.epoch ||
          this.log.some(
            (l) => l.type === 'user' && l.client_msg_id === frame.client_msg_id && l.epoch === frame.epoch,
          )
        ) {
          this.send(socket, { type: 'ack', client_msg_id: frame.client_msg_id, seq: ++this.seq });
          return;
        }
        this.record({
          type: 'user',
          text: frame.text,
          client_msg_id: frame.client_msg_id,
          epoch: frame.epoch,
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

  broadcastContext(): void {
    for (const socket of this.sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      this.send(socket, {
        type: 'context',
        epoch: this.epoch,
        replay_floor_seq: this.replayFloorSeq,
        state: this.contextState,
        usage: this.usage,
        compact_supported: true,
        session_active: true,
        writer: this.writer,
      });
    }
  }

  completeDeferredCompact(): void {
    const pending = this.deferredCompact;
    if (pending === null) throw new Error('no deferred compact');
    this.deferredCompact = null;
    if (pending.socket.readyState === WebSocket.OPEN) {
      this.send(pending.socket, {
        type: 'control_result',
        action: 'compact',
        request_id: pending.request_id,
        ok: true,
        epoch: this.epoch,
      });
    }
    this.contextState = 'idle';
    this.broadcastContext();
  }

  completeDeferredNewChat(): void {
    const pending = this.deferredNewChat;
    if (pending === null) throw new Error('no deferred new chat');
    this.deferredNewChat = null;
    this.epoch += 1;
    this.replayFloorSeq = this.seq;
    // Production publishes the committed epoch while it is still resetting,
    // before the terminal result and final idle snapshot.
    this.contextState = 'resetting';
    this.broadcastContext();
    if (pending.socket.readyState === WebSocket.OPEN) {
      this.send(pending.socket, {
        type: 'control_result',
        action: 'new_chat',
        request_id: pending.request_id,
        ok: true,
        epoch: this.epoch,
      });
    }
    this.contextState = 'idle';
    this.broadcastContext();
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
  epochs: number[];
  contexts: ContextFrame[];
  controlResults: string[];
  controlResultFrames: ControlResultFrame[];
}

function makeClient(
  server: TestServer,
  storage: StorageLike,
  token = TOKEN,
  options: { readonly contextTimeoutMs?: number } = {},
): Harness {
  const frames: LoggedFrame[] = [];
  const statuses: ChatMessage[] = [];
  const states: ConnectionState[] = [];
  const fatals: string[] = [];
  const replayStarts: boolean[] = [];
  const epochs: number[] = [];
  const contexts: ContextFrame[] = [];
  const controlResults: string[] = [];
  const controlResultFrames: ControlResultFrame[] = [];
  let replayEnds = 0;
  const client = new ChatClient(
    {
      token,
      host: `localhost:${server.port}`,
      secure: false,
      storage,
      webSocketCtor: WebSocket as unknown as ConstructorParameters<typeof ChatClient>[0]['webSocketCtor'],
      idgen: () => `m${Math.random().toString(36).slice(2, 10)}`,
      ...options,
    },
    {
      connection: (s) => states.push(s),
      messageStatus: (m) => statuses.push(m),
      frame: (f) => frames.push(f),
      replayStart: (full) => replayStarts.push(full),
      replayEnd: () => {
        replayEnds += 1;
      },
      context: (snapshot) => contexts.push(snapshot),
      epochChange: (epoch) => epochs.push(epoch),
      controlResult: (result) => {
        controlResults.push(result.request_id);
        controlResultFrames.push(result);
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
    epochs,
    contexts,
    controlResults,
    controlResultFrames,
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

  it('delivers authoritative non-null provider usage through the protocol seam', async () => {
    server.usage = { tokens: 370, context_window: 1_000, percent: 37 };
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.contexts.length > 0 && h.replayEnds === 1);
    expect(h.contexts[0]?.usage).toEqual(server.usage);
  });

  it('sends fixed control actions and clears old sent messages only after epoch confirmation', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);
    h.client.send('old epoch');
    await waitFor(() => h.client.getMessages().some((message) => message.status === 'acked'));

    const compactId = h.client.requestControl('compact');
    await waitFor(() => h.controlResults.includes(compactId));
    expect(server.controls.at(-1)?.action).toBe('compact');

    server.failNextNewChat = true;
    const failedResetId = h.client.requestControl('new_chat');
    const afterFailedReset = h.client.send('typed while failed reset is pending');
    await waitFor(() => h.controlResults.includes(failedResetId));
    await waitFor(() =>
      server.log.some((frame) => frame.type === 'user' && frame.text === afterFailedReset.text),
    );
    expect(
      h.client.getMessages().find((message) => message.client_msg_id === afterFailedReset.client_msg_id),
    ).toMatchObject({ status: 'acked', epoch: 0 });

    const resetId = h.client.requestControl('new_chat');
    const duringReset = h.client.send('typed while reset is pending');
    expect(duringReset.status).toBe('queued');
    expect(duringReset.epoch).toBeUndefined();
    expect(server.log.some((frame) => frame.type === 'user' && frame.text === duringReset.text)).toBe(false);
    await waitFor(() => h.controlResults.includes(resetId) && h.epochs.includes(1));
    await waitFor(() =>
      server.log.some((frame) => frame.type === 'user' && frame.text === duringReset.text),
    );
    expect(
      h.client.getMessages().find((message) => message.client_msg_id === duringReset.client_msg_id),
    ).toMatchObject({ status: 'acked', epoch: 1 });

    h.client.stop();
    h.client.send('never sent words');
    server.epoch = 2;
    server.replayFloorSeq = server.seq;
    h.client.connect();
    await waitFor(() => h.epochs.includes(2));
    await waitFor(() => h.client.getMessages().some((message) => message.text === 'never sent words'));
    expect(h.client.getMessages().some((message) => message.text === 'old epoch')).toBe(false);
    expect(h.client.getMessages().some((message) => message.text === 'never sent words')).toBe(true);
  });

  it('reports an honest unknown compact outcome after its terminal result is lost', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);
    server.deferNextCompact = true;
    const requestId = h.client.requestControl('compact');
    await waitFor(() => h.contexts.some((snapshot) => snapshot.state === 'compacting'));
    server.dropAll();
    await waitFor(() => h.states.includes('offline'));
    await waitFor(
      () => h.client.getState() === 'open' && h.contexts.filter((s) => s.state === 'compacting').length >= 2,
    );
    server.completeDeferredCompact();
    await waitFor(() => h.controlResultFrames.some((result) => result.request_id === requestId));
    expect(
      h.controlResultFrames.find((result) => result.request_id === requestId),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      message: expect.stringContaining('lost during reconnect'),
    });
  });

  it('persists pending New chat across reload and suppresses retiring replay until commit', async () => {
    const storage = memStorage();
    const first = makeClient(server, storage);
    clients.push(first.client);
    first.client.connect();
    await waitFor(() => first.client.getState() === 'open' && first.replayEnds === 1);
    first.client.send('retired transcript');
    await waitFor(() => server.log.some((frame) => frame.type === 'user'));

    server.deferNextNewChat = true;
    first.client.requestControl('new_chat');
    await waitFor(() => first.contexts.some((snapshot) => snapshot.state === 'resetting'));
    expect(storage.map.has('gru-pending-new-chat')).toBe(true);
    first.client.stop();

    const reloaded = makeClient(server, storage);
    clients.push(reloaded.client);
    expect(reloaded.client.hasPendingNewChat()).toBe(true);
    reloaded.client.connect();
    await waitFor(
      () => reloaded.contexts.some((snapshot) => snapshot.state === 'resetting'),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(reloaded.frames.some((frame) => frame.type === 'user' && frame.text === 'retired transcript')).toBe(false);
    expect(reloaded.replayEnds).toBe(0);

    server.completeDeferredNewChat();
    await waitFor(() => reloaded.epochs.includes(1) && reloaded.replayEnds === 1);
    expect(reloaded.client.hasPendingNewChat()).toBe(false);
    expect(storage.map.has('gru-pending-new-chat')).toBe(false);
    expect(reloaded.frames.some((frame) => frame.type === 'user' && frame.text === 'retired transcript')).toBe(false);
  });

  it('recovers a pending new chat when reconnect first observes resetting', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);

    server.deferNextNewChat = true;
    h.client.requestControl('new_chat');
    const held = h.client.send('held across reset reconnect');
    await waitFor(() => h.contexts.some((snapshot) => snapshot.state === 'resetting'));
    server.dropAll();
    await waitFor(() => h.states.includes('offline'));
    await waitFor(
      () =>
        h.client.getState() === 'open' &&
        h.contexts.filter((snapshot) => snapshot.state === 'resetting').length >= 2,
    );
    expect(server.log.some((frame) => frame.type === 'user' && frame.text === held.text)).toBe(false);

    server.completeDeferredNewChat();
    await waitFor(() => h.epochs.includes(1));
    await waitFor(() => server.log.some((frame) => frame.type === 'user' && frame.text === held.text));
    expect(
      h.client.getMessages().find((message) => message.client_msg_id === held.client_msg_id),
    ).toMatchObject({ status: 'acked', epoch: 1 });
    expect(() => h.client.requestControl('new_chat')).not.toThrow();
  });

  it('treats an advanced resetting epoch as committed success when the result was lost', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);

    server.deferNextNewChat = true;
    const requestId = h.client.requestControl('new_chat');
    const held = h.client.send('deliver into recovered committed epoch');
    await waitFor(() => h.contexts.some((snapshot) => snapshot.state === 'resetting'));
    server.dropAll();
    await waitFor(() => h.states.includes('offline'));
    // Durable activation committed while the requesting socket was gone.
    // Reconnect first sees that advanced epoch still in resetting state.
    server.deferredNewChat = null;
    server.epoch = 1;
    server.replayFloorSeq = server.seq;
    server.contextState = 'resetting';
    await waitFor(
      () =>
        h.client.getState() === 'open' &&
        h.contexts.some((snapshot) => snapshot.epoch === 1 && snapshot.state === 'resetting'),
    );
    server.contextState = 'idle';
    server.broadcastContext();
    await waitFor(() => server.log.some((frame) => frame.type === 'user' && frame.text === held.text));
    expect(
      h.controlResultFrames.some((result) => result.request_id === requestId && !result.ok),
    ).toBe(false);
    expect(
      h.client.getMessages().find((message) => message.client_msg_id === held.client_msg_id),
    ).toMatchObject({ status: 'acked', epoch: 1 });
  });

  it('surfaces an inferred failed New chat when its result is lost on reconnect', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);

    server.deferNextNewChat = true;
    const requestId = h.client.requestControl('new_chat');
    const held = h.client.send('return to old epoch after failed reset');
    await waitFor(() => h.contexts.some((snapshot) => snapshot.state === 'resetting'));
    server.dropAll();
    await waitFor(() => h.states.includes('offline'));
    await waitFor(
      () =>
        h.client.getState() === 'open' &&
        h.contexts.filter((snapshot) => snapshot.state === 'resetting').length >= 2,
    );

    server.deferredNewChat = null;
    server.contextState = 'idle';
    server.broadcastContext();
    await waitFor(() => h.controlResults.includes(requestId));
    await waitFor(() => server.log.some((frame) => frame.type === 'user' && frame.text === held.text));
    expect(server.epoch).toBe(0);
  });

  it('keeps reader words queued locally until that socket is promoted writer', async () => {
    server.writer = false;
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);
    const queued = h.client.send('wait for the pen');
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(server.log.some((frame) => frame.type === 'user' && frame.text === queued.text)).toBe(false);
    const beforePromotion = h.client.getMessages().find(
      (message) => message.client_msg_id === queued.client_msg_id,
    );
    expect(beforePromotion).toMatchObject({ status: 'queued' });
    expect(beforePromotion?.epoch).toBeUndefined();

    server.writer = true;
    server.broadcastContext();
    await waitFor(() => server.log.some((frame) => frame.type === 'user' && frame.text === queued.text));
    await waitFor(
      () =>
        h.client.getMessages().find((message) => message.client_msg_id === queued.client_msg_id)
          ?.status === 'acked',
    );
  });

  it('fails closed on a regressed context epoch without clearing the active view', async () => {
    const h = makeClient(server, memStorage());
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);
    server.epoch = 2;
    server.broadcastContext();
    await waitFor(() => h.epochs.includes(2));
    const contextsAtTwo = h.contexts.length;

    server.epoch = 1;
    server.broadcastContext();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(h.contexts).toHaveLength(contextsAtTwo);
    expect(h.epochs).not.toContain(1);
    expect(h.fatals.some((message) => message.includes('epoch regressed'))).toBe(true);
  });

  it('rejects a send when its initial durable queue entry cannot be persisted', async () => {
    const blockedStorage: StorageLike = {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error('quota blocked');
      },
    };
    const h = makeClient(server, blockedStorage);
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);
    expect(() => h.client.send('stay local without durable epoch')).toThrow(/storage is unavailable/);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(
      server.log.some((frame) => frame.type === 'user' && frame.text === 'stay local without durable epoch'),
    ).toBe(false);
    expect(h.client.getMessages()).toEqual([]);
  });

  it('reload does not resurrect a persisted sent item across an epoch boundary', async () => {
    const storage = memStorage();
    storage.setItem(
      'gru-outbox',
      JSON.stringify([
        { client_msg_id: 'sent-old', text: 'already left old epoch', status: 'sent', epoch: 0 },
        { client_msg_id: 'never-sent', text: 'still local', status: 'queued' },
      ]),
    );
    server.contextState = 'resetting';
    const h = makeClient(server, storage);
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(server.log.some((frame) => frame.type === 'user' && frame.text === 'still local')).toBe(false);
    server.epoch = 1;
    server.replayFloorSeq = server.seq;
    server.contextState = 'idle';
    server.broadcastContext();
    await waitFor(() => h.client.getMessages().some((message) => message.text === 'still local'));
    await waitFor(() => server.log.some((frame) => frame.type === 'user' && frame.text === 'still local'));
    expect(server.log.some((frame) => frame.type === 'user' && frame.text === 'already left old epoch')).toBe(false);
    expect(h.client.getMessages().some((message) => message.text === 'already left old epoch')).toBe(false);
    expect(h.epochs).toContain(1);
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

  it('closes and retries when auth_ok is not followed by required context', async () => {
    server.omitNextContext = true;
    const h = makeClient(server, memStorage(), TOKEN, { contextTimeoutMs: 20 });
    clients.push(h.client);
    h.client.connect();
    await waitFor(() => h.states.includes('offline'));
    expect(h.replayEnds).toBe(0);
    expect(h.contexts).toEqual([]);
    await waitFor(() => h.client.getState() === 'open' && h.replayEnds === 1);
    expect(server.authCount).toBeGreaterThanOrEqual(2);
    expect(h.contexts.at(-1)).toMatchObject({ type: 'context', epoch: 0 });
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

  it('restores outbox records independently: null chips and empty IDs cannot poison healthy siblings', async () => {
    const storage = memStorage();
    const validChips = [{ path: '/data/uploads/ok.png', name: 'ok.png', kind: 'image' as const }];
    storage.setItem(
      'gru-outbox',
      JSON.stringify([
        { client_msg_id: 'healthy-before', text: 'first healthy record' },
        { client_msg_id: 'corrupt-text', text: 'keep my text', attachments: { length: 1 } },
        { client_msg_id: 'null-chip-text', text: 'null chip degrades', attachments: [null] },
        { client_msg_id: 'null-chip-empty', text: '', attachments: [null] },
        { client_msg_id: '', text: 'never acknowledgeable' },
        { client_msg_id: 'valid-chip', text: '', attachments: validChips },
        { client_msg_id: 'overlong-with-chip', text: 'x'.repeat(4_001), attachments: validChips },
        { client_msg_id: 'healthy-after', text: 'still here' },
      ]),
    );
    const h = makeClient(server, storage);
    clients.push(h.client);
    h.client.connect();
    for (const id of [
      'healthy-before',
      'corrupt-text',
      'null-chip-text',
      'valid-chip',
      'overlong-with-chip',
      'healthy-after',
    ]) {
      await waitFor(() => h.statuses.some((m) => m.client_msg_id === id && m.status === 'acked'));
    }

    expect(h.client.getMessages().some((m) => m.client_msg_id === 'null-chip-empty')).toBe(false);
    expect(h.client.getMessages().some((m) => m.client_msg_id === '')).toBe(false);
    expect(server.log.find((f) => f.type === 'user' && f.client_msg_id === 'null-chip-empty')).toBeUndefined();
    expect(server.log.find((f) => f.type === 'user' && f.client_msg_id === '')).toBeUndefined();
    expect(server.log.find((f) => f.type === 'user' && f.client_msg_id === 'null-chip-text')).toMatchObject({
      text: 'null chip degrades',
    });
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
    expect(server.log.filter((f) => f.type === 'user').map((f) => f.client_msg_id)).toEqual([
      'healthy-before',
      'corrupt-text',
      'null-chip-text',
      'valid-chip',
      'overlong-with-chip',
      'healthy-after',
    ]);
  });

  it('persists offline attachment messages and restores their exact chips after reload', async () => {
    const storage = memStorage();
    const first = makeClient(server, storage);
    clients.push(first.client);
    const textChips = [{ path: '/workspace/spec.md', name: 'spec.md', kind: 'file' as const }];
    const imageChips = [{ path: '/data/uploads/shot.png', name: 'shot.png', kind: 'image' as const }];
    const withText = first.client.send('review this', textChips);
    const attachmentOnly = first.client.send('', imageChips);

    const persisted = JSON.parse(storage.map.get('gru-outbox') ?? '[]') as Array<Record<string, unknown>>;
    expect(persisted).toEqual([
      {
        client_msg_id: withText.client_msg_id,
        text: 'review this',
        attachments: textChips,
        status: 'queued',
      },
      {
        client_msg_id: attachmentOnly.client_msg_id,
        text: '',
        attachments: imageChips,
        status: 'queued',
      },
    ]);

    const second = makeClient(server, storage);
    clients.push(second.client);
    second.client.connect();
    await waitFor(() => second.statuses.some((m) => m.client_msg_id === withText.client_msg_id && m.status === 'acked'));
    await waitFor(() => second.statuses.some((m) => m.client_msg_id === attachmentOnly.client_msg_id && m.status === 'acked'));

    expect(server.log.filter((f) => f.type === 'user' && f.client_msg_id === withText.client_msg_id)).toEqual([
      expect.objectContaining({ text: 'review this', attachments: textChips }),
    ]);
    expect(server.log.filter((f) => f.type === 'user' && f.client_msg_id === attachmentOnly.client_msg_id)).toEqual([
      expect.objectContaining({ text: '', attachments: imageChips }),
    ]);
    expect(storage.map.has('gru-outbox')).toBe(false);
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
