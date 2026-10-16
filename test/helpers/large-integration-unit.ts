import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FixtureRepo } from './fixture-repo.js';

/** A path segment as a filesystem may fold it: compatibility forms (NFKC),
 * ignorable code points (HFS+), an NTFS stream suffix (`:…`), trailing dots
 * or spaces (Windows), any case. */
function foldedSegment(part: string): string {
  const folded = part.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  // Windows drops trailing dots and blanks: a segment of only those (`.`,
  // `..`, `...`, `. .`) folds to nothing.
  const bare = folded.replace(/[.\s]+$/u, '');
  // A stream suffix (`a:b`) or a reserved device name (with any extension or
  // trailing blanks) folds to nothing too: refused, never judged as another name.
  if (bare.includes(':') || /^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$|clock\$)\s*(?:\.[\s\S]*)?$/iu.test(bare)) return '';
  return bare.toLowerCase();
}
/** A name a filesystem may map onto `.git`, including the 8.3 short names
 * `git~N`. */
function isGitAlias(part: string): boolean {
  const name = foldedSegment(part);
  return name === '.git' || /^git~\d+$/u.test(name);
}

/** Commits `count` new files under `many/` in one commit. Thousands of new
 * objects must never start a detached background gc / maintenance that is
 * still writing .git while the fixture is removed, so both are disabled
 * first (#393's 4001-path fixtures). */
export function commitManyPaths(repo: FixtureRepo, count: number, directory = 'many'): void {
  // 100000 bounds a typo (4e9) to minutes of fixture work, never a full disk.
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
    throw new Error(`commitManyPaths needs a path count from 1 to 100000 (got ${String(count)})`);
  }
  if (directory === '' || isAbsolute(directory) || /^[A-Za-z]:/u.test(directory) || directory.includes('\0') ||
      directory.split(/[\\/]/u).some((part) => part === '.' || part === '..' || foldedSegment(part) === '' || isGitAlias(part))) {
    throw new Error(`commitManyPaths directory must be a relative path inside the fixture's work tree (got ${JSON.stringify(directory)})`);
  }
  if (existsSync(join(repo.path, directory))) throw new Error(`commitManyPaths directory already exists: ${directory}`);
  repo.git(['config', 'gc.auto', '0']);
  repo.git(['config', 'maintenance.auto', 'false']);
  mkdirSync(join(repo.path, directory), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(repo.path, directory, `f${String(index)}.ts`), `export const v${String(index)} = ${String(index)};\n`);
  }
  repo.git(['add', directory]);
  repo.git(['commit', '-m', `touch ${String(count)} paths`]);
}

/** Generous for writing and committing thousands of files on a loaded runner. */
export const LARGE_UNIT_TIMEOUT_MS = 120_000;
