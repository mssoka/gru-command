import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phantom-check guard: every test file must register exactly its pinned
 * number of tests. A file that silently collects zero tests (or loses some
 * to an aborted module) fails here instead of passing vacuously.
 * Adding a test? Bump this pin — that is the point.
 */
const PINS: Record<string, number> = {
  'board-engine.test.ts': 13,
  'board-frames.test.ts': 3,
  'board-server.test.ts': 13,
  'bob-scheduler.test.ts': 5,
  'chat-frame-log.test.ts': 19,
  'chat-frames.test.ts': 4,
  'attachments.test.ts': 28,
  'chat-server.test.ts': 59,
  'chat-session-state.test.ts': 6,
  'claude-adapter.test.ts': 58,
  'config.test.ts': 39,
  'dispatch-e2e.test.ts': 3,
  'dispatch-joins.test.ts': 2,
  'dispatch-server.test.ts': 4,
  'health.test.ts': 17,
  'identity.test.ts': 3,
  'install-one-line.test.ts': 14,
  'install.test.ts': 11,
  'lan-phone-raw-client.test.ts': 6,
  'ledger-api.test.ts': 17,
  'ledger-db.test.ts': 6,
  'logger.test.ts': 3,
  'notifications.test.ts': 5,
  'perkins-driver.test.ts': 2,
  'perkins-wave.test.ts': 16,
  'pi-adapter.test.ts': 38,
  'rehearsal.test.ts': 4,
  'roles-definitions.test.ts': 7,
  'roles-gru.test.ts': 4,
  'runtime-probe.test.ts': 7,
  'session-store.test.ts': 14,
  'shutdown.test.ts': 4,
  'smoke-claude.test.ts': 1,
  'smoke-real-model.test.ts': 1,
  'spec-rulings-drift.test.ts': 5,
  'static.test.ts': 10,
  'stub-runtime.test.ts': 14,
  'suite-shape.test.ts': 1,
  'supervisor.test.ts': 21,
  'transcripts.test.ts': 13,
  'uploads-dir.test.ts': 3,
  'wizard.test.ts': 19,
  'wizard-interactive.test.ts': 5,
  'wizard-register.test.ts': 2,
  'worktree-manager.test.ts': 35,
  'worktree-manifest.test.ts': 6,
  'worktree-port.test.ts': 4,
  'worktrees-server.test.ts': 3,
};

describe('suite shape', () => {
  it('every test file is pinned and registers exactly its expected test count', () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.test.ts'))
      .sort();
    expect(files).toEqual(Object.keys(PINS).sort());
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf-8');
      const registered = (source.match(/\bit\(/g) ?? []).length;
      const pinned = PINS[file] ?? -1;
      expect(
        registered,
        `${file}: registered ${registered} tests, pin says ${pinned === -1 ? 'UNPINNED' : pinned}`,
      ).toBe(pinned);
    }
  });
});
