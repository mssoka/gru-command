/**
 * Vitest setup file: one diagnostics scope per test, failure reporting,
 * and bounded teardown for fixture-owned children.
 *
 * Registration order (setup files load before the test file) means this
 * afterEach runs LAST in the default hook order, after the test's own
 * cleanup hooks, so it observes the state they leave behind. Vitest
 * invokes afterEach even when the test (or a beforeEach hook) timed out,
 * which is what makes timeout diagnostics automatic. A beforeAll failure
 * marks its tests skipped and runs no per-test hooks; harness setup
 * helpers that can fail that way use runBoundedFixtureStep, which emits
 * the same diagnostics at throw time.
 */
import { afterEach, beforeEach } from 'vitest';
import {
  activateTestScope,
  createTestScope,
  currentTestScope,
  deactivateTestScope,
  disposeScopeProcesses,
  renderFailureDiagnostics,
} from './harness-diagnostics.mjs';

interface TaskLike {
  readonly name?: string | undefined;
  readonly suite?: TaskLike | undefined;
  readonly file?: { readonly name?: string | undefined } | undefined;
}

function fullName(task: TaskLike): string {
  const names: string[] = [];
  let cursor: TaskLike | undefined = task.suite;
  while (cursor !== undefined) {
    if (cursor.name !== undefined && cursor.name !== '') names.unshift(cursor.name);
    cursor = cursor.suite;
  }
  names.push(task.name ?? '<unknown test>');
  return names.join(' > ');
}

beforeEach((context) => {
  const task = context.task as TaskLike;
  const stale = activateTestScope(
    createTestScope({ file: task.file?.name ?? '<unknown file>', name: fullName(task) }),
  );
  if (stale !== null) {
    // A previous scope that never reached its afterEach: reap its owned
    // children in the background rather than leaking them into this test.
    void disposeScopeProcesses(stale, { graceMs: 500 }).catch(() => undefined);
  }
});

afterEach(async (context) => {
  const scope = currentTestScope();
  if (scope === null) return;
  try {
    const errors = (context.task.result?.errors ?? []) as readonly unknown[];
    for (const error of errors) {
      process.stderr.write(`${renderFailureDiagnostics(scope, error)}\n`);
    }
  } finally {
    deactivateTestScope(scope);
    await disposeScopeProcesses(scope, { graceMs: 2_000 }).catch(() => undefined);
  }
});
