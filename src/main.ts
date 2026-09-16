import { configPathFor, loadConfig, ConfigError } from './config.js';
import { loadOrCreateIdentity } from './identity.js';
import { Logger } from './logger.js';
import { RuntimeRegistry } from './runtime/registry.js';
import { SessionStore } from './sessions/store.js';
import { createService, type ServiceHandle } from './server.js';
import { SERVICE_NAME, VERSION } from './version.js';

async function main(): Promise<number> {
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

  const logger = new Logger(config.dataDir);
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

  // Crash forensics: structured fatal lines for anything that escapes, so
  // the JSON-lines log stays the record even under OS-service restarts.
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception', { error: String(error), stack: error.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { reason: String(reason) });
    process.exit(1);
  });

  const state: { handle?: ServiceHandle; registry?: RuntimeRegistry; store?: SessionStore } = {};
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
        // (SPEC ruling 12).
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

  const service = createService(
    config,
    identity,
    (level, msg, fields) => logger.log(level, msg, fields),
    () => registry.status(),
  );
  state.handle = await service.start();
  const handle = state.handle;
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
