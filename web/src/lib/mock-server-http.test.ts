import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

const TOKEN = 'configured-mock-test-token';
const cleanupDirs: string[] = [];
const children: ChildProcess[] = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('missing test server address');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startMock(): Promise<{ baseUrl: string }> {
  const port = await availablePort();
  const entry = fileURLToPath(new URL('../../mock/server.ts', import.meta.url));
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GRU_MOCK_HOST: '127.0.0.1',
      GRU_MOCK_PORT: String(port),
      GRU_MOCK_TOKEN: TOKEN,
      GRU_MOCK_TEST_MAX_UPLOAD_BYTES: '16',
      GRU_MOCK_TEST_MAX_UPLOAD_FILES: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf-8');
  child.stderr!.setEncoding('utf-8');
  child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`mock startup timed out\n${stdout}\n${stderr}`)), 10_000);
    const poll = setInterval(() => {
      if (stdout.includes('listening on')) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 10);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      reject(new Error(`mock exited during startup (${String(code)})\n${stdout}\n${stderr}`));
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function upload(baseUrl: string, filename: string, bytes: Uint8Array): Promise<Response> {
  return fetch(`${baseUrl}/api/attach/uploads`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ filename, content_base64: Buffer.from(bytes).toString('base64') }),
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function postControl(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

interface MockSocket {
  readonly socket: WebSocket;
  readonly frames: Array<Record<string, unknown>>;
}

async function openAuthedSocket(baseUrl: string): Promise<MockSocket> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  const frames: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  await waitFor(() => frames.some((frame) => frame.type === 'auth_ok'));
  return { socket, frames };
}

function isTurnFrame(frame: Record<string, unknown>): boolean {
  return frame.type === 'turn' || frame.type === 'tool' || frame.type === 'delta';
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    // A signal death leaves exitCode null (r2 W6): treat signalCode as a
    // settled exit too, and bound every wait so teardown cannot hang on
    // an event that already fired or a child that refuses to die.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dev mock upload endpoint hardening', () => {
  it('materializes safely and pins raw/decoded caps, quota, UTF-8 names, and collisions', async () => {
    const { baseUrl } = await startMock();

    const rawTooLarge = await fetch(`${baseUrl}/api/attach/uploads`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: 'x'.repeat(5_000),
    });
    expect(rawTooLarge.status).toBe(413);
    expect(await rawTooLarge.text()).toContain('request body exceeds mock upload limit');

    const decodedTooLarge = await upload(baseUrl, 'decoded.bin', new Uint8Array(17));
    expect(decodedTooLarge.status).toBe(413);
    expect(await decodedTooLarge.text()).toContain('upload exceeds 16 byte mock limit');

    const longName = `${'界'.repeat(100)}.txt`;
    const firstResponse = await upload(baseUrl, longName, new TextEncoder().encode('first'));
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as { path: string; name: string; bytes: number };
    cleanupDirs.push(dirname(first.path));
    expect(Buffer.byteLength(first.name)).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(basename(first.path))).toBeLessThanOrEqual(255);
    expect(readFileSync(first.path, 'utf-8')).toBe('first');

    const secondResponse = await upload(baseUrl, longName, new TextEncoder().encode('second'));
    expect(secondResponse.status).toBe(201);
    const second = await secondResponse.json() as { path: string; name: string; bytes: number };
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(first.path, 'utf-8')).toBe('first');
    expect(readFileSync(second.path, 'utf-8')).toBe('second');

    const quotaResponse = await upload(baseUrl, 'third.txt', new TextEncoder().encode('third'));
    expect(quotaResponse.status).toBe(507);
    expect(await quotaResponse.text()).toContain('mock upload quota exceeded');

    // Both rejected size requests and the rejected quota request leave no file.
    expect(readdirSync(dirname(first.path))).toHaveLength(2);
  }, 30_000);
});

describe('dev mock reset settles the previous turn before rewinding the log', () => {
  it('never replays orphan turn frames from a parked held turn after /__reset', async () => {
    const { baseUrl } = await startMock();
    const first = await openAuthedSocket(baseUrl);
    await postControl(baseUrl, '/__turn-hold');
    first.socket.send(
      JSON.stringify({ type: 'user', text: 'reset probe', client_msg_id: 'm1', epoch: 0 }),
    );
    // The full scripted reply streams first (final 🪐 token), then the hold
    // parks the turn on the next tick without a terminal turn frame.
    await waitFor(() =>
      first.frames.some((frame) => frame.type === 'delta' && String(frame.text).includes('🪐')),
    );
    await sleep(150);
    expect(first.frames.some((frame) => frame.type === 'turn' && frame.state === 'end')).toBe(false);

    const reset = await postControl(baseUrl, '/__reset');
    expect(reset.ok).toBe(true);
    // The terminated socket's close handler settles the parked turn after
    // the reset returns; the rewind must not leave its frames behind.
    await sleep(250);

    const replay = await openAuthedSocket(baseUrl);
    await sleep(150);
    expect(replay.frames.filter(isTurnFrame)).toEqual([]);
    first.socket.terminate();
    replay.socket.terminate();
  }, 30_000);

  it('drops an in-flight streaming turn at /__reset with no replayed frames', async () => {
    const { baseUrl } = await startMock();
    const first = await openAuthedSocket(baseUrl);
    first.socket.send(
      JSON.stringify({ type: 'user', text: 'mid-stream probe', client_msg_id: 'm1', epoch: 0 }),
    );
    await waitFor(() => first.frames.some((frame) => frame.type === 'delta'));
    expect(first.frames.some((frame) => frame.type === 'turn' && frame.state === 'end')).toBe(false);

    const reset = await postControl(baseUrl, '/__reset');
    expect(reset.ok).toBe(true);
    // The interval/close settle fires after the reset returns.
    await sleep(250);

    const replay = await openAuthedSocket(baseUrl);
    await sleep(150);
    expect(replay.frames.filter(isTurnFrame)).toEqual([]);
    first.socket.terminate();
    replay.socket.terminate();
  }, 30_000);

  it('drops a queued (deferred) user frame with a parked turn at /__reset — no ghost reply', async () => {
    const { baseUrl } = await startMock();
    const first = await openAuthedSocket(baseUrl);
    await postControl(baseUrl, '/__turn-hold');
    first.socket.send(
      JSON.stringify({ type: 'user', text: 'parked probe', client_msg_id: 'd1', epoch: 0 }),
    );
    // Run the stream to exhaustion so the turn is genuinely parked, then
    // queue a SECOND user frame: it defers (one scripted turn at a time).
    await waitFor(() =>
      first.frames.some((frame) => frame.type === 'delta' && String(frame.text).includes('🪐')),
    );
    await sleep(150);
    expect(first.frames.some((frame) => frame.type === 'turn' && frame.state === 'end')).toBe(false);
    first.socket.send(
      JSON.stringify({ type: 'user', text: 'queued while parked', client_msg_id: 'd2', epoch: 0 }),
    );
    await sleep(200);

    const reset = await postControl(baseUrl, '/__reset');
    expect(reset.ok).toBe(true);
    // Any drained queued reply would have streamed + settled by now; the
    // rewind must not leave its frames behind (ghost frames for replay).
    await sleep(800);

    const replay = await openAuthedSocket(baseUrl);
    await sleep(300);
    expect(replay.frames.filter(isTurnFrame)).toEqual([]);
    first.socket.terminate();
    replay.socket.terminate();
  }, 30_000);
});
