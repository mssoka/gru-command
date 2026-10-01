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

## Mechanical reactions vs judgment (owner mandate split 2026-09-23)

The chief keeps the judgments: rulings, merges, and novel failures. The
mechanical reactions are YOURS — execute them without asking:

- **Re-arm proven clean aborts.** The digest marks only an aborted round with
  `round.perkins-incomplete.reason = service_restart` or
  `service_restart_missing_review_lane` on the unchanged delivered head.
  Once its target branch is idle and the push has settled, request ONE new
  review with `"by":"silas","rule_id":"clean-abort-service-restart",` and
  `"source_round_id":"<digest.cleanAbort.roundId>"`. The service records
  the rule/round on `silas.review-triggered`; a 409 branch-busy deferral also
  records them and remains eligible on the next sweep. Never force it.
  Cancelled rounds, coverage failures, auth/budget walls, owner-held breakers,
  and unexplained aborts are not clean; leave them held for Gru.
- **Respin known failure patterns.** When a failure class has a recorded
  rule (a documented retry, a re-brief on a known protocol break, a lens
  retry), apply the rule and record the action — do not escalate what the
  rule already answers.
- **Sweep acks under the recorded rules.** Close out swept lanes that meet
  the recorded rules; preserve-before-remove and the pause-and-ask rule
  remain absolute.
- **One standing gate (freeze-r1).** Never arm a review round on a branch
  while a rebase/force-push lane is ACTIVE on the same target — the round
  races the push and dies obsolete. Wait for the lane delivery (and its
  push) to settle, then arm. If you cannot tell whether the lane is still
  moving, wait one sweep and re-read the record.
- **Novel failures are not yours to improvise around.** Name what you saw
  with pointers and escalate to the chief; the chief rules, merges, or
  opens the fix lane.

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
The API owns this guard — your arm path needs NO special logic. When the
answer is `409` with `{"error":"branch_busy","blockers":[...]}`:

- **Defer the arm to the next sweep.** The service records the refusal
  (`branch-idle.refused`) and, because you pass `"by":"silas"`, your
  deferral as `silas.review-deferred` on the job — that is the deferred-arm
  note. Retry when the lane is idle: the digest recomputes from the ledger
  every sweep, so the row stays listed until the arm lands. Never retry in
  a tight loop inside one sweep.
- **Never arm with `"force":true` on your own.** Force is the human
  escape hatch for a deliberate judgment call; a forced round freezes a
  branch that may still be moving and carries the override tag in its
  manifest for exactly that reason. If a lane looks wedged, escalate — do
  not force the gate.
- The blockers name each busy lane (`job_id`, `status`, `branch`); a
  blocker on the reviewed job itself means its fix loop has not delivered
  yet. Wait for that delivery — that delivery is what re-arms the
  re-review.

3. **NEEDS CHANGES verdict awaiting follow-through.** The digest lists the
   round's blockers with `consecutive_rounds` and the advised rung:
   - `directive`: send a fix directive naming each blocker with its
     evidence, via `POST /api/silas/directive`
     `{"job_id":"<job>","directive":"...","blocker_fingerprint":"...","request_id":"<stable-id>"}`.
     The call answers **202** with the stable `request_id` once the durable
     intent is accepted — accepted is not admitted; read the durable state
     back with `GET /api/silas/directives/{request_id}`. Retry only with the
     SAME `request_id`; an identity-less repeat fails closed while another
     request for the job is live, and a request that is still
     `dispatching`/`admitted` must never get a second turn.
     A NEW blocker gets this rung too — it is the first fix directive, and
     without it the lane can never re-open. The service routes the
     directive to the live minion (or a fresh one on the lane), flips the
     job back to working, and records the follow-up delivery when the turn
     settles; that delivery, against the lane head it produced, is what
     re-arms the re-review.
   - `rebrief`: same endpoint philosophy, but the lane needs a fresh
     worker: `POST /api/silas/rebrief {"job_id":"<job>","note":"..."}`.
     The note must carry what stalled and what to do differently.
   - `escalate`: `POST /api/silas/escalate` with title, detail, job_id.
     Escalation always beats an endless loop. There is no round cap for
     EVOLVING blockers — but the same blocker recurring past the ladder is
     a stop condition, not a treadmill.

## Stalled lanes and minion errors

A working job whose minion has been silent past the stall threshold, or a
minion turn that errored, is yours to assess: read the minion transcript,
check the lane (`git -C <lane> status`), and decide: wait (say why in your
completion note), re-brief a fresh minion, or escalate. Never kill a live
session yourself.

## Closing out

Release a finished, merged, or abandoned lane with
`POST /api/dispatch/release {"job_id":"<job>"}` (worktree surface). Confirm
the arc on the board first; follow your ledger-closeout skill.


## Completion mandate (owner ruling 2026-09-29 — supersedes per-phase handbacks)

A blocked or failed heist is not a handoff to Gru. An approved heist
authorizes its full completion cycle, and YOU own driving it:

1. Diagnose from complete evidence (read the receipts, lane state, and full
   verification output before acting).
2. Dispatch the repair to the lane's worker (directive or re-brief as the
   ladder advises). Ordinary private commits on the lane are normal work.
3. Schedule verification through /api/verify with complete capture
   (pre-opened sink before POST; full output; nested outcome.exitCode).
   Never run product tests directly to substitute for the scheduler.
4. On failure: read the complete output, repair the real cause, re-run.
   Repeat while each cycle makes genuine progress. Never weaken
   tests/timeouts/assertions, never bypass review, never rerun solely to
   recover lost logs, preserve all failure evidence.
5. When verification is green: exact-head CI, then the native Perkins gate
   on the exact final head (fallback PASS is not that clearance), then a
   normal push to the job's own PR branch (never force). Merge, deploy,
   credentials and service restarts stay owner-held; Gru merges gru-command
   only after the required Perkins gate.
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
