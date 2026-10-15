import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FixtureRepo } from './fixture-repo.js';

/** Commits `count` new files under `many/` in one commit. Thousands of new
 * objects must never start a detached background gc / maintenance that is
 * still writing .git while the fixture is removed, so both are disabled
 * first (#393's 4001-path fixtures). */
export function commitManyPaths(repo: FixtureRepo, count: number, directory = 'many'): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
    throw new Error(`commitManyPaths needs a path count from 1 to 100000 (got ${String(count)})`);
  }
  if (directory === '' || isAbsolute(directory) || directory.split(/[\\/]/u).some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error(`commitManyPaths directory must be a plain relative path inside the fixture (got ${JSON.stringify(directory)})`);
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
