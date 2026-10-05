---
title: 'Short heist names on minion cards'
type: 'feature'
created: '2026-09-24'
status: 'in-review'
baseline_commit: '059c076290145d4aae6e0b47c7b3f87156862c43'
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

R5 follow-through (2026-09-30, after r5 settled NEEDS CHANGES at `71935f8` under the chief adjudication): repaired the confirmed invisible-prefix shortening warning and the three failed-suite causes without touching timeouts, pools or assertions; diagnosis and evidence live in Verification below. The vitest worker-RPC timeout patch (upstream `timeout: -1`) belongs to PR #135 and was not duplicated here — it is declared as a cross-lane gate dependency in the handoff matrix.

## Spec Change Log

- 2026-09-30: apply the settled r3 restart/registration and padded-name findings without changing frozen intent. KEEP lowercase names, collision suffixes, raw identity and transcript selection, Perkins labels, v6.1 presentation and incoming residency eviction/resume behavior. Compose the newest-first implementer query with the incoming directive fallback; reconcile inherited test-count pins, not runtime/config policy.

## Review Triage Log

| r3 finding | Disposition / evidence |
| --- | --- |
| Required end-to-end verification absent | Execution/evidence gap addressed, but full local gate remains blocked: run `64dc5548-ae80-4b0c-a088-66643c363f67` failed at the clean rebased implementation head. Exact-head Linux CI passed. Await independent disposition; neither isolated passes nor CI erase the failed scheduler result. |
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
- Scheduler `POST /api/verify {job_id:"crew-heist-labels",scope:"full"}` ran at clean implementation head `7590131b3481798715f384283e0a97ea8122d2c4`: run `64dc5548-ae80-4b0c-a088-66643c363f67`, exit 1, not timed out, duration 774779 ms, 90 files / 1463 tests passed, three tests failed, four files skipped and five Vitest RPC timeout errors. Output SHA-256 `87f92e6f520b15cc829521cef088157586e07dfec24d130a1b508816b542a114`; local complete capture: `_bmad-output/implementation-artifacts/verify-crew-heist-labels-rebrief-full.ndjson`. Failed cases: install-one-line owned-service restart (30 s timeout), LAN-phone replay (empty delta text), Perkins unknown/foreign receipt (30 s timeout). This is NOT a full PASS.
- Diagnostic reruns: all six LAN-phone cases passed when the entire stateful file ran with a one-worker pool (filtering the phone case alone omits required desktop history and is invalid evidence); the install case passed with the same one-worker pool; the Perkins receipt case passed in the focused diagnostic run. No failing assertions were weakened and no unrelated test/config/runtime edits were made. These passes narrow the local failure but do not prove a root cause or replace the scheduler full gate.
- Linux CI run [36684697753](https://github.com/mssoka/gru-command/actions/runs/36684697753) explicitly reports `head_sha=7590131b3481798715f384283e0a97ea8122d2c4`, SUCCESS on Ubuntu / Node 22: 93 backend files, 1469 tests passed (Linux-only cases included); 39 web files, 370 tests passed. CI tests the normal PR merge-result checkout. PR #141 is mergeable after the rebase. This evidence-only checkpoint changes no product/test code; its pushed head still requires fresh CI.
- **Blocked checkpoint:** shared-host scheduler full is not green; independent Perkins re-review/acceptance is still owed. Stop unchanged full retries and report the concrete failures instead of treating fallback PASS, focused tests or Linux CI as a local scheduler PASS. PR fixes are published, not merged or deployed.
- No live configuration/database edits, maintenance restart, merge or deployment.

### R5 follow-through — 2026-09-30 source repairs (not yet re-verified)

r5 returned NEEDS CHANGES at `71935f8acc034f224ad909f80d67defd06937aa6` (base `c54bfbf89727bacfd27a27db65a9fab681c19c3e`) with one blocker (final-head scheduler full + exact-head CI) and one confirmed display-correctness warning. This pass repaired the identified causes source-only; no timeout, pool, assertion or suite default was weakened, and no test/build command was run (the pacing scheduler owned the global verification slot).

- **Display warning (r5 confirmed):** `heistName` now ignores invisible-only graphemes (ZWSP/format/control/bare combining marks) before applying the 24-grapheme bound, so `'\u200b'.repeat(24) + 'wake alerts'` renders `wake alerts`; a ZWJ emoji cluster is one grapheme and survives intact; a name with nothing visible falls back to `unassigned` instead of an empty-looking card. Raw authored names are still stored and validated unchanged (ledger `hasVisibleCharacters`, protocol mirror). Coverage added: DOM case in `web/src/ui/board.test.ts` (prefixed-invisible, ZWJ emoji, invisible-only fallback), protocol acceptance in `web/src/lib/board-protocol.test.ts`, ledger acceptance + raw retention in `test/ledger-api.test.ts`.
- **LAN-phone replay race (`test/lan-phone-raw-client.test.ts:206`):** the phone asserted the replayed delta text immediately after the user frame; under load the delta frames had not arrived yet (received `''`). The case now waits for the replayed `turn end` frame before reading deltas — the same completion wait the file's reconnect case already uses. Assertions unchanged.
- **Perkins R2 receipt loop (`test/perkins-builtin-wave.test.ts:2952`):** eight mutations each rebuilt a full repo/ledger/worktree set, exceeding the authored 30 s default on the shared host (45.3 s in the failed full run; 34.7 s in a 3-file focused run). The case now shares one repo/ledger/port/artifacts across the eight mutations — the same sharing the neighbouring R1 case already uses; each mutation keeps its own round, event and aborts/null assertions. No timeout changed.
- **install-one-line owned-service case (`test/install-one-line.test.ts:604`):** the case spent a full extra installer cycle on setup+wizard before exercising service ownership. It now provisions the instance config directly — the retained-config pattern its neighbouring update test already uses — and still proves clone-when-absent → build → foreign refusal, then the owned restart. Assertions unchanged; no timeout changed.
- **Five `onTaskUpdate` RPC errors (failed run):** root cause is vitest 3.2.7's hardcoded 60 s worker→host birpc timeout (`DEFAULT_TIMEOUT = 6e4`, no configuration surface). A worker blocked in long synchronous test operations past 60 s raises the unhandled error while its tests still pass; the run exits 1. Upstream removed the timer (`vitest-dev/vitest#8297`, `timeout: -1`); the fix is pending on PR #135 as a `pretest` hook + `tools/patch-vitest-rpc-timeout.mjs` (cherry-picked on #134/#139) and is not on `main` or this lane. It is declared in the handoff matrix as a cross-lane gate dependency, not duplicated here.
- **Next gates:** scheduler-backed `full` at the new clean head (fresh ownership/media/free-space checkpoint; complete NDJSON capture + nested exit), exact-head Linux CI, then native Perkins re-review. Owner alone merges, deploys or restarts. The handoff matrix is `_bmad-output/implementation-artifacts/r5-followthrough-verification-matrix.md` (local, ignored).

### Main integration — 2026-10-02 (owner-cleared resume)

- Integrated current `origin/main` `059c076290145d4aae6e0b47c7b3f87156862c43`
  (PR #69 worktree-fresh-base + PR #151 native-compaction-wait) with an
  ordinary history-preserving merge; conflicts were limited to
  `docs/LEDGER.md`, `src/ledger/db.ts` and `test/suite-shape.test.ts`.
  Pre-integration head `364638f2dbf3388a63a1696204aff5f23a695f34` is
  preserved in history and as a local bundle under the resume briefing.
  No reset/discard/stash/force; no sibling lane touched.
- Genuine accepted-main collision: main's accepted id 9 is now
  `worktree-base-source`, so the never-applied `job-display-name`
  migration renumbers 9 -> 10 (no deployed DB had ever applied it;
  `docs/LEDGER.md` updated). The v8-upgrade test still exercises the
  full slice and passes structurally unchanged.
- `test/suite-shape.test.ts`: `supervisor.test.ts` pin recounted from the
  merged source (56); the whole pin map was revalidated against the guard
  regex — 98/98 files pinned, zero mismatches.
- R5 follow-through repairs (invisible-grapheme shortening guard and its
  three deterministic regressions, LAN-phone replay wait, Perkins R2
  fixture sharing, install-one-line direct provisioning) are all present
  and were not modified by the integration.
- Next gates (this head, no source change after): scheduler-backed `full`
  via `/api/verify`, exact-head Linux CI, fresh native Perkins review of
  the exact published head.

## Review Triage Log — fresh bmad-build layers, 2026-10-02

Fresh independent reviewer contexts (isolated one-shot `pi -p` sessions,
model `deepseek/deepseek-flash` matching the implementer route, cwd = this
lane; raw findings and full session transcripts preserved under
`_bmad-output/implementation-artifacts/reviewers-1437840/`). Content under
review: the unified diff `origin/main 059c076 → 1437840`, staged as
`review-crew-heist-labels-finaldiff-1437840.patch` (122069 bytes, sha256
`5339187d908d982e50c4c7ade99a3b6324345b619c57d0660e2efd40be81fce4`).
`baseline_commit` was corrected to `059c076` (the PR's current merge base)
because the previous value predated the 2026-10-02 main integrations.
Severities below are assigned by triage, not by the reviewing layers.

| Layer | Session id | Findings |
| --- | --- | --- |
| Blind Hunter | `01a0fd0e-4f72-7130-8937-d77e48778bbf` | 18 |
| Edge Case Hunter | `01a0fd0e-4fe7-77f7-a1c3-543827ce7609` | 4 |
| Verification Gap Reviewer | `01a0fd0e-4eff-7260-845d-2b0dc27c54e8` | 1 |

### Findings, verdicts, dispositions

| # | Finding (layer) | Verdict | Evidence / disposition |
| --- | --- | --- | --- |
| 1 | `POST /api/jobs` ignores `display_name` (blind) | false | Authoring surface is the dispatch handoff per frozen intent; `/api/jobs` is documented as-is (`docs/BOARD.md`), dispatch authoring is documented (`docs/FLOW.md`, `docs/LEDGER.md`). No defect. |
| 2 | No in-repo producer sends `display_name` (blind) | false | The optional field extends the dispatch API for the dispatcher's own handoff payload; intent required acceptance, not an in-repo sender. No defect. |
| 3 | Protocol comment over-claims a full ledger-rule mirror (blind) | low | Fixed: comment now names the visibility rule and records the deliberate omission of the 100-unit length ceiling (adding the ceiling here would reject whole snapshots for one long name). Comment-only. |
| 4 | One malformed `displayName` rejects the whole snapshot (blind) | false | Deliberate, documented, tested strict contract for malformed present blocks, consistent with the surrounding build/silas/verify blocks and the repo's fail-loud boundary style; unreachable from validated writers and from legacy rows (`display_name` exists only from migration 11). No defect. |
| 5 | `JOB_DISPLAY_NAME_MAX_LENGTH` doc math/units wrong (blind) | low | Fixed: comment now states 100 UTF-16 code units; value unchanged (tests pin it; intent requires a bound, not a grapheme count). Comment-only. |
| 6 | Raw authored name never surfaced (blind) | false | Lowercase display is the approved presentation; full title + id stay in tooltip/aria; normalization is documented in Design Notes. No defect. |
| 7 | Unlinked minions lose their ledger `label` (blind; edge #4) | false | Frozen I/O matrix: unlinked → `unassigned` + suffix; deliberate and tested (`web/src/ui/board.test.ts`, label→unassigned case). No defect. |
| 8 | Invisible-only `displayName` degrades to `unassigned` though a title exists (blind) | false | The ledger refuses the write and the protocol mirror rejects an invisible-only value before render; the renderer fallback is defense-in-depth for direct calls and is deliberate + tested. No defect. |
| 9 | Invisible graphemes inside a word join letters (blind) | low | Rejected: zero-width separator characters are rare copy-paste casualties, the display stays readable, and normalizing them would add a behavior branch for no acceptance gain. |
| 10 | Single over-long word is hard-cut, no test (blind) | low | Fixed-by-test: new DOM case pins the 24-grapheme grapheme-safe cut; multi-word names still cut at word boundaries (a single word has none). Test-only. |
| 11 | Same-heist workers indistinguishable in transcript titles (blind) | low | Fixed: the opened transcript label now carries the rail suffix (`wake alerts · dec9`), matching the rail row's disambiguation; DOM test updated. |
| 12 | E2E uses short ASCII names only; no overflow assertion (blind) | low | Deferred (deferred-work.md): recorded layout acceptance is the four human-inspected light/dark desktop+phone captures; the lane's only declared scheduler scope (`full` = `npm test`) does not run Playwright, so e2e assertions cannot be validated here. |
| 13 | Mobile full identity only via `title` (touch ignores it) (blind) | low | Rejected: the tooltip is the approved surface, the aria-label carries the full identity, and a tap-popover is a new interaction beyond intent. |
| 14 | Binding-failure dispose masks the original error (blind; edge #2) | low | Fixed: the dispose rejection is logged and the actionable binding error is rethrown (mirrors the stale-result path); test now makes dispose reject and asserts the rung reports the binding error. |
| 15 | Migration guard compares ids only (blind; edge #1) | low | Fixed: a recorded name that differs from code now fails loud with the mismatch named, closing the renumber/reuse blind spot this integration's 9→10 renumber exposed; ledger-db test simulates the pre-renumber DB. |
| 16 | Dispatch service forwards a blank `displayName` to the strict ledger (blind) | false | Ledger strictness (blank = error) and HTTP tolerance (blank = absent) are both the documented, intended layering; each boundary is pinned by tests. No defect. |
| 17 | "Extend only colliding suffixes" untested with a mixed group (blind) | low | Fixed-by-test: the collision fixture now includes a non-colliding peer on the same heist and asserts it keeps exactly four characters. Test-only. |
| 18 | `registerAgent` review-role protection is a hardcoded pair (blind) | false | The pair is the only review role the runtime can produce and is explicitly tested (`preserves the review-worker role…`); data-driven generality is speculative. No defect. |
| 19 | Applied-migration rename/reuse hazard (edge #1) | low | Fixed with #15 (same root cause). |
| 20 | Binding-failure dispose path (edge #2) | low | Fixed with #14 (same root cause). |
| 21 | G1 test relies on earlier suite sections (FK on `agents.job_id`) (edge #3) | low | Fixed: the implementer-list test self-seeds its job so focused runs no longer depend on earlier sections. Test-only. |
| 22 | Unlinked minion label no longer rendered (edge #4) | false | Duplicate of #7; same disposition. |
| 23 | Re-brief reviewer exclusion not observed by any test (verification gap) | medium | Fixed: the rebrief test now registers a round-bound live review-only handle and asserts it is absent from `disposedHandles` while the prior implementer is retired. Test-only. |

Repairs landed as source/test commits on this branch; the scheduler `full`
gate, exact-head CI and the fresh native Perkins round below run at the
repaired head.

## r6 INCOMPLETE and evidence repair — 2026-10-02

r6 (target `3398b43c14ca695c58291cbb612495c31adf594b`) returned INCOMPLETE:
the confined lead could read neither the owner's reference upload nor the
vision-skill route (both outside its immutable review directory), the frozen
specification carried only an older head's Linux CI receipt, and the edge and
acceptance specialists exceeded their 600000 ms turn budgets. Every failed
attempt and finding remains preserved under the host review artifact root; no
timed-out specialist is counted as coverage and no finding was erased.

This round repaired the evidence path against the two modalities the confined
review actually has — the frozen specification (ledger-backed scheduler
receipts appended at arm time) and the frozen worktree (tracked files read by
the run's image-capable read tool):

- **Visual evidence now rides the frozen tree.** The isolated mock fixture
  gained one working lane whose authored name is longer than the 24-grapheme
  bound and mixes Unicode with `<script>`/quote characters; the new
  `crew-rail` Playwright project asserts the short authored row, the bounded
  Unicode row, retained role/state subtext and pill, the full title/id in the
  tooltip and accessible name, no primary `minion` prefix and no horizontal
  overflow, then captures desktop/phone light/dark. Pixel reads of every
  capture come from the explicit vision route (`zai-coding-cn/glm-5.3-flash`
  via headless pi); captures, vision reports, hashes, commands and
  limitations are committed under
  `_bmad-output/implementation-artifacts/crew-heist-labels-evidence/`.
- **The owner's private reference upload is not published.** It stays
  host-side (owner material); the frozen briefing already carries its
  description and the evidence README records the limitation. The
  acceptance comparison is against the current render, which the pack
  supplies as pixels.
- **Linux CI receipts are committed with their exact relationship stated.**
  A receipt cannot be a file of the commit it describes (writing it moves the
  head), so the evidence pack carries the run receipt for the reviewed code
  commit plus the explicit evidence-only delta map to the frozen head, and
  the frozen head's own merge-result run is recorded on the PR. The
  scheduler `full` run at the frozen head is appended to the specification by
  the host because it is bound to that exact SHA.
- **The r6 architecture note was fixed proportionately.**
  `web/src/ui/board.ts:minionSuffixes` now buckets long IDs by their
  four-grapheme tail and scans only genuinely colliding buckets; values,
  row-order independence and short-ID behavior are unchanged, and a
  large-history regression pins lone tails, the 4→5→6 collision ladder,
  short IDs and reversal stability. No unrelated refactor rode along.
- **Second main integration.** `origin/main` `a2315ae` (PR #132
  provider-recovery sensor, PR #134 board-merged-attention) merged with an
  ordinary history-preserving merge; conflicts (silas-driver interface,
  migration numbering, suite-shape pins) resolved semantically with both
  sides kept. The never-applied `job-display-name` migration renumbers
  10 → 11 (`docs/LEDGER.md`, spec and test comments updated); the
  registered source checkout and sibling lanes were not touched.


### r7 evidence-round verification — 2026-10-03

- **Second main integration:** `eeb62f0` carries the merge of `b900837`
  (PR #150 gru-working-flavor + PR #143 lens-unused-neutral); conflicts in
  `fix-directive.ts`/`perkins.ts` resolved by keeping main's provider-pacing
  interlock whole and re-applying this lane's implementer-only selection; main's
  newer routing doubles gained `listImplementerMinions`; suite-shape pins
  recounted (dispatch-server 25, fix-directive 15, supervisor 86,
  rebrief-recovery 12).
- **Scheduler prep (exact head `eeb62f0`, clean tree):** scope
  `crew-heist-labels` run `b1f96c2e-0377-48d7-a788-7b020a0afc20`, exit 0 —
  web board/protocol 74 passed, `crew-rail` acceptance pass, backend focused
  12 files / 346 passed. Raw NDJSON host-side; record in the evidence pack.
- **Linux CI (exact head `eeb62f0`):** run `37083150166` SUCCESS, all steps
  including the full test suite; full job/step receipt committed in the
  evidence pack (`ci/ci-run-37083150166-eeb62f091281.json`).
- **Visual acceptance:** the four captures (`crew-{light,dark}-{desktop,phone}`)
  and their verbatim `zai-coding-cn/glm-5.3-flash` vision reports are committed
  under `_bmad-output/implementation-artifacts/crew-heist-labels-evidence/`
  with SHA-256 hashes, the inspected presentation and the limitations
  (including the model's `nion` OCR note and the owner-reference publication
  constraint) in that directory's README.
- **Prior failed attempt preserved:** the first prep run `a8e16b5e` exited 1
  with three timeout-class failures under a loaded host; its complete raw
  capture stays host-side and is not claimed as verification.
- **Evidence-chain CI:** the first evidence commit (`8a559a7`) failed the
  repository hygiene gate on one embedded host path; the scrub commit
  (`4c42ce2`) is green in run `37084328165` (all steps), whose receipt is in
  the evidence pack.
- **Structural note:** a commit cannot contain the CI receipt of itself
  (writing the receipt moves the head). The pack therefore binds the reviewed
  code head's receipt and states the exact relationship; the host scheduler
  `full` receipt at the frozen head is appended to this specification by the
  host because it is bound to that SHA.

### r8 final-head verification — 2026-10-05

- **First full at `c7d2f34` (load-class witness):** scheduler run
  `b48b27c8-3b46-4898-98dd-a472532ffd73`, exit 1 — three failed files, all
  real-service boot waits under co-tenant load (1785 backend tests passed):
  lan-phone W5 and wake-e2e both died in `startRealService`'s fixed 20 s boot
  deadline with the ledger-ready log inside the window and no `/health`
  answer yet; worktrees-server ROUND ARM hit the 30 s per-test default while
  creating a job worktree plus a detached review worktree. Complete capture
  host-side: `verify-crew-heist-labels-final-c7d2f34-full-20261005T005317Z.ndjson`.
- **Investigation:** all three are the co-tenant class `vitest.config.ts`
  already documents (boot deadlines expiring with zero assertion failures).
  The helper's single 20 s window was shared by the port-discovery and
  `/health` polls, so a slow discovery starved the health wait outright.
- **Repair at `cf4bb06` (test harness only):**
  `test/helpers/real-service.mjs` gets `BOOT_DEADLINE_MS = 60 s` with
  SEPARATE discovery and health deadlines — a wedged boot still fails loud
  at the same budget; the booting tests/hooks (lan-phone `beforeAll`,
  wake-e2e's three cases, worktrees-server ROUND ARM) get explicit 90 s
  ceilings matching the repo's existing real-service precedent
  (attachments 60–120 s, dispatch-server 90 s, perkins-builtin-wave
  60–120 s) so the helper's loud deadline, never a vitest cut, is the
  failure surface. No assertion, pool, or suite default changed;
  suite-shape pins hold; focused rerun of the three files: 12/12 pass.
- **Scheduler-backed full at exact clean head `cf4bb06` (GREEN):** run
  `3a4178cd-1bdb-479d-9690-4d00cdce00c0`, exit 0, not timed out, duration
  552 895 ms, `tracked_dirty: false`, output SHA-256
  `4f37ca7a3df27871c9bee00355c6293552bed10c9b7a2c9523133da35f238fbb`.
  Backend 106 files / 1792 tests passed (12 skipped, 4 files skipped);
  web 43 files / 418 tests passed. Complete capture host-side:
  `verify-crew-heist-labels-final-cf4bb06-full-20261005T0109Z.ndjson`.
- **Exact-head CI:** `c7d2f34` is green in run `37084763772` (all steps);
  the repair head's CI rides this documentation commit's push (structural
  note stands: a commit cannot contain its own CI receipt — the PR's
  merge-result run is the final-head receipt).

### r9 main-drift integration + fresh bmad review — 2026-10-05

- **Main drift forced a third integration:** main advanced to `639998e`
  (PRs #204–#209 + board-pr-number-links), leaving the PR CONFLICTING —
  GitHub builds no merge ref for a conflicting PR, so no `pull_request`
  CI run can exist at any head until the conflict clears (the missing
  CI at `d194a08` was this, not a dropped event; close/reopen did not
  and cannot fix it).
- **Fresh independent review (4 isolated terminal panes, `pi
  openai-codex/gpt-6-sol`, cwd = lane, diff `b900837...d194a08`):**
  blind-hunter 10 findings, edge-case-hunter 7, verification-gap 2,
  acceptance-auditor 1. Raw findings + session transcripts preserved
  under `reviewers-d194a08/` (host-side). Triage: the same-millisecond
  tie-break in `listImplementerMinions` was confirmed by all four
  layers and fixed (rowid insertion order); the directive
  registration-failure dispose gap, the stale-marker review-only
  resume, the provider-recovery non-adoption (vgap patch), the ZWJ
  code-point fallback, the boot-budget arithmetic, the fallback-row
  e2e fit, the scope-comment over-claim, the UTF-16 doc unit and the
  evidence README state-surface explanation are all repaired in the
  integration commit; the digest attribution sort is documented as
  deliberate (attribution ≠ routing); crew-rail in required CI is
  deferred to the owner/e2e-gate lane (deferred-work.md).
- **Integration `1aeeb7f`:** 19 files resolved semantically (migration
  17 renumber, implementer-only × #161 child-exclusion union across
  routing/supervision/provider-recovery, #171 rail carrying the heist
  names, mock fixtures merged, pins re-derived).
- **First full at `1aeeb7f` failed 3 merge artifacts** (run
  `8522bf1f`, exit 1, 1783 passed): child-workers migration fixtures
  seeded via the merged `addJob` against pre-#161 schemas lacking
  `display_name`, and the lane's verify scope named heavy files
  without the heavy config (test-budgets guard). Fixed at `992d51f`:
  fixtures seed raw SQL through their own schema; the scope's backend
  roster splits heavy/light per the repo rule.
- **Scheduler-backed full at exact clean head `992d51f` (GREEN):** run
  `f8b5ad83-e70e-45be-98fe-ce13a6b913e3`, exit 0, not timed out,
  duration 702 867 ms, `tracked_dirty: false`, output SHA-256
  `dfffdb1abb737e806c98ccfda482a3216a8433b6e3357cdcce8fe7dba819d196`.
  Backend 100 files / 1786 tests passed (6 skipped, 4 files skipped);
  decisions 29/741; web 44 files / 484 tests passed. Captures host-side:
  `verify-crew-heist-labels-final-{c7d2f34,cf4bb06,1aeeb7f,992d51f}-full-*.ndjson`
  (the c7d2f34 and 1aeeb7f failures preserved as load-class and
  merge-artifact witnesses).
- **Exact-head CI:** rides this documentation commit's push — the PR is
  mergeable again, so the merge-ref run is the final-head receipt.
