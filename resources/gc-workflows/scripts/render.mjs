#!/usr/bin/env node
// GC-owned helper. Node standard library only; never load project/global config.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoLinks, validateContext } from './context.mjs';

class WorkflowResourceError extends Error {
  constructor(message) { super(message); this.name = 'WorkflowResourceError'; }
}
const fail = (message) => { throw new WorkflowResourceError(message); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeRelative = (path) => typeof path === 'string' && path !== '' && !path.startsWith('/') &&
  !path.includes('\\') && !path.includes('\0') && !path.split('/').some((part) => ['', '.', '..'].includes(part));

function filesUnder(directory, prefix = '') {
  const out = new Map();
  const info = lstatSync(join(directory, prefix));
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`not a real directory: ${join(directory, prefix)}`);
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const entry = lstatSync(join(directory, path));
    if (entry.isSymbolicLink()) fail(`symlinked resource/snapshot: ${path}`);
    if (entry.isDirectory()) for (const [key, value] of filesUnder(directory, path)) out.set(key, value);
    else if (entry.isFile()) out.set(path, readFileSync(join(directory, path)));
    else fail(`non-regular resource/snapshot: ${path}`);
  }
  return out;
}
function contentHash(files) {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort()) hash.update(`f\0${path}\0`).update(files.get(path)).update('\0');
  return hash.digest('hex');
}
function verifiedRuntime() {
  const files = filesUnder(root);
  const manifestBytes = files.get('runtime.json');
  if (manifestBytes === undefined) fail('missing GC workflow resource runtime.json');
  const manifest = JSON.parse(manifestBytes.toString('utf-8'));
  if (!record(manifest) || manifest.schema_version !== 2 || manifest.name !== 'gru-command-workflows' ||
      !Number.isSafeInteger(manifest.version) || manifest.version < 1 ||
      manifest.id !== `gru-command-workflows@${manifest.version}` || !record(manifest.files) ||
      !record(manifest.entrypoints)) fail('invalid GC workflow runtime.json identity/schema');
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!safeRelative(path) || path === 'runtime.json' || !/^[0-9a-f]{64}$/u.test(hash)) fail(`invalid GC workflow resource declaration: ${path}`);
    if (!files.has(path)) fail(`missing GC workflow resource ${path}`);
    if (sha(files.get(path)) !== hash) fail(`GC workflow resource ${path} does not match its sha256`);
  }
  for (const path of files.keys()) {
    if (path !== 'runtime.json' && !Object.hasOwn(manifest.files, path)) fail(`undeclared GC workflow resource ${path}`);
  }
  for (const route of ['normal', 'small-change', 'plan', 'review']) {
    if (!safeRelative(manifest.entrypoints[route]) || !files.has(manifest.entrypoints[route])) fail(`missing GC workflow entrypoint ${route}`);
  }
  const contentSha256 = contentHash(files);
  if (basename(root) !== `${manifest.name}-${manifest.version}-${contentSha256.slice(0, 20)}`) {
    fail(`GC workflow runtime ${root} is not its immutable content-addressed copy`);
  }
  return { files, manifest, contentSha256 };
}

function render(raw, route) {
  const { files, manifest, contentSha256 } = verifiedRuntime();
  if (!Object.hasOwn(manifest.entrypoints, route)) fail(`unsupported GC workflow route: ${route}`);
  const context = validateContext(raw, [root, dirname(root)]);
  const receipt = { ...context, runtimeId: manifest.id, contentSha256 };
  const generation = sha(JSON.stringify(receipt));
  const snapshots = join(context.artifactRoot, 'workflow-snapshots');
  const snapshotDir = join(snapshots, generation);
  assertNoLinks(snapshotDir);
  const contextFile = join(snapshotDir, 'invocation.json');
  const values = { ...receipt, contextFile };
  const expected = new Map([['invocation.json', Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)]]);
  for (const [path, bytes] of files) {
    // The launcher remains in the immutable runtime, not the instruction snapshot:
    // its package-relative helper would not exist beside a copied SKILL.md.
    if (!path.startsWith('skills/') || !path.endsWith('.md') || path.endsWith('/SKILL.md')) continue;
    const text = bytes.toString('utf-8')
      .replace(/\[\[gc-resource:([^\]]+)\]\]/gu, (_, target) => {
        if (!safeRelative(target) || !files.has(target) || !target.startsWith('skills/') || !target.endsWith('.md') || target.endsWith('/SKILL.md')) fail(`${path} references missing/unsupported resource ${target}`);
        return join(snapshotDir, target);
      })
      .replace(/\{\{context\.([A-Za-z][A-Za-z0-9]*)\}\}/gu, (_, key) => {
        if (!Object.hasOwn(values, key)) fail(`${path} has unknown context field ${key}`);
        return values[key];
      });
    if (/\[\[gc-resource:|\{\{context\./u.test(text)) fail(`unresolved GC workflow token in ${path}`);
    expected.set(path, Buffer.from(text));
  }
  const verifySnapshot = () => {
    const actual = filesUnder(snapshotDir);
    for (const [path, bytes] of expected) {
      if (!actual.get(path)?.equals(bytes)) fail(`GC workflow snapshot is missing/modified: ${join(snapshotDir, path)}`);
    }
    for (const path of actual.keys()) if (!expected.has(path)) fail(`undeclared GC workflow snapshot file: ${path}`);
  };
  // Validate all input/closure before creating anything, and never alter project files.
  mkdirSync(context.artifactRoot, { recursive: true, mode: 0o700 });
  if ((lstatSync(context.artifactRoot).mode & 0o077) !== 0) fail('GC workflow artifactRoot must have private permissions (0700)');
  mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  if (existsSync(snapshotDir)) verifySnapshot();
  else {
    const staging = mkdtempSync(join(snapshots, '.staging-'));
    try {
      for (const [path, bytes] of expected) {
        const target = join(staging, path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, bytes, { flag: 'wx', mode: 0o400 });
      }
      try { renameSync(staging, snapshotDir); } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
      verifySnapshot();
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  return { runtimeId: manifest.id, contentSha256, entrypoint: join(snapshotDir, manifest.entrypoints[route]), snapshotDir, contextFile };
}

try {
  const args = process.argv.slice(2);
  let route = 'normal';
  let contextFile;
  let stdin = false;
  let json = false;
  const seen = new Set();
  while (args.length > 0) {
    const flag = args.shift();
    if (seen.has(flag)) fail(`duplicate GC workflow argument ${flag}`);
    seen.add(flag);
    if (flag === '--route') route = args.shift();
    else if (flag === '--context') contextFile = args.shift();
    else if (flag === '--context-stdin') stdin = true;
    else if (flag === '--json') json = true;
    else fail(`unknown GC workflow argument ${flag}`);
  }
  if ((contextFile !== undefined) === stdin) fail('supply exactly one --context <absolute JSON path> or --context-stdin');
  if (contextFile !== undefined && !isAbsolute(contextFile)) fail('--context must be an absolute JSON path');
  const input = readFileSync(stdin ? 0 : contextFile, 'utf-8');
  const result = render(JSON.parse(input), route);
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `read and follow ${result.entrypoint}\n`);
} catch (error) {
  process.stderr.write(`WorkflowResourceError: ${error.message}\n`);
  process.exitCode = 1;
}
