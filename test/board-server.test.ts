import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  overrides: Partial<Parameters<typeof createBoardServer>[0]> = {},
): Promise<{
  port: number;
  api: LedgerApi;
  bus: EventBus;
  board: ReturnType<typeof createBoardServer>;
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
  const engine = new BoardEngine({ ledger: api, bus });
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
    ...overrides,
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
    expect((await postJson(port, `/api/notifications/${owner.id}/disposition`, 'board-test-token', { detail: 'No' })).status).toBe(400);
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
    for (const body of [{}, { title: '  ', detail: 'x' }, { title: 'x', detail: '\n' }, { title: 'x'.repeat(501), detail: 'y' }]) {
      expect((await postJson(port, path, 'board-test-token', body)).status).toBe(400);
    }
    const before = api.countPendingActionRequiredIncludingReceipts();
    const created = await postJson(port, path, 'board-test-token', { title: 'Owner call', detail: 'Approve external merge' });
    expect(created).toMatchObject({ status: 201, body: { kind: 'gru.owner-escalation', routing: 'needs-owner', title: 'Owner call', ackedAt: null } });
    expect(api.countPendingActionRequiredIncludingReceipts()).toBe(before); // never loops into Gru's machine queue
    const row = created.body as { id: string };
    expect(api.getNotification(row.id)).toMatchObject({ detail: 'Approve external merge', shownAt: null });
    expect((await getJson(port, '/api/board', 'board-test-token')).body).toMatchObject({ unackedNeedsOwner: expect.any(Number) });
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

  it('owner cancellation endpoint: auth, malformed bodies, unlisted refusals and the audited idempotent success', async () => {
    const { api, port } = harness;
    const listed = 'gc-freeze-heat-evidence';
    const body = {
      expected_status: 'parked',
      authority_reference: 'j-1117 owner-close-seventeen-parked-20261006',
      reason: 'owner asked to move these away from parked',
    };
    expect((await postJson(port, `/api/jobs/${listed}/owner-cancellation`, null, body)).status).toBe(401);
    expect((await postJson(port, `/api/jobs/${listed}/owner-cancellation`, 'wrong-token', body)).status).toBe(401);
    for (const bad of [
      {},
      { ...body, expected_status: 'working' },
      { ...body, authority_reference: '' },
      { ...body, reason: '' },
    ]) {
      const response = await postJson(port, `/api/jobs/${listed}/owner-cancellation`, 'board-test-token', bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    const nullBody = await postJson(port, `/api/jobs/${listed}/owner-cancellation`, 'board-test-token', null);
    expect(nullBody.status).toBe(400);
    expect((await postJson(port, '/api/jobs/ghost/owner-cancellation', 'board-test-token', body)).status).toBe(404);

    // An unlisted parked job is refused with the typed code and no effect.
    api.addJob({ id: 'unlisted-cancel', repo: 'demo-repo', title: 'Unlisted' });
    api.setJobStatus('unlisted-cancel', 'working');
    api.setJobStatus('unlisted-cancel', 'parked');
    const unlisted = await postJson(port, '/api/jobs/unlisted-cancel/owner-cancellation', 'board-test-token', body);
    expect(unlisted.status).toBe(409);
    expect(unlisted.body).toMatchObject({ error: 'cancellation_refused', code: 'not-listed' });
    expect(api.getJob('unlisted-cancel')?.status).toBe('parked');

    // A listed parked legacy lane cancels in one audited, idempotent hop.
    api.addJob({ id: listed, repo: 'demo-repo', title: 'Listed legacy lane' });
    api.setJobStatus(listed, 'working');
    api.setJobStatus(listed, 'parked');
    const accepted = await postJson(port, `/api/jobs/${listed}/owner-cancellation`, 'board-test-token', body);
    expect(accepted.status).toBe(200);
    const acceptedBody = accepted.body as { job: { status: string }; event: { kind: string; seq: number }; idempotent: boolean };
    expect(acceptedBody.job.status).toBe('done');
    expect(acceptedBody.event.kind).toBe('job.owner-cancellation');
    expect(acceptedBody.idempotent).toBe(false);
    const replay = await postJson(port, `/api/jobs/${listed}/owner-cancellation`, 'board-test-token', body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotent: true, event: { seq: acceptedBody.event.seq }, job: { status: 'done' } });
    const settled = await postJson(port, `/api/jobs/${listed}/owner-cancellation`, 'board-test-token', { ...body, reason: 'a different reason' });
    expect(settled.status).toBe(409);
    expect(settled.body).toMatchObject({ error: 'cancellation_refused', code: 'already-closed' });
    const snapshot = (await getJson(port, '/api/board', 'board-test-token')).body as {
      repos: { jobs: { id: string; status: string; prState: string | null }[] }[];
    };
    const job = snapshot.repos.flatMap((repo) => repo.jobs).find((candidate) => candidate.id === listed);
    expect(job).toMatchObject({ status: 'done', prState: null });
  });

  it('owner cancellation endpoint passes the authoritative runtime probe: a ledger idle row with an open turn refuses', async () => {
    const local = await boot('cancel-probe-token', {
      closeoutRuntime: () => ({
        liveHandleIds: new Set<string>(),
        supervisionFor: (agentId: string) =>
          agentId === 'probe-idle-open'
            ? { state: 'watching', breakerOpen: false, openTurn: true, openControl: false, openToolCalls: 0 }
            : null,
      }),
    });
    try {
      const listed = 'silas-context-rotation';
      local.api.addJob({ id: listed, repo: 'demo-repo', title: 'Probe lane' });
      local.api.setJobStatus(listed, 'working');
      local.api.setJobStatus(listed, 'parked');
      local.api.registerAgent({ id: 'probe-idle-open', role: 'minion', jobId: listed });
      local.api.setAgentState('probe-idle-open', 'idle');
      const refused = await postJson(local.port, `/api/jobs/${listed}/owner-cancellation`, 'cancel-probe-token', {
        expected_status: 'parked',
        authority_reference: 'j-1117 owner-close-seventeen-parked-20261006',
        reason: 'owner asked',
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'cancellation_refused', code: 'live-work' });
      expect(local.api.getJob(listed)?.status).toBe('parked');
    } finally {
      await local.close();
    }
  });

  it('the main assembly wires the authoritative closeout runtime probe (assembly alarm)', () => {
    // The behavior has unit coverage but the production composition does
    // not: dropping this wiring would silently fall back to durable markers
    // only and no behavioral test would fail (same alarm pattern as the
    // supervisor-stop wiring pin).
    const mainSource = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    const start = mainSource.indexOf('closeoutRuntime:');
    expect(start, 'main.ts declares closeoutRuntime').toBeGreaterThanOrEqual(0);
    const block = mainSource.slice(start, start + 900);
    expect(block).toContain('registry.listHandles()');
    expect(block).toContain('supervisorLive.viewFor(agentId)');
    expect(block).toContain('openTurn');
    expect(block).toContain('openToolCalls');
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
        kind: 'supervision.breaker',
        routing: 'needs-owner',
        severity: 'error',
        title: 'Crash-loop breaker tripped: agent a1 stopped',
        detail: 'ack to re-arm',
        agentId: 'a1',
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
