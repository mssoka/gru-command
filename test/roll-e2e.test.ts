import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { adoptRollMarker } from '../src/roll/adopt.js';
import { readBuildInfo } from '../src/build-info.js';
import { RollController } from '../src/roll/controller.js';
import { readRollMarker, readRollState } from '../src/roll/state.js';

/**
 * GATED self-roll smoke (skipped by default; run with GRU_ROLL_E2E=1).
 *
 * Clones a scratch origin, lands a no-op commit, then drives the REAL
 * RollController (real git, real npm ci + builds) against a scratch deploy
 * clone — proving preflight pull+build, the drain probe, the swap marker,
 * and boot adoption end to end. The OS-supervisor relaunch itself is not
 * exercised here (launchd/systemd ownership belongs to the host): the
 * exit-code contract is pinned by the scratch-launchd evidence in the PR,
 * and this smoke stops at the marker + adoption boundary.
 */
const ENABLED = process.env['GRU_ROLL_E2E'] === '1';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf-8' }).trim();
}

describe.skipIf(!ENABLED)('self-roll e2e (scratch instance)', () => {
  it('rolls a no-op change through preflight → drain → swap → adoption', async () => {
    const repoRoot = join(import.meta.dirname, '..');
    const scratch = mkdtempSync(join(tmpdir(), 'gru-command-roll-e2e-'));
    cleanupDirs.push(scratch);
    const dataDir = join(scratch, 'instance');

    // Scratch origin + work clone + deploy clone (deploy sits at the base).
    const origin = join(scratch, 'origin.git');
    execFileSync('git', ['clone', '--bare', '--quiet', repoRoot, origin], { stdio: 'pipe' });
    const work = join(scratch, 'work');
    execFileSync('git', ['clone', '--quiet', origin, work], { stdio: 'pipe' });
    git(work, ['config', 'user.email', 'roll-e2e@example.invalid']);
    git(work, ['config', 'user.name', 'roll e2e']);
    const deploy = join(scratch, 'deploy');
    execFileSync('git', ['clone', '--quiet', origin, deploy], { stdio: 'pipe' });

    // The no-op change the roll must pick up.
    git(work, ['commit', '--allow-empty', '-m', 'no-op roll fixture commit']);
    const targetSha = git(work, ['rev-parse', 'HEAD']);
    git(work, ['push', '--quiet', 'origin', 'HEAD']);
    expect(git(deploy, ['rev-parse', 'HEAD'])).not.toBe(targetSha);

    const swaps: string[] = [];
    const controller = new RollController({
      dataDir,
      repoRoot: deploy,
      drainTimeoutMs: 0,
      probeInFlight: async () => [],
      readBuiltSha: () => readBuildInfo(deploy).rev,
      onSwap: (state) => swaps.push(state.toSha ?? 'none'),
    });
    const state = await controller.roll({ reason: 'gated e2e', requestedBy: 'vitest' });

    expect(state.phase).toBe('swap');
    expect(state.error).toBeNull();
    expect(state.fromSha).not.toBe(targetSha);
    expect(state.toSha).toBe(targetSha);
    expect(state.preflight?.pulled).toBe(true);
    expect(state.preflight?.rebuilt).toBe(true);
    expect(git(deploy, ['rev-parse', 'HEAD'])).toBe(targetSha);
    expect(readBuildInfo(deploy).rev).toBe(targetSha);
    expect(existsSync(join(deploy, 'dist', 'cli', 'service.js'))).toBe(true);
    expect(existsSync(join(deploy, 'web', 'dist', 'index.html'))).toBe(true);
    expect(swaps).toEqual([targetSha]);
    const marker = readRollMarker(dataDir);
    expect(marker?.toSha).toBe(targetSha);

    // The relaunched binary consumes the marker (boot adoption).
    const logs: string[] = [];
    const adopted = adoptRollMarker({
      dataDir,
      runningSha: readBuildInfo(deploy).rev,
      log: (level, msg) => logs.push(`${level}:${msg}`),
    });
    expect(adopted.marker?.toSha).toBe(targetSha);
    expect(readRollMarker(dataDir)).toBeNull();
    expect(readRollState(dataDir)?.phase).toBe('done');
    expect(logs.some((line) => line === `info:rolled to ${targetSha}`)).toBe(true);
    expect(readFileSync(join(dataDir, 'roll-state.json'), 'utf-8')).toContain('"done"');
  }, 600_000);
});
