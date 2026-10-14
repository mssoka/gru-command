# Property contracts for Perkins reviews (GH350)

Stack-aware, property-based executable review evidence: a language-neutral
orchestration contract, repository/package capability resolution, pluggable
version-aware adapters, and host-owned restricted execution with typed
receipts. Property contracts COMPLEMENT structured findings, explanations,
existing tests, independent review and readiness checks — they never
independently authorize merging, publication or deployment.

## Duties: host vs adapter vs reviewer

- **Adapters** (`src/property/types.ts` `PropertyAdapter`) describe how a
  TARGET repository's stack runs property tests: detection, placement and
  selection, execution planning, result interpretation. Adapters NEVER
  spawn processes.
- **The host** owns spawning, sandboxing, budgets, overlays, receipts,
  qualification, freezing, replay and every enforcement decision. Reviewer
  proposals are UNTRUSTED structured input, never evidence; only
  executor-produced, runtime-sealed receipts are host evidence (the seal is
  enforced at runtime in the production paths — a TypeScript type alone is
  not provenance).
- **Reviewers** stay read-only: they propose contracts (requirement
  reference, invariant, input domain, invalid-input behavior, what the test
  does and does not establish); the host validates, qualifies, executes and
  records.

## Tooling-state ladder (resolution honesty)

`declared` (manifest names it) → `locked` (lockfile entry with a resolved
version) → `installed` (`node_modules/<name>/package.json` present) →
`runnable` (runner `.bin` entry resolves to a contained regular file).
A lockfile proves LOCKED dependencies only — never installed or runnable
tooling. A resolved row is a planning candidate; `executable: true` requires
the runner `runnable` and every required library `installed`. Runner `.bin`
symlinks are followed ONLY through canonical-containment validation (both
sides canonicalized; a target escaping the repository or landing on a
non-regular file refuses with the precise reason). Resolution never
installs anything and never assumes Gru's own stack, a default runner, or
one ecosystem for a whole repository: monorepo and polyglot packages
resolve per package, scoped to the affected paths, with a content-hash
`resolutionKey` that changes when any contributing file byte changes.

## Shipped support matrix

| Adapter | Ecosystem | Framework | Runner | Tested range | Status |
|---------|-----------|-----------|--------|--------------|--------|
| `vitest-fast-check` | node-typescript | fast-check | vitest | vitest ≥3.0.0 <4.0.0 (reporter contract probed on 3.2.7); fast-check ≥3.0.0 <4.0.0 | **shipped** (pilot) |
| `hypothesis-pytest` | python | Hypothesis | pytest | none | unsupported (candidate) |
| `proptest-cargo` | rust | proptest | cargo test | none | unsupported (candidate) |
| `go-native-fuzz` | go | native fuzzing | go test | none | unsupported (candidate) |
| `streamdata-mix` | elixir | StreamData | mix test | none | unsupported (candidate) |
| `gleam-testing` | gleam | Gleam testing | gleam test | none | unsupported (candidate) |

Unsupported rows fail explicitly (`unsupported-ecosystem` naming the row);
manifest hints are never treated as proof that a framework or runner is
installed. `vitest-fast-check` capabilities: scalar generation ✔, stateful
sequences ✔, shrinking ✔, replay-by-seed ✔, controlled interleavings ✘
(honestly false — no deterministic scheduling claim).

## Typed outcomes and the interpretation contract

Outcome kinds: `pass`, `property-failure`, `build-failure`,
`collection-failure`, `selection-failure`, `infrastructure-error`,
`timeout`, `inconclusive`, `unsupported`, `not-run`. Direct exit code,
signal and duration are preserved verbatim on every outcome.

Classification uses POSITIVE evidence only. For the Vitest JSON reporter
(one Jest-shaped object on stdout): zero `testResults` ⇒
selection-failure (zero selected is never PASS); a failed suite with zero
assertions ⇒ collection-failure; failed assertions matching the plan's
selection identity ⇒ property-failure (a runner-report classification,
never by itself qualified contract or product proof); failures outside the
selection are disclosed as unselected and can never be promoted or dropped.
A nonzero exit with no parsable report is INCONCLUSIVE unless the stderr
matches one of the documented pre-report diagnostic signatures
(`vitest-failed-config-load`, `vitest-cannot-find-module`,
`node-err-module-not-found`, `vitest-failed-resolve-import`) — then
build-failure with the matched signature. Signals ⇒ infrastructure-error;
wall-clock expiry ⇒ timeout. `pass` requires: executed(selected) > 0, all
executed passed, no unselected failures, exit 0, and a self-consistent
report (totals agree with per-assertion accounting; success flag agrees
with the exit code). Zero EXECUTED (all skipped) is inconclusive — skipped
rows are not executed controls.

## Execution, evidence and replay

Generated tests and repository commands are UNTRUSTED executable code. The
host executor runs them under an enforceable OS sandbox backend (macOS
`sandbox-exec`; a generic `unshare` binary is NOT treated as a Linux
backend) with credential-stripped allowlisted environments, isolated
HOME/TMPDIR, isolated workspace copies, bounded output capture, and
process-group termination on budget expiry with descendant cessation.
Where no qualified backend exists the executor REFUSES (`not-run` /
`unsupported` naming the gap) — a worktree is not a sandbox, and nothing
ever executes unsandboxed as a fallback. Approved bounds (iterations,
shrinking, runtime, repair attempts) are never silently raised.

Receipts bind source commit/tree, the explicit overlay identity (per-file
hashes; the source SHA alone never identifies the tested bytes —
exact-head/clean-tree verification elsewhere is untouched), configuration,
dependency and adapter versions, the actual command and working directory,
selected/executed/skipped accounting, direct exit/signal/timeout state,
output hashes, and replay data (seed, shrink path, schedule, environment
profile). Retained counterexamples replay under the recorded data or
honestly disclose nondeterminism/unsupported replay. Relevant source,
overlay, config or tool changes invalidate the affected evidence.

## Qualification, freezing and repair

A proposed contract becomes a blocker only after qualification: a relevant
known-bad implementation/mutation must FAIL it and a healthy/reference
implementation must PASS it; vacuous (e.g. an always-0.0 ratio satisfying
"nonnegative finite float"), contradictory and inconclusive oracles are
rejected or escalated, never forced onto production code. Baseline-vs-
candidate attribution is preserved — a counterexample that fails on the
baseline too is not a new PR defect. Qualified contracts FREEZE for the
repair attempt; deleted, altered or skipped contracts and
generator-excluded counterexamples are detected (requalification required,
never silent oracle repair). Bounded repair attempts feed qualified
counterexamples and requirement context; useful minimized examples are
retained as deterministic regressions after review of the generated
artifacts.

## Modes, CI and metrics

Repository-level configuration (`.gru-command/property.toml`, strictly
parsed): `disabled`, `observation` (execute and record, never block) and
`enforced` (qualified failures may hold the PR through the EXISTING review
authority — property PASS never independently authorizes anything; the
original final tests, independent whole-change review, exact-head/remote
checks and readiness gates remain mandatory). CI runs bounded PR checks
and optional deeper scheduled exploration with retained replay evidence,
on the same declared locked fixture setup. Metrics distinguish actionable
defects and invalid oracles from raw generated-case counts and report total
execution/token cost.

## Real-tool fixture (test-only)

`test/fixtures/property/real-tool/` carries the committed lock identity
(vitest 3.2.7 + fast-check 3.23.2, public-registry sha512 entries) for the
deterministic real campaign, provisioned under the Root-approved 2026-10-14
guards — see `test/fixtures/property/real-tool/PROVISIONING.md`. It is not
a Gru dependency, ships no installer capability, and network use is
authorized for the declared provisioning stages only.

## Stateful pilots

Gru-relevant sequence invariants (no second writer without proven
predecessor cessation; stale acknowledgements cannot release a newer
owner's resources; terminal results immutable across cancel/retry/late
completion; admission revalidates identity after async boundaries) run as
model/fake-runtime properties on the real fast-check engine, labeled
`simulated-model` — never native OS/process/provider proof.
