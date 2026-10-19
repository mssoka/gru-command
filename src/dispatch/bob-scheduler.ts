import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { LogLevel } from '../logger.js';
import type { AgentHandle, SpawnOptions } from '../runtime/types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Bob's periodic consolidation trigger (EPICS E8 story 4): on an
 * interval, prompt the bob role's supervised slot with consolidation
 * instructions. Bob himself is memory, not mechanics — this scheduler
 * only knocks; the role's prompt (roles/bob.md) governs the craft.
 * Interval 0 disables the trigger entirely.
 *
 * Due-based since issue #451: the next knock is due
 * `lastBobAt + intervalMs`, read from persisted state at start, so a
 * restart no longer resets the cadence (with a weekly interval and a
 * service that restarts more often than that, a boot-armed plain
 * setInterval would never fire). The boot beat fires only when due; a
 * restart mid-interval waits out the remainder as the first beat.
 */

/** The supervised-slot surface the scheduler needs. */
export interface BobSlot {
  ensure(options?: SpawnOptions): Promise<AgentHandle>;
}

export const BOB_CONSOLIDATION_PROMPT = [
  'Periodic memory consolidation is due.',
  'Review the job close-outs, review findings, and notes recorded since',
  'your last consolidation; extract the durable lessons (decisions and',
  'their reasons, patterns that worked, pitfalls that cost time,',
  'corrections worth keeping) and consolidate them into memory files',
  'with provenance, per your standing orders. Never invent events;',
  'never rewrite history. Finish with a one-paragraph summary of what',
  'you consolidated.',
].join(' ');

/** The persisted schedule file, under the instance's data home. */
export const BOB_STATE_FILE = 'bob-state.json';

export class BobScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BobScheduleError';
  }
}

/** The persisted schedule: when the last consolidation COMPLETED. */
export interface BobState {
  readonly version: 1;
  readonly lastBobAt: string | null;
}

/** Read the persisted schedule; a missing file means never consolidated
 * (due now). An unreadable file fails loud — refusing to guess whether a
 * week has passed keeps a corrupt record from silencing Bob or
 * over-running him. */
export function loadBobState(file: string): BobState {
  if (!existsSync(file)) return { version: 1, lastBobAt: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new BobScheduleError(
      `bob state ${file} is unreadable (${String(error)}); refusing to guess — inspect or remove the file`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BobScheduleError(`bob state ${file} is not an object — inspect or remove the file`);
  }
  const row = parsed as Record<string, unknown>;
  if (row['version'] !== 1) {
    throw new BobScheduleError(`bob state ${file} has an unsupported version — inspect or remove the file`);
  }
  const lastBobAt = row['lastBobAt'];
  if (lastBobAt !== null && (typeof lastBobAt !== 'string' || Number.isNaN(Date.parse(lastBobAt)))) {
    throw new BobScheduleError(`bob state ${file} has an invalid lastBobAt — inspect or remove the file`);
  }
  return { version: 1, lastBobAt };
}

/** Write the schedule atomically: a crash leaves either the old record or
 * the new one, never a half-written file. */
export function saveBobState(file: string, state: BobState): void {
  const staging = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    renameSync(staging, file);
  } catch (error) {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* best effort — the active state was never replaced */
    }
    throw new BobScheduleError(`could not write bob state ${file}: ${String(error)}`);
  }
}

/** The state seam: production persists to `BOB_STATE_FILE` (bobStateFile),
 * tests inject an in-memory record. */
export interface BobStatePort {
  /** The last completed consolidation (ISO instant) or null (never). */
  lastBobAt(): string | null;
  /** Record a completed consolidation; a failed beat never calls this. */
  recordBeat(at: Date): void;
}

/** Production wiring: the schedule persists under the instance data home. */
export function bobStateFile(file: string): BobStatePort {
  return {
    lastBobAt: () => loadBobState(file).lastBobAt,
    recordBeat: (at) => saveBobState(file, { version: 1, lastBobAt: at.toISOString() }),
  };
}

export interface BobSchedulerOptions {
  /** Consolidation interval; 0 disables the trigger. */
  readonly intervalMs: number;
  readonly slot: BobSlot;
  /** Persisted schedule read fresh at start; omitting it keeps the
   * pre-due semantics (never consolidated, so due immediately). */
  readonly state?: BobStatePort;
  readonly log?: Log;
  /** Clock + timer seams for tests. */
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly now?: () => Date;
}

export class BobScheduler {
  private readonly opts: BobSchedulerOptions;
  private readonly log: Log;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(opts: BobSchedulerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  get running(): boolean {
    return this.timer !== null || this.bootTimer !== null || this.firstBeatTimer !== null;
  }

  /** Milliseconds until the next consolidation is due, from the persisted
   * schedule: `max(0, lastBobAt + intervalMs − now)`; null (never
   * consolidated) is due now. An unparsable timestamp is a corrupt state
   * file — refuse to guess. */
  private dueInMs(): number {
    const lastBobAt = this.opts.state?.lastBobAt() ?? null;
    if (lastBobAt === null) return 0;
    const last = Date.parse(lastBobAt);
    if (Number.isNaN(last)) {
      throw new BobScheduleError(
        `persisted bob state has an unparsable lastBobAt ${JSON.stringify(lastBobAt)} — inspect or remove the bob state file`,
      );
    }
    return Math.max(0, last + this.opts.intervalMs - this.now().getTime());
  }

  start(): void {
    if (this.opts.intervalMs <= 0) {
      this.log('info', 'bob consolidation trigger disabled (interval 0)', {});
      return;
    }
    if (this.running) return;
    const dueInMs = this.dueInMs();
    if (dueInMs === 0) {
      const setTimeoutImpl = this.opts.setTimeout ?? setTimeout;
      this.bootTimer = setTimeoutImpl(() => {
        this.bootTimer = null;
        void this.tick();
      }, 0);
      this.bootTimer.unref?.();
    }
    // Cadence continuity: a restart mid-interval waits out the remainder
    // (dueInMs) instead of resetting the clock; due-now falls back to a
    // full interval. The recurring interval arms after the first beat.
    const firstBeatInMs = dueInMs > 0 ? dueInMs : this.opts.intervalMs;
    const setTimeoutImpl = this.opts.setTimeout ?? setTimeout;
    this.firstBeatTimer = setTimeoutImpl(() => {
      this.firstBeatTimer = null;
      void this.tick();
      const setIntervalImpl = this.opts.setInterval ?? setInterval;
      this.timer = setIntervalImpl(() => {
        void this.tick();
      }, this.opts.intervalMs);
      this.timer.unref?.();
    }, firstBeatInMs);
    this.firstBeatTimer.unref?.();
    this.log('info', 'bob consolidation trigger started', {
      interval_ms: this.opts.intervalMs,
      boot_beat_due: dueInMs === 0,
      due_in_ms: dueInMs,
      first_beat_in_ms: firstBeatInMs,
    });
  }

  stop(): void {
    if (this.bootTimer !== null) {
      (this.opts.clearTimeout ?? clearTimeout)(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.firstBeatTimer !== null) {
      (this.opts.clearTimeout ?? clearTimeout)(this.firstBeatTimer);
      this.firstBeatTimer = null;
    }
    if (this.timer === null) return;
    const clearIntervalImpl = this.opts.clearInterval ?? clearInterval;
    clearIntervalImpl(this.timer);
    this.timer = null;
    this.log('info', 'bob consolidation trigger stopped', {});
  }

  /**
   * One consolidation knock. Never overlapping (a slow consolidation
   * skips a beat rather than queueing two); a failed prompt is logged
   * loud and retried at the next interval — consolidation is periodic,
   * interruptible, and never blocks a live operation. A completed beat
   * persists `lastBobAt`; a failed one leaves the schedule untouched.
   */
  async tick(): Promise<{ prompted: boolean; note?: string }> {
    if (this.busy) {
      this.log('info', 'bob beat skipped — previous consolidation still running', {});
      return { prompted: false, note: 'previous consolidation still running — skipping this beat' };
    }
    this.busy = true;
    try {
      const handle = await this.opts.slot.ensure();
      await handle.prompt(BOB_CONSOLIDATION_PROMPT, { owner: 'bob-scheduler' });
      try {
        this.opts.state?.recordBeat(this.now());
      } catch (error) {
        // The knock happened; only the schedule record failed. Next boot
        // reads the older timestamp and knocks again rather than staying
        // silent for a week.
        this.log('error', 'bob consolidation completed but its schedule timestamp could not be persisted', {
          error: String(error),
        });
      }
      this.log('info', 'bob consolidation prompt delivered', { agent: handle.id });
      return { prompted: true };
    } catch (error) {
      this.log('error', 'bob consolidation prompt failed', { error: String(error) });
      return { prompted: false, note: String(error) };
    } finally {
      this.busy = false;
    }
  }
}
