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
         merged/done/binned are terminal; a PR registered before the turn
         settles keeps working → in-review legal)
        discard: ANY non-terminal → binned (terminal, no outbound edges;
         merged/done can NOT be binned)
        administrative closeout: parked → done ONLY through
         `adminCloseParkedJob` (audited, evidence-bound — never the
         generic status write)

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
- **`binned` is the terminal DISCARDED state** (owner/chief cancelled a
  lane): every non-terminal status may be binned through the ordinary
  authenticated `POST /api/jobs/<id>/status` write WHEN no target-owned
  producer remains. The same status transaction refuses open worker turns,
  non-terminal children, pending/live rounds, unsettled verification
  runs, and active initial dispatch, directive or provider-recovery
  admissions that have not registered their worker yet; an idle `working`
  job can still be binned. Historical directive intents and claimed
  provider waits are not perpetual runtime blockers after the attempt
  settles; last-side-effect guards also refuse late prompts if a job
  became terminal during an asynchronous boundary. Gru's shipped role
  teaches this intentional action through its permitted shell and the
  configured service token; no background process automatically bins
  work. `binned` never leaves — it shares the terminal contract with `merged`/`done`
  (`isJobTerminal`, `TERMINAL_JOB_STATUSES`). The transition appends the
  ordinary `job.status` `{from, to}` event (the prior status and every
  earlier event stay on the record) and settles the lane's applicable
  obligations as `job-terminal` abandonment in the SAME transaction.
  Binning is a disposition, NOT evidence: it never means the work
  succeeded, a PR merged, a gate passed, an obligation was satisfied, a
  worktree was destroyed or a live process stopped. `merged`/`done`
  lanes cannot be binned (their history is closed), and a binned lane
  can never resume, be re-briefed, amended, directed or re-reviewed.
- **Administrative closeout** (`adminCloseParkedJob`, owner ruling
  j-1115) is the ONE exception path that closes a parked PR-backed lane
  without faking a hop: the generic machine still refuses parked → done,
  and only this guarded operation admits the direct `parked → done` edge.
  (A lane resumed through its normal lifecycle still reaches `done` by
  the ordinary route — this edge exists for a lane that never resumes.) It requires an
  explicit expected status + PR url + head, the job's LATEST recorded
  `github.branch-state` observation to say the PR is CLOSED and not
  merged at exactly that url/head, and no target-owned live work
  (spawning/streaming worker turns, non-terminal child workers,
  pending/live rounds, unsettled verification runs). ONE transaction
  appends the `job.admin-closeout` audit (request evidence + the cited
  observation seq), records the direct status hop, and closes the
  applicable obligations `job-terminal` (abandonment, never a success
  claim). A repeated identical request returns the recorded closeout
  idempotently; a changed request is refused — the recorded one is never
  overwritten. Idle/historical bookkeeping rows and the separate
  directive/re-brief control rows are neither read nor rewritten.
- `setRoundVerdict` also transitions the round to `verdict-posted` — a
  posted verdict IS that state (and a verdict on a still-`pending` round
  fails loud, machine and all, leaving no trace).
- `bindLens` backfills the agent's round/job wiring — runtime-registered
  agents (no round context at spawn) connect to their round with this
  ONE call.
- Lens chips derive `live` from their bound agent's turn events
  (idempotent); `done`/`error` are explicit outcomes (the wave runner or
  error derivation sets them).

**Default lens set** (`DEFAULT_LENSES`, 9): blind, edge, acceptance,
security, architecture, codebase, tests, performance, operations — the
fallback for a future round created without an explicit list. Production
rounds pass the pinned policy's applicable catalog (9, or 8 for explicit
no-spec) at creation; every new round carries those chips, and historical
rounds keep exactly the chips they recorded.

## Event kinds

Every mutation appends one event row in the same transaction and
publishes it on the in-process event bus (`src/events/bus.ts`).

| Kind | Payload (essentials) |
|---|---|
| `job.created` | repo, title, display_name |
| `job.status` / `job.note` / `job.pr` / `job.target` | from→to / note / url / ref (`binned` uses the ordinary from→to event) |
| `job.admin-closeout` | disposition (`closed-without-merge`), expected status/url, provider evidence (state/merged/head/closed_at), the cited `github.branch-state` observation (event seq + identity), reason, request sha256 |
| `round.created` / `round.status` / `round.verdict` / `round.target` | seq, lenses / from→to / verdict / ref |
| `lens.bound` / `lens.status` | agentId / from→to (+note) |
| `agent.spawned` / `agent.state` / `agent.error` | role, label / from→to (+error) / error, fatal |
| `verification.started` / `verification.completed` | run id, scope, command, sha, workers, queued ms / ok, exit code, duration, bounded output hash+tail |
| `verification.requested` / `verification.attached` | admitted single-flight attempt: request id, run id, dedupe key (job+lane+scope+head+command) / a duplicate submission attached to that producer |
| `verification.reconciled` | a completed request identity replayed its recorded outcome — no rerun |
| `verification.lock-timeout` / `verification.stale-released` | wait ms + holder counts + request id / pid, reason (`holder-dead` \| `no-runner` \| `max-age`), age, interrupted request ids |
| `branch-idle.refused` / `branch-idle.forced` | phase (`arm`/`freeze`), targetBranch, blockers — the review-arm branch-idle guard (forced rounds also carry the tag in their frozen manifest). The fallback route's two RECORD-EMITTING arm checks are the intake guard and the post-pre-flight re-entry, so a forced fallback admission records TWO `arm`-phase override records where the native route records `arm` + `freeze`. The running gate's boundary re-proofs (round intake, default-reviewer worker admission) emit NO branch-idle rows — a stop there is a `job.fallback-review` phase `aborted` |
| `silas.review-deferred` | target_branch, phase, blockers — Silas defers a refused arm to its next sweep; `reason: fallback_unavailable` + `note` when Perkins pre-flight failed and the fallback gate could not engage, or `reason: fallback_failed` when the gate engaged and already terminated (`blocked`/`aborted`) before the receipt (the clean-abort provenance travels here, non-consuming) |
| `silas.review-triggered` | route, and `round_id` + `rule_id`/`source_round_id` ONLY when a Perkins round is actually armed — the consuming clean-abort receipt; fallback/queued routes record the route without the provenance |
| `job.amendment-accepted` / `job.amendment-rejected` | amendment id, version, body sha256+bytes, supersedes, approval by/reference, previous/effective contract hashes, idempotency key / refusal code+reason + current hash/version |
| `round.review-inputs-frozen` | acceptance version/base+effective hashes/amendment ids, evidence attachment hashes (no pixels, no paths), bound CI record state |
| `round.admission-preflight` | ok, full check list (`head-binding`, `frozen-packet:<file>`, `spec-context`, `verification-evidence`, `ci-evidence`, `evidence:<id>`), and on refusal the exhaustive named missing-input list — recorded after the freeze receipts and BEFORE any lead/child spawn (gh-169) |
| `round.parent-incident` | exactly ONE per parent-aborted round: note, startedAttempts, startedLenses, notStartedLenses — a lead disconnect is one parent incident; never-started lenses keep their `pending` chip (not-started ≠ failed execution) (gh-169) |
| `job.review-handoff-conflict` / `job.review-handoff-superseded` | request seq + folded scope; a differing evidence set is recorded as count + opaque request fingerprint, never paths |

Events are appended for **state changes**; idempotent enrichment writes
(re-registering an agent, same-state activity refreshes) update rows
without minting events.

`events` rows are queryable (`LedgerApi.listEvents({ limit })`, newest
first); the notification center derives its feed from recent events.

## The API of record (`src/ledger/api.ts`)

All writes go through `LedgerApi`; every method validates, updates the
row, appends the event, and (with a bus attached) publishes it:

- jobs: `addJob` · `setJobStatus` · `noteJob` · `setJobPr` · `setJobTargetRef` ·
  `adminCloseParkedJob` (guarded administrative closeout, owner ruling
  j-1115: evidence-bound parked → done for a closed-without-merge PR)
- rounds: `addRound` · `setRoundStatus` · `setRoundVerdict` · `setRoundTarget`
- lenses: `bindLens` · `setLensOutcome` · `markLensLive`
- agents: `registerAgent` (upsert) · `setAgentState`
- events: `appendCustomEvent` · `listEvents`
- re-briefs: `beginPendingRebrief` · `bindPendingRebriefWorker` ·
  `listPendingRebriefs` · `clearPendingRebriefs` · `retirePendingRebriefs`
  (the only cancellation seam: identity-checked deletion + one terminal
  `silas.rebrief-retired` audit in the same transaction)
- amendments: `addJobAmendment` · `listJobAmendments` · `effectiveContract`
  (append-only, expected-contract-hash concurrency, per-refusal audit)
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
retired administratively when the job is already `merged`/`done`/`binned`
(below);
`UNIQUE (job_id, kind)` means a newer request supersedes an older
marker. Boot reconciliation (`src/dispatch/rebrief-recovery.ts`)
consumes leftovers: resume the interrupted session (or re-dispatch fresh
on the same lane), record the missing events, or escalate
action-required when recovery fails. A leftover whose job has since
reached `merged`/`done`/`binned` is instead retired administratively: the
identity-checked marker deletion and a single `silas.rebrief-retired`
audit commit in one transaction, with no spawn and no escalation.
Retirement fires wherever the terminal state is met — the boot scan, a
settling turn, or the re-dispatch boundary — not only at boot. Spent
markers (both guarded events already landed) are the exception: they
clear as the completed request they are, with no retirement audit. A
malformed pair (missing kind or mismatched phase id, payload hash, or
watermark) stays visible and escalates for repair instead of being
completed or retired, even when terminal. A completed pair publishes
`silas.rebrief-settled` in the same transaction that clears its markers
(a settlement failure rolls the clear back, so the next pass can still
release the queued handoff); retirement and escalation do not publish
settlement. The boot summary's units are mixed by design:
`examined` counts markers while `completed`/`redispatched`/`retired` count
jobs, so one retired
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

### E9: short heist names (migration 17)

`jobs.display_name` is the optional short name the crew rail shows on
minion cards (nullable: legacy rows read as NULL and fall back to a
display-only, grapheme-bounded shortening of the title). `addJob` trims
an authored value, rejects blank or visible-character-free names, and
caps it at `JOB_DISPLAY_NAME_MAX_LENGTH` (100 UTF-16 code units — the same unit JavaScript `.length` counts, so an emoji-rich name can hit the cap at 50 characters); the dispatch
API accepts the same value as `display_name`, maps a missing, blank or
mistyped field to "no authored name" rather than an error, answers a
too-long name with 400, and `job.created` payloads carry the stored
value. Reads: `JobView.displayName` on `GET /api/board`; the full title
and the full agent id stay on the job and in each row's tooltip, so
nothing is lost when a name is shortened for display.
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
| `retired` | **control ownership closed** by the guarded, evidence-fenced retirement after server-verified writer cessation; no delivery and no no-effect outcome is claimed, the work remains unfinished, and the request id is consumed |

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

**Guarded retirement (migration 23, owner approval j-1348).** When a
prompt was delivered and the worker ceased mid-turn with no correlated
terminal receipt, the request's CONTROL ownership can be closed without
claiming success or no-effect: `POST
/api/silas/directives/{request_id}/retire` runs one ledger transaction
that re-verifies every live-ownership mark (open agent turns, child
workers, in-process admissions, re-brief markers, other live requests,
provider waits, verification runs, review rounds, live lane processes),
binds the caller's `expected_job_id` / `expected_state` /
`expected_payload_hash` / `expected_head` (freshly resolved from the
lane) and therefore refuses stale or conflicting intent, preserves any
correlated admission evidence by binding it first
(`admitted-without-terminal`), refuses a correlated terminal receipt so
normal settlement owns it, flips the state to `retired`, appends exactly
one `silas.directive-retired` audit event, and CLOSES (never completes)
an awaiting phase handoff. The row keeps a durable continuation hold
(`hold_released_by`/`hold_released_at`): while open it fences review
arming, digest offers and stall offers exactly like a live request, and
only a fresh accepted directive/re-brief identity releases it. Unknown,
stale or missing evidence fails closed; replays of the same canonical
intent are idempotent with one audit transition. No worker is spawned,
no job/obligation/approval is rewritten, and activation remains a
separate owner decision — see [DIRECTIVE-RECOVERY.md](./DIRECTIVE-RECOVERY.md).

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

### Canonical job amendments (migration 14, review-input handoff)

One append-only table carries the effective acceptance for later Perkins
rounds. The original briefing row is never rewritten.

**`job_amendments`** — `id` (TEXT PRIMARY KEY), `job_id` (FK to `jobs`),
`version` (INTEGER; `UNIQUE (job_id, version)`), `body` + `body_sha256`,
`supersedes` (JSON array of `original:<anchor>` / `amendment:<id>`),
`approval_by` + `approval_reference`, `previous_contract_sha256`,
`contract_sha256`, `request_sha256` (the exact-request fingerprint that backs
idempotent retry), `idempotency_key` (partial `UNIQUE (job_id,
idempotency_key)` index where not null) and `created_at`. Writers present the
contract hash they read; a stale writer is refused and audited, never merged.
See [REVIEW-INPUTS.md](./REVIEW-INPUTS.md) for the HTTP surface and
[`src/review-inputs/amendments.ts`](../src/review-inputs/amendments.ts) for the
renderer. Migration 14 is additive and carries the same landing-collision
convention as migrations 10-13.

### Tracked child workers (migration 15, issue #161)

Two additive shapes make nested GC-managed workers first-class records:

- **`agents.parent_agent_id` + `agents.parentage`** — the durable parent
  link and the honest parentage category (`'top-level'` = explicitly
  parentless, `'child'` = parented, `NULL` = legacy/unknown, never
  reconstructed from names or job patterns). Indexed by
  `idx_agents_parent`.
- **`child_workers`** — the admission record AND the lifetime-creation
  counter. Columns: `id` (the admission identity), `agent_id` (the
  spawned session, bound after spawn), `parent_agent_id`, `job_id`,
  `purpose`, `authority` (`read-only` | `writer`), `task`, `label`,
  `idempotency_key` + `payload_hash` (UNIQUE `(parent_agent_id,
  idempotency_key)`), `state` (`queued` → `admitted` → `active` →
  `done` | `error` | `cancelled`), `worktree_id` + `branch`,
  `session_file`, `result_state` + `result_summary` + `result_ref`, and
  the lifecycle timestamps. A retry with the same key replays the same
  row; a changed payload under the same key fails loud
  (`ChildWorkerConflictError`). Session resumes and replacement sessions
  never insert a second row.

**Counter semantics (present + lifetime).** `LedgerApi.countChildWorkers`
and `childCountsByParent` are SQL aggregates over these rows:
`queued` = `state` is `queued` or `admitted` (a child whose lane exists
but whose resident admission is still waiting is not active);
`active` = a live session is running the task (`active`); `finished` =
`done`/`error`/`cancelled`; `lifetimeCreations` = the ROW COUNT (one per
logical child creation). Restart changes nothing — the aggregates are
computed from the durable table, and event replay never touches them.

`result_summary` carries the child's own final report on `done`, and the
named failure/cancellation reason on `error`/`cancelled`; `result_ref`
is the session transcript referenced by that result (never a bare null
when a session existed).

Migration 15 also rebuilds the `worktrees` table in place to admit
`kind = 'child'` (a child lane's owner id is the child agent id; SQLite
cannot alter a CHECK constraint). The migration declares
`foreignKeysOff: true`, so the runner disables foreign keys around the
rebuild transaction and verifies `PRAGMA foreign_key_check` BEFORE
COMMIT — a violation rolls the whole migration back loudly. It carries
the same landing-collision convention as migrations 10-14.

### Decision memory (migration 20, issue #218)

Decisions Gru and Silas make — holds, dismissals, acted dispositions —
are STATE, not prose. Before this table, "resolved under the existing
ownership hold" lived only in memory notes, so every re-detection of the
same signal re-woke the chief to rediscover the hold. The `decisions`
table makes the hold queryable:

| Column | Purpose |
|---|---|
| `id` | uuid |
| `subject` | `'job:<id>'` \| `'pr:<repo>#<n>'` \| `'incident:<kind>:<key>'` — a kind-prefixed stable key |
| `decision` | `hold` \| `dismissed` \| `acted` \| `superseded` \| `covered` |
| `covers` | JSON array of signal kinds, e.g. `["pr-conflict","ci-failed"]` (canonical: deduped, sorted) |
| `basis_fingerprint` | state hash at decision time (head SHA / incident hash); `NULL` = any basis |
| `reason` | non-empty, bounded (2000) |
| `by` | `gru` \| `silas` \| `owner` \| `code` — a CLAIM, never identity proof (#99: the bearer token is shared) |
| `client_key` | UNIQUE idempotency key — a retry with the same key and content returns the original row; changed content fails loud (`DecisionConflictError`) |
| `created_at`, `recheck_at` | `recheck_at NULL` = no scheduled re-look (a basis change still re-opens) |
| `cleared_at`, `cleared_by`, `cleared_reason` | stamped by `clearDecision`; rows are never rewritten or deleted |

**The trigger query** is `LedgerApi.coveringDecision({ subject, signal,
basis, now })`: it returns a decision only when the row is not cleared,
its `covers` include the signal, its `basis_fingerprint` is null or
equals the current basis, and its `recheck_at` is null or in the future.
A changed basis OR a passed recheck re-opens the subject — suppression
never outlives its evidence. Only the NEWEST active decision listing the
signal is the candidate: when it fails, the subject re-opens even if an
older, broader hold on the same subject still matches — a replacement
hold should mark its predecessor `superseded` or clear it. The scan is
exhaustive for the subject (pages past any listing window).

**Writes** go through `LedgerApi` (`recordDecision`, `clearDecision`,
each appending a `decision.recorded` / `decision.cleared` event in the
same transaction as the row) or the board server's bearer-authed routes
(`POST /api/decisions`, `POST /api/decisions/{id}/clear`,
`GET /api/decisions?subject=&active=1`). Both Gru (`roles/gru.md`) and
Silas (`resources/silas-skills/ops-dispatch`) record holds through this
API instead of prose: hold a lane → record the decision with covers +
basis + recheck, then resolve the alert.

**Board visibility:** the snapshot carries `activeDecisions` (subject,
decision, by, recheck — a bounded newest-first window) plus
`activeDecisionCount`, the untruncated total, so an overflow past the
window is visible rather than silent; the full set is paged via
`GET /api/decisions?active=1`. No owner-facing notification is ever
hidden by a decision — decisions suppress re-detection noise, never the
needs-owner bell.

**Sequencing (the issue's own plan):** #218 is the foundation. The
production wiring lands in the lanes it unblocks — hold suppression in
#215, the `recheck_at` re-look sweep in #217, and the #219/#220/#117
lanes stacking on this branch. Until those land, the table is the
readable state they build on; recording through the API is live now.

**Wake side (issue #219):** every wake the decision layer avoids is on
the ledger as `gru.wake-deferred` — `reason: 'covered'` names the
decision id that held the incident, `duplicate` the incident key already
woken, `failed` the bounded-retry exhaustion that escalated. The board
wakes tracker and the #214 yield report (wakes/day, avoided share) read
this stream; nothing avoids a wake silently.
