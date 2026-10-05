# Verification evidence and qualifications (packet v3)

All runs execute through the authenticated `/api/verify` scheduler with
committed declared scopes, one outstanding request per lane, unique
pre-opened raw-NDJSON and decoded sinks flushed to EOF, and receipts that
bind the nested `completed.outcome` (exitCode/ok), the actual clean SHA,
`trackedDirty`, full output bytes/SHA-256, and the ledger terminal row.
Complete outputs and receipts for every run are copied under this
directory's stage folders.

Hygiene note: every copy here has the personal home prefix replaced with
`<HOME>` / `<LANE_WORKTREE>` (SPEC ruling 8); see the packet README. The
receipts themselves carry the original `output_sha256` bindings.

## Head chain

`5c0d1d3` (fresh-main merge) → `1b9fafd` (browser r5 band waits) →
`faa69d6` (browser r6 scroll pin) → `1bea5c9` (final-review r2 repairs) →
**`9ba8637`** (r2 follow-up: ancestor hints; the frozen product head). Packet
commits in between (`255ef07`, `7330e44`, `821ead3f`) add only this packet
directory; `manifest.json.head_chain` records each role.

## Stage 1 — pre-merge green set at `1bac32d`

| scope | run | exit | output | ledger |
|---|---|---|---|---|
| `wizard-bmad-retry` | `5f642709-71cd-4722-9142-e3180e32fdb3` | 0 | 7361 B / `6795bdb9…` | 40553 |
| `full` | `4261b840-9b0d-40d9-938a-e1d527afe341` | 0 | 111477 B / `49265cba…` | 40674 |
| `wizard-bmad-browser-consumer` | `8473ecde-e10f-4c7c-b5c5-d8ea9c2a643a` | 0 | 14834 B / `91ef95bf…` | 40521 |
| CI `37087368772` | at `1bac32d` | success | — | — |

## Stage 2 — post-merge green set at `faa69d6`

| scope | run | exit | output | ledger |
|---|---|---|---|---|
| `wizard-bmad-retry` | `be16f221-1982-4463-a36b-d5ac62bfd7f8` | 0 | 7371 B / `3d7ac469…` | 41584 |
| `full` | `1744e502-4244-4d09-9361-0de64763f457` | 0 | 113166 B / `9fe26c56…` | 41539 |
| `wizard-bmad-browser-consumer` | `5360af3c-6ba4-44f7-aff5-894ddd732212` | 0 | 15041 B / `68249f8d…` | — |

## Stage 3 — repaired green set at `9ba8637`

| scope | run | exit | output | ledger |
|---|---|---|---|---|
| `wizard-bmad-retry` | `02a41d78-5b47-426c-9c29-3130c6b8f397` | 0 | 9047 B / `3ba27534…` | — |
| `typecheck` | `5e262d98-579a-4749-b989-7a2d4c8d5187` | 0 | 69 B / `94cfb586…` | — |
| `full` | `443c4247-c724-47fe-b80a-de0ab5b8f1bd` | 0 | 110741 B / `14d2c787…` | — |
| `wizard-bmad-browser-consumer` | `59980235-123b-47a9-a5d0-9a2bd1d56ae5` | 0 | 14185 B / `4c71acbd…` | — |

Repaired-set coverage: focused 67/67 across the four files; `full` =
lint + typecheck + build (with the pinned Perkins policy integrity check) +
backend 27 additional onboarding tests + web 409 + hygiene; browser = web
unit 409/409 + Playwright 51/51 (all projects).

## Qualifications (preserved, not erased)

- **Original RED** (`wizard-bmad-browser-consumer` at `81d3f10`): run
  `48f31148`, exit 1, 24833 B /
  `7587a6af65c3a2a485f724d27de6cb1aa878e2a4ea03fcea9bd54074896f4aa7`,
  ledger 40053 — full output and the repair chain under `repair-lineage/`.
- **Intermediate REDs**: `e31c915b` (554e51c), `eee1db6e` (c275cfb),
  `73b2242d` (d93ba27) — browser captures; and the focused RED `eef4dd0c`
  (1bea5c9) which exposed the pre-action ancestor-check ordering and was
  followed by the `9ba8637` follow-up. No unchanged-RED replay.
- **Never-started scheduler requests** (typed `lock_wait_timeout`;
  preserved receipts in the lane's ignored gate-prep, never counted as
  coverage): multiple across the cycle, including `typecheck` r2 at
  `81d3f10`, `full` r1 at `81d3f10`, `wizard-bmad-snapshot-update` r2 at
  `8b556e1`, browser r1 at `c275cfb`, browser r1 at `1bac32d`, focused r1 at
  `1bea5c9`, focused r1 and browser r1 at `9ba8637`. Also one HTTP 400
  intake rejection for a scope name over the 32-character limit (renamed;
  never started).
- **Historical pre-correction PASS at `81d3f10`** (focused `aeffca7f`, full
  `e8f776b7`) and the earlier FULL RED at `2e837de` (`5dfe4bea`, 7 host-load
  timeouts) are preserved in the lane spec and the operations archive and
  are not relabeled or re-run for logs.
- **CI:** exact-head CI for `1bac32d` (run `37087368772`) is historical; CI
  for the final published head runs on the normal push.
- **Consumed review round:** `review-round/` carries the three tracked
  reviewer jobs (adversarial, edge-case-hunter, verification-gap), their
  findings and receipts; `claims/final-review-dispositions.md` dispositions
  each finding.
