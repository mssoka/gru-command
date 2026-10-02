# PR136 r4 repair — plan and repair record

Phase id: `pr136-r4-repair-20261002`
Job: `durable-blocked-followthrough` — branch `gru/durable-blocked-followthrough` — PR #136 (open, non-draft)
Frozen target under repair: `1308956cdbfd8abc743fcee7bcb4f437af841950` (native r4 NEEDS CHANGES)
Complete report: `~/.gru-command/reviews/durable-blocked-followthrough-r4/perkins-report.md`
Chief staged handoff: `~/.gru-command/investigations/pr136-r4-sweep-pause-20261002T1637Z/source-followthrough.staged.md`

This is the ordinary single-writer repair loop on the existing authorized
job/branch/PR. No restart recovery, no replay, no new lane. Prior 0/2
findings were fixed; prior 1 retains only the caller-provenance version
validation residual as a NONBLOCKING note (the version string on an
obligation authority is caller-supplied provenance; request existence/job/
admitted-settled state ARE validated). The three r4 blockers below are
corrected in this delta.

## Blocker 1 — fulfilled-but-error turns published as completed marked phases

**Defect.** Both adapters settle a fulfilled prompt even when the turn ended
in an in-band error (Claude `result.isError` resolves with error state; Pi
surfaces assistant `stopReason: 'error'` and still resolves). The dispatch,
directive and re-brief producers treated resolution as success: they stamped
phase-tagged deliveries, and the completion gate checked identity/admission,
never the turn outcome — so an error-only audit could publish a completed
phase.

**Repair (no new runtime interface; the runtime's own terminal evidence).**
- `src/dispatch/fix-directive.ts` — `promptTerminalVerdict(handle)` reads
  the handle's health at settle; `state === 'error'` is a failed turn;
  an unreadable health is unproven (fail closed, never success).
  `routeFixDirectiveToMinion` and `rebriefFreshMinion` return the typed
  `outcome: 'completed' | 'error'` for the settled turn. (`outcome` is
  additive to the existing return shapes.)
- `src/dispatch/service.ts` — the dispatch fulfillment path checks the
  verdict before recording anything; a failed turn takes the SAME path as a
  rejected prompt (`recordTurnFailure`: durable `job.minion-error`, lane
  blocked, awaiting guard row closed only when no delivery was recorded).
- `src/dispatch/server.ts` — the directive path records admission evidence
  (the prompt WAS admitted) but NO delivery and NO phase completion; the
  request stays `admitted` with a durable reconcile note, so the boot
  reconciler escalates it for a Gru reconciliation. The re-brief path
  records `job.minion-error` and keeps the durable marker pair pending for
  the existing recovery ladder; it answers 202 `state: 'turn-error'` — no
  `silas.rebrief`, no delivery, no completion.
- `src/dispatch/rebrief-recovery.ts` — a recovery turn that resolves with an
  in-band error is a failed turn: it takes the resume/fresh/escalate ladder,
  never records guarded events.

## Blocker 2 — unmarked hand-backs lost across the two crash windows

**Defect.** The legacy event-sequence hand-back (`phase-handback@<seq>` +
`silas.phase-handback.<job>@<seq>`) is written by the live bus observer,
which runs after the delivery commit. (a) A crash between delivery commit
and observer write loses the debt AND the card; the phase reconciler has no
phase row, and boot adoption skips lanes that already have obligation
history. (b) A crash between the obligation write and the notification
loses the card; no unmarked publication marker existed.

**Repair.**
- `src/ledger/api.ts` — `listUnmarkedHandbackDeliveries(limit)` (window a:
  follow-up `job.delivered` events on still-blocked lanes with no
  `phase-handback@<seq>` obligation; deliveries owned by an existing phase
  row are excluded) and `listHandbacksMissingCards(limit)` (window b: live
  `phase-handback@` obligations with no stable-kind notification row).
  Both candidate sets drop rows as they are processed, so bounded passes
  reach the tail.
- `src/dispatch/obligations.ts` — the live observer and the boot backstop
  now ride ONE `recordUnmarkedHandback`/`publishUnmarkedHandbackCard` pair:
  the obligation upsert is idempotent by event identity, and a card row of
  the stable kind — unacked, acked or resolved — is never re-posted.
  `reconcileUnmarkedHandbacks` recovers both windows; nothing spawns a
  worker, rings the owner or mints a fresh alert id.
- `src/main.ts` — the unmarked backstop runs at boot after the phase sweep
  and before adoption (a recovered specific debt beats generic triage).

## Blocker 3 — the phase reconciler starved rows beyond its reset scan budget

**Defect.** Every pass listed `awaiting` + `completed` rows oldest-first and
stopped after 200 x 20 rows; already-published completed rows never left the
scan set, so a fixed prefix consumed the whole budget on every restart and a
later owed decision was never reached.

**Repair.**
- `src/ledger/api.ts` — `listPhaseHandoffs({ needsAction: true })` narrows
  to rows a pass can move: `awaiting`, or `completed` missing its obligation
  or card. Satisfied publication history is excluded BY the query.
- `src/ledger/db.ts` — migration 12 `reconcile_cursors` (scope, cursor,
  updated_at); `readReconcileCursor`/`writeReconcileCursor` are the only
  accessors.
- `src/dispatch/obligations.ts` — `reconcilePhaseHandoffs` reads actionable
  rows only and persists a durable round-robin cursor: a pass that exhausts
  its page budget resumes at its last examined rowid; a pass that reaches
  the end wraps to the first row. Every actionable row is examined within a
  bounded number of passes regardless of published history size.

## Deterministic regressions (no clocks/providers/live notices)

- `test/phase-handoffs.test.ts` (+2):
  - a fulfilled-but-error dispatch turn closes its marked phase, blocks the
    lane, records `job.minion-error`, publishes no card and cannot be
    completed by the boot pass;
  - a bounded pass makes fair progress past 4,000 satisfied published rows
    and across successive one-row passes (each actionable row examined
    exactly once; owed cards eventually publish).
- `test/obligations-handback.test.ts` (+3): window a recovery exactly once
  without a worker turn; window b recovery (the observer crashes between the
  obligation write and the notification); marked deliveries / unblocked
  lanes are left to their own owners.
- `test/dispatch-server.test.ts` (+2): HTTP-level marked directive and
  marked re-brief in-band-error paths — admission without delivery, markers
  kept, phase awaiting, no hand-back card.
- `test/rebrief-recovery.test.ts` (+1): an in-band-error recovery turn keeps
  the markers and posts the bounded action-required escalation.
- `test/suite-shape.test.ts`: exact count pins bumped.

## Preserved boundaries

- No new runtime attestation interface, no provider recovery, no second
  scheduler/watcher/wake path; the existing boot coordinator, ledger,
  EventBus and `NotificationCenter` action-required path carry everything.
- No merge/deploy/restart/migration activation, no owner ACK, no live
  notices. Owner stops, terminal/parked guards and the marked-path
  single-card discipline are unchanged.
- Known residual (nonblocking, from prior 1): obligation `authority.version`
  is caller-supplied provenance; request existence/job/admitted-settled
  state are validated against ledger facts.
