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
import { NotificationCenter } from './notifications/center.js';
import { Supervisor } from './supervision/supervisor.js';
import { TranscriptService } from './transcripts/service.js';
import { DispatchService } from './dispatch/service.js';
import { WorktreeManager } from './worktrees/manager.js';
import { createWorktreeServer } from './worktrees/server.js';
import { AutoVerdictPoster, WaveRunner } from './dispatch/perkins.js';
import { BobScheduler } from './dispatch/bob-scheduler.js';
import { createDispatchServer } from './dispatch/server.js';
import { createService, type ServiceHandle } from './server.js';
import { createAttachmentsServer } from './attachments/server.js';
import { uploadsDirNeedsHardening } from './attachments/resolver.js';
import { DecisionRuntime } from './decisions/runtime.js';
import { isolateDecisionEnvironment } from './decisions/credentials.js';
import type { Role } from './config.js';
import { resolveSpawnPolicy } from './config.js';
import {
  buildClaudeCodeAuthArgs,
  isGitHubRemote,
  isGitLabRemote,
  probeGitHubRemote,
  probeGitLabRemote,
  probeModelProvider,
  probeReviewPolicy,
  repoRemote,
  runReviewPreflight,
  type ModelProviderProbe,
} from './dispatch/review-path.js';
import { loadPerkinsPolicy } from './dispatch/perkins-review/policy.js';
import { spawnSync } from 'node:child_process';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SpawnOptions } from './runtime/types.js';

let cachedModelRuntime: ModelRuntime | null = null;
async function modelRuntimeForProbe(): Promise<ModelRuntime> {
  cachedModelRuntime ??= await ModelRuntime.create({ refreshOnCreate: false });
  return cachedModelRuntime;
}

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

/** Fail-closed four-leg review pre-flight (user amendment 2026-09-20). */
async function reviewPreflightCheck(
  config: ReturnType<typeof loadConfig>,
  repoPath: string,
): Promise<Awaited<ReturnType<typeof runReviewPreflight>>> {
  const runtimeId = config.runtimes.roles['perkins'] ?? config.runtimes.default;
  return runReviewPreflight({
    'resource-integrity': () => {
      loadPerkinsPolicy();
    },
    'model-provider': async () => {
      const modelRef = resolveSpawnPolicy(config, runtimeId, 'perkins').model;
      if (runtimeId === 'claude-code') {
        // Probe binary presence AND auth: a cheap authenticated call proves
        // the provider is configured and reachable. --version alone is
        // insufficient (succeeds without credentials).
        const authArgs = buildClaudeCodeAuthArgs(modelRef);
        const probe = spawnSync(
          'claude',
          authArgs,
          { encoding: 'utf-8', timeout: 30_000, input: '' },
        );
        if (probe.error !== undefined) {
          throw new Error(`claude-code probe failed: ${String(probe.error)}`);
        }
        if (probe.status !== 0) {
          const stderr = (probe.stderr ?? '').trim().slice(0, 300);
          throw new Error(`claude-code is not configured/authed for the review model (exit ${probe.status}): ${stderr}`);
        }
        return;
      }
      const runtime = await modelRuntimeForProbe();
      const probe: ModelProviderProbe = {
        modelRef,
        getModel: (provider, id) => runtime.getModel(provider, id),
        checkAuth: (provider) => runtime.checkAuth(provider),
        availableProviders: () => runtime.getProviders().map((provider) => provider.id),
      };
      await probeModelProvider(probe);
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

/** Route blocker findings back to the implementing minion session: the live
 * job minion first; otherwise a fresh minion on the job lane. */
async function routeFixDirectiveToMinion(input: {
  registry: RuntimeRegistry;
  ledger: LedgerApi;
  worktreeManager: WorktreeManager;
  jobId: string;
  directive: string;
  signal: AbortSignal;
}): Promise<{ delivered: boolean; minionId?: string; note?: string }> {
  const minions = input.ledger
    .listAgents()
    .filter((agent) => agent.jobId === input.jobId && agent.role === 'minion');
  for (const minion of [...minions].reverse()) {
    const handle = input.registry.getHandle(minion.id);
    if (handle !== null) {
      await racedPrompt(handle, input.directive, input.signal);
      return { delivered: true, minionId: minion.id };
    }
  }
  const lane = input.worktreeManager
    .listWorktrees({ jobId: input.jobId })
    .find((candidate) => candidate.kind === 'job');
  if (lane === undefined) {
    return { delivered: false, note: 'no implementing minion session and no job lane' };
  }
  const handle = await input.registry.spawn('minion', { cwd: lane.path });
  try {
    await racedPrompt(handle, input.directive, input.signal);
  } finally {
    await handle.dispose();
  }
  return { delivered: true, minionId: handle.id };
}

/** Race a prompt against cancellation so shutdown cannot stall on an
 * in-flight fix-directive turn. */
function racedPrompt(handle: { prompt(text: string, options?: { owner?: string }): Promise<void> }, text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('review operation aborted'));
  return Promise.race([
    handle.prompt(text, { owner: 'bmad-review-gate' }),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('review operation aborted')), { once: true });
    }),
  ]);
}
import { ChatFrameLog } from './chat/frame-log.js';
import { createChatServer, type ChatServer } from './chat/server.js';
import { BOARD_WS_PATH } from './board/frames.js';
import { GruSessionPointer } from './chat/session-state.js';
import { createStaticRoot, defaultStaticRoot } from './static.js';
import { SERVICE_NAME, VERSION } from './version.js';

async function main(): Promise<number> {
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

  const logger = new Logger(config.dataDir, true, {
    maxBytes: config.logging.maxBytes,
    keep: config.logging.keep,
  });
  const identity = loadOrCreateIdentity(config.dataDir);
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
    board?: Awaited<ReturnType<typeof createBoardServer>>;
    ledgerDb?: LedgerDb;
    supervisor?: Supervisor;
    decisions?: DecisionRuntime;
    bob?: BobScheduler;
    wave?: WaveRunner;
  } = {};
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown begin', { signal });
    const forceExit = setTimeout(() => {
      logger.error('shutdown timeout — forcing exit', { signal });
      process.exit(1);
    }, 5_000);
    forceExit.unref();
    if (state.handle === undefined) {
      clearTimeout(forceExit);
      logger.info('shutdown complete', { signal, note: 'signal arrived during boot' });
      process.exit(0);
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
        if (state.wave !== undefined) {
          try {
            await state.wave.shutdown();
          } catch (error) {
            logger.error('Perkins review shutdown failed', { error: String(error) });
          }
        }
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
        process.exit(0);
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
  // E7: late-bound supervision feed — the engine is constructed before
  // the supervisor exists; the closure resolves per snapshot.
  let supervisor: Supervisor | null = null;
  let decisions: DecisionRuntime | null = null;
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
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  registry.onAgentEvent((envelope) => engine.onRuntimeEvent(envelope));

  // Chat (E4): the single Gru session behind /ws. The durable frame log
  // loads and boot-settles BEFORE the HTTP server accepts anything (r1
  // N13): a corrupt log refuses boot without ever having listened, and no
  // client can attach to an unsettled log. The Gru spawn is lazy-warm
  // (warmup is best-effort, first message retries) so a model outage can
  // never keep the service down. Since E7 the Gru session runs behind a
  // SUPERVISED slot: the supervisor adopts it, watches turn liveness,
  // restarts it up the ladder, and trips the crash-loop breaker.
  const chatDir = join(config.dataDir, 'chat');
  const frameLog = ChatFrameLog.load(
    chatDir,
    (level, msg, fields) => logger.log(level, msg, fields),
    { maxBytes: config.chat.frameLogMaxBytes, keep: config.chat.frameLogKeep },
  );
  // Action-required notifications surface in chat (SPEC ruling 13) — the
  // chat server arrives one step below; late-bind the callback.
  let surfaceInChat: (notification: NotificationRecord) => void = () => {};
  const notifications = new NotificationCenter({
    ledger,
    bus,
    onActionRequired: (notification) => surfaceInChat(notification),
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
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  gruSlot.onSwap((handle) => chat.adoptRestartedGru(handle));
  surfaceInChat = (notification) => {
    chat.surfaceNotice(
      `⚠ Action required: ${notification.title}${notification.detail !== null ? ` — ${notification.detail}` : ''}`,
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
        routing: 'action-required',
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
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  const wave = new WaveRunner({
    ledger,
    worktrees: worktreeManager,
    spawner: (role: Role, spawnOptions?: SpawnOptions) => registry.spawn(role, spawnOptions ?? {}),
    poster: new AutoVerdictPoster(),
    reviewArtifactRoot: join(config.dataDir, 'reviews'),
    reviewPreflight: (input) => reviewPreflightCheck(config, input.repoPath),
    fallbackGate: {
      skillPath: resolveBmadReviewSkillPath(),
      fixDirectiveSink: (directiveInput) => routeFixDirectiveToMinion({
        registry,
        ledger,
        worktreeManager,
        jobId: directiveInput.jobId,
        directive: directiveInput.directive,
        signal: directiveInput.signal,
      }),
    },
    escalate: (title, detail) => {
      notifications.post({ kind: 'review-escalation', routing: 'action-required', severity: 'error', title, detail });
    },
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  state.wave = wave;
  await wave.recoverInterruptedRounds();
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
  const dispatchServer = createDispatchServer({
    config,
    dispatch: dispatcher,
    wave,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  // The ONE attach flow's HTTP surface (SPEC ruling 19, this lane): the
  // same seam chat and dispatch both ride — workspace browse (on-disk
  // picks send paths, never bytes) + uploads materialization
  // (clipboard/phone bytes → <data_dir>/uploads/ → that path).
  const attachmentsServer = createAttachmentsServer({
    config,
    log: (level, msg, fields) => logger.log(level, msg, fields),
  });
  state.bob = bob;

  const service = createService(
    config,
    identity,
    (level, msg, fields) => logger.log(level, msg, fields),
    () => registry.status(),
    {
      staticRoot: createStaticRoot(defaultStaticRoot(import.meta.url)),
      supervisionStatus: () => supervisorLive.status(),
      decisionsStatus: () => decisionRuntime.status(),
      requestHook: (req, res, path) =>
        attachmentsServer.requestHook(req, res, path) ||
        worktreeServer.requestHook(req, res, path) ||
        dispatchServer.requestHook(req, res, path) ||
        board.requestHook(req, res, path),
    },
  );
  state.handle = await service.start();
  const handle = state.handle;
  chat.attach(handle.httpServer);
  board.attach(handle.httpServer); // last: its upgrade handler terminates unclaimed paths
  state.chat = chat;
  chat.warmup();
  supervisorLive.start();
  bob.start();

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
