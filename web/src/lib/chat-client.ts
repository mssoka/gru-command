/**
 * Chat socket client — reconnect-safe, never loses a typed word.
 *
 * - Auth via first frame; re-auth carries `last_seen_seq` so the server
 *   replays only what this client missed.
 * - Sends while disconnected queue in storage and flush after re-auth.
 * - Every server frame is deduped by `seq`; acks dedupe by client_msg_id.
 * - Storage + WebSocket constructor are injectable so unit tests run in
 *   Node without a DOM.
 */

import {
  WS_PATH,
  parseServerFrame,
  type LoggedFrame,
  type ServerFrame,
  type UserFrame,
} from './protocol.js';
import type { StorageLike } from '../theme.js';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'open'
  | 'reconnecting'
  | 'offline';

export type MessageStatus = 'queued' | 'sent' | 'acked';

export interface ChatMessage {
  readonly client_msg_id: string;
  readonly text: string;
  status: MessageStatus;
}

export interface ChatClientEvents {
  connection(state: ConnectionState): void;
  /** A user message changed status (queued → sent → acked). */
  messageStatus(message: ChatMessage): void;
  /** A logged server frame to render (delta/tool/turn/error/replayed user), in order. */
  frame(frame: LoggedFrame): void;
  /** Fires once after auth_ok when the server began a replay.
   *  `full` means the client asked for everything (fresh page load) — the
   *  UI should clear and rebuild; otherwise only missed frames arrive. */
  replayStart(full: boolean): void;
  /** Full history was restored (replay caught up to live traffic). */
  replayEnd(): void;
  /** Fatal error (bad token, protocol failure) — pairing must redo. */
  fatal(message: string): void;
}

export interface ChatClientOptions {
  readonly token: string;
  /** e.g. location.host — the client builds ws(s)://<host>/ws itself. */
  readonly host: string;
  readonly secure?: boolean;
  readonly storage: StorageLike;
  readonly webSocketCtor?: WebSocketCtor;
  readonly idgen?: () => string;
  readonly initialMessages?: readonly ChatMessage[];
}

/** Minimal structural type over the browser WebSocket (and `ws` in tests). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type WebSocketCtor = new (url: string) => SocketLike;

const OUTBOX_KEY = 'gru-outbox';
const SOCKET_OPEN = 1;
/** Guard against a wedge pasting unbounded text into storage + frames. */
export const MAX_MESSAGE_CHARS = 4_000;
/** A socket that never finishes handshaking is treated as down. */
const CONNECT_TIMEOUT_MS = 10_000;

const BACKOFF_MS = [800, 1_600, 3_200, 6_400, 12_000] as const;

export class ChatClient {
  private socket: SocketLike | null = null;
  private state: ConnectionState = 'idle';
  private lastSeenSeq = 0;
  private highWaterSeq = 0;
  private attempts = 0;
  private stopped = false;
  private replaying = false;
  private readonly messages = new Map<string, ChatMessage>();
  private readonly outbox: string[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly options: ChatClientOptions,
    private readonly events: ChatClientEvents,
  ) {
    for (const message of options.initialMessages ?? []) {
      this.messages.set(message.client_msg_id, { ...message });
    }
    for (const stored of this.readOutbox()) {
      // Restored queued messages keep their text so a reload loses nothing.
      if (!this.messages.has(stored.client_msg_id)) {
        this.messages.set(stored.client_msg_id, { ...stored, status: 'queued' });
      }
      if (!this.outbox.includes(stored.client_msg_id)) this.outbox.push(stored.client_msg_id);
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  getMessages(): readonly ChatMessage[] {
    return [...this.messages.values()];
  }

  connect(): void {
    this.stopped = false;
    // Defensive: a second connect must not leak the old socket or timers.
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.socket?.close();
    this.socket = null;
    // Surface restored queued messages so the UI renders them as bubbles.
    for (const id of this.outbox) {
      const message = this.messages.get(id);
      if (message) this.events.messageStatus({ ...message });
    }
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.socket?.close();
    this.socket = null;
    // onclose's stale-socket check returns early after nulling, so the
    // terminal transition is made here explicitly.
    this.setState('idle');
  }

  /** Queue-or-send a user message. Throws on empty/oversized text. */
  send(text: string): ChatMessage {
    const trimmed = text.trim();
    if (trimmed === '') throw new Error('empty message');
    if (trimmed.length > MAX_MESSAGE_CHARS) {
      throw new Error(`message too long (${trimmed.length} > ${MAX_MESSAGE_CHARS} chars)`);
    }
    const message: ChatMessage = {
      client_msg_id: this.id(),
      text: trimmed,
      status: 'queued',
    };
    this.messages.set(message.client_msg_id, message);
    this.outbox.push(message.client_msg_id);
    this.persistOutbox();
    this.events.messageStatus({ ...message });
    this.flushOutbox();
    return { ...message };
  }

  private id(): string {
    return this.options.idgen?.() ?? globalThis.crypto.randomUUID();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.connection(state);
  }

  private openSocket(): void {
    if (this.stopped) return;
    const ctor = this.options.webSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
    const secure = this.options.secure ?? true;
    const scheme = secure ? 'wss' : 'ws';
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const socket = new ctor(`${scheme}://${this.options.host}${WS_PATH}`);
    this.socket = socket;

    const connectTimer = setTimeout(() => {
      this.timers.delete(connectTimer);
      // Handshake never completed: treat as down, let onclose drive retry.
      socket.close();
    }, CONNECT_TIMEOUT_MS);
    this.timers.add(connectTimer);

    socket.onopen = () => {
      clearTimeout(connectTimer);
      this.timers.delete(connectTimer);
      this.setState('authenticating');
      const auth: Record<string, unknown> = { type: 'auth', token: this.options.token };
      if (this.lastSeenSeq > 0) auth.last_seen_seq = this.lastSeenSeq;
      socket.send(JSON.stringify(auth));
    };

    socket.onmessage = (event) => {
      const frame = parseServerFrame(String(event.data));
      if (frame === null) {
        // Malformed frames are ignored loudly in devtools, never fatal.
        console.warn('gru-chat: ignoring malformed frame', event.data);
        return;
      }
      this.handleFrame(socket, frame);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return; // stale socket from a prior attempt
      this.socket = null;
      if (this.stopped) {
        this.setState('idle');
        return;
      }
      this.setState('offline');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose follows and drives the state machine.
    };
  }

  private handleFrame(socket: SocketLike, frame: ServerFrame): void {
    if (socket !== this.socket) return; // stale socket from a prior attempt
    if (frame.type === 'auth_ok') {
      // Server restarted with a truncated/reset log: its high-water mark is
      // below what we already saw — resync with a full replay instead of
      // deduping every future frame into silence.
      if (frame.seq < this.lastSeenSeq) {
        this.lastSeenSeq = 0;
        // Detach before closing so onclose treats it as stale and doesn't
        // schedule a second reconnect.
        this.socket = null;
        socket.close();
        this.setState('offline');
        this.scheduleReconnect();
        return;
      }
      this.highWaterSeq = frame.seq;
      this.attempts = 0;
      // Unacked messages from a previous connection are re-queued; the
      // server dedups re-received user frames by client_msg_id and re-acks.
      for (const message of this.messages.values()) {
        if (message.status === 'sent') {
          message.status = 'queued';
          this.events.messageStatus({ ...message });
        }
      }
      this.replaying = true;
      this.events.replayStart(this.lastSeenSeq === 0);
      this.setState('open');
      // auth_ok's seq is the log high-water mark: replay ends exactly when
      // the stream catches up to it. Empty replay ends immediately.
      this.maybeEndReplay();
      return;
    }

    if (frame.type === 'error' && frame.fatal === true) {
      this.stopped = true;
      this.events.fatal(frame.message);
      socket.close();
      return;
    }

    if (frame.type === 'ack') {
      const message = this.messages.get(frame.client_msg_id);
      if (message && message.status !== 'acked') {
        message.status = 'acked';
        this.events.messageStatus({ ...message });
        this.removeFromOutbox(frame.client_msg_id);
      }
      this.bumpSeq(frame.seq);
      return;
    }

    if (frame.type === 'error') {
      if (typeof frame.seq === 'number') this.bumpSeq(frame.seq);
      this.events.frame(frame);
      return;
    }

    // delta / tool / turn / replayed-user — dedupe by seq (replay + live
    // share the stream). A replayed user frame also settles its local ack.
    if (frame.seq <= this.lastSeenSeq) return;
    this.bumpSeq(frame.seq);
    if (frame.type === 'user') {
      const local = this.messages.get(frame.client_msg_id);
      if (local && local.status !== 'acked') {
        local.status = 'acked';
        this.events.messageStatus({ ...local });
        this.removeFromOutbox(frame.client_msg_id);
        return; // already rendered locally — no duplicate bubble
      }
    }
    this.events.frame(frame);
  }

  private bumpSeq(seq: number): void {
    if (seq > this.lastSeenSeq) this.lastSeenSeq = seq;
    this.maybeEndReplay();
  }

  private maybeEndReplay(): void {
    if (!this.replaying || this.state !== 'open') return;
    if (this.lastSeenSeq < this.highWaterSeq) return;
    this.replaying = false;
    this.events.replayEnd();
    this.flushOutbox();
  }

  private flushOutbox(): void {
    if (this.state !== 'open' || this.replaying) return;
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) return;
    // Outbox entries stay until acked — a dropped socket re-sends them on
    // the next connection (see auth_ok). Never lose a typed word.
    for (const id of this.outbox) {
      const message = this.messages.get(id);
      if (message === undefined || message.status === 'acked') continue;
      if (message.status !== 'queued') continue;
      const frame: UserFrame = {
        type: 'user',
        text: message.text,
        client_msg_id: message.client_msg_id,
      };
      socket.send(JSON.stringify(frame));
      message.status = 'sent';
      this.events.messageStatus({ ...message });
    }
  }

  private removeFromOutbox(id: string): void {
    const index = this.outbox.indexOf(id);
    if (index >= 0) {
      this.outbox.splice(index, 1);
      this.persistOutbox();
    }
  }

  private scheduleReconnect(): void {
    const index = Math.min(this.attempts, BACKOFF_MS.length - 1);
    const delay = BACKOFF_MS[index] ?? 12_000;
    this.attempts += 1;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.openSocket();
    }, delay);
    this.timers.add(timer);
  }

  private readOutbox(): Array<{ client_msg_id: string; text: string }> {
    try {
      const raw = this.options.storage.getItem(OUTBOX_KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: Array<{ client_msg_id: string; text: string }> = [];
      for (const entry of parsed) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).client_msg_id === 'string' &&
          typeof (entry as Record<string, unknown>).text === 'string'
        ) {
          const record = entry as { client_msg_id: string; text: string };
          out.push({ client_msg_id: record.client_msg_id, text: record.text });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private persistOutbox(): void {
    try {
      const entries = this.outbox
        .map((id) => this.messages.get(id))
        .filter((m): m is ChatMessage => m !== undefined && m.status !== 'acked')
        .map((m) => ({ client_msg_id: m.client_msg_id, text: m.text }));
      // Drop ids whose messages vanished or got acked.
      this.outbox.length = 0;
      this.outbox.push(...entries.map((e) => e.client_msg_id));
      if (entries.length === 0) {
        this.options.storage.removeItem(OUTBOX_KEY);
      } else {
        this.options.storage.setItem(OUTBOX_KEY, JSON.stringify(entries));
      }
    } catch {
      // Storage full/blocked: the in-memory queue still protects this page.
    }
  }
}
