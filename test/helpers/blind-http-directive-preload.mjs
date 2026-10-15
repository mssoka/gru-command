#!/usr/bin/env node
/**
 * Compiled-service HTTP observer composition fixture (issue #339 G2).
 * Supplies ONE scripted native-capable adapter handle through the REAL
 * registry publication/supervision funnel. Never patches registry lookup,
 * custody checks, observer installation, the scanner, or a provider SDK.
 * main.ts -> dispatch server -> physical directive delivery is the only
 * observation path under test; unintended provider spawns fail loudly.
 *
 * This is a protocol double, NOT production Pi/Claude SDK-boundary evidence.
 * Its deliberately unmatched prohibited toolResult invalidates coverage but
 * must remain UNKNOWN completion, never an invented delivery receipt.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { ClaudeCodeRuntime } = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'runtime', 'claude-adapter.js')).href);
const {
  inspectDirectiveCheckpoint, prepareDirectiveBinding, prepareDirectiveProducer,
  recordDirectiveProducerCessation,
} = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'runtime', 'directive-checkpoint.js')).href);
const minionId = process.env['GRU_BLIND_HTTP_MINION_ID'];
const sessionFile = process.env['GRU_BLIND_HTTP_SESSION_FILE'];
let spawned = false;
ClaudeCodeRuntime.prototype.spawn = async function spawn(role, options = {}) {
  if (role !== 'minion' || minionId === undefined || sessionFile === undefined ||
      options.agentId !== minionId || options.resumeFile !== sessionFile || spawned) {
    throw new Error('G2 fixture authorizes only one scripted original minion resume; no other provider spawn');
  }
  const header = JSON.parse(readFileSync(sessionFile, 'utf8').split('\n')[0]);
  if (header.type !== 'session' || typeof header.id !== 'string' || header.cwd !== options.cwd) throw new Error('G2 fixture requires its original native header and registered cwd');
  spawned = true;
  let producer = null;
  let ceased = false;
  const append = row => appendFileSync(sessionFile, `${JSON.stringify(row)}\n`);
  return {
    id: minionId, role: 'minion', sessionFile,
    capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
    prepareDirectiveProducer(identity) {
      if (producer !== null && !isDeepStrictEqual(producer.identity, identity)) throw new Error('G2 fixture cannot substitute another native request identity');
      producer ??= prepareDirectiveProducer({ identity, agentId: minionId, sessionId: header.id, sessionFile });
      return producer;
    },
    inspectDirective: identity => inspectDirectiveCheckpoint(sessionFile, identity),
    async prompt(text, promptOptions) {
      const directive = promptOptions?.directive;
      if (ceased || directive === undefined || producer === null || !isDeepStrictEqual(producer.identity, directive.identity)) throw new Error('G2 fixture requires its exact live prepared native directive');
      directive.beforeAdmission();
      prepareDirectiveBinding({ identity: directive.identity, runtime: 'pi', agentId: minionId,
        sessionId: header.id, sessionFile, text, authorityManifest: 'deterministic G2 HTTP fixture' });
      const userId = randomUUID();
      append({ type: 'message', id: userId, parentId: null, message: { role: 'user', content: [{ type: 'text', text }] } });
      const proof = inspectDirectiveCheckpoint(sessionFile, directive.identity);
      if (proof.state === 'unknown') throw new Error(proof.reason);
      directive.onAdmitted(proof.binding);
      append({ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: 'docs/issues/305-review.md:1:prior assessment' } });
      append({ type: 'message', id: randomUUID(), parentId: userId, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'scripted turn ended; malformed tool evidence remains UNKNOWN' }] } });
    },
    async steer() {},
    async followUp() {},
    subscribe() { return () => {}; },
    health() { return { state: ceased ? 'disposed' : 'idle', lastActivity: null, sessionFile }; },
    async dispose() {
      if (producer !== null) recordDirectiveProducerCessation(producer);
      ceased = true;
    },
    cessationEvidence: () => ceased ? 'ceased' : 'unknown',
  };
};
