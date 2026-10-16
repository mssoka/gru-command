import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeDirectivePermissionChannel, privateClaudeDirectiveSettings, type ClaudeToolDecision, type ClaudeToolRequest } from '../src/runtime/claude-directive.js';
import { assertClaudeDirectiveToolIntent, inspectDirectiveCheckpoint, prepareClaudeDirectiveBinding, type DirectiveTurnIdentity } from '../src/runtime/directive-checkpoint.js';
import { workerVerificationRefusal, type WorkerVerificationPolicy } from '../src/runtime/worker-verification-policy.js';

/**
 * Claude Code directive turns (#424): the stdio permission channel fails
 * closed on anything but its own exchange, and the Claude checkpoint reads
 * only the exact admitted turn.
 */

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** A child whose stdin the test reads back, line by line. */
function fakeChild(): { readonly child: ChildProcess; readonly written: () => Record<string, unknown>[] } {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  let text = '';
  stdin.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
  Object.assign(child, { stdin });
  return { child, written: () => text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>) };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const request = (id: string, toolUseId: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Read', tool_use_id: toolUseId, input: { file_path: '/x' }, ...extra } });

function channel(decide: (request: ClaudeToolRequest) => ClaudeToolDecision = () => ({ allow: true }), verification?: WorkerVerificationPolicy) {
  const { child, written } = fakeChild();
  const failures: string[] = [];
  const decided: ClaudeToolRequest[] = [];
  const permissions = new ClaudeDirectivePermissionChannel(child, {
    fail: (message) => failures.push(message),
    decide: async (tool, durable) => { await durable; decided.push(tool); return decide(tool); },
    ...(verification === undefined ? {} : { verification }),
  });
  permissions.start();
  const init = written()[0]!;
  const initialize = (): void => permissions.ingest({ type: 'control_response', response: { subtype: 'success', request_id: init['request_id'], response: {} } }, Promise.resolve());
  return { permissions, written, failures, decided, initialize };
}

describe('the Claude directive permission channel (#424)', () => {
  it('initializes, decides a tool only once its request is durable, returns the input unchanged, and takes back its own echo once', async () => {
    const c = channel();
    expect(c.written()[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
    c.initialize();
    let durable!: () => void;
    c.permissions.ingest(request('r1', 'toolu_1'), new Promise<void>((resolve) => { durable = resolve; }));
    await tick();
    expect(c.decided).toEqual([]); // not before the request frame is durable
    durable();
    await tick(); await tick();
    const response = c.written().at(-1)!;
    expect(response).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { file_path: '/x' } } } });
    // The CLI echoes it once (--replay-user-messages): taken back silently.
    c.permissions.ingest(response, Promise.resolve());
    expect(c.failures).toEqual([]);
    // The same echo again is foreign.
    c.permissions.ingest(response, Promise.resolve());
    expect(c.failures).toEqual(['foreign or repeated directive permission response']);
  });

  it('fails closed on a foreign response, a repeated request or tool, an unknown subtype, malformed input, or a result before initialization', async () => {
    const early = channel();
    early.permissions.ingest({ type: 'result', subtype: 'success' }, Promise.resolve());
    expect(early.failures).toEqual(['directive permission initialization did not complete before result']);
    const cases: [string, (c: ReturnType<typeof channel>) => void][] = [
      ['foreign response', (c) => c.permissions.ingest({ type: 'control_response', response: { subtype: 'success', request_id: 'never-written', response: {} } }, Promise.resolve())],
      ['repeated request id', (c) => { c.permissions.ingest(request('r1', 'toolu_1'), Promise.resolve()); c.permissions.ingest(request('r1', 'toolu_2'), Promise.resolve()); }],
      ['repeated tool use', (c) => { c.permissions.ingest(request('r1', 'toolu_1'), Promise.resolve()); c.permissions.ingest(request('r2', 'toolu_1'), Promise.resolve()); }],
      ['unknown subtype', (c) => c.permissions.ingest({ type: 'control_request', request_id: 'r1', request: { subtype: 'mcp_message' } }, Promise.resolve())],
      ['malformed input', (c) => c.permissions.ingest(request('r1', 'toolu_1', { input: ['not', 'an', 'object'] }), Promise.resolve())],
      ['before initialization', (c) => c.permissions.ingest(request('r1', 'toolu_1'), Promise.resolve())],
    ];
    for (const [label, drive] of cases) {
      const c = channel();
      if (label !== 'before initialization') c.initialize();
      drive(c);
      await tick();
      expect(c.failures.length, label).toBeGreaterThan(0);
    }
  });

  it('denies a lane\'s verification producer before any fence, with the verification refusal', async () => {
    const policy: WorkerVerificationPolicy = { jobId: 'job', laneId: 'lane', cwd: '/lane', scopes: ['full'], producerPrefixes: [['npm', 'test']], helper: 'gc-verify', configFile: '/config.toml' };
    const c = channel(() => ({ allow: true }), policy);
    c.initialize();
    c.permissions.ingest({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu_1', input: { command: 'npm test' } } }, Promise.resolve());
    await tick();
    expect(c.decided).toEqual([]);
    expect(c.written().at(-1)).toMatchObject({ response: { request_id: 'r1', response: { behavior: 'deny', message: workerVerificationRefusal(policy) } } });
  });

  it('a fence that throws denies the tool and fails the turn', async () => {
    const c = channel(() => { throw new Error('fence broke'); });
    c.initialize();
    c.permissions.ingest(request('r1', 'toolu_1'), Promise.resolve());
    await tick(); await tick();
    expect(c.written().at(-1)).toMatchObject({ response: { request_id: 'r1', response: { behavior: 'deny' } } });
    expect(c.failures).toEqual(['directive tool fence failed: fence broke']);
  });
});

describe('the Claude directive checkpoint (#424)', () => {
  const identity: DirectiveTurnIdentity = { requestId: 'claude-unit', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64), jobId: 'job-unit', workRevision: 0, authorityEpoch: 0 };
  const content = [{ type: 'text', text: 'follow the approved correction' }];
  /** A transcript with GC's header, a bound directive, and then `frames`. */
  function turn(frames: readonly Record<string, unknown>[], header = true): string {
    const dir = mkdtempSync(join(tmpdir(), 'gru-claude-checkpoint-'));
    dirs.push(dir);
    const file = join(dir, 'session.jsonl');
    // A legacy transcript starts with the CLI's own frames, not GC's header.
    writeFileSync(file, `${JSON.stringify(header ? { type: 'session', version: 1, id: 'cli-session', cwd: dir, runtime: 'claude-code' } : { type: 'system', subtype: 'init', session_id: 'cli-session' })}\n`);
    if (header) prepareClaudeDirectiveBinding({ identity, agentId: 'minion', sessionId: 'cli-session', sessionFile: file, content, authorityManifest: 'manifest' });
    for (const frame of frames) appendFileSync(file, `${JSON.stringify(frame)}\n`);
    return file;
  }
  const init = { type: 'system', subtype: 'init', session_id: 'cli-session' };
  const echo = { type: 'user', isReplay: true, uuid: 'echo-1', session_id: 'cli-session', parent_tool_use_id: null, message: { role: 'user', content } };
  const use = (id: string) => ({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] } });
  const result = (id: string) => ({ type: 'user', uuid: `r-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] } });
  const done = { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1', session_id: 'cli-session' };

  it('is terminal at the turn\'s own result, after every tool settled', () => {
    expect(inspectDirectiveCheckpoint(turn([init, echo, use('t1'), result('t1'), done]), identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'result-1' });
  });

  it('is unknown, never resumable, for a turn without a result, a second prompt, a repeated tool id, or a tool error', () => {
    const reasons = [
      [init, echo, use('t1')],
      [init, echo, { ...echo, uuid: 'echo-2' }, done],
      [init, echo, use('t1'), use('t1'), done],
      [init, echo, use('t1'), { ...result('t1'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'no', is_error: true }] } }, done],
      [init, { ...echo, message: { role: 'user', content: [{ type: 'text', text: 'something else' }] } }, done],
    ].map((frames) => inspectDirectiveCheckpoint(turn(frames), identity));
    for (const proof of reasons) expect(proof.state).toBe('unknown');
    expect(reasons.map((proof) => (proof as { reason: string }).reason)).toEqual([
      'native directive turn has no result yet',
      'another prompt entered the directive turn',
      'malformed native tool identity',
      'native tool error requires a recovery judgment',
      'actual native admission user receipt unavailable/changed',
    ]);
  });

  it('refuses a tool whose intent is not recorded, changed, already settled, or ambiguous', () => {
    const file = turn([init, echo, use('t1')]);
    expect(() => assertClaudeDirectiveToolIntent(file, identity, 't1', 'Read', { file_path: '/x' })).not.toThrow();
    expect(() => assertClaudeDirectiveToolIntent(file, identity, 't1', 'Read', { file_path: '/y' })).toThrow(/not persisted before execution or its invocation\/results changed/u);
    expect(() => assertClaudeDirectiveToolIntent(file, identity, 't2', 'Read', { file_path: '/x' })).toThrow(/not persisted before execution/u);
    expect(() => assertClaudeDirectiveToolIntent(turn([init, echo, use('t1'), result('t1')]), identity, 't1', 'Read', { file_path: '/x' })).toThrow(/not persisted before execution/u);
    expect(() => assertClaudeDirectiveToolIntent(turn([init, echo, use('t1'), use('t1')]), identity, 't1', 'Read', { file_path: '/x' })).toThrow(/ambiguous/u);
  });

  it('a header that no longer names the session makes the checkpoint unknown, never a throw', () => {
    const file = turn([init, echo, done]);
    const [, ...rest] = readFileSync(file, 'utf8').split('\n');
    writeFileSync(file, [JSON.stringify({ type: 'session', version: 1, id: 'another-session', cwd: '/elsewhere', runtime: 'claude-code' }), ...rest].join('\n'));
    // The prefix it was bound to changed too; either way: unknown, by name.
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
  });

  it('a transcript with no GC session header binds nothing', () => {
    const legacy = turn([], false);
    expect(() => prepareClaudeDirectiveBinding({ identity, agentId: 'minion', sessionId: 'cli-session', sessionFile: legacy, content, authorityManifest: 'manifest' }))
      .toThrow(/no exact GC session header/u);
  });
});

describe('directive turn settings (#424)', () => {
  it('ask the host for every listed tool; a verification lane adds its Bash hook; the file is private', () => {
    const plain = privateClaudeDirectiveSettings(['Read', 'Bash', 'Edit']);
    try {
      expect(JSON.parse(readFileSync(plain.file, 'utf8'))).toEqual({ permissions: { ask: ['Read', 'Bash', 'Edit'] } });
      expect(statSync(plain.file).mode & 0o077).toBe(0);
    } finally { plain.dispose(); }
    const policy: WorkerVerificationPolicy = { jobId: 'job', laneId: 'lane', cwd: '/lane', scopes: ['full'], producerPrefixes: [['npm', 'test']], helper: 'gc-verify', configFile: '/config.toml' };
    const lane = privateClaudeDirectiveSettings(['Read', 'Bash'], policy);
    try {
      const settings = JSON.parse(readFileSync(lane.file, 'utf8')) as { permissions: { ask: string[] }; hooks: { PreToolUse: { matcher: string }[] } };
      expect(settings.permissions.ask).toEqual(['Read', 'Bash']);
      expect(settings.hooks.PreToolUse.map((hook) => hook.matcher)).toEqual(['Bash']);
    } finally { lane.dispose(); }
  });
});
