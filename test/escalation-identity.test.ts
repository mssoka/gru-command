import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import {
  createReviewEscalationNotifier,
  resolveEscalationAgent,
  type ReviewEscalationPort,
} from '../src/dispatch/escalation-identity.js';

const dbs: LedgerDb[] = [];
const dirs: string[] = [];
function fresh(): LedgerApi {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-escalation-identity-'));
  dirs.push(dir);
  const db = new LedgerDb(dir);
  dbs.push(db);
  return new LedgerApi(db.handle, { bus: new EventBus() });
}
afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seedLane(ledger: LedgerApi, jobId: string, agentId: string): void {
  ledger.addJob({ id: jobId, repo: 'fixture', title: jobId, briefing: 'b' });
  ledger.setJobStatus(jobId, 'working');
  ledger.registerAgent({ id: agentId, role: 'minion', jobId });
}

describe('wave escalation identity (A4 owner-approved extension)', () => {
  it('resolves a lane worker only from consistent, real identity — never cross-job', () => {
    const ledger = fresh();
    seedLane(ledger, 'job-a', 'agent-a');
    seedLane(ledger, 'job-b', 'agent-b');
    const round = ledger.addRound({ jobId: 'job-a', lenses: ['blind'], targetRef: 'sha' });

    // No context, an unknown actor, and a job with no bound worker stay unbound.
    expect(resolveEscalationAgent(ledger, undefined)).toBeNull();
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a' })).toBe('agent-a');
    expect(resolveEscalationAgent(ledger, { jobId: 'job-b' })).toBe('agent-b');
    expect(resolveEscalationAgent(ledger, { jobId: 'job-missing' })).toBeNull();
    expect(resolveEscalationAgent(ledger, { agentId: 'agent-ghost' })).toBeNull();
    // Round-only context resolves the round's job; a consistent job/round pair works.
    expect(resolveEscalationAgent(ledger, { roundId: round.id })).toBe('agent-a');
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a', roundId: round.id })).toBe('agent-a');
    // Contradictions are refused, never attributed to another job.
    expect(resolveEscalationAgent(ledger, { jobId: 'job-b', agentId: 'agent-a' })).toBeNull();
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a', roundId: round.id, agentId: 'agent-b' })).toBeNull();
  });

  it('the notifier keeps the alert contract and adds only the existing agentId binding', () => {
    const ledger = fresh();
    seedLane(ledger, 'job-a', 'agent-a');
    const center = new NotificationCenter({ ledger, bus: new EventBus() });
    const notify = createReviewEscalationNotifier(ledger, center);

    notify('Review round job-a-r1 is INCOMPLETE', 'required proof did not complete', { jobId: 'job-a' });
    const row = ledger.listNotifications()[0]!;
    expect(row).toMatchObject({
      kind: 'review-escalation',
      routing: 'action-required',
      severity: 'error',
      title: 'Review round job-a-r1 is INCOMPLETE',
      detail: 'required proof did not complete',
      agentId: 'agent-a',
      ackedAt: null,
      resolvedAt: null,
    });
  });

  it('absent or contradictory identity posts the unchanged alert unbound — never vanishing', () => {
    const ledger = fresh();
    seedLane(ledger, 'job-a', 'agent-a');
    seedLane(ledger, 'job-b', 'agent-b');
    const posts: Array<{ kind: string; routing: string; severity: string; title: string; agentId?: string | null }> = [];
    const port: ReviewEscalationPort = {
      post(input) {
        posts.push(input);
        return input;
      },
    };
    const notify = createReviewEscalationNotifier(ledger, port);

    notify('no context', 'd');
    notify('contradiction', 'd', { jobId: 'job-b', agentId: 'agent-a' });
    notify('unknown actor', 'd', { jobId: 'job-a', agentId: 'agent-ghost' });
    expect(posts).toHaveLength(3);
    for (const post of posts) {
      expect(post.kind).toBe('review-escalation');
      expect(post.routing).toBe('action-required');
      expect(post.severity).toBe('error');
      expect('agentId' in post).toBe(false);
    }
  });

  it('successive events from different jobs never share identity', () => {
    const ledger = fresh();
    seedLane(ledger, 'job-a', 'agent-a');
    seedLane(ledger, 'job-b', 'agent-b');
    const posts: Array<{ title: string; agentId?: string | null }> = [];
    const notify = createReviewEscalationNotifier(ledger, {
      post(input) {
        posts.push(input);
        return input;
      },
    });

    notify('a', 'd', { jobId: 'job-a' });
    notify('b', 'd', { jobId: 'job-b' });
    notify('b again', 'd', { jobId: 'job-b', agentId: 'agent-b' });
    expect(posts.map((post) => post.agentId)).toEqual(['agent-a', 'agent-b', 'agent-b']);
  });
});
