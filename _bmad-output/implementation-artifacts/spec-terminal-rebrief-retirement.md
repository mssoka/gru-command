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
- Implemented by the lane minion directly (no subagent capability in this runtime). Red phase: `test/rebrief-recovery.test.ts` + `test/ledger-api.test.ts` → 9 failed / 31 passed (only the new cases). Green phase after implementation → 40/40; `test/dispatch-server.test.ts` 20/20 and `test/suite-shape.test.ts` 2/2 at the lane head. Evidence transcripts: `/tmp/terminal-rebrief-evidence/{red-phase,green-phase,seam-tests}.log`.
- Inherited (pre-existing at baseline c54bfbf) suite-shape drift reconciled as part of the pin task: `owner-actions.test.ts` was absent from PINS (actual 8) and `github-poll.test.ts` was pinned 22 vs actual 24. Both are mechanical test-count pins; #136 fixes the same drifts independently (its `owner-actions` count is 28 because its branch grows that suite). Revalidate the `owner-actions.test.ts` line if #136 merges first.
- No deviations from the spec's frozen block; no schema change; no notification path added.

## Verification

**Commands:**
- `npx vitest run test/rebrief-recovery.test.ts test/ledger-api.test.ts` -- expected: new cases fail pre-change, pass after.
- `npm run lint && npm run typecheck` -- expected: clean.
- `npm run build` -- expected: clean.
- Full suite + `/api/verify`: coordinated with Silas at a media/process-safe checkpoint (>=36GiB free); not run by this lane.

**Manual checks:** keep the pre-change red transcript and post-change green transcript in the completion report; confirm no live-ledger run.
