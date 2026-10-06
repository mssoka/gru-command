import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, DEFAULT_LENSES, type PendingRebriefRecord } from '../src/ledger/api.js';
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

describe('job deliverable kind (E19 durable-write guard)', () => {
  it('refuses an unknown deliverable at addJob — direct callers share the boundary', () => {
    // Self-cleaning (never cleanupDirs: the shared registry's index 0 is
    // the main describe's beforeAll dir).
    const dir = mkdtempSync(join(tmpdir(), 'gru-ledger-deliverable-'));
    const db = new LedgerDb(dir);
    const api = new LedgerApi(db.handle);
    try {
      expect(() => api.addJob({
        id: 'bad-kind', repo: 'r', title: 't', briefing: 'b',
        deliverable: 'merge' as never,
      })).toThrow(/unknown job deliverable/);
      expect(db.handle.prepare('SELECT COUNT(*) AS n FROM jobs WHERE id = ?').get('bad-kind')).toEqual({ n: 0 });
      expect(api.addJob({ id: 'ok-kind', repo: 'r', title: 't', briefing: 'b', deliverable: 'review' }).deliverable).toBe('review');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


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

  it('retains optional heist names and bound worker identity through restart and observer updates', () => {
    const dir = tmpDir();
    const firstDb = new LedgerDb(dir);
    const first = new LedgerApi(firstDb.handle, { bus: new EventBus() });
    first.addJob({ id: 'named-heist', repo: 'fixture', title: 'Full & Detailed Heist Title', displayName: ' Wake Alerts ' });
    first.addJob({ id: 'legacy-heist', repo: 'fixture', title: 'Original title' });
    first.registerAgent({ id: 'worker-full-id', role: 'minion', jobId: 'named-heist', sessionFile: '/session' });
    first.registerAgent({ id: 'worker-full-id', role: 'minion' }); // runtime observer cannot erase the binding
    firstDb.close();
    const reopenedDb = new LedgerDb(dir);
    const reopened = new LedgerApi(reopenedDb.handle, { bus: new EventBus() });
    expect(reopened.getJob('named-heist')).toMatchObject({ title: 'Full & Detailed Heist Title', displayName: 'Wake Alerts' });
    expect(reopened.getJob('legacy-heist')?.displayName).toBeNull();
    expect(reopened.getAgent('worker-full-id')).toMatchObject({ id: 'worker-full-id', jobId: 'named-heist', sessionFile: '/session' });
    expect(() => reopened.addJob({ id: 'blank-name', repo: 'fixture', title: 'T', displayName: '  ' })).toThrow(/display name/u);
    reopenedDb.close();
  });

  it('authored names are bounded and must be visible: cap, invisible-only, emoji ok (G2/G3)', () => {
    expect(() => api.addJob({ id: 'name-over-cap', repo: 'fixture', title: 'T', displayName: 'x'.repeat(101) }))
      .toThrow(/exceeds 100 characters/u);
    // Zero-width and format-only names would render an empty card.
    expect(() => api.addJob({ id: 'name-invisible-zwsp', repo: 'fixture', title: 'T', displayName: '\u200b\u200b' }))
      .toThrow(/visible characters/u);
    expect(() => api.addJob({ id: 'name-invisible-zwj', repo: 'fixture', title: 'T', displayName: '\u200d\u200d\u200d' }))
      .toThrow(/visible characters/u);
    expect(() => api.addJob({ id: 'name-invisible-bidi', repo: 'fixture', title: 'T', displayName: '\u200e\u202e\u2066' }))
      .toThrow(/visible characters/u);
    expect(() => api.addJob({ id: 'name-invisible-marks', repo: 'fixture', title: 'T', displayName: '\u0301\u0301' }))
      .toThrow(/visible characters/u);
    const named = api.addJob({ id: 'name-emoji-ok', repo: 'fixture', title: 'T', displayName: '🧑\u200d🚀 launch' });
    expect(named.displayName).toBe('🧑\u200d🚀 launch');
    // Visible letters behind an invisible prefix are accepted and kept raw:
    // the rail ignores the controls before shortening (r5 warning), so the
    // stored authored value is never mutated to fit a display bound.
    const prefixed = api.addJob({
      id: 'name-invisible-prefix', repo: 'fixture', title: 'T',
      displayName: '\u200b'.repeat(24) + 'wake alerts',
    });
    expect(prefixed.displayName).toBe('\u200b'.repeat(24) + 'wake alerts');
    const atCap = api.addJob({ id: 'name-at-cap', repo: 'fixture', title: 'T', displayName: 'y'.repeat(100) });
    expect(atCap.displayName).toHaveLength(100);
  });

  it('job.created payload carries the authored name; legacy jobs record null (G10)', () => {
    api.addJob({ id: 'created-named', repo: 'fixture', title: 'Full title', displayName: 'short name' });
    api.addJob({ id: 'created-legacy', repo: 'fixture', title: 'Full title' });
    const named = api.latestJobEvent('created-named', 'job.created');
    const legacy = api.latestJobEvent('created-legacy', 'job.created');
    expect(named?.payload).toMatchObject({ repo: 'fixture', title: 'Full title', display_name: 'short name' });
    expect(legacy?.payload).toMatchObject({ repo: 'fixture', title: 'Full title', display_name: null });
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

  it('addRound defaults to exactly the nine-lens standard catalog, all pending', () => {
    const round = api.addRound({ jobId: 'fix-login-flow', targetRef: 'abc123' });
    expect(round.seq).toBe(1);
    expect(round.id).toBe('fix-login-flow-r1');
    // The exact names and order are asserted independently of DEFAULT_LENSES:
    // a swap inside the constant must not silently pass this test.
    expect(round.lenses.map((chip) => chip.lens)).toEqual([
      'blind', 'edge', 'acceptance', 'security', 'architecture', 'codebase', 'tests', 'performance', 'operations',
    ]);
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

  it('a historical seven-chip round keeps its own recorded lenses when a later round gets the expanded catalog', () => {
    api.addJob({ id: 'catalog-expansion', repo: 'billing-api', title: 'catalog expansion' });
    const historical = api.addRound({
      jobId: 'catalog-expansion',
      lenses: ['blind', 'edge', 'acceptance', 'security', 'architecture', 'codebase', 'tests'],
      targetRef: 'before-expansion',
    });
    const current = api.addRound({ jobId: 'catalog-expansion', targetRef: 'after-expansion' });
    expect(historical.lenses.map((chip) => chip.lens)).toEqual(
      ['blind', 'edge', 'acceptance', 'security', 'architecture', 'codebase', 'tests'],
    );
    expect(current.lenses.map((chip) => chip.lens)).toEqual([...DEFAULT_LENSES]);
    // The persisted historical round stays exactly as recorded: the
    // expansion is never backfilled onto a record created before it.
    expect(api.getRound(historical.id)?.lenses.map((chip) => chip.lens)).toEqual(
      ['blind', 'edge', 'acceptance', 'security', 'architecture', 'codebase', 'tests'],
    );
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

  it('listImplementerMinions: newest-first role-minion rows, review-only sessions excluded (G1)', () => {
    // Self-seeding: earlier sections share this db, but a focused run must
    // not depend on their rows (agents.job_id is FK-enforced).
    if (api.getJob('fix-login-flow') === null) {
      api.addJob({ id: 'fix-login-flow', repo: 'billing-api', title: 'Fix the login flow regression' });
    }
    api.addJob({ id: 'unrelated', repo: 'fixture', title: 'other heist' });
    api.registerAgent({ id: 'crew', role: 'gru' });
    api.registerAgent({ id: 'impl', role: 'minion', jobId: 'fix-login-flow', sessionFile: '/impl.jsonl' });
    api.registerAgent({ id: 'other-job', role: 'minion', jobId: 'unrelated', sessionFile: '/other.jsonl' });
    const round = api.addRound({ jobId: 'fix-login-flow', lenses: ['blind'] });
    api.registerAgent({ id: 'lead', role: 'perkins', jobId: 'fix-login-flow', roundId: round.id, sessionFile: '/lead.jsonl' });
    api.registerAgent({ id: 'round-bound', role: 'minion', jobId: 'fix-login-flow', roundId: round.id, sessionFile: '/round.jsonl' });
    api.registerAgent({ id: 'lens-bound', role: 'minion', jobId: 'fix-login-flow', sessionFile: '/lens.jsonl' });
    api.bindLens(round.id, 'blind', 'lens-bound');
    api.registerAgent({ id: 'unlinked', role: 'minion', sessionFile: '/unlinked.jsonl' });
    const bump = db.handle.prepare('UPDATE agents SET updated_at = ? WHERE id = ?');
    bump.run('2026-09-29T12:00:01.000Z', 'impl');
    bump.run('2026-09-29T12:00:02.000Z', 'round-bound');
    bump.run('2026-09-29T12:00:03.000Z', 'lens-bound');
    // 'agent-one' trails from an earlier suite section sharing this db.
    const implementers = api.listImplementerMinions('fix-login-flow').map((agent) => agent.id);
    expect(implementers[0]).toBe('impl');
    for (const reviewer of ['lead', 'round-bound', 'lens-bound']) {
      expect(implementers).not.toContain(reviewer);
    }
    expect(api.listImplementerMinions('unrelated').map((agent) => agent.id)).toEqual(['other-job']);
    expect(api.listImplementerMinions('no-such-job')).toEqual([]);
  });

  it('listImplementerMinions: same-millisecond ties keep insertion (spawn) order, and tracked children are never implementers (2026-10-05 review)', () => {
    api.addJob({ id: 'tie-heist', repo: 'billing-api', title: 'Tie order heist' });
    // Two implementers registered within the SAME millisecond: created_at
    // cannot separate them, and the alphabetical UUID order ('tie-a' <
    // 'tie-b') is incidental — insertion (spawn) order must win, so the
    // second registrant is the newest implementer.
    api.registerAgent({ id: 'tie-a', role: 'minion', jobId: 'tie-heist' });
    api.registerAgent({ id: 'tie-b', role: 'minion', jobId: 'tie-heist' });
    const tie = db.handle.prepare('UPDATE agents SET created_at = ? WHERE id = ?');
    tie.run('2026-10-05T03:00:00.000Z', 'tie-a');
    tie.run('2026-10-05T03:00:00.000Z', 'tie-b');
    expect(api.listImplementerMinions('tie-heist').map((agent) => agent.id)).toEqual(['tie-b', 'tie-a']);
    // Issue #161 union: a tracked child worker on the same job shares the
    // writer's role but is never the primary lane worker — the pick must
    // exclude it (routing digests/fix directives never land on a child).
    const parent = api.getAgent('tie-b')!;
    api.registerAgent({ id: 'tie-child', role: 'minion', jobId: 'tie-heist', parentage: 'child', parentAgentId: parent.id });
    const afterChild = api.listImplementerMinions('tie-heist').map((agent) => agent.id);
    expect(afterChild).not.toContain('tie-child');
    expect(afterChild).toEqual(['tie-b', 'tie-a']);
  });

  it('preserves the review-worker role when a fallback reviewer is re-registered by the spawn tap', () => {
    api.addJob({ id: 'fallback-role-heist', repo: 'fixture', title: 'Review title' });
    api.registerAgent({ id: 'fallback-reviewer', role: 'minion', sessionFile: '/review.jsonl' });
    api.registerAgent({ id: 'fallback-reviewer', role: 'perkins', label: 'fallback-review', jobId: 'fallback-role-heist' });
    // A resumed fallback restart uses the runtime spawn role, not the
    // durable review-worker role. The observer must not downgrade it.
    api.registerAgent({ id: 'fallback-reviewer', role: 'minion', sessionFile: '/review-resumed.jsonl' });
    expect(api.getAgent('fallback-reviewer')).toMatchObject({
      id: 'fallback-reviewer', role: 'perkins', label: 'fallback-review',
      jobId: 'fallback-role-heist', sessionFile: '/review-resumed.jsonl', roundId: null,
    });
    expect(api.listImplementerMinions('fallback-role-heist').map((agent) => agent.id)).not.toContain('fallback-reviewer');
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
  it('listActiveRounds reports exactly the pending/live rounds across jobs (roll drain probe)', () => {
    api.addJob({ id: 'roll-probe-a', repo: 'roll-probe', title: 'roll probe A' });
    api.addJob({ id: 'roll-probe-b', repo: 'roll-probe', title: 'roll probe B' });
    const pending = api.addRound({ jobId: 'roll-probe-a', targetRef: 't1', lenses: ['alpha'] });
    const live = api.addRound({ jobId: 'roll-probe-b', targetRef: 't2', lenses: ['alpha'] });
    api.setRoundStatus(live.id, 'live');
    const posted = api.addRound({ jobId: 'roll-probe-a', targetRef: 't3', lenses: ['alpha'] });
    api.setRoundStatus(posted.id, 'live');
    api.setRoundVerdict(posted.id, 'approved');
    const aborted = api.addRound({ jobId: 'roll-probe-b', targetRef: 't4', lenses: ['alpha'] });
    api.setRoundStatus(aborted.id, 'aborted');
    const active = api.listActiveRounds();
    // Other suites' rounds may still be non-terminal on the shared ledger:
    // assert the probe contract (only pending/live) and membership, not a
    // global count.
    expect(active.every((round) => round.status === 'pending' || round.status === 'live')).toBe(true);
    expect(active.map((round) => round.id)).toEqual(expect.arrayContaining([pending.id, live.id]));
    expect(active.map((round) => round.id)).not.toContain(posted.id);
    expect(active.map((round) => round.id)).not.toContain(aborted.id);
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

describe('pending re-brief terminal retirement (ledger boundary)', () => {
  let db: LedgerDb;
  let api: LedgerApi;

  beforeAll(() => {
    db = new LedgerDb(tmpDir());
    api = new LedgerApi(db.handle);
  });
  afterAll(() => db.close());

  function mergedJob(id: string): void {
    api.addJob({ id, repo: 'terminal-retirement', title: 'terminal retirement fixture' });
    api.setJobStatus(id, 'working');
    api.setJobStatus(id, 'in-review');
    api.setJobStatus(id, 'merged');
  }

  function candidatesOf(markers: readonly PendingRebriefRecord[]): readonly {
    id: string;
    kind: PendingRebriefRecord['kind'];
    payloadHash: string;
    baselineSeq: number;
  }[] {
    return markers.map((marker) => ({
      id: marker.id,
      kind: marker.kind,
      payloadHash: marker.payloadHash,
      baselineSeq: marker.baselineSeq,
    }));
  }

  it('beginPendingRebrief refuses a terminal job inside its own transaction (the HTTP guard is not the only boundary)', () => {
    mergedJob('intake-terminal');
    expect(() => api.beginPendingRebrief({ jobId: 'intake-terminal', note: 'n', briefing: 'b' }))
      .toThrow(/terminal lanes are never re-briefed/u);
    expect(api.listPendingRebriefs({ jobId: 'intake-terminal' })).toHaveLength(0);
  });

  it('retirePendingRebriefs commits audit + identity-checked deletion together; a replay is a no-op', () => {
    const jobId = 'retire-atomic';
    api.addJob({ id: jobId, repo: 'terminal-retirement', title: 'audit atomicity' });
    api.setJobStatus(jobId, 'working');
    const markers = api.beginPendingRebrief({ jobId, note: 'n', briefing: 'b' });
    const candidates = candidatesOf(markers);
    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'merged');

    const first = api.retirePendingRebriefs({ jobId, reason: 'job terminal', candidates });
    expect(first.refused).toBeNull();
    expect(first.retired.map((marker) => marker.id).sort()).toEqual(markers.map((marker) => marker.id).sort());
    expect(api.listPendingRebriefs({ jobId })).toHaveLength(0);
    const audit = api.latestJobEvent(jobId, 'silas.rebrief-retired');
    expect(audit).not.toBeNull();
    expect((audit?.payload as { job_status?: string }).job_status).toBe('merged');

    const replay = api.retirePendingRebriefs({ jobId, reason: 'job terminal', candidates });
    expect(replay.retired).toHaveLength(0);
    expect(api.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-retired')).toHaveLength(1);
  });

  it('refuses direct retirement of a fully landed terminal request without an audit', () => {
    const jobId = 'retire-spent-refusal';
    api.addJob({ id: jobId, repo: 'terminal-retirement', title: 'completed request' });
    api.setJobStatus(jobId, 'working');
    const markers = api.beginPendingRebrief({ jobId, note: 'n', briefing: 'b' });
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId });
    api.appendCustomEvent({ kind: 'job.delivered', jobId });
    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'merged');
    const result = api.retirePendingRebriefs({ jobId, reason: 'terminal', candidates: candidatesOf(markers) });
    expect(result).toMatchObject({ retired: [], skippedIds: [], refused: 'events-already-landed' });
    expect(api.listPendingRebriefs({ jobId })).toEqual(markers);
    expect(api.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    expect(api.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(true);
    expect(api.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(api.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-settled')).toHaveLength(1);
  });

  it('settlement refuses an unfinished or incoherent pair before any deletion', () => {
    const unlanded = 'settle-refuse-unlanded';
    api.addJob({ id: unlanded, repo: 'settlement-refusal', title: 'not yet' });
    api.setJobStatus(unlanded, 'working');
    const markers = api.beginPendingRebrief({ jobId: unlanded, note: 'n', briefing: 'b' });
    expect(() => api.clearPendingRebriefsIfCurrentAndSettle(markers))
      .toThrow(/guarded event .* has not landed/u);
    expect(api.listPendingRebriefs({ jobId: unlanded })).toHaveLength(2);
    expect(api.latestJobEvent(unlanded, 'silas.rebrief-settled')).toBeNull();

    const malformed = 'settle-refuse-malformed';
    api.addJob({ id: malformed, repo: 'settlement-refusal', title: 'broken pair' });
    api.setJobStatus(malformed, 'working');
    const pair = api.beginPendingRebrief({ jobId: malformed, note: 'n', briefing: 'b' });
    db.handle.prepare('DELETE FROM pending_rebriefs WHERE id = ?').run(pair[0]!.id);
    const survivor = api.listPendingRebriefs({ jobId: malformed });
    expect(() => api.clearPendingRebriefsIfCurrentAndSettle(survivor))
      .toThrow(/incomplete or incoherent/u);
    expect(api.listPendingRebriefs({ jobId: malformed })).toHaveLength(1);
    expect(api.latestJobEvent(malformed, 'silas.rebrief-settled')).toBeNull();
  });

  it('settlement insertion failure rolls back the marker clear, then a retry settles once', () => {
    const jobId = 'settle-atomic-rollback';
    api.addJob({ id: jobId, repo: 'settlement-rollback', title: 'atomic' });
    api.setJobStatus(jobId, 'working');
    const markers = api.beginPendingRebrief({ jobId, note: 'n', briefing: 'b' });
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId });
    api.appendCustomEvent({ kind: 'job.delivered', jobId });
    db.handle.exec(`CREATE TRIGGER fail_rebrief_settlement BEFORE INSERT ON events
      WHEN NEW.kind = 'silas.rebrief-settled' BEGIN SELECT RAISE(ABORT, 'settlement blocked'); END`);
    try {
      expect(() => api.clearPendingRebriefsIfCurrentAndSettle(markers)).toThrow(/settlement blocked/u);
      expect(api.listPendingRebriefs({ jobId }).map((row) => row.id)).toEqual(markers.map((row) => row.id));
      expect(api.latestJobEvent(jobId, 'silas.rebrief-settled')).toBeNull();
    } finally {
      db.handle.exec('DROP TRIGGER fail_rebrief_settlement');
    }
    expect(api.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(true);
    expect(api.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(api.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-settled')).toHaveLength(1);
  });

  it('retirement audit insertion failure rolls back marker deletion, then a retry commits once', () => {
    const jobId = 'retire-audit-rollback';
    api.addJob({ id: jobId, repo: 'terminal-retirement', title: 'rollback' });
    api.setJobStatus(jobId, 'working');
    const markers = api.beginPendingRebrief({ jobId, note: 'n', briefing: 'b' });
    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'merged');
    db.handle.exec(`CREATE TRIGGER fail_retirement_audit BEFORE INSERT ON events
      WHEN NEW.kind = 'silas.rebrief-retired' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END`);
    try {
      expect(() => api.retirePendingRebriefs({ jobId, reason: 'terminal', candidates: candidatesOf(markers) }))
        .toThrow(/audit blocked/u);
      expect(api.listPendingRebriefs({ jobId }).map((row) => row.id)).toEqual(markers.map((row) => row.id));
      expect(api.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    } finally {
      db.handle.exec('DROP TRIGGER fail_retirement_audit');
    }
    expect(api.retirePendingRebriefs({ jobId, reason: 'terminal', candidates: candidatesOf(markers) }).retired).toHaveLength(2);
    expect(api.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(api.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-retired')).toHaveLength(1);
  });

  it('a stale snapshot never erases a newer request generation; nonterminal and missing jobs are refused', () => {
    const jobId = 'retire-generation';
    api.addJob({ id: jobId, repo: 'terminal-retirement', title: 'generation guard' });
    api.setJobStatus(jobId, 'working');
    const old = api.beginPendingRebrief({ jobId, note: 'old', briefing: 'b' });
    const staleCandidates = candidatesOf(old);
    const fresh = api.beginPendingRebrief({ jobId, note: 'fresh', briefing: 'b' });
    expect(fresh.map((marker) => marker.id)).not.toEqual(old.map((marker) => marker.id));

    // Nonterminal: refused, nothing deleted or recorded — and nothing is
    // reported as "skipped" because no row was read or compared.
    const refused = api.retirePendingRebriefs({ jobId, reason: 'x', candidates: staleCandidates });
    expect(refused.refused).toBe('job-not-terminal');
    expect(refused.skippedIds).toHaveLength(0);
    expect(refused.retired).toHaveLength(0);
    expect(api.listPendingRebriefs({ jobId })).toHaveLength(2);

    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'merged');
    const stale = api.retirePendingRebriefs({ jobId, reason: 'x', candidates: staleCandidates });
    expect(stale.retired).toHaveLength(0);
    expect(stale.skippedIds.slice().sort()).toEqual(staleCandidates.map((candidate) => candidate.id).sort());
    expect(api.listPendingRebriefs({ jobId })).toHaveLength(2); // the newer generation survives

    const current = api.retirePendingRebriefs({ jobId, reason: 'x', candidates: candidatesOf(fresh) });
    expect(current.retired).toHaveLength(2);
    expect(api.listPendingRebriefs({ jobId })).toHaveLength(0);

    const missing = api.retirePendingRebriefs({ jobId: 'no-such-job', reason: 'x', candidates: [] });
    expect(missing.refused).toBe('job-missing');
  });

  it('a mixed candidate list retires only the matching identity and traces the drifted id', () => {
    const jobId = 'retire-mixed';
    api.addJob({ id: jobId, repo: 'terminal-retirement', title: 'mixed candidates' });
    api.setJobStatus(jobId, 'working');
    const superseded = api.beginPendingRebrief({ jobId, note: 'old', briefing: 'b' });
    const fresh = api.beginPendingRebrief({ jobId, note: 'fresh', briefing: 'b' });
    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'merged');
    // One candidate still matches the live row; its stale-generation twin
    // (same kind, superseded id/hash/watermark) must be skipped, never
    // deleted — and the drift must be traceable in the single audit.
    const matching = candidatesOf(fresh)[0]!;
    const drifted = candidatesOf(superseded).find((candidate) => candidate.kind === matching.kind)!;
    const result = api.retirePendingRebriefs({ jobId, reason: 'job terminal', candidates: [matching, drifted] });
    expect(result.refused).toBeNull();
    expect(result.retired.map((marker) => marker.id)).toEqual([matching.id]);
    expect(result.skippedIds).toEqual([drifted.id]);
    // Exactly one row deleted; the newer generation of the other kind survives.
    expect(api.listPendingRebriefs({ jobId }).map((marker) => marker.id))
      .toEqual([fresh.find((marker) => marker.kind !== matching.kind)!.id]);
    const audits = api.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-retired');
    expect(audits).toHaveLength(1);
    const payload = audits[0]!.payload as { retired: readonly { id: string }[]; skipped_ids: readonly string[] };
    expect(payload.retired.map((marker) => marker.id)).toEqual([matching.id]);
    expect(payload.skipped_ids).toEqual([drifted.id]);
  });

  it('duplicate candidate ids retire and audit ONCE — a caller-side duplicate cannot overstate the deletion', () => {
    const jobId = 'retire-duplicate-ids';
    api.addJob({ id: jobId, repo: 'terminal-retirement', title: 'duplicate guard' });
    api.setJobStatus(jobId, 'working');
    const markers = api.beginPendingRebrief({ jobId, note: 'n', briefing: 'b' });
    const candidates = candidatesOf(markers);
    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'merged');
    // The same candidate twice (a caller-side duplicate): the id retires
    // once, the audit names it once, and nothing is reported as skipped.
    const result = api.retirePendingRebriefs({
      jobId, reason: 'job terminal', candidates: [...candidates, ...candidates],
    });
    expect(result.retired.map((marker) => marker.id).sort()).toEqual(markers.map((marker) => marker.id).sort());
    expect(result.skippedIds).toEqual([]);
    expect(api.listPendingRebriefs({ jobId })).toHaveLength(0);
    const audit = api.latestJobEvent(jobId, 'silas.rebrief-retired');
    const audited = (audit?.payload as { retired?: readonly { id: string }[] }).retired ?? [];
    expect(audited.map((row) => row.id).sort()).toEqual(markers.map((marker) => marker.id).sort());
    expect(audited).toHaveLength(2); // one audit row per real marker, not per candidate
  });

  it('a marked retirement audits its own landed phase despite a newer foreign-phase event', () => {
    const jobId = 'retire-phase-audit';
    api.addJob({ id: jobId, repo: 'terminal-retirement', title: 'phase evidence' });
    api.setJobStatus(jobId, 'working');
    const markers = api.beginPendingRebrief({
      jobId, note: 'n', briefing: 'b', handoff: { kind: 'gru-decision', decision: 'review' },
    });
    const phaseId = markers[0]!.phaseId;
    expect(phaseId).not.toBeNull();
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { phase_id: phaseId } });
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { phase_id: 'foreign' } });
    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'merged');
    api.retirePendingRebriefs({ jobId, reason: 'terminal', candidates: candidatesOf(markers) });
    const retired = (api.latestJobEvent(jobId, 'silas.rebrief-retired')?.payload as {
      retired: readonly { kind: string; guarded_event_landed: boolean }[];
    }).retired;
    expect(retired.find((row) => row.kind === 'silas.rebrief')?.guarded_event_landed).toBe(true);
    expect(retired.find((row) => row.kind === 'job.delivered')?.guarded_event_landed).toBe(false);
  });

  it('a marked retirement audits its own event beyond the newest thousand unrelated job events', () => {
    const jobId = 'retire-phase-window';
    api.addJob({ id: jobId, repo: 'terminal-retirement', title: 'old phase evidence' });
    api.setJobStatus(jobId, 'working');
    const markers = api.beginPendingRebrief({
      jobId, note: 'n', briefing: 'b', handoff: { kind: 'gru-decision', decision: 'review' },
    });
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { phase_id: markers[0]!.phaseId } });
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { phase_id: 'foreign' } });
    for (let i = 0; i < 1001; i++) api.appendCustomEvent({ kind: 'job.note', jobId, payload: { index: i } });
    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'merged');
    api.retirePendingRebriefs({ jobId, reason: 'terminal', candidates: candidatesOf(markers) });
    const retired = (api.latestJobEvent(jobId, 'silas.rebrief-retired')?.payload as {
      retired: readonly { kind: string; guarded_event_landed: boolean }[];
    }).retired;
    expect(retired.find((row) => row.kind === 'silas.rebrief')?.guarded_event_landed).toBe(true);
    expect(retired.find((row) => row.kind === 'job.delivered')?.guarded_event_landed).toBe(false);
  });

  it('the retirement audit recomputes guarded_event_landed from the ledger, not the caller', () => {
    const jobId = 'retire-landed-flag';
    api.addJob({ id: jobId, repo: 'terminal-retirement', title: 'landed-flag truth' });
    api.setJobStatus(jobId, 'working');
    const markers = api.beginPendingRebrief({ jobId, note: 'n', briefing: 'b' });
    // The guarded `silas.rebrief` event lands; the delivery never does.
    api.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { minion_id: 'w', note: 'n' } });
    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'merged');
    const result = api.retirePendingRebriefs({ jobId, reason: 'job terminal', candidates: candidatesOf(markers) });
    expect(result.retired).toHaveLength(2);
    const audit = api.latestJobEvent(jobId, 'silas.rebrief-retired');
    const retired =
      (audit?.payload as { retired?: readonly { kind: string; guarded_event_landed?: boolean }[] }).retired ?? [];
    const flagFor = (kind: string): boolean | undefined =>
      retired.find((marker) => marker.kind === kind)?.guarded_event_landed;
    // Recomputed in the transaction from the ledger's own events: the caller
    // supplied no flag at all.
    expect(flagFor('silas.rebrief')).toBe(true);
    expect(flagFor('job.delivered')).toBe(false);
  });
});

describe('ledger api — identity-corrected follow-through reads (issue #163)', () => {
  function freshApi(): LedgerApi {
    const db = new LedgerDb(tmpDir());
    return new LedgerApi(db.handle, { bus: new EventBus() });
  }

  it('finds a request-correlated event behind a full window of same-kind events', () => {
    const api = freshApi();
    api.addJob({ id: 'job-buried', repo: 'demo', title: 't' });
    const old = api.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-buried',
      payload: { request_id: 'req-old' },
    });
    for (let i = 0; i < 1200; i += 1) {
      api.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-buried', payload: { request_id: `req-${i}` } });
    }
    const found = api.latestJobEventByRequestId('job-buried', 'job.delivered', 'req-old');
    expect(found?.seq).toBe(old.seq);
    expect(api.latestJobEventByRequestId('job-buried', 'job.delivered', 'req-missing')).toBeNull();
  });

  it('reduces verification events per scope behind a flood of other scopes', () => {
    const api = freshApi();
    api.addJob({ id: 'job-scope-flood', repo: 'demo', title: 't' });
    const full = api.appendCustomEvent({
      kind: 'verification.completed',
      jobId: 'job-scope-flood',
      payload: { ok: false, scope: 'full', run_id: 'run-old' },
    });
    let latestFocused = full;
    for (let i = 0; i < 600; i += 1) {
      latestFocused = api.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-scope-flood',
        payload: { ok: true, scope: 'focused', run_id: `run-${i}` },
      });
    }
    const scoped = api.latestJobEventsByPayloadScope('job-scope-flood', ['verification.completed']);
    const rows = scoped.map((event) => [event.payload, event.seq] as const);
    const fullRow = rows.find(([payload]) => (payload as { scope?: string }).scope === 'full');
    const focusedRow = rows.find(([payload]) => (payload as { scope?: string }).scope === 'focused');
    expect(fullRow?.[1]).toBe(full.seq); // the older failure scope never ages out
    expect(focusedRow?.[1]).toBe(latestFocused.seq);
  });
});

describe('decision memory (issue #218)', () => {
  let api: LedgerApi;
  const closeFns: (() => void)[] = [];
  afterAll(() => {
    for (const close of closeFns) close();
  });

  function fresh(): LedgerApi {
    const d = new LedgerDb(tmpDir());
    closeFns.push(() => d.close());
    api = new LedgerApi(d.handle, { bus: new EventBus() });
    return api;
  }

  const base = {
    subject: 'pr:mssoka/gru-command#148',
    decision: 'hold' as const,
    covers: ['pr-conflict'],
    reason: 'existing ownership/integration hold',
    by: 'gru' as const,
  };

  it('coverage matrix: unchanged basis → covered; changed basis → not covered', () => {
    const a = fresh();
    a.recordDecision({ ...base, basisFingerprint: 'aaaa', clientKey: 'k-basis' });
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'aaaa' })).not.toBeNull();
    // The basis moved (a new head) — the hold no longer covers; the subject re-opens.
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'bbbb' })).toBeNull();
  });

  it('coverage matrix: a passed recheck_at → not covered; a future one → covered', () => {
    const a = fresh();
    a.recordDecision({
      ...base,
      recheckAt: '2030-01-01T00:00:00.000Z',
      clientKey: 'k-recheck',
    });
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'x', now: '2029-06-01T00:00:00.000Z' })).not.toBeNull();
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'x', now: '2030-06-01T00:00:00.000Z' })).toBeNull();
    // Omitted `now` means the real clock: a far-future recheck still covers.
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'x' })).not.toBeNull();
  });

  it('coverage matrix: cleared → not covered; unknown subject → not covered', () => {
    const a = fresh();
    const row = a.recordDecision({ ...base, clientKey: 'k-clear' });
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'x' })).not.toBeNull();
    a.clearDecision({ id: row.id, by: 'owner', reason: 'hold lifted' });
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'x' })).toBeNull();
    expect(a.coveringDecision({ subject: 'pr:elsewhere/repo#1', signal: 'pr-conflict', basis: 'x' })).toBeNull();
  });

  it('coverage matrix: a signal outside covers → not covered; null basis covers ANY basis', () => {
    const a = fresh();
    a.recordDecision({ ...base, covers: ['ci-failed'], clientKey: 'k-signal' });
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'x' })).toBeNull();
    expect(a.coveringDecision({ subject: base.subject, signal: 'ci-failed', basis: 'anything' })).not.toBeNull();
    a.recordDecision({ ...base, covers: ['ci-failed'], basisFingerprint: null, clientKey: 'k-any-basis', subject: 'job:j-1' });
    expect(a.coveringDecision({ subject: 'job:j-1', signal: 'ci-failed', basis: 'whatever-head' })).not.toBeNull();
  });

  it('only the newest decision covering the signal is the candidate — an older broader hold never shadows a re-open', () => {
    const a = fresh();
    a.recordDecision({ ...base, basisFingerprint: null, clientKey: 'k-old-broad' });
    const newer = a.recordDecision({ ...base, covers: ['pr-conflict', 'ci-failed'], basisFingerprint: 'aaaa', clientKey: 'k-newer' });
    // Newer decision covers on its own basis.
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'aaaa' })).toMatchObject({ id: newer.id });
    // Basis moved: the NEWER decision fails — and the older, basisless hold
    // must NOT keep the subject covered (the promised re-open is real).
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'bbbb' })).toBeNull();
    expect(a.coveringDecision({ subject: base.subject, signal: 'ci-failed', basis: 'bbbb' })).toBeNull();
    // A passed recheck on the newest coverer re-opens the same way.
    a.clearDecision({ id: newer.id, by: 'gru', reason: 'replace with recheck shape' });
    const withRecheck = a.recordDecision({ ...base, basisFingerprint: null, clientKey: 'k-recheck-shape', recheckAt: '2030-01-01T00:00:00.000Z' });
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'x', now: '2031-01-01T00:00:00.000Z' })).toBeNull();
    expect(a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'x', now: '2029-01-01T00:00:00.000Z' })).toMatchObject({ id: withRecheck.id });
  });

  it('coveringDecision pages to exhaustion — a hold beyond any single listing window is still found', () => {
    const a = fresh();
    // The OLDEST decision is the only coverer for pr-conflict; 510 newer
    // active decisions on the same subject cover a different signal, so
    // the coverer sits past the first (500-row) page.
    const oldest = a.recordDecision({ ...base, clientKey: 'k-deep' });
    for (let i = 0; i < 510; i += 1) {
      a.recordDecision({ ...base, covers: ['ci-failed'] });
    }
    const found = a.coveringDecision({ subject: base.subject, signal: 'pr-conflict', basis: 'x' });
    expect(found).toMatchObject({ id: oldest.id });
    // …and a subject with only non-covering decisions stays uncovered.
    expect(a.coveringDecision({ subject: 'job:j-none', signal: 'pr-conflict', basis: 'x' })).toBeNull();
  }, 20_000);

  it('vocabulary: subject kinds are exactly job/pr/incident; signals are canonical lowercase tokens', () => {
    const a = fresh();
    expect(a.recordDecision({ ...base, subject: 'job:j-9', clientKey: 'k-job' }).subject).toBe('job:j-9');
    expect(a.recordDecision({ ...base, subject: 'incident:pr-conflict:abc', clientKey: 'k-inc' }).subject).toBe('incident:pr-conflict:abc');
    expect(() => a.recordDecision({ ...base, subject: 'bogus:key', clientKey: 'k-bogus' })).toThrow(/unknown decision subject kind "bogus"/);
    expect(() => a.recordDecision({ ...base, subject: 'PR:x', clientKey: 'k-upper' })).toThrow(/unknown decision subject kind "PR"/);
    expect(() => a.recordDecision({ ...base, covers: ['Pr Conflict'] })).toThrow(/lowercase token/);
    expect(() => a.recordDecision({ ...base, covers: ['PR-CONFLICT'] })).toThrow(/lowercase token/);
    expect(a.recordDecision({ ...base, covers: ['ci.failed_v2'], clientKey: 'k-token' }).covers).toEqual(['ci.failed_v2']);
  });

  it('recheck_at must be an ISO 8601 UTC timestamp, not merely Date.parse-able', () => {
    const a = fresh();
    expect(() => a.recordDecision({ ...base, recheckAt: 'March 5 2030' })).toThrow(/ISO 8601 UTC timestamp/);
    expect(() => a.recordDecision({ ...base, recheckAt: '2030-01-01T00:00:00+02:00' })).toThrow(/ISO 8601 UTC timestamp/);
    expect(() => a.recordDecision({ ...base, recheckAt: '2030-13-45T00:00:00.000Z' })).toThrow(/parseable ISO timestamp/);
    const ok = a.recordDecision({ ...base, recheckAt: '2030-01-01T00:00:00Z' });
    expect(ok.recheckAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('countDecisions reports the untruncated active total', () => {
    const a = fresh();
    const one = a.recordDecision({ ...base, clientKey: 'k-c1' });
    a.recordDecision({ ...base, clientKey: 'k-c2' });
    expect(a.countDecisions({ activeOnly: true })).toBe(2);
    expect(a.countDecisions()).toBe(2);
    a.clearDecision({ id: one.id, by: 'gru', reason: 'r' });
    expect(a.countDecisions({ activeOnly: true })).toBe(1);
    expect(a.countDecisions()).toBe(2);
  });

  it('create is idempotent on client_key retry: same row, one event; changed content conflicts', () => {
    const a = fresh();
    const first = a.recordDecision({ ...base, basisFingerprint: 'aaaa', clientKey: 'k-idem', recheckAt: '2030-01-01T00:00:00.000Z' });
    const replay = a.recordDecision({ ...base, basisFingerprint: 'aaaa', clientKey: 'k-idem', recheckAt: '2030-01-01T00:00:00.000Z' });
    expect(replay.id).toBe(first.id);
    // covers ordering differences canonicalize to the same decision.
    const replayReordered = a.recordDecision({
      ...base, covers: ['ci-failed', 'pr-conflict'], basisFingerprint: 'aaaa', clientKey: 'k-idem-covers',
    });
    const replayReordered2 = a.recordDecision({
      ...base, covers: ['pr-conflict', 'ci-failed'], basisFingerprint: 'aaaa', clientKey: 'k-idem-covers',
    });
    expect(replayReordered2.id).toBe(replayReordered.id);
    // k-idem (1 row) + k-idem-covers (1 row): replays never add rows.
    expect(a.listDecisions({ subject: base.subject })).toHaveLength(2);
    const recorded = a.listEvents().filter((e) => e.kind === 'decision.recorded');
    expect(recorded).toHaveLength(2);
    expect(() =>
      a.recordDecision({ ...base, reason: 'a DIFFERENT hold under the same key', clientKey: 'k-idem' }),
    ).toThrow(/different decision/);
    // No key = no idempotency: every call makes a new decision.
    const free1 = a.recordDecision({ ...base });
    const free2 = a.recordDecision({ ...base });
    expect(free1.id).not.toBe(free2.id);
  });

  it('events carry the decision payload; clear appends decision.cleared once', () => {
    const a = fresh();
    const row = a.recordDecision({
      subject: 'incident:pr-conflict:abc', decision: 'dismissed', covers: ['pr-conflict'],
      basisFingerprint: 'hash-1', reason: 'stale incident, already settled', by: 'silas', clientKey: 'k-event',
    });
    const event = a.listEvents().find((e) => e.kind === 'decision.recorded' && (e.payload as { id?: string }).id === row.id);
    expect(event?.payload).toMatchObject({
      id: row.id, subject: 'incident:pr-conflict:abc', decision: 'dismissed', by: 'silas', basis_fingerprint: 'hash-1',
    });
    a.clearDecision({ id: row.id, by: 'gru', reason: 're-opened by owner' });
    a.clearDecision({ id: row.id, by: 'gru', reason: 'repeat is an idempotent no-op' });
    const cleared = a.listEvents().filter((e) => e.kind === 'decision.cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.payload).toMatchObject({ id: row.id, by: 'gru' });
  });

  it('validation: bad enums, empty reason, bad dates, and malformed subjects fail loudly', () => {
    const a = fresh();
    expect(() => a.recordDecision({ ...base, decision: 'maybe' as never })).toThrow(/unknown decision kind/);
    expect(() => a.recordDecision({ ...base, by: 'minion' as never })).toThrow(/unknown decision actor/);
    expect(() => a.recordDecision({ ...base, reason: '' })).toThrow(/reason must be 1-/);
    expect(() => a.recordDecision({ ...base, recheckAt: 'not-a-date' })).toThrow(/ISO 8601 UTC timestamp/);
    expect(() => a.recordDecision({ ...base, subject: 'no-colon-here' })).toThrow(/"<kind>:<key>"/);
    expect(() => a.recordDecision({ ...base, covers: [] })).toThrow(/non-empty array/);
    expect(() => a.recordDecision({ ...base, covers: [''] })).toThrow(/signal must be 1-/);
    expect(() => a.coveringDecision({ subject: base.subject, signal: '', basis: 'x' })).toThrow(/signal/);
    expect(() => a.clearDecision({ id: 'missing', by: 'gru', reason: 'r' })).toThrow(/not found/);
  });

  it('listDecisions filters by subject and activeOnly, newest first, bounded', () => {
    const a = fresh();
    const first = a.recordDecision({ ...base, subject: 'job:j-list', clientKey: 'k-l1' });
    const second = a.recordDecision({ ...base, subject: 'job:j-list', covers: ['ci-failed'], clientKey: 'k-l2' });
    a.recordDecision({ ...base, subject: 'job:j-other', clientKey: 'k-l3' });
    a.clearDecision({ id: second.id, by: 'silas', reason: 'done' });
    const all = a.listDecisions({ subject: 'job:j-list' });
    expect(all.map((r) => r.id)).toEqual([second.id, first.id]); // newest first
    expect(a.listDecisions({ subject: 'job:j-list', activeOnly: true }).map((r) => r.id)).toEqual([first.id]);
    expect(a.listDecisions()).toHaveLength(3);
  });
});

describe('report-job closure (issue #220)', () => {
  function freshDb(): { api: LedgerApi; db: LedgerDb; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-report-closure-'));
    const db = new LedgerDb(dir);
    const api = new LedgerApi(db.handle, { bus: new EventBus() });
    return { api, db, dir };
  }

  /** A delivered report-type job with its target recorded. */
  function deliveredReportJob(
    api: LedgerApi,
    jobId: string,
    opts: { deliverable?: 'review' | 'artifact' | 'investigation'; targetRef?: string; targetSha?: string; commissioner?: string } = {},
  ): void {
    api.addJob({
      id: jobId, repo: 'fixture-app', title: `t-${jobId}`, briefing: 'review the PR',
      deliverable: opts.deliverable ?? 'review',
      commissioner: opts.commissioner ?? 'gru',
      ...(opts.targetRef !== undefined ? { targetRef: opts.targetRef } : {}),
      ...(opts.targetSha !== undefined ? { targetSha: opts.targetSha } : {}),
    });
    api.setJobStatus(jobId, 'working');
    api.setJobStatus(jobId, 'delivered');
    const delivered = api.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { agentId: 'a1', sha: 'head-1' } });
    api.openReportObligation({ jobId, observedAtSeq: delivered.seq });
  }

  it('persists commissioner and target on a report-type job, and the created event carries them', () => {
    const { api, db, dir } = freshDb();
    try {
      const job = api.addJob({
        id: 'rep-1', repo: 'fixture-app', title: 't', briefing: 'b',
        deliverable: 'review', commissioner: 'silas',
        targetRef: 'https://git.example.invalid/o/r/pull/9', targetSha: 'abc123',
      });
      expect(job.commissioner).toBe('silas');
      expect(job.targetRef).toBe('https://git.example.invalid/o/r/pull/9');
      expect(job.targetSha).toBe('abc123');
      const created = api.latestJobEvent('rep-1', 'job.created');
      expect(created?.payload).toMatchObject({ commissioner: 'silas', target_ref: 'https://git.example.invalid/o/r/pull/9', target_sha: 'abc123' });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses target fields on a PR-owing lane and blank values anywhere', () => {
    const { api, db, dir } = freshDb();
    try {
      expect(() => api.addJob({
        id: 'pr-lane', repo: 'r', title: 't', briefing: 'b',
        targetRef: 'https://git.example.invalid/o/r/pull/1',
      })).toThrow(/report-job fields/);
      expect(() => api.addJob({
        id: 'blank-sha', repo: 'r', title: 't', briefing: 'b',
        deliverable: 'review', targetRef: 'https://git.example.invalid/o/r/pull/1', targetSha: '  ',
      })).toThrow(/target_sha/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a handback opens exactly ONE obligation; a duplicate delivery coalesces (idempotent)', () => {
    const { api, db, dir } = freshDb();
    try {
      api.addJob({ id: 'rep-dup', repo: 'r', title: 't', briefing: 'b', deliverable: 'review', commissioner: 'gru', targetRef: 'https://x/pull/1', targetSha: 's1' });
      api.setJobStatus('rep-dup', 'working');
      const first = api.appendCustomEvent({ kind: 'job.delivered', jobId: 'rep-dup', payload: { sha: 's1' } });
      const opened = api.openReportObligation({ jobId: 'rep-dup', observedAtSeq: first.seq });
      expect(opened.created).toBe(true);
      expect(opened.obligation.incidentKey).toBe('report:rep-dup');
      expect(opened.obligation.logicalStep).toBe('review');
      expect(opened.obligation.state).toBe('open');
      // A later delivery (re-brief) replays the same open: still one debt.
      const second = api.appendCustomEvent({ kind: 'job.delivered', jobId: 'rep-dup', payload: { sha: 's2' } });
      const replay = api.openReportObligation({ jobId: 'rep-dup', observedAtSeq: second.seq });
      expect(replay.created).toBe(false);
      expect(replay.obligation.id).toBe(opened.obligation.id);
      expect(api.listObligations({ jobId: 'rep-dup' })).toHaveLength(1);
      // Step follows kind: artifact → verification, investigation → audit.
      api.addJob({ id: 'rep-art', repo: 'r', title: 't', briefing: 'b', deliverable: 'artifact', commissioner: 'gru' });
      api.setJobStatus('rep-art', 'working');
      const art = api.appendCustomEvent({ kind: 'job.delivered', jobId: 'rep-art', payload: {} });
      expect(api.openReportObligation({ jobId: 'rep-art', observedAtSeq: art.seq }).obligation.logicalStep).toBe('verification');
      api.addJob({ id: 'rep-inv', repo: 'r', title: 't', briefing: 'b', deliverable: 'investigation', commissioner: 'gru' });
      api.setJobStatus('rep-inv', 'working');
      const inv = api.appendCustomEvent({ kind: 'job.delivered', jobId: 'rep-inv', payload: {} });
      expect(api.openReportObligation({ jobId: 'rep-inv', observedAtSeq: inv.seq }).obligation.logicalStep).toBe('audit');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('openReportObligation refuses PR-owing lanes and unknown jobs', () => {
    const { api, db, dir } = freshDb();
    try {
      api.addJob({ id: 'pr-job', repo: 'r', title: 't', briefing: 'b' });
      expect(() => api.openReportObligation({ jobId: 'pr-job', observedAtSeq: 1 })).toThrow(/report obligations open only on/);
      expect(() => api.openReportObligation({ jobId: 'missing', observedAtSeq: 1 })).toThrow(/not found/);
      // Legacy NULL deliverable is PR-owing by definition — refused too.
      api.addJob({ id: 'legacy-job', repo: 'r', title: 't', briefing: 'b' });
      expect(() => api.openReportObligation({ jobId: 'legacy-job', observedAtSeq: 1 })).toThrow(/report obligations open only on/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an acted disposition settles the obligation and closes the job delivered → done', () => {
    const { api, db, dir } = freshDb();
    try {
      deliveredReportJob(api, 'rep-acted', { targetRef: 'https://x/pull/2', targetSha: 's1' });
      api.addJob({ id: 'directive-1', repo: 'r', title: 'fix lane', briefing: 'fix' });
      const result = api.settleReportDisposition({
        jobId: 'rep-acted', outcome: 'acted', directiveJobId: 'directive-1', by: 'gru',
      });
      expect(result.job.status).toBe('done');
      expect(result.obligation.state).toBe('settled');
      const disposition = api.latestJobEvent('rep-acted', 'job.report-disposition');
      expect(disposition?.payload).toMatchObject({ outcome: 'acted', directive_job_id: 'directive-1', obligation_id: result.obligation.id });
      // Evidence grounding (ruling A): the cited event is real, on the job.
      const settled = api.getObligation(result.obligation.id);
      expect(settled?.settlement).toMatchObject({ kind: 'executed-action', evidenceEventKind: 'job.report-disposition' });
      expect(() => api.setJobStatus('rep-acted', 'working')).toThrow(/illegal transition/); // done is terminal
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dismissed and superseded dispositions carry a written reason and close the lane', () => {
    const { api, db, dir } = freshDb();
    try {
      deliveredReportJob(api, 'rep-dismiss', { deliverable: 'investigation', targetRef: 'https://x/pull/3', targetSha: 's1' });
      const dismissed = api.settleReportDisposition({ jobId: 'rep-dismiss', outcome: 'dismissed', note: 'findings already covered by the hold' });
      expect(dismissed.job.status).toBe('done');
      expect(dismissed.obligation.settlement).toMatchObject({ kind: 'cancelled', reason: 'findings already covered by the hold' });

      deliveredReportJob(api, 'rep-super', { deliverable: 'artifact', targetRef: 'https://x/pull/4', targetSha: 's1' });
      const superseded = api.settleReportDisposition({ jobId: 'rep-super', outcome: 'superseded', note: 're-reviewed by the newer round' });
      expect(superseded.job.status).toBe('done');
      expect(superseded.obligation.settlement).toMatchObject({ kind: 'superseded', reason: 're-reviewed by the newer round' });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dispositions fail loud on every missing precondition', () => {
    const { api, db, dir } = freshDb();
    try {
      deliveredReportJob(api, 'rep-guard', { targetRef: 'https://x/pull/5', targetSha: 's1' });
      expect(() => api.settleReportDisposition({ jobId: 'rep-guard', outcome: 'acted' })).toThrow(/acted requires directive_job_id/);
      expect(() => api.settleReportDisposition({ jobId: 'rep-guard', outcome: 'acted', directiveJobId: 'ghost' })).toThrow(/not found/);
      expect(() => api.settleReportDisposition({ jobId: 'rep-guard', outcome: 'dismissed' })).toThrow(/non-empty note/);
      expect(() => api.settleReportDisposition({ jobId: 'missing', outcome: 'dismissed', note: 'x' })).toThrow(/not found/);
      // A working (not yet delivered) report owes nothing to settle.
      api.addJob({ id: 'rep-working', repo: 'r', title: 't', briefing: 'b', deliverable: 'review', commissioner: 'gru' });
      api.setJobStatus('rep-working', 'working');
      expect(() => api.settleReportDisposition({ jobId: 'rep-working', outcome: 'dismissed', note: 'x' })).toThrow(/DELIVERED report/);
      // A delivered PR job has no report obligation to settle.
      api.addJob({ id: 'pr-delivered', repo: 'r', title: 't', briefing: 'b' });
      api.setJobStatus('pr-delivered', 'working');
      api.setJobStatus('pr-delivered', 'delivered');
      api.appendCustomEvent({ kind: 'job.delivered', jobId: 'pr-delivered', payload: {} });
      expect(() => api.settleReportDisposition({ jobId: 'pr-delivered', outcome: 'dismissed', note: 'x' })).toThrow(/dispositions apply to/);
      // An already-settled obligation refuses a second disposition — the
      // closed lane (done) is the guard that answers.
      api.settleReportDisposition({ jobId: 'rep-guard', outcome: 'dismissed', note: 'first' });
      expect(() => api.settleReportDisposition({ jobId: 'rep-guard', outcome: 'dismissed', note: 'second' })).toThrow(/is done/);
      // A delivered report whose obligation was never opened (e.g. the
      // crash window the boot reconciler covers) also refuses loudly.
      api.addJob({ id: 'rep-noles', repo: 'r', title: 't', briefing: 'b', deliverable: 'review', commissioner: 'gru' });
      api.setJobStatus('rep-noles', 'working');
      api.setJobStatus('rep-noles', 'delivered');
      api.appendCustomEvent({ kind: 'job.delivered', jobId: 'rep-noles', payload: {} });
      expect(() => api.settleReportDisposition({ jobId: 'rep-noles', outcome: 'dismissed', note: 'x' })).toThrow(/no open report obligation/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-supersede retires the debt, records report.superseded, and closes the lane', () => {
    const { api, db, dir } = freshDb();
    try {
      deliveredReportJob(api, 'rep-auto', { targetRef: 'https://x/pull/6', targetSha: 's1' });
      const result = api.supersedeReportObligation({ jobId: 'rep-auto', reason: 'target merged' });
      expect(result.job.status).toBe('done');
      expect(result.obligation.settlement).toMatchObject({ kind: 'superseded', reason: 'target merged' });
      expect(api.latestJobEvent('rep-auto', 'report.superseded')?.payload).toMatchObject({ reason: 'target merged', target_ref: 'https://x/pull/6' });
      // The scan set no longer carries the closed lane.
      expect(api.listReportClosureCandidates().map((job) => job.id)).toEqual([]);
      // A second auto-supersede hits the status guard — the lane is done.
      expect(() => api.supersedeReportObligation({ jobId: 'rep-auto', reason: 'again' })).toThrow(/DELIVERED report/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the candidate scan and the PR-url lookup find exactly the delivered targeted reports', () => {
    const { api, db, dir } = freshDb();
    try {
      deliveredReportJob(api, 'rep-scan', { targetRef: 'https://x/pull/7', targetSha: 's1' });
      deliveredReportJob(api, 'rep-untargeted', { deliverable: 'artifact' }); // no target: commissioner's, not the pass's
      api.addJob({ id: 'src-pr', repo: 'fixture-app', title: 't', briefing: 'b' });
      api.setJobPr('src-pr', 'https://x/pull/7');
      const candidates = api.listReportClosureCandidates();
      expect(candidates.map((job) => job.id)).toEqual(['rep-scan']);
      expect(api.findJobByPrUrl('https://x/pull/7')?.id).toBe('src-pr');
      expect(api.findJobByPrUrl('https://x/pull/999')).toBeNull();
      expect(api.findJobByPrUrl('')).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
