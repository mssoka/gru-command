import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type AddJobAmendmentResult } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const BRIEFING = 'Goal: ship the label fix.\nAcceptance 1: use the fixed bmad-build entry point.';

function boot(dir = temp('gru-amendments-')): { api: LedgerApi; db: LedgerDb; dir: string } {
  const db = new LedgerDb(dir);
  const api = new LedgerApi(db.handle, { bus: new EventBus() });
  return { api, db, dir };
}

function accepted(result: AddJobAmendmentResult): Extract<AddJobAmendmentResult, { status: 'accepted' }> {
  if (result.status !== 'accepted') throw new Error(`expected accepted, got ${result.status}: ${result.reason}`);
  return result;
}

function amendment(
  api: LedgerApi,
  contractSha: string,
  body: string,
  overrides: Partial<Parameters<LedgerApi['addJobAmendment']>[0]> = {},
): AddJobAmendmentResult {
  return api.addJobAmendment({
    jobId: 'job-1',
    body,
    supersedes: [],
    approval: { by: 'owner', reference: 'epoch12 seq194760 client_msg_id feaf620e' },
    expectedContractSha256: contractSha,
    ...overrides,
  });
}

describe('canonical job amendments', () => {
  it('renders the effective contract as the original briefing plus append-only amendments', () => {
    const { api } = boot();
    api.addJob({ id: 'job-1', repo: 'repo', title: 't', briefing: BRIEFING });
    const base = api.effectiveContract('job-1')!;
    expect(base.version).toBe(0);
    expect(base.text).toBe(BRIEFING);
    expect(base.contractSha256).toBe(sha256(BRIEFING));
    const added = accepted(amendment(api, base.contractSha256, 'Acceptance 1 is superseded: select task-relevant installed skills.', {
      supersedes: ['original:Acceptance 1'],
    }));
    expect(added.amendment.version).toBe(1);
    expect(added.idempotent).toBe(false);
    expect(added.contract.version).toBe(1);
    expect(added.contract.contractSha256).not.toBe(base.contractSha256);
    const text = added.contract.text!;
    expect(text.startsWith(BRIEFING)).toBe(true);
    expect(text).toContain('CANONICAL AMENDMENTS');
    expect(text).toContain('## Amendment #1');
    expect(text).toContain('approval: owner — epoch12 seq194760 client_msg_id feaf620e');
    expect(text).toContain('supersedes: original:Acceptance 1');
    expect(text).toContain('status: EFFECTIVE');
    expect(text).toContain('select task-relevant installed skills.');
    expect(api.effectiveContract('job-1')!.contractSha256).toBe(added.contract.contractSha256);
    expect(api.listJobAmendments('job-1')).toHaveLength(1);
    const events = api.listEvents().filter((entry) => entry.kind === 'job.amendment-accepted');
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { contract_sha256: string }).contract_sha256).toBe(added.contract.contractSha256);
    // The original job briefing row is untouched.
    expect(api.getJob('job-1')!.briefing).toBe(BRIEFING);
  });

  it('marks a superseded amendment NOT EFFECTIVE without deleting history', () => {
    const { api } = boot();
    api.addJob({ id: 'job-1', repo: 'repo', title: 't', briefing: BRIEFING });
    const first = accepted(amendment(api, sha256(BRIEFING), 'First amendment.'));
    const second = accepted(amendment(api, first.contract.contractSha256, 'Second amendment replaces the first.', {
      supersedes: [`amendment:${first.amendment.id}`],
    }));
    const text = second.contract.text!;
    expect(text).toContain('First amendment.');
    expect(text).toContain(`status: NOT EFFECTIVE — superseded by amendment #2`);
    expect(text).toContain('Second amendment replaces the first.');
  });

  it('rejects stale/concurrent writes with the current contract hash, and audits the refusal', () => {
    const { api } = boot();
    api.addJob({ id: 'job-1', repo: 'repo', title: 't', briefing: BRIEFING });
    const first = accepted(amendment(api, sha256(BRIEFING), 'First.'));
    const stale = amendment(api, sha256(BRIEFING), 'Concurrent writer.');
    expect(stale.status).toBe('rejected');
    if (stale.status !== 'rejected') throw new Error('unreachable');
    expect(stale.code).toBe('stale');
    expect(stale.currentContractSha256).toBe(first.contract.contractSha256);
    expect(stale.currentVersion).toBe(1);
    expect(api.listJobAmendments('job-1')).toHaveLength(1);
    const rejects = api.listEvents().filter((entry) => entry.kind === 'job.amendment-rejected');
    expect(rejects).toHaveLength(1);
    expect((rejects[0]!.payload as { code: string }).code).toBe('stale');
  });

  it('rejects a supersedes anchor absent from the briefing, and audits the refusal', () => {
    const { api } = boot();
    api.addJob({ id: 'job-1', repo: 'repo', title: 't', briefing: BRIEFING });
    const result = amendment(api, sha256(BRIEFING), 'Rewrite.', { supersedes: ['original:Acceptance 99'] });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.code).toBe('invalid');
    expect(result.reason).toContain('Acceptance 99');
    expect(api.listJobAmendments('job-1')).toHaveLength(0);
    const rejects = api.listEvents().filter((entry) => entry.kind === 'job.amendment-rejected');
    expect(rejects.some((entry) => (entry.payload as { reason?: string }).reason?.includes('Acceptance 99'))).toBe(true);
  });

  it('refuses to rewrite a briefing that already carries accepted amendments', () => {
    const { api } = boot();
    api.addJob({ id: 'job-1', repo: 'repo', title: 't', briefing: BRIEFING });
    accepted(amendment(api, sha256(BRIEFING), 'First.'));
    expect(() => api.setJobBriefing('job-1', 'A rewritten briefing.')).toThrow(/accepted canonical amendments/u);
    expect(api.getJob('job-1')!.briefing).toBe(BRIEFING);
  });

  it('audits a job-not-found refusal instead of dropping it (events carry no job FK)', () => {
    const { api } = boot();
    const result = amendment(api, sha256(BRIEFING), 'Body.', { jobId: 'missing-job' });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.code).toBe('job-not-found');
    const rejects = api.listEvents().filter((entry) => entry.kind === 'job.amendment-rejected');
    expect(rejects.some((entry) => (entry.payload as { code?: string }).code === 'job-not-found')).toBe(true);
  });

  it('idempotent retries resolve deterministically; a key reused for another request conflicts', () => {
    const { api } = boot();
    api.addJob({ id: 'job-1', repo: 'repo', title: 't', briefing: BRIEFING });
    const request = {
      jobId: 'job-1',
      body: 'Approved correction.',
      supersedes: ['original:Goal'],
      approval: { by: 'owner', reference: 'j-969' },
      expectedContractSha256: sha256(BRIEFING),
      idempotencyKey: 'retry-1',
    };
    const first = accepted(api.addJobAmendment(request));
    const retry = accepted(api.addJobAmendment(request));
    expect(retry.idempotent).toBe(true);
    expect(retry.amendment.id).toBe(first.amendment.id);
    expect(api.listJobAmendments('job-1')).toHaveLength(1);
    const conflict = api.addJobAmendment({ ...request, body: 'A different request with the same key.' });
    expect(conflict.status).toBe('rejected');
    if (conflict.status !== 'rejected') throw new Error('unreachable');
    expect(conflict.code).toBe('idempotency-conflict');
    expect(api.listJobAmendments('job-1')).toHaveLength(1);
  });

  it('rejects improperly authorized, unknown-supersede, empty and oversized drafts', () => {
    const { api } = boot();
    api.addJob({ id: 'job-1', repo: 'repo', title: 't', briefing: BRIEFING });
    const hash = sha256(BRIEFING);
    const blankReference = api.addJobAmendment({
      jobId: 'job-1',
      body: 'x',
      approval: { by: 'owner', reference: '   ' },
      expectedContractSha256: hash,
    });
    expect(blankReference.status).toBe('rejected');
    const unknownSupersede = api.addJobAmendment({
      jobId: 'job-1',
      body: 'x',
      supersedes: ['amendment:does-not-exist'],
      approval: { by: 'owner', reference: 'j-969' },
      expectedContractSha256: hash,
    });
    expect(unknownSupersede.status).toBe('rejected');
    const badAnchor = api.addJobAmendment({
      jobId: 'job-1',
      body: 'x',
      supersedes: ['Goal'],
      approval: { by: 'owner', reference: 'j-969' },
      expectedContractSha256: hash,
    });
    expect(badAnchor.status).toBe('rejected');
    const empty = amendment(api, hash, '   ');
    expect(empty.status).toBe('rejected');
    const oversized = amendment(api, hash, 'x'.repeat(32 * 1024 + 1));
    expect(oversized.status).toBe('rejected');
    expect(api.listJobAmendments('job-1')).toHaveLength(0);
  });

  it('refuses terminal jobs and jobs without a recorded briefing', () => {
    const { api } = boot();
    api.addJob({ id: 'job-1', repo: 'repo', title: 't', briefing: BRIEFING });
    api.setJobStatus('job-1', 'working');
    api.setJobStatus('job-1', 'in-review');
    api.setJobStatus('job-1', 'merged');
    const terminal = amendment(api, sha256(BRIEFING), 'late');
    expect(terminal.status).toBe('rejected');
    if (terminal.status !== 'rejected') throw new Error('unreachable');
    expect(terminal.code).toBe('job-terminal');
    // A binned (discarded) lane is terminal on the same contract.
    api.addJob({ id: 'job-3', repo: 'repo', title: 'discarded', briefing: BRIEFING });
    api.setJobStatus('job-3', 'working');
    api.setJobStatus('job-3', 'binned');
    const discarded = amendment(api, sha256(BRIEFING), 'too late', { jobId: 'job-3' });
    expect(discarded.status).toBe('rejected');
    if (discarded.status !== 'rejected') throw new Error('unreachable');
    expect(discarded.code).toBe('job-terminal');
    api.addJob({ id: 'job-2', repo: 'repo', title: 'no briefing' });
    const noBriefing = api.addJobAmendment({
      jobId: 'job-2',
      body: 'x',
      approval: { by: 'owner', reference: 'j-969' },
      expectedContractSha256: sha256(''),
    });
    expect(noBriefing.status).toBe('rejected');
    if (noBriefing.status !== 'rejected') throw new Error('unreachable');
    expect(noBriefing.code).toBe('no-briefing');
  });

  it('survives restart: accepted amendments and the effective contract are durable and exact', () => {
    const dir = temp('gru-amendments-restart-');
    const first = boot(dir);
    first.api.addJob({ id: 'job-1', repo: 'repo', title: 't', briefing: BRIEFING });
    const added = accepted(amendment(first.api, sha256(BRIEFING), 'Durable amendment.'));
    first.db.close();
    const second = boot(dir);
    const rows = second.api.listJobAmendments('job-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(added.amendment.id);
    expect(rows[0]!.bodySha256).toBe(added.amendment.bodySha256);
    expect(second.api.effectiveContract('job-1')!.contractSha256).toBe(added.contract.contractSha256);
    second.db.close();
  });

  it('legacy jobs without amendments keep byte-identical specs (version 0)', () => {
    const { api } = boot();
    api.addJob({ id: 'job-legacy', repo: 'repo', title: 't', briefing: 'Old briefing bytes.\nWith newlines.  ' });
    const contract = api.effectiveContract('job-legacy')!;
    expect(contract.version).toBe(0);
    expect(contract.text).toBe('Old briefing bytes.\nWith newlines.  ');
    expect(contract.amendmentIds).toEqual([]);
  });
});
