import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createService } from '../src/server.js';
import { createStaticRoot } from '../src/static.js';
import { configPathFor, loadConfig } from '../src/config.js';
import { loadOrCreateIdentity } from '../src/identity.js';

/**
 * Production static-serving (E4): the built web UI rides the same port as
 * the chat socket. Unit legs exercise the root directly; the integration
 * legs prove the hook composes inside the real service (health intact,
 * JSON 404 for what the root doesn't hold).
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-static-'));
  cleanupDirs.push(dir);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>gru</title>\n');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("bundled");\n');
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  return dir;
}

interface FakeRes {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly state: { status: number | null; headers: Record<string, unknown> };
  body(): string;
}

function fakeReqRes(method: string): FakeRes {
  const req = { method } as IncomingMessage;
  const state = { status: null as number | null, headers: {} as Record<string, unknown> };
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  }) as ServerResponse;
  res.writeHead = ((status: number, headers?: Record<string, unknown>) => {
    state.status = status;
    state.headers = headers ?? {};
    return res;
  }) as ServerResponse['writeHead'];
  return { req, res, state, body: () => Buffer.concat(chunks).toString('utf-8') };
}

describe('createStaticRoot', () => {
  it('serves index.html at / with no-cache and the html mime', async () => {
    const root = createStaticRoot(makeDist());
    const { req, res, state, body } = fakeReqRes('GET');
    expect(root.serve(req, res, '/')).toBe(true);
    expect(state.status).toBe(200);
    expect(state.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(state.headers['cache-control']).toBe('no-cache');
    await new Promise((resolve) => res.once('finish', resolve)); // pipe completes
    expect(body()).toContain('<title>gru</title>');
  });

  it('serves hashed assets immutable with the right mime', () => {
    const root = createStaticRoot(makeDist());
    const { req, res, state } = fakeReqRes('GET');
    expect(root.serve(req, res, '/assets/index-abc123.js')).toBe(true);
    expect(state.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(state.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers HEAD with headers only', () => {
    const root = createStaticRoot(makeDist());
    const { req, res, state, body } = fakeReqRes('HEAD');
    expect(root.serve(req, res, '/favicon.svg')).toBe(true);
    expect(state.status).toBe(200);
    expect(state.headers['content-type']).toBe('image/svg+xml');
    expect(body()).toBe('');
  });

  it('rejects traversal, encoded traversal, directories, and missing files', () => {
    const dir = makeDist();
    const root = createStaticRoot(dir);
    for (const path of [
      '/../package.json',
      '/%2e%2e%2fpackage.json',
      '/%2E%2E/assets/index-abc123.js',
      '/assets',
      '/nope.js',
      '/assets/../../outside.txt',
    ]) {
      const { req, res, state } = fakeReqRes('GET');
      expect(root.serve(req, res, path), `path ${path} must not serve`).toBe(false);
      expect(state.status).toBeNull();
    }
  });

  it('falls through for non-GET methods and a missing root', () => {
    const root = createStaticRoot(makeDist());
    const posted = fakeReqRes('POST');
    expect(root.serve(posted.req, posted.res, '/')).toBe(false);
    const missing = createStaticRoot(join(makeDist(), 'does-not-exist'));
    const { req, res } = fakeReqRes('GET');
    expect(missing.serve(req, res, '/')).toBe(false);
  });
});

describe('static root inside the real service', () => {
  it('serves the UI, keeps /health intact, and 404s what the root does not hold', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-e4-home-'));
    cleanupDirs.push(home);
    // Ephemeral port per test: a fixed port shares the fetch keep-alive
    // pool across servers and resets the next test's first request.
    writeFileSync(configPathFor(home), '[server]\nport = 0\n', 'utf-8');
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const identity = loadOrCreateIdentity(config.dataDir);
    const service = createService(config, identity, () => {}, () => null, {
      staticRoot: createStaticRoot(makeDist()),
    });
    const handle = await service.start();
    const base = `http://127.0.0.1:${handle.port}`;
    try {
      const index = await fetch(`${base}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await index.text()).toContain('<title>gru</title>');

      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as Record<string, unknown>;
      expect(healthBody['service']).toBe('gru-command');

      const missing = await fetch(`${base}/no-such-file.js`);
      expect(missing.status).toBe(404);
      const missingBody = (await missing.json()) as Record<string, unknown>;
      expect(missingBody['error']).toBe('not_found');
    } finally {
      await handle.stop();
    }
  });

  it('without a static root the service keeps the pre-E4 JSON 404 at /', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-e4-home-'));
    cleanupDirs.push(home);
    writeFileSync(configPathFor(home), '[server]\nport = 0\n', 'utf-8');
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const identity = loadOrCreateIdentity(config.dataDir);
    const service = createService(config, identity);
    const handle = await service.start();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['error']).toBe('not_found');
    } finally {
      await handle.stop();
    }
  });
});
