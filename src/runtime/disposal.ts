/**
 * Aggregate disposal (issue #341). A plain `for (…) await target.dispose()`
 * loop aborts on the FIRST rejection, so one hung session that fails to prove
 * idle at shutdown would abandon every remaining handle's lock release and
 * every adapter's bridge teardown — the exact failure mode #341 exists to
 * contain. This runs EVERY disposal CONCURRENTLY, collects the per-target
 * causes, and fails loud ONCE at the end with the handle/adapter ids attached.
 *
 * Concurrency is load-bearing, not an optimisation: a serial traversal pays
 * one per-target bound for EACH hung target (N hung sessions ≈
 * N × CESSATION_IDLE_TIMEOUT_MS), which at service shutdown outruns the
 * force-exit guard and abandons the remaining cleanup. Concurrent traversal
 * keeps the worst case at a single bound regardless of N.
 *
 * Lives in a leaf module (no imports) so both `pi-adapter.ts` (PiRuntime) and
 * `registry.ts` can share it without an import cycle.
 */
export interface DisposableTarget {
  /** Product id used to attribute a failure (handle id or adapter id). */
  readonly id: string;
  dispose(): Promise<void>;
}

/** Render a rejection for the aggregate message without assuming it is an
 * Error: a pathological value (`Object.create(null)`, a Symbol) whose
 * `String()` throws must not abort the aggregate itself. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return '<unprintable rejection>';
  }
}

/** Start every target's disposal SYNCHRONOUSLY (capturing a synchronous throw
 * as a rejection) so the whole batch is in flight before the first
 * settlement. */
function startAll(targets: readonly DisposableTarget[]): Promise<void>[] {
  return targets.map((target) => {
    try {
      return Promise.resolve(target.dispose());
    } catch (error) {
      return Promise.reject(error);
    }
  });
}

/** Await EVERY started disposal and return the attributed failures in TARGET
 * input order — never settlement order, never first-failure-only. Each failure
 * carries the target id and the ORIGINAL thrown value as its `cause`. */
async function collectFailures(targets: readonly DisposableTarget[]): Promise<Error[]> {
  const settled = await Promise.allSettled(startAll(targets));
  const failures: Error[] = [];
  settled.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const target = targets[index]!;
    failures.push(
      new Error(`${target.id}: ${describeFailure(result.reason)}`, { cause: result.reason }),
    );
  });
  return failures;
}

/** One AggregateError over every collected cause, with the total target count
 * across the whole traversal (not just the failing phase). */
function aggregateFailure(failures: readonly Error[], totalTargets: number): AggregateError {
  return new AggregateError(
    [...failures],
    `disposal failed for ${failures.length} of ${totalTargets} target(s): ` +
      failures.map((failure) => failure.message).join('; '),
  );
}

/** Dispose every target CONCURRENTLY, then throw one {@link AggregateError}
 * carrying the per-target causes. Never aborts the traversal: a failure on
 * target N does not skip N+1 (and does not delay it behind N's bound).
 * Resolves cleanly when every target disposes. */
export async function disposeAll(targets: readonly DisposableTarget[]): Promise<void> {
  const failures = await collectFailures(targets);
  if (failures.length > 0) throw aggregateFailure(failures, targets.length);
}

/** Dispose every target of PHASE 1 concurrently, wait for the whole phase to
 * settle, then do the same for PHASE 2 (and so on). A failure in an earlier
 * phase NEVER skips a later phase — phases are ordered, targets within a phase
 * are not. Causes are combined across phases (phase order, then target input
 * order) and reported once with the total target count attached.
 *
 * `registry.dispose()` uses this to keep the resident-handle phase ahead of the
 * adapter phase: a native adapter disposes the SAME underlying handles the
 * residents wrap, so running it only after the resident phase settles lets
 * each underlying handle retire from the adapter's own set first and avoids
 * re-attributing one handle's timeout as an adapter-only failure. */
export async function disposePhases(
  phases: readonly (readonly DisposableTarget[])[],
): Promise<void> {
  const failures: Error[] = [];
  let totalTargets = 0;
  for (const phase of phases) {
    totalTargets += phase.length;
    failures.push(...(await collectFailures(phase)));
  }
  if (failures.length > 0) throw aggregateFailure(failures, totalTargets);
}
