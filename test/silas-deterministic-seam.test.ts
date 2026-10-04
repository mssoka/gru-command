import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { SilasDriver } from '../src/dispatch/silas-driver.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { preflightFailure } from '../src/dispatch/review-path.js';
import { GitReviewPort } from './helpers/git-review-port.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Minimal REAL composition: SilasDriver (real trigger/bus/sweep) driving a
 * REAL WaveRunner queued handoff through the deterministic seam. */
describe('Silas deterministic-pass seam drives actual handoff reconsideration', () => {
  it('a bus wake event arms an idle-lane handoff with NO second API call, before any slot wake, without double start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seam-comp-port-')); dirs.push(root);
    const dbDir = mkdtempSync(join(tmpdir(), 'seam-comp-db-')); const db = new LedgerDb(dbDir); dirs.push(dbDir);
    const bus = new EventBus();
    const ledger = new LedgerApi(db.handle, { bus });
    const port = new GitReviewPort(root, 'main', 'a'.repeat(40));
    const job = ledger.addJob({ id: 'job-seam', repo: 'fixture', title: 'seam', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    await port.createJobWorktree({ repoPath: root, jobId: job.id });
    const order: string[] = [];
    const spawner = vi.fn();
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner, bus,
      reviewPreflight: async () => { order.push('preflight'); return { ok: false as const, failures: [preflightFailure('review-policy', 'disabled')] }; },
    });
    const accepted = await wave.requestReview({ jobId: job.id, handoff: true });
    expect(accepted.route).toBe('queued');
    // The lane settles WITHOUT a delivery event reaching the shared bus:
    // the status leaves the busy set but stays review-authorizable, so the
    // deterministic pass — not a second API request — may arm the queued
    // handoff. (A `job.delivered` event would already wake the wave's own
    // listener; this test isolates the Silas hook.)
    ledger.setJobStatus(job.id, 'delivered');
    const sweep: { cb: (() => void) | null } = { cb: null };
    const driver = new SilasDriver({
      slot: {
        ensure: async () => { order.push('slot-wake'); throw new Error('no model wake in this composition test'); },
        viewFor: () => null,
      } as never,
      ledger: { appendCustomEvent: () => ({ seq: 1 }) } as never,
      worktrees: { listWorktrees: () => [] } as never,
      ops: { baseUrl: 'http://127.0.0.1:0', configPath: 'unused' },
      config: { enabled: true, sweepIntervalMs: 60_000, pollIntervalMs: 0, directiveAt: 2, rebriefAt: 3, escalateAt: 4, stallThresholdMs: 1_800_000 },
      skills: [],
      bus,
      now: () => 0,
      setInterval: ((cb: () => void) => { sweep.cb = cb; return 1; }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as never,
      onDeterministicPass: () => {
        order.push('hook');
        wave.reconcilePendingHandoffs();
      },
    });
    driver.start();
    bus.publish({ seq: 1, ts: '0', kind: 'job.delivered', agentId: null, jobId: 'other-job', roundId: null, lens: null, payload: null });
    for (let tick = 0; tick < 50 && !ledger.latestJobEvent(job.id, 'job.review-handoff-started')
      && !ledger.latestJobEvent(job.id, 'job.review-handoff-failed'); tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // The hook ran BEFORE any slot wake and the real handoff reached a
    // terminal outcome with zero additional API calls.
    expect(order[0]).toBe('hook');
    expect(order).not.toContain('slot-wake');
    const terminal = ledger.latestJobEvent(job.id, 'job.review-handoff-started') ?? ledger.latestJobEvent(job.id, 'job.review-handoff-failed');
    expect(terminal).not.toBeNull();
    // Sweep tick fires the hook again: bounded, no duplicate start (the
    // pending entry is gone after its terminal outcome).
    sweep.cb?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order.filter((entry) => entry === 'hook').length).toBeGreaterThanOrEqual(2);
    await wave.shutdown();
    driver.stop();
  }, 30_000);
});
