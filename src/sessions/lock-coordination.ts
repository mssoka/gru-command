import { DatabaseSync } from 'node:sqlite';

const LOCK_COORDINATION_BUSY_TIMEOUT_MS = 0;
const LOCK_COORDINATION_SUFFIX = '.lock-coordination.sqlite';

export class SessionLockCoordinationError extends Error {
  constructor(readonly sessionFile: string, readonly originalCause: unknown) {
    super(`could not acquire session lock coordination for ${sessionFile}: ${String(originalCause)}`);
    this.name = 'SessionLockCoordinationError';
  }
}

/** Run one synchronous lock-file observation or transition under a cross-process
 * SQLite write reservation. The session lock itself remains the durable owner
 * record; this database serializes observations and pathname mutations.
 * Synchronous event-loop callers never wait on another coordinator: contention
 * refuses loudly and the bounded recovery pass may reconsider afterward. */
export function withSessionLockCoordination<T>(sessionFile: string, operation: () => T): T {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(`${sessionFile}${LOCK_COORDINATION_SUFFIX}`);
    database.exec(`PRAGMA busy_timeout = ${LOCK_COORDINATION_BUSY_TIMEOUT_MS}`);
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try { database?.close(); } catch (closeError) {
      throw new AggregateError([error, closeError], `session lock coordinator could not close for ${sessionFile}`);
    }
    throw new SessionLockCoordinationError(sessionFile, error);
  }

  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `session lock coordination rollback failed for ${sessionFile}`);
    }
    throw error;
  } finally {
    database.close();
  }
}
