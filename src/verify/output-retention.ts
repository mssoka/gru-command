import type { VerificationOutcome, VerificationProgress } from './scheduler.js';

/**
 * In-memory retained run output for reconnect replay (issue #554).
 *
 * The observed failure: a capture helper whose response headers took longer
 * than its 60 s bound gave up and wrote a 0-byte `unknown` receipt, while the
 * service still queued and completed the run — the run's complete output was
 * lost to everyone but the ledger's tail. The scheduler now keeps every
 * `output` frame of each run IN MEMORY from the first byte, so a same
 * `request_id` re-submit can be handed the frames it missed (a replayed
 * prefix) before the live stream continues, or the complete output of a run
 * that already finished.
 *
 * The store is deliberately separate from the bounded 64-entry
 * `requestHistory`: evicting a terminal identity from that history must never
 * drop output younger than the retention window. It is bounded twice —
 * {@link RETAINED_OUTPUT_PER_RUN_MAX_BYTES} per run and
 * {@link RETAINED_OUTPUT_TOTAL_MAX_BYTES} across runs — and completed output
 * is kept {@link RETAINED_OUTPUT_WINDOW_MS} after completion, measured on the
 * scheduler's injectable clock. Total-cap pressure evicts the oldest retained
 * output first.
 *
 * Retention is memory only: it never survives a service restart, and a replay
 * after one honestly reports `replayed_output: "none"`.
 */

/** Completed runs' output is retained this long after completion. */
export const RETAINED_OUTPUT_WINDOW_MS = 30 * 60 * 1000;
/** At most this much output is retained for one run. */
export const RETAINED_OUTPUT_PER_RUN_MAX_BYTES = 8 * 1024 * 1024;
/** At most this much output is retained across every run. */
export const RETAINED_OUTPUT_TOTAL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * How much of a run's output a replay carried:
 *  - `complete`: every output frame from the first byte was replayed;
 *  - `incomplete`: some output is missing (the per-run cap dropped frames, or
 *    total-cap pressure cleared a live run's retained prefix);
 *  - `none`: nothing was retained (evicted, past the window, or a restart).
 */
export type ReplayedOutput = 'complete' | 'incomplete' | 'none';

/** One streamed `output` progress frame: the sink's own frame vocabulary. */
export type RetainedOutputFrame = Extract<VerificationProgress, { readonly type: 'output' }>;

export interface RetainedOutputReplay {
  /** The retained frames from byte 0, snapshotted at the call. */
  readonly frames: readonly RetainedOutputFrame[];
  readonly replayed: ReplayedOutput;
}

export interface OutputRetentionOptions {
  /** The scheduler's clock (injectable; the window is measured on it). */
  readonly now: () => number;
  /** Test seams; production uses the exported pins above. */
  readonly windowMs?: number;
  readonly perRunMaxBytes?: number;
  readonly totalMaxBytes?: number;
}

interface RetainedOutputEntry {
  readonly runId: string;
  readonly frames: RetainedOutputFrame[];
  bytes: number;
  /** False once a frame was dropped: a later replay has a gap. */
  complete: boolean;
  /** Completion time on the injected clock; null while the run is live. */
  completedAt: number | null;
  outcome: VerificationOutcome | null;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`output retention ${label} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

export class OutputRetention {
  private readonly entries = new Map<string, RetainedOutputEntry>();
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly perRunMaxBytes: number;
  private readonly totalMaxBytes: number;
  private totalBytes = 0;

  constructor(options: OutputRetentionOptions) {
    this.now = options.now;
    this.windowMs = positiveInteger(options.windowMs ?? RETAINED_OUTPUT_WINDOW_MS, 'windowMs');
    this.perRunMaxBytes = positiveInteger(
      options.perRunMaxBytes ?? RETAINED_OUTPUT_PER_RUN_MAX_BYTES,
      'perRunMaxBytes',
    );
    this.totalMaxBytes = positiveInteger(
      options.totalMaxBytes ?? RETAINED_OUTPUT_TOTAL_MAX_BYTES,
      'totalMaxBytes',
    );
    if (this.perRunMaxBytes > this.totalMaxBytes) {
      throw new Error(
        `output retention per-run cap ${String(this.perRunMaxBytes)} exceeds the total cap ${String(this.totalMaxBytes)} — ` +
          'one run could never be retained whole',
      );
    }
  }

  /** Retained output bytes across every run (bounded by the total cap). */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Runs whose output is currently retained (live and completed). */
  get runs(): number {
    return this.entries.size;
  }

  /**
   * Open a live entry before its first byte so a same-`request_id` re-submit
   * that arrives while the run is still queued is answered `complete` with
   * zero frames (nothing produced yet), never a false `none` (which means the
   * output was lost). Idempotent.
   */
  begin(runId: string): void {
    this.entryFor(runId);
  }

  /**
   * Retain one output frame from the moment it is first streamed. Once the
   * per-run cap is crossed the entry stops retaining (and reports
   * `incomplete`) rather than silently replacing earlier bytes.
   */
  retain(frame: RetainedOutputFrame): void {
    const entry = this.entryFor(frame.runId);
    if (!entry.complete) return;
    const bytes = Buffer.byteLength(frame.text, 'utf8');
    if (entry.bytes + bytes > this.perRunMaxBytes) {
      entry.complete = false;
      return;
    }
    entry.frames.push(frame);
    entry.bytes += bytes;
    this.totalBytes += bytes;
    if (this.totalBytes > this.totalMaxBytes) this.evictOldest();
  }

  /**
   * Bind the run's recorded outcome and start its retention window. Called
   * once the run has genuinely settled; a run that produced no output still
   * gets an entry, so a reconnect replays "nothing at all" as `complete`.
   */
  complete(runId: string, outcome: VerificationOutcome): void {
    this.prune();
    const entry = this.entryFor(runId);
    entry.outcome = outcome;
    entry.completedAt = this.now();
    if (this.totalBytes > this.totalMaxBytes) this.evictOldest();
  }

  /** Drop everything retained for a run that settled without an outcome. */
  discard(runId: string): void {
    const entry = this.entries.get(runId);
    if (entry === undefined) return;
    this.totalBytes -= entry.bytes;
    this.entries.delete(runId);
  }

  /**
   * The frames a same-`request_id` re-submit missed, snapshotted so a later
   * live frame can never be replayed twice.
   */
  replay(runId: string): RetainedOutputReplay {
    this.prune();
    const entry = this.entries.get(runId);
    if (entry === undefined) return { frames: [], replayed: 'none' };
    return { frames: [...entry.frames], replayed: entry.complete ? 'complete' : 'incomplete' };
  }

  /**
   * A completed run's recorded outcome, read from retention. This is the
   * fallback that keeps output reachable after the 64-entry request history
   * evicts a terminal identity inside the retention window.
   */
  recordedOutcome(runId: string): VerificationOutcome | null {
    this.prune();
    return this.entries.get(runId)?.outcome ?? null;
  }

  /** Drop completed output past the retention window (lazy, on access). */
  prune(): void {
    const now = this.now();
    for (const [runId, entry] of this.entries) {
      if (entry.completedAt === null || now - entry.completedAt <= this.windowMs) continue;
      this.totalBytes -= entry.bytes;
      this.entries.delete(runId);
    }
  }

  private entryFor(runId: string): RetainedOutputEntry {
    const existing = this.entries.get(runId);
    if (existing !== undefined) return existing;
    const created: RetainedOutputEntry = {
      runId,
      frames: [],
      bytes: 0,
      complete: true,
      completedAt: null,
      outcome: null,
    };
    this.entries.set(runId, created);
    return created;
  }

  /**
   * Total-cap pressure evicts the oldest retained output first (map insertion
   * order). A completed run's entry is dropped whole; a live attempt's entry
   * keeps its place with an empty, `incomplete` marker, so a later attach
   * reports missing output instead of implying nothing has been produced.
   */
  private evictOldest(): void {
    for (const [runId, entry] of this.entries) {
      if (this.totalBytes <= this.totalMaxBytes) return;
      this.totalBytes -= entry.bytes;
      if (entry.completedAt === null) {
        entry.frames.length = 0;
        entry.bytes = 0;
        entry.complete = false;
        continue;
      }
      this.entries.delete(runId);
    }
  }
}
