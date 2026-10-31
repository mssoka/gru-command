# The pipeline (pending work)

The pipeline is the durable queue of approved heists that are not dispatched
yet. An entry holds one complete briefing in the ledger. The service admits it
as a normal heist when nothing blocks it and a resident worker slot is free.

Gru keeps pending work here, never only in conversation or notes: a briefing
that lives in a chat context is lost when the context is compacted, and an
entry in the ledger is not. Gru's side of this is in
[`roles/gru.md`](../roles/gru.md) ("The pipeline (pending work)"). Intake
approval enqueues its frozen heists through the same service
([INTAKE.md](./INTAKE.md)).

Source of truth: `src/ledger/pipeline.ts` (vocabulary and evaluation),
`src/ledger/api.ts` (persistence), `src/dispatch/pipeline.ts` (the admitting
consumer) and the `/api/pipeline` routes in `src/dispatch/server.ts`. There is
no `config.toml` key for it.

## Endpoints

Every route needs `Authorization: Bearer <token>`, the instance `[auth]` token.
A missing or wrong token answers `401 unauthorized` (`503 not_configured` when
the instance has no token). A build that does not host the queue answers
`503 pipeline_not_hosted`. Any other refusal is
`400 bad_request` with a `detail`: a malformed field, an unknown entry on
`hold`, `clear-hold` or `cancel`, or an entry whose state refuses the action.

| Route | Does |
|---|---|
| `POST /api/pipeline/enqueue` | accepts one briefing as a `waiting` entry |
| `GET /api/pipeline` | lists the active entries, compact, with live state and reason |
| `GET /api/pipeline/entries/<id>` | reads one entry in full, briefing included |
| `POST /api/pipeline/entries/<id>/hold` | holds an entry |
| `POST /api/pipeline/entries/<id>/clear-hold` | releases a hold |
| `POST /api/pipeline/entries/<id>/cancel` | cancels an entry that is not admitted |

### Enqueue

`POST /api/pipeline/enqueue`, JSON body:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | The entry id. It becomes the job id (and the branch `gru/<id>`) on admission, so use 1 to 128 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit, that make a valid branch name (no `..`, no trailing `.`, no `.lock` ending). Enqueue accepts uppercase letters. The id check rejects the exact ids `.` and `..`, but not a `..` inside a longer id (for example `a..b`), a trailing `.` or a `.lock` ending. Uppercase is refused by the dispatch service before any job row exists, so admission retries and then makes the entry `failed`, its id burned; the others fail when the lane is created, after the job row exists. The entry answers `201` in the accepted cases (see [Admission](#admission)). |
| `repo_path` | yes | Path of the repository the lane is created from. Enqueue checks only that it is not blank; a path the dispatch service refuses surfaces at admission. |
| `title` | yes | The heist title. |
| `briefing` | yes | The complete briefing, stored verbatim. |
| `request_id` | no | Idempotency identity. Defaults to `id`. |
| `priority` | no | A JSON number, an integer from 0 to 9. Default 5. See [Priority](#priority). |
| `prerequisites` | no | Array of `{ "id": "<entry id>", "milestone": "<milestone>" }`. See [Prerequisites](#prerequisites-and-milestones). |
| `exclusive_scopes` | no | Array of scope names. See [Exclusive scopes](#exclusive-scopes). |
| `hold_reason` | no | A string. A non-blank value enqueues the entry already held. Trimmed and cut to 500 characters. A blank string is no hold; a non-string is a 400. |
| `by` | no | Who enqueued. Recorded on the `pipeline.enqueued` event; attribution only. |

The request body is capped at 512 KiB; a larger one is rejected and the
connection is closed, so the client sees a reset rather than a `400`. Other
fields are ignored. Admission dispatches `job_id`, `repo_path`, `title`
and `briefing` and nothing else, so an admitted job is dispatched as
`POST /api/dispatch` would with only those four fields. The pipeline carries
none of that route's optional fields (display name, deliverable, review target,
parent job, completion handoff, pre-bootstrap patch, briefing-review
provenance).

The receipt, `201` for a new entry and `200` for an exact replay:

```json
{ "entryId": "…", "requestId": "…", "state": "waiting", "priority": 5,
  "enqueueSeq": 12, "queuedAt": "…", "held": false, "duplicate": false }
```

An entry always starts `waiting`; `held` says whether `hold_reason` was given.
A replay is the same `request_id` with the same `id`, `repo_path`, `title`,
`briefing`, `priority`, `prerequisites`, `exclusive_scopes` and `hold_reason`;
it returns the acceptance receipt with `duplicate: true` and creates nothing.

`409 conflict` (nothing is written) when:

- the `request_id` was accepted with different content: **an accepted briefing
  is immutable**, and changed work needs a new entry;
- a new `request_id` reuses the `id` of an entry in any state, cancelled and
  failed ones included, or the `id` of an existing job;
- the prerequisites would form a dependency cycle.

An entry that lists itself as a prerequisite is a `400`. While an entry exists,
its `id` is reserved against a direct `POST /api/dispatch` — except while the
entry is `admitting`, when the reservation stands aside and any caller may take
the id. A direct dispatch that takes it makes the pipeline's own creation fail;
the pipeline counts that attempt, unless the direct job carries the entry's
exact briefing and repo, in which case it adopts the job.

### Reading

`GET /api/pipeline` answers the active entries, in admission order (see
[Priority](#priority)), without briefings:

```json
{ "entries": [{ "id": "…", "repo": "…", "title": "…", "priority": 5,
                "enqueueSeq": 12, "state": "waiting",
                "reason": "owner hold: waiting for the release", "queuedAt": "…" }],
  "pending": 1 }
```

`state` and `reason` are computed when you read, from the live jobs, their
recorded delivery and the resident budget. `entries` holds `waiting`, `ready`,
`admitting` and `failed` entries only: an `admitted` entry has become a job and
a `cancelled` one is closed. `pending` counts the active entries
(`waiting`, `ready`, `admitting`); a terminal `failed` entry stays listed as
attention but is not pending. The board shows this same projection.

`GET /api/pipeline/entries/<id>` answers `404 not_found` for an unknown id and
otherwise:

```json
{ "entry": { "id": "…", "repoPath": "…", "repo": "…", "title": "…",
             "briefing": "…", "briefingHash": "…", "priority": 5, "enqueueSeq": 12,
             "state": "waiting", "holdReason": "waiting for the release", "prerequisites": [],
             "exclusiveScopes": [], "requestId": "…", "payloadHash": "…",
             "jobId": null, "claim": null, "failureReason": null, "failureCount": 0,
             "reconcileNote": null, "queuedAt": "…", "claimedAt": null,
             "admittedAt": null, "updatedAt": "…" },
  "live_state": "waiting", "live_reason": "owner hold: waiting for the release" }
```

`entry.state` is the stored state. `live_state` and `live_reason` are what the
list shows now; for an `admitted` or `cancelled` entry `live_state` is the
stored state. A cancelled entry keeps its cancellation reason in
`entry.failureReason`.

### Hold, clear-hold, cancel

Each is a `POST` with a JSON body and answers `200` with the entry record.
`by` is optional on all three and is recorded on the event.

| Route | Body | Rule |
|---|---|---|
| `…/hold` | `reason` (required) | Only a `waiting` or `ready` entry. Sets the hold and makes the entry `waiting`. The reason is trimmed and cut to 500 characters; holding a held entry replaces the reason. |
| `…/clear-hold` | `reason` (optional) | Only a `waiting` or `ready` entry. An entry with no hold comes back unchanged. The entry is reconsidered at once. |
| `…/cancel` | `reason` (required) | A `waiting` or `ready` entry, held or not. Clears any hold and closes the entry for good. Cancelling a cancelled entry is a no-op. |

Refused with a `400`: any of the three on an `admitting` entry (a live
admission claim is never raced) and on an `admitted` one (its job lifecycle owns
it now; stop the job through its own controls). `hold` and `clear-hold` are also
refused on a `failed` or `cancelled` entry. `cancel` is refused on a `failed`
entry, whose failure record is kept as history: supersede it by enqueueing the
work again under a new `id` and `request_id`, and re-enqueue its dependents. Any authenticated caller can
hold or clear a hold: the service does not enforce which caller may clear one,
and the entry's reason reads `owner hold: <reason>` whoever placed it. Each
mutation records `by` on its event, and neither the list nor the entry readback
exposes the placer. The role tells Gru to clear only the holds it placed itself.

## States

| State | Meaning |
|---|---|
| `waiting` | Enqueued, held, or blocked. `reason` says which. |
| `ready` | Nothing blocks it. It is admitted as soon as the shared budget has a slot; `reason` says what it is waiting for, or is null. |
| `admitting` | The service claimed it and is dispatching it (`dispatch claim in flight`). |
| `admitted` | Dispatched. The entry id is now the job id and the job's ordinary lifecycle takes over. The entry leaves the list. |
| `failed` | Terminal. Admission failed three times before any job existed. |
| `cancelled` | Terminal. Closed by `cancel`. |

`waiting` and `ready` flip as eligibility changes. The `reason` on a `waiting`
entry is the first of these that applies, checked in this order:

- `owner hold: <hold_reason>`;
- `dependency cycle: a → b → a`;
- for each prerequisite in the order listed:
  - `waiting for <id> — not enqueued` (the id names no entry yet);
  - `prerequisite <id> cancelled` or `prerequisite <id> failed`;
  - `waiting for <id> to be admitted (now <state>)`, or
    `waiting for <id> to be <milestone> (now <job status, or entry state when it has no job>)`;
- `exclusive scope "<scope>" held by <id>`.

A `ready` entry's reason is `waiting behind N older resident admission(s) in the
shared queue` or `waiting for a resident worker slot (<busy>/<capacity> busy)`.
A `failed` entry's reason is its failure, for example `admission failed: …`.

## Prerequisites and milestones

A prerequisite names another **pipeline entry** and the milestone it must have
reached. An entry is eligible only when every prerequisite has. A prerequisite
may name an entry that is not enqueued yet; the dependent waits on it. A
dependency on a job that was dispatched outside the pipeline cannot be a
prerequisite, because it names no entry: it waits forever as
`waiting for <id> — not enqueued`. Express it as a `hold_reason` that names the
job and clear the hold when the job lands.

| Milestone | Reached when the prerequisite entry |
|---|---|
| `admitted` | is `admitted` and its job has a recorded worker start (a registered minion, or a `job.minion-spawned` event). A job that was committed but never started a worker does not release dependents. Nothing here reads the job's later status. |
| `delivered` | has a job with a proven candidate delivery on record (a `job.delivered` event; one recorded as unproven does not count) and a status of `delivered`, `in-review`, `merged` or `done`. |
| `merged` | has a job whose status is exactly `merged`. |
| `done` | has a job whose status is exactly `done`. |

- **A binned dependency does not release a `delivered` dependent.** Binning is
  not in the list above on purpose: a discard invalidates the premise, and
  releasing approved work off it would claim progress the record never made. The
  dependent stays `waiting` with the job's status in its reason (`waiting for
  <id> to be delivered (now binned)`) until it is cancelled. Re-enqueue the work
  that is still owed with prerequisites that name live entries. The same holds
  under `merged` and `done`, which a binned job never reaches. Only `admitted`,
  which looks at the start and never at the later status, still counts it.
- `merged` and `done` are separate terminal statuses and neither implies the
  other. A job that ends `done` never satisfies `merged`, and one that ends
  `merged` never satisfies `done`. `delivered` accepts either ending, but only
  with a proven candidate delivery on record: a job that closes without one
  never satisfies it and its dependent waits as
  `waiting for <id> to be delivered (now done)`.
- A dependency that is `cancelled` or `failed` leaves its dependents `waiting`
  (`prerequisite <id> cancelled|failed`) until they are cancelled too. The
  service never cancels a dependent for you.
- A prerequisite id follows the same rule as an entry id, appears once per
  entry, and cannot be the entry's own id.

## Priority

`priority` is an integer from 0 to 9, default 5. A **lower number is admitted
first**: 0 is the highest priority and 9 the lowest. Eligible entries are
ordered by priority, then by enqueue order (`enqueueSeq`, strictly increasing),
then by id.

Priority only orders eligible entries. A blocked entry never holds up the ones
behind it: a priority 0 entry that waits on a hold or a prerequisite is skipped,
and unrelated work runs. Priority does not preempt a running job, and it does
not create capacity. A value outside 0 to 9, a fraction, or a non-number is a
`400`.

## Exclusive scopes

`exclusive_scopes` is a list of names of exclusive resources, for work that must
not run at the same time even in different repositories. Each name is a
non-empty string of at most 200 characters, without leading or trailing
whitespace, listed once. Names are compared exactly; there are no wildcards and
no case folding.

An entry that shares a scope with another entry waits while that entry holds it
(`exclusive scope "<scope>" held by <id>`). An entry holds its scopes from the
moment it is `admitting` until its admitted job reaches a terminal status
(`merged`, `done` or `binned`). Scopes serialize pipeline entries only; a job
dispatched directly holds none.

## Admission

The service reconsiders the queue when something that can change eligibility
happens: an enqueue, a cleared hold, any job transition, a resident worker slot
freeing up or being taken, and once at boot. There is no polling timer. In that
pass it takes the first eligible entry in the order above and admits it
only when the shared resident worker budget has a free slot and no older
resident admission is queued ahead of it. The budget stays the one capacity
authority; the pipeline keeps no counter of its own. When eligible work waits
on a full budget, the pipeline registers its demand with the budget so the
budget's own idle-minion reclaim can serve it.

Admission writes the claim (`admitting`) before it dispatches, dispatches the
entry through the existing dispatch service with the entry id as the job id,
then marks the entry `admitted`. A failed dispatch never duplicates work:

- a dispatch that fails before any job exists (for example one refused for an
  uppercase `id`) puts the entry back to `waiting` with the failure noted, and one retry pass is armed 5 seconds later (the next
  trigger runs it sooner). The third such failure makes the entry `failed` and
  posts one `pipeline.admission-failed` notification (`action-required`: it wakes
  Gru, not the owner's bell);
- a dispatch that created the job before failing (for example a lane that git
  refuses to create, such as an `id` that is not a valid branch name) is
  adopted, not repeated: the entry becomes `admitted` and the id is burned. The
  dispatch service normally blocks the job with the failure noted before it
  rethrows; when the failure escaped before that handler (for example the
  handoff write), the pipeline's interrupted-startup check blocks the job,
  notes it, and posts one `pipeline.adopted-without-worker` notification
  (`action-required`). The pipeline never posts that card for a job the
  dispatch service already blocked;
- a claim left over from a crash is reconciled at boot: a committed job is
  adopted, otherwise the entry returns to `waiting` with its briefing intact.

## The briefing-review gate is not run on admission

Nefario's briefing-review gate ([BRIEFING-REVIEW.md](./BRIEFING-REVIEW.md)) runs
inside the `POST /api/dispatch` handler, before that route creates anything.
Pipeline admission calls the dispatch service directly and never passes through
the handler. Today, then, an admitted entry is never held for a READY review at
any `stage`, is never refused for a missing review, and carries no review
provenance on its job. Making admission honour the gate is a separate change.
A material amendment made after admission reaches the worker with the next
directive or re-brief ([REVIEW-INPUTS.md](./REVIEW-INPUTS.md)), so the worker's
first turn runs on the text as enqueued.

Until then, the discipline is Gru's: enqueue the entry held, review the exact
briefing while it is held, clear the hold on READY, and on CHANGES-NEEDED record
a push-back, clear the hold, and correct the worker with one dispatch amendment
after admission (see the role). A finding that disagrees with the owner's intent
is escalated as `scope-design` and never released.

## Immutability and correction

An entry's briefing, title, repository, priority, prerequisites and scopes are
fixed at enqueue; no route edits them. Only its hold can change, through `hold`
and `clear-hold`. To change an entry before it
is admitted, cancel it and enqueue the corrected briefing under a **new** `id` (a cancelled
entry's id stays reserved), with a new `request_id` too if you set one: a new
`id` under the old `request_id` is a `409`. Entries that listed the cancelled one as
a prerequisite stay `waiting` on it, so they are cancelled and re-enqueued
against the new id as well. A briefing-review finding is not a briefing change:
it is recorded as a push-back and reaches the worker as a post-admission
amendment, unless it disputes the owner's intent, in which case it is escalated
as `scope-design` and not released (see the gate section). After admission the
briefing is the job's, and a
correction is an ordinary dispatch amendment
(`POST /api/dispatch/amendment`, see [FLOW.md](./FLOW.md)).

## Ledger events

Every change appends an event: `pipeline.enqueued`, `pipeline.held`,
`pipeline.hold-cleared`, `pipeline.cancelled`, `pipeline.state` (a `waiting` and
`ready` flip), `pipeline.claimed`, `pipeline.admitted`, `pipeline.requeued`,
`pipeline.reconciled` and `pipeline.failed`.
