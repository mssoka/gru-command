---
title: 'Audited retirement of stale re-brief requests on terminal jobs'
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

**Problem:** A re-brief admitted while a job was nonterminal can outlive the job. When the job later reaches `merged`/`done`, boot reconciliation still sees the pending marker pair; `redispatchGroup` refuses the terminal lane, so the request is preserved and escalated `action-required` again at every boot (live: merged `board-for-you-owner-actions`, `perkins-whole-pr-review`, 2026-09-30 08:03Z), while the delivery-only shortcut could otherwise fabricate a `job.delivered` from terminality. No audited disposition exists for the obsolete markers.

**Approach:** At boot, a terminal job's pending re-brief markers are administratively retired: one `silas.rebrief-retired` audit event carrying the request identity (ids, kinds, payload hashes, baseline watermarks, worker/session refs) and the terminal reason commits in the same transaction as the identity-checked marker deletion. No spawn/resume, no fabricated guarded events, no reopen, no new action-required alert. Admission and finalization recheck the job boundary and fail closed; nonterminal jobs keep every existing recovery path.

## Boundaries & Constraints

**Always:**
- Retire only a `merged`/`done` job's markers, and only when at least one guarded event is unlanded; deletion is conditional on the examined identity (marker id + kind + payload hash + baseline watermark), so a newer request generation is never erased and replays are no-ops.
- Audit event + deletion are one transaction (`retirePendingRebriefs`). `clearPendingRebriefs` stays the events-landed success path, not a cancellation.
- `beginPendingRebrief` rechecks terminal status inside its own transaction (the installed HTTP guard stays); recovery and finalization recheck the job before spawning/recording.
- Blocked/parked/held jobs, missing jobs, malformed markers: existing honest recovery/escalation unchanged. Retirement posts no notification.

**Never:** spawn/resume/kill workers for terminal requests; fabricate `job.delivered`/`silas.rebrief`; reopen status; post an action-required alert for retirement; schema migration, new endpoint, daemon/timer, dependency; live-ledger run; touch the review-eligibility interlock, #136 directive family, UI/board, cancellation classification, owner alert disposition, or other lanes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Terminal pair, events unlanded | boot reconcile, job merged | one audit event + both markers deleted; 0 workers; 0 alerts | N/A |
| Only `job.delivered` remains | merged job, `silas.rebrief` landed | administrative retirement; no fabricated delivery | N/A |
| Repeated/concurrent pass | markers gone after first retire | next pass examined 0; exactly one audit event | N/A |
| Newer marker generation | candidate ids replaced before retire | skipped, not deleted; no audit for the old snapshot | caller logs skipped ids |
| Terminal flip mid-turn | worker gated, job merged, then turn settles | finalize retires; no guarded events; artifacts preserved | N/A |
| Admission race | HTTP guard passed, job merged before marker write | `beginPendingRebrief` throws; no markers written | named error to caller |
| Nonterminal / missing / malformed | blocked, parked, absent job, bad row | existing redispatch/escalation unchanged | escalate as today |

</frozen-after-approval>

## Code Map

- `src/ledger/api.ts` -- add `PendingRebriefRetireCandidate`/`PendingRebriefRetirement` + `retirePendingRebriefs` (atomic audit + identity-checked delete, terminal recheck); harden `beginPendingRebrief` inside `this.transaction`. Reuse `transaction`/`appendEvent`/`listPendingRebriefs`; leave `clearPendingRebriefs`/`bindPendingRebriefWorker` alone.
- `src/dispatch/rebrief-recovery.ts` -- `reconcilePendingRebriefs`: retire non-empty missing sets on terminal jobs before the delivery-only shortcut; add `retired` to `ReconcileReport`. `redispatchGroup`: terminal refusal retires, not throws. `finalizeRebriefRequest`: retire when the job went terminal; skip `silas.rebrief-recovered` then.
- `src/dispatch/server.ts` -- surface disposition (response field + log); keep the installed guard.
- `src/main.ts` -- log `retired` beside existing counters.
- `test/rebrief-recovery.test.ts` -- boot retirement (pair + delivery-only), repeated-pass idempotence, gated mid-turn race, terminal-vs-unrelated separation, nonterminal preservation.
- `test/ledger-api.test.ts` -- terminal intake refusal, atomic retire + replay no-op, newer-generation identity guard.
- `test/suite-shape.test.ts` -- bump pins for edited test files.

Shared seams if main/#136 moves: #136 appends directive reconciliation to `rebrief-recovery.ts` and adds ledger APIs; review-rebrief-interlock owns review eligibility — do not touch those regions.

## Tasks & Acceptance

**Execution:**
- [x] `src/ledger/api.ts` -- retirement types/method + terminal intake check -- the only seam allowed to delete markers as cancellation.
- [x] `src/dispatch/rebrief-recovery.ts` -- reconcile/finalize/redispatch terminal branches + report field -- boot and turn boundaries.
- [x] `src/dispatch/server.ts`, `src/main.ts` -- surface disposition -- truthful operator log/response.
- [x] `test/rebrief-recovery.test.ts`, `test/ledger-api.test.ts` -- deterministic tests (fake ledgers/registries, gated promises; no sleeps) -- prove fails-before/fixes-after.
- [x] `test/suite-shape.test.ts` -- bump pins -- phantom-check guard.

**Acceptance Criteria:**
- Given a merged job with an admitted pending pair, when boot reconciles, then markers are deleted with exactly one `silas.rebrief-retired` audit (ids/kinds/hashes/watermarks/agent/session), no spawn, no guarded events, no new action-required alert, job stays merged.
- Given a restarted/concurrent pass or a replaced marker generation, then no duplicate retirement, no partial unaudited deletion, no erased newer request.
- Given a terminal flip during finalization or an admission race, then no event recording/reopen/spawn; failed boundary checks leave markers to existing escalation.

## Design Notes

- Spent markers (all guarded events landed) keep the `clearPendingRebriefs` success path: the request was honored, so calling it a cancellation would be untruthful.
- Audit payload per marker: `id`, `kind`, `payload_hash`, `baseline_seq`, `note`, `agent_id`, `session_file`, `requested_at`, `guarded_event_landed`; job-level: `job_status`, `reason`, `skipped_ids`. No notification carries marker internals.
- `retirePendingRebriefs` returns `{retired, recorded, skippedIds, refused}`; a refusal (`job-missing`/`job-not-terminal`) deletes and records nothing so boot never fails on a defensive boundary.

## Implementation Notes

- Checkpoint 1 approval is carried by the dispatched work order (this slice is pre-approved/staged; the dispatch briefing is the human intent). No Open Questions were raised; the full spec is kept (est. ~1900 tokens, over the 1600 proposal, single cohesive goal — splitting would be artificial).
- Implemented by the lane minion directly (no subagent capability in this runtime). Red phase: `test/rebrief-recovery.test.ts` + `test/ledger-api.test.ts` → 9 failed / 31 passed (only the new cases). Green phase after implementation → 40/40; `test/dispatch-server.test.ts` 20/20 and `test/suite-shape.test.ts` 2/2 at the lane head. Evidence transcripts are retained OUTSIDE the reviewed artifact — the repo git-ignores `_bmad-output/` and `*.log`, so the files are in the lane worktree only and were never force-added: `_bmad-output/implementation-artifacts/terminal-rebrief-evidence/{red-phase,green-phase,seam-tests}.log` (sha256 `bc8c38f9d301948624fbffc316f53829806d4594df3780b79c299d6a3ebaecf4`, `64a2555d93f7d6ee51875b1f1b30123c42abf19cf90d8860863a575c0235f084`, `d9aa4b2bd9a20f93b9cf3a1ebdc4aadd4a2829064b59532548b635ebd9e98efc`) plus `post-change.diff` (sha256 `59a3b99e2a2b892a2fdc3375d725ec5f6c7eeb984bcc33eea2aa4701bfa46b8b`). The frozen artifact carries the deterministic tests and the suite-shape pins; this note is the portable pointer.
- Re-brief continuation (2026-09-30, source-only): the 14 fresh final-diff advisory candidates were triaged individually (table below). Four genuine in-scope repairs landed with deterministic tests: (1) a missing job never takes the delivery-only shortcut and `finalizeRebriefRequest` fails closed instead of minting history; (2) an incomplete terminal retirement returns a disposition that `redispatchGroup` and the endpoint surface, and never a `silas.rebrief-recovered` claim; (3) the ledger recomputes the audit's `guarded_event_landed` from its own events at transaction time; (4) the boot-retire audit test now asserts exact identity equality (hash/watermark/timestamp) per retired marker. Suite pins recomputed from the raw-source regex after the edits: dispatch-server 22, ledger-api 27, rebrief-recovery 20. A `terminal-rebrief` focused scope was declared in `.gru-command/worktree.toml` for ops verification; the local FULL gate remains owed (diagnosis below).
- Inherited (pre-existing at baseline c54bfbf) suite-shape drift: `owner-actions.test.ts` was absent from PINS (actual 8) and `github-poll.test.ts` was pinned 22 vs actual 24. History audit (the base-to-head diff does not show these two edits): both pins were repaired on main by `dae3ef4` ("restore the owner-actions pin lost in the #133 merge content") and `c0d0ec2` ("restore the github-poll pin also dropped by the #133 merge"), both ancestors of the integrated base `2aa836ab`; this lane's own pin task reconciles only the counts its added tests change (`dispatch-server`, `ledger-api`, `rebrief-recovery`). #136 fixes the same drifts independently (its `owner-actions` count is 28 because its branch grows that suite). Revalidate the `owner-actions.test.ts` line if #136 merges first.
- No deviations from the spec's frozen block; no schema change; no notification path added.
- Independent review receipts (not a conforming Perkins gate; not self-attested): three fresh same-model sessions ran the staged blind-hunter / edge-case-hunter / verification-gap prompts at pinned head `ba7f2d6`. Operational copies are preserved in the ops interlock sweep bundle `silas-interlock-0857-R2YFB9` (per-file hashes in its `independent-finding-artifact-preservation.json`); 11 + 3 + 3 findings + 1 other, triaged individually below as untrusted observations (every claim re-verified against the pinned code; the verification layer's recorded input-contract limit — it read its own clean base checkout beyond the strict supplied-only packet — means that layer is held non-conforming and none of its claims were pre-trusted).
- Exact-head CI receipts: run `36693133112` at `ba7f2d6` failed on the single inherited supervisor fixture race (`test/supervisor.test.ts:1132`, alert sampled after a fixed 50 ms while the 1/2/4 ms backoff rungs settle asynchronously; complete output preserved by the ops CI-failure capture for that run, sha256 `30404663f06753d2b4089657df39de52b28fd7d67839cab445d9fa58f73d517a`). Causal fix: the test now waits on the condition itself (`vi.waitFor`, this file's own convention) instead of a fixed real-time slice; no assertion weakened, no timeout raised, no semantics changed. Run `36697299977` at `ef5211` then failed on (a) the new administrative-retirement test asserting a null `job.delivered` where the initial dispatch turn's historical delivery (seq 6, source `dispatch`) is correctly retained, and (b) two personal absolute paths in these receipt notes. Both fixed in place: the test now proves no POST-boundary fabrication while preserving the historical event and terminal status, and the receipts are portable (second complete output sha256 `520de1d719d10a206c1f057f1fd9ed543ffca9969c9c29a239e4e70507db6d7f`).
- Full suite + native Perkins + exact-final-head CI remain owed gates; the two focused local runs are not a substitute and no READY/PASS is claimed.
- Final raw-advice triage (2026-10-01, packet head `62f5c54`): the 12-row factual disposition is preserved in the ignored `_bmad-output/implementation-artifacts/ops-triage/pr142-final/` (never force-added). Repaired in this head: `retirePendingRebriefs` refusals no longer report unexamined candidates as `skippedIds` (refuse/skip truth); the boot all-skip branch and the retirement log lines gained deterministic pins; FLOW/LEDGER/close-out docs describe the terminal-retirement outcome; queued-vs-settled counter semantics documented. Suite pins recomputed from the raw guard regex: `rebrief-recovery` 21 (`dispatch-server` 22, `ledger-api` 27 unchanged) — historical figures at that head only; the live pins are asserted by `test/suite-shape.test.ts` and were recomputed again with every later test addition. No frozen-intent change, no new event kind.

## Review Triage Log

Every original finding is preserved and individually auditable in the preservation directory named above; verdicts were rendered after re-reading the pinned code (not from reviewer severity). Grouped dispositions follow the table.

| ID | Layer | Original finding (own anchor) | Verdict | Evidence / disposition |
|---|---|---|---|---|
| B1 | blind | `retired` flag conflates "terminal branch examined" with "retired" | false | The refusal/skip state is unreachable: the terminal branch requires a terminal, non-null job and the ledger re-read runs in the same synchronous section (no await, single writer); jobs are never deleted. Comment tightened to "actually retired". |
| B2 | blind | `skippedIds` never logged; spec promises caller logs skipped ids | low | Fact confirmed. All-skipped is defensive-only today, but the promised trace now exists: `warn` else-branch at both terminal call sites. |
| B3 | blind | `refused` outcome silently dropped at both call sites | low | Same root cause as B2; refusal unreachable (B1), now logged with `refused` + `skipped` instead of silence. |
| B4 | blind | terminal intake throws generic `Error`, not a typed "named error" | low | Message names job + status and is asserted; no consumer branches by type; HTTP fails closed with 400 either way. Adding an exported error class would widen the ledger public API against the mandate. Rejected, reason recorded. |
| B5 | blind | `guarded_event_landed` caller snapshot could go stale before deletion | false | Candidate construction and the retire transaction run in one synchronous section on the single-writer ledger; no event can land between them. |
| B6 | blind | no test covers the new HTTP retirement disposition | medium | Confirmed. Fixed: new `/api/silas/rebrief` test (gate turn → merge mid-turn → 200 + `retired:true` + `delivered_sha:null` + no fabricated events + retirement audit); `dispatch-server` pin 20→21. |
| B7 | blind | `redispatchGroup` terminal branch untested/unreachable | low | Unreachable only because the same-tick loop check precedes it; it is the fail-closed boundary the frozen intent requires ("recovery ... recheck the job at their boundary") and is documented in code. Keeping it. Rejected, reason recorded. |
| B8 | blind | `done` status never exercised | low | Confirmed. Fixed: new deterministic `done` test asserts a retired audit with `job_status:"done"`, no spawn, markers gone. |
| B9 | blind | suite-shape pin repairs bundled into this change | low | Fact; splitting a pushed commit needs rebase/reset (prohibited). Bundling is recorded here, in the commit body and in the PR body with the #136 merge-order caveat. Rejected, reason recorded. |
| B10 | blind | "no notification" asserted only for one family | low | Confirmed. Fixed: the terminal-pair and spent-marker tests now assert the whole notification log is empty. |
| B11 | blind | evidence cited `/tmp`; deferred suite/verify should be a merge precondition | low | Evidence was already preserved in-tree before the review; the Implementation Notes now cite the durable path. The deferred full gate is already stated as a precondition. |
| E1 | edge | `finalizeRebriefRequest` with a null job proceeds without a missing-job guard | false | Jobs have no deletion path; `pending_rebriefs.job_id` references `jobs(id)`; the pre-existing null-job behavior is unchanged for a state the service cannot produce. |
| E2 | edge | zero-retired runs drop `skippedIds`/`refused` silently | low | Same root cause/fix as B2/B3. |
| E3 | edge | duplicate candidate ids double-retire/double-audit | false | In-tree callers pass PK-unique marker sets from one listing; no caller can produce duplicates. |
| V1 | verification | endpoint retirement disposition has no test | medium | Independently re-verified against the pinned head despite the layer's non-conforming input limit; same fix as B6. |
| V2 | verification | audit `agent_id`/`session_file` refs carried by no test | low | Confirmed. Fixed: the boot-retire test now binds a worker/session and asserts both refs (and `note`) in the retirement audit. |
| V3 | verification | spent markers on a terminal job not pinned to the completed/clear path | low | Confirmed. Fixed: new spent-markers test asserts `completed:1`, `retired:0`, markers cleared, no retirement audit. |
| V-O | verification | caller never logs skipped ids (other finding) | low | Same root cause/fix as B2/B3. |

**Grouped dispositions (no loopback required — no intent_gap or bad_spec entries):**
- G1 (B2, B3, E2, V-O): low — patch applied (defensive disposition logging + truthful `retired` doc comment).
- G2 (B6, V1): medium — patch applied (endpoint test + pin).
- G3 (B8): low — patch applied (`done` test).
- G4 (V3): low — patch applied (spent-markers test).
- G5 (B10): low — patch applied (full notification-log assertions).
- G6 (B11): low — patch applied (durable evidence path in these notes).
- False with recorded reasons: B1, B5, E1, E3. Low rejected with recorded reasons: B4, B7, B9. Originals remain untouched in the preservation directory.

### Final-diff advisory triage (2026-09-30; 12 adversarial + 1 edge + 1 verification raw candidates)

Raw candidate outputs are preserved by ops at `silas-ops-sweep-20260930T202418Z/pr142-final-{adversarial,edge,verification}-1a1c6a2-20260930-findings.json` (packet base `2aa836ab` → head `1a1c6a2`, patch sha256 `4df502e3…`, manifest sha256 `51d28c57…`). Every row below was re-verified against the pinned code; none is a native verdict.

| ID | Source | Finding anchor | Verdict | Evidence / disposition |
|---|---|---|---|---|
| R1 | adversarial 1 | unresolved `silas.rebrief-unreconciled.<jobId>` incident survives retirement | reject — out of scope | Owner-alert disposition/notification lifecycle is excluded (Boundaries: “owner alert disposition”; original briefing excludes “notification ACK automation”); acceptance bars only a NEW action-required alert. Raw finding preserved for owner adoption. |
| R2 | adversarial 2 | `finalizeRebriefRequest` discards `refused`/`skippedIds`; endpoint returns a silent 200 | accept — repaired | `PendingRebriefFinalize.retirement` now carries `{refused, skippedIds}`; `redispatchGroup` and the `/api/silas/rebrief` handler log `warn`; the response includes `retirement` when markers were kept. Tests: `finalize reports an incomplete terminal retirement…`, `/api/silas/rebrief surfaces a retirement that retired nothing…`. |
| R3 | adversarial 3 | endpoint re-implements `merged`/`done` instead of `isJobTerminal` | reject — not a defect | No current divergence: `isJobTerminal` is exactly `merged`/`done`, and the ledger backstop already shares it. The rationale is future terminal-set expansion, which is not licensed by raw critique; no current acceptance gap. |
| R4 | adversarial 4 | `job === null` falls into the delivery-only shortcut and mints `job.delivered`/`silas.rebrief-recovered` | accept — repaired | The shortcut now requires a non-null job and falls through to the honest re-dispatch escalation; `finalizeRebriefRequest` throws for a missing job instead of recording. Tests: `a missing job never takes the delivery-only shortcut…`, `finalize fails closed for a missing job…`. |
| R5 | adversarial 5 | audit `guarded_event_landed` copied from the caller snapshot | accept — repaired | `retirePendingRebriefs` recomputes the flag in-transaction from `latestJobEvent(row.jobId, row.kind)?.seq > row.baselineSeq`; the candidate no longer carries the field. Test: `the retirement audit recomputes guarded_event_landed from the ledger, not the caller`. |
| R6 | adversarial 6 | skipped/refused outcome has no durable trace beyond an optional log | reject as written | The durable trace is the surviving marker row itself plus the warn logs now emitted at every retirement call site (R2). A new `silas.rebrief-retire-skipped` event kind or `ReconcileReport` field is extra ledger surface not required by the acceptance; a full skip is defensive-only. |
| R7 | adversarial 7 | `delivered_sha: null` even when the delivery event landed | reject — contract preserved | Null deliberately means NO NEW delivery; the historical event stays on the ledger and the audit records `guarded_event_landed: true` for it (pinned by the lone-delivery-marker test). Erasing historical evidence is explicitly forbidden. |
| R8 | adversarial 8 | board `SILAS_RECONCILE_KINDS` lacks `silas.rebrief-retired` | reject — out of scope | Board/UI metrics redesign is excluded by the spec’s Never list and the re-brief; acceptance requires no board counter, only truthful retirement records. |
| R9 | adversarial 9 | spec claims owner-actions/github-poll pin repairs not present in the frozen diff | accept — spec corrected | History audited: the repairs are main commits `dae3ef4`/`c0d0ec2` (ancestors of `2aa836ab`); the note now names them and scopes this lane’s pin task to its own counts. |
| R10 | adversarial 10 | cited evidence transcripts absent from the frozen tree | accept — spec corrected | The transcripts are git-ignored lane evidence; the note now says so with sha256 pointers and does NOT force-add raw logs (edge E1 rejected below). |
| R11 | adversarial 11 | `redispatchGroup` appends `silas.rebrief-recovered` when the terminal branch retired nothing | accept — repaired | `finalized.retirement !== null` now returns with a `warn` and no recovery event; pinned by the mid-turn test. |
| R12 | adversarial 12 | refused/all-skipped outcomes untested through the call sites | accept — tests added | The two R2/R11 repairs each carry a deterministic test; a `done`-job and spent-marker path were already pinned. |
| E1 | edge 1 | `git add -f` the evidence logs into the tree | reject — instruction forbids | The re-brief explicitly forbids force-tracking private/raw logs; originals stay ignored/external with truthful hash pointers (R10). |
| V1 | verification 1 | audit identity scalars asserted only for shape/positivity | accept — test strengthened | The boot-retire test now compares `payload_hash`, `baseline_seq`, `requested_at` (and kind) to the pre-deletion markers per id, not to regexes. |

## Verification

**Commands:**
- `npx vitest run test/rebrief-recovery.test.ts test/ledger-api.test.ts` -- expected: new cases fail pre-change, pass after.
- `npx vitest run test/rebrief-recovery.test.ts test/ledger-api.test.ts test/dispatch-server.test.ts test/suite-shape.test.ts` -- the declared `terminal-rebrief` focused scope (`.gru-command/worktree.toml`); verifies the repaired seams and recomputed pins at unchanged budgets. Focused green is never FULL clearance.
- `npm run lint && npm run typecheck` -- expected: clean.
- `npm run build` -- expected: clean.
- Full suite + `/api/verify`: coordinated with Silas at a media/process-safe checkpoint (>=36GiB free); not run by this lane.

**Final-head full-gate diagnosis (scheduler `b4b7d760-5ddb-4ce4-bc9d-0c75d20f98b6`, ledger 32742, head `1a1c6a2`, exit 1):** exactly three failures, each `Test timed out in 30000ms` with no assertion, thrown error, RPC or signal failure — `test/dispatch-server.test.ts` by=silas 34548ms, `test/perkins-builtin-wave.test.ts` T4 48560ms, `test/wizard.test.ts` `--answers rejects secrets…` 35267ms; backend 1459 passed / 12 skipped; web not reached. Raw output preserved at `silas-ops-sweep-20260930T202418Z/pr142-full/` (199 frames, 99470 bytes, sha256 `c388c56e…`; receipt binds nested `outcome.exitCode=1`).

- **Mechanism:** wall-clock deadline overruns of the three longest subprocess/worktree-bound tests, not hangs or logic failures.
- **Source mapping:** the lane diff touches none of the exercised timeout paths — T4 exercises `src/dispatch/perkins.ts` (untouched); the wizard test runs `dist/wizard/main.js` (no `src/wizard/**` change); the by=silas test exercises the `/api/dispatch`, `/api/dispatch/pr`, `/api/dispatch/review` handlers while the only `src/dispatch/server.ts` changes are inside the `/api/silas/rebrief` handler; `src/main.ts`’s one-line boot counter is on no test path here.
- **Cross-check:** the exact head passed the full CI suite on GitHub run 36769728953 (job “Full suite (Node 22)”; T4 1361ms, by=silas 1123ms, wizard 8940ms). Compiled preserved local history shows the same three tests repeatedly breaching the 30s default on this host across unrelated heads (dispatch-server 55 fail / 34 pass, T4 9 / 56, wizard 59 / 28) — a local wall-clock sensitivity of those inherited tests, not a property of this change set.
- **Not claimed:** the specific trigger of the `b4b7d760` overruns is not isolable from static evidence, and host contention is not a proven root cause. No timeout/worker/pool flag is changed; the T4 180s override stays removed (j-470). The only executable discriminator for “does this recur at the frozen head” is a FULL re-run under unchanged runner/flags/budgets; a focused subset cannot decide it. If the overruns recur, a source-level repair of these three inherited tests is blocked by the standing no-timeout-change constraint — that is an owner/policy decision, not a lane invention.

**Manual checks:** keep the pre-change red transcript and post-change green transcript in the completion report; confirm no live-ledger run.

## Continuation 2026-10-02 — preserved-FULL diagnosis and the runtime-capability repair

Authority: continuous-completion continuation of this undertaking (re-brief; same
job/worktree/branch/PR142). Full trace, measured evidence and hashes live in the lane
evidence directory `_bmad-output/implementation-artifacts/pr142-full-red-continuation-20261002/diagnosis.md`
(git-ignored lane evidence, like the captured FULLs).

The preserved FULL at `b923c98` (runId `721efa02-f895-464e-b12e-f5ab428ed024`, ledger
39524; raw 141261B sha256 `384010ff…`, decoded 121526B sha256 `0c0f9ff8…`) failed exactly
four tests, all `Test timed out in 30000ms` with zero assertion failures:

| Test | Path traced | Disposition |
|---|---|---|
| `dispatch-server.test.ts:548` by=silas | `/api/dispatch/review` → `requestReview` → `setupRound` → `resolveFreezeTarget` (fixture probe/fetch) → review worktree + freeze diff | Aborted mid-review-POST (stray-probe evidence); ≥1 assertion ran. Open: inherited test unchanged from main; the genuine repair is being authored in the `review-rebrief-interlock` native-NEEDS-CHANGES correction (reviewed head `271540a7954e`, base `b900837`) — coordinate that ownership, no private copy. |
| `install-one-line.test.ts:604` owned/foreign service | Four synchronous `install.sh` runs (setup clone/build + refusal + print + owned restart) | Body completed; all assertions passed; the timeout is the post-hoc elapsed marker. Open: the genuine cost repair is PR141 `f2a7271` (drops the redundant setup cycle) — coordinate, no private copy. |
| `perkins-builtin-wave.test.ts:3385` N5 | `wave.runRound` real round (freeze, worktree, diff, fake lead/lens, prior selection, sweep) | Aborted mid-round, zero assertions ran. Open: no sibling repair exists; the next genuine step is this lane's one controlled full verification at a real paced capacity checkpoint, and if still red, an in-lane cause determination (instrumentation), never a budget claim. |
| `wizard.test.ts:462` `--answers` refusals | Four synchronous `node dist/wizard/main.js` children | **Repaired in-lane (`ce62304`):** every wizard process imported `runtime/probe.ts` → both adapters → the agent-SDK graphs for two static literals (~7s/invocation measured). Capability declarations moved to `src/runtime/capabilities.ts`; adapters re-export; probe consumes it; deterministic decoupling oracle added (sentinel adapter mocks; fails before, passes after); suite-shape pin 7→8. |

- The stray `fatal: cannot change to '…/fixture-silas-by'` was traced (not assumed):
  `execFileSync` forwards child stderr by default; the call site is
  `test/helpers/pr-head-probe.ts:14`, reached by the orphaned in-flight review request
  after the test timeout and fixture cleanup. Harness capture finding, no product fault.
- Independence from the lane diff (context, never a dismissal): the product diff
  (`rebrief-recovery.ts`, the `/api/silas/rebrief` handler, `ledger/api.ts`, the boot
  counter) is on none of the four paths, and the failing test bodies are unchanged from
  main — but these remain OPEN requirements until a controlled full verification at this
  head succeeds. A same-body pass/fail history is a lead to time-box, not a cause.
- Focused verification at the repaired head `2e42d61` (declared scope
  `runtime-capability-decoupling`, committed): `/api/verify` run
  `69c36574-23aa-4f45-be79-a36c8142662e` **PASS**, exit 0, not timed out, clean tracked
  tree; 123/123 tests across `runtime-probe` (including the new decoupling oracle),
  `claude-adapter`, `wizard`, `suite-shape`. Receipt + sinks: verify-capture
  `runtime-capability-decoupling-2e42d619a433-20261002T203135Z.*` (raw 13307B sha256
  `713f5006…`, decoded 6821B sha256 `43931e44…`). Measured effect: the wizard
  `--answers rejects secrets…` case is now 4045ms over four CLI invocations (36509ms in
  the preserved FULL; 7.7-11.5s per invocation pre-repair). Readiness reconciliation:
  the original queued run is terminal (39524/39547); the two pending rebrief rows are
  this session's own live dispatch pair, recorded in the receipt.
- Open dispositions and dependencies (corrected 2026-10-02, j861/j869/j870 continuation):
  j829 `gc-test-harness-budgets-20261002` is a **separate owner-held harness job**; its
  landing is NOT a prerequisite for this lane's completion, and its unlanded
  budgets/skip/timeout changes are never transplanted. The three open host-load timeouts
  are driven as: (a) dispatcher `dispatch-server.test.ts:548` — genuine repair owned by
  the `review-rebrief-interlock` native-NEEDS-CHANGES correction (actor: that lane's
  producer; repair: the reviewed blockers + inherited dispatcher/T4 failures; why
  indispensable: it authors the concrete dispatcher repair; re-reconcile at each main
  move and immediately before publish); (b) `install-one-line.test.ts:604` — genuine
  repair owned by PR141 `f2a7271` (crew-heist-labels head `3398b43`; same reconciliation);
  (c) N5 — no sibling owner: the next genuine step is this lane's one controlled FULL at
  a real paced capacity checkpoint, then an in-lane cause determination if still red.
  Prescribed independent read-only reviews are dispatched as separate tracked jobs from
  the frozen actual-head packet; publish → exact-head CI → one native Perkins handoff
  follow the controlled full verification.

### Continuation change map (packets outside the frozen block)

The frozen block above owns the retirement seams; the continuation adds files the frozen
block never names. That is a recorded continuation decision (the frozen intent itself is
unchanged), and each addition carries its own acceptance evidence:

- `src/runtime/capabilities.ts` + `src/runtime/probe.ts` + adapter re-exports — the
  measured wizard SDK-graph defect repair (`ce62304`); evidence: the `runtime-capability`
  focused PASS and the wizard case drop 36509ms → 4045ms.
- `test/runtime-probe.test.ts` — the decoupling oracle, strengthened after review to
  throwing adapter mocks (evaluation-level, not value-level).
- `.gru-command/worktree.toml` — focused scopes (`runtime-capability-decoupling`,
  `pr142-review-triage`) and the build-first `terminal-rebrief` scope; every scope names
  its precondition and none changes budgets/timeouts.
- `test/chat-server.test.ts`, `test/supervisor.test.ts`, `test/claude-adapter.test.ts`,
  `test/perkins-builtin-wave.test.ts` (T4 cost relief) — inherited-suite continuity
  repairs carried by the lane's main integrations; all pinned by their own suites.

### Independent review round (2026-10-02, packet `fa8b591`)

Three tracked read-only review jobs were dispatched through the authenticated
`/api/dispatch` surface (separate sessions/worktrees, artifact-only outputs):
`terminal-rebrief-review-{blind-hunter,edge-case-hunter,verification-gap}-fa8b591`.
Packet: `_bmad-output/implementation-artifacts/pr142-review-packet-fa8b591/` (frozen diff
sha256 `f1db5c10…`, 137700 bytes; briefing hashes in `packet.json`); harvested reports in
the same directory. Every claim was re-verified against the pinned code before a verdict:

| ID | Lens | Claim | Verdict |
|---|---|---|---|
| B1/E2 | blind/edge | partial retirement's kept ids dropped at the mid-turn log surfaces | accept — both logs now carry `refused`/`skipped`; new mid-turn partial test |
| B2 | blind | `retired:true` + `skipped_ids` combined contract unpinned | accept — new endpoint partial test pins both; log carries the ids |
| B3/E1 | blind/edge | `terminal-rebrief` scope can pass on a stale `dist` | accept — scope now inlines the build |
| B4/B5 | blind | LEDGER API catalog stale; "cleared ONLY" contradicts retirement | accept — both reworded |
| B6 | blind | spec pin figures historical vs live | accept — marked historical above |
| B7 | blind | no endpoint test for the missing-job throw | reject, reason recorded — jobs have no deletion path; the unit test pins fail-closed; a forced wrapper would pin generic error mapping |
| B8 | blind | dangling `silas.rebrief-unreconciled` incident disposition undocumented | reject, reason recorded — owner-alert disposition is an excluded boundary (prior R1); retirement posts no alert by contract |
| B9 | blind | frozen boundary/Code Map vs bundled diff | accept — change map above (frozen block untouched) |
| B10 | blind | `retired` counter partial semantics | accept (doc) — field comment + LEDGER clarified; counting semantics retained |
| B11 | blind | duplicate candidate ids can double-delete/double-audit | accept — dedupe guard + test |
| B12 | blind | `PendingRebriefRetirement.recorded` unread | accept — field dropped; tests assert the deletion/audit directly |
| B13 | blind | `t4-oracle` prerequisite comment overclaims | accept — comment corrected |
| VG1 | verification | endpoint warn line unpinned | accept — log capture + assertion |
| VG2 | verification | decoupling oracle observes values, not evaluation | accept — throwing adapter factories (verified to catch a side-effect import) |

Review returns are advisory artifacts, never native clearance; repairs are verified by the
`pr142-review-triage` focused scope and the controlled FULL.
