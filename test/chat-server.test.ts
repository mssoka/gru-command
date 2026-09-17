import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as web from '../web/src/lib/protocol.js';
import { ChatFrameLog } from '../src/chat/frame-log.js';
import { createChatServer, type ChatServer } from '../src/chat/server.js';
import { GruSessionPointer } from '../src/chat/session-state.js';
import type { GruCommandConfig } from '../src/config.js';
import { withFallbacks } from '../src/runtime/fallbacks.js';
import type {
  AgentCapabilities,
  AgentHandle,
  AgentRuntime,
  AgentState,
  PromptOptions,
  RuntimeEvent,
  RuntimeEventListener,
} from '../src/runtime/types.js';

/**
 * The E4 chat server over REAL sockets (story 4). Every frame the client
 * harness receives is parsed with the WEB contract validator — any frame
 * the server emits that the frontend would reject shows up as
 * `__malformed__` and fails the exact-sequence assertions.
 */

const TOKEN = 'test-token';
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scriptable stub Gru session
// ---------------------------------------------------------------------------

interface StubCall {
  readonly op: 'prompt' | 'steer';
  readonly text: string;
  readonly owner: string | undefined;
}

class StubGruHandle implements AgentHandle {
  readonly role = 'gru' as const;
  readonly id = 'stub-gru';
  sessionFile: string | null;
  readonly calls: StubCall[] = [];
  /** Deltas emitted per prompt turn. */
  deltas: readonly string[] = ['Hello', ' boss'];
  /** When set, the turn emits tool start/end around the deltas. */
  toolName: string | null = null;
  /** Hold the NEXT prompt's turn open until this resolves. */
  nextHold: Promise<void> | null = null;
  /** The NEXT prompt rejects with this error before any event. */
  nextPromptError: string | null = null;
  /** The NEXT prompt emits a fatal runtime error mid-turn (no turn end). */
  nextFatal: string | null = null;
  private state: AgentState = 'idle';
  private readonly listeners = new Set<RuntimeEventListener>();

  constructor(sessionFile: string | null) {
    this.sessionFile = sessionFile;
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    this.calls.push({ op: 'prompt', text, owner: options?.owner });
    if (this.nextPromptError !== null) {
      const message = this.nextPromptError;
      this.nextPromptError = null;
      throw new Error(message);
    }
    const hold = this.nextHold;
    this.nextHold = null;
    const fatal = this.nextFatal;
    this.nextFatal = null;
    this.setState('streaming');
    this.emit({ type: 'turn_start' });
    if (this.toolName !== null) {
      this.emit({ type: 'tool_start', callId: 'c1', tool: this.toolName });
    }
    for (const delta of this.deltas) this.emit({ type: 'text_delta', delta });
    if (fatal !== null) {
      this.setState('error');
      this.emit({ type: 'error', error: fatal, fatal: true });
      return; // the turn never ends (dead runtime)
    }
    if (this.toolName !== null) {
      this.emit({ type: 'tool_end', callId: 'c1', isError: false });
    }
    if (hold !== null) await hold;
    this.setState('idle');
    this.emit({ type: 'turn_end' });
  }

  async steer(text: string, options?: PromptOptions): Promise<void> {
    this.calls.push({ op: 'steer', text, owner: options?.owner });
  }

  async followUp(_text: string, _options?: PromptOptions): Promise<void> {
    throw new Error('not used by the chat layer');
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  health() {
    return {
      state: this.state,
      lastActivity: null,
      sessionFile: this.sessionFile,
    };
  }

  async dispose(): Promise<void> {}

  private setState(state: AgentState): void {
    this.state = state;
    this.emit({ type: 'state', state });
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class StubGruRuntime implements AgentRuntime {
  readonly id = 'stub-gru-runtime';
  readonly capabilities: AgentCapabilities;
  readonly handle: StubGruHandle;

  constructor(handle: StubGruHandle, steer: 'native' | 'queued') {
    this.handle = handle;
    this.capabilities = {
      streaming: true,
      steer,
      resume: 'file',
      images: false,
      thinking: true,
      thinkingLevelControl: true,
      followUp: true,
    };
  }

  async spawn(): Promise<AgentHandle> {
    return this.handle;
  }

  health() {
    return { state: 'ok' as const };
  }

  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly dir: string;
  readonly chatDir: string;
  readonly frameLog: ChatFrameLog;
  readonly chat: ChatServer;
  readonly http: HttpServer;
  readonly port: number;
  readonly handle: StubGruHandle;
  readonly spawnCalls: (string | null)[];
  failNextSpawn(error: Error): void;
  close(): Promise<void>;
}

async function makeHarness(options: {
  readonly token?: string;
  readonly authDeadlineMs?: number;
  readonly steer?: 'native' | 'queued';
  readonly reuseDir?: string;
  readonly failFirstSpawn?: Error;
} = {}): Promise<Harness> {
  const dir = options.reuseDir ?? mkdtempSync(join(tmpdir(), 'gru-command-e4-'));
  cleanupDirs.push(dir);
  const chatDir = join(dir, 'chat');
  mkdirSync(chatDir, { recursive: true });
  // The stub's session file must EXIST for the resume pointer to take it.
  const sessionsDir = join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, 'stub-gru-session.jsonl');
  writeFileSync(sessionFile, '', { flag: 'a' });

  const frameLog = ChatFrameLog.load(chatDir);
  const pointer = new GruSessionPointer(chatDir);
  const handle = new StubGruHandle(sessionFile);
  const runtime = new StubGruRuntime(handle, options.steer ?? 'native');
  const wrapped = options.steer === 'queued' ? withFallbacks(runtime) : runtime;
  const spawnCalls: (string | null)[] = [];
  let spawnFailure: Error | null = options.failFirstSpawn ?? null;
  const chat = createChatServer({
    config: { auth: { token: options.token ?? TOKEN } } as GruCommandConfig,
    frameLog,
    pointer,
    spawnGru: (resumeFile) => {
      spawnCalls.push(resumeFile);
      if (spawnFailure !== null) {
        const error = spawnFailure;
        spawnFailure = null;
        return Promise.reject(error);
      }
      return wrapped.spawn('gru');
    },
    authDeadlineMs: options.authDeadlineMs,
    heartbeatMs: 0, // heartbeat timing is not under test here
  });
  const http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  chat.attach(http);
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  const port = (http.address() as AddressInfo).port;
  return {
    dir,
    chatDir,
    frameLog,
    chat,
    http,
    port,
    handle,
    spawnCalls,
    failNextSpawn(error: Error) {
      spawnFailure = error;
    },
    async close() {
      await chat.dispose();
      await new Promise<void>((resolveClose) => {
        http.closeAllConnections();
        http.close(() => resolveClose());
      });
    },
  };
}

type Received = web.ServerFrame | { readonly type: '__malformed__'; readonly raw: string };

class TestClient {
  readonly frames: Received[] = [];
  readonly closed: Promise<number>;
  private readonly socket: WebSocket;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.closed = new Promise((resolveClose) => {
      this.socket.on('close', (code: number) => resolveClose(code));
    });
    this.socket.on('message', (data: unknown) => {
      const raw = String(data);
      this.frames.push(web.parseServerFrame(raw) ?? { type: '__malformed__', raw });
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolveOpen, rejectOpen) => {
      this.socket.once('open', () => resolveOpen());
      this.socket.once('error', rejectOpen);
    });
  }

  sendRaw(payload: unknown): void {
    this.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  auth(token: string, lastSeenSeq?: number): void {
    this.sendRaw({
      type: 'auth',
      token,
      ...(lastSeenSeq !== undefined ? { last_seen_seq: lastSeenSeq } : {}),
    });
  }

  send(text: string, clientMsgId: string): void {
    this.sendRaw({ type: 'user', text, client_msg_id: clientMsgId });
  }

  async waitFor(
    pred: (frame: Received) => boolean,
    label: string,
    timeoutMs = 5_000,
  ): Promise<Received> {
    const started = Date.now();
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`waitFor(${label}) timed out; frames: ${JSON.stringify(this.frames)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async waitForCount(count: number, timeoutMs = 5_000): Promise<void> {
    await this.waitFor(() => this.frames.length >= count, `frame count ${count}`, timeoutMs);
  }

  close(): Promise<number> {
    this.socket.close();
    return this.closed;
  }

  terminate(): Promise<number> {
    this.socket.terminate();
    return this.closed;
  }
}

const isType = (type: string) => (frame: Received) => (frame as { type: string }).type === type;

/** Poll a non-frame condition (server-side state the client can't see). */
async function pollUntil(pred: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`pollUntil(${label}) timed out`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function authedClient(port: number, token: string = TOKEN, lastSeenSeq?: number): Promise<TestClient> {
  const client = new TestClient(port);
  await client.open();
  client.auth(token, lastSeenSeq);
  await client.waitFor(isType('auth_ok'), 'auth_ok');
  return client;
}

const isTurnEndFrame = (frame: Received): boolean =>
  (frame as { type: string; state?: string }).type === 'turn' &&
  (frame as { state?: string }).state === 'end';

/** Capture BEFORE the send, then await: resolves when a NEW turn end
 * arrives (replays contain old turn ends, so a naive first-match after
 * the fact returns instantly and races the delivery chain). */
function nextTurnEnd(client: TestClient): Promise<void> {
  const before = client.frames.filter(isTurnEndFrame).length;
  return client.waitFor(
    () => client.frames.filter(isTurnEndFrame).length > before,
    `turn end #${before + 1}`,
  ).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat server (real sockets, stub Gru)', () => {
  it('round-trip: auth, user+ack, then the live turn stream with consecutive seqs', async () => {
    const harness = await makeHarness();
    const client = await authedClient(harness.port);
    expect(client.frames[0]).toEqual({ type: 'auth_ok', seq: 0 });

    const done = nextTurnEnd(client);
    client.send('hello gru', 'm1');
    await done;
    const kinds = client.frames.map((frame) => frame.type);
    expect(kinds).toEqual(['auth_ok', 'user', 'ack', 'turn', 'delta', 'delta', 'turn']);
    expect(client.frames[1]).toMatchObject({ type: 'user', text: 'hello gru', client_msg_id: 'm1', seq: 1 });
    expect(client.frames[2]).toMatchObject({ type: 'ack', client_msg_id: 'm1', seq: 2 });
    expect(client.frames[3]).toMatchObject({ type: 'turn', state: 'start', seq: 3 });
    expect(client.frames[4]).toMatchObject({ type: 'delta', text: 'Hello', seq: 4 });
    expect(client.frames[5]).toMatchObject({ type: 'delta', text: ' boss', seq: 5 });
    expect(client.frames[6]).toMatchObject({ type: 'turn', state: 'end', seq: 6 });
    // Every frame parsed web-valid (no __malformed__) and the seqs are 1..N.
    expect(kinds).not.toContain('__malformed__');
    expect(harness.frameLog.highWaterSeq).toBe(6);
    expect(harness.handle.calls).toEqual([{ op: 'prompt', text: 'hello gru', owner: 'chat' }]);
    await client.close();
    await harness.close();
  });

  it('streams tool activity as tool start/end frames inside the turn', async () => {
    const harness = await makeHarness();
    harness.handle.toolName = 'read';
    const client = await authedClient(harness.port);
    const done = nextTurnEnd(client);
    client.send('use a tool', 'm1');
    await done;
    const kinds = client.frames.map((frame) => frame.type);
    expect(kinds).toEqual(['auth_ok', 'user', 'ack', 'turn', 'tool', 'delta', 'delta', 'tool', 'turn']);
    expect(client.frames[4]).toMatchObject({ type: 'tool', name: 'read', state: 'start' });
    expect(client.frames[7]).toMatchObject({ type: 'tool', name: 'read', state: 'end' });
    await client.close();
    await harness.close();
  });

  it('fresh page load: full history replay restores both sides of the conversation', async () => {
    const harness = await makeHarness();
    const first = await authedClient(harness.port);
    let done = nextTurnEnd(first);
    first.send('first message', 'm1');
    await done;
    done = nextTurnEnd(first);
    first.send('second message', 'm2');
    await done;

    const fresh = await authedClient(harness.port);
    await fresh.waitForCount(first.frames.length); // auth_ok + replay of the log
    const replayed = fresh.frames.slice(1);
    expect(replayed).toEqual(first.frames.slice(1) as web.ServerFrame[]);
    await first.close();
    await fresh.close();
    await harness.close();
  });

  it('reconnect: last_seen_seq replays exactly the missed frames after auth_ok', async () => {
    const harness = await makeHarness();
    const first = await authedClient(harness.port);
    let done = nextTurnEnd(first);
    first.send('one', 'm1');
    await done;
    const seen = first.frames.length; // auth_ok + logged frames so far
    done = nextTurnEnd(first);
    first.send('two', 'm2');
    await done;

    const highWater = harness.frameLog.highWaterSeq;
    const reconnected = await authedClient(harness.port, TOKEN, 1);
    await reconnected.waitForCount(1 + (highWater - 1));
    expect(reconnected.frames[0]).toEqual({ type: 'auth_ok', seq: highWater });
    const replayed = reconnected.frames.slice(1);
    expect(replayed).toEqual(first.frames.slice(2) as web.ServerFrame[]); // log frames with seq > 1
    expect(replayed.length).toBe(seen - 2 + (first.frames.length - seen));
    await first.close();
    await reconnected.close();
    await harness.close();
  });

  it('rejects a bad token and a non-auth first frame fatally, logging nothing', async () => {
    const harness = await makeHarness();

    const badToken = new TestClient(harness.port);
    await badToken.open();
    badToken.auth('wrong-token');
    const fatal1 = await badToken.waitFor(isType('error'), 'fatal error');
    expect(fatal1).toEqual({ type: 'error', message: 'unauthorized: bad token', fatal: true });
    await badToken.closed;

    const noAuth = new TestClient(harness.port);
    await noAuth.open();
    noAuth.send('skipping auth', 'm1');
    const fatal2 = await noAuth.waitFor(isType('error'), 'fatal error');
    expect(fatal2).toEqual({ type: 'error', message: 'first frame must be auth', fatal: true });
    await noAuth.closed;

    expect(harness.frameLog.highWaterSeq).toBe(0);
    expect(harness.handle.calls).toEqual([]);
    await harness.close();
  });

  it('rejects on auth timeout, and rejects every connection when no token is configured', async () => {
    const slow = await makeHarness({ authDeadlineMs: 50 });
    const idle = new TestClient(slow.port);
    await idle.open();
    const timeoutError = await idle.waitFor(isType('error'), 'auth timeout');
    expect(timeoutError).toEqual({
      type: 'error',
      message: 'auth timeout: first frame must be auth',
      fatal: true,
    });
    await idle.closed;
    await slow.close();

    const unconfigured = await makeHarness({ token: '' });
    const client = new TestClient(unconfigured.port);
    await client.open();
    client.auth(TOKEN);
    const notConfigured = await client.waitFor(isType('error'), 'not configured');
    expect(notConfigured).toMatchObject({
      type: 'error',
      fatal: true,
      message: expect.stringContaining('chat is not configured'),
    });
    await client.closed;
    await unconfigured.close();
  });

  it('malformed frames and re-auth are non-fatal, seq-logged, and the connection survives', async () => {
    const harness = await makeHarness();
    const client = await authedClient(harness.port);
    client.sendRaw('this is not json');
    await client.waitForCount(2);
    expect(client.frames[1]).toMatchObject({ type: 'error', message: 'malformed frame', seq: 1 });
    client.auth(TOKEN); // a second auth while authed
    await client.waitForCount(3);
    expect(client.frames[2]).toMatchObject({
      type: 'error',
      message: 'already authenticated',
      seq: 2,
    });
    const done = nextTurnEnd(client);
    client.send('still alive', 'm1');
    await done;
    expect(harness.handle.calls).toEqual([{ op: 'prompt', text: 'still alive', owner: 'chat' }]);
    await client.close();
    await harness.close();
  });

  it('second client attaches read-only: live broadcast in, sends rejected ephemerally', async () => {
    const harness = await makeHarness();
    const writer = await authedClient(harness.port);
    const firstTurn = nextTurnEnd(writer);
    writer.send('for the readers', 'm1');
    await firstTurn;

    const reader = await authedClient(harness.port);
    await reader.waitForCount(1 + harness.frameLog.highWaterSeq); // auth_ok + full replay
    const before = harness.frameLog.highWaterSeq;
    reader.send('trying to write', 'r1');
    const rejection = await reader.waitFor(
      (frame) => frame.type === 'error',
      'read-only rejection',
    );
    expect(rejection).toEqual({ type: 'error', message: 'read-only: another client holds the pen' });
    // Ephemeral: no seq, nothing logged, nothing delivered.
    expect(rejection).not.toHaveProperty('seq');
    expect(harness.frameLog.highWaterSeq).toBe(before);
    expect(harness.handle.calls).toHaveLength(1);

    // The reader sees the writer's traffic live.
    const done = nextTurnEnd(writer);
    writer.send('another update', 'm2');
    await done;
    await reader.waitFor(
      (frame) => frame.type === 'user' && (frame as web.ReplayedUserFrame).client_msg_id === 'm2',
      'live user broadcast',
    );
    await reader.waitFor(
      (frame) => frame.type === 'turn' && (frame as web.TurnFrame).state === 'end',
      'live turn end',
    );
    expect(reader.frames.length).toBeGreaterThanOrEqual(writer.frames.length - 1);
    await writer.close();
    await reader.close();
    await harness.close();
  });

  it('the pen promotes FIFO on writer disconnect: the earliest reader can then send', async () => {
    const harness = await makeHarness();
    const writer = await authedClient(harness.port);
    const readerA = await authedClient(harness.port);
    const readerB = await authedClient(harness.port);

    // While the writer lives, both readers are rejected.
    readerA.send('nope', 'ra1');
    await readerA.waitFor(isType('error'), 'rejection');
    await writer.close();

    // Earliest reader promoted — retry through the promotion race: rejected
    // attempts are ephemeral (unlogged, undelivered), and a landed attempt
    // dedups any re-send, so retrying 'ra2' is always safe.
    let promoted = false;
    for (let attempt = 0; attempt < 25 && !promoted; attempt++) {
      readerA.send('promoted', 'ra2');
      try {
        await readerA.waitFor(
          (frame) => frame.type === 'ack' && (frame as web.AckFrame).client_msg_id === 'ra2',
          'promoted ack',
          200,
        );
        promoted = true;
      } catch {
        /* not promoted yet */
      }
    }
    expect(promoted).toBe(true);
    readerB.send('still read-only', 'rb1');
    const rejectionB = await readerB.waitFor(isType('error'), 'second rejection');
    expect(rejectionB).toEqual({
      type: 'error',
      message: 'read-only: another client holds the pen',
    });
    // The promoted turn may already have completed during the retry loop:
    // wait for its turn end by count (readerA saw no earlier turns).
    await pollUntil(
      () => readerA.frames.filter(isTurnEndFrame).length >= 1,
      'promoted turn end',
    );
    expect(harness.handle.calls).toEqual([{ op: 'prompt', text: 'promoted', owner: 'chat' }]);
    await readerA.close();
    await readerB.close();
    await harness.close();
  });

  it('mid-turn messages are delivered as steer on a native-steer runtime', async () => {
    const harness = await makeHarness({ steer: 'native' });
    let releaseTurn!: () => void;
    harness.handle.nextHold = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    const client = await authedClient(harness.port);
    client.send('start a long turn', 'm1');
    await client.waitFor(
      (frame) => frame.type === 'turn' && (frame as web.TurnFrame).state === 'start',
      'turn start',
    );
    client.send('adjust course', 'm2');
    await client.waitFor(
      (frame) => frame.type === 'ack' && (frame as web.AckFrame).client_msg_id === 'm2',
      'steer ack',
    );
    // The steer reached the live session WITHOUT waiting for turn end
    // (the ack precedes delivery — poll for the server-side call).
    await pollUntil(() => harness.handle.calls.length === 2, 'steer delivered');
    expect(harness.handle.calls).toEqual([
      { op: 'prompt', text: 'start a long turn', owner: 'chat' },
      { op: 'steer', text: 'adjust course', owner: 'chat' },
    ]);
    const done = nextTurnEnd(client);
    releaseTurn();
    await done;
    await client.close();
    await harness.close();
  });

  it('mid-turn messages on a queued-steer runtime serialize through the fallback', async () => {
    const harness = await makeHarness({ steer: 'queued' });
    let releaseTurn!: () => void;
    harness.handle.nextHold = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    const client = await authedClient(harness.port);
    client.send('first', 'm1');
    await client.waitFor(
      (frame) => frame.type === 'turn' && (frame as web.TurnFrame).state === 'start',
      'first turn start',
    );
    client.send('second', 'm2');
    // Acked immediately (never lose a typed word), delivered after the turn.
    await client.waitFor(
      (frame) => frame.type === 'ack' && (frame as web.AckFrame).client_msg_id === 'm2',
      'second ack',
    );
    expect(harness.handle.calls).toHaveLength(1);
    releaseTurn();
    await client.waitForCount(13, 10_000); // auth_ok + two full exchanges (6 frames each)
    expect(harness.handle.calls).toEqual([
      { op: 'prompt', text: 'first', owner: 'chat' },
      { op: 'prompt', text: 'second', owner: 'chat' },
    ]);
    // Two settled turns in order, no interleaving.
    const turnStates = client.frames
      .filter((frame) => frame.type === 'turn')
      .map((frame) => (frame as web.TurnFrame).state);
    expect(turnStates).toEqual(['start', 'end', 'start', 'end']);
    await client.close();
    await harness.close();
  });

  it('re-sent client_msg_id gets a fresh ack with no re-delivery and no duplicate user frame', async () => {
    const harness = await makeHarness();
    const client = await authedClient(harness.port);
    const done = nextTurnEnd(client);
    client.send('only once', 'dup-1');
    await done;
    const before = harness.frameLog.highWaterSeq;

    client.send('only once', 'dup-1'); // re-send (unacked-across-drop case)
    await client.waitForCount(1 + before + 1);
    const reAck = client.frames.at(-1);
    expect(reAck).toMatchObject({ type: 'ack', client_msg_id: 'dup-1', seq: before + 1 });
    expect(harness.handle.calls).toHaveLength(1);
    expect(
      harness.frameLog.history.filter((frame) => frame.type === 'user'),
    ).toHaveLength(1);
    await client.close();
    await harness.close();
  });

  it('a fatal runtime error mid-turn logs the error and settles the turn', async () => {
    const harness = await makeHarness();
    harness.handle.toolName = 'bash';
    harness.handle.nextFatal = 'the runtime exploded';
    const client = await authedClient(harness.port);
    client.send('doomed prompt', 'm1');
    await client.waitFor(
      (frame) => frame.type === 'turn' && (frame as web.TurnFrame).state === 'end',
      'settled turn',
    );
    const kinds = client.frames.map((frame) => frame.type);
    expect(kinds).toEqual(['auth_ok', 'user', 'ack', 'turn', 'tool', 'delta', 'delta', 'error', 'tool', 'turn']);
    expect(client.frames[7]).toMatchObject({
      type: 'error',
      message: 'the runtime exploded',
      fatal: true,
    });
    expect(client.frames[8]).toMatchObject({ type: 'tool', name: 'bash', state: 'end' });
    expect(client.frames[9]).toMatchObject({ type: 'turn', state: 'end' });
    // History is settled; the session recovers for the next prompt.
    expect(harness.frameLog.hasOpenTurn).toBe(false);
    harness.handle.toolName = null;
    client.send('recovery prompt', 'm2');
    await pollUntil(() => harness.handle.calls.length === 2, 'recovery delivered');
    await client.waitForCount(16); // + user, ack, turn, delta, delta, turn
    expect(harness.handle.calls[1]).toEqual({ op: 'prompt', text: 'recovery prompt', owner: 'chat' });
    await client.close();
    await harness.close();
  });

  it('spawn failure surfaces an ephemeral error; the next send retries and succeeds', async () => {
    const harness = await makeHarness({ failFirstSpawn: new Error('model unavailable') });
    const client = await authedClient(harness.port);
    client.send('wake the brain', 'm1');
    await client.waitFor(isType('error'), 'spawn failure');
    const notice = client.frames.at(-1);
    expect(notice).toEqual({ type: 'error', message: 'gru is unavailable: model unavailable' });
    expect(notice).not.toHaveProperty('seq');
    expect(harness.handle.calls).toEqual([]);

    const done = nextTurnEnd(client);
    client.send('wake the brain', 'm2');
    await done;
    expect(harness.handle.calls).toEqual([{ op: 'prompt', text: 'wake the brain', owner: 'chat' }]);
    expect(harness.spawnCalls).toEqual([null, null]); // fresh brain both times
    await client.close();
    await harness.close();
  });

  it('service restart: seq and history continue, an open turn boot-settles, the same Gru resumes', async () => {
    const first = await makeHarness();
    const clientA = await authedClient(first.port);
    const doneA = nextTurnEnd(clientA);
    clientA.send('before the restart', 'm1');
    await doneA;
    // Leave a turn OPEN (held) to simulate a mid-turn process death.
    let releaseTurn!: () => void;
    first.handle.nextHold = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    clientA.send('interrupted', 'm2');
    await clientA.waitFor(
      (frame) => frame.type === 'ack' && (frame as web.AckFrame).client_msg_id === 'm2',
      'second ack',
    );
    const recordedSession = first.handle.sessionFile;
    const seqAtDeath = first.frameLog.highWaterSeq;
    await first.close(); // chat dispose: clients get 1001; the turn never ends
    releaseTurn(); // let the leaked prompt settle quietly (unsubscribed)

    // "Restart": fresh chat server over the same dirs.
    const second = await makeHarness({ reuseDir: first.dir });
    // Boot settled the open turn.
    expect(second.frameLog.highWaterSeq).toBe(seqAtDeath + 1);
    expect(second.frameLog.hasOpenTurn).toBe(false);
    expect(second.frameLog.history.at(-1)).toEqual({
      type: 'turn',
      state: 'end',
      seq: seqAtDeath + 1,
    });

    const clientB = await authedClient(second.port);
    // Full replay: everything from before the restart, including the settle.
    await clientB.waitForCount(1 + second.frameLog.highWaterSeq);
    expect(clientB.frames.slice(1)).toEqual([...second.frameLog.history] as web.ServerFrame[]);

    // New traffic continues the seq, and the spawn RESUMED the same session.
    const doneB = nextTurnEnd(clientB);
    clientB.send('after the restart', 'm3');
    await doneB;
    expect(second.spawnCalls).toEqual([recordedSession]);
    const lastAck = clientB.frames.find(
      (frame) => frame.type === 'ack' && (frame as web.AckFrame).client_msg_id === 'm3',
    );
    expect(lastAck).toMatchObject({ seq: seqAtDeath + 3 }); // user, then ack
    await clientB.close();
    await second.close();
  });
});
