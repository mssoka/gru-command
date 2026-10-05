---
title: 'gh-169 Stage 4 — Perkins admission preflight and honest parent/child/unused/batch/round counters'
type: 'feature'
created: '2026-10-05'
status: 'in-review'
route: 'dispatch'
baseline_commit: '6cdd5ab42398fef56a47266308e936a2996faa23'
review_loop_iteration: 0
context: ['gh-167', 'gh-79-80-86-87-perkins-stage2', 'gh-168']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A Perkins round spends its expensive work before proving its
frozen packet is completely accessible, and its counters lie under parent
failure. Concretely, on current main (`6cdd5ab`): `abortRound`
(`src/dispatch/perkins.ts`) flips EVERY `pending`/`live` lens chip to
`error`, so one lead `Connection error` with zero children displays a
nine-chip slate of failed specialists; the workflow-failure catch and
`finalizationIncomplete` both return `lenses.map(() => error)`; a lead-owned
INCOMPLETE report never states how many specialists actually executed; the
published appendix carries no CI-evidence state line (missing vs failed CI
is frozen distinctly in the manifest but invisible in the report); and a
supplied-spec round with no recorded scheduler verification run freezes
silently — absence is not disclosed anywhere the reviewer reads.

**Approach:** (1) A host-owned **admission preflight** runs immediately
after the freeze and its receipts, before the run promise exists and before
any lead or child spawn: it re-validates the complete frozen packet read-only
(head binding, manifest/diff/spec/conventions/changed-files hashes, evidence
attachment bytes, CI record shape, verification-section presence) and refuses
with one exhaustive, precisely named missing-input list. (2) Parent vs child
truth: `abortRound` leaves never-started lenses `pending` (not-started ≠
failed execution), marks only genuinely started lenses `error` with the
parent cause, and records exactly ONE `round.parent-incident` event with
started/not-started lens facts; INCOMPLETE reports and wave outcomes carry
the same execution facts. (3) The appendix publishes the frozen CI-evidence
state (GREEN/PENDING/FAILED/UNAVAILABLE/NOT-MATCHED — missing is never
rendered as failure) and specialist-attempt totals. (4) A supplied-spec
round with no bound verification run freezes an explicit UNAVAILABLE
verification section instead of silence; the preflight requires it.

## Boundaries & Constraints

**Always:** Read-only preflight (no packet writes, no filesystem expansion);
fail loud with named errors; budgets unchanged (16 runs/round, 2
attempts/lens, 2 terminal attempts); one lead, one frozen target per round;
batches stay scheduling units inside one round; frozen rounds stay immutable
(write-once artifacts; recovery/preflight never mutate predecessor bytes);
missing evidence is displayed and recorded distinctly from failed evidence;
deterministic fail-before/pass-after tests for every user-visible change.

**Never:** No new lenses, no mandatory-coverage gate (availability is not
forced execution), no timing/attempt-budget change, no CI waiver, no
fabricated PASS, no merge or service restart, no historical ledger rewrite,
no mid-review packet mutation, no arbitrary filesystem expansion.

</frozen-after-approval>

## Code Map

- `src/dispatch/perkins-review/admission.ts` (new) — `admissionPreflight(review, movementRef)` returning exhaustive `{checks, missing}`; `ReviewAdmissionError` carrying the named missing inputs. Named inputs: `head-binding`, `frozen-packet:<file>`, `spec-context`, `verification-evidence`, `ci-evidence`, `evidence:<id>`.
- `src/dispatch/perkins-review/whole.ts` — export `headMovedSinceFreeze` for reuse (no behavior change).
- `src/verify/evidence.ts` — `appendRecordedVerification` appends an explicit bounded `UNAVAILABLE — NO BOUND VERIFICATION RUN` section when no run binds (mirrors the CI omission-notice contract); a section that cannot fit refuses the freeze.
- `src/dispatch/perkins.ts` — run the preflight after `round.review-owner`, record `round.admission-preflight` (ok/checks/missing), refuse via `ReviewAdmissionError` before the run promise; `abortRound` parent/child honesty + `round.parent-incident`; honest interrupted lens results and INCOMPLETE report execution facts; appendix CI line + attempt totals; pass the frozen CI record into `publicationBodyFor`.
- `src/board/engine.ts` — `lensAttempts` derive from the ledger's `round.specialist-started` events (the budget authority), not from registered agent labels.
- `test/perkins-admission-preflight.test.ts` (new), `test/perkins-builtin-wave.test.ts`, `test/perkins-whole-review.test.ts`, `test/verification-evidence.test.ts`, `test/review-inputs-handoff.test.ts`, `test/board-engine*.test.ts` — new deterministic coverage; updated pins where they encoded the dishonest slate.
- `docs/REVIEW-INPUTS.md`, `docs/FLOW.md`, `docs/LEDGER.md` — admission preflight, parent-incident counters, verification-absence disclosure.

## Tasks & Acceptance

**Execution:**
- [x] admission module + preflight wiring + ledger event.
- [x] abortRound parent/child honesty + parent-incident event + honest interrupted outcomes/reports.
- [x] verification absence disclosure.
- [x] appendix CI-state line + attempt totals; publication passthrough.
- [x] board lensAttempts from ledger starts.
- [x] docs + tests (fail-before/pass-after).

**Acceptance Criteria:**
- Given required spec/assets/verification/CI material is inaccessible after the freeze, then preflight refuses before any specialist (or lead) starts, with one exhaustive precisely named missing-input list; given a fully accessible packet, preflight passes and the packet stays frozen head-bound.
- Given missing CI evidence vs a failing CI, the two states are displayed and recorded distinctly (appendix line names UNAVAILABLE/NOT-MATCHED vs FAILED; never a missing→failure conversion).
- Given a lead disconnect before children start, the round shows one parent incident (event + report line) and zero executed specialist failures: never-started lenses stay `pending`, none is `error`.
- Given lenses that started and failed, valid, failed and retried attempts stay distinguishable (unchanged Stage 2 truth preserved).
- Given multiple child batches in one round, batch composition, per-lens attempts and per-round counts stay truthful; no second round is minted and attempt budgets are not reset (existing pins re-verified).
- Given a frozen review, its packet bytes are not mutated by admission, display or recovery code (hash-identity test across preflight + abort paths).

## Implementation Notes

- Preflight check inventory (all read-only, bounded reads): `head-binding` (`sourceMovementSinceFreeze` + movementRef resolution), `frozen-packet:manifest.json` (byte re-read; deep-equal), `frozen-packet:diff.patch` / `spec-context.md` / `project-conventions.md` / `changed-files.json` (declared sha256 match + shape), `spec-context` (supplied-spec mode carries the CI section; no-spec mode exempt), `verification-evidence` (supplied-spec spec-context carries a HOST-RECORDED VERIFICATION section — embedded evidence or the explicit UNAVAILABLE disclosure), `ci-evidence` (record present, valid state; bound states name the frozen head), `evidence:evN` (frozen bytes readable, sized, hash-matched).
- `abortRound` truth rule: a lens is `error` at parent abort iff it has a `round.specialist-started` ledger start or a live chip; otherwise it stays `pending` forever (aborted round ⇒ not-started). One `round.parent-incident` event records `{note, startedAttempts, startedLenses, notStartedLenses}`.
- Wave-outcome honesty: interrupted rounds map lenses with ≥1 start to `error` ("attempt started; interrupted by parent failure") and zero-start lenses to an error state whose note begins `not started — parent incident` (the `ReviewLensResult` union keeps its two states; the note carries the truth). The durable INCOMPLETE reports state the same counts.
- Appendix CI line derives ONLY from the frozen manifest record (historical stability); `publicationBodyFor` threads it through unchanged bounds.
- Board `lensAttempts`: `listRoundSpecialistStarts` per round (LIMIT 17) merged with the legacy agent-label derivation at the MAX (never a sum): charged-but-unregistered starts count, and pre-event legacy rounds keep label-derived counts.
- **Advertised-branch probe fix (head binding):** `advertisedRemoteBranch` now applies only to refs that RESOLVE to `refs/remotes/<remote>/<branch>` and pass `check-ref-format --branch`. A revision expression (`origin/topic~1`) or a slash-named tag (`origin/v1`) is not a branch spelling — previously their ls-remote probe exited 2 and poisoned the round as `check-failed` movement (verified at baseline `6cdd5ab` with a direct `sourceMovementSinceFreeze` probe: `{"cause":"check-failed",...ls-remote...}`), silently forcing those pinned rounds INCOMPLETE. The remote-lookup-failure contract is preserved for genuine tracking-ref spellings (the pinned test now drives `origin/feature/review` and still demands the redacted check-failed rejection).
- The new `dist/dispatch/perkins-review/admission.js` is registered in the finite `PUBLIC_REVIEW_EXECUTABLE_PATHS` provenance catalog (review-executable-paths.ts) — an unpacked tarball without it fails the installed-runtime fingerprint fail-closed.
- Fail-before evidence (baseline worktree at `6cdd5ab`, tests written first): the admission module/events did not exist (`perkins-admission-preflight.test.ts` cannot import `admission.js`); the interrupted-round pins asserted `lenses.every(state === 'error')` — the dishonest slate this stage removes; `appendRecordedVerification({evidence:null})` returned the spec unchanged (silence); the appendix had no CI-state line or attempts-totals line; `abortRound` flipped every pending chip to `error` (observed via the two updated reconciliation tests failing against the new expectations before the perkins.ts change); the R4/R5 pin rounds recorded `round.head-moved`-class check-failed movement (direct probe above).
- Pass-after local runs (post-round-6 remediation head, full gate): lint ✓, typecheck ✓, build ✓; fast backend 1892 passed/11 skipped; heavy backend 879 passed/6 skipped across all 30 files; web workspace 515/515.

## Spec Change Log

## Review Triage Log

- **Round 6** (bmad-code-review re-review on d126f0c → `review-gh-169-bmad-round6.md`, verdict BLOCK: 12 items): eleven remediated, one accepted residual — R6-1 restart promotion reconstructs deferred lens outcomes from durable evidence and commits them ATOMICALLY with the promoted verdict (a promoted round can never keep pending unused chips); R6-2 the complete-review `round.perkins-review` event lands only AFTER the atomic verdict/chip commit (an aborted round never carries a complete:true event); R6-3 the async ref-identification fails CLOSED on timeouts/kills/spawn failures (only an established non-zero git exit — a proven invalid spelling — may skip the remote proof); R6-4 one cumulative admission budget flows through every async probe step; R6-6 the on-disk manifest is byte-compared against the ledger's round.freeze-manifest receipt (a whitespace-only rewrite refuses admission); R6-7 the finalization report heading follows the DURABLE incident marker and discloses a failed terminalization; R6-8 a settled-INCOMPLETE never returns done/not-used results for lenses whose deferred chips never committed; R6-9 wave-level remote-only advance caught by the async probe before spawn; R6-10 a posted body with a frozen UNAVAILABLE record publishes MISSING distinctly (not FAILED, not NOT RECORDED); R6-11 settled a1 + journaled-unsettled a2 on the SAME lens keeps both attempts in chip note, returned result and host INCOMPLETE report; R6-12 a TRANSIENT second-chip failure lets the abort complete with one incident and consistent terminal state. **Accepted residual (R6-5):** the LOCAL admission head proof (rev-parse/status on the just-frozen local checkout — sub-process but local-filesystem bound, no network I/O) remains synchronous; the network-bearing probe (ls-remote) is off-loop and bounded. Moving the local proof async is a mechanical refactor of the sync preflight with no observed stall class (local git on a hot checkout); recorded for the owner's gate rather than risk-limboed in this stage.

- **Round 5** (bmad-code-review re-review on 27d7593 → `review-gh-169-bmad-round5.md`, verdict BLOCK: 9 items; round-4 R4-4/7/8/9 closed): all nine remediated — P1 (high) NEW transactional `finalizeRoundVerdictWithLensOutcomes` in the ledger commits the deferred not-used chips AND the verdict in ONE transaction (any failure commits nothing: round stays live, deferred chips pending, abort legal; the injected-explosion test re-pinned to the atomic shape); P2 attempt-level truth inside recordLensResults (a settled a1 + journaled-unsettled a2 keeps a1's verdict AND appends 'started but unsettled: a2' to the chip/result in both settled branches); P3 the async admission probe performs its OWN ref identification with async bounded git calls (check-ref-format/rev-parse/remote/ls-remote all off-loop; non-branch spellings SKIP exactly like the sync helper); P4 CI counts labeled 'retained check(s)'/'retained failing check(s)' (the frozen arrays are the capped retained sets); P5 the pre-spawn workflow refusal returns 'not started — setup refusal (no review owner spawned)' notes matching its no-incident ledger truth; P6 the exact UNAVAILABLE no-bound-run disclosure asserted in the LEAD prompt; P7 WaveRunner-level stalled-remote test: a timer ticker keeps ticking through the 5 s probe (loop responsive), the arm refuses fail-closed head-binding with a no-spawn receipt and zero agents; P8 mid-loop settled-chip failure injection (second write throws): first lens keeps its committed done chip/result, the failed-write lens keeps live with an interrupted result, no invented failures; P9 dual failure (poster throws + host-report write-once collision): returned/event/escalation all name perkins-report.delivery-incomplete.md as the fallback, lead report preserved. Timing-dependent tests (residency queue, queued handoffs, branch-idle replays) now wait on events/wall time instead of bare setImmediate drains (setup gained a real async subprocess await). Round-5 rejected claims (B1/B3, B7 low) stay rejected. Gate at this head: lint/typecheck/build green; backend fast 1892; heavy 875 (30/30); web 515.

- **Round 4** (bmad-code-review re-review on d125a98 → `review-gh-169-bmad-round4.md`, verdict BLOCK: 9 items; round-3 P1/P6/P7/P8 closed, P2/P3/P4/P5 partial, P9 wave-gap open): all nine remediated — R4-1 the deferred not-used chips commit BEFORE the verdict transition (a posted verdict can never coexist with pending unused chips; a chip-write failure aborts a still-live round legally; injected ledger-explosion test pins chips/verdict/outcome agreement and no invented post-verdict abort); R4-2 a journaled-but-unsettled lens is an honest execution-gap error chip + result, never 'not used' (wave-level pin via a freeze-boundary-charged start: appendix discloses 'started-but-unsettled: edge a1' and excludes it from not-used); R4-3 `recordLensResults` fills a caller-held mutable accounting INCREMENTALLY and the abort path reconciles from DURABLY COMMITTED chips (a mid-loop throw can never map an already-done lens to an interrupted error); R4-4 the 'Specialists run' line is labelled '(settled)' and names journal-only started lenses instead of printing 'none'; R4-5 a failed host-INCOMPLETE write names the CURRENT reportFile as the fallback (event + escalation agree with the returned path); R4-6 the advertised-tip remote probe at admission is now ASYNC (`probeAdvertisedTipMovementAsync`, injected into the preflight; the sync probe is skipped) — a stalled remote no longer blocks the event loop (responsiveness pin: unrelated timers complete while the probe waits); R4-7 an oversized BOUND verification run freezes through the real wave as the explicit VERIFICATION EVIDENCE OMITTED notice (never NO BOUND RUN; geometry sized from the actual rendered block); R4-8 board retry ×2 from ledger-only starts with one registered child (MAX merge preserved); R4-9 remote-only advance on a fully-qualified tracking ref (push from a second clone; local ref unmoved; advertised target-moved proof). Round-4 rejected claims (B1/B6, B7 low) stay rejected. Gate at this head: lint/typecheck/build green; backend fast 1892; heavy 872 (30/30; admission 17/17, wave 168/168, freeze 25/25); web 515.

- **Round 3** (bmad-code-review re-review on 7f88fbf → `review-gh-169-bmad-round3.md`, verdict BLOCK: 9 items; Q1/Q3/Q4/Q7–Q10 of round 2 closed, Q2/Q5/Q6 residual): all nine remediated — R3-P1 attempt-granular unsettled accounting (`settledExecutionFactsLine`, `SpecialistStartFact`; a settled a1 can never hide a charged a2; unit pin); R3-P2 conclusive appendix start totals sourced from the start journal (`AppendixStartTotals`; a started-but-unsettled lens is disclosed as such and never published as not-used); R3-P3 finalization-abort reconciliation (settled chips commit immediately, not-used chips defer until the verdict records; a ledger-explode injection test proves settled truth kept, never-started lenses pending, returned results consistent, no invented failures); R3-P4 a failed host-INCOMPLETE report write is loud (event payload `hostReportWriteFailed`, escalation names the lead-report fallback; write-once collision test); R3-P5 the advertised-remote probe at admission is bounded (`ADMISSION_REMOTE_PROBE_TIMEOUT_MS` 5 s; a stalled remote refuses fail-closed in seconds — pinned with a sleeping ls-remote shim); R3-P6 FLOW.md distinguishes pre-spawn setup interruption (no incident event) from a spawned round's single parent incident; R3-P7 every contract-required CI key must be PRESENT (null permitted, absence malformed; nested url included); R3-P8 the wave corruption test now breaks two independent inputs and asserts both names in the event, the thrown refusal and the escalation; R3-P9 a spec with no room for ANY verification section refuses at assembly (wave-level pin: aborted-no-spawn round, nothing frozen silently). Round-3 rejected claims (B1/B2/B3/B4, B9 low) stay rejected. Gate at this head: lint/typecheck/build green; backend fast 1891; heavy 869 (30/30; admission 16/16, wave 166/166); web 515.

- **Round 2** (bmad-code-review re-review on 572b50b → `review-gh-169-bmad-round2.md`, verdict BLOCK: 10 items): all ten remediated — Q1 changed-files.json shape+equality checked at admission (one named check); Q2 full CiEvidenceRecord contract validation (typed nullable provenance, integer pr/sourceSeq, REQUIRED failure conclusion); Q3 exactly ONE verdict per named admission check (spec digest + UTF-8 decodability combined); Q4 pre-spawn interruptions (setup shutdown, pre-spawn workflow failure) no longer claim a parent incident — the report heading follows the ledger truth (Setup interruption/refusal wording; deterministic pins); Q5 journaled starts vs settled results separated (started-but-unsettled lenses named, never "not used"); Q6 the returned `outcome.reportFile` for a settled INCOMPLETE is the host-owned `perkins-report.host-incomplete.md` linking the preserved lead report and carrying the counts (escalation names it; wave-level pin); Q7 untrusted CI failure names individually bounded and visibly elided past 5 (+hostile-name pin); Q8 abortRound persists the incident event FIRST from the pre-abort classification (idempotent append; startedSpecialistLenses also folds a persisted incident's startedLenses so a partial abort can never relabel a child never-started); Q9 a real WaveRunner admission refusal exercised through the `reviewFreezeObserver` freeze-boundary seam (named refusal event, no-spawn receipt, zero agents, lane swept); Q10 packet bytes hash-pinned through the real abort path and the full settled round (plus the unit read-only pin). Round-2 rejected claims (R1/R3/R5/R7) stay rejected with the reviewers' own verification. Gate at the remediation head: lint/typecheck/build green; backend fast 1891; heavy 862 (30/30); web 515.
- **Round 1** (bmad-code-review, four gpt-6-sol reviewers on b30dd22 → report `_bmad-output/implementation-artifacts/review-gh-169-bmad-round1.md`, verdict BLOCK): all 11 patch action items accepted and remediated in the remediation commit — P1 invalid-UTF-8 spec decode folded into the guarded exhaustive refusal (+test); P2 full CI-record shape validation at admission (checks/failures arrays and items; +test); P3 oversized bound verification evidence renders the bounded omission notice or refuses the freeze (never silent; +tests); P4 every missing-input NAME always reaches the refusal message (details elide as a group; +test); P5 ONE started classification (journal ∪ live chips) shared by abortRound, the parent-incident event, interrupted outcomes and facts (restart pin corrected); P6 restart reports carry pre-abort execution facts (+charged-start test); P7 lead-submitted INCOMPLETE rounds get a write-once host-facts artifact plus the facts in the event payload; P8 parent-incident is idempotent across partial abort/recovery (+double-recovery test); P9 fully-qualified revision expressions (refs/remotes/origin/topic~1) excluded from the advertised probe, genuine qualified tracking refs keep it (+wave-level pin); P10 the posted body's CI state asserted against a real posting round with a frozen FAILED record (B10 extended); P11 board lensAttempts pinned from a ledger-only charged start (MAX merge). The three reviewer-rejected claims (evidence receipt gate; two-state result union; MAX legacy merge) stay rejected — they match the approved spec inventory.

## Design Notes

- Preflight is deliberately after the freeze (not before): the freeze is
  what makes "accessible" checkable — the packet is validated from its own
  frozen bytes, never from live sources, and a refusal leaves a no-spawn
  aborted round whose artifacts name exactly what was missing.
- The parent-incident event is the single round-level counter ("one lead
  disconnect = one parent incident"); lens chips remain per-child truth.
- not-started ≠ not-used: `not used` stays a DONE outcome on conclusive
  rounds (lead-owned whole-PR review); `pending` on an aborted round is the
  not-started display; neither is ever an error chip.

## Verification

**Commands (local; scheduled `/api/verify` full gate follows per program):**
- `npx vitest run test/perkins-admission-preflight.test.ts test/perkins-builtin-wave.test.ts test/perkins-whole-review.test.ts test/verification-evidence.test.ts test/review-inputs-handoff.test.ts test/board-engine.test.ts test/board-engine-v4.test.ts` — expected exit 0.
- `npm run lint && npm run typecheck && npm run build` — expected exit 0.
- `npm run test:backend` — expected exit 0 (full backend suite).
