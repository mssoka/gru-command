#!/usr/bin/env node
// Managed by Gru Command BMAD bootstrap v1
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
      hash.update('d\0' + relativePath + '\0');
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (info.isFile()) {
      hash.update('f\0' + relativePath + '\0');
      hash.update(readFileSync(path));
      hash.update('\0');
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
