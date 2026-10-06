import { mkdtempSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  applyLegacyReportBackfill,
  classifyLegacyReportJob,
  legacyJobPrNumber,
  planLegacyReportBackfill,
  prUrlNumber,
} from '../src/ledger/report-backfill.js';
import { parseArgs } from '../src/cli/report-jobs-backfill.js';

describe('legacy report backfill classification (issue #220)', () => {
  it('classifies by job-id pattern with review lenses outranking later tokens', () => {
    // Review lens lanes.
    for (const id of [
      'job-gc-test-budgets-review-blind-hunter-dcee6ee',
      'job-pr144-final-adversarial-36c-20261003',
      'job-pr142-whole-edge-case-hunter-09ed-20261002',
      'terminal-retirement-review-verification-gap-fa8b591',
      'job-perkins-whole-pr-review',
    ]) {
      expect(classifyLegacyReportJob(id, null)?.deliverable).toBe('review');
    }
    // Verification and investigation lanes.
    expect(classifyLegacyReportJob('job-verification-run-77', null)?.deliverable).toBe('artifact');
    expect(classifyLegacyReportJob('incident-postmortem-investigation-1', null)?.deliverable).toBe('investigation');
    // A bare `final-` lane is the final review pass (last priority).
    expect(classifyLegacyReportJob('final-dashboard-copy', null)?.deliverable).toBe('review');
    // The briefing fallback fills what the id cannot.
    expect(classifyLegacyReportJob('lane-42', 'please review the auth changes')?.deliverable).toBe('review');
    expect(classifyLegacyReportJob('lane-42', 'investigate the flaky suite')?.deliverable).toBe('investigation');
    expect(classifyLegacyReportJob('lane-42', 'no signals here')).toBeNull();
    expect(classifyLegacyReportJob('lane-42', null)).toBeNull();
  });

  it('extracts PR numbers from legacy ids and PR urls', () => {
    expect(legacyJobPrNumber('job-pr144-final-adversarial-36c')).toBe(144);
    expect(legacyJobPrNumber('pr7-review')).toBe(7);
    expect(legacyJobPrNumber('job-no-number')).toBeNull();
    expect(prUrlNumber('https://github.com/o/r/pull/144')).toBe(144);
    expect(prUrlNumber('https://github.com/o/r/pull/144#discussion')).toBe(144);
    expect(prUrlNumber('https://github.com/o/r/pulls')).toBeNull();
  });
});

describe('legacy report backfill plan and apply (issue #220)', () => {
  function freshLedger(): { api: LedgerApi; db: LedgerDb; cleanup(): void } {
    const realDir = mkdtempSync(`./.tmp-report-backfill-`);
    const db = new LedgerDb(realDir);
    const api = new LedgerApi(db.handle, { bus: new EventBus() });
    return {
      api,
      db,
      cleanup() {
        db.close();
        rmSync(realDir, { recursive: true, force: true });
      },
    };
  }

  /** A legacy delivered lane: PR-less, NULL deliverable (pre-E19 shape). */
  function seedLegacyJob(api: LedgerApi, jobId: string, briefing = 'look into it'): void {
    api.addJob({ id: jobId, repo: 'fixture-app', title: `t-${jobId}`, briefing });
    api.setJobStatus(jobId, 'working');
    api.setJobStatus(jobId, 'delivered');
    api.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: 'head-1' } });
  }

  it('dry-run lists every legacy row with its proposed outcome and writes nothing', () => {
    const h = freshLedger();
    try {
      seedLegacyJob(h.api, 'job-pr31-review-blind');
      seedLegacyJob(h.api, 'mystery-lane-42', 'nothing recognizable');
      // An E19-marked report job is NOT legacy scope; nor a PR-carrying lane.
      h.api.addJob({ id: 'modern-review', repo: 'fixture-app', title: 't', briefing: 'b', deliverable: 'review' });
      h.api.setJobStatus('modern-review', 'working');
      h.api.setJobStatus('modern-review', 'delivered');
      h.api.appendCustomEvent({ kind: 'job.delivered', jobId: 'modern-review', payload: {} });

      const plan = planLegacyReportBackfill(h.api);
      expect(plan.proposals.map((proposal) => proposal.job.id).sort()).toEqual(['job-pr31-review-blind', 'mystery-lane-42']);
      expect(plan.proposals.find((proposal) => proposal.job.id === 'job-pr31-review-blind')?.outcome).toBe('obligation-opened');
      expect(plan.proposals.find((proposal) => proposal.job.id === 'mystery-lane-42')?.outcome).toBe('owner-list');
      expect(plan.ownerList).toBe(1);
      // Nothing was written.
      expect(h.api.getJob('job-pr31-review-blind')?.deliverable).toBeNull();
      expect(h.api.getJob('job-pr31-review-blind')?.status).toBe('delivered');
      expect(h.api.listObligations({ jobId: 'job-pr31-review-blind' })).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('proposes superseded when the target PR merged or a newer job covers the same PR', async () => {
    const h = freshLedger();
    try {
      seedLegacyJob(h.api, 'job-pr31-review-blind');
      // The job that carried PR #31, now merged.
      h.api.addJob({ id: 'impl-pr31', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.api.setJobStatus('impl-pr31', 'working');
      h.api.setJobPr('impl-pr31', `https://github.com/o/r/pull/31`);
      h.api.setJobStatus('impl-pr31', 'in-review');
      h.api.setJobStatus('impl-pr31', 'merged');

      seedLegacyJob(h.api, 'job-pr32-review-edge');
      // A NEWER job for PR #32 — the older report was superseded by re-review.
      // (Sibling discovery indexes jobs that CARRY the PR; "newer" compares
      // created_at, so the fixture lets the clock advance.)
      await new Promise((resolve) => setTimeout(resolve, 5));
      h.api.addJob({ id: 'job-pr32-review-edge-retry', repo: 'fixture-app', title: 't', briefing: 'b', deliverable: 'review' });
      h.api.setJobPr('job-pr32-review-edge-retry', 'https://github.com/o/r/pull/32');

      const plan = planLegacyReportBackfill(h.api);
      const merged = plan.proposals.find((proposal) => proposal.job.id === 'job-pr31-review-blind');
      expect(merged?.outcome).toBe('superseded');
      expect(merged?.reason).toContain('#31');
      const retried = plan.proposals.find((proposal) => proposal.job.id === 'job-pr32-review-edge');
      expect(retried?.outcome).toBe('superseded');
      expect(retried?.reason).toContain('newer job');
    } finally {
      h.cleanup();
    }
  });

  it('apply stamps the kind, opens the obligation, records report.backfilled, and closes provable supersessions', () => {
    const h = freshLedger();
    try {
      seedLegacyJob(h.api, 'job-pr33-review-lens');
      h.api.addJob({ id: 'impl-pr33', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.api.setJobStatus('impl-pr33', 'working');
      h.api.setJobPr('impl-pr33', 'https://github.com/o/r/pull/33');
      h.api.setJobStatus('impl-pr33', 'in-review');
      h.api.setJobStatus('impl-pr33', 'merged');
      seedLegacyJob(h.api, 'verification-lane-9');

      const plan = planLegacyReportBackfill(h.api);
      const applied = applyLegacyReportBackfill(h.api, plan);
      expect(applied.failed).toBe(0);
      expect(applied.applied).toBe(2);

      // The merged-target lane: superseded end-to-end.
      expect(h.api.getJob('job-pr33-review-lens')?.deliverable).toBe('review');
      expect(h.api.getJob('job-pr33-review-lens')?.status).toBe('done');
      expect(h.api.getJob('job-pr33-review-lens')?.targetRef).toBe('https://github.com/o/r/pull/33');
      expect(h.api.listObligations({ jobId: 'job-pr33-review-lens' })).toHaveLength(1);
      expect(h.api.latestJobEvent('job-pr33-review-lens', 'report.backfilled')?.payload).toMatchObject({ outcome: 'superseded' });
      expect(h.api.latestJobEvent('job-pr33-review-lens', 'report.superseded')).not.toBeNull();

      // The unprovable lane: kind stamped, obligation open, owner decides.
      expect(h.api.getJob('verification-lane-9')?.deliverable).toBe('artifact');
      expect(h.api.getJob('verification-lane-9')?.status).toBe('delivered');
      const obligation = h.api.listObligations({ jobId: 'verification-lane-9' })[0];
      expect(obligation?.incidentKey).toBe('report:verification-lane-9');
      expect(obligation?.state).toBe('open');
      expect(obligation?.logicalStep).toBe('verification');
      expect(h.api.latestJobEvent('verification-lane-9', 'report.backfilled')?.payload).toMatchObject({ outcome: 'obligation-opened' });
    } finally {
      h.cleanup();
    }
  });

  it('apply is idempotent: settled rows leave the scan, stamped rows stay stamped, owner rows keep listing', () => {
    const h = freshLedger();
    try {
      seedLegacyJob(h.api, 'job-pr34-review-lens');
      h.api.addJob({ id: 'impl-pr34', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.api.setJobStatus('impl-pr34', 'working');
      h.api.setJobPr('impl-pr34', 'https://github.com/o/r/pull/34');
      h.api.setJobStatus('impl-pr34', 'in-review');
      h.api.setJobStatus('impl-pr34', 'merged');
      seedLegacyJob(h.api, 'unclassifiable-lane');

      const firstPlan = planLegacyReportBackfill(h.api);
      const first = applyLegacyReportBackfill(h.api, firstPlan);
      expect(first.applied).toBe(1);
      // Replaying the SAME stale plan is a true no-op (no duplicate event).
      const replayed = applyLegacyReportBackfill(h.api, firstPlan);
      expect(replayed.applied).toBe(0);
      expect(h.api.listEvents({ limit: 500 }).filter((event) => event.jobId === 'job-pr34-review-lens' && event.kind === 'report.backfilled')).toHaveLength(1);

      const secondPlan = planLegacyReportBackfill(h.api);
      // The classified row is gone from the scan; the owner row re-lists.
      expect(secondPlan.proposals.map((proposal) => proposal.job.id)).toEqual(['unclassifiable-lane']);
      const second = applyLegacyReportBackfill(h.api, secondPlan);
      expect(second.applied).toBe(0);
      expect(second.skipped).toBe(1);

      // The stamped rows did not change: one obligation, one done job.
      expect(h.api.listObligations({ jobId: 'job-pr34-review-lens' })).toHaveLength(1);
      expect(h.api.getJob('job-pr34-review-lens')?.status).toBe('done');
      expect(h.api.getJob('unclassifiable-lane')?.deliverable).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('the CLI contract: --apply is opt-in, dry-run is the default', () => {
    expect(parseArgs([])).toEqual({ apply: false, dataDir: null, json: false });
    expect(parseArgs(['--apply', '--json'])).toEqual({ apply: true, dataDir: null, json: true });
    expect(parseArgs(['--data-dir', '/tmp/x']).dataDir).toBe('/tmp/x');
    expect(() => parseArgs(['--write'])).toThrow(/unknown argument/);
  });
});
