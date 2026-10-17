import { execFile } from 'node:child_process';
import { chmod, lstat, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { oneLineErrorText } from '../property/error-text.js';

/**
 * What a manifest's `reclaim` entry (#427) is on disk, shared by the two
 * places that judge one: the onboarding proof (PR 1b), which fails a
 * manifest whose entry is unsafe, and lane slimming (PR 2a), which deletes
 * a safe one. Both read a path the same way, so an entry the proof passed is
 * the entry slimming finds:
 *
 * - every `lstat` here never follows a link, and a link anywhere on an
 *   entry's path is reported, never walked through;
 * - git runs with no user or system config, so the repository's own ignore
 *   rules decide what is ignored.
 */

const oneLine = (error: unknown): string => oneLineErrorText(error instanceof Error ? error.message : error, 400);

/** Git in a checkout with no user or system config: no hooks, no fsmonitor,
 * no prompts, off the event loop. Resolves with the exit code; a failure to
 * run rejects. */
function measureGit(cwd: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') reject(new Error(`git ${args[0] ?? ''} could not run: ${oneLine(error)}`));
      else resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

/** Git refuses a pathspec that passes through a symbolic link (exit 128). */
const beyondLink = (run: { readonly code: number; readonly stderr: string }): boolean => run.code === 128 && /beyond a symbolic link/u.test(run.stderr);

/** Whether the repository's ignore rules ignore a path (an empty folder
 * included, which `git status` never lists); `link` when git refuses the
 * path because it passes through a link. */
export async function reclaimIgnored(dir: string, path: string): Promise<boolean | 'link'> {
  const run = await measureGit(dir, ['check-ignore', '-q', '--', path]);
  if (run.code === 0) return true;
  if (run.code === 1) return false;
  if (beyondLink(run)) return 'link';
  throw new Error(`git check-ignore exited ${String(run.code)}: ${oneLine(run.stderr)}`);
}

/** Tracked files at or under a path; `link` when git refuses the path
 * because it passes through a link. */
export async function reclaimTrackedFiles(dir: string, path: string): Promise<number | 'link'> {
  const run = await measureGit(dir, ['--literal-pathspecs', 'ls-files', '-z', '--', path]);
  if (beyondLink(run)) return 'link';
  if (run.code !== 0) throw new Error(`git ls-files exited ${String(run.code)}: ${oneLine(run.stderr.trim() === '' ? '(no output)' : run.stderr)}`);
  return run.stdout.split('\0').filter((entry) => entry !== '').length;
}

/** Where a reclaim entry (normalized `a/b`) stands, by an `lstat` of each
 * path prefix in turn: a link anywhere on the path is reported, never
 * walked through. */
export async function reclaimState(dir: string, entry: string): Promise<'absent' | 'link' | 'present'> {
  const segments = entry.split('/');
  for (let depth = 1; depth <= segments.length; depth += 1) {
    let stat;
    try {
      stat = await lstat(join(dir, ...segments.slice(0, depth)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
      throw error;
    }
    if (stat.isSymbolicLink()) return 'link';
  }
  return 'present';
}

/** Bytes on disk under a path, by `lstat` (a link counts as itself, never
 * its target): each inode's allocated blocks (`blocks * 512`; its `size`
 * where a platform reports no blocks), folders included, each inode once.
 * A file counts only when every one of its hard links was met inside the
 * walk (its `nlink`): deleting the tree frees it. A file also linked from
 * outside (a package store's hard links) is `sharedBytes` instead, since
 * deleting the tree frees none of it. Blocks a copy-on-write clone shares
 * with another file (an APFS clone) cannot be seen from here and are
 * counted in full. `skip` names one child of the root to leave out. */
export async function treeUsage(root: string, skip: string | null = null): Promise<{ readonly bytes: number; readonly sharedBytes: number }> {
  let bytes = 0;
  const folders = new Set<string>();
  const files = new Map<string, { readonly bytes: number; readonly nlink: number; met: number }>();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      continue;
    }
    const inode = `${String(stat.dev)}:${String(stat.ino)}`;
    const allocated = typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
    if (!stat.isDirectory()) {
      const file = files.get(inode) ?? { bytes: allocated, nlink: stat.nlink, met: 0 };
      file.met += 1;
      files.set(inode, file);
      continue;
    }
    if (folders.has(inode)) continue;
    folders.add(inode);
    bytes += allocated;
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      continue;
    }
    for (const name of names) if (!(current === root && name === skip)) stack.push(join(current, name));
  }
  let sharedBytes = 0;
  for (const file of files.values()) {
    if (file.met >= file.nlink) bytes += file.bytes;
    else sharedBytes += file.bytes;
  }
  return { bytes, sharedBytes };
}

/** A tree's size (#427): every inode under it once, its hard links met
 * inside the walk or not (the onboarding proof's sizes). What deleting it
 * frees, and what stays linked from outside, is {@link treeUsage}'s split. */
export async function treeBytes(root: string, skip: string | null = null): Promise<number> {
  const { bytes, sharedBytes } = await treeUsage(root, skip);
  return bytes + sharedBytes;
}

/** Remove a tree; a link inside it is removed as a link, never followed.
 * Some setups leave read-only folders behind, so a failed removal makes the
 * tree writable (never following a link) and tries once more. With a
 * `signal` (#427: a slim's, which the service's stop aborts) the removal
 * checks it at every path and stops there, rejecting, with the rest left in
 * place. */
export async function removeTree(dir: string, signal?: AbortSignal): Promise<void> {
  const remove = async (): Promise<void> => {
    if (signal === undefined) await rm(dir, { recursive: true, force: true });
    else await removeWalk(dir, signal);
  };
  try {
    await remove();
    return;
  } catch (error) {
    if (signal?.aborted === true) throw error;
    // retried below once the tree is writable
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    try {
      if (!(await lstat(current)).isDirectory()) continue;
      await chmod(current, 0o700);
      for (const name of await readdir(current)) stack.push(join(current, name));
    } catch {
      // gone, or not ours to change: the retry reports what stays
    }
  }
  await remove();
}

/** Remove a tree path by path, children before their folder, checking the
 * signal before each one. */
async function removeWalk(root: string, signal: AbortSignal): Promise<void> {
  const stack: { readonly path: string; expanded: boolean }[] = [{ path: root, expanded: false }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.expanded) {
      stack.pop();
      await rmdir(top.path);
      continue;
    }
    if (signal.aborted) throw new Error(`the removal of ${root} was stopped part way`);
    let stat;
    try {
      stat = await lstat(top.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      stack.pop();
      continue;
    }
    if (!stat.isDirectory()) {
      stack.pop();
      await unlink(top.path);
      continue;
    }
    top.expanded = true;
    for (const name of await readdir(top.path)) stack.push({ path: join(top.path, name), expanded: false });
  }
}
