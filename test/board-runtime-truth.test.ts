import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { BoardEngine, type AgentRuntimeClass, type RuntimeOwnership } from '../src/board/engine.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { AgentEventEnvelope } from '../src/runtime/registry.js';
import type { AgentSupervisionView } from '../src/supervision/supervisor.js';
import type { Role } from '../src/config.js';

/**
 * Issue #171 — truthful agent status. The crew rail must distinguish
 * current service-owned agents from historical sessions (stale rows left
 * by an unclean stop/restart or a legacy import) and must not present a
 * working agent as settled-idle on a raw adapter state alone.
 *
 * These tests pin the ENGINE projections: the runtime ownership
 * classification, the supervision-corrected display status, and the
 * membership-first rail ordering. The classification is a pure read
 * over live ownership evidence — the same ledger + a fresh ownership
 * probe (i.e. a restarted service) must produce the same truth, which
 * is the idempotence/startup criterion.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-board-truth-'));
  cleanupDirs.push(dir);
  return dir;
}

function envelope(
  agentId: string,
  role: Role,
  event: AgentEventEnvelope['event'],
): AgentEventEnvelope {
  return { agentId, role, sessionFile: `/tmp/sessions/${role}/x.jsonl`, phase: 'event', event };
}

function supervisionView(
  agentId: string,
  overrides: Partial<AgentSupervisionView> = {},
): AgentSupervisionView {
  return {
    agentId,
    role: 'silas',
    slotId: null,
    state: 'watching',
    restarts: 0,
    breakerOpen: false,
    stopReason: null,
    stoppedAt: null,
    openTurn: false,
    openControl: false,
    openToolCalls: 0,
    lastEventAt: null,
    lastFileBytes: null,
    ...overrides,
  };
}

function owned(...ids: string[]): RuntimeOwnership {
  return { ownedAgentIds: new Set(ids) };
}

describe('board engine — runtime ownership classification (#171)', () => {
  let api: LedgerApi;
  let bus: EventBus;

  beforeAll(() => {
    const db = new LedgerDb(tmpDir());
    bus = new EventBus();
    api = new LedgerApi(db.handle, { bus });
  });

  it('a ledger-only row (previous run / legacy import) classifies historical when probes are wired', () => {
    // Stale rows exactly as observed: an old Silas frozen in `idle` and an
    // old minion frozen in `streaming` from a September run, plus a fresh
    // Silas the current runtime owns.
    api.registerAgent({ id: 'silas-sept', role: 'silas' });
    api.setAgentState('silas-sept', 'idle');
    api.registerAgent({ id: 'minion-sept', role: 'minion', label: 'lens:chunk' });
    api.setAgentState('minion-sept', 'streaming');
    api.registerAgent({ id: 'silas-now', role: 'silas' });
    api.setAgentState('silas-now', 'idle');

    const engine = new BoardEngine({ ledger: api, bus, runtimeOwnership: () => owned('silas-now') });
    const byId = new Map(engine.snapshot().agents.map((agent) => [agent.id, agent]));
    expect(byId.get('silas-sept')?.runtime).toBe<AgentRuntimeClass>('historical');
    expect(byId.get('minion-sept')?.runtime).toBe<AgentRuntimeClass>('historical');
    expect(byId.get('silas-now')?.runtime).toBe<AgentRuntimeClass>('current');
  });

  it('a supervision view (live adoption or hydrated durable stop) proves current ownership — never retired', () => {
    // A stopped lane waiting on the owner's ack and a restarting worker are
    // OWNED by the current runtime: supervision evidence outranks the
    // registry handle probe's absence (the handle is gone by design).
    api.registerAgent({ id: 'minion-stopped', role: 'minion' });
    api.registerAgent({ id: 'minion-restarting', role: 'minion' });
    const stopped = supervisionView('minion-stopped', {
      role: 'minion',
      state: 'stopped',
      breakerOpen: true,
      stopReason: 'crash loop',
    });
    const restarting = supervisionView('minion-restarting', {
      role: 'minion',
      state: 'restarting',
    });
    const engine = new BoardEngine({
      ledger: api,
      bus,
      supervisionFor: (agentId) =>
        agentId === 'minion-stopped' ? stopped : agentId === 'minion-restarting' ? restarting : null,
      runtimeOwnership: () => owned(), // registry sees no live handles
    });
    const byId = new Map(engine.snapshot().agents.map((agent) => [agent.id, agent]));
    expect(byId.get('minion-stopped')?.runtime).toBe<AgentRuntimeClass>('current');
    expect(byId.get('minion-restarting')?.runtime).toBe<AgentRuntimeClass>('current');
  });

  it('supervision-only wiring still proves non-membership (the adoption tap sees every spawn)', () => {
    api.registerAgent({ id: 'gru-legacy', role: 'gru' });
    api.setAgentState('gru-legacy', 'idle');
    const engine = new BoardEngine({
      ledger: api,
      bus,
      supervisionFor: () => null, // wired probe, agent never adopted
    });
    expect(engine.snapshot().agents.find((agent) => agent.id === 'gru-legacy')?.runtime).toBe<
      AgentRuntimeClass
    >('historical');
  });

  it('no ownership probe wired → unverified, never a guessed historical class', () => {
    api.registerAgent({ id: 'perkins-old', role: 'perkins' });
    api.setAgentState('perkins-old', 'idle');
    const engine = new BoardEngine({ ledger: api, bus });
    expect(engine.snapshot().agents.find((agent) => agent.id === 'perkins-old')?.runtime).toBe<
      AgentRuntimeClass
    >('unverified');
  });

  it('a wired probe answering null (temporarily unavailable) is missing evidence → unverified, never historical', () => {
    api.registerAgent({ id: 'bob-orphan', role: 'bob' });
    api.setAgentState('bob-orphan', 'idle');
    const engine = new BoardEngine({
      ledger: api,
      bus,
      runtimeOwnership: () => null, // wired, but cannot answer right now
    });
    expect(engine.snapshot().agents.find((agent) => agent.id === 'bob-orphan')?.runtime).toBe<
      AgentRuntimeClass
    >('unverified');
  });

  it('a fresh ownership probe over the same ledger (a restart) yields the identical classification — idempotent, no data edits', () => {
    // The ledger persists across a restart; the ownership sets do not.
    // Classification must be a pure read: same rows, same fresh probes →
    // same truth, with no fabricated completion events in the record.
    const eventsBefore = api
      .listEvents({ limit: 5000 })
      .filter((event) => event.agentId === 'silas-sept' && event.kind === 'agent.state').length;
    const first = new BoardEngine({ ledger: api, bus, runtimeOwnership: () => owned('silas-now') });
    const second = new BoardEngine({ ledger: api, bus, runtimeOwnership: () => owned('silas-now') });
    const classify = (engine: BoardEngine): string =>
      engine
        .snapshot()
        .agents.filter((agent) => ['silas-sept', 'silas-now'].includes(agent.id))
        .map((agent) => `${agent.id}:${agent.runtime}`)
        .sort()
        .join('|');
    expect(classify(second)).toBe(classify(first));
    expect(classify(first)).toBe('silas-now:current|silas-sept:historical');
    // No reconciliation wrote anything: the durable record is untouched.
    const eventsAfter = api
      .listEvents({ limit: 5000 })
      .filter((event) => event.agentId === 'silas-sept' && event.kind === 'agent.state').length;
    expect(eventsAfter).toBe(eventsBefore);
  });
});

describe('board engine — truthful display status (#171)', () => {
  let api: LedgerApi;
  let bus: EventBus;

  beforeAll(() => {
    const db = new LedgerDb(tmpDir());
    bus = new EventBus();
    api = new LedgerApi(db.handle, { bus });
  });

  it('a raw-idle agent with an open supervision turn presents streaming, not a settled idle turn', () => {
    // The observed defect: an open turn, fresh tool/event activity and a
    // growing session file while the raw adapter state says `idle`.
    api.registerAgent({ id: 'silas-open', role: 'silas' });
    api.setAgentState('silas-open', 'idle');
    const view = supervisionView('silas-open', {
      openTurn: true,
      openToolCalls: 1,
      lastEventAt: new Date().toISOString(),
    });
    const engine = new BoardEngine({
      ledger: api,
      bus,
      supervisionFor: (agentId) => (agentId === 'silas-open' ? view : null),
      runtimeOwnership: () => owned(),
    });
    const agent = engine.snapshot().agents.find((candidate) => candidate.id === 'silas-open');
    expect(agent?.state).toBe('idle'); // the raw record is preserved
    expect(agent?.status).toBe('streaming'); // the board's truthful chip
  });

  it('open control (compaction) and open tool calls also prove live work over a raw idle', () => {
    api.registerAgent({ id: 'gru-compacting', role: 'gru' });
    api.setAgentState('gru-compacting', 'idle');
    api.registerAgent({ id: 'minion-tool', role: 'minion' });
    api.setAgentState('minion-tool', 'idle');
    const engine = new BoardEngine({
      ledger: api,
      bus,
      supervisionFor: (agentId) =>
        agentId === 'gru-compacting'
          ? supervisionView('gru-compacting', { role: 'gru', openControl: true })
          : agentId === 'minion-tool'
            ? supervisionView('minion-tool', { role: 'minion', openToolCalls: 2 })
            : null,
      runtimeOwnership: () => owned(),
    });
    const byId = new Map(engine.snapshot().agents.map((agent) => [agent.id, agent]));
    expect(byId.get('gru-compacting')?.status).toBe('streaming');
    expect(byId.get('minion-tool')?.status).toBe('streaming');
  });

  it('a genuinely settled idle (no open work) stays idle; missing supervision never downgrades a raw streaming', () => {
    api.registerAgent({ id: 'gru-settled', role: 'gru' });
    api.setAgentState('gru-settled', 'idle');
    api.registerAgent({ id: 'silas-quiet', role: 'silas' });
    api.setAgentState('silas-quiet', 'streaming');
    const engine = new BoardEngine({
      ledger: api,
      bus,
      supervisionFor: (agentId) =>
        agentId === 'gru-settled' ? supervisionView('gru-settled', { role: 'gru' }) : null,
      runtimeOwnership: () => owned('gru-settled', 'silas-quiet'),
    });
    const byId = new Map(engine.snapshot().agents.map((agent) => [agent.id, agent]));
    expect(byId.get('gru-settled')?.status).toBe('idle');
    expect(byId.get('silas-quiet')?.status).toBe('streaming');
  });

  it('rail ordering is membership-first: a current idle outranks a historical streaming record', () => {
    // The observed mis-sort: stale `streaming` epochs floated above the
    // live crew. Membership is the primary key now.
    api.registerAgent({ id: 'stale-streamer', role: 'minion', label: 'blind:001' });
    api.setAgentState('stale-streamer', 'streaming');
    api.setAgentState('stale-streamer', 'streaming'); // fresh-ish lastActivity
    api.registerAgent({ id: 'current-idle', role: 'silas' });
    api.setAgentState('current-idle', 'idle');
    const engine = new BoardEngine({
      ledger: api,
      bus,
      runtimeOwnership: () => owned('current-idle'),
    });
    const ids = engine.snapshot().agents.map((agent) => agent.id);
    expect(ids.indexOf('current-idle')).toBeLessThan(ids.indexOf('stale-streamer'));
  });

  it('a derived streaming (raw idle + open turn) sorts with the live workers', () => {
    api.registerAgent({ id: 'silas-derived', role: 'silas' });
    api.setAgentState('silas-derived', 'idle');
    api.registerAgent({ id: 'stale-epoch', role: 'silas' });
    api.setAgentState('stale-epoch', 'streaming');
    const engine = new BoardEngine({
      ledger: api,
      bus,
      supervisionFor: (agentId) =>
        agentId === 'silas-derived'
          ? supervisionView('silas-derived', { openTurn: true })
          : null,
      runtimeOwnership: () => owned('silas-derived'),
    });
    const ids = engine.snapshot().agents.map((agent) => agent.id);
    expect(ids.indexOf('silas-derived')).toBeLessThan(ids.indexOf('stale-epoch'));
  });
});

describe('board engine — runtime event feed keeps classification surfaces fed (#171)', () => {
  it('a live spawned agent adopted by supervision turns current, and its disposal stays the record', () => {
    const db = new LedgerDb(tmpDir());
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    const engine = new BoardEngine({
      ledger: api,
      bus,
      supervisionFor: (agentId) =>
        agentId === 'silas-live' ? supervisionView('silas-live') : null,
      runtimeOwnership: () => owned('silas-live'),
    });
    engine.onRuntimeEvent({ agentId: 'silas-live', role: 'silas', sessionFile: null, phase: 'spawned' });
    engine.onRuntimeEvent(envelope('silas-live', 'silas', { type: 'state', state: 'idle' }));
    let agent = engine.snapshot().agents.find((candidate) => candidate.id === 'silas-live');
    expect(agent?.runtime).toBe<AgentRuntimeClass>('current');
    expect(agent?.state).toBe('idle');

    engine.onRuntimeEvent({ agentId: 'silas-live', role: 'silas', sessionFile: null, phase: 'disposed' });
    agent = engine.snapshot().agents.find((candidate) => candidate.id === 'silas-live');
    expect(agent?.state).toBe('disposed'); // the graveyard keeps the record
  });
});
