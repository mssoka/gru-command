# PR148 final whole-change review packet (frozen)

Purpose: the immutable, accessible, tracked evidence packet for the fresh
independent whole-change review of PR #148 (`wizard-bmad-deterministic-retry-32`)
required by the original contract (j-761/j-861 pattern; blind/adversarial,
edge-case-hunter and verification-gap lenses).

## Frozen bindings

- **Review target (product):** `5c0d1d343639c4c96c0e387030f8c3ef6fddd445` —
  the fresh-main integration merge of lane head `1bac32d` and
  `origin/main 5d56194a905262231bb0d183292b6d08cbd70810` (PR #149).
- **Base / diff-base:** `5d56194a905262231bb0d183292b6d08cbd70810` (freshly
  resolved origin/main at freeze; it is the merge-base of target and main).
- **Product diff:** `final.patch` — `git diff 5d56194..5c0d1d3` with this
  packet directory excluded. See `manifest.json` for bytes and SHA-256, and
  for the per-file blob hashes of every file the diff touches.
- **Lane:** branch `gru/wizard-bmad-deterministic-retry-32`, PR
  https://github.com/mssoka/gru-command/pull/148 (ordinary, non-draft).
- The packet is committed as the ONLY tracked delta on top of the product
  head: `git diff --stat 5c0d1d3..<packet-commit>` lists only files under
  this packet directory. This packet adds no product bytes; the verified
  product tree is exactly the tree above.

## Hygiene sanitization (one mechanical substitution)

This packet is committed to the shared product repo and must satisfy the
repo hygiene gate (SPEC ruling 8: zero personal paths). Every copy in this
packet therefore has the literal personal home prefix replaced with
`<HOME>` and the lane-worktree absolute path replaced with
`<LANE_WORKTREE>`; your briefing provides the machine paths. Nothing else
was altered: the evidence copies are otherwise byte-complete, and each
file's sanitization count plus its shipped SHA-256 are in `manifest.json`.
The original evidence bytes remain bound by the receipts' own
`output_sha256` fields (also inside this packet).

## How to verify this packet

1. Read `manifest.json`. It lists every packet file with its SHA-256, plus
   the product head/base/diff-base, packet bytes, the product diff bytes and
   hash, the four PNG before/after hashes, and the verification-run bindings.
2. Hash the packet files you read (`shasum -a 256 <file>`) and compare. Any
   mismatch is a hard stop — report it, do not review past it.
3. For product files, the manifest lists the git blob hash of every
   diff-touched file at the product head; the frozen worktree path below is
   that exact tree.

## Bounded inputs (read-only)

- This packet directory — the whole bounded evidence set.
- The named lens instruction file only (path provided in your briefing).
- The frozen source tree, for context and symbol/test search:
  `<LANE_WORKTREE>/`
  at product head `5c0d1d3`. Read-only; tracked content is frozen for the
  duration of the review. Do NOT read: `_bmad-output/gate-prep/` (run
  logs), `node_modules/`, `.git/`, `dist/`, `web/dist/`, `web/test-results/`,
  other jobs' worktrees, sessions, ledgers, journals, or any native review
  material.

## Deliverable

Findings only, in your lens's canonical shape, as (a) your final message and
(b) `_bmad-output/implementation-artifacts/ops-review/<your-review-id>/findings.json`
in your OWN worktree, plus the initial/final `receipt.json` sibling that
declares your inputs, bindings, before/after hash counts, method and limits.
The findings are the review; the receipt is provenance metadata, never a
substitute. No severity/ranking. An empty array is valid where the lens
allows it. Read-only: no product edits, no commits, no pushes, no review
arms, no merges.

## Packet contents

| path | what it is |
|---|---|
| `final.patch` | the whole product change under review |
| `manifest.json` | hashes and bindings for everything here |
| `claims/spec.md` | the tracked acceptance spec (also in the diff) |
| `claims/issue-32.json` | the captured issue requirements (task data) |
| `claims/native-r1-review.md` | prior native Perkins r1 review (NEEDS CHANGES) |
| `claims/native-r1-dispositions.md` | individual disposition of each r1 finding |
| `verification/current-evidence.md` | verification/CI evidence, hashes, qualifications |
| `verification/*.complete-output.txt` | complete run outputs (EOF, untruncated) |
| `verification/*.receipt.json` | capture/ledger bindings for those runs |
| `verification/ci.json` | exact-head CI metadata |
| `repair-lineage/lineage.md` | the browser-correction chain and its runs |
| `repair-lineage/*.output.txt` | original RED + each intermediate RED, complete |
| `png/before/`, `png/after/` | the four theme baselines before/after the approved refresh |
| `png/PROVENANCE.md` | approved-UI provenance, per-image inspection notes, bounds |
| `source/changed/` | full text of every non-PNG file the change touches (head) |
| `source/context/` | key unchanged files the change leans on (chat view, working-flavor lib, e2e helpers/configs) |

## Note on the verification evidence

`verification/current-evidence.md` carries the pre-merge green set
(`1bac32d`) with full hashes, plus the qualifications (never-started
requests, intermediate REDs, original RED). The fresh-main product head's
own scoped runs and the evidence-only follow-up commit that appends them are
recorded there as the current state; the follow-up touches only this packet
directory and no product bytes.
