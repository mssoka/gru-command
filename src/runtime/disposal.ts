/**
 * Aggregate disposal (issue #341). A plain `for (…) await target.dispose()`
 * loop aborts on the FIRST rejection, so one hung session that fails to prove
 * idle at shutdown would abandon every remaining handle's lock release and
 * every adapter's bridge teardown — the exact failure mode #341 exists to
 * contain. This runs EVERY disposal, collects the per-target causes, and fails
 * loud ONCE at the end with the handle/adapter ids attached.
 *
 * Lives in a leaf module (no imports) so both `pi-adapter.ts` (PiRuntime) and
 * `registry.ts` can share it without an import cycle.
 */
export interface DisposableTarget {
  /** Product id used to attribute a failure (handle id or adapter id). */
  readonly id: string;
  dispose(): Promise<void>;
}

/** Dispose every target, then throw one {@link AggregateError} carrying the
 * per-target causes. Never aborts the traversal: a failure on target N does
 * not skip N+1. Resolves cleanly when every target disposes. */
export async function disposeAll(targets: readonly DisposableTarget[]): Promise<void> {
  const failures: Error[] = [];
  for (const target of targets) {
    try {
      await target.dispose();
    } catch (error) {
      failures.push(
        new Error(
          `${target.id}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `disposal failed for ${failures.length} of ${targets.length} target(s): ` +
        failures.map((failure) => failure.message).join('; '),
    );
  }
}
