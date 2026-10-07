---
title: 'Dashboard slim strip — current-main continuation (approved Sample2 port)'
type: 'feature'
created: '2026-10-07'
status: 'in-review'
route: 'dispatch'
baseline_commit: '49b558f243c7bacbfb46c7bc04f749bf131cefea'
review_loop_iteration: 5
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
- Tests: `web/src/ui/board.test.ts` (rail describe ~475–652 re-faced to strip selectors; FOR YOU describe ~2420+ `data-control` updates + lane's new regressions appended: wake truths, independent reveal no-request, short face vs expanded, id collision, push/removal, window keep, ack/open focus, panel surface scoping); `web/src/lib/board-rail.test.ts` (append split describe); `web/src/lib/owner-band.test.ts` (append `ackNextStep` describe); `web/e2e/dashboard-strip.spec.ts` (lane-only, port + silas fixtures for main's `isValidSnapshot`, add children-present and deferred-wake cases); `web/e2e/smoke.spec.ts` (rail assertions to strip DOM; keep six-section suites); `web/playwright.config.ts` (mock `testMatch` union); `.gitignore` (`web/e2e-artifacts/`); `.gru-command/worktree.toml` (union 4 scopes, baselines pinned to `49b558f`).

## Tasks & Acceptance

**Execution:**
- [x] `web/src/lib/board-health.ts` + `web/src/lib/board-rail.ts` + `web/src/lib/owner-band.ts` — additive splits + `ackNextStep`; no derivation changes.
- [x] `web/src/ui/board.ts` — slim strip + merged wakes chip + compact owner band (disclosure, allocated regions, focus, panel surface).
- [x] `web/src/styles/components.css` — slim-strip and compact band styles with reserved numeric slots and 640px container groups.
- [x] `web/src/ui/board.test.ts`, `web/src/lib/board-rail.test.ts`, `web/src/lib/owner-band.test.ts` — re-face existing rail assertions, append the lane's deterministic regressions.
- [x] `web/e2e/dashboard-strip.spec.ts` — port the synthetic suite; extend silas fixtures to main's protocol; add CHILDREN present/absent and deferred-wakes cases; keep 1440/1200/768/360 × light/dark captures.
- [x] `web/e2e/smoke.spec.ts`, `web/playwright.config.ts` — selector migration + mock testMatch union.
- [x] `.gru-command/worktree.toml`, `.gitignore` — union scopes (`strip-browser`, `dashboard-slim-strip-unit`, `dashboard-slim-strip-baseline` base-pinned, `strip-browser-baseline` base-pinned) + `web/e2e-artifacts/`.
- [ ] Commit, then built-in independent whole-change review via `POST /api/dispatch` (`deliverable: review`) on the exact head; fix findings; re-verify.

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
- 2026-10-07 verification round at head `a8847055e3d0c11eddb282458e67c7e6b88a359a` (all through the authenticated scheduler + shipped capture helper; complete NDJSON sinks + receipts under `_bmad-output/verify-captures/current-main-20261007/`): `dashboard-slim-strip-unit` GREEN run 73255daf (137/137); `strip-browser` GREEN run 5d3bc3d2 (67/67, captures inspected at 1440/1200/768/360 light+dark); `dashboard-slim-strip-baseline` RED run e7bf5e64 (23 assertion-level feature-absence failures + 1 missing-export TypeError inside a test for the new `ackNextStep` import; no collection/suite-level error); `strip-browser-baseline` RED run 6bda4166 (67/67 fail on the missing strip DOM, baseline app builds); `typecheck` GREEN run 4cbd19a1; `full` GREEN run 19589690 (lint/typecheck/build + backend 2291 passed + heavy 925 passed + web 537 passed, exit 0). Independent whole-change review is commissioned via `POST /api/dispatch` (`deliverable: review`, three lenses) at this exact head as part of this round.
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

Round-1 resolution: all patch entries landed in commits `b030831` (main fixes + test hardening), `e5ae13e` (A1 probe zero-reservation), `64ab947` (real theme golden refresh for the CHILDREN separator fix, inspected). Re-verification at the fix head `64ab947`: `dashboard-slim-strip-unit` GREEN 137 (run 803e9f62); `strip-browser` GREEN 67 (run 041a281b); `strip-smoke` GREEN (run f9e4f0bf); `strip-themes` GREEN (run 734295fb); `dashboard-slim-strip-baseline` RED (run f5976535); `strip-browser-baseline` RED (run a0cf1b64); `typecheck` GREEN (run 371b6da9); `full` GREEN (run 3f23f291). Round-2 whole-change review commissioned at `ddc42e4`; its blocking scope was the fix delta `6e48023..ddc42e4` (untouched-code findings reported as follow-ups).

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

Round-6 follow-ups (reported, not blocking; record only unless noted): the band-head fallback anchor has no themed focus ring (F-1); display receipts fire for collapsed rows whose full detail is hidden (F-2, doctrine note); the smoke KPI walk omits `jobs.binned` (F-3); the deploy `unknown` split branch is unexercised (F-4); non-alert pair tones are unpinned (F-5); `::before` KPI separators are exposed to AT (F-6); the capture suite overwrites fixed ignored paths without run-scoping (F-7); re-pairing reuses actionId/region state held from the previous connection (`bindClient` does not clear the band maps — edge-case follow-up); the spec Tasks section still says "union 4 scopes" where seven were added (edge-case claim follow-up, wording now consistent in Verification). The carried records (CHILDREN tone, group aria-label, unstamped geometry, narrow-width age/deferred legs, panel layout, baseline failure-kind) remain in `deferred-work.md`.

## Design Notes

- Numeric slots: number part only carries `.num` (`font-variant-numeric: tabular-nums; display:inline-block; text-align:right`), scoped to `#chip-rail`/`#board-owner` so unrelated surfaces keep app defaults (probe-tested). The e2e suite measures geometry; CSS only declares.
- Strip DOM: `.strip-pair[data-chip]` keeps each chip's identity (deploy/reviews/silas/alerts/verify/cure) and tone class; `.strip-group` keeps group aria-labels; every count keeps `data-kpi`. A present CHILDREN group renders as an additional group (wraps to a second row under the 3-column container grid) — no fact dropped.
- Region ids: `fy-detail-<n>` allocated per action id; controls carry `data-action-id` + `data-control` (disclose|ack|open); focus restore matches both.
- Baselines: unit baseline overlays final test files on a `git archive` of `49b558f` (node_modules symlinked); browser baseline overlays final strip spec + playwright config. Expected RED is feature-absence; a collection/setup error is not acceptable fail-before evidence.
- Provenance recorded per file as source blob OID at `4de42d9`; the ignored `preservation-manifest-*.json` holds original hashes (rechecked at handback).

## Verification

**Commands (through authenticated `/api/verify` + shipped capture helper; the union this lane added is seven scopes: `strip-browser`, `strip-smoke`, `strip-themes`, `strip-themes-update`, `dashboard-slim-strip-unit`, `dashboard-slim-strip-baseline`, `strip-browser-baseline` — the latter two pinned to base `49b558f…` and expected RED):**
- `dashboard-slim-strip-unit` — `cd web && node ../node_modules/vitest/vitest.mjs run src/ui/board.test.ts src/lib/board-rail.test.ts src/lib/owner-band.test.ts`; expected GREEN.
- `strip-browser` — `(cd web && npm run e2e -- --project=mock e2e/dashboard-strip.spec.ts)`; expected GREEN; retain + inspect 1440/1200/768/360 light/dark captures.
- `strip-smoke` — `(mock smoke suite)`; expected GREEN (migrated main assertions).
- `strip-themes` — `(mock + real "dark toggle persists" goldens, no update flag)`; expected GREEN; `strip-themes-update` is the deliberate, inspected regeneration scope (never cited as acceptance).
- `pipeline-board-browser` — the existing main scope; expected GREEN (slim-strip chrome geometry migration).
- `dashboard-slim-strip-baseline` / `strip-browser-baseline` — final test bytes over `git archive 49b558f…`; expected RED (feature absence), exits unmasked.
- `full` (`npm test`) and `typecheck` at the same final head.
- Independent whole-change review via `POST /api/dispatch` with `"deliverable": "review"` on the exact head (six rounds: 1–2 whole-change with full blocking scope, 3–5 delta-scoped from round 3, 6 the concluding whole-change pass); then exact-head CI and native Perkins READY on the exact final head.

**Manual checks:** personally inspect screenshots at 1440/1200/768/360 both themes; verify no overflow masking.
