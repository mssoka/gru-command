import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { defaultPackageRoot } from '../build-info.js';
import { loadConfig, type GruCommandConfig } from '../config.js';
import { repositoryGitEnv } from '../git-env.js';
import { defaultListenerProbe, type ListenerProbe } from '../listener-probe.js';
import { resolveManagedRepoPathSync } from '../repos/managed-names.js';
import { dialHost } from './service.js';

/**
 * `gru-service reset` (#427 PR 2b): a clean fresh start that keeps the
 * config. Deleting `~/.gru-command` by hand also deleted `config.toml` and
 * left dangling worktree registrations and `gru/*` branches in every
 * managed repository. In order, reset:
 *
 * 1. refuses while the service may run: something listens on its port, its
 *    `/health` gives any answer but a refused connection (a timeout
 *    included), or its ledger is held open (SQLite's own lock, which the
 *    service holds while it runs; it keeps no pid file). It checks again
 *    after the confirmation, immediately before the first change, and holds
 *    the ledger's lock until it is done, so a service cannot start under it;
 * 2. lists what it will do;
 * 3. with `--yes`, or a confirmation at the terminal:
 *    - removes every GC lane with `git worktree remove --force --force` in
 *      the repository that registers it (lanes are created locked): the
 *      managed repositories' lanes, and the lanes of repositories that are
 *      not managed or not available now, found under `[worktrees] root`, in
 *      the data directory or in the ledger's registry and read from their
 *      own `.git` file. A GC lane is a worktree the registry names, or one
 *      under the lanes root on a `gru/*` branch, locked by GC's creation or
 *      holding GC's handoff receipt; any other worktree is the user's and
 *      is never touched. A lane folder its existing repository does not
 *      register is deleted as a folder; one whose repository cannot be
 *      found is left and named. Then `git worktree prune` runs in each
 *      managed repository, unless it would also drop a worktree of the
 *      user's own whose folder is missing (then it says so and skips it);
 *    - deletes `gru/*` branches only with `--delete-branches` (`git branch
 *      -D`; one a worktree of the user's has checked out is kept, named),
 *      and `refs/gru/*` only with `--delete-refs`;
 *    - deletes the data directory's contents except `config.toml`, the
 *      install's own files ({@link RESET_KEEPS}) and any worktree of the
 *      user's in it, keeping the directory. The delete never follows a link:
 *      a link is deleted as a link.
 *
 * It prints what it removed. It never touches the user's own branches,
 * worktrees or files: a data directory (as the filesystem resolves it) that
 * is or holds the home directory, the filesystem root, the workspace or a
 * managed repository, or that holds the install or lies inside it, is
 * refused; a lane that is not removed leaves the data directory as it was.
 */

/** What reset keeps in the data directory: the config, and the install's
 * own files (the instance identity, provider credentials, the Perkins
 * GitHub App bundle, the installer's consent and wizard draft, and the
 * service unit's own log files). A kept path's folders are kept too; what
 * else they hold is deleted. */
export const RESET_KEEPS: readonly string[] = [
  'config.toml',
  'identity',
  'credentials',
  'perkins',
  'onboarding-consent.json',
  'wizard-draft.json',
  'logs/launchd.out.log',
  'logs/launchd.err.log',
];

const USAGE = `usage: gru-service reset [--yes] [--delete-branches] [--delete-refs]

  reset   stop-the-world fresh start that keeps config.toml: removes every GC
          lane from the repository that registers it (git worktree remove
          --force --force, then git worktree prune) and empties the data
          directory except config.toml and the install's own files. The
          service must be stopped. It lists what it will do and asks first.

  --yes              do it without asking
  --delete-branches  also delete gru/* branches (never one checked out)
  --delete-refs      also delete refs/gru/* (GC's saved snapshots)
`;

export interface ResetOptions {
  readonly yes: boolean;
  readonly deleteBranches: boolean;
  readonly deleteRefs: boolean;
}

export type ResetParse =
  | { readonly ok: true; readonly options: ResetOptions }
  | { readonly ok: false; readonly error: string; readonly help: boolean };

export function parseResetArgs(argv: readonly string[]): ResetParse {
  let yes = false;
  let deleteBranches = false;
  let deleteRefs = false;
  for (const arg of argv) {
    if (arg === '--yes') yes = true;
    else if (arg === '--delete-branches') deleteBranches = true;
    else if (arg === '--delete-refs') deleteRefs = true;
    else if (arg === '-h' || arg === '--help') return { ok: false, error: '', help: true };
    else return { ok: false, error: `unknown argument: ${arg}`, help: true };
  }
  return { ok: true, options: { yes, deleteBranches, deleteRefs } };
}

export interface ResetCliDeps {
  readonly loadConfig: () => GruCommandConfig;
  /** Who listens on the service's port; null where the platform has no probe. */
  readonly probeListeners: ListenerProbe;
  readonly fetchFn: typeof fetch;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Ask at the terminal; null when there is none to ask at. */
  readonly confirm: ((question: string) => Promise<boolean>) | null;
  /** The install's own code: a data directory that holds it, or lies in it, is refused. */
  readonly packageRoot: string;
  readonly homeDir: string;
}

function defaultDeps(): ResetCliDeps {
  return {
    loadConfig: () => loadConfig(),
    probeListeners: (host, port) => defaultListenerProbe(host, port),
    fetchFn: (input, init) => fetch(input, init),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    confirm: process.stdin.isTTY === true ? askAtTerminal : null,
    packageRoot: defaultPackageRoot(),
    homeDir: homedir(),
  };
}

async function askAtTerminal(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/iu.test((await terminal.question(question)).trim());
  } finally {
    terminal.close();
  }
}

/** One GC lane to remove: `git <at> worktree remove --force --force <path>`
 * (`at`: `-C <repository>` or `--git-dir <common dir>`), or, for a lane
 * folder its existing repository does not register (`at` null), the folder. */
interface LanePlan {
  readonly path: string;
  readonly at: readonly string[] | null;
  /** The repository it is removed from, as the plan names it. */
  readonly repo: string;
}

interface RepoPlan {
  readonly name: string;
  readonly path: string;
  readonly lanes: readonly LanePlan[];
  readonly branches: readonly string[];
  /** `gru/*` branches a worktree of the user's has checked out: kept. */
  readonly checkedOut: readonly { readonly branch: string; readonly tree: string }[];
  readonly refs: readonly string[];
  /** Worktrees of the user's own whose folder is missing: a prune would drop them. */
  readonly userPrunable: readonly string[];
}

/** Lanes no managed repository's listing holds: those to remove, and those
 * left (named), which leave the data directory as it is. */
interface OtherLanes {
  readonly lanes: readonly LanePlan[];
  readonly left: readonly { readonly path: string; readonly reason: string }[];
}

/** One lane the ledger's registry names. */
interface RegistryLane {
  readonly path: string;
  readonly repoPath: string;
  readonly status: string;
}

/** What the plan reads once and gathers as it goes. */
interface PlanContext {
  readonly realData: string | null;
  readonly laneRoots: readonly string[];
  /** The registry's lanes not yet swept, by their path as recorded and as resolved. */
  readonly registry: ReadonlyMap<string, RegistryLane>;
  /** Real paths of every worktree a managed repository lists. */
  readonly listed: Set<string>;
  /** Real paths of the user's worktrees (and folders not GC's) in the data directory: never deleted. */
  readonly protect: Set<string>;
}

const STOP_HINT =
  'Stop it first: launchctl bootout gui/$(id -u)/com.gru-command.service (macOS) or systemctl --user stop gru-command (Linux), ' +
  'or end the npm start it runs in; then run gru-service reset again, and start the service afterwards with ./install.sh --service.';

export async function runResetCli(argv: readonly string[], overrides: Partial<ResetCliDeps> = {}): Promise<number> {
  const deps: ResetCliDeps = { ...defaultDeps(), ...overrides };
  const parsed = parseResetArgs(argv);
  if (!parsed.ok) {
    if (parsed.error !== '') deps.stderr(`gru-service reset: ${parsed.error}`);
    deps.stderr(USAGE.trimEnd());
    return parsed.error === '' ? 0 : 2;
  }
  const options = parsed.options;
  let config: GruCommandConfig;
  try {
    config = deps.loadConfig();
  } catch (error) {
    deps.stderr(`gru-service reset: cannot load instance config: ${String((error as Error).message)}`);
    return 1;
  }

  // The data directory as the filesystem resolves it: every check, and the
  // delete, use this one path.
  let realData: string | null;
  try {
    realData = existsSync(config.dataDir) ? realpathSync(config.dataDir) : null;
  } catch (error) {
    deps.stderr(`gru-service reset: refused: the data directory ${config.dataDir} cannot be resolved: ${String((error as Error).message)}`);
    return 1;
  }
  const refusal = dataDirRefusal(config, realData, deps);
  if (refusal !== null) {
    deps.stderr(`gru-service reset: refused: ${refusal}`);
    return 1;
  }

  // 1. Never while the service may run.
  const running = await serviceRunning(config, deps);
  if (running !== null) {
    deps.stderr(`gru-service reset: refused: ${running}. ${STOP_HINT}`);
    return 1;
  }
  const first = await lockLedger(realData);
  if (first.kind === 'held') {
    deps.stderr(`gru-service reset: refused: ${first.detail}. ${STOP_HINT}`);
    return 1;
  }
  let registry: readonly RegistryLane[] = [];
  if (first.kind === 'locked') {
    first.release();
    if (typeof first.registry === 'string') deps.stdout(`note: the ledger's lane registry cannot be read (${first.registry}); lanes are told by their gru/* branch, GC's lock and GC's handoff receipt`);
    else registry = first.registry;
  } else if (first.kind === 'unusable') {
    deps.stdout(`note: ${first.detail}`);
  }

  // 2. What it will do.
  const ctx: PlanContext = {
    realData,
    laneRoots: [...new Set([resolve(config.worktrees.root), real(config.worktrees.root)])],
    registry: new Map(registry.filter((lane) => lane.status !== 'swept').flatMap((lane) => [[lane.path, lane], [real(lane.path), lane]] as const)),
    listed: new Set(),
    protect: new Set(),
  };
  const repos: RepoPlan[] = [];
  for (const name of config.managedRepos) {
    const resolved = resolveManagedRepoPathSync(config.workspaceRoot, name);
    if (resolved.kind !== 'available') {
      deps.stdout(`skipped ${name}: ${resolved.kind === 'unavailable' ? resolved.reason : resolved.error}; its lanes are removed from the repository that registers them`);
      continue;
    }
    try {
      repos.push(planRepo(name, resolved.path, ctx, options));
    } catch (error) {
      deps.stderr(`gru-service reset: refused: ${name} (${resolved.path}) cannot be read: ${String((error as Error).message)}`);
      return 1;
    }
  }
  const others = planOtherLanes(ctx);
  const data = planDataDir(realData, ctx.protect);
  printPlan(deps, config, options, repos, others, ctx, data);

  // 3. Only with --yes or a confirmation.
  if (!options.yes) {
    if (deps.confirm === null) {
      deps.stderr('gru-service reset: no terminal to confirm at; nothing changed. Pass --yes to reset.');
      return 1;
    }
    if (!(await deps.confirm('Proceed? [y/N] '))) {
      deps.stdout('reset cancelled; nothing changed.');
      return 1;
    }
  }

  // Again, immediately before the first change: the service may have
  // started while reset waited. The ledger's lock is held until reset ends.
  const again = await serviceRunning(config, deps);
  if (again !== null) {
    deps.stderr(`gru-service reset: refused: ${again} (checked again before changing anything; nothing changed). ${STOP_HINT}`);
    return 1;
  }
  const lock = await lockLedger(realData);
  if (lock.kind === 'held') {
    deps.stderr(`gru-service reset: refused: ${lock.detail} (checked again before changing anything; nothing changed). ${STOP_HINT}`);
    return 1;
  }
  try {
    return carryOut(deps, config, realData, repos, others, data);
  } finally {
    if (lock.kind === 'locked') lock.release();
  }
}

function carryOut(
  deps: ResetCliDeps, config: GruCommandConfig, realData: string | null, repos: readonly RepoPlan[], others: OtherLanes,
  data: { readonly remove: readonly string[]; readonly keep: readonly string[] },
): number {
  const failed: string[] = [];
  const removeLane = (lane: LanePlan): void => {
    if (lane.at === null) {
      try {
        removeNoFollow(lane.path);
        deps.stdout(`removed lane folder ${lane.path} (${lane.repo} does not register it)`);
      } catch (error) {
        failed.push(lane.path);
        deps.stderr(`gru-service reset: lane folder ${lane.path} could not be deleted: ${String((error as Error).message)}`);
      }
      return;
    }
    const removed = git([...lane.at, 'worktree', 'remove', '--force', '--force', lane.path]);
    if (removed.status === 0) deps.stdout(`removed lane ${lane.path} from ${lane.repo}`);
    else {
      failed.push(lane.path);
      deps.stderr(`gru-service reset: lane ${lane.path} could not be removed from ${lane.repo}: ${removed.stderr.trim()}`);
    }
  };
  for (const repo of repos) for (const lane of repo.lanes) removeLane(lane);
  for (const lane of others.lanes) removeLane(lane);
  for (const { path, reason } of others.left) {
    failed.push(path);
    deps.stderr(`gru-service reset: lane ${path} was not removed: ${reason}`);
  }
  for (const repo of repos) {
    if (repo.userPrunable.length === 0) {
      const pruned = git(['-C', repo.path, 'worktree', 'prune']);
      if (pruned.status !== 0) deps.stderr(`gru-service reset: git worktree prune failed in ${repo.name}: ${pruned.stderr.trim()}`);
    } else {
      deps.stdout(`skipped git worktree prune in ${repo.name}: it would also drop your own worktree(s) whose folder is missing: ${repo.userPrunable.join(', ')}`);
    }
    for (const branch of repo.branches) {
      // `git branch -D` refuses a branch checked out anywhere, a lane included.
      const deleted = git(['-C', repo.path, 'branch', '-D', branch]);
      if (deleted.status === 0) deps.stdout(`deleted branch ${branch} in ${repo.name}`);
      else deps.stderr(`gru-service reset: branch ${branch} in ${repo.name} was kept: ${deleted.stderr.trim()}`);
    }
    for (const ref of repo.refs) {
      const deleted = git(['-C', repo.path, 'update-ref', '-d', ref]);
      if (deleted.status === 0) deps.stdout(`deleted ref ${ref} in ${repo.name}`);
      else deps.stderr(`gru-service reset: ref ${ref} in ${repo.name} was kept: ${deleted.stderr.trim()}`);
    }
  }
  if (failed.length > 0) {
    deps.stderr(`gru-service reset: ${String(failed.length)} lane(s) were not removed (${failed.join(', ')}), so the data directory ${config.dataDir} was left as it was; fix what held them and run reset again.`);
    return 1;
  }
  if (realData === null) {
    deps.stdout(`reset done: there is no data directory at ${config.dataDir}. Start the service with ./install.sh --service (or npm start).`);
    return 0;
  }
  let incomplete = false;
  for (const entry of data.remove) {
    const full = join(realData, entry);
    try {
      removeNoFollow(full);
      deps.stdout(`deleted ${full}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      incomplete = true;
      deps.stderr(`gru-service reset: ${full} could not be deleted: ${String((error as Error).message)}`);
    }
  }
  if (incomplete) return 1;
  deps.stdout(`reset done: ${config.dataDir} keeps ${data.keep.length === 0 ? 'nothing else' : data.keep.join(', ')}. Start the service with ./install.sh --service (or npm start).`);
  return 0;
}

/** Why the service may be running, or null when it is provably stopped:
 * nothing listens on its port and its `/health` connection is refused. */
async function serviceRunning(config: GruCommandConfig, deps: ResetCliDeps): Promise<string | null> {
  const port = config.server.port;
  if (port === 0) return 'the instance binds an ephemeral port (port = 0), so reset cannot tell whether the service runs';
  const host = dialHost(config.server.host);
  const owners = await deps.probeListeners(host, port);
  if (owners !== null && owners.length > 0) {
    return `the service is running: ${owners.map((owner) => `pid ${String(owner.pid)}${owner.command === '' ? '' : ` (${owner.command})`}`).join(', ')} listens on port ${String(port)}`;
  }
  const url = `http://${host}:${String(port)}/health`;
  try {
    const res = await deps.fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(2_000) });
    return `the service is running: ${url} answered (HTTP ${String(res.status)})`;
  } catch (error) {
    if (connectionRefused(error)) return null;
    return `the service may be running: ${url} did not refuse the connection (${errorText(error)})`;
  }
}

/** Whether a failed fetch is a refused connection (every address tried refused). */
function connectionRefused(error: unknown): boolean {
  const seen = new Set<unknown>();
  const refused = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return false;
    seen.add(value);
    const { code, cause, errors } = value as { readonly code?: unknown; readonly cause?: unknown; readonly errors?: unknown };
    if (Array.isArray(errors) && errors.length > 0) return errors.every(refused);
    return code === 'ECONNREFUSED' || refused(cause);
  };
  return refused(error);
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { readonly cause?: unknown }).cause;
  return cause instanceof Error ? `${error.name}: ${error.message}: ${cause.message}` : `${error.name}: ${error.message}`;
}

type LedgerProbe =
  | { readonly kind: 'absent' }
  | { readonly kind: 'held'; readonly detail: string }
  | { readonly kind: 'unusable'; readonly detail: string }
  | { readonly kind: 'locked'; readonly registry: readonly RegistryLane[] | string; readonly release: () => void };

/** SQLite result codes: busy and locked (another connection holds the
 * file), and a damaged file or one that is no database. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/**
 * The ledger's exclusive lock: SQLite's own file lock, which a service
 * holds for as long as its ledger is open. `held` while another process
 * (or connection) has it open, or when that cannot be told; `locked`, with
 * the registry's lanes read under it, keeping the lock until `release` (a
 * service starting meanwhile cannot open its ledger); `unusable` for a file
 * SQLite cannot use as a database, which no service runs on either.
 */
async function lockLedger(realData: string | null): Promise<LedgerProbe> {
  if (realData === null) return { kind: 'absent' };
  const file = join(realData, 'ledger', 'ledger.db');
  if (!existsSync(file)) return { kind: 'absent' };
  // Loaded only here: `gru-service roll` never touches the ledger.
  const { DatabaseSync } = await import('node:sqlite');
  let db: InstanceType<typeof DatabaseSync> | null = null;
  try {
    db = new DatabaseSync(file, { timeout: 0 });
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
  } catch (error) {
    try { db?.close(); } catch { /* the lock's error is the one to report */ }
    const code = (error as { readonly errcode?: unknown }).errcode;
    const message = (error as Error).message;
    if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return { kind: 'held', detail: `the service's ledger ${file} is held open by a running process (${message})` };
    if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return { kind: 'unusable', detail: `the ledger ${file} is not a usable database (${message}), so no service runs on it` };
    return { kind: 'held', detail: `whether a running service holds the ledger ${file} cannot be told (${message})` };
  }
  const held = db;
  let registry: readonly RegistryLane[] | string;
  try {
    registry = (held.prepare('SELECT path, repo_path, status FROM worktrees').all() as { path: unknown; repo_path: unknown; status: unknown }[])
      .filter((row) => typeof row.path === 'string' && row.path !== '')
      .map((row) => ({ path: row.path as string, repoPath: String(row.repo_path ?? ''), status: String(row.status) }));
  } catch (error) {
    registry = (error as Error).message;
  }
  return { kind: 'locked', registry, release: () => { try { held.close(); } catch { /* closed already */ } } };
}

/** Why emptying the data directory would touch the user's own files or the
 * install, or null. Every path is compared as the filesystem resolves it,
 * by path segment. */
function dataDirRefusal(config: GruCommandConfig, realData: string | null, deps: ResetCliDeps): string | null {
  if (realData === null) return null;
  const named = realData === config.dataDir ? config.dataDir : `${config.dataDir} (${realData})`;
  if (realData === dirname(realData)) return `the data directory ${named} is the file system root`;
  const home = real(deps.homeDir);
  if (within(realData, home)) return `the data directory ${named} ${realData === home ? 'is' : 'holds'} your home directory ${deps.homeDir}`;
  if (within(realData, real(config.workspaceRoot))) return `the data directory ${named} holds the workspace root ${config.workspaceRoot}`;
  for (const name of config.managedRepos) {
    if (within(realData, real(join(config.workspaceRoot, name)))) return `the data directory ${named} holds the managed repository ${name}`;
  }
  const install = real(deps.packageRoot);
  if (within(realData, install)) return `the data directory ${named} holds the install ${deps.packageRoot}`;
  if (within(install, realData)) return `the data directory ${named} lies inside the install ${deps.packageRoot}`;
  return null;
}

/** Whether `inner` is `outer` or lies inside it, by path segment (never by
 * a string prefix: `<data>/..code` lies inside, `<data>-2` does not). */
function within(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A path as the filesystem resolves it: its nearest existing ancestor
 * resolved, the rest as spelled. */
function real(path: string): string {
  const missing: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(at), ...[...missing].reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      missing.push(basename(at));
      at = parent;
    }
  }
}

function underLaneRoot(ctx: PlanContext, path: string): boolean {
  return ctx.laneRoots.some((root) => path !== root && within(root, path));
}

/** A folder where GC makes lanes: `<lanes root>/<repository>/<job|review|child>-<id>`. */
function laneShaped(ctx: PlanContext, path: string): boolean {
  return ctx.laneRoots.some((root) => {
    const parts = relative(root, path).split(sep);
    return within(root, path) && parts.length === 2 && /^(job|review|child)-./u.test(parts[1]!);
  });
}

/** Whether a worktree is a GC lane: the registry names it, or it lies under
 * the lanes root on a `gru/*` branch, locked by GC's creation, or with GC's
 * handoff receipt for it in its administration. */
function gcLane(ctx: PlanContext, tree: string, facts: { readonly branch: string | null; readonly lock: string | null; readonly admin: string | null }): boolean {
  const resolved = real(tree);
  if (ctx.registry.has(tree) || ctx.registry.has(resolved)) return true;
  if (!underLaneRoot(ctx, resolved) && !underLaneRoot(ctx, resolve(tree))) return false;
  if (facts.branch?.startsWith('gru/') === true || facts.lock?.startsWith('gru-creation:') === true) return true;
  const admin = facts.admin ?? adminNamedBy(tree);
  if (admin === null) return false;
  try {
    const receipt = JSON.parse(readFileSync(join(admin, 'gru-creation-handoff.json'), 'utf-8')) as { readonly path?: unknown };
    return receipt.path === resolved;
  } catch {
    return false;
  }
}

/** The worktrees a repository's `git worktree list --porcelain -z` names:
 * each record's fields, the repository's own checkout first. */
function worktreeRecords(at: readonly string[]): string[][] {
  const listing = git([...at, 'worktree', 'list', '--porcelain', '-z']);
  if (listing.status !== 0) throw new Error(`git worktree list failed: ${listing.stderr.trim()}`);
  // Records are NUL-separated fields, each record ended by an empty field.
  return listing.stdout.split('\0\0').map((record) => record.split('\0').filter((field) => field !== '')).filter((fields) => fields.length > 0);
}

function planRepo(name: string, path: string, ctx: PlanContext, options: ResetOptions): RepoPlan {
  const lanes: LanePlan[] = [];
  const userPrunable: string[] = [];
  /** Branches the user's own worktrees (the repository's checkout included) have checked out. */
  const userBranches = new Map<string, string>();
  for (const [index, fields] of worktreeRecords(['-C', path]).entries()) {
    const tree = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
    if (tree === undefined) continue;
    ctx.listed.add(real(tree));
    const branch = fields.find((field) => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null;
    const locked = fields.find((field) => field === 'locked' || field.startsWith('locked '));
    const lock = locked === undefined ? null : locked.slice('locked '.length);
    if (index > 0 && gcLane(ctx, tree, { branch, lock, admin: null })) {
      lanes.push({ path: tree, at: ['-C', path], repo: name });
      continue;
    }
    if (branch !== null) userBranches.set(branch, tree);
    if (index > 0 && fields.some((field) => field === 'prunable' || field.startsWith('prunable '))) userPrunable.push(tree);
    if (index > 0 && ctx.realData !== null && within(ctx.realData, real(tree))) ctx.protect.add(real(tree));
  }
  const listRefs = (pattern: string, format: string): string[] => {
    const run = git(['-C', path, 'for-each-ref', `--format=${format}`, pattern]);
    if (run.status !== 0) throw new Error(`git for-each-ref ${pattern} failed: ${run.stderr.trim()}`);
    return run.stdout.split('\n').filter((line) => line !== '');
  };
  // lstrip=2, never refname:short, which a same-named tag turns into `heads/gru/x`.
  const gruBranches = options.deleteBranches ? listRefs('refs/heads/gru/', '%(refname:lstrip=2)') : [];
  return {
    name,
    path,
    lanes,
    branches: gruBranches.filter((branch) => !userBranches.has(branch)),
    checkedOut: gruBranches.filter((branch) => userBranches.has(branch)).map((branch) => ({ branch, tree: userBranches.get(branch)! })),
    refs: options.deleteRefs ? listRefs('refs/gru/', '%(refname)') : [],
    userPrunable,
  };
}

/**
 * The lanes no managed repository lists (#427 PR 2b review): linked
 * worktrees (a `.git` FILE) under the lanes root (two levels deep) or in the
 * data directory (three), and the registry's lanes not yet swept. Each is
 * read from its own `.git` file, never through git:
 * - registered in an existing repository (an administration there points
 *   back at it): a GC lane is removed there; any other is the user's, kept;
 * - otherwise, a lane GC made (the registry names it, or it has a lane's
 *   place under the lanes root) is removed from the repository the registry
 *   records when that one lists it; else its folder is deleted when its
 *   existing repository registers it nowhere; else, its repository not
 *   found or its `.git` file unreadable, it is left and named. Any other
 *   folder is kept.
 * A registry lane whose folder is gone is deregistered from the repository
 * the registry records, when that one still lists it.
 */
function planOtherLanes(ctx: PlanContext): OtherLanes {
  const candidates = new Map<string, string>();
  const add = (path: string): void => {
    const resolved = real(path);
    if (!ctx.listed.has(resolved) && !candidates.has(resolved)) candidates.set(resolved, path);
  };
  for (const root of ctx.laneRoots) for (const tree of linkedTrees(root, 2)) add(tree);
  if (ctx.realData !== null) for (const tree of linkedTrees(ctx.realData, 3)) add(tree);
  const registered = [...new Set(ctx.registry.values())];
  for (const lane of registered) if (existsSync(lane.path)) add(lane.path);
  const lanes: LanePlan[] = [];
  const left: { path: string; reason: string }[] = [];
  const listings = new Map<string, Set<string> | null>();
  /** The registry's repository of a lane, when it lists that lane. */
  const recordedRepository = (tree: string, resolved: string): string | null => {
    const lane = ctx.registry.get(tree) ?? ctx.registry.get(resolved);
    if (lane === undefined || lane.repoPath === '' || !existsSync(lane.repoPath)) return null;
    if (!listings.has(lane.repoPath)) {
      try {
        listings.set(lane.repoPath, new Set(worktreeRecords(['-C', lane.repoPath]).slice(1)
          .map((fields) => fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length))
          .filter((path): path is string => path !== undefined).map(real)));
      } catch {
        listings.set(lane.repoPath, null);
      }
    }
    return listings.get(lane.repoPath)?.has(resolved) === true ? lane.repoPath : null;
  };
  const keep = (resolved: string): void => {
    if (ctx.realData !== null && within(ctx.realData, resolved)) ctx.protect.add(resolved);
  };
  for (const [resolved, tree] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    const link = linkedTree(tree);
    if (!('problem' in link) && link.admin !== null && link.common !== null) {
      if (gcLane(ctx, tree, { ...adminFacts(link.admin), admin: link.admin })) lanes.push({ path: tree, at: ['--git-dir', link.common], repo: link.common });
      else keep(resolved);
      continue;
    }
    if (!ctx.registry.has(tree) && !ctx.registry.has(resolved) && !laneShaped(ctx, resolved)) {
      keep(resolved);
      continue;
    }
    const recorded = recordedRepository(tree, resolved);
    if (recorded !== null) lanes.push({ path: tree, at: ['-C', recorded], repo: recorded });
    else if ('problem' in link) left.push({ path: tree, reason: link.problem });
    else if (link.common !== null) lanes.push({ path: tree, at: null, repo: link.common });
    else left.push({ path: tree, reason: `the repository its .git file names (${link.named}) cannot be found, so whether it still registers the lane cannot be told; delete the folder yourself once you no longer need what it holds` });
  }
  for (const lane of registered) {
    if (existsSync(lane.path) || ctx.listed.has(real(lane.path))) continue;
    const recorded = recordedRepository(lane.path, real(lane.path));
    if (recorded !== null) lanes.push({ path: lane.path, at: ['-C', recorded], repo: recorded });
  }
  return { lanes, left };
}

/** Real folders (never links) up to `depth` levels under `root` whose
 * `.git` is a file: linked worktrees. Their insides, and a folder holding a
 * repository's own `.git`, are not searched. */
function linkedTrees(root: string, depth: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, level: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let gitKind: 'file' | 'other' | 'none' = 'none';
      try {
        if (!lstatSync(path).isDirectory()) continue;
        gitKind = lstatSync(join(path, '.git')).isFile() ? 'file' : 'other';
      } catch {
        // not a folder, or no .git in it
      }
      if (gitKind === 'file') found.push(path);
      else if (gitKind === 'none' && level < depth) walk(path, level + 1);
    }
  };
  try {
    if (lstatSync(root).isDirectory()) walk(root, 1);
  } catch {
    // no such root
  }
  return found;
}

/** The administration a worktree's `.git` file names, when it is a folder. */
function adminNamedBy(tree: string): string | null {
  try {
    const line = readFileSync(join(tree, '.git'), 'utf-8').replace(/[\r\n]+$/u, '');
    if (!line.startsWith('gitdir: ')) return null;
    const admin = resolve(tree, line.slice('gitdir: '.length));
    return statSync(admin).isDirectory() ? admin : null;
  } catch {
    return null;
  }
}

/** A worktree's branch and lock reason, read from its administration. */
function adminFacts(admin: string): { readonly branch: string | null; readonly lock: string | null } {
  let branch: string | null = null;
  let lock: string | null = null;
  try {
    const head = readFileSync(join(admin, 'HEAD'), 'utf-8').trim();
    if (head.startsWith('ref: refs/heads/')) branch = head.slice('ref: refs/heads/'.length);
  } catch {
    // no HEAD: no branch
  }
  try {
    lock = readFileSync(join(admin, 'locked'), 'utf-8').trim();
  } catch {
    // not locked
  }
  return { branch, lock };
}

/**
 * Where a linked worktree is registered, read from its `.git` file: the
 * administration that points back at it (the one the file names, or another
 * of the same repository's) and that repository's common directory; the
 * common directory alone when that repository registers the folder nowhere;
 * neither when that repository cannot be found. A `.git` file that cannot
 * be read, or names no gitdir, is a problem, by name.
 */
function linkedTree(tree: string):
  | { readonly admin: string | null; readonly common: string | null; readonly named: string }
  | { readonly problem: string } {
  let line: string;
  try {
    line = readFileSync(join(tree, '.git'), 'utf-8').replace(/[\r\n]+$/u, '');
  } catch (error) {
    return { problem: `its .git file cannot be read (${String((error as NodeJS.ErrnoException).code ?? (error as Error).message)})` };
  }
  if (!line.startsWith('gitdir: ') || line === 'gitdir: ' || /[\r\n]/u.test(line)) return { problem: 'its .git file names no gitdir' };
  const named = resolve(tree, line.slice('gitdir: '.length));
  const own = real(join(tree, '.git'));
  const pointsBack = (admin: string): boolean => {
    try {
      return real(resolve(admin, readFileSync(join(admin, 'gitdir'), 'utf-8').trimEnd())) === own;
    } catch {
      return false;
    }
  };
  const commonOf = (admin: string): string | null => {
    try {
      const common = realpathSync(resolve(admin, readFileSync(join(admin, 'commondir'), 'utf-8').trim()));
      return gitDirectory(common) ? common : null;
    } catch {
      return null;
    }
  };
  if (pointsBack(named)) return { admin: named, common: commonOf(named), named };
  // The administration it names is gone, or is another folder's: its
  // repository may still register it under another name.
  const container = dirname(named);
  if (basename(container) !== 'worktrees' || !gitDirectory(dirname(container))) return { admin: null, common: null, named };
  const common = realpathSync(dirname(container));
  let ids: string[] = [];
  try {
    ids = readdirSync(container).sort();
  } catch {
    // no administrations
  }
  const admin = ids.map((id) => join(container, id)).find(pointsBack) ?? null;
  return { admin, common, named };
}

/** Whether `dir` is a git directory: a HEAD file and objects and refs folders. */
function gitDirectory(dir: string): boolean {
  try {
    return statSync(join(dir, 'HEAD')).isFile() && statSync(join(dir, 'objects')).isDirectory() && statSync(join(dir, 'refs')).isDirectory();
  } catch {
    return false;
  }
}

/** The data directory's entries to delete (relative paths) and those kept:
 * {@link RESET_KEEPS} and the user's worktrees in it, with the folders that
 * lead to them. */
function planDataDir(realData: string | null, protect: ReadonlySet<string>): { readonly remove: readonly string[]; readonly keep: readonly string[] } {
  const remove: string[] = [];
  const keep: string[] = [];
  if (realData === null) return { remove, keep };
  const kept = [...RESET_KEEPS, ...[...protect].map((path) => relative(realData, path).split(sep).join('/'))];
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(realData, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const entry = rel === '' ? name : `${rel}/${name}`;
      if (kept.includes(entry)) keep.push(entry);
      else if (kept.some((path) => path.startsWith(`${entry}/`)) && lstatSync(join(realData, entry)).isDirectory()) walk(entry);
      else remove.push(entry);
    }
  };
  walk('');
  return { remove, keep };
}

/** Delete a path without ever following a link: a folder (by lstat) is
 * emptied and removed, anything else (a link included) is unlinked. */
function removeNoFollow(path: string): void {
  if (lstatSync(path).isDirectory()) {
    for (const name of readdirSync(path)) removeNoFollow(join(path, name));
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
}

function printPlan(
  deps: ResetCliDeps, config: GruCommandConfig, options: ResetOptions, repos: readonly RepoPlan[], others: OtherLanes, ctx: PlanContext,
  data: { readonly remove: readonly string[]; readonly keep: readonly string[] },
): void {
  deps.stdout('gru-service reset will:');
  for (const repo of repos) {
    deps.stdout(`  in ${repo.name} (${repo.path}):`);
    deps.stdout(repo.lanes.length === 0 ? '    remove no lane (none is registered)' : `    remove ${String(repo.lanes.length)} GC lane(s) (git worktree remove --force --force): ${repo.lanes.map((lane) => lane.path).join(', ')}`);
    deps.stdout(repo.userPrunable.length === 0 ? '    run git worktree prune' : `    skip git worktree prune (it would also drop your own worktree(s) whose folder is missing: ${repo.userPrunable.join(', ')})`);
    if (options.deleteBranches) {
      deps.stdout(repo.branches.length === 0 ? '    delete no gru/* branch (there is none)' : `    delete gru/* branches: ${repo.branches.join(', ')}`);
      for (const { branch, tree } of repo.checkedOut) deps.stdout(`    keep ${branch} (checked out in your worktree ${tree})`);
    } else {
      deps.stdout('    keep gru/* branches (--delete-branches deletes them)');
    }
    if (options.deleteRefs) deps.stdout(repo.refs.length === 0 ? '    delete no refs/gru/* ref (there is none)' : `    delete refs/gru/* refs: ${repo.refs.join(', ')}`);
    else deps.stdout('    keep refs/gru/* refs, GC\'s saved snapshots (--delete-refs deletes them)');
  }
  if (others.lanes.length + others.left.length > 0) {
    deps.stdout('  lanes of repositories that are not managed, or not available now:');
    for (const lane of others.lanes) {
      deps.stdout(lane.at === null ? `    delete the lane folder ${lane.path} (${lane.repo} does not register it)` : `    remove the lane ${lane.path} from ${lane.repo} (git worktree remove --force --force)`);
    }
    for (const { path, reason } of others.left) deps.stdout(`    cannot remove the lane ${path}: ${reason}; the data directory is then left as it is`);
  }
  deps.stdout(`  in the data directory ${config.dataDir}:`);
  deps.stdout(data.remove.length === 0 ? '    delete nothing (it holds nothing else)' : `    delete: ${data.remove.join(', ')}`);
  deps.stdout(`    keep: ${data.keep.length === 0 ? 'nothing (config.toml is not there)' : data.keep.join(', ')}`);
  for (const path of ctx.protect) deps.stdout(`    (${path} is a worktree or folder of your own: it is kept)`);
  for (const [what, root] of [['lane root', config.worktrees.root], ['preserve root', config.worktrees.preserveRoot]] as const) {
    if (ctx.realData === null || !within(ctx.realData, real(root))) deps.stdout(`    (the ${what} ${root} lies outside the data directory and is left as it is)`);
  }
  deps.stdout('Your own branches, worktrees and files are not touched.');
}

function git(args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const run = spawnSync('git', [...args], { encoding: 'utf-8', env: { ...repositoryGitEnv(false), GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? (run.error === undefined ? '' : String(run.error)) };
}
