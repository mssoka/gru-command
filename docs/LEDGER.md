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
- re-briefs: `beginPendingRebrief` · `bindPendingRebriefWorker` ·
  `listPendingRebriefs` · `clearPendingRebriefs` · `retirePendingRebriefs`
  (the only cancellation seam: identity-checked deletion + one terminal
  `silas.rebrief-retired` audit in the same transaction)
- reads: `getJob` · `listJobs(repo?)` · `getRound` · `listRounds` ·
  `getAgent` · `listAgents`

The thin HTTP write surface (validated, token-authed — the base E8's
dispatch flow builds on) exposes a SUBSET of these (jobs, rounds,
agents, lens binding/outcomes); see [BOARD.md](./BOARD.md).


### E7: notifications (migration 3)

The `notifications` table is the durable notification log (SPEC ruling
13): one row per notification, written once at event time. Columns:
`id` (uuid — the ack contract), `ts`, `kind`, `routing`
(`fyi` | `action-required` | `needs-owner`), `severity` (`info` |
`error`), `title`, `detail`, `agent_id`, and the proven-ack pair: `shown_at`/`shown_by`
(display receipts, one per surface, idempotent) and `acked_at`/
`acked_by` (the human clearance). Every mutation appends a
`notification.created` / `notification.shown` / `notification.acked`
event and publishes on the bus — the board pushes, machine-attention
rows wake Gru, needs-owner rows surface in chat, and the breaker re-arm
rides the ack. Legacy row routing is never promoted on boot or by age;
`notification.resolved` with Gru's action detail closes machine work,
while only an explicit `needs-owner` post creates a human decision stop. The
board's notification center renders this table directly; nothing is
derived per-snapshot.

### E8: pending re-briefs (migration 8)

The `pending_rebriefs` table is the restart-safety marker for Silas
re-brief requests (finding 2026-09-23: an in-flight re-brief lost both
its worker and its event recording at restart). One row per guarded
event — `kind` is `silas.rebrief` or `job.delivered` — with `job_id`,
the request `payload` (note + briefing) and its sha256 `payload_hash`,
the `baseline_seq` event watermark the request must post-date, the bound
worker (`agent_id`, `session_file`), and `requested_at`. The marker pair
is written BEFORE any worker spawns and cleared when its events land — or
retired administratively when the job is already `merged`/`done` (below);
`UNIQUE (job_id, kind)` means a newer request supersedes an older
marker. Boot reconciliation (`src/dispatch/rebrief-recovery.ts`)
consumes leftovers: resume the interrupted session (or re-dispatch fresh
on the same lane), record the missing events, or escalate
action-required when recovery fails. A leftover whose job has since
reached `merged`/`done` is instead retired administratively: the
identity-checked marker deletion and a single `silas.rebrief-retired`
audit commit in one transaction, with no spawn and no escalation.
Retirement fires wherever the terminal state is met — the boot scan, a
settling turn, or the re-dispatch boundary — not only at boot. Spent
markers (both guarded events already landed) are the exception: they
clear as the completed request they are, with no retirement audit. The
boot summary's units are mixed by design: `examined` counts markers
while `completed`/`redispatched`/`retired` count jobs, so one retired
marker pair reads `examined: 2 … retired: 1` — not a partial failure. A
group counts once per scan in which at least one of its markers retires;
a group partially retired by one scan and completed by a later scan is
counted by each scan that retired part of it.

### Residency admission + durable review handoffs (custom events)

The resident-budget cap emits durable custom events (all carry truthful
provenance; none grant admission authority): `round.residency-queued` /
`round.residency-admitted` / `round.residency-cancelled` track a review
round's paired lead+child admission through the FIFO budget;
`job.review-handoff-queued` / `-claimed` / `-requeued` / `-started` /
`-failed` / `-skipped` / `-conflict` (a differing duplicate records its
folded scope truthfully) track a minion's durable 202 review receipt — a
claim with no terminal marker reconciles fail-closed at boot (never a
blind replay), same-job re-busy re-queues, and terminal/swept lanes skip
truthfully. `resident.reclaim-failed` records a deduplicated (per boot; one attempt
per handle per drain-epoch by construction) failed idle-disposal
observation — the failed
worker keeps its permit; `resident.open-control-unknown` records (once
per affected handle) that supervision lacked openControl evidence, which
makes the handle non-reclaimable rather than presumed idle.

### E8: worktree base provenance (migration 9)

`worktrees.base_source` records HOW a lane's registered `sha` was
resolved: `origin` = the freshly-fetched, LIVE-VERIFIED origin
default-branch tip (a cache-guessed default whose live probe failed is
NEVER `origin`, even when its fetch succeeds — the fetch proves the
branch exists, not that it is the default); `local-head-fallback` = the
declared degraded path. Rows written before this migration keep NULL —
a legacy lane's provenance is genuinely unknown, never guessed — as do
REVIEW rows pinned to an exact commit or fully-qualified ref: their
`sha` is their provenance. On JOB lanes the manager declares the source
on every row it creates, the `worktree.created` event carries it, and a
`local-head-fallback` creation also posts a `worktree-base-fallback`
FYI (owner incident 2026-09-23: lanes branched up to hours stale,
silently). On REVIEW lanes `origin` covers any freshly fetched origin
branch named by the target — not only the default branch.
### E10: durable follow-through obligations and directive requests (migration 11)

Two tables carry the blocked-heist follow-through contract. Neither
executes work, schedules anything or wakes anyone by itself: they make
the NEXT obligation durable. This slice wires attention for the
phase-completion hand-back only (`observeFollowUpDelivery` posts one
action-required Gru row); obligations recorded by blocked transitions
and boot adoption are durable triage debt that the digest / FOR YOU
projection slices consume later — not yet surfaced by a notification.

**`job_obligations`** — one row per (job, logical step, incident key)
incarnation. A blocked transition records its obligation in the SAME
transaction as the status write (`LedgerApi.setJobStatus`), with a typed
blocker category (a closed list; anything else is `unknown` → Gru
triage, never guessed into authority), the responsible role, the next
action, optional typed authority, wake condition, bounded due/deadline
state, optional human description (evidence for triage, never
authority) and firing-rule provenance (issue #117). Identity survives
duplicate observations (coalesce, no generation advance); distinct
incidents coexist; a settled incident recurring mints a NEW incarnation
(`id#n`) — the partial unique index enforces one active incarnation per
tuple. `plan_revision` bumps when a duplicate observation CHANGES the
plan (next action / authority / wake condition) and fences claims taken
under the older plan. Receipts cite REAL ledger events (existence, kind,
job, correlation) and never settle; evidence settlements and mechanical
authority are validated against ledger facts (`verifyObligationAuthority`
→ an unverifiable reference is a visible non-executable decision). Claim
replacement across an expired lease requires positive reconciliation
proof recorded with the full prior identity in `claim_log`. Parking
suspends, terminal closes, `invalidateStaleContinuations` reclassifies
stale continuations onto a LINKED successor — debt is never silently
erased.

**`pending_directives`** — one row per accepted Silas directive request,
keyed by the caller's stable `request_id`. The atomic intent→dispatch
claim is persisted BEFORE any prompt/spawn side effect, so a crash
before the insert is provably side-effect-free while a crash after it
is ADMISSION-UNKNOWN — never read as safe to retry. States:

| state | meaning |
|---|---|
| `dispatching` | accepted; a claim was taken before any side effect; native admission not yet recorded (or unknown after a crash) |
| `admitted` | a correlated `silas.directive-sent` event bound an actual awaited turn; terminal receipt pending |
| `settled` | the correlated `job.delivered` terminal receipt was recorded |
| `failed` | a durable positive no-effect failure was recorded; resubmit changed work under a NEW request id |

`POST /api/silas/directive` returns **202** with the stable `request_id`
once the durable intent is accepted — accepted ≠ admitted. The async
turn stays owned and tracked by the existing dispatch server instance
(no detached helper, no second chief); late errors surface durably.
`GET /api/silas/directives/{request_id}` is the authenticated readback
of the same request. Same id + same canonical payload replays to the
SAME row; same id + different payload is a 409 conflict. The lane is
single-writer: while ANY live request exists for the job, ANY different
request id — identified or not — fails closed (409 `ambiguous_repeat`)
with the live request NAMED; only a replay of that same id proceeds, so
a fresh id can never start a second concurrent turn. Boot reconciliation
(`reconcilePendingDirectives` in the existing recovery coordinator)
completes a request from its own correlated evidence when it exists —
admission first, then the terminal receipt — and otherwise posts ONE
bounded, stable-kind action-required escalation naming the request: no
automatic retry, no fabricated delivery, no fresh alert ids to bypass
dedupe. A settled/failed request id never re-runs; recovered capacity is
not permission. The live-request duplicate guard and the boot pass
both query the LIVE states directly, and the boot pass pages by
`request_id` cursor — terminal history can never crowd a live request
out of examination.

### Explicit phase-completion handoffs (migration 12, pr136-chief-handoff)

The durable-follow-through contract above started with blocked lanes. A
bounded phase can also complete on a lane that is NOT blocked and whose
HEAD never moves (the fresh artifact-only dispatch and the same-head
re-brief are the observed shapes). Migration 11 closes that gap with an
EXPLICIT, durable intent — never inferred from a final message, an HTTP
status, `job.delivered` alone, an idle board or an assistant claim.

**The intent.** The phase-authorizing requests accept an optional typed
field:

```json
"completion_handoff": { "kind": "gru-decision", "decision": "rule on the completed audit follow-through" }
```

on `POST /api/dispatch` (fresh artifact phase), `POST /api/silas/directive`
(bounded fix/repair phase) and `POST /api/silas/rebrief` (fresh-worker
phase). Omitting the field preserves the ordinary flow exactly. A
malformed intent answers 400 BEFORE any job, marker or side effect. The
decision text is a label for the owed obligation — never authority and
never identity.

**`phase_handoffs`** — one guard row per marked phase, written in the
SAME transaction as the authorized request (before admission/side
effects). Identity is host-owned:
`phase-handoff:<job>:<source>:<generation>` (per-job monotonic
generation). States:

| state | meaning |
|---|---|
| `awaiting` | the intent is durable; the phase has not completed (the request's own reconcilers still own admission-unknown escalation) |
| `completed` | a VALIDATED correlated terminal delivery landed; the obligation and its one card are reconciled from here |
| `closed` | terminal without a hand-back (failed/cancelled/superseded/parked/terminal-job); closed never reopens |

**Validated completion.** Only a `job.delivered` event carrying the
phase's `phase_id` AND postdating its `intent_seq` AND passing the
source's admission gate completes a phase: a directive request must be
`admitted`/`settled` with the matching `request_id`; a re-brief must have
recorded its `silas.rebrief` request event with the same phase id; a
dispatch delivery must come from the phase's bound minion. A phase-tagged
delivery is recorded ONLY when the prompt settled without an in-band
runtime error: both adapters resolve a fulfilled prompt on an error turn
(Claude `result.isError`; Pi assistant `stopReason: 'error'`), so every
marked path correlates the handle's terminal health at settle
(`promptTerminalVerdict`) before stamping a delivery. A failed turn
records `job.minion-error` and NO delivery: the dispatch guard row
closes, the directive request stays `admitted` with a reconcile note (the
boot pass escalates it), and a re-brief keeps its marker pair for the
recovery ladder — none can masquerade as completion. Disposed and
admission-unknown attempts likewise record nothing. An older receipt
cannot complete a newer phase (correlation, not sequence).

**The hand-back.** On completion the service records ONE
`phase-completion` obligation (`incidentKey phase-handoff@<phaseId>`,
category `phase-completion`, firing rule
`phase-completion-gru-decision`, no authority) and publishes ONE
action-required row on the existing Gru wake path
(`NotificationCenter.postIncident`, stable kind
`silas.phase-handback.<phaseId>`, `dedupe: all`). No watcher, minion
callback, model classification or second wake pipeline participates.
Durable guards: a terminal job settles the debt `job-terminal`; a parked
job SUSPENDS it — neither publishes a card, and neither is revived
automatically. Shown/ACK/disposition is never settlement.

**Reconciliation.** `reconcilePhaseHandoffs` rides the existing boot
sequence (after the directive/re-brief reconcilers): an awaiting phase
whose delivery committed before the observer ran is completed and
published; a completed phase missing its obligation or card finishes
them. It reads only ACTIONABLE rows (`awaiting` intents plus `completed`
rows missing the obligation or card — already-published history is
excluded, so no prefix can consume its budget) and persists a durable
round-robin cursor (`reconcile_cursors`, migration 13): a pass that
exhausts its page budget resumes from its last examined rowid on the next
pass, and a pass that reaches the end wraps to the first row. Every
actionable row is therefore examined within a bounded number of passes.
Every step is idempotent, so duplicates, replays and restarts yield
exactly one logical hand-back per phase — no re-dispatch, no duplicate
Gru turn, no fresh alert ids. The legacy blocked-only observer skips any
delivery naming an existing phase row, so a marked blocked hand-back is
never double-published.

**Unmarked hand-back crash windows.** The legacy event-sequence hand-back
(`silas.phase-handback.<job>@<seq>` + obligation `phase-handback@<seq>`)
is written by the live bus observer, which runs AFTER the delivery
commits — a crash in that gap would lose it. `reconcileUnmarkedHandbacks`
(boot, after the phase sweep) restores both windows from durable state:
(a) follow-up `job.delivered` events on still-blocked lanes with no
hand-back obligation yet, and (b) live `phase-handback@` obligations
whose stable-kind card was never published. Both ride the SAME
record/publish routine as the live observer; both candidate sets drop
rows as they are processed, so bounded passes reach the tail and re-runs
are no-ops. Recovery never spawns a worker, never rings the owner and
never re-posts an existing card (even a resolved one); the one card is
machine `action-required`.

**Limits.** This slice adds no runtime attestation interface, no
provider recovery and no timer/scheduler: a crash mid-dispatch with no
admission evidence leaves the phase `awaiting` (never a fabricated
success). Migration 12 is additive; nothing here changes owner stops,
merge/deploy/restart policy or any callers' notification semantics.

### Bounded reconcile cursors (migration 13, PR136 r4 repair)

One tiny durable table backs fair bounded reconciliation:

**`reconcile_cursors`** — `scope` (TEXT PRIMARY KEY), `cursor` (INTEGER
rowid), `updated_at`. `LedgerApi.readReconcileCursor` /
`writeReconcileCursor` are the only accessors. The `phase-handoffs`
scope is used by `reconcilePhaseHandoffs`; the cursor rowid is the last
row EXAMINED by a pass that hit its page budget, and `0` means “start
from the first actionable row”. A cursor is operational state, never a
write license: it only decides WHICH bounded slice of already-authorized
reconciliation runs next. Migration 13 is additive and carries the same
landing-collision convention as migrations 10/11.
