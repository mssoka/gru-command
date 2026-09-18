import type { LogLevel } from '../logger.js';
import type { AgentHandle, SpawnOptions } from '../runtime/types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Bob's periodic consolidation trigger (EPICS E8 story 4): on an
 * interval, prompt the bob role's supervised slot with consolidation
 * instructions. Bob himself is memory, not mechanics — this scheduler
 * only knocks; the role's prompt (roles/bob.md) governs the craft.
 * Interval 0 disables the trigger entirely.
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

export interface BobSchedulerOptions {
  /** Consolidation interval; 0 disables (the trigger never fires). */
  readonly intervalMs: number;
  readonly slot: BobSlot;
  readonly log?: Log;
  /** Clock + timer seams for tests. */
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

export class BobScheduler {
  private readonly opts: BobSchedulerOptions;
  private readonly log: Log;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(opts: BobSchedulerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.opts.intervalMs <= 0) {
      this.log('info', 'bob consolidation trigger disabled (interval 0)', {});
      return;
    }
    if (this.timer !== null) return;
    const setIntervalImpl = this.opts.setInterval ?? setInterval;
    this.timer = setIntervalImpl(() => {
      void this.tick();
    }, this.opts.intervalMs);
    this.timer.unref?.();
    this.log('info', 'bob consolidation trigger started', { intervalMs: this.opts.intervalMs });
  }

  stop(): void {
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
   * interruptible, and never blocks a live operation.
   */
  async tick(): Promise<{ prompted: boolean; note?: string }> {
    if (this.busy) {
      return { prompted: false, note: 'previous consolidation still running — skipping this beat' };
    }
    this.busy = true;
    try {
      const handle = await this.opts.slot.ensure();
      await handle.prompt(BOB_CONSOLIDATION_PROMPT, { owner: 'bob-scheduler' });
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
