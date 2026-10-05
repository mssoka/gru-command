import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const MAX_ENTRIES = 100_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 64;

// Only fd 3 crosses the process boundary. Python traverses with dir_fd and
// O_NOFOLLOW; no untrusted directory pathname can redirect enumeration.
const SCAN_FD = `import json, os, stat, sys
if sys.version_info < (3, 8) or not stat.S_ISDIR(os.fstat(3).st_mode):
    sys.exit(2)
if len(sys.argv) > 2 and sys.argv[2]:
    # Prove the scanned package/dist descriptor belongs to the same held
    # installation root. Pathname ancestor replacement cannot fake this walk.
    cursor = os.dup(4)
    try:
        for part in sys.argv[2].split('/'):
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=cursor)
            os.close(cursor)
            cursor = next_fd
        root_child = os.fstat(cursor)
        selected = os.fstat(3)
        if (root_child.st_dev, root_child.st_ino) != (selected.st_dev, selected.st_ino):
            sys.exit(2)
    finally:
        os.close(cursor)
rows = []
total = 0
def visit(fd, path, depth):
    global total
    if depth > ${MAX_DEPTH}:
        sys.exit(2)
    before = os.fstat(fd)
    names = []
    directories = []
    files = []
    with os.scandir(fd) as entries:
        for entry in entries:
            total += 1
            if total > ${MAX_ENTRIES}:
                sys.exit(2)
            names.append(entry.name)
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                directories.append(entry.name)
            elif stat.S_ISREG(info.st_mode):
                files.append([entry.name, str(info.st_dev), str(info.st_ino), str(info.st_mtime_ns), str(info.st_ctime_ns), str(info.st_size)])
    after = os.fstat(fd)
    if (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns):
        sys.exit(2)
    rows.append([path, str(after.st_dev), str(after.st_ino), str(after.st_mtime_ns), str(after.st_ctime_ns), names, files])
    if len(sys.argv) > 1 and sys.argv[1] == 'shallow':
        return
    for name in directories:
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            visit(child, path + name + '/', depth + 1)
        finally:
            os.close(child)
visit(3, '', 0)
sys.stdout.write(json.dumps(rows, ensure_ascii=True, separators=(',', ':')))
`;

/** Resolve the same explicit, stable interpreter installed into launchd.
 * Unmanaged direct runs resolve PATH once to an absolute executable; an
 * explicit invalid setting never silently falls back to another interpreter. */
export function reviewPythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['GRU_COMMAND_REVIEW_PYTHON'];
  const candidate = configured !== undefined
    ? configured
    : (env['PATH'] ?? '').split(delimiter).filter((part) => isAbsolute(part))
      .map((part) => join(part, 'python3'))
      .find((path) => {
        try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
      });
  if (candidate === undefined || !isAbsolute(candidate)) {
    throw new Error('Darwin review dependency identity requires a pinned absolute Python 3 executable (GRU_COMMAND_REVIEW_PYTHON)');
  }
  try {
    const resolved = realpathSync(candidate);
    if (configured !== undefined && resolved !== candidate) throw new Error('interpreter path is not pinned');
    if (!statSync(resolved).isFile()) throw new Error('interpreter is not a regular file');
    accessSync(resolved, constants.X_OK);
    if (process.platform === 'darwin') {
      // A shebang/version-manager shim may dispatch a different Python from
      // the one probed at install time. Require the actual native Mach-O.
      const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        const magic = Buffer.alloc(4);
        if (!info.isFile() || info.nlink !== 1 || readSync(fd, magic, 0, magic.length, 0) !== magic.length ||
          !new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
            'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']).has(magic.toString('hex'))) {
          throw new Error('interpreter is not a native Mach-O executable');
        }
      } finally { closeSync(fd); }
    }
    return resolved;
  } catch {
    throw new Error('Darwin review dependency identity requires a usable pinned Python 3 executable');
  }
}

interface FileReceipt {
  readonly dev: string;
  readonly ino: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly size: string;
}

interface Listing {
  readonly dev: string;
  readonly ino: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly names: readonly string[];
  readonly files: ReadonlyMap<string, FileReceipt>;
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..' &&
    Buffer.byteLength(value) <= 255 && !value.includes('/') && !value.includes('\0') &&
    !/[\uD800-\uDFFF]/u.test(value);
}

/** One bounded child per installed dependency tree, with every directory
 * scanned through held no-follow descriptors. Re-check each held JS descriptor
 * before using its listing: a changed tree never earns compatible credit. */
export function reviewDirectoryTree(fd: number, interpreter = reviewPythonExecutable(), shallow = false,
  root?: { readonly fd: number; readonly relativePath: string }): ReadonlyMap<string, Listing> {
  if (!fstatSync(fd).isDirectory()) throw new Error('review runtime directory descriptor is not a directory');
  const child = spawnSync(interpreter, ['-I', '-S', '-c', SCAN_FD, shallow ? 'shallow' : 'full', root?.relativePath ?? ''], {
    env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', fd, ...(root === undefined ? [] : [root.fd])], encoding: 'utf8',
    timeout: 20_000, maxBuffer: MAX_OUTPUT_BYTES, shell: false,
  });
  if (child.status !== 0 || child.error !== undefined || typeof child.stdout !== 'string' ||
    Buffer.byteLength(child.stdout) > MAX_OUTPUT_BYTES) {
    throw new Error('Darwin review dependency directory enumeration failed (Python 3 FD probe)');
  }
  let value: unknown;
  try { value = JSON.parse(child.stdout); }
  catch { throw new Error('Darwin review dependency directory enumeration returned invalid JSON'); }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENTRIES) {
    throw new Error('Darwin review dependency directory enumeration exceeded its entry bound');
  }
  const listings = new Map<string, Listing>();
  let count = 0;
  for (const row of value as unknown[]) {
    if (!Array.isArray(row) || row.length !== 7 || typeof row[0] !== 'string' ||
      (row[0] !== '' && (row[0].length > MAX_DEPTH * 256 ||
        !row[0].endsWith('/') || row[0].slice(0, -1).split('/').some((part) => !validName(part)))) ||
      row.slice(1, 5).some((field) => typeof field !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(field)) ||
      !Array.isArray(row[5]) || !Array.isArray(row[6]) || listings.has(row[0])) {
      throw new Error('Darwin review dependency directory enumeration returned an invalid listing');
    }
    const names = new Set<string>();
    for (const entry of row[5] as unknown[]) {
      count += 1;
      if (count > MAX_ENTRIES || !validName(entry) || names.has(entry)) {
        throw new Error('Darwin review dependency directory enumeration returned an invalid entry');
      }
      names.add(entry);
    }
    const files = new Map<string, FileReceipt>();
    for (const receipt of row[6] as unknown[]) {
      if (!Array.isArray(receipt) || receipt.length !== 6 || !validName(receipt[0]) ||
        !names.has(receipt[0]) || files.has(receipt[0]) ||
        receipt.slice(1).some((field) => typeof field !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(field))) {
        throw new Error('Darwin review dependency directory enumeration returned an invalid file receipt');
      }
      files.set(receipt[0], { dev: receipt[1] as string, ino: receipt[2] as string,
        mtimeNs: receipt[3] as string, ctimeNs: receipt[4] as string, size: receipt[5] as string });
    }
    listings.set(row[0], { dev: row[1] as string, ino: row[2] as string,
      mtimeNs: row[3] as string, ctimeNs: row[4] as string, names: [...names].sort(), files });
  }
  if (!listings.has('')) throw new Error('Darwin review dependency directory enumeration omitted its root');
  return listings;
}

export function checkedReviewDirectoryEntries(fd: number, listing: Listing | undefined): readonly string[] {
  const info = fstatSync(fd, { bigint: true });
  if (listing === undefined || !info.isDirectory() || String(info.dev) !== listing.dev ||
    String(info.ino) !== listing.ino || String(info.mtimeNs) !== listing.mtimeNs ||
    String(info.ctimeNs) !== listing.ctimeNs) {
    throw new Error('review runtime directory changed during descriptor-bound enumeration');
  }
  return listing.names;
}

/** Reject a pathname swap before reading a single byte. Recheck the held
 * parent and file receipts after the bounded read and before any digest
 * update; a changed package never receives compatible identity credit. */
export function checkedReviewFileBytes(
  parentFd: number, listing: Listing | undefined, name: string, fileFd: number,
  read: () => Buffer,
): Buffer {
  const check = () => {
    checkedReviewDirectoryEntries(parentFd, listing);
    const expected = listing?.files.get(name);
    const actual = fstatSync(fileFd, { bigint: true });
    if (expected === undefined || !actual.isFile() || String(actual.dev) !== expected.dev ||
      String(actual.ino) !== expected.ino || String(actual.mtimeNs) !== expected.mtimeNs ||
      String(actual.ctimeNs) !== expected.ctimeNs || String(actual.size) !== expected.size) {
      throw new Error('review runtime file changed since descriptor-bound enumeration');
    }
  };
  check();
  const bytes = read();
  check();
  return bytes;
}
