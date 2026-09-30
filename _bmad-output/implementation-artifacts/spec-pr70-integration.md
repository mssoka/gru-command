---
title: 'PR70 bounded integration after owner merged PR68+PR76'
type: 'integration'
created: '2026-09-27'
baseline_commit: 'cea37b57b31874716ae8e8bec53770625cae8345'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="owner-approved briefing — do not modify unless the owner renegotiates">

## Intent

**Problem:** Owner merged PR68 (board v6.1 rulings, `0930488e1c6f72a2085e0b4aa86a54b22efa2730`) and PR76 (`df9fe01e87913c5f2ad47219ddc2f838eca6d045`) to main, which now conflicts with the approved owner-chime branch `gru/owner-chime` (head `cea37b57b31874716ae8e8bec53770625cae8345`, PR70 OPEN/CONFLICTING); PR70 must integrate current main so Silas can run ONE fresh native whole-PR Perkins review against it.

**Approach:** Normal merge commit of origin/main into the existing branch (no rebase, no force, no blanket ours/theirs), resolving the four content conflicts semantically while retaining BOTH the approved owner-chime surface (synthesized needs-owner-only chime, first-gesture arming with unarmed bell-nudge fallback, persisted speaker mute, 30s throttle) AND main's newer PR68/71 bell navigation/ack + routing contracts; then focused verification, scheduler-run full verification, genuinely independent bounded BMAD delta review, normal safe push for fresh exact-head CI, receipts, and persisted DELIVERED.

## Boundaries & Constraints

**Always:** Preserve pre-integration head `cea37b5` with a non-overwriting local backup ref + receipt before merging. Resolve conflicts semantically from the combined tree's actual content. Preserve main's bell click behavior verbatim (panel toggle + seen-owner ack + shown receipts — PR68/71 owner-approved) and keep mute/arming on the separate header speaker. Keep the chime keyed ONLY on `routing === 'needs-owner'`; action-required/FYI stay silent. Keep every command + exit code; failed broad runs stay failed. Heavy verification through the deployed service scheduler (`POST /api/verify`, job `owner-chime`) at a safe checkpoint, never in parallel with media work; preserve >=36GiB free disk. Fresh exact-final-head GitHub CI on the pushed candidate. Honest capability reporting: the repo has no `_bmad` scaffold (`render_skill.py` absent), so this lane-local bmad-build run follows the skill's workflow files directly with this spec as its bounded artifact, per the PR76/PR77/PR68 lane precedent; the render-pipeline gap is recorded in the delivery evidence, not papered over.

**Never:** No rebase/force-push/ours-theirs blanket/reset/stash/test deletion/new dependency/unrelated repair. Do NOT touch live `~/.gru-command/config.toml` (read-only token extraction for API headers only, never printed/stored), private backups, deployed checkout, other lanes, parked board work, review/role/model policy. No service restart/deploy/merge — the owner retains merges. Worker does NOT self-arm `/api/dispatch/review` or publish a substitute whole-PR verdict; Silas owns the ONE native Perkins arm after this job settles idle. No new feature choices: real owner-approved audio scope only, no audible alarms in the owner's active app (isolated AudioContext/clock/storage fixtures in unit tests; isolated browser only if needed). Do not reopen the historical r1 chunk-review failure (ABORTED/INCOMPLETE — superseded by the whole-PR protocol) or turn old/ACKed/resolved history into fresh audio.

</frozen-after-approval>

## Code Map

Investigation (2026-09-27, this lane, HEAD=cea37b5, origin/main=df9fe01):

- `git merge-tree --write-tree HEAD origin/main`: FOUR content conflicts — `docs/BOARD.md`, `web/e2e/smoke.spec.ts`, `web/src/lib/board-protocol.ts`, `web/src/styles/components.css`. Auto-merging (must be verified semantically): `docs/UI.md`, `web/index.html`, `web/src/lib/board-protocol.test.ts`, `web/src/main.ts`. New files landing whole: `web/src/ui/owner-chime.ts` (+ its test).
- `web/src/lib/board-protocol.ts`: branch widened the routing union to include `'needs-owner'`; main landed the SAME widening plus `FOR YOU` semantics via PR71 (`NotificationView.routing: 'fyi' | 'action-required' | 'needs-owner'`, snapshot check accepts all three). Branch's protocol change is fully subsumed — resolution takes MAIN's file verbatim.
- `web/src/ui/board.ts` (main, unchanged by branch): bell click = panel toggle + `seenOwnerIds` add + `sendShown` receipts + badge refresh; `surfaceNewNotifications` fires `onToast` ONLY for new (not first-render, not resolved) `needs-owner` rows — the chime hook point inherits that gating, and the chime's own routing gate stays as defense-in-depth. Old/ACKed/resolved history can never sound.
- `web/src/main.ts`: branch wires `OwnerChime` (speaker = `#sound-toggle`, bell = `#notification-bell`, storage) and extends the `setToastHandler` callback with `ownerChime.notify(notification.routing)`. Main kept the same seam (`boardView.setToastHandler((notification) => surfaceNotification(notification))`) — merged wiring keeps both.
- `web/index.html`: branch inserted `#sound-toggle` between `#conn-dot` and `#notification-bell`; main's v6.1 header kept that adjacency — auto-merge should place the speaker in the live header; verify post-merge.
- `web/e2e/smoke.spec.ts`: branch added `'#sound-toggle'` to `CHROME_CONTROLS` (old list had `#tab-chat`/`#tab-board`); main's v6.1 removed the tabs (`CHROME_CONTROLS = ['#theme-toggle', '#settings-toggle']`, with `#notification-bell` appended on specific assertions). Resolution: main's structure + `'#sound-toggle'` appended to `CHROME_CONTROLS`.
- `web/src/styles/components.css`: branch added `.board-sound` armed/muted styles, `.board-bell--nudge` + keyframes, and a `@media (max-width: 640px)` icon-compaction block; it also rewrote the phone-chrome comment for the OLD v6 header (mentions lens toggle — obsolete). Main's v6.1 phone chrome (≤560px: tagline+ticker drop) is authoritative. Resolution: main's file + chime styles re-added; compaction block re-added with a v6.1-accurate comment; branch's obsolete comment rewrite discarded.
- `docs/BOARD.md`: main rewrote the cockpit section for v6.1; branch added an owner-chime bullet + speaker mention. Resolution: main's doc + adapted chime bullet.
- Mock fixtures (`web/mock/server.ts`, main): already carry `needs-owner` (mock-n3 breaker) and `action-required` (mock-n4) rows — chime acceptance runs against these plus unit stubs.
- Mute-vs-navigation contract: original scope text says "clicking the header bell toggles sound mute"; main's owner-approved bell click navigates/acks. The approved briefing resolves this: keep ack/navigation separate from mute/arming, preserve bell behavior — the separate speaker IS the approved separation, not a new design choice. Recorded in receipts + completion report; no bell behavior change.
- Scheduler: deployed service 127.0.0.1:7665, `POST /api/verify {job_id:"owner-chime", scope:"full"}`; board shows 1 active media run — wait for idle at a safe checkpoint. Status persistence via the status API with independent read-back (`/api/board`).
- CI `.github/workflows/ci.yml`: lint, typecheck, build, `npm test` on PR merge result. PR: https://github.com/mssoka/gru-command/pull/70.
- Precedents: `_bmad-output/implementation-artifacts/spec-pr76-main-integration.md` (commit 6238b97), spec-pr68-integration.md (73443a1 lineage).

## Tasks & Acceptance

**Execution:**
- [x] Create non-overwriting backup ref `backup/pr70-pre-integration-cea37b5` + receipt file -- preserve recovery point before merge -- briefing requirement.
- [x] `git merge origin/main` (df9fe01) normal merge commit -- integrate current main -- the actual integration.
- [x] `web/src/lib/board-protocol.ts` -- resolve to main's version verbatim (branch's union widening is subsumed by PR71) -- no duplicated divergent edits.
- [x] `web/src/styles/components.css` -- main's v6.1 styles + `.board-sound`/nudge/keyframes re-added + `≤640px` compaction with v6.1-accurate comment -- both surfaces styled.
- [x] `web/e2e/smoke.spec.ts` -- main's `CHROME_CONTROLS` + `'#sound-toggle'` -- phone reachability pinned for the speaker.
- [x] `docs/BOARD.md` -- main's v6.1 cockpit doc + owner-chime bullet -- docs match merged behavior.
- [x] Semantic verification of auto-merged `web/index.html` (speaker in live v6.1 header), `web/src/main.ts` (chime wiring on main's seam), `web/src/lib/board-protocol.test.ts`, `docs/UI.md` -- auto-merge is not semantic proof.
- [x] Focused local verification: eslint on touched files, `npm run typecheck`, web unit suites for chime/protocol -- integration correctness before heavy runs.
- [x] Scheduler full verification via `POST /api/verify {job_id:"owner-chime", scope:"full"}` at a safe checkpoint (media run finished) -- required project verification through shared scheduler.
- [x] Genuinely independent bounded BMAD delta review of `origin/main..HEAD` -- separate process/author from source; receipts recorded; findings triaged honestly (capability gaps reported, not faked).
- [x] Normal safe push (re-verify remote hasn't advanced) + fresh exact-final-head GitHub CI green -- publication.
- [x] Receipts under the job briefing's delivery directory -- refs, resolution inventory, tests/exits, review identities/SHA binding, CI evidence, limitations.
- [x] Persist job `owner-chime` = DELIVERED via status API + independent read-back -- stop source writes; Silas takes the ONE native whole-PR Perkins arm after idle.

**Acceptance Criteria:**
- Given the merged tree, when a NEW unresolved `needs-owner` notification arrives, then exactly one chime (or one nudge when unarmed; nothing when muted; throttled to one per 30s) sounds — and `action-required`/`fyi` never sound (unit tests with AudioContext stub, clock, storage fixtures).
- Given the merged tree, when the header bell is clicked, then the notification panel toggles and owner rows are acked/shown EXACTLY as on main (bell behavior preserved verbatim; mute lives only on the speaker, persisted in localStorage, badge still counts).
- Given the merged branch, when pushed normally, then GitHub CI passes at the exact final head SHA and PR #70 shows the merge candidate without force history.
- Given completed integration, when status is persisted, then job `owner-chime` reads DELIVERED from an independent API query and no other job's state changed.

## Verification

**Commands:**
- `npx eslint web/src/ui/owner-chime.ts web/src/main.ts web/src/lib/board-protocol.ts` -- expected: exit 0
- `npm run typecheck` -- expected: exit 0
- `npm run build` / `npm run build:web` -- expected: exit 0
- `npm run test:web -- run src/ui/owner-chime.test.ts src/lib/board-protocol.test.ts` (focused) then scheduler `npm test` full -- expected: exit 0, all pass
- `git diff --stat origin/main..HEAD` -- expected: only the owner-chime surface files beyond main
- `gh pr checks 70` / `gh run list` -- expected: green at the exact pushed SHA

**Manual checks (if no CLI):**
- Scheduler run outcome recorded with run id + exit code from `/api/verify`.
- `/api/board` shows `owner-chime: DELIVERED`.

## Implementation Notes

- Render-pipeline honesty: `bmad-build`'s `render_skill.py` scaffold does not exist in this repo; this spec follows the workflow (clarify -> plan -> implement -> review -> present) directly from the skill's step files, lane-local, per the PR68/76/77 precedent. Recorded in delivery evidence.
- The historical `owner-chime-r1` chunk review verdict INCOMPLETE (coverage exhausted on lens locatability) is superseded by PR77's whole-PR protocol; Silas runs the ONE fresh native round after this job settles — no repair pass against r1 findings here.

## Review Triage Log

Three fresh independent layers (blind-hunter, edge-case-hunter,
verification-gap) on the integration delta — headless `pi -p --no-session`, fresh
context, tools read/grep/bash, no session shared with the source author.
Receipts + exit codes under the delivery dir `layers/`. Eight findings; all
in-delta, none pre-existing on main. All fixed in commit 9bdb9a9 (web unit
332/332 after; mock e2e 25/25 incl. 390/561px phone budgets and the theme
goldens — no golden regeneration needed, the speaker sits within the 2%
snapshot tolerance).

| # | finding (layer) | verdict | disposition |
|---|---|---|---|
| 1 | speaker a dead no-op when Web Audio absent; title keeps promising enable (blind, edge#3) | confirmed | fixed: permanent absence flagged; speaker disables itself with honest tooltip; test pins disabled+title+aria |
| 2 | needs-owner row acked on another device still rings (edge#1) | confirmed | fixed: notify() takes the notification; ackedAt/resolvedAt rows are ignored — handled history never fresh audio; toasts keep main's semantics; test added |
| 3 | setMuted flips state before storage write — throw diverges UI (edge#2) | confirmed | fixed: write-before-flip; fail-loud preserved (theme contract); divergence test added |
| 4 | throttle reads wall clock — jump double-rings, rollback silences (edge#4) | confirmed | fixed: monotonic performance.now default; deterministic skew test (fails on the old Date.now default) |
| 5 | failed first-gesture arm removes listeners — transient failure disarms forever (edge#5) | confirmed | fixed: listeners persist until armed or permanently unavailable; speaker click retries; retry test added |
| 6 | production wiring in main.ts unverified in CI (vgap#1) | confirmed, partial | startup guard pinned in CI (index.html #sound-toggle presence/adjacency); handler-adoption gap honestly recorded as a limitation (no CI test drives the real handler; e2e not in CI — adding a mid-session needs-owner mock control would expand scope beyond the chime) |
| 7 | phone-fit guarantee rests on e2e outside CI (vgap#2) | confirmed | pre-existing repo property (same for main's bell/theme); limitation recorded; mock e2e 25/25 green |
| 8 | storage.setItem throw path unhandled in click listener (edge#2 secondary) | confirmed | subsumed by fix 3 (same reorder) |

Layer identity honesty: the three reviewers are separate headless `pi`
processes with fresh contexts and read-only tools, launched from prepared
prompt files (preserved in the delivery dir) — genuinely separate from the
source author, but not the native Perkins arm: Silas's ONE fresh whole-PR
round remains the review gate of record after this job settles.
