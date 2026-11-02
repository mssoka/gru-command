import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { JobStatus } from '../src/ledger/states.js';
import { createDurableReconcileHook, createProductionDeterministicPass } from '../src/dispatch/durable-reconcile.js';
import { NotificationCenter } from '../src/notifications/center.js';

/**
 * Issue #560 (#503 P2): an initial dispatch interrupted between its recorded
 * handoff and its first minion must surface as blocked — durable note + ONE
 * action-required card — and never be re-dispatched, swept or mutated.
 *
 * A1 drives the PRODUCTION hook (`createDurableReconcileHook`), so the same
 * test is the fail-before witness at the base: driven through the new module
 * alone it would only prove the module exists. Everything the base lacks is
 * reached through the hook or dynamically imported, so the file still
 * collects there and the case fails by assertion, never by import.
 */

const cleanupDirs: string[] = [];
const liveDbs: LedgerDb[] = [];
afterEach(() => {
  while (liveDbs.length > 0) liveDbs.pop()!.close();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

interface Harness {
  readonly ledger: LedgerApi;
  readonly notifications: NotificationCenter;
}

function boot(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gru-interrupted-dispatch-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  liveDbs.push(db);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  return { ledger, notifications: new NotificationCenter({ ledger, bus }) };
}

/** The crash shape #560 reports on: the job row, the recorded handoff, the
 * move to `working`, an ACTIVE job lane (created before the spawn) and its
 * bootstrap marker — and no agent, no spawn event, ever. Production names
 * the lane with the job id (`worktrees/manager.ts` `registerWorktree`), so
 * the fixture does too; a job-id-keyed guard must not silently miss it. */
function seedInterruptedDispatch(h: Harness, id: string, title = `job ${id}`): string {
  h.ledger.addJob({ id, repo: 'demo', title, briefing: 'b' });
  h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId: id, payload: { repo: 'demo', repoPath: '/tmp/demo' } });
  h.ledger.setJobStatus(id, 'working');
  h.ledger.registerWorktree({
    id,
    kind: 'job',
    repoPath: '/tmp/demo',
    repoName: 'demo',
    path: `/tmp/demo-${id}`,
    sha: 'a'.repeat(40),
    jobId: id,
  });
  h.ledger.appendCustomEvent({ kind: 'worktree.bootstrapped', jobId: id, payload: { id } });
  return id;
}

/** The report shape this suite reads out of the production hook. Declared
 * locally (not imported from the new module) so the file collects on the
 * pre-change base. */
interface InterruptedSection {
  readonly examined: number;
  readonly truncated?: boolean;
  readonly blocked: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: number;
}
interface PassReport {
  readonly ok?: boolean;
  readonly failures?: number;
  readonly advanced?: number;
  readonly interruptedDispatches?: InterruptedSection;
}

/** The EXACT production deterministic pass main.ts wires. */
function runPass(h: Harness): PassReport {
  return createDurableReconcileHook({ ledger: h.ledger, notifications: h.notifications })({
    trigger: 'sweep',
    wakeInFlight: false,
  }) as unknown as PassReport;
}

function cards(h: Harness, jobId: string) {
  return h.ledger.listNotifications({ limit: 100 }).filter((row) => row.kind === `dispatch.interrupted.${jobId}`);
}

function candidateIds(h: Harness): readonly string[] {
  return h.ledger.listInterruptedDispatchCandidates(50).map((job) => job.id);
}

/** The SQL pre-filter excluded the row: it is never a candidate and neither
 * layer writes anything. */
function expectExcludedBySql(h: Harness, jobId: string, status: JobStatus = 'working'): void {
  expect(candidateIds(h)).not.toContain(jobId);
  const report = runPass(h);
  expect(report.interruptedDispatches?.blocked).toEqual([]);
  expect(h.ledger.getJob(jobId)?.status).toBe(status);
  expect(cards(h, jobId)).toHaveLength(0);
}

/** The SQL pre-filter returned the row and the SERVICE's guard is what
 * skipped it (the ownership facts SQL cannot see). */
async function expectSkippedByService(h: Harness, jobId: string, reason: string): Promise<void> {
  expect(candidateIds(h)).toContain(jobId);
  const { reconcileInterruptedDispatches } = await import('../src/dispatch/interrupted-dispatch.js');
  const report = reconcileInterruptedDispatches({ ledger: h.ledger, notifications: h.notifications });
  expect(report.blocked).toEqual([]);
  const skip = report.skipped.find((entry) => entry.startsWith(`${jobId}: `));
  expect(skip, 'the service guard names the job it skipped').toBeDefined();
  expect(skip).toContain(reason);
  expect(h.ledger.getJob(jobId)?.status).toBe('working');
  expect(cards(h, jobId)).toHaveLength(0);
}

/** The lane-less crash shape of issue #583: the job row, the recorded
 * handoff and the move to `working` — the process died before
 * `registerWorktree`, so there is no lane row and no worker. Durably
 * identical for an initial dispatch and a continuation. */
function seedLaneLessInterruptedDispatch(h: Harness, id: string, title = `job ${id}`): string {
  h.ledger.addJob({ id, repo: 'demo', title, briefing: 'b' });
  h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId: id, payload: { repo: 'demo', repoPath: '/tmp/demo' } });
  h.ledger.setJobStatus(id, 'working');
  return id;
}

/** The report shape the boot lane-less pass returns. Declared locally (not
 * imported from the changed module) so the file still collects on the
 * pre-change base. */
interface LaneLessReport {
  readonly examined: number;
  readonly truncated: boolean;
  readonly blocked: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: number;
}

/** The boot pass's discriminated result: `absent` means the pre-change base
 * has no lane-less pass at all. Tests assert `kind` and only then read the
 * optional report, so a missing export fails by assertion — never by a
 * TypeError from dereferencing `undefined`. */
interface BootPassRun {
  readonly kind: 'absent' | 'ran';
  readonly report?: LaneLessReport;
}

/** The EXACT boot entry point main.ts wires (issue #583), reached by dynamic
 * import: the base has no such export, so this helper returns `absent`. */
async function runBootPass(h: Harness, opts: { readonly limit?: number } = {}): Promise<BootPassRun> {
  const module = (await import('../src/dispatch/interrupted-dispatch.js')) as unknown as Record<string, unknown>;
  const pass = module['reconcileInterruptedLaneLessDispatches'];
  if (typeof pass !== 'function') return { kind: 'absent' };
  const report = (
    pass as (
      deps: { readonly ledger: LedgerApi; readonly notifications: NotificationCenter },
      options: { readonly limit?: number },
    ) => LaneLessReport
  )({ ledger: h.ledger, notifications: h.notifications }, opts);
  return { kind: 'ran', report };
}

describe('interrupted initial dispatch (issue #560)', () => {
  it('A1: blocks an initial dispatch interrupted before any minion, once, and leaves the lane alone', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-interrupted', 'Fix the interrupted thing');

    const report = runPass(h);

    // The obligation: blocked, with the note wording an operator can act on.
    const job = h.ledger.getJob(jobId);
    expect(job?.status).toBe('blocked');
    expect(job?.note).toContain('no worker ever started');
    const card = h.ledger.findNotificationByKind(`dispatch.interrupted.${jobId}`, 'any');
    expect(card?.routing).toBe('action-required');
    expect(card?.title).toContain('Fix the interrupted thing');
    expect(card?.detail).toContain(jobId);
    expect(card?.detail).toContain('no minion ever started');
    expect(report.interruptedDispatches?.blocked).toEqual([jobId]);

    // A3: no dispatch, no sweep, no worktree mutation — the lane is exactly
    // as the crash left it, and no worker evidence was fabricated.
    expect(h.ledger.listWorktrees({ jobId }).map((lane) => lane.status)).toEqual(['active']);
    expect(h.ledger.latestJobEvent(jobId, 'job.minion-spawned')).toBeNull();
    expect(h.ledger.listEvents({ limit: 100 }).filter((event) => event.kind === 'worktree.status')).toHaveLength(0);

    // A second pass adds no card, no note and no status write.
    const eventsBefore = h.ledger.listEvents({ limit: 200 }).length;
    const second = runPass(h);
    expect(second.interruptedDispatches?.examined).toBe(0);
    expect(second.interruptedDispatches?.blocked).toEqual([]);
    expect(second.advanced).toBe(0);
    expect(h.ledger.listEvents({ limit: 200 }).length).toBe(eventsBefore);
    expect(cards(h, jobId)).toHaveLength(1);
  });

  it('A1 re-interruption: one card per job until the existing one is resolved', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-again');
    runPass(h);
    const first = h.ledger.findNotificationByKind(`dispatch.interrupted.${jobId}`, 'any');
    expect(first).not.toBeNull();

    // Unresolved: later passes never post a second card.
    runPass(h);
    expect(cards(h, jobId)).toHaveLength(1);

    // Resolved, then the lane re-arms and interrupts again: a new card.
    if (first === null) throw new Error('the first interruption card is missing');
    h.ledger.resolveNotificationById(first.id, 'gru');
    h.ledger.setJobStatus(jobId, 'working');
    const report = runPass(h);
    expect(report.interruptedDispatches?.blocked).toEqual([jobId]);
    expect(cards(h, jobId)).toHaveLength(2);
    expect(h.ledger.getJob(jobId)?.status).toBe('blocked');
  });

  it('A2: a top-level minion agent row keeps the job out of the candidate set', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-agent');
    h.ledger.registerAgent({ id: 'minion-agent', role: 'minion', jobId, parentage: 'top-level' });
    expectExcludedBySql(h, jobId);
  });

  it('A2: a job.minion-spawned event keeps the job out of the candidate set', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-spawned');
    h.ledger.appendCustomEvent({ kind: 'job.minion-spawned', jobId, payload: {} });
    expectExcludedBySql(h, jobId);
  });

  it('A2: a parked job is never a candidate', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-parked');
    h.ledger.setJobStatus(jobId, 'parked');
    expectExcludedBySql(h, jobId, 'parked');
  });

  it('A2: a delivered job is never a candidate', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-delivered');
    h.ledger.setJobStatus(jobId, 'delivered');
    expectExcludedBySql(h, jobId, 'delivered');
  });

  it('A2: a binned job is never a candidate', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-binned');
    h.ledger.setJobStatus(jobId, 'binned');
    expectExcludedBySql(h, jobId, 'binned');
  });

  it('A2: a swept lane is never a candidate', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-swept');
    h.ledger.setWorktreeStatus(jobId, 'swept');
    expectExcludedBySql(h, jobId);
  });

  it('A2: a paused lane is never a candidate (live processes, not an interruption)', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-paused');
    h.ledger.setWorktreeStatus(jobId, 'paused');
    expectExcludedBySql(h, jobId);
  });

  it('A2: an in-flight dispatch admission is skipped by the service guard', async () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-admitted');
    const release = h.ledger.beginJobAdmission(jobId, 'initial dispatch');
    try {
      await expectSkippedByService(h, jobId, 'in-flight dispatch admission');
    } finally {
      release();
    }
  });

  it('A2: a live directive that owns the lane is skipped by the service guard', async () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-directive');
    h.ledger.beginDirectiveIntent({ jobId, directive: 'continue', holder: 'silas-ops', requestId: 'req-directive' });
    await expectSkippedByService(h, jobId, 'live directive request');
  });

  it('A2: an open provider wait is skipped by the service guard', async () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-provider');
    h.ledger.recordProviderWait({
      id: 'wait-provider',
      routeKey: 'route-provider',
      provider: 'p',
      model: 'm',
      endpoint: 'e',
      credentialFingerprint: 'fp',
      waiterKind: 'job-minion',
      jobId,
      agentId: null,
      slotId: null,
      sessionFile: null,
      continuation: null,
      jobStatusAtEstablishment: 'working',
      lineageKey: null,
      incidentId: 'incident-provider',
      incidentGeneration: 1,
      reasonClass: 'temporary-limit',
    });
    await expectSkippedByService(h, jobId, 'open provider wait');
  });

  it('A2: a pipeline entry still admitting is skipped by the service guard', async () => {
    const h = boot();
    // The pipeline uses the entry id as the job id, and the entry must be
    // accepted before the job exists.
    h.ledger.enqueuePipelineEntry({ id: 'job-pipelined', repoPath: '/tmp/demo', title: 't', briefing: 'b' });
    h.ledger.claimPipelineEntry({ id: 'job-pipelined', holder: 'silas-pipeline' });
    const jobId = seedInterruptedDispatch(h, 'job-pipelined');
    await expectSkippedByService(h, jobId, 'the pipeline owns this dispatch');
  });

  it('A2: an unsettled verification run is skipped by the service guard', async () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-verifying');
    h.ledger.appendCustomEvent({ kind: 'verification.requested', jobId, payload: { run_id: 'run-1' } });
    await expectSkippedByService(h, jobId, 'unsettled verification run');
  });

  it('the pure verdict blocks the crash facts and names every single-fact exclusion', async () => {
    const { interruptedDispatchVerdict } = await import('../src/dispatch/interrupted-dispatch.js');
    interface Evidence {
      readonly status: JobStatus;
      readonly workerStarted: boolean;
      readonly handoff: boolean;
      readonly activeLane: boolean;
      readonly admissions: readonly string[];
      readonly laneOwner: string | null;
      readonly openProviderWaits: number;
      readonly pipelineAdmitting: boolean;
      readonly unsettledVerification: boolean;
    }
    const crash: Evidence = {
      status: 'working',
      workerStarted: false,
      handoff: true,
      activeLane: true,
      admissions: [],
      laneOwner: null,
      openProviderWaits: 0,
      pipelineAdmitting: false,
      unsettledVerification: false,
    };
    expect(interruptedDispatchVerdict(crash)).toEqual({ block: true, reason: null });

    const flips: readonly (readonly [Partial<Evidence>, string])[] = [
      [{ status: 'blocked' }, 'not working'],
      [{ admissions: ['initial dispatch'] }, 'in-flight dispatch admission'],
      [{ activeLane: false }, 'no active job lane'],
      [{ workerStarted: true }, 'a minion started'],
      [{ handoff: false }, 'no job.handoff event'],
      [{ laneOwner: 'job "x" has a live directive request' }, 'live directive request'],
      [{ openProviderWaits: 1 }, 'open provider wait'],
      [{ pipelineAdmitting: true }, 'the pipeline owns this dispatch'],
      [{ unsettledVerification: true }, 'unsettled verification run'],
    ];
    for (const [flip, reason] of flips) {
      const verdict = interruptedDispatchVerdict({ ...crash, ...flip });
      expect(verdict.block, `one flipped fact must not block: ${reason}`).toBe(false);
      expect(verdict.reason).toContain(reason);
    }
  });

  it('bounds one pass to the limit, resumes from the head, and never duplicates a card', async () => {
    const h = boot();
    const jobIds = ['job-page-a', 'job-page-b', 'job-page-c'].map((id) => seedInterruptedDispatch(h, id));
    const { reconcileInterruptedDispatches } = await import('../src/dispatch/interrupted-dispatch.js');
    const deps = { ledger: h.ledger, notifications: h.notifications };

    // ONE bounded query per pass (no cursor): blocked rows leave the set, so
    // the next pass reaches the tail from the head.
    const first = reconcileInterruptedDispatches(deps, { limit: 2 });
    expect(first.examined).toBe(2);
    expect(first.truncated).toBe(true);
    expect(first.blocked).toHaveLength(2);
    const second = reconcileInterruptedDispatches(deps, { limit: 2 });
    expect(second.examined).toBe(1);
    expect(second.truncated).toBe(false);
    expect(second.blocked).toHaveLength(1);
    expect([...first.blocked, ...second.blocked].sort()).toEqual([...jobIds].sort());
    for (const jobId of jobIds) expect(cards(h, jobId)).toHaveLength(1);
  });

  it('reports a failed write through the pass failure channel and retries it next pass', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-throw');
    const note = vi.spyOn(h.ledger, 'noteJob').mockImplementation(() => {
      throw new Error('ledger is read-only');
    });
    try {
      const report = runPass(h);
      expect(report.interruptedDispatches?.failed).toBe(1);
      expect(report.failures).toBe(1);
      expect(report.ok).toBe(false);
      expect(h.ledger.getJob(jobId)?.status).toBe('working');
      expect(cards(h, jobId)).toHaveLength(0);
    } finally {
      note.mockRestore();
    }
    // The note-first write order is what makes this retry possible.
    const retried = runPass(h);
    expect(retried.interruptedDispatches?.blocked).toEqual([jobId]);
    expect(h.ledger.getJob(jobId)?.status).toBe('blocked');
  });

  it('reports a status write that throws after the note as failed, and retries it next pass', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-status-throw');
    const status = vi.spyOn(h.ledger, 'setJobStatus').mockImplementation(() => {
      throw new Error('status write lost');
    });
    try {
      const report = runPass(h);
      // The card is already posted (note → card → status), and the row is
      // still `working`, so the next pass can retry it as the log promises.
      expect(report.interruptedDispatches?.failed).toBe(1);
      expect(report.failures).toBe(1);
      expect(report.ok).toBe(false);
      expect(h.ledger.getJob(jobId)?.status).toBe('working');
      expect(candidateIds(h)).toContain(jobId);
      expect(h.ledger.getJob(jobId)?.note).toContain('no worker ever started');
      expect(cards(h, jobId)).toHaveLength(1);
    } finally {
      status.mockRestore();
    }
    const retried = runPass(h);
    expect(retried.interruptedDispatches?.blocked).toEqual([jobId]);
    expect(h.ledger.getJob(jobId)?.status).toBe('blocked');
    // The deduped card was never posted twice.
    expect(cards(h, jobId)).toHaveLength(1);
  });
});

/**
 * Issue #583 (#503 P2): the OTHER half of the same window. A dispatch
 * interrupted BEFORE its lane row — initial or continuation — has no
 * candidate for the lane-required pass, and a live pass could not tell it
 * from a dispatch still starting, so the witness is a boot-only pass. These
 * cases drive the boot entry point through a dynamic import: the base has no
 * such export, and B1's first assertion is ledger-level, so the pre-change
 * base REDs by assertion, never by a TypeError.
 */
describe('interrupted dispatch without a lane (issue #583)', () => {
  it('B1: a boot pass blocks a working job that crashed before its lane row', async () => {
    const h = boot();
    const jobId = seedLaneLessInterruptedDispatch(h, 'job-no-lane', 'Fix the lane-less thing');

    const run = await runBootPass(h);

    // FIRST assertion is ledger-level on purpose: against the pre-change
    // base the row is still `working`, so this REDs as an AssertionError
    // (`expected 'working' to be 'blocked'`) — never as a TypeError from
    // dereferencing a pass the base does not export.
    expect(h.ledger.getJob(jobId)?.status).toBe('blocked');
    expect(run.kind).toBe('ran');
    const job = h.ledger.getJob(jobId);
    expect(job?.note).toContain('no worker ever started');
    // The class is the whole interrupted window: initial OR continuation.
    expect(job?.note).toContain('initial or continuation');
    const card = h.ledger.findNotificationByKind(`dispatch.interrupted.${jobId}`, 'any');
    expect(card?.routing).toBe('action-required');
    expect(card?.title).toContain('Fix the lane-less thing');
    expect(card?.detail).toContain(jobId);
    expect(card?.detail).toContain('never reached a lane');
    expect(run.report?.blocked).toEqual([jobId]);

    // Nothing touched the worktree table, and no worker evidence appeared.
    expect(h.ledger.listWorktrees({ jobId })).toEqual([]);
    expect(h.ledger.latestJobEvent(jobId, 'job.minion-spawned')).toBeNull();
    expect(h.ledger.listEvents({ limit: 200 }).filter((event) => event.kind === 'worktree.status')).toHaveLength(0);

    // A second boot adds no card, no note and no status write.
    const eventsBefore = h.ledger.listEvents({ limit: 200 }).length;
    const second = await runBootPass(h);
    expect(second.report?.examined).toBe(0);
    expect(second.report?.blocked).toEqual([]);
    expect(h.ledger.listEvents({ limit: 200 }).length).toBe(eventsBefore);
    expect(cards(h, jobId)).toHaveLength(1);
  });

  it('B2: the live deterministic pass never sees a lane-less dispatch (the SQL excludes it, not a guard)', () => {
    const h = boot();
    const jobId = seedLaneLessInterruptedDispatch(h, 'job-no-lane-live');
    // The EXACT production deterministic pass main.ts wires for the Silas
    // trigger: the lane-less class must not be reachable from it at all.
    const report = createProductionDeterministicPass({
      ledger: h.ledger,
      notifications: h.notifications,
      getWave: () => undefined,
    })({ trigger: 'sweep', wakeInFlight: false }) as unknown as PassReport;

    // Call-site isolation: the candidate set itself excludes the shape, so
    // no service guard is even consulted — a live dispatch at the same
    // durable shape is never blocked.
    expect(report.interruptedDispatches?.examined).toBe(0);
    expect(report.interruptedDispatches?.blocked).toEqual([]);
    expect(h.ledger.getJob(jobId)?.status).toBe('working');
    expect(h.ledger.getJob(jobId)?.note).toBeNull();
    expect(cards(h, jobId)).toHaveLength(0);
  });

  it('B3: a paused or a swept lane keeps the job out of the lane-less candidate set', async () => {
    const h = boot();
    const paused = seedLaneLessInterruptedDispatch(h, 'job-no-lane-paused');
    h.ledger.registerWorktree({
      id: paused,
      kind: 'job',
      repoPath: '/tmp/demo',
      repoName: 'demo',
      path: `/tmp/demo-${paused}`,
      sha: 'a'.repeat(40),
      jobId: paused,
    });
    h.ledger.setWorktreeStatus(paused, 'paused');
    const swept = seedLaneLessInterruptedDispatch(h, 'job-no-lane-swept');
    h.ledger.registerWorktree({
      id: swept,
      kind: 'job',
      repoPath: '/tmp/demo',
      repoName: 'demo',
      path: `/tmp/demo-${swept}`,
      sha: 'a'.repeat(40),
      jobId: swept,
    });
    h.ledger.setWorktreeStatus(swept, 'swept');

    const run = await runBootPass(h);

    // ANY worktree row excludes the job, so neither a live-process pause nor
    // a retained sweep is ever claimed by the lane-less class.
    expect(run.kind).toBe('ran');
    expect(run.report?.examined).toBe(0);
    expect(run.report?.blocked).toEqual([]);
    for (const jobId of [paused, swept]) {
      expect(h.ledger.getJob(jobId)?.status).toBe('working');
      expect(cards(h, jobId)).toHaveLength(0);
    }
  });

  it('B4: a top-level minion, a spawn event or any agent row keeps the job out', async () => {
    const h = boot();
    const topLevel = seedLaneLessInterruptedDispatch(h, 'job-no-lane-top');
    h.ledger.registerAgent({ id: 'agent-lane-less-top', role: 'minion', jobId: topLevel, parentage: 'top-level' });
    const spawned = seedLaneLessInterruptedDispatch(h, 'job-no-lane-spawned');
    h.ledger.appendCustomEvent({ kind: 'job.minion-spawned', jobId: spawned, payload: {} });
    // A child row is not a started worker, but it IS a job-owned agent: the
    // continuation fence's own notion, which the broad agent clause excludes.
    const child = seedLaneLessInterruptedDispatch(h, 'job-no-lane-child');
    h.ledger.registerAgent({ id: 'agent-lane-less-child', role: 'minion', jobId: child, parentage: 'child' });

    const run = await runBootPass(h);

    expect(run.kind).toBe('ran');
    expect(run.report?.examined).toBe(0);
    expect(run.report?.blocked).toEqual([]);
    for (const jobId of [topLevel, spawned, child]) {
      expect(h.ledger.getJob(jobId)?.status).toBe('working');
      expect(cards(h, jobId)).toHaveLength(0);
    }
  });

  it('B5: the service guards skip a re-brief, a provider wait, an unsettled verification and the pipeline claim', async () => {
    const h = boot();
    const rebrief = seedLaneLessInterruptedDispatch(h, 'job-no-lane-rebrief');
    h.ledger.beginPendingRebrief({ jobId: rebrief, note: 'same blocker; try differently', briefing: 'the original contract' });
    const provider = seedLaneLessInterruptedDispatch(h, 'job-no-lane-provider');
    h.ledger.recordProviderWait({
      id: 'wait-lane-less',
      routeKey: 'route-lane-less',
      provider: 'p',
      model: 'm',
      endpoint: 'e',
      credentialFingerprint: 'fp',
      waiterKind: 'job-minion',
      jobId: provider,
      agentId: null,
      slotId: null,
      sessionFile: null,
      continuation: null,
      jobStatusAtEstablishment: 'working',
      lineageKey: null,
      incidentId: 'incident-lane-less',
      incidentGeneration: 1,
      reasonClass: 'temporary-limit',
    });
    const verifying = seedLaneLessInterruptedDispatch(h, 'job-no-lane-verifying');
    h.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: verifying, payload: { run_id: 'run-lane-less' } });
    // The pipeline claims its entry BEFORE awaiting dispatch and finalizes
    // only after it returns, so an `admitting` entry is the boot-time fence
    // for a pipeline-owned dispatch in exactly this window.
    h.ledger.enqueuePipelineEntry({ id: 'job-no-lane-pipelined', repoPath: '/tmp/demo', title: 't', briefing: 'b' });
    h.ledger.claimPipelineEntry({ id: 'job-no-lane-pipelined', holder: 'silas-pipeline' });
    const pipelined = seedLaneLessInterruptedDispatch(h, 'job-no-lane-pipelined');

    const run = await runBootPass(h);

    expect(run.kind).toBe('ran');
    expect(run.report?.examined).toBe(4);
    expect(run.report?.blocked).toEqual([]);
    const skipped = run.report?.skipped ?? [];
    expect(skipped).toHaveLength(4);
    const reasonFor = (jobId: string) => skipped.find((entry) => entry.startsWith(`${jobId}: `));
    expect(reasonFor(rebrief)).toContain('pending re-brief that owns the lane');
    expect(reasonFor(provider)).toContain('open provider wait');
    expect(reasonFor(verifying)).toContain('unsettled verification run');
    expect(reasonFor(pipelined)).toContain('the pipeline owns this dispatch');
    for (const jobId of [rebrief, provider, verifying, pipelined]) {
      expect(h.ledger.getJob(jobId)?.status).toBe('working');
      expect(cards(h, jobId)).toHaveLength(0);
    }
  });

  it('B6: the pure lane-less verdict blocks the crash facts and names every single-fact exclusion', async () => {
    const module = (await import('../src/dispatch/interrupted-dispatch.js')) as unknown as Record<string, unknown>;
    const exported = module['interruptedDispatchWithoutLaneVerdict'];
    expect(typeof exported, 'interruptedDispatchWithoutLaneVerdict is exported').toBe('function');
    interface Evidence {
      readonly status: JobStatus;
      readonly workerStarted: boolean;
      readonly handoff: boolean;
      readonly laneRowPresent: boolean;
      readonly admissions: readonly string[];
      readonly laneOwner: string | null;
      readonly openProviderWaits: number;
      readonly pipelineAdmitting: boolean;
      readonly unsettledVerification: boolean;
    }
    const verdictOf = exported as (evidence: Evidence) => { readonly block: boolean; readonly reason: string | null };
    const crash: Evidence = {
      status: 'working',
      workerStarted: false,
      handoff: true,
      laneRowPresent: false,
      admissions: [],
      laneOwner: null,
      openProviderWaits: 0,
      pipelineAdmitting: false,
      unsettledVerification: false,
    };
    expect(verdictOf(crash)).toEqual({ block: true, reason: null });

    const flips: readonly (readonly [Partial<Evidence>, string])[] = [
      [{ status: 'blocked' }, 'not working'],
      [{ admissions: ['initial dispatch'] }, 'in-flight dispatch admission'],
      [{ laneRowPresent: true }, 'a worktree row exists'],
      [{ workerStarted: true }, 'a minion started'],
      [{ handoff: false }, 'no job.handoff event'],
      [{ laneOwner: 'job "x" has a live directive request' }, 'live directive request'],
      [{ openProviderWaits: 1 }, 'open provider wait'],
      [{ pipelineAdmitting: true }, 'the pipeline owns this dispatch'],
      [{ unsettledVerification: true }, 'unsettled verification run'],
    ];
    for (const [flip, reason] of flips) {
      const verdict = verdictOf({ ...crash, ...flip });
      expect(verdict.block, `one flipped fact must not block: ${reason}`).toBe(false);
      expect(verdict.reason).toContain(reason);
    }
  });

  it('B7: a status write that throws after note and card fails once and retries with one card', async () => {
    const h = boot();
    const jobId = seedLaneLessInterruptedDispatch(h, 'job-no-lane-status-throw');
    const status = vi.spyOn(h.ledger, 'setJobStatus').mockImplementation(() => {
      throw new Error('status write lost');
    });
    try {
      const run = await runBootPass(h);
      expect(run.kind).toBe('ran');
      expect(run.report?.failed).toBe(1);
      expect(run.report?.blocked).toEqual([]);
      // Note and card already landed; the row is still a candidate.
      expect(h.ledger.getJob(jobId)?.status).toBe('working');
      expect(h.ledger.getJob(jobId)?.note).toContain('no worker ever started');
      expect(cards(h, jobId)).toHaveLength(1);
    } finally {
      status.mockRestore();
    }
    const retried = await runBootPass(h);
    expect(retried.report?.blocked).toEqual([jobId]);
    expect(h.ledger.getJob(jobId)?.status).toBe('blocked');
    // The deduped card was never posted twice.
    expect(cards(h, jobId)).toHaveLength(1);
  });

  it('B8: a lane row that lands between two boot passes keeps the job out for good', async () => {
    const h = boot();
    const jobId = seedLaneLessInterruptedDispatch(h, 'job-no-lane-later');
    const first = await runBootPass(h);
    expect(first.kind).toBe('ran');
    expect(first.report?.blocked).toEqual([jobId]);

    // Re-armed, and this time the dispatch reaches its lane row: the job
    // leaves the lane-less class (the lane-required pass owns it now).
    h.ledger.setJobStatus(jobId, 'working');
    h.ledger.registerWorktree({
      id: jobId,
      kind: 'job',
      repoPath: '/tmp/demo',
      repoName: 'demo',
      path: `/tmp/demo-${jobId}`,
      sha: 'a'.repeat(40),
      jobId,
    });
    const second = await runBootPass(h);
    expect(second.kind).toBe('ran');
    expect(second.report?.examined).toBe(0);
    expect(second.report?.blocked).toEqual([]);
    expect(h.ledger.getJob(jobId)?.status).toBe('working');
    expect(cards(h, jobId)).toHaveLength(1);
  });

  it('B9: the continuation shape — an unresolved creation-continuation request, no lane — is blocked once', async () => {
    const h = boot();
    const jobId = 'job-no-lane-continuation';
    // The continuation's own repo path must resolve for the request to be
    // accepted; the job records the path's leaf as its repository.
    const repoRoot = mkdtempSync(join(tmpdir(), 'gru-continuation-repo-'));
    cleanupDirs.push(repoRoot);
    const handoffRepoPath = join(repoRoot, 'demo');
    mkdirSync(handoffRepoPath);
    h.ledger.addJob({ id: jobId, repo: 'demo', title: 'Continue the interrupted thing', briefing: 'b' });
    const handoff = h.ledger.appendCustomEvent({
      kind: 'job.handoff',
      jobId,
      payload: { repo: 'demo', repoPath: handoffRepoPath },
    });
    // A continuation is accepted only against a blocked, workerless lane; it
    // writes no second handoff and sets `working` itself.
    h.ledger.setJobStatus(jobId, 'blocked');
    const branch = `gru/${jobId}`;
    const baseSha = 'a'.repeat(40);
    const tokenSha256 = 'b'.repeat(64);
    const settlement = h.ledger.recordCreationProducerSettlement({
      jobId,
      branch,
      sha: baseSha,
      tokenSha256,
      pid: 4242,
      exitCode: 0,
      signal: null,
    });
    const accepted = h.ledger.acceptCreationContinuation({
      jobId,
      requestId: 'req-583-continuation',
      payloadSha256: createHash('sha256').update('continuation payload').digest('hex'),
      handoffSeq: handoff.seq,
      briefingSha256: createHash('sha256').update('b', 'utf8').digest('hex'),
      handoffRepoPath,
      repoPath: realpathSync(handoffRepoPath),
      branch,
      baseSha,
      baseSource: 'local-head-fallback',
      producerSettlementSeq: settlement.seq,
      receiptTokenSha256: tokenSha256,
    });
    expect(accepted.timeline.state).toBe('accepted');
    // The continuation dispatch starts and dies before its lane row.
    h.ledger.setJobStatus(jobId, 'working');

    const run = await runBootPass(h);

    expect(h.ledger.getJob(jobId)?.status).toBe('blocked');
    expect(run.kind).toBe('ran');
    expect(run.report?.blocked).toEqual([jobId]);
    expect(h.ledger.getJob(jobId)?.note).toContain('initial or continuation');
    expect(cards(h, jobId)).toHaveLength(1);
    // The pass never touches worktrees, and the request stays unresolved.
    expect(h.ledger.listWorktrees({ jobId })).toEqual([]);
    expect(h.ledger.getCreationContinuation(jobId, 'req-583-continuation')?.state).toBe('accepted');
  });
});
