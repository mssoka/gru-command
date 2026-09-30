---
title: 'Short heist names on minion cards'
type: 'feature'
created: '2026-09-24'
status: 'in-progress'
baseline_commit: 'c54bfbf89727bacfd27a27db65a9fab681c19c3e'
route: 'dispatch'
review_loop_iteration: 1
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
- [x] `src/ledger/db.ts`, `src/ledger/api.ts`: additive nullable job display-name field, validation, legacy reads; no updates to existing job titles.
- [x] `src/dispatch/server.ts`, `src/dispatch/service.ts`: accept/pass optional `display_name` at dispatch (reject blank authored value); never require it or change briefing.
- [x] `src/dispatch/fix-directive.ts`, `src/dispatch/perkins.ts`: register fresh spawned minions with known `jobId` before prompt/disposal; leave rebrief and lens labels intact.
- [x] `src/board/engine.ts`, `web/src/lib/board-protocol.ts`: expose/validate nullable short name alongside full job title, tolerate legacy absence.
- [x] `web/src/ui/board.ts`, `web/src/styles/components.css`: minion-only name/suffix, collision logic (all states including disposed), accessible full identity and overflow-safe text; preserve full-ID transcript target.
- [x] `test/ledger-db.test.ts`, `test/ledger-api.test.ts`, `test/dispatch-e2e.test.ts`, `test/dispatch-server.test.ts`, `test/fix-directive.test.ts`, `test/perkins-builtin-wave.test.ts`, `test/board-engine.test.ts`, `web/src/lib/board-protocol.test.ts`, `web/src/ui/board.test.ts`: deterministic red/green migration/restart, associations, lifecycle, collisions, escaping and transcript/non-minion regressions.

**Acceptance Criteria:**
- Given workers bound to one job, when state changes or service restarts, then the same heist name, unique suffixes, original title/IDs and existing role/state UI persist.
- Given a fallback-review, fix or rebrief worker spawned for a known job, when it settles/errors/disposes, then its durable job binding remains; an unlinked worker never acquires one by guesswork.
- Given a minion card is clicked, when opening a transcript, then the original full-ID session is selected; Perkins lens grouping and standing crew remain unchanged.
- Given long, Unicode or special names, when rendered at mobile/desktop in light/dark, then text is escaped, bounded and readable with full details available.

## Implementation Notes

Plan checkpoint approved by owner (journals j-24/j-25); continuation authorized after verified maintenance in re-brief. The checkpoint commit was not implementation. The 2026-09-30 fix loop rebased the existing PR #141 onto main `c54bfbf89727bacfd27a27db65a9fab681c19c3e`, including #140/#131/#133 and the earlier #68/#71 integration. No source checkout or sibling branch was modified. The pre-rebase head and ignored verification/WIP artifacts remain preserved locally. No review round was live at the rebase checkpoint; check again before publishing a head move.

## Spec Change Log

- 2026-09-30: apply the settled r3 restart/registration and padded-name findings without changing frozen intent. KEEP lowercase names, collision suffixes, raw identity and transcript selection, Perkins labels, v6.1 presentation and incoming residency eviction/resume behavior. Compose the newest-first implementer query with the incoming directive fallback; reconcile inherited test-count pins, not runtime/config policy.

## Review Triage Log

| r3 finding | Disposition / evidence |
| --- | --- |
| Required end-to-end verification absent | Still open until a clean scheduler full run and exact-head CI are recorded. Twelve older-head runs did not pass; none is approval. |
| Restarted implementer loses job binding | Fixed: snapshot the predecessor ledger association before spawn, then register the replacement before recovering its prompt. Real board-tap tests cover fresh/same IDs and neutral legacy rows. A failed binding write disposes the replacement before prompt recovery. |
| Review role overwritten by spawn re-registration | Fixed: preserve a durable Perkins role against generic minion spawn registration; test the fallback row's role, label, job binding and exclusion. Fresh fallback restarts inherit the explicit metadata, not guessed ownership. |
| Dispatch caps raw rather than trimmed name | Fixed: trim before HTTP length validation; padded/exact-cap accepted and padded-over-cap rejected by deterministic HTTP tests. |

## Design Notes

Optional metadata permits authored examples without hardcoded IDs; old jobs derive truthful title fallback. Normalize case/whitespace, truncate at a Unicode-safe word boundary and keep full title separately. Persistent nullable migration waits until approval. Resolve suffix collisions by job ID (unlinked separately), independent of row order. Fallback PASS is not an exact-head Perkins verdict.

## Hold Checkpoint — 2026-09-24

Owner priority hold: approved plan SHA-256 `0c47bbabe5887547784783b300f1bb746437a65f094bc39cfe4092d1e2fdaada` was implemented through commit `a8eced702b1b072eecc2a213bebdee319f7f578f` on `gru/crew-heist-labels`; that is not a delivered PR. Clean tree before this checkpoint. Changes: nullable job name migration/API, dispatch metadata, explicit fresh fix/fallback minion binding, board/protocol name + collision rendering, accessibility/CSS, documentation, backend/DOM/e2e tests. Review prompts were generated locally under ignored `_bmad-output/implementation-artifacts/review-crew-heist-labels-*-prompt.md`; no independent review was started. No PR exists.

Checks actually run: `npm run typecheck`, `npm run build`, `npm run build:web`, targeted eslint, focused backend tests (56 ledger/board/lessons, 3 dispatch-server, 1 fallback, 1 fix association, 1 dispatch-e2e), web board/protocol (38), focused Playwright mock (1; four desktop/mobile light/dark captures inspected), diff checks. Full lint failed on 40 pre-existing generated BMAD hook errors; #72 owns that fix and the missing declared scheduler `full` scope. A broad unscheduled development test attempt timed out amid co-tenant contention; later affected focused tests passed. No full scheduler run, exact-head Linux CI, independent review or PR. At hold, #68/#71/#72/#73 are unmerged; integrate their landed changes, then schedule full verification, obtain exact-head Linux CI and independent review, deliver PR, never merge/deploy. Resume only on explicit Gru continuation; do not reset the lane or treat the maintenance approval as final acceptance.

## Verification

### Historical evidence (not final-head verification)

The 2026-09-24 focused backend/web/build checks and four Playwright captures passed as recorded in the hold checkpoint above. At that time the shared lint/bootstrap fixes and incoming UI changes were not landed; that checkpoint was not delivery. PR #141 subsequently received NEEDS CHANGES reviews, most recently r3 at `01716c5b6998d28a6091731df22751c2413f5658`. CI was green on that old head, but local scheduler runs 1–12 failed. The last run (`9db75246-1fe6-4b57-a672-c47a3fd22910`) failed with 19 failed tests and seven Vitest RPC timeout errors; the worker's stream ended early but the host's completion record retains the result. No fallback PASS substitutes for Perkins.

### Rebased fix-loop checks — 2026-09-30

- Red/green: restart binding, fallback role downgrade, trimmed HTTP cap and newest-spawn directive selection failed before their corresponding fixes and passed afterwards. The neutral legacy case passed throughout.
- `npm run lint`, `npm run typecheck`, `npm run build`, `npm run build:web`: passed.
- Affected backend suites: ledger-api/db, supervisor, board-engine, fix-directive, rebrief-recovery, Silas driver, dispatch-server, lessons-injection and suite-shape: 204 passed; after adding the binding-write failure regression, supervisor + suite-shape: 56 passed (54 supervisor cases).
- `npm run test:web`: 39 files / 370 tests passed, including protocol and crew DOM identity/collision cases.
- Focused Playwright mock crew-rail test: passed. Inspected all four desktop/phone light/dark captures: lowercase heist names and one suffix remain visible, role/state/pills and crew/Perkins labels remain intact, no crew-card overflow. The incoming FOR YOU presentation is preserved. No unrelated design changes.
- Full scheduler verification, fresh exact-head Linux CI and independent Perkins re-review remain required for delivery. The declared `full` scope is now available; request it through `POST /api/verify` on a clean committed head. Do not repeat unchanged failed runs or inflate unrelated timeouts.
- No live configuration/database edits, maintenance restart, merge or deployment.
