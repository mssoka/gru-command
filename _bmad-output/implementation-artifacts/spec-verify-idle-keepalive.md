---
title: 'Keep verification response streams alive during legitimate idle periods'
type: 'bugfix'
created: '2026-10-09'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 4
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

**Decision — cadence/lifecycle (in `src/verify/server.ts`):** `VERIFY_HEARTBEAT_MS = 15_000`; the heartbeat is an `unref`'d `setInterval` armed right after `writeHead`. The idle clock starts at `writeHead` (not at the first frame), so a first frame delayed past one interval — e.g. an attach queued behind a back-pressured sibling — still gets a ping instead of an unbounded silent body; a leading `ping` is legal and is counted apart by the reader. A tick writes a ping only when the last body write is at least one interval old, so the worst-case idle gap is 2 × 15 s ≈ 30 s — an order of magnitude under the 300 s client limit, with no ping noise during chatty output. At most one ping write may be in flight at a time, so a stalled socket cannot stack drain/close listeners. The timer is cleared on the terminal `completed`/`error` frame, on `res` `close`, and in the `finally` before `res.end()`; a ping is therefore never written after the terminal frame. `heartbeatMs` is a test seam (default `VERIFY_HEARTBEAT_MS`); a cadence that is non-positive or leaves no worst-case margin (`2 × heartbeatMs >= VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS`) is refused loudly.

**Decision — wire contract:** `PingFrame` and `VerificationStreamFrame` are exported from `src/verify/server.ts`, and `writeFrame` is typed to them (plus the admission `error` record), so the ping is a documented member of the stream vocabulary rather than a magic string.

**Decision — scope:** server-side fix. `src/verify/scheduler.ts` is untouched (it is the producer-frame owner and its `queued`/`started`/`output`/`completed` vocabulary is unchanged). `src/verify/capture.ts`/`capture-cli.ts` change only to count transport pings apart from producer frames (`pings` vs `frames`), which is causally required to keep the receipt's producer-frame fingerprint honest; the reader's malformed/terminal rejection is unchanged. This keeps "transport keepalive is not producer output" structurally true.

**Files changed:**
- `src/verify/server.ts` — `VERIFY_HEARTBEAT_MS`, `VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS`, `PingFrame`, the validated `heartbeatMs` seam, heartbeat arm/stop/write on a monotonic clock.
- `src/verify/capture.ts`, `src/verify/capture-cli.ts` — `pings` counted (and receipted) apart from producer `frames`.
- `test/verification-server.test.ts` — the four named regressions plus the cadence/refusal pin and the attach-stream keepalive (real isolated server, short heartbeat cadence; scoped spies prove one `setInterval` per response, unref'd and cleared).
- `test/verification-capture.test.ts` — reader accepts interleaved pings and still rejects post-terminal frames; a completed stream with pings stays promotable through real EOF; a stream severed after pings stays UNKNOWN with no output binding.
- `test/assert-verify-keepalive-baseline.test.ts`, `tools/assert-verify-keepalive-baseline.mjs` (+ `.d.mts`) — fail-before report classifier.
- `test/suite-shape.test.ts` — recomputed phantom-check pins (25 / 26 / 5).
- `docs/FLOW.md` — the `ping` frame in the documented response vocabulary (leading ping and 2 × cadence bound included), and the capture-receipt `pings`/`frames` split.
- `_bmad-output/implementation-artifacts/deferred-work.md` — the deferred review follow-ups.
- `.gru-command/worktree.toml` — `verify-idle-keepalive`, `verify-idle-keepalive-static`, `verify-idle-keepalive-baseline`, and `verify-idle-capture-baseline` scopes.

**Fail-before:** every named regression is assertion-first, so the pre-fix base REDs by assertion rather than by a harness timeout. Two scheduler-backed scopes reproduce this on isolated base snapshots and classify the machine-readable Vitest reports with `tools/assert-verify-keepalive-baseline.mjs`, which exits 2 when a claim is broken: `verify-idle-keepalive-baseline` (7 named server regressions) and `verify-idle-capture-baseline` (3 capture-reader/helper regressions). Every failure in each report must be one of the named regressions failing behaviorally, so a harness timeout or an unlisted failure can never pass as RED.

**Review round 1 (BMAD blind hunter, job `verify-idle-keepalive-review-blind-hunter-20261009`, reviewed head 49a219e):** 14 findings, triaged below; the actionable ones were repaired in the first fix cycle. The one finding rejected in round 1 (F4) was re-raised in round 2 and is now patched (R3).

**Workflow note:** this lane is a tracked minion, so the workflow's independent review is commissioned through the service dispatch surface as a separate read-only review job at the frozen head (not a model-native subagent), per the standing build-workflow playbook.

**Route deviation note:** route `oneshot` is deliberate: there are no human intent gaps (the briefing delegates encoding/timing/lifecycle to the worker), nothing irreversible, and the change is a single small causal mechanism plus its scoped tests. Implementation happens in this lane; no untracked helpers are spawned.

## Fix-cycle decisions (review round 1)

- **Monotonic clock:** idle is measured with `performance.now()`, so a backward NTP/wall-clock step can never suppress a ping for the duration of the step.
- **Cadence upper bound:** `heartbeatMs` must satisfy `2 × heartbeatMs < VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS` (300 000). The error message and the guard now agree that an oversized cadence reintroduces the truncation.
- **Transport frames are not producer frames:** `NdjsonCaptureReader` counts `ping` into a separate `pings` field and never into `frames`; `CaptureReceipt` carries `pings`. The incident's producer-frame fingerprint (`frames:1` queued, `frames:2` quiet) keeps its meaning. Post-terminal pings are still `malformed` (the terminal check runs first), so the guard is not loosened.
- **Default cadence pinned by value:** the pin asserts the default path arms the shipped 15,000 ms cadence (positive integer, `2 × interval < 300 000`). It deliberately does not import a new symbol, so overlaying the final test file onto the pre-fix base still loads (an import of a missing export would be a collection failure, not assertion RED).
- **Baseline classification (two legs):** the scopes write Vitest JSON reports and run `tools/assert-verify-keepalive-baseline.mjs`; a collection/setup/import failure, a named regression that passed, or a non-behavioral failure is a broken claim (exit 2), never a silent RED. A matcher `TypeError` on a named test counts as behavioral RED.
- **Receipt back-compat:** `readCaptureReceipt` normalizes a pre-keepalive receipt (no `pings` field) to `pings: 0` — truthful, since those captures held no transport frames.
- **Attach coverage:** the keepalive is proven on the duplicate-attach stream too (one producer, pings while quiet, nothing after the terminal).
- **Documentation:** `docs/FLOW.md` documents the `ping` frame in the response vocabulary.

## Review Triage Log

Round 1 — BMAD blind hunter `verify-idle-keepalive-review-blind-hunter-20261009`, reviewed head `49a219e`; 14 findings. Its disposition was settled mechanically by the head move (job already `done`), per the review-supersession rule.
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

Round 2 — BMAD blind hunter `verify-idle-keepalive-review-round2-blind-hunter-20261009`, reviewed head `90b42f8` (whole change `32fc2f6..90b42f8`); 14 findings.

- R1 `bodyStarted` left the pre-first-frame window unprotected (an attach queued behind a stalled sibling could be silent unbounded) — **medium**, patched: the idle clock now starts at `writeHead` and the leading-ping gate is gone.
- R2 the timer writer had no in-flight guard, stacking drain/close listeners on a stalled socket — **medium**, patched: at most one ping write in flight.
- R3 `ping` still not an exported contract — **medium**, patched this round: `PingFrame`/`VerificationStreamFrame` exported and used by `writeFrame`.
- R4 cadence pinned by shape only; a 147,000 ms default stayed green — **medium**, patched: the default is pinned by value (15,000 ms).
- R5 a required receipt field was added without back-compat — **medium**, patched: `readCaptureReceipt` normalizes legacy receipts to `pings: 0`.
- R6 the baseline comment's exclusion claim was factually wrong and dropped a provable RED leg — **medium**, patched: the comment is corrected and `verify-idle-capture-baseline` adds the capture leg under its own fast config.
- R7 the classifier's `AssertionError:`-only rule could mislabel a matcher `TypeError` as a broken claim — **medium**, patched: `isBehavioralRed` accepts both behavioral shapes.
- R8 no consumer-level reproduction of the client idle deadline — **low**, deferred: real byte arrivals with a bounded gap on an isolated server already prove acceptance 1-3; the stronger `node:http` idle-deadline variant is recorded in `deferred-work.md`.
- R9 the `ping` frame was undocumented — **medium**, patched: `docs/FLOW.md` now documents it.
- R10 the spec was stale again (capture-untouched claim, validation description, status) — **medium**, patched: this update.
- R11 cleanup/pin timer accounting selected by cadence value with exact populations — **low**, patched: populations relaxed to presence/`≥` while each handle is still asserted unref'd and cleared.
- R12 cadence evidence was wall-clock and load-sensitive (1 s bound over a 25 ms cadence) — **low**, patched: the gap bound is 2 s with `≥ 3` pings required, keeping periodicity evidence without a tight stall-sensitive bound.
- R13 the guard's largest accepted cadence is untested — **low**, deferred: the guard is fail-safe one-sided and the shipped default is pinned by value, so an edge off-by-one can only reject loudly, never reintroduce truncation; recorded in `deferred-work.md`.
- R14 the transport abort cause remains cause-blind — **low**, deferred: the incident briefing forbids unrelated error-telemetry expansion; recorded in `deferred-work.md`.

Round 3 — BMAD blind hunter `verify-idle-keepalive-review-round3-blind-hunter-20261009`, reviewed head `11c80ff` (whole change `32fc2f6..11c80ff`); 18 findings. Delta-hunk findings were treated as blocking; findings on untouched code as follow-ups.

- F1/F2 `writeFrame`'s `| Record<string, unknown>` made the exported union non-constraining, and the union omitted the error frame — **medium**, patched: `VerificationErrorFrame` added and `writeFrame` typed to `VerificationStreamFrame`, with `satisfies PingFrame` restored at the ping literal.
- F3 no test delayed the first frame to prove a leading ping — **medium**, patched: a stub-scheduler test delays the first producer frame past several intervals and asserts a leading ping (and it fails at the pre-fix base).
- F4 the in-flight ping guard is untested — **low**, deferred (recorded in `deferred-work.md`).
- F5 the cadence pin lost its population assertion while its comment still claimed one — **medium**, patched: the default path asserts exactly one 15,000 ms interval, and the comment matches.
- F6 stale "1 s bound" comment after the round-2 widening — **low**, patched: comments corrected.
- F7 cleanup comment imprecise — **low**, patched.
- F8 the classifier could accept an unlisted or non-behavioral failure — **medium**, patched: every failure in the report must be one of the named regressions failing behaviorally, and the reported failed count is reconciled (server leg now names all 7).
- F9 the behavioral-rule prefix was unpinned Vitest internals — **low**, patched: positive/negative matrix plus the observed Vitest version named.
- F10 the `server|capture` leg selector was untested — **low**, patched: `resolveBaselineLeg` exported and tested.
- F11 receipt normalization was over-broad (any non-number → 0) — **medium**, patched: only an absent field normalizes to 0; a present-but-corrupt field reads as unreadable (null), never a silent zero.
- F12 the docs omitted that a ping may be the first body frame and the 2 × cadence bound — **medium**, patched.
- F13 the docs over-claimed "never truncate" and the TSDoc's 2 × explanation was inverted — **low**, patched (scheduled-tick caveat stated; explanation corrected).
- F14 the spec was stale again — **medium**, patched.
- F15 the reader's `frames`/`pings` partition is not pinned — **low**, deferred.
- F16 the capture-side docs were not updated with the `pings`/`frames` split — **low**, patched in `docs/FLOW.md`.
- F17 acceptance 3's dispose leg is untested — **low**, deferred.
- F18 the guard error message printed `options.heartbeatMs` (undefined for a bad default) — **low**, patched: it prints the resolved cadence.

Round 4 — BMAD blind hunter `verify-idle-keepalive-review-round4-blind-hunter-20261009`, reviewed head `8604d8b` (whole change `32fc2f6..8604d8b`); 14 findings, all addressed.

- R4-1 the classifier's substring title match could accept an unlisted failure whose title merely contains a named one — **medium**, patched: exact title equality plus a per-title uniqueness check, with the smuggling case pinned.
- R4-2 receipt validation is asymmetric (only `pings` is validated) — **low**, patched comment; full receipt validation deferred (pre-existing).
- R4-3 a required field under an unchanged version — **low**, patched: the version's additive-field policy is documented (new fields normalize in the reader; breaking changes need a new version).
- R4-4 no keepalive coverage of the `error` terminal path — **medium**, patched: a stub-scheduler lock-wait-error regression asserts pings while waiting and that `error` is the last frame.
- R4-5 two tests asserted frame index 0 though the docs allow a leading ping — **low**, patched: presence assertions instead of index-0.
- R4-6 arrival timestamps measure chunk delivery, not wire cadence — **low**, patched comment (counts are the cadence evidence).
- R4-7 the ping's wire shape was never asserted — **medium**, patched: the leading ping is asserted exactly `{"type":"ping"}`.
- R4-8 the guard's accepted range has no stated margin — **low**, patched: the option TSDoc states the hard 2× bound, the shipped default's large margin, and the custom-bodyTimeout caveat.
- R4-9 a synchronous write failure left the heartbeat armed — **medium**, patched: the write catch stops the timer.
- R4-10 stale baseline scope comment (four vs eight titles, AssertionError wording) — **low**, patched.
- R4-11 deferred-work header misattributed round-3 items — **low**, patched.
- R4-12 the classifier is exercised only against hand-rolled reports — **low**, deferred (real-report fixture).
- R4-13 no negative "no ping noise" case or pinned producer-frame count — **low**, patched: the capture-honest test pins `frames === 4` alongside `pings > 0`, and an existing default-cadence test pins the exact `queued/started/output/completed` sequence (zero pings for a chatty run).
- R4-14 the documented vocabulary omitted `attached` — **low**, patched.
