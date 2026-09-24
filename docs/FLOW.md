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
                      │                                                   7/6 lens types × chunks
                      │                                                   verify + audit
                      │                                                   report → PR comment
 release ◄─────────── sweep (preserve-first)                            (chips live on the board)
```

## 1. Briefing (Gru, chat-side)

The user brings intent; Gru consults and settles the plan
(plan-before-heist is Gru-side canon). The output is a briefing a
stranger could execute: goal, boundaries, acceptance, verification.

## 2. Ops handoff (dispatch)

`POST /api/dispatch` `{job_id, repo_path, title, briefing}` — the
mechanical handoff behind the chat surface:

1. **Job row** — briefing recorded verbatim; status `dispatched`.
2. **Lane** — one git worktree per job on branch `gru/<job>` at the
   CURRENT fresh head (worktree manager, below). Status `working`.
3. **Minion** — a fresh agent session spawned with `cwd` = the worktree
   (SPEC ruling 17: dispatch cwd is the PROJECT root on every runtime;
   the minion discovers the project's own skills/bmad from there). The
   briefing prompt is delivered as the session's first turn.

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

`POST /api/dispatch/review` `{job_id, target_ref?, no_spec?}` freezes one
exact target/base/diff/spec set in a detached review worktree. The arm
first passes the **branch-idle guard**: while any lane is actively
working/pushing the target branch (`dispatched`/`working` with no settled
delivery for its current attempt), the API answers `409 branch_busy` with
`blockers: [{job_id, status, branch}]` and the same check re-runs
immediately before the freeze, so a lane re-opened mid-setup is refused
the same way. The arm passes once the lane delivers. `force: true` is the
human override; a forced round is tagged in its frozen manifest
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
one real Perkins lead and exactly seven required lens types per frozen diff
chunk (blind, edge, acceptance, security, architecture, codebase, tests), or
six types per chunk only when `no_spec: true` explicitly removes acceptance.
Each lens/chunk attempt is a distinct tracked child; malformed attempts are
retryable up to the policy limit, so the total child-session count may exceed
the required coverage cardinality.

- The lead receives only six product-native tools: read a frozen chunk,
  run tracked lens children, store bounded notes, record a candidate
  decision, preflight a candidate terminal submission, and submit terminal
  proof. It owns delegation,
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
  its six orchestration tools; a lens child that declares native tools
  gets only its own (the `perkins_submit_findings` channel) and never sees
  the lead's six. That seam is harness-independent by design — review
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
  verifies exact coverage, candidate ownership,
  frozen-commit evidence, prior audit, source stability, report contents,
  delivery, and canonical blocker arithmetic. Zero blockers is READY TO
  MERGE, 1–3 is NEEDS CHANGES, and 4+ is MAJOR REWORK NEEDED. Warnings and
  notes never block.
- A malformed child output consumes one attempt and may be retried within the
  pinned bound. Any exhausted attempt, cancellation, restart, changed
  source/checkout, unsupported evidence, invalid audit, missing coverage,
  or delivery failure durably terminalizes the round as INCOMPLETE. It can
  neither post nor record approval. Startup reconciliation marks interrupted
  rounds INCOMPLETE and releases their owned detached lanes.
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
   token valid for the exact repository remote, used for SHA-bound verdict
   delivery. Only GitHub and GitLab hosts are supported; other origins fail
   the leg closed (credentials are never sent to unknown hosts).
4. **Review policy enabled** — `[review] enabled = true` in config.

All legs pass → Perkins review (the gate). Any leg fails → the request
routes to the bmad-review skill **if installed** (never bundled with the
product). The fallback carries FULL GATE semantics: the session returns
findings; the host triages them (release-safety categories — correctness,
security, data loss, broken builds, and related crash/regression/
vulnerability/injection/secret-leak tags — are BLOCKERS; the rest are
notes); BLOCKERS > 0 routes a fix directive to the implementing MINION
session, the lane's working diff is re-read, and the gate re-reviews after
fixes (bounded rounds); 0 blockers = PASS reported as clear-to-merge. The
fallback session is a full-capability minion by design — it must load the
ambient BMAD skill — and is instructed never to gate, approve, merge, or
modify implementation code; every gate decision is the host's. The fallback
never records a Perkins verdict and never moves merge authority: only an
exact-head Perkins READY can authorize a merge, and merge stays user-held
everywhere. A failed pre-flight is never a silent downgrade — the failed
legs, their remediations, and both recovery options (install BMAD via
onboarding / restore Perkins) are escalated and recorded on the job as
`job.fallback-review` events. GitLab merge requests get the same SHA-bound
delivery discipline as GitHub (the frozen HEAD is verified before a note is
posted; a PR's recorded base is refreshed into the delivery record rather
than gating, since a pinned base is expected to trail a moving main), and
the GitLab probe and poster resolve their token
identically (`GITLAB_TOKEN`, falling back to `GL_TOKEN`); GitHub
authenticates through the `gh` CLI.

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
- **One worker budget across runs.** Total test workers stay within
  `[verify] worker_budget` (default: CPU cores − 2), enforced by the run
  wrapper through the vitest pool knobs and `GRU_VERIFY_*` variables for
  other runners.
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
- **Progress streams** back as NDJSON: `queued` → `started` → `output…`
  → `completed` (or `error`).

Managed repos still own their CI: this endpoint coordinates LOCAL
verification runs inside lane worktrees — the orchestrator never hosts a
tenant's CI.

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
  one-slot replay) — never dropped, never stacked.
- **The GitHub signal poll (POLL-ONLY; owner ruling 2026-09-23)** rides
  the same driver on its own faster interval (`[silas] poll_interval_ms`,
  default 60 s; 0 disables) and needs no model turn: every tracked job
  branch is read through authenticated `gh api` (`repos/{o}/{r}/pulls`
  for merged state and `mergeable_state`;
  `repos/{o}/{r}/commits/{sha}/check-runs` for conclusions), batched one
  call per repo per tick where possible. Each observed state CHANGE
  applies exactly once: PR merged → `in-review → merged` transition plus
  a `github.pr-merged` event; PR conflicting (`mergeable_state: dirty`) →
  `github.pr-conflict` plus an action-required cascade notification
  (mechanical tier — Silas may arm a rebase lane within mandate); CI
  failed → `github.ci-failed` plus a notification carrying the run URL,
  routed by check kind (mechanical → fyi, judgment → wake-eligible
  action-required); CI green → `github.ci-green` review-gate signal.
  Dedupe is by the last recorded `github.branch-state` event — restarts
  re-read the same cursor, so nothing double-applies. The per-tick call
  budget keeps the poll under 40 % of the authenticated GitHub rate
  limit; a rate-limit response aborts the tick instead of hammering.
  Webhooks are not built (no inbound tunnel). The tier ladder is
  unchanged: no new autonomy.
- **The digest** handed to every wake carries the actionable states,
  computed from the ledger: delivered jobs with no PR registered; PRs
  whose follow-up delivery proves the lane head moved past the newest
  round's reviewed target (first review AND re-review after a fix round;
  an unchanged head warrants no round; and a review already REQUESTED for
  the current state retires the row — including the bmad-review fallback
  route, which creates no round and owns its own fix loop); NEEDS CHANGES
  verdicts awaiting follow-through, with per-blocker recurrence analysis;
  working lanes whose minion has been silent past `stall_threshold_ms`;
  plus recent minion errors for context.
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
  the SAME canonical blocker (normalized category/location/title
  fingerprint) recurs across consecutive verdict rounds, the digest names
  the rung and Silas executes it through `/api/silas/*`: `directive_at`
  (default 2) → fix directive to the implementing minion; `rebrief_at`
  (default 3) → re-brief a FRESH minion on the same lane; `escalate_at`
  (default 4) → action-required notification that wakes Gru to rule.
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
  can never stall silently on a lost turn.
- **Authority boundaries are unchanged** (`roles/silas.md`): dispatch,
  track, close; never product code; never merge; preserve before remove;
  escalate with pointers. Silas acts only through the authenticated ops
  surface — the pairing token is read from the instance config at call
  time, never echoed.
- **Skills** — `ops-dispatch` and `ledger-closeout` ship in-repo under
  `resources/silas-skills/` and are injected into every wake prompt (the
  delivery mechanism: Silas hosts at the workspace root, so plain project
  skill discovery does not apply; a clean install needs nothing else on
  disk). The files are the source of truth.
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
  midnight; default off) defers wakes to the window's end.
- **Dedupe** — one wake per open notification id, persisted (`awareness.json`);
  open receipts are never evicted after an arbitrary number of other wakes.
  Closed IDs are pruned. A failed attempt consumes the configured interval
  (including across restarts) but never claims the notification ID.
- **Backlog migration** — before scanning old unacked rows, persisted
  provider/credential stops, supervision breakers and foreign-listener /
  destructive-op stops are moved to `needs-owner` only while unacknowledged.
  Historical human Acks are retained: an already re-armed breaker must not
  ring again. Remaining open machine rows seed bounded wake turns; all mode
  includes FYI/owner context too.

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
arms the unresolved-attention deadline immediately, even if Gru's turn is
still running or hung. A later turn failure is logged separately without
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
| `action-required` | machine attention: Gru resolves/acts in-turn | NEEDS GRU queue; wakes Gru; never rings the owner bell |
| `needs-owner` | owner-only decisions (merges outside this repo, budget, destructive ops) and anything Gru escalates | FOR YOU band + owner bell + morning digest |
| `fyi` | standing feed | board feed only |

**Unresolved follow-up.** A successful prompt is delivery, not resolution.
Open machine and owner stops remain eligible for bounded context in later
user turns even after the ledger event cursor advances; both routing classes
receive space when each has pending rows. If a delivered machine alert remains unresolved
for 30 minutes, a durable one-time `needs-owner` follow-up rings the owner bell
without re-waking that ID. The due time survives restart; a later Gru
machine disposition resolves the follow-up automatically. Normal machine
alerts never ring the owner bell merely for being posted.

**Machine disposition.** A successful prompt is delivery, not resolution.
After acting on an `action-required` row Gru calls the authenticated
`POST /api/notifications/{id}/disposition` with a nonempty JSON `detail`
(the action taken or why no safe action was possible). The ledger records
`notification.resolved` by `gru`; the endpoint refuses `needs-owner` and
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
push and dies obsolete); arm after the lane delivery settles. Service
restarts remain manual until self-roll-34 lands.

## Bob (periodic memory)

Bob's consolidation trigger runs on the configured interval
(`[dispatch] bob_interval_ms`, default hourly; `0` disables): it knocks
on the bob role's supervised slot with consolidation instructions; the
role's persona (`roles/bob.md`) governs the craft. Never overlapping,
never blocking a live operation.

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
# bob_interval_ms = 3600000        # 0 disables Bob's trigger

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
