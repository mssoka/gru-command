/**
 * The Silas autopilot's deterministic-pass hook (issue #243).
 *
 * Silas's {@link DeterministicPassHook} runs at the top of every trigger —
 * bus wake events and sweep ticks alike — BEFORE any LLM wake. This module
 * turns one pass into: compute the digest, run every enabled autopilot
 * family against it, report bounded counts. LLM Silas is woken afterwards
 * only for the rows the pass left behind.
 *
 * A failing pass is reported, never thrown: the rows stay for LLM Silas and
 * the next observation re-derives them. The returned `ok: false` is how the
 * driver's own contract records an incomplete pass.
 */
import type { SilasAutopilotConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import { runSilasAutopilot, type AutopilotLedger, type SilasAutopilotOps } from './silas-autopilot.js';
import type { DeterministicPassHook, DeterministicPassResult, SilasOpsDigest } from './silas-driver.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The production deterministic-pass composition (issue #243 F-M4): the
 * durable reconciliation half plus the autopilot half in ONE pass. Either
 * half reporting `ok: false` fails the whole pass, so the driver records
 * `silas.reconcile-failed` and never advances a completed reconciliation over
 * a failed half. Extracted from main.ts so the composition itself is
 * behaviorally testable through a real driver and ledger. */
export function composeDeterministicPass(
  durable: DeterministicPassHook,
  autopilot: DeterministicPassHook,
): DeterministicPassHook {
  return async (context) => {
    const durableResult = await durable(context);
    const autopilotResult = await autopilot(context);
    const durableCounts = typeof durableResult === 'object' && durableResult !== null ? durableResult : {};
    const autopilotCounts = typeof autopilotResult === 'object' && autopilotResult !== null ? autopilotResult : {};
    return {
      ...durableCounts,
      ...autopilotCounts,
      // One failed half fails the pass: the driver records a failed
      // reconciliation, never a completed one.
      ok: durableCounts['ok'] !== false && autopilotCounts['ok'] !== false,
    } satisfies DeterministicPassResult;
  };
}

export interface SilasAutopilotPassDeps {
  readonly ledger: AutopilotLedger;
  readonly config: SilasAutopilotConfig;
  readonly ops: SilasAutopilotOps;
  /** Computes the freshly observed digest for this pass (the same seams the
   * driver's own wake uses). */
  readonly digest: (trigger: string) => Promise<SilasOpsDigest>;
  readonly log?: Log;
}

export function createSilasAutopilotHook(deps: SilasAutopilotPassDeps): DeterministicPassHook {
  return async (context) => {
    if (!deps.config.enabled) return { ok: true, autopilot: { enabled: false } };
    try {
      const digest = await deps.digest(context.trigger);
      const result = await runSilasAutopilot({
        digest,
        config: deps.config,
        ledger: deps.ledger,
        ops: deps.ops,
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });
      return {
        // A failed action is an incomplete pass (issue #243 R2-M2): the
        // driver records `silas.reconcile-failed`, never a completed
        // reconciliation that hides the failure behind `ok: true`.
        ok: result.ok,
        autopilot: {
          enabled: true,
          decisions: result.decisions,
          enforced: result.enforced,
          refusals: result.refusals,
          failures: result.failures,
        },
      };
    } catch (error) {
      deps.log?.('error', 'silas autopilot pass failed — rows stay for LLM Silas', {
        trigger: context.trigger,
        error: String(error).slice(0, 300),
      });
      return { ok: false, autopilot: { enabled: true, error: String(error).slice(0, 300) } };
    }
  };
}
