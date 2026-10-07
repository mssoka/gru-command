---
title: 'Dashboard slim strip — current-main continuation (approved Sample2 port)'
type: 'feature'
created: '2026-10-07'
status: 'in-progress'
route: 'dispatch'
baseline_commit: '49b558f243c7bacbfb46c7bc04f749bf131cefea'
review_loop_iteration: 0
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
- [ ] `web/src/lib/board-health.ts` + `web/src/lib/board-rail.ts` + `web/src/lib/owner-band.ts` — additive splits + `ackNextStep`; no derivation changes.
- [ ] `web/src/ui/board.ts` — slim strip + merged wakes chip + compact owner band (disclosure, allocated regions, focus, panel surface).
- [ ] `web/src/styles/components.css` — slim-strip and compact band styles with reserved numeric slots and 640px container groups.
- [ ] `web/src/ui/board.test.ts`, `web/src/lib/board-rail.test.ts`, `web/src/lib/owner-band.test.ts` — re-face existing rail assertions, append the lane's deterministic regressions.
- [ ] `web/e2e/dashboard-strip.spec.ts` — port the synthetic suite; extend silas fixtures to main's protocol; add CHILDREN present/absent and deferred-wakes cases; keep 1440/1200/768/360 × light/dark captures.
- [ ] `web/e2e/smoke.spec.ts`, `web/playwright.config.ts` — selector migration + mock testMatch union.
- [ ] `.gru-command/worktree.toml`, `.gitignore` — union scopes (`strip-browser`, `dashboard-slim-strip-unit`, `dashboard-slim-strip-baseline` base-pinned, `strip-browser-baseline` base-pinned) + `web/e2e-artifacts/`.
- [ ] Commit, then built-in independent whole-change review via `POST /api/dispatch` (`deliverable: review`) on the exact head; fix findings; re-verify.

**Acceptance Criteria:**
- Given complete/empty/zero/unknown/stale snapshots, when the strip renders, then every current-main labelled fact and `data-kpi` value is truthful, GRU wake/count stays independent of SILAS, and Binned stays distinct from Parked/success.
- Given 9/10, 99/100, 999/1000 fixtures at 1440/1200/768/360 (+ long labels, both themes), when rendered, then adjacent labels/group geometry do not jump, no body/component horizontal overflow or clipping occurs, and essential text/numbers meet ≥4.5:1 contrast.
- Given multiple owner notices/ready PRs, when rendered, then faces are initially collapsed with heading/count/calm empty state and older-pending access; Enter/Space disclosure, focus and expanded state survive snapshot refresh; reveal makes no operational request or pending-count change; Ack/OPEN PR remain explicit and reconcile ambiguity to the authoritative snapshot.
- Given the rest of the cockpit, when any other surface renders, then order/counts/previews/collapsed sections/Binned disclosure, chat, crew/transcripts, receipts and navigation are unchanged.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

- Numeric slots: number part only carries `.num` (`font-variant-numeric: tabular-nums; display:inline-block; text-align:right`), scoped to `#chip-rail`/`#board-owner` so unrelated surfaces keep app defaults (probe-tested). The e2e suite measures geometry; CSS only declares.
- Strip DOM: `.strip-pair[data-chip]` keeps each chip's identity (deploy/reviews/silas/alerts/verify/cure) and tone class; `.strip-group` keeps group aria-labels; every count keeps `data-kpi`. A present CHILDREN group renders as an additional group (wraps to a second row under the 3-column container grid) — no fact dropped.
- Region ids: `fy-detail-<n>` allocated per action id; controls carry `data-action-id` + `data-control` (disclose|ack|open); focus restore matches both.
- Baselines: unit baseline overlays final test files on a `git archive` of `49b558f` (node_modules symlinked); browser baseline overlays final strip spec + playwright config. Expected RED is feature-absence; a collection/setup error is not acceptable fail-before evidence.
- Provenance recorded per file as source blob OID at `4de42d9`; the ignored `preservation-manifest-*.json` holds original hashes (rechecked at handback).

## Verification

**Commands (through authenticated `/api/verify` + shipped capture helper):**
- `strip-browser` — `(cd web && npm run e2e -- --project=mock e2e/dashboard-strip.spec.ts)`; expected GREEN at final head; retain + inspect 1440/1200/768/360 light/dark captures.
- `dashboard-slim-strip-unit` — `cd web && node ../node_modules/vitest/vitest.mjs run src/ui/board.test.ts src/lib/board-rail.test.ts src/lib/owner-band.test.ts`; expected GREEN.
- `dashboard-slim-strip-baseline` / `strip-browser-baseline` — final test bytes over `git archive 49b558f…`; expected RED (feature absence).
- `full` (`npm test`) and `typecheck` at the same final head.
- Independent whole-change review via `POST /api/dispatch` with `"deliverable": "review"` on the exact head; then exact-head CI and native Perkins READY on the exact final head.

**Manual checks:** personally inspect screenshots at 1440/1200/768/360 both themes; verify no overflow masking.
