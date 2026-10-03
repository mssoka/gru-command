import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import type { RuntimeId } from '../config.js';
import type { BmadRepoAction, WizardAnswers } from './answers.js';

export const BMAD_INSTALLER_VERSION = '6.12.0';
export const BMAD_DEFAULT_MODULES = ['bmm', 'cis', 'tea', 'gds'] as const;
export const BMAD_MODULE_PINS = {
  cis: 'v0.3.2',
  tea: 'v1.27.2',
  gds: 'v0.7.2',
} as const;

const RECORD_PATH = join('.gru-command', 'bmad-install.json');
const BOOTSTRAP_PATH = join('.gru-command', 'bmad-bootstrap.mjs');
const WORKTREE_MANIFEST_PATH = join('.gru-command', 'worktree.toml');
const BLOCK_START = '# BEGIN GRU COMMAND BMAD BOOTSTRAP';
const BLOCK_END = '# END GRU COMMAND BMAD BOOTSTRAP';
const EXCLUDE_START = '# BEGIN GRU COMMAND BMAD GENERATED';
const EXCLUDE_END = '# END GRU COMMAND BMAD GENERATED';
const BOOTSTRAP_MARKER = '// Managed by Gru Command BMAD bootstrap v1';

export interface BmadModuleVersion {
  readonly name: string;
  readonly version: string;
}

export interface BmadManifestSummary {
  readonly installerVersion: string;
  readonly modules: readonly BmadModuleVersion[];
  readonly tools: readonly string[];
}

type RuntimeSkillMap = Readonly<Record<string, readonly string[]>>;

interface InstalledBmad {
  readonly text: string;
  readonly summary: BmadManifestSummary;
  readonly runtimeSkills: RuntimeSkillMap;
}

export interface BmadRepoResult {
  readonly repo: string;
  readonly action: BmadRepoAction;
  readonly ready: boolean;
  readonly message: string;
  readonly recordPath?: string;
  /**
   * True only when `ready === false` and the failure is deterministic
   * (gh-32): it validated unchanged on-disk state, so retrying re-runs the
   * identical check and fails identically. The wizard must offer skip-only
   * plus the deliberate repair path, never another identical retry.
   * Absent for transient failures (prerequisites, installer
   * network/download), which keep the retry/skip offer.
   */
  readonly deterministic?: true;
  /**
   * Class-specific deliberate repair guidance for deterministic failures
   * (carried over from `BmadDeterministicSetupError.repairHint`); the
   * wizard renders it, falling back to neutral repair wording when a class
   * message already carries its own context.
   */
  readonly repairHint?: string;
}

/**
 * Install-state deterministic failures keep the deliberate repair/update
 * path the issue names (gh-32): the OFFICIAL installer, run by the user —
 * never an automatic overwrite or upgrade by the wizard.
 */
const INSTALLER_REPAIR_HINT =
  'Fix deliberately by running `npx bmad-method install` in that repo, then re-run the wizard';
/**
 * "BMAD already exists" is preserved, not repaired: the deliberate path is a
 * fresh wizard run choosing reuse, because installer overwrite/upgrade is
 * exactly what the guard refuses. Exported so the headless renderer can
 * name the answers.bmad.<repo> value the noninteractive mode actually
 * offers instead of pointing at an interactive prompt it does not have.
 */
export const REUSE_REPAIR_HINT =
  'Re-run the wizard and choose reuse to preserve the existing install';
/**
 * A symlinked ENTRY under a runtime skills root is not necessarily an
 * installer-managed binding: foreign user-owned entries get this neutral
 * deliberate fix (remove or replace the entry), while the official-installer
 * hint is reserved for proven managed module/binding causes — the installer
 * would not remove a foreign symlink either.
 */
const FOREIGN_SKILL_ENTRY_HINT =
  'Remove or replace the symlinked skill entry deliberately, then re-run the wizard';

/**
 * A BMAD setup failure caused by unchanged on-disk repo state (a manifest
 * declaring a missing/unsafe/escaping module directory, a runtime-binding
 * mismatch, a malformed existing manifest/record, a refused unsafe path).
 * A retry cannot change the outcome — the class-specific `repairHint` (or
 * the wizard's neutral fallback) names the deliberate repair, and skip
 * stays available. Read/IO and tool-availability failures are NOT this
 * class: they stay plain `Error`s and keep the retry/skip offer.
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
  readonly run?: typeof spawnSync;
  /** Test seam; production performs real bounded --version probes. */
  readonly prerequisiteCheck?: (
    command: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
  ) => boolean;
}

function insideOrEqual(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function tail(text: string, max = 2_000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

/**
 * The PRODUCTION prerequisite probe (real spawnSync --version). Exported
 * for the BMAD failure-matrix acceptance: the failure classes must exercise
 * the real probe, not only the test seam, so deleting either guard fails
 * the suite.
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

function requiredRuntimeCommands(tools: readonly string[]): string[] {
  return tools.map((tool) => (tool === 'claude-code' ? 'claude' : tool));
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
  const missing = ['node', 'npx', 'git', 'uv', ...requiredRuntimeCommands(tools)].filter(
    (command) => !check(command, env, repoPath),
  );
  if (missing.length > 0) {
    throw new Error(
      `missing BMAD prerequisite(s): ${missing.join(', ')}. Install them, then retry; or skip this repo`,
    );
  }
}

/** Parse the small stable subset of the official installer manifest we consume. */
export function parseBmadManifest(text: string, source: string): BmadManifestSummary {
  let section = '';
  let installerVersion = '';
  const modules: Array<{ name?: string; version?: string }> = [];
  const tools: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^[A-Za-z_][\w-]*:$/.test(line)) {
      section = line.slice(0, -1);
      continue;
    }
    if (section === 'installation') {
      const match = /^version:\s*(.+)$/.exec(line);
      if (match?.[1] !== undefined) installerVersion = match[1].trim().replace(/^['"]|['"]$/g, '');
    } else if (section === 'modules') {
      const name = /^-\s+name:\s*(.+)$/.exec(line)?.[1];
      if (name !== undefined) {
        modules.push({ name: name.trim().replace(/^['"]|['"]$/g, '') });
        continue;
      }
      const version = /^version:\s*(.+)$/.exec(line)?.[1];
      if (version !== undefined && modules.length > 0) {
        modules[modules.length - 1]!.version = version.trim().replace(/^['"]|['"]$/g, '');
      }
    } else if (section === 'ides') {
      const tool = /^-\s+(.+)$/.exec(line)?.[1];
      if (tool !== undefined) tools.push(tool.trim().replace(/^['"]|['"]$/g, ''));
    }
  }
  if (installerVersion === '' || modules.length === 0) {
    throw new Error(`existing BMAD manifest is malformed: ${source}`);
  }
  const completeModules = modules.map((entry) => {
    if (entry.name === undefined || entry.version === undefined || entry.version === '') {
      throw new Error(`existing BMAD manifest has an incomplete module entry: ${source}`);
    }
    return { name: entry.name, version: entry.version };
  });
  if (new Set(completeModules.map((entry) => entry.name)).size !== completeModules.length) {
    throw new Error(`existing BMAD manifest has duplicate modules: ${source}`);
  }
  return { installerVersion, modules: completeModules, tools };
}

function manifestFor(repoPath: string): { text: string; summary: BmadManifestSummary } | null {
  const path = join(repoPath, '_bmad', '_config', 'manifest.yaml');
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8');
  return { text, summary: parseBmadManifest(text, path) };
}

/**
 * Read an EXISTING install's manifest for reuse. A manifest that fails
 * PARSE validation is unchanged on-disk state (gh-32) — a retry re-parses
 * the same bytes and fails identically — so parse failures are
 * deterministic with the installer repair path. Read/IO failures are
 * recoverable (permissions or interference can change between attempts)
 * and stay transient, as do fresh-installer outputs via manifestFor.
 */
function existingManifestFor(repoPath: string): { text: string; summary: BmadManifestSummary } | null {
  const path = join(repoPath, '_bmad', '_config', 'manifest.yaml');
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8');
  try {
    return { text, summary: parseBmadManifest(text, path) };
  } catch (error) {
    throw new BmadDeterministicSetupError((error as Error).message, INSTALLER_REPAIR_HINT);
  }
}

function assertNoPartialInstall(repoPath: string): void {
  const suspicious = [
    join(repoPath, '_bmad'),
    join(repoPath, '.agents', 'skills', 'bmad-build'),
    join(repoPath, '.claude', 'skills', 'bmad-build'),
  ];
  if (suspicious.some((path) => existsSync(path))) {
    throw new BmadDeterministicSetupError(
      'partial BMAD installation detected without a valid _bmad/_config/manifest.yaml; preserve it and repair or choose skip',
    );
  }
}

function expectedFreshModules(summary: BmadManifestSummary): void {
  const actual = new Map(summary.modules.map((entry) => [entry.name, entry.version]));
  const expected = new Map<string, string>([
    ['core', BMAD_INSTALLER_VERSION],
    ['bmm', BMAD_INSTALLER_VERSION],
    ...Object.entries(BMAD_MODULE_PINS),
  ]);
  if (actual.size !== expected.size) {
    throw new Error(`official BMAD install returned unexpected module set: ${[...actual.keys()].join(',')}`);
  }
  for (const [name, version] of expected) {
    if (actual.get(name) !== version) {
      throw new Error(
        `official BMAD install version drift for ${name}: expected ${version}, got ${actual.get(name) ?? 'missing'}`,
      );
    }
  }
}

function assertNoSymlinkComponents(base: string, relativePath: string, repairHint?: string): void {
  let current = base;
  for (const part of relativePath.split('/').filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) {
      throw new BmadDeterministicSetupError(`refusing BMAD path through symlink: ${current}`, repairHint);
    }
  }
}

function runtimeSkillsRoot(repoPath: string, tool: string): string {
  return join(repoPath, tool === 'claude-code' ? '.claude' : '.agents', 'skills');
}

function markdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

/**
 * bmad-method 6.12.0 emits legacy short config tokens into both BMM and
 * GDS installs. With all four approved modules those names are ambiguous,
 * so fresh generated skill copies are qualified to their owning module.
 * Existing/customized installs are never patched by reuse.
 */
function qualifyFreshSkillConfig(
  repoPath: string,
  tools: readonly string[],
  runtimeSkills: RuntimeSkillMap,
): number {
  const keys = ['planning_artifacts', 'implementation_artifacts', 'project_knowledge'];
  let replacements = 0;
  let buildQualified = false;
  for (const tool of tools) {
    const runtimeRoot = runtimeSkillsRoot(repoPath, tool);
    for (const skillName of runtimeSkills[tool] ?? []) {
      const module = skillName.startsWith('gds-') ? 'gds' : 'bmm';
      for (const file of markdownFiles(join(runtimeRoot, skillName))) {
        const original = readFileSync(file, 'utf-8');
        let next = original;
        for (const key of keys) {
          const token = `{{.${key}}}`;
          const qualified = `{{config.modules.${module}.${key}}}`;
          const count = next.split(token).length - 1;
          if (count > 0) {
            next = next.split(token).join(qualified);
            replacements += count;
            if (skillName === 'bmad-build' && key === 'implementation_artifacts') {
              buildQualified = true;
            }
          }
        }
        if (next !== original) atomicWrite(file, next, statSync(file).mode & 0o777);
      }
    }
  }
  if (!buildQualified) {
    throw new Error(
      'pinned BMAD install did not expose the expected bmad-build config token; refusing an unverified compatibility patch',
    );
  }
  return replacements;
}

function verifyModuleDirectories(repoPath: string, summary: BmadManifestSummary): void {
  assertNoSymlinkComponents(repoPath, '_bmad', INSTALLER_REPAIR_HINT);
  for (const module of summary.modules) {
    const path = join(repoPath, '_bmad', module.name);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) {
      throw new BmadDeterministicSetupError(
        `BMAD manifest declares missing or unsafe module directory: ${path}`,
        INSTALLER_REPAIR_HINT,
      );
    }
    if (!insideOrEqual(repoPath, realpathSync(path))) {
      throw new BmadDeterministicSetupError(
        `BMAD module directory escapes selected repo: ${path}`,
        INSTALLER_REPAIR_HINT,
      );
    }
  }
}

function verifySkills(repoPath: string, tools: readonly string[]): void {
  for (const tool of tools) {
    const root = tool === 'claude-code' ? '.claude' : '.agents';
    assertNoSymlinkComponents(repoPath, `${root}/skills/bmad-build`, INSTALLER_REPAIR_HINT);
    const skill = join(repoPath, root, 'skills', 'bmad-build', 'SKILL.md');
    if (!existsSync(skill) || lstatSync(skill).isSymbolicLink() || !statSync(skill).isFile()) {
      throw new BmadDeterministicSetupError(
        `BMAD ${tool} binding is missing required bmad-build skill: ${skill}`,
        INSTALLER_REPAIR_HINT,
      );
    }
    if (!insideOrEqual(repoPath, realpathSync(skill))) {
      throw new BmadDeterministicSetupError(
        `BMAD ${tool} binding escapes selected repo: ${skill}`,
        INSTALLER_REPAIR_HINT,
      );
    }
  }
}

function verifyNoAmbiguousSkillConfig(
  repoPath: string,
  tools: readonly string[],
  summary: BmadManifestSummary,
  runtimeSkills?: RuntimeSkillMap,
): void {
  const modules = new Set(summary.modules.map((module) => module.name));
  if (!modules.has('bmm') || !modules.has('gds')) return;
  for (const tool of tools) {
    const runtimeRoot = runtimeSkillsRoot(repoPath, tool);
    const roots = runtimeSkills === undefined
      ? [runtimeRoot]
      : (runtimeSkills[tool] ?? []).map((skill) => join(runtimeRoot, skill));
    for (const root of roots) {
      for (const file of markdownFiles(root)) {
        const text = readFileSync(file, 'utf-8');
        for (const key of ['planning_artifacts', 'implementation_artifacts', 'project_knowledge']) {
          if (text.includes(`{{.${key}}}`)) {
            throw new BmadDeterministicSetupError(
              `existing BMAD binding has ambiguous BMM/GDS config token in ${file}; ` +
                'reuse preserved it unchanged, so repair or deliberately reinstall before marking ready',
              INSTALLER_REPAIR_HINT,
            );
          }
        }
      }
    }
  }
}

function officialInstallerArgs(directory: string, tools: readonly string[]): string[] {
  return [
    '--yes',
    `bmad-method@${BMAD_INSTALLER_VERSION}`,
    'install',
    '--directory',
    directory,
    '--modules',
    BMAD_DEFAULT_MODULES.join(','),
    '--pin',
    `cis=${BMAD_MODULE_PINS.cis}`,
    '--pin',
    `tea=${BMAD_MODULE_PINS.tea}`,
    '--pin',
    `gds=${BMAD_MODULE_PINS.gds}`,
    '--tools',
    tools.join(','),
    '--yes',
    '--no-shims',
  ];
}

function runOfficialInstaller(
  directory: string,
  tools: readonly string[],
  env: NodeJS.ProcessEnv,
  run: typeof spawnSync,
): void {
  const result = run('npx', officialInstallerArgs(directory, tools), {
    cwd: directory,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`official BMAD installer failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `official BMAD installer exited ${result.status ?? 'by signal'}; retry this repo or skip it\n` +
        tail(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
    );
  }
}

/**
 * Validate DISPOSABLE preflight output (gh-32 r1): the stage directory is
 * deleted in `finally` and the repo is untouched, so an unsafe GENERATED
 * binding is a transient installer-output failure — a new attempt can
 * produce valid output — even though the safety refusal itself stands.
 * Existing-repo validation keeps its deterministic classification.
 */
/**
 * Fresh-installer OUTPUT that fails validation is not unchanged user
 * state: the official installer can produce different bytes on a re-run,
 * so these failures stay transient — retry re-runs the installer (the
 * spec's fresh-install output contract). Validation of unchanged bytes on
 * the reuse path keeps its deterministic classification.
 */
function asTransientInstallerOutput(error: unknown): never {
  if (error instanceof BmadDeterministicSetupError) {
    throw new Error(
      `official BMAD installer output failed validation: ${(error as Error).message}; retry this repo or skip`,
    );
  }
  throw error;
}

/** The staging path is deleted in finally and must never leak into
 * user-facing text: only the sanitized cause text is carried out. */
function withoutStagingPath(message: string, stage: string): string {
  return message
    .split(`${stage}/`)
    .join('')
    .split(stage)
    .join('')
    .trim();
}

function preflightSkillNames(stage: string, tool: string): string[] {
  try {
    return runtimeSkillNames(stage, tool);
  } catch (error) {
    // EVERY thrown value passes through the staging-path hygiene, not only
    // the refusal branch: a plain read/IO failure while inspecting the
    // disposable stage must not name a path that no longer exists.
    const detail = withoutStagingPath(
      error instanceof Error ? error.message : String(error),
      stage,
    );
    if (error instanceof BmadDeterministicSetupError) {
      // Keep the refusal class: an unsafe staged binding is deterministic
      // installer preflight output, never a retryable condition.
      throw new Error(
        `official BMAD preflight produced an unsafe skill binding${detail === '' ? '' : `: ${detail}`}; retry this repo or skip`,
      );
    }
    // Plain read/IO failures keep their transient class (the staging install
    // can succeed on a re-run) with a message a stranger can act on.
    throw new Error(
      `official BMAD preflight failed${detail === '' ? '' : `: ${detail}`}; retry this repo or skip`,
    );
  }
}

/** Fresh-install runtime skill scan. These entries are INSTALLER OUTPUT
 * (the official installer just ran over the repo): a refusal it produced is
 * transient installer validation, never a deterministic user-state verdict
 * — the same classification the post-install checks below keep. The repo's
 * PRE-install entries were already scanned by the caller and keep theirs. */
function freshRuntimeSkills(
  repoPath: string,
  tools: readonly string[],
  beforeSkills: Record<string, string[]>,
): Record<string, string[]> {
  try {
    return Object.fromEntries(
      tools.map((tool) => {
        const before = new Set(beforeSkills[tool] ?? []);
        return [tool, runtimeSkillNames(repoPath, tool).filter((name) => !before.has(name))];
      }),
    ) as Record<string, string[]>;
  } catch (error) {
    asTransientInstallerOutput(error);
  }
}

function installFresh(
  repoPath: string,
  tools: readonly string[],
  env: NodeJS.ProcessEnv,
  run: typeof spawnSync,
): InstalledBmad {
  assertNoPartialInstall(repoPath);
  const beforeSkills = Object.fromEntries(
    tools.map((tool) => [tool, runtimeSkillNames(repoPath, tool)]),
  ) as Record<string, string[]>;

  // Discover the exact pinned install's output names in an isolated staging
  // directory before allowing the official installer to touch the repo.
  const stage = mkdtempSync(join(tmpdir(), 'gru-command-bmad-preflight-'));
  try {
    runOfficialInstaller(stage, tools, env, run);
    const staged = manifestFor(stage);
    if (staged === null) throw new Error('official BMAD preflight wrote no manifest');
    expectedFreshModules(staged.summary);
    for (const tool of tools) {
      const generated = preflightSkillNames(stage, tool);
      const collisions = generated.filter((name) => beforeSkills[tool]?.includes(name));
      if (collisions.length > 0) {
        throw new Error(
          `fresh BMAD install would overwrite existing ${tool} skill(s): ${collisions.join(', ')}; ` +
            'preserve them and choose skip, or move them before retrying',
        );
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  runOfficialInstaller(repoPath, tools, env, run);
  const installed = manifestFor(repoPath);
  if (installed === null) throw new Error('official BMAD installer reported success but wrote no manifest');
  expectedFreshModules(installed.summary);
  const actualTools = new Set(installed.summary.tools);
  if (tools.some((tool) => !actualTools.has(tool))) {
    throw new Error(`official BMAD installer omitted requested tool binding(s): ${tools.join(',')}`);
  }
  const runtimeSkills = freshRuntimeSkills(repoPath, tools, beforeSkills);
  for (const tool of tools) {
    if (!runtimeSkills[tool]?.includes('bmad-build')) {
      throw new Error(`official BMAD installer did not create an isolated bmad-build binding for ${tool}`);
    }
  }
  qualifyFreshSkillConfig(repoPath, tools, runtimeSkills);
  try {
    verifyModuleDirectories(repoPath, installed.summary);
    verifySkills(repoPath, tools);
    verifyNoAmbiguousSkillConfig(repoPath, tools, installed.summary, runtimeSkills);
  } catch (error) {
    asTransientInstallerOutput(error);
  }
  return { ...installed, runtimeSkills };
}

function atomicWrite(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing to replace symlink: ${path}`);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf-8', mode, flag: 'wx' });
    renameSync(tmp, path);
    chmodSync(path, mode);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function managedBlock(
  original: string,
  start: string,
  end: string,
  body: readonly string[],
): string {
  const startAt = original.indexOf(start);
  const endAt = original.indexOf(end);
  if ((startAt === -1) !== (endAt === -1) || (startAt !== -1 && endAt < startAt)) {
    // Unpaired/reversed managed markers are unchanged on-disk state: a
    // retry re-reads the same bytes and fails identically, so this is a
    // deterministic skip-only refusal (gh-32), not a retryable write.
    throw new BmadDeterministicSetupError(
      `malformed managed block: expected paired ${start} / ${end}`,
    );
  }
  const block = `${start}\n${body.join('\n')}\n${end}`;
  if (startAt !== -1) {
    return `${original.slice(0, startAt)}${block}${original.slice(endAt + end.length)}`;
  }
  const prefix = original === '' || original.endsWith('\n') ? original : `${original}\n`;
  return `${prefix}${prefix === '' ? '' : '\n'}${block}\n`;
}

function runtimeSkillNames(repoPath: string, tool: string, repairHint?: string): string[] {
  const rootName = tool === 'claude-code' ? '.claude' : '.agents';
  assertNoSymlinkComponents(repoPath, `${rootName}/skills`, repairHint);
  const root = runtimeSkillsRoot(repoPath, tool);
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) {
    throw new BmadDeterministicSetupError(`BMAD skill root is not a directory: ${root}`, repairHint);
  }
  const names: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new BmadDeterministicSetupError(
        `BMAD skill binding is a symlink: ${path}`,
        FOREIGN_SKILL_ENTRY_HINT,
      );
    }
    if (entry.isDirectory()) names.push(entry.name);
  }
  return names.sort();
}

function observedBmadSkills(repoPath: string, tools: readonly string[]): RuntimeSkillMap {
  return Object.fromEntries(
    tools.map((tool) => [
      tool,
      runtimeSkillNames(repoPath, tool, INSTALLER_REPAIR_HINT).filter((name) => /^(?:bmad|gds|tea|cis)-/.test(name)),
    ]),
  );
}

function validatedSkillPath(repoPath: string, tool: string, skill: string): string {
  if (tool !== 'pi' && tool !== 'claude-code') {
    throw new BmadDeterministicSetupError(`unsafe BMAD runtime tool: ${tool}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skill) || skill === '.' || skill === '..') {
    throw new BmadDeterministicSetupError(`unsafe BMAD recorded skill name: ${skill}`);
  }
  const root = runtimeSkillsRoot(repoPath, tool);
  const path = join(root, skill);
  assertNoSymlinkComponents(repoPath, relative(repoPath, path), INSTALLER_REPAIR_HINT);
  // Resolve each operand in its own guarded step so a missing repository,
  // skills root, or recorded binding is reported for the object that
  // actually disappeared (all three are unchanged on-disk state).
  const resolveReal = (target: string, missingMessage: string, hint?: string): string => {
    try {
      return realpathSync(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new BmadDeterministicSetupError(missingMessage, hint);
      }
      throw error;
    }
  };
  const realRepo = resolveReal(repoPath, `BMAD repository directory is missing: ${repoPath}`);
  const realRoot = resolveReal(
    root,
    `BMAD ${tool} skills root is missing: ${root}`,
    INSTALLER_REPAIR_HINT,
  );
  const realSkill = resolveReal(
    path,
    `BMAD recorded skill binding is missing: ${path}`,
    INSTALLER_REPAIR_HINT,
  );
  if (!insideOrEqual(realRepo, realRoot) || !insideOrEqual(realRoot, realSkill) ||
      !lstatSync(path).isDirectory()) {
    throw new BmadDeterministicSetupError(`unsafe BMAD recorded skill path: ${path}`);
  }
  return path;
}

function hashOwnedPayload(repoPath: string, runtimeSkills: RuntimeSkillMap, includeDerived = false): string {
  const hash = createHash('sha256');
  const visit = (path: string): void => {
    const relativePath = relative(repoPath, path);
    // The renderer and Python bytecode caches are derived output, not the
    // pinned executable/configuration source. Never include or copy them.
    if (!includeDerived && (relativePath === '_bmad/render' ||
        (relativePath.startsWith('_bmad/') && relativePath.split('/').includes('__pycache__')))) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new BmadDeterministicSetupError(`BMAD owned payload contains symlink: ${path}`);
    if (info.isDirectory()) {
      hash.update(`d\0${relativePath}\0`);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (info.isFile()) {
      hash.update(`f\0${relativePath}\0`);
      hash.update(readFileSync(path));
      hash.update('\0');
    } else {
      throw new BmadDeterministicSetupError(`BMAD owned payload contains unsupported entry: ${path}`);
    }
  };
  visit(join(repoPath, '_bmad'));
  for (const tool of Object.keys(runtimeSkills).sort()) {
    for (const skill of [...(runtimeSkills[tool] ?? [])].sort()) {
      visit(validatedSkillPath(repoPath, tool, skill));
    }
  }
  return hash.digest('hex');
}

function updateLocalExclude(
  repoPath: string,
  tools: readonly string[],
  runtimeSkills: RuntimeSkillMap,
  env: NodeJS.ProcessEnv,
): void {
  const gitPath = spawnSync('git', ['-C', repoPath, 'rev-parse', '--git-path', 'info/exclude'], {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (gitPath.status !== 0 || gitPath.stdout.trim() === '') {
    throw new Error(`cannot resolve Git local exclude for ${repoPath}`);
  }
  const rawPath = gitPath.stdout.trim();
  const excludePath = isAbsolute(rawPath) ? rawPath : resolve(repoPath, rawPath);
  const original = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
  const lines = [
    '/_bmad/_config/',
    '/_bmad/core/',
    '/_bmad/bmm/',
    '/_bmad/cis/',
    '/_bmad/tea/',
    '/_bmad/gds/',
    '/_bmad/render/',
    '/_bmad/scripts/',
  ];
  for (const tool of tools) {
    const root = tool === 'claude-code' ? '.claude' : '.agents';
    for (const skill of runtimeSkills[tool] ?? []) lines.push(`/${root}/skills/${skill}/`);
  }
  atomicWrite(excludePath, managedBlock(original, EXCLUDE_START, EXCLUDE_END, lines));
}

const BOOTSTRAP_SOURCE = `#!/usr/bin/env node
${BOOTSTRAP_MARKER}
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
const childEnv = { ...process.env };
const root = realpathSync(process.cwd());
const sourceRaw = execFileSync('git', ['config', '--local', '--get', 'gru-command.bmad-source'], { encoding: 'utf-8', env: childEnv }).trim();
if (!sourceRaw) throw new Error('missing git-local gru-command.bmad-source; rerun Gru Command BMAD onboarding');
const source = realpathSync(sourceRaw);
const common = (dir) => realpathSync(execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf-8', env: childEnv }).trim());
if (common(root) !== common(source)) throw new Error('BMAD bootstrap source belongs to a different Git repository');
if (root === source) process.exit(0);
const inside = (base, child) => { const rel = relative(base, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
// lstat sees dangling symlinks that existsSync follows and misses.
const lstatIfPresent = (path) => {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const assertSafeDestination = (to) => {
  const target = resolve(to);
  if (!inside(root, target)) throw new Error('BMAD bootstrap destination escapes worktree: ' + to);
  let current = root;
  for (const part of relative(root, target).split('/').filter(Boolean)) {
    current = join(current, part);
    if (lstatIfPresent(current)?.isSymbolicLink()) {
      throw new Error('BMAD bootstrap refuses destination symlink: ' + current);
    }
  }
};
const copyTree = (from, to) => {
  const unresolved = resolve(from);
  if (!inside(source, unresolved)) throw new Error('BMAD bootstrap source escapes the selected repo: ' + from);
  // Only these lexical derived-cache paths are excluded. All other entries
  // still pass through the source symlink and realpath confinement checks.
  const rel = relative(source, unresolved);
  if (rel === '_bmad/render' ||
      (rel.startsWith('_bmad/') && rel.split('/').includes('__pycache__'))) return;
  const unresolvedInfo = lstatSync(unresolved);
  if (unresolvedInfo.isSymbolicLink()) throw new Error('BMAD bootstrap refuses source symlink: ' + from);
  const src = realpathSync(unresolved);
  if (!inside(source, src)) throw new Error('BMAD bootstrap source escapes the selected repo: ' + from);
  const info = lstatSync(src);
  assertSafeDestination(to);
  if (info.isDirectory()) {
    const dest = lstatIfPresent(to);
    if (dest && !dest.isDirectory()) throw new Error('BMAD bootstrap destination collision: ' + to);
    if (!dest) mkdirSync(to, { recursive: true, mode: 0o700 });
    // Never alter a directory already present in the lane: it may contain
    // private, unrelated files. New directories stay private until complete.
    for (const name of readdirSync(src)) copyTree(join(src, name), join(to, name));
    if (!dest) chmodSync(to, info.mode & 0o777);
    return;
  }
  if (!info.isFile()) throw new Error('BMAD bootstrap supports only files/directories: ' + from);
  const dest = lstatIfPresent(to);
  if (dest) {
    if (!dest.isFile() || dest.isSymbolicLink()) throw new Error('BMAD bootstrap destination collision: ' + to);
    if (!readFileSync(src).equals(readFileSync(to))) throw new Error('BMAD bootstrap destination differs from source: ' + to);
    return;
  }
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  cpSync(src, to, { errorOnExist: true, force: false });
};
const record = JSON.parse(readFileSync(join(root, '.gru-command', 'bmad-install.json'), 'utf-8'));
const sourceManifest = readFileSync(join(source, '_bmad', '_config', 'manifest.yaml'));
const sourceHash = createHash('sha256').update(sourceManifest).digest('hex');
if (sourceHash !== record.official_manifest_sha256) throw new Error('BMAD bootstrap source manifest changed since onboarding');
if (record.source_payload_format !== undefined && record.source_payload_format !== 'without-derived-caches-v1') {
  throw new Error('BMAD bootstrap record has unsupported source payload format');
}
// Validate ALL recorded bindings before hashing any owned payload. A record
// cannot use a relative skill name or symlinked ancestor to read outside it.
const skillPaths = [];
for (const tool of Object.keys(record.runtime_skills ?? {}).sort()) {
  if (tool !== 'pi' && tool !== 'claude-code') throw new Error('BMAD bootstrap record has unsafe runtime tool: ' + tool);
  const dir = tool === 'claude-code' ? '.claude' : '.agents';
  const names = record.runtime_skills[tool];
  if (!Array.isArray(names)) throw new Error('BMAD bootstrap record has invalid skills for ' + tool);
  const skillsRoot = join(source, dir, 'skills');
  for (const name of [...names].sort()) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name === '..') {
      throw new Error('BMAD bootstrap record has unsafe skill name for ' + tool);
    }
    const path = join(skillsRoot, name);
    for (const part of [join(source, dir), skillsRoot, path]) {
      if (lstatSync(part).isSymbolicLink()) throw new Error('BMAD bootstrap refuses source skill symlink: ' + part);
    }
    if (!inside(realpathSync(skillsRoot), realpathSync(path)) || !lstatSync(path).isDirectory()) {
      throw new Error('BMAD bootstrap record has unsafe skill path: ' + path);
    }
    skillPaths.push(path);
  }
}
const hashPayload = () => {
  const hash = createHash('sha256');
  const visit = (path) => {
    const relativePath = relative(source, path);
    // Old records still verify against the full payload until explicitly refreshed.
    if (record.source_payload_format === 'without-derived-caches-v1' &&
        (relativePath === '_bmad/render' ||
          (relativePath.startsWith('_bmad/') && relativePath.split('/').includes('__pycache__')))) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('BMAD owned payload contains symlink: ' + path);
    if (info.isDirectory()) {
      hash.update('d\\0' + relativePath + '\\0');
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (info.isFile()) {
      hash.update('f\\0' + relativePath + '\\0');
      hash.update(readFileSync(path));
      hash.update('\\0');
    } else throw new Error('BMAD owned payload contains unsupported entry: ' + path);
  };
  visit(join(source, '_bmad'));
  for (const path of skillPaths) visit(path);
  return hash.digest('hex');
};
if (hashPayload() !== record.source_payload_sha256) throw new Error('BMAD bootstrap source payload changed since onboarding');
copyTree(join(source, '_bmad'), join(root, '_bmad'));
for (const tool of record.tools) {
  const dir = tool === 'claude-code' ? '.claude' : '.agents';
  const skills = record.runtime_skills?.[tool];
  if (!Array.isArray(skills) || skills.length === 0) throw new Error('BMAD bootstrap record has no generated skills for ' + tool);
  for (const skillName of skills) {
    if (typeof skillName !== 'string' || skillName.includes('/') || skillName === '.' || skillName === '..') {
      throw new Error('BMAD bootstrap record has unsafe skill name for ' + tool);
    }
    copyTree(join(source, dir, 'skills', skillName), join(root, dir, 'skills', skillName));
  }
}
for (const module of record.modules) {
  const moduleDir = join(root, '_bmad', module.name);
  if (!existsSync(moduleDir)) throw new Error('BMAD bootstrap missing required module ' + module.name);
}
for (const tool of record.tools) {
  const dir = tool === 'claude-code' ? '.claude' : '.agents';
  const skill = join(root, dir, 'skills', 'bmad-build', 'SKILL.md');
  if (!existsSync(skill)) throw new Error('BMAD bootstrap missing bmad-build for ' + tool);
}
execFileSync('uv', ['--version'], { stdio: 'ignore', env: childEnv });
console.log('Gru Command BMAD bootstrap ready: ' + record.modules.map((m) => m.name + '@' + m.version).join(','));
`;

function updateWorktreeBootstrap(repoPath: string, env: NodeJS.ProcessEnv): void {
  const manifestPath = join(repoPath, WORKTREE_MANIFEST_PATH);
  const original = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf-8') : '';
  if (original !== '') {
    try {
      parse(original);
    } catch (error) {
      throw new BmadDeterministicSetupError(`existing worktree manifest is malformed: ${manifestPath}: ${String(error)}`);
    }
  }
  const next = managedBlock(original, BLOCK_START, BLOCK_END, [
    '[[setup]]',
    '# Fresh clones have no git-local BMAD source. Only onboarded repositories',
    '# run the generated copier; a configured but invalid source still fails loud.',
    'command = "if git config --local --get gru-command.bmad-source >/dev/null 2>&1; then node .gru-command/bmad-bootstrap.mjs; fi"',
  ]);
  const bootstrapPath = join(repoPath, BOOTSTRAP_PATH);
  if (existsSync(bootstrapPath) && !readFileSync(bootstrapPath, 'utf-8').includes(BOOTSTRAP_MARKER)) {
    throw new BmadDeterministicSetupError(`refusing to overwrite non-Gru BMAD bootstrap: ${bootstrapPath}`);
  }
  atomicWrite(bootstrapPath, BOOTSTRAP_SOURCE, 0o755);
  atomicWrite(manifestPath, next);
  const configured = spawnSync(
    'git',
    ['-C', repoPath, 'config', '--local', 'gru-command.bmad-source', repoPath],
    { encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (configured.status !== 0) throw new Error(`cannot record Git-local BMAD bootstrap source for ${repoPath}`);
}

function writeRecord(
  repoPath: string,
  manifestText: string,
  summary: BmadManifestSummary,
  tools: readonly string[],
  runtimeSkills: RuntimeSkillMap,
  fresh: boolean,
): string {
  const path = join(repoPath, RECORD_PATH);
  if (existsSync(path)) {
    const current = JSON.parse(readFileSync(path, 'utf-8')) as { managed_by?: unknown };
    if (current.managed_by !== 'gru-command') {
      throw new BmadDeterministicSetupError(`refusing to overwrite non-Gru BMAD record: ${path}`);
    }
  }
  const record = {
    managed_by: 'gru-command',
    installer: `bmad-method@${summary.installerVersion}`,
    default_modules: fresh ? [...BMAD_DEFAULT_MODULES] : [],
    pins: fresh ? BMAD_MODULE_PINS : {},
    modules: summary.modules,
    tools,
    runtime_skills: runtimeSkills,
    official_manifest_sha256: createHash('sha256').update(manifestText).digest('hex'),
    source_payload_sha256: payloadSha256ForFreshOrReuse(repoPath, runtimeSkills, fresh),
    source_payload_format: 'without-derived-caches-v1',
    compatibility_patches: fresh ? ['qualify-bmm-gds-short-config-tokens-v1'] : [],
  };
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** Existing-state hashing keeps its deterministic classification; a FRESH
 * record's payload is installer output, so its failures stay transient. */
function payloadSha256ForFreshOrReuse(
  repoPath: string,
  runtimeSkills: RuntimeSkillMap,
  fresh: boolean,
): string {
  try {
    return hashOwnedPayload(repoPath, runtimeSkills);
  } catch (error) {
    if (fresh) asTransientInstallerOutput(error);
    throw error;
  }
}

function assertControlFilesSafe(repoPath: string): void {
  const controlDir = join(repoPath, '.gru-command');
  if (existsSync(controlDir)) {
    const info = lstatSync(controlDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new BmadDeterministicSetupError(`refusing BMAD control writes through unsafe path: ${controlDir}`);
    }
  }
  for (const relativePath of [RECORD_PATH, BOOTSTRAP_PATH, WORKTREE_MANIFEST_PATH]) {
    const path = join(repoPath, relativePath);
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new BmadDeterministicSetupError(`refusing BMAD control write through unsafe path: ${path}`);
      }
    }
  }
  const recordPath = join(repoPath, RECORD_PATH);
  if (existsSync(recordPath)) {
    // Read OUTSIDE the parse catch (gh-32 r1): a read/IO failure is
    // recoverable (permissions can change between attempts) and stays a
    // plain transient error; only UNPARSEABLE content is deterministic.
    const recordText = readFileSync(recordPath, 'utf-8');
    let managedBy: unknown;
    try {
      managedBy = (JSON.parse(recordText) as { managed_by?: unknown }).managed_by;
    } catch {
      throw new BmadDeterministicSetupError(`existing BMAD record is malformed: ${recordPath}`);
    }
    if (managedBy !== 'gru-command') {
      throw new BmadDeterministicSetupError(`refusing to overwrite non-Gru BMAD record: ${recordPath}`);
    }
  }
  const bootstrapPath = join(repoPath, BOOTSTRAP_PATH);
  if (existsSync(bootstrapPath) && !readFileSync(bootstrapPath, 'utf-8').includes(BOOTSTRAP_MARKER)) {
    throw new BmadDeterministicSetupError(`refusing to overwrite non-Gru BMAD bootstrap: ${bootstrapPath}`);
  }
  const manifestPath = join(repoPath, WORKTREE_MANIFEST_PATH);
  if (existsSync(manifestPath)) {
    // Same split as the record above (gh-32 r1): read outside the parse
    // catch so a denied read stays transient, never "malformed".
    const manifestText = readFileSync(manifestPath, 'utf-8');
    try {
      parse(manifestText);
    } catch (error) {
      throw new BmadDeterministicSetupError(
        `existing worktree manifest is malformed: ${manifestPath}: ${String(error)}`,
      );
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
  // A spawn failure, signal, timeout (status null + error set) or empty
  // output is tool availability, not repo state: installing/unblocking git
  // and retrying can succeed, so it keeps the retry/skip offer — the same
  // availability class the prerequisite probe reports. A clean non-zero
  // exit stays deterministic, but it must be diagnosed truthfully: git also
  // refuses on ownership/config conditions whose deliberate fix is a
  // Git-state change, not a different directory. The wizard never edits
  // Git config, ownership, or credentials itself — the message names the
  // deliberate fix and skip stays available.
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
    assertControlFilesSafe(repoPath);
    assertNoSymlinkComponents(repoPath, '_bmad', INSTALLER_REPAIR_HINT);
    for (const tool of tools) runtimeSkillNames(repoPath, tool, INSTALLER_REPAIR_HINT);
    assertPrerequisites(tools, env, repoPath, options.prerequisiteCheck ?? commandAvailable);
    const existing = existingManifestFor(repoPath);
    let installed: InstalledBmad;
    let fresh = false;
    let verifiedLegacyRecord: Record<string, unknown> | undefined;
    if (action === 'install') {
      if (existing !== null) {
        throw new BmadDeterministicSetupError(
          'BMAD already exists; choose reuse to preserve it (automatic overwrite/upgrade is disabled)',
          REUSE_REPAIR_HINT,
        );
      }
      installed = installFresh(repoPath, tools, env, options.run ?? spawnSync);
      fresh = true;
    } else {
      if (existing === null) {
        assertNoPartialInstall(repoPath);
        throw new BmadDeterministicSetupError('reuse requested but no existing BMAD manifest was found');
      }
      // Validate the declared module directories BEFORE any record or
      // fingerprint work (gh-32 r1): an already-onboarded repo whose
      // declared module directory went missing/symlinked/escaping must be
      // classified with the official-installer repair hint even when the
      // payload fingerprint would also mismatch. Fingerprint validation is
      // NOT weakened — it runs unchanged, just after the directory check.
      verifyModuleDirectories(repoPath, existing.summary);
      let recordedSkills: RuntimeSkillMap | undefined;
      const priorRecord = join(repoPath, RECORD_PATH);
      if (existsSync(priorRecord)) {
        const prior = JSON.parse(readFileSync(priorRecord, 'utf-8')) as Record<string, unknown>;
        if (typeof prior.source_payload_sha256 !== 'string') {
          throw new BmadDeterministicSetupError(
            `existing BMAD record lacks a source payload fingerprint: ${priorRecord}`,
          );
        }
        const raw = prior.runtime_skills;
        if (raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          const parsed: Record<string, string[]> = {};
          for (const [tool, names] of Object.entries(raw)) {
            if ((tool !== 'pi' && tool !== 'claude-code') || !Array.isArray(names) ||
                names.some((name) => typeof name !== 'string')) {
              throw new BmadDeterministicSetupError(
                `existing BMAD record has invalid runtime_skills: ${priorRecord}`,
              );
            }
            for (const name of names as string[]) validatedSkillPath(repoPath, tool, name);
            parsed[tool] = [...names] as string[];
          }
          recordedSkills = parsed;
        }
        if (prior.source_payload_format !== undefined && prior.source_payload_format !== 'without-derived-caches-v1') {
          throw new BmadDeterministicSetupError('existing BMAD record has unsupported source payload format');
        }
        if (!recordedSkills ||
            hashOwnedPayload(repoPath, recordedSkills, prior.source_payload_format === undefined) !== prior.source_payload_sha256) {
          throw new BmadDeterministicSetupError(
            'BMAD source payload changed since onboarding; reuse cannot refresh an unverified fingerprint (including legacy render caches). Review source and re-onboard deliberately',
          );
        }
        if (prior.source_payload_format === undefined) verifiedLegacyRecord = prior;
      }
      const runtimeSkills = recordedSkills ?? observedBmadSkills(repoPath, existing.summary.tools);
      installed = { ...existing, runtimeSkills };
      // Module directories were already validated above, before the
      // fingerprint refusal; installed.summary === existing.summary here.
      verifySkills(repoPath, installed.summary.tools);
      verifyNoAmbiguousSkillConfig(
        repoPath,
        installed.summary.tools,
        installed.summary,
        runtimeSkills,
      );
      const existingTools = new Set(installed.summary.tools);
      const missingBindings = tools.filter((tool) => !existingTools.has(tool));
      if (missingBindings.length > 0) {
        throw new BmadDeterministicSetupError(
          `existing BMAD install lacks selected runtime binding(s): ${missingBindings.join(', ')}; ` +
            'reuse will not modify it—choose skip or deliberately update it with the official installer',
          INSTALLER_REPAIR_HINT,
        );
      }
    }

    if (fresh) updateLocalExclude(repoPath, installed.summary.tools, installed.runtimeSkills, env);
    if (Object.values(installed.runtimeSkills).some((skills) => skills.length > 0)) {
      updateWorktreeBootstrap(repoPath, env);
    }
    const existingRecordPath = join(repoPath, RECORD_PATH);
    // Explicit reuse can upgrade an unchanged legacy fingerprint; a changed
    // legacy hash (even cache-only) cannot prove that executable bytes stayed
    // the same, so it was refused above rather than silently re-pinned.
    if (verifiedLegacyRecord) {
      atomicWrite(existingRecordPath, `${JSON.stringify({
        ...verifiedLegacyRecord,
        source_payload_sha256: hashOwnedPayload(repoPath, installed.runtimeSkills),
        source_payload_format: 'without-derived-caches-v1',
      }, null, 2)}\n`);
    }
    const recordPath = !fresh && existsSync(existingRecordPath)
      ? existingRecordPath
      : writeRecord(
          repoPath,
          installed.text,
          installed.summary,
          installed.summary.tools,
          installed.runtimeSkills,
          fresh,
        );
    return {
      repo: repoName,
      action,
      ready: true,
      recordPath,
      message:
        `${action === 'install' ? 'installed' : 'reused unchanged'} ` +
        `${installed.summary.modules.map((module) => `${module.name}@${module.version}`).join(', ')}; ` +
        `bindings: ${installed.summary.tools.join(', ')}`,
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
