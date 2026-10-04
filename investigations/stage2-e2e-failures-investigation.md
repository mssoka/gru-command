# Investigation: Stage 2 e2e failures

## Hand-off Brief

1. **What happened.** Confirmed: the Stage 2 worktree's `npm run e2e` run exited 1 with five failures and 46 passes (`/tmp/gru-stage2-e2e-final.log`, 2026-10-04).
2. **Where the case stands.** Resolved locally on the separate `gru/e2e-gate-repair-20261004` branch: 51/51 e2e pass. The same five failures reproduced on `origin/main` plus only the independent verify-scope fix.
3. **What's needed next.** Integrate the independent gate branches, then obtain exact-head CI and native Perkins evidence before calling Stage 2 merge-ready.

## Case Info

| Field | Value |
| --- | --- |
| Ticket | N/A |
| Date opened | 2026-10-04 |
| Status | Resolved locally; integration gates pending |
| System | Darwin 25.6.0 arm64, Node/Playwright project in `~/.gru-command/worktrees/gru-command/job-perkins-reliability-stage2-20261003` |
| Evidence sources | `/tmp/gru-stage2-e2e-final.log` (run on Stage 2 worktree), `/tmp/gru-stage2-e2e.log` (earlier run), source/tests, Git history |

## Problem Statement

User request: “investigate the e2e”. The preceding delivery reported five UI screenshot/reflow failures from `npm run e2e`; whether they are unrelated to Stage 2, flaky, platform-specific, or regressions remains to be established.

## Evidence Inventory

| Source | Status | Notes |
| --- | --- | --- |
| `/tmp/gru-stage2-e2e-final.log` | Available | Two chat-reflow visibility failures, two light-theme screenshot mismatches, one busy-phrase assertion; 46 passed. |
| `/tmp/gru-stage2-e2e.log` | Available | Same five test names failed in preceding run; ratios differ by <0.01. |
| `web/test-results/` | Partial | Error contexts and four actual/expected/diff PNGs available; no trace ZIP seen in initial inventory. |
| Source, test code, Git history | Available | Compared unchanged `web/` sources against `origin/main`; independently reproduced all five failures on a base-derived branch. |
| Issue tracker / production telemetry | Missing | No ticket or production incident supplied; this is a local E2E run. |

## Investigation Backlog

| # | Path to Explore | Priority | Status | Notes |
| - | --- | --- | --- | --- |
| 1 | Identify all five failing tests and failure messages in both logs | High | Done | Same five names fail twice; reflow hidden tool line, two snapshots, empty busy phrase. |
| 2 | Inventory browser artifacts and compare to expected snapshots | High | Done | Expected/actual light screenshots show added FOR YOU band, speaker button and crew vocabulary. |
| 3 | Trace failing assertions to fixtures, rendering and recent Git changes | High | Done | Collapsed service band, hold fall-through, snapshot baseline predates merged UI. |
| 4 | Reproduce narrowly where evidence permits | Medium | Done | Focused flavor trace, 5/46 base comparison, three repeated flavor passes, two repeated theme passes, full 51/51 repaired e2e on each branch. |

## Timeline of Events

| Time | Event | Source | Confidence |
| --- | --- | --- | --- |
| 2026-10-04 | First Stage 2 e2e run failed with five cases | `/tmp/gru-stage2-e2e.log` | Confirmed |
| 2026-10-04 | Second Stage 2 e2e run failed with five cases and 46 passes | `/tmp/gru-stage2-e2e-final.log` | Confirmed |
| 2026-10-04 | Unchanged base web code reproduced the same five failures and 46 passes | `/tmp/gru-e2e-main-plus-gate-baseline.log`, branch derived from `origin/main` with verify-scope test-only repair | Confirmed |
| 2026-10-04 | Independent e2e repair branch passed all 51 cases after scoped fixes | `/tmp/gru-e2e-branch-full.log`; focused and theme repeat logs | Confirmed |

## Confirmed Findings

### Finding 1: Five e2e cases failed twice

**Evidence:** `/tmp/gru-stage2-e2e-final.log` and `/tmp/gru-stage2-e2e.log` terminal summaries (five failed, 46 passed each).

**Detail:** Two `smoke.spec.ts` reflow cases fail on a hidden `.tool-line`, two theme snapshots differ 0.07/0.03, and `working-flavor.spec.ts` reads an empty second phrase. Focused flavor repro fails again (`/tmp/gru-e2e-flavor-trace.log`).

### Finding 2: The reflow tests assert an intentionally collapsed service event is visible

**Evidence:** `web/e2e/smoke.spec.ts:903-915`, `web/src/ui/chat.ts:883-911`, `web/test-results/smoke-chat-pane-reflow-own-58f81--a-live-drag-light-and-dark-mock/error-context.md:100-118`, commit `4f4ebc8`.

**Detail:** The `mcp__` tool exists inside a collapsed service-event band; the error line remains visible. The test needs to expand the band before checking the rendered tool and its geometry.

### Finding 3: A mock held turn ends on the next stream tick without release

**Evidence:** `web/mock/server.ts:138-181`, `web/e2e/working-flavor.spec.ts:100-145`; focused trace `web/test-results/working-flavor-busy-phrase-4ecaa-l-geometry-on-every-surface-mock/trace.zip` shows busy first and a hidden empty flavor at the second read.

**Detail:** On token exhaustion the interval consumes `holdNextTurn` and saves `releaseHeldTurn=finish`, but fails to stop the timer. The next tick sees no token and calls `finish()`; the turn ends roughly one 45ms tick after the last delta. The test's `not.toHaveText(first)` passes on the empty cleared slot before a 4s rotation. No explicit release was sent yet in the trace.

### Finding 4: Both theme baselines predate intentional board/chrome changes

**Evidence:** Baseline PNGs last changed in merge `39f68e4`; later FOR YOU band commit `1d349af`; `web/src/ui/board.ts:203-242`; expected/actual PNGs in `web/test-results/{smoke-themes-*,real-server-themes-*}`.

**Detail:** Actual mock and real both show FOR YOU (pending and empty respectively); old baselines have no band. Actuals also show speaker control and CREW vocabulary absent from old PNGs. The real service's deploy chip changes from baseline `69 behind` to `unknown`/`current`, an environment-sensitive label. After refresh, two independent reruns passed both theme cases within the existing 2% screenshot tolerance; no mask or wider tolerance was needed.

## Deduced Conclusions

### Deduction 1: The five failures are not evidence of a Stage 2 UI regression

**Based on:** Findings 2–4 and the Stage 2 diff (no `web/` changes between `3c2db0ed0b4d7db1e69a42901e5ff21144c01d62` and current Stage 2 HEAD).

**Reasoning:** The mock failures are local to unchanged UI tests/mock server; merged UI changes postdate screenshots. The real snapshot also exercises the same unchanged board and a fresh-home server, not a Perkins review call.

**Conclusion:** Three mechanisms explain the observed failures: stale visibility assertions, a mock hold-timer defect, and stale/volatile screenshots. The same five failures reproduced on an independent base-derived worktree with no Stage 2 or UI fix changes, corroborating this attribution.

## Hypothesized Paths

### Hypothesis 1: Failures are unrelated to the Stage 2 backend-only changes

**Status:** Confirmed by independent base-derived e2e run.

**Theory:** UI/browser assertions fail from baseline drift or environment behavior rather than the Perkins review-engine changes.

**Supporting indicators:** The initial run reported screenshot/reflow and locator failures; the Stage 2 change surface is backend review logic.

**Would confirm:** A failing case reproduces on an unchanged base revision under the same browser/environment, or source traces prove no dependency on the changed backend behavior.

**Would refute:** A case passes on the base and fails only after a Stage 2 change, with a traced dependency.

**Resolution:** Stage 2 has no `web/` changes; service-band and FOR YOU commits predate this branch. `/tmp/gru-e2e-main-plus-gate-baseline.log` reproduces the identical five failures with 46 passes on a branch created from `origin/main` (its only differences repair verify-scope metadata/tests).

## Missing Evidence

| Gap | Impact | How to Obtain |
| --- | --- | --- |
| Exact-head CI and native Perkins READY on integrated changes | Prevents claiming merge readiness | Integrate the separate gate branches, then request authorized remote CI/review receipts. |

## Source Code Trace

| Element | Detail |
| --- | --- |
| Error origin | `web/e2e/smoke.spec.ts:914` hidden tool assertion; `web/e2e/working-flavor.spec.ts:145` empty second phrase; `web/e2e/{smoke,real-server}.spec.ts` screenshot comparisons. |
| Trigger | `npm run e2e` from the Stage 2 worktree. |
| Condition | Collapsed service-band, mock hold interval fall-through, stale snapshots with dynamic labels. |
| Related files | `web/src/ui/chat.ts`, `web/mock/server.ts`, `web/src/ui/board.ts`, `web/e2e/*-snapshots`. |

## Conclusion

**Confidence:** High

The mock hold timer was still live while the turn was held; clearing it prevents a premature `turn:end`. The strengthened test exposed two additional bugs: an intrinsic-width busy chip reflowed controls as phrases rotated (now uses a flexible zero basis), and an already-open sheet obscured a redundant FAB click on phone resize (test now asserts it stays open). The reflow tests expand the intentionally collapsed service band before checking tool text; four stale snapshot baselines were visually inspected and updated. Focused reflow/flavor passed 3/3, repeated flavor passed 3/3, themes passed twice, and full e2e passed 51/51 on the Stage 2 working tree and separately on the base-derived e2e repair branch. `npm test` passed with the repair applied on Stage 2; the standalone e2e branch requires the separately prepared verify-scope branch because `origin/main` has a pre-existing scope-routing test failure.

## Recommended Next Steps

### Fix direction

Keep the two gate fixes in separate branches: `gru/verify-scope-gate-repair-20261004` (workload-aware Stage 1 scopes) and `gru/e2e-gate-repair-20261004` (mock hold, layout, assertions and refreshed baselines). Integrate verify-scope first so the e2e branch's inherited `npm test` failure is removed; rerun full gates on the integrated exact head. Stage 2 remains clean on its own branch until these gates are integrated.

### Diagnostic

The base comparison is complete; watch screenshot volatility in exact-head CI. Do not claim native Perkins READY without a receipt.

## Reproduction Plan

Reproduced all five on the base-derived branch (46/51) and all 51 passed after the repair branch's UI/e2e delta under the same machine/browser setup. Logs: `/tmp/gru-e2e-main-plus-gate-baseline.log`, `/tmp/gru-e2e-branch-full.log`.

## Side Findings

`npm test` on the e2e-only branch fails on the pre-existing Stage 1 verify-scope routing assertion (1288 fast passed, one failed). The separate verify-scope branch passes `npm test` (1289 fast, 605 heavy, 408 web). The Stage 2 branch with its previously recorded scope fix passes `npm test` (1289 fast, 616 heavy, 408 web).
