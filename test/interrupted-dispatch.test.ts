import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { JobStatus } from '../src/ledger/states.js';
import { createDurableReconcileHook } from '../src/dispatch/durable-reconcile.js';
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
 * bootstrap marker — and no agent, no spawn event, ever. */
function seedInterruptedDispatch(h: Harness, id: string, title = `job ${id}`): string {
  h.ledger.addJob({ id, repo: 'demo', title, briefing: 'b' });
  h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId: id, payload: { repo: 'demo', repoPath: '/tmp/demo' } });
  h.ledger.setJobStatus(id, 'working');
  h.ledger.registerWorktree({
    id: `lane-${id}`,
    kind: 'job',
    repoPath: '/tmp/demo',
    repoName: 'demo',
    path: `/tmp/demo-${id}`,
    sha: 'a'.repeat(40),
    jobId: id,
  });
  h.ledger.appendCustomEvent({ kind: 'worktree.bootstrapped', jobId: id, payload: { id: `lane-${id}` } });
  return id;
}

/** The report shape this suite reads out of the production hook. Declared
 * locally (not imported from the new module) so the file collects on the
 * pre-change base. */
interface InterruptedSection {
  readonly examined: number;
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
    h.ledger.setWorktreeStatus(`lane-${jobId}`, 'swept');
    expectExcludedBySql(h, jobId);
  });

  it('A2: a paused lane is never a candidate (live processes, not an interruption)', () => {
    const h = boot();
    const jobId = seedInterruptedDispatch(h, 'job-paused');
    h.ledger.setWorktreeStatus(`lane-${jobId}`, 'paused');
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

  it('pages through the candidates under a limit and never duplicates a card', async () => {
    const h = boot();
    const jobIds = ['job-page-a', 'job-page-b', 'job-page-c'].map((id) => seedInterruptedDispatch(h, id));
    const { reconcileInterruptedDispatches } = await import('../src/dispatch/interrupted-dispatch.js');
    const deps = { ledger: h.ledger, notifications: h.notifications };

    const first = reconcileInterruptedDispatches(deps, { limit: 2 });
    expect(first.examined).toBe(2);
    expect(first.blocked).toHaveLength(2);
    const second = reconcileInterruptedDispatches(deps, { limit: 2 });
    expect(second.examined).toBe(1);
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
});
