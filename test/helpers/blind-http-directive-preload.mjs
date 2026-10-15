#!/usr/bin/env node
/**
 * Runtime fixture for the compiled-service HTTP continuation regression
 * (issue #339 G2).
 *
 * Injected into the real service with NODE_OPTIONS=--import. It does NOT install
 * the blind observer and never calls the scanner: it only makes the PRODUCTION
 * registry resolve ONE seeded implementer minion to a scripted live handle whose
 * prompt appends a prohibited tool result to the seeded session file. The
 * observer that records the resulting invalidation comes solely from the real
 * `main.ts` -> `createDispatchServer({ observeBlindTurn })` production
 * forwarding. Removing only that main-to-server port leaves the event unrecorded.
 */
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const { RuntimeRegistry } = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'runtime', 'registry.js')).href);

const minionId = process.env['GRU_BLIND_HTTP_MINION_ID'];
const sessionFile = process.env['GRU_BLIND_HTTP_SESSION_FILE'];

function prohibitedLine() {
  return `${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: 'docs/issues/305-review.md:1:prior assessment' } })}\n`;
}

const originalGetHandle = RuntimeRegistry.prototype.getHandle;
RuntimeRegistry.prototype.getHandle = function getHandle(agentId) {
  if (minionId !== undefined && agentId === minionId) {
    if (globalThis.__gruBlindHttpHandle === undefined) {
      globalThis.__gruBlindHttpHandle = {
        id: minionId,
        role: 'minion',
        sessionFile,
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async prompt() { appendFileSync(sessionFile, prohibitedLine()); },
        async steer() {},
        async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle', lastActivity: null, sessionFile }; },
        async dispose() {},
      };
    }
    return globalThis.__gruBlindHttpHandle;
  }
  return originalGetHandle.call(this, agentId);
};
