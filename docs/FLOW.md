# The dispatch flow

The heist arc, in-product (EPICS E8; SPEC rulings 2, 17, 18). Every step
lands on the ledger — the record of record — and the board renders the
whole arc live.

```
 Gru (chat)          ops (Silas role)            minion                  Perkins hybrid
 ──────────          ─────────────────           ───────                 ───────────────
 consult → plan
 briefing ─────────► job row (briefing verbatim)
                      │ fresh worktree + branch
                      ├─────────────────────────► spawned IN the worktree
                      │                           briefing turn …
                      │                           deliverable + PR link ◄─┤
                      │                                                   one lead
                      │                                                   9/8 whole-change lenses
                      │                                                   (lead-selected batches)
                      │                                                   verify + audit
                      │                                                   report → PR comment
 release ◄─────────── sweep (preserve-first)                            (chips live on the board)
```

## 1. Briefing (Gru, chat-side)

The user brings intent; Gru consults and settles the plan
(plan-before-heist is Gru-side canon). The output is a briefing a
stranger could execute: goal, boundaries, acceptance, verification.

## 2. Ops handoff (dispatch)

`POST /api/dispatch` `{job_id, repo_path, title, briefing, display_name?}` — the
mechanical handoff behind the chat surface. `display_name` is an optional
short heist label authored at handoff; it does not replace the full title or
worker identity. Older jobs without it use a shortened title on minion cards:

1. **Job row** — briefing recorded verbatim; status `dispatched`.
2. **Lane** — one git worktree per job on branch `gru/<job>` at the
   FETCHED origin default-branch head (worktree manager, below; a fetch
   failure degrades to local HEAD with `base_source:
   'local-head-fallback'` recorded, never silently). Status `working`.
3. **Minion** — a fresh agent session spawned with `cwd` = the worktree
   (SPEC ruling 17: dispatch cwd is the PROJECT root on every runtime;
   project conventions remain applicable there). New jobs receive the
   GC-owned workflow plus explicit registered job/private artifact context;
   ambient BMAD does not select execution settings. The lane keeps its exact
   binding for its life; historical BMAD jobs retain their original contract
   ([GC-WORKFLOWS.md](./GC-WORKFLOWS.md)). The briefing prompt is
   delivered as the session's first turn.

Failures are loud and leave no half lanes: a spawn failure sweeps the
fresh worktree back out and blocks the job with a note.

## 3. Lifecycle on the board

The ledger's event stream drives the board: `job.handoff`,
`job.minion-spawned`, `job.delivered` (or `job.minion-error`), the PR
link (`POST /api/dispatch/pr`), review rounds with per-lens chips, and
the sweep. Statuses track that stream automatically: the settling turn
moves `working → delivered` (ok) or `working → blocked` (error), and a
registered PR opens the review window (`working|delivered →
in-review`). Merge detection is NOT internal — nothing here writes
`merged`; the external sweep (Silas) is the remaining caller. The board
groups by repo; the phone is board-first.

## 4. Review waves (Perkins)

`POST /api/dispatch/review` `{job_id, target_ref?, no_spec?, evidence?}`
freezes one exact target/base/diff/spec set in a detached review worktree. An
arm may carry private evidence uploads; the frozen round binds the effective
amended acceptance and the exact-target CI receipt, and the amendment/contract
endpoints (`POST /api/dispatch/amendment`,
`GET /api/dispatch/jobs/<id>/contract`) manage that acceptance. A
**material** amendment (owner rules 2026-10-08) makes the delivered candidate
outdated: review stays fenced until a continuation carrying that revision
delivers, and a review already owning the lane is superseded — proven stopped
before any directive or re-brief prompts the minion (REVIEW-INPUTS.md §4). See
[REVIEW-INPUTS.md](./REVIEW-INPUTS.md); a private-evidence arm is refused on
the bmad-review fallback route rather than silently reviewed without it. The arm
first passes the **branch-idle guard**: while any lane is actively
working/pushing the target branch (`dispatched`/`working`/`in-review`
with no settled delivery for its current attempt — a PR link flips a lane
to `in-review` mid-attempt, so that status alone is not proof of
settlement; a `delivered → in-review` flip starts no attempt), the API
answers `409 branch_busy` with
`blockers: [{job_id, status, branch}]` and the same check re-runs
immediately before the freeze, so a lane re-opened mid-setup is refused
the same way. The guard compares a lane's RECORDED branch (or the
`gru/<jobId>` branch a `dispatched` job is about to create). A lane that
checks out its own branch but pushes a FOREIGN PR branch (a rebase/
salvage lane) is invisible to that comparison — no lane declares a push
target yet (issue #121 records the evidence and the declared-push-target
extension). Silas's standing freeze-r1 rule — never arm while a known
rebase/force-push lane is active on the target — is the control for that
class. The same recheck runs after a failed pre-flight and before
the bmad-review fallback gate admits — a re-brief or lane re-open landing
during the awaited pre-flight refuses the fallback arm (409, or a queued
replay re-queue) instead of starting a fallback reviewer; the fallback
recheck enters through the same `arm`-phase guard, so a forced fallback
admission carries two `arm`-phase `branch-idle.forced` records where the
native route carries `arm` + `freeze`. A running fallback gate also
re-proves its lane, marker and replay-authorization facts at each round
intake, after the default reviewer's worker admission and asynchronous
spawn, and after the reviewer returns. It compares the current attempt,
delivery and branch owners to the audited admission snapshot: a new working
attempt, newly busy foreign lane, or replaced checkout cannot approve the
old diff. `force` in the fallback covers only blockers present at the
original arm, not a new request during preflight or an active reviewer.
It also compares the durable re-brief settlement watermark from admission
and each round's diff intake: a request that begins and settles while the
reviewer runs cannot approve the old diff. Those boundary re-proofs
emit no branch-idle audit rows: at admission a replay whose job is
blocked/parked is HELD (`job.review-handoff-held` plus escalation,
requiring a new validated request), while after admission the gate stops
as `job.fallback-review` phase `aborted` with a free-text reason and no
held identity. Terminal (`merged`/`done`/`binned`) jobs take the
canonical terminal refusal before any busy check — a stale marker never answers
`branch_busy` and never resurrects the job. The reviewed job's OWN
unresolved request fences the review regardless of an explicit
`target_ref` naming another lane; unrelated foreign lanes keep their own
branch-matched busy semantics. A `blocked` gate terminal reports the
failing round in `iterations`; an `aborted` terminal reports only
completed rounds (the aborted event's `iteration` names the round not
taken). The arm passes
only when the target work is genuinely
settled AND no re-brief request is unresolved — a delivery alone does not
release a fenced lane. A lane with an unresolved re-brief request counts
busy the same way: the durable pending markers written before a re-brief
worker spawns (cleared only when the request genuinely settles, via
finalization or boot recovery) fence the target regardless of an older
delivery or a status flip — the fence can coexist with a delivered or
in-review status — and the Silas digest rechecks every proposed review
at final publication, after any async blocker-history work. A live re-brief
finalizer matches the exact admitted marker IDs as well as any phase ID:
ordinary requests have no phase ID, so an older turn cannot consume a
newer request's markers. Settlement publishes `silas.rebrief-settled` in
the SAME transaction that clears the markers, so a queued handoff that
re-queued on the earlier delivery can retry without waiting for another
sweep — and a settlement publication failure rolls the clear back instead
of stranding the handoff behind already-cleared markers. `force: true` is the owner's explicit override —
never an automatic operations action; a forced round is tagged in its
frozen manifest
(`branchIdle`) and the event log (`branch-idle.forced`), refusals land as
`branch-idle.refused`, and a Silas auto-arm deferral lands as
`silas.review-deferred` (retry on the next sweep). For a job
with a registered PR, the target is resolved from the pull request's own
live head: the code host's `headRefName` decides WHICH branch is fetched
from `origin` — a lane ref synthesized from the job id (`gru/<jobId>`) is
never the freeze source — and the fetched tip must equal the live
pull/merge-request head. A resolved ref that fetches nothing, a moved
head, or an unverifiable host answer aborts the request before a round or
lens exists (an action-required escalation names the resolved mismatch).
A round has
one real Perkins lead reviewing the complete frozen change. The pinned
policy's catalog makes nine whole-change specialist lenses available (blind,
edge, acceptance, security, architecture, codebase, tests, performance,
operations) — eight when `no_spec: true` explicitly removes the
spec-dependent acceptance lens. The lead SELECTS which specialists help the
change: availability is never a mandatory coverage gate, and a subset (or
none) is a valid review. Specialists run in explicit tool-call batches
bounded by the round's admitted resident wave and provider pacing; the lead
splits oversized work across calls, and any number of batches completes
inside the SAME round, frozen target and lead. A round is bounded to 16 real
specialist runs (retries included), two attempts per lens, and two real
terminal submissions (free preflight is distinct); failed attempts count and
stay recorded, and a completed lens cannot be rerun for a second opinion.
Lenses the lead did not use are reported as `not used`, never as coverage.
Immediately after the freeze (and before the run promise or any lead/child
spawn), an **admission preflight** re-validates the complete frozen packet
read-only — head binding, every declared artifact digest, evidence
attachment bytes, the CI record's shape, and the spec's explicit CI and
verification sections (a no-binding verification run freezes an explicit
UNAVAILABLE disclosure, never silence) — and refuses with one exhaustive,
named missing-input list (`round.admission-preflight`); a refused round
aborts without spawn. Parent-failure truth (gh-169): a round whose PARENT
fails after a review owner spawned (lead transport death, restart,
finalization crash) records exactly one `round.parent-incident` event;
lenses with a started attempt carry an honest interrupted-execution error,
and never-started lenses keep their `pending` chips — one lead disconnect
is one parent incident, never a slate of failed specialists. A PRE-SPAWN
interruption (setup shutdown or a pre-spawn workflow failure) is not a
parent incident: it leaves the durable negative owner receipt
(`round.review-no-spawn`) and an INCOMPLETE report whose heading says
setup refusal/interruption — no incident event exists to find. A revision-expression or tag pin
(`origin/topic~1`, `origin/v1`) is not a branch spelling: the
advertised-tip movement probe skips it (the pin still binds through local
resolution and the pristine-checkout proof), so pinned rounds no longer
degenerate into check-failed movement.

- The lead receives only its declared product-native tools: four
  whole-change orchestration tools (run tracked specialist children, store
  bounded notes, preflight a candidate terminal submission, submit terminal
  proof) plus the bounded prior-revision reader on a re-review. It reads the
  complete frozen change with its confined read tools and owns delegation,
  investigation, verification, deduplication, prior audit, verdict
  calculation, and report authorship. Recording runs the exact terminal
  decision validator at store time; preflight uses the exact terminal
  validator without spending a terminal attempt, sealing the round, or
  accepting anything; a rejected terminal submission returns every
  violation in one bounded response, can be amended with a `{"mode":"delta"}`
  resubmission carrying only changed fields (merged host-side and
  re-validated as the whole), and still counts as one real attempt.
- Lens children are fresh, ambient-free sessions. Blind has no tools or
  repository/spec context; other lenses get confined read/grep/find/list
  tools. No reviewer gets shell, edit, write, ambient skills, extensions,
  settings, unrelated MCP servers, or nested delegation. A review session
  may declare product-native tools, and the ADAPTER exposes exactly those
  declared tools on every harness: pi injects them in-process, claude-code
  attaches a session-scoped, product-owned MCP bridge. The lead declares
  its whole-change orchestration tools; a lens child that declares native
  tools gets only its own (the `perkins_submit_findings` channel) and never
  sees the lead's. That seam is harness-independent by design — review
  isolation and tool exposure live in the adapter implementation, never in
  caller branches on harness.
- Child findings are evidence-paired at envelope construction: a finding that
  cites a real file must quote that file (or its frozen diff), so an attempt
  that mixes a candidate with foreign-file evidence fails at the child, well
  before the lead inherits it; the attempt stays retryable within the pinned
  lens bound.
- Findings leave a lens child only through `perkins_submit_findings` when
  the hosting runtime wires it; its input is validated against the exact
  finding schema and assistant text is never parsed back on that path. A
  runtime without the tool keeps the strict JSON-array envelope, whose
  tolerant recovery (fences, preamble, embedded array) only locates the
  array before the same exact schema validates every finding.
- The integrity-pinned package policy is the sole prompt authority for lead
  and child review behavior; interpolated repository/spec/convention text is
  untrusted evidence, never instruction. The host bounds attempts,
  concurrency, candidate/report bytes, and wall time; records every child;
  verifies exact run accounting (selected lenses, attempts, round budget),
  candidate ownership,
  frozen-commit evidence, prior audit, source stability, report contents,
  delivery, and canonical blocker arithmetic. Zero blockers is READY TO
  MERGE, 1–3 is NEEDS CHANGES, and 4+ is MAJOR REWORK NEEDED. Warnings and
  notes never block.
- A malformed child output consumes one attempt and may be retried within the
  pinned bound; a failed or exhausted specialist attempt is recorded
  lens-failure truth and never terminalizes the round by itself.
  Cancellation, restart, changed
  source/checkout, unsupported evidence, invalid audit, or delivery failure
  durably terminalizes the round as INCOMPLETE. It can
  neither post nor record approval. Startup reconciliation marks interrupted
  rounds INCOMPLETE and releases their owned detached lanes.
- The base is changed source only when the locally resolved base ref no
  longer contains the frozen merge-base (rewritten past it) or no longer
  resolves; nothing is fetched, so a host-side rewrite counts once it is
  visible locally, and the frozen base stays recorded as provenance.
- Installed builds load the integrity-pinned policy and Claude MCP server
  relative to the compiled package. Missing, tampered, symlinked, or
  source-fallback resources fail closed.
- The Claude stream-json CLI does not expose a deterministic lead-turn
  discriminator. Claude coverage therefore pins total lead time and terminal
  tool acceptance, while direct turn-count discrimination remains covered by
  the Pi/offline session path; no direct Claude turn-count coverage is claimed.

## 4b. Review-path selection: the bmad-review fallback gate (user amendment 2026-09-20, fork-3 extension)

Perkins is the PRIMARY review gate. At review request time — before any
round is created — a fail-closed four-leg capability pre-flight decides the
route:

1. **Bundled resource integrity** — the SHA-256-pinned Perkins policy loads
   (and the compiled MCP server carries its pin).
2. **Review model provider** — the configured review model resolves and its
   provider holds credentials (cheap probe; no generation call). On the
   claude-code runtime this is a CLI-availability probe; on pi it checks
   model resolution plus provider auth.
3. **Code-host integration** — a GitHub (`gh`) or GitLab (`GITLAB_TOKEN`)
   token valid for the exact repository remote: the preflight leg. Verdict
   delivery rides the `gh` token only when no Perkins App bundle is
   installed; with a bundle, github.com publication is App-authored (see
   [PERKINS-APP-PUBLICATION.md](./PERKINS-APP-PUBLICATION.md)). Only GitHub
   and GitLab hosts are supported; other origins fail the leg closed
   (credentials are never sent to unknown hosts).
4. **Review policy enabled** — `[review] enabled = true` in config.

All legs pass → Perkins review (the gate). Any leg fails → the request
routes to GC's verified owned fallback review helper. The stable API route is
still `bmad-review-fallback`; no external BMAD skill is discovered or required.
The fallback carries FULL GATE semantics: the session returns
findings; the host triages them (release-safety categories — correctness,
security, data loss, broken builds, and related crash/regression/
vulnerability/injection/secret-leak tags — are BLOCKERS; the rest are
notes); BLOCKERS > 0 routes a fix directive to the implementing MINION
session, the lane's working diff is re-read, and the gate re-reviews after
fixes (bounded rounds); 0 blockers = PASS that clears review/fix routing
only — the fallback PASS is the review gate of record for routing and
fixes, never a Perkins READY and never merge clearance. The
fallback session is a bounded minion report task with read tools and one JSON
report write, without build-workflow injection, implementation edit or shell tools.
It reads the owned helper and is instructed never to gate, approve, merge, or
modify implementation code; every gate decision is the host's. The fallback
never records a Perkins verdict and never moves merge authority: only an
exact-head Perkins READY can authorize a merge, and the owner holds every
merge, everywhere — this repository included. A failed pre-flight is never a silent downgrade — the failed
legs, their remediations, and both recovery options (restore the exact retained
owned package/context or repair a new GC install / restore Perkins) are escalated
and recorded on the job as
`job.fallback-review` events. GitLab merge requests get the same SHA-bound
delivery discipline as GitHub (the frozen HEAD is verified before a note is
posted; a PR's recorded base is refreshed into the delivery record rather
than gating, since a pinned base is expected to trail a moving main), and
the GitLab probe and poster resolve their token
identically (`GITLAB_TOKEN`, falling back to `GL_TOKEN`). GitHub
**publication** authenticates through the `gh` CLI when no Perkins App
bundle is installed; with a bundle, github.com publication is App-authored
while the review preflight still probes remotes through `gh` (see
[PERKINS-APP-PUBLICATION.md](./PERKINS-APP-PUBLICATION.md)).

Report artifacts persist before delivery, but the local round verdict is
recorded only after SHA-bound delivery proof succeeds; delivery failure
terminalizes the round as durable INCOMPLETE alongside the preserved
report — it never erases already-preserved findings.

## 4c. Verification scheduler — one global test budget (contention fix 2026-09-22)

Concurrent lanes used to each run their full suite with a worker pool
sized to the machine's cores; N co-tenant lanes oversubscribed the box
(observed load 15–22, vitest RPC timeouts killing green runs). That is a
coordination problem, not a capacity one: the service owns ONE cross-lane
verification budget.

- **Lanes request a run** through the authenticated ops surface —
  `POST /api/verify {job_id, scope}` (`scope` defaults to `full`) —
  instead of running the suite themselves. The command comes from the
  project's own declaration in `.gru-command/worktree.toml` (`[verify]`,
  `scope = "command"` pairs), and it runs inside the job's lane worktree.
  A repo that declares no verify command gets a loud 409 — no guessed
  command, ever.
- **The scheduler owns concurrency.** At most `[verify] max_concurrent`
  runs (default 1) run at once; further requests queue FIFO. A request
  that waits past `lock_wait_timeout_ms` (default 15 min) fails LOUD: the
  lane receives a typed `error` frame and the ledger a
  `verification.lock-timeout` record — nothing hangs silently.
- **Identical submissions are single-flight, never duplicate producers**
  (issue #159). Same job + lane + scope + head + command shares ONE run:
  the duplicate stream gets an `attached` frame naming the run and then
  receives the same terminal outcome; a restart orphan that already
  represents the submission answers with a typed `duplicate_in_flight`
  error instead of a second producer. A completed run, a failed-run
  repair, or a changed head is never permanently suppressed — a fresh
  submission runs.
- **A submission can carry durable identity.** `POST /api/verify` accepts
  an optional client `request_id` (and `expected_head`; a lane that moved
  answers 409 `head_changed` before any producer exists). Replaying the
  same `request_id` attaches to the in-flight run or replays the recorded
  terminal outcome — a lost response is reconciled, never replayed blind.
  The run's exact head is re-read at spawn: a lane that moved while the
  request waited fails as `head_changed` instead of verifying the new
  revision. `GET /api/verify/status?request_id=…` answers
  `unknown | accepted | running | completed | admission-failed |
  interrupted`; only a task confirmed never-started (typed
  `lock_wait_timeout`, no `started` frame) may be retried under its old
  identity. Terminal identities append to `<data_dir>/verify/requests.ndjson`,
  so history eviction and crash/restart never turn a completed or
  interrupted identity into `unknown`: it reports its terminal state and
  refuses a rerun — a re-verification mints a NEW request id.
- **Capture is exclusive and receipted.** The shipped capture helper
  (`dist/verify/capture-cli.js`, named in Silas's wake prompt) opens a
  unique `wx` sink BEFORE the POST, streams every NDJSON frame to EOF
  (transport `ping` frames included — the receipt records them as
  `pings`, separate from the producer-frame `frames` count), and writes
  `<sink>.receipt.json` binding run id, true head/dirty state,
  exit/outcome and output length/hash. A stream without a valid terminal
  completion, with torn/foreign records, or whose single run identity does
  not hold across the whole stream is `unknown` and is never promoted to
  success; a replayed terminal receipt is marked `reconciled` and is an
  honest failure (the outcome is known, the original full capture is not
  reconstructable, and a rerun to recover logs is refused). Owned helpers are withdrawn only with identity validation
  (pid + start time + command/cwd); malformed pid records, crashes and
  stale owners are cleared without touching unrelated processes, and
  sinks/receipts are preserved.
- **One worker budget across runs.** Total test workers stay within
  `[verify] worker_budget` (default: CPU cores − 2), enforced by the run
  wrapper through the vitest pool knobs and `GRU_VERIFY_*` variables for
  other runners.
- **Project harness budgets compose with the run budget.** A repo may
  classify process-heavy integration files with their own finite ceilings
  and a smaller worker cap (gru-command: 120s and two workers, see
  `test/helpers/test-budgets.ts`). The classified phase runs sequentially
  after the fast phase inside the declared `full` command, so the two
  phases never overlap and a smaller scheduler pin still wins.
- **Holders are durable and self-healing.** Active holders persist at
  `<data_dir>/verify/scheduler.json` with the runner pid; a persisted
  holder whose pid is dead — or was never recorded — is released
  (stale-holder detection), and each run is
  wall-clock bounded (`run_timeout_ms`) with the whole process group
  killed on expiry.
- **Outcomes are recorded evidence.** Every run lands as
  `verification.started` / `verification.completed` with ok, exit code,
  duration, sha, worker count, and bounded output hash/tail. Review
  consumes the RECORDED run: when a completed run binds to the exact
  frozen review target SHA (clean tracked tree), the host freezes a
  clearly-delimited evidence block into the review spec context, so the
  tests lens weighs ledger-backed evidence instead of a pasted report.
  The job's COMPLETE `verification.completed` history is read in bounded
  keyset pages with no finite lifetime window: the newest run binding the
  frozen target governs, a long history never refuses a review, and the
  explicit absence section appears only after the whole history is read.
- **Progress streams** back as NDJSON: `queued` → `started` → `output…`
  → `completed` (or `error`), with transport `ping` frames interleaved
  into any silence. A duplicate submission to an in-flight run instead
  begins with `attached` and then receives only that run's later frames
  (an already-running attach has no `queued`/`started`; a terminal
  attach gets `attached` → `completed`). While the body would otherwise
  be silent —
  a queued slot wait (up to `lock_wait_timeout_ms`), or a producer that
  has not written yet — the surface emits application-level `ping`
  frames (default every 15 s, worst-case gap 2 × cadence ≈ 30 s) so a
  streaming client's default 300 s HTTP body-idle timeout does not
  truncate a valid run. A `ping` is transport liveness only: no run
  identity, never producer output, never a terminal frame, and never
  written after `completed`/`error`. A `ping` may be the FIRST body
  frame when the first producer frame is delayed past one cadence, so a
  consumer must tolerate a leading `ping` (and must never count it as a
  producer frame). The protection assumes the event loop services the
  timer; a stall longer than the client's idle limit is outside it.

Managed repos still own their CI: this endpoint coordinates LOCAL
verification runs inside lane worktrees — the orchestrator never hosts a
tenant's CI.

## 4d. Resident worker admission

`[concurrency] max_workers` (default 4) bounds live non-core worker sessions
across every heist, including idle minions, review leads and children, on both
runtime adapters. Gru, Silas, Bob and the separate `[verify]` scheduler are not
charged to this pool. At capacity, new sessions wait FIFO; an eligible idle
minion is disposed through its normal session path before a waiting request is
admitted. A display `idle` state alone is insufficient: pending prompts,
control/tool activity, supervision's open-turn truth, and an as-yet-undelivered
first prompt prohibit eviction. A residency release never sweeps the transcript
or job worktree.

A Perkins round waits for two permits together before starting its lead,
reserving room for at least one child. Optional parallel lens children use
spare slots only when no older admission is waiting; the configured
`[review] max_concurrent_children` (default 2) is a ceiling *inside* the
shared pool, not extra capacity. A minion sending `POST /api/dispatch/review`
with `by: "minion"` while its own branch is busy receives a durable queued
handoff receipt (202) immediately. The branch-idle guard still prevents
freezing until that minion's delivery event; a queued round then appears in
the ledger as `round.residency-queued` until its lead/child pair is admitted.
Queued waits consume no reviewer turn or spawn timeout.

## 4e. Tracked child workers (sub-minions, issue #161)

A parent minion can commission one independent child worker through GC's
own authenticated control plane: `POST /api/dispatch/child`
`{parent_agent_id, job_id, purpose, authority, task, idempotency_key,
label?}`. GC — not a provider-native delegation extension — owns
admission, identity, lifecycle, cancellation and the result record.

**GC-mediated parent tools.** A dispatched top-level minion receives
three product-native tools bound to its own agent id by closure —
`request_child_worker`, `list_child_workers` and `cancel_child_worker`.
They execute INSIDE the GC service process, so no bearer secret is
written into session space and a sibling worker cannot impersonate the
parent by reading a file. The HTTP child endpoints remain the operator
surface (pairing token) and are not the minion-facing path.

Declared capability gap (review round 3): the tools are hosted only on
runtimes that execute them in the service process (**pi**). A
claude-code session's tools ride a discoverable same-uid loopback bridge,
which another worker process could call to impersonate the parent — so
the claude-code adapter REFUSES non-review product tools loudly, and a
claude-code minion receives no parent-tool surface (the board, HTTP and
ledger surfaces remain runtime-agnostic).

- **Parentage is a relationship, not a sixth role.** A child is a
  minion-role session whose agent row carries `parentage = 'child'` and
  `parent_agent_id`. Only top-level minions may commission workers
  (nested delegation is refused), and one parent admits at most four
  logical children (`MAX_CHILDREN_PER_PARENT`).
- **Idempotent admission.** The child's admission row AND its agent row
  are written before any spawn (one product-owned id for the admission
  record, the agent row and the lane), so a queued child is visible on
  the board with parent navigation immediately. A duplicate or
  lost-response retry with the same `(parent_agent_id,
  idempotency_key)` returns the existing child and creates no second
  worker; the same key with a different payload is a 409 conflict.
  Refusals name the failed precondition: unknown parent, parent not
  permitted, nested delegation, job mismatch, expired/terminal job,
  disposed parent, missing parent lane, fanout cap, budget/capacity
  (the shared resident pool is full and no ELIGIBLE idle minion is
  reclaimable by the budget's own predicate — a refusal, never an
  unsatisfiable wait that would deadlock parents),
  invalid task or authority (`{error, detail}`).
- **Bounded authority and isolation.** `authority: "read-only"` spawns
  the child with the read-only tool set (`read`, `grep`, `find`, `ls`) in
  a detached lane based at the parent lane's HEAD; `authority: "writer"`
  gets the minion tool set and its own branch
  `gru/<jobId>-child-<childId>`. A child never mutates the parent's
  working tree implicitly and never inherits more than its own declared
  authority.
- **Lifecycle and result.** The child record moves
  `queued → admitted → active → done | error | cancelled`. Child
  admission waits in the SAME FIFO resident-worker admission as any other
  worker session (an atomic budget RESERVATION is taken when the run
  starts, so a free-seat probe race cannot admit an unsatisfiable
  queue); the provider pacing pool is taken only AFTER the resident
  permit (so a capacity-blocked child never holds a turn slot), and the
  child turn consumes that shared pool. `active` means the briefing is
  about to be delivered — a pacing wait still reads queued/admitted.
  `done` is a successful terminal outcome recorded from the transport's
  own terminal evidence INCLUDING any automatic rate-limit retry
  settlement, AND requires the child's own FINAL report (the turn's last
  transcript message) in `result_summary`, with the session file as
  `result_ref`; a clean turn with no collectable final report is a named
  `error`, never a fully reported `done`. Cancellation awaits handle
  disposal and records `cancelled` only when cessation is proven; an
  unproven stop stays NON-TERMINAL with durable `child.stop-unproven`
  debt (and never releases the lane). `GET
  /api/dispatch/children/:id`, `GET /api/dispatch/jobs/:jobId/children`
  (operator) and `GET /api/dispatch/agents/:agentId/children` (the
  parent's own scope) are the discovery paths; `POST
  /api/dispatch/children/:id/cancel` stops a live child (terminal records
  are immutable).
- **Counters.** The board snapshot carries `children {queued, active,
  finished, lifetimeCreations}`; `lifetimeCreations` counts ROWS in
  `child_workers` (one per logical creation), so retries, session resumes
  and service restarts never double-count. See [LEDGER.md](./LEDGER.md)
  for the full semantics.
- **Ownership and recovery.** Child lanes are registered worktree lanes
  (kind `child`) and sweep through the same release path; read-only lanes
  are swept automatically once their run is terminal (including on boot
  reconciliation after a crash), writer lanes keep their branch for
  inspection, and a release refuses (409 `active_child_workers`)
  while a non-terminal child still owns one — whichever selector the
  caller used (job id, job lane, or the child lane itself). Parent/job
  eligibility is revalidated immediately before the lane, after the
  lane, after resident admission, after the pacing wait, and on boot;
  supervision-stopped/errored parents fence the child instead of
  starting a writer late. At boot, a child that never bound a session is
  re-run under the same identity (only when still eligible); one that
  had a live session is terminally failed with the honest reason (its
  transcript stays readable) — never a fabricated `done`. A supervision
  restart is REFUSED for a tracked child: a child is a single-run
  logical worker, and a replacement session would duplicate its result
  and put two writers in one lane; the parent requests a new child
  instead (the breaker/stop machinery still applies in full).

## 4f. Minion-owned build cycle (owner ruling 2026-10-02)

Implementation briefings hand the worker the whole job. The minion follows the
GC-owned workflow and explicit registered job context named in its system prompt.
Private operational material stays under the configured GC data home; approved
portable knowledge stays in the assigned `gru-output/`. Project conventions remain
applicable, but ambient BMAD skills/config cannot select GC execution authority.
Historical lane bindings and output references remain unchanged. The workflow's built-in
review runs on fresh, context-free reviewer contexts the minion
commissions as separately tracked review jobs — each with its own session
and worktree, a read-only brief, and the immutable diff head; never an
untracked launcher, an extension subagent, or a model-native child
session. The worker owns the cycle end to end (implementation, finding
resolution, verification, the authorized ordinary non-draft PR); Silas
gives goal/boundaries/acceptance, coordinates capacity and expensive
verification through the existing scheduler, and arms native Perkins on
the exact final settled PR head. NEEDS CHANGES returns to the same
implementing worker; the owner holds every merge.

**Policy vs implemented.** These obligations ship in the installed
playbook, and the deliverable kind is implemented: reviewer, artifact and
investigation dispatches carry `deliverable` (E19, `jobs.deliverable`)
and their handbacks are no longer classified as PR-overdue by the Silas
digest. Everything else here — reviewer tool confinement, automated
commission re-arm, escalation-notification repair — remains shipped
policy that the runtime does not fully enforce; do not read the playbook
as a runtime guarantee.

## 5. Release (the sweep)

`POST /api/dispatch/release` `{job_id, confirm_kill?, base_branch?}` —
the ordered, preserve-first sweep (ruling 18c):

1. **Preserve** untracked deliverables into the instance data dir
   (before anything else; deliverables are never hostages).
2. **Reap tracked services** — processes the orchestrator itself spawned
   for the lane (verification runs, recorded in the ledger with evidence
   `registry`) are signalled on teardown: process-group SIGTERM, grace,
   then SIGKILL. Dual-keyed on the live registry row AND a current
   in-tree enumeration, so a recycled pid can never redirect the kill.
3. **Enumerate** processes rooted in the tree: a process counts when
   the registered path appears in its ARGV as a whole path
   (path-boundary match — a sibling lane `job-a-2` is never confused
   with `job-a`) OR when the process's actual working directory is
   inside the tree (resolved via lsof on macOS / procfs on Linux; other
   platforms are argv-only, declared). Every pid a pause or confirmed
   kill is grounded on lands in the ledger's worktree-process records —
   the ask always names exactly what was live.
4. **Pause and ask** — any other live process pauses the sweep, records a
   needs-owner escalation (destructive steps require the owner's ruling),
   and touches nothing. `confirm_kill` is
   the human's answer to the RECORDED ask: it kills exactly the pids the
   pause put on the record (never a fresh enumeration — pids that
   appeared since were never acknowledged), with a SIGTERM grace before
   SIGKILL. Processes that survive both signals re-pause; processes that
   appeared after the acknowledged kill get their own ask.
   `confirm_kill` without a recorded pause is not honored — the ask
   always comes first. Silent kills do not exist for processes the
   orchestrator did not spawn.
5. **Remove** the worktree; **containment-verified** branch delete (a
   branch is deleted only when its commits are provably contained in an
   existing ref — otherwise it is retained and noted, never
   force-deleted).
6. **Re-resolve the fresh head** at release: follow-on work always
   starts from the current head, never a held sha.

## The worktree subsystem (ruling 18)

The dispatch flow rides a **worktree port** (`src/dispatch/worktree-port.ts`)
whose CONTRACT is documented in the interface and pinned by
`test/helpers/worktree-port-contract.ts` — lane ids ARE owner ids
(job/round), discovery is by job scope, statuses are exactly
active/paused/swept, unknown ids reject. Every implementation (the
in-memory double here, the manager on its lane) runs the contract:
the five-subsystem manager — bootstrap manifest, ledger-owned registry
(sweeps match registry paths only), the preserve-first sweep with
pause-and-ask, detached-for-reviews/branch-for-jobs, sequential
fresh-head creation — lands as its OWN review lane (`src/worktrees/`,
`docs/WORKTREES.md` on that lane). Until it merges, the core's port is
unavailable and dispatch fails loud, never silent.


## Ops follow-through (Silas, hosted; owner ruling 2026-09-21)

The Silas role is a HOSTED session: a supervised slot (`silas-ops`, the
gru-main / bob-consolidator pattern) woken by its driver
(`src/dispatch/silas-driver.ts`). The driver is the watchtower; Silas is
the judgment; the dispatch surface is the mechanical hand.

- **Wakes** fire on the events that matter (`job.delivered`,
  `job.minion-error`, `round.verdict`) plus a periodic sweep
  (`[silas] sweep_interval_ms`, default 5 min). A trigger arriving while a
  silas turn is open queues ONE latest trigger (the decisions runtime's
  one-slot replay) — never dropped, never stacked. A sweep wakes only
  when the digest's decision-relevant fingerprint CHANGED (issue #217):
  rows projected to identity + actionable fields (volatile timestamps,
  ages and session/lane paths excluded) so an identical operational
  state never re-wakes Silas — 88 % of sweep wakes used to carry a
  digest identical to the previous one. Rows appear when a lane crosses
  a due threshold (stall, queue timeout, recovery), so threshold
  crossings wake by construction. A recorded decision `recheck_at`
  passing since the last delivered wake also wakes (#218) — exactly
  once, and even when the digest is empty — and
  `[silas] unchanged_rewake_ms` (default 6 h; 0 = never) bounds a safety
  re-look at unchanged state. The fingerprint of the last DELIVERED wake
  persists in the `silas.wake-delivered` event (the `silas.wake`
  attempt marker still lands before the prompt, so #214's yield
  telemetry attributes Silas's in-turn actions to the wake that
  prompted them), and driver start seeds the gate from the newest
  delivered event, so a restart never re-wakes what Silas has already
  seen. A queued event trigger is never displaced by a later sweep —
  only a newer event supersedes it. Event triggers always deliver,
  whatever the gate says.
- **The GitHub signal poll (POLL-ONLY; owner ruling 2026-09-23)** rides
  the same driver on its own faster interval (`[silas] poll_interval_ms`,
  default 60 s; 0 disables) and needs no model turn: every tracked job
  branch is read through authenticated `gh api` (`repos/{o}/{r}/pulls`
  for merged state and `mergeable_state`;
  `repos/{o}/{r}/commits/{sha}/check-runs` for conclusions), batched one
  call per repo per tick where possible. Each observed state CHANGE
  applies exactly once: PR merged → `in-review → merged` transition plus
  a `github.pr-merged` event; PR conflicting (`mergeable_state: dirty`) →
  `github.pr-conflict` plus an fyi notification (mechanical tier — Silas
  owns the rebase within mandate; the conflict lands in his digest's
  `conflictingPrs` rows and never wakes Gru, issue #215); CI
  failed → `github.ci-failed` plus a notification carrying the run URL,
  routed by check kind (mechanical → fyi, judgment → wake-eligible
  action-required); CI green → `github.ci-green` review-gate signal.
  Dedupe is by the last recorded `github.branch-state` event — restarts
  re-read the same cursor, so nothing double-applies. The per-tick call
  budget keeps the poll under 40 % of the authenticated GitHub rate
  limit; a rate-limit response aborts the tick instead of hammering.
  Webhooks are not built (no inbound tunnel). The tier ladder is
  unchanged: no new autonomy. On the wake side (issue #219) a
  re-detected failing head under a fresh notification id is ONE incident
  (`github.ci-failed:<job>:<sha>` is the incident key) — the wake policy
  opens no second turn for it; a hold recorded through
  `POST /api/decisions` (issue #218) with a matching basis defers the
  wake to the hold's recheck instead.
- **The digest** handed to every wake carries the actionable states,
  computed from the ledger: delivered jobs with no PR registered; PRs
  whose follow-up delivery proves the lane head moved past the newest
  round's reviewed target (first review AND re-review after a fix round);
  or a proven `service_restart` abort on the unchanged delivered head,
  once per source round under `clean-abort-service-restart`. Other aborts
  and unchanged heads warrant no round. The re-arm is bound to the proved
  delivered head: an explicit `target_ref` must name that sha and an
  omitted one freezes it — a moved live PR head is never substituted — and
  the freeze boundary re-proves the delivered head is still the recorded
  one: a newer delivery during the awaited pre-flight refuses the stale
  re-arm (the next sweep offers the changed-head re-review instead). A
  review already REQUESTED for the current state retires the row —
  including the bmad-review fallback route, which creates no round and
  owns its own fix loop; a fallback that never engaged (`unavailable`)
  retires nothing, so a missing/again-repaired gate leaves the row due. A
  queued handoff that ends `failed`/`held`/`skipped` without arming a
  round answers nothing either. The clean-abort row retires only on a
  state that answered it: an armed Perkins round records the consuming
  `silas.review-triggered` rule/round receipt (a fallback, queued or
  unavailable route does not), while any other ACCEPTED review request
  still withdraws the offer. Failed attempts stay eligible: a 409
  deferral and a fallback that never engaged (`unavailable`) or ended
  `blocked`/`aborted` answer nothing, so the same abort reappears for the
  next sweep. Conflicting PR heads (issue #215) are digest rows too: a
  live PR-owing lane whose open head is dirty against its base is Silas's
  mechanical rebase work — suppressed while a directive, re-brief or
  verification owns the lane, and never a Gru wake. NEEDS CHANGES
  verdicts awaiting follow-through, with per-blocker recurrence analysis;
  working lanes whose minion has been silent past `stall_threshold_ms`;
  plus recent minion errors for context. Since issue #217 a wake prompt
  carries the digest DELTA — added, changed and resolved rows keyed by
  category + identity since the last delivered wake — plus the
  authenticated pointer `GET /api/silas/digest` (read-only, computes the
  current digest with the same seams the driver uses) and a
  `Digest fingerprint:` line so yield telemetry can attribute every
  wake to a stable digest identity. The first wake after a restart
  sends the full digest once; a failed wake never advances the delta
  baseline. The static operating brief — authority orders, ops surface,
  capture helper, recurrence policy, provider recovery and the skills
  pack — is injected ONCE per session (re-injected only when the brief
  hash changes, the session handle changes, or a compaction may have
  dropped it, including one that fired mid-turn); later wakes carry
  only the marker line `Operating brief unchanged (hash …)`.
- **The loop closes without a human ping**: on a delivered job, Silas
  finds the PR (transcript/`gh`), registers it
  (`POST /api/dispatch/pr … by=silas`), and triggers the wave
  (`POST /api/dispatch/review … by=silas`). Attribution lands as
  `silas.pr-registered` / `silas.review-triggered` ledger events.
- **The recurrence ladder (no hard round cap).** While blockers evolve,
  fix rounds re-enter review without limit. A changes-requested verdict
  awaiting follow-through always gets at least the first fix directive per
  blocker (a new blocker included — otherwise the lane could never
  re-open). A settled directive/re-brief turn lands as a `job.delivered`
  event carrying the lane head it produced; the digest only fires the
  re-review when that head moved past the round's reviewed target. When
  the SAME canonical blocker (fingerprint of normalized category, file
  path without line numbers, and normalized title — a line-number suffix
  never participates, so an edit that shifts the defect's lines keeps its
  streak; issue #216) recurs across consecutive verdict rounds, the digest names
  the rung and Silas executes it through `/api/silas/*`: `directive_at`
  (default 2) → fix directive to the implementing minion; `rebrief_at`
  (default 3) → re-brief a FRESH minion on the same lane; `escalate_at`
  (default 4) → action-required notification that wakes Gru to rule.
  Distinct defects sharing one file, category and title tie-break on a
  normalized hash of the finding's evidence — only inside that colliding
  group, so evidence churn never resets anyone else's streak. A rung marker
  is read kinds-scoped, so unrelated job traffic cannot age an
  already-handled verdict back into the digest.
  Escalation always beats an endless loop. Every rung lands as
  `silas.directive-sent`, `silas.rebrief`, or `silas.escalated`.
- **Restart safety.** A re-brief REQUEST is durable BEFORE any worker
  spawns (`pending_rebriefs`): a marker pair (`silas.rebrief` +
  `job.delivered`) that clears only when its guarded events land. A
  service restart mid-turn loses the worker but never the request — at
  boot the reconciler resumes the interrupted worker's session (or
  re-dispatches a fresh worker on the same lane) and records the missing
  events when that turn settles; a failed recovery escalates
  action-required and keeps the markers for the next boot, so the lane
  can never stall silently on a lost turn. A leftover marker whose job
  has since reached terminal (`merged`/`done`/`binned`) before the request
  was honored cannot be served: the boot scan — or a settling turn or
  re-dispatch boundary that meets the terminal job — retires it
  administratively (the identity-checked deletion and one
  `silas.rebrief-retired` audit commit together, with no spawn and no
  escalation); spent markers (both guarded events already landed) still
  clear as a completion, with no retirement audit. A malformed pair
  (missing kind or mismatched phase id, payload hash, or watermark) is
  instead retained and escalated for repair, even on a terminal job; it
  cannot be treated as one request or retired. The boot summary
  counts `examined` in markers but `completed`/`redispatched`/`retired`
  in jobs, so one retired pair reads `examined: 2 … retired: 1` by design.
- **Authority boundaries are unchanged** (`roles/silas.md`): dispatch,
  track, close; never product code; never merge; preserve before remove;
  escalate with pointers. Silas acts only through the authenticated ops
  surface — the pairing token is read from the instance config at call
  time, never echoed.
- **Skills** — `ops-dispatch` and `ledger-closeout` ship in-repo under
  `resources/silas-skills/` and are injected into the wake prompt (the
  delivery mechanism: Silas hosts at the workspace root, so plain project
  skill discovery does not apply; a clean install needs nothing else on
  disk). The files are the source of truth. Since issue #217 the whole
  static operating brief (orders, ops surface, capture helper, policies
  and the skills pack) is injected ONCE per session — a wake whose brief
  hash, session handle and compaction boundary are unchanged carries
  only the marker line `Operating brief unchanged (hash …)`; a brief
  change, a new session handle, or a `compaction_end` that may have
  dropped it re-injects exactly once.
- **Off switch** — `[silas] enabled = false` hosts no slot and fires no
  wakes; the `/api/silas/*` surface answers 503. Model and thinking come
  from config (`[models.roles] silas` / `[thinking.roles] silas`), never
  hardcoded.

## Wake-on-alert (owner ruling 2026-09-23)

Before this ruling the awareness pipe delivered service context into Gru
TURNS but never opened one. With `notify_wake = "never"` and nothing of
Gru running between user messages, an action-required alert sat unacked
until the owner pinged — proven by the 2026-09-23 morning observation.
Wake-on-alert closes that hole: a critical notification OPENS a Gru turn
by itself, and the turn is expected to ACT.

**Wake policy** (`[chat]`, see CONFIG.md). `wake-policy.ts` decides; the
awareness layer batches, persists, and calls the chat wake sink.

- **Routing gate** — `notify_wake = "action-required"` (default) wakes for
  machine-attention rows; `"all"` also wakes for FYI/needs-owner; `"never"`
  stays passive-only (context rides the next human turn).
- **Severity gate** — `wake_min_severity = "info" | "error"` floors a wake
  without changing routing.
- **Rate limit + coalescing** — `wake_min_interval_ms` (default 5 min)
  bounds autonomous turns; candidates inside the window coalesce into ONE
  trailing wake carrying the whole batch.
- **Quiet hours** — `wake_quiet_hours = "HH:MM-HH:MM"` (local time, may wrap
  midnight; default off) defers wakes to the next real local window end,
  including DST transitions. Admission is checked again after a queued
  user turn and immediately before a wake starts; no turn opens in-window.
- **Dedupe** — one wake per open notification id, persisted (`awareness.json`);
  open receipts are never evicted after an arbitrary number of other wakes.
  Closed IDs are pruned. A failed attempt consumes the configured interval
  (including across restarts) but never claims the notification ID.
- **Backlog migration** — existing routing is immutable: even legacy rows
  with owner-like kinds remain machine attention if recorded as
  `action-required`. Open machine rows seed bounded wake turns; an owner
  decision is a new explicit `needs-owner` post, never an automatic rewrite.
  All mode includes FYI/owner context too.

**Mechanics.** A wake calls the chat server's `wakeAwareness()`: when the
lane is idle it opens one ordinary turn whose prompt is the awareness
block plus the wake instruction, clearly marked `[gru awareness · service
context — not a user message]`. The single stream and single pen are
unchanged — the wake rides the same session and the same frame log as any
other turn (chat renders its machinery as a collapsed service band). A
wake requested mid-turn becomes one trailing turn; a wake with nothing to
inject neither spawns a session nor burns a model turn; a failed wake is a
durable notice, never a message-delivery error. Notification IDs stay
pending independently of the event cursor until a durable turn-start frame
confirms the prompt accepted a block containing those IDs. This receipt
survives sidecar-write failure because boot reconciles delivered IDs from
ledger `gru.wake` events. A later turn failure is logged separately without
re-waking an already delivered ID; pre-acceptance spawn/prompt failures
retry after at least five
seconds AND the configured wake interval. Long intervals use safe timer
slices rather than Node's overflowing timeout. Only the IDs actually present in the bounded block count as woken; overflow
travels in later, rate-limited turns. The backlog sink binds only after
listen, chat and board route attachment, and the foreign-listener check:
Gru's in-turn disposition API is available before any boot wake opens.
If unsafe chat recovery prevents delivery, a `gru.wake-failed` receipt and
an idempotent `needs-owner` stop ask for manual service recovery; the machine
IDs remain pending for rate-limited retry.

**Mandate — act (tier-2).** A wake is machine attention meant to be acted
on in-turn: Gru diagnoses the incident and takes one substantive step per
incident (a fix lane, a re-arm, a disposition) within budget, staging the
rest; novel failures and judgment calls stay with Gru. Gru holds merge
authority for this repository; the owner retains it elsewhere. The owner
is reached only through `needs-owner` — and sparingly; an empty FOR YOU
band is the healthy state.

**Routing split** (same ruling). Routing is the attention channel; `never`
disables autonomous wakes but still carries pending owner stops in Gru's
next user-directed context block:

| routing | meaning | surface |
|---|---|---|
| `action-required` | machine attention: Gru resolves/acts in-turn | NEEDS GRU queue (live rows only; terminal-job rows are closed receipts under FEED); wakes Gru; never rings the owner bell |
| `needs-owner` | owner-only decisions (merges outside this repo, budget, destructive ops) and anything Gru escalates | FOR YOU band + owner bell + morning digest |
| `fyi` | standing feed | board feed only |

**Unresolved follow-up.** A successful prompt is delivery, not resolution.
Open machine and owner stops remain eligible for bounded context in later
user turns even after the ledger event cursor advances; both routing classes
receive space when each has pending rows. No age-based owner escalation is
made: only Gru's explicit, justified `POST /api/notifications/needs-owner`
creates an owner stop. A machine disposition closes the original incident.

**Machine disposition.** A successful prompt is delivery, not resolution.
After acting on an `action-required` row Gru calls the authenticated
`POST /api/notifications/{id}/disposition` with a nonempty JSON `detail`
(the action taken or why no safe action was possible). The ledger records
`notification.resolved` by `gru` with the action detail; the endpoint refuses `needs-owner` and
FYI rows. The authenticated `/ack` API itself refuses machine rows, not
just the web UI. Both open machine alerts and owner stops remain in their
board bands regardless of newer feed traffic. Only the owner Ack clears
owner stops.

**Morning digest.** The first delivered block after `morning_digest_gap_ms`
(default 8 h; 0 disables) carries a ledger-derived "while you were away"
digest — fires (wake turns delivered), actions, merges, staged PRs — so the
chief catches up without the owner relaying anything. The persisted owner
watermark is independent of the wake/event cursor: overnight wake turns
never consume actions or fires from the next owner-directed digest.

**Observability.** Every delivered wake is logged, appended to the ledger as a
`gru.wake` event (a failed attempt or later failed turn adds `gru.wake-failed`),
and counted by the board's wake tracker. Delivery is not an action taken;
actual resolutions and job events must be counted separately.

**Silas mandate split** (same lane). Mechanical reactions move to Silas's
ops driver — re-arm review rounds after clean aborts, pattern respins for
known failure classes, sweep acks under recorded rules. Gru keeps the
judgments: rulings, merges, and novel failures. One standing rule from the
2026-09-23 freeze: never auto-arm a review round on a branch while a
rebase/force-push lane is active on the same target (the round races the
push and dies obsolete); arm only after the lane genuinely settles — the
attempt delivered AND no unresolved re-brief request standing (marker/
control settlement, not delivery alone; see the branch-idle guard
section). Service restarts remain manual until self-roll-34 lands.

## Bob (periodic memory)

Bob's consolidation trigger ships **disabled** (`[dispatch]
bob_interval_ms = 0`, issue #221): the due-based dream pass (Book of
Lessons) is the learning loop that feeds the crew — it reads journal
entries, including the blockers Perkins journals from every posted
review verdict — and an hourly knock mostly found nothing, writing
memory files no role prompt or code path reads. The trigger remains
available for installs that want it (any positive `bob_interval_ms`
enables; `0` disables): it knocks on the bob role's supervised slot
with consolidation instructions; the role's persona (`roles/bob.md`)
governs the craft. Never overlapping, never blocking a live operation.

## Self-roll (the service deploys itself)

The service rolls ITSELF — there is no shelf-stable restart path that a
non-interactive shell can drive safely by hand. Two triggers, one state
machine:

- `gru-service roll` (CLI; `dist/cli/service.js`, also the `gru-service`
  bin) — wait mode follows the roll to verified completion.
- `POST /api/roll` (operator-guarded, pairing token).

Both write a disk record at `<data_dir>/roll-state.json` and drive four
idempotent phases:

1. **preflight** — in the deploy clone (the checkout containing this
   `dist`): refuse a dirty tree; **refuse a foreign listener on the
   instance port** (owner incident 2026-09-23: a loopback squatter would
   make the post-swap `/health` verification read the wrong process —
   the roll fails loud + action-required before any pull/build);
   `git pull --ff-only` (divergence refuses,
   never resets); `npm ci` + `npm run build` + `npm run build:web` while
   the OLD process keeps serving (the build replaces files under `dist/`;
   the old binary holds its own inodes). The build stamps
   `dist/build-rev.json` (via `tools/write-build-rev.mjs`) with the
   checkout SHA; when the clone is already stamped at the target SHA the
   rebuild is skipped.
2. **drain** — bounded wait (`[roll] drain_timeout_ms`, default 15 min)
   for non-terminal review rounds (`pending`/`live`) and mid-turn agent
   sessions (`spawning`/`streaming`) to settle. Early settle → immediate
   swap. Deadline reached → the in-flight work is logged, recorded as
   `abandoned` in the roll record, and the swap proceeds; startup recovery
   terminalizes interrupted rounds INCOMPLETE and resumes interrupted
   turns (#42).
3. **swap** — re-check the target SHA, write `<data_dir>/roll-marker.json`
   (the built SHA), then exit with code **75**. The marker is the only
   handoff state — no launchctl/systemctl juggling, no TTY.
4. **verify** — the relaunched binary consumes the marker at boot: logs
   `rolled to <sha>`, flips the record to `done` with the boot pid + build
   sha, clears the marker, and logs a post-listen self-check
   (uptime + sha). `/health` reports the running build identity in the
   token-gated payload (`build: { rev, committed_at, built_at }`); the CLI exits 0 only
   once `/health` reports the target SHA **and the port's listener pid is
   the process that adopted the roll** (a squatter answering a matching
   `/health` is caught by pid, not trusted).

**Why exit 75 and not exit(0).** The shipped units are
`launchd KeepAlive {SuccessfulExit=false}` and `systemd Restart=on-failure`:
a clean exit is a stop and stays down, so a roll that exited 0 would leave
the service dead until a manual bounce. A non-zero maintenance exit is
restart-worthy for both managers while `launchctl unload` /
`systemctl stop` still stop the unit for real. Verified against launchd
with a scratch job (exit 0 stayed down; exit 75 relaunched).

**The bug this lane removes (diagnosed 2026-09-23).** `install.sh --update`
from an agent-owned shell used `launchctl unload`/`load` to restart the
unit. The service spawns agent sessions as ordinary children — same
process group as the launchd job / systemd cgroup. launchd teardown of a
job SIGTERMs every remaining process in that group (default
`AbandonProcessGroup=false`), so the updater was killed *during* `unload`:
the unit was left unloaded and the `load` that would re-register it never
ran. Reproduced with a scratch job: the in-group child trapped SIGTERM
during unload and never reached load; an out-of-group process (the human
terminal case) completed both calls and the service came back. The same
shape leaves a `/dev/tty` register prompt blocking forever on an
agent-owned pty.

**install.sh --update is now a client of this path.** When the updater
detects it is running inside the managed service's process group (the
service main pid IS the group leader), it delegates the restart to
`gru-service roll` and never calls `unload`/`load`; the register prompt is
skipped with an announced default instead of reading `/dev/tty`. Run from
a human terminal, the update path is unchanged.

**Rollback safety (no auto-rollback v1).** If the new build fails to boot,
launchd throttles (5 s `ThrottleInterval`) and systemd backs off
(`RestartSec`) while the existing alerts fire; the operator bails
manually — the old dist is git, so re-pulling/rebuilding and restarting
the unit restores service. The bail command is printed by the CLI on
failure. An in-service trigger (an agent running the roll as a tool call)
counts its own open turn as in-flight work; run the CLI from a terminal
or an outside shell to avoid waiting out the drain bound.

## Configuration

```toml
[worktrees]
# root = "/absolute/path"          # default: <data_dir>/worktrees
# preserve_root = "/absolute/path" # default: <data_dir>/worktree-preserves
# setup_timeout_ms = 120000

[dispatch]
# bob_interval_ms = 3600000        # ships 0: disabled — the due-based dream is the loop

[silas]
# hosted ops session (see "Ops follow-through" above); live by default
# enabled = true
# sweep_interval_ms = 300000
# stall_threshold_ms = 1800000
# directive_at = 2
# rebrief_at = 3
# escalate_at = 4

[roll]
# bounded drain wait before a self-roll swaps the build (0 = swap now)
# drain_timeout_ms = 900000

[verify]
# Verification scheduler (see §4c); lanes request runs, the service owns
# the machine's one global test budget.
# max_concurrent = 1               # concurrent runs; further requests queue FIFO
# worker_budget = 0                # total test workers across runs; 0 = auto (cores - 2)
# lock_wait_timeout_ms = 900000    # queued request past this fails loud
# run_timeout_ms = 1800000         # per-run wall clock; expiry kills the process group
```
