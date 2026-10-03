---
title: 'gh-167 Stage 1 — activity-bounded Perkins execution across the transport waits'
type: 'feature'
created: '2026-10-03'
status: 'in-review'
route: 'dispatch'
baseline_commit: '9bb51b05af5d8f0a0cd389788d1d3f19607d5361'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A healthy Perkins specialist is killed at a fixed 600000 ms turn deadline and its findings are lost; separately, the 15-minute review transport waits (`RESPONSE_TIMEOUT_MS` in the review MCP server, `TOOL_EXECUTION_TIMEOUT_MS` in the review MCP bridge, `FALLBACK_REVIEW_TIMEOUT_MS` in the dispatch surface) cancel or orphan live review work instead of reporting it still-running and reattaching. Six sampled timeouts hit the deadline with 36–66 tool calls and 2.8–8.5 s total recorded tool time; a same-round control completed at 436.9 s — wall-clock lifetime is not evidence of a stall.

**Approach:** Remove the fixed specialist turn lifetime: wait on the child's settled turn and let existing host supervision (silence + live-tool/compaction evidence) own stall diagnosis. Turn the three 15-minute transport waits into still-running report boundaries: the review MCP server answers a wait-expired `tools/call` with a still-running result (never an error, never a socket kill), and the MCP bridge keeps the execution alive, joining an identical repeat call to it and retaining the settled success so a reattach returns the original result exactly once. The dispatch fallback review reports each expired wait slice durably and keeps waiting on the same live minion session.

## Boundaries & Constraints

**Always:** Reuse existing host supervision; no new scheduler, poller or heartbeat loop. Keep explicit cancellation, auth/resource/safety stops, one lead/writer, 16 runs/round, 2 attempts/lens, the transport waits themselves, findings validation and pinned-resource integrity (refresh pins, never disable checks). A reattach or a new transport call never refunds, resets or duplicates an attempt.

**Never:** No replacement fixed specialist lifetime, no arbitrary tool-call cap; no fallback PASS, new lenses, model/credential/budget change, cross-round result reuse or Stage 2 accounting redesign; no merge, restart or live-config edit; never kill or duplicate an accepted live specialist because a wait expired; never treat prose silence alone as idleness while model/tool activity exists.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Wait slice expires, work live (server) | `tools/call` unanswered at the wait | still-running result; execution survives | n/a |
| Reattach (bridge) | identical `tools/call` while in flight, or after settled success | joined result; the tool executes once | n/a |
| Settled failure | identical call after a failed execution | executes fresh (retry semantics); failure never cached | error response as before |
| Dead bridge/child | connect or execution fails | terminal error reported accurately | bounded error response |
| Child crosses 600000 ms | child turn settles valid at t > 600 s | run valid, recorded exactly once, no timeout classification | n/a |
| Prose silence, live activity | streaming/tooling with no visible prose | not idle, not failed at a wall clock | n/a |
| Explicit cancellation | round or bridge abort | turn/execution aborts; attempts unchanged | abort error |
| Fallback slice expires | fallback minion turn still open | durable still-running report; same session keeps running | real failure still fails loud |

</frozen-after-approval>

## Code Map

- `src/dispatch/perkins-review/whole.ts` — remove `CHILD_TURN_TIMEOUT_MS`; `boundedPrompt`/`retryPrompt` accept `number | null`; children wait unbounded (lead keeps `LEAD_TOTAL_TIMEOUT_MS`); extend the `perkins_run_specialists` description with the reattach contract; leave pool, attempts, envelopes and validators untouched.
- `src/runtime/review-mcp-server.mjs` — `RESPONSE_TIMEOUT_MS` becomes the wait slice; an expired `tools/call` returns a still-running result; add env seam `GRU_REVIEW_RESPONSE_WAIT_MS` (default unchanged, malformed value fails loud).
- `src/runtime/review-mcp-bridge.ts` — delete the `TOOL_EXECUTION_TIMEOUT_MS` abort; add a per-request-key execution registry (join in flight, retain settled successes bounded, drop failures); keep framing limits, teardown abort/await and result validation byte-for-byte; refresh `PERKINS_MCP_SERVER_SHA256`.
- `tools/verify-perkins-resource.mjs` — same server digest pin.
- `src/dispatch/perkins.ts` — `defaultFallbackReview`: slice loop with a durable still-running event and re-wait on the same session; keep `settleRetries`/lease/dispose ordering.
- `test/perkins-whole-review.test.ts`, `test/perkins-builtin-wave.test.ts` — adapt the two pinned expectations; new deterministic coverage.
- `test/review-mcp-transport.test.ts` (new) — bridge join/retain/cancel, spawned-server still-running/reattach, dead-socket error, pin consistency.

## Tasks & Acceptance

**Execution:**
- [x] `src/dispatch/perkins-review/whole.ts` — remove the child turn lifetime; optional budgets; tool description.
- [x] `src/runtime/review-mcp-server.mjs` — still-running wait slice + env seam.
- [x] `src/runtime/review-mcp-bridge.ts` — execution join/retention with no execution abort; refresh the server pin.
- [x] `tools/verify-perkins-resource.mjs` — refresh the server pin.
- [x] `src/dispatch/perkins.ts` — fallback slice loop + still-running report.
- [x] tests — deterministic coverage plus pin/regression updates.

**Acceptance Criteria:**
- Given a specialist whose turn settles valid after more than 600000 ms of deterministic time, then the run is recorded exactly once as valid, with no timeout classification.
- Given a live wave past the server wait slice, then the model receives still-running and a repeat identical call returns the eventual result with the underlying tool executed once.
- Given a genuinely failed execution or dead bridge, then the failure is reported and never retained as a success.
- Given explicit cancellation, then the abort still ends the turn/execution.
- Given a fallback turn open at the slice boundary, then a durable still-running report is recorded and the same session completes without a respawn.
- Given a rate-limited child, then retry-count bounds still govern and attempt accounting is unchanged.

## Implementation Notes

- Checkpoint 1: no Open Questions were open. Spec approved and status moved to `ready-for-dev` under the dispatch briefing's j-1065 authorization (ordinary BMAD planning/refinement needs no further owner round); token estimate ~1840, kept whole because the four transport surfaces are one stage goal and splitting them would break the briefing's stage separation.
- Design decisions (final): (1) the bridge, not the server, owns execution identity — canonical `(tool, input)` join, settled successes retained (soft 16 MiB bound, oldest settled evicted first), failures never retained so a retry really executes; (2) the server's 15-minute wait is the only transport boundary and on expiry answers a still-running tool result (never an error, never a socket kill), so the bridge carries no execution timer at all; (3) `whole.ts` specialist turns have no lifetime timer and no elapsed retry budget — retries stay count-bounded by the existing rate-limit policy and host supervision owns stall diagnosis via its silence + live-tool/compaction evidence; `LEAD_TOTAL_TIMEOUT_MS` (round bound) is untouched; (4) the fallback review's slice loop reports `still-running` durably per expired wait and re-attaches to the SAME live session; an open turn plus a terminal (`disposed`/`error`) session state fails loud instead of waiting forever; timers/listeners are cleaned per slice; (5) `GRU_REVIEW_RESPONSE_WAIT_MS` is a test-only seam — the bridge passes only `GRU_REVIEW_BRIDGE_SOCKET` into the server env, the default is the unchanged 15 minutes, and a malformed value exits 2.
- Fail-before evidence (prepared in a throwaway copy carrying the pre-change sources and the new tests, `/tmp/gru-fail-before-167`; no git metadata touched): crossing the retired 600000 ms deadline produced TWO failed envelopes instead of one valid; the retry test observed 2 model invocations instead of the count-bounded 4; the fallback test recorded `started, blocked` instead of `still-running` + live session; the transport join test executed the tool twice, the server answered a wait-expired call with an error, and the wait seam did not exist. The durable reproduction is the declared `perkins-reliability-stage1-baseline` scheduled scope (pinned base 9bb51b0 + identical final tests, expected RED, exits never masked).
- Pass-after development runs (local iteration; the scheduled scopes are the gate): `test/review-mcp-transport.test.ts` 7/7; `test/perkins-builtin-wave.test.ts` 93/93; `test/claude-adapter.test.ts` 89/89; `test/native-tools-parity.test.ts`, `test/verify-perkins-resource.test.ts`, `test/tool-heartbeat.test.ts`, `test/review-path.test.ts` 31/31; `test/perkins-whole-review.test.ts` 76/78 with two 30-second-ceiling timeouts under co-tenant load that pass in isolation (25 s/12 s — the environment class documented in `vitest.config.ts`), so the scheduled FULL is the authoritative gate. Lint, typecheck and the build (with the refreshed pinned-resource verifier) are green at the freeze head.
- Scheduled gates are frozen-head runs through the authenticated `/api/verify` scheduler with exclusive pre-opened raw/decoded captures, head/dirty binding and both sink hashes (client + receipts under `_bmad-output/gate-prep/perkins-reliability-stage1/`): `perkins-reliability-stage1-static`, `perkins-reliability-stage1-focused`, `perkins-reliability-stage1-baseline`, and `full`. Exact-head CI, the independent whole-change review and installed native Perkins READY are the operations-owned gates; this lane cannot launch review children.

## Spec Change Log

## Review Triage Log

- Self-triage (no review children available in this lane; the independent whole-change review remains the downstream gate). Reviewed the full diff against the retired-lifetime/transport contract: (1) bridge key canonicalization handles reordered keys and cannot collide (NUL separator; JSON escapes NUL inside strings) — covered by the join test; (2) failure outcomes are never retained, so identical retries execute for real — covered; (3) teardown still aborts pending executions and awaits handlers/executions with the existing bounded close — covered by the abort test and preserved bridge suites; (4) the fallback open-turn guard is evidence-based (terminal session state), not a wall clock — no healthy-work kill found; (5) `retryPrompt` keeps its rate-limit count bound; the `timeout` failure kind remains only for compatibility and the lead budget; (6) no `pass`/merge semantics touched, no validation weakened, pins refreshed and pinned by a new consistency test. No `high`/`medium` defect identified in the changed lines.

## Design Notes

- The bridge keys executions by canonicalized `(tool, input)` so a repeat call is a join, not a duplicate; successes are retained for reattach, failures are not (a retry must execute).
- The server keeps its 15-minute wait value as the report cadence; nothing kills work when it expires. The bridge needs no timer: the server's slice is the only wait boundary and the bridge holds the execution.
- `LEAD_TOTAL_TIMEOUT_MS` (4 h) is untouched: it bounds the round, not a specialist lifetime.

## Verification

**Commands (scheduled, authenticated, frozen head):**
- `perkins-reliability-stage1-static` — expected: lint + typecheck + build (pinned verifier) exit 0.
- `perkins-reliability-stage1-focused` — expected: the transport/engine/fallback/parity suites exit 0.
- `perkins-reliability-stage1-baseline` — expected: RED on the pinned pre-change head (fail-before), never masked.
- `full` — expected: `npm test` exit 0.
