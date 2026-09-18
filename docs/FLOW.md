# The dispatch flow

The heist arc, in-product (EPICS E8; SPEC rulings 2, 17, 18). Every step
lands on the ledger — the record of record — and the board renders the
whole arc live.

```
 Gru (chat)          ops (Silas role)            minion                  Perkins fleet
 ──────────          ─────────────────           ───────                 ──────────────
 consult → plan
 briefing ─────────► job row (briefing verbatim)
                      │ fresh worktree + branch
                      ├─────────────────────────► spawned IN the worktree
                      │                           briefing turn …
                      │                           deliverable + PR link ◄─┤
                      │                                                   round (7 lenses)
                      │                                                   detached worktree
                      │                                                   verdict → PR comment
 release ◄─────────── sweep (preserve-first)                            (chips live on the board)
```

## 1. Briefing (Gru, chat-side)

The user brings intent; Gru consults and settles the plan
(plan-before-heist is Gru-side canon). The output is a briefing a
stranger could execute: goal, boundaries, acceptance, verification.

## 2. Ops handoff (dispatch)

`POST /api/dispatch` `{job_id, repo_path, title, briefing}` — the
mechanical handoff behind the chat surface:

1. **Job row** — briefing recorded verbatim; status `dispatched`.
2. **Lane** — one git worktree per job on branch `gru/<job>` at the
   CURRENT fresh head (worktree manager, below). Status `working`.
3. **Minion** — a fresh agent session spawned with `cwd` = the worktree
   (SPEC ruling 17: dispatch cwd is the PROJECT root on every runtime;
   the minion discovers the project's own skills/bmad from there). The
   briefing prompt is delivered as the session's first turn.

Failures are loud and leave no half lanes: a spawn failure sweeps the
fresh worktree back out and blocks the job with a note.

## 3. Lifecycle on the board

The ledger's event stream drives the board: `job.handoff`,
`job.minion-spawned`, `job.delivered` (or `job.minion-error`), the PR
link (`POST /api/dispatch/pr`), review rounds with per-lens chips, and
the sweep. The board groups by repo; the phone is board-first.

## 4. Review waves (Perkins)

`POST /api/dispatch/review` `{job_id, target_ref?, lenses?}` — one
round = a multi-lens agent fleet:

- A **detached** worktree at the ref under review (reviews never grow
  branch debris — ruling 18d).
- One agent per lens (blind, edge, acceptance, security, architecture,
  codebase, tests), each bound to its live chip on the board, each
  ending with the strict protocol line `LENS-VERDICT: blocker|warning|note|clean`.
- **Consolidation is honest arithmetic**: any blocker or warning →
  `changes-requested`; only notes/clean → `approved`. A lens that could
  not conclude withholds the verdict and escalates — never softened.
- The verdict lands in the ledger first, then posts to the PR via `gh
  pr comment`; a posting failure escalates (action-required) without
  un-recording the verdict.

## 5. Release (the sweep)

`POST /api/dispatch/release` `{job_id, confirm_kill?, base_branch?}` —
the ordered, preserve-first sweep (ruling 18c):

1. **Preserve** untracked deliverables into the instance data dir
   (before anything else; deliverables are never hostages).
2. **Enumerate** processes rooted in the tree.
3. **Pause and ask** — any live process pauses the sweep, records an
   action-required escalation, and touches nothing. `confirm_kill` is
   the human's answer: it kills exactly the enumerated pids on the
   record, re-checks, and proceeds. Silent kills do not exist.
4. **Remove** the worktree; **containment-verified** branch delete (a
   branch is deleted only when its commits are provably contained in an
   existing ref — otherwise it is retained and noted, never
   force-deleted).
5. **Re-resolve the fresh head** at release: follow-on work always
   starts from the current head, never a held sha.

## The worktree manager (ruling 18)

The five subsystems behind the flow:

1. **Bootstrap manifest** — `<repo>/.gru-command/worktree.toml` declares
   what a fresh worktree needs (`[[link]]` symlinks, `[[copy]]` files,
   `[[setup]]` one-time commands); auto-applied at creation; the file
   travels with the repo. A missing manifest is a no-op; a malformed one
   fails loud and rolls the worktree back.
2. **Registry** — the ledger's worktree rows are the authoritative map
   job → worktree → branch → sha. Sweeps match registry paths ONLY —
   never id-proximity, never labels.
3. **Preserve-first sweep** — the ordered release above.
4. **Detached-for-reviews, branch-for-jobs** — encoded in the manager's
   two creation paths.
5. **Concurrency** — same-repo worktree creation is sequential (git
   index/refs contention); every creation resolves the fresh head at
   creation time.

## Bob (periodic memory)

Bob's consolidation trigger runs on the configured interval
(`[dispatch] bob_interval_ms`, default hourly; `0` disables): it knocks
on the bob role's supervised slot with consolidation instructions; the
role's persona (`roles/bob.md`) governs the craft. Never overlapping,
never blocking a live operation.

## Configuration

```toml
[worktrees]
# root = "/absolute/path"          # default: <data_dir>/worktrees
# preserve_root = "/absolute/path" # default: <data_dir>/worktree-preserves
# setup_timeout_ms = 120000

[dispatch]
# bob_interval_ms = 3600000        # 0 disables Bob's trigger
```
