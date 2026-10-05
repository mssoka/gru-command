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

## Provider profiles (issue #222)

Jev is reachable through three exchangeable provider profiles. All three are
always present; `[decisions.providers.<name>]` overrides a built-in by
re-declaring it (every key is required) or defines a new profile:

| Profile | Protocol | Endpoint | Model | Credential |
|---|---|---|---|---|
| `openrouter-jev` (default) | `openrouter-decisions` | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` | `openrouter` |
| `typesafe-direct` | `systemone` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `typesafe` |
| `local` | `systemone` | `http://127.0.0.1:8088/v1/systemone` | `laya-421m` | `none` |

The built-in `local` profile pins `input_price_per_mtok = 0` (a local model
has no cash cost); override the profile to price token-bearing local
servers otherwise.

Both protocols send the same request (`{ model, state, questions }` with
`Authorization: Bearer <key>`) and accept the same typed answer envelope;
response validation is identical. A `systemone` response that reports only
token counts gets its input cost computed from the profile's optional
`input_price_per_mtok` (default `0.042`); a reported `usage.cost` always
wins; when neither exists the cost is recorded as null, never invented.
Error mapping adds `422 → malformed_request` (a structurally rejected
request is a wiring bug, not provider health); `401 → auth_rejected`,
`403 → forbidden`, `429/5xx → provider_degraded` are unchanged.

Example — route one surface through TypeSafe directly:

```toml
[decisions.providers.typesafe-direct]
protocol = "systemone"
endpoint = "https://api.typesafe.ai/v1/systemone"
model = "jev-latest"
credential = "typesafe"
timeout_ms = 2000

[decisions.surfaces]
event_triage = "typesafe-direct"
```

Routing rules:

- `[decisions.surfaces.<surface>]` maps a surface name to a profile name —
  as the shorthand `event_triage = "typesafe-direct"` or as the explicit
  table `[decisions.surfaces.event_triage]` with `provider =
  "typesafe-direct"`. Unlisted surfaces (and omitted surface arguments)
  ride the default `openrouter-jev` profile — pre-profile behavior,
  unchanged. The deterministic fallback never changes and stays the floor.
- Production callers pass stable surface names: event/notification triage
  uses `event_triage`; supervisor runtime-health guidance uses
  `supervision_guidance`.
- The legacy `[decisions.jev]` block keeps working: it is the master
  switch and feeds the default profile's model/endpoint/timeout.
- **Credential binding is the security property.** A slot's resolved key is
  only ever sent to its pinned origin AND its pinned request path —
  `openrouter` → `https://openrouter.ai/api/alpha/decisions`, `typesafe` →
  `https://api.typesafe.ai/v1/systemone` — enforced at config validation,
  at provider construction, and again immediately before every request;
  redirects are refused. `credential = "none"` (keyless) is allowed only
  for loopback hosts (`127.0.0.1`, `::1`, `localhost`) over `http:` or
  `https:`.
- Hot reload applies to profiles and surface routing like every other
  `[decisions]` key: a switch swaps the surface's profile without a
  restart; in-flight answers from the old generation are discarded
  (existing semantics). A degrade of the default profile retires only the
  default profile's provider — other profiles keep serving their routed
  surfaces.
- Non-default profiles are constructed offline and probed only when used:
  a profile whose credential is missing falls back deterministically for
  its own calls (logged, never an owner incident). Probe any profile
  explicitly with `check --profile <name>`.
- **Credential changes need a recheck.** A running service resolves slot
  credentials when it (re)configures; after
  `credentials set --slot <name> --stdin`, use the Recheck surface (or
  restart) to adopt the new key — CLI `status`/`check --profile` always
  see the fresh key.

Provenance gains `profile` (the profile name that produced a `jev` outcome;
null on deterministic fallbacks).

## Credentials

Precedence per slot is:

1. `<SLOT>_API_KEY` in the Gru Command process environment (`OPENROUTER_API_KEY`,
   `TYPESAFE_API_KEY`);
2. `$GRU_COMMAND_HOME/credentials/<slot>.key` (`openrouter.key`, `typesafe.key`).

Provision the portable file store through stdin only:

```sh
printf '%s\n' "$OPENROUTER_API_KEY" | \
  node dist/decisions/cli.js credentials set --stdin
printf '%s\n' "$TYPESAFE_API_KEY" | \
  node dist/decisions/cli.js credentials set --slot typesafe --stdin
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
node dist/decisions/cli.js check --profile openrouter-jev
node dist/decisions/cli.js check --profile local
```

`status` is offline and reports sanitized credential presence/source/state
plus one sanitized entry per effective profile (name, protocol, endpoint,
model, credential slot and its resolved state/source — never key material).
`check` performs the same bounded Jev probe used at service startup when
Jev is enabled. `check --profile <name>` probes any configured profile with
the identical probe and exit contract. Exit status is zero for `ready` or
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
| `credential_missing` | Set `OPENROUTER_API_KEY` (or the routed profile's slot variable) for the service, run `credentials set [--slot <name>] --stdin`, then recheck. A non-default profile with a missing key only falls back for its own calls — `check --profile <name>` shows it. |
| `credential_invalid` | Remove whitespace/empty environment input or rewrite one non-empty line through the CLI. |
| `credential_unsafe` | Remove symlinks; set the credentials directory to `0700` and key file to `0600`; re-provision if ownership is uncertain. |
| `auth_rejected` / `forbidden` | Verify the OpenRouter credential and access, then recheck. |
| `provider_degraded` | One automatic recheck runs after a transient degradation; if still degraded, wait for provider/rate-limit recovery and use Recheck — deterministic behavior remains active. |
| `timeout` / `network_error` | One automatic recheck runs after a transient degradation; if still degraded, verify DNS/TLS/connectivity to `openrouter.ai` (the request timeout is intentionally bounded) and use Recheck. |
| `malformed_response` | Leave deterministic fallback active and inspect the configured model/endpoint compatibility. |
| `malformed_request` | The provider rejected the request shape (HTTP 422). Check the surface wiring/model name; this is a caller bug, not provider health. |
| `endpoint_untrusted` | Restore the verified HTTPS endpoint. Resolved portable credentials are never sent elsewhere. |
| `config_invalid` | Correct the named strict config error; the service remains deterministic/degraded (an instance with Jev off stays off). |
| `probe_failed` | The provider answered but did not confirm the synthetic health check; verify the configured model/endpoint compatibility, then recheck. |

No live-provider request is made while `enabled = false`.
