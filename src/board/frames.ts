/**
 * Board socket + API frames (E6): the contract between the board server
 * and the web client. Deliberately simpler than the chat contract —
 * snapshots are idempotent and last-write-wins, so there is no replay/seq
 * machinery: on open the server pushes the current snapshot, every board
 * change pushes a fresh one, and a reconnect simply starts over.
 */

export const BOARD_WS_PATH = '/board/ws';

export interface BoardAuthFrame {
  readonly type: 'auth';
  readonly token: string;
}

export type BoardClientFrame = BoardAuthFrame;

export interface BoardAuthOkFrame {
  readonly type: 'auth_ok';
}

export interface BoardSnapshotFrame {
  readonly type: 'board';
  readonly snapshot: unknown;
}

export interface BoardErrorFrame {
  readonly type: 'error';
  readonly message: string;
  readonly fatal: boolean;
}

export type BoardServerFrame = BoardAuthOkFrame | BoardSnapshotFrame | BoardErrorFrame;

/** Parse one inbound client frame; returns null on anything malformed. */
export function parseBoardClientFrame(raw: unknown): BoardClientFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  if (frame.type !== 'auth' || typeof frame.token !== 'string') return null;
  return { type: 'auth', token: frame.token };
}
