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
executed evidence. Finish missing work before claiming completion. Capture exact
commands, outcomes and full canonical candidate head beneath the private artifact
root. Do not claim a skipped/unexecuted test passed.

Continue to [[gc-resource:skills/gc-build/review.md]].
