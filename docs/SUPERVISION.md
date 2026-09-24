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
- **Action-required** — needs a human decision; posted by the supervisor
  on breaker trips. These also surface **in chat** as notice lines
  (`⚠ Action required: …`) so the single Gru window carries them.

**Ack ids — nothing shown is unproven.** Every notification carries a
stable id (the ack contract). When a client displays one — a toast, the
bell panel, a browser notification — it posts
`POST /api/notifications/:id/shown {surface}` and the row records the
receipt (`shown_at`, one per surface, idempotent). An **ack**
(`POST /api/notifications/:id/ack`) is the human clearance: it clears the
row (and, for a breaker row, re-arms supervision). The bell badge counts
unacked needs-owner errors; the NEEDS GRU machine queue is tracked
separately and never rings the bell; ack buttons live on every row.

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
