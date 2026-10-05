import type { LedgerApi } from '../ledger/api.js';
import type { EscalationContext } from './perkins.js';

/** The bounded ledger reads this seam may use to establish identity. */
type EscalationIdentityLedger = Pick<LedgerApi, 'getAgent' | 'getRound' | 'listAgents'>;

/** Resolve the `notification.agentId` binding for a wave escalation, or
 * null when no CONSISTENT real actor/job binding can be established.
 *
 * The row is never attributed to another job: absent context, an unknown
 * round, a contradictory job/round pair, an unknown actor, or an actor not
 * actually bound to the expected job all leave it unbound and live
 * (human-dispositioned). Context values are supplied by call sites that
 * already hold them; title/detail text is never parsed for identity. The
 * concrete-actor-only case (no job/round expectation) stays explicit: the
 * actor must exist, and the row's binding is whatever its own record says. */
export function resolveEscalationAgent(
  ledger: EscalationIdentityLedger,
  context: EscalationContext | undefined,
): string | null {
  if (context === undefined) return null;
  let roundJobId: string | null = null;
  if (context.roundId !== undefined) {
    roundJobId = ledger.getRound(context.roundId)?.jobId ?? null;
    // A supplied round is a claim of identity: an unknown round, or a round
    // that contradicts a supplied job, fails closed BEFORE any selection.
    if (roundJobId === null) return null;
    if (context.jobId !== undefined && context.jobId !== roundJobId) return null;
  }
  const jobId = context.jobId ?? roundJobId;
  if (context.agentId !== undefined) {
    const agent = ledger.getAgent(context.agentId);
    if (agent === null) return null;
    // The binding must be PROVED, not merely uncontradicted: when a job is
    // expected, the actor must actually be bound to it (a null job_id does
    // not pass). A known round with a matching job does not require the
    // actor's own roundId — a legitimate lane actor can carry a null round
    // while the context's round belongs to the same job (minion semantics).
    if (jobId !== null && agent.jobId !== jobId) return null;
    if (context.roundId !== undefined && agent.roundId !== null && agent.roundId !== context.roundId) return null;
    return agent.id;
  }
  if (jobId === null) return null;
  // Bind the lane's worker: the actor that must act on the alert, exactly
  // the producer pattern the other machine rows use. Selection follows
  // ledger.listAgents() order (most recently updated row first); any
  // same-job minion yields the same job-level receipt classification, so
  // a superseded-but-later-touched row stays job-correct. This seam
  // deliberately does not read supervision and must not grow an
  // unsupervised "current worker" guess (twelve-followthrough A2).
  // Issue #161: a tracked child is NOT the lane's writer — primary-minion
  // selection excludes children (legacy null parentage stays eligible).
  return ledger
    .listAgents()
    .find((agent) => agent.jobId === jobId && agent.role === 'minion' && agent.parentage !== 'child')?.id ?? null;
}

/** The notification surface this seam writes through. */
export interface ReviewEscalationPort {
  post(input: {
    readonly kind: 'review-escalation';
    readonly routing: 'action-required';
    readonly severity: 'error';
    readonly title: string;
    readonly detail: string;
    readonly agentId?: string | null;
  }): unknown;
}

/** Build the wave-escalation notifier. Routing, severity, content and the
 * unresolved lifecycle are exactly as before; the only addition is the
 * existing `agentId` binding when the hook's context establishes it. */
export function createReviewEscalationNotifier(
  ledger: EscalationIdentityLedger,
  notifications: ReviewEscalationPort,
): (title: string, detail: string, context?: EscalationContext) => void {
  return (title, detail, context) => {
    const agentId = resolveEscalationAgent(ledger, context);
    notifications.post({
      kind: 'review-escalation',
      routing: 'action-required',
      severity: 'error',
      title,
      detail,
      ...(agentId !== null ? { agentId } : {}),
    });
  };
}
