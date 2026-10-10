import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { devNull } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { WorktreeLane } from '../dispatch/worktree-port.js';

/** A missing, unsafe or conflicting explicit GC artifact binding. */
export class ArtifactContextError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ArtifactContextError';
  }
}

/** Identity of the verified, immutable workflow selected by the caller. */
export interface ArtifactWorkflow {
  readonly id: string;
  readonly sha256: string;
}

/** Metadata for exact captured inputs; source content is never executed/copied here. */
export interface ArtifactSource {
  readonly kind: string;
  readonly locator: string;
  readonly revision: string | null;
  readonly sha256: string;
}

export type ArtifactScope = 'operational' | 'document';

/** Stable logical location and provenance; no private payload bytes. */
export interface ArtifactReference {
  readonly schemaVersion: 1;
  readonly projectKey: string;
  readonly jobId: string;
  readonly scope: ArtifactScope;
  /** Relative to operationalDirectory or knowledgeDirectory, according to scope. */
  readonly path: string;
  readonly sha256: string;
  readonly workflow: ArtifactWorkflow;
  readonly sources: readonly ArtifactSource[];
  /** Explicit owner-boundary receipt supplied by the caller, never inferred from source text. */
  readonly approvalId: string | null;
}

export interface OperationalArtifactInput {
  readonly path: string;
  readonly contents: string;
  readonly sources: readonly ArtifactSource[];
}

export interface ApprovedDocumentInput extends OperationalArtifactInput {
  readonly approvalId: string;
}

export interface ArtifactContextInput {
  /** Config.dataDir, explicitly supplied. No HOME or ambient BMAD discovery. */
  readonly dataDir: string;
  /** The job lane obtained from the worktree registry, not a guessed cwd. */
  readonly worktree: WorktreeLane;
  readonly workflow: ArtifactWorkflow;
}

export interface ArtifactContext {
  readonly projectKey: string;
  readonly jobId: string;
  readonly jobDirectory: string;
  readonly operationalDirectory: string;
  readonly knowledgeDirectory: string;
  /** Immutable publication. Identical retries succeed; changed bytes/provenance refuse. */
  readonly writeOperational: (input: OperationalArtifactInput) => ArtifactReference;
  /** Explicit publication of approved bytes only; never copies operational material. */
  readonly publishDocument: (input: ApprovedDocumentInput) => ArtifactReference;
  /** Resolve a saved reference and verify its current bytes and binding. */
  readonly readReference: (scope: ArtifactScope, path: string) => ArtifactReference;
}

function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ArtifactContextError) throw error;
    throw new ArtifactContextError(`GC artifact operation failed: ${String(error)}`, error);
  }
}

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /\p{Cc}/u.test(value)) {
    throw new ArtifactContextError(`${label} must be a non-empty string without control characters`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ArtifactContextError(`${label} must be a lowercase sha256`);
  }
  return value;
}

function absolute(value: string, label: string): string {
  text(value, label);
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new ArtifactContextError(`${label} must be an explicit normalized absolute path: ${JSON.stringify(value)}`);
  }
  return value;
}

function artifactPath(value: unknown): string {
  const path = text(value, 'artifact path');
  if (isAbsolute(path) || /[\\:]/u.test(path) || path.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new ArtifactContextError(`artifact path must be a safe relative path: ${JSON.stringify(path)}`);
  }
  return path;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function maybeStat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** APFS/NTFS may resolve a different case/Unicode spelling to the same inode.
 * realpath alone does not recover the stored spelling on all filesystems. */
function exactEntry(path: string): void {
  if (!readdirSync(dirname(path)).includes(basename(path))) {
    throw new ArtifactContextError(`artifact path uses an aliased filesystem spelling; use the exact directory entry: ${path}`);
  }
}

/** Check every component, including dangling links and pre-existing ancestors.
 * Never chmod a foreign path or silently canonicalize a symlink escape. */
function directory(path: string, create: boolean, privateFrom?: string, exactFrom = privateFrom ?? path): void {
  const root = parse(path).root;
  let cursor = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    let info = maybeStat(cursor);
    if (info === null && create) {
      try {
        mkdirSync(cursor, { mode: privateFrom === undefined ? 0o755 : 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      info = lstatSync(cursor);
    }
    if (info === null) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ArtifactContextError(`artifact directory must be a real directory without symlinks: ${cursor}`);
    }
    // Symlink/kind checks cover every ancestor. Exact spelling checks cover
    // the owned boundary and descendants, not unrelated large system folders.
    if (inside(exactFrom, cursor)) exactEntry(cursor);
    if (privateFrom !== undefined && inside(privateFrom, cursor) && (info.mode & 0o077) !== 0) {
      throw new ArtifactContextError(`artifact directory must be private (0700); fix permissions explicitly: ${cursor}`);
    }
  }
}

/** Only our fully-written atomic publication links may temporarily share an
 * inode. Foreign hardlinks (including links outside this directory) refuse. */
function stagingLinks(path: string, info: Stats): readonly string[] {
  return readdirSync(dirname(path))
    .filter((name) => /^\.gc-artifact-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u.test(name))
    .map((name) => join(dirname(path), name))
    .filter((candidate) => {
      const stat = maybeStat(candidate);
      return stat !== null && stat.isFile() && stat.ino === info.ino && stat.dev === info.dev;
    });
}

function unlinkStaging(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    // An identical concurrent publisher may finish our already-published link.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readRegular(path: string, privateFile: boolean): Buffer | null {
  const info = maybeStat(path);
  if (info === null) return null;
  exactEntry(path);
  const check = (stat: Stats): void => {
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ArtifactContextError(`artifact must be a regular file, not a symlink or hardlink: ${path}`);
    }
    if (stat.nlink !== 1 && stat.nlink !== stagingLinks(path, stat).length + 1) {
      // The winning publisher may have removed its staging name while we listed.
      const current = lstatSync(path);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1) {
        throw new ArtifactContextError(`artifact must not have foreign hardlinks: ${path}`);
      }
    }
    if (privateFile && (stat.mode & 0o077) !== 0) {
      throw new ArtifactContextError(`artifact file must be private (0600); fix permissions explicitly: ${path}`);
    }
  };
  check(info);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    check(opened);
    if (opened.ino !== info.ino || opened.dev !== info.dev) {
      throw new ArtifactContextError(`artifact changed while opening: ${path}`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sameBytes(path: string, bytes: Buffer, privateFile: boolean): boolean {
  const existing = readRegular(path, privateFile);
  if (existing === null) return false;
  if (!existing.equals(bytes)) throw new ArtifactContextError(`artifact contains different bytes or identity: ${path}`);
  return true;
}

/** Exclusive atomic publish. A crash before receipt publication is completed by
 * an identical retry; a different revision needs a different relative path. */
function publish(path: string, bytes: Buffer, privateFrom?: string, exactFrom = privateFrom ?? dirname(path)): void {
  directory(dirname(path), true, privateFrom, exactFrom);
  if (sameBytes(path, bytes, privateFrom !== undefined)) {
    // Finish only same-inode staging links of this exact verified publication,
    // including a crash at link-before-unlink. This is not a directory sweep.
    for (const staging of stagingLinks(path, lstatSync(path))) unlinkStaging(staging);
    return;
  }
  const temporary = join(dirname(path), `.gc-artifact-${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: privateFrom === undefined ? 0o644 : 0o600 });
  let raced = false;
  try {
    directory(dirname(path), false, privateFrom, exactFrom);
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      raced = true;
    }
  } finally {
    unlinkStaging(temporary);
  }
  // Concurrent identical publishers may observe an owned staging hardlink;
  // the payload was fully written before that link became visible.
  if (raced) sameBytes(path, bytes, privateFrom !== undefined);
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
});

/** Refuse private storage in ANY Git checkout, not just this job's project.
 * This reads ancestor metadata only and never discovers authority from it. */
function refuseCheckoutDataHome(path: string): void {
  for (let cursor = path; ; cursor = dirname(cursor)) {
    if (maybeStat(join(cursor, '.git')) !== null) {
      throw new ArtifactContextError(`configured artifact data directory must be outside all Git checkouts: ${path}`);
    }
    if (dirname(cursor) === cursor) return;
  }
}

function refuseIgnoredDocument(worktreePath: string, path: string): void {
  const result = spawnSync('git', ['-C', worktreePath, 'check-ignore', '-q', '--', `gru-output/${path}`], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
  if (result.status === 0) {
    throw new ArtifactContextError(`approved document is Git-ignored; change the ignore rule explicitly before publication: gru-output/${path}`);
  }
  if (result.error !== undefined || result.status !== 1) {
    throw new ArtifactContextError(`cannot verify approved document Git visibility: ${result.error?.message ?? result.stderr}`);
  }
}

/** Local read-only git probes use no inherited repository-routing overrides,
 * global configuration or credentials. No remotes, service or model calls. */
function gitIdentity(path: string): { readonly top: string; readonly gitDir: string; readonly commonDir: string } {
  const output = execFileSync('git', [
    '-C', path, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir',
  ], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
  }).trimEnd().split('\n');
  if (output.length !== 3 || output.some((value) => value === '')) {
    throw new ArtifactContextError(`cannot identify registered git worktree: ${path}`);
  }
  return { top: realpathSync(output[0]!), gitDir: realpathSync(output[1]!), commonDir: realpathSync(output[2]!) };
}

function verifyLane(repoPath: string, worktreePath: string): void {
  directory(repoPath, false);
  directory(worktreePath, false);
  const repo = gitIdentity(repoPath);
  const lane = gitIdentity(worktreePath);
  if (repo.top !== repoPath || lane.top !== worktreePath || lane.gitDir === lane.commonDir ||
      repoPath === worktreePath || repo.commonDir !== lane.commonDir) {
    throw new ArtifactContextError(`artifact documents require the assigned linked job worktree of ${repoPath}: ${worktreePath}`);
  }
}

function workflowIdentity(value: ArtifactWorkflow): ArtifactWorkflow {
  return Object.freeze({ id: text(value.id, 'workflow id'), sha256: sha256(value.sha256, 'workflow sha256') });
}

function sourceIdentities(values: readonly ArtifactSource[]): readonly ArtifactSource[] {
  if (!Array.isArray(values)) throw new ArtifactContextError('artifact sources must be an explicit array of snapshot identities');
  return Object.freeze(values.map((value) => Object.freeze({
    kind: text(value.kind, 'source kind'), locator: text(value.locator, 'source locator'),
    revision: value.revision === null ? null : text(value.revision, 'source revision'),
    sha256: sha256(value.sha256, 'source sha256'),
  })));
}

/** New GC-owned workflow storage contract (#293). This is a caller-driven
 * primitive, not session wiring (#294), intake/approval (#296/#297), a ledger
 * migration or a cleanup policy. Historical bindings and stores are untouched. */
export function createArtifactContext(input: ArtifactContextInput): ArtifactContext {
  return guarded(() => {
    const dataDir = absolute(input.dataDir, 'configured data directory');
    const registeredRepo = absolute(input.worktree.repoPath, 'registered repository path');
    const assignedWorktree = absolute(input.worktree.path, 'assigned worktree path');
    const jobId = input.worktree.id;
    if (input.worktree.kind !== 'job' || input.worktree.jobId !== jobId ||
        (input.worktree.status !== 'active' && input.worktree.status !== 'paused') ||
        !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(jobId)) {
      throw new ArtifactContextError('artifact context requires a live registered job lane with a safe lowercase owning job id');
    }
    const workflow = workflowIdentity(input.workflow);
    verifyLane(registeredRepo, assignedWorktree);
    const repoPath = realpathSync(registeredRepo);
    const worktreePath = realpathSync(assignedWorktree);
    if (inside(repoPath, dataDir) || inside(worktreePath, dataDir)) {
      throw new ArtifactContextError('configured artifact data directory must be outside the registered repository and assigned worktree');
    }
    directory(dataDir, false);
    refuseCheckoutDataHome(dataDir);
    const projectKey = hash(repoPath);
    const projects = join(dataDir, 'projects');
    const jobDirectory = join(projects, projectKey, 'jobs', jobId);
    const operationalDirectory = join(jobDirectory, 'operational');
    const knowledgeDirectory = join(worktreePath, 'gru-output');
    const references = join(jobDirectory, 'references');
    const bindingFile = join(jobDirectory, 'context.json');
    const bindingBytes = Buffer.from(json({
      schemaVersion: 1, projectKey, repoPath, jobId, worktreePath, workflow,
    }));
    const directories = [jobDirectory, operationalDirectory, references];
    const checkBoundaries = (create: boolean): void => {
      for (const path of directories) directory(path, create, projects);
      directory(knowledgeDirectory, create);
    };
    // Refuse all existing wrong-kind paths/identity conflicts before initialization
    // publishes anything. Existing documents are not scanned, copied or rewritten.
    checkBoundaries(false);
    const hasBinding = sameBytes(bindingFile, bindingBytes, true);
    if (!hasBinding && maybeStat(jobDirectory) !== null && readdirSync(jobDirectory).length !== 0) {
      throw new ArtifactContextError(`artifact context binding is missing from an existing namespace; restore it explicitly: ${bindingFile}`);
    }
    directory(jobDirectory, true, projects);
    publish(bindingFile, bindingBytes, projects);
    checkBoundaries(true);

    const checkContext = (): void => {
      verifyLane(repoPath, worktreePath);
      checkBoundaries(false);
      if (!sameBytes(bindingFile, bindingBytes, true)) {
        throw new ArtifactContextError(`artifact context binding is missing; restore it explicitly: ${bindingFile}`);
      }
    };
    const receiptPath = (scope: ArtifactScope, path: string): string => {
      if (scope !== 'operational' && scope !== 'document') throw new ArtifactContextError('unknown artifact scope');
      return join(references, `${hash(`${scope}\0${path}`)}.json`);
    };
    const payloadPath = (scope: ArtifactScope, path: string): string =>
      join(scope === 'operational' ? operationalDirectory : knowledgeDirectory, ...path.split('/'));

    const write = (scope: ArtifactScope, value: OperationalArtifactInput, approvalId: string | null): ArtifactReference => guarded(() => {
      const path = artifactPath(value.path);
      if (typeof value.contents !== 'string') throw new ArtifactContextError('artifact contents must be explicit text bytes');
      const reference: ArtifactReference = Object.freeze({
        schemaVersion: 1, projectKey, jobId, scope, path, sha256: hash(value.contents), workflow,
        sources: sourceIdentities(value.sources), approvalId,
      });
      const bytes = Buffer.from(value.contents);
      const receiptBytes = Buffer.from(json(reference));
      checkContext();
      const payload = payloadPath(scope, path);
      const receipt = receiptPath(scope, path);
      const privateFrom = scope === 'operational' ? projects : undefined;
      directory(dirname(payload), false, privateFrom, scope === 'document' ? knowledgeDirectory : projects);
      const hasPayload = sameBytes(payload, bytes, scope === 'operational');
      const hasReceipt = sameBytes(receipt, receiptBytes, true);
      if (hasPayload && !hasReceipt) {
        throw new ArtifactContextError(`artifact receipt is missing for existing content; restore it explicitly: ${receipt}`);
      }
      if (scope === 'document') refuseIgnoredDocument(worktreePath, path);
      // Bind exact provenance BEFORE payload publication. A crash can leave a
      // receipt without content, never content whose provenance can be guessed.
      publish(receipt, receiptBytes, projects);
      publish(payload, bytes, privateFrom, scope === 'document' ? knowledgeDirectory : projects);
      return reference;
    });

    return Object.freeze({
      projectKey, jobId, jobDirectory, operationalDirectory, knowledgeDirectory,
      writeOperational: (value: OperationalArtifactInput) => write('operational', value, null),
      publishDocument: (value: ApprovedDocumentInput) => guarded(() =>
        write('document', value, text(value.approvalId, 'document approval receipt id'))),
      readReference: (scope: ArtifactScope, value: string): ArtifactReference => guarded(() => {
        const path = artifactPath(value);
        checkContext();
        const receipt = receiptPath(scope, path);
        const bytes = readRegular(receipt, true);
        if (bytes === null) throw new ArtifactContextError(`artifact reference is missing: ${receipt}`);
        const record = JSON.parse(bytes.toString('utf8')) as ArtifactReference;
        const expected: ArtifactReference = Object.freeze({
          schemaVersion: 1, projectKey, jobId, scope, path,
          sha256: sha256(record.sha256, 'artifact reference sha256'), workflow,
          sources: sourceIdentities(record.sources),
          approvalId: scope === 'document' ? text(record.approvalId, 'document approval receipt id') : null,
        });
        if (!bytes.equals(Buffer.from(json(expected)))) {
          throw new ArtifactContextError(`artifact reference has different provenance or binding: ${receipt}`);
        }
        const payload = payloadPath(scope, path);
        directory(dirname(payload), false, scope === 'operational' ? projects : undefined,
          scope === 'document' ? knowledgeDirectory : projects);
        const content = readRegular(payload, scope === 'operational');
        if (content === null || hash(content) !== expected.sha256) {
          throw new ArtifactContextError(`artifact content does not match reference sha256: ${payload}`);
        }
        return expected;
      }),
    });
  });
}
