import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOB_STATE_FILE, loadBobState } from '../src/dispatch/bob-scheduler.js';
import { pickFreePort, startRealService } from './helpers/real-service.mjs';

/**
 * Issue #451 through the REAL composition: the compiled service ships Bob
 * weekly, his due boot beat persists `lastBobAt` under the data home, and a
 * restart inherits the remainder instead of knocking again. Removing the
 * `state:` wiring in main.ts leaves bob-state.json unwritten and the
 * restart's trigger due — this test then fails.
 */

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

type LogLine = Record<string, unknown>;

function logLines(home: string): LogLine[] {
  const file = join(home, 'logs', 'service.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogLine);
}

/** Bob's session files under the data home, at any depth. */
function bobSessions(home: string): string[] {
  const dir = join(home, 'sessions', 'bob');
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((path) => path.endsWith('.jsonl'));
}

describe('compiled service: Bob persists his weekly schedule (issue #451)', () => {
  it('the due boot beat writes bob-state.json and a restart inherits the remainder', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-bob-state-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-bob-state-workspace-'));
    cleanup.push(home, workspace);
    const first = await startRealService({
      port: await pickFreePort(),
      home,
      workspace,
      keepHome: true,
      requireWebDist: false,
    });
    try {
      // No persisted state = due now: the boot beat must complete and write
      // the schedule under the data home (the production bobStateFile port).
      await vi.waitFor(
        () => {
          expect(existsSync(join(home, BOB_STATE_FILE)), 'bob-state.json written after the boot beat').toBe(true);
        },
        { timeout: 30_000, interval: 100 },
      );
      const state = loadBobState(join(home, BOB_STATE_FILE));
      expect(state.version).toBe(1);
      expect(state.lastBobAt).not.toBeNull();
      expect(Number.isNaN(Date.parse(state.lastBobAt!))).toBe(false);
      expect(bobSessions(home)).toHaveLength(1);
    } finally {
      await first.stop();
    }

    // The log survives the restart, so only a trigger line BEYOND the first
    // boot's proves the restarted process armed from persisted state.
    const triggerLines = (): LogLine[] =>
      logLines(home).filter((entry) => entry['msg'] === 'bob consolidation trigger started');
    const beforeRestart = triggerLines().length;
    const restarted = await startRealService({
      port: await pickFreePort(),
      home,
      workspace,
      keepHome: true,
      requireWebDist: false,
    });
    try {
      const started = await vi.waitFor(
        () => {
          const lines = triggerLines();
          expect(lines.length, 'the restart logged the Bob trigger').toBeGreaterThan(beforeRestart);
          return lines.at(-1)!;
        },
        { timeout: 20_000, interval: 100 },
      );
      // The restart inherits the week: no boot knock, first beat on the
      // remainder (~7 days from the beat, not a fresh 7 days plus drift).
      expect(started['boot_beat_due']).toBe(false);
      expect(Number(started['due_in_ms'])).toBeGreaterThan(6 * 86_400_000);
      expect(Number(started['first_beat_in_ms'])).toBeGreaterThan(6 * 86_400_000);
      expect(bobSessions(home), 'no second boot beat spawned another bob session').toHaveLength(1);
    } finally {
      await restarted.stop();
    }
  }, 90_000);
});
