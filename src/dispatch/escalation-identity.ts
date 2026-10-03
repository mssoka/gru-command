import type { LedgerApi } from '../ledger/api.js';
import type { EscalationContext } from './perkins.js';

/** The bounded ledger reads this seam may use to establish identity. */
type EscalationIdentityLedger = Pick<LedgerApi, 'getAgent' | 'getRound' | 'listAgents'>;

/** Resolve the `notification.agentId` binding for a wave escalation, or
 * null when no CONSISTENT real actor/job binding can be established.
 *
 * The row is never attributed to another job: absent context, an unknown
 * actor, or contradictory job/round identity leaves it unbound and live
 * (human-dispositioned). Context values are supplied by call sites that
 * already hold them; title/detail text is never parsed for identity.
 */
export function resolveEscalationAgent(
  ledger: EscalationIdentityLedger,
  context: EscalationContext | undefined,
): string | null {
  if (context === undefined) return null;
  const roundJobId =
    context.roundId !== undefined ? ledger.getRound(context.roundId)?.jobId ?? null : null;
  const jobId = context.jobId ?? roundJobId;
  if (context.agentId !== undefined) {
    const agent = ledger.getAgent(context.agentId);
    if (agent === null) return null;
    if (jobId !== null && agent.jobId !== null && agent.jobId !== jobId) return null;
    if (context.roundId !== undefined && agent.roundId !== null && agent.roundId !== context.roundId) return null;
    return agent.id;
  }
  if (jobId === null) return null;
  // Bind the lane's current worker: the actor that must act on the alert,
  // exactly the producer pattern the other machine rows use.
  return ledger.listAgents().find((agent) => agent.jobId === jobId && agent.role === 'minion')?.id ?? null;
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
