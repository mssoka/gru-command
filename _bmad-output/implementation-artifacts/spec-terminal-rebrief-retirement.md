---
title: 'Audited retirement of stale re-brief requests on terminal jobs'
type: 'bugfix'
created: '2026-09-30'
status: 'in-review'
route: 'dispatch'
baseline_commit: 'c54bfbf89727bacfd27a27db65a9fab681c19c3e'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A re-brief admitted while a job was nonterminal can outlive the job. When the job later reaches `merged`/`done`, boot reconciliation still sees the pending marker pair; `redispatchGroup` refuses the terminal lane, so the request is preserved and escalated `action-required` again at every boot (live: merged `board-for-you-owner-actions`, `perkins-whole-pr-review`, 2026-09-30 08:03Z), while the delivery-only shortcut could otherwise fabricate a `job.delivered` from terminality. No audited disposition exists for the obsolete markers.

**Approach:** At boot, a terminal job's pending re-brief markers are administratively retired: one `silas.rebrief-retired` audit event carrying the request identity (ids, kinds, payload hashes, baseline watermarks, worker/session refs) and the terminal reason commits in the same transaction as the identity-checked marker deletion. No spawn/resume, no fabricated guarded events, no reopen, no new action-required alert. Admission and finalization recheck the job boundary and fail closed; nonterminal jobs keep every existing recovery path.

## Boundaries & Constraints

**Always:**
- Retire only a `merged`/`done` job's markers, and only when at least one guarded event is unlanded; deletion is conditional on the examined identity (marker id + kind + payload hash + baseline watermark), so a newer request generation is never erased and replays are no-ops.
- Audit event + deletion are one transaction (`retirePendingRebriefs`). `clearPendingRebriefs` stays the events-landed success path, not a cancellation.
- `beginPendingRebrief` rechecks terminal status inside its own transaction (the installed HTTP guard stays); recovery and finalization recheck the job before spawning/recording.
- Blocked/parked/held jobs, missing jobs, malformed markers: existing honest recovery/escalation unchanged. Retirement posts no notification.

**Never:** spawn/resume/kill workers for terminal requests; fabricate `job.delivered`/`silas.rebrief`; reopen status; post an action-required alert for retirement; schema migration, new endpoint, daemon/timer, dependency; live-ledger run; touch the review-eligibility interlock, #136 directive family, UI/board, cancellation classification, owner alert disposition, or other lanes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Terminal pair, events unlanded | boot reconcile, job merged | one audit event + both markers deleted; 0 workers; 0 alerts | N/A |
| Only `job.delivered` remains | merged job, `silas.rebrief` landed | administrative retirement; no fabricated delivery | N/A |
| Repeated/concurrent pass | markers gone after first retire | next pass examined 0; exactly one audit event | N/A |
| Newer marker generation | candidate ids replaced before retire | skipped, not deleted; no audit for the old snapshot | caller logs skipped ids |
| Terminal flip mid-turn | worker gated, job merged, then turn settles | finalize retires; no guarded events; artifacts preserved | N/A |
| Admission race | HTTP guard passed, job merged before marker write | `beginPendingRebrief` throws; no markers written | named error to caller |
| Nonterminal / missing / malformed | blocked, parked, absent job, bad row | existing redispatch/escalation unchanged | escalate as today |

</frozen-after-approval>

## Code Map

- `src/ledger/api.ts` -- add `PendingRebriefRetireCandidate`/`PendingRebriefRetirement` + `retirePendingRebriefs` (atomic audit + identity-checked delete, terminal recheck); harden `beginPendingRebrief` inside `this.transaction`. Reuse `transaction`/`appendEvent`/`listPendingRebriefs`; leave `clearPendingRebriefs`/`bindPendingRebriefWorker` alone.
- `src/dispatch/rebrief-recovery.ts` -- `reconcilePendingRebriefs`: retire non-empty missing sets on terminal jobs before the delivery-only shortcut; add `retired` to `ReconcileReport`. `redispatchGroup`: terminal refusal retires, not throws. `finalizeRebriefRequest`: retire when the job went terminal; skip `silas.rebrief-recovered` then.
- `src/dispatch/server.ts` -- surface disposition (response field + log); keep the installed guard.
- `src/main.ts` -- log `retired` beside existing counters.
- `test/rebrief-recovery.test.ts` -- boot retirement (pair + delivery-only), repeated-pass idempotence, gated mid-turn race, terminal-vs-unrelated separation, nonterminal preservation.
- `test/ledger-api.test.ts` -- terminal intake refusal, atomic retire + replay no-op, newer-generation identity guard.
- `test/suite-shape.test.ts` -- bump pins for edited test files.

Shared seams if main/#136 moves: #136 appends directive reconciliation to `rebrief-recovery.ts` and adds ledger APIs; review-rebrief-interlock owns review eligibility — do not touch those regions.

## Tasks & Acceptance

**Execution:**
- [x] `src/ledger/api.ts` -- retirement types/method + terminal intake check -- the only seam allowed to delete markers as cancellation.
- [x] `src/dispatch/rebrief-recovery.ts` -- reconcile/finalize/redispatch terminal branches + report field -- boot and turn boundaries.
- [x] `src/dispatch/server.ts`, `src/main.ts` -- surface disposition -- truthful operator log/response.
- [x] `test/rebrief-recovery.test.ts`, `test/ledger-api.test.ts` -- deterministic tests (fake ledgers/registries, gated promises; no sleeps) -- prove fails-before/fixes-after.
- [x] `test/suite-shape.test.ts` -- bump pins -- phantom-check guard.

**Acceptance Criteria:**
- Given a merged job with an admitted pending pair, when boot reconciles, then markers are deleted with exactly one `silas.rebrief-retired` audit (ids/kinds/hashes/watermarks/agent/session), no spawn, no guarded events, no new action-required alert, job stays merged.
- Given a restarted/concurrent pass or a replaced marker generation, then no duplicate retirement, no partial unaudited deletion, no erased newer request.
- Given a terminal flip during finalization or an admission race, then no event recording/reopen/spawn; failed boundary checks leave markers to existing escalation.

## Design Notes

- Spent markers (all guarded events landed) keep the `clearPendingRebriefs` success path: the request was honored, so calling it a cancellation would be untruthful.
- Audit payload per marker: `id`, `kind`, `payload_hash`, `baseline_seq`, `note`, `agent_id`, `session_file`, `requested_at`, `guarded_event_landed`; job-level: `job_status`, `reason`, `skipped_ids`. No notification carries marker internals.
- `retirePendingRebriefs` returns `{retired, recorded, skippedIds, refused}`; a refusal (`job-missing`/`job-not-terminal`) deletes and records nothing so boot never fails on a defensive boundary.

## Implementation Notes

- Checkpoint 1 approval is carried by the dispatched work order (this slice is pre-approved/staged; the dispatch briefing is the human intent). No Open Questions were raised; the full spec is kept (est. ~1900 tokens, over the 1600 proposal, single cohesive goal — splitting would be artificial).
- Implemented by the lane minion directly (no subagent capability in this runtime). Red phase: `test/rebrief-recovery.test.ts` + `test/ledger-api.test.ts` → 9 failed / 31 passed (only the new cases). Green phase after implementation → 40/40; `test/dispatch-server.test.ts` 20/20 and `test/suite-shape.test.ts` 2/2 at the lane head. Evidence transcripts (durable, in-tree): `_bmad-output/implementation-artifacts/terminal-rebrief-evidence/{red-phase,green-phase,seam-tests}.log` (the `/tmp/...` copies of the first note were ephemeral source copies).
- Inherited (pre-existing at baseline c54bfbf) suite-shape drift reconciled as part of the pin task: `owner-actions.test.ts` was absent from PINS (actual 8) and `github-poll.test.ts` was pinned 22 vs actual 24. Both are mechanical test-count pins; #136 fixes the same drifts independently (its `owner-actions` count is 28 because its branch grows that suite). Revalidate the `owner-actions.test.ts` line if #136 merges first.
- No deviations from the spec's frozen block; no schema change; no notification path added.
- Independent review receipts (not a conforming Perkins gate; not self-attested): three fresh same-model sessions ran the staged blind-hunter / edge-case-hunter / verification-gap prompts at pinned head `ba7f2d6`. Operational copies are preserved in the ops interlock sweep bundle `silas-interlock-0857-R2YFB9` (per-file hashes in its `independent-finding-artifact-preservation.json`); 11 + 3 + 3 findings + 1 other, triaged individually below as untrusted observations (every claim re-verified against the pinned code; the verification layer's recorded input-contract limit — it read its own clean base checkout beyond the strict supplied-only packet — means that layer is held non-conforming and none of its claims were pre-trusted).
- Exact-head CI receipts: run `36693133112` at `ba7f2d6` failed on the single inherited supervisor fixture race (`test/supervisor.test.ts:1132`, alert sampled after a fixed 50 ms while the 1/2/4 ms backoff rungs settle asynchronously; complete output preserved by the ops CI-failure capture for that run, sha256 `30404663f06753d2b4089657df39de52b28fd7d67839cab445d9fa58f73d517a`). Causal fix: the test now waits on the condition itself (`vi.waitFor`, this file's own convention) instead of a fixed real-time slice; no assertion weakened, no timeout raised, no semantics changed. Run `36697299977` at `ef5211` then failed on (a) the new administrative-retirement test asserting a null `job.delivered` where the initial dispatch turn's historical delivery (seq 6, source `dispatch`) is correctly retained, and (b) two personal absolute paths in these receipt notes. Both fixed in place: the test now proves no POST-boundary fabrication while preserving the historical event and terminal status, and the receipts are portable (second complete output sha256 `520de1d719d10a206c1f057f1fd9ed543ffca9969c9c29a239e4e70507db6d7f`).
- Full suite + native Perkins + exact-final-head CI remain owed gates; the two focused local runs are not a substitute and no READY/PASS is claimed.

## Review Triage Log

Every original finding is preserved and individually auditable in the preservation directory named above; verdicts were rendered after re-reading the pinned code (not from reviewer severity). Grouped dispositions follow the table.

| ID | Layer | Original finding (own anchor) | Verdict | Evidence / disposition |
|---|---|---|---|---|
| B1 | blind | `retired` flag conflates "terminal branch examined" with "retired" | false | The refusal/skip state is unreachable: the terminal branch requires a terminal, non-null job and the ledger re-read runs in the same synchronous section (no await, single writer); jobs are never deleted. Comment tightened to "actually retired". |
| B2 | blind | `skippedIds` never logged; spec promises caller logs skipped ids | low | Fact confirmed. All-skipped is defensive-only today, but the promised trace now exists: `warn` else-branch at both terminal call sites. |
| B3 | blind | `refused` outcome silently dropped at both call sites | low | Same root cause as B2; refusal unreachable (B1), now logged with `refused` + `skipped` instead of silence. |
| B4 | blind | terminal intake throws generic `Error`, not a typed "named error" | low | Message names job + status and is asserted; no consumer branches by type; HTTP fails closed with 400 either way. Adding an exported error class would widen the ledger public API against the mandate. Rejected, reason recorded. |
| B5 | blind | `guarded_event_landed` caller snapshot could go stale before deletion | false | Candidate construction and the retire transaction run in one synchronous section on the single-writer ledger; no event can land between them. |
| B6 | blind | no test covers the new HTTP retirement disposition | medium | Confirmed. Fixed: new `/api/silas/rebrief` test (gate turn → merge mid-turn → 200 + `retired:true` + `delivered_sha:null` + no fabricated events + retirement audit); `dispatch-server` pin 20→21. |
| B7 | blind | `redispatchGroup` terminal branch untested/unreachable | low | Unreachable only because the same-tick loop check precedes it; it is the fail-closed boundary the frozen intent requires ("recovery ... recheck the job at their boundary") and is documented in code. Keeping it. Rejected, reason recorded. |
| B8 | blind | `done` status never exercised | low | Confirmed. Fixed: new deterministic `done` test asserts a retired audit with `job_status:"done"`, no spawn, markers gone. |
| B9 | blind | suite-shape pin repairs bundled into this change | low | Fact; splitting a pushed commit needs rebase/reset (prohibited). Bundling is recorded here, in the commit body and in the PR body with the #136 merge-order caveat. Rejected, reason recorded. |
| B10 | blind | "no notification" asserted only for one family | low | Confirmed. Fixed: the terminal-pair and spent-marker tests now assert the whole notification log is empty. |
| B11 | blind | evidence cited `/tmp`; deferred suite/verify should be a merge precondition | low | Evidence was already preserved in-tree before the review; the Implementation Notes now cite the durable path. The deferred full gate is already stated as a precondition. |
| E1 | edge | `finalizeRebriefRequest` with a null job proceeds without a missing-job guard | false | Jobs have no deletion path; `pending_rebriefs.job_id` references `jobs(id)`; the pre-existing null-job behavior is unchanged for a state the service cannot produce. |
| E2 | edge | zero-retired runs drop `skippedIds`/`refused` silently | low | Same root cause/fix as B2/B3. |
| E3 | edge | duplicate candidate ids double-retire/double-audit | false | In-tree callers pass PK-unique marker sets from one listing; no caller can produce duplicates. |
| V1 | verification | endpoint retirement disposition has no test | medium | Independently re-verified against the pinned head despite the layer's non-conforming input limit; same fix as B6. |
| V2 | verification | audit `agent_id`/`session_file` refs carried by no test | low | Confirmed. Fixed: the boot-retire test now binds a worker/session and asserts both refs (and `note`) in the retirement audit. |
| V3 | verification | spent markers on a terminal job not pinned to the completed/clear path | low | Confirmed. Fixed: new spent-markers test asserts `completed:1`, `retired:0`, markers cleared, no retirement audit. |
| V-O | verification | caller never logs skipped ids (other finding) | low | Same root cause/fix as B2/B3. |

**Grouped dispositions (no loopback required — no intent_gap or bad_spec entries):**
- G1 (B2, B3, E2, V-O): low — patch applied (defensive disposition logging + truthful `retired` doc comment).
- G2 (B6, V1): medium — patch applied (endpoint test + pin).
- G3 (B8): low — patch applied (`done` test).
- G4 (V3): low — patch applied (spent-markers test).
- G5 (B10): low — patch applied (full notification-log assertions).
- G6 (B11): low — patch applied (durable evidence path in these notes).
- False with recorded reasons: B1, B5, E1, E3. Low rejected with recorded reasons: B4, B7, B9. Originals remain untouched in the preservation directory.

## Verification

**Commands:**
- `npx vitest run test/rebrief-recovery.test.ts test/ledger-api.test.ts` -- expected: new cases fail pre-change, pass after.
- `npm run lint && npm run typecheck` -- expected: clean.
- `npm run build` -- expected: clean.
- Full suite + `/api/verify`: coordinated with Silas at a media/process-safe checkpoint (>=36GiB free); not run by this lane.

**Manual checks:** keep the pre-change red transcript and post-change green transcript in the completion report; confirm no live-ledger run.
