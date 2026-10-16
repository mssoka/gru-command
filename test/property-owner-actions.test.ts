import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// node:fs passes through; a test may make one removal or write fail (#380).
const { fsHooks } = vi.hoisted(() => ({ fsHooks: {
  beforeRm: null as ((path: string) => void) | null,
  beforeWrite: null as ((path: string) => void) | null,
} }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => { fsHooks.beforeRm?.(String(args[0])); return actual.rmSync(...args); },
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => { fsHooks.beforeWrite?.(String(args[0])); return actual.writeFileSync(...args); }) as typeof actual.writeFileSync,
  };
});
afterEach(() => { fsHooks.beforeRm = null; fsHooks.beforeWrite = null; });
import { createPropertyCampaignService, evictable, PropertyOwnerActionError, EVICTED_IDS_REMEMBERED, evictionVictim, nextAction, rememberEvicted } from '../src/dispatch/property-campaigns.js';
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
    expect(dead.body).toMatchObject({ state: 'failed', nextAction: { kind: 'propose-again', detail: expect.stringContaining('propose the reviewed campaign again') } });
    const again = await h.request(h.path, { campaign: (await h.request(`${h.path}/${id}`)).body.campaign });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body).toMatchObject({ state: 'proposed', nextAction: { kind: 'decide-execute', detail: expect.stringContaining('approve execution') } });
    const waiting = await h.request(`${h.path}/${again.body.id}/execute`, { decision: 'approve', expectedHead: again.body.candidateSha });
    expect(waiting.status).toBe(400); expect(waiting.body.detail).toMatch(/settle it/);
  });

  it('decides eviction and the next owner action from state and blocking alone (#380)', () => {
    const report = (blocking: boolean) => ({ blocking }) as never;
    const table = [
      ['proposed', null, false, 'decide-execute'], ['executed', report(true), false, 'decide-repair'],
      ['executed', report(false), true, 'none'], ['repaired', report(true), false, 'decide-repair'],
      ['repaired', report(false), false, 'decide-retain'], ['retained', report(false), true, 'none'],
      ['failed', report(true), true, 'propose-again'],
    ] as const;
    for (const [state, entryReport, canEvict, kind] of table) {
      const entry = { state, report: entryReport } as never;
      expect(evictable(entry), `${state} evictable`).toBe(canEvict);
      expect(nextAction(entry).kind, `${state} next`).toBe(kind);
    }
  });

  it('makes room at the proposal cap by evicting the oldest settled non-blocking entry, never a pending proposal or blocker (#380)', async () => {
    const { f, h, expectedHead } = await setup();
    const service = createPropertyCampaignService({ ...h.serviceOptions, maxRetainedProposals: 2 });
    try {
      const a = service.propose(h.jobId, { campaign: f.reviewed });
      const b = service.propose(h.jobId, { campaign: f.reviewed });
      // Both are pending proposals: nothing may be evicted.
      expect(() => service.propose(h.jobId, { campaign: f.reviewed })).toThrow(/every retained campaign is a pending proposal, an unresolved blocker, a repair awaiting retention or the campaign being decided right now/);
      // A executes in disabled mode: settled and non-blocking, so evictable.
      const executed = await service.decide(h.jobId, a.id, 'execute', { decision: 'approve', expectedHead });
      expect(executed).toMatchObject({ state: 'executed', report: { blocking: false }, nextAction: { kind: 'none' } });
      expect(b.nextAction).toMatchObject({ kind: 'decide-execute' });
      // A malformed proposal never costs a retained campaign its slot.
      expect(() => service.propose(h.jobId, { campaign: { ...f.reviewed, proposal: null } })).toThrow();
      expect(service.read(h.jobId, a.id).state).toBe('executed');
      const c = service.propose(h.jobId, { campaign: f.reviewed });
      // The evicted id says so by name, and its eviction is audited on disk.
      expect(() => service.read(h.jobId, a.id)).toThrow(/was evicted to make room for newer proposals; its audit files remain in/);
      const audit = readdirSync(join(h.serviceOptions.artifactsRoot, a.id)).filter((name) => name.startsWith('owner-evicted-'));
      expect(audit).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(h.serviceOptions.artifactsRoot, a.id, audit[0]!), 'utf8'))).toMatchObject({ evicted: { id: a.id, state: 'executed' }, byProposal: c.id });
      expect(service.read(h.jobId, b.id).state).toBe('proposed');
      expect(service.read(h.jobId, c.id).state).toBe('proposed');
      // Another job asking for the evicted id learns nothing about it.
      expect(() => service.read('another-job', a.id)).toThrow(/^no process-local campaign for this job\/id/u);
      expect(() => createPropertyCampaignService({ ...h.serviceOptions, maxRetainedProposals: 0 })).toThrow(/1\.\.128/);
    } finally { await service.dispose(); }
  });

  it('picks the eviction victim: oldest evictable, the proposing job\'s own first, never the one being decided (#380)', () => {
    const entry = (id: string, jobId: string, state: 'proposed' | 'executed' | 'retained' | 'failed', blocking = false) => ({ id, jobId, state, report: state === 'proposed' ? null : ({ blocking }) as never });
    const entries = [entry('p1', 'job-a', 'proposed'), entry('x1', 'job-b', 'executed'), entry('b1', 'job-a', 'executed', true), entry('r1', 'job-a', 'retained'), entry('f1', 'job-a', 'failed')];
    expect(evictionVictim(entries, 'job-a', null)?.id).toBe('r1');
    expect(evictionVictim(entries, 'job-c', null)?.id).toBe('x1');
    expect(evictionVictim(entries, 'job-a', 'r1')?.id).toBe('f1');
    expect(evictionVictim(entries, 'job-b', 'x1')?.id).toBe('r1');
    expect(evictionVictim([entry('p1', 'job-a', 'proposed'), entry('b1', 'job-a', 'executed', true)], 'job-a', null)).toBeUndefined();
    expect(evictionVictim([entry('x1', 'job-a', 'executed')], 'job-a', 'x1')).toBeUndefined();
  });

  it('remembers the last EVICTED_IDS_REMEMBERED evicted ids by default; an older one is forgotten (#380)', () => {
    const evicted = new Map<string, number>();
    for (let index = 0; index <= EVICTED_IDS_REMEMBERED; index += 1) rememberEvicted(evicted, `id-${String(index)}`, index);
    expect(EVICTED_IDS_REMEMBERED).toBe(1024);
    expect(evicted.size).toBe(EVICTED_IDS_REMEMBERED);
    expect(evicted.has('id-0')).toBe(false);
    expect(evicted.has(`id-${String(EVICTED_IDS_REMEMBERED)}`)).toBe(true);
  });

  it('remembers evicted ids within a bound, forgetting the oldest first (#380)', () => {
    const evicted = new Map<string, number>();
    for (let index = 0; index < 5; index += 1) rememberEvicted(evicted, `id-${String(index)}`, index, 3);
    expect([...evicted.keys()]).toEqual(['id-2', 'id-3', 'id-4']);
    rememberEvicted(evicted, 'id-2', 22, 3); // re-remembered: now the newest
    rememberEvicted(evicted, 'id-5', 5, 3);
    expect([...evicted.entries()]).toEqual([['id-4', 4], ['id-2', 22], ['id-5', 5]]);
  });

  it('never evicts the campaign being decided, and a failed eviction audit evicts nothing (#380)', async () => {
    const { f, h, expectedHead } = await setup();
    let releaseClear!: () => void;
    const clearing = new Promise<void>((resolve) => { releaseClear = resolve; });
    const host = {
      approveReviewedCampaign: () => ({}),
      execute: async () => ({ blocking: false, candidateSha: expectedHead }),
      repair: async (report: unknown) => report,
      retainReviewedRegression: () => [],
    };
    const wave = {
      assertWriterAdmissible: (jobId: string) => h.wave.assertWriterAdmissible(jobId),
      clearLaneForWriter: async (input: { readonly jobId: string; readonly writer: string }) => { await clearing; return h.wave.clearLaneForWriter(input); },
    };
    const service = createPropertyCampaignService({ ...h.serviceOptions, wave: wave as never, maxRetainedProposals: 2 }, host as never);
    try {
      const a = service.propose(h.jobId, { campaign: f.reviewed });
      await service.decide(h.jobId, a.id, 'execute', { decision: 'approve', expectedHead });
      const b = service.propose(h.jobId, { campaign: f.reviewed });
      // A is settled and evictable — but it is being decided right now.
      const retaining = service.decide(h.jobId, a.id, 'retain', { decision: 'approve', expectedHead });
      expect(() => service.propose(h.jobId, { campaign: f.reviewed })).toThrow(/or the campaign being decided right now; decide those first/u);
      expect(service.read(h.jobId, a.id).state).toBe('executed');
      releaseClear();
      expect(await retaining).toMatchObject({ id: a.id, state: 'retained' });
      // An eviction whose audit cannot be written evicts nothing: A stays.
      const auditDir = join(h.serviceOptions.artifactsRoot, a.id);
      const evictedAudit = () => readdirSync(auditDir).filter((name) => name.startsWith('owner-evicted-'));
      const campaignsBefore = readdirSync(h.serviceOptions.artifactsRoot).sort();
      // chmod cannot lock a directory for root: these refusals need a non-root user.
      expect(process.getuid?.(), 'run as a non-root user').not.toBe(0);
      chmodSync(auditDir, 0o500);
      let evictionRefusal: unknown = null;
      try { service.propose(h.jobId, { campaign: f.reviewed }); } catch (caught) { evictionRefusal = caught; } finally { chmodSync(auditDir, 0o700); }
      expect((evictionRefusal as Error).message).toMatch(new RegExp(`^the cache is full and campaign ${a.id} could not be evicted: its audit could not be written in ${auditDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\(.*EACCES.*\\); fix that directory, or decide a pending campaign, then propose again$`, 'u'));
      expect((evictionRefusal as Error).cause).toMatchObject({ code: 'EACCES' });
      expect(evictedAudit()).toEqual([]);
      // ...and the refused proposal left no record of its own.
      expect(readdirSync(h.serviceOptions.artifactsRoot).sort()).toEqual(campaignsBefore);
      // A proposal whose OWN record cannot be written evicts nothing either:
      // the victim's eviction record is withdrawn with it.
      chmodSync(h.serviceOptions.artifactsRoot, 0o500);
      try {
        expect(() => service.propose(h.jobId, { campaign: f.reviewed })).toThrow(/EACCES|permission denied/iu);
      } finally { chmodSync(h.serviceOptions.artifactsRoot, 0o700); }
      expect(evictedAudit()).toEqual([]);
      expect(service.read(h.jobId, a.id).state).toBe('retained');
      expect(service.read(h.jobId, b.id).state).toBe('proposed');
      // A withdrawal that fails itself fails loud: the original error and the
      // withdrawal's, and the record to remove by hand.
      fsHooks.beforeRm = (path) => { if (path.includes('owner-evicted-')) throw Object.assign(new Error('record busy'), { code: 'EBUSY' }); };
      chmodSync(h.serviceOptions.artifactsRoot, 0o500);
      let cleanupRefusal: unknown = null;
      try { service.propose(h.jobId, { campaign: f.reviewed }); } catch (caught) { cleanupRefusal = caught; } finally { chmodSync(h.serviceOptions.artifactsRoot, 0o700); fsHooks.beforeRm = null; }
      expect(cleanupRefusal).toBeInstanceOf(PropertyOwnerActionError);
      expect((cleanupRefusal as Error).message).toMatch(new RegExp(`^proposal campaign-[0-9a-f-]+ could not be recorded \\(.*EACCES.*\\) and its cleanup failed: Error: record busy — remove .*owner-evicted-[0-9a-f-]+\\.json \\(campaign ${a.id} was not evicted\\) by hand$`, 'u'));
      expect(((cleanupRefusal as Error).cause as AggregateError).errors.map((cause) => (cause as NodeJS.ErrnoException).code)).toEqual(['EACCES', 'EBUSY']);
      expect(evictedAudit()).toHaveLength(1);
      rmSync(join(auditDir, evictedAudit()[0]!));
      expect(service.read(h.jobId, a.id).state).toBe('retained');
      // A failed eviction audit removes its own partial record.
      fsHooks.beforeWrite = (path) => {
        if (!path.includes('owner-evicted-')) return;
        fsHooks.beforeWrite = null;
        writeFileSync(path, '{"partial');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      };
      expect(() => service.propose(h.jobId, { campaign: f.reviewed })).toThrow(/could not be evicted: its audit could not be written in .*\(Error: disk full\); fix that directory/u);
      expect(evictedAudit()).toEqual([]);
      expect(service.read(h.jobId, a.id).state).toBe('retained');
      // A partial record that cannot be removed is named, and travels as a cause.
      let partialPath = '';
      fsHooks.beforeWrite = (path) => {
        if (!path.includes('owner-evicted-')) return;
        fsHooks.beforeWrite = null; partialPath = path;
        writeFileSync(path, '{"partial');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      };
      fsHooks.beforeRm = (path) => { if (path.includes('owner-evicted-')) throw Object.assign(new Error('record stuck'), { code: 'EBUSY' }); };
      let partialRefusal: unknown = null;
      try { service.propose(h.jobId, { campaign: f.reviewed }); } catch (caught) { partialRefusal = caught; } finally { fsHooks.beforeRm = null; fsHooks.beforeWrite = null; }
      expect((partialRefusal as Error).message).toMatch(new RegExp(`then propose again \\(${partialPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} could not be removed: Error: record stuck — remove it by hand\\)$`, 'u'));
      expect(((partialRefusal as Error).cause as AggregateError).errors.map((cause) => (cause as NodeJS.ErrnoException).code)).toEqual(['ENOSPC', 'EBUSY']);
      rmSync(partialPath);
      // A record the exclusive write found already there is never removed.
      let foreign = '';
      fsHooks.beforeWrite = (path) => {
        if (!path.includes('owner-evicted-')) return;
        fsHooks.beforeWrite = null; foreign = path;
        writeFileSync(path, 'foreign');
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      };
      expect(() => service.propose(h.jobId, { campaign: f.reviewed })).toThrow(/could not be evicted: its audit could not be written in .*\(Error: exists\); fix that directory, or decide a pending campaign, then propose again$/u);
      expect(readFileSync(foreign, 'utf8')).toBe('foreign');
      rmSync(foreign);
      // A victim directory the failed audit itself had to create is removed with it.
      rmSync(auditDir, { recursive: true, force: true });
      fsHooks.beforeWrite = (path) => { if (path.includes('owner-evicted-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
      try { expect(() => service.propose(h.jobId, { campaign: f.reviewed })).toThrow(/could not be evicted/u); } finally { fsHooks.beforeWrite = null; }
      expect(existsSync(auditDir)).toBe(false);
      expect(service.read(h.jobId, a.id).state).toBe('retained');
      // Once the audit can be written, the same proposal evicts A by name.
      const c = service.propose(h.jobId, { campaign: f.reviewed });
      expect(evictedAudit()).toHaveLength(1);
      expect(() => service.read(h.jobId, a.id)).toThrow(/was evicted to make room/u);
      expect(service.read(h.jobId, c.id).state).toBe('proposed');
    } finally { await service.dispose(); }
  });

  it('a proposal whose own record fails after its directory exists leaves nothing, and names exactly what it could not remove (#380)', async () => {
    const { f, h } = await setup();
    const service = createPropertyCampaignService(h.serviceOptions);
    try {
      const before = readdirSync(h.serviceOptions.artifactsRoot).sort();
      // The directory is made, then the record write fails: the directory goes too.
      fsHooks.beforeWrite = (path) => { if (path.includes('owner-proposed-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
      expect(() => service.propose(h.jobId, { campaign: f.reviewed })).toThrow(/^disk full$/u);
      expect(readdirSync(h.serviceOptions.artifactsRoot).sort()).toEqual(before);
      // When that removal fails too, the directory is named for removal by hand.
      fsHooks.beforeRm = (path) => { if (/campaign-[0-9a-f-]+$/u.test(path)) throw Object.assign(new Error('directory busy'), { code: 'EBUSY' }); };
      let refusal: unknown = null;
      try { service.propose(h.jobId, { campaign: f.reviewed }); } catch (caught) { refusal = caught; } finally { fsHooks.beforeRm = null; fsHooks.beforeWrite = null; }
      expect(refusal).toBeInstanceOf(PropertyOwnerActionError);
      const left = readdirSync(h.serviceOptions.artifactsRoot).filter((name) => !before.includes(name));
      expect(left).toHaveLength(1);
      expect((refusal as Error).message).toBe(`proposal ${left[0]!} could not be recorded (Error: disk full) and its cleanup failed: Error: directory busy — remove ${join(h.serviceOptions.artifactsRoot, left[0]!)} by hand`);
      expect(((refusal as Error).cause as AggregateError).errors.map((cause) => (cause as NodeJS.ErrnoException).code)).toEqual(['ENOSPC', 'EBUSY']);
      // The proposal's own error is rethrown as it is; the composed refusal
      // around a failed cleanup is one bounded line, whatever the filesystem said.
      fsHooks.beforeWrite = (path) => { if (path.includes('owner-proposed-')) throw new Error(`disk\nfull\u202e ${'x'.repeat(400)}`); };
      let noisy: unknown = null;
      try { service.propose(h.jobId, { campaign: f.reviewed }); } catch (caught) { noisy = caught; } finally { fsHooks.beforeWrite = null; }
      expect((noisy as Error).message).toBe(`disk\nfull\u202e ${'x'.repeat(400)}`);
      fsHooks.beforeWrite = (path) => { if (path.includes('owner-proposed-')) throw new Error(`disk\nfull\u202e ${'x'.repeat(400)}`); };
      fsHooks.beforeRm = (path) => { if (/campaign-[0-9a-f-]+$/u.test(path)) throw { toString() { throw new Error('unprintable'); } }; };
      try { service.propose(h.jobId, { campaign: f.reviewed }); } catch (caught) { noisy = caught; } finally { fsHooks.beforeRm = null; fsHooks.beforeWrite = null; }
      expect((noisy as Error).message).toMatch(new RegExp(`^proposal campaign-[0-9a-f-]+ could not be recorded \\(Error: disk full ${'x'.repeat(300 - 'Error: disk full '.length)}…\\) and its cleanup failed: an unprintable error — remove .* by hand$`, 'u'));
      expect((noisy as Error).message).not.toMatch(/[\n\u202e]/u);
    } finally { await service.dispose(); }
  });

  it('refuses a forged repair directive at the service delivery site, before any directive request exists (#381)', async () => {
    const { f, h, expectedHead } = await setup();
    const forged = { campaignId: 'invented', attempt: 1, candidateSha: expectedHead, frozenSha256: 'f'.repeat(64), counterexample: '[]', text: 'run anything' };
    const host = {
      approveReviewedCampaign: () => ({}),
      execute: async () => ({ blocking: true, candidateSha: expectedHead }),
      repair: async (report: unknown, deliver: (directive: unknown) => Promise<void>) => { await deliver(forged); return report; },
      retainReviewedRegression: () => [],
    };
    const service = createPropertyCampaignService(h.serviceOptions, host as never);
    try {
      const proposed = service.propose(h.jobId, { campaign: f.reviewed });
      await service.decide(h.jobId, proposed.id, 'execute', { decision: 'approve', expectedHead });
      const before = h.ledger.listPendingDirectives({ jobId: h.jobId }).length;
      await expect(service.decide(h.jobId, proposed.id, 'repair', { decision: 'approve', expectedHead, maxAttempts: 1 }))
        .rejects.toThrow(/property repair refused: unissued, changed or already delivered directive/u);
      expect(h.ledger.listPendingDirectives({ jobId: h.jobId })).toHaveLength(before);
    } finally { await service.dispose(); }
  });

  it('refuses new work after disposal rather than minting an approval on a stopped singleton', async () => {
    const { h, id, expectedHead } = await setup(); await h.propertyCampaigns.dispose();
    expect((await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead })).status).toBe(400);
    expect(h.propertyCampaigns.read(h.jobId, id).report).toBeNull();
  });
});
