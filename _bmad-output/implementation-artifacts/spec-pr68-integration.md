---
title: 'PR68 bounded integration after owner merged PR71/PR77'
type: 'integration'
created: '2026-09-27'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '05f897220ba21f7b13b0737f92a9802cea46cd5a'
target_main: '4845b1a42e4a77e6b3d8daf7d8621f49e8ac1188'
---

# PR68 bounded integration after owner merged PR71/PR77

## Intent

<frozen-after-approval reason="owner-approved briefing pr68-approved.md (parallel-pending-heists-20260927) — no restatement needed">
Owner resumed pending heists in parallel. Integrate origin/main (`4845b1a`)
INTO `gru/board-ux-v6-1-rulings` (head `05f8972`, PR #68, OPEN/CONFLICTING)
with a normal merge commit that preserves BOTH feature sets: the approved
v6.1 display rulings (no desktop Chat/Board toggle, CREW label, heist/minion
display vocabulary, complete dark-mode surfaces, labeled chip rail) AND
main's #71 wake/routing split (FOR YOU = owner decisions, NEEDS GRU =
machine work) plus #77 review work. Resolve conflicts semantically, verify,
push normally, obtain exact-head CI. Historical failed run 35937797053
stays recorded. NOT in scope: merging PR68, deploy, new redesign,
classifier work, API/domain renames, removing accessibility or mobile
FAB/tabs (<900px), repairing all historical findings, force-push/rebase.
The newer #71 routing split wins over the original briefing's dated
"NEEDS YOU" band examples.
</frozen-after-approval>

## Code Map

Investigation (2026-09-27, this lane):

- Merge dry-run (`git merge-tree --write-tree 05f8972 4845b1a`): TWO text
  conflicts (`web/src/ui/board.ts` — one header-comment hunk only;
  `docs/BOARD.md`) + FOUR binary golden conflicts
  (`web/e2e/{smoke,real-server}.spec.ts-snapshots/{chat,real-chat}-{light,dark}-darwin.png`,
  changed on BOTH sides: ours = v6.1 command bar, main's = #71 service
  band). Auto-merges need semantic verification, not trust:
  `web/src/ui/board.test.ts`, `web/src/lib/board-rail.ts`(+test),
  `web/src/styles/components.css`, `web/index.html`, `web/e2e/{smoke,real-server}.spec.ts`.
- v6.1 rulings live in `web/src/lib/board-vocabulary.ts` (BOARD_WORDS,
  heistCount) applied at render boundaries in `web/src/ui/board.ts`
  (band counts, heist/minion row+lane meta, crew rail, labeled tracker
  fields), `web/src/ui/rail-tabs.ts` (CREW tab), `web/src/main.ts` +
  `web/src/ui/command-bar.ts` + `web/src/lib/command-ticker.ts` (no toggle,
  no ActiveView), `web/src/styles/components.css` + `tokens.css` (dark
  surfaces, chip rail), `web/index.html` (no tabs nav, CREW labels).
  Main did NOT touch main.ts/command-bar.ts/rail-tabs.ts/command-ticker.ts
  since base — those land whole.
- Main's board evolution (#71): `board-bands.ts` BAND_LABELS['needs-you']
  = 'NEEDS GRU'; FOR YOU notification section + wake routing in
  `board.ts`; `board-wakes` chip in `index.html`; `board-rail.ts` tracker
  detail "N needs Gru"; service band in `chat.ts`/CSS; `mock/server.ts`
  FOR YOU/NEEDS GRU incidents.
- `test/suite-shape.test.ts`: main's PINS table takes cleanly (our branch
  never touched `test/`); must still equal the merged `test/` listing.
- Verification: `npm test` = lint+typecheck+build(+perkins verifier)+
  backend vitest+web unit; heavy runs via scheduler `POST /api/verify
  {job_id:"board-ux-v6-1-rulings", scope:"full"}` on 127.0.0.1:7665
  (bearer from service config), lane declares `[verify] full = "npm test"`
  in `.gru-command/worktree.toml`. `npm run e2e` (Playwright, browsers
  present) regenerates the four goldens — deliberate re-capture of the
  merged tree, then eyeball-diff against both parents' captures; never
  blind refresh. CI (`.github/workflows/ci.yml`) runs `npm test`, no e2e.
- Status API: `POST /api/jobs/{id}/status` (valid: delivered) on the
  deployed service; read-back via `/api/board`.
- Historical CI 35937797053 failure = env-dependent backend tests
  (perkins-builtin-review/bmad-onboarding needing uv, install-one-line),
  not the web delta; stays recorded, superseded by exact-head CI.

## Tasks

1. [x] **Backup + merge** — non-overwriting `backup/pr68-pre-integration-05f8972`
   ref; `git merge origin/main` (normal, no rebase/force).
2. [x] **Resolve text conflicts** — board.ts header comment (union: labeled
   heist counts + NEEDS GRU band), docs/BOARD.md (v6.1 vocabulary ∩ #71
   routing semantics).
3. [x] **Semantic pass on auto-merges** — every v6.1 ruling survives onto
   main's evolved board.ts (heistCount band counts beside NEEDS GRU label,
   heist/minion meta, CREW rail, labeled tracker fields, dark surfaces);
   main's FOR YOU section/wakes chip/service band survive intact; smoke +
   real-server e2e text updated for both (NEEDS GRU × heists).
4. [x] **Regenerate 4 goldens** via `npm run e2e` on the merged tree;
   verify diffs show exactly toggle-removal + service-band, both themes.
5. [x] **Focused suites** — web unit (board*, board-vocabulary,
   theme-surfaces, rail-tabs, command-ticker, palette-contrast, chat-service-band),
   board bands/signals/protocol, suite-shape.
6. [x] **Full gate via scheduler** — one `POST /api/verify` scope `full`.
7. [x] **Captures** — light+dark × desktop+mobile of the changed views
   (command bar, chip rail, board bands, crew rail) via agent-browser.
8. [ ] **Independent BMAD review of the integration delta** — fresh
   layers, receipts under the delivery dir.
9. [ ] **Push + exact-head CI + DELIVERED** — normal push, CI green on
   pushed head, delivery receipt + status API delivered + /api/board
   read-back; then return for branch-idle native Perkins gate.

## Acceptance Criteria

- AC1 (ancestry): merge commit has both `05f8972` and `4845b1a` as
  parents; no conflict markers; each resolution maps to ruling/source.
- AC2 (rulings survive): merged bundle renders CREW tab, heist/minion
  vocabulary, labeled chip rail, no desktop toggle, mobile FAB/tabs
  intact; dark+light both first-class (captures prove it).
- AC3 (#71/#77 intact): FOR YOU/NEEDS GRU routing, wakes chip, service
  band, perkins-review behavior untouched by the display delta; backend
  identities (lane/job/agent) never renamed.
- AC4 (green): lint/typecheck/build/test:web + focused suites exit 0;
  scheduled full gate recorded (failures stay failures); e2e exits 0 with
  regenerated goldens verified against expectations.
- AC5 (review): fresh independent BMAD review of the delta; genuine
  integration findings fixed/escalated; no silent backlog expansion.
- AC6 (push/CI): normal push, fresh CI on exact head, provider facts
  recorded; PR stays OPEN (owner merges).
- AC7 (delivery): job `board-ux-v6-1-rulings` reads delivered from
  /api/board; full receipt under
  `~/.gru-command/briefings/parallel-pending-heists-20260927/pr68-delivery/`.

## Implementation Notes

- Keep >=36 GiB free (currently ~148 GiB); serialize heavy runs via the
  scheduler; one e2e pass; no busy-polling the 900-frame render holder.
- Existing unrelated findings become explicit follow-up notes, never
  bundled fixes.
- Bundle grep: no user-facing " JOBS<"/"LANE "/"AGENTS (" strings.
- Merge commit `39f68e4796aaf6c39316f9fcd728868d8e41949a` (parents 05f8972
  + 4845b1a), tree clean; backup ref `backup/pr68-pre-integration-05f8972`.
- Delta vs main is EXACTLY docs/ + web/ + lane spec (26 files) — zero
  backend changes (git-proven), so backend gate outcomes equal main's.
- lint/typecheck/build/build:web exit 0 (build includes perkins verifier).
- Web unit: 311/311 pass with `--no-file-parallelism`; under default
  parallel pool 3 liveness/timing tests failed on this loaded host
  (900-frame render active) and pass serially — same class pr77 recorded.
- suite-shape 2/2. E2e 44/44 incl. 4 regenerated goldens; goldens
  pixel-verified via vision reads (no toggle; TRACKERS labeled groups
  HEISTS/PRS/MINIONS; NEEDS GRU/IN FLIGHT/SETTLED + heist counts;
  CREW (5); dark surfaces complete — user bubble #182033 navy, cream
  hits were text ink; mobile: board → crew rail stacked, chat hidden
  until FAB, 0 toggle tabs, 11 labeled tracker fields, wakes chip).
- Scheduled full gate run `85695afd-8d92-4c30-8e7b-e24c764f0488` at
  39f68e4 (tracked-clean, 14 workers, 1068s): FAILED exit 1 — 22 files /
  55 tests; cause triage: 44 explicit timeouts + 4 "service never
  listened" + fetch/spawn failures; 2 bmad-onboarding assertion
  failures are the SAME tests/messages as historical CI run 35937797053
  (pre-merge, different machine class). Backend code byte-identical to
  main (delta = web/docs only) → failures are main-under-host-load, not
  merge-introduced. Failure preserved verbatim in delivery dir; per
  pr77 precedent the authoritative exact-head gate is GitHub CI on the
  pushed head (isolated runner).
- Row meta renders uppercase via existing CSS text-transform (all row
  meta — repo/branch too); source strings are lowercase heist/minion —
  words correct, case follows pre-existing v6 style.

## Open Questions

None — the owner briefing pre-authorizes target, strategy, bounds,
verification and push; escalation only for genuine semantic/permission
decisions the contracts cannot settle.

## Verification

**Commands:**
- `npm run lint && npm run typecheck` -- exit 0
- `npx vitest run web/src test/suite-shape.test.ts` (focused) -- exit 0
- `npm run e2e` -- exit 0, goldens regenerated + inspected
- `POST /api/verify {scope:"full"}` via scheduler -- completed run
  recorded (green or preserved failure with baseline comparison)
- `gh run watch` on pushed head -- CI SUCCESS

**Manual checks (if no CLI):**
- Four breakpoint captures (light/dark × desktop/mobile) show the changed
  views per rulings 1–5; goldens diff shows only expected UI deltas.
