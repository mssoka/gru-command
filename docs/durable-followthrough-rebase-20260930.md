# Durable follow-through — merge-wave reconciliation

PR #136 remains the delivery lane; this is integration of already-landed
main, not a new authorization or a replay of an earlier source phase.

## Preserved work and refs

- Original lane/remote head: `a73aee32d2643f75b15a517967f06cf19b25a31a`.
- Original base: `ded08be312ab20d47159db638cb7787505b49fc8`.
- Reconciled base: `c54bfbf89727bacfd27a27db65a9fab681c19c3e`
  (includes owner-merged #140, #131 and #133).
- Rebased implementation/fix tip, before this receipt commit:
  `81516c3d7fa9e8db79f05273d8394debe8f0dbae`.
- Safety ref: `refs/backup/job-durable-blocked-followthrough/pre-rebase-wave2`
  retains the original head. The earlier safety ref remains unchanged.
- No lane-local uncommitted product WIP was present. Ignored planning
  artifacts were retained; the unrelated existing stash was not applied,
  changed or dropped. No other checkout was edited.

## Resolutions

- `docs/LEDGER.md`: retain main's residency/review-handoff custom-event
  section and the lane's E9 obligation/directive section, including the
  evidence-honest r1 repairs.
- `test/suite-shape.test.ts`: retain main's pins (including
  `perkins-builtin-wave` 88 and `dispatch-server` 20), plus lane pins
  `directive-markers` 14, `ledger-obligations` 26 and
  `obligations-handback` 5. No tests or thresholds were weakened.
- Auto-merges in `fix-directive.ts`, `server.ts`, `main.ts` and the dispatch
  server tests retain main's eviction-safe routing, queued review receipts,
  residency/quiescence observation and deterministic handoff reconciliation
  alongside the lane's correlated directive receipts and hand-back observer.
- `git range-diff` retains all five lane commits: the two ledger commits
  have identical patches; the other differences are documentation placement
  and main-side test-pin/context changes. `git diff --check` passes.

## Gates, not delivery claims

- Before the local rebase, the latest native round was r3, settled approved
  on the **old** head `a73aee3`. That is historical evidence, not approval
  of this rewritten head. Recheck for a live round before publication;
  if one is live, defer the head move until it settles.
- Local lint/typecheck/build/tests have not been run for this candidate:
  no current coordinated media-safe checkpoint has been supplied. Request
  the existing `/api/verify` full scope only after that checkpoint and a
  fresh free-disk check (at least 36 GiB). Keep the complete stream and
  actual nested `outcome.exitCode`; stop on failure, without subset retries.
- Exact-head CI, independent final-diff BMAD and fresh native Perkins
  readiness remain separate gates. Do not rerun the initial BMAD build or
  reinstall/bypass its historical trust failure; the phase-2 ruling
  explicitly preserved that failure. Any necessary trust recovery belongs
  to Gru's ruling, not an author workaround.
- This rebase does not expand the released slice into deferred awareness,
  provider recovery, pipeline scheduling or board-projection work. No claim
  is made that the whole original undertaking is finished or deployed.
- Next Gru decision: coordinate the full verification checkpoint and
  independent final-diff review, then have Silas admit the required native
  round on the published head after the implementing minion is quiescent.
  Owner still controls merge, deployment and restart.
