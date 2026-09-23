import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BranchIdleTag } from '../branch-idle.js';

/** Tool-transport ceiling any frozen chunk may reach (perkins_read_chunk bound). */
export const MAX_TRANSPORT_CHUNK_BYTES = 900 * 1024;

const GIT_MAX_BUFFER = 128 * 1024 * 1024;
export const FROZEN_DIFF_MAX_BYTES = 8 * 1024 * 1024;
export const FROZEN_SPEC_MAX_BYTES = 256 * 1024;
export const FROZEN_CONVENTIONS_MAX_BYTES = 256 * 1024;
export const FROZEN_CHUNK_MAX_BYTES = 128 * 1024;

export interface ReviewChunk {
  readonly id: string;
  readonly files: readonly string[];
  readonly lineCount: number;
  readonly diff: string;
  readonly oversizeSingleFile: boolean;
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
  readonly chunks: readonly Omit<ReviewChunk, 'diff'>[];
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
  /** Policy-pinned chunking threshold (SPEC: the pinned policy is the
   * operative source for review sizing). Defaults to 3000 lines. */
  readonly chunkLineThreshold?: number;
  /** Forced-arm tag (branch-idle override) recorded in the manifest. */
  readonly branchIdle?: BranchIdleTag;
}

export interface FrozenReview {
  readonly directory: string;
  readonly manifest: FrozenReviewInputs;
  readonly diff: string;
  readonly specContext: string;
  readonly projectConventions: string;
  readonly chunks: readonly ReviewChunk[];
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
    if (!existsSync(cursor)) mkdirSync(cursor, { mode: 0o700 });
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

function gitHeaderToken(line: string, start: number): { readonly value: string; readonly next: number } | null {
  let cursor = start;
  while (line[cursor] === ' ') cursor += 1;
  if (cursor >= line.length) return null;
  if (line[cursor] !== '"') {
    const end = line.indexOf(' ', cursor);
    return { value: line.slice(cursor, end === -1 ? line.length : end), next: end === -1 ? line.length : end };
  }
  cursor += 1;
  const bytes: number[] = [];
  while (cursor < line.length) {
    const char = line[cursor]!;
    if (char === '"') return { value: Buffer.from(bytes).toString('utf8'), next: cursor + 1 };
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      cursor += 1;
      continue;
    }
    cursor += 1;
    const escaped = line[cursor];
    if (escaped === undefined) return null;
    const simple: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
    if (simple[escaped] !== undefined) {
      bytes.push(simple[escaped]);
      cursor += 1;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      const octal = line.slice(cursor).match(/^[0-7]{1,3}/)?.[0];
      if (octal === undefined) return null;
      bytes.push(Number.parseInt(octal, 8));
      cursor += octal.length;
      continue;
    }
    bytes.push(...Buffer.from(escaped));
    cursor += 1;
  }
  return null;
}

function changedPath(block: string): string {
  const newline = block.indexOf('\n');
  const first = newline === -1 ? block : block.slice(0, newline);
  if (!first.startsWith('diff --git ')) return 'unknown';
  const remainder = first.slice('diff --git '.length);
  // Quoted form (paths with spaces/special chars): "a/…" "b/…" — decode each.
  if (remainder.startsWith('"')) {
    const source = gitHeaderToken(remainder, 0);
    if (source === null) return 'unknown';
    const destination = gitHeaderToken(remainder, source.next + 1);
    if (destination === null || !destination.value.startsWith('b/')) return 'unknown';
    return destination.value.slice(2);
  }
  // Unquoted form: anchor on the LAST ' b/' so the destination extends to the
  // end of the line even in the presence of unusual bytes.
  const marker = remainder.lastIndexOf(' b/');
  if (marker === -1) return 'unknown';
  const destination = remainder.slice(marker + 3);
  return destination === '' ? 'unknown' : destination;
}

function topLevel(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

function splitFileBlocks(diff: string): readonly { path: string; block: string; lines: number }[] {
  const starts: number[] = [];
  const marker = /^diff --git /gm;
  for (let match = marker.exec(diff); match !== null; match = marker.exec(diff)) starts.push(match.index);
  if (starts.length === 0) return [];
  return starts.map((start, index) => {
    const raw = diff.slice(start, starts[index + 1] ?? diff.length);
    const block = raw.endsWith('\n') ? raw : `${raw}\n`;
    return { path: changedPath(block), block, lines: block.split('\n').length - 1 };
  });
}

/** Deterministic directory grouping with a complete, never-truncated diff.
 * Groups respect the line threshold AND the per-chunk byte bound so an
 * ordinary mid-size diff never produces an over-bound chunk; a single file
 * whose own block exceeds the byte bound is split at hunk boundaries. */
export function chunkUnifiedDiff(
  diff: string,
  threshold = 3000,
  maxBytes = FROZEN_CHUNK_MAX_BYTES,
): readonly ReviewChunk[] {
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error('review chunk threshold must be a positive integer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('review chunk byte bound must be a positive integer');
  const blocks = splitFileBlocks(diff);
  if (blocks.length === 0) return [];
  const totalLines = blocks.reduce((sum, block) => sum + block.lines, 0);
  const totalBytes = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.block, 'utf8'), 0);
  if (totalLines <= threshold && totalBytes <= maxBytes) {
    return [{
      id: '001',
      files: blocks.map((block) => block.path),
      lineCount: totalLines,
      diff: blocks.map((block) => block.block).join(''),
      oversizeSingleFile: false,
    }];
  }
  const groups = new Map<string, typeof blocks[number][]>();
  for (const block of blocks) {
    const key = topLevel(block.path);
    const group = groups.get(key) ?? [];
    group.push(block);
    groups.set(key, group);
  }

  const pieces: { files: string[]; blocks: string[]; lines: number; oversize: boolean }[] = [];
  for (const group of groups.values()) {
    let current: { files: string[]; blocks: string[]; lines: number; oversize: boolean } | null = null;
    const pushCurrent = (): void => {
      if (current !== null) pieces.push(current);
      current = null;
    };
    for (const block of group) {
      const blockBytes = Buffer.byteLength(block.block, 'utf8');
      if (block.lines > threshold || blockBytes > maxBytes) {
        pushCurrent();
        // One file over the bounds: split at hunk boundaries so every piece
        // fits the byte bound (a single hunk larger than the bound stays
        // oversize and is flagged).
        for (const piece of splitBlockByHunks(block, threshold, maxBytes)) pieces.push(piece);
        continue;
      }
      if (
        current === null || current.lines + block.lines > threshold ||
        Buffer.byteLength(current.blocks.join(''), 'utf8') + blockBytes > maxBytes
      ) {
        pushCurrent();
        current = { files: [], blocks: [], lines: 0, oversize: false };
      }
      current.files.push(block.path);
      current.blocks.push(block.block);
      current.lines += block.lines;
    }
    pushCurrent();
  }
  return pieces.map((part, index) => ({
    id: String(index + 1).padStart(3, '0'),
    files: part.files,
    lineCount: part.lines,
    diff: part.blocks.join(''),
    oversizeSingleFile: part.oversize,
  }));
}

function splitBlockByHunks(
  block: { path: string; block: string; lines: number },
  threshold: number,
  maxBytes: number,
): { files: string[]; blocks: string[]; lines: number; oversize: boolean }[] {
  const headerMatch = /^@@/m.exec(block.block);
  const headerEnd = headerMatch === null ? -1 : headerMatch.index;
  if (headerEnd === -1) {
    return [{ files: [block.path], blocks: [block.block], lines: block.lines, oversize: true }];
  }
  const header = block.block.slice(0, headerEnd);
  const body = block.block.slice(headerEnd);
  const hunks: string[] = [];
  const starts: number[] = [];
  const marker = /^@@/gm;
  for (let match = marker.exec(body); match !== null; match = marker.exec(body)) starts.push(match.index);
  for (let i = 0; i < starts.length; i += 1) {
    const piece = body.slice(starts[i]!, starts[i + 1] ?? body.length);
    if (piece !== '') hunks.push(piece);
  }
  const pieces: { files: string[]; blocks: string[]; lines: number; oversize: boolean }[] = [];
  let current: { blocks: string[]; lines: number; bytes: number } | null = null;
  const flush = (): void => {
    if (current !== null) {
      pieces.push({
        files: [block.path],
        blocks: [header + current.blocks.join('')],
        lines: current.lines,
        oversize: false,
      });
    }
    current = null;
  };
  for (const hunk of hunks) {
    const hunkBytes = Buffer.byteLength(hunk, 'utf8');
    const hunkLines = hunk.split('\n').length - 1;
    if (hunkBytes > maxBytes || hunkLines > threshold) {
      flush();
      pieces.push({ files: [block.path], blocks: [header + hunk], lines: hunkLines, oversize: true });
      continue;
    }
    if (current === null || current.bytes + hunkBytes > maxBytes || current.lines + hunkLines > threshold) flush();
    if (current === null) current = { blocks: [], lines: 0, bytes: 0 };
    current.blocks.push(hunk);
    current.lines += hunkLines;
    current.bytes += hunkBytes;
  }
  flush();
  return pieces;
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

export function assertFrozenPromptBounds(review: Pick<FrozenReview, 'diff' | 'specContext' | 'projectConventions' | 'chunks'>): void {
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
  for (const chunk of review.chunks) {
    const chunkBytes = Buffer.byteLength(chunk.diff, 'utf8');
    // Oversize single-hunk chunks are flagged by the splitter: they exceed
    // the per-chunk prompt target but must stay under the tool transport
    // bound or the review would be unreadable end-to-end.
    // Oversize single-hunk chunks are bounded by their JSON-SERIALIZED size
    // (perkins_read_chunk returns JSON.stringify(chunk), whose escaping can
    // inflate bytes ~2x), not the raw byte count.
    if (chunk.oversizeSingleFile) {
      const serialized = Buffer.byteLength(JSON.stringify(chunk.diff), 'utf8');
      if (serialized > MAX_TRANSPORT_CHUNK_BYTES) {
        throw new Error(`frozen chunk ${chunk.id} exceeds ${MAX_TRANSPORT_CHUNK_BYTES} serialized bytes`);
      }
    } else if (chunkBytes > FROZEN_CHUNK_MAX_BYTES) {
      throw new Error(`frozen chunk ${chunk.id} exceeds ${FROZEN_CHUNK_MAX_BYTES} UTF-8 bytes`);
    }
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
  const chunks = chunkUnifiedDiff(diff, input.chunkLineThreshold ?? 3_000);
  if (chunks.length === 0) throw new Error(`frozen review diff is empty for ${diffBaseSha}..${targetSha}`);

  const specContext = input.noSpec === true ? 'EXPLICIT NO-SPEC REVIEW' : input.spec!.trimEnd();
  const specBytes = `${specContext}\n`;
  const projectConventions = readConventions(input.repoPath, targetSha, chunks.flatMap((chunk) => chunk.files));
  assertFrozenPromptBounds({ diff, specContext, projectConventions, chunks });
  const directory = reviewArtifactDirectory(input.artifactRoot, input.roundId);
  ensureDirectoryWithoutSymlinks(directory);
  atomicWrite(join(directory, 'diff.patch'), diff, directory);
  atomicWrite(join(directory, 'spec-context.md'), specBytes, directory);
  atomicWrite(join(directory, 'project-conventions.md'), projectConventions, directory);
  for (const chunk of chunks) atomicWrite(join(directory, 'chunks', `${chunk.id}.patch`), chunk.diff, directory);

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
    chunks: chunks.map(({ diff: _diff, ...chunk }) => chunk),
    ...(input.branchIdle !== undefined ? { branchIdle: input.branchIdle } : {}),
  };
  atomicWrite(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, directory);
  return { directory, manifest, diff, specContext, projectConventions, chunks };
}

export function baseMovedSinceFreeze(review: FrozenReview): boolean {
  try {
    if (resolveGitCommit(review.manifest.repoPath, review.manifest.baseRef) !== review.manifest.baseRefSha) return true;
    // Only a configured remote's branch can drift remotely. A local branch
    // like `feature/x` is NOT remote/branch — treating the first segment as
    // a remote silently skipped the drift check.
    const slash = review.manifest.baseRef.indexOf('/');
    if (slash !== -1 && !review.manifest.baseRef.startsWith('refs/remotes/')) {
      const remote = review.manifest.baseRef.slice(0, slash);
      const branch = review.manifest.baseRef.slice(slash + 1);
      let configured = false;
      try {
        configured = git(review.manifest.repoPath, ['remote']).split('\n').includes(remote);
      } catch {
        configured = false;
      }
      if (configured) {
        const advertised = gitRaw(review.manifest.repoPath, ['ls-remote', '--exit-code', remote, `refs/heads/${branch}`]).trim();
        const remoteSha = advertised.split(/\s+/u)[0] ?? '';
        if (remoteSha !== '') return remoteSha !== review.manifest.baseRefSha;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** The configured-remote branch a movement ref names, or null when the ref
 * is not a remote-tracking ref (a SHA, a tag, or a local branch whose
 * leading segment is not a configured remote — a local `feature/x` is NOT
 * `remote feature`). Mirrors the base-drift rule for target refs. */
function advertisedRemoteBranch(repoPath: string, ref: string): { remote: string; branch: string } | null {
  const remoteRef = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref;
  const slash = remoteRef.indexOf('/');
  if (slash <= 0 || slash === remoteRef.length - 1) return null;
  const remote = remoteRef.slice(0, slash);
  const branch = remoteRef.slice(slash + 1);
  let configured = false;
  try {
    configured = git(repoPath, ['remote']).split('\n').includes(remote);
  } catch {
    return null;
  }
  return configured ? { remote, branch } : null;
}

export function refMovedSinceFreeze(review: FrozenReview): boolean {
  try {
    if (baseMovedSinceFreeze(review)) return true;
    if (git(review.manifest.repoPath, ['rev-parse', '--verify', `${review.manifest.targetRef}^{commit}`]) !== review.manifest.targetSha) {
      return true;
    }
    // A remote-tracking movement ref can move on the host without the local
    // ref moving (a push during the round): verify the live advertised tip,
    // mirroring the base drift check. Fail closed on an unreachable remote.
    const remoteTarget = advertisedRemoteBranch(review.manifest.repoPath, review.manifest.targetRef);
    if (remoteTarget !== null) {
      const advertised = gitRaw(review.manifest.repoPath, ['ls-remote', '--exit-code', remoteTarget.remote, `refs/heads/${remoteTarget.branch}`]).trim();
      if ((advertised.split(/\s+/u)[0] ?? '') !== review.manifest.targetSha) return true;
    }
    if (git(review.manifest.repoPath, ['rev-parse', '--verify', 'HEAD^{commit}']) !== review.manifest.targetSha) {
      return true;
    }
    // The detached review checkout is a frozen input too. Any tracked,
    // staged, untracked, or ignored byte is outside the target commit and
    // invalidates proof.
    assertReviewCheckoutClean(review.manifest.repoPath);
    return false;
  } catch {
    return true;
  }
}

export function writeReviewArtifact(review: FrozenReview, relativePath: string, value: unknown): string {
  const components = relativePath.split('/');
  if (
    relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0') ||
    components.some((component) => component === '' || component === '.' || component === '..')
  ) throw new Error('review artifact path escapes round directory');
  const root = ensureDirectoryWithoutSymlinks(review.directory);
  const path = resolve(root, ...components);
  if (!contained(root, path) || path === root) throw new Error('review artifact path escapes round directory');
  atomicWrite(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, root);
  return path;
}
