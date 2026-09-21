# The dispatch flow

The heist arc, in-product (EPICS E8; SPEC rulings 2, 17, 18). Every step
lands on the ledger — the record of record — and the board renders the
whole arc live.

```
 Gru (chat)          ops (Silas role)            minion                  Perkins hybrid
 ──────────          ─────────────────           ───────                 ───────────────
 consult → plan
 briefing ─────────► job row (briefing verbatim)
                      │ fresh worktree + branch
                      ├─────────────────────────► spawned IN the worktree
                      │                           briefing turn …
                      │                           deliverable + PR link ◄─┤
                      │                                                   one lead
                      │                                                   7/6 lens types × chunks
                      │                                                   verify + audit
                      │                                                   report → PR comment
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

`POST /api/dispatch/review` `{job_id, target_ref?, no_spec?}` freezes one
exact target/base/diff/spec set in a detached review worktree. A round has
one real Perkins lead and exactly seven required lens types per frozen diff
chunk (blind, edge, acceptance, security, architecture, codebase, tests), or
six types per chunk only when `no_spec: true` explicitly removes acceptance.
Each lens/chunk attempt is a distinct tracked child; malformed attempts are
retryable up to the policy limit, so the total child-session count may exceed
the required coverage cardinality.

- The lead receives only four product-native tools: read a frozen chunk,
  run tracked lens children, store bounded notes, and submit terminal proof.
  It owns delegation, investigation, verification, deduplication, prior
  audit, verdict calculation, and report authorship.
- Lens children are fresh, ambient-free sessions. Blind has no tools or
  repository/spec context; other lenses get confined read/grep/find/list
  tools. No reviewer gets shell, edit, write, ambient skills, extensions,
  settings, unrelated MCP servers, or nested delegation. The only MCP
  exception is the per-session, product-owned Claude lead bridge exposing the
  same four narrow tools; lens children never receive it.
- The integrity-pinned package policy is the sole prompt authority for lead
  and child review behavior; interpolated repository/spec/convention text is
  untrusted evidence, never instruction. The host bounds attempts,
  concurrency, candidate/report bytes, and wall time; records every child;
  verifies exact coverage, candidate ownership,
  frozen-commit evidence, prior audit, source stability, report contents,
  delivery, and canonical blocker arithmetic. Zero blockers is READY TO
  MERGE, 1–3 is NEEDS CHANGES, and 4+ is MAJOR REWORK NEEDED. Warnings and
  notes never block.
- A malformed child output consumes one attempt and may be retried within the
  pinned bound. Any exhausted attempt, cancellation, restart, changed
  source/checkout, unsupported evidence, invalid audit, missing coverage,
  or delivery failure durably terminalizes the round as INCOMPLETE. It can
  neither post nor record approval. Startup reconciliation marks interrupted
  rounds INCOMPLETE and releases their owned detached lanes.
- Installed builds load the integrity-pinned policy and Claude MCP server
  relative to the compiled package. Missing, tampered, symlinked, or
  source-fallback resources fail closed.
- The Claude stream-json CLI does not expose a deterministic lead-turn
  discriminator. Claude coverage therefore pins total lead time and terminal
  tool acceptance, while direct turn-count discrimination remains covered by
  the Pi/offline session path; no direct Claude turn-count coverage is claimed.

## 4b. Review-path selection: the bmad-review fallback gate (user amendment 2026-09-20, fork-3 extension)

Perkins is the PRIMARY review gate. At review request time — before any
round is created — a fail-closed four-leg capability pre-flight decides the
route:

1. **Bundled resource integrity** — the SHA-256-pinned Perkins policy loads
   (and the compiled MCP server carries its pin).
2. **Review model provider** — the configured review model resolves and its
   provider holds credentials (cheap probe; no generation call). On the
   claude-code runtime this is a CLI-availability probe; on pi it checks
   model resolution plus provider auth.
3. **Code-host integration** — a GitHub (`gh`) or GitLab (`GITLAB_TOKEN`)
   token valid for the exact repository remote, used for SHA-bound verdict
   delivery. Only GitHub and GitLab hosts are supported; other origins fail
   the leg closed (credentials are never sent to unknown hosts).
4. **Review policy enabled** — `[review] enabled = true` in config.

All legs pass → Perkins review (the gate). Any leg fails → the request
routes to the bmad-review skill **if installed** (never bundled with the
product). The fallback carries FULL GATE semantics: the session returns
findings; the host triages them (release-safety categories — correctness,
security, data loss, broken builds, and related crash/regression/
vulnerability/injection/secret-leak tags — are BLOCKERS; the rest are
notes); BLOCKERS > 0 routes a fix directive to the implementing MINION
session, the lane's working diff is re-read, and the gate re-reviews after
fixes (bounded rounds); 0 blockers = PASS reported as clear-to-merge. The
fallback session is a full-capability minion by design — it must load the
ambient BMAD skill — and is instructed never to gate, approve, merge, or
modify implementation code; every gate decision is the host's. The fallback
never records a Perkins verdict and never moves merge authority: only an
exact-head Perkins READY can authorize a merge, and merge stays user-held
everywhere. A failed pre-flight is never a silent downgrade — the failed
legs, their remediations, and both recovery options (install BMAD via
onboarding / restore Perkins) are escalated and recorded on the job as
`job.fallback-review` events. GitLab merge requests get the same SHA-bound
delivery discipline as GitHub (head + base verified before a note is
posted), and the GitLab probe and poster resolve their token
identically (`GITLAB_TOKEN`, falling back to `GL_TOKEN`); GitHub
authenticates through the `gh` CLI.

Report artifacts persist before delivery, but the local round verdict is
recorded only after SHA-bound delivery proof succeeds; delivery failure
terminalizes the round as durable INCOMPLETE alongside the preserved
report — it never erases already-preserved findings.

## 5. Release (the sweep)

`POST /api/dispatch/release` `{job_id, confirm_kill?, base_branch?}` —
the ordered, preserve-first sweep (ruling 18c):

1. **Preserve** untracked deliverables into the instance data dir
   (before anything else; deliverables are never hostages).
2. **Enumerate** processes rooted in the tree: a process counts when
   the registered path appears in its ARGV as a whole path
   (path-boundary match — a sibling lane `job-a-2` is never confused
   with `job-a`) OR when the process's actual working directory is
   inside the tree (resolved via lsof on macOS / procfs on Linux; other
   platforms are argv-only, declared). Every pid a pause or confirmed
   kill is grounded on lands in the ledger's worktree-process records —
   the ask always names exactly what was live.
3. **Pause and ask** — any live process pauses the sweep, records an
   action-required escalation, and touches nothing. `confirm_kill` is
   the human's answer to the RECORDED ask: it kills exactly the pids the
   pause put on the record (never a fresh enumeration — pids that
   appeared since were never acknowledged), with a SIGTERM grace before
   SIGKILL. Processes that survive both signals re-pause; processes that
   appeared after the acknowledged kill get their own ask.
   `confirm_kill` without a recorded pause is not honored — the ask
   always comes first. Silent kills do not exist.
4. **Remove** the worktree; **containment-verified** branch delete (a
   branch is deleted only when its commits are provably contained in an
   existing ref — otherwise it is retained and noted, never
   force-deleted).
5. **Re-resolve the fresh head** at release: follow-on work always
   starts from the current head, never a held sha.

## The worktree subsystem (ruling 18)

The dispatch flow rides a **worktree port** (`src/dispatch/worktree-port.ts`)
whose CONTRACT is documented in the interface and pinned by
`test/helpers/worktree-port-contract.ts` — lane ids ARE owner ids
(job/round), discovery is by job scope, statuses are exactly
active/paused/swept, unknown ids reject. Every implementation (the
in-memory double here, the manager on its lane) runs the contract:
the five-subsystem manager — bootstrap manifest, ledger-owned registry
(sweeps match registry paths only), the preserve-first sweep with
pause-and-ask, detached-for-reviews/branch-for-jobs, sequential
fresh-head creation — lands as its OWN review lane (`src/worktrees/`,
`docs/WORKTREES.md` on that lane). Until it merges, the core's port is
unavailable and dispatch fails loud, never silent.


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
