import type { RuntimeEvent } from './types.js';

/**
 * Long-tool liveness (E7 hung-turn fix): an OPEN tool call is activity,
 * not silence. A tool that produces no output — `npx vitest run` with its
 * output redirected to /tmp, a long download, a quiet build — leaves the
 * event surface silent for the whole run, so supervision's silence rule
 * (no event + no session growth = hung) would kill a live process and
 * orphan its turn.
 *
 * While any tool call is open, this emits a periodic `tool_update` per
 * open call ("still running"), so every event consumer — the supervisor,
 * the board, the chat surface — keeps observing a working session. It
 * writes nothing to the transcript and adds no durable rows; it only says
 * out loud what the runtime already knows: the tool has not returned yet.
 */

/**
 * Heartbeat cadence: a quarter of the supervision silence window so
 * several heartbeats land inside every window, capped at one minute
 * (bounded event volume) and floored at one second (test-scale configs
 * stay sane).
 */
export function toolHeartbeatIntervalMs(turnSilenceMs: number): number {
  return Math.max(1_000, Math.min(Math.floor(turnSilenceMs / 4), 60_000));
}

export class ToolHeartbeat {
  /** callId → tool name for every call currently executing. */
  private readonly open = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly emit: (event: RuntimeEvent) => void,
    private readonly intervalMs: number,
  ) {}

  /** A tool call started executing. */
  started(callId: string, tool: string): void {
    this.open.set(callId, tool);
    if (this.timer === null) {
      this.timer = setInterval(() => {
        for (const callId of this.open.keys()) this.emit({ type: 'tool_update', callId });
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  /** A tool call returned (success or error) — stop counting it. */
  ended(callId: string): void {
    this.open.delete(callId);
    if (this.open.size === 0) this.stopTimer();
  }

  /**
   * Forget every open call and stop beating. Called when a turn settles
   * without per-call terminal events (crash/error paths) and at disposal.
   */
  clear(): void {
    this.stopTimer();
    this.open.clear();
  }

  /** Open calls right now — the runtime's process-liveness probe reads this. */
  get openCalls(): number {
    return this.open.size;
  }

  dispose(): void {
    this.clear();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
