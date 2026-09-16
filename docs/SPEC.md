# Gru Command — SPEC v1 (user-approved 2026-09-16)

## Product

A standalone, installable multi-agent orchestrator: one Node/TypeScript
service hosting every agent as a headless session behind a pluggable
runtime adapter, with a web front-end (chat with the single Gru, live
heist board, per-agent transcripts, notifications). The browser is the
only required window. No terminal multiplexer anywhere — herdr is not
integrated. Other users can install it on their laptops from GitHub.

## Locked rulings (all user, 2026-09-15/16)

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
    minions (workers), Perkins (review waves), Bob (memory
    consolidation) — defined by prompt + skill set + permissions,
    runtime-agnostic.
16. **Runtime model & thinking policy.** DEFAULT = the runtime
    harness's own default: a `model = "default"` sentinel means
    "whatever pi / Claude Code is configured to use" — never hardcode a
    model in the product. `config.toml` carries per-runtime AND per-role
    overrides: model AND thinking_level, for both pi and claude-code
    runtimes. AgentRuntime spawn options accept (model, thinking_level)
    with the "default" passthrough. Fail-loud on an unknown model string
    for a runtime that validates models; adapters that cannot set
    thinking declare the capability gap (fallback: warn + proceed).

## Sources

Approved via structured review rounds (product brief, architecture rev 2,
and review amendments), 2026-09-15/16. Provenance records live outside
this repo.
