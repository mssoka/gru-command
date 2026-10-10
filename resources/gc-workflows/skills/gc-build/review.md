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
never merge it. Retain each reviewer job identity and its recorded findings
handback/disposition using the shipped minion playbook.

Independent terminal sessions are permitted only for explicit owner-directed
external development outside a GC job, with durable session/pane receipts; a GC
minion must not use this exception. The normal route uses all three lenses in
parallel when the runtime supports it:

- [[gc-resource:skills/gc-build/review-prompts/adversarial.md]] — diff and repository,
  without the author's explanation or self-review.
- [[gc-resource:skills/gc-build/review-prompts/edge-cases.md]] — diff, relevant code and
  acceptance scenarios; boundary/failure paths.
- [[gc-resource:skills/gc-build/review-prompts/verification.md]] — diff, approved intent,
  tests and exact executed verification evidence.

The small-change route requires the fresh adversarial reviewer; add the other
lenses when warranted. Never substitute author self-review for a reviewer. If
independent execution is unavailable or fails, report the infrastructure failure;
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

Inspect each claim against code. Classify concrete actionable defects separately
from speculation/style, explain severity/evidence, and record a reasoned disposition
for every finding. Refute false positives with evidence, not dismissal. Use
[[gc-resource:skills/gc-build/references/claims-check.md]] to check evidence honesty
and [[gc-resource:skills/gc-build/references/deletion-check.md]] for removals.

Fix all actionable in-scope defects and add/run regressions. When findings expose
wrong acceptance, obtain an explicit owner decision; do not silently rewrite intent
or create a completion claim. Do not offload known required work into new backlog.
Re-engage independent reviewers on the resulting changed head; preserve previous
receipts and record what changed. Re-run affected verification and confirm exact
final-head coverage before concluding review.

Continue to [[gc-resource:skills/gc-build/present.md]].
