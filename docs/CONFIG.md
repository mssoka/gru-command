# Configuration reference

Gru Command keeps all instance state in one per-user directory — by default
`~/.gru-command/`, never inside the workspace root. Configuration lives in
`config.toml` inside that directory.

## Locating the instance dir

| Source | Rule |
|---|---|
| `GRU_COMMAND_HOME` env | If set (and absolute), that directory is the instance dir. Intended for tests and multi-instance setups. An empty or relative value is rejected at startup. |
| Default | `~/.gru-command/` |

The config file is always `<instance dir>/config.toml`.

## The setup wizard

The setup wizard (`npm run wizard`, or `node dist/wizard/main.js`) is
the supported installation path. It reads prompts from `/dev/tty`, so a
`curl | bash` install remains one invocation, probes runtime CLIs, asks
for managed repos, offers per-repo BMAD onboarding, and writes the same
**complete teaching config** as the generator below. Every concrete
default is active; optional role/runtime overrides are shown commented
because activating a placeholder would change precedence.

True headless use is explicit: `--no-interact` accepts documented
defaults, and optional `--answers '<json>'` may contain only non-secret
choices. Invalid answers fail before config writes. Neither path
replaces an existing config without `--force`; force first creates a
timestamped 0600 backup and aborts if backup creation fails. A re-run
is round-trip safe: existing config values become the prompt defaults
(`--answers` keys, when explicitly provided, win), every section the
wizard does not prompt for is carried forward as-is, and a malformed
existing config fails loud instead of being silently replaced.

Generate without the rest of onboarding using:

```bash
npm run config:generate                 # writes <instance>/config.toml
npm run config:generate -- --force      # backup, then atomic replacement
```

`docs/example.config.toml` is copy-only documentation. Editing it never
changes the running application.

The instance dir also carries state that is NOT config and has no keys
here: `sessions/`, `chat/`, `logs/`, `ledger/`, `worktrees/` and
`worktree-preserves/` (job lanes and swept-out deliverables —
[WORKTREES.md](./WORKTREES.md)), and `uploads/` (the attach-flow home,
created at boot — SPEC ruling 19).

## Load & validation behavior

- **No config file** → the service boots on the documented defaults below.
- **Any parse or schema error** → the service **refuses to start** and exits
  non-zero with an error naming the file, the offending field, and what was
  expected (fail-loud; no partial boot, no silently ignored keys).
- Unknown keys are rejected at every level — this catches typos early
  instead of letting a misconfigured field silently fall back to a default.
- `~` and `~/…` expand to the user's home directory in path fields.
- All path fields must resolve to absolute paths after expansion.
- **`data_dir` must not live inside `workspace_root`** (and must not equal
  it) — instance state stays out of the managed-repos tree (SPEC ruling 7).
- Model policy: `[models].default` and `[thinking].default` may be empty
  or `"default"` (both mean "the runtime harness's own" — SPEC ruling
  16); any `[models.roles]` / `[thinking.roles]` override must be a
  non-empty string when present — an empty override is meaningless; omit
  it instead.

## Schema

The block below is GENERATED from `src/config-reference.ts` — the same
module that renders the wizard's `config.toml`, so the documented schema
and the emitted config cannot drift. Regenerate with `npm run config:docs`;
the test suite fails if the committed block ever diverges. Uncommenting an
example line activates that override.

<!-- BEGIN GENERATED CONFIG REFERENCE — source: src/config-reference.ts; regenerate: npm run config:docs -->
```toml
# Gru Command configuration.
# This is the live file read from <instance>/config.toml — and it doubles
# as the reference: every documented section is present with its default
# and a one-line purpose comment. Full per-runtime semantics (binding, session flags, effort mapping, resolution order): docs/RUNTIMES.md.
# Edit values in place, then restart only your Gru Command service.

# Root: the directory containing only managed project repositories.
workspace_root = "~/code"
# Root: per-instance state. ~-anchored so a restored config re-anchors to
# the NEW machine's home — an absolute machine-specific path would
# redirect all state to the old machine on restore. Explicit
# GRU_COMMAND_HOME setups emit their exact absolute dir by design.
data_dir = "~/.gru-command"

[server]
# Bind address. Loopback is safest; use a LAN address (or 0.0.0.0 for all
# interfaces) only on a trusted LAN. v1 has no TLS.
host = "127.0.0.1"
# Listen port; 0 chooses an ephemeral port. Integer 0–65535.
port = 7665

[auth]
# Pairing token for authenticated browser/WebSocket access. Keep this file private.
token = "a-random-pairing-token"

[runtimes]
# Session host runtime: "pi" or "claude-code".
default = "pi"

[runtimes.roles]
# Optional per-role runtime overrides (valid roles: gru, silas, minion, perkins, bob);
# omitted roles inherit runtimes.default.
# gru = "pi"
# silas = "pi"
# minion = "pi"
# perkins = "pi"
# bob = "pi"

[models]
# Default model reference. An explicit "provider/model" reference is passed to pi as-is; claude-code strips the provider segment for its CLI --model flag (bedrock-style dotted ids survive: "bedrock/us.anthropic.x" → "us.anthropic.x"). The literal "default" means the runtime's own configuration (SPEC ruling 16).
default = "default"

[models.roles]
# Optional per-role model overrides (valid roles: gru, silas, minion, perkins, bob);
# "default" means the runtime's own for that role. Per-runtime
# inline-table overrides live under [runtimes.<id>.roles].
# gru = "default"
# silas = "default"
# minion = "default"
# perkins = "default"
# bob = "default"

[thinking]
# Default thinking level. "default" delegates to the runtime; explicit
# levels are runtime-specific (pi: minimal/low/medium/high/xhigh/max; claude-code: low/medium/high/xhigh/max/ultracode).
default = "default"

[thinking.roles]
# Optional per-role thinking overrides (valid roles: gru, silas, minion, perkins, bob); per-runtime
# inline-table overrides live under [runtimes.<id>.roles].
# gru = "default"
# silas = "default"
# minion = "default"
# perkins = "default"
# bob = "default"

# [runtimes.pi]
# # Optional runtime-wide policy; omitted keys inherit [models]/[thinking].
# # Thinking levels accepted: minimal | low | medium | high | xhigh | max.
# # An explicit "provider/model" reference is passed to pi as-is; claude-code strips the provider segment for its CLI --model flag (bedrock-style dotted ids survive: "bedrock/us.anthropic.x" → "us.anthropic.x"). The literal "default" means the runtime's own configuration (SPEC ruling 16).
# # Full per-runtime semantics (binding, session flags, effort mapping, resolution order): docs/RUNTIMES.md.
# # model = "default"
# # thinking_level = "default"
# # On an unknown model, allow ONE bounded network catalog refresh before
# # failing; set false for a strictly offline catalog.
# # model_refresh = true
# # model_refresh_timeout_ms = 10000

# [runtimes.pi.roles]
# # Optional per-role inline tables (at least one field when uncommented).
# # Example: minion = { model = "default", thinking_level = "low" }
# # gru = { model = "default", thinking_level = "low" }
# # silas = { model = "default", thinking_level = "low" }
# # minion = { model = "default", thinking_level = "low" }
# # perkins = { model = "default", thinking_level = "low" }
# # bob = { model = "default", thinking_level = "low" }

# [runtimes.claude-code]
# # Optional runtime-wide policy; omitted keys inherit [models]/[thinking].
# # Thinking levels accepted: low | medium | high | xhigh | max | ultracode (mapped to the CLI --effort; anything else fails loud at spawn naming the valid set).
# # An explicit "provider/model" reference is passed to pi as-is; claude-code strips the provider segment for its CLI --model flag (bedrock-style dotted ids survive: "bedrock/us.anthropic.x" → "us.anthropic.x"). The literal "default" means the runtime's own configuration (SPEC ruling 16).
# # Full per-runtime semantics (binding, session flags, effort mapping, resolution order): docs/RUNTIMES.md.
# # model = "default"
# # thinking_level = "default"

# [runtimes.claude-code.roles]
# # Optional per-role inline tables (at least one field when uncommented).
# # Example: minion = { model = "default", thinking_level = "low" }
# # gru = { model = "default", thinking_level = "low" }
# # silas = { model = "default", thinking_level = "low" }
# # minion = { model = "default", thinking_level = "low" }
# # perkins = { model = "default", thinking_level = "low" }
# # bob = { model = "default", thinking_level = "low" }

[supervision]
# Agent watchdog and crash-loop breaker (see SUPERVISION.md).
enabled = true
# Open turn with no runtime event, no session growth, and no live tool = hung.
turn_silence_ms = 900000
# >= max_restarts within this rolling window trips the breaker.
restart_window_ms = 600000
max_restarts = 3
# Backoff base between failed restart rungs (doubles, capped at 60s).
restart_backoff_ms = 2000

[logging]
# service.log size-based rotation.
max_bytes = 10485760
keep = 5

[chat]
# gru.frames.jsonl rotation; reconnect replay spans retained shards.
frame_log_max_bytes = 8388608
frame_log_keep = 3
# Gru awareness wake policy. "never" (default) injects action-required
# escalations and a compact ledger digest into the NEXT Gru turn passively
# — no model turn runs by itself, so it adds no turn cost. Wake modes
# start a Gru turn when a notification lands: "action-required" only for
# action-required notifications; "all" for every notification (FYI
# included). Each wake is a full model turn (provider tokens + latency),
# so it costs whenever the lane is noisy. Wakes never acknowledge
# anything: the human still holds every ack.
notify_wake = "never"

[worktrees]
# Job/review worktree roots follow data_dir by default; uncomment only to relocate.
# root = "~/.gru-command/worktrees"
# preserve_root = "~/.gru-command/worktree-preserves"
# Budget per one-time bootstrap setup command.
setup_timeout_ms = 120000

[dispatch]
# Bob consolidation interval; 0 disables the periodic trigger.
bob_interval_ms = 3600000

[silas]
# Hosted ops session (Silas): closes the delivered→PR→review loop and
# breaks recurring blocker loops. enabled = false hosts no silas slot and
# fires no wakes. There is no review-round cap: while blockers evolve the
# loop continues; the directive/rebrief/escalate thresholds count
# CONSECUTIVE verdict rounds carrying the SAME canonical blocker.
enabled = true
sweep_interval_ms = 300000
# GitHub signal poll (POLL-ONLY; webhooks are not built). Once per tick
# every tracked branch is read through authenticated `gh api` — merged
# PR state, mergeable_state conflicts, and check-run conclusions — and
# the state-change mappings apply once per observed change (merged PR
# closes the lane; conflict cascades an action-required notification;
# CI failure posts a tiered notification with the run URL; CI green
# records the review-gate signal event). 0 disables the poll; requires
# an authenticated `gh` (see README Prerequisites). Rate-limit headroom:
# calls are capped per tick — at most 3000 of the authenticated 5000/h.
poll_interval_ms = 60000
stall_threshold_ms = 1800000
directive_at = 2
rebrief_at = 3
escalate_at = 4

[roll]
# Graceful self-roll drain policy: how long the service waits for
# in-flight review rounds and mid-turn agent sessions to settle before it
# swaps the build and lets the OS service manager relaunch the unit.
# 0 = snapshot the in-flight work and swap now (recovery marks
# interrupted rounds INCOMPLETE and resumes sessions).
drain_timeout_ms = 900000

[review]
# Review gate policy. true keeps Perkins as the primary gate behind the
# fail-closed four-leg pre-flight (bundled resource integrity, review-model
# provider auth, GitHub/GitLab token for verdict posting, review policy
# enabled); a failed leg is always reported, never a silent downgrade.
# false routes every review request to the installed bmad-review fallback
# gate (findings triaged; blockers routed to the implementing minion as fix
# directives; 0 blockers = clear to merge; merge stays user-held).
enabled = true

[verify]
# Verification scheduler: lanes request their project's verify command
# through POST /api/verify; the scheduler owns ONE global test budget
# across lanes. Requests beyond max_concurrent queue FIFO, a queued
# request past lock_wait_timeout_ms fails loud, a holder whose pid is
# dead is released, and every run is recorded for review evidence.
max_concurrent = 1
# Total test workers across runs; 0 = auto (CPU cores - 2).
worker_budget = 0
lock_wait_timeout_ms = 900000
run_timeout_ms = 1800000

```
<!-- END GENERATED CONFIG REFERENCE -->

See [`example.config.toml`](./example.config.toml) for a complete generic
example.

## Validation errors

| Violation | Error shape |
|---|---|
| TOML syntax error | `failed to parse TOML: <detail> (file: …)` |
| Unknown top-level key | `unknown top-level key \`x\` (valid keys: …)` |
| Unknown key in a table | `unknown key \`x\` in [server] (valid keys: …)` |
| Wrong type | `workspace_root must be a string, got number` |
| Empty required string | `auth.token must not be empty` |
| Unknown runtime id | `unknown runtime \`x\` (valid runtimes: pi, claude-code)` |
| Unknown role | `unknown role \`x\` (valid roles: gru, silas, minion, perkins, bob)` |
| Bad port | `server.port must be an integer between 0 and 65535 (0 = ephemeral)` |
| Unknown runtime policy key | `unknown key \`x\` in [runtimes.pi] (valid keys: model, thinking_level, model_refresh, model_refresh_timeout_ms, roles)` |
| Empty runtime role entry | `[runtimes.pi.roles.gru] must set at least one of model, thinking_level` |
| Unknown runtime id as a table | `unknown key \`x\` in [runtimes] (valid keys: default, roles, or a runtime id: pi, claude-code)` |
| Relative `GRU_COMMAND_HOME` | `GRU_COMMAND_HOME must be an absolute path` (an empty value is rejected the same way) |
| Path not absolute after expansion | `workspace_root must resolve to an absolute path` |
| `data_dir` inside `workspace_root` | `data_dir must not live inside workspace_root … — SPEC ruling 7` |
| TOML date where a table is expected | `server must be a table` (dates never pass as empty tables) |
| Non-positive supervision number | `supervision.turn_silence_ms must be a positive integer, got: 0` |
| Unreadable config file | `cannot read config file: EACCES — check permissions` (distinct from a TOML parse error) |

## What reads the config today

The foundation epic loads and validates the whole schema. The runtime
layer consumes `[runtimes]`, `[models]`, `[thinking]` whenever a spawn
happens: model references resolve fail-loud, thinking levels validate
per runtime, and the `"default"` sentinel passes through to the
harness's own configuration. The chat epic (E4) spawns the single Gru
session in production: `/ws` authenticates against `[auth].token`, and
`[server]` host/port bind both the web UI (served from `web/dist` when
built) and the chat socket. `/health` surfaces a summary
(`workspace_root`, `data_dir`) plus real liveness. See
[CHAT.md](./CHAT.md) for the chat protocol and reconnect contract,
[RUNTIMES.md](./RUNTIMES.md) for the capability matrix, fallback
semantics, and the session-store contract, and
[SUPERVISION.md](./SUPERVISION.md) for the supervision policy the
`[supervision]` table drives plus the log-rotation knobs.
