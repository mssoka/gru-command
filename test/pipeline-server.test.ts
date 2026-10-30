import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { requireArtifactJobId } from '../src/artifacts/context.js';
import { LedgerApi, requireSafeRecordId } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { loadConfig } from '../src/config.js';
import { PipelineService, type PipelineDispatchPort } from '../src/dispatch/pipeline.js';
import { createDispatchServer, type DispatchServer } from '../src/dispatch/server.js';

/**
 * Authenticated pipeline HTTP surface: enqueue receipts and replay
 * conflicts, readback, hold/clear/cancel mutations, and the not-hosted
 * 503. The scheduler/consumer itself is covered by its own suite.
 */

const TOKEN = 'pipeline-http-token';

const cleanup: { dirs: string[]; servers: HttpServer[]; hooks: DispatchServer[] } = { dirs: [], servers: [], hooks: [] };
afterEach(async () => {
  for (const hook of cleanup.hooks.splice(0)) hook.dispose();
  for (const server of cleanup.servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  while (cleanup.dirs.length > 0) rmSync(cleanup.dirs.pop()!, { recursive: true, force: true });
});

interface Harness {
  readonly base: string;
  readonly ledger: LedgerApi;
  readonly service: PipelineService;
  readonly calls: string[];
}

async function boot(opts: { hosted?: boolean; available?: number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-pipeline-server-'));
  cleanup.dirs.push(dir);
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  const config = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const calls: string[] = [];
  const port: PipelineDispatchPort = {
    async dispatch(input) {
      calls.push(input.jobId);
      ledger.addJob({ id: input.jobId, repo: 'demo', title: input.title, briefing: input.briefing });
      return { settled: Promise.resolve() };
    },
  };
  const service = new PipelineService({
    ledger,
    dispatch: port,
    capacity: () => ({ capacity: 4, occupied: 4 - (opts.available ?? 4), queued: 0, available: opts.available ?? 4 }),
    bus,
  });
  const hook = createDispatchServer({
    pendingProducerBlockers: () => [],
    config,
    dispatch: {} as never,
    wave: {} as never,
    ledger,
    ...(opts.hosted === false ? {} : { pipeline: service }),
  });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!hook.requestHook(req, res, path)) {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  cleanup.hooks.push(hook);
  cleanup.servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, ledger, service, calls };
}

async function api(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const ENQUEUE = {
  id: 'pipe-http-a',
  repo_path: '/tmp/demo',
  title: 'HTTP entry',
  briefing: 'Execute the HTTP entry',
};

describe('pipeline HTTP surface', () => {
  it('requires the bearer token', async () => {
    const h = await boot();
    expect((await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE, null)).status).toBe(401);
    expect((await api(h, 'GET', '/api/pipeline', undefined, 'wrong')).status).toBe(401);
  });

  it('returns a durable 201 receipt, replays as 200 duplicate, and 409s changed content', async () => {
    const h = await boot();
    const first = await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ entryId: 'pipe-http-a', state: 'waiting', duplicate: false, priority: 5 });
    expect(typeof first.body.enqueueSeq).toBe('number');
    await h.service.whenIdle();
    expect(h.calls).toEqual(['pipe-http-a']); // ample capacity: admitted by the receipt's trigger

    const replay = await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);

    const changed = await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, briefing: 'changed' });
    expect(changed.status).toBe(409);
    expect(h.ledger.getPipelineEntry('pipe-http-a')?.briefing).toBe('Execute the HTTP entry');
  });

  it('reads the full briefing only on the single-entry readback; the list stays compact', async () => {
    const h = await boot({ available: 0 });
    await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    const list = await api(h, 'GET', '/api/pipeline');
    expect(list.status).toBe(200);
    expect(list.body.pending).toBe(1);
    const rows = list.body.entries as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ id: 'pipe-http-a', state: 'ready', priority: 5 });
    expect(rows[0]).not.toHaveProperty('briefing');
    expect(String(rows[0]?.reason)).toContain('resident worker slot');

    const entry = await api(h, 'GET', '/api/pipeline/entries/pipe-http-a');
    expect(entry.status).toBe(200);
    expect((entry.body.entry as Record<string, unknown>).briefing).toBe('Execute the HTTP entry');
    expect(entry.body.live_state).toBe('ready');
    expect((await api(h, 'GET', '/api/pipeline/entries/pipe-ghost')).status).toBe(404);
  });

  it('holds, releases and cancels through explicit authenticated mutations', async () => {
    const h = await boot({ available: 0 });
    await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    const held = await api(h, 'POST', '/api/pipeline/entries/pipe-http-a/hold', { reason: 'owner deciding', by: 'owner' });
    expect(held.status).toBe(200);
    const waiting = await api(h, 'GET', '/api/pipeline');
    expect((waiting.body.entries as Record<string, unknown>[])[0]).toMatchObject({
      state: 'waiting',
      reason: 'owner hold: owner deciding',
    });
    await api(h, 'POST', '/api/pipeline/entries/pipe-http-a/clear-hold', { reason: 'approved' });
    const released = await api(h, 'GET', '/api/pipeline');
    expect((released.body.entries as Record<string, unknown>[])[0]).toMatchObject({ state: 'ready' });
    const cancelled = await api(h, 'POST', '/api/pipeline/entries/pipe-http-a/cancel', { reason: 'withdrawn' });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { state?: string }).state).toBe('cancelled');
    const after = await api(h, 'GET', '/api/pipeline');
    expect(after.body.pending).toBe(0);
  });

  it('rejects a malformed hold_reason outright — never a silently unheld executable entry', async () => {
    const h = await boot({ available: 0 });
    const numeric = await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, hold_reason: 123 });
    expect(numeric.status).toBe(400);
    expect(String(numeric.body.detail)).toContain('hold_reason must be a string');
    const boolean = await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, hold_reason: true });
    expect(boolean.status).toBe(400);
    // No durable side effect at all: nothing was accepted or executed.
    expect(h.ledger.getPipelineEntry('pipe-http-a')).toBeNull();
    expect(h.calls).toHaveLength(0);
    const list = await api(h, 'GET', '/api/pipeline');
    expect(list.body.pending).toBe(0);
  });

  it('validates priority and prerequisite milestones at the boundary', async () => {
    const h = await boot();
    expect((await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, priority: 99 })).status).toBe(400);
    expect(
      (
        await api(h, 'POST', '/api/pipeline/enqueue', {
          ...ENQUEUE,
          prerequisites: [{ id: 'other', milestone: 'whenever' }],
        })
      ).status,
    ).toBe(400);
  });

  it('refuses cancellation while an admission claim is live', async () => {
    const h = await boot({ available: 0 });
    await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    expect(h.ledger.claimPipelineEntry({ id: 'pipe-http-a', holder: 'silas-pipeline' })?.state).toBe('admitting');
    const refused = await api(h, 'POST', '/api/pipeline/entries/pipe-http-a/cancel', { reason: 'too late' });
    expect(refused.status).toBe(400);
    expect(String(refused.body.detail)).toContain('live admission claim');
  });

  it('never cancels a terminally failed entry over its durable failure record', async () => {
    const h = await boot({ available: 0 });
    await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    h.ledger.claimPipelineEntry({ id: 'pipe-http-a', holder: 'silas-pipeline' });
    h.ledger.releasePipelineClaim({
      id: 'pipe-http-a',
      reason: 'admission failed: spawn broken',
      outcome: 'failed',
    });
    const refused = await api(h, 'POST', '/api/pipeline/entries/pipe-http-a/cancel', { reason: 'clean up' });
    expect(refused.status).toBe(400);
    expect(String(refused.body.detail)).toContain('already failed terminally');
    // The failure record survives verbatim for downstream diagnosis.
    expect(h.ledger.getPipelineEntry('pipe-http-a')?.state).toBe('failed');
    expect(h.ledger.getPipelineEntry('pipe-http-a')?.failureReason).toBe('admission failed: spawn broken');
  });

  it('keeps a lone terminal failure visible as attention but NOT as pending queued work', async () => {
    const h = await boot({ available: 0 });
    await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    h.ledger.claimPipelineEntry({ id: 'pipe-http-a', holder: 'silas-pipeline' });
    h.ledger.releasePipelineClaim({ id: 'pipe-http-a', reason: 'admission failed: boom', outcome: 'failed' });
    const list = await api(h, 'GET', '/api/pipeline');
    const rows = list.body.entries as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ id: 'pipe-http-a', state: 'failed' });
    expect(String(rows[0]?.reason)).toContain('admission failed: boom');
    expect(list.body.pending).toBe(0);
  });

  it('returns the ACCEPTANCE receipt on replay — live drift never mutates it', async () => {
    const h = await boot({ available: 0 });
    const first = await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    expect(first.status).toBe(201);
    // Live state drifts: an owner hold lands after acceptance.
    await api(h, 'POST', '/api/pipeline/entries/pipe-http-a/hold', { reason: 'owner deciding' });
    const live = await api(h, 'GET', '/api/pipeline/entries/pipe-http-a');
    expect(live.body.live_state).toBe('waiting');
    // The replay still returns the acceptance-time receipt: state waiting,
    // not held — the frozen "same receipt except duplicate:true" matrix.
    const replay = await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      entryId: 'pipe-http-a',
      state: 'waiting',
      held: false,
      duplicate: true,
      enqueueSeq: first.body.enqueueSeq,
      queuedAt: first.body.queuedAt,
    });
    // The live row keeps its honest current state.
    expect(h.ledger.getPipelineEntry('pipe-http-a')?.holdReason).toBe('owner deciding');
  });

  it('posts the enqueue fields docs/PIPELINE.md and roles/gru.md document, and the route reads every one', async () => {
    const root = join(import.meta.dirname, '..');
    const doc = readFileSync(join(root, 'docs', 'PIPELINE.md'), 'utf-8');
    const table = doc.slice(doc.indexOf('### Enqueue'), doc.indexOf('### Reading'));
    const documented = [...table.matchAll(/^\| `([a-z_]+)` \|/gmu)].map((match) => match[1]);
    const body: Record<string, unknown> = {
      id: 'doc-a',
      repo_path: '/tmp/demo',
      title: 'Documented entry',
      briefing: 'Execute the documented entry',
      request_id: 'doc-req',
      priority: 2,
      prerequisites: [{ id: 'doc-dep', milestone: 'done' }],
      exclusive_scopes: ['doc-scope'],
      hold_reason: 'doc hold',
      by: 'gru',
    };
    // A field added to or dropped from the documented table fails here, so the
    // body below always matches the doc.
    expect([...documented].sort()).toEqual(Object.keys(body).sort());
    // The role names the same fields (its sentence is what Gru copies).
    const role = readFileSync(join(root, 'roles', 'gru.md'), 'utf-8').replace(/\s+/gu, ' ');
    expect(role).toContain('`{ "id", "repo_path", "title", "briefing" }`');
    for (const optional of ['priority', 'prerequisites', 'exclusive_scopes', 'hold_reason', 'request_id']) {
      expect(role).toContain(`\`${optional}\``);
    }
    expect(role).toContain('`"by": "gru"`');

    const h = await boot({ available: 0 });
    const accepted = await api(h, 'POST', '/api/pipeline/enqueue', body);
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ entryId: 'doc-a', requestId: 'doc-req', priority: 2, held: true, state: 'waiting' });
    expect(h.ledger.getPipelineEntry('doc-a')).toMatchObject({
      repoPath: '/tmp/demo',
      title: 'Documented entry',
      briefing: 'Execute the documented entry',
      requestId: 'doc-req',
      priority: 2,
      prerequisites: [{ id: 'doc-dep', milestone: 'done' }],
      exclusiveScopes: ['doc-scope'],
      holdReason: 'doc hold',
    });
    // The documented readback shape: the stored record plus the live view.
    const read = await api(h, 'GET', '/api/pipeline/entries/doc-a');
    expect(Object.keys(read.body).sort()).toEqual(['entry', 'live_reason', 'live_state']);
    expect(read.body.live_reason).toBe('owner hold: doc hold');
  });

  it('answers the refusals docs/PIPELINE.md documents: unknown ids, self and cyclic prerequisites, request reuse, burned ids', async () => {
    const h = await boot({ available: 0 });
    // An unknown entry is a 404 on the read and a 400 on the three mutations.
    expect((await api(h, 'GET', '/api/pipeline/entries/doc-ghost')).status).toBe(404);
    for (const action of ['hold', 'clear-hold', 'cancel']) {
      const refused = await api(h, 'POST', `/api/pipeline/entries/doc-ghost/${action}`, { reason: 'r' });
      expect(refused.status, action).toBe(400);
      expect(String(refused.body.detail), action).toContain('not found');
    }
    // A self prerequisite is a 400; a cycle is a 409.
    const self = await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, id: 'doc-self', prerequisites: [{ id: 'doc-self', milestone: 'done' }] });
    expect(self.status).toBe(400);
    const first = await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, id: 'doc-x', prerequisites: [{ id: 'doc-y', milestone: 'done' }] });
    expect(first.status).toBe(201);
    const cyclic = await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, id: 'doc-y', prerequisites: [{ id: 'doc-x', milestone: 'done' }] });
    expect(cyclic.status).toBe(409);
    // A dependency on a job dispatched outside the pipeline is accepted and waits as "not enqueued".
    const outside = await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, id: 'doc-out', prerequisites: [{ id: 'job-outside', milestone: 'done' }] });
    expect(outside.status).toBe(201);
    const list = await api(h, 'GET', '/api/pipeline');
    const outsideRow = (list.body.entries as Record<string, unknown>[]).find((row) => row.id === 'doc-out');
    expect(outsideRow).toMatchObject({ state: 'waiting', reason: 'waiting for job-outside — not enqueued' });
    // A correction under a new id but the old explicit request id is a 409, and a
    // cancelled entry's id stays reserved.
    await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, id: 'doc-r1', request_id: 'doc-request' });
    const reused = await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, id: 'doc-r2', request_id: 'doc-request' });
    expect(reused.status).toBe(409);
    expect((await api(h, 'POST', '/api/pipeline/entries/doc-r1/cancel', { reason: 'withdrawn' })).status).toBe(200);
    const burned = await api(h, 'POST', '/api/pipeline/enqueue', { ...ENQUEUE, id: 'doc-r1', request_id: 'doc-again' });
    expect(burned.status).toBe(409);
    // Enqueue accepts an uppercase id that admission refuses (docs/PIPELINE.md "Enqueue"
    // and "Admission"): when one of the two rules changes, the doc and the role change with it.
    expect(() => requireSafeRecordId('Fix-Login', 'pipeline entry id')).not.toThrow();
    expect(() => requireArtifactJobId('Fix-Login')).toThrow();
    expect(() => requireArtifactJobId('fix-login')).not.toThrow();
  });

  it('answers 503 when the pipeline surface is not hosted', async () => {
    const h = await boot({ hosted: false });
    const response = await api(h, 'POST', '/api/pipeline/enqueue', ENQUEUE);
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('pipeline_not_hosted');
  });
});

describe('pipeline production wiring contract', () => {
  // The focused suites inject fake pipeline services; a dropped production
  // injection would leave them green while the real queue went dark. This
  // source-contract pins the exact main-assembly seams (review finding:
  // production hosting/wiring is untested).
  it('main.ts constructs the real PipelineService against the shared registry budget', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf-8');
    expect(main).toContain('new PipelineService({');
    // The dispatch server hosts the real service instance.
    expect(main).toMatch(/pipeline(?:\s*=|\s*,)/u);
    // The board engine reads the same service's view (server-computed
    // pipeline block), never a browser-side re-derivation.
    expect(main).toContain('pipeline: () => pipelineView()');
    // Demand registration with the SHARED budget (D1): the consumer's
    // capacity-blocked acquire drives the budget's own idle-minion reclaim.
    expect(main).toContain('registry.residents.acquire(1, signal)');
    // The ACTUAL permit release (post-disposed-envelope) re-arms the
    // consumer even after a wake refusal (Perkins r3 blocker 4).
    expect(main).toContain('registry.onResidentReleased(() => pipeline?.schedule())');
  });
});
