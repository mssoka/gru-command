---
title: 'Native compaction: wait instead of silence-triggered restart'
type: 'bugfix'
created: '2026-10-01'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context:
  - 'docs/SUPERVISION.md'
---

<frozen-after-approval reason="human-owned intent — settled by the owner ('stalled provider is rare. also long as compaction is in progress, we wait for it. so yes.'); no further approval required">

## Intent

**Problem:** While a native provider compaction is open (`compaction_start` without `compaction_end`), the supervision watchdog treats silence past `turn_silence_ms` as a "compaction hang", disposes the live handle, restarts the session, and re-delivers the pending turn — destroying in-flight compaction work on the false theory that silence proves a stall.

**Approach:** While native compaction is open, silence is not hang evidence: the watchdog issues ONE factual FYI warning per open compaction episode (e.g. "compaction has not reported completion; continuing to wait") and keeps waiting indefinitely — no dispose/abort/restart, no pending-turn take/replay, no failure classification, no breaker consumption, no fake progress-clock update. Owner manual controls (stop, reset, New chat) remain the only ways to end a truly stalled episode. Native `compaction_end` (success OR failure) clears the open-control latch and the warning state through existing ownership; a later genuine episode may warn once again. Silence decisions already in flight when compaction starts are revalidated as stale so a destructive action can never land on a handle that entered compaction.

## Accepted behavior contract (owner-approved)

- Open native compaction (`openControl` latch) + silence past the existing threshold → at most one `fyi`/`info` notification per episode via the existing NotificationCenter; repeated ticks and duplicate `compaction_start` signals never warn twice within one episode; the handle stays owned and watching; pending work is retained.
- No second automatic deadline or escalation exists on top of the warning; indefinite waiting for a genuinely stalled provider is accepted; no owner bell, no needs-owner stop, no machine wake from the warning.
- The same handle's non-compaction policies are untouched: normal non-compacting hung turns still climb the ladder, genuine fatal errors still climb, provider-wall stops still stop, sleep/wake grace, live-tool liveness, review-isolation aborts, and decision-token staleness all keep their current semantics. Review attempts never enter generic resume.
- An idle-labeled handle or open pending turn inside an open compaction is still compaction: only a native `compaction_end` completes an episode.

</frozen-after-approval>

## Implementation Notes

- 2026-10-01 — Planned via bmad-build oneshot route. Investigated seams: `tick()` silence branch (src/supervision/supervisor.ts ~650–699), `onEnvelope` compaction latch (~538–543), `evaluateRecovery` staleness snapshot/replay (~905–1050), notification surface (NotificationCenter.post, routing `fyi` + severity `info`; owner-held kinds do not include the new kind), test harness (FakeHandle/FakeRegistry/boot, deferred-decision fake pattern at test/supervisor.test.ts:481).
- 2026-10-01 — Implementation decisions: (1) the compaction wait branch sits in `tick()` before the live-process probe and never touches `lastEventAt`; (2) warning state is one boolean per supervision record (`compactionWarned`), set when the warning posts, cleared wherever the latch clears through existing ownership (`compaction_end`, disposed envelope, `state: disposed`); (3) warning kind `supervision.native-compaction-wait` — deliberately NOT prefixed `supervision.compaction` so the #137 rollback oracle (`kind.startsWith('supervision.compaction')` must stay empty) is not weakened; (4) stale-silence revalidation: non-runtime-error decisions additionally require `openControl` to be unchanged since the snapshot, in the grant leg, the catch leg, and the queued-recovery replay; (5) `compaction hang` remains recognized in the FYI-kind mapping at restartRungInner (no path mints it now, but removing it is out-of-scope cleanup).
- 2026-10-01 — Declared (not executed) verification per briefing: focused scope `node tools/patch-vitest-rpc-timeout.mjs && npx vitest run test/supervisor.test.ts` added to `.gru-command/worktree.toml`; fail-before/pass-after same-test comparison left to the scheduled verifier (Silas). Review children cannot be launched from this lane's permitted operations: filled review prompts saved under `_bmad-output/implementation-artifacts/native-compaction-wait/` and review marked pending — independent review remains a gate.
- 2026-10-01 — The tick branch's `reason` ternary (`openControl ? 'compaction hang' : 'turn hang'`) became dead for the openControl case once the wait branch short-circuits it; simplified to a constant `'turn hang'` with a comment (directly-touched seam, not broad cleanup). The `compaction hang` string remains recognized in the deterministic failure classifier (`src/decisions/questions.ts`) and the FYI-kind mapping — both generic, both untouched, and the classifier keeps its own test.
- 2026-10-01 — Fail-before evidence derivation: on base `2aa836abe262759c651683deb40d05f02c9ede86`, all four new/rewritten compaction tests fail (dispose/restart/hang-FYI happen instead of the one wait-FYI; the race test ends in a restart of the compacting handle). The two strengthened disarm tests pass on both base and patch (regression oracles). Same tests, same scope, baseline-vs-patch under scheduled isolation is the verifier's comparison.
- 2026-10-01 — CORRECTION (ci-pin-repair, supersedes the prediction above as evidence status; the original entry is preserved for intent): the fail-before derivation above was a STATIC EXPECTATION from code reading — it is NOT measured red evidence, and no baseline comparison has run. Baseline-vs-patch comparison remains pending with the scheduled verifier. Separately recorded, measured facts from CI run 36864470157 (merge result 55d85a51eeffe0819804e94ba9f83665f5ea3d44 = e5f7d94 into 2aa836): the run FAILED overall — lint/typecheck/build passed; backend 1 failed / 1455 passed / 9 skipped; web suite not reached; all 48 supervisor tests PASSED; the sole observed failure is test/suite-shape.test.ts:136 (`supervisor.test.ts: registered 48 tests, pin says 45`). This run remains recorded as FAILED — it is not a pass and does not clear any gate. The subset failure also does not by itself prove anything about the distinct race oracles of the individual new tests; only the pending baseline comparison and focused/full runs can do that. Mechanical correction applied: suite-shape pin for supervisor.test.ts recomputed from the actual declarations (48 `it(`, 0 `it.skipIf(`) 45→48, and `test/suite-shape.test.ts` added to the declared `native-compaction-wait` focused scope (prefix `node tools/patch-vitest-rpc-timeout.mjs && ` and supervisor coverage unchanged).
