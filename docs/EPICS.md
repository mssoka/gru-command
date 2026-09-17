# Gru Command — Epics & Stories (v1)

Epic order = build order; each epic ships a PR (pr_review=1) and a
runnable increment on the dev machine. Every story carries tests; every
gate fails-before-fix where applicable.

## E1 — Foundation & scaffold
1. Repo scaffold: TypeScript/Node service package, build + test harness,
   lint, README skeleton. (private repo initially.)
2. Config system: `~/.gru-command/config.toml` — workspace_root (default
   ~/code), data_dir, runtimes (default + per-role), models, auth token.
   Fail-loud validation; documented schema.
3. Service skeleton: HTTP server + `/health` (3-signal liveness fields,
   identity fingerprint, version, session-path declaration), graceful
   shutdown, structured logging.
4. SPEC.md + EPICS.md + docs tree land in-repo (from the approved spec).
5. Local test: service boots, /health 200 with correct fields, config
   round-trips.

## E2 — Runtime adapter layer
1. `AgentRuntime` interface: spawn, prompt, steer, followUp, event
   stream, session persistence, health, capability declaration.
2. pi adapter (reference): pi SDK AgentSession under the interface —
   events, streaming deltas, session resume, single-writer enforcement.
3. Session-store: append-only jsonl in standard patterns under the
   instance data dir, flock, hourly rolling backup, growth detection on
   boot (the emergency-console reload contract).
4. Capability matrix + fallback behaviors (steer-unable → queue-until-idle).
5. Tests: spawn/prompt/event round-trip with a stub model; resume after
   process restart; flock contention.

## E3 — Claude Code adapter
1. `claude -p` headless wrapper: stream-json parsing → interface events,
   session resume flags, cwd + permission plumbing.
2. Capability declaration + fallbacks documented and tested.
3. Wizard detection: probe installed CLIs.

## E4 — Chat API + the single Gru
1. WebSocket chat: authenticated; prompt/steer from the browser; token
   deltas, tool activity, turn completion streamed live.
2. Gru role definition (runtime-agnostic prompt + persona + standing
   orders product-native).
3. Reconnect-safe: history reload from the session store; never lose a
   typed word (client queue + server ack).
4. Tests: round-trip, reconnect resume, single-writer (second client
   read-only).

## E5 — Web UI shell
1. Playful Planet design system as tokens/components (light default +
   dark toggle) — from the approved design pages.
2. Chat view (desktop + corner-bubble mobile) on E4's WebSocket.
3. App shell: nav, pairing screen (QR), degraded-mode banners.
4. Playwright smoke: pair, chat, reconnect.

## E6 — Ledger & the board
1. SQLite ledger (instance data dir): jobs, rounds, agents, events;
   migrations; the API of record.
2. Board engine: repo-grouped job states fed by the event bus + ledger;
   per-agent state chips; Perkins rounds with per-lens live chips.
3. Board UI: the live dashboard (desktop + phone board-first).
4. Agent transcript views: searchable, scrollable, per-agent.
5. Tests: state machine transitions, lens-chip lifecycle, board query
   correctness.

## E7 — Supervision & notifications
1. In-process supervisor: restart ladders, crash-loop breakers
   (3/10min → stop + escalate), per-agent health from adapters.
2. Notifications: in-app toasts + browser notifications; FYI vs
   action-required routing with ack ids.
3. OS service templates (launchd + systemd) + install scripts; KeepAlive
   out-of-band restart.
4. Tests: kill an agent → ladder restores; crash-loop breaker trips;
   notification ack round-trip.

## E8 — Roles & dispatch flow
1. Silas role (ops) + minion roles (workers) + Perkins wave runner +
   Bob (memory) — prompts, permissions, skill mappings per runtime.
2. Dispatch flow in-product: briefing authorship (Gru) → ops handoff →
   minion spawn (git worktree per job) → PR/watch lifecycle on the board.
3. Review waves (Perkins): multi-lens agent fleet, per-lens chips,
   verdict records into the ledger.
4. Tests: end-to-end dispatch on a fixture repo; wave lifecycle.
   Ruling-17 behaviors: dispatch cwd = project root (all runtimes);
   per-repo skills discovery inside worktrees via the bootstrap
   manifest.

## E9 — Installer, wizard & docs
1. GitHub one-line installer + setup wizard (runtimes detect, repos
   pick, models pick, QR pair).
2. Docs: README (product-pitch + install), OPERATIONS (emergency
   console, supervision, forensics), CONFIG reference. Generic samples
   only — zero personal/project specifics.
3. Release v1.0.0 tag.

## Post-v1 vault (explicitly not now)
Multi-user accounts · WAN exposure · code-editing UI · marketplace of
roles · cloud sync.
