---
title: 'Terminal Binned job status (replacement execution for job-status-binned)'
type: 'feature'
created: '2026-10-07'
status: 'in-review'
route: 'dispatch'
baseline_commit: '84aec28b04ddc406f26c458383452318f8cb7ed1'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `parked` is the only resting place for owner/chief-discarded jobs, and `parked → done` is deliberately illegal, so dead jobs clutter the board forever with no way to distinguish a paused, resumable lane from a cancelled one. The existing status path cannot express "discarded" truthfully.

**Approach:** Add a terminal `binned` job status. It is legal from every existing non-terminal status (`dispatched`, `working`, `delivered`, `in-review`, `blocked`, `parked`), illegal from `merged`/`done`, and has no outgoing/resumption edges — it is recognized by the same terminal contract as `merged`/`done` (obligation closure as abandonment, closed-receipt board projection, no resumable implementation/review offers). No new endpoint: the authenticated `POST /api/jobs/<id>/status` surface picks it up. **Operator clarification 2026-10-07:** the point is for Gru itself to intentionally bin a heist; the shipped Gru role must teach its own authenticated action, while a status transaction refuses target-owned live producers. No automatic binning or authorization by untrusted context. The board shows binned rows with an accessible distinct Binned badge in the Cold section behind an explicit disclosure; the prior status and all history stay on the record and the rows remain inspectable.

## Boundaries & Constraints

**Always:** binning preserves the prior status and all historical evidence (`job.status` from→to event, row history, rounds, lane, obligations closed as `job-terminal` abandonment — never a success claim); terminal recognition flows through the shared declaration (`JOB_TERMINAL` / `isJobTerminal` / `TERMINAL_JOB_STATUSES`) and every consumer that gates resumable work treats `binned` as terminal exactly like `merged`/`done`; the board hierarchy For you → In flight → Pipeline → For Gru → Settled → Cold, complete counts, previews 5/5/3, collapsed For Gru/Cold and count-only Cold stay intact, with binned rows staying in Cold and counted there; ordinary parked/done/merged rows (including the administrative Done from PR246) keep their distinct meanings and projections; malformed, unauthenticated or illegal requests fail without partial mutation.

**Never:** no new endpoint, restore/unbin feature, job migration, automatic live closeout, supervision/dispatch/runtime/worktree redesign, new runtime dependency, or resource-limit change; no relabeling of done/merged as binned; no inferring READY/PASS/merge from terminality; no weakening or skipping existing tests and pins; no touching sibling worktrees; never present a caller-provided `by` as authentication.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LEGAL_TRANSITION | any of `dispatched`,`working`,`delivered`,`in-review`,`blocked`,`parked` with no target-owned live producer | transition to `binned` lands; row `binned`; `job.status` event `{from: prior, to: binned}`; prior hops preserved | N/A |
| LIVE_PRODUCER | open worker turn, unfinished child, pending/live round, or unsettled verification | refused atomically: no status/event/obligation change; stop via own authorized control first | HTTP 400 names live work |
| ILLEGAL_SOURCE | `merged` or `done` | request refused, no row/event/obligation change | throw `illegal transition <from> → binned`; HTTP 400 `bad_request` |
| ILLEGAL_RESUME | `binned` | any other status refused, no mutation | throw `illegal transition binned → <to>` |
| OBLIGATIONS | lane with open/waiting/suspended obligations → `binned` | same transaction settles applicable obligations `{kind:'job-terminal', jobStatus:'binned'}`; settled history untouched | N/A |
| API_AUTH | POST status without/with bad token, even with `by` in body | 401 `unauthorized`; no mutation | typed 401 |
| API_MALFORMED | unknown status string | 400 `bad_request`; no mutation | typed 400 |
| BOARD_DEFAULT_HIDE | mixed snapshot with binned rows | binned rows absent from the rendered default view; explicit binned disclosure reveals them with the badge; non-binned cold rows unchanged; count includes binned | N/A |
| BOARD_EMPTY | snapshot without binned rows | no binned disclosure control; rendering unchanged | N/A |

</frozen-after-approval>

## Code Map

- `src/ledger/states.ts` -- `JOB_STATUSES`, `JOB_TRANSITIONS`, and the ONE terminal declaration `TERMINAL_JOB_STATUS_LIST` feeding `type TerminalJobStatus`, the `JOB_TERMINAL` set, `isJobTerminal` and `isTerminalJobStatus`; `TERMINAL_JOB_STATUSES` derives from the same predicate. The web cross-build alarm parses `TERMINAL_JOB_STATUS_LIST`.
- `src/ledger/api.ts` -- `setJobStatus` refuses binned while target-owned producers remain live in the same transaction, then calls `closeApplicableObligations(id, status)` for terminal targets; amendment/directive guards refuse terminal lanes (`isJobTerminal`).
- `src/ledger/obligations.ts` -- `job-terminal` settlement kind/parse: `jobStatus: 'done' | 'merged' | 'binned'`.
- `src/board/engine.ts` -- `prStateOf` (binned = closed receipt, null), `concludedJobs` receipt set, `isClosedReceipt`.
- `web/src/lib/board-protocol.ts` -- `jobStatusTone`/`jobChipTone`, `isJobConcluded` (binned terminal; alarms read the ledger declaration).
- `web/src/lib/board-bands.ts` -- `bandForJob` explicit binned → cold.
- `web/src/lib/board-kpi.ts` -- `derivedPrState` (binned = no open claim).
- `web/src/ui/board.ts` -- binned chip/dot; Cold binned disclosure + filter; binned job body keeps full round history.
- `web/src/styles/components.css` -- `.pp-chip--binned` + `.board-job__dot--binned` only, existing tokens.
- `src/dispatch/server.ts`, `src/dispatch/perkins.ts`, `src/dispatch/github-poll.ts`, `src/dispatch/silas-driver.ts`, `src/dispatch/obligations.ts`, `src/provider-recovery/resume.ts`, `src/provider-recovery/sensor.ts`, `src/chat/awareness.ts`, `src/telemetry/yield.ts` -- terminal checks must include `binned` (the no-resume / no-resurrection fences).
- `roles/gru.md` + `src/roles.ts` -- shipped Gru system prompt and permitted bash tool, teaching the named authenticated bin action, live-producer preflight and truthful abandonment; `test/board-server.test.ts` exercises that loaded instruction against the real HTTP boundary in a fixture.
- `docs/LEDGER.md` -- machine + terminal contract; `docs/BOARD.md` -- badge/filter/receipt projection; `docs/OPERATIONS.md` -- post-install operator procedure.
- `test/ledger-api.test.ts`, `test/ledger-obligations.test.ts`, `test/board-engine-v4.test.ts`, `test/board-server.test.ts`, `test/suite-shape.test.ts`, `web/src/lib/board-signals.test.ts`, `web/src/lib/board-kpi.test.ts`, `web/src/lib/board-bands.test.ts`, `web/src/lib/board-sections.test.ts`, `web/src/ui/board.test.ts` -- regressions + pins.
- `.gru-command/worktree.toml` -- committed verification scopes (focused backend+web, static, fail-before baseline).

## Tasks & Acceptance

**Execution:**
- [x] `src/ledger/states.ts` -- add `binned` to `JOB_STATUSES`, `JOB_TERMINAL`; add `binned` to every non-terminal transition list; `binned: []`; update the machine comment -- one terminal contract for merged/done/binned.
- [x] `src/ledger/api.ts` -- close applicable obligations for `binned` terminal transitions; use the terminal predicate in amendment/directive guards -- truthful abandonment, no resumable offers.
- [x] `src/ledger/obligations.ts` -- accept `binned` in `job-terminal` settlement type/parse.
- [x] `src/board/engine.ts` + `web/src/lib/{board-protocol,board-bands,board-kpi}.ts` -- terminal projections: prState null, concluded receipts, band cold, no needs-you promotion.
- [x] `web/src/ui/board.ts` + `web/src/styles/components.css` -- accessible Binned badge + Cold disclosure/filter; full-history body for binned.
- [x] no-resume consumers (dispatch/provider-recovery/chat/telemetry) -- include `binned` in terminal checks.
- [x] `docs/LEDGER.md`, `docs/BOARD.md`, `docs/OPERATIONS.md` -- record the contract, badge/filter behavior and the operator procedure.
- [x] tests + `test/suite-shape.test.ts` pins + `.gru-command/worktree.toml` scopes -- deterministic matrix/API/board coverage and the fail-before baseline.
- [x] operator clarification: Gru's shipped role instructs the intentional authenticated status action; live producers refuse binning transactionally; deterministic loaded-prompt → HTTP → history/debt/no-revival test fails before and passes after. No new endpoint or bulk binning.

**Acceptance Criteria:**
- Given each non-terminal status with no target-owned live producer, when `setJobStatus(id, 'binned')` runs, then the row is `binned`, the `job.status` event records `<prior> → binned`, and prior events remain.
- Given `merged` or `done`, when `binned` is requested, then it throws `illegal transition` and neither the row, the events nor obligations change.
- Given `binned`, when any resume/terminal-hop status is requested, then it throws and nothing changes.
- Given the shipped Gru role and an authorized deliberate discard of a named heist, when Gru uses its permitted shell and configured auth token to call the existing status surface, then 200 + audit event, closed debt as abandonment and no revival; an open producer is refused before mutation and must be stopped by its own control. Given the authenticated HTTP status surface, when a binned transition is requested validly, then 200 + audit event; unauthenticated (even with `by`) → 401; malformed → 400; illegal → 400 — all with no partial mutation.
- Given a mixed snapshot, when the board renders, then binned rows are hidden by default behind an explicit labeled disclosure, render with an accessible distinct Binned badge when revealed, stay fully inspectable with complete history, and counts include them without changing the six-section layout or previews.
- Given empty or binned-free snapshots, when the board renders, then no binned control appears and ordinary parked/done/merged projections are unchanged.

### Review Findings — PR #247 independent full-spec pass at 8d44669

- [x] [Review][Patch] Refuse new review rounds for binned jobs at the transactional ledger boundary; pin authenticated HTTP refusal and no partial mutation. [src/ledger/api.ts:2338]
- [x] [Review][Patch] Count binned jobs explicitly in the TRACKERS status breakdown, not only its total. [web/src/lib/board-kpi.ts:82]
- [x] [Review][Patch] Record a real merge observed by an existing in-flight poll after binning as a no-effect receipt; never begin polling already-discarded lanes or infer future merges. [src/dispatch/github-poll.ts:1008]
- [x] [Review][Patch] Add the delivered-then-binned report-backfill test to focused and fail-before verification scopes. [.gru-command/worktree.toml:585]
- [x] [Review][Patch] Make the fail-before gate distinguish assertion failures on both legs from import/setup failures. [.gru-command/worktree.toml:608]
- [x] [Review][Patch] Pin late phase-handoff abandonment settlement as job-terminal/binned rather than merely closed. [test/phase-handoffs.test.ts:517]

## Implementation Notes

- Workflow state: lane-local BMAD `bmad-build` render `_bmad/render/bmad-build/job-job-status-binned-continuation-20261006-0e52e101bc06/f76b749a098f5191ee57/`. Step-02 was executed against base `84aec28b04ddc406f26c458383452318f8cb7ed1` (equals observed remote main). Checkpoint 1 is auto-resolved under the dispatch briefing's explicit authority (`job-status-binned-continuation-20261006` is the sole owner of investigation/spec, implementation, built-in independent review, fixes, authenticated verification and PR as one complete build); no human is present in the lane. Status set `in-progress`, baseline pinned.
- No subagent runtime is exposed to this lane's tool surface, so implementation is done directly from the spec (step-03's documented fallback); the built-in review runs as fresh tracked review jobs through `POST /api/dispatch` per the playbook.
- Implementation commit `6cd0dd2c5a6e05b236a6a256d7c2fac3d79a0054` (spec `472d0f9`). `binned-static` PASS at 6cd0dd2 (lint/typecheck/build/web tsc, exit 0, capture `_bmad-output/binned-verify/binned-static-6cd0dd2.ndjson`, receipt sha256 1b8d5df7…). `binned-focused` PASS at 6cd0dd2 (backend 144 tests, 5 files; web 179 tests, 5 files; exit 0; capture `_bmad-output/binned-verify/binned-focused-6cd0dd2.ndjson`, receipt sha256 f0542a55…). `binned-baseline` RED at both legs as designed (backend 5 failed/137 passed; web 5 failed/174 passed; exit 1; capture `_bmad-output/binned-verify/binned-baseline-6cd0dd2.ndjson`, receipt sha256 b1a33a4c…) — failures are the new assertions at the pre-change base (unknown status "binned", assertion mismatches), never setup/compile failures.
- Round-1 fix head `2bdfc4973aff53564b1bb6797a9d01036d203f47`, test repairs `d24551af308113a2e1d3bbab4d1da3d2ec344f82`. Gates at `d24551a`: `binned-static` PASS; `binned-focused` PASS (backend 16 files / 627 tests, web 5 files / 180 tests; full capture `_bmad-output/binned-verify/binned-focused-d24551af308113a2e1d3bbab4d1da3d2ec344f82-a4.ndjson`); `binned-heavy` PASS (4 targeted cases; capture `…-heavy-…-a5.ndjson`); `binned-baseline` RED both legs (5 backend + 6 web assertion failures; capture `…-baseline-…-a1.ndjson`). Queue waits beyond the capture helper's transport bound were handled by re-attaching under the SAME durable request id; the terminated attempts are preserved (admission-failed / UNKNOWN receipts) and are not PASS evidence.
- Round-3 review (concluding pass) at `38a1d45`: edge-case 0; blind 13, verification-gap 2+1. The blocking round-2-hunk/artifact findings are repaired in the round-3 fix commit (comment repairs the round-2 log claimed but did not apply, spec Code Map, baseline pin-only exclusion disclosure, focus-fallback regression, delivered-then-binned supersession pin, plus the trivial comment/doc items); the original round-3 run recorded three untouched-code findings as follow-ups, but the independent fix-all pass below supersedes those temporary dispositions: the observed-merge gap and KPI bucket are repaired, and future merge discovery is closed as intentional fail-closed rather than deferred.
- Round-2 review fixes (head follows) close the second round's terminal-consumer gaps (child workers, branch idle, worktrees release, phase-handoff reconcile, ledger re-brief boundaries, pipeline exclusive scopes, awareness receipts), collapse the terminal declaration to ONE list feeding set/union/predicate, make the provider-recovery skip reason truthful for a discard, fix the binned disclosure focus fallback, and refresh the stale doc/role/skill enumerations.
- Closed-receipt projections are deliberate: binned → `prState` null on both server and web (never an open-PR claim), needs-Gru suppressed, bound notification rows are receipts, obligations settle `{kind:'job-terminal', jobStatus:'binned'}`. Terminal fences in dispatch/provider-recovery/chat/telemetry now route through `isJobTerminal` so a binned lane can never be re-briefed, amended, directed, reviewed, re-dispatched or resurrected by a later merge signal.
- Board filter: binned rows stay in COLD (complete count) and render only inside the expanded Cold section behind a second explicit `Show N binned records` disclosure; the badge is a dashed muted chip + dot with the visible word `binned`; the binned body keeps ALL rounds (merged/done stay quiescent).


## Spec Change Log

## Review Triage Log

Independent full-spec pass at frozen 8d44669 (run `3763215e-d5e0-4697-ad2b-a53c2e8ce0e0`, four fresh read-only Pi children, all `openai-codex/gpt-6-sol`); source reports and exact run IDs in the external `bmad-pr247-8d44669c933d-v9OwsS` review directory. Coordinator ownership receipt `ownership-handoff.json` grants sole PR-checkout mutation to review pane wAA:p2 after original writer was confirmed disposed. All findings below were independently classified before grouping; no deferrals or quota filler.

| ID | Layer | Verdict | Evidence / route |
|---|---|---|---|
| I1 | blind | medium | `addRound` validates the job exists but not terminality; authenticated POST creates a pending review round on binned. Patch transactional boundary. |
| I2 | blind | low | TRACKERS counts binned in total but has no named bucket; patch KPI + rail. |
| I3 | blind | medium for observed in-flight race; false for demanded future discovery | `trackedLanes` excludes binned by design: no fresh poll, provider call or inferred merge is authorized. The existing in-flight fetch race loses a REAL merge observation; patch that narrow case as a no-effect receipt. For an unobserved later merge, fail-closed report debt is intentional, not a defect (owner ruling), and remains owed until owner disposition. |
| I4 | blind | low | New delivered-then-binned test omitted from both relevant committed scopes; patch scope. |
| I5 | edge | low | Independent corroboration of I2; same root cause. |
| I6 | edge | low | Baseline script always exits 1 and labels any failed leg expected, even if import/setup failed; historical captures show real assertion failures but script cannot prove it alone. Patch gate classification. |
| I7 | edge | low | Independent corroboration of I4; same root cause. |
| I8 | verification-gap | low | Pre-verified: late binned phase obligation asserted only closed, not its job-terminal/binned settlement. Patch assertion. |
| I9 | acceptance-auditor | low | Independently corroborates I4 against the committed verification contract; same root cause. |


Round 1 — three fresh tracked review jobs at `e4f3f64481afae6288fee23a79a0611ce2a92aa9` (PR #247), read-only, trees verified unmodified. Reports: `_bmad-output/binned-verify/reviews/{blind-hunter,edge-case-hunter,verification-gap}.md` (+ `.provenance.json` with session sha256). Edge-case hunter: 0 findings.

| ID | Layer | Finding (short) | Verdict | Evidence / disposition |
|---|---|---|---|---|
| B1 | blind | `yield.ts` books discards as finished throughput and can deflate cost-per-finished | medium | Real: terminal set made `binned` count in `finishedJobs`. Patched: WIP-terminal keeps the shared declaration; finished-throughput stays merged/done; deterministic binned case added. |
| B2 | blind | a binned prerequisite stalls its pipeline dependents | low | Real and deliberate: releasing approved work off a cancelled premise would infer progress. Pinned with the stall + named reason in `ledger-pipeline`. |
| B3 | blind | `derivedPrState` hardcodes done/binned instead of the concluded twin | low | Real drift surface. Patched to ride `isJobConcluded` (future terminal statuses cannot present as open claims). |
| B4 | blind | shared live/receipt fixture lacks a binned row | low | Real verification gap (same as V4). Patched: fixture + SQL/engine/web assertions. |
| B5 | blind | obligation test covers only the open case | low | Real. Patched: a parked-suspended debt now pinned closing `job-terminal`/binned. |
| B6 | blind | four docs still say terminal = merged/done | low | Real. Patched: CHAT/SUPERVISION/UI/BOARD now say merged/done/binned. |
| B7 | blind | shipped Silas skill text says terminal = merged/done | low | Real shipped-prompt drift. Patched: both skill lines updated. |
| B8 | blind | terminal-contract comments adjacent to changed code are stale | low | Real. Patched: the cited comments updated to the three-status contract. |
| B9 | blind + VG-other | spec Implementation Notes duplicated two bullets | low | Real (my artifact). Patched: duplicate removed. |
| B10 | blind | repeat-binning behavior undocumented/unpinned; docs implied 400 | low | Real. Patched: docs now state the idempotent 200 no-op; ledger + HTTP tests pin it. |
| B11 | blind | plural binned disclosure label untested | low | Real. Patched: DOM test pins `Show 2 binned records`. |
| B12 | blind | `binnedExpanded` persistence across pushes undecided/uncovered | low | Real. Resolved as the existing session-disclosure convention (like COLD/FOR GRU); DOM test pins open-across-push and reversibility. |
| V1 | verification-gap | amendment / directive / re-brief / review-round admission fences unpinned for binned | medium | Real: reverting any guard shipped green. Patched: binned refusals added in amendments, directive intents, dispatch endpoints (filtered heavy case) and the wave `runRound` loop (filtered heavy case). |
| V2 | verification-gap | provider-recovery + phase-handoff + queued-handoff fences unpinned for binned | medium | Real. Patched: binned variants added in resume/sensor/phase-handoffs plus the handoff-skip loop (filtered heavy case). |
| V3 | verification-gap | Silas release-eligible + GitHub merge-skip unpinned for binned | medium | Real. Patched: binned release row test + binned merge-signal clean-skip test. |
| V4 | verification-gap | board/chat live-vs-receipt classification and yield M0 unpinned for binned | medium | Real. Patched: shared fixture extended (SQL + engine + web), awareness staged-PR exclusion, yield M0 binned case. |
| E0 | edge-case | (no findings) | — | Clean: 0 edge, 0 deletion, 0 claims findings; read-only honored. |

All round-1 findings are verified real (none false/rejected); every one is patched in the fix commit. No intent_gap/bad_spec loopback: the frozen intent already names the terminal contract, and the fixes are code/test/doc completions inside it. Round 2 (fresh whole-change review at the fix head) follows before any READY claim.

Round 2 — three fresh tracked review jobs at `d24551af308113a2e1d3bbab4d1da3d2ec344f82`, read-only, trees verified unmodified. Reports: `_bmad-output/binned-verify/reviews/r2-{blind-hunter,edge-case-hunter,verification-gap}.md` (+ provenance). Blind hunter 13, verification gap 7, edge case 1. All verified real; all patched.

| ID | Layer | Finding (short) | Verdict | Evidence / disposition |
|---|---|---|---|---|
| R2B1 | blind | spec's Verification block listed the pre-fix scopes | low | Real artifact drift. Patched: block now names the committed focused/heavy/static/baseline scopes and the fix-head receipts. |
| R2B2 | blind | baseline scope claimed wider overlay than its file list | low | Real. Patched: overlay extended to every fast suite the change touches (plus the shared fixture); the comment now scopes the claim and points heavy fail-before at `binned-heavy`. |
| R2B3 | blind | shipped Silas skill still said terminal = merged/done (re-brief bullet) | low | Real. Patched. |
| R2B4 | blind | `docs/FLOW.md` two stale enumerations | low | Real. Patched (both). |
| R2B5 | blind | `docs/LEDGER.md` re-brief-marker section contradicted its terminal bullet | low | Real. Patched (both lines). |
| R2B6 | blind | provider-recovery skip recorded a discard as "completed" | medium | Real truthfulness defect. Patched: `why` now names the actual terminal status (`job is binned — no continuation`); pinned in the resume test. |
| R2B7 | blind | terminal set declared four times; predicate could go unsound | medium | Real drift surface. Patched: ONE `TERMINAL_JOB_STATUS_LIST` declaration feeds the set, the union, the predicate and `isTerminalJobStatus`; api/obligations/silas-driver consume the shared type; the web cross-build alarm parses the single declaration. |
| R2B8 | blind | three stale terminal comments on/next to changed code | low | Real. Patched (board.ts x2, dispatch/service.ts). |
| R2B9/R2E1 | blind + edge | `section:cold-binned` cannot resolve through the focus fallback | low | Real a11y gap. Patched: the restore path maps the binned disclosure to the COLD shortcut so focus never drops to `<body>`. |
| R2B10 | blind | report-backfill discard exclusion unrecorded | low | Real. Patched: explicit decision comment (a discarded newer report never supersedes older debt). |
| R2B11 | blind | `docs/YIELD-REPORT.md` M0 doc not updated | low | Real. Patched: documents binned = terminal (leaves WIP) but not finished. |
| R2B12 | blind | `roles/silas.md` transition enumeration omitted binned | low | Real. Patched. |
| R2B13 | blind | `docs/BOARD.md` reflow artifact | low | Real. Patched. |
| R2V1 | verification-gap | awareness receipt classification unpinned for binned | medium | Real. Patched: the D1 receipt test now runs both merged and binned recipes (receipt section, no wake seed). |
| R2V2 | verification-gap | child-worker admission/spawn fences unpinned for binned | medium | Real. Patched: binned `parent_expired` admission + queued-child spawn fence arms added. |
| R2V3 | verification-gap | branch-idle terminal short-circuit unpinned for binned | medium | Real. Patched: synthetic busy test + HTTP canonical-refusal loop include binned (filtered heavy case). |
| R2V4 | verification-gap | sweep-ack release endpoint unpinned for binned rows | medium | Real. Patched: a binned lane now releases through `/api/dispatch/release` with the receipt (filtered heavy case). |
| R2V5 | verification-gap | boot reconcile close for terminal phase handoffs untested | medium | Real. Patched: binned awaiting intent closed by `reconcilePhaseHandoffs`. |
| R2V6 | verification-gap | ledger in-transaction re-brief boundaries unpinned for binned | medium | Real. Patched: begin + retire boundary tests parameterized with binned arms (audited `job_status: 'binned'`). |
| R2V7 | verification-gap | pipeline exclusive-scope release unpinned for binned | medium | Real. Patched: a binned entry releases its scope and the same-scope entry clears. |

No intent_gap/bad_spec loopback in either round. Round 3 (fresh whole-change review at the round-2 fix head) is the concluding pass before any READY claim.

Round 3 — three fresh tracked review jobs at `38a1d452c6947205449de44f92e22d6af5f90700`, read-only, trees clean. Reports: `_bmad-output/binned-verify/reviews/r3-*.md` (+ provenance). Edge case 0 findings. Historical round-3 convergence classification treated new findings on untouched code as follow-ups. The later independent fix-all pass below supersedes that temporary routing; its whole-change review and closure do not rely on this round limit.

| ID | Layer | Finding (short) | Verdict | Evidence / disposition |
|---|---|---|---|---|
| R3B1 | blind | round-2 log claimed comment repairs that were never applied | low | Real (my log overstated the disposition; the stale comments remained). Patched: service.ts + board.ts comments actually repaired now; log row stands as made true. |
| R3B2/R3VG-other | blind + VG | spec Code Map described the pre-R2B7 alarm shape | low | Real artifact drift. Patched: Code Map names `TERMINAL_JOB_STATUS_LIST` and its consumers. |
| R3B3 | blind | baseline omitted the pin-only suite without disclosure | low | Real. Patched: the scope comment names the deliberate pin-only exclusion (a base overlay would fail on final pin counts, not behavior). |
| R3VG1/R3B7 | VG + blind | the round-2 focus fallback had no regression test | medium | Real (revert ships green). Patched: DOM test focuses the binned disclosure, pushes a binned-free snapshot, asserts focus lands on the COLD shortcut. |
| R3VG2 | VG | delivered-then-binned report non-supersession unpinned | medium | Real. Patched: backfill test delivers findings, bins the lane, asserts the older debt stays `obligation-opened`. |
| R3B8 | blind | `jobFailing`'s binned arm unpinned | low | Real. Patched: the DOM binned row asserts no `board-job--alert` even with an aborted newest round. |
| R3B9 | blind | `binnedExpanded` vanish/reappear behavior undecided | low | Real ambiguity. Decided and pinned as the existing session-disclosure convention (state survives pushes; collapse survives vanish/reappear). |
| R3B10 | blind | board-engine test title no longer described the contract | low | Real. Patched (title names merged/done/binned). |
| R3B11 | blind | `docs/LEDGER.md` machine block taught two terminal sets | low | Real. Patched. |
| R3B12 | blind | OPERATIONS 200 bullet omitted the COLD count-only precondition | low | Real. Patched. |
| R3B13 | blind | terminal comments in rebrief-recovery/branch-idle stale | low | Follow-up on untouched code; fixed opportunistically in the same commit (comment-only). |
| R3B4 | blind | terminal merge-skip records no durable trace of the observed merge | low | Closed by this PR's independent review repair: an existing in-flight poll that genuinely observes a merge after binning records one `github.pr-merged` receipt with `applied:false`, leaves status binned, and dedupes retries. Already-binned jobs are NOT tracked or polled afresh (terminal/no-poll ruling); guaranteed future discovery was never part of the contract. |
| R3B5 | blind | report-debt supersede can never fire for a discarded target | low | Closed as not a defect under the owner-confirmed fail-closed rule: `reportSupersedeReason` still requires independent actual merge/head evidence; an in-flight observed merge now provides such evidence, while an unobserved later merge cannot be inferred from binned status/URL. The report debt remains owed until actual proof or an authorized owner disposition. Deterministic no-proof/proof tests pin both branches. |
| R3B6 | blind | TRACKERS KPI strip has no binned bucket | low | Closed by this PR's independent review repair: the existing shared `jobStatusCounts` and TRACKERS rail now include an explicit binned field and test. Sibling worktree was not edited. |

The historical round-3 convergence note described the earlier run, not this independent fix-all pass. Its three binned-related dispositions are reconciled above; none remains deferred after the owner-confirmed no-poll/no-fabrication decision and the in-flight observation/KPI repairs. No other deferred-work item is pulled into this PR.

### Independent fix-all closure evidence (local, not native Perkins)

Coordinator handoff: external `ownership-handoff.json` at the frozen review directory, checked 2026-10-07T13:07:56Z; original minion was disposed, PR worktree clean and exclusive writer wAA:p2. The four independent child reports and per-item triage are in the same directory. No job was binned or service restarted. Owner ruling for R3B4/B5: a binned lane is not polled after discard. Only a real merge from an already-running poll may be logged as no-effect; absent proof, report debt remains owed, not automatically superseded. The previous three binned-only deferred rows were removed from `deferred-work.md` because their actual disposition is now closed, not shelved.

Fail-before at the repair start: new ledger/HTTP tests failed (binned `addRound` accepted and HTTP returned 201); new web KPI/rail tests failed (`binned` missing and TRACKERS bucket undefined). After fixes: local `binned-focused`, `binned-heavy`, `binned-static` all exit 0; isolated `binned-baseline` exits 1 **only after** named backend and web assertions failed (classifier rejects setup/import errors with exit 2); logs `/tmp/pr247-binned-{focused,heavy,static}-local.log`, `/tmp/pr247-baseline-local.log`. Local `npm test` exit 0: fast 2272 passed/11 skipped, heavy 908 passed/6 skipped, web 525 passed. Local `npm run e2e` final exit 0: 75 passed; the first run had two expected light screenshots changed by the explicit TRACKERS field and one isolated epoch test failure, which passed on immediate focused rerun; refreshed four light/dark theme snapshots were visually checked for intact rail/layout and then the full E2E suite passed. These are local commands against this checkout, NOT authenticated `/api/verify` receipts and NOT native Perkins READY.

### Final-candidate review of e85c24b, operator clarification and dispositions

Read-only workflow `637af248-014f-4758-adbc-c5cfa42cd155` examined the entire 76-file `84aec28..e85c24b` change, without exclusions: blind `17348257-41af-4015-ae51-34d287b77d37`, edge `b2340453-78d3-4aec-a6f1-dcfd1c5b4aee`, verification `2dd79a3f-b0af-4e39-9fa8-12b27703de96`, acceptance `fe4e6360-94dd-432a-b2f5-02c9aa330a4d`; all explicit `openai-codex/gpt-6-sol`, fresh and read-only. Blind/edge saw the diff without spec/claims; verification/acceptance received the repair decisions, verification paths and the direct operator clarification. Reports: external `bmad-pr247-final-e85c24b56a70-2UOOjc/{blind-hunter,edge-case-hunter,verification-gap,acceptance-auditor}.md`. Quota was not padded.

| Grounded final finding | Disposition and deterministic proof |
|---|---|
| Gru had no shipped bin action, and status alone could bin a live producer | **REPAIRED** under direct operator clarification. `roles/gru.md` now teaches intentional auth `POST /api/jobs/<job-id>/status` with `{ "status": "binned" }`, no automatic binning, no new endpoint; the existing bash permission and Pi/Claude role-prompt loading provide the action. `LedgerApi.setJobStatus` refuses binned inside its transaction when target-owned workers, children, rounds or verification remain live; an idle working job remains eligible. `test/board-server.test.ts` derives the request from the actual loaded role, proves unauthenticated refusal, live refusal without event, then successful authorized discard, preserved history, abandonment settlement, and no revival. It was RED first for absent Gru instructions and then for 200 instead of 400 on a live worker; passed after repair. |
| In-flight CI failure after binning could post live action-required attention | **REPAIRED**. Only an already-fetched genuine merge may record a no-effect receipt; other non-merge signals are ignored once the job is terminal. `test/github-poll.test.ts` captured a true assertion-red (one stale CI event vs zero) and passed after the guard. No new provider calls, polling or closeout. |
| Fail-before verifier accepted mixed setup failure and named pre-assertion exception | **REPAIRED**. Classifier rejects any failed suite-level collection/setup result and requires an `AssertionError` from a named test. Backend selected named HTTP behavioral assertion, not an early unknown-status exception. Dedicated test captured RED first; both isolated baseline legs subsequently emit named assertion RED and the script exits 1 by design. |
| `board-rail.test.ts` omitted from focused and baseline scopes | **REPAIRED**. Both web command lists and the baseline overlay include it; focused web suite and fail-before scope re-executed. |

The binned live-producer guard made five old fixture setups invalid; those fixtures now mark historical agents idle before discarding, or assert that a queued child must finish and its producer be disposed BEFORE binning. Earlier `npm test` returned nonzero solely at the installed-layout gate because `roles/gru.md` was uncommitted; no source-test failure is concealed. Commit the new immutable candidate, then rerun full static, fast, heavy, web and E2E evidence. The first earlier full E2E attempt remains a real failed run (72 passed / 3 failed: two theme snapshots plus one epoch assertion); the isolated epoch rerun passed, four baseline images were updated and visually checked, and the following full E2E run passed 75. Before/after light and dark mock/real PNGs are preserved under external `bmad-pr247-final-e85c24b56a70-2UOOjc/snapshot-evidence/{before,after}/`. The mock pair adds the binned TRACKERS bucket and reflows a chip line without clipping; the real pair also updates an already-shipped six-section layout whose stale baseline still showed the old empty-board placeholder. The masked magenta deploy region is existing test masking; no visual-test tolerance was relaxed. This evidence is local and cannot be called native Perkins READY.

## Design Notes

- Binned rows classify into COLD (the existing sink for terminal/discarded lanes): the six-section hierarchy and previews stay untouched, and the Cold head count already carries the complete count. The binned rows render only inside an explicitly expanded Cold section AND behind a second explicit "binned records" disclosure; the control's label carries the count so the filter can never silently lose them.
- `binned` is a closed receipt exactly like `done`: `prState` presents `null` (no open-PR claim, no fabricated merge), needs-Gru causes are suppressed, bound notification rows classify as receipts. This is a projection decision, not evidence: binning never asserts the PR's real state.
- Obligations close with `{kind:'job-terminal', jobStatus:'binned'}` — abandonment semantics, never an executed/settled-success claim.

## Verification

**Commands:** all via the authenticated `/api/verify` scheduler with the committed scopes in `.gru-command/worktree.toml` (plus the shipped capture helper for complete captures):
- `binned-focused` -- the fast suites: ledger machine/obligations/API audit, board engine v4 + shared live/receipt fixture, pipeline milestones + exclusive scopes, amendments, directive intents, provider recovery, phase handoffs, chat awareness, GitHub merge polling, report backfill and durable reconcile, Silas release rows, yield telemetry, child workers, baseline-classifier assertions, suite pins, plus the web board suites.
- `binned-heavy` -- the filtered process-heavy cases the change touches under `vitest.heavy.config.ts`: perkins `runRound`/handoff-skip, dispatch directive/re-brief refusals, branch-idle terminal refusals, worktrees-server sweep-ack release.
- `binned-static` -- `node tools/patch-vitest-rpc-timeout.mjs && npm run lint && npm run typecheck && npm run build && cd web && node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
- `binned-baseline` -- isolated pre-change snapshot (base `84aec28b04ddc406f26c458383452318f8cb7ed1`) with the FINAL fast-suite test bytes (and the shared fixture) overlaid; expected RED on named backend and web behavioral assertions. The JSON receipt classifier rejects import/setup-only failure (exit 2), preserving the intentionally RED exit 1 only after both legs prove their own assertions. The heavy suites' fail-before is covered by `binned-heavy` at the fix head, not re-hosted on the base.

**Manual checks:** board DOM fixture tests cover the badge/disclosure/count/accessibility behavior; the tracked review jobs verify the whole change at the immutable head.
