# Ledger — the durable operational record (E6)

The SQLite ledger is the **API of record** for jobs, review rounds,
agents, and events. The board, later supervision (E7), and the dispatch
flow (E8) all read and write through it; the ledger never silently
coerces state and every mutation is atomic with its event row.

- **Location:** `<data_dir>/ledger/ledger.db` (instance data dir, SPEC
  ruling 7 — never inside the workspace root). WAL journaling; foreign
  keys enforced.
- **Engine:** the built-in `node:sqlite` module — no native compile step
  for clean clones. Requires Node ≥ 22.13 unflagged (`engines` pins
  ≥ 22.19). Node prints a one-time `ExperimentalWarning` when the module
  loads; that is expected and harmless.

## Schema & migrations

Migrations are **numbered, forward-only, contiguous from 1**, applied in
id order inside a transaction, and recorded in `schema_migrations`
(`id`, `name`, `applied_at`).

- Fresh data dir → all migrations apply in order, exactly once.
- Up-to-date DB → the runner is a no-op.
- **Fail-loud guards** (boot refuses rather than guessing):
  - an applied version unknown to the running binary (older binary vs
    newer DB — never run backwards),
  - a numbering gap in the migration list,
  - a migration whose SQL fails (transaction rolls back; whatever
    committed earlier stays durable; the handle closes).

Add a migration by appending to `MIGRATIONS` in
`src/ledger/db.ts` with the next id; never renumber or edit an applied
one.

### v1 tables (migration 1)

| Table | Purpose | Key columns |
|---|---|---|
| `jobs` | one dispatched work item per repo | `id` (slug), `repo`, `title`, `status`, `base_branch`, `pr_url`, `note` |
| `rounds` | a review round on a job | `id` (`<job>-r<seq>`), `job_id` → jobs, `seq` (unique per job), `status`, `verdict`, `target_ref` |
| `lens_states` | one chip per (round, lens) | `(round_id, lens)` PK, `state`, `agent_id`, `note` |
| `agents` | every hosted agent session | `id` (session id), `role`, `label`, `job_id`, `round_id`, `state`, `last_activity`, `session_file` |
| `events` | append-only history feeding the board | `seq` AUTOINCREMENT, `ts`, `kind`, denormalized `agent_id`/`job_id`/`round_id`/`lens`, JSON `payload` |

Row tables hold **current state**; the `events` table is the
**append-only history**. The board rebuilds entirely from the rows after
any restart (the engine's in-memory cache is never the source of truth).

## State machines

Illegal transitions **throw** (`src/ledger/states.ts`); nothing is
coerced and no event is written for a rejected change.

```text
job:    dispatched → working → delivered → in-review → merged | done
        (any non-terminal ⇄ blocked / parked as recoverable side-states;
         merged/done are terminal; a PR registered before the turn
         settles keeps working → in-review legal)

round:  pending → live → verdict-posted | aborted   (terminal: the last two)

lens:   pending → live → done | error               (terminal: the last two)
```

- `delivered` is the settle point: the minion's briefing turn completed
  and no PR is on record yet. The settle handler moves `ok → delivered`
  and `error → blocked`; a registered PR moves `working|delivered →
  in-review`. A Silas follow-through (directive or re-brief) re-opens a
  delivered lane (`delivered → working`) — the fresh attempt supersedes
  the prior delivery.
- `merged` has **no internal writer**: merge detection belongs to the
  external sweep (Silas) — the remaining external caller of the job
  machine. Nothing in the ledger infers a merge.
- `setRoundVerdict` also transitions the round to `verdict-posted` — a
  posted verdict IS that state (and a verdict on a still-`pending` round
  fails loud, machine and all, leaving no trace).
- `bindLens` backfills the agent's round/job wiring — runtime-registered
  agents (no round context at spawn) connect to their round with this
  ONE call.
- Lens chips derive `live` from their bound agent's turn events
  (idempotent); `done`/`error` are explicit outcomes (the wave runner or
  error derivation sets them).

**Default lens set** (`DEFAULT_LENSES`, 7): blind, edge, acceptance,
security, architecture, codebase, tests — every new round carries all
seven chips unless created with an explicit list.

## Event kinds

Every mutation appends one event row in the same transaction and
publishes it on the in-process event bus (`src/events/bus.ts`).

| Kind | Payload (essentials) |
|---|---|
| `job.created` | repo, title |
| `job.status` / `job.note` / `job.pr` / `job.target` | from→to / note / url / ref |
| `round.created` / `round.status` / `round.verdict` / `round.target` | seq, lenses / from→to / verdict / ref |
| `lens.bound` / `lens.status` | agentId / from→to (+note) |
| `agent.spawned` / `agent.state` / `agent.error` | role, label / from→to (+error) / error, fatal |
| `verification.started` / `verification.completed` | run id, scope, command, sha, workers, queued ms / ok, exit code, duration, bounded output hash+tail |
| `verification.lock-timeout` / `verification.stale-released` | wait ms + holder counts / pid, reason (`holder-dead` \| `no-runner` \| `max-age`), age |
| `branch-idle.refused` / `branch-idle.forced` | phase (`arm`/`freeze`), targetBranch, blockers — the review-arm branch-idle guard (forced rounds also carry the tag in their frozen manifest) |
| `silas.review-deferred` | target_branch, phase, blockers — Silas defers a refused arm to its next sweep |

Events are appended for **state changes**; idempotent enrichment writes
(re-registering an agent, same-state activity refreshes) update rows
without minting events.

`events` rows are queryable (`LedgerApi.listEvents({ limit })`, newest
first); the notification center derives its feed from recent events.

## The API of record (`src/ledger/api.ts`)

All writes go through `LedgerApi`; every method validates, updates the
row, appends the event, and (with a bus attached) publishes it:

- jobs: `addJob` · `setJobStatus` · `noteJob` · `setJobPr` · `setJobTargetRef`
- rounds: `addRound` · `setRoundStatus` · `setRoundVerdict` · `setRoundTarget`
- lenses: `bindLens` · `setLensOutcome` · `markLensLive`
- agents: `registerAgent` (upsert) · `setAgentState`
- events: `appendCustomEvent` · `listEvents`
- reads: `getJob` · `listJobs(repo?)` · `getRound` · `listRounds` ·
  `getAgent` · `listAgents`

The thin HTTP write surface (validated, token-authed — the base E8's
dispatch flow builds on) exposes a SUBSET of these (jobs, rounds,
agents, lens binding/outcomes); see [BOARD.md](./BOARD.md).


### E7: notifications (migration 3)

The `notifications` table is the durable notification log (SPEC ruling
13): one row per notification, written once at event time. Columns:
`id` (uuid — the ack contract), `ts`, `kind`, `routing`
(`fyi` | `action-required`), `severity` (`info` | `error`), `title`,
`detail`, `agent_id`, and the proven-ack pair: `shown_at`/`shown_by`
(display receipts, one per surface, idempotent) and `acked_at`/
`acked_by` (the human clearance). Every mutation appends a
`notification.created` / `notification.shown` / `notification.acked`
event and publishes on the bus — the board pushes, the chat surfaces
action-required items, and the breaker re-arm rides the ack. The
board's notification center renders this table directly; nothing is
derived per-snapshot.
