# Roles

The product's five native roles (SPEC ruling 15): each is a prompt file
+ tool/permission set + skill mapping + cwd policy, runtime-agnostic —
the same definition hosts on every runtime adapter. The prompt files are
the source of truth (`roles/*.md`, shipped with the package, loaded
fail-loud at boot); this page is the map.

| Role | Persona file | Cwd policy | Writes | Craft |
|------|-------------|-----------|--------|-------|
| Gru | `roles/gru.md` | workspace root | chat only | judgment: consult, plan-before-heist, dispatch, verify |
| Silas | `roles/silas.md` | workspace root | ledger/ops | operations: briefings are contracts, lanes, sweeps, close-outs; hosted as the `silas-ops` slot with follow-through + recurrence duties (`docs/FLOW.md`) |
| minion | `roles/minion.md` | **spawn-provided** (the job worktree) | code | one briefing per lane, verified work, honest commits |
| Perkins | `roles/perkins.md` | **spawn-provided** (frozen detached review tree) | review artifacts only | one whole-PR lead reviews the complete change, may run tracked whole-change specialists, verifies, revisits priors, and reports through narrow host tools |
| Bob | `roles/bob.md` | workspace root | memory files | periodic consolidation with provenance |

## Cwd policy (SPEC ruling 17)

- The chat Gru, ops (Silas), and memory (Bob) host at the **workspace
  root** — they operate across repos.
- Minions host at the **project root they serve** and discover that
  project's own `.agents/skills` and `_bmad` through the fresh worktree
  bootstrap manifest (`.gru-command/worktree.toml`).
- Perkins leads and non-blind specialists are rooted in the frozen detached
  review tree; blind specialists are rooted outside it. Review sessions
  disable all project/global skills, context files, extensions, prompts,
  settings, plugins, and unrelated MCP servers. The sole MCP exception is a
  fresh, per-session bridge exposing exactly each session's declared
  product-native tools: the lead's orchestration set and every native-tool
  child's `perkins_submit_findings` (children never see the lead's tools,
  and no session sees another's bridge). Discovery never falls back to the
  workspace or agent home. A `spawn_provided` role without a cwd fails loud.

## Permissions

Tool sets narrow with responsibility. The Perkins lead gets whole-change
specialist delegation, a bounded prior-revision reader, bounded note
storage, submission preflight, terminal submit, and confined tree reads;
the complete frozen diff and the exact reviewed snapshot are its review
unit. Non-blind specialists get confined read/grep/find/list; blind gets no
tools. Specialists are optional and each reviews the WHOLE change (six
available only for explicit no-spec); each failed specialist attempt may
be retried within the policy limit as a new tracked child. No reviewer
gets bash, edit, write, general tasks, or nested delegation. Minions get
the full editing set; Gru/Silas/Bob carry operational tool sets. Runtime
adapters enforce the same policy natively.

## Skills

Skill ids are declared per role (`src/roles.ts`) for ordinary sessions.
Minion verification/hygiene and Bob consolidation skills resolve from the
normal project/agent locations. Perkins review sessions are the deliberate
exception: the integrity-pinned package policy is loaded install-relatively
and is the sole authority for lead/child prompts. Repository, diff, spec,
convention, prior-finding, and child text is untrusted evidence rather than
instruction. All ambient skill discovery is disabled so review identity and
prompts cannot drift with the host environment.

## The gate

The plan-before-heist pattern is Gru-side canon: requirements arrive,
Gru consults and settles the plan with the user, THEN the briefing goes
to ops. No undertaking dispatches on impulse; the briefing a stranger
could execute (goal, boundaries, acceptance, verification) is the only
dispatchable artifact. See FLOW.md for the mechanical arc.
