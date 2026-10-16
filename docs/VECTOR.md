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
  - seam A resolves it to a runnable `vitest-fast-check` adapter, the one
    adapter the raid runner executes today (a package on another adapter is
    excluded and the exclusion names it);
  - the repository's `.gru-command/property.toml` mode is not `disabled`;
  - the clone has a cached origin default branch (`refs/remotes/origin/HEAD`).
- **Its source identity** is the package's git tree id at that head. A change
  outside the package does not change it.
- **Candidates are ranked** by four signals:
  - commits touching the package since its last raid;
  - Perkins changes-requested verdicts on the repository's jobs since then;
  - break-ins earlier raids found on it;
  - days since its last raid. A never-raided target counts as 1,000 days,
    which puts it ahead of any raided target short of hundreds of new commits.
- **Excluded, each with its reason:**
  - opted-out repositories;
  - repositories at their daily cap (`max_raids_per_day`). The cap counts
    raids started in the last 24 hours plus raids queued or running now; a
    proposal waiting for your Accept does not count until it is accepted;
  - a package with a pending proposal, or with a raid queued or running;
  - a package already raided or declined at the same source identity.

  A raid that was refused, yielded, was invalidated or hit a host error leaves
  its target eligible again.

No eligible candidate means no Gru turn, so an idle repository costs nothing.
Otherwise Gru gets one turn: an action-required `vector.raid-candidates` row
carrying the list. A target Gru has seen in an answered list, at the same
source identity, is not offered again: picking one target from a list does
not re-offer the others. A newer list supersedes an unanswered one, and when
no candidate is left, an unanswered list is closed.

Gru answers through the API:

| Route | Body | Result |
|---|---|---|
| `GET /api/vector/candidates` | — | the ranked list, its `digest`, every exclusion with its reason |
| `POST /api/vector/raids` | `{ "digest"?, "picks": [{ "repo", "package_dir", "reason" }], "requested_by"?: "gru" \| "owner-chat" }` | `201 { raids }`; `422 not_a_candidate`/`invalid_pick`; `409 vector_disabled` |
| `GET /api/vector/raids` | — | every raid record |
| `GET /api/vector/rollup` | — | spend and yield per repository (see below) |

How `POST /api/vector/raids` behaves:

- **Validation.** Every pick is checked against a freshly built list before
  anything is recorded. For picks that launch at once (autonomous mode or a
  chat request), the daily cap is checked across the whole request too. One
  invalid pick refuses the whole request, and a pick of an excluded target
  names the exclusion. An accepted proposal past the cap waits in the queue
  until the repository has room.
- **An empty `picks`** answers the offered list with no raid.
- **`raid_mode = "proposed"`.** Each pick becomes one typed FOR YOU decision,
  `vector.raid-proposal`, showing the target, Gru's reason, the budget and the
  signals.
  - A retried pick reuses the pending card.
  - Accept queues the raid. If the target's code changed after the card was
    posted, the Accept launches nothing: the proposal is withdrawn and the
    card says why.
  - Decline is recorded, and the target is not proposed again until its source
    identity changes.
  - If the target changes before a decision, the card is withdrawn, and an FYI
    says so. A card closed without an answer withdraws its proposal.
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
- **Before any session.** The raid is refused outright (`refused`, with the
  reason) when:
  - the host has no sandbox backend: a worktree is not a sandbox;
  - the repository opted out, or turned property execution off, since the
    pick.
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
     already tried in this raid, and the defects earlier raids already found
     on this target (by invariant), so it does not re-find them. It submits
     one attack through `gc_submit_raid_attack`. An attack is:
     - a requirement-grounded property proposal;
     - one JavaScript Vitest + fast-check test module;
     - a known-bad mutation that violates the invariant;
     - an optional reference that satisfies it.
     A round with no valid submission is recorded as `no-submission`. When
     no attack has qualified yet, it ends the raid as
     `no-qualified-proposals`; after one has, the raid goes on.
  2. An exact duplicate of a test that already ran (same package and test
     bytes at the same source identity) is rejected without execution. A test
     that was submitted but never ran is not a duplicate. Semantic
     near-duplicates cannot be detected deterministically, and are not.
  3. The host commits the controls into their clones. A known-bad control
     that changes nothing, or a control path that passes through a link in
     the clone, is an `invalid-attack`: it never runs. Otherwise the host
     qualifies the contract (seam C). The known-bad control must fail it and
     the reference must pass it. A rejected, inconclusive or escalated verdict
     never attacks, and counts as an invalid oracle.
  4. A qualified contract runs against the target in the sandbox (seam B). The
     target is its own baseline, so a break-in's attribution is
     `baseline-also-fails`: a pre-existing defect on main.
  5. On a property failure, the host replays the counterexample on a fresh
     run. Only a reproduced replay is a break-in. A failure that does not
     reproduce is `inconclusive`, and the nondeterminism is disclosed.
  6. On a pass, the next round tries a different vector.
- **Budgets.**
  - The caps are `max_rounds` attacks, `max_runs` sandboxed runs, the
    `max_raid_ms` wall clock and `max_raid_tokens`.
  - Token usage is each Vector session's context size at the end of its
    round, as the runtime reports it. The token cap counts the rounds that
    reported usage. When a round reports none, the report says how many
    did not, and the round, run and time caps bound the rest.
  - One attack costs at least three runs: both controls and the attack. A
    failure adds the baseline and the replay. A round starts only while at
    least five runs (the most one attack can need) are left.
  - Budgets never rise after failures or empty raids.
  - Every cap ends the raid as `budget-exhausted`. The round, run and token
    caps are checked at the next round boundary. The time cap also stops the
    round in flight, and the outcome keeps what that round ended with.
- **Main moving.** If the default-branch head moves during a raid, the raid
  ends `invalidated`, and nothing from the moved round counts, not even a
  break-in. The head is fetched from origin at every boundary; when a fetch
  fails, the cached default branch decides and the report says the head's
  freshness is unverified. A raid left running by a stopped service is closed
  out at the next boot as a host error.

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
- the head it ran at, and whether that head's freshness was verified;
- every round with its typed outcome (`break-in`, `pass`, `inconclusive`,
  `rejected`, `invalid-attack`, `duplicate` or `no-submission`) and its
  qualification verdict;
- each round's receipts, or the typed reason it has none;
- the outcome.

Its metrics extend #350's: proposals, qualified, rejections by verdict,
invalid-oracle rate, inconclusive rounds, invalid attacks, duplicates,
executed runs, break-ins, replay reliability, wall clock, token usage, and the
headline **cost per break-in**. Cost per break-in is left out when any round
reported no token usage. Generated case counts are context, never a success
measure.

The **repository rollup** (`GET /api/vector/rollup`) sums every finished raid
that executed at least one sandboxed run. A raid that ran nothing (refused,
unsupported, or stopped before its first run) is left out. Per repository it
shows raids, proposals, qualified attacks, rejections by verdict, the
invalid-oracle rate, executed runs, break-ins, replay reliability, wall clock,
tokens, cost per break-in, and the raids since the last break-in. Cost per
break-in counts only raids whose every round reported token usage. After five
raids in a row with no break-in, it flags the spend.
The raid that reaches the streak repeats the flag on its FYI. It is surfaced
as a number: turning raids off is your call.

## Break-ins

- **What a break-in is.** It is a pre-existing defect on the default branch. It
  never attaches as a blocker to an unrelated in-flight review.
- **`fix_mode = "proposed"` (default).** Each break-in becomes one typed FOR
  YOU decision, `vector.fix-proposal`. It carries the requirement, the
  invariant, the bounded counterexample, the replay seed, the frozen contract's
  digest, and where the evidence and receipts are.
  - Accept dispatches the fix heist.
  - Decline is recorded, and the same contract is not proposed again at the
    same source identity. The same contract means the same requirement and
    invariant (whitespace aside), however its test is worded.
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
  Gru, and is retried at the next reconcile, every five minutes. A retry that
  finds the fix heist's job already exists (the earlier dispatch landed but
  its record did not) counts it as dispatched and never dispatches twice. A
  successful retry closes the row.
