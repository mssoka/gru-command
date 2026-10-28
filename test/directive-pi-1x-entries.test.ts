import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DirectiveCheckpointError, flushDirectiveToolIntent, inspectDirectiveAdmission, inspectDirectiveCheckpoint, prepareDirectiveBinding,
  prepareDirectiveProducer, recordDirectiveRetryStart, type DirectiveTurnIdentity,
} from '../src/runtime/directive-checkpoint.js';

/**
 * The native transcript shapes pi 1.x adds to a directive's turn (#521):
 *  - `system` message entries (the prompt sections and tool declarations),
 *    persisted directly ahead of the prompt that carries them;
 *  - a `context_edit` entry that omits a failed reply from the model's
 *    context before the SDK retries it, or compacts and retries it.
 * Only these exact shapes, linked on the chain, are walked past. Every
 * control differs from an admitted case in one fact, so each refusal is that
 * fact's.
 */

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const identity: DirectiveTurnIdentity = { requestId: 'pi-1x-request', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64),
  jobId: 'pi-1x-job', workRevision: 0, authorityEpoch: 0 };
const text = 'follow the approved correction';
const ERROR = 'OpenAI Responses stream ended before a terminal response event';
const system = { role: 'system', content: '', sections: { identity: 'You are a minion.' }, toolsAdded: [{ name: 'bash', description: 'Run a command', parameters: { type: 'object' } }], timestamp: 1 };
const call = { type: 'toolCall', id: 'call-after-retry', name: 'bash', arguments: { command: 'true' } };
const invocation = { role: 'assistant', stopReason: 'toolUse', content: [call] };
const result = { role: 'toolResult', toolCallId: call.id, toolName: 'bash', isError: false, content: [{ type: 'text', text: 'ok' }] };
const answer = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] };
const failed = { role: 'assistant', stopReason: 'error', errorMessage: ERROR, content: [{ type: 'text', text: 'Checking', textSignature: '{"v":1,"id":"msg_1","phase":"commentary"}' }] };
const retryEvent = { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR };
const userMessage = (body: string) => ({ role: 'user', content: [{ type: 'text', text: body }] });

function append(file: string, row: Record<string, unknown>): Record<string, unknown> {
  appendFileSync(file, `${JSON.stringify(row)}\n`);
  return row;
}
function message(file: string, id: string, parentId: string | null, body: Record<string, unknown>) {
  return append(file, { type: 'message', id, parentId, message: body });
}
/** Pi 1.x omits a failed reply from context; `edit` overrides the omission's fields. */
function contextEdit(file: string, id: string, parentId: string, edit: Record<string, unknown> = {}) {
  return append(file, { type: 'context_edit', id, parentId, timestamp: '2026-10-28T00:00:00.000Z', targetId: parentId, replacement: null, ...edit });
}
/** Pi's automatic compaction linked on `parentId`, keeping the receipt. */
function compaction(file: string, id: string, parentId: string) {
  return append(file, { type: 'compaction', id, parentId, timestamp: '2026-10-28T00:00:00.000Z', summary: 'Pi automatic compaction summary',
    firstKeptEntryId: 'receipt', tokensBefore: 90_000, fromHook: false });
}
/** A directive bound at the header, with `systemIds` persisted ahead of its receipt (each parented on the one before). */
function scene(systemIds: readonly string[] = [], receiptParent?: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'gru-pi-1x-entries-'));
  dirs.push(dir);
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'pi-session', version: 3, cwd: '/lane' })}\n`);
  prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'minion', sessionId: 'pi-session', sessionFile: file, text, authorityManifest: 'manifest' });
  let parent: string | null = null;
  for (const id of systemIds) { message(file, id, parent, system); parent = id; }
  message(file, 'receipt', receiptParent === undefined ? parent : receiptParent, userMessage(text));
  return { file, producer: prepareDirectiveProducer({ identity, agentId: 'minion', sessionId: 'pi-session', sessionFile: file }) };
}

describe('pi 1.x system message entries ahead of a directive receipt (#521)', () => {
  it('a system message linked ahead of the receipt is walked past: admission and the checkpoint read through it', () => {
    const { file } = scene(['system-1']);
    expect(inspectDirectiveAdmission(file, identity).userEntryId).toBe('receipt');
    message(file, 'answer', 'receipt', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a prompt patch and a tool patch chained ahead of the receipt are both walked past', () => {
    const { file } = scene(['system-1', 'system-2']);
    expect(inspectDirectiveAdmission(file, identity).userEntryId).toBe('receipt');
    message(file, 'answer', 'receipt', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a receipt that is not linked after the system message ahead of it is no part of the receipt chain: admission is refused', () => {
    const { file } = scene(['system-1'], null);
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(new DirectiveCheckpointError('actual native admission user receipt unavailable/changed'));
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'actual native request receipt unavailable' });
  });

  it('a system message inside the turn is another writer\'s authority change: the checkpoint is refused by name', () => {
    const { file } = scene(['system-1']);
    inspectDirectiveAdmission(file, identity);
    message(file, 'mid-turn-system', 'receipt', system);
    message(file, 'answer', 'mid-turn-system', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'another user/custom message owns this session' });
  });

  it('a later bound request preceded by its own system message leaves the earlier checkpoint terminal', () => {
    const { file } = scene(['system-1']);
    inspectDirectiveAdmission(file, identity);
    message(file, 'answer', 'receipt', answer);
    const later: DirectiveTurnIdentity = { ...identity, requestId: 'later-request', payloadHash: 'b'.repeat(64) };
    prepareDirectiveBinding({ identity: later, runtime: 'pi', agentId: 'minion', sessionId: 'pi-session', sessionFile: file, text: 'a later directive', authorityManifest: 'manifest' });
    message(file, 'later-system', 'answer', system);
    message(file, 'later-receipt', 'later-system', userMessage('a later directive'));
    expect(inspectDirectiveAdmission(file, later).userEntryId).toBe('later-receipt');
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });
});

describe('pi 1.x context edits around a retried reply (#521)', () => {
  it('a receipted error row retried through the context edit that omits it: the retried call runs and the turn completes', () => {
    const { file, producer } = scene(['system-1']);
    const error = message(file, 'retry-error', 'receipt', failed);
    expect(recordDirectiveRetryStart(producer, retryEvent, error)).toBeNull();
    contextEdit(file, 'omit-error', 'retry-error');
    message(file, 'invocation', 'omit-error', invocation);
    expect(() => flushDirectiveToolIntent(file, invocation, call, identity)).not.toThrow();
    message(file, 'result', 'invocation', result);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'resumable', checkpointId: 'result' });
    message(file, 'answer', 'result', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a context edit that omits another row, or replaces its target, is not the retry\'s omission: the tool and the checkpoint are refused', () => {
    for (const [label, edit] of [['another target', { targetId: 'receipt' }], ['a replacement', { replacement: { role: 'user', content: 'rewritten' } }]] as const) {
      const { file, producer } = scene(['system-1']);
      const error = message(file, 'retry-error', 'receipt', failed);
      expect(recordDirectiveRetryStart(producer, retryEvent, error), label).toBeNull();
      contextEdit(file, 'omit-error', 'retry-error', edit);
      message(file, 'invocation', 'omit-error', invocation);
      expect(() => flushDirectiveToolIntent(file, invocation, call, identity), label).toThrow(DirectiveCheckpointError);
      message(file, 'result', 'invocation', result);
      message(file, 'answer', 'result', answer);
      expect(inspectDirectiveCheckpoint(file, identity), label).toMatchObject({ state: 'unknown' });
    }
  });

  it('a retry abandoned after the context edit leaves the omitted error row as the turn\'s terminal: not ok, with that error', () => {
    const { file, producer } = scene(['system-1']);
    const error = message(file, 'retry-error', 'receipt', failed);
    expect(recordDirectiveRetryStart(producer, retryEvent, error)).toBeNull();
    contextEdit(file, 'omit-error', 'retry-error');
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: false, error: ERROR, checkpointId: 'retry-error' });
  });

  it('a trailing context edit that omits something other than the terminal error row refuses the checkpoint', () => {
    const { file } = scene(['system-1']);
    message(file, 'retry-error', 'receipt', failed);
    contextEdit(file, 'omit-error', 'retry-error', { targetId: 'receipt' });
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
  });

  it('a compact-and-retry through the context edit that omits the failed reply keeps the directive', () => {
    const { file } = scene(['system-1']);
    message(file, 'retry-error', 'receipt', { ...failed, errorMessage: 'prompt is too long: 150000 tokens > 100000 maximum' });
    contextEdit(file, 'omit-error', 'retry-error');
    compaction(file, 'retry-compaction', 'omit-error');
    message(file, 'invocation', 'retry-compaction', invocation);
    expect(() => flushDirectiveToolIntent(file, invocation, call, identity)).not.toThrow();
    message(file, 'result', 'invocation', result);
    message(file, 'answer', 'result', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a call-less length row Pi compacts and retries through the omitting edit keeps the directive', () => {
    const { file } = scene(['system-1']);
    message(file, 'truncated', 'receipt', { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'partial answer' }] });
    contextEdit(file, 'omit-truncated', 'truncated');
    compaction(file, 'retry-compaction', 'omit-truncated');
    message(file, 'invocation', 'retry-compaction', invocation);
    expect(() => flushDirectiveToolIntent(file, invocation, call, identity)).not.toThrow();
    message(file, 'result', 'invocation', result);
    message(file, 'answer', 'result', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a compaction that skips the omitting edit is not linked on the failed reply: refused', () => {
    const { file } = scene(['system-1']);
    message(file, 'retry-error', 'receipt', { ...failed, errorMessage: 'prompt is too long: 150000 tokens > 100000 maximum' });
    contextEdit(file, 'omit-error', 'retry-error');
    compaction(file, 'retry-compaction', 'receipt');
    message(file, 'invocation', 'retry-compaction', invocation);
    expect(() => flushDirectiveToolIntent(file, invocation, call, identity)).toThrow(DirectiveCheckpointError);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
  });
});
