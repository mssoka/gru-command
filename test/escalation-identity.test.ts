import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    // A job-less actor (no job binding) proves the binding-required rule.
    ledger.registerAgent({ id: 'agent-unbound', role: 'minion' });
    const round = ledger.addRound({ jobId: 'job-a', lenses: ['blind'], targetRef: 'sha' });

    // No context, an empty context, an unknown actor, and a job with no
    // bound worker stay unbound.
    expect(resolveEscalationAgent(ledger, undefined)).toBeNull();
    expect(resolveEscalationAgent(ledger, {})).toBeNull();
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a' })).toBe('agent-a');
    expect(resolveEscalationAgent(ledger, { jobId: 'job-b' })).toBe('agent-b');
    expect(resolveEscalationAgent(ledger, { jobId: 'job-missing' })).toBeNull();
    expect(resolveEscalationAgent(ledger, { agentId: 'agent-ghost' })).toBeNull();
    // Round-only context resolves the round's job; a consistent job/round
    // pair works; a minion's own null round is legitimate for it.
    expect(resolveEscalationAgent(ledger, { roundId: round.id })).toBe('agent-a');
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a', roundId: round.id })).toBe('agent-a');
    // Unknown or foreign rounds fail closed BEFORE selection — with or
    // without a job, with or without an actor (A0/E0/V2).
    expect(resolveEscalationAgent(ledger, { roundId: 'no-such-round' })).toBeNull();
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a', roundId: 'no-such-round' })).toBeNull();
    expect(resolveEscalationAgent(ledger, { jobId: 'job-b', roundId: round.id })).toBeNull();
    expect(resolveEscalationAgent(ledger, { jobId: 'job-b', roundId: round.id, agentId: 'agent-b' })).toBeNull();
    expect(resolveEscalationAgent(ledger, { jobId: 'job-b', roundId: round.id, agentId: 'agent-a' })).toBeNull();
    // Known mismatches are refused, never cross-job attributed.
    expect(resolveEscalationAgent(ledger, { jobId: 'job-b', agentId: 'agent-a' })).toBeNull();
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a', roundId: round.id, agentId: 'agent-b' })).toBeNull();
    // A known job requires the actor to be actually bound: a job-less actor
    // cannot pass as merely uncontradicted (A1)...
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a', agentId: 'agent-unbound' })).toBeNull();
    // ...while the concrete-actor-only case stays explicitly separate.
    expect(resolveEscalationAgent(ledger, { agentId: 'agent-unbound' })).toBe('agent-unbound');
    // A matching actor bound to the expected job resolves.
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a', agentId: 'agent-a' })).toBe('agent-a');
    expect(resolveEscalationAgent(ledger, { jobId: 'job-a', roundId: round.id, agentId: 'agent-a' })).toBe('agent-a');
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

  it('context-free sweep-style alerts stay unbound and live even on a terminal lane (residual pin)', () => {
    const ledger = fresh();
    seedLane(ledger, 'job-review-lane', 'agent-lane');
    seedLane(ledger, 'job-job-lane', 'agent-job');
    const posts: Array<{ title: string; agentId?: string | null }> = [];
    const notify = createReviewEscalationNotifier(ledger, {
      post(input) {
        posts.push(input);
        return input;
      },
    });
    // Both review- and job-kind worktree sweep alerts are deliberately
    // context-free: a live-process pause requires a human ruling and must
    // never become a terminal-lane closed receipt (A7 proposal rejected;
    // the aggregate shutdown-deadline alert is likewise context-free).
    notify('Review worktree for round X paused on live processes', 'human ruling required');
    notify('Review worktree for round Y could not be swept', 'sweep error');
    ledger.setJobStatus('job-review-lane', 'working');
    ledger.setJobStatus('job-review-lane', 'done');
    notify('Review worktree for round X paused on live processes', 'lane now terminal');
    expect(posts.map((post) => post.agentId)).toEqual([undefined, undefined, undefined]);
    // Context-free resolution stays unbound regardless of any lane status.
    expect(resolveEscalationAgent(ledger, undefined)).toBeNull();
    expect(resolveEscalationAgent(ledger, {})).toBeNull();
    // And a worktree id must never be coerced into a round id: passing a
    // job/ recovery worktree id as {roundId} is an unknown round and fails
    // closed on both kinds (A7 rejected: no sweep identity binding).
    expect(resolveEscalationAgent(ledger, { roundId: 'job-job-lane' })).toBeNull();
    expect(resolveEscalationAgent(ledger, { roundId: 'job-review-lane' })).toBeNull();
  });

  it('the main assembly wires the review-escalation notifier (assembly alarm)', () => {
    // V0: factory-only tests cannot catch a replaced main wiring; this is
    // the repo's established source-drift alarm pattern.
    const mainSource = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(mainSource).toMatch(
      /import\s*\{[^}]*\bcreateReviewEscalationNotifier\b[^}]*\}\s*from\s*'\.\/dispatch\/escalation-identity\.js'/,
    );
    expect(mainSource).toMatch(/escalate:\s*createReviewEscalationNotifier\(\s*ledger\s*,\s*notifications\s*\)/);
  });
});
