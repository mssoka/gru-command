# Verification evidence (as frozen at packet v1)

All runs below execute through the authenticated `/api/verify` scheduler with
committed declared scopes, one outstanding request per lane, unique
pre-opened raw-NDJSON and decoded sinks flushed to EOF; each receipt binds
the nested `completed.outcome` (exitCode/ok), the actual clean SHA,
`trackedDirty`, full output bytes/SHA-256, and the ledger terminal row.
Copies of the complete outputs and receipts are in this directory.

## Current green set — product head `1bac32d` (pre-merge)

| scope | run | exit | sha | output | ledger seq |
|---|---|---|---|---|---|
| `wizard-bmad-retry` | `5f642709-71cd-4722-9142-e3180e32fdb3` | 0 | `1bac32d` | 7361 B / `6795bdb904302fa6888bff525f4fb04658960a58a730998e63e8b0831bcab9b3` | 40553 |
| `full` | `4261b840-9b0d-40d9-938a-e1d527afe341` | 0 | `1bac32d` | 111477 B / `49265cbadf761913a37ba98ef2ec845301e93aa56c9dcdc07532388cd7c919dd` | 40674 |
| `wizard-bmad-browser-consumer` | `8473ecde-e10f-4c7c-b5c5-d8ea9c2a643a` | 0 | `1bac32d` | 14834 B / `91ef95bff47efc596b45c15bbeba5afe9e02ade7065977a3588dc6650b8f56ae` | 40521 |

- `wizard-bmad-retry` — `npm run build && node tools/patch-vitest-rpc-timeout.mjs
  && npx vitest run test/bmad-onboarding.test.ts test/wizard-interactive.test.ts
  test/wizard.test.ts test/suite-shape.test.ts`: 4 files / 58 tests passed.
- `full` — `npm test` (lint + typecheck + build incl. policy integrity +
  vitest + web): backend 106 passed/4 skipped files, 1783 passed/12 skipped
  tests; web 43 files / 409 tests passed.
- `wizard-bmad-browser-consumer` — `node tools/patch-vitest-rpc-timeout.mjs &&
  npm run test:web && npm run e2e`: web unit 43 files / 409 passed; Playwright
  3 projects, **51/51 passed**, including the previously RED reflow, themes,
  working-flavor geometry and attach legs.
- CI at `1bac32d`: GitHub Actions run
  [37087368772](https://github.com/mssoka/gru-command/actions/runs/37087368772)
  — success (Full suite, Node 22). Metadata copy: `ci.json`.

## Fresh-main integration (product head `5c0d1d3`)

`git merge origin/main 5d56194` was performed in-lane, normally and
history-preserving (merge commit `5c0d1d3`; parents `1bac32d` + `5d56194`).
It auto-merged; the two files both sides touched are
`.gru-command/worktree.toml` (union of `[verify]` scopes; TOML parses, 29
scopes) and `test/suite-shape.test.ts` (union of pin updates). A static
re-derivation of all 111 pins against the merged test files reports zero
mismatches — recorded here as a pre-check only, NOT as verification coverage.

Because the merge changed the product head, the pre-merge green set above is
**not** treated as clearance for the merged head. The merged head's own
scoped runs are executed through `/api/verify` and appended to this packet in
an evidence-only follow-up commit (no product bytes change); their receipts
are also reported in the PR body and the completion report.

## Qualifications (preserved, not erased)

- **Original RED (browser-consumer at `81d3f10`):** run
  `48f31148-8d15-4b42-b0ab-59123eec61fb`, exit 1, 24833 B /
  `7587a6af65c3a2a485f724d27de6cb1aa878e2a4ea03fcea9bd54074896f4aa7`, ledger
  40053 — web unit 408/408, e2e 46/51. Full output and repair chain in
  `repair-lineage/`.
- **Intermediate REDs during the correction** (each preserved in
  `repair-lineage/`): `e31c915b` at `554e51c` (exit 1), `eee1db6e` at
  `c275cfb` (exit 1), `73b2242d` at `d93ba27` (exit 1). No unchanged-RED
  replay: each run followed a committed diagnosis/repair.
- **Never-started scheduler requests** (typed `lock_wait_timeout`; preserved
  receipts in the lane's ignored gate-prep, never counted as coverage):
  typecheck r2 at `81d3f10`; `wizard-bmad-retry` r1 at `81d3f10`; `full` r1 at
  `81d3f10`; `wizard-bmad-snapshot-update` r2 at `8b556e1`; browser r1 at
  `c275cfb`; browser r1 at `1bac32d`. Also one HTTP 400 intake rejection for a
  scope name over the 32-char limit (renamed; never started).
- **Historical pre-correction PASS at `81d3f10`** (focused `aeffca7f`, full
  `e8f776b7`) is retained separately from this evidence set and must not be
  read as clearance for the browser gate that followed.
- The earlier FULL RED at `2e837de` (`5dfe4bea`, 7 per-test 30 s timeouts,
  host-load class) and its cross-lane diagnosis are preserved in the lane
  spec's continuation notes and the operations investigation archive; they
  are not relabeled or re-run for logs.
