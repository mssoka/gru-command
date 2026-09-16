import { configPathFor, loadConfig, ConfigError } from './config.js';
import { loadOrCreateIdentity } from './identity.js';
import { Logger } from './logger.js';
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

  const state: { handle?: ServiceHandle } = {};
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
    void state.handle
      .stop()
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

  const service = createService(config, identity, (level, msg, fields) =>
    logger.log(level, msg, fields),
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
