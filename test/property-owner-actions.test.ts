import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPropertyCampaignService } from '../src/dispatch/property-campaigns.js';
import { forceCoversBlocker, laneIsBusy, snapshotForceAuthorization } from '../src/dispatch/branch-idle.js';
import { unitCampaign, commit, UNIT_PATH } from './fixtures/property/executor/campaign.js';
import { ownerService } from './fixtures/property/owner-service.js';

const fixtures: ReturnType<typeof unitCampaign>[] = [];
const servers: Awaited<ReturnType<typeof ownerService>>[] = [];
afterEach(async () => { try { for (const server of servers.splice(0)) await server.close(); } finally { for (const f of fixtures.splice(0)) f.cleanup(); } });
async function setup(mode: 'disabled' | 'enforced' = 'disabled', automation = 'proposed', repair?: (f: ReturnType<typeof unitCampaign>, text: string) => void | Promise<void>) {
  const f = unitCampaign(mode, (repo) => writeFileSync(join(repo.root, '.gru-command/property.toml'), `mode="${mode}"\nautomation="${automation}"\n`)); fixtures.push(f);
  const h = await ownerService(f.candidate.root, async (text) => { if (repair !== undefined) await repair(f, text); else { writeFileSync(join(f.candidate.root, 'test/placeholder'), 'tracked\n'); commit(f.candidate, 'owner-approved implementation repair'); } }); servers.push(h);
  const proposed = await h.request(h.path, { campaign: f.reviewed }); expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  return { f, h, proposed, id: proposed.body.id, expectedHead: proposed.body.candidateSha! };
}

describe('ordinary owner HTTP property actions (controlled minion; no JSON issuance)', () => {
  it('authenticates owner actions and never makes proposal/configuration an execution approval', async () => {
    const { f, h, proposed, id, expectedHead } = await setup('disabled', 'approved-repair');
    expect((await h.request(h.path, { campaign: f.reviewed }, null)).status).toBe(401);
    expect(proposed.body).toMatchObject({ state: 'proposed', report: null, mergeAuthority: 'none' });
    expect((await h.request(`${h.path}/${id}/execute`, {})).body).toMatchObject({ state: 'proposed', report: null, proposedAction: 'execute' });
    expect((await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead, report: { blocking: false } })).status).toBe(400);
    expect(h.prompts).toEqual([]);
    expect((await h.request(`${h.path}/${id}`)).body.report).toBeNull();
  });

  it('binds approval to the job, managed candidate root, full head and reviewed ignored bytes', async () => {
    const { f, h, id, expectedHead } = await setup();
    expect((await h.request(h.path, { campaign: { ...f.reviewed, candidateRoot: f.healthy.root } })).status).toBe(400);
    expect((await h.request(`/api/jobs/foreign-job/property-campaigns/${id}/execute`, { decision: 'approve', expectedHead })).status).toBe(400);
    expect((await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead: 'a'.repeat(40) })).status).toBe(400);
    writeFileSync(join(f.candidate.root, 'node_modules/vitest/altered-same-version.mjs'), '// moved after proposal\n');
    const moved = await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead });
    expect(moved.status).toBe(400); expect(moved.body.detail).toMatch(/moved/); expect(h.prompts).toEqual([]);
  });

  it('executes only after an explicit owner decision, spends it once, and never restores authority from report files', async () => {
    const { h, id, expectedHead } = await setup();
    const executed = await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead });
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    expect(executed.body).toMatchObject({ state: 'executed', report: { mode: 'disabled', blocking: false, metrics: { executedRuns: 0 } } });
    expect((await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead })).status).toBe(400);
    const restarted = createPropertyCampaignService(h.serviceOptions);
    try { expect(() => restarted.read(h.jobId, id)).toThrow(/process-local/); } finally { await restarted.dispose(); }
  });

  it('defaults repair and retention to proposed, then routes explicit approvals through the ordinary minion/ledger path', async () => {
    const { f, h, id, expectedHead } = await setup('enforced');
    const executed = await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead, approvedRepairAttempts: 1 });
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    if (process.platform !== 'darwin') { expect(executed.body.report?.qualification?.verdict).toBe('escalated'); return; }
    expect(executed.body.report?.blocking).toBe(true); expect(h.prompts).toEqual([]);
    const proposed = await h.request(`${h.path}/${id}/repair`, { maxAttempts: 1 }); expect(proposed.body.proposedAction).toBe('repair'); expect(h.prompts).toEqual([]);
    const repaired = await h.request(`${h.path}/${id}/repair`, { decision: 'approve', expectedHead, maxAttempts: 1 });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200); expect(repaired.body.report).toMatchObject({ blocking: false, repairAttempts: 1, candidateOutcome: 'pass', mergeAuthority: 'none' });
    expect(h.prompts).toHaveLength(1); expect(h.prompts[0]).toContain('test/placeholder');
    expect(h.ledger.listPendingDirectives({ jobId: h.jobId, states: ['dispatching', 'admitted'] })).toEqual([]);
    expect(h.ledger.latestJobEvent(h.jobId, 'job.delivered')?.payload).toMatchObject({ sha: repaired.body.candidateSha, source: 'silas-directive' });
    expect((await h.request(`${h.path}/${id}/retain`, {})).body.proposedAction).toBe('retain'); expect(existsSync(join(f.candidate.root, UNIT_PATH))).toBe(false);
    const retained = await h.request(`${h.path}/${id}/retain`, { decision: 'approve', expectedHead: repaired.body.candidateSha });
    expect(retained.status, JSON.stringify(retained.body)).toBe(200); expect(retained.body.retainedPaths).toHaveLength(3);
    expect(readFileSync(join(f.candidate.root, UNIT_PATH), 'utf8')).toBe(f.reviewed.overlayFiles[0]!.content);
  });

  it('requires both documented config opt-in and an owner repair allocation for autonomous follow-through', async () => {
    const { h, id, expectedHead } = await setup('enforced', 'approved-repair');
    const result = await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead, approvedRepairAttempts: 1 });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    if (process.platform !== 'darwin') { expect(h.prompts).toEqual([]); return; }
    expect(result.body).toMatchObject({ state: 'repaired', report: { candidateOutcome: 'pass', blocking: false, repairAttempts: 1 } });
    expect(h.prompts).toHaveLength(1);
  });

  it('does not auto-repair from config opt-in alone when execution was approved without a repair allocation', async () => {
    const { h, id, expectedHead } = await setup('enforced', 'approved-repair');
    const result = await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead });
    expect(result.status, JSON.stringify(result.body)).toBe(200); expect(result.body.state).toBe('executed'); expect(h.prompts).toEqual([]);
  });

  it('holds ordinary single-writer/review fences until native repair and frozen validation both settle', async () => {
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const { f, h, id, expectedHead } = await setup('enforced', 'proposed', async (repo) => { enter(); await gate; writeFileSync(join(repo.candidate.root, 'test/placeholder'), 'tracked\n'); commit(repo.candidate, 'gated implementation repair'); });
    await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead }); if (process.platform !== 'darwin') return;
    const operation = h.request(`${h.path}/${id}/repair`, { decision: 'approve', expectedHead, maxAttempts: 1 });
    await Promise.race([entered, operation.then((result) => { throw new Error(`repair returned before native gate: ${JSON.stringify(result)}`); })]);
    try {
      const job = h.ledger.getJob(h.jobId)!;
      expect(laneIsBusy(h.ledger, job)).toBe(true);
      const blocker = { jobId: h.jobId, status: job.status, branch: 'main' };
      expect(forceCoversBlocker(h.ledger, snapshotForceAuthorization(h.ledger, [blocker]), blocker)).toBe(false);
      expect(() => h.ledger.beginDirectiveIntent({ jobId: h.jobId, directive: 'competing writer', holder: 'unit' })).toThrow(/already live/);
      expect(() => h.ledger.beginJobAdmission(h.jobId, 'initial dispatch')).toThrow(/competing/);
      expect(h.ledger.listPendingDirectives({ jobId: h.jobId, states: ['dispatching', 'admitted'] })).toHaveLength(1);
    } finally { release(); const result = await operation; expect(result.status, JSON.stringify(result.body)).toBe(200); }
    expect(f.candidate.git(['rev-parse', 'HEAD'])).not.toBe(expectedHead);
    expect(h.ledger.listJobAdmissions(h.jobId)).toEqual([]);
  });

  it('leaves interrupted native repair live for ordinary reconciliation, without delivery or automatic retry', async () => {
    const { h, id, expectedHead } = await setup('enforced', 'proposed', () => { throw new Error('controlled native minion error'); });
    await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead }); if (process.platform !== 'darwin') return;
    const failed = await h.request(`${h.path}/${id}/repair`, { decision: 'approve', expectedHead, maxAttempts: 1 });
    expect(failed.status).toBe(400); expect(h.prompts).toHaveLength(1);
    const live = h.ledger.listPendingDirectives({ jobId: h.jobId, states: ['dispatching', 'admitted'] });
    expect(live).toHaveLength(1); expect(live[0]!.failReason).toMatch(/^reconcile:/);
    expect(h.ledger.latestJobEvent(h.jobId, 'job.delivered')).toBeNull();
    expect((await h.request(`${h.path}/${id}/repair`, { decision: 'approve', expectedHead, maxAttempts: 1 })).status).toBe(400); expect(h.prompts).toHaveLength(1);
    // #380: the failed entry is terminal and says so; the supported path is
    // to propose again, and execution waits for the live directive to settle.
    const dead = await h.request(`${h.path}/${id}`);
    expect(dead.body).toMatchObject({ state: 'failed', nextAction: expect.stringContaining('propose again') });
    const again = await h.request(h.path, { campaign: (await h.request(`${h.path}/${id}`)).body.campaign });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body).toMatchObject({ state: 'proposed', nextAction: expect.stringContaining('approve execution') });
    const waiting = await h.request(`${h.path}/${again.body.id}/execute`, { decision: 'approve', expectedHead: again.body.candidateSha });
    expect(waiting.status).toBe(400); expect(waiting.body.detail).toMatch(/settle it/);
  });

  it('makes room at the proposal cap by evicting the oldest settled non-blocking entry, never a pending proposal or blocker (#380)', async () => {
    const { f, h, id: first, expectedHead } = await setup();
    const service = createPropertyCampaignService({ ...h.serviceOptions, maxRetainedProposals: 2 });
    try {
      const a = service.propose(h.jobId, { campaign: f.reviewed });
      const b = service.propose(h.jobId, { campaign: f.reviewed });
      // Both are pending proposals: nothing may be evicted.
      expect(() => service.propose(h.jobId, { campaign: f.reviewed })).toThrow(/pending proposal or an unresolved blocker/);
      // A executes in disabled mode: settled and non-blocking, so evictable.
      const executed = await service.decide(h.jobId, a.id, 'execute', { decision: 'approve', expectedHead });
      expect(executed).toMatchObject({ state: 'executed', report: { blocking: false } });
      const c = service.propose(h.jobId, { campaign: f.reviewed });
      expect(() => service.read(h.jobId, a.id)).toThrow(/process-local/);
      expect(service.read(h.jobId, b.id).state).toBe('proposed');
      expect(service.read(h.jobId, c.id).state).toBe('proposed');
      expect(() => createPropertyCampaignService({ ...h.serviceOptions, maxRetainedProposals: 0 })).toThrow(/1\.\.128/);
      expect(first).toMatch(/^campaign-/);
    } finally { await service.dispose(); }
  });

  it('refuses new work after disposal rather than minting an approval on a stopped singleton', async () => {
    const { h, id, expectedHead } = await setup(); await h.propertyCampaigns.dispose();
    expect((await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead })).status).toBe(400);
    expect(h.propertyCampaigns.read(h.jobId, id).report).toBeNull();
  });
});
