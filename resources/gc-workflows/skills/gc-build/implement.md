# Implement

Work in {{context.worktreeRoot}}, job {{context.jobId}}. Read the approved working
spec under {{context.artifactRoot}}, applicable project conventions and its code
map. Verify the recorded full canonical base revision and preserve unrelated work.

Implement the complete assignment. Add deterministic tests for changed behavior
and edge cases; establish the pre-change failure where practical, then run the
covering tests. Reuse existing architecture. Do not weaken tests or acceptance to
make implementation pass, and do not replace missing preconditions with silent
fallbacks. Record decisions and deviations with reasons.

Stage and inspect the complete diff against the recorded base, including new files.
Audit every task, acceptance scenario and meaningful edge case against code and
executed evidence. When the spec has an I/O and edge-case matrix, every row needs
a test that verifies its expected behavior and that ran and passed in the recorded
verification; a covering test that did not run (unregistered, filtered out,
skipped or disabled) counts as missing. When a test disagrees with a row, never
edit the expectation to match the code: fix the code. A row that is itself wrong
against the approved intent is corrected in the spec with the approved-intent text
it contradicts quoted, and the correction is named in the handoff; a row that
encodes owner-approved acceptance changes only on an owner decision. Finish
missing work before claiming completion. Capture exact commands, outcomes and
full canonical candidate head beneath the private artifact root. Do not claim a
skipped/unexecuted test passed.

Continue to [[gc-resource:skills/gc-build/review.md]].
