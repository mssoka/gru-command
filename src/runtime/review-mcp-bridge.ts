import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeAgentTool } from './types.js';

const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024;
const PARTIAL_FRAME_TIMEOUT_MS = 5_000;
/** Soft byte bound on successfully settled results retained for re-attach.
 * Each entry is charged its text, its serialized structured details, its
 * request key and a fixed overhead, so no settled success is free. The
 * entries settled LONGEST AGO are evicted first (never in-flight ones); the
 * most recently settled result is always retained even when oversized. */
const MAX_RETAINED_EXECUTION_BYTES = 16 * 1024 * 1024;
/** Entry-count cap on retained successes, so tiny or zero-text results
 * cannot grow the map without bound. */
const MAX_RETAINED_EXECUTIONS = 256;
/** Fixed per-entry bookkeeping charge (record, promise, map slot). */
const RETAINED_ENTRY_OVERHEAD_BYTES = 256;

export interface ReviewMcpRetention {
  readonly maxBytes: number;
  readonly maxEntries: number;
}
const MAX_BUNDLED_SERVER_BYTES = 2 * 1024 * 1024;
const MAX_BRIDGE_CONNECTIONS = 16;
/** Cap on bridge teardown during disposal. Exported so the service shutdown
 * force-exit budget can be reconciled with the bounded teardown (issue #341). */
export const BRIDGE_CLOSE_TIMEOUT_MS = 5_000;
export const PERKINS_MCP_SERVER_SHA256 = 'd4ff7ad04a1e8069d843050940254b860f8fb8a8d7a4be13694415ded96c09a0';

interface BridgeRequest {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
}

interface BridgeToolResult {
  readonly text: string;
  readonly details?: Record<string, unknown>;
  readonly terminate?: boolean;
}

/** The settled outcome of one host-side tool execution. Failures are never
 * retained: a later identical request must execute for real. */
type BridgeOutcome =
  | { readonly ok: true; readonly result: BridgeToolResult; readonly retainedBytes: number }
  | { readonly ok: false; readonly error: string };

interface ExecutionRecord {
  readonly promise: Promise<BridgeOutcome>;
  settled: boolean;
  /** Retained cost (text + details + key + overhead); nonzero only for a
   * settled success. */
  retainedBytes: number;
  /** Monotonic settlement order of a retained success (0 until settled). */
  settledSeq: number;
}

/** Canonical request identity: object key order must not split one logical
 * call into two duplicate executions when a client re-issues it. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function executionKey(name: string, input: Record<string, unknown>): string {
  return `${name}\u0000${canonicalJson(input)}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contained(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function writeLine(socket: Socket, value: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.end(`${JSON.stringify(value)}\n`);
  } catch {
    // A peer may disconnect between the writable check and end(). The
    // per-socket error listener below contains asynchronous write errors;
    // this catches the synchronous half of the same harmless race.
    socket.destroy();
  }
}

/** Scoped local bridge for one Claude review session — lead or lens child.
 * Each bridge exposes exactly the native tools its session declared. The MCP
 * subprocess receives a 0700 Unix-socket path, not arbitrary service access. */
export class ReviewMcpBridge {
  readonly configFile: string;
  readonly toolNames: readonly string[];
  private closePromise: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private readonly sockets = new Set<Socket>();
  /** In-flight and retained-success executions, keyed by canonical request
   * identity, so a transport wait that ended without the result re-attaches
   * to the SAME work instead of cancelling or duplicating it. */
  private readonly executions = new Map<string, ExecutionRecord>();
  private retainedExecutionBytes = 0;
  private retainedExecutionCount = 0;
  private settlementSeq = 0;
  /** Per-connection request handlers in flight (teardown awaits them). */
  private readonly handlers = new Set<Promise<void>>();

  private constructor(
    readonly socketPath: string,
    private readonly directory: string,
    private readonly server: Server,
    private readonly tools: ReadonlyMap<string, NativeAgentTool>,
    private readonly retention: ReviewMcpRetention,
  ) {
    this.toolNames = [...tools.keys()];
    // The plain-JS server must ship beside this module in both src/ tests
    // and the source-free dist/ product. Never fall back into a source tree.
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const serverModule = fileURLToPath(new URL('./review-mcp-server.mjs', import.meta.url));
    const serverInfo = lstatSync(serverModule);
    if (
      !serverInfo.isFile() || serverInfo.isSymbolicLink() || !contained(moduleDirectory, serverModule) ||
      serverInfo.size > MAX_BUNDLED_SERVER_BYTES
    ) {
      throw new Error(`bundled review MCP server must be a bounded regular sibling file: ${serverModule}`);
    }
    const serverBytes = readFileSync(serverModule);
    if (serverBytes.byteLength !== serverInfo.size) {
      throw new Error(`bundled review MCP server changed while being read: ${serverModule}`);
    }
    const actualServerSha256 = createHash('sha256').update(serverBytes).digest('hex');
    if (actualServerSha256 !== PERKINS_MCP_SERVER_SHA256) {
      throw new Error(
        `bundled review MCP server integrity mismatch: expected ${PERKINS_MCP_SERVER_SHA256}, got ${actualServerSha256}`,
      );
    }
    this.configFile = join(directory, 'mcp-config.json');
    writeFileSync(this.configFile, `${JSON.stringify({
      mcpServers: {
        gru_perkins: {
          type: 'stdio',
          command: process.execPath,
          args: [serverModule],
          env: { GRU_REVIEW_BRIDGE_SOCKET: socketPath },
        },
      },
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }

  static async start(
    definitions: readonly NativeAgentTool[],
    startup: { chmod?: typeof chmodSync; retention?: ReviewMcpRetention } = {},
  ): Promise<ReviewMcpBridge> {
    const retention = startup.retention ?? {
      maxBytes: MAX_RETAINED_EXECUTION_BYTES,
      maxEntries: MAX_RETAINED_EXECUTIONS,
    };
    if (
      !Number.isSafeInteger(retention.maxBytes) || retention.maxBytes < 1 ||
      !Number.isSafeInteger(retention.maxEntries) || retention.maxEntries < 1
    ) {
      throw new Error('review bridge retention bounds must be positive safe integers');
    }
    const tools = new Map<string, NativeAgentTool>();
    for (const definition of definitions) {
      // Product-native tool names (review leads and, since issue #161,
      // non-review parent sessions): a lowercase snake-ish identifier.
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(definition.name) || tools.has(definition.name)) {
        throw new Error(`invalid or duplicate native tool name: ${definition.name}`);
      }
      tools.set(definition.name, definition);
    }
    const directory = mkdtempSync(join(tmpdir(), 'gru-review-mcp-'));
    let server: Server | null = null;
    let bridge: ReviewMcpBridge | null = null;
    const bridgeRef: { current: ReviewMcpBridge | null } = { current: null };
    try {
      // Every operation after mkdtemp belongs to this cleanup region,
      // including chmod and server construction.
      (startup.chmod ?? chmodSync)(directory, 0o700);
      const socketPath = join(directory, `bridge-${randomUUID().slice(0, 8)}.sock`);
      server = createServer((socket) => {
        socket.on('error', () => {
          bridgeRef.current?.sockets.delete(socket);
        });
        const current = bridgeRef.current;
        if (current === null) {
          socket.destroy();
          return;
        }
        if (current.sockets.size >= MAX_BRIDGE_CONNECTIONS) {
          writeLine(socket, { id: 'invalid', ok: false, error: 'review bridge connection limit reached' });
          return;
        }
        current.sockets.add(socket);
        socket.once('close', () => current.sockets.delete(socket));
        let bytes = 0;
        let body = '';
        let finished = false;
        socket.setEncoding('utf8');
        socket.setTimeout(PARTIAL_FRAME_TIMEOUT_MS, () => {
          if (finished) return;
          finished = true;
          writeLine(socket, { id: 'invalid', ok: false, error: 'review bridge request frame timed out' });
        });
        socket.on('data', (chunk: string) => {
          if (finished) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_BRIDGE_MESSAGE_BYTES) {
            finished = true;
            socket.pause();
            writeLine(socket, { id: 'invalid', ok: false, error: 'review bridge request exceeds 1 MiB' });
            return;
          }
          body += chunk;
          const newline = body.indexOf('\n');
          if (newline === -1) return;
          finished = true;
          socket.setTimeout(0);
          socket.pause();
          const execution = current.handle(socket, body.slice(0, newline));
          current.handlers.add(execution);
          void execution.finally(() => current.handlers.delete(execution));
        });
      });
      bridge = new ReviewMcpBridge(socketPath, directory, server, tools, retention);
      bridgeRef.current = bridge;
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(socketPath, () => {
          server!.off('error', reject);
          resolve();
        });
      });
      return bridge;
    } catch (error) {
      bridgeRef.current = null;
      if (bridge !== null) for (const socket of bridge.sockets) socket.destroy();
      try {
        server?.close();
      } catch {
        // The server may not have reached listen().
      }
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async handle(socket: Socket, raw: string): Promise<void> {
    let requestId = 'invalid';
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!object(parsed) || typeof parsed.id !== 'string' || typeof parsed.name !== 'string') {
        throw new Error('review bridge request schema is invalid');
      }
      if (parsed.input !== undefined && !object(parsed.input)) {
        throw new Error('review bridge request input must be an object');
      }
      const request = parsed as unknown as BridgeRequest;
      requestId = request.id;
      if (request.name === '__list__') {
        writeLine(socket, {
          id: request.id,
          ok: true,
          result: [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
        return;
      }
      const tool = this.tools.get(request.name);
      if (tool === undefined) throw new Error(`unknown native review tool: ${request.name}`);
      const input = (request.input ?? {}) as Record<string, unknown>;
      const key = executionKey(request.name, input);
      let record = this.executions.get(key);
      if (record === undefined) record = this.startExecution(tool, input, key);
      // A repeated identical request joins the same execution: the tool
      // runs once, and every waiter receives its settled outcome.
      const outcome = await record.promise;
      if (outcome.ok) writeLine(socket, { id: request.id, ok: true, result: outcome.result });
      else writeLine(socket, { id: request.id, ok: false, error: outcome.error });
    } catch (error) {
      writeLine(socket, {
        id: requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Start one host-side tool execution. There is deliberately no execution
   * deadline: the transport wait that ends without this result reports
   * still-running and re-attaches (by canonical identity), so the work is
   * only ended by the tool settling, an explicit bridge abort, or teardown. */
  private startExecution(
    tool: NativeAgentTool,
    input: Record<string, unknown>,
    key: string,
  ): ExecutionRecord {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.abort.signal.addEventListener('abort', abort, { once: true });
    const promise = (async (): Promise<BridgeOutcome> => {
      try {
        const result = await tool.execute(input, controller.signal);
        if (!object(result) || typeof result.text !== 'string') {
          throw new Error('native review tool returned an invalid result');
        }
        if (result.details !== undefined && !object(result.details)) {
          throw new Error('native review tool returned non-object structured details');
        }
        if (result.terminate !== undefined && typeof result.terminate !== 'boolean') {
          throw new Error('native review tool returned an invalid termination state');
        }
        // The result is serialized onto the socket anyway; measuring it here
        // makes a non-serializable details object a loud tool error.
        const detailsBytes = result.details === undefined
          ? 0
          : Buffer.byteLength(JSON.stringify(result.details) ?? '', 'utf8');
        return {
          ok: true,
          result: {
            text: result.text,
            ...(result.details !== undefined ? { details: result.details } : {}),
            ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
          },
          retainedBytes: Buffer.byteLength(result.text, 'utf8') + detailsBytes +
            Buffer.byteLength(key, 'utf8') + RETAINED_ENTRY_OVERHEAD_BYTES,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        this.abort.signal.removeEventListener('abort', abort);
      }
    })();
    const record: ExecutionRecord = { promise, settled: false, retainedBytes: 0, settledSeq: 0 };
    this.executions.set(key, record);
    void promise.then((outcome) => {
      record.settled = true;
      if (!outcome.ok) {
        // A failure is never retained: a later identical request must
        // execute for real (retry semantics), not replay the error.
        if (this.executions.get(key) === record) this.executions.delete(key);
        return;
      }
      if (this.executions.get(key) !== record) return;
      this.settlementSeq += 1;
      record.settledSeq = this.settlementSeq;
      record.retainedBytes = outcome.retainedBytes;
      this.retainedExecutionBytes += record.retainedBytes;
      this.retainedExecutionCount += 1;
      this.evictRetainedExecutions();
    });
    return record;
  }

  /** Keep retained successes bounded by bytes AND entry count, evicting the
   * entries SETTLED longest ago first. Start order is irrelevant: a wave that
   * started early but just settled is the newest retained result and the one
   * a re-attach needs. Pending executions are never evicted, and the most
   * recently settled success is always kept. Eviction only degrades a stale
   * re-attach into a fresh execution, never a just-settled one. */
  private evictRetainedExecutions(): void {
    const over = () =>
      this.retainedExecutionBytes > this.retention.maxBytes ||
      this.retainedExecutionCount > this.retention.maxEntries;
    if (!over()) return;
    const settled = [...this.executions.entries()]
      .filter(([, record]) => record.settled && record.retainedBytes > 0)
      .sort(([, a], [, b]) => a.settledSeq - b.settledSeq);
    // Never evict the newest settled success.
    for (const [key, record] of settled.slice(0, -1)) {
      if (!over()) break;
      this.executions.delete(key);
      this.retainedExecutionBytes -= record.retainedBytes;
      this.retainedExecutionCount -= 1;
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.teardown();
    return this.closePromise;
  }

  private async teardown(): Promise<void> {
    this.abort.abort();
    for (const socket of this.sockets) socket.destroy();
    const serverClosed = new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.allSettled([
          serverClosed,
          ...[...this.handlers],
          ...[...this.executions.values()].map((record) => record.promise),
        ]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, BRIDGE_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
