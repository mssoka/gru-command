import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export const SESSION_STATE_NAME = 'gru-session.json';

export interface GruSessionState {
  /** Absolute path of the active Gru session jsonl (inside the session store). */
  readonly sessionFile: string;
  /** ISO timestamp of the last successful spawn. */
  readonly spawnedAt: string;
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
    const sessionFile =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['sessionFile']
        : undefined;
    if (typeof sessionFile !== 'string' || sessionFile === '') {
      throw new Error(
        `gru session pointer ${this.file} has no sessionFile; ` +
          'refusing to guess — inspect or remove the file',
      );
    }
    if (!existsSync(sessionFile)) {
      this.log('warn', 'gru session pointer names a vanished session file — spawning fresh', {
        pointer: this.file,
        sessionFile,
      });
      return null;
    }
    return sessionFile;
  }

  /** Record the active session file (atomic tmp + rename). */
  record(sessionFile: string): void {
    const state: GruSessionState = { sessionFile, spawnedAt: new Date().toISOString() };
    const staging = `${this.file}.tmp-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    renameSync(staging, this.file);
  }
}
