import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LaneWriterConflictError, LedgerApi, type AddJobAmendmentResult } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DEFAULT_SILAS_CONFIG, loadConfig, type Role } from '../src/config.js';
import { NotificationCenter } from '../src/notifications/center.js';
import {
  amendmentSupersessions,
  renderEffectiveContract,
  requiredWorkRevision,
  type JobAmendmentRecord,
} from '../src/review-inputs/amendments.js';
import { findBusyLanes, laneIsBusy } from '../src/dispatch/branch-idle.js';
import { recordFollowUpDelivery, routeFixDirectiveToMinion, type DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import { reconcilePendingRebriefs } from '../src/dispatch/rebrief-recovery.js';
import {
  ReviewInProgressError,
  ReviewSupersessionUnconfirmedError,
  WaveRunner,
  type WaveOutcome,
} from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import type { DispatchService } from '../src/dispatch/service.js';
import { computeSilasDigest, silasWakeEvent } from '../src/dispatch/silas-driver.js';
import { MIGRATIONS } from '../src/ledger/db.js';
import { BoardEngine } from '../src/board/engine.js';
import { createHash } from 'node:crypto';
import { renderRevisionContinuation } from '../src/dispatch/work-revision.js';
import { liveReviewSessionIds } from '../src/dispatch/service-review-wave.js';
import { readFileSync } from 'node:fs';
import type { ResidentReviewRound } from '../src/runtime/registry.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { GitReviewPort } from './helpers/git-review-port.js';

/**
 * Supersede-and-resume (owner rules, 2026-10-08): material vs
 * administrative amendments, the pending-correction review fence, one
 * revision-stamped continuation, supersession of an obsolete review with a
 * PROVEN stop before any writer prompts, and one writer per lane. The R2
 * incident shape (PR256): a correction accepted while a continuation ran
 * must not let the next review freeze, and a correction sent while review
 * runs must stop that review first.
 */

const TOKEN = 'review-supersession-token';
const BRIEFING = 'Goal: ship the slim strip.\nAcceptance 1: the strip renders one row.';

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

function bootLedger(): { ledger: LedgerApi; db: LedgerDb } {
  const db = new LedgerDb(temp('gru-supersession-db-'));
  closers.push(async () => db.close());
  return { ledger: new LedgerApi(db.handle, { bus: new EventBus() }), db };
}

function accepted(result: AddJobAmendmentResult): Extract<AddJobAmendmentResult, { status: 'accepted' }> {
  if (result.status !== 'accepted') throw new Error(`expected accepted, got ${result.status}: ${result.reason}`);
  return result;
}

function amend(ledger: LedgerApi, jobId: string, effect: 'material' | 'administrative', body: string): JobAmendmentRecord {
  return accepted(ledger.addJobAmendment({
    jobId,
    body,
    approval: { by: 'gru', reference: `j-test ${effect}` },
    expectedContractSha256: ledger.effectiveContract(jobId)!.contractSha256,
    effect,
  })).amendment;
}

function deliver(ledger: LedgerApi, jobId: string, workRevision?: number): void {
  ledger.appendCustomEvent({
    kind: 'job.delivered',
    jobId,
    payload: { sha: 'fixture-settled', ...(workRevision !== undefined ? { work_revision: workRevision } : {}) },
  });
}

/** A completed scheduler verification of `sha` (the receipt option A
 * requires before a corrective delivery may be reviewed). */
function verified(ledger: LedgerApi, jobId: string, sha: string, ok = true): void {
  ledger.appendCustomEvent({
    kind: 'verification.completed',
    jobId,
    payload: { run_id: `run-${sha}-${String(ok)}`, scope: 'unit', sha, ok, exit_code: ok ? 0 : 1 },
  });
}

describe('rule 1 — material vs administrative amendments', () => {
  it('requires an explicit effect, audits the refusal, and records it on acceptance', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-1', repo: 'r', title: 't', briefing: BRIEFING });
    const refused = ledger.addJobAmendment({
      jobId: 'job-1',
      body: 'x',
      approval: { by: 'gru', reference: 'j-1' },
      expectedContractSha256: ledger.effectiveContract('job-1')!.contractSha256,
      effect: 'sometimes' as never,
    });
    expect(refused.status).toBe('rejected');
    if (refused.status !== 'rejected') throw new Error('unreachable');
    expect(refused.code).toBe('invalid');
    expect(refused.reason).toMatch(/effect must be "material"/);
    expect(ledger.listEvents().filter((event) => event.kind === 'job.amendment-rejected')).toHaveLength(1);
    const material = amend(ledger, 'job-1', 'material', 'Remove the unauthorized broad import.');
    expect(material.effect).toBe('material');
    const event = ledger.latestJobEvent('job-1', 'job.amendment-accepted');
    expect(event?.payload).toMatchObject({ effect: 'material', required_work_revision: 1 });
    expect(ledger.effectiveContract('job-1')!.text).toContain('effect: MATERIAL — requires implementation');
  });

  it('renders unclassified (pre-effect) rows byte-identically, so frozen contract hashes never move', () => {
    const legacy: JobAmendmentRecord = {
      id: 'a1', jobId: 'job-1', version: 1, body: 'Old clarification.', bodySha256: 'b', supersedes: [],
      approval: { by: 'owner', reference: 'j-1' }, effect: null, previousContractSha256: 'p', contractSha256: 'c',
      requestSha256: 'r', idempotencyKey: null, createdAt: '2026-10-01T00:00:00.000Z',
    };
    const rendered = renderEffectiveContract(BRIEFING, [legacy]);
    expect(rendered.text).not.toContain('effect:');
    expect(rendered.text).toContain('status: EFFECTIVE');
    // Unclassified history never gates review; only material versions do.
    expect(requiredWorkRevision([legacy])).toBe(0);
    expect(requiredWorkRevision([legacy, { version: 2, effect: 'administrative' }, { version: 3, effect: 'material' }])).toBe(3);
  });

  it('an administrative amendment never marks the candidate outdated; a material one does', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-1', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-1', 'working');
    deliver(ledger, 'job-1');
    amend(ledger, 'job-1', 'administrative', 'Typo fix in the acceptance wording.');
    expect(ledger.workRevisionState('job-1')).toEqual({ required: 0, delivered: 0 });
    expect(laneIsBusy(ledger, ledger.getJob('job-1')!)).toBe(false);
    amend(ledger, 'job-1', 'material', 'The strip must also show the review chip.');
    expect(ledger.workRevisionState('job-1')).toEqual({ required: 2, delivered: 0 });
    expect(laneIsBusy(ledger, ledger.getJob('job-1')!)).toBe(true);
  });
});

describe('rule 2 — a pending correction prevents review from starting', () => {
  it('fences the lane until a delivery carries the required revision (the R2 shape)', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-r2', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-r2', 'working');
    // v3 continuation is running; v4 and v5 land meanwhile.
    amend(ledger, 'job-r2', 'material', 'v1 conflict-resolution continuation.');
    const v4 = amend(ledger, 'job-r2', 'material', 'v2 scope enforcement.');
    amend(ledger, 'job-r2', 'administrative', 'v3 report linkage bookkeeping.');
    // The running continuation was composed at revision 1 and delivers it.
    deliver(ledger, 'job-r2', 1);
    expect(ledger.workRevisionState('job-r2')).toEqual({ required: v4.version, delivered: 1 });
    expect(laneIsBusy(ledger, ledger.getJob('job-r2')!)).toBe(true);
    const blockers = findBusyLanes({ ledger, lanes: [], targetBranch: 'gru/job-r2' });
    expect(blockers).toEqual([{ jobId: 'job-r2', status: 'working', branch: 'gru/job-r2', revision: { required: 2, delivered: 1 } }]);
    // Only a delivery stamped with the required revision releases the fence…
    deliver(ledger, 'job-r2', 2);
    // …and, being corrective, it is reviewed only on a verified head
    // (owner decision 2026-10-09, option A).
    expect(laneIsBusy(ledger, ledger.getJob('job-r2')!)).toBe(true);
    expect(findBusyLanes({ ledger, lanes: [], targetBranch: 'gru/job-r2' })).toEqual([
      { jobId: 'job-r2', status: 'working', branch: 'gru/job-r2', verification: { revision: 2, head: 'fixture-settled' } },
    ]);
    verified(ledger, 'job-r2', 'other-head');
    verified(ledger, 'job-r2', 'fixture-settled', false);
    expect(laneIsBusy(ledger, ledger.getJob('job-r2')!)).toBe(true);
    verified(ledger, 'job-r2', 'fixture-settled');
    expect(laneIsBusy(ledger, ledger.getJob('job-r2')!)).toBe(false);
  });

  it('stamps every continuation with the revision it was composed with', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-s', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-s', 'working');
    amend(ledger, 'job-s', 'material', 'First correction.');
    const directive = ledger.beginDirectiveIntent({ jobId: 'job-s', directive: 'fix', holder: 'silas-ops', requestId: 'req-1' });
    expect(directive.record.workRevision).toBe(1);
    expect(ledger.latestJobEvent('job-s', 'silas.directive-intent')?.payload).toMatchObject({ work_revision: 1 });
    const recorded = recordFollowUpDelivery({
      ledger, worktrees: { listWorktrees: () => [] }, jobId: 'job-s', agentId: null, source: 'silas-directive',
      requestId: 'req-1', workRevision: directive.record.workRevision ?? 0,
    });
    expect(ledger.listEvents().find((event) => event.seq === recorded.eventSeq)?.payload).toMatchObject({ work_revision: 1 });
    expect(() => recordFollowUpDelivery({
      ledger, worktrees: { listWorktrees: () => [] }, jobId: 'job-s', agentId: null, source: 'dispatch', workRevision: -1,
    })).toThrow(/non-negative integer/);
  });
});

describe('rule 4 — one combined, revision-stamped continuation', () => {
  it('renders every pending material amendment once, in version order, with its canonical bytes', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-c', repo: 'r', title: 't', briefing: BRIEFING });
    const first = amend(ledger, 'job-c', 'material', 'Amendment body ONE.');
    amend(ledger, 'job-c', 'administrative', 'Bookkeeping that never travels.');
    const third = amend(ledger, 'job-c', 'material', 'Amendment body THREE.');
    const block = renderRevisionContinuation({ jobId: 'job-c', revision: 3, deliveredRevision: 0, pending: [first, third] });
    expect(block).toContain('CONTRACT REVISION 3');
    expect(block.indexOf('Amendment body ONE.')).toBeLessThan(block.indexOf('Amendment body THREE.'));
    expect(block.split('Amendment body ONE.')).toHaveLength(2);
    expect(block).not.toContain('Bookkeeping that never travels.');
    expect(block).toContain('Name "contract revision 3" in your completion report.');
    expect(renderRevisionContinuation({ jobId: 'job-c', revision: 3, deliveredRevision: 3, pending: [] })).toBe('');
  });
});

describe('rule 5 — one writer per lane', () => {
  it('refuses a directive while a re-brief stands, and a re-brief while a directive is live', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-w', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-w', 'working');
    const markers = ledger.beginPendingRebrief({ jobId: 'job-w', note: 'fresh worker', briefing: BRIEFING });
    expect(markers.every((marker) => marker.workRevision === 0)).toBe(true);
    expect(() => ledger.beginDirectiveIntent({ jobId: 'job-w', directive: 'fix', holder: 'silas-ops' }))
      .toThrow(LaneWriterConflictError);
    ledger.addJob({ id: 'job-x', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-x', 'working');
    ledger.beginDirectiveIntent({ jobId: 'job-x', directive: 'fix', holder: 'silas-ops', requestId: 'live-x' });
    expect(() => ledger.beginPendingRebrief({ jobId: 'job-x', note: 'n', briefing: BRIEFING }))
      .toThrow(/live directive request \(live-x/);
  });
});

/** A fake resident review session: prompt never settles on its own (the
 * review is "running"); dispose removes it from the live set. */
function hangingHandle(id: string, live: Set<string>, sessionDir: string, leaks = false): AgentHandle {
  live.add(id);
  return {
    role: 'perkins',
    id,
    reviewIsolation: true,
    sessionFile: join(sessionDir, `${id}.jsonl`),
    capabilities: CAPABILITIES,
    prompt: () => new Promise<void>(() => {}),
    async steer() {},
    async followUp() {},
    subscribe: () => () => {},
    health: () => ({ state: live.has(id) ? 'streaming' as const : 'disposed' as const, lastActivity: null, sessionFile: null }),
    async dispose() {
      // A leaking session reports disposed to its caller but keeps running.
      if (!leaks) live.delete(id);
    },
  };
}

interface ReviewHarness {
  readonly ledger: LedgerApi;
  readonly wave: WaveRunner;
  readonly repo: FixtureRepo;
  readonly port: GitReviewPort;
  readonly escalations: string[];
  readonly informs: string[];
  readonly liveSessions: Set<string>;
  readonly jobId: string;
}

/** A real wave whose round is HELD: `mode: 'queued'` holds it at resident
 * admission (round pending — a queued review); `mode: 'running'` admits it
 * and hangs the lead session (round live — a running review). */
async function heldReview(input: {
  readonly mode: 'queued' | 'running';
  /** The resident reservation's disposal stalls until the test releases
   * it (an unproven stop); released in teardown so shutdown completes. */
  readonly closeHangs?: boolean;
  readonly deadlineMs?: number;
  /** Sessions survive disposal (an unproven stop after the run settled). */
  readonly leakSessions?: boolean;
  /** The runtime's owner-cessation proof (default: proven). */
  readonly ownerCeased?: () => boolean;
}): Promise<ReviewHarness & { readonly run: Promise<WaveOutcome>; readonly releaseClose: () => void }> {
  const repo = makeFixtureRepo('review-supersession');
  repos.push(repo);
  repo.git(['checkout', '-b', 'feature/review']);
  const target = repo.commitFile('src/main.ts', 'export const rows = 1;\n');
  const port = new GitReviewPort(temp('supersession-port-'), 'feature/review', target);
  const { ledger } = bootLedger();
  const jobId = 'job-held';
  await port.createJobWorktree({ repoPath: repo.path, jobId });
  ledger.addJob({ id: jobId, repo: 'fixture', title: 'held', baseBranch: 'main', briefing: BRIEFING });
  ledger.setJobStatus(jobId, 'working');
  deliver(ledger, jobId);
  const escalations: string[] = [];
  const informs: string[] = [];
  const liveSessions = new Set<string>();
  let sessionSeq = 0;
  let releaseClose: () => void = () => {};
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const sessionDir = temp('supersession-sessions-');
  const reservation: ResidentReviewRound = {
    spawn: async (_options: SpawnOptions) =>
      hangingHandle(`perkins-${++sessionSeq}`, liveSessions, sessionDir, input.leakSessions === true),
    beginChildren: (maxChildren: number) => ({ concurrency: maxChildren, finish: () => {} }),
    close: () => (input.closeHangs === true ? closeGate : Promise.resolve()),
    reconcileCleanup: () => {},
    cleanupDebt: () => [],
  };
  const wave = new WaveRunner({
    ledger,
    worktrees: port,
    spawner: async (role: Role) => {
      throw new Error(`no direct ${role} spawn in the held-review harness`);
    },
    reviewArtifactRoot: temp('supersession-artifacts-'),
    reconcileReviewAgent: async () => input.ownerCeased?.() ?? true,
    reserveReviewRound: (signal) => input.mode === 'running'
      ? Promise.resolve(reservation)
      : new Promise<ResidentReviewRound>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    liveReviewSessions: (agentIds) => agentIds.filter((id) => liveSessions.has(id)),
    escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    inform: (title) => informs.push(title),
    ...(input.deadlineMs !== undefined ? { supersessionDeadlineMs: input.deadlineMs } : {}),
  });
  closers.push(async () => {
    releaseClose();
    await wave.shutdown();
  });
  const begun = await wave.beginRound({ jobId });
  const run = begun.run.catch((error: unknown) => {
    throw error;
  });
  run.catch(() => {});
  if (input.mode === 'running') {
    // Wait (event-driven) until the lead session exists and the round is live.
    for (let spins = 0; spins < 400 && (liveSessions.size === 0 || ledger.getRound(begun.round.id)?.status !== 'live'); spins += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (ledger.getRound(begun.round.id)?.status !== 'live') {
      throw new Error(`held round did not go live: ${JSON.stringify(ledger.listEvents().filter((event) => event.roundId === begun.round.id).map((event) => [event.kind, event.payload]))}`);
    }
  } else {
    expect(ledger.getRound(begun.round.id)?.status).toBe('pending');
  }
  return { ledger, wave, repo, port, escalations, informs, liveSessions, jobId, run, releaseClose };
}

describe('rule 3 — a material change supersedes a review safely', () => {
  it('a current review refuses a writer; an approved material change makes it obsolete', async () => {
    const h = await heldReview({ mode: 'queued' });
    const active = h.wave.activeReview(h.jobId);
    expect(active?.roundIds).toHaveLength(1);
    expect(() => h.wave.assertWriterAdmissible(h.jobId)).toThrow(ReviewInProgressError);
    amend(h.ledger, h.jobId, 'material', 'Approved correction: remove the broad import.');
    expect(() => h.wave.assertWriterAdmissible(h.jobId)).not.toThrow();
    await h.wave.supersedeReviews({ jobId: h.jobId, reason: 'material amendment #1 accepted', by: 'gru' });
  });

  it('withdraws a queued round: superseded receipt first, confirmed stop, routine FYI only', async () => {
    const h = await heldReview({ mode: 'queued' });
    const roundId = h.wave.activeReview(h.jobId)!.roundIds[0]!;
    const outcome = await h.wave.supersedeReviews({ jobId: h.jobId, reason: 'material amendment #1 accepted', by: 'gru' });
    expect(outcome).toMatchObject({ roundIds: [roundId], confirmed: true, detail: null });
    expect(h.ledger.getRound(roundId)?.status).toBe('aborted');
    expect(h.wave.activeReview(h.jobId)).toBeNull();
    const superseded = h.ledger.latestRoundEvent(roundId, 'round.superseded');
    const confirmed = h.ledger.latestRoundEvent(roundId, 'round.supersession-confirmed');
    expect(superseded?.payload).toMatchObject({ reason: 'material amendment #1 accepted', by: 'gru', status: 'pending' });
    expect(confirmed).not.toBeNull();
    expect(superseded!.seq).toBeLessThan(confirmed!.seq);
    expect(h.escalations).toEqual([]);
    expect(h.informs).toEqual([`Review of job ${h.jobId} superseded`]);
    await expect(h.run).rejects.toThrow(/superseded/);
  });

  it('cancels a running round and its sessions, preserves the record, and proves the stop', async () => {
    const h = await heldReview({ mode: 'running' });
    const roundId = h.wave.activeReview(h.jobId)!.roundIds[0]!;
    expect(h.liveSessions.size).toBeGreaterThan(0);
    const writerGate = await h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive req-1' });
    expect(writerGate.confirmed).toBe(true);
    expect(h.liveSessions.size).toBe(0);
    expect(h.ledger.getRound(roundId)?.status).toBe('aborted');
    const incomplete = h.ledger.latestRoundEvent(roundId, 'round.perkins-incomplete');
    expect(incomplete?.payload).toMatchObject({ reason: 'superseded' });
    expect(h.ledger.latestRoundEvent(roundId, 'round.superseded')?.payload).toMatchObject({
      status: 'live', settled_specialists: [],
    });
    // The round's own INCOMPLETE notice is routine for a superseded round —
    // never an action-required escalation.
    expect(h.escalations).toEqual([]);
    expect(h.informs.some((title) => title.includes('INCOMPLETE (superseded)'))).toBe(true);
    const outcome = await h.run;
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
  });

  it('an unproven stop blocks the writer and escalates once — never both running', async () => {
    const h = await heldReview({ mode: 'running', closeHangs: true, deadlineMs: 50 });
    const roundId = h.wave.activeReview(h.jobId)!.roundIds[0]!;
    await expect(h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive req-2' }))
      .rejects.toThrow(ReviewSupersessionUnconfirmedError);
    expect(h.ledger.latestRoundEvent(roundId, 'round.supersession-unconfirmed')?.payload)
      .toMatchObject({ detail: expect.stringMatching(/did not settle within the bound/) });
    expect(h.escalations).toHaveLength(1);
    expect(h.escalations[0]).toMatch(/could not be confirmed stopped — its writer is blocked/);
    // The aborted operation is still unsettled: a retry is refused too,
    // never confirmed by an early return.
    await expect(h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive req-3' }))
      .rejects.toThrow(ReviewSupersessionUnconfirmedError);
  });
});

describe('rule 3 — the bmad-review fallback gate is a review too', () => {
  it('a running fallback gate refuses a current writer, then is superseded and proven stopped', async () => {
    const repo = makeFixtureRepo('review-supersession-fallback');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export const rows = 1;\n');
    const port = new GitReviewPort(temp('supersession-fallback-port-'), 'feature/review', target);
    const { ledger } = bootLedger();
    const jobId = 'job-fallback';
    await port.createJobWorktree({ repoPath: repo.path, jobId });
    ledger.addJob({ id: jobId, repo: 'fixture', title: 'fallback', baseBranch: 'main', briefing: BRIEFING });
    ledger.setJobStatus(jobId, 'working');
    deliver(ledger, jobId);
    const skillPath = join(temp('supersession-skill-'), 'SKILL.md');
    writeFileSync(skillPath, '---\nname: bmad-review\n---\n', 'utf8');
    let reviewing = false;
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: async (role: Role) => {
        throw new Error(`no ${role} spawn on the fallback route`);
      },
      reviewArtifactRoot: temp('supersession-fallback-artifacts-'),
      escalate: (title) => escalations.push(title),
      reviewPreflight: async () => ({
        ok: false as const,
        failures: [{ leg: 'review-policy' as const, detail: 'Perkins disabled', remediation: 'enable it' }],
      }),
      fallbackGate: {
        skillPath,
        // The fallback reviewer runs until its signal aborts.
        runFallbackReview: (input) => new Promise((resolve, reject) => {
          reviewing = true;
          // A reviewer that ANSWERS (clean, no blockers) after cancellation:
          // its findings must never become a PASS on the obsolete diff.
          input.signal?.addEventListener('abort', () => resolve([]), { once: true });
          void reject;
        }),
        fixDirectiveSink: async () => ({ delivered: true as const }),
      },
    });
    closers.push(() => wave.shutdown());
    const outcome = await wave.requestReview({ jobId });
    expect(outcome.route).toBe('bmad-review-fallback');
    for (let spins = 0; spins < 400 && !reviewing; spins += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reviewing).toBe(true);
    expect(wave.activeReview(jobId)).toEqual({ roundIds: [], operations: 1 });
    expect(() => wave.assertWriterAdmissible(jobId)).toThrow(ReviewInProgressError);
    amend(ledger, jobId, 'material', 'Approved correction during the fallback review.');
    const cleared = await wave.clearLaneForWriter({ jobId, writer: 'directive req-f' });
    expect(cleared).toMatchObject({ roundIds: [], operations: 1, confirmed: true });
    expect(wave.activeReview(jobId)).toBeNull();
    expect(ledger.latestJobEvent(jobId, 'job.review-superseded')?.payload).toMatchObject({ route: 'bmad-review-fallback' });
    expect(ledger.latestJobEvent(jobId, 'job.review-supersession-confirmed')).not.toBeNull();
    // Only the pre-existing engagement notice; the superseded gate's own
    // terminal record is routine (no BLOCKED/ABORTED incident).
    expect(escalations).toEqual([`Perkins gate unavailable for job ${jobId} — the bmad-review gate is engaged`]);
    const terminal = ledger.latestJobEvent(jobId, 'job.fallback-review');
    expect(terminal?.payload).toMatchObject({ phase: 'aborted', superseded: true });
    const phases = ledger.listJobEvents(jobId, { limit: 50 })
      .filter((event) => event.kind === 'job.fallback-review')
      .map((event) => (event.payload as { phase?: string }).phase);
    expect(phases).not.toContain('pass');
  });
});

/** A fake lane minion whose prompts are captured (the continuation text). */
class CapturingMinions implements DirectiveRegistry {
  readonly prompts: string[] = [];
  private readonly handles = new Map<string, AgentHandle>();
  register(id: string): void {
    const prompts = this.prompts;
    this.handles.set(id, {
      role: 'minion', id, sessionFile: null, capabilities: CAPABILITIES,
      async prompt(text: string) {
        prompts.push(text);
      },
      async steer() {},
      async followUp() {},
      subscribe: () => () => {},
      health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: null }),
      async dispose() {},
    });
  }
  getHandle(id: string): AgentHandle | null {
    return this.handles.get(id) ?? null;
  }
  /** A fresh (re-brief) minion: captured like the live one. */
  async spawn(_role: Role): Promise<AgentHandle> {
    const id = `spawned-${this.handles.size + 1}`;
    this.register(id);
    return this.handles.get(id)!;
  }
  async disposeHandle(handle: AgentHandle): Promise<void> {
    this.handles.delete(handle.id);
  }
}

async function serve(
  h: Pick<ReviewHarness, 'ledger' | 'wave' | 'port' | 'jobId'>,
  extra: { readonly providerClaims?: string[] } = {},
): Promise<{ port: number; registry: CapturingMinions }> {
  const dir = temp('supersession-server-');
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  const registry = new CapturingMinions();
  h.ledger.registerAgent({ id: 'minion-lane', role: 'minion', sessionFile: null, jobId: h.jobId });
  registry.register('minion-lane');
  const server = createDispatchServer({
    pendingProducerBlockers: () => [],
    config: loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester'),
    dispatch: null as unknown as DispatchService,
    wave: h.wave,
    ledger: h.ledger,
    silasOps: {
      registry,
      worktrees: h.port,
      notifications: new NotificationCenter({ ledger: h.ledger, bus: new EventBus() }),
      ...(extra.providerClaims !== undefined
        ? {
            providerRecovery: {
              claim: async (waitId: string) => {
                extra.providerClaims!.push(waitId);
                return { claimed: true };
              },
            } as never,
          }
        : {}),
    },
  });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return { port: (http.address() as AddressInfo).port, registry };
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function settledDirective(ledger: LedgerApi, requestId: string): Promise<string> {
  for (let spins = 0; spins < 2000; spins += 1) {
    const state = ledger.getDirective(requestId)?.state;
    if (state === 'settled' || state === 'failed') return state;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`directive ${requestId} never settled`);
}

describe('the service-enforced sequence over HTTP (R1/R2 replayed)', () => {
  it('refuses writers during a current review, then supersede → confirm → one continuation → revision delivered', async () => {
    const h = await heldReview({ mode: 'running' });
    const { port, registry } = await serve(h);
    const roundId = h.wave.activeReview(h.jobId)!.roundIds[0]!;

    // R1: a directive while the review is running and nothing approved it.
    const early = await post(port, '/api/silas/directive', { job_id: h.jobId, directive: 'restore strict viewport tests' });
    expect(early.status).toBe(409);
    expect(early.json).toMatchObject({ error: 'review_in_progress', round_ids: [roundId] });
    expect(h.ledger.listPendingDirectives({ jobId: h.jobId })).toHaveLength(0);
    const rebrief = await post(port, '/api/silas/rebrief', { job_id: h.jobId, note: 'fresh worker' });
    expect(rebrief.status).toBe(409);
    expect(rebrief.json).toMatchObject({ error: 'review_in_progress' });
    expect(h.ledger.listPendingRebriefs({ jobId: h.jobId })).toHaveLength(0);

    // An amendment without its effect is refused loudly and audited.
    const contract = h.ledger.effectiveContract(h.jobId)!;
    const missing = await post(port, '/api/dispatch/amendment', {
      job_id: h.jobId, body: 'x', approval: { by: 'gru', reference: 'j-1406' },
      expected_contract_sha256: contract.contractSha256,
    });
    expect(missing.status).toBe(400);
    expect(String(missing.json['detail'])).toMatch(/^effect is required/);

    // The approved correction: material → the running review is superseded now.
    const material = await post(port, '/api/dispatch/amendment', {
      job_id: h.jobId, body: 'Remove the unauthorized broad import.', effect: 'material',
      approval: { by: 'gru', reference: 'j-1406' }, expected_contract_sha256: contract.contractSha256,
    });
    expect(material.status).toBe(200);
    expect(material.json).toMatchObject({
      review_supersession: 'started',
      work_revision: { required: 1, delivered: 0, pending: true },
      amendment: { effect: 'material', version: 1 },
    });

    // R2: the corrective directive is admitted only after the stop is proven.
    const directive = await post(port, '/api/silas/directive', {
      job_id: h.jobId, directive: 'Carry the outstanding findings forward.', request_id: 'slim-v5-correction',
    });
    expect(directive.status).toBe(202);
    expect(directive.json).toMatchObject({ work_revision: 1 });
    expect(await settledDirective(h.ledger, 'slim-v5-correction')).toBe('settled');
    expect(h.ledger.getRound(roundId)?.status).toBe('aborted');
    expect(h.liveSessions.size).toBe(0);
    const confirmed = h.ledger.latestRoundEvent(roundId, 'round.supersession-confirmed');
    const sent = h.ledger.latestJobEvent(h.jobId, 'silas.directive-sent');
    expect(confirmed).not.toBeNull();
    expect(sent).not.toBeNull();
    expect(confirmed!.seq).toBeLessThan(sent!.seq);

    // One continuation, carrying the canonical amendment once, stamped.
    expect(registry.prompts).toHaveLength(1);
    expect(registry.prompts[0]).toContain('Carry the outstanding findings forward.');
    expect(registry.prompts[0]).toContain('CONTRACT REVISION 1');
    expect(registry.prompts[0]!.split('Remove the unauthorized broad import.')).toHaveLength(2);
    expect(h.ledger.latestJobEvent(h.jobId, 'job.delivered')?.payload).toMatchObject({
      request_id: 'slim-v5-correction', work_revision: 1,
    });
    expect(h.ledger.workRevisionState(h.jobId)).toEqual({ required: 1, delivered: 1 });
    // Implement → verify → review: the corrective head owes its pass.
    const correctedHead = (h.ledger.latestJobEvent(h.jobId, 'job.delivered')!.payload as { sha: string }).sha;
    expect(h.ledger.correctiveVerificationDebt(h.jobId)).toEqual({ revision: 1, head: correctedHead });
    expect(laneIsBusy(h.ledger, h.ledger.getJob(h.jobId)!)).toBe(true);
    verified(h.ledger, h.jobId, correctedHead);
    expect(laneIsBusy(h.ledger, h.ledger.getJob(h.jobId)!)).toBe(false);
  });

  it('a superseded round is never a clean-abort re-arm candidate', async () => {
    const h = await heldReview({ mode: 'queued' });
    const { port } = await serve(h);
    const roundId = h.wave.activeReview(h.jobId)!.roundIds[0]!;
    await h.wave.supersedeReviews({ jobId: h.jobId, reason: 'material amendment accepted', by: 'gru' });
    // Even when a restart labels the interrupted round service_restart.
    h.ledger.appendCustomEvent({
      kind: 'round.perkins-incomplete', jobId: h.jobId, roundId, payload: { reason: 'service_restart' },
    });
    const rearm = await post(port, '/api/dispatch/review', {
      job_id: h.jobId, by: 'silas', rule_id: 'clean-abort-service-restart', source_round_id: roundId,
    });
    expect(rearm.status).toBe(400);
    expect(String(rearm.json['detail'])).toMatch(/clean service-restart abort|superseded/);
  });
});

describe('the Silas digest owes ONE continuation while a revision is pending', () => {
  it('offers revisionContinuations, withholds review rows, and retires on a live writer', async () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-d', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-d', 'working');
    deliver(ledger, 'job-d');
    ledger.setJobPr('job-d', 'https://github.com/acme/fixture/pull/9');
    ledger.setJobStatus('job-d', 'in-review');
    const digest = () => computeSilasDigest({
      ledger,
      blockersForRound: async () => ({ blockers: [], note: null }),
      config: DEFAULT_SILAS_CONFIG,
      trigger: 'sweep',
    });
    expect((await digest()).prWithoutReview.map((row) => row.jobId)).toEqual(['job-d']);
    amend(ledger, 'job-d', 'material', 'First correction.');
    amend(ledger, 'job-d', 'administrative', 'Clarification.');
    amend(ledger, 'job-d', 'material', 'Second correction.');
    const pending = await digest();
    expect(pending.prWithoutReview).toEqual([]);
    expect(pending.revisionContinuations).toEqual([
      { jobId: 'job-d', repo: 'r', requiredRevision: 3, deliveredRevision: 0, pendingVersions: [1, 3] },
    ]);
    ledger.beginDirectiveIntent({ jobId: 'job-d', directive: 'implement revision 3', holder: 'silas-ops', requestId: 'cont-1' });
    expect((await digest()).revisionContinuations).toEqual([]);
  });

  it('never offers a clean-abort re-arm for a superseded round', async () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-e', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-e', 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-e', payload: { sha: 'a'.repeat(40) } });
    ledger.setJobPr('job-e', 'https://github.com/acme/fixture/pull/10');
    ledger.setJobStatus('job-e', 'in-review');
    const round = ledger.addRound({ jobId: 'job-e', targetRef: 'a'.repeat(40), lenses: ['blind'] });
    ledger.abortReviewSetupWithoutSpawn(round.id);
    ledger.appendCustomEvent({ kind: 'round.perkins-incomplete', jobId: 'job-e', roundId: round.id, payload: { reason: 'service_restart' } });
    const digest = () => computeSilasDigest({
      ledger, blockersForRound: async () => ({ blockers: [], note: null }), config: DEFAULT_SILAS_CONFIG, trigger: 'sweep',
    });
    expect((await digest()).prWithoutReview[0]?.cleanAbort?.roundId).toBe(round.id);
    ledger.appendCustomEvent({ kind: 'round.superseded', jobId: 'job-e', roundId: round.id, payload: { reason: 'material amendment' } });
    expect((await digest()).prWithoutReview.some((row) => row.cleanAbort !== undefined)).toBe(false);
  });
});

/** A laned job with a real wave but no review: writer paths, re-briefs and
 * queued handoffs (bus-backed) without any running round. */
async function plainLane(jobId = 'job-plain'): Promise<ReviewHarness> {
  const repo = makeFixtureRepo('review-supersession-plain');
  repos.push(repo);
  repo.git(['checkout', '-b', 'feature/review']);
  const target = repo.commitFile('src/main.ts', 'export const rows = 1;\n');
  const port = new GitReviewPort(temp('supersession-plain-port-'), 'feature/review', target);
  const db = new LedgerDb(temp('gru-supersession-plain-db-'));
  closers.push(async () => db.close());
  const bus = new EventBus();
  const ledger = new LedgerApi(db.handle, { bus });
  await port.createJobWorktree({ repoPath: repo.path, jobId });
  ledger.addJob({ id: jobId, repo: 'fixture', title: 'plain', baseBranch: 'main', briefing: BRIEFING });
  ledger.setJobStatus(jobId, 'working');
  const escalations: string[] = [];
  const informs: string[] = [];
  const wave = new WaveRunner({
    ledger,
    worktrees: port,
    bus,
    spawner: async (role: Role) => {
      throw new Error(`no ${role} spawn in the plain-lane harness`);
    },
    reviewArtifactRoot: temp('supersession-plain-artifacts-'),
    escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    inform: (title) => informs.push(title),
  });
  closers.push(() => wave.shutdown());
  return { ledger, wave, repo, port, escalations, informs, liveSessions: new Set(), jobId };
}

describe('review round 1 — the fences hold under force, restart and re-proof', () => {
  it('force never reviews a candidate an approved material change made obsolete', async () => {
    const h = await plainLane('job-forced');
    deliver(h.ledger, h.jobId);
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    await expect(h.wave.requestReview({ jobId: h.jobId, force: true })).rejects.toThrow(/is busy/);
    const refusal = h.ledger.latestJobEvent(h.jobId, 'branch-idle.refused');
    expect(refusal?.payload).toMatchObject({ forced: false, blockers: [{ jobId: h.jobId, revision: { required: 1, delivered: 0 } }] });
    expect(h.ledger.latestJobEvent(h.jobId, 'branch-idle.forced')).toBeNull();
    expect(h.ledger.listRounds(h.jobId)).toHaveLength(0);
  });

  it('an unproven stop keeps owning the lane until a later writer re-proves it', async () => {
    const h = await heldReview({ mode: 'running', leakSessions: true, deadlineMs: 2000 });
    const roundId = h.wave.activeReview(h.jobId)!.roundIds[0]!;
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    // The run settles and the round terminalizes, but a session survives.
    await expect(h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive a' }))
      .rejects.toThrow(/still alive/);
    expect(h.ledger.getRound(roundId)?.status).toBe('aborted');
    // The terminal round still owns the lane: the next writer is refused too.
    expect(h.wave.activeReview(h.jobId)?.roundIds).toEqual([roundId]);
    await expect(h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive b' }))
      .rejects.toThrow(ReviewSupersessionUnconfirmedError);
    // Only once the runtime proves the session gone does a writer pass.
    h.liveSessions.clear();
    // The same stuck stop is reported action-required once; a re-proof
    // that fails again is an FYI.
    expect(h.escalations.filter((line) => line.includes('could not be confirmed stopped'))).toHaveLength(1);
    expect(h.informs.some((title) => title.includes('still not proven stopped'))).toBe(true);
    const proven = await h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive c' });
    expect(proven.confirmed).toBe(true);
    expect(h.wave.activeReview(h.jobId)).toBeNull();
    expect(h.ledger.listEvents().filter((event) => event.roundId === roundId && event.kind === 'round.superseded')).toHaveLength(1);
    expect(h.ledger.latestRoundEvent(roundId, 'round.supersession-confirmed')).not.toBeNull();
  });

  it('confirmation demands the runtime owner-cessation proof the next round already requires', async () => {
    let ceased = false;
    const h = await heldReview({ mode: 'running', ownerCeased: () => ceased });
    await expect(h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive o' }))
      .rejects.toThrow(/not proven ceased/);
    ceased = true;
    expect((await h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive o2' })).confirmed).toBe(true);
  });

  it('a material change withdraws the queued review request, durably — a delivery or restart never replays it', async () => {
    const h = await plainLane('job-queued-handoff');
    // The minion asks for review while its own turn is still open.
    const queued = await h.wave.requestReview({ jobId: h.jobId, handoff: true, targetRef: 'feature/review' });
    expect(queued.route).toBe('queued');
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    await h.wave.supersedeReviews({ jobId: h.jobId, reason: 'material amendment #1 accepted', by: 'gru' });
    expect(h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-withdrawn')?.payload)
      .toMatchObject({ reason: 'material amendment #1 accepted' });
    if (queued.route === 'queued') await queued.run;
    deliver(h.ledger, h.jobId, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-claimed')).toBeNull();
    const restarted = new WaveRunner({
      ledger: h.ledger, worktrees: h.port, bus: new EventBus(),
      spawner: async () => {
        throw new Error('no spawn');
      },
      reviewArtifactRoot: temp('supersession-restart-artifacts-'),
    });
    closers.push(() => restarted.shutdown());
    restarted.resumeQueuedHandoffs();
    expect(h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-skipped')).toBeNull();
    expect(h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-claimed')).toBeNull();
  });

  it('a superseded round that a restart interrupted recovers as routine history', async () => {
    const h = await plainLane('job-restart');
    const round = h.ledger.addRound({ jobId: h.jobId, lenses: ['blind'] });
    h.ledger.setRoundStatus(round.id, 'live');
    h.ledger.appendCustomEvent({
      kind: 'round.superseded', jobId: h.jobId, roundId: round.id, payload: { reason: 'material amendment accepted' },
    });
    await h.wave.recoverInterruptedRounds();
    expect(h.ledger.getRound(round.id)?.status).toBe('aborted');
    expect(h.ledger.latestRoundEvent(round.id, 'round.perkins-incomplete')?.payload).toMatchObject({ reason: 'superseded' });
    expect(h.escalations).toEqual([]);
    expect(h.informs.some((title) => title.includes('(superseded)'))).toBe(true);
  });
});

describe('review round 1 — writer gates over HTTP', () => {
  it('an unproven stop refuses the directive with positive no-effect proof: no prompt, no delivery', async () => {
    const h = await heldReview({ mode: 'running', closeHangs: true, deadlineMs: 50 });
    const { port, registry } = await serve(h);
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    const accepted = await post(port, '/api/silas/directive', { job_id: h.jobId, directive: 'fix', request_id: 'refused-1' });
    expect(accepted.status).toBe(202);
    expect(await settledDirective(h.ledger, 'refused-1')).toBe('failed');
    expect(h.ledger.getDirective('refused-1')?.failReason).toMatch(/refused before any prompt/);
    expect(h.ledger.latestJobEvent(h.jobId, 'silas.directive-sent')).toBeNull();
    expect(registry.prompts).toEqual([]);
    expect(h.ledger.listEvents().filter((event) => event.kind === 'job.delivered' && event.jobId === h.jobId)).toHaveLength(1);
    expect(h.escalations.filter((line) => line.includes('could not be confirmed stopped'))).toHaveLength(1);
  });

  it('a re-brief carries the material amendment to the fresh minion and its delivery acknowledges the revision', async () => {
    const h = await plainLane('job-rebrief');
    deliver(h.ledger, h.jobId);
    amend(h.ledger, h.jobId, 'material', 'CORRECTION-BODY: remove the broad import.');
    const { port, registry } = await serve(h);
    const res = await post(port, '/api/silas/rebrief', { job_id: h.jobId, note: 'fresh worker for the correction' });
    expect(res.status).toBe(200);
    expect(registry.prompts).toHaveLength(1);
    expect(registry.prompts[0]).toContain('CONTRACT — revision 1');
    expect(registry.prompts[0]!.split('CORRECTION-BODY: remove the broad import.')).toHaveLength(2);
    expect(h.ledger.latestJobEvent(h.jobId, 'job.delivered')?.payload).toMatchObject({ source: 'silas-rebrief', work_revision: 1 });
    expect(h.ledger.workRevisionState(h.jobId)).toEqual({ required: 1, delivered: 1 });
  });

  it('a re-brief recovered after a restart re-delivers the durable contract and revision', async () => {
    const h = await plainLane('job-rebrief-boot');
    deliver(h.ledger, h.jobId);
    amend(h.ledger, h.jobId, 'material', 'BOOT-CORRECTION: restore the strict viewport tests.');
    h.ledger.beginPendingRebrief({ jobId: h.jobId, note: 'fresh worker', briefing: h.ledger.effectiveContract(h.jobId)!.text });
    const registry = new CapturingMinions();
    const report = await reconcilePendingRebriefs({
      registry, ledger: h.ledger, worktrees: h.port,
      notifications: { postIncident: () => ({}) } as never,
    }, { bootAt: new Date(Date.now() + 60_000) });
    await report.settled;
    expect(registry.prompts).toHaveLength(1);
    expect(registry.prompts[0]).toContain('BOOT-CORRECTION: restore the strict viewport tests.');
    expect(registry.prompts[0]).toContain('CONTRACT — revision 1');
    expect(h.ledger.latestJobEvent(h.jobId, 'job.delivered')?.payload).toMatchObject({ work_revision: 1 });
  });

  it('provider continuations take the same gate: current review → 409; obsolete review → superseded first', async () => {
    const h = await heldReview({ mode: 'running' });
    const claims: string[] = [];
    const { port } = await serve(h, { providerClaims: claims });
    h.ledger.recordProviderWait({
      id: 'wait-p', routeKey: 'route-p', provider: 'p', model: 'm', endpoint: 'e', credentialFingerprint: 'fp',
      waiterKind: 'job-minion', jobId: h.jobId, agentId: null, slotId: null, sessionFile: null, continuation: null,
      jobStatusAtEstablishment: 'working', lineageKey: null, incidentId: 'incident-p', incidentGeneration: 1,
      reasonClass: 'temporary-limit',
    });
    const current = await post(port, '/api/silas/provider-recovery/claim', { wait_id: 'wait-p', by: 'silas' });
    expect(current.status).toBe(409);
    expect(current.json).toMatchObject({ error: 'review_in_progress' });
    expect(claims).toEqual([]);
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    const obsolete = await post(port, '/api/silas/provider-recovery/claim', { wait_id: 'wait-p', by: 'silas' });
    expect(obsolete.status).toBe(200);
    expect(claims).toEqual(['wait-p']);
    expect(h.wave.activeReview(h.jobId)).toBeNull();
    expect(h.liveSessions.size).toBe(0);
  });
});

describe('review round 1 — one continuation, never contradictory', () => {
  it('a superseded pending amendment is named NOT EFFECTIVE and its body withheld', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-sup', repo: 'r', title: 't', briefing: BRIEFING });
    const first = amend(ledger, 'job-sup', 'material', 'OLD-RULE: render two rows.');
    const second = accepted(ledger.addJobAmendment({
      jobId: 'job-sup', body: 'NEW-RULE: render one row.', supersedes: [`amendment:${first.id}`],
      approval: { by: 'gru', reference: 'j-2' }, expectedContractSha256: ledger.effectiveContract('job-sup')!.contractSha256,
      effect: 'material',
    })).amendment;
    const block = renderRevisionContinuation({
      jobId: 'job-sup', revision: 2, deliveredRevision: 0, pending: [first, second],
      supersededBy: amendmentSupersessions(ledger.listJobAmendments('job-sup')),
    });
    expect(block).not.toContain('OLD-RULE: render two rows.');
    expect(block).toContain('status: NOT EFFECTIVE — superseded by amendment #2; do not implement it (body withheld)');
    expect(block).toContain('NEW-RULE: render one row.');
  });

  it('a fresh fallback session reads the amendment once (effective contract), not twice', async () => {
    const lanePath = temp('supersession-fresh-lane-');
    const prompts: string[] = [];
    const spawnFresh = async (_role: Role, options: SpawnOptions = {}): Promise<AgentHandle> => {
      if (options.resumeFile !== undefined && options.resumeFile !== null) throw new Error('session file is gone');
      return {
        role: 'minion', id: 'fresh-1', sessionFile: null, capabilities: CAPABILITIES,
        async prompt(text: string) {
          prompts.push(text);
        },
        async steer() {},
        async followUp() {},
        subscribe: () => () => {},
        health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: null }),
        async dispose() {},
      };
    };
    const contract = `${BRIEFING}\n\nAMENDMENT-BODY-ONCE`;
    const outcome = await routeFixDirectiveToMinion({
      registry: { getHandle: () => null, spawn: spawnFresh, disposeHandle: async () => {} },
      ledger: {
        getAgent: () => null,
        listAgents: () => [],
        listImplementerMinions: () => [{ id: 'minion-old', role: 'minion', jobId: 'job-f', sessionFile: '/sessions/old.jsonl' }],
        registerAgent: () => {},
        getJob: () => ({ briefing: BRIEFING, status: 'working' }),
      } as never,
      worktrees: { listWorktrees: () => [{ id: 'job-f', kind: 'job', path: lanePath, branch: null, jobId: 'job-f', status: 'active' }] } as never,
      jobId: 'job-f',
      directive: 'Implement contract revision 1.',
      contract,
      continuation: { block: 'CONTINUATION-BLOCK\nAMENDMENT-BODY-ONCE', freshNote: 'FRESH-NOTE revision 1' },
      signal: new AbortController().signal,
    });
    expect(outcome.delivered).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.split('AMENDMENT-BODY-ONCE')).toHaveLength(2);
    expect(prompts[0]).toContain('FRESH-NOTE revision 1');
    expect(prompts[0]).not.toContain('CONTINUATION-BLOCK');
  });

  it('the digest withholds the PR offer for an outdated candidate until the corrective delivery', async () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-nopr', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-nopr', 'working');
    deliver(ledger, 'job-nopr');
    const digest = () => computeSilasDigest({
      ledger, blockersForRound: async () => ({ blockers: [], note: null }), config: DEFAULT_SILAS_CONFIG, trigger: 'sweep',
    });
    expect((await digest()).deliveredWithoutPr.map((row) => row.jobId)).toEqual(['job-nopr']);
    amend(ledger, 'job-nopr', 'material', 'Correction.');
    const pending = await digest();
    expect(pending.deliveredWithoutPr).toEqual([]);
    expect(pending.revisionContinuations.map((row) => row.jobId)).toEqual(['job-nopr']);
    deliver(ledger, 'job-nopr', 1);
    // The corrective delivery owes its verification first (option A).
    const owed = await digest();
    expect(owed.deliveredWithoutPr).toEqual([]);
    expect(owed.verificationsOwed).toEqual([{ jobId: 'job-nopr', repo: 'r', revision: 1, head: 'fixture-settled' }]);
    verified(ledger, 'job-nopr', 'fixture-settled');
    const cleared = await digest();
    expect(cleared.verificationsOwed).toEqual([]);
    expect(cleared.deliveredWithoutPr.map((row) => row.jobId)).toEqual(['job-nopr']);
  });
});

describe('review round 2 — durable debts, handoffs and verification (option A)', () => {
  it('a minion review request for a candidate a material change made obsolete is refused, not queued', async () => {
    const h = await plainLane('job-handoff-refused');
    deliver(h.ledger, h.jobId);
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    await expect(h.wave.requestReview({ jobId: h.jobId, handoff: true })).rejects.toThrow(/is busy/);
    expect(h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-queued')).toBeNull();
  });

  it('a queued request older than a material amendment is withdrawn on restart even if the withdrawal was lost', async () => {
    const h = await plainLane('job-handoff-crash');
    const queued = await h.wave.requestReview({ jobId: h.jobId, handoff: true });
    expect(queued.route).toBe('queued');
    // The amendment commits; the service dies before its supersession pass.
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    const restarted = new WaveRunner({
      ledger: h.ledger, worktrees: h.port, bus: new EventBus(),
      spawner: async () => {
        throw new Error('no spawn');
      },
      reviewArtifactRoot: temp('supersession-crash-artifacts-'),
    });
    closers.push(() => restarted.shutdown());
    restarted.resumeQueuedHandoffs();
    expect(h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-withdrawn')?.payload)
      .toMatchObject({ reason: 'an approved material amendment was accepted after this review request' });
  });

  it('a supersession a restart interrupted (receipt, no confirmation) is re-proven before any writer', async () => {
    const h = await plainLane('job-unproven-round');
    const round = h.ledger.addRound({ jobId: h.jobId, lenses: ['blind'] });
    h.ledger.abortReviewSetupWithoutSpawn(round.id);
    h.ledger.appendCustomEvent({ kind: 'round.superseded', jobId: h.jobId, roundId: round.id, payload: { reason: 'material' } });
    expect(h.wave.activeReview(h.jobId)?.roundIds).toEqual([round.id]);
    expect(() => h.wave.assertWriterAdmissible(h.jobId)).toThrow(ReviewInProgressError);
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    expect((await h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive r' })).confirmed).toBe(true);
    expect(h.ledger.latestRoundEvent(round.id, 'round.supersession-confirmed')).not.toBeNull();
    expect(h.wave.activeReview(h.jobId)).toBeNull();
  });

  it('an unproven fallback stop is durable on the job until a writer re-proves it', async () => {
    const h = await plainLane('job-unproven-fallback');
    h.ledger.appendCustomEvent({ kind: 'job.review-superseded', jobId: h.jobId, payload: { route: 'bmad-review-fallback' } });
    h.ledger.appendCustomEvent({ kind: 'job.review-supersession-unconfirmed', jobId: h.jobId, payload: { detail: 'session alive' } });
    expect(h.wave.activeReview(h.jobId)).toEqual({ roundIds: [], operations: 0 });
    expect(() => h.wave.assertWriterAdmissible(h.jobId)).toThrow(ReviewInProgressError);
    // The fallback reviewer session is still registered live: unproven.
    h.ledger.registerAgent({ id: 'fallback-reviewer', role: 'perkins', label: 'fallback-review', jobId: h.jobId, sessionFile: null });
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    await expect(h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive f' })).rejects.toThrow(/fallback-reviewer/);
    h.ledger.setAgentState('fallback-reviewer', 'disposed');
    expect((await h.wave.clearLaneForWriter({ jobId: h.jobId, writer: 'directive f2' })).confirmed).toBe(true);
    expect(h.wave.activeReview(h.jobId)).toBeNull();
  });

  it('a pass on the corrective head re-offers a request that waited on its verification', async () => {
    const h = await plainLane('job-verify-replay');
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    deliver(h.ledger, h.jobId, 1);
    expect(h.ledger.correctiveVerificationDebt(h.jobId)).toEqual({ revision: 1, head: 'fixture-settled' });
    const queued = await h.wave.requestReview({ jobId: h.jobId, handoff: true });
    expect(queued.route).toBe('queued');
    verified(h.ledger, h.jobId, 'fixture-settled');
    for (let spins = 0; spins < 200 && h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-claimed') === null; spins += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-claimed')).not.toBeNull();
  });

  it('the debt follows the newest delivery until a review admits it, and only the corrective revision owes one', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-debt', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-debt', 'working');
    deliver(ledger, 'job-debt');
    expect(ledger.correctiveVerificationDebt('job-debt')).toBeNull(); // ordinary delivery: today's behavior
    amend(ledger, 'job-debt', 'material', 'Correction.');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-debt', payload: { sha: 'h1', work_revision: 1 } });
    verified(ledger, 'job-debt', 'h1', false);
    // The failed verification is repaired: the repair delivery owes its own pass.
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-debt', payload: { sha: 'h2', work_revision: 1 } });
    expect(ledger.correctiveVerificationDebt('job-debt')).toEqual({ revision: 1, head: 'h2' });
    verified(ledger, 'job-debt', 'h2');
    expect(ledger.correctiveVerificationDebt('job-debt')).toBeNull();
    // Once a review admitted the corrected work, later ordinary fix
    // deliveries at the same revision are not corrective.
    const admitted = ledger.addRound({ jobId: 'job-debt', targetRef: 'h2', lenses: ['blind'] });
    ledger.setRoundStatus(admitted.id, 'live');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-debt', payload: { sha: 'h3', work_revision: 1 } });
    expect(ledger.correctiveVerificationDebt('job-debt')).toBeNull();
  });

  it('accepting a material amendment alone stops a running review — no writer needed', async () => {
    const h = await heldReview({ mode: 'running' });
    const { port } = await serve(h);
    const roundId = h.wave.activeReview(h.jobId)!.roundIds[0]!;
    const accepted = await post(port, '/api/dispatch/amendment', {
      job_id: h.jobId, body: 'Approved correction.', effect: 'material',
      approval: { by: 'gru', reference: 'j-only-amendment' },
      expected_contract_sha256: h.ledger.effectiveContract(h.jobId)!.contractSha256,
    });
    expect(accepted.json).toMatchObject({ review_supersession: 'started' });
    for (let spins = 0; spins < 2000 && h.ledger.latestRoundEvent(roundId, 'round.supersession-confirmed') === null; spins += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(h.ledger.latestRoundEvent(roundId, 'round.supersession-confirmed')).not.toBeNull();
    expect(h.ledger.getRound(roundId)?.status).toBe('aborted');
    expect(h.liveSessions.size).toBe(0);
    expect(h.ledger.listPendingDirectives({ jobId: h.jobId })).toHaveLength(0);
  });

  it('a fresh session with nothing to resume is briefed with the effective contract', async () => {
    const lanePath = temp('supersession-nosession-lane-');
    const prompts: string[] = [];
    await routeFixDirectiveToMinion({
      registry: {
        getHandle: () => null,
        spawn: async (): Promise<AgentHandle> => ({
          role: 'minion', id: 'fresh-2', sessionFile: null, capabilities: CAPABILITIES,
          async prompt(text: string) {
            prompts.push(text);
          },
          async steer() {},
          async followUp() {},
          subscribe: () => () => {},
          health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: null }),
          async dispose() {},
        }),
        disposeHandle: async () => {},
      },
      ledger: {
        getAgent: () => null, listAgents: () => [], listImplementerMinions: () => [], registerAgent: () => {},
        getJob: () => ({ briefing: BRIEFING, status: 'working' }),
      } as never,
      worktrees: { listWorktrees: () => [{ id: 'job-n', kind: 'job', path: lanePath, branch: null, jobId: 'job-n', status: 'active' }] } as never,
      jobId: 'job-n',
      directive: 'Implement contract revision 1.',
      contract: `${BRIEFING}\n\nEFFECTIVE-AMENDMENT`,
      continuation: { block: 'BLOCK EFFECTIVE-AMENDMENT', freshNote: 'FRESH-NOTE' },
      signal: new AbortController().signal,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Effective contract (original briefing plus accepted amendments)');
    expect(prompts[0]!.split('EFFECTIVE-AMENDMENT')).toHaveLength(2);
    expect(prompts[0]).toContain('FRESH-NOTE');
  });

  it('the fresh contract is fixed at the intent: an amendment accepted while the gate waits travels next time', async () => {
    const h = await plainLane('job-intent-contract');
    deliver(h.ledger, h.jobId);
    amend(h.ledger, h.jobId, 'material', 'FIRST-CORRECTION');
    const gatedWave = {
      activeReview: () => null,
      assertWriterAdmissible: () => undefined,
      clearLaneForWriter: async (input: { jobId: string }) => {
        // Accepted while the writer gate waits.
        amend(h.ledger, input.jobId, 'material', 'SECOND-CORRECTION');
        return { jobId: input.jobId, roundIds: [], operations: 0, confirmed: true, detail: null };
      },
      supersedeReviews: async (input: { jobId: string }) => ({ jobId: input.jobId, roundIds: [], operations: 0, confirmed: true, detail: null }),
    } as unknown as WaveRunner;
    const dir = temp('supersession-intent-server-');
    writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
    const registry = new CapturingMinions();
    const server = createDispatchServer({
      pendingProducerBlockers: () => [],
      config: loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester'),
      dispatch: null as unknown as DispatchService,
      wave: gatedWave,
      ledger: h.ledger,
      silasOps: { registry, worktrees: h.port, notifications: new NotificationCenter({ ledger: h.ledger, bus: new EventBus() }) },
    });
    const http: HttpServer = createServer((req, res) => {
      if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
    const res = await post((http.address() as AddressInfo).port, '/api/silas/directive', {
      job_id: h.jobId, directive: 'Implement the correction.', request_id: 'intent-1',
    });
    expect(res.json).toMatchObject({ work_revision: 1 });
    expect(await settledDirective(h.ledger, 'intent-1')).toBe('settled');
    expect(registry.prompts).toHaveLength(1);
    expect(registry.prompts[0]).toContain('FIRST-CORRECTION');
    expect(registry.prompts[0]).not.toContain('SECOND-CORRECTION');
    expect(h.ledger.workRevisionState(h.jobId)).toEqual({ required: 2, delivered: 1 });
  });

  it('a pre-revision amendment survives migration 24 unclassified: same contract hash, no review fence', () => {
    const dir = temp('supersession-migration-');
    const old = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, 23) });
    old.handle.prepare("INSERT INTO jobs (id, repo, title, status, briefing, created_at, updated_at) VALUES ('j', 'r', 't', 'working', ?, 't', 't')").run(BRIEFING);
    const legacy: JobAmendmentRecord = {
      id: 'legacy-1', jobId: 'j', version: 1, body: 'A historical clarification.', bodySha256: 'b', supersedes: [],
      approval: { by: 'owner', reference: 'j-old' }, effect: null, previousContractSha256: 'p', contractSha256: '',
      requestSha256: 'r', idempotencyKey: null, createdAt: '2026-10-01T00:00:00.000Z',
    };
    // The pre-migration rendering, spelled out byte for byte (NOT via the
    // current renderer): an unclassified row must keep exactly this hash.
    const legacyText = [
      BRIEFING, '',
      '===== CANONICAL AMENDMENTS (append-only; accepted amendments affect later review rounds only) =====',
      '', '## Amendment #1 — accepted 2026-10-01T00:00:00.000Z', 'approval: owner — j-old', 'supersedes: none',
      'body_sha256: b', 'status: EFFECTIVE', '', 'A historical clarification.',
    ].join('\n');
    const contractSha256 = createHash('sha256').update(legacyText, 'utf8').digest('hex');
    expect(renderEffectiveContract(BRIEFING, [legacy]).contractSha256).toBe(contractSha256);
    old.handle.prepare(
      `INSERT INTO job_amendments (id, job_id, version, body, body_sha256, supersedes, approval_by, approval_reference,
         previous_contract_sha256, contract_sha256, request_sha256, idempotency_key, created_at)
       VALUES ('legacy-1', 'j', 1, 'A historical clarification.', 'b', '[]', 'owner', 'j-old', 'p', ?, 'r', NULL, '2026-10-01T00:00:00.000Z')`,
    ).run(contractSha256);
    old.close();
    const upgraded = new LedgerDb(dir);
    closers.push(async () => upgraded.close());
    const api = new LedgerApi(upgraded.handle);
    expect(api.listJobAmendments('j')[0]?.effect).toBeNull();
    expect(api.effectiveContract('j')!.contractSha256).toBe(contractSha256);
    expect(api.workRevisionState('j')).toEqual({ required: 0, delivered: 0 });
  });

  it('an accepted MATERIAL amendment wakes Silas; an administrative one does not', () => {
    expect(silasWakeEvent({ kind: 'job.amendment-accepted', payload: { effect: 'material' } })).toBe(true);
    expect(silasWakeEvent({ kind: 'job.amendment-accepted', payload: { effect: 'administrative' } })).toBe(false);
  });
});

describe('review round 3 — admitted reviews, retractions, fresh offers', () => {
  it('only a review that went live discharges a corrective verification debt', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-live', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-live', 'working');
    amend(ledger, 'job-live', 'material', 'Correction.');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-live', payload: { sha: 'hc', work_revision: 1 } });
    const refused = ledger.addRound({ jobId: 'job-live', lenses: ['blind'] });
    ledger.abortReviewSetupWithoutSpawn(refused.id); // created, refused at admission: reviewed nothing
    expect(ledger.correctiveVerificationDebt('job-live')).toEqual({ revision: 1, head: 'hc' });
    const admitted = ledger.addRound({ jobId: 'job-live', targetRef: 'hc', lenses: ['blind'] });
    ledger.setRoundStatus(admitted.id, 'live');
    expect(ledger.correctiveVerificationDebt('job-live')).toBeNull();
  });

  it('a material amendment a later amendment retracted owes no continuation', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-retract', repo: 'r', title: 't', briefing: BRIEFING });
    const material = amend(ledger, 'job-retract', 'material', 'Add the review chip.');
    expect(ledger.workRevisionState('job-retract').required).toBe(1);
    accepted(ledger.addJobAmendment({
      jobId: 'job-retract', body: 'Retracted: the chip is out of scope.', supersedes: [`amendment:${material.id}`],
      approval: { by: 'gru', reference: 'j-retract' }, expectedContractSha256: ledger.effectiveContract('job-retract')!.contractSha256,
      effect: 'administrative',
    }));
    expect(ledger.workRevisionState('job-retract')).toEqual({ required: 0, delivered: 0 });
  });

  it('after a superseded round the corrected delivery is offered a fresh review even on the same SHA', async () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-same', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-same', 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-same', payload: { sha: 'same-sha' } });
    ledger.setJobPr('job-same', 'https://github.com/acme/fixture/pull/11');
    ledger.setJobStatus('job-same', 'in-review');
    const round = ledger.addRound({ jobId: 'job-same', targetRef: 'same-sha', lenses: ['blind'] });
    ledger.setRoundStatus(round.id, 'live');
    amend(ledger, 'job-same', 'material', 'A process-only correction: no code change needed.');
    ledger.appendCustomEvent({ kind: 'round.superseded', jobId: 'job-same', roundId: round.id, payload: { reason: 'material' } });
    ledger.setRoundStatus(round.id, 'aborted');
    // The continuation delivers the SAME head, stamped with the revision.
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-same', payload: { sha: 'same-sha', work_revision: 1 } });
    verified(ledger, 'job-same', 'same-sha');
    const digest = await computeSilasDigest({
      ledger, blockersForRound: async () => ({ blockers: [], note: null }), config: DEFAULT_SILAS_CONFIG, trigger: 'sweep',
    });
    expect(digest.prWithoutReview.map((row) => row.jobId)).toEqual(['job-same']);
  });

  it('a failed run on the corrective head owes a repair, not a second verification of the same bytes', async () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-failed', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-failed', 'working');
    amend(ledger, 'job-failed', 'material', 'Correction.');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-failed', payload: { sha: 'hf', work_revision: 1 } });
    verified(ledger, 'job-failed', 'hf', false);
    const digest = await computeSilasDigest({
      ledger, blockersForRound: async () => ({ blockers: [], note: null }), config: DEFAULT_SILAS_CONFIG, trigger: 'sweep',
    });
    expect(digest.verificationFailures.map((row) => row.head)).toEqual(['hf']);
    expect(digest.verificationsOwed).toEqual([]);
  });

  it('the continuation is rendered at intent: a supersession accepted during the gate never withholds its body', async () => {
    const h = await plainLane('job-intent-block');
    deliver(h.ledger, h.jobId);
    const first = amend(h.ledger, h.jobId, 'material', 'FIRST-BODY');
    const gatedWave = {
      activeReview: () => null,
      assertWriterAdmissible: () => undefined,
      clearLaneForWriter: async (input: { jobId: string }) => {
        accepted(h.ledger.addJobAmendment({
          jobId: input.jobId, body: 'REPLACEMENT-BODY', supersedes: [`amendment:${first.id}`],
          approval: { by: 'gru', reference: 'j-replace' }, expectedContractSha256: h.ledger.effectiveContract(input.jobId)!.contractSha256,
          effect: 'material',
        }));
        return { jobId: input.jobId, roundIds: [], operations: 0, confirmed: true, detail: null };
      },
      supersedeReviews: async (input: { jobId: string }) => ({ jobId: input.jobId, roundIds: [], operations: 0, confirmed: true, detail: null }),
    } as unknown as WaveRunner;
    const { port, registry } = await serve({ ledger: h.ledger, wave: gatedWave, port: h.port, jobId: h.jobId });
    const res = await post(port, '/api/silas/directive', { job_id: h.jobId, directive: 'Implement.', request_id: 'block-1' });
    expect(res.json).toMatchObject({ work_revision: 1 });
    expect(await settledDirective(h.ledger, 'block-1')).toBe('settled');
    expect(registry.prompts[0]).toContain('FIRST-BODY');
    expect(registry.prompts[0]).not.toContain('NOT EFFECTIVE');
    expect(registry.prompts[0]).not.toContain('REPLACEMENT-BODY');
    expect(h.ledger.workRevisionState(h.jobId)).toEqual({ required: 2, delivered: 1 });
  });

  it('a pass recorded before a restart re-offers the queued request that waited on it', async () => {
    const h = await plainLane('job-verify-restart');
    amend(h.ledger, h.jobId, 'material', 'Correction.');
    deliver(h.ledger, h.jobId, 1);
    const queued = await h.wave.requestReview({ jobId: h.jobId, handoff: true });
    expect(queued.route).toBe('queued');
    await h.wave.shutdown();
    verified(h.ledger, h.jobId, 'fixture-settled'); // landed while no listener ran
    const restarted = new WaveRunner({
      ledger: h.ledger, worktrees: h.port, bus: new EventBus(),
      spawner: async () => {
        throw new Error('no spawn');
      },
      reviewArtifactRoot: temp('supersession-verify-restart-artifacts-'),
    });
    closers.push(() => restarted.shutdown());
    restarted.resumeQueuedHandoffs();
    for (let spins = 0; spins < 200 && h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-claimed') === null; spins += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(h.ledger.latestJobEvent(h.jobId, 'job.review-handoff-claimed')).not.toBeNull();
  });

  it('a superseded fallback gate cancelled during its fix directive still records its routine terminal', async () => {
    const h = await plainLane('job-fallback-fix');
    deliver(h.ledger, h.jobId);
    const skillPath = join(temp('supersession-fix-skill-'), 'SKILL.md');
    writeFileSync(skillPath, '---\nname: bmad-review\n---\n', 'utf8');
    let sinkEntered = false;
    const wave = new WaveRunner({
      ledger: h.ledger, worktrees: h.port,
      spawner: async () => {
        throw new Error('no spawn');
      },
      reviewArtifactRoot: temp('supersession-fix-artifacts-'),
      reviewPreflight: async () => ({ ok: false as const, failures: [{ leg: 'review-policy' as const, detail: 'off', remediation: 'on' }] }),
      fallbackGate: {
        skillPath,
        runFallbackReview: async () => [{ title: 'null deref', category: 'correctness', location: 'src/main.ts', evidence: 'x', detail: 'y' }],
        // The fix directive is mid-turn when the gate is superseded; it
        // returns delivered after the cancellation.
        fixDirectiveSink: (input) => new Promise((resolve) => {
          sinkEntered = true;
          input.signal.addEventListener('abort', () => resolve({ delivered: true as const }), { once: true });
        }),
      },
    });
    closers.push(() => wave.shutdown());
    await wave.requestReview({ jobId: h.jobId });
    for (let spins = 0; spins < 400 && !sinkEntered; spins += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    amend(h.ledger, h.jobId, 'material', 'Correction.');
    expect((await wave.supersedeReviews({ jobId: h.jobId, reason: 'material amendment', by: 'gru' })).confirmed).toBe(true);
    expect(h.ledger.latestJobEvent(h.jobId, 'job.fallback-review')?.payload).toMatchObject({ phase: 'aborted', superseded: true });
  });

  it('production proves review sessions stopped from runtime handles, never from ledger rows', () => {
    const states = new Map<string, string>([['live', 'streaming'], ['gone', 'disposed']]);
    const registry = {
      getHandle: (id: string) => (states.has(id) ? { health: () => ({ state: states.get(id)! }) } : null),
    };
    expect(liveReviewSessionIds(registry, ['live', 'gone', 'missing'])).toEqual(['live']);
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/liveReviewSessions:\s*\(agentIds\)\s*=>\s*liveReviewSessionIds\(registry,\s*agentIds\)/);
  });
});

describe('review round 4 — fences that cannot be talked around', () => {
  it('an administrative amendment during a running review supersedes nothing', async () => {
    const h = await heldReview({ mode: 'running' });
    const { port } = await serve(h);
    const roundId = h.wave.activeReview(h.jobId)!.roundIds[0]!;
    const res = await post(port, '/api/dispatch/amendment', {
      job_id: h.jobId, body: 'Typo fix in the acceptance wording.', effect: 'administrative',
      approval: { by: 'gru', reference: 'j-typo' },
      expected_contract_sha256: h.ledger.effectiveContract(h.jobId)!.contractSha256,
    });
    expect(res.json).toMatchObject({ review_supersession: 'none', work_revision: { pending: false } });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(h.ledger.getRound(roundId)?.status).toBe('live');
    expect(h.ledger.latestRoundEvent(roundId, 'round.superseded')).toBeNull();
    expect(h.liveSessions.size).toBeGreaterThan(0);
  });

  it('a re-brief whose obsolete review cannot be proven stopped is refused before any marker or prompt', async () => {
    const h = await heldReview({ mode: 'running', closeHangs: true, deadlineMs: 50 });
    const { port, registry } = await serve(h);
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    const res = await post(port, '/api/silas/rebrief', { job_id: h.jobId, note: 'fresh worker' });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: 'review_supersession_unconfirmed' });
    expect(h.ledger.listPendingRebriefs({ jobId: h.jobId })).toEqual([]);
    expect(registry.prompts).toEqual([]);
  });

  it('a pending-revision refusal never advises force', async () => {
    const h = await plainLane('job-hint');
    deliver(h.ledger, h.jobId);
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    const { port } = await serve(h);
    const res = await post(port, '/api/dispatch/review', { job_id: h.jobId, by: 'silas' });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({
      error: 'branch_busy',
      blockers: [{ job_id: h.jobId, required_revision: 1, delivered_revision: 0 }],
    });
    expect(String(res.json['hint'])).toMatch(/force cannot review an obsolete candidate/);
    expect(String(res.json['hint'])).not.toMatch(/or dispatch with force/);
  });

  it('a pass recorded before the approved correction does not pay the corrective debt, even on the same bytes', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-prior', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-prior', 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-prior', payload: { sha: 'same' } });
    verified(ledger, 'job-prior', 'same'); // before the amendment
    amend(ledger, 'job-prior', 'material', 'Correction needing no code change.');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-prior', payload: { sha: 'same', work_revision: 1 } });
    expect(ledger.correctiveVerificationDebt('job-prior')).toEqual({ revision: 1, head: 'same' });
    // A live round of ANOTHER head does not admit the corrected work either.
    const other = ledger.addRound({ jobId: 'job-prior', targetRef: 'other-head', lenses: ['blind'] });
    ledger.setRoundStatus(other.id, 'live');
    expect(ledger.correctiveVerificationDebt('job-prior')).toEqual({ revision: 1, head: 'same' });
    verified(ledger, 'job-prior', 'same');
    expect(ledger.correctiveVerificationDebt('job-prior')).toBeNull();
  });

  it('a correction delivered after a READY verdict is offered a fresh review even on the same SHA', async () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-ready', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-ready', 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-ready', payload: { sha: 'ready-sha' } });
    ledger.setJobPr('job-ready', 'https://github.com/acme/fixture/pull/12');
    ledger.setJobStatus('job-ready', 'in-review');
    const round = ledger.addRound({ jobId: 'job-ready', targetRef: 'ready-sha', lenses: ['blind'] });
    ledger.appendCustomEvent({
      kind: 'round.review-inputs-frozen', jobId: 'job-ready', roundId: round.id,
      payload: { acceptance: { version: 0 }, evidence: [], ci: { state: 'unavailable' } },
    });
    ledger.setRoundStatus(round.id, 'live');
    ledger.setRoundVerdict(round.id, 'approved');
    amend(ledger, 'job-ready', 'material', 'Owner changed a requirement after READY; already satisfied by the code.');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-ready', payload: { sha: 'ready-sha', work_revision: 1 } });
    verified(ledger, 'job-ready', 'ready-sha');
    const digest = await computeSilasDigest({
      ledger, blockersForRound: async () => ({ blockers: [], note: null }), config: DEFAULT_SILAS_CONFIG, trigger: 'sweep',
    });
    expect(digest.prWithoutReview.map((row) => row.jobId)).toEqual(['job-ready']);
  });

  it('a provider claim re-proves review ownership in the same tick as its claim', async () => {
    const h = await plainLane('job-provider-race');
    const claims: string[] = [];
    let admitted = false;
    const racingWave = {
      activeReview: () => (admitted ? { roundIds: ['raced-r1'], operations: 1 } : null),
      assertWriterAdmissible: () => undefined,
      clearLaneForWriter: async (input: { jobId: string }) => {
        admitted = true; // a review arms while the gate awaits
        return { jobId: input.jobId, roundIds: [], operations: 0, confirmed: true, detail: null };
      },
      supersedeReviews: async (input: { jobId: string }) => ({ jobId: input.jobId, roundIds: [], operations: 0, confirmed: true, detail: null }),
    } as unknown as WaveRunner;
    const { port } = await serve({ ledger: h.ledger, wave: racingWave, port: h.port, jobId: h.jobId }, { providerClaims: claims });
    h.ledger.recordProviderWait({
      id: 'wait-race', routeKey: 'route-r', provider: 'p', model: 'm', endpoint: 'e', credentialFingerprint: 'fp',
      waiterKind: 'job-minion', jobId: h.jobId, agentId: null, slotId: null, sessionFile: null, continuation: null,
      jobStatusAtEstablishment: 'working', lineageKey: null, incidentId: 'incident-r', incidentGeneration: 1,
      reasonClass: 'temporary-limit',
    });
    const res = await post(port, '/api/silas/provider-recovery/claim', { wait_id: 'wait-race', by: 'silas' });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: 'review_in_progress', round_ids: ['raced-r1'] });
    expect(claims).toEqual([]);
  });
});

describe('review round 5 — nothing strands the heist', () => {
  it('a correction retracted after it superseded the review re-offers a review of the standing delivery', async () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-retracted', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-retracted', 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-retracted', payload: { sha: 'stand-sha' } });
    ledger.setJobPr('job-retracted', 'https://github.com/acme/fixture/pull/13');
    ledger.setJobStatus('job-retracted', 'in-review');
    const round = ledger.addRound({ jobId: 'job-retracted', targetRef: 'stand-sha', lenses: ['blind'] });
    // The arm that started the round is newer than the standing delivery.
    ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'job-retracted', payload: { route: 'perkins', round_id: round.id } });
    ledger.setRoundStatus(round.id, 'live');
    const material = amend(ledger, 'job-retracted', 'material', 'Add the review chip.');
    ledger.appendCustomEvent({ kind: 'round.superseded', jobId: 'job-retracted', roundId: round.id, payload: { reason: 'material' } });
    ledger.setRoundStatus(round.id, 'aborted');
    const digest = () => computeSilasDigest({
      ledger, blockersForRound: async () => ({ blockers: [], note: null }), config: DEFAULT_SILAS_CONFIG, trigger: 'sweep',
    });
    expect((await digest()).prWithoutReview).toEqual([]); // the correction is owed first
    accepted(ledger.addJobAmendment({
      jobId: 'job-retracted', body: 'Retracted: no chip.', supersedes: [`amendment:${material.id}`],
      approval: { by: 'gru', reference: 'j-retract-2' }, expectedContractSha256: ledger.effectiveContract('job-retracted')!.contractSha256,
      effect: 'administrative',
    }));
    expect((await digest()).prWithoutReview.map((row) => row.jobId)).toEqual(['job-retracted']);
  });

  it('a pending revision fences a review of a FOREIGN target too, and force cannot waive it', async () => {
    const h = await plainLane('job-foreign-target');
    deliver(h.ledger, h.jobId);
    amend(h.ledger, h.jobId, 'material', 'Approved correction.');
    for (const force of [false, true]) {
      await expect(h.wave.requestReview({ jobId: h.jobId, targetRef: 'main', ...(force ? { force: true } : {}) }))
        .rejects.toThrow(/force cannot review an obsolete candidate/);
    }
    const refusal = h.ledger.latestJobEvent(h.jobId, 'branch-idle.refused');
    expect(refusal?.payload).toMatchObject({ forced: false, blockers: [{ jobId: h.jobId, revision: { required: 1, delivered: 0 } }] });
    expect(h.ledger.listRounds(h.jobId)).toHaveLength(0);
  });
});

describe('review round 6 — READY binds to the reviewed contract', () => {
  const SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
  const PR_URL = 'https://github.com/example/demo/pull/7';

  function stageReady(api: LedgerApi, id: string, frozenVersion: number): string {
    api.addJob({ id, repo: 'demo', title: `Heist ${id}`, briefing: BRIEFING });
    api.setJobPr(id, PR_URL);
    api.setJobStatus(id, 'working');
    api.setJobStatus(id, 'in-review');
    approveRound(api, id, frozenVersion);
    api.appendCustomEvent({
      kind: 'github.branch-state', jobId: id,
      payload: {
        repo: 'example/demo', branch: `gru/${id}`, sha: SHA, merged: false, pr_open: true, mergeable_state: 'clean',
        pr_number: 7, pr_url: PR_URL, merge_commit_sha: null,
        ci: { sha: SHA, status: 'green', signature: '', failures: [], checks: ['ci'] },
      },
    });
    return id;
  }

  function approveRound(api: LedgerApi, id: string, frozenVersion: number): void {
    const round = api.addRound({ jobId: id, targetRef: SHA, lenses: ['blind'] });
    api.appendCustomEvent({
      kind: 'round.review-inputs-frozen', jobId: id, roundId: round.id,
      payload: { acceptance: { version: frozenVersion }, evidence: [], ci: { state: 'green' } },
    });
    api.setRoundStatus(round.id, 'live');
    api.setRoundVerdict(round.id, 'approved');
  }

  it('a material amendment withdraws READY until a review of the corrected contract approves it', () => {
    const db = new LedgerDb(temp('supersession-ready-db-'));
    closers.push(async () => db.close());
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    const engine = new BoardEngine({ ledger: api, bus });
    stageReady(api, 'job-ready-gate', 0);
    expect(engine.snapshot().ownerPrs.map((row) => row.jobId)).toEqual(['job-ready-gate']);
    amend(api, 'job-ready-gate', 'material', 'Owner changed a requirement after READY.');
    expect(engine.snapshot().ownerPrs).toEqual([]); // correction pending delivery
    api.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-ready-gate', payload: { sha: SHA, work_revision: 1 } });
    expect(engine.snapshot().ownerPrs).toEqual([]); // the approval judged contract version 0
    approveRound(api, 'job-ready-gate', 1);
    expect(engine.snapshot().ownerPrs.map((row) => row.jobId)).toEqual(['job-ready-gate']);
    // An administrative amendment never withdraws READY.
    amend(api, 'job-ready-gate', 'administrative', 'Typo.');
    expect(engine.snapshot().ownerPrs.map((row) => row.jobId)).toEqual(['job-ready-gate']);
  });
});

describe('review round 6 — verification evidence and explicit targets', () => {
  it('a dirty-tree pass never pays the corrective debt', () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-dirty', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-dirty', 'working');
    amend(ledger, 'job-dirty', 'material', 'Correction.');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-dirty', payload: { sha: 'hd', work_revision: 1 } });
    ledger.appendCustomEvent({
      kind: 'verification.completed', jobId: 'job-dirty',
      payload: { run_id: 'dirty-1', scope: 'unit', sha: 'hd', ok: true, exit_code: 0, tracked_dirty: true },
    });
    expect(ledger.correctiveVerificationDebt('job-dirty')).toEqual({ revision: 1, head: 'hd' });
    verified(ledger, 'job-dirty', 'hd');
    expect(ledger.correctiveVerificationDebt('job-dirty')).toBeNull();
  });

  it('a retracted correction re-offers the standing delivery after a superseded FALLBACK gate too', async () => {
    const { ledger } = bootLedger();
    ledger.addJob({ id: 'job-fb-retract', repo: 'r', title: 't', briefing: BRIEFING });
    ledger.setJobStatus('job-fb-retract', 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-fb-retract', payload: { sha: 'fb-sha' } });
    ledger.setJobPr('job-fb-retract', 'https://github.com/acme/fixture/pull/14');
    ledger.setJobStatus('job-fb-retract', 'in-review');
    ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: 'job-fb-retract', payload: { phase: 'engaged' } });
    const material = amend(ledger, 'job-fb-retract', 'material', 'Correction.');
    ledger.appendCustomEvent({ kind: 'job.review-superseded', jobId: 'job-fb-retract', payload: { route: 'bmad-review-fallback' } });
    ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: 'job-fb-retract', payload: { phase: 'aborted', superseded: true } });
    accepted(ledger.addJobAmendment({
      jobId: 'job-fb-retract', body: 'Retracted.', supersedes: [`amendment:${material.id}`],
      approval: { by: 'gru', reference: 'j-fb' }, expectedContractSha256: ledger.effectiveContract('job-fb-retract')!.contractSha256,
      effect: 'administrative',
    }));
    const digest = await computeSilasDigest({
      ledger, blockersForRound: async () => ({ blockers: [], note: null }), config: DEFAULT_SILAS_CONFIG, trigger: 'sweep',
    });
    expect(digest.prWithoutReview.map((row) => row.jobId)).toEqual(['job-fb-retract']);
  });

  it('an unpaid corrective verification fences an explicit foreign target', async () => {
    const h = await plainLane('job-verify-foreign');
    amend(h.ledger, h.jobId, 'material', 'Correction.');
    deliver(h.ledger, h.jobId, 1);
    await expect(h.wave.requestReview({ jobId: h.jobId, targetRef: 'main' })).rejects.toThrow(/is busy/);
    expect(h.ledger.latestJobEvent(h.jobId, 'branch-idle.refused')?.payload).toMatchObject({
      forced: false, blockers: [{ jobId: h.jobId, verification: { revision: 1, head: 'fixture-settled' } }],
    });
    expect(h.ledger.listRounds(h.jobId)).toHaveLength(0);
  });

  it('owner force MAY review over an unpaid verification (the escape hatch), audited — unlike a pending revision', async () => {
    const h = await plainLane('job-verify-force');
    amend(h.ledger, h.jobId, 'material', 'Correction.');
    deliver(h.ledger, h.jobId, 1);
    const outcome = await h.wave.requestReview({ jobId: h.jobId, force: true });
    expect(outcome.route).toBe('perkins');
    if (outcome.route === 'perkins') await outcome.run.catch(() => undefined);
    expect(h.ledger.latestJobEvent(h.jobId, 'branch-idle.forced')?.payload).toMatchObject({
      forced: true, blockers: [{ jobId: h.jobId, verification: { revision: 1 } }],
    });
    expect(h.ledger.listRounds(h.jobId)).toHaveLength(1);
  });
});
