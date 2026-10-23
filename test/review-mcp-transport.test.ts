import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERKINS_MCP_SERVER_SHA256, ReviewMcpBridge } from '../src/runtime/review-mcp-bridge.js';
import type { NativeAgentTool } from '../src/runtime/types.js';
import { REVIEW_TOOL_RESULT_MAX_CHARS } from '../src/runtime/review-tool-limits.js';

/**
 * Stage 1 transport survival: a bounded wait that ends without a result
 * reports still-running and RE-ATTACHES to the same live execution instead
 * of cancelling or duplicating it. These tests never spend a real wait: the
 * bridge tests drive raw sockets with a gated tool, and the server test
 * spawns the bundled review MCP server with its documented deterministic
 * wait seam.
 */

const temporaryDirectories: string[] = [];
const servers: ChildProcessWithoutNullStreams[] = [];
const bridges: ReviewMcpBridge[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await new Promise<void>((resolve) => server.once('exit', () => resolve()));
    }
  }
  while (bridges.length > 0) await bridges.pop()!.close();
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

interface BridgeCallResponse {
  readonly ok: boolean;
  readonly result?: { readonly text: string; readonly details?: Record<string, unknown> };
  readonly error?: string;
}

function callBridge(
  socketPath: string,
  request: { readonly id: string; readonly name: string; readonly input?: unknown },
): { readonly promise: Promise<BridgeCallResponse>; readonly socket: Socket } {
  const socket = createConnection(socketPath);
  const promise = new Promise<BridgeCallResponse>((resolve, reject) => {
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => { body += chunk; });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        resolve(JSON.parse(body) as BridgeCallResponse);
      } catch (error) {
        reject(error as Error);
      }
    });
  });
  return { promise, socket };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

const BRIDGE_SERVER_MODULE = fileURLToPath(new URL('../src/runtime/review-mcp-server.mjs', import.meta.url));

/** Minimal JSON-RPC stdio client for the bundled review MCP server. */
function serverClient(child: ChildProcessWithoutNullStreams): {
  readonly call: (id: number, method: string, params?: unknown) => Promise<Record<string, unknown>>;
} {
  let buffered = '';
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message['id'];
      if (typeof id === 'number' && waiters.has(id)) {
        waiters.get(id)!(message);
        waiters.delete(id);
      }
    }
  });
  return {
    call: (id, method, params) => {
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server response timed out: ${method}`)), 5_000);
        waiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    },
  };
}

function spawnServer(socketPath: string, env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [BRIDGE_SERVER_MODULE], {
    env: { PATH: process.env.PATH ?? '', GRU_REVIEW_BRIDGE_SOCKET: socketPath, ...env },
  });
  servers.push(child);
  return child;
}

describe('review MCP bridge: join, retention and explicit abort', () => {
  it('joins an identical in-flight request (any key order) and executes the tool exactly once', async () => {
    let executions = 0;
    const gate = deferred();
    const tool: NativeAgentTool = {
      name: 'perkins_probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      execute: async () => {
        executions += 1;
        await gate.promise;
        return { text: 'wave-results', details: { resultCount: 2 } };
      },
    };
    const bridge = await ReviewMcpBridge.start([tool]);
    bridges.push(bridge);
    const request = { name: 'perkins_probe', input: { runs: [{ lens: 'blind' }, { lens: 'edge' }], scope: 'whole' } };
    const first = callBridge(bridge.socketPath, { id: 'first', ...request });
    void first.promise.catch(() => {});
    await vi.waitFor(() => expect(executions).toBe(1));
    // The server-side transport wait ended: its socket is gone, the work is not.
    first.socket.destroy();
    const second = callBridge(bridge.socketPath, {
      id: 'second',
      name: request.name,
      // Same request, different key order: canonical identity must join it.
      input: { scope: 'whole', runs: [{ lens: 'blind' }, { lens: 'edge' }] },
    });
    gate.resolve();
    await expect(second.promise).resolves.toMatchObject({
      ok: true, result: { text: 'wave-results', details: { resultCount: 2 } },
    });
    expect(executions).toBe(1);
    // A repeat AFTER settlement returns the retained success — no new work.
    await expect(callBridge(bridge.socketPath, { id: 'third', ...request }).promise)
      .resolves.toMatchObject({ ok: true, result: { text: 'wave-results' } });
    expect(executions).toBe(1);
    // A different request is different work.
    await expect(callBridge(bridge.socketPath, { id: 'fourth', name: 'perkins_probe', input: { other: true } }).promise)
      .resolves.toMatchObject({ ok: true, result: { text: 'wave-results' } });
    expect(executions).toBe(2);
  });

  it('never serves a settled failure from cache: an identical repeat executes for real', async () => {
    let executions = 0;
    const tool: NativeAgentTool = {
      name: 'perkins_probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      execute: async () => {
        executions += 1;
        if (executions === 1) throw new Error('specialist child died');
        return { text: 'recovered' };
      },
    };
    const bridge = await ReviewMcpBridge.start([tool]);
    bridges.push(bridge);
    await expect(callBridge(bridge.socketPath, { id: 'a', name: 'perkins_probe', input: {} }).promise)
      .resolves.toMatchObject({ ok: false, error: 'specialist child died' });
    await expect(callBridge(bridge.socketPath, { id: 'b', name: 'perkins_probe', input: {} }).promise)
      .resolves.toMatchObject({ ok: true, result: { text: 'recovered' } });
    expect(executions).toBe(2);
  });

  it('evicts by settlement age: a long-held wave that settles last is still re-attachable after pressure (#174)', async () => {
    const executions = new Map<string, number>();
    const gate = deferred();
    // Default retention (16 MiB): four 5 MiB successes cannot all fit.
    const big = 'x'.repeat(5 * 1024 * 1024);
    const tool: NativeAgentTool = {
      name: 'perkins_probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      execute: async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        const label = String(input['label']);
        executions.set(label, (executions.get(label) ?? 0) + 1);
        if (label === 'wave') await gate.promise;
        return { text: `${label}:${big}`, details: { label } };
      },
    };
    const bridge = await ReviewMcpBridge.start([tool]);
    bridges.push(bridge);
    const call = (id: string, label: string) =>
      callBridge(bridge.socketPath, { id, name: 'perkins_probe', input: { label } });
    const wave = call('wave-1', 'wave');
    void wave.promise.catch(() => {});
    await vi.waitFor(() => expect(executions.get('wave')).toBe(1));
    // Later-started successes settle first and fill the byte budget.
    for (const label of ['a', 'b', 'c']) {
      await expect(call(`${label}-1`, label).promise).resolves.toMatchObject({ ok: true });
    }
    // The held-open wave settles LAST (the transport wait ended: socket gone).
    wave.socket.destroy();
    const joined = call('wave-2', 'wave');
    gate.resolve();
    await expect(joined.promise).resolves.toMatchObject({ ok: true, result: { details: { label: 'wave' } } });
    // The oldest-SETTLED entries were evicted, not the just-settled wave.
    const reattach = await call('wave-3', 'wave').promise;
    expect(reattach).toMatchObject({ ok: true, result: { details: { label: 'wave' } } });
    expect(reattach.result?.text.startsWith('wave:')).toBe(true);
    expect(executions.get('wave')).toBe(1);
    // Pressure really evicted older settled successes: 'a' runs again.
    await expect(call('a-2', 'a').promise).resolves.toMatchObject({ ok: true });
    expect(executions.get('a')).toBe(2);
  });

  it('bounds zero-text successes by entry count and evicts the oldest settled first (#174)', async () => {
    const executions = new Map<number, number>();
    const tool: NativeAgentTool = {
      name: 'perkins_probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      execute: async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        const n = Number(input['n']);
        executions.set(n, (executions.get(n) ?? 0) + 1);
        return { text: '' };
      },
    };
    const bridge = await ReviewMcpBridge.start([tool], { retention: { maxBytes: 1024 * 1024, maxEntries: 3 } });
    bridges.push(bridge);
    const call = (id: string, n: number) =>
      callBridge(bridge.socketPath, { id, name: 'perkins_probe', input: { n } }).promise;
    for (const n of [1, 2, 3, 4]) await expect(call(`first-${n}`, n)).resolves.toMatchObject({ ok: true });
    // Entry 1 (settled longest ago) was evicted; 2..4 re-attach without work.
    for (const n of [2, 3, 4]) await expect(call(`again-${n}`, n)).resolves.toMatchObject({ ok: true });
    expect([2, 3, 4].map((n) => executions.get(n))).toEqual([1, 1, 1]);
    await expect(call('again-1', 1)).resolves.toMatchObject({ ok: true });
    expect(executions.get(1)).toBe(2);
  });

  it('charges structured details and request keys against the byte budget (#174)', async () => {
    const executions = new Map<string, number>();
    const tool: NativeAgentTool = {
      name: 'perkins_probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      execute: async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        const label = String(input['label']);
        executions.set(label, (executions.get(label) ?? 0) + 1);
        // Empty text: only the structured details carry weight.
        return { text: '', details: { payload: 'd'.repeat(2_000) } };
      },
    };
    const bridge = await ReviewMcpBridge.start([tool], { retention: { maxBytes: 5_000, maxEntries: 100 } });
    bridges.push(bridge);
    const call = (id: string, label: string) =>
      callBridge(bridge.socketPath, { id, name: 'perkins_probe', input: { label } }).promise;
    for (const label of ['a', 'b', 'c']) await expect(call(`first-${label}`, label)).resolves.toMatchObject({ ok: true });
    // Three ~2.3 KB entries exceed 5 KB: the oldest ('a') was evicted, the rest retained.
    for (const label of ['b', 'c']) await expect(call(`again-${label}`, label)).resolves.toMatchObject({ ok: true });
    expect([executions.get('b'), executions.get('c')]).toEqual([1, 1]);
    await expect(call('again-a', 'a')).resolves.toMatchObject({ ok: true });
    expect(executions.get('a')).toBe(2);
  });

  it('retains an oversized newest success, never caches failures, and rejects bad bounds (#174)', async () => {
    let executions = 0;
    const tool: NativeAgentTool = {
      name: 'perkins_probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      execute: async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        if (input['fail'] === true) {
          throw new Error('boom');
        }
        executions += 1;
        return { text: 'y'.repeat(10_000) };
      },
    };
    const bridge = await ReviewMcpBridge.start([tool], { retention: { maxBytes: 100, maxEntries: 1 } });
    bridges.push(bridge);
    const call = (id: string, input: Record<string, unknown>) =>
      callBridge(bridge.socketPath, { id, name: 'perkins_probe', input }).promise;
    await expect(call('big-1', {})).resolves.toMatchObject({ ok: true });
    await expect(call('fail-1', { fail: true })).resolves.toMatchObject({ ok: false, error: 'boom' });
    await expect(call('fail-2', { fail: true })).resolves.toMatchObject({ ok: false, error: 'boom' });
    // The failure neither evicted the oversized success nor was retained.
    await expect(call('big-2', {})).resolves.toMatchObject({ ok: true });
    expect(executions).toBe(1);
    await expect(ReviewMcpBridge.start([tool], { retention: { maxBytes: 0, maxEntries: 1 } }))
      .rejects.toThrow(/retention bounds must be positive safe integers/);
  });

  it('bridge teardown explicitly aborts a pending execution', async () => {
    let started = false;
    let aborted = false;
    const tool: NativeAgentTool = {
      name: 'perkins_probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      execute: async (_input, signal) => {
        started = true;
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('native review tool aborted'));
          }, { once: true });
        });
      },
    };
    const bridge = await ReviewMcpBridge.start([tool]);
    const pending = callBridge(bridge.socketPath, { id: 'pending', name: 'perkins_probe', input: {} })
      .promise.catch((error: unknown) => ({ ok: false, error: String(error) }));
    await vi.waitFor(() => expect(started).toBe(true));
    await bridge.close();
    const outcome = await pending;
    expect(aborted).toBe(true);
    expect(outcome.ok).toBe(false);
  });
});

describe('review MCP server: still-running wait slice and re-attach', () => {
  it('answers a wait-expired tools/call with still-running, then returns the live execution result on re-attach', async () => {
    let executions = 0;
    const gate = deferred();
    const bridge = await ReviewMcpBridge.start([{
      name: 'perkins_probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      execute: async () => {
        executions += 1;
        await gate.promise;
        return { text: 'final-results', details: { resultCount: 1 } };
      },
    }]);
    bridges.push(bridge);
    const server = spawnServer(bridge.socketPath, { GRU_REVIEW_RESPONSE_WAIT_MS: '150' });
    const client = serverClient(server);
    await client.call(1, 'initialize', { protocolVersion: '2099-arbitrary', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const first = (await client.call(2, 'tools/call', { name: 'perkins_probe', arguments: { runs: ['blind'] } })) as {
      result?: { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
      error?: unknown;
    };
    expect(first.error).toBeUndefined();
    expect(first.result?.content?.[0]?.text).toContain('has not returned within the 150 ms transport wait');
    expect(first.result?.content?.[0]?.text).toContain('The review tool "perkins_probe"');
    expect(first.result?.content?.[0]?.text).toContain('Call the same tool again with the same arguments to attach to it');
    // The re-attach guidance is the text; no structuredContent shadows it.
    expect(first.result?.structuredContent).toBeUndefined();
    expect(executions).toBe(1);
    gate.resolve();
    const second = (await client.call(3, 'tools/call', { name: 'perkins_probe', arguments: { runs: ['blind'] } })) as {
      result?: { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
      error?: unknown;
    };
    expect(second.error).toBeUndefined();
    expect(second.result?.content?.[0]?.text).toBe('final-results');
    expect(second.result?.structuredContent).toBeUndefined();
    // The re-attach joined the live execution; it did not start a second one.
    expect(executions).toBe(1);
  });

  it('returns the full tool text with no structuredContent, so Claude Code shows the model the text', async () => {
    // Claude Code 2.1.309 hands the model the structuredContent JSON instead
    // of the text when both are present: specialist findings, preflight
    // errors and re-attach guidance would reach the lead as counts only.
    const bridge = await ReviewMcpBridge.start([{
      name: 'perkins_probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      execute: async () => ({
        text: JSON.stringify({ results: [{ lens: 'performance', findings: [{ title: 'Unbounded queue' }] }] }),
        details: { resultCount: 1, findingCount: 1 },
      }),
    }]);
    bridges.push(bridge);
    const client = serverClient(spawnServer(bridge.socketPath));
    await client.call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const response = (await client.call(2, 'tools/call', { name: 'perkins_probe', arguments: {} })) as {
      result?: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
      error?: unknown;
    };
    expect(response.error).toBeUndefined();
    expect(response.result?.structuredContent).toBeUndefined();
    expect(response.result?.content).toEqual([{
      type: 'text',
      text: JSON.stringify({ results: [{ lens: 'performance', findings: [{ title: 'Unbounded queue' }] }] }),
    }]);
  });

  it('declares the inline result size Claude Code allows each review tool (#487)', async () => {
    // Without the declaration Claude Code turns a result over ~50,000
    // characters into a file pointer the confined lead cannot open.
    const bridge = await ReviewMcpBridge.start([
      { name: 'perkins_probe', description: 'probe', inputSchema: { type: 'object' }, execute: async () => ({ text: 'ok' }) },
      { name: 'perkins_other', description: 'other', inputSchema: { type: 'object' }, execute: async () => ({ text: 'ok' }) },
    ]);
    bridges.push(bridge);
    const client = serverClient(spawnServer(bridge.socketPath));
    await client.call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const listed = (await client.call(2, 'tools/list', {})) as { result?: { tools?: Array<{ name: string; _meta?: unknown }> } };
    expect(listed.result?.tools?.map((tool) => [tool.name, tool._meta])).toEqual([
      ['perkins_probe', { 'anthropic/maxResultSizeChars': REVIEW_TOOL_RESULT_MAX_CHARS }],
      ['perkins_other', { 'anthropic/maxResultSizeChars': REVIEW_TOOL_RESULT_MAX_CHARS }],
    ]);
  });

  it('reports a dead bridge as an accurate terminal error, never still-running', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gru-review-dead-'));
    temporaryDirectories.push(directory);
    const server = spawnServer(join(directory, 'missing.sock'), { GRU_REVIEW_RESPONSE_WAIT_MS: '1000' });
    const client = serverClient(server);
    await client.call(1, 'initialize', { protocolVersion: '2099-arbitrary', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const response = (await client.call(2, 'tools/call', { name: 'perkins_probe', arguments: {} })) as {
      error?: { message?: string };
      result?: unknown;
    };
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toBeTruthy();
    expect(response.error?.message).not.toContain('still running');
  });

  it('fails loud on a malformed wait override', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gru-review-bad-wait-'));
    temporaryDirectories.push(directory);
    const child = spawn(process.execPath, [BRIDGE_SERVER_MODULE], {
      env: { PATH: process.env.PATH ?? '', GRU_REVIEW_BRIDGE_SOCKET: join(directory, 'none.sock'), GRU_REVIEW_RESPONSE_WAIT_MS: '0' },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const exit = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    expect(exit).toBe(2);
    expect(stderr).toContain('GRU_REVIEW_RESPONSE_WAIT_MS must be a positive integer');
  });
});

describe('review MCP server integrity pins', () => {
  it('pins the exact bundled server bytes in the bridge and the build verifier', () => {
    const bytes = readFileSync(BRIDGE_SERVER_MODULE);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PERKINS_MCP_SERVER_SHA256);
    const verifier = readFileSync(join(process.cwd(), 'tools', 'verify-perkins-resource.mjs'), 'utf8');
    expect(verifier).toContain(PERKINS_MCP_SERVER_SHA256);
  });
});
