/**
 * What an onboarding proof (#427 PR 1b) is, as the ledger keeps it: the
 * result type, its `onboarding.proof` payload, and the one reader every
 * consumer uses (the review fence in LedgerApi, the onboarding service and
 * its projection, the Perkins packet). A record this reader cannot read is
 * not a pass: it fences review and never lifts the fence. No imports, so
 * the ledger can use it without the proof's runtime.
 */

/** A full commit id (SHA-1 or SHA-256), the only head a proof accepts. */
export const isCommitId = (head: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head);

export interface ProofSetupStep {
  readonly command: string;
  readonly ms: number;
  readonly ok: boolean;
}

export interface ProofVerify {
  /** Null when the manifest declares no `verify.full` (the step passes). */
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly ms: number;
  /** Time spent waiting for the budget slot. */
  readonly queuedMs: number;
  readonly workers: number | null;
  readonly outputBytes: number;
}

export interface ProofPath {
  readonly path: string;
  readonly bytes: number;
}

export interface ProofReclaim {
  readonly path: string;
  /** Absent before setup, present after verify. */
  readonly appeared: boolean;
  readonly ignored: boolean;
  readonly trackedFiles: number;
  /** Null when it is absent or a link (never measured through one). */
  readonly bytes: number | null;
  /** The entry is a link or lies under one: deleting it would reach outside the lane. */
  readonly link: boolean;
}

export interface OnboardingProofResult {
  readonly head: string;
  readonly passed: boolean;
  /** Why it failed, one entry per check; empty when it passed. */
  readonly failures: readonly string[];
  readonly setup: readonly ProofSetupStep[];
  /** Null when setup failed and verify never ran. */
  readonly verify: ProofVerify | null;
  /** Git-ignored paths present after verify that the fresh checkout lacked
   * (a bounded list); null when setup failed. */
  readonly appeared: readonly ProofPath[] | null;
  readonly appearedCount: number;
  readonly reclaim: readonly ProofReclaim[];
  /** The checkout's size without `.git`; null when setup failed. */
  readonly laneBytes: number | null;
  /** The failing command's output tail (setup or verify), redacted. */
  readonly outputTail: string;
}

/** The `onboarding.proof` payload (snake_case, as every ledger payload). */
export function onboardingProofPayload(repo: string, jobId: string, result: OnboardingProofResult): Record<string, unknown> {
  return {
    repo,
    job_id: jobId,
    head: result.head,
    outcome: result.passed ? 'passed' : 'failed',
    failures: result.failures,
    setup: result.setup.map((step) => ({ command: step.command, ms: step.ms, ok: step.ok })),
    verify: result.verify === null ? null : {
      command: result.verify.command, exit_code: result.verify.exitCode, signal: result.verify.signal, timed_out: result.verify.timedOut,
      ms: result.verify.ms, queued_ms: result.verify.queuedMs, workers: result.verify.workers, output_bytes: result.verify.outputBytes,
    },
    appeared: result.appeared,
    appeared_count: result.appearedCount,
    reclaim: result.reclaim.map((entry) => ({
      path: entry.path, appeared: entry.appeared, ignored: entry.ignored, tracked_files: entry.trackedFiles, bytes: entry.bytes, link: entry.link,
    })),
    lane_bytes: result.laneBytes,
    output_tail: result.outputTail,
  };
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const rows = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : [];

/** Read an `onboarding.proof` payload back; null when it is not one (no
 * head, no known outcome, or failures that are not a list of strings). */
export function readOnboardingProof(payload: unknown): OnboardingProofResult | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;
  const head = str(raw['head']);
  const outcome = str(raw['outcome']);
  const failures = raw['failures'];
  if (head === null || (outcome !== 'passed' && outcome !== 'failed')) return null;
  if (!Array.isArray(failures) || failures.some((entry) => typeof entry !== 'string')) return null;
  const verify = typeof raw['verify'] === 'object' && raw['verify'] !== null ? raw['verify'] as Record<string, unknown> : null;
  return {
    head,
    passed: outcome === 'passed',
    failures: failures as string[],
    setup: rows(raw['setup']).map((step) => ({ command: str(step['command']) ?? '', ms: num(step['ms']) ?? 0, ok: step['ok'] === true })),
    verify: verify === null ? null : {
      command: str(verify['command']), exitCode: num(verify['exit_code']), signal: str(verify['signal']), timedOut: verify['timed_out'] === true,
      ms: num(verify['ms']) ?? 0, queuedMs: num(verify['queued_ms']) ?? 0, workers: num(verify['workers']), outputBytes: num(verify['output_bytes']) ?? 0,
    },
    appeared: Array.isArray(raw['appeared']) ? rows(raw['appeared']).map((entry) => ({ path: str(entry['path']) ?? '', bytes: num(entry['bytes']) ?? 0 })) : null,
    appearedCount: num(raw['appeared_count']) ?? 0,
    reclaim: rows(raw['reclaim']).map((entry) => ({
      path: str(entry['path']) ?? '', appeared: entry['appeared'] === true, ignored: entry['ignored'] === true,
      trackedFiles: num(entry['tracked_files']) ?? 0, bytes: num(entry['bytes']), link: entry['link'] === true,
    })),
    laneBytes: num(raw['lane_bytes']),
    outputTail: str(raw['output_tail']) ?? '',
  };
}
