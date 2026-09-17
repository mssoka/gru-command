import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { BoardEngine, type BoardSnapshot } from '../src/board/engine.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { AgentEventEnvelope } from '../src/runtime/registry.js';
import type { Role } from '../src/config.js';

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
    engine = new BoardEngine({ ledger: api, bus });
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

  it('lens-chip lifecycle: pending → live on turn_start → done on outcome; 7 chips by default', () => {
    const job = api.addJob({ id: 'engine-job', repo: 'demo-repo', title: 'Lifecycle job' });
    api.setJobStatus(job.id, 'working');
    const round = api.addRound({ jobId: job.id, targetRef: 'sha-abc' });
    expect(round.lenses.length).toBe(7);
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
    expect(notifications.some((n) => n.severity === 'error' && (n.detail ?? '').includes('connection lost'))).toBe(true);
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
    expect(snapshot.notifications.some((n) => n.title.includes('blocked'))).toBe(true);
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
