import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, opendirSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { openCheckpoint } from '../dispatch/perkins-review/artifacts.js';
import { PUBLIC_DEPENDENCY_NAMES, PUBLIC_LOADER_KEYS, PUBLIC_LOADER_TARGETS } from './public-loader-fields.js';
import { checkedReviewDirectoryEntries, checkedReviewFileBytes, reviewDirectoryTree } from './review-directory-entries.js';
import { PUBLIC_REVIEW_EXECUTABLE_PATHS } from './review-executable-paths.js';

interface FileReceipt {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly nlink: bigint;
}

interface DirectoryReceipt {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function directoryReceipt(fd: number): DirectoryReceipt {
  const info = fstatSync(fd, { bigint: true });
  if (!info.isDirectory()) throw new Error('review runtime directory is not a checked directory');
  return { dev: info.dev, ino: info.ino, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
}

function assertDirectoryReceipt(fd: number, expected: DirectoryReceipt): void {
  const current = directoryReceipt(fd);
  if (current.dev !== expected.dev || current.ino !== expected.ino ||
    current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs) {
    throw new Error('review runtime directory changed during child selection');
  }
}

function assertFileReceipt(fd: number, expected: FileReceipt): void {
  const current = fstatSync(fd, { bigint: true });
  if (!current.isFile() || current.dev !== expected.dev || current.ino !== expected.ino ||
    current.size !== expected.size || current.mtimeNs !== expected.mtimeNs ||
    current.ctimeNs !== expected.ctimeNs || current.nlink !== expected.nlink) {
    throw new Error('review runtime file changed during fingerprint');
  }
}

interface InstalledPackage {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly imports?: unknown;
  readonly main?: string;
  readonly type?: string;
  readonly piConfig?: unknown;
}

/** Installed closure reads are always anchored to no-follow descriptors. In
 * particular, no pathname read may race a checked symlink or block on a FIFO. */
function descriptorBytes(fd: number, path: string, beforeRead?: () => void,
  record?: (receipt: FileReceipt) => void): Buffer {
  const before = fstatSync(fd, { bigint: true });
  const limit = 32n * 1024n * 1024n;
  if (!before.isFile() || before.nlink !== 1n || before.size > limit) {
    throw new Error('review runtime file must be bounded, regular and single-linked');
  }
  const receipt: FileReceipt = { path, dev: before.dev, ino: before.ino, size: before.size,
    mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs, nlink: before.nlink };
  beforeRead?.();
  const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
  let count = 0;
  while (count < bytes.length) {
    const size = readSync(fd, bytes, count, bytes.length - count, null);
    if (size === 0) break;
    count += size;
  }
  if (BigInt(count) !== before.size) throw new Error(`review runtime file changed during read: ${path}`);
  assertFileReceipt(fd, receipt);
  record?.(receipt);
  return bytes.subarray(0, count);
}

function regularBytes(path: string, parentFd: number,
  listing?: Parameters<typeof checkedReviewFileBytes>[1], beforeRead?: () => void,
  record?: (receipt: FileReceipt) => void): Buffer {
  // Linux resolves the child against the held directory, not the installed
  // package's mutable pathname. Darwin authenticates the reopened child
  // against the inherited-FD listing before reading any bytes.
  const fd = process.platform === 'linux'
    ? openSync(`/proc/self/fd/${parentFd}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    : openCheckpoint(dirname(path), basename(path));
  try {
    return process.platform === 'linux' ? descriptorBytes(fd, path, beforeRead, record)
      : checkedReviewFileBytes(parentFd, listing, basename(path), fd,
        () => descriptorBytes(fd, path, beforeRead, record));
  } finally { closeSync(fd); }
}

function directoryEntries(path: string, fd: number, tree?: ReturnType<typeof reviewDirectoryTree>, prefix = ''): readonly string[] {
  if (!fstatSync(fd).isDirectory()) throw new Error(`review runtime directory is not regular: ${path}`);
  if (process.platform === 'darwin') return checkedReviewDirectoryEntries(fd, tree?.get(prefix));
  const stream = opendirSync(`/proc/self/fd/${fd}`);
  try {
    const names: string[] = [];
    let entry;
    while ((entry = stream.readSync()) !== null) {
      if (names.length >= 65_536) throw new Error(`review runtime directory exceeds the entry bound: ${path}`);
      names.push(entry.name);
    }
    return names.sort();
  } finally { stream.closeSync(); }
}

function checkedJsonRecord(bytes: Buffer, kind: 'dependency' | 'build'): Buffer {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new Error(`review ${kind} identity is invalid — rebuild the installed package`); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`review ${kind} identity has an unsafe schema`);
  }
  const fields = parsed as Record<string, unknown>;
  if (kind === 'dependency') {
    if (Object.keys(fields).sort().join(',') !== 'dependencySha256,schemaVersion' || fields['schemaVersion'] !== 1 ||
      typeof fields['dependencySha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(fields['dependencySha256'])) {
      throw new Error('review dependency identity has an unsafe schema');
    }
    return Buffer.from(JSON.stringify([fields['schemaVersion'], fields['dependencySha256']]));
  }
  const rev = fields['rev'];
  const committedAt = fields['committedAt'];
  const builtAt = fields['builtAt'];
  const gitDate = typeof committedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u.test(committedAt) &&
    Number.isFinite(Date.parse(committedAt));
  if (Object.keys(fields).sort().join(',') !== 'builtAt,committedAt,rev' ||
    !(rev === null || (typeof rev === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(rev))) ||
    !(committedAt === null || gitDate) || (rev === null && committedAt !== null) ||
    typeof builtAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(builtAt) ||
    !Number.isFinite(Date.parse(builtAt))) {
    throw new Error('review build identity has an unsafe schema');
  }
  // builtAt is valid metadata for the UI, not executable behavior.
  return Buffer.from(JSON.stringify([rev, committedAt]));
}

function safeLoaderMetadata(value: unknown): unknown {
  if (value === undefined) return null;
  // These are audited literal public loader spellings, not lexical path
  // tests. A newly installed spelling must be audited before it is hashed.
  if (typeof value === 'string') {
    if (!PUBLIC_LOADER_TARGETS.has(value)) throw new Error('unsafe installed dependency loader metadata');
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(safeLoaderMetadata);
  if (typeof value !== 'object') throw new Error('unsafe installed dependency loader metadata');
  for (const [key, entry] of Object.entries(value)) {
    if (!PUBLIC_LOADER_KEYS.has(key)) throw new Error('unsafe installed dependency loader metadata');
    safeLoaderMetadata(entry);
  }
  return value;
}

function safePiConfig(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid installed piConfig metadata');
  const object = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(object)) {
    // The packaged Pi config directory is .pi. .other-pi is an explicitly
    // audited public test variant proving a changed config changes identity.
    if (!((key === 'configDir' && (field === '.pi' || field === '.other-pi')) ||
      (key === 'name' && field === 'pi'))) {
      throw new Error('unknown or unsafe installed piConfig metadata');
    }
  }
  return object;
}

/** Only validated non-secret loader fields and installed executable/catalog
 * bytes enter the digest. Credentials and arbitrary package metadata do not. */
export function reviewServiceRuntimeIdentity(
  registry: { runtimeIdFor(role: 'perkins'): string }, packageRoot: string,
): { readonly id: string; readonly version: string } {
  return { id: registry.runtimeIdFor('perkins'), version: reviewRuntimeVersion(packageRoot) };
}

export function reviewRuntimeVersion(packageRoot: string): string {
  const root = resolve(packageRoot);
  const digest = createHash('sha256');
  digest.update('gru-review-runtime-v2\0');
  const record = (kind: 'file' | 'package' | 'missing-optional', ...fields: readonly (string | Buffer)[]): void => {
    // Kind, field count and every byte length are explicit. No file content
    // can impersonate a subsequent path or a different record kind.
    const parts = [Buffer.from(kind), ...fields.map((field) =>
      typeof field === 'string' ? Buffer.from(field) : field)];
    if (parts.some((part) => part.length > 0xffffffff)) throw new Error('review runtime hash record exceeds its bound');
    const count = Buffer.alloc(4);
    count.writeUInt32BE(parts.length);
    digest.update(count);
    for (const part of parts) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(part.length);
      digest.update(length).update(part);
    }
  };
  const rootFd = openCheckpoint(dirname(root), basename(root));
  let rootParentFd: number | undefined;
  try {
  const rootReceipt = directoryReceipt(rootFd);
  rootParentFd = process.platform === 'linux'
    ? openSync(`/proc/self/fd/${rootFd}/..`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    : undefined;
  const rootParentReceipt = rootParentFd === undefined ? undefined : directoryReceipt(rootParentFd);
  const rootListing = process.platform === 'darwin' ? reviewDirectoryTree(rootFd, undefined, true).get('') : undefined;
  const checkRoot = (): void => {
    if (process.platform === 'darwin') {
      checkedReviewDirectoryEntries(rootFd, rootListing);
    } else {
      assertDirectoryReceipt(rootFd, rootReceipt);
      assertDirectoryReceipt(rootParentFd!, rootParentReceipt!);
      const installedFd = openCheckpoint(dirname(root), basename(root));
      try {
        const installed = directoryReceipt(installedFd);
        if (installed.dev !== rootReceipt.dev || installed.ino !== rootReceipt.ino) {
          throw new Error('review runtime installed root changed during fingerprint');
        }
      } finally { closeSync(installedFd); }
    }
  };
  const selectedFiles: FileReceipt[] = [];
  const recordFile = (receipt: FileReceipt): void => {
    if (selectedFiles.length >= 100_000) throw new Error('review runtime selected file receipts exceed their bound');
    selectedFiles.push(receipt);
  };
  const selectedDirectories: Array<{ readonly path: string; readonly receipt: DirectoryReceipt }> = [];
  const recordDirectory = (path: string, receipt: DirectoryReceipt): void => {
    if (selectedDirectories.length >= 100_000) throw new Error('review runtime directory receipts exceed their bound');
    selectedDirectories.push({ path, receipt });
  };
  const openCandidate = (candidate: string): number => {
    checkRoot();
    const withinRoot = relative(root, candidate);
    if (process.platform === 'linux' && withinRoot !== '' && !withinRoot.startsWith('/')) {
      // Resolve each component, including ancestor `..` steps for Node's
      // hoisted node_modules lookup, from the same held installation FD.
      // procfs is only a descriptor handle, never a pathname fallback.
      let parentFd = rootFd;
      const opened: number[] = [];
      try {
        const components = withinRoot.split('/');
        for (const [index, part] of components.entries()) {
          const last = index === components.length - 1;
          checkRoot();
          const parentReceipt = directoryReceipt(parentFd);
          const fd = openSync(`/proc/self/fd/${parentFd}/${part}`,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW |
            (last ? 0 : constants.O_DIRECTORY));
          opened.push(fd);
          assertDirectoryReceipt(parentFd, parentReceipt);
          if (part === '..' && parentFd === rootFd) {
            const selectedParent = directoryReceipt(fd);
            if (selectedParent.dev !== rootParentReceipt!.dev || selectedParent.ino !== rootParentReceipt!.ino) {
              throw new Error('review runtime installed root changed parents during fingerprint');
            }
          }
          checkRoot();
          parentFd = fd;
        }
        const result = opened.pop()!;
        return result;
      } finally { for (const fd of opened) closeSync(fd); }
    }
    const fd = openCheckpoint(dirname(candidate), basename(candidate));
    try { checkRoot(); return fd; }
    catch (error) { closeSync(fd); throw error; }
  };
  let dependencyIdentityChecked = false;
  const includeTree = (directory: string, prefix: string, installed: boolean, heldFd?: number,
    heldTree?: ReturnType<typeof reviewDirectoryTree>, treePrefix = '', packageName?: string): void => {
    const parentFd = heldFd ?? openCandidate(directory);
    try {
    checkRoot();
    const tree = process.platform === 'darwin' ? heldTree ?? reviewDirectoryTree(parentFd, undefined, false,
      { fd: rootFd, relativePath: relative(root, directory) }) : undefined;
    const parentReceipt = directoryReceipt(parentFd);
    const names = directoryEntries(directory, parentFd, tree, treePrefix);
    assertDirectoryReceipt(parentFd, parentReceipt);
    recordDirectory(directory, parentReceipt);
    for (const name of names) {
      if (installed && name === 'node_modules') continue;
      const path = join(directory, name);
      const relativePath = `${prefix}${name}`;
      // The held no-follow descriptor rejects links and FIFOs; reads use
      // that descriptor, not a pathname after a separate stat.
      let directoryFd: number | undefined;
      try {
        checkRoot();
        assertDirectoryReceipt(parentFd, parentReceipt);
        directoryFd = process.platform === 'linux'
          ? openSync(`/proc/self/fd/${parentFd}/${name}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
          : openCandidate(path);
        assertDirectoryReceipt(parentFd, parentReceipt);
        checkRoot();
        const info = fstatSync(directoryFd);
        if (info.isDirectory()) {
          // The descriptor remains open while descending; a switched child
          // directory can never redirect file reads to unchecked bytes.
          includeTree(path, `${relativePath}/`, installed, directoryFd, tree, `${treePrefix}${name}/`, packageName);
        } else if (info.isFile() && (installed
          ? /\.(?:js|mjs|cjs|node|wasm)$/u.test(name) ||
            (relativePath.includes('/dist/providers/data/') && /\.json$/u.test(name)) ||
            // Public esbuild platform binaries have no extension. These
            // exact package/file pairs are audited in the finite catalog.
            (treePrefix === 'bin/' && name === 'esbuild' &&
              PUBLIC_REVIEW_EXECUTABLE_PATHS.has(`${packageName}/bin/esbuild`))
          : /\.(?:js|mjs|json)$/u.test(name))) {
          // Finite, checked-in public names only. Never feed an unrecognized
          // installed pathname (even a .js or catalog JSON) into a digest.
          const publicPath = installed ? `${packageName}/${treePrefix}${name}` : relativePath;
          if (!PUBLIC_REVIEW_EXECUTABLE_PATHS.has(publicPath)) {
            throw new Error('review runtime contains an unproven executable path');
          }
          const beforeRead = () => { assertDirectoryReceipt(parentFd, parentReceipt); checkRoot(); };
          const bytes = process.platform === 'darwin'
            ? checkedReviewFileBytes(parentFd, tree?.get(treePrefix), name, directoryFd,
              () => descriptorBytes(directoryFd!, path, beforeRead, recordFile))
            : descriptorBytes(directoryFd, path, beforeRead, recordFile);
          let publicBytes = bytes;
          if (!installed && relativePath === 'dist/review-dependency-identity.json') {
            publicBytes = checkedJsonRecord(bytes, 'dependency');
            dependencyIdentityChecked = true;
          } else if (!installed && relativePath === 'dist/build-rev.json') {
            publicBytes = checkedJsonRecord(bytes, 'build');
          }
          checkRoot();
          record('file', relativePath, publicBytes);
        } else if (!info.isFile()) throw new Error(`review runtime contains a non-regular file: ${relativePath}`);
      } finally { if (directoryFd !== undefined) closeSync(directoryFd); }
    }
    } finally { if (heldFd === undefined) closeSync(parentFd); }
  };
  includeTree(join(root, 'dist'), 'dist/', false);
  if (!dependencyIdentityChecked) throw new Error('review dependency identity is missing — rebuild the installed package');
  const visited = new Set<string>();
  const selectedPackages: Array<{ readonly path: string; readonly dev: bigint; readonly ino: bigint; readonly ctimeNs: bigint }> = [];
  const visit = (name: string, parent: string): void => {
    if (!PUBLIC_DEPENDENCY_NAMES.has(name)) throw new Error('unknown installed dependency name — audit before review reuse');
    let base = parent;
    let directory: string | null = null;
    let packageFd: number | undefined;
    while (true) {
      const candidate = join(base, 'node_modules', name);
      try {
        packageFd = openCandidate(candidate);
        if (!fstatSync(packageFd).isDirectory()) throw new Error(`installed dependency is not a real directory: ${name}`);
        directory = candidate;
        break;
      } catch (error) {
        if (packageFd !== undefined) { closeSync(packageFd); packageFd = undefined; }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const next = dirname(base);
      if (next === base) break;
      base = next;
    }
    if (directory === null || packageFd === undefined) throw new Error(`installed review dependency is missing: ${name}`);
    if (visited.has(directory)) { closeSync(packageFd); return; }
    visited.add(directory);
    let metadata: InstalledPackage;
    try {
      const selected = fstatSync(packageFd, { bigint: true });
      if (!selected.isDirectory()) throw new Error('installed dependency is not a checked directory');
      selectedPackages.push({ path: directory, dev: selected.dev, ino: selected.ino, ctimeNs: selected.ctimeNs });
      const tree = process.platform === 'darwin' ? reviewDirectoryTree(packageFd, undefined, false,
        { fd: rootFd, relativePath: relative(root, directory) }) : undefined;
      checkRoot();
      const packageReceipt = directoryReceipt(packageFd);
      metadata = JSON.parse(regularBytes(join(directory, 'package.json'), packageFd, tree?.get(''),
        () => { assertDirectoryReceipt(packageFd!, packageReceipt); checkRoot(); }, recordFile).toString('utf8')) as InstalledPackage;
    if (metadata.name !== name || typeof metadata.version !== 'string' ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(metadata.version)) {
      throw new Error(`invalid installed review dependency: ${name}`);
    }
    const dependencyNames = (entries: InstalledPackage['dependencies']): string[] => {
      const names = Object.keys(entries ?? {}).sort();
      if (names.some((entry) => !PUBLIC_DEPENDENCY_NAMES.has(entry))) {
        throw new Error('unknown installed dependency name — audit before review reuse');
      }
      return names;
    };
    const safeMetadata = {
      name: metadata.name, version: metadata.version,
      type: metadata.type === undefined || metadata.type === 'module' || metadata.type === 'commonjs'
        ? metadata.type ?? null : (() => { throw new Error('unsafe installed dependency loader type'); })(),
      main: safeLoaderMetadata(metadata.main), exports: safeLoaderMetadata(metadata.exports),
      imports: safeLoaderMetadata(metadata.imports),
      piConfig: safePiConfig(metadata.piConfig),
      dependencies: dependencyNames(metadata.dependencies),
      optionalDependencies: dependencyNames(metadata.optionalDependencies),
      peerDependencies: dependencyNames(metadata.peerDependencies),
    };
    const location = relative(root, directory);
    checkRoot();
    record('package', location, JSON.stringify(safeMetadata));
    includeTree(directory, `${location}/`, true, packageFd, tree, '', name);
    } finally { closeSync(packageFd); }
    for (const dependency of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies }).sort()) {
      try { visit(dependency, directory); }
      catch (error) {
        if ((metadata.optionalDependencies?.[dependency] !== undefined || metadata.peerDependencies?.[dependency] !== undefined) &&
          error instanceof Error && error.message === `installed review dependency is missing: ${dependency}`) {
          record('missing-optional', dependency, relative(root, directory));
        } else throw error;
      }
    }
  };
  checkRoot();
  const projectBytes = regularBytes(join(root, 'package.json'), rootFd, rootListing, checkRoot, recordFile);
  checkRoot();
  const project = JSON.parse(projectBytes.toString('utf8')) as InstalledPackage;
  for (const name of Object.keys(project.dependencies ?? {}).sort()) visit(name, root);
  // Each package may have been replaced independently of the installation
  // root. Only its original checked directory may authorize this digest.
  for (const selected of selectedPackages) {
    const fd = openCandidate(selected.path);
    try {
      const current = fstatSync(fd, { bigint: true });
      if (!current.isDirectory() || current.dev !== selected.dev || current.ino !== selected.ino ||
        current.ctimeNs !== selected.ctimeNs) {
        throw new Error('review runtime installed dependency changed during fingerprint');
      }
    } finally { closeSync(fd); }
  }
  for (const selected of selectedDirectories) {
    checkRoot();
    const fd = openCandidate(selected.path);
    try { assertDirectoryReceipt(fd, selected.receipt); }
    finally { closeSync(fd); }
  }
  for (const receipt of selectedFiles) {
    checkRoot();
    const fd = openCandidate(receipt.path);
    try { assertFileReceipt(fd, receipt); }
    finally { closeSync(fd); }
  }
  checkRoot();
  // FD-relative reads alone cannot prove that the installed pathname still
  // names the held tree. A permanent replacement never earns prior credit.
  const installedFd = openCheckpoint(dirname(root), basename(root));
  try {
    const held = fstatSync(rootFd, { bigint: true });
    const installed = fstatSync(installedFd, { bigint: true });
    if (!held.isDirectory() || !installed.isDirectory() || held.dev !== installed.dev || held.ino !== installed.ino) {
      throw new Error('review runtime installed root changed during fingerprint');
    }
  } finally { closeSync(installedFd); }
  return digest.digest('hex');
  } finally {
    if (rootParentFd !== undefined) closeSync(rootParentFd);
    closeSync(rootFd);
  }
}
