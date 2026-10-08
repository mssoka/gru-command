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
 * composition (#255 round 7, R7-20): a retry recorded before a restart is
 * resumed by the booted service itself — no test calls the recovery
 * helper. Removing main's resume call leaves the record unsettled and this
 * test fails.
 */

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('compiled service: startup resumes durable admission retries', () => {
  it('fires a retry that came due while the service was down — here a skip, its job having moved on', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-admission-retry-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-admission-retry-workspace-'));
    cleanup.push(home, workspace);
    const jobId = 'job-boot-retry';
    const db = new LedgerDb(home);
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: jobId, repo: 'fixture', title: 'boot retry', baseBranch: 'main', briefing: 'review' });
      ledger.setJobStatus(jobId, 'working');
      ledger.setJobStatus(jobId, 'blocked'); // moved on before the retry came due
      ledger.appendCustomEvent({ kind: 'round.admission-retry-scheduled', jobId, roundId: `${jobId}-r1`, payload: {
        attempt: 1, of: 2, dueAt: new Date(Date.now() - 60_000).toISOString(), deliverySeq: 0, input: { jobId },
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
          const row = ledger.prepare("SELECT payload FROM events WHERE kind = 'round.admission-retry-skipped' AND job_id = ?").get(jobId) as
            | { payload: string }
            | undefined;
          expect(row).toBeDefined();
          expect(JSON.parse(row!.payload)).toMatchObject({ attempt: 1, reason: 'the job is blocked' });
        } finally {
          ledger.close();
        }
      }, { timeout: 20_000, interval: 250 });
    } finally {
      await service.stop();
    }
  }, 60_000);
});
