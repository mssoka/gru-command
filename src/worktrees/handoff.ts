import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { WorktreePort, WorktreeLane } from '../dispatch/worktree-port.js';
import type { LedgerApi, WorktreeRecord } from '../ledger/api.js';

const receiptName = 'gru-creation-handoff.json';
const knownLanes = new Map<string, { readonly lane: WorktreeRecord; readonly ledger: LedgerApi }>();
const managers = new WeakMap<object, LedgerApi>();
const completionKind = 'worktree.handoff-completed';
const factPageSize = 1000;
export function registerHandoffManager(manager: object, ledger: LedgerApi): void {
  managers.set(manager, ledger);
  for (const lane of ledger.listWorktrees()) rememberManagedLane(lane, ledger);
}

/** Internal descriptor-bound metadata proof shared with creation rollback. */
export function readWorktreeMetadata(file: string, limit = 64 * 1024): string {
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

interface Receipt {
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
    'token' in value && typeof value.token === 'string' && /^gru-creation:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.token) &&
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
  if (fact.jobId !== lane.jobId || fact.roundId !== lane.roundId || JSON.stringify(fact.payload) !== JSON.stringify(receipt) ||
    JSON.stringify(ledger.getEvent(fact.seq)) !== JSON.stringify(fact)) throw new Error('service handoff issuance conflicts with original binding');
}

function adminFor(path: string): string {
  const file = join(path, '.git');
  if (!lstatSync(file).isFile()) throw new Error('managed checkout no longer has its linked gitdir file');
  const text = readWorktreeMetadata(file).trim();
  if (!text.startsWith('gitdir: ')) throw new Error('managed checkout lost its linked gitdir');
  return realpathSync(resolve(path, text.slice(8)));
}

function validate(receipt: Receipt, lane: WorktreeLane): void {
  const admin = adminFor(lane.path);
  const common = realpathSync(resolve(admin, readWorktreeMetadata(join(admin, 'commondir')).trim()));
  const repoGit = join(lane.repoPath, '.git');
  const repoCommon = lstatSync(repoGit).isDirectory() ? realpathSync(repoGit)
    : realpathSync(resolve(adminFor(lane.repoPath), readWorktreeMetadata(join(adminFor(lane.repoPath), 'commondir')).trim()));
  if (repoCommon !== common || receipt.id !== lane.id || receipt.kind !== lane.kind || receipt.jobId !== lane.jobId || receipt.roundId !== lane.roundId || receipt.branch !== lane.branch || receipt.sha !== lane.sha ||
    receipt.repo !== realpathSync(lane.repoPath) || receipt.path !== realpathSync(lane.path) || receipt.admin !== admin || receipt.common !== common ||
    dirname(admin) !== join(common, 'worktrees') ||
    realpathSync(resolve(admin, readWorktreeMetadata(join(admin, 'gitdir')).trim())) !== realpathSync(join(lane.path, '.git'))) throw new Error('handoff binding changed');
  // Job/writer commits may advance. Attachment must not: a detached lane is
  // frozen, and a writer's reserved name must still be a direct branch.
  if (existsSync(join(common, 'reftable'))) throw new Error('unsupported ref storage — handoff identity unverified');
  const head = readWorktreeMetadata(join(admin, 'HEAD')).trim();
  if (lane.branch === null) {
    if (head !== lane.sha) throw new Error('detached handoff identity changed');
  } else {
    if (head !== `ref: refs/heads/${lane.branch}`) throw new Error('writer handoff attachment changed');
    const ref = join(common, 'refs', 'heads', lane.branch);
    if (existsSync(ref)) {
      if (realpathSync(ref) !== ref || !lstatSync(ref).isFile() || !/^[0-9a-f]{40,64}$/u.test(readWorktreeMetadata(ref).trim()) || readWorktreeMetadata(ref).trim().length !== lane.sha.length) throw new Error('writer branch is not direct');
    } else {
      const packed = readWorktreeMetadata(join(common, 'packed-refs'), 16 * 1024 * 1024);
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
  const receipt: Receipt = { state: 'pending', token, id: lane.id, kind: lane.kind, jobId: lane.jobId, roundId: lane.roundId, repo: realpathSync(lane.repoPath),
    common: realpathSync(resolve(admin, readWorktreeMetadata(join(admin, 'commondir')).trim())), admin,
    path: realpathSync(lane.path), branch: lane.branch, sha: lane.sha, createdAt: null };
  const file = join(admin, receiptName), temp = `${file}.${token.slice(13)}`;
  writeFileSync(temp, JSON.stringify(receipt), { flag: 'wx' });
  linkSync(temp, file); // atomic publication, never overwrite a foreign receipt
  unlinkSync(temp);
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
    const original = readWorktreeMetadata(file);
    const receipt = parseReceipt(original);
    const check = (): void => {
      try {
        const current = ledger.getWorktree(expected.id);
        if (current === null || current.status === 'swept' || current.createdAt !== generation) throw new Error('managed lane generation is unavailable or swept');
        if (readWorktreeMetadata(file) !== original || receipt.state !== 'ready' || typeof receipt.createdAt !== 'string' ||
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
    const repoGit = join(lane.repoPath, '.git');
    const common = lstatSync(repoGit).isDirectory() ? realpathSync(repoGit)
      : realpathSync(resolve(adminFor(lane.repoPath), readWorktreeMetadata(join(adminFor(lane.repoPath), 'commondir')).trim()));
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
