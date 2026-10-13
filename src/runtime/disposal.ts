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

/** Dispose every target CONCURRENTLY, then throw one {@link AggregateError}
 * carrying the per-target causes. Never aborts the traversal: a failure on
 * target N does not skip N+1 (and does not delay it behind N's bound).
 * Resolves cleanly when every target disposes. */
export async function disposeAll(targets: readonly DisposableTarget[]): Promise<void> {
  // Start every disposal synchronously (capturing a synchronous throw as a
  // rejection) so the whole set is in flight before the first settlement.
  const started = targets.map((target) => {
    try {
      return Promise.resolve(target.dispose());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  const settled = await Promise.allSettled(started);
  const failures: Error[] = [];
  settled.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const target = targets[index]!;
    failures.push(
      new Error(`${target.id}: ${describeFailure(result.reason)}`, { cause: result.reason }),
    );
  });
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `disposal failed for ${failures.length} of ${targets.length} target(s): ` +
        failures.map((failure) => failure.message).join('; '),
    );
  }
}
