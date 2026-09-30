---
title: 'Provider pacing: fresh-main integration and r5 fixes'
type: 'feature'
created: '2026-09-30'
status: 'in-progress'
route: 'dispatch'
baseline_commit: '6c187acbef9474a6d69e7fee0f6fccfb685dc1fb'
context: []
---

<frozen-after-approval reason="existing owner briefing and re-brief govern this fix loop">

## Intent

Deliver provider-agnostic FIFO minion and combined Perkins turn admission, plus bounded automatic rate-limit retry for both worker and review turns. Consume the r5 findings and reconcile the settled branch with fresh main. The owner sets live config; merge, deployment and restart remain owner-held.

## Boundaries & Constraints

Always: `[pacing]` is independent of residency settings, ships enabled with unlimited admission caps, supports explicit disable, and records every automatic retry. Retry only the rate-limit class with bounded exponential backoff and jitter. Queue FIFO without preempting active turns. Preserve exact-head verification and review freshness.

Never: hardcode provider names, add dependencies, alter live config or credentials, weaken tests or timeouts, reset/stash/force-push, touch another lane, merge the PR or restart the service.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Queue | Worker or review cap occupied | FIFO wait; honest board reason; release admits next | Abort removes queued wait only |
| Callbacks | Queue/admission recorder throws | No ghost waiter or leaked slot | Fail loud and leave pool reusable |
| Lead wave | Leads occupy review cap | Waiting lead yields; lenses run within combined cap | Cleanup releases lease even if disposal fails |
| Rate limit | Failed model prompt, retry budget available | Recorded exponential delay, then retry | Bound delays and attempts; preserve review isolation |
| Other error | Non-rate-limit prompt failure | No automatic loop | Existing supervisor/review failure handling |
| Exhaustion | Every allowed retry fails | Recorded exhaustion | Existing failure handling takes over |
| Config | Residency and pacing sections coexist | Independently parsed and round-tripped | Unknown keys/types fail with actionable fields |

</frozen-after-approval>

## Code Map

- `src/config.ts`, `src/config-reference.ts`: config and generated docs; residency now owns `[concurrency]`.
- `src/runtime/pacing.ts`: reusable gate, classifier, delay helper; no adapter branding.
- `src/dispatch/service.ts`, `fix-directive.ts`, `rebrief-recovery.ts`, `server.ts`: worker lease lifetimes and queued delivery.
- `src/dispatch/perkins.ts`, `perkins-review/whole.ts`: native review admission and isolated lifecycle; preserve resident-wave reservation and output accounting.
- `src/main.ts`, `src/board/engine.ts`: wiring and snapshot data; preserve merged owner-action data.
- `src/supervision/supervisor.ts`: worker rate-limit lifecycle; review isolation must remain workflow-owned.
- `test/*.test.ts`: deterministic transports, clocks, regression pins; full scheduler gate uses `npm test`.

## Tasks & Acceptance

- [x] Replay on main and preserve published ancestry with ordinary merges.
- [ ] Separate config sections and correct enabled/unlimited default and templates.
- [ ] Make gate callback failure and worker/lead lease cleanup safe; cover regressions.
- [ ] Gate fallback minion review and directive paths.
- [ ] Implement workflow-owned bounded review backoff with durable retry events and deterministic tests.
- [ ] Cover plumbing and board view seams; reconcile suite-shape pins.
- [ ] Commit, capture scheduler full verification, push without rewriting remote history, and request fresh native review and exact-head CI.

Acceptance: given saturated gates, release admits FIFO without exceeding the cap; given rate-limit errors, retries obey configured delay/budget and are recorded; given other errors, no automatic retry occurs; given default config, admission remains unlimited; given merged residency and pacing config, generation boots and preserves both.

## Implementation Notes

Rebase conflicts combined eviction-safe directive resumption with pacing leases and resident-wave admission with lead-slot yields. Published history retained via a merge with the published r5 head, avoiding force-push. Main advanced again with the owner-action board merge; both snapshot fields were retained.

## Review Triage Log

r5: liveness blocker addressed by lead yields; remaining warnings (disabled fan-out, cleanup leaks, fallback bypass, throwing queue hooks, absent review backoff) accepted for repair. Notes (patch-tool missing directory, plumbing tests) accepted. Native Perkins review remains the independent review authority.

r6 (target b872c93): NEEDS CHANGES — all nine prior findings confirmed fixed; three blockers:
- B1 worker deliveries settled/disposed before automatic retries finish → fixed in c338a0e: supervisor incidents expose `awaitRetrySettlement`, and dispatch / fresh-directive / fallback review release their lease, await the bounded outcome, and record delivered only for none/recovered. New tests in `test/supervisor.test.ts`.
- B2 restart recovery bypassed `max_concurrent_minions` → fixed in c338a0e: `recoverInterruptedTurn` delivers through the worker gate with cancellation and unconditional release; cap-one regression test added.
- B3 pretest vitest worker-RPC harness patch (`timeout: -1`) ruled a weakened deadline; removed in c338a0e with the tool + test + pins. **Open owner decision**: removal makes the scheduled FULL exit 1 with zero test failures (4× upstream `onTaskUpdate` runner errors; runs d81a57e5 vs c803b394). Owner row 996126e2 + Silas notification 9b3b4511 request (a) authorization to restore the upstream-fix harness or (b) disposition of the runner class with exact-head CI as gate. See `provider-pacing/r7-decision-request.md`.

c338a0e: exact-head CI green (rerun after an unrelated claude-adapter file-read flake); scheduled FULL red on the B3 runner class only. Awaiting the owner decision before restoring the patch (a) or arming r7 on the removed-patch head (b).

## Owner decision — B3 harness authorization (2026-09-30, journal j-463)

Owner approval received: "#135 / #139: authorize the test-runner timeout patch. approved." — option (a). This is a test-infrastructure exception only: test/assertion timeouts, the verification scheduler's run bounds, worker budgets and failure propagation are unchanged, and no other dependency or product change is included.

Restored on this lane (r8):

- `tools/patch-vitest-rpc-timeout.mjs` — the same change PR #139 landed on main (`timeout: -1` on vitest 3.2.7's worker→host birpc channel; upstream vitest-dev/vitest#11082 / #8297) plus the two fail-loud layout guards that are its only delta.
- The `pretest` hook, the npm `files` entry, the `pacing-unit` focused-scope entry, and the suite-shape pin.
- Deterministic tests: apply / idempotence / narrowness (byte-exact single-line insertion), fail-loud for a relocated layout, a missing rpc chunk, a changed shape, and an ambiguous site — plus a nested real-run test proving a deliberate failing test still fails the run under the patched runner and a green run still exits 0.

B1/B2 fixes in c338a0e are untouched. Historical FAILED receipt `d81a57e5` at `c338a0e` (zero test failures; 4× upstream `onTaskUpdate` runner errors; `verify-full-r7.ndjson` / `.outcome.json`) and the prior green-with-patch `c803b394` capture stay preserved under `provider-pacing/`. The patch is **not** green evidence until scheduled verification on the new head completes; focused/typecheck/full/CI gates are handed to Silas.

## Fresh-main integration (r9 continuation, 2026-09-30)

Fresh continuation worker (prior writer settled `15:58:52Z`; its pushed head `804fa62` preserved).
Fresh `origin/main` `128cdb8babed472464b3de0d1078929cec5ac4e1` merged history-preservingly into
`gru/provider-pacing` for the existing PR #135:

- Merge commit `7032eb672b0bede7527c4edc00a94a58963cbe5a` (parents `804fa62` + `128cdb8`);
  `origin/main` is an ancestor; no rebase, force-push, reset or stash.
- Single textual conflict: `tools/patch-vitest-rpc-timeout.mjs` (add/add). Both sides carry the same
  PR #139 fix; the lane copy is the exact superset (main + the two j-463 fail-loud layout guards +
  provenance note), verified byte-for-byte against both parents. Resolution keeps the lane copy.
- Clean incoming from main: `eslint.config.js`, `test/uploads-dir.test.ts`, `web/e2e/smoke.spec.ts`,
  `web/mock/server.ts`, `web/src/styles/components.css`, `web/src/ui/chat-reflow.test.ts`;
  `package.json` pretest/files entries were identical on both sides; `vitest.config.ts` clamp was
  net-identical between merge-base and fresh main.
- B1/B2 (`c338a0e`) and the r8 harness restoration (`1326dfc`, `804fa62`) untouched.
- Sanity only — no direct tests started (the scheduler is owned by the rollback lane): `node --check`
  on the resolved tool; the tool itself ran green and applied the identical patch to this worktree's
  vitest dist.
- Remaining gates on the pushed head: scheduled focused (`pacing-unit`), scheduled typecheck/full via
  `POST /api/verify` with complete capture and nested `outcome.exitCode = 0`, exact-head CI, fresh
  native Perkins READY. Not end-to-end DONE until then; Silas owns routine verification admission.

## Verification

Focused deterministic tests first; scheduled `POST /api/verify` full scope with an opened output sink and complete NDJSON capture; require nested `outcome.exitCode = 0`, clean exact-head SHA, CI on the same head and native Perkins READY. Do not rerun to recover lost evidence.
