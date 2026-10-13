#!/usr/bin/env node
/**
 * Startup-assembly double for the blind-coverage observer (issue #339 F3).
 *
 * Injected into the compiled service with NODE_OPTIONS=--import. It patches the
 * compiled `Supervisor.prototype.setObserveBlindTurn` so a test can observe the
 * PRODUCTION main.ts installation instead of installing the observer itself.
 *
 * When the test writes `GRU_BLIND_TRIGGER`, this drives a real recovered turn
 * through the production `Supervisor.deliverRecoveredTurn` with a runtime double
 * whose prompt appends a prohibited tool result to the real session file. The
 * production `DispatchService.observeBlindSession` (the installed observer) then
 * records the invalidation on the real ledger. Nothing here writes a report,
 * status, disposition, or any other fact: only the observer's own access event.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { clearInterval, setInterval } from 'node:timers';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const { Supervisor } = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'supervision', 'supervisor.js')).href);

const trigger = process.env['GRU_BLIND_TRIGGER'];
const resultFile = process.env['GRU_BLIND_RESULT'];

// Capture the production installation: this wrapper runs only because
// main.ts calls `supervisorLive.setObserveBlindTurn(observeBlindTurn)`.
const install = Supervisor.prototype.setObserveBlindTurn;
Supervisor.prototype.setObserveBlindTurn = function setObserveBlindTurn(observe) {
  globalThis.__gruBlindSupervisor = this;
  globalThis.__gruBlindObserverInstalled = typeof observe === 'function';
  return install.call(this, observe);
};

function prohibitedLine() {
  return `${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: 'docs/issues/305-review.md:1:prior assessment' } })}\n`;
}

async function drive() {
  const spec = JSON.parse(readFileSync(trigger, 'utf8'));
  const supervisor = globalThis.__gruBlindSupervisor;
  if (supervisor === undefined || globalThis.__gruBlindObserverInstalled !== true) {
    writeFileSync(resultFile, JSON.stringify({ installed: false }));
    return;
  }
  const handle = {
    id: spec.agentId,
    role: 'minion',
    sessionFile: spec.sessionFile,
    capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
    async prompt() { appendFileSync(spec.sessionFile, prohibitedLine()); },
    async steer() {},
    async followUp() {},
    subscribe() { return () => {}; },
    health() { return { state: 'idle', lastActivity: null, sessionFile: spec.sessionFile }; },
    async dispose() {},
  };
  const agent = {
    agentId: spec.agentId,
    role: 'minion',
    label: null,
    handle,
    recoveryAdmission: null,
    breakerOpen: false,
    slot: null,
    inRestart: false,
    openTurn: false,
    openControl: false,
    rateLimitRetry: null,
    openToolCalls: new Set(),
    pendingRecovery: null,
  };
  supervisor.agents.set(spec.agentId, agent);
  await supervisor.deliverRecoveredTurn(
    agent,
    handle,
    spec.agentId,
    { text: 'finish the review', owner: `dispatch:${spec.jobId}` },
    'restart',
    { pending: null, hadOpenTurn: true, originAgentId: spec.agentId, jobId: spec.jobId, authorityEpoch: 0 },
  );
  writeFileSync(resultFile, JSON.stringify({ installed: true, observed: true }));
}

if (trigger !== undefined && resultFile !== undefined) {
  const poll = setInterval(() => {
    if (!existsSync(trigger)) return;
    clearInterval(poll);
    void drive().catch((error) => {
      writeFileSync(resultFile, JSON.stringify({ error: String(error) }));
    });
  }, 25);
}
