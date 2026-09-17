/**
 * Server-side mirror of the chat socket protocol (EPICS E4 story 1).
 *
 * The contract's source of truth is the web UI's protocol module
 * (`web/src/lib/protocol.ts`) — built and mutation-proven against the
 * frontend. The backend build cannot import across the workspace
 * boundary (tsc rootDir), so this module mirrors it EXACTLY; a corpus
 * parity test (test/chat-frames.test.ts) feeds both implementations the
 * same inputs and fails on any divergence, in either direction.
 *
 * Contract summary (see docs/CHAT.md for the full server-side contract):
 * endpoint `/ws`, JSON text frames both directions. Client → server:
 * `auth` (first frame) and `user`. Server → client: `auth_ok`, `ack`,
 * `delta`, `tool`, `turn`, `error`, and `user` (replays). Every logged
 * frame carries a monotonic `seq`.
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
  // optional by shape; logged error frames always carry one (ephemeral
  // seq-less errors are never logged — see docs/CHAT.md).
  return frame.seq ?? 0;
}

// ---------------------------------------------------------------------------
// Builders (server side emits valid frames by construction)
// ---------------------------------------------------------------------------

/** A logged frame before seq assignment. The `error` member is narrowed
 * WITHOUT `fatal` (r2 W3): fatal frames are never persisted — the
 * shipped client treats any replayed fatal frame as pairing-fatal, so
 * the type itself must make the poison unpersistable. */
export type UnseqedFrame =
  | Omit<AckFrame, 'seq'>
  | Omit<DeltaFrame, 'seq'>
  | Omit<ToolFrame, 'seq'>
  | Omit<TurnFrame, 'seq'>
  | { readonly type: 'error'; readonly message: string }
  | Omit<ReplayedUserFrame, 'seq'>;

export function withSeq(frame: UnseqedFrame, seq: number): LoggedFrame {
  return { ...frame, seq } as LoggedFrame;
}

/** Ephemeral per-client error: never logged, never replayed (docs/CHAT.md). */
export function ephemeralError(message: string, fatal = false): ErrorFrame {
  return fatal ? { type: 'error', message, fatal: true } : { type: 'error', message };
}
