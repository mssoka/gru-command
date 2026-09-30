---
title: 'PR130 Perkins App publication: fresh-main integration'
type: 'chore'
created: '2026-09-30'
status: 'in-progress'
route: 'dispatch'
baseline_commit: 'd1391b65143e32b4d09a1e2a5d6cee038d87ad58'
investigated_main: 'c54bfbf89727bacfd27a27db65a9fab681c19c3e'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** PR #130's installed-App publisher is conflicted after the main integration wave. Prior exact-head CI passed, but scheduled local full verification failed and remains failed. Reviewing identity must still be the installed Perkins App, not a personal account.

**Approach:** Reconcile the existing candidate with freshly fetched main, preserve its approved authorship-only intent, then complete independent review, serialized verification, and exact-head CI before handing settled source to Silas. Integration is not deployment or live acceptance.

**Head strategy (owner decision 2026-09-30, correlation gru-pr130-history-preserving-approved-20260930):** history-preserving integration merge. Fetch fresh origin/main, record its full SHA, merge it into this existing branch, resolve conflicts narrowly, preserve both commits and later work, then normal non-force push to the existing PR #130 branch. This supersedes only the previous rebrief's "rebase onto fresh main" wording; rebase and any force push remain unauthorized.

## Boundaries & Constraints

**Always:** Preserve source history, receipts, reports, and WIP. Check this job's native-round state before head moves; defer while a round is pending/live. Preserve COMMENT-only publication, exact head/body, origin validation, bounded provider-proved reconciliation, fail-closed App authentication, and unchanged no-bundle/GitLab routes. Credentials come only from trusted runtime configuration; tests use synthetic keys and mocked HTTP. Use the shared verification scheduler for broad/service-spawning checks; retain complete output and failed exits. Maintain at least 36 GiB free disk and coordinate heavy workloads/media checkpoints.

**Never:** No force push without a revised decision, live App-key reads/minting, canaries, credential provisioning, production config changes, deployment, restart, or PR merge. Keep `src/dispatch/perkins.ts` read-only; return an exact bounded hook to Gru before shared-contract edits. Do not change upstream freeze/source semantics, UI, notifications, or foreign WIP. Never claim App activation from mocks or native reviews posted by the deployed personal publisher.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|--------------|-------------------|----------------|
| Integration | App injection overlaps residency wiring | Keep App selection and upstream options | Review resolved diff, not unconditional side selection |
| Collision | This job has a pending/live native round | Reviewed head stays unchanged | Defer head movement until settlement |
| Failed gate | Candidate verification fails | Preserve evidence; no delivered claim | Stop broad reruns and report the failed gate |

</frozen-after-approval>

## Code Map

- `src/main.ts` — sole merge-tree conflict. Keep `createStartupVerdictPoster(config)` alongside upstream `reserveReviewRound`, `maxConcurrentChildren`, and `bus`; preserve queued-handoff startup wiring.
- `src/dispatch/perkins-github-app.ts` — existing isolated parser/auth/publisher/factory; consume current poster and receipt interfaces.
- `src/dispatch/perkins.ts` — read-only receipt/recovery authority. Upstream adds residency/handoffs, not a changed poster input shape.
- `test/perkins-github-app.test.ts` — 52 existing synthetic-key/HTTP tests, including startup selection; never discover the real credential home.
- `test/suite-shape.test.ts` — retain App and main-side pins; preflight merges cleanly.
- `docs/PERKINS-APP-PUBLICATION.md`, `docs/CONFIG.md`, `docs/FLOW.md` — publisher contract and owner activation boundary; CONFIG/FLOW preflight merges cleanly.
- `.gru-command/worktree.toml` — scheduler scope `full = "npm test"`; never bypass it or tune the host/service to obtain green.

## Tasks & Acceptance

**Execution:**
- [x] `src/main.ts` — resolve integration using the approved head strategy; retain App selection and upstream wiring.
- [x] `src/dispatch/perkins-github-app.ts`, `test/perkins-github-app.test.ts`, `test/suite-shape.test.ts` — check compatibility and close material independent findings with deterministic regressions. Shared publisher source needs prior coordination.
- [x] `docs/PERKINS-APP-PUBLICATION.md` — correct statements affected by accepted findings, without claiming live success.
- [ ] This spec — append source refs, independent review binding, gate results, and disposition. Private transcripts/verification evidence stay outside the repository.

**Acceptance Criteria:**
- Given fresh main and the approved strategy, when integration completes, then main is included, only lane-owned changes remain in the PR diff, and no WIP is lost.
- Given a pending/live round, when integration would move its source, then no head moves until settlement.
- Given integrated source, when scheduled verification and exact-head CI complete, then every required green result is evidenced without erasing historical failures.
- Given final source, when independent BMAD review completes, then reviewer identities and exact diff binding are recorded before Silas starts a native whole-PR round.

## Implementation Notes

- 2026-09-30: Owner decision recorded (gru-pr130-history-preserving-approved-20260930): history-preserving integration merge; answered Open Question removed; no rebase/force push.
- State recheck before writing: lane HEAD 7980e32 clean, remote branch/PR #130 head d1391b6, no rounds for this job, no pending_rebrief markers, no other writer/process in the lane.
- Fresh origin/main fetched: 128cdb8babed472464b3de0d1078929cec5ac4e1 (Merge PR #139).
- Integration merge committed: 3c2b079 (parents 7980e32, 128cdb8). Conflict inventory: exactly one content conflict, src/main.ts WaveRunner construction, resolved to keep `poster: createStartupVerdictPoster(config)` alongside upstream `reserveReviewRound`/`maxConcurrentChildren`/`bus` plus `wave.resumeQueuedHandoffs()`. Auto-merge audit for files changed by both sides (docs/CONFIG.md, docs/FLOW.md, test/suite-shape.test.ts): both sides' edits retained (verified per file against each parent). PR diff vs fresh main = lane-owned files only.
- Integration repair committed: 8e1eab6 — suite-shape pins dropped by the main merge wave, verified by the file's own static counter and cross-validated by the independent identical repair in lane revert-compaction-137 (c0d0ec2): github-poll 22->24, owner-actions added at 8 (its static count; runtime 28 via its case loop).
- Focused pre-checks (direct, 2-file suite; not the official gate): run1 failed (missing pins + unhandled worker-RPC timeout because the direct npx invocation bypassed the repo `pretest` patch), run2 failed (github-poll pin), run3 green 54/54 after repairs. Logs and hashes under delivery/verify/integration/.
- Independent review round (integration final diff 128cdb8..8e1eab6, staged sha256 7ad798c69c22d2f820f0122b5a75595ea7cb2a13203c5a12ec2d172e74f1ac8d): five fresh read-only sessions under delivery/independent-review-integration/.
- Review closures committed: 83802c2 (findings), 5ccde5b (recheck findings), 5489fa7 (final-delta findings), b6dca64 (final-delta guard snippets + closing hardening); inherited repairs 30bb354. Staged hashes: recheck 25a5d48a..., delta e3fac918..., final-delta fixes ff2f75b9..., closing 2138ceee.... Focused after each: 68/68, 70/70, 74/74, 77/77 (perkins-github-app + suite-shape; pin 52→66→67→68→72→75). No `src/dispatch/perkins.ts` edit.
- Shared-contract boundary note for Gru: `VerdictPosterInput` carries no abort signal, so a bounded reconciliation can run up to its page/timeout budget after a round is cancelled; `perkins.ts` was left read-only per the ownership rule.
- 2026-09-30 (rebrief continuation, j-465 history-preserving integration): state recheck before writing: lane HEAD c72ade7 clean, published PR #130 head d1391b6, fetched origin/main c150abec (PR #147 compaction-rollback line), no other writer/round. T4 override removal committed first (ea8fc7b, see Spec Change Log). Normal main-into-feature merge of c150abec: clean 'ort' merge, conflict inventory EMPTY (auto-merged docs/CONFIG.md — both sides' edits retained — and test/suite-shape.test.ts — all five pin deltas combined). Verification of the merge result: all 98 suite pins statically match actual registrations; every main-only rollback file (config/pi-adapter/supervisor + their tests) byte-identical to main; lane-owned App files (perkins-github-app.ts, main.ts `createStartupVerdictPoster` wiring, PERKINS-APP-PUBLICATION.md, perkins-github-app tests) untouched by the merge; `src/dispatch/perkins.ts` untouched this turn (its delta vs the published head predates this session, commits f31249a/1a7a1a4/f783681/4875138, preserved as instructed); j-463 vitest worker-RPC pretest hook unchanged; no proactive_compact_percent / provider-health compaction deferral / wrapper five-minute abort resurrected (the only remaining references are main's own fail-loud rollback pins). Non-force push to the existing PR #130.
- Scheduled full runs: `e35309ee` on 821ed30 failed 1/1534 (chat-server adoption race; repaired 4ee38fb); the rerun on the repaired candidate and its run id are recorded in the delivery receipt. Inherited full-gate repairs carried by this lane (all test-only, disclosed): suite-shape pins, wizard no-TTY isolation, chat-server adoption wait. (Correction 2026-09-30: the earlier "T4 bound" item is withdrawn — the explicit 180s timeout on the T4 WaveRunner test was an unauthorized verification-bound extension and has been removed; the cross-validation cited against revert-compaction-137/4bc28b8 was invalid because that source carried the same extension, later ruled unauthorized and removed on PR #147. Accepted current main ends the T4 test with the inherited suite default.)
- 2026-09-30 (source-only repair turn; failed-FULL completion loop, correlation silas-ops-pr130-failed-full-and-advisory-repair-20260930T205959Z): the first final FULL on the repaired head `91bec13` (run `38f5a70a-cda3-4601-ade0-d70850d1a693`, ledger seq 32802) FAILED on three 30 s test timeouts — `dispatch-e2e` full heist arc, `perkins-builtin-wave` T4, `wizard --answers` secrets — with lint/typecheck/build green and 1526 passed. Static causality mapping only (no rerun, no runner/timeout/assertion change): none of the three failures awaits any module this PR changes (in-memory doubles; pre-existing WaveRunner; the compiled wizard), the same T4 and wizard timeouts reproduced on an unrelated lane's full run that does not contain this PR's test file, and the three failing windows did not overlap this lane's added test file. No causal proof of a diff defect exists statically; a single narrow same-runner scheduler discriminator (the three failing files alone on an idle host, unchanged runner/flags/oracles/budgets, one run) is declared as the named verify scope `publisher-timeout-discriminator` in the lane `.gru-command/worktree.toml` so ops can invoke it through the authenticated scheduler; it was neither scheduled nor executed, and a focused green would be a non-reproduction/latency observation only — never proof of cross-suite contention and never a FULL waiver.
- 2026-09-30 (same turn): triaged the 16 raw final-diff candidates delivered against `91bec13` (11 adversarial + 3 edge + 2 verification). The adversarial gate's input-scope variance (an undeclared `@types/node` read and a wrapper-skill read) is preserved as RAW ONLY; no advisory approval or native clearance is claimed, and a genuinely fresh exact-head compliant review remains required after this head moves. Fourteen candidates were accepted (six source repairs, four source-evidenced regression oracles, three doc corrections, and the Link-rule code/doc alignment), one was a duplicate of an accepted repair (bundle-dir special bits), and one was rejected with counter-evidence as a duplicate of a prior binding adjudication (shared-verifier plain-Error escape: unreachable today by construction; no test can discriminate a widened catch).

## Spec Change Log

- 2026-09-30 (rebrief continuation): Removed the unauthorized 180s timeout extension on the T4 WaveRunner reconciliation test — the test now ends with the inherited suite default, exactly as accepted on current main; every T4 assertion is untouched. Corrected the stale cross-validation note: revert-compaction-137/4bc28b8 carried the same rejected extension, so it never validated this bound; the identical extension was ruled unauthorized and removed on PR #147. No assertion, product, or other timeout change.
- 2026-09-30 (source-only repair turn, correlation silas-ops-pr130-failed-full-and-advisory-repair-20260930T205959Z): closed the accepted final-diff findings against `91bec13` — POSIX Windows-form key_path refusal, exact-`0700` bundle-dir mask (`0o7777`), constructor absolute-root validation, integral `maxReconciliationPages`, no-Link-header-only short-page absence, sanitized-only HTTP error state, and the clock-skew/growth/operator-prerequisite doc corrections — with seven new regression tests (suite pin 79 -> 86). No timeout, runner, assertion-weakening, or budget change; the failed FULL's three timeouts are mapped statically and one same-runner discriminator is staged for ops.

## Review Triage Log

### Round 1 — five fresh read-only BMAD lens sessions on the final diff (candidate 8e1eab6; staged sha256 7ad798c6...)

| Finding (lens) | Disposition |
|---|---|
| bundle root vs `data_dir` (adv/struct) | Accepted: `resolvePerkinsAppBundleRoot` (instance dir first, relocated data-dir fallback), docs + tests |
| unprovable 2xx receipt / 'unknown' id escape (adv/ec) | Accepted: usable-id helper (safe positive int or quoted string ≤200), `PerkinsAppError` routed into reconciliation + tests |
| `main.ts` wiring unpinned (adv/vg) | Accepted: static source pin in the suite |
| recovery walk depth vs shared 10 (adv) | Accepted: default 10 — and the underlying re-jump defect was found and fixed (coverage was capped at {1,last,last−1}) |
| PR URL unsanitized in diagnostics (adv/ec) | Accepted: both branches sanitized + tests |
| non-github.com GitHub hosts lack a boot signal (adv) | Not adopted: fail-closed at publication with an actionable error; boot-time remote scanning is outside this integration's scope. Recorded. |
| key_path `..`/absolute untested (adv) | Accepted: `resolvePerkinsAppKeyPath` exported + three tests |
| doc mode-class mismatch (adv/prose) | Accepted doc-side (exact classes; dir exactly 0700) |
| spec artifact unpopulated (adv) | Accepted: populated with this record |
| absence-certificate snapshot assumptions (adv/ec) | Accepted: max-tracked lastPage + growth/shrink regressions |
| factory root validation (adv) | Accepted: named errors + tests |
| dangling-symlink test used production fetch incidentally (adv) | Accepted: fetch double + zero-call assertion |
| no-fallback test read a private field (adv) | Accepted: behavioral assertions |
| selection EACCES race (ec) | Accepted: non-ENOENT stat stays present |
| file size cap (ec) | Accepted: cap + bounded same-descriptor read |
| UNC key path (ec) | Accepted: regex + exported-resolution tests |
| page=0 last link (ec) | Accepted: page ≥ 1 validation + test |
| gh preflight dependency + FLOW over-claim (vg) | Accepted docs-only: FLOW grounded to publication; activation notes the retained preflight dependency |
| structure/prose rows (struct/prose) | Accepted: class order, explicit ambiguity seam, mode-selection merge, runbook/Windows/prose fixes |

### Round 2 — three fresh read-only recheck sessions on the updated diff (candidate 83802c2; staged sha256 25a5d48a...)

| Finding (lens) | Disposition |
|---|---|
| all eight claimed closures | Verified closed (edge-case-hunter returned empty findings) |
| `Math.max` shrink direction unpinned (vg) | Accepted: shrink-direction regression (assignment would certify {1,5,4}) |
| no-Link short-page absence certificate (adv) | Not adopted: this is the provider's own end-of-list signal (Link headers are absent only when no further pages exist) and the legacy posters' identical rule; requiring more would leave every single-page reconciliation unresolved. The rule is now stated in the operator doc. |
| unbounded provider reply buffering (adv) | Accepted: 16 MiB ceiling with an options seam + test |
| fstat→read TOCTOU on the bundle cap (adv) | Accepted: bounded `readSync` on the same descriptor |
| sanitize word-boundary gap + URL shape coverage (adv) | Accepted: unanchored token/JWT patterns, URL tests cover PAT/JWT/embedded cases |
| zero/negative review ids (adv) | Accepted: ids require ≥ 1 |
| rate-limit classifier over-match (adv) | Accepted: narrowed to `rate limit`/`abuse detection` |
| `VerdictPosterInput` carries no abort signal (adv) | Recorded shared-contract boundary note for Gru; `perkins.ts` remains read-only. |

### Round 3 — final delta check over the recheck-fix commit

- Fresh adversarial session over the recheck-fix delta (candidate 5ccde5b; staged sha256 e3fac918...): closures 1/3/5/7 verified and pinned; refinements accepted and applied in 5489fa7 — true streaming byte budget for provider replies, status-first classification of oversized refusals, symmetric rate-limit tightening, construction validation of the reply ceiling, zero/negative id pinning, stronger sanitize assertions + benign-text pin, neutral growth wording. One follow-up delta check (candidate 5489fa7; staged sha256 ff2f75b9...) records the final verification of those applications.

### Inherited full-gate repairs (not PR130's diff)

- The focused probes on this lane reproduced two inherited main-lineage failures: the wizard no-TTY test (exit 1 due to an ambient instance config the loader rejects) and the T4 WaveRunner test sitting at 22.4s against the 30s default on this shared host. The wizard no-TTY isolation is repaired test-only in commit 30bb354 and stays carried by this lane. The second item — the explicit 180s timeout 30bb354 gave the T4 test — is withdrawn: it was an unauthorized verification-bound extension, not an accepted repair; the same extension was ruled unauthorized and removed on PR #147, and accepted current main ends this exact test with the inherited default. The earlier cross-validation citation of revert-compaction-137/4bc28b8 was stale (that source carried the same rejected extension). All T4 assertions are untouched; no product behavior changed.

### Round 4 — final-diff candidates against `91bec13` (16 raw: 11 adversarial + 3 edge + 2 verification)

Raw reviewer outputs, including the adversarial gate's declared input variance (an undeclared `@types/node` read and a wrapper-skill read), stay preserved and unmodified outside the repository; this output is RAW ONLY — no advisory approval, third gate, or native clearance is claimed, and a fresh exact-head compliant review is required after this head moves. One row per candidate, against the actual source and the approved App-publication contract:

| # | Lens | Candidate | Disposition | Repair / counter-evidence |
|---|---|---|---|---|
| 1 | adv | Windows-form `key_path` used verbatim on POSIX: not absolute, so `lstatSync`/`openSync` resolve it against the process CWD | accepted | `resolvePerkinsAppKeyPath` refuses drive/UNC forms by name off win32 (POSIX-absolute or bundle-relative only); regression covers drive, slash-drive, and UNC forms plus a load-level refusal; doc bullet corrected. |
| 2 | adv | `bundleDirSafe` masks `0o7000`, so setuid/setgid/sticky dirs pass while docs promise exactly 0700 | accepted | mode check is now `(info.mode & 0o7777) !== 0o700` (mirrors the file check); `02700` regression with a chmod-carried check. |
| 3 | adv | exported `PerkinsAppPrPoster` accepts a relative `instanceDir` and reads `<cwd>/perkins` | accepted | constructor now runs `requireBundleRoot(options.instanceDir, ...)`; direct-construction assertions added beside the factory ones. |
| 4 | adv | `maxReconciliationPages` accepted as 0/-1/NaN/1.5 while the body cap is strictly validated | accepted | `Number.isSafeInteger(n) && n >= 1` validation with a named error; construction tests for 0, -1, 1.5, NaN and an accepted 1. |
| 5 | adv | `verifyPostedReceipt` plain-Error branches escape the 2xx reconcile catch on future drift | rejected — duplicate of the prior binding adjudication (prior triage #9), independently re-verified | Unreachable today: `receiptFromReview` pre-validates every field the shared verifier re-checks (head = targetSha, commitId = targetSha, digest equality, usable id, verified bot actor, COMMENTED event), so no error from that block can be a non-`PerkinsAppError`; no test can discriminate a widened catch. Recorded as future-only. |
| 6 | adv | doc claims delivery proof requires submission "at or after this round's POST began", code credits `postStartMs - 60_000` | accepted docs-only | Bullet now states the real predicate ("no earlier than 60 s before this round's POST began"); the skew margin itself is unchanged; the code comment is aligned. |
| 7 | adv | doc claims a list that grows mid-walk keeps the delivery unresolved; covered growth actually certifies absence | accepted docs-only | Bullet qualifies: unresolved only while the grown list is not covered within the lookup bound; code unchanged (max-tracked lastPage). |
| 8 | adv | the ownership test patches `getuid` globally, so the directory check fires before the per-file check is ever exercised | accepted | The seam now runs twice: the directory message on the first uid read, then a call-count seam passes dir+config and fails the KEY read, asserting the file-specific message (uid reads 1/2/3). |
| 9 | adv | no selection test reaches the `EACCES` config-stat branch | accepted | `chmod 0000` parent regression (non-root guard, the file's existing pattern): App mode is selected and the composite github leg is the App poster, never the gh fallback. |
| 10 | adv | `PerkinsAppHttpError` retains the raw provider body on a public field | accepted | The class now keeps only sanitized classification state (`providerMessage`, `documentationUrl`); regression asserts no `body` property and that `JSON.stringify(error)` carries no credential-shaped bytes. |
| 11 | adv | README says verdict delivery rides `gh` without the App-mode qualification | accepted docs-only | Prerequisite now qualifies App mode and keeps the retained `gh` preflight dependency visible. |
| 12 | edge | a Link header present without `rel="last"` plus a short page certifies absence | accepted | The short-page end signal now applies only when no Link header is present at all; a present-but-unusable header continues the bounded walk and stays unresolved; regression + doc. |
| 13 | edge | bundle-dir special bits (same defect as adv #2) | duplicate of #2 — one repair | Same `0o7777` mask and regression cover it. |
| 14 | edge | claim: docs say the short-page signal needs no Link header while the code checks only `lastPage === null` | accepted with #12 | Code and doc now agree: the end signal requires no Link header at all. |
| 15 | vg | the pre-POST slug guard (missing/empty/charset-invalid) has no failing test | accepted | Three `/app` payloads assert `/usable slug/` and zero review POSTs, mirroring the id-mismatch test. |
| 16 | vg | real `perkins/`-directory-without-config selection never exercised in either direction | accepted | Two regressions: a real 0700 dir with no config keeps the legacy gh poster (single and composite legs), and removing only the config from a full bundle restores the legacy poster. |

Pin delta: `perkins-github-app.test.ts` 79 -> 86 (seven new tests), statically counted with the pin guard's own raw-source regex `\bit\(|\bit\.skipIf\(`; all 99 pins re-verified against that regex after the edits. Repairs accepted but not executed this turn (source-only): the next scheduled gate runs them.

## Verification

- `git merge-tree --write-tree --messages HEAD origin/main` — preflight exit 1: conflict in `src/main.ts`; no branch/working-tree mutation. Not a test pass.
- `git diff --check` — planning whitespace gate.
- Shared `POST /api/verify`, scope `full` — execute `npm test` once per meaningful candidate; preserve NDJSON and terminal outcome. Not run before the head-strategy decision.
- Full run 1 (candidate 821ed30, run `e35309ee-e545-4e8d-903d-b7da23442b0d`, tracked_dirty=false): **FAILED** — 1 failed | 1521 passed | 12 skipped; the single failure was `chat-server.test.ts > invokes fresh-handle adoption after durable New chat activation` (adopted still null when the control result arrived). Complete NDJSON + decoded outcome preserved under delivery/verify/integration/ (output 109,509 bytes, sha256 89c0a271a193ca11edd36f6076ae603985fbb03305f92d6bf87173709bdc49d8). Root cause: a test race against the deliberate server design — post-commit adoption starts on a next-turn setTimeout AFTER the control result is released (`src/chat/server.ts` postCommit comment) — repaired test-only in `4ee38fb` by waiting for the adoption itself (pollUntil, the file's own helper); focused probes green (logs preserved).
- Full run 2 (candidate 4ee38fb, run recorded below): result in the delivery receipt.
- Full run 3 (candidate `91bec13`, run `38f5a70a-cda3-4601-ade0-d70850d1a693`, ledger seq 32802): **FAILED** — 3 failed | 1526 passed | 12 skipped; the three failures are 30 s test timeouts (`dispatch-e2e` full heist arc, `perkins-builtin-wave` T4, `wizard --answers` secrets). Lint/typecheck/build succeeded; the web leg was not reached. Complete capture (209 frames, 108,109 bytes, sha256 `97a01987…`) reconstructed and matched to the terminal outcome. Source-only mapping this turn (no rerun, no timeout/runner change): the three tests await no module this PR changes, the T4 and wizard timeouts reproduced on an unrelated lane's full run lacking this PR's test file, and the failing windows did not overlap this lane's added test file. The one narrow same-runner discriminator is declared as the named verify scope `publisher-timeout-discriminator` in the lane `.gru-command/worktree.toml` (not scheduled or executed; a focused green is non-reproduction/latency evidence only, not a FULL waiver).
- Fresh exact-head CI after authorized push — require full-suite success; prior-head CI does not verify a new candidate.
