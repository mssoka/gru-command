import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { configPathFor, loadConfig, ConfigError } from './config.js';
import { loadOrCreateIdentity } from './identity.js';
import { Logger } from './logger.js';
import { RuntimeRegistry } from './runtime/registry.js';
import { resolvePacingPolicy } from './runtime/pacing.js';
import { SessionStore } from './sessions/store.js';
import { LedgerDb } from './ledger/db.js';
import { LedgerApi, type NotificationRecord } from './ledger/api.js';
import { EventBus } from './events/bus.js';
import { BoardEngine } from './board/engine.js';
import { createBoardServer } from './board/server.js';
import { DeployDriftTracker } from './board/deploy-drift.js';
import { defaultPackageRoot, readBuildInfo } from './build-info.js';
import { createServiceReviewWave } from './dispatch/service-review-wave.js';
import { NotificationCenter } from './notifications/center.js';
import { Supervisor } from './supervision/supervisor.js';
import { TranscriptService } from './transcripts/service.js';
import { DispatchService } from './dispatch/service.js';
import { WorktreeManager } from './worktrees/manager.js';
import { createWorktreeServer } from './worktrees/server.js';
import type { WaveRunner } from './dispatch/perkins.js';
import { createReviewEscalationNotifier } from './dispatch/escalation-identity.js';
import { createStartupVerdictPoster } from './dispatch/perkins-github-app.js';
import { BobScheduler } from './dispatch/bob-scheduler.js';
import { SilasDriver, computeSilasDigest, consolidatedBlockersFor, supervisionLookup } from './dispatch/silas-driver.js';
import { createProductionDeterministicPass } from './dispatch/durable-reconcile.js';
import { ProviderRecoverySensor, establishProviderWait } from './provider-recovery/sensor.js';
import { ModelRuntimeProbe } from './provider-recovery/probe.js';
import {
  composeMetadataReaders,
  type NativeCommandPort,
  type NativeContextPort,
} from './provider-recovery/composition.js';
import { claimProviderRecoveryContinuation } from './provider-recovery/resume.js';
import { GhCliApi, GitHubSignalPoll, type LaneRemoteResolver } from './dispatch/github-poll.js';
import { routeFixDirectiveToMinion } from './dispatch/fix-directive.js';
import { reconcilePendingRebriefs, reconcilePendingDirectives } from './dispatch/rebrief-recovery.js';
import { adoptBlockedLanes, observeFollowUpDelivery, observePhaseCompletion, reconcilePhaseHandoffs, reconcileUnmarkedHandbacks } from './dispatch/obligations.js';
import { createDispatchServer } from './dispatch/server.js';
import { PipelineService } from './dispatch/pipeline.js';
import { ChildWorkerService } from './dispatch/child-workers.js';
import { createVerificationServer } from './verify/server.js';
import type { VerificationQueueView } from './verify/scheduler.js';
import { createService, type ServiceHandle } from './server.js';
import { adoptRollMarker, reconcileStaleRoll } from './roll/adopt.js';
import { RollController, ROLL_SWAP_EXIT_CODE } from './roll/controller.js';
import { createRollProbes } from './roll/probes.js';
import { createRollServer } from './roll/server.js';
import { readRollState } from './roll/state.js';
import { createAttachmentsServer } from './attachments/server.js';
import { uploadsDirNeedsHardening } from './attachments/resolver.js';
import { JournalStore } from './lessons/journal.js';
import { BibleStore } from './lessons/bible.js';
import { createBibleReferences } from './lessons/references.js';
import {
  DreamEngine,
  DreamScheduler,
  DREAM_STATE_FILE,
  dreamFailureIncidents,
  LessonProposals,
  lessonProposalNotifier,
  loadDreamState,
  repairCommand,
} from './lessons/dream.js';
import { AgentLessonsDistiller } from './lessons/distiller.js';
import { createSessionLessonsCapture } from './lessons/capture.js';
import { createReviewOutcomeCapture } from './lessons/review-capture.js';
import { createLessonsServer } from './lessons/server.js';
import { DecisionRuntime } from './decisions/runtime.js';
import { DECISION_SURFACE_EVENT_TRIAGE } from './decisions/questions.js';
import { isolateDecisionEnvironment } from './decisions/credentials.js';
import type { Role } from './config.js';
import type { GruCommandConfig } from './config.js';
import { defaultListenerProbe, foreignListener, type ListenerOwner } from './listener-probe.js';
import { dialHost } from './cli/service.js';
import {
  assertWorktreeListenPort,
  WorktreePortSquatRefused,
} from './service-port-guard.js';
import {
  isGitHubRemote,
  isGitLabRemote,
  probeGitHubRemote,
  probeGitLabRemote,
  probeReviewPolicy,
  repoRemote,
  runRuntimeReviewPreflight,
} from './dispatch/review-path.js';
import { loadPerkinsPolicy } from './dispatch/perkins-review/policy.js';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { NativeAgentTool, SpawnOptions } from './runtime/types.js';

/** Locate the installed bmad-review skill: check both the pi agent dir
 * and ~/.agents (the BMAD default install root) for maximum compatibility. */
function resolveBmadReviewSkillPath(): string {
  for (const base of [getAgentDir(), join(homedir(), '.agents')]) {
    const candidate = join(base, 'skills', 'bmad-review', 'SKILL.md');
    if (existsSync(candidate)) return candidate;
  }
  // Return the pi agent dir path as the default — the gate will report
  // 'not installed' if neither location has it.
  return join(getAgentDir(), 'skills', 'bmad-review', 'SKILL.md');
}

/** The process LISTENING on the configured instance port when it is not us
 * (null: free, ours, ephemeral, or the platform has no probe). Port-squat
 * prevention, owner incident 2026-09-23 — see src/listener-probe.ts. */
function instancePortForeignListener(config: GruCommandConfig): Promise<ListenerOwner | null> {
  if (config.server.port === 0) return Promise.resolve(null);
  return foreignListener({
    probe: defaultListenerProbe,
    host: dialHost(config.server.host),
    port: config.server.port,
    selfPid: process.pid,
  });
}

/** Hard error + action-required for a foreign listener on the instance port
 * (never a silent loopback 503). `when` distinguishes the pre-bind check
 * from the post-bind pid check in the log/detail. */
function reportForeignListener(
  foreign: ListenerOwner,
  config: GruCommandConfig,
  port: number,
  logger: Logger,
  notifications: NotificationCenter,
  when: 'before' | 'while',
): void {
  logger.log('error', 'foreign listener owns the instance port — refusing to serve', {
    host: config.server.host,
    port,
    foreign_pid: foreign.pid,
    foreign_command: foreign.command,
    detected: when,
  });
  notifications.post({
    kind: 'port-squat',
    routing: 'needs-owner',
    severity: 'error',
    title: `Foreign process holds port ${port} (pid ${foreign.pid})`,
    detail:
      `${foreign.command === '' ? 'unknown command' : foreign.command} (pid ${foreign.pid}) ` +
      `owns ${dialHost(config.server.host)}:${port} ` +
      `${when === 'before' ? 'before this service could bind it' : 'while this service bound the same port'} ` +
      '— loopback clients would reach the squatter. Stop it, then restart the service.',
  });
}

/** Fail-closed four-leg review pre-flight (user amendment 2026-09-20). */
async function reviewPreflightCheck(
  config: ReturnType<typeof loadConfig>,
  registry: RuntimeRegistry,
  repoPath: string,
): Promise<Awaited<ReturnType<typeof runRuntimeReviewPreflight>>> {
  let thinking: string | undefined;
  const preflight = await runRuntimeReviewPreflight(async () => {
    const model = await registry.prepareReviewModel('perkins');
    thinking = registry.reviewThinkingLevel('perkins');
    return model;
  }, {
    'resource-integrity': () => {
      loadPerkinsPolicy();
    },
    'code-host': async () => {
      const remote = repoRemote(repoPath);
      if (remote === null) throw new Error(`repository origin is not a parseable https/ssh remote: ${repoPath}`);
      if (isGitHubRemote(remote.host)) probeGitHubRemote(remote);
      else if (isGitLabRemote(remote.host)) await probeGitLabRemote(remote, process.env['GITLAB_TOKEN'] ?? process.env['GL_TOKEN']);
      else {
        throw new Error(
          `unsupported code host '${remote.host}' — the review gate supports GitHub (gh) and GitLab (GITLAB_TOKEN) remotes`,
        );
      }
    },
    'review-policy': () => probeReviewPolicy({ reviewEnabled: () => config.review.enabled }),
  });
  return preflight.ok && thinking !== undefined ? { ...preflight, reviewThinkingLevel: thinking } : preflight;
}
import { ChatFrameLog } from './chat/frame-log.js';
import { createChatServer, type ChatServer } from './chat/server.js';
import { GruAwareness } from './chat/awareness.js';
import { BOARD_WS_PATH } from './board/frames.js';
import { GruSessionPointer } from './chat/session-state.js';
import { createStaticRoot, defaultStaticRoot } from './static.js';
import { SERVICE_NAME, VERSION } from './version.js';

/** Non-secret override flags from the Claude settings file (presence
 * booleans only; values never read into memory beyond the check). A
 * missing/unreadable file counts as NO override — the env overrides and
 * the keychain item itself remain the binding proofs. */
function claudeSettingsOverridesPresent(): boolean {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['apiKeyHelper'] === 'string' && parsed['apiKeyHelper'] !== '') return true;
    const env = parsed['env'];
    if (typeof env !== 'object' || env === null) return false;
    const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];
    return keys.some((key) => (env as Record<string, unknown>)[key] !== undefined);
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const bootHr = process.hrtime.bigint();
  // Capture once, then remove the provider key from the ambient process
  // environment before probes, agents, setup hooks, git, or gh can spawn.
  const decisionEnvironment = isolateDecisionEnvironment();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          msg: 'configuration invalid — refusing to start',
          detail: error.message,
        })}\n`,
      );
      return 1;
    }
    throw error;
  }

  // Port-squat prevention (owner incident 2026-09-23): a service spawned
  // from a git worktree must never bind the instance port — macOS lets a
  // loopback squatter coexist with the real wildcard/LAN bind, so this is
  // refused BEFORE any instance state is touched or any socket binds.
  try {
    assertWorktreeListenPort({
      checkoutRoot: defaultPackageRoot(),
      port: config.server.port,
      env: process.env,
    });
  } catch (error) {
    if (error instanceof WorktreePortSquatRefused) {
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          msg: 'refusing to listen from a worktree checkout',
          detail: error.message,
        })}\n`,
      );
      return 1;
    }
    throw error;
  }

  const logger = new Logger(config.dataDir, true, {
    maxBytes: config.logging.maxBytes,
    keep: config.logging.keep,
  });
  const identity = loadOrCreateIdentity(config.dataDir);
  const buildInfo = readBuildInfo();
  const repoRoot = defaultPackageRoot();
  logger.info('boot', {
    service: SERVICE_NAME,
    version: VERSION,
    pid: process.pid,
    workspace_root: config.workspaceRoot,
    data_dir: config.dataDir,
    config_file: configPathFor(config.instanceDir),
    config_loaded: config.sourceFile !== null,
    default_runtime: config.runtimes.default,
    install_id: identity.installId,
    build_sha: buildInfo.rev,
  });
  // Self-roll adoption (issue #34): the previous process wrote the swap
  // marker and exited for relaunch; this boot consumes it — logs
  // "rolled to <sha>", marks the record done, clears the marker. Sessions
  // resume through the existing boot path (#42 cure); the roll's drain
  // phase is what keeps a swap from interrupting a live turn by design.
  const rollAdoption = adoptRollMarker({
    dataDir: config.dataDir,
    runningSha: buildInfo.rev,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // A roll record that never swapped (restart for another reason mid-roll)
  // must not read as live: reconcile it to failed after adoption.
  reconcileStaleRoll({
    dataDir: config.dataDir,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // E9 / SPEC ruling 19: uploads-dir scaffolding next to the other
  // instance dirs (logs/, chat/) — DIRECTORY CREATION ONLY in E9; the
  // attach flow (this lane) rides it for clipboard/phone material.
  // Instance state stays under the data dir, never inside the workspace
  // root (ruling 7). Failure is loud and named (EACCES/ENOSPC never
  // surface as a raw stack).
  const uploadsDir = join(config.dataDir, 'uploads');
  try {
    // 0700 like every other instance dir (chat/, sessions/, ledger/) —
    // uploads will carry user material; not group/world traversable.
    mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
    // W-D (E9 r3 carry): creation-only 0700 left a pre-existing 0755
    // uploads dir loose forever — harden at EVERY boot, refuse to start
    // when the chmod fails (a perms regression must never boot quiet).
    if (uploadsDirNeedsHardening(uploadsDir)) {
      const previousMode = statSync(uploadsDir).mode & 0o777;
      chmodSync(uploadsDir, 0o700);
      logger.info('uploads_dir hardened to 0700 (was loose)', {
        path: uploadsDir,
        previous_mode: previousMode.toString(8),
      });
    }
    logger.info('uploads_dir', { path: uploadsDir });
  } catch (error) {
    logger.error('uploads dir creation failed — refusing to start (SPEC ruling 19)', {
      path: uploadsDir,
      error: String(error),
    });
    return 1;
  }

  // Crash forensics: structured fatal lines for anything that escapes, so
  // the JSON-lines log stays the record even under OS-service restarts.
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception', { error: String(error), stack: error.stack });
    // Best-effort: leave the size snapshot honest for the next boot's
    // growth detection even when the graceful shutdown path never runs.
    try {
      state.store?.persistSnapshot();
    } catch {
      /* dying anyway */
    }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { reason: String(reason) });
    process.exit(1);
  });

  const state: {
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
  } = {};
  let shuttingDown = false;
  /** Service-stopping signal (pacing): aborts QUEUED admission waits and
   * lets delivery settlement observe shutdown instead of hanging. */
  const serviceStop = new AbortController();
  const shutdown = (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    serviceStop.abort();
    logger.info('shutdown begin', { signal, exit_code: exitCode });
    const forceExit = setTimeout(() => {
      logger.error('shutdown timeout — forcing exit', { signal });
      process.exit(1);
    }, 5_000);
    forceExit.unref();
    if (state.handle === undefined) {
      clearTimeout(forceExit);
      logger.info('shutdown complete', { signal, note: 'signal arrived during boot' });
      process.exit(exitCode);
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
        if (state.registry !== undefined) {
          try {
            await state.registry.dispose();
          } catch (error) {
            logger.error('registry dispose failed', { error: String(error) });
          }
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
        process.exit(exitCode);
      })
      .catch((error: unknown) => {
        clearTimeout(forceExit);
        logger.error('shutdown failed', { signal, error: String(error) });
        process.exit(1);
      });
  };
  // Registered before the server starts so a signal in the boot window is
  // still a graceful, logged exit.
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Runtime layer (E2): durable session store + adapter registry, booted
  // BEFORE the server so /health can answer with real signals from the
  // first request. Growth findings also hit the log (SPEC ruling 12).
  const store = new SessionStore(config.dataDir, { log: (level, msg, fields) => logger.log(level, msg, fields) });
  const registry = new RuntimeRegistry({
    config,
    store,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const growth = registry.boot();
  state.store = store;
  state.registry = registry;
  logger.info('session store ready', {
    sessions_dir: store.sessionsDir,
    growth_findings: growth.findings.length,
  });

  // Ledger + board (E6): the SQLite record opens (and migrates) before
  // the HTTP server so a schema failure refuses boot loudly. The board
  // engine feeds on the registry tap; the transcript service reads the
  // session store.
  const ledgerDb = new LedgerDb(config.dataDir, { log: (level, msg, fields) => logger.log(level, msg, fields) });
  const bus = new EventBus({
    onListenerError: (message) => logger.log('error', 'event bus listener failed', { detail: message }),
  });
  const ledger = new LedgerApi(ledgerDb.handle, { bus });
  // Book of Lessons (owner design 2026-09-23): the journal is deliberate
  // capture; the bible is the distilled, pointer-referenceable memory. The
  // store is created here so the HTTP surface and the dispatch injection
  // share one instance; the dream cadence starts with Bob's slot below.
  const journal = new JournalStore(join(config.dataDir, 'journal'), {
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const bible = new BibleStore(join(config.dataDir, 'bible'), {
    chapterCapBytes: config.lessons.chapterCapBytes,
    indexCapBytes: config.lessons.indexCapBytes,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // A pristine book is seeded; a damaged one (chapters or state but no
  // INDEX.md) is never silently recreated — logged here, and every dream
  // pass fails loudly on it (an action-required incident).
  try {
    bible.ensureSeeded();
  } catch (error) {
    logger.log('error', 'the Book of Lessons is damaged — not seeded', { error: String(error) });
  }
  const lessonReferences = createBibleReferences({
    bible,
    maxReferences: config.lessons.maxReferences,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const lessonsCapture = createSessionLessonsCapture({
    journal,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // Perkins verdicts are learning inputs (issue #221): every posted round
  // verdict journals its consolidated blockers as deliberate finding
  // entries (source perkins:<round>), so the dream learns from reviews
  // without Bob's hourly pass. Idempotent per round via a sidecar next to
  // the review artifacts; runs regardless of [lessons] enabled — capture
  // is deliberate and must never be lost.
  createReviewOutcomeCapture({
    bus,
    journal,
    artifactRoot: join(config.dataDir, 'reviews'),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // E7: late-bound supervision feed — the engine is constructed before
  // the supervisor exists; the closure resolves per snapshot.
  let supervisor: Supervisor | null = null;
  let decisions: DecisionRuntime | null = null;
  // Deploy drift (board UX v4): the running build's revision vs
  // origin/main. The tracker checks in the background (boot is never
  // blocked by git/network) and the snapshot carries the cached view.
  const deployDrift = new DeployDriftTracker({
    repoRoot: defaultPackageRoot(),
    build: readBuildInfo(),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // Late-bound (the verification server lands below) — same pattern as
  // supervisionFor / decisionsStatus above.
  let verificationView: () => VerificationQueueView | null = () => null;
  // Durable pipeline queue (owner approvals j-239/j-1064): late-bound too —
  // the mechanical consumer is constructed after the dispatcher it feeds.
  let pipelineView: () => import('./ledger/pipeline.js').PipelineBoardView | null = () => null;
  let pipeline: PipelineService | null = null;
  // Provider pacing (owner heist 2026-09-29): one resolved policy for the
  // process — the optional rate-limit backoff plus the FIFO admission gate
  // shared by worker dispatches, directive deliveries, and Perkins rounds.
  // Every queue/admission lands on the ledger; the board snapshot carries
  // the live gate view. Default admission is enabled and unlimited; operators set
  // turn caps independently of the resident-session budget.
  const pacing = resolvePacingPolicy(config.pacing, {
    record: (event) => {
      ledger.appendCustomEvent({
        kind: event.kind,
        agentId: event.agentId ?? null,
        jobId: event.jobId ?? null,
        payload: event.payload,
      });
    },
  });
  const engine = new BoardEngine({
    ledger,
    bus,
    supervisionFor: (agentId) => supervisor?.viewFor(agentId) ?? null,
    // Issue #171 truthful agent status: the live registry's handle set is
    // the authoritative current-runtime ownership probe. Together with the
    // supervision feed (adoptions + hydrated durable stops) it classifies
    // every ledger row as current / historical / unverified — stale rows
    // left by an unclean stop no longer read as live crew.
    runtimeOwnership: () => ({
      ownedAgentIds: new Set(registry.listHandles().map((handle) => handle.id)),
    }),
    pacing: () => (config.pacing.enabled ? pacing.gate.view() : null),
    decisionsStatus: () => decisions?.status() ?? {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: config.decisions.jev.model,
      endpoint: config.decisions.jev.endpoint,
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'service-not-started',
      generation: 0,
    },
    buildDrift: () => deployDrift.view(),
    verifyQueue: () => verificationView(),
    pipeline: () => pipelineView(),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  registry.onAgentEvent((envelope) => {
    engine.onRuntimeEvent(envelope);
    pipeline?.noteRuntimeEvent(envelope);
  });
  deployDrift.start();
  state.deployDrift = deployDrift;

  // Chat (E4): the single Gru session behind /ws. The durable frame log
  // loads and boot-settles BEFORE the HTTP server accepts anything (r1
  // N13): a corrupt log refuses boot without ever having listened, and no
  // client can attach to an unsettled log. The Gru spawn is lazy-warm
  // (warmup is best-effort, first message retries under the chat spawn
  // backoff) so a model outage can never keep the service down. Since E7
  // the Gru session runs behind a SUPERVISED slot: the supervisor adopts
  // it, watches turn liveness, restarts it up the ladder, and trips the
  // crash-loop breaker.
  const chatDir = join(config.dataDir, 'chat');
  const frameLog = ChatFrameLog.load(
    chatDir,
    (level, msg, fields) => logger.log(level, msg, fields),
    { maxBytes: config.chat.frameLogMaxBytes, keep: config.chat.frameLogKeep },
  );
  // Needs-owner notifications surface in chat (SPEC ruling 13; owner routing
  // split 2026-09-23: action-required is MACHINE attention and never renders
  // in a human-facing band — the awareness wake carries it to Gru instead).
  // The chat server arrives one step below; late-bind the callback.
  let surfaceInChat: (notification: NotificationRecord) => void = () => {};
  const notifications = new NotificationCenter({
    ledger,
    bus,
    onNeedsOwner: (notification) => surfaceInChat(notification),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // Owner-approved Book of Lessons (owner decision 2026-10-07): the dream
  // proposes, the owner decides in For You, and only Accept writes.
  const lessonProposals = new LessonProposals({
    bible,
    notifier: lessonProposalNotifier({ notifications, ledger }),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // A decision interrupted by a crash or restart is finished, a stale
  // proposal withdrawn, and a pending one's For You notice re-ensured. A
  // corrupt record is logged here and fails the next dream pass loudly.
  try {
    lessonProposals.reconcile();
  } catch (error) {
    logger.log('error', 'lesson proposal reconcile failed at startup', { error: String(error) });
  }
  const lessonsServer = createLessonsServer({
    config,
    journal,
    bible,
    references: lessonReferences,
    proposals: lessonProposals,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // Durable follow-through observers: (a) an explicitly marked bounded
  // phase whose VALIDATED correlated completion landed records the owed
  // Gru decision durably (one obligation + one stable-kind action-required
  // hand-back on the existing wake path, even with no head move and on a
  // NONblocked lane); (b) the legacy blocked-only hand-back stays for
  // unmarked silas deliveries. Registered before boot recovery so
  // recovered deliveries are observed too. Observer failures are logged,
  // never bus-breaking.
  bus.subscribe((event) => {
    try {
      observePhaseCompletion(
        { ledger, notifications, log: (level, msg, fields) => logger.log(level, msg, fields) },
        event,
      );
    } catch (error) {
      logger.log('error', 'phase-completion observer failed', {
        kind: event.kind,
        job: event.jobId,
        error: String(error),
      });
    }
    try {
      observeFollowUpDelivery(
        { ledger, notifications, log: (level, msg, fields) => logger.log(level, msg, fields) },
        event,
      );
    } catch (error) {
      logger.log('error', 'follow-through observer failed', {
        kind: event.kind,
        job: event.jobId,
        error: String(error),
      });
    }
  });
  const decisionRuntime = new DecisionRuntime(config.decisions, {
    instanceDir: config.instanceDir,
    env: decisionEnvironment,
    // The enforce gate (#223) reads recorded backtest evidence from the
    // instance data directory.
    dataDir: config.dataDir,
    // Durable shadow ledger (#223): one decisions.shadow event per shadow
    // ask; recorder failures are isolated inside the runtime.
    onShadowRecord: (record) => {
      ledger.appendCustomEvent({ kind: 'decisions.shadow', payload: record });
    },
    notifications,
    onStatusChange: (status) => {
      ledger.appendCustomEvent({
        kind: 'decisions.status',
        payload: {
          enabled: status.enabled,
          status: status.status,
          reason: status.reason,
          model: status.model,
          credential_source: status.credentialSource,
          incarnation: status.incarnation,
          generation: status.generation,
        },
      });
    },
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  decisions = decisionRuntime;
  state.decisions = decisionRuntime;
  notifications.setDecisionService(
    decisionRuntime,
    () => decisionRuntime.readyFor(DECISION_SURFACE_EVENT_TRIAGE),
  );
  // Provider-recovery sensor (owner-approved 2026-09-28): constructed
  // BEFORE the supervisor so its recorder can observe wall stops, with
  // late-bound wake (SilasDriver lands below) and guarded re-arm ports.
  // Disabled by config = fully inert (no waits, no probes, no wakes).
  const silasWakePort: {
    trigger: (input: { kind: 'provider.restored'; routeKey: string }) => Promise<void>;
  } = {
    trigger: async (input) => {
      const driver = state.silas;
      if (driver === undefined) {
        logger.log('warn', 'provider-restored wake dropped — silas driver not yet started (the sweep retries)', {
          route: input.routeKey,
        });
        return;
      }
      await driver.trigger({ kind: 'provider.restored' });
    },
  };
  const slotReArmPort = {
    ownedProviderReArm: (agentId: string, waitId: string): boolean =>
      supervisorLive.ownedProviderReArm(agentId, waitId),
  };
  // Non-generation metadata readers (owner-approved overlay), composed
  // from read-only installed source interfaces: codex rides a nonmutating
  // one-off auth.json read (readStoredCredential — no store run, no
  // refresh); claude composes against the typed native snapshot port whose
  // platform proof is the keychain item itself (never a hardcoded brand
  // flag). ZERO generation on these paths, and their failures never fall
  // back to generation.
  const providerRecoverySensor = new ProviderRecoverySensor({
    config: config.providerRecovery,
    ledger,
    probe: new ModelRuntimeProbe({
      runtime: () => registry.piModelRuntime(),
      // The documented conservative finite bound governs the generation
      // probe too — not only the metadata readers/reservation expiry.
      timeoutMs: config.providerRecovery.probeTimeoutMs,
    }),
    metadataReaders: composeMetadataReaders({
      config: config.providerRecovery,
      codexAuthPath: undefined, // readStoredCredential resolves the installed auth.json itself
      fetch: {
        get: async ({ url, authorization, accept, timeoutMs, extraHeaders }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          timer.unref?.();
          try {
            const response = await fetch(url, {
              headers: { authorization, accept, ...(extraHeaders ?? {}) },
              signal: controller.signal,
              redirect: 'manual',
            });
            return { status: response.status, body: await response.text() };
          } finally {
            clearTimeout(timer);
          }
        },
      },
      claude: {
        // Traced native protocol: one bounded `security find-generic-password`
        // against the ACTUAL selected store/account. Never invoked while the
        // sensor is disabled; activation runs it under a ruled checkpoint.
        // Output stays in-process — never logged.
        command: {
          findGenericPassword: async ({ service, account }) => {
            const { execFile } = await import('node:child_process');
            return await new Promise((resolve) => {
              execFile(
                'security',
                ['find-generic-password', '-s', service, '-a', account, '-w'],
                { timeout: 10_000 },
                (error, stdout) => {
                  if (error !== null) resolve(null);
                  else resolve({ exitCode: 0, stdout: String(stdout) });
                },
              );
            });
          },
        } satisfies NativeCommandPort as NativeCommandPort,
        // OBSERVED context only (phase3 ruling: never assert a selected
        // platform): env overrides plus non-secret flags from the Claude
        // settings file. Presence booleans only — values never logged.
        context: (): NativeContextPort => ({
          overridesPresent:
            process.env['ANTHROPIC_API_KEY'] !== undefined ||
            process.env['ANTHROPIC_AUTH_TOKEN'] !== undefined ||
            process.env['ANTHROPIC_BASE_URL'] !== undefined ||
            process.env['CLAUDE_CODE_OAUTH_TOKEN'] !== undefined ||
            process.env['CLAUDE_CODE_USE_BEDROCK'] !== undefined ||
            process.env['CLAUDE_CODE_USE_VERTEX'] !== undefined ||
            process.env['CLAUDE_CODE_USE_FOUNDRY'] !== undefined ||
            process.env['CLAUDE_CONFIG_DIR'] !== undefined ||
            claudeSettingsOverridesPresent(),
        }),
        account: () => process.env['USER'] ?? '',
      },
      log: (level, msg, fields) => logger.log(level, msg, fields),
    }),
    notifications,
    wake: silasWakePort,
    slotReArm: slotReArmPort,
    silasHosted: () => config.silas.enabled,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  state.providerRecovery = providerRecoverySensor;
  const supervisorLive = new Supervisor({
    config: config.supervision,
    registry,
    ledger,
    notifications,
    decisions: decisionRuntime,
    rateLimitBackoff: pacing.backoff,
    workerGate: pacing.gate,
    providerWalls: {
      // Machine-vs-owner classification BEFORE any owner stop (phase3 r1
      // #2): the sink persists an eligible machine-owned wait FIRST and
      // answers true; false/throw keeps the conservative needs-owner stop.
      ownsProviderWall: async (input) => {
        const wait = await establishProviderWait(providerRecoverySensor, {
          agentId: input.agentId,
          role: input.role,
          slotId: input.slotId,
          jobId: input.jobId,
          sessionFile: input.sessionFile,
          failureClass: input.failureClass,
          provider: input.source?.provider ?? null,
          model: input.source?.model ?? null,
          errorMessage: input.source?.error ?? '',
          typed: input.source?.typed ?? null,
          incidentId: null,
          continuation: input.continuation,
        }).catch((error: unknown) => {
          logger.log('error', 'provider wait establishment failed (conservative owner stop kept)', {
            agent_id: input.agentId,
            error: String(error),
          });
          return null;
        });
        return wait !== null;
      },
      // Link the machine-owned action-required notice onto the persisted
      // wait: the incident resolves with the wait's own terminal lifecycle.
      linkProviderWaitIncident: ({ agentId, incidentId }) => {
        const wait = ledger.openProviderWaitForAgent(agentId);
        if (wait !== null) ledger.setProviderWaitIncident(wait.id, incidentId);
      },
      // The observation report for NON-machine-owned stops (incidentId
      // null): the sink re-classifies; ineligible classes stay owner-held.
      onProviderWall: (observation) => {
        void establishProviderWait(providerRecoverySensor, {
          agentId: observation.agentId,
          role: observation.role,
          slotId: observation.slotId,
          jobId: observation.jobId,
          sessionFile: observation.sessionFile,
          failureClass: observation.failureClass,
          provider: observation.source?.provider ?? null,
          model: observation.source?.model ?? null,
          errorMessage: observation.source?.error ?? '',
          typed: observation.source?.typed ?? null,
          incidentId: observation.incidentId,
          continuation: observation.continuation,
        }).catch((error: unknown) => {
          logger.log('error', 'provider wait establishment failed', {
            agent_id: observation.agentId,
            error: String(error),
          });
        });
      },
    },
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  supervisor = supervisorLive;
  // Reclaim quiescence: supervisor truth only. An UNKNOWN openControl
  // (field absent) is explicitly non-reclaimable and observed once per
  // affected handle — never silently treated as closed.
  const openControlUnknownSeen = new Set<string>();
  registry.setReclaimProbe((agentId) => {
    const view = supervisorLive.viewFor(agentId);
    if (view === null) return false;
    if (view.openControl === undefined) {
      if (!openControlUnknownSeen.has(agentId)) {
        openControlUnknownSeen.add(agentId);
        ledger.appendCustomEvent({
          kind: 'resident.open-control-unknown', jobId: null,
          payload: { agentId, note: 'supervision view lacks openControl evidence; handle treated as non-reclaimable' },
        });
      }
      return false;
    }
    return view.state === 'watching' && view.slotId === null &&
      !view.openTurn && view.openControl === false && view.openToolCalls === 0;
  });
  // Durable, deduplicated reclaim-failure relay: one event per handle per
  // drain epoch (the budget guarantees the bound); capacity accounting is
  // untouched — a failed disposal keeps its permit.
  // Per-boot dedup only (memory set): the durable bound is the budget's
  // one-attempt-per-handle-per-epoch rule; nothing here promises an
  // across-restart guarantee. The relayed error is truncated and scrubbed
  // of credential-shaped content — diagnostics never carry secrets.
  const reclaimFailedSeen = new Set<string>();
  registry.residents.onReclaimFailure = (observation) => {
    const dedupeKey = `${observation.agentId}:${observation.generation}:${observation.attempt}`;
    if (reclaimFailedSeen.has(dedupeKey)) return;
    reclaimFailedSeen.add(dedupeKey);
    // Controlled reason codes only: no arbitrary exception text (which can
    // embed bearer/basic headers, URL credentials, or assignments) enters
    // the durable record.
    const reason = /token|secret|password|api[_-]?key|authorization|bearer|basic\s/iu.test(observation.error)
      ? 'disposal-rejected-credential-shaped'
      : 'disposal-rejected';
    ledger.appendCustomEvent({
      kind: 'resident.reclaim-failed', jobId: null,
      payload: { agentId: observation.agentId, generation: observation.generation, attempt: observation.attempt, reason },
    });
  };
  const gruSlot = supervisorLive.declareSlot({
    id: 'gru-main',
    role: 'gru',
    spawn: (spawnOptions) => registry.spawn('gru', spawnOptions ?? {}),
  });
  // Gru awareness (dispatch briefing 2026-09-22): ledger-derived escalations
  // + lane digest for the chat brain. Constructed before the chat server so
  // each prompt can pull a block; the wake sink binds once chat exists.
  const awareness = new GruAwareness({
    dir: chatDir,
    ledger,
    bus,
    wakeMode: config.chat.notifyWake,
    wakeMinIntervalMs: config.chat.wakeMinIntervalMs,
    wakeMinSeverity: config.chat.wakeMinSeverity,
    wakeQuietHours: config.chat.wakeQuietHours,
    wakeDeferCovered: config.chat.wakeDeferCovered,
    morningDigestGapMs: config.chat.morningDigestGapMs,
    onFollowUpPosted: (notification) => surfaceInChat(notification),
    // Issue #224 shadow wiring: escalation-triage asks at the delivery
    // receipt. Asks fire ONLY when the escalation_triage surface is
    // explicitly configured `mode = "shadow"` and its routed profile is
    // ready; the runtime records without changing wake behavior.
    decisions: decisionRuntime,
    readyForSurface: (surface) => decisionRuntime.readyFor(surface),
    modeForSurface: (surface) => decisionRuntime.surfaceMode(surface),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const chat = createChatServer({
    config,
    frameLog,
    pointer: new GruSessionPointer(chatDir, (level, msg, fields) => logger.log(level, msg, fields)),
    spawnGru: (resumeFile, source) => gruSlot.ensure({
      ...(resumeFile !== null ? { resumeFile } : {}),
      intent: source === 'chat' ? 'user' : 'autonomous',
    }),
    canWakeGru: () => gruSlot.canReplace(),
    // New chat deliberately bypasses ensure(): it must mint without resume
    // even while the old supervised slot is healthy. Activation then advances
    // the slot generation so no stale restart can swap the old epoch back in.
    spawnFreshGru: () => registry.spawn('gru', {}),
    canAdoptFreshGru: () => gruSlot.canReplace(),
    adoptFreshGru: (handle) => gruSlot.adoptReplacement(handle),
    siblingUpgradePaths: [BOARD_WS_PATH],
    awareness,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // Bind the backlog wake only after the HTTP listener and the board/chat
  // routes are ready; Gru must be able to disposition the alert in-turn.
  state.awareness = awareness;
  gruSlot.onSwap((handle) => chat.adoptRestartedGru(handle));
  surfaceInChat = (notification) => {
    chat.surfaceNotice(
      `🔔 For you: ${notification.title}${notification.detail !== null ? ` — ${notification.detail}` : ''}`,
      () => {
        // Receipt follows durable persistence/broadcast, including notices
        // queued across a reset boundary. Rejected/failed notices stay unshown.
        notifications.markShown(notification.id, 'gru-chat');
      },
    );
  };
  state.supervisor = supervisorLive;
  // Enabled installs perform exactly one bounded synthetic check before
  // the server listens; disabled installs do not resolve a credential or
  // start a request. Chat notification persistence is bound first so a
  // boot-time degradation is visible to clients that connect later.
  await decisionRuntime.start();

  const board = createBoardServer({
    config,
    engine,
    ledger,
    transcripts: new TranscriptService(store.sessionsDir, { ledger }),
    bus,
    notifications,
    onNotificationAck: (id) => supervisorLive.onNotificationAcked(id),
    decisionsStatus: () => decisionRuntime.status(),
    onDecisionsRecheck: () => decisionRuntime.recheck(),
    siblingUpgradePaths: ['/ws'],
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  state.ledgerDb = ledgerDb;
  state.board = board;
  logger.info('ledger ready', { db_path: ledgerDb.dbPath });

  // Worktree manager (SPEC ruling 18; its own review lane): the port the
  // dispatch flow rides on, plus the release/answer endpoints it owns.
  const worktreeManager = new WorktreeManager({
    ledger,
    root: config.worktrees.root,
    preserveRoot: config.worktrees.preserveRoot,
    setupTimeoutMs: config.worktrees.setupTimeoutMs,
    onBaseFallback: ({ repoName, worktreeId, defaultBranch, sha, detail }) => {
      // Degraded lane creation (owner incident 2026-09-23): origin could
      // not be fetched, so the lane branched from the host clone's local
      // HEAD. The registry row carries base_source; this FYI makes the
      // staleness visible on the operator's surfaces instead of silent.
      notifications.post({
        kind: 'worktree-base-fallback',
        routing: 'fyi',
        severity: 'info',
        title: `Worktree base fell back to local HEAD: ${repoName}`,
        detail:
          `${defaultBranch === null ? 'origin default branch unresolvable' : `origin/${defaultBranch} fetch failed`} (${detail}) — ` +
          `lane ${worktreeId} branched from local HEAD ${sha}; its base may be stale until origin is reachable`,
      });
    },
    onSweepPaused: ({ worktree, processes }) => {
      notifications.post({
        kind: 'worktree-sweep-paused',
        // Destructive-op confirmation: the sweep waits for the OWNER's
        // ruling (preserve-before-remove), so it is needs-owner — never a
        // machine wake and never an auto-clear.
        routing: 'needs-owner',
        severity: 'info',
        title: `Worktree sweep paused: live processes in ${worktree.repoName}`,
        detail:
          `${processes.length} process(es) rooted in ${worktree.path} ` +
          `(pids ${processes.map((p) => p.pid).join(', ')}) — acknowledge to confirm removal`,
      });
    },
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const worktreeServer = createWorktreeServer({
    config,
    manager: worktreeManager,
    ledger,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // Tracked child workers (issue #161): GC-owned nested workers. Kids
  // ride the SAME spawner, resident budget and pacing gate as any other
  // minion turn; GC owns admission, parentage, lifecycle and results.
  // Constructed BEFORE the dispatcher: a dispatched parent's scoped
  // capability is minted here and named in its briefing.
  const childWorkers = new ChildWorkerService({
    ledger,
    worktrees: worktreeManager,
    hostParentTools: registry.runtimeIdFor('minion') === 'pi',
    spawner: (role: Role, spawnOptions?: SpawnOptions, residentRelease?: () => void) =>
      residentRelease !== undefined
        ? registry.spawnWithResident(role, spawnOptions ?? {}, residentRelease)
        : registry.spawn(role, spawnOptions ?? {}),
    workerGate: pacing.gate,
    retrySettlement: (agentId) => supervisorLive.awaitRetrySettlement(agentId),
    stopSignal: serviceStop.signal,
    reserveResident: (signal) => registry.reserveResident(signal),
    residentProbe: () => ({
      // The REAL budget eligibility (idle + its own reclaim predicate),
      // never a bare health-state guess.
      available: registry.residents.available,
      reclaimable: registry.residents.eligibleIdleCount(),
    }),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  state.childWorkers = childWorkers;
  // A child's supervision restart returns it to ITS lane with ITS bounded
  // tools — never the default role spawn (which would widen a read-only
  // child and move it out of its worktree).
  supervisorLive.setRestartPolicy((agentId, role) => childWorkers.restartPolicy(agentId, role));
  // Issue #161 declared capability gap: parent child-worker tools are
  // in-process and therefore only hosted on runtimes that execute tools in
  // the service process (pi). A claude-code minion receives no parent
  // tools rather than a same-uid-discoverable bridge (see the adapter's
  // refusal).
  const parentToolsFor = (agentId: string): readonly NativeAgentTool[] =>
    childWorkers.parentTools(agentId);
  const dispatcher = new DispatchService({
    ledger,
    worktrees: worktreeManager,
    spawner: (role: Role, spawnOptions?: SpawnOptions) => registry.spawn(role, spawnOptions ?? {}),
    workerGate: pacing.gate,
    retrySettlement: (agentId) => supervisorLive.awaitRetrySettlement(agentId),
    stopSignal: serviceStop.signal,
    parentTools: parentToolsFor,
    ...(config.lessons.enabled ? { lessons: lessonReferences, lessonsCapture } : {}),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // The durable queue's mechanical consumer: one shared-budget-aware
  // reconsider pass over the ledger-backed pipeline, triggered by enqueue,
  // bus transitions and runtime capacity events. No timer, no second
  // scheduler; the shared resident budget remains the capacity authority.
  pipeline = new PipelineService({
    ledger,
    dispatch: dispatcher,
    capacity: () => {
      const snapshot = registry.residencySnapshot();
      return {
        capacity: snapshot.capacity,
        occupied: snapshot.occupied,
        queued: snapshot.queued,
        available: snapshot.capacity - snapshot.occupied,
      };
    },
    // Demand registration with the SAME shared budget every admission
    // uses: while eligible work is capacity-blocked, one queued acquire
    // stays open so the budget's demand-driven idle-minion reclaim can
    // serve approved pipeline work (released the instant it grants).
    budget: { acquire: (signal) => registry.residents.acquire(1, signal) },
    bus,
    notifications,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  pipelineView = () => pipeline?.view() ?? null;
  state.pipeline = pipeline ?? undefined;
  // A PROVEN resident-permit release (after the disposed envelope) is the
  // signal a capacity-blocked queue may re-register demand / admit — the
  // pre-release envelope cannot prove it (Perkins r3 blocker 4).
  registry.onResidentReleased(() => pipeline?.schedule());
  const pipelineRecovery = pipeline.reconcileAtBoot();
  if (pipelineRecovery.examined > 0) {
    logger.info('pipeline admission reconciliation', {
      examined: pipelineRecovery.examined,
      adopted: pipelineRecovery.adopted,
      requeued: pipelineRecovery.requeued,
    });
  }
  const wave = createServiceReviewWave({ registry, options: {
    ledger,
    worktrees: worktreeManager,
    spawner: (role: Role, spawnOptions?: SpawnOptions) => registry.spawn(role, spawnOptions ?? {}),
    reviewGate: pacing.gate,
    workerGate: pacing.gate,
    rateLimitBackoff: pacing.backoff,
    retrySettlement: (agentId) => supervisorLive.awaitRetrySettlement(agentId),
    poster: createStartupVerdictPoster(config),
    reserveReviewRound: (signal) => registry.reserveReviewRound(signal),
    reconcileReviewAgent: async (agentId, marker) => registry.reviewOwnerCeased(agentId, marker),
    maxConcurrentChildren: config.review.maxConcurrentChildren,
    bus,
    reviewArtifactRoot: join(config.dataDir, 'reviews'),
    evidenceUploadsDir: join(config.dataDir, 'uploads'),
    reviewPreflight: (input) => reviewPreflightCheck(config, registry, input.repoPath),
    fallbackGate: {
      skillPath: resolveBmadReviewSkillPath(),
      fixDirectiveSink: (directiveInput) => routeFixDirectiveToMinion({
        workerGate: pacing.gate,
        retrySettlement: (agentId) => supervisorLive.awaitRetrySettlement(agentId),
        registry,
        ledger,
        worktrees: worktreeManager,
        jobId: directiveInput.jobId,
        directive: directiveInput.directive,
        signal: directiveInput.signal,
        owner: 'bmad-review-gate',
        parentTools: parentToolsFor,
      }),
    },
    // Wave escalations carry bounded per-call identity context; the
    // notifier binds the row through the existing agentId field only when
    // that identity is consistent (see src/dispatch/escalation-identity.ts).
    escalate: createReviewEscalationNotifier(ledger, notifications),
    // A transient admission refusal retries on its own (1 min, then 5 min):
    // each scheduled or skipped retry is an FYI; only the last refusal
    // escalates action-required through `escalate`. A routine review
    // supersession (owner rule 3) reports here too — never an Ack.
    inform: (title, detail) => {
      notifications.post({ kind: 'review-fyi', routing: 'fyi', severity: 'info', title, detail });
    },
    // Supersession proof (owner rule 3): a review session is stopped only
    // when the runtime no longer holds a live handle for it.
    liveReviewSessions: (agentIds) => agentIds.filter((agentId) => {
      const handle = registry.getHandle(agentId);
      return handle !== null && handle.health().state !== 'disposed';
    }),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  } });
  state.wave = wave;
  await wave.recoverInterruptedRounds();
  wave.resumeQueuedHandoffs();
  // Automatic admission retries live in memory (owner decision 2026-10-08):
  // one pending when the service stopped escalates now instead of resuming.
  wave.escalateInterruptedAdmissionRetries();
  // Re-brief restart safety (Silas finding 2026-09-23): a re-brief request
  // mid-flight at restart left no events and no worker. The durable
  // markers written before each worker spawned are consumed here — the
  // interrupted session is resumed (or a fresh worker re-dispatched on the
  // same lane) and the missing events are recorded when that turn settles.
  // Never awaited beyond dispatch: a re-brief turn is long; failures
  // escalate action-required from the background.
  const rebriefRecovery = await reconcilePendingRebriefs({
    registry,
    ledger,
    worktrees: worktreeManager,
    notifications,
    workerGate: pacing.gate,
    retrySettlement: (agentId) => supervisorLive.awaitRetrySettlement(agentId),
    parentTools: parentToolsFor,
    stopSignal: serviceStop.signal,
    log: (level, msg, fields) => logger.log(level, msg, fields),
    stopping: () => shuttingDown,
  });
  if (rebriefRecovery.examined > 0) {
    logger.info('re-brief reconciliation', {
      examined: rebriefRecovery.examined,
      completed: rebriefRecovery.completed,
      redispatched: rebriefRecovery.redispatched,
      retired: rebriefRecovery.retired,
    });
  }
  // Child-worker restart safety (issue #161): a child that never bound a
  // session re-runs under the same identity; one that had a live session
  // is terminally failed with the honest reason (its transcript stays
  // readable) — never a fabricated `done`.
  const childRecovery = childWorkers.reconcileOnBoot();
  if (childRecovery.resumed > 0 || childRecovery.failed > 0) {
    logger.info('child worker reconciliation', childRecovery);
  }
  // Directive-request restart safety (phase 3): a request accepted before
  // the crash reconciles from correlated evidence when it exists; when
  // admission or the terminal receipt is UNKNOWN, one bounded escalation
  // names it for a Gru reconciliation — never an automatic retry
  // (admission-unknown is not no-effect proof).
  const directiveRecovery = reconcilePendingDirectives({
    ledger,
    notifications,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  if (directiveRecovery.examined > 0) {
    logger.info('directive reconciliation', {
      examined: directiveRecovery.examined,
      completed: directiveRecovery.completed,
      escalated: directiveRecovery.escalated,
    });
  }
  // Explicit phase-handoff restart safety (pr136-chief-handoff): closes
  // crash windows after the correlated delivery commit and before/after
  // the obligation write and the notification publication. Runs AFTER the
  // directive/rebrief reconcilers so recovered admissions are visible;
  // bounded, idempotent, no re-dispatch, no new daemon.
  const phaseRecovery = reconcilePhaseHandoffs({
    ledger,
    notifications,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  if (phaseRecovery.examined > 0) {
    logger.info('phase handoff reconciliation', {
      examined: phaseRecovery.examined,
      completed: phaseRecovery.completed,
      published: phaseRecovery.published,
      closed: phaseRecovery.closed,
    });
  }
  // Unmarked blocked-phase hand-backs (the legacy event-sequence identity):
  // the boot backstop for the two windows the live observer cannot cover —
  // a delivery that committed before the observer ran, and an obligation
  // that committed before its card posted. One stable-kind machine card is
  // the recovery; nothing re-dispatches, nothing rings the owner.
  const unmarkedRecovery = reconcileUnmarkedHandbacks({
    ledger,
    notifications,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  if (unmarkedRecovery.deliveries > 0 || unmarkedRecovery.published > 0) {
    logger.info('unmarked follow-through reconciliation', {
      deliveries: unmarkedRecovery.deliveries,
      recovered: unmarkedRecovery.recovered,
      published: unmarkedRecovery.published,
    });
  }
  // Conservative migration of pre-existing blocked lanes: triage owed to
  // Gru for lanes with NO obligation history; lanes the live system
  // already tracks (active or settled) are left exactly as they are.
  const adoption = adoptBlockedLanes({
    ledger,
    notifications,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  if (adoption.adopted > 0) {
    logger.info('blocked-lane triage adoption', { scanned: adoption.scanned, adopted: adoption.adopted });
  }
  const bobSlot = supervisorLive.declareSlot({
    id: 'bob-consolidator',
    role: 'bob',
    spawn: (spawnOptions) => registry.spawn('bob', spawnOptions ?? {}),
  });
  const bob = new BobScheduler({
    intervalMs: config.dispatch.bobIntervalMs,
    slot: bobSlot,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // The dream pass shares Bob's supervised slot (one memory agent, two
  // triggers): the scheduled consolidation knock and the structured dream.
  const dream = new DreamScheduler({
    intervalMs: config.lessons.dreamIntervalMs,
    dreamOnBoot: config.lessons.dreamOnBoot,
    // Due-based cadence (issue #221): the schedule persists in the dream
    // state, so a service restart no longer resets it.
    lastDreamAt: () => loadDreamState(join(bible.dir, DREAM_STATE_FILE)).lastDreamAt,
    run: () =>
      new DreamEngine({
        journal,
        bible,
        distiller: new AgentLessonsDistiller({
          slot: bobSlot,
          bibleDir: bible.dir,
          log: (level, msg, fields) => logger.log(level, msg, fields),
        }),
        proposals: lessonProposals,
        log: (level, msg, fields) => logger.log(level, msg, fields),
      }).run(),
    // A failing dream is an incident, not just a log line (owner incident
    // 2026-10-07): one open incident per failure streak, carrying the exact
    // repair command for this instance; the next completed pass resolves it.
    ...dreamFailureIncidents(
      notifications,
      repairCommand({
        nodePath: process.execPath,
        toolPath: join(repoRoot, 'tools', 'repair-bible-provenance.mjs'),
        instanceDir: config.instanceDir,
        dataDir: config.dataDir,
      }),
    ),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  state.dream = dream;
  // Silas ops hosting (E8 follow-through; owner ruling 2026-09-21): the
  // supervised slot follows the gru-main / bob-consolidator pattern exactly
  // — model and thinking resolve from config ([models.roles] silas /
  // [thinking.roles] silas) at spawn, never hardcoded here.
  const silasSlot = config.silas.enabled
    ? supervisorLive.declareSlot({
        id: 'silas-ops',
        role: 'silas',
        spawn: (spawnOptions) => registry.spawn('silas', spawnOptions ?? {}),
      })
    : null;
  const dispatchServer = createDispatchServer({
    config,
    dispatch: dispatcher,
    wave,
    ledger,
    childWorkers,
    workerGate: pacing.gate,
    pendingProducerBlockers: (jobId) => supervisorLive.pendingProducerBlockers(jobId),
    retrySettlement: (agentId) => supervisorLive.awaitRetrySettlement(agentId),
    ...(pipeline !== null ? { pipeline } : {}),
    ...(config.silas.enabled && silasSlot !== null
      ? {
          silasOps: {
            registry,
            worktrees: worktreeManager,
            notifications,
            slotReArm: slotReArmPort,
            providerRecovery: {
              claim: (waitId: string, by: string) =>
                claimProviderRecoveryContinuation(
                  {
                    registry,
                    ledger,
                    worktrees: worktreeManager,
                    slotReArm: slotReArmPort,
                    log: (level, msg, fields) => logger.log(level, msg, fields),
                  },
                  waitId,
                  by,
                ),
            },
            // Read-only digest endpoint (issue #217): the wake prompt's
            // delta pointer resolves here, computed with the SAME seams the
            // driver uses (worktrees, blockers port, supervision stop
            // truth) so the API can never disagree with what wakes Silas.
            digest: () =>
              computeSilasDigest({
                ledger,
                worktrees: worktreeManager,
                blockersForRound: consolidatedBlockersFor(ledger),
                config: config.silas,
                trigger: 'api',
                supervisionFor: supervisionLookup(() => supervisor),
              }),
          },
        }
      : {}),
    ...(config.lessons.enabled ? { lessons: lessonReferences } : {}),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // The verification surface (contention fix, 2026-09-22): lanes request
  // their project's verify command through POST /api/verify; the scheduler
  // owns the machine's ONE global test budget (FIFO, stale holders,
  // worker cap) and records every run as review-consumable evidence.
  const verifyServer = createVerificationServer({
    config,
    ledger,
    worktrees: worktreeManager,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  verificationView = () => verifyServer.view();
  state.verify = verifyServer;
  // The ONE attach flow's HTTP surface (SPEC ruling 19, this lane): the
  // same seam chat and dispatch both ride — workspace browse (on-disk
  // picks send paths, never bytes) + uploads materialization
  // (clipboard/phone bytes → <data_dir>/uploads/ → that path).
  const attachmentsServer = createAttachmentsServer({
    config,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  state.bob = bob;

  // Graceful self-roll (issue #34): the operator surface + the state
  // machine. preflight/drain run in-process while the old build serves;
  // swap writes the marker and calls shutdown('roll') so the supervisor
  // relaunches the unit into the new build (exit 75 = restart-worthy).
  const rollController = new RollController({
    dataDir: config.dataDir,
    repoRoot,
    drainTimeoutMs: config.roll.drainTimeoutMs,
    probeInFlight: createRollProbes({ ledger, registry }),
    readBuiltSha: () => readBuildInfo(repoRoot).rev ?? buildInfo.rev,
    // Port-squat prevention (owner incident 2026-09-23): a roll swaps the
    // build and then verifies /health — if a foreign process owns the
    // port, the verification reads the squatter. Refuse the roll instead.
    probeForeignListener: () => instancePortForeignListener(config),
    onForeignListener: (owner) => {
      notifications.post({
        kind: 'roll-port-squat',
        routing: 'needs-owner',
        severity: 'error',
        title: `Roll refused: port ${config.server.port} is held by a foreign process (pid ${owner.pid})`,
        detail:
          `${owner.command === '' ? 'unknown command' : owner.command} (pid ${owner.pid}) owns ` +
          `${dialHost(config.server.host)}:${config.server.port}, so the post-roll /health check would ` +
          'read the squatter. Kill it and re-run the roll.',
      });
    },
    log: (level, msg, fields) => logger.log(level, msg, fields),
    onSwap: () => shutdown('roll', ROLL_SWAP_EXIT_CODE),
  });
  const rollServer = createRollServer({
    config,
    controller: rollController,
    // Post-restart GETs read the record from disk: this process has no
    // in-memory roll of its own, but the previous one left the file.
    loadState: () => {
      const live = rollController.state();
      if (live !== null) return live;
      try {
        return readRollState(config.dataDir);
      } catch (error) {
        logger.warn('roll state record unreadable', { error: String(error) });
        return null;
      }
    },
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });

  const service = createService(
    config,
    identity,
    (level, msg, fields) => logger.log(level, msg, fields),
    () => registry.status(),
    {
      staticRoot: createStaticRoot(defaultStaticRoot(import.meta.url)),
      supervisionStatus: () => supervisorLive.status(),
      decisionsStatus: () => decisionRuntime.status(),
      providerRecoveryView: () => providerRecoverySensor.waitingView(),
      buildInfo: () => buildInfo,
      requestHook: (req, res, path) =>
        lessonsServer.requestHook(req, res, path) ||
        rollServer.requestHook(req, res, path) ||
        attachmentsServer.requestHook(req, res, path) ||
        worktreeServer.requestHook(req, res, path) ||
        dispatchServer.requestHook(req, res, path) ||
        verifyServer.requestHook(req, res, path) ||
        board.requestHook(req, res, path),
    },
  );
  // Foreign-listener boot checks (owner incident 2026-09-23): on macOS a
  // loopback squatter coexists with our wildcard/LAN bind, so a clean
  // listen is NOT proof that clients reach us. The listener pid is.
  //
  // (a) PRE-bind: while this process is not yet listening, ANY listener on
  // the port is foreign — refuse before the socket exists (this also keeps
  // /health from being answered by a squatter during boot).
  if (config.server.port !== 0) {
    const prebind = await instancePortForeignListener(config);
    if (prebind !== null) {
      reportForeignListener(prebind, config, config.server.port, logger, notifications, 'before');
      return 1;
    }
  }
  // Issue #171: supervision hydration (restored durable stops) must land
  // BEFORE the listener serves snapshots — the ownership probe is wired
  // and answering from the first request, so a not-yet-hydrated stop
  // would classify as historical until some later push corrected it.
  supervisorLive.start();
  state.handle = await service.start();
  const handle = state.handle;
  chat.attach(handle.httpServer);
  board.attach(handle.httpServer); // last: its upgrade handler terminates unclaimed paths
  state.chat = chat;
  // (b) POST-bind: the literal listener-pid check (selfPid filtered), run
  // after the socket handlers are attached so a healthy /health answer is
  // never served while /ws is still unattached. Catches a squatter that
  // appeared in the (tiny) pre-bind race window.
  if (config.server.port !== 0) {
    const foreign = await instancePortForeignListener(config);
    if (foreign !== null) {
      reportForeignListener(foreign, config, handle.port, logger, notifications, 'while');
      await handle.stop();
      return 1;
    }
  }
  // Post-roll self-check (phase d): the relaunched build logs uptime+sha
  // once the socket is actually serving.
  if (rollAdoption.marker !== null) {
    logger.info('post-roll self-check', {
      build_sha: buildInfo.rev,
      uptime_ms: Number(process.hrtime.bigint() - bootHr) / 1_000_000,
      from_sha: rollAdoption.marker.fromSha,
      to_sha: rollAdoption.marker.toSha,
      port: handle.port,
    });
  }
  awareness.setWakeSink(() => chat.wakeAwareness());
  chat.warmup();
  bob.start();
  if (config.lessons.enabled) dream.start();
  else logger.info('lesson dream disabled by config', {});
  if (silasSlot !== null) {
    // The driver starts after listen so its wake prompt carries the real
    // bound port (config port 0 = ephemeral); until then no sweeps run and
    // event wakes wait for the first sweep — the sweep is the safety net.
    // The GitHub signal poll rides the same driver (POLL-ONLY; owner ruling
    // 2026-09-23): it observes tracked lanes through `gh api` and applies
    // the state-change mappings mechanically. A missing `gh` auth fails per
    // tick, loudly, and never takes the service down.
    const remoteCache = new Map<string, ReturnType<typeof repoRemote>>();
    const resolveLaneRemote: LaneRemoteResolver = (repoPath) => {
      if (!remoteCache.has(repoPath)) remoteCache.set(repoPath, repoRemote(repoPath));
      const remote = remoteCache.get(repoPath) ?? null;
      return remote === null ? null : { host: remote.host, owner: remote.owner, repo: remote.repo };
    };
    const silas = new SilasDriver({
      slot: silasSlot,
      ledger,
      worktrees: worktreeManager,
      config: config.silas,
      ops: {
        baseUrl: `http://${handle.host}:${handle.port}`,
        configPath: configPathFor(config.instanceDir),
      },
      bus,
      // Same live stop truth the board renders: a supervision-stopped
      // worker is waiting on a human re-arm, never a stalled lane. The
      // getter keeps the lookup late-bound like the engine's closure — a
      // construction-order change can never freeze a null handle (A4).
      supervisionFor: supervisionLookup(() => supervisor),
      // Issue #224 shadow wiring: same-blocker identity asks from the
      // recurrence block. Asks fire ONLY when the same_blocker surface is
      // explicitly configured `mode = "shadow"` and its routed profile is
      // ready; the runtime records without changing the ladder.
      decisions: decisionRuntime,
      readyForSurface: (surface) => decisionRuntime.readyFor(surface),
      modeForSurface: (surface) => decisionRuntime.surfaceMode(surface),
      // Chief phase-3 seam: every deterministic Silas pass runs the
      // production hook — the in-memory review-handoff reconsideration
      // plus the bounded durable reconciliation (issue #163) — BEFORE any
      // LLM wake. The factory is behaviorally tested with a real ledger
      // and driver; a wiring regression fails a behavioral test, not just
      // a source regex.
      onDeterministicPass: createProductionDeterministicPass({
        ledger,
        notifications,
        log: (level, msg, fields) => logger.log(level, msg, fields),
        getWave: () => state.wave,
      }),
      githubPoll: new GitHubSignalPoll({
        ledger,
        notifications,
        api: new GhCliApi(),
        resolveRemote: resolveLaneRemote,
        log: (level, msg, fields) => logger.log(level, msg, fields),
      }),
      log: (level, msg, fields) => logger.log(level, msg, fields),
    });
    state.silas = silas;
    silas.start();
  }
  // The provider-recovery sensor runs in the service, independent of
  // Silas's model availability: its timer starts after listen (same
  // pattern as the drivers) and its boot reconciliation re-wakes any
  // recovery whose delivery was lost across a restart — never silently
  // re-baselined away.
  if (config.providerRecovery.enabled) {
    providerRecoverySensor.start();
    void providerRecoverySensor.reconcileAtBoot().catch((error: unknown) => {
      logger.error('provider-recovery boot reconciliation failed', { error: String(error) });
    });
  } else {
    logger.info('provider-recovery sensor disabled — owner activation stays manual', {});
  }

  logger.info('listening', { host: handle.host, port: handle.port });
  return new Promise<number>(() => {
    // long-running: exit happens via signal handlers
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'fatal',
        error: String(error),
      })}\n`,
    );
    process.exit(1);
  });
