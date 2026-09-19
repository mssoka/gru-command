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

function commandAvailable(command: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
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

function assertNoPartialInstall(repoPath: string): void {
  const suspicious = [
    join(repoPath, '_bmad'),
    join(repoPath, '.agents', 'skills', 'bmad-build'),
    join(repoPath, '.claude', 'skills', 'bmad-build'),
  ];
  if (suspicious.some((path) => existsSync(path))) {
    throw new Error(
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

function assertNoSymlinkComponents(base: string, relativePath: string): void {
  let current = base;
  for (const part of relativePath.split('/').filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) {
      throw new Error(`refusing BMAD path through symlink: ${current}`);
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
  assertNoSymlinkComponents(repoPath, '_bmad');
  for (const module of summary.modules) {
    const path = join(repoPath, '_bmad', module.name);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) {
      throw new Error(`BMAD manifest declares missing or unsafe module directory: ${path}`);
    }
    if (!insideOrEqual(repoPath, realpathSync(path))) {
      throw new Error(`BMAD module directory escapes selected repo: ${path}`);
    }
  }
}

function verifySkills(repoPath: string, tools: readonly string[]): void {
  for (const tool of tools) {
    const root = tool === 'claude-code' ? '.claude' : '.agents';
    assertNoSymlinkComponents(repoPath, `${root}/skills/bmad-build`);
    const skill = join(repoPath, root, 'skills', 'bmad-build', 'SKILL.md');
    if (!existsSync(skill) || lstatSync(skill).isSymbolicLink() || !statSync(skill).isFile()) {
      throw new Error(`BMAD ${tool} binding is missing required bmad-build skill: ${skill}`);
    }
    if (!insideOrEqual(repoPath, realpathSync(skill))) {
      throw new Error(`BMAD ${tool} binding escapes selected repo: ${skill}`);
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
            throw new Error(
              `existing BMAD binding has ambiguous BMM/GDS config token in ${file}; ` +
                'reuse preserved it unchanged, so repair or deliberately reinstall before marking ready',
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
      const generated = runtimeSkillNames(stage, tool);
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
  const runtimeSkills = Object.fromEntries(
    tools.map((tool) => {
      const before = new Set(beforeSkills[tool] ?? []);
      return [tool, runtimeSkillNames(repoPath, tool).filter((name) => !before.has(name))];
    }),
  ) as Record<string, string[]>;
  for (const tool of tools) {
    if (!runtimeSkills[tool]?.includes('bmad-build')) {
      throw new Error(`official BMAD installer did not create an isolated bmad-build binding for ${tool}`);
    }
  }
  qualifyFreshSkillConfig(repoPath, tools, runtimeSkills);
  verifyModuleDirectories(repoPath, installed.summary);
  verifySkills(repoPath, tools);
  verifyNoAmbiguousSkillConfig(repoPath, tools, installed.summary, runtimeSkills);
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
    throw new Error(`malformed managed block: expected paired ${start} / ${end}`);
  }
  const block = `${start}\n${body.join('\n')}\n${end}`;
  if (startAt !== -1) {
    return `${original.slice(0, startAt)}${block}${original.slice(endAt + end.length)}`;
  }
  const prefix = original === '' || original.endsWith('\n') ? original : `${original}\n`;
  return `${prefix}${prefix === '' ? '' : '\n'}${block}\n`;
}

function runtimeSkillNames(repoPath: string, tool: string): string[] {
  const rootName = tool === 'claude-code' ? '.claude' : '.agents';
  assertNoSymlinkComponents(repoPath, `${rootName}/skills`);
  const root = runtimeSkillsRoot(repoPath, tool);
  if (!existsSync(root)) return [];
  if (!statSync(root).isDirectory()) throw new Error(`BMAD skill root is not a directory: ${root}`);
  const names: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`BMAD skill binding is a symlink: ${path}`);
    if (entry.isDirectory()) names.push(entry.name);
  }
  return names.sort();
}

function observedBmadSkills(repoPath: string, tools: readonly string[]): RuntimeSkillMap {
  return Object.fromEntries(
    tools.map((tool) => [
      tool,
      runtimeSkillNames(repoPath, tool).filter((name) => /^(?:bmad|gds|tea|cis)-/.test(name)),
    ]),
  );
}

function hashOwnedPayload(repoPath: string, runtimeSkills: RuntimeSkillMap): string {
  const hash = createHash('sha256');
  const visit = (path: string): void => {
    const relativePath = relative(repoPath, path);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error(`BMAD owned payload contains symlink: ${path}`);
    if (info.isDirectory()) {
      hash.update(`d\0${relativePath}\0`);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (info.isFile()) {
      hash.update(`f\0${relativePath}\0`);
      hash.update(readFileSync(path));
      hash.update('\0');
    } else {
      throw new Error(`BMAD owned payload contains unsupported entry: ${path}`);
    }
  };
  visit(join(repoPath, '_bmad'));
  for (const tool of Object.keys(runtimeSkills).sort()) {
    for (const skill of [...(runtimeSkills[tool] ?? [])].sort()) {
      visit(join(runtimeSkillsRoot(repoPath, tool), skill));
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
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
const childEnv = { ...process.env }; delete childEnv.OPENROUTER_API_KEY;
const root = realpathSync(process.cwd());
const sourceRaw = execFileSync('git', ['config', '--local', '--get', 'gru-command.bmad-source'], { encoding: 'utf-8', env: childEnv }).trim();
if (!sourceRaw) throw new Error('missing git-local gru-command.bmad-source; rerun Gru Command BMAD onboarding');
const source = realpathSync(sourceRaw);
const common = (dir) => realpathSync(execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf-8', env: childEnv }).trim());
if (common(root) !== common(source)) throw new Error('BMAD bootstrap source belongs to a different Git repository');
if (root === source) process.exit(0);
const inside = (base, child) => { const rel = relative(base, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const assertSafeDestination = (to) => {
  const target = resolve(to);
  if (!inside(root, target)) throw new Error('BMAD bootstrap destination escapes worktree: ' + to);
  let current = root;
  for (const part of relative(root, target).split('/').filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error('BMAD bootstrap refuses destination symlink: ' + current);
    }
  }
};
const copyTree = (from, to) => {
  const unresolved = resolve(from);
  if (!inside(source, unresolved)) throw new Error('BMAD bootstrap source escapes the selected repo: ' + from);
  const unresolvedInfo = lstatSync(unresolved);
  if (unresolvedInfo.isSymbolicLink()) throw new Error('BMAD bootstrap refuses source symlink: ' + from);
  const src = realpathSync(unresolved);
  if (!inside(source, src)) throw new Error('BMAD bootstrap source escapes the selected repo: ' + from);
  const info = lstatSync(src);
  assertSafeDestination(to);
  if (info.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(to, name));
    return;
  }
  if (!info.isFile()) throw new Error('BMAD bootstrap supports only files/directories: ' + from);
  if (existsSync(to)) {
    const dest = lstatSync(to);
    if (!dest.isFile() || dest.isSymbolicLink()) throw new Error('BMAD bootstrap destination collision: ' + to);
    if (!readFileSync(src).equals(readFileSync(to))) throw new Error('BMAD bootstrap destination differs from source: ' + to);
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(src, to, { errorOnExist: true, force: false });
};
const record = JSON.parse(readFileSync(join(root, '.gru-command', 'bmad-install.json'), 'utf-8'));
const sourceManifest = readFileSync(join(source, '_bmad', '_config', 'manifest.yaml'));
const sourceHash = createHash('sha256').update(sourceManifest).digest('hex');
if (sourceHash !== record.official_manifest_sha256) throw new Error('BMAD bootstrap source manifest changed since onboarding');
const hashPayload = () => {
  const hash = createHash('sha256');
  const visit = (path) => {
    const relativePath = relative(source, path);
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
  for (const tool of Object.keys(record.runtime_skills ?? {}).sort()) {
    const dir = tool === 'claude-code' ? '.claude' : '.agents';
    for (const skillName of [...record.runtime_skills[tool]].sort()) visit(join(source, dir, 'skills', skillName));
  }
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
      throw new Error(`existing worktree manifest is malformed: ${manifestPath}: ${String(error)}`);
    }
  }
  const next = managedBlock(original, BLOCK_START, BLOCK_END, [
    '[[setup]]',
    'command = "node .gru-command/bmad-bootstrap.mjs"',
  ]);
  const bootstrapPath = join(repoPath, BOOTSTRAP_PATH);
  if (existsSync(bootstrapPath) && !readFileSync(bootstrapPath, 'utf-8').includes(BOOTSTRAP_MARKER)) {
    throw new Error(`refusing to overwrite non-Gru BMAD bootstrap: ${bootstrapPath}`);
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
      throw new Error(`refusing to overwrite non-Gru BMAD record: ${path}`);
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
    source_payload_sha256: hashOwnedPayload(repoPath, runtimeSkills),
    compatibility_patches: fresh ? ['qualify-bmm-gds-short-config-tokens-v1'] : [],
  };
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function assertControlFilesSafe(repoPath: string): void {
  const controlDir = join(repoPath, '.gru-command');
  if (existsSync(controlDir)) {
    const info = lstatSync(controlDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`refusing BMAD control writes through unsafe path: ${controlDir}`);
    }
  }
  for (const relativePath of [RECORD_PATH, BOOTSTRAP_PATH, WORKTREE_MANIFEST_PATH]) {
    const path = join(repoPath, relativePath);
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`refusing BMAD control write through unsafe path: ${path}`);
      }
    }
  }
  const recordPath = join(repoPath, RECORD_PATH);
  if (existsSync(recordPath)) {
    let managedBy: unknown;
    try {
      managedBy = (JSON.parse(readFileSync(recordPath, 'utf-8')) as { managed_by?: unknown }).managed_by;
    } catch {
      throw new Error(`existing BMAD record is malformed: ${recordPath}`);
    }
    if (managedBy !== 'gru-command') {
      throw new Error(`refusing to overwrite non-Gru BMAD record: ${recordPath}`);
    }
  }
  const bootstrapPath = join(repoPath, BOOTSTRAP_PATH);
  if (existsSync(bootstrapPath) && !readFileSync(bootstrapPath, 'utf-8').includes(BOOTSTRAP_MARKER)) {
    throw new Error(`refusing to overwrite non-Gru BMAD bootstrap: ${bootstrapPath}`);
  }
  const manifestPath = join(repoPath, WORKTREE_MANIFEST_PATH);
  if (existsSync(manifestPath)) {
    try {
      parse(readFileSync(manifestPath, 'utf-8'));
    } catch (error) {
      throw new Error(`existing worktree manifest is malformed: ${manifestPath}: ${String(error)}`);
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
  if (!existsSync(candidate)) throw new Error(`selected repo no longer exists: ${candidate}`);
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`selected repo is a symlink; refusing BMAD writes outside the workspace: ${candidate}`);
  }
  const repoPath = realpathSync(candidate);
  if (!insideOrEqual(workspace, repoPath) || repoPath === workspace) {
    throw new Error(`selected repo escapes the workspace root: ${candidate}`);
  }
  if (!existsSync(join(repoPath, '.git'))) throw new Error(`selected directory is not a Git repo: ${repoPath}`);
  const gitRoot = spawnSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (gitRoot.status !== 0 || gitRoot.stdout.trim() === '') {
    throw new Error(`selected directory is not a usable Git repo: ${repoPath}`);
  }
  let actualRoot: string;
  try {
    actualRoot = realpathSync(gitRoot.stdout.trim());
  } catch {
    throw new Error(`selected Git repo reported an invalid top-level path: ${repoPath}`);
  }
  if (actualRoot !== repoPath) {
    throw new Error(`selected directory is not the Git repository root: ${repoPath}`);
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
  delete env.OPENROUTER_API_KEY;
  const tools = bmadToolsForAnswers(options.answers);
  try {
    const repoPath = validateRepo(options.workspaceRoot, repoName, env);
    assertControlFilesSafe(repoPath);
    assertNoSymlinkComponents(repoPath, '_bmad');
    for (const tool of tools) runtimeSkillNames(repoPath, tool);
    assertPrerequisites(tools, env, repoPath, options.prerequisiteCheck ?? commandAvailable);
    const existing = manifestFor(repoPath);
    let installed: InstalledBmad;
    let fresh = false;
    if (action === 'install') {
      if (existing !== null) {
        throw new Error('BMAD already exists; choose reuse to preserve it (automatic overwrite/upgrade is disabled)');
      }
      installed = installFresh(repoPath, tools, env, options.run ?? spawnSync);
      fresh = true;
    } else {
      if (existing === null) {
        assertNoPartialInstall(repoPath);
        throw new Error('reuse requested but no existing BMAD manifest was found');
      }
      let recordedSkills: RuntimeSkillMap | undefined;
      const priorRecord = join(repoPath, RECORD_PATH);
      if (existsSync(priorRecord)) {
        const raw = (JSON.parse(readFileSync(priorRecord, 'utf-8')) as {
          runtime_skills?: unknown;
        }).runtime_skills;
        if (raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          const parsed: Record<string, string[]> = {};
          for (const [tool, names] of Object.entries(raw)) {
            if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
              throw new Error(`existing BMAD record has invalid runtime_skills: ${priorRecord}`);
            }
            parsed[tool] = [...names] as string[];
          }
          recordedSkills = parsed;
        }
      }
      const runtimeSkills = recordedSkills ?? observedBmadSkills(repoPath, existing.summary.tools);
      installed = { ...existing, runtimeSkills };
      verifyModuleDirectories(repoPath, installed.summary);
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
        throw new Error(
          `existing BMAD install lacks selected runtime binding(s): ${missingBindings.join(', ')}; ` +
            'reuse will not modify it—choose skip or deliberately update it with the official installer',
        );
      }
    }

    if (fresh) updateLocalExclude(repoPath, installed.summary.tools, installed.runtimeSkills, env);
    if (Object.values(installed.runtimeSkills).some((skills) => skills.length > 0)) {
      updateWorktreeBootstrap(repoPath, env);
    }
    const existingRecordPath = join(repoPath, RECORD_PATH);
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
    };
  }
}

export function onboardSelectedRepos(options: BmadOnboardingOptions): BmadRepoResult[] {
  return options.answers.repos.map((repo) =>
    onboardBmadRepo(repo, options.answers.bmad[repo] ?? 'skip', options),
  );
}
