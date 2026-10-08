# Interrupted-directive recovery (retirement) — activation runbook

Owner approval: journal j-1348 (build), corrections j-1345. This runbook
describes the ONE supported way to close an interrupted directive
request's control ownership, and the exact boundary between that closure
and everything it is NOT.

## What it is

An interrupted directive is a request whose prompt may have been delivered
and whose worker ceased mid-turn with no correlated terminal receipt
(`job.delivered`). The request stays live (`dispatching`/`admitted`),
fencing the lane's single-writer guard, review arming, digest offers and
phase completion. `settled` would fabricate a delivery; `failed` would
falsely claim no effect. The guarded retirement closes ONLY that request's
control ownership, after the service itself proves (fresh, server-side)
that no producer still owns the lane, and records exactly one audit event:
`silas.directive-retired`.

**It is not:** success, failure-with-no-effect, permission to resume,
authorization to integrate, a merge decision, or a way to erase history.
The underlying work remains unfinished; a later fresh, authorized request
is still required to touch the lane again.

## Supported predicates (server-verified; any unknown/stale/missing evidence refuses)

The route resolves the lane's checkout HEAD synchronously, then the
ledger re-checks durable producer facts and the binding expectations in
one transaction. No await separates the evidence read from the commit;
the caller supplies expectations only:

- **Lane identity/head**: exactly one non-swept job lane for the job, and
  its freshly resolved checkout `HEAD` must equal the caller's
  `expected_head` (a registered branch tip is not checkout evidence).
- **No open worker turn**: no agent of the job in `spawning`/`streaming`.
- **No queued producer**: no non-terminal child worker; no pace-gate
  worker turn queued for the job.
- **No in-flight admission**: no process-local admission reserved for the
  job (the boundary every producer crosses before its first await).
- **No re-brief**: no `pending_rebriefs` marker.
- **No other live directive**: no live request other than the subject.
- **No provider continuation**: no `provider_waits` row for the job in
  `waiting`/`recovered-pending`/`claimed`.
- **No verification producer**: no unsettled verification run.
- **No review/source ownership**: no `pending`/`live` review round.
- **No live lane process**: no `worktree_processes` row in `live` state
  for the job's lanes.
- **No correlated terminal receipt**: a `job.delivered` correlated to the
  request is refused (`terminal_receipt_present`) — normal settlement owns
  it.
- **Admission preservation**: a correlated `silas.directive-sent` is bound
  first through the existing validated transition (the row then reads
  `admitted-without-terminal`); an admission event without a minion
  identity fails closed (`admission_evidence_incomplete`).

## Calling it

`POST /api/silas/directives/{request_id}/retire` (bearer-authenticated,
same configured auth boundary as every Silas surface):

```json
{
  "expected_job_id": "dashboard-slim-strip-current-main-20261007",
  "expected_state": "dispatching",
  "expected_payload_hash": "<payload_hash from GET /api/silas/directives/{id}>",
  "expected_head": "2a37ffb26f9b1a90793b608aedb1e222f6ed7ee6",
  "reason": "service restart 00:37:49Z disposed the writer; no terminal receipt exists",
  "by": "silas-ops"
}
```

`expected_state` is the state the caller verified (`dispatching` or
`admitted`). Success returns 200 with `state: "retired"`,
`admission_class`, the preserved admission fields, the hold state, the
recorded `retire_expected_state`/`retire_expected_head`, and the closed
phase-handoff id (if one was attached). Replays with the identical
canonical intent return `idempotent: true` and append nothing; a
lost-response retry reconstructs the identical intent from the readback
(`retire_expected_state`, `retire_expected_head`, plus the already
exposed job/payload hash), and a replay of a phase-closing retirement
reports the same `phase_handoff_closed` id.

### Refusals (all leave the record byte-identical)

| HTTP | error | Meaning / next step |
|---|---|---|
| 400 | `bad_request` | malformed body/field; fix and resend |
| 401 | — | missing/wrong bearer token |
| 404 | `not_found` | unknown request id |
| 409 | `directive_not_live` | already settled/failed; use normal flows |
| 409 | `request_mismatch` | wrong job/state/payload hash; re-read the row |
| 409 | `stale_head` | lane head moved; re-verify cessation at the new head |
| 409 | `terminal_receipt_present` | correlated delivery exists; let settlement/reconcile own it |
| 409 | `admission_evidence_incomplete` | admission event without identity; reconcile the actual turn |
| 409 | `lane_unavailable` | no single live lane / unresolvable head; fail closed |
| 409 | `live_work` | blockers list names the live ownership; resolve it first |
| 409 | `retire_conflict` | already retired under a different intent; the recorded outcome stands |

## How a candidate surfaces

A retirement is never automatic; the operator side sees a candidate
through existing surfaces:

- the boot reconciler's action-required escalation for a live request
  with no terminal receipt (`reconcilePendingDirectives`, card kind
  `silas.directive-unreconciled.<request_id>`) — the same card the
  observed incident raised;
- the board's next action naming the live directive
  (`directive <id>: <state> (<job>)`), and the authenticated readback
  `GET /api/silas/directives/{request_id}`;
- the Silas digest, which suppresses offers while the request is live.

## After retirement: the continuation hold

Retirement leaves a durable continuation hold on the request row
(`hold_released_by` null). While open, it is a **runtime** fence — not an
attention card:

- branch-idle refuses review arm/freeze on the lane (`409 branch_busy`);
- the Silas digest offers no review/directive/stall, verification-repair,
  minion-error continuation or provider-recovery rows for the job;
- late provider recovery cannot claim/resume the lane or release the hold;
- the board's next action names the retirement.

The hold is released **only** by a fresh accepted directive request or
re-brief marker (the release record names that request/marker id). The
retired request id itself never re-runs and never releases the hold. A
hold on a job that later goes terminal is inert (terminal lanes accept no
work): it is not projected as board debt and cannot mask a newer live
hold.

## Proof identity to cite

- request id + accepted payload hash + expected/resolved lane head (the
  event payload carries `expected_head`, `lane_id`, `admission_class`,
  `admission_seq`, `admission_minion`, `by`, `reason`);
- event `silas.directive-retired` (exactly one per request);
- the row's `retired_at`/`retired_by`/`retire_reason`;
- the phase-handoff `closed` reason when one was attached.

## Explicit non-effects

Retirement never spawns/resumes a worker, never arms review, never
advances publication, never completes a phase, never clears owner stops
or decisions, never authorizes integration, never merges/deploys, and
never rewrites a terminal receipt or a late event. It does not modify
job status, obligations, approvals, reports, verification outcomes or
other jobs.

## Activation rules

- Per-case owner/authority decision (journal) required before calling it
  on any real request — there is no bulk mode, no `force` option and no
  age-based automatic policy; boot/tick reconcilers never retire.
- The activation this build ships is CODE + MIGRATION only: the schema
  migration applies at the next service boot under the owner's manual
  rollout. This build performed no live retirement, no migration against
  the production ledger and no service restart.
- A retired request cannot revive a merged/done/binned job, and it is
  excluded from boot/tick reconciliation and digest offers by state.
