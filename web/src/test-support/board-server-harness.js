import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { EventBus } from '../../../src/events/bus.js';
import { BoardEngine } from '../../../src/board/engine.js';
import { createBoardServer } from '../../../src/board/server.js';
import { LedgerApi } from '../../../src/ledger/api.js';
import { LedgerDb } from '../../../src/ledger/db.js';
import { NotificationCenter } from '../../../src/notifications/center.js';
import { TranscriptService } from '../../../src/transcripts/service.js';
import { loadConfig } from '../../../src/config.js';
import { DecisionRuntime } from '../../../src/decisions/runtime.js';

/** Boot the production board HTTP routes against an isolated durable ledger. */
export async function startBoardServerHarness(token = 'board-client-integration-token') {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-board-client-integration-'));
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${token}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  const engine = new BoardEngine({ ledger: api, bus });
  const notifications = new NotificationCenter({ ledger: api, bus });
  const decisions = new DecisionRuntime(cfg.decisions, {
    instanceDir: cfg.instanceDir,
    env: { GRU_COMMAND_HOME: cfg.instanceDir },
    home: '/home/tester',
    watchConfig: false,
  });
  const board = createBoardServer({
    config: cfg,
    engine,
    ledger: api,
    transcripts: new TranscriptService(join(dir, 'sessions'), { ledger: api }),
    bus,
    notifications,
    decisionsStatus: () => decisions.status(),
    onDecisionsRecheck: () => decisions.recheck(),
    pushDebounceMs: 0,
  });
  const http = createServer((req, res) => {
    if (board.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  board.attach(http);
  try {
    await new Promise((resolveListen, rejectListen) => {
      http.once('error', rejectListen);
      http.listen(0, '127.0.0.1', resolveListen);
    });
    const port = http.address().port;
    let closed = false;
    return {
      token,
      url: `http://127.0.0.1:${port}`,
      api,
      notifications,
      async close() {
        if (closed) return;
        closed = true;
        decisions.dispose();
        await board.dispose();
        await new Promise((resolveClose) => {
          http.closeAllConnections();
          http.close(() => resolveClose());
        });
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    decisions.dispose();
    await board.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
