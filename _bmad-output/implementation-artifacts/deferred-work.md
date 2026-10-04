- source_spec: `_bmad-output/implementation-artifacts/spec-gh-97-owner-stop-routing.md`
  summary: Add a decisions.degraded.* variant of the fresh-owner-row regression (unacked legacy machine row of a degraded kind)
  evidence: The postIncident mechanism is kind-agnostic and covered via the provider-wall kind; the degraded producer merely shares it, so this is adjacent coverage, not a defect.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr76-main-integration.md`
  summary: 23 review findings (3-layer BMAD delta review of PR76 integration) all live in PR71/PR77 code that arrived verbatim from owner-merged main 4845b1a — whole-PR review engine (findingsDelivered stamp clobber, posted-payload writer/reader asymmetry, note-id coercion, dispose unbounded, -z copy parsing, provider discriminator divergence, surrogate truncation, note-prefix coupling, cached login), wake/routing (silent notify_wake default flip, legacy action-required rows unclearable, wake accept-callback stuck, blocked-wake re-arm loop, canWakeGru untested, [chat] wake-key round-trip untested), and board/dispatch (unbounded notifications snapshot, offset-pagination skips, disposition detail unbounded, clean-abort dedupe race, BOARD.md 30-min doc contradiction).
  evidence: every cited file verified byte-identical to origin/main 4845b1a (git diff --quiet per file); story delta vs main = exactly the 4 PR76 feature files; zero findings on the story's own surface; full layer outputs at ~/.gru-command/briefings/pr76-post77-conflict-and-native-review-20260927-delivery/layers/; briefing forbids a #71/#77 findings-harvest/repair pass — owner's parallel follow-up issues job (pr77-pr71-individual-followup-issues) owns filing; two vgap gaps pre-verified by their layer (test-coverage gaps, medium).
- source_spec: `_bmad-output/implementation-artifacts/spec-worker-residency-budget.md`
  summary: Independent-review deferrals on pre-existing main code carried by this diff (verification of each: unchanged on origin/main, untouched by this lane)
  evidence: 2026-09-28 triage — (1) registry.prepareReviewModel non-null assertion + nativeAdapters not cleared on dispose (#77); (2) hostDisclosureAppendix hardcoded seven-lens literal, no policy-catalog pin (#77/#68 era); (3) web board-protocol isValidSnapshot cross-version hard requirements (#68); (4) notify_wake default flip lacks OPERATIONS.md migration note (#71/#76); (5) chat wake acceptance unresolved when a prompt settles without turn_start (#71); (6) GitLabMrPoster String(created.id) turns null id into reviewId 'null'; (7) UTF-16 surrogate split in published-body truncation; (8) board pending-row pagination unbounded; (9) concurrent clean-abort re-arm dedupe race; (10) unbounded disposition detail persisted to ledger; (11) GitLab delivery without diff_refs.base_sha: recordDelivery writes a round.posted payload its strict reader rejects — restart recovery escalates a delivered round INCOMPLETE, and no test drives the writer→reader round trip on the empty-base branch.
- source_spec: `_bmad-output/implementation-artifacts/spec-worker-residency-budget.md`
  summary: 2026-09-28 recheck-round deferrals on pre-existing main code (each verified untouched by this lane via git diff origin/main)
  evidence: (1) whole.ts commitSettled may re-store unstamped originals over findingsDelivered:false in the pool-error branch (pre-dates this lane; this diff renamed only the pool variable); (2) dispatch worker-spawn waits emit no queue/ledger visibility and do not re-validate job status after admission (additive design scope beyond the review-scoped queue-visibility intent); (3) pi checkReviewModel tightening (authenticated provider alone no longer passes; no migration doc); (4) awareness resolveNotificationById legacy follow-up close path has no test; (5) ensureGru 'wake' default classifies user-driven compaction recovery through the wake gate/breaker message; (6) install.sh .service PATH dollar escaping; (7) board lensFromAgentLabel leading-colon lens chip; (8) awareness openAttention 1-slot split starves machine rows.
- source_spec: `_bmad-output/implementation-artifacts/pr136-chief-handoff/plan.md`
  summary: Dispatch-lane mid-turn crash after a marked phase intent has no recovery beyond leaving the phase `awaiting` (no fabricated completion, no phase-specific escalation)
  evidence: The pr136-chief-handoff delta deliberately adds no runtime attestation interface or provider recovery; a crash between the persisted intent and any admission evidence leaves the guard row awaiting and the job's own state visible. Adding dispatch-lane provider recovery is a wider runtime change that returns to Gru.
- source_spec: `_bmad-output/implementation-artifacts/pr136-chief-handoff/plan.md`
  summary: `reconcilePendingRebriefs` delivery-only branch may append a `silas.rebrief-recovered` event for a marker group replaced by a newer request mid-boot
  evidence: Markers are read as a boot snapshot; a newer re-brief request can replace them while recovery runs. The `expectedPhaseId` fence added by this delta prevents any phase completion from the stale group (and nothing is cleared), but the recovered-history event is still appended as noise.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: App review reconciliation can certify absence from a review-list record missing delivery-predicate fields.
  evidence: Inherited from main e75ca3d; `isDecidableReviewEntry` permits absent state/commit_id/body/submitted_at, while a short `lookupMatchingReview` page can certify non-delivery. Blind 1, Edge 2 and Verification Other 1 share this defect.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: App reconciliation refuses otherwise matching provider-quoted review IDs accepted by the receipt contract.
  evidence: Inherited from main e75ca3d; `usableProviderReviewId` accepts string IDs but `isDecidableReviewEntry` rejects them before matching, leaving an ambiguous POST unresolved.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: An unrelated malformed App review-list entry prevents crediting a complete matching review on the same page.
  evidence: Inherited from main e75ca3d; the whole-page `list.some(!isDecidableReviewEntry)` throws before `reviews.find(isMatchingAppReview)` runs, even though positive identity is independently verifiable.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: App installation token is not rechecked for expiry immediately before the irreversible review POST.
  evidence: Inherited from main e75ca3d; the pre-mint check permits roughly 30 seconds of remaining life, but the identity and PR probes can together consume that window before the POST.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: A direct fallback review may pass after its job is blocked or parked during the reviewer turn.
  evidence: Inherited from main e75ca3d; the post-await guard only rejects terminal state/working hops and checks review authorization for handoffs, not direct gates. Blind 6 and Edge 3 share this defect.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: Silas digest may publish a stale review candidate after it becomes blocked or parked during another candidate's awaited history.
  evidence: Inherited from main e75ca3d; `prWithoutReview` intake requires review-eligible status, but final filtering excludes only merged/done and pending markers.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: A fallback review can pass a working-tree diff changed during its asynchronous reviewer turn.
  evidence: Inherited from main e75ca3d; `recheckRound` watches ledger markers/status/settlement, but not the captured diff or HEAD; an independent lane edit with no ledger event can obsolete the reviewed bytes.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: Completed re-brief markers can clear without publishing the durable settlement wake when the append fails.
  evidence: Inherited from main e75ca3d; completion clears markers in one transaction, then appends `silas.rebrief-settled` separately; no pending markers remain to trigger another recovery pass or live queued-handoff retry if append fails.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: Historical App baseline scope labels an intermediate pinned test version as the final current contract.
  evidence: Inherited from main e75ca3d; `tools/app-contract-baseline.sh` overlays `0c4e129` tests and suite pin, so registration is self-consistent but newer current App oracles do not run against the historical baseline.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: App publication runbook calls an unproven ambiguous POST safe to retry after a visual review check.
  evidence: Inherited from main e75ca3d; `docs/PERKINS-APP-PUBLICATION.md` states that otherwise it was not delivered, even though incomplete lists and eventual provider visibility cannot prove absence.
- source_spec: `_bmad-output/implementation-artifacts/spec-pr142-review-verdict-closure.md`
  summary: Owned-service one-line-wrapper success path lost its dedicated installer regression oracle.
  evidence: Inherited from main e75ca3d; the success leg in `test/install-one-line.test.ts` now runs `target/install.sh`, while only the foreign-service refusal still exercises `bare/install.sh`.

## Deferred from: code review (2026-10-03)
- source_spec: none — BMAD code review of PR #170 (gru/gc-test-harness-budgets-20261002 @ 3540500), no-spec mode
  summary: Diagnostic redaction is over-broad and destroys the evidence it exists to keep (medium, test/helpers/harness-diagnostics.mjs:1205-1236)
  evidence: Probed on the PR head: case-insensitive Bearer|Basic + any word ("running basic checks" → "basic [REDACTED]"), label match without a word boundary ("max_tokens: 4096", "secrets: none configured"), \bAKIA/i ("Akiane"). A chunk ending in "…running basic setup" opens the streaming fail-closed state and discards the rest of the line, dropping " FAILED: ENOENT /missing/file". Deferred: tightening trades leak-safety for signal and contradicts the r1-pinned lowercase-bearer case — needs an owner call on the leak/noise trade-off.
- source_spec: none — BMAD code review of PR #170 (head 3540500)
  summary: runOwnedCommand and disposeScopeProcesses signal only the direct child; grandchildren of `bash install.sh` (npm/git/node) are orphaned on deadline or teardown (medium, test/helpers/harness-diagnostics.mjs:1397-1430,1486-1550)
  evidence: No detached spawn or process-group kill; SIGTERM to bash does not propagate. execFileSync's timeout behaved the same, but the new teardown claims to reap owned children. Deferred: the obvious fix (detached + kill(-pid)) puts the child in a new session with no controlling terminal, which changes the /dev/tty semantics the install.sh TTY tests assert — needs a design decision.
- source_spec: none — BMAD code review of PR #170 (head 3540500)
  summary: A timed-out async test body keeps running and spawns its remaining install.sh/wizard commands during the next test, tracked in that test's scope (medium, test/install-one-line.test.ts:1931-1968)
  evidence: Converting execFileSync to awaited runOwnedCommand means Vitest moves on after a timeout while the abandoned body continues; activeScope is the next test's scope, so the orphan runs add co-tenant load and appear in the wrong test's diagnostics. Vitest 3.2.7 aborts context.signal on timeout; threading it through ~35 run() call sites is a design choice. Deferred.
- source_spec: none — BMAD code review of PR #170 (head 3540500)
  summary: `npm test` chains the phases with &&, so any fast-phase failure hides every heavy-phase result for that run (low, package.json:161)
  evidence: Previously one `vitest run` reported all backend failures; CI now needs an extra round to see heavy regressions (no false green). The RPC patch also runs three times (pretest + both phase pretests), which is idempotent. Deferred: aggregating exit codes changes the chain shape pinned by harness-routing.test.ts.
- source_spec: none — BMAD code review of PR #170 (head 3540500)
  summary: AGENTS.md and other docs don't mention the phase split; `npx vitest run test/<heavy>.test.ts` now exits "No test files found" (low)
  evidence: README documents test:backend:heavy, but agent guidance does not, so minions running a heavy file directly hit an exit-1 trap (it fails loud, not silently). Deferred: the fix edits agent-context files.
