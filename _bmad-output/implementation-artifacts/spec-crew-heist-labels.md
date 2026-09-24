---
title: 'Short heist names on minion cards'
type: 'feature'
created: '2026-09-24'
status: 'draft'
route: 'dispatch'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Minion cards show role plus long ID and repeat the ID prefix, hiding the assigned heist. Fresh fix-directive and fallback-review minions can lack the job binding required for a truthful display.

**Approach:** Persist an optional owner-authored short name on the job during existing dispatch; derive a deterministic short lowercase title fallback for older jobs. Resolve minions through `jobId` and the job snapshot, show a neutral label when unlinked, and render one normally four-character ID suffix, extended only for collisions.

## Boundaries & Constraints

**Always:** Full UUID/title accessible via tooltip and keyboard; real transcript selection, role/state subline, pill, crew names and Perkins lens labels unchanged. Names belong to jobs.

**Never:** Mutate identities, review contracts, routing, live config/DB or residency-budget lane; no alias map, naming call, dependency, setting or redesign.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected behavior |
|----------|---------------|-------------------|
| Known job | Authored name, multiple minions/states | Shared lowercase name, unique suffixes, full identity accessible |
| Legacy job | No authored name | Stable short lowercase title fallback; full title accessible |
| Unlinked | No resolvable `jobId` | `unassigned` plus suffix, no invented heist |
| Collision | Same-job IDs share four trailing chars | Extend only colliding suffixes to distinct lengths deterministically |
| Other roles | Crew/Perkins label | Existing name/hash and lens label unchanged |

</frozen-after-approval>

## Code Map

- `src/ledger/db.ts`, `src/ledger/api.ts`: nullable job field after v8; `registerAgent` preserves existing binding across observer events.
- `src/dispatch/service.ts`, `src/dispatch/server.ts`: optional `display_name` from dispatch API to `addJob`; initial binding exists.
- `src/dispatch/fix-directive.ts`, `src/dispatch/perkins.ts`: fresh fix and default fallback minions lack registration; rebrief and Perkins lens/lead already bind correctly.
- `src/board/engine.ts`, `web/src/lib/board-protocol.ts`: optional `JobView` short name alongside full title; #71 changes snapshot/protocol too.
- `web/src/ui/board.ts`, `web/src/styles/components.css`: `renderAgents`/`agentRow` show `agentLabel` and first-eight hash. Join jobs by ID only for minions, use safe `el()` text. #68 changes adjacent rail UI; #71 changes other board UI. Integrate both after merge.

## Tasks & Acceptance

**Execution:**
- [ ] `src/ledger/db.ts`, `src/ledger/api.ts`: additive nullable job display-name field, validation, legacy reads; no updates to existing job titles.
- [ ] `src/dispatch/server.ts`, `src/dispatch/service.ts`: accept/pass optional `display_name` at dispatch (reject blank authored value); never require it or change briefing.
- [ ] `src/dispatch/fix-directive.ts`, `src/dispatch/perkins.ts`: register fresh spawned minions with known `jobId` before prompt/disposal; leave rebrief and lens labels intact.
- [ ] `src/board/engine.ts`, `web/src/lib/board-protocol.ts`: expose/validate nullable short name alongside full job title, tolerate legacy absence.
- [ ] `web/src/ui/board.ts`, `web/src/styles/components.css`: minion-only name/suffix, collision logic (all states including disposed), accessible full identity and overflow-safe text; preserve full-ID transcript target.
- [ ] `test/ledger-db.test.ts`, `test/ledger-api.test.ts`, `test/dispatch-e2e.test.ts`, `test/dispatch-server.test.ts`, `test/fix-directive.test.ts`, `test/perkins-builtin-wave.test.ts`, `test/board-engine.test.ts`, `web/src/lib/board-protocol.test.ts`, `web/src/ui/board.test.ts`: deterministic red/green migration/restart, associations, lifecycle, collisions, escaping and transcript/non-minion regressions.

**Acceptance Criteria:**
- Given workers bound to one job, when state changes or service restarts, then the same heist name, unique suffixes, original title/IDs and existing role/state UI persist.
- Given a fallback-review, fix or rebrief worker spawned for a known job, when it settles/errors/disposes, then its durable job binding remains; an unlinked worker never acquires one by guesswork.
- Given a minion card is clicked, when opening a transcript, then the original full-ID session is selected; Perkins lens grouping and standing crew remain unchanged.
- Given long, Unicode or special names, when rendered at mobile/desktop in light/dark, then text is escaped, bounded and readable with full details available.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

Optional metadata permits authored examples without hardcoded IDs; old jobs derive truthful title fallback. Normalize case/whitespace, truncate at a Unicode-safe word boundary and keep full title separately. Persistent nullable migration waits until approval. Resolve suffix collisions by job ID (unlinked separately), independent of row order. Fallback PASS is not an exact-head Perkins verdict.

## Verification

- Run affected Vitest suites above, `npm run test:web`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run build:web`; obtain scheduler-backed full run via `POST /api/verify {job_id,scope:"full"}` after implementation, then exact-head Linux PR CI and independent review. Inspect desktop/mobile light/dark captures, including focus/tooltip and clipping. Deliver PR; never merge/deploy or reopen ended design sessions.
