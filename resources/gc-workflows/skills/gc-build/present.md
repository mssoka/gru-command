# Verify and hand off

Assignment {{context.jobId}} in {{context.worktreeRoot}}. Keep private execution
receipts under {{context.artifactRoot}}; publish relevant approved portable
project knowledge under {{context.knowledgeRoot}} through the assigned worktree.

1. Confirm every acceptance/task/edge case is implemented, independently reviewed
   and verified. Run applicable affected regressions and repository lint,
   typecheck, build and full checks. Capture exact commands, exit codes, outcomes
   and full canonical tested commit. If the head changes, affected checks and
   independent review must cover the new final head. Never claim an old-head
   result covers newly edited executable bytes.
2. Prepare one focused ordinary non-draft PR when publication is authorized.
   Include purpose, scope, requirements traceability, exact reviewed/tested head,
   review receipts/dispositions, verification and honest residual limitations.
   Do not enqueue another job, mutate production state, merge or roll out unless
   separately authorized. The owner retains merge/rollout authority.
3. Development review is not native Perkins clearance. Preserve the existing
   native independent-review and exact-final-head Perkins release gates.
   A fallback or development PASS must never be presented as native READY.
4. Give a concise handoff: changed paths, PR/commit, executed checks and review
   outcome. Do not create a documentation-only or run-all-tests completion issue,
   and do not hide missing required work behind a success summary.
