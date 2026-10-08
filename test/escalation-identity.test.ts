import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
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

  it('every wave escalation call site carries its bounded identity context — or is an explicit residual (A7/V1 table)', () => {
    // Twelve-followthrough A7/V1: context coverage is hand-maintained per
    // call site. This table enumerates every `this.opts.escalate?.()` site
    // in production with its expected context text, so dropping a context,
    // changing its identity fields, or adding an unclassed site fails here
    // instead of silently re-living the terminal-lane receipt defect.
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'dispatch', 'perkins.ts'), 'utf8');
    const file = ts.createSourceFile('perkins.ts', source, ts.ScriptTarget.Latest, true);
    const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const sites: { readonly title: string; readonly context: string | null }[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'escalate'
      ) {
        sites.push({
          title: normalize(node.arguments[0]!.getText()),
          context: node.arguments.length >= 3 ? normalize(node.arguments[2]!.getText()) : null,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    // 30 of 33 sites carry the bounded context; the three null rows are the
    // sanctioned residuals (shutdown deadline, live-process pause, sweep
    // error) that stay deliberately context-free and live (A7 rejection
    // stands; a worktree id is never coerced into a round identity).
    const expected: readonly (readonly [string, string | null])[] = [
      ['`Queued review handoff for job ${job.id} needs reconciliation`', '{ jobId: job.id }'],
      ['`Queued review handoff failed for job ${job.id}`', '{ jobId: job.id }'],
      ["'Perkins review shutdown deadline exceeded'", null],
      ['`Review round ${round.id} carries a posted verdict without a provider-bound receipt`', '{ jobId: round.jobId, roundId: round.id }'],
      ['`Review round ${round.id} is INCOMPLETE after service restart`', '{ jobId: round.jobId, roundId: round.id }'],
      ['`Review round ${String(lane.roundId)} could not be processed during startup recovery`', '{ ...(lane.jobId !== null ? { jobId: lane.jobId } : {}), ...(lane.roundId !== null ? { roundId: lane.roundId } : {}), }'],
      ['`Review round ${round.id} is INCOMPLETE after service restart`', '{ jobId: round.jobId, roundId: round.id }'],
      ['`Queued review handoff for job ${jobId} is held`', '{ jobId }'],
      ['`Queued review handoff failed for job ${jobId}`', '{ jobId }'],
      // Owner decision 2026-10-08: a transient refusal retries; only the
      // last refusal, or a retry that cannot run, is action-required.
      ['`Perkins review for job ${jobId} refused admission before any specialist started`', '{ jobId, roundId }'],
      ['`Automatic review retry for job ${jobId} crashed`', '{ jobId, roundId: current.roundId }'],
      ['`Automatic review retry for job ${jobId} could not start`', '{ jobId, roundId: retry.roundId }'],
      // Retries live in memory: one a restart interrupted escalates once.
      ['`Automatic review retry for job ${job.id} was interrupted by a restart`', '{ jobId: job.id, roundId: scheduled.roundId }'],
      ['`Review for job ${job.id} cannot gate: Perkins is unavailable and the fallback is not installed`', '{ jobId: job.id }'],
      ['`Perkins gate unavailable for job ${job.id} — the bmad-review gate is engaged`', '{ jobId: job.id }'],
      ['`bmad-review gate PASS for job ${job.id} — review/fix routing cleared (not a Perkins READY; merge stays user-held)`', '{ jobId: job.id }'],
      ['`bmad-review gate BLOCKED for job ${jobId}`', '{ jobId }'],
      ['`bmad-review gate ABORTED for job ${jobId}`', '{ jobId }'],
      ['`Perkins delta READY for job ${input.jobId} still owes its final whole-change pass`', '{ jobId: input.jobId, roundId: round.id }'],
      ['`Perkins review for job ${input.job.id} was blocked before any round: the PR head could not be verified`', '{ jobId: input.job.id }'],
      ['`Review round ${round.id} disposal failed after completion`', '{ jobId: job.id, roundId: round.id }'],
      ['`Review round ${round.id} is INCOMPLETE`', '{ jobId: job.id, roundId: round.id }'],
      ['`Perkins report for round ${round.id} reconciled a provider review but did NOT record it`', '{ jobId: round.jobId, roundId: round.id }'],
      ['`Perkins report for round ${round.id} was recorded but NOT posted safely to the pull request`', '{ jobId: round.jobId, roundId: round.id }'],
      ['`Perkins report for round ${round.id} was recorded but has NO pull request to publish to`', '{ jobId: round.jobId, roundId: round.id }'],
      ['`Perkins report for round ${round.id} was recorded but NOT posted to the pull request`', '{ jobId: round.jobId, roundId: round.id }'],
      ['`Perkins review for job ${job.id} deferred ${followupTitles.length} follow-up finding(s)`', '{ jobId: job.id, roundId: round.id }'],
      ['`Review round ${round.id} INCOMPLETE record event could not be persisted`', '{ jobId: job.id, roundId: round.id }'],
      ['`Review round ${round.id} is INCOMPLETE`', '{ jobId: job.id, roundId: round.id }'],
      ['`Review round ${round.id} finalization artifact failed after its verdict committed`', '{ jobId: job.id, roundId: round.id }'],
      ['`Review round ${round.id} is INCOMPLETE`', '{ jobId: job.id, roundId: round.id }'],
      ['`Review worktree for round ${worktreeId} paused on live processes`', null],
      ['`Review worktree for round ${worktreeId} could not be swept`', null],
    ];
    expect(sites.map((site) => [site.title, site.context])).toEqual(expected);
    expect(sites).toHaveLength(33);
    expect(sites.filter((site) => site.context !== null)).toHaveLength(30);
  });
});
