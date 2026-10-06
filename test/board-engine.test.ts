import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { BoardEngine, type BoardSnapshot } from '../src/board/engine.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import type { AgentEventEnvelope } from '../src/runtime/registry.js';
import type { Role } from '../src/config.js';
import type { DecisionRuntimeStatus } from '../src/decisions/runtime.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-board-'));
  cleanupDirs.push(dir);
  return dir;
}

/** Build an envelope the registry tap would emit. */
function envelope(
  agentId: string,
  role: Role,
  event: AgentEventEnvelope['event'],
): AgentEventEnvelope {
  return {
    agentId,
    role,
    sessionFile: `/tmp/sessions/${role}/x.jsonl`,
    phase: 'event',
    event,
  };
}

describe('board engine — adapter events → ledger events → board state', () => {
  let api: LedgerApi;
  let bus: EventBus;
  let engine: BoardEngine;

  beforeAll(() => {
    const db = new LedgerDb(tmpDir());
    bus = new EventBus();
    api = new LedgerApi(db.handle, { bus });
    // E7: the notification center owns derivation (FYI rows land once,
    // at event time); the engine renders the durable table.
    new NotificationCenter({ ledger: api, bus });
    engine = new BoardEngine({ ledger: api, bus });
  });

  it('projects a live ready decision status instead of pinning the default disabled state', () => {
    const ready = new BoardEngine({
      ledger: api,
      bus,
      decisionsStatus: () => ({
        enabled: true,
        status: 'ready',
        reason: null,
        model: '~typesafe/jev-latest',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        credentialPresent: true,
        credentialSource: 'file',
        checkedAt: new Date(0).toISOString(),
        incarnation: 'test-incarnation',
        generation: 7,
      }),
    });
    expect(ready.snapshot().decisions).toMatchObject({ status: 'ready', credentialPresent: true, generation: 7 });
  });

  it('projects ready, degraded, recovered and disabled decision generations without notification ack forgery', () => {
    let current: DecisionRuntimeStatus = {
      enabled: true,
      status: 'ready' as const,
      reason: null,
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: true,
      credentialSource: 'file' as const,
      checkedAt: new Date(0).toISOString(),
      incarnation: 'test-incarnation',
      generation: 1,
    };
    const live = new BoardEngine({ ledger: api, bus, decisionsStatus: () => current });
    expect(live.snapshot().decisions.status).toBe('ready');
    current = { ...current, status: 'degraded', reason: 'provider_degraded', generation: 2 };
    expect(live.snapshot().decisions).toMatchObject({ status: 'degraded', reason: 'provider_degraded', generation: 2 });
    const incident = api.recordNotification({
      id: 'decision-transition-incident', kind: 'decisions.degraded.provider_degraded',
      routing: 'action-required', severity: 'error', title: 'Decision provider degraded',
    });
    api.resolveNotificationsByKindPrefix('decisions.degraded.', 'decisions-runtime');
    current = { ...current, status: 'ready', reason: null, generation: 3 };
    expect(live.snapshot().decisions.status).toBe('ready');
    expect(api.getNotification(incident.id)).toMatchObject({ ackedAt: null, resolvedAt: expect.any(String), resolvedBy: 'decisions-runtime' });
    current = {
      ...current, enabled: false, status: 'disabled', reason: 'disabled',
      credentialPresent: false, credentialSource: 'none', generation: 4,
    };
    expect(live.snapshot().decisions).toMatchObject({ enabled: false, status: 'disabled', generation: 4 });
  });

  it('a spawned agent lands in the ledger + snapshot agent rail', () => {
    engine.onRuntimeEvent({ agentId: 'gru-main', role: 'gru', sessionFile: null, phase: 'spawned' });
    const snapshot = engine.snapshot();
    expect(snapshot.agents.some((a) => a.id === 'gru-main' && a.role === 'gru')).toBe(true);
  });

  it('state + turn events map to agent rows: streaming during a turn, idle at end', () => {
    engine.onRuntimeEvent({ agentId: 'silas-ops', role: 'silas', sessionFile: null, phase: 'spawned' });
    engine.onRuntimeEvent(envelope('silas-ops', 'silas', { type: 'state', state: 'idle' }));
    engine.onRuntimeEvent(envelope('silas-ops', 'silas', { type: 'turn_start' }));
    engine.onRuntimeEvent(envelope('silas-ops', 'silas', { type: 'text_delta', delta: 'x' }));
    let agent = api.getAgent('silas-ops');
    expect(agent?.state).toBe('idle'); // deltas do not change state rows
    engine.onRuntimeEvent(envelope('silas-ops', 'silas', { type: 'state', state: 'streaming' }));
    expect(api.getAgent('silas-ops')?.state).toBe('streaming');
    engine.onRuntimeEvent(envelope('silas-ops', 'silas', { type: 'turn_end' }));
    agent = api.getAgent('silas-ops');
    expect(agent?.state).toBe('idle');
  });

  it('an agent spawned BEFORE the engine attached is registered on its first event (late subscriber)', () => {
    engine.onRuntimeEvent(envelope('bob-dream', 'bob', { type: 'state', state: 'idle' }));
    expect(api.getAgent('bob-dream')?.role).toBe('bob');
  });

  it('lens-chip lifecycle: pending → live on turn_start → done on outcome; 9 chips by default', () => {
    const job = api.addJob({ id: 'engine-job', repo: 'demo-repo', title: 'Lifecycle job' });
    api.setJobStatus(job.id, 'working');
    const round = api.addRound({ jobId: job.id, targetRef: 'sha-abc' });
    expect(round.lenses.length).toBe(9);
    // Spawn + bind lens agents for two lenses.
    engine.onRuntimeEvent({ agentId: 'lens-blind', role: 'perkins', sessionFile: null, phase: 'spawned' });
    engine.onRuntimeEvent({ agentId: 'lens-edge', role: 'perkins', sessionFile: null, phase: 'spawned' });
    api.registerAgent({ id: 'lens-blind', role: 'perkins', roundId: round.id, label: 'lens: blind' });
    api.registerAgent({ id: 'lens-edge', role: 'perkins', roundId: round.id, label: 'lens: edge' });
    api.bindLens(round.id, 'blind', 'lens-blind');
    api.bindLens(round.id, 'edge', 'lens-edge');
    // Live turns flip their chips live.
    engine.onRuntimeEvent(envelope('lens-blind', 'perkins', { type: 'turn_start' }));
    engine.onRuntimeEvent(envelope('lens-edge', 'perkins', { type: 'turn_start' }));
    let current = api.getRound(round.id);
    expect(current?.lenses.find((c) => c.lens === 'blind')?.state).toBe('live');
    expect(current?.lenses.find((c) => c.lens === 'edge')?.state).toBe('live');
    expect(current?.lenses.find((c) => c.lens === 'security')?.state).toBe('pending'); // untouched
    // Outcome resolves one lens; the other keeps streaming.
    engine.onRuntimeEvent({ agentId: 'lens-blind', role: 'perkins', sessionFile: null, phase: 'disposed' });
    api.setLensOutcome(round.id, 'blind', 'done', 'verdict json recorded');
    current = api.getRound(round.id);
    expect(current?.lenses.find((c) => c.lens === 'blind')?.state).toBe('done');
    expect(current?.lenses.find((c) => c.lens === 'edge')?.state).toBe('live');
  });

  it('an errored lens agent flips its chip error (event-derived)', () => {
    const job = api.addJob({ id: 'err-job', repo: 'demo-repo', title: 'Error path' });
    const round = api.addRound({ jobId: job.id, lenses: ['solo'] });
    engine.onRuntimeEvent({ agentId: 'lens-solo', role: 'perkins', sessionFile: null, phase: 'spawned' });
    api.registerAgent({ id: 'lens-solo', role: 'perkins', roundId: round.id });
    api.bindLens(round.id, 'solo', 'lens-solo');
    engine.onRuntimeEvent(envelope('lens-solo', 'perkins', { type: 'turn_start' }));
    engine.onRuntimeEvent(
      envelope('lens-solo', 'perkins', { type: 'state', state: 'error', error: 'provider cap' }),
    );
    const current = api.getRound(round.id);
    expect(current?.lenses.find((c) => c.lens === 'solo')?.state).toBe('error');
  });

  it('a fatal adapter error records an agent.error event and surfaces a notification', () => {
    engine.onRuntimeEvent(
      envelope('lens-solo', 'perkins', { type: 'error', error: 'connection lost', fatal: true }),
    );
    const events = api.listEvents();
    expect(
      events.some(
        (e) => e.kind === 'agent.error' && (e.payload as { error: string }).error === 'connection lost',
      ),
    ).toBe(true);
    const notifications = engine.notifications();
    expect(
      notifications.some(
        (n) => n.kind === 'agent.error' && n.routing === 'fyi' && (n.detail ?? '').includes('connection lost'),
      ),
    ).toBe(true);
  });

  it('snapshot is repo-grouped with rounds + lens chips; blocked jobs raise notifications', () => {
    api.setJobStatus('err-job', 'blocked');
    const snapshot: BoardSnapshot = engine.snapshot();
    const demoRepo = snapshot.repos.find((r) => r.name === 'demo-repo');
    expect(demoRepo).toBeDefined();
    const jobIds = demoRepo?.jobs.map((j) => j.id) ?? [];
    expect(jobIds).toContain('engine-job');
    expect(jobIds).toContain('err-job');
    const engineJob = demoRepo?.jobs.find((j) => j.id === 'engine-job');
    expect(engineJob?.rounds[0]?.lenses.filter((c) => c.state === 'done' || c.state === 'live').length).toBe(2);
    expect(snapshot.notifications.some((n) => n.title.includes('blocked') && n.routing === 'fyi')).toBe(true);
    // Other repos form their own groups.
    api.addJob({ id: 'solo-job', repo: 'website', title: 'Copy pass' });
    expect(engine.snapshot().repos.some((r) => r.name === 'website')).toBe(true);
  });

  it('board state REBUILDS from the ledger alone (engine restart parity)', () => {
    const db2 = new LedgerDb(cleanupDirs[0] as string);
    const bus2 = new EventBus();
    const api2 = new LedgerApi(db2.handle, { bus: bus2 });
    const engine2 = new BoardEngine({ ledger: api2, bus: bus2 });
    const snapshot = engine2.snapshot();
    const job = snapshot.repos.flatMap((r) => r.jobs).find((j) => j.id === 'engine-job');
    expect(job?.status).toBe('working');
    const chips = job?.rounds[0]?.lenses ?? [];
    expect(chips.find((c) => c.lens === 'blind')?.state).toBe('done');
    expect(chips.find((c) => c.lens === 'edge')?.state).toBe('live');
    expect(snapshot.agents.some((a) => a.id === 'gru-main' && a.role === 'gru')).toBe(true);
    db2.close();
  });

  it('change listeners fire on bus events (the WS push trigger)', () => {
    let fired = 0;
    const unsubscribe = engine.onChange(() => {
      fired += 1;
    });
    api.addJob({ id: 'change-job', repo: 'demo-repo', title: 'Trigger' });
    expect(fired).toBe(1);
    unsubscribe();
    api.addJob({ id: 'after-unsub', repo: 'demo-repo', title: 'No trigger' });
    expect(fired).toBe(1);
  });

  it('E6 r1: a TAP-shape agent (registered WITHOUT roundId) derives its chip after bindLens alone', () => {
    const job = api.addJob({ id: 'tap-job', repo: 'demo-repo', title: 'Tap wiring' });
    const round = api.addRound({ jobId: job.id, lenses: ['blind'] });
    // Exactly what the registry tap produces at spawn time: no round context.
    engine.onRuntimeEvent({ agentId: 'tap-lens', role: 'perkins', sessionFile: null, phase: 'spawned' });
    // The documented ONE-call wiring: bind the chip to the agent.
    api.bindLens(round.id, 'blind', 'tap-lens');
    // The agent's round row got backfilled — the derivation now finds it.
    expect(api.getAgent('tap-lens')?.roundId).toBe(round.id);
    engine.onRuntimeEvent(envelope('tap-lens', 'perkins', { type: 'turn_start' }));
    expect(api.getRound(round.id)?.lenses.find((c) => c.lens === 'blind')?.state).toBe('live');
    engine.onRuntimeEvent(
      envelope('tap-lens', 'perkins', { type: 'state', state: 'error', error: 'boom' }),
    );
    expect(api.getRound(round.id)?.lenses.find((c) => c.lens === 'blind')?.state).toBe('error');
    // listLensBindings drives the derivation directly (indexed, no scans).
    expect(api.listLensBindings('tap-lens')).toEqual([{ roundId: round.id, lens: 'blind' }]);
  });

  it('a blocked job notification row is durable — it outlives the event window', () => {
    api.addJob({ id: 'old-blocked', repo: 'demo-repo', title: 'Blocked long ago' });
    api.setJobStatus('old-blocked', 'working');
    api.setJobStatus('old-blocked', 'blocked');
    // Push 200+ newer events so the blocked transition leaves any event
    // window — the durable notification ROW keeps the item pinned.
    for (let i = 0; i < 210; i += 1) {
      api.appendCustomEvent({ kind: 'noise', payload: { i } });
    }
    const feed = engine.notifications();
    expect(feed.some((n) => n.title.includes('old-blocked') && n.severity === 'error')).toBe(true);
    // Derivation fired exactly once at event time.
    expect(feed.filter((n) => n.title.includes('old-blocked')).length).toBe(1);
  });

  it('E7 r1-16: a breaker-stopped agent renders its supervision state on the board (degraded board)', () => {
    engine.onRuntimeEvent({ agentId: 'stopped-minion', role: 'minion', sessionFile: null, phase: 'spawned' });
    const supervised = new BoardEngine({
      ledger: api,
      bus,
      supervisionFor: (agentId) =>
        agentId === 'stopped-minion'
          ? {
              agentId,
              role: 'minion',
              slotId: null,
              state: 'stopped',
              restarts: 3,
              breakerOpen: true,
              stopReason: 'crash loop',
              openTurn: false,
              openToolCalls: 0,
              lastEventAt: '2026-09-18T00:00:00.000Z',
              lastFileBytes: 0,
            }
          : null,
    });
    const snapshot = supervised.snapshot();
    const row = snapshot.agents.find((a) => a.id === 'stopped-minion');
    expect(row?.supervision).toMatchObject({ state: 'stopped', restarts: 3, breakerOpen: true, stopReason: 'crash loop' });
    // Unsupervised agents carry null — the UI renders no chip for them.
    const plain = supervised.snapshot().agents.find((a) => a.id === 'gru-main');
    expect(plain?.supervision).toBeNull();
  });

  it('a ledger hiccup never takes the runtime path down (observer isolation)', () => {
    // Unknown agent + no registration possible is the failure shape; the
    // engine must swallow + continue (logged), not throw upward.
    expect(() =>
      engine.onRuntimeEvent(envelope('never-spawned', 'minion', { type: 'turn_start' })),
    ).not.toThrow();
    // Late-subscriber registration rescued it.
    expect(api.getAgent('never-spawned')).not.toBeNull();
  });
});

describe('board engine — liveness-first rail and job trackers', () => {
  function fresh(): { api: LedgerApi; bus: EventBus; engine: BoardEngine } {
    const db = new LedgerDb(tmpDir());
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    return { api, bus, engine: new BoardEngine({ ledger: api, bus }) };
  }

  it('projects heist metadata and retains full worker/job IDs through observer lifecycle', () => {
    const { api, engine } = fresh();
    const job = api.addJob({ id: 'wake-crew', repo: 'fixture', title: 'Full wake-up alert contract', displayName: 'wake alerts' });
    api.registerAgent({ id: 'full-worker-uuid-dec9', role: 'minion', jobId: job.id });
    engine.onRuntimeEvent({ agentId: 'full-worker-uuid-dec9', role: 'minion', sessionFile: '/session', phase: 'spawned' });
    api.setAgentState('full-worker-uuid-dec9', 'idle');
    api.setAgentState('full-worker-uuid-dec9', 'disposed');
    expect(engine.snapshot().repos.flatMap((repo) => repo.jobs).find((row) => row.id === job.id)).toMatchObject({ title: job.title, displayName: 'wake alerts' });
    expect(engine.snapshot().agents.find((row) => row.id === 'full-worker-uuid-dec9')).toMatchObject({ jobId: job.id, state: 'disposed', sessionFile: '/session' });
  });

  it('sorts the rail by liveness before role: disposed gru BELOW streaming perkins; streaming above idle', () => {
    const { api, engine } = fresh();
    api.registerAgent({ id: 'chat-gru', role: 'gru' });
    api.setAgentState('chat-gru', 'disposed');
    api.registerAgent({ id: 'lens-perkins', role: 'perkins' });
    api.setAgentState('lens-perkins', 'streaming');
    api.registerAgent({ id: 'ops-silas', role: 'silas' });
    api.setAgentState('ops-silas', 'idle');
    api.registerAgent({ id: 'err-perkins', role: 'perkins' });
    api.setAgentState('err-perkins', 'error');
    api.registerAgent({ id: 'spawn-bob', role: 'bob' }); // spawning
    const ids = engine.snapshot().agents.map((agent) => agent.id);
    // The observed bug: a disposed gru epoch outranked a streaming lens.
    expect(ids.indexOf('lens-perkins')).toBeLessThan(ids.indexOf('ops-silas'));
    expect(ids.indexOf('lens-perkins')).toBeLessThan(ids.indexOf('chat-gru'));
    expect(ids.indexOf('spawn-bob')).toBeLessThan(ids.indexOf('ops-silas'));
    expect(ids.indexOf('ops-silas')).toBeLessThan(ids.indexOf('err-perkins'));
    expect(ids.indexOf('err-perkins')).toBeLessThan(ids.indexOf('chat-gru'));
  });

  it('breaks liveness ties by role order, then newest activity', () => {
    const { api, engine } = fresh();
    for (const [id, role] of [
      ['minion-a', 'minion'],
      ['gru-a', 'gru'],
      ['silas-a', 'silas'],
      ['bob-a', 'bob'],
    ] as const) {
      api.registerAgent({ id, role });
      api.setAgentState(id, 'idle');
    }
    expect(engine.snapshot().agents.map((agent) => agent.id)).toEqual([
      'gru-a',
      'silas-a',
      'minion-a',
      'bob-a',
    ]);
    api.registerAgent({ id: 'minion-b', role: 'minion' });
    api.setAgentState('minion-b', 'idle');
    // minion-b's state change is newer — it leads minion-a inside the band.
    expect(engine.snapshot().agents.map((agent) => agent.id)).toEqual([
      'gru-a',
      'silas-a',
      'minion-b',
      'minion-a',
      'bob-a',
    ]);
  });

  it('lane strip + round trackers carry branch, base sha, attempts, blockers and activity from the record', () => {
    const { api, engine } = fresh();
    const job = api.addJob({ id: 'track-job', repo: 'demo-repo', title: 'Tracked' });
    api.setJobStatus(job.id, 'working');
    api.registerWorktree({
      id: job.id,
      kind: 'job',
      repoPath: '/repos/demo-repo',
      repoName: 'demo-repo',
      path: '/worktrees/demo-repo/job-track-job',
      branch: 'gru/track-job',
      sha: 'abc123base',
      jobId: job.id,
    });
    const round = api.addRound({ jobId: job.id, targetRef: 'abc123base' });
    // One lens attempt, then a retry with the attempt-suffixed label.
    api.registerAgent({ id: 'lens-blind-1', role: 'perkins', label: 'blind:001', roundId: round.id, jobId: job.id });
    api.registerAgent({ id: 'lens-blind-2', role: 'perkins', label: 'blind:001#2', roundId: round.id, jobId: job.id });
    api.registerAgent({ id: 'lens-edge-1', role: 'perkins', label: 'edge:001', roundId: round.id, jobId: job.id });
    api.setAgentState('lens-blind-2', 'streaming');
    api.setLensOutcome(round.id, 'blind', 'done', 'blocker — two unsafe retries remain');
    api.setLensOutcome(round.id, 'edge', 'done', 'clean — nothing found');
    const view = engine.snapshot().repos.flatMap((repo) => repo.jobs).find((entry) => entry.id === job.id);
    expect(view?.lane).toMatchObject({ branch: 'gru/track-job', sha: 'abc123base', status: 'active' });
    expect(view?.lastAgentActivity).not.toBeNull();
    const roundView = view?.rounds[0];
    expect(roundView?.lensAttempts).toEqual([
      { lens: 'blind', attempts: 2 },
      { lens: 'edge', attempts: 1 },
    ]);
    expect(roundView?.blockers).toBe(1);
    expect(roundView?.lenses.find((chip) => chip.lens === 'blind')?.verdict).toBe('blocker');
    expect(roundView?.lenses.find((chip) => chip.lens === 'edge')?.verdict).toBe('clean');
  });

  it('counts a charged ledger start with NO registered child as a started attempt (gh-169 P11)', () => {
    const { api, engine } = fresh();
    const job = api.addJob({ id: 'charged-job', repo: 'demo-repo', title: 'Charged' });
    api.setJobStatus(job.id, 'working');
    api.registerWorktree({
      id: job.id,
      kind: 'job',
      repoPath: '/repos/demo-repo',
      repoName: 'demo-repo',
      path: '/worktrees/demo-repo/job-charged-job',
      branch: 'gru/charged-job',
      sha: 'ab12cdbase',
      jobId: job.id,
    });
    const round = api.addRound({ jobId: job.id, targetRef: 'ab12cdbase' });
    // The specialist start was journaled (the budget authority) but the
    // spawn crashed before any agent row existed: the attempt still
    // counts, and the MAX merge never lets it fall back to zero.
    api.appendCustomEvent({
      kind: 'round.specialist-started',
      jobId: job.id,
      roundId: round.id,
      payload: { lens: 'blind', attempt: 1, originRoundId: round.id },
    });
    const view = engine.snapshot().repos.flatMap((repo) => repo.jobs).find((entry) => entry.id === job.id);
    expect(view?.rounds[0]?.lensAttempts).toEqual([{ lens: 'blind', attempts: 1 }]);
    // A later registered child for the SAME lens never doubles the count
    // (MAX, not sum).
    api.registerAgent({ id: 'sp-blind-late', role: 'perkins', label: 'blind', roundId: round.id, jobId: job.id });
    const after = engine.snapshot().repos.flatMap((repo) => repo.jobs).find((entry) => entry.id === job.id);
    expect(after?.rounds[0]?.lensAttempts).toEqual([{ lens: 'blind', attempts: 1 }]);
  });

  it('counts a ledger-only RETRY as ×2 with a single registered child (gh-169 R4-8)', () => {
    const { api, engine } = fresh();
    const job = api.addJob({ id: 'retry-job', repo: 'demo-repo', title: 'Retry' });
    api.setJobStatus(job.id, 'working');
    api.registerWorktree({
      id: job.id,
      kind: 'job',
      repoPath: '/repos/demo-repo',
      repoName: 'demo-repo',
      path: '/worktrees/demo-repo/job-retry-job',
      branch: 'gru/retry-job',
      sha: 'cd34efbase',
      jobId: job.id,
    });
    const round = api.addRound({ jobId: job.id, targetRef: 'cd34efbase' });
    // Two charged starts (a retry) in the journal, ONE registered child:
    // the board multiplier must show ×2 from the journal alone.
    for (const attempt of [1, 2] as const) {
      api.appendCustomEvent({
        kind: 'round.specialist-started',
        jobId: job.id,
        roundId: round.id,
        payload: { lens: 'blind', attempt, originRoundId: round.id },
      });
    }
    api.registerAgent({ id: 'sp-blind-only', role: 'perkins', label: 'blind', roundId: round.id, jobId: job.id });
    const view = engine.snapshot().repos.flatMap((repo) => repo.jobs).find((entry) => entry.id === job.id);
    expect(view?.rounds[0]?.lensAttempts).toEqual([{ lens: 'blind', attempts: 2 }]);
  });

  it('counts whole-PR bare-lens specialist attempts (blind, blind#2) alongside legacy lens:chunk labels', () => {
    const { api, engine } = fresh();
    const job = api.addJob({ id: 'whole-job', repo: 'demo-repo', title: 'Whole' });
    api.setJobStatus(job.id, 'working');
    api.registerWorktree({
      id: job.id,
      kind: 'job',
      repoPath: '/repos/demo-repo',
      repoName: 'demo-repo',
      path: '/worktrees/demo-repo/job-whole-job',
      branch: 'gru/whole-job',
      sha: 'def456base',
      jobId: job.id,
    });
    const round = api.addRound({ jobId: job.id, targetRef: 'def456base' });
    // Whole-PR specialists mint bare lens labels; retries append #attempt.
    api.registerAgent({ id: 'sp-blind-1', role: 'perkins', label: 'blind', roundId: round.id, jobId: job.id });
    api.registerAgent({ id: 'sp-blind-2', role: 'perkins', label: 'blind#2', roundId: round.id, jobId: job.id });
    api.registerAgent({ id: 'sp-security-1', role: 'perkins', label: 'security', roundId: round.id, jobId: job.id });
    api.setAgentState('sp-blind-2', 'streaming');
    api.setLensOutcome(round.id, 'blind', 'done', 'clean — lead retained no finding sourced from this specialist');
    api.setLensOutcome(round.id, 'security', 'done', 'not used — lead-owned whole-PR review');
    const view = engine.snapshot().repos.flatMap((repo) => repo.jobs).find((entry) => entry.id === job.id);
    const roundView = view?.rounds[0];
    expect(roundView?.lensAttempts).toEqual([
      { lens: 'blind', attempts: 2 },
      { lens: 'security', attempts: 1 },
    ]);
    // The 'lead' agent label is not a lens and never becomes an attempt.
    api.registerAgent({ id: 'lead-1', role: 'perkins', label: 'lead', roundId: round.id, jobId: job.id });
    const after = engine.snapshot().repos.flatMap((repo) => repo.jobs).find((entry) => entry.id === job.id)?.rounds[0];
    expect(after?.lensAttempts).toEqual([
      { lens: 'blind', attempts: 2 },
      { lens: 'security', attempts: 1 },
    ]);
  });

  it('counts unacked action-required rows from the whole table, not the feed window', () => {
    const { api, engine } = fresh();
    api.recordNotification({ id: 'n-action', kind: 'test.notice', routing: 'action-required', severity: 'error', title: 'Ack me' });
    api.recordNotification({ id: 'n-fyi', kind: 'test.notice', routing: 'fyi', severity: 'info', title: 'FYI' });
    expect(engine.snapshot().unackedActionRequired).toBe(1);
    expect(() => api.ackNotification('n-action', 'web')).toThrow(/require a Gru disposition/);
    expect(engine.snapshot().unackedActionRequired).toBe(1);
    api.disposeMachineNotification('n-action', 'Fixed the cause');
    expect(engine.snapshot().unackedActionRequired).toBe(0);
    const resolved = api.recordNotification({ id: 'n-resolved', kind: 'test.notice', routing: 'action-required', severity: 'error', title: 'Resolved' });
    expect(engine.snapshot().unackedActionRequired).toBe(1);
    api.resolveNotificationsByKindPrefix('test.', 'runtime');
    expect(api.getNotification(resolved.id)?.resolvedAt).not.toBeNull();
    expect(engine.snapshot().unackedActionRequired).toBe(0);
  });

  it('unackedActionRequired counts LIVE rows only — rows bound to merged/done jobs are closed receipts', () => {
    const { api, engine } = fresh();
    // An unbound row stays global (no job → cannot be terminal).
    api.recordNotification({ id: 'n-global', kind: 'test.notice', routing: 'action-required', severity: 'error', title: 'Global' });

    const live = api.addJob({ id: 'live-job', repo: 'demo-repo', title: 'Live lane' });
    api.setJobStatus(live.id, 'working');
    api.registerAgent({ id: 'live-minion', role: 'minion', jobId: live.id });
    api.recordNotification({
      id: 'n-live',
      kind: 'test.live.notice',
      routing: 'action-required',
      severity: 'error',
      title: 'Agent live-minion stopped: quota wall',
      agentId: 'live-minion',
    });
    expect(engine.snapshot().unackedActionRequired).toBe(2);

    const merged = api.addJob({ id: 'merged-job', repo: 'demo-repo', title: 'Merged lane' });
    api.registerAgent({ id: 'merged-minion', role: 'minion', jobId: merged.id });
    api.recordNotification({
      id: 'n-merged',
      kind: 'test.merged.notice',
      routing: 'action-required',
      severity: 'error',
      title: 'Leftover escalation on a merged lane',
      agentId: 'merged-minion',
    });
    api.setJobStatus(merged.id, 'working');
    api.setJobStatus(merged.id, 'delivered');
    api.setJobStatus(merged.id, 'in-review');
    api.setJobStatus(merged.id, 'merged');
    // The merged lane's leftover escalation is a closed receipt: the live
    // count drops it while the row itself stays durable in the bell.
    expect(engine.snapshot().unackedActionRequired).toBe(2); // global + live

    const done = api.addJob({ id: 'done-job', repo: 'demo-repo', title: 'Done lane' });
    api.registerAgent({ id: 'done-minion', role: 'minion', jobId: done.id });
    api.recordNotification({
      id: 'n-done',
      kind: 'test.notice',
      routing: 'action-required',
      severity: 'error',
      title: 'Leftover on a done lane',
      agentId: 'done-minion',
    });
    api.setJobStatus(done.id, 'working');
    api.setJobStatus(done.id, 'done');
    expect(engine.snapshot().unackedActionRequired).toBe(2);

    // Nothing was acked or resolved — the record keeps the receipts.
    for (const id of ['n-merged', 'n-done']) {
      const row = api.getNotification(id);
      expect(row?.ackedAt).toBeNull();
      expect(row?.resolvedAt).toBeNull();
    }

    // Merging the live job closes its row the same way.
    api.setJobStatus(live.id, 'delivered');
    api.setJobStatus(live.id, 'in-review');
    api.setJobStatus(live.id, 'merged');
    expect(engine.snapshot().unackedActionRequired).toBe(1); // the unbound global row
  });

  it('the shared live/receipt fixture classifies identically for the chip and the bands', () => {
    // ONE fixture file is consumed by this suite and by
    // web/src/lib/board-signals.test.ts; the SQL live count and the web
    // attribution must agree on the same rows (followup review A4/V4).
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'live-receipt-classification.json'), 'utf-8'),
    ) as {
      readonly jobs: readonly { readonly id: string; readonly status: string }[];
      readonly agents: readonly { readonly id: string; readonly jobId: string }[];
      readonly notifications: readonly {
        readonly id: string;
        readonly kind: string;
        readonly routing: string;
        readonly agentId: string | null;
      }[];
      readonly expected: { readonly liveCount: number };
    };
    const { api } = fresh();
    for (const job of fixture.jobs) {
      api.addJob({ id: job.id, repo: 'fixture', title: job.id, briefing: 'b' });
      if (job.status === 'working') api.setJobStatus(job.id, 'working');
      if (job.status === 'done') {
        api.setJobStatus(job.id, 'working');
        api.setJobStatus(job.id, 'done');
      }
      if (job.status === 'merged') {
        api.setJobStatus(job.id, 'working');
        api.setJobStatus(job.id, 'delivered');
        api.setJobStatus(job.id, 'in-review');
        api.setJobStatus(job.id, 'merged');
      }
    }
    for (const agent of fixture.agents) {
      api.registerAgent({ id: agent.id, role: 'minion', jobId: agent.jobId });
    }
    for (const notification of fixture.notifications) {
      api.recordNotification({
        id: notification.id,
        kind: notification.kind,
        routing: notification.routing as 'action-required' | 'fyi',
        severity: 'error',
        title: notification.id,
        ...(notification.agentId !== null ? { agentId: notification.agentId } : {}),
      });
    }
    expect(api.countLivePendingActionRequired()).toBe(fixture.expected.liveCount);
    // The durable record keeps the terminal-bound receipts: live + 2.
    expect(api.countPendingActionRequiredIncludingReceipts()).toBe(fixture.expected.liveCount + 2);
  });

  it('counts needs-owner rows separately (the FOR YOU band never borrows the machine queue)', () => {
    const { api, engine } = fresh();
    api.recordNotification({ id: 'n-machine', kind: 'test.notice', routing: 'action-required', severity: 'error', title: 'Machine' });
    api.recordNotification({ id: 'n-owner', kind: 'test.notice', routing: 'needs-owner', severity: 'error', title: 'Owner' });
    let snapshot = engine.snapshot();
    expect(snapshot.unackedActionRequired).toBe(1);
    expect(snapshot.unackedNeedsOwner).toBe(1);
    api.ackNotification('n-owner', 'web');
    snapshot = engine.snapshot();
    expect(snapshot.unackedActionRequired).toBe(1);
    expect(snapshot.unackedNeedsOwner).toBe(0);
  });

  it('keeps pending owner-only stops visible despite thirty newer machine/FYI rows', () => {
    const { api, engine } = fresh();
    const owner = api.recordNotification({ id: 'owner-stop', kind: 'supervision.breaker', routing: 'needs-owner', severity: 'info', title: 'Owner-only re-arm' });
    for (let i = 0; i < 35; i += 1) {
      api.recordNotification({ id: `noise-${i}`, kind: 'noise', routing: i % 2 ? 'fyi' : 'action-required', severity: 'info', title: `Noise ${i}` });
    }
    const snap = engine.snapshot();
    expect(snap.unackedNeedsOwner).toBe(1);
    expect(snap.notifications.find((row) => row.id === owner.id)).toMatchObject({ routing: 'needs-owner', ackedAt: null });
  });

  it('keeps pending machine incidents visible beyond the recent feed while closed rows stay bounded', () => {
    const { api, engine } = fresh();
    api.recordNotification({ id: 'old-machine', kind: 'test.machine', routing: 'action-required', severity: 'error', title: 'Still needs Gru' });
    for (let i = 0; i < 35; i += 1) {
      api.recordNotification({ id: `feed-${i}`, kind: 'noise', routing: 'fyi', severity: 'info', title: `Noise ${i}` });
    }
    expect(engine.snapshot().notifications.find((row) => row.id === 'old-machine')).toMatchObject({ routing: 'action-required', resolvedAt: null });
    api.disposeMachineNotification('old-machine', 'Remediated');
    expect(engine.snapshot().notifications.some((row) => row.id === 'old-machine')).toBe(false);
  });

  it('tracks autonomous wakes from the durable gru.wake events', () => {
    const { api, engine } = fresh();
    expect(engine.snapshot().wakes).toEqual({ count: 0, lastAt: null });
    api.appendCustomEvent({ kind: 'gru.wake', payload: { notification_ids: ['n1'], count: 1 } });
    const first = engine.snapshot().wakes;
    expect(first.count).toBe(1);
    expect(first.lastAt).not.toBeNull();
    api.appendCustomEvent({ kind: 'gru.wake', payload: { notification_ids: ['n2'], count: 1 } });
    expect(engine.snapshot().wakes.count).toBe(2);
  });
});

describe('board engine — FOR YOU owner-PR projection on the snapshot', () => {
  function fresh(): { api: LedgerApi; bus: EventBus; engine: BoardEngine } {
    const db = new LedgerDb(tmpDir());
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    return { api, bus, engine: new BoardEngine({ ledger: api, bus }) };
  }

  const SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
  const PR_URL = 'https://github.com/example/demo/pull/7';

  /** Stage one job exactly as the real flow would: in-review + PR + a
   * head-bound approved round + a matching branch-state observation. */
  function stageReadyJob(api: LedgerApi, id: string, sha: string = SHA): void {
    const job = api.addJob({ id, repo: 'demo', title: `Heist ${id}` });
    api.setJobPr(id, PR_URL);
    // The legal staging path: dispatched → working → in-review (a PR on
    // record is exactly what moves a lane into review).
    api.setJobStatus(id, 'working');
    api.setJobStatus(id, 'in-review');
    const round = api.addRound({ jobId: id, targetRef: sha });
    api.setRoundStatus(round.id, 'live');
    api.setRoundVerdict(round.id, 'approved');
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: id,
      payload: {
        repo: 'example/demo',
        branch: `gru/${id}`,
        sha,
        merged: false,
        pr_open: true,
        mergeable_state: 'clean',
        pr_number: 7,
        pr_url: PR_URL,
        merge_commit_sha: null,
        ci: { sha, status: 'green', signature: '', failures: [], checks: ['ci'] },
      },
    });
    void job;
  }

  it('ships one ownerPrs row for the exact-head ready job (stable id, job order)', () => {
    const { api, engine } = fresh();
    stageReadyJob(api, 'job-b');
    stageReadyJob(api, 'job-a');
    const snap = engine.snapshot();
    expect(snap.ownerPrs.map((row) => row.id)).toEqual(['owner-pr:job-a', 'owner-pr:job-b']);
    expect(snap.ownerPrs[0]).toMatchObject({ jobId: 'job-a', prUrl: PR_URL, sha: SHA });
  });

  it('drops the row when the head moves after the approval (stale CI/verdict at the old sha)', () => {
    const { api, engine } = fresh();
    stageReadyJob(api, 'job-moved', SHA);
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: 'job-moved',
      payload: {
        repo: 'example/demo',
        branch: 'gru/job-moved',
        sha: 'ffff0000aaaa1111bbbb2222cccc3333dddd4444',
        merged: false,
        pr_open: true,
        // The FIXED poll writes null here: GitHub had not computed
        // mergeability for the new head, and the old head's 'clean' no
        // longer certifies it.
        mergeable_state: null,
        pr_number: 7,
        pr_url: PR_URL,
        merge_commit_sha: null,
        ci: null,
      },
    });
    expect(engine.snapshot().ownerPrs).toEqual([]);
  });

  it('keeps a delta READY gated until its final whole-change pass closes', () => {
    const { api, engine } = fresh();
    // (a) ONLY the pre-commit marker exists: a crash between the verdict
    // commit and the review event must not expose owner-ready.
    stageReadyJob(api, 'job-marker-only');
    api.appendCustomEvent({
      kind: 'round.final-pass-required',
      jobId: 'job-marker-only',
      roundId: api.listRounds('job-marker-only').at(-1)!.id,
      payload: { targetSha: SHA, reviewScope: 'delta' },
    });
    expect(engine.snapshot().ownerPrs).toEqual([]);

    // (b) ONLY the review-event flag exists (legacy/post-commit shape).
    stageReadyJob(api, 'job-event-only');
    api.appendCustomEvent({
      kind: 'round.perkins-review',
      jobId: 'job-event-only',
      roundId: api.listRounds('job-event-only').at(-1)!.id,
      payload: { canonicalVerdict: 'READY TO MERGE', reviewScope: 'delta', finalPassRequired: true },
    });
    expect(engine.snapshot().ownerPrs).toEqual([]);

    // (c) The whole-scope round closes and its review event carries no
    // pending flag: the newest round is whole and owner-ready.
    stageReadyJob(api, 'job-final-pass');
    api.appendCustomEvent({
      kind: 'round.final-pass-required',
      jobId: 'job-final-pass',
      roundId: api.listRounds('job-final-pass').at(-1)!.id,
      payload: { targetSha: SHA, reviewScope: 'delta' },
    });
    expect(engine.snapshot().ownerPrs).toEqual([]);
    const finalRound = api.addRound({ jobId: 'job-final-pass', targetRef: SHA });
    api.setRoundStatus(finalRound.id, 'live');
    api.setRoundVerdict(finalRound.id, 'approved');
    api.appendCustomEvent({
      kind: 'round.perkins-review',
      jobId: 'job-final-pass',
      roundId: finalRound.id,
      payload: { canonicalVerdict: 'READY TO MERGE', reviewScope: 'whole' },
    });
    expect(engine.snapshot().ownerPrs.map((row) => row.id)).toEqual(['owner-pr:job-final-pass']);
  });

  it('drops the row when the job takes a hold (blocked) or a newer round is changes-requested', () => {
    const { api, engine } = fresh();
    stageReadyJob(api, 'job-hold');
    api.setJobStatus('job-hold', 'blocked');
    expect(engine.snapshot().ownerPrs).toEqual([]);

    stageReadyJob(api, 'job-rejected');
    const round = api.addRound({ jobId: 'job-rejected', targetRef: SHA });
    api.setRoundStatus(round.id, 'live');
    api.setRoundVerdict(round.id, 'changes-requested');
    expect(engine.snapshot().ownerPrs).toEqual([]);
  });

  it('settles the row only on confirmed merged state, never on a link click', () => {
    const { api, engine } = fresh();
    stageReadyJob(api, 'job-merged');
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: 'job-merged',
      payload: {
        repo: 'example/demo',
        branch: 'gru/job-merged',
        sha: SHA,
        merged: true,
        pr_open: false,
        mergeable_state: 'clean',
        pr_number: 7,
        pr_url: PR_URL,
        merge_commit_sha: 'abcd0000abcd0000abcd0000abcd0000abcd0000',
        ci: { sha: SHA, status: 'green', signature: '', failures: [], checks: ['ci'] },
      },
    });
    expect(engine.snapshot().ownerPrs).toEqual([]);
  });

  it('FOR YOU r1: drops the row when the PR closes WITHOUT merging (close-after-ready transition)', () => {
    const { api, engine } = fresh();
    stageReadyJob(api, 'job-closed');
    // The PR is closed on GitHub but never merged: only the explicitly-open
    // gate settles it now — the row must not survive on stale readiness.
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: 'job-closed',
      payload: {
        repo: 'example/demo',
        branch: 'gru/job-closed',
        sha: SHA,
        merged: false,
        pr_open: false,
        mergeable_state: 'clean',
        pr_number: 7,
        pr_url: PR_URL,
        merge_commit_sha: null,
        ci: { sha: SHA, status: 'green', signature: '', failures: [], checks: ['ci'] },
      },
    });
    expect(engine.snapshot().ownerPrs).toEqual([]);
  });

  it('FOR YOU r1: a legacy branch-state event without pr_open fails closed until the poll re-observes', () => {
    const { api, engine } = fresh();
    // Exactly stageReadyJob but with the pre-r1 payload (no pr_open key) —
    // an event written before this change parses to prOpen null and must
    // not qualify; the next poll tick rewrites the cursor with the status.
    const job = api.addJob({ id: 'job-legacy', repo: 'demo', title: 'Heist job-legacy' });
    api.setJobPr('job-legacy', PR_URL);
    api.setJobStatus('job-legacy', 'working');
    api.setJobStatus('job-legacy', 'in-review');
    const round = api.addRound({ jobId: 'job-legacy', targetRef: SHA });
    api.setRoundStatus(round.id, 'live');
    api.setRoundVerdict(round.id, 'approved');
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: 'job-legacy',
      payload: {
        repo: 'example/demo',
        branch: 'gru/job-legacy',
        sha: SHA,
        merged: false,
        mergeable_state: 'clean',
        pr_number: 7,
        pr_url: PR_URL,
        merge_commit_sha: null,
        ci: { sha: SHA, status: 'green', signature: '', failures: [], checks: ['ci'] },
      },
    });
    void job;
    expect(engine.snapshot().ownerPrs).toEqual([]);
  });

  it('keeps an old pending owner stop AND a fresh ownerPrs row in one snapshot (distinct classes coexist)', () => {
    const { api, engine } = fresh();
    stageReadyJob(api, 'job-ready');
    api.recordNotification({
      id: 'old-owner-stop',
      kind: 'supervision.breaker',
      routing: 'needs-owner',
      severity: 'info',
      title: 'Owner-only re-arm',
    });
    for (let i = 0; i < 35; i += 1) {
      api.recordNotification({ id: `feed-${i}`, kind: 'noise', routing: 'fyi', severity: 'info', title: `Noise ${i}` });
    }
    const snap = engine.snapshot();
    expect(snap.unackedNeedsOwner).toBe(1);
    expect(snap.notifications.find((row) => row.id === 'old-owner-stop')).toMatchObject({ ackedAt: null });
    expect(snap.ownerPrs.map((row) => row.jobId)).toEqual(['job-ready']);
  });

  it('the main assembly binds the supervisor stop truth into the board engine (assembly alarm)', () => {
    // Twelve-followthrough A3: the waiting-chip truth rides a main.ts
    // closure; engine unit tests inject their own supervisionFor and the
    // browser gate runs against the mock, so dropping the production
    // binding stayed green. This is the repo's established source-drift
    // alarm pattern (the same shape as the driver/notifier pins).
    const mainSource = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(mainSource).toMatch(
      /new BoardEngine\(\{[\s\S]*?supervisionFor:\s*\(agentId\)\s*=>\s*supervisor\?\.viewFor\(agentId\)\s*\?\?\s*null/,
    );
  });

  it('bounds the snapshot to the newest receipt window while live rows stay complete (D3)', () => {
    // Owner decision D3: closed receipts stay unacked forever by design, so
    // the unbounded scan must carry live rows only plus a bounded receipt
    // window; the paged route serves older receipts on demand.
    const dir = mkdtempSync(join(tmpdir(), 'gru-d3-'));
    const db = new LedgerDb(dir);
    const bus = new EventBus();
    const ledger = new LedgerApi(db.handle, { bus });
    try {
      ledger.addJob({ id: 'job-d3', repo: 'r', title: 'D3', briefing: 'b' });
      ledger.setJobStatus('job-d3', 'working');
      ledger.registerAgent({ id: 'minion-d3', role: 'minion', jobId: 'job-d3' });
      const center = new NotificationCenter({ ledger, bus });
      for (let i = 0; i < 35; i += 1) {
        center.post({
          kind: `receipt-${i}`,
          routing: 'action-required',
          severity: 'error',
          title: `receipt ${i}`,
          agentId: 'minion-d3',
        });
      }
      center.post({ kind: 'live-row', routing: 'action-required', severity: 'error', title: 'live row' });
      ledger.setJobStatus('job-d3', 'delivered');
      ledger.setJobStatus('job-d3', 'in-review');
      ledger.setJobStatus('job-d3', 'merged');
      const engine = new BoardEngine({ ledger, bus });
      const snapshot = engine.snapshot();
      expect(
        snapshot.notifications.filter((row) => row.agentId === 'minion-d3' && row.ackedAt === null),
      ).toHaveLength(30);
      expect(snapshot.notifications.some((row) => row.title === 'live row')).toBe(true);
      expect(engine.isClosedReceipt('minion-d3')).toBe(true);
      expect(engine.isClosedReceipt(null)).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
