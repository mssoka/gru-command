import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname } from 'node:path';

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
interface NativeEntry { readonly type: string; readonly id: string; readonly parentId?: string | null; readonly message?: Record<string, unknown> }
function entries(path: string): NativeEntry[] {
  const text = readFileSync(path, 'utf8');
  if (text !== '' && !text.endsWith('\n')) throw new DirectiveCheckpointError('native transcript has a partial entry');
  return text.trim() === '' ? [] : text.trimEnd().split('\n').map((line) => JSON.parse(line) as NativeEntry);
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
export function readDirectiveBinding(file: string, requestId: string): DirectiveNativeBinding | null {
  let raw: string;
  try { raw = readFileSync(proofPath(file), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!raw.endsWith('\n')) throw new DirectiveCheckpointError('directive native association has a partial write');
  const rows = raw.trimEnd().split('\n').map((line) => JSON.parse(line) as DirectiveNativeBinding)
    .filter((row) => row.identity.requestId === requestId);
  for (const row of rows) {
    validateDirectiveIdentity(row.identity);
    if (row.sessionFile !== file || !row.agentId || !row.sessionId || !row.authorityManifest || !/^[a-f0-9]{64}$/.test(row.promptHash)) {
      throw new DirectiveCheckpointError('directive native association is malformed');
    }
    const first = rows[0]!;
    if (!isDeepStrictEqual({ ...first, userEntryId: null }, { ...row, userEntryId: null })) {
      throw new DirectiveCheckpointError('conflicting native request associations');
    }
  }
  return rows.at(-1) ?? null;
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
  let parent = user.id;
  const pending = new Map<string, string>();
  let lastMessage = user.message;
  for (const entry of native.slice(start + 1)) {
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
        const ok = message.stopReason === 'stop';
        return { state: 'terminal', binding: admitted, checkpointId: parent, ok,
          error: ok ? null : String(message.errorMessage ?? `native stopReason: ${String(message.stopReason)}`) };
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
