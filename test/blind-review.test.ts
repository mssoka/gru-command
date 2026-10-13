import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  admitBlindReview,
  blindCoverageOf,
  observeBlindSessionAccess,
  recordBlindAdmission,
  BLIND_ACCESS_EVENT,
} from '../src/dispatch/blind-review.js';
import type { ObservedToolResult } from '../src/dispatch/blind-input.js';

/**
 * The shared blind-access observer (`observeBlindSessionAccess`) is the one
 * seam every resume/re-brief/settle path calls. These pin its two documented
 * no-op promises and its cumulative-count semantics directly, at the helper
 * rather than through a delivery harness (issue #339 N8/N9).
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

const TARGET = 'f'.repeat(40);
const PERMITTED = 'src/feature.ts:1:export const feature = 1;';
const PROHIBITED = 'docs/issues/305-review.md:1:prior assessment';

function blindLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-blind-review-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const ledger = new LedgerApi(db.handle, { bus });
  return {
    ledger,
    /** A job admitted as a genuine blind review (the observer's precondition). */
    admit(jobId: string): void {
      ledger.addJob({ id: jobId, repo: 'fixture', title: 'blind review' });
      const admission = admitBlindReview({
        ledger,
        jobId,
        title: 'review (blind)',
        deliverable: 'review',
        briefing: 'Review the immutable package read-only.',
        targetSha: TARGET,
        repoName: 'fixture',
        inputPackage: { baseSha: 'a'.repeat(40), targetSha: TARGET, files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }] },
      });
      if (admission === null) throw new Error(`job "${jobId}" was not admitted as a blind review`);
      recordBlindAdmission(ledger, jobId, admission);
    },
    dispose(): void {
      db.close();
    },
  };
}

const result = (index: number, text: string): ObservedToolResult => ({ index, toolName: 'read', text });

describe('observeBlindSessionAccess — no-op contracts (issue #339 N9)', () => {
  it('reads nothing and records nothing for a job that was not admitted blind', () => {
    const h = blindLedger();
    let reads = 0;
    observeBlindSessionAccess(h.ledger, 'job-unadmitted', null, () => {
      reads += 1;
      return [result(0, PROHIBITED)];
    });
    // A non-blind job is a no-op: the session is never even read.
    expect(reads).toBe(0);
    expect(h.ledger.latestJobEvent('job-unadmitted', BLIND_ACCESS_EVENT)).toBeNull();
    h.dispose();
  });

  it('records no fabricated clean pass when the resumed session is unreadable', () => {
    const h = blindLedger();
    h.admit('job-unreadable');
    // The real reader on a nonexistent path returns null — the observer must
    // record NOTHING rather than an empty (clean-reading) observation.
    observeBlindSessionAccess(h.ledger, 'job-unreadable', join(tmpdir(), 'gru-no-such-session-339.jsonl'));
    expect(h.ledger.latestJobEvent('job-unreadable', BLIND_ACCESS_EVENT)).toBeNull();
    expect(blindCoverageOf(h.ledger, 'job-unreadable')).toMatchObject({ state: 'qualifying', accessObserved: false });
    h.dispose();
  });
});

describe('observeBlindSessionAccess — cumulative count semantics (issue #339 N8)', () => {
  it('sums prohibited access across observation events while the verdict stays invalidated', () => {
    const h = blindLedger();
    h.admit('job-cumulative');
    const clean = [result(0, PERMITTED)];
    observeBlindSessionAccess(h.ledger, 'job-cumulative', null, () => clean);
    expect(blindCoverageOf(h.ledger, 'job-cumulative')).toMatchObject({
      state: 'qualifying', qualifying: true, accessObserved: true, prohibitedAccess: 0,
    });
    // The resumed transcript is cumulative: the same whole-file rescan now
    // sees the prohibited read the first scan could not.
    const dirty = [result(0, PERMITTED), result(1, PROHIBITED)];
    observeBlindSessionAccess(h.ledger, 'job-cumulative', null, () => dirty);
    expect(blindCoverageOf(h.ledger, 'job-cumulative')).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
    });
    // A further rescan of the SAME transcript re-reports the read: the
    // informational count is the sum across events (documented tradeoff), and
    // the derived verdict stays invalidated.
    observeBlindSessionAccess(h.ledger, 'job-cumulative', null, () => dirty);
    expect(blindCoverageOf(h.ledger, 'job-cumulative')).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 2,
    });
    expect(h.ledger.countJobEventsAndArrayFieldLength('job-cumulative', BLIND_ACCESS_EVENT, 'prohibited')).toMatchObject({ events: 3, total: 2 });
    h.dispose();
  });
});
