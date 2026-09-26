---
title: 'Whole-PR Perkins review'
type: 'feature'
created: '2026-09-26'
status: 'done'
route: 'dispatch'
baseline_commit: '128412db65f25183854b5d3b54768f51aa8bd862'
approved_via: 'dispatch briefing (owner pre-approved design; no open questions)'
review_loop_iteration: 0
---

# Whole-PR Perkins review

## Intent

<frozen-after-approval>
Replace the chunk-based Perkins review protocol with one lead-owned whole-PR review, exactly as the owner approved (dispatch briefing, job perkins-whole-pr-review):

- The complete PR is the review unit. No directory/hunk partitioning and no
  lens-by-chunk task matrix for new reviews.
- One lead receives the original brief/spec, the full frozen diff, and
  read-only access to the exact reviewed repository snapshot, and owns
  investigation, verification, prior-issue revisiting, one coherent report,
  and the verdict. Specialists, when the lead uses them, each review the
  whole change from their lens with genuine independence; no new
  selection/configuration framework.
- The reviewer decides substantive truth and revisits prior issues without
  the removed-line/distinct-file proof-shape bureaucracy or the verbatim
  per-finding report transcription requirement. The final review stays
  coherent, evidence-based, accounts honestly for prior findings, and keeps
  useful source references.
- Host keeps only soundness checks: valid outcome/schema, exact reviewed
  commit/snapshot, honest execution status, safely formed GitHub
  publication, verified posting receipt, idempotent reconciliation on
  ambiguous posting failures. Unposted is never complete; unsupported or
  interrupted review is never approval; an accepted REQUEST_CHANGES is
  successful completion.
- Reviewer never fixes, pushes, or merges. Existing GitHub App identity
  (gh/GitLab posters) is unchanged; a review of an old SHA never authorizes
  a newer head (SHA-bound posting + head-move checks stay).
- Use actual runtime-declared context limits and native compaction; no
  hardcoded 1M capability, no silent truncation, no new chunk thresholds or
  size-planning ceremonies. Remove workflow-size barriers that existed only
  for the chunk protocol; keep genuine security/transport protections with
  honest errors. Old archived rounds, findings, and receipts are preserved
  untouched; minimal read-compatibility for old records only; no destructive
  migration, no replay/resume subsystem.
</frozen-after-approval>

## Implementation Notes

Key decisions (all inside the approved scope):

- New engine `PerkinsWholeReview` in `src/dispatch/perkins-review/whole.ts`;
  `hybrid.ts` deleted. Lead gets spec/conventions/prior-findings and the
  COMPLETE frozen diff inline in the initial prompt (native context handling
  and compaction; no chunking), plus confined read/grep/find/ls on the
  frozen review worktree. Native tools: `perkins_run_specialists`,
  `perkins_read_prior_revision` (only when a prior review exists),
  `perkins_store_artifact`, `perkins_preflight_submission`,
  `perkins_submit_review`. Specialists stay isolated children (blind =
  diff-only, others = frozen-tree reads) submitting the existing strict
  findings schema via `perkins_submit_findings` when wired, else the strict
  bare-array text path; per-lens attempt bound stays `maxLensAttempts` (2)
  as a resource bound; failed specialist runs are reported to the lead
  honestly and never abort the round (no required-coverage gate).
- Submission `{verdict, findings[], prior_dispositions[], report_markdown}`:
  collect-all validation keeps schema/coverage bounds (verdict enum, bounded
  finding fields with source in lenses ∪ `lead`, one disposition per prior
  index, report ≤128KiB stating `**Verdict: …**`, targetSha and
  diffBaseSha) and drops host verdict arithmetic, evidence-locatability
  proof at submission, report per-finding verbatim proofs, and
  fix_location/removed-line/PATH ABSENT proof shapes. Verdict is the
  reviewer's judgment; INCOMPLETE submissions stay valid terminal honest
  incompleteness and never approve. ≤2 real submit attempts; preflight free.
- `consolidated.json` schemaVersion 3, architecture `perkins-whole-pr`;
  `loadPriorReview`/prior-round selection accept v2 legacy (chunks required)
  and v3; still-present priors carry their original roundOrigin; normalized
  title+location dedupe retained.
- Freeze drops chunking (`chunkUnifiedDiff`, per-chunk byte bound, chunk
  manifests/artifacts, `chunkLineThreshold`); keeps the 8MiB frozen-diff
  bound, spec/convention bounds, symlink/clean-checkout/drift protections.
- `WaveRunner` swaps the engine, drops coverage-exhausted handling, and
  records lens chips truthfully: ran→done/error from real runs, never
  used→done `not used — lead-owned whole-PR review`. Posting, receipts,
  head-move, delivery-incomplete and restart reconciliation are unchanged.
- `resources/perkins-code-review/policy.json` rewritten for whole-PR
  (lead workflow, whole-diff prompts, whole-change file list, rules minus
  chunk threshold; unused verification/reReview prompts dropped); integrity
  pins refreshed in `src/dispatch/perkins-review/policy.ts` and
  `tools/verify-perkins-resource.mjs`; `review-mcp-server.mjs` untouched so
  its pin is unchanged.
- Board: bare-lens agent labels parse (`lensFromAgentLabel`); `docs/ROLES.md`
  Perkins permissions paragraph updated.

## Code Map

- `src/dispatch/perkins-review/hybrid.ts` (2545 lines) — DELETE; chunk
  protocol, coverage gates, delta/record machinery, proof-shape validators.
- `src/dispatch/perkins-review/artifacts.ts` — keep freeze/drift/write-once
  artifacts; remove chunk splitting + chunk bounds + `chunks` field.
- `src/dispatch/perkins-review/types.ts` — keep finding schema/parse
  helpers (source now lenses ∪ `lead`); drop coverage-gate and fix-audit
  proof parsing; keep dedupe.
- `src/dispatch/perkins-review/policy.ts` + `resources/perkins-code-review/policy.json`
  — whole-PR contract; pins must stay in sync with
  `tools/verify-perkins-resource.mjs` (AGENTS.md rule).
- `src/dispatch/perkins.ts` — `WaveRunner` wiring, lens outcome recording,
  prior-round selection (`isCompleteConsolidated`), no chunk args.
- `src/board/engine.ts` — `lensFromAgentLabel`, `lensAgentLabel` in perkins.ts.
- `src/runtime/*` — unchanged (isolatedReview/reviewLead/nativeTools,
  MCP bridge all reused as-is).
- Tests: replace `test/perkins-builtin-review.test.ts`; adapt
  `test/perkins-builtin-wave.test.ts`, `test/perkins-freeze-freshhead.test.ts`,
  `test/perkins-lead-schema-compat.test.ts`; new double
  `test/helpers/perkins-whole-double.ts`.

## Acceptance Criteria

1. Given a formerly oversized multi-directory diff (>3000 lines), When a
   review runs, Then one lead reviews the whole diff (no chunk artifacts, no
   seven-times-N scheduling) and any specialist sees the whole change.
2. Given prior findings incl. a cross-file fix and a same-file additive fix,
   When the lead revisits them, Then fixed/still-present dispositions are
   accepted from reviewer judgment with a bounded note — no
   removed-line/distinct-file/PATH ABSENT proof shapes — and every prior
   index is accounted for exactly once.
3. Given a coherent evidence-based report without verbatim per-finding
   duplication, When the lead submits, Then the review publishes; a
   REQUEST_CHANGES submission completes successfully (not an orchestration
   failure) and failed test-quality findings are reported as findings, not
   confused with a missing reviewer.
4. Given missing/invalid verdict, oversized report, moved head, cancellation,
   provider failure, unposted result, or ambiguous/duplicate posting, When
   finalizing, Then the round is truthfully INCOMPLETE/aborted with
   escalation, no fake receipt, and stale-head approval is impossible
   (SHA-bound posting and head-move checks).
5. Given old v2 hybrid rounds on disk, When a new round selects its prior,
   Then legacy consolidated findings load read-only and old
   verdicts/artifacts stay untouched.
6. Given the full suite (`npm test`), When run, Then lint, typecheck, build
   (incl. `verify-perkins-resource`), backend and web suites all pass.

## Tasks

1. `resources/perkins-code-review/policy.json` + `policy.ts` + verifier pins.
2. `artifacts.ts` freeze without chunks (keep bounds/guards).
3. `types.ts` finding/submission schema for the whole-PR engine.
4. `whole.ts` engine + delete `hybrid.ts`.
5. `perkins.ts` WaveRunner integration + lens outcomes.
6. Board label parsing + `docs/ROLES.md`.
7. Tests: new double + engine suite; adapt wave/freeze/compat suites.
8. [x] Full `npm test` (components each exit 0; backend run serially for a load-stable green); commit; PR #77 with exact-head CI green.

## Test Plan

Deterministic behavioral suites: engine happy paths (both verdicts),
judgment-only prior dispositions, schema negatives (verdict/report bounds),
specialist failure honesty + retry bound, no-chunk freeze of an oversized
multi-directory diff, head-move/cancel/never-submits → INCOMPLETE,
posting/receipt/reconciliation (existing wave tests), policy pin coherence,
legacy v2 prior loading, board label parsing.

## Risks

- Provider prompt-size limits on very large diffs: honest error path (no
  silent truncation) — matches briefing.
- Old suites encode chunk behavior; replacement must keep every
  posting/receipt safety test intact.

## Review Triage Log

- Step-04 review layers (blind-hunter, edge-case-hunter, verification-gap):
  this dispatch runtime has no subagent-spawn capability, so per the
  workflow fallback each layer's standalone prompt (diff/claims/instruction
  inlined) is staged under `_bmad-output/implementation-artifacts/
  review-layer-*-prompt.md` for the human to run in separate sessions. No
  findings have been triaged yet; the implementer's own full-diff audit
  found and fixed two issues (submission-time head-move gate strength,
  failed-batch specialist accounting). Independent review of PR #77 by the
  deployed Perkins gate remains mandatory per the briefing — never
  self-approval, never self-merge.

## Spec Change Log

- 2026-09-26: initial spec from dispatch briefing.
- 2026-09-26: delivered on PR #77 (head 91fd204f, CI 36216219411 success);
  review layers staged for external runs.
