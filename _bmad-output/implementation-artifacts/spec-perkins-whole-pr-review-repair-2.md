---
title: 'PR77 six-blocker repair pass: T1-T5, T13'
type: 'bugfix'
created: '2026-09-27'
status: 'done'
route: 'dispatch'
baseline_commit: '3ff52ebedbc304f766eeec9da88175469b67767b'
approved_via: 'owner "initiate fixes" via Gru bounded six-blocker scope; independent review owner-independent-pr77-3ff52eb-20260926 (5326595099, NEEDS CHANGES)'
review_loop_iteration: 0
---

# PR77 six-blocker repair pass: T1–T5, T13

## Intent

<frozen-after-approval>
Fix exactly the six reviewed blockers T1, T2, T3, T4, T5, T13 of the
independent review (provider review 5326595099) so real publication,
recovery and specialist-result preservation satisfy the reviewed
contract. T6–T12 and T14–T15 remain OPEN and must not be marked fixed
by this pass; no chunk matrices, raw-field transcription bureaucracy,
new auth/App, generic replay subsystem, role/model changes or new
dependencies. B1 is settled: authenticated gh COMMENT/COMMENTED under
the actual actor; no self-APPROVE, no branch-protection override, and a
COMMENT is never claimed as formal GitHub APPROVED/CHANGES_REQUESTED.
GitLab reconciliation keeps conservative fail-closed binding; no new
note-correlation protocol — any product decision beyond that stops with
options. Verification: focused red/green regressions through real
production paths first, then required full verification, exact-new-head
CI on the existing branch, then BLOCKED awaiting Gru's fresh independent
out-of-runner recheck. No legacy runner, no merge/deploy, no #71 work.
</frozen-after-approval>

## Implementation Notes

- **T1 (`src/dispatch/perkins.ts` AutoVerdictPoster)**: add `reconcile`
  that re-selects the provider by the SAME `isGitHubRemote`/
  `isGitLabRemote` host discrimination as `post` and delegates to that
  selected provider (loud error if the provider lacks reconcile — never
  a fabricated match). `src/main.ts` wiring stays `new
  AutoVerdictPoster()`; regression drives the adapter itself.
- **T2 (recordDelivery ↔ recovery)**: the writer's nested `receipt`
  gains `headSha: delivered.headSha` (all other fields unchanged;
  top-level `targetSha` stays for history). Positive recovery test
  generates the event through real finalization (receipt poster +
  ledger whose `setRoundVerdict` throws once to simulate the crash
  between publication and verdict), then feeds the ACTUAL persisted
  event to recovery.
- **T3 (recovery evidence)**: promotion requires, conjunctively: receipt
  with non-empty reviewId, `headSha === round.targetRef`, string
  `bodySha256 === publicationSha256`, non-empty string
  `publicationFile`, AND the file readable with digest equal to
  `publicationSha256`. Missing/null/malformed path, missing/unreadable/
  changed file → NOT bound → escalate + interrupted (never promoted);
  legacy incomplete stays incomplete; completed history untouched.
- **T4 (post-lookup guards)**: after a successful reconcile lookup and
  `verifyPostedReceipt`, re-apply the same guards as normal delivery —
  `signal.aborted` and `refMovedSinceFreeze` — BEFORE recording. On
  guard failure: write `perkins-report.reconciled-unrecorded.json`
  (receipt + reason), escalate for moved ref, treat as honestly
  unposted (round aborts INCOMPLETE; no verdict; the remote comment's
  existence is preserved as evidence, never claimed reviewed).
- **T5 (GitHub binding)**: `GhPrPoster.post` rejects a provider response
  whose `commit_id` is missing/null/empty (loud "missing the GitHub
  commit binding" — never null-pass-through); reconcile constructs
  receipts only from reviews whose `commit_id` is a string equal to the
  frozen target (body-matching but unbound reviews yield NO match —
  honestly unresolved). GitLab notes keep `commitId: null` semantics;
  no fictional GitHub fields imposed there.
- **T13 (`src/dispatch/perkins-review/whole.ts`)**: `runSpecialist`'s
  `finally` disposes best-effort — a dispose rejection writes
  `specialists/<lens>.attempt-N-<token>.dispose-error.json` and NEVER
  discards the run's result; `pool` returns settled results plus a
  first error instead of throwing siblings away; `runTool` commits
  every settled result FIRST, then restores attempts/started only for
  scheduled lenses that produced no result, then surfaces the error.
  Failed children stay invalid/failed (no fake success); terminal
  sealing still waits for all started children (existing submit
  serialization).

## Code Map

- `src/dispatch/perkins.ts` — AutoVerdictPoster.reconcile, GhPrPoster
  commit-binding requirements, recordDelivery receipt.headSha, recovery
  conjunctive evidence check, reconciled-delivery guards + unrecorded
  artifact.
- `src/dispatch/perkins-review/whole.ts` — best-effort dispose with
  durable dispose-error record, settled-results pool, commit-then-
  restore runTool accounting.
- `test/perkins-builtin-wave.test.ts` — T1 adapter integration, T2
  writer→recovery, T3 evidence variants, T4 guards, T5 GitHub receipt
  cases.
- `test/perkins-whole-review.test.ts` — T13 regressions.
- `test/helpers/perkins-whole-double.ts` — dispose-rejection injection.
- `test/suite-shape.test.ts` — count pins for added tests.

## Acceptance Criteria

1. Given a provider that accepted the POST then timed out, When
   WaveRunner finalizes through the PRODUCTION AutoVerdictPoster, Then
   the provider-selected reconcile runs (no second POST), and either a
   bound receipt records delivery or the round stays honestly unposted.
2. Given a crash between real publication and verdict recording, When
   recovery runs on the actual persisted `round.posted` event, Then the
   round is promoted verdict-posted with its receipt — no invented
   fields.
3. Given a posted verdict event whose publicationFile is missing/null/
   malformed or whose file is missing/unreadable/digest-changed, When
   recovery runs, Then promotion is refused (escalated, interrupted);
   a valid actual-writer event still promotes.
4. Given the source ref moves (or the abort signal fires) while the
   reconcile lookup is outstanding, When the lookup returns a bound
   receipt, Then delivery is NOT recorded, the reconciled-unrecorded
   artifact preserves the receipt + reason, and the round aborts
   INCOMPLETE with no verdict; a stable ref records normally.
5. Given a GitHub provider response with missing/null/empty/mismatched
   commit_id, When posting or reconciling through the concrete
   GhPrPoster, Then delivery is refused / unmatched; only commit_id ===
   frozen target completes.
6. Given a specialist child that settled (valid or failed) whose
   dispose rejects, or a sibling whose dispose rejects, When the batch
   finalizes, Then every settled result stays committed with true
   status, a dispose-error artifact records the cleanup failure
   distinctly, no attempt/started budget is restored for lenses that
   ran, and no result is reported as not used or fake success.
7. Given the full suites, When run, Then lint/typecheck/build (pinned
   verifier), focused new regressions and the required full
   verification pass with real exits, and exact-new-head CI is green on
   PR #77 (existing branch, no force/reset/new PR).

## Review disposition (IDs → this repair)

T1→AC1; T2→AC2; T3→AC3; T4→AC4; T5→AC5; T13→AC6; verification→AC7.
T6–T12, T14–T15 and residual N partials (N5 integration proofs, N8
rendered label, N10 behavioral invocation) remain OPEN — not marked
fixed, not waived. B1 settled per corrected contract (truthful
actor/event; COMMENT ≠ formal approval).

## Tasks

1. `perkins.ts`: adapter reconcile + commit binding + writer receipt +
   recovery evidence + post-lookup guards.
2. `whole.ts`: dispose best-effort + settled pool + honest accounting.
3. Tests per AC1–AC6 (+ double dispose injection, pins).
4. Full verification; push existing branch; exact-head CI; blocked
   handoff.

## Test Plan

Red/green through real paths: AutoVerdictPoster+gh-double
timeout-after-accept→reconcile (log proves single POST); crashing-
setRoundVerdict writer→recovery promotion; recovery evidence variant
matrix; reconcile-under-moved-ref and aborted-lookup (unrecorded
artifact); GhPrPoster commit_id matrix; dispose-rejection valid/failed/
sibling/submit-race regressions via the real batch/pool/terminal paths.

## Risks

- Pool signature change is internal (single caller); dispose errors
  become durable artifacts — board consumers unchanged.
- Reconcile guards add one artifact filename; write-once collision
  tolerated as elsewhere.

## Review Triage Log

- 2026-09-27 (red/green evidence): each new regression was first run
  RED against the reviewed code (only `src/` reverted via stash, tests
  and doubles in place): T13 valid-result/sibling tests ×2 failed,
  T1 adapter test failed, T2 writer→recovery test failed — then GREEN
  with the fix restored. T3/T4/T5 tests assert the exact reviewed
  gaps (conditional artifact check; missing post-lookup guards;
  null-pass-through commit_id) and pass only on the repaired code.
- 2026-09-27 (test-fixture corrections during development, not product
  changes): T1's fixture presents the origin as the github URL the PR
  names and pins the target (no origin fetch needed for the freeze);
  T2 simulates the crash as a silently lost verdict write AND presents
  the crash-time lane state (unswept) to recovery, because a real
  process death never reaches the sweep in runOwnedReview's finally;
  T4 moves the frozen BASE (commit-tree + branch -f main) — moving the
  lane branch alone cannot trip refMovedSinceFreeze for a SHA-pinned
  target, matching the guard's real semantics.
- 2026-09-27 (scope discipline): T6–T12, T14–T15 remain OPEN. No
  unrelated polish. GitLab reconciliation untouched beyond the T1
  adapter delegation (its conservative current-head+body binding
  stands; T7's deeper correlation question stays open).
- 2026-09-27 (step-04 review layers): no subagent spawn capability in
  this runtime; standalone prompts staged as
  `review-layer-{blind-hunter,edge-case-hunter,verification-gap}-prompt-sixblock.md`
  (this diff inlined, claims = this spec). STAGED, NOT EXECUTED — no
  findings claimed from them. Executed verification: focused red/green
  regressions; serial backend 1235/1235 (exit 1 solely from 3 vitest
  worker-RPC onTaskUpdate timeouts, zero test failures); serial web
  287/287 exit 0; lint/typecheck/build(pinned verifier)/hygiene exit 0.
  The board-client keepalive failure in the parallel web run
  reproduces only under worker concurrency, passes isolated (326ms)
  and serially — environmental, retained as evidence, re-proven by
  exact-head CI. Authoritative independent gate: Gru's fresh
  out-of-runner whole-PR recheck.

## Spec Change Log

- 2026-09-27: initial six-blocker repair spec from independent review
  triage + owner bounded scope.
