import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Review-source preflight (issue #317). A report-review job is admitted
 * only after the ACTUAL object store it will review from — the repository
 * the worktree manager branches in, or a validated immutable source
 * package — has proven it holds the exact target commit, the focused-delta
 * base and range, and every required content input. Repository basename,
 * origin equality, advertised metadata and a clean HEAD prove nothing: two
 * clones of one origin can differ by exactly the commits under review.
 *
 * A preflight failure is a named refusal BEFORE any job row, worktree or
 * reviewer spawn: never a no-findings report, a completed review, or
 * authority for an automatic retry. The one repair is explicit and
 * commissioner-authorized: a source package pinned by sha256 is verified
 * as a git bundle and fetched into the SELECTED repository's object store
 * only (a private ref, never a checkout, reset or unrelated worktree).
 */

/** Lenses that may declare required inputs. Blind-isolated lenses never
 * receive claims inputs (blind isolation is governed separately, #316). */
export const REVIEW_INPUT_LENSES = ['claims'] as const;
export type ReviewInputLens = (typeof REVIEW_INPUT_LENSES)[number];

export interface ReviewRequiredInput {
  /** Repo-relative path that must exist as a file in the target tree. */
  readonly path: string;
  readonly lens: ReviewInputLens;
}

export interface ReviewSourcePackage {
  /** Absolute path of a git bundle holding the target. */
  readonly path: string;
  /** Pinned content hash: the package is immutable or it is refused. */
  readonly sha256: string;
}

export interface ReviewSourceRequest {
  readonly jobId: string;
  readonly repoPath: string;
  /** Exact commit (hex object id, abbreviated or full). */
  readonly targetSha: string;
  /** Focused-delta base: the range reviewed is `targetBase..targetSha`. */
  readonly targetBase?: string;
  readonly requiredInputs?: readonly ReviewRequiredInput[];
  readonly sourcePackage?: ReviewSourcePackage;
}

export interface ReviewBoundInput {
  readonly path: string;
  readonly lens: ReviewInputLens;
  readonly blob: string;
}

export interface ReviewSourceBinding {
  /** Canonical git common directory of the selected object store. */
  readonly objectStore: string;
  readonly repoPath: string;
  readonly targetSha: string;
  readonly targetBase: string | null;
  /** Commits in `targetBase..targetSha`; null when no base was named. */
  readonly rangeCommits: number | null;
  readonly inputs: readonly ReviewBoundInput[];
  readonly source: 'repository' | 'source-package';
  readonly packageSha256: string | null;
}

export type ReviewSourcePreflight = (request: ReviewSourceRequest) => ReviewSourceBinding;

/** The named boundary error: the selected source cannot provide what the
 * review names. Carries every concrete problem and the remedy. */
export class ReviewSourceUnavailableError extends Error {
  readonly problems: readonly string[];
  constructor(jobId: string, repoPath: string, problems: readonly string[], remedy: string) {
    super(
      `review source preflight refused job "${jobId}" — the object store of ${repoPath} cannot provide the review inputs: ` +
        `${problems.join('; ')}. No minion was spawned and no review ran; ${remedy}`,
    );
    this.name = 'ReviewSourceUnavailableError';
    this.problems = problems;
  }
}

const HEX_OBJECT_ID = /^[0-9a-f]{7,64}$/iu;
const SHA256_HEX = /^[0-9a-f]{64}$/iu;
const REMEDY_NO_PACKAGE =
  'dispatch to the repository that holds the commits, or re-dispatch with an explicit source_package ' +
  '({path, sha256} of a git bundle) authorizing a repair; this refusal is not a completed review and is not retried automatically';

/** Inherited repository-selection variables must never redirect the probe
 * away from the repository the caller named. */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
    delete env[key];
  }
  return env;
}

function git(cwd: string, args: readonly string[]): { readonly ok: boolean; readonly out: string; readonly err: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: cleanGitEnv(), maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: result.error === undefined && result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.error?.message ?? result.stderr ?? '').trim(),
  };
}

interface Inspection {
  readonly problems: readonly string[];
  readonly targetSha: string | null;
  readonly targetBase: string | null;
  readonly rangeCommits: number | null;
  readonly inputs: readonly ReviewBoundInput[];
}

function resolveCommit(cwd: string, rev: string): string | null {
  const result = git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return result.ok && result.out !== '' ? result.out : null;
}

function inspect(storeDir: string, request: ReviewSourceRequest): Inspection {
  const problems: string[] = [];
  const target = resolveCommit(storeDir, request.targetSha);
  if (target === null) {
    problems.push(`target commit ${request.targetSha} is not in the object store`);
  } else if (!git(storeDir, ['rev-list', '--objects', '--missing=error', '--max-count=1', target]).ok) {
    problems.push(`target commit ${target} is present but its tree is incomplete (missing objects)`);
  }
  let base: string | null = null;
  let rangeCommits: number | null = null;
  if (request.targetBase !== undefined) {
    base = resolveCommit(storeDir, request.targetBase);
    if (base === null) {
      problems.push(`focused-delta base ${request.targetBase} is not in the object store`);
    } else if (target !== null) {
      const range = `${base}..${target}`;
      const walk = git(storeDir, ['rev-list', '--objects', '--missing=error', '--count', range]);
      const count = git(storeDir, ['rev-list', '--count', range]);
      if (!walk.ok || !count.ok) {
        problems.push(`range ${request.targetBase}..${request.targetSha} cannot be walked (invalid revision range or missing objects)`);
      } else if (Number(count.out) === 0) {
        problems.push(`range ${request.targetBase}..${request.targetSha} contains no commits to review`);
      } else {
        rangeCommits = Number(count.out);
      }
    }
  }
  const inputs: ReviewBoundInput[] = [];
  if (target !== null) {
    for (const input of request.requiredInputs ?? []) {
      const spec = `${target}:${input.path}`;
      const blob = git(storeDir, ['rev-parse', '--verify', '--quiet', spec]);
      const kind = blob.ok ? git(storeDir, ['cat-file', '-t', blob.out]) : null;
      if (!blob.ok || kind === null || !kind.ok || kind.out !== 'blob') {
        problems.push(`required ${input.lens} input ${input.path} is not a file in the target tree`);
      } else {
        inputs.push({ path: input.path, lens: input.lens, blob: blob.out });
      }
    }
  }
  return { problems, targetSha: target, targetBase: base, rangeCommits, inputs };
}

/** The blob a commit's tree holds at a path, or null (absent, not a file). */
export function targetBlob(storeDir: string, commit: string, path: string): string | null {
  const blob = git(storeDir, ['rev-parse', '--verify', '--quiet', `${commit}:${path}`]);
  if (!blob.ok || blob.out === '') return null;
  const kind = git(storeDir, ['cat-file', '-t', blob.out]);
  return kind.ok && kind.out === 'blob' ? blob.out : null;
}

/** The full commit a revision names in the store, or null. */
export function storeCommit(storeDir: string, rev: string): string | null {
  return resolveCommit(storeDir, rev);
}

/** Every path `base..target` changes (renames as a deletion plus an
 * addition), or null when the range cannot be read. */
export function changedPaths(storeDir: string, base: string, target: string): ReadonlySet<string> | null {
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', base, target], { cwd: storeDir, encoding: 'utf-8', env: cleanGitEnv(), maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) return null;
  return new Set((result.stdout ?? '').split('\0').filter((path) => path !== ''));
}

/** Verify the pinned bundle and fetch it into the selected repository. */
function repairFromPackage(request: ReviewSourceRequest, pkg: ReviewSourcePackage, repoDir: string): string[] {
  if (!SHA256_HEX.test(pkg.sha256)) return [`source package sha256 must be 64 hex characters`];
  if (!existsSync(pkg.path)) return [`source package ${pkg.path} does not exist`];
  const digest = createHash('sha256').update(readFileSync(pkg.path)).digest('hex');
  if (digest !== pkg.sha256.toLowerCase()) {
    return [`source package ${pkg.path} hash ${digest} does not match the pinned sha256 ${pkg.sha256.toLowerCase()} (not immutable)`];
  }
  const verified = git(repoDir, ['bundle', 'verify', pkg.path]);
  if (!verified.ok) return [`source package ${pkg.path} failed git bundle verify: ${verified.err.split('\n').pop() ?? ''}`];
  const heads = git(repoDir, ['bundle', 'list-heads', pkg.path]);
  const wanted = request.targetSha.toLowerCase();
  const carrier = heads.out
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .find(([oid, ref]) => oid !== undefined && ref !== undefined && oid.toLowerCase().startsWith(wanted));
  if (!carrier?.[1]) return [`source package ${pkg.path} carries no ref at target ${request.targetSha}`];
  const fetched = git(repoDir, ['fetch', '--quiet', '--no-tags', pkg.path, `${carrier[1]}:refs/gru/review-source/${request.jobId}`]);
  if (!fetched.ok) return [`fetching source package ${pkg.path} failed: ${fetched.err.split('\n').pop() ?? ''}`];
  return [];
}

/** The production preflight: git against the actual selected repository. */
export const gitReviewSourcePreflight: ReviewSourcePreflight = (request) => {
  if (!HEX_OBJECT_ID.test(request.targetSha)) {
    throw new ReviewSourceUnavailableError(request.jobId, request.repoPath, [`target_sha "${request.targetSha}" is not an exact commit id`], REMEDY_NO_PACKAGE);
  }
  if (request.targetBase !== undefined && !HEX_OBJECT_ID.test(request.targetBase)) {
    throw new ReviewSourceUnavailableError(request.jobId, request.repoPath, [`target_base "${request.targetBase}" is not an exact commit id`], REMEDY_NO_PACKAGE);
  }
  if (!existsSync(request.repoPath)) {
    throw new ReviewSourceUnavailableError(request.jobId, request.repoPath, ['repository path does not exist'], REMEDY_NO_PACKAGE);
  }
  const identity = git(request.repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!identity.ok) {
    throw new ReviewSourceUnavailableError(request.jobId, request.repoPath, ['path is not a git repository'], REMEDY_NO_PACKAGE);
  }
  const objectStore = realpathSync(identity.out);
  let source: ReviewSourceBinding['source'] = 'repository';
  let result = inspect(request.repoPath, request);
  if (result.problems.length > 0 && request.sourcePackage !== undefined) {
    const repairProblems = repairFromPackage(request, request.sourcePackage, request.repoPath);
    if (repairProblems.length > 0) {
      throw new ReviewSourceUnavailableError(request.jobId, request.repoPath, [...result.problems, ...repairProblems], 'the authorized source package could not repair the source; fix the package or the repository and re-dispatch explicitly');
    }
    source = 'source-package';
    result = inspect(request.repoPath, request);
  }
  if (result.problems.length > 0 || result.targetSha === null) {
    throw new ReviewSourceUnavailableError(
      request.jobId,
      request.repoPath,
      result.problems,
      request.sourcePackage === undefined ? REMEDY_NO_PACKAGE : 'even after the authorized source package repair; fix the package and re-dispatch explicitly',
    );
  }
  return {
    objectStore,
    repoPath: request.repoPath,
    targetSha: result.targetSha,
    targetBase: result.targetBase,
    rangeCommits: result.rangeCommits,
    inputs: result.inputs,
    source,
    packageSha256: source === 'source-package' && request.sourcePackage !== undefined ? request.sourcePackage.sha256.toLowerCase() : null,
  };
};

/** The reviewer lane must share the exact object store the preflight
 * proved — never "whatever happens to be in the reviewer worktree". */
export function assertLaneUsesBoundStore(jobId: string, binding: ReviewSourceBinding, lanePath: string): void {
  const lane = git(lanePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const laneStore = lane.ok ? realpathSync(lane.out) : null;
  if (laneStore !== binding.objectStore) {
    throw new ReviewSourceUnavailableError(
      jobId,
      binding.repoPath,
      [`reviewer worktree ${lanePath} uses object store ${laneStore ?? 'unknown'}, not the verified ${binding.objectStore}`],
      'the lane was swept; no review ran',
    );
  }
}

/** Briefing block binding the exact target/range/inputs for the reviewer. */
export function renderReviewSourceBlock(binding: ReviewSourceBinding): readonly string[] {
  return [
    'REVIEW SOURCE (preflight-verified in the object store this worktree uses):',
    `Target commit: ${binding.targetSha}`,
    ...(binding.targetBase === null
      ? []
      : [`Range: ${binding.targetBase}..${binding.targetSha} (${binding.rangeCommits} commits)`]),
    ...binding.inputs.map(
      (input) => `Required ${input.lens} input: ${input.path} @ ${binding.targetSha} (blob ${input.blob}) — for ${input.lens}-needed lenses only`,
    ),
    'Read these exact objects (git show / git diff by sha); do not substitute the worktree checkout.',
  ];
}
