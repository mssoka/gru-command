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

**Approach:** Add a terminal `binned` job status. It is legal from every existing non-terminal status (`dispatched`, `working`, `delivered`, `in-review`, `blocked`, `parked`), illegal from `merged`/`done`, and has no outgoing/resumption edges — it is recognized by the same terminal contract as `merged`/`done` (obligation closure as abandonment, closed-receipt board projection, no resumable implementation/review offers). No new endpoint: the authenticated `POST /api/jobs/<id>/status` surface picks it up. The board shows binned rows with an accessible distinct Binned badge in the Cold section behind an explicit disclosure; the prior status and all history stay on the record and the rows remain inspectable.

## Boundaries & Constraints

**Always:** binning preserves the prior status and all historical evidence (`job.status` from→to event, row history, rounds, lane, obligations closed as `job-terminal` abandonment — never a success claim); terminal recognition flows through the shared declaration (`JOB_TERMINAL` / `isJobTerminal` / `TERMINAL_JOB_STATUSES`) and every consumer that gates resumable work treats `binned` as terminal exactly like `merged`/`done`; the board hierarchy For you → In flight → Pipeline → For Gru → Settled → Cold, complete counts, previews 5/5/3, collapsed For Gru/Cold and count-only Cold stay intact, with binned rows staying in Cold and counted there; ordinary parked/done/merged rows (including the administrative Done from PR246) keep their distinct meanings and projections; malformed, unauthenticated or illegal requests fail without partial mutation.

**Never:** no new endpoint, restore/unbin feature, job migration, automatic live closeout, supervision/dispatch/runtime/worktree redesign, new runtime dependency, or resource-limit change; no relabeling of done/merged as binned; no inferring READY/PASS/merge from terminality; no weakening or skipping existing tests and pins; no touching sibling worktrees; never present a caller-provided `by` as authentication.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LEGAL_TRANSITION | any of `dispatched`,`working`,`delivered`,`in-review`,`blocked`,`parked` | transition to `binned` lands; row `binned`; `job.status` event `{from: prior, to: binned}`; prior hops preserved | N/A |
| ILLEGAL_SOURCE | `merged` or `done` | request refused, no row/event/obligation change | throw `illegal transition <from> → binned`; HTTP 400 `bad_request` |
| ILLEGAL_RESUME | `binned` | any other status refused, no mutation | throw `illegal transition binned → <to>` |
| OBLIGATIONS | lane with open/waiting/suspended obligations → `binned` | same transaction settles applicable obligations `{kind:'job-terminal', jobStatus:'binned'}`; settled history untouched | N/A |
| API_AUTH | POST status without/with bad token, even with `by` in body | 401 `unauthorized`; no mutation | typed 401 |
| API_MALFORMED | unknown status string | 400 `bad_request`; no mutation | typed 400 |
| BOARD_DEFAULT_HIDE | mixed snapshot with binned rows | binned rows absent from the rendered default view; explicit binned disclosure reveals them with the badge; non-binned cold rows unchanged; count includes binned | N/A |
| BOARD_EMPTY | snapshot without binned rows | no binned disclosure control; rendering unchanged | N/A |

</frozen-after-approval>

## Code Map

- `src/ledger/states.ts` -- `JOB_STATUSES`, `JOB_TERMINAL`, `JOB_TRANSITIONS`; `TERMINAL_JOB_STATUSES` derives from `JOB_TERMINAL`. Keep the existing declaration shapes (the web cross-build alarm parses `JOB_TERMINAL`).
- `src/ledger/api.ts` -- `setJobStatus` calls `closeApplicableObligations(id, status)` for terminal targets; amendment/directive guards refuse terminal lanes (`isJobTerminal`).
- `src/ledger/obligations.ts` -- `job-terminal` settlement kind/parse: `jobStatus: 'done' | 'merged' | 'binned'`.
- `src/board/engine.ts` -- `prStateOf` (binned = closed receipt, null), `concludedJobs` receipt set, `isClosedReceipt`.
- `web/src/lib/board-protocol.ts` -- `jobStatusTone`/`jobChipTone`, `isJobConcluded` (binned terminal; alarms read the ledger declaration).
- `web/src/lib/board-bands.ts` -- `bandForJob` explicit binned → cold.
- `web/src/lib/board-kpi.ts` -- `derivedPrState` (binned = no open claim).
- `web/src/ui/board.ts` -- binned chip/dot; Cold binned disclosure + filter; binned job body keeps full round history.
- `web/src/styles/components.css` -- `.pp-chip--binned` + `.board-job__dot--binned` only, existing tokens.
- `src/dispatch/server.ts`, `src/dispatch/perkins.ts`, `src/dispatch/github-poll.ts`, `src/dispatch/silas-driver.ts`, `src/dispatch/obligations.ts`, `src/provider-recovery/resume.ts`, `src/provider-recovery/sensor.ts`, `src/chat/awareness.ts`, `src/telemetry/yield.ts` -- terminal checks must include `binned` (the no-resume / no-resurrection fences).
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

**Acceptance Criteria:**
- Given each non-terminal status, when `setJobStatus(id, 'binned')` runs, then the row is `binned`, the `job.status` event records `<prior> → binned`, and prior events remain.
- Given `merged` or `done`, when `binned` is requested, then it throws `illegal transition` and neither the row, the events nor obligations change.
- Given `binned`, when any resume/terminal-hop status is requested, then it throws and nothing changes.
- Given the authenticated HTTP status surface, when a binned transition is requested validly, then 200 + audit event; unauthenticated (even with `by`) → 401; malformed → 400; illegal → 400 — all with no partial mutation.
- Given a mixed snapshot, when the board renders, then binned rows are hidden by default behind an explicit labeled disclosure, render with an accessible distinct Binned badge when revealed, stay fully inspectable with complete history, and counts include them without changing the six-section layout or previews.
- Given empty or binned-free snapshots, when the board renders, then no binned control appears and ordinary parked/done/merged projections are unchanged.

## Implementation Notes

- Workflow state: lane-local BMAD `bmad-build` render `_bmad/render/bmad-build/job-job-status-binned-continuation-20261006-0e52e101bc06/f76b749a098f5191ee57/`. Step-02 was executed against base `84aec28b04ddc406f26c458383452318f8cb7ed1` (equals observed remote main). Checkpoint 1 is auto-resolved under the dispatch briefing's explicit authority (`job-status-binned-continuation-20261006` is the sole owner of investigation/spec, implementation, built-in independent review, fixes, authenticated verification and PR as one complete build); no human is present in the lane. Status set `in-progress`, baseline pinned.
- No subagent runtime is exposed to this lane's tool surface, so implementation is done directly from the spec (step-03's documented fallback); the built-in review runs as fresh tracked review jobs through `POST /api/dispatch` per the playbook.
- Implementation commit `6cd0dd2c5a6e05b236a6a256d7c2fac3d79a0054` (spec `472d0f9`). `binned-static` PASS at 6cd0dd2 (lint/typecheck/build/web tsc, exit 0, capture `_bmad-output/binned-verify/binned-static-6cd0dd2.ndjson`, receipt sha256 1b8d5df7…). `binned-focused` PASS at 6cd0dd2 (backend 144 tests, 5 files; web 179 tests, 5 files; exit 0; capture `_bmad-output/binned-verify/binned-focused-6cd0dd2.ndjson`, receipt sha256 f0542a55…). `binned-baseline` RED at both legs as designed (backend 5 failed/137 passed; web 5 failed/174 passed; exit 1; capture `_bmad-output/binned-verify/binned-baseline-6cd0dd2.ndjson`, receipt sha256 b1a33a4c…) — failures are the new assertions at the pre-change base (unknown status "binned", assertion mismatches), never setup/compile failures.
- Closed-receipt projections are deliberate: binned → `prState` null on both server and web (never an open-PR claim), needs-Gru suppressed, bound notification rows are receipts, obligations settle `{kind:'job-terminal', jobStatus:'binned'}`. Terminal fences in dispatch/provider-recovery/chat/telemetry now route through `isJobTerminal` so a binned lane can never be re-briefed, amended, directed, reviewed, re-dispatched or resurrected by a later merge signal.
- Board filter: binned rows stay in COLD (complete count) and render only inside the expanded Cold section behind a second explicit `Show N binned records` disclosure; the badge is a dashed muted chip + dot with the visible word `binned`; the binned body keeps ALL rounds (merged/done stay quiescent).


## Spec Change Log

## Review Triage Log

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

## Design Notes

- Binned rows classify into COLD (the existing sink for terminal/discarded lanes): the six-section hierarchy and previews stay untouched, and the Cold head count already carries the complete count. The binned rows render only inside an explicitly expanded Cold section AND behind a second explicit "binned records" disclosure; the control's label carries the count so the filter can never silently lose them.
- `binned` is a closed receipt exactly like `done`: `prState` presents `null` (no open-PR claim, no fabricated merge), needs-Gru causes are suppressed, bound notification rows classify as receipts. This is a projection decision, not evidence: binning never asserts the PR's real state.
- Obligations close with `{kind:'job-terminal', jobStatus:'binned'}` — abandonment semantics, never an executed/settled-success claim.

## Verification

**Commands:** all via the authenticated `/api/verify` scheduler with the committed scopes below (plus the shipped capture helper for complete captures):
- `binned-focused` -- `node tools/patch-vitest-rpc-timeout.mjs && npx vitest run test/ledger-api.test.ts test/ledger-obligations.test.ts test/board-engine-v4.test.ts test/board-server.test.ts test/suite-shape.test.ts && cd web && ../node_modules/.bin/vitest run src/lib/board-signals.test.ts src/lib/board-kpi.test.ts src/lib/board-bands.test.ts src/lib/board-sections.test.ts src/ui/board.test.ts`
- `binned-static` -- `node tools/patch-vitest-rpc-timeout.mjs && npm run lint && npm run typecheck && npm run build && cd web && node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
- `binned-baseline` -- isolated pre-change snapshot (base `84aec28b04ddc406f26c458383452318f8cb7ed1`) with the FINAL behavioral tests overlaid; expected RED on the new assertions.

**Manual checks:** board DOM fixture tests cover the badge/disclosure/count/accessibility behavior; the tracked review jobs verify the whole change at the immutable head.
