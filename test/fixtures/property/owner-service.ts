import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../src/config.js';
import { EventBus } from '../../../src/events/bus.js';
import { LedgerApi } from '../../../src/ledger/api.js';
import { LedgerDb } from '../../../src/ledger/db.js';
import { createPropertyCampaignService } from '../../../src/dispatch/property-campaigns.js';
import { createDispatchServer } from '../../../src/dispatch/server.js';
import { DispatchService } from '../../../src/dispatch/service.js';
import { WaveRunner } from '../../../src/dispatch/perkins.js';
import { PacingGate } from '../../../src/runtime/pacing.js';
import type { AgentHandle } from '../../../src/runtime/types.js';
import type { WorktreeLane } from '../../../src/dispatch/worktree-port.js';
import { InMemoryWorktreePort } from '../../helpers/in-memory-worktrees.js';
import { propertyGit } from '../../../src/property/receipts.js';

/** Real HTTP/service/ledger/routing; the worktree registry and minion are
 * explicit controlled doubles. Generated-test execution is the real sandbox. */
export async function ownerService(candidateRoot: string, onRepair: (text: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'property-owner-service-'));
  writeFileSync(join(dir, 'config.toml'), '[auth]\ntoken="property-owner-test-token"\n[server]\nhost="127.0.0.1"\nport=0\n');
  const config = loadConfig({ GRU_COMMAND_HOME: dir }, dir);
  const db = new LedgerDb(dir); const bus = new EventBus(); const ledger = new LedgerApi(db.handle, { bus });
  const jobId = 'property-job'; ledger.addJob({ id: jobId, repo: candidateRoot, title: 'Owner-approved property repair' }); ledger.setJobStatus(jobId, 'delivered');
  ledger.registerAgent({ id: 'property-minion', role: 'minion', jobId }); ledger.setAgentState('property-minion', 'idle');
  const lane: WorktreeLane = { id: jobId, kind: 'job', jobId, roundId: null, repoPath: candidateRoot, repoName: 'property-fixture', path: candidateRoot, branch: propertyGit(candidateRoot, ['symbolic-ref', '--short', 'HEAD']).trim(), sha: propertyGit(candidateRoot, ['rev-parse', 'HEAD']).trim(), status: 'active' };
  const worktrees = Object.assign(new InMemoryWorktreePort(dir), { getWorktree: (id: string) => id === jobId ? lane : null, listWorktrees: () => [lane] });
  const prompts: string[] = [];
  let health: 'idle' | 'streaming' | 'error' = 'idle';
  const handle: AgentHandle = { id: 'property-minion', role: 'minion', sessionFile: null,
    capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
    async prompt(text) { prompts.push(text); health = 'streaming'; ledger.setAgentState(handle.id, 'streaming'); try { await onRepair(text); health = 'idle'; ledger.setAgentState(handle.id, 'idle'); } catch (error) { health = 'error'; ledger.setAgentState(handle.id, 'error'); throw error; } },
    async steer() {}, async followUp() {}, async dispose() {}, subscribe() { return () => {}; }, health() { return { state: health, lastActivity: null, sessionFile: null }; }, hasLiveProcess() { return health === 'streaming'; }, isCompacting() { return false; } };
  const registry = { getHandle: (id: string) => id === handle.id ? handle : null, spawn: async () => handle, disposeHandle: async () => {} };
  const spawner = async () => handle;
  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const wave = new WaveRunner({ ledger, worktrees, spawner, bus, reviewArtifactRoot: join(dir, 'reviews') });
  const workerGate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
  const artifactsRoot = join(dir, 'campaigns'); mkdirSync(artifactsRoot);
  const serviceOptions = { ledger, worktrees, registry, wave, workerGate, artifactsRoot, pendingProducerBlockers: () => [] };
  const propertyCampaigns = createPropertyCampaignService(serviceOptions);
  const server = createDispatchServer({ config, ledger, dispatch, wave, propertyCampaigns, pendingProducerBlockers: () => [] });
  const http = createServer((req, res) => { if (!server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) { res.writeHead(404); res.end('{}'); } });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const request = async (path: string, body?: unknown, token: string | null = 'property-owner-test-token') => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as ReturnType<typeof propertyCampaigns.read> & { error?: string; detail?: string; proposedAction?: string } };
  };
  return { jobId, ledger, propertyCampaigns, serviceOptions, wave, workerGate, worktrees, prompts, request, dir, path: `/api/jobs/${jobId}/property-campaigns`, async close() { server.dispose(); await propertyCampaigns.dispose(); await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
