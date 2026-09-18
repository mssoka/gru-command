# Roles

The product's five native roles (SPEC ruling 15): each is a prompt file
+ tool/permission set + skill mapping + cwd policy, runtime-agnostic —
the same definition hosts on every runtime adapter. The prompt files are
the source of truth (`roles/*.md`, shipped with the package, loaded
fail-loud at boot); this page is the map.

| Role | Persona file | Cwd policy | Writes | Craft |
|------|-------------|-----------|--------|-------|
| Gru | `roles/gru.md` | workspace root | chat only | judgment: consult, plan-before-heist, dispatch, verify |
| Silas | `roles/silas.md` | workspace root | ledger/ops | operations: briefings are contracts, lanes, sweeps, close-outs |
| minion | `roles/minion.md` | **spawn-provided** (the job worktree) | code | one briefing per lane, verified work, honest commits |
| Perkins | `roles/perkins.md` | **spawn-provided** (a detached review worktree) | nothing | adversarial multi-lens review, strict severity vocabulary |
| Bob | `roles/bob.md` | workspace root | memory files | periodic consolidation with provenance |

## Cwd policy (SPEC ruling 17)

- The chat Gru, ops (Silas), and memory (Bob) host at the **workspace
  root** — they operate across repos.
- Minions and Perkins lens agents host at the **project root they
  serve** — a fresh git worktree per job (see FLOW.md). This is where
  per-repo skills and bmad folders resolve: the project's own
  `.agents/skills` and `_bmad` are discovered from the session cwd, and
  fresh worktrees get them via the repo's bootstrap manifest
  (`.gru-command/worktree.toml`). Discovery NEVER falls back to the
  workspace root. A `spawn_provided` role spawned without a cwd fails
  loud (never a silent workspace-root landing).

## Permissions

Tool sets narrow with responsibility: Perkins reviewers get read-only
tools (no bash, no edit, no write — reviews never write the tree);
minions get the full editing set; Gru/Silas/Bob carry operational tool
sets. Runtime adapters map these to their native tool surfaces.

## Skills

Skill ids are declared per role (`src/roles.ts`), runtime-agnostic: the
seven Perkins lens skills (`lens-blind` … `lens-tests`), minion
verification/hygiene skills, Bob's consolidation skill. Skills are NOT
injected by this service — they resolve from the project's own skill
folders at the session cwd, so the same role definition carries each
project's own conventions (a project-local skill shadows any global
one).

## The gate

The plan-before-heist pattern is Gru-side canon: requirements arrive,
Gru consults and settles the plan with the user, THEN the briefing goes
to ops. No undertaking dispatches on impulse; the briefing a stranger
could execute (goal, boundaries, acceptance, verification) is the only
dispatchable artifact. See FLOW.md for the mechanical arc.
