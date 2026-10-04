---
title: 'Ship the minion-owned BMAD build-workflow playbook in installed role prompts'
type: 'feature'
created: '2026-10-02'
status: 'in-review'
route: 'dispatch'
baseline_commit: 6a00f4e50e7ae970915a9a534c142c1f8a45b57d
review_loop_iteration: 2
# Note (2026-10-03): native review rounds diff from current main
# (5d56194 at r1/r2 time); baseline_commit below is the pre-playbook
# comparison base, not the native review diff base.
context:
  - '{project-root}/AGENTS.md'
---

<!-- Approval record: the owner-settled intent lives in the dispatch briefing
     (job gc-packaged-build-playbook-20261002, goal/acceptance sections 1-7) and
     the operating ruling it carries. That briefing IS the human approval for
     this scope; the frozen block records it. Route rationale: shipped persona
     text with multi-surface regression needs the full three-layer review, so
     dispatch over oneshot despite the small footprint. -->

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The owner-settled implementation workflow — the implementing
minion runs the project's `bmad-build` skill end to end (spec, implementation,
its built-in review on fresh independent reviewer contexts, finding
resolution, verification, authorized ordinary PR), operations activates
native Perkins on the exact settled PR head, the owner merges — exists only
in local journal/memory. A clean gru-command install never receives it, so
other users' minions default to source-only handbacks and self-review.

**Approach:** Embed the playbook as coherent packaged role instructions —
one authoritative build-workflow section in the shipped `roles/minion.md`,
aligned sections in shipped `roles/silas.md` and `roles/gru.md` — and prove
delivery with deterministic regression tests that load the prompts from an
isolated installed-package layout (shipped artifact only, no developer
checkout, home paths, journal, or global custom instructions).

## Boundaries & Constraints

**Always:**
- The minion prompt explicitly selects the PROJECT's installed `bmad-build`
  skill for meaningful implementation work; the skill's own exclusions decide
  what is mechanical maintenance (no new competing rule). The minion owns the
  cycle end to end: built-in review on fresh independent reviewer contexts
  spawned through the product's supported runtime CLI headless mode
  (`pi -p` / `claude -p`), finding resolution, verification, authorized PR
  creation/update.
- Reviewers are fresh contexts — never implementer self-review, never a
  second Gru conversation. Missing spawn capability fails loud with the
  concrete gap; missing skill points to the official BMAD onboarding/install
  path (the wizard's project-local BMAD setup) and stops that implementation
  loudly.
- Silas/chief instructions match: briefings carry goal/boundaries/acceptance;
  capacity and expensive verification coordinate through the existing
  scheduler; native Perkins activates on the exact final settled PR head
  after existing prerequisites; NEEDS CHANGES returns to the implementing
  minion's authorized fix cycle; exact-final-head READY is required before
  the merge is presented to the owner (owner-held merge).
- Regression tests fail on the old prompt text and pass on the new; loading
  is proven from the shipped artifact and its normal prompt-loading path.
- Hygiene: no personal paths, home paths, provider accounts, local incident
  state, or owner identity in shipped artifacts (repo hygiene gate stays
  green).

**Never:**
- No new runtime/subsystem, role, or supplementary review stage duplicating
  bmad-build's built-in review; no bundling of a private generated skill
  snapshot; no ad hoc development replacing the missing skill; no weakening
  of existing tests, gates, pins, or owner-held merge/restart decisions.

</frozen-after-approval>

<!-- Amendment marker (2026-10-03): two frozen "Always" bullets are
     superseded by later owner clarifications, both recorded in the Spec
     Change Log below. (1) The bullet naming the runtime CLI headless
     print mode (`pi -p` / `claude -p`) as the reviewer-spawning mechanism
     is superseded by j-810/j-811: prescribed independent reviewers run as
     separately tracked review jobs. (2) The bullet requiring the literal
     project-installed `bmad-build` skill is superseded by j-761: the
     shipped contract selects the project's installed build-workflow skill
     by capability from the actual catalog/metadata. The frozen text is
     preserved unmodified; this marker records the supersessions inline
     for readers of the approval source. -->

## Code Map

- `roles/minion.md` -- shipped worker persona (loaded by `src/roles.ts`
  `loadRoleSystemPrompt` from `<pkg>/roles/`). Carries the authoritative
  build-workflow section: select the task-relevant BMAD skills from the
  PROJECT's actual installed catalog/metadata and follow their current
  workflows (never a fixed name/path/rename table). Already pinned phrases
  (ordinary non-draft PR order) must survive.
- `roles/silas.md` -- shipped ops persona. Carries the minion-owned cycle
  alignment section. Pinned phrases (integrity-pinned policy guard,
  never-merge, service-restart abort rule) must survive.
- `roles/gru.md` -- shipped chief persona. Resolve the stale wake bullet
  "Merges in this repository are yours only after the required gates" to the
  owner-held ruling (workflow-owned wording fix); keep pinned phrases
  "Perkins must be READY on the exact final head" and "Elsewhere the owner
  decides". gru.md is hygiene-pinned by `test/roles-gru.test.ts` (no `_bmad`,
  `\bpi\b`, `claude`, personal paths) — word accordingly.
- `src/roles.ts` -- ROLES_DIR = `<moddir>/../roles`; fail-loud load. No
  change needed; it is the normal prompt-loading path the tests prove.
- `src/dispatch/silas-driver.ts` (SKILLS_DIR `<moddir>/../../resources/silas-skills`)
  -- how the ops prompt's skills load from the shipped tree.
- `package.json` `files` -- `roles/` and `resources/silas-skills/` already
  shipped; assert both in the new regression test.
- `test/roles-definitions.test.ts` -- extend with pins for the new minion +
  silas clauses (src-loaded surface).
- `test/roles-gru.test.ts` -- update the wake-bullet pins to the resolved
  owner-held wording; keep the hygiene test.
- NEW `test/roles-installed-playbook.test.ts` -- builds a temp installed
  layout (package.json, full `dist/`, `roles/`, `resources/`, node_modules
  symlink to the repo's), imports `dist/roles.js` FROM the temp dir (normal
  loading path, no source import), asserts the capability-based playbook
  clauses on the worker and ops prompts, stages a representative
  renamed/replacement project skill catalog and asserts the contract is
  satisfiable without the old name, asserts fail-loud when `roles/` is
  removed, and asserts no personal/home paths in the loaded prompts.
- `scripts/hygiene-grep.sh` -- repo-wide personal-path gate; must stay green.
- `README.md` (Project-local BMAD setup) -- the official onboarding path the
  missing-skill rule points to. README IS shipped (package.json `files` and
  npm's default README inclusion); its version-scoped mention of
  `bmad-build` (`bmad-method@6.12.0`'s installed name) is deliberate and
  documents the pinned installer, while the fixed-name negatives apply to
  the persona/ops instruction surfaces.
- `docs/ROLES.md` -- persona map; one-row coherence touch (not shipped).

## Tasks & Acceptance

**Execution:**
- [x] `roles/minion.md` -- add a build-workflow playbook section (selection,
      ownership, fresh-reviewer rule, loud failures, PR ownership) -- the
      shipped worker instruction itself.
- [x] `roles/silas.md` -- add the minion-owned build cycle section (briefing
      shape, scheduler coordination, exact-final-head Perkins, no handbacks
      or duplicate review) -- ops alignment.
- [x] `roles/gru.md` -- resolve the merge-authority wake bullet to owner-held
      + exact-final-head READY, and note implementation briefings hand the
      worker the whole build cycle -- chief alignment.
- [x] `test/roles-definitions.test.ts` -- pin the new minion/silas/gru
      clauses -- deterministic regression on the src-loaded surface.
- [x] `test/roles-installed-playbook.test.ts` -- new installed-layout
      regression (isolated temp install, import shipped dist/roles.js,
      clause + fail-loud + hygiene assertions) -- proves delivery from the
      SHIPPED artifact.
- [x] `docs/ROLES.md` -- refresh the minion/silas map rows -- doc coherence.
- [x] j-761 correction: `roles/minion.md`, `roles/silas.md`, `roles/gru.md`,
      `resources/silas-skills/ops-dispatch/SKILL.md`, `docs/ROLES.md` --
      replace the literal `bmad-build` dependency with capability-based
      discovery/selection from the project's actual installed catalog and
      metadata; names/workflows may change between BMAD versions.
- [x] j-761 correction: `test/roles-definitions.test.ts`,
      `test/roles-gru.test.ts`, `test/silas-driver.test.ts`,
      `test/roles-installed-playbook.test.ts`,
      `test/perkins-whole-review.test.ts` -- pin the capability-based
      clauses, negative-pin the retired fixed-name dependency, and add the
      renamed/replacement catalog fixture at the installed-prompt seam.
- [x] j-810/j-811 correction: `roles/minion.md`, `roles/silas.md`,
      `roles/gru.md`, `resources/silas-skills/ops-dispatch/SKILL.md`,
      `docs/FLOW.md`, `docs/ROLES.md` -- the built-in review's fresh
      independent reviewer contexts are separately tracked review jobs
      the worker commissions through the service dispatch surface (own
      session and worktree); the retired raw headless-launcher
      (`pi -p` / `claude -p`) wording and the untracked
      subagent/extension bypass are forbidden, and the loud
      capability-gap stop stays. Tests negative-pin the retired wording
      at every loader surface.
- [x] r1-verdict directed follow-through: `test/pacing-admission.test.ts`
      (nested parent/reviewer admission at cap 1 and saturated default 4,
      limits preserved), `test/suite-shape.test.ts` pin; j-761 verified
      provenance recorded; failed FULL `c16457f6` fully inspected and
      whole-graded.
- [x] outcome-truth clarification (owner clarification 2026-10-02,
      consumed 2026-10-03): `roles/minion.md`, `roles/silas.md`,
      `roles/gru.md`, `resources/silas-skills/ops-dispatch/SKILL.md`,
      `docs/FLOW.md` -- a fulfilled call/HTTP 200/tool return/turn
      ending/receipt is not delivery; failed or unknown outcomes keep
      error evidence and a GC-owned repair obligation; delivered,
      terminal, and parked jobs are never reopened to compensate;
      artifact jobs complete at their artifact handback; current phase
      is distinct from historical delivery events; a failed attempt does
      not destroy the undertaking. Pins at the loader, installed-layout,
      staged-tarball, and raw gru seams.
- [x] baseline fixture repair: `.gru-command/worktree.toml` -- the
      packaged-playbook baseline `prep` path is anchored at "$root" so
      the build-log redirect lands after the `cd` into the snapshot
      (prior run aborted exit 99 at the redirect, before any build).
- [x] owner contract addendum (autonomous follow-through, 2026-10-02):
      `roles/minion.md`, `roles/silas.md`, `roles/gru.md`,
      `resources/silas-skills/ops-dispatch/SKILL.md`, `docs/FLOW.md` --
      continuous autonomous completion, the three-state reconciliation,
      bounded ops scan, restart-safe accepted actions, scheduler-owned
      one-shot verification, artifact-vs-PR completion, and the honest
      policy-vs-implemented statement; deterministic pins at the loader,
      installed-layout, and staged-tarball seams.
- [x] `.gru-command/worktree.toml` -- declare the lane's focused,
      installed-artifact, and fail-before baseline verification scopes (all
      via the authenticated `/api/verify` scheduler).

**Acceptance Criteria:**
- Given the temp installed layout built from the shipped files only, when
  `dist/roles.js` is imported from it, then the minion prompt directs
  discovery/selection of the task-relevant BMAD skills from the PROJECT's
  actual installed catalog/metadata and the selected workflow's fresh
  independent reviewer contexts (never self-review or a second Gru),
  verification and PR ownership, and the loud missing-skill stop; the
  silas prompt names goal/boundary/acceptance briefings,
  scheduler-coordinated verification, exact-final-head Perkins
  activation, and no per-phase approvals or duplicate supplementary review.
- Given a representative renamed/replacement project skill catalog, when
  the installed worker/ops prompts load, then the shipped contract
  contains no fixed skill-name dependency (the retired `bmad-build` string
  is absent) and the capability-based selection clauses match the catalog
  entry's task metadata under a different name.
- Given the same layout with `roles/` deleted, when `dist/roles.js` loads,
  then it throws naming the missing role file (fail-loud, no silent
  fallback).
- Given the pre-change tree (`git stash`-free check: `git show
  <base>:roles/minion.md`), the new pins' phrases are absent — tests fail
  before the change and pass after.
- Given the full suite, lint, typecheck, build, and the hygiene gate, all
  pass on the final head.

## Implementation Notes

- Runtime capability verified on this lane: `pi` CLI v0.99.1 on PATH,
  `pi -p --no-session` returns a fresh one-shot session (megaminion probe
  "MEGAMINION-OK"); `claude` is the product's other runtime binary
  (`src/runtime/claude-adapter.ts` default binary). Implementation runs
  directly in this lane (one-shot CLI subagents cannot be re-engaged for
  step-04 patches; the three review layers still run as fresh spawned
  contexts per the workflow).
- Additional surfaces beyond the original task list: the shipped ops skill
  `resources/silas-skills/ops-dispatch/SKILL.md` got the minion-owned-cycle
  amendment inside its completion mandate (what Silas actually follows),
  pinned positively in `test/silas-driver.test.ts` (loader surface) and in
  the staged-tarball assertions of `test/perkins-whole-review.test.ts`.
- Pre-change failure proof: every new pin phrase is absent from
  `git show 6a00f4e:` versions of all four shipped text files (verified by
  grep during implementation).
- Line-wrap hazard noted: raw `toContain` pins in `test/roles-gru.test.ts`
  must stay on one markdown line (bit twice during editing — fixed by
  rewrapping `roles/gru.md`, not by weakening pins).
- j-761 correction (owner clarification queued behind the previous actor's
  turn): the fixed-name dependency is superseded in the shipped prompts and
  their pins; the playbook now selects by the project's actual installed
  catalog/metadata. The lane declared `packaged-playbook`,
  `packaged-artifact`, and `packaged-playbook-baseline` scopes in
  `.gru-command/worktree.toml`; every product gate for this correction runs
  through the authenticated `/api/verify` scheduler with pre-opened sinks
  and complete NDJSON capture (the previous head's direct `npm test`
  invocations were a protocol violation; their failed/incomplete output is
  preserved as evidence, never re-run solely for logs).
- j-761 review loop 2 (fresh context-free layers: blind-hunter,
  edge-case-hunter, verification-gap — one provider timeout per failed
  layer was recorded, then each failed layer was re-launched as a fresh
  session and reported; artifacts under
  `_bmad-output/implementation-artifacts/review-loop2/`, loop-1 artifacts
  preserved beside them). All 13 findings triaged in the log above: one
  defer (pre-existing onboarding), one carried false (loop-1 row 4), one
  false, and ten patches applied — the renamed-catalog fixture now
  consumes a staged catalog and cross-checks installed names, the tarball
  smoke loads silas/gru through `ROLE_DEFINITIONS`, the baseline overlays
  the wake-prompt test and guards its build, and the focused scope checks
  `dist/` is the current build.
- 2026-10-02 continuation (owner proceed ruling): origin/main advanced
  from 6a00f4e to 059c076 (PR #69 worktree-fresh-base); a normal merge
  integrated it conflict-free (head f05d880) before the final gates, so
  verification, CI, and the native round all target one head. The 
  pre-playbook baseline for the fail-before scope stays pinned at
  6a00f4e (the honest old-behavior tree).
- Verification on the merged head f05d880 runs through the authenticated
  `/api/verify` scheduler with fresh exclusive sinks (labels 06+ under
  `_bmad-output/gate-prep/`): baseline (fail-before, expected RED) → full
  (required gate; rebuilds dist) → focused (post-build, declared scope).
  Prior receipts 01-05 remain preserved for their exact heads; the 04/05
  artifact attempts were typed never-started lock timeouts (retryable,
  never replayed blindly).

## Spec Change Log

- 2026-10-02 review loop 1 (trigger: verification-gap + blind-hunter
  findings on merge-authority adoption). Amended: the Silas-facing surfaces
  that still taught the superseded "Gru merges gru-command" rule —
  `src/dispatch/silas-driver.ts` wake header, ops-dispatch Authority bullet
  and completion step 5, `roles/gru.md` escalate/merge bullets,
  `docs/FLOW.md` (§4b, tier-2 mandate, routing table) — now state the
  owner-held-everywhere rule; `test/silas-driver.test.ts` and
  `test/roles-gru.test.ts` pins updated, negative pin added against the
  retired sentence. Known-bad state avoided: shipped ops instructions
  contradicting the changed chief prompt and the 2026-09-29 ruling on every
  wake, with a test pinning the stale wording. KEEP: the pinned phrase
  "fallback PASS is not that clearance" and the exact-final-head framing;
  the workflow-owned wording resolution only, no other safety rules
  touched.
- 2026-10-02 review loop 1 (trigger: blind-hunter fallback-gate finding).
  Amended: ops-dispatch amendment + `roles/silas.md` cycle section now
  state that the host-routed bmad-review fallback gate is the review gate
  of record when Perkins pre-flight fails (it is the gate, not a duplicate
  review). Known-bad state avoided: Silas reading the no-duplicate-review
  rule as overriding the host's fallback routing.

- 2026-10-02 clarification j-810/j-811 (trigger: the owner-settled
  delegation model — minions request independent workers THROUGH GC, not
  the Pi subagents extension or Claude Code built-in subagents; the
  hosted minion tool allowlist excludes the extension's subagent tool;
  installed skill discovery is not tool availability). Amended: the
  shipped minion/ops/chief playbook and the ops-dispatch skill now direct
  the selected workflow's review layers to fresh, context-free tracked
  review jobs the worker commissions through the service dispatch surface
  (each with its own session and worktree, a read-only brief, and the
  immutable diff head); an untracked one-shot launcher, an extension
  subagent, or a model-native child session is not a substitute, and the
  loud capability-gap stop stays. The package-contract regressions pin
  the tracked-job clauses and negative-pin the retired
  headless-print-mode wording. Known-bad state avoided: a shipped policy
  instructing workers to evade the role tool ceiling with an untracked
  launcher, or claiming a review that no tracked session can evidence.
  KEEP: minion-owned end-to-end completion, no per-phase approval, no
  source-only handback, loud missing-capability stop with the official
  onboarding path, exact-final-head Perkins, owner-held merge, and the
  native Perkins isolation/integrity pins (fail closed).
- 2026-10-02 baseline fixture repair (trigger: the declared
  `packaged-playbook-baseline` scope failed exit 99 because `prep` was
  assigned relative, then the script `cd`'d into the archived snapshot
  before redirecting the build log to `$prep/...`). Amended:
  `prep="$root/_bmad-output/gate-prep"`. The snapshot pointer, build
  guard, overlaid test files, and expected-RED intent are unchanged; the
  prior exit-99 receipt and snapshot remain preserved as evidence.

- 2026-10-03 final whole-diff review round (trigger: tracked review jobs
  `gc-playbook-final-review-{blind,edge,verifgap}-718249d`; verifgap clean,
  blind 14 + edge 3 findings triaged as rows 60-77). Patched:
  admission detection before the wait (pacing-view pre-check) and the
  loud stop; reviewer-brief head + diff base/range + read-only object
  access; findings-consumption duty; `Authorization: Bearer` guidance;
  cap-4 FIFO regression extended to two queued reviewers; baseline archive
  materialized and snapshot history appended; timeout scope runs both
  legs; targeted dirty-input guard in `assertDistCurrent`; canonical
  fallback terminology ("review gate of record for routing and fixes —
  never a Perkins READY"); README grammar and tarball pins;
  completion-order pins; spec/deferred traceability. The standing
  canonical-briefing disposition is unchanged.

- 2026-10-03 r1-verdict-directed follow-through (directive
  `gru-pr165-...` r1 bundle, consumed at the current head): (a) the
  admission-cycle blocker gained deterministic nested parent/reviewer
  regressions in `test/pacing-admission.test.ts` at the supported cap 1
  (the reviewer queues until the parent's turn settles — a synchronous
  wait would wait behind the parent's own lease, the condition the shipped
  contract stops on loudly) and at the saturated default 4 (no admission
  until a slot frees, then FIFO), with limits unchanged and no new
  subsystem/receipt/lease redesign; (b) the j-761 owner amendment now
  carries independently verified provenance (above) in this tracked
  record; (c) failed FULL `c16457f6` (b3a204a) was inspected in full
  (complete capture): lint/typecheck/build PASS, 3 genuine 30 s timeouts
  in untouched subprocess-heavy tests (`dispatch-server` by=silas,
  `install-one-line` foreign-unit, `perkins-builtin-wave` T4), web not
  reached; real causes are per-test ceilings under shared-host suite load,
  no in-lane repair is available without forbidden timeout/assertion
  changes, and the RED stays preserved/whole-graded, never waived by CI or
  host stories; (d) blocker 2 (canonical acceptance amendment) remains the
  owner/operations disposition required by r4 — the tracked amendment
  record is provided, and no fixed-name intent is restored.

- 2026-10-03 base-conflict continuation completed
  (`gru-pr165-base-conflict-20261003-once`): integrated `9bb51b0`, repaired
  the integrated-review findings, pushed `ad98f1a` (CI green), requested
  native r4 (prior fallback blocker fixed/accepted; only the carried
  canonical-briefing disposition remains). Failed FULLs `51`/`55` and
  earlier are preserved; the `ad98f1a` baseline attempts never started and
  are preserved as such.

- 2026-10-03 base-conflict continuation (amendment
  `gru-pr165-base-conflict-20261003-once`): origin/main advanced to
  `9bb51b0` (PR #136 durable-blocked-followthrough merged; PR #149
  earlier), making PR #165 DIRTY on the then-head `7a7702a`.
  History-preserving merge integrated origin/main at `27576fb`; the only
  conflict was `_bmad-output/implementation-artifacts/deferred-work.md`
  (both sides' entries kept). `docs/FLOW.md` policy-vs-implemented
  updated truthfully: PR #136 is now merged (durable directives,
  request-id idempotency, marked phase handoffs, per-turn terminal
  outcome validation in `src/runtime/prompt-verdict.ts`, boot
  reconciliation); the remaining open gaps stay named
  (#159/#160/#162/#163 — `stalledWorking` still keys on historical
  delivery) and no runtime guarantee is claimed. All prior controls and
  amendments preserved; the continuous-completion and outcome-truth
  contract remains shipped. Failed FULLs `c16457f6` (b3a204a) and the
  earlier failures/capture gaps remain preserved.

- 2026-10-03 outcome-truth clarification (owner clarification
  2026-10-02, delivery-truth; supersedes any reading that would reopen
  genuinely delivered jobs). Amended: `roles/minion.md`,
  `roles/silas.md`, `roles/gru.md`,
  `resources/silas-skills/ops-dispatch/SKILL.md`, `docs/FLOW.md` — a
  fulfilled call, HTTP 200, tool return, turn ending, or receipt is not
  delivery; failed/unknown outcomes keep their error evidence and a
  GC-owned repair/retry obligation; genuinely delivered, terminal, and
  parked jobs are never reopened to compensate; current phase is distinct
  from historical delivery events; a failed attempt does not destroy the
  undertaking. Policy vs implemented extended with the outcome/phase
  state: `durable-blocked-followthrough` / PR #136 carries the durable
  directive/phase machinery but its native r4 verdict is NEEDS CHANGES
  at the inspected head (resolve-but-error turns, unmarked crash
  windows, reconciler starvation); `/api/verify` admission/re-arm (#159)
  is missing; no parallel outcome system is authorized. KEEP: continuous
  completion, worker/owner boundaries, exact-head gates, no caps.

- 2026-10-03 native round 3 fix (trigger: Perkins round
  `gc-packaged-build-playbook-20261002-r3` NEEDS CHANGES on 60cfbd8 — 1
  carried canonical-briefing blocker + 1 new fallback-merge blocker).
  Amended: the contract-review reconciliation is corrected — a fallback
  gate PASS clears review/fix routing only and never substitutes for the
  exact-final-head Perkins READY required before a merge is presented;
  the missing Perkins gate is escalated instead. README, `docs/FLOW.md`,
  the ops skill, and the loader/tarball pins aligned. The carried blocker
  is an owner/operations disposition (canonical acceptance amendment via
  a supported audited ingress) — held, not bypassed. KEEP: fallback
  review/fix routing, owner-held merges, no agent merge, all gates.

- 2026-10-03 owner contract addendum (autonomous follow-through; owner
  ruling 2026-10-02, j-869/j-878/j-879): approved heists advance without a
  continue prompt — every nonterminal job resolves to active owned work,
  an internal wait with a re-arm trigger, or a precise needs-owner
  question; routine failures/review feedback/in-policy recovery/lost
  workers/capacity waits/gate handoffs are GC-owned; ops reconciliation is
  bounded and independent of long worker turns; accepted actions are
  restart-reconciled (idempotency, head/generation binding, single-writer
  fences); verification is scheduler-owned one-shot with honest terminal
  states; progress is not a heartbeat/open turn/API 200/delivered
  prompt/old-head CI; artifact-only and investigation jobs complete by
  verified artifact handback. Amended surfaces: `roles/minion.md`
  (continuous-completion rule, artifact-vs-PR completion, no-caps,
  accepted-action reconciliation for its own dispatched reviewers),
  `roles/silas.md` + `resources/silas-skills/ops-dispatch/SKILL.md`
  (the three-state reconciliation, bounded scan, restart-safe records,
  one-shot verification, progress-vs-live), `roles/gru.md` (no continue
  ceremony; precise owner questions only), `docs/FLOW.md` §4f (contract +
  honest policy-vs-implemented pointers); pins at
  the loader, installed-layout, and staged-tarball seams. Known-bad state
  avoided: shipped instructions that stall approved work pending a
  "continue", chase a product PR for artifact jobs, treat liveness as
  progress, or imply runtime enforcement exists. KEEP: no arbitrary
  minion task-duration/tool-call caps; safety, single-writer, review,
  owner-stop and exact-head gates; owner-held merge/restart; and the
  original BMAD build instructions and workflow stages. Policy vs
  implemented is stated honestly in `docs/FLOW.md` §4f:
  restart-durable acceptance records, cadence/next-action board truth,
  deliverable-kind carve-outs, and current-phase delivery are NOT
  implemented runtime guarantees (tracked as separate code work; no
  product runtime change was made here).

- 2026-10-03 native round 1 fix cycle (trigger: Perkins round
  `gc-packaged-build-playbook-20261002-r1` NEEDS CHANGES — 2 blockers on
  the b3a204a diff, posted to PR #165). Amended: (1) `roles/minion.md`
  names the nested worker-budget admission constraint on reviewer-job
  dispatch and requires a loud stop — no blocking wait, no blind retry,
  no untracked substitute, no limit bypass — with `roles/silas.md` and
  the ops-dispatch skill treating a reported nested-admission capability
  gap as a scheduling gate under the configured worker limits; (2) the
  build-workflow paragraph now explicitly selects the project's installed
  build-workflow skill by capability, and the j-761 owner amendment
  (quoted below) is provided to the next frozen review as a committed
  lane record — this file. Known-bad state avoided: a shipped instruction
  that can deadlock a lane at pacing cap 1 / saturated residency, and a
  name-free selection contract a reviewer cannot trace to an approved
  amendment. The job briefing is the review's spec source and has no
  worker-writable surface; if the next round requires the briefing itself
  to carry the amendment, that is an operations/owner action. KEEP:
  capability-based selection, minion-owned completion, tracked GC
  reviewers, exact-final-head Perkins, owner-held merge, and the
  configured worker limits unchanged (no new subsystem, no limit change —
  the reviewer's admitted alternative).

- 2026-10-02 clarification j-761 (trigger: owner correction superseding the
  literal bmad-build dependency in the original briefing). Provenance
  independently re-verified 2026-10-03: journal seq 761, ts
  2026-10-02T09:23:40.605Z, source gru; the verified ruling JSON is
  preserved in the silas-sweep-20261003T013313Z investigation bundle
  (`pr165-r1-verdict-repair/verified-owner-amendment-j761.json`). Owner ruling,
  verbatim: "GC must use relevant BMAD skills to achieve tasks, not
  hard-code bmad-build because BMAD renames skills. Supersedes literal
  skill-name requirements in j742/j745 and the active packaged-playbook
  briefing; preserves the task-relevant BMAD workflow ... Shipped
  instructions must select from installed project skill metadata/catalog
  and follow current instructions, not a fixed entry point/alias list or a
  universal implementation workflow for all tasks." Amended: the playbook
  explicitly selects the project's installed build-workflow skill by
  capability from the PROJECT's actual installed skill catalog/metadata,
  and follows its current workflow; never a fixed skill name, a single
  workflow, a remembered path, or a hand-maintained rename/alias table.
  Amended surfaces: `roles/minion.md`, `roles/silas.md`, `roles/gru.md`,
  `resources/silas-skills/ops-dispatch/SKILL.md`, `docs/ROLES.md`; the
  installed-layout and staged-tarball regressions now pin the
  capability-based clauses, negative-pin a fixed-name dependency, and
  stage a representative renamed/replacement catalog fixture at the
  installed-prompt seam. Known-bad state avoided: a shipped policy that
  breaks the moment BMAD renames or replaces its implementation skill, or
  reads as a licence for ad hoc development under a guessed name. KEEP:
  minion-owned end-to-end completion (no per-phase approval, no
  source-only handback, no invented call/turn/time caps), fresh independent
  reviewer contexts as tracked review jobs, the loud missing-capability
  stop with the official onboarding path, exact-final-head Perkins,
  owner-held merge.

## Review Triage Log

| # | Layer | Verdict | Evidence / disposition |
|---|-------|---------|------------------------|
| 1 | blind | medium | docs/FLOW.md §4b still teaches Gru-merges-gru-command (garbled "elsewhere everywhere"); contradicts the rule this change installs → patch (G1) |
| 2 | blind | low | gru.md residual "elsewhere" framing + escalate bullet example "merges elsewhere" — incomplete under owner-held-everywhere → patch (G1) |
| 3 | blind | low | no-duplicate-review rule vs host-routed bmad-review fallback gate ambiguity → patch (G2) |
| 4 | blind | false | "runtime-agnostic violation": product ships exactly two runtime adapters (`src/config.ts` RUNTIME_IDS `['pi','claude-code']`); the parenthetical names the product's actual binaries and the general rule is carried by "the installed runtime CLI's headless print mode" |
| 5a | blind | low | docs/ROLES.md Silas row run-on after insertion → patch (G3) |
| 5b | blind | low, rejected | "ROLES.md map unpinned": docs are not shipped and not pinned by repo convention; a pin would be new machinery for a cosmetic map |
| 6 | blind | low | truncated staged-ops matcher `native Perkins round on the` → patch (G3, extended to the full tail) |
| 7 | blind | low | installed-layout test hand-stages + symlinks node_modules ("leans on checkout" overclaim in comment); deriving from npm pack rejected — the real tarball path is already covered by perkins-whole-review pack test and duplicating a minutes-long pack in a unit test harms the suite → patch (G3, comment precision only) |
| 8a | blind | low | three stagings + probes per run → patch (G3, stage once in beforeAll) |
| 8b | blind | low, rejected | "overlapping pins" tarball vs installed-layout: intentional layered regression — package contents and installed-layout loading are distinct acceptance surfaces |
| 9 | blind | low | no negative assertion guards the retired behavior → patch (G1, negative pin) |
| 10 | edge | low | probe output shape unvalidated; opaque failure mode → patch (G3, shape guard) |
| 11 | edge | false | "no stated close-out for non-PR briefings": non-PR close-out is governed by the existing Closing out section and the ledger-closeout skill, unchanged by this diff; no reachable bad outcome shown |
| 12 | edge | false | same refutation for ops-dispatch step 2; the completion mandate already presumes PR lanes, others follow close-out rules |
| 13 | verif-gap | high (pre-verified) | merge-authority rule adopted in gru.md/silas.md but NOT at sibling Silas surfaces: wake header (`silas-driver.ts`), ops Authority bullet, ops completion step 5 — and `test/silas-driver.test.ts` pins the stale sentence verbatim; every wake ships the superseded rule → patch (G1) |
| 14 | verif-gap | low | gru.md escalate bullet — same root cause as 2 → G1 |
| 15 | verif-gap | low | docs/FLOW.md tier-2 mandate + routing table stale — same root cause as 1 → G1 |
| 16 | verif-gap | low | ops-dispatch internal Authority/step-5 vs 2026-09-29 section contradiction — same root cause as 13 → G1 |
| 17 | blind | low, deferred | `src/wizard/bmad-onboarding.ts` still validates the pinned installer's `bmad-build` names — verified present; pre-existing, version-pinned onboarding integration the intent keeps authoritative (original acceptance 7; spec Code Map), not caused by this change. A future renamed BMAD release is a versioned onboarding update → defer |
| 18 | blind | low | `docs/FLOW.md` had no minion-owned-cycle section; verified absent → patch (added §4e) |
| 19 | blind | low | `docs/ROLES.md` Gru row "dispatch, verify" read against gru.md's no-re-review rule; verified → patch (row wording: "gate the sequence") |
| 20 | blind | low | `roles/silas.md` 10-02 cycle section sat between the two 09-29 sections; verified (lines 108/131) → patch (moved below the merge-authority section) |
| 21 | blind | medium | renamed-catalog fixture was inert — nothing consumed it and the prompt assertions duplicated the previous test; verified against the file → patch with 23/24 (fixture-derived catalog selection probe + installed-name/skill-token cross-checks) |
| 22 | blind | low | tarball smoke loaded only the minion prompt through `ROLE_DEFINITIONS`; verified → patch (silas + gru prompts now checked through the same compiled loading path) |
| 23 | edge | medium (claim, confidence high) | AC2 falsified: a fixed dependency on the renamed entry would stay green — same root cause as 21 → patch (grouped) |
| 24 | verif-gap | high (pre-verified) | Broken-verification gap: no assertion tied product output to the renamed-catalog scenario; demo (fixed-name dependency under the renamed skill lands undetected) verified → patch (grouped with 21) |
| 25 | blind | low | baseline scope omitted the wake-prompt surface (`src/dispatch/silas-driver.ts` + `test/silas-driver.test.ts`) changed in this delta; verified → patch (overlay + run `silas-driver.test.ts` in the RED baseline) |
| 26 | blind | false, carried | runtime-agnostic violation — same location and claim as row 4, text unchanged; still false (product ships exactly two adapters; general rule carried by "the installed runtime CLI's headless print mode") |
| 27 | blind | false | standing-order-2 ambiguity: the playbook itself owns finding resolution and the NEEDS CHANGES fix cycle; no contradiction or reachable bad outcome shown |
| 28 | edge | low | baseline `npm run build` failure under `set -e` would be indistinguishable from the expected test RED; verified → patch (explicit build guard: distinct exit 99 + message) |
| 29 | edge | medium | focused scope could green over a stale `dist/` — verified: `dist/build-rev.json` was c8ad6c0 while the gate bound eeb9e89; compiled sources identical in this delta, but the gate-integrity gap is real → patch (`assertDistCurrent` in the installed-layout regression) |
| 30 | blind | low | `README.md:167` + `scripts/rehearsal-bmad-onboarding.mjs:66` still taught Perkins "autonomous-merge authority" while this change ships owner-held merges (README is a package file) → patch (owner-held wording) |
| 31 | blind | low | ops-dispatch completion step 5 ordered the push after the native gate, but FLOW §4 freezes the PR's live head and aborts on a moved head — the written order would obsolete the gated head → patch (push → CI → gate; never move the head after the gate) |
| 32 | blind, edge | low | baseline setup legs (`git archive`→`tar`, `cp`, `ln -s`) exited a generic nonzero indistinguishable from the expected test RED (tar on empty stdin can exit 0) → patch (setup guard: exit 3 + message; snapshot pointer records the lane head too) |
| 33 | blind, edge | low | the three new scopes omitted the approved worker-RPC patch `npm test` applies via pretest, so a harness-level nonzero could masquerade as expected RED → patch (patch prerequisite first in all three scopes) |
| 34 | blind | false | renamed-catalog probe "is the test's own algorithm, not the product": no shipped selection code exists — selection is prompt-level by design and the intent forbids a new runtime; the deterministic metadata selector plus name-absence pins are the available fail-before oracle → false |
| 35 | blind | low, rejected | `assertDistCurrent` binds only `dist/` while roles/resources stage from the working tree; the gated paths (scheduler, CI) always run committed-clean trees, and binding text files adds staging machinery beyond a direct correction → reject |
| 36 | blind | low, deferred | no staged `loadSilasSkills()` probe from an installed/tarball layout; file presence and loader resolution are separately covered and the loader path is unchanged by this change → defer (deferred-work.md) |
| 37 | blind | low | packed-files expectation omitted `roles/bob.md` though the smoke loads `ROLE_DEFINITIONS` (all five persona files) → patch |
| 38 | blind | medium | the shipped worker prompt carried no verification-scheduler reference, so its verification duty read as licence for competing full suites against the one global budget → patch (scheduler clause + pin) |
| 39 | blind | low | reviewer-commissioning wording did not name the mechanism; the tracked review jobs come from the job-dispatch surface (`POST /api/dispatch`, the PR135/j-810 precedent), not the Perkins review wave → patch (name the dispatch path in the minion prompt) |
| 40 | verif-gap | high (pre-verified) | ops-skill merge-authority rewrite had no pin: reverting the Authority bullet or step 5 left every suite green → patch (positive + negative pins at the loader and staged-tarball seams) |
| 41 | verif-gap, edge | medium (pre-verified) | shipped ops skill still said "the chief rules, merges…" (:57) and kept merges in the chief's judgment list (:31; `roles/silas.md:63`; FLOW :535), three lines from its own owner-held bullet → patch (owner-held wording everywhere) |
| 42 | verif-gap | medium (pre-verified) | `assertDistCurrent`'s bare catch treated any git failure as "no checkout", letting a broken guard read as pass → patch (fail loud when `.git` exists and HEAD cannot resolve) |
| 43 | blind | medium | Fallback-gate merge wording read as contradictory across README/FLOW/ops ("clear to merge" vs "never authorizes a merge" vs "review gate of record") → patch (every surface now: routed-there fallback is the review of record, its PASS is never Perkins READY, the owner holds the merge) |
| 44 | blind | medium | Worker prompt still said "merging belongs to the review verdict"; silas said "approved merges" — both implied verdict→merge → patch (review is the gate; the owner takes every merge decision) + positive/negative pins |
| 45 | blind | low | Reviewer dispatch not reachable from the shipped worker surface (no auth/base guidance) → patch (authenticated local API; token from the service config; never echo it) |
| 46 | blind | medium | An accepted dispatch can still admit after a reported nested-admission gap, and the worker had no reconciliation rule → duplicate-reviewer risk → patch (a submitted dispatch is an accepted action; reconcile by job identity before re-commissioning) |
| 47 | blind | low | Reviewer briefs must bind the immutable head through the brief itself (dispatch branches from the origin default) → patch (the brief names the exact head SHA) |
| 48 | blind, edge | low | Frozen spec block still prescribes the headless launcher with no inline supersession marker → patch (amendment marker placed outside the frozen block; frozen text untouched) |
| 49 | blind, edge | medium | Baseline expected-RED was exit-code-only: a GREEN baseline would be recorded as scope success; the overlay claim was broader than the four overlaid files → patch (GREEN exits 4; overlay claim narrowed to the four files; the staged-tarball oracle is covered by the artifact scope + pre-change phrase-absence). The stricter JSON `numFailedTests>0` identity check was rejected (runner change; identity is read from the complete capture) |
| 50 | blind | low | "Tracked as separate code work" had no pointers → patch (docs/FLOW §4f cites issues #160/#162/#163) |
| 51 | blind | false, carried | renamed-catalog selector "not tied to a shipped path" — same class as row 34; no shipped selector exists, selection is prompt-level by design, and the intent forbids a new runtime → false (carried) |
| 52 | blind | low | cross-surface wording drift (`substantive` vs `real repair`) → patch (aligned wording); no cross-surface meta-pin (redundant machinery) |
| 53 | blind | low | "internal wait … its owner" overloaded owner with the human sense → patch ("its owning job or agent") |
| 54 | blind | low | spec metadata stale for the native rounds → patch (frontmatter provenance note; baseline_commit/iteration fields preserved for the bmad workflow) |
| 55 | blind | low | README onboarding sentence named `bmad-build` unversioned while the playbook forbids fixed names → patch (version-scoped: the build-workflow skill this pinned release provides) |
| 56 | edge | low | tilde-path (`~/`) home-relative paths not negative-pinned at the installed seam → patch (`not.toContain('~/')`) |
| 57 | verif-gap | clean | No verification gaps found (whole diff read, receipt verified) |
| 58 | native r3 | blocker (carried 0, owner/ops) | Frozen Acceptance 1 still names the retired literal while the shipped contract selects by capability; the runtime freezes `job.briefing`, not the committed amendment record (`src/dispatch/perkins.ts:2041`) → **owner/operations disposition**: freeze the approved j-761 amendment into the canonical acceptance through a supported audited ingress, then re-review. Not resolvable in-lane; no gate/spec weakening or DB repair |
| 59 | native r3 | blocker (new) | The contract-review patch (row 43) over-reconciled the fallback gate: it permitted presenting a merge after a fallback PASS, contradicting Acceptance 4 (`roles/gru.md` READY rule + wake header). → patch: fallback PASS clears review/fix routing only; the missing Perkins gate is escalated, never substituted; README/FLOW/ops + loader and tarball pins aligned |
| 60 | blind | medium | Nested-admission rule not executable as written: no detection before waiting → patch: the worker prompt now names the service pacing view (board snapshot) as the pre-dispatch check and keeps the loud stop; the saturation view is asserted in the regressions |
| 61 | blind | low | Cap-4 regression queued only one reviewer (FIFO unexercised) → patch: two reviewers queued; head-waiter order and second admission asserted |
| 62 | blind | medium | Reviewer brief named only the head; no diff base/range or object-access instructions (dispatch branches from origin default) → patch: the brief must carry the head SHA plus the diff base/range (or a frozen diff) and read-only object access |
| 63 | blind | medium | No return path for a commissioned review's findings → patch: a review is complete only when its delivered findings are collected (report/session) and resolved through the fix cycle; reconcile the terminal state before re-commissioning |
| 64 | blind | low | Worker API guidance incomplete (no auth header/config surface) → patch: read the `[auth]` token from the instance config, send `Authorization: Bearer`, never echo or copy it |
| 65 | blind | low | Renamed-catalog test claim overbroad (a non-`bmad-` hardcode would pass) → patch: claim narrowed to name-absence plus the metadata-selection clauses (prose, not a runtime selector) |
| 66 | blind | low | `assertDistCurrent` ignored dirty staged inputs at the same HEAD → patch: targeted dirty check on `roles`/`resources`/`package.json` (supersedes the low dispositions in rows 35/51) |
| 67 | blind | low | Baseline pointer overwrote each run vs the "never deleted" comment → patch: `packaged-playbook-baseline.snapshots.log` appends history; latest pointer preserved |
| 68 | blind | low | `git archive | tar` could mask a failed archive leg → patch: archive materialized (`-o`) and extraction checked (completes row 49's guard) |
| 69 | blind | low | Fallback terminology split across surfaces ("FULL GATE semantics" vs "routing of record") → patch: canonical "review gate of record for routing and fixes — never a Perkins READY" across ops/silas/FLOW/README |
| 70 | blind | low | README grammar + no README/FLOW fallback pin → patch: "0 blockers clear..."; tarball README pins the corrected sentence and negative-pins the retired phrase |
| 71 | blind | low | Corrected ops completion order unpinned → patch: "let exact-head CI land" / "never move the head after the gate" pins added |
| 72 | blind | low, rejected | Worker `bmad-*` blanket negative vs ops review-token allowlist asymmetry: intentional (j-761 forbids the fixed build name on the worker; review tokens are ops-only). `claude -p` negative added to the tarball smoke |
| 73 | blind | low, deferred | `clear_to_merge` wire-field name debt → deferred (rename is a wire break; semantics documented and the owner-held marker pinned) |
| 74 | blind | low | Spec verification pointer/frontmatter/deferred traceability stale → patch: status in-review; deferred entries carry heads; receipt summary completed at close |
| 75 | edge | low | Timeout scope skipped the second leg when the first failed → patch: both legs run and both rc values are reported |
| 76 | edge | false, carried | Tasks text "full bmad-build cycle" vs name-free shipped prompts: the task wording is amended and the substance is the standing Acceptance-1 disposition (rows 58/previous) — owner/ops action |
| 77 | edge | low | Owner-held positive pins pass pre-change → patch: fail-before provenance clarified in the test comment (the negative pins carry the fail-before evidence) |
| 78 | native r5 | blocker (new) | Reviewer-commissioning precheck claimed the board pacing view covers the worker budget; pacing (turn pools) and the resident-session ceiling (default 4) are separate constraints — four busy parents pass the precheck and wait on reviewer POSTs while preventing their own admission (`roles/minion.md:103-110`) → patch: both constraints named; resident admission must be established (finish the turn with the review commission as its explicit next action, or stop loudly); submitted-dispatch reconciliation bounded by job identity; deterministic regression through DispatchService + real RuntimeRegistry at unlimited pacing/saturated residency + source/installed prompt pins |
| 79 | native r5 | warning | `packaged-playbook-timeouts` returned PASS after the RPC patch prerequisite failed (`; rc1=0` shape) → patch: patch guarded with a distinct setup-failure exit (3), never a masked test result |
| 80 | native r5 | warning | Baseline build log written to a truncating shared path outside the snapshot directory → patch: per-attempt log inside the unique snapshot dir; the pointer records the log path |
| 81 | native r5 | note (verification limits) | The timeout diagnostic inherited the heavy config's 120s ceiling, replacing the original 30s isolation claim → patch: explicit `--testTimeout=30000 --hookTimeout=30000` overrides pin the original budgets; comment states the config/override split truthfully |
| 82 | native r5 | prior fixed | Canonical-briefing acceptance conflict: the amended `job.briefing` supplies the j-761 owner amendment and the shipped capability contract; reviewer confirms resolved by the amendment, not a repository note |
| 83 | native r5 | publication | Report not posted — ambiguous app publication; manual review-list verification confirms no r5 publication (0 after r4); conservative non-retry per the publication-recovery contract; report preserved locally, no fabricated verdict comment |


### Final-review cycle (2026-10-02, continuation)

Fresh independent tracked review jobs (GC job dispatch, own sessions and
worktrees, read-only briefs at immutable head 96923a7): blind-hunter
`gc-playbook-review-blind-96923a7`, edge-case-hunter
`gc-playbook-review-edge-96923a7`, verification-gap
`gc-playbook-review-verifgap-96923a7` — all delivered (`job.delivered`),
reports preserved under `review-final/` with the staged packet
(`gc-playbook-final-96923a7.diff`, sha256 25ed13cc…). All findings
triaged above (30-42); patches applied without loopback (no intent_gap or
bad_spec).

- 2026-10-03 native handoff and main drift: the exact-head PR (165,
  b3a204a) passed CI (run 37076820082: 1782 passed / 9 skipped) and the
  native Perkins round `gc-packaged-build-playbook-20261002-r1` was
  requested (`by: minion`, 202 accepted, seven lenses) and went live on
  b3a204a. While that round ran, origin/main advanced to `5d56194`
  (PR #149 finding-dedupe-recency) and the PR went conflict-dirty; a
  history-preserving merge of origin/main was prepared locally at
  `5c428d8` (one conflict in `.gru-command/worktree.toml`, resolved by
  keeping both scope sets) and held UNPUSHED so the live round's frozen
  target is not moved underneath it. After the round settles: apply its
  fix cycle if any, re-run the applicable scopes on the new head, push
  non-force, and request the fresh exact-head native round.

### Native Perkins loop (2026-10-03)

- Round `gc-packaged-build-playbook-20261002-r1` frozen at target
  `b3a204a` (base `5d56194`; diff base `b900837`), seven lenses; verdict
  **NEEDS CHANGES** — 2 blockers, posted to PR #165:
  1. *Reviewer commissioning can deadlock at supported admission limits*
     (`roles/minion.md:55-66`): `/api/dispatch` awaits admission while the
     parent lane holds its worker slot; at pacing cap 1 or saturated
     residency the parent can wait behind the slot it needs. Disposition:
     the shipped prompt now states the nested-admission constraint and
     requires a loud stop (no blocking wait, no blind retry, no untracked
     substitute, no limit bypass); ops surfaces treat a reported gap as a
     scheduling gate under the configured limits. No runtime/subsystem
     change and no limit change — the reviewer's admitted alternative.
  2. *Skill-selection contract contradicts frozen Acceptance 1*
     (`roles/minion.md:38-47`): the frozen briefing names `bmad-build`
     while j-761 authorizes capability-based selection, and the amendment
     was not in the review's spec source (the job briefing). Disposition:
     the prompt now explicitly selects the project's installed
     build-workflow skill by capability, and the j-761 owner amendment is
     quoted and committed in this lane record for the next frozen review;
     the job briefing has no worker-writable surface, so a briefing-level
     amendment would be an operations/owner action.
- Prior-findings handling on the next round must adjudicate these two
  blockers against the fixed head; a fresh exact-head round is requested
  after the re-verification of the fix commits.

- Round `gc-packaged-build-playbook-20261002-r2` frozen at target
  `ff2f49d` (base `5d56194`; diff base `5d56194`), seven lenses; verdict
  **NEEDS CHANGES** — 1 blocker + 2 warnings, posted to PR #165:
  - Prior finding 1 (nested admission) **fixed/accepted**: the reviewer
    confirms the prompt-level fail-loud alternative, the ops scheduling
    wording, and the new pins; no nonblocking-dispatch implementation is
    claimed.
  - Prior finding 0 **carried**: the canonical briefing supplied to the
    round still contains the original `bmad-build` acceptance while the
    shipped contract selects by capability. The reviewer's resolution:
    "Freeze the actual owner-approved amendment into the canonical
    briefing/acceptance and re-review against that consistent contract."
    This is an operations/owner action: the review's spec source is
    `job.briefing` (`src/dispatch/perkins.ts:2041`) and no worker or ops
    HTTP surface can amend it (`LedgerApi.setJobBriefing` has no caller),
    so the worker cannot resolve it in-lane. Surface to the chief/ops with
    pointers; do not request another round until the amendment is frozen.
  - Warning 1 (onboarding pointer) **patched**: `roles/minion.md` now
    names the setup wizard's project-local BMAD install step and the
    README's "Project-local BMAD setup" section; pins added at the worker,
    installed-layout, and staged-tarball seams.
  - Warning 2 (baseline setup exit) **patched**: `.gru-command/worktree.toml`
    defines `setup_fail` first and guards every setup step (mkdir, RPC
    patch, mktemp, archive/extract, overlay, link, head, pointer write,
    cd) with the distinct exit 3, so a setup failure can never read as the
    expected test RED.
- Verification incident (2026-10-03T04:14-04:28): the 6c91ee0 baseline
  request `0edde2bf-b757-4709-a61c-de2de2c46d3a` was submitted with
  exclusive sinks, but the local client was killed by a bash-tool default
  timeout 60 s later, leaving a 99-byte partial capture (one queued
  frame). The request had been accepted; it was granted at 04:28:19 and
  settled server-side in 22.2 s with `ok=false, exit_code=1`,
  `output_bytes=70422`, `output_sha256=40eed742...`, and a tail showing
  `Test Files 4 failed (4); Tests 8 failed | 46 passed (54)` — the same
  genuine fail-before RED through the new guarded setup path. Disposition:
  partial capture and ledger-complete outcome preserved; no blind replay
  (a rerun solely to recover lost output is forbidden). Lesson applied:
  scheduler client calls always carry a generous explicit timeout.

- Round `gc-packaged-build-playbook-20261002-r3` frozen at target
  `60cfbd8` (base `5d56194`), seven lenses; verdict **NEEDS CHANGES** —
  prior findings 1 and 2 fixed, one new blocker plus one carried:
  - New: the contract-review fallback reconciliation let a fallback PASS
    stand in for the READY merge-presentation gate. Fixed in `8ed3bd6`:
    fallback PASS clears review/fix routing only; its PASS is not Perkins
    READY and the missing Perkins gate is escalated, never substituted
    (README/FLOW/ops/pins aligned; row 59).
  - Carried: the canonical-briefing acceptance amendment (owner/ops
    disposition; the briefing remains unamended as of the base-conflict
    continuation). Held, not bypassed; no r4 is requested until it lands.

- Round `gc-packaged-build-playbook-20261002-r4` frozen at target
  `ad98f1a` (base `9bb51b0`), seven lenses; verdict **NEEDS CHANGES** —
  **prior 0 fixed/accepted** (fallback PASS no longer bypasses the
  READY merge-presentation gate; README/FLOW/ops/wake header agree and
  the runtime reporting surfaces were aligned), **prior 1 carried only**:
  the canonical briefing still supplies the original `bmad-build`
  acceptance while the shipped contract selects by capability. The
  reviewer's required action: "Owner/operations must freeze the actual
  approved amendment into the canonical briefing/acceptance through an
  audited ingress, then request review against the consistent contract.
  A repository note alone does not resolve this blocker." No additional
  findings; the tests specialist timed out and is not counted as
  coverage.
- The lane is therefore complete on all in-lane axes and blocked solely
  on that owner/operations disposition; no r5 is requested while the
  briefing remains unamended. The post-integration independent review
  (`gc-playbook-integrated-review-{blind,edge,verifgap}-810f471`) findings
  were repaired in `ad98f1a`; head gates and receipt identities are bound
  in the completion handoff.

### Owner/ops disposition executed + r5 (2026-10-04)

- Canonical-briefing amendment executed through the audited ingress:
  `LedgerApi.setJobBriefing` updated `job.briefing` (7253 → 9400 bytes;
  audit event `job.briefing` seq 44020, 17:29:25.792Z) appending the
  j-761 owner amendment (provenance: journal seq 761,
  2026-10-02T09:23:40.605Z, source gru; verified ruling JSON preserved
  in the silas-sweep bundle). The frozen dispatch-time record
  (`briefings/.../briefing.md`) is preserved unmodified; the amended
  mirror and amendment record sit beside it. No raw SQL, no worker/ops
  HTTP surface existed for this (r2 verification).
- Base re-integration: origin/main advanced to `962a41b` (PRs #192/#193/
  #194); history-preserving merge `3fbfbf1` resolved conflicts
  keep-both (worktree.toml scopes — phase-split aligned for the j-829
  heavy classification; deferred-work entries; FLOW routing table;
  ops-dispatch step 2+3). FLOW §4f updated: #159 shipped via PR #192;
  #160/#162/#163 remain named. Semantic integration repair `2fa4d13`:
  PR #138's A7/V1 escalation table pinned the pre-correction fallback
  title (`clear to merge`); the table now pins this lane's r4-accepted
  corrected title (`review/fix routing cleared …`).
- Exact-head gates on `2fa4d13` through the authenticated `/api/verify`
  scheduler: `packaged-playbook` PASS (fast 67 + heavy install 13;
  receipt sha 33adbc87; one earlier attempt failed loud on the
  `assertDistCurrent` stale-`dist` guard and was repaired by a rebuild —
  preserved), `packaged-artifact` PASS (90 tests, tarball smoke;
  ledger-recorded outcome reconciled via status after the capture
  client's stream was lost — never replayed). CI on `2fa4d13` run
  `37221337144` green.
- Round `gc-packaged-build-playbook-20261002-r5` frozen at target
  `2fa4d13` (base `962a41b`), seven lenses; review verdict NEEDS
  CHANGES; publication aborted (`report_not_posted` — ambiguous app
  post, conservative non-retry). Manual review-list verification:
  0 publications after r4; the r5 report never reached PR #165 and is
  preserved locally. **Prior 0 (canonical-briefing conflict) fixed/
  accepted**: the supplied specification now carries the owner
  amendment j-761 and the reviewer confirms the former conflict is
  resolved by the amendment, not by a repository note. New findings:
  (1) blocker — the reviewer-commissioning precheck claimed the board
  pacing view covers the worker budget, but pacing (turn pools) and the
  resident-session ceiling (default 4) are separate constraints; four
  busy parents pass the precheck and wait on POSTs while blocking their
  own admission. Fixed: `roles/minion.md` names both constraints,
  requires establishing resident admission (finish the turn with the
  review commission as its explicit next action or stop loudly), and
  bounds submitted-dispatch reconciliation by job identity; new
  deterministic regression `test/pacing-admission.test.ts` exercises
  DispatchService through a real RuntimeRegistry with unlimited pacing
  and saturated residency (no spawn/resolve until a resident slot
  frees; FIFO; cap unchanged), plus prompt pins (source + installed).
  (2) warning — `packaged-playbook-timeouts` could PASS after an RPC
  patch failure: guarded (setup failure exit 3, never a masked result),
  and the 30s isolation budgets pinned via explicit --testTimeout/
  --hookTimeout overrides (the heavy config's 120s ceiling had replaced
  the claim — r5 verification note). (3) warning — the baseline build
  log was written to a truncating shared path: each attempt now writes
  inside its unique snapshot directory and the pointer records the log
  path. No r6 is requested before the corrections land on a new exact
  head.

## Verification

**Commands (all through the authenticated `/api/verify` scheduler — the
lane's declared scopes; never run directly):**
- `scope=packaged-playbook` (`node tools/patch-vitest-rpc-timeout.mjs && npx vitest run test/suite-shape.test.ts test/roles-installed-playbook.test.ts test/roles-definitions.test.ts test/roles-gru.test.ts test/silas-driver.test.ts test/install.test.ts`) -- expected: green (focused prompt/packaging regressions).
- `scope=packaged-artifact` (`node tools/patch-vitest-rpc-timeout.mjs && npx vitest run test/perkins-whole-review.test.ts`) -- expected: green (staged npm-pack tarball + smoke on the shipped artifact).
- `scope=packaged-playbook-baseline` -- expected RED: fail-before proof for the four overlaid oracles (`roles-installed-playbook`, `roles-definitions`, `roles-gru`, `silas-driver`) against the pinned pre-playbook tree (`6a00f4e`); setup failure exits 3 and build failure exits 99 (never confusable with the expected test RED), a green baseline exits 4 (the fail-before claim would be broken), and the snapshot pointer records the lane head; exit status left intact as evidence. The staged-tarball prompt oracles in `perkins-whole-review` are not overlaid here (pack cost); their pre-change absence is proven by the phrase-absence grep and their current pass by the artifact scope.
- `scope=full` (`npm test`) -- expected: full green on the final head
  (lint, typecheck, build, vitest, web); coordinated, no competing suites.
- `scope=typecheck` (`npm run typecheck`) -- available when a bounded
  typecheck check is wanted without the full chain.
- `scope=packaged-playbook-timeouts` (`node tools/patch-vitest-rpc-timeout.mjs && npx vitest run test/wizard.test.ts && npx vitest run test/dispatch-server.test.ts`) -- the declared timeout-classification diagnostic (isolation of the two FULL-run timeout tests at the unchanged 30 s ceiling). Recorded outcome: the attempts at `7a7702a` (`50`/`50b`) both never started (typed lock timeouts 900048/902625 ms, preserved); the a5a2 failure mechanism therefore remains unproved-by-isolation and is reported as such — never converted to a waiver.
- Final-head receipts live under `_bmad-output/gate-prep/` (labels 01+);
  the canonical final SHA and its receipt identities are bound in the
  ignored completion handoff
  (`_bmad-output/implementation-artifacts/completion-handoff.md`). The
  first integrated-head full (`51-full-810f471`, base `9bb51b0`) FAILED
  genuinely — a single 30 s `install-one-line` timeout with the complete
  capture retained — and is never erased by later heads or CI; post-repair
  heads take their own receipts as recorded in the handoff.
