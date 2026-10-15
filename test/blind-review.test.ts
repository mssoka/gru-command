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
 * no-op promises and its distinct-read count semantics directly, at the helper
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
    // A path this test OWNS that cannot exist (a unique empty directory), so a
    // pre-existing readable file can never make this assertion pass wrongly. The
    // real reader on a nonexistent path returns null — the observer must record
    // NOTHING rather than an empty (clean-reading) observation.
    const missingDir = mkdtempSync(join(tmpdir(), 'gru-command-blind-missing-'));
    cleanupDirs.push(missingDir);
    observeBlindSessionAccess(h.ledger, 'job-unreadable', join(missingDir, 'no-such-session.jsonl'));
    expect(h.ledger.latestJobEvent('job-unreadable', BLIND_ACCESS_EVENT)).toBeNull();
    expect(blindCoverageOf(h.ledger, 'job-unreadable')).toMatchObject({ state: 'qualifying', accessObserved: false });
    h.dispose();
  });
});

describe('observeBlindSessionAccess — repeated scans count distinct reads (issue #339 N8, #355)', () => {
  it('re-scanning the same transcript never inflates the count, while a late new read still lands', () => {
    const h = blindLedger();
    h.admit('job-cumulative');
    const clean = [result(0, PERMITTED)];
    observeBlindSessionAccess(h.ledger, 'job-cumulative', '/s/a.jsonl', () => clean);
    expect(blindCoverageOf(h.ledger, 'job-cumulative')).toMatchObject({
      state: 'qualifying', qualifying: true, accessObserved: true, prohibitedAccess: 0,
    });
    // The resumed transcript is cumulative: the same whole-file rescan now
    // sees the prohibited read the first scan could not.
    const dirty = [result(0, PERMITTED), result(1, PROHIBITED)];
    observeBlindSessionAccess(h.ledger, 'job-cumulative', '/s/a.jsonl', () => dirty);
    expect(blindCoverageOf(h.ledger, 'job-cumulative')).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
    });
    // A duplicate scan of the SAME transcript (settle + physical completion)
    // appends its fact but re-reports the same read: the count stays distinct.
    observeBlindSessionAccess(h.ledger, 'job-cumulative', '/s/a.jsonl', () => dirty);
    expect(blindCoverageOf(h.ledger, 'job-cumulative')).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
    });
    expect(h.ledger.countJobEventsAndDistinctArrayEntries('job-cumulative', BLIND_ACCESS_EVENT, 'prohibited', {
      event: ['source', 'session'], entry: ['index', 'toolName', 'code', 'path', 'excerptSha256'],
    })).toEqual({ events: 3, distinct: 1 });
    // A late retry's new read in the same transcript is a new read...
    observeBlindSessionAccess(h.ledger, 'job-cumulative', '/s/a.jsonl', () => [...dirty, result(2, PROHIBITED)]);
    expect(blindCoverageOf(h.ledger, 'job-cumulative').prohibitedAccess).toBe(2);
    // ...and the same index in ANOTHER session is another physical read.
    observeBlindSessionAccess(h.ledger, 'job-cumulative', '/s/b.jsonl', () => dirty);
    expect(blindCoverageOf(h.ledger, 'job-cumulative').prohibitedAccess).toBe(3);
    h.dispose();
  });

  it('refuses a malformed identity key by name instead of interpolating it', () => {
    const h = blindLedger();
    expect(() => h.ledger.countJobEventsAndDistinctArrayEntries('j', BLIND_ACCESS_EVENT, 'prohibited', { event: ["x') OR 1"], entry: [] }))
      .toThrow(/payload key must be a simple JSON key/u);
    expect(() => h.ledger.countJobEventsAndDistinctArrayEntries('j', BLIND_ACCESS_EVENT, 'prohibited', { event: [], entry: [] }))
      .toThrow(/at least one identity key/u);
    h.dispose();
  });
});
