import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixtureRepo } from './fixture-repo.js';

/** Commits `count` new files under `many/` in one commit. Thousands of new
 * objects must never start a detached background gc / maintenance that is
 * still writing .git while the fixture is removed, so both are disabled
 * first (#393's 4001-path fixtures). */
export function commitManyPaths(repo: FixtureRepo, count: number): void {
  repo.git(['config', 'gc.auto', '0']);
  repo.git(['config', 'maintenance.auto', 'false']);
  mkdirSync(join(repo.path, 'many'));
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(repo.path, 'many', `f${String(index)}.ts`), `export const v${String(index)} = ${String(index)};\n`);
  }
  repo.git(['add', 'many']);
  repo.git(['commit', '-m', `touch ${String(count)} paths`]);
}

/** Generous for writing and committing thousands of files on a loaded runner. */
export const LARGE_UNIT_TIMEOUT_MS = 120_000;
