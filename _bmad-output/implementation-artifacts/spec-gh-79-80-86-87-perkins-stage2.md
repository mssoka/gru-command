---
title: 'Stage 2 — durable Perkins review outcomes and accounting (#79, #80, #86, #87)'
type: 'bugfix'
created: '2026-10-04'
status: 'done'
route: 'dispatch'
baseline_commit: '3c2db0ed0b4d7db1e69a42901e5ff21144c01d62'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Four independent exception paths in whole-PR Perkins reviews lose delivery truth, refund executed specialist attempts, replace accepted terminal outcomes with cleanup errors, or make terminal publication unretryable. These errors conceal work or prevent a completed review from being reported accurately.

**Approach:** Preserve settled results and consumed attempts before fallible evidence/cleanup operations; keep undelivered findings marked as such; make an identical partial terminal publication recoverable while rejecting changed content; preserve the accepted result across lead cleanup failure with visible failure evidence. Implement all four issues serially with distinct regressions and separable commits.

## Boundaries & Constraints

**Always:** Keep Stage 1 execution/reattachment behavior, 2 attempts per lens, 16 specialist runs per round, terminal submission bounds, write-once protection against changed bytes, rejected-output evidence and valid-result checks. Only true not-started work can be refunded. Do not silently swallow artifact or cleanup errors; distinguish evidence-write failure from invalid specialist output. Existing oversize nondelivery and T13 cleanup semantics must remain intact. No merge, deployment, service restart, or issue closing.

**Never:** No Stage 3 cross-round reuse, Stage 4 admission changes, blanket artifact retries, arbitrary new timeouts, changed review policy, relaxed findings validation, or fallback PASS. Do not modify the unrelated dirty `main` worktree.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| #79 | A valid sibling settles; another causes a batch rejection | Valid run recorded with `findingsDelivered:false`, including in a later sealed `consolidated.json` | Lead sees batch error, not undelivered findings |
| #80 | A started child fails, then its primary `.error.json`/`.envelope.json` write rejects non-EEXIST | Its attempt and started count remain consumed; failure and evidence-recording gap retained in best available durable accounting | No fake success or refund; actual artifact error remains visible |
| #86 | A lead seals accepted output, then `dispose()` rejects | Return the accepted record; store a distinct lead dispose-error artifact or equivalent durable note | Without a settled outcome, disposal error still propagates |
| #87 | First terminal attempt writes report but fails before consolidated write | Byte-identical second submission finishes and seals | Different report bytes still fail loudly; no overwrite |

</frozen-after-approval>

## Code Map

- `src/dispatch/perkins-review/whole.ts` — `runSpecialist` writes failure artifacts before `settled` exists; `pool` returns undefined on rejection; `runTool`'s batch-error stamp is overwritten by `commitSettled`. `submitTool` writes attempt/report/consolidated sequentially and increments `terminalAttempts`; `run` finally awaits lead disposal after returning `accepted`. Preserve specialist T13 disposal handling and Stage 1 transport-aware wait.
- `src/dispatch/perkins-review/artifacts.ts` — `writeReviewArtifact` uses atomic hard-link write-once (`EEXIST`), symlink/path guards; reuse for terminal retry only after safe exact byte comparison. Do not relax global write-once behavior.
- `test/perkins-whole-review.test.ts` — `wholeHarness`, T13 settle/receipt tests, R17 oversize nondelivery, two-attempt terminal bound; add per-issue deterministic failure injection.
- `test/helpers/perkins-whole-double.ts` — `WholeLeadOptions` supports per-child failures, `disposeRejects`, `submitRetries`/`submitPayload`, and `beforeSubmit`; add narrow hooks only when required for reliable test injection.

## Tasks & Acceptance

**Execution (one writer; commit each issue separately in #79 → #80 → #86 → #87 order):**
- [x] `test/perkins-whole-review.test.ts` (and `test/helpers/perkins-whole-double.ts` only if needed) — write distinct fail-before regressions for each matrix row, including sealed outcomes, attempt accounting, and no-settlement disposal.
- [x] `src/dispatch/perkins-review/whole.ts` — fix #79 nondelivery commit ordering without changing oversize response handling.
- [x] `src/dispatch/perkins-review/whole.ts` — fix #80 failure settlement/evidence-write boundaries without refunding executed children; disclose recording gaps.
- [x] `src/dispatch/perkins-review/whole.ts` — fix #86 lead disposal after acceptance; preserve rejection before settlement and expose cleanup error.
- [x] `src/dispatch/perkins-review/whole.ts` — fix #87 report retry only for identical bytes, not changed content; preserve terminal attempt cap.

**Acceptance Criteria:**
- Given the four injected exception paths, when a review finishes or rejects, then its persisted specialist run statuses, delivery flags, attempt counts, and terminal outcome match what actually happened.
- Given existing oversize, T13, invalid submission, and Stage 1 transport cases, when their regression suites run, then their safety and accounting assertions still pass unchanged.

## Implementation Notes

- Issue-ordered fixes: `ff60ce53952f3b71d5950f31e361181a7f9ae648` (#79), `6304d53421a27bcf3206d97173a6c245f279d098` (#80), `30f07076640d795c0c49512ccb903b085b716163` (#86), `4d098d85fb8de9822b58362a6be622cc1bf82c81` (#87); #86 follow-up `3dbcd6a` preserves an accepted result when writing cleanup evidence itself fails, logging the gap.
- Per-issue regressions were red before their corresponding fixes. Independent review identified seven grouped issues; issue-scoped follow-ups `2ea14d8`, `f3605fa`, `783b490`, `cee4e57` addressed them. Final whole-review suite: 89/89; backend heavy: 616 passed/6 skipped; web unit: 408 passed; lint, typecheck and build pass. `npm test` still fails on the pre-existing Stage 1 scope-config error (`perkins-stage1-focused` missing heavy config; `test/test-budgets.test.ts:180`), and e2e still has five unrelated UI screenshot/reflow failures (46 passed). Neither is concealed or treated as a pass.
- Scheduled authenticated `/api/verify` full receipt, exact-head CI, independent review and native Perkins READY remain delivery gates; no credentials/job id were supplied and no gate was simulated.

## Spec Change Log

## Review Triage Log

- blind-1 `medium` (`patch`): #87 retry compares only report bytes at `whole.ts:1536`; changing structured findings while keeping report identical can seal inconsistent content. Frozen matrix requires an identical second submission; compare the prior published submission too.
- blind-2 `medium` (`patch`): `runSpecialist` calls `onProgress` after settling; a throwing callback can still reject the pool slot and refund an executed child. Guard post-settlement callback failure without suppressing execution accounting.
- blind-3 `medium` (`patch`): valid child output with failed evidence write falls into the invalid-output catch at `whole.ts:950–983`, misclassifying a storage failure; preserve valid outcome and disclose recording error.
- blind-4 `medium` (`patch`): existing valid raw/envelope followed by failed child write leaves the failure envelope collision ignored, with no fallback in `whole.ts:994–1017`; preserve the valid envelope and record the error path in a separate durable child artifact.
- blind-5 `medium` (`patch`): #80/#86 write-failure tests use mode 0500, which root can bypass; force deterministic failures through controlled filesystem shapes.
- blind-6 `false` (reject): verification section lists commands with intended success, while Implementation Notes already state `npm test` and e2e failed and remain delivery gates. Proposed fix edits this build's spec, which review rules reject.
- edge-1 `medium` (`patch`): same root cause as blind-1; structured findings can change without report bytes changing.
- edge-2 `medium` (`patch`): same root cause as blind-5; chmod is not deterministic under privileged CI.
- gap-1 `medium` (`patch`): #80 test checks only fallback child file presence; parsing and asserting its contents is necessary to prove the sole partial-round durable accounting artifact.
- gap-2 `low` (`patch`): #87 tests do not distinguish byte comparison from a lossy `trimEnd` implementation; add whitespace-only changed-report case and assert unchanged original bytes.

## Design Notes

Do not generalize artifact idempotence: read and compare the existing report only at the terminal retry boundary, with ordinary writes still failing EEXIST. Favor a settled failed-result record in memory before best-effort failure artifacts, then persist the best available audit state where storage permits; never reclassify an executed child as `neverRan` because an evidence write threw.

## Verification

**Commands:**
- `npx vitest run test/perkins-whole-review.test.ts` — issue regressions pass, each first reproduced red against its preceding state.
- `npm test` and `npm run e2e` — quality gates pass if environment supports browser e2e.
- Run the scheduled `/api/verify` full gate at the exact final head per the Stage 2 briefing; retain raw/decoded receipts and head binding. Independent exact-head review, CI and native Perkins READY remain delivery gates, not simulated by a local PASS.
