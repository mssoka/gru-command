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
  'attachments.test.ts': 28,
  'awareness.test.ts': 43,
  'bmad-onboarding.test.ts': 13,
  'board-engine-v4.test.ts': 4,
  'board-engine.test.ts': 31,
  'board-frames.test.ts': 3,
  'board-server.test.ts': 17,
  'bob-scheduler.test.ts': 5,
  'branch-idle-guard.test.ts': 6,
  'build-info.test.ts': 5,
  'chat-frame-log.test.ts': 20,
  'chat-frames.test.ts': 4,
  'chat-server.test.ts': 83,
  'chat-session-state.test.ts': 6,
  'claude-adapter.test.ts': 89,
  'config-generate.test.ts': 8,
  'config.test.ts': 63,
  'decisions-cli.test.ts': 4,
  'decisions-service-integration.test.ts': 1,
  'decisions.test.ts': 43,
  'deploy-drift.test.ts': 10,
  'dispatch-e2e.test.ts': 5,
  'dispatch-joins.test.ts': 2,
  'dispatch-server.test.ts': 20,
  'fix-directive.test.ts': 8,
  'github-poll.test.ts': 24,
  'health.test.ts': 19,
  'identity.test.ts': 3,
  'install-one-line.test.ts': 35,
  'install.test.ts': 13,
  'lan-phone-raw-client.test.ts': 6,
  'ledger-api.test.ts': 23,
  'ledger-db.test.ts': 6,
  'lessons-bible.test.ts': 13,
  'lessons-capture.test.ts': 5,
  'lessons-dream.test.ts': 12,
  'lessons-e2e.test.ts': 2,
  'lessons-injection.test.ts': 6,
  'lessons-journal.test.ts': 5,
  'lessons-references.test.ts': 5,
  'lessons-server.test.ts': 5,
  'listener-probe.test.ts': 5,
  'logger.test.ts': 3,
  'native-tools-parity.test.ts': 2,
  'notifications.test.ts': 19,
  'owner-actions.test.ts': 8,
  'perkins-builtin-wave.test.ts': 88,
  'perkins-crash-child.test.ts': 1, // skipped unless PERKINS_CRASH_CHILD is set; the parent crash test spawns it
  'perkins-freeze-freshhead.test.ts': 13,
  'perkins-lead-schema-compat.test.ts': 6,
  'perkins-whole-review.test.ts': 67,
  'pi-adapter.test.ts': 63,
  'pr-creation-policy.test.ts': 5,
  'rebrief-recovery.test.ts': 8,
  'rehearsal.test.ts': 4,
  'resident-budget.test.ts': 7,
  'resident-saturation.test.ts': 2,
  'review-path.test.ts': 24,
  'roles-definitions.test.ts': 10,
  'roles-gru.test.ts': 4,
  'roll-cli.test.ts': 15,
  'roll-controller.test.ts': 11,
  'roll-e2e.test.ts': 1,
  'roll-server.test.ts': 7,
  'roll-state.test.ts': 7,
  'runtime-cessation-evidence.test.ts': 4,
  'runtime-probe.test.ts': 7,
  'runtime-resident-registry.test.ts': 21,
  'service-port-guard.test.ts': 14,
  'silas-deterministic-seam.test.ts': 1,
  'session-store.test.ts': 14,
  'shutdown.test.ts': 4,
  'silas-driver.test.ts': 33,
  'silas-followthrough.test.ts': 2,
  'smoke-claude.test.ts': 1,
  'smoke-real-model.test.ts': 1,
  'spawn-backoff.test.ts': 5,
  'spec-rulings-drift.test.ts': 5,
  'static.test.ts': 10,
  'stub-runtime.test.ts': 14,
  'suite-shape.test.ts': 2,
  'supervisor.test.ts': 52,
  'tool-heartbeat.test.ts': 2,
  'transcripts.test.ts': 13,
  'uploads-dir.test.ts': 3,
  'verification-evidence.test.ts': 5,
  'verification-scheduler.test.ts': 18,
  'verification-server.test.ts': 12,
  'verify-perkins-resource.test.ts': 3,
  'wake-e2e.test.ts': 3,
  'wake-policy.test.ts': 17,
  'wizard-interactive.test.ts': 8,
  'wizard-register.test.ts': 2,
  'wizard.test.ts': 24,
  'worktree-manager.test.ts': 40,
  'worktree-manifest.test.ts': 8,
  'worktree-port.test.ts': 4,
  'worktrees-server.test.ts': 3,
};

describe('suite shape', () => {
  it('runs the full PR gate on the default merge-result checkout', () => {
    const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf-8');
    expect(workflow).toMatch(/- uses: actions\/checkout@v6\s*\n\s*- uses: actions\/setup-node@v6/);
    expect(workflow).not.toContain('github.event.pull_request.head.sha');
    expect(workflow).toContain('run: npm test');
  });

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
