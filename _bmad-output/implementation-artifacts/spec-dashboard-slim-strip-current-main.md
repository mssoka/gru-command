---
title: 'Dashboard slim strip — current-main continuation (approved Sample2 port)'
type: 'feature'
created: '2026-10-07'
status: 'in-review'
route: 'dispatch'
baseline_commit: '49b558f243c7bacbfb46c7bc04f749bf131cefea'
review_loop_iteration: 16
context: []
---

<!-- Continuation provenance: owner approvals j-1139 (resume), j-1253 (disk-floor
     removal), j-1255 (fresh-current-main linked continuation). Canonical contract
     GET /api/dispatch/jobs/dashboard-slim-strip/contract v3 (amendments 7b87be1d,
     69bd750b, 1eedb231). Approved intent carried from the original lane's
     spec-dashboard-slim-strip-approved.md (read-only source, HEAD 4de42d9).
     The dispatch briefing for job dashboard-slim-strip-current-main-20261007
     authorizes the whole build: implementation, built-in independent review,
     fixes, verification and one ordinary non-draft PR. No intent gap remained;
     no fabricated checkpoint is claimed — the frozen intent below is the
     owner-approved intent with only current-main-compatibility framing.
     Frozen-block clarifications (implementation-level, not intent changes):
     baseline pin refreshed 84aec28 → 49b558f per amendment #3; presentation
     merges main's newer facts (six sections, #163 silas precedence, #219
     deferred wakes, #161 children, Binned) rather than the older 059c076 base. -->

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The rail's seven large pills and the fully-expanded FOR YOU rows spend vertical space before the board. The owner selected the compact-strip presentation (approved reference Sample2 only; `source-with-image-omitted.txt` + three inspected captures), and the continuation must land it on current main without losing anything main has since merged.

**Approach:** Re-render the rail as a slim wrapping status row plus stable count groups (Heists / PRs / Crew, and the optional CHILDREN group when present), and re-face FOR YOU rows as collapsed summaries behind a per-row reveal-only "Review decision" control with the expanded region carrying the verbatim detail and full consequences. Counts, titles, tones, identities and action semantics come from the existing derivations unchanged; density comes from hierarchy/spacing on the existing Playful Planet theme. The port is targeted semantic hunk application from original `4de42d9` onto current main `49b558f` — no merge/cherry-pick, no whole-file replacement, no deduplication of main's newer facts.

## Boundaries & Constraints

**Always:**
- Every existing labelled fact and `data-kpi` identity renders from existing derivations (`railChips()`/`ownerRows()`); zero/unknown/empty/n-a semantics and existing title text preserved. Main's newer facts stay: six sections + order, Pipeline, full uncapped counts, previews 5/5/3, collapsed For Gru/Cold, count-only Cold, Binned rows behind their own disclosure, #163 Silas precedence/FAILED/full detail, #161 CHILDREN (absent field ⇒ group omitted, never a claimed zero), #219 deferred wakes (count/reasons/truncated), receipts, safe owner controls, deferred Gru wakes.
- Wake truth: GRU wake count and time derive ONLY from `snapshot.wakes`, never Silas. 0+no-or-invalid stamp is the honest no-wakes state (count still visible); count>0+missing/invalid stamp is "last wake unknown"; a supplied valid stamp is never discarded even at count 0.
- FOR YOU collapsed face: supplied title IS the Problem plus one SHORT static typed next-step line per kind family (`ackNextStep`; never parsed prose, never the full consequence). Expanded region: authoritative metadata, complete original detail and each action's full consequence beside that action's control. Ack / OPEN PR stay explicit separate controls; disclosure/navigation never ACKs, approves, executes, re-arms or changes pending counts.
- Every mutable numeric renders as its own reserved tabular slot with number and unit as separate spans fed by the same derivation that produced the string — including KPI counts, card values, numeric flags, wake count/age, pending count and the older-pending count. 9→10, 99→100, 999→1000 move no label, group box or row height at 1440/1200/768/360; larger values and long labels wrap honestly (no nowrap clipping, no overflow masking). Existing Playful Planet tokens/fonts/identity; essential text/numbers ≥4.5:1 contrast in light/dark and supported themes.
- Disclosure: keyboard Enter/Space via real buttons, visible focus, accessible names/`aria-controls`/`aria-expanded`; per-row state and focus survive snapshot refresh by stable action id + control kind; region ids allocated per action id (never slugged); row state retires only when the actionId leaves the full owner list; multiple rows disclose independently; the bell panel keeps its prior PR presentation (no shared region ids).
- Committed declared verification scopes through authenticated `/api/verify` with the shipped capture helper; baseline scopes pin base `49b558f243c7bacbfb46c7bc04f749bf131cefea` and must produce meaningful feature-absence fail-before RED; final-head unit and browser scopes pass; full/typecheck gates pass. Isolated synthetic browser fixtures only — never real owner notifications/buttons.

**Never:** new palette, font dependency, theme selector, or backend/API/schema/credential/model/config change; whole-file replacement of shared newer files by old ones; source-history merge/cherry-pick/reset/rebase/force-push; any write to the original lane or shared checkout; Binned/PR248/KPI-derivation changes; mock preview controls, reference imagery or illustrative counts in product artifacts; test weakening/skips; draft PR; merge/install/deploy/restart/cleanup; fabricating a workflow checkpoint or accepting a changed goal silently.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| COMPLETE | full snapshot: build/silas/verify/cure, children, deferred wakes, owner rows+PRs | every labelled fact + `data-kpi` renders truthfully; 6 pairs + groups stable; wakes count/age independent of Silas | n/a |
| EMPTY/UNKNOWN | missing build/verify/cure (`n/a`), silas null, wakes 0+null, absent children/deferred | honest n/a text; visible `no wakes yet · 0`; CHILDREN group omitted (never claimed zero); calm empty FOR YOU | n/a |
| WAKES_SPLIT | count>0 + null/invalid stamp; count 0 + valid stamp; valid stamp + count>0 | "last wake unknown" (never "no wakes yet"); supplied stamp never discarded; terse split age | unparseable stamp = unknown, never fabricated |
| BOUNDARY | 9/10, 99/100, 999/1000 at 1440/1200/768/360, long labels, both themes | reserved numeric slots; no label/group/row-height jump; no body/component overflow, clipping or masking; ≥4.5:1 contrast | >4-digit values wrap honestly |
| REVEAL | collapsed ack and PR rows; keyboard Enter/Space | region toggles with `aria-expanded`; NO request, no ack, pending count unchanged; full detail + consequences visible when expanded | long/untrusted text wraps as text |
| REFRESH | expanded+focused row; settled row removed; row pushed outside older-pending window | state+focus survive by action id + control kind; removal retires only that row; window-hidden row keeps identity | n/a |
| IDENTITY | colliding action ids (`a_b` vs `a-b`); band + bell PR rows | distinct allocated region ids and focus targets; panel keeps prior presentation, no shared region | n/a |
| UNSAFE_URL | non-https `prUrl` on a projected row | "PR link unavailable" text; never a link | fail closed |
| DEFERRED | wakes.deferred present (count/reasons/truncated) or absent | deferred count + reasons in the chip title; absent renders exactly as before | n/a |

</frozen-after-approval>

## Code Map

Port map (source `4de42d9` → destination current main `49b558f`):
- `web/src/lib/board-health.ts` — add `ValueSplit`/`FlagSplit` + `valueSplit`/`flagSplit` on `HealthCardView`; re-derive splits for main's #163 silas headline (`pass failed Xm ago`/`turn open Xm ago`/`reconciled Xm ago`/`wake Xm ago`/`no wakes yet`; FAILED flag is pure text → `flagSplit: null`); keep main's `value`, precedence, `full`/`detail`, ALERTS copy. `restartPending` untouched.
- `web/src/lib/board-rail.ts` — passthrough `valueSplit`/`flagSplit` from cards; trackers chip gets empty split; keep #161 CHILDREN + binned KPI groups and order.
- `web/src/lib/owner-band.ts` — additive `ackNextStep(kind)` beside `ackConsequence`; same kind families (supervision → "Ack re-arms this worker.", decisions.degraded → records saw, worktree-sweep-paused, port-squat/roll-port-squat, else neutral).
- `web/src/ui/board.ts` — slim rail replacement: `strip-status` row of `.strip-pair` (`statusPairNode`/`stripValueNode`/`stripFlagNode`) + `.strip-groups` (`stripGroupsNode`) replacing `railChipNode`/`trackersChipNode`; Jev/unacked/wakes chips move into the row (unacked always hidden — number renders once on ALERTS pair; wakes chip keeps main's deferred count/reasons/truncated title, merged with lane's count/age split; `ageSplitNode` + split mode in `refreshAge`); compact owner band: `expandedOwnerRows` set, `ownerRegionIds` map + `nextOwnerRegionId`, `ownerRegionId()`, `ownerDiscloseNode()`, two-arg `refocusAction(actionId, control)` (call site line ~480), `ownerAckRow` face/detail split with `data-control`, `ownerPrRow(row, surface)` panel variant for the bell (line ~1673 call site); retire-on-removal in `renderOwnerActions`; keep `renderNav`/sections/focus machinery/receipts intact.
- `web/src/styles/components.css` — replace the `.chip-rail`/`.rail-chip*`/`.rail-kpi*` block (main lines ~257–394) with slim-strip styles; scoped `#chip-rail .num, #board-owner .num` tabular slots (`min-width: calc(4ch + 1px)` / `calc(4ch + 1em)`); `@container (min-width: 640px)` 3-column groups; re-face `.board-owner__*` block (~1754–1898) with face/actions/disclose/detail + panel variant; keep every unrelated main style.
- Tests: `web/src/ui/board.test.ts` (rail describe ~475–652 re-faced to strip selectors; FOR YOU describe ~2420+ `data-control` updates + lane's new regressions appended: wake truths, independent reveal no-request, short face vs expanded, id collision, push/removal, window keep, ack/open focus, panel surface scoping); `web/src/lib/board-rail.test.ts` (append split describe); `web/src/lib/owner-band.test.ts` (append `ackNextStep` describe); `web/e2e/dashboard-strip.spec.ts` (lane-only, port + silas fixtures for main's `isValidSnapshot`, add children-present and deferred-wake cases); `web/e2e/smoke.spec.ts` (rail assertions to strip DOM; keep six-section suites); `web/playwright.config.ts` (mock `testMatch` union); `.gitignore` (`web/e2e-artifacts/`); `.gru-command/worktree.toml` (union 9 scopes + directive-recovery scope, baselines pinned to `49b558f`).

## Tasks & Acceptance

**Execution:**
- [x] `web/src/lib/board-health.ts` + `web/src/lib/board-rail.ts` + `web/src/lib/owner-band.ts` — additive splits + `ackNextStep`; no derivation changes.
- [x] `web/src/ui/board.ts` — slim strip + merged wakes chip + compact owner band (disclosure, allocated regions, focus, panel surface).
- [x] `web/src/styles/components.css` — slim-strip and compact band styles with reserved numeric slots and 640px container groups.
- [x] `web/src/ui/board.test.ts`, `web/src/lib/board-rail.test.ts`, `web/src/lib/owner-band.test.ts` — re-face existing rail assertions, append the lane's deterministic regressions.
- [x] `web/e2e/dashboard-strip.spec.ts` — port the synthetic suite; extend silas fixtures to main's protocol; add CHILDREN present/absent and deferred-wakes cases; keep 1440/1200/768/360 × light/dark captures.
- [x] `web/e2e/smoke.spec.ts`, `web/playwright.config.ts` — selector migration + mock testMatch union.
- [x] `.gru-command/worktree.toml`, `.gitignore` — union scopes (`strip-browser`, `dashboard-slim-strip-unit` (board.test.ts, board-rail.test.ts, owner-band.test.ts, slim-strip.baseline.test.ts), `dashboard-slim-strip-baseline` base-pinned, `strip-browser-baseline` base-pinned) + `web/e2e-artifacts/`.
- [x] Perkins r6 baseline follow-through — overlay the test-only helper required by integrated `board.test.ts`, classify every failed zero-assertion suite as setup/collection failure, and verify the feature-absence baseline at the current code head.
- [ ] Built-in independent whole-change review via `POST /api/dispatch` (`deliverable: review`) on the exact committed head; triage every finding, address required changes, and re-verify any moved head.

**Acceptance Criteria:**
- Given complete/empty/zero/unknown/stale snapshots, when the strip renders, then every current-main labelled fact and `data-kpi` value is truthful, GRU wake/count stays independent of SILAS, and Binned stays distinct from Parked/success.
- Given 9/10, 99/100, 999/1000 fixtures at 1440/1200/768/360 (+ long labels, both themes), when rendered, then adjacent labels/group geometry do not jump, no body/component horizontal overflow or clipping occurs, and essential text/numbers meet ≥4.5:1 contrast.
- Given multiple owner notices/ready PRs, when rendered, then faces are initially collapsed with heading/count/calm empty state and older-pending access; Enter/Space disclosure, focus and expanded state survive snapshot refresh; reveal makes no operational request or pending-count change; Ack/OPEN PR remain explicit and reconcile ambiguity to the authoritative snapshot.
- Given the rest of the cockpit, when any other surface renders, then order/counts/previews/collapsed sections/Binned disclosure, chat, crew/transcripts, receipts and navigation are unchanged.

## Implementation Notes

<!-- Appended during implementation. -->
- 2026-10-07 (job dashboard-slim-strip-current-main-20261007): ported the lane's presentation hunks onto current main by hand (no merge/cherry-pick; per-file provenance from `4de42d9` blobs recorded in the ignored preservation manifest). Base 49b558f; branch `gru/dashboard-slim-strip-current-main-20261007`.
- Merges recorded: wakes chip = lane count/age split + main #219 deferred (count/reasons/truncated), number rendered once on the ALERTS pair with the tracker chip hidden but text/title-complete; silas splits re-derived for main's #163 headline branches (pass failed / turn open / reconciled / wake / no wakes yet) with `FAILED` as pure text (no numeric part); CHILDREN preserved as an additional group only when the server reported counters; Binned KPI preserved; bell panel keeps its prior PR presentation via `ownerPrRow(row, 'panel')`; all six sections/previews/cold-binned behavior untouched.
- e2e suite refreshed for the current-main protocol: complete SilasView fixtures (no `undefined !== null` branches), 13 data-kpi slots (binned added), CHILDREN present/absent and deferred-wake cases added, reserved-slot geometry kept at 1440/1200/768/360 ± themes.
- Verification scopes unioned in `.gru-command/worktree.toml`; both baselines pin `49b558f…` (the recorded execution base), not the obsolete 84aec28 planning pin.
- 2026-10-07 verification round at head `a8847055e3d0c11eddb282458e67c7e6b88a359a` (all through the authenticated scheduler + shipped capture helper; complete NDJSON sinks + receipts under `_bmad-output/verify-captures/current-main-20261007/`): `dashboard-slim-strip-unit` (board.test.ts, board-rail.test.ts, owner-band.test.ts, slim-strip.baseline.test.ts) GREEN run 73255daf (137/137); `strip-browser` GREEN run 5d3bc3d2 (67/67, captures inspected at 1440/1200/768/360 light+dark); `dashboard-slim-strip-baseline` RED run e7bf5e64 (23 assertion-level feature-absence failures + 1 missing-export TypeError inside a test for the new `ackNextStep` import; no collection/suite-level error); `strip-browser-baseline` RED run 6bda4166 (67/67 fail on the missing strip DOM, baseline app builds); `typecheck` GREEN run 4cbd19a1; `full` GREEN run 19589690 (lint/typecheck/build + backend 2291 passed + heavy 925 passed + web 537 passed, exit 0). Independent whole-change review is commissioned via `POST /api/dispatch` (`deliverable: review`, three lenses) at this exact head as part of this round.
## Spec Change Log

## Review Triage Log

Round 1 (whole-change, three tracked lenses) reviewed `6e48023cfba4eade8130548cd31e28d5359f3f42`: blind-hunter 12 findings, edge-case-hunter 5, verification-gap 5 + 1 other. Every finding below was verified against the reviewed code; no `intent_gap` or `bad_spec` entry (code/tests carry each correction), so the round proceeds as patch + explicit re-verification at the fix head.

| # | Finding (surface) | Verdict | Route / evidence |
|---|---|---|---|
| 1 | BH1 + EC3 + EC4 + VG-other — trackers `titleAttr` no longer rendered (`board.ts` stripGroupsNode) | medium | patch: `groups.title = trackers.titleAttr` + unit assertion. The old chip's aggregate tone class is intentionally retired (its components carry their own tones on the ALERTS pair and the Jev chip); tooltip is restored, so the "existing title text preserved" claim is true again. |
| 2 | BH2 — deferred-only wakes rendered "last wake unknown" (`board.ts` renderTrackers) | medium | patch: the no-wakes branch now triggers on `count 0 + no/invalid stamp` regardless of deferrals; the deferred tally appends beside it in text and title. Unit case added; e2e expectation corrected. |
| 3 | BH3 + BH9(scope) + VG1 — migrated smoke suite executed by no scope; frozen theme goldens stale (repo browser gate red) | high | patch done in-loop: `strip-smoke` + `strip-themes(-update)` scopes added; the four goldens regenerated, visually inspected (mock+real, light+dark) and committed at `ee0f24a`; `strip-themes` and `strip-smoke` GREEN at that head. Re-verified at the fix head. |
| 4 | BH4 — wrapped CHILDREN group takes a stray left border / loses its row separator (`components.css`) | low | patch: `:nth-child(3n+1):not(:first-child)` row-separator rule in the 640px container; e2e computed-border assertions on the 4-group layout. |
| 5 | BH5 — deferred-count slot not covered by geometry | medium | patch: `.board-wakes__deferred` added to the measured slot set; 999→1000 pairwise geometry case added to the deferred e2e test. |
| 6 | BH6 — "one font, two floors" rationale mismatch (`4ch+1px` vs `4ch+1em`) | false | The claimed bad outcome (undetected 999→1000 growth in the sans strip slots, or user-visible dead space) is disproven at the reviewed head: every boundary pair, including those sans slots, measured equal boxes at 1440/1200/768/360; the band floor is invisible block padding. No shipped behavior follows from the comment wording. |
| 7 | BH7 — A1 scoping probe skips `min-width` | low | patch: probe now asserts `parseFloat(styles.probe.minWidth) || 0 === 0` (the first attempt asserted `toBe('auto')`; corrected in `e5ae13e` because Chromium resolves the unset value to `0px`). The probe now fails on both a global display leak and a global reservation leak. |
| 8 | BH8 — contrast targets omit flag pills / group labels / detail meta | medium | patch: targets extended (flag text, group name+unit, detail meta+notice). Offline WCAG check of the actual tokens: flag 7.81/6.08, unit 5.04/5.82, detail meta 4.98/5.50 (light/dark) — the scheduled run re-verifies in-browser. |
| 9 | BH9 + VG2 — mock smoke assertions pass on hidden collapse content | medium | patch: the smoke FOR YOU test now asserts collapsed-first, reveals each row, asserts `aria-expanded`, visible detail and visible consequence/evidence. |
| 10 | BH10 — duplicate nested `aria-label`, h3-before-h2 group heads, N identical disclosure names | low | patch: inner `aria-label` removed (the rail already carries it); group heads are `h2` (as in the approved reference); each disclosure gets `aria-label="Review decision: <row title>"`. |
| 11 | BH11 + EC2 — duplicate actionIds would collide region ids/focus | false | Not reachable: ack rows are keyed by ledger notification ids (primary keys) and PR rows one per projected jobId, with distinct `owner-ack:`/`owner-pr:` prefixes; the renderer contract assumes the snapshot's key uniqueness, and guards for an unreachable state are the rejected-complexity case. |
| 12 | BH12 — chained-optional silas assertion passes on `undefined` | low | patch: non-null assertion first, then numeric-content assertion. |
| 13 | EC1 + EC5 — focus falls to `<body>` when the focused owner control vanishes (settled/window-pushed row) | medium | patch: `refocusAction` returns a boolean; when the exact control is gone, focus moves to the older-pending control, else the first remaining band control; unit assertion on the window-push path. |
| 14 | VG3 — bell-panel fail-closed URL branch untested | low | patch: unsafe-URL panel render asserted (no anchor, "PR link unavailable") in the surface-scoping test. |
| 15 | VG4 — retire-on-removal unasserted | medium | patch: re-added same-id row asserts fresh collapsed state and a new region id (no resurrected lookalike). |
| 16 | VG5 — pair/flag `titleAttr` unasserted | low | patch: deploy pair + flag title assertions added. |

Named checks (not findings): the two baselines overlay final test bytes on base `49b558f` and leave exits unmasked — both RED by feature absence (23 assertion-level failures + 1 missing-export TypeError inside a test; recorded as the honest consequence of the feature's absence, matching the original lane's accepted baseline shape). Dark-theme geometry runs light-only in the boundary loop; the dark coverage is the contrast assertions plus the inspected dark captures at all four widths.

Round-1 resolution: all patch entries landed in commits `b030831` (main fixes + test hardening), `e5ae13e` (A1 probe zero-reservation), `64ab947` (real theme golden refresh for the CHILDREN separator fix, inspected). Re-verification at the fix head `64ab947`: `dashboard-slim-strip-unit` (board.test.ts, board-rail.test.ts, owner-band.test.ts, slim-strip.baseline.test.ts) GREEN 137 (run 803e9f62); `strip-browser` GREEN 67 (run 041a281b); `strip-smoke` GREEN (run f9e4f0bf); `strip-themes` GREEN (run 734295fb); `dashboard-slim-strip-baseline` RED (run f5976535); `strip-browser-baseline` RED (run a0cf1b64); `typecheck` GREEN (run 371b6da9); `full` GREEN (run 3f23f291). Round-2 whole-change review commissioned at `ddc42e4`; its blocking scope was the fix delta `6e48023..ddc42e4` (untouched-code findings reported as follow-ups).

Round 2 reviewed `ddc42e431347443411158aeff50b8f9070c76f9d` (blind-hunter 13: 5 blocking + 8 follow-ups; edge-case 4: 3 blocking + 1 follow-up; verification-gap 6: 3 blocking + 3 follow-ups; plus other observations). Blocking entries were all patch; the cheap follow-ups were folded into the same batch; two breadth items are deferred (deferred-work.md).

| # | Finding (surface) | Verdict | Route / evidence |
|---|---|---|---|
| R2-1 | Empty-band focus residual: the round-1 fallback has no target when the last row settles (both queries null) — focus still reaches `<body>`; the older-pending button itself was never captured across pushes (BH#1, EC#1, VG#3, VG-other) | medium | patch: `focusBandFallback()` prefers the older-pending control → first band control → the band heading (now `tabIndex=-1`); the capture also treats a focused `.board-band__more` as a band target; the click handler re-anchors focus after its own re-render. Unit tests: empty band, settle-with-remaining-row, more-push/activation. |
| R2-2 | Round-1 a11y fixes unobserved: disclosure `aria-label` and `h2` heading level had no assertions; labels collide when titles repeat (BH#2, VG#1, EC#2) | medium | patch: the label now embeds the stable action id (`Review decision: <title> (<actionId>)`); unit assertions for both labels, the duplicate-title case, and the H2 tag; e2e label assertion. |
| R2-3 | Wrapped 4th group kept 18px left padding and the row's last item lost its flush-right edge (BH#3, EC#3) | low | patch: row-edge padding rules in the 640px container; e2e computed padding assertions alongside the border assertions. |
| R2-4 | `.strip-kpi__num--alert` contrast never rendered/measured (the fixture pinned `conflicting: 0` and the target list lacked the class) (BH#4) | medium | patch: contrast fixture now renders `conflicting: 3`; `alertKpi` target added. |
| R2-5 | Spec triage row 7 quoted the pre-fix assertion; the shipped assertion read a resolved value (BH#5, EC note) | low | patch: row corrected; shipped assertion hardened to `parseFloat(...) || 0` and re-run. |

Follow-ups folded into the same batch (reported, not dropped): silas `FAILED` pure-text split pinned and every chip's split completeness asserted (BH#6, BH#8); per-group/per-KPI tooltip+aria assertions (VG follow-up); baseline scopes now `exit 2` on an unexpected GREEN (`FAILS-BEFORE CLAIM BROKEN` marker, the sibling convention) (BH#7, VG#2); 4-group (CHILDREN) slot geometry parameterized and compared pairwise (BH#10); `board-rail.ts` module docs reconciled with the v7 strip (BH#11); spec head/iteration recorded (BH#12); themed `:focus-visible` ring for the band controls + e2e outline assertion (BH#13); long-label phone leg at 360 (VG#3).

Deferred (recorded in `deferred-work.md`): baseline failure-kind assertion (build/import RED vs behavioral RED) and narrow-width wake-age/deferred boundary legs.

Round-2 resolution: patches landed in `8c7f4ed` (fix batch), `161109c`/`1f8f363` (e2e geometry parameterization + stamped CHILDREN fixture; two failed strip-browser attempts retained as honest history). Re-verification at `1f8f363`: unit GREEN **142** (run 1ef4b1b6 at 8c7f4ed — the suite grew to 142 with the round-2 tests; the earlier `137` note was the round-1 suite size and was corrected here per round-3 VG); strip-browser GREEN 67 (run f7308402); strip-smoke GREEN (run bdea9798; the first attempt run 9e4030da failed with 0 tests started on `http://localhost:8788 is already used` — a port-release race with the preceding run, inspected, no leftover process; one bounded rerun under a fresh request id); strip-themes GREEN (run 73981b71); dashboard-slim-strip-baseline RED (run bfcb4b67, exit 1 under the new guard); strip-browser-baseline RED (run 921acc83); typecheck GREEN (run 1c0468fe); full GREEN (run 153d73ac). Round-3 concluding whole-change review commissioned at `ac4fb4b`; only findings intersecting the delta `ddc42e4..ac4fb4b` could block (others report as follow-ups; the scope note here said `..1f8f363` before the spec-record commit and was corrected per round-3 BH).

Round 3 reviewed `ac4fb4bee251b559d03bc9b6190874bd0bf54361` (blind-hunter 12: 7 delta + 5 follow-ups; edge-case 1 delta; verification-gap 3 delta + 3 other). All delta findings were patch; the untouched-code follow-ups are recorded in `deferred-work.md` (one, the pipeline-board coverage question, is answered by running the existing `pipeline-board-browser` scope at the final head).

| # | Finding (surface) | Verdict | Route / evidence |
|---|---|---|---|
| R3-1 | The band-head fallback was not re-captured: the next snapshot push after the empty-band fallback replaced the focused `h2` and dropped focus out of the band (BH D1, EC-1, VG-1) | medium | patch: `headFocused` capture routes a focused `.board-band__head` through `focusBandFallback()`; the empty-band unit test now renders twice and asserts in-band focus both times. |
| R3-2 | The themed focus ring was asserted only on the disclosure; the Ack/OPEN PR selectors in the same rule were unobserved (BH D2, VG-3) | low | patch: computed `outlineWidth === '3px'` asserted after the restored Ack and OPEN PR focus legs. |
| R3-3 | Wrapped-row flush-right and the in-row 18px spacing were unpinned (BH D3) | low | patch: `wrapped.padRight === '0px'` and `second.padLeft === '18px'` assertions. |
| R3-4 | The 360 long-label leg could pass vacuously (`[].every` true; no visibility check) (BH D4) | low | patch: both long rows asserted visible at 360 (`:visible` count 2 + `details.length === 2` guard). |
| R3-5 | Baseline guards collapsed any nonzero to `exit 1`, losing the runner's real code (BH D5, VG-other) | low | patch: both scopes now `exit "$code"` (unexpected green still `exit 2`), so printed code and `outcome.exitCode` agree. |
| R3-6 | Activating `+N older pending` focused the band top, not the first newly revealed row (BH D6) | low | patch: the click handler captures the first row beyond the window and focuses its disclosure (fallback unchanged); unit test now pins `m-02`. |
| R3-7 | The second CHILDREN state re-verified only one of four numbers before the pairwise geometry; the comment misstated the states (BH D7) | low | patch: all four values asserted after the second push; comment corrected. |
| R3-8 | The round-2 spec record quoted a 137-test unit receipt against `8c7f4ed` while the suite was 142 (VG-other) | low | patch: record corrected; the final-head unit re-run evidences the final count. |

Round-3 follow-ups (untouched code, reported not blocking): panel PR layout is flow-adapted vs the base grid (F1); the CHILDREN group tone falls to neutral `park` (F3); group section names use the tooltip enumeration rather than the visible heading (F4); `geometry()` cannot measure unstamped wake states (F5) — all recorded in `deferred-work.md`. The pipeline-board coverage question (F2) was answered by executing the existing `pipeline-board-browser` scope: it exposed four stale geometry expectations of the old pill rail (a fixed `<140` chrome bound at tablet plus 0.39px sub-pixel viewport-edge rounding), migrated at `065bbf6` to the measured chip-rail bound and a 1px containment tolerance (occlusion remains a strict separate check); the scope is GREEN at `065bbf6` (run 52b744fa).

Round-3 resolution: fixes landed in `b86af16` (code + tests + record) and `065bbf6` (pipeline-board migration). Re-verification at `b86af16`: unit GREEN **142** (run 78da62aa, fresh request 7f5d84f2 — an earlier attempt under request a1eb29db whose run 2ec903fe completed green server-side lost its capture stream during a ~6-minute queue wait (`terminated`, started=false) and is retained as an honest incomplete capture, never cited as PASS); strip-browser GREEN 67 (run 88318fcf); strip-smoke GREEN (run dfd6db5a); strip-themes GREEN (run 2b2501fd); dashboard-slim-strip-baseline RED (run f22a5b17, exit 1); strip-browser-baseline RED (run 465be0f2, exit 1); typecheck GREEN (run 58be2719). Round-4 delta-scoped review commissioned at the post-fix candidate; only findings intersecting the round-3 delta `ac4fb4b..<candidate>` can block (others report as follow-ups).

Round 4 reviewed `560703c5e340d0d813f73254f77623e35230eb23` (blind-hunter 17: 5 delta + 12 follow-ups; edge-case 1 delta; verification-gap 0 new delta + 3 carried). The five delta findings were fixed in `1a3aabd37bbaa8745d8dba4e411c8ed533d76965`:

| # | Finding (surface) | Verdict | Route / evidence |
|---|---|---|---|
| R4-1 | The migrated sticky bound was one-sided: a nav overlapping the strip (under-measured chrome) passed (BH A1, EC) | medium | patch: the bound is now `railBottom - 1 <= nav.y <= railBottom + 1` (both directions). |
| R4-2 | The 1px containment tolerance was applied to the horizontal axes without justification (BH A2) | low | patch: tolerance confined to the vertical scroll axis; horizontal containment exact. |
| R4-3 | `exit "$code"` collides with the marker's `exit 2` space without the kind assertion (BH A3) | low | patch: exit semantics documented beside the scopes (marker line identifies a broken claim; tooling failures land in the exit-1 bucket); the kind assertion stays deferred. |
| R4-4 | The head-focused → rows-return transition was unpinned (BH A4) | low | patch: the empty-band focus test now renders a third time with rows and asserts focus lands on the live control. |
| R4-5 | Focus-ring assertions pinned only `outline-width` (BH A5) | low | patch: `ringOf` now asserts width, colour (`--work`) and offset in `1a3aabd`; the fourth property (`outline-style`) was added by R5-2 in `e98a6d1` (round-6 BH D-1 correction). |

Round-5 review at `1a3aabd` (blind-hunter 15: 3 delta + 12 follow-ups; edge-case 0; verification-gap 5: 1 delta + 4 follow-ups): the delta items (R5-1 pipeline-board runner evidence; R5-2 `outline-style`; R5-3 the comment's `tsc` example) were settled in `e98a6d18aa5b7cdf3d5334f78eacb315c5154d4d` (style pinned, comment corrected) and by the gate receipts below. Dispatch-transcription defect recorded: the round-5 briefs carried a hand-composed full SHA `1a3aabd6ac…` that does not exist; both reviewers resolved the unique short hash `1a3aabd` to the correct commit `1a3aabd37bb…` and reviewed it. Lesson: full SHAs are always copied from `git rev-parse`, never composed.

Exact-head receipts at `1a3aabd` (all through the authenticated scheduler + shipped capture helper; complete sinks + receipts under `_bmad-output/verify-captures/current-main-20261007/`): unit GREEN 142 (run 27e0d0d8); strip-browser GREEN 67 (run 160fa00e); strip-smoke GREEN (run 168b978f); strip-themes GREEN (run 76abf9f9); dashboard-slim-strip-baseline RED exit 1 (run 058ac42e); strip-browser-baseline RED exit 1 (run 17c856ff); typecheck GREEN (run ad1f40e6); pipeline-board-browser GREEN (run a36b4903); full GREEN (run 8b1ba722; backend 2291, heavy 925, web 542 passed). Round-6 delta review commissioned at `50f5f9aae20bbd1ea7b52a5abfba7abbe3741d87`; only findings intersecting `1a3aabd..50f5f9a` could block (others report as follow-ups; the whole-change coverage for convergence sits in this concluding round). Round-6 findings were record/comment-only (D-1 attribution wording, D-2 placeholders, D-3 round-count wording, D-4 comment enumeration), fixed in the final record commit; the remaining round-6 follow-ups are recorded below and in `deferred-work.md`.

Exact-final-head receipts at `50f5f9a` (after the round-5 fixes; all through the authenticated scheduler + shipped capture helper): unit GREEN 142 (run ac784b1b; an earlier attempt under request 16eca535 whose run cad0bf07 completed green server-side lost its capture stream to a queue-wait termination and is retained as an honest incomplete capture, never cited); strip-browser GREEN 67 (run 0b3da28a); strip-smoke GREEN (run 01dc594e); strip-themes GREEN (run b1de7e6e); dashboard-slim-strip-baseline RED exit 1 (run cb7d79d3); strip-browser-baseline RED exit 1 (run ecb81559); typecheck GREEN (run 6947d49a); pipeline-board-browser GREEN (run c8eaa1bb); full GREEN (run a66c0d5b; backend 2291, heavy 925, web 542 passed).

Round-6 follow-ups (reported, not blocking; record only unless noted): the band-head fallback anchor has no themed focus ring (F-1); display receipts fire for collapsed rows whose full detail is hidden (F-2, doctrine note); the smoke KPI walk omits `jobs.binned` (F-3); the deploy `unknown` split branch is unexercised (F-4); non-alert pair tones are unpinned (F-5); `::before` KPI separators are exposed to AT (F-6); the capture suite overwrites fixed ignored paths without run-scoping (F-7); re-pairing reuses actionId/region state held from the previous connection (`bindClient` does not clear the band maps — edge-case follow-up); the spec Tasks section still says "union 9 scopes + directive-recovery scope" where seven were added (edge-case claim follow-up, wording now consistent in Verification). The carried records (CHILDREN tone, group aria-label, unstamped geometry, narrow-width age/deferred legs, panel layout, baseline failure-kind) remain in `deferred-work.md`.

### Round 10 — concluding whole-change pass after the scope correction

Reviewed `e740d96` (blind-hunter 10, edge-case 5, verification-gap 2 + 3 observations). All triaged:

| # | Finding | Verdict | Disposition |
|---|---|---|---|
| BH-F1 | No exact-head verification receipt; "byte-identical" transitivity claim wrong for unit scope | high | **Fixed**: exact-head receipts recorded below; all 11 scopes ran at `e740d96` |
| BH-F2 | `bindClient` doesn't clear band maps on re-pair | follow-up | carried (deferred-work.md) |
| BH-F3 | Baselines can't prove RED kind (missing failure-kind assertion) | follow-up | carried (deferred-work.md) |
| BH-F4 | `strip-browser`/baseline skip RPC-patch prerequisite | false | the RPC patch targets vitest birpc timeouts; Playwright e2e scopes don't run vitest — the prefix in sibling browser scopes is copy-drift, not a missing prerequisite |
| BH-F5 | Wake-age boundaries at 1440 only | follow-up | carried (deferred-work.md) |
| BH-F6 | Unstamped wake states have zero geometry coverage | follow-up | carried (deferred-work.md) |
| BH-F7 | Group accessible names are tooltip enumerations | follow-up | carried (deferred-work.md) |
| BH-F8a | `::before` separators AT-audible | follow-up | carried (deferred-work.md) |
| BH-F8b | Wrapped-line leading dot at phone widths (new aspect of F8a) | follow-up | carried with F8a |
| BH-F9 | Ack-disclose grid auto-placement fragility | follow-up | recorded |
| BH-F10 | `ownerFocusKey` document-scoped without surface check | follow-up | recorded |
| EC-1 | Lesson-proposal GET/POST lacks timeout (absorbed main code) | follow-up | main's board-client.ts; not SLIM scope |
| EC-2 | POST error-body read can stall (absorbed main code) | follow-up | main's board-client.ts; not SLIM scope |
| EC-3 | `railChips` and `sectionsFor` use different `Date.now()` samples (absorbed main code) | follow-up | main's board-rail.ts; not SLIM scope |
| EC-4 | `bucketSnapshot` dead export after main's refactor (absorbed main code, deletion) | follow-up | main's board-bands.ts; not SLIM scope |
| EC-5 | Spec scope-union arithmetic: 7 vs 9+1 | record | corrected in this commit |
| VG-1 | Unit baseline fail-before record stale at the final head (fold changed overlay bytes; failure-kind composition mixed) | medium | baselines re-run at `e740d96` (runs `79200bd6`, `5a97c980`) and composition disclosed in the handoff: 23 assertion-level slim feature-absence failures + absorbed-main import errors (expected at the overlay boundary); failure-kind assertion remains deferred |
| VG-2 | Smoke wake content presence-only at the mock boundary | follow-up | recorded |

Exact-head receipts at `e740d96` (all through the authenticated scheduler + shipped capture helper; complete sinks under `_bmad-output/verify-captures/current-main-20261007/`):
- `dashboard-slim-strip-unit` (board.test.ts, board-rail.test.ts, owner-band.test.ts, slim-strip.baseline.test.ts) GREEN 142/142 (run `db137674-9456-45d6-8533-2affb477d1dd`)
- `strip-browser` GREEN 67/67 (run `f0ef8869-e700-4382-a6d3-d0056cba3f47`) — screenshots inspected
- `strip-smoke` GREEN (run `36b79ea1-69d4-4c25-b848-069cf7d99f59`)
- `strip-themes` GREEN (run `a9ac6aae-7323-4c91-91cd-d66287a9ea7f`)
- `dashboard-slim-strip-baseline` RED exit 1 (run `79200bd6-5d8b-4fe6-ac8d-208dbe4bf8bd`)
- `strip-browser-baseline` RED exit 1 (run `5a97c980-3434-4475-8918-3c034f4f3ac3`)
- `typecheck` GREEN (run `053e118d-07db-480b-9f0f-c91fc17001ca`)
- `pipeline-board-browser` GREEN 15/15 STRICT (run `1546061b-0412-4cbd-be25-49d0f7cf5f8c`)
- `megaminions-browser` GREEN (run `f1482ba1-0d82-4fe2-a56e-7d8738c03d31`)
- `full` GREEN (run `a52e12a8-beca-4574-9b25-8865aa9969c4`)

### Owner scope restoration (amendment #7, 2026-10-09) — provenance inventory and correction

Amendment #7 (owner chat frames 230126/230296/230406) withdrew the chief-added
later-main compatibility requirement (former amendments #3/#4, now NOT
EFFECTIVE): "current main" in the base brief means the recorded creation base
`49b558f`. No newer-main feature is SLIM acceptance. The FOR-YOU band itself
predates the base (merged `1d349af`), so the approved scope is the base board
plus the approved slim strip/compact band.

**Removed as unsupported absorbed-later-main additions (provenance: present
in `49b558f..main`, absent from the approved feature; the proposal machinery
was additionally ported under withdrawn amendment #3):**

- Lesson-proposal frontend machinery (chief-added; backend dependency made it
  a known-dark control): `board-protocol.ts` proposal types/validators/kinds,
  `board-client.ts` getLessonProposal/decideLessonProposal, `owner-band.ts`
  OwnerProposalRow/LESSONS_PROPOSAL_CONSEQUENCE/proposal branch, `board.ts`
  proposalStates/ownerProposalRow/decide flow/ownerProposalPointer/review
  renderers/error describers/owner-focus helper pair, proposal CSS blocks,
  `web/e2e/lesson-proposal.spec.ts`, lesson-proposal browser project+scope,
  and every proposal unit test. R3 findings 1/2/4 are RETIRED with this
  provenance (removed out-of-scope path; not claims of fixing the old path).
  Retained in-scope residue of R3-3: every POST (base ack surface) rides a
  bounded `AbortSignal.timeout`, pinned by a new discriminating unit test.
- Megaminion nested-row hierarchy (surfacedParents, familyChip/familyRows,
  nested jobRow recursion, `parentJobId`, 3-arg boardKpis topLevel counting,
  `board-family.ts`, `board-vocabulary` megaminion words, family/child CSS,
  `web/e2e/megaminions.spec.ts`, megaminions browser project+scope,
  megaminion unit tests). Base-supported behavior KEPT: children counts
  (CHILDREN optional/unknown strip group, Issue #161) and the base family
  counters on the job subline; `boardKpis` back to the base two-argument
  derivation ("SAME boardKpis derivation").
- Wholesale ==main files restored to base blobs (SLIM needs nothing they
  carried): board-sections.ts, board-kpi.ts, board-vocabulary.ts,
  board-bands.ts, web/src/main.ts, web/mock/server.ts, board-protocol.ts
  (now byte-identical to base), board-protocol.test.ts, board-kpi.test.ts,
  board-vocabulary.test.ts, board-client.test.ts recomposed (base + the
  lane's R7-R10 hardening tests − proposal tests + the new POST-deadline
  pin), absorbed `directive-recovery` verify scope removed.
- R3-5 baseline classification RESOLVED: dedicated fail-before instrument
  `web/src/ui/slim-strip.baseline.test.ts` (imports only base-existing
  symbols; asserts slim surfaces after a setup proof) +
  `tools/classify-baseline.mjs`; both baseline scopes now distinguish
  1 = RED CLASSIFIED (assertion-named feature absence, setup clean),
  2 = FAILS-BEFORE BROKEN, 3 = SETUP/COLLECTION FAILURE (never readable as
  behavioral evidence). owner-band.test.ts is deliberately not overlaid on
  base (ackNextStep is a slim-added symbol; that import error would be a
  setup failure); its head coverage stays in the unit scope.

**Kept as approved/base-supported:** the six-section board, six-section order
and previews, Binned/CHILDREN semantics (base forms), independent GRU/SILAS
wakes with deferred tallies, compact initially-collapsed FOR YOU with ack +
OPEN PR controls, reveal-only disclosure and stable focus, R7-R10 client
hardening (deadline, trailing chain, refused-pairing stop — required by the
approved "HTTP ambiguity reconciles to the authoritative snapshot"), the R2
error-contrast fix (retained band error surface), `.num` scoping, wake chip
honesty, strip styles.

### R3 native Perkins findings (INCOMPLETE at `2061e59`, triaged and fixed)

| # | Finding | Severity | Verdict | Fix |
|---|---|---|---|---|
| R3-1 | Lesson-proposal backend dependency: `GET /api/lessons/proposal` routes absent from frozen backend | blocker | **Dependency-boundary escalation** — the proposal controls came from current main; the backend routes are out of SLIM scope. Frontend controls preserved (not deleted); the backend routes require owner/ops-authorized integration. Synthetic interception tests cover the frontend rendering. |
| R3-2 | Keyboard focus falls to body when Accept/Reject disables its own focused control | blocker | **Fixed** at `1c8753c`: after `rerenderOwner()` during a decision, focus moves to the proposal disclosure (always present, always enabled); restored to the enabled button on completion. |
| R3-3 | Proposal GET/POST/body-read lack a deadline | warning | **Fixed** at `1c8753c`: `AbortSignal.timeout(SNAPSHOT_DEADLINE_MS)` bounds proposal GET and all POST body reads; timeout is unconfirmed (never auto-replayed); authoritative snapshot reconciles. |
| R3-4 | Proposal review headings/meta lack overflow-wrap | warning | **Fixed** at `1c8753c`: `overflow-wrap: anywhere` on `.board-owner__review-list` (inherited by all children) and `.board-owner__review-heading`. |
| R3-5 | Baseline RED kind not mechanically classified | warning | Confirmed; recorded as deferred (deferred-work.md: failure-kind assertion). |

### R3-fix exact-head receipts at `1c8753c`

| Scope | Run | Outcome |
|---|---|---|
| `lesson-proposal-browser` | `eedf4c08` | GREEN |
| `dashboard-slim-strip-unit` (board.test.ts, board-rail.test.ts, owner-band.test.ts, slim-strip.baseline.test.ts) | `043cf1cb` | GREEN 142/142 |
| `strip-browser` | `61201a9d` | GREEN 67/67 |
| `strip-smoke` | `49263282` | GREEN |
| `strip-themes` | `b5afe48f` | GREEN |
| `typecheck` | `3a76670c` | GREEN |
| `pipeline-board-browser` | `878a9c24` | GREEN 15/15 STRICT |
| `megaminions-browser` | `c83e144f` | GREEN |
| `full` | `f91bca9d` | GREEN |

### Final frozen candidate

`7352d73` (product bytes at `b565a32`; the last commit only widens the e2e
contrast targets and re-proves them on a clean tree). Base
`49b558f243c7bacbfb46c7bc04f749bf131cefea`. All declared scopes green except
the two baselines, which return the classified RED (exit 1) by design:
`dashboard-slim-strip-unit`, `typecheck`, `strip-browser`, `strip-smoke`,
`pipeline-board-browser`, `strip-themes`, `full`; baselines
`dashboard-slim-strip-baseline` (134 collected, 0 load errors, 20 identified
assertion failures, 12 non-assertion failures explicitly NOT claimed) and
`strip-browser-baseline` (67 unexpected, every failure naming a slim
surface). Inspected current-byte captures: 1440/768 light, 360/1440 dark.

### v7 workflow review rounds (owner amendment #7 scope-restoration candidate)

Three workflow-owned, parent-linked, read-only review rounds were commissioned
through `POST /api/dispatch` (`deliverable: review`, `parent_job_id`
`dashboard-slim-strip-current-main-20261007`, `target_ref` PR #256, the pinned
rubric artifact under `captures/gru-slim-review-rubric-20261009/` with its
sha256 named in each tracked brief):

| Round | Candidate | Lenses / outcome | Disposition |
|---|---|---|---|
| 1 | `76912bd9` | blind-hunter 15 findings; edge-case 1 finding; verification-gap 2 findings | all findings triaged; fixed in `24a8c55` (lint + classifier test + bounded-POST proof + project split + docs) |
| 2 | `4e36d73` | blind-hunter 12; verification-gap 0 gaps + 2 observations; edge-case swept without a report (not coverage) | fixed in `24a8ad5` (body-race deadline, `.num[hidden]` scope, classifier timedOut/empty-instrument/no-instrument branches + 3 pinned tests, band-head focus ring, CHILDREN identity + 768 container-transition coverage, widened contrast targets, acceptance-record sync) |
| 3 | `24a8ad5` | concluding whole-change pass (three lenses) | this round's findings are triaged against the convergence rule |

A restart-disposed round-0 blind-hunter session left partial investigation
leads (preserved); the substantive ones (dead `clientGeneration`/`jobSignals`,
dead `BoardApiError` import, dead `postApiWithStatus` status, family-map
drift) were assessed by the parent and fixed as ordinary engineering — they
are leads, not a delivered report. A round-0 edge-case report was dismissed
as "review not performed" (its brief referenced a rubric path that did not
exist in the reviewer's tree); its replacement is the round-1 edge-case
report above.

### Post-R2-fix exact-head receipts at `4ab3e7b`

| Scope | Run | Outcome |
|---|---|---|
| `dashboard-slim-strip-unit` (board.test.ts, board-rail.test.ts, owner-band.test.ts, slim-strip.baseline.test.ts) | `c48c1937` | GREEN 142/142 |
| `strip-browser` | `f0ef8869` | GREEN 67/67 |
| `strip-smoke` | `47a12ba7` | GREEN |
| `strip-themes` | `78ee53f2` | GREEN |
| `dashboard-slim-strip-baseline` | `79200bd6` | RED exit 1 (expected) |
| `strip-browser-baseline` | `5a97c980` | RED exit 1 (expected) |
| `typecheck` | `cee69050` | GREEN |
| `pipeline-board-browser` | `d40d531c` | GREEN 15/15 STRICT |
| `megaminions-browser` | `dcb256a0` | GREEN |
| `lesson-proposal-browser` | `d4043d62` | GREEN at `4ba44f5` |
| `full` | `96b177a7` | GREEN |

Exact-head CI: **structurally blocked** (PR conflict) — GitHub suppresses `pull_request` runs for conflicted PRs (SLIM replaces code main also carries in `board.ts`/`components.css`). Recorded as the owner-held merge-time resolution. Native Perkins: queued (`request_seq 57658`, route `queued`); arms after delivery.


### Round 7 (corrective whole-change pass, owner A / j-1307) — findings and resolution

Reviewed `57b354e2a007c674d0884f638f60bf0c0a4936a2`. 12 findings (6 delta + 6 follow-ups) + 8 carried. All 6 delta findings were patched in `2a37ffb`:

| # | Finding | Verdict | Fix |
|---|---|---|---|
| R7-1 | Spec line 220 said "deterministic centering" but helper does minimal+bounded corrections | record | corrected wording |
| R7-2 | Spec line 185 attributed all 4 b86af16 failures to scroll slivers; 1 was the stale `<140` bound | record | corrected attribution |
| R7-3 | Truncated recovered hash/run id | record | full values pasted |
| R7-4 | Helper occlusion correction only scrolled one direction (top-anchor assumption) | low | symmetric escape (score both directions, take feasible smaller move) |
| R7-5 | `hit` single center-point sample boundary (pre-existing, not delta regression) | follow-up | documented; no oracle change (matches base 49b558f) |
| R7-6 | Spec review record not extended for corrective cycle; stale iteration | record | extended + bumped |

Round-8 delta re-verification at `2a37ffb`: blind-hunter 11 findings (4 delta + 7 follow-ups/carried), edge-case 3 delta + 1 follow-up (all record/code fixes), verification-gap 4 (2 delta + 2 follow-ups). All delta findings were fixed in the conflict-resolution commit `b3e902e` and its follow-ups; the two scope-command RPC-patch prerequisites and the synthetic below-occluder leg are deferred (deferred-work.md). Round 9 is the concluding whole-change pass.



## Protected corrective follow-up (owner A, j-1307) — contract acknowledgment and corrections

### Effective contract acknowledgment
Read via `GET /api/dispatch/jobs/dashboard-slim-strip-current-main-20261007/contract`: **version 6**, `contract_sha256` `d4a8565c47d2480da6f8d3deaf5acf237a018a3dd2f0d50e627d92a80aa81511`, `base_sha256` `28e68b34af052c8cd17639380b39dde256fdfdc83ea987b3c58250a0235d4545`; amendments `f63d0c6c-9021-4d7a-8932-eba380bc7342` (capture-contract enforcement, j-1288), `6c8e06e0-470f-4a8b-ada0-d423f76cd084` (pipeline verification integrity / review-pin clarification, j-1295–j-1296), `b63275b8-…` (same-PR conflict-resolution continuation, j-1389/j-1355/j-1362/j-1387), `37536656-…` (v4 scope enforcement), `6ddf96dd-…` (v5 same-worker corrective continuation), and `a275e7c3-…` (v6, current), all EFFECTIVE. The lane explicitly acknowledges and applies both: missing captures are recovered by the SAME request/run identity through the supported status/output surfaces — never by minting a fresh request or a second producer for logs, never fabricating a helper EOF; strict full-viewport containment stands with the measured nav/rail invariant retained; full SHAs come from Git/provider only; the R5 pin discrepancy is preserved as recorded rather than falsified.

### Strict viewport containment restored (amendment #2)
`web/e2e/pipeline-board.spec.ts` `hitTarget.inViewport` is restored to the original strict bounds (`left >= 0 && top >= 0 && right <= innerWidth && bottom <= innerHeight`) — no negative coordinates, no coordinates past the viewport. The observed b86af16 failures (request `86fb1c0f-3fc1-4565-b83f-05111dfbcd13` / run `f6998e40-e371-405f-95a6-7439b80462f1`: exit 1, 4 failed / 11 passed) were one stale fixed bound plus three sub-pixel scroll slivers: the tablet-768 sticky test failed on the old `nav.y < 140` constant (observed 225; replaced by the measured two-sided bound at `065bbf6`), while the desktop-1440 and tablet-768 light/dark viewport proofs failed strict containment by a 0<1px bottom sliver from minimal scrolling (`scrollIntoViewIfNeeded` / focus scrolling). The interaction path is repaired deterministically: `scrollFullyIntoView` performs the browser's minimal placement and then iteratively corrects residual edge overflow and sticky-chrome occlusion with explicit, bounded scrolls (the scroll a real user performs) before the strict probe; the two-sided measured nav/rail alignment invariant is retained; the independent strict hit/occlusion check is unchanged. Historical results are preserved and never relabelled: `86fb1c0f`/`f6998e40` exit 1, 4 failed at `b86af16`; request `2d59bd27-7a14-4278-945b-bc4018580c75` / run `52b744fa-0848-4d4e-8715-0e8d505098a4` exit 0, 15 passed at `065bbf6` under its changed (relaxed) test bytes — the latter is not strict-oracle proof.

### Capture provenance reconciliation (amendment #1)
- `b86af16`: original request `a1eb29db-cddb-4d17-b962-9d68bfee5232` / run `2ec903fe-35cc-469b-8b72-c73e60d7b16d` completed exit 0 with 142 tests (event 51092) while its original client capture stayed UNKNOWN/terminated; all 443 original output bytes were recovered, sha256 `31f1654c01d077f9d49e5f142cc705c0114828c9ed7f427124afcbd3251e136c`. Distinct repeat producer request `7f5d84f2-2003-4be3-969c-76a9006ffc60` / run `78da62aa-4213-484f-bbcd-560a4adad2a4` executed the same head/scope/command for capture replacement; it does not repair the first receipt and proves no newer head.
- `50f5f9a`: original request `16eca535-b015-4066-89aa-f04476d8491b` / run `cad0bf07-31e9-4d44-aac9-c75775b23e74` clean producer (exit 0, 142 tests, 443 bytes, sha256 `fbf7c280377d94d818f8d9f19cbf4451419c66bbc7544ba5792e3769aed0437a`) with an UNKNOWN 99-byte client capture (sha256 `5822e246…`); distinct repeat producer request `e05fe226-d3f2-4800-b9e0-bbf21c163ef0` / run `ac784b1b-ba0f-422c-9639-8c4c871037af` (complete capture; producer output 442 bytes, sha256 `069c12ac6c661efde01641221e87e2b5d6f187e42aa325c566022fafd98cd4a6`) is recorded as a distinct producer, never as a recovered first receipt.
- `2fed6a5`: original request `638d125c-8933-4fab-9217-08bb6039bf3a` client capture UNKNOWN (99 bytes, sha256 `b3b63c57…`); its legitimate producer run `50ea0bb8-6258-47e6-957a-157d83fc7658` was recovered through the supported status surface (exit 0, 142 tests, 442 bytes, sha256 `eba106798dde1503c9ebcaeb2db89dbdfdd18baba9a5558304e975e95d601658`); the later same-head producer request `15b46607-91e2-457a-b08d-23a1754137d5` / run `6b29445e-6569-465f-b1ae-f665d7cfd059` is distinct and separately recorded.
- Disclosed deviation: the repeat producers (`78da62aa`, `ac784b1b`, `6b29445e`) were launched in the earlier cycle to replace terminated client captures; under amendment #1 that is not repair of the original receipt, and every presence/status distinction above is retained. This correction cycle recovered the outstanding `2fed6a5` UNKNOWN by same identity (no log-only rerun) and minted no replacement producer for missing captures.

### Conflict resolution (owner directive slim-conflict-resolution-continuation-20261008-v1, j-1355/j-1362/j-1387)
PR #256 was `mergeable_state: dirty` against main `4cc8a83d…` (then `72c73c10…`): the merge-tree probe conflicted in `web/src/styles/components.css` and `web/src/ui/board.ts`. GitHub suppresses `pull_request` workflow runs for conflicted PRs, so correction heads had **no exact-head CI**. The owner directed (j-1355) and the chief authorized (j-1362/j-1387, amendment b63275b8 / contract v3) the resolution via targeted semantic source edits in the existing lane — normal descendant source commits, no merge/rebase/base-switch. The resolution commit `b3e902e` reconciled all 9 overlap files (2 manual conflicts + 7 auto-merges + main's newer code for local self-consistency); PR #256 was registered via `/api/dispatch/pr`; exact-head CI and the native round for the resolution head are recorded in the ignored handoff and the completion report.

### R2 native review findings (INCOMPLETE at `a0ed034`, triaged)

| # | Finding | Verdict | Disposition |
|---|---|---|---|
| R2-1 | Remaining unrelated backend/schema import (`src/ledger/db.ts` migration 23) | addressed | already reverted at `e740d96` — `git diff 49b558f..e740d96 -- src/` is empty |
| R2-2 | Proposal error text fails light-theme contrast (1.57:1 vs required 4.5:1) | high | **Fixed** at `4ab3e7b`: `.board-owner__error` uses `color: var(--ink)` (12.26:1 light / high dark) + `border-left: 3px solid var(--alert)` for visual alert semantics |

### Correction-cycle receipts at `cb6adbc` (strict oracle; complete captures)
- `dashboard-slim-strip-unit` (board.test.ts, board-rail.test.ts, owner-band.test.ts, slim-strip.baseline.test.ts) GREEN 142/142 (run `cd27a125-b611-423a-b13d-449fea7004ba`, 11 frames).
- `strip-browser` GREEN 67/67 (run `f83ab022-8c69-4783-bc4e-a342bd1065f2`, 85 frames) — the eight final-head screenshots at 1440/1200/768/360 × light/dark were re-inspected at this head.
- `strip-smoke` GREEN (run `a9a0eadb-7fc4-4b73-bbd9-7a86077e581f`, 56 frames).
- `strip-themes` GREEN (run `365626c4-5c09-4f83-b22e-0d04f00003dc`, 16 frames).
- `dashboard-slim-strip-baseline` RED exit 1 (run `52c1a9b5-a7dc-4d32-aa6f-f580d252a526`, 130 frames; expected feature absence).
- `strip-browser-baseline` RED exit 1 (run `94ff1b92-0cf8-4396-8308-76eb0a6658c6`, 126 frames).
- `typecheck` GREEN (run `0a0ad71b-bb58-4b03-a530-89da49378e91`, 4 frames).
- `pipeline-board-browser` GREEN 15/15 under the STRICT containment oracle (run `7ec5f9ca-3f87-46ad-ad71-635efa2edd76`, 37 frames).
- `full` GREEN (run `e0e346f6-f537-424c-ba02-bc42a7073cb3`, 484 frames).
- PR #256 registered on the job via `POST /api/dispatch/pr` (200; job status `in-review`).
- Post-conflict-resolution corrections: `2a37ffb` (round-7 fixes), `4ba44f5` (lesson-proposal e2e chrome-height fix). Re-verification: `pipeline-board-browser` GREEN 15/15 strict at `2a37ffb` (run `7b2162a7-ee4a-4e8a-a89b-d1ae3a771bda`, request `7f45a99d-54eb-45e2-84ce-846391190913`); `lesson-proposal-browser` GREEN at `4ba44f5` (run `d4043d62-8826-4f64-91e6-87fd02153d37`). All other scopes' consumed test blobs are byte-identical from `cb6adbc` onward (verified by blob hash).

## Design Notes

- Numeric slots: number part only carries `.num` (`font-variant-numeric: tabular-nums; display:inline-block; text-align:right`), scoped to `#chip-rail`/`#board-owner` so unrelated surfaces keep app defaults (probe-tested). The e2e suite measures geometry; CSS only declares.
- Strip DOM: `.strip-pair[data-chip]` keeps each chip's identity (deploy/reviews/silas/alerts/verify/cure) and tone class; `.strip-group` keeps group aria-labels; every count keeps `data-kpi`. A present CHILDREN group renders as an additional group (wraps to a second row under the 3-column container grid) — no fact dropped.
- Region ids: `fy-detail-<n>` allocated per action id; controls carry `data-action-id` + `data-control` (disclose|ack|open); focus restore matches both.
- Baselines: unit baseline overlays final test files on a `git archive` of `49b558f` (node_modules symlinked); browser baseline overlays final strip spec + playwright config. Expected RED is feature-absence; a collection/setup error is not acceptable fail-before evidence.
- Provenance recorded per file as source blob OID at `4de42d9`; the ignored `preservation-manifest-*.json` holds original hashes (rechecked at handback).

## Verification

**Commands (through authenticated `/api/verify` + shipped capture helper; the union this lane added is seven scopes: `strip-browser`, `strip-smoke`, `strip-themes`, `strip-themes-update`, `dashboard-slim-strip-unit` (board.test.ts, board-rail.test.ts, owner-band.test.ts, slim-strip.baseline.test.ts), `dashboard-slim-strip-baseline`, `strip-browser-baseline` — the latter two pinned to base `49b558f…` and expected RED):**
- `dashboard-slim-strip-unit` (board.test.ts, board-rail.test.ts, owner-band.test.ts, slim-strip.baseline.test.ts) — `cd web && node ../node_modules/vitest/vitest.mjs run src/ui/board.test.ts src/lib/board-rail.test.ts src/lib/owner-band.test.ts`; expected GREEN.
- `strip-browser` — `(cd web && npm run e2e -- --project=strip e2e/dashboard-strip.spec.ts)`; expected GREEN; retain + inspect 1440/1200/768/360 light/dark captures.
- `strip-smoke` — `(mock smoke suite)`; expected GREEN (migrated main assertions).
- `strip-themes` — `(mock + real "dark toggle persists" goldens, no update flag)`; expected GREEN; `strip-themes-update` is the deliberate, inspected regeneration scope (never cited as acceptance).
- `pipeline-board-browser` — the existing main scope; expected GREEN. Its oracle is STRICT full-viewport containment plus the independent strict hit/occlusion check (amendment #2); the measured two-sided nav/rail alignment invariant replaces the stale fixed bound; the interaction path uses deterministic reachability placement (`scrollFullyIntoView`: browser minimal placement plus bounded edge/occlusion corrections), never an off-viewport admission.
- `dashboard-slim-strip-baseline` / `strip-browser-baseline` — final test bytes over `git archive 49b558f…`; expected RED (feature absence), exits unmasked.
- `full` (`npm test`) and `typecheck` at the same final head.
- Independent whole-change review via `POST /api/dispatch` with `"deliverable": "review"` on the exact head (seven rounds through the owner-directed corrective cycle: 1–2 whole-change, 3–6 delta-scoped, 7 the corrective whole-change pass; round 8 delta-scoped re-verification at the post-fix head); then exact-head CI and native Perkins READY on the exact final head.

**Manual checks:** personally inspect screenshots at 1440/1200/768/360 both themes; verify no overflow masking.

### Round 11 — integrated-main reports on candidate `74fefde2e418a6dd1899cfe4203b43e1ef53fb41`

The active contract is v11, SHA-256 `35f5047169f4a844cc978c44c06f8603dd2295d849a76836e40a4f2644861e63`. The execution/fail-before base remains `49b558f243c7bacbfb46c7bc04f749bf131cefea`; the integrated main input is `79c032e5a5a1ba7607b5daf6cafa36c2aecbdd37`; PR #256 remains the existing ordinary non-draft PR. The main integration is preservation context, not new product acceptance.

Three fresh tracked reviewers inspected the immutable range `79c032e5a5a1ba7607b5daf6cafa36c2aecbdd37..74fefde2e418a6dd1899cfe4203b43e1ef53fb41`. Complete report bytes matched commissioner custody entry `80dadba8` at `2026-10-11T18:18:09.971Z`: blind (2066 bytes, SHA-256 `d3494b1fd2d7de27ea78c3eb3a0f6c1a3de5572476d81d2ff70d9083dba054d7`), edge (1162 bytes, `315819b9f445c8666cdbb87dd1a782339a0ef258a334eee6fe653cc9699783c9`), verification-gap (1288 bytes, `6c196ff3540f89dfb0d2cf399b7c533931a325b4244566c62b2f27fc19906beb`). Report custody was settled separately from these code dispositions.

| Finding | Verdict | Evidence and disposition |
|---|---|---|
| BH-01 — notification-bell proposal pointer auto-placement loses the main panel's flow | medium | The SLIM grid row gives the pointer no title/meta/action areas; main's panel presentation is flex-wrapped. Restored the panel class and right-aligned its navigation button; added a synthetic desktop layout assertion in `lesson-proposal-browser`. |
| BH-02 — expanding older pending does not focus the newly revealed proposal | medium | `refocusAction(actionId, 'disclose')` cannot find the proposal summary without action/control identity. Registered that summary as the row's `disclose` control and added a unit test proving focus moves to it without fetching or deciding. |
| BH-03 — tracked POST HTTP 401 races into status-0 timeout | medium | The candidate added a bounded POST race; the 401 refusal stops the client and aborts that same controller, so the competing abort promise reported `status: 0`. The abort result now retains a received 401, with a regression test using a stalled error body. |
| BH-04 — owner disclosure/region state survives re-pair when an action id is reused | follow-up (carried) | Carried from the existing Round-6/Round-10 row and `deferred-work.md`; the same code and claim remain. Per the carried-finding rule, this row was not re-verified, patched, or newly deferred. |
| EC-01 — impossible calendar wake timestamp displays a plausible age | medium | The snapshot validator accepts any string timestamp and `Date.parse` normalizes `2026-02-30`; the strip can therefore show a false age. Added calendar-day validation and a view test that confirms the snapshot remains accepted while the age reads unknown. |
| EC-02 — focus fallback can select a disabled decision button | medium | When the focused row disappears, the prior `[data-action-id]` fallback can choose a disabled Accept button and leave focus on `<body>`. Fallback now filters disabled controls; a unit test covers a removed focused row while the proposal decision remains in flight. |
| EC-03 — unbroken proposal detail can overflow the owner band | medium | Proposal details render in generic `.board-owner__meta`; the SLIM CSS no longer supplied the generic wrapping rule. Restored `min-width: 0`/`overflow-wrap: anywhere` and added long-detail phone/desktop assertions. |
| VG-01 — browser fail-before can classify a render/setup failure as feature-absence RED | high | The harness proved only the board shell and the classifier matched titles as well as failure messages. Added an independent rendered-section check, page-error detection, message-only classification, and classifier tests that exclude unrelated companion-suite assertions from the unit-baseline claim. |

This log records the findings, evidence, and patch routes. Exact-head scheduler receipts and final CI/native-review state are recorded separately; no result is inferred from the review reports themselves.

### Round 11 proposal-browser test correction at `ccef66c5`

The exact-head `lesson-proposal-browser` run `c0de034a-8376-42b8-a11c-e3aa7b60b65e` failed 4/4: the three phone hit-target checks sampled the intentionally open Gru chat sheet over the board row, and the desktop pointer test compared `getComputedStyle().marginLeft` to the authored `auto` token even though Chromium returns the used pixel value. Its complete capture is retained in bundle `r11-lesson-proposal-browser-failed-ccef66c5-20261011T203232Z`. The first post-correction run `9755745a-a300-43f8-b7da-9d805fbf0d27` at `85137025` passed the desktop check but failed all three phone hit-target checks even after closing the chat sheet; its result is retained in bundle `r11-lesson-proposal-browser-failed-85137025-20261011T203849Z`. The test now centers each action in the viewport before the strict containment/hit test rather than relying on the browser's minimal nearest placement; the pointer check still measures resulting right-edge alignment. The exact-head `f09ae2c9` run `660f562d-0a3c-4061-9367-297ae730355f` still failed all three phone hit-target checks; its complete capture is retained in bundle `r11-lesson-proposal-browser-failed-f09ae2c9-20261011T204155Z`, and the test reports the topmost element in any failure. The exact-head `79b86207` run `7b3339d2-63fa-41a2-a826-45004e7707b1` identified `strip-kpi__k` at 360px and `#board-nav` at 375/390px as the topmost elements over the controls; its complete capture is retained in bundle `r11-lesson-proposal-browser-failed-79b86207-20261011T204447Z`. The test now uses a bounded scroll correction to clear sticky chrome while retaining the strict on-screen/hit assertions. No product source changed. At exact head `96c5e9d6`, scheduler run `0e271d21-16f1-436d-8ada-46cd519e83db` passed 4/4; the bounded scroll cleared measured sticky occlusion without relaxing the strict viewport/hit assertions.

### Round 12 — rendered BMAD Step 4 review at `8187e6db`

The required Step 4 reviewers inspected the frozen `49b558f243c7bacbfb46c7bc04f749bf131cefea..8187e6db1eb3ad458cc8020660b277b0e085cd16` diff (SHA-256 `a9fb59c9c2c7328645b72b3b938e791a4562ee25cace6a827ee0c149b4c61b46`). Their reports are `review-reports/step04-r12-blind-hunter.txt`, `review-reports/step04-r12-edge-case-hunter.txt`, and `review-reports/step04-r12-verification-gap.txt`; provenance is indexed in `review-reports/STEP04-INDEX.json`.

| Finding | Verdict / route | Evidence and disposition |
|---|---|---|
| R12-B1 — `validWakeStamp` accepts a non-canonical date form that `Date.parse` can normalize | medium — patch (group G1) | The new input path bypasses the calendar check because the regex does not match, then trusts the normalized parse. This is distinct from R11 EC-01's ISO-shaped impossible-day path, which is fixed; require the expected date form and add a regression test. |
| R12-B2 — strip group landmark name comes from the KPI enumeration | follow-up (carried) | Carried from R10 BH-F7 and its existing deferred-work entry; same claim and code at `web/src/ui/board.ts:1116-1121`. No re-verification, patch, or duplicate deferral. |
| R12-B3 — `bindClient` leaves disclosure maps across re-pair | follow-up (carried) | Carried from R11 BH-04 and its existing deferred-work entry; same claim and reset path at `web/src/ui/board.ts:331-340`. No re-verification, patch, or duplicate deferral. |
| R12-B4 — numeric-boundary checks do not cover all accepted widths | medium — patch the new older-pending coverage only; wake/deferred portions carried | The older-pending boundary loop currently covers 1440px and 360px only, while acceptance names 1440/1200/768/360. Extend that loop to all `VIEWPORTS`. The wake-age/deferred-count portions are the same already-carried R10 finding; do not re-open them. |
| R12-B5 — visual captures use fixed ignored paths | follow-up (carried) | Carried from R6 F-7 and its existing deferred-work entry; same paths at `web/e2e/dashboard-strip.spec.ts:1474-1490`. No re-verification, patch, or duplicate deferral. |
| R12-E1 — mailbox counts should match the raw item-array length | false | `GruMailbox.snapshot()` returns resolved items but computes counts from non-resolved `live` items; the For Gru renderer also filters resolved entries. Equality with the raw array length would reject valid snapshots and is not an acceptance requirement. |
| R12-E2 — a `kind: job` mailbox item may have `jobId: null` | medium — defer | The client validator accepts this malformed combination and `mailboxJobs()` drops null IDs, so a protocol-violating frame could omit a counted row. Current `projectMailbox.make()` derives `kind` from `jobId`, and this validator gap predates the SLIM changes. Added as a new follow-up in `deferred-work.md`. |
| R12-E3 — a non-resolved mailbox item may have an empty reasons array | low — defer | The validator permits an empty array, which would leave a malformed row without human-readable reason labels (the required `basis` is still displayed). Current projection emits job items only when reasons exist and derives incident reasons from notification rows; this is pre-existing protocol hardening, added to `deferred-work.md`. |
| R12-E4 — HEISTS status totals no longer use the prior all-job derivation | false | The PR base is integrated `main` at `79c032e5`; `web/src/lib/board-kpi.ts` is unchanged from that base to `8187e6db`. The current-main top-level HEISTS derivation is preserved, as required. |
| R12-E5 — chat is changed despite the unchanged-chat claim | false | `web/index.html` is unchanged from the integrated `main` base `79c032e5`; the cited intake view is already part of that preserved main behavior. |
| R12-E6 — crew/transcripts are changed despite the unchanged claim | false | The cited repository panel is present in integrated `main` and unchanged from `79c032e5` to the reviewed head. |
| R12-E7 — For Gru navigation count/availability changed source | false | The mailbox-derived count and availability already exist in `board-sections.ts` at the integrated-main base and are unchanged; the SLIM strip changes presentation, not this source. |
| R12-V1 — strip Playwright is absent from GitHub CI | false | GitHub CI is not this workflow's only verification path. The declared `strip-browser` scheduler scope ran at exact head `8187e6db` (run `c7b57499-58d8-45cf-a4c7-06ff28b65906`) and passed 68/68, including the responsive layout checks. No CI change is required for this task's gate. |

Root-cause groups: G1 is R12-B1's non-canonical date parse path, medium, patch. G2 is the new older-pending viewport-coverage gap in R12-B4, medium, patch; the older wake/deferred coverage finding remains carried. The remaining findings are false, carried, or deferred as recorded above. No `intent_gap` or `bad_spec` finding remains; no Step 3 loopback is triggered.

### Round 13 — rendered BMAD Step 4 review at `3da207a3`

Three fresh tracked reviewers inspected the frozen `49b558f243c7bacbfb46c7bc04f749bf131cefea..3da207a3c3f481d04e0f203ab0b0a7e72baffec5` diff (SHA-256 `2593da8aa51b3f77b9c473e35353ea953f9a1062e94d0262458d931c2d68d8b2`, 4,348,775 bytes). Reports and transcript provenance are indexed in the Round 13 `STEP04-R13-INDEX.json`; all transcripts had zero skipped torn lines and each reviewer worktree was clean at `79c032e5` with both reviewed Git objects present. The only in-scope new finding is the timezone-less timestamp acceptance; the other reports are repeated carried issues or separate pre-existing follow-ups.

| Finding | Verdict / route | Evidence and disposition |
|---|---|---|
| R13-B1 — timezone-less wake timestamp is parsed in viewer-local time | medium — patch (G1) | `Date.parse('2026-10-01T00:00:00')` is finite but uses local time, so the same snapshot can show different ages across time zones. Require an explicit zone in the wake-age path; add a regression test while preserving explicitly zoned timestamps. |
| R13-B2 — strip group accessible names use KPI enumeration | follow-up (carried) | Same claim as R10 BH-F7 and R12-B2; existing deferred-work disposition is unchanged. No duplicate patch or deferral. |
| R13-B3 — `bindClient` retains owner disclosure maps across re-pair | follow-up (carried) | Same claim as R11 BH-04 and R12-B3; existing deferred-work disposition is unchanged. No duplicate patch or deferral. |
| R13-B4 — wake/deferred numeric-boundary checks omit accepted widths | follow-up (carried) | R12 fixed the older-pending width loop at all `VIEWPORTS`; the remaining wake-age/deferred-width legs are the already-carried R10 BH-F5 / R12-B4 follow-up. No new acceptance gap is introduced by this report. |
| R13-B5 — visual captures use fixed ignored paths | follow-up (carried) | Same claim as R6 F-7 and R12-B5; existing deferred-work disposition is unchanged. |
| R13-B6 — job mailbox item may have null `jobId` | defer (carried) | Same pre-existing protocol-validation gap as R12-E2; existing deferred-work entry remains authoritative. |
| R13-B7 — non-resolved mailbox item may have empty `reasons` | defer (carried) | Same pre-existing protocol-validation gap as R12-E3; existing deferred-work entry remains authoritative. |
| R13-E1 — rehearsal script imports a removed wizard artifact and uses a retired answer | defer / out of scope | `scripts/rehearsal-bmad-onboarding.mjs` is unchanged in the reviewed range; this repo-internal harness is unrelated to the SLIM presentation. Recorded as a separate follow-up in `deferred-work.md`. |
| R13-V1 — signal-less GET can turn a received HTTP 401 into status-0 timeout | defer / integrated-main follow-up | The GET refusal path is existing `BoardClient` behavior from integrated main; the SLIM branch's prior fix addressed the POST race only. This is not required to render the strip and is recorded as a separate `deferred-work.md` follow-up. |

The full review texts are `review-reports/step04-r13-blind-hunter.txt`, `review-reports/step04-r13-edge-case-hunter.txt`, and `review-reports/step04-r13-verification-gap.txt`; hashes and transcript counts are in `review-reports/STEP04-R13-INDEX.json`. Root-cause group G1 is the timezone-less `Date.parse` local-time path; patch the validator and regression test. Other reports are carried or explicitly deferred as above. No `intent_gap` or `bad_spec` remains; no Step 3 loopback is triggered.

### Native Perkins r6 follow-through at `bf18b63a`

The native r6 report required a correction to the historical unit-baseline overlay and separately warned that failed suites with zero assertions can be misclassified when their error text is not recognized. The pre-fix scheduled run `3673c3de-46f3-4d65-b58e-177fcfc3527d` at `bf18b63a48f5f5f2dff32c69ec0d586085bbef51` is preserved: its Vitest report shows `board.test.ts` failed collection with zero assertions (`Failed to resolve import "../lib/mailbox-fixture.test-support.js"`), while the classifier incorrectly emitted `BASELINE RED CLASSIFIED`. Treat that run as invalid baseline evidence; do not relabel, delete, or replay it.

This follow-through overlays the test-only mailbox fixture helper with the integrated tests and makes any failed zero-assertion Vitest suite a code-3 setup/collection failure independent of its message. Regression coverage includes both an unrecognized `ReferenceError` and the recorded Vite import-resolution wording. The head-side board suite and accepted feature-absence instrument remain present and unchanged. The GET-401 follow-up and wake/deferred numeric-width coverage remain carried under R13-V1 and R13-B4; no new product gate is added.

### Round 14 — rendered BMAD Step 4 review at `fcd84b68`

Three fresh tracked reviewers inspected the frozen `49b558f243c7bacbfb46c7bc04f749bf131cefea..fcd84b680fc2ee10c8da6c82b5d97a9e925e33ae` diff (SHA-256 `72babce587243015ab9a2c63ea15b50617b600aca8dec0b5ad6837beee26e8dc`, 6,106,411 bytes). Reports and transcript provenance are indexed in `review-r14/STEP04-R14-INDEX.json`; all reviewer worktrees were clean, both Git objects were present, and transcripts had zero torn lines.

| Finding | Verdict / route | Evidence and disposition |
|---|---|---|
| R14-B1 — a signal-less GET can turn a received HTTP 401 into a status-0 timeout | follow-up (carried) | Same integrated-main GET refusal race as R13-V1; existing `deferred-work.md` disposition remains authoritative. No duplicate patch or deferral. |
| R14-B2 — missing `--require-file` value can fall back to generic baseline RED classification | medium — patch (group G1) | Reproduced with a one-test report containing an unrelated `AssertionError`: the malformed CLI invocation exited 1 with `BASELINE RED CLASSIFIED`. The CLI now rejects missing/empty required values with exit 3; regression tests cover the missing instrument path and missing/empty `--require-file-substr` allowlist, which could similarly disable its cause check. |
| R14-B3 — strip group region names use the KPI tooltip enumeration | follow-up (carried) | Same claim and unchanged code as R13-B2; existing deferred-work disposition remains authoritative. No duplicate patch or deferral. |
| R14-E1 — fallback review input capture resets the lane's actual Git index | defer (integrated-main review infrastructure) | A disposable-repository reproduction showed a staged change disappear from `git diff --cached` and move to the worktree diff after the capture's `git add -N .` / `git reset -q --` sequence. The implementation exists at integrated `main` `79c032e5` and is unchanged by the SLIM branch since that integration; the separate follow-up is recorded in `deferred-work.md`. |
| R14-E2 — onboarding rehearsal imports the removed wizard artifact | defer (carried) | Same claim as R13-E1; the rehearsal remains unchanged and its existing `deferred-work.md` entry is authoritative. No duplicate deferral. |
| R14-V1 — wake-age/deferred-count geometry boundaries are checked only at 1440px | follow-up (carried) | Same accepted-width coverage gap as R13-B4; the existing follow-up remains authoritative. No duplicate patch or deferral. |

Root-cause groups: G1 is malformed required CLI argument handling in the baseline classifier, medium, patched with fail-closed argument validation and regression tests. G2 is the integrated-main fallback capture's mutation of the real Git index, deferred outside this presentation scope. The remaining findings are carried unchanged. No `intent_gap` or `bad_spec` remains; no Step 3 loopback is triggered.

### Round 15 — built-in whole-change review at `d2ee6c56`

Three fresh tracked reviewers inspected frozen range `49b558f243c7bacbfb46c7bc04f749bf131cefea..d2ee6c56c005aba21bc0825a66dbdab5f2d721a9` (6,112,879 bytes; SHA-256 `02ed054c5012e3849c0e1b11ac9f6e998e3a01fd685279880bad87802841a54a`). Reports and transcript provenance are indexed in `review-r15/STEP04-R15-INDEX.json`; all jobs delivered, their worktrees remained clean at integrated main `79c032e5a5a1ba7607b5daf6cafa36c2aecbdd37`, both reviewed commit objects were present, and each transcript had zero torn lines. When commissioner dispositions were attempted after triage, each report job had already become `done` and its handback notification had been resolved by code; the authenticated disposition POSTs were refused because the jobs were no longer `DELIVERED`. The current PR observation remained open at `d2ee6c56`; the API did not expose the auto-retirement reason, so no merge or head-movement claim is made. This is recorded in `review-r15/dispatch-disposition.json`; no retry or status rewrite was attempted.

| Finding | Verdict / route | Evidence and disposition |
|---|---|---|
| R15-B1 — a valid JSON Vitest report with a null `testResults` entry makes the CLI throw and exit 1 | medium — patch (R15-G1) | Reproduced with `testResults: [null]` and one failed test: the uncaught `TypeError` exits 1, the same exit code as a behavioral RED. The CLI must report malformed report shape as setup/collection failure (exit 3). |
| R15-B2 — `--require-file-substr` without `--require-file` is silently ignored | medium — patch (R15-G2) | Reproduced: a generic report with an unrelated `AssertionError` plus only `--require-file-substr` prints `BASELINE RED CLASSIFIED` and exits 1. Reject the orphaned option rather than silently disabling its cause constraint. |
| R15-B3 — a failed snapshot GET after a pushed frame ends an in-flight post-action refresh without retry | medium — defer (integrated main) | The stale-epoch catch branch and `client.wake()` action caller are present at integrated main `79c032e5` and unchanged by this branch; the success branch already retries the same stale-push case. This is a separate main-side BoardClient follow-up, recorded in `deferred-work.md`, not a SLIM change. |
| R15-B4 — a wrapped KPI row begins with its separator dot | false | The approved 360px reference explicitly calls for light separators and shows the same dot at the start of wrapped HEISTS/PRS metric rows; the candidate capture matches the approved treatment. |
| R15-B5 — `bindClient` retains owner disclosure maps across re-pair | follow-up (carried) | Same claim as R11 BH-04, R12-B3, and R13-B3; the existing deferred-work entry remains authoritative. No re-verification, patch, or duplicate deferral. |
| R15-B6 — strip group `aria-label` overrides the visible heading | follow-up (carried) | Same claim as R10 BH-F7, R12-B2, R13-B2, and R14-B3; the existing deferred-work entry remains authoritative. No re-verification, patch, or duplicate deferral. |
| R15-E1 — a `kind: job` mailbox item may have `jobId: null` | follow-up (carried) | Same pre-existing validator gap as R12-E2 and R13-B6; existing deferred-work disposition remains authoritative. No re-verification, patch, or duplicate deferral. |
| R15-E2 — a non-resolved mailbox item may have an empty `reasons` array | follow-up (carried) | Same pre-existing validator gap as R12-E3 and R13-B7; existing deferred-work disposition remains authoritative. No re-verification, patch, or duplicate deferral. |
| R15-E3 — Playwright classification keeps only the first failed project/test per spec | medium — patch (R15-G3) | A synthetic report with two unexpected projects (feature-absence failure then unrelated fixture failure) exits 1 while reporting only one failure. Classify each unexpected test separately so an unclassified project failure cannot be omitted. |
| R15-E4 — onboarding rehearsal imports the removed wizard module | follow-up (carried) | Same claim as R13-E1 and R14-E2; its existing out-of-scope deferred-work entry remains authoritative. No re-verification, patch, or duplicate deferral. |
| R15-E5 — the reviewed change adds authenticated intake/proposal API routes despite the frozen backend boundary | false | `src/dispatch/server.ts` is byte-identical from integrated main `79c032e5` to candidate `d2ee6c56` (SHA-256 `4b6d6146c5953904c501efd0ebe057715c6229f61c7b4116bf3869d88d196098`). The routes are preserved main content, not changes introduced by this SLIM branch. |
| R15-V1 — a named Vitest instrument can omit its cause allowlist and skip feature-cause checks | medium — patch (R15-G2, pre-verified) | The verification-gap report establishes that an omitted `--require-file-substr` yields an empty allowlist and the classifier skips its cause guard; the R14 tests covered a present flag with a missing/empty value, not omission. Require the allowlist for named-instrument CLI mode. |

Root-cause groups: G1 is an invalid nested Vitest report escaping the classifier boundary as exit 1; catch malformed-shape exceptions and return setup failure 3. G2 is the unpaired file-cause CLI contract: orphaned or omitted `--require-file-substr` disables the intended cause check; require both options together with a nonempty list. G3 is per-spec Playwright aggregation that drops later unexpected projects; inspect every unexpected test. The BoardClient issue is pre-existing at integrated main and deferred; the other findings are false or carried. No `intent_gap` or `bad_spec` remains; no Step 3 loopback is triggered.

### Round 16 — built-in whole-change review at `b744e045`

Three fresh tracked reviewers inspected immutable range `49b558f243c7bacbfb46c7bc04f749bf131cefea..b744e0454290d4fba12fe38f55e859e7a37aafb1` (6,124,110 bytes; SHA-256 `1686d714d550f7cd4bb856d31c3af33c12fa9fc121ccc027d663b5b896ac964d`). Reports and reviewer/worktree provenance are indexed in `review-r16/review-reports/STEP04-R16-INDEX.json`; all three jobs delivered, each reviewer worktree remained clean at integrated main `79c032e5a5a1ba7607b5daf6cafa36c2aecbdd37`, and the frozen base/target objects were present.

| Finding | Verdict and route | Evidence and disposition |
|---|---|---|
| R16-B1 — malformed Playwright stats can still produce classified RED | medium — patch (G1) | The accepted `stats.unexpected` count was the only counter checked against the report tree; a string `stats.expected` can still pass and coerce the computed total. Require the serializer's top-level `errors` array, non-negative safe-integer counters, and match all four outcome counts against the JSON tree before accepting evidence. Regressions cover a missing `errors` array, the reported `expected: "2"` case and a typed counter/tree mismatch. |
| R16-E1 — proposal rows do not use the compact owner face | medium — defer / out of approved scope | The observation is accurate, but the owner scope-restoration amendment #7 and effective contract v11 exclude the absorbed-later-main lesson-proposal UI from SLIM acceptance; the integrated-main row is preserved rather than compacted here. The report's requested redesign would expand the feature. The separate follow-up is recorded in `deferred-work.md`; the existing `lesson-proposal-browser` scope is run at the settled candidate to check current-main preservation, not proposal compaction. |
| R16-E2 — onboarding rehearsal imports the removed wizard artifact | follow-up — carried | Same claim as R13-E1/R14-E2/R15-E4; the existing out-of-scope deferred entry remains authoritative. No duplicate verification or deferral. |
| R16-V1 — a failed Playwright spec with no unexpected test record can exit 2 | medium — patch (G1) | A report with `spec.ok: false`, one expected test and zero unexpected tests reaches the zero-unexpected branch before the retained incomplete-spec result is checked. Classify that report as setup failure (exit 3) before the claim-broken branch; a discriminating regression pins it. |
| R16-V2 — timer-driven split wake-age refresh lacks a regression | medium — patch (G2) | The accepted ticker must refresh the split digits without a new snapshot. Add a fake-clock unit case that holds one snapshot through 9s→10s and checks the number/unit update; no product logic change is required. |
| R16-V3 — wake/deferred/CHILDREN boundary geometry omits accepted widths | follow-up — carried | Same accepted-width gap already recorded under R10/R12/R13/R14; its existing deferred-work disposition remains authoritative. No duplicate patch or deferral. |
| R16-V4 — strip-group accessible names use tooltip enumerations | follow-up — carried | Same claim as R10-BH-F7/R12-B2/R13-B2/R14-B3/R15-B6; existing deferred-work entry remains authoritative. No duplicate verification or deferral. |

Root-cause groups: G1 is incomplete Playwright report validation: a missing errors array or malformed stats/tree can be accepted as behavioral evidence, while a failed spec absent from unexpected-test outcomes can be labeled an unexpectedly passing baseline. These now fail closed as exit 3, with exact regression cases. G2 is the missing timer-driven oracle for split wake-age updates; a deterministic unit test proves the unchanged-snapshot ticker path. The proposal redesign is deferred because owner amendment #7 excludes it from this feature; the other repeated observations remain carried. No `intent_gap` or `bad_spec` is triggered. The R16 reports are not re-settled after the implementation head advances beyond their reviewed SHA; no manual disposition is claimed.
