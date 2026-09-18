import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import {
  CLAUDE_CODE_CAPABILITIES,
  ClaudeCodeRuntime,
  mapRoleTools,
} from '../src/runtime/claude-adapter.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import {
  ClaudeTurnTranslator,
  extractSessionId,
  NdjsonParser,
  type StreamFrame,
} from '../src/runtime/stream-json.js';
import { LockBusyError, SessionStore } from '../src/sessions/store.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

/**
 * claude-code adapter tests (EPICS E3): a STUBBED CLI double (executable
 * node script) stands in for `claude` — real child processes, real stdio,
 * real NDJSON; never a real claude, never any network.
 */

const DOUBLE = join(import.meta.dirname, 'helpers', 'claude-double.mjs');
const DOUBLE_ENV_KEYS = [
  'CLAUDE_DOUBLE_LOG',
  'CLAUDE_DOUBLE_NO_PARTIALS',
  'CLAUDE_DOUBLE_MISMATCH',
  'CLAUDE_DOUBLE_IGNORE_TERM',
] as const;

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  // Double env knobs must never leak between tests.
  for (const key of DOUBLE_ENV_KEYS) delete process.env[key];
});

interface Fixture {
  home: string;
  workspace: string;
  store: SessionStore;
  logs: { level: string; msg: string; fields?: Record<string, unknown> }[];
  doubleLog: string;
  runtime: ClaudeCodeRuntime;
}

function fixture(knobs: { killGraceMs?: number } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'gru-command-claude-'));
  const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
  cleanupDirs.push(home, workspace);
  writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const store = new SessionStore(config.dataDir);
  const logs: Fixture['logs'] = [];
  const doubleLog = join(home, 'double-log.jsonl');
  process.env['CLAUDE_DOUBLE_LOG'] = doubleLog;
  const runtime = new ClaudeCodeRuntime({
    config,
    store,
    binary: DOUBLE,
    ...(knobs.killGraceMs !== undefined ? { killGraceMs: knobs.killGraceMs } : {}),
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
  return readFileSync(fx.doubleLog, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as never);
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
  it('spawns a session persisted under the store layout, named by the minted session uuid, lock held', async () => {
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

      // The transcript holds the RAW frames (init / assistant / result).
      const lines = readFileSync(handle.sessionFile!, 'utf-8').trim().split('\n');
      const frames = lines.map((l) => JSON.parse(l) as StreamFrame);
      expect(frames[0]!['type']).toBe('system');
      expect(frames[0]!['subtype']).toBe('init');
      expect(frames[0]!['session_id']).toBe(handle.id);
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

  it('emits thinking deltas before text when the model reasons', async () => {
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

  it('in-band error: result is_error resolves the prompt, sticky error state, next turn recovers', async () => {
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

  it('dispose mid-turn SIGTERMs the process: prompt rejects disposed, lock released', async () => {
    const fx = fixture();
    const releaseFile = join(fx.home, 'never-released');
    const handle = await fx.runtime.spawn('gru');
    const events = collect(handle);
    const turn = handle.prompt(`hold:${releaseFile}`, { owner: 'alice' });
    await waitFor(() => handle.health().state === 'streaming');
    await handle.dispose();
    await expect(turn).rejects.toThrow(/disposed/);
    expect(handle.health().state).toBe('disposed');
    expect(existsSync(`${handle.sessionFile}.lock`)).toBe(false);
    expect(states(events)[states(events).length - 1]).toBe('disposed');
  });

  it('a SIGTERM-immune process gets SIGKILL after the grace window', async () => {
    process.env['CLAUDE_DOUBLE_IGNORE_TERM'] = '1';
    const fx = fixture({ killGraceMs: 50 });
    const handle = await fx.runtime.spawn('gru');
    const turn = handle.prompt('hold:never', { owner: 'alice' });
    await waitFor(() => handle.health().state === 'streaming');
    await handle.dispose();
    // Settles only when the process actually dies — SIGKILL is the only
    // way out here, so this resolving at all proves the escalation fired.
    await expect(turn).rejects.toThrow(/disposed/);
    await fx.runtime.dispose();
  });

  it('a missing binary fails spawn naming it and latches the adapter down; a good binary recovers', async () => {
    const fx = fixture();
    const missing = new ClaudeCodeRuntime({
      config: (fx.runtime as never as { config: never }).config,
      store: fx.store,
      binary: join(fx.home, 'no-such-claude'),
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

  it('declares claude-code capabilities honestly (steer queued, no followUp)', () => {
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

  it('maps "default" to no flags and "provider/model" + level to --model/--effort', async () => {
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

  it('fails loud on malformed model references', async () => {
    const fx = fixture();
    await expect(fx.runtime.spawn('gru', { model: 'badshape' })).rejects.toThrow(
      /model reference must be "provider\/model" or "default", got: badshape/,
    );
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

  it('sends images as base64 content blocks in the stdin frame; plain text stays a string', async () => {
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
      expect(record.argv[record.argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
      const sysAt = record.argv.indexOf('--append-system-prompt');
      expect(record.argv[sysAt + 1]!.length).toBeGreaterThan(20);
      expect(record.argv[record.argv.indexOf('--session-id') + 1]).toBe(record.sessionId);
    }
    expect(review!.argv[review!.argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,LS');
    expect(build!.argv[build!.argv.indexOf('--tools') + 1]).toBe('Read,Bash,Edit,Write,Grep,Glob,LS');
    // The role prompt is the perkins/minion definition's own:
    expect(review!.argv[review!.argv.indexOf('--append-system-prompt') + 1]).toContain(
      'review agent',
    );
    expect(build!.argv[build!.argv.indexOf('--append-system-prompt') + 1]).toContain(
      'worker agent',
    );
  });

  it('mapRoleTools maps every known role tool and fails loud on an unknown id', () => {
    expect(mapRoleTools('perkins', ['read', 'grep', 'find', 'ls'])).toEqual([
      'Read',
      'Grep',
      'Glob',
      'LS',
    ]);
    expect(mapRoleTools('minion', ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])).toEqual([
      'Read',
      'Bash',
      'Edit',
      'Write',
      'Grep',
      'Glob',
      'LS',
    ]);
    expect(() => mapRoleTools('minion', ['nope'])).toThrow(
      /role "minion" tool "nope" has no claude-code tool mapping/,
    );
  });

  it('resumes a previous session file: --resume pinned, same file appended, history intact', async () => {
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

  it('refuses a resumeFile outside the session store', async () => {
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

  it('a spawned-but-never-prompted transcript resumes by adopting the filename uuid', async () => {
    const fx = fixture();
    const first = await fx.runtime.spawn('gru');
    const file = first.sessionFile!;
    const sessionId = first.id;
    await first.dispose(); // never prompted: empty transcript on disk
    expect(readFileSync(file, 'utf-8')).toBe('');

    const secondRuntime = new ClaudeCodeRuntime({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: new SessionStore(fx.store.dataDir),
      binary: DOUBLE,
    });
    const resumed = await secondRuntime.spawn('gru', { resumeFile: file });
    try {
      expect(resumed.id).toBe(sessionId); // adopted from the filename
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
      expect(frames[0]!['session_id']).toBe(sessionId);
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
      claude: { binary: DOUBLE },
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
      await handle.prompt('through the registry', { owner: 'alice' });
      expect(deltas(events, 'text_delta').join('')).toBe('echo: through the registry');
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

  it('steer mid-turn queues (steer-unable) and delivers as a SECOND process after idle', async () => {
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

  it('config-driven ruling-16 policy flows through the registry into argv', async () => {
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
      claude: { binary: DOUBLE },
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
    expect(t.result).toEqual({ subtype: 'success', isError: false, text: 'done' });
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

describe('spawn cwd (SPEC ruling 17 — dispatch roots in the project)', () => {
  it('runs the CLI with the explicit project cwd, not the workspace root', async () => {
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
