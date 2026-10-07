# Operations

Running Gru Command on your machine: service management, the emergency
console, supervision, forensics, and backups & restore. Operator-facing
companion to [SUPERVISION.md](./SUPERVISION.md) (the supervision +
service-install internals), [CONFIG.md](./CONFIG.md) (the config
schema), [CHAT.md](./CHAT.md) (the chat contract), and
[YIELD-REPORT.md](./YIELD-REPORT.md) (the GH-214 cost/yield telemetry).

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
gru-service roll          # self-roll: pull + rebuild + relaunch + verify
```

The service can also roll **itself** — `gru-service roll` (CLI) or
`POST /api/roll` (pairing-token guarded) pulls and rebuilds the deploy
clone while the old process keeps serving, drains in-flight review
rounds and agent turns (bounded), writes the swap marker, exits 75 so
the service manager relaunches the unit, and verifies the new build SHA
on `/health` before the CLI exits 0. `install.sh --update` delegates to
this path when it detects it is running inside the managed service (an
agent-owned shell), where `launchctl unload`/`load` would kill the
updater before it could reload the unit. Design, phases, drain bounds,
and rollback safety: [FLOW.md](./FLOW.md#self-roll-the-service-deploys-itself).

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

## Port-squat prevention (owner incident 2026-09-23)

macOS lets a specific bind (`127.0.0.1:7665`) coexist with a wildcard bind
(`0.0.0.0:7665`), so a stray service can sit on the loopback address while
the real instance serves the LAN — loopback clients then hit the squatter
(`503 not_configured`) for as long as nobody notices. Three durable
defenses, each with its own loud failure:

- **Worktree-spawned services never bind the instance port.** A service
  started from a linked git worktree (or with
  `GRU_COMMAND_WORKTREE_CONTEXT=1`) must use an ephemeral port
  (`port = 0`) or an explicit `GRU_SERVICE_PORT=<high port>` handoff;
  anything else refuses at boot, named. The test/e2e harness does exactly
  this for every service it spawns.
- **The roll preflight checks listener ownership.** If any pid other than
  the service itself listens on the instance port, `gru-service roll`
  (and `POST /api/roll`) fails in preflight with an action-required
  notification; the old service keeps serving. The `gru-service` follow-up
  trusts `/health` only when the listener pid is the process that adopted
  the roll — a squatter answering 200 is never read as success.
- **Boot checks the listener pid.** A service that binds but finds a
  foreign listener on its port logs the squatter pid + command, posts an
  action-required notification, and exits — never a silent loopback 503.

## Supervision and the crash-loop breaker

The in-process supervisor watches every hosted agent (liveness = runtime
events OR session-file growth OR a live open tool; a hung turn climbs a
restart ladder with resume — the conversation survives, and the
interrupted prompt is re-delivered or the lane is escalated as
recoverable). Sleep/wake gaps grant a fresh silence window instead of
restarting. ≥ 3 restarts inside 10 minutes trips the **crash-loop
breaker**: the agent is stopped, a needs-owner notification escalates
(FOR YOU band + owner bell + chat notice), and **acking that notification
re-arms** supervision — re-arm is the human's step. A service restart also clears an open breaker —
the ack record is durable, the breaker state is not.

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
  `chat/gru-session.json` atomically selects the active native session,
  epoch, and replay floor. New chat advances that boundary without deleting
  historical frames or native transcripts. Reconnect replay spans rotation
  shards (8 MB × 3). A corrupt log
  refuses boot — history is never silently truncated
  ([CHAT.md](./CHAT.md)).
- **Worktree lanes** — job worktrees under `<data_dir>/worktrees/`,
  preserved deliverables under `<data_dir>/worktree-preserves/`; the
  ledger is the authoritative map job → worktree → branch → processes
  ([WORKTREES.md](./WORKTREES.md)).

## Administrative closeout of a parked PR-backed lane

When a parked lane's PR is confirmed CLOSED on the host (never merged),
GitHub is terminal but the ledger still holds the parked job: the generic
status write deliberately refuses `parked → done`. The supported closeout
is the guarded, audited operation below — it never fakes a
`working`/`in-review` hop, never infers a merge, and never rewrites
preservation evidence, directives/re-briefs, worktrees, rounds, agents or
children (`docs/LEDGER.md` has the record-level contract).

Preconditions (all enforced; every refusal is a loud no-effect failure):

- the job is `parked`, PR-owing, and registers exactly the requested PR url;
- the poll's own latest `github.branch-state` observation says the PR is
  CLOSED (`pr_open: false`) and NOT merged (`merged: false`) at the
  requested head — no observation, an open PR, a merge or a moved head is
  refused;
- no target-owned live work: spawning/streaming worker turns, non-terminal
  tracked child workers, pending/live review rounds or unsettled
  verification runs.

Request (pairing token in `Authorization: Bearer`):

```bash
curl -sS -X POST "http://127.0.0.1:<port>/api/jobs/<job-id>/closeout" \
  -H "Authorization: Bearer $GRU_TOKEN" -H 'content-type: application/json' \
  -d '{
    "expected_status": "parked",
    "expected_pr_url": "https://github.com/<owner>/<repo>/pull/<n>",
    "provider": {
      "provider": "github",
      "state": "closed",
      "merged": false,
      "head_sha": "<full PR head sha>",
      "closed_at": "<ISO-8601 UTC, optional>"
    },
    "reason": "<why this administrative closure is authorized>"
  }'
```

- `200` — the job is `done`; the response carries the job, the
  `job.admin-closeout` audit event (seq + payload) and `idempotent: false`.
  Re-sending the identical request returns the SAME event with
  `idempotent: true`; a changed request against the closed lane is refused.
- `409 closeout_refused` — a guard refused (`code` names it: `not-parked`,
  `not-pr-backed`, `not-pr-owing`, `target-mismatch`, `unconfirmed-pr`,
  `pr-open`, `pr-merged`, `stale-head`, `live-work`, `already-closed`);
  nothing changed.
- `400` malformed body · `401` missing/bad token · `404` unknown job. A
  wrong `expected_status` **value** is a 400 body error. A lane that has
  moved off `parked` (or was closed by another path) is refused by the
  first failing guard in order: `already-closed` for an already-done
  lane, then `not-pr-backed` / `not-pr-owing` / `target-mismatch`, then
  `not-parked`.

Read back with the idempotent replay plus `GET /api/board`: the job is
`done`, `prState` is `null` (never `open`), and the lane no longer appears
in PR/review work. The operation performs no other side effect — no worker
spawn, re-brief, review arm, verification launch, worktree release, PR
write or notification ACK.

## Binning a job (terminal discard)

When the owner/chief discards a lane that will never resume (superseded,
cancelled, obsolete), close it as **binned** — the terminal discarded
state, distinct from the resumable `parked` hold. Binning works from any
non-terminal status (`dispatched`, `working`, `delivered`, `in-review`,
`blocked`, `parked`); `merged`/`done` lanes refuse it, and a binned lane
can never move again (no resume, re-brief, amendment, directive or
review). The prior status and every historical event stay on the record;
applicable obligations close as `job-terminal` abandonment in the same
transaction — binning is a disposition, never a success or cleanup
claim.

Preconditions (Gru's shipped role teaches this same action; no new endpoint
or automatic binning — the write itself is the ordinary status surface):

- confirm the lane is genuinely discarded and will not be resumed;
- inspect live ownership first (`GET /api/board`, `/health`): binning
  does NOT stop a running worker, cancel a queue entry, release a
  worktree, delete artifacts or ack notifications. The status transaction
  refuses target-owned open worker turns, unfinished child workers,
  pending/live review rounds, unsettled verification runs and an in-flight
  provider-recovery continuation, with no status or event mutation. A
  historical claimed wait does not hold the lane after its turn settles. Stop live work through its own authorized
  surfaces first — the board keeps showing the live producer and the
  worktree stays on the record. A `working` label alone is not proof of
  a live producer; idle `working` jobs remain bin-eligible.

Request (pairing token in `Authorization: Bearer`):

```bash
curl -sS -X POST "http://127.0.0.1:<port>/api/jobs/<job-id>/status" \
  -H "Authorization: Bearer $GRU_TOKEN" -H 'content-type: application/json' \
  -d '{"status":"binned"}'
```

- `200` — the job is `binned`; the ordinary `job.status` event records
  `<prior> → binned`. On the board, COLD is count-only by default:
  expand COLD (“Show records”), then the “Show N binned records”
  disclosure inside it reveals the discarded row.
- `400` — illegal transition (from `merged`/`done`, or any DIFFERENT
  status after `binned`), live-work refusal, or unknown status; nothing changed. Re-sending
  `{"status":"binned"}` to an already-binned lane is an idempotent
  200 no-op (the generic same-status write never mints a duplicate
  event) — a timed-out retry is safe.
- `401` missing/bad token · `404` unknown job.

There is no unbin: a mistaken bin is corrected by recording the honest
next action as a NEW lane/job, never by rewriting the closed record.

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
