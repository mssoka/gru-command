import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect as netConnect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as web from '../web/src/lib/protocol.js';
import { ChatFrameLog } from '../src/chat/frame-log.js';
import { createChatServer, type ChatServer } from '../src/chat/server.js';
import { GruSessionPointer, SESSION_STATE_NAME } from '../src/chat/session-state.js';
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
  readonly id: string;
  /** Vision-capable by default; the SPEC ruling 19 gate tests flip it. */
  capabilities: AgentCapabilities = {
    streaming: true,
    steer: 'native',
    resume: 'file',
    images: true,
    thinking: true,
    thinkingLevelControl: true,
    followUp: true,
  };
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
  /** The NEXT prompt emits a non-fatal runtime error mid-turn (turn completes). */
  nextSoftError: string | null = null;
  /** The NEXT steer rejects with this error (W2 leg). */
  nextSteerError: string | null = null;
  compactCalls = 0;
  nextCompactError: string | null = null;
  nextCompactHold: Promise<void> | null = null;
  disposeHold: Promise<void> | null = null;
  nextDisposeError: Error | null = null;
  disposalStarted = false;
  private disposalPromise: Promise<void> | null = null;
  throwOnUnsubscribe = false;
  throwHealthProbe = false;
  throwUsageProbe = false;
  throwCompactProbe = false;
  startCompactionOnNextHealth = false;
  disposed = false;
  private state: AgentState = 'idle';
  private readonly listeners = new Set<RuntimeEventListener>();

  constructor(sessionFile: string | null, id = 'stub-gru') {
    this.sessionFile = sessionFile;
    this.id = id;
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
    const softError = this.nextSoftError;
    this.nextSoftError = null;
    this.setState('streaming');
    this.emit({ type: 'turn_start' });
    if (this.toolName !== null) {
      this.emit({ type: 'tool_start', callId: 'c1', tool: this.toolName });
    }
    for (const delta of this.deltas) this.emit({ type: 'text_delta', delta });
    if (softError !== null) {
      this.emit({ type: 'error', error: softError, fatal: false });
    }
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
    if (this.nextSteerError !== null) {
      const message = this.nextSteerError;
      this.nextSteerError = null;
      throw new Error(message);
    }
  }

  async followUp(_text: string, _options?: PromptOptions): Promise<void> {
    throw new Error('not used by the chat layer');
  }

  getContextUsage() {
    if (this.throwUsageProbe) throw new Error('usage probe failed');
    return this.state === 'idle'
      ? { tokens: 20, contextWindow: 100, percent: 20, source: 'provider' as const }
      : null;
  }

  async compact(): Promise<void> {
    this.compactCalls += 1;
    this.emit({ type: 'compaction_start' });
    const hold = this.nextCompactHold;
    this.nextCompactHold = null;
    if (hold !== null) await hold;
    const failure = this.nextCompactError;
    this.nextCompactError = null;
    if (failure !== null) {
      this.emit({ type: 'compaction_end', success: false, error: failure });
      throw new Error(failure);
    }
    this.emit({ type: 'compaction_end', success: true });
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      if (this.throwOnUnsubscribe) throw new Error('stub unsubscribe failed');
      this.listeners.delete(listener);
    };
  }

  health() {
    if (this.throwHealthProbe) throw new Error('health probe failed');
    if (this.startCompactionOnNextHealth) {
      this.startCompactionOnNextHealth = false;
      this.emit({ type: 'compaction_start' });
    }
    return {
      state: this.state,
      lastActivity: null,
      sessionFile: this.sessionFile,
    };
  }

  canCompact = (): boolean => {
    if (this.throwCompactProbe) throw new Error('compact probe failed');
    return !this.disposed && this.state === 'idle';
  };

  dispose(): Promise<void> {
    if (this.disposalPromise !== null) return this.disposalPromise;
    this.disposalStarted = true;
    const hold = this.disposeHold;
    const failure = this.nextDisposeError;
    this.disposalPromise = (async () => {
      if (hold !== null) await hold;
      if (failure !== null) throw failure;
      this.disposed = true;
      this.setState('disposed');
    })();
    return this.disposalPromise;
  }

  /** Test hook: emit a runtime event directly (lens guards, edge shapes). */
  fire(event: RuntimeEvent): void {
    this.emit(event);
  }

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
      followUp: false, // honest: the stub's followUp() throws
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
  /** Real workspace fixture (ruling 19 provenance): ws/repo-a/*. */
  readonly workspaceRoot: string;
  /** Real uploads fixture (ruling 19 provenance): <dir>/uploads. */
  readonly uploadsDir: string;
  readonly chatDir: string;
  readonly frameLog: ChatFrameLog;
  readonly chat: ChatServer;
  readonly http: HttpServer;
  readonly port: number;
  readonly handle: StubGruHandle;
  readonly spawnCalls: (string | null)[];
  readonly freshHandles: StubGruHandle[];
  readonly resumedHandles: StubGruHandle[];
  close(): Promise<void>;
}

async function makeHarness(options: {
  readonly token?: string;
  readonly authDeadlineMs?: number;
  readonly heartbeatMs?: number;
  readonly controlTimeoutMs?: number;
  readonly steer?: 'native' | 'queued';
  readonly reuseDir?: string;
  readonly failFirstSpawn?: Error;
  readonly failFirstFreshSpawn?: Error;
  readonly failFirstPointerAdvance?: Error;
  readonly freshSpawnHold?: Promise<void>;
  readonly freshDisposeHold?: Promise<void>;
  readonly returnMismatchedOnResume?: boolean;
  readonly reuseActiveOnFresh?: boolean;
  readonly reuseActiveAliasOnFresh?: boolean;
  readonly reuseActiveHardLinkOnFresh?: boolean;
  readonly reuseActiveIdOnFresh?: boolean;
  readonly replaceDisposedOnResume?: boolean;
  readonly canAdoptFreshGru?: () => boolean;
  readonly adoptFreshGru?: (handle: AgentHandle) => Promise<void>;
  readonly siblingUpgradePaths?: readonly string[];
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

  // Ruling 19 provenance fixtures: chip paths must REALLY live under the
  // workspace root or the uploads dir (the delivery gate realpaths them).
  const workspaceRoot = join(dir, 'ws');
  const uploadsDir = join(dir, 'uploads');
  mkdirSync(join(workspaceRoot, 'repo-a'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'repo-a', 'notes.md'), 'notes', 'utf-8');
  writeFileSync(join(workspaceRoot, 'repo-a', 'shot.png'), 'png', 'utf-8');
  mkdirSync(uploadsDir, { recursive: true });

  const frameLog = ChatFrameLog.load(chatDir);
  const pointer = new GruSessionPointer(chatDir);
  if (options.failFirstPointerAdvance !== undefined) {
    const advance = pointer.advance.bind(pointer);
    let failure: Error | null = options.failFirstPointerAdvance;
    pointer.advance = (file, floor) => {
      if (failure !== null) {
        const error = failure;
        failure = null;
        throw error;
      }
      return advance(file, floor);
    };
  }
  const handle = new StubGruHandle(pointer.resumeCandidate() ?? sessionFile);
  const runtime = new StubGruRuntime(handle, options.steer ?? 'native');
  const wrapped = options.steer === 'queued' ? withFallbacks(runtime) : runtime;
  const spawnCalls: (string | null)[] = [];
  const freshHandles: StubGruHandle[] = [];
  const resumedHandles: StubGruHandle[] = [];
  let spawnFailure: Error | null = options.failFirstSpawn ?? null;
  let freshSpawnFailure: Error | null = options.failFirstFreshSpawn ?? null;
  const chat = createChatServer({
    config: {
      auth: { token: options.token ?? TOKEN },
      workspaceRoot,
      dataDir: dir,
    } as GruCommandConfig,
    frameLog,
    pointer,
    ...(options.siblingUpgradePaths !== undefined ? { siblingUpgradePaths: options.siblingUpgradePaths } : {}),
    spawnGru: (resumeFile) => {
      spawnCalls.push(resumeFile);
      if (spawnFailure !== null) {
        const error = spawnFailure;
        spawnFailure = null;
        return Promise.reject(error);
      }
      if (resumeFile !== null && options.returnMismatchedOnResume === true) {
        const mismatched = new StubGruHandle(
          join(sessionsDir, 'mismatched-resume.jsonl'),
          'mismatched-resume',
        );
        freshHandles.push(mismatched);
        return Promise.resolve(mismatched);
      }
      if (resumeFile !== null && handle.disposed && options.replaceDisposedOnResume === true) {
        const resumed = new StubGruHandle(resumeFile, `stub-resumed-${resumedHandles.length + 1}`);
        resumedHandles.push(resumed);
        return Promise.resolve(resumed);
      }
      return wrapped.spawn('gru');
    },
    spawnFreshGru: async () => {
      if (options.freshSpawnHold !== undefined) await options.freshSpawnHold;
      if (options.reuseActiveOnFresh === true) return handle;
      if (options.reuseActiveAliasOnFresh === true) {
        const alias = join(sessionsDir, 'active-session-alias.jsonl');
        symlinkSync(handle.sessionFile!, alias);
        const fresh = new StubGruHandle(alias, 'stub-aliased-active');
        freshHandles.push(fresh);
        return fresh;
      }
      if (options.reuseActiveHardLinkOnFresh === true) {
        const alias = join(sessionsDir, 'active-session-hard-link.jsonl');
        linkSync(handle.sessionFile!, alias);
        const fresh = new StubGruHandle(alias, 'stub-hard-linked-active');
        freshHandles.push(fresh);
        return fresh;
      }
      if (freshSpawnFailure !== null) {
        const error = freshSpawnFailure;
        freshSpawnFailure = null;
        throw error;
      }
      const file = join(sessionsDir, `fresh-${freshHandles.length + 1}.jsonl`);
      writeFileSync(file, '');
      const fresh = new StubGruHandle(
        file,
        options.reuseActiveIdOnFresh === true
          ? handle.id
          : `stub-fresh-${freshHandles.length + 1}`,
      );
      fresh.disposeHold = options.freshDisposeHold ?? null;
      freshHandles.push(fresh);
      return fresh;
    },
    ...(options.canAdoptFreshGru !== undefined
      ? { canAdoptFreshGru: options.canAdoptFreshGru }
      : {}),
    ...(options.adoptFreshGru !== undefined
      ? { adoptFreshGru: options.adoptFreshGru }
      : {}),
    authDeadlineMs: options.authDeadlineMs,
    heartbeatMs: options.heartbeatMs ?? 0, // off by default; the heartbeat test opts in
    controlTimeoutMs: options.controlTimeoutMs,
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
    workspaceRoot,
    uploadsDir,
    chatDir,
    frameLog,
    chat,
    http,
    port,
    handle,
    spawnCalls,
    freshHandles,
    resumedHandles,
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
  private epoch = 0;
  /** Older client fixtures ignore the additive ephemeral context frame. */
  private contextControls = false;

  constructor(port: number, path: string = '/ws') {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    this.closed = new Promise((resolveClose) => {
      this.socket.on('close', (code: number) => resolveClose(code));
      // A failed handshake (e.g. refused upgrade) errors instead of
      // closing — resolve -1 so tests can await either death shape.
      this.socket.on('error', () => resolveClose(-1));
    });
    this.socket.on('message', (data: unknown) => {
      const raw = String(data);
      const parsed = web.parseServerFrame(raw) ?? { type: '__malformed__' as const, raw };
      if (parsed.type === 'context') this.epoch = parsed.epoch;
      if (parsed.type === 'context' && !this.contextControls) return;
      this.frames.push(parsed);
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

  auth(token: string, lastSeenSeq?: number, contextControls = false): void {
    this.contextControls = contextControls;
    this.sendRaw({
      type: 'auth',
      token,
      ...(lastSeenSeq !== undefined ? { last_seen_seq: lastSeenSeq } : {}),
    });
  }

  control(action: 'compact' | 'new_chat', requestId: string): void {
    this.sendRaw({ type: 'control', action, request_id: requestId });
  }

  send(text: string, clientMsgId: string): void {
    this.sendRaw({ type: 'user', text, client_msg_id: clientMsgId, epoch: this.epoch });
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

/** A masked client→server WebSocket text frame (client frames MUST be
 * masked; payloads here are small, <126 bytes). */
function maskedTextFrame(payload: string): Buffer {
  const mask = randomBytes(4);
  const data = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(2);
  header[0] = 0x81; // FIN + text opcode
  header[1] = 0x80 | data.length; // MASK + length
  const masked = Buffer.from(data);
  for (let index = 0; index < data.length; index++) {
    masked[index] = data[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, mask, masked]);
}

/** A raw-socket WS client that NEVER answers pings — the heartbeat
 * terminate path exercised with a genuinely pong-blind peer. */
class PongBlindClient {
  readonly closed: Promise<void>;
  private readonly socket: Socket;
  private handshaked = false;

  constructor(port: number) {
    this.socket = netConnect(port, '127.0.0.1');
    this.closed = new Promise((resolveClose) => {
      this.socket.once('close', () => resolveClose());
    });
    this.socket.on('error', () => {
      /* terminate surfaces as close */
    });
    this.socket.on('data', (chunk: Buffer) => {
      if (!this.handshaked && chunk.toString('utf-8').includes(' 101 ')) {
        this.handshaked = true;
      }
      // After the handshake EVERYTHING is ignored — pings go unanswered.
    });
    const key = randomBytes(16).toString('base64');
    this.socket.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  }

  /** Auth + one user message, back-to-back (the reader's broadcast is the
   * observable confirmation — this client parses nothing). */
  authAndSend(token: string, text: string, clientMsgId: string): void {
    this.socket.write(maskedTextFrame(JSON.stringify({ type: 'auth', token })));
    this.socket.write(
      maskedTextFrame(JSON.stringify({ type: 'user', text, client_msg_id: clientMsgId, epoch: 0 })),
    );
  }
}

async function authedClient(
  port: number,
  token: string = TOKEN,
  lastSeenSeq?: number,
  contextControls = false,
): Promise<TestClient> {
  const client = new TestClient(port);
  await client.open();
  client.auth(token, lastSeenSeq, contextControls);
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
    // r2 W2': the writer does NOT receive its own user frame live (the
    // client renders it locally; history restores it on replay).
    const kinds = client.frames.map((frame) => frame.type);
    expect(kinds).toEqual(['auth_ok', 'ack', 'turn', 'delta', 'delta', 'turn']);
    expect(client.frames[1]).toMatchObject({ type: 'ack', client_msg_id: 'm1', seq: 2 });
    expect(client.frames[2]).toMatchObject({ type: 'turn', state: 'start', seq: 3 });
    expect(client.frames[3]).toMatchObject({ type: 'delta', text: 'Hello', seq: 4 });
    expect(client.frames[4]).toMatchObject({ type: 'delta', text: ' boss', seq: 5 });
    expect(client.frames[5]).toMatchObject({ type: 'turn', state: 'end', seq: 6 });
    // Every frame parsed web-valid (no __malformed__) and the seqs are 1..N.
    expect(kinds).not.toContain('__malformed__');
    expect(harness.frameLog.highWaterSeq).toBe(6);
    // The user frame IS in the durable log (seq 1) for replay.
    expect(harness.frameLog.history[0]).toMatchObject({
      type: 'user',
      text: 'hello gru',
      client_msg_id: 'm1',
      seq: 1,
    });
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
    expect(kinds).toEqual(['auth_ok', 'ack', 'turn', 'tool', 'delta', 'delta', 'tool', 'turn']);
    expect(client.frames[3]).toMatchObject({ type: 'tool', name: 'read', state: 'start' });
    expect(client.frames[6]).toMatchObject({ type: 'tool', name: 'read', state: 'end' });
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
    await fresh.waitForCount(1 + harness.frameLog.highWaterSeq); // auth_ok + the whole log
    const replayed = fresh.frames.slice(1);
    expect(replayed).toEqual([...harness.frameLog.history] as web.ServerFrame[]);
    // Both sides of the conversation restored, in seq order.
    expect(replayed.filter((frame) => frame.type === 'user')).toHaveLength(2);
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
    done = nextTurnEnd(first);
    first.send('two', 'm2');
    await done;

    const highWater = harness.frameLog.highWaterSeq;
    const reconnected = await authedClient(harness.port, TOKEN, 1);
    await reconnected.waitForCount(1 + (highWater - 1));
    expect(reconnected.frames[0]).toEqual({ type: 'auth_ok', seq: highWater });
    // Exactly the log frames with seq > 1, in order.
    const replayed = reconnected.frames.slice(1);
    expect(replayed).toEqual([...harness.frameLog.replayAfter(1)] as web.ServerFrame[]);
    expect(replayed[0]).toMatchObject({ seq: 2 });
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
    await client.waitForCount(11, 10_000); // auth_ok + two exchanges (ack+turn+delta+delta+turn each)
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
    const reAck = await client.waitFor(
      (frame) => frame.type === 'ack' &&
        (frame as web.AckFrame).client_msg_id === 'dup-1' &&
        (frame as web.AckFrame).seq === before + 1,
      're-ack',
    );
    expect(reAck).toBeDefined();
    expect(harness.handle.calls).toHaveLength(1);
    expect(
      harness.frameLog.history.filter((frame) => frame.type === 'user'),
    ).toHaveLength(1);
    await client.close();
    await harness.close();
  });

  it('a fatal runtime error mid-turn is logged WITHOUT the fatal flag (replay-safe) and settles the turn', async () => {
    const harness = await makeHarness();
    harness.handle.toolName = 'bash';
    harness.handle.nextFatal = 'the runtime exploded';
    const client = await authedClient(harness.port);
    const done = nextTurnEnd(client);
    client.send('doomed prompt', 'm1');
    await done;
    const kinds = client.frames.map((frame) => frame.type);
    expect(kinds).toEqual(['auth_ok', 'ack', 'turn', 'tool', 'delta', 'delta', 'error', 'tool', 'turn']);
    // r1 B2: the shipped client closes on ANY fatal:true frame — live or
    // replayed. Logged runtime deaths carry seq but NEVER the flag.
    const loggedFatal = client.frames[6] as web.ErrorFrame;
    expect(loggedFatal.type).toBe('error');
    expect(loggedFatal.message).toBe('the runtime exploded');
    expect(loggedFatal.seq).toBe(7);
    expect(loggedFatal.fatal).toBeUndefined();
    expect(client.frames[7]).toMatchObject({ type: 'tool', name: 'bash', state: 'end' });
    expect(client.frames[8]).toMatchObject({ type: 'turn', state: 'end' });
    // History is settled; the session recovers for the next prompt.
    expect(harness.frameLog.hasOpenTurn).toBe(false);

    // A FRESH page load (full replay) must never hit a poison fatal frame.
    const fresh = await authedClient(harness.port);
    await fresh.waitForCount(1 + harness.frameLog.highWaterSeq);
    const poison = fresh.frames.filter(
      (frame) => (frame as web.ErrorFrame).type === 'error' && (frame as web.ErrorFrame).fatal === true,
    );
    expect(poison).toEqual([]);

    harness.handle.toolName = null;
    client.send('recovery prompt', 'm2');
    await pollUntil(() => harness.handle.calls.length === 2, 'recovery delivered');
    await client.waitForCount(14); // + ack, turn, delta, delta, turn
    expect(harness.handle.calls[1]).toEqual({ op: 'prompt', text: 'recovery prompt', owner: 'chat' });
    await client.close();
    await fresh.close();
    await harness.close();
  });

  it('a prompt rejection logs a delivery failure without settling a turn that never opened', async () => {
    const harness = await makeHarness();
    harness.handle.nextPromptError = 'model exploded';
    const client = await authedClient(harness.port);
    client.send('doomed', 'm1');
    // The failure is logged (conversation-relevant) and non-fatal.
    await client.waitFor(
      (frame) => frame.type === 'error' &&
        (frame as web.ErrorFrame).message.includes('message delivery failed: model exploded'),
      'delivery failure',
    );
    expect(client.frames.some((frame) => frame.type === 'turn')).toBe(false);
    expect(client.frames.filter((frame) => frame.type === 'error')).toHaveLength(1);
    // The log holds exactly user + ack + error — no turn boundary noise.
    expect(harness.frameLog.history.map((frame) => frame.type)).toEqual(['user', 'ack', 'error']);
    expect((client.frames.at(-1) as web.ErrorFrame).fatal).toBeUndefined();

    // Recovery: the next message delivers normally on the same session.
    const done2 = nextTurnEnd(client);
    client.send('after the failure', 'm2');
    await done2;
    expect(harness.handle.calls).toEqual([
      { op: 'prompt', text: 'doomed', owner: 'chat' },
      { op: 'prompt', text: 'after the failure', owner: 'chat' },
    ]);
    await client.close();
    await harness.close();
  });

  it('a failed frame-log append during delivery is caught, reported, and never fatal (r3 blocker)', async () => {
    const harness = await makeHarness();
    try {
      const client = await authedClient(harness.port);
      const done1 = nextTurnEnd(client);
      client.send('baseline before disk failure', 'm1');
      await done1;

      // Fail the next two non-transport appends (user/ack already landed):
      // the turn-start frame (mid-prompt) and the inner delivery-error
      // frame that follows. Before the r3 fix the second throw escaped the
      // void-ed deliver() task as an unhandled rejection — which the
      // service treats as fatal (process.exit).
      const originalAppend = harness.frameLog.append.bind(harness.frameLog);
      let remainingFailures = 2;
      (harness.frameLog as unknown as { append: typeof originalAppend }).append = (
        frame: Parameters<typeof originalAppend>[0],
      ) => {
        if (remainingFailures > 0 && frame.type !== 'user' && frame.type !== 'ack') {
          remainingFailures -= 1;
          throw new Error('simulated ENOSPC: disk full');
        }
        return originalAppend(frame);
      };

      client.send('hit the broken log', 'm2');
      const bounded = await client.waitFor(
        (frame) => frame.type === 'error' &&
          (frame as web.ErrorFrame).message.includes(
            'message delivery failed; the conversation stays usable',
          ),
        'bounded durable delivery failure',
      );
      // The backstop frame is durable (replayable), never fatal.
      expect(typeof (bounded as web.ErrorFrame).seq).toBe('number');
      expect((bounded as web.ErrorFrame).fatal).toBeUndefined();

      // The service is alive and the delivery gate recovered.
      const done3 = nextTurnEnd(client);
      client.send('still alive after ENOSPC', 'm3');
      await done3;
      await client.close();
    } finally {
      await harness.close();
    }
  });

  it('a persistently broken frame log degrades to an ephemeral error without killing the service', async () => {
    const harness = await makeHarness();
    try {
      const client = await authedClient(harness.port);
      const done1 = nextTurnEnd(client);
      client.send('baseline before persistent failure', 'm1');
      await done1;

      // Every turn/error append fails while user/ack appends still pass —
      // so the message is accepted, the delivery chain hits the failure,
      // and the outer backstop must fall back to the ephemeral channel.
      const originalAppend = harness.frameLog.append.bind(harness.frameLog);
      let sabotage = true;
      (harness.frameLog as unknown as { append: typeof originalAppend }).append = (
        frame: Parameters<typeof originalAppend>[0],
      ) => {
        if (sabotage && (frame.type === 'turn' || frame.type === 'error')) {
          throw new Error('simulated EACCES: log unwritable');
        }
        return originalAppend(frame);
      };

      client.send('hit the unwritable log', 'm2');
      const ephemeral = await client.waitFor(
        (frame) => frame.type === 'error' &&
          (frame as web.ErrorFrame).message.includes(
            'message delivery failed; the conversation stays usable',
          ),
        'ephemeral delivery failure',
      );
      expect((ephemeral as web.ErrorFrame).seq).toBeUndefined();
      expect((ephemeral as web.ErrorFrame).fatal).toBeUndefined();

      // Recovery: repair the log and the same session keeps working.
      sabotage = false;
      const done3 = nextTurnEnd(client);
      client.send('recovered after repair', 'm3');
      await done3;
      await client.close();
    } finally {
      await harness.close();
    }
  });

  it('a steer rejection mid-live-turn logs the failure but never force-settles the running turn', async () => {
    const harness = await makeHarness();
    let releaseTurn!: () => void;
    harness.handle.nextHold = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    harness.handle.nextSteerError = 'steer rejected';
    const client = await authedClient(harness.port);
    client.send('start a long turn', 'm1');
    await client.waitFor(
      (frame) => frame.type === 'turn' && (frame as web.TurnFrame).state === 'start',
      'turn start',
    );
    client.send('adjust course', 'm2');
    await client.waitFor(
      (frame) => frame.type === 'error' &&
        (frame as web.ErrorFrame).message.includes('message delivery failed: steer rejected'),
      'steer failure logged',
    );
    // The runtime turn is STILL live — no settle frames may appear.
    expect(
      client.frames.some((frame) => frame.type === 'turn' && (frame as web.TurnFrame).state === 'end'),
    ).toBe(false);
    expect(
      harness.frameLog.history.some((frame) => frame.type === 'tool' && frame.state === 'end'),
    ).toBe(false);

    const done = nextTurnEnd(client);
    releaseTurn();
    await done;
    // History reads: user, ack, turn start, delta, delta, then the m2
    // exchange (user, ack), the steer failure, and the real turn end —
    // nothing settled early, no deltas after a closed turn.
    const logKinds = harness.frameLog.history.map((frame) => frame.type);
    expect(logKinds).toEqual(['user', 'ack', 'turn', 'delta', 'delta', 'user', 'ack', 'error', 'turn']);
    expect(harness.frameLog.history.at(-1)).toMatchObject({ type: 'turn', state: 'end' });
    await client.close();
    await harness.close();
  });

  it('a non-fatal runtime error mid-turn is logged and the turn completes', async () => {
    const harness = await makeHarness();
    harness.handle.nextSoftError = 'soft failure';
    const client = await authedClient(harness.port);
    const done = nextTurnEnd(client);
    client.send('tell me things', 'm1');
    await done;
    const kinds = client.frames.map((frame) => frame.type);
    expect(kinds).toEqual(['auth_ok', 'ack', 'turn', 'delta', 'delta', 'error', 'turn']);
    const soft = client.frames[5] as web.ErrorFrame;
    expect(soft.message).toBe('soft failure');
    expect(soft.fatal).toBeUndefined();
    expect(soft.seq).toBe(6);
    await client.close();
    await harness.close();
  });

  it('a duplicate turn_end event is swallowed by the open-turn guard (no dangling boundary)', async () => {
    const harness = await makeHarness();
    const client = await authedClient(harness.port);
    const done = nextTurnEnd(client);
    client.send('warm up', 'm1');
    await done;
    const before = harness.frameLog.highWaterSeq;

    // Adapter misbehavior: turn ends, then a stray turn_end arrives.
    harness.handle.fire({ type: 'turn_start' });
    harness.handle.fire({ type: 'turn_end' });
    harness.handle.fire({ type: 'turn_end' }); // duplicate — must be skipped
    await pollUntil(
      () => harness.frameLog.history.filter((frame) => frame.type === 'turn').length === 4,
      'fired turn frames logged',
    );
    expect(harness.frameLog.highWaterSeq).toBe(before + 2); // start + end only
    expect(harness.frameLog.history.at(-1)).toMatchObject({ type: 'turn', state: 'end' });
    await client.close();
    await harness.close();
  });

  it('spawn failure closes the unacked stream; reconnect retries and succeeds', async () => {
    const harness = await makeHarness({ failFirstSpawn: new Error('model unavailable') });
    const client = await authedClient(harness.port);
    client.send('wake the brain', 'm1');
    const notice = await client.waitFor(isType('error'), 'spawn failure');
    expect(notice).toEqual({
      type: 'error',
      message: 'Chat delivery could not be reconciled; reconnecting safely.',
    });
    expect(notice).not.toHaveProperty('seq');
    expect(await client.closed).toBe(1011);
    expect(harness.handle.calls).toEqual([]);

    const retry = await authedClient(harness.port);
    const done = nextTurnEnd(retry);
    retry.send('wake the brain', 'm1');
    await done;
    expect(harness.handle.calls).toEqual([{ op: 'prompt', text: 'wake the brain', owner: 'chat' }]);
    expect(harness.spawnCalls).toEqual([null, null]); // fresh brain both times
    await retry.close();
    await harness.close();
  });

  it('dispose closes clients with 1001 and refuses later upgrades (no zombies)', async () => {
    const harness = await makeHarness();
    const client = await authedClient(harness.port);
    const gone = client.closed;
    await harness.chat.dispose(); // detach the upgrade handler + close clients
    // The going-away code lets the UI queue before the runtime turns die.
    await expect(gone).resolves.toBe(1001);

    const zombie = new TestClient(harness.port);
    // With no 'upgrade' listener the HTTP server closes the connection:
    // the client dies without ever reaching auth (no frames, no hang).
    const code = await Promise.race([
      zombie.closed,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('zombie connection lingered')), 3_000),
      ),
    ]);
    expect(typeof code).toBe('number');
    expect(zombie.frames).toEqual([]);
    await new Promise<void>((resolveClose) => {
      harness.http.closeAllConnections();
      harness.http.close(() => resolveClose());
    });
  });

  it('E6: declared sibling upgrade paths pass through (unclaimed paths still die)', async () => {
    const harness = await makeHarness({ siblingUpgradePaths: ['/board/ws'] } as never);
    // A sibling wss claims the passed-through path on the same server.
    const { WebSocketServer: WSS } = await import('ws');
    const boardWss = new WSS({ noServer: true });
    const boardConnected = new Promise<void>((resolveConnect) => {
      boardWss.on('connection', () => resolveConnect());
    });
    harness.http.on('upgrade', (request, socket, head) => {
      if (new URL(request.url ?? '/', 'http://localhost').pathname === '/board/ws') {
        boardWss.handleUpgrade(request, socket, head, (ws) => boardWss.emit('connection', ws, request));
      }
    });
    const board = new TestClient(harness.port, '/board/ws');
    await board.open();
    await boardConnected; // passed through, not destroyed
    // Unclaimed non-sibling paths still die (standalone semantics kept).
    const stray = new TestClient(harness.port, '/nope');
    const code = await Promise.race([
      stray.closed,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('stray lingered')), 3_000)),
    ]);
    expect(typeof code).toBe('number');
    await board.close();
    boardWss.close();
    await harness.close();
  });

  it('upgrade requests to a non-/ws path are destroyed without any frames', async () => {
    const harness = await makeHarness();
    const stray = new TestClient(harness.port, '/nope');
    const code = await Promise.race([
      stray.closed,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('stray connection lingered')), 3_000),
      ),
    ]);
    expect(typeof code).toBe('number');
    expect(stray.frames).toEqual([]);
    expect(harness.frameLog.highWaterSeq).toBe(0);
    await harness.close();
  });

  it('pre-auth malformed frames are ephemeral: client-visible, never written to the durable log', async () => {
    const harness = await makeHarness();
    const client = new TestClient(harness.port);
    await client.open();
    client.sendRaw('garbage before auth');
    const notice = await client.waitFor(isType('error'), 'ephemeral notice');
    expect(notice).toEqual({ type: 'error', message: 'malformed frame' });
    expect(notice).not.toHaveProperty('seq');
    // The connection survives and can still authenticate.
    client.auth(TOKEN);
    await client.waitFor(isType('auth_ok'), 'auth_ok');
    // Nothing was logged by the unauthenticated socket.
    expect(harness.frameLog.highWaterSeq).toBe(0);
    await client.close();
    await harness.close();
  });

  it('a corrupt resume pointer surfaces as a spawn failure and never wedges the spawn gate', async () => {
    const harness = await makeHarness();
    const client = await authedClient(harness.port);
    const done = nextTurnEnd(client);
    client.send('first', 'm1');
    await done;
    expect(harness.spawnCalls).toEqual([null]);

    // The session dies (crash) AND the pointer is corrupt: the next spawn
    // must fail per-send (naming the pointer), not wedge the gate forever.
    harness.handle.fire({ type: 'state', state: 'disposed' });
    writeFileSync(join(harness.chatDir, SESSION_STATE_NAME), '{"sessionFile":', 'utf-8');
    client.send('second', 'm2');
    const failure = await client.waitFor(isType('error'), 'spawn failure surfaced');
    expect((failure as web.ErrorFrame).message).toContain('could not be reconciled');
    expect(await client.closed).toBe(1011);

    // Repair (remove the corrupt pointer): the gate must be free — a
    // reconnect can retry the same unacked word without restarting service.
    rmSync(join(harness.chatDir, SESSION_STATE_NAME));
    const retry = await authedClient(harness.port);
    const done3 = nextTurnEnd(retry);
    retry.send('third', 'm3');
    await done3;
    expect(harness.handle.calls.map((call) => call.text)).toEqual(['first', 'third']);
    expect(harness.spawnCalls).toEqual([null, null]); // fresh brain after repair
    await retry.close();
    await harness.close();
  });

  it('heartbeat: a pong-suppressed writer is terminated and the pen promotes to the ponging reader', async () => {
    const harness = await makeHarness({ heartbeatMs: 40 });
    // A raw WS client that NEVER answers pings — and holds the pen first.
    const blind = new PongBlindClient(harness.port);
    blind.authAndSend(TOKEN, 'hello from the blind writer', 'blind-m1');
    const reader = await authedClient(harness.port);
    await reader.waitFor(
      (frame) => frame.type === 'user' && (frame as web.ReplayedUserFrame).client_msg_id === 'blind-m1',
      'reader saw the blind writer traffic',
    );
    reader.send('trying while blind holds pen', 'r1');
    await reader.waitFor(isType('error'), 'read-only while blind lives');

    // The blind writer misses pongs → terminated → the reader is promoted.
    await blind.closed;
    let promoted = false;
    for (let attempt = 0; attempt < 25 && !promoted; attempt++) {
      reader.send('promoted after heartbeat', 'r2');
      try {
        await reader.waitFor(
          (frame) => frame.type === 'ack' && (frame as web.AckFrame).client_msg_id === 'r2',
          'promoted ack',
          200,
        );
        promoted = true;
      } catch {
        /* not promoted yet */
      }
    }
    expect(promoted).toBe(true);
    const done = nextTurnEnd(reader);
    reader.send('now streaming', 'r3');
    await done;
    // The ponging reader survived every heartbeat interval throughout.
    expect(reader.frames.filter((frame) => frame.type === 'delta').length).toBeGreaterThanOrEqual(4);
    await reader.close();
    await harness.close();
  });

  it('oversized frames (past the 64 KiB cap) are refused with close 1009', async () => {
    const harness = await makeHarness();
    const client = new TestClient(harness.port);
    await client.open();
    client.sendRaw('x'.repeat(70 * 1024));
    const code = await Promise.race([
      client.closed,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('oversize frame not refused')), 3_000),
      ),
    ]);
    expect(code).toBe(1009);
    expect(client.frames).toEqual([]);
    expect(harness.frameLog.highWaterSeq).toBe(0);
    await new Promise<void>((resolveClose) => {
      harness.http.closeAllConnections();
      harness.http.close(() => resolveClose());
    });
  });

  it('runtime-supplied empty strings are clamped before persisting (reload never bricks)', async () => {
    const harness = await makeHarness();
    const client = await authedClient(harness.port);
    const done = nextTurnEnd(client);
    client.send('degenerate adapter', 'm1');
    await done;

    // r2 B2'': an adapter emitting '' must not write a frame load()
    // rejects — clamp first, brick never.
    harness.handle.fire({ type: 'error', error: '', fatal: false });
    harness.handle.fire({ type: 'tool_start', callId: 'empty', tool: '' });
    harness.handle.fire({ type: 'tool_end', callId: 'empty', isError: false });
    await pollUntil(
      () => harness.frameLog.history.some((frame) => frame.type === 'tool' && frame.name === 'unknown'),
      'clamped tool frames',
    );
    const clampedError = harness.frameLog.history.find(
      (frame) => frame.type === 'error' && frame.message === 'unknown runtime error',
    );
    expect(clampedError).toBeDefined();
    // The persisted log reloads clean — the durability invariant holds.
    const reloaded = ChatFrameLog.load(harness.chatDir);
    expect(reloaded.highWaterSeq).toBe(harness.frameLog.highWaterSeq);
    await client.close();
    await harness.close();
  });

  it('a disposal mid-turn settles the open turn immediately (no dangling boundary)', async () => {
    const harness = await makeHarness();
    let releaseTurn!: () => void;
    harness.handle.nextHold = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    const client = await authedClient(harness.port, TOKEN, undefined, true);
    client.send('turn that outlives the session', 'm1');
    await client.waitFor(
      (frame) => frame.type === 'turn' && (frame as web.TurnFrame).state === 'start',
      'turn start',
    );
    expect(harness.frameLog.hasOpenTurn).toBe(true);

    harness.handle.throwOnUnsubscribe = true;
    harness.handle.fire({ type: 'state', state: 'disposed' });
    await pollUntil(() => !harness.frameLog.hasOpenTurn, 'settled on disposal');
    expect(harness.frameLog.history.at(-1)).toMatchObject({ type: 'turn', state: 'end' });
    expect(
      client.frames.some(
        (frame) => frame.type === 'context' && frame.session_active === false,
      ),
    ).toBe(true);
    releaseTurn(); // the leaked stub turn ends into no listeners
    await client.close();
    await harness.close();
  });

  it('rejects and disposes a resume spawn that returns a different session file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-e4-resume-mismatch-'));
    cleanupDirs.push(dir);
    const first = await makeHarness({ reuseDir: dir });
    let pointerBefore: ReturnType<GruSessionPointer['current']> = null;
    try {
      const client = await authedClient(first.port);
      client.send('establish resume identity', 'resume-identity-before');
      await client.waitFor(isTurnEndFrame, 'establish resume identity');
      pointerBefore = new GruSessionPointer(first.chatDir).current();
      await client.close();
    } finally {
      await first.close();
    }

    const restarted = await makeHarness({ reuseDir: dir, returnMismatchedOnResume: true });
    try {
      const client = await authedClient(restarted.port);
      client.send('must not switch brains', 'resume-identity-after');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'error' && /could not be reconciled/.test(frame.message),
          'resume identity rejection',
        ),
      ).toBeDefined();
      expect(new GruSessionPointer(restarted.chatDir).current()).toEqual(pointerBefore);
      expect(restarted.freshHandles[0]?.disposed).toBe(true);
      await client.close();
    } finally {
      await restarted.close();
    }
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

describe('chat server — supervision integration (E7)', () => {
  it('surfaceNotice logs + broadcasts a notice frame the web validator accepts', async () => {
    const harness = await makeHarness();
    const client = await authedClient(harness.port);
    const before = harness.frameLog.highWaterSeq;
    harness.chat.surfaceNotice('⚠ Action required: breaker tripped');
    await client.waitForCount(1 + harness.frameLog.highWaterSeq);
    const notice = client.frames.find((f) => f.type === 'notice');
    expect(notice).toMatchObject({ type: 'notice', text: '⚠ Action required: breaker tripped', seq: before + 1 });
    expect(harness.frameLog.history.at(-1)).toMatchObject({ type: 'notice' });
    // A reconnect replays the notice (durable frame).
    const clientB = await authedClient(harness.port);
    await clientB.waitForCount(1 + harness.frameLog.highWaterSeq);
    expect(clientB.frames.some((f) => f.type === 'notice')).toBe(true);
    await client.close();
    await clientB.close();
    await harness.close();
  });

  it('adoptRestartedGru rewires a supervisor restart: open turn settles, notice lands, prompts route to the NEW handle', async () => {
    const harness = await makeHarness();
    const client = await authedClient(harness.port);
    // Hold a turn open on the OLD handle (the hang the supervisor killed).
    let releaseTurn!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    harness.handle.nextHold = hold;
    const inFlight = nextTurnEnd(client);
    client.send('about to be restarted', 'm1');
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The supervisor produces a fresh handle over the SAME session file.
    const replacement = new StubGruHandle(harness.handle.sessionFile);
    harness.chat.adoptRestartedGru(replacement as unknown as import('../src/runtime/types.js').AgentHandle);
    releaseTurn();
    await inFlight;

    // The settle + restart notice are in the stream.
    expect(client.frames.some((f) => f.type === 'notice' && (f as { text?: string }).text?.includes('restarted'))).toBe(true);
    expect(harness.frameLog.hasOpenTurn).toBe(false);

    // New prompts reach the REPLACEMENT handle, not the old one.
    harness.handle.calls.length = 0;
    const done = nextTurnEnd(client);
    client.send('hello again', 'm2');
    await done;
    expect(replacement.calls.map((c) => c.text)).toContain('hello again');
    expect(harness.handle.calls).toEqual([]);
    await client.close();
    await harness.close();
  });
});

// ---------------------------------------------------------------------------
// SPEC ruling 19 — the ONE attach flow: chips on the wire, PATHS to the
// agent, graceful vision decline (this lane).
// ---------------------------------------------------------------------------

describe('chat server — attach flow (SPEC ruling 19)', () => {
  it('chips ride the logged user frame and the delivered prompt is a PATH manifest (no bytes)', async () => {
    const h = await makeHarness();
    try {
      const client = new TestClient(h.port);
      await client.open();
      client.auth(TOKEN);
      await client.waitFor(isType('auth_ok'), 'auth_ok');
      client.sendRaw({
        type: 'user',
        text: 'look at these',
        client_msg_id: 'attach-1',
        epoch: 0,
        attachments: [
          { path: join(h.workspaceRoot, 'repo-a', 'notes.md'), name: 'notes.md', kind: 'file' },
          { path: join(h.workspaceRoot, 'repo-a', 'shot.png'), name: 'shot.png', kind: 'image' },
        ],
      });
      await client.waitFor((f) => f.type === 'ack', 'ack');
      // Delivery landed on the Gru handle as a manifest prompt.
      await pollUntil(() => h.handle.calls.length === 1, 'prompt delivered');
      const prompt = h.handle.calls[0]!.text;
      expect(prompt).toContain('look at these');
      expect(prompt).toContain('[attached files — read them yourself at these paths]');
      expect(prompt).toContain(`- ${join(h.workspaceRoot, 'repo-a', 'notes.md')}`);
      expect(prompt).toContain(`- ${join(h.workspaceRoot, 'repo-a', 'shot.png')} (image)`);
      // NO bytes anywhere: the manifest is paths only (ruling 19(c)).
      expect(prompt).not.toContain('base64');
      // The logged user frame carries the chips (replay renders them).
      const logged = h.frameLog.history.find((f) => f.type === 'user');
      expect(logged).toMatchObject({
        type: 'user',
        attachments: [
          { path: join(h.workspaceRoot, 'repo-a', 'notes.md'), kind: 'file' },
          { path: join(h.workspaceRoot, 'repo-a', 'shot.png'), kind: 'image' },
        ],
      });
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('vision gate: an image chip on an images-incapable runtime DECLINES gracefully — notice + never-guess line, never an error, never a drop', async () => {
    const h = await makeHarness();
    h.handle.capabilities = { ...h.handle.capabilities, images: false };
    try {
      const client = new TestClient(h.port);
      await client.open();
      client.auth(TOKEN);
      await client.waitFor(isType('auth_ok'), 'auth_ok');
      const uploadedImage = join(h.uploadsDir, '1-shot.png');
      writeFileSync(uploadedImage, 'real provenance fixture', 'utf-8');
      client.sendRaw({
        type: 'user',
        text: 'what is in this picture',
        client_msg_id: 'attach-decline-1',
        epoch: 0,
        attachments: [{ path: uploadedImage, name: 'shot.png', kind: 'image' }],
      });
      // The decline is VISIBLE: a logged notice frame (not an error frame).
      const notice = await client.waitFor(
        (f) => f.type === 'notice' && String((f as { text?: string }).text).includes('Vision is unavailable'),
        'vision decline notice',
      );
      expect((notice as { seq: number }).seq).toBeGreaterThan(0);
      await client.waitFor(isType('ack'), 'ack');
      // The path STILL delivered (never a silent drop)…
      await pollUntil(() => h.handle.calls.length === 1, 'prompt delivered despite gate');
      const prompt = h.handle.calls[0]!.text;
      expect(prompt).toContain(uploadedImage);
      // …with the never-guess instruction for the blind model.
      expect(prompt).toContain('do NOT guess');
      // And NO error frame was logged for the gated attach.
      expect(h.frameLog.history.some((f) => f.type === 'error')).toBe(false);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('an attachment-only message (empty text, chips) is legal end-to-end', async () => {
    const h = await makeHarness();
    try {
      const client = new TestClient(h.port);
      await client.open();
      client.auth(TOKEN);
      await client.waitFor(isType('auth_ok'), 'auth_ok');
      client.sendRaw({
        type: 'user',
        text: '',
        client_msg_id: 'attach-only-1',
        epoch: 0,
        attachments: [{ path: join(h.workspaceRoot, 'repo-a', 'notes.md'), name: 'notes.md', kind: 'file' }],
      });
      await client.waitFor(isType('ack'), 'ack for attachment-only');
      await pollUntil(() => h.handle.calls.length === 1, 'prompt delivered');
      expect(h.handle.calls[0]!.text).toContain(join(h.workspaceRoot, 'repo-a', 'notes.md'));
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('re-sent frames (dedup) re-ack without re-delivering chips', async () => {
    const h = await makeHarness();
    try {
      const client = new TestClient(h.port);
      await client.open();
      client.auth(TOKEN);
      await client.waitFor(isType('auth_ok'), 'auth_ok');
      const dedupFile = join(h.workspaceRoot, 'one.txt');
      writeFileSync(dedupFile, 'exists so the provenance leg is non-vacuous', 'utf-8');
      const frame = {
        type: 'user' as const,
        text: 'once only',
        client_msg_id: 'attach-dedupe-1',
        epoch: 0,
        attachments: [
          { path: dedupFile, name: 'one.txt', kind: 'file' as const },
        ],
      };
      client.sendRaw(frame);
      await client.waitFor(isType('ack'), 'first ack');
      await pollUntil(() => h.handle.calls.length === 1, 'delivered');
      client.sendRaw(frame);
      await client.waitFor(
        () => client.frames.filter(isType('ack')).length >= 2,
        'second ack (dedup re-ack)',
      );
      expect(h.handle.calls.length).toBe(1);
      expect(h.handle.calls[0]!.text).toContain(dedupFile);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('provenance: chips outside the workspace and uploads drop GRACEFULLY — notice, no manifest entry, no error frame', async () => {
    const h = await makeHarness();
    try {
      const client = new TestClient(h.port);
      await client.open();
      client.auth(TOKEN);
      await client.waitFor(isType('auth_ok'), 'auth_ok');
      const outside = join(h.dir, 'outside-secret.txt'); // real file, OUTSIDE both homes
      writeFileSync(outside, 'shh', 'utf-8');
      client.sendRaw({
        type: 'user',
        text: 'read this too',
        client_msg_id: 'attach-prov-1',
        epoch: 0,
        attachments: [
          { path: join(h.workspaceRoot, 'repo-a', 'notes.md'), name: 'notes.md', kind: 'file' },
          { path: outside, name: 'outside-secret.txt', kind: 'file' },
        ],
      });
      const notice = await client.waitFor(
        (f) =>
          f.type === 'notice' && String((f as { text?: string }).text).includes('Attachment path not allowed'),
        'provenance notice',
      );
      expect((notice as { text?: string }).text).toContain('outside-secret.txt');
      await pollUntil(() => h.handle.calls.length === 1, 'prompt delivered');
      const prompt = h.handle.calls[0]!.text;
      // The allowed chip delivered; the rejected one never reached the agent.
      expect(prompt).toContain(join(h.workspaceRoot, 'repo-a', 'notes.md'));
      expect(prompt).not.toContain('outside-secret.txt');
      expect(h.frameLog.history.some((f) => f.type === 'error')).toBe(false);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('all rejected chips plus empty text are acked and noticed but NEVER delivered as an empty prompt', async () => {
    const h = await makeHarness();
    try {
      const client = new TestClient(h.port);
      await client.open();
      client.auth(TOKEN);
      await client.waitFor(isType('auth_ok'), 'auth_ok');
      const outside = join(h.dir, 'outside-only.png');
      writeFileSync(outside, 'x', 'utf-8');
      client.sendRaw({
        type: 'user',
        text: '',
        client_msg_id: 'attach-empty-after-filter',
        epoch: 0,
        attachments: [{ path: outside, name: 'outside-only.png', kind: 'image' }],
      });
      await client.waitFor(isType('ack'), 'ack');
      await client.waitFor(
        (f) => f.type === 'notice' && String((f as { text?: string }).text).includes('No deliverable content'),
        'empty delivery skipped notice',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.handle.calls).toHaveLength(0);
      expect(h.frameLog.history.some((f) => f.type === 'error')).toBe(false);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('malformed chips (bad kind / too many) are rejected as malformed frames, never delivered', async () => {
    const h = await makeHarness();
    try {
      const client = new TestClient(h.port);
      await client.open();
      client.auth(TOKEN);
      await client.waitFor(isType('auth_ok'), 'auth_ok');
      client.sendRaw({
        type: 'user',
        text: 'bad kind',
        client_msg_id: 'attach-bad-1',
        epoch: 0,
        attachments: [{ path: '/x', name: 'x', kind: 'video' }],
      });
      const err = await client.waitFor(isType('error'), 'malformed error');
      expect((err as { message?: string }).message).toContain('malformed frame');
      const errorsBeforeNineChipFrame = client.frames.filter(isType('error')).length;
      client.sendRaw({
        type: 'user',
        text: 'too many',
        client_msg_id: 'attach-bad-2',
        epoch: 0,
        attachments: Array.from({ length: 9 }, (_, i) => ({
          path: join(h.workspaceRoot, `f${i}`),
          name: `f${i}`,
          kind: 'file' as const,
        })),
      });
      // Count must advance: a generic predicate would consume the earlier
      // bad-kind error and leave this nine-chip leg vacuously green.
      await client.waitFor(
        () => client.frames.filter(isType('error')).length === errorsBeforeNineChipFrame + 1,
        'distinct nine-chip malformed error',
      );
      expect(h.handle.calls.length).toBe(0);
      await client.close();
    } finally {
      await h.close();
    }
  });
});

describe('chat context controls and durable new-chat boundaries', () => {
  it('sends fresh writer-aware context snapshots and compact is native, serialized, and non-durable', async () => {
    const h = await makeHarness();
    try {
      const writer = await authedClient(h.port, TOKEN, undefined, true);
      writer.send('establish session', 'establish-control-session');
      await writer.waitFor(isTurnEndFrame, 'establish turn');
      const writerContext = await writer.waitFor(
        (frame) =>
          frame.type === 'context' && frame.compact_supported && frame.state === 'idle',
        'writer context after session spawn',
      );
      expect(writerContext).toMatchObject({
        type: 'context',
        epoch: 0,
        state: 'idle',
        writer: true,
        compact_supported: true,
        usage: { tokens: 20, context_window: 100, percent: 20 },
      });
      const historyBeforeCompact = [...h.frameLog.history];
      const reader = await authedClient(h.port, TOKEN, undefined, true);
      expect(await reader.waitFor(isType('context'), 'reader context')).toMatchObject({ writer: false });
      reader.control('compact', 'reader-compact');
      expect(
        await reader.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'reader-compact',
          'reader rejection',
        ),
      ).toMatchObject({ ok: false, code: 'read_only' });

      writer.control('compact', 'writer-compact');
      expect(
        await writer.waitFor(
          (frame) => frame.type === 'context' && frame.state === 'compacting',
          'compacting snapshot',
        ),
      ).toMatchObject({ usage: null });
      expect(
        await writer.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'writer-compact',
          'compact result',
        ),
      ).toMatchObject({ ok: true, epoch: 0 });
      expect(h.handle.compactCalls).toBe(1);
      expect(h.frameLog.history).toEqual(historyBeforeCompact);
      await writer.close();
      expect(
        await reader.waitFor(
          (frame) => frame.type === 'context' && frame.writer,
          'promoted writer context',
        ),
      ).toMatchObject({ state: 'idle', writer: true });
      await reader.close();
    } finally {
      await h.close();
    }
  });

  it('isolates throwing provider probes behind conservative context snapshots', async () => {
    const h = await makeHarness();
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish before probe faults', 'probe-establish');
      await client.waitFor(isTurnEndFrame, 'probe setup turn');

      h.handle.throwHealthProbe = true;
      h.handle.fire({ type: 'state', state: 'idle' });
      expect(
        await client.waitFor(
          (frame) => frame.type === 'context' && frame.state === 'busy' && frame.usage === null,
          'health probe fallback',
        ),
      ).toBeDefined();
      h.handle.throwHealthProbe = false;

      h.handle.throwUsageProbe = true;
      h.handle.fire({ type: 'state', state: 'idle' });
      await client.waitFor(
        (frame) =>
          frame.type === 'context' &&
          frame.state === 'idle' &&
          frame.session_active &&
          frame.usage === null,
        'usage probe fallback',
      );
      h.handle.throwUsageProbe = false;

      h.handle.throwCompactProbe = true;
      h.handle.fire({ type: 'state', state: 'idle' });
      await client.waitFor(
        (frame) =>
          frame.type === 'context' &&
          frame.state === 'idle' &&
          frame.session_active &&
          !frame.compact_supported,
        'compact probe fallback',
      );
      h.handle.throwCompactProbe = false;
      client.send('still usable after probe faults', 'probe-after');
      await pollUntil(
        () => h.handle.calls.some((call) => call.text === 'still usable after probe faults'),
        'delivery after probe faults',
      );
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('keeps a promoted writer serialized behind an unresolved native compaction', async () => {
    const h = await makeHarness();
    try {
      const writer = await authedClient(h.port, TOKEN, undefined, true);
      writer.send('establish before held compact', 'establish-held-compact');
      await writer.waitFor(isTurnEndFrame, 'establish held compact session');
      const reader = await authedClient(h.port, TOKEN, undefined, true);
      let release!: () => void;
      h.handle.nextCompactHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      writer.control('compact', 'held-compact');
      await writer.waitFor(
        (frame) => frame.type === 'context' && frame.state === 'compacting',
        'held compact started',
      );
      await writer.close();
      expect(
        await reader.waitFor(
          (frame) => frame.type === 'context' && frame.writer && frame.state === 'compacting',
          'reader promoted during compact',
        ),
      ).toMatchObject({ writer: true, state: 'compacting' });

      reader.send('queued behind held compact', 'queued-held-compact');
      reader.control('compact', 'overlap-held-compact');
      expect(
        await reader.waitFor(
          (frame) =>
            frame.type === 'control_result' && frame.request_id === 'overlap-held-compact',
          'overlapping compact rejection',
        ),
      ).toMatchObject({ ok: false, code: 'busy' });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(
        h.frameLog.history.some(
          (frame) => frame.type === 'user' && frame.client_msg_id === 'queued-held-compact',
        ),
      ).toBe(false);
      expect(h.handle.calls.some((call) => call.text === 'queued behind held compact')).toBe(false);

      release();
      await reader.waitFor(
        (frame) => frame.type === 'ack' && frame.client_msg_id === 'queued-held-compact',
        'queued message ack after compact',
      );
      await pollUntil(
        () => h.handle.calls.some((call) => call.text === 'queued behind held compact'),
        'queued delivery after held compact',
      );
      await reader.close();
    } finally {
      await h.close();
    }
  });

  it('serializes user delivery behind provider-initiated compaction events', async () => {
    const h = await makeHarness();
    try {
      const writer = await authedClient(h.port, TOKEN, undefined, true);
      writer.send('establish before automatic compact', 'establish-auto-compact');
      await writer.waitFor(isTurnEndFrame, 'establish automatic compact session');
      h.handle.fire({ type: 'compaction_start' });
      await writer.waitFor(
        (frame) => frame.type === 'context' && frame.state === 'compacting',
        'automatic compact snapshot',
      );
      writer.send('queued behind automatic compact', 'queued-auto-compact');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(
        h.frameLog.history.some(
          (frame) => frame.type === 'user' && frame.client_msg_id === 'queued-auto-compact',
        ),
      ).toBe(false);
      expect(h.handle.calls.some((call) => call.text === 'queued behind automatic compact')).toBe(false);

      h.handle.fire({ type: 'compaction_end', success: true });
      expect(
        await writer.waitFor(
          (frame) => frame.type === 'context_event' && frame.action === 'compact',
          'automatic compact outcome',
        ),
      ).toMatchObject({ ok: true });
      await writer.waitFor(
        (frame) => frame.type === 'ack' && frame.client_msg_id === 'queued-auto-compact',
        'automatic compact queued ack',
      );
      await pollUntil(
        () => h.handle.calls.some((call) => call.text === 'queued behind automatic compact'),
        'delivery after automatic compact',
      );
      await writer.close();
    } finally {
      await h.close();
    }
  });

  it('rechecks provider compaction after ack and immediately before prompt delivery', async () => {
    const h = await makeHarness();
    try {
      const writer = await authedClient(h.port, TOKEN, undefined, true);
      writer.send('establish before ack race', 'ack-race-establish');
      await writer.waitFor(isTurnEndFrame, 'ack race setup');
      const callsBefore = h.handle.calls.length;
      h.handle.startCompactionOnNextHealth = true;
      writer.send('must wait after ack', 'ack-before-provider-compact');
      await writer.waitFor(
        (frame) => frame.type === 'ack' && frame.client_msg_id === 'ack-before-provider-compact',
        'durable ack before provider compact',
      );
      await writer.waitFor(
        (frame) => frame.type === 'context' && frame.state === 'compacting',
        'provider compact after ack',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(h.handle.calls).toHaveLength(callsBefore);
      h.handle.fire({ type: 'compaction_end', success: true });
      await pollUntil(
        () => h.handle.calls.some((call) => call.text === 'must wait after ack'),
        'prompt after provider compact terminal',
      );
      await writer.close();
    } finally {
      await h.close();
    }
  });

  it('projects provider-initiated compaction failures to every live user', async () => {
    const h = await makeHarness();
    try {
      const writer = await authedClient(h.port, TOKEN, undefined, true);
      writer.send('establish before provider failure', 'establish-provider-failure');
      await writer.waitFor(isTurnEndFrame, 'provider failure setup');
      const reader = await authedClient(h.port, TOKEN, undefined, true);
      h.handle.fire({ type: 'compaction_start' });
      h.handle.fire({ type: 'compaction_end', success: false, error: 'automatic compact failed' });
      for (const client of [writer, reader]) {
        expect(
          await client.waitFor(
            (frame) => frame.type === 'context_event' && frame.action === 'compact',
            'provider failure outcome',
          ),
        ).toMatchObject({ ok: false, message: 'automatic compact failed' });
      }
      await writer.close();
      await reader.close();
    } finally {
      await h.close();
    }
  });

  it('uses the native terminal event as explicit compaction result authority', async () => {
    const h = await makeHarness();
    try {
      const writer = await authedClient(h.port, TOKEN, undefined, true);
      writer.send('establish terminal authority', 'establish-terminal-authority');
      await writer.waitFor(isTurnEndFrame, 'terminal authority setup');
      Object.defineProperty(h.handle, 'compact', {
        configurable: true,
        value: async () => {
          h.handle.fire({ type: 'compaction_start' });
          h.handle.fire({
            type: 'compaction_end',
            success: false,
            error: 'terminal says compaction failed',
          });
          // Deliberately resolve to emulate a broken adapter. The server must
          // still trust the typed native terminal rather than report success.
        },
      });
      writer.control('compact', 'terminal-authority');
      expect(
        await writer.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'terminal-authority',
          'terminal-authority result',
        ),
      ).toMatchObject({ ok: false, code: 'failed', message: 'terminal says compaction failed' });
      expect(
        writer.frames.filter(
          (frame) => frame.type === 'context_event' && frame.action === 'compact',
        ),
      ).toHaveLength(0);
      await writer.close();
    } finally {
      await h.close();
    }
  });

  it('rejects no-session, busy, failed, and unsupported compaction without damaging chat', async () => {
    const h = await makeHarness();
    try {
      const writer = await authedClient(h.port, TOKEN, undefined, true);

      const contextsBeforeNoSession = writer.frames.filter(isType('context')).length;
      writer.control('compact', 'no-session');
      expect(
        await writer.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'no-session',
          'no-session rejection',
        ),
      ).toMatchObject({ ok: false, code: 'no_session' });
      await writer.waitFor(
        () => writer.frames.filter(isType('context')).length === contextsBeforeNoSession + 1,
        'canonical context after pre-lifecycle rejection',
      );

      writer.send('establish', 'establish-for-errors');
      await writer.waitFor(isTurnEndFrame, 'established turn');
      let release!: () => void;
      h.handle.nextHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const heldEnd = nextTurnEnd(writer);
      writer.send('hold turn', 'held-turn');
      await writer.waitFor(
        (frame) => frame.type === 'turn' && frame.state === 'start',
        'held turn start',
      );
      writer.control('compact', 'busy-compact');
      expect(
        await writer.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'busy-compact',
          'busy rejection',
        ),
      ).toMatchObject({ ok: false, code: 'busy' });
      release();
      await heldEnd;

      h.handle.nextCompactError = `provider failure ${'x'.repeat(500)}`;
      writer.control('compact', 'failed-compact');
      const failed = await writer.waitFor(
        (frame) => frame.type === 'control_result' && frame.request_id === 'failed-compact',
        'bounded compact failure',
      );
      expect(failed).toMatchObject({ ok: false, code: 'failed' });
      expect(failed.type === 'control_result' ? failed.message?.length : 0).toBeLessThanOrEqual(240);
      writer.send('usable after compact failure', 'after-compact-failure');
      await pollUntil(
        () => h.handle.calls.some((call) => call.text === 'usable after compact failure'),
        'delivery after compact failure',
      );

      Object.defineProperty(h.handle, 'compact', { value: undefined, configurable: true });
      writer.control('compact', 'unsupported-compact');
      expect(
        await writer.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'unsupported-compact',
          'unsupported rejection',
        ),
      ).toMatchObject({ ok: false, code: 'unsupported' });
      await writer.close();
    } finally {
      await h.close();
    }
  });

  it('caps user frames deferred behind a held control', async () => {
    const h = await makeHarness();
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish before queue cap', 'queue-cap-establish');
      await client.waitFor(isTurnEndFrame, 'queue cap setup');
      let release!: () => void;
      h.handle.nextCompactHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      client.control('compact', 'queue-cap-compact');
      await client.waitFor(
        (frame) => frame.type === 'context' && frame.state === 'compacting',
        'queue cap compacting',
      );
      for (let index = 0; index < 129; index += 1) {
        client.send(`deferred ${index}`, `deferred-cap-${index}`);
      }
      expect(
        await client.waitFor(
          (frame) => frame.type === 'error' && /too many messages/.test(frame.message),
          'deferred queue overflow',
        ),
      ).toBeDefined();
      expect(
        h.frameLog.history.some(
          (frame) => frame.type === 'user' && frame.client_msg_id === 'deferred-cap-128',
        ),
      ).toBe(false);
      expect(await client.closed).toBe(1013);
      release();
    } finally {
      await h.close();
    }
  });

  it('consumes deferred-frame failures and closes for no-ack reconnect recovery', async () => {
    const h = await makeHarness();
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish deferred failure', 'deferred-failure-establish');
      await client.waitFor(isTurnEndFrame, 'deferred failure setup');
      let release!: () => void;
      h.handle.nextCompactHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      client.control('compact', 'deferred-failure-compact');
      await client.waitFor(
        (frame) => frame.type === 'context' && frame.state === 'compacting',
        'deferred failure compacting',
      );
      const append = h.frameLog.append.bind(h.frameLog);
      h.frameLog.append = ((frame) => {
        if (frame.type === 'user' && frame.client_msg_id === 'deferred-failure-message') {
          throw new Error('injected append failure');
        }
        return append(frame);
      }) as ChatFrameLog['append'];
      client.send('fail after barrier', 'deferred-failure-message');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      release();
      expect(
        await client.waitFor(
          (frame) => frame.type === 'error' && /could not be reconciled/.test(frame.message),
          'deferred failure surfaced',
        ),
      ).toBeDefined();
      expect(await client.closed).toBe(1011);
      expect(
        h.frameLog.history.some(
          (frame) => frame.type === 'user' && frame.client_msg_id === 'deferred-failure-message',
        ),
      ).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('bounds a non-settling native compact and fresh-session spawn', async () => {
    const compactHarness = await makeHarness({ controlTimeoutMs: 25 });
    try {
      const client = await authedClient(compactHarness.port, TOKEN, undefined, true);
      client.send('establish before timeout', 'establish-timeout');
      await client.waitFor(isTurnEndFrame, 'establish before timeout');
      compactHarness.handle.nextCompactHold = new Promise<void>(() => {});
      client.control('compact', 'compact-timeout');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'compact-timeout',
          'compact timeout result',
        ),
      ).toMatchObject({ ok: false, code: 'failed' });
      expect(compactHarness.handle.disposed).toBe(true);
      await client.close();
    } finally {
      await compactHarness.close();
    }

    const spawnHarness = await makeHarness({
      controlTimeoutMs: 25,
      freshSpawnHold: new Promise<void>(() => {}),
    });
    try {
      const client = await authedClient(spawnHarness.port, TOKEN, undefined, true);
      const before = new GruSessionPointer(spawnHarness.chatDir).current();
      client.control('new_chat', 'spawn-timeout');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'spawn-timeout',
          'fresh spawn timeout result',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: 0 });
      expect(new GruSessionPointer(spawnHarness.chatDir).current()).toEqual(before);
      expect(spawnHarness.handle.disposed).toBe(false);
      await client.close();
    } finally {
      await spawnHarness.close();
    }
  });

  it('does not resume the committed session when timed-out compaction disposal fails', async () => {
    const h = await makeHarness({ controlTimeoutMs: 25, replaceDisposedOnResume: true });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish disposal failure', 'dispose-failure-establish');
      await client.waitFor(isTurnEndFrame, 'disposal failure setup');
      const spawnsBefore = h.spawnCalls.length;
      h.handle.nextCompactHold = new Promise<void>(() => {});
      h.handle.nextDisposeError = new Error('native writer still alive');
      client.control('compact', 'dispose-failure-compact');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'dispose-failure-compact',
          'disposal failure result',
        ),
      ).toMatchObject({ ok: false, code: 'failed' });
      expect(h.spawnCalls).toHaveLength(spawnsBefore);
      expect(await client.closed).toBe(1011);
    } finally {
      await h.close();
    }
  });

  it('never disposes the active handle when a timed-out fresh spawn later returns it', async () => {
    let releaseSpawn!: () => void;
    const h = await makeHarness({
      controlTimeoutMs: 25,
      reuseActiveOnFresh: true,
      freshSpawnHold: new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      }),
    });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish before late reuse', 'late-reuse-establish');
      await client.waitFor(isTurnEndFrame, 'late reuse setup');
      const before = new GruSessionPointer(h.chatDir).current();
      client.control('new_chat', 'late-reuse-timeout');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'late-reuse-timeout',
          'late reuse timeout result',
        ),
      ).toMatchObject({ ok: false, code: 'failed' });
      releaseSpawn();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(h.handle.disposed).toBe(false);
      expect(new GruSessionPointer(h.chatDir).current()).toEqual(before);
      client.send('active survives late reuse', 'late-reuse-after');
      await pollUntil(
        () => h.handle.calls.some((call) => call.text === 'active survives late reuse'),
        'active delivery after late reuse',
      );
      await client.close();
    } finally {
      releaseSpawn?.();
      await h.close();
    }
  });

  it('keeps compact timeout delivery gated until disposal and committed-session recovery finish', async () => {
    const h = await makeHarness({ controlTimeoutMs: 100, replaceDisposedOnResume: true });
    let releaseCompact!: () => void;
    let releaseDispose!: () => void;
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish timeout recovery', 'timeout-recovery-establish');
      await client.waitFor(isTurnEndFrame, 'timeout recovery setup');
      h.handle.nextCompactHold = new Promise<void>((resolve) => {
        releaseCompact = resolve;
      });
      h.handle.disposeHold = new Promise<void>((resolve) => {
        releaseDispose = resolve;
      });
      client.control('compact', 'timeout-recovery-compact');
      client.send('wait until resumed', 'timeout-recovery-message');
      await pollUntil(() => h.handle.disposalStarted, 'retiring handle disposal started');
      await new Promise<void>((resolve) => setTimeout(resolve, 35));
      expect(
        client.frames.some(
          (frame) =>
            frame.type === 'control_result' && frame.request_id === 'timeout-recovery-compact',
        ),
      ).toBe(false);
      expect(
        h.frameLog.history.some(
          (frame) => frame.type === 'user' && frame.client_msg_id === 'timeout-recovery-message',
        ),
      ).toBe(false);

      releaseDispose();
      expect(
        await client.waitFor(
          (frame) =>
            frame.type === 'control_result' && frame.request_id === 'timeout-recovery-compact',
          'timeout result after recovery',
        ),
      ).toMatchObject({ ok: false, code: 'failed' });
      await client.waitFor(
        (frame) => frame.type === 'ack' && frame.client_msg_id === 'timeout-recovery-message',
        'deferred frame after recovery',
      );
      expect(h.resumedHandles).toHaveLength(1);
      await pollUntil(
        () => h.resumedHandles[0]!.calls.some((call) => call.text === 'wait until resumed'),
        'deferred prompt routed to resumed handle',
      );
      expect(h.handle.calls.some((call) => call.text === 'wait until resumed')).toBe(false);
      releaseCompact();
      await client.close();
    } finally {
      releaseDispose?.();
      releaseCompact?.();
      await h.close();
    }
  });

  it('new chat advances one atomic epoch/floor, preserves old bytes, and supports repeated resets', async () => {
    const h = await makeHarness();
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('old epoch words', 'cross-epoch-id');
      await client.waitFor(isTurnEndFrame, 'old turn');
      const oldSession = h.handle.sessionFile!;
      const oldBytes = readFileSync(oldSession);
      const floor = h.frameLog.highWaterSeq;
      h.handle.throwOnUnsubscribe = true;

      client.control('new_chat', 'new-1');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'new-1',
          'first reset',
        ),
      ).toMatchObject({ ok: true, epoch: 1 });
      const boundarySnapshotIndex = client.frames.findIndex(
        (frame) => frame.type === 'context' && frame.epoch === 1,
      );
      const resetResultIndex = client.frames.findIndex(
        (frame) => frame.type === 'control_result' && frame.request_id === 'new-1',
      );
      expect(boundarySnapshotIndex).toBeGreaterThanOrEqual(0);
      expect(boundarySnapshotIndex).toBeLessThan(resetResultIndex);
      const firstFresh = h.freshHandles[0]!;
      expect(new GruSessionPointer(h.chatDir).current()).toMatchObject({
        sessionFile: firstFresh.sessionFile,
        epoch: 1,
        replayFloorSeq: floor,
      });
      await pollUntil(() => h.handle.disposed, 'retired handle disposal');
      expect(
        client.frames.some(
          (frame) => frame.type === 'context' && frame.epoch === 1 && frame.session_active,
        ),
      ).toBe(true);
      expect(readFileSync(oldSession)).toEqual(oldBytes);
      client.send('typed after reset', 'after-reset-id');
      await pollUntil(() => firstFresh.calls.length === 1, 'fresh epoch delivery');
      expect(firstFresh.calls[0]?.text).toBe('typed after reset');

      // Dedup scope is the active epoch, so the same browser id is legal.
      client.send('new epoch words', 'cross-epoch-id');
      await pollUntil(() => firstFresh.calls.length === 2, 'fresh delivery');
      const reconnect = await authedClient(h.port, TOKEN, 0, true);
      await reconnect.waitFor(isType('context'), 'reconnect context');
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(
        reconnect.frames.some(
          (frame) => frame.type === 'user' && frame.text === 'old epoch words',
        ),
      ).toBe(false);
      expect(
        reconnect.frames.some(
          (frame) => frame.type === 'user' && frame.text === 'new epoch words',
        ),
      ).toBe(true);
      const reconnectContextIndex = reconnect.frames.findIndex(
        (frame) => frame.type === 'context' && frame.epoch === 1,
      );
      const reconnectFreshFrameIndex = reconnect.frames.findIndex(
        (frame) => frame.type === 'user' && frame.text === 'new epoch words',
      );
      expect(reconnectContextIndex).toBeGreaterThanOrEqual(0);
      expect(reconnectContextIndex).toBeLessThan(reconnectFreshFrameIndex);

      client.control('new_chat', 'new-2');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'new-2',
          'second reset',
        ),
      ).toMatchObject({ ok: true, epoch: 2 });
      expect(new GruSessionPointer(h.chatDir).current()).toMatchObject({ epoch: 2 });
      expect(firstFresh.disposed).toBe(true);
      await reconnect.close();
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('rejects stale old-epoch resends server-side and scopes dedup to epoch', async () => {
    const h = await makeHarness();
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('old epoch id', 'epoch-scoped-id');
      await client.waitFor(isTurnEndFrame, 'old epoch delivery');
      client.control('new_chat', 'epoch-stale-reset');
      await client.waitFor(
        (frame) => frame.type === 'control_result' && frame.request_id === 'epoch-stale-reset',
        'epoch reset',
      );
      client.sendRaw({
        type: 'user',
        text: 'must never cross the boundary',
        client_msg_id: 'stale-other-tab',
        epoch: 0,
      });
      expect(
        await client.waitFor(
          (frame) => frame.type === 'error' && /reconciled/.test(frame.message),
          'stale epoch rejection',
        ),
      ).toBeDefined();
      expect(await client.closed).toBe(1011);
      expect(
        h.frameLog.history.some(
          (frame) => frame.type === 'user' && frame.text === 'must never cross the boundary',
        ),
      ).toBe(false);

      const current = await authedClient(h.port, TOKEN, undefined, true);
      current.send('same id is legal in epoch one', 'epoch-scoped-id');
      await current.waitFor(isTurnEndFrame, 'current epoch same-id delivery');
      expect(
        h.frameLog.history.flatMap((frame) =>
          frame.type === 'user' && frame.client_msg_id === 'epoch-scoped-id'
            ? [frame.epoch]
            : [],
        ),
      ).toEqual([0, 1]);
      await current.close();
    } finally {
      await h.close();
    }
  });

  it('logs notices raised during reset above the committed replay floor', async () => {
    let release!: () => void;
    const h = await makeHarness({
      freshSpawnHold: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.control('new_chat', 'notice-during-reset');
      await client.waitFor(
        (frame) => frame.type === 'context' && frame.state === 'resetting',
        'resetting before notice',
      );
      h.chat.surfaceNotice('action required while reset is staging');
      expect(
        h.frameLog.history.some(
          (frame) => frame.type === 'notice' && frame.text.includes('action required'),
        ),
      ).toBe(false);
      release();
      await client.waitFor(
        (frame) =>
          frame.type === 'control_result' && frame.request_id === 'notice-during-reset',
        'reset result before notice',
      );
      await client.waitFor(
        (frame) => frame.type === 'notice' && frame.text.includes('action required'),
        'deferred notice',
      );
      const state = new GruSessionPointer(h.chatDir).current()!;
      const notice = h.frameLog.history.find(
        (frame) => frame.type === 'notice' && frame.text.includes('action required'),
      );
      expect(notice?.seq).toBeGreaterThan(state.replayFloorSeq);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('reloads the durable epoch/floor and resumes the fresh session after service restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-e4-epoch-restart-'));
    cleanupDirs.push(dir);
    const first = await makeHarness({ reuseDir: dir });
    let freshFile = '';
    let floor = 0;
    try {
      const client = await authedClient(first.port, TOKEN, undefined, true);
      client.send('retired before service restart', 'retired-before-restart');
      await client.waitFor(isTurnEndFrame, 'retired turn');
      client.control('new_chat', 'restart-boundary');
      await client.waitFor(
        (frame) => frame.type === 'control_result' && frame.request_id === 'restart-boundary',
        'new chat before restart',
      );
      const state = new GruSessionPointer(first.chatDir).current()!;
      freshFile = state.sessionFile;
      floor = state.replayFloorSeq;
      await client.close();
    } finally {
      await first.close();
    }

    const restarted = await makeHarness({ reuseDir: dir });
    try {
      const client = await authedClient(restarted.port, TOKEN, 0, true);
      expect(await client.waitFor(isType('context'), 'restarted context')).toMatchObject({
        epoch: 1,
        replay_floor_seq: floor,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(
        client.frames.some(
          (frame) => frame.type === 'user' && frame.text === 'retired before service restart',
        ),
      ).toBe(false);
      client.send('after service restart', 'after-epoch-restart');
      await pollUntil(() => restarted.spawnCalls[0] === freshFile, 'resume fresh session after restart');
      await client.close();
    } finally {
      await restarted.close();
    }
  });

  it('invokes fresh-handle adoption after durable New chat activation', async () => {
    let adopted: AgentHandle | null = null;
    let retired: AgentHandle | null = null;
    const h = await makeHarness({
      adoptFreshGru: async (fresh) => {
        adopted = fresh;
        await retired?.dispose();
      },
    });
    retired = h.handle;
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.control('new_chat', 'adopt-fresh');
      await client.waitFor(
        (frame) => frame.type === 'control_result' && frame.request_id === 'adopt-fresh',
        'fresh adoption result',
      );
      expect(adopted).toBe(h.freshHandles[0]);
      expect(new GruSessionPointer(h.chatDir).current()?.sessionFile).toBe(
        h.freshHandles[0]?.sessionFile,
      );
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('rejects New chat before commit while the supervised slot breaker is open', async () => {
    const h = await makeHarness({ canAdoptFreshGru: () => false });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      const before = new GruSessionPointer(h.chatDir).current();
      client.control('new_chat', 'breaker-open-reset');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'breaker-open-reset',
          'breaker-open reset rejection',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: 0 });
      expect(new GruSessionPointer(h.chatDir).current()).toEqual(before);
      expect(h.freshHandles[0]?.disposed).toBe(true);
      expect(h.handle.disposed).toBe(false);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('bounds never-settling rejected-session cleanup before returning control failure', async () => {
    const never = new Promise<void>(() => {});
    const h = await makeHarness({
      controlTimeoutMs: 25,
      canAdoptFreshGru: () => false,
      freshDisposeHold: never,
    });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.control('new_chat', 'cleanup-never-settles');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'cleanup-never-settles',
          'bounded rejected-session cleanup',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: 0 });
      expect(h.freshHandles[0]?.disposalStarted).toBe(true);
      expect(h.handle.disposed).toBe(false);
      client.send('old chat remains usable', 'after-bounded-cleanup');
      await pollUntil(
        () => h.handle.calls.some((call) => call.text === 'old chat remains usable'),
        'delivery after bounded cleanup',
      );
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('bounds never-settling post-commit adoption without pinning the reset barrier', async () => {
    const h = await makeHarness({
      controlTimeoutMs: 25,
      adoptFreshGru: () => new Promise<void>(() => {}),
    });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.control('new_chat', 'adopt-never-settles');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'adopt-never-settles',
          'committed result before adoption timeout',
        ),
      ).toMatchObject({ ok: true, epoch: 1 });
      expect(
        await client.waitFor(
          (frame) => frame.type === 'context' && frame.epoch === 1 && frame.state === 'idle',
          'idle reset state',
        ),
      ).toBeDefined();
      expect(
        await client.waitFor(
          (frame) => frame.type === 'context_event' && frame.action === 'new_chat' && !frame.ok,
          'bounded adoption degradation',
        ),
      ).toMatchObject({ message: expect.stringContaining('supervision is degraded') });
      client.send('usable after adoption timeout', 'after-adoption-timeout');
      await pollUntil(
        () => h.freshHandles[0]?.calls.some((call) => call.text === 'usable after adoption timeout') === true,
        'delivery after adoption timeout',
      );
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('reports committed New chat success and separately surfaces failed supervision adoption', async () => {
    const h = await makeHarness({
      adoptFreshGru: async (fresh) => {
        await fresh.dispose();
        throw new Error('slot inactive');
      },
    });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.control('new_chat', 'adopt-failed');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'adopt-failed',
          'committed adoption result',
        ),
      ).toMatchObject({ ok: true, epoch: 1 });
      expect(
        await client.waitFor(
          (frame) => frame.type === 'context_event' && frame.action === 'new_chat',
          'supervision degradation event',
        ),
      ).toMatchObject({ ok: false, message: expect.stringContaining('supervision is degraded') });
      expect(new GruSessionPointer(h.chatDir).current()).toMatchObject({ epoch: 1 });
      expect(
        client.frames.some(
          (frame) => frame.type === 'context' && frame.epoch === 1 && !frame.session_active,
        ),
      ).toBe(true);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('refuses startup when the durable replay floor is ahead of the frame log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-e4-ahead-floor-'));
    cleanupDirs.push(dir);
    const chatDir = join(dir, 'chat');
    mkdirSync(chatDir, { recursive: true });
    const sessionFile = join(dir, 'session.jsonl');
    writeFileSync(sessionFile, '');
    const pointer = new GruSessionPointer(chatDir);
    pointer.advance(sessionFile, 1);
    const frameLog = ChatFrameLog.load(chatDir);
    expect(() =>
      createChatServer({
        config: {
          auth: { token: TOKEN },
          workspaceRoot: dir,
          dataDir: dir,
        } as GruCommandConfig,
        frameLog,
        pointer,
        spawnGru: async () => new StubGruHandle(sessionFile),
        spawnFreshGru: async () => new StubGruHandle(join(dir, 'fresh.jsonl'), 'fresh'),
        heartbeatMs: 0,
      }),
    ).toThrow(/replay floor 1 exceeds chat frame high-water 0/);
  });

  it('retries the same unacked words after vanished-session repair initially fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-e4-vanished-retry-'));
    cleanupDirs.push(dir);
    const first = await makeHarness({ reuseDir: dir });
    let vanishedFile = '';
    try {
      const client = await authedClient(first.port, TOKEN, undefined, true);
      client.control('new_chat', 'prepare-vanished-retry');
      await client.waitFor(
        (frame) =>
          frame.type === 'control_result' && frame.request_id === 'prepare-vanished-retry',
        'prepare vanished retry boundary',
      );
      vanishedFile = new GruSessionPointer(first.chatDir).current()!.sessionFile;
      await client.close();
    } finally {
      await first.close();
    }
    rmSync(vanishedFile, { force: true });

    const restarted = await makeHarness({
      reuseDir: dir,
      failFirstSpawn: new Error('repair temporarily unavailable'),
    });
    try {
      const firstAttempt = await authedClient(restarted.port, TOKEN, 0, true);
      firstAttempt.send('retry these exact words', 'vanished-retry-id');
      await firstAttempt.waitFor(
        (frame) => frame.type === 'error' && /could not be reconciled/.test(frame.message),
        'repair failure notice',
      );
      expect(await firstAttempt.closed).toBe(1011);
      expect(
        restarted.frameLog.history.some(
          (frame) => frame.type === 'user' && frame.client_msg_id === 'vanished-retry-id',
        ),
      ).toBe(false);
      expect(
        firstAttempt.frames.some(
          (frame) => frame.type === 'ack' && frame.client_msg_id === 'vanished-retry-id',
        ),
      ).toBe(false);

      const retry = await authedClient(restarted.port, TOKEN, 0, true);
      retry.send('retry these exact words', 'vanished-retry-id');
      await pollUntil(
        () => restarted.handle.calls.some((call) => call.text === 'retry these exact words'),
        'delivery after repair retry',
      );
      const state = new GruSessionPointer(restarted.chatDir).current()!;
      const logged = restarted.frameLog.history.find(
        (frame) => frame.type === 'user' && frame.client_msg_id === 'vanished-retry-id',
      );
      expect(state.epoch).toBe(2);
      expect(logged?.seq).toBeGreaterThan(state.replayFloorSeq);
      await retry.close();
    } finally {
      await restarted.close();
    }
  });

  it('advances the epoch before accepting words when a pointed native session vanished', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-e4-vanished-boundary-'));
    cleanupDirs.push(dir);
    const first = await makeHarness({ reuseDir: dir });
    let vanishedFile = '';
    let highWaterBeforeRepair = 0;
    try {
      const client = await authedClient(first.port, TOKEN, undefined, true);
      client.send('before vanished session', 'before-vanished');
      await client.waitFor(isTurnEndFrame, 'turn before vanished session');
      client.control('new_chat', 'vanished-new-chat');
      await client.waitFor(
        (frame) => frame.type === 'control_result' && frame.request_id === 'vanished-new-chat',
        'new chat before vanished session',
      );
      const fresh = first.freshHandles[0]!;
      client.send('fresh words before loss', 'fresh-before-loss');
      await pollUntil(() => fresh.calls.length === 1, 'fresh words delivered before loss');
      vanishedFile = fresh.sessionFile!;
      highWaterBeforeRepair = first.frameLog.highWaterSeq;
      await client.close();
    } finally {
      await first.close();
    }
    rmSync(vanishedFile, { force: true });

    const restarted = await makeHarness({ reuseDir: dir });
    try {
      const client = await authedClient(restarted.port, TOKEN, 0, true);
      client.send('first words after repair', 'after-vanished-repair');
      await pollUntil(
        () => restarted.handle.calls.some((call) => call.text === 'first words after repair'),
        'first delivery after vanished boundary repair',
      );
      const state = new GruSessionPointer(restarted.chatDir).current()!;
      expect(restarted.spawnCalls[0]).toBeNull();
      expect(state).toMatchObject({
        sessionFile: restarted.handle.sessionFile,
        epoch: 2,
        replayFloorSeq: highWaterBeforeRepair,
      });
      const repairedUser = restarted.frameLog.history.find(
        (frame) => frame.type === 'user' && frame.client_msg_id === 'after-vanished-repair',
      );
      expect(repairedUser?.seq).toBeGreaterThan(state.replayFloorSeq);
      expect(
        client.frames.some(
          (frame) => frame.type === 'ack' && frame.client_msg_id === 'after-vanished-repair',
        ),
      ).toBe(true);
      await client.close();
    } finally {
      await restarted.close();
    }
  });

  it('publishes a repaired epoch before flushing notices above its replay floor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-e4-repair-notice-order-'));
    cleanupDirs.push(dir);
    const first = await makeHarness({ reuseDir: dir });
    let vanishedFile = '';
    try {
      const client = await authedClient(first.port, TOKEN, undefined, true);
      client.control('new_chat', 'repair-notice-prepare');
      await client.waitFor(
        (frame) => frame.type === 'control_result' && frame.request_id === 'repair-notice-prepare',
        'prepare repair boundary',
      );
      vanishedFile = new GruSessionPointer(first.chatDir).current()!.sessionFile;
      await client.close();
    } finally {
      await first.close();
    }
    rmSync(vanishedFile, { force: true });

    const restarted = await makeHarness({ reuseDir: dir });
    try {
      const client = await authedClient(restarted.port, TOKEN, 0, true);
      restarted.chat.surfaceNotice('notice preserved across repair');
      client.send('trigger repair', 'repair-notice-trigger');
      await client.waitFor(
        (frame) => frame.type === 'notice' && frame.text === 'notice preserved across repair',
        'notice after repaired context',
      );
      const repairedContextIndex = client.frames.findIndex(
        (frame) => frame.type === 'context' && frame.epoch === 2,
      );
      const noticeIndex = client.frames.findIndex(
        (frame) => frame.type === 'notice' && frame.text === 'notice preserved across repair',
      );
      expect(repairedContextIndex).toBeGreaterThanOrEqual(0);
      expect(noticeIndex).toBeGreaterThan(repairedContextIndex);
      const state = new GruSessionPointer(restarted.chatDir).current()!;
      const notice = restarted.frameLog.history.find(
        (frame) => frame.type === 'notice' && frame.text === 'notice preserved across repair',
      );
      expect(notice?.seq).toBeGreaterThan(state.replayFloorSeq);
      await client.close();
    } finally {
      await restarted.close();
    }
  });

  it('aborts New chat if the retiring runtime starts provider compaction during fresh minting', async () => {
    let releaseSpawn!: () => void;
    const h = await makeHarness({
      freshSpawnHold: new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      }),
    });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish before reset race', 'reset-compact-race-establish');
      await client.waitFor(isTurnEndFrame, 'reset compact race setup');
      const before = new GruSessionPointer(h.chatDir).current();
      client.control('new_chat', 'reset-compact-race');
      await client.waitFor(
        (frame) => frame.type === 'context' && frame.state === 'resetting',
        'reset staging',
      );
      h.handle.fire({ type: 'compaction_start' });
      releaseSpawn();
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'reset-compact-race',
          'reset race result',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: before?.epoch ?? 0 });
      expect(new GruSessionPointer(h.chatDir).current()).toEqual(before);
      expect(h.freshHandles[0]?.disposed).toBe(true);
      expect(h.handle.disposed).toBe(false);
      h.handle.fire({ type: 'compaction_end', success: true });
      client.send('old session still usable', 'reset-compact-race-after');
      await pollUntil(
        () => h.handle.calls.some((call) => call.text === 'old session still usable'),
        'old session after aborted reset',
      );
      await client.close();
    } finally {
      releaseSpawn?.();
      await h.close();
    }
  });

  it('rejects a fresh spawn that reuses the active native session', async () => {
    const h = await makeHarness({ reuseActiveOnFresh: true });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish old native session', 'establish-before-reuse');
      await client.waitFor(isTurnEndFrame, 'establish before reuse');
      const before = new GruSessionPointer(h.chatDir).current();
      client.control('new_chat', 'reused-fresh');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'reused-fresh',
          'reused fresh rejection',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: 0 });
      expect(new GruSessionPointer(h.chatDir).current()).toEqual(before);
      expect(h.handle.disposed).toBe(false);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('rejects a fresh path alias that resolves to the active native session', async () => {
    const h = await makeHarness({ reuseActiveAliasOnFresh: true });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish before alias reuse', 'establish-before-alias-reuse');
      await client.waitFor(isTurnEndFrame, 'establish before alias reuse');
      const before = new GruSessionPointer(h.chatDir).current();
      client.control('new_chat', 'reused-alias');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'reused-alias',
          'reused alias rejection',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: 0 });
      expect(new GruSessionPointer(h.chatDir).current()).toEqual(before);
      expect(h.freshHandles[0]?.disposed).toBe(true);
      expect(h.handle.disposed).toBe(false);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('rejects a fresh hard link that aliases the active native session', async () => {
    const h = await makeHarness({ reuseActiveHardLinkOnFresh: true });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish before hard-link reuse', 'establish-before-hard-link-reuse');
      await client.waitFor(isTurnEndFrame, 'establish before hard-link reuse');
      const before = new GruSessionPointer(h.chatDir).current();
      client.control('new_chat', 'reused-hard-link');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'reused-hard-link',
          'reused hard-link rejection',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: 0 });
      expect(new GruSessionPointer(h.chatDir).current()).toEqual(before);
      expect(h.freshHandles[0]?.disposed).toBe(true);
      expect(h.handle.disposed).toBe(false);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('rejects a fresh file that reuses the active native session id', async () => {
    const h = await makeHarness({ reuseActiveIdOnFresh: true });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish old native id', 'establish-before-id-reuse');
      await client.waitFor(isTurnEndFrame, 'establish before id reuse');
      const before = new GruSessionPointer(h.chatDir).current();
      client.control('new_chat', 'reused-id');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'reused-id',
          'reused id rejection',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: 0 });
      expect(new GruSessionPointer(h.chatDir).current()).toEqual(before);
      expect(h.freshHandles[0]?.disposed).toBe(true);
      expect(h.handle.disposed).toBe(false);
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('a failed durable activation disposes the staged session and keeps the old chat usable', async () => {
    const h = await makeHarness({ failFirstPointerAdvance: new Error('pointer write failed') });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      client.send('establish before pointer failure', 'establish-pointer-failure');
      await client.waitFor(isTurnEndFrame, 'establish before pointer failure');
      const before = new GruSessionPointer(h.chatDir).current();
      client.control('new_chat', 'pointer-fail');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'pointer-fail',
          'pointer activation failure',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: 0 });
      expect(new GruSessionPointer(h.chatDir).current()).toEqual(before);
      expect(h.freshHandles[0]?.disposed).toBe(true);
      expect(h.handle.disposed).toBe(false);
      client.send('old usable after pointer failure', 'after-pointer-failure');
      await pollUntil(
        () => h.handle.calls.some((call) => call.text === 'old usable after pointer failure'),
        'old delivery after pointer failure',
      );
      await client.close();
    } finally {
      await h.close();
    }
  });

  it('a failed fresh spawn leaves the old epoch/session usable', async () => {
    const h = await makeHarness({ failFirstFreshSpawn: new Error('mint failed') });
    try {
      const client = await authedClient(h.port, TOKEN, undefined, true);
      const before = new GruSessionPointer(h.chatDir).current();
      client.control('new_chat', 'new-fail');
      expect(
        await client.waitFor(
          (frame) => frame.type === 'control_result' && frame.request_id === 'new-fail',
          'failed reset',
        ),
      ).toMatchObject({ ok: false, code: 'failed', epoch: 0 });
      expect(new GruSessionPointer(h.chatDir).current()).toEqual(before);
      client.send('old remains usable', 'after-failed-reset');
      await pollUntil(() => h.handle.calls.length === 1, 'old delivery after failed reset');
      expect(h.handle.calls[0]?.text).toBe('old remains usable');
      await client.close();
    } finally {
      await h.close();
    }
  });
});
