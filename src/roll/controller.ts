import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '../logger.js';
import { readBuildInfo } from '../build-info.js';
import { runRollCommand, type RollCommandResult } from './runner.js';
import {
  ROLL_RECORD_SCHEMA_VERSION,
  type RollDrainRecord,
  type RollMarker,
  type RollPhase,
  type RollState,
  type RollWorkItem,
  updateRollState,
  writeRollMarker,
} from './state.js';

/**
 * Graceful self-roll state machine (issue #34 graduation heist).
 *
 * The service rolls ITSELF: preflight pulls/builds in the deploy clone
 * while the old process keeps serving, drain waits (bounded) for in-flight
 * work, swap writes the marker and exits so the OS service manager
 * relaunches the unit, and boot-time adoption verifies the new binary.
 *
 * Swap exit code — deliberately 75 (EX_TEMPFAIL), NOT 0. The shipped
 * units are `launchd KeepAlive {SuccessfulExit=false}` and
 * `systemd Restart=on-failure`: a clean exit(0) is a STOP and stays down,
 * so a roll finishing with exit(0) would leave the service dead until a
 * manual bounce. A non-zero maintenance exit is treated as restart-worthy
 * by both managers while `launchctl unload` / `systemctl stop` still stop
 * the unit for real (the stop removes the job; no restart arm applies).
 * This was verified against launchd on macOS with a scratch job: exit 0
 * stays down, exit 75 relaunches — and a descendant of the job that
 * unloads it is SIGTERM-killed with the job's process group (the exact
 * install.sh --update hang this lane removes).
 */
export const ROLL_SWAP_EXIT_CODE = 75;

/** Preflight command budgets: generous, bounded, and named in the failure. */
export const ROLL_NPM_CI_TIMEOUT_MS = 20 * 60_000;
export const ROLL_BUILD_TIMEOUT_MS = 15 * 60_000;

/** Artifacts a roll must find (or produce) before it is allowed to swap. */
const REQUIRED_ARTIFACTS: readonly string[] = [
  'dist/main.js',
  'dist/wizard/main.js',
  'dist/cli/config-generate.js',
  'dist/cli/service.js',
  'dist/runtime/review-mcp-server.mjs',
  'resources/perkins-code-review/policy.json',
  'tools/verify-perkins-resource.mjs',
  'web/dist/index.html',
];

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export type RollRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<RollCommandResult>;

export interface RollControllerOptions {
  readonly dataDir: string;
  /** The deploy clone (the checkout containing this dist). */
  readonly repoRoot: string;
  /** Bounded drain wait; 0 = do not wait (snapshot, abandon, swap). */
  readonly drainTimeoutMs: number;
  /** Poll interval while waiting for in-flight work to settle. */
  readonly drainPollMs?: number;
  readonly run?: RollRunner;
  /** In-flight review rounds + mid-turn agent sessions (empty = drained). */
  readonly probeInFlight: () => Promise<readonly RollWorkItem[]>;
  /** The SHA the deploy clone's dist is currently built from (fresh disk
   * stamp; null when unknown). Drives the rebuild-skip decision — after an
   * install.sh prebuild the clone is already stamped at the target. */
  readonly readBuiltSha: () => string | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newId?: () => string;
  readonly log?: Log;
  /**
   * Invoked after the swap marker is durably on disk: production initiates
   * the graceful shutdown and exits with ROLL_SWAP_EXIT_CODE so the OS
   * service manager relaunches the unit. Tests record instead.
   */
  readonly onSwap: (state: RollState) => void;
}

/** A roll is already running in this process (HTTP 409). */
export class RollBusyError extends Error {
  constructor() {
    super('a roll is already in progress');
    this.name = 'RollBusyError';
  }
}

function detailOf(error: unknown): string {
  return String(error).replace(/[\r\n]+/gu, ' ').slice(0, 500);
}

function failureDetail(result: RollCommandResult): string {
  const text = result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim();
  return text.replace(/[\r\n]+/gu, ' ').slice(0, 500) || `exit code ${result.code}`;
}

export class RollController {
  private readonly opts: RollControllerOptions;
  private readonly log: Log;
  private readonly run: RollRunner;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly drainPollMs: number;
  private current: RollState | null = null;
  private busy = false;

  constructor(opts: RollControllerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.run = opts.run ?? runRollCommand;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.drainPollMs = opts.drainPollMs ?? 5_000;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Latest in-memory record (the roll this process performed, if any). */
  state(): RollState | null {
    return this.current;
  }

  /**
   * Run one roll: preflight → drain → swap. Resolves with the terminal
   * record of THIS call (swap/done when relaunched, failed otherwise);
   * never rejects for operational failures — those become `failed` states
   * with the old service still serving. Throws RollBusyError when a roll
   * is already in progress in this process.
   */
  async roll(input: { reason?: string; requestedBy?: string; forceBuild?: boolean } = {}): Promise<RollState> {
    if (this.busy) throw new RollBusyError();
    this.busy = true;
    try {
      return await this.runRoll(input);
    } finally {
      this.busy = false;
    }
  }

  private async runRoll(input: { reason?: string; requestedBy?: string; forceBuild?: boolean }): Promise<RollState> {
    const startedMs = this.now();
    const rollId = (this.opts.newId ?? randomUUID)();
    let state: RollState = {
      schemaVersion: ROLL_RECORD_SCHEMA_VERSION,
      rollId,
      phase: 'preflight',
      reason: input.reason ?? null,
      requestedBy: input.requestedBy ?? 'operator',
      repoRoot: this.opts.repoRoot,
      fromSha: null,
      toSha: null,
      startedAt: new Date(startedMs).toISOString(),
      updatedAt: new Date(startedMs).toISOString(),
      preflight: null,
      drain: null,
      error: null,
      verify: null,
    };
    state = updateRollState(this.opts.dataDir, state, {}, this.now);
    this.current = state;
    this.log('info', 'roll begin', {
      roll_id: rollId,
      repo_root: this.opts.repoRoot,
      reason: state.reason,
      requested_by: state.requestedBy,
      built_sha: this.opts.readBuiltSha(),
    });

    try {
      state = await this.preflight(state, input.forceBuild === true);
    } catch (error) {
      return this.fail(state, 'preflight', error);
    }
    try {
      state = await this.drain(state);
    } catch (error) {
      return this.fail(state, 'drain', error);
    }
    try {
      state = await this.swap(state);
      return state;
    } catch (error) {
      return this.fail(state, 'swap', error);
    }
  }

  // ------------------------------------------------------------------
  // a. preflight — pull + deps + build, all while the old process serves
  // ------------------------------------------------------------------

  private async preflight(state: RollState, forceBuild: boolean): Promise<RollState> {
    const started = this.now();
    const cwd = this.opts.repoRoot;

    const fromSha = await this.git(cwd, ['rev-parse', 'HEAD'], 'preflight');
    const dirty = await this.run('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd,
      timeoutMs: 60_000,
    });
    if (dirty.code !== 0) {
      throw new Error(`git status failed in the deploy clone: ${failureDetail(dirty)}`);
    }
    if (dirty.stdout.trim() !== '') {
      throw new Error(
        'refusing to roll a dirty deploy clone — commit, stash, or remove local changes first ' +
          `(git status reports ${dirty.stdout.trim().split('\n').length} entr(ies))`,
      );
    }

    const pulled = await this.run('git', ['pull', '--ff-only'], { cwd, timeoutMs: 5 * 60_000 });
    if (pulled.code !== 0) {
      throw new Error(
        `fast-forward-only update failed; resolve divergence manually (no reset was attempted): ${failureDetail(pulled)}`,
      );
    }
    const toSha = await this.git(cwd, ['rev-parse', 'HEAD'], 'preflight');

    const builtSha = this.opts.readBuiltSha();
    const artifactsPresent = REQUIRED_ARTIFACTS.every((artifact) => existsSync(join(cwd, artifact)));
    let rebuilt = false;
    let skippedBuildReason: string | null = null;
    if (!forceBuild && builtSha !== null && builtSha === toSha && artifactsPresent) {
      skippedBuildReason = `already built at ${toSha}`;
      this.log('info', 'roll preflight: source already at the built sha — rebuild skipped', {
        roll_id: state.rollId,
        sha: toSha,
      });
    } else {
      this.log('info', 'roll preflight: installing dependencies', { roll_id: state.rollId, sha: toSha });
      const ci = await this.run('npm', ['ci', '--no-audit', '--no-fund'], {
        cwd,
        timeoutMs: ROLL_NPM_CI_TIMEOUT_MS,
      });
      if (ci.code !== 0) throw new Error(`npm ci failed: ${failureDetail(ci)}`);
      this.log('info', 'roll preflight: building service and local CLIs', { roll_id: state.rollId });
      const build = await this.run('npm', ['run', 'build'], { cwd, timeoutMs: ROLL_BUILD_TIMEOUT_MS });
      if (build.code !== 0) throw new Error(`npm run build failed: ${failureDetail(build)}`);
      this.log('info', 'roll preflight: building web UI', { roll_id: state.rollId });
      const web = await this.run('npm', ['run', 'build:web'], { cwd, timeoutMs: ROLL_BUILD_TIMEOUT_MS });
      if (web.code !== 0) throw new Error(`npm run build:web failed: ${failureDetail(web)}`);
      rebuilt = true;
      for (const artifact of REQUIRED_ARTIFACTS) {
        if (!existsSync(join(cwd, artifact))) {
          throw new Error(`build did not produce ${artifact}`);
        }
      }
      const stamped = readBuildInfo(cwd);
      if (stamped.rev !== toSha) {
        throw new Error(
          `build stamp mismatch: dist/build-rev.json says ${stamped.rev ?? '<missing>'} but the checkout is at ${toSha}`,
        );
      }
    }

    const headAfterBuild = await this.git(cwd, ['rev-parse', 'HEAD'], 'preflight');
    if (headAfterBuild !== toSha) {
      throw new Error(`checkout moved during preflight: expected ${toSha}, found ${headAfterBuild}`);
    }

    const preflight = {
      fromSha,
      toSha,
      pulled: fromSha !== toSha,
      rebuilt,
      skippedBuildReason,
      durationMs: this.now() - started,
    };
    this.log('info', 'roll preflight complete', {
      roll_id: state.rollId,
      from_sha: fromSha,
      to_sha: toSha,
      pulled: preflight.pulled,
      rebuilt,
      duration_ms: preflight.durationMs,
    });
    const next = updateRollState(
      this.opts.dataDir,
      state,
      { phase: 'drain', fromSha, toSha, preflight },
      this.now,
    );
    this.current = next;
    return next;
  }

  // ------------------------------------------------------------------
  // b. drain — bounded wait for in-flight rounds and mid-turn minions
  // ------------------------------------------------------------------

  private async drain(state: RollState): Promise<RollState> {
    const started = this.now();
    const deadline = started + this.opts.drainTimeoutMs;
    let inFlightAtStart: readonly RollWorkItem[] = [];
    let lastKey = '';
    let abandoned: readonly RollWorkItem[] = [];
    let drained = false;
    for (;;) {
      const inFlight = await this.opts.probeInFlight();
      const key = JSON.stringify(
        [...inFlight].map((item) => `${item.kind}:${item.id}:${item.status}`).sort(),
      );
      if (inFlight.length === 0) {
        drained = true;
        break;
      }
      if (inFlightAtStart.length === 0) inFlightAtStart = inFlight;
      if (key !== lastKey) {
        lastKey = key;
        this.log('info', 'roll drain waiting on in-flight work', {
          roll_id: state.rollId,
          in_flight: inFlight,
        });
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        abandoned = inFlight;
        this.log('warn', 'roll drain bound reached — proceeding with work still in flight', {
          roll_id: state.rollId,
          drain_timeout_ms: this.opts.drainTimeoutMs,
          abandoned,
        });
        break;
      }
      await this.sleep(Math.max(1, Math.min(this.drainPollMs, remaining)));
    }
    if (drained) {
      this.log('info', 'roll drain complete', {
        roll_id: state.rollId,
        in_flight_at_start: inFlightAtStart,
        waited_ms: this.now() - started,
      });
    }
    const drain: RollDrainRecord = {
      startedAt: new Date(started).toISOString(),
      deadlineAt: new Date(deadline).toISOString(),
      waitedMs: this.now() - started,
      drained,
      inFlightAtStart,
      abandoned,
    };
    const next = updateRollState(this.opts.dataDir, state, { phase: 'swap', drain }, this.now);
    this.current = next;
    return next;
  }

  // ------------------------------------------------------------------
  // c. swap — marker on disk, then hand control to the relaunch path
  // ------------------------------------------------------------------

  private async swap(state: RollState): Promise<RollState> {
    const toSha = state.toSha;
    if (toSha === null) throw new Error('swap without a preflight target sha');
    const head = await this.git(this.opts.repoRoot, ['rev-parse', 'HEAD'], 'swap');
    if (head !== toSha) {
      throw new Error(`checkout moved after preflight: expected ${toSha}, found ${head}`);
    }
    const marker: RollMarker = {
      schemaVersion: ROLL_RECORD_SCHEMA_VERSION,
      rollId: state.rollId,
      fromSha: state.fromSha,
      toSha,
      markedAt: new Date(this.now()).toISOString(),
      reason: state.reason,
      requestedBy: state.requestedBy,
    };
    writeRollMarker(this.opts.dataDir, marker);
    const next = updateRollState(this.opts.dataDir, state, { phase: 'swap' }, this.now);
    this.current = next;
    this.log('info', 'roll swap: marker written — exiting for supervised relaunch', {
      roll_id: state.rollId,
      from_sha: state.fromSha,
      to_sha: toSha,
      exit_code: ROLL_SWAP_EXIT_CODE,
    });
    this.opts.onSwap(next);
    return next;
  }

  // ------------------------------------------------------------------

  private async git(cwd: string, args: readonly string[], phase: RollPhase): Promise<string> {
    const result = await this.run('git', args, { cwd, timeoutMs: 60_000 });
    if (result.code !== 0) {
      throw new Error(`${phase}: git ${args.join(' ')} failed: ${failureDetail(result)}`);
    }
    return result.stdout.trim();
  }

  private fail(state: RollState, phase: RollPhase, error: unknown): RollState {
    const detail = detailOf(error);
    const next = updateRollState(
      this.opts.dataDir,
      state,
      { phase: 'failed', error: { phase, detail } },
      this.now,
    );
    this.current = next;
    this.log('error', 'roll failed — old service keeps serving', {
      roll_id: state.rollId,
      phase,
      detail,
    });
    return next;
  }
}
