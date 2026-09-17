import { mkdtempSync, rmSync } from 'node:fs';
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
import { TranscriptService } from '../src/transcripts/service.js';
import { loadConfig } from '../src/config.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-board-server-'));
  cleanupDirs.push(dir);
  return dir;
}

async function boot(token: string): Promise<{
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
  const board = createBoardServer({
    config: cfg,
    engine,
    ledger: api,
    transcripts: new TranscriptService(join(dir, 'sessions'), { ledger: api }),
    bus,
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
  return {
    port,
    api,
    bus,
    board,
    async close() {
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
    expect((round.body as { lenses: { lens: string }[] }).lenses.length).toBe(7);
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

  it('write endpoints reject bad bodies and missing entities', async () => {
    const badBody = await postJson(harness.port, '/api/jobs', 'board-test-token', { id: 'x' });
    expect(badBody.status).toBe(400);
    const missing = await postJson(harness.port, '/api/rounds', 'board-test-token', { jobId: 'ghost' });
    expect(missing.status).toBe(404);
    const unauth = await postJson(harness.port, '/api/jobs', null, { id: 'y', repo: 'r', title: 't' });
    expect(unauth.status).toBe(401);
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
});
