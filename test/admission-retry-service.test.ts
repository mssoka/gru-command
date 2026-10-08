import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { pickFreePort, startRealService } from './helpers/real-service.mjs';

/**
 * The automatic admission retry's startup wiring through the REAL
 * composition (owner decision 2026-10-08): retries live in memory, so one
 * still pending when the service stopped is never resumed — the booted
 * service escalates it action-required, once. Removing main's startup call
 * leaves no escalation and this test fails.
 */

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('compiled service: startup escalates an interrupted admission retry', () => {
  it('a retry pending when the service stopped escalates action-required at the next start — never resumed, never a new round', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-admission-retry-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-admission-retry-workspace-'));
    cleanup.push(home, workspace);
    const jobId = 'job-boot-retry';
    const db = new LedgerDb(home);
    let roundId: string;
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: jobId, repo: 'fixture', title: 'boot retry', baseBranch: 'main', briefing: 'review' });
      ledger.setJobStatus(jobId, 'working');
      roundId = ledger.addRound({ jobId, lenses: ['correctness'], targetRef: 'a'.repeat(40) }).id;
      ledger.abortReviewSetupWithoutSpawn(roundId);
      ledger.appendCustomEvent({ kind: 'round.admission-retry-scheduled', jobId, roundId, payload: {
        attempt: 1, of: 2, dueAt: new Date(Date.now() + 60_000).toISOString(), deliverySeq: 0,
      } });
    } finally {
      db.close();
    }
    const service = await startRealService({
      port: await pickFreePort(), token: 'admission-retry-token', home, workspace, keepHome: true, requireWebDist: false,
    });
    try {
      await vi.waitFor(() => {
        const ledger = new DatabaseSync(join(home, 'ledger', 'ledger.db'), { readOnly: true });
        try {
          const settled = ledger.prepare("SELECT payload FROM events WHERE kind = 'round.admission-retry-settled' AND job_id = ?").all(jobId) as
            { payload: string }[];
          expect(settled.map((row) => JSON.parse(row.payload) as Record<string, unknown>)).toEqual([
            expect.objectContaining({ attempt: 1, outcome: 'interrupted' }),
          ]);
          const alerts = ledger.prepare("SELECT routing, title FROM notifications WHERE kind = 'review-escalation'").all() as
            { routing: string; title: string }[];
          expect(alerts).toEqual([{ routing: 'action-required', title: `Automatic review retry for job ${jobId} was interrupted by a restart` }]);
          const rounds = ledger.prepare('SELECT id FROM rounds WHERE job_id = ?').all(jobId) as { id: string }[];
          expect(rounds.map((row) => row.id)).toEqual([roundId]);
        } finally {
          ledger.close();
        }
      }, { timeout: 20_000, interval: 250 });
    } finally {
      await service.stop();
    }
  }, 60_000);
});
