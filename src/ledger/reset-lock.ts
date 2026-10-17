/**
 * The lock `gru-service reset` holds while it runs (#427 PR 2b):
 * `<data_dir>/reset.lock`, a SQLite file it locks exclusively from just
 * before its first change until it ends. Reset never deletes it (it is one
 * of the files reset keeps), so the lock stays on the file a starting
 * service looks at, and the ledger refuses to open while it is held
 * (`LedgerDb`): no service starts under a reset.
 * This module holds only the name, so `gru-service roll` never loads
 * `node:sqlite`.
 */
export const RESET_LOCK_FILE = 'reset.lock';
