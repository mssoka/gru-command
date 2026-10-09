import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isValidVerificationRequestId } from './scheduler.js';

/**
 * Supported verification capture (issue #159). The observed incident: six
 * agent-authored watchers redirected their POST /api/verify streams into
 * ONE truncating NDJSON sink, and the preserved snapshot held two request
 * streams plus a torn record. This module is the supported replacement for
 * that hand-rolled orchestration:
 *
 *  - the sink is created EXCLUSIVELY before the POST (`wx`), never
 *    truncated, never shared — a second capture for the same path is a
 *    typed refusal, not a silent interleave;
 *  - an owner record names the capture process (pid, start time, cwd,
 *    command, request identity) so a stale helper can be withdrawn by
 *    identity validation only — malformed pid records, crashes and
 *    recycled pids never redirect a kill at an unrelated process;
 *  - a terminal receipt binds run id, true head/dirty state, exit/outcome
 *    and output length/hash — and a stream without a valid terminal
 *    completion is NEVER promoted to success ("no partial/missing
 *    completion promoted to success").
 */

export const CAPTURE_OWNER_VERSION = 1;
export const CAPTURE_RECEIPT_VERSION = 1;

// ------------------------------------------------------------------
// Exclusive sink
// ------------------------------------------------------------------

export class CaptureSinkExistsError extends Error {
  readonly code = 'sink_exists';
  constructor(readonly sinkPath: string) {
    super(
      `capture sink ${sinkPath} already exists — a sink is exclusively owned and never truncated; ` +
        'choose a new path or withdraw/reconcile the previous capture',
    );
    this.name = 'CaptureSinkExistsError';
  }
}

export interface CaptureSinkDigest {
  readonly bytes: number;
  readonly sha256: string;
}

export interface ExclusiveCaptureSink extends CaptureSinkDigest {
  readonly path: string;
  write(text: string): void;
  close(): CaptureSinkDigest;
}

/**
 * Open a capture sink exclusively. `wx` makes creation atomic: the caller
 * that loses the race gets a typed error instead of sharing the file. The
 * parent directory is created first so the sink genuinely exists BEFORE
 * the POST reaches the scheduler.
 */
export function openExclusiveCaptureSink(path: string): ExclusiveCaptureSink {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CaptureSinkExistsError(path);
    throw error;
  }
  const hash = createHash('sha256');
  let bytes = 0;
  let digest: CaptureSinkDigest | null = null;
  return {
    path,
    get bytes(): number {
      return bytes;
    },
    get sha256(): string {
      return digest?.sha256 ?? hash.copy().digest('hex');
    },
    write(text: string): void {
      if (digest !== null) throw new Error(`capture sink ${path} is already closed`);
      const buffer = Buffer.from(text, 'utf8');
      writeSync(fd, buffer);
      hash.update(buffer);
      bytes += buffer.length;
    },
    close(): CaptureSinkDigest {
      if (digest === null) {
        fsyncSync(fd);
        closeSync(fd);
        digest = { bytes, sha256: hash.digest('hex') };
      }
      return digest;
    },
  };
}

// ------------------------------------------------------------------
// Owner records
// ------------------------------------------------------------------

export interface CaptureOwnerRecord {
  readonly version: 1;
  readonly pid: number;
  /** `null` when this host could not read the process start time. */
  readonly start_time: string | null;
  readonly cwd: string;
  readonly command: string;
  readonly request_id: string;
  readonly sink: string;
  readonly run_id: string | null;
  readonly created_at: string;
}

export type CaptureOwnerRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'owner'; readonly record: CaptureOwnerRecord };

export function captureOwnerPath(sinkPath: string): string {
  return `${sinkPath}.owner.json`;
}

export function captureReceiptPath(sinkPath: string): string {
  return `${sinkPath}.receipt.json`;
}

/** Validate an arbitrary parsed value as an owner record. */
export function parseCaptureOwner(value: unknown): CaptureOwnerRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['version'] !== CAPTURE_OWNER_VERSION) return null;
  const pid = record['pid'];
  const startTime = record['start_time'];
  const cwd = record['cwd'];
  const command = record['command'];
  const requestId = record['request_id'];
  const sink = record['sink'];
  const runId = record['run_id'];
  const createdAt = record['created_at'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (startTime !== null && (typeof startTime !== 'string' || startTime === '')) return null;
  if (typeof cwd !== 'string' || cwd === '') return null;
  if (typeof command !== 'string' || command === '') return null;
  if (typeof requestId !== 'string' || !isValidVerificationRequestId(requestId)) return null;
  if (typeof sink !== 'string' || sink === '') return null;
  if (runId !== null && typeof runId !== 'string') return null;
  if (typeof createdAt !== 'string' || createdAt === '') return null;
  return {
    version: CAPTURE_OWNER_VERSION,
    pid,
    start_time: startTime,
    cwd,
    command,
    request_id: requestId,
    sink,
    run_id: runId,
    created_at: createdAt,
  };
}

export function readCaptureOwner(path: string): CaptureOwnerRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'malformed', detail: `unreadable: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: 'malformed', detail: `not valid JSON: ${String(error)}` };
  }
  const record = parseCaptureOwner(parsed);
  if (record === null) return { kind: 'malformed', detail: 'owner record shape is not supported' };
  return { kind: 'owner', record };
}

export class CaptureOwnerExistsError extends Error {
  readonly code = 'owner_exists';
  constructor(readonly ownerPath: string) {
    super(`capture owner record ${ownerPath} already exists — refusing to overwrite a live claim`);
    this.name = 'CaptureOwnerExistsError';
  }
}

/** Write the owner claim exclusively (a second claim loses loudly). */
export function writeCaptureOwner(path: string, record: CaptureOwnerRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CaptureOwnerExistsError(path);
    throw error;
  }
}

export function removeCaptureOwner(path: string): boolean {
  try {
    rmSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// ------------------------------------------------------------------
// Identity-validated withdrawal
// ------------------------------------------------------------------

/** A point-in-time reading of one operating-system process. */
export interface ProcessProbe {
  readonly alive: boolean;
  readonly startTime: string | null;
  readonly cwd: string | null;
  readonly command: string | null;
}

export type WithdrawVerdict = 'withdrawn' | 'stale-cleared' | 'refused';

export interface WithdrawResult {
  readonly verdict: WithdrawVerdict;
  readonly reason: string;
  readonly pid: number | null;
}

export interface WithdrawDeps {
  readonly probe: (pid: number) => ProcessProbe;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** Grace between the withdrawal SIGTERM and the fallback SIGKILL. */
  readonly killGraceMs: number;
}

/**
 * Withdraw an owned capture helper by IDENTITY only. The record's pid is
 * signalled only when the live process' start time, command and cwd agree
 * with the record; a malformed record, a dead owner (stale claim), or any
 * identity mismatch is resolved without touching the named pid. Sink and
 * receipt files are never deleted — existing results are preserved.
 */
export async function withdrawCaptureOwner(
  ownerPath: string,
  deps: WithdrawDeps,
): Promise<WithdrawResult> {
  const read = readCaptureOwner(ownerPath);
  if (read.kind === 'missing') {
    return { verdict: 'refused', reason: 'no owner record at this path', pid: null };
  }
  if (read.kind === 'malformed') {
    return {
      verdict: 'refused',
      reason: `malformed owner record (${read.detail}) — no signal sent`,
      pid: null,
    };
  }
  const record = read.record;
  const before = deps.probe(record.pid);
  if (!before.alive) {
    removeCaptureOwner(ownerPath);
    return { verdict: 'stale-cleared', reason: 'recorded owner is gone', pid: record.pid };
  }
  const mismatch = identityMismatch(record, before);
  if (mismatch !== null) {
    return { verdict: 'refused', reason: mismatch, pid: record.pid };
  }
  deps.signal(record.pid, 'SIGTERM');
  await deps.sleep(deps.killGraceMs);
  const after = deps.probe(record.pid);
  if (!after.alive) {
    removeCaptureOwner(ownerPath);
    return { verdict: 'withdrawn', reason: 'owner identity validated and withdrawn', pid: record.pid };
  }
  // The pid may have been recycled during the grace window: revalidate the
  // SAME identity before escalating — an unrelated replacement is never
  // signalled.
  const afterMismatch = identityMismatch(record, after);
  if (afterMismatch !== null) {
    removeCaptureOwner(ownerPath);
    return {
      verdict: 'stale-cleared',
      reason: `owner exited during the grace period; replacement left untouched (${afterMismatch})`,
      pid: record.pid,
    };
  }
  deps.signal(record.pid, 'SIGKILL');
  removeCaptureOwner(ownerPath);
  return { verdict: 'withdrawn', reason: 'owner identity validated and withdrawn', pid: record.pid };
}

/**
 * Compare a live probe against the recorded identity, or null when the
 * identity is PROVEN. Start time and command are required: when either
 * side cannot be read, the identity is unverifiable and the caller must
 * refuse rather than signal a possibly-recycled pid.
 */
export function identityMismatch(record: CaptureOwnerRecord, probe: ProcessProbe): string | null {
  if (record.start_time === null || probe.startTime === null || probe.command === null) {
    return `owner identity for pid ${String(record.pid)} is unverifiable (start time/command unavailable) — no signal sent`;
  }
  const comparisons: { readonly field: string; readonly recorded: string; readonly live: string }[] = [
    { field: 'start time', recorded: record.start_time, live: probe.startTime },
    { field: 'command', recorded: record.command, live: probe.command },
  ];
  if (probe.cwd !== null) {
    comparisons.push({ field: 'cwd', recorded: record.cwd, live: probe.cwd });
  }
  for (const comparison of comparisons) {
    if (comparison.recorded !== comparison.live) {
      return `owner identity mismatch on ${comparison.field} for pid ${String(record.pid)} — no signal sent`;
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Terminal receipt
// ------------------------------------------------------------------

export type CaptureOutcome = 'completed' | 'unknown' | 'admission-failed';

export interface CaptureReceipt {
  readonly version: 1;
  readonly request_id: string;
  readonly sink: string;
  readonly outcome: CaptureOutcome;
  /** True when the terminal frame was a recorded-outcome replay: the run's
   * outcome is known, but this sink is NOT the original full capture. */
  readonly reconciled: boolean;
  /** Producer frames (queued/attached/started/output/one terminal). */
  readonly frames: number;
  /** Transport liveness frames (`ping`) — kept out of `frames` so the
   * producer-frame count stays the diagnostic it always was. */
  readonly pings: number;
  readonly capture_bytes: number;
  readonly capture_sha256: string;
  readonly run_id: string | null;
  readonly head: string | null;
  readonly expected_head: string | null;
  readonly tracked_dirty: boolean | null;
  readonly ok: boolean | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly timed_out: boolean | null;
  readonly output_bytes: number | null;
  readonly output_sha256: string | null;
  readonly started: boolean;
  readonly error: string | null;
  readonly completed_at: string;
}

export function writeCaptureReceipt(path: string, receipt: CaptureReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readCaptureReceipt(path: string): CaptureReceipt | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as CaptureReceipt;
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== CAPTURE_RECEIPT_VERSION) {
      return null;
    }
    // `pings` shipped after receipts already existed: a pre-keepalive receipt
    // truthfully carried zero transport frames, so normalize rather than
    // handing consumers an undefined count.
    return { ...parsed, pings: typeof parsed.pings === 'number' ? parsed.pings : 0 };
  } catch {
    return null;
  }
}

/**
 * The ONLY success predicate. A completed run is promoted to success only
 * when the terminal outcome binds run id, a real clean head, a zero exit
 * and an output hash, was not a recorded-outcome replay, and the
 * caller-named head (when given) matches; an unknown/admission-failed
 * stream is never success.
 */
export function captureReceiptSucceeded(receipt: CaptureReceipt): boolean {
  return (
    receipt.outcome === 'completed' &&
    receipt.reconciled !== true &&
    receipt.ok === true &&
    receipt.exit_code === 0 &&
    receipt.run_id !== null &&
    receipt.head !== null &&
    receipt.tracked_dirty === false &&
    receipt.output_sha256 !== null &&
    receipt.output_sha256 !== '' &&
    receipt.error === null &&
    (receipt.expected_head === null || receipt.expected_head === receipt.head)
  );
}

// ------------------------------------------------------------------
// NDJSON capture parsing
// ------------------------------------------------------------------

export interface CapturedNdjson {
  /** Producer frames (queued/attached/started/output/one terminal). */
  readonly frames: number;
  /** Transport liveness frames (`ping`); never producer frames. */
  readonly pings: number;
  readonly malformed: number;
  /** The terminal `completed` frame's outcome payload, if a valid one arrived. */
  readonly outcome: Record<string, unknown> | null;
  /** True when that terminal frame was a recorded-outcome replay. */
  readonly reconciled: boolean;
  readonly started: boolean;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
}

/** Bound on a single buffered line before it is treated as a torn record. */
const MAX_PARTIAL_LINE_BYTES = 1024 * 1024;

/**
 * Incremental NDJSON capture reader. Parses line by line so a long output
 * never accumulates in memory, enforces ONE run identity and exactly one
 * terminal frame at the END of the stream, and counts torn/foreign records
 * instead of silently accepting them. A capture with malformed records, a
 * second run's frames, or frames after the terminal frame is not a clean
 * single-run stream and must never be promoted to success. Transport
 * keepalive `ping` frames are counted separately (`pings`), never as
 * producer frames.
 */
export class NdjsonCaptureReader {
  private buffer = '';
  private frames = 0;
  private pings = 0;
  private malformed = 0;
  private outcome: Record<string, unknown> | null = null;
  private reconciled = false;
  private started = false;
  private errorCode: string | null = null;
  private errorDetail: string | null = null;
  private runId: string | null = null;
  private terminalSeen = false;

  push(text: string): void {
    this.buffer += text;
    for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.acceptLine(line);
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_PARTIAL_LINE_BYTES) {
      this.malformed += 1;
      this.buffer = '';
    }
  }

  finish(): CapturedNdjson {
    if (this.buffer.trim() !== '') {
      const line = this.buffer;
      this.buffer = '';
      this.acceptLine(line);
    }
    return {
      frames: this.frames,
      pings: this.pings,
      malformed: this.malformed,
      outcome: this.outcome,
      reconciled: this.reconciled,
      started: this.started,
      errorCode: this.errorCode,
      errorDetail: this.errorDetail,
    };
  }

  private acceptLine(line: string): void {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.malformed += 1;
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.malformed += 1;
      return;
    }
    this.acceptFrame(parsed as Record<string, unknown>);
  }

  private acceptFrame(frame: Record<string, unknown>): void {
    if (this.terminalSeen) {
      // Frames after the terminal frame are a concatenated/foreign stream
      // (a keepalive ping included — the terminal is the last body frame).
      this.malformed += 1;
      return;
    }
    if (frame['type'] === 'ping') {
      // Transport liveness, not producer output: counted apart so the
      // receipt's producer-frame count keeps its diagnostic meaning.
      this.pings += 1;
      return;
    }
    this.frames += 1;
    const frameRunId =
      typeof frame['runId'] === 'string' && frame['runId'] !== '' ? frame['runId'] : null;
    if (frameRunId !== null) {
      if (this.runId === null) {
        this.runId = frameRunId;
      } else if (this.runId !== frameRunId) {
        this.malformed += 1;
        return;
      }
    }
    const type = frame['type'];
    if (type === 'started' || (type === 'attached' && frame['state'] === 'running')) this.started = true;
    if (type === 'completed') {
      this.terminalSeen = true;
      if (frame['reconciled'] === true) this.reconciled = true;
      const candidate = frame['outcome'];
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        this.malformed += 1;
        return;
      }
      const outcome = candidate as Record<string, unknown>;
      const outcomeRunId = typeof outcome['runId'] === 'string' ? outcome['runId'] : '';
      const sha = outcome['sha'];
      if (
        outcomeRunId !== '' &&
        (this.runId === null || outcomeRunId === this.runId) &&
        typeof outcome['ok'] === 'boolean' &&
        typeof outcome['trackedDirty'] === 'boolean' &&
        typeof outcome['outputBytes'] === 'number' &&
        Number.isFinite(outcome['outputBytes']) &&
        typeof outcome['outputSha256'] === 'string' &&
        outcome['outputSha256'] !== '' &&
        typeof sha === 'string' &&
        sha !== ''
      ) {
        this.runId = outcomeRunId;
        this.outcome = outcome;
      } else {
        this.malformed += 1;
      }
    }
    if (type === 'error') {
      if (typeof frame['code'] === 'string') this.errorCode = frame['code'];
      if (typeof frame['detail'] === 'string') this.errorDetail = frame['detail'];
    }
  }
}

/** One-shot wrapper over {@link NdjsonCaptureReader} (tests, small bodies). */
export function parseCapturedNdjson(text: string): CapturedNdjson {
  const reader = new NdjsonCaptureReader();
  reader.push(text.endsWith('\n') ? text : `${text}\n`);
  return reader.finish();
}

/** The receipt identity fields read out of a terminal outcome payload. */
export interface CapturedOutcomeFields {
  readonly runId: string;
  readonly head: string | null;
  readonly trackedDirty: boolean;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputBytes: number;
  readonly outputSha256: string;
}

export function capturedOutcomeFields(outcome: Record<string, unknown>): CapturedOutcomeFields {
  const str = (key: string): string | null => (typeof outcome[key] === 'string' ? (outcome[key] as string) : null);
  const num = (key: string): number | null =>
    typeof outcome[key] === 'number' && Number.isFinite(outcome[key]) ? (outcome[key] as number) : null;
  return {
    runId: str('runId') ?? '',
    head: str('sha'),
    trackedDirty: outcome['trackedDirty'] === true,
    ok: outcome['ok'] === true,
    exitCode: num('exitCode'),
    signal: str('signal'),
    timedOut: outcome['timedOut'] === true,
    outputBytes: num('outputBytes') ?? 0,
    outputSha256: str('outputSha256') ?? '',
  };
}
