import type { ServiceHandle } from './server.js';
import type { RuntimeRegistry } from './runtime/registry.js';
import type { SessionStore } from './sessions/store.js';
import type { ChatServer } from './chat/server.js';
import type { GruAwareness } from './chat/awareness.js';
import type { createBoardServer } from './board/server.js';
import type { LedgerDb } from './ledger/db.js';
import type { Supervisor } from './supervision/supervisor.js';
import type { DecisionRuntime } from './decisions/runtime.js';
import type { BobScheduler } from './dispatch/bob-scheduler.js';
import type { DreamScheduler } from './lessons/dream.js';
import type { SilasDriver } from './dispatch/silas-driver.js';
import type { ProviderRecoverySensor } from './provider-recovery/sensor.js';
import type { WaveRunner } from './dispatch/perkins.js';
import type { ChildWorkerService } from './dispatch/child-workers.js';
import type { createVerificationServer } from './verify/server.js';
import type { PipelineService } from './dispatch/pipeline.js';
import type { DeployDriftTracker } from './board/deploy-drift.js';
import type { ManagedRepoOverviewTracker } from './repos/overview.js';
import { disposeDirectiveResources, type DirectiveProgressService } from './dispatch/directive-progress.js';
import { SHUTDOWN_FORCE_EXIT_MS } from './shutdown-budget.js';

/**
 * Graceful-shutdown orchestration (issue #341). Extracted from `main.ts` with
 * ONE production seam — the process-exit function — so the deadline/re-arm
 * contract can be executed in tests against the ACTUAL caller wiring rather
 * than a reconstructed model: `main.ts` invokes `startServiceShutdown` with its
 * live state bag, and the regression suite drives the same function with a
 * recording `exit` under controlled timers.
 */
export interface ServiceShutdownState {
  handle?: ServiceHandle;
  registry?: RuntimeRegistry;
  store?: SessionStore;
  chat?: ChatServer;
  awareness?: GruAwareness;
  board?: Awaited<ReturnType<typeof createBoardServer>>;
  ledgerDb?: LedgerDb;
  supervisor?: Supervisor;
  decisions?: DecisionRuntime;
  bob?: BobScheduler;
  dream?: DreamScheduler;
  silas?: SilasDriver;
  providerRecovery?: ProviderRecoverySensor;
  wave?: WaveRunner;
  childWorkers?: ChildWorkerService;
  verify?: ReturnType<typeof createVerificationServer>;
  pipeline?: PipelineService;
  deployDrift?: DeployDriftTracker;
  directiveProgress?: DirectiveProgressService;
  repoOverview?: ManagedRepoOverviewTracker;
}

/** The logger surface the shutdown path uses; `Logger` satisfies it. */
export interface ServiceShutdownLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface ServiceShutdownOptions {
  readonly signal: string;
  readonly exitCode: number;
  readonly logger: ServiceShutdownLogger;
  readonly state: ServiceShutdownState;
  /** Pacing signal owned by the caller: aborted once, at `shutdown begin`. */
  readonly serviceStop: AbortController;
  /** Process-exit seam. Production passes `process.exit`; tests record it.
   * Called at most once per shutdown. */
  readonly exit: (code: number) => void;
}

/**
 * Run the graceful shutdown once. The caller owns the re-entrancy guard
 * (`shuttingDown`) and the pacing signal; this function performs the abort,
 * arms the force-exit guard, runs every stage isolated, re-arms the guard
 * immediately before the bounded runtime teardown, and exits exactly once.
 */
export function startServiceShutdown(options: ServiceShutdownOptions): void {
  const { signal, exitCode, logger, state, serviceStop, exit } = options;
  serviceStop.abort();
  logger.info('shutdown begin', { signal, exit_code: exitCode });
  const armForceExit = (): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      logger.error('shutdown timeout — forcing exit', { signal });
      exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    // Real Node timers pin the loop until fired unless unref'd; the guard must
    // not keep a drained process alive. Fake timers (tests) may not expose
    // unref — the controlled clock drives the guard there.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };
  let forceExit = armForceExit();
  if (state.handle === undefined) {
    clearTimeout(forceExit);
    logger.info('shutdown complete', { signal, note: 'signal arrived during boot' });
    exit(exitCode);
    return;
  }
  const handle = state.handle;
  void Promise.resolve()
    .then(async () => {
      // Each stage isolated: a failure in one must never skip lock
      // release or the final snapshot — the next boot's growth detection
      // depends on the snapshot reflecting what this process last saw
      // (SPEC ruling 12). Chat clients go first (1001 going-away) so
      // they queue before the runtime turns die (E4); the board's
      // clients follow (E6).
      if (state.chat !== undefined) {
        try {
          await state.chat.dispose();
        } catch (error) {
          logger.error('chat server shutdown failed', { error: String(error) });
        }
      }
      // After chat: the awareness layer's deferred-wake timer must not
      // outlive the sink it would call (idempotent, never fatal).
      if (state.awareness !== undefined) {
        try {
          state.awareness.dispose();
        } catch (error) {
          logger.error('awareness shutdown failed', { error: String(error) });
        }
      }
      if (state.board !== undefined) {
        try {
          await state.board.dispose();
        } catch (error) {
          logger.error('board server shutdown failed', { error: String(error) });
        }
      }
      if (state.decisions !== undefined) {
        try {
          state.decisions.dispose();
        } catch (error) {
          logger.error('decision runtime dispose failed', { error: String(error) });
        }
      }
      if (state.supervisor !== undefined) {
        try {
          state.supervisor.dispose();
        } catch (error) {
          logger.error('supervisor dispose failed', { error: String(error) });
        }
      }
      if (state.bob !== undefined) {
        try {
          state.bob.stop();
        } catch (error) {
          logger.error('bob scheduler stop failed', { error: String(error) });
        }
      }
      if (state.dream !== undefined) {
        try {
          state.dream.stop();
        } catch (error) {
          logger.error('lesson dream scheduler stop failed', { error: String(error) });
        }
      }
      if (state.silas !== undefined) {
        try {
          state.silas.stop();
        } catch (error) {
          logger.error('silas driver stop failed', { error: String(error) });
        }
      }
      if (state.providerRecovery !== undefined) {
        try {
          state.providerRecovery.stop();
        } catch (error) {
          logger.error('provider-recovery sensor stop failed', { error: String(error) });
        }
      }
      if (state.wave !== undefined) {
        try {
          await state.wave.shutdown();
        } catch (error) {
          logger.error('Perkins review shutdown failed', { error: String(error) });
        }
      }
      if (state.pipeline !== undefined) {
        try {
          state.pipeline.dispose();
        } catch (error) {
          logger.error('pipeline dispose failed', { error: String(error) });
        }
      }
      if (state.childWorkers !== undefined) {
        try {
          await state.childWorkers.dispose();
        } catch (error) {
          logger.error('child worker shutdown failed', { error: String(error) });
        }
      }
      if (state.verify !== undefined) {
        try {
          await state.verify.dispose();
        } catch (error) {
          logger.error('verification scheduler shutdown failed', { error: String(error) });
        }
      }
      state.deployDrift?.stop();
      state.repoOverview?.stop();
      // The runtime teardown is the one bounded stage this guard supervises
      // directly (concurrent post-dispose idle proofs + adapter bridge
      // closes). Re-arm it here so elapsed time in the earlier stages cannot
      // eat into that budget and preempt a healthy bounded teardown — the
      // loss #341 exists to contain (issue #341).
      clearTimeout(forceExit);
      forceExit = armForceExit();
      try {
        await disposeDirectiveResources(state.directiveProgress, state.registry);
      } catch (error) {
        logger.error('directive progress/registry dispose failed', { error: String(error) });
      }
      if (state.store !== undefined) {
        try {
          state.store.dispose();
          state.store.persistSnapshot();
        } catch (error) {
          logger.error('session store shutdown failed', { error: String(error) });
        }
      }
      if (state.ledgerDb !== undefined) {
        try {
          state.ledgerDb.close();
        } catch (error) {
          logger.error('ledger shutdown failed', { error: String(error) });
        }
      }
      await handle.stop();
    })
    .then(() => {
      clearTimeout(forceExit);
      logger.info('shutdown complete', { signal });
      // A roll swap exits with ROLL_SWAP_EXIT_CODE (75, non-zero): the
      // shipped launchd/systemd units restart on an unsuccessful exit
      // and stay down on a clean one. A normal stop keeps exit 0.
      exit(exitCode);
    })
    .catch((error: unknown) => {
      clearTimeout(forceExit);
      logger.error('shutdown failed', { signal, error: String(error) });
      exit(1);
    });
}
