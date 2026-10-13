import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createWorkflowSessionBinder } from '../../src/workflows/session.js';
import { configPathFor, loadConfig } from '../../src/config.js';
import { makeWorkflowLane } from './workflow-lane.js';

export const WEB_INCIDENT = 'cd web && npx vitest run --config vitest.config.ts src/lib/board-client.test.ts src/ui/board.test.ts';
export const FULL_INCIDENT = 'npm test';
export const BUILD_INCIDENT = 'npm run lint && npm run typecheck && npm run build && npm run build:web';

/** Real assigned Git lane and offline executables: any backend start is durable. */
export function verificationLane(quality = false) {
  const f = makeWorkflowLane();
  mkdirSync(join(f.lane.path, '.gru-command'));
  mkdirSync(join(f.lane.path, 'web'));
  writeFileSync(join(f.lane.path, '.gru-command/worktree.toml'), '[verify]\nfull = "npm test"\nfocused = "npx vitest run"\n' + (quality ? 'quality = "CI=1 npm run quality"\nunit = "npm run test.unit"\ncheck = "npm run check/unit"\n' : ''));
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  const starts = join(f.root, 'producer-starts');
  for (const name of ['npm', 'npx', 'vitest', 'jest', 'tsc', 'eslint', 'vite', 'playwright']) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${starts}'\n`);
    chmodSync(file, 0o700);
  }
  const configFile = join(f.root, 'instance-$literal-`literal`', 'config.toml');
  mkdirSync(join(f.root, 'instance-$literal-`literal`'));
  writeFileSync(configFile, `data_dir = ${JSON.stringify(f.dataDir)}\n[auth]\ntoken = "isolated-verification-fixture-token"\n`, { mode: 0o600 });
  const config = loadConfig({ GRU_COMMAND_HOME: join(f.root, 'instance-$literal-`literal`') });
  for (const base of [f.lane.path, join(f.lane.path, 'web')]) {
    const localBin = join(base, 'node_modules/.bin'); mkdirSync(localBin, { recursive: true });
    for (const name of ['vitest', 'jest', 'tsc', 'eslint', 'vite', 'playwright']) {
      const file = join(localBin, name);
      writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${starts}'\n`); chmodSync(file, 0o700);
    }
  }
  const session = createWorkflowSessionBinder(f.dataDir, () => f.lane, undefined, () => false, undefined, configPathFor(config.instanceDir))({ agentId: 'recorded-minion' });
  return { ...f, bin, starts, session, config };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Real shipped helper transport with no admission or producer: a status-only
 * authenticated surface proves that ordinary Bash can reconcile an identity. */
export async function authenticatedCaptureStatus(f: ReturnType<typeof verificationLane>) {
  const requests: string[] = [];
  const token = 'isolated-verification-fixture-token';
  const configFile = f.session.workerVerification!.configFile;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${token}` || req.method !== 'GET' || req.url !== '/api/verify/status?request_id=existing') {
      res.writeHead(403); res.end('not authorized'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: 'unknown', requestId: 'existing' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture requires a bound TCP listener');
  const command = `node ${shellQuote(f.session.workerVerification!.helper)} status --request-id existing --url http://127.0.0.1:${address.port} --config ${shellQuote(configFile)}`;
  return { requests, command, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
