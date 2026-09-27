---
title: 'PR77 repair pass 3 — remaining verified findings'
type: 'bugfix'
created: '2026-09-27'
status: 'done'
baseline_commit: '2bdbec1255526035726c39f3ddfa1c1ea7f81ef6'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-perkins-whole-pr-review-repair-2.md'
---

<frozen-after-approval reason="owner-authorized repair pass 3 (briefings/pr77-remaining-findings-repair-3-20260926-approved.md + authority JSON); approval authority is the owner's written 'fix them' authorization, recorded here because this lane is dispatched, not interactive">

## Intent

**Problem:** Independent review 5327225567 (NEEDS CHANGES) at head `2bdbec1255526035726c39f3ddfa1c1ea7f81ef6` verified 20 root-cause groups (R1–R13, R15–R21) plus retained prior obligations (T6–T15, N3, N5, N8, N10, B2, B3, B6, B7, B10) in the whole-PR Perkins review: unbound restart-recovery receipts, GitLab historical-note reconciliation that fabricates delivery, first-page-only lookups, silent 50-finding cutoff, hostile-Markdown and contradiction reporting gaps, specialist cleanup/nondelivery loss, quoted-path prior reads, misattributed provenance, and missing behavioral proofs (board DOM label, ledger actor/event pin, >3000-line prompts, real crash recovery, guard invocation, deleted-file shape, v2 WaveRunner integration).

**Approach:** One repair pass on the existing branch/PR: a shared writer/reader posted-event contract with round-owned publication path and strictly bound receipts; provider-appropriate receipts (COMMENTED-only GitHub, fail-closed GitLab note reconciliation, authenticated-author matching, bounded pagination); complete sanitized disclosure and contradiction-aware coherence; settlement-preserving specialist accounting with durable nondelivery facts; machine-readable exact-file prior reads; and real-path behavioral tests including a disposable-child-process crash recovery.

## Boundaries & Constraints

**Always:** Preserve T1–T5 fixes and all prior accepted behavior; fail closed on unprovable GitLab historical notes (no new correlation protocol); use existing `gh`/token identity paths (no hard-coded accounts, no new App/auth/credentials); an accepted REQUEST_CHANGES stays successful completion; keep lead-owned substantive judgment (no blocker arithmetic, no lens/chunk matrices, no verbatim transcription); record real failing regressions before fixes; exact-head CI on the final pushed head; preserve historical records and failed attempts unchanged.

**Never:** No merge/deploy/self-approval, no `/api/dispatch/review` or legacy r3 retry, no new dependencies, no force-push/reset/rebase/new PR, no R14/E4 watchdog/cancellation redesign, no unrelated board styling or backlog work, no touching the parked board worktree, movie task, PR76, #71, or GC scope.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Restart recovery, real writer event | posted event w/ bound receipt + canonical publication file + digest | round completes, no republish, `round.post-recovered` | N/A |
| Restart recovery, malformed/foreign | receipt null/{} , wrong repo/PR/actor/event/commit, aliased path, digest mismatch | round stays interrupted; other rounds still recover; startup never crashes | escalate 'unbound round.posted' |
| GitLab ambiguous post | body-matching note by any author exists | reconcile THROWS unresolved; no verdict recorded; no second POST | 'cannot prove which head or attempt' |
| GitLab ambiguous post, no note anywhere | full bounded pagination finds none | reconcile returns null; stays unposted | N/A |
| GitHub reconcile, later page | match beyond page 1, correct author/state/commit | found, recorded once | page-cap exhaustion throws unresolved |
| Publication >50 findings | 60 retained findings | ALL 60 listed sanitized; body ≤ limit posts | over-limit fails explicitly with complete local overflow artifact |
| Hostile title/location | embedded newlines/Markdown | single-line inline-code rendering; no spoofed headings/facts | N/A |
| Contradictory report | 'no issues' prose + retained findings, one title named | submission rejected, actionable missing-titles feedback | bounded issue list |
| Dispose-error artifact write fails | settled child + failing artifact write | settled result + budget kept; cleanup-recording failure disclosed | never throws after settlement |
| Over-bound batch response | valid children, transport overflow | runs recorded `findingsDelivered:false`; appendix/ledger/notes disclose | lead proceeds truthfully |
| Quoted/deleted prior paths | Git-quoted names, file→dir replacement, D file | exact-file check via `name-only -z`; `{status:'D',oldPath,newPath:null}` | ambiguous selection rejected |

</frozen-after-approval>

## Code Map

- `src/dispatch/perkins.ts` -- recovery (recoverInterruptedRounds ~:820-1010), posters (GhPrPoster/GitLabMrPoster/AutoVerdictPoster :205-620), verifyPostedReceipt, hostDisclosureAppendix :94-135, recordDelivery/deliveryInput :1735-1900, recordLensResults :2032-2090
- `src/dispatch/perkins-review/whole.ts` -- runSpecialist dispose path :860-1010, runTool overflow :985-1045, priorRevisionTool :1071-1145, validateSubmission :1330-1480 (finding-source, report-coherence), specialistRuns assembly :1245-1270, leadPrompt :1560-1605
- `src/dispatch/perkins-review/types.ts` -- SpecialistRun/VerifiedFinding shapes; extend, do not break v2 read compat
- `web/src/lib/board-signals.ts`, `web/src/ui/board.ts` -- roundSummary/lensProgressLabel/jobSignal progress truth
- `test/perkins-whole-review.test.ts`, `test/perkins-builtin-wave.test.ts`, `web/src/lib/board-signals.test.ts`, `web/src/ui/board.test.ts` -- suite homes; `test/helpers/perkins-whole-double.ts` fake lead/children
- `src/main.ts:691-712` -- production poster wiring + startup recovery await (no change expected; verify no crash path)
- Evidence: `/Users/moses/.gru-command/reviews/owner-independent-pr77-2bdbec1-20260926/` (review.md, triage/*, posting-receipt.json)

## Tasks & Acceptance

**Execution:**
- [x] `src/dispatch/perkins.ts` -- shared posted-event contract: writer payload builder + strict recovery parser/binding validator (actor/event/commit/host/url/reviewId shapes, canonical round-owned publication path, symlink refusal, digest equality); per-round try/catch so malformed rounds never abort startup recovery; GitHub receipts require numeric/string id (no `String(null)`), COMMENTED state, authenticated `gh api user` actor match on post+reconcile; bounded multi-page reconcile with unresolved-exhaustion; GitLab reconcile fail-closed throw on any author-matching note, null only on exhaustive absence; appendix renders ALL findings with provider-appropriate publication line + >limit explicit overflow failure -- R1 R2 R4 R5 R6 R7 R13 R21 B2 B6 T6 T7 T8 T9
- [x] `src/dispatch/perkins-review/whole.ts` -- settle-preserving dispose (never throw after settlement; record cleanupRecordingError; no budget restore for settled runs); `findingsDelivered:false` on overflow batches into runs/consolidated; provenance: lens source requires a delivered finding with the same title; report coherence: every retained title must appear (whitespace-normalized); exact-file prior read via `diff --name-only -z` + blob existence, replacing header regex -- R8 R10 R11 R12 R17 T10 T11 N3
- [x] `src/dispatch/perkins.ts` + `web/src/lib/board-signals.ts` + `web/src/ui/board.ts` -- ran = used+failures label, settled progress, failure history retained in done lens notes -- R9 T12 T14 N8
- [x] `test/perkins-whole-review.test.ts` (+ double) -- red-first regressions: quoted-path exact-file, file→dir refusal, D-listing, >3000-line last-file sentinel in lead AND child prompts, guard invocation with malformed/valid input, coherence accept/reject, provenance empty-lens rejection, dispose-artifact-write failure keeps result, overflow marks nondelivery, >50 findings appendix, hostile markdown sanitization, 60-finding overflow failure -- R11 R15 R18 R20 T9 T11 T15 R10 R17 R8 T10
- [x] `test/perkins-builtin-wave.test.ts` -- ledger actor/event pin, v2-predecessor WaveRunner integration (old record unchanged, v3 chunk-free), disposable-child-process crash between posted event and verdict with real unswept lane, recovery-negative matrix incl. receipt:null, GitLab fail-closed + pagination, GitHub author/pagination, COMMENTED-state refusal, null-id refusal -- R16 R19 N5 R1 R3 R4 R5 R6 R13 T7
- [x] `web/src/lib/board-signals.test.ts` + `web/src/ui/board.test.ts` -- ran-count unit + rendered `.board-round__lens-progress` DOM label and chip title assertions -- R9 R15 T14

**Acceptance Criteria:**
- Given a real writer round.posted event, when recovery runs in a fresh process, then only the correctly bound round completes without republishing; malformed/foreign/null evidence leaves it interrupted without crashing other rounds.
- Given a GitLab body-matching historical note, when reconcile runs, then no delivered verdict is fabricated (throw), and exhaustive absence alone returns null.
- Given 60 retained findings or hostile Markdown, when the body is built, then all findings appear sanitized or delivery fails explicitly with complete local evidence — never a silent partial list.
- Given a settled child whose dispose-error artifact write fails, when the batch completes, then its result, findings, and attempt budget survive and the cleanup-recording failure is disclosed.
- Given a >3000-line multi-file diff, when lead and specialists are prompted, then the last-file sentinel is present in both actual prompts.
- Given a crashed child process (SIGKILL between posted event and verdict), when the parent restarts recovery, then the round completes from the persisted event with the lane unswept and no second POST.

## Implementation Notes

- Shared posted-event contract exported from `perkins.ts`: `PostedEventPayload`, `parsePostedEventPayload` (throw-free strict parse), `postedEventBindingProblem` (WaveRunner method) — writer `recordDelivery` now emits exactly this shape; recovery parses it. Receipt `baseSha` is required (real `PostedReviewReceipt` carries it).
- `MAX_RECONCILE_PAGES = 10`; GitHub reconcile pages `?per_page=100&page=N`, author+state(COMMENTED)+commit+body match; exhaustion throws unresolved. `GhPrPoster.resolveAuthenticatedLogin` caches `gh api user --jq .login`; R13: ids must be safe integers or nonempty strings.
- GitLab reconcile: pages notes, filters authored body matches, returns null ONLY on zero matches; any authored match throws fail-closed (R3). `resolveAuthenticatedUser` via `GET /api/v4/user` with the same token.
- `hostDisclosureAppendix(review, provider)` renders ALL findings as sanitized inline-code spans (`renderUntrustedInline`: control-char collapse, backtick neutralization, visible truncation); provider-appropriate publication line (github/gitlab/unknown from URL FORM); `publicationBodyFor` enforces `PUBLICATION_BODY_MAX_BYTES = 60_000`; `deliveryInput` writes `perkins-report.publication-overflow.json` and fails delivery on overflow.
- whole.ts: `runSpecialist` never throws after settlement — dispose-artifact failures try one alternate name, then carry `cleanupRecordingError` in-memory; `undeliveredRuns` set stamps `findingsDelivered:false` through `commitResults`; provenance getter `deliveredLensFindingTitles` backs the R12 rule; report coherence requires EVERY retained title (whitespace-normalized) with a bounded missing-list message; prior-revision exactness via `diff --name-only -z` + `cat-file -t` blob existence (zero matches = unchanged file or rejected nonexistent).
- Board: `RoundSummary.ran` = used + error-lenses-with-attempts; `lensProgressLabel` renders `N/M lenses ran · X failed · Y not used`; live pill counts settled (done+failures).
- New test infra: `test/helpers/persisted-review-port.ts` (file-backed lane registry — the honest cross-process analogue of the production WorktreeManager) and `test/perkins-crash-child.test.ts` (disposable SIGKILL child; skipped unless `PERKINS_CRASH_CHILD` is set). The parent spawns `node node_modules/vitest/dist/cli.js` ASYNC (spawnSync starved the pool RPC).
- Existing-test alignment: gh doubles answer the new `user` probe; `receipt.baseSha` added to crafted receipts; `setJobPr` before event crafting (stale JobRecord pitfall); pi-adapter + claude-double stub reports now account for every retained finding (the T11 rule caught real incoherence in both stubs); suite-shape pins bumped (73/64/1).
- RED evidence (before fixes): `npx vitest run test/perkins-builtin-wave.test.ts -t 'repair pass 3'` → 18 failed/2 passed; `... test/perkins-whole-review.test.ts -t 'repair pass 3'` → 5 failed/3 passed; web board tests → 6 failed/39 passed. All green after the fixes.
- Environmental, evidenced: vitest forks-pool `onTaskUpdate` RPC timeouts reproduce on UNMODIFIED baseline groups (`npx vitest run test/perkins-builtin-wave.test.ts -t 'WaveRunner delivery receipts'` → 9 passed, 1 error, exit 1); the full suite is clean with `--pool=threads --poolOptions.threads.singleThread` (exit 0, 1267 passed). The e2e `chat-light-darwin.png` screenshot mismatch ALSO fails at the stashed baseline (verified) — pre-existing rendering drift, not this change.

## Spec Change Log

## Review Triage Log

First step-04 pass — three context-free layers (blind-hunter, edge-case-hunter, verification-gap) over the 152,002-byte diff, run as separate headless sessions; every finding triaged below.

| Finding | Verdict / route | Evidence |
|---|---|---|
| B1 GitLab path-form regex typo `~-/merge_requests` | medium / patch (fixed) | `src/dispatch/perkins.ts:99` matched `~-` not `-`; custom-host MRs fell to 'unknown'. Fixed + `publicationProviderKindFor` unit test incl. custom-host MR. |
| B2/E1/V3 size check precedes redaction | medium / patch (fixed) | Redaction's fixed placeholders can expand bytes (layer demonstrated 56,481→77,481). Final redacted bytes now enforced + a `token=x ×7000` expansion test refuses publication. |
| B3/E2/E3 identity caches ignore host | medium / patch (fixed) | One poster serves many hosts. Per-host Maps (`authenticatedLogins`/`authenticatedUsers`) + two-hosts/two-accounts test. |
| B4 EEXIST on dispose-error artifact treated as recorded | false | Write-once store with unique runToken per run; a same-name collision means the identical record already exists. No reachable divergent outcome demonstrated. |
| B5 provenance binds by title alone | low / rejected | Deliberate bounded anchor (spec Design Notes); title+location-ID binding would grow the submission schema (public surface) beyond a direct correction. The empty-lens misattribution R12 closed. |
| B6 'no issues' prose beside all titles passes | false | The all-titles rule plus the complete authoritative host appendix are the chosen T11 design; sentence-level clean-claim detection is the brittle keyword prohibition the owner excluded. |
| B7/E5 verdict contradicts canonicalVerdict promotes | medium / patch (fixed) | Parser now enforces approved↔READY TO MERGE and changes-requested↔NEEDS CHANGES/MAJOR REWORK; negative recovery case added. |
| B8 recovery ignores baseSha coherence | false | baseSha is the PR's LIVE base at delivery (never frozen); no authoritative comparison target exists at restart — head/target binding is the boundary. |
| B9/E4 event binding ignores provider form | medium / patch (fixed) | Binding now derives the provider kind from job.prUrl: github-form requires COMMENTED+commit-bound; gitlab-form requires note+null; negatives added. |
| B10 parent-dir symlink aliasing | false | `reviewArtifactDirectory` rejects a symlinked roundId dir and any escape from the root (`ensureDirectoryWithoutSymlinks` + `contained`), and the payload path must resolve exactly to the canonical path. |
| B11 `ran` counts done-without-attempts | false | Production's only zero-run done note is the 'not used —' prefix writer; the discriminator and the count share one writer. |
| B12 chmod-based test is root-fragile | low / rejected | CI runners are non-root; 0o500 blocks owner writes there. Environment-specific to root execution, which CI is not. |
| E6 titles hidden in HTML comments pass | medium / patch (fixed) | Coherence matching now strips `<!-- -->` before normalizing. |
| E7 recovery never compares event.host | false | `event.url === job.prUrl` binds to the authoritative record; host is redundant metadata and the provider kind now derives from the same authoritative URL. |
| V1 GitLab POST lacks author check | medium / patch (fixed) | `resolveAuthenticatedUser` now runs before the note POST; mismatched-author test added; pre-existing GitLab POST tests' doubles answer `/user` and count the probe. |
| V2 undelivered lens note untested through WaveRunner | medium / patch (fixed) | New WaveRunner over-bound batch test asserts the persisted ledger lens note carries the NOT-delivered fact. |
| V4 batch.error path commits valid runs as delivered | medium / patch (fixed) | `commitSettled` error path now stamps `findingsDelivered:false` on committed valid runs before throwing (defense in depth; `runSpecialist` no longer rejects after settlement). |

No intent_gap or bad_spec entries; all patch items applied and re-verified (full suite EXIT 0, 1272 passed; web 290 passed; lint/typecheck/build green).


## Design Notes

- Recovery event whitelist: `event` must be `COMMENTED` (commitId===target) or `note` (commitId===null); unknown hosts stay acceptable (fixture/enterprise hosts) but unknown events/commit bindings are unbound.
- Provenance anchor is exact title equality against the specialist's delivered findings — reworded findings source as `lead` (documented in the validation message).
- Coherence check is all-retained-titles-present (normalized whitespace), not keyword bans; quoted/nuanced prose passes because titles appear.
- Publication bound: 60,000 bytes combined body (GitHub review-body limit 65,536 minus margin); overflow artifact `perkins-report.publication-overflow.json`.
- Crash fixture: vitest child (`node node_modules/vitest/dist/cli.js run <child-file>`) kills itself (SIGKILL) inside `setRoundVerdict`; parent asserts exit signal, unswept lane, then recovers. Fixture dirs are parent-owned.
- R14/E4 excluded (unverified); R3 keeps lead-owned judgment intact.

## Verification

**Commands:**
- `npx vitest run test/perkins-whole-review.test.ts test/perkins-builtin-wave.test.ts` -- expected: all pass, exit 0
- `npm run test -w web` -- expected: unit + DOM suites pass
- `npm test` -- expected: lint + typecheck + build + backend + web all green, exit 0
- `npm run e2e -w web` -- expected: browser e2e green (if environment allows; record honestly otherwise)

**Manual checks (if no CLI):**
- Push final head; record exact-head CI run URL/verdict; lane left BLOCKED AWAITING FRESH INDEPENDENT RECHECK.
