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
- Model policy: `[models].default` may be empty ("unset until the runtime
  layer ships"), but any `[models.roles]` override must be a non-empty
  string when present — an empty override is meaningless; omit it instead.

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
# Which agent runtime hosts sessions. Implementations arrive in later
# epics; the names are reserved by the schema now.
# One of: "pi" | "claude-code". Default: "pi"
default = "pi"

[runtimes.roles]
# Optional per-role overrides. Valid roles:
#   gru, silas, minion, perkins, bob
gru = "pi"
minion = "claude-code"

[models]
# Default model reference (free-form "provider/model" string).
# Optional until the runtime layer ships.
default = "provider/model-a"

[models.roles]
# Optional per-role model overrides (same role names as runtimes.roles).
gru = "provider/model-b"
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
| Relative `GRU_COMMAND_HOME` | `GRU_COMMAND_HOME must be an absolute path` (an empty value is rejected the same way) |
| Path not absolute after expansion | `workspace_root must resolve to an absolute path` |
| `data_dir` inside `workspace_root` | `data_dir must not live inside workspace_root … — SPEC ruling 7` |
| TOML date where a table is expected | `server must be a table` (dates never pass as empty tables) |
| Unreadable config file | `cannot read config file: EACCES — check permissions` (distinct from a TOML parse error) |

## What reads the config today

The foundation epic loads and validates the whole schema and exposes a
summary (`workspace_root`, `data_dir`) via `GET /health`. The runtime,
model, and auth values are carried for the adapter and UI epics — see
[EPICS.md](./EPICS.md).
