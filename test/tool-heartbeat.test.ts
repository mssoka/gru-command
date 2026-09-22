import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolHeartbeat, toolHeartbeatIntervalMs } from '../src/runtime/tool-heartbeat.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

/**
 * Long-tool heartbeats (E7 hung-turn fix): an open tool call is activity.
 * The heartbeat module is the piece that keeps a quiet-but-live tool run
 * visible on the event surface.
 */
describe('tool heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives a cadence that lands several beats inside the silence window', () => {
    expect(toolHeartbeatIntervalMs(900_000)).toBe(60_000); // capped at a minute
    expect(toolHeartbeatIntervalMs(20_000)).toBe(5_000); // a quarter of the window
    expect(toolHeartbeatIntervalMs(50)).toBe(1_000); // floored for test-scale configs
  });

  it('emits a tool_update per open call on the interval and stops when all close', () => {
    vi.useFakeTimers();
    const events: RuntimeEvent[] = [];
    const heartbeat = new ToolHeartbeat((event) => events.push(event), 1_000);

    heartbeat.started('tool-call-1', 'bash');
    expect(heartbeat.openCalls).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([{ type: 'tool_update', callId: 'tool-call-1' }]);

    // A second open call gets its own beat; the interval stays single.
    heartbeat.started('tool-call-2', 'read');
    vi.advanceTimersByTime(1_000);
    expect(events).toHaveLength(3);
    expect(events.filter((event) => event.type === 'tool_update' && event.callId === 'tool-call-1')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool_update' && event.callId === 'tool-call-2')).toHaveLength(1);

    // One close quiets only that call...
    heartbeat.ended('tool-call-1');
    vi.advanceTimersByTime(1_000);
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: 'tool_update', callId: 'tool-call-2' });

    // ...the last close stops the timer entirely (no idle beats).
    heartbeat.ended('tool-call-2');
    expect(heartbeat.openCalls).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(events).toHaveLength(4);

    // Disposal silences a still-open call and clears the count.
    heartbeat.started('tool-call-3', 'bash');
    heartbeat.dispose();
    vi.advanceTimersByTime(5_000);
    expect(events).toHaveLength(4);
    expect(heartbeat.openCalls).toBe(0);
  });
});
