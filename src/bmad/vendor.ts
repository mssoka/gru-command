import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BMAD_RUNTIME_MANIFEST,
  BMAD_RUNTIME_RESOURCE_DIR,
  BmadRuntimeError,
  bmadRuntimeId,
  parseBmadRuntimeManifest,
  type BmadRuntimeLayoutEntry,
  type BmadRuntimeManifest,
} from './runtime.js';

/**
 * Maintainer side of the bundled BMAD runtime (docs/BMAD-RUNTIME.md,
 * "Upgrading the bundled runtime"). The supported set is declared here:
 * the upstream files the GC build path actually reaches. Upgrading is a
 * deliberate, reviewed change — vendor a new upstream package, regenerate
 * the manifest, review the diff, run the tests — never a download at run time.
 */

/** Upstream package files bundled verbatim (package-relative paths). */
export const BMAD_UPSTREAM_FILES = ['LICENSE', 'src/scripts/render_skill.py', 'src/scripts/config_utils.py'] as const;
/** Bundled skills → their upstream package directory (copied whole). */
export const BMAD_UPSTREAM_SKILLS: Readonly<Record<string, string>> = {
  'bmad-build': 'src/bmm-skills/ship/bmad-build',
};
/** Skills the bundled workflows name only as optional, human-facing next steps. */
export const BMAD_OPTIONAL_SKILL_REFERENCES = ['bmad-advanced-elicitation', 'bmad-party-mode', 'bmad-walkthrough'] as const;

export interface UpstreamIdentity {
  readonly package: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
  readonly repository: string;
  readonly git_head: string;
  readonly license: string;
}

export interface CustomizationIdentity {
  readonly name: string;
  readonly version: number;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function regularFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    const info = lstatSync(join(root, rel));
    if (info.isSymbolicLink()) throw new BmadRuntimeError(`refusing symlink in bundle source: ${rel}`);
    if (info.isDirectory()) out.push(...regularFiles(root, rel));
    else if (info.isFile()) out.push(rel);
    else throw new BmadRuntimeError(`refusing non-regular bundle source: ${rel}`);
  }
  return out;
}

function hashes(root: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(root, file)))]));
}

/** The composed layout follows from the declared sources plus the GC tree. */
function layoutFor(upstreamFiles: readonly string[], gcFiles: readonly string[]): BmadRuntimeLayoutEntry[] {
  const layout: BmadRuntimeLayoutEntry[] = [];
  const gc = new Set(gcFiles);
  for (const file of upstreamFiles) {
    if (file === 'LICENSE') layout.push({ path: 'LICENSE', from: 'upstream/LICENSE' });
    else if (file.startsWith('src/scripts/')) {
      layout.push({ path: `scripts/${file.slice('src/scripts/'.length)}`, from: `upstream/${file}` });
    }
  }
  for (const [skill, source] of Object.entries(BMAD_UPSTREAM_SKILLS)) {
    for (const file of upstreamFiles.filter((path) => path.startsWith(`${source}/`))) {
      const rel = file.slice(source.length + 1);
      const overlay = `skills/${skill}/${rel}`;
      if (gc.has(overlay)) {
        layout.push({ path: overlay, from: `gc/${overlay}`, replaces: `upstream/${file}` });
        gc.delete(overlay);
      } else {
        layout.push({ path: overlay, from: `upstream/${file}` });
      }
    }
  }
  for (const file of gc) layout.push({ path: file, from: `gc/${file}` });
  return layout.sort((left, right) => left.path.localeCompare(right.path));
}

/** Regenerate `runtime.json` from the bundle trees on disk. */
export function writeBmadRuntimeManifest(
  bundleRoot: string,
  upstream: UpstreamIdentity,
  customization: CustomizationIdentity,
): BmadRuntimeManifest {
  const upstreamFiles = regularFiles(join(bundleRoot, 'upstream'));
  const gcFiles = regularFiles(join(bundleRoot, 'gc'));
  const manifest: BmadRuntimeManifest = {
    schema_version: 1,
    id: bmadRuntimeId({ upstream: { ...upstream, files: {} }, customization: { ...customization, files: {} } }),
    upstream: { ...upstream, files: hashes(join(bundleRoot, 'upstream'), upstreamFiles) },
    customization: { ...customization, files: hashes(join(bundleRoot, 'gc'), gcFiles) },
    skills: Object.keys(BMAD_UPSTREAM_SKILLS).sort(),
    optional_skill_references: [...BMAD_OPTIONAL_SKILL_REFERENCES],
    layout: layoutFor(upstreamFiles, gcFiles),
  };
  writeFileSync(join(bundleRoot, BMAD_RUNTIME_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function readBmadRuntimeManifest(bundleRoot: string): BmadRuntimeManifest {
  const path = join(bundleRoot, BMAD_RUNTIME_MANIFEST);
  return parseBmadRuntimeManifest(readFileSync(path, 'utf-8'), path);
}

/** npm's integrity string for a tarball: `sha512-<base64>`. */
export function tarballIntegrity(tarball: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
}

/**
 * Vendor from the registry tarball itself (`npm pack bmad-method@<version>`):
 * its sha512 must equal the recorded integrity (`npm view … dist.integrity`)
 * before any byte is used, so runtime.json's provenance is checked, not
 * merely declared.
 */
export function vendorBmadTarball(
  packageRoot: string,
  tarball: string,
  upstream: UpstreamIdentity,
  customization: CustomizationIdentity,
): BmadRuntimeManifest {
  const actual = tarballIntegrity(tarball);
  if (actual !== upstream.integrity) {
    throw new BmadRuntimeError(`${tarball} has integrity ${actual}, not the recorded ${upstream.integrity}`);
  }
  const extract = mkdtempSync(join(tmpdir(), 'gru-command-bmad-vendor-'));
  try {
    const untar = spawnSync('tar', ['-xzf', tarball, '-C', extract], { encoding: 'utf-8' });
    if (untar.status !== 0) throw new BmadRuntimeError(`cannot extract ${tarball}: ${untar.stderr || untar.error?.message}`);
    return vendorBmadUpstream(packageRoot, join(extract, 'package'), upstream, customization);
  } finally {
    rmSync(extract, { recursive: true, force: true });
  }
}

/**
 * Replace `upstream/` with the declared file set from an extracted upstream
 * package, then regenerate the manifest with the new upstream identity.
 * Use vendorBmadTarball: it verifies the archive first.
 */
export function vendorBmadUpstream(
  packageRoot: string,
  upstreamPackageDir: string,
  upstream: UpstreamIdentity,
  customization: CustomizationIdentity,
): BmadRuntimeManifest {
  const pkg = JSON.parse(readFileSync(join(upstreamPackageDir, 'package.json'), 'utf-8')) as {
    name?: string;
    version?: string;
  };
  if (pkg.name !== upstream.package || pkg.version !== upstream.version) {
    throw new BmadRuntimeError(
      `${upstreamPackageDir} is ${pkg.name}@${pkg.version}, not ${upstream.package}@${upstream.version}`,
    );
  }
  const sources = [
    ...BMAD_UPSTREAM_FILES,
    ...Object.values(BMAD_UPSTREAM_SKILLS).flatMap((dir) =>
      regularFiles(upstreamPackageDir, dir).filter((file) => !file.split('/').includes('__pycache__'))),
  ];
  for (const file of sources) {
    if (!existsSync(join(upstreamPackageDir, file))) {
      throw new BmadRuntimeError(`upstream package lacks declared file ${file}; review the supported set`);
    }
  }
  const bundleRoot = join(packageRoot, BMAD_RUNTIME_RESOURCE_DIR);
  rmSync(join(bundleRoot, 'upstream'), { recursive: true, force: true });
  for (const file of sources) {
    const target = join(bundleRoot, 'upstream', file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(upstreamPackageDir, file), target);
  }
  return writeBmadRuntimeManifest(bundleRoot, upstream, customization);
}
