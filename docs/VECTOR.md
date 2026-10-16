# Vector's raids

**Vector** attacks what Perkins reviews. A **raid** is one bounded adversarial
property campaign against one package on the default-branch head. Vector
proposes property contracts round after round; when an attack fails, he tries
a new vector, until the raid's budget runs out. A **break-in** is a
counterexample that passed qualification and that a fresh replay confirmed.

**Gru decides what to raid, and Silas runs the raids.** Raids reuse #350's
property seams unchanged: capability resolution (seam A), restricted execution
with receipts and replay (seam B), and qualification and frozen contracts
(seam C). Raids add no oracle, executor or sandbox.

**Raids gate nothing.** No merge, review or verification waits on a raid, and
a raid has no pass state. Raids run against code already on main. Heist
review, convergence, verification and readiness neither wait for raid state
nor read it. A raid writes only `vector.*` ledger events, its own
notifications and its own report. No raid touches a job, a round, an
obligation or a review's property evidence.

## Configuration

`[vector]` in `config.toml` is off by default, because raids spend quota.
[CONFIG.md](./CONFIG.md#vectors-raids-proposed-or-autonomous) explains each
key and the two modes:

- `raid_mode` decides whether a pick waits for your Accept;
- `fix_mode` decides whether a break-in's fix heist waits for it.

A repository opts out with `[vector] enabled = false` in its own
`.gru-command/worktree.toml`. Invalid values fail at boot and name the valid set.

## Picking targets: code ranks, Gru decides

Once per `plan_interval_ms`, code builds the candidate list from structured
state only.

- **A candidate is** a package in a managed repository where all of these hold:
  - seam A resolves it to a runnable property adapter;
  - the repository's `.gru-command/property.toml` mode is not `disabled`;
  - the clone has a cached origin default branch (`refs/remotes/origin/HEAD`).
- **Its source identity** is the package's git tree id at that head. A change
  outside the package does not change it.
- **Candidates are ranked** by four signals:
  - commits touching the package since its last raid;
  - Perkins changes-requested verdicts on the repository's jobs since then;
  - break-ins earlier raids found on it;
  - days since its last raid. Never-raided targets come first.
- **Excluded, each with its reason:**
  - opted-out repositories;
  - repositories at their daily cap (`max_raids_per_day`, rolling 24 hours);
  - a package with a pending proposal;
  - a package already raided or declined at the same source identity.

  A raid that yielded, was invalidated or hit a host error leaves its target
  eligible again.

No eligible candidate means no Gru turn, so an idle repository costs nothing.
Otherwise Gru gets one turn: an action-required `vector.raid-candidates` row
carrying the list. Each distinct list is offered once and answered once, so an
unchanged situation is never re-decided. A newer list supersedes an unanswered
one.

Gru answers through the API:

| Route | Body | Result |
|---|---|---|
| `GET /api/vector/candidates` | — | the ranked list, its `digest`, every exclusion with its reason |
| `POST /api/vector/raids` | `{ "digest"?, "picks": [{ "repo", "package_dir", "reason" }], "requested_by"?: "gru" \| "owner-chat" }` | `201 { raids }`; `422 not_a_candidate`/`invalid_pick`; `409 vector_disabled` |
| `GET /api/vector/raids` | — | every raid record |

How `POST /api/vector/raids` behaves:

- **Validation.** Every pick is checked against a freshly built list. One
  invalid pick refuses the whole request, and a pick of an excluded target
  names the exclusion.
- **An empty `picks`** answers the offered list with no raid.
- **`raid_mode = "proposed"`.** Each pick becomes one typed FOR YOU decision,
  `vector.raid-proposal`, showing the target, Gru's reason, the budget and the
  signals.
  - A retried pick reuses the pending card.
  - Accept queues the raid.
  - Decline is recorded, and the target is not proposed again until its source
    identity changes.
  - If the target changes before a decision, the card is withdrawn, and an FYI
    says so.
  - Pending cards survive restarts, and a choice recorded while the service was
    down is carried out at boot.
- **`raid_mode = "autonomous"`.** A pick launches straight away. It shows only
  as board activity (an FYI), never in FOR YOU.
- **A chat request** is the owner asking Gru in chat to raid a package
  (`requested_by: "owner-chat"`). It counts as the owner's Accept, and accepts
  a pending card for the same target. The bearer is shared, so this is Gru's
  declaration, recorded as declared. With `enabled = false` every request is
  refused, and the refusal says how to turn raids on.

## Running a raid (Silas's raid queue)

- **Scheduling.**
  - At most one raid runs per host.
  - No raid starts while heist work is queued (worker or review turns).
  - A running raid yields at its next round boundary when heist work arrives,
    and ends `yielded`; Gru may pick the target again later.
  - Vector's sessions take review turns through the same pacing path as every
    role (`src/runtime/pacing.ts`), and live in the same resident pool.
- **Before any session.** A host with no sandbox backend refuses the raid
  outright: a worktree is not a sandbox.
- **Roots.** The raid works in three throwaway clones of the default-branch
  head under `<data_dir>/vector/raids/<raid>/`:
  - the target;
  - a known-bad control;
  - a reference (healthy) control.

  Installed dependencies are copied into each clone, never linked. The clones
  are removed when the raid ends; its evidence and report stay.
- **Each round.**
  1. A fresh Vector session runs on Perkins's read-only role. It has the same
     tool confinement (read, grep, find, ls), no write tools and its own
     prompt (`src/vector/attack.ts`). It is told the target, the vectors
     already tried, and the contracts earlier raids already hold. It submits
     one attack through `gc_submit_raid_attack`. An attack is:
     - a requirement-grounded property proposal;
     - one JavaScript Vitest + fast-check test module;
     - a known-bad mutation that violates the invariant;
     - an optional reference that satisfies it.
  2. An exact-duplicate test (same package, adapter and test bytes at the same
     source identity) is rejected without execution. Semantic near-duplicates
     cannot be detected deterministically, and are not.
  3. The host commits the controls into their clones and qualifies the
     contract (seam C). The known-bad control must fail it and the reference
     must pass it. A rejected, inconclusive or escalated verdict never attacks,
     and counts as an invalid oracle.
  4. A qualified contract runs against the target in the sandbox (seam B). The
     target is its own baseline, so a break-in's attribution is
     `baseline-also-fails`: a pre-existing defect on main.
  5. On a property failure, the host replays the counterexample on a fresh
     run. Only a reproduced replay is a break-in. A failure that does not
     reproduce is `inconclusive`, and the nondeterminism is disclosed.
  6. On a pass, the next round tries a different vector.
- **Budgets.**
  - The caps are `max_rounds` attacks, `max_runs` sandboxed runs, the
    `max_raid_ms` wall clock and `max_raid_tokens`. Token usage is the Vector
    sessions' context size as the runtime reports it; where it reports none,
    the report says so.
  - One attack costs at least three runs: both controls and the attack. A
    failure adds the baseline and the replay.
  - Budgets never rise after failures or empty raids.
  - Every cap ends the raid at the next round boundary.
- **Main moving.** If the default-branch head moves during a raid, the raid
  ends `invalidated`, and nothing from the moved round counts, not even a
  break-in. A raid left running by a stopped service is closed out at the
  next boot as a host error.

## Outcomes, reports and metrics

| Outcome | Label |
|---|---|
| `found` | Vector broke in |
| `budget-exhausted` | Raid over: no break-in found in *N* attacks — not proof the code is safe |
| `no-qualified-proposals` | Raid over: no attack survived qualification |
| `refused` | Raid not run: *reason* |
| `unsupported` | Raid not run: target unsupported (*gap*) |
| `infrastructure-error` | Raid failed: *error* |
| `yielded` | Raid stopped for heist work |
| `invalidated` | Raid void: main moved during the raid |

No result that found nothing is ever shown as pass, verified or "no defects".
A finite raid proves nothing beyond the receipts it holds.

Every raid writes `report.json` beside its evidence and posts an FYI with its
label. The report holds:

- the target and why it was picked, and who launched it;
- every proposal with its qualification verdict;
- the receipts, or the typed reason there are none;
- the outcome.

Its metrics extend #350's: proposals, qualified, rejections by verdict,
invalid-oracle rate, executed runs, break-ins, replay reliability, wall clock,
token usage, and the headline **cost per break-in**. Generated case counts are
context, never a success measure.

## Break-ins

- **What a break-in is.** It is a pre-existing defect on the default branch. It
  never attaches as a blocker to an unrelated in-flight review.
- **`fix_mode = "proposed"` (default).** Each break-in becomes one typed FOR
  YOU decision, `vector.fix-proposal`. It carries the requirement, the
  invariant, the bounded counterexample, the replay seed, the frozen contract's
  digest, and where the evidence and receipts are.
  - Accept dispatches the fix heist.
  - Decline is recorded, and the same contract is not proposed again at the
    same source identity.
- **`fix_mode = "autonomous"`.** The fix heist is dispatched directly, with an
  FYI.
- **The fix heist itself.**
  - It goes through the normal dispatch path, the same one as
    `POST /api/dispatch`.
  - Its briefing is fixed host text in which every value is a line-safe JSON
    literal, the counterexample is labelled untrusted data, and the contract
    test travels as the qualified oracle.
  - Normal review, convergence, verification and readiness apply.
  - The contract test becomes a retained regression only through that normal
    review (#350 §8).
  - A raid never edits product code and grants no merge or publication
    authority.
- **Failed dispatch.** A dispatch that fails raises an action-required row for
  Gru, and is retried at the next reconcile, every five minutes.
