import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname } from 'node:path';
import { withSessionLockCoordination } from '../sessions/lock-coordination.js';

/** Accepted authority, not a prompt or a claim lease. */
export interface DirectiveTurnIdentity {
  readonly requestId: string;
  readonly payloadHash: string;
  readonly jobId: string;
  readonly workRevision: number;
  readonly contractSha256: string;
  readonly authorityEpoch: number;
}
export interface DirectiveNativeBinding {
  readonly identity: DirectiveTurnIdentity;
  readonly runtime: 'pi' | 'claude-code';
  readonly agentId: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly baseline: string | null;
  readonly promptHash: string;
  readonly userEntryId: string | null;
  readonly authorityManifest: string;
}
export type DirectiveCheckpoint =
  | { readonly state: 'unknown'; readonly reason: string }
  | { readonly state: 'resumable'; readonly binding: DirectiveNativeBinding; readonly checkpointId: string }
  | { readonly state: 'terminal'; readonly binding: DirectiveNativeBinding; readonly checkpointId: string; readonly ok: boolean; readonly error: string | null };
export class DirectiveCheckpointError extends Error {
  constructor(message: string) { super(message); this.name = 'DirectiveCheckpointError'; }
}
/** Bounds a directive's own turn (#469), never the session before it. */
const MAX_NATIVE_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_NATIVE_TRANSCRIPT_ENTRIES = 250_000;
const MAX_NATIVE_HEADER_BYTES = 64 * 1024;
const MAX_DIRECTIVE_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTIVE_JOURNAL_ENTRIES = 100_000;
const MAX_NATIVE_LOCK_BYTES = 4 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
// Fatal decoding (#363 S04-1-02): a lenient decode turns invalid bytes into
// U+FFFD, so corrupted evidence could hash like a genuine prompt. ignoreBOM
// keeps a leading U+FEFF, exactly as the lenient decode did.
function utf8Decoder() { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); }
function decodeEvidence(bytes: Uint8Array, label: string, decoder = utf8Decoder()): string {
  try { return decoder.decode(bytes); }
  catch { throw new DirectiveCheckpointError(`${label} is not valid UTF-8; corrupted bytes are never evidence`); }
}
/** Refuses anything but a regular file before its first read: a FIFO blocks. */
function openRegularFile(path: string, label: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new DirectiveCheckpointError(`${label} is not a regular file; bounded inspection requires durable file evidence`);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
/** Bytes from `offset` to the end, refused past `limit` before and while
 * reading. The file must still end exactly where the read did. */
function readBoundedBytes(fd: number, offset: number, limit: number, label: string): Buffer {
  if (fstatSync(fd).size - offset > limit) throw new DirectiveCheckpointError(`${label} exceeds the ${limit}-byte inspection limit`);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1 - total));
    const count = readSync(fd, chunk, 0, chunk.length, offset + total);
    if (count === 0) break;
    total += count;
    if (total > limit) throw new DirectiveCheckpointError(`${label} exceeds the ${limit}-byte inspection limit`);
    chunks.push(chunk.subarray(0, count));
  }
  if (fstatSync(fd).size !== offset + total) throw new DirectiveCheckpointError(`${label} changed during bounded inspection`);
  return Buffer.concat(chunks, total);
}
function readBoundedUtf8(path: string, limit: number, label: string): string {
  const fd = openRegularFile(path, label);
  try { return decodeEvidence(readBoundedBytes(fd, 0, limit, label), label); } finally { closeSync(fd); }
}
function assertEntryLimit(text: string, limit: number, label: string): void {
  let entries = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    entries += 1;
    if (entries > limit) throw new DirectiveCheckpointError(`${label} exceeds the entry inspection limit`);
  }
  if (text !== '' && !text.endsWith('\n') && ++entries > limit) {
    throw new DirectiveCheckpointError(`${label} exceeds the entry inspection limit`);
  }
}
export function validateDirectiveIdentity(identity: DirectiveTurnIdentity): void {
  if (!identity || [identity.requestId, identity.jobId].some((value) => typeof value !== 'string' || value.trim() === '') ||
      ![identity.payloadHash, identity.contractSha256].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) ||
      ![identity.workRevision, identity.authorityEpoch].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new DirectiveCheckpointError('directive checkpoint requires exact request/hash/job/revision/authority epoch');
  }
}
function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
interface NativeEntry {
  readonly type: string;
  readonly id: string;
  readonly parentId?: string | null;
  readonly message?: Record<string, unknown>;
  readonly provider?: unknown;
  readonly modelId?: unknown;
  readonly thinkingLevel?: unknown;
}
/*
 * Native transcripts grow for a session's whole life (#469), so inspection
 * never holds one whole. The header is read as its first line; the session
 * before a directive is streamed one bounded line at a time (pi) or hashed
 * (Claude); only the directive's own turn after its baseline is held, within
 * the transcript byte and entry limits.
 */
function withNativeTranscript<T>(file: string, inspect: (fd: number) => T): T {
  const fd = openRegularFile(file, 'native transcript');
  try { return inspect(fd); } finally { closeSync(fd); }
}
/** The first line only, never the session after it. */
function nativeHeaderLine(fd: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_NATIVE_HEADER_BYTES + 1 - total));
    const count = readSync(fd, chunk, 0, chunk.length, total);
    if (count === 0) throw new DirectiveCheckpointError('native transcript has no complete session header');
    const end = chunk.subarray(0, count).indexOf(10);
    chunks.push(chunk.subarray(0, end < 0 ? count : end));
    total += end < 0 ? count : end;
    if (end >= 0) return decodeEvidence(Buffer.concat(chunks, total), 'native transcript');
    if (total > MAX_NATIVE_HEADER_BYTES) throw new DirectiveCheckpointError(`native session header exceeds the ${MAX_NATIVE_HEADER_BYTES}-byte inspection limit`);
  }
}
/** The directive's own turn: every byte after `offset`, within the limits. */
function nativeTurnText(fd: number, offset: number): string {
  const text = decodeEvidence(readBoundedBytes(fd, offset, MAX_NATIVE_TRANSCRIPT_BYTES, 'native directive turn'), 'native transcript');
  assertEntryLimit(text, MAX_NATIVE_TRANSCRIPT_ENTRIES, 'native directive turn');
  return text;
}
/** Streams complete lines from the start, each bounded and fatally decoded,
 * until `visit` returns true. `end` is the offset after the line that stopped
 * the scan, null when the transcript ended first (`partial`: on a torn line). */
function scanNativeLines(fd: number, visit: (line: string) => boolean): { readonly end: number | null; readonly partial: boolean } {
  const decoder = utf8Decoder();
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let position = 0;
  const oversized = (): never => { throw new DirectiveCheckpointError(`native transcript entry exceeds the ${MAX_NATIVE_TRANSCRIPT_BYTES}-byte inspection limit`); };
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, position);
    if (count === 0) {
      if (fstatSync(fd).size !== position) throw new DirectiveCheckpointError('native transcript changed during bounded inspection');
      return { end: null, partial: pendingBytes > 0 };
    }
    const chunk = buffer.subarray(0, count);
    let start = 0;
    for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, newline);
      if (pendingBytes + piece.length > MAX_NATIVE_TRANSCRIPT_BYTES) oversized();
      const line = decodeEvidence(pending.length === 0 ? piece : Buffer.concat([...pending.splice(0), piece], pendingBytes + piece.length), 'native transcript', decoder);
      pendingBytes = 0;
      start = newline + 1;
      if (visit(line)) return { end: position + start, partial: false };
    }
    if (start < count) {
      pendingBytes += count - start;
      if (pendingBytes > MAX_NATIVE_TRANSCRIPT_BYTES) oversized();
      pending.push(Buffer.from(chunk.subarray(start))); // the read buffer is reused
    }
    position += count;
  }
}
/** A pi transcript split after its `baseline` entry (after the header when
 * null). Entries up to the split are kept only as their ids. */
interface PiTranscript {
  readonly header: NativeEntry | null;
  /** Every id through the baseline, the header's included. */
  readonly ids: ReadonlySet<string>;
  /** An entry through the baseline has no unique, non-empty id. */
  readonly malformed: boolean;
  /** The directive's own turn as complete lines; null without the baseline. */
  readonly turn: readonly string[] | null;
}
/** `accepted` drops a torn final line (a partial tail cannot undo an
 * accepted prefix); `whole` refuses it. */
function piTranscript(file: string, baseline: string | null, tail: 'whole' | 'accepted'): PiTranscript {
  return withNativeTranscript(file, (fd) => {
    let header = undefined as NativeEntry | null | undefined;
    let malformed = false as boolean;
    const ids = new Set<string>();
    const scan = scanNativeLines(fd, (line) => {
      const entry = JSON.parse(line) as NativeEntry | null;
      if (header === undefined) {
        header = entry;
        if (typeof entry?.id === 'string') ids.add(entry.id);
        return baseline === null;
      }
      if (!entry || typeof entry.id !== 'string' || entry.id === '' || ids.has(entry.id)) { malformed = true; return false; }
      ids.add(entry.id);
      return entry.id === baseline;
    });
    const partial = (): never => { throw new DirectiveCheckpointError('native transcript has a partial entry'); };
    if (scan.end === null) {
      if (scan.partial && tail === 'whole') partial();
      return { header: header ?? null, ids, malformed, turn: null };
    }
    const text = nativeTurnText(fd, scan.end);
    if (tail === 'whole' && text !== '' && !text.endsWith('\n')) partial();
    const turn = text.split('\n');
    turn.pop();
    return { header: header ?? null, ids, malformed, turn };
  });
}
/** Header facts come from the first line alone. They identify a session/cwd,
 * never admission, completion or work authority. */
export function readDirectiveSessionHeader(file: string): { readonly type?: unknown; readonly id?: unknown; readonly cwd?: unknown } {
  const header = JSON.parse(withNativeTranscript(file, nativeHeaderLine)) as unknown;
  if (typeof header !== 'object' || header === null) throw new DirectiveCheckpointError('native session header is malformed');
  return header;
}
function contentHash(content: unknown): string { return createHash('sha256').update(JSON.stringify(content)).digest('hex'); }
function proofPath(file: string): string { return `${file}.directives.jsonl`; }
function appendBinding(binding: DirectiveNativeBinding): void {
  const fd = openSync(proofPath(binding.sessionFile), 'a', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(binding)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  syncFile(dirname(binding.sessionFile));
}
/** Persist an exact association BEFORE native I/O. It proves intent only;
 * inspection needs the actual native user entry, never spawn/turn-start. */
export function prepareDirectiveBinding(input: {
  readonly identity: DirectiveTurnIdentity; readonly runtime: DirectiveNativeBinding['runtime'];
  readonly agentId: string; readonly sessionId: string; readonly sessionFile: string;
  readonly text: string; readonly authorityManifest?: string; readonly images?: readonly { readonly mediaType: string; readonly data: string }[];
}): DirectiveNativeBinding {
  validateDirectiveIdentity(input.identity);
  if (!input.authorityManifest) throw new DirectiveCheckpointError('directive requires a bound native role/cwd/tool/model authority manifest');
  const prior = readDirectiveBinding(input.sessionFile, input.identity.requestId);
  if (prior !== null) throw new DirectiveCheckpointError(`request ${input.identity.requestId} already has native association — inspect it; never replay`);
  // The baseline is the last entry: the whole session streams past, one line at a time.
  const baseline = withNativeTranscript(input.sessionFile, (fd) => {
    let last = null as string | null;
    const scan = scanNativeLines(fd, (line) => {
      const entry = JSON.parse(line) as NativeEntry;
      if (entry.type !== 'session') last = entry.id ?? null;
      return false;
    });
    if (scan.partial) throw new DirectiveCheckpointError('native transcript has a partial entry');
    return last;
  });
  const content = [ { type: 'text', text: input.text },
    ...(input.images ?? []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mediaType })) ];
  const binding: DirectiveNativeBinding = { identity: input.identity, runtime: input.runtime, agentId: input.agentId,
    sessionId: input.sessionId, sessionFile: input.sessionFile, baseline,
    promptHash: contentHash(content), userEntryId: null, authorityManifest: input.authorityManifest };
  appendBinding(binding);
  return binding;
}
function readDirectiveBindings(file: string): readonly DirectiveNativeBinding[] {
  let raw: string;
  try { raw = readBoundedUtf8(proofPath(file), MAX_DIRECTIVE_JOURNAL_BYTES, 'directive native association'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!raw.endsWith('\n')) throw new DirectiveCheckpointError('directive native association has a partial write');
  assertEntryLimit(raw, MAX_DIRECTIVE_JOURNAL_ENTRIES, 'directive native association');
  const rows = raw.trimEnd().split('\n').map((line) => JSON.parse(line) as DirectiveNativeBinding);
  const latest = new Map<string, DirectiveNativeBinding>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) throw new DirectiveCheckpointError('directive native association is malformed');
    validateDirectiveIdentity(row.identity);
    if (row.sessionFile !== file || !['pi', 'claude-code'].includes(row.runtime) ||
        [row.agentId, row.sessionId, row.authorityManifest].some((value) => typeof value !== 'string' || value.trim() === '') ||
        typeof row.promptHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.promptHash) ||
        !(row.baseline === null || typeof row.baseline === 'string' && row.baseline !== '') ||
        !(row.userEntryId === null || typeof row.userEntryId === 'string' && row.userEntryId !== '')) {
      throw new DirectiveCheckpointError('directive native association is malformed');
    }
    const prior = latest.get(row.identity.requestId);
    if (prior !== undefined && (!isDeepStrictEqual({ ...prior, userEntryId: null }, { ...row, userEntryId: null }) ||
        prior.userEntryId !== null && prior.userEntryId !== row.userEntryId)) {
      throw new DirectiveCheckpointError('conflicting native request associations');
    }
    latest.set(row.identity.requestId, row);
  }
  return [...latest.values()];
}
export function readDirectiveBinding(file: string, requestId: string): DirectiveNativeBinding | null {
  return readDirectiveBindings(file).find((row) => row.identity.requestId === requestId) ?? null;
}
function hasLaterBoundRequest(file: string, native: readonly NativeEntry[], identity: DirectiveTurnIdentity, checkpointId: string): boolean {
  try {
    const checkpointIndex = native.findIndex((entry) => entry.id === checkpointId);
    if (checkpointIndex < 0) return false;
    let baseline = checkpointId;
    let nextIndex = checkpointIndex + 1;
    // These controls change the NEXT request's model, not the completed
    // request's ancestry. No branch, compaction or unbound effect is skipped.
    while (native[nextIndex]?.type === 'model_change' || native[nextIndex]?.type === 'thinking_level_change') {
      const control = native[nextIndex]!;
      if (control.parentId !== baseline || control.type === 'model_change' &&
          (typeof control.provider !== 'string' || !control.provider.trim() || typeof control.modelId !== 'string' || !control.modelId.trim()) ||
          control.type === 'thinking_level_change' && (typeof control.thinkingLevel !== 'string' ||
            !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(control.thinkingLevel))) return false;
      baseline = control.id;
      nextIndex += 1;
    }
    const immediate = native[nextIndex];
    if (immediate?.type !== 'message' || immediate.message?.role !== 'user' || immediate.parentId !== baseline || !Array.isArray(immediate.message.content)) return false;
    const hash = contentHash(immediate.message.content);
    const matching = readDirectiveBindings(file).filter((candidate) => candidate.identity.requestId !== identity.requestId &&
      candidate.identity.jobId === identity.jobId && candidate.baseline === baseline && candidate.promptHash === hash &&
      (candidate.userEntryId === null || candidate.userEntryId === immediate.id));
    const named = matching.filter((candidate) => candidate.userEntryId === immediate.id);
    // Prefer the real published native association. Without one, only a
    // unique exact preparation can be read back; identical rejected/later
    // preparations are ambiguous, never fabricated into another admission.
    const candidate = named.length === 1 ? named[0] : named.length === 0 && matching.length === 1 ? matching[0] : undefined;
    if (candidate === undefined) return false;
    const admitted = inspectDirectiveAdmission(file, candidate.identity);
    return admitted.userEntryId === immediate.id && isDeepStrictEqual(admitted, { ...candidate, userEntryId: immediate.id });
  } catch { return false; }
}
/** Admission is a prefix fact, independent of later unfinished/unknown effects.
 * Read only through the exact user receipt, never infer admission from a shape. */
export function inspectDirectiveAdmission(file: string, identity: DirectiveTurnIdentity): DirectiveNativeBinding {
  validateDirectiveIdentity(identity);
  const binding = readDirectiveBinding(file, identity.requestId);
  if (binding === null || !isDeepStrictEqual(binding.identity, identity)) throw new DirectiveCheckpointError('exact native admission association unavailable');
  if (binding.runtime === 'claude-code') return inspectClaudeDirectiveAdmission(file, binding);
  if (binding.runtime !== 'pi') throw new DirectiveCheckpointError('exact native admission association unavailable');
  const native = piTranscript(file, binding.baseline, 'accepted');
  const header = native.header;
  if (header?.type !== 'session' || header.id !== binding.sessionId) throw new DirectiveCheckpointError('native admission session identity mismatch');
  if (native.malformed) throw new DirectiveCheckpointError('malformed/rebound native admission prefix');
  const line = native.turn?.[0];
  if (line === undefined) throw new DirectiveCheckpointError('actual native admission user receipt unavailable');
  const entry = JSON.parse(line) as NativeEntry;
  if (!entry || typeof entry.id !== 'string' || !entry.id || native.ids.has(entry.id)) throw new DirectiveCheckpointError('malformed/rebound native admission prefix');
  if (entry.type !== 'message' || entry.message?.role !== 'user' || entry.parentId !== binding.baseline || !Array.isArray(entry.message.content) ||
      contentHash(entry.message.content) !== binding.promptHash || binding.userEntryId !== null && binding.userEntryId !== entry.id) {
    throw new DirectiveCheckpointError('actual native admission user receipt unavailable/changed');
  }
  syncFile(file);
  const admitted = { ...binding, userEntryId: entry.id };
  if (binding.userEntryId === null) appendBinding(admitted);
  return admitted;
}

/** Native transcript readback owns proof. Pi entries are tree-linked: only
 * the exact direct user child of the prepared baseline is admitted. A
 * missing result, branch/compaction or another prompt refuses continuation. */
export function inspectDirectiveCheckpoint(file: string, identity: DirectiveTurnIdentity): DirectiveCheckpoint {
  validateDirectiveIdentity(identity);
  const binding = readDirectiveBinding(file, identity.requestId);
  const unknown = (reason: string): DirectiveCheckpoint => ({ state: 'unknown', reason });
  if (binding === null || !isDeepStrictEqual(binding.identity, identity)) return unknown('exact native request association unavailable');
  if (binding.runtime === 'claude-code') return inspectClaudeDirectiveCheckpoint(file, binding);
  if (binding.runtime !== 'pi') return unknown('exact native request association unavailable');
  const transcript = piTranscript(file, binding.baseline, 'whole');
  // The directive's own turn: its receipt first, then everything after it.
  const native = (transcript.turn ?? []).map((line) => JSON.parse(line) as NativeEntry);
  const header = transcript.header;
  if (header?.type !== 'session' || header.id !== binding.sessionId) return unknown('native session identity mismatch');
  if (transcript.malformed) return unknown('native checkpoint has a malformed or duplicate entry identity');
  const ids = new Set<string>();
  for (const entry of native) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '' || transcript.ids.has(entry.id) || ids.has(entry.id)) return unknown('native checkpoint has a malformed or duplicate entry identity');
    ids.add(entry.id);
  }
  if (transcript.turn === null) return unknown('native baseline unavailable');
  const user = native[0];
  if (user?.type !== 'message' || user.message?.role !== 'user' || user.parentId !== binding.baseline ||
      contentHash(user.message.content) !== binding.promptHash || !user.id) return unknown('actual native request receipt unavailable');
  if (binding.userEntryId !== null && user.id !== binding.userEntryId) return unknown('native request receipt changed');
  // The native receipt is durably flushed before the product admission callback.
  syncFile(file);
  const admitted = { ...binding, userEntryId: user.id };
  if (binding.userEntryId === null) appendBinding(admitted);
  if (producerReceipts(file).some((row) => row.state === 'guard-refused' && isDeepStrictEqual(row.producer.identity, identity))) return unknown('native directive execution/authority boundary refused; exact turn remains incomplete');
  let parent = user.id;
  const pending = new Map<string, string>();
  let lastMessage = user.message;
  let terminal = false;
  for (const entry of native.slice(1)) {
    if (terminal) {
      // A later user entry is not part of this completed turn when its own
      // distinct, durably read-back admission binds it. Keep the earlier
      // checkpoint readable without treating an unbound/replayed user tail
      // as proof that the old request completed.
      if (hasLaterBoundRequest(file, native, identity, parent)) {
        const ok = lastMessage.stopReason === 'stop';
        return { state: 'terminal', binding: admitted, checkpointId: parent, ok,
          error: ok ? null : String(lastMessage.errorMessage ?? `native stopReason: ${String(lastMessage.stopReason)}`) };
      }
      return unknown('native entries follow the correlated terminal checkpoint without a distinct bound request');
    }
    if (entry.type !== 'message' || entry.parentId !== parent || !entry.id || entry.message === undefined) return unknown('native branch/control/partial checkpoint');
    parent = entry.id;
    const message = entry.message;
    if (message.role === 'assistant') {
      if (pending.size > 0) return unknown('assistant advanced without complete native tool results');
      if (!Array.isArray(message.content)) return unknown('malformed native assistant');
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type !== 'toolCall') continue;
        if (message.stopReason !== 'toolUse' || typeof block.id !== 'string' || block.id === '' || typeof block.name !== 'string' || typeof block.arguments !== 'object' || block.arguments === null || pending.has(block.id)) return unknown('malformed native tool identity');
        pending.set(block.id, block.name);
      }
      if (pending.size === 0) {
        if (!['stop', 'error', 'aborted', 'length'].includes(String(message.stopReason))) return unknown('malformed native assistant terminal');
        terminal = true;
      }
    } else if (message.role === 'toolResult') {
      if (typeof message.toolCallId !== 'string' || !pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName || typeof message.isError !== 'boolean') return unknown('unmatched/malformed native tool result');
      pending.delete(message.toolCallId);
      if (!Array.isArray(message.content) || typeof message.toolName !== 'string') return unknown('malformed native tool result content/name');
      if (message.isError) return unknown('native tool error requires a recovery judgment');
    } else return unknown('another user/custom message owns this session');
    lastMessage = message;
  }
  if (pending.size > 0) return unknown('native tool effects/results are incomplete');
  if (lastMessage.role === 'assistant') {
    const ok = lastMessage.stopReason === 'stop';
    return { state: 'terminal', binding: admitted, checkpointId: parent, ok,
      error: ok ? null : String(lastMessage.errorMessage ?? `native stopReason: ${String(lastMessage.stopReason)}`) };
  }
  return { state: 'resumable', binding: admitted, checkpointId: parent };
}

/**
 * Claude Code (#424, owner ruling 2026-10-16: exact proof, never resume).
 * The claude-code adapter runs one CLI process per turn and appends every
 * stdout frame to the product transcript, which starts with a GC session
 * header (`type: 'session'`, the CLI session id, the cwd). A directive turn
 * runs with `--replay-user-messages`: the CLI's own echo of the prompt
 * (`type: 'user'`, `isReplay: true`, its `uuid`) is the admission receipt.
 * The binding records the transcript's exact byte prefix before the turn;
 * everything the turn did follows it. A Claude checkpoint is terminal (the
 * turn's `result` frame) or unknown, never resumable: an interrupted Claude
 * directive is never continued or replayed.
 */
const CLAUDE_BASELINE = /^prefix:(0|[1-9][0-9]*):([a-f0-9]{64})$/;

/** The exact prefix a new Claude directive binds: the whole transcript,
 * hashed and fatally decoded as it streams past, ending on a complete frame. */
function claudeTranscriptPrefix(fd: number): string {
  const hash = createHash('sha256');
  const decoder = utf8Decoder();
  const validate = (bytes?: Uint8Array): void => {
    try { decoder.decode(bytes, { stream: bytes !== undefined }); }
    catch { throw new DirectiveCheckpointError('native transcript is not valid UTF-8; corrupted bytes are never evidence'); }
  };
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let length = 0;
  let last = -1;
  for (let count = readSync(fd, chunk, 0, chunk.length, 0); count > 0; count = readSync(fd, chunk, 0, chunk.length, length)) {
    const bytes = chunk.subarray(0, count);
    validate(bytes);
    hash.update(bytes);
    length += count;
    last = bytes[count - 1]!;
  }
  validate();
  if (fstatSync(fd).size !== length) throw new DirectiveCheckpointError('native transcript changed during bounded inspection');
  if (last !== 10) throw new DirectiveCheckpointError('native transcript has a partial entry');
  return `prefix:${String(length)}:${hash.digest('hex')}`;
}

/** sha256 of the first `length` bytes, streamed; null when the transcript is shorter. */
function nativePrefixHash(fd: number, length: number): string | null {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  for (let position = 0; position < length;) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, length - position), position);
    if (count === 0) return null;
    hash.update(chunk.subarray(0, count));
    position += count;
  }
  return hash.digest('hex');
}

function claudeHeader(line: string, sessionId: string): void {
  let header: unknown = null;
  try { header = JSON.parse(line) as unknown; } catch { header = null; }
  const record = typeof header === 'object' && header !== null ? header as Record<string, unknown> : null;
  if (record?.['type'] !== 'session' || record['id'] !== sessionId || record['runtime'] !== 'claude-code' || typeof record['cwd'] !== 'string') {
    throw new DirectiveCheckpointError('claude-code transcript has no exact GC session header for this session');
  }
}

/** Persist an exact Claude association BEFORE the CLI is spawned. `content` is
 * the exact user message content the adapter sends on stdin. */
export function prepareClaudeDirectiveBinding(input: {
  readonly identity: DirectiveTurnIdentity; readonly agentId: string; readonly sessionId: string; readonly sessionFile: string;
  readonly content: readonly unknown[]; readonly authorityManifest?: string;
}): DirectiveNativeBinding {
  validateDirectiveIdentity(input.identity);
  if (!input.authorityManifest) throw new DirectiveCheckpointError('directive requires a bound native role/cwd/tool/model authority manifest');
  if (readDirectiveBinding(input.sessionFile, input.identity.requestId) !== null) {
    throw new DirectiveCheckpointError(`request ${input.identity.requestId} already has native association — inspect it; never replay`);
  }
  const baseline = withNativeTranscript(input.sessionFile, (fd) => {
    const prefix = claudeTranscriptPrefix(fd);
    claudeHeader(nativeHeaderLine(fd), input.sessionId);
    return prefix;
  });
  const binding: DirectiveNativeBinding = { identity: input.identity, runtime: 'claude-code', agentId: input.agentId, sessionId: input.sessionId,
    sessionFile: input.sessionFile, baseline, promptHash: contentHash(input.content), userEntryId: null,
    authorityManifest: input.authorityManifest };
  appendBinding(binding);
  return binding;
}

type ClaudeFrame = Record<string, unknown>;

/** The frames the bound turn appended after its exact recorded prefix, and
 * the index of its admission echo (or a reason there is none). A partial
 * tail cannot undo an accepted prefix. */
function claudeTurn(file: string, binding: DirectiveNativeBinding): { readonly frames: readonly ClaudeFrame[]; readonly echo: number } | { readonly refused: string } {
  const prefix = CLAUDE_BASELINE.exec(binding.baseline ?? '');
  if (prefix === null) return { refused: 'claude-code association has no exact transcript prefix' };
  const length = Number(prefix[1]);
  // The prefix is hashed as it streams; only the turn after it is held.
  const read = withNativeTranscript(file, (fd): { readonly text: string } | { readonly refused: string } => {
    if (nativePrefixHash(fd, length) !== prefix[2]) return { refused: 'the native transcript before the directive changed' };
    const text = nativeTurnText(fd, length);
    try { claudeHeader(nativeHeaderLine(fd), binding.sessionId); }
    catch (error) {
      if (!(error instanceof DirectiveCheckpointError)) throw error;
      return { refused: error.message };
    }
    return { text };
  });
  if ('refused' in read) return read;
  const lines = read.text.split('\n');
  lines.pop(); // a partial tail cannot undo an accepted prefix
  const frames: ClaudeFrame[] = [];
  for (const line of lines) {
    let frame: unknown;
    try { frame = JSON.parse(line) as unknown; } catch { return { refused: 'malformed native frame after the directive prefix' }; }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return { refused: 'malformed native frame after the directive prefix' };
    frames.push(frame as ClaudeFrame);
  }
  let init = false;
  for (const [index, frame] of frames.entries()) {
    const type = frame['type'];
    if (type === 'system') {
      if (frame['subtype'] === 'init') {
        if (frame['session_id'] !== binding.sessionId) return { refused: 'native session identity mismatch' };
        init = true;
      }
      continue;
    }
    if (type === 'user') {
      const message = frame['message'] as { content?: unknown } | undefined;
      if (!init || frame['isReplay'] !== true || frame['session_id'] !== binding.sessionId || frame['parent_tool_use_id'] != null ||
          typeof frame['uuid'] !== 'string' || frame['uuid'] === '' || !Array.isArray(message?.content) ||
          contentHash(message.content) !== binding.promptHash || (binding.userEntryId !== null && binding.userEntryId !== frame['uuid'])) {
        return { refused: 'actual native admission user receipt unavailable/changed' };
      }
      return { frames, echo: index };
    }
    // Before its own echo the turn may only announce itself.
    if (type === 'assistant' || type === 'result' || type === 'control_request' || type === 'stream_event') {
      return { refused: 'the native turn proceeded without an exact admission receipt' };
    }
  }
  return { refused: 'actual native admission user receipt unavailable' };
}

function inspectClaudeDirectiveAdmission(file: string, binding: DirectiveNativeBinding): DirectiveNativeBinding {
  const turn = claudeTurn(file, binding);
  if ('refused' in turn) throw new DirectiveCheckpointError(turn.refused);
  syncFile(file);
  const admitted = { ...binding, userEntryId: turn.frames[turn.echo]!['uuid'] as string };
  if (binding.userEntryId === null) appendBinding(admitted);
  return admitted;
}

/** Terminal at the turn's own `result` frame, or unknown. Never resumable. */
function inspectClaudeDirectiveCheckpoint(file: string, binding: DirectiveNativeBinding): DirectiveCheckpoint {
  const unknown = (reason: string): DirectiveCheckpoint => ({ state: 'unknown', reason });
  const turn = claudeTurn(file, binding);
  if ('refused' in turn) return unknown(turn.refused);
  syncFile(file);
  const admitted = { ...binding, userEntryId: turn.frames[turn.echo]!['uuid'] as string };
  if (binding.userEntryId === null) appendBinding(admitted);
  if (producerReceipts(file).some((row) => row.state === 'guard-refused' && isDeepStrictEqual(row.producer.identity, binding.identity))) {
    return unknown('native directive execution/authority boundary refused; exact turn remains incomplete');
  }
  const pending = new Map<string, string>();
  for (const frame of turn.frames.slice(turn.echo + 1)) {
    const type = frame['type'];
    const message = frame['message'] as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
    if (type === 'assistant') {
      for (const block of blocks) {
        if (block['type'] !== 'tool_use') continue;
        if (typeof block['id'] !== 'string' || block['id'] === '' || typeof block['name'] !== 'string' || block['name'] === '' ||
            typeof block['input'] !== 'object' || block['input'] === null || pending.has(block['id'])) return unknown('malformed native tool identity');
        pending.set(block['id'], block['name']);
      }
    } else if (type === 'user') {
      if (frame['isReplay'] === true) return unknown('another prompt entered the directive turn');
      for (const block of blocks) {
        if (block['type'] !== 'tool_result') continue;
        if (typeof block['tool_use_id'] !== 'string' || !pending.has(block['tool_use_id'])) return unknown('unmatched/malformed native tool result');
        if (block['is_error'] === true) return unknown('native tool error requires a recovery judgment');
        pending.delete(block['tool_use_id']);
      }
    } else if (type === 'control_request') {
      const request = frame['request'] as Record<string, unknown> | undefined;
      if (request?.['subtype'] === 'can_use_tool' && (typeof request['tool_use_id'] !== 'string' || !pending.has(request['tool_use_id']))) {
        return unknown('a tool permission request names no recorded tool intent');
      }
    } else if (type === 'system' && frame['subtype'] === 'init') {
      return unknown('a new native turn began before the directive turn reached its result');
    } else if (type === 'result') {
      if (frame['session_id'] !== binding.sessionId || typeof frame['uuid'] !== 'string' || frame['uuid'] === '') return unknown('malformed native result');
      const ok = frame['subtype'] === 'success' && frame['is_error'] === false;
      if (ok && pending.size > 0) return unknown('native tool effects/results are incomplete');
      return { state: 'terminal', binding: admitted, checkpointId: frame['uuid'], ok,
        error: ok ? null : String(typeof frame['result'] === 'string' && frame['result'] !== '' ? frame['result'] : `native result: ${String(frame['subtype'])}`) };
    }
  }
  return unknown('native directive turn has no result yet');
}

/** The exact tool intent a Claude permission request names is durably in the
 * transcript, within the admitted turn, before the host allows it. */
export function assertClaudeDirectiveToolIntent(file: string, identity: DirectiveTurnIdentity, toolUseId: string, toolName: string, input: unknown): void {
  const binding = inspectDirectiveAdmission(file, identity);
  const turn = claudeTurn(file, binding);
  if ('refused' in turn) throw new DirectiveCheckpointError(turn.refused);
  const resolved = new Set<string>();
  let intent: Record<string, unknown> | null = null;
  for (const frame of turn.frames.slice(turn.echo + 1)) {
    const blocks = Array.isArray((frame['message'] as { content?: unknown } | undefined)?.content)
      ? (frame['message'] as { content: Record<string, unknown>[] }).content : [];
    if (frame['type'] === 'assistant') {
      for (const block of blocks) {
        if (block['type'] !== 'tool_use' || block['id'] !== toolUseId) continue;
        if (intent !== null) throw new DirectiveCheckpointError('native tool intent is ambiguous: its tool_use id repeats in the turn');
        intent = block;
      }
    }
    if (frame['type'] === 'user') for (const block of blocks) { if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') resolved.add(block['tool_use_id']); }
    if (frame['type'] === 'result') throw new DirectiveCheckpointError('the directive turn already reached its result');
  }
  if (intent === null || resolved.has(toolUseId) || intent['name'] !== toolName || !isDeepStrictEqual(intent['input'], input)) {
    throw new DirectiveCheckpointError('native tool intent is not persisted before execution or its invocation/results changed');
  }
  syncFile(file);
}

/** Physical native host ownership; logical minion identity is not an incarnation. */
export interface DirectiveProducer {
  readonly lockOwner?: { readonly host: string; readonly pid: number; readonly bootId: string };
  readonly incarnation: string;
  readonly pid: number;
  readonly host: string;
  readonly identity: DirectiveTurnIdentity;
  readonly agentId: string;
  readonly sessionId: string;
  readonly sessionFile: string;
}
interface ProducerReceipt { readonly state: 'started' | 'ceased' | 'independent' | 'completed' | 'guard-refused'; readonly producer: DirectiveProducer; readonly checkpointId?: string; readonly head?: string | null; readonly toolCallId?: string; readonly boundary?: 'authority'; readonly reason?: string }
export interface DirectiveCompletion { readonly producer: DirectiveProducer; readonly checkpointId: string; readonly head: string | null }
function appendProducer(receipt: ProducerReceipt): void {
  const fd = openSync(`${receipt.producer.sessionFile}.producers.jsonl`, 'a', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(receipt)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  syncFile(dirname(receipt.producer.sessionFile));
}
export function prepareDirectiveProducer(input: Omit<DirectiveProducer, 'incarnation' | 'pid' | 'host'>): DirectiveProducer {
  validateDirectiveIdentity(input.identity);
  const producer = { ...input, incarnation: randomUUID(), pid: process.pid, host: hostname() };
  appendProducer({ state: 'started', producer });
  return producer;
}
function producerReceipts(file: string): readonly ProducerReceipt[] {
  let text: string;
  try { text = readBoundedUtf8(`${file}.producers.jsonl`, MAX_DIRECTIVE_JOURNAL_BYTES, 'native producer journal'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!text.endsWith('\n')) throw new DirectiveCheckpointError('native producer journal has a partial write');
  assertEntryLimit(text, MAX_DIRECTIVE_JOURNAL_ENTRIES, 'native producer journal');
  const rows = text.trimEnd().split('\n').map((line) => JSON.parse(line) as ProducerReceipt);
  const starts = new Map<string, DirectiveProducer>();
  for (const receipt of rows) {
    const { state, producer } = receipt;
    if (state === 'completed' && (typeof receipt.checkpointId !== 'string' || !receipt.checkpointId ||
        !(receipt.head === null || typeof receipt.head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.head)))) {
      throw new DirectiveCheckpointError('malformed native completion HEAD receipt');
    }
    validateDirectiveIdentity(producer.identity);
    if (state === 'guard-refused' && (typeof receipt.reason !== 'string' || !receipt.reason ||
        !(typeof receipt.toolCallId === 'string' && receipt.toolCallId.length > 0 || receipt.boundary === 'authority' && receipt.toolCallId === undefined))) {
      throw new DirectiveCheckpointError('malformed native guard refusal receipt');
    }
    if (!['started', 'ceased', 'independent', 'completed', 'guard-refused'].includes(state) || !producer.incarnation || !Number.isSafeInteger(producer.pid) || producer.pid <= 0 ||
        !producer.host || !producer.agentId || !producer.sessionId || producer.sessionFile !== file ||
        producer.lockOwner !== undefined && (producer.lockOwner.host !== producer.host || producer.lockOwner.pid !== producer.pid || !producer.lockOwner.bootId)) throw new DirectiveCheckpointError('malformed native producer journal');
    const start = starts.get(producer.incarnation);
    if (state === 'started') {
      if (start !== undefined) throw new DirectiveCheckpointError('duplicate native producer incarnation');
      starts.set(producer.incarnation, producer);
    } else if (!isDeepStrictEqual(start, producer)) throw new DirectiveCheckpointError('native cessation does not bind its physical incarnation');
  }
  return rows;
}
export function recordDirectiveProducerCessation(producer: DirectiveProducer): void {
  const rows = producerReceipts(producer.sessionFile);
  if (!rows.some((row) => row.state === 'started' && isDeepStrictEqual(row.producer, producer))) throw new DirectiveCheckpointError('native producer start missing');
  if (!rows.some((row) => row.state === 'ceased' && isDeepStrictEqual(row.producer, producer))) appendProducer({ state: 'ceased', producer });
  else { syncFile(`${producer.sessionFile}.producers.jsonl`); syncFile(dirname(producer.sessionFile)); }
}
/** ESRCH proves only host absence. Caller still needs a safe native checkpoint
 * and every independent child/process/tool fence before executing or settling. */
export function inspectDirectiveProducers(file: string, identity?: DirectiveTurnIdentity): readonly {
  readonly producer: DirectiveProducer; readonly evidence: 'ceased' | 'host-absent' | 'unknown';
}[] {
  const rows = producerReceipts(file).filter((row) => identity === undefined || isDeepStrictEqual(row.producer.identity, identity));
  // One pass, not one scan per start (#363 S04-0-03): producerReceipts has
  // already proven every receipt of an incarnation equals its start, so
  // the incarnation names the exact physical producer.
  const ceased = new Set(rows.filter((row) => row.state === 'ceased').map((row) => row.producer.incarnation));
  const independent = new Set(rows.filter((row) => row.state === 'independent').map((row) => row.producer.incarnation));
  return rows.filter((row) => row.state === 'started').map(({ producer }) => {
    if (ceased.has(producer.incarnation)) return { producer, evidence: 'ceased' as const };
    if (independent.has(producer.incarnation)) return { producer, evidence: 'unknown' as const };
    let absent = false;
    if (producer.host === hostname()) {
      try { process.kill(producer.pid, 0); }
      catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
    return { producer, evidence: absent ? 'host-absent' as const : 'unknown' as const };
  });
}

export function recordDirectiveToolRefusal(producer: DirectiveProducer, toolCallId: string, reason: string): void {
  const rows = producerReceipts(producer.sessionFile);
  if (!toolCallId || !reason || !rows.some((row) => row.state === 'started' && isDeepStrictEqual(row.producer, producer))) throw new DirectiveCheckpointError('native tool refusal requires exact original physical start');
  if (!rows.some((row) => row.state === 'guard-refused' && row.toolCallId === toolCallId && isDeepStrictEqual(row.producer, producer))) appendProducer({ state: 'guard-refused', producer, toolCallId, reason });
  else syncFile(`${producer.sessionFile}.producers.jsonl`);
}

/** A model/role authority refusal is durable even when no tool was called.
 * Never invent a tool-call id or let restart reinterpret it as completion. */
export function recordDirectiveAuthorityRefusal(producer: DirectiveProducer, reason: string): void {
  const rows = producerReceipts(producer.sessionFile);
  if (!reason || !rows.some((row) => row.state === 'started' && isDeepStrictEqual(row.producer, producer))) throw new DirectiveCheckpointError('native authority refusal requires exact original physical start');
  if (!rows.some((row) => row.state === 'guard-refused' && row.boundary === 'authority' && isDeepStrictEqual(row.producer, producer))) appendProducer({ state: 'guard-refused', producer, boundary: 'authority', reason });
  else syncFile(`${producer.sessionFile}.producers.jsonl`);
}

export function recordDirectiveCompletion(producer: DirectiveProducer, checkpointId: string, head: string | null): void {
  if (!(head === null || typeof head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))) throw new DirectiveCheckpointError('native completion HEAD malformed');
  const proof = inspectDirectiveCheckpoint(producer.sessionFile, producer.identity);
  if (proof.state !== 'terminal' || !proof.ok || proof.checkpointId !== checkpointId || proof.binding.agentId !== producer.agentId || proof.binding.sessionId !== producer.sessionId) {
    throw new DirectiveCheckpointError('native completion does not bind the original successful checkpoint/producer');
  }
  const prior = readDirectiveCompletion(producer.sessionFile, producer.identity, checkpointId);
  const completion = { producer, checkpointId, head };
  if (prior !== null && !isDeepStrictEqual(prior, completion)) throw new DirectiveCheckpointError('conflicting native completion HEAD receipts');
  if (prior === null) appendProducer({ state: 'completed', ...completion });
  else syncFile(`${producer.sessionFile}.producers.jsonl`);
}
export function readDirectiveCompletion(file: string, identity: DirectiveTurnIdentity, checkpointId: string): DirectiveCompletion | null {
  const completed = producerReceipts(file).filter((row) => row.state === 'completed' && isDeepStrictEqual(row.producer.identity, identity));
  let result: DirectiveCompletion | null = null;
  for (const row of completed) {
    const receipt = { producer: row.producer, checkpointId: row.checkpointId!, head: row.head! };
    if (receipt.checkpointId !== checkpointId || result !== null && !isDeepStrictEqual(receipt, result)) throw new DirectiveCheckpointError('conflicting/mismatched native completion HEAD receipts');
    result = receipt;
  }
  return result;
}

/** A native cessation receipt never identifies a later writer's lock.
 * This is an additional fence, not cessation proof from lock absence. */
export function directiveProducerLockBlocker(producer: DirectiveProducer): string | null {
  return withSessionLockCoordination(producer.sessionFile, () => {
    let text: string;
    try { text = readBoundedUtf8(`${producer.sessionFile}.lock`, MAX_NATIVE_LOCK_BYTES, 'native session lock'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const holder = JSON.parse(text) as { host?: unknown; pid?: unknown; bootId?: unknown };
    const expected = producer.lockOwner;
    if (expected === undefined || holder.host !== expected.host || holder.pid !== expected.pid || holder.bootId !== expected.bootId || holder.host !== hostname()) return 'current native lock owner is foreign/legacy/unbound';
    try { process.kill(expected.pid, 0); return 'current native lock owner is still live'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'current native lock owner absence is unproven'; }
    return readBoundedUtf8(`${producer.sessionFile}.lock`, MAX_NATIVE_LOCK_BYTES, 'native session lock') === text ? null : 'current native lock owner changed during observation';
  });
}

/** The one current lock belongs to the latest durable physical incarnation.
 * Callers must still prove cessation for EVERY historical producer; matching
 * the current lock never releases an older UNKNOWN owner. */
export function directiveSessionLockBlocker(file: string): string | null {
  const current = inspectDirectiveProducers(file).at(-1);
  return current === undefined ? 'native session lacks exact physical producer ownership' : directiveProducerLockBlocker(current.producer);
}

export function recordDirectiveIndependentController(producer: DirectiveProducer): void { appendProducer({ state: 'independent', producer }); }
/** Called by the real SDK beforeToolCall hook, after its awaited message
 * persistence. No tool can execute unless its exact intent is durably on disk. */
export function flushDirectiveToolIntent(file: string, assistantMessage: unknown, toolCall: {
  readonly id: string; readonly name: string; readonly arguments: unknown;
}, identity: DirectiveTurnIdentity, executionMode: 'sequential' | 'parallel' = 'sequential'): void {
  const binding = inspectDirectiveAdmission(file, identity);
  const transcript = piTranscript(file, binding.baseline, 'whole');
  // The admitted turn only (#469): its receipt first, then everything after it.
  const native = (transcript.turn ?? []).map((line) => JSON.parse(line) as NativeEntry);
  let index = native.length - 1;
  // Sequential batches persist results between preparations; the pinned SDK
  // prepares every parallel call before executing any or persisting results.
  // Only this invocation's contiguous, tree-linked results may follow it.
  while (index >= 0 && native[index]?.type === 'message' && native[index]?.message?.role === 'toolResult') index -= 1;
  const invocation = native[index];
  const content = invocation?.message?.content;
  const refuse = (): never => { throw new DirectiveCheckpointError('native tool intent is not persisted before execution or its invocation/results changed'); };
  if (invocation?.type !== 'message' || !invocation.id || invocation.message?.role !== 'assistant' || invocation.message.stopReason !== 'toolUse' ||
      !isDeepStrictEqual(invocation.message, JSON.parse(JSON.stringify(assistantMessage))) || !Array.isArray(content)) refuse();
  const pending = new Map<string, Record<string, unknown>>();
  for (const block of content as Record<string, unknown>[]) {
    if (block.type !== 'toolCall') continue;
    if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name ||
        typeof block.arguments !== 'object' || block.arguments === null || pending.has(block.id)) refuse();
    pending.set(block.id as string, block);
  }
  const batchSize = pending.size;
  let parent = invocation!.id;
  for (const result of native.slice(index + 1)) {
    const message = result.message;
    const id = message?.toolCallId;
    if (!result.id || result.parentId !== parent || typeof id !== 'string' || pending.get(id)?.name !== message?.toolName ||
        typeof message?.isError !== 'boolean' || !Array.isArray(message.content)) refuse();
    pending.delete(id as string);
    parent = result.id;
  }
  if (native[0]?.id !== binding.userEntryId || index < 1) refuse();
  let ancestor = binding.userEntryId;
  const chainPending = new Map<string, string>();
  const ids = new Set([native[0]!.id]);
  for (const entry of native.slice(1)) {
    const message = entry.message;
    if (entry.type !== 'message' || !entry.id || transcript.ids.has(entry.id) || ids.has(entry.id) || entry.parentId !== ancestor || !message) refuse();
    ids.add(entry.id); ancestor = entry.id;
    if (message!.role === 'assistant') {
      if (chainPending.size > 0 || message!.stopReason !== 'toolUse' || !Array.isArray(message!.content)) refuse();
      for (const block of message!.content as Record<string, unknown>[]) {
        if (block.type !== 'toolCall') continue;
        if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || typeof block.arguments !== 'object' || block.arguments === null || chainPending.has(block.id)) refuse();
        chainPending.set(block.id as string, block.name as string);
      }
      if (chainPending.size === 0) refuse();
    } else if (message!.role === 'toolResult') {
      if (typeof message!.toolCallId !== 'string' || chainPending.get(message!.toolCallId) !== message!.toolName || message!.isError !== false || !Array.isArray(message!.content)) refuse();
      chainPending.delete(message!.toolCallId as string);
    } else refuse();
  }
  const requested = pending.get(toolCall.id);
  if ((executionMode === 'parallel' ? pending.size !== batchSize : pending.keys().next().value !== toolCall.id) ||
      requested?.name !== toolCall.name || !isDeepStrictEqual(requested.arguments, toolCall.arguments)) refuse();
  syncFile(file);
}
