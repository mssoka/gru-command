import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsPromised = promisify(execFileCallback);
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BranchIdleTag } from '../branch-idle.js';
import type { CiEvidenceRecord } from '../../review-inputs/ci-evidence.js';
import {
  freezeEvidenceAttachments,
  REVIEW_EVIDENCE_MAX_FILE_BYTES,
  REVIEW_EVIDENCE_MAX_FILES,
  REVIEW_EVIDENCE_MAX_TOTAL_BYTES,
  type FrozenEvidenceAttachment,
  type FrozenEvidenceRuntimeAttachment,
  type ReviewEvidenceRequest,
} from '../../review-inputs/evidence.js';

const GIT_MAX_BUFFER = 128 * 1024 * 1024;
export const FROZEN_DIFF_MAX_BYTES = 8 * 1024 * 1024;
export const FROZEN_SPEC_MAX_BYTES = 256 * 1024;
export const FROZEN_CONVENTIONS_MAX_BYTES = 256 * 1024;
export const FROZEN_MANIFEST_MAX_BYTES = 256 * 1024;
export const FROZEN_CHANGED_FILES_MAX_BYTES = 256 * 1024;
export const SPECIALIST_CHECKPOINT_MAX_BYTES = 1024 * 1024;

export interface FrozenAcceptance {
  readonly version: number;
  /** sha256 of the original briefing bytes ('' when none was recorded). */
  readonly baseSha256: string;
  /** sha256 of the frozen effective acceptance text. */
  readonly contractSha256: string;
  readonly amendmentIds: readonly string[];
}

export interface FrozenReviewEvidenceManifest {
  /** Frozen attachment metadata (round-relative paths, no bytes). */
  readonly attachments: readonly FrozenEvidenceAttachment[];
  /** The exact-target CI record as bound at freeze, or null when none was
   * requested/recorded. Historical: late results never rewrite it. */
  readonly ci: CiEvidenceRecord | null;
}

export interface FrozenReviewInputs {
  readonly schemaVersion: 2;
  readonly roundId: string;
  /** Absent provenance makes an older manifest ineligible for recovery. */
  readonly recoveryIdentity: ReviewRecoveryIdentity | null;
  readonly repoPath: string;
  readonly targetRef: string;
  readonly baseRef: string;
  readonly targetSha: string;
  readonly baseRefSha: string;
  readonly diffBaseSha: string;
  readonly diffSha256: string;
  readonly specMode: 'supplied' | 'explicit-no-spec';
  readonly specSha256: string;
  readonly conventionsSha256: string;
  readonly changedFilesSha256: string;
  readonly createdAt: string;
  /** Changed file paths of the frozen diff (the whole-PR review unit). */
  readonly changedFiles: readonly string[];
  /** Effective acceptance binding: which contract version/hashes and which
   * amendment ids the frozen spec was rendered from. Present for supplied
   * specs (version 0 = original briefing only). */
  readonly acceptance?: FrozenAcceptance;
  /** Private frozen evidence + exact-target CI, when any was supplied. */
  readonly reviewEvidence?: FrozenReviewEvidenceManifest;
  /** Present only for a `force: true` arm: the branch-idle blockers the
   * override bypassed (the audit tag for a forced round). */
  readonly branchIdle?: BranchIdleTag;
}

export interface ReviewRecoveryIdentity {
  readonly jobId: string;
  readonly policySha256: string;
  readonly runtimeId: string;
  readonly runtimeVersion: string;
  readonly modelRef: string;
  readonly modelRole: string;
  readonly modelSettingsSha256: string;
  /** Entire tracked target tree, including assets not shown in the diff. */
  readonly trackedTreeSha: string;
}

export interface FreezeReviewInput {
  readonly recoveryIdentity?: Omit<ReviewRecoveryIdentity, 'trackedTreeSha'>;
  readonly roundId: string;
  readonly repoPath: string;
  readonly artifactRoot: string;
  readonly baseRef: string;
  readonly targetRef: string;
  /** Symbolic ref observed before the exact target SHA was selected. */
  readonly movementRef?: string;
  readonly spec?: string;
  readonly noSpec?: boolean;
  readonly now?: () => Date;
  /** Forced-arm tag (branch-idle override) recorded in the manifest. */
  readonly branchIdle?: BranchIdleTag;
  /** Owning job id, recorded in the private evidence receipt when known. */
  readonly jobId?: string;
  /** Effective-contract binding: the exact contract text the supplied spec
   * starts with, plus its version/hashes/provenance ids. */
  readonly acceptance?: {
    readonly contractText: string;
    readonly version: number;
    readonly baseSha256: string;
    readonly amendmentIds: readonly string[];
  };
  /** Authorized private evidence attachments to freeze this round. */
  readonly evidence?: readonly ReviewEvidenceRequest[];
  /** The configured service uploads dir (required when evidence is present). */
  readonly evidenceUploadsDir?: string;
  /** Bound exact-target CI record (from the ledger), stored in the manifest. */
  readonly ciEvidence?: CiEvidenceRecord | null;
}

export interface FrozenReview {
  readonly directory: string;
  readonly manifest: FrozenReviewInputs;
  readonly diff: string;
  readonly specContext: string;
  readonly projectConventions: string;
  /** Changed file paths of the complete frozen diff. */
  readonly changedFiles: readonly string[];
  /** Frozen private evidence (empty attachments when none was supplied) and
   * the bound exact-target CI record. */
  readonly evidence: {
    readonly attachments: readonly FrozenEvidenceRuntimeAttachment[];
    readonly ci: CiEvidenceRecord | null;
  };
}

function gitRaw(repoPath: string, args: readonly string[], timeoutMs = 30_000): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(repoPath: string, args: readonly string[], timeoutMs = 30_000): string {
  return gitRaw(repoPath, args, timeoutMs).trimEnd();
}

export function resolveGitCommit(repoPath: string, ref: string): string {
  if (ref.trim() === '') throw new Error('git ref must be non-empty');
  return git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

/** Resolve an explicit base, otherwise use the repository's real default branch. */
export function resolveReviewBaseRef(repoPath: string, explicit?: string | null): string {
  if (explicit !== undefined && explicit !== null && explicit.trim() !== '') return explicit;
  try {
    return git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  } catch {
    for (const candidate of ['main', 'master']) {
      try {
        resolveGitCommit(repoPath, candidate);
        return candidate;
      } catch {
        // Try the next conventional default; never guess beyond an existing ref.
      }
    }
  }
  throw new Error('complete review requires job.baseBranch or a resolvable origin/HEAD, main, or master base');
}

function hash(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function contained(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function ensureDirectoryWithoutSymlinks(path: string, boundary = path): string {
  const absolute = resolve(path);
  const root = resolve(boundary);
  if (!contained(root, absolute)) throw new Error(`review artifact directory escapes its trusted boundary: ${absolute}`);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`review artifact root must be a real directory: ${root}`);
  }
  let cursor = root;
  const rel = relative(root, absolute);
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) mkdirSync(cursor, { recursive: true, mode: 0o700 });
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`review artifact directory component must be a real directory: ${cursor}`);
    }
  }
  if (!contained(realpathSync(root), realpathSync(absolute))) {
    throw new Error(`review artifact directory resolves outside its trusted boundary: ${absolute}`);
  }
  return absolute;
}

function atomicWrite(path: string, contents: string, boundary = dirname(path)): void {
  ensureDirectoryWithoutSymlinks(dirname(path), boundary);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`review artifact destination must not be a symlink: ${path}`);
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    // A hard-link publish is atomic and fails with EEXIST instead of replacing
    // frozen evidence. Temp and destination share a directory/filesystem.
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}

/** Resolve one review-round directory without treating ledger-controlled ids
 * as paths. This also protects startup recovery of rows created by older
 * builds that did not validate identifiers at ingress. */
export function reviewArtifactDirectory(artifactRoot: string, roundId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(roundId) || roundId === '.' || roundId === '..') {
    throw new Error('review round id is not a safe artifact path component');
  }
  const root = ensureDirectoryWithoutSymlinks(artifactRoot);
  const directory = resolve(root, roundId);
  if (!contained(root, directory) || directory === root) {
    throw new Error('review artifact directory escapes the configured root');
  }
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`review round artifact path must be a real directory: ${directory}`);
    }
    if (!contained(realpathSync(root), realpathSync(directory))) {
      throw new Error(`review round artifact path resolves outside the configured root: ${directory}`);
    }
  }
  return directory;
}

function assertFrozenTreeHasNoSymlinks(repoPath: string, targetSha: string): void {
  const entries = gitRaw(repoPath, ['ls-tree', '-r', '-z', targetSha, '--']).split('\0').filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const metadata = tab === -1 ? entry : entry.slice(0, tab);
    const path = tab === -1 ? '(unknown)' : entry.slice(tab + 1);
    if (metadata.startsWith('120000 ')) {
      throw new Error(`frozen target contains a symlink, which review tools may not observe: ${path}`);
    }
  }
}

function assertReviewCheckoutClean(repoPath: string): void {
  const status = gitRaw(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
  if (status !== '') {
    const first = status.split('\0').find(Boolean)?.slice(0, 300) ?? 'unknown checkout mutation';
    throw new Error(`detached review checkout is not pristine (tracked/staged/untracked/ignored content: ${first})`);
  }
}

/** Changed file paths of the frozen delta, straight from the same frozen
 * revisions the diff came from (rename-aware destination names). */
function changedFilePaths(repoPath: string, diffBaseSha: string, targetSha: string): readonly string[] {
  return gitRaw(repoPath, ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--name-only', '-z', diffBaseSha, targetSha, '--'])
    .split('\0')
    .filter(Boolean);
}

function conventionPaths(changedFiles: readonly string[], tracked: ReadonlySet<string>): readonly string[] {
  const wanted = new Set<string>();
  for (const rootFile of ['AGENTS.md', 'CONTRIBUTING.md']) {
    if (tracked.has(rootFile)) wanted.add(rootFile);
  }
  for (const file of changedFiles) {
    const parts = file.split('/').filter(Boolean);
    parts.pop();
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const candidate = `${parts.slice(0, depth).join('/')}/AGENTS.md`;
      if (tracked.has(candidate)) wanted.add(candidate);
    }
  }
  return [...wanted].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length;
    return depth !== 0 ? depth : left.localeCompare(right);
  });
}

function readConventions(repoPath: string, targetSha: string, changedFiles: readonly string[]): string {
  const tracked = new Set(gitRaw(repoPath, ['ls-tree', '-r', '--name-only', '-z', targetSha, '--']).split('\0').filter(Boolean));
  const parts: string[] = [];
  let totalBytes = 0;
  for (const name of conventionPaths(changedFiles, tracked)) {
    const object = `${targetSha}:${name}`;
    const type = git(repoPath, ['cat-file', '-t', object]);
    const size = Number(git(repoPath, ['cat-file', '-s', object]));
    if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`project convention ${name} is not a regular tracked blob`);
    }
    totalBytes += size;
    if (size > FROZEN_CONVENTIONS_MAX_BYTES || totalBytes > FROZEN_CONVENTIONS_MAX_BYTES) {
      throw new Error(`frozen project conventions exceed ${FROZEN_CONVENTIONS_MAX_BYTES} UTF-8 bytes`);
    }
    const contents = gitRaw(repoPath, ['show', object]);
    if (contents.includes('\uFFFD')) {
      throw new Error(`project convention ${name} is not valid UTF-8 text`);
    }
    if (Buffer.byteLength(contents) !== size) {
      throw new Error(`project convention ${name} changed while frozen bytes were read`);
    }
    parts.push(`--- ${name} ---\n${contents.trimEnd()}`);
  }
  return parts.length === 0 ? 'No repository convention file was supplied.' : `${parts.join('\n\n')}\n`;
}

export function assertFrozenPromptBounds(review: Pick<FrozenReview, 'diff' | 'specContext' | 'projectConventions'>): void {
  const diffBytes = Buffer.byteLength(review.diff, 'utf8');
  if (diffBytes > FROZEN_DIFF_MAX_BYTES) {
    throw new Error(`frozen diff exceeds ${FROZEN_DIFF_MAX_BYTES} UTF-8 bytes`);
  }
  const specBytes = Buffer.byteLength(`${review.specContext}\n`, 'utf8');
  if (specBytes > FROZEN_SPEC_MAX_BYTES) {
    throw new Error(`frozen spec context exceeds ${FROZEN_SPEC_MAX_BYTES} UTF-8 bytes`);
  }
  const conventionBytes = Buffer.byteLength(review.projectConventions, 'utf8');
  if (conventionBytes > FROZEN_CONVENTIONS_MAX_BYTES) {
    throw new Error(`frozen project conventions exceed ${FROZEN_CONVENTIONS_MAX_BYTES} UTF-8 bytes`);
  }
}

export function freezeReviewInputs(input: FreezeReviewInput): FrozenReview {
  if (input.spec !== undefined && input.noSpec === true) throw new Error('review cannot supply both spec and explicit no-spec');
  if ((input.spec === undefined || input.spec.trim() === '') && input.noSpec !== true) {
    throw new Error('complete review requires frozen spec/context or explicit noSpec=true');
  }
  if (input.baseRef.trim() === '' || input.targetRef.trim() === '') throw new Error('review base and target refs are required');
  if (input.recoveryIdentity !== undefined &&
    (Object.keys(input.recoveryIdentity).sort().join(',') !== [
      'jobId', 'policySha256', 'runtimeId', 'runtimeVersion', 'modelRef', 'modelRole', 'modelSettingsSha256',
    ].sort().join(',') || Object.values(input.recoveryIdentity).some((value) =>
      typeof value !== 'string' || value.trim() === ''))) {
    throw new Error('recovery identity must contain every non-empty provenance field');
  }

  const targetSha = resolveGitCommit(input.repoPath, input.targetRef);
  const baseRefSha = resolveGitCommit(input.repoPath, input.baseRef);
  const diffBaseSha = git(input.repoPath, ['merge-base', baseRefSha, targetSha]);
  assertReviewCheckoutClean(input.repoPath);
  assertFrozenTreeHasNoSymlinks(input.repoPath, targetSha);
  const diff = gitRaw(input.repoPath, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--find-renames',
    '--find-copies',
    '--unified=3',
    diffBaseSha,
    targetSha,
    '--',
  ]);
  const changedFiles = changedFilePaths(input.repoPath, diffBaseSha, targetSha);
  if (changedFiles.length === 0) throw new Error(`frozen review diff is empty for ${diffBaseSha}..${targetSha}`);

  const specContext = input.noSpec === true ? 'EXPLICIT NO-SPEC REVIEW' : input.spec!;
  const specBytes = `${specContext}\n`;
  const projectConventions = readConventions(input.repoPath, targetSha, changedFiles);
  assertFrozenPromptBounds({ diff, specContext, projectConventions });
  // The effective acceptance must be the prefix the caller says it is: a
  // mismatched binding refuses rather than freezing a spec whose provenance
  // record would be a lie.
  let acceptance: FrozenAcceptance | undefined;
  if (input.acceptance !== undefined) {
    const contractText = input.acceptance.contractText.trimEnd();
    if (!specContext.startsWith(contractText)) {
      throw new Error('frozen spec context does not start with the bound effective contract; refusing to freeze a mismatched acceptance');
    }
    acceptance = {
      version: input.acceptance.version,
      baseSha256: input.acceptance.baseSha256,
      contractSha256: hash(input.acceptance.contractText),
      amendmentIds: [...input.acceptance.amendmentIds],
    };
  }
  const directory = reviewArtifactDirectory(input.artifactRoot, input.roundId);
  ensureDirectoryWithoutSymlinks(directory);
  // Private review evidence freezes FIRST (all requests validate before any
  // byte is published): a refused intake leaves the round directory without
  // partial evidence a later reader could mistake for a frozen record.
  const requestedEvidence = input.evidence ?? [];
  let frozenEvidence: {
    readonly attachments: readonly FrozenEvidenceRuntimeAttachment[];
    readonly receipt: readonly FrozenEvidenceAttachment[];
  } | null = null;
  if (requestedEvidence.length > 0) {
    if (input.evidenceUploadsDir === undefined || input.evidenceUploadsDir.trim() === '') {
      throw new Error('review evidence was requested but no evidence uploads directory is configured');
    }
    const frozen = freezeEvidenceAttachments({
      requests: requestedEvidence,
      uploadsDir: input.evidenceUploadsDir,
      roundDirectory: directory,
      roundId: input.roundId,
      jobId: input.jobId ?? null,
      targetSha,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    frozenEvidence = { attachments: frozen.attachments, receipt: frozen.receipt };
  }
  const ciEvidence = input.ciEvidence ?? null;
  atomicWrite(join(directory, 'diff.patch'), diff, directory);
  atomicWrite(join(directory, 'spec-context.md'), specBytes, directory);
  atomicWrite(join(directory, 'project-conventions.md'), projectConventions, directory);
  const changedFilesBytes = `${JSON.stringify(changedFiles, null, 2)}\n`;
  if (Buffer.byteLength(changedFilesBytes) > FROZEN_CHANGED_FILES_MAX_BYTES) {
    throw new Error('frozen changed-file list exceeds recovery byte limit');
  }
  atomicWrite(join(directory, 'changed-files.json'), changedFilesBytes, directory);

  const manifest: FrozenReviewInputs = {
    schemaVersion: 2,
    roundId: input.roundId,
    recoveryIdentity: input.recoveryIdentity === undefined ? null : {
      ...input.recoveryIdentity,
      trackedTreeSha: git(input.repoPath, ['rev-parse', `${targetSha}^{tree}`]),
    },
    repoPath: input.repoPath,
    targetRef: input.movementRef ?? input.targetRef,
    baseRef: input.baseRef,
    targetSha,
    baseRefSha,
    diffBaseSha,
    diffSha256: hash(diff),
    specMode: input.noSpec === true ? 'explicit-no-spec' : 'supplied',
    specSha256: hash(specBytes),
    conventionsSha256: hash(projectConventions),
    changedFilesSha256: hash(changedFilesBytes),
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    changedFiles,
    ...(acceptance !== undefined ? { acceptance } : {}),
    ...(frozenEvidence !== null || ciEvidence !== null
      ? {
          reviewEvidence: {
            attachments: frozenEvidence?.receipt ?? [],
            ci: ciEvidence,
          },
        }
      : {}),
    ...(input.branchIdle !== undefined ? { branchIdle: input.branchIdle } : {}),
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestBytes) > FROZEN_MANIFEST_MAX_BYTES) {
    throw new Error('frozen manifest exceeds recovery byte limit');
  }
  atomicWrite(join(directory, 'manifest.json'), manifestBytes, directory);
  return {
    directory,
    manifest,
    diff,
    specContext,
    projectConventions,
    changedFiles,
    evidence: { attachments: frozenEvidence?.attachments ?? [], ci: ciEvidence },
  };
}

export type SourceMovementCause = 'target-moved' | 'base-rewritten' | 'base-unresolvable' | 'checkout-changed' | 'check-failed';
export interface SourceMovement {
  readonly cause: SourceMovementCause;
  readonly detail: string;
}

function movement(cause: SourceMovementCause, detail: string): SourceMovement {
  // Git can echo a credential-bearing remote URL in stderr. Mask it before
  // bounding the detail that is persisted in reports, events and errors.
  const safeDetail = detail.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, '[REDACTED URL]');
  return { cause, detail: safeDetail.replace(/[\r\n]+/gu, ' ').slice(0, 300) };
}

function gitErrorDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text = stderr instanceof Buffer ? stderr.toString('utf8') : typeof stderr === 'string' ? stderr : '';
  return text.trim() || (error instanceof Error ? error.message : String(error));
}

/** Only the local base is read: an advance is valid while the frozen
 * merge-base remains reachable; no remote base tip is consulted or fetched. */
function baseMovementSinceFreeze(review: FrozenReview): SourceMovement | null {
  const { repoPath, baseRef, baseRefSha, diffBaseSha } = review.manifest;
  let live: string;
  try {
    live = resolveGitCommit(repoPath, baseRef);
  } catch (error) {
    return movement('base-unresolvable', `base ${baseRef} cannot resolve: ${gitErrorDetail(error)}`);
  }
  if (live === baseRefSha) return null;
  try {
    gitRaw(repoPath, ['merge-base', '--is-ancestor', diffBaseSha, live]);
    return null;
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 1) {
      return movement('base-rewritten', `base ${baseRef} no longer descends from ${diffBaseSha}`);
    }
    return movement('check-failed', gitErrorDetail(error));
  }
}

/** The configured-remote branch a movement ref names, or null when the ref
 * is not a remote-tracking branch spelling (a SHA, a tag, a revision
 * expression like origin/topic~1, or a local branch whose leading segment
 * is not a configured remote — a local `feature/x` is NOT
 * `remote feature`).
 *
 * gh-169: the advertised-tip comparison applies ONLY to refs that resolve
 * to refs/remotes/<remote>/<branch>. A revision expression (origin/topic~1)
 * is not that branch spelling — probing refs/heads/<branch-with-operators>
 * exits 2 and poisoned every pin round as `check-failed` movement; a tag
 * like origin/v1 resolves to refs/tags/… and never names an advertised
 * branch. Both now correctly skip this check; their pins still bind through
 * the local resolution and pristine-checkout proofs. */
function advertisedRemoteBranch(repoPath: string, ref: string): { remote: string; branch: string } | null {
  let remoteRef: string;
  if (ref.startsWith('refs/remotes/')) {
    // gh-169 P9: a fully-qualified spelling is not automatically a tracking
    // REF — `refs/remotes/origin/topic~1` is a resolvable revision
    // EXPRESSION whose ls-remote probe would false-alarm exactly like the
    // short spelling. Validate the ref format before treating the prefix
    // as proof; a genuine tracking ref keeps its advertised-tip check.
    try {
      gitRaw(repoPath, ['check-ref-format', ref]);
    } catch {
      return null;
    }
    remoteRef = ref.slice('refs/remotes/'.length);
  } else {
    // Fully-qualified non-tracking refs (tags, heads) are exact and never
    // advertised-branch spellings.
    if (ref.startsWith('refs/')) return null;
    // A valid branch spelling only: revision operators (~ ^ : .. @{}) make
    // the ref an EXPRESSION, not the branch itself.
    try {
      gitRaw(repoPath, ['check-ref-format', '--branch', ref]);
    } catch {
      return null;
    }
    // The ref must actually RESOLVE to a remote-tracking ref — a tag whose
    // name carries a slash (origin/v1) resolves to refs/tags/origin/v1 and
    // never names an advertised branch.
    let fullName: string;
    try {
      fullName = git(repoPath, ['rev-parse', '--symbolic-full-name', '--verify', ref]);
    } catch {
      return null;
    }
    if (!fullName.startsWith('refs/remotes/')) return null;
    remoteRef = fullName.slice('refs/remotes/'.length);
  }
  const slash = remoteRef.indexOf('/');
  if (slash <= 0 || slash === remoteRef.length - 1) return null;
  const remote = remoteRef.slice(0, slash);
  const branch = remoteRef.slice(slash + 1);
  return git(repoPath, ['remote']).split('\n').includes(remote) ? { remote, branch } : null;
}

/** Compare the locally resolved base ancestry, movement ref (local and
 * advertised target tip), HEAD and pristine checkout with the frozen target.
 * A base advance is not movement; frozen SHAs stay provenance. Any failed
 * check returns a cause, so the boolean wrapper fails closed on every error. */
/** Movement probe options (gh-169 P5): `remoteProbeTimeoutMs` bounds the
 * advertised-tip ls-remote at REQUEST-TIME admission so a stalled remote
 * cannot block the service event loop for the full 30 s proof budget — a
 * probe that exceeds the bound reports check-failed (fail-closed,
 * retryable) instead of stalling. The submission gate keeps the full
 * budget by omitting the option. */
export interface SourceMovementOptions {
  readonly remoteProbeTimeoutMs?: number;
  /** Skip the advertised-tip probe (the caller supplies a precomputed
   * async result — gh-169 R4-6: request-time admission probes the remote
   * OFF the event loop and injects the outcome). */
  readonly skipRemoteProbe?: boolean;
}

export function sourceMovementSinceFreeze(review: FrozenReview, options?: SourceMovementOptions): SourceMovement | null {
  const { repoPath, targetRef, targetSha } = review.manifest;
  try {
    const base = baseMovementSinceFreeze(review);
    if (base !== null) return base;
    let localTarget: string;
    try {
      localTarget = resolveGitCommit(repoPath, targetRef);
    } catch (error) {
      return movement('target-moved', `target ${targetRef} cannot resolve: ${gitErrorDetail(error)}`);
    }
    if (localTarget !== targetSha) return movement('target-moved', `target ${targetRef} is ${localTarget}, frozen at ${targetSha}`);
    // A push may move the host tip without moving the local tracking ref.
    if (options?.skipRemoteProbe === true) {
      // The caller owns the advertised-tip proof (async path).
    } else {
      const remoteTarget = advertisedRemoteBranch(repoPath, targetRef);
      if (remoteTarget !== null) {
      const advertised = gitRaw(
        repoPath,
        ['ls-remote', '--exit-code', remoteTarget.remote, `refs/heads/${remoteTarget.branch}`],
          options?.remoteProbeTimeoutMs,
        ).trim();
        const tip = advertised.split(/\s+/u)[0] ?? '';
        if (tip !== targetSha) return movement('target-moved', `advertised ${remoteTarget.remote}/${remoteTarget.branch} is ${tip}, frozen at ${targetSha}`);
      }
    }
    if (resolveGitCommit(repoPath, 'HEAD') !== targetSha) {
      return movement('checkout-changed', `review checkout HEAD no longer matches ${targetSha}`);
    }
    try {
      assertReviewCheckoutClean(repoPath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('detached review checkout is not pristine')) {
        return movement('checkout-changed', error.message);
      }
      throw error;
    }
    return null;
  } catch (error) {
    return movement('check-failed', gitErrorDetail(error));
  }
}

/** Async advertised-tip probe (gh-169 R4-6): the SAME fail-closed
 * comparison `sourceMovementSinceFreeze` performs, executed with the
 * non-blocking execFile so a stalled remote never blocks the service
 * event loop at request-time admission. Null = no movement; errors and
 * timeouts return an explicit check-failed movement (fail-closed,
 * retryable), never silence and never a stall. */
export async function probeAdvertisedTipMovementAsync(
  review: FrozenReview,
  timeoutMs: number,
): Promise<SourceMovement | null> {
  const { targetRef, targetSha } = review.manifest;
  const run = async (args: readonly string[]): Promise<string> => {
    const { stdout } = await execFileAsPromised('git', ['-C', review.manifest.repoPath, ...args], {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024,
    });
    return stdout;
  };
  // Round-5 P3: EVERY preparation step is async and bounded — the sync
  // advertisedRemoteBranch helper (30 s execFileSync defaults) is never
  // touched at admission, so no slow config/filesystem/helper step can
  // block the service event loop. Semantics mirror the sync helper: a
  // spelling that is not a valid branch/ref name SKIPS the probe (no
  // movement); only genuine probe errors are fail-closed check-failed.
  const identify = async (): Promise<{ remote: string; branch: string } | null> => {
    if (targetRef.startsWith('refs/') && !targetRef.startsWith('refs/remotes/')) return null;
    if (!targetRef.startsWith('refs/remotes/')) {
      try {
        await run(['check-ref-format', '--branch', targetRef]);
      } catch {
        return null; // not a branch spelling (e.g. origin/topic~1)
      }
      let fullName: string;
      try {
        fullName = (await run(['rev-parse', '--symbolic-full-name', '--verify', targetRef])).trimEnd();
      } catch {
        return null;
      }
      if (!fullName.startsWith('refs/remotes/')) return null;
      const remoteRef = fullName.slice('refs/remotes/'.length);
      const slash = remoteRef.indexOf('/');
      if (slash <= 0 || slash === remoteRef.length - 1) return null;
      const remote = remoteRef.slice(0, slash);
      const remotes = (await run(['remote'])).split('\n');
      return remotes.includes(remote) ? { remote, branch: remoteRef.slice(slash + 1) } : null;
    }
    try {
      await run(['check-ref-format', targetRef]);
    } catch {
      return null; // a qualified revision expression, not a tracking ref
    }
    const remoteRef = targetRef.slice('refs/remotes/'.length);
    const slash = remoteRef.indexOf('/');
    if (slash <= 0 || slash === remoteRef.length - 1) return null;
    const remote = remoteRef.slice(0, slash);
    const remotes = (await run(['remote'])).split('\n');
    return remotes.includes(remote) ? { remote, branch: remoteRef.slice(slash + 1) } : null;
  };
  let remoteTarget: { remote: string; branch: string } | null = null;
  try {
    remoteTarget = await identify();
  } catch (error) {
    return movement('check-failed', gitErrorDetail(error));
  }
  if (remoteTarget === null) return null;
  try {
    const { stdout } = await execFileAsPromised(
      'git',
      ['-C', review.manifest.repoPath, 'ls-remote', '--exit-code', remoteTarget.remote, `refs/heads/${remoteTarget.branch}`],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    const tip = stdout.trim().split(/\s+/u)[0] ?? '';
    if (tip !== targetSha) {
      return movement('target-moved', `advertised ${remoteTarget.remote}/${remoteTarget.branch} is ${tip}, frozen at ${targetSha}`);
    }
    return null;
  } catch (error) {
    return movement('check-failed', gitErrorDetail(error));
  }
}

export function refMovedSinceFreeze(review: FrozenReview): boolean {
  return sourceMovementSinceFreeze(review) !== null;
}

/** Only the terminal retry may compare a previously published report. A
 * no-follow descriptor and byte bound keep this check inside the same safe
 * round directory without relaxing write-once artifact publication. */
export function publishedReportMatches(review: FrozenReview, expected: string): boolean {
  const descriptor = openCheckpoint(review.directory, 'perkins-report.md');
  try {
    const info = fstatSync(descriptor);
    const bytes = Buffer.from(expected, 'utf8');
    if (!info.isFile() || info.size !== bytes.length) return false;
    const actual = Buffer.allocUnsafe(bytes.length);
    let count = 0;
    while (count < actual.length) {
      const read = readSync(descriptor, actual, count, actual.length - count, null);
      if (read === 0) return false;
      count += read;
    }
    return fstatSync(descriptor).size === count && actual.equals(bytes);
  } finally {
    closeSync(descriptor);
  }
}

/** Each open must be anchored in one kernel path walk. Darwin's
 * O_NOFOLLOW_ANY rejects symlinks anywhere in that walk; Linux resolves each
 * component relative to a held no-follow directory descriptor through procfs.
 * An lstat followed by a pathname open is not an ownership proof. */
export function openCheckpoint(directory: string, relativePath: string): number {
  const absolute = resolve(directory, relativePath);
  if (process.platform === 'darwin') {
    // Only the OS-owned /var alias may be normalized; never realpath a
    // caller-controlled ancestor (doing so would conceal a substitution).
    const path = absolute.startsWith('/var/') ? `/private${absolute}` : absolute;
    // Darwin sys/fcntl.h O_NOFOLLOW_ANY; unlike O_NOFOLLOW this applies to
    // the entire kernel pathname walk, including ancestor directories.
    return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
  }
  if (process.platform !== 'linux') throw new Error('no race-safe checkpoint directory traversal on this platform');
  const descriptors: number[] = [];
  try {
    let parent = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(parent);
    const parts = absolute.slice(1).split('/');
    for (const part of parts.slice(0, -1)) {
      parent = openSync(`/proc/self/fd/${parent}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(parent);
    }
    return openSync(`/proc/self/fd/${parent}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } finally {
    for (const fd of descriptors.reverse()) closeSync(fd);
  }
}

/** Read exact original bytes with a bound on the read itself, not merely the
 * pre-read stat: a concurrent append cannot cause an unbounded allocation. */
export function readReviewCheckpointBytes(directory: string, relativePath: string, maxBytes = 256 * 1024): Buffer {
  const components = relativePath.split('/');
  if (components.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > FROZEN_DIFF_MAX_BYTES) {
    throw new Error('invalid review checkpoint path or byte limit');
  }
  const descriptor = openCheckpoint(directory, relativePath);
  try {
    return readBoundedCheckpointDescriptor(descriptor, maxBytes);
  } finally {
    closeSync(descriptor);
  }
}

/** @internal The reader seam makes concurrent growth deterministic in tests;
 * production always uses readSync on the no-follow descriptor. */
export function readBoundedCheckpointDescriptor(
  descriptor: number, maxBytes: number,
  readChunk: (fd: number, bytes: Buffer, offset: number, length: number, position: null) => number = readSync,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > FROZEN_DIFF_MAX_BYTES) {
    throw new Error('invalid review checkpoint byte limit');
  }
  const info = fstatSync(descriptor);
  if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error('review checkpoint is not a bounded regular file');
  const bytes = Buffer.allocUnsafe(maxBytes + 1);
  let count = 0;
  while (count < bytes.length) {
    const read = readChunk(descriptor, bytes, count, bytes.length - count, null);
    if (read === 0) break;
    count += read;
  }
  const after = fstatSync(descriptor);
  if (count !== info.size || after.size !== info.size || after.ino !== info.ino || count > maxBytes) {
    throw new Error('review checkpoint changed during bounded read');
  }
  return bytes.subarray(0, count);
}

export function readReviewCheckpoint(directory: string, relativePath: string, maxBytes = 256 * 1024): string {
  // Preserve a UTF-8 BOM as U+FEFF so callers that re-encode a checkpoint
  // never confuse BOM-prefixed bytes with the original receipted source.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(readReviewCheckpointBytes(directory, relativePath, maxBytes));
}

/** A base-only recovered lens is usable only while the same pinned base
 * still merges cleanly with the frozen target. merge-tree writes Git objects,
 * never the index or checkout; nonzero/conflict/ambiguous output refuses.
 * Re-run at submission so movement after lead spawn cannot authorize READY. */
export function proveRecoveredBaseMergeability(review: FrozenReview, priorBaseTips: readonly string[]): void {
  const { repoPath, baseRef, baseRefSha, targetSha, diffBaseSha } = review.manifest;
  if (priorBaseTips.length === 0 || priorBaseTips.length > 16 ||
    priorBaseTips.some((tip) => !/^[0-9a-f]{40}$/u.test(tip) || tip === baseRefSha)) {
    throw new Error('recovered base mergeability requires bounded distinct prior base tips');
  }
  if (resolveGitCommit(repoPath, baseRef) !== baseRefSha || resolveGitCommit(repoPath, targetSha) !== targetSha) {
    throw new Error('recovered base moved before mergeability proof');
  }
  for (const tip of priorBaseTips) gitRaw(repoPath, ['merge-base', '--is-ancestor', tip, baseRefSha]);
  if (git(repoPath, ['merge-base', baseRefSha, targetSha]) !== diffBaseSha) {
    throw new Error('recovered base changed the frozen merge-base');
  }
  const mergedTree = execFileSync('git', ['-C', repoPath, 'merge-tree', '--write-tree', baseRefSha, targetSha], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(mergedTree) || git(repoPath, ['cat-file', '-t', mergedTree]) !== 'tree') {
    throw new Error('recovered base mergeability proof did not produce one verified tree');
  }
  if (resolveGitCommit(repoPath, baseRef) !== baseRefSha || resolveGitCommit(repoPath, targetSha) !== targetSha) {
    throw new Error('recovered base moved during mergeability proof');
  }
}

function effectiveEvidenceIdentity(evidence: FrozenReviewEvidenceManifest | undefined): unknown {
  if (evidence === undefined) return undefined;
  return {
    ci: evidence.ci,
    // Each manifest keeps its own freeze time. It is provenance of the copy,
    // not a change to the bytes or owner-authorized purpose/consent.
    attachments: evidence.attachments.map(({ frozenAt: _frozenAt, ...effective }) => effective),
  };
}

function authenticateFrozenAttachments(directory: string, evidence: FrozenReviewEvidenceManifest | undefined): boolean {
  if (evidence === undefined) return true;
  if (!Array.isArray(evidence.attachments) || evidence.attachments.length > REVIEW_EVIDENCE_MAX_FILES) return false;
  let total = 0;
  for (const [index, attachment] of evidence.attachments.entries()) {
    if (attachment?.id !== `ev${index + 1}` || attachment.frozenFile !== `evidence/ev${index + 1}.bin` ||
      !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0 || attachment.bytes > REVIEW_EVIDENCE_MAX_FILE_BYTES ||
      typeof attachment.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(attachment.sha256) ||
      attachment.sourceSha256 !== attachment.sha256) return false;
    total += attachment.bytes;
    if (total > REVIEW_EVIDENCE_MAX_TOTAL_BYTES) return false;
    const bytes = readReviewCheckpointBytes(directory, attachment.frozenFile, REVIEW_EVIDENCE_MAX_FILE_BYTES);
    if (bytes.length !== attachment.bytes || hash(bytes) !== attachment.sha256) return false;
  }
  return true;
}

export function compatibleReviewIdentity(
  current: FrozenReview, predecessorDirectory: string, expectedManifestSha256?: string,
): boolean {
  try {
    const manifestBytes = readReviewCheckpointBytes(predecessorDirectory, 'manifest.json', FROZEN_MANIFEST_MAX_BYTES);
    if (expectedManifestSha256 !== undefined && hash(manifestBytes) !== expectedManifestSha256) return false;
    const prior = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as FrozenReviewInputs;
    const identity = current.manifest.recoveryIdentity;
    if (prior.schemaVersion !== 2 || prior.roundId !== basename(predecessorDirectory) ||
      identity === null || prior.recoveryIdentity === null ||
      JSON.stringify(prior.recoveryIdentity) !== JSON.stringify(identity)) return false;
    for (const key of ['targetSha', 'baseRef', 'diffBaseSha', 'diffSha256', 'specMode', 'specSha256', 'conventionsSha256', 'changedFiles', 'acceptance'] as const) {
      if (JSON.stringify(prior[key]) !== JSON.stringify(current.manifest[key])) return false;
    }
    if (JSON.stringify(effectiveEvidenceIdentity(prior.reviewEvidence)) !==
      JSON.stringify(effectiveEvidenceIdentity(current.manifest.reviewEvidence)) ||
      !authenticateFrozenAttachments(predecessorDirectory, prior.reviewEvidence)) return false;
    // A moving symbolic base is provenance, not an effective frozen input.
    // Only a proven fast-forward with the same target merge-base can reuse
    // specialist work; missing/replaced commits and inconclusive git proofs
    // fail closed. Both manifests retain their own observed base tips.
    if (typeof prior.baseRefSha !== 'string' || !/^[0-9a-f]{40}$/u.test(prior.baseRefSha)) return false;
    if (prior.baseRefSha !== current.manifest.baseRefSha) {
      gitRaw(current.manifest.repoPath, ['merge-base', '--is-ancestor', prior.baseRefSha, current.manifest.baseRefSha]);
      if (git(current.manifest.repoPath, ['merge-base', current.manifest.baseRefSha, current.manifest.targetSha]) !== prior.diffBaseSha) return false;
    }
    const files = [
      ['diff.patch', prior.diffSha256, FROZEN_DIFF_MAX_BYTES],
      ['spec-context.md', prior.specSha256, FROZEN_SPEC_MAX_BYTES],
      ['project-conventions.md', prior.conventionsSha256, FROZEN_CONVENTIONS_MAX_BYTES],
    ] as const;
    for (const [name, digest, limit] of files) {
      if (hash(readReviewCheckpointBytes(predecessorDirectory, name, limit)) !== digest) return false;
    }
    if (typeof prior.changedFilesSha256 !== 'string' || prior.changedFilesSha256 !== current.manifest.changedFilesSha256) return false;
    const changed = readReviewCheckpointBytes(predecessorDirectory, 'changed-files.json', FROZEN_CHANGED_FILES_MAX_BYTES);
    if (hash(changed) !== prior.changedFilesSha256 ||
      JSON.stringify(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(changed))) !== JSON.stringify(prior.changedFiles)) return false;
    return true;
  } catch {
    return false;
  }
}

function reviewArtifactPath(review: FrozenReview, relativePath: string): { root: string; path: string } {
  const components = relativePath.split('/');
  if (
    relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0') ||
    components.some((component) => component === '' || component === '.' || component === '..')
  ) throw new Error('review artifact path escapes round directory');
  const root = ensureDirectoryWithoutSymlinks(review.directory);
  const path = resolve(root, ...components);
  if (!contained(root, path) || path === root) throw new Error('review artifact path escapes round directory');
  return { root, path };
}

/** Read a review artifact with the same path-safety rules as writes. A
 * write-once collision is idempotent ONLY when the existing bytes equal
 * what the rejected write would have published; callers use this to tell
 * an idempotent retry apart from a missing-or-stale evidence gap. */
export function readReviewArtifact(review: FrozenReview, relativePath: string): string {
  const { path } = reviewArtifactPath(review, relativePath);
  return readFileSync(path, 'utf8');
}

export function writeReviewArtifact(review: FrozenReview, relativePath: string, value: unknown): string {
  const { root, path } = reviewArtifactPath(review, relativePath);
  const bytes = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  if ((/^attempts\/[a-z]+-[12]\.settled\.json$/u.test(relativePath) ||
    /^specialists\/[a-z]+\.attempt-[12]-[a-f0-9]{8}\.envelope\.json$/u.test(relativePath) ||
    /^children\/[A-Za-z0-9._-]+\.json$/u.test(relativePath)) &&
    Buffer.byteLength(bytes, 'utf8') > SPECIALIST_CHECKPOINT_MAX_BYTES) {
    throw new Error('specialist checkpoint exceeds its recovery byte limit');
  }
  atomicWrite(path, bytes, root);
  return path;
}
