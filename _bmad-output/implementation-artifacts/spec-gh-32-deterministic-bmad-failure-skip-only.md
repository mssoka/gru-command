---
title: 'GH-32: deterministic BMAD setup failures must not offer futile retry'
type: 'bugfix'
created: '2026-09-30'
status: 'in-review'
route: 'oneshot'
baseline_commit: '2aa836abe262759c651683deb40d05f02c9ede86'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** After a BMAD onboarding failure the wizard always offers
"Retry or skip" (interactive) or "Retry after fixing it" (noninteractive).
For deterministic failures — unchanged on-disk state such as a manifest
declaring a missing, unsafe (symlinked), or escaping module directory, an
existing install lacking the selected runtime binding, a malformed existing
manifest/record, or a refused unsafe path — retry re-runs the identical
check against unchanged bytes and fails identically, looping the user
(observed 3+ futile retries in the field, gh-32).

**Approach:** Classify failures at the source in
`src/wizard/bmad-onboarding.ts`: deterministic state-validation throws
become a named `BmadDeterministicSetupError`; the returned
`BmadRepoResult` carries `deterministic: true`. The wizard failure loop
(`src/wizard/main.ts`) then offers skip-only for deterministic failures,
with actionable text naming the deliberate repair path (`npx bmad-method
install` in that repo, then re-run the wizard; Gru never repairs or
overwrites an existing install automatically). Transient failures —
missing prerequisites, installer start/network/download/output — keep the
existing retry/skip offer unchanged. Explicit per-repo skip, the
noninteractive fail-loud contract, and all collected answers/behavior are
preserved; the noninteractive deterministic message stops suggesting a
futile retry and names the same deliberate fix path plus
`answers.bmad.<repo>="skip"`.

Owner authority: dispatch briefing (j-481, 2026-09-30) approves gh-32's
settled behavioral plan and directs this lane to run once without
re-asking — recorded here as the standing Checkpoint-1 approval.

</frozen-after-approval>

## Implementation Notes

- Investigation: `onboardBmadRepo` (src/wizard/bmad-onboarding.ts) catches
  every throw into a plain `{ ready: false, message }`; main.ts's loop
  (src/wizard/main.ts ~620–651) is the only consumer of that result.
  Classification therefore needs one named error class, one optional
  result field, and one new branch in the wizard loop — no signature
  changes elsewhere.
- Deterministic class = checks of unchanged on-disk state:
  validateRepo, assertControlFilesSafe, assertNoSymlinkComponents,
  runtimeSkillNames, assertNoPartialInstall, validatedSkillPath,
  hashOwnedPayload, verifyModuleDirectories, verifySkills,
  verifyNoAmbiguousSkillConfig, existing-manifest parse (wrapped at the
  reuse call site so fresh-installer output stays transient), "BMAD
  already exists", "reuse requested but no existing BMAD manifest", the
  four existing-record payload checks, and the missing-runtime-binding
  mismatch. Transient (plain `Error`, retry retained):
  assertPrerequisites ("Install them, then retry"), installer
  start/exit failures, preflight skill-collision ("move them before
  retrying"), fresh-install output guards, and post-install control
  writes.
- Regression tests: classification unit tests in
  test/bmad-onboarding.test.ts (missing/symlinked/escaping declared
  module dir, binding mismatch, malformed manifest → deterministic true;
  installer and prerequisite failures → no deterministic flag); pty tests
  in test/wizard-interactive.test.ts (deterministic → skip-only prompt
  naming `npx bmad-method install`, Enter skips and setup completes;
  transient → "Retry or skip" still offered, retry succeeds via a
  stateful fake npx); noninteractive legs in test/wizard.test.ts
  (deterministic failure exits 1 with the truthful message; explicit
  `bmad.<repo>="skip"` still completes headlessly). Fixtures are
  temporary directories only; no real config/BMAD repo is touched and no
  network installer runs.
- Documentation: no README/docs text describes the failure prompt today,
  so no doc change is required; "per-repo skip is always available"
  (README) stays true.
- Review layers: the in-session subagent review layers are not launchable
  in this headless lane; independent review is honored through the
  lane's coordinated gate — native Perkins admission on the PR, owned by
  Silas's verification queue per the dispatch briefing (no self-armed
  review).
- Continuation (2026-09-30, same-job successor after the owner provider
  restart): the disposed predecessor's five-file WIP was preserved as a
  binary snapshot and byte-compared (diff SHA-256 and per-file SHA-256
  match) before any further edit. Its final identified defect was in the
  transient pty fixture: the stateful fake `npx` compared its
  `--directory` argument against the raw `mkdtemp` path while the wizard
  validates and installs through `realpathSync` (macOS `/var/...` →
  `/private/var/...`), so the injected first-write failure never fired.
  The retained WIP already carries the correction (`realpathSync` embedded
  in the fixture); this continuation re-derived and verified it and
  changed no source/test bytes. Direct partial runs by the predecessor
  (build, source typecheck, `bmad-onboarding` + `wizard` suites green
  after fixture repair; pty suite 1 failed / 9 passed, then the realpath
  fix was applied) are partial evidence only: the post-fix pty rerun never
  completed before disposal, and none of it is scheduled gate clearance.
  The declared focused scope below is the first admissible scheduled run
  at the pushed head.
- Continuation (2026-09-30, same-job successor, CI repair): CI run
  36773384950 at ed13cc8 failed exactly one test — the suite-shape pin
  guard (test/suite-shape.test.ts:136, "bmad-onboarding.test.ts:
  registered 14 tests, pin says 13"). The guard loop short-circuits on
  the first stale pin, hiding two more stale pins: wizard-interactive
  (8 → 10) and wizard (24 → 25). Every pin was re-derived from raw
  sources with the guard's own regex (/\bit\(|\bit\.skipIf\(/g): only
  those three files differ from their pins, each by exactly the tests
  this lane added (bmad-onboarding +1, wizard-interactive +2, wizard
  +1); all other 95 files match. Pins refreshed; no test identities or
  oracles changed. The declared focused scope now includes
  test/suite-shape.test.ts so the focused gate exercises the causal
  defect; this remains source/CI/focused evidence, not gate clearance.
- Continuation (2026-09-30, same-job successor, verification-setup
  correction): the first scheduled focused run at c770f95 (run
  cdb660f5-7283-46f3-922c-d1551d9d0659, scope wizard-bmad-retry) exited
  1 with all 4 files / 51 tests passed and exactly one unhandled
  `[vitest-worker]: Timeout calling "onTaskUpdate"` — vitest 3.2.7's
  60 s worker→host birpc timer on a loaded host (upstream removed the
  timer; the repo carries the approved fix in
  tools/patch-vitest-rpc-timeout.mjs). `npm test` applies that patch via
  `pretest`, but the bare focused scope did not. The declared scope now
  runs `node tools/patch-vitest-rpc-timeout.mjs` before the same
  `npx vitest run` of the same four files — the settled existing fix
  only: no new deadline/fixture/scheduler/runner/pool change, no
  RPC/test-budget increase, and patch guards plus every test identity,
  assertion and 30 s bound are unchanged. This is a verification-setup
  correction, not a product causal repair. The recorded exit 1 stands
  and all-51-pass is not clearance. Local `dist/build-rev.json` still
  labels `rev: 2aa836abe262759c651683deb40d05f02c9ede86` (pre-commit WIP
  build, builtAt 2026-09-30T20:08:53.983Z); focused runs are not a fresh
  full installed-build claim — ops FULL rebuilds the exact final head.
- Continuation (2026-10-01, same-job successor, CI fixture repair): CI
  run 36801770035 at abfe7d2 (synthetic merge 1520f8b) was green on
  lint/typecheck/build and failed exactly two classification fixtures.
  (1) test/bmad-onboarding.test.ts's plain non-Git case routed through
  `answers()`/parseAnswers first; parseAnswers correctly refuses a repo
  name whose `.git` is absent, so the intended validateRepo deterministic
  assertion was never reached. The fixture now validates answers while
  the directory is still a Git repo, removes `.git` (the race validateRepo
  guards), re-asserts that parseAnswers still refuses the now-invalid
  name, and only then calls the direct onboarding seam — asserting
  deterministic classification, neutral guidance and a no-write oracle.
  (2) test/wizard.test.ts's binding-mismatch leg selects claude-code,
  whose prerequisite probe hit the recoverable missing `claude` CLI
  before the intended deterministic missing-binding check; the leg's
  owned bin fixture now provides a harmless synthetic `claude` stub so it
  reaches the deterministic branch without depending on an installed user
  CLI, while missing-tool retry ownership keeps its dedicated inverse
  coverage. No test identity, assertion, deadline, pin or expected text
  changed; this pass executed nothing (static source only). The declared
  focused scope already builds first for its dist-driven CLI/pty legs;
  the command list below is trued up to match.

- Continuation (2026-10-02, backlog-native-fixes-pr148-20261002, native r1 repairs): Perkins whole-PR r1 (NEEDS CHANGES, head 2bf6bc7) confirmed three blockers + one warning, all in bmad-onboarding.ts classification (the wizard loop in main.ts already consumes `deterministic` correctly in both modes and needed no change). Repairs: (1) reuse validates declared module directories via `verifyModuleDirectories(existing.summary)` BEFORE record/fingerprint work — an already-onboarded missing/symlinked module keeps the official-installer repairHint even when the fingerprint also mismatches; fingerprint validation itself is unchanged, and the now-redundant post-hash call was removed; (2) `validatedSkillPath` classifies realpath ENOENT/ENOTDIR on a recorded binding/root as deterministic with the installer hint ("BMAD recorded skill binding is missing"), rethrowing every other errno as transient — no blanket catch; (3) `assertControlFilesSafe` reads the record and worktree-manifest text OUTSIDE their parse catches, so a valid-but-unreadable control file stays transient (never "malformed"), while parse failures remain deterministic; (4) disposable preflight-stage validation is downgraded to transient via `preflightSkillNames` (safety refusal text retained, stage deleted in finally, repo untouched), while existing-repo validation stays deterministic. Regressions: test/bmad-onboarding.test.ts (five-part r1 matrix), noninteractive leg in test/wizard.test.ts (successful synthetic install → delete recorded binding → reuse → exit 1 skip-only truthful message), pty leg in test/wizard-interactive.test.ts (same class through the interactive mode; Enter skips and collected answers complete setup); suite pins bumped 14→15, 25→26, 10→11. This phase executed static source edits only; the merged main parent is 6a00f4e50e7ae970915a9a534c142c1f8a45b57d (PR151).

- Continuation (2026-10-02, pr148-proof-prep-20261002): after the first collected focused PASS at exact b13b6eb (run 85913ad0, 54/54 across suite-shape 2 / onboarding 15 / pty 11 / wizard 26, chief-verified whole-output hash 4f4bf9eebf0a3e2b0a8dd0a05ca0399adddfab0df9b81979fd951f9696c64261), minimal source-only proof preparation before final FULL: (P1) the grouped r1 unit case is split into FIVE explicit it() cases — missing module, symlinked module, deleted recorded binding, control-file read+recovery, disposable preflight — so each class can RED independently against pre-fix source; the read+recovery case retains ONE captured answers object across every attempt and restores permissions in finally; (P2) the deleted-binding pty case now types a deliberate retry and proves via single-occurrence banner/message counts that no second setup attempt runs before the deliberate skip (the older missing-module typed-retry leg is a different class); (P3) new scheduler-only baseline scope wizard-bmad-retry-baseline: git archive of the PRE-REPAIR merge parent cee0ecbe53229d05c13f909dd11d4b31e886db72, identical final tests + suite pins overlaid from the committed final-test headrev (captured at admission, never a circular self-SHA), node_modules bound by symlink, approved RPC patch + npm run build BEFORE the dist-driven CLI/pty legs, unchanged vitest pools/30s budgets/assertions, per-file test hashes + base/head SHAs + retained snapshot pointer recorded in the ignored gate-prep pointer file, nonzero RED exit preserved unmasked, baseline and final focused runs are separate scheduler requests. Suite pins: bmad-onboarding 15→19; pty 11 and wizard 26 unchanged. Static source phase; no product execution.

- Continuation (2026-10-02, owner-approved completion cycle under j-837/j-858/j-861, one rebuilt worker in the same lane): ownership reconciled before any effect — the detached producer PID19628 completed its ONE admitted FULL (run 5dfe4bea, exit 1) and genuinely ceased; no pending rebrief, live round, rooted process or accepted lane verification remained; the earlier queued directive had failed HTTP400 disposed-before-delivery and was NOT replayed. Current-main integration performed as an ordinary history-preserving merge in this worktree: branch tip 2e837de + fresh origin/main b900837 → merge commit bcdb5e6. Sole textual conflict `.gru-command/worktree.toml` (both sides appended `[verify]` scopes) resolved as a UNION — every main scope and this lane's `wizard-bmad-retry` + `wizard-bmad-retry-baseline` are retained, validated with a TOML parse; `test/suite-shape.test.ts` auto-merged as the union of both sides' pin updates (branch: bmad-onboarding 19, wizard-interactive 11, wizard 26; main: its new/updated counters). No semantic product decision, no rebase/reset/force/discard, no cross-lane transplant; the j-829 harness-budget change and the review-rebrief-interlock T4 cost repair stay with their own lanes.

- FULL-timeout diagnosis (complete failed output first, per j-858/j-861): run 5dfe4bea at head 2e837de, decoded 115441 bytes / SHA f73a17d5…, ledger 39434 — all seven failures are per-test 30000ms timeouts (dispatch-server silas attribution; install-one-line owned-service; perkins-builtin-wave schema-exception and T4 reconciliation; perkins-freeze-freshhead remote-tip; perkins-whole-review empty/verdict identity; wizard `--answers` secrets/non-object) with ZERO assertion failures; lint/typecheck/build passed and backend RED stopped the chain before `test:web`. Within this lane, the SAME head passed a focused run (ce4f49c2, exit 0, includes `test/wizard.test.ts`) and produced only one timeout in the earlier lighter FULL c02f989d (6 of the 7 passed) versus seven in 5dfe4bea; exact-head GitHub CI 37004307525 (2e837de) passed the full suite on an isolated runner; and the identical test names timed out in other lanes' local FULLs in the same hours (terminal-rebrief-retirement 17:24 dispatch-server; perkins-github-app-publisher 18:17 five of the same names; compaction-timeout-isolation 14:57 four of the same names) while none of the six non-wizard files is touched by this lane. Conclusion: the observed failures are host resource-timing artifacts of co-tenant local execution — the inferred cause is recorded as the best-supported explanation, not promoted to proof (j-825 framing); no product defect is attributable and none was found. No timeout, assertion, budget or gate changed; the earlier FULL failures are preserved, not erased.

- Final-head gate plan (merged head onward): authenticated scheduler requests with unique pre-opened raw/decoded sinks, one outstanding at a time — `typecheck`, focused `wizard-bmad-retry`, `full`, and the newly declared `wizard-bmad-browser-consumer` scope (web compile+unit suite plus both Playwright projects) so a backend-only FULL failure can never leave browser-consumer evidence uncaptured; then settled ordinary push, exact-head GitHub CI, and native Perkins READY on the exact final published head. Prior per-lane findings/dispositions remain as recorded above; no new phase-approval checkpoint was invented.

- Continuation (2026-10-02, j-861/j-869/j-870 browser completion correction): the required `wizard-bmad-browser-consumer` gate at 81d3f10 was RED (run 48f31148, ledger 40053 — web unit 408/408 PASS, e2e 46/51) and is repaired in-lane from the complete preserved output and artifacts. (1) working-flavor `:145` empty phrase slice: the mock's `/__turn-hold` did not actually hold — the parking branch left the 45 ms tick interval running, so the next tick fell through to `finish()` and the busy state (and phrase) cleared before the 4 s rotation; the mock now clears the interval when parked, and reset settles a parked turn so it cannot leak into a cleared log (fixture-contract repair; spec text, oracles and geometry assertions unchanged). (2) reflow `.tool-line` hidden ×2: the clean-chat clause (4f4ebc8, its own unit-tested behavior; the first smoke test already taps the band) renders tool lines in a collapsed service band — the stress helper now expands the band before the visibility assertions and the reflow sweep, restoring the intended long-token measurements (test-side repair using the established idiom). (3) theme baselines: the four darwin snapshots predate approved main-side UI (last touched 2026-09-27, before the 2026-09-28 FOR YOU owner band, the owner chime, and the band-era board mock); regeneration is declared as its own scheduler scope `wizard-bmad-browser-snapshot-update` (explicit `--update-snapshots` on the two `dark toggle persists` tests), outputs reviewed and committed, then the acceptance scope re-runs; the existing 2% pixel allowance covers residual live churn (clock strings, mock job durations, fresh session ids). No assertion, tolerance, timeout, deadline or approved UX was changed; the prior FULL PASS (`e8f776b7` at 81d3f10) and the original browser RED receipt stay preserved and distinct.

## Spec Change Log

## Review Triage Log

## Verification

**Commands:**
- `POST /api/verify {job_id:"wizard-bmad-deterministic-retry-32", scope:"wizard-bmad-retry"}` -- focused regression (`npm run build && node tools/patch-vitest-rpc-timeout.mjs && npx vitest run` on `test/bmad-onboarding.test.ts`, `test/wizard-interactive.test.ts`, `test/wizard.test.ts`, `test/suite-shape.test.ts`); the build prefix is required because the CLI/pty legs execute `dist/`.
- `POST /api/verify {job_id:"wizard-bmad-deterministic-retry-32", scope:"typecheck"}` -- `npm run typecheck` (covers the added test code under `tsconfig.test.json`).
- `POST /api/verify {job_id:"wizard-bmad-deterministic-retry-32", scope:"full"}` -- `npm test` (lint + typecheck + build + vitest + web).
- `POST /api/verify {job_id:"wizard-bmad-deterministic-retry-32", scope:"wizard-bmad-browser-consumer"}` -- browser-consumer acceptance: `node tools/patch-vitest-rpc-timeout.mjs && npm run test:web && npm run e2e` (web compile + unit consumer suite, then the root build and both Playwright projects against the test-managed real service). Declared for the j-861 final-head gate because a backend-only `full` failure would otherwise leave the web consumer suite unexecuted.
- `POST /api/verify {job_id:"wizard-bmad-deterministic-retry-32", scope:"wizard-bmad-browser-snapshot-update"}` -- baseline regeneration for the two `themes` snapshot tests (`--update-snapshots`): writes the four tracked darwin PNGs deliberately; outputs are reviewed/committed, then `wizard-bmad-browser-consumer` re-runs as the acceptance gate.
- Exact-head GitHub CI on the pushed branch; native Perkins review READY required.

**Manual checks:**
- None: every acceptance leg is covered by the deterministic regression
  tests listed in Implementation Notes; no fixture touches a real config,
  a real BMAD install, or the network installer.

