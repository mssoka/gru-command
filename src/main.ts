import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { configPathFor, loadConfig, ConfigError } from './config.js';
import { loadOrCreateIdentity } from './identity.js';
import { Logger } from './logger.js';
import { RuntimeRegistry } from './runtime/registry.js';
import { SessionStore } from './sessions/store.js';
import { LedgerDb } from './ledger/db.js';
import { LedgerApi, type NotificationRecord } from './ledger/api.js';
import { EventBus } from './events/bus.js';
import { BoardEngine } from './board/engine.js';
import { createBoardServer } from './board/server.js';
import { DeployDriftTracker } from './board/deploy-drift.js';
import { defaultPackageRoot, readBuildInfo } from './build-info.js';
import { NotificationCenter } from './notifications/center.js';
import { Supervisor } from './supervision/supervisor.js';
import { TranscriptService } from './transcripts/service.js';
import { DispatchService } from './dispatch/service.js';
import { WorktreeManager } from './worktrees/manager.js';
import { createWorktreeServer } from './worktrees/server.js';
import { AutoVerdictPoster, WaveRunner } from './dispatch/perkins.js';
import { BobScheduler } from './dispatch/bob-scheduler.js';
import { SilasDriver } from './dispatch/silas-driver.js';
import { GhCliApi, GitHubSignalPoll, type LaneRemoteResolver } from './dispatch/github-poll.js';
import { routeFixDirectiveToMinion } from './dispatch/fix-directive.js';
import { reconcilePendingRebriefs } from './dispatch/rebrief-recovery.js';
import { createDispatchServer } from './dispatch/server.js';
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
import { DreamEngine, DreamScheduler } from './lessons/dream.js';
import { AgentLessonsDistiller } from './lessons/distiller.js';
import { createSessionLessonsCapture } from './lessons/capture.js';
import { createLessonsServer } from './lessons/server.js';
import { DecisionRuntime } from './decisions/runtime.js';
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
import type { SpawnOptions } from './runtime/types.js';

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
  return runRuntimeReviewPreflight(() => registry.prepareReviewModel('perkins'), {
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
}
import { ChatFrameLog } from './chat/frame-log.js';
import { createChatServer, type ChatServer } from './chat/server.js';
import { GruAwareness } from './chat/awareness.js';
import { BOARD_WS_PATH } from './board/frames.js';
import { GruSessionPointer } from './chat/session-state.js';
import { createStaticRoot, defaultStaticRoot } from './static.js';
import { SERVICE_NAME, VERSION } from './version.js';

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
    wave?: WaveRunner;
    verify?: ReturnType<typeof createVerificationServer>;
    deployDrift?: DeployDriftTracker;
  } = {};
  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
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
        if (state.wave !== undefined) {
          try {
            await state.wave.shutdown();
          } catch (error) {
            logger.error('Perkins review shutdown failed', { error: String(error) });
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
  bible.ensureSeeded();
  const lessonReferences = createBibleReferences({
    bible,
    maxReferences: config.lessons.maxReferences,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const lessonsCapture = createSessionLessonsCapture({
    journal,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const lessonsServer = createLessonsServer({
    config,
    journal,
    bible,
    references: lessonReferences,
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
  const engine = new BoardEngine({
    ledger,
    bus,
    supervisionFor: (agentId) => supervisor?.viewFor(agentId) ?? null,
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
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  registry.onAgentEvent((envelope) => engine.onRuntimeEvent(envelope));
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
  const decisionRuntime = new DecisionRuntime(config.decisions, {
    instanceDir: config.instanceDir,
    env: decisionEnvironment,
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
    () => decisionRuntime.status().status === 'ready',
  );
  const supervisorLive = new Supervisor({
    config: config.supervision,
    registry,
    ledger,
    notifications,
    decisions: decisionRuntime,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  supervisor = supervisorLive;
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
    morningDigestGapMs: config.chat.morningDigestGapMs,
    onFollowUpPosted: (notification) => surfaceInChat(notification),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const chat = createChatServer({
    config,
    frameLog,
    pointer: new GruSessionPointer(chatDir, (level, msg, fields) => logger.log(level, msg, fields)),
    spawnGru: (resumeFile) => gruSlot.ensure(resumeFile !== null ? { resumeFile } : {}),
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
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const dispatcher = new DispatchService({
    ledger,
    worktrees: worktreeManager,
    spawner: (role: Role, spawnOptions?: SpawnOptions) => registry.spawn(role, spawnOptions ?? {}),
    ...(config.lessons.enabled ? { lessons: lessonReferences, lessonsCapture } : {}),
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const wave = new WaveRunner({
    ledger,
    worktrees: worktreeManager,
    spawner: (role: Role, spawnOptions?: SpawnOptions) => registry.spawn(role, spawnOptions ?? {}),
    poster: new AutoVerdictPoster(),
    reviewArtifactRoot: join(config.dataDir, 'reviews'),
    reviewPreflight: (input) => reviewPreflightCheck(config, registry, input.repoPath),
    fallbackGate: {
      skillPath: resolveBmadReviewSkillPath(),
      fixDirectiveSink: (directiveInput) => routeFixDirectiveToMinion({
        registry,
        ledger,
        worktrees: worktreeManager,
        jobId: directiveInput.jobId,
        directive: directiveInput.directive,
        signal: directiveInput.signal,
        owner: 'bmad-review-gate',
      }),
    },
    escalate: (title, detail) => {
      notifications.post({ kind: 'review-escalation', routing: 'action-required', severity: 'error', title, detail });
    },
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  state.wave = wave;
  await wave.recoverInterruptedRounds();
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
    log: (level, msg, fields) => logger.log(level, msg, fields),
    stopping: () => shuttingDown,
  });
  if (rebriefRecovery.examined > 0) {
    logger.info('re-brief reconciliation', {
      examined: rebriefRecovery.examined,
      completed: rebriefRecovery.completed,
      redispatched: rebriefRecovery.redispatched,
    });
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
    run: () =>
      new DreamEngine({
        journal,
        bible,
        distiller: new AgentLessonsDistiller({
          slot: bobSlot,
          bibleDir: bible.dir,
          log: (level, msg, fields) => logger.log(level, msg, fields),
        }),
        log: (level, msg, fields) => logger.log(level, msg, fields),
      }).run(),
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
    ...(config.silas.enabled && silasSlot !== null
      ? { silasOps: { registry, worktrees: worktreeManager, notifications } }
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
  supervisorLive.start();
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
