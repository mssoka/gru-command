---
title: 'Managed repository overview — compact rows below the crew list'
type: 'feature'
created: '2026-10-07'
status: 'in-progress'
route: 'dispatch'
baseline_commit: '49b558f243c7bacbfb46c7bc04f749bf131cefea'
review_loop_iteration: 2
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The right crew rail ends in a large quiet zone; the owner has no at-a-glance, read-only view of the managed repositories' GitHub state (open PRs, open issues excluding PRs, latest default-branch Actions run and its freshness). The owner selected compact rows "A" from the resumed mockup (job repo-status-mockups) and ordered immediate implementation (j-1259).

**Approach:** Add a read-only "Managed repositories" module below the crew list inside the existing rail: compact rows (repo identity + link when provable, exact open-PR and open-issue-excluding-PR counts, latest default-branch Actions run as workflow · branch + outcome + safe link, checked age), matching the approved Option A light/dark palette/type/spacing. Server-side: a background tracker derives rows from the configured managed-repo registry (workspace_root + the wizard's depth-1 `.git` discovery rule), resolves each origin remote, and reads GitHub through the existing authenticated `gh` seam on a bounded cadence with per-repo atomic observations, caching, and explicit stale/unavailable labeling. Board snapshot gains one additive typed `repoOverview` field.

## Boundaries & Constraints

**Always:** rows derive from the configured registry only (no hard-coded examples, no arbitrary scans); stable registry order; missing/non-GitHub/malformed remotes stay honestly not-linked — never a guessed identity or manufactured zero; counts are repository-wide exact totals via aggregate endpoints (issues exclude PRs), zero is a successful observed count, loading/failure/missing is never zero; the run shown is the newest run on the repo's actual discovered default branch (queued/running supersedes an older completed result), labeled as default-branch CI only, never deployment health, aggregate CI or merge readiness; `checkedAt` is the last successful server-side fetch completion, never render time; cached data survives errors only with explicit stale/unavailable labels, age and error, and an old green never reads as current; all reads are server-side through the existing `gh` auth seam inside the new tracker's bounded cadence/budget (no browser polling, no credentials in payload/logs, no unbounded fan-out or retry loop); additive optional-field snapshot/protocol compatibility; six board sections, counts/classification, Binned/Pipeline semantics, crew/disposed/history controls, transcript switching, scrolling, notifications/owner controls, slim KPI/For-you presentation and section-collapse behavior all unchanged; light/dark + narrow geometry with visible status text/glyph as well as color, safe focus and links, stable numeric layout, no horizontal overflow; provider strings render as untrusted text.

**Never:** no extra sorting preferences, repo-management UI, workflow selectors, new themes or dashboards; no changes to existing repo actions; overview reads/disclosures never ACK, execute or change GitHub state; no GitHub mutation; no new runtime dependencies, config keys, auth/provider changes, force pushes or source-history merges; no private screenshots, copied comparison HTML, mock controls or sample facts in app/public artifacts; no touching the slim-strip or section-toggle sibling lanes; original repo-status-mockups stays unchanged.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| REGISTRY_ROWS | configured workspace_root with N managed repos | exactly N stable-ordered rows; additions appear unchecked, removals drop; crew list untouched | unreadable root → empty registry, not an error |
| REMOTE_UNLINKED | repo without origin / non-GitHub host / malformed remote | linked=false, `linkReason`, counts/run null, NOT LINKED badge | no GitHub call spent on it |
| COUNTS | 0 / nonzero / multi-page (>100) totals; `incomplete_results` | exact `total_count` for `is:open is:pr` and `is:open is:issue`; zero shown as 0 | incomplete/malformed → attempt fails, prior data kept stale |
| RUN_STATES | success/failure/timed_out/cancelled/skipped/neutral/action_required/stale/startup_failure; completed/in_progress/queued family | mapped to the fixed state list with text+glyph; newest run by (createdAt,id) wins over older passed | unrecognized status/conclusion → `unknown` |
| RUN_EMPTY | workflows=0; workflows>0 but no run on default branch | `no-workflow`; `never-run` — never inferred from an empty run page alone | N/A |
| RUN_URL | provider run URL | https link only when hostname equals the repo host; else dropped to null | unsafe URL never rendered as href |
| FETCH_FAIL | one repo's call fails (permission/not-found/other) | that repo keeps its previous complete observation as `stale` (or `unavailable` with none) + error/age; other repos still refresh | rate-limit/auth aborts the rest of the refresh; next cadence retries |
| FRESHNESS | success older than 3× cadence without re-attempt; failed re-attempt after success | `stale` with the last outcome label and cached-result note; never implies current health | N/A |
| ACTIONS_OFF | workflows/runs return 404/409 or actions-disabled | counts still fresh; run state `unavailable` | attempt still succeeds |
| AUTH_ABSENT | `gh` missing/unauthenticated | rows attempted once per cadence, `unavailable` with the error; service stays up | loud bounded failure, no hammering |
| EMPTY / MANY | empty registry; many repos (> per-refresh budget) | explicit empty note; all rows present, refresh rotates within budget, rows stay usable via bounded list scroll | N/A |
| MALICIOUS | markup/hostile workflow names or URLs | rendered as inert text; hrefs only validated https | validator rejects malformed rows |

</frozen-after-approval>

## Code Map

- `src/wizard/steps.ts` -- `discoverManagedRepos` (depth-1 `.git`, dot-dirs skipped, symlinks count, sorted) is the registry rule; extract to shared module and re-export here.
- `src/repos/discovery.ts` (new) -- canonical `discoverManagedRepos`.
- `src/repos/overview.ts` (new) -- `ManagedRepoOverviewTracker` (mirror `src/board/deploy-drift.ts`: cached `view()`, coalesced `refresh()`, interval+stale policy, call budget, rotation), pure projections (`runStateOf`, `selectLatestRun`, freshness), `GhRepoOverviewApi` port adapter on `GhCommandRunner`/`defaultGhRunner`/`GhApiError`/`GhRateLimitedError` from `src/dispatch/github-poll.ts`; remote seam `repoRemote`+`isGitHubRemote` from `src/dispatch/review-path.ts`; exact endpoints: `repos/{o}/{r}` (default_branch), `search/issues?q=repo:o/r is:open is:pr` and `...is:issue&per_page=1` (`total_count`), `.../actions/workflows?per_page=1` (`total_count`), `.../actions/runs?branch=<default>&per_page=3`.
- `src/board/engine.ts` -- additive `repoOverview?: () => RepoOverviewView | null` option, snapshot field `repoOverview: RepoOverviewView | null` (late-bound like `buildDrift`).
- `src/main.ts` -- construct/start/stop the tracker (`workspaceRoot: config.workspaceRoot`), wire the late-bound view; shutdown stop.
- `web/src/lib/board-protocol.ts` -- mirrored types + strict optional `repoOverview` validation (absent/null tolerated).
- `web/src/lib/repo-overview.ts` (new) -- pure presentation model (badge label/glyph/tone, freshness overlay, notes, counts, safe link).
- `web/src/ui/repo-overview.ts` (new) -- `RepoOverviewPanel` rendering rows; uses the shared age ticker via an injected `ageNode` factory.
- `web/src/ui/board.ts` -- minimal hookup: construct panel on `#board-repos`, render after `renderAgents`; `web/index.html` -- new sibling panel `data-rail-panel="agents"`; `web/src/styles/components.css` -- `.repo-overview*` styles on existing tokens (independent bounded list scroll).
- `web/playwright.config.ts` -- new `repo-overview` project; `web/e2e/repo-overview.spec.ts` (new) -- light/dark + desktop/narrow geometry, glyph/text, zero side effects, synthetic WebSocket-seeded snapshots. `web/mock/server.ts` is deliberately NOT modified: the committed smoke/real theme baselines stay bit-identical and the module still gets a full browser proof through the established synthetic-seed pattern (lens-pills/pipeline-board); the mock's absent-field path doubles as the hidden-section compatibility check.
- Backend tests `test/repo-overview.test.ts` (new; fakes only, fast) + `test/board-engine.test.ts`/`test/board-server.test.ts` additions + `test/suite-shape.test.ts` pin; web tests `web/src/lib/repo-overview.test.ts`, `web/src/ui/repo-overview.test.ts` (new), `web/src/lib/board-protocol.test.ts`, `web/src/ui/board.test.ts` plus the two other DOM shims (`board-merged-attention.test.ts`, `owner-chime.test.ts`).
- `docs/BOARD.md` -- document the read-only module, data semantics and freshness rule; `.gru-command/worktree.toml` -- committed focused/static/browser/baseline scopes.

## Tasks & Acceptance

**Execution:**
- [x] `src/repos/discovery.ts` + `src/wizard/steps.ts` -- one canonical managed-repo registry rule -- rows and wizard can never drift.
- [x] `src/repos/overview.ts` -- tracker, exact counts, run selection/mapping, freshness/stale policy, budget/rotation, remote classification, gh adapter -- the whole server data path.
- [x] `src/board/engine.ts` + `src/main.ts` -- additive snapshot field + service wiring/lifecycle -- the board can render it and nothing else changes.
- [x] `web/src/lib/board-protocol.ts` + `web/src/lib/repo-overview.ts` -- mirrored types, strict validator, pure badge/notes model -- server truth renders deterministically.
- [x] `web/src/ui/repo-overview.ts` + `web/src/ui/board.ts` + `web/index.html` + `web/src/styles/components.css` -- dedicated compact-row panel below the crew list -- approved A fidelity with independent scrolling.
- [x] `web/playwright.config.ts` + `web/e2e/repo-overview.spec.ts` + `web/e2e/repo-overview.spec.ts` -- generic sample + browser geometry/theme proof -- inspected evidence.
- [x] tests + suite pin + docs + scopes -- full deterministic matrix, exact fail-before capture.

**Acceptance Criteria:**
- Given the configured registry, when the board renders, then each managed repo appears once in stable order with identity/link-or-not-linked, exact open-PR and open-issue-excl-PR counts, latest default-branch run state/context/freshness, and no hard-coded/sample facts; empty registry renders the explicit empty note and config changes never duplicate rows or disturb the crew list.
- Given zero/nonzero/multi-page counts, mocked GitHub/network failures, unknown values, partial repo failures, cached stale data and recovery, when the tracker refreshes, then zero is a real count; loading/failure/missing is never zero; only the failed repo degrades (stale/unavailable + age/error) and a later successful refresh restores `fresh`.
- Given completed and incomplete run outcomes, a moved default branch, multiple workflows and an empty run page with/without workflows, when the row renders, then the newest default-branch run is shown with the correct state text/glyph (including failed/timed-out/cancelled/skipped/neutral/action-required/unknown/never-run/no-workflow), labeled as default-branch CI only, linked only to a validated https URL.
- Given a pre-change snapshot without the field, when the web parses it, then the board renders unchanged (section hidden); a present malformed `repoOverview` is rejected by the validator; hostile labels/URLs never become markup or hrefs.
- Given light/dark desktop and narrow widths, when the rail renders, then rows keep legible counts/labels, visible status text/glyph, focusable safe links, no horizontal overflow, independent crew scrolling and working transcript switching; overview interactions cause zero GitHub writes/ACKs/executions; `npm test` and the committed scopes stay green.

## Implementation Notes

- Workflow state: lane-local `bmad-build` render `_bmad/render/bmad-build/job-managed-repo-overview-compact-rows-20261007-fcf5e1520d66/a577bd78ee00aae81fc8/`. Step-02 executed against base `49b558f243c7bacbfb46c7bc04f749bf131cefea` (equals observed remote main; clean branch `gru/managed-repo-overview-compact-rows-20261007`). Checkpoint 1 is auto-resolved under the briefing's explicit authority and the owner's settled Option A selection; no human is present in the lane, no Open Questions remain (the briefing settles every mockup-listed semantics question). The spec measures ~4.0k estimated tokens (above the 1600-token proposal); kept full — the briefing's six-part acceptance contract is one cohesive cross-layer deliverable (backend tracker + snapshot + web component + browser proof) that cannot be split into independently shippable PRs, and route is `dispatch`.
- Fixed decisions (owner briefing + mockup cannot settle implementation-level choices; none are user-visible surprises): cadence 300 s; `freshness` = fresh within 3× cadence of the last SUCCESSFUL fetch, else stale; checkedAt = successful fetch completion on the server clock; newest run = max by (createdAt, id); per-refresh call budget 100 with rotation; unsupported/absent remotes spend no GitHub call; not-linked rows carry a reason.
- No subagent runtime in this lane's tool surface: implementation runs directly from this spec (step-03 fallback); the built-in independent review runs as fresh tracked read-only review jobs via `POST /api/dispatch` (`"deliverable": "review"`) per the playbook.
- Verification: scopes `repo-overview-focused`, `repo-overview-static`, `repo-overview-browser`, `repo-overview-baseline` added to `.gru-command/worktree.toml`; all runs through the authenticated `/api/verify` scheduler via the shipped complete-capture helper, exact-head receipts recorded below.
- Implementation commit `c3f3b3519a429c6032d114d74490abc28dc84d4a` (PR #257). Round-1 schedule receipts at that head — `repo-overview-focused` PASS (backend 5 files/116 tests + web 6 files/177 tests; run `c40dcd58-a6ef-4074-80cf-2942e8680051`, capture sha256 `cf66fb9e…`), `repo-overview-static` PASS (lint/typecheck/build/web tsc; run `6718115f-4d1f-4c0a-b85b-0c6a322c5161`, capture sha256 `bf54d1c5…`), `repo-overview-browser` PASS (3 tests; run `149dd9a1-d800-46d5-8e22-843a758d15e4`, capture sha256 `2dd02ec5…`), `repo-overview-baseline` RED by design (backend 4 + web 4 named assertion failures; run `32152c83-a895-45f0-b632-13a4ea047396`, capture sha256 `e7e85033…`, snapshot `/var/folders/…/gru-baseline-repo-overview.x912Sv`). The `full` request (`full-c3f3b35-1`, run `4489163b…`) queued behind a foreign run past the capture helper's wait bound and was left accepted for re-attach at the same durable request id; it is not PASS evidence.
- Round-1 independent review (three fresh tracked read-only jobs via `POST /api/dispatch`, deliverable `review`, target PR #257 + head `c3f3b35`, commissioner this lane): `repo-overview-review-{blind,edge,verify}-20261007`, all delivered; reviewer trees verified clean at base, findings collected from their transcripts into the ignored `_bmad-output/managed-repo-overview/reviews/r1/`. Findings and dispositions in the Review Triage Log; all valid ones are fixed in the round-2 commit `77643e6ee54e91c8b8bdf968341bc5da296006da` (pushed; PR #257). Reports retained; no reviewer tree was modified. Round-1 report dispositions: blind routed as `acted` by the ops layer; edge + verify settled `acted` by this lane (directive job = this lane).
- Round-1 fix-head schedule receipts at `77643e6`: `repo-overview-focused` PASS (backend 5 files/124 tests + web 6 files/179 tests; run `950f6510-a522-45f7-b93d-68f3fc2fb03e`, capture sha256 `7455b656…`), `repo-overview-static` PASS (run `30c43cb6-8eb5-4513-9f97-b6132e3c76dc`, capture sha256 `369b19f4…`), `repo-overview-browser` PASS (3 tests; run `744c29d7-2fea-4524-a2d2-fc93dd6ff026`, capture sha256 `d97d76c7…`), `repo-overview-baseline` RED by design (4+4 named assertion failures; run `6fffb503-6a88-4e8e-b8df-e80ebe0d6896`, capture sha256 `b55166b0…`, snapshot `…/gru-baseline-repo-overview.SnwfiW`), `full` PASS (exit 0, 587648 ms, trackedDirty false; run `e0b29ec8-266e-43d3-ac4e-28268e697052`, capture sha256 `ab651403…`; fast backend 120 files/2339 tests, heavy 30 files/925 tests, web 47 files/548 tests, lint/typecheck/build included). The earlier `full-c3f3b35-1` request (run `4489163b…`) is preserved as a contaminated attempt: it was admitted while this lane was mid-edit (`trackedDirty: true`) and failed typecheck on a transient in-progress signature — never PASS evidence, never rerun for logs.
- Round-2 independent review (same three lenses, fresh tracked jobs at the round-1 fix head `77643e6`): `repo-overview-review-{blind,edge,verify}-r2-20261007`, all delivered, reviewer trees clean; findings in `_bmad-output/managed-repo-overview/reviews/r2/`. All valid findings fixed in the round-3 commit (atomic classification publishing, host-pinned links, hidden-panel scroll memory, no-branch state, budget/abort disclosure, async scan, validator hardening, cadence test, drift alarm, raw-context tooltips); dispositions in the Review Triage Log. Process note: the r2 briefs' READ block still named the parent diff range while the TARGET named the fix head; all three reviewers resolved it correctly (they reviewed base→head and the repair delta) — the round-3 briefs carry corrected ranges.

## Design Notes

- Counts: REST search `total_count` is GitHub's exact aggregate; `open_issues_count` is deliberately NOT used (it includes PRs and cannot exclude them). `incomplete_results: true` degrades the attempt, never presented as exact.
- Server data path is one attempt per repo (all calls must succeed, except permanent Actions-unavailable) so a row's counts/run share one `checkedAt` and freshness label; the atomicity keeps the UI honest without a second freshness field.
- Shared `gh` auth budget: tracked-PR poll worst case 50 calls/min; overview ≤ 100 calls per 5 min = 20/min → combined ≤ 70/min ≤ 5 000/h with headroom. Search calls are PACED to one per 2 s (≤30/min sustained), because each repository costs two search calls and a 20-repo pass would otherwise burst past GitHub's 30/min Search quota and self-inflict a 403 that aborts the pass.

Run-state → badge text/glyph/tone (one table, server state, web-rendered; text carries meaning, color is never the only cue):

| state | text | glyph | tone |
|---|---|---|---|
| passed | PASSED | ✓ | done |
| failed | FAILED | ✕ | alert |
| timed-out | TIMED OUT | ⏱ | alert |
| startup-failure | STARTUP FAILED | ✕ | alert |
| action-required | ACTION REQUIRED | ! | alert |
| cancelled | CANCELLED | ⊘ | park |
| skipped | SKIPPED | — | park |
| neutral | NEUTRAL | — | park |
| stale-run | STALE RUN | ⌛ | park |
| running | RUNNING | ↻ | work |
| queued | QUEUED | ⋯ | work |
| no-workflow | NO WORKFLOW | ∅ | park |
| never-run | NO RUNS | — | park |
| no-branch | NO BRANCH | — | park |
| unknown | UNKNOWN | ? | park |
| unavailable (run) | UNAVAILABLE | ! | park |

Freshness overlays replace the state badge when the row is not fresh: `NOT CHECKED` (?), `UNAVAILABLE` (!, fetch failed, no cache), `STALE · last <state text lowercased>` (⌛, cached after failure or older than 3× cadence), `NOT LINKED` (!). Notes disclose: cached-result/no-health-claim, fetch-failed age, newest-run-in-progress/queued precedence, cancelled-neither, no-run-yet, actions-unavailable, not-linked reason.

## Spec Change Log

- Round-1 review (independent tracked jobs at `c3f3b35`): the frozen intent was not changed. The Code Map's `web/mock/server.ts` deliverable was corrected to the deliberate decision (synthetic-seed browser proof; committed baselines untouched) and the Design Notes' search-quota arithmetic was replaced with the implemented 2 s pacing rule. No intent renegotiation.

## Review Triage Log

Round-1 whole-change review at `c3f3b3519a429c6032d114d74490abc28dc84d4a` (base `49b558f243c7bacbfb46c7bc04f749bf131cefea`), three fresh tracked read-only jobs (blind / edge-case / verification-gap), all findings independently triaged against the code before grouping.

| ID | Layer | Verdict | Evidence / disposition |
|---|---|---|---|
| B1/E2 | blind+edge | medium | `classifyGhError` and `isActionsUnavailableError` matched the annotated label, so a repo named `authentication-service`/`actions-disabled-*` could flip a per-repo failure into a global abort or a fake Actions state. Fixed: `GhApiError.causeText` (gh stderr / spawn detail) is the ONLY classification input for structured errors; adapter/shape errors are per-repo `other`. Pinned by label-contamination tests. |
| B2/E6 | blind+edge | medium | Attempt timestamps were written at attempt START, so an in-flight fetch rendered STALE/"fetch failed" on every cadence. Fixed: `lastAttemptAt` is written at completion (success or failure) only; a partial budget attempt records nothing. Pinned by a gated in-flight view test. |
| B3 | blind | medium | Panel rebuilt unconditionally on the 30 s snapshot push, resetting list scroll and focused links. Fixed: the panel preserves `scrollTop` and restores focus through per-row `data-focus-key` values. Pinned by a DOM test. |
| B4 | blind | medium | Remote resolution used `spawnSync git` per repo per refresh (event-loop stall). Fixed: the default resolver is async (`execFile`, 10 s timeout); the tracker awaits it. |
| B7/E5 | blind+edge | medium | Non-object `workflow_runs` entries were silently dropped, manufacturing `never-run`. Fixed: `latestRuns` fails loud on a malformed entry; the tracker keeps the previous observation stale. Pinned. |
| B8 | blind | low | A per-refresh budget smaller than one observation pinned the cursor and starved later repos. Fixed: rotation advances past a partial observation (nothing recorded). Pinned. |
| B9 | blind | low | Two Search calls per repo could burst past GitHub's 30/min Search quota. Fixed: search calls paced to 2 s (≤30/min sustained). Pinned; spec arithmetic corrected. |
| E1 | edge | high | Provider `run_number`/timestamp garbage could reach the snapshot, fail the web validator and freeze the whole board. Fixed server-side normalization (`countOrNull`/`isoOrNull`); validator coherence also hardened (fullName non-empty, safe segments, link pathname must match). Pinned adapter + protocol tests. |
| E3 | edge | low | A `gh` timeout was classified like a missing `gh` and aborted the pass. Fixed via structured causes: timeout/output-cap are per-repo `other`. Pinned. |
| V1 | verify | high | Badge tone classes had no stylesheet rules — every chip rendered neutral; the DOM test only asserted a class name. Fixed: emit the established `pp-chip--<tone>` contract; browser spec now asserts distinct computed backgrounds. |
| V2 | verify | medium | Production default scan/remote-resolver seams were never exercised (every test injected them). Fixed: a real-workspace test drives both defaults over a temp `git init` repo + a non-repo directory. |
| B5/E7 | blind+edge | low (claim) | Spec Code Map named `web/mock/server.ts` sample rows that were deliberately not implemented. Resolved as a spec correction: committed mock/theme baselines stay bit-identical; browser proof uses the established synthetic-seed pattern. Recorded in the Spec Change Log. |
| B10 | blind | low | Parity corpus not extended. Fixed: `test/board-frames.test.ts` valid exemplar now carries `repoOverview` (plus a malformed variant). |
| B12 | blind | low | The module joined the CREW tab without the tabpanel a11y contract. Fixed: `role="tabpanel"`/`aria-labelledby` on the section, `aria-controls` includes both panels; browser spec asserts. |
| B13 | blind | low | `repoCiView` fell back to a fabricated `workflow` label. Fixed: missing workflow renders `—`. Pinned. |
| B14 | blind | low | Coverage gaps for the above. Fixed by the new tests (in-flight, label contamination, tiny budget, pacing, malformed runs, normalization, default seams, panel scroll/focus, push-to-empty, computed tone colours). |
| E4 | edge | false | `.github`-suffixed hosts are accepted by the repository's own `isGitHubRemote` policy (the same seam the tracked-lane poll and Perkins use); tightening it in this lane would change sibling behavior outside the approved scope. Inherited policy, not a defect here. Reported as a follow-up rather than patched. |

Round-2 whole-change review at `77643e6ee54e91c8b8bdf968341bc5da296006da` (`repo-overview-review-{blind,edge,verify}-r2-20261007`, same three tracked read-only lenses; reviewer trees verified clean).

| ID | Layer | Verdict | Evidence / disposition |
|---|---|---|---|
| R2-1 (verify F1, edge 1, blind) | verify+edge | high | Async remote classification published `registry` before classifying, so a mid-pass `view()` could emit a newly added row as `linked:false` with `linkReason:null` — the web validator then rejected the WHOLE snapshot. Fixed: classification builds a local map and publishes registry+states atomically after every remote resolves; never-classified entries stay unpublished and a resolver error keeps the previous row. Pinned with a gated cross-validator mid-pass test. |
| R2-2 (blind 1-2) | blind | medium | Link/run URLs were not host-pinned client-side. Fixed: rows carry `host`; the validator requires the https link hostname and any run URL hostname to equal it. Pinned. |
| R2-3 | blind | medium | Scroll memory failed while the panel was hidden (`scrollTop` reads 0 under `[hidden]`). Fixed: panel remembers the last observed offset (render capture + scroll listener) and restores it. Pinned. |
| R2-4 | blind | medium | A repo with no default branch degraded the whole observation. Fixed: new `no-branch` run state keeps exact counts and skips runs/workflows calls. Pinned across server + web. |
| R2-5 | blind | low | Budget exhaustion mid-observation left no log. Fixed: the retry path sets the budget abort so the operator-visible warning fires. Pinned. |
| R2-6 | blind | medium | A persistent global outage left unreached rows undisclosed. Fixed: a fatal abort marks every unattempted linked repo with the abort detail (stale/unavailable + error), matching the spec's AUTH_ABSENT row. Pinned. |
| R2-7..R2-10 | blind | low | Empty provider strings, invisible display names, freshness/checkedAt+run incoherence, and the stale `lastAttemptAt` comment. Fixed in the validator/comments. Pinned. |
| R2-11 | verify | medium | The refresh cadence/stop had no executing test. Fixed: `start() schedules background refreshes and stop() clears the timer` (mirrors deploy-drift). |
| R2-12 | blind | low | Default-resolver failure paths untested. Fixed: the real-workspace test now drives no-origin, non-GitHub and git-error semantics (git-reported no-remote resolves null; spawn/timeout rejects and keeps the prior classification). |
| R2-13 | blind | low | Five transported run fields were validated but never rendered. Fixed: raw provider status/conclusion/run number/timestamps render as badge and CI tooltips, with DOM assertions. |
| R2-14 | blind | low | Registry scan stayed synchronous each refresh. Fixed: `discoverManagedReposAsync` (identical rule) is the tracker default; the wizard keeps the sync twin. |
| R2-15 | blind | low | Hand-mirrored run-state/freshness unions had no drift alarm. Fixed: both sides export runtime lists and `test/board-frames.test.ts` pins them equal. |
| R2-E2 | edge | medium | A resolver error became `null` and was classified as remote-less, dropping cached data. Fixed: git-reported no-remote resolves null; spawn/timeout rejects and the previous classification is kept. Pinned. |
| R2-E3 | edge | low | Unlinked rows could validate carrying counts/run. Fixed: unlinked rows require null host/counts/run. Pinned. |
| R2-E4 | edge | low | Focus dropped to body when the focused row vanished. Fixed: focus lands on the nearest surviving control in the module. Pinned. |
| R2-brief | process | — | The r2 briefs named the parent commit as the diff endpoint; reviewers resolved it locally. Round-3 briefs corrected; no code impact. |

## Verification

**Commands:**
- `repo-overview-focused` -- expected: PASS (backend tracker/engine/server suites + web protocol/pure/DOM/integration suites); `repo-overview-static` -- expected: PASS (lint/typecheck/build/web tsc).
- `repo-overview-browser` -- expected: PASS (mock playwright project; captures under a gitignored lane root).
- `repo-overview-baseline` -- expected: RED both legs by named behavioral assertions against base `49b558f` (import/setup failure is not fail-before evidence).

**Manual checks:**
- Inspect the light/dark desktop/narrow captures against the approved Option A mockup (row rhythm, badge text+glyph, module under the crew list, no overflow).

