# Jev decision provider: production operations

Gru Command can use TypeSafe Jev as a bounded decision aid in two existing
control paths. Jev is **off by default**. Deterministic behavior remains
available when Jev is disabled, unavailable, malformed, or below a configured
confidence threshold.

This is an operator reference for Gru Command's integration, not a generic
Jev SDK guide.

## Scope (2026-09-20 amendment)

Jev classifies exactly two surfaces:

- **Event/notification triage** — derived orchestration events are classified
  (action needed? attention class? severity?) before optional routing upward
  to ops attention. Fail toward attention: only high-confidence noise may be
  filtered; uncertain or action-looking events route UP; a direct
  action-required post (escalations, breakers) never passes through Jev and
  can never be silenced or demoted by it.
- **Supervisor / runtime-health signatures** — runtime failure signatures are
  classified (transient / auth wall / quota wall / network / hang / fatal) for
  restart-versus-escalate guidance. Restart counters, ceilings, timeout
  arithmetic, stop/cancel state, and the human ack re-arm remain deterministic
  code; Jev never grants a restart, kill, or bypass.

Perkins wave/findings triage and worktree sweep/disposal preflight are
deliberately OUT of scope and are not wired.

## Configuration

Add the generated fragment to `$GRU_COMMAND_HOME/config.toml` (default:
`~/.gru-command/config.toml`):

```sh
node dist/decisions/cli.js config-template
# To generate the same complete fragment with enabled=true:
node dist/decisions/cli.js config-template --enabled true
```

The complete default-off fragment is:

```toml
[decisions.jev]
enabled = false
model = "~typesafe/jev-latest"
endpoint = "https://openrouter.ai/api/alpha/decisions"
timeout_ms = 2000

[decisions.thresholds.read_only]
act = 0.60
confirm = 0.40
require_confirm_on_act = false

[decisions.thresholds.operational]
act = 0.75
confirm = 0.55
require_confirm_on_act = false

[decisions.thresholds.destructive]
act = 0.85
confirm = 0.70
require_confirm_on_act = true
```

Configuration is strict: unknown fields, wrong types, out-of-range values, and
`confirm >= act` are rejected. Destructive confirmation cannot be disabled.

The service watches `config.toml`. A valid atomic replacement is applied
without a service restart. Disabling Jev invalidates in-flight Jev answers
and prevents new provider requests; pending work uses deterministic output.
Invalid reloads keep the product usable in deterministic degraded mode.

## Credentials

Precedence is:

1. `OPENROUTER_API_KEY` in the Gru Command process environment;
2. `$GRU_COMMAND_HOME/credentials/openrouter.key`.

Provision the portable file store through stdin only:

```sh
printf '%s\n' "$OPENROUTER_API_KEY" | \
  node dist/decisions/cli.js credentials set --stdin
```

The credential directory is owner-only (`0700`) and the key file is
owner-only (`0600`). The key file contains protected **plaintext**, not
encrypted storage; protection relies on filesystem ownership and these
permissions. Writes are atomic. Symlinks, loose permissions, empty values,
and multiline values are rejected. The key is removed from the service's
ambient process environment at boot (children never inherit it), never
accepted on argv, and never written to TOML, JSON status, logs,
notifications, or child-process environments.

Automatic credential resolution is allowed only for the exact trusted
endpoint shown above. Custom endpoints require an explicitly supplied
in-process key; Gru Command will not forward a resolved environment/file
credential to them.

## Status and checks

```sh
node dist/decisions/cli.js status --json
node dist/decisions/cli.js check --json
```

`status` is offline and reports only sanitized credential
presence/source/state. `check` performs the same bounded Jev probe used at
service startup when Jev is enabled. Exit status is zero for `ready` or
intentionally `disabled`, and nonzero for `degraded`.

Authenticated service surfaces:

- `GET /health` — includes `decisions` status;
- `GET /api/board` — includes `decisions` status;
- `GET /api/decisions/status` — status only;
- `POST /api/decisions/recheck` — bounded credential/provider recheck.

The Settings page shows only `disabled`, `ready`, or `degraded`, sanitized
reason text, model/endpoint, credential presence/source, last-check time, and
the per-process generation. It never shows key material. A degraded
transition creates one durable action-required notification; a recovery (or
an explicit disable) resolves it with a durable FYI notification. Repeated
restarts deduplicate the same unresolved incident instead of flooding copies.

## Decision boundaries

Jev assists but does not replace existing deterministic authority:

- event triage: derived rows stay durable before any classification;
  classification may route a row UP to action-required, never down;
- runtime failure classification and restart guidance: the watchdog ladder
  and crash-loop breaker stay authoritative, and a confirmation-band restart
  guidance stops the agent for a human instead of restarting.

A provider timeout, HTTP error, malformed answer, missing answer, invalid
probability/confidence, unexpected choice, or incompatible score rubric
produces the request's deterministic fallback. Provenance records `jev`
versus `deterministic`, model, sanitized fallback reason, and usage when
supplied. Raw prompts, raw provider bodies, and secrets are not placed in
notifications, and all outbound state is redacted (labeled secrets, bearer
schemes, URL userinfo, opaque key formats, private-key blocks).

## Troubleshooting

| Status reason | Operator action |
|---|---|
| `credential_missing` | Set `OPENROUTER_API_KEY` for the service or run `credentials set --stdin`, then recheck. |
| `credential_invalid` | Remove whitespace/empty environment input or rewrite one non-empty line through the CLI. |
| `credential_unsafe` | Remove symlinks; set the credentials directory to `0700` and key file to `0600`; re-provision if ownership is uncertain. |
| `auth_rejected` / `forbidden` | Verify the OpenRouter credential and access, then recheck. |
| `provider_degraded` | One automatic recheck runs after a transient degradation; if still degraded, wait for provider/rate-limit recovery and use Recheck — deterministic behavior remains active. |
| `timeout` / `network_error` | One automatic recheck runs after a transient degradation; if still degraded, verify DNS/TLS/connectivity to `openrouter.ai` (the request timeout is intentionally bounded) and use Recheck. |
| `malformed_response` | Leave deterministic fallback active and inspect the configured model/endpoint compatibility. |
| `endpoint_untrusted` | Restore the verified HTTPS endpoint. Resolved portable credentials are never sent elsewhere. |
| `config_invalid` | Correct the named strict config error; the service remains deterministic/degraded (an instance with Jev off stays off). |
| `probe_failed` | The provider answered but did not confirm the synthetic health check; verify the configured model/endpoint compatibility, then recheck. |

No live-provider request is made while `enabled = false`.
