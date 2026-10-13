import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeFileSync } from 'node:fs';
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
const MAX_NATIVE_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_NATIVE_TRANSCRIPT_ENTRIES = 250_000;
const MAX_DIRECTIVE_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTIVE_JOURNAL_ENTRIES = 100_000;
const MAX_NATIVE_LOCK_BYTES = 4 * 1024;
function readBoundedUtf8(path: string, limit: number, label: string): string {
  const fd = openSync(path, 'r');
  try {
    const initialSize = fstatSync(fd).size;
    if (initialSize > limit) throw new DirectiveCheckpointError(`${label} exceeds the ${limit}-byte inspection limit`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > limit) throw new DirectiveCheckpointError(`${label} exceeds the ${limit}-byte inspection limit`);
      chunks.push(chunk.subarray(0, count));
    }
    if (fstatSync(fd).size !== total) throw new DirectiveCheckpointError(`${label} changed during bounded inspection`);
    return Buffer.concat(chunks, total).toString('utf8');
  } finally { closeSync(fd); }
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
function entries(path: string): NativeEntry[] {
  const text = readBoundedUtf8(path, MAX_NATIVE_TRANSCRIPT_BYTES, 'native transcript');
  if (text !== '' && !text.endsWith('\n')) throw new DirectiveCheckpointError('native transcript has a partial entry');
  assertEntryLimit(text, MAX_NATIVE_TRANSCRIPT_ENTRIES, 'native transcript');
  if (text.trim() === '') return [];
  const lines = text.trimEnd().split('\n');
  return lines.map((line) => JSON.parse(line) as NativeEntry);
}
/** Header facts use the same bounded read as checkpoint inspection. They
 * identify a session/cwd, never admission, completion or work authority. */
export function readDirectiveSessionHeader(file: string): { readonly type?: unknown; readonly id?: unknown; readonly cwd?: unknown } {
  const text = readBoundedUtf8(file, MAX_NATIVE_TRANSCRIPT_BYTES, 'native transcript');
  const end = text.indexOf('\n');
  if (end < 0) throw new DirectiveCheckpointError('native transcript has no complete session header');
  const header = JSON.parse(text.slice(0, end)) as unknown;
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
  const native = entries(input.sessionFile);
  const content = [ { type: 'text', text: input.text },
    ...(input.images ?? []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mediaType })) ];
  const binding: DirectiveNativeBinding = { identity: input.identity, runtime: input.runtime, agentId: input.agentId,
    sessionId: input.sessionId, sessionFile: input.sessionFile, baseline: native.filter((entry) => entry.type !== 'session').at(-1)?.id ?? null,
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
  if (binding === null || binding.runtime !== 'pi' || !isDeepStrictEqual(binding.identity, identity)) throw new DirectiveCheckpointError('exact native admission association unavailable');
  const text = readBoundedUtf8(file, MAX_NATIVE_TRANSCRIPT_BYTES, 'native transcript');
  assertEntryLimit(text, MAX_NATIVE_TRANSCRIPT_ENTRIES, 'native transcript');
  const lines = text.split('\n'); lines.pop(); // a partial tail cannot undo an accepted prefix
  const header = JSON.parse(lines[0] ?? 'null') as NativeEntry | null;
  if (header?.type !== 'session' || header.id !== binding.sessionId) throw new DirectiveCheckpointError('native admission session identity mismatch');
  let baselineFound = binding.baseline === null;
  const ids = new Set<string>([header.id]);
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as NativeEntry;
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new DirectiveCheckpointError('malformed/rebound native admission prefix');
    ids.add(entry.id);
    if (!baselineFound) { baselineFound = entry.id === binding.baseline; continue; }
    if (entry.type !== 'message' || entry.message?.role !== 'user' || entry.parentId !== binding.baseline || !Array.isArray(entry.message.content) ||
        contentHash(entry.message.content) !== binding.promptHash || binding.userEntryId !== null && binding.userEntryId !== entry.id) {
      throw new DirectiveCheckpointError('actual native admission user receipt unavailable/changed');
    }
    syncFile(file);
    const admitted = { ...binding, userEntryId: entry.id };
    if (binding.userEntryId === null) appendBinding(admitted);
    return admitted;
  }
  throw new DirectiveCheckpointError('actual native admission user receipt unavailable');
}

/** Native transcript readback owns proof. Pi entries are tree-linked: only
 * the exact direct user child of the prepared baseline is admitted. A
 * missing result, branch/compaction or another prompt refuses continuation. */
export function inspectDirectiveCheckpoint(file: string, identity: DirectiveTurnIdentity): DirectiveCheckpoint {
  validateDirectiveIdentity(identity);
  const binding = readDirectiveBinding(file, identity.requestId);
  const unknown = (reason: string): DirectiveCheckpoint => ({ state: 'unknown', reason });
  if (binding === null || !isDeepStrictEqual(binding.identity, identity)) return unknown('exact native request association unavailable');
  if (binding.runtime !== 'pi') return unknown('claude-code does not attest an exact resumable request checkpoint');
  const native = entries(file);
  const header = native[0] as (NativeEntry & { readonly id?: string }) | undefined;
  if (header?.type !== 'session' || header.id !== binding.sessionId) return unknown('native session identity mismatch');
  const ids = new Set<string>([header.id]);
  for (const entry of native.slice(1)) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '' || ids.has(entry.id)) return unknown('native checkpoint has a malformed or duplicate entry identity');
    ids.add(entry.id);
  }
  const start = binding.baseline === null ? 1 : native.findIndex((entry) => entry.id === binding.baseline) + 1;
  if (start <= 0) return unknown('native baseline unavailable');
  const user = native[start];
  if (user?.type !== 'message' || user.message?.role !== 'user' || user.parentId !== binding.baseline ||
      contentHash(user.message.content) !== binding.promptHash || !user.id) return unknown('actual native request receipt unavailable');
  if (binding.userEntryId !== null && user.id !== binding.userEntryId) return unknown('native request receipt changed');
  // The native receipt is durably flushed before the product admission callback.
  syncFile(file);
  const admitted = { ...binding, userEntryId: user.id };
  if (binding.userEntryId === null) appendBinding(admitted);
  if (producerReceipts(file).some((row) => row.state === 'guard-refused' && isDeepStrictEqual(row.producer.identity, identity))) return unknown('native directive tool boundary refused; exact turn remains incomplete');
  let parent = user.id;
  const pending = new Map<string, string>();
  let lastMessage = user.message;
  let terminal = false;
  for (const entry of native.slice(start + 1)) {
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
interface ProducerReceipt { readonly state: 'started' | 'ceased' | 'independent' | 'completed' | 'guard-refused'; readonly producer: DirectiveProducer; readonly checkpointId?: string; readonly head?: string | null; readonly toolCallId?: string; readonly reason?: string }
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
    if (state === 'guard-refused' && (!receipt.toolCallId || !receipt.reason)) throw new DirectiveCheckpointError('malformed native tool refusal receipt');
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
  return rows.filter((row) => row.state === 'started').map(({ producer }) => {
    if (rows.some((row) => row.state === 'ceased' && isDeepStrictEqual(row.producer, producer))) return { producer, evidence: 'ceased' as const };
    if (rows.some((row) => row.state === 'independent' && isDeepStrictEqual(row.producer, producer))) return { producer, evidence: 'unknown' as const };
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

export function recordDirectiveIndependentController(producer: DirectiveProducer): void { appendProducer({ state: 'independent', producer }); }
/** Called by the real SDK beforeToolCall hook, after its awaited message
 * persistence. No tool can execute unless its exact intent is durably on disk. */
export function flushDirectiveToolIntent(file: string, assistantMessage: unknown, toolCall: {
  readonly id: string; readonly name: string; readonly arguments: unknown;
}, identity: DirectiveTurnIdentity, executionMode: 'sequential' | 'parallel' = 'sequential'): void {
  const native = entries(file);
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
  const binding = inspectDirectiveAdmission(file, identity);
  const start = native.findIndex((entry) => entry.id === binding.userEntryId);
  if (start < 1 || start >= index) refuse();
  let ancestor = binding.userEntryId;
  const chainPending = new Map<string, string>();
  const ids = new Set(native.slice(0, start + 1).map((entry) => entry.id));
  for (const entry of native.slice(start + 1)) {
    const message = entry.message;
    if (entry.type !== 'message' || !entry.id || ids.has(entry.id) || entry.parentId !== ancestor || !message) refuse();
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
