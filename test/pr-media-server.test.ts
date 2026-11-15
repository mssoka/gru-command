import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { PrMediaConfig } from '../src/config.js';
import { createMediaServer, MEDIA_MAX_BODY_BYTES, type MediaServerLedger } from '../src/media/server.js';
import { findMedia, mediaRoot, storeMedia } from '../src/media/store.js';
import { minimalPng } from './helpers/images.js';

/**
 * PR media HTTP surface: a capture binds only when the job's live lane sits
 * at exactly the named head with a clean tracked tree; the board reads the
 * bytes back with the token, hash re-verified, never with a store path.
 */

const TOKEN = 'media-test-token';
const HEAD = 'c'.repeat(40);
const dirs: string[] = [];
const dbs: LedgerDb[] = [];
const servers: Server[] = [];

interface Fixture {
  readonly base: string;
  readonly ledger: LedgerApi;
  readonly dataDir: string;
  readonly config: { value: PrMediaConfig };
  readonly lanes: { jobId: string; kind: string; path: string; status: string }[];
  readonly git: { sha: string | null; trackedDirty: boolean };
}

async function fixture(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'gru-pr-media-server-'));
  dirs.push(dataDir);
  const db = new LedgerDb(dataDir);
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  ledger.addJob({ id: 'j-ui', repo: 'widget-shop', title: 'Plain-language cards' });
  ledger.addJob({ id: 'j-other', repo: 'widget-shop', title: 'Another heist' });
  const lanes = [
    { jobId: 'j-ui', kind: 'job', path: '/lanes/j-ui', status: 'active' },
    { jobId: 'j-other', kind: 'job', path: '/lanes/j-other', status: 'active' },
  ];
  const git = { sha: HEAD as string | null, trackedDirty: false };
  const config = { value: { enabled: true, publish: 'autonomous' } as PrMediaConfig };
  const port: MediaServerLedger = {
    appendCustomEvent: (fields) => ledger.appendCustomEvent(fields),
    listJobEvents: (jobId, opts) => ledger.listJobEvents(jobId, opts),
    latestEventByPayloadField: (kind, field, value) => ledger.latestEventByPayloadField(kind, field, value),
    getJob: (id) => ledger.getJob(id),
    // Lanes are looked up per job, as the ledger does.
    listWorktrees: (opts) => lanes.filter((lane) => lane.jobId === opts?.jobId),
  };
  const media = createMediaServer({
    ledger: port,
    dataDir,
    token: TOKEN,
    config: () => config.value,
    gitState: (cwd) => {
      expect(cwd).toBe('/lanes/j-ui');
      return git;
    },
  });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!media.requestHook(req, res, path)) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, ledger, dataDir, config, lanes, git };
}

function submit(base: string, body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${base}/api/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function capture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: 'j-ui',
    head_sha: HEAD,
    caption: 'FOR YOU card with a typed decision',
    content_base64: minimalPng().toString('base64'),
    ...overrides,
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  while (dbs.length > 0) dbs.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('PR media HTTP surface', () => {
  it('stores a capture of the lane head and serves its exact bytes back to the board', async () => {
    const f = await fixture();
    const created = await submit(f.base, capture({ role: 'before' }));
    expect(created.status).toBe(201);
    const view = (await created.json()) as Record<string, unknown>;
    expect(view).toMatchObject({ job_id: 'j-ui', head_sha: HEAD, media_type: 'image/png', role: 'before', captured_by: 'minion' });
    expect(JSON.stringify(view)).not.toContain(f.dataDir); // no store path leaves the server
    const listed = await fetch(`${f.base}/api/media?job_id=j-ui`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(((await listed.json()) as { media: unknown[] }).media).toHaveLength(1);
    const bytes = await fetch(`${f.base}/api/media/${String(view['id'])}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get('content-type')).toBe('image/png');
    expect(bytes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(bytes.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await bytes.arrayBuffer()).equals(minimalPng())).toBe(true);
  });

  it('lists GC captures with their shot, the camera\'s latest run and the newest coverage, for the minion to read back', async () => {
    const f = await fixture();
    const runId = 'cr-55555555-5555-4555-8555-555555555555';
    const list = async (): Promise<Record<string, unknown>> =>
      (await (await fetch(`${f.base}/api/media?job_id=j-ui`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as Record<string, unknown>;
    expect(await list()).toEqual({ job_id: 'j-ui', media: [], camera: null, coverage: null });
    storeMedia({ dataDir: f.dataDir, ledger: f.ledger, jobId: 'j-ui', headSha: HEAD, caption: 'Filmed card', role: 'after', bytes: minimalPng(), capturedBy: 'gc', shot: { runId, shotId: 'card', viewport: 'desktop', files: 1 } });
    f.ledger.appendCustomEvent({ kind: 'media.capture-started', jobId: 'j-ui', payload: { run_id: runId, head_sha: HEAD, shot_list_sha256: 'a'.repeat(64), files: 1 } });
    f.ledger.appendCustomEvent({ kind: 'media.capture-failed', jobId: 'j-ui', payload: { run_id: runId, head_sha: HEAD, shot_list_sha256: 'a'.repeat(64), code: 'step_failed', detail: 'shot "card" step 2 failed' } });
    f.ledger.appendCustomEvent({ kind: 'media.coverage', jobId: 'j-ui', payload: { head_sha: HEAD, state: 'owed', touched: 2, paths: ['web/a.ts', 'web/b.ts'], globs: ['web/**'], skip: null, shot_list: 'valid', camera: 'failed', detail: 'shot "card" step 2 failed' } });
    const body = await list();
    expect(body['media']).toEqual([expect.objectContaining({ captured_by: 'gc', shot: { run_id: runId, shot_id: 'card', viewport: 'desktop' } })]);
    expect(body['camera']).toEqual({ state: 'failed', run_id: runId, head_sha: HEAD, shot_list_sha256: 'a'.repeat(64), code: 'step_failed', detail: 'shot "card" step 2 failed', at: expect.any(String) });
    expect(body['coverage']).toEqual({
      head_sha: HEAD, state: 'owed', touched: 2, paths: ['web/a.ts', 'web/b.ts'], globs: ['web/**'], skip: null,
      shot_list: 'valid', camera: 'failed', detail: 'shot "card" step 2 failed', recorded_at: expect.any(String),
    });
  });

  it('binds only at the lane head with a clean tracked tree, on a live lane', async () => {
    const f = await fixture();
    f.git.sha = 'd'.repeat(40);
    const moved = await submit(f.base, capture());
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ error: 'head_mismatch', lane_head: 'd'.repeat(40) });
    f.git.sha = HEAD;
    f.git.trackedDirty = true;
    expect(await (await submit(f.base, capture())).json()).toMatchObject({ error: 'dirty_tree' });
    f.git.trackedDirty = false;
    f.git.sha = null;
    expect(await (await submit(f.base, capture())).json()).toMatchObject({ error: 'lane_unreadable' });
    f.git.sha = HEAD;
    f.lanes.push({ jobId: 'j-ui', kind: 'job', path: '/lanes/j-ui-old', status: 'paused' });
    expect(await (await submit(f.base, capture())).json()).toMatchObject({ error: 'lane_ambiguous' });
    f.lanes.pop();
    f.lanes[0]!.status = 'swept';
    expect(await (await submit(f.base, capture())).json()).toMatchObject({ error: 'no_active_lane' });
    expect(await (await submit(f.base, capture({ job_id: 'j-missing' }))).json()).toMatchObject({ error: 'job_not_found' });
    expect(f.ledger.latestJobEvent('j-ui', 'media.captured')).toBeNull();
  });

  it('refuses malformed requests, unsupported types and oversized bodies by name', async () => {
    const f = await fixture();
    const error = async (response: Promise<Response>): Promise<string> => `${(await response).status}:${String(((await (await response).json()) as { error: string }).error)}`;
    expect(await error(submit(f.base, capture({ head_sha: 'abc' })))).toBe('400:bad_request');
    expect(await error(submit(f.base, capture({ head_sha: HEAD.toUpperCase() })))).toBe('400:bad_request');
    expect(await error(submit(f.base, capture({ content_base64: '%%%' })))).toBe('400:bad_request');
    expect(await error(submit(f.base, capture({ caption: '' })))).toBe('400:bad_request');
    expect(await error(submit(f.base, capture({ role: 'during' })))).toBe('400:bad_request');
    expect(await error(submit(f.base, capture({ content_base64: Buffer.from('<svg/>').toString('base64') })))).toBe('415:media_unsupported_type');
    expect(await error(submit(f.base, '[1]'))).toBe('400:bad_request');
    expect(await error(submit(f.base, 'x'.repeat(MEDIA_MAX_BODY_BYTES + 1)))).toBe('413:media_too_large');
  });

  it('requires the pairing token on every route and honors [pr_media] enabled = false on every route', async () => {
    const f = await fixture();
    const created = (await (await submit(f.base, capture())).json()) as { id: string };
    expect((await submit(f.base, capture(), 'wrong')).status).toBe(401);
    expect((await fetch(`${f.base}/api/media?job_id=j-ui`)).status).toBe(401);
    expect((await fetch(`${f.base}/api/media/${created.id}`)).status).toBe(401);
    f.config.value = { enabled: false, publish: 'autonomous' };
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    expect(await (await submit(f.base, capture())).json()).toMatchObject({ error: 'pr_media_disabled' });
    expect(await (await fetch(`${f.base}/api/media?job_id=j-ui`, auth)).json()).toMatchObject({ error: 'pr_media_disabled' });
    expect(await (await fetch(`${f.base}/api/media/${created.id}`, auth)).json()).toMatchObject({ error: 'pr_media_disabled' });
  });

  it('accepts a capture near the 10 MB cap sent as wrapped base64', async () => {
    const f = await fixture();
    const big = minimalPng(Buffer.alloc(9_900_000)); // an extra chunk-sized run of bytes inside a valid PNG
    const wrapped = big.toString('base64').replace(/.{76}/gu, '$&\n');
    const response = await submit(f.base, capture({ content_base64: wrapped }));
    expect(response.status).toBe(201);
    expect(((await response.json()) as { bytes: number }).bytes).toBe(big.length);
  });

  it('answers a missing capture 404 and an altered one 410, never the bytes', async () => {
    const f = await fixture();
    const created = (await (await submit(f.base, capture())).json()) as { id: string };
    const get = (id: string): Promise<Response> => fetch(`${f.base}/api/media/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await get('m-00000000-0000-0000-0000-000000000000')).status).toBe(404);
    // A malformed percent-escape is a named 404, never a 500.
    const malformed = await get('%E0%A4%A');
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toMatchObject({ error: 'media_not_found' });
    const item = findMedia(f.ledger, created.id)!;
    writeFileSync(join(mediaRoot(f.dataDir), item.file), Buffer.concat([minimalPng(), Buffer.from('tail')]));
    const altered = await get(created.id);
    expect(altered.status).toBe(410);
    expect(await altered.json()).toMatchObject({ error: 'media_altered' });
  });
});
