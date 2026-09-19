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
the supported way to create this file: it probes installed runtime
CLIs, asks for the workspace root and managed repos, and writes a
config that matches this schema exactly — the `"default"` sentinel for
models/thinking (SPEC ruling 16), a generated `[auth]` token, and the
bind host/port. Non-interactive runs take `--answers '<json>'`
(unspecified answers = documented defaults; invalid answers fail loud
with NOTHING written). Re-running the wizard over an existing
`config.toml` copies it to `config.toml.backup-<timestamp>` first; a
failed backup aborts before any write. Hand edits are first-class: the
wizard never rewrites a file you did not point it at.

The instance dir also carries state that is NOT config and has no keys
here: `sessions/`, `chat/`, `logs/`, `ledger/`, and `uploads/` (the
attach-flow home, created at boot — SPEC ruling 19).

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

```toml
# Root: the directory holding your managed repositories/projects.
# Default: ~/code
workspace_root = "~/code"

# Root: the per-instance data directory (config, identity, logs, sessions).
# Default: ~/.gru-command  (i.e. the instance dir itself)
data_dir = "~/.gru-command"

[server]
# Bind address. Default "127.0.0.1" (this machine only). To pair a phone
# or another device on the LAN, bind the machine's LAN address (or
# 0.0.0.0 for all interfaces) — the chat socket and the web UI share
# this port. v1 has no TLS: LAN only, never expose to WAN.
host = "127.0.0.1"
# Listen port. 0 = ephemeral (pick a free port; useful in tests).
# Default: 7665. Must be an integer 0–65535.
port = 7665

[auth]
# Pairing token for the web front-end — LIVE since the chat epic (E4):
# the /ws chat socket requires it on the first frame. When empty or
# absent, the chat endpoint rejects EVERY connection ("chat is not
# configured"); /health stays up either way. Must be a non-empty string
# when present. Generate one per install (the setup wizard does this).
token = "a-random-pairing-token"

[runtimes]
# Which agent runtime hosts sessions. Both adapters are implemented:
# "pi" (pi SDK reference) and "claude-code" (headless claude -p CLI).
# Default: "pi"
default = "pi"

[runtimes.roles]
# Optional per-role overrides. Valid roles:
#   gru, silas, minion, perkins, bob
gru = "pi"
minion = "claude-code"

[models]
# Default model reference. "default" = the runtime harness's own
# configured model (SPEC ruling 16 — the product never hardcodes a
# model). Explicit: "provider/model". Optional; default "default".
default = "default"

[models.roles]
# Optional per-role model overrides (same role names as runtimes.roles).
# "default" here means "runtime's own" for that role.
gru = "provider/model-b"

[thinking]
# Thinking level policy, same shape as [models]. "default" = the
# runtime's own setting. Optional; default "default".
default = "default"

[thinking.roles]
# Optional per-role thinking overrides.
perkins = "max"

[runtimes.pi]
# Per-runtime model & thinking overrides for pi-hosted sessions
# (pi accepts thinking levels: minimal, low, medium, high, xhigh, max).
model = "default"
thinking_level = "default"

# [runtimes.claude-code] works the same way for claude-hosted sessions.
# Thinking levels accepted there: low, medium, high, xhigh, max,
# ultracode (mapped to the CLI's --effort). An explicit "provider/model"
# model reference strips the provider segment for the CLI's --model flag.
# See RUNTIMES.md for the full per-runtime semantics.

[runtimes.pi.roles]
# Per-runtime per-role overrides; inline tables with model and/or
# thinking_level (at least one).
minion = { model = "provider/model-c", thinking_level = "low" }
bob = { thinking_level = "medium" }

[supervision]
# In-process supervision policy (E7 — see SUPERVISION.md). All optional.
# Watchdog: an open turn with no runtime event AND no session-file
# growth for this long is hung and climbs the restart ladder.
enabled = true
turn_silence_ms = 900000
# Crash-loop breaker: >= max_restarts within a rolling restart_window_ms
# trips the breaker (agent stopped, action-required notification; ack
# re-arms).
restart_window_ms = 600000
max_restarts = 3
# Backoff base between failed restart rungs (doubles, capped at 60s).
restart_backoff_ms = 2000

[logging]
# Size-based service.log rotation. Optional.
max_bytes = 10485760
keep = 5

[chat]
# Chat frame-log rotation (E7): rotate gru.frames.jsonl at the cap, keep
# N shards; reconnect replay spans shards (history intact in-window).
frame_log_max_bytes = 8388608
frame_log_keep = 3

[worktrees]
# Worktree manager (E8, SPEC ruling 18). All optional.
# root: where job/review worktrees are created (default:
# <data_dir>/worktrees).
# preserve_root: where untracked deliverables land on sweep (default:
# <data_dir>/worktree-preserves).
# setup_timeout_ms: budget per one-time bootstrap setup command.
setup_timeout_ms = 120000

[dispatch]
# Dispatch flow (E8). Optional.
# bob_interval_ms: Bob's periodic consolidation interval; 0 disables.
bob_interval_ms = 3600000
```

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
| Unknown runtime policy key | `unknown key \`x\` in [runtimes.pi] (valid keys: model, thinking_level, roles)` |
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
