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
`curl | bash` install remains one invocation, probes runtime CLIs, defaults new installs to Claude Code (`pi` stays selectable; a missing CLI for the chosen runtime stops setup with the fix, never a silent fallback; an existing config keeps its runtime), offers
real Git repository directories as candidates, validates selected Git roots
and GC worktree setup without provisioning or inspecting independent BMAD
([BMAD-RUNTIME.md](./BMAD-RUNTIME.md)), and writes the same **complete
teaching config** as the generator below. The exact selection is persisted
as root-level `managed_repos`; discovery does not enroll unselected siblings.
It then checks each selected repository's origin for a GC manifest and asks
once whether to onboard the ones without
([ONBOARDING.md](./ONBOARDING.md#installer-consent)).
Every concrete default is active; optional role/runtime overrides are shown
commented because activating a placeholder would change precedence. Interactive
setup excludes linked repo entries from choices; explicit headless selection
of a linked repo still fails before writes.

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
created at boot — SPEC ruling 19). The Perkins App credential bundle is
also instance state: it is read from `perkins/` under the instance dir
(the directory holding this file), with `<data_dir>/perkins/` honored as
a fallback for relocated deployments — see
[PERKINS-APP-PUBLICATION.md](./PERKINS-APP-PUBLICATION.md).

## Managed repositories

`workspace_root` is a shared project directory and may contain unrelated
repositories. `managed_repos` is the explicit subset Gru Command treats as
managed (including overview membership and intake root validation);
names are exact direct-child directory names relative to `workspace_root`,
for example:

```toml
workspace_root = "~/code"
managed_repos = ["project-a", "project-c"]
```

A missing `managed_repos` field in an older config and an explicit empty list
both mean **no managed repositories**. Discovery only supplies installer
choices; new siblings are never enrolled automatically. To configure an
existing installation, choose the intended names yourself, edit the live
`<instance>/config.toml` list without changing unrelated settings, save it,
and run `gru restart` to apply it. No selection is
inferred or written for you, and there is no hot reload. A selected but
unavailable directory stays selected and is shown as unavailable rather than
being replaced by another workspace child. Existing jobs and history are not
removed when the overview list changes.

The overview reads GitHub origins through the `gh` login and GitLab origins
(`gitlab.com`, or a self-hosted host whose first label is `gitlab`) through the
`glab` login; GC never reads or handles a GitLab token. Run `glab auth login`
(add `--hostname <host>` for a self-hosted host) with a token that has the
`read_api` or `api` scope, and confirm with `glab auth status`. No environment
variable and no `gru restart` are needed. A row on a host glab is not logged in
to, or with glab not installed, reads unavailable and names `glab auth login
--hostname <host>`; a login without `read_api` or `api` fails that host's rows
as an auth failure. GitHub rows are unaffected either way. Origins on any other
host read `Not linked (unsupported code host)`. See [BOARD.md](./BOARD.md) for
what each row shows.

Perkins GitLab delivery is separate and unchanged: it still uses `GITLAB_TOKEN`
with the `api` scope ([FLOW.md](./FLOW.md)). The same token also reads a GitLab
merge request's head pipeline once per review round, as the exact-head CI
evidence ([REVIEW-INPUTS.md](./REVIEW-INPUTS.md#gitlab-merge-requests)); with
no `GITLAB_TOKEN` or `GL_TOKEN` that block reads `UNAVAILABLE`
(`token-missing`). Set it in the service's environment, for example through
[`[env]`](#service-environment-env). glab itself prefers a `GITLAB_TOKEN` set in the service's environment over its
stored login, so when that variable is set the overview reads with it too.

## Service environment (`[env]`)

The installer regenerates the service unit (the launchd plist or the systemd
unit) on every update, so a variable you add to the unit by hand is lost the
next time you run `gru update`. Put such variables in `config.toml` instead:

```toml
[env]
GITLAB_TOKEN = "replace-locally"
CUSTOM_SERVICE_OPTION = "enabled"
```

The section is optional. Without it, nothing changes.

- **Who gets the values.** The service itself, from its boot step on (right
  after its modules load), and every process it starts (agents, git, gh, glab, verification
  commands). GC's usual child-process filtering still applies on top.
- **Precedence.** The environment the service starts with wins. A name the
  service unit (or whoever starts the service) already sets keeps that
  value, even when the value is empty. `[env]` only supplies names that are
  not set at all. The unit always sets `GRU_COMMAND_HOME`, `PATH`, and on
  macOS `GRU_COMMAND_REVIEW_PYTHON`, so `[env]` cannot change those. The boot
  log line lists the names `[env]` supplied and the names the inherited
  environment kept (`config_env`). It shows names only, never values.
  Precedence is per name: a program that reads one of several names can
  pick an `[env]` name over a different name the unit sets. Perkins reads
  the GitLab token as `GITLAB_TOKEN`, then `GL_TOKEN`; gh prefers `GH_TOKEN`
  to `GITHUB_TOKEN`; the Claude CLI prefers `ANTHROPIC_API_KEY` to a login.
- **Reserved names.** `GRU_*` names and `HOME` are refused, in any letter
  case. GC uses them to select the instance, its config and the port and to
  carry lane and review authority, and those come only from the unit and
  from GC itself. `[env]` can never move the service to another instance or
  config: the config file is chosen before `[env]` is read.
- **Decision provider keys.** `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY`
  in `[env]` reach Jev's credential lookup, exactly like the same variables
  set in the service unit. They take precedence over the
  `credentials/<slot>.key` files. They never reach a process the service
  starts. `node dist/decisions/cli.js status` and `check` read them the
  same way.
- **When it applies.** The service reads `[env]` once, at boot, right after
  it loads the config and before it starts any provider, client or child
  process. Every boot reads it: `gru start`, `gru restart`, `gru update`,
  login or reboot starts, the service manager restarting a crashed service,
  and a direct `node dist/main.js`. An edit takes effect at the next start
  or restart; there is no hot reload. An edit that makes the file invalid
  is still noticed at once, as in any other section: Jev's config watcher
  re-reads the whole file, and while it is invalid Jev (if enabled) falls
  back to deterministic routing with the reason `config_invalid`.
  Variables Node.js reads as it starts
  (`NODE_OPTIONS` or `NODE_EXTRA_CA_CERTS`, for example) take effect only in
  the processes the service starts: `[env]` is read after the running
  service's Node.js has started.
- **Literal values.** Values are plain strings. There is no `$VAR`
  expansion and no shell. Names must be valid environment variable names
  (letters, digits and underscores, not starting with a digit). Values must
  be strings without a NUL character; an empty string is allowed. The whole
  table is limited to 64 KiB of names and values, because every process the
  service starts carries it; put large data in a file and set its path.
- **Checked before starting.** `gru start`, `gru restart` (with or without
  `--now`) and `gru roll` load the config first and refuse when it is
  invalid, leaving the service as it is. The service runs the same check
  when it boots. `gru update` and a roll started from the board do not
  check first. That matters only after an edit nothing has checked yet:
  the running service keeps the config it loaded, so the update's restart
  is the first boot to read the edited file. It refuses it, and the service
  stays down while launchd (about every 5 s) or systemd (about every 2 s)
  retries; it comes back once the file is fixed (`gru start` if not).
- **Plaintext secrets.** `[env]` is not an encrypted secret store. Values
  sit in `config.toml` in plaintext, so the file must be private to you:
  `chmod 600 ~/.gru-command/config.toml`. If the file holds `[env]` values
  and its group or others have any access, GC refuses it. The setup wizard
  writes the file `0600`. GC never prints the values. Validation errors name
  the field, never its value. TOML syntax errors give the line and column
  without quoting the file. Neither the API nor `gru status` shows them.
- **Updates keep it.** `gru update` (`install.sh --update`) never rewrites
  `config.toml`. Re-running the setup wizard writes `[env]` back, with its
  values, and keeps a private backup of the previous file. A variable that a
  past update already removed from the unit cannot be recovered by this
  feature: add it to `[env]` again.

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
  it) — instance state stays out of the shared workspace tree (SPEC ruling 7).
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
# Edit values in place, then apply them with `gru restart`.

# Shared project directory; it may also contain repositories Gru Command does not manage.
workspace_root = "~/code"
# Explicit project directory names relative to workspace_root; only these are managed.
# An empty list manages none. Add names here deliberately, then run `gru restart`.
managed_repos = ["project-a", "project-c"]
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

# [env]
# Optional variables for the service and every process it starts, such as
# a token a CLI the service runs reads. The service unit's own environment
# wins for any name it sets (an empty value too); [env] fills the rest.
# Literal strings, no expansion; GRU_* names and HOME are reserved. Read once per
# boot: apply an edit with `gru restart`. Values are plaintext, so this
# file must stay private to you (chmod 600; [env] values in a file others
# can read are refused).
# GITLAB_TOKEN = "replace-locally"

[runtimes]
# Session host runtime: "claude-code" (default for new installs) or "pi".
# Existing installs keep whatever is set here; switch by editing this line.
default = "claude-code"

[runtimes.roles]
# Optional per-role runtime overrides (valid roles: gru, silas, minion, perkins, bob);
# omitted roles inherit runtimes.default.
# gru = "claude-code"
# silas = "claude-code"
# minion = "claude-code"
# perkins = "claude-code"
# bob = "claude-code"

[models]
# Default model reference. pi takes an explicit "provider/model" reference as-is. claude-code is always Anthropic and needs no provider: use the CLI's own names ("opus", "claude-opus-5-5"); a provider segment, if present, is stripped for its --model flag (bedrock-style dotted ids survive: "bedrock/us.anthropic.x" → "us.anthropic.x"); a shared [models] entry naming another provider is a pi reference that claude-code passes over, unless its id has an Anthropic cloud shape (Bedrock "[region.]anthropic.…", Vertex "claude-…@YYYYMMDD"); resellers serving Claude under their own ids ("github-copilot/claude-…") are passed over too, as is a pi-only shared [thinking] level ("minimal"). The literal "default" means the runtime's own configuration (SPEC ruling 16).
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
# # pi takes an explicit "provider/model" reference as-is. claude-code is always Anthropic and needs no provider: use the CLI's own names ("opus", "claude-opus-5-5"); a provider segment, if present, is stripped for its --model flag (bedrock-style dotted ids survive: "bedrock/us.anthropic.x" → "us.anthropic.x"); a shared [models] entry naming another provider is a pi reference that claude-code passes over, unless its id has an Anthropic cloud shape (Bedrock "[region.]anthropic.…", Vertex "claude-…@YYYYMMDD"); resellers serving Claude under their own ids ("github-copilot/claude-…") are passed over too, as is a pi-only shared [thinking] level ("minimal"). The literal "default" means the runtime's own configuration (SPEC ruling 16).
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
# # pi takes an explicit "provider/model" reference as-is. claude-code is always Anthropic and needs no provider: use the CLI's own names ("opus", "claude-opus-5-5"); a provider segment, if present, is stripped for its --model flag (bedrock-style dotted ids survive: "bedrock/us.anthropic.x" → "us.anthropic.x"); a shared [models] entry naming another provider is a pi reference that claude-code passes over, unless its id has an Anthropic cloud shape (Bedrock "[region.]anthropic.…", Vertex "claude-…@YYYYMMDD"); resellers serving Claude under their own ids ("github-copilot/claude-…") are passed over too, as is a pi-only shared [thinking] level ("minimal"). The literal "default" means the runtime's own configuration (SPEC ruling 16).
# # Full per-runtime semantics (binding, session flags, effort mapping, resolution order): docs/RUNTIMES.md.
# # model = "default"
# # thinking_level = "default"
# # MCP servers for non-review sessions: "none" = only the role's tools
# # (like pi); "project" = only the cwd's .mcp.json as committed at HEAD,
# # for roles with a shell; "user" = your own Claude MCP configuration,
# # connectors included, without prompts.
# # mcp = "none"
# # After an agent replies, how long its turn may wait on background work
# # it left running (a test run, a dev server). Each turn is its own CLI;
# # past this, or once a message arrives, GC stops that work and tells
# # the agent in its next ordinary turn.
# # background_wait_ms = 900000

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

# [pacing]
# Provider pacing: FIFO admission caps for minion and Perkins review
# turns (queued waits are carried in the board snapshot data; live turns are never preempted),
# plus bounded automatic retry for the rate-limit error class
# (HTTP 429, "rate limit", "too many requests", throttling and the
# rate_limit token, so Claude Code's statusless "high load" off-switch
# is retried too). Every automatic retry is recorded as a
# pacing.auto-retry ledger event.
# Full ledger vocabulary: pacing.queued, pacing.admitted,
# pacing.wait-cancelled, pacing.queued-rollback, pacing.auto-retry,
# pacing.auto-retry-recovered, pacing.auto-retry-exhausted.
# Enabled by default with unlimited admission caps. Suggested starting
# point: cap minion and review turns at 3; 1s backoff, capped at 60s,
# 5 retries.
# max_auto_retries = 0 disables automatic retry (admission caps stay active).
# Caps count MINION and Perkins review turns only: silas/bob/distiller/
# chat core turns are outside this pool (the board view is not a
# provider-wide count).
# max_concurrent_minions = 3
# max_concurrent_review_turns = 3   # 0 = unlimited
# backoff_base_ms = 1000
# backoff_max_ms = 60000
# max_auto_retries = 5
# enabled = true
# Optional provider-keyed extra signatures (global text signatures):
# [pacing.providers."<provider-id>"]
# rate_limit_patterns = ["pacing code \\d+"]
# [concurrency] controls resident sessions separately from these turn caps.

[logging]
# service.log size-based rotation.
max_bytes = 10485760
keep = 5

[chat]
# gru.frames.jsonl rotation; reconnect replay spans retained shards.
frame_log_max_bytes = 8388608
frame_log_keep = 3
# Gru awareness wake policy. Wakes OPEN a Gru turn so a critical alert
# is acted on without the user pinging. "action-required" (default) wakes
# for machine-attention rows and for a recorded owner decision Gru owns
# whose follow-through is owed; "all" also for FYI/needs-owner; "never"
# injects context passively before the next turn only (no autonomous
# turn). Each wake is a full model turn (provider tokens + latency).
notify_wake = "action-required"
# Minimum interval between autonomous wakes; candidates inside the
# window coalesce into ONE trailing wake. 0 disables the cap.
wake_min_interval_ms = 300000
# Severity floor for a wake: "info" wakes for every routed row,
# "error" only for error-severity rows.
wake_min_severity = "info"
# Local-time quiet window ("HH:MM-HH:MM", may wrap midnight); wakes
# inside it defer to the window end. Empty string = off.
wake_quiet_hours = ""
# Issue #219 kill switch: an incident covered by an active decision
# (issue #218) defers its wake to that decision's recheck instead of
# opening a turn; breakers, provider walls and needs-owner rows always
# wake. false restores waking for covered incidents.
wake_defer_covered = true
# Code-only FOR GRU mailbox recovery; startup/events/ticks use existing wake gates.
mailbox_reconcile_interval_ms = 300000
# First delivered block after this much quiet time carries a "while you
# were away" digest (wakes, actions, merges, staged PRs). 0 disables it.
morning_digest_gap_ms = 28800000

[worktrees]
# Job/review worktree roots follow data_dir by default; uncomment only to relocate.
# root = "~/.gru-command/worktrees"
# preserve_root = "~/.gru-command/worktree-preserves"
# Budget per one-time bootstrap setup command.
setup_timeout_ms = 120000
# Disk (#427, docs/WORKTREES.md): the board and GET /api/disk show what GC
# uses under data_dir, by category. Over disk_budget_gb (GB of 2^30 bytes),
# GC frees space losslessly: it releases the lanes of finished jobs, deletes
# their review folders, then slims idle lanes. The budget never stops a
# heist. 0 disables it.
disk_budget_gb = 30
# With less than min_free_disk_gb free on the disk, new job and writer-child
# lanes wait in a queue while GC frees space (review lanes never wait).
# 0 disables the floor.
min_free_disk_gb = 10
# "automatic": GC frees space on its own. "proposed": GC posts one FOR YOU
# card listing each step and the space it frees; Accept runs them.
reclaim_mode = "automatic"

[dispatch]
# Bob consolidation knock, due-based like the dream: due at
# lastBobAt + bob_interval_ms from persisted state, so a restart inherits
# the cadence instead of resetting it. 0 disables it. Ships 7 days.
bob_interval_ms = 604800000

[lessons]
# Book of Lessons: deliberate journal entries → dream distillation →
# concise bible chapters → progressive-disclosure pointer lines in
# briefings (chapter bodies are never inlined). enabled = false disables
# the dream cadence and pointer injection; the journal API stays
# available because capture is deliberate and must never be lost.
enabled = true
# Dream cadence: due lastDreamAt + interval (ms); a restart waits out
# the remainder instead of resetting it. 0 = no periodic pass. Ships weekly.
dream_interval_ms = 604800000
dream_on_boot = true
# Hard caps (bytes): each chapter file, and the index — the only part
# ever embedded in briefings. The dream trims to fit; when the index
# cannot hold the chapters, the pass fails loud until they consolidate.
chapter_cap_bytes = 4096
index_cap_bytes = 1024
# Maximum pointer lines injected into one briefing/directive.
max_references = 3

[silas]
# Hosted ops session (Silas): closes the delivered→PR→review loop and
# breaks recurring blocker loops. enabled = false hosts no silas slot and
# fires no wakes. There is no review-round cap: while blockers evolve the
# loop continues; the directive/rebrief/escalate thresholds count
# CONSECUTIVE verdict rounds carrying the SAME canonical blocker.
enabled = true
sweep_interval_ms = 300000
# Sweep wake gate (issue #217): a sweep whose digest fingerprint is
# unchanged does not re-wake Silas until this much time has passed
# since the last delivered wake (a bounded safety re-look). 0 = never
# re-wake on an unchanged digest; a changed digest, an event whose
# digest is non-empty, or a passed decision recheck always wakes (an
# empty digest never wakes on its own; a due decision recheck still
# does). The wake prompt carries
# digest DELTA rows plus a pointer to GET /api/silas/digest, and the
# static operating brief (orders, ops surface, skills) is injected
# once per session — re-injected only when the brief hash changes,
# the session handle changes, or a compaction may have dropped it).
unchanged_rewake_ms = 21600000
# GitHub signal poll (POLL-ONLY; webhooks are not built). Once per tick
# every tracked branch is read through authenticated `gh api` — merged
# PR state, mergeable_state conflicts, and check-run conclusions — and
# the state-change mappings apply once per observed change (merged PR
# closes the lane; conflict cascades an fyi notification (mechanical
# tier — Silas coordinates the conflict integration); CI failure posts
# a tiered notification with the run URL; CI green
# records the review-gate signal event). 0 disables the poll; requires
# an authenticated `gh` (see README Prerequisites). Rate-limit headroom:
# calls are capped per tick — at most 3000 of the authenticated 5000/h.
poll_interval_ms = 60000
stall_threshold_ms = 1800000
directive_at = 2
rebrief_at = 3
escalate_at = 4

[silas.autopilot]
# Issue #243: the unambiguous rule families executed in code, BEFORE any
# LLM wake. `enabled` is the global kill switch (default off). Issue #443:
# `default_mode` applies to EVERY family without an explicit entry below —
# including families added by later releases — and defaults to `dry-run`,
# so enabling the autopilot never enforces a family by itself.
enabled = false
default_mode = "dry-run"

[silas.autopilot.rules]
# Per-family mode: "off" (records nothing, calls nothing), "dry-run"
# (records the would-call), or "enforce" (performs exactly one call).
# A family listed here always overrides `default_mode`.

[provider_recovery]
# Provider-recovery sensor (owner-approved 2026-09-28): watches EXPLICIT
# temporary provider waits on supported routes (v1: the zai-coding-cn
# GLM coding route), probes each exact provider/model/credential binding
# on a shared bounded cadence (a tiny no-history/no-tools generation,
# ≤64 output tokens, no hidden retries), and on completed producer
# evidence wakes Silas once to claim guarded continuations — no owner
# ACK for eligible waits. The openai-codex route and claude-code lanes
# on the native claude.ai login are checked by read-only usage-metadata
# reads instead (no generation). GLM/Codex are DISABLED BY DEFAULT: owner
# activation is manual. Auth/billing/ambiguous failures and unsupported
# providers stay machine attention: Gru decides the direction and asks the
# owner only through a typed reserved decision.
enabled = false
# claude-code lanes on the native claude.ai login: a usage-limit wall
# waits on the claude.ai usage endpoint and resumes when the window
# resets. ON by default, independent of `enabled`. Off — and always for
# API-key/override contexts — Claude quota walls are left to Gru. Turning
# either switch off hands that provider's open waits to Gru at the next
# boot (an action-required notice per wait; none where the owner already
# holds the lane's stop) — never stranded.
claude_native = true
# Sensor tick (how often routes are re-examined). The check cadence
# itself cannot go below the approved 300 s floor.
tick_interval_ms = 30000
cadence_min_ms = 300000
# Rolling probe budget per route (approval cap: 12/hour; config may
# only lower it). Trustworthy provider Retry-After hints reschedule
# within [cadence_min_ms, retry_after_max_ms].
max_attempts_per_hour = 12
probe_backoff_base_ms = 60000
probe_backoff_max_ms = 1800000
# Bounded false-recovery ladder: after this many recovered-
# then-re-hit continuations the route escalates to Gru (action-
# required) and probing suspends for suspension_ms.
false_recovery_escalate_at = 3
suspension_ms = 21600000
retry_after_max_ms = 3600000
# Finite timeout for one probe I/O (generation or metadata read); also
# bounds the durable pre-I/O reservation expiry.
probe_timeout_ms = 30000
# GLM bounded generation fallback (<=64 output tokens, no history/tools,
# no hidden retries). The owner overlay keeps it DISABLED in production:
# false means GLM checks fail closed (no readiness endpoint exists yet).
glm_generation_fallback = false

[vector]
# Vector's raids (#351, docs/VECTOR.md): Gru-directed adversarial property
# campaigns against code already on the default branch, off the heist path.
# Raids gate nothing: no merge, review or verification waits on one, and a
# raid that finds nothing is never a pass. Raids spend quota, so they are
# off until you opt in: true lets Gru plan raids; false = no candidate list,
# no Gru turn, no Vector session, and a chat raid request is refused.
# A repository opts out with `[vector] enabled = false` in its own
# .gru-command/worktree.toml.
enabled = false
# "proposed": each raid Gru picks waits for your Accept in FOR YOU.
# "autonomous": Gru launches raids without asking (board activity only).
raid_mode = "proposed"
# "proposed": each break-in waits for your Accept in FOR YOU before Gru
# dispatches its fix heist. "autonomous": Gru dispatches it without asking.
fix_mode = "proposed"
# How often code rebuilds the raid candidate list (ms); only a changed list
# costs a Gru turn. 0 = raids only when you ask Gru in chat.
plan_interval_ms = 86400000
# Per-raid budgets, never raised after failures or an empty raid. Each
# attack runs a known-bad and a healthy control before it runs against the
# target, plus a baseline and a fresh replay when it fails, so one round
# costs three to five sandboxed runs. A round starts only while five runs
# are left, so max_runs is at least 5.
max_rounds = 4
max_runs = 16
max_raid_ms = 1800000
# Token cap where the runtime reports usage; when it does not, the round,
# run and time caps still bind and the raid report says so.
max_raid_tokens = 400000
# Raids per repository in any rolling 24 hours: started, waiting to run,
# or ended before starting (refused, or failed before they started).
max_raids_per_day = 2

[onboarding]
# Onboarding heists (#427, docs/ONBOARDING.md): a managed repository whose
# origin default branch has no .gru-command/worktree.toml gets no lane
# setup and no verify command. GC finds those repositories at start (only
# when origin answers; an unreachable origin is never taken as missing) and
# a minion opens a PR adding the manifest, derived from the repository's
# own CI, build files and README.
# "proposed": one FOR YOU card per repository; Accept dispatches the heist,
# Decline is remembered until you ask Gru to propose it again.
# "autonomous": GC dispatches the heist and posts a board FYI row.
# "off": nothing is checked, proposed or dispatched, and the installer's
# consent is not read. An open onboarding heist is still proven before
# review in every mode.
mode = "proposed"

[roll]
# Graceful self-roll drain policy: how long the service waits for
# in-flight review rounds and mid-turn agent sessions to settle before it
# swaps the build and lets the OS service manager relaunch the unit.
# 0 = snapshot the in-flight work and swap now (recovery marks
# interrupted rounds INCOMPLETE and resumes sessions).
drain_timeout_ms = 900000

[concurrency]
# Service-wide resident worker sessions (including idle minions, review
# leads and lens children). Gru, Silas and Bob do not use this pool.
# With Perkins reviews enabled (the default), at least 2 are required so
# a review lead and one child can be admitted together; at capacity new
# work queues FIFO and only genuinely idle workers are reclaimed
# (sessions, lanes and untracked work are preserved for resume).
# Positive integer <= 128 (documented sanity ceiling).
max_workers = 4

[review]
# Review gate policy. true keeps Perkins as the primary gate behind the
# fail-closed four-leg pre-flight (bundled resource integrity, review-model
# provider auth, code-host token for the round probe, review policy
# enabled); a failed leg is always reported, never a silent downgrade.
# github.com verdicts publish as the installed Perkins GitHub App
# (perkins-review[bot]); with enabled = true and no bundle the setup
# wizard and every boot name the gap — verdict publication identity:
# MISSING (self-author 422) (see docs/PERKINS-APP-PUBLICATION.md).
# false routes every review request to the installed bmad-review fallback
# gate (findings triaged; blockers routed to the implementing minion as fix
# directives; 0 blockers clear review/fix routing only — a fallback PASS is not a Perkins READY; merge stays user-held).
enabled = true
# Simultaneous lens children inside the global resident pool (not extra slots).
# Positive integer <= 32 (review-gated bound); effective concurrency also
# depends on spare global slots. Specialists are lead-selected whole-change
# lenses run in explicit batches inside ONE round; the round stays bounded
# to 16 real runs and two attempts per lens regardless of this ceiling.
max_concurrent_children = 2

[verify]
# Verification scheduler: lanes request their project's verify command
# through POST /api/verify; the scheduler owns ONE global test budget
# across lanes/repos. It governs only verification commands submitted
# through that API — it does not set AI-agent/reviewer counts and does
# not govern arbitrary commands run directly outside it. Requests
# beyond max_concurrent queue FIFO, a queued request past
# lock_wait_timeout_ms fails loud, a holder whose pid is dead is
# released, and every run is recorded for review evidence.
# Maximum simultaneous verification commands; 1 serializes runs and
# later requests queue FIFO. Not a per-command test-worker count.
max_concurrent = 1
# Total test-runner worker allowance across admitted runs, NOT AI
# agents/reviewers. 0 = auto: max(1, OS-available CPU parallelism - 2).
# The allowance is split across the effective concurrency (max_concurrent
# clamped so the budget is never exceeded; each run gets its share,
# minimum 1). Enforcement passes supported runner worker settings to
# each run (vitest pool env vars + GRU_VERIFY_*); it is not an OS CPU
# quota and reserves no cores.
worker_budget = 0
# Deadline for a queued request waiting for a slot, in milliseconds;
# 900000 = 15 minutes. Expiry fails that queued request loud without
# starting it; the current holder is not terminated.
lock_wait_timeout_ms = 900000
# Execution deadline after a run starts (queue wait excluded), in
# milliseconds; 1800000 = 30 minutes. On expiry the scheduler SIGTERMs
# the run's process group, then SIGKILLs after the 5-second grace if
# needed, and records the run as timed out / non-success.
run_timeout_ms = 1800000

# [briefing_review]
# Nefario (docs/BRIEFING-REVIEW.md): Gru commissions a zero-context review
# of one briefing BEFORE POST /api/dispatch; tier picks the lenses (low =
# stranger, medium = +acceptance/verification, high = all five). The review
# is binding on readiness (it can hold a dispatch back) and advisory on
# content (it never changes scope or overrides an owner ruling).
# enabled = false is the stop state: no commission (503), no readiness
# refusal, and a zeroed board card. Leave it out of a config an older
# build must still parse.
# enabled = true
# stage = "auto" follows the tier: high and medium are enforced, low is
# advisory. stage = 1 records provenance and refuses only a FALSE claim;
# stage = 2 also refuses a high-tier dispatch; stage = 3 forces high + medium.
# stage = "auto"

# ── Jev decisions (optional) ─────────────────────────────────────────
# Jev is a small, cheap "System One" decision model (TypeSafe, via OpenRouter).
# Gru Command runs fully without it: with Jev off, deterministic code makes
# every decision and no provider is ever contacted.
#
# Credentials never belong in TOML. Store the OpenRouter key from stdin with:
#   pbpaste | node dist/decisions/cli.js credentials set --stdin           # macOS clipboard
#   node dist/decisions/cli.js credentials set --slot typesafe --stdin     # TypeSafe direct
# then verify (no key material printed):
#   node dist/decisions/cli.js status --json   and   node dist/decisions/cli.js check --json
[decisions.jev]
enabled = false # MASTER SWITCH. Off = no surface ever asks a provider. Hot-reloads; store the key first.
model = "~typesafe/jev-latest" # OpenRouter Jev alias; feeds the openrouter-jev profile below.
endpoint = "https://openrouter.ai/api/alpha/decisions" # Credential-bearing traffic is restricted to this exact HTTPS endpoint.
timeout_ms = 5000 # Per-call limit; on timeout the deterministic answer is used. Raise it if timeouts recur on a healthy network.

# ── Surface modes: how each decision point uses Jev ──────────────────
# With the master switch on, every [decisions.surfaces.<surface>] picks a mode:
#
#   mode = "off"      Deterministic only. Jev is never asked; zero cost.
#   mode = "shadow"   Jev IS asked and its answer is recorded next to the
#                     deterministic one (ledger event decisions.shadow), but
#                     Gru Command always USES the deterministic answer:
#                     behavior cannot change. START HERE. A single slow or
#                     failed ask is recorded, not an incident; 3 in a row
#                     mark Jev degraded (a board FYI while every acting
#                     surface is shadow/off) with automatic rechecks.
#   mode = "enforce"  Gru Command USES Jev's answer (deterministic fallback on
#                     failure or low confidence). Refuses to run until a
#                     recorded backtest meets its threshold, saved at
#                     <data_dir>/decisions/backtests/<surface>.json by:
#                       node dist/decisions/cli.js extract-cases --surface <s> --out <jsonl>
#                       node dist/decisions/cli.js backtest --surface <s> --profile <p> --cases <jsonl> --threshold <min> --save
#                     Not usable on any surface yet (see each one below).
#                     Setting it anywhere still makes a transient (timeout,
#                     network or provider-error) outage of the default
#                     openrouter-jev profile page you instead of a board FYI.
#   (no mode key)     Legacy, pre-#223: for event_triage and supervision_guidance
#                     Gru Command USES Jev's answer with NO backtest gate;
#                     escalation_triage, same_blocker and report_conclusion are never asked.
#                     A mode-less event_triage or supervision_guidance also makes
#                     a transient outage page you.
#                     Give every surface an explicit mode unless you mean that.
#
# Surfaces (the complete list; any other name fails to load):
#   event_triage          does an orchestration event need attention? (may only raise attention, never lower it)
#                         off or shadow today: no registered backtest, so enforce rejects every
#                         Jev ask (the deterministic answer still serves) and opens an owner incident
#   supervision_guidance  classifies a runtime failure: restart vs escalate (restart counters stay deterministic)
#                         off or shadow today: no registered backtest, so enforce rejects every
#                         Jev ask (the deterministic answer still serves) and opens an owner incident
#                         (its host asks even with the master switch off, so this incident opens then too)
#                         a known auth or quota wall stops at once, without asking
#   escalation_triage     is a Silas escalation a ruling or a status report?
#                         off or shadow today: it asks Jev only in shadow, so enforce never asks
#   same_blocker          is this review blocker the same defect as last round?
#                         off or shadow today: it asks Jev only in shadow, so enforce never asks
#   report_conclusion     clean pass / findings / inconclusive
#                         backtest only: no live host yet, so enforce never asks
#
# `provider` routes a surface to a provider profile (default: openrouter-jev);
# change it in the surface's own table.
[decisions.surfaces.event_triage]
provider = "openrouter-jev"
mode = "shadow"

[decisions.surfaces.supervision_guidance]
provider = "openrouter-jev"
mode = "shadow"

[decisions.surfaces.escalation_triage]
provider = "openrouter-jev"
mode = "shadow"

[decisions.surfaces.same_blocker]
provider = "openrouter-jev"
mode = "shadow"

# ── Provider profiles (optional) ─────────────────────────────────────
# Built-ins always exist: openrouter-jev (default), typesafe-direct and local.
# Override one by re-declaring it, or define your own under a new name.
# Probe any of them (master switch on) with:
#   node dist/decisions/cli.js check --profile <name>
# [decisions.providers.typesafe-direct]
# protocol = "systemone"
# endpoint = "https://api.typesafe.ai/v1/systemone"
# model = "jev-latest"
# credential = "typesafe" # env TYPESAFE_API_KEY or credentials/typesafe.key; bound to api.typesafe.ai
# timeout_ms = 5000
# input_price_per_mtok = 0.042 # cost fallback when a response carries no usage.cost
#
# [decisions.providers.local]
# protocol = "systemone"
# endpoint = "http://127.0.0.1:8088/v1/systemone"
# model = "laya-421m"
# credential = "none" # keyless is allowed ONLY for loopback hosts
# timeout_ms = 5000
# input_price_per_mtok = 0 # an omitted price falls back to 0.042, not the built-in's 0

# ── Confidence thresholds (by risk class) ────────────────────────────
# Read-only classification: mistakes are recoverable, so confidence bars are lower.
[decisions.thresholds.read_only]
act = 0.6 # metric >= act enters the high band.
confirm = 0.4 # confirm <= metric < act flags for confirmation.
require_confirm_on_act = false # High read-only routes need no added confirmation.

# Operational routing can spend turns/quota or alter restart guidance.
[decisions.thresholds.operational]
act = 0.75 # High-confidence operational guidance is eligible within existing authority.
confirm = 0.55 # Medium confidence flags; below this uses deterministic fallback.
require_confirm_on_act = false # Existing operational guards still apply.

# Destructive routing never grants permission: every passable band still requires a human.
[decisions.thresholds.destructive]
act = 0.85 # High bar for destructive triage.
confirm = 0.7 # Medium band pauses/asks; below uses deterministic fallback.
require_confirm_on_act = true # Must stay true; config validation rejects false.

```
<!-- END GENERATED CONFIG REFERENCE -->

See [`example.config.toml`](./example.config.toml) for a complete generic
example.

## Validation errors

| Violation | Error shape |
|---|---|
| TOML syntax error | `failed to parse TOML: Invalid TOML document: <reason> (line 3, column 9) (file: …)` (never quotes the file) |
| Unknown top-level key | `unknown top-level key \`x\` (valid keys: …)` |
| Unknown key in a table | `unknown key \`x\` in [server] (valid keys: …)` |
| Wrong type | `workspace_root must be a string, got number` |
| Wrong managed list type | `managed_repos must be an array of repository names` |
| Invalid managed name | `managed_repos[0] must be a plain directory name under workspace_root` |
| Duplicate managed name | `managed_repos must not contain duplicate repository names` |
| Empty required string | `auth.token must not be empty` |
| Unknown runtime id | `unknown runtime \`x\` (valid runtimes: pi, claude-code)` |
| Unknown role | `unknown role \`x\` (valid roles: gru, silas, minion, perkins, bob)` |
| Bad port | `server.port must be an integer between 0 and 65535 (0 = ephemeral)` |
| Unknown runtime policy key | `unknown key \`x\` in [runtimes.pi] (valid keys: model, thinking_level, model_refresh, model_refresh_timeout_ms, roles)` |
| Empty runtime role entry | `[runtimes.pi.roles.gru] must set at least one of model, thinking_level` |
| Bad claude-code MCP mode | `runtimes.claude-code.mcp must be one of "none", "project", "user", got "x"` |
| Bad claude-code background wait | `runtimes.claude-code.background_wait_ms must be a positive integer, got: 0` (at most 2147483647) |
| Unknown runtime id as a table | `unknown key \`x\` in [runtimes] (valid keys: default, roles, or a runtime id: pi, claude-code)` |
| Relative `GRU_COMMAND_HOME` | `GRU_COMMAND_HOME must be an absolute path` (an empty value is rejected the same way) |
| Path not absolute after expansion | `workspace_root must resolve to an absolute path` |
| `data_dir` inside `workspace_root` | `data_dir must not live inside workspace_root … — SPEC ruling 7` |
| TOML date where a table is expected | `server must be a table` (dates never pass as empty tables) |
| Non-positive supervision number | `supervision.turn_silence_ms must be a positive integer, got: 0` |
| Unreadable config file | `cannot read config file: EACCES — check permissions` (distinct from a TOML parse error) |
| `[env]` value not a string | `env.TOKEN must be a string, got number` |
| Bad `[env]` name | `env name "1BAD" is not a valid environment variable name …` |
| Reserved `[env]` name | `env.GRU_COMMAND_HOME is reserved: GRU_* variables are set by Gru Command and its service unit …` |
| NUL in an `[env]` value | `env.TOKEN must not contain a NUL character` |
| `HOME` in `[env]` | `env.HOME is reserved: it locates the instance and its config, so only the service unit sets it` |
| `[env]` over 64 KiB | `[env] holds 70000 bytes of names and values, over the 65536-byte limit: …` |
| `[env]` values in a shared file | `[env] holds values, so the config must be private to its owner, but its mode is 0644 — run: chmod 600 …` |

## What reads the config today

The foundation epic loads and validates the whole schema. The runtime
layer consumes `[runtimes]`, `[models]`, `[thinking]` whenever a spawn
happens: model references resolve fail-loud, thinking levels validate
per runtime, and the `"default"` sentinel passes through to the
harness's own configuration. The chat epic (E4) spawns the single Gru
session in production: `/ws` authenticates against `[auth].token`, and
`managed_repos` and `workspace_root` feed the server-side managed GitHub
overview; an absent/empty list makes no repository provider calls. `[server]`
host/port bind both the web UI (served from `web/dist` when built) and the
chat socket. `/health` surfaces a summary (`workspace_root`, `data_dir`) plus
real liveness. See
[CHAT.md](./CHAT.md) for the chat protocol and reconnect contract,
[RUNTIMES.md](./RUNTIMES.md) for the capability matrix, fallback
semantics, and the session-store contract, and
[SUPERVISION.md](./SUPERVISION.md) for the supervision policy the
`[supervision]` table drives plus the log-rotation knobs.

### Vector's raids: `proposed` or `autonomous`

`[vector]` is off by default, because raids spend quota. Turn it on with
`enabled = true`. Two settings then decide how much Gru does without asking
you. [VECTOR.md](./VECTOR.md) describes the whole flow.

- **`raid_mode`** decides what happens when Gru picks a package to raid.
  - **`"proposed"` (default).** Say Gru picks `billing-api/src/refunds` because
    twelve commits landed there since its last raid. You get one FOR YOU card:
    "Launch Vector's raid on billing-api/src/refunds?", with Gru's reason, the
    budget and the ranking signals. Accept queues the raid for Silas. Decline
    is recorded, and that package is not proposed again until its code
    changes. If the code changes before you answer, the card is withdrawn.
  - **`"autonomous"`.** Say Gru makes the same pick overnight. The raid
    launches straight away and waits in Silas's queue until no heist work is
    waiting. You see "Vector raid launched: billing-api/src/refunds" in the
    board's activity, not in FOR YOU. The daily cap still binds: with
    `max_raids_per_day = 2`, a third raid on billing-api within 24 hours is
    refused, and the refusal names the cap.
- **`fix_mode`** decides what happens when a raid breaks in: a qualified
  counterexample that a fresh replay confirmed.
  - **`"proposed"` (default).** Say the raid finds that a refund of `-1`
    cents comes back negative, and a fresh replay reproduces it. You get one
    FOR YOU card: "Dispatch a fix heist for Vector's break-in on
    billing-api/src/refunds?". It shows the invariant, the counterexample and
    the replay seed, and its Details hold the frozen contract, the shrink path
    and the receipts. Only Accept makes Gru dispatch the fix heist. Decline is
    recorded, and the same requirement and invariant is not proposed again
    until that package's code changes.
  - **`"autonomous"`.** The same break-in dispatches the fix heist at once,
    and you see "Vector fix heist dispatched" in the board's activity. If the
    dispatch fails, Gru gets an action-required row, and the dispatch is
    retried every five minutes.

  Either way, the fix runs through normal review, convergence, verification
  and readiness.

Asking Gru in chat to raid a package counts as your Accept. It is checked
against the same candidate list, so a package code excluded is refused, with
the reason. With `enabled = false`, a chat request is refused and says how to
turn raids on.

### Onboarding: `proposed`, `autonomous` or `off`

`[onboarding] mode` decides what GC does about a managed repository whose
origin default branch has no `.gru-command/worktree.toml`. Such a repository's
lanes get no setup and no verify command. [ONBOARDING.md](./ONBOARDING.md)
describes the whole flow.

- **`"proposed"` (default).** Say `swift-app`'s origin `main` has no manifest.
  At start you get one FOR YOU card, "Onboard swift-app". Accept dispatches a
  heist whose minion reads the repository's CI, build files and README and opens
  "Onboard swift-app to GC". Decline is remembered: swift-app is not proposed
  again until you ask Gru to propose it. A restart while the card waits posts
  no second card.
- **`"autonomous"`.** The same scan dispatches the heist straight away. You see
  "Onboarding heist dispatched: swift-app" in the board's activity, not in FOR
  YOU. Only a repository's first onboarding heist starts this way. If it ends
  without the manifest reaching origin, the next scan asks you with a card.
- **`"off"`.** Nothing is checked, proposed or dispatched, and the installer's
  consent file is not read. An onboarding heist that is already open is still
  proven before review
  ([ONBOARDING.md](./ONBOARDING.md#proof-before-review)): `off` stops new
  onboarding, never the gate on an open PR.

If origin cannot be reached, nothing happens: GC logs why and checks again at
the next start. Answering yes to the wizard's "Onboard them now?" skips the
cards for those repositories in any mode except `"off"`.

### Disk: `disk_budget_gb`, `min_free_disk_gb` and `reclaim_mode`

Three `[worktrees]` keys keep GC from filling the disk (#427).
[WORKTREES.md](./WORKTREES.md#8-disk-view-budget-and-floor-427) describes the
whole flow. GB here is 2^30 bytes, as `df -h` counts. Each GB value is a
finite number from 0 to 1000000; anything else refuses to load, naming the
key.

- **`disk_budget_gb = 30`** (default). Say GC uses 34 GB under `data_dir`: three
  lanes of merged jobs, five idle lanes and their review folders. At its next
  check (every five minutes, and after each lane is created) GC releases the
  merged jobs' lanes once they have settled (their work is saved first),
  deletes those jobs' review folders, then slims idle lanes, oldest idle first.
  It stops once it uses at most 27 GB (90% of the budget), and starts again
  only over 30 GB. Each step is recorded. The budget never stops or refuses a
  heist.
- **`min_free_disk_gb = 10`** (default). Say the disk lanes are created on (or
  `data_dir`'s) has 6 GB free. A new job lane, or a writer child's lane, waits
  in a queue, and its note says "queued: 6.0 GB free is below the 10 GB floor
  ([worktrees] min_free_disk_gb)" and what GC is doing about it ("GC is freeing
  space", "the reclaim card is waiting for the owner's decision", or "nothing
  more can be freed without losing work; Gru has been told"). GC frees space at
  once, and once the disk has 10 GB free the lanes are created one at a time.
  Review lanes never wait. A floor at or above the disk's size could never be
  met: GC treats it as off and tells Gru.
- **`reclaim_mode = "automatic"`** (default) frees the space on its own. With
  **`"proposed"`**, GC posts one FOR YOU card listing each step and the space
  it frees, and does nothing until you Accept. Decline changes nothing, and GC
  asks again once its usage grows by another 10% of the budget past its usage
  when you declined. Switching back to `"automatic"` withdraws an open card at
  the next start.

When GC is over the budget or under the floor and nothing it can free remains
(every lane in use, say), Gru gets one row naming GC's usage by category, the
largest lanes and how much of the disk is not GC's. The row closes itself once
the condition clears. `0` turns the budget or the floor off; the board's disk
row and `GET /api/disk` still show the numbers.

### Nefario's briefing review: stage auto, 1, 2 or 3

`[briefing_review]` configures Nefario, the pre-dispatch review of a heist
briefing ([BRIEFING-REVIEW.md](./BRIEFING-REVIEW.md)). Two keys:

- **`enabled`** (boolean, default `true`). `false` is the stop state: a
  commission answers 503 `briefing_review_disabled`, the dispatch gate admits
  everything, and the cockpit card shows zeros. Nothing else changes: Perkins,
  intake approval, merge authority and the verbatim-briefing contract are
  untouched either way.
- **`stage`** (exactly `auto`, `1`, `2` or `3`, default `auto`). `auto` follows
  the tier: high and medium are enforced, low is advisory. Stage 1 records
  provenance and refuses only a **false** provenance claim — a dispatch that
  says "READY" for a review that holds no verdict, or names a sha it is not
  dispatching. Stage 2 refuses a **high-tier** dispatch whose exact briefing sha
  has no `READY` review and no recorded push-back, before any job row exists.
  Stage 3 forces high and medium enforcement. Low stays advisory at every stage.

The default is **`stage = "auto"`**: enforcement follows the tier; every
non-low tier is held (today high and medium), and low is advisory. Auto is
forward-looking: a tier added later is enforced without a config edit; stage 3
pins today's high + medium set. Set `stage = 1` (advisory), `2` (high only)
or `3` (force high + medium) to override it. Promotion is a config change, not
a code change. Before a flip, in-flight reviews at the newly enforced tier are
revised or pushed back.

The section is emitted **as a commented example** in a freshly generated config
so a default config stays parseable by a pre-Nefario build after `gru roll`; a
re-run re-emits it active, like `[env]` and `[pacing]`. An install that has
enabled it and wants to roll back must remove the block first. Invalid values
fail loud: `briefing_review.stage must be "auto", 1, 2 or 3 …`.

### Mailbox recovery cadence

`[chat].mailbox_reconcile_interval_ms` is an integer **1–2147483647** in
milliseconds, default **300000**; larger values are rejected before Node can
clamp them into a one-millisecond timer. Recovery also runs at startup and on coalesced ledger source
events. It executes metadata reconciliation only; actual model turns still pass
all existing Gru admission gates. `notify_wake = "never"` remains passive-only
and records explicit admission deferrals. Rechecks do not grant owner-stop,
merge, deployment or restart authority.
