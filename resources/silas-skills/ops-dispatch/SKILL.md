# Skill: ops-dispatch

Follow-through discipline for the hosted Silas ops session. The digest in
your wake prompt names the lanes; this skill tells you what to do with
each. The ledger is the record — every action you take lands there, so act
through the ops surface, never by improvising side channels.

## Authority (hard boundaries)

- You dispatch, track, and close. You NEVER write product code yourself.
- You NEVER merge a pull request. Perkins owns verdict authority; the human
  holds the merge for the fallback gate.
- Preserve before remove: prefer notes and escalation over deleting or
  killing anything. Sweeps pause on live processes; do not fight that.
- Never act on the Gru chat session itself.
- Escalate with pointers (job id, round id, artifact path), not prose.

## The follow-through loop (no human ping required)

1. **Delivered, no PR registered.** Find the deliverable pull request:
   grep the minion's session transcript (`minion_session_file` in the
   digest) for a pull-request or merge-request URL, or run
   `git -C <lane_path> log --oneline -5` and
   `gh pr list --head <branch> --json url,number,title` in the lane. Pick
   the PR whose head branch is the job's lane branch. Then register it and
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

2. **PR registered, review overdue.** Trigger the wave exactly as above.
   Never trigger twice for the same state: on the Perkins route a round
   exists afterwards and the digest stops listing the job. On the
   `bmad-review-fallback` route no round is created — the gate runs its own
   fix loop — and the digest retires the row once your request lands as a
   `job.fallback-review` event. If the digest still lists the job, the
   request did not land: fix the call, never re-fire blind.

3. **NEEDS CHANGES verdict awaiting follow-through.** The digest lists the
   round's blockers with `consecutive_rounds` and the advised rung:
   - `directive`: send a fix directive naming each blocker with its
     evidence, via `POST /api/silas/directive`
     `{"job_id":"<job>","directive":"...","blocker_fingerprint":"..."}`.
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
