# PR136 chief handoff — implementation review record (worker self-review)

Phase id: `pr136-chief-handoff-20261001`
Scope reviewed: the `pr136-chief-handoff` delta on branch
`gru/durable-blocked-followthrough`, commits `66ac377` (source) on top of
`5ccae79` (main integration) and `e28bcfe` (plan checkpoint).

## What ran, and what did not

- Ran in this session: whole-diff reads, static API/type reasoning, SQL and
  state-machine traces, adversarial pass over the acceptance criteria, and
  the deterministic tests WRITTEN (not executed).
- Did NOT run: independent BMAD review layers (no subagent capability in
  this worker session), `npm test`/lint/typecheck/build, any provider or
  live-service probe, any `/api/verify` run. Nothing in this document is a
  verification receipt; exact-head CI, focused/FULL `/api/verify` and
  native Perkins remain external gates owned by Silas/Perkins/ops.

## Findings: verified and fixed before/with this record

1. **Nullability hazard in the publish routine** — `finishPhaseHandoff`
   carried `obligationId` as `string | null` across the create-guard, so
   the later `settleObligation`/`suspendObligation` calls could not be
   proven non-null statically and would have been a type error. Fixed by
   deriving `const obligationId = obligation.id` after the guard; behaviour
   unchanged. Verified by reading the final function body.
2. **Failure handler could close a phase whose delivery had committed** —
   a post-delivery bookkeeping error rejects the same promise as a failed
   turn; closing an `awaiting` phase then would strand an already-committed
   delivery (the boot reconciler skips closed phases). Fixed with the
   `deliveredRecorded` flag: close only when no delivery was recorded.
   Verified by tracing both rejection sources.
3. **Older re-brief receipt could record against newer markers** — a
   re-brief turn in flight while a NEWER re-brief request replaced the
   marker pair would read the newer `phase_id` at finalize and could
   complete a newer phase from an older turn (acceptance E). Fixed with an
   `expectedPhaseId` fence in `finalizeRebriefRequest` (server and boot
   redispatch both pass it); the stale finalize records nothing, clears
   nothing, and logs; covered by the supersede test.
4. **Unvalidated `source` filter** in `listPhaseHandoffs` — a bad runtime
   value silently returned an empty page. Now fails loud like the states
   filter.
5. **Decision bound only at the HTTP parser** — `beginPhaseHandoff` now
   enforces the same 500-character bound for direct API callers.
6. **Duplicated comment block** in `server.ts` after the handoff edit —
   removed.
7. **Marker guard could be satisfied by an unrelated delivery** —
   `finalizeRebriefRequest`/`reconcilePendingRebriefs` treated ANY
   `job.delivered` (or `silas.rebrief`) event after the marker watermark as
   "the request's event". For a MARKED request, an unrelated delivery (for
   example the superseded phase's late receipt) could satisfy the marker
   while the phase-correlated delivery was never recorded — the marked
   phase would then never complete. Fixed with a phase-correlated marker
   predicate (`pendingRebriefGuardedEvent`); unmarked markers keep the
   legacy newest-event semantics. Found by tracing the supersede test;
   covered by its assertions.

## Findings checked and rejected (no change)

8. **Double publication between the marked and legacy observers** — the
   legacy observer skips any delivery naming an existing phase row, the
   phase observer publishes one stable-kind row with `dedupe: 'all'`, and
   the blocked-lane test asserts exactly one card. Verified by reading both
   paths and the test.
9. **Duplicate/out-of-order deliveries** — completion is one-shot per phase
   (`completePhaseHandoff` refuses a different second seq; same seq is
   idempotent), the obligation coalesces on the same incident key, and the
   notification kind is stable per phase. Verified by the crash-window test.
10. **Bounded event scans (1000 newest job events)** in the completion /
    re-brief request evidence lookups — adequate for the window they serve
    (the live observer is synchronous at append; the boot backstop runs
    immediately after a crash, when the relevant event is the newest one).
    Not a defect; the bound keeps reconciliation finite.
11. **Action-required card cannot be acked as a human** — `ack` throws for
    machine rows, so a shown/acked card can never erase the debt; only an
    explicit accepted-evidence settlement closes it. Verified by the
    disposition test and existing ledger behavior.

## Residual limits (declared, not papered over)

- A crash mid-dispatch after the intent and before any admission evidence
  leaves the phase `awaiting` with no fabricated success; no dispatch-lane
  provider recovery is added (wider runtime change — Gru decision if
  wanted). Recorded in plan §7 and deferred-work.
- `reconcilePendingRebriefs`' delivery-only branch can still append a
  `silas.rebrief-recovered` event for a marker group that was replaced
  mid-boot (history noise); the phase fence prevents any completion from
  it. Deferred.
- Shared-bearer attribution is unchanged: the intent is caller-supplied;
  everything that completes a phase (phase identity, admission, delivery
  correlation) is host-owned and ledger-validated, and completion is
  evidence, never approval.
