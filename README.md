# Gru Command

A standalone, installable multi-agent orchestrator. One Node.js service
hosts every agent as a headless session behind a pluggable runtime
adapter (Claude Code, the default for new installs, or `pi`), with a web front-end for chat with the
single Gru, the live heist board, and per-agent transcripts. The browser
is the only required window.

**v1.0.0** — chat with the single Gru, the SQLite ledger of record, the
live board dashboard with per-agent transcripts, in-process supervision
(restart ladders + crash-loop breakers), notifications with acks, the
dispatch flow (briefing → worktree lanes → minions → Perkins review
waves), and OS service install — see [docs/EPICS.md](docs/EPICS.md).

## What's inside

- **Chat with one brain** — a single Gru session behind an authenticated
  WebSocket; reconnect-safe history with tab-local durable outbox recovery. See native
  context usage when the provider exposes it, compact in place, or start a
  fresh durable chat epoch without deleting old transcripts. Attach
  workspace files, phone camera/gallery files, or clipboard images through
  one path-based flow; text-only models decline image interpretation
  visibly instead of guessing ([CHAT.md](docs/CHAT.md)).
- **Review source intake** — preview GitHub issues, specs and BMAD documents
  in the existing chat without executing them. Edit immutable concrete plans,
  select dependency-complete work, explicitly approve into the existing pipeline,
  and recover accepted identities after reconnects ([INTAKE.md](docs/INTAKE.md)).
  No BMAD installation is required; imported statuses are data, not authority.
- **The live board** — repo-grouped job cards, per-agent state chips,
  review rounds with per-lens live chips, notification center
  ([BOARD.md](docs/BOARD.md)).
- **Dispatch flow** — briefing → per-job git worktrees → minions →
  adversarial hybrid review waves → SHA-bound PR verdicts. One Perkins lead
  reviews the complete frozen change and selects optional specialist lenses
  from the nine-lens whole-change catalog (eight for explicit no-spec).
  Specialists run in lead-submitted batches inside ONE round, bounded to 16
  real runs, two attempts per lens, and two terminal submissions, with
  failed and unused lenses reported as real coverage facts rather than a
  mandatory gate. Its install-relative, integrity-pinned policy is the sole
  prompt authority; repository text is untrusted evidence. Claude leads alone
  receive a fresh scoped MCP bridge for the same narrow native tools
  ([FLOW.md](docs/FLOW.md), [WORKTREES.md](docs/WORKTREES.md)).
- **Hosted ops (Silas)** — the operations role runs as a supervised session
  that closes the follow-through loop without a human ping (delivered job →
  PR registered → review wave) and breaks recurring blocker loops: same
  blocker twice → fix directive, third → re-brief a fresh minion, fourth →
  escalation. Evolving blockers keep looping — there is no round cap
  ([FLOW.md](docs/FLOW.md)).
- **Book of Lessons** — deliberate journal entries (Gru, Silas, and opt-in
  minion lessons blocks) are distilled by a cadence dream into a concise,
  deduplicated bible with provenance; briefings and directives carry
  pointer lines only, and agents read the pointed section on demand
  ([LESSONS.md](docs/LESSONS.md)).
- **Pluggable runtimes** — Claude Code (default for new installs) and `pi` adapters;
  models/thinking default to each runtime's own configuration
  ([RUNTIMES.md](docs/RUNTIMES.md)).
- **Robustness** — durable sessions with resume, restart ladders,
  crash-loop breakers, login-started OS service
  ([SUPERVISION.md](docs/SUPERVISION.md)).

## Screenshots

*(placeholder — the chat window, the board, and the phone layout land
here before the v1.0.0 tag)*

## Prerequisites

- **Node.js ≥ 22.19** — the service runtime and build toolchain.
- **Python 3 ≥ 3.8 on macOS** — required for descriptor-bound installed-code fingerprinting and Perkins review recovery; `install.sh` verifies inherited-directory-FD support before setup, update, or service registration.
- **git** — per-job worktree lanes and branch inspection.
- **GitHub CLI (`gh`), authenticated for every managed repo** — the
  GitHub signal poll and the round's code-host preflight always ride
  `gh`. SHA-bound Perkins verdict delivery also rides `gh` unless a
  Perkins App bundle is installed, in which case github.com publication
  is App-authored while the preflight still uses `gh`
  ([PERKINS-APP-PUBLICATION.md](docs/PERKINS-APP-PUBLICATION.md)). Run
  `gh auth login` with a token that can read the repositories (`repo`
  scope for private repos) and confirm with `gh auth status`.
- **Perkins App bundle — install prerequisite for review verdicts.** On
  github.com, Perkins publishes its verdicts as the installed GitHub App
  (`perkins-review[bot]`), never your personal `gh` account (owner ruling
  2026-09-27): GitHub rejects an account approving its own pull request,
  and every heist PR is created by that same `gh` identity. The service
  selects its publisher once at startup, so provision the bundle before
  the first review round:

  1. **GitHub App** — install it (id `4366368` for this deployment) in the
     org that hosts the reviewed repositories, with access to those
     repositories. Note each owner's **installation id** from the
     installation URL.
  2. **Bundle** — in the instance dir (default `~/.gru-command/`), as
     literal `KEY=VALUE` data (parsed as bytes, never sourced as a shell
     script):

     ```text
     ~/.gru-command/perkins/config        # 0600
       app_id=4366368
       key_path="/absolute/path/to/app-key.pem"
       installation_id_<owner>=<installation id>   # one per reviewed owner
     ~/.gru-command/perkins/app-key.pem   # 0600, the RSA PEM from the App settings page
     ```

     Regular files owned by the service user, owner-only (`0600`; a
     hardened `0400` is accepted); the bundle directory itself exactly
     `0700`. One `installation_id_<owner>` per reviewed repository owner
     (case-insensitive, hyphens fine).
  3. **Restart the service** — the poster resolves the bundle at startup
     only.
  4. **Verify** — run a review round; the verdict must post as
     `perkins-review[bot]`. If it posts as your personal account, the
     bundle did not resolve.

  With `[review] enabled = true`, the setup wizard and every service boot
  name the gap (`verdict publication identity: MISSING — reviews will run
  but verdicts cannot post (self-author 422)`) instead of letting a full
  round die on the `422`; the legacy personal-`gh` publisher remains a
  documented compatibility fallback, never a silent one. Full reference:
  [PERKINS-APP-PUBLICATION.md](docs/PERKINS-APP-PUBLICATION.md).

GitHub signal ingestion is poll-only — no webhooks, no inbound tunnel.

## Setup

1. **Install** — the one-liner (or clone + `./install.sh`) below installs
   dependencies, builds the service and web UI, and runs the wizard. The
   wizard writes the live config at `~/.gru-command/config.toml`,
   smoke-tests first boot, and prints whether the Perkins App bundle (the
   verdict-publication prerequisite above) is in place — with the setup
   guide inline when it is not. Re-running the one-liner is a safe updater;
   it keeps the existing config, skips the wizard, and surfaces a missing
   bundle at the next service boot.
2. **Register the service** — `./install.sh --service` registers and
   starts the login OS service (see [Run](#run)); `./install.sh
   --uninstall` removes it.
3. **GitHub signal poll** — the Silas watchtower polls every tracked job
   branch through authenticated `gh api` (`[silas] poll_interval_ms`,
   default 60000 ms; `0` disables). Once per tick it reads
   `repos/{owner}/{repo}/pulls` for merged state and `mergeable_state`,
   and `repos/{owner}/{repo}/commits/{sha}/check-runs` for the latest
   check-run conclusions. Each observed state CHANGE applies exactly
   once: a merged PR closes its lane (`github.pr-merged`), a conflicting
   PR (`mergeable_state: dirty`) cascades an fyi notification (mechanical
   tier — Silas coordinates the conflict integration), a CI failure posts
   a notification carrying the run URL
   (mechanical checks → fyi, judgment checks → action-required), and CI
   green records the review-gate signal event (`github.ci-green`). The
   per-tick call budget caps usage at 3 000 of the authenticated
   5 000 requests/hour GitHub budget. Webhooks remain a possible future
   option and are not built.

   Verify the same data by hand:

   ```bash
   gh auth status
   gh api "repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=5" \
     --jq '.[] | {number, state, merged_at, mergeable_state, head: .head.ref}'
   gh api "repos/{owner}/{repo}/commits/{sha}/check-runs" \
     --jq '.check_runs[] | {name, status, conclusion, url: .details_url}'
   gh api rate_limit --jq '.resources.core'
   ```

## Install

One line (macOS + Linux, Node ≥ 22.19, git; **macOS also requires Python 3 ≥ 3.8**):

```bash
curl -fsSL https://raw.githubusercontent.com/mssoka/gru-command/main/install.sh | bash
```

On macOS, the installer verifies that Python 3 can enumerate an inherited
checked directory descriptor before setup, update or service registration.
It pins the resolved absolute interpreter in the launchd unit as
`GRU_COMMAND_REVIEW_PYTHON`, so startup does not depend on an interactive
shell or version-manager shim. Set `GRU_COMMAND_REVIEW_PYTHON` to a stable
absolute Python 3 executable if it is not found on `PATH`. Missing or
unusable Python stops installation before mutation; at runtime, review
identity fails closed rather than crediting incompatible checkpoints.
`--help`, `--print`, and `--uninstall` remain available without Python.
See [the prerequisite decision](docs/decisions/gh-168-darwin-python-review-enumeration.md).

That single invocation clones to `~/gru-command`, installs dependencies,
builds the service and web UI, and runs the setup wizard through
`/dev/tty` even though the script itself is piped. The wizard detects
Claude Code/`pi` (new installs default to Claude Code; pick `pi` explicitly if you use it), offers Git repositories under the configured
`workspace_root`, and persists the exact selected subset as `managed_repos`
in `~/.gru-command/config.toml`. The root may contain unselected sibling
projects; only configured names appear in the GitHub overview. An older
config without the list manages none until the owner edits the explicit
names and restarts the service ([CONFIG.md](docs/CONFIG.md)). The wizard
smoke-tests first boot and can register/start the owned OS service. A truly
headless environment fails immediately with the exact `--no-interact`
command instead of hanging.

Or clone it yourself and run the wizard in one go:

```bash
git clone https://github.com/mssoka/gru-command.git
cd gru-command
./install.sh            # deps + build, then the wizard
```

Explicit non-interactive defaults (the JSON is optional). Omit `token` to
generate the pairing token privately in-process; an explicitly supplied token
is an ordinary command-line argument and may be visible to local process
inspection:

```bash
./install.sh --no-interact
./install.sh --no-interact --answers '{}'
```

Re-running the one-liner or `./install.sh` for a configured instance is
a safe updater: it refuses a dirty/diverged clone, uses
`git pull --ff-only`, installs dependencies, rebuilds, preserves the
config, and restarts only a service unit that names this exact
repo/instance — and if that unit is missing entirely (deleted plist,
failed prior install), the updater registers it afresh: prompted
interactively, automatic under `--no-interact` or whenever no terminal is
available (cron/CI); declining keeps the run green and prints the
`./install.sh --service` hint. You do not have to poll the repository to
notice a release: the board's **deploy** check compares the build's
`dist/build-rev.json` with `origin/main` (every 5 minutes) and with the
newest stable `vX.Y.Z` reachable from `origin/main` (a tag on another ref
is never advertised — pulling main could not deliver it). A build older
than that release reads the tag with an `UPDATE AVAILABLE` flag and that
state wins over the commit count; otherwise a build behind main reads
`N behind` with a `RESTART PENDING` flag. `gru version` prints
the version stamped into the build plus its SHA, offline. Generate a
fresh complete config separately with:

```bash
npm run config:generate                 # refuses an existing file
npm run config:generate -- --force      # timestamped 0600 backup first
```

### GC-owned delivery resources

GC ships directly editable build/planning/review resources with their own
identity and content integrity in `resources/gc-workflows/`. Both normal and
small-change paths retain independent tracked review, reasoned fixes,
verification and ordinary PR handoff, without finding or tool-call quotas.
The new package resolves with explicit project/job/worktree/artifact/knowledge
context and no project/global BMAD, Python/uv or external skill dependency.
See [docs/GC-WORKFLOWS.md](docs/GC-WORKFLOWS.md) for invocation, local manifest
refresh, packaging tests and retained lane bindings.

New implementation jobs now receive this owned package and explicit registered
project/job context on both Pi and Claude Code. Operational material is private
under `<data_dir>/projects/<project-key>/jobs/<job-id>/operational/`; approved
portable knowledge belongs in the assigned worktree's `gru-output/`. GC-invoked
fallback review uses a verified owned helper, not a global `bmad-review` install.
Fallback PASS clears review/fix routing only, never native Perkins READY.
Independent BMAD installs and historical outputs/bindings remain untouched;
resumes retain their original package or fail with exact restoration guidance.
Setup validates Git/GC prerequisites without a BMAD provisioning step. It creates
no project BMAD files, skills or outputs; obsolete headless `bmad` answers must be
removed explicitly. User project setup commands remain authoritative. Retire old
GC-marked bootstrap blocks with the owner-run, backup-first procedure in
[docs/BMAD-RUNTIME.md](docs/BMAD-RUNTIME.md), not automatic cleanup.

### GC-managed BMAD runtime (historical)

The pinned `bmad-method@6.12.0` build package remains available for already-bound
historical lanes. New jobs select GC-owned delivery resources instead. An upgrade
never switches a running lane's workflow; missing retained bytes require restoring
that exact package, not recreating the worker/worktree/PR. Perkins (GitHub/GitLab)
remains the exact-head native release gate, and the owner performs every final PR
merge.

You need the selected runtime CLI (`claude` by default, or `pi`) for agents. Setup fails loud, naming the missing CLI and how to select the other runtime, instead of silently falling back. Existing installs keep the runtime their `config.toml` already says; only newly generated configs default to Claude Code. Only retained
historical BMAD rendering uses `uv`; current setup and owned GC execution do not.
Installing, breaking or removing independent BMAD does not affect GC setup or
workflow selection. [docs/BMAD-RUNTIME.md](docs/BMAD-RUNTIME.md) covers:

- the bundled set
- configuration precedence
- job binding
- the deliberate upstream-upgrade procedure
- license notices
- the tested commands for retiring an old repo-local `_bmad` install by hand

## Run

```bash
npm start               # serve the web UI + /health on the configured bind
./install.sh --service  # register + start as a login OS service (and refresh gru)
./install.sh --uninstall
```

Install and update also put a `gru` command in `~/.local/bin` (the
installer says when that directory is not on your PATH). It runs this
checkout's CLI from any directory:

```bash
gru update              # pull main, rebuild, restart (./install.sh --update, from anywhere)
gru restart             # apply config.toml edits: drain in-flight turns, relaunch the installed build
gru restart --now       # restart at once; boot recovery resumes the turns it cut
gru stop                # stop the service (down until gru start, a reboot or your next login)
gru start               # start it again
gru status              # running build, installed build, how far behind main
gru logs -f             # follow the service log
gru version             # installed version + build SHA (offline; --json)
gru reset               # with the service stopped: remove GC's lanes, empty the data dir, keep config.toml
gru roll [--detach]     # the self-roll; inside the service use --detach (gru update does)
```

`gru-service` is the same command under its older name. A `gru` already in
`~/.local/bin` that the installer did not write is left alone.

`gru reset` is the clean fresh start. Stop the service first (`gru stop`); reset
lists what it will do and asks (or pass `--yes`). It removes every GC lane
from the repository that registers it (`git worktree remove --force
--force`, then `git worktree prune`) and deletes the data directory's
contents except `config.toml`, the install's own files and any worktree of
yours in it (with its repository when that is there too), the ledger last; a service started meanwhile refuses to open
its ledger until reset ends. `gru/*` branches go only with
`--delete-branches` and `refs/gru/*` only with `--delete-refs`; your own
branches, worktrees and files are never touched
([docs/WORKTREES.md](docs/WORKTREES.md#7-expiry-moved-repositories-and-reset-427)).

Open `http://127.0.0.1:7665`, enter the pairing token from the wizard
(or scan the QR from an already-paired device). To pair a phone, bind
the machine's LAN address (v1 is LAN + token only — no TLS, never
expose it to the WAN). Unauthenticated `GET /health` answers liveness
only (service/version/health signal); the full operator payload
(workspace paths, install fingerprint, supervision detail) requires
the pairing token — a deliberate disclosure limit on the pairing
surface. Service management, supervision behavior, the emergency
console, forensics and backups:
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Optional: Jev decisions (OpenRouter key)

Gru Command runs fully without this. **Jev** is TypeSafe's System One decision model, served through OpenRouter. It is an optional, very cheap decision aid for a few bounded judgments, for example:

- triaging an alert;
- recognising the same review blocker across rounds;
- classifying an escalation.

It is **off by default**. While it is off, deterministic code makes every decision.

**What to expect**

- **Shadow mode first.** You start in shadow mode: Jev is asked and its answers are recorded in the ledger (`decisions.shadow`), but Gru Command keeps using the deterministic answer. Behaviour cannot change.
- **The cost is tiny.** Jev costs about $0.04 per million input tokens, and a decision is a few hundred tokens (about $0.00002). Use a **dedicated OpenRouter key with a low credit limit**.
- **Enforcement is gated.** Moving a surface from shadow to `enforce` requires a recorded backtest that meets its threshold, and your explicit decision. It is not usable on any surface yet. See the [Jev guide](docs/jev-production-integration.md).
- **Authority stays with you.** Jev never decides merges, review verdicts, restarts or owner-only rulings. If OpenRouter is unreachable, Gru Command falls back to deterministic behaviour.

Every command below (`npm run config:generate` and each `dist/decisions/cli.js` call) reads the instance from `GRU_COMMAND_HOME` (default `~/.gru-command`). If your service uses another value, export it first. `install.sh` wrote it into the service file; run the block for your OS. It exports nothing when the file has no value, and prints the instance the commands will use:

```bash
# macOS
v="$(plutil -extract EnvironmentVariables.GRU_COMMAND_HOME raw -o - ~/Library/LaunchAgents/com.gru-command.service.plist 2>/dev/null)"; [ -n "$v" ] && export GRU_COMMAND_HOME="$v"; unset v
echo "instance: ${GRU_COMMAND_HOME:-$HOME/.gru-command}"
```

```bash
# Linux (systemd uses the last assignment; install.sh quotes a path containing spaces, tr drops those quotes)
v="$(sed -n 's/^Environment=GRU_COMMAND_HOME=//p' "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/gru-command.service" 2>/dev/null | tail -n 1 | tr -d '"')"; [ -n "$v" ] && export GRU_COMMAND_HOME="$v"; unset v
echo "instance: ${GRU_COMMAND_HOME:-$HOME/.gru-command}"
```

**1. Store the key.** Use stdin only: never pass the key on the command line or put it in `config.toml`.

Create a key at openrouter.ai → **Keys**. Copy **only the key**: it starts with `sk-or-v1-` and is 73 characters long, with no `OPENROUTER_API_KEY=` prefix and no quotes. Then, from the install directory:

```bash
# macOS: from the clipboard
pbpaste | cut -c1-9           # sanity check: must print sk-or-v1-
pbpaste | node dist/decisions/cli.js credentials set --stdin
pbcopy < /dev/null            # clear the clipboard

# Linux: hidden prompt
read -rs KEY && printf '%s\n' "$KEY" | node dist/decisions/cli.js credentials set --stdin; unset KEY
```

This writes `~/.gru-command/credentials/openrouter.key` (or under `$GRU_COMMAND_HOME`). The folder is `0700` and the file `0600`.

- **Don't create the folder yourself.** A folder with looser permissions is refused as unsafe.
- **Don't edit the file.** If an editor adds a final newline, that is tolerated; a second line is not.
- **Environment variable alternative.** An `OPENROUTER_API_KEY` variable in the service environment also works and takes precedence. The file is the recommended store.

**Modes.** Each `[decisions.surfaces.<surface>]` picks one mode. `node dist/decisions/cli.js config-template` prints the full annotated fragment.

| Mode | What Gru Command does |
|---|---|
| `off` | Deterministic only; Jev is never asked |
| `shadow` | Asks Jev and records its answer, but always uses the deterministic answer. **Start here.** |
| `enforce` | Uses Jev's answer, with deterministic fallback. It refuses to run until a recorded backtest meets its threshold. Not usable on any surface yet: on `event_triage` and `supervision_guidance` it rejects every Jev ask (the deterministic answer still serves) and opens an owner incident, elsewhere it never asks, and anywhere it makes a transient default-profile outage page you. |
| *(no mode key)* | Legacy behaviour. `event_triage` and `supervision_guidance` use Jev's answer with **no** backtest gate, and a transient outage pages you; `escalation_triage`, `same_blocker` and `report_conclusion` never ask Jev. Avoid it by giving every surface an explicit mode. |

**2. Enable Jev in shadow mode.** The service hot-reloads this section, so no restart is needed. Give every surface an explicit `mode = "shadow"`: an unlisted or mode-less `event_triage` or `supervision_guidance` would act on Jev's answer instead of only recording it.

- **Fresh install:** your `config.toml` already contains the Jev block, switched off, with every surface in shadow. Set `enabled = true` in its `[decisions.jev]` table. Edit in place; a pasted second copy of a table fails to load.
- **Older config, Jev off, no surface listed:** run `npm run config:generate -- --force` from the install directory first, then set `enabled = true`. It backs the old file up and keeps your values, but drops hand-written comments; the [Jev guide](docs/jev-production-integration.md#configuration) has the details.
- **Older config with Jev on, or with any surface listed:** a regenerate keeps exactly those surface entries (none, if none are listed). With Jev on and no surface listed, every transient outage pages you and two surfaces act ungated, so fix it now: set `enabled = false` (hot-reloads), run `npm run config:generate -- --force` (it drops hand-written comments; the backup keeps them), then set `enabled = true` again. Otherwise edit by hand: set `mode = "shadow"` in each existing surface table, turn a shorthand `event_triage = "<profile>"` key into a table that keeps `provider = "<profile>"`, then add only the missing tables. Do it before turning Jev on, or right away if it is already on.

The Jev and surface tables should read as follows (any provider and threshold tables after them stay as they are):

```toml
[decisions.jev]
enabled = true
model = "~typesafe/jev-latest"
endpoint = "https://openrouter.ai/api/alpha/decisions"
timeout_ms = 5000

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
```

**3. Verify.** No key material is printed.

```bash
# An OPENROUTER_API_KEY exported in your shell outranks the key file; use env -u so you see what the service sees
env -u OPENROUTER_API_KEY node dist/decisions/cli.js status --json   # credential_present: true, credential_source: "file"
env -u OPENROUTER_API_KEY node dist/decisions/cli.js check --json    # one tiny live probe; expect "status":"ready"
```

`install.sh` puts no key variable in the service unit, so unless you added one to the service's environment, the service uses the key file. If the service does get `OPENROUTER_API_KEY` from its environment (check with `launchctl getenv OPENROUTER_API_KEY` on macOS or `systemctl --user show-environment` on Linux), run these commands with that value exported instead, and expect `credential_source: "environment"`.

`check` only probes while `enabled = true`; while Jev is off it reports `disabled`. If it isn't `ready`, set `enabled = false` until it is. Otherwise a running service reports the provider as degraded and raises an alert.

| `check` reason | What it means / fix |
|---|---|
| `credential_missing` | No key stored. Do step 1. |
| `auth_rejected` | OpenRouter refused the key. You copied something other than the bare `sk-or-v1-…` key, or the key is revoked. Repeat step 1. |
| `credit_exhausted` | The key's credit limit is spent (HTTP 402). Add credit to the account, then recheck. Only you can fix this; it never heals on its own. |
| `forbidden` | The key is valid but has no access to the decisions model. Check the key's model limits. |
| `credential_invalid` | The file holds more than one line. Repeat step 1 instead of editing the file. |
| `credential_unsafe` | Folder or file permissions are too open, or the file is a symlink. Remove `~/.gru-command/credentials` and repeat step 1. |
| `endpoint_untrusted` | The configured endpoint is not a verified HTTPS decisions endpoint. Restore it. |
| `endpoint_not_found` / `malformed_request` | The endpoint path or model name is wrong (HTTP 404/400/422). Check the `model` and `endpoint` values above. |
| `probe_failed` / `malformed_response` | OpenRouter answered, but not as expected. Check the `model` and `endpoint` values above. |
| `provider_degraded` / `network_error` | Transient provider trouble (HTTP 408/429, 5xx, or no connection). Jev rechecks automatically on a bounded backoff; use Recheck if it persists. |
| `timeout` | Answers are slower than `timeout_ms`. A single slow shadow ask is only recorded; 3 in a row mark Jev degraded, and it rechecks automatically. If this keeps happening on a healthy network, raise `timeout_ms` (for example to 8000). |

Full reference (provider profiles including TypeSafe direct and a local `/v1/systemone` model, backtests, enforcement): [docs/jev-production-integration.md](docs/jev-production-integration.md).

## Documentation

| Doc | What it covers |
|---|---|
| [SPEC.md](docs/SPEC.md) | the product constitution — 19 locked rulings |
| [CONFIG.md](docs/CONFIG.md) | configuration reference (schema + validation) |
| [OPERATIONS.md](docs/OPERATIONS.md) | running it: services, emergency console, forensics, backups |
| [CHAT.md](docs/CHAT.md) | the single-Gru chat socket protocol + reconnect contract |
| [BOARD.md](docs/BOARD.md) | the live board dashboard + transcripts |
| [LEDGER.md](docs/LEDGER.md) | the SQLite ledger of record |
| [FLOW.md](docs/FLOW.md) | the dispatch flow: briefing → lanes → review waves |
| [WORKTREES.md](docs/WORKTREES.md) | the worktree manager (preserve-first sweeps) |
| [ONBOARDING.md](docs/ONBOARDING.md) | onboarding heists: a manifest PR for each managed repo that has none |
| [RUNTIMES.md](docs/RUNTIMES.md) | runtime adapters, capabilities, session store |
| [jev-production-integration.md](docs/jev-production-integration.md) | optional Jev decision provider: OpenRouter key, shadow mode, backtests, troubleshooting |
| [SUPERVISION.md](docs/SUPERVISION.md) | supervision, notifications, OS service install |
| [ROLES.md](docs/ROLES.md) | the five product-native roles |
| [UI.md](docs/UI.md) | the web front-end + design system |
| [EPICS.md](docs/EPICS.md) | epic/story plan (v1 scope) |

## Development

```bash
npm install
npm test        # full gate: lint + typecheck + build + fast + heavy + web
npm run build   # prerequisite for the standalone phase commands below (dist-dependent suites)
npm run test:backend        # fast suites (30s test/hook budget, up to 4 workers)
npm run test:backend:heavy  # process-heavy integration suites (120s budget, up to 2 workers)
npm run test:backend:heavy -- test/perkins-whole-review.test.ts  # debug one heavy file
npm run wizard  # fresh wizard; use -- --force to replace config with backup
```

The backend suite is routed by real workload. Fast unit/in-process suites keep
the 30s ceiling; the process-heavy integration files (real install/build
pipelines, spawned services and CLIs, PTY, git worktree/review flows) are
listed with per-file reasons in `test/helpers/test-budgets.ts`, run at a 120s
ceiling, and are capped at two workers. Both phases run sequentially inside
`npm test`, so the aggregate worker count never exceeds the verification
scheduler's single global budget. `npx vitest run` alone runs the fast phase;
use `npm run test:backend:heavy` for the classified files. Both standalone
phases assume `npm run build` has run first — several suites boot `dist/`
artifacts — while `npm test` builds before either phase.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) is the authoritative full gate — it runs `npm test` on every pull request and push to `main`; dispatch lanes verify only their narrow suites locally.

The default test suite runs fully offline (stub model provider, stubbed
claude CLI double, fixture PATHs). Opt-in live smoke tests and the
fresh-machine install rehearsal are env-gated — see
[docs/RUNTIMES.md](docs/RUNTIMES.md) and
[docs/OPERATIONS.md](docs/OPERATIONS.md#install-rehearsal).

## License

MIT — see [LICENSE](LICENSE).
