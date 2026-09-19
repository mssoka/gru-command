import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
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
