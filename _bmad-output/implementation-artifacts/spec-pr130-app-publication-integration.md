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
- [ ] `src/main.ts` — resolve integration using the approved head strategy; retain App selection and upstream wiring.
- [ ] `src/dispatch/perkins-github-app.ts`, `test/perkins-github-app.test.ts`, `test/suite-shape.test.ts` — check compatibility and close material independent findings with deterministic regressions. Shared publisher source needs prior coordination.
- [ ] `docs/PERKINS-APP-PUBLICATION.md` — correct statements affected by accepted findings, without claiming live success.
- [ ] This spec — append source refs, independent review binding, gate results, and disposition. Private transcripts/verification evidence stay outside the repository.

**Acceptance Criteria:**
- Given fresh main and the approved strategy, when integration completes, then main is included, only lane-owned changes remain in the PR diff, and no WIP is lost.
- Given a pending/live round, when integration would move its source, then no head moves until settlement.
- Given integrated source, when scheduled verification and exact-head CI complete, then every required green result is evidenced without erasing historical failures.
- Given final source, when independent BMAD review completes, then reviewer identities and exact diff binding are recorded before Silas starts a native whole-PR round.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

- `git merge-tree --write-tree --messages HEAD origin/main` — preflight exit 1: conflict in `src/main.ts`; no branch/working-tree mutation. Not a test pass.
- `git diff --check` — planning whitespace gate.
- Shared `POST /api/verify`, scope `full` — execute `npm test` once per meaningful candidate; preserve NDJSON and terminal outcome. Not run before the head-strategy decision.
- Fresh exact-head CI after authorized push — require full-suite success; prior-head CI does not verify a new candidate.
