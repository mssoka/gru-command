- source_spec: `_bmad-output/implementation-artifacts/spec-review-input-handoff.md`
  summary: The non-blind specialist child's fail-closed `capabilities.images` check has no test that can observe it (the test double applies one capability to lead and children alike).
  evidence: Verification-gap layer 2026-10-04; deleting `assertEvidenceCapability(handle, childImages, ...)` at `src/dispatch/perkins-review/whole.ts` keeps every test green, but today the lead and children resolve to the same review model/capabilities (`src/dispatch/perkins.ts` passes `reviewModel` to both), so the child branch is unreachable with heterogeneous capabilities. Closing it needs a per-handle capability seam on `fakeWholeSpawner` plus a case asserting the lens fails closed while the lead reviews.
- source_spec: `_bmad-output/implementation-artifacts/spec-review-input-handoff.md`
  summary: A canonical amendment body can reproduce host marker lines (`## Amendment #N`, `status: EFFECTIVE`, the frozen-spec delimiter) inside the rendered effective contract.
  evidence: Blind-hunter layer 2026-10-04; `renderEffectiveContract` interpolates the approved body verbatim at column 0. Only the authenticated writer (pairing token) can append bodies, so the practical risk is low, but a future renderer hardening should quote/indent bodies or escape host marker prefixes; no unauthenticated path exists.
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
- source_spec: `_bmad-output/implementation-artifacts/spec-crew-heist-labels.md`
  summary: The crew-rail e2e covers short ASCII authored names only; add a long/Unicode authored name plus an ellipsis/overflow assertion (and re-check the authored row at the phone viewport) when an e2e-executing scope is available.
  evidence: Fresh bmad-build blind-hunter finding 2026-10-02 (triaged low, not fixed): the recorded layout acceptance remains the four human-inspected desktop+phone light/dark captures, and the lane's only declared scheduler scope is `full` (`npm test`), which does not run Playwright.
- source_spec: `_bmad-output/implementation-artifacts/pr136-chief-handoff/plan.md`
  summary: Dispatch-lane mid-turn crash after a marked phase intent has no recovery beyond leaving the phase `awaiting` (no fabricated completion, no phase-specific escalation)
  evidence: The pr136-chief-handoff delta deliberately adds no runtime attestation interface or provider recovery; a crash between the persisted intent and any admission evidence leaves the guard row awaiting and the job's own state visible. Adding dispatch-lane provider recovery is a wider runtime change that returns to Gru.
- source_spec: `_bmad-output/implementation-artifacts/pr136-chief-handoff/plan.md`
  summary: `reconcilePendingRebriefs` delivery-only branch may append a `silas.rebrief-recovered` event for a marker group replaced by a newer request mid-boot
  evidence: Markers are read as a boot snapshot; a newer re-brief request can replace them while recovery runs. The `expectedPhaseId` fence added by this delta prevents any phase completion from the stale group (and nothing is cleared), but the recovered-history event is still appended as noise.
- source_spec: none
  summary: Obtain scheduled full `/api/verify` receipts, exact-head CI, and native Perkins READY for the final Stage 2 head.
  evidence: Operational gates for the owner's authenticated scheduler. The e2e-repair deferral below is resolved: the five UI failures were fixed by this branch (held mock turns, busy-phrase rotation, reserved busy-status slot, expanded service events, sheet preservation) and re-verified on the integrated head 81295ed over the current base 39a19ea — `npm test` green (fast 1766/heavy 750/web 466) and `npm run e2e` 55/55 including visually inspected theme snapshots; the four refreshed snapshots were accepted after explicit image inspection (intact header, bubbles, composer, panels; no blank/garbled regions).
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

## Deferred from: code review of spec-gh-32-deterministic-bmad-failure-skip-only (2026-10-05)

- source_spec: `_bmad-output/implementation-artifacts/spec-gh-32-deterministic-bmad-failure-skip-only.md`
  summary: `wizard-bmad-browser-consumer` runs `npm run e2e` whose Playwright screenshot baselines are darwin-only, so the scope has no Linux baseline support.
  evidence: bmad code review (blind-hunter, gpt-6-sol) 2026-10-05; pre-existing main convention — origin/main's `web/e2e/*-snapshots/` carry only `-darwin` PNGs and CI does not run e2e — so repair is a cross-lane Linux-baseline effort, not this lane's change.

- source_spec: `_bmad-output/implementation-artifacts/spec-crew-heist-labels.md`
  summary: The crew-rail Playwright project (rail layout/overflow geometry) is not part of any required recurring gate — CI runs `npm test` (Vitest) only; a future CSS regression could pass every required check while breaking the rail layout.
  evidence: Fresh bmad-build verification-gap finding 2026-10-05 (disposition: defer). The dedicated `crew-rail` project is runnable on demand through the declared scheduler scopes (`crew-rail-captures`, `crew-captures-fast`) and ran green at the reviewed heads, but adding Playwright to required CI is a repo-wide runner-cost/policy decision (browsers install, ~1-2 min/job) that the owner and the e2e-gate-repair lane (job-e2e-gate-repair-20261004) own, not this display-naming lane.

## Deferred from: code review of issue 189 (2026-10-05)

- source_spec: GitHub issue #189 (PR #228, settlement-gap lane)
  summary: A synchronous settlement-publication failure in the boot spent-marker or delivery-only completion paths rejects the whole `reconcilePendingRebriefs` pass, and `src/main.ts` awaits that pass during startup — one faulty job can stall recovery of every other job and startup itself.
  evidence: bmad code review (blind-hunter, gpt-6-sol) 2026-10-05; pre-existing shape — the old two-step clear→publish could throw out of the scan identically, and GH-228 strictly improves recovery (the clear now rolls back, markers survive for the next boot). Per-job containment changes reconcile error semantics (report shape, escalation routing) and belongs to a dedicated reliability lane, not the settlement-gap fix.
- source_spec: GitHub issue #189 (PR #228, settlement-gap lane)
  summary: The delivery-only shortcut appends `silas.rebrief-recovered` after the atomic clear+settle commits; a failure of that audit append loses the recovery audit with no markers left to re-derive it from.
  evidence: bmad code review (blind-hunter, gpt-6-sol) 2026-10-05; pre-existing window (the audit trailed the settlement before this change too) and observability-only — the settlement itself is committed, so no handoff strands. Atomic audit+settlement needs another API variant; not worth the surface for an informational event.

## Deferred from: code review of GH-221 / PR #229 (2026-10-05)

- [ ] [Review][Defer] No startup reconciliation of uncaptured review verdicts [src/lessons/review-capture.ts] — deferred: real but not actionable now. Capture is event-driven only: a verdict whose consolidated record is missing/unreadable at event time stays uncaptured unless the same round posts another verdict event, and verdicts committed moments before a crash are never rescanned at boot. Closing it needs a new ledger query (all verdict-posted rounds across jobs — none exists today) plus a bounded startup sweep wired in main.ts, which is new ledger surface beyond this reviewed PR. Exposure in the current production flow is near-nil: verdicts post only while the service is up, and whole-pr rounds write consolidated.json before the verdict event (INCOMPLETE/recovery rounds carry no accepted findings). Settled by: implement `listVerdictRounds()` on LedgerApi + a boot-time sweep that replays uncaptured rounds through the same capture path (finding sources make replays idempotent).
- [ ] [Review][Defer] main.ts production wiring is untested for the due-based dream (no boot-assembly harness) [src/main.ts] — deferred: pre-verified verification-gap finding. The cadence tests supply their own `lastDreamAt` callback, so deleting main.ts's `lastDreamAt: () => loadDreamState(...)` port would still leave the suite green while a restart would reset the cadence again. There is no existing service-assembly test harness (no test imports src/main). Settled by: a boot-assembly test that starts the service against a seeded dream state (lastDreamAt in the future, fresh journal entries) and asserts no distiller call before the due time.

## Deferred from: code review of GH-215 conflicts-to-silas (2026-10-05)

- source_spec: GitHub issue #215 (Route mechanical PR conflicts to Silas's digest instead of waking Gru)
  summary: Conflict-row retirement is ADMISSION-based (a `silas.directive-sent` carrying `pr-conflict:<headSha>` retires the row) while the ops-dispatch skill says to escalate only after the rebase directive fails twice — a failed rebase directive leaves no visible second attempt, because the spec itself prescribes admission-based suppression. Any fix that retires only on a successful outcome contradicts issue #215's explicit suppression rule, so it needs an issue-level decision (or #218 typed holds) first.
  evidence: bmad code review (blind-hunter + edge-case-hunter, gpt-6-sol) 2026-10-05, triaged defer — spec-prescribed behavior, not this lane's change.

- source_spec: GitHub issue #215 (Route mechanical PR conflicts to Silas's digest instead of waking Gru)
  summary: A live/armed Perkins review round does not fence the `conflictingPrs` row — a base update can dirty the PR mid-round and the digest will offer a rebase that invalidates the frozen review target. The issue's suppression list is deliberately enumerated (directives, re-briefs, verifications, later #218 holds); round coordination belongs to #218's typed decision memory, where an active-hold check can cover `pr-conflict`.
  evidence: bmad code review (blind-hunter, gpt-6-sol) 2026-10-05, triaged defer — real coordination hazard, owned by the #218 phase; adding round-state fencing here would exceed the issue's prescribed suppression contract.

## Deferred from: code review of issue #218 (2026-10-06)

- [Review][Defer] Trigger-path suppression wiring — `coveringDecision` is not yet called by any production trigger/wake path, so a recorded hold does not yet prevent re-detection wakes. Deferred: #218 is the foundation by the issue's own sequencing; hold suppression wiring is #215's scope and the #219 lane is already stacking on `gru/decision-memory-218`. Docs now state this truthfully. Settled by: #215 landing its suppression query on this API.
- [x] [Review][Defer] `recheck_at` re-look scheduler — a passed `recheck_at` re-opens the subject for future queries, but nothing schedules a wake/sweep when it passes. Deferred: the recheck sweep is #217's explicit scope per the issue ("recheck_at in #217"). Settled by: #217's scheduler reading `recheck_at` — DONE: PR #238 (merged 2026-10-06) reads `recheck_at` in the Silas sweep gate.

## Deferred from: code review of PR #238 (2026-10-06)

- `prompt()` resolving with an unsuccessful in-band turn verdict is counted as a delivered wake (`src/dispatch/silas-driver.ts` runWake) — pre-existing slot contract, not introduced by #217; adopting `promptWithVerdict` for the silas slot is a separate change.
- Skill files edited on disk while the driver runs never reload (constructor-loaded `loadSilasSkills`) — pre-existing; a driver restart applies the revised pack.

## Deferred from: code review of GH-224 / PR #239 (2026-10-06)

- `report_conclusion` production wiring — host is #220 (unbuilt); surface documented BACKTEST-ONLY until that handback path exists.
- `same_blocker` labelled-positive population under-covers enforce (carry-key positives share a #216 fingerprint; production asks only about fingerprint-differing pairs) — grow the labelled set from real differing-fingerprint history before enforce.
- Extractor groups review rounds by identical target SHA; production compares per-job rounds across moved heads — same measurement-limit family, documented in docs/jev-production-integration.md.
- Enforce gate does not machine-check the per-surface owner decision — process precondition; encoding it would change #223's reviewed evidence schema.
- Live backtests (openrouter-jev + one alternative profile) + recorded owner decisions per surface — owner steps (credentials/spend); labelled inputs staged at ~/.gru-command/decisions/cases/escalation_triage.jsonl (41 cases).

## Deferred from: code review of PR #241 / issue #117 (2026-10-06)

- verificationFailures digest rows with a null scope can never follow the `verification-failure:<scope>@<run_id>` fingerprint discipline: the retirement fingerprints are only built when scope is non-null, so a null-scope failure row can only retire via resubmission (impossible for null scope) or terminality. Pre-existing digest identity gap (unchanged by #117, which only names the pre-existing instruction as the `verification-repair` rule). Fix: give the null-scope row an actionable identity or withhold the rule offer.

## Deferred from: bmad-build review of dashboard-slim-strip-current-main (2026-10-07)

- source_spec: `_bmad-output/implementation-artifacts/spec-dashboard-slim-strip-current-main.md`
  summary: The two fail-before baseline scopes guard an unexpected GREEN but cannot distinguish a behavioral feature-absence RED from a build/import/collection failure.
  evidence: The scopes now terminate exit 2 on an unexpected pass (`FAILS-BEFORE CLAIM BROKEN`) and keep the real exit otherwise; adding the binned-baseline failure-kind assertion (`tools/assert-binned-baseline.mjs` pattern: per-leg JSON reporter + named-behavioral-failure check) needs a lane helper and a re-verified run. The recorded REDs (runs e7bf5e64/f5976535, 6bda4166/a0cf1b64) are behavioral today.
- source_spec: `_bmad-output/implementation-artifacts/spec-dashboard-slim-strip-current-main.md`
  summary: The wake-age and deferred-count digit-boundary legs (9→10, 99→100, 999→1000) run at 1440 only, while the acceptance names 1440/1200/768/360.
  evidence: The familyA/B/C boundary loops cover all four viewports for the other slots and the reserved-slot CSS is shared, but the age/deferred slots cross their own boundaries at one width only; extend the two long tests with narrow-width legs at the next suite touch (the long-label test now has a 360 leg).
- source_spec: `_bmad-output/implementation-artifacts/spec-dashboard-slim-strip-current-main.md`
  summary: The bell panel's ready-PR row keeps its prior content and explicit OPEN PR link but flows with a flex override instead of the base grid alignment; no test compares the panel layout to base.
  evidence: Round-3 blind-hunter follow-up (panel variant added by the port commit, not the review delta). Content/regions/controls are preserved and asserted structurally; revisit only when the notification panel is next touched, with a panel-level visual or computed-style pin.
- source_spec: `_bmad-output/implementation-artifacts/spec-dashboard-slim-strip-current-main.md`
  summary: The optional CHILDREN group falls through the tone map to the neutral park marker; no tone is assigned or asserted.
  evidence: Round-3 blind-hunter follow-up. The approved reference defines only HEISTS/PRS/CREW marker tones; decide a CHILDREN tone (or keep neutral) and pin it when the group is next touched.
- source_spec: `_bmad-output/implementation-artifacts/spec-dashboard-slim-strip-current-main.md`
  summary: Each `.strip-group` section's accessible name is the tooltip enumeration (`working / in-review / …`) rather than the visible heading (HEISTS/PRS/CREW/CHILDREN).
  evidence: Round-3 blind-hunter follow-up. No test asserts the section name; switch to the visible name or `aria-labelledby` the head when the strip next receives an a11y pass.
- source_spec: `_bmad-output/implementation-artifacts/spec-dashboard-slim-strip-current-main.md`
  summary: `geometry()` cannot measure wake states without a valid stamp (`no wakes yet` / `last wake unknown`), so those states have text assertions only.
  evidence: Round-3 blind-hunter follow-up: `need(.board-age-split__num)` throws for unstamped states; add optional-slot handling when the geometry helper is next extended.
- source_spec: `_bmad-output/implementation-artifacts/spec-dashboard-slim-strip-current-main.md`
  summary: `bindClient` (re-pair) does not clear the owner band's `expandedOwnerRows`/`ownerRegionIds`, so an actionId reused by the new connection can render pre-expanded with a recycled region id.
  evidence: Round-6 edge-case follow-up; reachable only across re-pair with a server that reuses ids; harden at the next owner-band touch (clear the maps in `bindClient` and pin with a unit test).
- source_spec: `_bmad-output/implementation-artifacts/spec-dashboard-slim-strip-current-main.md`
  summary: The capture suite overwrites fixed ignored screenshot paths without clearing or run-scoping, so a failed run can leave stale images that satisfy the manual inspection step.
  evidence: Round-6 blind-hunter follow-up (F-7); clear or run-scope `web/e2e-artifacts/` before capturing at the next suite touch.
- source_spec: `_bmad-output/implementation-artifacts/spec-dashboard-slim-strip-current-main.md`
  summary: The `.strip-kpi + .strip-kpi::before` separator glyphs are CSS-generated content exposed to assistive technology.
  evidence: Round-6 blind-hunter follow-up (F-6); replace with a real `aria-hidden` span or non-content separator at the next strip a11y pass.
