# Supervision & notifications (E7)

Gru Command keeps every hosted agent alive and observable, and surfaces
what needs human attention — all product-native, no terminal window
required.

Two layers, one ruling each (SPEC rulings 5 and 13):

```text
OS service manager (launchd/systemd)  ← the SERVICE's out-of-band watcher
        │ KeepAlive / Restart=on-failure: crash → restart, clean stop stays down
        ▼
gru-command service
        │ in-process Supervisor: per-AGENT liveness, restart ladder,
        │ crash-loop breaker; NotificationCenter: FYI vs action-required
        ▼
agents (gru today; minions + perkins + bob with the dispatch flow)
```

## The in-process supervisor

The supervisor watches every agent the runtime registry hosts. It never
leaves the process and never imports a concrete adapter — it feeds on the
registry's event tap, handle health, and session-file sizes.

**Liveness = events OR bytes.** While a turn is open (or the adapter
reports `streaming`/`spawning`), any runtime event — or growth of the
session jsonl — resets the turn-silence clock. A slow-but-alive tool run
never trips the watchdog; a turn silent past `turn_silence_ms` (default
15 min) is hung and climbs the ladder.

**An open tool call is activity, not silence.** A tool that produces no
output — `npx vitest run` with its output redirected, a quiet build —
leaves the event surface silent for its whole run. Runtimes therefore
emit a periodic long-tool heartbeat (`tool_update` "still running" per
open call, cadence = a quarter of the silence window, capped at 1 min)
and expose a live-process probe; the supervisor consults the probe at the
silence threshold and resets the clock rather than killing the process
(it fails toward NOT killing live work). A turn with no events, no
growth, and no live tool is still hung and climbs the ladder; a probe
error reads as live.

**An open native compaction is waited for, never silence-restarted.**
Provider compaction (`compaction_start` … `compaction_end`) can run
silent far longer than a normal turn, so while it is open the silence
threshold does not climb the restart ladder: at the threshold the
supervisor makes at most ONE factual FYI attempt per episode
(`supervision.native-compaction-wait` — "compaction has not reported
completion; continuing to wait", `fyi`/info — no owner bell, and no
machine wake under the default action-required wake policy; an explicit
`notify_wake=all` configuration routes every notification kind, this FYI
included) and keeps waiting. The attempt is best-effort at-most-one: the
episode latch is set before the synchronous post, so a post that throws
— before the row persists or after it — is never retried, and repeated
ticks cannot duplicate the FYI. Repeated ticks and duplicate start
signals never warn twice within one episode;
`compaction_end` (success or failure) clears the latch and the warning
state through the existing ownership path, so the next genuine episode
may warn once again. Waiting is indefinite by design — a truly stalled
provider is out-waited, and the owner's manual stop/reset remains the way
to end one; there is no second automatic deadline. This exclusion is
silence-only: a genuine fatal error, an explicit owner control, or a
known provider-error control still lands during open compaction, and an
independently authorized review-isolation deadline still aborts an
isolated review attempt with an open compaction (no ordinary replacement
spawns). A silence
classification already in flight when compaction starts is discarded as
stale, so old silence evidence can never kill a handle that entered
compaction.

**Sleep/wake is not a hang.** A watchdog tick separated from the
previous one by a wall-clock gap beyond the tick cadence means the
machine was suspended; every open turn gets a fresh silence window, a
`supervision.wake` ledger event records the gap, and an FYI notification
names the affected lanes (job, branch, phase). Nothing is restarted on
wake.

**Interrupted turns are resumed, never silently orphaned.** Before a
restart rung (or a wall stop / breaker trip) kills an open turn, the
supervisor snapshots the runtime's `pendingTurn` (prompt text, owner,
images). After the resumed session comes up, the prompt is re-delivered
under the same single-writer owner; the recovery attempt and outcome are
recorded as `supervision.turn-recovery` events. When the runtime cannot
name the prompt (or the re-delivery fails), the supervision posts an
**action-required** `supervision.turn-orphaned.<agent>` note naming the
lane (job, branch, worktree, job phase), so recovery is a lane action,
not archaeology.

**Restart ladder.** A hang or a *fatal* runtime error triggers one
restart rung: dispose the wedged handle (its pending prompts reject),
respawn with `resumeFile` (crash = resume — the conversation survives),
swap listeners for declared slots (the chat Gru session re-wires
itself and the user sees a notice). Failed rungs back off (2 s base,
doubling, 60 s cap) and retry.

An intentional **New chat** is not a restart rung. The chat layer first
preflights the slot (`canReplace()`); an open breaker rejects the reset before
any fresh runtime is spawned. It then mints and durably activates a fresh
unresumed handle, reports the committed epoch, and releases the chat control
mutex before bounded intentional adoption/retired-handle cleanup. Adoption
advances the slot generation; any older restart already in flight is disposed
on completion and cannot swap the retired conversation back in.
Restart-ring/breaker bookkeeping follows the stable slot onto the replacement,
and intentional replacement does not acknowledge or erase an existing breaker
notification. Post-commit adoption failure is a degradation event, not a false
reset failure.

**What is NOT a restart:** an in-band turn error (`state: 'error'`) —
the adapter contract already recovers on the next turn. Only hangs and
fatal errors climb.

**Crash-loop breaker.** ≥ `max_restarts` (default 3) restarts within a
rolling `restart_window_ms` (default 10 min) trips the breaker: the agent
is **stopped** (no further restarts), a **needs-owner** notification
escalates (re-arm is the human's ack), and the board marks the agent (`⛔ stopped` on the rail + the
notification). Acking that notification **re-arms** supervision: the ring
clears, a fresh window opens, one restart attempt resumes the agent. A
service restart also resets breaker state (in-memory by design) — the ack
record is durable, an open breaker is not, so an ack can never strand an
agent across a service restart.

**Watchdog config** (`[supervision]` in `config.toml`):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | supervision off = pure registry behavior |
| `turn_silence_ms` | `900000` | open turn with no event, no byte growth, and no live tool process this long = hung |
| `restart_window_ms` | `600000` | rolling breaker window |
| `max_restarts` | `3` | restarts allowed per window before the breaker trips |
| `restart_backoff_ms` | `2000` | base backoff between failed rungs (doubling, 60 s cap) |

`/health` carries the full supervision state under `supervision`:
per-agent state (`watching`/`restarting`/`stopped`), restart counts, breaker
flags, open tool-call counts, watchdog config.

## Notifications

Every notification is a **durable ledger row** (the notification log —
`notifications` table, migration 3). Rows are created once, at event
time; the board's notification center renders the table, nothing is
computed per-snapshot.

**Routing (SPEC ruling 13):**

- **FYI** — informational; derived automatically from board-worthy
  events (job blocked, agent errored, lens failed, round verdict) and
  posted directly by the supervisor (hang detected, restart engaged).
- **Action-required** — machine attention for Gru. Eligible rows open a
  rate-limited Gru wake turn; Gru diagnoses and dispositions them. They appear
  in NEEDS GRU (live rows only) and not the owner bell; rows bound to a
  terminal merged/done lane are closed receipts rendered under FEED. Breakers
  requiring owner re-arm and other owner-only decisions use **needs-owner**,
  not action-required.
- **Stopped-worker truth (2026-09-29)** — a supervision-stopped or
  breaker-open worker leaves the job status working, but the lane renders an
  explicit waiting state with its recorded reason (`waiting · quota wall`);
  the Silas stall channel never wakes such a lane — only genuinely silent
  live workers stall. The lane's current worker decides whether a stop
  shows: a newer live worker clears an older stop, a fresh worker
  registered before its first frame counts as live (its registration
  stamps the stall clock), and among stops the newest recorded one speaks
  (activity stamp first, registration order when unknown). A re-dispatched
  lane is never COLD on the superseded stop's stamp.

**Ack ids — nothing shown is unproven.** Every notification carries a
stable id (the ack contract). When a client displays one — a toast, the
bell panel, a browser notification — it posts
`POST /api/notifications/:id/shown {surface}` and the row records the
receipt (`shown_at`, one per surface, idempotent). An **ack**
(`POST /api/notifications/:id/ack`) is the owner clearance for owner/FYI
rows. The bell badge counts all unseen needs-owner rows, including info;
the NEEDS GRU machine queue is tracked separately and never rings the bell.
Only owner/FYI rows expose Ack or Mark seen controls; Gru dispositions
machine rows through the notification disposition endpoint. Existing routing
never changes by age or at boot. Gru may post an explicit needs-owner decision
through the authenticated endpoint; a blocked wake creates a durable
needs-owner stop asking for manual service recovery.

**Surfaces:** in-app toasts (always — the floor), the browser
Notification API (permission requested at pairing; toasts carry the load
when denied), the board bell panel, and chat notices for
needs-owner items.

The log is append-only by design (the record of what was escalated and
when). Retention/pruning of very old notification rows is a known
follow-up — at chat-scale volumes the table stays trivial for years.

## OS service install

```bash
npm install && npm run build   # dist/main.js must exist
./install.sh --service        # detect OS, render + install + start the unit
./install.sh --print           # render the unit to stdout, change nothing
./install.sh --uninstall       # stop + remove
```

Everything resolves absolutely at install time — the repo root, the node
binary (resolved through version-manager symlinks to its stable install
path), and `GRU_COMMAND_HOME` (default `~/.gru-command`). launchd gets
`KeepAlive {SuccessfulExit: false}` (restart on crash; a clean stop stays
down); systemd user units get `Restart=on-failure` + `RestartSec=2`
(enable `loginctl enable-linger $USER` for an always-on machine). Logs
land in `<instance>/logs/` — `service.log` for the structured JSON
stream, `launchd.*.log` for the service-manager capture.

Sessions resume from disk on every restart (SPEC ruling 12): the session
store's boot growth detection reports any emergency-console edits that
happened while the service was down.

## Log rotation (bounded growth)

| Log | Rotate at | Keep | Notes |
|---|---|---|---|
| `<instance>/logs/service.log` | 10 MB | 5 rotated | size-based, checked per line |
| `<instance>/chat/gru.frames.jsonl` | 8 MB | 3 shards | replay spans shards — reconnect history stays intact within retention |

Chat frame-log shards are `gru.frames.jsonl.1` (newest rotated) …
`.3` (oldest); `load()` reads oldest→newest then the live file, and seqs
stay consecutive across the whole chain. Frame-log rotation knobs:
`[chat] frame_log_max_bytes` / `frame_log_keep`; service log:
`[logging] max_bytes` / `keep`.

## Queued-wait timeouts

Callers may cap their own queue wait: `prompt(text, { timeoutMs: 5000 })`
rejects *that caller* when the turn never goes idle — the queue, the
live turn, and other callers are untouched. The supervision watchdog
owns un-hanging the turn itself; `timeoutMs` is caller-side relief.

## Testing

`test/supervisor.test.ts` drives a controllable runtime: a killed stub
agent climbs the ladder and is restored (resumed from its session file);
three fast failures trip the breaker exactly once with a needs-owner
notification; an ack re-arms; in-band errors never restart. The same
suite pins the compaction wait policy: an open silent compaction holding
a real pending-turn snapshot warns at most once per episode and is never
restarted (same handle retained, no pending-turn take or re-delivery, no
breaker, no fake progress — lastEventAt stays at the real start),
duplicate start signals warn once per episode, `compaction_end` re-arms
the warning for the next episode, a stale silence decision returning
after compaction started is discarded, a synchronous warning-post
failure (before persistence or after a durable row) neither duplicates
the FYI nor restarts the handle, and a fatal error or an
isolated-review deadline still lands during open compaction. The same
suite pins the hung-turn follow-ups: a live open tool never trips the
watchdog, heartbeats keep a quiet run alive, an interrupted turn is
re-delivered on the resumed session, an unresumable turn posts its
recoverable-lane note, and a sleep/wake gap grants a fresh window.
`test/tool-heartbeat.test.ts` covers the heartbeat cadence/stop/dispose
contract; the pi and claude adapter suites prove a long quiet bash run
heartbeats end to end and answers the live-process probe.
`test/notifications.test.ts` covers the ack round-trip end to end
(post → show → ack → events + board snapshot fields). OS units are
covered by `install.sh --print` rendering tests (path escaping,
placeholder substitution).
