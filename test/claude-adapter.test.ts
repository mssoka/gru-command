import { PassThrough } from 'node:stream';
import * as childProcesses from 'node:child_process';
import { BUILD_INCIDENT, FULL_INCIDENT, WEB_INCIDENT, authenticatedCaptureStatus, verificationLane } from './helpers/worker-verification.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import type { WorkerVerificationPolicy } from '../src/runtime/worker-verification-policy.js';
import {
  CLAUDE_CODE_CAPABILITIES,
  ClaudeCodeRuntime,
  checkedInProjectMcpConfig,
  claudeInBandError,
  gitFailure,
  isProjectMcpCopyName,
  loggableMcpServerName,
  mapRoleTools,
} from '../src/runtime/claude-adapter.js';
import { isRateLimitErrorText } from '../src/runtime/pacing.js';
import { deterministicFailureClass } from '../src/decisions/questions.js';
import { classifyProviderRejection, providerSupportsSensor } from '../src/provider-recovery/classify.js';
import { RuntimeRegistry, serviceRegistryOptions } from '../src/runtime/registry.js';
import { makeWorkflowLane } from './helpers/workflow-lane.js';
import { NO_REVIEW_OWNER_LEDGER } from './helpers/no-review-owner-ledger.js';
import { makeFallbackRuntimeHarness } from './helpers/fallback-runtime.js';
import {
  ClaudeControlTranslator,
  ClaudeTurnTranslator,
  extractSessionId,
  NdjsonParser,
  type StreamFrame,
} from '../src/runtime/stream-json.js';
import { LockBusyError, SessionStore } from '../src/sessions/store.js';
import { inspectDirectiveProducers, prepareClaudeDirectiveBinding, readDirectiveBinding, readDirectiveCompletion, type DirectiveNativeBinding, type DirectiveTurnIdentity } from '../src/runtime/directive-checkpoint.js';
import type { AgentHandle, RuntimeEvent } from '../src/runtime/types.js';
import { ReviewMcpBridge } from '../src/runtime/review-mcp-bridge.js';
import { PerkinsWholeReview } from '../src/dispatch/perkins-review/whole.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { freezeReviewInputs } from '../src/dispatch/perkins-review/artifacts.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';

/** The project-MCP copies beside a session transcript (one per live handle). */
function copiesOf(sessionFile: string): string[] {
  return readdirSync(dirname(sessionFile))
    .filter((name) => isProjectMcpCopyName(basename(sessionFile), name))
    .map((name) => join(dirname(sessionFile), name));
}

/**
 * claude-code adapter tests (EPICS E3): a STUBBED CLI double (executable
 * node script) stands in for `claude` — real child processes, real stdio,
 * real NDJSON; never a real claude, never any network.
 */

const DOUBLE = join(import.meta.dirname, 'helpers', 'claude-double.mjs');
const DOUBLE_ENV_KEYS = [
  'CLAUDE_DOUBLE_ECHO',
  'CLAUDE_DOUBLE_TOOL_INPUT_DRIFT',
  'CLAUDE_DOUBLE_PERMISSION_MALFORMED',
  'CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL',
  'CLAUDE_DOUBLE_COMPACT_VERIFICATION',
  'CLAUDE_DOUBLE_LOG',
  'CLAUDE_DOUBLE_NO_PARTIALS',
  'CLAUDE_DOUBLE_TOOL_HOLD_MS',
  'CLAUDE_DOUBLE_MISMATCH',
  'CLAUDE_DOUBLE_MCP_SERVER_ERRORS',
  'CLAUDE_DOUBLE_MCP_SERVERS',
  'CLAUDE_DOUBLE_IGNORE_TERM',
  'CLAUDE_DOUBLE_COMPACT_ERROR',
  'CLAUDE_DOUBLE_COMPACT_STATUS_FAIL',
  'CLAUDE_DOUBLE_COMPACT_EXIT_ERROR',
  'CLAUDE_DOUBLE_COMPACT_NO_INIT',
  'CLAUDE_DOUBLE_COMPACT_INIT_NO_ID',
  'CLAUDE_DOUBLE_COMPACT_NO_RESULT',
  'CLAUDE_DOUBLE_COMPACT_CONTENT',
  'CLAUDE_DOUBLE_COMPACT_FORGED_RESULT',
  'CLAUDE_DOUBLE_COMPACT_MALFORMED_RESULT',
  'CLAUDE_DOUBLE_COMPACT_HOLD_FILE',
  'CLAUDE_DOUBLE_WORKFLOW_CANDIDATE',
  'CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL',
  'CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH',
  'CLAUDE_DOUBLE_REPLAY',
] as const;

const cleanupDirs: string[] = [];
const isAuthKey = (key: string) =>
  /^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|AWS_|GOOGLE_|CLOUD_ML_REGION)/u.test(key);
const hostAuthEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => isAuthKey(key)));
const clearAuthEnv = () => {
  for (const key of Object.keys(process.env).filter(isAuthKey)) delete process.env[key];
};
beforeEach(clearAuthEnv);
afterAll(() => {
  clearAuthEnv();
  Object.assign(process.env, hostAuthEnv);
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  // Double knobs and credentials must never leak between tests.
  for (const key of DOUBLE_ENV_KEYS) delete process.env[key];
  clearAuthEnv();
});

interface Fixture {
  home: string;
  workspace: string;
  store: SessionStore;
  logs: { level: string; msg: string; fields?: Record<string, unknown> }[];
  doubleLog: string;
  runtime: ClaudeCodeRuntime;
}

function fixture(knobs: { killGraceMs?: number; toolHeartbeatMs?: number; reviewSettingsFile?: string; spawnProcess?: typeof spawn; configToml?: string } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'gru-command-claude-'));
  const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
  cleanupDirs.push(home, workspace);
  writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n${knobs.configToml ?? ''}`, 'utf-8');
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const store = new SessionStore(config.dataDir);
  const logs: Fixture['logs'] = [];
  const doubleLog = join(home, 'double-log.jsonl');
  process.env['CLAUDE_DOUBLE_LOG'] = doubleLog;
  const runtime = new ClaudeCodeRuntime({
    config,
    store,
    binary: DOUBLE,
    ...(knobs.spawnProcess !== undefined ? { spawnProcess: knobs.spawnProcess } : {}),
    ...(knobs.killGraceMs !== undefined ? { killGraceMs: knobs.killGraceMs } : {}),
    ...(knobs.toolHeartbeatMs !== undefined ? { toolHeartbeatMs: knobs.toolHeartbeatMs } : {}),
    reviewSettingsFile: knobs.reviewSettingsFile ?? join(home, 'absent-review-settings.json'),
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
  });
  return { home, workspace, store, logs, doubleLog, runtime };
}

function collect(handle: { subscribe(l: (e: RuntimeEvent) => void): () => void }): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  handle.subscribe((event) => events.push(event));
  return events;
}

function deltas(events: RuntimeEvent[], type: 'text_delta' | 'thinking_delta'): string[] {
  return events.filter((e) => e.type === type).map((e) => (e as { delta: string }).delta);
}

function states(events: RuntimeEvent[]): string[] {
  return events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
}

/** Parsed invocation records the double appended to CLAUDE_DOUBLE_LOG. */
function doubleInvocations(fx: Fixture): {
  argv: string[];
  cwd: string;
  prompt: string;
  images: number;
  sessionId: string;
  stdin: string;
}[] {
  if (!existsSync(fx.doubleLog)) return [];
  const records: {
    argv: string[];
    cwd: string;
    prompt: string;
    images: number;
    sessionId: string;
    stdin: string;
  }[] = [];
  for (const raw of readFileSync(fx.doubleLog, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      records.push(JSON.parse(line) as never);
    } catch {
      // A concurrent appendFileSync can expose a partially written trailing
      // record; the callers' waitFor loops retry until the write completes
      // (code review: the CI Full suite crashed on a mid-append read).
      break;
    }
  }
  return records;
}

/** Direct bridge-socket probe: the same newline-delimited wire the bundled
 * MCP server speaks, without spawning the CLI. */
async function bridgeProbe(configFile: string, name: string, input: Record<string, unknown>): Promise<unknown> {
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
    mcpServers: { gru_perkins: { env: { GRU_REVIEW_BRIDGE_SOCKET: string } } };
  };
  const socketPath = config.mcpServers.gru_perkins.env.GRU_REVIEW_BRIDGE_SOCKET;
  return new Promise((resolveProbe, reject) => {
    const socket = createConnection(socketPath);
    let body = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: 'probe', name, input })}\n`));
    socket.on('data', (chunk) => { body += chunk; });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const response = JSON.parse(body) as { ok: boolean; result?: unknown; error?: string };
        if (!response.ok) reject(new Error(response.error ?? 'bridge probe failed'));
        else resolveProbe(response.result);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Condition-based wait — never a bare wall-clock sleep (flake doctrine). */
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ClaudeCodeRuntime over the stubbed CLI double', () => {
  it('spawns a session persisted under the store layout, named by the minted session uuid, lock held #contract:session-roundtrip:claude-code', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      expect(handle.role).toBe('gru');
      const expectedDir = fx.store.sessionDirFor('gru', fx.workspace);
      expect(handle.sessionFile).toContain(expectedDir);
      const name = handle.sessionFile!.split('/').pop()!;
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T[\dT:.Z-]+_[0-9a-f-]{36}\.jsonl$/);
      // The file's uuid IS the session id (the resume handle).
      expect(handle.id).toBe(name.replace(/\.jsonl$/, '').split('_').pop()!);
      expect(existsSync(`${handle.sessionFile}.lock`)).toBe(true);
      expect(handle.health()).toMatchObject({ state: 'idle', sessionFile: handle.sessionFile });
    } finally {
      await handle.dispose();
    }
    expect(existsSync(`${handle.sessionFile}.lock`)).toBe(false);
  });

  it('round-trips a prompt: ordered deltas, turn lifecycle, raw frames in the transcript', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('hello world', { owner: 'alice' });
      expect(deltas(events, 'text_delta').join('')).toBe('echo: hello world');
      expect(deltas(events, 'text_delta').length).toBeGreaterThan(1); // real streaming
      expect(events.filter((e) => e.type === 'turn_start').length).toBe(1);
      expect(events.filter((e) => e.type === 'turn_end').length).toBe(1);
      const st = states(events);
      expect(st[0]).toBe('spawning');
      expect(st).toContain('streaming');
      expect(st[st.length - 1]).toBe('idle');
      expect(handle.health().lastActivity).not.toBeNull();

      // The transcript holds GC's session header, then the RAW frames (init / assistant / result).
      const lines = readFileSync(handle.sessionFile!, 'utf-8').trim().split('\n');
      const frames = lines.map((l) => JSON.parse(l) as StreamFrame);
      expect(frames[0]).toMatchObject({ type: 'session', id: handle.id, cwd: fx.workspace, runtime: 'claude-code' });
      expect(frames[1]!['type']).toBe('system');
      expect(frames[1]!['subtype']).toBe('init');
      expect(frames[1]!['session_id']).toBe(handle.id);
      expect(frames.some((f) => f['type'] === 'assistant')).toBe(true);
      const last = frames[frames.length - 1]!;
      expect(last['type']).toBe('result');
      expect(last['is_error']).toBe(false);
      // Turn chaining: a second turn on the same handle RESUMES (the
      // session id may only be minted once).
      await handle.prompt('again please', { owner: 'alice' });
      const invocations = doubleInvocations(fx);
      expect(invocations.length).toBe(2);
      expect(invocations[0]!.argv[invocations[0]!.argv.indexOf('--session-id') + 1]).toBe(
        handle.id,
      );
      expect(invocations[1]!.argv[invocations[1]!.argv.indexOf('--resume') + 1]).toBe(handle.id);
      expect(invocations[1]!.argv).not.toContain('--session-id');
    } finally {
      await handle.dispose();
    }
  });

  it('runs native /compact in a dedicated resumed process without leaking command text #contract:compaction:claude-code', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      expect(handle.getContextUsage?.()).toBeNull();
      expect(handle.canCompact?.()).toBe(false);
      // The double's own frames carry no provider window: nothing is measured.
      await handle.prompt('establish the session');
      expect(handle.getContextUsage?.()).toBeNull();
      expect(handle.canCompact?.()).toBe(true);
      const textBefore = deltas(events, 'text_delta').join('');
      const contentEventsBefore = events.filter(
        (event) =>
          event.type === 'text_delta' ||
          event.type === 'thinking_delta' ||
          event.type === 'tool_start' ||
          event.type === 'tool_update' ||
          event.type === 'tool_end',
      ).length;
      const id = handle.id;
      const file = handle.sessionFile;
      process.env['CLAUDE_DOUBLE_COMPACT_CONTENT'] = '1';
      await handle.compact?.();
      expect(handle.id).toBe(id);
      expect(handle.sessionFile).toBe(file);
      expect(deltas(events, 'text_delta').join('')).toBe(textBefore);
      expect(
        events.filter(
          (event) =>
            event.type === 'text_delta' ||
            event.type === 'thinking_delta' ||
            event.type === 'tool_start' ||
            event.type === 'tool_update' ||
            event.type === 'tool_end',
        ),
      ).toHaveLength(contentEventsBefore);
      expect(events.filter((event) => event.type === 'compaction_start')).toHaveLength(1);
      expect(
        events.filter((event) => event.type === 'compaction_end' && event.success),
      ).toHaveLength(1);
      const compact = doubleInvocations(fx).at(-1)!;
      expect(compact.prompt).toBe('/compact');
      expect(compact.argv[compact.argv.indexOf('--resume') + 1]).toBe(id);
      expect(compact.argv).not.toContain('--session-id');
      const compactFrames = readFileSync(file!, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        compactFrames.some(
          (frame) => frame['type'] === 'system' && frame['subtype'] === 'compact_boundary',
        ),
      ).toBe(true);
      expect(
        compactFrames.some(
          (frame) => frame['type'] === 'result' && frame['result'] === 'Compacted conversation',
        ),
      ).toBe(true);
      await handle.prompt('continue after native compact');
      expect(deltas(events, 'text_delta').join('')).toContain('continue after native compact');
      const continuation = doubleInvocations(fx).at(-1)!;
      expect(continuation.argv[continuation.argv.indexOf('--resume') + 1]).toBe(id);
    } finally {
      await handle.dispose();
    }
  });

  it('dispose kills a held native compact before unlocking and the session resumes', async () => {
    const fx = fixture({ killGraceMs: 50 });
    const handle = await fx.runtime.spawn('gru');
    await handle.prompt('establish before held compact');
    process.env['CLAUDE_DOUBLE_IGNORE_TERM'] = '1';
    const file = handle.sessionFile!;
    const releaseFile = join(fx.home, 'release-held-compact');
    process.env['CLAUDE_DOUBLE_COMPACT_HOLD_FILE'] = releaseFile;
    const compact = handle.compact!();
    const rejected = expect(compact).rejects.toThrow(/disposed/);
    await waitFor(() => handle.isCompacting?.() === true && doubleInvocations(fx).length >= 2);
    const disposing = handle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(`${file}.lock`)).toBe(true);
    await disposing;
    await rejected;
    expect(existsSync(`${file}.lock`)).toBe(false);

    delete process.env['CLAUDE_DOUBLE_IGNORE_TERM'];
    delete process.env['CLAUDE_DOUBLE_COMPACT_HOLD_FILE'];
    const resumed = await fx.runtime.spawn('gru', { resumeFile: file });
    try {
      await resumed.prompt('usable after compact restart');
      expect(resumed.health().state).toBe('idle');
    } finally {
      await resumed.dispose();
    }
  });

  it('a native compact failure is bounded and the Claude conversation remains usable', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('establish');
      process.env['CLAUDE_DOUBLE_COMPACT_ERROR'] = '1';
      await expect(handle.compact?.()).rejects.toThrow(/native compact failed/);
      expect(
        events.some((event) => event.type === 'compaction_end' && !event.success),
      ).toBe(true);
      delete process.env['CLAUDE_DOUBLE_COMPACT_ERROR'];
      await handle.prompt('still usable');
      expect(deltas(events, 'text_delta').join('')).toContain('still usable');
    } finally {
      await handle.dispose();
    }
  });

  it('does not fake compact success when the slash command succeeds but native compaction fails', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      await handle.prompt('establish');
      process.env['CLAUDE_DOUBLE_COMPACT_STATUS_FAIL'] = '1';
      await expect(handle.compact?.()).rejects.toThrow(/native compact status failed/);
      delete process.env['CLAUDE_DOUBLE_COMPACT_STATUS_FAIL'];
      process.env['CLAUDE_DOUBLE_MISMATCH'] = '1';
      await expect(handle.compact?.()).rejects.toThrow(/session id mismatch/);
      delete process.env['CLAUDE_DOUBLE_MISMATCH'];
      process.env['CLAUDE_DOUBLE_COMPACT_EXIT_ERROR'] = '1';
      await expect(handle.compact?.()).rejects.toThrow(/exit 7/);
      delete process.env['CLAUDE_DOUBLE_COMPACT_EXIT_ERROR'];
      process.env['CLAUDE_DOUBLE_COMPACT_NO_INIT'] = '1';
      await expect(handle.compact?.()).rejects.toThrow(/without an init frame/);
      delete process.env['CLAUDE_DOUBLE_COMPACT_NO_INIT'];
      process.env['CLAUDE_DOUBLE_COMPACT_INIT_NO_ID'] = '1';
      await expect(handle.compact?.()).rejects.toThrow(/init reported \(empty\)/);
      delete process.env['CLAUDE_DOUBLE_COMPACT_INIT_NO_ID'];
      process.env['CLAUDE_DOUBLE_COMPACT_NO_RESULT'] = '1';
      await expect(handle.compact?.()).rejects.toThrow(/without a result frame/);
      delete process.env['CLAUDE_DOUBLE_COMPACT_NO_RESULT'];
      process.env['CLAUDE_DOUBLE_COMPACT_FORGED_RESULT'] = '1';
      await expect(handle.compact?.()).rejects.toThrow(/without a native compact success/);
      delete process.env['CLAUDE_DOUBLE_COMPACT_FORGED_RESULT'];
      process.env['CLAUDE_DOUBLE_COMPACT_MALFORMED_RESULT'] = '1';
      await expect(handle.compact?.()).rejects.toThrow(/malformed result frame/);
      delete process.env['CLAUDE_DOUBLE_COMPACT_MALFORMED_RESULT'];
      await handle.prompt('usable after status failure');
    } finally {
      await handle.dispose();
    }
  });

  it('emits thinking deltas before text when the model reasons #contract:thinking-deltas:claude-code', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('think about it');
      const kinds = events
        .filter((e) => e.type === 'thinking_delta' || e.type === 'text_delta')
        .map((e) => e.type);
      expect(kinds[0]).toBe('thinking_delta');
      expect(kinds[kinds.length - 1]).toBe('text_delta');
    } finally {
      await handle.dispose();
    }
  });

  it('without partial messages, text and thinking arrive exactly once from complete frames', async () => {
    process.env['CLAUDE_DOUBLE_NO_PARTIALS'] = '1';
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('think twice');
      // Complete-frame fallback: one thinking delta + one text delta.
      expect(deltas(events, 'thinking_delta')).toEqual(['pondering']);
      expect(deltas(events, 'text_delta')).toEqual(['thought about it']);
    } finally {
      await handle.dispose();
    }
  });

  it('maps a tool loop: tool_start once (partials vs complete frame deduped), updates, tool_end', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('tool:Bash please');
      const starts = events.filter((e) => e.type === 'tool_start');
      expect(starts).toEqual([{ type: 'tool_start', callId: 'toolu_double_1', tool: 'Bash' }]);
      // Two input_json_delta partials → two tool_updates for the same call.
      const updates = events.filter((e) => e.type === 'tool_update');
      expect(updates).toEqual([
        { type: 'tool_update', callId: 'toolu_double_1' },
        { type: 'tool_update', callId: 'toolu_double_1' },
      ]);
      const ends = events.filter((e) => e.type === 'tool_end');
      expect(ends).toEqual([{ type: 'tool_end', callId: 'toolu_double_1', isError: false }]);
      expect(deltas(events, 'text_delta').join('')).toBe('tool done');
    } finally {
      await handle.dispose();
    }
  });

  it('E7 follow-up: a held-open tool call heartbeats and reports a live process', async () => {
    process.env['CLAUDE_DOUBLE_TOOL_HOLD_MS'] = '300';
    const fx = fixture({ toolHeartbeatMs: 25 });
    const handle = await fx.runtime.spawn('minion');
    try {
      const events = collect(handle);
      const turn = handle.prompt('tool:Bash please');
      await vi.waitFor(() => expect(handle.hasLiveProcess?.()).toBe(true), { timeout: 5_000 });
      await turn;
      expect(handle.hasLiveProcess?.()).toBe(false);
      const updates = events.filter(
        (event) => event.type === 'tool_update' && event.callId === 'toolu_double_1',
      );
      // Two input_json_delta partials plus periodic heartbeats while the
      // call stayed open — the heartbeat count must exceed the partials.
      expect(updates.length).toBeGreaterThanOrEqual(3);
    } finally {
      await handle.dispose();
    }
  });

  it('reassembles frames split mid-line and mid-multibyte-character (chunked stdout)', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('partial delivery');
      // The double suppresses partials here and chunk-writes the frames with
      // a 7-byte stride, so the assistant text arrives exactly once, intact:
      expect(deltas(events, 'text_delta')).toEqual(['héllo ★ partial world ☃']);
      expect(fx.logs.filter((l) => l.msg.includes('non-JSON'))).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it('skips blank/garbage lines with a warn log and drops a torn tail at EOF', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('garbage in, signal out');
      expect(deltas(events, 'text_delta').join('')).toBe('through the noise');
      const warns = fx.logs.filter((l) => l.level === 'warn' && l.msg.includes('non-JSON'));
      // "this is not json" + the torn tail '{"type":"resul'.
      expect(warns.length).toBe(2);
      expect(warns[0]!.fields!['line']).toBe('this is not json');
      expect(warns[1]!.fields!['line']).toBe('{"type":"resul');
    } finally {
      await handle.dispose();
    }
  });

  it('in-band error: result is_error resolves the prompt, sticky error state, next turn recovers #contract:in-band-error:claude-code', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('error please', { owner: 'alice' });
      const errors = events.filter((e) => e.type === 'error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect((errors[0] as { error: string }).error).toContain('double exploded');
      expect((errors[0] as { fatal: boolean }).fatal).toBe(false);
      expect(handle.health().state).toBe('error');
      // Recovers like pi (W7 parity): the next prompt works and ends idle.
      await handle.prompt('are you back?', { owner: 'alice' });
      expect(handle.health().state).toBe('idle');
      const st = states(events);
      expect(st).toContain('error');
      expect(st[st.length - 1]).toBe('idle');
    } finally {
      await handle.dispose();
    }
  });

  it('transport failure: non-zero exit without a result frame rejects with the stderr tail', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await expect(handle.prompt('crash now', { owner: 'alice' })).rejects.toThrow(
        /without a result frame.*double crash requested/s,
      );
      expect(handle.health().state).toBe('error');
      expect(events.some((e) => e.type === 'error')).toBe(true);
      expect(events.some((e) => e.type === 'turn_end')).toBe(false); // the turn never completed
      // The binary itself works — a turn crash is NOT adapter-down.
      expect(fx.runtime.health().state).toBe('ok');
      // The retry after a crash that never reached init RE-MINTS with
      // --session-id (the session never registered CLI-side) — never a
      // dangling --resume.
      await handle.prompt('recovered', { owner: 'alice' });
      expect(handle.health().state).toBe('idle');
      const invocations = doubleInvocations(fx);
      expect(invocations.length).toBe(2);
      expect(invocations[1]!.argv[invocations[1]!.argv.indexOf('--session-id') + 1]).toBe(
        handle.id,
      );
      expect(invocations[1]!.argv).not.toContain('--resume');
    } finally {
      await handle.dispose();
    }
  });

  it('a turn with no init frame is a protocol violation (identity never verified)', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      await expect(handle.prompt('no-init turn')).rejects.toThrow(/without an init frame/);
      expect(handle.health().state).toBe('error');
    } finally {
      await handle.dispose();
    }
  });

  it('protocol violation: exit 0 without a result frame rejects loudly', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      await expect(handle.prompt('no-result-ok')).rejects.toThrow(/without a result frame/);
      expect(handle.health().state).toBe('error');
    } finally {
      await handle.dispose();
    }
  });

  it('session-id mismatch on init kills the process and rejects (never a foreign session)', async () => {
    process.env['CLAUDE_DOUBLE_MISMATCH'] = '1';
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      await expect(handle.prompt('hello')).rejects.toThrow(/session id mismatch/);
      expect(handle.health().state).toBe('error');
    } finally {
      await handle.dispose();
    }
  });

  it('a concurrent prompt on the raw handle rejects loudly (the wrapper is the serializer)', async () => {
    const fx = fixture();
    const releaseFile = join(fx.home, 'release-me');
    const handle = await fx.runtime.spawn('gru');
    try {
      const first = handle.prompt(`hold:${releaseFile}`, { owner: 'alice' });
      await waitFor(() => handle.health().state === 'streaming');
      await expect(handle.prompt('me too', { owner: 'bob' })).rejects.toThrow(/turn in flight/);
      writeFileSync(releaseFile, 'go', 'utf-8');
      await first;
      expect(handle.health().state).toBe('idle');
    } finally {
      await handle.dispose();
    }
  });

  it('dispose mid-turn SIGTERMs the process: prompt rejects disposed, lock released #contract:dispose-releases-lock:claude-code', async () => {
    const fx = fixture();
    const releaseFile = join(fx.home, 'never-released');
    const handle = await fx.runtime.spawn('gru');
    const events = collect(handle);
    const turn = handle.prompt(`hold:${releaseFile}`, { owner: 'alice' });
    const rejected = expect(turn).rejects.toThrow(/disposed/);
    await waitFor(() => handle.health().state === 'streaming');
    const disposing = handle.dispose();
    const concurrentDispose = handle.dispose();
    expect(concurrentDispose).toBe(disposing);
    await Promise.all([disposing, concurrentDispose]);
    await rejected;
    expect(handle.health().state).toBe('disposed');
    expect(existsSync(`${handle.sessionFile}.lock`)).toBe(false);
    expect(states(events)[states(events).length - 1]).toBe('disposed');
  });

  it('a SIGTERM-immune process gets SIGKILL after the grace window', async () => {
    process.env['CLAUDE_DOUBLE_IGNORE_TERM'] = '1';
    const fx = fixture({ killGraceMs: 50 });
    const handle = await fx.runtime.spawn('gru');
    const turn = handle.prompt('hold:never', { owner: 'alice' });
    const rejected = expect(turn).rejects.toThrow(/disposed/);
    await waitFor(() => handle.health().state === 'streaming');
    const disposing = handle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(`${handle.sessionFile}.lock`)).toBe(true);
    await disposing;
    expect(existsSync(`${handle.sessionFile}.lock`)).toBe(false);
    // Settles only when the process actually dies — SIGKILL is the only
    // way out here, so this resolving at all proves the escalation fired.
    await rejected;
    await fx.runtime.dispose();
  });

  it('a missing binary fails spawn naming it and latches the adapter down; a good binary recovers', async () => {
    const fx = fixture();
    const missing = new ClaudeCodeRuntime({
      config: (fx.runtime as never as { config: never }).config,
      store: fx.store,
      binary: join(fx.home, 'no-such-claude'),
      reviewSettingsFile: join(fx.home, 'absent-review-settings.json'),
    });
    await expect(missing.spawn('gru')).rejects.toThrow(/no-such-claude/);
    expect(missing.health().state).toBe('down');
    expect(missing.health().note).toContain('no-such-claude');
    // The same runtime recovers once the binary works (re-probe per spawn).
    const handle = await fx.runtime.spawn('gru');
    expect(fx.runtime.health().state).toBe('ok');
    await handle.dispose();
  });

  it('rejects an empty prompt loudly before any process spawns', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      await expect(handle.prompt('')).rejects.toThrow(/empty prompt/);
      expect(doubleInvocations(fx)).toEqual([]); // nothing spawned
      // Images-only is a legitimate prompt (blocks without text).
      await handle.prompt('', { images: [{ mediaType: 'image/png', data: 'aGk=' }] });
      const invocations = doubleInvocations(fx);
      expect(invocations.length).toBe(1);
      expect(invocations[0]!.images).toBe(1);
    } finally {
      await handle.dispose();
    }
  });

  it('a mid-life binary vanish rejects the turn, latches down, and re-probes on recovery', async () => {
    const fx = fixture();
    const binary = join(fx.home, 'claude-copy.mjs');
    copyFileSync(DOUBLE, binary);
    chmodSync(binary, 0o755);
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      binary,
      reviewSettingsFile: join(fx.home, 'absent-review-settings.json'),
    });
    const handle = await runtime.spawn('gru');
    await handle.prompt('first turn fine');
    expect(runtime.health().state).toBe('ok');
    // The binary vanishes mid-life: the NEXT turn fails, the adapter
    // latches down, and the next spawn re-probes instead of trusting cache.
    rmSync(binary);
    await expect(handle.prompt('second turn')).rejects.toThrow(/failed to spawn/);
    expect(runtime.health().state).toBe('down');
    expect(runtime.health().note).toContain('vanished mid-run');
    copyFileSync(DOUBLE, binary);
    chmodSync(binary, 0o755);
    const recovered = await runtime.spawn('gru');
    expect(runtime.health().state).toBe('ok');
    await recovered.dispose();
    await handle.dispose();
  });

  it('declares claude-code capabilities honestly (steer queued, no followUp) #contract:capabilities:claude-code', () => {
    expect(CLAUDE_CODE_CAPABILITIES).toEqual({
      streaming: true,
      steer: 'queued',
      resume: 'file',
      images: true,
      thinking: true,
      thinkingLevelControl: true,
      followUp: false,
    });
    const fx = fixture();
    expect(fx.runtime.id).toBe('claude-code');
    expect(fx.runtime.capabilities).toEqual(CLAUDE_CODE_CAPABILITIES);
  });

  it('every Claude model accepts images and needs no provider — no catalog lookup gates vision', async () => {
    const fx = fixture();
    for (const model of [undefined, 'default', 'opus', 'claude-opus-5-5', 'anthropic/claude-opus-5-5']) {
      const handle = await fx.runtime.spawn('gru', model === undefined ? {} : { model });
      try {
        expect(handle.capabilities.images, String(model)).toBe(true);
        await handle.prompt('see this', { images: [{ mediaType: 'image/png', data: 'aGk=' }] });
        const record = doubleInvocations(fx).at(-1)!;
        expect(record.images).toBe(1);
        const cli = model === undefined || model === 'default' ? undefined : model.replace(/^anthropic\//u, '');
        expect(record.argv.includes('--model') ? record.argv[record.argv.indexOf('--model') + 1] : undefined).toBe(cli);
      } finally {
        await handle.dispose();
      }
    }
  });

  it('maps "default" to no flags and "provider/model" + level to --model/--effort #contract:model-resolution:claude-code', async () => {
    const fx = fixture();
    // default: neither flag leaves the adapter.
    const plain = await fx.runtime.spawn('gru');
    await plain.prompt('plain');
    await plain.dispose();
    // explicit: provider prefix stripped, effort passed through.
    const fancy = await fx.runtime.spawn('gru', {
      model: 'anthropic/claude-x',
      thinkingLevel: 'high',
    });
    await fancy.prompt('fancy');
    await fancy.dispose();
    // multi-segment: only the FIRST segment is the provider (Bedrock-style
    // dotted ids survive — the documented contract).
    const bedrock = await fx.runtime.spawn('gru', { model: 'bedrock/us.anthropic.claude-x' });
    await bedrock.prompt('bedrock');
    await bedrock.dispose();
    const [first, second, third] = doubleInvocations(fx);
    expect(first!.argv).not.toContain('--model');
    expect(first!.argv).not.toContain('--effort');
    const modelAt = second!.argv.indexOf('--model');
    expect(second!.argv[modelAt + 1]).toBe('claude-x');
    const effortAt = second!.argv.indexOf('--effort');
    expect(second!.argv[effortAt + 1]).toBe('high');
    expect(third!.argv[third!.argv.indexOf('--model') + 1]).toBe('us.anthropic.claude-x');
  });

  it('preflight and spawn pass identical native CLI model tokens without pi metadata', async () => {
    const fx = fixture();
    for (const ref of ['sonnet', 'claude-custom-v2', 'bedrock/us.anthropic.claude-x', 'default']) {
      // Preflight must use the same role policy as the subsequent spawn.
      writeFileSync(configPathFor(fx.home), `workspace_root = "${fx.workspace}"\n[models.roles]\nperkins = "${ref}"\n`);
      const config = loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester');
      const runtime = new ClaudeCodeRuntime({ config, store: fx.store, binary: DOUBLE, reviewSettingsFile: join(fx.home, 'absent-review-settings.json') });
      await runtime.checkReviewModel('perkins');
      const handle = await runtime.spawn('perkins');
      await handle.prompt('hello');
      await handle.dispose();
      const calls = doubleInvocations(fx).slice(-2);
      const modelToken = (argv: string[]) => argv[argv.indexOf('--model') + 1];
      expect(calls[0]?.argv.includes('--model')).toBe(ref !== 'default');
      expect(calls[1]?.argv.includes('--model')).toBe(ref !== 'default');
      if (ref !== 'default') {
        expect(modelToken(calls[0]!.argv)).toBe(modelToken(calls[1]!.argv));
        expect(modelToken(calls[0]!.argv)).toBe(ref.startsWith('bedrock/') ? ref.slice(8) : ref);
      }
    }
  });

  it('pins the user settings-selected default and env credential for probe, lead and lens without ambient settings', async () => {
    const fx = fixture();
    const settingsFile = join(fx.home, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({
      model: 'settings-sonnet', env: { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'settings-sonnet', NODE_OPTIONS: '--import=hostile' },
      hooks: { PreToolUse: [{ hooks: [{ command: 'hostile' }] }] },
    }));
    writeFileSync(configPathFor(fx.home), `workspace_root = "${fx.workspace}"\n[runtimes]\ndefault = "claude-code"\n`);
    const config = loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester');
    const registry = new RuntimeRegistry({ config, store: fx.store, claude: { binary: DOUBLE, reviewSettingsFile: settingsFile } });
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'] = 'settings-sonnet';
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'] = 'env';
    const reviewModel = await registry.prepareReviewModel('perkins');
    expect(reviewModel).toBeDefined();
    // An edit after preflight cannot switch the model/credentials mid-review.
    writeFileSync(settingsFile, JSON.stringify({ model: 'different-model', env: { ANTHROPIC_API_KEY: 'changed' } }));
    for (const mode of ['reviewLead', 'isolatedReview'] as const) {
      const handle = await registry.spawn('perkins', { [mode]: { systemPrompt: 'frozen review', tools: [] }, reviewModel });
      try {
        await handle.prompt('review');
      } finally {
        await handle.dispose();
      }
    }
    await registry.dispose();
    const calls = doubleInvocations(fx);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.argv).not.toContain('--model');
      const settingsPath = call.argv[call.argv.indexOf('--settings') + 1]!;
      expect(settingsPath).not.toBe(settingsFile);
      expect(existsSync(settingsPath)).toBe(false);
    }
  });

  it('runs a relative credential helper only in the trusted settings directory, never in the review tree', async () => {
    const fx = fixture();
    const settingsFile = join(fx.home, 'settings.json');
    const trustedMarker = join(fx.home, 'helper-ran');
    const hostileMarker = join(fx.home, 'hostile-ran');
    const helperName = 'review-key-helper';
    writeFileSync(join(fx.home, helperName), `#!/bin/sh\nprintf helper-key\ntouch "${trustedMarker}"\n`);
    chmodSync(join(fx.home, helperName), 0o700);
    writeFileSync(join(fx.workspace, helperName), `#!/bin/sh\ntouch "${hostileMarker}"\nprintf hostile-key\n`);
    chmodSync(join(fx.workspace, helperName), 0o700);
    writeFileSync(settingsFile, JSON.stringify({ apiKeyHelper: `./${helperName}`, model: 'settings-custom-id' }));
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'), store: fx.store,
      binary: DOUBLE, reviewSettingsFile: settingsFile,
    });
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'] = 'settings-custom-id';
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'] = 'helper';
    const reviewModel = await runtime.prepareReviewModel('perkins');
    expect(existsSync(trustedMarker)).toBe(true);
    // Rotating the source after preflight must not execute another helper.
    rmSync(trustedMarker);
    writeFileSync(settingsFile, JSON.stringify({ apiKeyHelper: './not-present' }));
    await expect(runtime.spawn('perkins', {
      model: 'different-model', isolatedReview: { systemPrompt: 'lens', tools: [] }, reviewModel,
    })).rejects.toThrow(/differs from the preflighted model/);
    for (const mode of ['reviewLead', 'isolatedReview'] as const) {
      const handle = await runtime.spawn('perkins', {
        cwd: fx.workspace, [mode]: { systemPrompt: 'review', tools: [], nativeTools: [] }, reviewModel,
      });
      try { await handle.prompt('review'); } finally { await handle.dispose(); }
    }
    expect(existsSync(hostileMarker)).toBe(false);
    expect(existsSync(trustedMarker)).toBe(false);
    expect(doubleInvocations(fx)).toHaveLength(3);
  });

  it('preserves settings OAuth credentials through probe, lead and lens without an inherited API key', async () => {
    const fx = fixture();
    const settingsFile = join(fx.home, 'oauth-settings.json');
    writeFileSync(settingsFile, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-token' } }));
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'), store: fx.store,
      binary: DOUBLE, reviewSettingsFile: settingsFile,
    });
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'] = 'oauth';
    const snapshot = await runtime.prepareReviewModel('perkins');
    expect(snapshot.authEnv['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth-test-token');
    writeFileSync(settingsFile, '{}');
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'rotated-token';
    for (const mode of ['reviewLead', 'isolatedReview'] as const) {
      const handle = await runtime.spawn('perkins', { [mode]: { systemPrompt: 'review', tools: [] }, reviewModel: snapshot });
      try { await handle.prompt('review'); } finally { await handle.dispose(); }
    }
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    expect(doubleInvocations(fx)).toHaveLength(3);
  });

  it('direct isolated overrides honor native model tokens and pin the supplied snapshot', async () => {
    const fx = fixture();
    const settingsFile = join(fx.home, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'test-key' } }));
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'), store: fx.store,
      binary: DOUBLE, reviewSettingsFile: settingsFile,
    });
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'] = 'env';
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'] = 'sonnet';
    const direct = await runtime.spawn('perkins', {
      model: 'anthropic/sonnet', isolatedReview: { systemPrompt: 'lens', tools: [] },
    });
    try { await direct.prompt('review'); } finally { await direct.dispose(); }
    writeFileSync(configPathFor(fx.home), `workspace_root = "${fx.workspace}"\n[models.roles]\nperkins = "anthropic/sonnet"\n`);
    const configured = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'), store: fx.store,
      binary: DOUBLE, reviewSettingsFile: settingsFile,
    });
    const original = await configured.prepareReviewModel('perkins');
    const equivalent = await configured.spawn('perkins', {
      model: 'sonnet', reviewModel: original, reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] },
    });
    try { await equivalent.prompt('review'); } finally { await equivalent.dispose(); }
    await expect(configured.spawn('perkins', {
      model: 'opus', reviewModel: original, isolatedReview: { systemPrompt: 'lens', tools: [] },
    })).rejects.toThrow(/differs from the preflighted model/);
    delete process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'];
    const defaultHandle = await runtime.spawn('perkins', {
      model: 'default', isolatedReview: { systemPrompt: 'lens', tools: [] },
    });
    try { await defaultHandle.prompt('review'); } finally { await defaultHandle.dispose(); }
    expect(doubleInvocations(fx).map((call) => call.argv.includes('--model'))).toEqual([true, true, true, false]);
  });

  it('rejects malformed credential JSON without disclosing its input in diagnostics', async () => {
    const fx = fixture();
    const settingsFile = join(fx.home, 'broken-settings.json');
    const secret = 'credential-canary-private';
    writeFileSync(settingsFile, `{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"${secret}"}, invalid}`);
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'), store: fx.store,
      binary: DOUBLE, reviewSettingsFile: settingsFile,
    });
    let detail = '';
    try { await runtime.prepareReviewModel('perkins'); }
    catch (error) { detail = String(error); }
    expect(detail).toContain('malformed Claude review model/auth settings JSON');
    expect(detail).not.toContain(secret);
    expect(doubleInvocations(fx)).toEqual([]);
  });

  it('cleans credential-bearing probe and failed bridge settings without spawning a session', async () => {
    const fx = fixture();
    const settingsFile = join(fx.home, 'credential-settings.json');
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'), store: fx.store,
      binary: DOUBLE, reviewSettingsFile: settingsFile,
    });
    // Confine credential settings dirs to this test's own TMPDIR: the
    // machine tmpdir is shared with other suites, other lanes, and the
    // live service, so a concurrent producer's live dir must never read
    // as this runtime's leak (same ownership rule as the bridge tests).
    const ownedTmp = mkdtempSync(join(tmpdir(), 'claude-settings-tmp-'));
    cleanupDirs.push(ownedTmp);
    const previousTmpdir = process.env['TMPDIR'];
    process.env['TMPDIR'] = ownedTmp;
    try {
      const newlyRetained = () =>
        readdirSync(ownedTmp).filter((name) => name.startsWith('gru-claude-review-')).sort();
      process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'] = 'env';
      writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'bad-key' } }));
      await expect(runtime.prepareReviewModel('perkins')).rejects.toThrow(/not configured\/authed/);
      expect(newlyRetained()).toEqual([]);
      writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'test-key' } }));
      const snapshot = await runtime.prepareReviewModel('perkins');
      expect(newlyRetained()).toEqual([]);
      const goodProbe = doubleInvocations(fx)[0]!;
      const settingsPath = goodProbe.argv[goodProbe.argv.indexOf('--settings') + 1]!;
      // The probe must have used the owned root, or the scoped scan above
      // could go blind instead of catching a genuine retained dir.
      expect(settingsPath.startsWith(ownedTmp)).toBe(true);
      expect(existsSync(settingsPath)).toBe(false);
      await expect(runtime.spawn('perkins', {
        reviewModel: { ...snapshot, role: 'gru' },
        isolatedReview: { systemPrompt: 'lens', tools: [] },
      })).rejects.toThrow(/snapshot belongs to gru/);
      await expect(runtime.spawn('perkins', {
        reviewModel: snapshot,
        reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [
          // A general native name is allowed since #161; a malformed one
          // (space/case) is still rejected at bridge start.
          { name: 'bad name!', description: 'rejected', inputSchema: {}, execute: async () => ({ text: '' }) },
        ] },
      })).rejects.toThrow(/invalid or duplicate native tool name/);
      expect(newlyRetained()).toEqual([]);
      expect(doubleInvocations(fx)).toHaveLength(1);
      const recovered = await runtime.spawn('perkins', {
        reviewModel: snapshot, isolatedReview: { systemPrompt: 'lens', tools: [] },
      });
      try { await recovered.prompt('review'); } finally { await recovered.dispose(); }
      expect(newlyRetained()).toEqual([]);
      expect(doubleInvocations(fx)).toHaveLength(2);
    } finally {
      if (previousTmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previousTmpdir;
    }
  });

  it('keeps concurrent and successive review proofs independent on the same Claude adapter', async () => {
    const fx = fixture();
    const settingsFile = join(fx.home, 'review-settings.json');
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'), store: fx.store,
      binary: DOUBLE, reviewSettingsFile: settingsFile,
    });
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'] = 'env';
    writeFileSync(settingsFile, JSON.stringify({ model: 'settings-A', env: { ANTHROPIC_MODEL: 'env-A', ANTHROPIC_API_KEY: 'test-key' } }));
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'] = 'env-A';
    const first = await runtime.prepareReviewModel('perkins');
    writeFileSync(settingsFile, JSON.stringify({ model: 'settings-B', env: { ANTHROPIC_MODEL: 'env-B', ANTHROPIC_API_KEY: 'test-key' } }));
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'] = 'env-B';
    const second = await runtime.prepareReviewModel('perkins');
    expect(first).not.toBe(second);
    for (const [snapshot, expected] of [[first, 'env-A'], [second, 'env-B'], [first, 'env-A']] as const) {
      process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'] = expected;
      const handle = await runtime.spawn('perkins', {
        reviewModel: snapshot, isolatedReview: { systemPrompt: 'lens', tools: [] },
      });
      try { await handle.prompt('review'); } finally { await handle.dispose(); }
      expect(doubleInvocations(fx).at(-1)?.argv).not.toContain('--model');
    }
    expect(doubleInvocations(fx)).toHaveLength(5);
  });

  it('lets Claude select native defaults in precedence order and keeps slash-containing settings IDs intact', async () => {
    const fx = fixture();
    const settingsFile = join(fx.home, 'review-settings.json');
    writeFileSync(settingsFile, JSON.stringify({ model: 'bedrock/us.anthropic.claude-x', env: { ANTHROPIC_API_KEY: 'test-key' } }));
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'), store: fx.store,
      binary: DOUBLE, reviewSettingsFile: settingsFile,
    });
    const ambient = process.env['ANTHROPIC_MODEL'];
    process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'] = 'env';
    try {
      process.env['ANTHROPIC_MODEL'] = 'native-env-model';
      process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'] = 'native-env-model';
      const fromEnv = await runtime.prepareReviewModel('perkins');
      expect(fromEnv.modelRef).toBe('default');
      // Changing the process default after preflight cannot change this round.
      delete process.env['ANTHROPIC_MODEL'];
      const envHandle = await runtime.spawn('perkins', {
        reviewModel: fromEnv, reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] },
      });
      try { await envHandle.prompt('review'); } finally { await envHandle.dispose(); }
      expect(doubleInvocations(fx).at(-1)?.argv).not.toContain('--model');
      process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'] = 'bedrock/us.anthropic.claude-x';
      const fromSettings = await runtime.prepareReviewModel('perkins');
      const settingsHandle = await runtime.spawn('perkins', {
        reviewModel: fromSettings, isolatedReview: { systemPrompt: 'lens', tools: [] },
      });
      try { await settingsHandle.prompt('review'); } finally { await settingsHandle.dispose(); }
      expect(doubleInvocations(fx).at(-1)?.argv).not.toContain('--model');
    } finally {
      if (ambient === undefined) delete process.env['ANTHROPIC_MODEL'];
      else process.env['ANTHROPIC_MODEL'] = ambient;
    }
    expect(doubleInvocations(fx)).toHaveLength(4);
  });

  it('rejects a native CLI that cannot authenticate even when metadata is optional', async () => {
    const fx = fixture();
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      binary: join(fx.home, 'missing-claude'),
      reviewSettingsFile: join(fx.home, 'absent-review-settings.json'),
    });
    await expect(runtime.checkReviewModel('perkins')).rejects.toThrow(/claude-code is not configured\/authed/);
  });

  it('rejects an installed CLI that exits nonzero with an auth or model error on stderr', async () => {
    const fx = fixture();
    const binary = join(fx.home, 'failing-claude');
    writeFileSync(binary, '#!/bin/sh\necho "invalid credentials for selected model" >&2\nexit 23\n');
    chmodSync(binary, 0o755);
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      binary,
      reviewSettingsFile: join(fx.home, 'absent-review-settings.json'),
    });
    await expect(runtime.checkReviewModel('perkins')).rejects.toThrow(
      /claude-code is not configured\/authed for the review model: invalid credentials for selected model/,
    );
  });

  it('registry preflight uses the perkins runtime override, not the default pi adapter', async () => {
    const fx = fixture();
    writeFileSync(configPathFor(fx.home),
      `workspace_root = "${fx.workspace}"\n[runtimes]\ndefault = "pi"\n[runtimes.roles]\nperkins = "claude-code"\n[models.roles]\nperkins = "sonnet"\n`);
    const config = loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester');
    const registry = new RuntimeRegistry({ config, store: fx.store, claude: { binary: DOUBLE, reviewSettingsFile: join(fx.home, 'absent-review-settings.json') } });
    try {
      expect(registry.runtimeIdFor('gru')).toBe('pi');
      expect(registry.runtimeIdFor('perkins')).toBe('claude-code');
      await expect(registry.checkReviewModel('perkins')).resolves.toBeUndefined();
      const handle = await registry.spawn('perkins');
      await handle.prompt('review');
      await handle.dispose();
      const calls = doubleInvocations(fx);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.argv[call.argv.indexOf('--model') + 1]).toBe('sonnet');
      }
    } finally {
      await registry.dispose();
    }
  });

  it('fails loud on malformed model references', async () => {
    const fx = fixture();
    // Native CLI aliases are legitimate even when absent from pi metadata.
    const native = await fx.runtime.spawn('gru', { model: 'badshape' });
    await native.prompt('hello');
    await native.dispose();
    expect(doubleInvocations(fx).at(-1)?.argv).toContain('badshape');
    await expect(fx.runtime.spawn('gru', { model: 'anthropic/' })).rejects.toThrow(
      /model reference/,
    );
    await expect(fx.runtime.spawn('gru', { model: '/orphan' })).rejects.toThrow(
      /model reference/,
    );
    expect(fx.runtime.health().state).toBe('ok'); // caller-facing, never latched
  });

  it('fails loud on thinking levels claude cannot express (ruling 16)', async () => {
    const fx = fixture();
    await expect(fx.runtime.spawn('gru', { thinkingLevel: 'minimal' })).rejects.toThrow(
      /unknown thinking level "minimal" for claude-code \(valid: default, low, medium, high, xhigh, max, ultracode\)/,
    );
    expect(fx.runtime.health().state).toBe('ok');
  });

  it('sends images as base64 content blocks in the stdin frame; plain text stays a string #contract:images:claude-code', async () => {
    const fx = fixture();
    const withImage = await fx.runtime.spawn('gru');
    await withImage.prompt('look at this', {
      images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
    });
    await withImage.dispose();
    const plainText = await fx.runtime.spawn('gru');
    await plainText.prompt('just words');
    await plainText.dispose();
    const [img, plain] = doubleInvocations(fx);
    expect(img!.images).toBe(1);
    const imgFrame = JSON.parse(img!.stdin.trim()) as {
      type: string;
      message: { role: string; content: unknown };
    };
    expect(imgFrame.type).toBe('user');
    expect(imgFrame.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'text', text: 'look at this' },
    ]);
    const plainFrame = JSON.parse(plain!.stdin.trim()) as { message: { content: unknown } };
    expect(plainFrame.message.content).toBe('just words');
  });

  it('plumbs cwd, permission mode, role tools, and the role system prompt into argv', async () => {
    const fx = fixture();
    const perkins = await fx.runtime.spawn('perkins');
    await perkins.prompt('review this');
    await perkins.dispose();
    const minion = await fx.runtime.spawn('minion');
    await minion.prompt('build this');
    await minion.dispose();
    const [review, build] = doubleInvocations(fx);
    // macOS tmpdir resolves through /private — compare realpaths.
    expect(realpathSync(review!.cwd)).toBe(realpathSync(fx.workspace));
    expect(realpathSync(build!.cwd)).toBe(realpathSync(fx.workspace));
    for (const record of [review!, build!]) {
      expect(record.argv).toContain('-p');
      expect(record.argv.join(' ')).toContain('--output-format stream-json');
      expect(record.argv.join(' ')).toContain('--input-format stream-json');
      expect(record.argv.join(' ')).toContain('--include-partial-messages');
      // No ambient MCP by default. The CLI replay echo is never used: it
      // would echo permission control_responses into the verification channel.
      expect(record.argv).not.toContain('--replay-user-messages');
      expect(record.argv).toContain('--strict-mcp-config');
      expect(record.argv).not.toContain('--mcp-config');
      expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
      const sysAt = record.argv.indexOf('--append-system-prompt');
      expect(record.argv[sysAt + 1]!.length).toBeGreaterThan(20);
      expect(record.argv[record.argv.indexOf('--session-id') + 1]).toBe(record.sessionId);
    }
    expect(review!.argv[review!.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(build!.argv[build!.argv.indexOf('--tools') + 1]).toBe('Read,Bash,Edit,Write,Grep,Glob');
    // Issue #161: a child worker's bounded authority reaches the CLI's
    // own --tools allowlist, and its product-owned identity is honored.
    const child = await fx.runtime.spawn('minion', {
      agentId: 'child-owned-id',
      roleTools: ['read', 'grep', 'find', 'ls'],
    });
    expect(child.id).toBe('child-owned-id');
    await child.prompt('audit this');
    await child.dispose();
    const childInvocation = doubleInvocations(fx).at(-1)!;
    expect(childInvocation.argv[childInvocation.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    // An override can only NARROW: an undeclared tool refuses loud.
    await expect(
      fx.runtime.spawn('perkins', { roleTools: ['undeclared-tool'] }),
    ).rejects.toThrowError(/role tool override names "undeclared-tool"/);
    // Issue #161 declared capability gap: non-review product-native tools
    // cannot be hosted on claude-code (the MCP bridge is a discoverable
    // same-uid socket); the refusal is loud, never a silent unhosted tool.
    await expect(
      fx.runtime.spawn('minion', {
        nativeTools: [
          {
            name: 'request_child_worker',
            description: 'x',
            inputSchema: { type: 'object' },
            execute: async () => ({ text: '' }),
          },
        ],
      }),
    ).rejects.toThrowError(/cannot host product-native non-review tools/);
    // The role prompt is the perkins/minion definition's own:
    expect(review!.argv[review!.argv.indexOf('--append-system-prompt') + 1]).toContain(
      'Whole-PR Review Lead',
    );
    expect(build!.argv[build!.argv.indexOf('--append-system-prompt') + 1]).toContain(
      'worker agent',
    );
  });

  it('default fallback reaches Claude CLI and MCP with no shell/edit/write authority', async () => {
    const fx = fixture();
    const dataDir = realpathSync(fx.home);
    const h = makeFallbackRuntimeHarness((role, opts) => registry.spawn(role, opts), dataDir);
    class ClaudeRegistry extends RuntimeRegistry { override runtimeIdFor() { return 'claude-code' as const; } }
    const registry = new ClaudeRegistry({ ...serviceRegistryOptions({ reviewOwnerCessation: NO_REVIEW_OWNER_LEDGER, config: loadConfig({ GRU_COMMAND_HOME: dataDir }), store: fx.store,
      workflowLaneFor: h.authority.workflowLaneFor, workflowBuildFor: h.authority.workflowBuildFor }),
      claude: { binary: DOUBLE, reviewSettingsFile: join(dataDir, 'absent-review-settings.json') },
    });
    try {
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback');
      expect(outcome.clearToMerge, outcome.note).toBe(true);
      const [record] = doubleInvocations(fx);
      const tools = record!.argv[record!.argv.indexOf('--tools') + 1]!;
      const allowed = record!.argv[record!.argv.indexOf('--allowedTools') + 1]!;
      expect(tools.split(',')).toEqual(['Read', 'Grep', 'Glob', 'mcp__gru_perkins__gc_submit_fallback_findings']);
      expect(allowed).toContain('mcp__gru_perkins__gc_submit_fallback_findings');
      expect(allowed).not.toMatch(/Bash|Edit|Write/u);
      expect(record!.argv).toContain('--strict-mcp-config');
      expect(record!.argv).not.toContain('--plugin-dir');
      expect(record!.argv[record!.argv.indexOf('--setting-sources') + 1]).toBe('');
      expect(record!.argv[record!.argv.indexOf('--system-prompt') + 1]).toContain('VERIFIED OWNED HELPER');
      expect(realpathSync(record!.cwd)).toBe(h.lane.path);
      expect(readFileSync(outcome.reportFiles[0]!, 'utf8').trim()).toBe('[]');
      expect(outcome.reportFiles[0]).toContain(join(dataDir, 'projects'));
      expect(readFileSync(join(h.lane.path, 'candidate.ts'), 'utf8')).toBe('export const candidate = 1;\n');
      expect(h.ledger.listRounds(h.job.id)).toEqual([]);
    } finally { await h.wave.shutdown(); await registry.dispose(); await fx.runtime.dispose(); h.close(); }
  });

  it('production owned workflow reaches Claude plugin/prompt/cwd and retains the same binding on resume', async () => {
    const fx = fixture(); const f = makeWorkflowLane(); cleanupDirs.push(f.root);
    const config = loadConfig({ GRU_COMMAND_HOME: f.dataDir });
    mkdirSync(join(f.lane.path, '_bmad/custom'), { recursive: true });
    writeFileSync(join(f.lane.path, '_bmad/custom/config.toml'), 'NOT TOML');
    class ClaudeRegistry extends RuntimeRegistry { override runtimeIdFor() { return 'claude-code' as const; } }
    const claude = new ClaudeRegistry({ ...serviceRegistryOptions({ reviewOwnerCessation: NO_REVIEW_OWNER_LEDGER, config, store: new SessionStore(f.dataDir),
      workflowLaneFor: () => f.lane }), claude: { binary: DOUBLE } });
    const first = await claude.spawn('minion', { cwd: f.lane.path, agentId: 'same-worker' });
    try {
      await first.prompt('build'); await first.dispose();
      const resumed = await claude.spawn('minion', { agentId: 'same-worker', resumeFile: first.sessionFile! });
      try { expect(resumed.id).toBe(first.id); await resumed.prompt('continue'); } finally { await resumed.dispose(); }
      const [build, resume] = doubleInvocations(fx);
      expect(resume!.argv).toContain('--resume');
      const plugin = build!.argv[build!.argv.indexOf('--plugin-dir') + 1]!;
      expect(plugin).toContain(join(f.dataDir, 'bmad-runtime/gru-command-workflows-'));
      for (const turn of [build!, resume!]) {
        expect(turn.cwd).toBe(f.lane.path);
        expect(turn.argv[turn.argv.indexOf('--plugin-dir') + 1]).toBe(plugin);
        const note = turn.argv[turn.argv.indexOf('--append-system-prompt') + 1]!;
        expect(note).toContain('`gru-command-workflows:gc-build`');
        expect(note).toContain(join(f.dataDir, 'projects'));
        expect(note).toContain(join(f.lane.path, 'gru-output'));
        expect(note).toContain('workflow-context.json');
        // Bound-workflow boundary (native r2 blocker): the appended prompt
        // composes the corrected role plus the note, qualifying owner-held
        // merges to final PR merges only.
        expect(note).toContain('worker agent');
        expect(note).toContain('merge main into your task branch');
        expect(note).toContain('final PR merges remain owner-held');
        expect(note).not.toContain('READY; merges remain owner-held');
      }
      expect(readFileSync(join(f.lane.path, '_bmad/custom/config.toml'), 'utf8')).toBe('NOT TOML');
      expect(existsSync(join(f.lane.path, '_bmad/render'))).toBe(false);
    } finally { await first.dispose(); await claude.dispose(); }
  });

  it('a lane-bound managed BMAD runtime loads as a session plugin named in the prompt; reviews never get it', async () => {
    const fx = fixture();
    const managedSkills = {
      source: 'gru-command-bmad',
      runtimeId: 'bmad-method@6.12.0+gru-command-bmad.1',
      contentSha256: 'b'.repeat(64),
      root: join(fx.workspace, 'runtime-root'),
      skillsDir: join(fx.workspace, 'runtime-root', 'skills'),
      skills: ['bmad-build'],
      laneBound: true,
    };
    const minion = await fx.runtime.spawn('minion', { managedSkills });
    await minion.prompt('build this');
    await minion.prompt('keep building');
    await minion.dispose();
    const review = await fx.runtime.spawn('perkins', {
      managedSkills,
      isolatedReview: { systemPrompt: 'isolated policy', tools: [] },
    });
    await review.prompt('frozen diff only');
    await review.dispose();
    const [build, resumed, isolated] = doubleInvocations(fx);
    // Every turn re-launches the CLI; the resumed turn keeps the plugin too.
    expect(resumed!.argv).toContain('--resume');
    for (const turn of [build!, resumed!]) expect(turn.argv[turn.argv.indexOf('--plugin-dir') + 1]).toBe(managedSkills.root);
    const prompt = build!.argv[build!.argv.indexOf('--append-system-prompt') + 1]!;
    expect(prompt).toContain('worker agent');
    expect(prompt).toContain('## Gru Command BMAD runtime');
    expect(prompt).toContain('`gru-command-bmad:bmad-build`');
    expect(prompt).toContain('not a repo-local or global skill with the same base name');
    expect(isolated!.argv).not.toContain('--plugin-dir');
    expect(isolated!.argv[isolated!.argv.indexOf('--system-prompt') + 1]).toBe('isolated policy');
  });

  it('enforces isolated-review tools and disables ambient Claude resources in argv #contract:isolated-review-tools:claude-code', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('perkins', {
      isolatedReview: { systemPrompt: 'isolated policy', tools: [] },
    });
    await handle.prompt('frozen diff only');
    await handle.dispose();
    const [record] = doubleInvocations(fx);
    expect(record!.argv[record!.argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(record!.argv[record!.argv.indexOf('--tools') + 1]).toBe('');
    expect(record!.argv[record!.argv.indexOf('--system-prompt') + 1]).toBe('isolated policy');
    expect(record!.argv).not.toContain('--append-system-prompt');
    expect(record!.argv).toEqual(expect.arrayContaining([
      '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '', '--no-chrome',
    ]));
    // --safe-mode / --bare disable every MCP server, including the review bridge.
    expect(record!.argv).not.toContain('--safe-mode');
    expect(record!.argv).not.toContain('--bare');
    expect(record!.argv[record!.argv.indexOf('--setting-sources') + 1]).toBe('');
    expect(record!.argv).not.toContain('--allowedTools');
    expect(handle.reviewIsolation).toBe(true);
  });

  it('starts a scoped bridge for an isolated lens child declaring native tools, exposing exactly them #contract:review-native-tools:claude-code', async () => {
    const fx = fixture();
    const executed: unknown[] = [];
    const submitFindings = {
      name: 'perkins_submit_findings',
      description: 'submit structured lens findings',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['findings'],
        properties: { findings: { type: 'array' } },
      },
      execute: async (input: unknown) => {
        executed.push(input);
        return { text: JSON.stringify({ accepted: true }), details: { accepted: true } };
      },
    };
    const handle = await fx.runtime.spawn('perkins', {
      cwd: fx.workspace,
      isolatedReview: {
        systemPrompt: 'lens policy',
        tools: ['read', 'grep', 'find', 'ls'],
        nativeTools: [submitFindings],
      },
    });
    let bridgeDirectory: string | null = null;
    try {
      await handle.prompt('frozen lenses only');
      const [record] = doubleInvocations(fx);
      // File tools stay the declared read set, mapped to claude built-ins;
      // the enabled list also names the one bridged MCP tool.
      expect((record!.argv[record!.argv.indexOf('--tools') + 1] ?? '').split(',')).toEqual([
        'Read', 'Grep', 'Glob', 'mcp__gru_perkins__perkins_submit_findings',
      ]);
      const configFile = record!.argv[record!.argv.indexOf('--mcp-config') + 1]!;
      bridgeDirectory = dirname(configFile);
      // The allowed native surface is EXACTLY the one declared tool — never
      // the lead's orchestration tools.
      const allowed = (record!.argv[record!.argv.indexOf('--allowedTools') + 1] ?? '').split(',');
      expect(allowed.filter((tool) => tool.startsWith('mcp__'))).toEqual([
        'mcp__gru_perkins__perkins_submit_findings',
      ]);
      for (const leadTool of [
        'perkins_run_specialists', 'perkins_store_artifact',
        'perkins_preflight_submission', 'perkins_submit_review',
      ]) {
        expect(allowed.join(',')).not.toContain(leadTool);
      }
      // The bridge itself exposes exactly the declared set...
      const listed = await bridgeProbe(configFile, '__list__', {}) as Array<{ name: string; description: string }>;
      expect(listed.map((tool) => tool.name)).toEqual(['perkins_submit_findings']);
      expect(listed[0]!.description).toBe('submit structured lens findings');
      // ...and dispatches calls to the declared callback over the wire.
      await expect(bridgeProbe(configFile, 'perkins_submit_findings', { findings: [] })).resolves.toEqual({
        text: JSON.stringify({ accepted: true }),
        details: { accepted: true },
      });
      expect(executed).toEqual([{ findings: [] }]);
    } finally {
      await handle.dispose();
    }
    // Teardown: the bridge owns its temporary directory and removes it.
    expect(bridgeDirectory).not.toBeNull();
    expect(existsSync(bridgeDirectory!)).toBe(false);
  });

  it('starts no bridge and no native allow-list for an isolated review declaring no native tools', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('perkins', {
      cwd: fx.workspace,
      isolatedReview: { systemPrompt: 'lens policy', tools: ['read', 'grep', 'find', 'ls'] },
    });
    try {
      await handle.prompt('file tools only');
      const [record] = doubleInvocations(fx);
      expect(record!.argv).not.toContain('--mcp-config');
      const allowed = (record!.argv[record!.argv.indexOf('--allowedTools') + 1] ?? '').split(',');
      expect(allowed.map((entry) => entry.split('(')[0])).toEqual(['Read', 'Grep', 'Glob']);
      expect(allowed.some((entry) => entry.startsWith('mcp__'))).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it('keeps one bridge per child session and closes every bridge on dispose', async () => {
    const fx = fixture();
    const handles: AgentHandle[] = [];
    const configFiles: string[] = [];
    try {
      // Concurrency note: a hybrid round runs as many concurrent lens
      // children as its admitted wave allows (the catalog has nine lenses);
      // each gets its OWN bridge, and none may outlive its session.
      for (let index = 0; index < 9; index += 1) {
        const handle = await fx.runtime.spawn('perkins', {
          cwd: fx.workspace,
          isolatedReview: {
            systemPrompt: `lens ${index}`,
            tools: ['read'],
            nativeTools: [{
              name: `perkins_child_${index}`,
              description: `child ${index}`,
              inputSchema: { type: 'object' },
              execute: async () => ({ text: 'ok' }),
            }],
          },
        });
        handles.push(handle);
        await handle.prompt(`child turn ${index}`);
        const records = doubleInvocations(fx);
        const record = records[records.length - 1]!;
        const configFile = record.argv[record.argv.indexOf('--mcp-config') + 1]!;
        configFiles.push(configFile);
        expect(existsSync(dirname(configFile))).toBe(true);
      }
      // Distinct bridges, one per child — never a shared cross-child bridge.
      expect(new Set(configFiles).size).toBe(9);
      for (let index = 0; index < 9; index += 1) {
        const listed = await bridgeProbe(configFiles[index]!, '__list__', {}) as Array<{ name: string }>;
        expect(listed.map((tool) => tool.name)).toEqual([`perkins_child_${index}`]);
      }
    } finally {
      await Promise.all(handles.map((handle) => handle.dispose()));
    }
    for (const configFile of configFiles) expect(existsSync(dirname(configFile))).toBe(false);
  });

  it('closes the scoped bridge when the spawn fails after the bridge started', async () => {
    const fx = fixture();
    // Deterministic post-bridge failure: a FILE occupies the role's session
    // directory path, so the scaffold mkdir fails only AFTER the scoped
    // bridge was started — cleanup must still own the bridge's teardown.
    const sessionDir = fx.store.sessionDirFor('perkins', fx.workspace);
    mkdirSync(dirname(sessionDir), { recursive: true });
    writeFileSync(sessionDir, 'not a directory');
    // Confine bridge temp dirs to this test's own TMPDIR: the assertion can
    // never observe a concurrent worker's live bridge.
    const bridgeTmp = mkdtempSync(join(tmpdir(), 'claude-bridge-tmp-'));
    cleanupDirs.push(bridgeTmp);
    const previousTmpdir = process.env['TMPDIR'];
    process.env['TMPDIR'] = bridgeTmp;
    try {
      await expect(fx.runtime.spawn('perkins', {
        cwd: fx.workspace,
        isolatedReview: {
          systemPrompt: 'lens policy',
          tools: ['read'],
          nativeTools: [{
            name: 'perkins_submit_findings',
            description: 'submit structured lens findings',
            inputSchema: { type: 'object' },
            execute: async () => ({ text: 'ok' }),
          }],
        },
      })).rejects.toThrow(/EEXIST|file already exists, mkdir/);
      // The failed spawn left no bridge temp directory behind.
      expect(readdirSync(bridgeTmp)).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previousTmpdir;
    }
  });

  it('runs a whole-PR Perkins lead through the real Claude adapter and scoped MCP bridge', async () => {
    const fx = fixture();
    const repo = makeFixtureRepo('claude-perkins-whole');
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    process.env['CLAUDE_DOUBLE_WORKFLOW_CANDIDATE'] = '1';
    try {
      const frozen = freezeReviewInputs({
        roundId: 'claude-whole-round', repoPath: repo.path, artifactRoot: join(fx.home, 'review-artifacts'),
        baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'Acceptance: answer returns 43.',
      });
      const engine = new PerkinsWholeReview({
        spawner: (role, options) => fx.runtime.spawn(role, options),
        policy: loadPerkinsPolicy(),
      });
      const result = await engine.run({
        roundId: 'claude-whole-round', roundNumber: 1, frozenReview: frozen,
        movementRef: 'feature/review', noSpec: false,
      });
      expect(result.canonicalVerdict).toBe('READY TO MERGE');
      expect(result.specialistRuns.filter((run) => run.status === 'valid')).toHaveLength(9);
      const invocations = doubleInvocations(fx);
      expect(invocations).toHaveLength(10);
      const lead = invocations.find((record) => record.prompt.includes('COMPLETE FROZEN DIFF (the whole change under review)'));
      expect(lead).toBeDefined();
      const configFile = lead!.argv[lead!.argv.indexOf('--mcp-config') + 1];
      expect(configFile).toContain('mcp-config.json');
      const allowed = lead!.argv[lead!.argv.indexOf('--allowedTools') + 1] ?? '';
      expect(allowed).toContain('mcp__gru_perkins__perkins_run_specialists');
      expect(allowed).toContain('mcp__gru_perkins__perkins_submit_review');
      expect(allowed).toMatch(/Read\(\/.+\/\*\*\)/);
      expect(lead!.argv[lead!.argv.indexOf('--setting-sources') + 1]).toBe('');
      const bridgeDirectory = dirname(configFile ?? '');
      await vi.waitFor(() => expect(existsSync(bridgeDirectory)).toBe(false));
      expect(result.findings).toHaveLength(2);
      expect(result.findings[0]?.verification).toMatchObject({ disposition: 'confirmed' });
    } finally {
      await fx.runtime.dispose();
      repo.cleanup();
    }
  });

  it('gives an isolated child its own scoped bridge exposing exactly its declared native tools', async () => {
    const fx = fixture();
    const tool = {
      name: 'perkins_submit_findings',
      description: 'structured findings child tool',
      inputSchema: { type: 'object' },
      execute: async () => ({ text: 'ok' }),
    };
    const handle = await fx.runtime.spawn('perkins', {
      isolatedReview: { systemPrompt: 'isolated policy', tools: [], nativeTools: [tool] },
    });
    let bridgeDirectory: string | null = null;
    try {
      await handle.prompt('frozen diff only');
      const [record] = doubleInvocations(fx);
      const configIndex = record!.argv.indexOf('--mcp-config');
      expect(configIndex).toBeGreaterThan(-1);
      const configFile = record!.argv[configIndex + 1]!;
      bridgeDirectory = dirname(configFile);
      const allowed = record!.argv[record!.argv.indexOf('--allowedTools') + 1] ?? '';
      expect(allowed).toContain('mcp__gru_perkins__perkins_submit_findings');
      expect(allowed).not.toContain('mcp__gru_perkins__perkins_submit_review');
      expect(allowed).not.toContain('mcp__gru_perkins__perkins_run_lenses');
      expect(handle.reviewTools).toEqual(['perkins_submit_findings']);
      // The child bridge exposes exactly the declared tool, nothing more.
      const socketPath = (JSON.parse(readFileSync(configFile, 'utf8')) as {
        mcpServers: { gru_perkins: { env: { GRU_REVIEW_BRIDGE_SOCKET: string } } };
      }).mcpServers.gru_perkins.env.GRU_REVIEW_BRIDGE_SOCKET;
      const listed = await new Promise<string>((resolveResponse, reject) => {
        const socket = createConnection(socketPath);
        let body = '';
        socket.setEncoding('utf8');
        socket.once('connect', () => socket.write(`${JSON.stringify({ id: 'list', name: '__list__' })}\n`));
        socket.on('data', (chunk) => { body += chunk; });
        socket.once('error', reject);
        socket.once('end', () => resolveResponse(body));
      });
      const parsed = JSON.parse(listed) as { ok: boolean; result: Array<{ name: string }> };
      expect(parsed.ok).toBe(true);
      expect(parsed.result.map((entry) => entry.name)).toEqual(['perkins_submit_findings']);
    } finally {
      await handle.dispose();
    }
    await vi.waitFor(() => expect(existsSync(bridgeDirectory!)).toBe(false));
    // A child that declares no native tools gets no bridge at all.
    const textOnly = await fx.runtime.spawn('perkins', {
      isolatedReview: { systemPrompt: 'isolated policy', tools: [] },
    });
    try {
      await textOnly.prompt('frozen diff only');
      const record = doubleInvocations(fx).find((entry) => entry.sessionId === textOnly.id)!;
      expect(record.argv).not.toContain('--mcp-config');
      expect(textOnly.reviewTools).toBeUndefined();
    } finally {
      await textOnly.dispose();
    }
  });

  it('rejects resume for isolated reviews so ambient history cannot cross the boundary #contract:isolated-review-no-resume:claude-code', async () => {
    const fx = fixture();
    const ordinary = await fx.runtime.spawn('perkins');
    const file = ordinary.sessionFile!;
    await ordinary.dispose();
    await expect(fx.runtime.spawn('perkins', {
      resumeFile: file,
      isolatedReview: { systemPrompt: 'isolated', tools: [] },
    })).rejects.toThrow(/must be fresh/);
  });

  it('mapRoleTools maps every known role tool to a tool the CLI ships and fails loud on an unknown id', () => {
    // The CLI silently ignores unknown --tools names and no longer ships
    // `LS`: directory listing maps to Glob, listed once.
    expect(mapRoleTools('perkins', ['read', 'grep', 'find', 'ls'])).toEqual([
      'Read',
      'Grep',
      'Glob',
    ]);
    expect(mapRoleTools('perkins', ['ls'])).toEqual(['Glob']);
    expect(mapRoleTools('minion', ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])).toEqual([
      'Read',
      'Bash',
      'Edit',
      'Write',
      'Grep',
      'Glob',
    ]);
    expect(() => mapRoleTools('minion', ['nope'])).toThrow(
      /role "minion" tool "nope" has no claude-code tool mapping/,
    );
  });

  it('loads no ambient MCP servers by default; mcp = "user" opts in, but never for a narrowed tool set', async () => {
    const run = async (configToml: string, roleTools?: readonly string[]) => {
      const fx = fixture({ configToml });
      const lane = mkdtempSync(join(tmpdir(), 'gru-command-lane-'));
      cleanupDirs.push(lane);
      const handle = await fx.runtime.spawn('minion', { cwd: lane, ...(roleTools !== undefined ? { roleTools } : {}) });
      await handle.prompt('which servers');
      await handle.dispose();
      return doubleInvocations(fx).at(-1)!.argv;
    };
    const byDefault = await run('');
    expect(byDefault).toContain('--strict-mcp-config');
    expect(byDefault).not.toContain('--mcp-config');
    const user = await run('[runtimes.claude-code]\nmcp = "user"\n');
    expect(user).not.toContain('--strict-mcp-config');
    expect(user).not.toContain('--mcp-config');
    // A bounded child worker's narrowed tools are never widened by ambient MCP.
    const narrowed = await run('[runtimes.claude-code]\nmcp = "user"\n', ['read', 'grep', 'find', 'ls']);
    expect(narrowed).toContain('--strict-mcp-config');
    expect(narrowed).not.toContain('--mcp-config');
    const badHome = mkdtempSync(join(tmpdir(), 'gru-command-claude-'));
    cleanupDirs.push(badHome);
    writeFileSync(configPathFor(badHome), `workspace_root = "${badHome}"\n[runtimes.claude-code]\nmcp = "all"\n`, 'utf-8');
    expect(() => loadConfig({ GRU_COMMAND_HOME: badHome }, '/home/tester')).toThrow(
      /runtimes\.claude-code\.mcp must be one of "none", "project", "user", got "all"/,
    );
  });

  it('mcp = "project" hands the CLI a private copy of the .mcp.json committed at HEAD — re-checked every turn and compaction', async () => {
    const fx = fixture({ configToml: '[runtimes.claude-code]\nmcp = "project"\n' });
    const repo = makeFixtureRepo('mcp-project');
    try {
      const file = join(repo.path, '.mcp.json');
      const committed = JSON.stringify({ mcpServers: {} });
      const handle = await fx.runtime.spawn('minion', { cwd: repo.path });
      let copy = '';
      const mcpConfig = (argv: readonly string[]): string | null => {
        expect(argv).toContain('--strict-mcp-config');
        return argv.includes('--mcp-config') ? argv[argv.indexOf('--mcp-config') + 1]! : null;
      };
      const turn = async (): Promise<string | null> => {
        await handle.prompt('which servers');
        return mcpConfig(doubleInvocations(fx).at(-1)!.argv);
      };
      expect(await turn()).toBeNull(); // no file
      writeFileSync(file, committed);
      expect(await turn()).toBeNull(); // untracked: e.g. a session wrote it into its lane
      repo.git(['add', '.mcp.json']);
      expect(await turn()).toBeNull(); // staged, never committed
      repo.commitFile('.mcp.json', committed);
      copy = (await turn())!; // checked in: loads on the next turn, no respawn
      expect(copiesOf(handle.sessionFile!)).toEqual([copy]); // this handle's own copy beside the transcript
      // The CLI reads a private, owner-only copy of the verified bytes — never
      // the lane path a later write could swap.
      expect(readFileSync(copy, 'utf-8')).toBe(committed);
      expect(statSync(copy).mode & 0o777).toBe(0o600);
      // Compaction is a fresh CLI process too: it re-resolves the same way.
      await handle.compact?.();
      expect(doubleInvocations(fx).at(-1)!.prompt).toBe('/compact');
      expect(mcpConfig(doubleInvocations(fx).at(-1)!.argv)).toBe(copy);
      writeFileSync(file, JSON.stringify({ mcpServers: { injected: { command: 'sh' } } }));
      expect(await turn()).toBeNull(); // edited after commit
      expect(existsSync(copy)).toBe(false); // never a stale copy left to load
      repo.git(['add', '.mcp.json']);
      expect(await turn()).toBeNull(); // edit staged, not committed: still not HEAD's bytes
      repo.git(['reset', '-q', '--', '.mcp.json']);
      repo.git(['checkout', '--', '.mcp.json']);
      expect(await turn()).toBe(copy);
      rmSync(file);
      symlinkSync(join(repo.path, 'package.json'), file);
      expect(await turn()).toBeNull(); // a symlink never loads
      rmSync(file);
      expect(await turn()).toBeNull(); // removed mid-session: never a dangling --mcp-config
      writeFileSync(file, committed);
      expect(await turn()).toBe(copy);
      await handle.dispose();
      await vi.waitFor(() => expect(existsSync(copy)).toBe(false)); // the copy lives only as long as the session
      expect(fx.logs.filter((entry) => entry.msg.includes('no project MCP servers loaded')).map((entry) => entry.fields?.['reason'])).toEqual([
        'no .mcp.json in the session cwd',
        '.mcp.json is not committed at HEAD',
        '.mcp.json differs from its committed version',
        '.mcp.json is not a regular file (symlink or other)',
        'no .mcp.json in the session cwd',
      ]);
    } finally {
      repo.cleanup();
    }
  });

  it('an infrastructure failure of the project-MCP check is logged at warn; a content refusal at info', async () => {
    const fx = fixture({ configToml: '[runtimes.claude-code]\nmcp = "project"\n' });
    const plain = mkdtempSync(join(tmpdir(), 'gru-command-not-a-repo-'));
    cleanupDirs.push(plain);
    const handle = await fx.runtime.spawn('minion', { cwd: plain });
    await handle.prompt('no file yet');
    writeFileSync(join(plain, '.mcp.json'), '{}');
    await handle.prompt('git cannot read HEAD here');
    await handle.dispose();
    expect(fx.logs.filter((entry) => entry.msg === 'mcp = "project": no project MCP servers loaded')
      .map((entry) => [entry.level, String(entry.fields?.['reason']).split(':')[0]])).toEqual([
      ['info', 'no .mcp.json in the session cwd'],
      ['warn', 'git cannot read HEAD in the session cwd'],
    ]);
  });

  it('only a label-shaped server name is ever logged', () => {
    // Combining marks of every kind (NFD Latin, Devanagari vowel signs, an
    // enclosing mark), numbers of any kind (a digit, Ⅻ, ①) leading or not, a
    // digit-led plugin segment, the CLI's own connector collision suffix, an
    // 80-code-point name of astral letters, a 23-character run, one the Kelvin
    // sign continues (no case folding) and two 12-letter runs joined by '_'
    // (a run counts only ASCII letters and digits) are labels.
    for (const name of ['db', 'Upper_Case.v2 x', 'café', '数据', 'plugin:edgeplug:brokensrv', `${'ab-'.repeat(26)}ab`,
      'cafe\u0301', 'a\u20dd', '\u0921\u0947\u091f\u093e', '\u216B \u2460\u00BD', '1password', 'plugin:1p:2fa',
      '\u2460x', 'x\u216B', 'claude.ai Gmail (2)', '\u{20000}'.repeat(80), 'a'.repeat(23), `${'a'.repeat(23)}\u212A`,
      `${'a'.repeat(12)}_${'a'.repeat(12)}`]) {
      expect(loggableMcpServerName(name), name).toBe(true);
    }
    // Over 80 code points with no run (astral text within 160 UTF-16 units
    // too); a 24-character run of ASCII letters and digits in either case,
    // also split only by nonspacing, spacing or enclosing marks; a UUID in any
    // case, split by a mark or inside a longer name; a name that does not
    // start with a letter or number ('-', '_', a mark, a space, a symbol, a
    // control or format character); a plugin name whose segments are not
    // labels, that lacks its server segment or that does not start the name;
    // and any character outside the label — never a denylist.
    for (const name of ['', 'me@host', 'https://u:p@h/m', 'user:sk-secret', 'ok\nuser', 'a/b', '-lead',
      'plugin:a:b:c', 'plugin:x', 'plugin:_a:b', 'db.plugin:a:b', `ghp_${'a'.repeat(36)}`,
      '123e4567-e89b-12d3-a456-426614174000', `plugin:p:${'a'.repeat(24)}`, 'plugin:p:123e4567-e89b-12d3-a456-426614174000',
      `${'ab-'.repeat(27)}`, `${'\u{20000}'.repeat(79)}ab`,
      'a'.repeat(24), 'zZ9'.repeat(8), 'a\u0301'.repeat(24), 'a\u093e'.repeat(24), 'a\u20dd'.repeat(24),
      '123E4567-E89B-12D3-A456-426614174000', '123e4567-E89B-12d3-A456-4266141740aF',
      '123e\u03014567-e89b-12d3-a456-426614174000', 'db-123e4567-e89b-12d3-a456-426614174000',
      '\u0301a', '\u093ea', '\u20dda', '\na', '\u202ea', '@a', ' a', '.a', '(a', '+15551234567',
      '_internal', 'a+b=', 'a\u202eb', 'a\u2028b', 'a"b', 'a$b']) {
      expect(loggableMcpServerName(name), name).toBe(false);
    }
  });

  it('a server name over 160 UTF-16 units is refused before it is spread into code points', () => {
    // The CLI echoes a config key of any size. The long name is label-shaped
    // and run-free, so only the length can refuse it; a shorter name is
    // spread (the spy is live) — how often is the implementation's business.
    const iterate = String.prototype[Symbol.iterator];
    let spreads = 0;
    const seen: unknown[] = [];
    String.prototype[Symbol.iterator] = function (this: string) {
      spreads += 1;
      return iterate.call(this);
    };
    try {
      seen.push(loggableMcpServerName(`${'ab-'.repeat(53)}ab`), spreads, loggableMcpServerName('a'.repeat(23)), spreads > 0);
    } finally {
      String.prototype[Symbol.iterator] = iterate;
    }
    expect(seen).toEqual([false, 0, true, true]);
  });

  it('MCP servers the CLI could not load are logged by name — skipped ones with the CLI code, failed or sign-in-blocked ones with a fixed description — once per distinct set', async () => {
    const fx = fixture();
    const lane = mkdtempSync(join(tmpdir(), 'gru-command-lane-'));
    cleanupDirs.push(lane);
    const handle = await fx.runtime.spawn('minion', { cwd: lane });
    const problemLogs = () => fx.logs.filter((entry) => entry.msg === 'claude could not load some MCP servers');
    try {
      process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'] = JSON.stringify([
        { name: 'db', type: 'invalid_config', message: 'Skipped — invalid MCP server config for "db"' },
      ]);
      await handle.prompt('one');
      await handle.prompt('two'); // the same set: not logged again
      expect(problemLogs()).toHaveLength(1);
      expect(problemLogs()[0]).toMatchObject({ level: 'warn', fields: { servers: ['db: skipped (invalid_config)'], total: 1 } });
      delete process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'];
      await handle.prompt('three'); // cleared...
      process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'] = JSON.stringify([{ name: 'db', type: 'invalid_config', message: 'Skipped — invalid MCP server config for "db"' }]);
      await handle.prompt('four'); // ...so a recurrence is logged again
      expect(problemLogs()).toHaveLength(2);
      // A different set is logged too — never the CLI's free text (it pastes
      // rejected values in unescaped), only a code-shaped reason.
      process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'] = JSON.stringify([
        { name: 'api', type: 'invalid_config', message: 'url: invalid "https://user:sk-secret@example.invalid/mcp"' },
        { name: 'q-type', type: 'unknown_type', message: 'Skipped — unknown MCP server type "sk"secret-in-type" for server "q-type"' },
        { name: 'bare' },
        { name: 'odd', type: 'Not A Code: sk-secret' },
        { name: 'lc', type: 'invalid_config url "https://user:sk-secret@example.invalid/mcp"' },
        { name: 'sp', type: 'invalid config' },
        { name: 'colon', type: 'invalid:config' },
        { name: 'upper', type: 'Invalid_config' },
        { name: 'cap', type: 'abc_'.repeat(10) },
        { name: 'long', type: `${'abc_'.repeat(10)}a` },
        { name: 'tok', type: 'a'.repeat(24) },
        { name: 'uuid', type: 'a23e4567-e89b-12d3-a456-426614174000' },
        { name: 'https://user:sk-secret-in-name@host.invalid/mcp', type: 'invalid_config' },
        { name: 'Upper_Case.v2 x', type: 'invalid_config' },
        { name: `${'ab-'.repeat(27)}`, type: 'invalid_config' },
        'a bare string from the CLI with sk-secret',
      ]);
      await handle.prompt('five');
      expect(problemLogs()).toHaveLength(3);
      expect(problemLogs()[2]?.fields?.['servers']).toEqual(['api: skipped (invalid_config)', 'q-type: skipped (unknown_type)',
        'bare: skipped (unknown reason)', 'odd: skipped (unknown reason)', 'lc: skipped (unknown reason)',
        'sp: skipped (unknown reason)', 'colon: skipped (unknown reason)', 'upper: skipped (unknown reason)',
        `cap: skipped (${'abc_'.repeat(10)})`, 'long: skipped (unknown reason)', 'tok: skipped (unknown reason)',
        'uuid: skipped (unknown reason)',
        '(name withheld #1): skipped (invalid_config)',
        'Upper_Case.v2 x: skipped (invalid_config)', '(name withheld #2): skipped (invalid_config)', '?: skipped (unknown reason)']);
      expect(JSON.stringify(problemLogs())).not.toContain('sk-secret');
      // A server the CLI kept but could not start (status "failed": a missing
      // env var or a broken command) is logged too.
      delete process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'];
      process.env['CLAUDE_DOUBLE_MCP_SERVERS'] = JSON.stringify([{ name: 'ok', status: 'connected' }, { name: 'needs-env', status: 'failed' },
        { name: 'starting', status: 'pending' }, { name: 'connector', status: 'needs-auth', source: 'claudeai' },
        { name: 'off', status: 'disabled' }, { name: 'hosted', status: 'needs-auth', source: 'dynamic' },
        { name: 'https://user:sk-secret@host.invalid/mcp', status: 'failed', source: 'dynamic' },
        { name: 'plugin:edgeplug:brokensrv', status: 'failed', source: 'plugin' },
        { name: 'me@sk-secret.invalid', status: 'needs-auth', source: 'dynamic' }]);
      await handle.prompt('six');
      expect(problemLogs()[3]?.fields).toMatchObject({
        servers: ['needs-env: failed to start', 'hosted: needs authentication (a headless session cannot sign in)',
          '(name withheld #1): failed to start', 'plugin:edgeplug:brokensrv: failed to start',
          '(name withheld #2): needs authentication (a headless session cannot sign in)'], total: 5,
      });
      // A flood is capped: the first 20 entries plus the total.
      process.env['CLAUDE_DOUBLE_MCP_SERVERS'] = JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ name: `s${i}`, status: 'failed' })));
      await handle.prompt('seven');
      const flood = problemLogs()[4]?.fields as { servers: string[]; total: number };
      expect(flood.total).toBe(25);
      expect(flood.servers).toEqual(Array.from({ length: 20 }, (_, i) => `s${i}: failed to start`));
      // One init frame with both kinds (as the real CLI emits for one file):
      // skipped lines first, then failed ones.
      process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'] = JSON.stringify([{ name: 'x', type: 'invalid_config', message: 'header "sk-secret-in-message"' }]);
      process.env['CLAUDE_DOUBLE_MCP_SERVERS'] = JSON.stringify([{ name: 'ok', status: 'failed' }]);
      await handle.prompt('eight');
      expect(problemLogs()[5]?.fields).toMatchObject({ servers: ['x: skipped (invalid_config)', 'ok: failed to start'], total: 2 });
      // Two different sets whose names are both withheld are still two sets:
      // dedupe runs on the raw names (memory only), never the logged form.
      delete process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'];
      process.env['CLAUDE_DOUBLE_MCP_SERVERS'] = JSON.stringify([{ name: 'https://a:sk-secret@one.invalid/m', status: 'failed' }]);
      await handle.prompt('nine');
      process.env['CLAUDE_DOUBLE_MCP_SERVERS'] = JSON.stringify([{ name: 'https://b:sk-secret@two.invalid/m', status: 'failed' }]);
      await handle.prompt('ten');
      expect(problemLogs()).toHaveLength(8);
      expect(problemLogs()[7]?.fields).toMatchObject({ servers: ['(name withheld #1): failed to start'], total: 1 });
      // Within one entry a withheld name keeps one number...
      const c = 'https://c:sk-secret@three.invalid/m';
      const d = 'https://d:sk-secret@four.invalid/m';
      process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'] = JSON.stringify([{ name: c, type: 'invalid_config' }]);
      process.env['CLAUDE_DOUBLE_MCP_SERVERS'] = JSON.stringify([{ name: d, status: 'failed' }, { name: c, status: 'failed' }]);
      await handle.prompt('eleven');
      expect(problemLogs()).toHaveLength(9);
      expect(problemLogs()[8]?.fields).toMatchObject({ servers: ['(name withheld #1): skipped (invalid_config)',
        '(name withheld #2): failed to start', '(name withheld #1): failed to start'], total: 3 });
      // ...the same set in another order is not logged again, and only a
      // digest of the raw names is kept.
      process.env['CLAUDE_DOUBLE_MCP_SERVERS'] = JSON.stringify([{ name: c, status: 'failed' }, { name: d, status: 'failed' }]);
      await handle.prompt('twelve');
      expect(problemLogs()).toHaveLength(9);
      expect((handle as unknown as { mcpServerProblemsNote: string }).mcpServerProblemsNote).toMatch(/^[0-9a-f]{64}$/u);
      // The same names with a changed reason are a different set.
      process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'] = JSON.stringify([{ name: c, type: 'unknown_type' }]);
      await handle.prompt('thirteen');
      expect(problemLogs()).toHaveLength(10);
      expect(problemLogs()[9]?.fields).toMatchObject({ servers: ['(name withheld #1): skipped (unknown_type)',
        '(name withheld #1): failed to start', '(name withheld #2): failed to start'], total: 3 });
      expect(JSON.stringify(problemLogs())).not.toContain('sk-secret');
    } finally {
      delete process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'];
      delete process.env['CLAUDE_DOUBLE_MCP_SERVERS'];
      await handle.dispose();
    }
  });

  it('mcp = "project" never loads lane servers for a role without a shell', async () => {
    const fx = fixture({ configToml: '[runtimes.claude-code]\nmcp = "project"\n' });
    const repo = makeFixtureRepo('mcp-project-read-only');
    try {
      repo.commitFile('.mcp.json', JSON.stringify({ mcpServers: { lane: { command: 'sh' } } }));
      const reader = await fx.runtime.spawn('perkins', { cwd: repo.path });
      await reader.prompt('which servers');
      const argv = doubleInvocations(fx).at(-1)!.argv;
      expect(argv).toContain('--strict-mcp-config');
      expect(argv).not.toContain('--mcp-config');
      expect(copiesOf(reader.sessionFile!)).toEqual([]);
      await reader.dispose();
      expect(fx.logs.some((entry) => entry.msg === 'mcp = "project": a role without a shell loads no project MCP servers' &&
        entry.fields?.['role'] === 'perkins')).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('the project-MCP check names infrastructure failures and refuses a committed non-file', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'gru-command-not-a-repo-'));
    cleanupDirs.push(plain);
    writeFileSync(join(plain, '.mcp.json'), '{}');
    const outside = await checkedInProjectMcpConfig(plain);
    expect('reason' in outside && outside.reason).toMatch(/^git cannot read HEAD in the session cwd: .*not a git repository/u);
    expect(outside).toMatchObject({ infrastructure: true }); // logged at warn, never as a content refusal
    // An unreadable file or directory is an infrastructure failure, not "absent".
    const locked = makeFixtureRepo('mcp-project-locked');
    try {
      locked.commitFile('.mcp.json', '{}');
      chmodSync(join(locked.path, '.mcp.json'), 0o000);
      expect(await checkedInProjectMcpConfig(locked.path)).toMatchObject({ reason: expect.stringMatching(/^\.mcp\.json cannot be read: .*EACCES/u), infrastructure: true });
      chmodSync(join(locked.path, '.mcp.json'), 0o644);
      const inner = join(locked.path, 'inner');
      mkdirSync(inner);
      writeFileSync(join(inner, '.mcp.json'), '{}');
      chmodSync(inner, 0o000);
      expect(await checkedInProjectMcpConfig(inner)).toMatchObject({ reason: expect.stringMatching(/^\.mcp\.json cannot be inspected: .*EACCES/u), infrastructure: true });
      chmodSync(inner, 0o755);
    } finally {
      locked.cleanup();
    }
    // A committed blob git cannot read (its object is gone) is infrastructure too.
    const broken = makeFixtureRepo('mcp-project-missing-object');
    try {
      broken.commitFile('.mcp.json', '{"mcpServers":{"lost":{}}}');
      const oid = execFileSync('git', ['rev-parse', 'HEAD:.mcp.json'], { cwd: broken.path, encoding: 'utf8' }).trim();
      rmSync(join(broken.path, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
      expect(await checkedInProjectMcpConfig(broken.path)).toMatchObject({
        reason: expect.stringMatching(/^git cannot read the committed \.mcp\.json: /u), infrastructure: true,
      });
    } finally {
      broken.cleanup();
    }
    // A failed git run is named by its first stderr line, else its signal, else its message.
    expect(gitFailure({ stderr: Buffer.from('fatal: bad object\nmore'), signal: null, message: 'Command failed' })).toBe('fatal: bad object');
    expect(gitFailure({ stderr: Buffer.from(''), signal: 'SIGTERM', message: 'Command failed' })).toBe('git killed by SIGTERM');
    expect(gitFailure({ message: 'spawn git ENOENT' })).toBe('spawn git ENOENT');
    const repo = makeFixtureRepo('mcp-project-committed-link');
    try {
      symlinkSync('package.json', join(repo.path, '.mcp.json'));
      repo.git(['add', '.mcp.json']);
      repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-q', '-m', 'link']);
      rmSync(join(repo.path, '.mcp.json'));
      writeFileSync(join(repo.path, '.mcp.json'), '{}');
      expect(await checkedInProjectMcpConfig(repo.path)).toEqual({ reason: 'the committed .mcp.json is not a regular file' });
    } finally {
      repo.cleanup();
    }
  });

  it('holds the session slot across the async project-MCP check and never spawns after disposal', async () => {
    const fx = fixture({ configToml: '[runtimes.claude-code]\nmcp = "project"\n' });
    const repo = makeFixtureRepo('mcp-project-slot');
    try {
      repo.commitFile('.mcp.json', JSON.stringify({ mcpServers: {} }));
      const handle = await fx.runtime.spawn('minion', { cwd: repo.path });
      await handle.prompt('establish the session');
      expect(handle.canCompact?.()).toBe(true);
      const first = handle.prompt('first');
      await expect(handle.prompt('second')).rejects.toThrow(/one operation at a time/);
      expect(handle.canCompact?.()).toBe(false);
      await expect(handle.compact!()).rejects.toThrow(/requires an idle session/);
      await first;
      const before = doubleInvocations(fx).length;
      const late = expect(handle.prompt('raced by disposal')).rejects.toThrow('agent session disposed');
      await handle.dispose();
      await late;
      expect(handle.pendingTurn?.()).toBeNull(); // nothing spawned: no pending turn survives disposal
      expect(doubleInvocations(fx)).toHaveLength(before);
      // The check that finished after disposal leaves no copy behind.
      await vi.waitFor(() => expect(copiesOf(handle.sessionFile!)).toEqual([]));
    } finally {
      repo.cleanup();
    }
  });

  it('a project-mode turn is the pending turn from acceptance, and a failed copy write fails it loudly', async () => {
    const fx = fixture({ configToml: '[runtimes.claude-code]\nmcp = "project"\n' });
    const repo = makeFixtureRepo('mcp-project-pending');
    try {
      repo.commitFile('.mcp.json', JSON.stringify({ mcpServers: {} }));
      const handle = await fx.runtime.spawn('minion', { cwd: repo.path });
      const first = handle.prompt('accepted before the check');
      // A supervisor capture during the async check sees the accepted turn.
      expect(handle.pendingTurn?.()).toMatchObject({ text: 'accepted before the check' });
      await first;
      const copy = doubleInvocations(fx).at(-1)!.argv.at(doubleInvocations(fx).at(-1)!.argv.indexOf('--mcp-config') + 1)!;
      rmSync(copy);
      mkdirSync(copy); // the private copy can no longer be written
      const events: RuntimeEvent[] = [];
      const pendingAtError: unknown[] = [];
      handle.subscribe((event) => {
        events.push(event);
        if (event.type === 'error') pendingAtError.push(handle.pendingTurn?.() ?? null);
      });
      await expect(handle.prompt('cannot prepare')).rejects.toThrow(/^claude turn could not be prepared: /u);
      // An error-time capture (the supervisor's restart snapshot) still sees
      // the accepted prompt; only afterwards is it cleared.
      expect(pendingAtError).toEqual([expect.objectContaining({ text: 'cannot prepare' })]);
      expect(handle.pendingTurn?.()).toBeNull();
      // A subscriber that re-prompts from the error keeps ITS prompt pending.
      let again: Promise<unknown> | undefined;
      const unsubscribe = handle.subscribe((event) => {
        if (event.type === 'error' && again === undefined) {
          again = handle.prompt('re-prompted from the error').then(() => 'resolved', (error: unknown) => error);
        }
      });
      await expect(handle.prompt('fails again')).rejects.toThrow(/could not be prepared/u);
      unsubscribe();
      expect(handle.pendingTurn?.()).toMatchObject({ text: 're-prompted from the error' });
      expect(handle.health()).toMatchObject({ state: 'spawning' }); // the re-prompt owns the state
      expect(String(await again)).toMatch(/could not be prepared/u);
      expect(handle.pendingTurn?.()).toBeNull();
      expect(events.some((event) => event.type === 'error' && /could not be prepared/u.test(event.error))).toBe(true);
      expect(handle.health()).toMatchObject({ state: 'error' });
      // Compaction fails the same way, as a failed compaction.
      await expect(handle.compact!()).rejects.toThrow(/^claude turn could not be prepared: /u);
      expect(events.some((event) => event.type === 'compaction_end' && !event.success)).toBe(true);
      // Neither failure kept the session's operation slot.
      rmSync(copy, { recursive: true });
      expect(handle.canCompact?.()).toBe(true);
      await handle.prompt('after the failure');
      expect(doubleInvocations(fx).at(-1)!.prompt).toBe('after the failure');
      await handle.dispose();
    } finally {
      repo.cleanup();
    }
  });

  it('the project-MCP check reads the cwd repository only and names line-ending-only differences', async () => {
    const repo = makeFixtureRepo('mcp-project-routing');
    const other = makeFixtureRepo('mcp-project-elsewhere');
    const saved = process.env['GIT_DIR'];
    try {
      const committed = '{\n  "mcpServers": {}\n}\n';
      repo.commitFile('.mcp.json', committed);
      // An inherited routing variable never points the check at another repo.
      process.env['GIT_DIR'] = join(other.path, '.git');
      expect(await checkedInProjectMcpConfig(repo.path)).toEqual({ config: Buffer.from(committed) });
      if (saved === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved;
      writeFileSync(join(repo.path, '.mcp.json'), committed.replaceAll('\n', '\r\n'));
      expect(await checkedInProjectMcpConfig(repo.path)).toEqual({
        reason: '.mcp.json differs from its committed bytes only in line endings (autocrlf/eol conversion); only byte-identical files load',
      });
      writeFileSync(join(repo.path, '.mcp.json'), `${committed}${' '.repeat(4096)}`);
      expect(await checkedInProjectMcpConfig(repo.path)).toEqual({ reason: '.mcp.json differs from its committed version' });

      // The reverse conversion (CRLF committed, LF checked out) is named too.
      const crlf = makeFixtureRepo('mcp-project-crlf');
      try {
        crlf.commitFile('.mcp.json', committed.replaceAll('\n', '\r\n'));
        writeFileSync(join(crlf.path, '.mcp.json'), committed);
        expect(await checkedInProjectMcpConfig(crlf.path)).toMatchObject({ reason: expect.stringContaining('only in line endings') });
        // Bytes, not decoded text: invalid UTF-8 never passes for a line-ending
        // difference (both sides would decode to U+FFFD).
        const raw = (byte: number, eol: number[]) => Buffer.concat([Buffer.from('{"mcpServers":{},"note":"'), Buffer.from([byte]), Buffer.from('"}'), Buffer.from(eol)]);
        writeFileSync(join(crlf.path, '.mcp.json'), raw(0xff, [0x0a]));
        crlf.git(['add', '.mcp.json']);
        crlf.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-q', '-m', 'raw bytes']);
        expect(await checkedInProjectMcpConfig(crlf.path)).toMatchObject({ config: expect.anything() });
        writeFileSync(join(crlf.path, '.mcp.json'), raw(0xfe, [0x0d, 0x0a]));
        expect(await checkedInProjectMcpConfig(crlf.path)).toEqual({ reason: '.mcp.json differs from its committed version' });
        // Only a CR right before an LF is a line ending: a lone CR is an edit.
        crlf.commitFile('.mcp.json', '{}\n');
        writeFileSync(join(crlf.path, '.mcp.json'), '\r{}\n');
        expect(await checkedInProjectMcpConfig(crlf.path)).toEqual({ reason: '.mcp.json differs from its committed version' });
        // A committed file that is not a JSON object is refused at the boundary.
        // A syntax error is named by position only — never the source text,
        // which may carry a token.
        crlf.commitFile('.mcp.json', '{"mcpServers":{"x":{"env":{"TOKEN":"sk-secret-value"}}} oops');
        const syntax = await checkedInProjectMcpConfig(crlf.path);
        expect(syntax).toEqual({ reason: 'the committed .mcp.json is not valid JSON (at line 1, column 57)' });
        expect(JSON.stringify(syntax)).not.toContain('sk-secret');
        // A pretty-printed file is located by its line, too.
        crlf.commitFile('.mcp.json', '{"mcpServers":{}}\n\n  oops');
        expect(await checkedInProjectMcpConfig(crlf.path)).toEqual({ reason: 'the committed .mcp.json is not valid JSON (at line 3, column 3)' });
        // A BOM is invisible in an editor, so the column is the same with or
        // without it; a parser message with no location suffix (V8 quotes the
        // source instead) yields no location at all.
        crlf.commitFile('.mcp.json', '\uFEFF{"mcpServers":{}} oops');
        expect(await checkedInProjectMcpConfig(crlf.path)).toEqual({ reason: 'the committed .mcp.json is not valid JSON (at line 1, column 19)' });
        crlf.commitFile('.mcp.json', 'sk-secret-token');
        expect(await checkedInProjectMcpConfig(crlf.path)).toEqual({ reason: 'the committed .mcp.json is not valid JSON' });
        // Digits inside V8's quoted snippet are never taken for a position.
        crlf.commitFile('.mcp.json', 'position 48213377');
        expect(await checkedInProjectMcpConfig(crlf.path)).toEqual({ reason: 'the committed .mcp.json is not valid JSON' });
        crlf.commitFile('.mcp.json', 'x at position 99'); // V8 quotes it: still never a location
        expect(await checkedInProjectMcpConfig(crlf.path)).toEqual({ reason: 'the committed .mcp.json is not valid JSON' });
        // A server entry the CLI only skips is not fatal (CLI 2.1.300 skips
        // it and reports it in the init frame — logging that is pinned by
        // the skipped-servers test): the file loads.
        crlf.commitFile('.mcp.json', '{"mcpServers":{"x":5}}');
        expect(await checkedInProjectMcpConfig(crlf.path)).toMatchObject({ config: expect.anything() });
        for (const content of ['["a list"]', 'null', '42', '"a string"', 'true']) {
          crlf.commitFile('.mcp.json', content);
          expect(await checkedInProjectMcpConfig(crlf.path), content).toEqual({ reason: 'the committed .mcp.json is not a JSON object' });
        }
        for (const content of ['{"mcpServers":5}', '{"mcpServers":[]}', '{"mcpServers":null}', '{}', '{"servers":{}}']) {
          crlf.commitFile('.mcp.json', content);
          expect(await checkedInProjectMcpConfig(crlf.path), content).toEqual({ reason: 'the committed .mcp.json has no "mcpServers" object' });
        }
        // A leading BOM (Windows editors) is valid, exactly as the CLI reads it.
        crlf.commitFile('.mcp.json', '\uFEFF{"mcpServers":{}}');
        expect(await checkedInProjectMcpConfig(crlf.path)).toMatchObject({ config: expect.anything() });
      } finally {
        crlf.cleanup();
      }
    } finally {
      if (saved === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved;
      repo.cleanup();
      other.cleanup();
    }
  });

  it('a .mcp.json swapped or grown while git runs is never blocked on or read past its bound', async () => {
    const repo = makeFixtureRepo('mcp-project-race');
    const bin = mkdtempSync(join(tmpdir(), 'gru-command-git-race-'));
    cleanupDirs.push(bin);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const savedPath = process.env['PATH'];
    // Restored even if a check hangs past the test timeout.
    onTestFinished(() => {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
    });
    const target = join(repo.path, '.mcp.json');
    const sq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`; // POSIX single-quote
    const t = sq(target);
    // A lane writer racing the check: while git reads the committed blob in
    // THIS fixture repo (and nowhere else), the working file is replaced.
    const race = (action: string) => writeFileSync(join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = "cat-file" ] && [ "$(pwd -P)" = ${sq(realpathSync(repo.path))} ]; then ${action}; fi\nexec ${sq(realGit)} "$@"\n`, { mode: 0o755 });
    // A blocking open must fail this test fast, never hang the suite: on
    // timeout a writer opens the FIFO, releasing any reader blocked on it.
    const check = async (): Promise<unknown> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          checkedInProjectMcpConfig(repo.path),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
              try {
                if (lstatSync(target).isFIFO()) closeSync(openSync(target, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
              } catch { /* nothing left to release */ }
              reject(new Error('the check blocked'));
            }, 5_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const committed = JSON.stringify({ mcpServers: {} });
      repo.commitFile('.mcp.json', committed);
      process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
      for (const swap of [`rm -f ${t} && mkfifo ${t}`, `rm -f ${t} && ln -s package.json ${t}`, `rm -f ${t} && mkdir ${t}`]) {
        race(swap);
        expect(await check(), swap).toEqual({ reason: '.mcp.json is not a regular file (symlink or other)' });
        rmSync(target, { recursive: true, force: true });
        writeFileSync(target, committed);
      }
      // Grown to a sparse 3 GiB after the first look: refused after a few
      // bytes — an unbounded read could not even load it.
      race(`dd if=/dev/null of=${t} bs=1 count=0 seek=3221225472 2>/dev/null`);
      expect(await check()).toEqual({ reason: '.mcp.json differs from its committed version' });
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      repo.cleanup();
    }
  });

  it('each handle owns its project-MCP copy: a resumed session never shares the predecessor copy', async () => {
    const fx = fixture({ configToml: '[runtimes.claude-code]\nmcp = "project"\n' });
    const repo = makeFixtureRepo('mcp-project-resume');
    const handles: AgentHandle[] = [];
    const track = async (spawned: Promise<AgentHandle>) => { const handle = await spawned; handles.push(handle); return handle; };
    let disposalFailures: unknown[] = [];
    try {
      repo.commitFile('.mcp.json', JSON.stringify({ mcpServers: {} }));
      const copyOf = () => { const argv = doubleInvocations(fx).at(-1)!.argv; return argv[argv.indexOf('--mcp-config') + 1]!; };
      const first = await track(fx.runtime.spawn('minion', { cwd: repo.path }));
      await first.prompt('one');
      const firstCopy = copyOf();
      const file = first.sessionFile!;
      // The copy a handle really writes is the one format the sweep knows.
      expect(isProjectMcpCopyName(basename(file), basename(firstCopy))).toBe(true);
      await first.dispose();
      const resumed = await track(fx.runtime.spawn('minion', { cwd: repo.path, resumeFile: file }));
      await resumed.prompt('two');
      const resumedCopy = copyOf();
      expect(resumedCopy).not.toBe(firstCopy);
      await vi.waitFor(() => expect(copiesOf(file)).toEqual([resumedCopy]));
      await resumed.dispose();
      // A predecessor that crashed (never disposed) left its copy behind: the
      // next handle's first project turn sweeps it — and nothing else.
      writeFileSync(`${file}.deadbeef.project-mcp.json`, '{}');
      // A session whose file name extends this one: its copy is not ours.
      const extended = `${file}.x.jsonl.deadbeef.project-mcp.json`;
      writeFileSync(extended, '{}');
      const notACopy = `${file}.zz.project-mcp.json`; // not a token this code mints
      writeFileSync(notACopy, '{}');
      const other = await track(fx.runtime.spawn('minion', { cwd: repo.path }));
      await other.prompt('another session');
      const otherCopy = copyOf();
      const next = await track(fx.runtime.spawn('minion', { cwd: repo.path, resumeFile: file }));
      await next.prompt('three');
      await vi.waitFor(() => expect(copiesOf(file)).toEqual([copyOf()]));
      expect(existsSync(`${file}.lock`)).toBe(true); // the session's own lock is never swept
      expect(existsSync(otherCopy)).toBe(true); // nor another session's copy
      expect(existsSync(extended)).toBe(true); // nor one whose name merely extends this session's
      expect(existsSync(notACopy)).toBe(true); // nor anything that is not exactly a copy name
      rmSync(extended);
      rmSync(notACopy);
      await next.dispose();
      // A copy the sweep cannot remove is logged, never fatal.
      mkdirSync(`${file}.abcdef12.project-mcp.json`);
      const after = await track(fx.runtime.spawn('minion', { cwd: repo.path, resumeFile: file }));
      await after.prompt('four');
      expect(doubleInvocations(fx).at(-1)!.prompt).toBe('four');
      expect(fx.logs.some((entry) => entry.level === 'warn' && entry.msg === 'stale project MCP copy could not be removed')).toBe(true);
      rmSync(`${file}.abcdef12.project-mcp.json`, { recursive: true });
    } finally {
      const disposed = await Promise.allSettled(handles.map((handle) => handle.dispose()));
      disposalFailures = disposed.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((failure) => failure.reason);
      repo.cleanup();
    }
    // After the finally: a test failure surfaces as itself; a disposal
    // failure fails an otherwise passing test.
    if (disposalFailures.length > 0) throw new AggregateError(disposalFailures, 'handle disposal failed');
  });

  it('isolated review sessions stay strict with only their scoped bridge even when mcp = "user"', async () => {
    const fx = fixture({ configToml: '[runtimes.claude-code]\nmcp = "user"\n' });
    const review = await fx.runtime.spawn('perkins', { isolatedReview: { systemPrompt: 'isolated', tools: ['read'] } });
    try {
      await review.prompt('frozen diff only');
      const record = doubleInvocations(fx).at(-1)!;
      expect(record.argv).toContain('--strict-mcp-config');
      expect(record.argv).not.toContain('--mcp-config');
    } finally {
      await review.dispose();
    }
  });

  it('records each prompt in the product transcript right after its verified init frame', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('minion');
    await handle.prompt('first ask');
    await handle.prompt('second ask');
    const file = handle.sessionFile!;
    await handle.dispose();
    const frames = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as StreamFrame);
    const prompts = frames.filter((frame) => frame['type'] === 'user' && frame['gc_prompt'] === true);
    expect(prompts.map((frame) => (frame['message'] as { content: unknown }).content)).toEqual(['first ask', 'second ask']);
    expect(prompts.every((frame) => frame['session_id'] === handle.id && typeof frame['timestamp'] === 'string')).toBe(true);
    for (const prompt of prompts) {
      expect(frames[frames.indexOf(prompt) - 1]).toMatchObject({ type: 'system', subtype: 'init' });
    }
    // Identity stays first: the prompt follows init, so resume still reads
    // the session id from the transcript head.
    expect(extractSessionId(readFileSync(file, 'utf-8'))).toBe(handle.id);
  });

  it('a synthetic API-error message is the turn error, never streamed as the agent\'s words', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    const events = collect(handle);
    await handle.prompt('api-error please');
    await handle.dispose();
    expect(deltas(events, 'text_delta')).toEqual([]);
    const errors = events.filter((e) => e.type === 'error').map((e) => (e as { error: string }).error);
    expect(errors).toEqual([expect.stringMatching(/issue with the selected model.*\(HTTP 404, model_not_found\)$/)]);
    expect(states(events)).toContain('error');
  });

  it('a role flipped to claude-code in a pi-first config never sends a pi model to the CLI (production registry path)', async () => {
    const fx = fixture();
    writeFileSync(configPathFor(fx.home), `workspace_root = "${fx.workspace}"\n[runtimes.roles]\ngru = "claude-code"\n` +
      '[models]\ndefault = "openai-codex/gpt-6.1-sol"\n[models.roles]\ngru = "openai-codex/gpt-6-astra"\n[thinking]\ndefault = "minimal"\n');
    const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      claude: { binary: DOUBLE, reviewSettingsFile: join(fx.home, 'absent-review-settings.json') },
      log: (_level, msg, fields) => logs.push({ msg, ...(fields !== undefined ? { fields } : {}) }),
    });
    try {
      const handle = await registry.spawn('gru');
      await handle.prompt('which model');
      await handle.dispose();
      const argv = doubleInvocations(fx).at(-1)!.argv;
      expect(argv).not.toContain('--model'); // Claude Code's own model, not "gpt-6-astra"
      expect(argv).not.toContain('--effort'); // pi's "minimal" never reaches the CLI either
      const note = logs.find((entry) => entry.msg.includes('passed over pi references'));
      expect(note?.fields).toMatchObject({
        role: 'gru',
        passed_over: [
          'models.roles.gru = openai-codex/gpt-6-astra',
          'models.default = openai-codex/gpt-6.1-sol',
          'thinking.default = minimal',
        ],
        model: 'default',
        thinking_level: 'default',
      });
    } finally {
      await registry.dispose();
    }
  });

  it('a Claude usage-limit wall is a typed quota wall the supervisor and recovery sensor can act on #contract:provider-failure-typed:claude-code', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('minion', { model: 'claude-opus-5-5' });
    const events = collect(handle);
    await handle.prompt('usage-limit please');
    await handle.dispose();
    expect(deltas(events, 'text_delta')).toEqual([]);
    const error = events.find((e) => e.type === 'error') as Extract<RuntimeEvent, { type: 'error' }>;
    expect(error).toEqual({
      type: 'error',
      error: "You've hit your limit · resets 3pm (UTC) (HTTP 429, rate_limit)",
      fatal: false,
      provider: 'anthropic-claude-native',
      model: 'claude-opus-5-5', // the CLI-resolved model from init
      typed: { origin: 'provider-message', status: 429, bodyCode: 'rate_limit' },
    });
    // The same deterministic machinery a pi lane's 429 reaches: bounded
    // rate-limit retry first, then a quota-wall stop (never an unclassified
    // error that strands the lane), then a temporary-recoverable wait.
    expect(isRateLimitErrorText(error.error)).toBe(true);
    expect(deterministicFailureClass(error.error)).toBe('quota_wall');
    expect(classifyProviderRejection({ provider: error.provider!, model: error.model!, errorMessage: error.error,
      status: error.typed!.status!, bodyCode: error.typed!.bodyCode! })).toEqual({ kind: 'temporary-recoverable', retryAfterMs: null });
    expect(providerSupportsSensor(error.provider!)).toBe(true);
  });

  it('typed provenance and identity are only attached when the CLI reported a provider failure', () => {
    const result = { subtype: 'error_during_execution', isError: true, text: 'tool loop exploded', apiErrorStatus: null };
    expect(claudeInBandError(result, null, 'claude-opus-5-5')).toEqual({ type: 'error', error: 'tool loop exploded', fatal: false });
    const billing = claudeInBandError({ ...result, text: null, apiErrorStatus: 402 },
      { text: 'Credit balance is too low', code: 'billing_error', status: 402 }, 'claude-opus-5-5');
    expect(billing).toMatchObject({ error: 'Credit balance is too low (HTTP 402, billing_error)', typed: { status: 402, bodyCode: 'billing_error' } });
    expect(deterministicFailureClass(billing.error)).toBe('quota_wall');
    expect(classifyProviderRejection({ provider: billing.provider!, model: billing.model!, errorMessage: billing.error,
      status: 402, bodyCode: 'billing_error' })).toEqual({ kind: 'owner-controlled', reason: 'billing' });
    const auth = claudeInBandError({ ...result, text: 'Invalid API key', apiErrorStatus: 401 }, null, null);
    expect(auth).toEqual({ type: 'error', error: 'Invalid API key (HTTP 401)', fatal: false, typed: { origin: 'provider-message', status: 401 } });
    expect(deterministicFailureClass(auth.error)).toBe('authentication_wall');
    // A failure code without an HTTP status still names the provider failure.
    const overloaded = claudeInBandError({ ...result, text: null }, { text: 'Overloaded', code: 'overloaded', status: null }, 'claude-opus-5-5');
    expect(overloaded).toEqual({ type: 'error', error: 'Overloaded (overloaded)', fatal: false,
      provider: 'anthropic-claude-native', model: 'claude-opus-5-5', typed: { origin: 'provider-message', bodyCode: 'overloaded' } });
  });

  it('a default-model Claude lane (no --model) names the model the CLI reported in init', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('minion');
    const events = collect(handle);
    await handle.prompt('usage-limit please');
    await handle.dispose();
    expect(doubleInvocations(fx).at(-1)!.argv).not.toContain('--model');
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      provider: 'anthropic-claude-native',
      model: 'double-default-model', // from the init frame; nothing was configured
      typed: { origin: 'provider-message', status: 429, bodyCode: 'rate_limit' },
    });
  });

  it('resumes a previous session file: --resume pinned, same file appended, history intact #contract:session-resume:claude-code', async () => {
    const fx = fixture();
    const first = await fx.runtime.spawn('gru');
    await first.prompt('remember this', { owner: 'alice' });
    const file = first.sessionFile!;
    const sessionId = first.id;
    await first.dispose();
    const linesBefore = readFileSync(file, 'utf-8').trim().split('\n').length;

    // "New process": same data dir, fresh adapter.
    const secondRuntime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: new SessionStore(fx.store.dataDir),
      binary: DOUBLE,
      reviewSettingsFile: join(fx.home, 'absent-review-settings.json'),
    });
    const resumed = await secondRuntime.spawn('gru', { resumeFile: file });
    try {
      expect(resumed.sessionFile).toBe(file); // same file, never duplicated
      expect(resumed.id).toBe(sessionId); // the transcript's session id is adopted
      await resumed.prompt('continue', { owner: 'alice' });
      const lines = readFileSync(file, 'utf-8').trim().split('\n');
      expect(lines.length).toBeGreaterThan(linesBefore);
      const invocations = doubleInvocations(fx);
      const resumeCall = invocations[invocations.length - 1]!;
      expect(resumeCall.argv[resumeCall.argv.indexOf('--resume') + 1]).toBe(sessionId);
      expect(resumeCall.argv).not.toContain('--session-id');
      // The transcript holds both turns' init frames (append-only forensics).
      expect(lines.filter((l) => l.includes('"subtype":"init"')).length).toBe(2);
    } finally {
      await resumed.dispose();
    }
  });

  it('refuses a resumeFile outside the session store #contract:resume-outside-store-refused:claude-code', async () => {
    const fx = fixture();
    await expect(
      fx.runtime.spawn('gru', { resumeFile: join(fx.home, 'elsewhere.jsonl') }),
    ).rejects.toThrow(/must live under the session store/);
  });

  it('refuses to resume a transcript with no session id, releasing the lock it took', async () => {
    const fx = fixture();
    const dir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(dir, { recursive: true });
    const orphan = join(dir, '2026-09-17T00-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl');
    writeFileSync(orphan, '{"not":"a session frame"}\n', 'utf-8');
    await expect(fx.runtime.spawn('gru', { resumeFile: orphan })).rejects.toThrow(
      /has no session id/,
    );
    expect(existsSync(`${orphan}.lock`)).toBe(false); // released on the way out
    // Caller-facing input error — adapter health stays ok (never latched).
    expect(fx.runtime.health().state).toBe('ok');
  });

  it('refuses to resume a transcript another runtime wrote (a pi session) by name, releasing its lock #contract:foreign-transcript-refused:claude-code', async () => {
    const fx = fixture();
    const dir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '2026-09-17T00-00-00-000Z_22222222-2222-2222-2222-222222222222.jsonl');
    // pi's own first records: its session header, then a user message.
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: '22222222-2222-2222-2222-222222222222', timestamp: '2026-09-17T00:00:00.000Z', cwd: fx.workspace })}\n${JSON.stringify({ type: 'message', id: 'a1b2c3d4', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } })}\n`, 'utf-8');
    const before = readFileSync(file, 'utf-8');
    await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(/has no session id/);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(doubleInvocations(fx)).toEqual([]);
  });

  describe('native directive admission (#424: exact proof, never resume)', () => {
    const identityFor = (requestId: string): DirectiveTurnIdentity => ({ requestId, payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: `job-${requestId}`, workRevision: 0, authorityEpoch: 0 });
    const frames = (file: string): StreamFrame[] => readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as StreamFrame);
    const gitRepo = (dir: string): string => {
      for (const args of [['init', '-q'], ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '--allow-empty', '-m', 'seed']]) execFileSync('git', args, { cwd: dir });
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    };

    it('admits a directive at the CLI\'s own echo, fences every tool after its intent is durable, and records completion with HEAD #contract:native-directive-admission:claude-code', async () => {
      const fx = fixture();
      const head = gitRepo(fx.workspace);
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const identity = identityFor('claude-admitted');
      const admitted: DirectiveNativeBinding[] = [];
      let checks = 0;
      const producer = handle.prepareDirectiveProducer!(identity);
      await handle.prompt('tool:Read follow the approved correction', { directive: { identity, beforeAdmission: () => { checks += 1; }, onAdmitted: (binding) => admitted.push(binding) } });
      const transcript = frames(handle.sessionFile!);
      const echo = transcript.find((frame) => frame['type'] === 'user' && frame['isReplay'] === true)!;
      const result = transcript.find((frame) => frame['type'] === 'result')!;
      // Admission is the CLI's own receipt, read back from the durable transcript.
      expect(admitted).toEqual([expect.objectContaining({ runtime: 'claude-code', agentId: handle.id, sessionId: handle.id, userEntryId: echo['uuid'] })]);
      expect(readDirectiveBinding(handle.sessionFile!, identity.requestId)).toMatchObject({ userEntryId: echo['uuid'] });
      // The tool asked the host after its tool_use was recorded, and the host allowed it unchanged.
      const order = transcript.map((frame) => frame['type'] === 'control_request' ? 'ask' : frame['type'] === 'assistant' && JSON.stringify(frame).includes('"tool_use"') ? 'intent' : null).filter(Boolean);
      expect(order).toEqual(['intent', 'ask']);
      expect(transcript.some((frame) => frame['type'] === 'control_response' && JSON.stringify(frame).includes('"behavior":"allow"'))).toBe(true);
      expect(checks).toBeGreaterThanOrEqual(2); // before the binding, and again at the tool
      // A directive turn's record is the echo, never a GC-written prompt frame.
      expect(transcript.some((frame) => frame['gc_prompt'] === true)).toBe(false);
      const argv = doubleInvocations(fx).at(-1)!.argv;
      expect(argv).toEqual(expect.arrayContaining(['--replay-user-messages', '--permission-prompt-tool', 'stdio', '--settings']));
      expect(existsSync(argv[argv.indexOf('--settings') + 1]!)).toBe(false); // private, removed after the turn
      // Terminal at the turn's own result; completion carries the HEAD captured at the result.
      expect(handle.inspectDirective!(identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: result['uuid'] });
      expect(readDirectiveCompletion(handle.sessionFile!, identity, result['uuid'] as string)).toMatchObject({ head, producer });
      // The CLI child is an independent controller until this handle proves cessation.
      expect(inspectDirectiveProducers(handle.sessionFile!, identity).map((owner) => owner.evidence)).toEqual(['unknown']);
      await handle.dispose();
      expect(handle.cessationEvidence?.()).toBe('ceased');
      expect(inspectDirectiveProducers(handle.sessionFile!, identity).map((owner) => owner.evidence)).toEqual(['ceased']);
      await expect(handle.resumeDirective!(identity, 'x', () => {})).rejects.toThrow(/never continues an interrupted directive/u);
    });

    it('an echo that differs from what the host sent is no admission: the turn is refused and no tool is allowed', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const identity = identityFor('claude-mutated');
      const admitted: DirectiveNativeBinding[] = [];
      process.env['CLAUDE_DOUBLE_ECHO'] = 'mutate';
      await expect(handle.prompt('tool:Read follow it', { directive: { identity, beforeAdmission: () => {}, onAdmitted: (binding) => admitted.push(binding) } }))
        .rejects.toThrow(/directive refused: actual native admission user receipt unavailable\/changed/u);
      expect(admitted).toEqual([]);
      expect(handle.inspectDirective!(identity)).toMatchObject({ state: 'unknown' });
      expect(frames(handle.sessionFile!).some((frame) => frame['type'] === 'control_response' && JSON.stringify(frame).includes('"behavior":"allow"'))).toBe(false);
      await handle.dispose();
    });

    it('authority withdrawn before a tool runs, or a permission request naming other input, refuses the tool with a durable guard receipt', async () => {
      for (const [label, setup] of [['withdrawn', () => {}], ['drifted', () => { process.env['CLAUDE_DOUBLE_TOOL_INPUT_DRIFT'] = '1'; }]] as const) {
        const fx = fixture();
        const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
        const identity = identityFor(`claude-guard-${label}`);
        let checks = 0;
        setup();
        try {
          const beforeAdmission = (): void => { checks += 1; if (label === 'withdrawn' && checks > 1) throw new Error('the job was parked'); };
          await expect(handle.prompt('tool:Read follow it', { directive: { identity, beforeAdmission, onAdmitted: () => {} } }), label).rejects.toThrow(/directive refused/u);
          const journal = readFileSync(`${handle.sessionFile!}.producers.jsonl`, 'utf-8');
          expect(journal, label).toContain('"state":"guard-refused"');
          expect(handle.inspectDirective!(identity), label).toMatchObject({ state: 'unknown' });
          expect(frames(handle.sessionFile!).some((frame) => frame['type'] === 'control_response' && JSON.stringify(frame).includes('"behavior":"allow"')), label).toBe(false);
        } finally {
          delete process.env['CLAUDE_DOUBLE_TOOL_INPUT_DRIFT'];
          await handle.dispose();
        }
      }
    });

    it('a refused tool\'s deny is written before the turn ends, and a CLI that ignores SIGTERM is killed after the grace period', async () => {
      const fx = fixture({ killGraceMs: 300 });
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const identity = identityFor('claude-stubborn');
      process.env['CLAUDE_DOUBLE_TOOL_INPUT_DRIFT'] = '1';
      process.env['CLAUDE_DOUBLE_IGNORE_TERM'] = '1';
      try {
        // Without the escalation this CLI never exits and the prompt never settles.
        await expect(handle.prompt('tool:Read follow it', { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } }))
          .rejects.toThrow(/directive refused: native tool intent is not persisted/u);
        // The CLI read the deny (it echoes what the host wrote) before it was killed.
        expect(frames(handle.sessionFile!).some((frame) => frame['type'] === 'control_response' && JSON.stringify(frame).includes('"behavior":"deny"'))).toBe(true);
      } finally {
        delete process.env['CLAUDE_DOUBLE_TOOL_INPUT_DRIFT'];
        delete process.env['CLAUDE_DOUBLE_IGNORE_TERM'];
        await handle.dispose();
      }
    });

    it('a lost transcript write fails the directive: an incomplete record is never a delivery', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      let broken = false;
      handle.subscribe((event) => {
        if (event.type !== 'turn_start') return;
        // The disk fails on the first ordinary (non-gating) frame of the turn.
        type Chunk = { toString(): string };
        const stream = (handle as unknown as { liveTranscript: { _writev: unknown; _write: (chunk: Chunk, encoding: unknown, callback: (error?: Error) => void) => void } }).liveTranscript;
        const write = stream._write.bind(stream);
        stream._writev = null;
        stream._write = (chunk, encoding, callback) => {
          if (!broken && chunk.toString().includes('"type":"stream_event"')) { broken = true; callback(new Error('ENOSPC: no space left on device')); return; }
          write(chunk, encoding, callback);
        };
      });
      await expect(handle.prompt('answer plainly', { directive: { identity: identityFor('claude-disk'), beforeAdmission: () => {}, onAdmitted: () => {} } }))
        .rejects.toThrow(/directive transcript write failed: ENOSPC/u);
      expect(broken).toBe(true);
      await handle.dispose();
    });

    it('a directive that already failed admits nothing, even when the CLI\'s echo is durable after the failure', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const identity = identityFor('claude-failed-first');
      const file = handle.sessionFile!;
      // A genuine binding and a genuine echo: only the earlier failure stops admission.
      const content = [{ type: 'text', text: 'follow it' }];
      prepareClaudeDirectiveBinding({ identity, agentId: handle.id, sessionId: handle.id, sessionFile: file, content, authorityManifest: 'manifest' });
      const echo = { type: 'user', isReplay: true, uuid: 'echo-1', session_id: handle.id, parent_tool_use_id: null, message: { role: 'user', content } };
      appendFileSync(file, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: handle.id })}\n${JSON.stringify(echo)}\n`);
      const admitted: unknown[] = [];
      const turn = { directive: { identity, beforeAdmission: () => {}, onAdmitted: (binding: unknown) => admitted.push(binding) },
        producer: {}, content, settings: { file: '', dispose: () => {} }, admission: null as Promise<void> | null, admitted: null, failure: new Error('refused earlier') as unknown, completion: null };
      const follow = (handle as unknown as { followDirectiveFrame(turn: unknown, frame: unknown, durable: Promise<void>, abort: (detail: string) => void): void }).followDirectiveFrame.bind(handle);
      follow(turn, echo, Promise.resolve(), () => {});
      await turn.admission;
      expect(admitted).toEqual([]);
      expect(turn.admitted).toBeNull();
      await handle.dispose();
    });

    it('a throw while handling a lost transcript write still fails the directive and ends its CLI', async () => {
      const signals: string[] = [];
      const fx = fixture({ spawnProcess: ((binary: string, args: readonly string[], options: object) => {
        const child = spawn(binary, args, options);
        const kill = child.kill.bind(child);
        child.kill = (signal?: NodeJS.Signals | number) => { signals.push(String(signal)); return kill(signal); };
        return child;
      }) as unknown as typeof spawn });
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      vi.spyOn(handle as unknown as { failDirective(): void }, 'failDirective').mockImplementation(() => { throw new Error('handler broke'); });
      let broken = false;
      handle.subscribe((event) => {
        if (event.type !== 'turn_start') return;
        type Chunk = { toString(): string };
        const stream = (handle as unknown as { liveTranscript: { _writev: unknown; _write: (chunk: Chunk, encoding: unknown, callback: (error?: Error) => void) => void } }).liveTranscript;
        const write = stream._write.bind(stream);
        stream._writev = null;
        stream._write = (chunk, encoding, callback) => {
          if (!broken && chunk.toString().includes('"type":"stream_event"')) { broken = true; callback(new Error('ENOSPC: no space left on device')); return; }
          write(chunk, encoding, callback);
        };
      });
      await expect(handle.prompt('answer plainly', { directive: { identity: identityFor('claude-handler-throws'), beforeAdmission: () => {}, onAdmitted: () => {} } }))
        .rejects.toThrow(/directive failure handling threw: handler broke/u);
      expect(fx.logs.some((line) => line.level === 'error' && line.msg === 'directive failure handling threw after a lost transcript write')).toBe(true);
      expect(signals[0]).toBe('SIGTERM'); // the CLI was ended, not left running
      await handle.dispose();
    });

    it('a directive turn whose CLI never starts leaves no private settings behind; one that started keeps them until its close', async () => {
      const settingsOf = (args: readonly string[]): string => args[args.indexOf('--settings') + 1]!;
      for (const mode of ['throws', 'errors', 'errors-while-live'] as const) {
        let settings = '';
        let live: (EventEmitter & { killed: string[] }) | null = null;
        const spawnProcess = ((_binary: string, args: readonly string[]) => {
          settings = settingsOf(args);
          if (mode === 'throws') throw new Error('EAGAIN: cannot fork');
          const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
            pid: mode === 'errors-while-live' ? 4242 : undefined, exitCode: null, signalCode: null, killed: [] as string[],
            kill: (signal: string) => { child.killed.push(signal); return true; } });
          live = child;
          setImmediate(() => {
            child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
            // A live child may report a second error (say, a failed kill): handled once.
            if (mode === 'errors-while-live') child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
          });
          return child as unknown as ChildProcess;
        }) as unknown as typeof spawn;
        const fx = fixture({ spawnProcess, killGraceMs: 50 });
        const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
        const prompt = handle.prompt('follow it', { directive: { identity: identityFor(`claude-nospawn-${mode}`), beforeAdmission: () => {}, onAdmitted: () => {} } });
        if (mode === 'errors-while-live') {
          // A CLI that did start is ended (SIGTERM, then SIGKILL after the grace)
          // and keeps its settings; the turn settles only from its close.
          let settled = false;
          void prompt.catch(() => {}).finally(() => { settled = true; });
          await vi.waitFor(() => expect(live!.killed).toEqual(['SIGTERM', 'SIGKILL']));
          expect(fx.logs.filter((line) => line.msg === 'a further claude child error was ignored: its first error already began ending the child'), mode).toHaveLength(1);
          expect(existsSync(settings), mode).toBe(true);
          expect(settled, mode).toBe(false);
          live!.emit('close', null, 'SIGKILL');
        }
        // A CLI that started is not reported as one that failed to spawn.
        await expect(prompt, mode).rejects.toThrow(mode === 'errors-while-live' ? /^claude process failed: Error: spawn claude ENOENT$/u : /claude process failed to spawn/u);
        expect(settings, mode).not.toBe('');
        await vi.waitFor(() => expect(existsSync(settings), mode).toBe(false));
        await handle.dispose();
      }
    });

    it('a CLI that closes stdin under the prompt write fails the turn instead of crashing the service', async () => {
      // The real failure: the CLI is gone before it reads its frame, so the
      // stdin write rejects with EPIPE. An unhandled stream 'error' was an
      // uncaught exception that took the whole service down (CI, no CLI).
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        pid: 4343, exitCode: null, signalCode: null, kill: () => true,
      });
      const fx = fixture({ spawnProcess: (() => child) as unknown as typeof spawn, killGraceMs: 20 });
      const handle = await fx.runtime.spawn('gru');
      const frames: string[] = [];
      child.stdin.on('data', (chunk: Buffer) => frames.push(chunk.toString('utf8')));
      const turn = handle.prompt('read this frame').catch((error: Error) => error.message);
      await vi.waitFor(() => expect(frames.join('')).toContain('read this frame'));
      // The adapter owns the stream error; the child's own close settles the turn.
      expect(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
      expect(fx.logs.some((line) => line.msg === 'claude stdin is closed; the prompt frame could not be written')).toBe(true);
      child.emit('close', 1, null);
      expect(await turn).toMatch(/claude ended via exit 1/u);
      await handle.dispose();
    });

    it('a turn admitted at the echo that never reaches a result is no delivery', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const identity = identityFor('claude-no-result');
      const admitted: DirectiveNativeBinding[] = [];
      await expect(handle.prompt('no-result-ok please', { directive: { identity, beforeAdmission: () => {}, onAdmitted: (binding) => admitted.push(binding) } }))
        .rejects.toThrow(/without a result frame/u);
      expect(admitted).toHaveLength(1); // admitted: the CLI acknowledged it
      expect(handle.inspectDirective!(identity)).toMatchObject({ state: 'unknown', reason: 'native directive turn has no result yet' });
      await handle.dispose();
    });

    it('a directive turn on a foreign session is aborted, even by a CLI that ignores SIGTERM', async () => {
      const fx = fixture({ killGraceMs: 300 });
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      process.env['CLAUDE_DOUBLE_MISMATCH'] = '1';
      process.env['CLAUDE_DOUBLE_IGNORE_TERM'] = '1';
      const identity = identityFor('claude-foreign');
      const admitted: DirectiveNativeBinding[] = [];
      try {
        // Its stdin stays open for the permission channel: only the abort ends it.
        await expect(handle.prompt('follow it', { directive: { identity, beforeAdmission: () => {}, onAdmitted: (binding) => admitted.push(binding) } }))
          .rejects.toThrow(/session id mismatch/u);
        // The foreign session's echo (sent before it died) admits nothing.
        expect(admitted).toEqual([]);
        expect(handle.inspectDirective!(identity)).toMatchObject({ state: 'unknown' });
      } finally {
        delete process.env['CLAUDE_DOUBLE_MISMATCH'];
        delete process.env['CLAUDE_DOUBLE_IGNORE_TERM'];
        await handle.dispose();
      }
    });

    it('a CLI that dies before answering keeps its own diagnosis, not the missing echo', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      await expect(handle.prompt('crash right away', { directive: { identity: identityFor('claude-crash'), beforeAdmission: () => {}, onAdmitted: () => {} } }))
        .rejects.toThrow(/claude ended via exit 2 without a result frame: double crash requested/u);
      await handle.dispose();
    });

    it('a changed authority manifest at the tool refuses it with a durable guard receipt', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const identity = identityFor('claude-manifest');
      const manifest = handle as unknown as { directiveAuthorityManifest(): string };
      const original = manifest.directiveAuthorityManifest.bind(handle);
      let calls = 0;
      vi.spyOn(manifest, 'directiveAuthorityManifest').mockImplementation(() => (calls += 1) === 1 ? original() : 'a different model or tool set');
      await expect(handle.prompt('tool:Read follow it', { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } }))
        .rejects.toThrow(/authority changed before effect/u);
      expect(readFileSync(`${handle.sessionFile!}.producers.jsonl`, 'utf-8')).toContain('"state":"guard-refused"');
      expect(handle.inspectDirective!(identity)).toMatchObject({ state: 'unknown' });
      await handle.dispose();
    });

    it('a turn the CLI never acknowledged with its echo is no delivery, even when the CLI reports success', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const identity = identityFor('claude-no-echo');
      const admitted: DirectiveNativeBinding[] = [];
      process.env['CLAUDE_DOUBLE_ECHO'] = 'skip';
      await expect(handle.prompt('just answer', { directive: { identity, beforeAdmission: () => {}, onAdmitted: (binding) => admitted.push(binding) } }))
        .rejects.toThrow(/ended without the CLI's admission echo/u);
      expect(admitted).toEqual([]);
      expect(handle.inspectDirective!(identity)).toMatchObject({ state: 'unknown', reason: 'the native turn proceeded without an exact admission receipt' });
      await handle.dispose();
    });

    it('a directive is text only: an image, or no text, is refused before anything is bound', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const directive = (requestId: string) => ({ identity: identityFor(requestId), beforeAdmission: () => {}, onAdmitted: () => {} });
      await expect(handle.prompt('look at this', { images: [{ mediaType: 'image/png', data: 'AAAA' }], directive: directive('claude-image') })).rejects.toThrow(/text only/u);
      await expect(handle.prompt('', { directive: directive('claude-empty') })).rejects.toThrow(/needs text/u);
      expect(readDirectiveBinding(handle.sessionFile!, 'claude-image')).toBeNull();
      expect(doubleInvocations(fx)).toEqual([]);
      await handle.dispose();
    });

    it('a resumed session keeps the capability only when GC\'s header names this session and cwd', async () => {
      const fx = fixture();
      const first = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const file = first.sessionFile!;
      await first.dispose();
      const resumed = await fx.runtime.spawn('minion', { cwd: fx.workspace, resumeFile: file });
      expect(resumed.prepareDirectiveProducer).toBeDefined();
      expect(resumed.inspectDirective).toBeDefined();
      await resumed.dispose();
      // The same session resumed in another directory cannot attest admission there.
      const elsewhere = mkdtempSync(join(tmpdir(), 'gru-command-elsewhere-'));
      cleanupDirs.push(elsewhere);
      const moved = await fx.runtime.spawn('minion', { cwd: elsewhere, resumeFile: file });
      expect(moved.prepareDirectiveProducer).toBeUndefined();
      expect(moved.inspectDirective).toBeUndefined();
      await moved.dispose();
    });

    it('a tool error leaves the checkpoint UNKNOWN (a recovery judgment, as on pi) and records no completion', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const identity = identityFor('claude-tool-error');
      await expect(handle.prompt('tool-error:Read try it', { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } }))
        .rejects.toThrow(/native tool error requires a recovery judgment/u);
      expect(handle.inspectDirective!(identity)).toMatchObject({ state: 'unknown', reason: 'native tool error requires a recovery judgment' });
      await handle.dispose();
    });

    it('a session that cannot attest admission exposes no directive capability and refuses a directive by name before any CLI run', async () => {
      const fx = fixture({ configToml: '[runtimes.claude-code]\nmcp = "user"\n' });
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      expect(handle.prepareDirectiveProducer).toBeUndefined();
      expect(handle.inspectDirective).toBeUndefined();
      await expect(handle.prompt('follow it', { directive: { identity: identityFor('claude-ambient'), beforeAdmission: () => {}, onAdmitted: () => {} } }))
        .rejects.toThrow(/cannot attest directive admission/u);
      expect(doubleInvocations(fx)).toEqual([]);
      await handle.dispose();
    });

    it('a directive whose authority fails before the binding leaves no association and runs no CLI', async () => {
      const fx = fixture();
      const handle = await fx.runtime.spawn('minion', { cwd: fx.workspace });
      const identity = identityFor('claude-refused-early');
      await expect(handle.prompt('follow it', { directive: { identity, beforeAdmission: () => { throw new Error('superseded'); }, onAdmitted: () => {} } }))
        .rejects.toThrow(/superseded/u);
      expect(readDirectiveBinding(handle.sessionFile!, identity.requestId)).toBeNull();
      expect(doubleInvocations(fx)).toEqual([]);
      expect(handle.health().state).toBe('idle');
      await handle.dispose();
    });
  });

  it('resume scan is bounded: a session id beyond the prefix window is not found', async () => {
    const fx = fixture();
    const dir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(dir, { recursive: true });
    const fat = join(dir, '2026-09-17T00-00-00-000Z_00000000-0000-0000-0000-000000000000.jsonl');
    // A junk line >256KB pushes the init frame beyond the scan prefix.
    writeFileSync(
      fat,
      `{"pad":"${'x'.repeat(300 * 1024)}"}\n{"type":"system","subtype":"init","session_id":"hidden-id"}\n`,
      'utf-8',
    );
    await expect(fx.runtime.spawn('gru', { resumeFile: fat })).rejects.toThrow(
      /has no session id in its first/,
    );
    expect(fx.runtime.health().state).toBe('ok');
  });

  it('a legacy empty transcript resumes by adopting the filename uuid', async () => {
    const fx = fixture();
    const dir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '2026-09-17T00-00-00-000Z_33333333-3333-3333-3333-333333333333.jsonl');
    writeFileSync(file, '', 'utf-8');
    const resumed = await fx.runtime.spawn('gru', { resumeFile: file });
    try {
      expect(resumed.id).toBe('33333333-3333-3333-3333-333333333333');
      // No GC header: this session cannot attest directive admission.
      expect(resumed.prepareDirectiveProducer).toBeUndefined();
    } finally {
      await resumed.dispose();
    }
  });

  it('a spawned-but-never-prompted transcript (GC\'s header only) resumes by adopting the header\'s session id', async () => {
    const fx = fixture();
    const first = await fx.runtime.spawn('gru');
    const file = first.sessionFile!;
    const sessionId = first.id;
    await first.dispose(); // never prompted: only the session header on disk
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toMatchObject({ type: 'session', id: sessionId, runtime: 'claude-code' });

    const secondRuntime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: new SessionStore(fx.store.dataDir),
      binary: DOUBLE,
      reviewSettingsFile: join(fx.home, 'absent-review-settings.json'),
    });
    const resumed = await secondRuntime.spawn('gru', { resumeFile: file });
    try {
      expect(resumed.id).toBe(sessionId); // adopted from the header
      await resumed.prompt('first words', { owner: 'alice' });
      const invocations = doubleInvocations(fx);
      const last = invocations[invocations.length - 1]!;
      // The session never registered CLI-side: the first turn MINTS it.
      expect(last.argv[last.argv.indexOf('--session-id') + 1]).toBe(sessionId);
      expect(last.argv).not.toContain('--resume');
      // And the transcript now holds the frames, keyed to the adopted id.
      const frames = readFileSync(file, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as StreamFrame);
      expect(frames[1]!['session_id']).toBe(sessionId);
    } finally {
      await resumed.dispose();
    }
  });

  it('double-resume of one session file in one process is rejected loudly', async () => {
    const fx = fixture();
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write something');
    const file = first.sessionFile!;
    await first.dispose();
    const resumed = await fx.runtime.spawn('gru', { resumeFile: file });
    await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(
      /already hosted by this process/,
    );
    await resumed.dispose();
    // After dispose, the file can be hosted again.
    const again = await fx.runtime.spawn('gru', { resumeFile: file });
    await again.dispose();
  });

  it('resume of a file locked by another process rejects without touching it', async () => {
    const fx = fixture();
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write');
    const file = first.sessionFile!;
    await first.dispose();
    const foreign = new SessionStore(fx.store.dataDir);
    foreign.acquireLock(file);
    const bytesBefore = readFileSync(file, 'utf-8').length;
    try {
      await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(/locked by pid/);
      expect(readFileSync(file, 'utf-8').length).toBe(bytesBefore);
      expect(existsSync(`${file}.lock`)).toBe(true); // theirs, intact
    } finally {
      foreign.releaseLock(file);
      foreign.dispose();
    }
  });

  it('LockBusyError import sanity: the adapter surfaces the store error type', async () => {
    const fx = fixture();
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write');
    const file = first.sessionFile!;
    await first.dispose();
    const foreign = new SessionStore(fx.store.dataDir);
    foreign.acquireLock(file);
    try {
      await fx.runtime.spawn('gru', { resumeFile: file }).then(
        () => expect.unreachable('must not host a foreign-locked file'),
        (error: unknown) => expect(error).toBeInstanceOf(LockBusyError),
      );
    } finally {
      foreign.releaseLock(file);
      foreign.dispose();
    }
  });

  it('a second runtime instance sharing one store cannot re-host a live file', async () => {
    const fx = fixture();
    const first = await fx.runtime.spawn('gru');
    await first.prompt('hosted');
    const file = first.sessionFile!;
    const sibling = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store, // SAME store instance — the in-process single-writer hole
      binary: DOUBLE,
      reviewSettingsFile: join(fx.home, 'absent-review-settings.json'),
    });
    await expect(sibling.spawn('gru', { resumeFile: file })).rejects.toThrow(
      /already hosted by this process/,
    );
    expect(sibling.health().state).toBe('ok'); // caller-facing conflict, never latched
    await first.dispose();
    // Once released, the sibling can host it.
    const resumed = await sibling.spawn('gru', { resumeFile: file });
    await resumed.dispose();
  });

  it('a failed fresh spawn leaves no orphan transcript and no lock behind', async () => {
    const fx = fixture();
    const poisoned = new SessionStore(fx.store.dataDir);
    poisoned.acquireLock = () => {
      throw new Error('staged lock failure');
    };
    const runtime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: poisoned,
      binary: DOUBLE,
      reviewSettingsFile: join(fx.home, 'absent-review-settings.json'),
    });
    await expect(runtime.spawn('gru')).rejects.toThrow('staged lock failure');
    const dir = fx.store.sessionDirFor('gru', fx.workspace);
    const leftovers = readdirSync(dir).filter((n) => n.endsWith('.jsonl') || n.endsWith('.lock'));
    expect(leftovers).toEqual([]);
    expect(runtime.health().state).toBe('down'); // genuine infra failure latches
  });
});

describe('RuntimeRegistry + claude-code (fallback-wrapped)', () => {
  async function claudeRegistryFixture() {
    const fx = fixture();
    writeFileSync(
      configPathFor(fx.home),
      `workspace_root = "${fx.workspace}"\n[runtimes]\ndefault = "claude-code"\n`,
      'utf-8',
    );
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      claude: { binary: DOUBLE, reviewSettingsFile: join(fx.home, 'absent-review-settings.json') },
    });
    return { fx, registry };
  }

  it('spawns through the registry with steer wrapped to queued, and reports adapter status', async () => {
    const { registry } = await claudeRegistryFixture();
    registry.boot();
    expect(registry.runtimeIdFor('gru')).toBe('claude-code');
    const adapter = registry.runtimeFor('claude-code');
    expect(adapter.id).toBe('claude-code');
    expect(adapter.capabilities.steer).toBe('queued'); // fallback-wrapped
    const handle = await registry.spawn('gru');
    try {
      const events = collect(handle);
      expect(handle.canCompact?.()).toBe(false);
      await handle.prompt('through the registry', { owner: 'alice' });
      expect(deltas(events, 'text_delta').join('')).toBe('echo: through the registry');
      expect(handle.canCompact?.()).toBe(true);
      await handle.compact?.();
      expect(handle.canCompact?.()).toBe(true);
      expect(events.some((event) => event.type === 'compaction_end' && event.success)).toBe(true);
      const status = registry.status();
      expect(status.adapters).toEqual([{ id: 'claude-code', state: 'ok' }]);
      expect(status.agentSession.state).toBe('idle');
      expect(status.activeSessions).toBe(1);
    } finally {
      await registry.disposeHandle(handle);
    }
    expect(registry.status().activeSessions).toBe(0);
    await registry.dispose();
  });

  it('steer mid-turn queues (steer-unable) and delivers as a SECOND process after idle #contract:steering:claude-code', async () => {
    const { fx, registry } = await claudeRegistryFixture();
    registry.boot();
    const handle = await registry.spawn('gru');
    try {
      const events = collect(handle);
      const releaseFile = join(fx.home, 'release-steer');
      const first = handle.prompt(`hold:${releaseFile}`, { owner: 'alice' });
      // Wait for the first process to be live — condition-based, no sleep.
      await waitFor(
        () => handle.health().state === 'streaming' && doubleInvocations(fx).length === 1,
      );
      const steered = handle.steer('redirect please', { owner: 'bob' });
      // Held: the queue event fires synchronously and no second process spawns.
      expect(events.some((e) => e.type === 'queued' && e.reason === 'steer-unable')).toBe(true);
      expect(doubleInvocations(fx).length).toBe(1);
      writeFileSync(releaseFile, 'go', 'utf-8');
      await first;
      await steered; // resolves only after ITS delivered turn completes
      const invocations = doubleInvocations(fx);
      expect(invocations.length).toBe(2);
      expect(invocations[0]!.prompt).toBe(`hold:${releaseFile}`);
      expect(invocations[1]!.prompt).toBe('redirect please');
      // Never interleaved: the second invocation's session flag is --resume
      // of the SAME session (turn chaining, not a parallel session).
      expect(invocations[1]!.argv[invocations[1]!.argv.indexOf('--resume') + 1]).toBe(
        invocations[0]!.sessionId,
      );
    } finally {
      await registry.dispose();
    }
  });

  it('followUp mid-turn queues with reason single-writer', async () => {
    const { fx, registry } = await claudeRegistryFixture();
    registry.boot();
    const handle = await registry.spawn('gru');
    try {
      const events = collect(handle);
      const releaseFile = join(fx.home, 'release-followup');
      const first = handle.prompt(`hold:${releaseFile}`, { owner: 'alice' });
      await waitFor(
        () => handle.health().state === 'streaming' && doubleInvocations(fx).length === 1,
      );
      const follow = handle.followUp('and then this', { owner: 'alice' });
      expect(
        events.some((e) => e.type === 'queued' && e.reason === 'single-writer'),
      ).toBe(true);
      writeFileSync(releaseFile, 'go', 'utf-8');
      await Promise.all([first, follow]);
      const invocations = doubleInvocations(fx);
      expect(invocations.map((i) => i.prompt)).toEqual([
        `hold:${releaseFile}`,
        'and then this',
      ]);
    } finally {
      await registry.dispose();
    }
  });

  it('config-driven ruling-16 policy flows through the registry into argv #contract:registry-policy:claude-code', async () => {
    const fx = fixture();
    writeFileSync(
      configPathFor(fx.home),
      [
        `workspace_root = "${fx.workspace}"`,
        '[runtimes]',
        'default = "claude-code"',
        '[runtimes.claude-code]',
        'model = "anthropic/claude-policy"',
        'thinking_level = "low"',
        '[runtimes.claude-code.roles]',
        'minion = { model = "bedrock/us.anthropic.claude-minion", thinking_level = "max" }',
        '',
      ].join('\n'),
      'utf-8',
    );
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      claude: { binary: DOUBLE, reviewSettingsFile: join(fx.home, 'absent-review-settings.json') },
    });
    try {
      const gru = await registry.spawn('gru');
      await gru.prompt('policy check');
      const minion = await registry.spawn('minion');
      await minion.prompt('role policy check');
      // Spawn options beat the configured policy (most specific wins).
      const override = await registry.spawn('bob', { model: 'anthropic/claude-opt' });
      await override.prompt('override check');
      const [a, b, c] = doubleInvocations(fx);
      expect(a!.argv[a!.argv.indexOf('--model') + 1]).toBe('claude-policy');
      expect(a!.argv[a!.argv.indexOf('--effort') + 1]).toBe('low');
      expect(b!.argv[b!.argv.indexOf('--model') + 1]).toBe('us.anthropic.claude-minion');
      expect(b!.argv[b!.argv.indexOf('--effort') + 1]).toBe('max');
      expect(c!.argv[c!.argv.indexOf('--model') + 1]).toBe('claude-opt');
      expect(c!.argv[c!.argv.indexOf('--effort') + 1]).toBe('low'); // policy still applies
    } finally {
      await registry.dispose();
    }
  });
});

describe('NdjsonParser (pure)', () => {
  it('reassembles frames split across byte chunks and mid-multibyte characters', () => {
    const frames: StreamFrame[] = [];
    const parser = new NdjsonParser({ onFrame: (f) => frames.push(f) });
    const payload = Buffer.from('{"type":"assistant","note":"héllo ★ ☃"}\n{"type":"result","is_error":false}\n', 'utf8');
    for (let i = 0; i < payload.length; i += 1) {
      parser.push(payload.subarray(i, i + 1)); // one byte at a time
    }
    parser.end();
    expect(frames.length).toBe(2);
    expect(frames[0]!['note']).toBe('héllo ★ ☃');
    expect(frames[1]!['type']).toBe('result');
  });

  it('skips blank lines silently, reports garbage and torn tails', () => {
    const frames: StreamFrame[] = [];
    const garbage: string[] = [];
    const parser = new NdjsonParser({
      onFrame: (f) => frames.push(f),
      onGarbage: (line) => garbage.push(line),
    });
    parser.push('\n  \n{"type":"system"}\nnot json\n');
    parser.end();
    expect(frames.length).toBe(1);
    expect(garbage).toEqual(['not json']);
    const parser2 = new NdjsonParser({
      onFrame: (f) => frames.push(f),
      onGarbage: (line) => garbage.push(line),
    });
    parser2.push('{"type":"resul');
    parser2.end();
    expect(garbage).toEqual(['not json', '{"type":"resul']);
  });

  it('delivers a complete-but-unterminated final frame at EOF (kill raced the newline)', () => {
    const frames: StreamFrame[] = [];
    const garbage: string[] = [];
    const parser = new NdjsonParser({
      onFrame: (f) => frames.push(f),
      onGarbage: (line) => garbage.push(line),
    });
    parser.push('{"type":"assistant"}\n{"type":"result","is_error":false}');
    parser.end();
    expect(frames).toEqual([{ type: 'assistant' }, { type: 'result', is_error: false }]);
    expect(garbage).toEqual([]);
  });

  it('rejects mixing string and byte pushes on one parser (decoder state would corrupt order)', () => {
    const parser = new NdjsonParser({ onFrame: () => {} });
    parser.push(Buffer.from('{"a":1'));
    expect(() => parser.push('"b":2}\n')).toThrow(/do not mix/);
    const parser2 = new NdjsonParser({ onFrame: () => {} });
    parser2.push('{"a":1');
    expect(() => parser2.push(Buffer.from('}\n'))).toThrow(/do not mix/);
  });

  it('treats non-object JSON lines (arrays, scalars) as garbage', () => {
    const frames: StreamFrame[] = [];
    const garbage: string[] = [];
    const parser = new NdjsonParser({
      onFrame: (f) => frames.push(f),
      onGarbage: (line) => garbage.push(line),
    });
    parser.push('[1,2,3]\n42\n"str"\n{"ok":true}\n');
    parser.end();
    expect(frames).toEqual([{ ok: true }]);
    expect(garbage).toEqual(['[1,2,3]', '42', '"str"']);
  });
});

describe('ClaudeControlTranslator (pure)', () => {
  function expectCompactSuccess(frame: StreamFrame): void {
    const translator = new ClaudeControlTranslator();
    translator.ingest(frame);
    expect(translator.compactSucceeded).toBe(true);
    expect(translator.compactFailure).toBeNull();
  }

  it('accepts a native compact success reported by status alone', () => {
    expectCompactSuccess({ type: 'system', subtype: 'status', compact_result: 'success' });
  });

  it('accepts a native compact success reported by boundary alone', () => {
    expectCompactSuccess({ type: 'system', subtype: 'compact_boundary' });
  });

  it('keeps a native compact failure sticky if a later status claims success', () => {
    const translator = new ClaudeControlTranslator();
    translator.ingest({
      type: 'system',
      subtype: 'status',
      compact_result: 'failed',
      compact_error: 'first failure',
    });
    translator.ingest({ type: 'system', subtype: 'status', compact_result: 'success' });
    translator.ingest({ type: 'system', subtype: 'compact_boundary' });
    expect(translator.compactSucceeded).toBe(false);
    expect(translator.compactFailure).toBe('first failure');
  });
});

/** One Gru turn recorded from Claude Code 2.1.305, content trimmed: two API
 * calls whose blocks repeat their usage, then the result. Two lines are
 * synthesized from the recorded shape: the last call's closing text block
 * (the recorded call ended in a tool call) and the subagent frame. */
const RECORDED_TURN = join(import.meta.dirname, 'fixtures', 'claude-stream', 'context-usage-turn.jsonl');
const recordedFrames = (): StreamFrame[] =>
  readFileSync(RECORDED_TURN, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as StreamFrame);
/** The last main-thread call: 2 + 643 + 77,264 of claude-opus-5-5's 1,000,000. */
const MEASURED = { tokens: 77_909, contextWindow: 1_000_000, percent: 7.7909 };

describe('Claude context usage from recorded stream-json (#461)', () => {
  const measure = (frames: readonly StreamFrame[]) => {
    const t = new ClaudeTurnTranslator();
    for (const frame of frames) t.ingest(frame);
    return t.contextUsage;
  };
  const messageOf = (frame: StreamFrame) => frame['message'] as StreamFrame;
  const isMain = (frame: StreamFrame) => frame['type'] === 'assistant' && frame['parent_tool_use_id'] === null;
  const lastMainIndex = (frames: readonly StreamFrame[]) => frames.map(isMain).lastIndexOf(true);
  /** The recorded turn with its result frame rebuilt by `edit`. */
  const withResult = (edit: (result: StreamFrame) => StreamFrame) =>
    recordedFrames().map((frame) => (frame['type'] === 'result' ? edit(frame) : frame));
  /** The recorded turn ending in the CLI's in-band API error: its synthetic
   * message, then an is_error result that still carries the window. */
  const inBandErrorTurn = () => {
    const frames = recordedFrames();
    const result = frames.pop()!;
    const synthetic = {
      type: 'assistant', parent_tool_use_id: null, session_id: 'recorded-session', is_api_error_message: true, error: 'rate_limit', api_error_status: 429,
      message: { id: 'msg_synthetic', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your limit" }],
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
    };
    return [...frames, synthetic, { ...result, is_error: true, api_error_status: 429 }];
  };
  /** The recorded turn with the LAST main-thread frame's usage rebuilt by `edit`. */
  const withLastUsage = (edit: (usage: StreamFrame) => StreamFrame) => {
    const frames = recordedFrames();
    const last = lastMainIndex(frames);
    const message = messageOf(frames[last]!);
    frames[last] = { ...frames[last]!, message: { ...message, usage: edit(message['usage'] as StreamFrame) } };
    return frames;
  };

  it('measures the latest main-thread call against the result window for its model', () => {
    expect(measure(recordedFrames())).toEqual(MEASURED);
  });

  it('counts repeated blocks of one API message once, and the last call of the turn wins', () => {
    const frames = recordedFrames();
    const lastMain = frames[lastMainIndex(frames)]!;
    expect(measure([...frames.slice(0, -1), lastMain, lastMain, frames.at(-1)!])).toEqual(MEASURED);
    // The later call wins even when it is the smaller one (latest, not largest).
    const firstCall = frames.filter((frame) => isMain(frame) && messageOf(frame)['id'] === 'msg_011CgEJhS5MsRc98HWnziMaQ');
    const reordered = [...frames.filter((frame) => !firstCall.includes(frame) && frame['type'] !== 'result'), ...firstCall, frames.at(-1)!];
    expect(measure(reordered)).toEqual({ tokens: 2 + 1_803 + 75_461, contextWindow: 1_000_000, percent: 7.7266 });
  });

  it('subagent frames never change the measurement', () => {
    const frames = recordedFrames();
    const subagent = frames.find((frame) => frame['type'] === 'assistant' && frame['parent_tool_use_id'] !== null)!;
    expect(subagent).toBeDefined();
    expect(measure(frames)).toEqual(MEASURED);
    // The same frame on the main thread would have counted: the parent is what excludes it.
    const asMain = frames.map((frame) => (frame === subagent ? { ...frame, parent_tool_use_id: null } : frame));
    expect(measure(asMain)?.tokens).toBe(3 + 5_000 + 150_000);
  });

  it('a result without the window for that model measures nothing', () => {
    expect(measure(recordedFrames().filter((frame) => frame['type'] !== 'result'))).toBeNull();
    expect(measure(withResult(({ modelUsage: _dropped, ...result }) => result))).toBeNull();
    expect(measure(withResult((result) => ({ ...result, modelUsage: { 'claude-other-model': { contextWindow: 1_000_000 } } })))).toBeNull();
    for (const contextWindow of [0, -1, 1.5, '1000000', null, undefined]) {
      expect(measure(withResult((result) => ({ ...result, modelUsage: { 'claude-opus-5-5': { contextWindow } } })))).toBeNull();
    }
  });

  it('malformed usage on the latest main-thread frame measures nothing rather than an older call', () => {
    expect(measure(withLastUsage(({ cache_read_input_tokens: _dropped, ...usage }) => usage))).toBeNull();
    expect(measure(withLastUsage((usage) => ({ ...usage, input_tokens: -2 })))).toBeNull();
    expect(measure(withLastUsage((usage) => ({ ...usage, cache_creation_input_tokens: '643' })))).toBeNull();
    const frames = recordedFrames();
    const last = lastMainIndex(frames);
    const { model: _dropped, ...message } = messageOf(frames[last]!);
    frames[last] = { ...frames[last]!, message };
    expect(measure(frames)).toBeNull();
  });

  it('an errored turn measures nothing (owner ruling 2026-10-21)', () => {
    expect(measure(inBandErrorTurn())).toBeNull();
    expect(measure(withResult((result) => ({ ...result, is_error: true })))).toBeNull();
  });

  it('a zero-token synthetic reply is no API call and never replaces the measurement', () => {
    const frames = recordedFrames();
    const result = frames.pop()!;
    // The CLI's own unflagged reply, as Claude Code transcripts record it.
    const noResponse = {
      type: 'assistant', parent_tool_use_id: null, session_id: 'recorded-session',
      message: { id: 'msg_no_response', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }],
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
    };
    expect(measure([...frames, noResponse, result])).toEqual(MEASURED);
    // A turn whose only reply is synthetic made no API call: nothing measures it.
    expect(measure([noResponse, result])).toBeNull();
  });

  it('a native compaction inside the turn resets the measurement until a later call', () => {
    const frames = recordedFrames();
    const result = frames.pop()!;
    const boundary = { type: 'system', subtype: 'compact_boundary', session_id: 'recorded-session' };
    expect(measure([...frames, boundary, result])).toBeNull();
    expect(measure([...frames, { type: 'compact_boundary', session_id: 'recorded-session' }, result])).toBeNull();
    const lastMain = frames[lastMainIndex(frames)]!;
    expect(measure([...frames, boundary, lastMain, result])).toEqual(MEASURED);
    // A subagent's compaction (a synthesized shape) is another context: the main measurement stands.
    expect(measure([...frames, { ...boundary, parent_tool_use_id: 'toolu_subagent_context_461' }, result])).toEqual(MEASURED);
  });

  it('with several models in the result, the main-thread call reads its own model\'s window', () => {
    const frames = withResult((result) => ({
      ...result,
      modelUsage: { 'claude-haiku-4-5': { contextWindow: 200_000 }, ...(result['modelUsage'] as StreamFrame), 'claude-sonnet-5-5': { contextWindow: 400_000 } },
    }));
    expect(measure(frames)).toEqual(MEASURED);
  });

  it('a prompt larger than the reported window measures nothing: that window cannot be the call\'s', () => {
    const frames = withResult((result) => ({ ...result, modelUsage: { 'claude-opus-5-5': { contextWindow: 50_000 } } }));
    expect(measure(frames)).toBeNull();
    const exact = withResult((result) => ({ ...result, modelUsage: { 'claude-opus-5-5': { contextWindow: 77_909 } } }));
    expect(measure(exact)).toEqual({ tokens: 77_909, contextWindow: 77_909, percent: 100 });
  });

  it('a fresh handle is unmeasured; a replayed turn measures; a turn without a result clears it #contract:context-usage:claude-code', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      expect(handle.getContextUsage?.()).toBeNull();
      process.env['CLAUDE_DOUBLE_REPLAY'] = RECORDED_TURN;
      const events = collect(handle);
      await handle.prompt('measure this turn');
      expect(deltas(events, 'text_delta').join('')).toContain('Recorded turn answer.');
      expect(handle.getContextUsage?.()).toEqual(MEASURED);
      // A running turn has no current measurement, and a turn the provider did
      // not measure (the double's own frames carry no window) leaves none behind.
      delete process.env['CLAUDE_DOUBLE_REPLAY'];
      const release = join(fx.home, 'release-measured-hold');
      const held = handle.prompt(`hold:${release}`);
      await waitFor(() => handle.health().state === 'streaming');
      expect(handle.getContextUsage?.()).toBeNull();
      writeFileSync(release, '');
      await held;
      expect(handle.getContextUsage?.()).toBeNull();
      process.env['CLAUDE_DOUBLE_REPLAY'] = RECORDED_TURN;
      await handle.prompt('measure again');
      expect(handle.getContextUsage?.()).toEqual(MEASURED);
      // A turn that dies without a result frame leaves none behind either.
      await expect(handle.prompt('crash')).rejects.toThrow();
      expect(handle.getContextUsage?.()).toBeNull();
    } finally {
      await handle.dispose();
    }
    expect(handle.getContextUsage?.()).toBeNull();
  });

  it('compaction clears the measurement until the next measured turn, whether it succeeds or fails', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      process.env['CLAUDE_DOUBLE_REPLAY'] = RECORDED_TURN;
      await handle.prompt('measure before compact');
      expect(handle.getContextUsage?.()).toEqual(MEASURED);
      const release = join(fx.home, 'release-compact');
      process.env['CLAUDE_DOUBLE_COMPACT_HOLD_FILE'] = release;
      const compacting = handle.compact!();
      await waitFor(() => handle.isCompacting?.() === true);
      expect(handle.getContextUsage?.()).toBeNull();
      writeFileSync(release, '');
      await compacting;
      delete process.env['CLAUDE_DOUBLE_COMPACT_HOLD_FILE'];
      expect(handle.getContextUsage?.()).toBeNull();
      await handle.prompt('measure after compact');
      expect(handle.getContextUsage?.()).toEqual(MEASURED);

      process.env['CLAUDE_DOUBLE_COMPACT_ERROR'] = '1';
      await expect(handle.compact!()).rejects.toThrow(/native compact failed/);
      expect(handle.getContextUsage?.()).toBeNull();
      delete process.env['CLAUDE_DOUBLE_COMPACT_ERROR'];
      await handle.prompt('measure after failed compact');
      expect(handle.getContextUsage?.()).toEqual(MEASURED);
    } finally {
      await handle.dispose();
    }
  });

  it('an in-band error leaves the handle in error with no measurement; the next measured turn restores it', async () => {
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      process.env['CLAUDE_DOUBLE_REPLAY'] = RECORDED_TURN;
      await handle.prompt('measure first');
      expect(handle.getContextUsage?.()).toEqual(MEASURED);
      const errored = join(fx.home, 'in-band-error-turn.jsonl');
      writeFileSync(errored, inBandErrorTurn().map((frame) => JSON.stringify(frame)).join('\n'));
      process.env['CLAUDE_DOUBLE_REPLAY'] = errored;
      await handle.prompt('hit the limit');
      expect(handle.health().state).toBe('error');
      expect(handle.getContextUsage?.()).toBeNull();
      process.env['CLAUDE_DOUBLE_REPLAY'] = RECORDED_TURN;
      await handle.prompt('after the limit resets');
      expect(handle.getContextUsage?.()).toEqual(MEASURED);
    } finally {
      await handle.dispose();
    }
  });

  it('a resumed session is unmeasured before its first turn, never seeded from its transcript', async () => {
    const fx = fixture();
    const first = await fx.runtime.spawn('gru');
    try {
      process.env['CLAUDE_DOUBLE_REPLAY'] = RECORDED_TURN;
      await first.prompt('measure, then restart');
      expect(first.getContextUsage?.()).toEqual(MEASURED);
    } finally {
      await first.dispose();
    }
    const file = first.sessionFile!;
    expect(readFileSync(file, 'utf8')).toContain('"cache_read_input_tokens":77264');
    const resumed = await fx.runtime.spawn('gru', { resumeFile: file });
    try {
      expect(resumed.getContextUsage?.()).toBeNull();
      await resumed.prompt('first turn after restart');
      expect(resumed.getContextUsage?.()).toEqual(MEASURED);
    } finally {
      await resumed.dispose();
    }
  });
});

describe('ClaudeTurnTranslator (pure)', () => {
  const init = { type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: [] };

  it('per-message dedupe: a message whose partials never arrived still emits from its complete frame', () => {
    const t = new ClaudeTurnTranslator();
    const events: RuntimeEvent[] = [];
    const feed = (frame: StreamFrame) => events.push(...t.ingest(frame));
    feed(init);
    // Message 1: full SSE chain (message_start carries the id).
    feed({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg_1' } },
    });
    feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one' } },
    });
    feed({ type: 'stream_event', event: { type: 'message_stop' } });
    feed({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'one' }] } });
    // Message 2: its partials NEVER arrived (CLI quirk) — the complete frame
    // must still emit (no turn-global suppression).
    feed({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'two' }] } });
    expect(events).toEqual([
      { type: 'text_delta', delta: 'one' },
      { type: 'text_delta', delta: 'two' },
    ]);
  });

  it('dedupes partials against complete frames (text never emitted twice)', () => {
    const t = new ClaudeTurnTranslator();
    const events: RuntimeEvent[] = [];
    const feed = (frame: StreamFrame) => events.push(...t.ingest(frame));
    feed(init);
    feed({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } },
    });
    feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
    });
    feed({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    feed({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    expect(events).toEqual([
      { type: 'text_delta', delta: 'he' },
      { type: 'text_delta', delta: 'llo' },
    ]);
    expect(t.init?.sessionId).toBe('s1');
  });

  it('falls back to complete frames when no partials arrive (text, thinking, tool_start)', () => {
    const t = new ClaudeTurnTranslator();
    const events: RuntimeEvent[] = [];
    const feed = (frame: StreamFrame) => events.push(...t.ingest(frame));
    feed(init);
    feed({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
        ],
      },
    });
    feed({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true }],
      },
    });
    expect(events).toEqual([
      { type: 'thinking_delta', delta: 'hmm' },
      { type: 'text_delta', delta: 'answer' },
      { type: 'tool_start', callId: 'toolu_1', tool: 'Bash' },
      { type: 'tool_end', callId: 'toolu_1', isError: true },
    ]);
  });

  it('tracks tool blocks by index: partials announce tool_start and map input_json_delta to tool_update', () => {
    const t = new ClaudeTurnTranslator();
    const events: RuntimeEvent[] = [];
    const feed = (frame: StreamFrame) => events.push(...t.ingest(frame));
    feed({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_9', name: 'Read' },
      },
    });
    feed({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
    });
    feed({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
    // The complete frame arrives later — must NOT re-announce.
    feed({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: {} }] },
    });
    expect(events).toEqual([
      { type: 'tool_start', callId: 'toolu_9', tool: 'Read' },
      { type: 'tool_update', callId: 'toolu_9' },
    ]);
  });

  it('maps tool_progress to tool_update, skips unknown frame types, captures the result frame', () => {
    const t = new ClaudeTurnTranslator();
    expect(t.ingest({ type: 'tool_progress', parent_tool_use_id: 'toolu_1' })).toEqual([
      { type: 'tool_update', callId: 'toolu_1' },
    ]);
    expect(t.ingest({ type: 'rate_limit_event', rate_limit_info: {} })).toEqual([]);
    expect(t.ingest({ type: 'system', subtype: 'api_retry', attempt: 1 })).toEqual([]);
    expect(t.ingest({ type: 'some_future_frame' })).toEqual([]);
    expect(
      t.ingest({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
    ).toEqual([]);
    expect(t.result).toEqual({ subtype: 'success', isError: false, text: 'done', apiErrorStatus: null });
    // A second result frame is ignored (exactly one per turn).
    t.ingest({ type: 'result', subtype: 'error', is_error: true });
    expect(t.result?.subtype).toBe('success');
  });

  it('extractSessionId scans past garbage and torn lines to the first session_id', () => {
    const text = [
      '{"type":"resul', // torn
      'not json',
      '{"type":"system","subtype":"init","session_id":"abc-123"}',
      '{"type":"assistant","session_id":"abc-123"}',
      '',
    ].join('\n');
    expect(extractSessionId(text)).toBe('abc-123');
    expect(extractSessionId('')).toBeNull();
    expect(extractSessionId('{"type":"user","message":{}}\n')).toBeNull();
  });
});

describe('ReviewMcpBridge bounded protocol failures', () => {
  it('cleans the owned temporary directory when chmod fails during startup', async () => {
    const prefix = 'gru-review-mcp-';
    const before = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix)));
    await expect(ReviewMcpBridge.start([{
      name: 'perkins_probe', description: 'probe', inputSchema: { type: 'object' },
      execute: async () => ({ text: 'ok' }),
    }], {
      chmod: () => { throw new Error('forced chmod failure'); },
    })).rejects.toThrow('forced chmod failure');
    const created = readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix) && !before.has(entry));
    expect(created).toEqual([]);
  });

  it('returns a bounded error for an oversized request without an uncaught socket error', async () => {
    const bridge = await ReviewMcpBridge.start([{
      name: 'perkins_probe', description: 'probe', inputSchema: { type: 'object' },
      execute: async () => ({ text: 'ok' }),
    }]);
    try {
      const response = await new Promise<string>((resolveResponse, reject) => {
        const socket = createConnection(bridge.socketPath);
        let body = '';
        const timer = setTimeout(() => reject(new Error('oversize bridge response timed out')), 5_000);
        socket.setEncoding('utf8');
        socket.once('connect', () => socket.write(`${'x'.repeat(1024 * 1024 + 1)}\n`));
        socket.on('data', (chunk) => { body += chunk; });
        socket.once('error', reject);
        socket.once('end', () => {
          clearTimeout(timer);
          resolveResponse(body);
        });
      });
      expect(JSON.parse(response)).toMatchObject({
        id: 'invalid', ok: false, error: 'review bridge request exceeds 1 MiB',
      });
    } finally {
      const directory = dirname(bridge.configFile);
      await bridge.close();
      expect(existsSync(directory)).toBe(false);
    }
  });

  it('rejects malformed request input and non-object native structured details', async () => {
    const bridge = await ReviewMcpBridge.start([{
      name: 'perkins_bad_details', description: 'bad details', inputSchema: { type: 'object' },
      execute: async () => ({ text: 'unsafe', details: 'not-an-object' } as never),
    }]);
    const call = async (request: unknown): Promise<{ ok: boolean; error?: string }> =>
      new Promise((resolveResponse, reject) => {
        const socket = createConnection(bridge.socketPath);
        let body = '';
        socket.setEncoding('utf8');
        socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on('data', (chunk) => { body += chunk; });
        socket.once('error', reject);
        socket.once('end', () => resolveResponse(JSON.parse(body) as { ok: boolean; error?: string }));
      });
    try {
      await expect(call({ id: 'array-input', name: 'perkins_bad_details', input: [] }))
        .resolves.toMatchObject({ ok: false, error: 'review bridge request input must be an object' });
      await expect(call({ id: 'bad-details', name: 'perkins_bad_details', input: {} }))
        .resolves.toMatchObject({ ok: false, error: 'native review tool returned non-object structured details' });
    } finally {
      await bridge.close();
    }
  });

  it('caps aggregate bridge sockets and concurrent close callers share one teardown', async () => {
    const bridge = await ReviewMcpBridge.start([{
      name: 'perkins_probe', description: 'probe', inputSchema: { type: 'object' },
      execute: async () => ({ text: 'ok' }),
    }]);
    const held = Array.from({ length: 16 }, () => createConnection(bridge.socketPath));
    for (const socket of held) socket.on('error', () => {});
    await Promise.all(held.map((socket) => new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    })));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rejected = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(bridge.socketPath);
      let body = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { body += chunk; });
      socket.once('error', reject);
      socket.once('end', () => resolve(body));
    });
    expect(JSON.parse(rejected)).toMatchObject({
      id: 'invalid', ok: false, error: 'review bridge connection limit reached',
    });
    const first = bridge.close();
    const second = bridge.close();
    expect(first).toBe(second);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(held.every((socket) => socket.destroyed)).toBe(true);
  });

  it('contains a peer disconnect while an asynchronous native tool is completing', async () => {
    let release!: () => void;
    let started!: () => void;
    const toolStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    const toolRelease = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const bridge = await ReviewMcpBridge.start([{
      name: 'perkins_wait', description: 'wait', inputSchema: { type: 'object' },
      execute: async () => {
        started();
        await toolRelease;
        return { text: 'finished after disconnect' };
      },
    }]);
    const socket = createConnection(bridge.socketPath);
    socket.on('error', () => {});
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 'disconnect', name: 'perkins_wait', input: {} })}\n`);
    });
    await toolStarted;
    socket.destroy();
    release();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await expect(bridge.close()).resolves.toBeUndefined();
  });
});

describe('spawn cwd (SPEC ruling 17 — dispatch roots in the project)', () => {
  it('runs the CLI with the explicit project cwd, not the workspace root #contract:spawn-cwd:claude-code', async () => {
    const fx = fixture();
    const project = join(fx.workspace, 'fixture-project');
    mkdirSync(project, { recursive: true });
    const handle = await fx.runtime.spawn('minion', { cwd: project });
    await handle.prompt('build this');
    await handle.dispose();
    const [invocation] = doubleInvocations(fx);
    expect(realpathSync(invocation!.cwd)).toBe(realpathSync(project));
  });

  it('fails loud on a bad cwd before any CLI process exists', async () => {
    const fx = fixture();
    await expect(fx.runtime.spawn('minion', { cwd: 'relative' })).rejects.toThrowError(/absolute path/);
    await expect(fx.runtime.spawn('minion', { cwd: join(fx.workspace, 'nope') })).rejects.toThrowError(
      /does not exist/,
    );
    expect(doubleInvocations(fx)).toHaveLength(0);
  });
});

describe('isolated-review confinement guards', () => {
  it('rejects a review cwd containing allowedTools pattern metacharacters before spawn', async () => {
    const fx = fixture();
    const hostile = join(fx.workspace, 'hostile(*)&dir');
    mkdirSync(hostile, { recursive: true });
    await expect(fx.runtime.spawn('perkins', {
      cwd: hostile,
      isolatedReview: { systemPrompt: 'isolated policy', tools: ['read'] },
    }).then(async (handle) => {
      try {
        return await handle.prompt('frozen diff only');
      } finally {
        await handle.dispose();
      }
    })).rejects.toThrow(/pattern metacharacters unsafe for Claude allowedTools confinement/u);
    expect(doubleInvocations(fx)).toHaveLength(0);
  });
});

describe('ReviewMcpBridge fail-closed guards', () => {
  it('rejects invalid or duplicate native tool names at start', async () => {
    await expect(ReviewMcpBridge.start([{
      name: 'not-perkins-prefixed', description: 'x', inputSchema: { type: 'object' }, execute: async () => ({ text: '' }),
    }])).rejects.toThrow(/invalid or duplicate native tool name/u);
    const tool = {
      name: 'perkins_ok', description: 'x', inputSchema: { type: 'object' }, execute: async () => ({ text: '' }),
    };
    await expect(ReviewMcpBridge.start([tool, { ...tool, name: 'perkins_ok' }]))
      .rejects.toThrow(/invalid or duplicate native tool name/u);
  });

  it('rejects a tampered bundled MCP server before launching it', async () => {
    const staged = mkdtempSync(join(tmpdir(), 'claude-bridge-stage-'));
    const originalServer = readFileSync(new URL('../src/runtime/review-mcp-server.mjs', import.meta.url));
    const originalBridge = readFileSync(new URL('../dist/runtime/review-mcp-bridge.js', import.meta.url));
    try {
      writeFileSync(join(staged, 'review-mcp-server.mjs'), Buffer.concat([originalServer, Buffer.from('\n// tampered\n')]));
      const stagedBridgeSource = originalBridge.toString('utf8').replace(/\/\/# sourceMappingURL=.*\n?/u, '');
      writeFileSync(join(staged, 'review-mcp-bridge.js'), stagedBridgeSource, 'utf8');
      writeFileSync(join(staged, 'package.json'), '{"type":"module"}\n', 'utf8');
      const { ReviewMcpBridge: StagedBridge } = await import(
        pathToFileURL(join(staged, 'review-mcp-bridge.js')).href
      );
      await expect(StagedBridge.start([{
        name: 'perkins_ok', description: 'x', inputSchema: { type: 'object' }, execute: async () => ({ text: '' }),
      }])).rejects.toThrow(/integrity mismatch/u);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  });

  it('issue #315: an ordinary minion carries the private verification settings, never a review session', async () => {
    const policy: WorkerVerificationPolicy = {
      jobId: 'job-915', laneId: 'job-915', cwd: '/lane', scopes: ['full'],
      producerPrefixes: [['npm', 'test']], helper: '/pkg/dist/verify/capture-cli.js', configFile: '/instance/config.toml',
    };
    const fx = fixture();
    const handle = await fx.runtime.spawn('gru', { workerVerification: policy });
    const owned = handle as unknown as { params: { verificationSettingsFile?: string; isolatedReview?: boolean } };
    const file = owned.params.verificationSettingsFile;
    expect(file).toBeDefined();
    expect(existsSync(file as string)).toBe(true);
    const settings = JSON.parse(readFileSync(file as string, 'utf8')) as { permissions?: { ask?: string[] } };
    expect(settings.permissions?.ask?.length ?? 0).toBeGreaterThan(0);
    await handle.dispose();
    // A child that never started ceases immediately: the private dir is cleaned.
    expect(existsSync(file as string)).toBe(false);
    const isolated = await fx.runtime.spawn('gru', { isolatedReview: { systemPrompt: 'frozen native policy', tools: [] } });
    expect((isolated as unknown as { params: { verificationSettingsFile?: string } }).params.verificationSettingsFile).toBeUndefined();
    await isolated.dispose();
    await fx.runtime.dispose();
  });

  describe('issue #315: private verification-file custody', () => {
    const policy: WorkerVerificationPolicy = {
      jobId: 'job-915', laneId: 'job-915', cwd: '/lane', scopes: ['full'],
      producerPrefixes: [['npm', 'test']], helper: '/pkg/dist/verify/capture-cli.js', configFile: '/instance/config.toml',
    };

    async function settingsLifetime(outcome: 'deadline' | 'error', recordedExit = false): Promise<void> {
      const fx = fixture({ killGraceMs: 5 });
      const handle = await fx.runtime.spawn('gru', { workerVerification: policy });
      const owned = handle as unknown as {
        params: { verificationSettingsFile?: string };
        live: ChildProcess | null;
        cessationKind: string;
      };
      const file = owned.params.verificationSettingsFile as string;
      const policyFile = join(dirname(file), 'policy.json');
      const original = Object.assign(new EventEmitter(), {
        exitCode: null, signalCode: null, kill: vi.fn(() => true),
      }) as unknown as ChildProcess;
      owned.live = original;
      vi.useFakeTimers();
      try {
        const disposing = handle.dispose();
        const settled = disposing.then(() => 'fulfilled', () => 'rejected');
        // A real ChildProcess records its exit before its close: an exit seen
        // after the disposal began is no proof past an error or the deadline (#359).
        if (recordedExit) Object.assign(original, { exitCode: 143 });
        if (outcome === 'error') original.emit('error', new Error('owned fixture transport error'));
        await vi.advanceTimersByTimeAsync(40);
        expect(await settled).toBe('fulfilled');
        // Cessation is UNKNOWN: the original child never reported a close.
        expect(handle.cessationEvidence!()).toBe('unknown');
        expect(existsSync(file)).toBe(true);
        expect(existsSync(policyFile)).toBe(true);
        // Only the identity-bound original close releases the private files.
        original.emit('close', 0, null);
        expect(existsSync(file)).toBe(false);
        expect(existsSync(policyFile)).toBe(false);
      } finally {
        original.emit('close', 0, null);
        vi.useRealTimers();
        await fx.runtime.dispose();
      }
    }

    it('retains private verification files through an unknown deadline until late close', async () => {
      await settingsLifetime('deadline');
    });

    it('retains private verification files through a child error until actual close', async () => {
      await settingsLifetime('error');
    });

    it('retains private verification files through an exit recorded with no close — past an error or the deadline — until the close (#359)', async () => {
      await settingsLifetime('error', true);
      await settingsLifetime('deadline', true);
    });

    it('a child whose error and close land in the same tick, before the disposal settles, is ceased and releases its files (#359)', async () => {
      const fx = fixture({ killGraceMs: 5 });
      const handle = await fx.runtime.spawn('gru', { workerVerification: policy });
      const owned = handle as unknown as { params: { verificationSettingsFile?: string }; live: ChildProcess | null };
      const file = owned.params.verificationSettingsFile as string;
      const policyFile = join(dirname(file), 'policy.json');
      // The close alone is the proof: this fake never records an exit code or signal.
      // (A policy child's close is also recorded by its custody tracker; the
      // adapter's own same-tick latch is pinned without a policy in
      // runtime-claude-cessation-ownership.test.ts.)
      const original = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;
      owned.live = original;
      vi.useFakeTimers();
      try {
        const disposing = handle.dispose();
        original.emit('error', new Error('owned fixture transport error'));
        original.emit('close', null, 'SIGTERM');
        await vi.advanceTimersByTimeAsync(40);
        await disposing;
        expect(handle.cessationEvidence!()).toBe('ceased');
        expect([existsSync(file), existsSync(policyFile)]).toEqual([false, false]);
      } finally {
        vi.useRealTimers();
        await fx.runtime.dispose();
      }
    });

    /** A controllable policy child: the spawn seam returns it for the turn so
     * an owned error can clear the live slot without a real close. */
    function policyChild(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
      const child = new EventEmitter() as unknown as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
      Object.assign(child, {
        stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null,
        kill: vi.fn(() => true),
      });
      return child as ChildProcess & { kill: ReturnType<typeof vi.fn> };
    }

    it('registers the policy child at spawn so a pre-disposal error keeps the files (N4/R2-V2)', async () => {
      const child = policyChild();
      const fx = fixture({ killGraceMs: 5, spawnProcess: (() => child) as unknown as typeof spawn });
      const handle = await fx.runtime.spawn('gru', { workerVerification: policy });
      const owned = handle as unknown as { params: { verificationSettingsFile?: string }; live: ChildProcess | null };
      const file = owned.params.verificationSettingsFile as string;
      const policyFile = join(dirname(file), 'policy.json');
      const turn = handle.prompt('run the declared checks').catch(() => 'rejected');
      await waitFor(() => owned.live === child);
      // An owned transport error clears the live slot BEFORE dispose runs.
      child.emit('error', new Error('owned fixture transport error'));
      expect(await turn).toBe('rejected');
      expect(owned.live).toBeNull();
      await handle.dispose();
      // Spawn-time registration keeps the tracked original owned, so the files
      // survive and the evidence is honestly UNKNOWN.
      expect(handle.cessationEvidence!()).toBe('unknown');
      expect(existsSync(file)).toBe(true);
      expect(existsSync(policyFile)).toBe(true);
      // Only the identity-bound original close releases them.
      child.emit('close', 0, null);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(policyFile)).toBe(false);
      await fx.runtime.dispose();
    });

    it('signals a tracked policy child after the live slot cleared (N10)', async () => {
      const child = policyChild();
      const fx = fixture({ killGraceMs: 5, spawnProcess: (() => child) as unknown as typeof spawn });
      const handle = await fx.runtime.spawn('gru', { workerVerification: policy });
      const owned = handle as unknown as { live: ChildProcess | null };
      const turn = handle.prompt('run the declared checks').catch(() => 'rejected');
      await waitFor(() => owned.live === child);
      child.emit('error', new Error('owned fixture transport error'));
      expect(await turn).toBe('rejected');
      expect(owned.live).toBeNull();
      await handle.dispose();
      // The identity-bound original is still a disposal target even though the
      // live slot was cleared: the same bounded termination applies.
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emit('close', 0, null);
      await fx.runtime.dispose();
    });
  });
});
describe('scheduled verification ordinary Claude Bash', () => {
  async function refuses(input: string | ((cwd: string) => string), quality = false) {
    const lane = verificationLane(quality); cleanupDirs.push(lane.root);
    const command = typeof input === 'string' ? input : input(lane.lane.path);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const f = fixture();
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      await handle.prompt(`verification-bash:${command}`);
      expect(existsSync(lane.starts)).toBe(false);
      const transcript = readFileSync(handle.sessionFile!, 'utf8');
      expect(transcript).toContain('capture-cli.js');
      expect(transcript).toContain('focused, full');
      expect(transcript).toContain('no receipt was created');
      const record = JSON.parse(readFileSync(f.doubleLog, 'utf8').trim().split('\n')[0]!);
      const settingsFile = record.argv[record.argv.indexOf('--settings') + 1];
      expect(existsSync(settingsFile)).toBe(true);
      expect(record.argv).toContain('bypassPermissions');
      expect(record.argv).toContain('--permission-prompt-tool');
      expect(record.argv).not.toContain('--mcp-config');
      await handle.dispose();
      expect(existsSync(settingsFile)).toBe(false);
    } finally { process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  }
  it('scheduled verification guard refuses the exact web incident before any producer', async () => refuses(WEB_INCIDENT));
  it('scheduled verification guard refuses the exact npm test incident before any producer', async () => refuses(FULL_INCIDENT));
  it('scheduled verification guard refuses the entire exact build compound before its first producer', async () => refuses(BUILD_INCIDENT));
  it('scheduled verification native denial survives non-blocking hook failure for all incident forms', async () => {
    process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL'] = '1';
    try { for (const command of [WEB_INCIDENT, FULL_INCIDENT, BUILD_INCIDENT]) await refuses(command); }
    finally { delete process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL']; }
  });

  it('review-1 standalone lint refuses before any producer #contract:scheduled-verification:claude-code', async () => refuses('npm run lint'));
  it('review-1 standalone typecheck refuses before any producer', async () => refuses('npm run typecheck'));
  it('review-1 standalone build refuses before any producer', async () => refuses('npm run build'));
  it('review-1 standalone build:web refuses before any producer', async () => refuses('npm run build:web'));
  it('review-1 backend script refuses before any producer', async () => refuses('npm run test:backend'));
  it('review-1 heavy backend script refuses before any producer', async () => refuses('npm run test:backend:heavy'));
  it('review-1 web script refuses in a minimal lane', async () => refuses('npm run test:web'));
  it('review-1 npm prefix normalization refuses before any producer', async () => refuses('npm --prefix web test'));
  it('review-1 npx option normalization refuses before any producer', async () => refuses('npx --no-install vitest run'));
  it('review-1 assignment-prefixed declared custom script refuses', async () => refuses('CI=1 npm run quality', true));
  it('review-1 wrapper nesting and options refuse before any producer', async () => {
    for (const command of ['env -i PATH="$PATH" npm test', 'env -u UNUSED command -p env --ignore-environment PATH="$PATH" npm test', 'command -- env --unset=UNUSED npm test']) await refuses(command);
  });
  it('review-1 adjacent redirects refuse before any producer', async () => {
    for (const command of ['npm test>test.log', 'npm test 2>test.log', 'npm test>>test.log']) await refuses(command);
  });
  it('review-1 known direct local-bin paths refuse before any producer', async () => {
    for (const command of ['./node_modules/.bin/vitest run', 'cd web && ../node_modules/.bin/vitest run']) await refuses(command);
    await refuses((cwd) => `${join(cwd, 'node_modules/.bin/vitest')} run`);
    await refuses((cwd) => `${join(cwd, 'web/node_modules/.bin/vitest')} run`);
  });
  it('review-1 executable producers outside literal heredocs refuse whole calls', async () => {
    await refuses("cat <<'EOF'\nnpm test\nEOF\nnpm run build:web");
    await refuses("npm test; cat <<'EOF'\nnpx vitest run\nEOF");
  });
  it('review-1 each conventional direct tool independently refuses', async () => {
    for (const producer of ['vitest run', 'jest', 'tsc --noEmit', 'eslint .', 'vite build', 'playwright test']) {
      await refuses(producer); await refuses(`npx ${producer}`);
    }
  });
  it('scheduled verification preserves source/Git/quoted-text and normal helper execution', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const capture = await authenticatedCaptureStatus(lane);
    const f = fixture();
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      await handle.prompt(`verification-bash:git status --short; printf '%s' 'npm test'; ${capture.command}`);
      const transcript = readFileSync(handle.sessionFile!, 'utf8');
      expect(capture.requests).toEqual(['GET /api/verify/status?request_id=existing']);
      expect(transcript).toContain('existing');
      expect(transcript).not.toContain('Minion verification refused');
      await handle.dispose();
    } finally { await f.runtime.dispose(); await capture.close(); }
  });
  it('review-1 literal source heredocs and development/setup actions remain normal Bash', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const f = fixture();
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      await handle.prompt("verification-bash:cat > source.txt <<'EOF'\nnpm test && npx vitest run\nEOF\ncat source.txt; vite; vite dev; npx vite preview; playwright install; npx playwright install-deps");
      expect(existsSync(join(lane.lane.path, 'source.txt'))).toBe(true);
      expect(readFileSync(join(lane.lane.path, 'source.txt'), 'utf8')).toBe('npm test && npx vitest run\n');
      expect(readFileSync(lane.starts, 'utf8').trim().split('\n')).toHaveLength(5);
      expect(readFileSync(handle.sessionFile!, 'utf8')).not.toContain('Minion verification refused');
      await handle.dispose();
    } finally { process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });
  it('review-1 second and disposed/reopened turns preserve native guards with zero producer starts', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const f = fixture();
    process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL'] = '1';
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      await handle.prompt(`verification-bash:${FULL_INCIDENT}`);
      await handle.prompt('verification-bash:npm run build:web');
      const file = handle.sessionFile!; await handle.dispose();
      const reopened = await f.runtime.spawn('minion', { ...lane.session, resumeFile: file });
      await reopened.prompt('verification-bash:npx --no-install vitest run');
      expect(existsSync(lane.starts)).toBe(false);
      const records = doubleInvocations(f);
      expect(records).toHaveLength(3);
      for (const record of records) {
        expect(record.argv).toContain('--settings'); expect(record.argv).toContain('--permission-prompt-tool');
        expect(record.cwd).toBe(lane.lane.path);
      }
      expect(records[1]!.argv).toContain('--resume'); expect(records[2]!.argv).toContain('--resume');
      expect(reopened.id).toBe(handle.id);
      expect(readFileSync(file, 'utf8')).toContain('capture-cli.js');
      await reopened.dispose();
    } finally { delete process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL']; process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });
  it('review-1 native fallback independently covers conventional flags and local-bin paths', async () => {
    process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL'] = '1';
    try {
      for (const command of ['npm --prefix web test', 'npx --no-install vitest run', './node_modules/.bin/vitest run', 'cd web && ../node_modules/.bin/vitest run', 'npm test>test.log', 'env -i PATH="$PATH" command -p npm test']) await refuses(command);
      await refuses('CI=1 npm run quality', true);
      await refuses((cwd) => `${join(cwd, 'node_modules/.bin/vitest')} run`);
    } finally { delete process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL']; }
  });

  async function settingsLifetime(outcome: 'deadline' | 'error' | 'dispose-error') {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const f = fixture({ killGraceMs: 5 });
    const handle = await f.runtime.spawn('minion', lane.session);
    const owned = handle as unknown as {
      params: { verificationSettingsFile: string }; live: ChildProcess | null;
    };
    const original = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const foreign = new EventEmitter();
    owned.live = original;
    const file = owned.params.verificationSettingsFile;
    const policyFile = join(dirname(file), 'policy.json');
    const release = outcome === 'dispose-error' ? vi.spyOn(f.store, 'releaseLock').mockImplementationOnce(() => { throw new Error('owned fixture release fault'); }) : null;
    vi.useFakeTimers();
    try {
      const disposing = handle.dispose();
      const settled = disposing.then(() => 'fulfilled', () => 'rejected');
      if (outcome === 'error') original.emit('error', new Error('owned fixture transport error'));
      await vi.advanceTimersByTimeAsync(30);
      expect(await settled).toBe(outcome === 'dispose-error' ? 'rejected' : 'fulfilled');
      expect(handle.cessationEvidence!()).toBe('unknown');
      expect(existsSync(file)).toBe(true); expect(existsSync(policyFile)).toBe(true);
      foreign.emit('close', 0, null);
      expect(existsSync(file)).toBe(true);
      original.emit('close', 0, null);
      expect(existsSync(file)).toBe(false); expect(existsSync(policyFile)).toBe(false);
    } finally {
      original.emit('close', 0, null); release?.mockRestore(); vi.useRealTimers(); await f.runtime.dispose();
    }
  }
  it('review-1 verification files survive unknown deadline until identity-bound late close', async () => settingsLifetime('deadline'));
  it('review-1 verification files survive child error until identity-bound actual close', async () => settingsLifetime('error'));
  it('review-1 verification files survive disposal rejection until identity-bound actual close', async () => settingsLifetime('dispose-error'));

  it('review-2 npm aliases refuse independently before producer start', async () => {
    for (const command of ['npm tst', 'npm run-script lint', 'npm exec -- vitest run', 'npm x -- vitest run', 'npm rum lint', 'npm urn lint']) await refuses(command);
  });
  it('review-2 conventional option positions refuse independently', async () => {
    for (const command of ['npm --loglevel error test', 'npm run --if-present lint', 'npm --loglevel error run --if-present lint']) await refuses(command);
  });
  it('review-2 exact declared script words refuse independently', async () => {
    for (const command of ['npm run test.unit', 'npm run-script check/unit']) await refuses(command, true);
  });
  it('review-2 root-relative web bin paths refuse independently', async () => {
    for (const command of ['web/node_modules/.bin/vitest run', './web/node_modules/.bin/vitest run']) await refuses(command);
  });
  it('review-2 bounded control prefixes refuse entire calls', async () => {
    for (const command of ['! npm test', '! printf ok | npm test', 'if npm test; then printf ok; fi', '( npm test )', '{ npm test; }']) await refuses(command);
  });

  it('review-2 plain unquoted source heredocs and diagnostic reads execute normally', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const f = fixture();
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      await handle.prompt("verification-bash:cat > source.txt <<EOF\nnpm test && npx vitest run\nEOF\ncat source.txt; tsc --version; tsc --showConfig; eslint --help; npx --no-install tsc --version; npm exec -- tsc --showConfig");
      expect(existsSync(join(lane.lane.path, 'source.txt'))).toBe(true);
      expect(readFileSync(join(lane.lane.path, 'source.txt'), 'utf8')).toBe('npm test && npx vitest run\n');
      expect(readFileSync(lane.starts, 'utf8').trim().split('\n')).toEqual(['tsc', 'tsc', 'eslint', 'npx', 'npm']);
      expect(readFileSync(handle.sessionFile!, 'utf8')).not.toContain('Minion verification refused');
      await handle.dispose();
    } finally { process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });
  it('review-2 independent raw corpus exercises native refusal and allow with hook unavailable', async () => {
    const { nativeCorpus } = await import('./helpers/verification-native-corpus.mjs');
    const lane = verificationLane(true); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const f = fixture(); process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL'] = '1';
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      for (const row of nativeCorpus) {
        const before = existsSync(lane.starts) ? readFileSync(lane.starts, 'utf8') : '';
        await handle.prompt(`verification-bash:${row.raw}`);
        const after = existsSync(lane.starts) ? readFileSync(lane.starts, 'utf8') : '';
        if (row.refused) expect(after, row.raw).toBe(before);
        // The per-turn transcript tool_result attests native simulated
        // disposition independently of the model's final text.
        const frames = readFileSync(handle.sessionFile!, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const result = frames.filter((frame) => frame.type === 'user').at(-1);
        expect(result.message.content[0].is_error, row.raw).toBe(row.refused);
      }
      await handle.dispose();
    } finally { delete process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL']; process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });

  async function startedChildCustody(operation: 'prompt' | 'compact') {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const startProcess = vi.fn(childProcesses.spawn);
    const f = fixture({ killGraceMs: 5, spawnProcess: startProcess as unknown as typeof childProcesses.spawn });
    const handle = await f.runtime.spawn('minion', lane.session);
    if (operation === 'compact') await handle.prompt('establish owned session');
    const owned = handle as unknown as { params: { verificationSettingsFile: string }; live: ChildProcess | null; cessationKind: string };
    const original = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, kill: vi.fn(() => true), stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const foreign = new EventEmitter();
    startProcess.mockClear();
    const spy = startProcess.mockReturnValueOnce(original as ReturnType<typeof childProcesses.spawn>);
    try {
      const running = operation === 'prompt' ? handle.prompt('owned failing transport') : handle.compact!();
      const rejected = expect(running).rejects.toThrow(/process failed to spawn/);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(owned.live).toBe(original);
      original.emit('error', new Error('owned pre-disposal transport error'));
      await rejected;
      expect(owned.live).toBeNull();
      const file = owned.params.verificationSettingsFile;
      expect(existsSync(file)).toBe(true);
      await handle.dispose();
      expect(handle.cessationEvidence!()).toBe('unknown');
      expect(owned.cessationKind).toBe('live');
      expect(existsSync(file)).toBe(true);
      foreign.emit('close', 0, null);
      expect(handle.cessationEvidence!()).toBe('unknown');
      expect(existsSync(file)).toBe(true);
      original.emit('close', 0, null);
      expect(handle.cessationEvidence!()).toBe('ceased');
      expect(existsSync(file)).toBe(false);
      expect(existsSync(join(dirname(file), 'policy.json'))).toBe(false);
    } finally { original.emit('close', 0, null); await f.runtime.dispose(); }
  }
  it('review-2 actual prompt registration retains pre-disposal errored original until delayed close', async () => startedChildCustody('prompt'));
  it('review-2 actual compaction registration retains pre-disposal errored original until delayed close', async () => startedChildCustody('compact'));

  it('review-8 Claude host refuses option-terminator and heredoc-FD producers with hook unavailable', async () => {
    process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL'] = '1';
    try { for (const command of ['npm exec -- vitest run -- --help', 'npm 0<<EOF test\nEOF\n']) await refuses(command); }
    finally { delete process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL']; }
  });
  it('strict repair every retained producing raw case refuses ordinary Claude with hook unavailable', async () => {
    const { nativeCorpus } = await import('./helpers/verification-native-corpus.mjs');
    process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL'] = '1';
    try { for (const row of nativeCorpus.filter((row) => row.refused)) await refuses(row.raw, true); }
    finally { delete process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL']; }
  });
  it('strict repair policy-bearing compaction refuses native Bash with zero producer starts', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const f = fixture(); process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL'] = '1';
    try {
      const handle = await f.runtime.spawn('minion', lane.session); await handle.prompt('establish');
      for (const incident of [WEB_INCIDENT, FULL_INCIDENT, BUILD_INCIDENT]) {
        process.env['CLAUDE_DOUBLE_COMPACT_VERIFICATION'] = incident;
        await handle.compact!();
      }
      expect(existsSync(lane.starts)).toBe(false);
      for (const invocation of doubleInvocations(f).slice(1)) {
        expect(invocation.argv).toContain('--resume'); expect(invocation.argv).toContain('--permission-prompt-tool');
        expect(invocation.cwd).toBe(lane.lane.path);
      }
      await handle.dispose();
    } finally { delete process.env['CLAUDE_DOUBLE_COMPACT_VERIFICATION']; delete process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL']; await f.runtime.dispose(); }
  });
  it('strict repair disposal signals every unresolved original while a different policy child is live', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const controlled = () => Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, kill: vi.fn(() => true), stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const a = controlled(); const b = controlled();
    const start = vi.fn(spawn).mockReturnValueOnce(a as ReturnType<typeof spawn>).mockReturnValueOnce(b as ReturnType<typeof spawn>);
    const f = fixture({ killGraceMs: 5, spawnProcess: start as unknown as typeof spawn });
    const handle = await f.runtime.spawn('minion', lane.session);
    const turnA = handle.prompt('A'); const rejectedA = expect(turnA).rejects.toThrow(/process failed to spawn/);
    a.emit('error', new Error('owned error without close')); await rejectedA;
    const turnB = handle.prompt('B'); const rejectedB = expect(turnB).rejects.toThrow(/disposed/);
    vi.useFakeTimers();
    try {
      const disposal = handle.dispose(); await vi.advanceTimersByTimeAsync(30); await disposal; await rejectedB;
      for (const child of [a, b]) {
        expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      }
      const file = (handle as unknown as { params: { verificationSettingsFile: string } }).params.verificationSettingsFile;
      b.emit('close', null, 'SIGKILL'); expect(handle.cessationEvidence!()).toBe('unknown'); expect(existsSync(file)).toBe(true);
      a.emit('close', null, 'SIGKILL'); expect(handle.cessationEvidence!()).toBe('ceased'); expect(existsSync(file)).toBe(false);
    } finally { a.emit('close', 0, null); b.emit('close', 0, null); vi.useRealTimers(); await f.runtime.dispose(); }
  });
  it('strict repair a proven-closed original cannot be re-registered during asynchronous settlement', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => true), stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcess;
    const f = fixture({ killGraceMs: 5, spawnProcess: vi.fn(() => child) as unknown as typeof spawn });
    const handle = await f.runtime.spawn('minion', lane.session);
    const pending = handle.prompt('owned'); const rejection = expect(pending).rejects.toThrow(/disposed/);
    child.emit('close', 0, null);
    await handle.dispose(); await rejection;
    expect(handle.cessationEvidence!()).toBe('ceased');
    const file = (handle as unknown as { params: { verificationSettingsFile: string } }).params.verificationSettingsFile;
    expect(existsSync(file)).toBe(false); expect(child.kill).not.toHaveBeenCalled();
    await f.runtime.dispose();
  });
  it('strict repair SIGTERM-resistant post-error original actually dies on existing SIGKILL escalation', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const start = vi.fn(spawn); const f = fixture({ killGraceMs: 30, spawnProcess: start as unknown as typeof spawn });
    process.env['CLAUDE_DOUBLE_IGNORE_TERM'] = '1';
    const handle = await f.runtime.spawn('minion', lane.session);
    const pending = handle.prompt(`hold:${join(lane.root, 'never-created')}`);
    const rejection = expect(pending).rejects.toThrow(/process failed to spawn/);
    await vi.waitFor(() => expect(existsSync(f.doubleLog)).toBe(true));
    const child = start.mock.results[0]!.value as ChildProcess;
    const close = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal })));
    const signals = vi.spyOn(child, 'kill'); child.emit('error', new Error('owned pre-disposal transport error')); await rejection;
    await handle.dispose();
    expect(await close).toEqual({ code: null, signal: 'SIGKILL' });
    expect(signals).toHaveBeenCalledWith('SIGTERM'); expect(signals).toHaveBeenCalledWith('SIGKILL');
    expect(handle.cessationEvidence!()).toBe('ceased');
    expect(existsSync((handle as unknown as { params: { verificationSettingsFile: string } }).params.verificationSettingsFile)).toBe(false);
    delete process.env['CLAUDE_DOUBLE_IGNORE_TERM']; await f.runtime.dispose();
  });

  it('strict repair expanding escaped source plaintext and help diagnostics execute ordinary Claude', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const oldPath = process.env['PATH']; process.env['PATH'] = `${lane.bin}:${oldPath ?? ''}`;
    const f = fixture(); process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL'] = '1';
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      await handle.prompt("verification-bash:cat > escaped.txt <<EOF\n\\$(npm test)\n\\`npm test\\`\nEOF\ncat > empty.txt <<''\nnpm test\n\ncat escaped.txt empty.txt; tsc --pretty false --showConfig; npx vitest run --help");
      expect(readFileSync(join(lane.lane.path, 'escaped.txt'), 'utf8')).toBe('$(npm test)\n`npm test`\n');
      expect(readFileSync(join(lane.lane.path, 'empty.txt'), 'utf8')).toBe('npm test\n');
      expect(readFileSync(lane.starts, 'utf8').trim().split('\n')).toEqual(['tsc', 'npx']);
      expect(readFileSync(handle.sessionFile!, 'utf8')).not.toContain('Minion verification refused'); await handle.dispose();
    } finally { delete process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL']; process.env['PATH'] = oldPath; await f.runtime.dispose(); }
  });

  it('review-8 ordinary pre-ACK Bash is denied before prompt and compaction side effects', async () => {
    for (const operation of ['prompt', 'compact'] as const) {
      const lane = verificationLane(); cleanupDirs.push(lane.root);
      const marker = join(lane.lane.path, 'ordinary-pre-ack-side-effect');
      const start = vi.fn(spawn); const f = fixture({ spawnProcess: start as unknown as typeof spawn });
      const handle = await f.runtime.spawn('minion', lane.session);
      if (operation === 'compact') await handle.prompt('establish original conversation');
      const original = Object.assign(new EventEmitter(), {
        exitCode: null, signalCode: null, kill: vi.fn(() => true), stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      }) as unknown as ChildProcess;
      const wire: Record<string, unknown>[] = [];
      original.stdin!.on('data', (chunk: Buffer) => {
        const frame = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>; wire.push(frame);
        const response = frame['response'] as Record<string, unknown> | undefined;
        const decision = response?.['response'] as Record<string, unknown> | undefined;
        // The ordinary shell acts only on its original host's approval.
        if (decision?.['behavior'] === 'allow') {
          const input = decision['updatedInput'] as { readonly command: string };
          const execution = childProcesses.spawnSync('/bin/sh', ['-c', input.command], { cwd: lane.lane.path, encoding: 'utf8' });
          expect(execution.status, execution.stderr).toBe(0);
        }
      });
      start.mockReturnValueOnce(original as ReturnType<typeof spawn>);
      let running: Promise<void> | undefined;
      try {
        running = operation === 'compact' ? handle.compact!() : handle.prompt('ordinary Bash before initialization acknowledgement');
        const outcome = running.then(() => 'resolved', (error: unknown) => String(error));
        expect(wire.map((frame) => frame['type'])).toEqual(['control_request', 'user']);
        original.stdout!.emit('data', Buffer.from(JSON.stringify({
          type: 'control_request', request_id: 'ordinary-pre-ack-request',
          request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'ordinary-pre-ack-tool', input: { command: 'touch ordinary-pre-ack-side-effect' } },
        }) + '\n'));
        const responseFrame = wire.find((frame) => frame['type'] === 'control_response');
        const response = responseFrame?.['response'] as Record<string, unknown> | undefined;
        expect(response?.['request_id']).toBe('ordinary-pre-ack-request');
        expect(existsSync(marker)).toBe(false);
        expect(response?.['response']).toMatchObject({ behavior: 'deny' });
        original.emit('close', 0, null);
        expect(await outcome).toContain('malformed or foreign worker verification permission request');
      } finally {
        original.emit('close', 0, null); await running?.catch(() => undefined);
        await handle.dispose(); expect(handle.cessationEvidence!()).toBe('ceased');
        await f.runtime.dispose();
      }
    }
  });

  async function initializationOrdering(operation: 'prompt' | 'compact', inspectDelivery: boolean): Promise<void> {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const start = vi.fn(spawn); const f = fixture({ spawnProcess: start as unknown as typeof spawn });
    const handle = await f.runtime.spawn('minion', lane.session);
    if (operation === 'compact') await handle.prompt('establish original conversation');
    const original = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, kill: vi.fn(() => true), stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    const wire: Record<string, unknown>[] = [];
    original.stdin!.on('data', (chunk: Buffer) => wire.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>));
    start.mockReturnValueOnce(original as ReturnType<typeof spawn>);
    const owned = handle as unknown as { params: { sessionId: string; verificationSettingsFile: string } };
    let running: Promise<void> | undefined;
    try {
      running = operation === 'compact' ? handle.compact!() : handle.prompt('owned prompt before initialization reply');
      // Observe rejection immediately; do not create an unhandled promise if
      // a delivery assertion fails on the archived, pre-fix implementation.
      const outcome = running.then(() => 'resolved', (error: unknown) => String(error));
      expect(existsSync(owned.params.verificationSettingsFile)).toBe(true);
      expect(wire[0]?.['type']).toBe('control_request');
      if (inspectDelivery) {
        expect(wire.map((frame) => frame['type'])).toEqual(['control_request', 'user']);
        const message = wire[1]?.['message'] as { readonly content?: string };
        expect(message.content).toBe(operation === 'compact' ? '/compact' : 'owned prompt before initialization reply');
      }
      // A valid session/result is not initialization of the permission
      // transport. Missing reply must remain fail-loud even without Bash.
      original.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: owned.params.sessionId }) + '\n'));
      original.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ordinary text', session_id: owned.params.sessionId }) + '\n'));
      original.emit('close', 0, null);
      expect(await outcome).toContain('worker verification permission initialization did not complete before result');
      expect(existsSync(lane.starts)).toBe(false);
    } finally {
      original.emit('close', 0, null); await running?.catch(() => undefined);
      await handle.dispose(); expect(handle.cessationEvidence!()).toBe('ceased');
      await f.runtime.dispose();
    }
  }
  it('review-4 initialization prompt pipelines after original binding without waiting for a reply', async () => initializationOrdering('prompt', true));
  it('review-4 initialization compaction pipelines after original binding without waiting for a reply', async () => initializationOrdering('compact', true));
  it('review-4 initialization unanswered transport cannot accept a text-only terminal turn', async () => initializationOrdering('prompt', false));

  it('strict repair malformed native permission transport fails ordinary Claude closed with zero starts', async () => {
    const lane = verificationLane(); cleanupDirs.push(lane.root);
    const f = fixture(); process.env['CLAUDE_DOUBLE_PERMISSION_MALFORMED'] = '1'; process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL'] = '1';
    try {
      const handle = await f.runtime.spawn('minion', lane.session);
      await expect(handle.prompt('verification-bash:npm test')).rejects.toThrow(/malformed or foreign worker verification permission request/);
      expect(existsSync(lane.starts)).toBe(false); await handle.dispose();
      expect(handle.cessationEvidence!()).toBe('ceased');
    } finally { delete process.env['CLAUDE_DOUBLE_PERMISSION_MALFORMED']; delete process.env['CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL']; await f.runtime.dispose(); }
  });

});
