# Gru Command

A standalone, installable multi-agent orchestrator. One Node.js service
hosts every agent as a headless session behind a pluggable runtime
adapter (`pi` or Claude Code), with a web front-end for chat with the
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
- **Pluggable runtimes** — `pi` (reference) and Claude Code adapters;
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

GitHub signal ingestion is poll-only — no webhooks, no inbound tunnel.

## Setup

1. **Install** — the one-liner (or clone + `./install.sh`) below installs
   dependencies, builds the service and web UI, and runs the wizard. The
   wizard writes the live config at `~/.gru-command/config.toml` and
   smoke-tests first boot. Re-running the one-liner is a safe updater.
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
   PR (`mergeable_state: dirty`) cascades an action-required
   notification, a CI failure posts a notification carrying the run URL
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
`pi`/Claude Code, selects managed repos, writes the complete commented
live config at `~/.gru-command/config.toml`, smoke-tests first boot, and
can register/start the owned OS service. A truly headless environment
fails immediately with the exact `--no-interact` command instead of
hanging.

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
`./install.sh --service` hint. Generate a fresh complete config separately with:

```bash
npm run config:generate                 # refuses an existing file
npm run config:generate -- --force      # timestamped 0600 backup first
```

### Project-local BMAD setup

For each selected managed repo—not the workspace root and never every
discovered directory—the wizard offers official BMAD setup, default on
for fresh repos. This release pins `bmad-method@6.12.0` and installs all
four approved defaults: `bmm,cis,tea,gds` (core is implicit), with
external pins `cis=v0.3.2`, `tea=v1.27.2`, `gds=v0.7.2`. Runtime bindings
follow the selected `pi`/Claude tools. Existing/customized installs
default to **reuse unchanged**; per-repo skip is always available.
The pinned set carries `bmad-review` out of the box, and it is a gate:
0 blockers means clear to merge, while blockers route back to the
implementing minion as fix directives—never inform-only. Perkins
(GitHub/GitLab) remains the stronger gate with exact-head verdicts and
autonomous-merge authority.

Successful setup records exact versions in
`.gru-command/bmad-install.json`, adds an idempotent owned bootstrap
block to `.gru-command/worktree.toml`, and uses narrow Git-local excludes
for generated paths. It does not blanket-ignore `.agents/`, `.claude/`,
or `_bmad-output/`, and never untracks files. Commit the three
`.gru-command/` bootstrap files so newly-created worktrees can copy an
isolated project-local BMAD install and discover `bmad-build`; generated
skills/output remain local. Network and prerequisite failures name the
repo and keep retry or explicit skip; deterministic state failures—a
broken or partial install, a missing/unsafe module directory, a missing
runtime binding—offer skip-only with deliberate repair guidance
(install-repair classes additionally name the official repair path
`npx bmad-method install` in that repository), never an automatic
overwrite. No false-ready state.

You need the selected runtime CLI (`pi` or `claude`) for agents and `uv`
for BMAD workflows. Missing prerequisites are reported before a repo is
marked BMAD-ready.

## Run

```bash
npm start               # serve the web UI + /health on the configured bind
./install.sh --service  # register + start as a login OS service
./install.sh --uninstall
gru-service roll        # graceful self-roll: pull + rebuild + relaunch + verify
```

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
| [RUNTIMES.md](docs/RUNTIMES.md) | runtime adapters, capabilities, session store |
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
