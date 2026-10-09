import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import { parse } from 'smol-toml';
import type { RuntimeId } from '../config.js';
import {
  loadBundledBmadRuntime,
  materializeBmadRuntime,
  PACKAGE_ROOT,
  skillLauncherCommand,
  type BundledBmadRuntime,
} from '../bmad/runtime.js';
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

/** Settings the bundled skills read; each must resolve to a string. */
const STRING_SETTINGS = new Set([
  'core.communication_language',
  'core.document_output_language',
  'core.output_folder',
  'modules.bmm.planning_artifacts',
  'modules.bmm.implementation_artifacts',
  'modules.bmm.project_knowledge',
]);

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
const LEGACY_ANSWER_REPAIR_HINT =
  'Move that setting into _bmad/custom/config.toml (team) or config.user.toml (personal) — docs/BMAD-RUNTIME.md ' +
  '"Retiring a repo-local install" does this for every answer — then re-run the wizard';

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

function readSettingsLayer(repoPath: string, rel: string): Record<string, unknown> {
  // Settings are project state: never read through a link out of the repo.
  assertNoSymlinkComponents(repoPath, rel);
  const path = join(repoPath, rel);
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile()) {
    throw new BmadDeterministicSetupError(`project BMAD settings path is not a file: ${path}`, SETTINGS_REPAIR_HINT);
  }
  // Read OUTSIDE the parse catch (gh-32 r1): a read/IO failure stays a
  // plain transient error; only UNPARSEABLE content is deterministic.
  const text = readFileSync(path, 'utf-8');
  try {
    return parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new BmadDeterministicSetupError(`project BMAD settings file is malformed: ${path}: ${String(error)}`, SETTINGS_REPAIR_HINT);
  }
}

/** Every scalar leaf as `dotted.path → value` (arrays are not settings). */
function scalarSettings(data: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (typeof data !== 'object' || data === null || Array.isArray(data) || data instanceof Date) return out;
  for (const [key, value] of Object.entries(data)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)) {
      for (const [nested, leaf] of scalarSettings(value, path)) out.set(nested, leaf);
    } else if (!Array.isArray(value)) {
      out.set(path, value);
    }
  }
  return out;
}

/** Later layers win, as in the renderer's structural merge. */
function effectiveSettings(layers: readonly Record<string, unknown>[]): Map<string, unknown> {
  const merged = new Map<string, unknown>();
  for (const layer of layers) for (const [path, value] of scalarSettings(layer)) merged.set(path, value);
  return merged;
}

function sameSetting(left: unknown, right: unknown): boolean {
  return left instanceof Date && right instanceof Date ? left.getTime() === right.getTime() : left === right;
}

interface ProjectSettings {
  /** Repo-relative output folders to create. */
  readonly outputs: readonly string[];
}

/**
 * Validate the project's settings the way the runtime's renderer will read
 * them — GC defaults, then `_bmad/custom/config.toml`, then
 * `config.user.toml` — so provisioning never reports ready for a project
 * whose first render would halt: every `_bmad/custom/*.toml` must parse,
 * the settings the bundled skills use must be strings, and a legacy
 * installer answer the runtime no longer reads must not differ from the
 * effective value (it would be silently dropped otherwise).
 */
function projectSettings(repoPath: string, runtime: BundledBmadRuntime): ProjectSettings {
  const defaults = runtime.files.get('config/defaults.toml');
  if (defaults === undefined) throw new Error(`bundled BMAD runtime ${runtime.id} lacks config/defaults.toml`);
  assertNoSymlinkComponents(repoPath, '_bmad/custom');
  const customDir = join(repoPath, '_bmad', 'custom');
  if (existsSync(customDir) && lstatSync(customDir).isDirectory()) {
    for (const name of readdirSync(customDir).filter((entry) => entry.endsWith('.toml')).sort()) {
      readSettingsLayer(repoPath, `_bmad/custom/${name}`);
    }
  }
  const effective = effectiveSettings([
    parse(defaults.toString('utf-8')) as Record<string, unknown>,
    readSettingsLayer(repoPath, '_bmad/custom/config.toml'),
    readSettingsLayer(repoPath, '_bmad/custom/config.user.toml'),
  ]);
  for (const [path, value] of effective) {
    if (STRING_SETTINGS.has(path) && typeof value !== 'string') {
      throw new BmadDeterministicSetupError(
        `project BMAD setting \`${path}\` must be a string, got ${JSON.stringify(value)}`,
        SETTINGS_REPAIR_HINT,
      );
    }
  }
  const legacy = effectiveSettings([
    readSettingsLayer(repoPath, '_bmad/config.toml'),
    readSettingsLayer(repoPath, '_bmad/config.user.toml'),
  ]);
  for (const [path, value] of legacy) {
    if (effective.has(path) && !sameSetting(effective.get(path), value)) {
      throw new BmadDeterministicSetupError(
        `legacy BMAD installer answer \`${path}\` = ${JSON.stringify(value)} differs from the effective value ` +
          `${JSON.stringify(effective.get(path))}; the GC-managed runtime does not read installer answers, so builds would stop`,
        LEGACY_ANSWER_REPAIR_HINT,
      );
    }
  }
  const outputs: string[] = [];
  for (const path of OUTPUT_SETTINGS) {
    const value = effective.get(path.join('.'));
    if (typeof value !== 'string') continue;
    const resolved = value.split('{project-root}').join(repoPath);
    if (!isAbsolute(resolved) || !insideOrEqual(repoPath, resolved) || resolved === repoPath) continue;
    outputs.push(relative(repoPath, resolved).split('\\').join('/'));
  }
  return { outputs };
}

interface ProvisionReport {
  readonly created: string[];
  readonly kept: string[];
}

/**
 * Refuse a target (or any existing ancestor below the repo root) that is a
 * link or the wrong kind of entry — checked for EVERY target before the
 * first write, so a refusal never leaves a half-provisioned repo behind.
 */
function assertTarget(repoPath: string, rel: string, kind: 'directory' | 'file'): void {
  assertNoSymlinkComponents(repoPath, rel);
  const parts = rel.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    const path = join(repoPath, ...parts.slice(0, index));
    if (!existsSync(path)) return;
    const wanted = index === parts.length ? kind : 'directory';
    const info = lstatSync(path);
    if (wanted === 'directory' ? !info.isDirectory() : !info.isFile()) {
      throw new BmadDeterministicSetupError(`BMAD project path exists but is not a ${wanted}: ${path}`);
    }
  }
}

function ensureDirectory(repoPath: string, rel: string, report: ProvisionReport): void {
  const path = join(repoPath, rel);
  if (existsSync(path)) {
    report.kept.push(rel);
    return;
  }
  mkdirSync(path, { recursive: true });
  report.created.push(rel);
}

function ensureFile(repoPath: string, rel: string, content: string, report: ProvisionReport): void {
  const path = join(repoPath, rel);
  if (existsSync(path)) {
    report.kept.push(rel);
    return;
  }
  // 'wx': never replace a file that appeared since the check.
  writeFileSync(path, content, { encoding: 'utf-8', flag: 'wx' });
  report.created.push(rel);
}

/** A kept `_bmad/render/.gitignore` must still keep rendered snapshots out of git. */
function assertRenderIgnored(repoPath: string): void {
  if (!existsSync(join(repoPath, '_bmad', 'render', '.gitignore'))) return;
  // Probe the render directory itself: an ignore file that only names some
  // files (say `workflow.md`) would still let other snapshots through.
  const probe = spawnSync('git', ['-C', repoPath, 'check-ignore', '-q', '--no-index', '_bmad/render/bmad-build/'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (probe.error !== undefined || (probe.status !== 0 && probe.status !== 1)) {
    throw new Error(`git check-ignore failed in ${repoPath}: ${probe.error?.message ?? probe.stderr}; retry or skip this repo`);
  }
  if (probe.status === 1) {
    throw new BmadDeterministicSetupError(
      `existing ${join(repoPath, '_bmad', 'render', '.gitignore')} does not ignore rendered workflow snapshots`,
      'Make that file ignore everything (a single `*` line) or delete it so provisioning recreates it, then re-run the wizard',
    );
  }
}

/**
 * Create the project-local state the GC-managed runtime uses. Idempotent:
 * an existing path is validated and kept byte-for-byte, never rewritten.
 */
export function provisionBmadProject(repoPath: string, runtime: BundledBmadRuntime): ProvisionReport {
  const report: ProvisionReport = { created: [], kept: [] };
  const { outputs } = projectSettings(repoPath, runtime);
  const targets: Array<[string, 'directory' | 'file', string?]> = [
    ['_bmad', 'directory'],
    ['_bmad/custom', 'directory'],
    ['_bmad/custom/.gitignore', 'file', BMAD_CUSTOM_GITIGNORE],
    ['_bmad/render', 'directory'],
    ['_bmad/render/.gitignore', 'file', BMAD_RENDER_GITIGNORE],
    ...outputs.map((rel): [string, 'directory'] => [rel, 'directory']),
  ];
  for (const [rel, kind] of targets) assertTarget(repoPath, rel, kind);
  for (const skill of runtime.manifest.skills) assertNoSymlinkComponents(repoPath, `_bmad/render/${skill}`);
  assertRenderIgnored(repoPath);
  try {
    for (const [rel, kind, content] of targets) {
      if (kind === 'directory') ensureDirectory(repoPath, rel, report);
      else ensureFile(repoPath, rel, content!, report);
    }
    renderCheck(repoPath, runtime);
  } catch (error) {
    // A refusal leaves the repo as it found it: undo this run's creations.
    for (const rel of [...report.created].reverse()) {
      const path = join(repoPath, rel);
      try {
        if (lstatSync(path).isDirectory()) rmdirSync(path);
        else rmSync(path, { force: true });
      } catch {
        // A directory the render check filled stays; it is derived output.
      }
    }
    throw error;
  }
  return report;
}

/**
 * The authoritative readiness proof: run every bundled skill's own launcher
 * against the repo, exactly as a build would. A HALT is the project's
 * unchanged state (deterministic); a launcher that cannot run is tooling
 * (transient). The runtime is composed in a throwaway store.
 */
function renderCheck(repoPath: string, runtime: BundledBmadRuntime): void {
  const store = mkdtempSync(join(tmpdir(), 'gru-command-bmad-check-'));
  try {
    const materialized = materializeBmadRuntime(runtime, store);
    for (const skill of materialized.skills) {
      const launcher = skillLauncherCommand(materialized, skill, repoPath);
      const result = spawnSync('/bin/sh', ['-c', launcher.command], {
        cwd: repoPath,
        encoding: 'utf-8',
        env: { ...process.env, ...launcher.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      const halt = /^HALT: (.+)$/mu.exec(result.stdout ?? '');
      if (result.status === 1 && halt?.[1] !== undefined) {
        throw new BmadDeterministicSetupError(
          `the bundled BMAD runtime cannot render ${skill} for this repo: ${halt[1]}`,
          SETTINGS_REPAIR_HINT,
        );
      }
      if (result.status !== 0 || !/^read and follow \/.+\/workflow\.md$/mu.test(result.stdout ?? '')) {
        throw new Error(
          `the bundled BMAD runtime did not run for ${skill} (${result.error?.message ?? `exit ${String(result.status)}`}): ` +
            `${output.slice(-500)}; check uv and retry, or skip this repo`,
        );
      }
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
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
