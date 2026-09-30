---
title: 'FOR YOU: permanent owner-action section on the board'
type: 'feature'
created: '2026-09-28'
status: 'in-review'
route: 'dispatch'
baseline_commit: 'df9fe01e87913c5f2ad47219ddc2f838eca6d045'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/BOARD.md'
  - '{project-root}/docs/UI.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The owner's pending obligations (ack/resume stops, owner-answer
decisions, genuinely merge-ready PRs) live only inside the bell panel; the
owner hunts through notifications to find what needs them, and merge-ready
PRs have no evidence-bound home at all.

**Approach:** Add a permanent FOR YOU section at the top of the board (above
the existing job bands, matching NEEDS GRU's label style). It renders the
authoritative pending-owner obligations: unacked `needs-owner` notification
rows (with the existing authenticated Ack control and honest consequence
copy) plus a new server-side, evidence-bound `ownerPrs` projection of PRs
whose exact current head has an approved head-bound review round, clean
mergeable state, and green CI. PR rows carry one action: OPEN PR (external
link); no in-app merge. The bell stays the alert/history surface — same
authoritative rows, no second state machine.

Owner approval of intent: dispatch briefing 2026-09-28 (`owner-approval.json`,
"yes. go ahead. we discussed that. I think."); the briefing directs the lane
BMAD workflow to run once without re-asking this approval — it is recorded
here as the standing Checkpoint-1 approval.

## Boundaries & Constraints

**Always:**
- Pending = still owed: `routing === 'needs-owner' && ackedAt === null &&
  resolvedAt === null`. Opening the board/bell/detail or a shown receipt
  never completes an obligation; only a confirmed authoritative ack (or
  system resolution) closes an ack row; only confirmed merged/closed state
  settles a PR row.
- PR rows fail closed: only `in-review` jobs with a recorded PR, a durable
  `github.branch-state` observation whose `pr_url` matches the recorded PR,
  `merged === false`, `mergeable_state === 'clean'`, CI observed green at
  exactly that branch-state sha, and the newest review round's verdict
  `approved` with `targetRef` equal to that sha. Anything missing, stale,
  moved, dirty, blocked, failed/pending, or changes-requested renders no
  ready row.
- Ack rows explain scope: a provider-wall/breaker ack re-arms supervision
  and does NOT clear code/test/review holds; generic decision acks do not
  prove a migration/token-rotation/deployment ran.
- Deterministic order (newest first, id tiebreak), stable row ids
  (`owner-ack:{notificationId}`, `owner-pr:{jobId}`), no text-based dedupe,
  no grouping beyond obligation identity, no bulk/auto-ack.
- All pending rows reachable: window with an explicit "+N older" expander
  (never lose obligations under newer feed entries).
- Keyboard/screen-reader usable; a snapshot re-render preserves focus inside
  the section and never rings a chime/toast; themes and mobile layout hold.
- URLs rendered as links only when https (or relative); never derive
  actions from notification prose.

**Never:**
- No in-app merge button, no new workflow engine, no new notification kinds
  or check names as authority, no browser-only inbox state machine, no
  changes to NEEDS GRU/machine rows, bell badge semantics, owner-chime
  (#70) arming/mute/throttle, board bands order, vocab, or themes.
- No live-config/credential/service mutations; no new runtime deps; no
  broad test runs without the coordinated gate.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner stop + machine incident | 1 needs-owner + 1 action-required, both unacked | FOR YOU shows only the owner stop with Ack; NEEDS GRU keeps the machine row; FOR YOU count 1 | N/A |
| Seen/opened | Panel opened / board rendered; shown receipts sent | Pending count unchanged (ack still owed) | N/A |
| Ack succeeds | Owner clicks Ack once (fixture ack path) | Row stays pending until the authoritative snapshot carries `ackedAt`; then row closes on every surface | Re-render keeps the control enabled; no optimistic disappearance |
| Ack HTTP ambiguous/failing | Ack POST fails or times out | Row stays pending; control re-enables; next snapshot reconciles one authoritative result | Catch → revert optimistic disabled state |
| Ready PR, exact head | in-review job; branch-state sha S: clean, CI green@S, newest round approved, targetRef=S | FOR YOU PR row: affected heist, reason (approved@S, CI green@S, mergeable), OPEN PR (https only) | N/A |
| Head moves / hold / dirty / CI red or pending / changes-requested / merged / branch-state missing or pr_url mismatch | Any single condition | No ready PR row (fail closed); merged/closed settles on confirmed state, never on link click | N/A |
| Feed window bounded | Older still-pending needs-owner row beyond the 30-row feed window | Engine already merges ALL unacked needs-owner rows into the snapshot; band renders it behind the expander | N/A |
| Re-render while focused | Snapshot push while focus is on a band control | Focus restored to the same stable action id; no toast/chime | N/A |

</frozen-after-approval>

## Code Map

- `src/board/engine.ts` — `BoardSnapshot` gains `ownerPrs` (computed via
  new pure module); `notifications()` already merges ALL unacked
  needs-owner/action-required rows (bounded-feed escape, keep).
- `src/board/owner-actions.ts` (NEW) — pure `ownerReadyPrs(jobs,
  branchStateOf)` projection + `readiness` reasons; no I/O.
- `src/dispatch/github-poll.ts` — evidence source: `BRANCH_STATE_EVENT`
  payload shape (`sha`,`merged`,`mergeable_state`,`pr_url`,`ci{sha,status}`);
  reuse `readBranchState`-style parsing; DO NOT modify poll behavior.
- `src/ledger/api.ts` — `latestJobEvent(jobId, kind)`,
  `countPendingNeedsOwner()`, `listNotifications` filters (reuse as-is).
- `src/board/server.ts` — snapshot already ships whole; no new endpoints
  needed for this slice; ack/shown endpoints unchanged.
- `web/src/lib/board-protocol.ts` — `OwnerPrView` + optional snapshot
  field `ownerPrs` (validator tolerates absent pre-upgrade servers, strict
  when present), mirror of engine type.
- `web/src/ui/board.ts` — `renderOwnerActions()`; FOR YOU band above job
  bands in new mount; ack rows reuse `boardClient.ackNotification`; focus
  preservation; 'web-board' shown receipts; NO toast/chime calls.
- `web/index.html` — `<section id="board-owner">` above `#board-jobs`.
- `web/src/styles/components.css` — band styles via design tokens
  (auto light/dark); reuse `.board-band__*` patterns.
- `web/mock/server.ts` — generic sample `ownerPrs` + a ready-PR fixture row
  (no real project names).
- `test/board-engine.test.ts`, `web/src/ui/board.test.ts`,
  `web/src/lib/board-protocol.test.ts`, `test/owner-actions.test.ts` (NEW)
  — deterministic fixtures only.
- `docs/BOARD.md`, `docs/UI.md` — document the band, the readiness rule,
  and its fail-closed edges (the "exact gap" record).

## Tasks & Acceptance

**Execution:**
- [x] `src/board/owner-actions.ts` + `test/owner-actions.test.ts` — pure evidence-bound PR-readiness projection with exhaustive fail-closed cases — single authority for "ready".
- [x] `src/board/engine.ts` + `test/board-engine.test.ts` — compose `ownerPrs` into the snapshot from jobs + `github.branch-state` events; ordering/stability tests; no regression to notifications merge behavior.
- [x] `web/src/lib/board-protocol.ts` + test — `OwnerPrView` shape, optional-field validator (absent tolerated / present strict), safe-URL rule for `prUrl`.
- [x] `web/index.html`, `web/src/styles/components.css` — mount + token-based styles, mobile + both themes, no overflow.
- [x] `web/src/ui/board.ts` + `web/src/ui/board.test.ts` — FOR YOU band: ack rows with consequence copy (quota-ack scope note), PR rows with OPEN PR, count, calm empty state, expander, focus preservation, no toast/chime, bell/NEEDS GRU unchanged.
- [x] `web/mock/server.ts` — fixture rows incl. a ready PR and negative samples for visual proof.
- [x] `docs/BOARD.md`, `docs/UI.md` — honest action semantics + readiness rule + limitations (GitHub-native review states beyond `mergeable_state` are not separately projected; Perkins READY is represented by the head-bound approved round).
- [x] Delivery artifacts under the approved briefings delivery folder (`delivery/delivery-record.md`, `delivery/verification-snapshot.md`).

**Acceptance Criteria:**
- Given a snapshot with mixed routing and ack states, when the board renders, then FOR YOU contains exactly the unacked unresolved needs-owner rows plus ready PRs, in stable order, with count; NEEDS GRU and FEED bands unchanged.
- Given an ack click whose HTTP result is authoritative success, when the next snapshot lands, then the row closes on board and bell without a second control execution.
- Given any single readiness disqualifier (head moved, hold, dirty/blocked mergeable, CI pending/failed/absent or sha-mismatched, changes-requested, merged, missing/mismatched branch-state), when the projection computes, then no OPEN PR row appears.
- Given more pending rows than the window size, when expanded, then every pending obligation is reachable with stable ids and no duplicates.
- Given a snapshot push while a band control has focus, when re-render completes, then focus remains on the equivalent control and no toast/chime fired.
- Given both themes and a narrow viewport, when the band renders, then it stays readable and keyboard-navigable with no horizontal overflow.

## Implementation Notes

- Implemented directly (no subagent runtime available in this dispatch
  host); the spec was the sole source of truth.
- Verification actually run: `npm run lint` clean; `npm run typecheck`
  clean; `npm run build` + `npm run build:web` clean (perkins resource
  verifier green at build rev df9fe01); backend suites
  owner-actions/board-engine/board-server/board-frames/notifications/
  ledger-api/github-poll (136 tests) green; FULL web workspace vitest
  (38 files, 334 tests) green. The broad root `npm test` chain and any
  browser/e2e run are gated on the coordinated checkpoint and were NOT
  run autonomously.
- New pure module `web/src/lib/owner-band.ts` carries the row model +
  consequence copy + window + safePrUrl (tests in
  `web/src/lib/owner-band.test.ts`).
- Lane integrated current main `df9fe01e87913c5f2ad47219ddc2f838eca6d045`
  (fast-forward; lane had no prior commits) before product edits.
- PR #70 (owner-chime, in-review) inspected: it owns audio semantics via
  `setToastHandler`/`web/src/ui/owner-chime.ts`; this feature adds no audio
  and does not touch that path. Crossing hooks: none functional; adjacent
  edits in `web/index.html`/`components.css` are append-only.
- `board-merged-attention-fix` (bdea8c0f) is a delivered-but-unmerged
  classifier change on another lane; nothing here edits its surface.

## Spec Change Log

- 2026-09-28 (r1 follow-through, chief-directed): four round-1 review
  blockers fixed in one bounded pass on the same lane. (1) PR open/closed
  status (`prOpen`/`pr_open`) now flows GhPull → NormalizedBranchState →
  dedupe comparison → branch-state payload/parser, and the readiness gate
  requires an explicitly OPEN pull (closed-without-merge and legacy
  no-status events fail closed; the poll rewrites the cursor on its next
  tick because prOpen now participates in sameBranchState). (2) A moved
  head no longer inherits the old head's mergeability: nextBranchState
  invalidates the carried value on head change (the same-head async-
  unknown retry keeps its pinned behavior); unknown-at-new-head yields
  null and the board fails closed until 'clean' is observed for the new
  head. (3) The two e2e board-order assertions now expect FOR YOU first
  (five bands), and a mock-backed FOR YOU e2e test pins the owner stop +
  ready-PR row content. (4) The bell renders the SAME authoritative owner
  projection as the board band (pending acks AND ready PRs) so a PR-only
  obligation can never read "nothing needs you"; badge/toast alert
  semantics and FEED history are unchanged. Verification HOLD per the
  brief: no tests/builds/browser/verify were run after the GitHub Full
  Suite failure at 1f41a1b (run 36434424797) — preserved, not rerun.

## Review Triage Log

- readiness (r1): closed-unmerged PR stayed eligible for OPEN PR —
  verified real (only `merged` settled; GhPull.state was dropped at
  normalization). Fixed: prOpen carried/compared/projected; explicitly-
  open gate + close-after-ready and legacy-event fixtures. high → patched.
- readiness (r1): new head inherited the old head's clean mergeability —
  verified real (nextBranchState carried prev mergeableState on 'unknown'
  regardless of sha). Fixed: head-change invalidation, fail-closed null
  at the new head; same-head carry pinned unchanged; poll-to-board
  fixture added. high → patched.
- verification (r1): e2e board-order assertions contradicted the new band
  (NEEDS GRU first / exactly four bands). Verified real at
  smoke.spec.ts:470,544. Fixed: both orders now FOR YOU + four job bands;
  mock-backed FOR YOU e2e source added. high → patched.
- owner-projection (r1): bell contradicted the board on a PR-only
  obligation ("nothing needs you" vs 1 pending). Verified real (bell
  filtered needs-owner notifications only). Fixed: bell FOR YOU renders
  the authoritative ownerRows projection (acks + PRs); alert/history
  behavior preserved; PR-only and empty-projection parity tests added.
  high → patched.

<!-- Step-04 halt record (2026-09-28): this dispatch host exposes no
     subagent runtime, so the three review layers (blind-hunter,
     edge-case-hunter, verification-gap) were NOT run in-session. Per the
     step's no-subagent fallback, three standalone prompts with every
     referenced file inlined (diff + claims + reviewer instructions) were
     written next to this spec:
       review-standalone-1-blind-hunter.md
       review-standalone-2-edge-case-hunter.md
       review-standalone-3-verification-gap.md
     Each must run in a SEPARATE session (ideally a different LLM); their
     findings paste back here for triage before any PASS claim. The
     dispatch briefing's independent final-PR-diff BMAD review, exact-head
     CI, native Perkins READY, and image-inspected browser proof remain
     distinct unmet gates on top of this loop. No findings have been
     triaged yet — the log below is intentionally empty. -->

## Design Notes

- Readiness rule is deliberately a conjunction of exact-head facts already
  durable in the ledger; the "smallest explicit evidence-bound readiness
  handoff" is the `github.branch-state` event + the head-bound approved
  round — both already written by existing producers. No new producer, no
  UI heuristic.
- Ack-row copy derives from `kind`: provider-wall/breaker → "re-arms the
  worker; does NOT clear code/test/review holds"; sweep/port-squat →
  remediation is manual; decisions.degraded → "ack records you saw it; the
  system stays degraded until fixed". Notification text itself is never
  parsed for actions.

## Verification

**Commands:**
- `npx vitest run test/owner-actions.test.ts test/board-engine.test.ts` -- expected: all pass
- `npm run test -w web -- board` -- expected: web board/protocol suites pass
- `npm run lint && npm run typecheck` -- expected: clean
- `npm run build` -- expected: clean (perkins resource verifier passes)

**Manual checks (if no CLI):**
- Browser proof (coordinated-gate): mock fixture, both themes + mobile
  viewport, visual inspection by an image-capable route before any PASS.
