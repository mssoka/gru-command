import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { WorktreePort, WorktreeLane } from '../dispatch/worktree-port.js';
import type { LedgerApi, WorktreeRecord } from '../ledger/api.js';

const receiptName = 'gru-creation-handoff.json';
/** The one canonical creation token. Both the handoff receipt and the
 * creation receipt that precedes it must accept exactly this spelling
 * (issue #453): a value one reader refuses may never be adopted by the other. */
export const CREATION_TOKEN = /^gru-creation:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const knownLanes = new Map<string, { readonly lane: WorktreeRecord; readonly ledger: LedgerApi }>();
const managers = new WeakMap<object, LedgerApi>();
const completionKind = 'worktree.handoff-completed';
const factPageSize = 1000;
export function registerHandoffManager(manager: object, ledger: LedgerApi): void {
  managers.set(manager, ledger);
  for (const lane of ledger.listWorktrees()) rememberManagedLane(lane, ledger);
}

/** The default bound on one git metadata file read. */
export const WORKTREE_METADATA_LIMIT = 64 * 1024;

/** Internal descriptor-bound metadata proof shared with creation rollback. */
export function readWorktreeMetadata(file: string, limit = WORKTREE_METADATA_LIMIT): string {
  if (!lstatSync(file).isFile()) throw new Error('handoff metadata is not a regular file');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('handoff metadata exceeds its bound');
    const buffer = Buffer.alloc(limit + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size !== stat.size || fstatSync(fd).size !== stat.size) throw new Error('handoff metadata changed while reading');
    if (size > limit) throw new Error('handoff metadata exceeds its bound');
    return buffer.subarray(0, size).toString('utf8');
  } finally { closeSync(fd); }
}

export class WorktreeHandoffUnresolvedError extends Error {
  constructor(path: string, cause?: unknown) {
    super(`worktree handoff unresolved for ${path} — retain the registered lane and inspect its original custody before retry`, { cause });
    this.name = 'WorktreeHandoffUnresolvedError';
  }
}

/** A lane's creation handoff receipt, as its administration holds it and
 * the ledger's completion (and any rebinding) records it. */
export interface Receipt {
  readonly state: 'pending' | 'ready';
  readonly token: string;
  readonly id: string;
  readonly kind: WorktreeLane['kind'];
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly repo: string;
  readonly common: string;
  readonly admin: string;
  readonly path: string;
  readonly branch: string | null;
  readonly sha: string;
  readonly createdAt: string | null;
}

const receiptFields = new Set(['state', 'token', 'id', 'kind', 'jobId', 'roundId', 'repo', 'common', 'admin', 'path', 'branch', 'sha', 'createdAt']);

function isReceipt(value: unknown): value is Receipt {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === receiptFields.size && Object.keys(value).every((key) => receiptFields.has(key)) &&
    'state' in value && (value.state === 'pending' || value.state === 'ready') &&
    'token' in value && typeof value.token === 'string' && CREATION_TOKEN.test(value.token) &&
    'id' in value && typeof value.id === 'string' && value.id !== '' &&
    'kind' in value && (value.kind === 'job' || value.kind === 'review' || value.kind === 'child') &&
    'jobId' in value && (value.jobId === null || typeof value.jobId === 'string' && value.jobId !== '') &&
    'roundId' in value && (value.roundId === null || typeof value.roundId === 'string' && value.roundId !== '') &&
    'repo' in value && typeof value.repo === 'string' && value.repo !== '' &&
    'common' in value && typeof value.common === 'string' && value.common !== '' &&
    'admin' in value && typeof value.admin === 'string' && value.admin !== '' &&
    'path' in value && typeof value.path === 'string' && value.path !== '' &&
    'branch' in value && (value.branch === null || typeof value.branch === 'string' && value.branch !== '') &&
    'sha' in value && typeof value.sha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.sha) &&
    'createdAt' in value && (value.state === 'pending' ? value.createdAt === null : typeof value.createdAt === 'string' && value.createdAt !== '');
}

function parseReceipt(text: string): Receipt {
  const value: unknown = JSON.parse(text);
  // This private issuer writes canonical JSON. Round-trip equality also refuses
  // duplicate keys rather than letting JSON.parse's last value grant a phase.
  if (!isReceipt(value) || JSON.stringify(value) !== text) throw new Error('invalid handoff receipt identity or phase fields');
  return value;
}

export function rememberManagedLane(lane: WorktreeRecord, ledger: LedgerApi): WorktreeRecord {
  const association = { lane, ledger };
  knownLanes.set(lane.path, association);
  if (existsSync(lane.path)) knownLanes.set(realpathSync(lane.path), association);
  return lane;
}

function* completionFacts(ledger: LedgerApi) {
  const count = ledger.countEvents(completionKind);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('handoff fact inventory is incomplete');
  let cursor = 0, observed = 0;
  for (;;) {
    const page = ledger.listEventsAfter(cursor, { kinds: [completionKind], limit: factPageSize });
    if (page.length > factPageSize) throw new Error('handoff fact page exceeds its bound');
    if (page.length === 0) break;
    for (const event of page) {
      if (event.kind !== completionKind || !Number.isSafeInteger(event.seq) || event.seq <= cursor || ++observed > count) throw new Error('handoff fact inventory changed or is incomplete');
      if (!isReceipt(event.payload) || event.payload.state !== 'ready' || Buffer.byteLength(JSON.stringify(event.payload)) > 64 * 1024) throw new Error('malformed or oversized service handoff fact');
      cursor = event.seq;
      yield { ...event, payload: event.payload };
    }
  }
  if (observed !== count || ledger.countEvents(completionKind) !== count) throw new Error('handoff fact inventory changed or is incomplete');
}

function assertIssued(receipt: Receipt, lane: WorktreeRecord, ledger: LedgerApi): void {
  const facts = [];
  for (const event of completionFacts(ledger)) {
    if (event.payload.id === lane.id || event.payload.token === receipt.token) {
      facts.push(event);
      if (facts.length > 1) throw new Error('conflicting service handoff issuance');
    }
  }
  if (facts.length !== 1) throw new Error('original unique service handoff issuance is unavailable');
  const fact = facts[0]!;
  if (fact.jobId !== lane.jobId || fact.roundId !== lane.roundId || JSON.stringify(issuedBinding(fact.payload, lane.id, ledger).binding) !== JSON.stringify(receipt) ||
    JSON.stringify(ledger.getEvent(fact.seq)) !== JSON.stringify(fact)) throw new Error('service handoff issuance conflicts with original binding');
}

/** A lane's handoff re-bound to its repository's new place (#427 PR 2b):
 * `{ id, from, to, move_seq }`, two ready receipts that differ only in
 * `repo`, `common` and `admin`. Recorded only by LedgerApi.moveWorktreeRepo,
 * as the event right after the lane's {@link REPO_MOVED_KIND} (`move_seq`),
 * in the same transaction; never on its own. */
export const HANDOFF_REBOUND_KIND = 'worktree.handoff-rebound';

/** A lane's registry `repo_path` moved (#427 PR 2b): `{ id, from, to }`. */
export const REPO_MOVED_KIND = 'worktree.repo-moved';

/** The receipt fields a move changes: where the repository, its common
 * directory and the lane's administration live. */
const REBOUND_FIELDS: ReadonlySet<string> = new Set(['repo', 'common', 'admin']);

/** A lane's issued handoff: the binding it holds now, the binding the
 * newest rebinding replaced (null when there is none), and every binding
 * of its chain in order (the original completion first, `binding` last). */
interface IssuedBinding {
  readonly binding: Receipt;
  readonly previous: Receipt | null;
  readonly chain: readonly Receipt[];
}

/** The binding a lane's handoff holds now: its one original completion,
 * with each rebinding applied in order. Each rebinding must start from the
 * binding before it, change nothing but the repository's paths, and be
 * paired with the lane's move: the event right before it, in its
 * transaction, is the {@link REPO_MOVED_KIND} of the same lane its
 * `move_seq` names. An inconsistent chain is refused by name. */
function issuedBinding(original: Receipt, laneId: string, ledger: LedgerApi): IssuedBinding {
  let binding = original;
  let previous: Receipt | null = null;
  const chain: Receipt[] = [original];
  let cursor = 0;
  for (;;) {
    const page = ledger.listEventsAfter(cursor, { kinds: [HANDOFF_REBOUND_KIND], payload: { key: 'id', equals: laneId }, limit: factPageSize });
    if (page.length === 0) return { binding, previous, chain };
    for (const event of page) {
      if (event.kind !== HANDOFF_REBOUND_KIND || event.seq <= cursor) throw new Error('handoff rebinding inventory changed or is incomplete');
      cursor = event.seq;
      const { from, to, move_seq: moveSeq } = (event.payload ?? {}) as { readonly from?: unknown; readonly to?: unknown; readonly move_seq?: unknown };
      if (!isReceipt(from) || !isReceipt(to) || to.state !== 'ready' || JSON.stringify(from) !== JSON.stringify(binding) ||
        Object.keys(from).some((key) => !REBOUND_FIELDS.has(key) && JSON.stringify(from[key as keyof Receipt]) !== JSON.stringify(to[key as keyof Receipt]))) {
        throw new Error('handoff rebinding conflicts with the issued binding');
      }
      const move = moveSeq === event.seq - 1 ? ledger.getEvent(moveSeq) : null;
      if (move?.kind !== REPO_MOVED_KIND || (move.payload as { readonly id?: unknown } | null)?.id !== laneId ||
        move.jobId !== event.jobId || move.roundId !== event.roundId) {
        throw new Error('handoff rebinding is not paired with a move of the lane\'s repository');
      }
      previous = binding;
      binding = to;
      chain.push(to);
    }
  }
}

/** Every lane's completion facts by lane id, read once on first use (#427
 * PR 2b): a moved-repository check passes one to each lane it settles or
 * re-binds, so it reads the facts once, never once per lane. */
export type LaneCompletions = () => ReadonlyMap<string, readonly Receipt[]>;

/** A {@link LaneCompletions} over the ledger's completion facts as they are
 * when it is first called. */
export function laneCompletionsOnce(ledger: LedgerApi): LaneCompletions {
  let byLane: ReadonlyMap<string, readonly Receipt[]> | null = null;
  return () => {
    if (byLane === null) {
      const read = new Map<string, readonly Receipt[]>();
      for (const { payload } of completionFacts(ledger)) read.set(payload.id, [...(read.get(payload.id) ?? []), payload]);
      byLane = read;
    }
    return byLane;
  };
}

/** The issued binding of a lane, or null when no completion names it (a
 * lane made before handoffs were recorded). */
function laneBinding(laneId: string, ledger: LedgerApi, completions: LaneCompletions): IssuedBinding | null {
  const facts = completions().get(laneId) ?? [];
  if (facts.length > 1) throw new Error('conflicting service handoff issuance');
  return facts.length === 0 ? null : issuedBinding(facts[0]!, laneId, ledger);
}

/** A rebinding of a moved lane's handoff, ready to record and publish. */
export interface LaneRebind {
  readonly id: string;
  readonly from: Receipt;
  readonly to: Receipt;
  /** The lane's administration, where the receipt is published. */
  readonly admin: string;
}

/**
 * The rebinding of a lane whose repository moved (#427 PR 2b), once
 * `git worktree repair` pointed its `.git` file at `repoPath`'s
 * administration of it: the binding the ledger issued, and the same binding
 * at the new place. Null for a lane with no issued handoff, or one already
 * bound there. Refused by name when the lane's administration is not
 * `repoPath`'s, or when the receipt on disk is not GC's to rewrite: neither
 * the new binding nor any binding of the lane's own issued chain. An
 * earlier binding than the issued one is a rebinding recorded and never
 * published, then a second move (A→B recorded, its receipt not written,
 * then B→C): the newest binding is recorded and published over it. The
 * lane's completion is looked up in the check's `completions`.
 */
export function prepareLaneRebind(lane: WorktreeRecord, repoPath: string, ledger: LedgerApi, completions: LaneCompletions): LaneRebind | null {
  const issued = laneBinding(lane.id, ledger, completions);
  if (issued === null) return null;
  const admin = adminFor(lane.path);
  const common = laneCommonDirectory(admin);
  if (repositoryCommonDirectory(repoPath) !== common || dirname(admin) !== join(common, 'worktrees') ||
    adminBackPointer(admin) !== resolvedPath("checkout's git file", join(lane.path, '.git'))) {
    throw new Error(`lane ${lane.path} is not administered by ${repoPath}: its handoff cannot be re-bound there`);
  }
  const from = issued.binding;
  const to: Receipt = { ...from, repo: resolvedPath('repository', repoPath), common, admin };
  if (JSON.stringify(to) === JSON.stringify(from)) return null;
  const disk = JSON.stringify(parseReceipt(readWorktreeMetadata(join(admin, receiptName))));
  if (disk !== JSON.stringify(to) && !issued.chain.some((binding) => JSON.stringify(binding) === disk)) {
    throw new Error(`lane administration ${admin} holds a handoff receipt GC did not issue: it is not re-bound`);
  }
  return { id: lane.id, from, to, admin };
}

/** Whether a lane whose git link works holds a handoff receipt naming other
 * repository paths than the ones the link reaches as the filesystem
 * resolves them (#427 PR 2b): the repository moved with a link left at its
 * old place, or its own git directory moved. Read from the files, before
 * any ledger fact; a lane with no readable receipt is not stale here
 * (custody speaks for it). */
export function laneReceiptStale(lane: WorktreeRecord): boolean {
  try {
    const admin = adminFor(lane.path);
    const receipt = parseReceipt(readWorktreeMetadata(join(admin, receiptName)));
    return receipt.admin !== admin || receipt.common !== laneCommonDirectory(admin) || receipt.repo !== resolvedPath('repository', lane.repoPath);
  } catch {
    return false;
  }
}

/** Publish a recorded rebinding's receipt in the lane's administration:
 * written whole beside it, then renamed over it. */
export function publishLaneRebind(rebind: Pick<LaneRebind, 'to' | 'admin'>): void {
  const file = join(rebind.admin, receiptName);
  const temp = `${file}.rebound-${process.pid}-${Date.now()}`;
  try {
    const fd = openSync(temp, 'wx');
    try {
      writeFileSync(fd, JSON.stringify(rebind.to));
      durably(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* never written, or already renamed */ }
    throw new Error(`lane administration ${rebind.admin} cannot take its re-bound handoff receipt (${errnoOf(error)})`, { cause: error });
  }
}

/** Finish a rebinding the ledger recorded and the disk did not get (a stop
 * between the two, perhaps more than once): when the lane's receipt is an
 * earlier binding of its own issued chain, publish the newest one. True
 * when it published. The lane's completion is looked up in the check's
 * `completions`. */
export function settleLaneRebind(lane: WorktreeRecord, ledger: LedgerApi, completions: LaneCompletions): boolean {
  // Most lanes were never re-bound: one indexed look before any fact is read.
  if (ledger.listEventsAfter(0, { kinds: [HANDOFF_REBOUND_KIND], payload: { key: 'id', equals: lane.id }, limit: 1 }).length === 0) return false;
  const issued = laneBinding(lane.id, ledger, completions);
  if (issued === null || issued.previous === null) return false;
  const admin = adminFor(lane.path);
  const disk = JSON.stringify(parseReceipt(readWorktreeMetadata(join(admin, receiptName))));
  if (disk === JSON.stringify(issued.binding) || !issued.chain.some((binding) => JSON.stringify(binding) === disk) || issued.binding.admin !== admin) return false;
  publishLaneRebind({ to: issued.binding, admin });
  return true;
}

const GITDIR_PREFIX = 'gitdir: ';
const errnoOf = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.message : String(error));

/** The gitdir a checkout's `.git` FILE names, resolved against the checkout
 * but not yet followed — so a dangling target can still be refused by name.
 * Like git's read_gitfile: trailing line ends (any number) are stripped and
 * nothing else, so trailing spaces stay part of the path and an empty path
 * is refused. A line end left inside is a second line, which no gitdir file
 * git writes has — refused by name. */
function linkedGitdir(path: string): string {
  const file = join(path, '.git');
  let isFile: boolean;
  try {
    isFile = lstatSync(file).isFile();
  } catch (error) {
    throw new Error(`checkout ${path} no longer has its linked gitdir file (${errnoOf(error)})`, { cause: error });
  }
  if (!isFile) throw new Error(`checkout ${path} no longer has its linked gitdir file (.git is not a regular file)`);
  let text: string;
  try {
    text = readWorktreeMetadata(file).replace(/[\r\n]+$/u, '');
  } catch (error) {
    throw new Error(`checkout ${path} has an unreadable .git file (${errnoOf(error)})`, { cause: error });
  }
  if (!text.startsWith(GITDIR_PREFIX)) throw new Error(`checkout ${path} lost its linked gitdir: its .git file has no "${GITDIR_PREFIX}" line`);
  if (/[\r\n]/u.test(text)) throw new Error(`checkout ${path} has a .git file of more than one line — not a gitdir file git writes`);
  const named = text.slice(GITDIR_PREFIX.length);
  if (named === '') throw new Error(`checkout ${path} has a .git file naming an empty gitdir`);
  return resolve(path, named);
}

/** A managed checkout's administration directory, followed — or refused by
 * name when the gitdir its `.git` file names cannot be resolved, or is not a
 * directory. */
function adminFor(path: string): string {
  const gitdir = linkedGitdir(path);
  let admin: string;
  try {
    admin = realpathSync(gitdir);
  } catch (error) {
    throw new Error(`checkout ${path} names gitdir ${gitdir}, which cannot be resolved (${errnoOf(error)})`, { cause: error });
  }
  let isDirectory: boolean;
  try {
    isDirectory = statSync(admin).isDirectory();
  } catch (error) {
    throw new Error(`checkout ${path} names gitdir ${gitdir}, which cannot be inspected (${errnoOf(error)})`, { cause: error });
  }
  if (!isDirectory) throw new Error(`checkout ${path} names gitdir ${gitdir}, which is not a directory`);
  return admin;
}

type EntryKind = 'file' | 'directory' | 'other' | 'absent' | { readonly unreadable: string };
/** What `path` is, followed as git follows it — never a raw error. */
function entryKind(path: string): EntryKind {
  try {
    const stat = statSync(path);
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    return errnoOf(error) === 'ENOENT' ? 'absent' : { unreadable: errnoOf(error) };
  }
}

/** Whether anything at all — a dangling link included — is at `path`
 * (lstat, never following), or a refusal naming why that cannot be told.
 * Only true absence is absence: a file standing where a directory of the
 * path should be (ENOTDIR) is corruption, refused by name. */
function present(path: string, what: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT') return false;
    throw new Error(`${what} ${path} cannot be inspected (${code})`, { cause: error });
  }
}

/** fsync, where the filesystem can: one that cannot (EINVAL, ENOTSUP) is no
 * reason to refuse a handoff; any other failure is raised. */
function durably(fd: number): void {
  try { fsyncSync(fd); } catch (error) {
    if (errnoOf(error) !== 'EINVAL' && errnoOf(error) !== 'ENOTSUP') throw error;
  }
}

/** Why `dir` is not a full git directory (HEAD file, objects and refs
 * directories, each followed as git follows them), or null when it is. */
function gitDirectoryProblem(dir: string): string | null {
  const head = entryKind(join(dir, 'HEAD'));
  if (head === 'absent') return 'it has no HEAD file';
  if (typeof head === 'object') return `its HEAD cannot be inspected (${head.unreadable})`;
  if (head !== 'file') return 'its HEAD is not a regular file';
  for (const name of ['objects', 'refs']) {
    const found = entryKind(join(dir, name));
    if (typeof found === 'object') return `its ${name} cannot be inspected (${found.unreadable})`;
    if (found !== 'directory') return found === 'absent' ? `it has no ${name} directory` : `its ${name} is not a directory`;
  }
  return null;
}

/** The common git directory a `.git` FILE's gitdir resolves to (#372): a
 * linked worktree's administration names it in `commondir`; a
 * `--separate-git-dir` checkout's gitdir IS the full git directory (no
 * `commondir`). Either way the directory reached must be a full git
 * directory, and a `commondir` never chains to another administration.
 * Anything else — missing, dangling, looping, unreadable, an empty, unreadable
 * or foreign `commondir` — fails loud by name, with the path as given and,
 * when they differ, the path it resolved to. */
export function commonDirectoryOfGitdir(gitdir: string): string {
  let resolved: string | null = null;
  const refuse = (problem: string): never => {
    const where = resolved !== null && resolved !== gitdir ? `${gitdir} (resolved to ${resolved})` : gitdir;
    throw new Error(`repository gitdir ${where} is neither a linked worktree administration nor a git directory: ${problem}`);
  };
  try {
    resolved = realpathSync(gitdir);
  } catch (error) {
    return refuse(errnoOf(error) === 'ENOENT' ? 'it does not exist' : `it cannot be resolved (${errnoOf(error)})`);
  }
  const self = entryKind(resolved);
  if (typeof self === 'object') return refuse(`it cannot be inspected (${self.unreadable})`);
  if (self !== 'directory') return refuse('it is not a directory');
  const commondir = join(resolved, 'commondir');
  const pointer = entryKind(commondir);
  if (pointer === 'absent') {
    const problem = gitDirectoryProblem(resolved);
    return problem === null ? resolved : refuse(problem);
  }
  let target: string;
  try {
    target = readWorktreeMetadata(commondir).trim();
  } catch (error) {
    return refuse(`its commondir cannot be read (${errnoOf(error)})`);
  }
  if (target === '') return refuse('its commondir is empty');
  let common: string;
  try {
    common = realpathSync(resolve(resolved, target));
  } catch (error) {
    return refuse(`its commondir names ${target}, which cannot be resolved (${errnoOf(error)})`);
  }
  const kind = entryKind(common);
  const chain = kind === 'directory' ? entryKind(join(common, 'commondir')) : 'absent';
  const problem = typeof kind === 'object' ? `it cannot be inspected (${kind.unreadable})`
    : kind !== 'directory' ? 'it is not a directory'
    : typeof chain === 'object' ? `its commondir cannot be inspected (${chain.unreadable})`
    : chain !== 'absent' ? 'it is itself a linked administration'
    : gitDirectoryProblem(common);
  return problem === null ? common : refuse(`its commondir names ${common}, which is not a git directory: ${problem}`);
}

/** The repository's common git directory: its `.git` directory (a symlinked
 * one followed), or what its `.git` file's gitdir resolves to (linked
 * worktree or separate git dir). The ONE layout reading behind the handoff
 * proof, the absence proof and creation custody. A missing `.git`, a `.git`
 * directory that is no full git directory, or a `.git` symlink to a gitdir
 * FILE (whose relative gitdir git and this reading could resolve
 * differently), is refused by name. */
export function repositoryCommonDirectory(repoPath: string): string {
  const repoGit = join(repoPath, '.git');
  let link: boolean;
  let canonical: string;
  try {
    link = lstatSync(repoGit).isSymbolicLink();
    canonical = realpathSync(repoGit);
  } catch (error) {
    throw new Error(`repository ${repoPath} has no usable .git (${errnoOf(error)})`, { cause: error });
  }
  const kind = entryKind(canonical);
  if (typeof kind === 'object') throw new Error(`repository ${repoPath} has a .git that cannot be inspected (${kind.unreadable})`);
  if (kind === 'directory') {
    const problem = gitDirectoryProblem(canonical);
    if (problem !== null) throw new Error(`repository ${repoPath} has a .git directory that is not a git directory: ${problem}`);
    return canonical;
  }
  if (link) throw new Error(`repository ${repoPath} has a .git symlink to a gitdir file (${canonical}) — an unsupported layout`);
  return commonDirectoryOfGitdir(linkedGitdir(repoPath));
}

/** `path` followed, or refused by name — never a raw error. */
function resolvedPath(what: string, path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new Error(`${what} ${path} cannot be resolved (${errnoOf(error)})`, { cause: error });
  }
}

/** A managed lane's administration is always a linked worktree
 * administration: it names its common directory in `commondir`. A full git
 * directory (a `.git` file pointed at the repository's own git directory) is
 * refused by name, never taken for its own common directory. */
function laneCommonDirectory(admin: string): string {
  const pointer = entryKind(join(admin, 'commondir'));
  if (pointer === 'absent') throw new Error(`lane administration ${admin} has no commondir — it is not a linked worktree administration`);
  if (typeof pointer === 'object') throw new Error(`lane administration ${admin} has a commondir that cannot be inspected (${pointer.unreadable})`);
  return commonDirectoryOfGitdir(admin);
}

/** The checkout `.git` file a lane administration's `gitdir` file points
 * back to, followed — or refused by name. */
function adminBackPointer(admin: string): string {
  // Git trims only the END of this file (strbuf_rtrim); an empty one names
  // nothing.
  const named = adminFile(admin, 'gitdir').trimEnd();
  if (named === '') throw new Error(`lane administration ${admin} has an empty gitdir file`);
  if (named.includes('\0')) throw new Error(`lane administration ${admin} has a gitdir file holding a NUL byte — not one git writes`);
  if (/[\r\n]/u.test(named)) throw new Error(`lane administration ${admin} has a gitdir file of more than one line — not one git writes`);
  return resolvedPath(`lane administration ${admin}'s checkout git file`, resolve(admin, named));
}

/** A git metadata file's text, or a refusal naming it. */
function namedMetadata(file: string, what: string, limit?: number): string {
  try {
    return readWorktreeMetadata(file, limit);
  } catch (error) {
    throw new Error(`${what} ${file} is unreadable (${errnoOf(error)})`, { cause: error });
  }
}

/** A lane administration's metadata file, or a refusal naming it. */
function adminFile(admin: string, name: string): string {
  try {
    return readWorktreeMetadata(join(admin, name));
  } catch (error) {
    throw new Error(`lane administration ${admin} has an unreadable ${name} file (${errnoOf(error)})`, { cause: error });
  }
}

function validate(receipt: Receipt, lane: WorktreeLane): void {
  const admin = adminFor(lane.path);
  const common = laneCommonDirectory(admin);
  const repoCommon = repositoryCommonDirectory(lane.repoPath);
  if (repoCommon !== common || receipt.id !== lane.id || receipt.kind !== lane.kind || receipt.jobId !== lane.jobId || receipt.roundId !== lane.roundId || receipt.branch !== lane.branch || receipt.sha !== lane.sha ||
    receipt.repo !== resolvedPath('repository', lane.repoPath) || receipt.path !== resolvedPath('checkout', lane.path) || receipt.admin !== admin || receipt.common !== common ||
    dirname(admin) !== join(common, 'worktrees') ||
    adminBackPointer(admin) !== resolvedPath("checkout's git file", join(lane.path, '.git'))) throw new Error('handoff binding changed');
  // Job/writer commits may advance. Attachment must not: a detached lane is
  // frozen, and a writer's reserved name must still be a direct branch.
  if (existsSync(join(common, 'reftable'))) throw new Error('unsupported ref storage — handoff identity unverified');
  const head = adminFile(admin, 'HEAD').trim();
  if (lane.branch === null) {
    if (head !== lane.sha) throw new Error('detached handoff identity changed');
  } else {
    if (head !== `ref: refs/heads/${lane.branch}`) throw new Error('writer handoff attachment changed');
    const ref = join(common, 'refs', 'heads', lane.branch);
    // Present as anything at all (a dangling link included) is a loose ref,
    // judged as one; only true absence — under real directories — falls back
    // to packed refs.
    for (let dir = dirname(ref); dir.startsWith(join(common, 'refs')) && dir !== common; dir = dirname(dir)) {
      let link = false;
      try { link = lstatSync(dir).isSymbolicLink(); } catch (error) { if (errnoOf(error) !== 'ENOENT') throw new Error(`writer branch ref directory ${dir} cannot be inspected (${errnoOf(error)})`, { cause: error }); }
      if (link) throw new Error(`writer branch is not direct: its ref ${ref} lies under a linked directory ${dir}`);
    }
    if (present(ref, 'writer branch ref')) {
      // Direct first — a ref reached through a link is never read.
      if (resolvedPath('writer branch ref', ref) !== ref) throw new Error(`writer branch is not direct: its ref ${ref} is reached through a link`);
      const text = namedMetadata(ref, 'writer branch ref').trim();
      if (!/^[0-9a-f]{40,64}$/u.test(text) || text.length !== lane.sha.length) throw new Error(`writer branch is not direct: its ref ${ref} does not hold a commit id of the lane's length`);
    } else {
      const packedFile = join(common, 'packed-refs');
      if (!present(packedFile, 'packed refs')) throw new Error(`writer branch ${lane.branch} has neither a loose ref nor a packed-refs file`);
      const packed = namedMetadata(packedFile, 'packed refs', 16 * 1024 * 1024);
      if (packed.split('\n').some((line) => line.startsWith('^') && !/^\^[0-9a-f]{40,64}$/u.test(line))) throw new Error('malformed peeled ref metadata');
      const lines = packed.split('\n').filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('^'));
      if (lines.some((line) => !/^[0-9a-f]{40,64} refs\//u.test(line))) throw new Error('malformed packed ref metadata');
      if (lines.filter((line) => /^[0-9a-f]{40,64}$/u.test(line.split(' ')[0] ?? '') && line.split(' ')[0]?.length === lane.sha.length && line.split(' ')[1] === `refs/heads/${lane.branch}`).length !== 1) {
        throw new Error('writer branch identity is missing');
      }
    }
  }
}

export function beginLaneHandoff(lane: Pick<WorktreeLane, 'id' | 'kind' | 'repoPath' | 'path' | 'branch' | 'sha' | 'jobId' | 'roundId'>, admin: string, token: string): void {
  const receipt: Receipt = { state: 'pending', token, id: lane.id, kind: lane.kind, jobId: lane.jobId, roundId: lane.roundId, repo: resolvedPath('repository', lane.repoPath),
    common: laneCommonDirectory(admin), admin,
    path: resolvedPath('checkout', lane.path), branch: lane.branch, sha: lane.sha, createdAt: null };
  const file = join(admin, receiptName), temp = `${file}.${token.slice(13)}`;
  // Never a stray temporary receipt: whatever this call created — even a
  // write that failed partway — is removed, and one that cannot be is named
  // with its own reason. Only a temporary name that already existed (the
  // `wx` open refused it) is not this call's to remove.
  const removeTemp = (failure: unknown): void => {
    try { unlinkSync(temp); } catch (cleanupError) {
      if (errnoOf(cleanupError) === 'ENOENT') return;
      throw new Error(`lane administration ${admin} ${failure === null ? 'published its handoff receipt' : `cannot take a handoff receipt (${errnoOf(failure)})`} and its temporary receipt could not be removed (${errnoOf(cleanupError)})`,
        { cause: failure === null ? cleanupError : new AggregateError([failure, cleanupError], 'handoff receipt and its cleanup failed') });
    }
  };
  // Ours exactly when the exclusive open succeeded: nothing else is ever removed.
  let ours = false;
  try {
    const fd = openSync(temp, 'wx');
    ours = true;
    // Durable before it is published; a write error stays the one reported.
    try {
      writeFileSync(fd, JSON.stringify(receipt));
      durably(fd);
    } catch (writeError) {
      try { closeSync(fd); } catch { /* the write error is the one to report */ }
      throw writeError;
    }
    closeSync(fd);
    linkSync(temp, file); // atomic publication, never overwrite a foreign receipt
  } catch (error) {
    if (ours) removeTemp(error);
    throw new Error(`lane administration ${admin} cannot take a handoff receipt (${errnoOf(error)})`, { cause: error });
  }
  // The published directory entry is made durable too, where the filesystem
  // can — before the temporary name is removed, so no cleanup failure skips
  // it. A failure here comes after publication and is named so; the caller
  // rolls the unregistered lane back, receipt and all.
  // Boxed, so even a thrown `undefined` or `null` is a failure.
  let unsynced: { readonly error: unknown } | null = null;
  let unclosed: { readonly error: unknown } | null = null;
  try {
    const dirFd = openSync(admin, 'r');
    try { durably(dirFd); } catch (error) { unsynced = { error }; }
    try { closeSync(dirFd); } catch (error) { unclosed = { error }; }
  } catch (error) {
    unsynced = { error };
  }
  // A close failure alone is a failure to make it durable; after a sync
  // failure it never replaces that reason, but travels with it.
  const failed = unsynced ?? unclosed;
  if (failed === null) {
    removeTemp(null);
    return;
  }
  const undurable = failed.error;
  const cause = unsynced !== null && unclosed !== null ? new AggregateError([unsynced.error, unclosed.error], 'the directory sync and its close both failed') : undurable;
  const notDurable = `lane administration ${admin} published its handoff receipt but could not make it durable (${errnoOf(undurable)})`;
  try { unlinkSync(temp); } catch (cleanupError) {
    if (errnoOf(cleanupError) !== 'ENOENT') {
      throw new Error(`${notDurable}, and its temporary receipt could not be removed (${errnoOf(cleanupError)})`,
        { cause: new AggregateError([cause, cleanupError], 'handoff receipt durability and its cleanup failed') });
    }
  }
  throw new Error(notDurable, { cause });
}

export function assertPendingLaneHandoff(lane: WorktreeRecord, admin: string, token: string): Receipt {
  try {
    const receipt = parseReceipt(readWorktreeMetadata(join(admin, receiptName)));
    if (receipt.state !== 'pending' || receipt.token !== token) throw new Error('original pending handoff receipt changed');
    validate(receipt, lane);
    return receipt;
  } catch (error) { throw new WorktreeHandoffUnresolvedError(lane.path, error); }
}

/** Called only after the original identity/nonce proof and successful unlock. */
export function completeLaneHandoff(lane: WorktreeRecord, admin: string, token: string, ledger: LedgerApi): void {
  const file = join(admin, receiptName);
  const receipt = assertPendingLaneHandoff(lane, admin, token);
  if (existsSync(join(admin, 'locked'))) throw new Error('handoff unlock did not settle');
  const registered = ledger.getWorktree(lane.id);
  if (registered === null || JSON.stringify(registered) !== JSON.stringify(lane)) throw new Error('original service registration changed');
  for (const event of completionFacts(ledger)) {
    if (event.payload.id === lane.id || event.payload.token === token) throw new Error('handoff issuance already exists or conflicts');
  }
  const ready: Receipt = { ...receipt, state: 'ready', createdAt: lane.createdAt };
  const temp = `${file}.${token.slice(13)}`;
  writeFileSync(temp, JSON.stringify(ready), { flag: 'wx' });
  renameSync(temp, file);
  rememberManagedLane(lane, ledger);
  // The injected SERVICE ledger commits before notification. A notification
  // failure retains this fact; no retry may mint replacement authority.
  ledger.appendCustomEvent({ kind: completionKind, jobId: lane.jobId, roundId: lane.roundId, payload: ready });
  captureLaneHandoff(lane)();
}

/** Capture once; all later boundaries validate that SAME completed receipt. */
export function captureLaneHandoff(lane: WorktreeLane): () => void {
  try {
    const association = knownLanes.get(lane.path);
    if (association === undefined) throw new Error('trusted service ledger association is unavailable');
    const { ledger } = association;
    const expected = ledger.getWorktree(association.lane.id);
    if (expected === null || expected.createdAt !== association.lane.createdAt) throw new Error('original registered generation is unavailable');
    const generation = expected.createdAt;
    const admin = adminFor(lane.path), file = join(admin, receiptName);
    // A non-lane administration is refused by name before its receipt is read.
    laneCommonDirectory(admin);
    let original: string;
    try {
      original = readWorktreeMetadata(file);
    } catch (error) {
      throw new Error(`lane administration ${admin} has no readable handoff receipt (${errnoOf(error)})`, { cause: error });
    }
    const receipt = parseReceipt(original);
    const check = (): void => {
      try {
        const current = ledger.getWorktree(expected.id);
        if (current === null || current.status === 'swept' || current.createdAt !== generation) throw new Error('managed lane generation is unavailable or swept');
        if (adminFile(admin, receiptName) !== original || receipt.state !== 'ready' || typeof receipt.createdAt !== 'string' ||
          receipt.createdAt !== generation) throw new Error('completed handoff proof is missing or changed');
        validate(receipt, current);
        validate(receipt, lane);
        assertIssued(receipt, current, ledger);
        if (existsSync(join(admin, 'locked'))) throw new Error('managed lane custody is locked or unresolved');
      } catch (error) { throw new WorktreeHandoffUnresolvedError(lane.path, error); }
    };
    check();
    return check;
  } catch (error) { throw new WorktreeHandoffUnresolvedError(lane.path, error); }
}

export function capturePortLaneHandoff(port: Pick<WorktreePort, 'getWorktree' | 'listWorktrees'>, lane: WorktreeLane): () => void {
  const ledger = managers.get(port);
  if (ledger !== undefined) {
    const original = ledger.getWorktree(lane.id);
    if (original === null) throw new WorktreeHandoffUnresolvedError(lane.path);
    rememberManagedLane(original, ledger);
  }
  const file = join(lane.path, '.git');
  if (!managers.has(port) && !knownLanes.has(lane.path) && !('createdAt' in lane) &&
    (!existsSync(file) || lstatSync(file).isDirectory())) return () => {}; // injected, genuinely non-linked context
  return captureLaneHandoff(lane);
}

function* ancestors(path: string): Generator<string> {
  let current = resolve(path);
  for (;;) {
    yield current;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Resolve missing descendants through their existing ancestor too: replacing
 * or removing a known root must never turn managed custody into an exemption. */
function canonicalCwd(cwd: string): string {
  // resolve() and JS realpath collapse symlink-dependent '..' before the
  // filesystem sees it. Native realpath follows the same traversal as cwd.
  let path = isAbsolute(cwd) ? cwd : `${process.cwd()}/${cwd}`;
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = realpathSync.native(path);
      if (missing.some((part) => part === '.' || part === '..')) throw new Error('cwd parent traversal through missing metadata is unverifiable');
      return join(canonical, ...[...missing].reverse());
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error('cwd symlink target is missing — custody unresolved');
      } catch (metadataError) {
        if (!(metadataError instanceof Error && 'code' in metadataError && metadataError.code === 'ENOENT')) throw metadataError;
      }
      const parent = dirname(path);
      if (parent === path) throw error;
      missing.push(basename(path));
      path = parent;
    }
  }
}

function owningAssociation(cwd: string) {
  const lexical = [...ancestors(cwd)].map((path) => knownLanes.get(path)).find((entry) => entry !== undefined);
  const canonical = canonicalCwd(cwd);
  const owner = [...ancestors(canonical)].map((path) => knownLanes.get(path)).find((entry) => entry !== undefined);
  if (lexical !== undefined && (owner === undefined || owner.ledger !== lexical.ledger || owner.lane.id !== lexical.lane.id)) throw new Error('managed cwd escaped or replaced its owning checkout');
  return { owner, canonical };
}

export function captureCwdHandoff(cwd: string | undefined): () => void {
  if (cwd === undefined) return () => {};
  try {
    const original = owningAssociation(cwd);
    const owner = original.owner;
    if (owner !== undefined) {
      const check = captureLaneHandoff(owner.lane);
      return () => {
        try {
          const current = owningAssociation(cwd);
          if (current.canonical !== original.canonical || current.owner?.ledger !== owner.ledger ||
            current.owner.lane.id !== owner.lane.id || current.owner.lane.createdAt !== owner.lane.createdAt) throw new Error('cwd owning handoff changed');
          check();
        } catch (error) { throw new WorktreeHandoffUnresolvedError(cwd, error); }
      };
    }
    const checkUnassigned = (): void => {
      try {
        const current = owningAssociation(cwd);
        if (current.owner !== undefined) throw new Error('cwd acquired a managed handoff after capture');
        // Linked ancestors without a trusted issuer are unresolved, not unassigned.
        for (const path of ancestors(current.canonical)) {
          const file = join(path, '.git');
          if (existsSync(file) && !lstatSync(file).isDirectory()) throw new Error('registered handoff binding is unavailable');
        }
      } catch (error) { throw new WorktreeHandoffUnresolvedError(cwd, error); }
    };
    checkUnassigned();
    return checkUnassigned; // genuinely unassigned cwd is still rechecked at awaits
  } catch (error) { throw new WorktreeHandoffUnresolvedError(cwd, error); }
}

function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

/** Cleanup's old missing-tree reconciliation is NOT writer readiness. Only
 * affirmative absence of BOTH checkout and associated administration permits it. */
export function assertLaneResourcesAbsent(lane: WorktreeLane): void {
  try {
    if (!absent(lane.path)) throw new Error('checkout is present or replaced');
    const expected = join(realpathSync(dirname(lane.path)), basename(lane.path), '.git');
    const common = repositoryCommonDirectory(lane.repoPath);
    const container = join(common, 'worktrees');
    if (absent(container)) return;
    if (!lstatSync(container).isDirectory()) throw new Error('worktree inventory is not canonical');
    for (const entry of readdirSync(container, { withFileTypes: true })) {
      if (!entry.isDirectory()) throw new Error('ambiguous worktree administration inventory');
      const admin = join(container, entry.name);
      const text = readWorktreeMetadata(join(admin, 'gitdir')).trim();
      if (text === '' || !text.endsWith('/.git')) throw new Error('malformed worktree backlink');
      const backlink = resolve(admin, text);
      const canonical = join(realpathSync(dirname(dirname(backlink))), basename(dirname(backlink)), '.git');
      if (canonical === expected) throw new Error('associated administration retained — custody unresolved');
    }
    if (!absent(lane.path)) throw new Error('checkout appeared during absence inspection');
  } catch (error) { throw new WorktreeHandoffUnresolvedError(lane.path, error); }
}

export function captureCleanupHandoff(lane: WorktreeLane): () => void {
  if (!absent(lane.path)) {
    const check = captureLaneHandoff(lane);
    return () => {
      if (absent(lane.path)) assertLaneResourcesAbsent(lane);
      else check();
    };
  }
  assertLaneResourcesAbsent(lane);
  return () => assertLaneResourcesAbsent(lane);
}
