# Bounded-stop handback — compaction-timeout-isolation (post-rollback reconciliation)

**Status: bounded stop for the original deadline-path acceptance (A/B); diagnostic regression scope delivered.**
This handback is the reconciliation exact-head review requested: the frozen acceptance criteria A/B require a fired adapter deadline and the identical fixture against its repair, but the owner-approved rollback of PR #137 removed that deadline from `main` before this lane's current artifact existed. No production timeout is reintroduced to satisfy stale criteria; the post-rollback decision is isolated to the owner (below).

## What was exercised

- Offline causal reproduction on the real installed `@earendil-works/pi-coding-agent` 0.85.1 `AgentSession` over the stub `ModelRuntime` (isolated temp dirs; no credentials, network, or live sessions).
- A live turn is driven into a real mid-run threshold compaction (`prepareNextTurnWithContext` → `_compactBeforeNextAssistantResponse`) whose summary stalls; the cancellation seam is then applied through the public SDK session:
  - broad `session.abort()` cancels the live turn (error events; the continuation never answers) — the 2026-09-30 incident shape;
  - summary-only `session.abortCompaction()` leaves the run live; the continuation answers and its successful reply is asserted on the event surface, in live SDK state, and in the durable session JSONL; the SDK's `compaction aborted` terminal publishes exactly once;
  - the complete external compaction-terminal list is asserted in every variant;
  - native SDK follow-up work is admitted while the run is live and before compaction opens, stays pending through the stall (`pendingMessageCount` 0→1→0, zero model calls), and delivers exactly once after summary-only cancellation (abort-settles and late-terminal modes);
  - late transports neither resurrect the cancelled run nor duplicate terminals; explicit dispose still rejects queued work and releases the lock; a committed chat reset releases its result, idle view, and delivery barrier while the retired handle's disposal is still held.
- Red/green history (preserved, superseded): the former deadline path's red evidence head `2e67213` (test-only) and the experimental product fix `b3681ce` remain reachable in branch history; the rollback superseded both as a production change.

## What hypothesis was refuted

- That A/B ("when the current deadline fires … the supported patch …") can be demonstrated on current `main`: **refuted**. The approved rollback (main `059c076`, PR #147) deleted `COMPACTION_DEADLINE_MS`, `abortNativeCompaction`, and the deadline call sites from `src/runtime/pi-adapter.ts`; PR #151 makes supervision wait out open native compaction with no second automatic deadline. There is no adapter deadline left to arm or repair, and re-adding it is forbidden without a new owner decision.
- What remains proven is the SDK cancellation boundary itself (above), pinned as a regression contract: any future or owner-controlled bound must cancel summary-only; the fixtures fail on broad cancellation at that seam.

## The one discriminating next decision (owner)

Whether any automatic compaction bound returns on `main`, and if so with what trigger and owner controls. `main` deliberately has none today (wait-out supervision). If a bound returns, this PR's fixtures are its guardrail. Until that decision, this artifact is tests/verification-declaration only and is not a claim of an adapter-timeout production repair.

## Verification receipt history (historical heads)

This document is committed at a revision it cannot name as its own successor; exact-target focused/typecheck/full/CI receipts for the reviewed head are supplied with the review (see the PR description) and are authoritative there. The entries below are HISTORICAL receipts for earlier heads, retained for the record and not carried forward as current-head clearance:

- Reviewed head `b0f5f3c1485d31d7590a77a6fed22ab79668763d` (base `main` `5d56194a905262231bb0d183292b6d08cbd70810`, merged history-preserving via `31a8fbc`): `compaction-timeout` run `cf38f639-6f9d-41cc-9e0e-6801e99b567e` exit 0; `typecheck` run `e37504c1-c7a6-43a3-ba02-eb0b1016c508` exit 0; `full` run `c52fade2-a00d-4a4a-bc1e-984df9f98170` exit 0 (1793 passed / 12 skipped + web 408 passed); CI run `37096293238` success; `trackedDirty` false on every run. (Superseded head.)
- Prior reviewed head `5e1eb1fd89b2d9c682c01423f8e2cc33a2511551`: same three scopes green; native round r3 returned READY TO MERGE (two non-blocking oracle warnings, since repaired).
- Preserved failures (no waivers): full-run attempts with unrelated 30-second host-contention timeouts and typed never-started `lock_wait_timeout` requests stay recorded as failed.

## Scope framing

- Deliverable class: bounded-stop handback per the original stop condition, plus the diagnostic regression fixtures/tests that survive the rollback.
- Not delivered (out of scope / owner-owned): reintroduction of any automatic compaction bound; adapter-timeout red-to-green evidence on current `main`; provider-stall cure claims.

## r7 follow-through addendum (2026-10-03)

Native round r7 (frozen `d1395b8dc6deb7d429c0bd320d12b08bc55dd6e3`, verdict-posted NEEDS CHANGES) raised one blocker and two warnings; all three are dispositioned on test-owned surfaces only, in the same lane/source. Round/head mapping from the ledger (authoritative): r3 READY @ `5e1eb1f`, r4 NEEDS CHANGES @ `b0f5f3c`, r5 READY @ `93692ce`, r6 READY @ `0dfb249`, r7 NEEDS CHANGES @ `d1395b8`. Corrections to the history above: the `b0f5f3c` receipt block records that head's scheduler runs, which native r4 then reviewed NEEDS CHANGES (repaired at `93692ce`) — those runs are historical, not clearance; the "r3 READY" entry for `5e1eb1f` is accurate but superseded by every later head.

### Blocker — the full gate was red at `d1395b8` (2 × 30 s test-body timeouts)

Complete `e19f81a7` output read (113293 B, sha256 `c38b0aea…`, 959 lines; preserved in the lane's ignored investigation evidence outside the tracked tree — the run id identifies it). Both failures were composite tests carrying two-plus budget-sized scenarios in one 30 s body:

- `install-one-line` "restarts only an owned service and refuses a foreign unit with the same public name" ran three full installer cycles (setup + foreign refusal + owned restart): CI nominal 3363 ms, 21146 ms in the ff4634c local FULL, 33291 ms timeout at `d1395b8`.
- `perkins-builtin-wave` T4 ran two full moved/aborted round fixtures: CI nominal 818 ms, 26554 ms local at ff4634c, 33724 ms timeout at `d1395b8`.

Repair (same oracles, no lowering, no skips, no added parallelism; the historical r7 run below used the unchanged 30000 ms default ceiling, and after the current-main integration these files run under the classified heavy runner — see the r8 section): each composite is split into per-scenario tests — `refuses a foreign unit with the same public name` + `restarts only an owned service unit`; T4a (moved) + T4b (aborted) with identical fixture setup and assertions. Evidence: scope `r7-timeout-cliff` run `833d78a3-4623-4dc7-bf01-8f5e631e3b8c` exit 0 (T4a 6562 ms, T4b 8577 ms, foreign 9942 ms, owned 11707 ms — all under the unchanged ceiling); sinks `r7-fix3-timeout-cliff-*`. The two intermediate focused reds (missing return wiring `4362c6ba…`; missing unit-dir mkdir `819e6d92…`) are preserved with their fixes.

### Warning — `lan-phone-w5` omitted its backend build prerequisite

Repaired: the committed scope now schedules `npm run build` (its fixture boots `dist/main.js`) before vitest, so a fresh lane cannot fail on absent dist and a reused lane cannot exercise stale backend output under a current-SHA receipt. Evidence: run `67a20167-efe3-4980-96c1-7fdb74b7b452` exit 0, 6/6 passed, build step visible in the capture; sinks `r7-fix3-lan-phone-w5-*`.

### Warning — late-summary probes lacked the post-cancel held-transport checkpoint

Repaired: both late-terminal cancellation probes (adapter queue and native SDK queue) now pin the interval AFTER cancellation and BEFORE releasing the summary — pending work still owed on the actual surface, zero model delivery, and prompt/steer/followUp refused by the admission guard — while retaining the deferred/final exactly-once terminals and the SDK-delegation oracles. Evidence: scope `compaction-timeout` run `d9d8ec7c-5b73-4b0d-9207-00dd8b0e0ddc` exit 0 (160/160) at the checkpoint head; final-head receipts at this document's shipping head are supplied with the review / PR description and are authoritative there.

### Fresh in-lane review and remaining gates

The bmad step-04 layers were re-run as fresh contexts on the merged diff (`20386e1`; outputs `review-20386e1-*`); their findings were triaged and the applied/rejected dispositions are logged in the spec's review triage log (T4b oracle parity, JSONL tail tolerance, chat exactly-once count, scope comments applied; rejected items evidenced there). Remaining gates: the final integrated head's focused/typecheck/FULL receipts, current-head CI, and exact-head native Perkins clearance. Merge stays owner-held.

### r8 reconciliation and current-main integration (2026-10-04)

Round r8 (frozen `d1395b8`, verdict-posted NEEDS CHANGES) raised one blocker and two warnings. The blocker (full gate red at `d1395b8`) was dispositioned by the r7 repairs above; the CI run on the repaired head `2d33967` confirms it cleared the timeout class — run `37135057205` finished 1869 passed / 9 skipped with exactly one failure. That single failure was this document: `scripts/hygiene-grep.sh` flagged an absolute personal evidence path on line 45 (the always-on hygiene gate, SPEC ruling 8). Repaired by removing the path from the tracked document; the same gate is locally clean (`scripts/hygiene-grep.sh` exit 0). The W5 build-prerequisite warning is the `npm run build` prefix above, and the late-summary warning is the post-cancel held-transport checkpoint above.

The PR had also become CONFLICTING/DIRTY against `origin/main` (`40f9867`, the history-preserving integrations of PRs #142/#144/#130 and the j-829 workload-aware budget policy). Integrated in merge `84d7dbc` with both intents kept:

- `perkins-builtin-wave` T4 keeps the reviewed r7 split (T4a moved / T4b aborted, per-scenario bodies) and adopts main's batched fixture cost repair plus the observation-only T4-PHASE/T4-ATTR instrumentation per leg; suite pin 95 (main 94 + one split).
- `install-one-line` keeps the r7 foreign/owned split, moved onto main's async `run()` helper with every call awaited (same titles, bodies and assertions).
- `lan-phone-raw-client` W5 keeps the seq-correlated replayed-turn barrier (this lane's reviewed predicate) with main's arrival-order rationale.
- `chat-server` held retirement takes main's bounded poll plus the explicit disposed oracle.
- `.gru-command/worktree.toml` keeps the PR145 scopes and main's added scopes; every contract scope that names a main-classified heavy file now routes through `--config vitest.heavy.config.ts`, `lan-phone-w5` keeps its build prerequisite, and `test/test-budgets.ts` observed-timeout pins name the split descendants (all guarded by `test/test-budgets.test.ts`).

Exact-head local FULL at `84d7dbc`: `npm test` exit 0 — fast 1506 passed / 6 skipped, heavy 662 passed / 6 skipped, web 408 passed, hygiene clean. Focused: `compaction-timeout` 161/161 (pi-adapter 75, chat-server 84, suite-shape 2); T4a/T4b and both split installer scenarios green under the heavy runner. Remaining gates: exact-head CI and native Perkins clearance; merge stays owner-held. A receipt bound to a successor head cannot be written inside this revision; the CI result for the pushed head is the authoritative current-head receipt, supplied with the PR.
