---
title: 'Keep verification response streams alive during legitimate idle periods'
type: 'bugfix'
created: '2026-10-09'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
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
- `src/verify/server.ts` — `VERIFY_HEARTBEAT_MS`, `PingFrame`, `heartbeatMs` option, heartbeat arm/stop/write.
- `test/verification-server.test.ts` — the four named regressions (real isolated server, short heartbeat cadence; spies prove one `setInterval` per response and every one cleared).
- `test/verification-capture.test.ts` — reader accepts interleaved pings and still rejects post-terminal frames; a completed stream with pings stays promotable through real EOF; a stream severed after pings stays UNKNOWN with no output binding.
- `test/suite-shape.test.ts` — recomputed phantom-check pins (22 / 24).
- `.gru-command/worktree.toml` — `verify-idle-keepalive`, `verify-idle-keepalive-static`, and `verify-idle-keepalive-baseline` scopes.

**Fail-before (local, ad-hoc):** with `src/verify/server.ts` restored to base 32fc2f6 (tests unchanged), all four named regressions RED: queued leg times out with no ping, quiet leg `expected -1 to be greater than 1`, cleanup leg `expected +0 to be 3`, honest-capture leg `captured` lacks `"type":"ping"`. The scheduler-backed `verify-idle-keepalive-baseline` scope reproduces this on an isolated base snapshot.

**Workflow note:** this lane is a tracked minion, so the workflow's independent review is commissioned through the service dispatch surface as a separate read-only review job at the frozen head (not a model-native subagent), per the standing build-workflow playbook.

**Route deviation note:** route `oneshot` is deliberate: there are no human intent gaps (the briefing delegates encoding/timing/lifecycle to the worker), nothing irreversible, and the change is a single small causal mechanism plus its scoped tests. Implementation happens in this lane; no untracked helpers are spawned.
