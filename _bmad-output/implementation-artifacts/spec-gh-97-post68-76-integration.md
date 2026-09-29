---
title: 'gh-97: integrate PR129 with post-68/76 main (bounded, behavior-preserving)'
type: 'chore'
created: '2026-09-27'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** PR #129 (issue #97 owner-stop routing, incl. Perkins R1/R2 tie-mode fixes) is OPEN/CONFLICTING at `8e98fd0` after the owner merged #68 (`0930488`) and #76 (`df9fe01`) to main; native r3 READY covers only the old head, not an integrated one.

**Approach:** Normal merge of freshly fetched origin/main into `gru/gh-97-owner-stop-routing` (never reset/stash/rebase/force or blanket ours/theirs): resolve actual conflicts only (expected: both-added `deferred-work.md` union; take-theirs for untouched-by-lane files; derive `suite-shape` counts from the actual combined tree), preserving #68/#76, #71/#77, every unrelated job, and ALL issue97 tie-mode behavior (fresh owner stop Ack-able; historical machine row untouched; same-ms legacy-first ties reuse the eligible owner row; unacked vs active/ACKed-unresolved semantics distinct). Verification via the shared `/api/verify` scheduler (token used privately, programmatically only), focused notification/supervisor/decisions/suite-shape coverage plus lint/typecheck/build, and a GENUINELY independent BMAD review of the final integration/source-test diff (isolated session/helper — the r3 author-inline caveat must not repeat). Then normal non-force push and exact-final-head CI; Silas owns the fresh native whole-PR Perkins round after branch idle.

**Boundaries:** no new implementation writer; no reviewer-identity changes; no live config edits/restart/deploy/merge-to-main; no new models/dependencies/framework; failed exits stay failed; no repeated broad runs merely to capture logs.

</frozen-after-approval>

## Implementation Notes

<!-- Agent-owned. Append-only during implementation. -->

- 2026-09-29 (completion-grant resume of PR #129 from integration head 9279f544):
  - Lane reconciliation: preserved in full (no reset/stash/force). Re-fetched origin/main and merged `ded4416` (roles/silas.md + ops-dispatch skill only; no test-visible surface) — head `f7c6031` before repairs.
  - Diagnosis of the failed scheduled full run at 9279f544: the failure multiset is starvation-shaped — 26 per-test timeouts, 10 service-startup deadline lapses with zero bytes on both streams, 10 vitest RPC timeouts — and no failing test file differs from either merge parent; a second independent serial retry reproduced the same shape. Direct probes at the same head: the hygiene gate exits 0 ("clean") but takes 51.7s wall vs its 30s test ceiling (one grep spawn per tracked file); the pty BMAD test's Enter at the runtime prompt depends on pi's `--version` finishing inside the 5s probe cap, which it does not on this host (measured ~5.4-6.6s), so the probe default flips to claude-code against that test's Pi-only fixture.
  - Repairs (harness/test-fixture only — no timeout, assertion, test-intent, or product-surface change):
    1. Effective vitest pool clamped to min(scheduler pin, 4) in the root and web configs.
    2. Hygiene gate scans in batches of 200 files per grep (same patterns, same -I skip, same per-match allowlist residual re-check, same file:line:text output, exit-2 per-file fallback).
    3. Pty BMAD test pins its runtime answer to its own Pi-only fixture; the all-defaults test still exercises the probe default.
    Items 1-2 use the sibling lane's settled starvation shape (gru/owner-chime f5497b8/cfdc616) and item 3 matches f020dc6, so the two PRs reconcile in either merge order.
  - Pre-checks after repair: lint OK; typecheck OK; hygiene teeth tests pass (20.3s / 24.6s under co-tenant storm load). Scheduled full verification follows in a co-tenant-quiet window; all earlier failed outputs stay preserved.
