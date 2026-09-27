---
title: 'PR77 bounded integration after owner merged PR71'
type: 'integration'
created: '2026-09-27'
status: 'done'
baseline_commit: '25405387fb319c1bbbda5f92fb7ff44238282e5a'
target_main: '6249e98a40fb022348210ef8dd5ce794e32c9e57'
route: 'dispatch'
review_loop_iteration: 0
---

# PR77 bounded integration after owner merged PR71

## Intent

<frozen-after-approval>
Owner merged #71 (main `6249e98a40fb022348210ef8dd5ce794e32c9e57`) and said
"action" on the live PR77-conflicts notification. Integrate origin/main INTO
`gru/perkins-whole-pr-review` (head `25405387fb319c1bbbda5f92fb7ff44238282e5a`)
with a normal merge commit that preserves BOTH feature sets: #71's
wake/routing/durable-control behavior AND #77's whole-PR Perkins review.
Resolve conflicts semantically (no blanket ours/theirs). Changes beyond
conflict hunks only where the combined tree needs them to build/work, each
explained. Then run the required project verification through the shared
verification scheduler, complete a bounded BMAD review of the
integration/resolution DELTA, push normally to the existing PR77 branch,
obtain exact-head CI, and persist source job `perkins-whole-pr-review` as
BLOCKED via the status API with independent /api/board confirmation.

NOT in scope: merging PR77 into main, deployment, legacy r4 review, new
review rounds on old heads, repairing known review findings (owner is filing
individual issues via a separate parallel job), force-push, rebase, history
rewriting, or backlog work. Existing whole-PR NEEDS CHANGES reviews for #77
and #71 remain accurate history.

Authority: owner briefing `pr77-integration-after-pr71-owner-merge-20260927-approved.md`
(owner-approved via action; no restatement needed).
</frozen-after-approval>

## Code Map

Investigation (2026-09-27, this lane):

- Merge dry-run (`git merge-tree --write-tree 2540538 6249e98`): exactly ONE
  content conflict — `test/suite-shape.test.ts`. Nine other shared files
  auto-merge; mechanical success does not prove semantic correctness.
- Shared files both PRs touched (the predicted ten-file overlap):
  `src/board/engine.ts`, `test/board-engine.test.ts`,
  `test/dispatch-e2e.test.ts`, `test/dispatch-server.test.ts`,
  `test/roles-definitions.test.ts`, `test/suite-shape.test.ts`,
  `web/src/lib/board-signals.test.ts`, `web/src/lib/board-signals.ts`,
  `web/src/ui/board.test.ts`, `web/src/ui/board.ts`.
- `test/suite-shape.test.ts` pins EVERY test file's registered `it(` count
  and requires the PINS table to equal the directory listing exactly.
  #77 side: board-engine 19→20, deleted `perkins-builtin-review.test.ts`
  (pin removed), `perkins-builtin-wave` 38→78, added
  `perkins-crash-child`(1), `perkins-whole-review`(64). #71 side:
  board-engine 19→23, board-server 15→17, awareness 13→43, chat-server
  80→83, config 56→57, dispatch-server 18→19, notifications 15→16,
  service-port-guard 13→14, silas-driver 30→33, supervisor 42→43, added
  `wake-e2e`(3), `wake-policy`(17). Resolution: regenerate the whole PINS
  table from the ACTUAL merged tree (file set = union minus deletions;
  count = registered tests per merged file), never one side's table.
- `src/board/engine.ts`: #77 rewrote `lensFromAgentLabel` (whole-PR bare lens
  labels, legacy `lens:chunk` still parsed); #71 added owner/machine pending
  counts, wake totals, pagination in other regions. Merged file must keep
  both; `test/board-engine.test.ts` carries both sides' assertions (merged
  count will exceed either side's pin).
- Cross-file call chain: #71's `src/dispatch/server.ts` clean-abort re-arm
  guards call `options.wave.requestReview(input)` and read
  `outcome.round.lenses`, `outcome.round.id`, `outcome.clearToMerge`;
  #77-rewritten `src/dispatch/perkins.ts` still exports WaveRunner with
  `requestReview` and round `lenses` — typecheck binds the contract.
  `deliveredTargetSha` import from `./silas-driver.js` exists (#71-side).
- `web/src/lib/board-signals.ts`: #77 added used/unused/ran lens counting +
  settled live-progress; #71 changed action-required wording to "needs Gru"
  machine attention. Different regions; merged unit tests decide.
- #71-only files land whole: `src/chat/wake-policy.ts`, `test/wake-*.ts`,
  docs, roles/gru|silas.md, `web/src/ui/chat-service-band.test.ts`, chat
  e2e specs + PNG snapshots. #77-only files land whole:
  `src/dispatch/perkins-review/whole.ts` (+deleted `hybrid.ts`),
  `test/perkins-whole-review.test.ts`, `test/perkins-crash-child.test.ts`,
  `test/helpers/perkins-whole-double.ts` (+deleted hybrid double),
  policy.json + verifier pin updates (in sync on our side).
- Verification: `npm test` = lint + typecheck + build (includes
  `tools/verify-perkins-resource.mjs`) + backend vitest + web unit. Heavy
  commands go through the deployed service scheduler:
  `POST /api/verify {job_id:"perkins-whole-pr-review", scope:"full"}` on
  127.0.0.1:7665 with bearer token from service config; lane declares
  `[verify] full = "npm test"` in `.gru-command/worktree.toml`.
- CI (`.github/workflows/ci.yml`): lint, typecheck, build, `npm test` on the
  PR merge result — no e2e in CI. Web e2e specs cover chat only; merged
  `web/src/ui/chat.ts` and its snapshots both come verbatim from #71's
  CI-green head 387b457, so the integration delta does not touch any e2e
  surface (board has no e2e spec). Known local chat-light screenshot flake
  at pre-integration head is recorded history, not this delta.
- Status API: deployed service on 127.0.0.1:7665; job currently `working`;
  final state must be persisted BLOCKED (API write + /api/board read-back).
- Backup ref `backup/pr77-pre-integration-2540538` created (non-overwriting);
  pre-integration receipt at
  `~/.gru-command/briefings/pr77-integration-after-pr71-owner-merge-20260927-delivery/pre-integration-state.md`.

## Tasks

1. [x] **Merge** — merge commit `234b1e9` on `gru/perkins-whole-pr-review`; both
   `2540538` and `6249e98` are parents (normal merge, no rebase/force).
2. [x] **Resolve `test/suite-shape.test.ts`** — PINS regenerated from the
   actual merged tree with the guard's own counting regex (union file set;
   board-engine 24, wake-e2e 3, wake-policy 17, perkins-whole-review 64,
   perkins-crash-child 1 retained with comment; perkins-builtin-review
   removed with its deleted file). suite-shape run exits 0.
3. [x] **Semantic integration check** — lint + typecheck + build exit 0
   (perkins-resource verifier green); merged overlap files verified as
   strict supersets of BOTH parents (dispatch-server.test 18+1=19 union,
   board.test 36 ⊇ both, NEEDS YOU→NEEDS GRU titles are #71 renames, not
   losses); zero conflict markers; no changes needed beyond the conflict
   file.
4. [x] **Focused verification** — green, all on the merged tree:
   backend: suite-shape 2, wake-policy 17, wake-e2e 3, board-engine 24,
   board-server 17, dispatch-server 19, dispatch-e2e 5, roles-definitions 9,
   silas-driver 33, notifications 16, chat-server 83, awareness 43,
   supervisor 43, config 57, service-port-guard 14, perkins-whole-review 64,
   perkins-builtin-wave (in-batch), perkins-freeze-freshhead 13,
   perkins-lead-schema-compat 6, bmad-onboarding 13, wizard-register 2,
   listener-probe 5; perkins suite batch 160 passed/1 skipped (crash-child,
   env-gated by design). web: 35 files / 304 tests exit 0.
5. [~] **Full gate via scheduler** — `POST /api/verify` run
   `5326580b-d8d4-4e1c-9fcf-bd481f40b9e8` scope `full` at `234b1e9`
   (tracked-clean, 14 workers): FAILED, exit 1 — 21 files / 44 tests, all
   timeout/spawn/boot-starvation signatures, 10 vitest `onTaskUpdate` RPC
   errors, zero code-assertion mismatches. NOT waved off — reproduced the
   exact baseline: pre-merge `2540538` in a detached worktree, same
   machine/command (`vitest run` default pool after clean build): FAILED,
   exit 1 — 19 files / 39 tests / 9 RPC errors, same signature; 18 of 21
   merged-run failing files fail in BOTH runs; the 3 merged-only files
   (bmad-onboarding, wizard-register, wake-e2e — the latter not existing at
   baseline) all pass in isolation on the merged tree (23/23 with
   listener-probe control). Pre-existing local default-pool host-load
   condition, also documented by the independent PR77 review record at the
   pre-integration heads (with exact-head CI SUCCESS + thread-pool exit 0
   there). Failure retained; authoritative exact-head gate = GitHub CI on
   the pushed head (brief acceptance 5), which runs the same `npm test` on
   an isolated runner.
6. [x] **BMAD review of the delta** — completed 2026-09-27: three fresh
   independent layers (blind 13, edge 4, verification-gap 1 pre-verified),
   all exit 0, receipts preserved. All 18 findings pre-exist verbatim on
   owner-merged main (every cited file byte-identical to 6249e98, untouched
   by PR77); ZERO target the integration delta. No loopback; 3 grouped
   defer rows appended. Review did NOT broaden into the findings backlog.
7. [x] **Re-resolve main, push, CI** — origin/main re-resolved (still
   6249e98, no advance) before push; normal fast-forward push
   234b1e9..5da0224 (no force). The earlier 2540538→234b1e9 remote movement
   was the CHIEF publishing this lane's merge commit on the owner's direct
   "fix it now" instruction (receipts preserved in the delivery dir;
   verified byte-identical). CI run 36314189462 on final head 5da0224:
   completed/SUCCESS; PR OPEN, MERGEABLE, mergeState CLEAN, base 6249e98.
8. [x] **BLOCKED hold + delivery** — `POST /api/jobs/perkins-whole-pr-review/status
   {"status":"blocked"}` → 200; independent /api/board read-back confirms
   `blocked` (updatedAt 2026-09-27T11:00:57.944Z). Delivery receipt + layer
   receipts + verification logs preserved under
   `~/.gru-command/briefings/pr77-integration-after-pr71-owner-merge-20260927-delivery/`.

## Acceptance Criteria

- AC1 (ancestry): Given the merged branch, `2540538` AND `6249e98` are both
  ancestors, the working tree has no conflict markers, and every manual
  resolution carries a rationale mapping to source/tests.
- AC2 (conflict): Given the merged `test/suite-shape.test.ts`, the PINS
  table equals the merged `test/` file listing and every pinned count equals
  that file's registered tests; `vitest run test/suite-shape.test.ts` exits 0.
- AC3 (both features): Given focused suites from both sides (wake-policy,
  wake-e2e, perkins-whole-review, perkins-builtin-wave, board-engine,
  dispatch-server, dispatch-e2e, board-signals, board, chat-service-band),
  all pass in the combined tree without deleting either side's assertions.
- AC4 (full gate): `POST /api/verify` scope `full` returns a completed,
  `ok:true` run bound to the integrated head (tracked-clean), with recorded
  run id; failures stay failures (no fudging, no golden refresh).
- AC5 (review): BMAD review of the integration/resolution delta completes
  with fresh context; genuine integration findings are fixed or escalated;
  the review does not silently expand into the known findings backlog.
- AC6 (push/CI): Normal push of the merge commit to
  `origin/gru/perkins-whole-pr-review` (no force); fresh CI run on the exact
  pushed head; provider facts (head/main/mergeability) recorded.
- AC7 (hold): Job `perkins-whole-pr-review` reads BLOCKED from /api/board
  (API-persisted, not prose); delivery receipt written with exact refs,
  files, rationales, exits, CI URL, and any remaining genuine blocker.

## Implementation Notes

- Keep >=36 GiB free; serialize heavy commands via the scheduler.
- Do not touch the parallel issue-creation worker's records/processes.
- Never merge the PR, deploy, or arm any review round; never bind a real
  Gru conversation on 7665.
- Preserve prior specs/artifacts; this spec is new, not a repair-3 edit.

## Open Questions

None — the owner-action briefing pre-authorizes target, strategy, bounds,
verification and push; escalation is only for genuine semantic/permission
decisions the contracts cannot settle (per briefing).

## Review Triage Log

Layers: blind-hunter (13 findings), edge-case-hunter (4), verification-gap
(1, pre-verified per its evidence rules). All launched fresh
(pi 0.87.1 / openai-codex/gpt-6-sol @ xhigh, --no-session, tools read+grep,
no context files/extensions/skills/themes), synchronous, receipts under
`~/.gru-command/briefings/pr77-integration-after-pr71-owner-merge-20260927-delivery/layers/`.

Classification basis: every cited file (notifications/center.ts,
supervision/supervisor.ts, chat/awareness.ts, chat/server.ts,
dispatch/silas-driver.ts, dispatch/server.ts, docs/BOARD.md,
web/src/ui/chat.ts) is byte-identical to owner-merged main 6249e98 and
untouched by PR77 — verified with `git diff` against both parents. All 18
findings pre-exist this integration on main; ZERO findings target the
integration delta itself (merge, suite-shape regeneration, or any combined-
tree-only code). No intent_gap, no bad_spec, no patch → no loopback.

| # | finding (layer) | verdict | evidence / route |
|---|---|---|---|
| 1 | legacy unacked machine-routed incident reuse strands Ack-controlled stop (blind; edge#4) | medium, defer | = owner #71 review g1 (high there); code identical to main |
| 2 | ensureSlot re-arms owner-held breaker on ordinary chat (blind) | medium, defer | #71 design point (g2-class); identical to main |
| 3 | wake-blocked advice says restart service (blind) | low, defer | #71 behavior; identical to main |
| 4 | blocked-wake follow-up fixed-ID ack gap (blind) | medium, defer | #71; identical to main |
| 5 | wake context stale across async Gru spawn (blind) | medium, defer | = #71 review g5; identical to main |
| 6 | digest re-offers clean-abort after fallback event (blind; edge#2) | medium, defer | = #71 review g24; identical to main |
| 7 | clean-abort proof misses live branch-head re-check (blind) | medium, defer | = #71 review g14 (high there); identical to main |
| 8 | BOARD.md 30-min owner follow-up vs no-age-based rule (blind) | low, defer | #71 docs inconsistency; identical to main |
| 9 | digest staged-PR windowing not cursor-based (blind) | medium, defer | = #71 review g6; identical to main |
| 10 | digest shows one disposition detail of N resolutions (blind) | low, defer | #71 (g7/g13-class); identical to main |
| 11 | needs-owner notices collapsed behind service band (blind) | low, defer | #71 clean-chat design; owner UX decision; identical to main |
| 12 | control-result durability claim vs DOM-only render (blind) | medium, defer | = #71 review g8; identical to main |
| 13 | explicit target_ref≠SHA guard missing (edge#1) | medium, defer | #71 review g14 same surface; identical to main |
| 14 | concurrent double re-arm reservation race (edge#3) | medium, defer | same main-side API surface; identical to main |
| 15 | missing service_restart_missing_review_lane re-arm test (vgap, pre-verified) | medium, defer | verified: no test matches that reason; #71-side coverage gap |
| 16 | (dup of #1) routing-match on incident reuse (edge#4) | medium, defer | merged with #1 |

Deferred entries appended to `deferred-work.md` (3 grouped rows); owner's
parallel issue-creation job owns the GitHub tickets — nothing duplicated,
nothing repaired here, per the integration-only mandate.
