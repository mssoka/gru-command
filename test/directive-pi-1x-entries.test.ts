import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DirectiveCheckpointError, conversationTail, flushDirectiveToolIntent, inspectDirectiveAdmission, inspectDirectiveCheckpoint, prepareDirectiveBinding,
  prepareDirectiveProducer, recordDirectiveRetryStart, type DirectiveTurnIdentity,
} from '../src/runtime/directive-checkpoint.js';

/**
 * The native transcript shapes pi 1.x adds to a directive's turn (#521):
 *  - `system` message entries (the prompt sections and tool declarations),
 *    persisted directly ahead of the prompt that carries them;
 *  - a `context_edit` entry that omits a failed reply from the model's
 *    context before the SDK retries it, or compacts and retries it;
 *  - a `usage` entry (kind cache_warm) its cache warmer appends on a timer,
 *    anywhere in a turn.
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
/** Pi's cache warmer: a usage entry on the current leaf. */
function cacheWarm(file: string, id: string, parentId: string | null, kind = 'cache_warm') {
  return append(file, { type: 'usage', id, parentId, timestamp: '2026-10-28T00:00:00.000Z', kind, provider: 'anthropic', model: 'fixture-model',
    usage: { input: 1, output: 1, cacheRead: 9, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}
/** A directive bound at the header, with `systemIds` persisted ahead of its receipt (each parented on the one before). */
function boundFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-pi-1x-entries-'));
  dirs.push(dir);
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'pi-session', version: 3, cwd: '/lane' })}\n`);
  prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'minion', sessionId: 'pi-session', sessionFile: file, text, authorityManifest: 'manifest' });
  return file;
}
/** A later directive prepared on the current last entry and admitted after `parentId` (through a system message when `systemId` names one). */
function laterRequest(file: string, parentId: string, systemId?: string): void {
  const later: DirectiveTurnIdentity = { ...identity, requestId: 'later-request', payloadHash: 'b'.repeat(64) };
  prepareDirectiveBinding({ identity: later, runtime: 'pi', agentId: 'minion', sessionId: 'pi-session', sessionFile: file, text: 'a later directive', authorityManifest: 'manifest' });
  let parent = parentId;
  if (systemId !== undefined) { message(file, systemId, parent, system); parent = systemId; }
  message(file, 'later-receipt', parent, userMessage('a later directive'));
  expect(inspectDirectiveAdmission(file, later).userEntryId).toBe('later-receipt');
}
function scene(systemIds: readonly string[] = [], receiptParent?: string | null) {
  const file = boundFile();
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

  it('a system message that is not linked on the baseline is no part of the receipt chain: admission is refused', () => {
    const file = boundFile();
    message(file, 'system-1', 'elsewhere', system);
    message(file, 'receipt', 'system-1', userMessage(text));
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(new DirectiveCheckpointError('actual native admission user receipt unavailable/changed'));
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
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
    laterRequest(file, 'answer', 'later-system');
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

  it('a context edit that rewrites a row inside the turn is no omission of a failed reply: the checkpoint and the next tool are refused', () => {
    const rewrite = { targetId: 'result', replacement: { role: 'toolResult', toolCallId: call.id, toolName: 'bash', isError: false, content: [{ type: 'text', text: 'rewritten' }] } };
    const { file } = scene(['system-1']);
    message(file, 'invocation', 'receipt', invocation);
    message(file, 'result', 'invocation', result);
    contextEdit(file, 'rewrite-result', 'result', rewrite);
    message(file, 'answer', 'rewrite-result', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
    const second = scene(['system-1']);
    const next = { ...call, id: 'call-second' };
    const nextInvocation = { ...invocation, content: [next] };
    message(second.file, 'invocation', 'receipt', invocation);
    message(second.file, 'result', 'invocation', result);
    contextEdit(second.file, 'rewrite-result', 'result', rewrite);
    message(second.file, 'next-invocation', 'rewrite-result', nextInvocation);
    expect(() => flushDirectiveToolIntent(second.file, nextInvocation, next, identity)).toThrow(DirectiveCheckpointError);
  });

  it('a context edit after the compact-and-retry that rewrites its compaction is refused ahead of a later bound request', () => {
    const { file } = scene(['system-1']);
    message(file, 'retry-error', 'receipt', { ...failed, errorMessage: 'prompt is too long: 150000 tokens > 100000 maximum' });
    contextEdit(file, 'omit-error', 'retry-error');
    compaction(file, 'retry-compaction', 'omit-error');
    contextEdit(file, 'rewrite-compaction', 'retry-compaction', { replacement: { role: 'user', content: 'rewritten' } });
    laterRequest(file, 'rewrite-compaction');
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'native context edit does not omit the completed checkpoint' });
  });

  it('an edit linked on a sibling branch is not the omission of the terminal error row it names', () => {
    const { file } = scene(['system-1']);
    message(file, 'retry-error', 'receipt', failed);
    contextEdit(file, 'omit-error', 'receipt', { targetId: 'retry-error' });
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
  });

  it('an edit that omits a reply which did not fail is no retry\'s omission: the checkpoint is refused', () => {
    const { file } = scene(['system-1']);
    message(file, 'answer', 'receipt', answer);
    contextEdit(file, 'omit-answer', 'answer');
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
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

  it('a lost host after the omitting edit and the recovery compaction reads the failed reply\'s terminal, not ok', () => {
    const { file } = scene(['system-1']);
    message(file, 'retry-error', 'receipt', { ...failed, errorMessage: 'prompt is too long: 150000 tokens > 100000 maximum' });
    contextEdit(file, 'omit-error', 'retry-error');
    compaction(file, 'retry-compaction', 'omit-error');
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: false, checkpointId: 'retry-error' });
  });

  it('a later bound request after that edit and compaction leaves the earlier turn terminal, not ok', () => {
    const { file } = scene(['system-1']);
    message(file, 'retry-error', 'receipt', { ...failed, errorMessage: 'prompt is too long: 150000 tokens > 100000 maximum' });
    contextEdit(file, 'omit-error', 'retry-error');
    compaction(file, 'retry-compaction', 'omit-error');
    laterRequest(file, 'retry-compaction');
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: false, checkpointId: 'retry-error' });
  });

  it('an abandoned retry followed by a later bound request, through its system message, leaves the earlier turn terminal, not ok', () => {
    const { file, producer } = scene(['system-1']);
    const error = message(file, 'retry-error', 'receipt', failed);
    expect(recordDirectiveRetryStart(producer, retryEvent, error)).toBeNull();
    contextEdit(file, 'omit-error', 'retry-error');
    laterRequest(file, 'omit-error', 'later-system');
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: false, error: ERROR, checkpointId: 'retry-error' });
  });

  it('the same abandoned retry whose edit replaces its target is no omission: the earlier turn stays unknown', () => {
    const { file, producer } = scene(['system-1']);
    const error = message(file, 'retry-error', 'receipt', failed);
    expect(recordDirectiveRetryStart(producer, retryEvent, error)).toBeNull();
    contextEdit(file, 'omit-error', 'retry-error', { replacement: { role: 'user', content: 'rewritten' } });
    laterRequest(file, 'omit-error', 'later-system');
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
  });
});

describe('pi 1.x cache-warm usage entries (#521)', () => {
  it('a warm entry between the baseline and the receipt is read through: admission and the checkpoint see the receipt on the baseline', () => {
    const file = boundFile();
    // Appended by the timer after the binding was prepared, ahead of the prompt's own entries.
    cacheWarm(file, 'warm-1', null);
    message(file, 'system-1', 'warm-1', system);
    message(file, 'receipt', 'system-1', userMessage(text));
    expect(inspectDirectiveAdmission(file, identity).userEntryId).toBe('receipt');
    message(file, 'answer', 'receipt', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a warm entry mid-turn, even between a tool call and its result, leaves the tool guard and the checkpoint intact', () => {
    const { file } = scene(['system-1']);
    message(file, 'invocation', 'receipt', invocation);
    cacheWarm(file, 'warm-1', 'invocation');
    expect(() => flushDirectiveToolIntent(file, invocation, call, identity)).not.toThrow();
    message(file, 'result', 'warm-1', result);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'resumable', checkpointId: 'result' });
    cacheWarm(file, 'warm-2', 'result');
    message(file, 'answer', 'warm-2', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a warm entry on a failed reply, before its omitting edit, keeps the retry history readable', () => {
    const { file, producer } = scene(['system-1']);
    const error = message(file, 'retry-error', 'receipt', failed);
    expect(recordDirectiveRetryStart(producer, retryEvent, error)).toBeNull();
    cacheWarm(file, 'warm-1', 'retry-error');
    contextEdit(file, 'omit-error', 'retry-error');
    message(file, 'invocation', 'omit-error', invocation);
    expect(() => flushDirectiveToolIntent(file, invocation, call, identity)).not.toThrow();
    message(file, 'result', 'invocation', result);
    message(file, 'answer', 'result', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a later directive prepared on a warm entry that follows the earlier turn is still its own bound request', () => {
    const { file } = scene(['system-1']);
    message(file, 'answer', 'receipt', answer);
    cacheWarm(file, 'warm-1', 'answer');
    // Prepared while the warm entry is the last one: that entry is its baseline.
    laterRequest(file, 'warm-1', 'later-system');
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a warm entry that is its own parent closes a cycle, not a chain: admission and the checkpoint refuse it', () => {
    const file = boundFile();
    cacheWarm(file, 'warm-self', 'warm-self');
    message(file, 'receipt', 'warm-self', userMessage(text));
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(DirectiveCheckpointError);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
  });

  it('two warm entries that are each other\'s parent close a cycle too: the walk ends and the receipt is refused', () => {
    const file = boundFile();
    cacheWarm(file, 'warm-a', 'warm-b');
    cacheWarm(file, 'warm-b', 'warm-a');
    message(file, 'receipt', 'warm-b', userMessage(text));
    expect(() => inspectDirectiveAdmission(file, identity)).toThrow(DirectiveCheckpointError);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
  });

  it('a usage entry of any other kind is an unknown entry: the checkpoint refuses it by name', () => {
    const { file } = scene(['system-1']);
    cacheWarm(file, 'usage-1', 'receipt', 'extension_note');
    message(file, 'answer', 'usage-1', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'native branch/control/partial checkpoint' });
  });

  it('the retry-start receipt reads the conversation tail, never a warm entry that became the leaf', () => {
    const entries = [{ type: 'message', id: 'retry-error' }, { type: 'usage', kind: 'cache_warm', id: 'warm-1' }, { type: 'usage', kind: 'cache_warm', id: 'warm-2' }];
    expect(conversationTail(entries)?.id).toBe('retry-error');
    expect(conversationTail([...entries, { type: 'usage', kind: 'extension_note', id: 'usage-3' }])?.id).toBe('usage-3');
    expect(conversationTail(entries.slice(1))).toBeUndefined();
  });
});
