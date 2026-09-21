import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeAgentTool } from './types.js';

const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024;
const PARTIAL_FRAME_TIMEOUT_MS = 5_000;
const TOOL_EXECUTION_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_BUNDLED_SERVER_BYTES = 2 * 1024 * 1024;
const MAX_BRIDGE_CONNECTIONS = 16;
const BRIDGE_CLOSE_TIMEOUT_MS = 5_000;
export const PERKINS_MCP_SERVER_SHA256 = 'badd96c16800cffb9e18734f777d40d423b72423b89debed5684ad42c62f2032';

interface BridgeRequest {
  readonly id: string;
  readonly name: string;
  readonly input?: unknown;
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

/** Scoped local bridge used only by one Claude review-lead session. The MCP
 * subprocess receives a 0700 Unix-socket path, not arbitrary service access. */
export class ReviewMcpBridge {
  readonly configFile: string;
  readonly toolNames: readonly string[];
  private closePromise: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private readonly sockets = new Set<Socket>();
  private readonly executions = new Set<Promise<void>>();

  private constructor(
    readonly socketPath: string,
    private readonly directory: string,
    private readonly server: Server,
    private readonly tools: ReadonlyMap<string, NativeAgentTool>,
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
    startup: { chmod?: typeof chmodSync } = {},
  ): Promise<ReviewMcpBridge> {
    const tools = new Map<string, NativeAgentTool>();
    for (const definition of definitions) {
      if (!/^perkins_[a-z0-9_]{1,48}$/.test(definition.name) || tools.has(definition.name)) {
        throw new Error(`invalid or duplicate native review tool name: ${definition.name}`);
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
          current.executions.add(execution);
          void execution.finally(() => current.executions.delete(execution));
        });
      });
      bridge = new ReviewMcpBridge(socketPath, directory, server, tools);
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
    let request: BridgeRequest | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let removeAbort = (): void => {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!object(parsed) || typeof parsed.id !== 'string' || typeof parsed.name !== 'string') {
        throw new Error('review bridge request schema is invalid');
      }
      if (parsed.input !== undefined && !object(parsed.input)) {
        throw new Error('review bridge request input must be an object');
      }
      request = parsed as unknown as BridgeRequest;
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
      const controller = new AbortController();
      const abort = () => controller.abort();
      this.abort.signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => this.abort.signal.removeEventListener('abort', abort);
      const result = await Promise.race([
        tool.execute(request.input ?? {}, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('native review tool execution timed out'));
          }, TOOL_EXECUTION_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (!object(result) || typeof result.text !== 'string') {
        throw new Error('native review tool returned an invalid result');
      }
      if (result.details !== undefined && !object(result.details)) {
        throw new Error('native review tool returned non-object structured details');
      }
      if (result.terminate !== undefined && typeof result.terminate !== 'boolean') {
        throw new Error('native review tool returned an invalid termination state');
      }
      writeLine(socket, { id: request.id, ok: true, result });
    } catch (error) {
      writeLine(socket, {
        id: request?.id ?? 'invalid',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      removeAbort();
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
        Promise.allSettled([serverClosed, ...this.executions]),
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
