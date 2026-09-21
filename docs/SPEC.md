# Gru Command — SPEC v1 (user-approved 2026-09-16)

## Product

A standalone, installable multi-agent orchestrator: one Node/TypeScript
service hosting every agent as a headless session behind a pluggable
runtime adapter, with a web front-end (chat with the single Gru, live
heist board, per-agent transcripts, notifications). The browser is the
only required window. No terminal multiplexer anywhere — herdr is not
integrated. Other users can install it on their laptops from GitHub.

## Locked rulings (all user, 2026-09-15/17)

1. **Single Gru.** One chat brain, no clones. The UI is a window, never a
   second brain. Single-writer rule enforced by design.
2. **Same spawn flow.** Requirements → Gru consult (plan-before-heist) →
   briefing → ops (Silas role) → minions. The product surfaces the flow.
3. **Robustness over speed to build.** Durable state, crash = resume,
   reconnect-safe UI, never lose a typed word.
4. **Runtime adapters, pluggable:** `pi` (pi SDK — reference
   implementation) and `claude-code` (headless `claude -p` with
   stream-json output and session-resume flags — the CLI surface, not the
   SDK). Config picks the default runtime with per-role overrides.
   Capability gaps are declared per adapter with graceful fallbacks.
5. **No custom watchman.** OS service manager (launchd/systemd
   KeepAlive) is the out-of-band watcher; an in-process supervisor
   handles agent liveness (restart ladders, crash-loop breakers — 3 in
   10min → stop + escalate); /health exposes 3-signal liveness and an
   identity fingerprint.
6. **Workspace root is config, default `~/code`.** Never hardcoded; the
   setup wizard asks. Holds ONLY the user's managed repos/projects.
7. **Instance state lives in `~/.gru-command/`** — config, ledger DB,
   session files, notification log. NEVER inside the workspace root.
8. **Repo hygiene:** the shared product repo ships orchestration only —
   service, UI, role definitions, docs, installer. No project names, no
   sample heists, no personal paths. Instance data is per-install.
9. **Security:** LAN bind + pairing token (QR for the phone). No WAN in v1.
10. **Auto-start:** OS service (launchd/systemd) starts Gru Command at
    login; sessions resume from disk.
11. **Design language: Playful Planet.** Warm paper light theme default +
    manual dark toggle; chunky ink outlines, toy-box confidence, minion
    yellow accents. Board grouped by repo; Perkins rounds show per-lens
    live chips; phone layout = board-first with chat as a corner bubble.
12. **Session forensics preserved:** sessions persist as append-only
    jsonl in standard pi session-dir patterns (path declared via
    /health), flock'd, hourly rolling backup; the pi CLI (or claude CLI)
    is the documented emergency console — stop service, open the newest
    session file, single-writer preserved by the stop; service detects
    jsonl growth while down and reloads.
13. **Escalations/notifications:** event-bus native. FYI → notification;
    action-required → a queued item Gru surfaces in chat; ack ids
    (nothing shown is unproven).
14. **GitHub installer:** one-line install script or git clone + setup
    wizard; wizard detects installed runtimes (pi CLI, Claude Code) and
    configures adapters; picks managed repos, models/providers; generates
    the pairing QR.
15. **Roles are product-native:** Gru (CEO interface), Silas (ops COO),
    minions (workers), Perkins (hybrid review lead + tracked lens children),
    Bob (memory consolidation) — defined by prompt + skill set + permissions,
    runtime-agnostic. A Perkins round freezes exact inputs, then one lead owns
    complete seven-lens coverage (six only for explicit no-spec), independent
    verification, reconciliation, prior-finding audit, canonical blocker
    arithmetic, and report authorship through narrow host tools. The host
    freezes identity, disables ambient resources, tracks/disposes children,
    bounds attempts/concurrency/time/bytes, preserves evidence, and rejects
    incomplete, moved, unowned, unsupported, undelivered, or malformed proof.
    Canonical verdicts are 0 blockers = READY TO MERGE, 1–3 = NEEDS CHANGES,
    4+ = MAJOR REWORK NEEDED; INCOMPLETE never approves.
16. **Runtime model & thinking policy.** DEFAULT = the runtime
    harness's own default: a `model = "default"` sentinel means
    "whatever pi / Claude Code is configured to use" — never hardcode a
    model in the product. `config.toml` carries per-runtime AND per-role
    overrides: model AND thinking_level, for both pi and claude-code
    runtimes. AgentRuntime spawn options accept (model, thinking_level)
    with the "default" passthrough. Fail-loud on an unknown model string
    for a runtime that validates models; adapters that cannot set
    thinking declare the capability gap (fallback: warn + proceed).

17. **Per-project bmad/skills (`.agents/skills` + `_bmad` folders) —
    never at the workspace root.** Every managed repo carries its own
    `.agents/skills` + `_bmad` folders; the workspace root carries
    neither (it holds managed repos only — rulings 6/8). The setup
    wizard scaffolds the folders when missing, or warns-and-proceeds
    for repos that opt out. Skills discovery follows the PROJECT cwd:
    the dispatch flow roots minions in the repo they serve, and they
    find that repo's bmad natively — spawn options carry the repo
    root. The global agent-dir keeps generic skills unchanged; a
    project-local skill of the same name shadows the global one.
    Per-project `bmad-customize` overrides become possible per repo.
    Fresh worktrees check out tracked files only; discovery inside a
    worktree resolves via the worktree manager's bootstrap manifest
    (ruling 18: symlinks/copies), or the folders are tracked by the
    repo — discovery never falls back to the workspace root. The chat
    Gru (spawned at the workspace root) discovers the global agent-dir
    only, by design. This supersedes any workspace-root
    skills-discovery assumption in the dispatch flow (E8+): all
    runtime adapters' dispatch cwd is the PROJECT root, never the
    workspace root.

18. **Worktree manager:** the product's dispatch flow manages worktrees
    as a first-class subsystem. (a) **Bootstrap manifest** — each
    project repo declares its fresh-worktree needs in-repo at
    `<repo>/.gru-command/worktree.toml` (symlinks, files-to-copy,
    one-time setup commands), auto-applied at creation; the file
    travels with the repo (extends ruling 17). (b) **Registry** — the
    ledger is the authoritative map job → worktree → branch → panes →
    spawned processes; creation at a freshly-resolved sha; sweeps match
    registry paths only, never id-proximity or labels. (c)
    **Preserve-first ordered sweep** — untracked deliverables preserved
    first; processes rooted in the tree enumerated BEFORE removal; any
    live process PAUSES the sweep and ASKS (fail-loud, never a silent
    kill); then worktree removal + containment-verified branch delete.
    (d) **Detached-for-reviews, branch-for-jobs** — review rounds run
    detached worktrees; job minions run branches. (e) **Concurrency** —
    same-repo worktree creation is sequential; released work
    re-resolves the fresh head at release.

19. **Path references, not attachments — one attach flow, uploads
    dir.** (a) Conversations and briefings reference workspace material
    by PATH — repo-relative inside a managed repo, workspace-relative
    otherwise: the workspace root is the canonical namespace and nothing
    is copied into the product repo (ruling 8). (b) Exactly ONE attach
    flow exists for bringing non-repo material (images, snippets, logs)
    into a conversation; chat and dispatch both ride it — no
    per-surface side doors. The composer gets an attach/add button:
    picked files/images show as ready-to-send chips/preview, and the
    user NEVER types or pastes paths. (c) Resolution semantics — one
    mechanism for desktop, phone, and clipboard: an on-disk local file
    sends its PATH with NO byte copy; clipboard paste (Mac-screenshot
    class) AND phone-origin content materialize into the instance
    uploads dir (`<data_dir>/uploads/`) and send THAT path. (d) The
    agent ALWAYS receives a path and reads the file itself —
    text/code/image with a type-appropriate read; vision gated on
    model capability with a graceful decline (never a guess). The
    attach flow itself lands as its own lane (`gru-command-attach1`)
    before the v1.0.0 tag; E9 ships the ruling text plus (e) only.
    (e) The attach flow's storage home is `<data_dir>/uploads/`; the
    service scaffolds the directory at boot next to the other instance
    dirs (logs/, chat/) — DIRECTORY CREATION ONLY, instance state per
    ruling 7, never inside the workspace root.


## Sources

Approved via structured review rounds (product brief, architecture rev 2,
and review amendments), 2026-09-15/17. Provenance records live outside
this repo.
