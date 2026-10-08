---
title: 'Guarded interrupted-directive recovery'
type: 'feature'
created: '2026-10-08'
status: 'in-review'
route: 'dispatch'
baseline_commit: '52ae3f1ce88ccfd0d0095f99fb8f51db67a88a62'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/LEDGER.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Silas directive whose prompt was provably delivered and whose worker
ceased mid-turn — service restart, crash, disposed actor — with no correlated
terminal receipt has no truthful terminal path. `settled` would fabricate a
delivery, `failed` is semantically false ("no effect" is disproven), and the live
`dispatching`/`admitted` row fences the lane's single-writer guard, review arming,
digest offers and phase completion forever. The owner-approved repair (j-1345
corrections, j-1348 build authority) must close only that request's control
ownership, audibly, without claiming success, no-effect, or permission.

**Approach:** Add one terminal directive state `retired` and one authenticated,
evidence-fenced transition `retireInterruptedDirective` exposed as
`POST /api/silas/directives/{request_id}/retire`. The service itself re-derives a
fresh, identity-bound cessation predicate from durable marks + the live lane head;
the caller supplies only binding expectations (job, state, payload hash, head) and
audit labels. The transition appends exactly one `silas.directive-retired` audit
event, preserves any admission evidence (upgrading `dispatching` with a correlated
`silas.directive-sent` to `admitted`), creates a durable continuation hold that
consumers enforce (`laneIsBusy`, digest fences, board next action), and closes (never
completes) an awaiting phase handoff attached to the request. The hold is released
only by a fresh accepted directive/re-brief request. No spawn, no review arm, no
publication, no owner-stop change, no consumed-id revival.

## Boundaries & Constraints

**Always:** Evidence is collected and re-verified server-side inside the state
transaction; caller booleans/labels/hashes alone never release. Unknown, stale,
missing, inaccessible or inconsistent evidence fails closed with a typed refusal
that changes nothing. One audit event per logical retirement; replays are idempotent
by canonical input fingerprint; conflicting intent or stale state is refused.
Preserve request id, payload, admission evidence and missing-terminal facts.
Keep control closure, successful work, permission, and merge/deployment strictly
separate in every readback/event/runbook. Existing auth boundary only.

**Never:** No fabricated `silas.directive-sent` / `job.delivered` /
`silas.directive-settled` / `silas.directive-failed`. No force option, no bulk
retirement, no age-only automatic policy, no boot/tick auto-retirement. No
automatic worker spawn/resume, review offer/arm, publication advance, phase
completion, owner-stop clearing, integration authorization, or reuse of a consumed
request id. No job status / obligation / approval / report / verification / other-job
mutation. No new dependencies, no direct production DB writes, no live-request
retirement or migration execution as part of development. No merge, deploy or restart.

</frozen-after-approval>

## Code Map

- `src/ledger/directives.ts` — states; add `'retired'`, terminal helper, admission-class helper, record + hold types, shared `DirectiveRetirementError` vocabulary.
- `src/ledger/db.ts` — migration 23 `directive-retirement`: nullable columns on `pending_directives` (`retired_at`, `retired_by`, `retire_reason`, `retire_fingerprint`, `hold_released_by`, `hold_released_at`) + hold index. Existing per-table column additions are the established pattern (e.g. migrations 9/21/22).
- `src/ledger/api.ts` — directive block (~6449-6740) owns `beginDirectiveIntent` / `recordDirectiveAdmission` / `recordDirectiveDelivery` / `failDirective` / `recordDirectiveReconcile`; add `retireInterruptedDirective`, `listDirectiveRecoveryHolds`, `hasOpenDirectiveRecoveryHold`, `listOpenProviderWaitsForJob`, `listJobAdmissions`; extend `directiveFromRow`; release holds in `beginDirectiveIntent` (created path) and `beginPendingRebrief` (~3332); reuse `terminalLiveWorkBlockers` vocabulary (~1889) for refusal shape; `closePhaseHandoff` (~6349) for the awaiting phase.
- `src/dispatch/directive-recovery.ts` (new) — orchestration: replay short-circuit, job-lane resolution (`listWorktrees({jobId})`, kind `job`, non-swept), fresh head via `resolveGitCommit` (`src/dispatch/perkins-review/artifacts.ts:154`), then the ledger transition; typed refusals mapped by the route.
- `src/dispatch/server.ts` — route next to the directive block (~984-1310); readback `states` map; auth via `authed`, ops via `silasOpsOr503`.
- `src/dispatch/branch-idle.ts` — `BranchIdleLedger` + `laneIsBusy` (~247-280): an open recovery hold fences the lane.
- `src/dispatch/silas-driver.ts` — four live-directive fence sites (1161, 1359, 1839, 1853) + ledger Pick (~296): hold fences offers/stall/conflict rows.
- `src/board/engine.ts` — `nextActionProjection` (~935): show an open hold after live debt.
- `test/directive-retirement.test.ts` (new) — full acceptance matrix through the real route + real `LedgerApi` + `InMemoryWorktreePort` + fixture git repo (harness pattern: `test/dispatch-server.test.ts`).
- `test/ledger-db.test.ts` — pre-migration upgrade case for the new columns.
- `docs/LEDGER.md`, `docs/DIRECTIVE-RECOVERY.md` (new) — state table and owner runbook.

## Tasks & Acceptance

**Execution:**
- [x] `src/ledger/directives.ts` — add `retired` state, terminal/admission-class helpers, record fields, hold record, `DirectiveRetirementError` — one shared vocabulary.
- [x] `src/ledger/db.ts` — migration 23 with the six nullable columns + hold index — additive, boot-applied, never executed against production here.
- [x] `src/ledger/api.ts` — `retireInterruptedDirective` (single transaction: expected-field checks, blocker re-check, admission preservation, state flip, ONE event, hold write, awaiting-phase close), hold queries, job-scoped provider-wait query, admission accessor, release-on-acceptance, terminal guards on `failDirective`/`recordDirectiveReconcile` — atomic audit truth.
- [x] `src/dispatch/directive-recovery.ts` — lane/head evidence orchestration + replay path — route stays thin.
- [x] `src/dispatch/server.ts` — POST route + readback fields — authenticated boundary.
- [x] `src/dispatch/branch-idle.ts`, `src/dispatch/silas-driver.ts`, `src/board/engine.ts` — enforce the hold — no automatic follow-through.
- [x] `test/directive-retirement.test.ts`, `test/ledger-db.test.ts` — deterministic fail-before/pass-after matrix (below).
- [x] `docs/LEDGER.md`, `docs/DIRECTIVE-RECOVERY.md` — readback truth + activation/runbook.

**Acceptance Criteria:**
- Given a live `dispatching` request with a ceased writer and an existing lane, when the retirement route is called with matching expectations, then state becomes `retired`, exactly one `silas.directive-retired` event exists, admission class is `admission-unknown`, a hold is open, and no sent/delivered/settled/failed/job/obligation/other-request evidence changed.
- Given a live `admitted` request (correlated sent) without delivery, when retired, then admission_seq/minion are preserved and class is `admitted-without-terminal`; a correlated `job.delivered` instead refuses (`terminal_receipt_present`) so normal settlement owns it; an unbound correlated sent is bound first, not discarded.
- Given malformed/unauthenticated/wrong-identity/stale-head/stale-state/conflicting-replay input, when called, then the typed refusal (400/401/404/409) leaves the row, events, hold and phase handoff byte-identical.
- Given any open producer evidence — live `spawning`/`streaming` agent, non-terminal child worker, in-flight admission, pending re-brief, open provider wait (waiting/recovered-pending/claimed), unsettled verification run, live/pending review round, or live lane process — when called, then `live_work` refusal names it and nothing changes; removing that evidence makes the same call succeed.
- Given a retirement with an awaiting phase handoff, when it commits, then the handoff is `closed` (not completed), no completion/obligation/notification was minted, and a forced failure mid-transaction rolls back the row, event, hold and phase close together.
- Given an already-retired request, when replayed with identical canonical input, then 200 `idempotent:true` and no second event; different input → 409; a late `job.delivered`/failure/admission event or a replay of the consumed id changes nothing.
- Given a retirement, when consumers run, then the lane stays fenced (branch-idle review arm refuses, digest offers/stall suppressed, board shows the open hold), no spawn/review/phase event occurs; a fresh accepted directive or re-brief releases the hold by its own identity, and boot/tick reconcilers and a re-opened database read the same truth.

## Implementation Notes

Implementation status 2026-10-08: all tasks complete; focused verification green (new matrix 30 tests; ledger-db upgrade 9; directive-markers 14; durable-reconcile 13; branch-idle-guard heavy 46; dispatch-server heavy 61; board suites 90; typecheck + lint clean). No I/O matrix row exists in this spec; the acceptance criteria are covered by the named suite. Review commissioned as tracked dispatch review jobs at the pushed head; full `/api/verify` capture follows the exact final head.

(Autonomous lane note, 2026-10-08: owner approval j-1348 + this dispatch already approve the
whole build; the step-02 checkpoint's "Approve and continue" is satisfied without a live human
halt, per briefing "do not re-interview settled intent". Spec intentionally exceeds the 1600-token
target: one cohesive goal whose acceptance matrix is fixed by the briefing; scope standard's
limits are non-gates.)

## Design Notes

**Cessation predicate (server-derived, fail closed).** Blockers: agents of the job in
`spawning`/`streaming` (covers awaited/open turns; the runtime registers `spawning` before
prompting and every prompt-starting path takes an in-flight admission before its first await);
non-terminal child workers (`queued`/`admitted`/`active`); `activeJobAdmissions` for the job;
pending re-brief markers; any live directive other than the subject; open provider waits
(`waiting`/`recovered-pending`/`claimed`) for the job; `hasUnsettledVerificationRun`; review
rounds `pending`/`live`; live `worktree_processes` rows for the job's lanes; a queued worker
pacing-gate entry whose id is the job (when the gate is hosted). Missing lane, unresolvable
head, unreadable evidence or a sent event without minion identity refuses. The route resolves
lane + fresh `resolveGitCommit` head; the ledger re-checks and compares inside one transaction.

**Race elimination.** The guarded section is fully synchronous (no await between evidence
collection and commit) in a single-threaded process over one SQLite connection; every producer
writes its durable mark (intent row, re-brief marker, admission, provider claim,
verification.requested, round, agent row) before its side effect and inside the same database,
so the in-transaction re-check is authoritative. Late evidence cannot rewrite a terminal row:
`recordDirectiveAdmission`/`recordDirectiveDelivery`/`failDirective` state guards plus the
`retired` terminal guard. Documented residual: in-process admissions are per-process by design.

**Hold semantics.** The `retired` row keeps its own `hold_released_by`/`hold_released_at`; an
open hold is a runtime fence (branch-idle + digest + board), NOT attention. It is released
atomically by the next accepted directive intent or re-brief marker (identity recorded); replay
of the retired id never releases it.

## Verification

**Commands:**
- `npx vitest run test/directive-retirement.test.ts test/ledger-db.test.ts test/directive-markers.test.ts test/durable-reconcile.test.ts test/branch-idle-guard.test.ts` — expected: all pass; the new suite fails before the change.
- `npm run typecheck && npm run lint && npm run build` — expected: clean.
- shared `/api/verify` scheduling for focused/full/type/lint/build gates with full captures.

**Manual checks:** readback of a retired request shows `retired`, admission class, hold state and
the no-delivery/no-effect separation; `git diff` contains no production data or config change.
