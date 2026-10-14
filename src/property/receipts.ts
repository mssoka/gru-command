import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CaptureState,
  ExecutionBudget,
  ExecutionIdentity,
  OutputArtefactRef,
  OverlayIdentity,
  PropertyExecutionReceipt,
  PropertyFailureRecord,
  PropertyRunOutcome,
  ReplayData,
  RetainedCounterexample,
  SandboxEnforcement,
  SourceIdentity,
} from './types.js';
import { sha256Hex } from './overlay.js';

/**
 * Receipt assembly (GH350 seam B, contract v3): typed receipts binding
 * exact source, overlay, config, lock, adapter and tool identity, the
 * verbatim argv and selection filter, output artefact hashes, capture
 * truncation state, and the replay data retained with every counterexample.
 *
 * Honesty rules implemented here:
 *  - the source identity is a DIGEST story, never a boolean: a clean tree
 *    yields `clean-sha`; a dirty tracked tree is REFUSED (`refused-dirty`)
 *    because dirty-source execution is not supported by this executor; a
 *    repo where git cannot answer is a named error, never a null SHA.
 *  - output artefact refs hash the bytes actually captured (post-truncation,
 *    marker included), so the receipt always describes exactly what the
 *    host saw.
 *  - replay data is extracted only from evidence the runner actually
 *    reported (failure-message seed/counterexample conventions); anything
 *    absent stays `null`/empty — it is never guessed.
 */

export class GitIdentityUnavailableError extends Error {
  readonly code = 'git-identity-unavailable';
  constructor(readonly repoRoot: string, readonly detail: string) {
    super(
      `cannot establish git identity for ${repoRoot}: ${detail} — ` +
        'property receipts bind the exact source commit and refuse to run without it',
    );
    this.name = 'GitIdentityUnavailableError';
  }
}

export class ReceiptCoherenceError extends Error {
  readonly code = 'receipt-coherence';
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptCoherenceError';
  }
}

const GIT_TIMEOUT_MS = 10_000;

export function propertyGit(repoRoot: string, args: readonly string[]): string {
  // Repository config must not turn metadata discovery into host execution.
  return execFileSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-C', repoRoot, ...args], {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
}

/**
 * Source identity for a receipt (contract v3): HEAD sha plus tracked-tree
 * dirtiness read from the repo under review. Untracked files are excluded
 * on purpose — the overlay is the explicit representation of proposed
 * bytes and is bound separately, so dirty must mean exactly "tracked bytes
 * changed". A dirty tracked tree is `refused-dirty`: this executor does
 * not support dirty-source execution, and a boolean is not a digest.
 */
export function buildSourceIdentity(repoRoot: string): SourceIdentity {
  let sha: string;
  let statusText: string;
  try {
    sha = propertyGit(repoRoot, ['rev-parse', 'HEAD']).trim();
    statusText = propertyGit(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  } catch (error) {
    throw new GitIdentityUnavailableError(repoRoot, String(error));
  }
  if (sha === '') {
    throw new GitIdentityUnavailableError(repoRoot, 'git rev-parse HEAD returned no commit');
  }
  if (statusText.trim() !== '') {
    return { kind: 'refused-dirty', };
  }
  return { kind: 'clean-sha', sha };
}

/** sha256 of the governing lockfile bytes when one exists, else null. */
export function lockfileIdentity(packageDir: string, repoRoot: string): string | null {
  for (const dir of unique([packageDir, repoRoot])) {
    const lock = join(dir, 'package-lock.json');
    try {
      return sha256Hex(readFileSync(lock, 'utf-8'));
    } catch {
      // Absent at this root — try the next.
    }
  }
  return null;
}

/** sha256 of `.gru-command/property.toml` when one exists, else null. */
export function propertyConfigIdentity(repoRoot: string): string | null {
  try {
    return sha256Hex(readFileSync(join(repoRoot, '.gru-command', 'property.toml'), 'utf-8'));
  } catch {
    return null;
  }
}

function unique(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

/**
 * Build the v3 execution identity from independently verified parts. The
 * argv is the argv ACTUALLY executed (element 0 = executable), verbatim;
 * the selection filter is the plan's binding for this run.
 */
export function buildExecutionIdentity(input: {
  readonly source: SourceIdentity;
  readonly argv: readonly string[];
  readonly selectionFilter: string;
  readonly lockIdentity: string | null;
  readonly configIdentity: string | null;
  readonly overlay: OverlayIdentity | null;
  readonly adapterProfile: string;
  readonly toolVersions: Readonly<Record<string, string>>;
}): ExecutionIdentity {
  const { source, argv, selectionFilter } = input;
  if (argv.length === 0 || argv[0] === '') {
    throw new ReceiptCoherenceError('execution identity requires a non-empty argv (element 0 = executable)');
  }
  if (argv.includes('') ) {
    throw new ReceiptCoherenceError('execution identity argv must not contain empty elements');
  }
  return {
    source,
    argv: [...argv],
    selectionFilter,
    lockIdentity: input.lockIdentity,
    configIdentity: input.configIdentity,
    overlay: input.overlay,
    adapterProfile: input.adapterProfile,
    toolVersions: { ...input.toolVersions },
  };
}

/** Hashed reference to one captured output stream (hash covers the exact
 * captured text, including any truncation marker). */
export function outputArtefactRef(kind: 'stdout' | 'stderr', text: string): OutputArtefactRef {
  return { kind, bytes: Buffer.byteLength(text, 'utf-8'), sha256: sha256Hex(text) };
}

export function outputArtefactRefs(stdout: string, stderr: string): readonly OutputArtefactRef[] {
  return [outputArtefactRef('stdout', stdout), outputArtefactRef('stderr', stderr)];
}

/** Capture-completeness state from the executor's stream observers. */
export function captureState(stdoutTruncated: boolean, stderrTruncated: boolean): CaptureState {
  return {
    stdoutTruncated,
    stderrTruncated,
    complete: !stdoutTruncated && !stderrTruncated,
  };
}

/**
 * Environment profile string: a stable, per-run summary of the scrubbed
 * execution environment. Volatile entries (HOME, TMPDIR — per-workspace
 * values by construction) are excluded so the profile identifies the
 * environment POLICY inputs, not the throwaway workspace path.
 */
export function environmentProfileString(env: Readonly<Record<string, string>>): string {
  const volatile = new Set(['HOME', 'TMPDIR', 'GRU_PROPERTY_SEED', 'GRU_PROPERTY_PATH']);
  const canonical = Object.keys(env)
    .filter((key) => !volatile.has(key))
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join('\n');
  return `platform=${process.platform};node=${process.versions.node};env=${sha256Hex(canonical).slice(0, 16)}`;
}

/**
 * Shrink-path extraction from a failure message: lines of the documented
 * form `shrink: <step>` (optionally `shrink #2: <step>` / `shrinked:`)
 * accumulate in order. Stock fast-check output carries no such lines, so
 * the honest result there is an empty path.
 */
export function extractShrinkPath(message: string): readonly string[] {
  // Native fast-check failure output: { seed: N, path: "0:1:2", ... }.
  const nativePath = /\bpath:\s*"([0-9:]*)"/u.exec(message);
  if (nativePath !== null) return [nativePath[1]!];
  const steps: string[] = [];
  const pattern = /^[ \t]*shrink(?:ed)?[ \t]*(?:#\d+)?[ \t]*[:=][ \t]*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message)) !== null) steps.push((match[1] as string).trim());
  return steps;
}

/**
 * Minimized-counterexample input extraction from a failure message. The
 * documented convention is fast-check's reporter line `Counterexample: X`
 * (single line, verbatim after the colon). When no such line exists the
 * honest fallback is the failure excerpt itself, labelled as unparsed —
 * never an invented input.
 */
export function extractCounterexampleInput(message: string): { readonly input: string; readonly parsed: boolean } {
  const match = /^Counterexample:[ \t]*(.+)$/m.exec(message);
  if (match !== null) return { input: (match[1] as string).trim(), parsed: true };
  return { input: message.trim(), parsed: false };
}

/**
 * Replay data retained with a retained counterexample. Returns `null` when
 * there are no failures to retain — a passing run has nothing to replay.
 */
export function extractReplayData(input: {
  readonly failures: readonly PropertyFailureRecord[];
  readonly environmentProfile: string;
  readonly schedule?: string | null;
  readonly replaySupported?: boolean;
  readonly replayDisclosure?: string | null;
}): ReplayData | null {
  const { failures, environmentProfile } = input;
  if (failures.length === 0) return null;
  const withSeed = failures.find((failure) => failure.seed !== null) ?? null;
  const seed = withSeed?.seed ?? null;
  const shrinkPath = failures
    .flatMap((failure) => [...extractShrinkPath(failure.messageExcerpt)])
    .slice(0, 64);
  return {
    seed,
    shrinkPath,
    schedule: input.schedule ?? null,
    environmentProfile,
    // Replay-by-seed is only claimed when a seed was actually retained.
    replaySupported: input.replaySupported ?? seed !== null,
    replayDisclosure: input.replayDisclosure ?? null,
  };
}

/**
 * Retain the minimized counterexample for a failing run: the parsed
 * counterexample input plus its replay controls. `null` for runs without
 * a selected property failure.
 */
export function retainedCounterexample(input: {
  readonly outcome: PropertyRunOutcome;
  readonly environmentProfile: string;
}): RetainedCounterexample | null {
  const { outcome, environmentProfile } = input;
  if (outcome.kind !== 'property-failure' || outcome.failures.length === 0) return null;
  const primary = outcome.failures[0] as PropertyFailureRecord;
  const extracted = extractCounterexampleInput(primary.messageExcerpt);
  const replay = extractReplayData({ failures: outcome.failures, environmentProfile, replaySupported: extracted.parsed && primary.seed !== null });
  if (replay === null) return null;
  return {
    minimizedInput: extracted.input,
    replay: extracted.parsed
      ? replay
      : {
          ...replay,
          replayDisclosure:
            replay.replayDisclosure === null
              ? 'counterexample input could not be parsed from the failure message — retained excerpt is verbatim, not a parsed minimized input'
              : replay.replayDisclosure,
        },
  };
}

/**
 * Assemble the final host-owned receipt from already-honest parts. This
 * function only ARRANGES evidence; it is unsealed by construction — only
 * the executor's issuance closure can mint a sealed receipt.
 */
export function assemblePropertyExecutionReceipt(input: {
  readonly identity: ExecutionIdentity;
  readonly command: string;
  readonly cwd: string;
  readonly outcome: PropertyRunOutcome;
  readonly stdout: string;
  readonly stderr: string;
  readonly capture: CaptureState;
  readonly counterexample: RetainedCounterexample | null;
  readonly sandbox: SandboxEnforcement;
  readonly replay: ReplayData | null;
  readonly budget: ExecutionBudget;
}): PropertyExecutionReceipt {
  const { identity, command, cwd, outcome, stdout, stderr, capture, counterexample, sandbox, replay, budget } = input;
  if (identity.argv[0] !== command) {
    throw new ReceiptCoherenceError(
      `receipt command ${JSON.stringify(command)} disagrees with identity argv[0] ${JSON.stringify(identity.argv[0])}`,
    );
  }
  if (outcome.receipt.stdout !== stdout || outcome.receipt.stderr !== stderr) {
    throw new ReceiptCoherenceError('receipt output streams disagree with the outcome raw receipt streams');
  }
  return {
    identity,
    command,
    cwd,
    outcome,
    outputs: outputArtefactRefs(stdout, stderr),
    capture,
    counterexample,
    sandbox,
    replay,
    budget,
  };
}

/** sha256 of arbitrary bytes (used for lock/config identities). */
export function sha256Bytes(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
