import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManagedSkillSet } from '../runtime/types.js';
import { parseWorkflowManifest, verifyWorkflowFiles, workflowDirName } from '../workflows/manifest.js';

/**
 * The Gru Command-managed BMAD runtime (issue #283).
 *
 * The package ships a pinned set of upstream BMAD files, byte-for-byte, plus
 * a small GC customization layer (`resources/bmad-runtime/`, described by its
 * `runtime.json`). Nothing here downloads or upgrades BMAD: a new upstream
 * version arrives only as a reviewed GC release (docs/BMAD-RUNTIME.md).
 *
 * Jobs never run from the package tree itself — an update replaces it in
 * place. The verified bundle is composed into a content-addressed, read-only
 * directory under the data dir, and each job lane records which one it uses,
 * so a running job keeps its runtime when a newer one ships.
 */

export const BMAD_RUNTIME_RESOURCE_DIR = join('resources', 'bmad-runtime');
export const BMAD_RUNTIME_MANIFEST = 'runtime.json';
/** Name Claude Code namespaces the bundled skills under (`<plugin>:<skill>`). */
export const BMAD_RUNTIME_SOURCE = 'gru-command-bmad';
const BINDING_FILE = join('gru-command', 'bmad-runtime.json');

/** `<package>/` — src/bmad and dist/bmad both sit two levels below the root. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A bundled, materialized, or bound runtime that cannot be used as-is. */
export class BmadRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BmadRuntimeError';
  }
}

export interface BmadRuntimeLayoutEntry {
  /** Path inside the composed runtime. */
  readonly path: string;
  /** Bundle-relative source: `upstream/<file>` or `gc/<file>`. */
  readonly from: string;
  /** For a GC overlay: the upstream file it stands in for. */
  readonly replaces?: string;
}

export interface BmadRuntimeManifest {
  readonly schema_version: 1;
  readonly id: string;
  readonly upstream: {
    readonly package: string;
    readonly version: string;
    readonly tarball: string;
    readonly integrity: string;
    readonly repository: string;
    readonly git_head: string;
    readonly license: string;
    /** Bundle path under `upstream/` → sha256 of the unchanged upstream bytes. */
    readonly files: Readonly<Record<string, string>>;
  };
  readonly customization: {
    readonly name: string;
    readonly version: number;
    /** Bundle path under `gc/` → sha256. */
    readonly files: Readonly<Record<string, string>>;
  };
  /** Skills the runtime supplies to sessions (each has `skills/<name>/SKILL.md`). */
  readonly skills: readonly string[];
  /** Skills the bundled workflows only mention as optional, human-facing next steps. */
  readonly optional_skill_references: readonly string[];
  readonly layout: readonly BmadRuntimeLayoutEntry[];
}

/** Shared immutable bytes: new GC resources reuse the #283 store and lane records. */
export interface RuntimeBundle {
  readonly id: string;
  /** sha256 over the composed layout (every path and its bytes). */
  readonly contentSha256: string;
  /** Directory name of the materialized runtime (identity + content hash). */
  readonly dirName: string;
  /** Composed runtime: path → bytes (includes `runtime.json`). */
  readonly files: ReadonlyMap<string, Buffer>;
}

export interface BundledBmadRuntime extends RuntimeBundle {
  readonly manifest: BmadRuntimeManifest;
}

export interface MaterializedBmadRuntime {
  readonly id: string;
  readonly dir: string;
  readonly contentSha256: string;
  readonly skillsDir: string;
  readonly skills: readonly string[];
}

export interface BmadRuntimeBinding extends MaterializedBmadRuntime {
  /** Lane binding record; null when the cwd is not a linked git worktree. */
  readonly bindingFile: string | null;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSafeRelative(path: string, label: string): void {
  const parts = path.split('/');
  if (path === '' || path.startsWith('/') || path.includes('\\') ||
      parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new BmadRuntimeError(`${label} is not a safe relative path: ${JSON.stringify(path)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BmadRuntimeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireHashes(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new BmadRuntimeError(`${label} must be a non-empty object of path → sha256`);
  }
  for (const [path, hash] of Object.entries(value)) {
    assertSafeRelative(path, `${label} entry`);
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) {
      throw new BmadRuntimeError(`${label}[${path}] must be a lowercase sha256`);
    }
  }
  return value as Record<string, string>;
}

function requireNames(value: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some((name) => typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(name))) {
    throw new BmadRuntimeError(`${label} must be a list of skill names`);
  }
  return value as string[];
}

/** The id is derived, never trusted: upstream version + customization version. */
export function bmadRuntimeId(manifest: Pick<BmadRuntimeManifest, 'upstream' | 'customization'>): string {
  return `${manifest.upstream.package}@${manifest.upstream.version}+${manifest.customization.name}.${manifest.customization.version}`;
}

export function parseBmadRuntimeManifest(text: string, source: string): BmadRuntimeManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new BmadRuntimeError(`BMAD runtime manifest ${source} is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(raw) || raw['schema_version'] !== 1) {
    throw new BmadRuntimeError(`BMAD runtime manifest ${source} has an unsupported schema_version`);
  }
  const upstream = raw['upstream'];
  const customization = raw['customization'];
  if (!isRecord(upstream) || !isRecord(customization)) {
    throw new BmadRuntimeError(`BMAD runtime manifest ${source} lacks upstream/customization sections`);
  }
  const version = customization['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new BmadRuntimeError(`BMAD runtime manifest ${source}: customization.version must be a positive integer`);
  }
  const layout = raw['layout'];
  if (!Array.isArray(layout) || layout.length === 0) {
    throw new BmadRuntimeError(`BMAD runtime manifest ${source}: layout must be a non-empty list`);
  }
  const manifest: BmadRuntimeManifest = {
    schema_version: 1,
    id: requireString(raw['id'], 'id'),
    upstream: {
      package: requireString(upstream['package'], 'upstream.package'),
      version: requireString(upstream['version'], 'upstream.version'),
      tarball: requireString(upstream['tarball'], 'upstream.tarball'),
      integrity: requireString(upstream['integrity'], 'upstream.integrity'),
      repository: requireString(upstream['repository'], 'upstream.repository'),
      git_head: requireString(upstream['git_head'], 'upstream.git_head'),
      license: requireString(upstream['license'], 'upstream.license'),
      files: requireHashes(upstream['files'], 'upstream.files'),
    },
    customization: {
      name: requireString(customization['name'], 'customization.name'),
      version,
      files: requireHashes(customization['files'], 'customization.files'),
    },
    skills: requireNames(raw['skills'], 'skills', false),
    optional_skill_references: requireNames(raw['optional_skill_references'], 'optional_skill_references', true),
    layout: layout.map((entry, index) => {
      if (!isRecord(entry)) throw new BmadRuntimeError(`layout[${index}] must be an object`);
      const path = requireString(entry['path'], `layout[${index}].path`);
      const from = requireString(entry['from'], `layout[${index}].from`);
      assertSafeRelative(path, `layout[${index}].path`);
      assertSafeRelative(from, `layout[${index}].from`);
      const replaces = entry['replaces'];
      if (replaces !== undefined) assertSafeRelative(requireString(replaces, `layout[${index}].replaces`), `layout[${index}].replaces`);
      return { path, from, ...(replaces !== undefined ? { replaces: replaces as string } : {}) };
    }),
  };
  if (manifest.id !== bmadRuntimeId(manifest)) {
    throw new BmadRuntimeError(
      `BMAD runtime manifest ${source}: id ${manifest.id} does not match ${bmadRuntimeId(manifest)}`,
    );
  }
  return manifest;
}

/** Regular files under `root`, as sorted posix paths. Links and special files are refused. */
function listRegularFiles(root: string, label: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new BmadRuntimeError(`${label} contains a symlink: ${rel}`);
      if (info.isDirectory()) visit(path, rel);
      else if (info.isFile()) out.push(rel);
      else throw new BmadRuntimeError(`${label} contains a non-regular entry: ${rel}`);
    }
  };
  visit(root, '');
  return out;
}

function contentHash(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort()) {
    hash.update(`f\0${path}\0`);
    hash.update(files.get(path)!);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function runtimeDirName(manifest: BmadRuntimeManifest, content: string): string {
  const name = `${manifest.upstream.package}-${manifest.upstream.version}-` +
    `${manifest.customization.name}-${manifest.customization.version}-${content.slice(0, 20)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
    throw new BmadRuntimeError(`BMAD runtime identity produces an unsafe directory name: ${name}`);
  }
  return name;
}

/**
 * Load and verify the runtime bundle shipped with this package. Every file
 * must be declared with its hash, every declared file must be present and
 * unchanged, and no undeclared file may sit next to them. A broken bundle
 * fails here — never by borrowing a framework installed somewhere else.
 */
export function loadBundledBmadRuntime(packageRoot: string = PACKAGE_ROOT): BundledBmadRuntime {
  const bundleRoot = join(packageRoot, BMAD_RUNTIME_RESOURCE_DIR);
  const failure = (detail: string): BmadRuntimeError => new BmadRuntimeError(
    `Gru Command's bundled BMAD runtime (${bundleRoot}) failed verification: ${detail}. ` +
      'Reinstall or rebuild Gru Command; it never falls back to another BMAD installation.',
  );
  const manifestPath = join(bundleRoot, BMAD_RUNTIME_MANIFEST);
  let manifestBytes: Buffer;
  try {
    if (lstatSync(bundleRoot).isSymbolicLink() || lstatSync(manifestPath).isSymbolicLink()) {
      throw failure('the bundle or its manifest is a symlink');
    }
    manifestBytes = readFileSync(manifestPath);
  } catch (error) {
    if (error instanceof BmadRuntimeError) throw error;
    throw failure(`cannot read ${BMAD_RUNTIME_MANIFEST}: ${(error as Error).message}`);
  }
  let manifest: BmadRuntimeManifest;
  try {
    manifest = parseBmadRuntimeManifest(manifestBytes.toString('utf-8'), manifestPath);
  } catch (error) {
    throw failure((error as Error).message);
  }

  const rootEntries = readdirSync(bundleRoot).sort();
  const expectedRoot = [BMAD_RUNTIME_MANIFEST, 'gc', 'upstream'].sort();
  if (rootEntries.join('\0') !== expectedRoot.join('\0')) {
    throw failure(`bundle root must hold exactly ${expectedRoot.join(', ')}; found ${rootEntries.join(', ')}`);
  }
  const declared = new Map<string, string>();
  for (const [path, hash] of Object.entries(manifest.upstream.files)) declared.set(`upstream/${path}`, hash);
  for (const [path, hash] of Object.entries(manifest.customization.files)) declared.set(`gc/${path}`, hash);
  const present = new Set<string>();
  for (const area of ['upstream', 'gc']) {
    const root = join(bundleRoot, area);
    try {
      const info = lstatSync(root);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new BmadRuntimeError(`bundle ${area}/ is not a real directory`);
      for (const rel of listRegularFiles(root, `bundle ${area}/`)) present.add(`${area}/${rel}`);
    } catch (error) {
      if (error instanceof BmadRuntimeError) throw failure(error.message);
      throw failure(`cannot list ${area}/: ${(error as Error).message}`);
    }
  }
  const missing = [...declared.keys()].filter((path) => !present.has(path));
  if (missing.length > 0) throw failure(`missing pinned file(s): ${missing.join(', ')}`);
  const undeclared = [...present].filter((path) => !declared.has(path));
  if (undeclared.length > 0) throw failure(`undeclared file(s): ${undeclared.join(', ')}`);
  const bytes = new Map<string, Buffer>();
  for (const [path, hash] of declared) {
    const content = readFileSync(join(bundleRoot, path));
    if (sha256(content) !== hash) throw failure(`${path} does not match its pinned sha256`);
    bytes.set(path, content);
  }

  const files = new Map<string, Buffer>();
  const used = new Set<string>();
  for (const entry of manifest.layout) {
    const source = bytes.get(entry.from);
    if (source === undefined) throw failure(`layout ${entry.path} names an undeclared source ${entry.from}`);
    if (entry.path === BMAD_RUNTIME_MANIFEST || files.has(entry.path)) {
      throw failure(`layout path ${entry.path} is reserved or duplicated`);
    }
    if (entry.replaces !== undefined) {
      if (!entry.from.startsWith('gc/') || !bytes.has(entry.replaces) || !entry.replaces.startsWith('upstream/')) {
        throw failure(`overlay ${entry.path} must replace a declared upstream file with a gc file`);
      }
      used.add(entry.replaces);
    }
    used.add(entry.from);
    files.set(entry.path, source);
  }
  const unused = [...declared.keys()].filter((path) => !used.has(path));
  if (unused.length > 0) throw failure(`declared file(s) not placed in the runtime layout: ${unused.join(', ')}`);
  for (const skill of manifest.skills) {
    if (!files.has(`skills/${skill}/SKILL.md`)) throw failure(`skill ${skill} has no skills/${skill}/SKILL.md`);
  }
  files.set(BMAD_RUNTIME_MANIFEST, manifestBytes);
  const content = contentHash(files);
  return {
    id: manifest.id,
    manifest,
    contentSha256: content,
    dirName: runtimeDirName(manifest, content),
    files,
  };
}

/**
 * Verify a materialized runtime directory from its own bytes: its content
 * hash must still produce its directory name, and every declared skill must
 * be present. A modified or partial directory fails loud.
 */
export function inspectMaterializedBmadRuntime(dir: string): MaterializedBmadRuntime {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(dir);
  } catch (error) {
    throw new BmadRuntimeError(`BMAD runtime directory is missing: ${dir} (${(error as Error).message})`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new BmadRuntimeError(`BMAD runtime path is not a real directory: ${dir}`);
  }
  const files = new Map<string, Buffer>();
  for (const rel of listRegularFiles(dir, `BMAD runtime ${dir}`)) files.set(rel, readFileSync(join(dir, rel)));
  const manifestBytes = files.get(BMAD_RUNTIME_MANIFEST);
  if (manifestBytes === undefined) throw new BmadRuntimeError(`BMAD runtime ${dir} has no ${BMAD_RUNTIME_MANIFEST}`);
  const text = manifestBytes.toString('utf-8');
  // Only two known schemas: #283's retained runtimes and GC-owned delivery resources.
  // This is historical continuity, not ambient/arbitrary BMAD compatibility.
  let schema: unknown;
  try { schema = (JSON.parse(text) as { schema_version?: unknown }).schema_version; } catch {
    throw new BmadRuntimeError(`runtime manifest ${join(dir, BMAD_RUNTIME_MANIFEST)} is not valid JSON`);
  }
  const manifest = schema === 2
    ? parseWorkflowManifest(text, join(dir, BMAD_RUNTIME_MANIFEST))
    : parseBmadRuntimeManifest(text, join(dir, BMAD_RUNTIME_MANIFEST));
  if (manifest.schema_version === 2) verifyWorkflowFiles(manifest, files);
  const content = contentHash(files);
  const expectedName = manifest.schema_version === 2 ? workflowDirName(manifest, content) : runtimeDirName(manifest, content);
  if (basename(dir) !== expectedName) {
    throw new BmadRuntimeError(
      `BMAD runtime ${dir} was modified after it was installed (its content no longer matches its name)`,
    );
  }
  for (const skill of manifest.skills) {
    if (!files.has(`skills/${skill}/SKILL.md`)) throw new BmadRuntimeError(`BMAD runtime ${dir} lacks skill ${skill}`);
  }
  return { id: manifest.id, dir, contentSha256: content, skillsDir: join(dir, 'skills'), skills: manifest.skills };
}

/**
 * Compose the verified bundle into `<storeRoot>/<dirName>` (read-only files),
 * or verify the copy already there. Content-addressed: a directory name
 * names exactly one set of bytes, so concurrent writers converge.
 */
export function materializeBmadRuntime(runtime: RuntimeBundle, storeRoot: string): MaterializedBmadRuntime {
  mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  if (lstatSync(storeRoot).isSymbolicLink()) {
    throw new BmadRuntimeError(`BMAD runtime store is a symlink: ${storeRoot}`);
  }
  const target = join(storeRoot, runtime.dirName);
  const verified = (): MaterializedBmadRuntime => {
    const existing = inspectMaterializedBmadRuntime(target);
    if (existing.contentSha256 !== runtime.contentSha256) {
      throw new BmadRuntimeError(`BMAD runtime ${target} does not hold runtime ${runtime.id}`);
    }
    return existing;
  };
  if (existsSync(target)) return verified();
  const staging = mkdtempSync(join(storeRoot, '.staging-'));
  try {
    for (const path of [...runtime.files.keys()].sort()) {
      const file = join(staging, ...path.split('/'));
      mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
      writeFileSync(file, runtime.files.get(path)!, { mode: 0o444, flag: 'wx' });
    }
    try {
      renameSync(staging, target);
    } catch (error) {
      // A concurrent writer published the same content-addressed directory.
      if (!existsSync(target)) throw error;
    }
    return verified();
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The one launcher command a bundled skill tells the agent to run, with its
 * placeholders bound to environment variables (paths are never spliced
 * into shell text, so a quote or `$(…)` in a directory name stays inert).
 */
export function skillLauncherCommand(
  runtime: MaterializedBmadRuntime,
  skill: string,
  projectRoot: string,
): { readonly command: string; readonly env: Readonly<Record<string, string>> } {
  const skillRoot = join(runtime.skillsDir, skill);
  const text = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8');
  const block = /```bash\n([^\n]+)\n```/u.exec(text);
  if (block?.[1] === undefined) throw new BmadRuntimeError(`${skill}/SKILL.md has no launcher command block`);
  if (!/"\{project-root\}/u.test(block[1]) || !/"\{skill-root\}/u.test(block[1])) {
    throw new BmadRuntimeError(`${skill}/SKILL.md launcher must double-quote its {project-root} and {skill-root} paths`);
  }
  return {
    command: block[1].split('{project-root}').join('${GC_BMAD_PROJECT_ROOT}').split('{skill-root}').join('${GC_BMAD_SKILL_ROOT}'),
    env: { GC_BMAD_PROJECT_ROOT: projectRoot, GC_BMAD_SKILL_ROOT: skillRoot },
  };
}

interface BindingRecord {
  readonly schema_version: 1;
  readonly runtime_id: string;
  readonly runtime_dir: string;
  readonly content_sha256: string;
  readonly bound_at: string;
}

function parseBindingRecord(text: string, source: string): BindingRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new BmadRuntimeError(`BMAD runtime binding ${source} is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(raw) || raw['schema_version'] !== 1 ||
      typeof raw['content_sha256'] !== 'string' || !/^[0-9a-f]{64}$/u.test(raw['content_sha256'])) {
    throw new BmadRuntimeError(`BMAD runtime binding ${source} is malformed`);
  }
  return {
    schema_version: 1,
    runtime_id: requireString(raw['runtime_id'], 'runtime_id'),
    runtime_dir: requireString(raw['runtime_dir'], 'runtime_dir'),
    content_sha256: raw['content_sha256'],
    bound_at: requireString(raw['bound_at'], 'bound_at'),
  };
}

/** The lane's private git dir, or null when `cwd` is not a linked worktree. */
function laneGitDir(cwd: string): string | null {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (result.error === undefined && result.status === 128 && /not a git repository/iu.test(result.stderr ?? '')) {
    return null;
  }
  if (result.error !== undefined || result.status !== 0) {
    // Never guess: a lane whose binding cannot be read must not silently
    // switch to whatever runtime ships today.
    throw new BmadRuntimeError(
      `cannot resolve the git dir of ${cwd} to read its BMAD runtime binding: ` +
        `${result.error?.message ?? (result.stderr ?? '').trim()}`,
    );
  }
  const [gitDir, commonDir] = result.stdout.trim().split('\n').map((line) => realpathSync(line.trim()));
  if (gitDir === undefined || commonDir === undefined) {
    throw new BmadRuntimeError(`git reported no git dir for ${cwd}`);
  }
  return gitDir === commonDir ? null : gitDir;
}

export interface BmadRuntimeBinderOptions {
  /** Where runtimes are materialized (`<dataDir>/bmad-runtime`). */
  readonly storeRoot: string;
  /** The verified runtime this GC build ships (memoize it: one bundle per process). */
  readonly bundled: () => RuntimeBundle;
  /** Test seam: runs just before a first binding is published (race proofs). */
  readonly beforePublish?: () => void;
}

/**
 * Bind a session's working directory to a runtime. A linked git worktree (a
 * job lane) records its binding in its private git dir the first time and
 * keeps it for the life of the lane: a later GC update never switches it.
 * Any other directory uses the runtime this build ships, unrecorded.
 */
export function bindBmadRuntime(cwd: string, options: BmadRuntimeBinderOptions): BmadRuntimeBinding {
  const gitDir = laneGitDir(cwd);
  if (gitDir === null) {
    return { ...materializeBmadRuntime(options.bundled(), options.storeRoot), bindingFile: null };
  }
  const bindingFile = join(gitDir, BINDING_FILE);
  if (existsSync(bindingFile)) return boundRuntime(cwd, bindingFile, options);
  const runtime = materializeBmadRuntime(options.bundled(), options.storeRoot);
  const record: BindingRecord = {
    schema_version: 1,
    runtime_id: runtime.id,
    runtime_dir: runtime.dir,
    content_sha256: runtime.contentSha256,
    bound_at: new Date().toISOString(),
  };
  mkdirSync(dirname(bindingFile), { recursive: true });
  const tmp = `${bindingFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx', mode: 0o644 });
    options.beforePublish?.();
    // Publish without replacement: when another process bound this lane
    // first (possibly to a different runtime), its binding wins.
    linkSync(tmp, bindingFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return boundRuntime(cwd, bindingFile, options);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { ...runtime, bindingFile };
}

/** The runtime a lane's existing binding record names — never another one. */
function boundRuntime(cwd: string, bindingFile: string, options: BmadRuntimeBinderOptions): BmadRuntimeBinding {
  const record = parseBindingRecord(readFileSync(bindingFile, 'utf-8'), bindingFile);
  if (dirname(record.runtime_dir) !== options.storeRoot) {
    throw new BmadRuntimeError(
      `BMAD runtime binding ${bindingFile} names ${record.runtime_dir}, outside the runtime store ${options.storeRoot}`,
    );
  }
  let bound: MaterializedBmadRuntime;
  try {
    bound = inspectMaterializedBmadRuntime(record.runtime_dir);
  } catch (error) {
    // The very same bytes still ship with this build: restoring them is
    // not a switch. Anything else fails loud — the job keeps its runtime.
    const current = options.bundled();
    if (current.contentSha256 !== record.content_sha256 ||
        join(options.storeRoot, current.dirName) !== record.runtime_dir) {
      throw new BmadRuntimeError(
        `job lane ${cwd} is bound to BMAD runtime ${record.runtime_id} at ${record.runtime_dir}, ` +
          `which is unusable: ${(error as Error).message}. A running job never switches runtimes ` +
          'silently: restore that runtime directory, or retire the lane and dispatch the job again.',
      );
    }
    bound = materializeBmadRuntime(current, options.storeRoot);
  }
  if (bound.contentSha256 !== record.content_sha256 || bound.id !== record.runtime_id) {
    throw new BmadRuntimeError(
      `job lane ${cwd} is bound to BMAD runtime ${record.runtime_id} (content ${record.content_sha256}), ` +
        `but ${record.runtime_dir} holds ${bound.id} (content ${bound.contentSha256})`,
    );
  }
  return { ...bound, bindingFile };
}

/** A process-wide binder: the bundle is read and verified once, on first use. */
export function createBmadRuntimeBinder(storeRoot: string, packageRoot: string = PACKAGE_ROOT): (cwd: string) => ManagedSkillSet {
  let bundle: BundledBmadRuntime | undefined;
  const bundled = (): BundledBmadRuntime => (bundle ??= loadBundledBmadRuntime(packageRoot));
  return (cwd) => managedSkillSet(bindBmadRuntime(cwd, { storeRoot, bundled }));
}

export function managedSkillSet(binding: BmadRuntimeBinding): ManagedSkillSet {
  return {
    source: BMAD_RUNTIME_SOURCE,
    runtimeId: binding.id,
    contentSha256: binding.contentSha256,
    root: binding.dir,
    skillsDir: binding.skillsDir,
    skills: binding.skills,
    laneBound: binding.bindingFile !== null,
  };
}
