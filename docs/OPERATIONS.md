# Operations

Running Gru Command on your machine: service management, the emergency
console, supervision, forensics, and backups & restore. Operator-facing
companion to [SUPERVISION.md](./SUPERVISION.md) (the supervision +
service-install internals), [CONFIG.md](./CONFIG.md) (the config
schema), and [CHAT.md](./CHAT.md) (the chat contract).

## Where everything lives

| Path | Contents |
|---|---|
| `<data_dir>/config.toml` | instance configuration (default `~/.gru-command/`) |
| `<data_dir>/logs/service.log` | structured JSON-lines service log (rotated, 10 MB × 5) |
| `<data_dir>/sessions/` | append-only agent transcripts (jsonl), locks, hourly backups |
| `<data_dir>/chat/` | chat frame log (`gru.frames.jsonl`) + the Gru session pointer |
| `<data_dir>/uploads/` | attach-flow storage home: materialized clipboard/phone content (SPEC ruling 19). 0700, hardened at every boot and on every write; 8 MiB per file (413 beyond), capped at 1 000 files (507 beyond). Allocation is serialized across service processes; names are UTF-8 byte-bounded and never overwrite. Prune manually — nothing deletes user material on its own |
| `<data_dir>/ledger/ledger.db` | the SQLite record of record (jobs, rounds, agents, events, notifications) |
| workspace root | YOUR managed repos only (default `~/code`) — never instance state |

`/health` declares the live values: workspace root, data dir, session
path, version, install id (the identity fingerprint), and the 3-signal
liveness (see below).

## Service management

The OS service manager is the SERVICE's out-of-band watcher (SPEC ruling
5) — crash → restart, clean stop stays down. One mechanism everywhere:
`install.sh`.

```bash
./install.sh              # full setup (deps + build → wizard)
./install.sh --service    # register + start the service (launchd/systemd)
./install.sh --print      # render the platform unit; change nothing
./install.sh --uninstall  # stop the service and remove the unit
```

macOS (launchd):

```bash
launchctl list | grep gru-command          # status
launchctl kickstart -k gui/$(id -u)/com.gru-command.service   # restart
tail -f ~/.gru-command/logs/service.log    # the structured stream
```

Linux (systemd user unit):

```bash
systemctl --user status gru-command
systemctl --user restart gru-command
journalctl --user -u gru-command -f        # systemd's capture mirror
loginctl enable-linger $USER               # keep it running when logged out
```

Without the OS service: `npm start` (or `node dist/main.js`) in the
repo. Sessions resume from disk on every start (SPEC ruling 12).

## Supervision and the crash-loop breaker

The in-process supervisor watches every hosted agent (liveness = runtime
events OR session-file growth; a hung turn climbs a restart ladder with
resume — the conversation survives). ≥ 3 restarts inside 10 minutes
trips the **crash-loop breaker**: the agent is stopped, an
action-required notification escalates (chat notice + board bell), and
**acking that notification re-arms** supervision. A service restart
also clears an open breaker — the ack record is durable, the breaker
state is not.

Knobs (`[supervision]` in `config.toml`): `turn_silence_ms` (default 15
min), `restart_window_ms` / `max_restarts` / `restart_backoff_ms`, and
`enabled`. The full policy: [SUPERVISION.md](./SUPERVISION.md);
`/health` carries the live per-agent supervision state.

## Emergency console

To talk to the Gru brain directly with a runtime CLI (pi or claude):

1. **Stop the service first** (`./install.sh --uninstall`, or
   `systemctl --user stop gru-command` / `launchctl unload …`). The stop
   releases every session lock — single-writer is preserved BY the stop,
   never raced.
2. Find the newest session file: `/health` declares the session path
   (`<data_dir>/sessions/…`); transcripts are append-only jsonl.
   - pi-hosted sessions: resume with the `pi` CLI in the same
     workspace.
   - claude-hosted sessions: `claude --resume <session-uuid>` (the uuid
     is the transcript filename's suffix) in the workspace root.
3. Edit/inspect as needed. The product transcript is the forensic
   record, not the console's input — for claude, the CLI reads its own
   store; the emergency edit applies to pi-style session files.
4. Restart the service. **Boot growth detection** (SPEC ruling 12)
   re-scans every session file: anything that grew, shrank, or vanished
   while you were in there is reported via `/health`
   (`liveness.signals.session_growth`) and a warn log line — an
   emergency-console edit never passes silently.

## Forensics

- **Sessions** — append-only jsonl under `<data_dir>/sessions/`, in
  standard patterns (`sessions/<role>/--<dashed-cwd>--<hash8>/…`); the
  active file holds an exclusive lock with a pid + heartbeat sidecar.
  This is the ground truth of what every agent said and did.
- **Service log** — `logs/service.log`, one JSON object per line (boot,
  requests, lifecycle, supervision actions). Rotated at 10 MB, 5 shards
  kept.
- **Ledger** — `ledger/ledger.db` (SQLite, WAL): jobs, review rounds,
  agents, the append-only events table, and the notification log. The
  board is a projection of it; nothing shown is computed per-snapshot.
  Inspect read-only while running (`sqlite3 file:…?mode=ro`), or after
  a stop. Schema + migration rules: [LEDGER.md](./LEDGER.md).
- **Chat history** — `chat/gru.frames.jsonl`, seq-consecutive frames;
  reconnect replay spans rotation shards (8 MB × 3). A corrupt log
  refuses boot — history is never silently truncated
  ([CHAT.md](./CHAT.md)).
- **Worktree lanes** — job worktrees under `<data_dir>/worktrees/`,
  preserved deliverables under `<data_dir>/worktree-preserves/`; the
  ledger is the authoritative map job → worktree → branch → processes
  ([WORKTREES.md](./WORKTREES.md)).

## Backups & restore

The service self-manages:

- **Session transcripts** — hourly rolling copies into
  `<data_dir>/sessions/backups/` (ISO-hour slots, newest 24 per file);
  a pass also runs at boot. Recovery tooling must tolerate a torn tail
  line.
- **Chat frames + service log** — size-based rotation with retained
  shards (see above).

You should additionally back up the whole `<data_dir>/` (config,
identity, ledger, sessions, chat) on whatever schedule you trust — stop
the service (or rely on SQLite's WAL) before copying `ledger.db`. To
restore on a new machine: install, stop the service, lay the old
`<data_dir>/` contents into the new instance dir, start — sessions and
the ledger resume. The pairing token, install id, and full history come
along for the ride.

## Install rehearsal

The README's install promise is provable on a machine (or fixture home)
that has never seen Gru Command:

```bash
bash scripts/rehearsal.sh      # pristine fixture HOME + workspace, fresh
                               # file:// clone, non-interactive install,
                               # health smoke — evidence to the PR
bash scripts/hygiene-grep.sh   # zero personal paths / project names
                               # outside the allowlisted install URL
```

The vitest equivalent is env-gated (`GRU_COMMAND_REHEARSAL=1`); the
hygiene grep runs in the default suite.
