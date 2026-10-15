import { isSealedExecutionReceipt, type ExecutePlanInput, type ExecutePlanResult, type PropertyExecutor } from './executor.js';
import type { OverlayInputFile } from './overlay.js';
import type { PropertyAdapter, RetainedCounterexample, SealedExecutionReceipt } from './types.js';

/**
 * Replay of retained minimized counterexamples (GH350 seam B).
 *
 * A retained counterexample is replayed through the SAME executor code path
 * as the original run — sandbox, scrubbed environment, budgets, proven
 * cessation — with the recorded seed injected as an executor-issued
 * control (GRU_PROPERTY_SEED; the plan's env allowlist cannot request it).
 *
 * Honesty rules:
 *  - "reproduced" is claimed ONLY on structural evidence: the replay run
 *    reported the same selected property failure, the runner echoed the
 *    same seed, and the minimized counterexample input matches. Anything
 *    weaker is disclosed, never promoted.
 *  - a counterexample without replay support (no retained seed) is an
 *    explicit unsupported-replay refusal — no execution, no guess.
 *  - environment-profile drift between capture and replay is disclosed
 *    even when the failure reproduces; the schedule/env provenance is part
 *    of what a replay claims.
 */

export type ReplayOutcomeKind = 'reproduced' | 'not-reproduced' | 'unsupported-replay';

export interface ReplayOutcome {
  readonly kind: ReplayOutcomeKind;
  /** The replay run's sealed receipt when one was executed. */
  readonly receipt: SealedExecutionReceipt | null;
  readonly disclosure: string;
  /** True when the recorded environment profile matches the replay's. */
  readonly environmentMatch: boolean;
}

export interface ReplayRequest {
  readonly executor: PropertyExecutor;
  readonly plan: ExecutePlanInput['plan'];
  readonly adapter: PropertyAdapter;
  readonly repoRoot: string;
  readonly packageDir: string;
  readonly overlayFiles?: readonly OverlayInputFile[];
  readonly counterexample: RetainedCounterexample;
  readonly originalReceipt: SealedExecutionReceipt;
  /**
   * Test/diagnostic control for simulating seed drift: production replay
   * always uses the recorded seed. A drifted seed that fails to reproduce
   * is disclosed as non-reproduction — never silently retried.
   */
  readonly seedOverride?: string;
}

function failureSeedEchoed(receipt: SealedExecutionReceipt): string | null {
  return receipt.outcome.failures.find((failure) => failure.seed !== null)?.seed ?? null;
}

/**
 * Replay a retained minimized counterexample through the executor with its
 * recorded seed (and disclose schedule/environment provenance).
 */
export async function replayRetainedCounterexample(request: ReplayRequest): Promise<ReplayOutcome> {
  const { executor, plan, adapter, repoRoot, packageDir, overlayFiles, counterexample } = request;
  const replay = counterexample.replay;
  if (!isSealedExecutionReceipt(request.originalReceipt) || JSON.stringify(request.originalReceipt.counterexample) !== JSON.stringify(counterexample)) throw new Error('replay requires the original host-issued counterexample receipt');
  if (!replay.replaySupported || replay.seed === null) {
    return {
      kind: 'unsupported-replay',
      receipt: null,
      disclosure:
        replay.replayDisclosure ??
        'the retained counterexample carries no replayable seed — replay is unsupported for this capture and is refused rather than guessed',
      environmentMatch: false,
    };
  }
  const seed = request.seedOverride ?? replay.seed;
  const result: ExecutePlanResult = await executor.executePlan({
    plan,
    adapter,
    repoRoot,
    packageDir,
    overlayFiles,
    approval: executor.approvePlan({ plan, repoRoot, packageDir, overlayFiles, replaySeed: seed, replayPath: replay.shrinkPath[0] ?? null }),
    replaySeed: seed,
    replayPath: replay.shrinkPath[0] ?? null,
  });
  if (!result.executed) {
    return {
      kind: 'not-reproduced',
      receipt: null,
      disclosure: `replay run was refused before execution (${result.refusal.kind}: ${result.refusal.reason}) — no reproduction claim is possible`,
      environmentMatch: false,
    };
  }
  const { receipt } = result;
  const environmentMatch = receipt.replay !== null && receipt.replay.environmentProfile === replay.environmentProfile;
  const driftNote = environmentMatch
    ? ''
    : ' environment profile differs from the recorded capture (schedule/env drift disclosed);';

  if (receipt.outcome.kind !== 'property-failure' || receipt.outcome.failures.length === 0) {
    return {
      kind: 'not-reproduced',
      receipt,
      disclosure:
        `replay with recorded seed ${seed} ended as ${receipt.outcome.kind} without a selected property failure — ` +
        `the counterexample did not reproduce; possible nondeterminism or a changed target.${driftNote}`,
      environmentMatch,
    };
  }
  const echoedSeed = failureSeedEchoed(receipt);
  const replayed = receipt.counterexample;
  const seedMatches = echoedSeed === seed;
  const inputMatches = replayed?.minimizedInput === counterexample.minimizedInput;
  const assertionMatches = counterexample.testIdentity !== undefined && replayed?.testIdentity === counterexample.testIdentity && receipt.outcome.failures[0]?.testIdentity === counterexample.testIdentity;
  const identityMatches = JSON.stringify(receipt.identity.source) === JSON.stringify(request.originalReceipt.identity.source) && receipt.identity.workspaceTreeSha256 === request.originalReceipt.identity.workspaceTreeSha256 && receipt.identity.dependencyTreeSha256 === request.originalReceipt.identity.dependencyTreeSha256 && receipt.identity.lockIdentity === request.originalReceipt.identity.lockIdentity && receipt.identity.configIdentity === request.originalReceipt.identity.configIdentity && receipt.identity.overlay?.overlaySha256 === request.originalReceipt.identity.overlay?.overlaySha256 && receipt.identity.selectionFilter === request.originalReceipt.identity.selectionFilter && receipt.identity.adapterProfile === request.originalReceipt.identity.adapterProfile;
  if (seedMatches && inputMatches && assertionMatches && replayed?.replay.replaySupported === true && identityMatches && environmentMatch) {
    return {
      kind: 'reproduced',
      receipt,
      disclosure:
        `replayed counterexample reproduced deterministically: seed ${seed} echoed by the runner, minimized input identical` +
        `.${driftNote}`,
      environmentMatch,
    };
  }
  return {
    kind: 'not-reproduced',
    receipt,
    disclosure:
      `replay did not reproduce the retained counterexample: seed echo ${JSON.stringify(echoedSeed)} (expected ${JSON.stringify(seed)}), ` +
      `minimized input ${JSON.stringify(replayed?.minimizedInput)} (expected ${JSON.stringify(counterexample.minimizedInput)}) — ` +
      `disclosed as nondeterminism or drift, never claimed as reproduction.${driftNote}`,
    environmentMatch,
  };
}
