import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DirectiveCheckpointError, flushDirectiveToolIntent, inspectDirectiveAdmission, inspectDirectiveCheckpoint, prepareDirectiveBinding,
  prepareDirectiveProducer, readDirectiveBinding, recordDirectiveRetryStart, type DirectiveProducer, type DirectiveTurnIdentity,
} from '../src/runtime/directive-checkpoint.js';

/**
 * Pi retry history (#483). After a retryable provider error the Pi SDK keeps
 * the error assistant row in the transcript and retries from it. Only a
 * durable `retry-start` receipt, written from the live SDK `auto_retry_start`
 * event through the directive's exact physical producer, lets the native tool
 * guard and the checkpoint walk past that row, and only when the SDK's
 * retried answer follows it. Every control below differs from the admitted
 * case in exactly one fact, so each refusal is that fact's.
 */

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const identity: DirectiveTurnIdentity = { requestId: 'retry-request', payloadHash: 'a'.repeat(64), contractSha256: 'c'.repeat(64),
  jobId: 'retry-job', workRevision: 0, authorityEpoch: 0 };
const text = 'follow the approved correction';
const ERROR = 'OpenAI Responses stream ended before a terminal response event';
const UNRECEIPTED = 'native error row has no matching live SDK retry-start receipt';
const NOT_HISTORY = 'native retry-start receipted error row is not retry history: unknown content or no retried answer';
const TAIL = 'native branch tail is not the effect-free error row this retry names';
/** What the Responses and Google parsers persist before a stream breaks. */
const signedContent = [
  { type: 'thinking', thinking: 'reading the lane first', thinkingSignature: 'opaque-reasoning', redacted: false },
  { type: 'text', text: 'Checking the failing test', textSignature: '{"v":1,"id":"msg_1","phase":"commentary"}' },
];
const errorMessage = (content: readonly unknown[] = signedContent, error = ERROR) => ({ role: 'assistant', stopReason: 'error', errorMessage: error, content });
const call = { type: 'toolCall', id: 'call-after-retry', name: 'bash', arguments: { command: 'true' } };
/** A call the stream cut off mid-arguments: the SDK never runs it. */
const partialCall = { type: 'toolCall', id: 'partial-call|partial-item', name: 'bash', arguments: {} };
const invocation = { role: 'assistant', stopReason: 'toolUse', content: [call] };
const result = { role: 'toolResult', toolCallId: call.id, toolName: 'bash', isError: false, content: [{ type: 'text', text: 'ok' }] };
const answer = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] };
const retryEvent = (overrides: Record<string, unknown> = {}) => ({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: ERROR, ...overrides });

function entry(file: string, id: string, parentId: string | null, message: Record<string, unknown>) {
  const row = { type: 'message', id, parentId, message };
  appendFileSync(file, `${JSON.stringify(row)}\n`);
  return row;
}
function journal(file: string): string { return readFileSync(`${file}.producers.jsonl`, 'utf8'); }
function appendReceipt(file: string, receipt: Record<string, unknown>): void { appendFileSync(`${file}.producers.jsonl`, `${JSON.stringify(receipt)}\n`); }
function producerFor(file: string, who: DirectiveTurnIdentity): DirectiveProducer {
  return prepareDirectiveProducer({ identity: who, agentId: 'minion', sessionId: 'pi-session', sessionFile: file });
}

/** A Pi directive whose first request failed at `retry-error`, admitted
 * (read back) unless `admit` is false. */
function retryScene(content: readonly unknown[] = signedContent, admit = true) {
  const dir = mkdtempSync(join(tmpdir(), 'gru-retry-history-'));
  dirs.push(dir);
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'pi-session', version: 3, cwd: '/lane' })}\n`);
  prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'minion', sessionId: 'pi-session', sessionFile: file, text, authorityManifest: 'manifest' });
  const producer = producerFor(file, identity);
  entry(file, 'receipt', null, { role: 'user', content: [{ type: 'text', text }] });
  if (admit) inspectDirectiveAdmission(file, identity);
  const error = entry(file, 'retry-error', 'receipt', errorMessage(content));
  return { file, producer, error };
}
/** The retried request calls a tool: the guard must admit it before it runs. */
function flushRetried(file: string, parent = 'retry-error'): void {
  entry(file, 'invocation', parent, invocation);
  flushDirectiveToolIntent(file, invocation, call, identity);
}
/** The tool ran and the turn answered: the walk must get past the error row. */
function finishTurn(file: string): void {
  entry(file, 'result', 'invocation', result);
  entry(file, 'answer', 'result', answer);
}
/** Refused at the guard by `reason`, and the checkpoint never reads the turn as finished. */
function expectRetryHistoryRefused(file: string, reason = UNRECEIPTED): void {
  expect(() => flushRetried(file)).toThrow(new DirectiveCheckpointError(reason));
  finishTurn(file);
  expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'unknown' });
}

describe('Pi retry history (#483)', () => {
  it('a retry-start receipt for a signed text/thinking error row lets the retried tool call run, and the checkpoint walks past the row', () => {
    const { file, producer, error } = retryScene();
    expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBeNull();
    expect(journal(file)).toContain(JSON.stringify({ state: 'retry-start', producer, entryId: 'retry-error', errorMessage: ERROR }));
    expect(() => flushRetried(file)).not.toThrow();
    entry(file, 'result', 'invocation', result);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'resumable', checkpointId: 'result' });
    entry(file, 'answer', 'result', answer);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, error: null, checkpointId: 'answer' });
  });

  it('an abandoned retry ends the turn on its receipted error row: terminal, not ok, with that error', () => {
    const { file, producer, error } = retryScene();
    expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBeNull();
    // Cancelled during backoff: auto_retry_end {success:false}, and nothing follows the row.
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: false, error: ERROR, checkpointId: 'retry-error' });
  });

  it('retry evidence is recorded on the directive\'s first request, before its admission is read back', () => {
    const { file, producer, error } = retryScene(signedContent, false);
    expect(readDirectiveBinding(file, identity.requestId)?.userEntryId).toBeNull();
    expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBeNull();
    expect(() => flushRetried(file)).not.toThrow();
    finishTurn(file);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('retry evidence is recorded for a fractional SDK backoff delay', () => {
    const { file, producer, error } = retryScene();
    expect(recordDirectiveRetryStart(producer, retryEvent({ delayMs: 0.5 }), error)).toBeNull();
    expect(() => flushRetried(file)).not.toThrow();
  });

  it('retry evidence is recorded only from an auto_retry_start naming an effect-free error tail, once per producer and row', () => {
    const { file, producer, error } = retryScene();
    const before = journal(file);
    const refused = [
      [{ type: 'agent_end', willRetry: false, errorMessage: ERROR }, error, 'not an SDK auto_retry_start event'],
      [retryEvent({ attempt: 0 }), error, 'malformed SDK auto_retry_start event'],
      [retryEvent({ attempt: 4 }), error, 'malformed SDK auto_retry_start event'],
      [retryEvent({ delayMs: -1 }), error, 'malformed SDK auto_retry_start event'],
      [retryEvent({ delayMs: Number.POSITIVE_INFINITY }), error, 'malformed SDK auto_retry_start event'],
      [retryEvent({ errorMessage: ' ' }), error, 'malformed SDK auto_retry_start event'],
      [retryEvent({ errorMessage: 'HTTP 503 service unavailable' }), error, TAIL],
      [retryEvent(), { ...error, message: { ...error.message, stopReason: 'aborted' } }, TAIL],
      [retryEvent(), { ...error, message: errorMessage([...signedContent, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]) }, TAIL],
      [retryEvent(), { ...error, type: 'custom' }, TAIL],
    ] as const;
    for (const [event, tail, reason] of refused) expect(recordDirectiveRetryStart(producer, event, tail), reason).toBe(reason);
    expect(journal(file)).toBe(before);
    expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBeNull();
    expect(recordDirectiveRetryStart(producer, retryEvent({ attempt: 2, delayMs: 4000 }), error)).toBeNull();
    expect(journal(file).slice(before.length).trimEnd().split('\n')).toHaveLength(1);
  });

  it('a retry-start receipt naming another error message for the row is refused', () => {
    const { file, producer, error } = retryScene();
    const other = 'HTTP 503 service unavailable';
    // The live tail carried the other error; the persisted row does not.
    expect(recordDirectiveRetryStart(producer, retryEvent({ errorMessage: other }), { ...error, message: errorMessage(signedContent, other) })).toBeNull();
    expectRetryHistoryRefused(file);
  });

  it('a retry-start receipt for a different error row is refused', () => {
    const { file, producer, error } = retryScene();
    expect(recordDirectiveRetryStart(producer, retryEvent(), { ...error, id: 'another-error' })).toBeNull();
    expectRetryHistoryRefused(file);
  });

  it('a retry-start receipt from another directive request in the same session is refused', () => {
    const { file, error } = retryScene();
    const other = { ...identity, requestId: 'another-request', payloadHash: 'b'.repeat(64) };
    prepareDirectiveBinding({ identity: other, runtime: 'pi', agentId: 'minion', sessionId: 'pi-session', sessionFile: file, text, authorityManifest: 'manifest' });
    expect(recordDirectiveRetryStart(producerFor(file, other), retryEvent(), error)).toBeNull();
    expectRetryHistoryRefused(file);
  });

  it('a retry-start receipt from a producer of another identity for the same request is refused', () => {
    const { file, error } = retryScene();
    const stale = producerFor(file, { ...identity, authorityEpoch: 1 });
    expect(recordDirectiveRetryStart(stale, retryEvent(), error)).toBe('exact pi directive association unavailable');
    appendReceipt(file, { state: 'retry-start', producer: stale, entryId: 'retry-error', errorMessage: ERROR });
    expectRetryHistoryRefused(file);
  });

  it('a receipted error row holding a partial tool call is retry history once the retried answer follows (owner ruling 2026-10-22)', () => {
    const { file, producer, error } = retryScene([signedContent[1], partialCall]);
    expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBeNull();
    expect(() => flushRetried(file)).not.toThrow();
    finishTurn(file);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a result naming a retried error row\'s never-run tool call is refused', () => {
    const { file, producer, error } = retryScene([signedContent[1], partialCall]);
    expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBeNull();
    entry(file, 'invocation', 'retry-error', invocation);
    entry(file, 'partial-result', 'invocation', { ...result, toolCallId: partialCall.id });
    expect(() => flushDirectiveToolIntent(file, invocation, call, identity)).toThrow(
      new DirectiveCheckpointError('native tool intent is not persisted before execution or its invocation/results changed'));
    expect(inspectDirectiveCheckpoint(file, identity)).toEqual({ state: 'unknown', reason: 'unmatched/malformed native tool result' });
  });

  it('a retry-start receipt cannot make an error row with unknown or malformed content retry history', () => {
    const refused = [
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'Checking the failing test', annotations: [] },
      { type: 'text', text: 'Checking the failing test', textSignature: { v: 1, id: 'msg_1' } },
    ];
    for (const block of refused) {
      const { file, producer, error } = retryScene([signedContent[0], block]);
      expect(recordDirectiveRetryStart(producer, retryEvent(), error), JSON.stringify(block)).toBe(TAIL);
      appendReceipt(file, { state: 'retry-start', producer, entryId: 'retry-error', errorMessage: ERROR });
      expectRetryHistoryRefused(file, NOT_HISTORY);
    }
  });

  it('two consecutive retried error rows are both history, and the turn completes past them', () => {
    const { file, producer, error } = retryScene();
    const second = 'HTTP 503 service unavailable';
    expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBeNull();
    const again = entry(file, 'retry-error-2', 'retry-error', errorMessage([], second));
    expect(recordDirectiveRetryStart(producer, retryEvent({ attempt: 2, delayMs: 4000, errorMessage: second }), again)).toBeNull();
    expect(journal(file).match(/"state":"retry-start"/gu)).toHaveLength(2);
    expect(() => flushRetried(file, 'retry-error-2')).not.toThrow();
    finishTurn(file);
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: true, checkpointId: 'answer' });
  });

  it('a retry whose attempts ran out ends the turn on the final unreceipted error row: terminal, not ok', () => {
    const { file, producer, error } = retryScene();
    const last = 'HTTP 503 service unavailable';
    expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBeNull();
    // auto_retry_end {success:false}: the final error has no retry-start.
    entry(file, 'final-error', 'retry-error', errorMessage([], last));
    expect(inspectDirectiveCheckpoint(file, identity)).toMatchObject({ state: 'terminal', ok: false, error: last, checkpointId: 'final-error' });
  });

  it('an abandoned receipted retry row followed by a later bound request or control is the earlier turn\'s terminal, not ok', () => {
    const later: DirectiveTurnIdentity = { ...identity, requestId: 'later-request', payloadHash: 'b'.repeat(64) };
    for (const control of [false, true]) {
      const { file, producer, error } = retryScene();
      expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBeNull();
      let baseline = 'retry-error';
      if (control) {
        appendFileSync(file, `${JSON.stringify({ type: 'model_change', id: 'switch-model', parentId: baseline, provider: 'openai', modelId: 'gpt-next' })}\n`);
        baseline = 'switch-model';
      }
      prepareDirectiveBinding({ identity: later, runtime: 'pi', agentId: 'minion', sessionId: 'pi-session', sessionFile: file, text: 'a later directive', authorityManifest: 'manifest' });
      entry(file, 'later-receipt', baseline, { role: 'user', content: [{ type: 'text', text: 'a later directive' }] });
      expect(inspectDirectiveAdmission(file, later).userEntryId).toBe('later-receipt');
      expect(inspectDirectiveCheckpoint(file, identity), `control: ${String(control)}`).toMatchObject({ state: 'terminal', ok: false, error: ERROR, checkpointId: 'retry-error' });
    }
  });

  it('conflicting retry-start receipts for one error row are never trusted', () => {
    const { file, producer, error } = retryScene();
    appendReceipt(file, { state: 'retry-start', producer, entryId: 'retry-error', errorMessage: 'HTTP 503 service unavailable' });
    expect(recordDirectiveRetryStart(producer, retryEvent(), error)).toBe('conflicting retry-start receipt for this error row');
    appendReceipt(file, { state: 'retry-start', producer, entryId: 'retry-error', errorMessage: ERROR });
    expect(() => inspectDirectiveCheckpoint(file, identity)).toThrow(new DirectiveCheckpointError('conflicting native retry-start receipts for one error row'));
    expect(() => flushRetried(file)).toThrow(new DirectiveCheckpointError('conflicting native retry-start receipts for one error row'));
  });

  it('a malformed retry-start receipt fails the producer journal read loudly', () => {
    const malformed = [
      [{ errorMessage: ERROR }, 'malformed native retry-start receipt'],
      [{ entryId: '', errorMessage: ERROR }, 'malformed native retry-start receipt'],
      [{ entryId: ' ', errorMessage: ERROR }, 'malformed native retry-start receipt'],
      [{ entryId: 7, errorMessage: ERROR }, 'malformed native retry-start receipt'],
      [{ entryId: 'retry-error' }, 'malformed native retry-start receipt'],
      [{ entryId: 'retry-error', errorMessage: ' ' }, 'malformed native retry-start receipt'],
      [{ entryId: 'retry-error', errorMessage: { message: ERROR } }, 'malformed native retry-start receipt'],
    ] as const;
    for (const [fields, message] of malformed) {
      const { file, producer, error } = retryScene();
      appendReceipt(file, { state: 'retry-start', producer, ...fields });
      expect(() => inspectDirectiveCheckpoint(file, identity), JSON.stringify(fields)).toThrow(new DirectiveCheckpointError(message));
      expect(() => recordDirectiveRetryStart(producer, retryEvent(), error), JSON.stringify(fields)).toThrow(new DirectiveCheckpointError(message));
    }
    // A receipt binds the exact started physical producer, never an unstarted one.
    const { file, producer } = retryScene();
    appendReceipt(file, { state: 'retry-start', producer: { ...producer, incarnation: 'never-started' }, entryId: 'retry-error', errorMessage: ERROR });
    expect(() => inspectDirectiveCheckpoint(file, identity)).toThrow(new DirectiveCheckpointError('native cessation does not bind its physical incarnation'));
  });
});
