---
title: 'gh-97: honor owner routing when a legacy machine row dedupes a new owner-held stop'
type: 'bugfix'
created: '2026-09-27'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
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
