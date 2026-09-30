---
title: 'Revert PR #137 compaction gate (rollback only)'
type: 'refactor'
created: '2026-09-30'
status: 'ready-for-dev'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'c54bfbf89727bacfd27a27db65a9fab681c19c3e'
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/CONFIG.md'
  - '{project-root}/docs/SUPERVISION.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** PR #137 (merge `dd11a328aeeeae8969238aa5cb5e8c7cc1e02c2f`; commits `c0de4f1d`, `ea98e777`, `0f36d6c0`) replaced native compaction behavior with service-owned proactive timing plus a provider-health deferral and a five-minute wrapper abort. The owner reports OpenAI compaction was slow but completed before a temporary GLM failure prompted the shared compaction changes, and a later chat had to be recreated because compaction failed. The owner approved a rollback of PR #137 ONLY. This is a rollback, not a new compaction design and not a claim that every failure's cause is proved.

**Approach:** Land one new history-preserving revert commit equivalent to `git revert -m 1 dd11a328` against first parent `85727deac83a5407e11f32b3c278f32047be86ea`, with minimal reconciliation for later main changes. Keep native/manual compaction, lifecycle event-driven delivery, persistence, and every unrelated later improvement. Report the old-config-key load result and the owner deployment prerequisite.

Owner approval: dispatch briefing 2026-09-30 (explicit rollback approval + instruction to run the lane BMAD workflow once without re-asking); recorded here as the standing Checkpoint-1 approval.

## Boundaries & Constraints

**Always:**
- Remove only #137 behavior: proactive gate + deferral in supervision, the `proactive_compact_percent` setting, and the adapter's compaction deadline/abort.
- Preserve post-#137 work in shared files (e.g. `openControl` view fields, cessation-evidence/dispose changes) and later test additions; reconcile suite pins from actual test counts, never to hide failures.
- Work only in this lane worktree/branch; leave the trail in commits; record verification against the exact committed head.

**Never:**
- No reset, rebase, history rewrite, force-push, wholesale checkout of old files, or broad rollback.
- No new compaction design, provider-specific workaround, timeout increase, model/provider switch, or native-stall-repair claim.
- Do not touch PR #145 / `b3681ce56f99183d0bab7e90a76d0b250680496c` or its lanes/files/holds; no cherry-pick, merge, promotion, deletion, or review arm.
- No chat reset, session erase, live-config edit, service restart/roll, install/deploy, PR merge, or other-lane change.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Installed config keeps the old key | `config.toml` contains `[supervision] proactive_compact_percent = 70` | Restored pre-#137 loader rejects it: `ConfigError: unknown key \`proactive_compact_percent\` in [supervision] (valid keys: …)` | Owner removes the key before service activation (prerequisite, reported — no compat semantics invented) |
| Native compaction crosses the former deadline | Native/pi-initiated or explicit compaction in progress beyond 300000 ms (fake time) | Wrapper never aborts the compaction or pending reply; when native completion arrives its events proceed promptly | No timer remains in the adapter |
| Idle session over the former threshold / provider error | Supervised idle session at ≥ old 70%, or a stream error | No proactive compaction and no deferral; hang/error/restart protections keep their pre-existing contract | Native pi behavior only |
| Suite pins after #137 test removal | Actual `it(` counts in changed suites | Pins equal actual counts (pi-adapter 61, supervisor 44); unrelated pins (perkins-whole-review 67) unchanged | Pin test fails loudly on drift |
| Later work in reverted files | Post-merge commits touching the same files | Later features/tests remain; reconciliation explained in commit/PR text | Escalate only if reconciliation would change approved scope |

</frozen-after-approval>

## Code Map

- `src/supervision/supervisor.ts` — delete the gate state (`CompactionGateState`, `ProviderCondition`), evaluators (`maybeProactiveCompact`, `deferCompaction`, `runProactiveCompaction`, `noteCompactionFailure`, `settleProviderCondition`), the `compaction_end` failure hook, and view fields; KEEP later `openControl` additions and all hang/restart/watchdog logic.
- `src/runtime/pi-adapter.ts` — delete `COMPACTION_DEADLINE_MS`, the `compactionDeadlineMs` option/field/constructor param, the `Promise.race` deadline in `compact()`, `clearCompactionDeadline`, `armNativeCompactionDeadline`, `onNativeCompactionDeadline`, `abortNativeCompaction`, and the `abort?` session member; KEEP later cessation-evidence / awaited-`dispose` code.
- `src/config.ts` — drop `proactiveCompactPercent` from `SupervisionConfig`, the default, the `requirePercent` validator, and the `[supervision]` VALID key list (restores unknown-key rejection).
- `src/config-reference.ts` — drop the knob from the generated reference (docs drift guard reads it).
- `docs/CONFIG.md`, `docs/example.config.toml`, `docs/SUPERVISION.md` — remove #137 knob/gate docs; keep later resident-budget/docs changes.
- `test/supervisor.test.ts`, `test/pi-adapter.test.ts`, `test/config.test.ts`, `test/health.test.ts`, `test/board-engine.test.ts` — remove #137 cases and fixture fields; keep later tests/fixtures.
- `test/suite-shape.test.ts` — reconcile pins from actual counts.
- `.gru-command/worktree.toml` — add focused verify scope `compaction-rollback` for scheduler evidence.
- `_bmad-output/implementation-artifacts/spec-revert-compaction-137.md` — this spec.

## Tasks & Acceptance

**Execution:**
- [ ] Revert `dd11a328` (-m 1) via a new commit; resolve `test/suite-shape.test.ts` by actual counts; verify every reverted file keeps post-#137 changes -- rollback provenance and no collateral loss.
- [ ] Confirm no shadow references remain (`proactive`, `compactionDeadline`, `COMPACTION_DEADLINE`, view fields) in `src/`, `test/`, `docs/` -- dangling references fail build/typecheck.
- [ ] Verify old-key behavior with an isolated temp-home fixture via `loadConfig` (no live config writes) -- records the deployment prerequisite.
- [ ] Add the `compaction-rollback` focused scope to `.gru-command/worktree.toml` -- scheduler-run focused regression evidence.
- [ ] Run focused regression, typecheck, and the full gate through `POST /api/verify` at the final head; exact-head GitHub CI; Perkins review handoff.

**Acceptance Criteria:**
- Given main at `c54bfbf` plus the new commit, when diffed against #137's parent and later main changes, then only #137 behavior is rolled back and unrelated post-merge work remains.
- Given a native or explicit compaction in progress beyond 300000 ms (fake time), when the former deadline passes, then the wrapper neither aborts compaction nor the pending reply, and native completion proceeds without waiting for a timer.
- Given an idle supervised session over the former threshold or a provider error, when supervision observes it, then no #137 proactive attempt/deferral occurs and hang/error/restart protections are unchanged.
- Given manual/native compaction, chat context controls, and persisted sessions exercised through focused tests, then pre-#137 behavior holds (no reset or data loss).
- Given the final clean committed head, then focused, typecheck, and full-gate outcomes are recorded against that exact head; failures remain failures.
- Given the delivered PR, then its description says rollback only, lists reconciliation and deployment prerequisites, and claims neither deployment nor root-cause proof.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `POST /api/verify {job_id:"revert-compaction-137", scope:"compaction-rollback"}` -- focused regression (`vitest run` on pi-adapter, supervisor, config, health, board-engine, suite-shape, config-generate)
- `POST /api/verify {job_id:"revert-compaction-137", scope:"typecheck"}` -- `npm run typecheck`
- `POST /api/verify {job_id:"revert-compaction-137", scope:"full"}` -- `npm test` (lint + typecheck + build + vitest + web)
- Exact-head GitHub CI on the pushed branch; native Perkins review READY required.

**Manual checks:**
- Isolated fixture: `loadConfig` against a temp `GRU_COMMAND_HOME` whose config carries the old key; expect the fail-loud unknown-key `ConfigError` and no live-config reads/writes.
