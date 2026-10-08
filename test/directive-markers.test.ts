import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import {
  AmbiguousDirectiveError,
  DirectiveConflictError,
  LedgerApi,
  RecordNotFound,
} from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { loadConfig } from '../src/config.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { reconcilePendingDirectives } from '../src/dispatch/rebrief-recovery.js';
import type { DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import type { DispatchService } from '../src/dispatch/service.js';
import type { WaveRunner } from '../src/dispatch/perkins.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import type { Role } from '../src/config.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';

/**
 * Durable directive requests (phase 3 slice). Offline and deterministic:
 * a real LedgerDb on a temp dir, an in-memory bus, scripted reopens, and
 * the REAL dispatch HTTP service path (createDispatchServer) for the
 * accepted-vs-admitted contract. No providers, no live spawns, no owner
 * notices.
 *
 * Incidents reproduced:
 * - PR133 timeout window: an HTTP client retries while the original turn
 *   is in flight — same request id replays to the SAME durable row and the
 *   identical minion receives exactly ONE prompt (no second writer).
 * - Crash windows: intent without admission (admission UNKNOWN — never a
 *   silent retry), admitted without terminal receipt (no fabricated
 *   delivery), and record-keeping-only crashes (completed from correlated
 *   evidence).
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-directive-'));
  cleanupDirs.push(dir);
  return dir;
}

/** Drive one directive request to `settled` with real correlated events. */
function settleDirective(api: LedgerApi, jobId: string, requestId: string, minionId: string): void {
  api.beginDirectiveIntent({ jobId, directive: `settled ${requestId}`, holder: 'silas-ops', requestId });
  const sent = api.appendCustomEvent({
    kind: 'silas.directive-sent',
    jobId,
    payload: { request_id: requestId, minion_id: minionId },
  });
  api.recordDirectiveAdmission({ requestId, minionId, eventSeq: sent.seq });
  const delivered = api.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { request_id: requestId } });
  api.recordDirectiveDelivery({ requestId, eventSeq: delivered.seq });
}

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

describe('directive requests — durable ledger contract', () => {
  it('accepts an intent atomically (dispatching + claim) BEFORE any side effect; replay is the same row', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-d1', repo: 'r', title: 'Job D1' });
    api.setJobStatus('job-d1', 'working');
    const before = api.latestEventSeq();
    const intent = api.beginDirectiveIntent({
      jobId: 'job-d1',
      directive: 'fix the blocker',
      holder: 'silas-ops',
      requestId: 'req-d1',
    }).record;
    expect(intent.state).toBe('dispatching');
    expect(intent.claim?.holder).toBe('silas-ops');
    expect(intent.baselineSeq).toBe(before);
    const intentEvents = api.countEvents('silas.directive-intent');
    // A durable replay of the exact request is the SAME row — no new event.
    const replay = api.beginDirectiveIntent({
      jobId: 'job-d1',
      directive: 'fix the blocker',
      holder: 'silas-ops',
      requestId: 'req-d1',
    }).record;
    expect(replay.requestId).toBe('req-d1');
    expect(replay.payloadHash).toBe(intent.payloadHash);
    expect(api.countEvents('silas.directive-intent')).toBe(intentEvents);
    // Same id + different payload is a conflict, never a silent replacement.
    expect(() =>
      api.beginDirectiveIntent({ jobId: 'job-d1', directive: 'DIFFERENT work', holder: 'silas-ops', requestId: 'req-d1' }),
    ).toThrow(DirectiveConflictError);
    // Terminal lanes take no directives.
    api.addJob({ id: 'job-done', repo: 'r', title: 'Done' });
    api.setJobStatus('job-done', 'working');
    api.setJobStatus('job-done', 'done');
    expect(() =>
      api.beginDirectiveIntent({ jobId: 'job-done', directive: 'x', holder: 'silas-ops', requestId: 'req-nope' }),
    ).toThrow(/terminal lanes/u);
    // A binned (discarded) lane is terminal on the same contract.
    api.addJob({ id: 'job-binned', repo: 'r', title: 'Binned' });
    api.setJobStatus('job-binned', 'working');
    api.setJobStatus('job-binned', 'binned');
    expect(() =>
      api.beginDirectiveIntent({ jobId: 'job-binned', directive: 'x', holder: 'silas-ops', requestId: 'req-nope-2' }),
    ).toThrow(/terminal lanes/u);
  });

  it('fails CLOSED while a live request exists — identity-less AND a fresh different id (named)', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-d2', repo: 'r', title: 'Job D2' });
    api.setJobStatus('job-d2', 'working');
    const first = api.beginDirectiveIntent({ jobId: 'job-d2', directive: 'first', holder: 'silas-ops' }).record;
    expect(first.requestId).toBeTruthy(); // minted identity for a one-off caller
    // Identity-less repeat: refused.
    expect(() =>
      api.beginDirectiveIntent({ jobId: 'job-d2', directive: 'first', holder: 'silas-ops' }),
    ).toThrow(AmbiguousDirectiveError);
    // A FRESH, never-seen request id: also refused, naming the live request
    // — a new id must never start a second concurrent turn on the lane.
    expect(() =>
      api.beginDirectiveIntent({ jobId: 'job-d2', directive: 'fresh attempt', holder: 'silas-ops', requestId: 'req-fresh-1' }),
    ).toThrow(new RegExp(`${first.requestId}.*dispatching`, 'su'));
    // A replay of the LIVE id itself still proceeds (it is the same request).
    expect(
      api.beginDirectiveIntent({ jobId: 'job-d2', directive: 'first', holder: 'silas-ops', requestId: first.requestId }).created,
    ).toBe(false);
    // A DIFFERENT job is not ambiguous.
    api.addJob({ id: 'job-d2b', repo: 'r', title: 'Job D2b' });
    api.setJobStatus('job-d2b', 'working');
    expect(() => api.beginDirectiveIntent({ jobId: 'job-d2b', directive: 'other', holder: 'silas-ops' })).not.toThrow();
  });

  it('the live-request guard sees a live request sorting past a long settled history (B1)', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-d5', repo: 'r', title: 'Job D5' });
    api.setJobStatus('job-d5', 'working');
    // 200 terminal rows whose request_ids sort BEFORE the live request:
    // a request_id-ordered first page of 200 contains only history.
    for (let i = 0; i < 200; i += 1) {
      settleDirective(api, 'job-d5', `req-aaaa-${String(i).padStart(4, '0')}`, `minion-d5-${i}`);
    }
    const live = api.beginDirectiveIntent({ jobId: 'job-d5', directive: 'live work', holder: 'silas-ops', requestId: 'req-zzzz-live' }).record;
    expect(live.state).toBe('dispatching');
    // The live request is past the old page, but a repeat — identified or
    // not — must still fail closed: a second live request would mean a
    // second implementing turn.
    expect(() => api.beginDirectiveIntent({ jobId: 'job-d5', directive: 'repeat', holder: 'silas-ops' })).toThrow(
      AmbiguousDirectiveError,
    );
    expect(() =>
      api.beginDirectiveIntent({ jobId: 'job-d5', directive: 'repeat', holder: 'silas-ops', requestId: 'req-zzzz-fresh' }),
    ).toThrow(/req-zzzz-live/u);
  });

  it('admission binds only to a correlated REAL event; delivery requires admitted + correlated + post-admission', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-d3', repo: 'r', title: 'Job D3' });
    api.addJob({ id: 'job-d3x', repo: 'r', title: 'Job D3x' });
    api.setJobStatus('job-d3', 'working');
    api.beginDirectiveIntent({ jobId: 'job-d3', directive: 'run', holder: 'silas-ops', requestId: 'req-d3' });
    // Fabricated sequence.
    expect(() => api.recordDirectiveAdmission({ requestId: 'req-d3', minionId: 'm1', eventSeq: 987_654 })).toThrow(
      /does not exist/u,
    );
    // Wrong kind.
    const note = api.appendCustomEvent({ kind: 'job.note', jobId: 'job-d3', payload: { request_id: 'req-d3', minion_id: 'm1' } });
    expect(() => api.recordDirectiveAdmission({ requestId: 'req-d3', minionId: 'm1', eventSeq: note.seq })).toThrow(
      /must cite a silas.directive-sent/u,
    );
    // Wrong job.
    const foreign = api.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-d3x', payload: { request_id: 'req-d3', minion_id: 'm1' } });
    expect(() => api.recordDirectiveAdmission({ requestId: 'req-d3', minionId: 'm1', eventSeq: foreign.seq })).toThrow(
      /wrong job/u,
    );
    // Uncorrelated payload.
    const uncorrelated = api.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-d3', payload: { request_id: 'someone-else', minion_id: 'm1' } });
    expect(() => api.recordDirectiveAdmission({ requestId: 'req-d3', minionId: 'm1', eventSeq: uncorrelated.seq })).toThrow(
      /not correlated/u,
    );
    // Delivery before admission is refused — admitted evidence comes first.
    const early = api.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-d3', payload: { request_id: 'req-d3' } });
    expect(() => api.recordDirectiveDelivery({ requestId: 'req-d3', eventSeq: early.seq })).toThrow(/dispatching/u);
    // Valid correlated admission.
    const sent = api.appendCustomEvent({
      kind: 'silas.directive-sent',
      jobId: 'job-d3',
      payload: { request_id: 'req-d3', minion_id: 'm1' },
    });
    const admitted = api.recordDirectiveAdmission({ requestId: 'req-d3', minionId: 'm1', eventSeq: sent.seq });
    expect(admitted.state).toBe('admitted');
    expect(api.recordDirectiveAdmission({ requestId: 'req-d3', minionId: 'm1', eventSeq: sent.seq }).updatedAt).toBe(
      admitted.updatedAt,
    ); // idempotent replay
    // Delivery correlation is required and must postdate admission.
    const staleDelivery = api.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-d3', payload: { request_id: 'req-d3' } });
    expect(() => api.recordDirectiveDelivery({ requestId: 'req-d3', eventSeq: early.seq })).toThrow(/at\/before admission/u);
    const settled = api.recordDirectiveDelivery({ requestId: 'req-d3', eventSeq: staleDelivery.seq });
    expect(settled.state).toBe('settled');
    expect(settled.deliverySeq).toBe(staleDelivery.seq);
    // A settled request id NEVER re-runs: the replay reports the outcome.
    const replayed = api.beginDirectiveIntent({ jobId: 'job-d3', directive: 'run', holder: 'silas-ops', requestId: 'req-d3' }).record;
    expect(replayed.state).toBe('settled');
  });

  it('a durable failure is terminal for the request id and appends its evidence event', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-d4', repo: 'r', title: 'Job D4' });
    api.setJobStatus('job-d4', 'working');
    api.beginDirectiveIntent({ jobId: 'job-d4', directive: 'run', holder: 'silas-ops', requestId: 'req-d4' });
    const failed = api.failDirective({ requestId: 'req-d4', reason: 'no implementing minion session and no job lane' });
    expect(failed.state).toBe('failed');
    expect(failed.failReason).toContain('no implementing minion');
    expect(api.latestJobEvent('job-d4', 'silas.directive-failed')).not.toBeNull();
    expect(api.failDirective({ requestId: 'req-d4', reason: 'again' }).updatedAt).toBe(failed.updatedAt); // idempotent
    expect(() => api.getDirective('nope')).not.toThrow();
    expect(api.getDirective('nope')).toBeNull();
    expect(() => api.recordDirectiveReconcile({ requestId: 'nope', note: 'x' })).toThrow(RecordNotFound);
  });
});

describe('directive requests — boot reconciliation (crash windows, bounded, no retry)', () => {
  function boot(dir: string): { ledger: LedgerApi; notifications: NotificationCenter; bus: EventBus } {
    const db = new LedgerDb(dir);
    const bus = new EventBus({});
    const ledger = new LedgerApi(db.handle, { bus });
    const notifications = new NotificationCenter({ ledger, bus });
    return { ledger, notifications, bus };
  }

  it('completes a request from correlated evidence when only the bookkeeping was lost', () => {
    const dir = tmpDir();
    {
      const { ledger } = boot(dir);
      ledger.addJob({ id: 'job-r1', repo: 'r', title: 'Job R1' });
      ledger.setJobStatus('job-r1', 'working');
      ledger.beginDirectiveIntent({ jobId: 'job-r1', directive: 'run', holder: 'silas-ops', requestId: 'req-r1' });
      // The turn DID admit and deliver; the crash hit between the event
      // append and the request-record update.
      const sent = ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: 'job-r1',
        payload: { request_id: 'req-r1', minion_id: 'minion-r1' },
      });
      expect(sent.seq).toBeGreaterThan(0);
      ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-r1', payload: { request_id: 'req-r1', source: 'silas-directive' } });
    }
    const { ledger, notifications } = boot(dir); // restart
    const report = reconcilePendingDirectives({ ledger, notifications });
    expect(report).toMatchObject({ examined: 1, completed: 1, escalated: 0 });
    const row = ledger.getDirective('req-r1');
    expect(row?.state).toBe('settled');
    expect(row?.admissionSeq).not.toBeNull();
    expect(row?.deliverySeq).not.toBeNull();
  });

  it('escalates ADMISSION-UNKNOWN once (stable kind, no re-dispatch, no fabricated outcome) and counts attempts', () => {
    const dir = tmpDir();
    {
      const { ledger } = boot(dir);
      ledger.addJob({ id: 'job-r2', repo: 'r', title: 'Job R2' });
      ledger.setJobStatus('job-r2', 'working');
      ledger.beginDirectiveIntent({ jobId: 'job-r2', directive: 'run', holder: 'silas-ops', requestId: 'req-r2' });
      // No admission evidence exists: the prompt MAY have been delivered.
    }
    const { ledger, notifications } = boot(dir);
    const report = reconcilePendingDirectives({ ledger, notifications });
    expect(report).toMatchObject({ examined: 1, completed: 0, escalated: 1 });
    expect(ledger.getDirective('req-r2')?.state).toBe('dispatching'); // untouched
    expect(ledger.getDirective('req-r2')?.attempts).toBe(1);
    const card = ledger.findNotificationByKind('silas.directive-unreconciled.req-r2', 'unacked');
    expect(card).not.toBeNull();
    expect(card?.routing).toBe('action-required');
    expect(card?.detail).toContain('Do NOT re-dispatch');
    // A second boot pass escalates through the SAME card (dedupe holds) and
    // only advances the bounded attempt counter.
    const second = reconcilePendingDirectives({ ledger, notifications });
    expect(second.escalated).toBe(1);
    expect(ledger.getDirective('req-r2')?.attempts).toBe(2);
    const cards = ledger
      .listNotifications({ limit: 200 })
      .filter((notification) => notification.kind === 'silas.directive-unreconciled.req-r2');
    expect(cards).toHaveLength(1);
  });

  it('escalates an ADMITTED request without a terminal receipt — no fabricated job.delivered', () => {
    const dir = tmpDir();
    {
      const { ledger } = boot(dir);
      ledger.addJob({ id: 'job-r3', repo: 'r', title: 'Job R3' });
      ledger.setJobStatus('job-r3', 'working');
      ledger.beginDirectiveIntent({ jobId: 'job-r3', directive: 'run', holder: 'silas-ops', requestId: 'req-r3' });
      const sent = ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: 'job-r3',
        payload: { request_id: 'req-r3', minion_id: 'minion-r3' },
      });
      ledger.recordDirectiveAdmission({ requestId: 'req-r3', minionId: 'minion-r3', eventSeq: sent.seq });
    }
    const { ledger, notifications } = boot(dir);
    const report = reconcilePendingDirectives({ ledger, notifications });
    expect(report).toMatchObject({ examined: 1, completed: 0, escalated: 1 });
    expect(ledger.getDirective('req-r3')?.state).toBe('admitted'); // still in flight/unknown
    // No fabricated delivery event exists.
    expect(ledger.latestJobEvent('job-r3', 'job.delivered')).toBeNull();
    const card = ledger.findNotificationByKind('silas.directive-unreconciled.req-r3', 'unacked');
    expect(card).not.toBeNull();
    // Owner decision D2: the recorded admission worker binds the row so a
    // terminal lane classifies it as a closed receipt.
    expect(card?.agentId).toBe('minion-r3');
  });

  it('reconciles a live request sorting past a long settled history (B1)', () => {
    const dir = tmpDir();
    {
      const { ledger } = boot(dir);
      ledger.addJob({ id: 'job-b1r', repo: 'r', title: 'Job B1r' });
      ledger.setJobStatus('job-b1r', 'working');
      for (let i = 0; i < 200; i += 1) {
        settleDirective(ledger, 'job-b1r', `req-aaaa-${String(i).padStart(4, '0')}`, `minion-b1r-${i}`);
      }
      // Crash window: intent without admission, sorting past the old page.
      ledger.beginDirectiveIntent({ jobId: 'job-b1r', directive: 'crash window', holder: 'silas-ops', requestId: 'req-zzzz-live' });
    }
    const { ledger, notifications } = boot(dir);
    const report = reconcilePendingDirectives({ ledger, notifications });
    expect(report).toMatchObject({ examined: 1, completed: 0, escalated: 1 });
    expect(ledger.getDirective('req-zzzz-live')?.attempts).toBe(1);
    expect(ledger.findNotificationByKind('silas.directive-unreconciled.req-zzzz-live', 'unacked')).not.toBeNull();
  });

  it('boot reconciliation pages with the cursor past the first page of live rows (B1)', () => {
    const dir = tmpDir();
    {
      const { ledger } = boot(dir);
      // 201 live requests across 201 jobs (the single-writer guard forbids
      // many live requests on ONE lane; the pager must still walk the whole
      // live set by request_id cursor, never a fixed first page).
      for (let i = 0; i < 201; i += 1) {
        ledger.addJob({ id: `job-b1p-${String(i).padStart(4, '0')}`, repo: 'r', title: `Job B1p ${i}` });
        ledger.setJobStatus(`job-b1p-${String(i).padStart(4, '0')}`, 'working');
        ledger.beginDirectiveIntent({
          jobId: `job-b1p-${String(i).padStart(4, '0')}`,
          directive: `live ${i}`,
          holder: 'silas-ops',
          requestId: `req-live-${String(i).padStart(4, '0')}`,
        });
      }
    }
    const { ledger, notifications } = boot(dir);
    const report = reconcilePendingDirectives({ ledger, notifications });
    expect(report).toMatchObject({ examined: 201, completed: 0, escalated: 201 });
    expect(ledger.getDirective('req-live-0200')?.attempts).toBe(1);
    expect(ledger.findNotificationByKind('silas.directive-unreconciled.req-live-0200', 'unacked')).not.toBeNull();
  });

  it('escalates a just-recorded admission from post-recovery state, not the stale snapshot (W1)', () => {
    const dir = tmpDir();
    {
      const { ledger } = boot(dir);
      ledger.addJob({ id: 'job-w1', repo: 'r', title: 'Job W1' });
      ledger.setJobStatus('job-w1', 'working');
      ledger.beginDirectiveIntent({ jobId: 'job-w1', directive: 'run', holder: 'silas-ops', requestId: 'req-w1' });
      // Admission evidence exists; the terminal receipt does not. Boot
      // recovery records the admission from the event, so the card must
      // describe the request as ADMITTED — never as admission-unknown.
      ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: 'job-w1',
        payload: { request_id: 'req-w1', minion_id: 'minion-w1' },
      });
    }
    const { ledger, notifications } = boot(dir);
    const report = reconcilePendingDirectives({ ledger, notifications });
    expect(report).toMatchObject({ examined: 1, completed: 0, escalated: 1 });
    const row = ledger.getDirective('req-w1');
    expect(row?.state).toBe('admitted');
    expect(row?.admissionMinion).toBe('minion-w1');
    expect(row?.failReason).toContain('admitted without terminal receipt at boot');
    const card = ledger.findNotificationByKind('silas.directive-unreconciled.req-w1', 'unacked');
    expect(card?.detail).toContain('minion-w1');
    expect(card?.detail).not.toContain('no native admission evidence');
  });
});

describe('directive requests — the real service path (HTTP 202 + readback)', () => {
  class FakeMinions implements DirectiveRegistry {
    readonly prompts: { id: string; text: string }[] = [];
    gate: Promise<void> | null = null;
    private readonly handles = new Map<string, AgentHandle>();

    register(id: string): void {
      this.handles.set(id, this.handleFor(id));
    }

    getHandle(id: string): AgentHandle | null {
      return this.handles.get(id) ?? null;
    }

    async spawn(_role: Role, _options: SpawnOptions = {}): Promise<AgentHandle> {
      const id = `spawned-${this.handles.size + 1}`;
      this.register(id);
      return this.handles.get(id) as AgentHandle;
    }

    async disposeHandle(handle: AgentHandle): Promise<void> {
      this.handles.delete(handle.id);
    }

    private handleFor(id: string): AgentHandle {
      const gate = (): Promise<void> | null => this.gate;
      const prompts = this.prompts;
      return {
        role: 'minion',
        id,
        sessionFile: null,
        capabilities: FAKE_CAPABILITIES,
        async prompt(text: string): Promise<void> {
          prompts.push({ id, text });
          const pending = gate();
          if (pending !== null) await pending;
        },
        async steer(): Promise<void> {},
        async followUp(): Promise<void> {},
        subscribe(): () => void {
          return () => {};
        },
        health(): { state: 'idle'; lastActivity: null; sessionFile: null } {
          return { state: 'idle', lastActivity: null, sessionFile: null };
        },
        async dispose(): Promise<void> {},
      };
    }
  }

  const TOKEN = 'directive-test-token';

  async function bootServer(): Promise<{
    port: number;
    ledger: LedgerApi;
    registry: FakeMinions;
    close: () => Promise<void>;
  }> {
    const dir = tmpDir();
    writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
    const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
    const db = new LedgerDb(dir);
    const bus = new EventBus({});
    const ledger = new LedgerApi(db.handle, { bus });
    const notifications = new NotificationCenter({ ledger, bus });
    const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));
    const registry = new FakeMinions();
    ledger.addJob({ id: 'job-h1', repo: 'r', title: 'Job H1' });
    ledger.setJobStatus('job-h1', 'working');
    ledger.registerAgent({ id: 'minion-h1', role: 'minion', sessionFile: null, jobId: 'job-h1' });
    registry.register('minion-h1');
    // The directive route touches only the silas ops surface + ledger; the
    // dispatch/wave doubles are never reached on /api/silas/* paths.
    const server = createDispatchServer({
      pendingProducerBlockers: () => [],
      config: cfg,
      dispatch: null as unknown as DispatchService,
      wave: null as unknown as WaveRunner,
      ledger,
      silasOps: { registry, worktrees, notifications },
    });
    const http: HttpServer = createServer((req, res) => {
      if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
    const port = (http.address() as AddressInfo).port;
    return {
      port,
      ledger,
      registry,
      close: async () => {
        server.dispose();
        await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      },
    };
  }

  async function post(port: number, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${port}/api/silas/directive`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function get(port: number, requestId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${port}/api/silas/directives/${encodeURIComponent(requestId)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function until<T>(fn: () => T | null, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = fn();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error('timed out waiting for the durable state to settle');
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    }
  }

  it('202s on durable acceptance, readback separates accepted/admitted/settled, and a same-id retry never doubles the writer', async () => {
    const h = await bootServer();
    try {
      // Hold the minion turn open: the request is admitted-in-flight while
      // the "client" retries (the PR133 timeout window).
      let release!: () => void;
      h.registry.gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      const first = await post(h.port, { job_id: 'job-h1', directive: 'fix it', request_id: 'req-http-1' });
      expect(first.status).toBe(202);
      expect(first.body['request_id']).toBe('req-http-1');
      expect(first.body['state']).toBe('dispatching');
      // The client timed out and retries with the SAME id: replay, no new turn.
      const retry = await post(h.port, { job_id: 'job-h1', directive: 'fix it', request_id: 'req-http-1' });
      expect(retry.status).toBe(202);
      expect(retry.body['request_id']).toBe('req-http-1');
      expect(h.registry.prompts).toHaveLength(1);
      expect(h.registry.prompts[0]?.id).toBe('minion-h1');
      // Readback mid-flight: accepted, admission may already be recorded.
      const inflight = await get(h.port, 'req-http-1');
      expect(inflight.status).toBe(200);
      expect(['dispatching', 'admitted']).toContain(inflight.body['state']);
      release();
      const settled = await until(() => {
        const row = h.ledger.getDirective('req-http-1');
        return row !== null && row.state === 'settled' ? row : null;
      });
      expect(settled.admissionSeq).not.toBeNull();
      expect(settled.deliverySeq).not.toBeNull();
      expect(h.registry.prompts).toHaveLength(1); // one writer, one turn
      const readback = await get(h.port, 'req-http-1');
      expect(readback.body['state']).toBe('settled');
      // A consumed request id reports its outcome instead of re-running.
      const consumed = await post(h.port, { job_id: 'job-h1', directive: 'fix it', request_id: 'req-http-1' });
      expect(consumed.status).toBe(200);
      expect(consumed.body['state']).toBe('settled');
      expect(h.registry.prompts).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('fails CLOSED (409) for any repeat while a live request exists — identity-less or fresh id, live request named', async () => {
    const h = await bootServer();
    try {
      let release!: () => void;
      h.registry.gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      const first = await post(h.port, { job_id: 'job-h1', directive: 'audit' });
      expect(first.status).toBe(202);
      const firstId = first.body['request_id'] as string;
      expect(typeof firstId).toBe('string');
      const repeat = await post(h.port, { job_id: 'job-h1', directive: 'audit' });
      expect(repeat.status).toBe(409);
      expect(repeat.body['error']).toBe('ambiguous_repeat');
      // A fresh request id is equally refused, naming the live request: no
      // second concurrent turn on the lane, ever.
      const fresh = await post(h.port, { job_id: 'job-h1', directive: 'audit again', request_id: 'req-http-fresh' });
      expect(fresh.status).toBe(409);
      expect(fresh.body['error']).toBe('ambiguous_repeat');
      expect(String(fresh.body['detail'])).toContain(firstId);
      expect(h.registry.prompts).toHaveLength(1);
      release();
      await until(() => (h.ledger.getDirective(firstId)?.state === 'settled' ? true : null));
      // Once settled, a NEW directive for the job proceeds (fresh id).
      const afterSettled = await post(h.port, { job_id: 'job-h1', directive: 'next phase', request_id: 'req-http-next' });
      expect(afterSettled.status).toBe(202);
    } finally {
      await h.close();
    }
  });

  it('readback 404s unknown requests and requires auth', async () => {
    const h = await bootServer();
    try {
      const missing = await get(h.port, 'no-such-request');
      expect(missing.status).toBe(404);
      const unauth = await fetch(`http://127.0.0.1:${h.port}/api/silas/directives/no-such-request`);
      expect(unauth.status).toBe(401);
    } finally {
      await h.close();
    }
  });
});
