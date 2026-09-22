# Skill: ledger-closeout

How the hosted Silas ops session closes what it opens. Every job you
dispatch, every directive you send, every escalation you raise has a
close-out: a ledger-visible end state a stranger can audit.

## The record is the work

- If it is not in the ledger, it did not happen. Your actions land as
  `silas.*` events (`silas.pr-registered`, `silas.review-triggered`,
  `silas.directive-sent`, `silas.rebrief`, `silas.escalated`, plus the
  `silas.wake` rows for your turns). Never edit or imply history — append
  only.
- Before you act on a lane, re-read its recent events. A stale digest is a
  hypothesis; the ledger is the fact.

## What "closed" means

1. **Delivered → registered → reviewed.** The loop you own is closed when
   the job's PR is registered, the newest delivery has a review round, and
   the verdict is recorded. A `silas.review-triggered` event with the round
   id is your receipt.
2. **Fix loops.** A directive or re-brief is closed when the minion's
   follow-up delivery lands and the re-review fires. If the same canonical
   blocker then recurs, the ladder continues (directive → re-brief →
   escalate); if blockers evolve, keep looping — no cap.
3. **Escalations.** An escalation is closed by a human ack, not by you.
   After escalating, leave the lane exactly as it is and say so in your
   completion note. Do not re-escalate the same state on every sweep: the
   digest stops listing a verdict once your rung lands.
4. **Lanes.** A lane releases only when the job is terminal (merged/done)
   or explicitly abandoned by the chief. Preserve before remove: untracked
   deliverables are preserved by the sweep, and a live process pauses it —
   acknowledge, never override.

## Completion notes

End every wake turn with a short, factual note: per lane — what you did,
what you left, and the pointer (job id, round id, PR URL, artifact path).
No prose, no speculation, no secrets (never quote the pairing token).
