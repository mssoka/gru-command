---
title: 'Perkins indirect-fix audit evidence'
type: 'bugfix'
created: '2026-09-24'
status: 'in-review'
route: 'dispatch'
baseline_commit: 'cedbf625b4d4c58f1a60da4a1b1e8678f0e459dd'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** R3 lead preflight rejected only prior #7: its cited helper `src/runtime/claude-model.ts` stayed unchanged, but the fix is in caller `src/runtime/claude-review-settings.ts`. INCOMPLETE is not approval.

**Approach:** Add a typed, optional changed-caller proof bound to the prior frozen target and current frozen target. Preserve the original citation; code proves provenance and an exact changed line, while the reviewer explains causality.

## Boundaries & Constraints

**Always:** Base: clean fast-forwarded main `1cbb1c446d810ec572631042b65316750c686737`. Retain cited-path deletion, original-path `PATH ABSENT`, speculative N/A, exact-once audits, candidate verification, actor/round/head identity, frozen-source confinement and mandatory terminal submission. Pi and Claude MCP share host validator/schema.

**Never:** No #73 feature repair, auth/publication, installer, budgets, labels, wake, dependencies, model judgment pass, changed legacy BMAD fingerprint, weaker pins, archive mutation, review retry, merge or deployment.

## I/O & Edge-Case Matrix

| Input | Expected result |
|---|---|
| Confirmed prior at unchanged helper; `fixed` audit with changed caller location, one actual changed-line `evidence`, causal `reason` | Preflight and terminal may pass; finding's original citation retained |
| Four-key legacy audit with cited deletion, cited absence, or speculative N/A | Same rules and result as before |
| Path only; wrong SHA, fabricated/context-only line, binary/unavailable file, invalid path or status | Actionable rejection; no arbitrary current-tree/whole-PR fallback |
| Renamed/deleted caller | Accept only a real changed +/- hunk line; rename-only rejected |

</frozen-after-approval>

## Code Map

- `src/dispatch/perkins-review/types.ts` — `FixAuditResult`, strict text parser `parseFixAuditResults`.
- `src/dispatch/perkins-review/hybrid.ts` — audit parser/full-delta merge, tool schema, `fixedAuditEvidence`, prior coverage, report and prompt; `loadPriorReview` supplies prior target SHA, `freezeReviewInputs` in `artifacts.ts` supplies current target.
- `resources/perkins-code-review/policy.json` — pinned shipped lead/re-review instructions; keep provenance source fingerprint.
- `src/runtime/review-mcp-bridge.ts`, `src/runtime/review-mcp-server.mjs` — transport native tool schema/calls; no separate validator. Touch only if needed.
- `test/perkins-builtin-review.test.ts`, `test/helpers/perkins-hybrid-double.ts`, `test/perkins-lead-schema-compat.test.ts`, `test/verify-perkins-resource.test.ts` — frozen Git fixture, tool paths, schema and integrity coverage.

## Tasks & Acceptance

**Execution:**
- [x] `types.ts`, `hybrid.ts` — accept optional `fix_location: {path: string, change: 'added' | 'removed'}` only with `fixed`, distinct from original cited path. Keep four-key legacy entries valid. Validate strict nested keys, bounded safe relative path, one nonempty single-line evidence payload (not N/A or PATH ABSENT), and nonempty bounded reviewer reason, for both text/full/delta submissions.
- [x] `hybrid.ts` — for explicit proof require valid prior target SHA; use bounded, timed Git lookups for *prior target → frozen current target*, no ext diff/textconv or worktree reads. Check path status and textual hunk +/- line, never header/context/binary; on rename pair old/new paths before inspecting hunk, allow true deleted-file removed lines and new-file added lines, reject rename-only. Fail closed on Git errors, malformed/escaping path or absent required blob. Retain old proof route unchanged; require report to identify original citation and fix path alongside evidence, with reviewer causal reasoning in `reason`.
- [x] `hybrid.ts`, `policy.json` — declare optional nested location identically on full/delta prior-audit items (root remains typed object), document strict alternate proof in lead prompt/shipped instructions; code remains validation authority. Refresh only affected policy hash pins using real bytes.
- [x] Tests above — red/green small Git prior/current fixture modeling r3, plus wrong revision, invented/context-only line, safe-path/shape/status, binary/unavailable, rename-only, changed rename/deletion and added caller lines. Cover legacy deletion/absence/speculative, missing/duplicate prior entries, candidate/head/terminal gates, report proof and Pi/MCP schema serialization.

**Acceptance Criteria:**
- Given an unchanged cited helper and a genuine caller edit between frozen targets, when a complete explicit location, changed-line evidence and causal reason are submitted, then preflight and terminal accept without changing the historical citation.
- Given a fabricated, stale, malformed or unlocatable explicit proof, when either tool validates it, then it rejects with an actionable reason; path alone never passes.
- Given valid legacy audits and an exact-head complete terminal submission, when validated, then they retain behavior; absent/duplicate audits and unsupported claims still fail.

## Implementation Notes

- Added optional `fix_location` to the shared audit result and full/delta tool declarations; old four-field submissions remain accepted. An explicit proof checks the original cited blob at the prior target, rename-aware unfiltered status once per validation, regular text blobs and a bounded zero-context patch for the selected path pair. Git failures reject, never trigger fallback. Semantic relevance stays with the reviewer's `reason`.
- Updated policy resource digest from actual bytes to `325f751720cc46c21093b108ca77fb5627198d2a9cdd145a8a94db24d6c239a9`; MCP server and canonical-source bytes/pins unchanged. Tested small synthetic frozen repositories, including negative and rename/deletion cases.
- Local focused Vitest multi-test run exercised 100 passing assertions but failed on one outdated test expectation (corrected and re-run green individually) and a host-load worker RPC timeout. A subsequent 14-case run passed every assertion but still reported one RPC timeout. Do not claim either run green. Individual matrix cases (happy, context rejection, wrong revision, rename-only/edit, removed/binary, delta, report) passed without timeout; `npx vitest run test/suite-shape.test.ts test/perkins-lead-schema-compat.test.ts test/verify-perkins-resource.test.ts --maxWorkers=1` passed (10 passed, 1 skipped). `npm run typecheck`, `npm run lint`, `npm run build`, `node tools/verify-perkins-resource.mjs .` and `npm pack --dry-run` passed after the final patch. The Linux merge-result CI remains the required full gate.

## Spec Change Log

## Review Triage Log

## Design Notes

Explicit proof is an alternate route only for `fixed` at a distinct path. A changed line in an unrelated *changed* file is provenance-valid but causal relevance remains the reviewer's judgment, not a call-graph check. Git rename metadata must prevent unchanged rename content masquerading as new additions. Deleting a caller can prove a removed line; a path absence marker remains reserved for the original citation.

## Verification

- `npx vitest run test/perkins-builtin-review.test.ts test/perkins-lead-schema-compat.test.ts test/verify-perkins-resource.test.ts` — focused proof/schema/resource checks after approval.
- `node -e "const{createHash}=require('node:crypto');const{readFileSync}=require('node:fs');for(const p of ['resources/perkins-code-review/policy.json','src/runtime/review-mcp-server.mjs'])console.log(p,createHash('sha256').update(readFileSync(p)).digest('hex'))"` — capture real hashes; copy changed policy SHA into `src/dispatch/perkins-review/policy.ts` and `tools/verify-perkins-resource.mjs`; update `src/runtime/review-mcp-bridge.ts` and verifier MCP pin only if server bytes changed. Never alter canonical-source pin for this change.
- `npm run typecheck && npm run lint && npm run build && node tools/verify-perkins-resource.mjs . && npm pack --dry-run` — type/lint/build/pack/prepack. Required final gate is existing Linux synthetic MERGE-result CI, not overloaded local 14-worker suite, static-count replacement or head-only override. Record head/base/tested merge; one PR, complete primary clearance and green CI before Gru merges; merge is not deployment.
