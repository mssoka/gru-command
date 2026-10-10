# GC-owned delivery resources

GC ships directly editable delivery resources in `resources/gc-workflows/`.
They adapt selected useful BMAD templates, with license/attribution retained,
not an upstream fork, synchronization service or compatibility promise.
Project BMAD is optional and independent: this package never reads its config,
renderer, skills or output and never modifies its installation.

**This PR (#292) supplies the resource package and explicit invocation API.**
Production session/review selection and setup remain on their existing paths
until #294/#295 land. Merely shipping this package does not switch live jobs,
retire the old package, change the external fallback or remove any user files.
Artifact allocation/configuration is #293; the paths below are explicit caller
inputs, not a second storage allocator. The intake workflow added by #296 can
use the same manifest/resource/reference mechanism.

## Supported delivery paths

- `gc-build`: normal route — investigate/plan, implement, independent tracked
  three-lens review, reasoned fixes, verification and ordinary PR handoff.
- Small-change route — reduced planning plus at least one fresh independent
  adversarial reviewer, reasoned fixes, verification and ordinary PR handoff.
- Planning and review helper entrypoints are also independently resolvable.

All required templates, reviewer prompts, evidence/deletion checks and the
standard-library-only Node helper are shipped. No project `_bmad`, Python/uv,
global skill or unshipped checkout file is required for these new resources.
No minimum finding quota or total/per-phase tool-call ceiling applies; a clean
review may return `No actionable findings.` Review needs actual independent
tracked runs/sessions, not author self-review or merely sending a prompt.
Development/fallback PASS is never native exact-final-head Perkins READY.

## Explicit invocation context

The caller supplies an absolute JSON file (or the typed API's `WorkflowContext`):

```json
{
  "projectId": "registered-project-7",
  "projectRoot": "/workspace/app",
  "worktreeRoot": "/lanes/app/job-42",
  "jobId": "j-42",
  "artifactRoot": "/private/gc-data/projects/registered-project-7/jobs/j-42",
  "knowledgeRoot": "/lanes/app/job-42/gru-output"
}
```

`projectId`/`jobId` are stable caller-authorized identities, not inferred from a
folder name or source document. Roots must be absolute, real non-symlinked paths.
Project/worktree roots must already exist. The artifact root must be private
(0700), outside project/worktree/runtime roots, and must not contain those roots.
The knowledge root must be a descendant of the assigned worktree. It is validated
but never created or populated by rendering; approved portable knowledge can be
written there later through that worktree. Private prompts/logs/review reports
belong in the artifact root, never in repository knowledge.

The CLI performs full read-only context validation **before** installing a runtime
or publishing a lane binding. It reads any existing lane reference without
mutation and executes the **selected** workflow's verified `scripts/context.mjs`
bytes in memory; the retained renderer uses that same validator, avoiding two
context contracts. Bound A uses A's validator, never installed B's stricter or
broken contract; a valid retained A remains invokable with no current B bundle.
New lanes validate B before binding. Invalid identities, escaping/linked roots and nonprivate
artifact roots cannot pin a rejected request's workflow version.

The helper resolves all operational `[[gc-resource:...]]` links and context tokens
into an immutable snapshot under `<artifactRoot>/workflow-snapshots/<hash>/`.
It records the exact context plus selected workflow identity/content hash in
`invocation.json`. Repeating the context reuses the verified snapshot; modified,
partial or symlinked snapshots fail by name rather than being overwritten. It
never consults ambient config, guesses missing context, writes the shared runtime
or changes project conventions. Changing context produces another snapshot.

```sh
# Explicit fixture/example invocation, not a production-session cutover:
node dist/cli/workflow-runtime.js render --context /absolute/context.json \
  --store /private/gc-data/bmad-runtime --package-root /absolute/gc-install \
  --route normal
# Other routes: small-change, plan, review. Output is a JSON receipt with entrypoint.
```

`renderWorkflow(runtime, context, route)` invokes the retained runtime's helper
via argv/stdin, with no shell interpolation. `gc-build/SKILL.md` contains the
same package-relative helper launcher using a supplied absolute context file;
`workflowLauncherCommand` passes quoted environment variables for paths.

## Identity, integrity and lane continuity

`runtime.json` uses schema 2, a GC name/version (`gru-command-workflows@1`),
supported entrypoints/skill names and per-resource sha256. There are no upstream
archive/identity sections. Missing/corrupt/undeclared/symlinked files fail with
`WorkflowResourceError`; no ambient workflow fallback is permitted. Required
helpers and reference closure must remain complete even during manifest refresh.

`loadBundledWorkflowRuntime`, `materializeBmadRuntime` and
`bindWorkflowRuntime` reuse #283's content-addressed immutable store and atomic
first-writer lane binding. Files are installed read-only; running lanes record
exact identity/path/content in their private git dir's existing
`gru-command/bmad-runtime.json`. Keep the same store root when crossing to the
owned package so retained #283 bindings remain addressable. No automatic store
migration or historical cleanup is performed.

A lane bound to A retains A when B ships; a new lane can bind B. A valid existing
#283 binding retains its original BMAD identity, namespace and skill list even
when no new bundle is available. GC does not reinterpret that old workflow as
`gc-build` or supply an invented new invocation contract. The existing session
consumer must honor the returned historical skill set until the lane retires.
A missing runtime can be restored only when the current package ships identical
bytes; corrupt retained bytes fail loudly, never silently switch the lane.
`createWorkflowRuntimeBinder` is available for the later execution cutover; this
change does not wire it into the production registry or setup wizard.

## Editing and shipping (maintainers)

Edit GC templates/helpers directly, then refresh **local GC integrity**:

```sh
npx tsc
node dist/cli/workflow-runtime.js manifest . --version 2
npm test
npm pack
```

Use a positive integer GC resource version for intentional instruction releases;
content hashes independently distinguish every set of bytes. There is no BMAD
fetch/re-vendoring step or byte-for-byte upstream comparison on GC resources.
`npm run build` verifies the owned manifest; `npm pack` rebuilds backend/web and
ships the complete resource directory plus this document. The old bundle is
still separately verified only for its transitional production consumers.

`test/workflow-runtime.test.ts` covers edits, integrity, closure, explicit context,
ambient independence, isolation, shell-special paths, immutable snapshots, lane
updates/races and historical continuity. `test/workflow-runtime-packaged.test.ts`
extracts the actual npm archive, without source/config/global BMAD or even a
`node_modules` tree, and drives the compiled CLI for both build routes. These
prove deterministic mechanics, not paid model execution or live rollout.

No automatic migration/deletion of old outputs, bindings, captures or independent
BMAD installs accompanies this package. Existing owner-run legacy handling remains
in [BMAD-RUNTIME.md](BMAD-RUNTIME.md); merge and rollout remain owner decisions.
