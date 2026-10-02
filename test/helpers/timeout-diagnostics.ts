/**
 * Vitest setup file: a file-scoped diagnostics context (for children
 * started in `beforeAll`), one scope per test, automatic failure
 * reporting, and bounded teardown for fixture-owned children.
 *
 * Registration order (setup files load before the test file) means the
 * `beforeAll`/`afterAll` hooks here run before/after the test file's own,
 * so a service booted in the file's `beforeAll` is tracked. Per-test
 * scopes nest inside the file scope: their diagnostics render the
 * file-scope children too, but disposal at test end touches only the
 * test's own children; the file scope is disposed in `afterAll`.
 *
 * Reporting and disposal are registered through `context.onTestFinished`
 * from `beforeEach`. Vitest invokes those callbacks after the afterEach
 * chain and its failure handling, so a test whose own `afterEach` throws
 * or times out still gets diagnostics and bounded cleanup — a setup
 * `afterEach` would be skipped when the hook chain aborts. A `beforeAll`
 * failure runs no per-test hooks; the file `afterAll` reports and disposes
 * the file scope, and harness setup helpers that can fail that way also
 * use runBoundedFixtureStep, which emits the same diagnostics at throw
 * time.
 */
import { afterAll, beforeAll, beforeEach } from 'vitest';
import {
  activateTestScope,
  createTestScope,
  deactivateTestScope,
  disposeScopeProcesses,
  renderFailureDiagnostics,
  type DiagnosticsScope,
} from './harness-diagnostics.mjs';

interface TaskLike {
  readonly name?: string | undefined;
  readonly suite?: TaskLike | undefined;
  readonly file?: { readonly name?: string | undefined } | undefined;
  readonly result?: { readonly errors?: readonly unknown[] } | undefined;
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

let fileScope: DiagnosticsScope | null = null;

beforeAll((suite) => {
  const file = suite.file ?? suite;
  fileScope = createTestScope({
    file: file.name ?? '<unknown file>',
    name: '<file scope>',
  });
  activateTestScope(fileScope);
});

beforeEach((context) => {
  const task = context.task as TaskLike;
  const scope = createTestScope({
    file: task.file?.name ?? '<unknown file>',
    name: fullName(task),
    parent: fileScope,
  });
  const stale = activateTestScope(scope);
  if (stale !== null && stale !== fileScope) {
    // A previous test scope that never reached its onTestFinished: reap its
    // owned children in the background rather than leaking them into this test.
    void disposeScopeProcesses(stale, { graceMs: 500 }).catch(() => undefined);
  }
  context.onTestFinished(async () => {
    try {
      const errors = (context.task as TaskLike).result?.errors ?? [];
      for (const error of errors) {
        process.stderr.write(`${renderFailureDiagnostics(scope, error)}\n`);
      }
    } catch {
      // Diagnostics must never turn a passing test red.
    }
    try {
      deactivateTestScope(scope);
      await disposeScopeProcesses(scope, { graceMs: 2_000 });
    } catch {
      // Bounded teardown failures are reported by the next scope's reaper.
    }
  });
});

afterAll(async (suite) => {
  const scope = fileScope;
  fileScope = null;
  if (scope === null) return;
  try {
    const errors = suite.result?.errors ?? [];
    for (const error of errors) {
      process.stderr.write(`${renderFailureDiagnostics(scope, error)}\n`);
    }
  } catch {
    // Diagnostics must never turn a passing file red.
  }
  try {
    deactivateTestScope(scope);
    await disposeScopeProcesses(scope, { graceMs: 2_000 });
  } catch {
    // The file's own afterAll hooks have already run; leftovers are bounded
    // by the verification scheduler's process-group teardown at lane end.
  }
});
