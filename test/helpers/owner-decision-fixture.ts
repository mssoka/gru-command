/**
 * The shared owner-decision fixture (issue #570).
 *
 * Every owner card has to state a recommendation and what happens if the
 * owner does nothing, and its owner-facing text has to read plainly — so the
 * fixture is written once, valid by construction, and each test overrides the
 * field it is actually about. Without it, one boundary change rewrites a
 * dozen unrelated literals.
 */
import type { NotificationDecision } from '../../src/ledger/notification-decision.js';

export function ownerDecisionFixture(overrides: Partial<NotificationDecision> = {}): NotificationDecision {
  return {
    question: 'Approve the slim contract?',
    context: 'The agreed product scope would change, and that is your call.',
    recommendation: 'Approve the slim contract.',
    ifNothing: 'If you do nothing, nothing changes and the scope stays as it is.',
    reservedClass: 'scope-design',
    whyNotDelegable: 'It changes the agreed product scope, which is the owner’s call.',
    options: [
      { id: 'approve', label: 'Approve the slim contract', consequence: 'Gru starts the slim plan and reports back.' },
      { id: 'keep', label: 'Keep the current approach', consequence: 'Nothing changes; the work stays parked.' },
    ],
    discussion: false,
    ...overrides,
  };
}
