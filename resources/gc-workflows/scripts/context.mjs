// Shared GC-owned context validator: CLI preflight and the retained renderer
// execute these same bytes. Pure validation; no directories/files are created.
import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

class WorkflowResourceError extends Error {
  constructor(message) { super(message); this.name = 'WorkflowResourceError'; }
}
const fail = (message) => { throw new WorkflowResourceError(message); };

export function assertNoLinks(path) {
  let current = path;
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) fail(`context path is a symlink: ${current}`); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function inside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function validateContext(raw, protectedRoots = []) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('GC workflow context must be an explicit JSON object');
  const context = {};
  const keys = ['projectId', 'jobId', 'projectRoot', 'worktreeRoot', 'artifactRoot', 'knowledgeRoot'];
  if (Object.keys(raw).some((key) => !keys.includes(key))) fail('unknown GC workflow context field');
  for (const key of keys) {
    const value = raw[key];
    if (typeof value !== 'string' || value.trim() === '' || /[\0\r\n]/u.test(value)) fail(`GC workflow context ${key} must be a non-empty string`);
    if (key === 'projectId' || key === 'jobId') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) fail(`GC workflow context ${key} must be a stable identity, not a path`);
      context[key] = value;
    } else {
      if (!isAbsolute(value)) fail(`GC workflow context ${key} must be an absolute path`);
      context[key] = resolve(value);
      assertNoLinks(context[key]);
    }
  }
  for (const key of ['projectRoot', 'worktreeRoot']) {
    if (!lstatSync(context[key]).isDirectory()) fail(`GC workflow context ${key} is not a directory: ${context[key]}`);
  }
  for (const path of [context.projectRoot, context.worktreeRoot, ...protectedRoots.map((path) => resolve(path))]) {
    if (inside(path, context.artifactRoot) || inside(context.artifactRoot, path)) fail('GC workflow artifactRoot must be private and outside project/worktree/runtime roots');
  }
  if (context.knowledgeRoot === context.worktreeRoot || !inside(context.worktreeRoot, context.knowledgeRoot)) {
    fail('GC workflow knowledgeRoot must be beneath the assigned worktreeRoot');
  }
  if (existsSync(context.knowledgeRoot) && !lstatSync(context.knowledgeRoot).isDirectory()) fail('GC workflow knowledgeRoot is not a directory');
  if (existsSync(context.artifactRoot)) {
    const info = lstatSync(context.artifactRoot);
    if (!info.isDirectory()) fail('GC workflow artifactRoot is not a directory');
    if ((info.mode & 0o077) !== 0) fail('GC workflow artifactRoot must have private permissions (0700)');
  }
  return context;
}
