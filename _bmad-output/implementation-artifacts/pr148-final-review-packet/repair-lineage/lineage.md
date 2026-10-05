# Browser-correction lineage (original RED → green)

This is the complete chain from the required gate's RED to its GREEN. Every
run is bound in the ledger; the complete outputs are the `.output.txt` files
in this directory. Nothing was re-run merely to recover logs, and no RED was
erased.

## 1. Original RED — `wizard-bmad-browser-consumer` at `81d3f10`

Run `48f31148-8d15-4b42-b0ab-59123eec61fb`, exit 1, ledger 40053, output
24833 B / `7587a6af65c3a2a485f724d27de6cb1aa878e2a4ea03fcea9bd54074896f4aa7`
(`original-browser-red.output.txt`). Web unit 408/408 passed; Playwright
5/51 failed:

1. `smoke.spec.ts` reflow ×2 — `.tool-line` with the long stress token
   resolved to a hidden element.
2. `smoke.spec.ts` themes + `real-server.spec.ts` themes — `chat-light` and
   `real-chat-light` darwin baselines over the 2 % allowance (7–8 % diff).
3. `working-flavor.spec.ts` — `second.slice(0, -1)` was the empty string.

Diagnosis was performed from this complete output plus the Playwright error
contexts and the repository history before any edit.

## 2. Repairs and each intermediate RED

- **Mock turn-hold** (`web/mock/server.ts`): the `/__turn-hold` parking branch
  left the 45 ms tick interval running, so `finish()` fired one tick later and
  the busy chip cleared before the 4 s rotation — hence the empty slice. The
  mock now clears the interval when parked; reset settles a parked turn.
- **Service-band expansion** (`web/e2e/smoke.spec.ts`): the clean-chat clause
  (4f4ebc8, owner 2026-09-23) renders tool lines in a collapsed band (its own
  unit-tested behavior; the first smoke test already taps it). The stress
  helper now expands the band before the visibility assertions and the reflow
  sweep, restoring the intended long-token measurements.
- **Theme baselines**: snapshots predate the approved owner band/chime UI
  (last written 2026-09-27); see `png/PROVENANCE.md`. Regenerated
  deliberately via the committed `wizard-bmad-snapshot-update` scope — first
  `changed` mode (run `b40b49d4`: 3 files), then `=all` (run `8593dbef`: all
  four, because the real-dark baseline was silently left stale by changed
  mode).
- **RED 1 — run `e31c915b` at `554e51c`** (exit 1,
  `intermediate-red-554e51c.output.txt`): the geometry sweep failed for
  21/100 approved phrases (the strip wrapped, pushing controls to a second
  line) and the clipboard attach leg sent inside the composer's busy-upload
  guard. Repair: console/tablet widths pin `flex-wrap: nowrap` for
  `.chat-context` (phone keeps its own-row wrap); attach legs wait for the
  busy placeholder to clear before sending.
- **RED 2 — run `eee1db6e` at `c275cfb`** (exit 1,
  `intermediate-red-c275cfb.output.txt`): with nowrap alone, a long phrase
  shrank the CONTROLS themselves until their labels wrapped (button boxes
  changed between the two measurements). Repair: the controls are
  non-shrinkable (`flex: none`) at console/tablet widths so only the status
  chip shrinks and ellipsizes; stylesheet pin added in
  `web/src/ui/chat-working-flavor.test.ts`.
- **RED 3 — run `73b2242d` at `d93ba27`** (exit 1,
  `intermediate-red-d93ba27.output.txt`): the desktop and tablet sweeps
  passed for the first time; the phone step timed out tapping `#gru-fab`
  because the tablet drawer stays open across the width change and the open
  sheet covers the FAB. Repair: tap the FAB only when the sheet is closed.

## 3. GREEN and final-head gates at `1bac32d`

- `wizard-bmad-browser-consumer` run `8473ecde-…`, exit 0, ledger 40521 —
  web unit 409/409, Playwright 51/51.
- `wizard-bmad-retry` run `5f642709-…`, exit 0, ledger 40553 — 58/58.
- `full` run `4261b840-…`, exit 0, ledger 40674 — backend 1783 passed /
  12 skipped; web 409.
- CI `37087368772` success at `1bac32d`.

## 4. Fresh-main integration

Merge commit `5c0d1d3` (parents `1bac32d` + `origin/main 5d56194`,
PR #149) — normal, history-preserving, auto-merged; see
`../verification/current-evidence.md` for the merge file list and the
pre-check qualifications.

## 5. Post-merge browser corrections (r5/r6)

The post-merge browser runs came back RED twice on the two `themes`
whole-page captures with the owner band missing while the DOM contained it.
Capture analysis (per-region alignment, diff and error-context comparison)
located the mechanism: the shell is page-scrollable and composer
interaction scrolls it, so the captures depended on the page scroll origin —
at ~20px every content pane sat 20px higher with the rest byte-aligned, and
at a larger offset the band's sticky head stayed pinned while its rows
scrolled away. Repairs: r5 (`1b9fafd`) synchronizes the tests on the band's
authoritative rows before the screenshot; r6 (`faa69d6`) pins
`window.scrollTo(0, 0)` before each capture. Post-merge green set: focused
`be16f221`, full `1744e502`, browser `5360af3c`.

## 6. Final independent review round and repairs (r2)

Three fresh tracked review jobs (`review-round/`) ran the installed
bmad-review lenses against packet v2 and returned 13 + 3 + 6 findings.
Genuine defects were repaired at `1bea5c9` and `9ba8637`: deterministic
managed-block refusal; transient fresh-installer output semantics (reuse
unchanged); per-object missing-path attribution; preflight message hygiene;
ancestor-refusal installer hints; git-toplevel errno discrimination; plus
the review-identified regression coverage (reuse content validators,
control-file refusals, validateRepo refusals, hint-less fallback, denied
manifest read, ENOTDIR/rethrow arms, e2e toggle guard, direct mock
turn-hold coverage) and the README wording fix. One focused RED
(`eef4dd0c` at `1bea5c9`) exposed the pre-action ancestor-check ordering and
was followed by the `9ba8637` follow-up; then focused `02a41d78`,
typecheck `5e262d98`, full `443c4247` and browser `59980235` all passed.
Per-finding dispositions: `../claims/final-review-dispositions.md`.
