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
| workspace root | shared project directory (default `~/code`); `managed_repos` in `config.toml` explicitly selects managed children — never instance state |

The workspace root may contain unrelated repositories. An absent or empty
`managed_repos` list means none; discovery never enrolls siblings. To add
repositories after installation, edit the exact direct-child names in
`<data_dir>/config.toml`, keep unrelated settings intact, and restart the
service through its normal OS service lifecycle. The running process does not
hot-reload the list. See [CONFIG.md](./CONFIG.md#managed-repositories).

`/health` declares the live values: workspace root, data dir, session
path, version, install id (the identity fingerprint), and the 3-signal
liveness (see below).

## Service management

The OS service manager is the SERVICE's out-of-band watcher (SPEC ruling
5) — crash → restart, clean stop stays down. One mechanism everywhere:
`install.sh`.

```bash
./install.sh              # full setup (deps + build → wizard)
./install.sh --service    # register + start the service (launchd/systemd), refresh gru
./install.sh --print      # render the platform unit; change nothing
./install.sh --uninstall  # stop the service and remove the unit (and the gru launcher)
./install.sh --stop       # stop the owned service (down until --start, a reboot or next login)
./install.sh --start      # start it
./install.sh --restart    # restart it now (turns in flight resume through boot recovery)
```

Install and update also write the `gru` launcher to `~/.local/bin` (or
`GRU_COMMAND_BIN_DIR`). It runs the deploy clone's CLI with the same pinned
Node as the unit, from any directory, and the installer never replaces a
`gru` there that it did not write:

```bash
gru update                # install.sh --update from anywhere
gru restart [--now]       # graceful by default: drain, relaunch the installed build, verify
gru stop | gru start      # install.sh --stop / --start
gru status [--json]       # running vs installed build, drift from main; exit 1 when down
gru logs [-f] [-n N]      # the service log
gru roll                  # self-roll: pull + rebuild + relaunch + verify
gru version               # installed version + build SHA (offline; --json)
gru reset                 # service stopped: remove GC lanes, empty the data dir, keep config.toml
```

`gru restart` is the self-roll in restart mode: no pull and no build, the
same bounded drain (`[roll] drain_timeout_ms`, default 15 minutes; new
turns are not held back, so a busy fleet may wait the whole bound), then
the relaunch and the `/health` check. Use it to apply `config.toml` edits.
`gru restart --now` restarts through the service manager at once; boot
recovery resumes the turns it cut.

`gru update` runs the deploy clone's `install.sh --update` from that
checkout, on your shell's Node.js as running it yourself would (a Node
upgrade is picked up, and the unit and launcher move to it). A shell with
no `node`, or one older than 22.19, falls back to the Node.js `gru` runs
on.

From inside the service (an agent's shell), `gru stop` and
`gru restart --now` refuse, because the service manager would end them with
the service. Use `gru restart --detach` or `gru roll --detach` there:
`--detach` follows the roll through preflight (a refused roll still fails,
loud) and returns once the drain begins. `gru update` from inside already
hands off to `gru roll --detach`. Waiting longer is pointless there: the
drain counts the calling session's own turn, and the relaunch ends that
shell with the service before any verification.

The CLI reads the instance's `config.toml` to reach the service, so an edit
to `[server]` host/port or `[auth]` token is applied with `gru restart
--now` from a terminal. The service cannot apply it from inside, and that
restart cuts the turns in flight.

**Noticing a release.** The board's `deploy` check is the operator-facing
update signal. Every 5 minutes the service reads `origin/main` and the
newest stable `vX.Y.Z` reachable from it: a build older than that release
renders the tag with an `UPDATE AVAILABLE` flag (this state wins over the
commit count); otherwise a build behind main renders `N behind` with a
`RESTART PENDING` flag. A release on another ref is never advertised —
pulling main could not deliver it — and is named in `checkError` instead.
The check starts from the revision stamped into `dist/build-rev.json` at
build time (never the live `git HEAD`), falls back to the last fetched
refs when origin is unreachable (the fallback is named once; a count that
could not be proven shows the full error), and reports `unknown` rather
than guessing. `gru version` prints the version stamped at build
time plus the build SHA, with no config read and no network.

The service can also roll **itself** — `gru roll` (CLI) or
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
launchctl list | grep gru-command          # status (or: gru status)
launchctl kickstart -k gui/$(id -u)/com.gru-command.service   # restart now (or: gru restart --now)
tail -f ~/.gru-command/logs/service.log    # the structured stream (or: gru logs -f)
```

Linux (systemd user unit):

```bash
systemctl --user status gru-command      # (or: gru status)
systemctl --user restart gru-command     # restart now (or: gru restart --now)
journalctl --user -u gru-command -f        # systemd's capture mirror (or: gru logs -f)
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
  the service itself listens on the instance port, `gru roll` and
  `gru restart` (and `POST /api/roll`) fail in preflight with an
  action-required notification; the old service keeps serving. The `gru` follow-up
  trusts `/health` only when the listener pid is the process that adopted
  the roll — a squatter answering 200 is never read as success.
- **Boot checks the listener pid.** A service that binds but finds a
  foreign listener on its port logs the squatter pid + command, posts an
  owner-only `port-squat` notice (it clears on a later successful bind),
  and exits — never a silent loopback 503.

## Supervision and the crash-loop breaker

The in-process supervisor watches every hosted agent (liveness = runtime
events OR session-file growth OR a live open tool; a hung turn climbs a
restart ladder with resume — the conversation survives, and the
interrupted prompt is re-delivered or the lane is escalated as
recoverable). Sleep/wake gaps grant a fresh silence window instead of
restarting. ≥ 3 restarts inside 10 minutes trips the **crash-loop
breaker**: the agent is stopped and an action-required machine alert wakes
Gru; **Gru's guarded disposition on that alert re-arms** supervision (an
operator using the lane's slot does too) — the owner is never asked to
ack. A service restart also clears an open breaker — the resolution record
is durable, the breaker state is not.

Knobs (`[supervision]` in `config.toml`): `turn_silence_ms` (default 15
min), `restart_window_ms` / `max_restarts` / `restart_backoff_ms`, and
`enabled`. The full policy: [SUPERVISION.md](./SUPERVISION.md);
`/health` carries the live per-agent supervision state.

## Emergency console

To talk to the Gru brain directly with a runtime CLI (pi or claude):

1. **Stop the service first** (`gru stop`, or `./install.sh --stop`). The stop
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
4. Restart the service (`gru start`). **Boot growth detection** (SPEC ruling 12)
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

## Parking a job (explicit owner hold)

Parking (`POST /api/jobs/:id/status` with `{"status":"parked"}`) is an
explicit owner hold. It is an administrative state, not proof that a
producer stopped, so the service answers the two facts separately.

- **The hold refuses new work.** Initial dispatch already refuses a parked
  lane; a fresh child worker is refused (`409 job_held`) and a new
  verification is refused with `409 job_held` (`verification.refused` is
  recorded); a duplicate `request_id` still attaches or replays.
  Review handoffs already require a working/delivered/in-review
  status and are revoked by parking.
- **Live producers are physically stopped.** The service disposes every
  runtime handle bound to the job, cancels tracked child workers and
  supersedes live review rounds. It writes `job.execution-stop` with
  `state: "stopped"` only when every target has positive cessation
  evidence (the adapter's own observation, a terminal child result, a
  confirmed review supersession).
- **An unproven stop is named, never fabricated.** A failed dispose, a
  ledger open turn the runtime no longer holds, an unsettled verification
  run or an in-flight producer admission leaves `state: "unproven"` with the
  exact residue in the event, and opens one `needs-owner`
  `job-stop-unproven:<jobId>` incident (reused across boot re-proofs and
  resolved when a later pass proves the stop). A
  pre-existing verification is never reported stopped merely because the
  job is parked; it may still finish.
- **Stopping is not closing.** The job stays parked until the owner moves it
  back to a working status. The stop record and the hold are separate rows,
  so a later reader can tell an administrative hold from a proven producer
  stop.
- **A restart re-proves the stop.** A crash between `requested` and the
  verdict, or an unproven residue, is retried at the next boot for lanes
  that are still parked; shutdown joins an in-flight pass (bounded) before
  the wave and runtime teardown it drives.

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
- no target-owned live work: live directive requests and pending re-brief
  markers (each named; settle, retire or have the owner abandon it first),
  spawning/streaming worker turns, non-terminal tracked child workers,
  pending/live review rounds or unsettled verification runs.

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
  pending/live review rounds, unsettled verification runs, in-flight
  initial dispatch, directive or provider-recovery admission, live
  directive requests and pending re-brief markers (each named), with no
  status or event mutation. A historical claimed wait does not hold the
  lane after its runtime attempt settles. Stop live work through its own
  authorized surfaces first — the board keeps showing the live producer and
  the worktree stays on the record. A live directive or re-brief marker
  whose producer custody the service cannot establish is closed by the
  owner's abandonment (`by: "owner"`, `confirm_intent: true`; Gru asks, never
  calls it), never by binning; it refuses while any producer is known to
  run ([DIRECTIVE-RECOVERY.md](./DIRECTIVE-RECOVERY.md#owner-abandonment-unknown-custody)). A `working` label alone is not proof of a live
  producer; idle `working` jobs remain bin-eligible.

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

A job whose only live request is a directive request that was deferred
before reaching its worker is closed out by the service itself (#523): the
same request retires the request (`by: "canceled-request-closeout"`), bins
the job, closes the debt, resolves the request's recovery card and completes
a durable intent, resuming after a crash or restart. Optional body fields:
`reason` (at most 500 characters, stored and appended to the retire reason)
and `by` (`gru` is kept, anything else is stored `unattributed`; `owner` is
never recorded). It adds `409 request_closeout_refused` /
`request_closeout_stopped` / `request_closeout_superseded` and
`400 invalid_reason`; every other job is unchanged
([DIRECTIVE-RECOVERY.md](./DIRECTIVE-RECOVERY.md#canceled-request-closeout-523)).

There is no unbin: a mistaken bin is corrected by recording the honest
next action as a NEW lane/job, never by rewriting the closed record.

## Backups & restore

The service self-manages:

- **Session transcripts** — an hourly pass (and one at boot) copies only
  the transcripts whose content changed since their last recorded copy
  into `<data_dir>/sessions/backups/` (ISO-hour slots); the change
  baseline is `<data_dir>/sessions/backup-baseline.json` (the source's
  size, mtime and ctime when the pass scanned it, plus the generation's file
  name). Change means that fingerprint moved, so an in-place rewrite is
  copied and a metadata-only touch costs one harmless extra copy. Unchanged
  transcripts are never re-copied, however recently they were written; a
  transcript whose recorded generation is missing, unreadable or truncated is
  copied once more, with a `warn`, so an out-of-band reclaim (or damage) of
  the backup directory cannot leave a live transcript without a snapshot. Per live transcript
  the newest 24 backups are kept, and any generation whose ISO hour ended
  more than 7 days ago is pruned — never the newest generation and never the
  generation the baseline records. After a clock step or a failed baseline
  write those two can differ and the pass keeps both, because it cannot tell
  which one holds the last bytes: restore from the one with the newest
  content, not from the name alone. A transcript that is
  gone keeps its last recorded backup while its older generations age out, so
  it can hold up to a week
  of hourly generations; its recorded entry stays in the baseline so the
  pass knows which backup is that transcript's last. Recovery tooling must
  tolerate a torn tail line.
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
