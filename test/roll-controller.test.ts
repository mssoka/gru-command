import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RollBusyError,
  RollController,
  type RollRunner,
} from '../src/roll/controller.js';
import type { RollCommandResult } from '../src/roll/runner.js';
import { readRollMarker, readRollState, type RollWorkItem } from '../src/roll/state.js';

/**
 * Self-roll state machine: preflight refusals (dirty, diverged, failed
 * build, moved checkout, bad stamp), the bounded drain (settles early or
 * abandons at the deadline), and the swap handoff (marker written, state
 * kept, onSwap fired exactly once). The old service keeps serving on every
 * failure — no phase failure may write a marker.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** A repoRoot that already holds every required build artifact. */
function stageArtifacts(repoRoot: string): void {
  for (const artifact of [
    'dist/main.js',
    'dist/wizard/main.js',
    'dist/cli/config-generate.js',
    'dist/cli/service.js',
    'dist/runtime/review-mcp-server.mjs',
    'resources/perkins-code-review/policy.json',
    'tools/verify-perkins-resource.mjs',
    'web/dist/index.html',
  ]) {
    mkdirSync(dirname(join(repoRoot, artifact)), { recursive: true });
    writeFileSync(join(repoRoot, artifact), 'fixture\n', 'utf-8');
  }
}

function stampBuild(repoRoot: string, rev: string): void {
  mkdirSync(join(repoRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'dist', 'build-rev.json'),
    `${JSON.stringify({ rev, committedAt: '2026-09-23T00:00:00.000Z', builtAt: '2026-09-23T00:00:00.000Z' })}\n`,
    'utf-8',
  );
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

interface Scripted {
  readonly calls: string[];
  readonly run: RollRunner;
}

/**
 * A scripted command runner. `heads` is the sequence `git rev-parse HEAD`
 * returns (last value repeats); `status`, `pull`, `ci`, `build`, `web`
 * shape the other results; `onBuild` runs when `npm run build` executes.
 */
function scriptedRunner(options: {
  heads: string[];
  status?: string;
  pull?: RollCommandResult;
  ci?: RollCommandResult;
  build?: RollCommandResult;
  web?: RollCommandResult;
  onBuild?: () => void;
}): Scripted {
  const calls: string[] = [];
  let headIndex = 0;
  const ok: RollCommandResult = { code: 0, stdout: '', stderr: '' };
  const run: RollRunner = async (command, args, runOptions) => {
    const key = `${command} ${args.join(' ')}`.trim();
    calls.push(key);
    if (command === 'git' && args[0] === 'rev-parse') {
      const head = options.heads[Math.min(headIndex, options.heads.length - 1)] as string;
      headIndex += 1;
      return { code: 0, stdout: `${head}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'status') {
      return { code: 0, stdout: options.status ?? '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'pull') {
      return options.pull ?? ok;
    }
    if (command === 'npm' && args[0] === 'ci') return options.ci ?? ok;
    if (command === 'npm' && args[1] === 'build') {
      options.onBuild?.();
      return options.build ?? ok;
    }
    if (command === 'npm' && args[1] === 'build:web') return options.web ?? ok;
    void runOptions;
    return ok;
  };
  return { calls, run };
}

interface Fixture {
  readonly dataDir: string;
  readonly repoRoot: string;
}

function fixture(): Fixture {
  const root = tempDir('gru-command-roll-controller-');
  const dataDir = join(root, 'instance');
  const repoRoot = join(root, 'deploy');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  stageArtifacts(repoRoot);
  return { dataDir, repoRoot };
}

function makeController(fix: Fixture, overrides: {
  runner: RollRunner;
  probeInFlight?: () => Promise<readonly RollWorkItem[]>;
  readBuiltSha?: () => string | null;
  drainTimeoutMs?: number;
  clock?: { now: number };
  probeForeignListener?: () => Promise<{ pid: number; command: string } | null>;
  onForeignListener?: (owner: { pid: number; command: string }) => void;
}): { controller: RollController; swaps: string[] } {
  const clock = overrides.clock ?? { now: 1_000_000 };
  const swaps: string[] = [];
  const controller = new RollController({
    dataDir: fix.dataDir,
    repoRoot: fix.repoRoot,
    drainTimeoutMs: overrides.drainTimeoutMs ?? 30_000,
    drainPollMs: 1_000,
    run: overrides.runner,
    probeInFlight: overrides.probeInFlight ?? (async () => []),
    readBuiltSha: overrides.readBuiltSha ?? (() => null),
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms; },
    newId: () => 'roll-test-1',
    onSwap: (state) => { swaps.push(state.phase); },
    ...(overrides.probeForeignListener !== undefined
      ? { probeForeignListener: overrides.probeForeignListener }
      : {}),
    ...(overrides.onForeignListener !== undefined
      ? { onForeignListener: overrides.onForeignListener }
      : {}),
  });
  return { controller, swaps };
}

describe('roll controller preflight', () => {
  it('REFUSES a roll when a foreign listener owns the instance port — before any git call, action-required', async () => {
    const fix = fixture();
    const scripted = scriptedRunner({ heads: [SHA_A] });
    const escalations: { pid: number; command: string }[] = [];
    const { controller, swaps } = makeController(fix, {
      runner: scripted.run,
      probeForeignListener: async () => ({ pid: 987, command: 'node /squat/dist/main.js' }),
      onForeignListener: (owner) => escalations.push(owner),
    });
    const state = await controller.roll();
    expect(state.phase).toBe('failed');
    expect(state.error?.phase).toBe('preflight');
    expect(state.error?.detail).toContain('foreign process');
    expect(state.error?.detail).toContain('pid 987');
    expect(state.error?.detail).toContain('action required');
    expect(escalations).toEqual([{ pid: 987, command: 'node /squat/dist/main.js' }]);
    // The squatter never got a build or a swap; the old service keeps serving.
    expect(scripted.calls.some((call) => call.startsWith('git pull'))).toBe(false);
    expect(readRollMarker(fix.dataDir)).toBeNull();
    expect(swaps).toEqual([]);
  });

  it('refuses a dirty deploy clone before any pull, leaving no marker and no swap', async () => {
    const fix = fixture();
    const scripted = scriptedRunner({ heads: [SHA_A], status: '?? local-notes.txt\n' });
    const { controller, swaps } = makeController(fix, { runner: scripted.run });
    const state = await controller.roll();
    expect(state.phase).toBe('failed');
    expect(state.error?.phase).toBe('preflight');
    expect(state.error?.detail).toContain('dirty deploy clone');
    expect(scripted.calls.some((call) => call.startsWith('git pull'))).toBe(false);
    expect(readRollMarker(fix.dataDir)).toBeNull();
    expect(swaps).toEqual([]);
  });

  it('refuses divergence when git pull --ff-only fails', async () => {
    const fix = fixture();
    const scripted = scriptedRunner({
      heads: [SHA_A],
      pull: { code: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.\n' },
    });
    const { controller, swaps } = makeController(fix, { runner: scripted.run });
    const state = await controller.roll();
    expect(state.phase).toBe('failed');
    expect(state.error?.detail).toContain('fast-forward-only update failed');
    expect(readRollMarker(fix.dataDir)).toBeNull();
    expect(swaps).toEqual([]);
  });

  it('fails on a failed build without a marker — the old service keeps serving', async () => {
    const fix = fixture();
    const scripted = scriptedRunner({
      heads: [SHA_A, SHA_B, SHA_B],
      build: { code: 2, stdout: '', stderr: 'error TS2304: Cannot find name\n' },
    });
    const { controller, swaps } = makeController(fix, { runner: scripted.run });
    const state = await controller.roll();
    expect(state.phase).toBe('failed');
    expect(state.error?.detail).toContain('npm run build failed');
    expect(state.error?.detail).toContain('TS2304');
    expect(readRollMarker(fix.dataDir)).toBeNull();
    expect(swaps).toEqual([]);
  });

  it('fails when the checkout moves during the build', async () => {
    const fix = fixture();
    const scripted = scriptedRunner({
      heads: [SHA_A, SHA_B, SHA_C],
      onBuild: () => stampBuild(fix.repoRoot, SHA_B),
    });
    const { controller, swaps } = makeController(fix, { runner: scripted.run });
    const state = await controller.roll();
    expect(state.phase).toBe('failed');
    expect(state.error?.detail).toContain('checkout moved during preflight');
    expect(swaps).toEqual([]);
  });

  it('fails when the build stamp does not match the target sha', async () => {
    const fix = fixture();
    const scripted = scriptedRunner({
      heads: [SHA_A, SHA_B, SHA_B],
      onBuild: () => stampBuild(fix.repoRoot, SHA_A),
    });
    const { controller, swaps } = makeController(fix, { runner: scripted.run });
    const state = await controller.roll();
    expect(state.phase).toBe('failed');
    expect(state.error?.detail).toContain('build stamp mismatch');
    expect(swaps).toEqual([]);
  });
});

describe('roll controller drain + swap', () => {
  it('rebuilds a moved checkout, drains, and swaps with the marker carrying the built sha', async () => {
    const fix = fixture();
    const scripted = scriptedRunner({
      heads: [SHA_A, SHA_B, SHA_B],
      onBuild: () => stampBuild(fix.repoRoot, SHA_B),
    });
    const { controller, swaps } = makeController(fix, { runner: scripted.run });
    const state = await controller.roll({ reason: 'fixture', requestedBy: 'test' });
    expect(state.phase).toBe('swap');
    expect(state.preflight?.rebuilt).toBe(true);
    expect(state.preflight?.pulled).toBe(true);
    expect(state.drain?.drained).toBe(true);
    expect(scripted.calls).toContain('npm ci --no-audit --no-fund');
    expect(scripted.calls).toContain('npm run build');
    expect(scripted.calls).toContain('npm run build:web');
    const marker = readRollMarker(fix.dataDir);
    expect(marker?.toSha).toBe(SHA_B);
    expect(marker?.fromSha).toBe(SHA_A);
    expect(marker?.reason).toBe('fixture');
    expect(marker?.requestedBy).toBe('test');
    expect(swaps).toEqual(['swap']);
    expect(readRollState(fix.dataDir)?.phase).toBe('swap');
  });

  it('skips the rebuild when the deploy clone is already stamped at the target sha', async () => {
    const fix = fixture();
    stampBuild(fix.repoRoot, SHA_B);
    const scripted = scriptedRunner({ heads: [SHA_A, SHA_B, SHA_B] });
    const { controller } = makeController(fix, { runner: scripted.run, readBuiltSha: () => SHA_B });
    const state = await controller.roll();
    expect(state.phase).toBe('swap');
    expect(state.preflight?.rebuilt).toBe(false);
    expect(state.preflight?.skippedBuildReason).toContain(SHA_B);
    expect(scripted.calls.some((call) => call.startsWith('npm '))).toBe(false);
  });

  it('drain waits for in-flight work and proceeds as soon as it settles', async () => {
    const fix = fixture();
    const scripted = scriptedRunner({ heads: [SHA_A, SHA_B, SHA_B], onBuild: () => stampBuild(fix.repoRoot, SHA_B) });
    const clock = { now: 1_000_000 };
    let probes = 0;
    const { controller } = makeController(fix, {
      runner: scripted.run,
      clock,
      drainTimeoutMs: 30_000,
      probeInFlight: async () => {
        probes += 1;
        return probes <= 2 ? [{ kind: 'round', id: 'round-1', status: 'live' }] : [];
      },
    });
    const state = await controller.roll();
    expect(state.phase).toBe('swap');
    expect(state.drain?.drained).toBe(true);
    expect(state.drain?.inFlightAtStart).toEqual([{ kind: 'round', id: 'round-1', status: 'live' }]);
    expect(state.drain?.abandoned).toEqual([]);
    expect(state.drain?.waitedMs).toBe(2_000);
  });

  it('drain bound: never-settling work is abandoned at the deadline, then the swap proceeds', async () => {
    const fix = fixture();
    const scripted = scriptedRunner({ heads: [SHA_A, SHA_B, SHA_B], onBuild: () => stampBuild(fix.repoRoot, SHA_B) });
    const clock = { now: 1_000_000 };
    const { controller, swaps } = makeController(fix, {
      runner: scripted.run,
      clock,
      drainTimeoutMs: 3_000,
      probeInFlight: async () => [
        { kind: 'minion', id: 'minion-7', status: 'streaming' },
      ],
    });
    const state = await controller.roll();
    expect(state.phase).toBe('swap');
    expect(state.drain?.drained).toBe(false);
    expect(state.drain?.abandoned).toEqual([{ kind: 'minion', id: 'minion-7', status: 'streaming' }]);
    expect(state.drain?.waitedMs).toBe(3_000);
    expect(readRollMarker(fix.dataDir)?.toSha).toBe(SHA_B);
    expect(swaps).toEqual(['swap']);
  });

  it('a second concurrent roll is refused while the first is still running', async () => {
    const fix = fixture();
    let releaseStatus: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const base = scriptedRunner({ heads: [SHA_A, SHA_B, SHA_B], onBuild: () => stampBuild(fix.repoRoot, SHA_B) });
    const gatedRun: RollRunner = async (command, args, options) => {
      if (command === 'git' && args[0] === 'status') await gate;
      return base.run(command, args, options);
    };
    const { controller } = makeController(fix, { runner: gatedRun });
    const first = controller.roll();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(controller.roll()).rejects.toBeInstanceOf(RollBusyError);
    releaseStatus();
    await expect(first).resolves.toMatchObject({ phase: 'swap' });
    expect(existsSync(join(fix.dataDir, 'roll-state.json'))).toBe(true);
  });
});
