import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { SilasDriver } from '../src/dispatch/silas-driver.js';
import { createProductionDeterministicPass } from '../src/dispatch/durable-reconcile.js';
import { CanceledRequestCloseout } from '../src/dispatch/canceled-request-closeout.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { preflightFailure } from '../src/dispatch/review-path.js';
import { GitReviewPort } from './helpers/git-review-port.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

/** Minimal REAL composition: SilasDriver (real trigger/bus/sweep) driving a
 * REAL WaveRunner queued handoff through the deterministic seam. */
describe('Silas deterministic-pass seam drives actual handoff reconsideration', () => {
  it('a bus wake event arms an idle-lane handoff with NO second API call, before any slot wake, without double start', async () => {
    const repo = makeFixtureRepo('seam-comp-source'); repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'seam-comp-port-')); dirs.push(root);
    const dbDir = mkdtempSync(join(tmpdir(), 'seam-comp-db-')); const db = new LedgerDb(dbDir); dirs.push(dbDir);
    // Two buses: the ledger publishes on its own; the wave and driver share
    // the control bus. A real delivery settles the lane without waking the
    // wave's own listener, so only the deterministic pass can arm the
    // handoff in this test.
    const bus = new EventBus();
    const ledgerBus = new EventBus();
    const ledger = new LedgerApi(db.handle, { bus: ledgerBus });
    const port = new GitReviewPort(root, 'main', repo.head(), ledger);
    const job = ledger.addJob({ id: 'job-seam', repo: 'fixture', title: 'seam', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    await port.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const order: string[] = [];
    const spawner = vi.fn();
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner, bus,
      reviewPreflight: async () => { order.push('preflight'); return { ok: false as const, failures: [preflightFailure('review-policy', 'disabled')] }; },
    });
    const requestReview = vi.spyOn(wave, 'requestReview');
    const accepted = await wave.requestReview({ jobId: job.id, handoff: true });
    expect(accepted.route).toBe('queued');
    // The lane settles for real (a recorded delivery), while the CONTROL
    // bus never sees it: the wave's own delivery listener stays silent, so
    // the deterministic pass — not a second API request — may arm the
    // queued handoff. The status stays working: a settled delivery is the
    // review-ready point, not a status flip.
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: repo.head() } });
    const sweep: { cb: (() => void) | null } = { cb: null };
    const driver = new SilasDriver({
      slot: {
        ensure: async () => { order.push('slot-wake'); throw new Error('no model wake in this composition test'); },
        viewFor: () => null,
      } as never,
      ledger: { appendCustomEvent: () => ({ seq: 1 }) } as never,
      worktrees: { listWorktrees: () => [] } as never,
      ops: { baseUrl: 'http://127.0.0.1:0', configPath: 'unused' },
      config: { enabled: true, sweepIntervalMs: 60_000, pollIntervalMs: 0, directiveAt: 2, rebriefAt: 3, escalateAt: 4, stallThresholdMs: 1_800_000, unchangedRewakeMs: 21_600_000, autopilot: { enabled: false, defaultMode: 'dry-run', rules: {} } },
      skills: [],
      bus,
      now: () => 0,
      setInterval: ((cb: () => void) => { sweep.cb = cb; return 1; }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as never,
      // The PRODUCTION factory, with the real wave reconciler bound the
      // same way main.ts binds it (behavioral composition coverage).
      onDeterministicPass: (context: { trigger: string; wakeInFlight: boolean }) => {
        order.push('hook');
        return createProductionDeterministicPass({
          ledger,
          notifications: { postIncident: () => ({ id: 'seam-notice' }) },
          getWave: () => wave,
        })(context as Parameters<ReturnType<typeof createProductionDeterministicPass>>[0]);
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
    expect(order).toContain('preflight');
    const terminalCount = ledger.listJobEvents(job.id).filter((event) =>
      event.kind === 'job.review-handoff-started' || event.kind === 'job.review-handoff-failed').length;
    // Sweep tick fires the hook again: bounded, no duplicate start (the
    // pending entry is gone after its terminal outcome).
    sweep.cb?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order.filter((entry) => entry === 'hook').length).toBeGreaterThanOrEqual(2);
    expect(requestReview.mock.calls.filter(([input]) => input.fromHandoff !== true)).toHaveLength(1);
    expect(requestReview).toHaveBeenCalledTimes(2); // Initial API arm plus the internal deterministic replay.
    expect(ledger.listJobEvents(job.id).filter((event) =>
      event.kind === 'job.review-handoff-started' || event.kind === 'job.review-handoff-failed')).toHaveLength(terminalCount);
    await wave.shutdown();
    driver.stop();
  }, 30_000);
});

it('P34 real pending original native directive is reconsidered through the production driver seam once without a model wake', async () => {
  const { DirectiveProgressService } = await import('../src/dispatch/directive-progress.js');
  const { DirectiveNativeFixture } = await import('./helpers/directive-native-fixture.js');
  const root = mkdtempSync(join(tmpdir(), 'directive-driver-seam-')); dirs.push(root);
  const db = new LedgerDb(root); const ledger = new LedgerApi(db.handle); const bus = new EventBus();
  const worktrees = new GitReviewPort(root, 'main', 'a'.repeat(40), ledger);
  const job = ledger.addJob({ id: 'original-driver-directive', repo: 'fixture', title: 'original', briefing: 'approved original' }); ledger.setJobStatus(job.id, 'working');
  await worktrees.createJobWorktree({ repoPath: root, jobId: job.id });
  const file = join(root, 'original-native.jsonl'); const native = new DirectiveNativeFixture(file, 'original-driver-minion');
  ledger.registerAgent({ id: 'original-driver-minion', role: 'minion', jobId: job.id, sessionFile: file }); ledger.setAgentState('original-driver-minion', 'idle');
  const row = ledger.beginDirectiveIntent({ jobId: job.id, requestId: 'original-seam-request', directive: 'original approved task', holder: 'gru' }).record;
  ledger.prepareDirectiveTarget(row.requestId, { agentId: 'original-driver-minion', sessionFile: file });
  native.begin('original approved task', { directive: { identity: ledger.directiveTurnIdentity(row.requestId), beforeAdmission: () => {}, onAdmitted: (binding) => { ledger.bindDirectiveNativeAdmission(binding); } } });
  native.end(); native.ceased();
  const notifications = { postIncident: () => ({ id: 'seam-notice' }) }; const spawn = vi.fn(async () => { throw new Error('terminal original must not spawn'); });
  const progress = new DirectiveProgressService({ ledger, worktrees, notifications, signal: new AbortController().signal,
    registry: { getHandle: () => null, spawn, disposeHandle: async () => {} }, pendingProducerBlockers: () => [] });
  let sweep: (() => void) | null = null;
  const driver = new SilasDriver({ ledger: { appendCustomEvent: () => ({ seq: 1 }) } as never, worktrees: { listWorktrees: () => [] } as never,
    slot: { ensure: async () => { throw new Error('no model wake'); }, viewFor: () => null } as never, bus,
    ops: { baseUrl: 'http://127.0.0.1:0', configPath: 'unused' }, skills: [],
    config: { enabled: true, sweepIntervalMs: 60_000, pollIntervalMs: 0, directiveAt: 2, rebriefAt: 3, escalateAt: 4, stallThresholdMs: 1_800_000, unchangedRewakeMs: 21_600_000, autopilot: { enabled: false, defaultMode: 'dry-run', rules: {} } },
    setInterval: ((callback: () => void) => { sweep = callback; return 1; }) as unknown as typeof setInterval, clearInterval: (() => {}) as never,
    onDeterministicPass: createProductionDeterministicPass({ ledger, notifications, getWave: () => undefined, directiveProgress: progress }) });
  try {
    driver.start(); bus.publish({ seq: 1, ts: '0', kind: 'job.delivered', jobId: 'unrelated', agentId: null, roundId: null, lens: null, payload: null });
    await new Promise<void>((resolve) => setImmediate(resolve)); await progress.settled();
    expect(ledger.getDirective(row.requestId)?.state).toBe('settled'); expect(spawn).not.toHaveBeenCalled();
    (sweep as (() => void) | null)?.(); await new Promise<void>((resolve) => setImmediate(resolve)); await progress.settled();
    expect(ledger.listJobEventsByKinds(job.id, ['job.delivered'])).toHaveLength(1);
  } finally { driver.stop(); await progress.dispose(); db.close(); }
});

it('P35 the production pass resumes an open canceled-request closeout and leaves a stopped one with an unchanged blocker fingerprint alone (#523)', async () => {
  const repo = makeFixtureRepo('seam-closeout'); repos.push(repo);
  const root = mkdtempSync(join(tmpdir(), 'seam-closeout-port-')); dirs.push(root);
  const dbDir = mkdtempSync(join(tmpdir(), 'seam-closeout-db-')); dirs.push(dbDir);
  const db = new LedgerDb(dbDir); const ledger = new LedgerApi(db.handle);
  const port = new GitReviewPort(root, 'main', repo.head(), ledger);
  try {
    const defer = async (jobId: string, requestId: string): Promise<void> => {
      ledger.addJob({ id: jobId, repo: 'fixture', title: jobId, briefing: `briefing for ${jobId}` });
      ledger.setJobStatus(jobId, 'working');
      await port.createJobWorktree({ repoPath: repo.path, jobId });
      ledger.beginRebriefIntent({ jobId, note: 'redo the work', holder: 'silas-ops', requestId });
      expect(ledger.claimDirectiveDispatch(requestId)).toBe(true);
      const start = ledger.latestJobEventByRequestId(jobId, 'silas.directive-dispatch-started', requestId)!;
      ledger.recordDirectiveDispatchDeferral(ledger.directiveTurnIdentity(requestId), start.seq, 'a supervised producer held the lane');
    };
    await defer('job-open', 'req-open'); await defer('job-stopped', 'req-stopped');
    let release = (): void => {};
    let hook: ((step: string, jobId: string) => void) | undefined;
    const closeout = new CanceledRequestCloseout({ ledger, worktrees: port, pendingProducerBlockers: () => [],
      afterStep: (step, intent) => hook?.(step, intent.jobId) });
    hook = (step, jobId) => { if (step === 'intent' && jobId === 'job-open') throw new Error('crash after S1'); };
    expect(() => closeout.requestBinning('job-open', { status: 'binned', by: 'gru' })).toThrow('crash after S1');
    hook = (step, jobId) => { if (step === 'intent' && jobId === 'job-stopped') release = ledger.beginJobAdmission('job-stopped', 'late admission'); };
    expect(closeout.requestBinning('job-stopped', { status: 'binned', by: 'gru' })?.status).toBe(409);
    hook = undefined;
    expect(ledger.latestCloseoutForJob('job-open')?.state).toBe('open');
    expect(ledger.latestCloseoutForJob('job-stopped')?.state).toBe('stopped');
    const order: string[] = [];
    const pass = createProductionDeterministicPass({ ledger, notifications: { postIncident: () => ({ id: 'seam-notice' }) }, getWave: () => undefined,
      directiveProgress: { reconsider: () => { order.push('reconsider'); } },
      closeout: { resumePending: () => { order.push('resume'); return closeout.resumePending(); } } });
    const stoppedEvents = ledger.listJobEvents('job-stopped').length;
    pass({ trigger: 'sweep', wakeInFlight: false } as never);
    // The reconsideration runs first; the open intent completes; the stopped one is untouched.
    expect(order).toEqual(['reconsider', 'resume']);
    expect(ledger.latestCloseoutForJob('job-open')).toMatchObject({ state: 'complete', generation: 1 });
    expect(ledger.getJob('job-open')?.status).toBe('binned');
    expect(ledger.latestCloseoutForJob('job-stopped')?.state).toBe('stopped');
    expect(ledger.getJob('job-stopped')?.status).toBe('working');
    expect(ledger.listJobEvents('job-stopped')).toHaveLength(stoppedEvents);
    // Its blockers change (the admission is released): the next pass completes it.
    release();
    pass({ trigger: 'sweep', wakeInFlight: false } as never);
    expect(ledger.latestCloseoutForJob('job-stopped')).toMatchObject({ state: 'complete' });
    expect(ledger.getJob('job-stopped')?.status).toBe('binned');
  } finally { db.close(); }
});
