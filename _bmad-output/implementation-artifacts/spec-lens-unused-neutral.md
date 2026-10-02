---
title: 'Neutral unused lens pills'
type: 'bugfix'
created: '2026-09-30'
status: 'in-review'
route: 'dispatch'
baseline_commit: 'c54bfbf89727bacfd27a27db65a9fab681c19c3e'
review_loop_iteration: 0
context:
  - docs/BOARD.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A whole-PR round records a lens the lead never ran as `done` with the canonical note `not used — lead-owned whole-PR review`. The board renders every `done` lens as a green `✓` pill, so settled unused lenses read as passed specialist coverage. The owner's screenshot shows round 5 (`3/7 LENSES RAN · 4 NOT USED`) with all seven pills green and ticked, and approved the fix: "gray and no checkmark. it is. go".

**Approach:** Add one presentation classifier that maps the established `done` + canonical-notused record to `unused`. Render `unused` as a neutral gray pill with no checkmark, carrying concise `not used` wording and the note as its tooltip; reuse the same classifier in `roundSummary` so counts and chips cannot disagree. No backend, policy, or ledger change.

## Boundaries & Constraints

**Always:** Keep all seven lens pills visible. Keep executed/clean, live, pending, blocker and error presentation unchanged (errors stay alert with evidence and `×N` attempts). Make unused pills neutral gray in light and dark themes with no success/check styling, legible via concise wording and the note tooltip, and distinguishable from pending. Reuse the existing `done` + `note.startsWith('not used')` signal. Preserve the current theme, typography, pill shape, mobile wrapping and expanders.

**Never:** No schema/ledger/backend/lifecycle change. No mandatory-seven-lens or owner-specific policy inference from notused. No new dependency. No prose-only downgrade (a pending/error record mentioning "not used" keeps its state). No reinterpreting errors as unused or green. No test weakening, timeout change, or invented green evidence. Do not touch the unmerged #138 board-section-truth branch/tree or absorb staged board work.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Unused lens | `done` + note `not used — lead-owned whole-PR review` | Gray `pp-chip--unused` pill, marker `—`, text `— <lens> · not used`, tooltip = note; counted `unused`/not ran | N/A |
| Executed clean lens | `done` + `clean — …` note | Unchanged green `✓` (`pp-chip--done`) | N/A |
| Legacy record | `done` + null note | Unchanged green `✓` | N/A |
| Blocker lens | `done` + `blocker — …` | Unchanged alert override (`board-lens--blocker`) | N/A |
| Prose false positive | `pending`/`live`/`error` whose note contains "not used" | Keeps actual state (○/◉/✕); prose is never authority | N/A |
| Error with attempts | `error` + attempts/timeout note | Unchanged alert `✕`, `×N`, evidence tooltip; counted in `ran` and `failures` | N/A |
| Unknown state | Unrecognized `state` string | Unchanged `?` + park tone | N/A |

</frozen-after-approval>

## Code Map

- `web/src/lib/board-protocol.ts` -- `LensChipView` (line 10); `lensChipTone` (line 519). Add `lensChipState(lens)`: `done` + `note.startsWith('not used')` → `unused`, otherwise the recorded state. Give `lensChipTone` an `unused` case returning `pp-chip--unused`.
- `web/src/lib/board-signals.ts` -- `roundSummary` (line 32) computes `unused` inline with the same predicate; switch it to the classifier. `done`/`used`/`ran`/`failures` semantics unchanged.
- `web/src/ui/board.ts` -- `LENS_STATE_LABEL` (line 79); `lensChips` (line 752). Add `unused: '—'`; classify each chip once and use the result for the tone class, icon, `· not used` wording and note tooltip.
- `web/src/styles/components.css` -- `.pp-chip--*` tones (lines 59-64). Add `.pp-chip--unused` reusing the `--park` fill / `--ink` text (the light/dark flip comes from tokens; no new palette).
- `web/src/lib/board-protocol.test.ts` -- classifier + tone tests (line 242 block).
- `web/src/lib/board-signals.test.ts` -- `roundSummary` regression coverage (existing suite).
- `web/src/ui/board.test.ts` -- DOM regression: seven-pill/4-unused round; separate 4-unused/3-errors round; mixed-state round.
- `docs/BOARD.md` -- per-lens chip vocabulary (line 134). Add the unused pill to the list.
- Do not change: `src/` backend/policy/ledger, `tokens.css`, `jobSignal` semantics, board layout/expanders, existing test assertions.

## Tasks & Acceptance

**Execution:**
- [x] `web/src/lib/board-protocol.ts` -- add `lensChipState` + `unused` tone case -- one classification every lens surface reads.
- [x] `web/src/lib/board-signals.ts` -- `roundSummary` uses the classifier -- counts cannot disagree with chips.
- [x] `web/src/ui/board.ts` -- classified icon/class/wording/tooltip in `lensChips` -- the visible fix.
- [x] `web/src/styles/components.css` -- `.pp-chip--unused` neutral fill -- gray in both themes, no success token.
- [x] `web/src/lib/board-protocol.test.ts`, `web/src/lib/board-signals.test.ts`, `web/src/ui/board.test.ts` -- deterministic classification + DOM tests -- fail on the old all-green renderer, pass after.
- [x] `docs/BOARD.md` -- vocabulary line -- docs match the rendered states.

**Acceptance Criteria:**
- Given the screenshot's seven-lens round (3 executed + 4 canonical unused), when the round is expanded, then all seven pills render; exactly the four unused are gray (`pp-chip--unused`) with no `✓`/success styling, say "not used" and keep the note as tooltip, while blind/edge/tests keep the green `✓`; the summary reads `3/7 lenses ran · 4 not used`.
- Given a mixed round with unused, clean, pending, live, blocker and error lenses, then each retains a distinct honest state; unused is not passed and not failed; timeouts stay alert with attempts and evidence.
- Given a done lens without a canonical notused note, or a legacy record with null note, then normal done presentation remains; given a pending/error record whose prose mentions "not used", then prose alone cannot downgrade the actual state.
- Given light/dark themes, mobile/desktop wrapping and repeat snapshot pushes, then neutral pills stay gray/non-success, readable, non-overflowing, and expose lens name + notused reason, with round totals agreeing.
- Deterministic DOM/helper tests fail on the old renderer (all green/all ticks) and pass after, including the four-unused/three-errors case separately; existing assertions, failures and recorded counts are preserved.

## Implementation Notes

- Dispatch briefing (job `lens-unused-neutral`) is the approval for this spec: checkpoint resolved as "Approve and continue" with the owner's quote "gray and no checkmark. it is. go". Implementation proceeds in this single minion lane; the completion/fix/verification/review loop is Silas-owned per the briefing.
- Decision (within the approved envelope): unused chips show the visible wording `· not used` plus the note as tooltip; marker `—`; the neutral class is `pp-chip--unused` reusing the `--park` token so light and dark follow the existing palette.
- The canonical signal stays exactly `state === 'done' && note !== null && note.startsWith('not used')` (same predicate `roundSummary` used before); no tightening, so existing records stay backward-compatible.
- Changed: `board-protocol.ts` (`lensChipState` + `unused` tone), `board-signals.ts` (`roundSummary` reads the classifier), `board.ts` (`LENS_STATE_LABEL.unused = '—'`; `lensChips` class/icon/wording/tooltip), `components.css` (`.pp-chip--unused`), three test files, `docs/BOARD.md`. Nothing outside lens presentation touched.
- Surprise: none in the renderer; the existing `roundSummary` predicate and the chip renderer were the only two consumers, so the shared classifier is a two-call-site change plus tests.
- Matrix audit (structural): every I/O matrix row has at least one covering test -- unused = render + classifier tests; clean/legacy/blocker/error-with-attempts = new DOM tests plus existing suite; prose false positive = classifier + `roundSummary` tests; unknown state = classifier + tone tests. Execution of these tests is deferred to the authenticated verify scope (see Verification); the structural audit cannot substitute for a passing run.
- Repeat-push coverage: the first DOM test re-renders the same snapshot with the job/round still expanded and re-asserts 4 unused gray / 3 green -- no stale green after a push.
- Review routing: the embedded bmad-build review layers (context-free subagents) are not available in this lane, and the dispatch contract assigns the completion/fix/verification/review loop to Silas with independent final-diff review and native Perkins READY as gates; this lane ran a manual adversarial self-review of the staged diff instead (one wrong blocker-class assertion was found and fixed before commit). Spec status stays `in-review` until that independent loop and the real test run complete -- no `done` or delivery-ready claim from unrun tests.
- Completion-loop mechanical CI repair (source-only; no executable product checks in-lane): exact-head CI run `36694913645` (job `109820449406`, PR #143, checked-out merge ref `09ba700f4fbe0fdb34de73b1d240beec65744857` = `5ed7ef1` + `c54bfbf`) failed only `test/suite-shape.test.ts:123` file-set equality -- `test/owner-actions.test.ts` existed on disk but was absent from PINS, so the per-file count loop never ran. Full capture: ignored ops bundle `silas-sweep-20260930T1221/lens-unused-neutral-ci-36694913645.log`, 887 lines / 136177 bytes / sha256 `18fd8f6dfefd723600595224768d014c95030b3eaa854aad78939fcdc864cc3c`; backend summary 1449 passed / 1 failed / 9 skipped, web suite not reached; lint, typecheck, build and resource pin passed earlier in the same job.
- Repair (j-414 inherited main-side drift, mechanical): reconciled ALL 97 `test/*.test.ts` files against the gate's own static regex `/\bit\(|\bit\.skipIf\(/g` by source reads (never collected vitest counts): `owner-actions.test.ts` pinned at `8` static registrations (28 runtime cases loop over one `it(`), `github-poll.test.ts` `22` -> `24`; all other 95 pins already matched, no orphans and no `.each` violations. No assertion, test, matcher, timeout or file-set gate changed; the unused-lens regression tests and theme/UI intent are untouched.
- Integration seam #136 (`gru/durable-blocked-followthrough`, draft): it modifies both `test/owner-actions.test.ts` (+85/-28) and `test/suite-shape.test.ts` (+5/-1). If it merges first, owner-actions' static count will likely grow -- re-reconcile the pin against the merged tree; do not copy that lane's values into this one.
- Integration (backlog admission2, 2026-10-02): fetched fresh `origin/main` `6a00f4e50e7ae970915a9a534c142c1f8a45b57d` (matches the delivered preflight; PR151 native-compaction-wait) and normal-merged it with `ort` -- merge commit `d50eeba72384a2d89c8c7f432c21eae778d4bd18`, parents `5118817` + `6a00f4e`; zero conflicts, no rebase/reset/force. `.gru-command/worktree.toml` PR151 scopes (`native-compaction-wait`, `native-compaction-wait-baseline` with its RED-by-design baseline and preserved pointer file) landed whole -- no union repair needed because this branch had no side-diff against the merge base for that file. Post-merge static suite-shape audit (gate's own regex `/\bit\(|\bit\.skipIf\(/g`, source reads only, never vitest): 98 files / 98 pins / 0 drift / 0 orphans (supervisor pin 52 matches main's grown suite). Lens-fix files are byte-identical to `5ed7ef1` except `components.css`, which additionally carries main's absorbed PR139 chat-reflow additions around the intact `.pp-chip--unused` rule (re-verified: `--park`/`--ink` tokens present in both themes). The final MAIN-to-FINAL diff (`origin/main`..HEAD) is exactly the 9 lens/spec files. No product test/build/lint/typecheck/browser run in this phase -- the pinned admission2 scope and baseline RED/Gap declarations are in the ignored handoff `_bmad-output/implementation-artifacts/backlog-main-integration-20261002/implementation-handoff.json`.

## Verification

**Commands (safe local, pre-admission) -- all run green on the working tree:**
- `npm run typecheck` (root `tsc --noEmit -p tsconfig.test.json`) -- clean.
- `npm run lint` (eslint .) -- clean.
- `npm run build -w web` (`tsc --noEmit` over `src`/`mock`/`e2e` + vite build, CSS compiled) -- clean.

**Product tests:** deferred to the authenticated `/api/verify` full scope through Silas -- the briefing forbids direct vitest/browser runs. Current pacing run/control reconciliation must clear first plus >=36GiB free and a media/process-safe checkpoint; no delivery-ready claim until the real suite runs.

**Exact-head CI:** run `36694913645` at `5ed7ef1` failed mechanically in `suite-shape` only (file-set equality; record above). The pin repair is the follow-up commit on this branch, so a fresh CI run at the repaired head is required; no product check of any kind was executed in-lane for this repair.

**Manual/visual:** light + dark board captures with a seven-lens/4-unused fixture, read by Gru or a genuine vision reviewer; mobile/desktop wrap check.
