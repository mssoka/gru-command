# Independent tracked development review

Worktree: {{context.worktreeRoot}}; job: {{context.jobId}}.
Private review evidence: {{context.artifactRoot}}. Context: {{context.contextFile}}.

Capture the full canonical base and candidate head and complete diff, including
new files. Review actual code and executed evidence, not the implementer's report.

## Required reviewers

For a GC-assigned job, launch fresh, context-free reviewers as service-tracked
commissioned review jobs (megaminions), never generic child workers or untracked
terminal agents. Use `POST /api/dispatch` with `deliverable: "review"`,
`parent_job_id: "{{context.jobId}}"`, `target_ref` naming this job's ordinary PR and
`target_sha` naming the exact committed candidate head. If needed, commit the
verified candidate and publish its reviewable ordinary PR before commissioning;
never merge it. Name the exact source for the review (issue #317): optional
`target_base` (focused-delta base; the range reviewed is
`target_base..target_sha`), `required_inputs` (`[{path, lens}]` content the
review needs — only the `claims` lens accepts inputs, a `blind` lens is a 400)
and `source_package` (`{path, sha256}` of a hash-pinned git bundle authorizing a
repair). The service proves the actual selected object store holds the named
target/base/range/inputs before the reviewer spawns; if it cannot, the dispatch
is refused `422 review_source_unavailable` (`problems`, `retry_authorized:false`)
— a refusal, not a report, and never an automatic retry. Dispatch to the
repository that holds the commits, or re-dispatch with an explicit
`source_package`. Retain each reviewer job identity and its recorded findings
handback/disposition using the shipped minion playbook.

Independent terminal sessions are permitted only for explicit owner-directed
external development outside a GC job, with durable session/pane receipts; a GC
minion must not use this exception. The normal route uses all four lenses in
parallel when the runtime supports it:

- [[gc-resource:skills/gc-build/review-prompts/adversarial.md]] — diff and repository,
  without the author's explanation or self-review. This is the BLIND lens: commission it
  with `"review_role": "blind"`, an `"input_package"` (`base_sha`, `target_sha`, the
  base-to-target `diff` and/or exact target `files`) and `"parent_contract_sha256"` read
  from `GET /api/dispatch/jobs/{{context.jobId}}/contract`. The service validates the package
  against this job's effective `blind-isolation:` rule (administrative clarifications
  included) BEFORE any reviewer spawns, and refuses task specs, prior assessments and
  deferred/triage text carried by a document-like file (extensionless or `.md`/`.markdown`/
  `.txt`/`.rst`/`.adoc`, whatever it is named) with a correction path; other file types are
  path-checked only. Never hand a
  blind reviewer an unfiltered historical diff, and never count a blind report as
  independent coverage unless `GET /api/dispatch/jobs/<review job>/blind-coverage` says
  `qualifying`; settling a report is not validity.
- [[gc-resource:skills/gc-build/review-prompts/edge-cases.md]] — diff and relevant code
  only: never the spec, intent, task list or author's explanation. Commission it
  with `"review_role": "claims"` and no `required_inputs`.
- [[gc-resource:skills/gc-build/review-prompts/verification.md]] — diff, tests and exact
  executed verification evidence, with the approved intent (the ground truth) and
  the claims it falsifies (the working spec's acceptance and tasks, or on the
  small-change route the note's settled acceptance) quoted in its brief.
  Claims-needed lens: `"review_role": "claims"`.
- [[gc-resource:skills/gc-build/review-prompts/intent-alignment.md]] — diff and its tests
  plus the verbatim owner-approved intent quoted into the brief; the brief never
  adds the author's explanation, task list or self-review. Claims-needed lens:
  `"review_role": "claims"`.

Hand the edge-case lens the diff without knowledge-root paths
(`{{context.knowledgeRoot}}`), so a committed spec is not part of what it traces;
the other lenses, intent alignment included, review those files as part of the
change. A change that touches only knowledge-root files gives the edge-case lens
no code to trace: record it as not applicable, with that reason, instead of
commissioning it.

The small-change route requires the fresh adversarial reviewer and widens with the
risk re-scored against the candidate diff: `medium` adds the verification and
edge-case lenses, `high` uses all four, and an unrecorded risk counts as `high`.
A risk raised during review commissions the lenses it now requires on the same
head before review concludes. Never substitute author self-review for a reviewer.
If independent execution is unavailable or fails, report the infrastructure failure;
review remains incomplete, not a fabricated pass. Do not silently change the
owner-selected review model or launch protocol.

Bind each review result to a durable report under the private artifact root. Record
actual run/session/pane identity, reviewer role/model, full base/head, completion
state, report path and evidence. Track every launched reviewer to completion;
a queued prompt is not a completed review. Reviewers are read-only and must not
mutate the implementation or see each other's results before submitting theirs.

There is no minimum finding quota, no total/per-phase tool-call ceiling and no
minimum number of review rounds. A clean review may return `No actionable findings.`
Do not manufacture defects to fill a target. These rules apply to both routes.

## Triage and fixes

Triage only after every launched reviewer has reported or ended without a report.
A failed lens is a reviewer job that ended without a report (crashed, cancelled,
refused or stopped), reported its content missing or unreadable, or delivered a
blind report that `blind-coverage` does not rate `qualifying`. Record it,
re-commission it or report the infrastructure failure as above, and treat that
lens's coverage as missing until a replacement reports. A replacement or later
re-review of that lens covers from the last head where it had counted coverage (or
the base), never a narrower focused delta; triage its findings when they arrive.
A failed blind report never counts as coverage, whatever `blind-coverage` says. If
its replacement is refused `409 blind_coverage_owned`, do not retry in a loop: the
service accepts a same-head replacement only once the failed job is parked or
binned. Decide after triaging the other lenses: when fixes follow, commission the
blind lens again on the new head; otherwise escalate to the owner with the failed
job's id, and once that job is parked or binned commission the replacement on the
then-current head. Review stays incomplete until every required lens is covered;
only the edge-case lens on a knowledge-root-only change may instead be recorded
not applicable. Disregard any
severity a reviewer assigned. Record one row per finding in the review triage log
of the working spec (or small-change note) under the private artifact root —
reviewed head, verdict, evidence and a reasoned disposition for every finding;
never drop, merge or silently skip one.

On a re-review of a changed head, match each finding against the logged rows
first. Carry a row forward when the finding has the same location and claim and,
since the head the row was logged at, nothing changed the cited code, the code its
evidence relied on, any caller of or path into the cited code, or the approved
intent. Log it again as `carried` with the head range compared, keeping its
original verdict and disposition, without re-verifying or re-fixing it; a carried
pending owner decision stays pending until the owner rules. A row marked fixed or
corrected is never carried: the same finding at unchanged code means the fix
missed, so verify it again. Verify everything else.

Verify each remaining claim: at the cited file and line, does the bad outcome
actually occur? Read past the changed lines — callers, upstream guards — until you
can answer yes or no. A different finding about nearby code does not settle this
one; judge whether the problem is real, not whether the proposed fix is plausible.
Code that fails loudly on a state you have not shown the program can reach is
correct behavior, not a defect. Render exactly one verdict:

- `high` (intolerable), `medium` (tolerable) or `low` (cosmetic or negligible) —
  the bad outcome is real. Grade by harm to users or developers; for a
  developer-only problem name where it causes trouble (which caller diverges,
  which rule breaks). A complaint with no named harm is not a grade: use `false`
  or `maybe-false`. When the harm is real but its size is unclear, grade higher.
- `false` — you checked and the outcome does not occur. Record what disproves this
  specific claim; a true fact about nearby code is not a disproof.
- `maybe-false` — the diff and surrounding code cannot decide it. Record what
  would.

Reject `false` findings on their refutation. Reject a `low` finding when users or
developers are unlikely to meet the defect in everyday use (judged plainly; no
proof needed) and its fix is more than a direct correction or deletion — new
guards, branches, parameters or other complexity. Treat a finding as out of scope
only when the approved intent itself excludes it, not because the spec's task
list or the diff's shape leaves it out. Each rejection keeps its row and reason.

Group the survivors by shared root cause — the same defect produced both, not
merely the same location or the same fix — and give each group its highest
verdict. Then:

- A group of only `maybe-false` members that would be `medium` or `high` if true:
  run the check that decides it (read the deciding code, run the test) and grade
  it again. One that cannot be settled is logged as unsettled and named in the
  handoff with what would settle it; one that would only be `low` is rejected
  with that note.
- A defect this change neither caused nor exposed: log it as pre-existing with
  its evidence and name it in the handoff; do not open new backlog for it.
- Findings that expose wrong expected behavior — an acceptance scenario or
  matrix row — are corrected only by quoting the approved-intent text it
  contradicts, never to match the code; then fix the code and its tests to the
  corrected expectation with a regression. Any other doubt about expected behavior
  needs an explicit owner decision. Do not silently rewrite intent or create a
  completion claim. A wrong implementation-plan detail (a task, a code-map entry)
  is corrected with its reason, never to drop work the approved intent or
  acceptance still requires. Log each correction as `corrected` (with the commit
  of any code fix) and name it in the handoff.
- Fix all actionable in-scope defects — every other surviving group — and
  add/run regressions.

Use [[gc-resource:skills/gc-build/references/claims-check.md]] to check evidence
honesty and [[gc-resource:skills/gc-build/references/deletion-check.md]] for
removals. Do not offload known required work into new backlog.
Re-engage independent reviewers on the resulting changed head; preserve previous
receipts and record what changed. Re-run affected verification and confirm exact
final-head coverage before concluding review.

Continue to [[gc-resource:skills/gc-build/present.md]].
