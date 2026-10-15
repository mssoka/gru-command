# Property contracts for Perkins reviews (GH350)

Stack-aware, property-based executable review evidence: a language-neutral
orchestration contract, repository/package capability resolution, pluggable
version-aware adapters, and host-owned restricted execution with typed
receipts. Property contracts COMPLEMENT structured findings, explanations,
existing tests, independent review and readiness checks — they never
independently authorize merging, publication or deployment.

## Implementation status on the GH350 work branch

Capability resolution, host-owned sandbox execution, guarded qualification,
seed/path replay, Perkins evidence, bounded repair, reviewed regression
retention, CLI and CI wiring are implemented. The deterministic real-tool
campaign exercises the complete chain on macOS. Final whole-change review,
full-suite/exact-head CI and owner merge approval are separate delivery gates;
the implementation or a focused campaign passing does not claim those gates.
The lead's `perkins_submit_property_contracts` tool records immutable,
untrusted-input snapshots (8 proposals per call, 32 per round). It refuses
late submissions after the terminal review and counts only persisted artifacts.
Recording never executes a proposal or substitutes for host receipt evidence.

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
shrinking, runtime, repair attempts) are never silently raised. The pilot
executes one reviewed JavaScript test selection, uses native configuration
loading with esbuild/cache/watch/API disabled, and permits one active run per
executor. The workspace is read-only even for generated tests. A 256MiB V8
heap flag is not a universal native/RSS limit or a global concurrency quota.
The host supplies iteration/shrink bounds to the reviewed property through
`GRU_PROPERTY_MAX_ITERATIONS`/`GRU_PROPERTY_MAX_SHRINK_STEPS`; arbitrary JS
that ignores those values is still bounded by the OS restrictions and wall
clock, not by a claimed universal assertion-count monitor.

**Authenticated runner report (#378).** Under `pool=threads` the code under
test shares the process with Vitest's reporter, so stdout — and any file the
sandbox let the run write — is writable by that code. The verdict therefore
never comes from free stdout: the host passes a per-run 256-bit nonce on
fd 3 only (never argv, environment or files), the host-owned config reads and
closes fd 3 in the main thread before any test worker exists, and a framing
reporter (Vitest's own JSON reporter) prints the report between
`<nonce>:BEGIN` and `<nonce>:END`. The host parses exactly one such framed
block; an unframed, duplicated or unterminated report is no report at all
(`inconclusive`, never a pass). The approved plan's `--reporter=json` is
fulfilled by that host reporter rather than passed as a CLI flag (a CLI
reporter would replace it and print an unframed report).

**Owner-defined trust boundary:** Seatbelt denials may return catchable
`EPERM`/`EACCES`. A hostile runner that catches a denial and prints PASS can
produce only an unqualified `runner-report-classification`, not product
proof. The production host must reject fake/vacuous known-bad controls even
when both raw reports say PASS. No per-operation host audit or fatal-denial
mode is claimed; fatal denials also break legitimate Node/Tinypool probes.
The raw-parser distinction and production rejection have separate regression
controls. See the recorded owner decision in
`_bmad-output/implementation-artifacts/gh350-security-matrix-decision.md`.

Receipts bind source commit/tree, the explicit overlay identity (per-file
hashes; the source SHA alone never identifies the tested bytes —
exact-head/clean-tree verification elsewhere is untouched), configuration,
copied source and installed dependency byte digests, dependency and adapter
versions, the actual command and working directory,
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
checks and readiness gates remain mandatory). Missing configuration defaults
to disabled. Observation records evidence but cannot block or allocate a
repair; enforced candidate-only, qualified, actually replayed failures can
hold an ordinary whole-pass Perkins READY decision. Delta convergence and
all final verification rules remain unchanged.

The host CLI requires explicit artifact-review approval:

```sh
node dist/cli/property-check.js --approve-reviewed-campaign reviewed.json \\
  --artifacts-dir /owned/property-evidence --trigger pull-request
```

The closed JSON schema contains exactly `proposal`, `overlayFiles`,
`knownBadRoot`, `healthyRoot`, `candidateRoot`, and nullable `baselineRoot`.
Artifact references must match reviewed bytes. A baseline must be a real Git
ancestor, not an unrelated healthy example. There are no command fields or
installation permissions. Persisted JSON is audit material: it cannot recreate
in-process execution, report, repair-directive or artifact-review authority.
A new process must execute and qualify again.

Repairs run as ordinary durable directive requests through the native
directive path (admission, producer fences, settlement and recovery — the same
path as every other directive), with one-use allocations and at most three
total attempts. The repair directive is fixed host text with every value
emitted as a line-safe JSON literal; the sandbox-controlled minimized
counterexample is labelled untrusted data, bounded to 4096 characters and
carried with its sha256, so it can never forge a directive line (#379). Source movement across async boundaries,
changed dependency/lock/adapter/oracle/budget identities, and deletion of an
already-present frozen contract require requalification. Each repair validation
uses both the retained seed and native shrink path, so passing only the random
cases cannot hide a still-broken minimized edge case. Configuration parsing and
identity hashing refuse aliased or over-64KiB inputs; lock identity binds all
recognized package/root lockfiles with a 2MiB per-file ceiling. Reviewed retention
keeps the original candidate counterexample (not a qualification control's) and
preserves oracle bytes and adds a closed seed/path regression wrapper plus
the actual minimized counterexample/replay audit file. Retention changes
source bytes and invalidates prior review evidence; its files land in the live
lane all-or-nothing (a mid-way failure removes what it created and restores
what it overwrote, #380).

**Owner-service lifecycle (#380).** The owner HTTP service keeps campaigns
process-local. At its retention cap (128) it evicts the oldest settled,
non-blocking entry; pending proposals and unresolved blockers are never
evicted (when only those remain, a new proposal is refused until they are
decided). Every campaign view carries `nextAction`. A `failed` entry is
terminal: let any live directive settle through ordinary reconciliation, then
propose the reviewed campaign again for the current head. The candidate root
is bound to the job's active managed lane; the qualification control roots
(`knownBadRoot`, `healthyRoot`, `baselineRoot`) are owner-supplied paths
accepted on the authenticated owner's word — they are read-only inputs,
copied and executed only inside the sandbox, never written.

**Bounded evidence (#377).** `max_output_bytes` is capped at 8 MiB per stream
per run, capture storage grows only with the bytes actually kept, and a
long-lived executor retains at most 1024 sealed receipts and 256 MiB of their
output, evicting the oldest first — an evicted receipt reference resolves to
nothing, so every later consumer fails closed and requalifies.

`.github/workflows/property-contracts.yml` runs the bounded positive macOS
campaign for PRs/manual runs and weekly scheduled campaigns, retaining replay
receipts/counterexamples/metrics. The scheduled campaign uses the same bounds;
it is not a claim of deeper search or new-contract generation. The Ubuntu
full suite additionally covers explicit unsupported-host refusal, not positive
sandbox proof. Both workflows materialize the separately locked fixture under
the approved provisioning guards; workflow definitions are not green CI.
Metrics distinguish actionable defects and invalid oracles from raw generated
case counts, retain unknown validity separately, and report execution time
and token cost (unknown token costs remain `null`).

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
