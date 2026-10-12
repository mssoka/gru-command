---
title: 'Notifications — readable cards and clear owner decisions'
type: 'feature'
created: '2026-10-11'
status: 'in-review'
route: 'dispatch'
baseline_commit: 'f738b9b1594081cdbb4929af7be256454951eb43'
review_loop_iteration: 5
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/BOARD.md'
  - '{project-root}/docs/UI.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FOR YOU is currently an acknowledgment queue, not a decision
inbox: a dense all-uppercase card with an ambiguous Ack (owner screenshot
2026-10-08), while routine operational coordination reaches the owner's
bell. The 2026-10-09 screenshots add the shared defect: NEEDS GRU cards
render their whole diagnostic prose in the `.lbl` label style (uppercase,
0.18em tracking, faint) and clip/wrap badly.

**Approach:** enforce the owner-clarified responsibility chain in the
notification producers and the service boundary (Silas owns routine
recovery/re-arm; beyond Silas, Gru decides and re-arms through supported
controls; only reserved owner decisions reach FOR YOU), give genuinely
owner-only decisions an authoritative typed decision record (question,
context, recommendation, options with consequences, evidence) validated
server-side, and render ONE readable shared notification card — FOR YOU,
NEEDS GRU and FEED, board and bell — with sentence-case body text, a
separate short metadata line, an accessible Details disclosure for full
diagnostics, and controls that name their real supported effect.

The owner deliberately released the staged pipeline entry
(`for-you-readable-notifications-20261009-v3`, clear-hold 2026-10-11:
"deploy the heist") and the briefing directs this lane's BMAD workflow to
run once without re-asking approval; that release is the standing
Checkpoint-1 approval. Original decision-routing acceptance and the
2026-10-09 shared-readability extension both remain owed.

## Boundaries & Constraints

**Always:**
- FOR YOU contains only genuinely owner-reserved matters: consequential
  scope/design or risk tradeoffs, authority/cost beyond delegation,
  destructive or irreversible choices, lesson proposals and all merges.
  Routine re-arms, retries, review follow-through, repairable CI and
  blocker awareness stay machine-side (FOR GRU / FEED); aging or repetition
  never promotes an incident to an owner decision.
- Owner-routed decisions carry server-validated typed metadata; buttons
  map 1:1 to supported server behavior. No generic Ack in FOR YOU, no
  fake approval/fix control, no approval label wired to the old ack
  endpoint, no browser LLM or prose keyword extraction.
- A recorded decision is not operation completion: decision and
  follow-through states render distinctly; viewing, expanding, copying,
  navigating or changing theme never submits anything.
- Protected boundaries stay protected: explicit owner stops, budget/cost
  constraints, single-writer/live-producer guards, reviewer/test holds,
  owner-only lesson decisions, manual restarts and owner-performed merges.
  No acknowledgment endpoint becomes a privilege bypass.
- Shared board/bell truth, deterministic ordering, every pending owner
  decision, older-item disclosure, display receipts vs decisions, focus
  behavior and audit history are preserved.
- Legacy/unknown rows are handled honestly (readable, no invented action,
  no silent drop); a real stop is never erased by age or display.

**Never:**
- Do not edit the companion worktrees
  (`dashboard-slim-strip-current-main-20261007` / PR256,
  `board-section-header-toggles-20261007`), bypass integration/recovery
  holds, absorb PR257, restart the service, merge the branch, or add a
  second modal system.
- Do not change global `.lbl` semantics; do not uppercase/letterspace prose.
- Do not add a runtime summarization call or any browser-side LLM.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Routine recovery | routine stop within delegated authority | machine attention only (action-required/fyi); no FOR YOU row, no owner bell | producer classification logged; no unsafe retry |
| Beyond Silas | uncertain/novel operational decision | Gru receives an action-required row; owner untouched | no owner row; direction recorded on the machine row |
| Reserved owner decision | `gru.owner-escalation` with typed decision | both surfaces render question/context/recommendation/options/consequences + Details; option buttons submit the decision | missing/invalid decision → 400 at the API boundary |
| Decision submit | option click on an open decision | `POST /api/notifications/:id/decision` records decided_at/by/option; row shows "decided — awaiting follow-through" | duplicate submit idempotent; different option → 409; unknown option → 400; resolved row → 409 |
| Decision follow-through | producer resolves after the operation | row resolves distinctly; decision receipt remains in history | no false completion |
| Long diagnostic card | long prose, SHA, UUID, long path | readable sentence-case wrap; full text inside Details; no horizontal overflow; no clipping | never permanently clipped; copy retains full text |
| Unknown/legacy owner row | unregistered kind or pre-change escalation | re-triaged to Gru (action-required) with a note; no invented control; never dropped | migration is idempotent and bounded |
| Machine row ack | `POST .../ack` on action-required | refused | typed 400/409; no state change |
| Protected boundaries | owner stop, budget, review/test hold | ordinary recovery cannot clear/bypass it | only the authorized route applies |

</frozen-after-approval>

## Code Map

- `src/notifications/attention.ts` (new) — authoritative owner-attention registry: `owner-required | owner-allowed | owner-forbidden` per kind/prefix; unknown defaults to Gru triage; `requiresTypedDecision(kind)`.
- `src/ledger/notification-decision.ts` (new) — typed `NotificationDecision` (question/context/recommendation/reservedClass/whyNotDelegable/options/discussion) + strict validation and safe parse.
- `src/ledger/db.ts` — migration 28: `ALTER TABLE notifications ADD COLUMN decision_json/decided_at/decided_by/decided_option`.
- `src/ledger/api.ts` — `NotificationRecord` + `recordNotification(decision)` + `recordNotificationDecision()` + `notificationFromRow`; keep `ackNotification` (record-only now) and `disposeMachineNotification`.
- `src/notifications/center.ts` — enforce the registry in `post()` (force/deny owner routing; require typed decision for `gru.owner-escalation`); gh-97 openIncident logic follows the effective routing.
- `src/board/server.ts` — `POST /api/notifications/needs-owner` requires a valid `decision`; new `POST /api/notifications/:id/decision`; `onNotificationDisposition` hook after a successful machine disposition.
- `src/board/engine.ts` — notification projection carries decision/decided fields.
- `src/main.ts` — boot wiring for the `onNotificationDisposition` hook and the bounded legacy owner-attention reconciliation; resolve open `port-squat`/`roll-port-squat` notices once the service binds successfully.
- `src/supervision/supervisor.ts` — `tripBreaker` posts action-required (no owner chime); disposition/ack re-arm paths share one guarded routine; provider-wall fallback posts action-required with a Gru decision owed.
- `src/board/...`, `src/ledger/...` tests to extend: `test/notifications.test.ts`, `test/board-server.test.ts`, `test/board-engine*.test.ts`, `test/supervisor.test.ts`, `test/provider-recovery-*.test.ts`.
- `web/src/lib/board-protocol.ts` — optional `decision`/`decidedAt`/`decidedBy`/`decidedOption` on `NotificationView` + validators.
- `web/src/lib/board-client.ts` — `decideNotification(id, optionId)` using the new endpoint, errors typed via `BoardApiError`.
- `web/src/lib/owner-band.ts` — row kinds `decision | notice | proposal | pr`; per-kind owner guidance (no generic ack copy).
- `web/src/ui/board.ts` — ONE shared card renderer for band rows and bell `notificationRow`: title, short meta line, context, decision block with option buttons + consequences, Details disclosure, distinct decided/pending/resolved states; preserve focus + open disclosures across snapshot pushes.
- `web/src/styles/components.css` — card layout, wrapping (`overflow-wrap:anywhere`, `min-width:0`), sentence-case body, AA-safe colors on live/error/receipt surfaces; `.lbl` for short labels only.
- `web/src/lib/palette-contrast.test.ts`, `web/src/ui/board.test.ts`, `web/src/lib/board-protocol.test.ts`, `web/src/lib/owner-band.test.ts` — focused DOM/protocol/contrast regressions.
- `web/e2e/notification-readability.spec.ts` (new) — fixed long-content fixture across themes/widths/zoom, keyboard details, no side-effect POSTs, direct captures.
- `.gru-command/worktree.toml` — focused/static/browser verify scopes + fail-before baseline scope.
- `docs/BOARD.md`, `docs/FLOW.md` — update present-behavior descriptions.

## Tasks & Acceptance

**Execution:**
- [x] `src/ledger/db.ts` + `src/ledger/api.ts` + `src/ledger/notification-decision.ts` — decision columns, strict typed decision, decision recording (idempotent), row mapping.
- [x] `src/notifications/attention.ts` + `src/notifications/center.ts` — registry enforcement, decision-required escalation, Gh-97 path follows effective routing.
- [x] `src/board/server.ts` + `src/board/engine.ts` — escalation validation, decision endpoint, projection; disposition hook.
- [x] `src/supervision/supervisor.ts` + `src/main.ts` — breaker/provider-wall machine routing, guarded re-arm on disposition, legacy reconciliation, squat-notice resolution.
- [x] `web/src/lib/board-protocol.ts` + `board-client.ts` + `owner-band.ts` — protocol, client, row model.
- [x] `web/src/ui/board.ts` + `web/src/styles/components.css` — shared readable card, decision controls, Details disclosure, focus/disclosure preservation, contrast.
- [x] `web/e2e/notification-readability.spec.ts` + `web/playwright.config.ts` — fixed fixture browser regressions and captures.
- [x] Backend/web unit suites updated + new focused tests.
- [x] `.gru-command/worktree.toml` verify scopes; docs updates.

**Acceptance Criteria:**
- Given a routine recoverable minion stop, when detected, then the machine queue owns supported recovery/re-arm and no FOR YOU row or owner bell is created.
- Given an operational decision beyond Silas, when it escalates, then Gru receives it (action-required) and the owner is not prompted unless a reserved boundary is stated.
- Given a genuinely owner-only decision, when escalated, then both owner surfaces show the same question, recommendation, options, consequences and Details; buttons match supported server behavior and no generic Ack or routine Re-arm control appears in FOR YOU.
- Given a long diagnostic notice, when rendered, then the default face is readable in both themes and full evidence is inspectable.
- Given viewing/expansion/navigation/repeated clicks/failure/stale snapshot/reload, then no unchosen operation is recorded, duplicates are prevented, pending/error states follow authoritative evidence, and decision vs completion stay distinct.
- Given protected boundaries, ordinary recovery cannot bypass them; decisions stay visible until settled.
- Given keyboard/zoom/mobile/desktop/light/dark, cards/controls are readable with correct focus and no clipping/overflow.
- Given legacy/unknown cards, they are handled honestly (no invented action, no silent drop).

## Verification

**Commands:**
- `node tools/patch-vitest-rpc-timeout.mjs && npx vitest run test/notification-decisions.test.ts test/notifications.test.ts test/board-server.test.ts test/board-engine.test.ts test/board-engine-v4.test.ts test/supervisor.test.ts test/provider-recovery-sensor.test.ts test/provider-recovery-resume.test.ts test/silas-driver.test.ts test/suite-shape.test.ts` — expected: all pass.
- `node tools/patch-vitest-rpc-timeout.mjs && cd web && ../node_modules/.bin/vitest run src/lib/board-protocol.test.ts src/lib/owner-band.test.ts src/lib/palette-contrast.test.ts src/ui/board.test.ts src/ui/board-merged-attention.test.ts src/ui/owner-chime.test.ts` — expected: all pass.
- `node tools/patch-vitest-rpc-timeout.mjs && npm run lint && npm run typecheck && npm run build` — expected: success.
- `node tools/patch-vitest-rpc-timeout.mjs && cd web && node ../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node node_modules/vite/bin/vite.js build && node ../node_modules/@playwright/test/cli.js test --project=notification-readability` — expected: pass + captures.

**Manual checks:**
- Inspect captures (both themes, 390/768/1280, 200% zoom, 320px container): no overflow/clipping, sentence-case prose, Details intact.
- Confirm no real owner notification is acknowledged during tests.

## Implementation Notes

- 2026-10-11: spec authored in-lane from the released v3 briefing + live
  code investigation at base f738b9b1.
- Server: owner-attention registry enforced in NotificationCenter (owner
  force/deny, typed decision required for `gru.owner-escalation`,
  unknown→Gru), migration 25 + record-only decision endpoint, breaker and
  provider-wall stops moved to machine attention with the guarded
  disposition re-arm, boot reconciliation of legacy owner rows, port-squat
  notices resolved on a successful bind.
- Web: one shared card for band + bell (mixed-case title/context, short
  metadata label, typed decision block, Details disclosure, focus/open
  preservation), decision submission with overlay/error states, AA contrast
  on live/error/receipt surfaces.
- Verification run in-lane: focused backend 320 passed; web units 623
  passed; lint/typecheck/build green; `notification-readability` Playwright
  project 6/6 with captures inspected; fail-before oracle 3/3 AssertionError
  RED on the isolated f738b9b1 snapshot and GREEN at head.
- Matrix audit: every I/O matrix row is covered by a named test that ran in
  the focused verification output (registry/decision suites, supervisor and
  provider seams, board-server, web unit suites, e2e).
- Review round 1 (d0470c25) returned 7 blind-hunter, 7 edge-case and 5
  verification-gap findings; all verified real and patched (see the Review
  Triage Log). Re-verification after fixes: fast backend 2924 passed; web
  units 623+ passed; lint/typecheck/build green; the three browser projects
  (notification-readability + mock + real) 62 passed; theme snapshots
  regenerated and visually inspected.
- 2026-10-11 R12 proof correction: the notification-only fixture restores
  helper-owned inline font sizes and snapshots all text baselines before
  changing them; it checks independent pre/post sizes for FOR YOU, expanded
  diagnostics and bell-list content, including relative-size text and fresh
  nodes after snapshot replacement. Root/body, viewport, DPR, composer and
  panel geometry are pinned; no product styles were changed.
- Scheduled browser capture on c69a5b92 reached 64/66 tests; both failures
  were the 320px container assertion using `clientWidth`, which measured
  314px after an internal scrollbar. Container-size checks now use the
  border-box width; client width remains the horizontal-overflow oracle.
  The complete failed capture and failure images remain preserved.
- 2026-10-11 main integration: `origin/main` at
  `79c032e5a5a1ba7607b5daf6cafa36c2aecbdd37` was merged as
  `8d98be911a23df52a1abc786722157df3913308f`. The migration collision was
  resolved by retaining main's migrations 26–27 and assigning the
  never-applied owner-decision migration ID 28. The exact-head `full`
  scope passed; the browser scope completed 66 tests (65 passed, 1 failed)
  at the mock theme snapshot in `web/e2e/smoke.spec.ts:1470`. The main
  snapshot showed three legacy FOR YOU rows while the branch's smoke test
  expects two rows with the typed decision card. The merge kept main's PNG
  despite that test change. The captured screen matches the test contract;
  only the light/dark theme snapshots were refreshed by the targeted test
  (1 passed) and visually inspected. The 65/66 receipt remains preserved
  as historical evidence; final-head scopes are recorded separately.

## Spec Change Log

- 2026-10-11 R13: added fresh-DOM 2× assertions for the rebuilt owner and
  bell decision diagnostics. The mock theme snapshots were refreshed after
  tracing the integrated-head mismatch to main's stale three-row images;
  the targeted theme test passed and the light/dark results were inspected.
  That targeted test is not a substitute for separate exact-head full/browser
  capture receipts.

## Review Triage Log

Round 1 (head d0470c25; blind-hunter / edge-case-hunter / verification-gap
tracked review jobs). Every finding was verified against the code; all were
real and are patched in this round. Verdicts:

- Stale browser estate asserting the removed owner-Ack contract
  (`web/e2e/smoke.spec.ts`, `web/e2e/real-server.spec.ts`, mock fixture) —
  high; patch. Verified the specs pinned `.board-owner__ack` 'Ack' and the
  decision-less needs-owner POST (which now 400s). Fixed: smoke/mock moved
  to a typed decision + machine provider row; real-server round-trips a
  typed decision, the recorded choice and the disposition follow-through;
  the decision-less POST is pinned to 400; the browser scope now runs
  `--project=mock --project=real` too; theme snapshots regenerated and
  inspected.
- `roles/gru.md` instructed a bare `{title, detail}` escalation — high;
  patch. Fixed to the typed decision payload with the decision/disposition
  endpoints and pinned in `test/roles-gru.test.ts`.
- A recorded owner decision had no settlement path — high; patch.
  `POST /api/notifications/:id/disposition` now resolves an already-decided
  owner row with the follow-through detail; an undecided row is refused
  (code `undecided`); board-server and notification-decisions tests cover
  both plus idempotency.
- Owner notices promised producer resolution that did not exist
  (enforce-gate / sweep pauses / blocked wakes) — high; patch. Producer
  resolutions implemented: a passing gated call clears its enforce-gate
  incident, a completed sweep resolves only that worktree's
  `worktree-sweep-paused:<id>:<pause>` notice, and a delivered wake clears
  blocked/failed wake stops; each has a focused test.
- Ack-era documentation (BOARD/UI/SUPERVISION) and runtime strings
  (chat breaker message, awareness comment, supervisor re-arm log) — low;
  patch. Updated to the disposition/decision model.
- `awareness.test.ts` hard-floor case no longer exercised an owner-routed
  row (breaker downgraded) — medium; patch. Now posts a registered
  `port-squat` row and asserts its effective routing.
- An ack could clear a typed decision row out of FOR YOU — high; patch.
  The ledger refuses it and the HTTP surface answers 409
  `decision_required`; both covered.
- A machine stop deduping onto a surviving legacy owner row could strand
  the lane — medium; patch. `openIncident` now re-triages such a row to
  machine attention with a note before reuse; test added.
- Non-boolean `discussion` was silently coerced — low; patch. Validation
  now throws; test added.
- `isOwnerHeldNotificationKind` kept stale semantics with no remaining
  callers — low; patch. Removed.
- Ambiguous transport failure claimed "nothing was changed" — medium;
  patch. Server refusals and unconfirmed transport failures now read
  distinctly; test covers both.
- Bell focus could jump to the band's lookalike card — medium; patch.
  Owner-focus capture/restore is scoped to the band; bell copies keep only
  their own focus keys; a test pins bell focus across a re-render.
- Snapshot projection of decision/decided fields untested — patch.
  `test/board-server.test.ts` asserts the `/api/board` projection carries
  the question and the recorded state.
- main.ts boot bindings (disposition hook, port-squat clearance, legacy
  migration, sweep resolution) had no assembly pin — patch. A source-drift
  pin in `test/board-engine.test.ts` covers all four.
- Mock fixture no longer represented the shipped owner surfaces — patch.
  Updated to the typed decision + machine rows (also resolves the stale
  smoke assertions above).

Round 2 (head 4d9d724c; same three tracked lenses). Round-1 resolutions
were verified; the remaining/new findings were all real and are patched:

- `reconcileMissingTree`'s `onSwept` call sat after an unconditional
  `return` (dead code) — high; patch. Moved before the return; a
  manager-level test now drives both the missing-tree reconcile and the
  direct sweep and asserts the callback (added to the focused scope under
  the classified heavy config).
- `focusNotification`'s fallback was document-wide, so a decision recorded
  from the bell landed focus on the band's lookalike — high; patch.
  `focusNotification(id, root)` now takes the owning surface; the
  disappearing-control bell path has its own unit test.
- A resolved decided row still read "awaiting follow-through" — high;
  patch. The line is conditional and a FEED test pins "follow-through
  resolved".
- The option-submit error line was unreadable on error cards (dark:
  `--danger` IS `--alert`) — high; patch. Forced to `--on-state` on the
  alert surface and pinned in the palette suite.
- Legacy unattributable `worktree-sweep-paused` rows had no settlement —
  medium; patch. The boot migration re-triages them to Gru with a note
  (scoped rows keep their own sweep-evidence resolution).
- Enforce-gate settlement used a LIKE prefix that could bleed between
  surface names — medium; patch. `resolveNotificationsByExactKind` + test.
- No negative protocol test for junk decision payloads — patch. Malformed
  question/discussion/options/decided fields now pinned invalid.
- The registry override warn log named the wrong direction when an
  owner-required kind was forced owner — low; patch. Direction-aware copy.
- Remaining Ack-model docs/strings (SUPERVISION/OPERATIONS/LEDGER/CONFIG,
  generated config reference, example config, chat breaker messages,
  board/engine comments, Silas role and ops-skill lists) — medium; patch.
  All updated to the disposition/decision model.
- The focused scope omitted the new regression files — patch. Added
  decisions-shadow, roles-gru/roles-definitions and the worktree-manager
  case.

Round-2 verification result: the reviews ran against 4d9d724c; the
hygiene fixture-path commit and these fixes move the head, so a final
whole-change round (3) reviews the exact final head before any merge
presentation.

Round 3 (head a86922d7; same three tracked lenses). All round-2
resolutions verified. One blocker-class finding (its location intersects
the round-2 hunks) and several follow-ups; fixed in one batch:

- The exact-kind enforce-gate fix had no CONSUMER-level discriminating test
  — high/blocker; patch. `test/decisions-shadow.test.ts` now opens a
  `${surface}-extra` lookalike incident and asserts it stays unresolved
  after the passing gated call (reverting to the prefix call would fail).
- `docs/FLOW.md` still said the disposition endpoint refuses needs-owner
  rows outright, contradicting the decided-row follow-through — low;
  patch (wording corrected).
- The sweep-heal path never re-fired `onSwept`, so a pause notice whose
  first resolution was lost (crash between the flip and the hook) stayed
  open — medium; patch (the hook re-fires when the tree is gone; the heal
  test asserts it).
- Boot clearance for port squats used prefix resolution — low; patch
  (`resolveExactKind` + assembly pin updated).
- Remaining "owner-held provider wall" wording (Silas brief, main comment,
  chat refusal, ops-skill list, provider-recovery spec code-map) — low;
  patch.
- The focus fallback parsed ids with a fixed `split(':')[1]`, so an id
  containing ':' (e.g. `lessons-proposal-withdrawn:<uuid>`) dropped focus
  to `<body>` — medium; patch (suffix-aware parse + regression).
- The legacy-owner paging claim (that the pass mutates the set it pages
  over) — false: the function materializes every page before the mutation
  loop; recorded refutation.
- A vacuous `owner-ack:lp-1` null assertion in a proposal test — low;
  patch (asserts the real Accept/Reject controls and the removed family).
- Direct (non-HTTP) producers could store a malformed decision that reads
  back as 'no decision' — medium; patch (the notification center now
  deep-validates at its write boundary).
- The spec's own Code Map named `requiresOwnerDecision` instead of
  `requiresTypedDecision` — rejected by the review rule that bars fixes
  editing this build's spec; corrected opportunistically as an agent-owned
  Code Map typo.
- The real-server compact epoch race stays deferred (pre-existing,
  reproduced at the pristine base; recorded in deferred-work).

R12 actual text-only zoom reports (review target 8e1e20f48b56bed52880560386efb1668cf86530; complete change 46615b80f6cabd96d5b3cfe22d71f3d627fdcd08..8e1e20f48b56bed52880560386efb1668cf86530). The three genuine reports were acted under the existing commissioner; their report and phase obligations are settled, and these entries do not re-dispatch or re-disposition them. Each finding was verified against the reviewed code and routed to patch:

- `high` — edge-cases: the document-wide parent-first loop can record a relative-size descendant after its ancestor was doubled, then double it again. The reviewed helper did this; current helper restores its inline overrides and measures all notification-text baselines before scaling, with an independent 1.08em probe (patch).
- `high` — edge-cases: scaling every element includes `html`, so `rem`-based layout such as the 10rem composer cap can grow. The reviewed helper iterated `*`; current helper scopes changes to notification text and asserts unchanged root/body/composer metrics (patch).
- `high` — blind-hunter: the same reachable relative-size descendant can exceed the required factor while the reviewed title oracle passes. The current test directly measures a relative probe before and after on initial and rebuilt content (patch).
- `high` — blind-hunter: `probeBase` and `probeAfter` came from the mutating pass, allowing a wrong base to validate itself. Current tests take independent font-size samples before applying the helper and again after a snapshot rebuild (patch).
- `high` — blind-hunter: expanded diagnostic and bell-list text were not required to double. Current tests independently measure the owner detail and notification-list title/details at desktop and 320px panel width (patch).
- `high` — verification-gap: the global relative-size descendant can be over-scaled while fixed-size title checks pass. The current notification-only mechanism and relative probe assert exact doubling on initial and rebuilt content (patch).
- `high` — verification-gap: the original exact-factor check used its own pass’s baseline. Current assertions use separately captured pre-pass and rebuilt-DOM baselines (patch).
- `high` — verification-gap: panel text could remain unzoomed while the owner card oracle passed. Current tests assert exact pre/post sizes in `#notification-list`, including the 320px panel condition (patch).

R13 actual text-only proof round (candidate
`8d98be911a23df52a1abc786722157df3913308f`; three tracked reviewers). The
blind-hunter reported no actionable findings. Edge-cases and
verification-gap independently found that the post-rebuild 2× assertions
omitted the fresh owner Details diagnostic and the bell decision Details
diagnostic. Both findings were acted on: add replacement probes and
independently measure each fresh-node baseline before asserting 2× after
reapplication. No product CSS changed. Verification-gap also surfaced the
single browser failure. Investigation traced it to main's stale theme
snapshots; only those two images were refreshed and the focused test
passed. The failed capture remains historical; final-head evidence is kept
separately.

R14 confirmation (candidate `ffb65f1da5d22eb975c11f36e68c6e5b992a9334`).
The blind-hunter reported no actionable findings. Edge-cases and
verification-gap found that the rebuilt bell decision Details text was
measured while the panel was hidden, allowing a hidden node to satisfy the
computed-font assertion. The test now verifies the owner disclosure remains
open/focused, reopens the bell panel after the snapshot push, verifies its
decision disclosure remains open and the diagnostic text is visible, then
measures and asserts the 2× result. No product CSS changed. Two additional
verification-gap follow-ups (cross-surface content equivalence and
unknown/legacy browser coverage) were explicitly deferred as outside the
actual text-only zoom proof task.

R2 whole-change Perkins review (target `bb44455891f5e8b8332e676781020a9d480370ef`, diff base `79c032e5a5a1ba7607b5daf6cafa36c2aecbdd37`; verdict MAJOR REWORK NEEDED). The four blockers and separate dark error-card chip contrast warning were confirmed against the frozen source. This correction cycle carries the notification re-arm fence through failed-spawn retries and paced prompt replay; checks active Perkins ownership at each re-arm boundary; checks jobless Silas provider waits before the no-job return; includes asynchronous `supervision.rearm-fenced` outcomes in durable stop reconstruction and mailbox restrictions; and gives state chips an explicit AA-safe ink-on-paper pair. Focused regressions cover retry/backoff, queued replay and retained debt, active-round refusal before and during spawn, Silas slot provider ownership, fresh-supervisor/board reconstruction, mailbox restrictions and both-theme chip contrast. At the time this triage entry was recorded, exact-head scheduled verification and refreshed review were pending; the immutable scheduler receipts and later review disposition are authoritative for their outcomes.

Round R2 correction review (target `987c5fc2ba9d8689665df974ac80bd6171055123`; diff base `79c032e5a5a1ba7607b5daf6cafa36c2aecbdd37`). Findings were checked against the named code paths; all confirmed findings route to patch:

- `high` — blind / edge: `gru.wake-blocked-mailbox.` was absent from owner routing, so boot reconciliation could demote a mailbox stop. Added the registered prefix plus delivered-wake resolution and owner guidance; tests cover legacy retention, recovery resolution and copy.
- `medium` — blind: a same-option retry after follow-through returned `not_open`. The ledger now checks recorded-choice idempotency before resolved state; tests distinguish recorded-and-resolved replay, conflicting choices and resolved-undecided rows.
- `medium` — blind: `decision_recorded` / `not_open` conflicts left stale options described as retryable. Both surfaces now lock and refresh on those codes; unit tests assert owner/bell state and authoritative decided/resolved replacement.
- `medium` — edge: a discussion route clicked the in-pane collapse/close control instead of opening chat. It now uses the real FAB; the board test drives `ConsoleShell` with a collapsed pane and verifies expansion plus composer focus.
- `medium` — edge: notification IDs containing the literal `:option:` marker were truncated during focus fallback. Parsing now uses the final marker; a DOM regression checks the complete ID receives focus.
- `medium` — edge: successful decision overrides survived `bindClient()` and could contaminate another service reusing an ID. Re-pair now clears overrides; test records on one client then verifies the second client's undecided row remains actionable.
- `medium` — edge: enforce-gate notices inherited credential guidance, which cannot repair invalid or failing backtest evidence. Guidance now names the backtest evidence and gated-surface retry; a kind-specific test distinguishes it from provider degradation.
- `high` — edge: asynchronous re-arm fences persisted stop truth without the active retry-control binding or failed-post debt. Lifecycle events now carry the current control and pending reason; restart hydration restores/binds stopped agents, disposes an adopted handle, and retries missing controls. Tests cover both a live control after restart and failed-post debt recovery.
- `high` — verification-gap: source-text assembly checks and separate stubs did not drive a real supervisor refusal through authenticated HTTP wiring. The production binding is shared and a board-server integration test asserts the real refusal leaves the machine alert unresolved.

## Design Notes

- **Owner-attention registry is the single authority.** Producer intent
  is honored only for registered kinds; `needs-owner` requests from
  unregistered or machine kinds are routed to Gru (action-required) and
  logged, so routine recovery can never ring the owner. Unknown kinds triage
  to Gru rather than inventing owner controls.
- **Decision effects are record-only.** The only supported effect of an
  option is recording the owner's decision durably (with an event); the
  follow-through stays with its owner (Gru/Silas) and the row remains
  visible, distinct from completion. Lessons proposals keep their existing
  accept/reject endpoints and review.
- **Legacy migration.** A bounded boot reconciliation re-triages unacked
  owner rows whose kind is not owner-registered (or legacy
  `gru.owner-escalation` without a typed decision) to action-required with
  a recorded note: not dropped, not acked, not executed.
- **Readability.** The card face is title + short metadata + typed
  context/decision; full diagnostics live in an accessible `<details>`.
  Short detail may render as the body verbatim (no semantic derivation);
  long detail never truncates. `.lbl` remains only for short labels.
- **Breaker re-arm** stays guarded by the existing recovery-authority fence
  and now rides the Gru disposition path instead of an owner ack; it never
  bypasses owner stops, budgets, directive holds or terminal lanes.
