# PR148 final whole-change review packet

Purpose: the immutable, accessible, tracked evidence packet for the
independent whole-change review of PR #148
(`wizard-bmad-deterministic-retry-32`) and for the completion record that
follows it. It carries the consumed review round, every repair, and the
verification evidence for the repaired head.

## Frozen bindings (packet v3)

- **Review target / product head:** `9ba863746da8a0af3b6f20c00d3cb08acc95f28c`
  (fresh-main merge + browser corrections + final-review repairs).
- **Base / diff-base:** `5d56194a905262231bb0d183292b6d08cbd70810` (freshly
  resolved origin/main at integration; the merge-base of target and main).
- **Product diff:** `final.patch` — `git diff 5d56194..9ba8637` with this
  packet directory excluded. Bytes and SHA-256 are in `manifest.json`,
  together with the **git blob hash of every file the diff touches at the
  frozen head** (`product_files_at_head`) so the frozen worktree can be
  checked against the packet mechanically.
- **Head chain:** `manifest.json.head_chain` lists every intermediate head
  and its role (packet-only vs product changes), so each supersession is
  explicit.
- **Lane:** branch `gru/wizard-bmad-deterministic-retry-32`, PR
  https://github.com/mssoka/gru-command/pull/148 (ordinary, non-draft).
- This packet is committed as the only tracked delta on top of the product
  head. It adds no product bytes.

## How to verify this packet

1. Read `manifest.json`: it lists every packet file with SHA-256, the
   product head/base/diff-base, the head chain, the product diff bytes and
   hash, the per-file blob hashes of the diff-touched product files, and the
   verification-run bindings for all three stages.
2. Hash every packet file you read (`shasum -a 256`) and compare — before
   and after your analysis. Any mismatch is a hard stop.
3. For product files, compare the frozen worktree's file bytes against the
   `product_files_at_head` blob hashes (`git hash-object <file>` in the
   frozen worktree).

## Hygiene sanitization (one mechanical substitution)

Every copy in this packet has the literal personal home prefix replaced with
`<HOME>`, the lane worktree with `<LANE_WORKTREE>`, and reviewer worktrees
with `<REVIEWER_WORKTREE_*>` (SPEC ruling 8); your briefing provides the
machine paths. Nothing else was altered; each file's substitution count and
shipped SHA-256 are in `manifest.json`, and the original evidence bytes
remain bound by the receipts' own `output_sha256` fields.

## Bounded inputs (read-only)

- This packet directory — the whole bounded evidence set.
- The named lens instruction file only (path provided in the briefing).
- The frozen source tree for context and symbol/test search:
  `<LANE_WORKTREE>` at the product head. Read-only. Do NOT read
  `_bmad-output/gate-prep/`, `node_modules/`, `.git/` internals, other jobs'
  worktrees, sessions, ledgers, journals, or native review material.

## Contents

| path | what it is |
|---|---|
| `final.patch` | the whole product change under review |
| `manifest.json` | hashes, head chain and bindings for everything here |
| `claims/spec.md` | the tracked acceptance spec |
| `claims/issue-32.json` | the captured issue requirements (task data) |
| `claims/native-r1-review.md` / `claims/native-r1-dispositions.md` | prior native r1 findings and their individual dispositions |
| `claims/final-review-dispositions.md` | this round's findings (3 lenses) and their individual dispositions |
| `review-round/` | the three consumed reviews: findings JSON, receipts, review identities |
| `verification/pre-merge/` | green scopes at `1bac32d` (pre-fresh-main) |
| `verification/post-merge/` | green scopes at `faa69d6` (post-merge, post-browser corrections) |
| `verification/repaired/` | green scopes at `9ba8637` (after the final-review repairs) |
| `verification/current-evidence.md` | the evidence story, qualifications and preserved failures |
| `repair-lineage/` | the original RED → green chain with every intermediate RED |
| `png/before/`, `png/after/` | the four theme baselines before/after the approved refresh |
| `png/PROVENANCE.md` | approved-UI provenance, per-image inspection, tolerance bounds |
| `source/changed/` | full text of every non-PNG file the change touches |
| `source/context/` | key unchanged files the change leans on |
