---
title: 'Repair Stage 1 verify-scope routing under workload-aware Vitest budgets'
type: 'bugfix'
created: '2026-10-04'
status: 'done'
route: 'oneshot'
review_loop_iteration: 1
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `npm test` fails because Stage 1's declared verify scopes run heavy integration files with the fast/default Vitest configuration; the scope-routing test detects `perkins-stage1-focused` first. The archived fails-before baseline intentionally runs its pinned old revision, where the later heavy config does not exist.

**Approach:** Make current-tree Stage 1 focused and adapter verification route classified heavy files through the heavy config and fast files through the fast config, preserving the RPC patch and existing file selection. Keep the archived pre-change baseline's genuine historical behavior rather than imposing a config absent from its tree; ensure the routing guard explicitly distinguishes that isolated historical baseline without exempting current-tree scopes. The UI e2e failures and authenticated delivery gates are separate deferred work.

</frozen-after-approval>

## Implementation Notes

- `.gru-command/worktree.toml`: focused scope mixes `perkins-whole-review`/`perkins-builtin-wave` (heavy) with five fast suites; adapters scope mixes heavy `claude-adapter` with three fast suites. Baseline archives `9bb51b05af5d8f0a0cd389788d1d3f19607d5361`, which contains neither `vitest.heavy.config.ts` nor `test/helpers/test-budgets.ts`.
- `test/test-budgets.test.ts:160-182`: scope-routing assertion previously scanned all `&&` segments equally, including the archived baseline. It excludes only the explicitly pinned pre-budget archived baseline after checking its base SHA, archive command, isolated directory (`cd "$d"`), and unconditional `exit 1`; current-tree scopes remain fully checked. No workload budgets, baseline scripts, or test assertions were relaxed.
- `.gru-command/worktree.toml`: the focused scope runs one fast segment (the transport suite plus the four engine suites), then its heavy segment; adapters run the classified Claude adapter with the heavy config and the other suites in a fast segment. Both declared scopes pass locally without changing selected files. The original 2026-10-04 run on the pre-rebase tree passed `npm test` with fast 1289/6 skipped, heavy 616/6 skipped, web 408; the rebased branch re-verified with lint, typecheck, build (incl. the pinned Perkins resource verifier), and the routing-guard suite 9/9.
- Blind Hunter review: no actionable findings. The UI e2e failures and authenticated delivery gates are owned by the separate e2e-gate lane (PR #180, `gru/e2e-gate-repair-20261004`), which carries the evolved sibling of this repair plus the Stage 2 review-behavior fixes; they were never entries in `deferred-work.md`.
- 2026-10-05 rebase review (gpt-6-sol, bmad-code-review): rebased onto current main (was 305 commits behind, conflicting); the original code changes had already landed on main in equivalent form, so the conflicts resolved in main's favor and this branch restored the dropped `cd "$d"` isolation assertion while correcting these notes to describe the landed tree.
