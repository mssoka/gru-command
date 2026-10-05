import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  reconcileDurableWork,
  type DurableReconcileReport,
} from '../src/dispatch/durable-reconcile.js';
import { settleDirectivesFromEvidence } from '../src/dispatch/rebrief-recovery.js';
import type { FollowThroughNotifications } from '../src/dispatch/obligations.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function freshLedger(): { api: LedgerApi } {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-durable-reconcile-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  const api = new LedgerApi(db.handle, { bus: new EventBus() });
  return { api };
}

interface Post {
  readonly kind: string;
  readonly routing: string;
  readonly title: string;
}

function fakeNotifications(posts: Post[]): FollowThroughNotifications {
  return {
    postIncident: (input) => {
      posts.push({ kind: input.kind, routing: input.routing, title: input.title });
      return { id: `notice-${posts.length}` };
    },
  };
}

/** A live directive request whose correlated admission+delivery exist. */
function seedCorrelatedDirective(api: LedgerApi, jobId: string, requestId: string, directive = 'repair the thing'): void {
  api.beginDirectiveIntent({ jobId, directive, holder: 'silas-ops', requestId });
  const sent = api.appendCustomEvent({
    kind: 'silas.directive-sent',
    jobId,
    payload: { request_id: requestId, minion_id: `minion-${requestId}` },
  });
  api.recordDirectiveAdmission({ requestId, minionId: `minion-${requestId}`, eventSeq: sent.seq });
  api.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { request_id: requestId, source: 'silas-directive' } });
}

/** A marked phase handoff awaiting its correlated completion. */
function seedMarkedPhase(api: LedgerApi, jobId: string, decision: string): string {
  const phase = api.beginPhaseHandoff({
    jobId,
    source: 'silas-rebrief',
    intent: { kind: 'gru-decision', decision },
  }).record;
  api.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { phase_id: phase.phaseId } });
  api.appendCustomEvent({
    kind: 'job.delivered',
    jobId,
    payload: { phase_id: phase.phaseId, source: 'silas-rebrief', sha: 'head-1' },
  });
  return phase.phaseId;
}

describe('durable reconciliation pass (issue #163)', () => {
  it('settles a directive from its own correlated evidence and is idempotent', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    api.addJob({ id: 'job-dir', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus('job-dir', 'working');
    seedCorrelatedDirective(api, 'job-dir', 'req-1');

    const first = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) });
    expect(first.directives.examined).toBe(1);
    expect(first.directives.completed).toBe(1);
    expect(first.advanced).toBe(1);
    expect(api.getDirective('req-1')?.state).toBe('settled');
    // A settlement is a durable machine action marker (health projection).
    expect(
      api.listEvents({ limit: 50 }).filter((event) => event.kind === 'silas.directive-settled'),
    ).toHaveLength(1);

    // A replay performs no further transition and posts nothing new.
    const second: DurableReconcileReport = reconcileDurableWork({
      ledger: api,
      notifications: fakeNotifications(posts),
    });
    expect(second.directives.examined).toBe(0); // settled rows leave the LIVE filter
    expect(second.advanced).toBe(0);
    expect(posts).toHaveLength(0); // settlement itself is not an owner/machine card
  });

  it('leaves an admission-unknown directive live, untouched and un-narrated (never replayed)', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    api.addJob({ id: 'job-unknown', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus('job-unknown', 'working');
    api.beginDirectiveIntent({ jobId: 'job-unknown', directive: 'waiting', holder: 'silas-ops', requestId: 'req-unknown' });

    const report = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) });
    expect(report.directives.examined).toBe(1);
    expect(report.directives.completed).toBe(0);
    const row = api.getDirective('req-unknown');
    expect(row?.state).toBe('dispatching'); // visible and live — the boot pass owns escalation
    expect(row?.attempts).toBe(0); // this pass never writes boot-style reconcile notes
    expect(posts).toHaveLength(0);
    // Nothing was dispatched and no worker event was minted.
    expect(api.listEvents({ limit: 50 }).filter((event) => event.kind === 'silas.directive-sent')).toHaveLength(0);
  });

  it('completes a marked phase exactly once and publishes ONE action-required hand-back', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    const job = api.addJob({ id: 'job-phase', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus(job.id, 'working');
    const phaseId = seedMarkedPhase(api, job.id, 'rule on the completed audit');

    const first = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) });
    expect(first.phases.completed).toBe(1);
    expect(first.phases.published).toBe(1);
    expect(api.getPhaseHandoff(phaseId)?.state).toBe('completed');
    const obligations = api.listObligations({ jobId: job.id });
    expect(obligations).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.routing).toBe('action-required');
    expect(posts[0]?.title).toContain(job.id);

    const second = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) });
    expect(second.phases.completed).toBe(0);
    expect(second.phases.published).toBe(0);
    expect(api.listObligations({ jobId: job.id })).toHaveLength(1);
    expect(posts).toHaveLength(1); // never re-posts a second card
  });

  it('does not reopen a parked/terminal lane and does not touch an owned worker (no dispatch, no await)', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    api.addJob({ id: 'job-parked', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus('job-parked', 'parked');
    const phaseId = seedMarkedPhase(api, 'job-parked', 'should stay suspended');

    const report = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) });
    // The parked guard suspends the debt and closes the intent without a
    // hand-back card: an owner stop is never a machine decision.
    expect(api.getPhaseHandoff(phaseId)?.state).toBe('closed');
    expect(api.listObligations({ jobId: 'job-parked' }).every((row) => row.state === 'suspended')).toBe(true);
    expect(posts).toHaveLength(0);
    expect(report.phases.closed).toBe(1);
  });

  it('pages with a durable round-robin cursor: a settled prefix never starves later eligible phases', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    const job = api.addJob({ id: 'job-fair', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus(job.id, 'working');
    const phases = [1, 2, 3, 4, 5].map((n) => seedMarkedPhase(api, job.id, `decision ${n}`));

    const budget = { phasePageSize: 2, phaseMaxPages: 1 };
    const first = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) }, budget);
    const second = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) }, budget);
    const third = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) }, budget);
    const fourth = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) }, budget);

    expect([first, second, third].map((report) => report.phases.completed)).toEqual([2, 2, 1]);
    // Later rows were reached on later passes — the prefix did not starve.
    expect(phases.every((phaseId) => api.getPhaseHandoff(phaseId)?.state === 'completed')).toBe(true);
    expect(fourth.phases.examined).toBe(0);
    expect(api.listObligations({ jobId: job.id })).toHaveLength(5);
    // The cursor wrapped: the pass after the tail starts over.
    expect(fourth.phases.completed).toBe(0);
  });

  it('settles directives beyond a bounded page budget instead of re-reading the same prefix', () => {
    const { api } = freshLedger();
    // One live request per job (single-writer per lane): A and B stay live
    // with no evidence; C (the third row) has complete evidence.
    for (const id of ['job-dir-a', 'job-dir-b', 'job-dir-c']) {
      api.addJob({ id, repo: 'demo', title: 't', briefing: 'b' });
      api.setJobStatus(id, 'working');
    }
    api.beginDirectiveIntent({ jobId: 'job-dir-a', directive: 'a', holder: 'silas-ops', requestId: 'd-a' });
    api.beginDirectiveIntent({ jobId: 'job-dir-b', directive: 'b', holder: 'silas-ops', requestId: 'd-b' });
    seedCorrelatedDirective(api, 'job-dir-c', 'd-c');

    const first = settleDirectivesFromEvidence({ ledger: api }, { pageSize: 2, maxPages: 1 });
    expect(first.examined).toBe(2);
    expect(first.completed).toBe(0);
    const second = settleDirectivesFromEvidence({ ledger: api }, { pageSize: 2, maxPages: 1 });
    expect(second.examined).toBe(1);
    expect(second.completed).toBe(1);
    expect(api.getDirective('d-c')?.state).toBe('settled');
    // The prefix rows remain live (their own evidence never landed) — the
    // pass neither drops nor fabricates them.
    expect(api.getDirective('d-a')?.state).toBe('dispatching');
    expect(api.getDirective('d-b')?.state).toBe('dispatching');
  });

  it('never touches an owned worker while reconciling an unrelated lane', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    // A long worker operation: live streaming minion, lane working.
    api.addJob({ id: 'job-busy', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus('job-busy', 'working');
    api.registerAgent({ id: 'min-busy', role: 'minion', jobId: 'job-busy', sessionFile: '/tmp/busy-session' });
    api.setAgentState('min-busy', 'streaming');
    // An unrelated lane with a completed transition to settle.
    api.addJob({ id: 'job-idle', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus('job-idle', 'working');
    seedCorrelatedDirective(api, 'job-idle', 'req-idle');

    const before = api.latestEventSeq();
    const report = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) });
    expect(report.advanced).toBe(1);
    // The working lane, its agent and its session are exactly as they were:
    // reconciliation neither awaits that turn nor mints a second writer.
    expect(api.getJob('job-busy')?.status).toBe('working');
    expect(api.listAgents().find((agent) => agent.id === 'min-busy')?.state).toBe('streaming');
    expect(api.listEvents({ limit: 200 }).filter((event) => event.jobId === 'job-busy' && event.seq > before)).toEqual([]);
  });

  it('an uncorrelated or stale-head delivery never advances an awaiting phase', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    const job = api.addJob({ id: 'job-stale', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus(job.id, 'working');
    const phase = api.beginPhaseHandoff({
      jobId: job.id,
      source: 'silas-rebrief',
      intent: { kind: 'gru-decision', decision: 'rule later' },
    }).record;
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId: job.id, payload: { phase_id: phase.phaseId } });
    // A delivery for the lane with no phase correlation (an older/other
    // attempt): the phase stays awaiting — stale evidence cannot advance it.
    api.appendCustomEvent({
      kind: 'job.delivered',
      jobId: job.id,
      payload: { sha: 'other-head', source: 'silas-rebrief' },
    });

    const report = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) });
    expect(report.phases.completed).toBe(0);
    expect(api.getPhaseHandoff(phase.phaseId)?.state).toBe('awaiting');
    expect(posts).toHaveLength(0);
  });
  it('reports partial hand-back failures honestly and rotates the cursor past a failing prefix', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    for (const id of ['job-hb-1', 'job-hb-2', 'job-hb-3']) {
      api.addJob({ id, repo: 'demo', title: 't', briefing: 'b' });
      api.setJobStatus(id, 'blocked');
      api.appendCustomEvent({ kind: 'job.delivered', jobId: id, payload: { source: 'silas-directive', sha: `sha-${id}` } });
    }
    let failing = true;
    // The real NotificationCenter persists the card row (window-B dedupe is
    // ledger truth); the wrapper fails only the first candidate's backend.
    const center = new NotificationCenter({ ledger: api, bus: new EventBus() });
    const notifications: FollowThroughNotifications = {
      postIncident: (input) => {
        if (failing && input.title.includes('job-hb-1')) throw new Error('card backend down');
        posts.push({ kind: input.kind, routing: input.routing, title: input.title });
        return center.postIncident(input);
      },
    };

    // Pass 1: the first candidate's card backend fails. The report says so
    // (never ok:true) and the durable cursor moves past it.
    const first = reconcileDurableWork({ ledger: api, notifications }, { handbackLimit: 1 });
    expect(first.ok).toBe(false);
    expect(first.failures).toBeGreaterThanOrEqual(1);
    expect(first.examined).toBeGreaterThanOrEqual(2); // window A + window B
    expect(posts.some((post) => post.title.includes('job-hb-2'))).toBe(false);

    // Pass 2: the recovery works; the SAME failing prefix cannot starve the
    // later eligible hand-back.
    failing = false;
    const second = reconcileDurableWork({ ledger: api, notifications }, { handbackLimit: 1 });
    expect(second.handbacks.recovered + second.handbacks.published).toBeGreaterThanOrEqual(1);
    expect(posts.some((post) => post.title.includes('job-hb-2'))).toBe(true);

    // Pass 3: the skipped first obligation is retried once the window wraps.
    reconcileDurableWork({ ledger: api, notifications }, { handbackLimit: 1 });
    expect(posts.some((post) => post.title.includes('job-hb-1'))).toBe(true);
  });
  it('counts a phase-card failure as a failed pass (ok:false), never a green heartbeat', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    const job = api.addJob({ id: 'job-phase-fail', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus(job.id, 'working');
    const phase = api.beginPhaseHandoff({
      jobId: job.id,
      source: 'silas-rebrief',
      intent: { kind: 'gru-decision', decision: 'rule after the card backend recovers' },
    }).record;
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId: job.id, payload: { phase_id: phase.phaseId } });
    api.appendCustomEvent({
      kind: 'job.delivered',
      jobId: job.id,
      payload: { phase_id: phase.phaseId, source: 'silas-rebrief' },
    });
    const center = new NotificationCenter({ ledger: api, bus: new EventBus() });
    const notifications: FollowThroughNotifications = {
      postIncident: (input) => {
        if (input.kind.includes('job-phase-fail')) throw new Error('card backend down');
        posts.push({ kind: input.kind, routing: input.routing, title: input.title });
        return center.postIncident(input);
      },
    };
    const report = reconcileDurableWork({ ledger: api, notifications });
    expect(report.phases.failed).toBeGreaterThanOrEqual(1);
    expect(report.ok).toBe(false);
    expect(report.failures).toBeGreaterThanOrEqual(1);
    expect(posts).toHaveLength(0);
  });

  it('counts a directive-evidence failure as a failed pass (ok:false)', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    api.addJob({ id: 'job-dir-fail', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus('job-dir-fail', 'working');
    api.beginDirectiveIntent({ jobId: 'job-dir-fail', directive: 'waiting', holder: 'silas-ops', requestId: 'req-fail' });
    // A ledger read failure for the evidence lookup: the row failure is
    // counted (never a green heartbeat) and stays live for the next pass.
    const failing = new Proxy(api, {
      get(target, prop, receiver) {
        if (prop === 'latestJobEventByRequestId') {
          return () => {
            throw new Error('ledger scan failed');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as LedgerApi;
    const report = reconcileDurableWork({ ledger: failing, notifications: fakeNotifications(posts) });
    expect(report.directives.failed).toBeGreaterThanOrEqual(1);
    expect(report.ok).toBe(false);
    expect(api.getDirective('req-fail')?.state).toBe('dispatching'); // untouched, retried next pass
  });

  it('counts a malformed hand-back obligation as failed instead of silently skipping it', () => {
    const { api } = freshLedger();
    const posts: Post[] = [];
    api.addJob({ id: 'job-malformed', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus('job-malformed', 'working');
    api.recordBlockedObservation('job-malformed', {
      logicalStep: 'operation',
      category: { kind: 'unknown' },
      incidentKey: 'phase-handback@not-a-seq',
      observedAtSeq: api.latestEventSeq(),
    });
    const report = reconcileDurableWork({ ledger: api, notifications: fakeNotifications(posts) });
    expect(report.handbacks.failed).toBeGreaterThanOrEqual(1);
    expect(report.ok).toBe(false);
    expect(posts).toHaveLength(0);
  });
});
