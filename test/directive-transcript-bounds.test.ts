import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertClaudeDirectiveToolIntent, flushDirectiveToolIntent, inspectDirectiveAdmission, inspectDirectiveCheckpoint,
  prepareClaudeDirectiveBinding, prepareDirectiveBinding, readDirectiveSessionHeader, type DirectiveTurnIdentity,
} from '../src/runtime/directive-checkpoint.js';

/**
 * Bounded native inspection (#469). Inspecting a directive is bounded by the
 * directive's own turn, never by the session's lifetime: a session whose
 * transcript is past the 32 MiB limit still takes directives on both
 * runtimes. A changed prefix and a directive turn that is itself too large
 * are still refused by name.
 */

const LIMIT = 32 * 1024 * 1024;
const PAST_LIMIT = LIMIT + 4 * 1024 * 1024;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const identity: DirectiveTurnIdentity = { requestId: 'bounded-request', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64),
  jobId: 'bounded-job', workRevision: 0, authorityEpoch: 0 };
const text = 'follow the approved correction';
const filler = 'x'.repeat(256 * 1024);

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

/** Rewrites `from` (found exactly once) with `to` of the same length, in place. */
function patch(file: string, from: string, to: string): void {
  const bytes = readFileSync(file);
  const at = bytes.indexOf(from);
  if (at < 0 || bytes.indexOf(from, at + 1) >= 0 || Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error(`patch target ${from} is not unique or changes length`);
  const fd = openSync(file, 'r+');
  try { writeSync(fd, to, at); } finally { closeSync(fd); }
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
function preparePi(file: string) {
  return prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'minion', sessionId: 'pi-session', sessionFile: file, text, authorityManifest: 'manifest' });
}
const toolCall = { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'true' } };
const invocation = { role: 'assistant', stopReason: 'toolUse', content: [toolCall] };

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
const content = [{ type: 'text', text }];
function prepareClaude(file: string) {
  return prepareClaudeDirectiveBinding({ identity, agentId: 'minion', sessionId: 'cli-session', sessionFile: file, content, authorityManifest: 'manifest' });
}
const init = { type: 'system', subtype: 'init', session_id: 'cli-session' };
const echo = { type: 'user', isReplay: true, uuid: 'echo-1', session_id: 'cli-session', parent_tool_use_id: null, message: { role: 'user', content } };
const use = { type: 'assistant', uuid: 'a-t1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } };
const result = { type: 'user', uuid: 'r-t1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } };
const done = { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1', session_id: 'cli-session' };

describe('a pi session past the transcript limit (#469)', () => {
  it('reads its header, admits, fences a tool and checkpoints a small directive turn', () => {
    const { file, last } = piSession(PAST_LIMIT);
    expect(statSync(file).size).toBeGreaterThan(LIMIT);
    expect(readDirectiveSessionHeader(file)).toEqual(piHeader);
    expect(preparePi(file).baseline).toBe(last);
    const receipt = piEntry(file, 'receipt', last, { role: 'user', content: [{ type: 'text', text }] });
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ baseline: last, userEntryId: receipt });
    const asked = piEntry(file, 'invocation', receipt, invocation);
    expect(() => flushDirectiveToolIntent(file, invocation, toolCall, identity)).not.toThrow();
    const settled = piEntry(file, 'result', asked, { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'ok' }] });
    const answer = piEntry(file, 'answer', settled, { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] });
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: answer });
  });

  it('still refuses a rewritten history: a repeated entry id or a lost baseline', () => {
    const { file, last } = piSession(PAST_LIMIT);
    preparePi(file);
    const receipt = piEntry(file, 'receipt', last, { role: 'user', content: [{ type: 'text', text }] });
    piEntry(file, 'answer', receipt, { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] });
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true });
    // An id deep in the history repeats an earlier one.
    patch(file, '"id":"history-10"', '"id":"history-11"');
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'native checkpoint has a malformed or duplicate entry identity' });
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(/^malformed\/rebound native admission prefix$/u);
    patch(file, '"id":"history-11","parentId":"history-9"', '"id":"history-10","parentId":"history-9"');
    // The baseline entry itself is gone.
    patch(file, `"id":"${last}"`, `"id":"${last.replace('history', 'rewrite')}"`);
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'native baseline unavailable' });
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(/^actual native admission user receipt unavailable$/u);
  });

  it('refuses by name a directive turn past the limits, an oversized history entry and an oversized header', () => {
    const turn = sessionFile(piHeader);
    preparePi(turn);
    const receipt = piEntry(turn, 'receipt', null, { role: 'user', content: [{ type: 'text', text }] });
    appendUntil(turn, PAST_LIMIT, (index) => JSON.stringify({ type: 'message', id: `turn-${index}`, parentId: index === 0 ? receipt : `turn-${index - 1}`,
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: filler }] } }));
    expect(() => inspectDirectiveCheckpoint(turn, identity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);
    expect(() => inspectDirectiveAdmission(turn, identity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);

    const entry = sessionFile(piHeader);
    appendFileSync(entry, `${JSON.stringify({ type: 'message', id: 'huge', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(LIMIT) }] } })}\n`);
    expect(() => preparePi(entry)).toThrow(/^native transcript entry exceeds the 33554432-byte inspection limit$/u);

    const header = sessionFile({ ...piHeader, cwd: `/${'x'.repeat(64 * 1024)}` });
    expect(() => readDirectiveSessionHeader(header)).toThrow(/^native session header exceeds the 65536-byte inspection limit$/u);
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
    frames(file, init, echo);
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ userEntryId: 'echo-1' });
    frames(file, use);
    expect(() => assertClaudeDirectiveToolIntent(file, identity, 't1', 'Read', { file_path: '/x' })).not.toThrow();
    frames(file, result, done);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'result-1' });
  });

  it('still refuses a changed prefix deep in the session, and corrupted bytes at binding', () => {
    const file = claudeSession(PAST_LIMIT);
    prepareClaude(file);
    frames(file, init, echo, use);
    expect(inspectDirectiveAdmission(file, identity)).toMatchObject({ userEntryId: 'echo-1' });
    patch(file, '"uuid":"history-100"', '"uuid":"history-999"');
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'the native transcript before the directive changed' });
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(/^the native transcript before the directive changed$/u);
    expect(() => assertClaudeDirectiveToolIntent(file, identity, 't1', 'Read', { file_path: '/x' })).toThrow(/^the native transcript before the directive changed$/u);

    const corrupted = claudeSession(PAST_LIMIT);
    const fd = openSync(corrupted, 'r+');
    try { writeSync(fd, Buffer.from([0xff]), 0, 1, LIMIT); } finally { closeSync(fd); }
    expect(() => prepareClaude(corrupted)).toThrow(/^native transcript is not valid UTF-8; corrupted bytes are never evidence$/u);
  });

  it('refuses by name a directive turn past the limit', () => {
    const file = sessionFile(claudeHeader);
    prepareClaude(file);
    frames(file, init, echo);
    appendUntil(file, PAST_LIMIT, (index) => JSON.stringify({ type: 'assistant', uuid: `turn-${index}`, message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }));
    expect(() => inspectDirectiveCheckpoint(file, identity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(/^native directive turn exceeds the 33554432-byte inspection limit$/u);
  });
});

describe('bounded reads (#469)', () => {
  it('never holds a session whole: every buffer inspection assembles or decodes stays far below the session size', () => {
    const pi = piSession(PAST_LIMIT);
    const claude = claudeSession(PAST_LIMIT);
    const concat = vi.spyOn(Buffer, 'concat');
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    readDirectiveSessionHeader(pi.file);
    preparePi(pi.file);
    const receipt = piEntry(pi.file, 'receipt', pi.last, { role: 'user', content: [{ type: 'text', text }] });
    inspectDirectiveAdmission(pi.file, identity);
    const asked = piEntry(pi.file, 'invocation', receipt, invocation);
    flushDirectiveToolIntent(pi.file, invocation, toolCall, identity);
    piEntry(pi.file, 'result', asked, { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'ok' }] });
    expect(inspectDirectiveCheckpoint(pi.file, identity)).toMatchObject({ state: 'resumable', checkpointId: 'result' });
    readDirectiveSessionHeader(claude);
    prepareClaude(claude);
    frames(claude, init, echo, use);
    inspectDirectiveAdmission(claude, identity);
    assertClaudeDirectiveToolIntent(claude, identity, 't1', 'Read', { file_path: '/x' });
    expect(inspectDirectiveCheckpoint(claude, identity)).toMatchObject({ state: 'unknown', reason: 'native directive turn has no result yet' });
    const assembled = concat.mock.results.map((call) => (call.value as Buffer).length);
    const decoded = decode.mock.calls.map(([input]) => (input as Uint8Array | undefined)?.byteLength ?? 0);
    expect(assembled.length).toBeGreaterThan(0);
    expect(decoded.length).toBeGreaterThan(0);
    // The largest is one 256 KiB history entry, never the 36 MiB session.
    expect(Math.max(...assembled, ...decoded)).toBeLessThan(1024 * 1024);
  });
});
