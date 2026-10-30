import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observeTerminalJobDirective, surfaceDirectiveRecovery } from '../src/dispatch/directive-progress.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { markHistoricalDirectiveFixture } from './helpers/directive-native-fixture.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';

/**
 * The text that sends Gru and the owner to the owner-approval route (#523, A14).
 *
 * This file imports only modules that exist on the base commit, and seeds its
 * requests without any helper the change adds, so on the base it runs and
 * fails by assertion (the old `confirm_intent` recipe, no new section), never
 * by an import or collection error. The `gc-523-approval-before` scope runs it
 * against a `git archive` of the base.
 */

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
const dbs: LedgerDb[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

const root = join(import.meta.dirname, '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf-8');

describe('owner approval - the text that sends Gru and the owner to the new route', () => {
  it('both unknown-custody cards ask for a proposal and carry no terminal recipe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-owner-approval-text-'));
    cleanupDirs.push(dir);
    mkdirSync(join(dir, 'wtroot'));
    const repo = makeFixtureRepo('oa-text');
    cleanupRepos.push(repo);
    const db = new LedgerDb(dir);
    dbs.push(db);
    const bus = new EventBus({});
    const ledger = new LedgerApi(db.handle, { bus });
    const notifications = new NotificationCenter({ ledger, bus });
    const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'), ledger);
    const seed = async (jobId: string, requestId: string): Promise<void> => {
      ledger.addJob({ id: jobId, repo: 'fixture-app', title: jobId, briefing: `briefing for ${jobId}` });
      ledger.setJobStatus(jobId, 'working');
      await worktrees.createJobWorktree({ repoPath: repo.path, jobId });
      ledger.beginDirectiveIntent({ jobId, directive: `repair ${jobId}`, holder: 'silas-ops', requestId });
      markHistoricalDirectiveFixture(ledger, requestId);
    };

    await seed('job-x1', 'req-x1');
    surfaceDirectiveRecovery({ ledger, notifications }, 'req-x1', 'restart interrupted the writer');
    const debtCard = ledger.findNotificationByKind('silas.directive-unreconciled.req-x1', 'active')!;
    // The terminal-job card is a different request's card: same kind, its own row.
    await seed('job-x2', 'req-x2');
    ledger.registerAgent({ id: 'minion-x2', role: 'minion', jobId: 'job-x2', sessionFile: join(dir, 'none-x2.jsonl') });
    ledger.setAgentState('minion-x2', 'idle');
    const sent = ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-x2', payload: { request_id: 'req-x2', minion_id: 'minion-x2' } });
    ledger.recordDirectiveAdmission({ requestId: 'req-x2', minionId: 'minion-x2', eventSeq: sent.seq });
    ledger.setJobStatus('job-x2', 'in-review');
    ledger.setJobStatus('job-x2', 'merged');
    observeTerminalJobDirective({ ledger, notifications } as unknown as Parameters<typeof observeTerminalJobDirective>[0], 'req-x2');
    const terminalCard = ledger.findNotificationByKind('silas.directive-unreconciled.req-x2', 'active')!;
    expect(terminalCard.id).not.toBe(debtCard.id);

    const cases = [
      ['debt', debtCard.detail ?? '', 'It needs the owner: '],
      ['terminal', terminalCard.detail ?? '', 'if its producer custody is unknown, '],
    ] as const;
    for (const [label, detail, marker] of cases) {
      expect(detail, label).toContain('POST /api/owner-approvals');
      expect(detail, label).toContain('ask the owner whether to abandon it');
      expect(detail, label).toContain('Never call /abandon yourself');
      expect(detail, label).not.toContain('confirm_intent');
      expect(detail, label).not.toContain('by "owner"');
      // The ask never spells the terminal URL. The same card still carries
      // the inspect/retire readback routes that are NOT this recipe (design 13
      // replaces only the parenthetical recipe), so the URL assertion is
      // scoped to the ask sentence, not the whole card.
      const ask = detail.slice(detail.indexOf(marker));
      expect(ask, label).toContain(marker);
      expect(ask, label).toContain('POST /api/owner-approvals');
      expect(ask, label).not.toContain('/api/silas/directives/');
      expect(ask, label).not.toContain('confirm_intent');
      expect(ask, label).not.toContain('by "owner"');
      // The inspect and retire lines stay.
      expect(detail, label).toContain('Inspect GET /api/silas/directives/');
    }
    expect(terminalCard.detail).toContain('/retire when the service can verify cessation');
  });

  it('roles/gru.md routes a directive request to the proposal and keeps the re-brief marker instruction', () => {
    const source = read('roles', 'gru.md').replace(/\s+/gu, ' ');
    expect(source).toContain('For a directive request, propose abandonment with `POST /api/owner-approvals`; the owner\'s Approve carries it out.');
    expect(source).toContain('For a re-brief marker, ask the owner whether to abandon it, quoting the card.');
    expect(source).toContain('Never call `/abandon`, record the owner\'s decision, or send owner attribution yourself.');
  });

  it('docs/DIRECTIVE-RECOVERY.md documents both routes, every state and every refusal code', () => {
    const doc = read('docs', 'DIRECTIVE-RECOVERY.md');
    expect(doc).toContain('### Owner approval of abandonment');
    expect(doc).toContain('POST /api/owner-approvals');
    expect(doc).toContain('GET /api/owner-approvals/{id}');
    expect(doc).toContain('POST /api/silas/directives/{request_id}/abandon');
    for (const state of ['proposed', 'approved', 'executing', 'succeeded', 'denied', 'refused', 'withdrawn']) {
      expect(doc, state).toContain(state);
    }
    for (const code of ['card-post-failed', 'decider-not-owner', 'abandoned-elsewhere', 'stale-fence', 'execution-error', 'service-not-hosted',
      'retirement_available', 'live_work', 'directive_not_live', 'request_mismatch', 'terminal_receipt_present']) {
      expect(doc, code).toContain(code);
    }
    expect(doc).toContain('expectedDecision');
    expect(doc).toContain('confirm_intent');
    expect(doc).toContain('C1');
  });

  it('docs/OPERATIONS.md points the unknown-custody sentence at the owner-approval section', () => {
    const operations = read('docs', 'OPERATIONS.md').replace(/\s+/gu, ' ');
    expect(operations).toContain('POST /api/owner-approvals');
    expect(operations).toContain('DIRECTIVE-RECOVERY.md#owner-approval-of-abandonment');
    expect(operations).toContain('DIRECTIVE-RECOVERY.md#owner-abandonment-unknown-custody');
  });
});
