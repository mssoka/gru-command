import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export const SESSION_STATE_NAME = 'gru-session.json';

export interface GruSessionState {
  /** Absolute path of the active Gru session jsonl (inside the session store). */
  readonly sessionFile: string;
  /** ISO timestamp of the last successful spawn. */
  readonly spawnedAt: string;
  /** Durable conversation generation. Legacy pointers load as epoch 0. */
  readonly epoch: number;
  /** Frames at or below this seq belong to an earlier active chat view. */
  readonly replayFloorSeq: number;
  /** The runtime that wrote the active session. NULL on pointers written
   * before this field existed: those resume once, then get backfilled. A
   * pointer naming runtime A must never hand its transcript to runtime B —
   * the formats are different, and pi's projection of a claude-code
   * transcript throws deep inside the SDK (see session-tree.ts). */
  readonly runtime: string | null;
}

/**
 * The single-Gru resume pointer (EPICS E4 story 3; SPEC rulings 1/3).
 *
 * The service must resume the SAME Gru brain across restarts — never
 * fork the conversation. This sidecar records which session file the
 * chat server spawned (or resumed) last, so the next boot passes it to
 * the runtime as `resumeFile`. Atomic writes (tmp + rename): a crash
 * mid-write never leaves a torn pointer.
 */
export class GruSessionPointer {
  readonly file: string;
  private readonly log: Log;

  constructor(
    readonly dir: string,
    log: Log = () => {},
    /** The runtime that WOULD host the next spawn. Null means unknown (a
     * pointer test, or a caller with no runtime notion): the mismatch check
     * is skipped rather than guessed. */
    private readonly currentRuntime: () => string | null = () => null,
  ) {
    this.file = join(dir, SESSION_STATE_NAME);
    this.log = log;
  }

  /**
   * The session file to resume, or null. A pointer whose session file
   * vanished is stale (the history is gone either way) → fresh spawn +
   * warn. A corrupt pointer fails loud — guessing here forks brains.
   */
  resumeCandidate(): string | null {
    const state = this.current();
    if (state === null) return null;
    if (!existsSync(state.sessionFile)) {
      this.log('warn', 'gru session pointer names a vanished session file — spawning fresh', {
        pointer: this.file,
        sessionFile: state.sessionFile,
      });
      return null;
    }
    // The session format belongs to the runtime that wrote it. Handing a
    // claude-code transcript to pi projects a foreign tree (and pi's first
    // open rewrites the header on the way), so refuse before the spawner
    // ever sees the path.
    const runtime = this.currentRuntime();
    if (state.runtime !== null && runtime !== null && state.runtime !== runtime) {
      this.log('warn', 'gru session was written by another runtime — spawning fresh', {
        pointer: this.file,
        sessionFile: state.sessionFile,
        session_runtime: state.runtime,
        runtime,
      });
      return null;
    }
    return state.sessionFile;
  }

  /** Read the durable pointer without applying session-file existence policy. */
  current(): GruSessionState | null {
    if (!existsSync(this.file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch (error) {
      throw new Error(
        `gru session pointer ${this.file} is unreadable (${String(error)}); ` +
          'refusing to guess — inspect or remove the file (a fresh brain spawns when it is absent)',
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `gru session pointer ${this.file} has no sessionFile; ` +
          'refusing to guess — inspect or remove the file',
      );
    }
    const value = parsed as Record<string, unknown>;
    const sessionFile = value['sessionFile'];
    if (typeof sessionFile !== 'string' || sessionFile === '') {
      throw new Error(
        `gru session pointer ${this.file} has no sessionFile; ` +
          'refusing to guess — inspect or remove the file',
      );
    }
    // Only the jointly ABSENT fields are the legacy shape. A partial pair
    // cannot represent an atomic boundary and explicit null/other corrupt
    // values must fail loud rather than being reinterpreted as epoch zero.
    const hasEpoch = value['epoch'] !== undefined;
    const hasReplayFloor = value['replayFloorSeq'] !== undefined;
    if (hasEpoch !== hasReplayFloor) {
      throw new Error(
        `gru session pointer ${this.file} has an incomplete epoch/replay floor; ` +
          'refusing to guess — inspect or remove the file',
      );
    }
    const epoch = hasEpoch ? value['epoch'] : 0;
    const replayFloorSeq = hasReplayFloor ? value['replayFloorSeq'] : 0;
    if (!isCounter(epoch) || !isCounter(replayFloorSeq)) {
      throw new Error(
        `gru session pointer ${this.file} has an invalid epoch/replay floor; ` +
          'refusing to guess — inspect or remove the file',
      );
    }
    // Absent is the legacy shape (resume once, then backfill). A present but
    // non-string value cannot be interpreted, and silently reading it as
    // "unknown" would resume a transcript this runtime may not own.
    const runtime = value['runtime'];
    if (runtime !== undefined && runtime !== null && (typeof runtime !== 'string' || runtime === '')) {
      throw new Error(
        `gru session pointer ${this.file} has an invalid runtime; ` +
          'refusing to guess — inspect or remove the file',
      );
    }
    return {
      sessionFile,
      spawnedAt: typeof value['spawnedAt'] === 'string' ? value['spawnedAt'] : '',
      epoch,
      replayFloorSeq,
      runtime: typeof runtime === 'string' ? runtime : null,
    };
  }

  /** Record a successful spawn without changing its conversation boundary. */
  record(sessionFile: string): GruSessionState {
    const prior = this.current();
    const state: GruSessionState = {
      sessionFile,
      spawnedAt: new Date().toISOString(),
      epoch: prior?.epoch ?? 0,
      replayFloorSeq: prior?.replayFloorSeq ?? 0,
      runtime: this.currentRuntime(),
    };
    this.write(state);
    return state;
  }

  /** Atomically activate a truly fresh native session and replay boundary. */
  advance(sessionFile: string, replayFloorSeq: number): GruSessionState {
    if (!isCounter(replayFloorSeq)) throw new Error('replay floor must be a non-negative integer');
    const prior = this.current();
    const priorEpoch = prior?.epoch ?? 0;
    if (priorEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error('chat epoch is exhausted; refusing to reuse an imprecise boundary');
    }
    const state: GruSessionState = {
      sessionFile,
      spawnedAt: new Date().toISOString(),
      epoch: priorEpoch + 1,
      replayFloorSeq,
      runtime: this.currentRuntime(),
    };
    this.write(state);
    return state;
  }

  private write(state: GruSessionState): void {
    const staging = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
      renameSync(staging, this.file);
    } catch (error) {
      try {
        rmSync(staging, { force: true });
      } catch {
        /* best effort — the active pointer was never replaced */
      }
      throw error;
    }
  }
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
