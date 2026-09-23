import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, DEFAULT_LENSES } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-ledger-api-'));
  cleanupDirs.push(dir);
  return dir;
}

describe('ledger api — the record of state', () => {
  let api: LedgerApi;
  let bus: EventBus;
  let db: LedgerDb;

  beforeAll(() => {
    db = new LedgerDb(tmpDir());
    bus = new EventBus();
    api = new LedgerApi(db.handle, { bus });
  });

  it('addJob creates a dispatched job and appends a job.created event (row + event atomic)', () => {
    const job = api.addJob({ id: 'fix-login-flow', repo: 'billing-api', title: 'Fix the login flow regression' });
    expect(job.status).toBe('dispatched');
    const events = api.listEvents();
    expect(events.some((e) => e.kind === 'job.created' && e.jobId === 'fix-login-flow')).toBe(true);
  });

  it('duplicate job ids and empty fields are rejected', () => {
    expect(() => api.addJob({ id: 'fix-login-flow', repo: 'x', title: 'dup' })).toThrow(/already exists/u);
    expect(() => api.addJob({ id: '', repo: 'x', title: 'empty id' })).toThrow(/non-empty/u);
    for (const unsafe of ['../escape', 'a/b', '.hidden', '-lead', 'has space', 'a'.repeat(129), '.', '..']) {
      expect(() => api.addJob({ id: unsafe, repo: 'x', title: 'unsafe id' })).toThrow(/safe 128-character record identifier/u);
    }
    expect(api.addJob({ id: 'a'.repeat(128), repo: 'x', title: 'boundary' }).id).toHaveLength(128);
  });

  it('legal job transitions walk the machine; every hop appends an event', () => {
    api.setJobStatus('fix-login-flow', 'working');
    api.setJobStatus('fix-login-flow', 'in-review');
    const job = api.setJobStatus('fix-login-flow', 'merged');
    expect(job.status).toBe('merged');
    const hops = api.listEvents().filter((e) => e.kind === 'job.status' && e.jobId === 'fix-login-flow');
    // listEvents is newest-first; reverse for chronological reads.
    expect(hops.map((e) => (e.payload as { to: string }).to).reverse()).toEqual(['working', 'in-review', 'merged']);
  });

  it('terminal job states are terminal; illegal transitions throw and change nothing', () => {
    const before = api.getJob('fix-login-flow');
    expect(() => api.setJobStatus('fix-login-flow', 'working')).toThrow(/illegal transition merged → working/u);
    expect(api.getJob('fix-login-flow')).toEqual(before); // untouched
    api.addJob({ id: 'docs-pass', repo: 'billing-api', title: 'Docs pass' });
    expect(() => api.setJobStatus('docs-pass', 'merged')).toThrow(/illegal transition dispatched → merged/u);
    expect(() => api.setJobStatus('docs-pass', 'not-a-status' as never)).toThrow(/unknown job status/u);
    expect(() => api.setJobStatus('no-such-job', 'working')).toThrow(/not found/u);
  });

  it('blocked and parked are recoverable side states', () => {
    api.setJobStatus('docs-pass', 'working');
    api.setJobStatus('docs-pass', 'blocked');
    api.setJobStatus('docs-pass', 'working'); // resume
    api.setJobStatus('docs-pass', 'parked');
    api.setJobStatus('docs-pass', 'working'); // resume from park
    expect(api.getJob('docs-pass')?.status).toBe('working');
  });

  it('the delivered arc: working → delivered → in-review, with delivered side-hops', () => {
    api.addJob({ id: 'deliver-truth', repo: 'billing-api', title: 'Deliver the truth' });
    api.setJobStatus('deliver-truth', 'working');
    const delivered = api.setJobStatus('deliver-truth', 'delivered');
    expect(delivered.status).toBe('delivered');
    expect(api.setJobStatus('deliver-truth', 'in-review').status).toBe('in-review');
    const hops = api.listEvents().filter((e) => e.kind === 'job.status' && e.jobId === 'deliver-truth');
    expect(hops.map((e) => (e.payload as { to: string }).to).reverse()).toEqual(['working', 'delivered', 'in-review']);

    // delivered's recoverable side-hops and its terminal done.
    api.addJob({ id: 'deliver-blocked', repo: 'billing-api', title: 'Blocked after delivery' });
    api.setJobStatus('deliver-blocked', 'working');
    api.setJobStatus('deliver-blocked', 'delivered');
    expect(api.setJobStatus('deliver-blocked', 'blocked').status).toBe('blocked');

    api.addJob({ id: 'deliver-parked', repo: 'billing-api', title: 'Parked after delivery' });
    api.setJobStatus('deliver-parked', 'working');
    api.setJobStatus('deliver-parked', 'delivered');
    expect(api.setJobStatus('deliver-parked', 'parked').status).toBe('parked');

    api.addJob({ id: 'deliver-done', repo: 'billing-api', title: 'Done after delivery' });
    api.setJobStatus('deliver-done', 'working');
    api.setJobStatus('deliver-done', 'delivered');
    expect(api.setJobStatus('deliver-done', 'done').status).toBe('done');
    expect(() => api.setJobStatus('deliver-done', 'working')).toThrow(/illegal transition done → working/u);
  });

  it('delivered is never a regression target — only working may enter it', () => {
    api.addJob({ id: 'no-regress', repo: 'billing-api', title: 'No regression' });
    api.setJobStatus('no-regress', 'working');
    api.setJobStatus('no-regress', 'in-review');
    expect(() => api.setJobStatus('no-regress', 'delivered')).toThrow(/illegal transition in-review → delivered/u);

    const blockedJob = api.addJob({ id: 'blocked-no-deliver', repo: 'billing-api', title: 'Blocked' });
    api.setJobStatus(blockedJob.id, 'working');
    api.setJobStatus(blockedJob.id, 'blocked');
    expect(() => api.setJobStatus(blockedJob.id, 'delivered')).toThrow(/illegal transition blocked → delivered/u);

    const parkedJob = api.addJob({ id: 'parked-no-deliver', repo: 'billing-api', title: 'Parked' });
    api.setJobStatus(parkedJob.id, 'working');
    api.setJobStatus(parkedJob.id, 'parked');
    expect(() => api.setJobStatus(parkedJob.id, 'delivered')).toThrow(/illegal transition parked → delivered/u);

    const dispatchedJob = api.addJob({ id: 'dispatched-no-deliver', repo: 'billing-api', title: 'Dispatched' });
    expect(() => api.setJobStatus(dispatchedJob.id, 'delivered')).toThrow(/illegal transition dispatched → delivered/u);
  });

  it('notes and PR URLs land on the row + event log', () => {
    api.noteJob('docs-pass', 'waiting on the base sync');
    api.setJobPr('docs-pass', 'https://example.invalid/pr/7');
    const job = api.getJob('docs-pass');
    expect(job?.note).toBe('waiting on the base sync');
    expect(job?.prUrl).toBe('https://example.invalid/pr/7');
    expect(api.listEvents().some((e) => e.kind === 'job.pr' && e.jobId === 'docs-pass')).toBe(true);
  });

  it('addRound defaults to exactly the 7 standard lenses, all pending', () => {
    const round = api.addRound({ jobId: 'fix-login-flow', targetRef: 'abc123' });
    expect(round.seq).toBe(1);
    expect(round.id).toBe('fix-login-flow-r1');
    expect(round.lenses.map((chip) => chip.lens)).toEqual([...DEFAULT_LENSES]);
    expect(round.lenses.every((chip) => chip.state === 'pending')).toBe(true);
    expect(round.targetRef).toBe('abc123');
  });

  it('custom lens lists are honored but must be unique and non-empty', () => {
    const round = api.addRound({ jobId: 'fix-login-flow', lenses: ['alpha', 'beta'] });
    expect(round.lenses.map((chip) => chip.lens)).toEqual(['alpha', 'beta']);
    expect(() => api.addRound({ jobId: 'fix-login-flow', lenses: ['alpha', 'alpha'] })).toThrow(/unique/u);
    expect(() => api.addRound({ jobId: 'fix-login-flow', lenses: [''] })).toThrow(/non-empty/u);
    expect(() => api.addRound({ jobId: 'nope', lenses: ['a'] })).toThrow(/not found/u);
  });

  it('round seq numbers continue within a job; verdicts are validated', () => {
    const r2 = api.addRound({ jobId: 'fix-login-flow' });
    expect(r2.seq).toBe(3); // r1 (default lenses) + custom round came first
    expect(() => api.setRoundVerdict(r2.id, 'meh' as never)).toThrow(/unknown round verdict/u);
    api.setRoundStatus(r2.id, 'live');
    const posted = api.setRoundVerdict(r2.id, 'approved');
    expect(posted.verdict).toBe('approved');
    expect(posted.status).toBe('verdict-posted'); // a posted verdict IS the verdict-posted state
    expect(() => api.setRoundStatus(r2.id, 'live')).toThrow(/illegal transition verdict-posted → live/u);
  });

  it('agents upsert: register, then state updates with events; last_activity refreshes', () => {
    api.registerAgent({ id: 'agent-one', role: 'minion', label: 'fix-login worker', jobId: 'fix-login-flow' });
    let agent = api.getAgent('agent-one');
    expect(agent?.state).toBe('spawning');
    api.setAgentState('agent-one', 'streaming');
    agent = api.setAgentState('agent-one', 'idle'); // same-state: activity only
    expect(agent.state).toBe('idle');
    expect(agent.lastActivity).not.toBeNull();
    const hops = api.listEvents().filter((e) => e.kind === 'agent.state' && e.agentId === 'agent-one');
    expect(hops.map((e) => (e.payload as { to: string }).to).reverse()).toEqual(['streaming', 'idle']);
    expect(() => api.setAgentState('ghost', 'idle')).toThrow(/not found/u);
  });

  it('lens binding + outcome transitions; unknown rounds/lenses fail loud', () => {
    api.registerAgent({ id: 'lens-blind', role: 'perkins', roundId: 'fix-login-flow-r1' });
    let round = api.bindLens('fix-login-flow-r1', 'blind', 'lens-blind');
    expect(round.lenses.find((chip) => chip.lens === 'blind')?.agentId).toBe('lens-blind');
    round = api.setLensOutcome('fix-login-flow-r1', 'blind', 'live');
    expect(round.lenses.find((chip) => chip.lens === 'blind')?.state).toBe('live');
    round = api.setLensOutcome('fix-login-flow-r1', 'blind', 'done', 'verdict json on disk');
    expect(round.lenses.find((chip) => chip.lens === 'blind')?.note).toBe('verdict json on disk');
    expect(() => api.setLensOutcome('fix-login-flow-r1', 'blind', 'pending')).toThrow(/illegal transition done → pending/u);
    expect(() => api.bindLens('fix-login-flow-r1', 'nope', 'x')).toThrow(/no lens/u);
    expect(() => api.setLensOutcome('no-such-round', 'blind', 'done')).toThrow(/not found/u);
    expect(api.listEvents().some((e) => e.kind === 'lens.bound' && e.lens === 'blind')).toBe(true);
  });

  it('markLensLive is idempotent (no duplicate events) and skips resolved chips', () => {
    const before = api.listEvents().filter((e) => e.kind === 'lens.status').length;
    api.bindLens('fix-login-flow-r1', 'edge', 'lens-blind');
    api.markLensLive('fix-login-flow-r1', 'edge'); // → live (event)
    api.markLensLive('fix-login-flow-r1', 'edge'); // already live (no event)
    api.markLensLive('fix-login-flow-r1', 'blind'); // done (no event)
    const after = api.listEvents().filter((e) => e.kind === 'lens.status').length;
    expect(after - before).toBe(1);
  });

  it('every mutation publishes on the bus with the ledger event row', () => {
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.kind));
    api.addJob({ id: 'bus-check', repo: 'r', title: 't' });
    api.setJobStatus('bus-check', 'working');
    unsubscribe();
    expect(seen).toContain('job.created');
    expect(seen).toContain('job.status');
    // And after unsubscribe, no more events arrive.
    const seenAfter = seen.length;
    api.noteJob('bus-check', 'note');
    expect(seen.length).toBe(seenAfter);
  });

  it('listJobs groups by repo when filtered; jobs list across repos newest-first', () => {
    api.addJob({ id: 'other-repo-job', repo: 'website', title: 'Copy pass' });
    const billing = api.listJobs('billing-api');
    expect(billing.every((job) => job.repo === 'billing-api')).toBe(true);
    expect(billing.map((job) => job.id)).toContain('fix-login-flow');
    const all = api.listJobs();
    expect(all.length).toBeGreaterThanOrEqual(4);
  });

  it('rolled-back transactions publish NOTHING on the bus (no phantom events)', () => {
    const dir2 = tmpDir();
    const db2 = new LedgerDb(dir2);
    const bus2 = new EventBus();
    const seen2: string[] = [];
    bus2.subscribe((event) => seen2.push(event.kind));
    const api2 = new LedgerApi(db2.handle, { bus: bus2 });
    api2.addJob({ id: 'phantom-job', repo: 'r', title: 't' });
    api2.setJobStatus('phantom-job', 'working');
    const round = api2.addRound({ jobId: 'phantom-job' }); // pending
    const kindsBefore = seen2.length;
    // A verdict on a PENDING round fails loudly (the machine refuses):
    // the round.verdict event was appended inside the txn, then the
    // pending→verdict-posted transition throws → FULL rollback.
    expect(() => api2.setRoundVerdict(round.id, 'approved')).toThrow(
      /illegal transition pending → verdict-posted/u,
    );
    // Nothing published, nothing written — the rollback left no trace.
    expect(seen2.length).toBe(kindsBefore);
    expect(api2.getRound(round.id)?.verdict).toBeNull();
    expect(api2.getRound(round.id)?.status).toBe('pending');
    expect(
      api2.listEvents().some((e) => e.kind === 'round.verdict' && e.roundId === round.id),
    ).toBe(false);
    db2.close();
  });

  it('bindLens backfills the agent round/job wiring (the one-call chip↔agent connection)', () => {
    // A tap-shape registration: no round/job context at spawn time.
    api.registerAgent({ id: 'wire-agent', role: 'perkins' });
    const job = api.addJob({ id: 'wire-job', repo: 'demo-repo', title: 'Wiring' });
    const round = api.addRound({ jobId: job.id, lenses: ['edge'] });
    api.bindLens(round.id, 'edge', 'wire-agent');
    const agent = api.getAgent('wire-agent');
    expect(agent?.roundId).toBe(round.id);
    expect(agent?.jobId).toBe(job.id);
    expect(api.listLensBindings('wire-agent')).toEqual([{ roundId: round.id, lens: 'edge' }]);
  });

  it('listEventsAfter + latestEventSeq: bounded windows strictly after a cursor', () => {
    const base = api.latestEventSeq();
    expect(base).toBeGreaterThan(0);
    const first = api.appendCustomEvent({ kind: 'digest.one', payload: { n: 1 } });
    const second = api.appendCustomEvent({ kind: 'digest.two', payload: { n: 2 } });
    const third = api.appendCustomEvent({ kind: 'digest.three', payload: { n: 3 } });
    expect(api.latestEventSeq()).toBe(third.seq);
    // Strictly-after + oldest-first by default.
    expect(api.listEventsAfter(base).map((e) => e.seq)).toEqual([first.seq, second.seq, third.seq]);
    expect(api.listEventsAfter(first.seq).map((e) => e.kind)).toEqual(['digest.two', 'digest.three']);
    // Newest-first + limit = the window shape the digest reads.
    expect(api.listEventsAfter(base, { order: 'desc', limit: 2 }).map((e) => e.seq)).toEqual([
      third.seq,
      second.seq,
    ]);
    // Kind filter narrows the scan (notification events for action notes).
    expect(api.listEventsAfter(base, { kinds: ['digest.two'] }).map((e) => e.seq)).toEqual([second.seq]);
    expect(api.listEventsAfter(third.seq)).toEqual([]);
  });

  it('listJobEvents/latestJobEvent scope the stream to one job (ops digest queries)', () => {
    api.addJob({ id: 'scoped-events', repo: 'billing-api', title: 'scope check' });
    api.appendCustomEvent({ kind: 'silas.wake', jobId: 'scoped-events', payload: { n: 1 } });
    api.appendCustomEvent({ kind: 'silas.wake', jobId: 'scoped-events', payload: { n: 2 } });
    api.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'scoped-events', payload: {} });
    api.appendCustomEvent({ kind: 'other.job', jobId: 'fix-login-flow', payload: {} });
    const events = api.listJobEvents('scoped-events');
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.every((event) => event.jobId === 'scoped-events')).toBe(true);
    // newest first: the last append (directive-sent) leads
    expect(events[0]?.kind).toBe('silas.directive-sent');
    // bounded
    expect(api.listJobEvents('scoped-events', { limit: 2 })).toHaveLength(2);
    // latest-by-kind
    const latest = api.latestJobEvent('scoped-events', 'silas.wake');
    expect((latest?.payload as { n?: number }).n).toBe(2);
    expect(api.latestJobEvent('scoped-events', 'never-happened')).toBeNull();
    expect(api.latestJobEvent('no-such-job', 'silas.wake')).toBeNull();
  });
  it('latestEventOfKinds/countEventsSince answer the board health cards (Silas wake + today)', () => {
    api.appendCustomEvent({ kind: 'silas.wake', payload: { marker: 'health-test' } });
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId: 'scoped-events', payload: { marker: 'health-test' } });
    const latestWake = api.latestEventOfKinds(['silas.wake']);
    expect(latestWake?.kind).toBe('silas.wake');
    expect((latestWake?.payload as { marker?: string }).marker).toBe('health-test');
    expect(api.latestEventOfKinds(['never.happened'])).toBeNull();
    expect(() => api.latestEventOfKinds([])).toThrow(/at least one kind/u);
    expect(
      api.countEventsSince(['silas.wake', 'silas.rebrief'], '1970-01-01T00:00:00.000Z'),
    ).toBeGreaterThanOrEqual(2);
    expect(api.countEventsSince(['silas.wake'], '2999-01-01T00:00:00.000Z')).toBe(0);
    expect(
      api.countEventsSince(['silas.rebrief'], '1970-01-01T00:00:00.000Z'),
    ).toBeGreaterThanOrEqual(1);
    expect(() => api.countEventsSince([], '1970-01-01T00:00:00.000Z')).toThrow(/at least one kind/u);
  });
  it('a restarted ledger (same file) serves the full record — the board rebuilds from it', () => {
    db.close();
    const dataDir = cleanupDirs[0] as string; // the dir from beforeAll
    const db2 = new LedgerDb(dataDir);
    const api2 = new LedgerApi(db2.handle, { bus: new EventBus() });
    const job = api2.getJob('fix-login-flow');
    expect(job?.status).toBe('merged');
    const rounds = api2.listRounds('fix-login-flow');
    expect(rounds[0]?.lenses.find((chip) => chip.lens === 'blind')?.state).toBe('done');
    expect(api2.getAgent('agent-one')?.state).toBe('idle');
    expect(api2.listEvents().length).toBeGreaterThan(10);
    db2.close();
  });

});
