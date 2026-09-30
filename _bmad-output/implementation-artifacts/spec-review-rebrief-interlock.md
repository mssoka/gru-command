---
title: 'Review eligibility and admission during pending re-briefs'
type: 'bugfix'
created: '2026-09-30'
status: 'in-review'
route: 'dispatch'
baseline_commit: 'c54bfbf89727bacfd27a27db65a9fab681c19c3e'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A lane with a newer unresolved re-brief can still be offered or admitted for review on an older delivery (notification 21ee6800-6290-47b3-86b6-347b57daa36f). `laneIsBusy` (src/dispatch/branch-idle.ts) checks only working/dispatched status plus `job.delivered` versus the last `job.status → working` hop, and `computeSilasDigest`'s `prWithoutReview` projection reads historical delivery/head without the durable `pending_rebriefs` markers written before a re-brief worker spawns. Live evidence 2026-09-30: #135/#138 had unresolved markers and open re-brief turns yet appeared review-eligible; crew-heist-labels-r5 was admitted on the same head while its pending re-brief had not settled (j-410/j-411 — evidence only, not permission to touch crew).

**Approach:** Make an unresolved target-owned re-brief a first-class "busy" fact. The shared branch-busy predicate fences a nonterminal job with any pending marker regardless of delivery or status, and the Silas review-eligibility projection never offers such a target for first review, changed-head re-review, or clean-abort rearm. Release rides the existing marker lifecycle (`finalizeRebriefRequest` / boot reconciliation) — no second scheduler, counter, supervisor, polling/liveness subsystem, or schema change.

## Boundaries & Constraints

**Always:**
- Reuse the existing durable pending-request facts (`ledger.listPendingRebriefs`); presence of any marker for a job is the unresolved fact, re-read at arm intake and again at freeze, so a re-brief admitted during asynchronous setup aborts admission. Queued-handoff replay runs the same guard.
- Fence the target job only: blockers stay branch-matched; terminal (`merged`/`done`) jobs never count busy, so stale terminal markers cannot block unrelated lanes or resurrect terminal jobs; unrelated eligible lanes stay unaffected.
- Preserve genuine settled-delivery eligibility. Once markers clear and no target-owned work remains, ordinary first review, changed-head re-review, bounded clean-abort behavior and owner `force: true` (explicit, audited, never automatic) behave exactly as before.
- Old-worker late delivery, minion/ledger idle, and status transitions alone cannot clear a newer request. Never release or approve pending work merely to allow a review.

**Never:** add runtime dependencies; change schema, models, pinned review policy, thresholds or timeouts; weaken tests; modify `src/ledger/api.ts`, `perkins.ts` internals, or #136's `fix-directive.ts`/`rebrief-recovery.ts`/`server.ts`/ledger obligations; touch #69, terminal-rebrief-retirement, crew, or other lanes; run live lanes as review fixtures; use force; claim a broad concurrency redesign.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Re-brief before spawn / live / restart-recovered | ≥1 pending marker, any nonterminal status | review arm and digest both fence the target | arm: 409 `branch_busy`; digest: no `prWithoutReview` row |
| One guarded marker left; late old delivery; status flip | marker subset + newer `job.delivered` | still fenced; delivery/idle cannot answer the request | N/A |
| Re-brief arrives during review setup | markers appear between arm and freeze | round aborts, lane swept, no review starts | `branch-idle.refused` phase `freeze` |
| Request genuinely settles | markers cleared by finalization/recovery | exactly that target releases; others unchanged | N/A |
| Foreign pending work | markers on another job/branch | unrelated eligible lanes unaffected | N/A |
| Terminal stale markers | `merged`/`done` job with leftovers | never busy; job stays terminal | N/A |

</frozen-after-approval>

## Code Map

Owned by this slice:
- `src/dispatch/branch-idle.ts` — extend `BranchIdleLedger` with `listPendingRebriefs`; `laneIsBusy` returns true for a nonterminal job with any pending marker (before the status/delivery logic); terminal short-circuit. `findBusyLanes` unchanged: branch matching already scopes blockers.
- `src/dispatch/silas-driver.ts` — extend `DigestLedger` with `listPendingRebriefs`; compute the pending job-id set once per digest; gate every `prWithoutReview` push (first review, changed-head re-review, clean-abort rearm) on the job not being fenced.
- `test/branch-idle-guard.test.ts` — marker-fence unit + HTTP arm/preflight, freeze-race, and queued-replay regressions.
- `test/silas-driver.test.ts` — digest fence regressions (first, re-review, clean-abort, late delivery, settlement).
- `test/suite-shape.test.ts` — bump the two edited files' test-count pins.
- `docs/FLOW.md`, `resources/silas-skills/ops-dispatch/SKILL.md` — concise behavioral note.

Seams owned elsewhere (read-only here):
- `src/dispatch/perkins.ts` — no change required: arm and freeze already call `findBusyLanes` with the live `LedgerApi`, which satisfies the extended port; the freeze call re-reads after `createReviewWorktree`.
- `src/ledger/api.ts` — `listPendingRebriefs({jobId})` already exists; interface reuse only.
- `src/dispatch/rebrief-recovery.ts`/`fix-directive.ts`/`server.ts` (#136) — marker lifecycle is consumed, not modified. If #136's terminal retirement lands first, deleted terminal markers were never fenced here.

## Tasks & Acceptance

**Execution:**
- [ ] `src/dispatch/branch-idle.ts` — pending-marker busy fact + terminal short-circuit — the shared predicate both boundaries and all callers inherit.
- [ ] `src/dispatch/silas-driver.ts` — pending set + `prWithoutReview` fence — stop the offer, not just the admission.
- [ ] `test/branch-idle-guard.test.ts`, `test/silas-driver.test.ts` — deterministic regressions (fake ledgers, deferred/bounded async flushes; no sleeps, no provider spawn).
- [ ] `test/suite-shape.test.ts` pins; docs notes.

**Acceptance Criteria:**
- Given an old delivery newer than the last working hop and a newer unresolved re-brief, when the digest is computed, then the target is not offered for first review, changed-head re-review or clean-abort rearm. Working, delivered and in-review states stay fenced; status transitions alone cannot release it.
- Given a matching pending re-brief (before spawn, live, restart-recovered, or only one guarded marker remaining), when review is requested normally, then it refuses/defer as 409 `branch_busy` before any preflight or round work; queued-review replay re-queues through the same guard; a late old-worker delivery does not clear it.
- Given re-brief admission during asynchronous review preparation, when final freeze is reached, then current marker state is rechecked and no obsolete review starts.
- Given the matching request genuinely settles and no target-owned work remains in flight, when normal gates allow, then exactly that target is released; ordinary first review, changed-head re-review, clean-abort behavior and owner force stay intact.
- Given terminal stale requests or pending work on another target, then unrelated eligible lanes remain unaffected and terminal jobs stay terminal. No equivalence is claimed with a general concurrency redesign.

## Design Notes

- "Unresolved" = presence of any `pending_rebriefs` row for the job. Presence-based is deliberate: a late `job.delivered` from the pre-re-brief worker postdating the marker watermark must not answer the newer request; a crash between event landing and marker clear may only over-fence until the next reconciliation — fail-closed, never a release to admit a review.
- `laneIsBusy` keeps the marker check status-independent except terminal; the digest reads the pending set once per computation.
- Remaining inverse-direction limitation (documented, not fixed): a re-brief admitted AFTER the freeze recheck closes can still race a live round; eliminating that window needs a transactional admission/lease join, which is out of this slice.

## Implementation Notes

- Implemented by the lane minion directly (no subagent capability in this runtime). Step-02 planning was resumed from the preserved render at `_bmad/render/bmad-build/job-review-rebrief-interlock-a3916df71acc/389474823968c3ab9eb6/`; bmad-build was NOT invoked a second time and nothing was reinstalled or re-rendered.
- No `src/dispatch/perkins.ts` edit was needed: arm (`enforceBranchIdleForRequest`) and freeze (`setupRound` → `enforceBranchIdle`) already pass the live `LedgerApi` into `findBusyLanes`, which satisfies the extended `BranchIdleLedger`; the existing freeze re-read after `createReviewWorktree` is what catches a re-brief admitted during asynchronous setup. No `src/ledger/api.ts` change: `listPendingRebriefs` already exists.
- Change shape: `laneIsBusy` gains the presence-based marker fence (plus the terminal short-circuit); `computeSilasDigest` reads the pending job-id set once and gates every `prWithoutReview` push. Tests: 4 new in `branch-idle-guard.test.ts` (marker unit fence; arm refusal before preflight with late-delivery/partial-settlement; freeze race; queued-handoff replay) and 2 new in `silas-driver.test.ts` (first + moved-head fence with late delivery; clean-abort rearm fence) — all deterministic, no sleeps, no provider spawn. Suite-shape pins bumped (6→10, 33→35); no existing assertion weakened.
- Verification posture: global scheduler pacing FULL783ac932 held this lane's window, so no product test/typecheck/build/listener/provider command was run here. Red-phase (fails on baseline) and green-phase execution are declared below for ops via `/api/verify`; the completion report carries the exact-head verification-readiness receipt with scopes and remaining gates. No failures to preserve — nothing was executed.
- CI repair (run 36694997158 at `275266f`; merge-result tree `7bb8af87` is byte-identical to the lane head): the only failure was inherited pin drift from main's #133 merge — `test/owner-actions.test.ts` existed but was absent from PINS (8 static registrations), and `test/github-poll.test.ts` was pinned 22 vs 24 static registrations. Repaired narrowly in `test/suite-shape.test.ts` (add `owner-actions.test.ts: 8`; `github-poll.test.ts` 22→24); the other 95 pins and the file set reconcile exactly against the gate's own regex, and no test, assertion, threshold or gate changed. Evidence: out-of-tree sweep capture `silas-sweep-0944-8i7aDk/review-rebrief-interlock-ci-36694997158.log` (sha256 `579f118fab379bde23ad83b84814a015549394888eaaab67317c63ba2d1a929a`; lint/typecheck/build passed, backend vitest 1455 passed / 1 failed / 9 skipped, web suite not reached before the `&&` stop). Seam: if #136 merges first it grows `owner-actions.test.ts` — re-reconcile that pin against the merged tree, never copy another lane's value.

## Verification

**Commands (ops schedules via `/api/verify`; this lane does not run product checks — global scheduler pacing FULL783ac932):**
- `npx vitest run test/branch-idle-guard.test.ts test/silas-driver.test.ts` — expected: the 6 new cases fail on baseline (`laneIsBusy` ignores markers; digest offers fenced targets), pass at the lane head.
- `npm run lint && npm run typecheck` — expected clean.
- `npm run build` — expected clean (no pinned-resource change).
- `npm test` — full backend + web gate at a media/process-safe checkpoint (≥36GiB free).

**Gates:** exact-final-head CI, independent final-diff review, native Perkins READY. Worker never self-arms; owner merges/restarts remain manual. A source-only checkpoint is not a passed gate.
