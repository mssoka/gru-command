import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BranchIdleTag } from '../branch-idle.js';
import type { CiEvidenceRecord } from '../../review-inputs/ci-evidence.js';
import {
  freezeEvidenceAttachments,
  type FrozenEvidenceAttachment,
  type FrozenEvidenceRuntimeAttachment,
  type ReviewEvidenceRequest,
} from '../../review-inputs/evidence.js';

const GIT_MAX_BUFFER = 128 * 1024 * 1024;
export const FROZEN_DIFF_MAX_BYTES = 8 * 1024 * 1024;
export const FROZEN_SPEC_MAX_BYTES = 256 * 1024;
export const FROZEN_CONVENTIONS_MAX_BYTES = 256 * 1024;

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
  readonly schemaVersion: 1;
  readonly roundId: string;
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

export interface FreezeReviewInput {
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

function gitRaw(repoPath: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(repoPath: string, args: readonly string[]): string {
  return gitRaw(repoPath, args).trimEnd();
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

function hash(text: string): string {
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
  atomicWrite(join(directory, 'changed-files.json'), `${JSON.stringify(changedFiles, null, 2)}\n`, directory);

  const manifest: FrozenReviewInputs = {
    schemaVersion: 1,
    roundId: input.roundId,
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
  atomicWrite(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, directory);
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
 * is not a remote-tracking ref (a SHA, a tag, or a local branch whose
 * leading segment is not a configured remote — a local `feature/x` is NOT
 * `remote feature`). */
function advertisedRemoteBranch(repoPath: string, ref: string): { remote: string; branch: string } | null {
  const remoteRef = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref;
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
export function sourceMovementSinceFreeze(review: FrozenReview): SourceMovement | null {
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
    const remoteTarget = advertisedRemoteBranch(repoPath, targetRef);
    if (remoteTarget !== null) {
      const advertised = gitRaw(repoPath, ['ls-remote', '--exit-code', remoteTarget.remote, `refs/heads/${remoteTarget.branch}`]).trim();
      const tip = advertised.split(/\s+/u)[0] ?? '';
      if (tip !== targetSha) return movement('target-moved', `advertised ${remoteTarget.remote}/${remoteTarget.branch} is ${tip}, frozen at ${targetSha}`);
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

export function refMovedSinceFreeze(review: FrozenReview): boolean {
  return sourceMovementSinceFreeze(review) !== null;
}

/** Only the terminal retry may compare a previously published report. A
 * no-follow descriptor and byte bound keep this check inside the same safe
 * round directory without relaxing write-once artifact publication. */
export function publishedReportMatches(review: FrozenReview, expected: string): boolean {
  const root = ensureDirectoryWithoutSymlinks(review.directory);
  // O_NOFOLLOW rejects symlink swaps; O_NONBLOCK keeps the open bounded —
  // a FIFO or device planted at the report path returns immediately and
  // is then rejected by the regular-file check below instead of blocking
  // the terminal retry indefinitely.
  const descriptor = openSync(join(root, 'perkins-report.md'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    const bytes = Buffer.from(expected, 'utf8');
    if (!info.isFile() || info.size !== bytes.length) return false;
    return readFileSync(descriptor).equals(bytes);
  } finally {
    closeSync(descriptor);
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
  atomicWrite(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, root);
  return path;
}
