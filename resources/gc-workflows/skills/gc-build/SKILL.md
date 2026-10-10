---
name: gc-build
description: 'Gru Command-owned software delivery: plan, implement, independently review, fix, verify and hand off an ordinary PR.'
---

Use the exact invocation context file supplied by GC/the caller. It names the
registered project, project root, assigned worktree, job, private operational
artifact root and repository knowledge root. Missing context is a named error,
not permission to infer a project/job from a folder name.

Run this package's retained helper, replacing `{skill-root}` with this skill's
absolute directory and `{context-file}` with the supplied absolute JSON path:

```bash
node "{skill-root}/../../scripts/render.mjs" --context "{context-file}"
```

Read and follow the absolute entrypoint printed by the helper. It resolves both
normal and small-change routes and all required planning/review helpers from
this package. No external skill, renderer or project configuration is needed.
On error stop and report the named failure; do not borrow an ambient workflow.
