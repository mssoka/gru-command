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
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_ATTACHMENT_PATH_CHARS,
  WS_PATH,
  parseServerFrame,
  type AttachmentChip,
  type ContextFrame,
  type ControlAction,
  type ControlResultFrame,
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
  /** Attach chips (SPEC ruling 19): paths the agent reads itself. */
  readonly attachments?: readonly AttachmentChip[];
  /** Epoch in which this message actually left the browser. */
  epoch?: number;
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
  /** Fresh server-owned context/control state. */
  context?(snapshot: ContextFrame): void;
  /** A requested fixed control reached a terminal result. */
  controlResult?(result: ControlResultFrame): void;
  /** The durable active-chat epoch changed; the UI clears only its view. */
  epochChange?(epoch: number): void;
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

/** Chip shape check shared by send() and the outbox restore (review r1:
 * an unvalidated restore could wedge the outbox on a malformed frame the
 * server would reject forever). */
export function chipsValid(chips: unknown): chips is readonly AttachmentChip[] {
  if (chips === undefined) return true;
  if (!Array.isArray(chips)) return false;
  if (chips.length === 0 || chips.length > MAX_ATTACHMENTS_PER_MESSAGE) return false;
  for (const chip of chips) {
    if (
      typeof chip !== 'object' ||
      chip === null ||
      Array.isArray(chip) ||
      typeof chip.path !== 'string' ||
      chip.path === '' ||
      chip.path.length > MAX_ATTACHMENT_PATH_CHARS ||
      typeof chip.name !== 'string' ||
      chip.name === '' ||
      chip.name.length > MAX_ATTACHMENT_NAME_CHARS ||
      (chip.kind !== 'file' && chip.kind !== 'image')
    ) {
      return false;
    }
  }
  return true;
}

const OUTBOX_KEY = 'gru-outbox';
const SOCKET_OPEN = 1;
/** Guard against a wedge pasting unbounded text into storage + frames. */
export const MAX_MESSAGE_CHARS = 4_000;
/** A socket that never finishes handshaking is treated as down. */
const CONNECT_TIMEOUT_MS = 10_000;
const CONTEXT_TIMEOUT_MS = 5_000;

const BACKOFF_MS = [800, 1_600, 3_200, 6_400, 12_000] as const;

export class ChatClient {
  private socket: SocketLike | null = null;
  private state: ConnectionState = 'idle';
  private lastSeenSeq = 0;
  private highWaterSeq = 0;
  private currentEpoch: number | null = null;
  private attempts = 0;
  private stopped = false;
  private replaying = false;
  private awaitingContext = false;
  private reconnectPending = false;
  private serverControlState: ContextFrame['state'] | null = null;
  private serverWriter: boolean | null = null;
  /** While New chat is unresolved, newly typed words stay browser-local. The
   * authoritative idle context (including reconnect recovery) releases them
   * into whichever epoch actually won. */
  private pendingNewChatRequest: string | null = null;
  private pendingNewChatResultEpoch: number | null = null;
  /** A reconnect first observed this pending reset before its terminal idle
   * snapshot. Kept separately because ordinary reconnect reconciliation is
   * consumed by that first (possibly still-resetting) context frame. */
  private pendingNewChatRecovery = false;
  private readonly messages = new Map<string, ChatMessage>();
  private readonly outbox: string[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private contextDeadline: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: ChatClientOptions,
    private readonly events: ChatClientEvents,
  ) {
    for (const message of options.initialMessages ?? []) {
      this.messages.set(message.client_msg_id, { ...message });
    }
    for (const stored of this.readOutbox()) {
      // Restored entries retain whether they actually left the browser;
      // epoch confirmation decides whether a sent item may be retried.
      if (!this.messages.has(stored.client_msg_id)) {
        this.messages.set(stored.client_msg_id, { ...stored });
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
    this.contextDeadline = null;
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
    this.contextDeadline = null;
    this.socket?.close();
    this.socket = null;
    // onclose's stale-socket check returns early after nulling, so the
    // terminal transition is made here explicitly.
    this.setState('idle');
  }

  /** Queue-or-send a user message. An attachment-only message is legal
   * (chips carry the content); text alone or with chips is too. Throws
   * when there is neither text nor attachments, or oversized text. */
  send(text: string, attachments?: readonly AttachmentChip[]): ChatMessage {
    const trimmed = text.trim();
    const chips = attachments === undefined || attachments.length === 0 ? undefined : attachments;
    if (!chipsValid(chips)) throw new Error('invalid attachments (bad shape, kind, count, or length)');
    if (trimmed === '' && chips === undefined) throw new Error('empty message');
    if (trimmed.length > MAX_MESSAGE_CHARS) {
      throw new Error(`message too long (${trimmed.length} > ${MAX_MESSAGE_CHARS} chars)`);
    }
    const message: ChatMessage = {
      client_msg_id: this.id(),
      text: trimmed,
      ...(chips !== undefined ? { attachments: chips } : {}),
      status: 'queued',
    };
    this.messages.set(message.client_msg_id, message);
    this.outbox.push(message.client_msg_id);
    this.persistOutbox();
    this.events.messageStatus({ ...message });
    this.flushOutbox();
    return { ...message };
  }

  requestControl(action: ControlAction): string {
    if (this.state !== 'open' || this.replaying) {
      throw new Error('chat controls require an open, synchronized connection');
    }
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      throw new Error('chat controls require an open connection');
    }
    if (action === 'new_chat' && this.pendingNewChatRequest !== null) {
      throw new Error('new chat is already pending');
    }
    const requestId = `control-${this.id()}`;
    if (action === 'new_chat') {
      this.pendingNewChatRequest = requestId;
      this.pendingNewChatResultEpoch = null;
      this.pendingNewChatRecovery = false;
    }
    try {
      socket.send(JSON.stringify({ type: 'control', action, request_id: requestId }));
    } catch (error) {
      if (this.pendingNewChatRequest === requestId) {
        this.pendingNewChatRequest = null;
        this.pendingNewChatResultEpoch = null;
        this.pendingNewChatRecovery = false;
      }
      throw error;
    }
    return requestId;
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
      this.awaitingContext = true;
      const auth: Record<string, unknown> = {
        type: 'auth',
        token: this.options.token,
      };
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
        this.currentEpoch = null;
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
      if (this.contextDeadline !== null) {
        clearTimeout(this.contextDeadline);
        this.timers.delete(this.contextDeadline);
      }
      const contextDeadline = setTimeout(() => {
        this.timers.delete(contextDeadline);
        if (this.contextDeadline === contextDeadline) this.contextDeadline = null;
        if (this.socket === socket && this.awaitingContext) socket.close();
      }, CONTEXT_TIMEOUT_MS);
      this.contextDeadline = contextDeadline;
      this.timers.add(contextDeadline);
      // Wait for the authoritative epoch snapshot before deciding whether
      // a sent/unacked item may be retried. It may belong to a retired epoch.
      this.reconnectPending = true;
      this.replaying = true;
      this.events.replayStart(this.lastSeenSeq === 0);
      this.setState('open');
      // auth_ok's seq is the log high-water mark: replay ends exactly when
      // the stream catches up to it. Empty replay ends immediately.
      this.maybeEndReplay();
      return;
    }

    if (frame.type === 'context') {
      this.handleContext(frame);
      return;
    }

    if (frame.type === 'control_result') {
      if (frame.action === 'new_chat' && frame.request_id === this.pendingNewChatRequest) {
        if (frame.ok) {
          // Do not flush on success alone. The following idle context is the
          // authoritative boundary and closes the crash window between
          // durable activation and deferred server-side logging.
          this.pendingNewChatResultEpoch = frame.epoch;
        } else {
          // No epoch transition can follow a terminal rejection. Release the
          // local hold now; the server sends a canonical context snapshot
          // immediately after every pre-lifecycle rejection (and control
          // finally does the same after an attempted transition).
          this.pendingNewChatRequest = null;
          this.pendingNewChatResultEpoch = null;
          this.pendingNewChatRecovery = false;
        }
      }
      this.events.controlResult?.(frame);
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

  private handleContext(snapshot: ContextFrame): void {
    const priorEpoch = this.currentEpoch;
    if (priorEpoch !== null && snapshot.epoch < priorEpoch) {
      this.stopped = true;
      this.events.fatal(
        `server context epoch regressed from ${priorEpoch} to ${snapshot.epoch}; refusing unsafe replay`,
      );
      this.socket?.close();
      return;
    }
    this.awaitingContext = false;
    if (this.contextDeadline !== null) {
      clearTimeout(this.contextDeadline);
      this.timers.delete(this.contextDeadline);
      this.contextDeadline = null;
    }
    this.serverControlState = snapshot.state;
    this.serverWriter = snapshot.writer;
    const reconciling = this.reconnectPending;
    if (reconciling && this.pendingNewChatRequest !== null) {
      this.pendingNewChatRecovery = true;
    }
    let outboxChanged = false;
    let initialEpochPruned = false;
    if (priorEpoch === null) {
      this.currentEpoch = snapshot.epoch;
      this.lastSeenSeq = Math.max(this.lastSeenSeq, snapshot.replay_floor_seq);
      // On page restoration, persisted `sent` items carry the epoch in which
      // they left. Never resend one into a different active conversation.
      // Legacy entries had no status/epoch and restore as queued (safe).
      for (const [id, message] of this.messages) {
        if (message.epoch !== undefined && message.epoch !== snapshot.epoch) {
          this.messages.delete(id);
          outboxChanged = true;
          initialEpochPruned = true;
        } else if (message.status === 'sent' && this.reconnectPending) {
          message.status = 'queued';
          this.events.messageStatus({ ...message });
          outboxChanged = true;
        }
      }
    } else if (snapshot.epoch !== priorEpoch) {
      this.currentEpoch = snapshot.epoch;
      this.lastSeenSeq = snapshot.replay_floor_seq;
      // Only messages that never left this browser survive a durable reset.
      // Sent/acked entries belong to the retired epoch and must not be
      // resurrected by a reconnect resend.
      for (const [id, message] of this.messages) {
        if (message.status !== 'queued' || message.epoch !== undefined) {
          this.messages.delete(id);
          outboxChanged = true;
        }
      }
      this.events.epochChange?.(snapshot.epoch);
    } else {
      this.lastSeenSeq = Math.max(this.lastSeenSeq, snapshot.replay_floor_seq);
      if (this.reconnectPending) {
        // Same epoch: normal at-least-once retry; server-side id dedup makes
        // this safe and returns a fresh ack.
        for (const message of this.messages.values()) {
          if (message.status === 'sent') {
            message.status = 'queued';
            this.events.messageStatus({ ...message });
            outboxChanged = true;
          }
        }
      }
    }
    let pendingNewChatCleared = false;
    if (
      this.pendingNewChatRequest !== null &&
      snapshot.state === 'idle' &&
      (
        (this.pendingNewChatResultEpoch !== null &&
          snapshot.epoch >= this.pendingNewChatResultEpoch) ||
        (this.pendingNewChatResultEpoch === null && this.pendingNewChatRecovery)
      )
    ) {
      if (
        this.pendingNewChatResultEpoch === null &&
        this.pendingNewChatRecovery &&
        priorEpoch === snapshot.epoch
      ) {
        // The terminal result was lost with the socket, but an authoritative
        // idle snapshot in the original epoch proves reset did not commit.
        this.events.controlResult?.({
          type: 'control_result',
          action: 'new_chat',
          request_id: this.pendingNewChatRequest,
          ok: false,
          epoch: snapshot.epoch,
          code: 'failed',
          message: 'New chat did not complete before reconnect',
        });
      }
      this.pendingNewChatRequest = null;
      this.pendingNewChatResultEpoch = null;
      this.pendingNewChatRecovery = false;
      pendingNewChatCleared = true;
    }
    this.reconnectPending = false;
    if (outboxChanged) this.persistOutbox();
    // A fresh page renders restored outbox entries at replayStart, before its
    // first authoritative epoch arrives. Clear that temporary old-epoch
    // bubble if reconciliation just proved it belongs to a retired chat.
    if (initialEpochPruned) this.events.epochChange?.(snapshot.epoch);
    this.events.context?.(snapshot);
    this.maybeEndReplay();
    if (pendingNewChatCleared || snapshot.state === 'idle') this.flushOutbox();
  }

  private bumpSeq(seq: number): void {
    if (seq > this.lastSeenSeq) this.lastSeenSeq = seq;
    this.maybeEndReplay();
  }

  private maybeEndReplay(): void {
    if (!this.replaying || this.awaitingContext || this.state !== 'open') return;
    if (this.lastSeenSeq < this.highWaterSeq) return;
    this.replaying = false;
    this.events.replayEnd();
    this.flushOutbox();
  }

  private flushOutbox(): void {
    if (
      this.state !== 'open' ||
      this.replaying ||
      this.pendingNewChatRequest !== null ||
      this.serverWriter !== true ||
      this.serverControlState === 'compacting' ||
      this.serverControlState === 'resetting'
    ) return;
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
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      };
      const previousEpoch = message.epoch;
      message.status = 'sent';
      if (this.currentEpoch !== null) message.epoch = this.currentEpoch;
      // Persist the exact sent epoch before bytes leave this process. If
      // storage is unavailable, keep the word queued locally rather than
      // creating a reload shape that can cross an epoch without provenance.
      if (!this.persistOutbox()) {
        message.status = 'queued';
        if (previousEpoch === undefined) delete message.epoch;
        else message.epoch = previousEpoch;
        continue;
      }
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        message.status = 'queued';
        if (previousEpoch === undefined) delete message.epoch;
        else message.epoch = previousEpoch;
        this.persistOutbox();
        continue;
      }
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

  private readOutbox(): Array<{
    client_msg_id: string;
    text: string;
    attachments?: readonly AttachmentChip[];
    epoch?: number;
    status: 'queued' | 'sent';
  }> {
    try {
      const raw = this.options.storage.getItem(OUTBOX_KEY);
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: Array<{
        client_msg_id: string;
        text: string;
        attachments?: readonly AttachmentChip[];
        epoch?: number;
        status: 'queued' | 'sent';
      }> = [];
      for (const entry of parsed) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).client_msg_id === 'string' &&
          (entry as Record<string, unknown>).client_msg_id !== '' &&
          typeof (entry as Record<string, unknown>).text === 'string'
        ) {
          const record = entry as {
            client_msg_id: string;
            text: string;
            attachments?: unknown;
            epoch?: unknown;
            status?: unknown;
          };
          // Validate EACH record independently: one hostile attachments
          // value must not throw away healthy siblings. Invalid chips
          // degrade to text-only and overlong text to attachments-only;
          // if that leaves no content, drop the record so it cannot
          // become an unackable immortal frame.
          const trimmedText = record.text.trim();
          const text = trimmedText.length <= MAX_MESSAGE_CHARS ? trimmedText : '';
          const attachments =
            record.attachments !== undefined && chipsValid(record.attachments)
              ? record.attachments
              : undefined;
          if (text === '' && attachments === undefined) continue;
          const epoch =
            typeof record.epoch === 'number' &&
            Number.isSafeInteger(record.epoch) &&
            record.epoch >= 0
              ? record.epoch
              : undefined;
          out.push({
            client_msg_id: record.client_msg_id,
            text,
            ...(attachments !== undefined ? { attachments } : {}),
            ...(epoch !== undefined ? { epoch } : {}),
            // Old persisted shapes omitted status; treating those as never
            // sent preserves the pre-epoch never-lose behavior.
            status: record.status === 'sent' ? 'sent' : 'queued',
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private persistOutbox(): boolean {
    try {
      const entries = this.outbox
        .map((id) => this.messages.get(id))
        .filter((m): m is ChatMessage => m !== undefined && m.status !== 'acked')
        .map((m) => ({
          client_msg_id: m.client_msg_id,
          text: m.text,
          ...(m.attachments !== undefined ? { attachments: m.attachments } : {}),
          ...(m.epoch !== undefined ? { epoch: m.epoch } : {}),
          status: m.status,
        }));
      // Drop ids whose messages vanished or got acked.
      this.outbox.length = 0;
      this.outbox.push(...entries.map((e) => e.client_msg_id));
      if (entries.length === 0) {
        this.options.storage.removeItem(OUTBOX_KEY);
      } else {
        this.options.storage.setItem(OUTBOX_KEY, JSON.stringify(entries));
      }
      return true;
    } catch {
      // Storage full/blocked: the in-memory queue still protects this page.
      return false;
    }
  }
}
