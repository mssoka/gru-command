#!/usr/bin/env node
/* global Buffer, clearTimeout, process, setTimeout */
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 15 * 60 * 1_000;
const SUPPORTED_PROTOCOL_VERSION = '2024-11-05';
const socketPath = process.env['GRU_REVIEW_BRIDGE_SOCKET'];
if (socketPath === undefined || socketPath === '') {
  process.stderr.write('GRU_REVIEW_BRIDGE_SOCKET is required\n');
  process.exit(2);
}
const bridgeSocketPath = socketPath;

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function bridge(name, input) {
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(bridgeSocketPath);
    let bytes = 0;
    let body = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      socket.removeAllListeners();
      socket.destroy();
      if (error === null) resolve(result);
      else reject(error);
    };
    const connectTimer = setTimeout(() => finish(new Error('review bridge connection timed out')), CONNECT_TIMEOUT_MS);
    const responseTimer = setTimeout(() => finish(new Error('review bridge response timed out')), RESPONSE_TIMEOUT_MS);
    connectTimer.unref?.();
    responseTimer.unref?.();
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      clearTimeout(connectTimer);
      socket.write(`${JSON.stringify({ id, name, input })}\n`);
    });
    socket.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_MESSAGE_BYTES) {
        finish(new Error('review bridge response exceeds 1 MiB'));
        return;
      }
      body += chunk;
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      try {
        const response = JSON.parse(body);
        if (!object(response)) throw new Error('review bridge response must be an object');
        if (response.id !== id) throw new Error('review bridge response id mismatch');
        if (typeof response.ok !== 'boolean') throw new Error('review bridge response status is invalid');
        if (!response.ok) throw new Error(typeof response.error === 'string' ? response.error : 'native review tool failed');
        if (!object(response.result) && !Array.isArray(response.result)) {
          throw new Error('review bridge result must be an object or array');
        }
        finish(null, response.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function respond(id, result, error) {
  const message = error === undefined
    ? { jsonrpc: '2.0', id, result }
    : { jsonrpc: '2.0', id, error };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const active = new Set();
function dispatch(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    respond(null, undefined, { code: -32700, message: 'parse error' });
    return;
  }
  if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    respond(object(request) && request.id !== undefined ? request.id : null, undefined, {
      code: -32600,
      message: 'invalid JSON-RPC request object',
    });
    return;
  }
  if (request.id === undefined) return;
  if (!['string', 'number'].includes(typeof request.id) && request.id !== null) {
    respond(null, undefined, { code: -32600, message: 'invalid JSON-RPC request id' });
    return;
  }
  if (request.params !== undefined && !object(request.params)) {
    respond(request.id, undefined, { code: -32602, message: 'request params must be an object' });
    return;
  }
  const operation = (async () => {
    try {
      if (request.method === 'initialize') {
        respond(request.id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'gru-perkins-review', version: '1.0.0' },
        });
        return;
      }
      if (request.method === 'ping') {
        respond(request.id, {});
        return;
      }
      if (request.method === 'tools/list') {
        const tools = await bridge('__list__', {});
        if (!Array.isArray(tools)) throw new Error('native review tool list is invalid');
        respond(request.id, { tools });
        return;
      }
      if (request.method === 'tools/call') {
        const params = request.params ?? {};
        if (typeof params.name !== 'string') throw new Error('tools/call requires a name');
        if (params.arguments !== undefined && !object(params.arguments)) {
          throw new Error('tools/call arguments must be an object');
        }
        const result = await bridge(params.name, params.arguments ?? {});
        if (typeof result.text !== 'string') throw new Error('native review tool returned invalid text');
        if (result.details !== undefined && !object(result.details)) {
          throw new Error('native review tool returned invalid structured details');
        }
        if (result.terminate !== undefined && typeof result.terminate !== 'boolean') {
          throw new Error('native review tool returned invalid termination state');
        }
        respond(request.id, {
          content: [{ type: 'text', text: result.text }],
          structuredContent: result.details ?? {},
          ...(result.terminate === true ? { _meta: { terminate: true } } : {}),
        });
        return;
      }
      respond(request.id, undefined, { code: -32601, message: `method not found: ${request.method}` });
    } catch (error) {
      respond(request.id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  active.add(operation);
  void operation.finally(() => active.delete(operation));
}

let frameParts = [];
let frameBytes = 0;
let discardingOversize = false;
function appendSegment(segment, terminated) {
  if (!discardingOversize) {
    if (frameBytes + segment.byteLength > MAX_MESSAGE_BYTES) {
      discardingOversize = true;
      frameParts = [];
      frameBytes = 0;
      respond(null, undefined, { code: -32600, message: 'JSON-RPC request exceeds 1 MiB' });
    } else {
      frameParts.push(segment);
      frameBytes += segment.byteLength;
    }
  }
  if (!terminated) return;
  if (!discardingOversize) dispatch(Buffer.concat(frameParts, frameBytes).toString('utf8'));
  frameParts = [];
  frameBytes = 0;
  discardingOversize = false;
}

process.stdin.on('data', (value) => {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let start = 0;
  for (;;) {
    const newline = chunk.indexOf(0x0a, start);
    if (newline === -1) {
      appendSegment(chunk.subarray(start), false);
      return;
    }
    appendSegment(chunk.subarray(start, newline), true);
    start = newline + 1;
    if (start >= chunk.length) return;
  }
});
process.stdin.on('end', () => {
  if (frameBytes > 0 || discardingOversize) appendSegment(Buffer.alloc(0), true);
  void Promise.allSettled([...active]);
});
