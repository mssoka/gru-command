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

## Shadow surfaces (issue #224)

Three further surfaces exist for the labelled-history backtest harness
(#223). They ask ONLY in explicit `mode = "shadow"` — a surface with no
mode key never receives their asks (an unrecorded provider call serves
nothing; `off` needs no asks; `enforce` is a future host change) — and
shadow asks RECORD the provider answer next to the deterministic
baseline while still serving the deterministic answer: behavior cannot
change until the #223 enforce gate is met AND the owner records a
decision per surface.

**Shadow misses are evidence, not incidents.** A transient failure of a
default-profile shadow ask (`timeout`, `network_error`,
`provider_degraded`) is recorded (`decisions.shadow`, provenance
`deterministic`, model `null`) and logged; the runtime stays `ready`.
Only **3 consecutive** transient misses degrade it, and a successful ask
resets the count. Credential, auth, config and schema failures still
degrade on the first miss.

| Surface | Question | Fires at | Deterministic baseline |
|---|---|---|---|
| `escalation_triage` | choice `triage` (`needs_ruling`, `needs_owner`, `status_report`, `covered_by_open_item`) + noul `needs_decision` | the awareness layer's wake-delivery receipt, for Silas-authored escalation rows (`silas.escalation`, `silas.escalated:<jobId>`) inside the delivered batch — the exact point the labelled extractor links on | every escalation reaches Gru (`needs_ruling`, noul 1 — fail toward a wake) |
| `same_blocker` | noul `same_defect` over two findings | the Silas digest's recurrence block, when two blockers' #216 fingerprints differ but file and category overlap (digest-wide cap of 8 pairs, deduped per process) | different fingerprints are different blockers (noul 0 — fail toward the new blocker) |
| `report_conclusion` | choice `conclusion` (`clean_pass`, `findings_need_action`, `inconclusive`) | BACKTEST-ONLY until #220's report-handback host exists (its question set, builder, summarisation and enforce-gate registration are live) | every delivered report still owes the commissioner a review (`findings_need_action` — never a silent clean pass; the issue's draft table named `inconclusive`, but the reviewed #223 measurement contract pins the baseline to today's behavior) |

Escalation-triage requests carry the escalated subjects' open decisions
and recent dispositions from decision memory (#218) when any exist —
with each row's `covers` and basis fingerprint so a hold scoped to
another signal cannot read as applicable. The labelled extractor
reconstructs the same memory as of each historical wake, so backtest
states measure the memory-enriched behavior.

Known measurement limits (recorded deliberately, issue #224 review):

- `same_blocker` labelled positives are carry-key pairs (the lead's own
  carry), which share a #216 base fingerprint — production only asks
  about fingerprint-DIFFERING pairs, so the labelled positive population
  under-covers exactly the cases enforce would act on. Current history
  yields zero pairable cases (every reviewed head seen once); grow the
  labelled set from real differing-fingerprint history before taking
  `same_blocker` anywhere near enforce.
- The extractor groups review rounds by identical target SHA, while
  production compares a job's verdict rounds across moved heads —
  recurrences across edits are outside the labelled population for the
  same reason.

Enforcement preconditions: recorded backtest evidence meeting its
threshold (#223 gate) AND a recorded owner decision per surface — the
gate enforces the evidence; the owner decision is a process
precondition the gate cannot read. `escalation_triage` enforcement
additionally needs #219's deferral mechanism (defer, never drop; hard
floors bypass).

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
timeout_ms = 5000

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
timeout_ms = 5000

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
- **Per-surface mode (issue #223).** The explicit table form also accepts
  `mode = "off" | "shadow" | "enforce"`. `off` serves the deterministic
  answer and never calls the provider. `shadow` asks the provider and
  records the answer next to the deterministic baseline as a
  `decisions.shadow` ledger event (hash of the filtered state + question
  ids — never the state text), but still serves the deterministic
  answer: behavior cannot change while evidence accumulates. `enforce`
  serves the provider answer but requires recorded backtest evidence
  meeting its stated threshold at
  `<data_dir>/decisions/backtests/<surface>.json`; missing or failing
  evidence fails the request loud (`EnforceGateError`) and posts a deduplicated
  needs-owner configuration incident. Only surfaces with registered labelled
  backtests (`escalation_triage`, `same_blocker`, `report_conclusion`) may opt in
  to `enforce`; today's production `event_triage` and `supervision_guidance`
  surfaces can use `off` or `shadow` until their backtests exist. A surface
  with no `mode` key keeps the pre-#223 behavior without the gate.
- **Earning enforce.** Extract labelled history to JSONL
  (`{ id, state, label }`), run the harness against any profile, and save
  the evidence together with its stated threshold:

  ```
  node dist/decisions/cli.js extract-cases --surface <s> --out cases.jsonl
  node dist/decisions/cli.js backtest --surface <s> --profile <p> \
    --cases cases.jsonl --record <dir>      # live run; stores raw responses
  node dist/decisions/cli.js backtest --surface <s> --profile <p> \
    --cases cases.jsonl --replay <dir> --threshold <min> --save
  ```

  The report carries n, agreement with the deterministic baseline,
  precision/recall of the action that would be taken, calibration
  buckets, cost, and p50/p95 latency. `--save` only accepts a `--threshold`;
  the enforce gate re-evaluates the recorded metric against it, binds it to
  the configured profile model, and never trusts the stored flag. Live
  provider fallbacks fail the backtest instead of earning enforce evidence.
  For `report_conclusion`, `--artifact-root` points to delivered report
  handback exports: one `<job>/handback.json` per case with
  `{ "schemaVersion": 1, "jobId": "<job>", "deliverable": "review",
  "report": "...\\n**Verdict: READY TO MERGE**" }`. Perkins
  `consolidated.json` review rounds are not report-type handbacks; verdict
  lines are removed from the request state. Yield telemetry (#214) reports
  shadow disagreement rates per surface and provider.
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

## Request deadlines and failure evidence

`timeout_ms` bounds the **client-side exchange**, from immediately before
fetch through response-body consumption and validation. It is not the model's
inference time. Header wait includes local scheduling, connection setup and
provider processing; this fetch integration does not separately measure
DNS, TCP, TLS, gateway queueing or inference. An unauthenticated fast `401`
probe measures a different path from an authenticated decision and does not
exonerate either the client or the provider for a historical slow request.

The provider races the whole exchange against its own deadline, in addition
to signaling transport abort. Even an abort-ignoring fetch/body cannot keep
its caller or one of the four admission slots pending beyond the local
deadline. Late response bodies are cancelled best-effort; late answers cannot
route a decision. Disposal cancels as `disposed`, not `timeout`, and runtime
generation checks prevent shutdown/reconfiguration from recording a stale
shadow ask as a new timeout. Cancellation cannot guarantee an uncooperative
underlying transport has stopped. JavaScript timers need an event-loop turn;
if the loop is blocked, expiry can run late, but elapsed-time checks also
reject a response that arrives after the deadline before the timer runs.

New `decisions.shadow` records include `fallback_reason` and
`request_diagnostics`. Attempted failures retain their actual elapsed
`latency_ms` rather than replacing it with zero. The diagnostics contain:

- `phase`: `not_started` for an admission refusal, `request` while waiting
  for headers, `response_headers` while checking HTTP status and declared
  response size (without reading rejected or oversized bodies),
  `response_body` while reading an accepted response's body, or
  `response_validation` while parsing/checking a completed body;
- `timeoutMs` and `deadlineExpired`: configured client budget and whether
  this request's own deadline expired (an upstream abort can be classified
  as `timeout` without our local deadline having expired);
- `headersMs` and `bodyMs`: elapsed milestones from the same request start,
  not individual phase durations; `null` means that milestone was not observed
  before the bounded request settled, not proof a response never arrived later;
- `httpStatus`: observed HTTP status, or `null` before headers.

`fallback_reason = "capacity_limited"` means the four local admission slots
were occupied: that ask never contacted the provider. It is logged as a
`decision provider request fell back` warning with profile, surface, elapsed
time and diagnostics, but does **not** degrade remote-provider health or
count as a transient miss. Deterministic stand-ins (for example a missing key
or an already-degraded runtime) have their actual fallback reason and null
request diagnostics. These records contain no request state, credentials,
raw error text or raw provider bodies.

Historical rows without these new fields have **unknown causes**: a
`deterministic` source and `latency_ms = 0` alone cannot establish a timeout,
a capacity refusal, a DNS fault, or a long-lived slot deadlock.

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
and multiline values are rejected; a single final newline (as an editor adds
on save) is tolerated. Let `credentials set` create the directory — a
pre-created directory with looser permissions is refused as unsafe. The key is removed from the service's
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
transition creates one durable notification: FOR YOU (`needs-owner`) when a
human must act (credential, auth, config, schema) or a surface acts on Jev
(`enforce`, or a modeless `event_triage`/`supervision_guidance`), and a board
FYI when the failure is transient and every acting surface is `shadow`/`off`.
A recovery (or an explicit disable) resolves it with a durable FYI
notification. Repeated
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
| `provider_degraded` | Transient: automatic rechecks run on a bounded backoff (1, 5, 15, 60 min); if still degraded after the last one, wait for provider/rate-limit recovery and use Recheck — deterministic behavior remains active. |
| `timeout` / `network_error` | Transient: automatic rechecks run on a bounded backoff (1, 5, 15, 60 min); if still degraded, verify DNS/TLS/connectivity to `openrouter.ai` and use Recheck. Inspect the shadow record's `fallback_reason`, or the request warning's `reason` for any mode, plus elapsed time and `request_diagnostics`, before changing `timeout_ms` (default 5000). The section hot-reloads, but increasing the budget is not a diagnosis and will not explain local capacity refusals. |
| `malformed_response` | Leave deterministic fallback active and inspect the configured model/endpoint compatibility. |
| `malformed_request` | The provider rejected the request shape (HTTP 422). Check the surface wiring/model name; this is a caller bug, not provider health. |
| `endpoint_untrusted` | Restore the verified HTTPS endpoint. Resolved portable credentials are never sent elsewhere. |
| `config_invalid` | Correct the named strict config error; the service remains deterministic/degraded (an instance with Jev off stays off). |
| `probe_failed` | The provider answered but did not confirm the synthetic health check; verify the configured model/endpoint compatibility, then recheck. |

No live-provider request is made while `enabled = false`.
