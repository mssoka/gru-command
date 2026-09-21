import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type CredentialSource = 'environment' | 'file' | 'none';
export type CredentialState = 'present' | 'absent' | 'unsafe' | 'invalid' | 'unreadable';

export interface CredentialResolution {
  readonly state: CredentialState;
  readonly source: CredentialSource;
  /** Internal only. Callers must never serialize/log this field. */
  readonly key?: string;
}

export function credentialPath(instanceDir: string): string {
  return join(instanceDir, 'credentials', 'openrouter.key');
}

/**
 * Move the provider key into a private environment snapshot before any
 * product subprocesses are launched. Child processes inherit process.env,
 * so leaving this value ambient would expose it to agents and repo hooks.
 */
export function isolateDecisionEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const isolated = { ...env };
  delete env['OPENROUTER_API_KEY'];
  return isolated;
}

function validKey(value: string): boolean {
  return value.trim() !== '' && value === value.trim() && !/[\r\n\0]/.test(value);
}

function unixOwnershipSafe(path: string, expectedMode: number): boolean {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return false;
  if (process.platform === 'win32') return true;
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) return false;
  return (info.mode & 0o777) === expectedMode;
}

function resolveFile(instanceDir: string): CredentialResolution {
  const file = credentialPath(instanceDir);
  const directory = dirname(file);
  try {
    // lstat sees dangling symlinks that existsSync deliberately follows and
    // reports as absent. Only a genuine ENOENT is an absent credential store.
    const dirInfo = lstatSync(directory);
    if (!dirInfo.isDirectory() || !unixOwnershipSafe(directory, 0o700)) {
      return { state: 'unsafe', source: 'file' };
    }
    const fileInfo = lstatSync(file);
    if (!fileInfo.isFile() || !unixOwnershipSafe(file, 0o600)) {
      return { state: 'unsafe', source: 'file' };
    }
    const key = readFileSync(file, 'utf8');
    if (!validKey(key)) return { state: 'invalid', source: 'file' };
    return { state: 'present', source: 'file', key };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'absent', source: 'none' };
    return { state: 'unreadable', source: 'file' };
  }
}

/** Environment override wins even when malformed: never silently fall through. */
export function resolveCredential(
  instanceDir: string,
  env: NodeJS.ProcessEnv = process.env,
): CredentialResolution {
  const fromEnv = env['OPENROUTER_API_KEY'];
  if (fromEnv !== undefined) {
    if (!validKey(fromEnv)) return { state: 'invalid', source: 'environment' };
    return { state: 'present', source: 'environment', key: fromEnv };
  }
  return resolveFile(instanceDir);
}

export function parseCredentialStdin(input: string): string {
  const key = input.endsWith('\r\n') ? input.slice(0, -2) : input.endsWith('\n') ? input.slice(0, -1) : input;
  if (!validKey(key)) {
    throw new Error('credential must be one non-empty line with no leading/trailing whitespace');
  }
  return key;
}

/** Atomic protected-file persistence; pre-existing unsafe paths are rejected. */
export function writeCredential(instanceDir: string, key: string): void {
  if (!validKey(key)) throw new Error('credential must be one non-empty line');
  const file = credentialPath(instanceDir);
  const directory = dirname(file);
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || !unixOwnershipSafe(directory, 0o700)) {
      throw new Error('credential directory is unsafe; require an owner-only 0700 real directory');
    }
  } else {
    mkdirSync(directory, { mode: 0o700 });
  }
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (!info.isFile() || !unixOwnershipSafe(file, 0o600)) {
      throw new Error('credential file is unsafe; require an owner-only 0600 regular file');
    }
  }
  const temp = join(directory, `.openrouter.key.${process.pid}.${Date.now()}.tmp`);
  let fd: number | null = null;
  try {
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    writeFileSync(fd, key, { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, file);
    // Verify the final object rather than trusting umask/rename behavior.
    if (!unixOwnershipSafe(file, 0o600) || !lstatSync(file).isFile()) {
      throw new Error('credential file did not retain safe owner-only permissions');
    }
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}
