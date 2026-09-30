---
title: 'gh-97: honor owner routing when a legacy machine row dedupes a new owner-held stop'
type: 'bugfix'
created: '2026-09-27'
status: 'done'
route: 'oneshot'
review_loop_iteration: 2
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** An unresolved pre-routing-split machine-routed `supervision.provider-wall.<agentId>.<failureClass>` row makes `NotificationCenter.postIncident` return that legacy row for a NEW owner-held provider stop, so the breaker binds to a row the owner cannot Ack (`ledger.ackNotification` throws for action-required), no FOR YOU/bell row is created, and the walled provider cannot be re-armed until Gru disposes of the legacy row (GC issue #97, severity high; legacy-state precondition; no production incident observed).

**Approach:** In `postIncident`, when the dedupe hit is an unacknowledged row whose routing is not the requested `needs-owner`, honor the request by posting a fresh owner-held row (which rings the bell and is owner-Ack-able, re-arming the breaker through `supervisor.onNotificationAcked`); the legacy machine row stays untouched for Gru triage — never migrated, auto-acked, resolved, or grandfathered into FOR YOU.

## Boundaries & Constraints

**Always:**
- Preserve same-routing dedupe (an unacked `needs-owner` hit for a `needs-owner` request reuses the existing row) and fresh-install behavior (no legacy row → exactly one row per incident).
- Preserve the existing dedupe reuse of previously ACKED machine rows under `dedupe: 'active'` (incoming77/71 behavior; `test/notifications.test.ts` "preserves legacy machine routing for Gru triage and makes only new owner stops human-facing").
- The regression must exercise the real `NotificationCenter` + supervisor ACK entry chain (`center.ack` → `supervisor.onNotificationAcked`) with the existing supervisor test doubles, not a constructed object shape.
- Every user-visible behavior change lands with a deterministic test that fails before the change and passes after it.

**Never:**
- No bulk migration of legacy rows, no breaker trip/re-arm of any live Gru/owner service, no automatic owner-stop acknowledgment, no breaker policy redesign, no new dependencies.
- No changes outside `src/notifications/center.ts` and directly required notification/supervisor tests (a supervisor source change requires a concrete call-chain reason).
- Do not disturb findings still open from PRs #77/#71.

</frozen-after-approval>

## Implementation Notes

- 2026-09-27: Red-first evidence — both new tests failed on unfixed main at exactly the defect: `postIncident` returned the legacy machine row id (notifications test) and no fresh owner row existed (supervisor test, rows length 1).
- Fix: one conditional in `NotificationCenter.postIncident` — when the dedupe hit is an unacked row whose routing is not the requested `needs-owner`, post a fresh owner-held row; otherwise reuse as before. Acked machine rows under `dedupe: 'active'` still reuse (pins the existing 'preserves legacy machine routing' test = incoming77/71 behavior).
- Files: `src/notifications/center.ts` (fix), `test/notifications.test.ts` (+1 center-level test incl. same-routing dedupe and post-ack next-trip determinism), `test/supervisor.test.ts` (+1 full-chain regression: real NotificationCenter + supervisor stop → fresh needs-owner row → `center.ack` → `onNotificationAcked` → breaker closes + respawn), `test/suite-shape.test.ts` (inventory 16→17, 43→44, derived from the actual combined tree).
- Supervisor source unchanged — the fix lands entirely in the notification center; `stopForGuidance` already requests `needs-owner` and binds the returned row.
- Timing note: after re-arm the respawn replaces the disposed agent slot, so the regression asserts the breaker close synchronously at ack time and the respawn via spawn count (the existing auth-wall test's own acceptance shape).

- Verification (2026-09-27, lane-local, serial under active host render): lint OK; typecheck OK; build OK (perkins resource verifier OK); backend `vitest run --no-file-parallelism` 87 files / 1341 tests passed, 0 failed (3 vitest-worker `onTaskUpdate` RPC timeouts = host-load artifact, no failed assertions); web `npm run test:web` 35 files / 304 tests passed (one earlier load-flake run recorded, re-run green; see delivery notes for the uploads-dir razor-margin reconciliation with a clean origin/main baseline).

## Review Triage Log

- 2026-09-27 blind-hunter (inline; no subagent runtime — prompt + record in `review-blind-hunter-gh-97.md`): finding "resolved+unacked machine row under `dedupe:'all'`" — `false` for current code: the only `dedupe:'all'` caller posts `decisions.ready` with routing `'fyi'` (src/decisions/runtime.ts), never `'needs-owner'`; the edge is deterministic if ever reached and matches the fix's intent.
- "non-owner-held kinds requested needs-owner change behavior" — `false`: no current caller requests `'needs-owner'` for a non-owner-held kind (producer inventory: provider-wall + decisions.degraded.* only; others post action-required/fyi).
- "regression does not pin breakerNotificationId" — `false` as a defect: the supervisor binds exactly the postIncident return; if it returned the legacy row, no needs-owner row would exist (length assertion) and the owner ack would throw (asserted), so the chain cannot pass on a legacy-bound breaker.
- "no decisions.degraded.* fresh-row variant" — `low`, deferred to deferred-work.md: mechanism is kind-agnostic and covered via the provider-wall kind; adjacent coverage, not a bug.
- "suite-shape counts hand-updated" — `false`: the suite-shape pin validates each file's static count and passed against the actual combined tree (17 notifications / 44 supervisor, confirmed by the vitest tallies).

## Spec Change Log (loopback 1 — Perkins R1 on PR #129)

- Finding: equal-millisecond ties in `findNotificationByKind` (`ORDER BY ts DESC, id ASC`, src/ledger/api.ts) let the legacy machine row keep WINNING the dedupe after a fresh owner row exists; each repeated owner stop then inserted ANOTHER owner row (duplicate bell). The original test's `legacy-provider-wall` id always sorts after a UUID (hex digits < 'l') and did not control the clock, so the tie path was untested.
- Amendment: on an unacked machine-row hit, `postIncident` now reuses an ELIGIBLE unacked same-kind `needs-owner` row before inserting — via a new routing-scoped ledger lookup `findNotificationByKindAndRouting` (unacked + unresolved, newest first). Known-bad state avoided: duplicate owner notifications on same-ms ties; acked/resolved owner rows are NOT eligible, so a genuinely new trip still mints a new owner row (next-trip semantics preserved).
- KEEP: the round-1 acceptance set (fresh Ack-able row on machine hit; legacy row preserved; acked-row reuse under `dedupe:'active'`; same-routing dedupe; fresh-install behavior) all still green unchanged — the amendment only collapses the duplicate-insert window.

## Review Triage Log (loopback 1)

- Perkins R1 finding (equal-ms tie → legacy row wins dedupe → duplicate owner rows): verified REAL by a deterministic red reproduction (frozen clock + all-zeros legacy id — lexicographically first among UUIDs — repeat stop minted a second owner row `d89f0906… ≠ 8fc3bcd4…`). Fixed as prescribed (reuse-then-insert); regression `reuses the open owner row on a same-millisecond tie instead of duplicating the bell (Perkins R1)` asserts: repeat returns the SAME owner id, exactly 2 rows of the kind, exactly ONE onNeedsOwner bell ring, legacy row untouched (action-required/unacked/unresolved).

- Loopback 1 files: `src/ledger/api.ts` (+`findNotificationByKindAndRouting`), `src/notifications/center.ts` (reuse-before-insert on the machine-hit branch), `test/notifications.test.ts` (+1 fixed-clock tie regression; 17→18), `test/suite-shape.test.ts` (17→18).

## Spec Change Log (loopback 2 — Perkins R2 on PR #129)

- Finding: the R1 routing-scoped lookup excluded ACKed rows unconditionally, but the decisions.degraded.* producer posts with `dedupe: 'active'` (ack = "human saw it", the row stays the ONE active incident until recovery resolves it). On a legacy-first same-millisecond tie, the kind lookup selected the legacy machine row, the scoped lookup missed the ACKED-but-unresolved owner row, and the repeated active post inserted a duplicate owner row + second bell.
- Amendment: `findNotificationByKindAndRouting` is now MODE-AWARE with the same semantics as `findNotificationByKind` — 'unacked' (acked owner row is spent → new trip mints a new owner row), 'active' (unresolved owner row reused even if acked, until resolved), 'any'. `postIncident` passes the producer's own dedupe mode through. Known-bad state avoided: duplicate owner bell on active dedupe after ack.
- KEEP: R1 tie regression unchanged and green; unacked-dedupe next-trip-after-ack semantics unchanged and green (gh-97 test); the pinned acked-machine-row reuse under 'active' (legacy-0) unchanged; fresh-install behavior unchanged.

## Review Triage Log (loopback 2)

- Perkins R2 finding: verified REAL by deterministic red reproduction (frozen clock + all-zeros legacy machine row + `decisions.degraded.credential_missing`; ack the unresolved owner row; repeated 'active' post minted `480bf1c4… ≠ a75efa93…`). Fixed as prescribed; regression `active dedupe reuses an ACKed unresolved owner row on a tie instead of ringing the bell again (Perkins R2)` asserts same owner id, exactly 2 rows, ONE bell ring, legacy machine row untouched.
