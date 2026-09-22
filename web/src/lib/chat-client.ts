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
  type ContextEventFrame,
  type ContextFrame,
  type ControlAction,
  type ControlResultFrame,
  type LoggedFrame,
  type ServerFrame,
  type UserFrame,
} from './protocol.js';
import type { StorageLike } from '../theme.js';
import { uuidV4 } from './uuid.js';

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
  /** Provider-initiated or degraded context lifecycle outcome. */
  contextEvent?(event: ContextEventFrame): void;
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
  /** Test/embedding seam; production default remains 5 seconds. */
  readonly contextTimeoutMs?: number;
  /** No inbound frame for this long ⇒ the socket is presumed dead (the
   * sleep-killed/zombie shape that fires no close event) and is force-
   * reopened through the standard reconnect path. Default 2.5× the
   * server's 30 s ping cadence. */
  readonly livenessWindowMs?: number;
  /** How often the liveness clock is checked. */
  readonly livenessCheckMs?: number;
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
const PENDING_RESET_KEY = 'gru-pending-new-chat';
const SOCKET_OPEN = 1;
/** Guard against a wedge pasting unbounded text into storage + frames. */
export const MAX_MESSAGE_CHARS = 4_000;
/** A socket that never finishes handshaking is treated as down. */
const CONNECT_TIMEOUT_MS = 10_000;
const CONTEXT_TIMEOUT_MS = 5_000;
const DEFAULT_LIVENESS_WINDOW_MS = 75_000;
const DEFAULT_LIVENESS_CHECK_MS = 5_000;

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
  private pendingCompactRequest: string | null = null;
  private pendingCompactRecovery = false;
  private pendingNewChatRequest: string | null = null;
  private pendingNewChatOriginEpoch: number | null = null;
  private pendingNewChatResultEpoch: number | null = null;
  /** A reconnect first observed this pending reset before its terminal idle
   * snapshot. Kept separately because ordinary reconnect reconciliation is
   * consumed by that first (possibly still-resetting) context frame. */
  private pendingNewChatRecovery = false;
  /** A reload while reset is unresolved must not replay the retiring epoch
   * into the optimistic empty view. Frames still advance seq bookkeeping. */
  private suppressReplayFrames = false;
  private readonly suppressedReplay: LoggedFrame[] = [];
  private readonly messages = new Map<string, ChatMessage>();
  private readonly outbox: string[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private contextDeadline: ReturnType<typeof setTimeout> | null = null;
  /** Last inbound frame (any data, ping frames included). */
  private lastFrameAt = 0;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    const pendingReset = this.readPendingReset();
    if (pendingReset !== null) {
      this.pendingNewChatRequest = pendingReset.requestId;
      this.pendingNewChatOriginEpoch = pendingReset.originEpoch;
      this.pendingNewChatRecovery = true;
      this.suppressReplayFrames = true;
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  getMessages(): readonly ChatMessage[] {
    return [...this.messages.values()];
  }

  hasPendingNewChat(): boolean {
    return this.pendingNewChatRequest !== null;
  }

  connect(): void {
    this.stopped = false;
    // Defensive: a second connect must not leak the old socket or timers.
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.contextDeadline = null;
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.startLivenessWatch();
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
    this.reconnectTimer = null;
    this.stopLivenessWatch();
    this.socket?.close();
    this.socket = null;
    // onclose's stale-socket check returns early after nulling, so the
    // terminal transition is made here explicitly.
    this.setState('idle');
  }

  /**
   * Wake hook (document visibilitychange → visible, window 'online').
   * Re-verifies socket liveness without touching outbox/seq state: a
   * socket silent past the window is force-reconnected, and a pending
   * backoff timer is accelerated so a slept tab does not wait it out.
   * Chat's missing history is recovered by the normal auth replay.
   */
  wake(): void {
    if (this.stopped) return;
    if (this.socket !== null) {
      if (Date.now() - this.lastFrameAt > this.livenessWindowMs) this.forceReconnect();
      return;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.timers.delete(this.reconnectTimer);
      this.reconnectTimer = null;
      this.openSocket();
    }
  }

  private get livenessWindowMs(): number {
    return this.options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  }

  private startLivenessWatch(): void {
    if (this.livenessTimer !== null) return;
    this.livenessTimer = setInterval(
      () => this.checkLiveness(),
      this.options.livenessCheckMs ?? DEFAULT_LIVENESS_CHECK_MS,
    );
  }

  private stopLivenessWatch(): void {
    if (this.livenessTimer !== null) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  /** A sleep-killed socket fires no close event — detect the silence and
   * hand it to the reconnect path (which re-auths with last_seen_seq, so
   * missed history replays and queued words still flush exactly once). */
  private checkLiveness(): void {
    if (this.stopped || this.socket === null) return;
    if (Date.now() - this.lastFrameAt <= this.livenessWindowMs) return;
    this.forceReconnect();
  }

  /** Detach + close a presumed-dead socket and schedule the standard
   * reconnect. Detaching matters: a zombie close() may never fire, and a
   * late close from the old socket must not double-schedule. */
  private forceReconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
    if (this.pendingCompactRequest !== null) this.pendingCompactRecovery = true;
    this.setState('offline');
    this.scheduleReconnect();
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
    if (!this.persistOutbox()) {
      this.messages.delete(message.client_msg_id);
      this.outbox.pop();
      throw new Error('could not persist the queued message; browser storage is unavailable');
    }
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
    if (action === 'compact' && this.pendingCompactRequest !== null) {
      throw new Error('context compaction is already pending');
    }
    if (action === 'new_chat' && this.pendingNewChatRequest !== null) {
      throw new Error('new chat is already pending');
    }
    const requestId = `control-${this.id()}`;
    if (action === 'compact') {
      this.pendingCompactRequest = requestId;
      this.pendingCompactRecovery = false;
    }
    if (action === 'new_chat') {
      if (this.currentEpoch === null) {
        throw new Error('new chat requires an authoritative context epoch');
      }
      if (!this.persistPendingReset(requestId, this.currentEpoch)) {
        throw new Error('could not persist pending New chat state');
      }
      this.pendingNewChatRequest = requestId;
      this.pendingNewChatOriginEpoch = this.currentEpoch;
      this.pendingNewChatResultEpoch = null;
      this.pendingNewChatRecovery = false;
      this.suppressReplayFrames = false;
    }
    try {
      socket.send(JSON.stringify({ type: 'control', action, request_id: requestId }));
    } catch (error) {
      if (this.pendingCompactRequest === requestId) {
        this.pendingCompactRequest = null;
        this.pendingCompactRecovery = false;
      }
      if (this.pendingNewChatRequest === requestId) {
        this.pendingNewChatRequest = null;
        this.pendingNewChatOriginEpoch = null;
        this.pendingNewChatResultEpoch = null;
        this.pendingNewChatRecovery = false;
        this.suppressReplayFrames = false;
        this.clearPendingReset();
      }
      throw error;
    }
    return requestId;
  }

  private id(): string {
    // uuidV4 falls back to getRandomValues-based v4 minting where
    // crypto.randomUUID is absent (insecure contexts: LAN HTTP origins).
    return this.options.idgen?.() ?? uuidV4();
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
      // Bytes on the wire are the liveness proof; the parse decides whether
      // there is anything to do with them.
      this.lastFrameAt = Date.now();
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
      if (this.pendingCompactRequest !== null) this.pendingCompactRecovery = true;
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
    if (frame.type === 'ping') return; // keepalive only — no seq, no state
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
      }, this.options.contextTimeoutMs ?? CONTEXT_TIMEOUT_MS);
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
      if (frame.action === 'compact' && frame.request_id === this.pendingCompactRequest) {
        this.pendingCompactRequest = null;
        this.pendingCompactRecovery = false;
      }
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
          this.pendingNewChatOriginEpoch = null;
          this.pendingNewChatResultEpoch = null;
          this.pendingNewChatRecovery = false;
          this.suppressReplayFrames = false;
          this.clearPendingReset();
        }
      }
      this.events.controlResult?.(frame);
      return;
    }

    if (frame.type === 'context_event') {
      this.events.contextEvent?.(frame);
      return;
    }

    if (frame.type === 'error' && frame.fatal === true) {
      this.stopped = true;
      this.events.fatal(frame.message);
      socket.close();
      return;
    }

    if (
      this.suppressReplayFrames &&
      'seq' in frame &&
      typeof frame.seq === 'number'
    ) {
      // Keep transport continuity while the persisted pending-reset marker
      // hides the retiring epoch. If authoritative recovery proves failure,
      // the buffered replay restores that epoch before replayEnd.
      this.suppressedReplay.push(frame as LoggedFrame);
      this.bumpSeq(frame.seq);
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
    const pendingRetiredEpoch =
      this.pendingNewChatRequest !== null &&
      this.pendingNewChatOriginEpoch === snapshot.epoch &&
      snapshot.state !== 'idle';
    this.suppressReplayFrames = pendingRetiredEpoch;
    if (!pendingRetiredEpoch && snapshot.epoch !== this.pendingNewChatOriginEpoch) {
      this.suppressedReplay.length = 0;
    }

    if (
      this.pendingCompactRequest !== null &&
      this.pendingCompactRecovery &&
      snapshot.state === 'idle'
    ) {
      this.events.controlResult?.({
        type: 'control_result',
        action: 'compact',
        request_id: this.pendingCompactRequest,
        ok: false,
        epoch: snapshot.epoch,
        code: 'failed',
        message: 'Compaction outcome was lost during reconnect; current context is idle.',
      });
      this.pendingCompactRequest = null;
      this.pendingCompactRecovery = false;
    }

    let pendingNewChatCleared = false;
    if (this.pendingNewChatRequest !== null && snapshot.state === 'idle') {
      const committed =
        (this.pendingNewChatResultEpoch !== null &&
          snapshot.epoch >= this.pendingNewChatResultEpoch) ||
        (this.pendingNewChatOriginEpoch !== null &&
          snapshot.epoch > this.pendingNewChatOriginEpoch);
      const inferredFailure =
        !committed &&
        this.pendingNewChatResultEpoch === null &&
        this.pendingNewChatRecovery &&
        this.pendingNewChatOriginEpoch === snapshot.epoch;
      if (inferredFailure) {
        // The terminal result was lost with the socket, and an authoritative
        // idle snapshot still names the request's origin epoch: no durable
        // reset committed. Announce rollback first so a reloaded ChatView
        // exits its persisted optimistic-empty model; then replay the held
        // retiring transcript into that restored model.
        this.suppressReplayFrames = false;
        this.events.controlResult?.({
          type: 'control_result',
          action: 'new_chat',
          request_id: this.pendingNewChatRequest,
          ok: false,
          epoch: snapshot.epoch,
          code: 'failed',
          message: 'New chat did not complete before reconnect',
        });
        this.restoreSuppressedReplay();
      }
      if (committed || inferredFailure) {
        this.pendingNewChatRequest = null;
        this.pendingNewChatOriginEpoch = null;
        this.pendingNewChatResultEpoch = null;
        this.pendingNewChatRecovery = false;
        this.suppressReplayFrames = false;
        this.suppressedReplay.length = 0;
        this.clearPendingReset();
        pendingNewChatCleared = true;
      }
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

  private restoreSuppressedReplay(): void {
    for (const frame of this.suppressedReplay.splice(0)) {
      if (frame.type === 'ack') {
        const message = this.messages.get(frame.client_msg_id);
        if (message && message.status !== 'acked') {
          message.status = 'acked';
          this.events.messageStatus({ ...message });
          this.removeFromOutbox(frame.client_msg_id);
        }
        continue;
      }
      if (frame.type === 'user') {
        const local = this.messages.get(frame.client_msg_id);
        if (local && local.status !== 'acked') {
          local.status = 'acked';
          this.events.messageStatus({ ...local });
          this.removeFromOutbox(frame.client_msg_id);
          continue;
        }
      }
      this.events.frame(frame);
    }
  }

  private bumpSeq(seq: number): void {
    if (seq > this.lastSeenSeq) this.lastSeenSeq = seq;
    this.maybeEndReplay();
  }

  private maybeEndReplay(): void {
    if (
      !this.replaying ||
      this.awaitingContext ||
      this.suppressReplayFrames ||
      this.state !== 'open'
    ) return;
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
      if (this.currentEpoch === null) continue;
      const frame: UserFrame = {
        type: 'user',
        text: message.text,
        client_msg_id: message.client_msg_id,
        epoch: this.currentEpoch,
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
      if (this.reconnectTimer === timer) this.reconnectTimer = null;
      this.openSocket();
    }, delay);
    this.timers.add(timer);
    this.reconnectTimer = timer;
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

  private readPendingReset(): { requestId: string; originEpoch: number } | null {
    try {
      const raw = this.options.storage.getItem(PENDING_RESET_KEY);
      if (raw === null) return null;
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      const parsed = value as Record<string, unknown>;
      return typeof parsed.request_id === 'string' &&
        parsed.request_id !== '' &&
        typeof parsed.origin_epoch === 'number' &&
        Number.isSafeInteger(parsed.origin_epoch) &&
        parsed.origin_epoch >= 0
        ? { requestId: parsed.request_id, originEpoch: parsed.origin_epoch }
        : null;
    } catch {
      return null;
    }
  }

  private persistPendingReset(requestId: string, originEpoch: number): boolean {
    try {
      this.options.storage.setItem(
        PENDING_RESET_KEY,
        JSON.stringify({ request_id: requestId, origin_epoch: originEpoch }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private clearPendingReset(): void {
    try {
      this.options.storage.removeItem(PENDING_RESET_KEY);
    } catch {
      /* an authoritative in-memory resolution still releases this page */
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
