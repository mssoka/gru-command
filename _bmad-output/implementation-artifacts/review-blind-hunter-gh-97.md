# Blind Hunter review prompt — gh-97 (filled per step-oneshot)

The oneshot workflow directs: when the runtime cannot launch subagents,
write the full prompt with placeholders filled here. Executor note: this
lane's minion runtime has no subagent spawn capability; the review below
was executed inline by the implementing agent against the final diff,
which is recorded as a limitation (the deployed native Perkins whole-PR
gate on the idle branch remains the independent review of record).

---

Conduct a review of the changed files in the current worktree
(`src/notifications/center.ts`, `test/notifications.test.ts`,
`test/supervisor.test.ts`, `test/suite-shape.test.ts` — 8.3 kB of diff).
Look for what's missing, not only what's wrong.
Compute your finding floor N from the size of the changes:
N = min(floor(sqrt(8.3) + 1), 10) = min(floor(2.88 + 1), 10) = 3.
Find at least 3 issues to fix or improve.
Output a Markdown list of findings only — no severity, priority, or
ranking. If you have zero findings, re-check and keep thinking; do not
stop with an empty list.

Do not invoke any skill, and do not spawn subagents of your own — you
are the reviewer.

---

## Inline execution record (2026-09-27, post-green)

Findings produced under this prompt by the implementing agent:

1. The fix conditions on `existing.ackedAt === null` but not on
   `existing.resolvedAt`; a resolved-but-unacked machine row under
   `dedupe: 'unacked'` cannot be returned (the mode filters
   `resolved_at IS NULL`), but under `dedupe: 'all'` a resolved
   machine row CAN be returned and would then be reused instead of
   honored — check whether any needs-owner caller uses `dedupe: 'all'`.
2. `post()` coerces owner-held kinds to `needs-owner`, so the fresh row
   for a `supervision.provider-wall.*` kind is always owner-held; but
   the mismatch branch also fires for NON-owner-held kinds requested as
   `needs-owner` (e.g. a hypothetical future caller) — verify no current
   caller relies on the old reuse for that combination.
3. The regression asserts `rows` has length 2 but does not pin WHICH row
   the breaker bound (`breakerNotificationId` is not observable in the
   view); the re-arm proof is indirect (ack of the fresh row closes the
   breaker) — consider whether an agent whose breaker was bound to the
   legacy id could also pass (it cannot: acking the legacy id throws,
   and only the acked id re-arms).
4. No test covers the `decisions.degraded.*` owner-held kind gaining the
   same fresh-row behavior (the only other `needs-owner` postIncident
   producer with legacy-row potential).
5. `test/suite-shape.test.ts` counts were hand-updated; confirm the
   derived counts match the actual combined tree (17/44) rather than
   trusting the edit.

Triage of these findings is recorded in the spec's Review Triage Log.
