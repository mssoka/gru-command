import { createHash } from 'node:crypto';

export const WORKFLOW_RESOURCE_DIR = 'resources/gc-workflows';
export const WORKFLOW_MANIFEST = 'runtime.json';
export const WORKFLOW_SOURCE = 'gru-command-workflows';
export const WORKFLOW_ENTRYPOINTS = {
  normal: 'skills/gc-build/workflow.md',
  'small-change': 'skills/gc-build/small-change.md',
  plan: 'skills/gc-build/plan.md',
  review: 'skills/gc-build/review.md',
} as const;
export type WorkflowRoute = keyof typeof WORKFLOW_ENTRYPOINTS;

/** The supported delivery path, not a catalog of arbitrary skills. */
export const REQUIRED_WORKFLOW_FILES: readonly string[] = [
  'LICENSE', 'NOTICE.md', '.claude-plugin/plugin.json', 'scripts/render.mjs', 'scripts/context.mjs',
  'skills/gc-build/SKILL.md', ...Object.values(WORKFLOW_ENTRYPOINTS),
  'skills/gc-build/implement.md', 'skills/gc-build/present.md', 'skills/gc-build/spec-template.md',
  'skills/gc-build/review-prompts/adversarial.md', 'skills/gc-build/review-prompts/edge-cases.md',
  'skills/gc-build/review-prompts/verification.md',
  'skills/gc-build/references/claims-check.md', 'skills/gc-build/references/deletion-check.md',
];

/** Current intake needs this helper; historical lane manifests remain valid. */
export const REQUIRED_INTAKE_WORKFLOW_FILE = 'skills/gc-build/intake.md';

export class WorkflowResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowResourceError';
  }
}

export interface WorkflowManifest {
  readonly schema_version: 2;
  readonly id: string;
  readonly name: typeof WORKFLOW_SOURCE;
  readonly version: number;
  readonly skills: readonly ['gc-build'];
  readonly entrypoints: Readonly<Record<WorkflowRoute, string>>;
  /** Resource-relative paths and hashes of GC-owned bytes. No upstream identity. */
  readonly files: Readonly<Record<string, string>>;
}

export function workflowId(version: number): string {
  return `${WORKFLOW_SOURCE}@${version}`;
}

export function workflowDirName(manifest: WorkflowManifest, content: string): string {
  return `${manifest.name}-${manifest.version}-${content.slice(0, 20)}`;
}

export function workflowContentHash(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort()) {
    hash.update(`f\0${path}\0`).update(files.get(path)!).update('\0');
  }
  return hash.digest('hex');
}

export function verifyWorkflowFiles(manifest: WorkflowManifest, files: ReadonlyMap<string, Buffer>): void {
  for (const [path, hash] of Object.entries(manifest.files)) {
    const bytes = files.get(path);
    if (bytes === undefined) throw new WorkflowResourceError(`missing GC workflow resource ${path}`);
    if (createHash('sha256').update(bytes).digest('hex') !== hash) {
      throw new WorkflowResourceError(`GC workflow resource ${path} does not match its sha256`);
    }
  }
  for (const path of files.keys()) {
    if (path !== WORKFLOW_MANIFEST && !Object.hasOwn(manifest.files, path)) {
      throw new WorkflowResourceError(`undeclared GC workflow resource ${path}`);
    }
    if (path.endsWith('.md')) {
      const text = files.get(path)!.toString('utf-8');
      for (const [, target] of text.matchAll(/\[\[gc-resource:([^\]]+)\]\]/gu)) {
        if (target === undefined || !files.has(target) || !target.startsWith('skills/') || !target.endsWith('.md') || target.endsWith('/SKILL.md')) {
          throw new WorkflowResourceError(`${path} references missing/unsupported GC workflow resource ${target}`);
        }
      }
      const contextFields = ['projectId', 'projectRoot', 'worktreeRoot', 'jobId', 'artifactRoot', 'knowledgeRoot', 'runtimeId', 'contentSha256', 'contextFile'];
      for (const [, field] of text.matchAll(/\{\{context\.([^}]+)\}\}/gu)) {
        if (!contextFields.includes(field!)) throw new WorkflowResourceError(`${path} has unknown context field ${field}`);
      }
      if (/\[\[gc-resource:|\{\{context\./u.test(text.replace(/\[\[gc-resource:[^\]]+\]\]|\{\{context\.[^}]+\}\}/gu, ''))) {
        throw new WorkflowResourceError(`${path} has a malformed GC workflow token`);
      }
    }
  }
  let plugin: unknown;
  try { plugin = JSON.parse(files.get('.claude-plugin/plugin.json')!.toString('utf-8')); } catch {
    throw new WorkflowResourceError('GC workflow resource .claude-plugin/plugin.json is not valid JSON');
  }
  if (!isRecord(plugin) || plugin['name'] !== WORKFLOW_SOURCE) throw new WorkflowResourceError('.claude-plugin/plugin.json must name gru-command-workflows');
}

export function assertWorkflowPath(path: string): void {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new WorkflowResourceError(`unsafe GC workflow resource path: ${JSON.stringify(path)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkflowManifest(text: string, source: string): WorkflowManifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) {
    throw new WorkflowResourceError(`GC workflow manifest ${source} is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(raw) || raw['schema_version'] !== 2 || raw['name'] !== WORKFLOW_SOURCE ||
      !Number.isSafeInteger(raw['version']) || (raw['version'] as number) < 1) {
    throw new WorkflowResourceError(`GC workflow manifest ${source} has an invalid schema/name/version`);
  }
  const version = raw['version'] as number;
  if (raw['id'] !== workflowId(version)) {
    throw new WorkflowResourceError(`GC workflow manifest ${source}: id must be ${workflowId(version)}`);
  }
  if (!Array.isArray(raw['skills']) || raw['skills'].length !== 1 || raw['skills'][0] !== 'gc-build') {
    throw new WorkflowResourceError(`GC workflow manifest ${source}: skills must be [gc-build]`);
  }
  const files = raw['files'];
  if (!isRecord(files)) throw new WorkflowResourceError(`GC workflow manifest ${source} lacks files`);
  for (const [path, hash] of Object.entries(files)) {
    assertWorkflowPath(path);
    if (path === WORKFLOW_MANIFEST || typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) {
      throw new WorkflowResourceError(`GC workflow manifest ${source}: invalid sha256 for ${path}`);
    }
  }
  for (const path of REQUIRED_WORKFLOW_FILES) {
    if (files[path] === undefined) throw new WorkflowResourceError(`GC workflow manifest ${source} lacks required resource ${path}`);
  }
  const entrypoints = raw['entrypoints'];
  if (!isRecord(entrypoints) || Object.keys(entrypoints).length !== Object.keys(WORKFLOW_ENTRYPOINTS).length) {
    throw new WorkflowResourceError(`GC workflow manifest ${source} lacks supported entrypoints`);
  }
  for (const [route, path] of Object.entries(WORKFLOW_ENTRYPOINTS)) {
    if (entrypoints[route] !== path) throw new WorkflowResourceError(`GC workflow manifest ${source}: ${route} must name ${path}`);
  }
  return {
    schema_version: 2, name: WORKFLOW_SOURCE, version, id: workflowId(version),
    skills: ['gc-build'], entrypoints: { ...WORKFLOW_ENTRYPOINTS }, files: files as Record<string, string>,
  };
}
