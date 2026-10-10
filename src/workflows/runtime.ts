import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  bindBmadRuntime, inspectMaterializedBmadRuntime, managedSkillSet, PACKAGE_ROOT, readBmadRuntimeBinding,
  type BmadRuntimeBinding, type BmadRuntimeBinderOptions, type MaterializedBmadRuntime, type RuntimeBundle,
} from '../bmad/runtime.js';
import type { ManagedSkillSet } from '../runtime/types.js';
import {
  parseWorkflowManifest, verifyWorkflowFiles, workflowContentHash, workflowDirName, workflowId,
  WorkflowResourceError, WORKFLOW_ENTRYPOINTS, WORKFLOW_MANIFEST, WORKFLOW_RESOURCE_DIR, WORKFLOW_SOURCE,
  type WorkflowManifest, type WorkflowRoute,
} from './manifest.js';

export { WorkflowResourceError } from './manifest.js';

export interface BundledWorkflowRuntime extends RuntimeBundle {
  readonly manifest: WorkflowManifest;
  readonly resourceRoot: string;
}

/** Explicit caller-owned authority/context; storage allocation belongs to #293. */
export interface WorkflowContext {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly worktreeRoot: string;
  readonly jobId: string;
  readonly artifactRoot: string;
  readonly knowledgeRoot: string;
}

export interface WorkflowInvocation {
  readonly runtimeId: string;
  readonly contentSha256: string;
  readonly entrypoint: string;
  readonly snapshotDir: string;
  readonly contextFile: string;
}

function resourceFiles(root: string, prefix = ''): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const info = lstatSync(join(root, prefix));
  if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkflowResourceError(`GC workflow resource directory is not a real directory: ${join(root, prefix)}`);
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    const entry = lstatSync(join(root, rel));
    if (entry.isSymbolicLink()) throw new WorkflowResourceError(`GC workflow resource is a symlink: ${rel}`);
    if (entry.isDirectory()) for (const [path, bytes] of resourceFiles(root, rel)) files.set(path, bytes);
    else if (entry.isFile()) files.set(rel, readFileSync(join(root, rel)));
    else throw new WorkflowResourceError(`GC workflow resource is not a regular file: ${rel}`);
  }
  return files;
}

function readWorkflowResources(root: string): BundledWorkflowRuntime {
  try {
    const files = resourceFiles(root);
    const bytes = files.get(WORKFLOW_MANIFEST);
    if (bytes === undefined) throw new WorkflowResourceError(`missing ${WORKFLOW_MANIFEST}`);
    const manifest = parseWorkflowManifest(bytes.toString('utf-8'), join(root, WORKFLOW_MANIFEST));
    verifyWorkflowFiles(manifest, files);
    const contentSha256 = workflowContentHash(files);
    return { id: manifest.id, manifest, resourceRoot: root, files, contentSha256, dirName: workflowDirName(manifest, contentSha256) };
  } catch (error) {
    throw new WorkflowResourceError(`GC workflow package ${root} failed verification: ${(error as Error).message}. Rebuild or reinstall GC; no ambient workflow fallback is permitted.`);
  }
}

/** Shipped GC bytes only: never consult project/global BMAD or a source checkout. */
export function loadBundledWorkflowRuntime(packageRoot = PACKAGE_ROOT): BundledWorkflowRuntime {
  return readWorkflowResources(join(packageRoot, WORKFLOW_RESOURCE_DIR));
}

/** Read-only selection precedes context validation and binding. Retained A is the
 * validation authority too; installed B may be different, corrupt or absent. */
export function workflowRuntimeForInvocation(cwd: string, storeRoot: string, packageRoot = PACKAGE_ROOT): BundledWorkflowRuntime {
  const reference = readBmadRuntimeBinding(cwd, storeRoot);
  if (reference === null) return loadBundledWorkflowRuntime(packageRoot);
  try {
    const retained = readWorkflowResources(reference.dir);
    if (retained.id !== reference.id || retained.contentSha256 !== reference.contentSha256 ||
        basename(reference.dir) !== retained.dirName) {
      throw new WorkflowResourceError(`retained GC workflow ${reference.dir} does not match binding ${reference.bindingFile}`);
    }
    return retained;
  } catch (error) {
    // Permit the existing binder's identical-byte restoration only. Still no
    // writes here: invalid context must not install a runtime or bind a lane.
    const current = loadBundledWorkflowRuntime(packageRoot);
    if (current.id !== reference.id || current.contentSha256 !== reference.contentSha256 ||
        join(storeRoot, current.dirName) !== reference.dir) {
      throw new WorkflowResourceError(`lane ${cwd} retains workflow ${reference.id} at ${reference.dir}, which cannot be invoked: ${(error as Error).message}. Restore that retained runtime; never switch the lane to ${current.id}.`);
    }
    return current;
  }
}

/** Maintainer-local integrity refresh: no upstream release, archive or comparison. */
export function writeWorkflowManifest(packageRoot: string, version?: number): WorkflowManifest {
  const root = join(packageRoot, WORKFLOW_RESOURCE_DIR);
  const files = resourceFiles(root);
  const current = files.get(WORKFLOW_MANIFEST);
  const selectedVersion = version ?? (current === undefined ? 1 : parseWorkflowManifest(current.toString('utf-8'), join(root, WORKFLOW_MANIFEST)).version);
  const manifest = parseWorkflowManifest(JSON.stringify({
    schema_version: 2, name: WORKFLOW_SOURCE, version: selectedVersion, id: workflowId(selectedVersion),
    skills: ['gc-build'], entrypoints: WORKFLOW_ENTRYPOINTS,
    files: Object.fromEntries([...files].filter(([path]) => path !== WORKFLOW_MANIFEST)
      .map(([path, bytes]) => [path, createHash('sha256').update(bytes).digest('hex')])),
  }), root);
  verifyWorkflowFiles(manifest, files);
  writeFileSync(join(root, WORKFLOW_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Validate without installing/binding. Execute the already-verified validator bytes,
 * not a mutable package pathname, so the CLI and retained renderer share one contract. */
export function validateWorkflowContext(bundle: BundledWorkflowRuntime, context: unknown, protectedRoots: readonly string[] = []): WorkflowContext {
  const source = bundle.files.get('scripts/context.mjs');
  if (source === undefined) throw new WorkflowResourceError('missing GC workflow resource scripts/context.mjs');
  const validator = `
    import { readFileSync } from 'node:fs';
    try {
      const { validateContext } = await import(process.argv[1]);
      const input = JSON.parse(readFileSync(0, 'utf-8'));
      process.stdout.write(JSON.stringify(validateContext(input.context, input.protectedRoots)));
    } catch (error) {
      process.stderr.write(error.message);
      process.exitCode = 1;
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', validator,
    `data:text/javascript;base64,${source.toString('base64')}`], {
    input: JSON.stringify({ context, protectedRoots }), encoding: 'utf-8', timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new WorkflowResourceError(`GC workflow context validation failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as WorkflowContext;
}

/** Same atomic binding record as #283. A retained historical runtime wins unchanged. */
export function bindWorkflowRuntime(cwd: string, options: BmadRuntimeBinderOptions): BmadRuntimeBinding {
  return bindBmadRuntime(cwd, options);
}

export function createWorkflowRuntimeBinder(storeRoot: string, packageRoot = PACKAGE_ROOT): (cwd: string) => ManagedSkillSet {
  let bundle: BundledWorkflowRuntime | undefined;
  return (cwd) => {
    const binding = bindWorkflowRuntime(cwd, { storeRoot, bundled: () => (bundle ??= loadBundledWorkflowRuntime(packageRoot)) });
    const manifest = JSON.parse(readFileSync(join(binding.dir, WORKFLOW_MANIFEST), 'utf-8')) as { schema_version: number };
    return manifest.schema_version === 2 ? { ...managedSkillSet(binding), source: WORKFLOW_SOURCE } : managedSkillSet(binding);
  };
}

/** Execute the retained package's helper with argv/stdin, never shell interpolation. */
export function renderWorkflow(runtime: MaterializedBmadRuntime, context: WorkflowContext, route: WorkflowRoute = 'normal'): WorkflowInvocation {
  const verified = inspectMaterializedBmadRuntime(runtime.dir);
  if (verified.id !== runtime.id || verified.contentSha256 !== runtime.contentSha256) {
    throw new WorkflowResourceError(`GC workflow invocation does not match bound runtime ${runtime.dir}`);
  }
  const manifest = parseWorkflowManifest(readFileSync(join(runtime.dir, WORKFLOW_MANIFEST), 'utf-8'), runtime.dir);
  const result = spawnSync(process.execPath, [join(runtime.dir, 'scripts/render.mjs'), '--context-stdin', '--route', route, '--json'], {
    input: JSON.stringify(context), encoding: 'utf-8', timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new WorkflowResourceError(`GC workflow ${manifest.id} invocation failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as WorkflowInvocation;
}

/** The skill's own command, with caller paths passed in quoted environment variables. */
export function workflowLauncherCommand(runtime: MaterializedBmadRuntime, contextFile: string, route: WorkflowRoute = 'normal'):
{ readonly command: string; readonly env: Readonly<Record<string, string>> } {
  if (!Object.hasOwn(WORKFLOW_ENTRYPOINTS, route)) throw new WorkflowResourceError(`unsupported GC workflow route: ${route}`);
  const skillRoot = join(runtime.skillsDir, 'gc-build');
  const text = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8');
  const command = /```bash\n([^\n]+)\n```/u.exec(text)?.[1];
  if (command === undefined || !command.includes('"{skill-root}') || !command.includes('"{context-file}"')) {
    throw new WorkflowResourceError('gc-build/SKILL.md lacks a quoted GC workflow launcher');
  }
  return {
    command: `${command.replaceAll('{skill-root}', '${GC_WORKFLOW_SKILL_ROOT}').replaceAll('{context-file}', '${GC_WORKFLOW_CONTEXT_FILE}')} --route ${route}`,
    env: { GC_WORKFLOW_SKILL_ROOT: skillRoot, GC_WORKFLOW_CONTEXT_FILE: contextFile },
  };
}
