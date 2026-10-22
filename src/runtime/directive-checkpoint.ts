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
 * never holds one whole. The header is its first line. The session before a
 * directive's baseline is streamed past: pi keeps only its entry ids, Claude
 * re-hashes its exact bytes. The directive's own turn after the baseline is
 * read only as far as an inspection walks, and only the lines read count
 * against the transcript byte and entry limits, so a session's later work
 * never refuses an earlier directive.
 */
const HEADER_OVERSIZED = `native session header exceeds the ${MAX_NATIVE_HEADER_BYTES}-byte inspection limit`;
const ENTRY_OVERSIZED = `native transcript entry exceeds the ${MAX_NATIVE_TRANSCRIPT_BYTES}-byte inspection limit`;
function withNativeTranscript<T>(file: string, inspect: (fd: number) => T): T {
  const fd = openRegularFile(file, 'native transcript');
  try { return inspect(fd); } finally { closeSync(fd); }
}
/** Complete lines read on demand from `start`, each bounded and fatally
 * decoded. A torn final line is never decoded: it only sets `partial`. */
class NativeLines {
  private readonly decoder = utf8Decoder();
  private readonly buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  private chunk = this.buffer.subarray(0, 0);
  private position: number;
  private count = 0;
  /** The offset after the last complete line read. */
  end: number;
  partial = false;
  constructor(private readonly fd: number, start: number) { this.position = start; this.end = start; }
  /** The next complete line, or null at the end; one longer than `limit` bytes refuses. */
  next(limit: number, oversized: string): string | null {
    const pieces: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      if (this.chunk.length === 0) {
        const count = readSync(this.fd, this.buffer, 0, this.buffer.length, this.position);
        if (count === 0) {
          if (fstatSync(this.fd).size !== this.position) throw new DirectiveCheckpointError('native transcript changed during bounded inspection');
          if (bytes > 0) this.partial = true;
          return null;
        }
        this.position += count;
        this.chunk = this.buffer.subarray(0, count);
      }
      const newline = this.chunk.indexOf(10);
      const piece = newline < 0 ? this.chunk : this.chunk.subarray(0, newline);
      bytes += piece.length;
      if (bytes > limit) throw new DirectiveCheckpointError(oversized);
      if (newline < 0) {
        pieces.push(Buffer.from(piece)); // the read buffer is reused
        this.chunk = this.chunk.subarray(this.chunk.length);
        continue;
      }
      this.chunk = this.chunk.subarray(newline + 1);
      this.end += bytes + 1;
      this.count += 1;
      return decodeEvidence(pieces.length === 0 ? piece : Buffer.concat([...pieces, piece], bytes), 'native transcript', this.decoder);
    }
  }
  /** The next line of the session itself: the header within its own bound, then entries. */
  nextEntry(): string | null {
    return this.count === 0 ? this.next(MAX_NATIVE_HEADER_BYTES, HEADER_OVERSIZED) : this.next(MAX_NATIVE_TRANSCRIPT_BYTES, ENTRY_OVERSIZED);
  }
}
/** The first line alone, never the session after it. */
function nativeHeaderLine(fd: number): string {
  const line = new NativeLines(fd, 0).nextEntry();
  if (line === null) throw new DirectiveCheckpointError('native transcript has no complete session header');
  return line;
}
/** A directive's own turn after its baseline, read on demand within the
 * transcript limits. `accepted` ends at a torn final line (a partial tail
 * cannot undo an accepted prefix); `whole` refuses it. */
class NativeTurn {
  private readonly lines: NativeLines;
  private count = 0;
  private scope = 'native directive turn';
  private ended: { readonly start: number; readonly count: number } | null = null;
  constructor(fd: number, private start: number, private readonly tail: 'whole' | 'accepted') { this.lines = new NativeLines(fd, start); }
  /** The turn ended at the last line read. What is read after it only looks
   * ahead, under its own bound and its own name: it is never charged to,
   * nor refused as, this turn. Idempotent until resume(): a chained retry
   * ends, resumes and ends again. */
  end(): void {
    if (this.ended !== null) return;
    this.ended = { start: this.start, count: this.count };
    this.start = this.lines.end; this.count = 0; this.scope = 'native lookahead after the directive turn';
  }
  /** Takes back end(): what was read since belongs to the turn after all,
   * and is charged to it under the turn's own bound and name. A line too
   * large to read at all was refused before its role was known, under the
   * lookahead's name: it is past both bounds. */
  resume(): void {
    if (this.ended === null) throw new DirectiveCheckpointError('native directive turn resumed without having ended');
    this.start = this.ended.start; this.count += this.ended.count; this.ended = null; this.scope = 'native directive turn';
    if (this.lines.end - this.start > MAX_NATIVE_TRANSCRIPT_BYTES) throw new DirectiveCheckpointError(`${this.scope} exceeds the ${MAX_NATIVE_TRANSCRIPT_BYTES}-byte inspection limit`);
    if (this.count > MAX_NATIVE_TRANSCRIPT_ENTRIES) throw new DirectiveCheckpointError(`${this.scope} exceeds the entry inspection limit`);
  }
  /** The turn's next line, or undefined at its end. */
  next(): string | undefined {
    const line = this.lines.next(MAX_NATIVE_TRANSCRIPT_BYTES - (this.lines.end - this.start) - 1, `${this.scope} exceeds the ${MAX_NATIVE_TRANSCRIPT_BYTES}-byte inspection limit`);
    if (line === null) {
      if (this.lines.partial && this.tail === 'whole') throw new DirectiveCheckpointError('native transcript has a partial entry');
      return undefined;
    }
    if (++this.count > MAX_NATIVE_TRANSCRIPT_ENTRIES) throw new DirectiveCheckpointError(`${this.scope} exceeds the entry inspection limit`);
    return line;
  }
}
/** The pi turn's entry at `index`: `malformed` without a unique, non-empty
 * id; undefined past the turn's end. */
type PiTurn = (index: number) => NativeEntry | 'malformed' | undefined;
/** A pi transcript split after its `baseline` entry (after the header when
 * null). Entries through the split are kept only as their ids. */
interface PiTranscript {
  readonly header: NativeEntry | null;
  /** Every id through the baseline, the header's included. */
  readonly ids: ReadonlySet<string>;
  /** An entry through the baseline has no unique, non-empty id. */
  readonly malformed: boolean;
  /** Null without the baseline. */
  readonly turn: PiTurn | null;
  /** The turn ended at the last entry read (see NativeTurn.end). */
  readonly endTurn: () => void;
  /** Takes back endTurn (see NativeTurn.resume). */
  readonly resumeTurn: () => void;
}
function withPiTranscript<T>(file: string, baseline: string | null, tail: 'whole' | 'accepted', inspect: (transcript: PiTranscript) => T): T {
  return withNativeTranscript(file, (fd) => {
    const lines = new NativeLines(fd, 0);
    const first = lines.nextEntry();
    const header = first === null ? null : JSON.parse(first) as NativeEntry | null;
    const ids = new Set<string>();
    if (typeof header?.id === 'string') ids.add(header.id);
    const fresh = (entry: NativeEntry | null, seen?: ReadonlySet<string>): entry is NativeEntry =>
      !!entry && typeof entry.id === 'string' && entry.id !== '' && !ids.has(entry.id) && !seen?.has(entry.id);
    let malformed = false;
    let found = first !== null && baseline === null;
    while (!found) {
      const line = lines.nextEntry();
      if (line === null) break;
      const entry = JSON.parse(line) as NativeEntry | null;
      if (!fresh(entry)) { malformed = true; continue; }
      ids.add(entry.id);
      found = entry.id === baseline;
    }
    if (!found) {
      if (lines.partial && tail === 'whole') throw new DirectiveCheckpointError('native transcript has a partial entry');
      return inspect({ header, ids, malformed, turn: null, endTurn: () => {}, resumeTurn: () => {} });
    }
    const after = new NativeTurn(fd, lines.end, tail);
    const seen = new Set<string>();
    const entries: (NativeEntry | 'malformed')[] = [];
    const turn: PiTurn = (index) => {
      while (entries.length <= index) {
        const line = after.next();
        if (line === undefined) return undefined;
        const entry = JSON.parse(line) as NativeEntry | null;
        if (fresh(entry, seen)) { seen.add(entry.id); entries.push(entry); } else entries.push('malformed');
      }
      return entries[index];
    };
    return inspect({ header, ids, malformed, turn, endTurn: () => after.end(), resumeTurn: () => after.resume() });
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
    const lines = new NativeLines(fd, 0);
    let last: string | null = null;
    for (let line = lines.nextEntry(); line !== null; line = lines.nextEntry()) {
      const entry = JSON.parse(line) as NativeEntry;
      if (entry.type !== 'session') last = entry.id ?? null;
    }
    if (lines.partial) throw new DirectiveCheckpointError('native transcript has a partial entry');
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
/** Reads only the few entries after the checkpoint (#469); a read refusal
 * propagates, a binding that does not read back is no later request. */
function hasLaterBoundRequest(file: string, native: PiTurn, identity: DirectiveTurnIdentity, checkpointIndex: number): boolean {
  const checkpoint = native(checkpointIndex);
  if (typeof checkpoint !== 'object') return false;
  let baseline = checkpoint.id;
  let nextIndex = checkpointIndex + 1;
  // These controls change the NEXT request's model, not the completed
  // request's ancestry. No branch, compaction or unbound effect is skipped.
  for (let control = native(nextIndex); typeof control === 'object' && (control.type === 'model_change' || control.type === 'thinking_level_change'); control = native(nextIndex)) {
    if (control.parentId !== baseline || control.type === 'model_change' &&
        (typeof control.provider !== 'string' || !control.provider.trim() || typeof control.modelId !== 'string' || !control.modelId.trim()) ||
        control.type === 'thinking_level_change' && (typeof control.thinkingLevel !== 'string' ||
          !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(control.thinkingLevel))) return false;
    baseline = control.id;
    nextIndex += 1;
  }
  const immediate = native(nextIndex);
  if (typeof immediate !== 'object' || immediate.type !== 'message' || immediate.message?.role !== 'user' || immediate.parentId !== baseline || !Array.isArray(immediate.message.content)) return false;
  try {
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
  return withPiTranscript(file, binding.baseline, 'accepted', (transcript) => admitPiDirective(file, binding, transcript));
}
/** Pi admission: the exact user receipt directly after the baseline, the
 * turn's first entry and the only one read. */
function admitPiDirective(file: string, binding: DirectiveNativeBinding, { header, malformed, turn }: PiTranscript): DirectiveNativeBinding {
  if (header?.type !== 'session' || header.id !== binding.sessionId) throw new DirectiveCheckpointError('native admission session identity mismatch');
  if (malformed) throw new DirectiveCheckpointError('malformed/rebound native admission prefix');
  const entry = turn?.(0);
  if (entry === undefined) throw new DirectiveCheckpointError('actual native admission user receipt unavailable');
  if (entry === 'malformed') throw new DirectiveCheckpointError('malformed/rebound native admission prefix');
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
  return withPiTranscript(file, binding.baseline, 'whole', (transcript) => piDirectiveCheckpoint(file, binding, transcript));
}
/** The walk reads the turn only up to its own end (#469): its terminal and
 * the few entries that show what follows it. */
function piDirectiveCheckpoint(file: string, binding: DirectiveNativeBinding, { header, malformed, turn: native, endTurn, resumeTurn }: PiTranscript): DirectiveCheckpoint {
  const { identity } = binding;
  const unknown = (reason: string): DirectiveCheckpoint => ({ state: 'unknown', reason });
  const MALFORMED = 'native checkpoint has a malformed or duplicate entry identity';
  if (header?.type !== 'session' || header.id !== binding.sessionId) return unknown('native session identity mismatch');
  if (malformed) return unknown(MALFORMED);
  if (native === null) return unknown('native baseline unavailable');
  const user = native(0);
  if (user === 'malformed') return unknown(MALFORMED);
  if (user?.type !== 'message' || user.message?.role !== 'user' || user.parentId !== binding.baseline ||
      contentHash(user.message.content) !== binding.promptHash || !user.id) return unknown('actual native request receipt unavailable');
  if (binding.userEntryId !== null && user.id !== binding.userEntryId) return unknown('native request receipt changed');
  // The native receipt is durably flushed before the product admission callback.
  syncFile(file);
  const admitted = { ...binding, userEntryId: user.id };
  if (binding.userEntryId === null) appendBinding(admitted);
  const receipts = producerReceipts(file);
  if (receipts.some((row) => row.state === 'guard-refused' && isDeepStrictEqual(row.producer.identity, identity))) return unknown('native directive execution/authority boundary refused; exact turn remains incomplete');
  const retries = retryEvidence(receipts, identity);
  let parent = user.id;
  const pending = new Map<string, string>();
  let lastMessage = user.message;
  let terminal = false;
  // A tool error the turn went on to answer is ordinary work (a failing test,
  // a grep with no match). One it never answered may be an interrupted effect,
  // unless it is the SDK's own "not executed" result for a length row's call.
  let unanswered = false;
  const notExecuted = new Set<string>();
  for (let index = 1; ; index += 1) {
    const entry = native(index);
    if (entry === undefined) break;
    if (entry === 'malformed') return unknown(MALFORMED);
    if (terminal) {
      // A later user entry is not part of this completed turn when its own
      // distinct, durably read-back admission binds it. Keep the earlier
      // checkpoint readable without treating an unbound/replayed user tail
      // as proof that the old request completed.
      if (hasLaterBoundRequest(file, native, identity, index - 1)) {
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
      unanswered = false;
      if (!Array.isArray(message.content)) return unknown('malformed native assistant');
      // A receipted error row is history only when the SDK's retried answer
      // follows it; otherwise it is the turn's terminal. Its successor is read
      // as lookahead, and charged to the turn only as that retried answer.
      if (isRetryHistoryRow(entry, () => { endTurn(); return native(index + 1); }, retries)) resumeTurn();
      else {
        const calls = rowCalls(message.stopReason);
        for (const block of message.content as Record<string, unknown>[]) {
          // Ending the turn, an error or aborted row owes no results.
          if (block.type !== 'toolCall' || calls === 'never-run') continue;
          if (calls === null || typeof block.id !== 'string' || block.id === '' || typeof block.name !== 'string' || typeof block.arguments !== 'object' || block.arguments === null || pending.has(block.id)) return unknown('malformed native tool identity');
          pending.set(block.id, block.name);
          if (calls === 'not-executed') notExecuted.add(block.id);
        }
        if (pending.size === 0) {
          if (!['stop', 'error', 'aborted', 'length'].includes(String(message.stopReason))) return unknown('malformed native assistant terminal');
          terminal = true;
          // Whatever follows (a later request, its controls) is lookahead.
          endTurn();
        }
      }
    } else if (message.role === 'toolResult') {
      if (typeof message.toolCallId !== 'string' || !pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName || typeof message.isError !== 'boolean') return unknown('unmatched/malformed native tool result');
      pending.delete(message.toolCallId);
      if (!Array.isArray(message.content) || typeof message.toolName !== 'string') return unknown('malformed native tool result content/name');
      // Nothing ran for a "not executed" result: there is no effect to judge.
      if (!notExecuted.delete(message.toolCallId) && message.isError) unanswered = true;
    } else return unknown('another user/custom message owns this session');
    lastMessage = message;
  }
  if (pending.size > 0) return unknown('native tool effects/results are incomplete');
  if (lastMessage.role === 'assistant') {
    const ok = lastMessage.stopReason === 'stop';
    return { state: 'terminal', binding: admitted, checkpointId: parent, ok,
      error: ok ? null : String(lastMessage.errorMessage ?? `native stopReason: ${String(lastMessage.stopReason)}`) };
  }
  if (unanswered) return unknown('native tool error the turn never answered requires a recovery judgment');
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

/** The CLI's own background-task completion (#471). Under
 * --replay-user-messages Claude Code replays it as an `isReplay` user frame
 * that it tags `origin.kind: 'task-notification'`, its content a string that
 * is exactly one `<task-notification>` block (Claude Code 2.1.306, recorded
 * in test/fixtures/claude-stream/task-notifications.jsonl). It is a runtime
 * event, not a prompt: it never admits a directive and never counts as
 * another prompt in its turn. Any other replayed user frame still does. */
export function isClaudeTaskNotification(frame: ClaudeFrame, sessionId: string): boolean {
  const origin = frame['origin'];
  const content = (frame['message'] as { content?: unknown } | undefined)?.content;
  return frame['type'] === 'user' && frame['isReplay'] === true && frame['session_id'] === sessionId && frame['parent_tool_use_id'] == null &&
    typeof origin === 'object' && origin !== null && (origin as Record<string, unknown>)['kind'] === 'task-notification' &&
    typeof content === 'string' && /^<task-notification>(?:(?!<\/?task-notification>)[\s\S])*<\/task-notification>$/u.test(content.trim());
}

/** The bound turn after its exact recorded prefix, frame by frame and read
 * only as far as an inspection walks (#469): `malformed` for a line that is
 * no JSON object, undefined past the turn's end. `echo` indexes its
 * admission receipt. */
interface ClaudeTurn {
  readonly frame: (index: number) => ClaudeFrame | 'malformed' | undefined;
  readonly echo: number;
  readonly receipt: string;
}

/** Runs `inspect` over the turn the binding's exact prefix starts, or
 * `refused` with the reason there is none. A partial tail cannot undo an
 * accepted prefix. */
function withClaudeTurn<T>(file: string, binding: DirectiveNativeBinding, inspect: (turn: ClaudeTurn) => T, refused: (reason: string) => T): T {
  const prefix = CLAUDE_BASELINE.exec(binding.baseline ?? '');
  if (prefix === null) return refused('claude-code association has no exact transcript prefix');
  const length = Number(prefix[1]);
  return withNativeTranscript(file, (fd) => {
    if (nativePrefixHash(fd, length) !== prefix[2]) return refused('the native transcript before the directive changed');
    try { claudeHeader(nativeHeaderLine(fd), binding.sessionId); }
    catch (error) {
      if (!(error instanceof DirectiveCheckpointError)) throw error;
      return refused(error.message);
    }
    const lines = new NativeTurn(fd, length, 'accepted');
    const frames: (ClaudeFrame | 'malformed')[] = [];
    const frame = (index: number): ClaudeFrame | 'malformed' | undefined => {
      while (frames.length <= index) {
        const line = lines.next();
        if (line === undefined) return undefined;
        let parsed: unknown;
        try { parsed = JSON.parse(line) as unknown; } catch { parsed = null; }
        frames.push(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as ClaudeFrame : 'malformed');
      }
      return frames[index];
    };
    let init = false;
    for (let index = 0; ; index += 1) {
      const current = frame(index);
      if (current === undefined) return refused('actual native admission user receipt unavailable');
      if (current === 'malformed') return refused('malformed native frame after the directive prefix');
      const type = current['type'];
      if (type === 'system') {
        if (current['subtype'] === 'init') {
          if (current['session_id'] !== binding.sessionId) return refused('native session identity mismatch');
          init = true;
        }
        continue;
      }
      if (type === 'user') {
        // A resumed session may replay a dead turn's task notifications first.
        if (init && isClaudeTaskNotification(current, binding.sessionId)) continue;
        const message = current['message'] as { content?: unknown } | undefined;
        if (!init || current['isReplay'] !== true || current['session_id'] !== binding.sessionId || current['parent_tool_use_id'] != null ||
            typeof current['uuid'] !== 'string' || current['uuid'] === '' || !Array.isArray(message?.content) ||
            contentHash(message.content) !== binding.promptHash || (binding.userEntryId !== null && binding.userEntryId !== current['uuid'])) {
          return refused('actual native admission user receipt unavailable/changed');
        }
        return inspect({ frame, echo: index, receipt: current['uuid'] });
      }
      // Before its own echo the turn may only announce itself.
      if (type === 'result' || type === 'control_request' || claudeAnswerFrame(current)) {
        return refused('the native turn proceeded without an exact admission receipt');
      }
    }
  });
}

/** Model output — not the keepalive ping the CLI streams while a request
 * stalls, which may precede its echo (#472). */
export function claudeAnswerFrame(frame: Readonly<Record<string, unknown>>): boolean {
  return frame['type'] === 'assistant' ||
    frame['type'] === 'stream_event' && (frame['event'] as { type?: unknown } | undefined)?.type !== 'ping';
}

/** Publishes the read-back admission once the echo is durable. */
function admitClaudeDirective(file: string, binding: DirectiveNativeBinding, turn: ClaudeTurn): DirectiveNativeBinding {
  syncFile(file);
  const admitted = { ...binding, userEntryId: turn.receipt };
  if (binding.userEntryId === null) appendBinding(admitted);
  return admitted;
}

function inspectClaudeDirectiveAdmission(file: string, binding: DirectiveNativeBinding): DirectiveNativeBinding {
  return withClaudeTurn(file, binding, (turn) => admitClaudeDirective(file, binding, turn), (reason) => { throw new DirectiveCheckpointError(reason); });
}

/** Terminal at the turn's own `result` frame, or unknown. Never resumable. */
function inspectClaudeDirectiveCheckpoint(file: string, binding: DirectiveNativeBinding): DirectiveCheckpoint {
  const unknown = (reason: string): DirectiveCheckpoint => ({ state: 'unknown', reason });
  return withClaudeTurn(file, binding, (turn) => {
    const admitted = admitClaudeDirective(file, binding, turn);
    if (producerReceipts(file).some((row) => row.state === 'guard-refused' && isDeepStrictEqual(row.producer.identity, binding.identity))) {
      return unknown('native directive execution/authority boundary refused; exact turn remains incomplete');
    }
    const pending = new Map<string, string>();
    // As on pi: a tool error the model went on to answer is ordinary work; a
    // result straight after one means the CLI ended the turn by itself.
    let unanswered = false;
    for (let index = turn.echo + 1; ; index += 1) {
      const frame = turn.frame(index);
      if (frame === undefined) break;
      if (frame === 'malformed') return unknown('malformed native frame after the directive prefix');
      const type = frame['type'];
      const message = frame['message'] as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];
      if (type === 'assistant') {
        // Only the main agent's own frame answers it, never a sub-agent's.
        if (frame['parent_tool_use_id'] == null) unanswered = false;
        for (const block of blocks) {
          if (block['type'] !== 'tool_use') continue;
          if (typeof block['id'] !== 'string' || block['id'] === '' || typeof block['name'] !== 'string' || block['name'] === '' ||
              typeof block['input'] !== 'object' || block['input'] === null || pending.has(block['id'])) return unknown('malformed native tool identity');
          pending.set(block['id'], block['name']);
        }
      } else if (type === 'user') {
        if (frame['isReplay'] === true) {
          if (isClaudeTaskNotification(frame, binding.sessionId)) continue;
          return unknown('another prompt entered the directive turn');
        }
        for (const block of blocks) {
          if (block['type'] !== 'tool_result') continue;
          if (typeof block['tool_use_id'] !== 'string' || !pending.has(block['tool_use_id'])) return unknown('unmatched/malformed native tool result');
          if (block['is_error'] === true) unanswered = true;
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
        if (ok && unanswered) return unknown('native tool error the turn never answered requires a recovery judgment');
        return { state: 'terminal', binding: admitted, checkpointId: frame['uuid'], ok,
          error: ok ? null : String(typeof frame['result'] === 'string' && frame['result'] !== '' ? frame['result'] : `native result: ${String(frame['subtype'])}`) };
      }
    }
    return unknown('native directive turn has no result yet');
  }, unknown);
}

/** The exact tool intent a Claude permission request names is durably in the
 * transcript, within the admitted turn, before the host allows it. Admission
 * and intent come from one read of the transcript. */
export function assertClaudeDirectiveToolIntent(file: string, identity: DirectiveTurnIdentity, toolUseId: string, toolName: string, input: unknown): void {
  validateDirectiveIdentity(identity);
  const binding = readDirectiveBinding(file, identity.requestId);
  if (binding === null || !isDeepStrictEqual(binding.identity, identity) || binding.runtime !== 'claude-code') {
    throw new DirectiveCheckpointError('exact native admission association unavailable');
  }
  const refuse = (reason: string): never => { throw new DirectiveCheckpointError(reason); };
  withClaudeTurn(file, binding, (turn) => {
    admitClaudeDirective(file, binding, turn);
    const resolved = new Set<string>();
    let intent: Record<string, unknown> | null = null;
    for (let index = turn.echo + 1; ; index += 1) {
      const frame = turn.frame(index);
      if (frame === undefined) break;
      if (frame === 'malformed') refuse('malformed native frame after the directive prefix');
      const current = frame as ClaudeFrame;
      const blocks = Array.isArray((current['message'] as { content?: unknown } | undefined)?.content)
        ? (current['message'] as { content: Record<string, unknown>[] }).content : [];
      if (current['type'] === 'assistant') {
        for (const block of blocks) {
          if (block['type'] !== 'tool_use' || block['id'] !== toolUseId) continue;
          if (intent !== null) refuse('native tool intent is ambiguous: its tool_use id repeats in the turn');
          intent = block;
        }
      }
      if (current['type'] === 'user') for (const block of blocks) { if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') resolved.add(block['tool_use_id']); }
      if (current['type'] === 'result') refuse('the directive turn already reached its result');
    }
    if (intent === null || resolved.has(toolUseId) || intent['name'] !== toolName || !isDeepStrictEqual(intent['input'], input)) {
      refuse('native tool intent is not persisted before execution or its invocation/results changed');
    }
    syncFile(file);
  }, refuse);
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
interface ProducerReceipt { readonly state: 'started' | 'ceased' | 'independent' | 'completed' | 'guard-refused' | 'retry-start'; readonly producer: DirectiveProducer; readonly checkpointId?: string; readonly head?: string | null; readonly toolCallId?: string; readonly boundary?: 'authority'; readonly reason?: string; readonly entryId?: string; readonly errorMessage?: string }
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
    if (state === 'retry-start' && (!nonBlank(receipt.entryId) || !nonBlank(receipt.errorMessage))) {
      throw new DirectiveCheckpointError('malformed native retry-start receipt');
    }
    if (!['started', 'ceased', 'independent', 'completed', 'guard-refused', 'retry-start'].includes(state) || !producer.incarnation || !Number.isSafeInteger(producer.pid) || producer.pid <= 0 ||
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonBlank(value: unknown): value is string { return typeof value === 'string' && value.trim() !== ''; }
/** What the pinned SDK's agent loop (pi-agent-core agent-loop.js) does with
 * an assistant row's tool calls: it runs none of an error or aborted row's
 * (owner ruling 2026-10-22, see validRetryErrorContent); it answers each of a
 * length row's with its own failed "not executed" result and goes on; it
 * runs a toolUse or stop row's (openai-completions and mistral end `stop`
 * while holding calls). Null for any other stop: never trusted. */
function rowCalls(stopReason: unknown): 'never-run' | 'not-executed' | 'executed' | null {
  if (stopReason === 'error' || stopReason === 'aborted') return 'never-run';
  if (stopReason === 'length') return 'not-executed';
  return stopReason === 'toolUse' || stopReason === 'stop' ? 'executed' : null;
}
/** Text, thinking and tool calls only. Owner ruling 2026-10-22: an error
 * row's tool calls, partial ones included, never ran (the SDK executes none),
 * so they are inert retry history when the row is retried, and owe no
 * results when it ends the turn. Unknown blocks, and text or thinking with
 * other keys, are never history. */
function validRetryErrorContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.every((value: unknown) => {
    const block = objectRecord(value);
    if (block?.['type'] === 'toolCall') return true;
    if (block?.['type'] === 'text') return typeof block['text'] === 'string' &&
      (block['textSignature'] === undefined || typeof block['textSignature'] === 'string') &&
      Object.keys(block).every((key) => ['type', 'text', 'textSignature'].includes(key));
    if (block?.['type'] === 'thinking') return typeof block['thinking'] === 'string' &&
      (block['thinkingSignature'] === undefined || typeof block['thinkingSignature'] === 'string') &&
      (block['redacted'] === undefined || typeof block['redacted'] === 'boolean') &&
      Object.keys(block).every((key) => ['type', 'thinking', 'thinkingSignature', 'redacted'].includes(key));
    return false;
  });
}
/** An assistant error row whose exact entry and error a live SDK retry-start
 * receipt names, holding only history content. Error text alone proves nothing. */
function isReceiptedErrorRow(entryId: string, message: Record<string, unknown>, evidence: ReadonlyMap<string, string>): boolean {
  return message['role'] === 'assistant' && message['stopReason'] === 'error' && typeof message['errorMessage'] === 'string' &&
    evidence.get(entryId) === message['errorMessage'] && validRetryErrorContent(message['content']);
}
/** The one retry-history predicate both walks use: a receipted error row the
 * SDK's retried answer (an assistant parented on it) follows. Its tool calls
 * never enter the pending set, so a result naming one is unmatched. Without
 * that answer (a retry cancelled during backoff) the row is the turn's
 * terminal. `successor` is read only for a receipted row. */
function isRetryHistoryRow(entry: NativeEntry, successor: () => NativeEntry | 'malformed' | undefined, evidence: ReadonlyMap<string, string>): boolean {
  if (entry.message === undefined || !isReceiptedErrorRow(entry.id, entry.message, evidence)) return false;
  const next = successor();
  return typeof next === 'object' && next.type === 'message' && next.parentId === entry.id && next.message?.role === 'assistant';
}
/** entryId → errorMessage from this exact directive's retry-start receipts,
 * whichever of its physical producers recorded them. */
function retryEvidence(receipts: readonly ProducerReceipt[], identity: DirectiveTurnIdentity): ReadonlyMap<string, string> {
  const evidence = new Map<string, string>();
  for (const row of receipts) {
    if (row.state !== 'retry-start' || !isDeepStrictEqual(row.producer.identity, identity)) continue;
    const prior = evidence.get(row.entryId!);
    if (prior !== undefined && prior !== row.errorMessage) throw new DirectiveCheckpointError('conflicting native retry-start receipts for one error row');
    evidence.set(row.entryId!, row.errorMessage!);
  }
  return evidence;
}
/** Called only for a live Pi `auto_retry_start` event, never synthesized from
 * history. Pi emits it from `_prepareRetry` after its retry classifier and
 * budget checks, once the error row is persisted and before that row leaves
 * the in-memory context. Recording checks the event, that the given row is an
 * error row carrying this retry's error and only history content, and the
 * directive's pi association and started producer; it then writes that
 * producer, the row's id and its error. It proves no ancestry: the walks do,
 * and they admit the row only with the retried answer after it. Null once
 * recorded, else why nothing was. */
export function recordDirectiveRetryStart(producer: DirectiveProducer, event: unknown, latestEntry: unknown): string | null {
  validateDirectiveIdentity(producer.identity);
  const sdkEvent = objectRecord(event);
  if (sdkEvent?.['type'] !== 'auto_retry_start') return 'not an SDK auto_retry_start event';
  const { attempt, maxAttempts, delayMs, errorMessage } = sdkEvent;
  // SDK delayMs is baseDelayMs·2^(attempt-1), and the configured base may be fractional.
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1 || !Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < (attempt as number) ||
      typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0 || !nonBlank(errorMessage)) return 'malformed SDK auto_retry_start event';
  const entry = objectRecord(latestEntry);
  const message = objectRecord(entry?.['message']);
  const entryId = entry?.['id'];
  if (entry?.['type'] !== 'message' || !nonBlank(entryId) || message === null ||
      !isReceiptedErrorRow(entryId, message, new Map([[entryId, errorMessage]]))) return 'native branch tail is not an error row of retry-history content carrying this retry\'s error';
  const binding = readDirectiveBinding(producer.sessionFile, producer.identity.requestId);
  if (binding === null || binding.runtime !== 'pi' || !isDeepStrictEqual(binding.identity, producer.identity)) return 'exact pi directive association unavailable';
  const rows = producerReceipts(producer.sessionFile);
  if (!rows.some((row) => row.state === 'started' && isDeepStrictEqual(row.producer, producer))) return 'exact original physical producer start missing';
  const prior = rows.filter((row) => row.state === 'retry-start' && row.entryId === entryId && isDeepStrictEqual(row.producer.identity, producer.identity));
  if (prior.some((row) => row.errorMessage !== errorMessage)) return 'conflicting retry-start receipt for this error row';
  if (!prior.some((row) => isDeepStrictEqual(row.producer, producer))) appendProducer({ state: 'retry-start', producer, entryId, errorMessage });
  else syncFile(`${producer.sessionFile}.producers.jsonl`);
  return null;
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
  validateDirectiveIdentity(identity);
  const prepared = readDirectiveBinding(file, identity.requestId);
  if (prepared === null || !isDeepStrictEqual(prepared.identity, identity) || prepared.runtime !== 'pi') {
    throw new DirectiveCheckpointError('exact native admission association unavailable');
  }
  const refuse = (reason = 'native tool intent is not persisted before execution or its invocation/results changed'): never => { throw new DirectiveCheckpointError(reason); };
  // One read (#469): the admission and the live turn, receipt first, every
  // entry with its own unique id.
  const { binding, native } = withPiTranscript(file, prepared.baseline, 'whole', (transcript) => {
    const admitted = admitPiDirective(file, prepared, transcript);
    const entries: NativeEntry[] = [];
    for (let entry = transcript.turn!(0); entry !== undefined; entry = transcript.turn!(entries.length)) {
      if (entry === 'malformed') refuse();
      entries.push(entry as NativeEntry);
    }
    return { binding: admitted, native: entries };
  });
  let index = native.length - 1;
  // Sequential batches persist results between preparations; the pinned SDK
  // prepares every parallel call before executing any or persisting results.
  // Only this invocation's contiguous, tree-linked results may follow it.
  while (index >= 0 && native[index]?.type === 'message' && native[index]?.message?.role === 'toolResult') index -= 1;
  const invocation = native[index];
  const content = invocation?.message?.content;
  if (invocation?.type !== 'message' || !invocation.id || invocation.message?.role !== 'assistant' || rowCalls(invocation.message.stopReason) !== 'executed' ||
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
  const retries = retryEvidence(producerReceipts(file), identity);
  for (const entry of native.slice(1)) {
    const message = entry.message;
    if (entry.type !== 'message' || entry.parentId !== ancestor || !message) refuse();
    ancestor = entry.id;
    if (message!.role === 'assistant') {
      if (chainPending.size > 0 || !Array.isArray(message!.content)) refuse();
      // An error row the live SDK retried past is history, not a tool invocation.
      if (!isRetryHistoryRow(entry, () => native[native.indexOf(entry) + 1], retries)) {
        if (message!.stopReason === 'error') {
          refuse(!retries.has(entry.id) || retries.get(entry.id) !== message!['errorMessage'] ? 'native error row has no matching live SDK retry-start receipt'
            : !isReceiptedErrorRow(entry.id, message!, retries) ? 'native receipted error row holds content that is not retry history'
              : 'native receipted error row has no retried answer after it');
        }
        // An executed row's calls, or a length row's, each get a result.
        const calls = rowCalls(message!.stopReason);
        if (calls !== 'executed' && calls !== 'not-executed') refuse();
        for (const block of message!.content as Record<string, unknown>[]) {
          if (block.type !== 'toolCall') continue;
          if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || typeof block.arguments !== 'object' || block.arguments === null || chainPending.has(block.id)) refuse();
          chainPending.set(block.id as string, block.name as string);
        }
        if (chainPending.size === 0) refuse();
      }
    } else if (message!.role === 'toolResult') {
      // An earlier failed call is ordinary work; the minion may go on.
      if (typeof message!.toolCallId !== 'string' || chainPending.get(message!.toolCallId) !== message!.toolName || typeof message!.isError !== 'boolean' || !Array.isArray(message!.content)) refuse();
      chainPending.delete(message!.toolCallId as string);
    } else refuse();
  }
  const requested = pending.get(toolCall.id);
  if ((executionMode === 'parallel' ? pending.size !== batchSize : pending.keys().next().value !== toolCall.id) ||
      requested?.name !== toolCall.name || !isDeepStrictEqual(requested.arguments, toolCall.arguments)) refuse();
  syncFile(file);
}
