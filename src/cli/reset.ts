import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
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
 * 1. refuses while the service runs (something listens on its port, or its
 *    `/health` answers), naming how to stop it;
 * 2. lists what it will do;
 * 3. with `--yes`, or a confirmation at the terminal:
 *    - in each managed repository, removes every registered GC lane (a
 *      worktree under `[worktrees] root`) with `git worktree remove --force`
 *      (twice forced for a lane git holds locked), then runs
 *      `git worktree prune`, unless that would also drop a worktree of the
 *      user's own whose folder is missing (then it says so and skips it);
 *    - deletes `gru/*` branches only with `--delete-branches` (`git branch
 *      -D`; one a worktree of the user's has checked out is kept, named),
 *      and `refs/gru/*` only with `--delete-refs`;
 *    - deletes the data directory's contents except `config.toml` and the
 *      install's own files ({@link RESET_KEEPS}), keeping the directory.
 *
 * It prints what it removed. It never touches the user's own branches,
 * worktrees or files: a data directory that holds the workspace, a managed
 * repository or the home directory is refused, and a lane removal that
 * fails leaves the data directory as it was.
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
          lane from each managed repository (git worktree remove --force, then
          git worktree prune) and empties the data directory except
          config.toml and the install's own files. The service must be
          stopped. It lists what it will do and asks first.

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
  /** The install's own code: never deleted. */
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

/** One GC lane registered in a managed repository. */
interface LanePlan {
  readonly path: string;
  readonly locked: boolean;
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

  // 1. Never while the service runs.
  const running = await serviceRunning(config, deps);
  if (running !== null) {
    deps.stderr(`gru-service reset: refused: ${running}. ${STOP_HINT}`);
    return 1;
  }
  const refusal = dataDirRefusal(config, deps);
  if (refusal !== null) {
    deps.stderr(`gru-service reset: refused: ${refusal}`);
    return 1;
  }

  // 2. What it will do.
  const repos: RepoPlan[] = [];
  for (const name of config.managedRepos) {
    const resolved = resolveManagedRepoPathSync(config.workspaceRoot, name);
    if (resolved.kind !== 'available') {
      deps.stdout(`skipped ${name}: ${resolved.kind === 'unavailable' ? resolved.reason : resolved.error}`);
      continue;
    }
    try {
      repos.push(planRepo(name, resolved.path, config, options));
    } catch (error) {
      deps.stderr(`gru-service reset: refused: ${name} (${resolved.path}) cannot be read: ${String((error as Error).message)}`);
      return 1;
    }
  }
  const data = planDataDir(config.dataDir, deps.packageRoot);
  printPlan(deps, config, options, repos, data);

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

  let failed = false;
  for (const repo of repos) {
    for (const lane of repo.lanes) {
      const removed = git(repo.path, ['worktree', 'remove', '--force', ...(lane.locked ? ['--force'] : []), lane.path]);
      if (removed.status === 0) deps.stdout(`removed lane ${lane.path} from ${repo.name}`);
      else {
        failed = true;
        deps.stderr(`gru-service reset: lane ${lane.path} could not be removed from ${repo.name}: ${removed.stderr.trim()}`);
      }
    }
    if (repo.userPrunable.length === 0) {
      const pruned = git(repo.path, ['worktree', 'prune']);
      if (pruned.status !== 0) deps.stderr(`gru-service reset: git worktree prune failed in ${repo.name}: ${pruned.stderr.trim()}`);
    } else {
      deps.stdout(`skipped git worktree prune in ${repo.name}: it would also drop your own worktree(s) whose folder is missing: ${repo.userPrunable.join(', ')}`);
    }
    for (const branch of repo.branches) {
      // `git branch -D` refuses a branch checked out anywhere, a lane included.
      const deleted = git(repo.path, ['branch', '-D', branch]);
      if (deleted.status === 0) deps.stdout(`deleted branch ${branch} in ${repo.name}`);
      else deps.stderr(`gru-service reset: branch ${branch} in ${repo.name} was kept: ${deleted.stderr.trim()}`);
    }
    for (const ref of repo.refs) {
      const deleted = git(repo.path, ['update-ref', '-d', ref]);
      if (deleted.status === 0) deps.stdout(`deleted ref ${ref} in ${repo.name}`);
      else deps.stderr(`gru-service reset: ref ${ref} in ${repo.name} was kept: ${deleted.stderr.trim()}`);
    }
  }
  if (failed) {
    deps.stderr(`gru-service reset: a lane could not be removed, so the data directory ${config.dataDir} was left as it was; fix what held it and run reset again.`);
    return 1;
  }
  for (const entry of data.remove) {
    try {
      rmSync(join(config.dataDir, entry), { recursive: true, force: true });
      deps.stdout(`deleted ${join(config.dataDir, entry)}`);
    } catch (error) {
      failed = true;
      deps.stderr(`gru-service reset: ${join(config.dataDir, entry)} could not be deleted: ${String((error as Error).message)}`);
    }
  }
  if (failed) return 1;
  deps.stdout(`reset done: ${config.dataDir} keeps ${data.keep.length === 0 ? 'nothing else' : data.keep.join(', ')}. Start the service with ./install.sh --service (or npm start).`);
  return 0;
}

/** Why the service counts as running, or null when it is stopped. */
async function serviceRunning(config: GruCommandConfig, deps: ResetCliDeps): Promise<string | null> {
  const port = config.server.port;
  if (port === 0) return 'the instance binds an ephemeral port (port = 0), so reset cannot tell whether the service runs';
  const host = dialHost(config.server.host);
  const owners = await deps.probeListeners(host, port);
  if (owners !== null && owners.length > 0) {
    return `the service is running: ${owners.map((owner) => `pid ${String(owner.pid)}${owner.command === '' ? '' : ` (${owner.command})`}`).join(', ')} listens on port ${String(port)}`;
  }
  try {
    const res = await deps.fetchFn(`http://${host}:${String(port)}/health`, { method: 'GET', signal: AbortSignal.timeout(2_000) });
    return `the service is running: http://${host}:${String(port)}/health answered (HTTP ${String(res.status)})`;
  } catch {
    return null;
  }
}

/** Why emptying the data directory would touch the user's own files, or null. */
function dataDirRefusal(config: GruCommandConfig, deps: ResetCliDeps): string | null {
  if (!existsSync(config.dataDir)) return null;
  const data = realpathSync(config.dataDir);
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const holds = (path: string): boolean => {
    const rel = relative(data, real(path));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  if (data === '/' || data === real(deps.homeDir)) return `the data directory ${config.dataDir} is ${data === '/' ? 'the file system root' : 'your home directory'}`;
  if (holds(config.workspaceRoot)) return `the data directory ${config.dataDir} holds the workspace root ${config.workspaceRoot}`;
  for (const name of config.managedRepos) {
    if (holds(join(config.workspaceRoot, name))) return `the data directory ${config.dataDir} holds the managed repository ${name}`;
  }
  return null;
}

function planRepo(name: string, path: string, config: GruCommandConfig, options: ResetOptions): RepoPlan {
  const listing = git(path, ['worktree', 'list', '--porcelain', '-z']);
  if (listing.status !== 0) throw new Error(`git worktree list failed: ${listing.stderr.trim()}`);
  const roots = [config.worktrees.root];
  try {
    roots.push(realpathSync(config.worktrees.root));
  } catch {
    // no lane root on disk: only its spelling can match
  }
  const underRoot = (tree: string): boolean => roots.some((root) => {
    const rel = relative(root, tree);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
  const lanes: LanePlan[] = [];
  const userPrunable: string[] = [];
  /** Branches the user's own worktrees (the repository's checkout included) have checked out. */
  const userBranches = new Map<string, string>();
  // Records are NUL-separated fields, each record ended by an empty field;
  // the first is the repository's own checkout.
  const records = listing.stdout.split('\0\0').map((record) => record.split('\0').filter((field) => field !== '')).filter((fields) => fields.length > 0);
  for (const [index, fields] of records.entries()) {
    const tree = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
    if (tree === undefined) continue;
    if (index > 0 && underRoot(tree)) {
      lanes.push({ path: tree, locked: fields.some((field) => field === 'locked' || field.startsWith('locked ')) });
      continue;
    }
    const branch = fields.find((field) => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);
    if (branch !== undefined) userBranches.set(branch, tree);
    if (index > 0 && fields.some((field) => field === 'prunable' || field.startsWith('prunable '))) userPrunable.push(tree);
  }
  const listRefs = (pattern: string, format: string): string[] => {
    const run = git(path, ['for-each-ref', `--format=${format}`, pattern]);
    if (run.status !== 0) throw new Error(`git for-each-ref ${pattern} failed: ${run.stderr.trim()}`);
    return run.stdout.split('\n').filter((line) => line !== '');
  };
  const gruBranches = options.deleteBranches ? listRefs('refs/heads/gru/', '%(refname:short)') : [];
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

/** The data directory's entries to delete (relative paths) and those kept. */
function planDataDir(dataDir: string, packageRoot: string): { readonly remove: readonly string[]; readonly keep: readonly string[] } {
  const remove: string[] = [];
  const keep: string[] = [];
  const install = (() => {
    try {
      return realpathSync(packageRoot);
    } catch {
      return packageRoot;
    }
  })();
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(dataDir, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const entry = rel === '' ? name : `${rel}/${name}`;
      const full = join(dataDir, entry);
      const holdsInstall = (() => {
        const inner = relative(full, install);
        return inner === '' || (!inner.startsWith('..') && !isAbsolute(inner));
      })();
      if (RESET_KEEPS.includes(entry) || holdsInstall) {
        keep.push(entry);
      } else if (RESET_KEEPS.some((kept) => kept.startsWith(`${entry}/`)) && lstatSync(full).isDirectory()) {
        walk(entry);
      } else {
        remove.push(entry);
      }
    }
  };
  walk('');
  return { remove, keep };
}

function printPlan(deps: ResetCliDeps, config: GruCommandConfig, options: ResetOptions, repos: readonly RepoPlan[], data: { readonly remove: readonly string[]; readonly keep: readonly string[] }): void {
  deps.stdout('gru-service reset will:');
  for (const repo of repos) {
    deps.stdout(`  in ${repo.name} (${repo.path}):`);
    deps.stdout(repo.lanes.length === 0 ? '    remove no lane (none is registered)' : `    remove ${String(repo.lanes.length)} GC lane(s) (git worktree remove --force): ${repo.lanes.map((lane) => lane.path).join(', ')}`);
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
  deps.stdout(`  in the data directory ${config.dataDir}:`);
  deps.stdout(data.remove.length === 0 ? '    delete nothing (it holds nothing else)' : `    delete: ${data.remove.join(', ')}`);
  deps.stdout(`    keep: ${data.keep.length === 0 ? 'nothing (config.toml is not there)' : data.keep.join(', ')}`);
  for (const [what, root] of [['lane root', config.worktrees.root], ['preserve root', config.worktrees.preserveRoot]] as const) {
    const rel = relative(config.dataDir, root);
    if (rel.startsWith('..') || isAbsolute(rel)) deps.stdout(`    (the ${what} ${root} lies outside the data directory and is left as it is)`);
  }
  deps.stdout('Your own branches, worktrees and files are not touched.');
}

function git(repoPath: string, args: readonly string[]): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const run = spawnSync('git', [...args], { cwd: repoPath, encoding: 'utf-8', env: { ...repositoryGitEnv(false), GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? (run.error === undefined ? '' : String(run.error)) };
}
