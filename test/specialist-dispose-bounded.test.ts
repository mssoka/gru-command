import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { configPathFor, loadConfig } from '../src/config.js';
import { ClaudeCodeRuntime } from '../src/runtime/claude-adapter.js';
import { SessionStore } from '../src/sessions/store.js';

/**
 * Issue #95 (R39): can a production specialist `dispose()` stay pending
 * forever? These tests pin the evidence that it cannot, on the SLOWEST real
 * production disposal path of each runtime, without any added watchdog:
 *
 *  - Claude specialist (isolatedReview) = live child that ignores SIGTERM and
 *    SIGKILL-bound transcript, PLUS a scoped review bridge with a tool handler
 *    that never settles. dispose() is bounded by killGraceMs*2 (child) +
 *    killGraceMs (flush) + BRIDGE_CLOSE_TIMEOUT_MS (5s, bridge teardown).
 *  - Pi specialist = AgentSession.dispose() of the pinned SDK is synchronous
 *    (not an async function), so `await session.dispose()` cannot wait on
 *    waitForIdle. If an SDK upgrade makes it async this test fails and the
 *    Pi disposal bound must be re-established deliberately.
 */

const DOUBLE = join(import.meta.dirname, 'helpers', 'claude-double.mjs');
const cleanupDirs: string[] = [];
const isAuthKey = (key: string) =>
  /^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|AWS_|GOOGLE_|CLOUD_ML_REGION)/u.test(key);
const hostAuthEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => isAuthKey(key)));
const clearAuthEnv = () => {
  for (const key of Object.keys(process.env).filter(isAuthKey)) delete process.env[key];
};
afterEach(() => {
  delete process.env['CLAUDE_DOUBLE_IGNORE_TERM'];
  delete process.env['CLAUDE_DOUBLE_LOG'];
  delete process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'];
  clearAuthEnv();
});
afterAll(() => {
  Object.assign(process.env, hostAuthEnv);
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('specialist dispose() is bounded on the slowest production paths (#95)', () => {
  it('Claude specialist: SIGTERM-immune child + never-settling bridge tool still disposes within the owned bounds', async () => {
    clearAuthEnv();
    const home = mkdtempSync(join(tmpdir(), 'gru-command-dispose-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-dispose-ws-'));
    cleanupDirs.push(home, workspace);
    writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const doubleLog = join(home, 'double-log.jsonl');
    process.env['CLAUDE_DOUBLE_LOG'] = doubleLog;
    const settingsFile = join(home, 'review-settings.json');
    writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'test-key' } }));
    const killGraceMs = 50;
    const runtime = new ClaudeCodeRuntime({
      config, store, binary: DOUBLE, killGraceMs, reviewSettingsFile: settingsFile,
    });
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'] = 'env';
    const snapshot = await runtime.prepareReviewModel('perkins');
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => { toolStarted = resolve; });
    // The review child's env is a snapshot (`claudeReviewProcessEnv`) captured
    // HERE, at spawn time — the turn-spawned process later inherits it verbatim.
    // Setting this after spawn (as before) left the child SIGTERM-vulnerable, so
    // the SIGKILL-escalation premise was never actually exercised. It must be
    // set BEFORE spawn; not earlier, because prepareReviewModel's synchronous
    // `--version`/auth probe child only exits cleanly without IGNORE_TERM.
    process.env['CLAUDE_DOUBLE_IGNORE_TERM'] = '1';
    const handle = await runtime.spawn('perkins', {
      reviewModel: snapshot,
      isolatedReview: {
        systemPrompt: 'lens',
        tools: [],
        // Worst case: the host-side tool never settles and ignores abort.
        nativeTools: [{
          name: 'perkins_hang', description: 'never settles', inputSchema: { type: 'object' },
          execute: () => { toolStarted(); return new Promise(() => {}); },
        }],
      },
    });
    const turn = handle.prompt('hold:never', { owner: 'alice' });
    const turnRejected = expect(turn).rejects.toThrow(/disposed/);
    // The invocation record carries the scoped bridge's MCP config.
    const invocation = await vi_waitFor(() => {
      if (!existsSync(doubleLog)) return null;
      const lines = readFileSync(doubleLog, 'utf8').trim().split('\n').filter((line) => line !== '');
      const records = lines.map((line) => JSON.parse(line) as { argv: string[] });
      return records.find((record) => record.argv.includes('--mcp-config')) ?? null;
    });
    const configFile = invocation.argv[invocation.argv.indexOf('--mcp-config') + 1]!;
    const bridgeSocket = (JSON.parse(readFileSync(configFile, 'utf8')) as {
      mcpServers: { gru_perkins: { env: { GRU_REVIEW_BRIDGE_SOCKET: string } } };
    }).mcpServers.gru_perkins.env.GRU_REVIEW_BRIDGE_SOCKET;
    const client = createConnection(bridgeSocket);
    client.on('error', () => {});
    client.once('connect', () => client.write(`${JSON.stringify({ id: 'hang-1', name: 'perkins_hang', input: {} })}\n`));
    await started; // a bridge handler is now pinned in flight forever

    const begin = Date.now();
    await handle.dispose();
    const elapsed = Date.now() - begin;
    await turnRejected;
    client.destroy();
    expect(handle.health().state).toBe('disposed');
    const sessionFile = handle.sessionFile;
    expect(sessionFile).not.toBeNull();
    expect(existsSync(`${sessionFile!}.lock`)).toBe(false);
    expect(existsSync(configFile)).toBe(false); // bridge directory removed
    // 5s bridge teardown cap + child exit/flush grace windows + generous CI slack.
    expect(elapsed).toBeLessThan(5_000 + killGraceMs * 3 + 10_000);
    // The never-settling handler really did pin the bridge until its own cap.
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
  }, 40_000);

  it('Pi specialist: the pinned SDK AgentSession.dispose() is synchronous, so awaiting it cannot wait on idle', () => {
    expect(AgentSession.prototype.dispose.constructor.name).toBe('Function'); // not AsyncFunction
    expect(AgentSession.prototype.dispose.length).toBe(0);
  });
});

async function vi_waitFor<T>(read: () => T | null, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
