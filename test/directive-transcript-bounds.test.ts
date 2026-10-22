import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertClaudeDirectiveToolIntent, flushDirectiveToolIntent, inspectDirectiveAdmission, inspectDirectiveCheckpoint,
  prepareClaudeDirectiveBinding, prepareDirectiveBinding, readDirectiveBinding, readDirectiveSessionHeader, type DirectiveTurnIdentity,
} from '../src/runtime/directive-checkpoint.js';

/**
 * Bounded native inspection (#469). Inspecting a directive is bounded by the
 * directive's own turn, never by the session's lifetime: a session whose
 * transcript is past the 32 MiB limit still takes directives on both
 * runtimes, and later work never refuses an earlier directive. A changed
 * prefix, a torn or corrupted entry and a directive turn that is itself too
 * large are still refused by name.
 */

/** Every read the module makes goes through here, so a test can see how much
 * of a transcript an inspection read, and change a transcript mid-read. */
const reads = vi.hoisted(() => ({
  calls: [] as { readonly length: number; readonly bytes: number }[],
  whole: 0,
  onEof: null as { readonly ino: number; readonly append: () => void } | null,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readSync = actual.readSync as (...args: unknown[]) => number;
  const readFile = actual.readFileSync as (...args: unknown[]) => unknown;
  return {
    ...actual,
    readSync: (...args: unknown[]) => {
      const bytes = readSync(...args);
      reads.calls.push({ length: typeof args[3] === 'number' ? args[3] : Number.POSITIVE_INFINITY, bytes });
      const hook = reads.onEof;
      if (bytes === 0 && hook !== null && actual.fstatSync(args[0] as number).ino === hook.ino) { reads.onEof = null; hook.append(); }
      return bytes;
    },
    readFileSync: (...args: unknown[]) => { reads.whole += 1; return readFile(...args); },
  };
});
/** What `inspect` read: total bytes, its largest single request, whole-file reads. */
function observe<T>(inspect: () => T): { readonly result: T; readonly bytes: number; readonly largest: number; readonly whole: number } {
  reads.calls = [];
  reads.whole = 0;
  const result = inspect();
  return { result, bytes: reads.calls.reduce((sum, call) => sum + call.bytes, 0), largest: Math.max(0, ...reads.calls.map((call) => call.length)), whole: reads.whole };
}

const LIMIT = 32 * 1024 * 1024;
const PAST_LIMIT = LIMIT + 4 * 1024 * 1024;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); reads.onEof = null; });

const identity: DirectiveTurnIdentity = { requestId: 'bounded-request', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64),
  jobId: 'bounded-job', workRevision: 0, authorityEpoch: 0 };
const laterIdentity: DirectiveTurnIdentity = { ...identity, requestId: 'later-request', payloadHash: 'b'.repeat(64) };
const latestIdentity: DirectiveTurnIdentity = { ...identity, requestId: 'latest-request', payloadHash: 'd'.repeat(64) };
const text = 'follow the approved correction';
// Multi-byte text, so 64 KiB reads split characters across chunk boundaries.
const filler = 'x—é'.repeat(64 * 1024);

function sessionFile(header: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-bounded-transcript-'));
  dirs.push(dir);
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, `${JSON.stringify(header)}\n`);
  return file;
}

/** Appends `line(index)` rows until the file holds at least `bytes`; returns how many. */
function appendUntil(file: string, bytes: number, line: (index: number) => string): number {
  const fd = openSync(file, 'a');
  try {
    let count = 0;
    for (let size = statSync(file).size; size < bytes; count += 1) size += writeSync(fd, `${line(count)}\n`);
    return count;
  } finally { closeSync(fd); }
}
function appendRows(file: string, count: number, row: (index: number) => Record<string, unknown>): void {
  appendFileSync(file, `${Array.from({ length: count }, (_, index) => JSON.stringify(row(index))).join('\n')}\n`);
}

/** Rewrites `from` (found exactly once) with `to` of the same length, in place. */
function patch(file: string, from: string, to: string): void {
  const bytes = readFileSync(file);
  const at = bytes.indexOf(from);
  if (at < 0 || bytes.indexOf(from, at + 1) >= 0 || Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error(`patch target ${from} is not unique or changes length`);
  const fd = openSync(file, 'r+');
  try { writeSync(fd, to, at); } finally { closeSync(fd); }
}
function writeAt(file: string, offset: number, bytes: Buffer): void {
  const fd = openSync(file, 'r+');
  try { writeSync(fd, bytes, 0, bytes.length, offset); } finally { closeSync(fd); }
}

/** Appends `row(text)` with an em dash straddling the 64 KiB read boundary. */
function straddleChunkBoundary(file: string, row: (text: string) => Record<string, unknown>): void {
  const before = Buffer.from(JSON.stringify(row('@@'))).indexOf('@@');
  const pad = 64 * 1024 - 1 - statSync(file).size - before;
  appendFileSync(file, `${JSON.stringify(row(`${'x'.repeat(pad)}—tail`))}\n`);
  expect(readFileSync(file).subarray(64 * 1024 - 1, 64 * 1024 + 2)).toEqual(Buffer.from('—'));
}

const piHeader = { type: 'session', id: 'pi-session', version: 3, cwd: '/lane' };
/** A pi session with `bytes` of earlier, tree-linked history; returns its last entry id. */
function piSession(bytes: number): { readonly file: string; readonly last: string } {
  const file = sessionFile(piHeader);
  const count = appendUntil(file, bytes, (index) => JSON.stringify({ type: 'message', id: `history-${index}`, parentId: index === 0 ? null : `history-${index - 1}`,
    message: index % 2 === 0 ? { role: 'user', content: [{ type: 'text', text: filler }] } : { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: filler }] } }));
  return { file, last: `history-${count - 1}` };
}
function piEntry(file: string, id: string, parentId: string | null, message: Record<string, unknown>): string {
  appendFileSync(file, `${JSON.stringify({ type: 'message', id, parentId, message })}\n`);
  return id;
}
const prompt = (body: string) => ({ role: 'user', content: [{ type: 'text', text: body }] });
const answer = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] };
function preparePi(file: string, who = identity, body = text) {
  return prepareDirectiveBinding({ identity: who, runtime: 'pi', agentId: 'minion', sessionId: 'pi-session', sessionFile: file, text: body, authorityManifest: 'manifest' });
}
const toolCall = { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'true' } };
const invocation = { role: 'assistant', stopReason: 'toolUse', content: [toolCall] };
const toolResult = (id: string, body = 'ok') => ({ role: 'toolResult', toolCallId: id, toolName: 'bash', isError: false, content: [{ type: 'text', text: body }] });

const claudeHeader = { type: 'session', version: 1, id: 'cli-session', cwd: '/lane', runtime: 'claude-code' };
/** A Claude session with `bytes` of earlier CLI frames after GC's header. */
function claudeSession(bytes: number): string {
  const file = sessionFile(claudeHeader);
  appendUntil(file, bytes, (index) => JSON.stringify({ type: 'assistant', uuid: `history-${index}`, session_id: 'cli-session', message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }));
  return file;
}
function frames(file: string, ...rows: readonly Record<string, unknown>[]): void {
  for (const row of rows) appendFileSync(file, `${JSON.stringify(row)}\n`);
}
const content = (body = text) => [{ type: 'text', text: body }];
function prepareClaude(file: string, who = identity, body = text) {
  return prepareClaudeDirectiveBinding({ identity: who, agentId: 'minion', sessionId: 'cli-session', sessionFile: file, content: content(body), authorityManifest: 'manifest' });
}
const init = { type: 'system', subtype: 'init', session_id: 'cli-session' };
const echo = (uuid = 'echo-1', body = text) => ({ type: 'user', isReplay: true, uuid, session_id: 'cli-session', parent_tool_use_id: null, message: { role: 'user', content: content(body) } });
const use = { type: 'assistant', uuid: 'a-t1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } };
const result = { type: 'user', uuid: 'r-t1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } };
const done = (uuid = 'result-1') => ({ type: 'result', subtype: 'success', is_error: false, uuid, session_id: 'cli-session' });

const MALFORMED = 'native checkpoint has a malformed or duplicate entry identity';

describe('a pi session past the transcript limit (#469)', () => {
  it('reads its header, admits, fences a tool and checkpoints a small directive turn', () => {
    const { file, last } = piSession(PAST_LIMIT);
    expect(statSync(file).size).toBeGreaterThan(LIMIT);
    expect(readDirectiveSessionHeader(file)).toEqual(piHeader);
    expect(preparePi(file).baseline).toBe(last);
    const receipt = piEntry(file, 'receipt', last, prompt(text));
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ baseline: last, userEntryId: receipt });
    const asked = piEntry(file, 'invocation', receipt, invocation);
    expect(() => flushDirectiveToolIntent(file, invocation, toolCall, identity)).not.toThrow();
    const settled = piEntry(file, 'result', asked, toolResult('call-1'));
    const final = piEntry(file, 'answer', settled, answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: final });
  });

  it('takes a directive after more history entries than the turn entry limit, and across a character split by a read', () => {
    const file = sessionFile(piHeader);
    straddleChunkBoundary(file, (body) => ({ type: 'message', id: 'straddle', parentId: null, message: prompt(body) }));
    appendRows(file, 250_001, (index) => ({ type: 'message', id: `h${index}`, parentId: index === 0 ? 'straddle' : `h${index - 1}`, message: { role: 'user', content: [] } }));
    expect(readDirectiveSessionHeader(file)).toEqual(piHeader);
    expect(preparePi(file).baseline).toBe('h250000');
    const receipt = piEntry(file, 'receipt', 'h250000', prompt(text));
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ userEntryId: receipt });
    piEntry(file, 'answer', receipt, answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('still refuses a rewritten history: a repeated entry id, a lost baseline, corrupted bytes', () => {
    const { file, last } = piSession(PAST_LIMIT);
    preparePi(file);
    const receipt = piEntry(file, 'receipt', last, prompt(text));
    piEntry(file, 'answer', receipt, answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true });
    // An id deep in the history repeats an earlier one.
    patch(file, '"id":"history-10"', '"id":"history-11"');
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: MALFORMED });
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(/^malformed\/rebound native admission prefix$/u);
    patch(file, '"id":"history-11","parentId":"history-9"', '"id":"history-10","parentId":"history-9"');
    // A byte deep in the history is no UTF-8.
    const bytes = readFileSync(file);
    const at = bytes.indexOf('"text":"x', bytes.indexOf('"id":"history-20"')) + '"text":"'.length;
    writeAt(file, at, Buffer.from([0xff]));
    expect(() => inspectDirectiveCheckpoint(file, identity)).toThrow(/^native transcript is not valid UTF-8; corrupted bytes are never evidence$/u);
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(/^native transcript is not valid UTF-8; corrupted bytes are never evidence$/u);
    writeAt(file, at, Buffer.from('x'));
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true });
    // The baseline entry itself is gone, and the session ends on a torn line.
    patch(file, `"id":"${last}"`, `"id":"${last.replace('history', 'rewrite')}"`);
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'native baseline unavailable' });
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(/^actual native admission user receipt unavailable$/u);
    appendFileSync(file, '{"type":"message","id":"torn"');
    expect(() => inspectDirectiveCheckpoint(file, identity)).toThrow(/^native transcript has a partial entry$/u);
    expect(() => preparePi(file, laterIdentity)).toThrow(/^native transcript has a partial entry$/u);
  });

  it('refuses a turn entry that reuses a history id: as the receipt, inside the turn and in a tool chain', () => {
    const reused = piSession(PAST_LIMIT);
    preparePi(reused.file);
    piEntry(reused.file, 'history-5', reused.last, prompt(text));
    expect(() => inspectDirectiveAdmission(reused.file, identity)).toThrow(/^malformed\/rebound native admission prefix$/u);
    expect(inspectDirectiveCheckpoint(reused.file, identity)).toEqual({ state: 'unknown', reason: MALFORMED });

    const turn = piSession(PAST_LIMIT);
    preparePi(turn.file);
    const receipt = piEntry(turn.file, 'receipt', turn.last, prompt(text));
    expect(inspectDirectiveAdmission(turn.file, identity)).toMatchObject({ userEntryId: receipt });
    piEntry(turn.file, 'history-5', receipt, invocation);
    expect(inspectDirectiveCheckpoint(turn.file, identity)).toEqual({ state: 'unknown', reason: MALFORMED });
    expect(() => flushDirectiveToolIntent(turn.file, invocation, toolCall, identity))
      .toThrow(/^native tool intent is not persisted before execution or its invocation\/results changed$/u);
  });

  it('reads only what it walks: a torn tail never undoes admission, but a checkpoint walking into it refuses', () => {
    const { file, last } = piSession(PAST_LIMIT);
    preparePi(file);
    const receipt = piEntry(file, 'receipt', last, prompt(text));
    appendFileSync(file, '{"type":"message","id":"torn"');
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ userEntryId: receipt });
    expect(() => inspectDirectiveCheckpoint(file, identity)).toThrow(/^native transcript has a partial entry$/u);
  });

  it('refuses by name a directive turn past the byte limit, an oversized history entry and an oversized header on every path', () => {
    const turn = sessionFile(piHeader);
    preparePi(turn);
    const receipt = piEntry(turn, 'receipt', null, prompt(text));
    appendUntil(turn, PAST_LIMIT, (index) => index % 2 === 0
      ? JSON.stringify({ type: 'message', id: `use-${index}`, parentId: index === 0 ? receipt : `result-${index - 1}`, message: { ...invocation, content: [{ ...toolCall, id: `call-${index}` }] } })
      : JSON.stringify({ type: 'message', id: `result-${index}`, parentId: `use-${index - 1}`, message: toolResult(`call-${index - 1}`, filler) }));
    expect(() => inspectDirectiveCheckpoint(turn, identity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);
    // Admission reads only the receipt: the oversized rest is not its evidence.
    expect(inspectDirectiveAdmission(turn, identity)).toMatchObject({ userEntryId: receipt });

    const entry = sessionFile(piHeader);
    appendFileSync(entry, `${JSON.stringify({ type: 'message', id: 'huge', parentId: null, message: prompt('x'.repeat(LIMIT)) })}\n`);
    expect(() => preparePi(entry)).toThrow(/^native transcript entry exceeds the 33554432-byte inspection limit$/u);

    const header = sessionFile(piHeader);
    preparePi(header);
    piEntry(header, 'receipt', null, prompt(text));
    const [, ...rest] = readFileSync(header, 'utf8').split('\n');
    writeFileSync(header, [JSON.stringify({ ...piHeader, cwd: `/${'x'.repeat(64 * 1024)}` }), ...rest].join('\n'));
    for (const read of [() => readDirectiveSessionHeader(header), () => inspectDirectiveAdmission(header, identity), () => inspectDirectiveCheckpoint(header, identity), () => preparePi(header, laterIdentity)]) {
      expect(read).toThrow(/^native session header exceeds the 65536-byte inspection limit$/u);
    }
  });
});

describe('a Claude Code session past the transcript limit (#469)', () => {
  it('reads its header, binds its exact prefix, admits, fences a tool and checkpoints a small directive turn', () => {
    const file = claudeSession(PAST_LIMIT);
    expect(statSync(file).size).toBeGreaterThan(LIMIT);
    expect(readDirectiveSessionHeader(file)).toEqual(claudeHeader);
    // The same prefix shape a whole-file read produced: earlier bindings still verify.
    const whole = readFileSync(file);
    expect(prepareClaude(file).baseline).toBe(`prefix:${String(whole.length)}:${createHash('sha256').update(whole).digest('hex')}`);
    frames(file, init, echo());
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ userEntryId: 'echo-1' });
    frames(file, use);
    expect(() => assertClaudeDirectiveToolIntent(file, identity, 't1', 'Read', { file_path: '/x' })).not.toThrow();
    frames(file, result, done());
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'result-1' });
  });

  it('binds after more history frames than the turn entry limit, and across a character split by a read', () => {
    const file = sessionFile(claudeHeader);
    straddleChunkBoundary(file, (body) => ({ type: 'assistant', uuid: 'straddle', session_id: 'cli-session', message: { role: 'assistant', content: [{ type: 'text', text: body }] } }));
    appendRows(file, 250_001, () => ({ type: 'stream_event', session_id: 'cli-session' }));
    const whole = readFileSync(file);
    expect(prepareClaude(file).baseline).toBe(`prefix:${String(whole.length)}:${createHash('sha256').update(whole).digest('hex')}`);
    frames(file, init, echo(), done());
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ userEntryId: 'echo-1' });
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'result-1' });
  });

  it('still refuses a changed prefix deep in the session, and corrupted or torn bytes at binding', () => {
    const file = claudeSession(PAST_LIMIT);
    prepareClaude(file);
    frames(file, init, echo(), use);
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ userEntryId: 'echo-1' });
    patch(file, '"uuid":"history-50"', '"uuid":"history-99"');
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'the native transcript before the directive changed' });
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(/^the native transcript before the directive changed$/u);
    expect(() => assertClaudeDirectiveToolIntent(file, identity, 't1', 'Read', { file_path: '/x' })).toThrow(/^the native transcript before the directive changed$/u);

    const corrupted = claudeSession(PAST_LIMIT);
    writeAt(corrupted, LIMIT, Buffer.from([0xff]));
    expect(() => prepareClaude(corrupted)).toThrow(/^native transcript is not valid UTF-8; corrupted bytes are never evidence$/u);

    const torn = claudeSession(PAST_LIMIT);
    appendFileSync(torn, '{"type":"assistant","uuid":"torn"');
    expect(() => prepareClaude(torn)).toThrow(/^native transcript has a partial entry$/u);
  });

  it('refuses by name a directive turn past the byte or the entry limit; its admission still reads', () => {
    const bytes = sessionFile(claudeHeader);
    prepareClaude(bytes);
    frames(bytes, init, echo());
    appendUntil(bytes, PAST_LIMIT, (index) => JSON.stringify({ type: 'assistant', uuid: `turn-${index}`, message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }));
    expect(() => inspectDirectiveCheckpoint(bytes, identity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);
    expect(inspectDirectiveAdmission(bytes, identity)).toMatchObject({ userEntryId: 'echo-1' });

    const entries = sessionFile(claudeHeader);
    prepareClaude(entries);
    frames(entries, init, echo());
    appendRows(entries, 250_001, () => ({ type: 'stream_event', session_id: 'cli-session' }));
    expect(() => inspectDirectiveCheckpoint(entries, identity)).toThrow(/^native directive turn exceeds the entry inspection limit$/u);
    expect(inspectDirectiveAdmission(entries, identity)).toMatchObject({ userEntryId: 'echo-1' });
  });
});

describe('an earlier directive on a session that kept working (#469)', () => {
  it('pi: stays inspectable after a later directive turn past the limit, reading only through its own turn', () => {
    const file = sessionFile(piHeader);
    preparePi(file);
    const first = piEntry(file, 'answer-a', piEntry(file, 'receipt-a', null, prompt(text)), answer);
    preparePi(file, laterIdentity, 'the next approved step');
    const second = piEntry(file, 'answer-b', piEntry(file, 'receipt-b', first, prompt('the next approved step')), answer);
    expect(inspectDirectiveAdmission(file, laterIdentity)).toMatchObject({ userEntryId: 'receipt-b' });
    preparePi(file, latestIdentity, 'the last approved step');
    const receipt = piEntry(file, 'receipt-c', second, prompt('the last approved step'));
    expect(inspectDirectiveAdmission(file, latestIdentity)).toMatchObject({ userEntryId: receipt });
    appendUntil(file, PAST_LIMIT, (index) => index % 2 === 0
      ? JSON.stringify({ type: 'message', id: `use-${index}`, parentId: index === 0 ? receipt : `result-${index - 1}`, message: { ...invocation, content: [{ ...toolCall, id: `call-${index}` }] } })
      : JSON.stringify({ type: 'message', id: `result-${index}`, parentId: `use-${index - 1}`, message: toolResult(`call-${index - 1}`, filler) }));
    const earliest = observe(() => inspectDirectiveCheckpoint(file, identity));
    expect(earliest.result).toMatchObject({ state: 'terminal', ok: true, checkpointId: first });
    expect(earliest.bytes).toBeLessThan(1024 * 1024);
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ userEntryId: 'receipt-a' });
    expect(inspectDirectiveCheckpoint(file, laterIdentity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: second });
    // The latest directive's own turn is past the limit: that one refuses.
    expect(() => inspectDirectiveCheckpoint(file, latestIdentity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);
  });

  it('pi: a turn just under the limit stays inspectable once a later request follows it; that lookahead is not charged to it', () => {
    const file = sessionFile(piHeader);
    preparePi(file);
    const receipt = `${JSON.stringify({ type: 'message', id: 'receipt-a', parentId: null, message: prompt(text) })}\n`;
    const terminal = (body: string) => `${JSON.stringify({ type: 'message', id: 'answer-a', parentId: 'receipt-a', message: { ...answer, content: [{ type: 'text', text: body }] } })}\n`;
    // The whole turn, receipt and terminal, is 10 bytes under the limit.
    appendFileSync(file, receipt + terminal('x'.repeat(LIMIT - 10 - Buffer.byteLength(receipt) - Buffer.byteLength(terminal('')))));
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer-a' });
    preparePi(file, laterIdentity, 'the next approved step');
    piEntry(file, 'receipt-b', 'answer-a', prompt('the next approved step'));
    expect(inspectDirectiveAdmission(file, laterIdentity)).toMatchObject({ userEntryId: 'receipt-b' });
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer-a' });
  });

  it('Claude Code: stays inspectable after a later directive turn past the limit, reading only through its own turn', () => {
    const file = sessionFile(claudeHeader);
    prepareClaude(file);
    frames(file, init, echo('echo-a'), done('result-a'));
    prepareClaude(file, laterIdentity, 'the next approved step');
    frames(file, init, echo('echo-b', 'the next approved step'), done('result-b'));
    prepareClaude(file, latestIdentity, 'the last approved step');
    frames(file, init, echo('echo-c', 'the last approved step'));
    appendUntil(file, PAST_LIMIT, (index) => JSON.stringify({ type: 'assistant', uuid: `turn-${index}`, message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }));
    const earliest = observe(() => inspectDirectiveCheckpoint(file, identity));
    expect(earliest.result).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'result-a' });
    expect(earliest.bytes).toBeLessThan(1024 * 1024);
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ userEntryId: 'echo-a' });
    expect(inspectDirectiveCheckpoint(file, laterIdentity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'result-b' });
    expect(() => inspectDirectiveCheckpoint(file, latestIdentity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);
  });
});

describe('bounded reads (#469)', () => {
  it('never holds a session whole: no whole-file read, no read request or assembled buffer near the session size', () => {
    const pi = piSession(PAST_LIMIT);
    const claude = claudeSession(PAST_LIMIT);
    const header = observe(() => readDirectiveSessionHeader(pi.file));
    expect(header.bytes).toBeLessThanOrEqual(64 * 1024);
    const concat = vi.spyOn(Buffer, 'concat');
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    const inspected = observe(() => {
      preparePi(pi.file);
      const receipt = piEntry(pi.file, 'receipt', pi.last, prompt(text));
      inspectDirectiveAdmission(pi.file, identity);
      const asked = piEntry(pi.file, 'invocation', receipt, invocation);
      flushDirectiveToolIntent(pi.file, invocation, toolCall, identity);
      piEntry(pi.file, 'result', asked, toolResult('call-1'));
      expect(inspectDirectiveCheckpoint(pi.file, identity)).toMatchObject({ state: 'resumable', checkpointId: 'result' });
      readDirectiveSessionHeader(claude);
      prepareClaude(claude);
      frames(claude, init, echo(), use);
      inspectDirectiveAdmission(claude, identity);
      assertClaudeDirectiveToolIntent(claude, identity, 't1', 'Read', { file_path: '/x' });
      expect(inspectDirectiveCheckpoint(claude, identity)).toMatchObject({ state: 'unknown', reason: 'native directive turn has no result yet' });
    });
    expect(inspected.whole).toBe(0);
    expect(inspected.largest).toBeLessThanOrEqual(64 * 1024);
    const assembled = concat.mock.results.map((call) => (call.value as Buffer).length);
    const decoded = decode.mock.calls.map(([input]) => (input as Uint8Array | undefined)?.byteLength ?? 0);
    expect(assembled.length).toBeGreaterThan(0);
    expect(decoded.length).toBeGreaterThan(0);
    // The largest is one ~384 KiB history entry, never the 36 MiB session.
    expect(Math.max(...assembled, ...decoded)).toBeLessThan(1024 * 1024);
  });

  it('refuses a transcript that grows while it is read, by name', () => {
    const grows = (file: string): void => { reads.onEof = { ino: statSync(file).ino, append: () => appendFileSync(file, '{"type":"late"}\n') }; };
    const pi = sessionFile(piHeader);
    piEntry(pi, 'history-0', null, prompt('earlier'));
    grows(pi);
    expect(() => preparePi(pi)).toThrow(/^native transcript changed during bounded inspection$/u);

    const claude = sessionFile(claudeHeader);
    grows(claude);
    expect(() => prepareClaude(claude)).toThrow(/^native transcript changed during bounded inspection$/u);

    const turn = sessionFile(piHeader);
    preparePi(turn);
    piEntry(turn, 'receipt', null, prompt(text));
    grows(turn);
    expect(() => inspectDirectiveCheckpoint(turn, identity)).toThrow(/^native transcript changed during bounded inspection$/u);
  });
});

describe('the pi tool fence reads its own admission and the whole live turn (#469)', () => {
  const RECEIPT_CHANGED = /^actual native admission user receipt unavailable\/changed$/u;
  const NOT_PERSISTED = /^native tool intent is not persisted before execution or its invocation\/results changed$/u;
  it('refuses a receipt with another prompt or another parent', () => {
    const prompted = sessionFile(piHeader);
    preparePi(prompted);
    piEntry(prompted, 'invocation', piEntry(prompted, 'receipt', null, prompt('a different prompt')), invocation);
    expect(() => flushDirectiveToolIntent(prompted, invocation, toolCall, identity)).toThrow(RECEIPT_CHANGED);

    const parented = sessionFile(piHeader);
    piEntry(parented, 'h0', null, prompt('earlier'));
    expect(preparePi(parented).baseline).toBe('h0');
    piEntry(parented, 'invocation', piEntry(parented, 'receipt', null, prompt(text)), invocation);
    expect(() => flushDirectiveToolIntent(parented, invocation, toolCall, identity)).toThrow(RECEIPT_CHANGED);
  });

  it('refuses a call whose batch sibling\'s result reuses a history id, or a torn live tail', () => {
    // A sequential batch: call-1 settled, call-2 next. Only the id of
    // call-1's result differs between the accepted and the refused case.
    const second = { ...toolCall, id: 'call-2' };
    const batch = { ...invocation, content: [toolCall, second] };
    for (const [id, refused] of [['result-1', false], ['h0', true]] as const) {
      const file = sessionFile(piHeader);
      piEntry(file, 'h0', null, prompt('earlier'));
      preparePi(file);
      piEntry(file, id, piEntry(file, 'invocation', piEntry(file, 'receipt', 'h0', prompt(text)), batch), toolResult('call-1'));
      const flush = () => flushDirectiveToolIntent(file, batch, second, identity);
      if (refused) expect(flush, id).toThrow(NOT_PERSISTED);
      else expect(flush, id).not.toThrow();
    }

    const torn = sessionFile(piHeader);
    preparePi(torn);
    piEntry(torn, 'invocation', piEntry(torn, 'receipt', null, prompt(text)), invocation);
    appendFileSync(torn, '{"type":"message","id":"torn"');
    expect(() => flushDirectiveToolIntent(torn, invocation, toolCall, identity)).toThrow(/^native transcript has a partial entry$/u);
  });

  it('allows the next call after many settled ones: the live turn is read to its end', () => {
    const file = sessionFile(piHeader);
    preparePi(file);
    let parent = piEntry(file, 'receipt', null, prompt(text));
    for (let index = 0; index < 40; index += 1) {
      const call = { ...toolCall, id: `call-${index}` };
      parent = piEntry(file, `result-${index}`, piEntry(file, `use-${index}`, parent, { ...invocation, content: [call] }), toolResult(call.id));
    }
    const next = { ...toolCall, id: 'call-40' };
    const asked = { ...invocation, content: [next] };
    piEntry(file, 'use-40', parent, asked);
    expect(() => flushDirectiveToolIntent(file, asked, next, identity)).not.toThrow();
  });

  it('allows the next call after Pi compacted the turn or the prompt, and refuses one compacted inside a tool round or by a hook (#481)', () => {
    const compaction = (file: string, id: string, parentId: string, firstKeptEntryId: string, fields: Record<string, unknown> = {}): string => {
      appendFileSync(file, `${JSON.stringify({ type: 'compaction', id, parentId, timestamp: '2026-10-22T00:00:00.000Z', summary: 'Pi automatic compaction summary',
        firstKeptEntryId, tokensBefore: 90_000, fromHook: false, ...fields })}\n`);
      return id;
    };
    const next = { ...toolCall, id: 'call-2' };
    const asked = { ...invocation, content: [next] };
    const sibling = { ...toolCall, id: 'call-x' };
    for (const [mode, refused] of [['after-round', false], ['pre-prompt', false], ['inside-round', true], ['inside-batch', true], ['hook-authored', true]] as const) {
      const file = sessionFile(piHeader);
      const earlier = piEntry(file, 'h1', piEntry(file, 'h0', null, prompt('earlier')), answer);
      preparePi(file);
      const receipt = piEntry(file, 'receipt', mode === 'pre-prompt' ? compaction(file, 'pre-prompt', earlier, earlier) : earlier, prompt(text));
      const first = piEntry(file, 'use-1', receipt, mode === 'inside-batch' ? { ...invocation, content: [toolCall, sibling] } : invocation);
      let settled = piEntry(file, 'result-1', mode === 'inside-round' ? compaction(file, 'compaction', first, receipt) : first, toolResult('call-1'));
      // Between two results of one batch: the round is still open.
      if (mode === 'inside-batch') settled = piEntry(file, 'result-x', compaction(file, 'compaction', settled, receipt), toolResult('call-x'));
      const tip = mode === 'after-round' || mode === 'hook-authored'
        ? compaction(file, 'compaction', settled, receipt, mode === 'hook-authored' ? { fromHook: true } : {}) : settled;
      piEntry(file, 'use-2', tip, asked);
      if (refused) expect(() => flushDirectiveToolIntent(file, asked, next, identity), mode).toThrow(NOT_PERSISTED);
      else expect(() => flushDirectiveToolIntent(file, asked, next, identity), mode).not.toThrow();
    }
  });
});

describe('pinned identities and read refusals (#469)', () => {
  it('refuses a receipt with an empty id or the header\'s own id', () => {
    for (const id of ['', 'pi-session']) {
      const file = sessionFile(piHeader);
      preparePi(file);
      piEntry(file, id, null, prompt(text));
      expect(() => inspectDirectiveAdmission(file, identity), id).toThrow(/^malformed\/rebound native admission prefix$/u);
      expect(inspectDirectiveCheckpoint(file, identity), id).toEqual({ state: 'unknown', reason: MALFORMED });
      expect(readDirectiveBinding(file, identity.requestId)?.userEntryId, id).toBeNull();
    }
  });

  it('a read refusal past a pi terminal propagates; a torn header refuses', () => {
    const file = sessionFile(piHeader);
    preparePi(file);
    const final = piEntry(file, 'answer', piEntry(file, 'receipt', null, prompt(text)), answer);
    appendFileSync(file, `${JSON.stringify({ type: 'model_change', id: 'model', parentId: final, provider: 'fixture', modelId: 'next' })}\n{"type":"message","id":"torn"`);
    expect(() => inspectDirectiveCheckpoint(file, identity)).toThrow(/^native transcript has a partial entry$/u);

    const header = sessionFile(piHeader);
    preparePi(header);
    writeFileSync(header, '{"type":"session","id":"pi-session"');
    expect(() => inspectDirectiveCheckpoint(header, identity)).toThrow(/^native transcript has a partial entry$/u);
  });

  it('Claude Code: a torn live tail is no refusal, the checkpoint publishes admission, and the header bound holds at binding', () => {
    const file = sessionFile(claudeHeader);
    prepareClaude(file);
    frames(file, init, echo(), use);
    appendFileSync(file, '{"type":"assistant","uu');
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'native directive turn has no result yet' });
    expect(() => assertClaudeDirectiveToolIntent(file, identity, 't1', 'Read', { file_path: '/x' })).not.toThrow();

    const published = sessionFile(claudeHeader);
    prepareClaude(published);
    frames(published, init, echo(), done());
    expect(readDirectiveBinding(published, identity.requestId)?.userEntryId).toBeNull();
    expect(inspectDirectiveCheckpoint(published, identity)).toMatchObject({ state: 'terminal', ok: true });
    expect(readDirectiveBinding(published, identity.requestId)?.userEntryId).toBe('echo-1');

    const header = sessionFile({ ...claudeHeader, cwd: `/${'x'.repeat(64 * 1024)}` });
    expect(() => prepareClaude(header)).toThrow(/^native session header exceeds the 65536-byte inspection limit$/u);
  });
});

describe('limits at their exact boundaries (#469)', () => {
  /** A Claude turn (init, echo, `rows`, result) of exactly `bytes`, or `count` lines. */
  function claudeTurn(rows: (file: string, start: number) => void): string {
    const file = sessionFile(claudeHeader);
    prepareClaude(file);
    const start = statSync(file).size;
    frames(file, init, echo());
    rows(file, start);
    frames(file, done());
    return file;
  }
  const doneBytes = Buffer.byteLength(`${JSON.stringify(done())}\n`);
  const turnOfBytes = (bytes: number) => claudeTurn((file, start) => {
    const frame = (body: string) => `${JSON.stringify({ type: 'assistant', uuid: 'filler', message: { role: 'assistant', content: [{ type: 'text', text: body }] } })}\n`;
    appendFileSync(file, frame('x'.repeat(bytes - (statSync(file).size - start) - doneBytes - Buffer.byteLength(frame('')))));
  });
  const turnOfLines = (lines: number) => claudeTurn((file) => appendRows(file, lines - 3, () => ({ type: 'stream_event', session_id: 'cli-session' })));

  it('a turn of exactly 32 MiB or 250,000 entries is read; one byte or one entry more refuses', () => {
    const exact = turnOfBytes(LIMIT);
    expect(inspectDirectiveCheckpoint(exact, identity)).toMatchObject({ state: 'terminal', ok: true });
    expect(() => inspectDirectiveCheckpoint(turnOfBytes(LIMIT + 1), identity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);
    expect(inspectDirectiveCheckpoint(turnOfLines(250_000), identity)).toMatchObject({ state: 'terminal', ok: true });
    expect(() => inspectDirectiveCheckpoint(turnOfLines(250_001), identity)).toThrow(/^native directive turn exceeds the entry inspection limit$/u);
  });

  it('pi: a turn of exactly 32 MiB, its receipt included, is read; one byte more refuses', () => {
    const turn = (bytes: number) => {
      const file = sessionFile(piHeader);
      preparePi(file);
      const receipt = `${JSON.stringify({ type: 'message', id: 'receipt-a', parentId: null, message: prompt(text) })}\n`;
      const terminal = (body: string) => `${JSON.stringify({ type: 'message', id: 'answer-a', parentId: 'receipt-a', message: { ...answer, content: [{ type: 'text', text: body }] } })}\n`;
      appendFileSync(file, receipt + terminal('x'.repeat(bytes - Buffer.byteLength(receipt) - Buffer.byteLength(terminal('')))));
      return file;
    };
    expect(inspectDirectiveCheckpoint(turn(LIMIT), identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer-a' });
    expect(() => inspectDirectiveCheckpoint(turn(LIMIT + 1), identity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);
  });

  it('a header line of exactly 64 KiB is read; one byte more refuses', () => {
    const header = (bytes: number) => {
      const line = (cwd: string) => JSON.stringify({ ...piHeader, cwd });
      return sessionFile(JSON.parse(line(`/${'x'.repeat(bytes - Buffer.byteLength(line('/')))}`)) as Record<string, unknown>);
    };
    expect(readDirectiveSessionHeader(header(64 * 1024))).toMatchObject({ type: 'session', id: 'pi-session' });
    expect(() => readDirectiveSessionHeader(header(64 * 1024 + 1))).toThrow(/^native session header exceeds the 65536-byte inspection limit$/u);
  });

  it('pi: a lookahead past a terminal has its own bound and its own name, never the earlier turn\'s', () => {
    /** A 2-entry turn, then `controls` controls and the next directive's receipt. */
    const lookahead = (controls: number) => {
      const file = sessionFile(piHeader);
      preparePi(file);
      const final = piEntry(file, 'answer-a', piEntry(file, 'receipt-a', null, prompt(text)), answer);
      appendRows(file, controls, (index) => ({ type: 'thinking_level_change', id: `level-${index}`, parentId: index === 0 ? final : `level-${index - 1}`, thinkingLevel: 'low' }));
      preparePi(file, laterIdentity, 'the next approved step');
      piEntry(file, 'receipt-b', `level-${controls - 1}`, prompt('the next approved step'));
      expect(inspectDirectiveAdmission(file, laterIdentity)).toMatchObject({ userEntryId: 'receipt-b' });
      return { file, final };
    };
    // 249,999 controls and the receipt are 250,000 lookahead entries: within their own bound.
    const within = lookahead(249_999);
    expect(inspectDirectiveCheckpoint(within.file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: within.final });
    // One more is past it, and refused as the lookahead, never as the 2-entry turn.
    expect(() => inspectDirectiveCheckpoint(lookahead(250_000).file, identity)).toThrow(/^native lookahead after the directive turn exceeds the entry inspection limit$/u);

    const bytes = sessionFile(piHeader);
    preparePi(bytes);
    const final = piEntry(bytes, 'answer-a', piEntry(bytes, 'receipt-a', null, prompt(text)), answer);
    piEntry(bytes, 'huge', final, prompt('x'.repeat(LIMIT)));
    expect(() => inspectDirectiveCheckpoint(bytes, identity)).toThrow(/^native lookahead after the directive turn exceeds the 33554432-byte inspection limit$/u);
  });
});
