import { CESSATION_IDLE_TIMEOUT_MS } from './runtime/pi-adapter.js';
import { BRIDGE_CLOSE_TIMEOUT_MS } from './runtime/review-mcp-bridge.js';

/** Fraction of the bounded teardown added on top so clock jitter and the
 * remaining (non-runtime) shutdown stages cannot trip the guard on a healthy
 * exit. */
const SHUTDOWN_FORCE_EXIT_SLACK_MS = 5_000;

/**
 * Force-exit guard for graceful shutdown (issue #341). `main.ts` arms this
 * timer at `shutdown begin`; if it fires first it calls `process.exit(1)`.
 *
 * The runtime teardown it supervises is BOUNDED: every handle's post-dispose
 * idle proof is capped at {@link CESSATION_IDLE_TIMEOUT_MS} and handles are
 * disposed CONCURRENTLY (so N hung sessions cost one bound, not N), and every
 * adapter's bridge close at {@link BRIDGE_CLOSE_TIMEOUT_MS}. A guard no larger
 * than a single bound fired `process.exit(1)` while a healthy bounded teardown
 * was still running and abandoned the remaining lock releases and the final
 * snapshot — the loss #341 exists to prevent. The budget therefore outlasts
 * the bounded teardown with slack.
 */
export const SHUTDOWN_FORCE_EXIT_MS =
  CESSATION_IDLE_TIMEOUT_MS + BRIDGE_CLOSE_TIMEOUT_MS + SHUTDOWN_FORCE_EXIT_SLACK_MS;
