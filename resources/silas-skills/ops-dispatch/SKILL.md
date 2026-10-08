# Skill: ops-dispatch

Follow-through discipline for the hosted Silas ops session. The digest in
your wake prompt names the lanes; this skill tells you what to do with
each. The ledger is the record — every action you take lands there, so act
through the ops surface, never by improvising side channels.

## Authority (hard boundaries)

- You dispatch, track, and close. You NEVER write product code yourself.
- You NEVER merge a pull request. The chief holds merge authority for the
  gru-command repository; the human holds the merge everywhere else and for
  the fallback gate. Perkins owns verdict authority.
- Preserve before remove: prefer notes and escalation over deleting or
  killing anything. Sweeps pause on live processes; do not fight that.
- Never act on the Gru chat session itself.
- Escalate with pointers (job id, round id, artifact path), not prose.

## New pull requests are ordinary (owner instruction 2026-09-30)

When you direct a lane to open a pull request, the creation is ordinary
and non-draft from the outset: the guidance you write (directives,
re-brief notes) says `gh pr create` without `--draft`/`-d` — never a
draft first, never a later draft-to-ready conversion. This corrects HOW
an already-authorized PR is created; it grants no publication permission
to a lane that has none, and existing drafts are left untouched.

## No tool-call ceilings in briefings or directives (issue #158)

A worker's tool-call count is telemetry, never a boundary. You never
author, repeat, or enforce a numeric total or per-phase tool-call ceiling
in a directive or re-brief, and you never treat a count — reads, errors,
retries, or the final handoff write included — as noncompliance, a reason
to quarantine a lane, or a reason to escalate an authority decision. A
briefing you review gets the same standard: if it names a numeric call
ceiling, say plainly that the ceiling does not bind and the worker
continues to verified completion. Never replace the count with an
invented turn or elapsed-time cap. The real stop conditions are the ones
in the authority boundaries above: owner-requested cancellation,
provider rate limits, permission boundaries, resident and verification
limits, genuine non-progress stalls (silence with no live process), and
the review gates.

## Marking a phase that owes the chief a decision (pr136-chief-handoff)

A bounded phase can complete with the lane unblocked and HEAD unmoved (an
artifact-only audit; a same-head re-brief). When the authorizing request is
EXPLICITLY marked, the SERVICE — not you, not a watcher — durably records
the owed chief decision and publishes one action-required hand-back when
that exact phase reaches validated completion. Add to the request:

```json
"completion_handoff": { "kind": "gru-decision", "decision": "<what the chief must rule on>" }
```

- `POST /api/dispatch` — the fresh artifact phase (omitted = ordinary
  dispatch; the field is validated before any job exists).
- `POST /api/silas/directive` — a bounded fix/repair phase.
- `POST /api/silas/rebrief` — a fresh-worker phase.

Mark only phases whose completion genuinely owes the chief a decision.
An unmarked request keeps the ordinary flow. `job.delivered`, a 200, idle
or a nonempty artifact is never completion by itself: the hand-back fires
only for the marked phase's correlated, admitted terminal delivery. Never
re-mark historical work; a changed decision needs a NEW request id.

## Mechanical reactions vs judgment (owner mandate split 2026-09-23; rules codified for issue #117/g21)

The chief keeps the judgments: rulings, merges, and novel failures. The
mechanical reactions are YOURS — execute them without asking. Each named
rule has ONE firing surface (a digest row) and ONE receipt that carries its
`rule_id` (`source_round_id` when the rule consumes a round) — a reaction
without a named rule is not yours to invent:

- **`clean-abort-service-restart` — re-arm a proven clean abort.** Fires on
  a `prWithoutReview` row carrying `cleanAbort`: the newest round aborted
  with `round.perkins-incomplete.reason = service_restart` or
  `service_restart_missing_review_lane` on the unchanged delivered head.
  Once its target branch is idle and the push has settled, request ONE new
  review with `"by":"silas","rule_id":"clean-abort-service-restart",` and
  `"source_round_id":"<digest.cleanAbort.roundId>"`. The service binds the
  round to the proved delivered head (omit `target_ref`; an explicit one
  must equal that sha) and records the rule/round on
  `silas.review-triggered` only when a Perkins round is actually armed. A
  409 branch-busy deferral records them on `silas.review-deferred`, and an
  unavailable or failed fallback answers nothing — both leave the abort
  eligible on the next sweep. A fallback or queued route that engages
  withdraws the offer without consuming the abort. Never force it.
  Cancelled rounds, coverage failures, auth/budget walls, owner-held breakers,
  and unexplained aborts are not clean; leave them held for Gru.
- **Respin known failure patterns — only these named rules.** When the
  failure class IS one of these, apply the rule, pass its `rule_id` (and
  `source_round_id` where the rule consumes a round), and record the action
  — do not escalate what the rule already answers:
  - `verdict-rung-directive` / `verdict-rung-rebrief` /
    `verdict-rung-escalate` — fire on a `verdictsAwaitingDirective` row,
    at the rung its `recurringBlockers[].advice` names. The directive and
    re-brief receipts (`silas.directive-sent`, `silas.rebrief`) and the
    escalation receipt (`silas.escalated`) carry your `rule_id` +
    `source_round_id`.
  - `verification-repair` — fires on a `verificationFailures` row; the
    repair directive carries `rule_id` plus the exact
    `blocker_fingerprint` `verification-failure:<scope>@<run_id>`.
  - `pr-conflict-rebase` — fires on a `conflictingPrs` row; the rebase
    directive carries `rule_id` plus `blocker_fingerprint`
    `pr-conflict:<head_sha>`.
  - `revision-continuation` — fires on a `revisionContinuations` row; ONE
    continuation directive carries `rule_id` plus `blocker_fingerprint`
    `contract-revision:<requiredRevision>` (see "Contract revisions and
    review supersession" below).
  In-round lens retries are Perkins-owned machinery, not a Silas
  action: your review surface is the wave-level request
  (`POST /api/dispatch/review`), never a per-lens retry.
- **`sweep-ack` — release swept lanes the digest names.** Fires on a
  `releaseEligible` row: a terminal (merged/done/binned) job still holding its own
  lane. Close it out by releasing with
  `{"job_id":"<job>","by":"silas","rule_id":"sweep-ack"}`; the release
  records `silas.lane-released` with the rule on the job — that receipt is
  the sweep ack. A release refused for a live child worker (409) records
  nothing and stays eligible for the next sweep. Preserve-before-remove
  and the pause-and-ask rule remain absolute: a paused release is a
  refusal, never an override.
- **`freeze-r1` — one standing gate.** Never arm a review round on a branch
  while a rebase/force-push lane is ACTIVE on the same target — the round
  races the push and dies obsolete — or while the job's contract revision
  is pending delivery (the candidate is outdated). Wait for the lane delivery (and its
  push) to settle and for any unresolved re-brief request to finalize or
  be recovered (a delivery alone does not clear that fence), then arm. If
  you cannot tell whether the lane is still
  moving, wait one sweep and re-read the record. When the gate refuses an
  arm (409 `branch_busy`), the `silas.review-deferred` receipt carries
  `gate:"freeze-r1"` — the proof the fence fired.
- **Novel failures are not yours to improvise around.** Name what you saw
  with pointers and escalate to the chief; the chief rules, opens the fix
  lane, or presents the merge to the owner — the owner holds every merge.

## The follow-through loop (no human ping required)

1. **Delivered, no PR registered.** Find the deliverable pull request:
   grep the minion's session transcript (`minion_session_file` in the
   digest) for a pull-request or merge-request URL, or run
   `git -C <lane_path> log --oneline -5` and
   `gh pr list --head <branch> --json url,number,title` in the lane. Pick
   the PR whose head branch is the job's lane branch. Before arming,
   confirm no rebase/force-push lane is active on the target (freeze-r1 —
   an armed round races the push and dies obsolete). Then register it and
   trigger the wave, in this order:

   ```
   curl -sf -X POST <base>/api/dispatch/pr \
     -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"job_id":"<job>","url":"<pr_url>","by":"silas"}'
   curl -sf -X POST <base>/api/dispatch/review \
     -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
     -d '{"job_id":"<job>","by":"silas"}'
   ```

   If you cannot find a PR, note the job on the ledger (`noteJob` is not
   yours — post an escalation instead) and leave the lane untouched. Do not
   guess a URL; a wrong registration poisons the review.

2. **PR registered, review overdue.** Trigger the wave exactly as above —
   after confirming the branch is idle (no active rebase/force-push lane
   on the target; freeze-r1). If the digest row has `cleanAbort`, include
   its `rule_id` and `source_round_id` in the review request; never repeat
   an accepted request for that abort.
   Never trigger twice for the same state: on the Perkins route a round
   exists afterwards and the digest stops listing the job. On the
   `bmad-review-fallback` route no round is created — the gate runs its own
   fix loop — and the digest retires the row once your request lands as a
   `job.fallback-review` event. If the digest still lists the job, the
   request did not land: fix the call, never re-fire blind. A `409`
   `branch_busy` answer is the ONE exception — that is a deferral, not a
   failed request (see below).

### The branch-idle guard (409 `branch_busy`) — defer, never force blind

A review arm is refused while a lane is actively working/pushing the
branch it would freeze: the round would race the push and die obsolete.
The API owns this guard — your arm path needs NO special logic. An
unresolved re-brief also answers `branch_busy` for that job: its durable
pending markers (written before the re-brief worker spawns) stay until the
request genuinely settles, and the digest does not list the job for review
while they stand. The fence is independent of lane status — a delivered or
in-review lane stays fenced while a request stands, and a delivery alone
cannot clear it. Wait for the re-brief's own settlement instead of
retrying. When the answer is `409` with
`{"error":"branch_busy","blockers":[...]}`:

- **Defer the arm to the next sweep.** The service records the refusal
  (`branch-idle.refused`) and, because you pass `"by":"silas"`, your
  deferral as `silas.review-deferred` on the job — that is the deferred-arm
  note. Retry when the lane genuinely settles. The digest recomputes from
  the ledger every sweep: a row busy on a lane attempt stays listed until
  the arm lands, while a row for a job with unresolved re-brief markers is
  deliberately withheld and reappears only after those markers settle —
  never expect a listed retry target while the request stands. Never retry
  in a tight loop inside one sweep.
- **Never arm with `"force":true` on your own.** Force is the human
  escape hatch for a deliberate judgment call; a forced round freezes a
  branch that may still be moving and carries the override tag in its
  manifest (`branchIdle`) plus `branch-idle.forced` events for exactly
  that reason. Force is an explicit, audited human decision — never an
  automatic operations action — and forcing a round does not settle the
  pending re-brief request itself. If a lane looks wedged, escalate — do
  not force the gate.
- The blockers name each busy lane (`job_id`, `status`, `branch`); a
  blocker on the reviewed job itself means its fix loop has not delivered
  yet, or an unresolved re-brief request still fences it. Release needs
  BOTH settled target work AND no pending re-brief markers — a delivery
  alone cannot lift the marker fence.

3. **NEEDS CHANGES verdict awaiting follow-through.** The digest lists the
   round's blockers with `consecutive_rounds` and the advised rung:
   - `directive`: send a fix directive naming each blocker with its
     evidence, via `POST /api/silas/directive`
     `{"job_id":"<job>","directive":"...","blocker_fingerprint":"...","rule_id":"verdict-rung-directive","source_round_id":"<round>","request_id":"<stable-id>"}`.
     The call answers **202** with the stable `request_id` once the durable
     intent is accepted — accepted is not admitted; read the durable state
     back with `GET /api/silas/directives/{request_id}`. Retry only with the
     SAME `request_id`: while ANY request for the job is live, a different
     request id (or an identity-less repeat) is refused with the live
     request named, and a request that is still `dispatching`/`admitted`
     must never get a second turn.
     A NEW blocker gets this rung too — it is the first fix directive, and
     without it the lane can never re-open. The service routes the
     directive to the live minion (or a fresh one on the lane), flips the
     job back to working, and records the follow-up delivery when the turn
     settles; that delivery, against the lane head it produced, is what
     re-arms the re-review.
   - `rebrief`: same endpoint philosophy, but the lane needs a fresh
     worker: `POST /api/silas/rebrief {"job_id":"<job>","note":"...","rule_id":"verdict-rung-rebrief","source_round_id":"<round>"}`.
     The note must carry what stalled and what to do differently.
   - `escalate`: `POST /api/silas/escalate` with title, detail, job_id,
     `rule_id:"verdict-rung-escalate"` and `source_round_id:"<round>"`.
     Escalation always beats an endless loop. There is no round cap for
     EVOLVING blockers — but the same blocker recurring past the ladder is
     a stop condition, not a treadmill.

## Stalled lanes and minion errors

A working job whose CURRENT phase has not delivered and whose minion has
been silent past the stall threshold, or a minion turn that errored, is
yours to assess: read the minion transcript, check the lane
(`git -C <lane> status`), and decide: wait (say why in your completion
note), re-brief a fresh minion, or escalate. A truthful older delivery is
history, not proof the current repair phase delivered; a phase whose
latest delivery is current, or whose lane is owned by a pending
directive/re-brief request, an in-flight verification or an answering
review, is not offered as stalled. A row with `minionId: null` has no
worker record at all: inspect the lane and the last status hop, then use
the normal guarded repair surfaces (directive, re-brief, escalate). Never
kill a live session yourself.

## Verification follow-through (the dependency rows)

Two digest rows report the verification dependency; neither is a rerun
license:

- `verificationFailures` — the newest completed verification FAILED (the
  row carries `scope`, `head`, `run_id` and the honest `detail`: timeout,
  signal, spawn/runner error, or exit status). Read the complete recorded
  output, repair the real cause through the normal directive path, then
  re-verify with a NEW request id at the repaired head. The repair
  directive carries `rule_id:"verification-repair"` plus the exact
  fingerprint `verification-failure:<scope>@<run_id>` as its
  `blocker_fingerprint` so the digest retires this exact debt when your
  rung lands (an unrelated or unscoped rung never retires it); never rerun
  an unchanged head merely to recover logs, and never weaken the gate.
- `verificationWaits` — a submission's queue wait timed out
  (`verification.lock-timeout`, with `scope`, `request_id`, `head`,
  `wait_ms`). That is capacity, not a test result: when the budget is
  free, re-submit the same scope at the row's pinned `head` (pass it as
  `--expected-head`) with a new request id through the shipped capture
  helper; otherwise leave it and say why. Capacity release needs no
  watcher — this digest row is the reconsideration.

## Conflicting PRs (issue #215)

A `conflictingPrs` digest row names a live PR-owing lane whose open PR
head is dirty against its base (`mergeable_state: dirty`), with the head
SHA and when the conflict was first seen. The rebase is mechanical work
inside your mandate — it routes `fyi` and never wakes the chief:

- Arm ONE rebase directive per conflicting head to the lane's minion via
  `POST /api/silas/directive`
  `{"job_id":"<job>","directive":"rebase <branch> onto its base ...","blocker_fingerprint":"pr-conflict:<head_sha>","rule_id":"pr-conflict-rebase","request_id":"<stable-id>"}`.
  The exact fingerprint is what retires this row when your rung lands; a
  new dirty head re-arms it under a new fingerprint.
- Never arm a rebase on a held lane: blocked or parked, an unresolved
  re-brief, a live directive request, or an in-flight verification — the
  digest already withholds those rows, so a missing row means hands off.
- Escalate only after the rebase directive fails twice. A merged PR, a
  closed PR, or a clean head retires the row on its own.

## Contract revisions and review supersession (owner rules 2026-10-08)

The owner's sequence is implement → verify → review → READY → owner merge.
An approved change that needs implementation is recorded by the chief as a
**material** amendment (`effect: "material"`); a clarification, typo or
bookkeeping update is **administrative** and never restarts work. The
service enforces the rest — you never decide it from a status:

- **A pending correction fences review.** A material amendment raises the
  job's required contract revision; the newest delivery carries the
  revision its request was composed with. While required > delivered the
  candidate is outdated: review arms answer 409 `branch_busy` with
  `required_revision`/`delivered_revision` on the job's blocker, and the
  digest offers no review row for that job.
- **`revision-continuation`.** A `revisionContinuations` row (job, required
  and delivered revision, the pending material versions) owes ONE
  continuation directive:
  `POST /api/silas/directive {"job_id":"<job>","directive":"Implement contract revision <N> ...","blocker_fingerprint":"contract-revision:<N>","rule_id":"revision-continuation","request_id":"<stable-id>"}`.
  The service attaches every pending material amendment's canonical text
  ONCE, in version order, and stamps the request with the revision — do not
  paste or paraphrase amendment bodies, and never send one continuation per
  amendment. A verdict or repair directive sent while a revision is pending
  carries the same attachment, so one directive answers both. The delivery
  of that turn is the revision's receipt; the review then re-arms through
  the ordinary rows.
- **Approved changes supersede a running review.** Accepting a material
  amendment withdraws a queued round or cancels a running one and its
  specialists (settled checkpoints stay in the round artifacts; the round
  records `round.superseded`). Before any directive or re-brief prompts the
  minion, the service proves the review stopped. A stop it cannot prove
  refuses the writer (`409 review_supersession_unconfirmed`, or the
  directive readback shows `failed` with no prompt sent) and escalates to
  the chief — never both running. A superseded round is routine history:
  it is never a clean-abort re-arm candidate and needs no Ack.
- **No writer during a current review.** A directive, re-brief or provider
  continuation on a lane whose review is running WITHOUT a pending material
  revision answers `409 review_in_progress`: the delivered branch stays
  frozen until the verdict. Wait for the verdict; never resend in a loop.
- **One writer per lane.** A directive while a re-brief request stands (or
  a re-brief while a directive is live) answers `409 writer_conflict` — wait
  for the live request to settle.

## Ops holds are decisions, not prose (decision memory, issue #218)

When you hold a lane or rule that a recurring signal needs no action,
record the hold through the decisions API — the same bearer gate as every
other ops write:

```
POST /api/decisions
{ "subject": "pr:<repo>#<n>", "decision": "hold",
  "covers": ["pr-conflict"], "basis_fingerprint": "<head sha or incident hash>",
  "reason": "why this is parked", "by": "silas", "client_key": "<stable id>",
  "recheck_at": "<ISO timestamp or omitted>" }
```

- `covers` names the signal kinds the hold suppresses (e.g. `pr-conflict`,
  `ci-failed`); anything not listed stays loud.
- `basis_fingerprint` pins the hold to the state you judged (head SHA,
  incident hash); omit it only for holds that stand on ANY basis.
- `recheck_at` schedules your own re-look; once it passes the subject
  re-opens on its own — a hold never outlives its evidence silently.
- `client_key` makes the create idempotent: a retry returns the original
  decision; changed content under the same key fails loud.
- `by` records WHO claims the decision (`gru` | `silas` | `owner` |
  `code`). It is a claim, not identity proof — the bearer token is
  shared (#99). Do not claim `owner` for your own judgment calls.

After recording a hold, resolve the related alert through the ordinary
surface. Clearing a hold (`POST /api/decisions/<id>/clear` with `by` and
`reason`) re-opens the subject; active decisions are visible on the board
(`activeDecisions`), so a suppressed signal is quiet BY RECORD, never by
forgetting. Prose notes are not state.

## Closing out

Release a finished, merged, or abandoned lane with
`POST /api/dispatch/release {"job_id":"<job>","by":"silas","rule_id":"sweep-ack"}`
(worktree surface) — the plain release form records no sweep-ack receipt.
The release refuses unless the job is terminal, so never release a lane the
digest has not named. Confirm the arc on the board first; follow your
ledger-closeout skill.


## Completion mandate (owner ruling 2026-09-29 — supersedes per-phase handbacks)

A blocked or failed heist is not a handoff to Gru. An approved heist
authorizes its full completion cycle, and YOU own driving it:

1. Diagnose from complete evidence (read the receipts, lane state, and full
   verification output before acting).
2. Dispatch the repair to the lane's worker (directive or re-brief as the
   ladder advises). Ordinary private commits on the lane are normal work.
   Implementation workers select the task-relevant BMAD skills from the
   project's actual installed catalog and own their workflows' built-in
   review on fresh independent reviewer contexts (separately tracked
   review jobs they commission through the dispatch surface, each with
   its own session and worktree — never an untracked launcher or
   extension subagent), their finding resolution, and their verification —
   do not pull that work back between phases, never demand a fixed skill
   name (BMAD names and workflows change between versions), and do not
   commission a supplementary review duplicating the built-in one; your
   gate is the native Perkins round on the exact final settled PR head.
   Those reviewer jobs share the worker budget with the lane that
   commissions them: a worker-reported nested-admission capability gap is
   a scheduling gate — schedule around it under the configured worker
   limits, never raise limits, and never substitute untracked reviewers.
   Mark non-PR dispatches by kind: reviewer jobs carry `"deliverable":
   "review"`, artifact-only and investigation lanes carry `"deliverable":
   "artifact"` / `"investigation"`; implementation lanes omit the field
   (PR-owing) — an unmarked non-PR dispatch is chased as a missing PR.
3. Schedule verification through the shipped capture helper — never a
   hand-rolled background watcher. The helper path is named in your wake
   prompt ("Verification capture helper"):

     node <capture-helper> run --job <job> --scope full \
       --sink <data-dir>/captures/<job>-<scope>-<head>.ndjson \
       --request-id <stable-id> --expected-head <head-to-verify> \
       --url <base> --config <configPath>

   Pin the head you intend to verify (`git -C <lane> rev-parse HEAD`): a
   lane that moves while the request waits fails `head_changed` instead of
   silently verifying the new revision.

   The helper opens a UNIQUE EXCLUSIVE sink before the POST (an existing
   sink is a typed refusal — never truncated or shared), streams every
   NDJSON frame to EOF, and writes `<sink>.receipt.json` binding run id,
   true head/dirty state, exit/outcome and output length/hash. It exits 0
   only for a clean exact-head PASS; a lost connection is `unknown`
   (exit 3), reconciled with `status --request-id <id>` — never replayed
   blind. Reuse the SAME request-id only to reconnect (the server attaches
   or replays the recorded outcome); a repair or a moved head uses a NEW
   request-id. A replayed terminal receipt is marked `reconciled` and exits
   1: the run's outcome is known but the ORIGINAL full capture is gone —
   read the ledger, do not rerun to recover logs. A typed
   `lock_wait_timeout` with no started frame (exit 4) is the one retryable
   admission failure. Never run product tests directly to substitute for
   the scheduler.

   Withdraw an obsolete owned helper only through the helper itself:

     node <capture-helper> withdraw --owner <sink>.owner.json

   Identity is validated (pid + start time + command/cwd); malformed PID
   records, crashes and stale owners are recovered without touching
   unrelated sessions, the service, or owner cancellation controls, and
   existing sink/receipt files are preserved.
4. On failure: read the complete output, repair the real cause, re-run.
   Repeat while each cycle makes genuine progress. Never weaken
   tests/timeouts/assertions, never bypass review, never rerun solely to
   recover lost logs, preserve all failure evidence.
5. When verification is green: push the job's own PR branch normally
   (never force), let exact-head CI land, then run the native Perkins gate
   on that exact final settled head (fallback PASS is not that clearance —
   and never move the head after the gate). Merge, deploy, credentials and
   service restarts stay owner-held, gru-command included: the owner merges
   every repository, after the exact-final-head READY Perkins gate.
6. Escalate to Gru ONLY: genuine design/intent decisions outside the spec,
   safety/permission conflicts, choices the spec leaves open, the same
   failure after three genuine repair attempts without progress, or a
   destructive/owner-only step. One escalation with pointers, then terminal
   for that checkpoint.

Gates stay gates. Completion means the heist actually finished — not a
blocked row with an error attached.


## Merge authority update (owner ruling 2026-09-29)

The owner holds ALL merges, everywhere, permanently for now — including
gru-command after a READY Perkins gate. Gru no longer merges anything.
When a PR reaches READY (exact-head native Perkins clearance), the
completion loop posts a FOR YOU row for the owner with the merge decision;
that row is also the live test of the FOR YOU section. Workers and Silas
never merge; Gru never merges either. Service restarts also remain fully
owner-held — Gru's 2026-09-29 restart attempt killed the service and failed
to relaunch it; do not delegate restarts to agents again.
