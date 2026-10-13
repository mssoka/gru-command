import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * Narrow build reuse for compatible verification gates (issue #318).
 *
 * Prerequisite analysis (fixed candidate 12142cf2, 109 declared scopes):
 * 17 scopes run `npm run build`; 6 of those are plain `&&` chains of
 * `npm`/`node` steps. The only steps declared ahead of the build are
 * `node tools/patch-vitest-rpc-timeout.mjs`, `npm run lint` and
 * `npm run typecheck` — none of them writes the build outputs (lint is
 * read-only, typecheck is `tsc --noEmit`, the patch edits node_modules
 * test-runner internals). Every other scope shape (quotes, `cd`, `set -e`,
 * `||`, pipes, env prefixes, a build preceded by an unknown step) is a
 * prerequisite this module cannot reason about, so it is NON-reusable and
 * runs exactly as declared.
 *
 * This is deliberately not a build cache. A single, exact step
 * (`npm run build`) in a single, exact lane directory may be satisfied by
 * the immediately preceding successful execution of that same step when —
 * and only when — every input is provably identical right now (see
 * {@link inspectReuse}). The proof boundary is the recursive digest of the
 * whole build output tree: every file under `dist/`, by sorted relative
 * path and content digest. Reuse only ever replaces the build step; every
 * gate-specific check still executes and is reported separately.
 *
 * A donor needs only its BUILD step to have passed: the record is taken the
 * moment `npm run build` exits 0, so a run whose later step failed still
 * donates its build (per-step truth, intentional). Reuse is on by default
 * with no configuration off-switch — disabling it is code-level only
 * (`new VerificationScheduler({ buildReuse: false })`).
 */

/** The one step that may be reused. */
export const REUSABLE_BUILD_STEP = 'npm run build';

/**
 * Steps that may precede the build in a reusable chain. They are
 * output-neutral (they never write the build outputs). Any other step ahead
 * of the build is an unknown prerequisite.
 */
export const BUILD_NEUTRAL_PREREQUISITES: ReadonlySet<string> = new Set([
  'node tools/patch-vitest-rpc-timeout.mjs',
  'npm run lint',
  'npm run typecheck',
]);

/** The build output trees whose whole-tree digest is the reuse proof. */
export const DEFAULT_BUILD_OUTPUT_ROOTS: readonly string[] = ['dist'];

/** One file inside a build output tree, named relative to that tree's root. */
export interface OutputFile {
  readonly path: string;
  readonly digest: string;
}

/** The proven state of the build output trees. */
export interface OutputFingerprint {
  /** Stable digest over every output file (sorted path + content digest). */
  readonly digest: string;
  /** The sorted file listing the digest covers. */
  readonly files: readonly OutputFile[];
}

/** Environment keys that legitimately differ between compatible gates. */
const VOLATILE_ENV_KEYS: ReadonlySet<string> = new Set(['GRU_VERIFY_RUN_ID', 'GRU_VERIFY_SCOPE']);

const SIMPLE_STEP = /^(?:npm|node|npx) [A-Za-z0-9_./:=@ -]+$/;
const MAX_RECORDS = 16;

export type VerificationCheckStatus = 'passed' | 'failed' | 'reused' | 'not-run';

/** Truthful per-step evidence: what really ran, and how it ended. */
export interface VerificationCheck {
  readonly command: string;
  readonly status: VerificationCheckStatus;
  /** True only when a process for this step actually executed. */
  readonly ran: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  /** The run whose build execution satisfied this step (reused only). */
  readonly reusedFromRunId: string | null;
  /** Why a reusable-shaped build step still ran normally (null otherwise). */
  readonly reuseRefusal: string | null;
}

export interface CommandPlan {
  readonly steps: readonly string[];
  /** Index of the reusable build step; null = run the command as declared. */
  readonly buildIndex: number | null;
  /** Null when the build may participate; else why the chain is opaque. */
  readonly refusal: string | null;
}

/**
 * Decompose a declared command into its `&&` steps, but only when the whole
 * chain is simple enough that running each step in its own shell is exactly
 * equivalent to the original `sh -c` chain.
 */
export function planCommand(command: string): CommandPlan {
  const whole: CommandPlan = { steps: [command], buildIndex: null, refusal: null };
  const steps = command.split(' && ');
  if (steps.length < 2 || !steps.every((step) => SIMPLE_STEP.test(step) && step === step.trim())) {
    return whole;
  }
  const buildSteps = steps.flatMap((step, index) => (step === REUSABLE_BUILD_STEP ? [index] : []));
  if (buildSteps.length !== 1) return whole;
  const buildIndex = buildSteps[0]!;
  const unknown = steps.slice(0, buildIndex).find((step) => !BUILD_NEUTRAL_PREREQUISITES.has(step));
  return {
    steps,
    buildIndex,
    refusal: unknown === undefined ? null : `unknown-prerequisite: ${unknown}`,
  };
}

export interface BuildInputs {
  readonly head: string | null;
  readonly clean: boolean;
  readonly config: string;
  readonly env: string;
  readonly outputs: OutputFingerprint | null;
}

export interface BuildRecord extends BuildInputs {
  readonly runId: string;
  readonly cwd: string;
}

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function sha(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${part.length}:${part}\n`);
  return hash.digest('hex');
}

function fileDigest(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'absent';
  }
}

/** Hash of the build-relevant configuration files (tracked or not). */
function configFingerprint(cwd: string): string {
  let names: string[];
  try {
    names = readdirSync(cwd).filter((name) => /^tsconfig.*\.json$/.test(name));
  } catch {
    return 'unreadable';
  }
  const files = ['package.json', 'package-lock.json', '.npmrc', ...names].sort();
  return sha(files.map((file) => `${file}=${fileDigest(join(cwd, file))}`));
}

function envFingerprint(env: NodeJS.ProcessEnv): string {
  return sha(
    Object.entries(env)
      .filter(([key, value]) => value !== undefined && !VOLATILE_ENV_KEYS.has(key))
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`),
  );
}

const byRelativePath = (left: OutputFile, right: OutputFile): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

/** Every file under `root` (POSIX-relative paths), or null when unreadable. */
function outputFiles(root: string): OutputFile[] | null {
  const files: OutputFile[] = [];
  const walk = (dir: string, prefix: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!walk(join(dir, entry.name), relative)) return false;
      } else if (entry.isFile()) {
        const digest = fileDigest(join(dir, entry.name));
        if (digest === 'absent') return false;
        files.push({ path: relative, digest });
      } else {
        // A link or other nonregular entry is not a complete output proof.
        // Refuse reuse rather than silently omit bytes the build may import.
        return false;
      }
    }
    return true;
  };
  return walk(root, '') ? files.sort(byRelativePath) : null;
}

/** Whole-tree digest of every output root, or null when any root is missing. */
function outputsFingerprint(cwd: string, roots: readonly string[]): OutputFingerprint | null {
  const files: OutputFile[] = [];
  for (const root of roots) {
    const listing = outputFiles(join(cwd, root));
    if (listing === null) return null;
    for (const file of listing) files.push({ path: `${root}/${file.path}`, digest: file.digest });
  }
  files.sort(byRelativePath);
  return { digest: sha(files.map((file) => `${file.path}=${file.digest}`)), files };
}

/** Observe the inputs of a build in `cwd` right now. */
export function observeBuildInputs(
  cwd: string,
  env: NodeJS.ProcessEnv,
  roots: readonly string[],
): BuildInputs {
  const head = git(cwd, ['rev-parse', 'HEAD']);
  // Tracked AND untracked (non-ignored) changes are input: unknown = dirty.
  const status = git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  return {
    head: head === null || head === '' ? null : head,
    clean: status === '',
    config: configFingerprint(cwd),
    env: envFingerprint(env),
    outputs: outputsFingerprint(cwd, roots),
  };
}

/**
 * Decide whether `record` may stand in for a build in the current state.
 * Returns null when reuse is proven safe, else the (loud, specific) reason
 * the build must run normally.
 */
export function inspectReuse(
  record: BuildRecord | undefined,
  now: BuildInputs,
  leaseHead: string | null,
): string | null {
  if (record === undefined) return 'no-prior-build';
  if (leaseHead === null || now.head === null) return 'head-unknown';
  if (now.head !== leaseHead || now.head !== record.head) return 'head-changed';
  if (!now.clean) return 'dirty-input';
  if (now.config !== record.config) return 'config-changed';
  if (now.env !== record.env) return 'env-changed';
  if (now.outputs === null) return 'outputs-missing';
  if (record.outputs === null) return 'outputs-changed';
  if (now.outputs.digest !== record.outputs.digest) {
    const changed = firstOutputDifference(record.outputs, now.outputs);
    return changed === null ? 'outputs-changed' : `outputs-changed: ${changed}`;
  }
  return null;
}

/** First output file, by sorted path, that differs between two fingerprints. */
function firstOutputDifference(record: OutputFingerprint, now: OutputFingerprint): string | null {
  const recordByPath = new Map(record.files.map((file) => [file.path, file.digest] as const));
  const nowByPath = new Map(now.files.map((file) => [file.path, file.digest] as const));
  const paths = [...new Set([...recordByPath.keys(), ...nowByPath.keys()])].sort();
  for (const path of paths) {
    if (recordByPath.get(path) !== nowByPath.get(path)) return path;
  }
  return null;
}

/** Bounded per-lane-directory memory of the last proven-good build. */
export class BuildRecords {
  private readonly records = new Map<string, BuildRecord>();
  private readonly building = new Map<string, number>();

  get(cwd: string): BuildRecord | undefined {
    return this.records.get(cwd);
  }

  /** A build step is starting: nothing earlier may be inherited past it. */
  beginBuild(cwd: string): void {
    this.records.delete(cwd);
    this.building.set(cwd, (this.building.get(cwd) ?? 0) + 1);
  }

  isBuilding(cwd: string): boolean {
    return (this.building.get(cwd) ?? 0) > 0;
  }

  endBuild(cwd: string): void {
    const remaining = (this.building.get(cwd) ?? 0) - 1;
    if (remaining > 0) this.building.set(cwd, remaining);
    else this.building.delete(cwd);
  }

  /** Remember a successful build; refuses unprovable states (returns false). */
  remember(cwd: string, runId: string, after: BuildInputs, leaseHead: string | null): boolean {
    this.records.delete(cwd);
    if (leaseHead === null || after.head !== leaseHead || !after.clean || after.outputs === null) {
      return false;
    }
    this.records.set(cwd, { ...after, runId, cwd });
    for (const key of this.records.keys()) {
      if (this.records.size <= MAX_RECORDS) break;
      this.records.delete(key);
    }
    return true;
  }

  forget(cwd: string): void {
    this.records.delete(cwd);
  }
}
