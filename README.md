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
  adversarial hybrid review waves → SHA-bound PR verdicts. Perkins runs seven
  required lens types per frozen chunk (six only for explicit no-spec), with
  malformed attempts retryable within a pinned bound. Its install-relative,
  integrity-pinned policy is the sole prompt authority; repository text is
  untrusted evidence. Claude leads alone receive a fresh scoped MCP bridge for
  the same narrow native tools ([FLOW.md](docs/FLOW.md),
  [WORKTREES.md](docs/WORKTREES.md)).
- **Pluggable runtimes** — `pi` (reference) and Claude Code adapters;
  models/thinking default to each runtime's own configuration
  ([RUNTIMES.md](docs/RUNTIMES.md)).
- **Robustness** — durable sessions with resume, restart ladders,
  crash-loop breakers, login-started OS service
  ([SUPERVISION.md](docs/SUPERVISION.md)).

## Screenshots

*(placeholder — the chat window, the board, and the phone layout land
here before the v1.0.0 tag)*

## Install

One line (macOS + Linux, Node ≥ 22.19, git):

```bash
curl -fsSL https://raw.githubusercontent.com/mssoka/gru-command/main/install.sh | bash
```

That clones the repo to `~/gru-command`, installs dependencies, and
builds. A piped shell has no terminal, so it stops there and prints the
exact command that finishes setup — run it in your terminal:

```bash
bash ~/gru-command/install.sh
```

That runs the interactive **setup wizard**: it detects your installed
agent runtimes (`pi`, Claude Code), asks for your workspace root and
which repos live in it, picks runtime/model/thinking defaults, writes
`~/.gru-command/config.toml` (backing up any previous one), shows the
pairing QR for your phone, smoke-tests first boot, and can register the
OS service — the wizard fails loud rather than guessing.

Or clone it yourself and run the wizard in one go:

```bash
git clone https://github.com/mssoka/gru-command.git
cd gru-command
./install.sh            # deps + build, then the wizard
```

Non-interactive (every answer defaults; the JSON may omit anything):

```bash
./install.sh --answers '{}'
```

You need one agent-runtime CLI installed for agents to actually spawn
(`pi` or `claude`) — the wizard warns and proceeds without one, and the
adapters fail loud at spawn time until it exists.

## Run

```bash
npm start               # serve the web UI + /health on the configured bind
./install.sh --service  # register + start as a login OS service
./install.sh --uninstall
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
npm test        # lint + typecheck + build + full offline suite
npm run wizard  # re-run the setup wizard (interactive; backs up config.toml)
```

The default test suite runs fully offline (stub model provider, stubbed
claude CLI double, fixture PATHs). Opt-in live smoke tests and the
fresh-machine install rehearsal are env-gated — see
[docs/RUNTIMES.md](docs/RUNTIMES.md) and
[docs/OPERATIONS.md](docs/OPERATIONS.md#install-rehearsal).

## License

MIT — see [LICENSE](LICENSE).
