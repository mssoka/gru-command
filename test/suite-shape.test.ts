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
  'board-engine.test.ts': 15,
  'board-frames.test.ts': 3,
  'board-server.test.ts': 14,
  'bob-scheduler.test.ts': 5,
  'chat-frame-log.test.ts': 20,
  'chat-frames.test.ts': 4,
  'attachments.test.ts': 28,
  'bmad-onboarding.test.ts': 10,
  'chat-server.test.ts': 74,
  'chat-session-state.test.ts': 6,
  'claude-adapter.test.ts': 72,
  'config-generate.test.ts': 7,
  'config.test.ts': 43,
  'decisions-cli.test.ts': 4,
  'decisions-service-integration.test.ts': 1,
  'decisions.test.ts': 43,
  'dispatch-e2e.test.ts': 3,
  'dispatch-joins.test.ts': 2,
  'dispatch-server.test.ts': 8,
  'health.test.ts': 18,
  'identity.test.ts': 3,
  'install-one-line.test.ts': 29,
  'install.test.ts': 12,
  'lan-phone-raw-client.test.ts': 6,
  'ledger-api.test.ts': 17,
  'ledger-db.test.ts': 6,
  'logger.test.ts': 3,
  'notifications.test.ts': 15,
  'perkins-builtin-review.test.ts': 52,
  'perkins-builtin-wave.test.ts': 34,
  'pi-adapter.test.ts': 47,
  'rehearsal.test.ts': 4,
  'roles-definitions.test.ts': 9,
  'review-path.test.ts': 26,
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
  'supervisor.test.ts': 42,
  'tool-heartbeat.test.ts': 2,
  'transcripts.test.ts': 13,
  'uploads-dir.test.ts': 3,
  'verify-perkins-resource.test.ts': 3,
  'wizard.test.ts': 24,
  'wizard-interactive.test.ts': 8,
  'wizard-register.test.ts': 2,
  'worktree-manager.test.ts': 36,
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
      expect(source, `${file}: parameterized cases evade the static suite pin; register explicit cases`).not.toMatch(
        /\b(?:it|test|describe)\.each\(/,
      );
      const registered = (source.match(/\bit\(|\bit\.skipIf\(/g) ?? []).length;
      const pinned = PINS[file] ?? -1;
      expect(
        registered,
        `${file}: registered ${registered} tests, pin says ${pinned === -1 ? 'UNPINNED' : pinned}`,
      ).toBe(pinned);
    }
  });
});
