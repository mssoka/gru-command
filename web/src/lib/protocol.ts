/**
 * Gru Command chat socket protocol — the contract-as-built (E5).
 *
 * Endpoint: `/ws`. JSON text frames both directions.
 *
 * Client → server:
 *   { type: "auth", token, last_seen_seq? }   — MUST be the first frame.
 *   { type: "user", text, client_msg_id }
 *
 * Server → client (every frame carries a monotonic `seq`):
 *   { type: "auth_ok", seq }                  — auth accepted; `seq` is the
 *                                               log high-water mark.
 *   { type: "ack", client_msg_id, seq }       — a user message was received.
 *   { type: "delta", text, seq }              — streamed reply chunk.
 *   { type: "tool", name, state, seq }        — tool activity status line.
 *   { type: "turn", state: "start"|"end", seq }
 *   { type: "error", message, fatal?, seq? }  — fatal errors precede close.
 *
 * Reconnect: the client re-sends `auth` with `last_seen_seq`; the server
 * replies `auth_ok` and replays every logged frame with seq > last_seen_seq
 * (in seq order) before resuming live traffic. Omitting `last_seen_seq`
 * (or passing 0) requests a full replay — that is how a fresh page load
 * restores history.
 *
 * The real socket (E4) implements this same contract; the mock in
 * `web/mock/` exists only until that lands.
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

export interface UserFrame {
  readonly type: 'user';
  readonly text: string;
  readonly client_msg_id: string;
}

export type ClientFrame = AuthFrame | UserFrame;

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

export interface ReplayedUserFrame extends UserFrame {
  readonly seq: number;
}

export type ServerFrame =
  | AuthOkFrame
  | AckFrame
  | DeltaFrame
  | ToolFrame
  | TurnFrame
  | ErrorFrame
  | ReplayedUserFrame;

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
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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
      if (!isNonEmptyString(value.text) || !isNonEmptyString(value.client_msg_id)) return null;
      return { type: 'user', text: value.text, client_msg_id: value.client_msg_id };
    }
    default:
      return null;
  }
}

/** Parse a raw server→client frame; returns null when malformed. */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'auth_ok':
      return isSeq(value.seq) ? { type: 'auth_ok', seq: value.seq } : null;
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
    case 'user':
      // Server→client user frames appear in reconnect replays (they carry
      // seq) so a fresh page restores both sides of the conversation.
      return isNonEmptyString(value.text) &&
        isNonEmptyString(value.client_msg_id) &&
        isSeq(value.seq)
        ? { type: 'user', text: value.text, client_msg_id: value.client_msg_id, seq: value.seq }
        : null;
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

/** Frames that replay out of the server log on reconnect (all but auth_ok). */
export type LoggedFrame = Exclude<ServerFrame, AuthOkFrame>;

export function loggedFrameSeq(frame: LoggedFrame): number {
  // All logged frames carry a mandatory seq except `error`, where it is
  // optional by shape but always assigned by the mock before logging.
  return frame.seq ?? 0;
}
