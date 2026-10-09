import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import { parse } from 'smol-toml';
import type { RuntimeId } from '../config.js';
import { loadBundledBmadRuntime, PACKAGE_ROOT, type BundledBmadRuntime } from '../bmad/runtime.js';
import type { BmadRepoAction, WizardAnswers } from './answers.js';

/**
 * Per-selected-repo BMAD provisioning (issue #283).
 *
 * Gru Command ships the BMAD framework itself (the GC-managed runtime,
 * src/bmad/runtime.ts); a managed repository keeps only its own state.
 * Provisioning creates the project-local locations the runtime uses —
 * `_bmad/custom/` for project settings, a self-ignoring `_bmad/render/`
 * for rendered snapshots, and the configured output folders — and never
 * modifies anything that already exists. A legacy repo-local BMAD install
 * is left exactly as it is; retiring it is a documented, owner-run step
 * (docs/BMAD-RUNTIME.md), never a side effect of onboarding.
 */

/** Matches the ignore file the runtime's renderer writes on demand. */
export const BMAD_RENDER_GITIGNORE =
  '# Rendered BMAD workflow snapshots (derived output of the Gru Command\n' +
  '# BMAD runtime). Never commit them.\n' +
  '*\n';
export const BMAD_CUSTOM_GITIGNORE =
  '# Personal BMAD overrides stay local; team settings are committed.\n' +
  '*.user.toml\n';

/** Output-location settings provisioning creates when they resolve inside the repo. */
const OUTPUT_SETTINGS = [
  ['core', 'output_folder'],
  ['modules', 'bmm', 'planning_artifacts'],
  ['modules', 'bmm', 'implementation_artifacts'],
] as const;

export interface BmadRepoResult {
  readonly repo: string;
  readonly action: BmadRepoAction;
  readonly ready: boolean;
  readonly message: string;
  /** The runtime the repo was provisioned for (ready results only). */
  readonly runtimeId?: string;
  /**
   * True only when `ready === false` and the failure is deterministic
   * (gh-32): it validated unchanged on-disk state, so retrying re-runs the
   * identical check and fails identically. The wizard must offer skip-only
   * plus the deliberate repair path, never another identical retry.
   * Absent for transient failures (prerequisites, I/O, a broken product
   * install), which keep the retry/skip offer.
   */
  readonly deterministic?: true;
  /** Class-specific deliberate repair guidance for deterministic failures. */
  readonly repairHint?: string;
}

const SYMLINK_REPAIR_HINT =
  'Replace the symlinked path with a real directory deliberately (keep a copy of anything you need), then re-run the wizard';
const SETTINGS_REPAIR_HINT = 'Fix the reported project BMAD settings file deliberately, then re-run the wizard';

/**
 * A provisioning failure caused by unchanged on-disk repo state (a symlinked
 * or wrongly typed project path, a malformed settings file, a refused repo
 * selection). A retry cannot change the outcome; skip stays available.
 * Read/IO and tool-availability failures are NOT this class.
 */
export class BmadDeterministicSetupError extends Error {
  /** Class-specific deliberate repair guidance; omitted when the message itself carries it. */
  readonly repairHint?: string;

  constructor(message: string, repairHint?: string) {
    super(message);
    this.name = 'BmadDeterministicSetupError';
    this.repairHint = repairHint;
  }
}

export interface BmadOnboardingOptions {
  readonly workspaceRoot: string;
  readonly answers: WizardAnswers;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam; production performs real bounded --version probes. */
  readonly prerequisiteCheck?: (
    command: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
  ) => boolean;
  /** Test seam; production verifies the bundle this package ships. */
  readonly runtime?: () => BundledBmadRuntime;
}

function insideOrEqual(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The PRODUCTION prerequisite probe (real spawnSync --version). Exported
 * for the failure-matrix acceptance: the failure classes must exercise the
 * real probe, not only the test seam.
 */
export function commandAvailable(command: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  const result = spawnSync(command, ['--version'], {
    cwd,
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 10_000,
  });
  return result.error === undefined && result.status === 0;
}

export function bmadToolsForAnswers(answers: WizardAnswers): string[] {
  const runtimes = new Set<RuntimeId>([answers.runtime, ...Object.values(answers.roles)]);
  const tools: string[] = [];
  if (runtimes.has('pi')) tools.push('pi');
  if (runtimes.has('claude-code')) tools.push('claude-code');
  return tools;
}

function assertPrerequisites(
  tools: readonly string[],
  env: NodeJS.ProcessEnv,
  repoPath: string,
  check: (command: string, env: NodeJS.ProcessEnv, cwd: string) => boolean,
): void {
  // uv runs the bundled renderer; the runtime CLIs host the sessions.
  const commands = ['git', 'uv', ...tools.map((tool) => (tool === 'claude-code' ? 'claude' : tool))];
  const missing = commands.filter((command) => !check(command, env, repoPath));
  if (missing.length > 0) {
    throw new Error(
      `missing BMAD prerequisite(s): ${missing.join(', ')}. Install them, then retry; or skip this repo`,
    );
  }
}

function assertNoSymlinkComponents(base: string, relativePath: string): void {
  let current = base;
  for (const part of relativePath.split('/').filter(Boolean)) {
    current = join(current, part);
    // lstat, not existsSync: existsSync follows links, so a DANGLING
    // symlink reads as absent and the refusal would be skipped for exactly
    // the link class it exists to catch. ENOENT/ENOTDIR end the walk;
    // other I/O errors (EACCES, EIO) stay transient.
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new BmadDeterministicSetupError(`refusing BMAD project path through symlink: ${current}`, SYMLINK_REPAIR_HINT);
    }
  }
}

function validateRepo(
  workspaceRoot: string,
  repoName: string,
  env: NodeJS.ProcessEnv,
): string {
  const workspace = realpathSync(workspaceRoot);
  const candidate = join(workspace, repoName);
  if (!existsSync(candidate)) {
    throw new BmadDeterministicSetupError(`selected repo no longer exists: ${candidate}`);
  }
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new BmadDeterministicSetupError(
      `selected repo is a symlink; refusing BMAD writes outside the workspace: ${candidate}`,
    );
  }
  const repoPath = realpathSync(candidate);
  if (!insideOrEqual(workspace, repoPath) || repoPath === workspace) {
    throw new BmadDeterministicSetupError(`selected repo escapes the workspace root: ${candidate}`);
  }
  if (!existsSync(join(repoPath, '.git'))) {
    throw new BmadDeterministicSetupError(`selected directory is not a Git repo: ${repoPath}`);
  }
  const gitRoot = spawnSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  // A spawn failure, signal, timeout or empty output is tool availability,
  // not repo state: it keeps the retry/skip offer. A clean non-zero exit is
  // deterministic and diagnosed truthfully; the wizard never edits Git
  // config, ownership, or credentials itself.
  if (gitRoot.error !== undefined || gitRoot.signal !== null || gitRoot.status === null) {
    const detail = gitRoot.error !== undefined
      ? gitRoot.error.message
      : `terminated by signal ${gitRoot.signal ?? 'unknown'}`;
    throw new Error(
      `git probe failed for ${repoPath}: ${detail}; ensure Git runs on this host, then retry or skip this repo`,
    );
  }
  if (gitRoot.status !== 0) {
    const refusal =
      `${String(gitRoot.stderr ?? '')} ${String(gitRoot.stdout ?? '')}`.toLowerCase();
    if (
      /dubious ownership|safe\.directory|unable to read config|bad config|config file .*permission/.test(
        refusal,
      )
    ) {
      throw new BmadDeterministicSetupError(
        `git refused to resolve this repository (Git ownership/config condition): ${repoPath}; ` +
          'repair the reported Git state deliberately (for example its ownership or safe.directory configuration), then re-run the wizard or choose skip',
      );
    }
    throw new BmadDeterministicSetupError(`selected directory is not a usable Git repo: ${repoPath}`);
  }
  if (gitRoot.stdout.trim() === '') {
    throw new Error(
      `git reported no repository root for ${repoPath}; retry or skip this repo`,
    );
  }
  let actualRoot: string;
  try {
    actualRoot = realpathSync(gitRoot.stdout.trim());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new BmadDeterministicSetupError(`selected Git repo reported an invalid top-level path: ${repoPath}`);
    }
    // EACCES/EIO and friends can recover between attempts — stay transient.
    throw error;
  }
  if (actualRoot !== repoPath) {
    throw new BmadDeterministicSetupError(`selected directory is not the Git repository root: ${repoPath}`);
  }
  return repoPath;
}

function readSettingsLayer(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  // Read OUTSIDE the parse catch (gh-32 r1): a read/IO failure stays a
  // plain transient error; only UNPARSEABLE content is deterministic.
  const text = readFileSync(path, 'utf-8');
  try {
    return parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new BmadDeterministicSetupError(`project BMAD settings file is malformed: ${path}: ${String(error)}`, SETTINGS_REPAIR_HINT);
  }
}

function settingAt(layers: readonly Record<string, unknown>[], path: readonly string[]): unknown {
  let found: unknown;
  for (const layer of layers) {
    let current: unknown = layer;
    for (const part of path) {
      current = typeof current === 'object' && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)[part]
        : undefined;
    }
    if (current !== undefined) found = current;
  }
  return found;
}

/**
 * Output folders from the same layers the runtime's renderer reads (GC
 * defaults, then `_bmad/custom/config.toml`, then `config.user.toml`).
 * Only locations that resolve inside the repository are created.
 */
function outputLocations(repoPath: string, runtime: BundledBmadRuntime): string[] {
  const defaults = runtime.files.get('config/defaults.toml');
  if (defaults === undefined) throw new Error(`bundled BMAD runtime ${runtime.id} lacks config/defaults.toml`);
  const layers = [
    parse(defaults.toString('utf-8')) as Record<string, unknown>,
    readSettingsLayer(join(repoPath, '_bmad', 'custom', 'config.toml')),
    readSettingsLayer(join(repoPath, '_bmad', 'custom', 'config.user.toml')),
  ];
  const locations: string[] = [];
  for (const path of OUTPUT_SETTINGS) {
    const value = settingAt(layers, path);
    if (typeof value !== 'string' || !value.includes('{project-root}')) continue;
    const resolved = value.split('{project-root}').join(repoPath);
    if (!isAbsolute(resolved) || !insideOrEqual(repoPath, resolved) || resolved === repoPath) continue;
    locations.push(relative(repoPath, resolved).split('\\').join('/'));
  }
  return locations;
}

interface ProvisionReport {
  readonly created: string[];
  readonly kept: string[];
}

function ensureDirectory(repoPath: string, rel: string, report: ProvisionReport): void {
  assertNoSymlinkComponents(repoPath, rel);
  const path = join(repoPath, rel);
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory()) {
      throw new BmadDeterministicSetupError(`BMAD project path exists but is not a directory: ${path}`);
    }
    report.kept.push(rel);
    return;
  }
  mkdirSync(path, { recursive: true });
  report.created.push(rel);
}

function ensureFile(repoPath: string, rel: string, content: string, report: ProvisionReport): void {
  assertNoSymlinkComponents(repoPath, rel);
  const path = join(repoPath, rel);
  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) {
      throw new BmadDeterministicSetupError(`BMAD project path exists but is not a file: ${path}`);
    }
    report.kept.push(rel);
    return;
  }
  // 'wx': never replace a file that appeared since the check.
  writeFileSync(path, content, { encoding: 'utf-8', flag: 'wx' });
  report.created.push(rel);
}

/**
 * Create the project-local state the GC-managed runtime uses. Idempotent:
 * an existing path is validated and kept byte-for-byte, never rewritten.
 */
export function provisionBmadProject(repoPath: string, runtime: BundledBmadRuntime): ProvisionReport {
  const report: ProvisionReport = { created: [], kept: [] };
  // Validate every target before the first write, so a refusal never leaves
  // a half-provisioned repo behind.
  const outputs = outputLocations(repoPath, runtime);
  for (const rel of ['_bmad', '_bmad/custom', '_bmad/custom/.gitignore', '_bmad/render', '_bmad/render/.gitignore', ...outputs]) {
    assertNoSymlinkComponents(repoPath, rel);
  }
  ensureDirectory(repoPath, '_bmad', report);
  ensureDirectory(repoPath, '_bmad/custom', report);
  ensureFile(repoPath, '_bmad/custom/.gitignore', BMAD_CUSTOM_GITIGNORE, report);
  ensureDirectory(repoPath, '_bmad/render', report);
  ensureFile(repoPath, '_bmad/render/.gitignore', BMAD_RENDER_GITIGNORE, report);
  for (const rel of outputs) ensureDirectory(repoPath, rel, report);
  return report;
}

function legacyInstallNote(repoPath: string): string {
  const legacy = [
    join('_bmad', '_config', 'manifest.yaml'),
    join('.gru-command', 'bmad-install.json'),
  ].filter((rel) => existsSync(join(repoPath, rel)));
  return legacy.length === 0
    ? ''
    : '; legacy repo-local BMAD install left unchanged (GC builds no longer use it) — ' +
        'retire it with docs/BMAD-RUNTIME.md "Retiring a repo-local install"';
}

export function onboardBmadRepo(
  repoName: string,
  action: BmadRepoAction,
  options: BmadOnboardingOptions,
): BmadRepoResult {
  if (action === 'skip') {
    return { repo: repoName, action, ready: false, message: 'skipped by explicit per-repo choice' };
  }
  const env = { ...process.env, ...options.env };
  const tools = bmadToolsForAnswers(options.answers);
  try {
    const repoPath = validateRepo(options.workspaceRoot, repoName, env);
    assertPrerequisites(tools, env, repoPath, options.prerequisiteCheck ?? commandAvailable);
    const runtime = (options.runtime ?? (() => loadBundledBmadRuntime(PACKAGE_ROOT)))();
    const report = provisionBmadProject(repoPath, runtime);
    return {
      repo: repoName,
      action,
      ready: true,
      runtimeId: runtime.id,
      message:
        `GC-managed BMAD runtime ${runtime.id}; ` +
        `created ${report.created.length > 0 ? report.created.join(', ') : 'nothing'}` +
        `${report.kept.length > 0 ? `; kept existing ${report.kept.join(', ')}` : ''}` +
        legacyInstallNote(repoPath),
    };
  } catch (error) {
    return {
      repo: repoName,
      action,
      ready: false,
      message: String((error as Error).message),
      deterministic: error instanceof BmadDeterministicSetupError ? true : undefined,
      repairHint: error instanceof BmadDeterministicSetupError ? error.repairHint : undefined,
    };
  }
}
