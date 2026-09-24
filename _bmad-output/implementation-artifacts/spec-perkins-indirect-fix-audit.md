---
title: 'Perkins indirect-fix audit evidence'
type: 'bugfix'
created: '2026-09-24'
status: 'draft'
route: 'dispatch'
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
- [ ] `types.ts`, `hybrid.ts` — accept optional `fix_location: {path: string, change: 'added' | 'removed'}` only with `fixed`, distinct from original cited path. Keep four-key legacy entries valid. Validate strict nested keys, bounded safe relative path, one nonempty single-line evidence payload (not N/A or PATH ABSENT), and nonempty bounded reviewer reason, for both text/full/delta submissions.
- [ ] `hybrid.ts` — for explicit proof require valid prior target SHA; use bounded, timed Git lookups for *prior target → frozen current target*, no ext diff/textconv or worktree reads. Check path status and textual hunk +/- line, never header/context/binary; on rename pair old/new paths before inspecting hunk, allow true deleted-file removed lines and new-file added lines, reject rename-only. Fail closed on Git errors, malformed/escaping path or absent required blob. Retain old proof route unchanged; require report to identify original citation and fix path alongside evidence, with reviewer causal reasoning in `reason`.
- [ ] `hybrid.ts`, `policy.json` — declare optional nested location identically on full/delta prior-audit items (root remains typed object), document strict alternate proof in lead prompt/shipped instructions; code remains validation authority. Refresh only affected policy hash pins using real bytes.
- [ ] Tests above — red/green small Git prior/current fixture modeling r3, plus wrong revision, invented/context-only line, safe-path/shape/status, binary/unavailable, rename-only, changed rename/deletion and added caller lines. Cover legacy deletion/absence/speculative, missing/duplicate prior entries, candidate/head/terminal gates, report proof and Pi/MCP schema serialization.

**Acceptance Criteria:**
- Given an unchanged cited helper and a genuine caller edit between frozen targets, when a complete explicit location, changed-line evidence and causal reason are submitted, then preflight and terminal accept without changing the historical citation.
- Given a fabricated, stale, malformed or unlocatable explicit proof, when either tool validates it, then it rejects with an actionable reason; path alone never passes.
- Given valid legacy audits and an exact-head complete terminal submission, when validated, then they retain behavior; absent/duplicate audits and unsupported claims still fail.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

Explicit proof is an alternate route only for `fixed` at a distinct path. A changed line in an unrelated *changed* file is provenance-valid but causal relevance remains the reviewer's judgment, not a call-graph check. Git rename metadata must prevent unchanged rename content masquerading as new additions. Deleting a caller can prove a removed line; a path absence marker remains reserved for the original citation.

## Verification

- `npx vitest run test/perkins-builtin-review.test.ts test/perkins-lead-schema-compat.test.ts test/verify-perkins-resource.test.ts` — focused proof/schema/resource checks after approval.
- `node -e "const{createHash}=require('node:crypto');const{readFileSync}=require('node:fs');for(const p of ['resources/perkins-code-review/policy.json','src/runtime/review-mcp-server.mjs'])console.log(p,createHash('sha256').update(readFileSync(p)).digest('hex'))"` — capture real hashes; copy changed policy SHA into `src/dispatch/perkins-review/policy.ts` and `tools/verify-perkins-resource.mjs`; update `src/runtime/review-mcp-bridge.ts` and verifier MCP pin only if server bytes changed. Never alter canonical-source pin for this change.
- `npm run typecheck && npm run lint && npm run build && node tools/verify-perkins-resource.mjs . && npm pack --dry-run` — type/lint/build/pack/prepack. Required final gate is existing Linux synthetic MERGE-result CI, not overloaded local 14-worker suite, static-count replacement or head-only override. Record head/base/tested merge; one PR, complete primary clearance and green CI before Gru merges; merge is not deployment.
