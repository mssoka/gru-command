# The worktree manager

SPEC ruling 18's five subsystems — the dispatch flow's worktree engine,
landed as its own review lane (Perkins r4 split). The E8 core rides it
through the worktree **port** (`src/dispatch/worktree-port.ts`); this
lane provides the implementation and owns the release/answer endpoints.

## 1. Bootstrap manifest (18a)

Each project repo declares its fresh-worktree needs in-repo at
`<repo>/.gru-command/worktree.toml`; applied automatically at creation:

```toml
[[link]]                 # symlink created in the fresh worktree
at = "_bmad"             #   worktree-relative (no ..)
to = "_bmad"             #   target: repo-root-relative (.. allowed) or absolute

[[copy]]                 # file copied from the source checkout
from = ".env.local"      #   repo-root-relative (no ..)
to = ".env.local"        #   worktree-relative (no ..)

[[setup]]                # one-time command, cwd = the worktree
command = "npm install"

[verify]                 # verification commands by scope (POST /api/verify;
full = "npm test"        #   see FLOW.md §4c — default scope `full`)
quick = "npm run lint"
```

A missing manifest is a no-op; a malformed one fails loud and rolls the
worktree back **all the way** (worktree AND the branch the failed call
created — a leftover `gru/<job>` would wedge the job id forever).

## 2. Registry (18b)

The ledger is the authoritative map job → worktree → branch → **processes**:
the `worktrees` and `worktree_processes` tables. Sweeps match registry
paths ONLY — never id-proximity, never labels. Every pid a pause or a
confirmed kill is grounded on lands in the registry, so the ask always
names exactly what was live.

The orchestrator's OWN spawned services land there too: the verification
scheduler records every run it spawns for a lane (pid + argv, evidence
`registry`) and reconciles it on exit. A service the orchestrator started
for a lane is the lane's to tear down — not a stranger's.

## 3. Preserve-first ordered sweep (18c)

`release()` order is law:

1. **Preserve** untracked deliverables FIRST (`--porcelain -z` — never
   C-quoted paths; symlinks are preserved AS LINKS; a genuine mid-sweep
   vanish is skipped+logged; any other preserve failure ABORTS the sweep
   with the tree intact — deliverables are never sacrificed).
2. **Reap tracked services** — live `registry`-evidence processes are
   signalled (process group SIGTERM → grace → SIGKILL) and recorded
   killed, with a `worktree.service-reaped` event. Dual-keyed: a pid is
   signalled only when its registry row is live AND it still enumerates
   as rooted in the tree (a recycled pid can never redirect the kill).
3. **Enumerate** processes rooted in the tree: argv **path-boundary**
   match (a sibling lane `job-a-2` is never confused with `job-a`) OR
   the process's actual **cwd** (lsof on macOS, procfs on Linux; other
   platforms argv-only, declared).
4. **Pause and ask** — any other live process pauses the sweep
   (action-required escalation) and touches nothing. `confirm_kill`
   answers the RECORDED ask: it kills exactly the acknowledged pids
   (never a fresh enumeration — later arrivals were never acknowledged),
   with a SIGTERM grace before SIGKILL. Survivors re-pause; newcomers get
   their own ask; `confirm_kill` without a recorded pause is not honored.
   Silent kills do not exist for processes the orchestrator did not spawn.
5. **Remove** the worktree; **containment-verified** branch delete (a
   branch dies only when provably contained in an existing ref;
   otherwise retained and noted).
6. **Re-resolve the fresh head** — follow-on work starts from now.

## 4. Detached-for-reviews, branch-for-jobs (18d)

Jobs run `gru/<job>` branches in their own worktrees; review rounds
check out DETACHED worktrees at the ref under review (reviews never
grow branch debris). Review lanes record their owning job at creation —
every pause is answerable by construction (job id or round id).

## 5. Concurrency (18e)

Same-repo creation is sequential (git index/refs contention); every
creation resolves the CURRENT head — never a held sha.

## Endpoints

`POST /api/dispatch/release` — `{ job_id | round_id | worktree_id,
confirm_kill?, base_branch? }`. The paused response carries the FULL
process list (pid, command, evidence) and the ask note: that payload is
what a human acknowledges against. Authenticated like every product
surface.

## Configuration

```toml
[worktrees]
# root = "/absolute/path"          # default: <data_dir>/worktrees
# preserve_root = "/absolute/path" # default: <data_dir>/worktree-preserves
# setup_timeout_ms = 120000
```
