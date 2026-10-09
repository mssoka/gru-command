---
title: 'Keep verification response streams alive during legitimate idle periods'
type: 'bugfix'
created: '2026-10-09'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The verification client's default HTTP body-idle timeout (300,000 ms on the installed Node 22 / undici) truncates valid `/api/verify` NDJSON responses whenever the response body is legitimately silent for longer than that. The confirmed incident (report `verify-queued-capture-loss-investigation-20261009`) lost a queued capture after ~301 s of body silence while the producer kept running and completed; nine losses repeat the pattern, including quiet-running streams (`queued` + `started` then silence). The producer outcome/hash is not lost, but the client's stream and EOF are.

**Approach:** The smallest causal, server-side transport fix on the EXISTING `/api/verify` response: while the stream is open and has been silent for a bounded interval strictly below the 300 s client limit, write an application-level `ping` frame (the same keepalive idiom as the chat/board surfaces). This covers the queued slot wait and the quiet-running gap with one mechanism and protects every streaming consumer, not only the capture helper. Transport liveness only: never producer output, never a terminal frame, never after `completed`/`error`, and never a substitute for real EOF.

**Boundaries:** Smallest causal fix; do not weaken the capture parser or fake a terminal frame/EOF; preserve producer outcome/hash semantics; no new runtime dependency, generic persistence/replay subsystem, queue/concurrency/timeout policy change, unrelated telemetry, auth/config/provider change, or dashboard edit; scheduler/capture changes only where causally required. Do NOT fold this into the SLIM feature or change its tests/acceptance.

**Acceptance (binding, from the incident-repair briefing):**
1. `queued verification keeps response alive during slot wait` — with the single scheduler slot occupied, the waiting response has periodic real body bytes with maximum idle gap strictly below 300,000 ms until admitted/terminal; no extra producer or bypassed FIFO/lock timeout. Fails against the 32fc2f6 implementation and passes after the repair.
2. `quiet running verification keeps response alive` — the same protection operates between `started` and the first/later output for a legitimate silent producer, without fabricating producer output or changing its output byte/hash record.
3. `verification terminal and disconnect cleanup` — no transport frame after `completed`/`error`, no leaked keepalive timer after terminal/close/dispose; genuine disconnection leaves the producer outcome/cancellation semantics as they were; terminal/timer and disconnect/write races neither crash nor unpromote a clean capture.
4. `capture remains honest with keepalive` — the shipped reader/helper accepts the compatible keepalive stream, binds the actual expected head/run, receives one terminal plus real EOF and yields a complete truthful receipt; a real truncated/errored stream stays UNKNOWN; mixed identities/post-terminal illegal frames stay rejected; duplicate request identities never run a second producer.

</frozen-after-approval>

## Implementation Notes

**Decision — encoding:** a well-formed `{"type":"ping"}` frame per line, not bare whitespace. It is the project's established application-level keepalive idiom (`src/chat/frames.ts`, `src/board/frames.ts` both document a `PingFrame` for exactly this "prove the socket is alive while quiet" purpose), it is observable as real body bytes, and the shipped `NdjsonCaptureReader` already accepts unknown frame types without counting them malformed (`acceptLine`/`acceptFrame`). A ping carries no `runId` and no output, so it can never be mistaken for producer output or disturb the single-run identity check.

**Decision — cadence/lifecycle (in `src/verify/server.ts`):** `VERIFY_HEARTBEAT_MS = 15_000`; the heartbeat is an `unref`'d `setInterval` armed right after `writeHead`, before the first scheduler frame. A tick writes a ping only when the stream has already begun (`bodyStarted`) and the last body write is at least one interval old, so worst-case idle gap is 2 × 15 s ≈ 30 s — an order of magnitude under the 300 s client limit, with no ping noise during chatty output. It is cleared on the terminal `completed`/`error` frame, on `res` `close`, and in the `finally` before `res.end()`; a ping is therefore never written after the terminal frame. `heartbeatMs` is a test seam (default `VERIFY_HEARTBEAT_MS`); a non-positive cadence is refused loudly because disabling it reintroduces exactly this defect.

**Decision — scope:** server-side only. `src/verify/scheduler.ts` is untouched (it is the producer-frame owner and its `queued`/`started`/`output`/`completed` vocabulary is unchanged); `src/verify/capture.ts` is untouched (its honest-failure and post-terminal rejection behaviour already covers pings, and is pinned by new tests). This keeps "transport keepalive is not producer output" structurally true.

**Files changed:**
- `src/verify/server.ts` — `VERIFY_HEARTBEAT_MS`, `VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS`, `PingFrame`, the validated `heartbeatMs` seam, heartbeat arm/stop/write on a monotonic clock.
- `src/verify/capture.ts`, `src/verify/capture-cli.ts` — `pings` counted (and receipted) apart from producer `frames`.
- `test/verification-server.test.ts` — the four named regressions plus the cadence/refusal pin and the attach-stream keepalive (real isolated server, short heartbeat cadence; scoped spies prove one `setInterval` per response, unref'd and cleared).
- `test/verification-capture.test.ts` — reader accepts interleaved pings and still rejects post-terminal frames; a completed stream with pings stays promotable through real EOF; a stream severed after pings stays UNKNOWN with no output binding.
- `test/assert-verify-keepalive-baseline.test.ts`, `tools/assert-verify-keepalive-baseline.mjs` (+ `.d.mts`) — fail-before report classifier.
- `test/suite-shape.test.ts` — recomputed phantom-check pins (24 / 24 / 3).
- `.gru-command/worktree.toml` — `verify-idle-keepalive`, `verify-idle-keepalive-static`, and `verify-idle-keepalive-baseline` scopes.

**Fail-before:** every named regression is assertion-first, so the pre-fix base REDs by assertion rather than by a harness timeout. With `src/verify/server.ts` restored to base 32fc2f6 (tests unchanged), all named regressions RED (queued: 0 pings where ≥3 are required; quiet: 0 bridging pings; cleanup: 0 heartbeat intervals; honest capture: no `"type":"ping"`). The scheduler-backed `verify-idle-keepalive-baseline` scope reproduces this on an isolated base snapshot and classifies the Vitest JSON report with `tools/assert-verify-keepalive-baseline.mjs`, which exits 2 when the RED is not four named `AssertionError`s.

**Review round 1 (BMAD blind hunter, job `verify-idle-keepalive-review-blind-hunter-20261009`, reviewed head 49a219e):** 14 findings, triaged below; the actionable ones are repaired in this cycle and the two rejected `low` findings are recorded with their disproof.

**Workflow note:** this lane is a tracked minion, so the workflow's independent review is commissioned through the service dispatch surface as a separate read-only review job at the frozen head (not a model-native subagent), per the standing build-workflow playbook.

**Route deviation note:** route `oneshot` is deliberate: there are no human intent gaps (the briefing delegates encoding/timing/lifecycle to the worker), nothing irreversible, and the change is a single small causal mechanism plus its scoped tests. Implementation happens in this lane; no untracked helpers are spawned.

## Fix-cycle decisions (review round 1)

- **Monotonic clock:** idle is measured with `performance.now()`, so a backward NTP/wall-clock step can never suppress a ping for the duration of the step.
- **Cadence upper bound:** `heartbeatMs` must satisfy `2 × heartbeatMs < VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS` (300 000). The error message and the guard now agree that an oversized cadence reintroduces the truncation.
- **Transport frames are not producer frames:** `NdjsonCaptureReader` counts `ping` into a separate `pings` field and never into `frames`; `CaptureReceipt` carries `pings`. The incident's producer-frame fingerprint (`frames:1` queued, `frames:2` quiet) keeps its meaning. Post-terminal pings are still `malformed` (the terminal check runs first), so the guard is not loosened.
- **Default cadence pinned behaviorally:** the pin asserts the default path arms exactly one heartbeat interval at a positive integer cadence with `2 × interval < 300 000`. It deliberately does not import a new symbol, so overlaying the final test file onto the pre-fix base still loads (an import of a missing export would be a collection failure, not assertion RED).
- **Baseline classification:** `verify-idle-keepalive-baseline` writes a Vitest JSON report and runs `tools/assert-verify-keepalive-baseline.mjs`; a collection/setup/import failure, a named regression that passed, or a non-`AssertionError` failure is a broken claim (exit 2), never a silent RED.
- **Attach coverage:** the keepalive is proven on the duplicate-attach stream too (one producer, pings between `attached` and the first output, nothing after the terminal).

## Review Triage Log

- F1 shipped cadence unpinned — **medium**, patched: default cadence is now pinned behaviorally (one heartbeat interval, positive integer, `2 × interval < 300 000`).
- F2 loud refusal untested — **medium**, patched: `0 / -1 / 1.5 / NaN / Infinity / 150 000 / 300 000` all asserted to throw before any scheduler exists.
- F3 validation accepted a cadence ≥ 300 s — **medium**, patched: the guard rejects any `2 × heartbeatMs ≥ 300 000`.
- F4 `ping` absent from an exported wire union — **low**, rejected: the only consumer is the generic `NdjsonCaptureReader` (untyped frame records), and the pre-existing `writeFrame` widening already carried the `error` frame outside `VerificationProgress`; adding a public stream-union would expand API surface with no incident or consumer need.
- F5 `frames` conflated pings with producer frames — **medium**, patched: `pings` is a separate reader/receipt field; the incident's frame-count fingerprint is preserved.
- F6 quiet regression assumed `ping` never precedes `started` — **medium**, patched: the assertion is now arrival-time based (pings bridging `started`→first output), not frame order.
- F7 gap assertions near-vacuous — **medium**, patched: each idle window is additionally bounded at 1 s (proves cadence, not just "no five-minute hang").
- F8 terminal ping-order assertions vacuous without pings — **low**, patched: streams that must ping now assert a ping count; the rest assert the terminal is the last frame.
- F9 global timer accounting brittle — **medium**, patched: the intervals are selected by the injected cadence, each returned handle is asserted `hasRef() === false` and cleared.
- F10 no keepalive coverage on the attach stream — **medium**, patched: new attached-duplicate test.
- F11 `unref` unasserted — **low**, patched: `hasRef() === false` on each heartbeat handle.
- F12 wall-clock cadence — **medium**, patched: `performance.now()`.
- F13 baseline treated any nonzero exit as RED — **medium**, patched: machine-readable report + `tools/assert-verify-keepalive-baseline.mjs` (exit 2 on a broken claim).
- F14 spec stale at the review head — **medium**, patched: this cycle updates status, iteration, notes, and triage.
