import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * The bare origin a fixture attaches is the shared store its clones read, so
 * its HEAD must name the branch the fixture publishes (`main`) instead of
 * whatever `init.defaultBranch` the HOST carries. On a host whose default is
 * another name the clone checked out nothing and kept an unresolvable HEAD,
 * so every test reaching a clone (worktree creation, review-source preflight)
 * failed for a reason unrelated to the code under test (#344–#349).
 */

const repos: FixtureRepo[] = [];
const dirs: string[] = [];
const SAVED_SYSTEM_CONFIG = process.env['GIT_CONFIG_NOSYSTEM'];
const SAVED_GLOBAL_CONFIG = process.env['GIT_CONFIG_GLOBAL'];

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

afterEach(() => {
  for (const [name, saved] of [['GIT_CONFIG_NOSYSTEM', SAVED_SYSTEM_CONFIG], ['GIT_CONFIG_GLOBAL', SAVED_GLOBAL_CONFIG]] as const) {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('fixture bare origin', () => {
  it('names main as its HEAD, so a clone of a main fixture resolves HEAD even when init.defaultBranch is another name', () => {
    // A host whose default branch name is NOT main; every git child below
    // inherits it. Nothing the fixture does may depend on that setting.
    const configHome = mkdtempSync(join(tmpdir(), 'gru-fixture-gitconfig-'));
    dirs.push(configHome);
    const config = join(configHome, 'config');
    writeFileSync(config, '[init]\n\tdefaultBranch = trunk\n', 'utf-8');
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['GIT_CONFIG_GLOBAL'] = config;
    expect(git(['var', 'GIT_DEFAULT_BRANCH'])).toBe('trunk');

    const repo = makeFixtureRepo('shared-app');
    repos.push(repo);
    const origin = attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'main']);
    expect(git(['-C', origin, 'symbolic-ref', 'HEAD'])).toBe('refs/heads/main');

    // The consequence the suite depends on: a clone of that origin resolves
    // HEAD at the published commit, on main.
    const cloneRoot = mkdtempSync(join(tmpdir(), 'gru-fixture-clone-'));
    dirs.push(cloneRoot);
    const clone = join(cloneRoot, 'shared-app');
    execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: 'ignore' });
    expect(git(['-C', clone, 'rev-parse', 'HEAD'])).toBe(repo.head());
    expect(git(['-C', clone, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });
});
