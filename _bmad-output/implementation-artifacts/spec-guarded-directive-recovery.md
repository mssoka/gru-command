---
title: 'Guarded interrupted-directive recovery'
type: 'feature'
created: '2026-10-08'
status: 'in-review'
route: 'dispatch'
baseline_commit: '52ae3f1ce88ccfd0d0095f99fb8f51db67a88a62'
review_loop_iteration: 2
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

Implementation fix cycle 1 (post-review): persisted and exposed the recorded
canonical retirement expectations (replay reconstruction), normalized head/hash
case, carried the closed phase id on the audit event and on replays, filtered
inert terminal-job holds from the board projection, added the retirement audit
facts to the consumed-id replay response, validated the hold row's audit facts
loudly, and added discriminating tests for the pace-gate queue, the stall fence,
the two digest publish-boundary races, and every omitted live-ownership filter
member. Migration 23 gained `retire_expected_state`/`retire_expected_head`
(never applied outside local test databases).

## Review Triage Log

Round 1 (three tracked review jobs at head `ffb0319`, parent
`guarded-directive-recovery-20261008`, deliverable `review`): blind
hunter (15 findings), edge-case hunter (2 findings), verification-gap
reviewer (4 gap findings + 1 other finding). Every claim was verified
against the code at the reviewed head; all are real and were fixed in the
same cycle (commit "fix(directives): review round 1 dispositions"). No
intent gap, bad-spec or defer entry: each fix is a bounded correction to
this change, not a re-derivation; no finding was rejected or dropped.

| # | Reviewer / claim | Verdict | Evidence + disposition |
|---|---|---|---|
| B1 | Replay cannot be reconstructed from the readback (`expected_state`/head absent) | medium | Real: the canonical intent was fingerprinted but its binding facts were not readable, so a lost-response retry could not reproduce it. Fixed: `retire_expected_state`/`retire_expected_head` persisted and exposed on the readback + retire response; runbook documents replay reconstruction; test replays from readback alone. |
| B2 | Uppercase `expected_head` passes the route regex but fails the lowercase compare as `stale_head` | low | Real: valid uppercase object ids were misdirected to a stale-head refusal. Fixed: route trims/lowercases head and payload hash before fingerprint/compare; uppercase-success test added. |
| B3 | Idempotent replay drops `phase_handoff_closed` | low | Real: the replay path returned null even when the original transition closed the phase. Fixed: replay reconstructs the closure by the exact close-reason prefix; replay test asserts the same phase id. |
| B4 | `silas.directive-retired` payload omits the closed `phase_id` | low | Real: the durable correlation was only a second lookup. Fixed: payload carries `phase_handoff_closed` (and `expected_state`); test asserts it. |
| B5 | Holds on jobs that later go terminal can never be released and the board advertises them forever | medium | Real: terminal lanes accept no releasing request, so the projection named a dead lane and could mask newer holds. Fixed: the board filters terminal jobs (the hold stays durably inert); test retires on a binned job and proves an inert hold is not projected while a newer live hold still is. |
| B6 | Retired-id replay through `POST /api/silas/directive` lacks retirement audit fields | low | Real: replay-only callers could not learn why/when the id was consumed. Fixed: the replay response carries the same retirement facts as the readback; test asserts them. |
| B7 | Queued pace-gate worker refusal is dead code under test | medium | Real (verification gap): the harness never supplied a gate. Fixed: `boot()` accepts a gate; a queued worker turn returns a named `live_work` refusal and the same call succeeds once released. |
| B8 | Digest `conflictingPrs` hold fence untested | medium | Real (verification gap): no observer existed for the publish-boundary recheck. Fixed: a conflict offer is retracted when a retirement hold opens during the compute await. |
| B9 | Retirement fingerprint has no pinned/golden value | low | Real: a preimage change would silently turn every replay into a conflict. Fixed: golden-constant test pins the exact format hash. |
| B10 | `listDirectiveRecoveryHolds` blind-casts nullable audit columns | low | Real: an inconsistent retired row would surface `undefined` text. Fixed: named loud errors on missing audit facts; typed `retireExpectedState` read validated at row decode. |
| B11 | Migration-upgrade test checks two columns and not the index | low | Real (verification gap). Fixed: all eight new columns asserted null after the v22→v23 upgrade plus the hold index. |
| B12 | Runbook never says how a retirement candidate surfaces | low | Real: operators had no detection path. Fixed: "How a candidate surfaces" section (boot escalation card, board next action, readback, digest). |
| B13 | `silas.directive-retired` absent from Silas health action kinds | low | Claimed invisible-to-health is true and deliberate: retirement is an operator/owner control closure that advances no work and must not count as Silas follow-through yield. Fixed by documenting the exclusion at the list; no behavior change. |
| B14 | Dead line in the stale-head test | low | Real: an unused fixture commit. Fixed: removed; the lane commit is the only head move. |
| B15 | Retire response omits `hold_released_at` the readback exposes | low | Real asymmetry. Fixed: the retire response carries both hold fields. |
| V1 | Queued pace-gate refusal never executed under test | medium | Real (pre-verified gap); same root as B7 — fixed with the gate-backed test. |
| V2 | Stall-fence assertion cannot fail (in-review delivered fixture never proposes a row) | medium | Real (broken-verification gap): the assertion was vacuous. Fixed: a `reopenRepairPhase` lane where the hold is the only fence — suppressed while open, visible after a fresh request fails with no-effect proof. |
| V3 | Digest publish-boundary rechecks masked by the intake fence; no mid-sweep test | medium | Real: deleting the recheck clauses left the suite green. Fixed: two `blockersForRound` race tests (review offer + conflict offer) that open the hold between intake and publish. |
| V4 | Live-ownership refusal matrix exercises one status per clause | medium | Real (regression gap): `spawning`, `recovered-pending`, `claimed`, `live` were never created. Fixed: each filter member now has a refusal assertion and a release/success path. |
| V5 | Idempotent replay of a phase-closing retirement misreports the closure (other finding) | low | Real; same root as B3 — fixed by the replay reconstruction; the phase test now replays. |
| E1 | Board names a terminal-job hold forever and masks newer holds | medium | Real; same root as B5 — fixed by the terminal-job filter and proven by the binned-job board assertion. |
| E2 | Replay of a phase-closing retirement returns `phaseClosed` null | low | Real; same root as B3/V5 — fixed and asserted. |

No deferred entries: every finding was resolvable inside this change's
scope, and none was dropped.

### Continuation after the quota interruption (2026-10-08)

The original minion and all three round-2 service reviewers stopped at
`quota_wall` without a completed second-round verdict. Their partial
transcripts are investigation evidence, not review clearance. The existing
clean branch and PR #261 were preserved; origin was fetched before continuing.

| # | Verified issue | Verdict | Evidence + disposition |
|---|---|---|---|
| C1 | NEEDS CHANGES, verification failure/wait and minion-error channels bypass the recovery hold | high | A real route retirement still published these continuation offers; red regression reproduced the verdict channel. Fixed: filter every continuation channel at the final synchronous digest publish boundary; baseline/held/released and mid-await tests cover it. |
| C2 | Late provider recovery can claim and resume a held lane | high | Red fixture reached the spawn path and consumed its wait after retirement. Fixed: refuse before atomic provider claim, leaving wait/control evidence unchanged; hide the held lane from provider continuation offers. |
| C3 | Registered branch tip can remain unchanged while checkout HEAD advances | medium | Detached fixture with an unchanged registered branch incorrectly retired against the old head. Fixed: bind the actual checkout HEAD; stale expected head refuses byte-identically. |
| C4 | Branch-idle hold assertion was masked by the pre-existing open-attempt fence | medium | The old fixture had no delivery and was busy even without its hold. Fixed: use an otherwise idle delivered lane, explicitly prove the hold-free view is idle, then assert the real hold keeps it busy. |
| C5 | Review/conflict race tests were masked by event-watermark retraction | medium | Partial second-round reviewer mutation evidence showed missing hold clauses remained green. Fixed: isolate the hold recheck from the independent watermark in those two tests. |
| C6 | Late admission, changed-payload consumed replay, ambiguous/inaccessible lane and reopened replay were not discriminated | low | Added exact record/hold preservation assertions and replay/refusal cases, plus inconsistent-audit decode checks. |

The isolated shared-scheduler red run is
`0232bc12-5492-485b-ba4c-0c9cc9a15a2b` (request
`verify-guarded-continuation-red-20261008`): 4 reproductions failed, 246 tests
passed; complete capture/receipt at
`~/.gru-command/captures/guarded-directive-continuation-20261008/red.ndjson`.
It intentionally binds a dirty test-first tree, not a passing commit.
All corrections stay within the frozen continuation boundary; no deferred
work or production activation was created. The matrix now registers 38 tests.

### Requested Herdr Pi review at `55d70ed` (2026-10-08)

All four independent reviewers completed using Pi `openai-codex/gpt-6-sol`
(Blind Hunter `wA9:p2Y`, Edge Case Hunter `wA9:p2Z`, Verification Gap
`wA9:p20`, Acceptance Auditor `wA9:p31`). Reports are in
`~/.gru-command/captures/guarded-directive-continuation-20261008/`.
Each raw finding was verified at the reviewed head and receives its own
verdict below, before root-cause grouping. Verification Gap's sole `Other
finding` was verified normally, not accepted as a pre-verified test gap.
All corrections are private boundary patches to demonstrated states; no
new operator endpoint, frozen-intent change, or deferred work was added.

| # | Raw reviewer claim | Verdict | Evidence + patch disposition |
|---|---|---|---|
| H-B1 | Historical claimed waits permanently block later retirement | high | The query included every claimed wait after its awaited turn ended. Keep unproven claims fenced; emit a genuine correlated provider terminal receipt and exclude only proven completed/failed or superseded debt. Real provider happy-path and retirement tests discriminate both cases. |
| H-B2 | Pending supervisor backoff can restart after retirement | high | The tap adopts lane minions, and failed rungs retain a timer while rows are idle/error. Production retirement now reads the supervisor's pending classification/restart/retry/control ownership synchronously; real failed-rung and rate-limit tests plus route refusal/cessation tests cover it. |
| H-B3 | Agent-ID-keyed paced retries escape job-ID queue lookup | high | Supervisor retry/recovery gates use agent IDs. Match the subject job's registered agent IDs too; the new queued-agent test refuses without an audit write. |
| H-B4 | Forced review bypasses an open hold | high | The branch blocker reached the force override. Hold blockers are now unconditionally refused and never audited as forced; real review-route force test proves zero rounds/spawns. |
| H-B5 | Foreign target bypasses the reviewed job's own hold | high | Only the own-job re-brief was unconditional. Include the own-job hold independently of target resolution; foreign-target and force-plus-target route cases refuse. |
| H-B6 | Old provider continuation races fresh accepted directive | high | Acceptance clears the hold before the replacement appears; claim did not inspect its live ownership. Check fresh directive/re-brief/admission ownership before claim and immediately before side effects, and bind old waits to the durable accepted handoff sequence. Old waits stay unchanged and cannot resume after the fresh turn ends. |
| H-B7 | Parked/blocked handling cancels a wait before the hold guard | medium | Those status branches ran first and wrote cancelled status. The hold guard now precedes them; working/parked/blocked cases prove byte-identical wait and event history. |
| H-B8 | Retire-plus-accept during digest await republishes stale offers | high | At publication only the already-released hold was checked. Recheck fresh producer ownership on retired lanes after all awaits; a retire-plus-accept race now retracts the old verdict. |
| H-B9 | One malformed hold masks later healthy board debt | medium | Bulk decode threw before projection could inspect the later row. Projection reports malformed audit debt individually, keeps healthy holds visible, and leaves strict control reads throwing; real board test observes the named error and healthy hold. |
| H-B10 | Throwing registry becomes generic HTTP 400 | medium | Registry lookup escaped the typed lane-evidence boundary. Translate it to 409 lane_unavailable before any write; the exact throwing-port route test preserves row/events. |
| H-E1 | Late old wait can resume alongside a fresh directive | high | Independently confirmed the live-intent/admission gap in the provider claim. The fresh-owner, ordered supersession and pre-side-effect fences prevent this outcome; old wait remains recorded. |
| H-E2 | Throwing registry is an untyped refusal | medium | Confirmed thrown listWorktrees reached generic bad_request. The typed registry boundary returns lane_unavailable with no mutation. |
| H-E3 | Malformed earlier hold hides a later healthy hold | medium | Confirmed one decode error poisoned the bulk projection. Per-row error reporting preserves the healthy board hold and strict fail-closed reads. |
| H-E4 | Open hold fails to preserve a parked/blocked late wait | medium | Confirmed status cancellation preceded the hold branch. Hold-first refusal preserves the wait on both statuses. |
| H-V1 | Fresh dispatching intent does not fence old recovered wait claim | high | Confirmed acceptance releases the hold before worker registration and the test offered but never claimed the wait. The test now attempts claim both during and after the fresh request; both refuse old evidence, while a genuinely new post-handoff wait can continue. |
| H-A1 | Admitted row may audit minion B against sent receipt naming A | high | recordDirectiveAdmission allowed the mismatch and retirement skipped bound-evidence revalidation. Retirement now verifies exact sent sequence/kind/job/request/minion for admitted rows; mismatch refuses with admission_evidence_incomplete and no writes. |
| H-A2 | Unreadable registry violates typed fail-closed AC | medium | Confirmed the port exception bypassed lane_unavailable mapping. The new typed 409 test covers the registry itself, not merely an inaccessible checkout path. |

After individual verdicts, shared roots are: provider authority/history
(H-B1/B6/B7, H-E1/E4, H-V1), supervised/paced producer ownership
(H-B2/B3), review authorization (H-B4/B5), digest publication (H-B8),
projection isolation (H-B9/H-E3), typed lane evidence (H-B10/H-E2/H-A2),
and bound admission identity (H-A1). Every real finding is patched here;
none is deferred or dismissed. The retirement matrix now registers 46
tests and the supervisor suite 94. Dirty-tree preflights are development
evidence only, never commit-bound clearance; clean-head focused/full
receipts are captured separately after the patch commit.

### Follow-up challenge at `8e747ab`

All four requested Pi reviewers completed the correction challenge. Original
findings are resolved on their reported paths, except H-B8's narrower
fully-settled race. Every new raw finding below is verified independently
before grouping; none is deferred. Reports and native model/session
identities are captured as `*-followup-8e747ab.md` and
`followup-8e747ab-results.json` in the same capture directory.

| # | Raw follow-up claim | Verdict | Evidence + correction route |
|---|---|---|---|
| F-B1 | A fresh turn can fully settle during the digest await, leaving the old verdict offer | high | The answering check precedes the await and only live ownership is checked afterward. Patch: apply the existing per-job event watermark to continuation rows on retired lanes, so a settled handoff also invalidates the captured offer. |
| F-B2 | Superseded waits still drive sensor probing and boot wake batches | medium | validateWaiter and pending-batch reconciliation did not consult ordered retirement identity. Patch: preserve wait/audit rows, suppress held/unknown/superseded candidates, and close only batches whose bound debt is proven superseded/terminal. |
| F-B3 | An inert terminal-job hold prevents terminal provider-wait cleanup | medium | Hold-first claim returned before the terminal guard on a job that cannot accept a releaser. Patch: terminal cancellation precedes the runtime hold, while parked/blocked holds still preserve waits; no terminal job is revived. |
| F-E1 | Asynchronous old route lookup can establish its wait after the fresh handoff | high | Supervisor hands wall recording to an untracked async credential lookup after stopping; establishment had no admission before its first await. Patch: reserve job admission for the real observation until route resolution and wait recording finish, so retirement cannot cross that interval. |
| F-V1 | Production supervisor-to-route connection can be omitted without a failing check | medium | The real supervisor and route-stub tests are independent, and the server field was optional. Pre-verified coverage finding. Patch: require the proof port at both server and orchestration boundaries; removing the production wiring must fail typecheck, with explicit no-supervisor fixture ports. |
| F-A1 | A claimed continuation can deliver after a newer completed handoff | high | Wait identity was checked only before awaited spawn. Fixed: recheck exact handoff identity at the continuation setup/prompt fences after awaited spawn; changed authority is a declined attempt, not a fresh-job minion error or status rewrite. Unknown disposal retains producer ownership, even if the wait's permission was superseded. |

All six route to private boundary patches to demonstrated states. Sensor
observation admission and post-spawn authority have different roots; the
latter's corrective refusal must also preserve the newer job's status and
receipts. No frozen intent or operator endpoint changes are needed.

All six corrections are implemented. The retirement matrix now registers
50 tests and the sensor suite 52, with both in `directive-recovery`.
Test-first dirty captures `followup-red-8e747ab.ndjson` and
`followup-red-v2-8e747ab.ndjson` reproduce the five behavioral findings
(the initial two invalid incident fixtures were corrected before their
reproductions). `required-port-mutation-v2-8e747ab.ndjson`, run
`5b5388e1-3414-4703-a83a-7184e01cdee6`, fails solely when main's actual
supervisor connection is omitted: TS2345 requires
`pendingProducerBlockers`. The connection is restored; normal typecheck
passes. Focused preflight run `7b962f6c-009b-4725-afd4-d25385cae7bd`
passes all 495 checks with the same declared budgets. These dirty-tree
runs are regression/development evidence, not commit-bound clearance.
No review finding was deferred; final exact-head challenge and receipts
follow the patch commit.

### Exact-head challenge at `598044b`

All four Pi `openai-codex/gpt-6-sol` sessions completed their read-only
challenge. Each raw finding below is verified separately before grouping;
Verification Gap's Other finding is verified normally.

| # | Raw claim | Verdict | Verified evidence + disposition |
|---|---|---|---|
| N-B1 | Fresh directive/re-brief overtakes provider observation or already-prompting continuation | high | beginDirectiveIntent/beginPendingRebrief lack the provider admission fence; recording after the newer handoff gives old evidence a misleading birth sequence. Patch both acceptance boundaries and capture native recovery epoch before observer I/O. |
| N-E1 | Breaker ACK replays a retired prompt | high | onNotificationAcked re-arms a stopped breaker; restart/recovery checks handle currency, not retirement authority. Patch ACK/restart/delivery with hold and captured native epoch fences, preserving the stopped history and never replaying a superseded snapshot. |
| N-V1 | Fresh H2 starts while provider prompt H1 is pending (Other finding) | high | The real helper awaits prompt after its last authority check; a fresh acceptance currently sees no live directive and ignores the provider reservation. Patch acceptance; add pending-prompt H2 refusal and after-settlement positive counterpart. |
| N-A1 | Delayed observation gains newer handoff authority | high | Independently traced the same accepted-before-route-resolution sequence. Patch both provider exclusion and pre-I/O epoch capture; preserve normal current observation and post-settlement acceptance. |

After individual verification, N-B1/N-V1/N-A1 share asymmetric provider
ownership at fresh acceptance; N-E1 is a distinct supervisor replay root.
All are private boundary patches to demonstrated states; none is deferred.
Implemented provider reservations plus unproven-claim refusal at both fresh
acceptance boundaries, pre-I/O native epoch capture, and supervisor
ACK/restart/delivery epoch fencing. The old post-spawn race now expects H2
refusal; its reachable owner-park/disposal matrix still exercises the late
helper guard and retained unknown cleanup ownership. Added observation,
actually-pending prompt/HTTP H2, and ACK/re-arm regressions with positive
post-cessation/fresh-turn counterparts. Retirement suite is 52, supervisor
95, focused total 498. Developmental red v3
`e345ea69-cdae-49dc-9524-928b655fef50` reproduces all four assertions with the
acceptance fence deliberately omitted and old supervisor unchanged. Earlier
red attempts had fixture API mistakes and are not discriminating evidence.
The mutation is restored. Focused developmental green
`89502000-15de-4afa-a78d-adc6556eaec1` and typecheck
`f3442b35-9116-4e4b-88e5-11730e38282a` pass; both are dirty, non-commit-bound
preflights, not clearance. Final-source review and exact-head gates remain.
The exact-head full run's unchanged SIGTERM wall-clock assertion failed once
(3199ms versus 2000ms; it includes local git reads outside the 250ms remote
probe). No timeout/budget was waived. Unchanged full rerun
`dd228178-29b8-4afa-8472-d78fa1ff9ed9` passes at clean `598044b`; CI also
passes at that SHA. The first failed capture remains preserved as failure,
not clearance. Typecheck `4efc2a02-1460-4381-8176-79080c9edfd1` and
focused `425a22d6-a246-4c89-b73c-eb7a03a36319` pass at the same clean head.
These receipts clear that source only, not the next corrections.

## Design Notes

**Cessation predicate (server-derived, fail closed).** Blockers: agents of the job in
`spawning`/`streaming` (covers awaited/open turns; the runtime registers `spawning` before
prompting and every prompt-starting path takes an in-flight admission before its first await);
non-terminal child workers (`queued`/`admitted`/`active`); `activeJobAdmissions` for the job;
pending re-brief markers; any live directive other than the subject; open provider waits
(`waiting`/`recovered-pending`/unproven `claimed`) for the job; `hasUnsettledVerificationRun`; review
rounds `pending`/`live`; live `worktree_processes` rows for the job's lanes; worker pacing
entries keyed by job or its agents; supervisor pending classification/restart/backoff,
retry/recovery admission, or open turn/control/tool ownership. Historical claims need a
correlated genuine closed-turn or acknowledged-disposal receipt; spawn/cleanup
errors remain unproven even after supersession. Unclaimed superseded waits need an
exact durable handoff sequence (unknown evidence stays a blocker). Missing lane, unresolvable
head, unreadable registry/supervision, or inconsistent sent/admitted identity refuses. The route resolves
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
of the retired id never releases it. Fresh acceptance on a job with retirement history
also records `silas.directive-recovery-handoff`, bound to the accepted identity and
retired request IDs. Native event ordering, never clock age, proves whether a provider
wait preceded that handoff. Superseded waits remain unchanged, are not continuation
offers, and unclaimed stale debt does not permanently block later control closure;
missing ordered proof stays fenced. Forced review and foreign targets cannot waive
a hold. Fresh live ownership and the captured event watermark are rechecked at
digest publication, including a fresh turn that fully settled during an await.

## Verification

**Commands:**
- `npx vitest run test/directive-retirement.test.ts test/ledger-db.test.ts test/directive-markers.test.ts test/durable-reconcile.test.ts test/branch-idle-guard.test.ts` — expected: all pass; the new suite fails before the change.
- `npm run typecheck && npm run lint && npm run build` — expected: clean.
- shared `/api/verify` scheduling for focused/full/type/lint/build gates with full captures.

**Manual checks:** readback of a retired request shows `retired`, admission class, hold state and
the no-delivery/no-effect separation; `git diff` contains no production data or config change.
