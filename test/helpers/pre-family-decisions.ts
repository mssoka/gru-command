import { randomUUID } from 'node:crypto';
import { LedgerDb, MIGRATIONS } from '../../src/ledger/db.js';

export interface PreFamilyDecisionInput {
  readonly subject: string;
  readonly covers: readonly string[];
  readonly decision?: string;
  readonly basisFingerprint?: string | null;
  readonly reason?: string;
  readonly by?: string;
  readonly clientKey?: string | null;
}

/** #503: decisions as a ledger before migration 32 stored them. The current
 * write boundary refuses retired tokens, so they are inserted raw into a
 * ledger stopped at migration 31; opening `dir` with every migration then
 * flags them pre-family. Returns their ids, oldest first. */
export function seedPreFamilyDecisions(dir: string, decisions: readonly PreFamilyDecisionInput[]): readonly string[] {
  const db = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, 31) });
  try {
    return decisions.map((input, index) => {
      const id = randomUUID();
      db.handle.prepare(`INSERT INTO decisions (id, subject, decision, covers, basis_fingerprint, reason, by, client_key, created_at, recheck_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(id, input.subject, input.decision ?? 'hold', JSON.stringify([...input.covers].sort()),
        input.basisFingerprint ?? null, input.reason ?? 'recorded before signal families', input.by ?? 'gru', input.clientKey ?? null,
        new Date(Date.parse('2026-01-01T00:00:00.000Z') + index).toISOString());
      return id;
    });
  } finally { db.close(); }
}
