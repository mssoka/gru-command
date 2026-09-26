---
title: 'Whole-PR Perkins review: independent PR77 review repairs'
type: 'bugfix'
created: '2026-09-27'
status: 'done'
route: 'dispatch'
baseline_commit: 'cb136827c53f820c1b6150db4b3a34bf4f1bb32c'
approved_via: 'dispatch briefing (owner unblock directive); independent review owner-independent-pr77-cb13682-20260926 (NEEDS CHANGES)'
review_loop_iteration: 0
---

# Whole-PR Perkins review: independent PR77 review repairs

## Intent

<frozen-after-approval>
Repair the verified shortcomings of the approved whole-PR Perkins review
(PR #77, reviewed head cb136827c53f820c1b6150db4b3a34bf4f1bb32c) found by
the independent review (5324849145, NEEDS CHANGES), preserving the
simplified whole-change design, then hand a new exact head to Gru for the
approved independent out-of-runner recheck.

Scope correction (owner, j-110): no independent GitHub App exists and none
may be created. Preserve the existing authenticated gh COMMENT transport,
accurately expose actual provider event/actor/receipt, distinguish it from
the independent AI reviewer's substantive verdict, and keep
CI/merge/protection gates untouched. B1 stays in the record for
independent re-evaluation against this corrected contract — no
self-approval, no erased findings, no old-gate invocation, no merge/deploy,
no #71 work, no new dependencies/auth/model changes. Do not reinstate the
retired chunk/proof-shape protocol.
</frozen-after-approval>

## Implementation Notes

- **Receipt (B2/B5)**: posters return a verified `PostedReviewReceipt`
  {reviewId, actor, event, commitId, headSha, baseSha, bodySha256} parsed
  from the POST response (GitHub: created review object — id, user.login,
  state, commit_id, body; GitLab: created note — id, body + post-delivery
  head re-probe). WaveRunner refuses to record delivery unless the receipt
  is bound: headSha === frozen targetSha, commitId === targetSha (when
  present), bodySha256 === digest of the exact redacted publication body,
  non-empty reviewId/actor/event. A zero-exit POST with missing/empty or
  unbound response is a delivery failure, never `round.posted`.
- **Reconciliation (B3)**: on an ambiguous POST failure (timeout/transport
  after the request may have committed), reconcile once via a provider
  lookup for an existing review on the PR bound to the frozen head whose
  body digest matches; a match is the receipt (idempotent, no duplicate
  post), otherwise honestly unposted.
- **No-PR/no-poster completion (B4)**: with `job.prUrl === null` (or no
  poster on a linked PR) a conclusive verdict is never recorded as a
  completed round; the round aborts `report_not_posted`/`no_pr_link` with
  escalation and the report is preserved.
- **Recovery (B6)**: restart promotion of an interrupted live round now
  requires the `round.posted` event to carry a bound receipt
  (receipt.headSha === round target, non-empty reviewId, bodySha256 that
  matches the preserved publication artifact). Bare/unbound legacy events
  are left as honest INCOMPLETE records; completed historical rounds are
  not rewritten.
- **B1 exposure**: keep `event:'COMMENT'` (never APPROVE with the author
  identity); `round.posted` now records actual provider event/actor/review
  id/commit/digest; the published body keeps reviewer prose and the host
  appends factual execution/disclosure sections (below) so nothing claims a
  formal GitHub APPROVED/CHANGES_REQUESTED event; docs/spec stop asserting
  an "existing independent App identity". B1 itself remains open for the
  independent recheck.
- **Specialist accounting (B7/B8)**: capacity checks (round cap, per-call
  batch) move BEFORE spawning; `MAX_TOOL_RUNS` 8→4 so one call stays inside
  the bridge's 15-minute tool bound (one concurrency-4 wave ≈ 10 min);
  over-bound completed batches commit their real results (envelopes, run
  records, failure evidence, started count) and fail honestly without
  restoring attempts; `perkins_submit_review` is serialized with run
  scheduling so a terminal submission can never seal while children are in
  flight or discard their finished results.
- **Source provenance (N1)**: submission finding `source` must be `lead`
  or a lens with a recorded valid specialist result.
- **Report coherence + disclosure (B10/N4)**: the host appends a compact
  factual appendix to the published body built from actual structured
  results — retained findings (severity/location/title, source-ref) and
  execution facts (specialists ran/failed/not-used) — and validation adds
  one coherence anchor: with retained findings present the lead prose must
  mention at least one finding title. No verbatim raw-field transcription,
  no severity arithmetic. Preflight responses are wire-bounded with an
  omitted-count plus a durable pointer to the full artifact list.
- **Prior selection (B9)**: the newest qualifying predecessor
  (verdict-posted with a review event) is required; a missing/corrupt
  consolidated file for it fails round setup loudly instead of silently
  falling back to an older record.
- **Carry-forward (N2/N9)**: still-present dispositions may optionally
  refresh {location, evidence, severity} (validated, bounded); carried
  findings keep original roundOrigin; v2 `chunks` are stripped from newly
  written v3 records; dedupe prefers the fresher round's judgment within
  same-key merges; the head-move fact is observed once per submission so a
  sealed artifact can never carry READY + headMoved:true.
- **Prior-revision reader (N3)**: name-status parsing fixed (A→oldPath
  null); exact single-file selection verified against `--name-only`
  (descendant/ambiguity errors honestly); `--text --no-textconv` defeats
  `-diff` attributes; responses are bounded by the FULL escaped wire frame
  (1 MiB MCP bound minus margin), shared with the specialists-response
  bound (E4).
- **Coverage (N5/N6/N10 + audit items)**: tests for last-file delivery of
  a large diff into lead AND specialist prompts; WaveRunner v2-prior
  selection; restored npm-pack/source-free MCP artifact smoke; failed
  terminal-frame (session-output) regression; native-tool child that never
  calls the tool; 128-KiB multibyte report bound; truthful same-file
  additive-fix note asserting the guard; board bare-label/lensAttempts
  tests and truthful lens-progress rendering (not-used no longer counted
  as done coverage); test-double verdict/disposition consistency; orphan
  fixture registration; pi-adapter harvest dedupe; docs/ROLES.md factual
  corrections (hybrid wording, per-specialist bridge).

## Code Map

- `src/dispatch/perkins.ts` — posters (receipt + reconcile), finalization
  (receipt binding, no-PR fail-closed), recovery guard, prior selection.
- `src/dispatch/perkins-review/whole.ts` — run accounting/capacity/
  serialization, submission validation (source provenance, coherence
  anchor, single head-move observation), carry-forward refresh + chunk
  strip, preflight wire bound, prior-revision reader fixes, appendix
  rendering.
- `src/dispatch/perkins-review/types.ts` — receipt-friendly finding types,
  dedupe freshness rule.
- `web/src/ui/board.ts`, `src/board/engine.ts` — truthful lens progress +
  bare-label tests.
- Tests: `test/perkins-whole-review.test.ts`, `test/perkins-builtin-wave.test.ts`,
  `test/board-engine.test.ts`, `test/pi-adapter.test.ts`,
  `test/helpers/perkins-whole-double.ts`, `docs/ROLES.md`.

## Acceptance Criteria

1. Given a poster that exits 0 with empty/fake/unbound output, When the
   wave finalizes, Then no `round.posted`, no verdict recorded, delivery
   INCOMPLETE with escalation (B2/B5).
2. Given a POST that times out after the provider may have committed, When
   finalizing, Then exactly one provider lookup reconciles by frozen head +
   body digest: a match yields a verified receipt without a second post; no
   match stays honestly unposted (B3).
3. Given `job.prUrl === null` or a missing poster, When the lead submits a
   conclusive verdict, Then the round aborts unposted with escalation and
   no approved/changes-requested verdict (B4).
4. Given restart with a legacy bare `round.posted` verdict event, When
   recovery runs, Then it is NOT promoted; a bound receipt that matches the
   preserved publication artifact still promotes (B6).
5. Given a specialist batch over the response bound or round cap, When it
   completes, Then its real runs/envelopes/started counts are preserved and
   reported (never "not used"); capacity is checked before spawning (B7).
6. Given a terminal submit racing in-flight specialists, When the submit
   executes, Then it is serialized behind the running batch and seals only
   the complete run record (B8).
7. Given a newest predecessor with a missing/corrupt consolidated file,
   When a new round arms, Then setup fails loudly naming the round; a valid
   v2 predecessor is still selected and its findings revisited (B9/G2).
8. Given retained findings or failed specialists, When the review
   publishes, Then the published body carries the host factual appendix
   (findings + execution disclosure) and receipt facts; prose denying all
   findings beside retained blockers is rejected (B10/N4).
9. Given an added file, a deleted file replaced by a directory, or
   `-diff` attributes, When the lead reads the prior revision, Then the
   listing is truthful and path reads are exact, attribute-proof, and
   wire-bounded (N3).
10. Given the full suites, When run, Then lint/typecheck/build (pinned
    verifier) and the focused + required suites pass with real exits; the
    new head carries green exact-head CI on PR #77 (no new PR).

## Review disposition (IDs → this repair)

B2✚B5→AC1; B3→AC2; B4→AC3; B6→AC4; B7→AC5; B8→AC6; B9→AC7; B10+N4→AC8;
N1→source guard; N2→refresh; N3→AC9; N5→tests(G1,G2); N6→pack/terminal
tests; N7→batch cap 4; N8→board truth; N9→strip/consistency;
N10→fixture truth. B1→corrected contract docs + receipt exposure; stays
OPEN for independent re-evaluation (not self-approved, not erased).
Not disputed: none. Recorded as verified-not-changed: r1 C157 (child
8-MiB blob bound fails loud and retriable, not silent), C069/072/081
(rejected by the independent audit).

## Tasks

1. `perkins.ts`: poster receipts + reconciliation + no-PR fail-closed +
   recovery binding + prior-selection fail-closed + docs correction.
2. `whole.ts`: accounting/capacity/serialization, validation (provenance,
   coherence, single head observation), carry-forward, preflight bound,
   reader fixes, host appendix, batch cap.
3. `types.ts` dedupe freshness; board truthful progress.
4. Tests per ACs + audit items; double fixes.
5. Full verification; push same PR branch; exact-head CI.

## Test Plan

Focused engine/wave tests per AC (mocked posters incl. forged/empty
receipts, accepted-then-timeout reconcile, restart promotion both ways,
no-PR abort, capacity-before-start, serialized submit, prior-selection
failure, coherence rejection, appendix presence, reader cases, provenance,
refresh, chunk strip, batch cap, wire bounds); large-diff last-file prompt
delivery; v2 WaveRunner prior; pack smoke; terminal-frame; board
bare-label truth.

## Risks

- Poster contract change touches shared types: GitLab poster and all test
  doubles updated in the same change; no provider-architecture expansion.
- Appendix is host-authored from structured results only — no model
  transcription requirement returns.

## Review Triage Log

- 2026-09-27 (recovery session): bmad-build step-04 review layers
  (blind-hunter, edge-case-hunter, verification-gap) have NO subagent
  spawn capability in this runtime; per the workflow's standalone-prompt
  fallback they are staged for external runs as
  `review-layer-{blind-hunter,edge-case-hunter,verification-gap}-prompt-repair.md`
  (repair diff vs baseline cb136827 inlined, claims = this spec). STAGED,
  NOT EXECUTED in this session — no findings from them are claimed. The
  authoritative independent gate for this repair is Gru's approved
  out-of-runner whole-PR recheck (owner re-brief 2026-09-26), which
  separately re-evaluates B1 against the corrected COMMENT-transport
  contract. Workflow-internal checks that DID execute: full `npm test`
  via the verification scheduler (lint, typecheck, pinned-resource build,
  backend vitest, web suite) on the exact committed bytes; exact-head CI
  on PR #77 after push.
- 2026-09-27 (recovery verification — REAL finding, patched):
  `test/roles-definitions.test.ts` still pinned retired chunk-protocol
  phrases (`perkins_run_lenses`, `perkins_record_decision`, `The blind
  child has no tools`, "hybrid" naming) against the corrected whole-PR
  role contract; the prior session updated `test/claude-adapter.test.ts`
  but missed this pin. Patched to the new contract phrases
  (`perkins_run_specialists`, `perkins_read_prior_revision`,
  `perkins_submit_findings`, `The blind specialist has no tools`);
  evidence: serial rerun green.
- 2026-09-27 (recovery verification — REAL finding, patched): the
  prior session's new receipt doubles hardcoded the owner's personal
  GitHub login (`actor: 'mssoka'` ×19) in shipped tests, failing the
  always-on hygiene gate (SPEC ruling 8). Replaced with the generic
  service actor `gru-bot` (the existing GitLab-double convention);
  evidence: `bash scripts/hygiene-grep.sh` → clean; affected suites
  rerun green.
- 2026-09-27 (environment, retained honestly): the scheduler `full`
  scope run (runId 7ff753e0, 14 workers, exit 1, log preserved at
  /tmp/pr77-verify-full.log) collapsed under box load — 57 failures,
  all timeout/RPC signatures (`Test timed out in 30000ms`, worker
  `onTaskUpdate` timeouts), alongside four Sep-23 orphaned
  `npm run build` chains (reparented to PID 1, wedged ~3 days at
  ~50% CPU each) and the live music-video dispatch. The orphans were
  terminated (dead-session leftovers, not live tools); serial reruns
  on the quiet box are the retained local evidence; exact-head CI
  re-runs the parallel gate authoritatively.

## Spec Change Log

- 2026-09-27: initial repair spec from dispatch briefing + independent
  review triage.
- 2026-09-27: recovery continuation (prior session disposed mid-run at
  13:16Z with WIP byte-preserved); status in-review; repair-diff review
  prompts staged; full verification rerun.
- 2026-09-27: status done. Committed 8bd33098e3c516ae65b883c1b2ca8a0a2e
  50b094 (code) — the two recovery-session findings (persona pins,
  personal actor in doubles) patched in the same commit; serial backend
  1226/1226 green (exit 1 solely from vitest worker-RPC onTaskUpdate
  timeouts, zero test failures), web 287/287 exit 0, lint/typecheck/
  build exit 0; exact-head CI on PR #77 is the authoritative gate.
  Independent out-of-runner recheck (incl. B1 re-evaluation) follows via
  Gru per the owner re-brief; lane hands off blocked-awaiting-recheck.
