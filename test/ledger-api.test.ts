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
    expect(api.clearPendingRebriefsIfCurrent(markers)).toBe(true);
    expect(api.listPendingRebriefs({ jobId })).toHaveLength(0);
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
