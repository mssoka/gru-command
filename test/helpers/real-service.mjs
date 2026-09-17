#!/usr/bin/env node
/**
 * Boots the REAL service (dist/main.js) with a hermetic instance for
 * real-socket tests: a throwaway GRU_COMMAND_HOME holding a real config
 * (auth token, fixed host/port, claude-code runtime) and a PATH whose
 * `claude` resolves to the offline CLI double (test/helpers/claude-double.mjs).
 *
 * Everything on the wire is real — config load, token hash auth, the
 * /ws frame contract, static serving of web/dist — except the agent
 * binary, which is the suite's proven stream-json double. Never any
 * network.
 *
 * Two entry points:
 *   import { startRealService } from './helpers/real-service.mjs'
 *   node test/helpers/real-service.mjs            (manual/standalone boot)
 * CLI knobs: REAL_SERVICE_PORT, REAL_SERVICE_TOKEN (defaults shared with
 * web/playwright.config.ts and web/e2e/real-server.spec.ts).
 */

import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
export const REAL_SERVICE_PORT = Number(process.env.REAL_SERVICE_PORT ?? 7790);
export const REAL_SERVICE_TOKEN = process.env.REAL_SERVICE_TOKEN ?? 'e2e-real-pairing-token';

/** A TCP port the OS confirms free right now (race-tolerant for tests). */
export function pickFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
    probe.on('error', reject);
  });
}

function failLoud(message) {
  process.stderr.write(`real-service: ${message}\n`);
  throw new Error(message);
}

/** Resolves true once /health answers 2xx (never throws; 1s cap so a
 *  hung response can never stall the boot loop past its deadline). */
function healthOk(baseUrl) {
  return new Promise((resolveCheck) => {
    const request = httpGet(`${baseUrl}/health`, (res) => {
      res.resume();
      resolveCheck(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
    });
    request.on('error', () => resolveCheck(false));
    request.setTimeout(1_000, () => request.destroy(new Error('health check timeout')));
  });
}

/**
 * Start the real service and resolve once /health answers.
 *
 * Ownership: a boot that CREATED its tmp home/workspace removes them on
 * stop(); a boot handed `home`/`workspace` (restart with durable state)
 * never deletes either — the caller owns them.
 *
 * @returns {{ child, home: string, workspace: string, port: number,
 *             token: string, baseUrl: string, stop: () => Promise<void> }}
 */
export async function startRealService({
  port = REAL_SERVICE_PORT,
  token = REAL_SERVICE_TOKEN,
  keepHome = false,
  requireWebDist = true,
  home: existingHome,
  workspace: existingWorkspace,
} = {}) {
  const mainJs = join(REPO_ROOT, 'dist', 'main.js');
  if (!existsSync(mainJs)) {
    failLoud(`dist/main.js not found — run \`npm run build\` at the repo root first (tried ${mainJs})`);
  }
  // The UI matters for browser smoke (the service serves web/dist);
  // raw-socket tests never load a page and may run without it.
  if (requireWebDist && !existsSync(join(REPO_ROOT, 'web', 'dist', 'index.html'))) {
    failLoud('web/dist/index.html not found — run `npm run build:web` first');
  }

  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'gru-command-real-e2e-'));
  const workspace = existingWorkspace ?? mkdtempSync(join(tmpdir(), 'gru-command-real-ws-'));
  const ownsDirs = existingHome === undefined;
  // `claude` on PATH → the offline CLI double (tracked 0755, so the
  // symlink is executable as-is — never chmod the repo file). Idempotent:
  // a restart reuses the same home.
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  rmSync(join(binDir, 'claude'), { force: true });
  symlinkSync(join(HERE, 'claude-double.mjs'), join(binDir, 'claude'));

  writeFileSync(
    join(home, 'config.toml'),
    [
      `workspace_root = "${workspace}"`,
      '[server]',
      'host = "127.0.0.1"',
      `port = ${port}`,
      '[auth]',
      `token = "${token}"`,
      '[runtimes]',
      'default = "claude-code"',
      '',
    ].join('\n'),
    'utf-8',
  );

  const child = spawn(process.execPath, [mainJs], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GRU_COMMAND_HOME: home,
      PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    },
  });
  let stderrTail = '';
  child.stdout.on('data', () => {}); // drain: the service log must never wedge the pipe
  child.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-4000);
  });
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      cleanup();
      failLoud(`service exited during boot (code ${child.exitCode})\n${stderrTail}`);
    }
    if (await healthOk(baseUrl)) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      cleanup();
      failLoud(`service never answered /health on ${baseUrl}\n${stderrTail}`);
    }
    await delay(100);
  }

  function cleanup() {
    // keepHome = "this boot's dirs survive stop()" (the e2e restart flow
    // hands them to the next boot and removes them in its afterAll);
    // a boot handed home/workspace owns neither and never deletes them.
    if (ownsDirs && !keepHome) {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  async function stop() {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(5000).then(() => undefined)]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    cleanup();
  }

  return { child, home, workspace, port, token, baseUrl, stop };
}

// ---------------------------------------------------------------------------
// CLI entry (playwright webServer): run until SIGTERM/SIGINT.
// ---------------------------------------------------------------------------

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const service = await startRealService();
  process.stdout.write(
    `gru-command REAL service (hermetic) listening on ${service.baseUrl} ` +
      `(token: ${service.token}, runtime: claude-code double)\n`,
  );
  const shutdown = () => {
    void service.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
