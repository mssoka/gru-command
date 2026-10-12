import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { BoardEngine } from '../src/board/engine.js';
import { createBoardServer } from '../src/board/server.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { branchStatePayload } from '../src/dispatch/github-poll.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { TranscriptService } from '../src/transcripts/service.js';
import { loadConfig } from '../src/config.js';
import { DecisionRuntime } from '../src/decisions/runtime.js';
import { DREAM_FAILED_KIND, dreamFailureIncidents } from '../src/lessons/dream.js';
import { ROLE_DEFINITIONS } from '../src/roles.js';
import { bindSupervisorNotificationDisposition } from '../src/supervision/notification-disposition.js';
import { Supervisor, type SupervisorRegistry } from '../src/supervision/supervisor.js';
import type { AgentEventEnvelope } from '../src/runtime/registry.js';
import type { RepoOverviewView } from '../src/repos/overview.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-board-server-'));
  cleanupDirs.push(dir);
  return dir;
}

async function boot(
  token: string,
  overrides: Partial<{
    heartbeatMs: number;
    repoOverview: () => RepoOverviewView | null;
    onNotificationDisposition: (id: string, detail: string) => { readonly ok: boolean; readonly reason?: string } | void;
  }> = {},
): Promise<{
  port: number;
  api: LedgerApi;
  bus: EventBus;
  board: ReturnType<typeof createBoardServer>;
  engine: BoardEngine;
  notifications: NotificationCenter;
  close: () => Promise<void>;
}> {
  const dir = tmpDir();
  // The instance dir IS the config dir (GRU_COMMAND_HOME points at it).
  const { writeFileSync } = await import('node:fs');
  // An EMPTY token means NO [auth] table at all — the loader's default is
  // token: '' (the not-configured state); an explicit empty string would
  // fail config validation.
  writeFileSync(
    join(dir, 'config.toml'),
    token === ''
      ? '[server]\nhost = "127.0.0.1"\nport = 0\n'
      : `[auth]\ntoken = "${token}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`,
    'utf-8',
  );
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  const { repoOverview, ...serverOverrides } = overrides;
  const engine = new BoardEngine({
    ledger: api,
    bus,
    ...(repoOverview !== undefined ? { repoOverview } : {}),
  });
  const notifications = new NotificationCenter({ ledger: api, bus });
  const decisions = new DecisionRuntime(cfg.decisions, {
    instanceDir: cfg.instanceDir,
    env: { GRU_COMMAND_HOME: cfg.instanceDir },
    home: '/home/tester',
    watchConfig: false,
  });
  const board = createBoardServer({
    config: cfg,
    engine,
    ledger: api,
    transcripts: new TranscriptService(join(dir, 'sessions'), { ledger: api }),
    bus,
    notifications,
    decisionsStatus: () => decisions.status(),
    onDecisionsRecheck: () => decisions.recheck(),
    pushDebounceMs: 10,
    ...serverOverrides,
  });
  const http: HttpServer = createServer((req, res) => {
    if (board.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  board.attach(http);
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    api,
    bus,
    board,
    engine,
    notifications,
    async close() {
      decisions.dispose();
      await board.dispose();
      await new Promise<void>((resolveClose) => {
        http.closeAllConnections();
        http.close(() => resolveClose());
      });
      db.close();
    },
  };
}

class BoardClient {
  readonly frames: { type: string; message?: string; [key: string]: unknown }[] = [];
  readonly closed: Promise<number>;
  private readonly socket: WebSocket;

  constructor(port: number, path: string = '/board/ws') {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    this.closed = new Promise((resolveClose) => {
      this.socket.on('close', (code: number) => resolveClose(code));
      this.socket.on('error', () => resolveClose(-1));
    });
    this.socket.on('message', (data: RawData) => {
      this.frames.push(JSON.parse(String(data)) as { type: string; message?: string });
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolveOpen, rejectOpen) => {
      this.socket.once('open', () => resolveOpen());
      this.socket.once('error', rejectOpen);
    });
  }

  send(payload: unknown): void {
    this.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  async waitFor(pred: (frame: { type: string }) => boolean, label: string, timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      if (this.frames.some(pred)) return;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`waitFor(${label}) timed out; frames: ${JSON.stringify(this.frames)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): Promise<number> {
    this.socket.close();
    return this.closed;
  }

  terminate(): Promise<number> {
    this.socket.terminate();
    return this.closed;
  }
}

/** Capture the actual server peer to assert auth callback containment synchronously:
 * an escaped exception must fail an assertion, not strand ws's receiver teardown. */
async function openBoardPeer(client: BoardClient): Promise<WebSocket> {
  let peer: WebSocket | undefined;
  const emit = WebSocketServer.prototype.emit;
  const observer = vi.spyOn(WebSocketServer.prototype, 'emit').mockImplementation(function (this: WebSocketServer, event, ...args) {
    if (event === 'connection') peer = args[0] as WebSocket;
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  });
  try {
    await client.open();
    if (peer === undefined) throw new Error('board server peer was not connected');
    return peer;
  } finally { observer.mockRestore(); }
}

async function getJson(port: number, path: string, token: string | null): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

async function postJson(
  port: number,
  path: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('board server — HTTP API', () => {
  let harness: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    harness = await boot('board-test-token');
  });

  it('G24 authenticated disposition succeeds and GET reads back durable ownership without changing job authority', async () => {
    const isolated = await boot('disposition-token');
    try {
      isolated.api.addJob({ id: 'disposition-job', repo: 'r', title: 'waiting for owner' });
      isolated.api.setJobStatus('disposition-job', 'blocked');
      const initial = await getJson(isolated.port, '/api/mailbox', 'disposition-token');
      const item = (initial.body as { items: { id: string; basis: string }[] }).items[0]!;
      const decision = isolated.api.recordDecision({ subject: item.id, decision: 'hold', covers: ['blocked'], reason: 'owner must authorize continuation', by: 'owner' });
      const input = { basis: item.basis, state: 'waiting', owner: 'owner', detail: 'do not restart', dependency: 'owner authorization', recheckAt: new Date(Date.now() + 60_000).toISOString(), references: [{ kind: 'decision', id: decision.id }] };
      const notificationsBefore = isolated.api.listNotifications();
      const written = await postJson(isolated.port, `/api/mailbox/${encodeURIComponent(item.id)}/disposition`, 'disposition-token', input);
      expect(written.status).toBe(200);
      expect(written.body).toMatchObject({ id: item.id, basis: item.basis, state: 'waiting', owner: 'owner', disposition: input, receipt: null });
      const page = await getJson(isolated.port, '/api/mailbox', 'disposition-token');
      expect(page.status).toBe(200);
      expect((page.body as { items: unknown[] }).items).toEqual([written.body]);
      const board = await getJson(isolated.port, '/api/board', 'disposition-token');
      expect((board.body as { mailbox: { items: unknown[] } }).mailbox.items).toEqual([written.body]);
      expect(isolated.api.getJob('disposition-job')?.status).toBe('blocked');
      expect(isolated.api.listNotifications()).toEqual(notificationsBefore);
    } finally { await isolated.close(); }
  });

  it('G09 malformed source evidence returns observable unavailability from /api/board', () => assertSourceUnavailable('/api/board'));
  it('G09 malformed source evidence returns observable unavailability from /api/mailbox', () => assertSourceUnavailable('/api/mailbox'));
  it('F03 malformed object fields make /api/board unavailable rather than clear', () => assertSourceUnavailable('/api/board', { pr_url: null, pr_open: 'true', mergeable_state: null, sha: null }));
  it('F03 malformed object fields make /api/mailbox unavailable rather than clear', () => assertSourceUnavailable('/api/mailbox', { pr_url: null, pr_open: 'true', mergeable_state: null, sha: null }));
  async function assertSourceUnavailable(path: string, payload: unknown = []): Promise<void> {
    const isolated = await boot('malformed-token');
    try {
      isolated.api.addJob({ id: 'malformed-job', repo: 'r', title: 'malformed evidence' });
      isolated.api.appendCustomEvent({ kind: 'github.branch-state', jobId: 'malformed-job', payload });
      expect(() => isolated.engine.mailbox.snapshot()).toThrow(/malformed PR evidence/);
      expect((await getJson(isolated.port, path, null)).status).toBe(401);
      const result = await getJson(isolated.port, path, 'malformed-token');
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ error: 'board_unavailable', detail: expect.stringContaining('malformed PR evidence') });
      expect(result.body).not.toHaveProperty('mailbox');
      const write = await postJson(isolated.port, '/api/mailbox/job%3Amalformed-job/disposition', 'malformed-token', {});
      expect(write.status).toBe(503);
      expect(write.body).toMatchObject({ error: 'board_unavailable' });
      expect(isolated.api.getJob('malformed-job')?.status).toBe('dispatched');
    } finally { await isolated.close(); }
  }

  it('GH-305 mailbox HTTP shares board identities, pages durably, and fences stale/invalid writes behind auth', async () => {
    const isolated = await boot('mailbox-test-token');
    try {
      isolated.api.addJob({ id: 'mail-http', repo: 'r', title: 'mailbox HTTP' });
      isolated.api.setJobStatus('mail-http', 'blocked');
      expect((await getJson(isolated.port, '/api/mailbox', null)).status).toBe(401);
      const page = await getJson(isolated.port, '/api/mailbox?limit=1', 'mailbox-test-token');
      expect(page.status).toBe(200);
      const item = (page.body as { items: { id: string; basis: string }[] }).items[0]!;
      const board = await getJson(isolated.port, '/api/board', 'mailbox-test-token');
      expect((board.body as { mailbox: { items: unknown[] } }).mailbox.items).toEqual((page.body as { items: unknown[] }).items);
      expect((await getJson(isolated.port, '/api/mailbox?limit=0', 'mailbox-test-token')).status).toBe(400);
      const path = `/api/mailbox/${encodeURIComponent(item.id)}/disposition`;
      const input = { basis: 'stale', state: 'waiting', owner: 'owner', detail: 'needs owner ruling', references: [] };
      expect((await postJson(isolated.port, path, null, input)).status).toBe(401);
      expect((await postJson(isolated.port, path, 'mailbox-test-token', input)).status).toBe(409);
      expect((await postJson(isolated.port, path, 'mailbox-test-token', { ...input, basis: item.basis })).status).toBe(400);
      expect(isolated.api.getJob('mail-http')?.status).toBe('blocked');
    } finally { await isolated.close(); }
  });

  it('GET /api/board: 401 without token, 401 with a bad token, snapshot with a valid one', async () => {
    const anon = await getJson(harness.port, '/api/board', null);
    expect(anon.status).toBe(401);
    const bad = await getJson(harness.port, '/api/board', 'wrong-token');
    expect(bad.status).toBe(401);
    const ok = await getJson(harness.port, '/api/board', 'board-test-token');
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('repos');
    expect(ok.body).toHaveProperty('agents');
    expect(ok.body).toHaveProperty('notifications');
    expect(ok.body).toHaveProperty('decisions', expect.objectContaining({ status: 'disabled' }));
    // Managed repository overview rides the same authenticated snapshot
    // additively; unwired producers render null (the web hides the section).
    expect(ok.body).toHaveProperty('repoOverview', null);
  });

  it('GET /api/board carries the additive repoOverview projection when wired', async () => {
    const view: RepoOverviewView = {
      rows: [
        {
          key: 'alpha',
          displayName: 'alpha',
          linked: true,
          host: 'github.com',
          link: 'https://github.com/acme/alpha',
          linkReason: null,
          fullName: 'acme/alpha',
          openPrs: 2,
          openIssues: 3,
          run: {
            state: 'passed',
            status: 'completed',
            conclusion: 'success',
            workflow: 'CI',
            branch: 'main',
            runNumber: 4,
            url: 'https://github.com/acme/alpha/actions/runs/4',
            runCreatedAt: '2026-10-07T10:00:00.000Z',
            runStartedAt: '2026-10-07T10:00:00.000Z',
            runUpdatedAt: '2026-10-07T10:05:00.000Z',
          },
          freshness: 'fresh',
          checkedAt: '2026-10-07T10:06:00.000Z',
          lastAttemptAt: '2026-10-07T10:06:00.000Z',
          error: null,
        },
      ],
    };
    const wired = await boot('board-test-token', { repoOverview: () => view });
    try {
      const body = (await getJson(wired.port, '/api/board', 'board-test-token')).body as { repoOverview: unknown };
      expect(body.repoOverview).toEqual(view);
    } finally {
      await wired.close();
    }
  });

  it('machine disposition is authenticated, requires an action detail, and never resolves an owner stop', async () => {
    const { api, port } = harness;
    const machine = api.recordNotification({ id: 'machine-disposition', kind: 'test', routing: 'action-required', severity: 'error', title: 'Fix me' });
    const owner = api.recordNotification({ id: 'owner-disposition', kind: 'test', routing: 'needs-owner', severity: 'info', title: 'Ask owner' });
    const path = `/api/notifications/${machine.id}/disposition`;
    expect((await postJson(port, path, null, { detail: 'Fixed' })).status).toBe(401);
    expect((await postJson(port, path, 'wrong-token', { detail: 'Fixed' })).status).toBe(401);
    expect((await postJson(port, path, 'board-test-token', {})).status).toBe(400);
    expect((await postJson(port, path, 'board-test-token', { detail: '   ' })).status).toBe(400);
    // An UNDECIDED owner stop is refused with a typed 409 (a decided row
    // resolves through the same route after its follow-through).
    expect((await postJson(port, `/api/notifications/${owner.id}/disposition`, 'board-test-token', { detail: 'No' }))).toMatchObject({
      status: 409,
      body: { error: 'decision_refused', code: 'undecided' },
    });
    expect(api.getNotification(machine.id)?.resolvedAt).toBeNull();
    const resolved = await postJson(port, path, 'board-test-token', { detail: 'Opened repair lane' });
    expect(resolved).toMatchObject({ status: 200, body: { resolvedBy: 'gru', ackedAt: null } });
    expect(api.getNotification(machine.id)?.resolvedAt).not.toBeNull();
    expect(api.getNotification(owner.id)?.resolvedAt).toBeNull();
    expect((await postJson(port, path, 'board-test-token', { detail: 'duplicate' })).status).toBe(200);
    expect(api.listEventsAfter(0, { kinds: ['notification.resolved'] }).filter((e) => (e.payload as { id?: string }).id === machine.id)).toMatchObject([
      { payload: { id: machine.id, by: 'gru', detail: 'Opened repair lane' } },
    ]);
  });

  it('validates authenticated Gru owner escalation and places it only in FOR YOU', async () => {
    const { api, port } = harness;
    const path = '/api/notifications/needs-owner';
    for (const token of [null, 'wrong-token']) {
      expect((await postJson(port, path, token, { title: 'Owner call', detail: 'Approve external merge' })).status).toBe(401);
    }
    for (const body of [{}, { title: '  ', detail: 'x' }, { title: 'x', detail: '\n' }, { title: 'x'.repeat(501), detail: 'y' }, { title: 'Owner call', detail: 'Approve external merge' }]) {
      expect((await postJson(port, path, 'board-test-token', body)).status).toBe(400);
    }
    const before = api.countPendingActionRequiredIncludingReceipts();
    const decision = {
      question: 'Approve the external merge?',
      context: 'PR256 needs an owner-controlled integration route.',
      recommendation: 'Approve it.',
      reservedClass: 'merge',
      whyNotDelegable: 'All merges remain owner-performed.',
      options: [
        { id: 'approve', label: 'Approve', consequence: 'Gru prepares the merge.' },
        { id: 'keep', label: 'Keep it parked', consequence: 'Nothing changes.' },
      ],
      discussion: false,
    };
    const created = await postJson(port, path, 'board-test-token', { title: 'Owner call', detail: 'Approve external merge', decision });
    expect(created).toMatchObject({
      status: 201,
      body: {
        kind: 'gru.owner-escalation',
        routing: 'needs-owner',
        title: 'Owner call',
        ackedAt: null,
        decidedAt: null,
        decision: { question: 'Approve the external merge?', reservedClass: 'merge' },
      },
    });
    expect(api.countPendingActionRequiredIncludingReceipts()).toBe(before); // never loops into Gru's machine queue
    const row = created.body as { id: string };
    expect(api.getNotification(row.id)).toMatchObject({ detail: 'Approve external merge', shownAt: null });
    expect((await getJson(port, '/api/board', 'board-test-token')).body).toMatchObject({ unackedNeedsOwner: expect.any(Number) });
    // Decision submission carries the displayed decision snapshot so a
    // reused option id cannot silently bind an old label to new meaning.
    // Recording remains idempotent and never resolves the row — a decision
    // receipt is not follow-through.
    const missingDisplayedDecision = await postJson(port, `/api/notifications/${row.id}/decision`, 'board-test-token', { optionId: 'approve', by: 'web' });
    expect(missingDisplayedDecision).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    const decided = await postJson(port, `/api/notifications/${row.id}/decision`, 'board-test-token', {
      optionId: 'approve', by: 'web', expectedDecision: decision,
    });
    expect(decided).toMatchObject({ status: 200, body: { decidedOption: 'approve', decidedBy: 'web', resolvedAt: null, ackedAt: null } });
    expect((decided.body as { decidedAt: string | null }).decidedAt).not.toBeNull();
    const replay = await postJson(port, `/api/notifications/${row.id}/decision`, 'board-test-token', {
      optionId: 'approve', expectedDecision: decision,
    });
    expect(replay.status).toBe(200); // idempotent replay
    const changed = await postJson(port, `/api/notifications/${row.id}/decision`, 'board-test-token', {
      optionId: 'keep', expectedDecision: decision,
    });
    expect(changed).toMatchObject({ status: 409, body: { error: 'decision_refused', code: 'decision_recorded' } });
    const unknownOption = await postJson(port, `/api/notifications/${row.id}/decision`, 'board-test-token', {
      optionId: 'nope', expectedDecision: decision,
    });
    expect(unknownOption).toMatchObject({ status: 400, body: { error: 'decision_refused', code: 'unknown_option' } });
    const notOwner = await postJson(port, '/api/notifications/does-not-exist/decision', 'board-test-token', {
      optionId: 'approve', expectedDecision: decision,
    });
    expect(notOwner.status).toBe(404);
    const decisionEvents = api
      .listEvents({ limit: 100 })
      .filter((event) => event.kind === 'notification.decision' && (event.payload as { id?: string }).id === row.id);
    expect(decisionEvents).toHaveLength(1);
    // The snapshot projection carries the typed decision and its recorded
    // state to BOTH owner surfaces (the only server→web transport).
    const board = (await getJson(port, '/api/board', 'board-test-token')).body as {
      notifications: { id: string; decision?: { question?: string } | null; decidedAt?: string | null; decidedOption?: string | null }[];
    };
    const projected = board.notifications.find((entry) => entry.id === row.id);
    expect(projected?.decision).toMatchObject({ question: 'Approve the external merge?' });
    expect(projected?.decidedAt).toBeTruthy();
    expect(projected?.decidedOption).toBe('approve');
    // An ack can never erase a typed owner question.
    const ackRefused = await postJson(port, `/api/notifications/${row.id}/ack`, 'board-test-token', { by: 'web' });
    expect(ackRefused).toMatchObject({ status: 409, body: { error: 'decision_required' } });
    // Follow-through resolution: a DECIDED row resolves with the action
    // detail; an UNDECIDED owner row refuses (resolution never silences an
    // unanswered question).
    const undecided = await postJson(port, path, 'board-test-token', { title: 'Second call', detail: 'evidence', decision });
    const undecidedId = (undecided.body as { id: string }).id;
    const refusedResolve = await postJson(port, `/api/notifications/${undecidedId}/disposition`, 'board-test-token', { detail: 'premature' });
    expect(refusedResolve).toMatchObject({ status: 409, body: { error: 'decision_refused', code: 'undecided' } });
    const resolved = await postJson(port, `/api/notifications/${row.id}/disposition`, 'board-test-token', { detail: 'Executed the approved prep' });
    expect(resolved).toMatchObject({ status: 200, body: { resolvedBy: 'gru', decidedOption: 'approve', ackedAt: null } });
    expect(api.getNotification(row.id)).toMatchObject({ resolvedBy: 'gru' });
  });

  it('decision status and recheck are authenticated and return the durable disabled state', async () => {
    expect((await getJson(harness.port, '/api/decisions/status', null)).status).toBe(401);
    expect((await postJson(harness.port, '/api/decisions/recheck', null, {})).status).toBe(401);
    expect((await postJson(harness.port, '/api/decisions/recheck', 'wrong-token', {})).status).toBe(401);
    const status = await getJson(harness.port, '/api/decisions/status', 'board-test-token');
    expect(status).toEqual({
      status: 200,
      body: expect.objectContaining({ enabled: false, status: 'disabled', credentialPresent: false }),
    });
    const recheck = await postJson(harness.port, '/api/decisions/recheck', 'board-test-token', {});
    expect(recheck).toEqual({
      status: 200,
      body: expect.objectContaining({ enabled: false, status: 'disabled', reason: 'disabled' }),
    });
  });

  it('the write API creates jobs/rounds/agents and validates status transitions', async () => {
    const created = await postJson(harness.port, '/api/jobs', 'board-test-token', {
      id: 'api-job',
      repo: 'demo-repo',
      title: 'API-created job',
    });
    expect(created.status).toBe(201);
    const round = await postJson(harness.port, '/api/rounds', 'board-test-token', {
      jobId: 'api-job',
    });
    expect(round.status).toBe(201);
    expect((round.body as { lenses: { lens: string }[] }).lenses.length).toBe(9);
    const illegal = await postJson(harness.port, '/api/jobs/api-job/status', 'board-test-token', {
      status: 'merged',
    });
    expect(illegal.status).toBe(400); // dispatched → merged is illegal
    const legal = await postJson(harness.port, '/api/jobs/api-job/status', 'board-test-token', {
      status: 'working',
    });
    expect(legal.status).toBe(200);
    expect((legal.body as { status: string }).status).toBe('working');
    const snapshot = (await getJson(harness.port, '/api/board', 'board-test-token')).body as {
      repos: { name: string; jobs: { id: string }[] }[];
    };
    expect(snapshot.repos.find((r) => r.name === 'demo-repo')?.jobs.some((j) => j.id === 'api-job')).toBe(true);
  });

  it('a binned discard is audited end-to-end; auth/malformed/illegal attempts never mutate', async () => {
    const { api, port } = harness;
    api.addJob({ id: 'audit-binned', repo: 'demo-repo', title: 'Audit the discard' });
    const eventsBefore = api.listJobEvents('audit-binned').length;
    // A caller-provided `by` is NOT authentication.
    const unauth = await postJson(port, '/api/jobs/audit-binned/status', null, { status: 'binned', by: 'gru' });
    expect(unauth.status).toBe(401);
    expect(api.getJob('audit-binned')?.status).toBe('dispatched');
    expect(api.listJobEvents('audit-binned').length).toBe(eventsBefore);

    const malformed = await postJson(port, '/api/jobs/audit-binned/status', 'board-test-token', { status: 'discarded' });
    expect(malformed.status).toBe(400);
    expect(api.getJob('audit-binned')?.status).toBe('dispatched');
    expect(api.listJobEvents('audit-binned').length).toBe(eventsBefore);

    const legal = await postJson(port, '/api/jobs/audit-binned/status', 'board-test-token', { status: 'binned' });
    expect(legal.status).toBe(200);
    expect((legal.body as { status: string }).status).toBe('binned');
    // The ordinary audit event preserves the truthful prior status.
    expect(api.latestJobEvent('audit-binned', 'job.status')?.payload).toEqual({ from: 'dispatched', to: 'binned' });
    // A repeated identical write is an idempotent 200 no-op (no event).
    const rebinEvents = api.listJobEvents('audit-binned').length;
    const rebin = await postJson(port, '/api/jobs/audit-binned/status', 'board-test-token', { status: 'binned' });
    expect(rebin.status).toBe(200);
    expect(api.listJobEvents('audit-binned').length).toBe(rebinEvents);

    // Terminal: no resumption, and a closed merged lane refuses binning.
    const resume = await postJson(port, '/api/jobs/audit-binned/status', 'board-test-token', { status: 'working' });
    expect(resume.status).toBe(400);
    expect((resume.body as { detail: string }).detail).toMatch(/illegal transition binned → working/u);
    expect(api.getJob('audit-binned')?.status).toBe('binned');
    api.addJob({ id: 'audit-merged', repo: 'demo-repo', title: 'Already merged' });
    api.setJobStatus('audit-merged', 'working');
    api.setJobStatus('audit-merged', 'in-review');
    api.setJobStatus('audit-merged', 'merged');
    const refuse = await postJson(port, '/api/jobs/audit-merged/status', 'board-test-token', { status: 'binned' });
    expect(refuse.status).toBe(400);
    expect((refuse.body as { detail: string }).detail).toMatch(/illegal transition merged → binned/u);
    expect(api.getJob('audit-merged')?.status).toBe('merged');

    // The board snapshot carries the discarded lane as a closed receipt.
    const snapshot = (await getJson(port, '/api/board', 'board-test-token')).body as {
      repos: { name: string; jobs: { id: string; status: string; prState: string | null }[] }[];
    };
    const row = snapshot.repos.flatMap((repo) => repo.jobs).find((job) => job.id === 'audit-binned');
    expect(row?.status).toBe('binned');
    expect(row?.prState).toBeNull();
  });

  it('Gru loaded action bins a named abandoned heist through auth with truthful history and no revival', async () => {
    const { api, port } = harness;
    const prompt = ROLE_DEFINITIONS.gru.systemPrompt;
    expect(ROLE_DEFINITIONS.gru.tools).toContain('bash');
    // This test reads the actual shipped Gru prompt, extracts its action,
    // then executes that path against the real HTTP write surface (never a
    // live instance). A status enum or operator-only manual cannot pass.
    const action = prompt.match(/authenticated `POST (\/api\/jobs\/<job-id>\/status)` with JSON `(\{ "status": "binned" \})`/u);
    expect(action, 'Gru must be taught the precise authenticated discard action').not.toBeNull();
    if (action === null) return;
    expect(prompt).toContain('Do not automatically bin');
    expect(prompt).toContain('live worker');
    const jobId = 'gru-bin-heist';
    const path = action[1]!.replace('<job-id>', jobId);
    const body = JSON.parse(action[2]!) as { status: string };
    const liveId = 'gru-bin-live';
    const livePath = action[1]!.replace('<job-id>', liveId);
    api.addJob({ id: liveId, repo: 'demo-repo', title: 'Still running' });
    api.setJobStatus(liveId, 'working');
    api.registerAgent({ id: 'live-gru-worker', role: 'minion', jobId: liveId });
    api.setAgentState('live-gru-worker', 'streaming');
    const liveBefore = api.listJobEvents(liveId);
    const refused = await postJson(port, livePath, 'board-test-token', body);
    expect(refused.status).toBe(400);
    expect((refused.body as { detail: string }).detail).toMatch(/live work|open worker/u);
    expect(api.getJob(liveId)?.status).toBe('working');
    expect(api.listJobEvents(liveId)).toEqual(liveBefore);
    api.setAgentState('live-gru-worker', 'idle');
    expect((await postJson(port, livePath, 'board-test-token', body)).status).toBe(200);

    api.addJob({ id: jobId, repo: 'demo-repo', title: 'Discarded by Gru' });
    api.setJobStatus(jobId, 'working');
    api.setJobStatus(jobId, 'blocked');
    const before = api.listJobEvents(jobId);
    expect(api.listObligations({ jobId }).some((row) => row.state === 'open')).toBe(true);
    expect((await postJson(port, path, null, body)).status).toBe(401);
    expect(api.listJobEvents(jobId)).toEqual(before);
    const accepted = await postJson(port, path, 'board-test-token', body);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ id: jobId, status: 'binned' });
    const after = api.listJobEvents(jobId);
    expect(after.slice(-before.length)).toEqual(before);
    expect(after.filter((event) => event.kind === 'job.status' &&
      (event.payload as { to?: string }).to === 'binned'))
      .toHaveLength(1);
    expect(api.latestJobEvent(jobId, 'job.status')?.payload).toEqual({ from: 'blocked', to: 'binned' });
    expect(api.listObligations({ jobId }).every((row) => row.state === 'closed')).toBe(true);
    expect(api.listObligations({ jobId }).some((row) =>
      row.settlement?.kind === 'job-terminal' && row.settlement.jobStatus === 'binned')).toBe(true);
    expect((await postJson(port, path, 'board-test-token', { status: 'working' })).status).toBe(400);
    expect(api.getJob(jobId)?.status).toBe('binned');
    expect(api.listJobEvents(jobId)).toEqual(after);
  });

  it('Gru bin refuses pending review and unsettled verification with no partial status or debt mutation', async () => {
    const { api, port } = harness;
    for (const [id, kind] of [
      ['gru-bin-round', 'round'],
      ['gru-bin-verify', 'verification'],
    ] as const) {
      api.addJob({ id, repo: 'demo-repo', title: 'Active producer' });
      api.setJobStatus(id, 'working');
      api.setJobStatus(id, 'blocked');
      if (kind === 'round') api.addRound({ jobId: id });
      else api.appendCustomEvent({ kind: 'verification.started', jobId: id, payload: { run_id: 'ongoing' } });
      const beforeEvents = api.listJobEvents(id);
      const beforeDebts = api.listObligations({ jobId: id });
      const refusal = await postJson(port, `/api/jobs/${id}/status`, 'board-test-token', { status: 'binned' });
      expect(refusal.status, kind).toBe(400);
      expect((refusal.body as { detail: string }).detail, kind)
        .toMatch(kind === 'round' ? /live review round/u : /unsettled verification/u);
      expect(api.getJob(id)?.status).toBe('blocked');
      expect(api.listJobEvents(id)).toEqual(beforeEvents);
      expect(api.listObligations({ jobId: id })).toEqual(beforeDebts);
    }
  });

  it('closeout endpoint: auth, malformed bodies, missing jobs and guard refusals fail loud without changes', async () => {
    const { api, port } = harness;
    const head = '3c44e87e2e9e64cbc3301d7806540df6273438e6';
    const prUrl = 'https://github.com/acme/gru-command/pull/165';
    const validBody = {
      expected_status: 'parked',
      expected_pr_url: prUrl,
      provider: { provider: 'github', state: 'closed', merged: false, head_sha: head, closed_at: '2026-10-05T05:06:52Z' },
      reason: 'owner-authorized administrative closeout (j-1115)',
    };
    expect((await postJson(port, '/api/jobs/x/closeout', null, validBody)).status).toBe(401);
    expect((await postJson(port, '/api/jobs/x/closeout', 'wrong-token', validBody)).status).toBe(401);
    for (const body of [
      {},
      { ...validBody, expected_status: 'working' },
      { ...validBody, provider: { ...validBody.provider, state: 'open' } },
      { ...validBody, provider: { ...validBody.provider, merged: true } },
      { ...validBody, provider: { ...validBody.provider, head_sha: 'nope' } },
      { ...validBody, provider: { ...validBody.provider, closed_at: 'not-a-time' } },
      { ...validBody, provider: { ...validBody.provider, closed_at: '' } },
      { ...validBody, expected_pr_url: '' },
      { ...validBody, expected_pr_url: 'not-a-url' },
      { ...validBody, reason: '' },
    ]) {
      const bad = await postJson(port, '/api/jobs/x/closeout', 'board-test-token', body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
    }
    // A literal JSON null body is a named 400, never a raw TypeError detail.
    const nullBody = await postJson(port, '/api/jobs/x/closeout', 'board-test-token', null);
    expect(nullBody.status).toBe(400);
    expect((nullBody.body as { detail: string }).detail).toContain('JSON object');
    expect((await postJson(port, '/api/jobs/ghost/closeout', 'board-test-token', validBody)).status).toBe(404);

    // A parked lane whose recorded provider observation is still OPEN is
    // refused with the typed code — and nothing changes.
    api.addJob({ id: 'open-pr-http', repo: 'demo-repo', title: 'Open PR' });
    api.setJobStatus('open-pr-http', 'working');
    api.setJobPr('open-pr-http', prUrl);
    api.setJobStatus('open-pr-http', 'in-review');
    api.setJobStatus('open-pr-http', 'parked');
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: 'open-pr-http',
      payload: branchStatePayload(
        { jobId: 'open-pr-http', repo: { host: 'github.com', owner: 'acme', repo: 'gru-command' }, branch: 'gru/open-pr-http', prNumber: 165, prUrl },
        { sha: head, merged: false, prOpen: true, mergeableState: 'dirty', ci: null, prNumber: 165, prUrl, mergeCommitSha: null },
      ),
    });
    const refused = await postJson(port, '/api/jobs/open-pr-http/closeout', 'board-test-token', validBody);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'closeout_refused', code: 'pr-open' });
    expect(api.getJob('open-pr-http')?.status).toBe('parked');
    expect(api.latestJobEvent('open-pr-http', 'job.admin-closeout')).toBeNull();

    // Target-identity refusals ride the same typed 409 mapping: the request
    // names a different PR than the registered / recorded target.
    api.addJob({ id: 'target-http', repo: 'demo-repo', title: 'Target' });
    api.setJobStatus('target-http', 'working');
    api.setJobPr('target-http', prUrl);
    api.setJobStatus('target-http', 'in-review');
    api.setJobStatus('target-http', 'parked');
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: 'target-http',
      payload: branchStatePayload(
        { jobId: 'target-http', repo: { host: 'github.com', owner: 'acme', repo: 'gru-command' }, branch: 'gru/target-http', prNumber: 165, prUrl },
        { sha: head, merged: false, prOpen: false, mergeableState: 'dirty', ci: null, prNumber: 165, prUrl, mergeCommitSha: null },
      ),
    });
    const mismatch = await postJson(port, '/api/jobs/target-http/closeout', 'board-test-token', {
      ...validBody,
      expected_pr_url: 'https://github.com/acme/gru-command/pull/999',
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ error: 'closeout_refused', code: 'target-mismatch' });
    expect(api.getJob('target-http')?.status).toBe('parked');

    // A refusal message that happens to contain the transcript sentinel
    // still maps to the typed 409, never the transcript 404.
    const sentinel = await postJson(port, '/api/jobs/target-http/closeout', 'board-test-token', {
      ...validBody,
      expected_pr_url: 'https://github.com/acme/gru-command/transcript unreadable/pull/165',
    });
    expect(sentinel.status).toBe(409);
    expect(sentinel.body).toMatchObject({ error: 'closeout_refused', code: 'target-mismatch' });

    // Live work rides the same typed 409 mapping.
    api.addJob({ id: 'live-http', repo: 'demo-repo', title: 'Live' });
    api.setJobStatus('live-http', 'working');
    api.setJobPr('live-http', prUrl);
    api.setJobStatus('live-http', 'in-review');
    api.setJobStatus('live-http', 'parked');
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: 'live-http',
      payload: branchStatePayload(
        { jobId: 'live-http', repo: { host: 'github.com', owner: 'acme', repo: 'gru-command' }, branch: 'gru/live-http', prNumber: 165, prUrl },
        { sha: head, merged: false, prOpen: false, mergeableState: 'dirty', ci: null, prNumber: 165, prUrl, mergeCommitSha: null },
      ),
    });
    api.registerAgent({ id: 'live-http-worker', role: 'minion', jobId: 'live-http' });
    api.setAgentState('live-http-worker', 'streaming');
    const liveRefused = await postJson(port, '/api/jobs/live-http/closeout', 'board-test-token', validBody);
    expect(liveRefused.status).toBe(409);
    expect(liveRefused.body).toMatchObject({ error: 'closeout_refused', code: 'live-work' });
  });

  it('closeout endpoint: the guarded success is audited, idempotent, and the board stops presenting the lane as an open PR', async () => {
    const { api, port } = harness;
    const jobId = 'closeout-http';
    const head = '3c44e87e2e9e64cbc3301d7806540df6273438e6';
    const prUrl = 'https://github.com/acme/gru-command/pull/178';
    api.addJob({ id: jobId, repo: 'demo-repo', title: 'Closeout HTTP' });
    api.setJobStatus(jobId, 'working');
    api.setJobPr(jobId, prUrl);
    api.setJobStatus(jobId, 'in-review');
    api.setJobStatus(jobId, 'parked');
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId,
      payload: branchStatePayload(
        { jobId, repo: { host: 'github.com', owner: 'acme', repo: 'gru-command' }, branch: `gru/${jobId}`, prNumber: 178, prUrl },
        { sha: head, merged: false, prOpen: false, mergeableState: 'dirty', ci: null, prNumber: 178, prUrl, mergeCommitSha: null },
      ),
    });
    const body = {
      expected_status: 'parked',
      expected_pr_url: prUrl,
      provider: { provider: 'github', state: 'closed', merged: false, head_sha: head, closed_at: '2026-10-05T05:06:52Z' },
      reason: 'owner-authorized administrative closeout (j-1115)',
    };
    // The previous refusal is preserved at the HTTP boundary.
    const illegal = await postJson(port, `/api/jobs/${jobId}/status`, 'board-test-token', { status: 'done' });
    expect(illegal.status).toBe(400);
    expect((illegal.body as { detail: string }).detail).toContain('illegal transition parked → done');

    const accepted = await postJson(port, `/api/jobs/${jobId}/closeout`, 'board-test-token', body);
    expect(accepted.status).toBe(200);
    const acceptedBody = accepted.body as { job: { status: string }; event: { kind: string; seq: number }; idempotent: boolean };
    expect(acceptedBody.job.status).toBe('done');
    expect(acceptedBody.event.kind).toBe('job.admin-closeout');
    expect(acceptedBody.idempotent).toBe(false);

    const replay = await postJson(port, `/api/jobs/${jobId}/closeout`, 'board-test-token', body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotent: true, event: { seq: acceptedBody.event.seq }, job: { status: 'done' } });
    expect(api.listJobEventsByKinds(jobId, ['job.admin-closeout'])).toHaveLength(1);

    // A changed request against the closed lane is the typed 409.
    const changed = await postJson(port, `/api/jobs/${jobId}/closeout`, 'board-test-token', { ...body, reason: 'a different request' });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ error: 'closeout_refused', code: 'already-closed' });
    expect(api.listJobEventsByKinds(jobId, ['job.admin-closeout'])).toHaveLength(1);

    const snapshot = (await getJson(port, '/api/board', 'board-test-token')).body as {
      repos: { jobs: { id: string; status: string; prUrl: string | null; prState: string | null }[] }[];
    };
    const job = snapshot.repos.flatMap((repo) => repo.jobs).find((candidate) => candidate.id === jobId);
    expect(job).toMatchObject({ status: 'done', prUrl, prState: null });

    // An omitted closed_at is a valid closeout: the audit records null.
    const noClosedAt = 'closeout-http-no-closed-at';
    api.addJob({ id: noClosedAt, repo: 'demo-repo', title: 'Closeout without closed_at' });
    api.setJobStatus(noClosedAt, 'working');
    api.setJobPr(noClosedAt, prUrl);
    api.setJobStatus(noClosedAt, 'in-review');
    api.setJobStatus(noClosedAt, 'parked');
    api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: noClosedAt,
      payload: branchStatePayload(
        { jobId: noClosedAt, repo: { host: 'github.com', owner: 'acme', repo: 'gru-command' }, branch: `gru/${noClosedAt}`, prNumber: 178, prUrl },
        { sha: head, merged: false, prOpen: false, mergeableState: 'dirty', ci: null, prNumber: 178, prUrl, mergeCommitSha: null },
      ),
    });
    const { closed_at: _omitted, ...providerWithoutClosedAt } = body.provider;
    const noClosed = await postJson(port, `/api/jobs/${noClosedAt}/closeout`, 'board-test-token', { ...body, provider: providerWithoutClosedAt });
    expect(noClosed.status).toBe(200);
    expect(
      (noClosed.body as { event: { payload: { provider: { closed_at: unknown } } } }).event.payload.provider.closed_at,
    ).toBeNull();
  });

  it('authenticated round creation refuses binned jobs without creating an event', async () => {
    const jobId = 'binned-round-http';
    harness.api.addJob({ id: jobId, repo: 'demo-repo', title: 'Discarded review' });
    harness.api.setJobStatus(jobId, 'binned');
    const before = harness.api.listJobEvents(jobId);
    const refused = await postJson(harness.port, '/api/rounds', 'board-test-token', { jobId });
    expect(refused.status).toBe(400);
    expect(harness.api.listRounds(jobId)).toEqual([]);
    expect(harness.api.listJobEvents(jobId)).toEqual(before);
  });

  it('write endpoints reject bad bodies and missing entities', async () => {
    const badBody = await postJson(harness.port, '/api/jobs', 'board-test-token', { id: 'x' });
    expect(badBody.status).toBe(400);
    const missing = await postJson(harness.port, '/api/rounds', 'board-test-token', { jobId: 'ghost' });
    expect(missing.status).toBe(404);
    const unauth = await postJson(harness.port, '/api/jobs', null, { id: 'y', repo: 'r', title: 't' });
    expect(unauth.status).toBe(401);
  });

  it('the write API validates enum vocabularies (role, agent state, lens outcome)', async () => {
    await postJson(harness.port, '/api/jobs', 'board-test-token', {
      id: 'enum-job',
      repo: 'demo-repo',
      title: 'Enum checks',
    });
    const badRole = await postJson(harness.port, '/api/agents', 'board-test-token', {
      id: 'bad-role',
      role: 'banana',
    });
    expect(badRole.status).toBe(400);
    const goodRole = await postJson(harness.port, '/api/agents', 'board-test-token', {
      id: 'good-role',
      role: 'perkins',
    });
    expect(goodRole.status).toBe(201);
    const badState = await postJson(harness.port, '/api/agents/state', 'board-test-token', {
      id: 'good-role',
      state: 'flying',
    });
    expect(badState.status).toBe(400);
    const goodState = await postJson(harness.port, '/api/agents/state', 'board-test-token', {
      id: 'good-role',
      state: 'streaming',
    });
    expect(goodState.status).toBe(200);
    const round = await postJson(harness.port, '/api/rounds', 'board-test-token', { jobId: 'enum-job' });
    const roundId = (round.body as { id: string }).id;
    const liveOutcome = await postJson(harness.port, '/api/lenses/outcome', 'board-test-token', {
      roundId,
      lens: 'blind',
      state: 'live',
    });
    expect(liveOutcome.status).toBe(400); // live derives from agent events, never posted
    const badLenses = await postJson(harness.port, '/api/rounds', 'board-test-token', {
      jobId: 'enum-job',
      lenses: [],
    });
    expect(badLenses.status).toBe(400); // an explicit empty list is never silently defaulted
    const wrongType = await postJson(harness.port, '/api/jobs', 'board-test-token', {
      id: 'typed',
      repo: 'r',
      title: 't',
      baseBranch: 123,
    });
    expect(wrongType.status).toBe(400); // present-but-wrong-typed fields are never dropped
  });

  it('typed 404s: missing entities AND missing transcript files', async () => {
    const missingJob = await postJson(harness.port, '/api/jobs/ghost/status', 'board-test-token', {
      status: 'working',
    });
    expect(missingJob.status).toBe(404);
    const missingTranscript = await getJson(
      harness.port,
      '/api/transcripts/file?file=nope/missing.jsonl',
      'board-test-token',
    );
    expect(missingTranscript.status).toBe(404);
    const badBefore = await getJson(
      harness.port,
      '/api/transcripts/file?file=x&before=',
      'board-test-token',
    );
    expect(badBefore.status).toBe(400); // empty-string params are rejected, not coerced
  });

  it('unknown /api paths 404; non-API paths fall through to the service (404 here)', async () => {
    const unknown = await getJson(harness.port, '/api/nope', 'board-test-token');
    expect(unknown.status).toBe(404);
    const outside = await getJson(harness.port, '/not-api', 'board-test-token');
    expect(outside.status).toBe(404);
  });

  it('GET /api/transcripts lists session files (empty store → empty list)', async () => {
    const res = await getJson(harness.port, '/api/transcripts', 'board-test-token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcripts: [] });
  });
});

describe('board server — WS push', () => {
  let harness: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    harness = await boot('ws-board-token');
  });

  it('G09 contains malformed evidence during auth snapshot push', () => assertSnapshotUnavailable('auth'));
  it('G09 contains malformed evidence during event snapshot push', () => assertSnapshotUnavailable('event'));
  it('F03 object-shaped malformed evidence is contained during auth snapshot push', () => assertSnapshotUnavailable('auth', { pr_url: null, pr_open: 'true', mergeable_state: null, sha: null }));
  it('F03 object-shaped malformed evidence is contained during event snapshot push', () => assertSnapshotUnavailable('event', { pr_url: null, pr_open: 'true', mergeable_state: null, sha: null }));
  async function assertSnapshotUnavailable(boundary: 'auth' | 'event', payload: unknown = []): Promise<void> {
    const isolated = await boot('malformed-ws-token', { heartbeatMs: 0 });
    const client = new BoardClient(isolated.port);
    try {
      const addJob = () => isolated.api.addJob({ id: 'malformed-ws-job', repo: 'r', title: 'invalid evidence' });
      const corrupt = () => isolated.api.appendCustomEvent({ kind: 'github.branch-state', jobId: 'malformed-ws-job', payload });
      const peer = await openBoardPeer(client);
      if (boundary === 'auth') {
        addJob(); corrupt();
        expect(() => peer.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'malformed-ws-token' })))).not.toThrow();
      } else {
        client.send({ type: 'auth', token: 'malformed-ws-token' });
        await client.waitFor((frame) => frame.type === 'board', 'initial valid snapshot');
        addJob();
        await client.waitFor(() => client.frames.some((frame) => frame.type === 'board' &&
          (frame.snapshot as { repos: { jobs: { id: string }[] }[] }).repos.some((repo) => repo.jobs.some((job) => job.id === 'malformed-ws-job'))), 'job source push');
        corrupt();
      }
      const previousBoards = client.frames.filter((frame) => frame.type === 'board').length;
      await client.waitFor((frame) => frame.type === 'error', 'unavailable snapshot').catch(() => {});
      expect(client.frames.find((frame) => frame.type === 'error')).toMatchObject({ type: 'error', fatal: false, message: expect.stringContaining('board unavailable') });
      expect(client.frames.filter((frame) => frame.type === 'board')).toHaveLength(previousBoards);
      expect(await client.closed).toBe(1011);
      expect(() => isolated.engine.mailbox.snapshot()).toThrow(/malformed PR evidence/);
      expect((await getJson(isolated.port, '/api/board', 'malformed-ws-token')).status).toBe(503);
      const prUrl = 'https://github.com/org/repo/pull/305';
      isolated.api.setJobPr('malformed-ws-job', prUrl);
      isolated.api.appendCustomEvent({ kind: 'github.branch-state', jobId: 'malformed-ws-job', payload: branchStatePayload(
        { jobId: 'malformed-ws-job', repo: { host: 'github.com', owner: 'org', repo: 'repo' }, branch: 'mailbox', prNumber: 305, prUrl },
        { sha: 'recovered-head', merged: false, prNumber: 305, prUrl, prOpen: true, mergeableState: 'dirty', mergeCommitSha: null, ci: null },
      ) });
      const recovered = new BoardClient(isolated.port);
      try {
        await recovered.open();
        recovered.send({ type: 'auth', token: 'malformed-ws-token' });
        await recovered.waitFor((frame) => frame.type === 'board', 'same-token recovered snapshot');
        const frame = recovered.frames.find((frame) => frame.type === 'board')!;
        expect(frame.snapshot).toMatchObject({ mailbox: { counts: { threads: 1, needsGru: 1 }, items: [{ jobId: 'malformed-ws-job', state: 'needs-gru' }] } });
        expect(recovered.frames.some((frame) => frame.type === 'error')).toBe(false);
        expect((await getJson(isolated.port, '/api/board', 'malformed-ws-token')).status).toBe(200);
      } finally { await recovered.close(); }
    } finally { await client.terminate(); await isolated.close(); }
  }

  it('G09 contains unexpected runtime snapshot errors at auth without fabricating board data', async () => {
    const isolated = await boot('runtime-ws-token', { heartbeatMs: 0 });
    const client = new BoardClient(isolated.port);
    const snapshot = vi.spyOn(isolated.engine, 'snapshot').mockImplementation(() => { throw new Error('snapshot source unavailable'); });
    try {
      const peer = await openBoardPeer(client);
      expect(() => peer.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'runtime-ws-token' })))).not.toThrow();
      await client.waitFor((frame) => frame.type === 'error', 'runtime error').catch(() => {});
      expect(client.frames.find((frame) => frame.type === 'error')).toMatchObject({ fatal: false, message: expect.stringContaining('snapshot source unavailable') });
      expect(client.frames.some((frame) => frame.type === 'board')).toBe(false);
      expect(await client.closed).toBe(1011);
      expect((await getJson(isolated.port, '/api/board', 'runtime-ws-token')).status).toBe(503);
      snapshot.mockRestore();
      const recovered = new BoardClient(isolated.port);
      try {
        await recovered.open();
        recovered.send({ type: 'auth', token: 'runtime-ws-token' });
        await recovered.waitFor((frame) => frame.type === 'board', 'runtime recovery with same token');
        expect(recovered.frames.some((frame) => frame.type === 'error')).toBe(false);
        expect((await getJson(isolated.port, '/api/board', 'runtime-ws-token')).status).toBe(200);
      } finally { await recovered.close(); }
    } finally { snapshot.mockRestore(); await client.terminate(); await isolated.close(); }
  });

  it('auth → auth_ok → immediate snapshot; changes push fresh snapshots', async () => {
    const client = new BoardClient(harness.port);
    await client.open();
    client.send({ type: 'auth', token: 'ws-board-token' });
    await client.waitFor((f) => f.type === 'auth_ok', 'auth_ok');
    await client.waitFor((f) => f.type === 'board', 'initial snapshot');
    const pushesBefore = client.frames.filter((f) => f.type === 'board').length;
    // A ledger write lands → a new snapshot arrives.
    harness.api.addJob({ id: 'push-job', repo: 'r', title: 'push' });
    await client.waitFor((f) => f.type === 'board' && client.frames.filter((x) => x.type === 'board').length > pushesBefore, 'pushed snapshot');
    const last = client.frames
      .filter((f) => f.type === 'board')
      .at(-1) as unknown as { snapshot: { repos: { jobs: { id: string }[] }[] } };
    expect(last.snapshot.repos.some((r) => r.jobs.some((j) => j.id === 'push-job'))).toBe(true);
    await client.close();
  });

  it('a refreshed incident detail reaches a connected board at once — same id, first failure kept, no heartbeat needed', async () => {
    const quiet = await boot('ws-refresh-token', { heartbeatMs: 0 });
    try {
      const notifications = new NotificationCenter({ ledger: quiet.api, bus: quiet.bus });
      const times = ['2026-10-07T09:00:00.000Z', '2026-10-07T21:00:00.000Z'];
      let tick = 0;
      const hooks = dreamFailureIncidents(notifications, 'REPAIR', () => new Date(times[tick++]!));
      hooks.onFailure(new Error('first outage'));
      const client = new BoardClient(quiet.port);
      await client.open();
      client.send({ type: 'auth', token: 'ws-refresh-token' });
      await client.waitFor((f) => f.type === 'board', 'initial snapshot');
      type Row = { id: string; kind: string; detail: string | null };
      const incident = (frame: { type: string }): Row | undefined =>
        frame.type === 'board'
          ? (frame as unknown as { snapshot: { notifications: Row[] } }).snapshot.notifications.find((row) => row.kind === DREAM_FAILED_KIND)
          : undefined;
      const initial = incident(client.frames.filter((f) => f.type === 'board').at(-1)!)!;
      expect(initial.detail).toContain('failed pass 1');
      hooks.onFailure(new Error('second outage'));
      await client.waitFor((f) => (incident(f)?.detail ?? '').includes('failed pass 2'), 'refreshed incident detail');
      const refreshed = client.frames.map(incident).filter((row): row is Row => row !== undefined).at(-1)!;
      expect(refreshed.id).toBe(initial.id);
      expect(refreshed.detail).toContain(`First failure (${times[0]}): Error: first outage`);
      expect(refreshed.detail).toContain(`Latest failure (${times[1]}, failed pass 2): Error: second outage`);
      await client.close();
    } finally {
      await quiet.close();
    }
  });

  it('a bad token is a fatal error + close; a non-auth first frame likewise', async () => {
    const bad = new BoardClient(harness.port);
    await bad.open();
    bad.send({ type: 'auth', token: 'nope' });
    const code = await bad.closed;
    expect(code).not.toBe(1000);
    expect(bad.frames.some((f) => f.type === 'error' && (f.message ?? '').includes('invalid token'))).toBe(true);

    const malformed = new BoardClient(harness.port);
    await malformed.open();
    malformed.send('not json at all');
    const code2 = await malformed.closed;
    expect(code2).not.toBe(1000);

    const wrongFirst = new BoardClient(harness.port);
    await wrongFirst.open();
    wrongFirst.send({ type: 'board', snapshot: {} });
    await wrongFirst.closed;
  });

  it('heartbeat sends application-level ping frames (client liveness evidence)', async () => {
    const env = await boot('heartbeat-board-token', { heartbeatMs: 40 });
    try {
      const client = new BoardClient(env.port);
      await client.open();
      client.send({ type: 'auth', token: 'heartbeat-board-token' });
      await client.waitFor((f) => f.type === 'auth_ok', 'auth_ok');
      // The server pings every 40 ms; the JSON ping frame is how the
      // browser client refreshes its stale clock.
      await client.waitFor((f) => f.type === 'ping', 'app ping');
      // Issue #171: the same cadence refreshes the snapshot — supervision
      // activity and ownership classification can change without a ledger
      // event, so a connected board must not stay stale.
      client.frames.length = 0;
      await client.waitFor((f) => f.type === 'board', 'heartbeat snapshot refresh');
      await client.close();
    } finally {
      await env.close();
    }
  });

  it('authed WS clients survive post-auth noise frames (valid JSON or garbage)', async () => {
    const client = new BoardClient(harness.port);
    await client.open();
    client.send({ type: 'auth', token: 'ws-board-token' });
    await client.waitFor((f) => f.type === 'auth_ok', 'auth_ok');
    client.frames.length = 0;
    // Post-auth traffic of any shape is IGNORED — never a fatal close.
    client.send({ type: 'ping' });
    client.send('garbage-not-json');
    harness.api.addJob({ id: 'post-noise', repo: 'r', title: 'still live' });
    await client.waitFor((f) => f.type === 'board', 'snapshot after noise');
    await client.close();
  });

  it('an unclaimed upgrade path is terminated by the board (the last-attached handler)', async () => {
    const stray = new BoardClient(harness.port, '/definitely-not-a-ws');
    const code = await Promise.race([
      stray.closed,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error('stray lingered')), 3_000)),
    ]);
    expect(typeof code).toBe('number');
  });
});

describe('board server — empty token config locks every door', () => {
  it('notification shown/ack round-trip (E7): receipts idempotent, ack fires the hook, 404 unknown', async () => {
    const acked: string[] = [];
    const dispositions: string[] = [];
    const dir = tmpDir();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(dir, 'config.toml'),
      '[auth]\ntoken = "ack-token"\n[server]\nhost = "127.0.0.1"\nport = 0\n',
      'utf-8',
    );
    const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
    const db = new LedgerDb(dir);
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    const engine = new BoardEngine({ ledger: api, bus });
    const notifications = new NotificationCenter({ ledger: api, bus });
    const board = createBoardServer({
      config: cfg,
      engine,
      ledger: api,
      transcripts: new TranscriptService(join(dir, 'sessions'), { ledger: api }),
      bus,
      notifications,
      onNotificationAck: (id) => acked.push(id),
      onNotificationDisposition: (id) => {
        dispositions.push(id);
      },
      pushDebounceMs: 10,
    });
    const http: HttpServer = createServer((req, res) => {
      if (board.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
      res.writeHead(404);
      res.end();
    });
    board.attach(http);
    await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
    const port = (http.address() as AddressInfo).port;
    try {
      const row = notifications.post({
        kind: 'port-squat',
        routing: 'needs-owner',
        severity: 'error',
        title: 'Foreign process holds port 7665 (pid a1)',
        detail: 'stop it, then restart the service',
      });
      // Auth door on the notification endpoints too.
      const anon = await postJson(port, `/api/notifications/${row.id}/ack`, null, { by: 'web' });
      expect(anon.status).toBe(401);
      // Display receipt (idempotent).
      const shown1 = await postJson(port, `/api/notifications/${row.id}/shown`, 'ack-token', { surface: 'web-toast' });
      expect(shown1.status).toBe(200);
      const shown2 = await postJson(port, `/api/notifications/${row.id}/shown`, 'ack-token', { surface: 'web-toast' });
      expect(shown2.status).toBe(200);
      const shownEvents = api
        .listEvents({ limit: 100 })
        .filter((e) => e.kind === 'notification.shown' && (e.payload as { id: string }).id === row.id);
      expect(shownEvents.length).toBe(1);
      // Missing surface is a 400.
      const bad = await postJson(port, `/api/notifications/${row.id}/shown`, 'ack-token', {});
      expect(bad.status).toBe(400);
      const machine = notifications.post({ kind: 'test.machine', routing: 'action-required', severity: 'error', title: 'Gru repair required' });
      const illegal = await postJson(port, `/api/notifications/${machine.id}/ack`, 'ack-token', { by: 'web' });
      expect(illegal.status).toBe(400);
      expect(api.getNotification(machine.id)).toMatchObject({ ackedAt: null, resolvedAt: null });
      expect(api.countPendingActionRequiredIncludingReceipts()).toBeGreaterThan(0);
      // Machine disposition fires the disposition hook exactly once (the
      // supervisor's guarded breaker re-arm rides this in production).
      const disposedRow = await postJson(port, `/api/notifications/${machine.id}/disposition`, 'ack-token', { detail: 'repair lane opened' });
      expect(disposedRow).toMatchObject({ status: 200, body: { resolvedBy: 'gru', ackedAt: null } });
      const disposedAgain = await postJson(port, `/api/notifications/${machine.id}/disposition`, 'ack-token', { detail: 'repeat' });
      expect(disposedAgain.status).toBe(200);
      expect(dispositions).toEqual([machine.id]);
      // Owner Ack fires the hook exactly once, idempotently.
      const ack1 = await postJson(port, `/api/notifications/${row.id}/ack`, 'ack-token', { by: 'web' });
      expect(ack1.status).toBe(200);
      expect((ack1.body as { ackedAt: string | null }).ackedAt).not.toBeNull();
      const ack2 = await postJson(port, `/api/notifications/${row.id}/ack`, 'ack-token', { by: 'web' });
      expect(ack2.status).toBe(200);
      expect(acked).toEqual([row.id]);
      // Unknown id → 404.
      const missing = await postJson(port, '/api/notifications/nope/ack', 'ack-token', { by: 'web' });
      expect(missing.status).toBe(404);
      // A Book of Lessons proposal closes only through Accept/Reject (owner
      // decision 2026-10-07): a plain ack is refused and fires no hook.
      const proposal = notifications.post({
        kind: 'lessons.proposal',
        routing: 'fyi',
        severity: 'info',
        title: 'Book of Lessons: 1 lesson change proposed',
      });
      expect(proposal.routing).toBe('needs-owner');
      const refused = await postJson(port, `/api/notifications/${proposal.id}/ack`, 'ack-token', { by: 'web' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'decision_required' });
      expect(api.getNotification(proposal.id)).toMatchObject({ ackedAt: null, resolvedAt: null });
      expect(acked).toEqual([row.id]);
      // A failing dream's incident closes only on a completed pass (owner
      // decision 2026-10-08): Gru's disposition is refused, the row stays open.
      const dreamFailed = notifications.post({
        kind: 'lessons.dream-failed',
        routing: 'action-required',
        severity: 'error',
        title: 'Lesson dream is failing — the Book of Lessons is not being updated',
      });
      const disposed = await postJson(port, `/api/notifications/${dreamFailed.id}/disposition`, 'ack-token', { detail: 'opened a repair lane' });
      expect(disposed.status).toBe(409);
      expect(disposed.body).toMatchObject({ error: 'producer_resolved', detail: expect.stringContaining('a completed dream pass') });
      expect(api.getNotification(dreamFailed.id)).toMatchObject({ resolvedAt: null, ackedAt: null });
    } finally {
      await board.dispose();
      await new Promise<void>((resolveClose) => {
        http.closeAllConnections();
        http.close(() => resolveClose());
      });
      db.close();
    }
  });

  it('HTTP returns 503 not_configured; WS rejects with a fatal error', async () => {
    const harness = await boot('');
    const res = await getJson(harness.port, '/api/board', null);
    expect(res.status).toBe(503);
    const client = new BoardClient(harness.port);
    await client.open();
    client.send({ type: 'auth', token: '' });
    await client.closed;
    expect(client.frames.some((f) => f.type === 'error' && (f.message ?? '').includes('not configured'))).toBe(true);
    await harness.close();
  });

  it('pages closed receipts on demand, newest-first, with the raw offset cursor (D3)', async () => {
    const harness = await boot('board-test-token');
    try {
      harness.api.addJob({ id: 'job-receipts', repo: 'r', title: 'Receipts', briefing: 'b' });
      harness.api.setJobStatus('job-receipts', 'working');
      harness.api.registerAgent({ id: 'minion-receipts', role: 'minion', jobId: 'job-receipts' });
      const center = new NotificationCenter({ ledger: harness.api, bus: harness.bus });
      for (let i = 0; i < 3; i += 1) {
        center.post({
          kind: `receipt-page-${i}`,
          routing: 'action-required',
          severity: 'error',
          title: `receipt ${i}`,
          agentId: 'minion-receipts',
        });
      }
      harness.api.setJobStatus('job-receipts', 'delivered');
      harness.api.setJobStatus('job-receipts', 'in-review');
      harness.api.setJobStatus('job-receipts', 'merged');
      expect((await getJson(harness.port, '/api/notifications/receipts', null)).status).toBe(401);
      const first = await getJson(harness.port, '/api/notifications/receipts?limit=2', 'board-test-token');
      expect(first.status).toBe(200);
      const firstBody = first.body as { receipts: { id: string }[]; nextOffset: number; hasMore: boolean };
      expect(firstBody.receipts).toHaveLength(2);
      expect(firstBody.hasMore).toBe(true);
      const second = await getJson(
        harness.port,
        `/api/notifications/receipts?offset=${firstBody.nextOffset}&limit=2`,
        'board-test-token',
      );
      const secondBody = second.body as { receipts: { id: string }[]; hasMore: boolean };
      expect(secondBody.receipts).toHaveLength(1);
      expect(secondBody.hasMore).toBe(false);
    } finally {
      await harness.close();
    }
  });
});

describe('board server — decision memory (issue #218)', () => {
  it('decision routes are bearer-authed, create idempotently, list, and clear', async () => {
    const harness = await boot('board-test-token');
    try {
      const decisionBody = {
        subject: 'pr:mssoka/gru-command#148',
        decision: 'hold',
        covers: ['pr-conflict'],
        basis_fingerprint: 'aaaa',
        reason: 'existing ownership/integration hold',
        by: 'gru',
        client_key: 'http-idem-1',
      };
      // Locked door without the bearer.
      expect((await postJson(harness.port, '/api/decisions', null, decisionBody)).status).toBe(401);
      expect((await postJson(harness.port, '/api/decisions/whatever/clear', null, { by: 'gru', reason: 'r' })).status).toBe(401);
      expect((await getJson(harness.port, '/api/decisions', null)).status).toBe(401);

      const first = await postJson(harness.port, '/api/decisions', 'board-test-token', decisionBody);
      expect(first.status).toBe(201);
      const created = first.body as { id: string; subject: string; covers: string[]; recheckAt: string | null };
      expect(created.subject).toBe('pr:mssoka/gru-command#148');
      expect(created.covers).toEqual(['pr-conflict']);

      // Retry with the same client_key returns the SAME decision — never a second row.
      const retry = await postJson(harness.port, '/api/decisions', 'board-test-token', decisionBody);
      expect((retry.body as { id: string }).id).toBe(created.id);
      expect(((await getJson(harness.port, '/api/decisions', 'board-test-token')).body as { decisions: unknown[] }).decisions).toHaveLength(1);

      // Validation failures are loud 400s.
      expect(
        (await postJson(harness.port, '/api/decisions', 'board-test-token', { ...decisionBody, decision: 'maybe', client_key: 'bad-1' })).status,
      ).toBe(400);
      expect(
        (await postJson(harness.port, '/api/decisions', 'board-test-token', { ...decisionBody, by: 'minion', client_key: 'bad-2' })).status,
      ).toBe(400);
      expect(
        (await postJson(harness.port, '/api/decisions', 'board-test-token', { ...decisionBody, covers: 'pr-conflict', client_key: 'bad-3' })).status,
      ).toBe(400);
      expect(
        (await postJson(harness.port, '/api/decisions', 'board-test-token', { ...decisionBody, subject: 'no-colon', client_key: 'bad-4' })).status,
      ).toBe(400);
      expect(
        (await postJson(harness.port, '/api/decisions', 'board-test-token', { ...decisionBody, subject: 'bogus:key', client_key: 'bad-5' })).status,
      ).toBe(400);
      // Present-but-empty optional fields are LOUD 400s — never silent
      // broadening ("" fingerprint → any-basis) or silent recheck removal.
      expect(
        (await postJson(harness.port, '/api/decisions', 'board-test-token', { ...decisionBody, basis_fingerprint: '', client_key: 'bad-6' })).status,
      ).toBe(400);
      expect(
        (await postJson(harness.port, '/api/decisions', 'board-test-token', { ...decisionBody, recheck_at: '', client_key: 'bad-7' })).status,
      ).toBe(400);
      expect(
        (await postJson(harness.port, '/api/decisions', 'board-test-token', { ...decisionBody, client_key: '' })).status,
      ).toBe(400);
      expect(
        (await postJson(harness.port, '/api/decisions', 'board-test-token', { ...decisionBody, recheck_at: 'March 5 2030', client_key: 'bad-8' })).status,
      ).toBe(400);

      // The board snapshot carries active decisions (subject, decision, by, recheck).
      const snapshot = (await getJson(harness.port, '/api/board', 'board-test-token')).body as {
        activeDecisions: { id: string; subject: string; decision: string; by: string; recheckAt: string | null }[];
        activeDecisionCount: number;
      };
      expect(snapshot.activeDecisions).toHaveLength(1);
      expect(snapshot.activeDecisionCount).toBe(1);
      expect(snapshot.activeDecisions[0]).toMatchObject({
        id: created.id, subject: created.subject, decision: 'hold', by: 'gru', recheckAt: null,
      });

      // subject filter + active filter on the listing.
      const subjectQuery = encodeURIComponent('pr:mssoka/gru-command#148');
      const listed = (await getJson(harness.port, `/api/decisions?subject=${subjectQuery}&active=1`, 'board-test-token')).body as {
        decisions: { id: string }[];
      };
      expect(listed.decisions.map((d) => d.id)).toEqual([created.id]);

      // Clear: unknown id is a typed 404; the real clear re-opens the subject.
      expect(
        (await postJson(harness.port, '/api/decisions/does-not-exist/clear', 'board-test-token', { by: 'gru', reason: 'r' })).status,
      ).toBe(404);
      const cleared = await postJson(harness.port, `/api/decisions/${created.id}/clear`, 'board-test-token', { by: 'owner', reason: 'hold lifted' });
      expect(cleared.status).toBe(200);
      expect((cleared.body as { clearedAt: string | null }).clearedAt).not.toBeNull();
      expect(((await getJson(harness.port, '/api/decisions?active=1', 'board-test-token')).body as { decisions: unknown[] }).decisions).toHaveLength(0);
      expect(((await getJson(harness.port, '/api/decisions', 'board-test-token')).body as { decisions: unknown[] }).decisions).toHaveLength(1);
      const afterClear = (await getJson(harness.port, '/api/board', 'board-test-token')).body as { activeDecisions: unknown[]; activeDecisionCount: number };
      expect(afterClear.activeDecisions).toHaveLength(0);
      expect(afterClear.activeDecisionCount).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
describe('board server — guarded machine re-arm and the discussion bridge (R1 fixes)', () => {
  it('a refused re-arm is a typed 409 that consumes nothing; the same control retries once the fence clears', async () => {
    let refusal: { ok: boolean; reason?: string } | null = {
      ok: false,
      reason: 'job "parked-lane" is parked (owner/ops hold)',
    };
    const hookCalls: string[] = [];
    const { port, api, close } = await boot('board-test-token', {
      onNotificationDisposition: (id) => {
        hookCalls.push(id);
        return refusal ?? { ok: true };
      },
    });
    try {
      api.recordNotification({
        id: 'machine-rearm',
        kind: 'supervision.breaker',
        routing: 'action-required',
        severity: 'error',
        title: 'Lane stopped: restart ladder tripped',
        detail: 'breaker open',
      });
      const refused = await postJson(port, '/api/notifications/machine-rearm/disposition', 'board-test-token', {
        detail: 'fix landed',
      });
      expect(refused).toMatchObject({ status: 409, body: { error: 'rearm_refused', code: 'rearm_refused' } });
      // Nothing was recorded: the alert, its ack state and its retryable
      // debt all survive the refusal.
      expect(api.getNotification('machine-rearm')?.resolvedAt).toBeNull();
      expect(api.getNotification('machine-rearm')?.ackedAt).toBeNull();
      expect(
        api.listEvents({ limit: 100 }).filter((event) => event.kind === 'notification.rearm-refused'),
      ).toHaveLength(1);
      // The fence clears: the SAME control (no new alert, no new id) is
      // accepted and the row closes with the truthful re-arm outcome.
      refusal = null;
      const accepted = await postJson(port, '/api/notifications/machine-rearm/disposition', 'board-test-token', {
        detail: 'hold lifted',
      });
      expect(accepted).toMatchObject({ status: 200, body: { rearm: 'accepted' } });
      expect((accepted.body as { resolvedAt: string | null }).resolvedAt).not.toBeNull();
      expect(api.getNotification('machine-rearm')?.resolvedBy).toBe('gru');
      // A repeat disposition of the resolved row is idempotent and never
      // re-runs the guarded re-arm (the hook is skipped).
      const repeat = await postJson(port, '/api/notifications/machine-rearm/disposition', 'board-test-token', {
        detail: 'duplicate',
      });
      expect(repeat).toMatchObject({ status: 200, body: { rearm: 'not_applicable' } });
      expect(hookCalls).toEqual(['machine-rearm', 'machine-rearm']);
    } finally {
      await close();
    }
  });

  it('the production supervisor binding preserves a real refusal through the authenticated disposition route', async () => {
    let disposition: ((id: string) => ReturnType<Supervisor['onNotificationDisposed']>) | null = null;
    const harness = await boot('board-test-token', {
      onNotificationDisposition: (id) => (disposition === null ? undefined : disposition(id)),
    });
    const registryTap: { listener: ((envelope: AgentEventEnvelope) => void) | null } = { listener: null };
    const registry: SupervisorRegistry = {
      onAgentEvent: (listener) => {
        registryTap.listener = listener;
        return () => { registryTap.listener = null; };
      },
      getHandle: () => null,
      spawn: async () => { throw new Error('parked re-arm must refuse before spawn'); },
      disposeHandle: async () => {},
    };
    const supervisor = new Supervisor({
      config: { enabled: true, turnSilenceMs: 60_000, restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1_000 },
      registry,
      ledger: harness.api,
      notifications: harness.notifications,
      tickMs: 5_000,
    });
    disposition = bindSupervisorNotificationDisposition(supervisor);
    try {
      supervisor.start();
      harness.api.addJob({ id: 'real-parked-lane', repo: 'fixture', title: 'parked lane' });
      harness.api.setJobStatus('real-parked-lane', 'parked');
      harness.api.registerAgent({ id: 'real-stopped-agent', role: 'minion', jobId: 'real-parked-lane' });
      registryTap.listener?.({ agentId: 'real-stopped-agent', role: 'minion', sessionFile: null, phase: 'spawned' });
      const internals = supervisor as unknown as { agents: Map<string, unknown>; tripBreaker(agent: unknown): void };
      const agent = internals.agents.get('real-stopped-agent');
      if (agent === undefined) throw new Error('supervisor did not adopt the fixture agent');
      internals.tripBreaker(agent);
      const stop = harness.api.listNotifications({ limit: 50 }).find((row) => row.agentId === 'real-stopped-agent' && row.kind === 'supervision.breaker');
      if (stop === undefined) throw new Error('supervisor did not post the breaker control');

      const response = await postJson(harness.port, `/api/notifications/${encodeURIComponent(stop.id)}/disposition`, 'board-test-token', {
        detail: 'retry after hold review',
      });
      expect(response).toMatchObject({ status: 409, body: { error: 'rearm_refused', code: 'rearm_refused' } });
      expect(harness.api.getNotification(stop.id)).toMatchObject({ resolvedAt: null, ackedAt: null });
    } finally {
      supervisor.dispose();
      await harness.close();
    }
  });

  it('keeps a restored breaker control open when disposition precedes agent adoption', async () => {
    let disposition: ((id: string) => ReturnType<Supervisor['onNotificationDisposed']>) | null = null;
    const harness = await boot('board-test-token', {
      onNotificationDisposition: (id) => (disposition === null ? undefined : disposition(id)),
    });
    const registryTap: { listener: ((envelope: AgentEventEnvelope) => void) | null } = { listener: null };
    const registry: SupervisorRegistry = {
      onAgentEvent: (listener) => {
        registryTap.listener = listener;
        return () => { registryTap.listener = null; };
      },
      getHandle: () => null,
      spawn: async () => { throw new Error('an unadopted restored stop must refuse before spawn'); },
      disposeHandle: async () => {},
    };
    const config = { enabled: true, turnSilenceMs: 60_000, restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1_000 };
    const supervisor = new Supervisor({
      config,
      registry,
      ledger: harness.api,
      notifications: harness.notifications,
      tickMs: 5_000,
    });
    let originalDisposed = false;
    let restored: Supervisor | null = null;
    disposition = bindSupervisorNotificationDisposition(supervisor);
    try {
      supervisor.start();
      harness.api.addJob({ id: 'restore-before-adopt-job', repo: 'fixture', title: 'restored breaker control' });
      harness.api.setJobStatus('restore-before-adopt-job', 'working');
      harness.api.registerAgent({ id: 'restore-before-adopt-agent', role: 'minion', jobId: 'restore-before-adopt-job' });
      registryTap.listener?.({ agentId: 'restore-before-adopt-agent', role: 'minion', sessionFile: null, phase: 'spawned' });
      const internals = supervisor as unknown as { agents: Map<string, unknown>; tripBreaker(agent: unknown): void };
      const agent = internals.agents.get('restore-before-adopt-agent');
      if (agent === undefined) throw new Error('supervisor did not adopt the fixture agent');
      internals.tripBreaker(agent);
      const stop = harness.api.listNotifications({ limit: 50 }).find(
        (row) => row.agentId === 'restore-before-adopt-agent' && row.kind === 'supervision.breaker',
      );
      if (stop === undefined) throw new Error('supervisor did not post the breaker control');

      supervisor.dispose();
      originalDisposed = true;
      restored = new Supervisor({ config, registry, ledger: harness.api, notifications: harness.notifications, tickMs: 5_000 });
      disposition = bindSupervisorNotificationDisposition(restored);
      restored.start();
      expect(restored.viewFor('restore-before-adopt-agent')).toMatchObject({ state: 'stopped', breakerOpen: true });

      const response = await postJson(
        harness.port,
        `/api/notifications/${encodeURIComponent(stop.id)}/disposition`,
        'board-test-token',
        { detail: 'retry after adoption' },
      );
      expect(response).toMatchObject({ status: 409, body: { error: 'rearm_refused', code: 'rearm_refused' } });
      expect(harness.api.getNotification(stop.id)).toMatchObject({ resolvedAt: null, ackedAt: null });
      expect(restored.viewFor('restore-before-adopt-agent')).toMatchObject({ state: 'stopped', breakerOpen: true });
    } finally {
      restored?.dispose();
      if (!originalDisposed) supervisor.dispose();
      await harness.close();
    }
  });

  it('re-fences a pre-spawn re-arm failure through the authenticated disposition route', async () => {
    let disposition: ((id: string) => ReturnType<Supervisor['onNotificationDisposed']>) | null = null;
    const harness = await boot('board-test-token', {
      onNotificationDisposition: (id) => (disposition === null ? undefined : disposition(id)),
    });
    const registryTap: { listener: ((envelope: AgentEventEnvelope) => void) | null } = { listener: null };
    let spawnCalls = 0;
    const registry: SupervisorRegistry = {
      onAgentEvent: (listener) => {
        registryTap.listener = listener;
        return () => { registryTap.listener = null; };
      },
      getHandle: () => null,
      spawn: async () => {
        spawnCalls += 1;
        throw new Error('pre-spawn notification failure must prevent spawn');
      },
      disposeHandle: async () => {},
    };
    const supervisor = new Supervisor({
      config: { enabled: true, turnSilenceMs: 60_000, restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1_000 },
      registry,
      ledger: harness.api,
      notifications: harness.notifications,
      tickMs: 5_000,
    });
    disposition = bindSupervisorNotificationDisposition(supervisor);
    const originalPost = harness.notifications.post.bind(harness.notifications);
    harness.notifications.post = ((input: Parameters<NotificationCenter['post']>[0]) => {
      if (input.kind === 'supervision.restart') throw new Error('restart notice unavailable');
      return originalPost(input);
    }) as typeof harness.notifications.post;
    try {
      supervisor.start();
      harness.api.addJob({ id: 'pre-spawn-rearm-job', repo: 'fixture', title: 'pre-spawn re-arm failure' });
      harness.api.setJobStatus('pre-spawn-rearm-job', 'working');
      harness.api.registerAgent({ id: 'pre-spawn-rearm-agent', role: 'minion', jobId: 'pre-spawn-rearm-job' });
      registryTap.listener?.({ agentId: 'pre-spawn-rearm-agent', role: 'minion', sessionFile: null, phase: 'spawned' });
      const internals = supervisor as unknown as { agents: Map<string, unknown>; tripBreaker(agent: unknown): void };
      const agent = internals.agents.get('pre-spawn-rearm-agent');
      if (agent === undefined) throw new Error('supervisor did not adopt the fixture agent');
      internals.tripBreaker(agent);
      const stop = harness.api.listNotifications({ limit: 50 }).find(
        (row) => row.agentId === 'pre-spawn-rearm-agent' && row.kind === 'supervision.breaker',
      );
      if (stop === undefined) throw new Error('supervisor did not post the breaker control');

      const response = await postJson(
        harness.port,
        `/api/notifications/${encodeURIComponent(stop.id)}/disposition`,
        'board-test-token',
        { detail: 'retry after the restart notice failure' },
      );
      expect(response).toMatchObject({ status: 200, body: { rearm: 'accepted' } });
      expect(harness.api.getNotification(stop.id)?.resolvedAt).not.toBeNull();
      await vi.waitFor(() =>
        expect(supervisor.viewFor('pre-spawn-rearm-agent')).toMatchObject({ state: 'stopped', breakerOpen: true }),
      );
      expect(spawnCalls).toBe(0);
      const retryControl = harness.api.listNotifications({ limit: 50, unackedOnly: true }).find(
        (row) => row.agentId === 'pre-spawn-rearm-agent' && row.kind === 'supervision.rearm-fenced',
      );
      expect(retryControl).toMatchObject({ routing: 'action-required', ackedAt: null, resolvedAt: null });
      expect(retryControl?.id).not.toBe(stop.id);
      expect(harness.api.latestSupervisionEvent('pre-spawn-rearm-agent')?.kind).toBe('supervision.rearm-fenced');
    } finally {
      supervisor.dispose();
      await harness.close();
    }
  });

  it('an alert that re-arms nothing reports the record-only outcome (rearmed: false)', async () => {
    const { port, api, close } = await boot('board-test-token', {
      onNotificationDisposition: () => ({ ok: true, rearmed: false }),
    });
    try {
      api.recordNotification({
        id: 'machine-unbound',
        kind: 'supervision.hang',
        routing: 'action-required',
        severity: 'error',
        title: 'Already resumed lane',
        detail: 'no stopped breaker is bound here',
      });
      const res = await postJson(port, '/api/notifications/machine-unbound/disposition', 'board-test-token', {
        detail: 'verified the lane resumed',
      });
      expect(res).toMatchObject({ status: 200, body: { rearm: 'not_applicable' } });
      expect((res.body as { resolvedAt: string | null }).resolvedAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it('a blank disposition detail is refused BEFORE the guarded hook can consume the control', async () => {
    const hookCalls: string[] = [];
    const { port, api, close } = await boot('board-test-token', {
      onNotificationDisposition: (id) => {
        hookCalls.push(id);
        return { ok: true, rearmed: true };
      },
    });
    try {
      api.recordNotification({
        id: 'machine-blank-detail',
        kind: 'supervision.breaker',
        routing: 'action-required',
        severity: 'error',
        title: 'Stopped',
        detail: 'breaker open',
      });
      const res = await postJson(port, '/api/notifications/machine-blank-detail/disposition', 'board-test-token', {
        detail: '   ',
      });
      expect(res).toMatchObject({ status: 400, body: { error: 'bad_request' } });
      expect(hookCalls).toEqual([]);
      expect(api.getNotification('machine-blank-detail')?.resolvedAt).toBeNull();
    } finally {
      await close();
    }
  });

  it('a throwing re-arm fails LOUD (502) and never records the disposition', async () => {
    const { port, api, close } = await boot('board-test-token', {
      onNotificationDisposition: () => {
        throw new Error('supervisor unavailable');
      },
    });
    try {
      api.recordNotification({
        id: 'machine-fail',
        kind: 'supervision.breaker',
        routing: 'action-required',
        severity: 'error',
        title: 'Lane stopped',
        detail: 'breaker open',
      });
      const res = await postJson(port, '/api/notifications/machine-fail/disposition', 'board-test-token', { detail: 'try' });
      expect(res).toMatchObject({ status: 502, body: { error: 'rearm_failed' } });
      expect(api.getNotification('machine-fail')?.resolvedAt).toBeNull();
      expect(api.listEvents({ limit: 100 }).filter((event) => event.kind === 'notification.rearm-failed')).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('without a supervisor hook a machine disposition still records (rearm not_applicable)', async () => {
    const { port, api, close } = await boot('board-test-token');
    try {
      api.recordNotification({
        id: 'machine-plain',
        kind: 'supervision.breaker',
        routing: 'action-required',
        severity: 'error',
        title: 'Lane stopped',
        detail: 'breaker open',
      });
      const res = await postJson(port, '/api/notifications/machine-plain/disposition', 'board-test-token', { detail: 'ok' });
      expect(res).toMatchObject({ status: 200, body: { rearm: 'not_applicable' } });
      expect((res.body as { resolvedAt: string | null }).resolvedAt).not.toBeNull();
    } finally {
      await close();
    }
  });

  it('the discussion bridge attaches agreed options, records nothing, and the typed path then settles', async () => {
    const { port, api, close } = await boot('board-test-token');
    try {
      const created = await postJson(port, '/api/notifications/needs-owner', 'board-test-token', {
        title: 'Which shape should the dashboard take?',
        detail: 'Talk it through with Gru before a choice is recorded',
        decision: {
          question: 'Which shape should the dashboard take?',
          context: 'The discussion has not converged on a concrete option.',
          recommendation: null,
          reservedClass: 'scope-design',
          whyNotDelegable: 'It changes the agreed product scope.',
          options: [],
          discussion: true,
        },
      });
      expect(created.status).toBe(201);
      const row = created.body as { id: string; decision: Record<string, unknown> };
      // No option exists yet: the typed path cannot invent an approval.
      expect(
        (await postJson(port, `/api/notifications/${row.id}/decision`, 'board-test-token', {
          optionId: 'go', expectedDecision: row.decision,
        })).status,
      ).toBe(400);
      const attached = await postJson(port, `/api/notifications/${row.id}/decision-options`, 'board-test-token', {
        options: [
          { id: 'go', label: 'Go with shape A', consequence: 'Gru commissions shape A.' },
          { id: 'stop', label: 'Stop here', consequence: 'Nothing moves.' },
        ],
        by: 'gru',
      });
      expect(attached).toMatchObject({ status: 200, body: { decidedAt: null, resolvedAt: null } });
      expect((attached.body as { decision: { options: readonly unknown[] } }).decision.options).toHaveLength(2);
      const staleDisplayedDecision = (attached.body as { decision: Record<string, unknown> }).decision;
      const refreshed = await postJson(port, `/api/notifications/${row.id}/decision-options`, 'board-test-token', {
        options: [
          { id: 'go', label: 'Go with shape B', consequence: 'Gru commissions shape B.' },
          { id: 'stop', label: 'Stop here', consequence: 'Nothing moves.' },
        ],
        by: 'gru',
      });
      expect(refreshed.status).toBe(200);
      const currentDisplayedDecision = (refreshed.body as { decision: Record<string, unknown> }).decision;
      const staleChoice = await postJson(port, `/api/notifications/${row.id}/decision`, 'board-test-token', {
        optionId: 'go', by: 'web', expectedDecision: staleDisplayedDecision,
      });
      expect(staleChoice).toMatchObject({ status: 409, body: { error: 'decision_refused', code: 'decision_changed' } });
      expect(api.getNotification(row.id)).toMatchObject({
        decidedAt: null,
        decision: { options: [
          { id: 'go', label: 'Go with shape B' },
          { id: 'stop', label: 'Stop here' },
        ] },
      });
      // Attaching options records NO choice: follow-through stays refused
      // until the owner decides.
      expect(
        (await postJson(port, `/api/notifications/${row.id}/disposition`, 'board-test-token', { detail: 'premature' })).status,
      ).toBe(409);
      const events = api.listEvents({ limit: 100 }).filter((event) => event.kind === 'notification.decision-options');
      expect(events).toHaveLength(2);
      expect(events[0]?.payload).toMatchObject({ id: row.id, by: 'gru', option_ids: ['go', 'stop'] });
      const decided = await postJson(port, `/api/notifications/${row.id}/decision`, 'board-test-token', {
        optionId: 'go', by: 'web', expectedDecision: currentDisplayedDecision,
      });
      expect(decided).toMatchObject({ status: 200, body: { decidedOption: 'go', resolvedAt: null } });
      expect((await postJson(port, `/api/notifications/${row.id}/disposition`, 'board-test-token', { detail: 'executed' })).status).toBe(200);
      // Refusal shapes: a typed (non-discussion) decision keeps its
      // producer-authored options; malformed/empty lists and unknown rows
      // are refused without touching anything.
      const typed = await postJson(port, '/api/notifications/needs-owner', 'board-test-token', {
        title: 'Typed decision',
        detail: 'producer-authored options',
        decision: {
          question: 'Q?',
          context: 'C',
          recommendation: null,
          reservedClass: 'scope-design',
          whyNotDelegable: 'W',
          options: [{ id: 'one', label: 'One', consequence: 'c' }],
          discussion: false,
        },
      });
      const typedId = (typed.body as { id: string }).id;
      const replaced = await postJson(port, `/api/notifications/${typedId}/decision-options`, 'board-test-token', {
        options: [{ id: 'two', label: 'Two', consequence: 'c' }],
      });
      expect(replaced).toMatchObject({ status: 409, body: { code: 'not_discussion' } });
      expect(api.getNotification(typedId)?.decision?.options.map((option) => option.id)).toEqual(['one']);
      expect(
        (await postJson(port, '/api/notifications/missing/decision-options', 'board-test-token', {
          options: [{ id: 'two', label: 'Two', consequence: 'c' }],
        })).status,
      ).toBe(404);
      // A needs-owner row with NO typed decision refuses the bridge with
      // the documented typed code.
      api.recordNotification({
        id: 'notice-without-decision',
        kind: 'port-squat',
        routing: 'needs-owner',
        severity: 'error',
        title: 'Port occupied',
        detail: 'bind refused',
      });
      const noDecision = await postJson(port, '/api/notifications/notice-without-decision/decision-options', 'board-test-token', {
        options: [{ id: 'two', label: 'Two', consequence: 'c' }],
      });
      expect(noDecision).toMatchObject({ status: 409, body: { code: 'no_decision' } });
      expect(
        (await postJson(port, `/api/notifications/${typedId}/decision-options`, 'board-test-token', { options: [] })).status,
      ).toBe(400);
      expect(
        (await postJson(port, `/api/notifications/${typedId}/decision-options`, 'board-test-token', {
          options: [{ id: 'BAD', label: 'x', consequence: 'c' }],
        })).status,
      ).toBe(400);
    } finally {
      await close();
    }
  });
});
