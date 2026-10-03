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
