/**
 * Board socket + API contract (client side, E6) — the mirror of the
 * service's src/board/frames.ts. Snapshots are idempotent and
 * last-write-wins: no replay/seq machinery, the server pushes a fresh
 * snapshot after auth and on every change; a reconnect starts over.
 */

export const BOARD_WS_PATH = '/board/ws';

export interface LensChipView {
  readonly lens: string;
  readonly state: string;
  readonly agentId: string | null;
  readonly note: string | null;
}

export interface RoundView {
  readonly id: string;
  readonly seq: number;
  readonly status: string;
  readonly verdict: string | null;
  readonly targetRef: string | null;
  readonly updatedAt: string;
  readonly lenses: readonly LensChipView[];
}

export interface JobView {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly prUrl: string | null;
  readonly baseBranch: string | null;
  readonly note: string | null;
  readonly rounds: readonly RoundView[];
}

export interface AgentView {
  readonly id: string;
  readonly role: string;
  readonly label: string | null;
  readonly state: string;
  readonly lastActivity: string | null;
  readonly sessionFile: string | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
}

export interface NotificationView {
  readonly id: string;
  readonly ts: string;
  readonly severity: 'info' | 'error';
  readonly title: string;
  readonly detail: string | null;
}

export interface BoardSnapshot {
  readonly repos: readonly { readonly name: string; readonly jobs: readonly JobView[] }[];
  readonly agents: readonly AgentView[];
  readonly notifications: readonly NotificationView[];
}

export interface TranscriptInfo {
  readonly file: string;
  readonly role: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly agentId: string | null;
  readonly agentLabel: string | null;
}

export interface TranscriptEntry {
  readonly index: number;
  readonly ts: number | null;
  readonly kind: 'user' | 'assistant' | 'tool_result' | 'system' | 'other';
  readonly role: string | null;
  readonly text: string;
  readonly thinking: string | null;
  readonly toolName: string | null;
  readonly isError: boolean;
}

export interface TranscriptPage {
  readonly file: string;
  readonly total: number;
  readonly entries: readonly TranscriptEntry[];
  readonly nextCursor: number | null;
  readonly skippedTornLines: number;
}

export interface TranscriptMatch {
  readonly index: number;
  readonly kind: TranscriptEntry['kind'];
  readonly snippet: string;
}

export interface TranscriptSearchResult {
  readonly file: string;
  readonly query: string;
  readonly matches: readonly TranscriptMatch[];
  readonly scanned: number;
}

export interface BoardAuthOkFrame {
  readonly type: 'auth_ok';
}

export interface BoardSnapshotFrame {
  readonly type: 'board';
  readonly snapshot: BoardSnapshot;
}

export interface BoardErrorFrame {
  readonly type: 'error';
  readonly message: string;
  readonly fatal: boolean;
}

export type BoardServerFrame = BoardAuthOkFrame | BoardSnapshotFrame | BoardErrorFrame;

/** Parse + validate one inbound server frame; null when malformed. */
export function parseBoardServerFrame(raw: unknown): BoardServerFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  if (frame.type === 'auth_ok') return { type: 'auth_ok' };
  if (frame.type === 'error' && typeof frame.message === 'string' && typeof frame.fatal === 'boolean') {
    return { type: 'error', message: frame.message, fatal: frame.fatal };
  }
  if (frame.type === 'board' && isValidSnapshot(frame.snapshot)) {
    return { type: 'board', snapshot: frame.snapshot as BoardSnapshot };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nstr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function isValidSnapshot(value: unknown): value is BoardSnapshot {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.repos) || !Array.isArray(value.agents) || !Array.isArray(value.notifications)) {
    return false;
  }
  return value.repos.every(
    (repo) =>
      isRecord(repo) &&
      typeof repo.name === 'string' &&
      Array.isArray(repo.jobs) &&
      repo.jobs.every(
        (job) =>
          isRecord(job) &&
          typeof job.id === 'string' &&
          typeof job.title === 'string' &&
          typeof job.status === 'string' &&
          Array.isArray(job.rounds) &&
          job.rounds.every(
            (round) =>
              isRecord(round) &&
              typeof round.id === 'string' &&
              typeof round.status === 'string' &&
              Array.isArray(round.lenses) &&
              round.lenses.every(
                (chip) => isRecord(chip) && typeof chip.lens === 'string' && typeof chip.state === 'string',
              ),
          ),
      ),
  );
}

/** Shape helpers shared by the views (defensive against schema drift). */
export function agentViewOf(agent: AgentView): { id: string; role: string; state: string } {
  return { id: agent.id, role: agent.role, state: agent.state };
}

export function lensChipTone(state: string): string {
  switch (state) {
    case 'live':
      return 'pp-chip--work';
    case 'done':
      return 'pp-chip--done';
    case 'error':
      return 'pp-chip--alert';
    default:
      return 'pp-chip--park';
  }
}

export function jobChipTone(status: string): string {
  switch (status) {
    case 'working':
    case 'dispatched':
      return 'pp-chip--work';
    case 'in-review':
      return 'pp-chip--rev';
    case 'merged':
    case 'done':
      return 'pp-chip--done';
    case 'blocked':
      return 'pp-chip--alert';
    case 'parked':
      return 'pp-chip--park';
    default:
      return '';
  }
}

export function agentStateTone(state: string): string {
  switch (state) {
    case 'streaming':
      return 'pp-chip--work';
    case 'idle':
      return 'pp-chip--done';
    case 'error':
      return 'pp-chip--alert';
    case 'spawning':
      return 'pp-chip--park';
    default:
      return 'pp-chip--park';
  }
}

export { str as boardStr, nstr as boardNstr };
