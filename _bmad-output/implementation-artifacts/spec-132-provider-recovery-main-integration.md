---
title: 'PR #132 provider-recovery fresh-main reconciliation'
type: 'chore'
created: '2026-09-30'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context:
  - _bmad-output/specs/spec-provider-recovery-sensor/SPEC.md
  - _bmad-output/specs/spec-provider-recovery-sensor/code-map.md
  - _bmad-output/specs/spec-provider-recovery-sensor/gate-matrix.md
---

<frozen-after-approval reason="re-brief-authorized integration; original approved sensor intent unchanged">

## Intent

**Problem:** PR #132 conflicts with current main after the #140/#131 merge wave and #133. The existing r4 fix and all approved recovery boundaries must survive reconciliation.

**Approach:** Rebase the lane onto verified remote default main, preserving the old head under a lane-local safety ref before any move. Resolve collisions by retaining both current-main lifecycle/admission/owner-routing behavior and the approved provider-recovery additions. Include reconciliation in the fix-loop delivery, not a new undertaking. Given a live review or verification round, defer the head move until it settles. Given WIP, preserve it rather than reset/stash/discard it. Given failed verification, preserve complete output and require a bounded ruling before retrying. Do not merge, restart, activate the sensor, call live providers, self-arm Perkins, or modify another checkout.

</frozen-after-approval>

## Implementation Notes

### Planning and shared-hook map (before product edits)

- BMAD build renderer invoked exactly once in this session; verified snapshot loaded successfully. No bootstrap bypass. Freeform integration work, not an epic story. No new owner-intent gaps or irreversible product action; branch history is recoverable through the safety ref and an explicit remote lease. Changes are reconciliation plus narrow compatibility repairs, not new recovery behavior.
- Takeover head: `5cd62b19809d334c30f595d72ce60cfed63d1eb5`. Tree clean, including untracked files; the existing shared stash belongs to another lane and is untouched. Current main/default: `c54bfbf89727bacfd27a27db65a9fab681c19c3e`. Previous integration base: `fb1e850716eb11ccaf141ae37a040a9490fc340f` (also the verified merge base).
- Latest native round `provider-recovery-sensor-r4` is verdict-posted/changes-requested at `c2036c34a5ef00b9b9c31a445595d752fe7ba6aa`. Recheck authenticated board immediately before rebase and remote update. Do not treat the board's original lane SHA as the current target.
- Inherited `/api/verify` run `e2eebb45-1601-4914-a9dc-072b3be4c8ed` has settled unsuccessfully during lint: `ok=false`, `exitCode=null`, `signal=SIGKILL`, `timedOut=false`. Complete capture validated against scheduler byte count/hash. No cause asserted. Ruling/checkpoint requested through authenticated `/api/silas/escalate`; no retries authorized by this note.
- `src/runtime/registry.ts`, `src/runtime/types.ts`, `src/runtime/pi-adapter.ts`: preserve main's ResidentBudget, queued resident proxy, FIFO admission, cessation evidence and review reservations; retain typed provider-error provenance and route binding. No second counter or cap behavior change.
- `src/supervision/supervisor.ts`: preserve main's owned registry disposal/quiescence path; retain the sensor's explicit wall ownership, incident linking and guarded same-slot recovery. Historical owner ACK and isolated review stops remain independent.
- `src/main.ts`, `src/config.ts`, `src/config-reference.ts`, `docs/CONFIG.md`, `docs/example.config.toml`: compose current-main resident configuration/wiring with existing provider-recovery configuration/wiring; never replace default route/credentials, add watchers, or activate the sensor.
- `src/dispatch/silas-driver.ts`, `src/dispatch/server.ts`: preserve the deterministic-pass hook, review branch-idle guard and normal admission; retain the durable provider.restored event/digest and guarded recovery claim endpoint. No explicit second wake.
- `src/ledger/api.ts`, `src/notifications/center.ts`: retain main's mode-aware owner incident dedupe plus explicit new machine-owned wall routing. `src/ledger/db.ts` retains the sensor's additive migration, with no live database changes.
- `src/runtime/residency-observations.ts` on main exposes handle/pool facts, not the sensor's claim/incident/route/session-turn join. The sensor's progress-gated fan-out port remains an unresolved integration limitation; do not invent a cap hook during rebase.
- `test/suite-shape.test.ts`: retain the union of new main suites and sensor suites; recompute only overlapping test-count pins by source inspection, not guesses. `test/provider-recovery-seam.test.ts` may need default concurrency configuration for main's registry. All fake-only sensor tests and r4 settle-attribution tests survive.
- Preserve prior verification failures and review findings, including unfinished r4 findings. No inherited CI/review result applies automatically to a moved head. Final deliverables: canonical head/base/PR, conflict/integration evidence, gate matrix, activation/rollback and remaining limitations under the approved delivery directory.

### Reconciliation results

- Safety ref: `refs/backup/pr132-pre-merge-wave-5cd62b1` retains the full original head. Eleven commits replayed without skipping; intermediate rebased code head: `10732164d769d5e55ba886abf59a1d63eb7e9e37`. No reset, stash, WIP discard, or other checkout change. The planning spec was ignored by the repository's existing `_bmad-output/` rule; it was preserved on disk through rebase and will be explicitly tracked.
- Authenticated pre-rebase guard: no pending/live review round, no active/queued verification; r4 settled changes-requested. Rebase proceeded only after the inherited full run had settled. The final remote update requires a second fresh guard and the exact old-head lease.
- `docs/example.config.toml`: retained `[concurrency] max_workers = 4`, `[review] max_concurrent_children = 2`, and the entire existing `[provider_recovery]` section, including default-disabled activation and fallback.
- `test/suite-shape.test.ts`: retained main's `perkins-whole-review` pin 67 and the measured union `pi-adapter` pin 65. R4 pins remain sensor 46 / resume 14. Static inventory then found two upstream-main inconsistencies: GitHub poll source has 24 cases but pin 22, and new owner-actions source has 8 cases but no pin. Corrected these two pins without modifying any test bodies. This is source inventory, NOT a passed test run or executed fails-before evidence.
- Source-union inspection: all 24 lane-only blobs equal the original head (including all sensor modules, fake tests and r4 attribution); all 63 main-only blobs equal current main; all 14 conflict-free overlapping files equal their full three-way merge. Only the documented example-config and suite-pin resolutions differ. No product behavior was added in this epoch and no cap interface was invented. Range-diff and machine-readable comparisons are preserved in delivery/integration-merge-wave.
- Verification blocker escalated once via authenticated ops: notification `bb156d8a-3158-49a3-8c19-f10cc16e2618`. No local test/lint/typecheck/build run or subset retry in this session while the failed-run ruling is outstanding. CI after a lease-guarded push is a separate gate, not a substitute for local verification.
- This runtime exposes no subagent tool for fresh independent BMAD review. The oneshot review prompt will be written with canonical final revisions for a separate session. It remains a separate OUTSTANDING gate; a self-read, native Perkins, or inherited review cannot substitute for it. This spec must not be marked done until required gates settle.
