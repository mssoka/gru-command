import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorktreeManifest } from '../worktrees/manifest.js';
import { matrixRowFor } from './adapters/matrix.js';
import { detectVitestFastCheck, resolveVitestBinary } from './adapters/vitest-fast-check.js';
import type {
  ManifestEvidenceEntry,
  PackageResolution,
  PackageResolutionStatus,
  PropertyCapabilityReport,
  PropertyDetectionContext,
  PropertyDetectionResult,
  ToolingLadder,
  ToolingState,
} from './types.js';

/**
 * GH350 capability resolution (issue §1): read-only, target-package-scoped
 * discovery of property-testing tooling. Manifest→framework mappings are
 * HINTS: every claim is backed by lockfile/installed-module/binary evidence
 * recorded per row, and the root manifest never decides for nested
 * packages. No writes, no installs, no network — ever.
 */

const MAX_WALK_DEPTH = 6;
const MAX_WALK_ENTRIES = 20_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.venv', 'coverage', '__pycache__']);

const NODE_MANIFEST = 'package.json';
const MANIFEST_BY_KIND: readonly { readonly file: string; readonly ecosystem: string }[] = [
  { file: NODE_MANIFEST, ecosystem: 'node-typescript' },
  { file: 'pyproject.toml', ecosystem: 'python' },
  { file: 'Cargo.toml', ecosystem: 'rust' },
  { file: 'go.mod', ecosystem: 'go' },
  { file: 'mix.exs', ecosystem: 'elixir' },
  { file: 'gleam.toml', ecosystem: 'gleam' },
];
const NODE_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];

export class ResolutionWalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionWalkError';
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function toPosix(path: string): string {
  return path.includes('\\') ? path.split('\\').join('/') : path;
}

interface DirectoryScan {
  readonly dirs: readonly string[];
  readonly files: ReadonlySet<string>;
}

/** One bounded, non-symlink-following directory listing. Symlinked entries
 * report as neither file nor directory here and are skipped — manifest
 * symlinks are never trusted resolution input. */
function scanDirectory(absolute: string, relativeDir: string): DirectoryScan {
  let entries: readonly import('node:fs').Dirent[];
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    throw new ResolutionWalkError(`capability scan could not read ${relativeDir === '' ? '.' : relativeDir}: ${String(error)}`);
  }
  const dirs: string[] = [];
  const files = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(entry.name);
    else if (entry.isFile()) files.add(entry.name);
  }
  return { dirs: dirs.sort(), files };
}

/** Read a bounded regular file; named error for unreadable/oversized. */
function readBounded(absolute: string, label: string): string {
  let info;
  try {
    info = lstatSync(absolute);
  } catch (error) {
    throw new ResolutionWalkError(`${label} is unreadable: ${String(error)}`);
  }
  if (!info.isFile()) throw new ResolutionWalkError(`${label} is not a regular file`);
  if (info.size > MAX_MANIFEST_BYTES) throw new ResolutionWalkError(`${label} exceeds ${MAX_MANIFEST_BYTES} bytes`);
  try {
    return readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new ResolutionWalkError(`${label} could not be read: ${String(error)}`);
  }
}

function evidenceFor(repoRoot: string, relative: string, role: ManifestEvidenceEntry['role']): ManifestEvidenceEntry | null {
  try {
    return { path: relative, role, sha256: sha256(readBounded(join(repoRoot, relative), relative)) };
  } catch {
    return null;
  }
}

function row(
  packageDir: string,
  ecosystem: string | null,
  status: PackageResolutionStatus,
  adapterId: string | null,
  tooling: ToolingLadder | null,
  reasons: readonly string[],
  evidence: readonly ManifestEvidenceEntry[],
): PackageResolution {
  return {
    packageDir: packageDir === '' ? '.' : packageDir,
    ecosystem,
    status,
    adapterId,
    tooling,
    reasons,
    evidence,
    resolutionKey: sha256(
      evidence.map((entry) => `${entry.path}\u0000${entry.sha256}`).sort().join('\n') ||
        `${packageDir}\u0000no-evidence`,
    ),
  };
}

/** Node ladder: declared → locked → installed → runnable, with the
 * manifest claim as hint only. A missing binary is a resolved PLANNING
 * row with executable:false, never a guessed install. */
function ladderForNode(context: PropertyDetectionContext, detected: PropertyDetectionResult): {
  readonly status: PackageResolutionStatus;
  readonly ladder: ToolingLadder | null;
  readonly reasons: readonly string[];
} {
  const reasons = [...detected.reasons];
  if (!detected.compatible) {
    const missing = reasons.some((reason) => reason.includes('is not declared'));
    return { status: missing ? 'missing-dependency' : 'ambiguous', ladder: null, reasons };
  }
  const { versions } = detected;
  const lockedVitest = versions['vitest@locked'] ?? null;
  const lockedFastCheck = versions['fast-check@locked'] ?? null;
  const installedVitest = versions['vitest@installed'] ?? null;
  const installedFastCheck = versions['fast-check@installed'] ?? null;
  if (lockedVitest === null && lockedFastCheck === null && installedVitest === null && installedFastCheck === null) {
    reasons.push('install state unverified: no lockfile entry and no installed module proves vitest or fast-check — manifest claims alone are hints');
    return { status: 'ambiguous', ladder: null, reasons };
  }
  const libraries: Record<string, ToolingState> = {
    'fast-check': installedFastCheck !== null ? 'installed' : lockedFastCheck !== null ? 'locked' : 'declared',
  };
  if (installedVitest !== null) {
    const binary = resolveVitestBinary(context.repoRoot, context.packageDir);
    if (binary.path === null) {
      reasons.push(binary.reason ?? 'runner binary not resolvable');
      return {
        status: 'resolved',
        ladder: { runner: 'declared', libraries, executable: false, reasons: [binary.reason ?? 'runner binary not resolvable'] },
        reasons,
      };
    }
    reasons.push(`runner binary resolved (contained): ${toPosix(binary.path)}`);
    return {
      status: 'resolved',
      ladder: { runner: 'runnable', libraries, executable: installedFastCheck !== null, reasons: [] },
      reasons,
    };
  }
  reasons.push('lockfile proves locked dependencies only — not installed or runnable tooling');
  return {
    status: 'resolved',
    ladder: { runner: lockedVitest !== null ? 'locked' : 'declared', libraries, executable: false, reasons: ['lockfile proof is not install proof'] },
    reasons,
  };
}

function resolveNodePackage(
  repoRoot: string,
  packageDir: string,
  approvedCommands: Readonly<Record<string, string>>,
  evidence: readonly ManifestEvidenceEntry[],
): PackageResolution {
  const manifestPath = packageDir === '' ? NODE_MANIFEST : `${packageDir}/${NODE_MANIFEST}`;
  let manifestText: string;
  try {
    manifestText = readBounded(join(repoRoot, manifestPath), manifestPath);
  } catch (error) {
    return row(packageDir, 'node-typescript', 'invalid-manifest', null, null, [String(error)], evidence);
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestText) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    return row(packageDir, 'node-typescript', 'invalid-manifest', null, null, [`${manifestPath} is malformed JSON (${String(error)})`], evidence);
  }
  const lockfiles: { readonly path: string; readonly text: string }[] = [];
  for (const base of new Set(packageDir === '' ? [''] : ['', packageDir])) {
    for (const lock of NODE_LOCKFILES) {
      const relative = base === '' ? lock : `${base}/${lock}`;
      try {
        lockfiles.push({ path: relative, text: readBounded(join(repoRoot, relative), relative) });
      } catch {
        // absent lockfile at this location
      }
    }
  }
  const context: PropertyDetectionContext = { repoRoot, packageDir: join(repoRoot, packageDir), manifest, lockfiles, approvedCommands };
  const detected = detectVitestFastCheck(context);
  const ladder = ladderForNode(context, detected);
  const approved = Object.entries(approvedCommands)
    .filter(([, command]) => command.includes('vitest'))
    .map(([scope, command]) => `approved project command names vitest (${scope}: ${command})`);
  return row(
    packageDir,
    'node-typescript',
    ladder.status,
    ladder.status === 'resolved' || ladder.status === 'ambiguous' ? 'vitest-fast-check' : null,
    ladder.ladder,
    [...ladder.reasons, ...approved],
    evidence,
  );
}

/** Resolve property-testing capabilities for one repository. Pure read;
 * deterministic: same bytes in, same rows out. */
export function resolvePropertyCapabilities(input: {
  readonly repoRoot: string;
  readonly scopePaths?: readonly string[];
}): PropertyCapabilityReport {
  const rootInfo = lstatSync(input.repoRoot);
  if (!rootInfo.isDirectory()) throw new ResolutionWalkError(`repoRoot is not a directory: ${input.repoRoot}`);
  const approvedCommands = loadWorktreeManifest(input.repoRoot)?.verify ?? {};
  const candidates: { readonly dir: string; readonly manifest: string }[] = [];
  let walked = 0;

  const walk = (relativeDir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    walked += 1;
    if (walked > MAX_WALK_ENTRIES) throw new ResolutionWalkError(`capability scan exceeded ${MAX_WALK_ENTRIES} directories`);
    const scan = scanDirectory(join(input.repoRoot, relativeDir), relativeDir);
    // Nested package manifests are discovered by the walk itself: the ROOT
    // manifest never decides for a nested package (issue §1).
    for (const kind of MANIFEST_BY_KIND) {
      if (scan.files.has(kind.file)) {
        candidates.push({ dir: relativeDir, manifest: kind.file });
        break;
      }
    }
    for (const name of scan.dirs) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      walk(relativeDir === '' ? name : `${relativeDir}/${name}`, depth + 1);
    }
  };
  walk('', 0);

  const inScope = (packageDir: string): boolean => {
    if (input.scopePaths === undefined || input.scopePaths.length === 0) return true;
    const normalized = packageDir === '.' ? '' : packageDir;
    return input.scopePaths.some((raw) => {
      const scope = toPosix(raw).replace(/^\.\//u, '');
      return scope === normalized || (normalized !== '' && scope.startsWith(`${normalized}/`));
    });
  };

  const rows: PackageResolution[] = [];
  for (const candidate of candidates) {
    const packageDir = candidate.dir === '' ? '.' : candidate.dir;
    if (!inScope(packageDir)) continue;
    if (candidate.manifest === NODE_MANIFEST) {
      const evidence: ManifestEvidenceEntry[] = [];
      const bases = packageDir === '.' ? [''] : ['', packageDir];
      for (const base of new Set(bases)) {
        const push = (relative: string, role: ManifestEvidenceEntry['role']): void => {
          const entry = evidenceFor(input.repoRoot, relative, role);
          if (entry !== null) evidence.push(entry);
        };
        push(base === '' ? NODE_MANIFEST : `${base}/${NODE_MANIFEST}`, 'manifest');
        for (const lock of NODE_LOCKFILES) push(base === '' ? lock : `${base}/${lock}`, 'lockfile');
        for (const tool of ['vitest', 'fast-check']) {
          push(base === '' ? `node_modules/${tool}/package.json` : `${base}/node_modules/${tool}/package.json`, 'installed-module');
        }
      }
      rows.push(resolveNodePackage(input.repoRoot, candidate.dir, approvedCommands, evidence));
      continue;
    }
    const ecosystem = MANIFEST_BY_KIND.find((kind) => kind.file === candidate.manifest)!.ecosystem;
    const manifestPath = candidate.dir === '' ? candidate.manifest : `${candidate.dir}/${candidate.manifest}`;
    const evidence: ManifestEvidenceEntry[] = [];
    const manifestEvidence = evidenceFor(input.repoRoot, manifestPath, 'manifest');
    if (manifestEvidence !== null) evidence.push(manifestEvidence);
    const matrixRow = matrixRowFor(ecosystem);
    rows.push(
      manifestEvidence === null
        ? row(candidate.dir, ecosystem, 'invalid-manifest', null, null, [`${manifestPath} is unreadable`], evidence)
        : row(candidate.dir, ecosystem, 'unsupported-ecosystem', null, null, [
            `${ecosystem} has no shipped adapter (matrix row: ${matrixRow?.adapterId ?? 'unknown'}, status ${matrixRow?.status ?? 'unknown'}) — see docs/PROPERTY-CONTRACTS.md`,
          ], evidence),
    );
  }

  if (rows.length === 0) {
    const evidence: ManifestEvidenceEntry[] = [];
    const configEvidence = evidenceFor(input.repoRoot, '.gru-command/worktree.toml', 'config');
    if (configEvidence !== null) evidence.push(configEvidence);
    rows.push(
      row('.', null, 'no-tooling', null, null, [input.scopePaths !== undefined && input.scopePaths.length > 0 ? 'no supported ecosystem manifest within the scan bounds intersects the requested scope' : 'no supported ecosystem manifest discovered within the scan bounds'], evidence),
    );
  }

  return {
    repoRoot: input.repoRoot,
    packages: rows.sort((left, right) => left.packageDir.localeCompare(right.packageDir)),
    scoped: input.scopePaths !== undefined && input.scopePaths.length > 0,
  };
}
