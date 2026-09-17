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
# Bind address. v1 is local-only by default; LAN exposure + pairing
# arrive with the UI work. Default: "127.0.0.1"
host = "127.0.0.1"
# Listen port. 0 = ephemeral (pick a free port; useful in tests).
# Default: 7665. Must be an integer 0–65535.
port = 7665

[auth]
# Pairing token for the web front-end. Optional in the foundation epic;
# required once the UI ships. Must be a non-empty string when present.
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
| Unreadable config file | `cannot read config file: EACCES — check permissions` (distinct from a TOML parse error) |

## What reads the config today

The foundation epic loads and validates the whole schema. The runtime
layer consumes `[runtimes]`, `[models]`, `[thinking]` whenever a spawn
happens (none spawn in production until the chat epic, E4): model
references resolve fail-loud, thinking levels
validate per runtime, and the `"default"` sentinel passes through to the
harness's own configuration. `/health` surfaces a summary
(`workspace_root`, `data_dir`) plus real liveness. The UI epics consume
the auth values. See [RUNTIMES.md](./RUNTIMES.md) for the capability
matrix, fallback semantics, and the session-store contract.
