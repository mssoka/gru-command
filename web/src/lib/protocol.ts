/**
 * Gru Command chat socket protocol — the contract-as-built (E5).
 *
 * Endpoint: `/ws`. JSON text frames both directions.
 *
 * Client → server:
 *   { type: "auth", token, last_seen_seq? }   — MUST be the first frame.
 *   { type: "user", text, client_msg_id, epoch, attachments? }
 *   { type: "control", action, request_id }
 *
 * Server → client (durable frames carry a monotonic `seq`):
 *   { type: "auth_ok", seq }                  — auth accepted; `seq` is the
 *                                               log high-water mark.
 *   { type: "ack", client_msg_id, seq }       — a user message was received.
 *   { type: "delta", text, seq }              — streamed reply chunk.
 *   { type: "tool", name, state, seq }        — tool activity status line.
 *   { type: "turn", state: "start"|"end", seq }
 *   { type: "context", ... }                 — ephemeral authoritative lifecycle.
 *   { type: "control_result", ... }          — ephemeral terminal control result.
 *   { type: "context_event", ... }           — unsolicited provider lifecycle outcome.
 *   { type: "error", message, fatal?, seq? }  — fatal errors precede close.
 *
 * Reconnect: the client re-sends `auth` with `last_seen_seq`; the server
 * replies `auth_ok`, then an authoritative `context` snapshot, then logged
 * frames with seq > max(last_seen_seq, context.replay_floor_seq), in order.
 * The client must process context before replay so an epoch change can clear
 * the retired view safely. Omitting `last_seen_seq` (or passing 0) requests
 * all replayable history for the active epoch.
 *
 * The production socket and `web/mock/` both implement this contract;
 * parser parity is enforced by the root protocol corpus.
 */

export const WS_PATH = '/ws';

// ---------------------------------------------------------------------------
// Frame shapes
// ---------------------------------------------------------------------------

export interface AuthFrame {
  readonly type: 'auth';
  readonly token: string;
  readonly last_seen_seq?: number;
}

/** An attachment chip (SPEC ruling 19): a PATH reference the agent
 * reads itself — never a byte payload. Mirrored exactly in the server
 * twin (src/chat/frames.ts); parity-tested. */
export interface AttachmentChip {
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'image';
}

/** Composer caps mirrored from src/attachments/resolver.ts (single
 * source of constants; these live here so the client can pre-validate
 * without importing server code). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const MAX_ATTACHMENT_PATH_CHARS = 1024;
export const MAX_ATTACHMENT_NAME_CHARS = 200;

export interface UserFrame {
  readonly type: 'user';
  readonly text: string;
  readonly client_msg_id: string;
  /** Durable active-chat epoch observed before this frame left the client.
   * The server rejects stale/future epochs before logging or delivery. */
  readonly epoch: number;
  /** Ready-to-send chips from the ONE attach flow (SPEC ruling 19).
   * Optional + absent on legacy frames; validated chip-by-chip. */
  readonly attachments?: readonly AttachmentChip[];
}

export type ControlAction = 'compact' | 'new_chat';

export interface ControlFrame {
  readonly type: 'control';
  readonly action: ControlAction;
  readonly request_id: string;
}

export type ClientFrame = AuthFrame | UserFrame | ControlFrame;

export type ToolState = 'start' | 'end';
export type TurnState = 'start' | 'end';

export interface AuthOkFrame {
  readonly type: 'auth_ok';
  readonly seq: number;
}

export interface AckFrame {
  readonly type: 'ack';
  readonly client_msg_id: string;
  readonly seq: number;
}

export interface DeltaFrame {
  readonly type: 'delta';
  readonly text: string;
  readonly seq: number;
}

export interface ToolFrame {
  readonly type: 'tool';
  readonly name: string;
  readonly state: ToolState;
  readonly seq: number;
}

export interface TurnFrame {
  readonly type: 'turn';
  readonly state: TurnState;
  readonly seq: number;
}

export interface ErrorFrame {
  readonly type: 'error';
  readonly message: string;
  readonly fatal?: boolean;
  readonly seq?: number;
}

/** A product notice surfaced in the chat stream (E7, SPEC ruling 13):
 * action-required items Gru surfaces in chat. Logged + replayed. */
export interface NoticeFrame {
  readonly type: 'notice';
  readonly text: string;
  readonly seq: number;
}

export interface ReplayedUserFrame {
  readonly type: 'user';
  readonly text: string;
  readonly client_msg_id: string;
  /** Absent only on logs written before epoch-stamped user frames shipped. */
  readonly epoch?: number;
  readonly attachments?: readonly AttachmentChip[];
  readonly seq: number;
}

export type ContextControlState = 'idle' | 'busy' | 'compacting' | 'resetting';

export interface ContextUsageFrame {
  readonly tokens: number;
  readonly context_window: number;
  readonly percent: number;
}

/** Fresh, server-owned control state. It is intentionally ephemeral: every
 * authentication receives a new snapshot rather than replaying stale state. */
export interface ContextFrame {
  readonly type: 'context';
  readonly epoch: number;
  readonly replay_floor_seq: number;
  readonly state: ContextControlState;
  readonly usage: ContextUsageFrame | null;
  readonly compact_supported: boolean;
  readonly session_active: boolean;
  readonly writer: boolean;
}

export type ControlResultCode =
  | 'busy'
  | 'no_session'
  | 'unsupported'
  | 'read_only'
  | 'failed';

export interface ControlResultFrame {
  readonly type: 'control_result';
  readonly action: ControlAction;
  readonly request_id: string;
  readonly ok: boolean;
  readonly epoch: number;
  readonly code?: ControlResultCode;
  readonly message?: string;
}

/** Unsolicited provider lifecycle outcome. Unlike control_result, this is
 * broadcast to every connected view and has no client request to correlate. */
export interface ContextEventFrame {
  readonly type: 'context_event';
  readonly action: ControlAction;
  readonly ok: boolean;
  readonly message?: string;
}

/** Application-level keepalive: proves the socket is alive while chat is
 * quiet. Carries no seq and is never logged/replayed — reconnect and
 * outbox semantics are untouched; clients use it as liveness evidence. */
export interface PingFrame {
  readonly type: 'ping';
}

export type ServerFrame =
  | AuthOkFrame
  | ContextFrame
  | ControlResultFrame
  | ContextEventFrame
  | AckFrame
  | DeltaFrame
  | ToolFrame
  | TurnFrame
  | ErrorFrame
  | NoticeFrame
  | ReplayedUserFrame
  | PingFrame;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validate an optional attachments array (SPEC ruling 19 chips).
 * undefined (absent) and a valid array pass; anything malformed is null.
 * Mirrored exactly in the server twin — the parity corpus pins it. */
function parseAttachments(
  value: unknown,
): readonly AttachmentChip[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return null;
  }
  const chips: AttachmentChip[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (
      !isNonEmptyString(entry.path) ||
      entry.path.length > MAX_ATTACHMENT_PATH_CHARS ||
      !isNonEmptyString(entry.name) ||
      entry.name.length > MAX_ATTACHMENT_NAME_CHARS ||
      (entry.kind !== 'file' && entry.kind !== 'image')
    ) {
      return null;
    }
    chips.push({ path: entry.path, name: entry.name, kind: entry.kind });
  }
  return chips;
}

/** Parse a raw client→server frame; returns null when malformed. */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'auth': {
      if (!isNonEmptyString(value.token)) return null;
      if (value.last_seen_seq !== undefined && !isSeq(value.last_seen_seq)) return null;
      const frame: AuthFrame = { type: 'auth', token: value.token };
      if (isSeq(value.last_seen_seq)) return { ...frame, last_seen_seq: value.last_seen_seq };
      return frame;
    }
    case 'user': {
      if (
        typeof value.text !== 'string' ||
        !isNonEmptyString(value.client_msg_id) ||
        !isSeq(value.epoch)
      ) return null;
      const attachments = parseAttachments(value.attachments);
      if (attachments === null) return null;
      // Attachment-only messages are legal (chips carry the content);
      // a frame with neither text nor chips is malformed (ruling 19).
      if (value.text.trim() === '' && attachments === undefined) return null;
      return attachments === undefined
        ? { type: 'user', text: value.text, client_msg_id: value.client_msg_id, epoch: value.epoch }
        : {
            type: 'user',
            text: value.text,
            client_msg_id: value.client_msg_id,
            epoch: value.epoch,
            attachments,
          };
    }
    case 'control':
      return (value.action === 'compact' || value.action === 'new_chat') &&
        isNonEmptyString(value.request_id)
        ? { type: 'control', action: value.action, request_id: value.request_id }
        : null;
    default:
      return null;
  }
}

/** Parse a raw server→client frame; returns null when malformed. */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'ping':
      return { type: 'ping' };
    case 'auth_ok':
      return isSeq(value.seq) ? { type: 'auth_ok', seq: value.seq } : null;
    case 'context': {
      if (
        !isSeq(value.epoch) ||
        !isSeq(value.replay_floor_seq) ||
        (value.state !== 'idle' &&
          value.state !== 'busy' &&
          value.state !== 'compacting' &&
          value.state !== 'resetting') ||
        typeof value.compact_supported !== 'boolean' ||
        typeof value.session_active !== 'boolean' ||
        typeof value.writer !== 'boolean'
      ) return null;
      let usage: ContextUsageFrame | null = null;
      if (value.usage !== null) {
        if (!isRecord(value.usage)) return null;
        if (
          typeof value.usage.tokens !== 'number' ||
          !Number.isFinite(value.usage.tokens) ||
          value.usage.tokens < 0 ||
          typeof value.usage.context_window !== 'number' ||
          !Number.isFinite(value.usage.context_window) ||
          value.usage.context_window <= 0 ||
          typeof value.usage.percent !== 'number' ||
          !Number.isFinite(value.usage.percent) ||
          value.usage.percent < 0 ||
          value.usage.percent > 100
        ) return null;
        usage = {
          tokens: value.usage.tokens,
          context_window: value.usage.context_window,
          percent: value.usage.percent,
        };
      }
      return {
        type: 'context',
        epoch: value.epoch,
        replay_floor_seq: value.replay_floor_seq,
        state: value.state,
        usage,
        compact_supported: value.compact_supported,
        session_active: value.session_active,
        writer: value.writer,
      };
    }
    case 'control_result': {
      if (
        (value.action !== 'compact' && value.action !== 'new_chat') ||
        !isNonEmptyString(value.request_id) ||
        typeof value.ok !== 'boolean' ||
        !isSeq(value.epoch)
      ) return null;
      const codes: readonly ControlResultCode[] = [
        'busy', 'no_session', 'unsupported', 'read_only', 'failed',
      ];
      if (value.code !== undefined && !codes.includes(value.code as ControlResultCode)) return null;
      if (value.ok ? value.code !== undefined : value.code === undefined) return null;
      if (value.message !== undefined && !isNonEmptyString(value.message)) return null;
      return {
        type: 'control_result',
        action: value.action,
        request_id: value.request_id,
        ok: value.ok,
        epoch: value.epoch,
        ...(value.code !== undefined ? { code: value.code as ControlResultCode } : {}),
        ...(typeof value.message === 'string' ? { message: value.message } : {}),
      };
    }
    case 'context_event':
      if (
        (value.action !== 'compact' && value.action !== 'new_chat') ||
        typeof value.ok !== 'boolean' ||
        (value.message !== undefined && !isNonEmptyString(value.message))
      ) return null;
      return {
        type: 'context_event',
        action: value.action,
        ok: value.ok,
        ...(typeof value.message === 'string' ? { message: value.message } : {}),
      };
    case 'ack':
      return isNonEmptyString(value.client_msg_id) && isSeq(value.seq)
        ? { type: 'ack', client_msg_id: value.client_msg_id, seq: value.seq }
        : null;
    case 'delta':
      return typeof value.text === 'string' && isSeq(value.seq)
        ? { type: 'delta', text: value.text, seq: value.seq }
        : null;
    case 'tool':
      return isNonEmptyString(value.name) &&
        (value.state === 'start' || value.state === 'end') &&
        isSeq(value.seq)
        ? { type: 'tool', name: value.name, state: value.state, seq: value.seq }
        : null;
    case 'turn':
      return (value.state === 'start' || value.state === 'end') && isSeq(value.seq)
        ? { type: 'turn', state: value.state, seq: value.seq }
        : null;
    case 'notice':
      return isNonEmptyString(value.text) && isSeq(value.seq)
        ? { type: 'notice', text: value.text, seq: value.seq }
        : null;
    case 'user':
      // Server→client user frames appear in reconnect replays (they carry
      // seq) so a fresh page restores both sides of the conversation —
      // attachment chips included (SPEC ruling 19).
      {
        if (typeof value.text !== 'string' ||
          !isNonEmptyString(value.client_msg_id) ||
          !isSeq(value.seq)) return null;
        if (value.epoch !== undefined && !isSeq(value.epoch)) return null;
        const attachments = parseAttachments(value.attachments);
        if (attachments === null) return null;
        if (value.text.trim() === '' && attachments === undefined) return null;
        return attachments === undefined
          ? {
              type: 'user',
              text: value.text,
              client_msg_id: value.client_msg_id,
              ...(isSeq(value.epoch) ? { epoch: value.epoch } : {}),
              seq: value.seq,
            }
          : {
              type: 'user',
              text: value.text,
              client_msg_id: value.client_msg_id,
              ...(isSeq(value.epoch) ? { epoch: value.epoch } : {}),
              seq: value.seq,
              attachments,
            };
      }
    case 'error': {
      if (!isNonEmptyString(value.message)) return null;
      const frame: ErrorFrame = { type: 'error', message: value.message };
      return {
        ...frame,
        ...(typeof value.fatal === 'boolean' ? { fatal: value.fatal } : {}),
        ...(isSeq(value.seq) ? { seq: value.seq } : {}),
      };
    }
    default:
      return null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Frames that replay out of the durable log. Control state/outcomes are
 * always fresh and never persisted. */
export type LoggedFrame = Exclude<
  ServerFrame,
  AuthOkFrame | ContextFrame | ControlResultFrame | ContextEventFrame | PingFrame
>;

export function loggedFrameSeq(frame: LoggedFrame): number {
  // All logged frames carry a mandatory seq except `error`, where it is
  // optional by shape but always assigned by the mock before logging.
  return frame.seq ?? 0;
}
