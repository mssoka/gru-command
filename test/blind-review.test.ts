import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  admitBlindReview,
  blindCoverageOf,
  blindSessionIdentity,
  observeBlindSessionAccess,
  recordBlindAdmission,
  recordObservedAccess,
  BLIND_ACCESS_EVENT,
} from '../src/dispatch/blind-review.js';
import { BlindInputRefusal, type ObservedToolResult } from '../src/dispatch/blind-input.js';

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

  it('identifies a session by its canonical path: two spellings of one transcript are one session (#355)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'blind-session-')));
    try {
      writeFileSync(join(dir, 'a.jsonl'), '');
      symlinkSync(join(dir, 'a.jsonl'), join(dir, 'alias.jsonl'));
      const identity = blindSessionIdentity(join(dir, 'a.jsonl'));
      expect(identity).toMatch(/^[0-9a-f]{64}$/u);
      expect(blindSessionIdentity(join(dir, 'alias.jsonl'))).toBe(identity);
      expect(blindSessionIdentity(join(dir, '.', 'a.jsonl'))).toBe(identity);
      const h = blindLedger();
      h.admit('job-cumulative');
      observeBlindSessionAccess(h.ledger, 'job-cumulative', join(dir, 'a.jsonl'), () => [result(0, PROHIBITED)]);
      observeBlindSessionAccess(h.ledger, 'job-cumulative', join(dir, 'alias.jsonl'), () => [result(0, PROHIBITED)]);
      expect(blindCoverageOf(h.ledger, 'job-cumulative').prohibitedAccess).toBe(1);
      // The local path itself never rides the ledger.
      expect(JSON.stringify(h.ledger.listJobEvents('job-cumulative'))).not.toContain(dir);
      h.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('counts an identical operator re-post once, a legacy session-less event as one unknown session, and refuses a malformed event (#355)', () => {
    const h = blindLedger();
    h.admit('job-cumulative');
    recordObservedAccess(h.ledger, 'job-cumulative', [result(0, PROHIBITED)], 'operator');
    recordObservedAccess(h.ledger, 'job-cumulative', [result(0, PROHIBITED)], 'operator');
    expect(blindCoverageOf(h.ledger, 'job-cumulative').prohibitedAccess).toBe(1);
    recordObservedAccess(h.ledger, 'job-cumulative', [result(1, PROHIBITED)], 'operator');
    expect(blindCoverageOf(h.ledger, 'job-cumulative').prohibitedAccess).toBe(2);
    // A pre-#355 session scan carried no `session`: it is one unknown session.
    const [entry] = (h.ledger.latestJobEvent('job-cumulative', BLIND_ACCESS_EVENT)!.payload as { prohibited: unknown[] }).prohibited;
    h.ledger.appendCustomEvent({ kind: BLIND_ACCESS_EVENT, jobId: 'job-cumulative', payload: { source: 'session', scanned: 1, rule_sha256: 'r', prohibited: [entry] } });
    h.ledger.appendCustomEvent({ kind: BLIND_ACCESS_EVENT, jobId: 'job-cumulative', payload: { source: 'session', scanned: 1, rule_sha256: 'r', prohibited: [entry] } });
    expect(blindCoverageOf(h.ledger, 'job-cumulative').prohibitedAccess).toBe(3);
    // A corrupt event is refused by name, never counted as nothing: an event
    // without the array, and an entry that is no object.
    h.ledger.appendCustomEvent({ kind: BLIND_ACCESS_EVENT, jobId: 'job-cumulative', payload: { source: 'session', scanned: 1 } });
    expect(() => blindCoverageOf(h.ledger, 'job-cumulative')).toThrow(/has 1 review\.blind-access-observed event\(s\) without a "prohibited" array and 0 non-object "prohibited" entr\(ies\)/u);
    h.ledger.appendCustomEvent({ kind: BLIND_ACCESS_EVENT, jobId: 'job-cumulative', payload: { source: 'session', prohibited: ['not an object'] } });
    expect(() => blindCoverageOf(h.ledger, 'job-cumulative')).toThrow(/1 review\.blind-access-observed event\(s\) without a "prohibited" array and 1 non-object "prohibited" entr\(ies\) — refusing to count them/u);
    h.dispose();
  });

  it('a sibling review whose coverage cannot be read refuses a new admission by name, never replacing it blindly (#355)', () => {
    const h = blindLedger();
    h.ledger.addJob({ id: 'sibling-review', repo: 'fixture', title: 'blind review', deliverable: 'review', targetSha: TARGET });
    const admission = admitBlindReview({
      ledger: h.ledger, jobId: 'sibling-review', title: 'review (blind)', deliverable: 'review',
      briefing: 'Review the immutable package read-only.', targetSha: TARGET, repoName: 'fixture',
      inputPackage: { baseSha: 'a'.repeat(40), targetSha: TARGET, files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }] },
    });
    recordBlindAdmission(h.ledger, 'sibling-review', admission!);
    h.ledger.appendCustomEvent({ kind: BLIND_ACCESS_EVENT, jobId: 'sibling-review', payload: { source: 'session', prohibited: [7] } });
    h.ledger.addJob({ id: 'new-review', repo: 'fixture', title: 'blind review', deliverable: 'review', targetSha: TARGET });
    let refusal: unknown = null;
    try {
      admitBlindReview({
        ledger: h.ledger, jobId: 'new-review', title: 'review (blind)', deliverable: 'review',
        briefing: 'Review the immutable package read-only.', targetSha: TARGET, repoName: 'fixture',
        inputPackage: { baseSha: 'a'.repeat(40), targetSha: TARGET, files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }] },
      });
    } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(BlindInputRefusal);
    expect(refusal).toMatchObject({ code: 'blind_coverage_unreadable', status: 409, details: { coverage_job_id: 'sibling-review' } });
    expect(String(refusal)).toMatch(/blind coverage of sibling review "sibling-review" cannot be read: .*non-object "prohibited" entr/u);
    expect((refusal as BlindInputRefusal).correction).toBe(`Inspect and repair "sibling-review"'s ${BLIND_ACCESS_EVENT} events in the ledger (its coverage cannot be computed until they are readable), then commission again.`);
    h.dispose();
  });

  it('a session identity needs an absolute path, and survives a transcript gone since it was read (#355)', () => {
    expect(() => blindSessionIdentity('relative/session.jsonl')).toThrow(/must be an absolute path/u);
    // Gone with its directory: the nearest ancestor that resolves, canonical, plus the names below it.
    const gone = join(tmpdir(), `gru-gone-${String(process.pid)}`, 'session.jsonl');
    const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
    expect(blindSessionIdentity(gone)).toBe(sha256(join(realpathSync(tmpdir()), `gru-gone-${String(process.pid)}`, 'session.jsonl')));
    // Any failure other than absence is raised, never papered over.
    const loop = join(realpathSync(mkdtempSync(join(tmpdir(), 'blind-loop-'))), 'loop');
    try {
      symlinkSync(loop, loop);
      expect(() => blindSessionIdentity(join(loop, 'a.jsonl'))).toThrow(/ELOOP/u);
    } finally { rmSync(join(loop, '..'), { recursive: true, force: true }); }
    // Gone through a linked directory: the same identity it had while it existed.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'blind-gone-')));
    try {
      writeFileSync(join(dir, 'a.jsonl'), '');
      symlinkSync(dir, `${dir}-alias`);
      const living = blindSessionIdentity(join(`${dir}-alias`, 'a.jsonl'));
      rmSync(join(dir, 'a.jsonl'));
      expect(blindSessionIdentity(join(`${dir}-alias`, 'a.jsonl'))).toBe(living);
    } finally { rmSync(`${dir}-alias`, { force: true }); rmSync(dir, { recursive: true, force: true }); }
  });

  it('a scanned read is recorded even when its transcript path cannot be resolved (#356)', () => {
    const h = blindLedger();
    h.admit('job-cumulative');
    observeBlindSessionAccess(h.ledger, 'job-cumulative', 'relative/session.jsonl', () => [result(0, PROHIBITED)]);
    expect(blindCoverageOf(h.ledger, 'job-cumulative')).toMatchObject({ state: 'invalidated', prohibitedAccess: 1 });
    const unresolved = `unresolved:${createHash('sha256').update(resolve('relative/session.jsonl')).digest('hex')}`;
    expect((h.ledger.latestJobEvent('job-cumulative', BLIND_ACCESS_EVENT)?.payload as { session: string }).session).toBe(unresolved);
    // A re-scan of the same unresolvable transcript is the same read.
    observeBlindSessionAccess(h.ledger, 'job-cumulative', 'relative/session.jsonl', () => [result(0, PROHIBITED)]);
    expect(blindCoverageOf(h.ledger, 'job-cumulative')).toMatchObject({ state: 'invalidated', prohibitedAccess: 1 });
    h.dispose();
  });

  it('names a corrupt blind-access payload, and leaves any other database failure as it is (#355)', () => {
    const h = blindLedger();
    h.admit('job-corrupt');
    observeBlindSessionAccess(h.ledger, 'job-corrupt', '/sessions/a.jsonl', () => [result(0, PROHIBITED)]);
    const db = (h.ledger as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    db.prepare('UPDATE events SET payload = ? WHERE job_id = ? AND kind = ?').run('{bad', 'job-corrupt', BLIND_ACCESS_EVENT);
    const keys = { event: ['session'], entry: ['index'] };
    let corrupt: unknown = null;
    try { h.ledger.countJobEventsAndDistinctArrayEntries('job-corrupt', BLIND_ACCESS_EVENT, 'prohibited', keys); } catch (error) { corrupt = error; }
    expect((corrupt as Error).message).toMatch(new RegExp(`^job "job-corrupt" has a ${BLIND_ACCESS_EVENT.replace(/\./gu, '\\.')} event whose payload cannot be read as JSON \\(.*malformed JSON.*\\) — refusing to count; inspect the ledger$`, 'u'));
    expect((corrupt as Error).cause).toBeInstanceOf(Error);
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const spy = vi.spyOn(db, 'prepare').mockImplementation(() => { throw busy; });
    try {
      expect(() => h.ledger.countJobEventsAndDistinctArrayEntries('job-corrupt', BLIND_ACCESS_EVENT, 'prohibited', keys)).toThrow(busy);
    } finally { spy.mockRestore(); }
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
